#!/usr/bin/env node
// Operator CLI for invite-only team membership. There is no HTTP admin endpoint: every action runs one
// `wrangler d1 execute --remote` with the operator's own Cloudflare login, as a subprocess without a shell.
//
//   node scripts/invites.mjs issue  --env staging|production --out ABSOLUTE_FILE [--hours 1..168] [--dry-run]
//   node scripts/invites.mjs revoke --env staging|production --username NAME [--dry-run]
//   node scripts/invites.mjs admit  --env staging|production --username NAME [--dry-run]
//
// issue writes the plaintext invitation code only to --out (exclusive create, mode 0600, outside this
// repository); stdout, argv, SQL and logs carry the SHA-256 hash at most. revoke ends a membership and
// every session of that author but keeps their records. admit (re)activates an existing account.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(API_ROOT, '../..');
const CONFIG = path.join(API_ROOT, 'wrangler.jsonc');
const WRANGLER = path.join(API_ROOT, 'node_modules/wrangler/bin/wrangler.js');

// Mirrors the D1 bindings in wrangler.jsonc (asserted by the tests); production is the top-level config.
export const ENVIRONMENTS = {
  staging: { database: 'falsify-harness-records-staging', envArgs: ['--env', 'staging'] },
  production: { database: 'falsify-harness-records', envArgs: [] },
};
const USERNAME = /^[A-Za-z0-9_-]{3,32}$/;
const HASH = /^[0-9a-f]{64}$/;
const USAGE = 'usage: invites.mjs issue --env staging|production --out ABSOLUTE_FILE [--hours 1..168] [--dry-run]\n'
  + '       invites.mjs revoke|admit --env staging|production --username NAME [--dry-run]';

export class UsageError extends Error {}

export function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (!['issue', 'revoke', 'admit'].includes(action)) throw new UsageError('unknown action');
  const options = { action, dryRun: false };
  const allowed = action === 'issue' ? ['--env', '--out', '--hours'] : ['--env', '--username'];
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (!allowed.includes(flag) || i + 1 >= rest.length) throw new UsageError('unknown or incomplete option');
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) throw new UsageError('repeated option');
    options[key] = rest[++i];
  }
  if (!Object.hasOwn(ENVIRONMENTS, options.env ?? '')) throw new UsageError('--env must be staging or production');
  if (action === 'issue') {
    if (typeof options.out !== 'string' || !path.isAbsolute(options.out)) throw new UsageError('--out must be an absolute path');
    const out = path.resolve(options.out);
    const relative = path.relative(REPO_ROOT, out);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new UsageError('--out must be outside the repository');
    options.out = out;
    const hours = options.hours === undefined ? '168' : options.hours;
    if (!/^[1-9][0-9]{0,2}$/.test(hours) || Number(hours) > 168) throw new UsageError('--hours must be an integer from 1 to 168');
    options.hours = Number(hours);
  } else {
    if (!USERNAME.test(options.username ?? '')) throw new UsageError('--username must be 3 to 32 characters of A-Z, a-z, 0-9, _ or -');
    options.username = options.username.toLowerCase();
  }
  return options;
}

// SQL is built only from validated values: a hex hash, integers, ISO timestamps and a [a-z0-9_-] username.
export function issueSql(codeHash, createdAt, expiresAtMs) {
  if (!HASH.test(codeHash) || !Number.isSafeInteger(expiresAtMs)) throw new Error('invalid issue values');
  return `INSERT INTO invitations (code_hash, created_at, expires_at) VALUES ('${codeHash}', '${isoOnly(createdAt)}', ${expiresAtMs});`;
}

export function revokeSql(username, at) {
  const name = checkedName(username);
  const when = isoOnly(at);
  return `UPDATE team_members SET status = 'revoked', revoked_at = '${when}' WHERE status = 'active' AND author_id = (SELECT id FROM authors WHERE username = '${name}'); `
    + `UPDATE sessions SET revoked_at = '${when}' WHERE revoked_at IS NULL AND author_id = (SELECT id FROM authors WHERE username = '${name}');`;
}

export function admitSql(username, at) {
  const name = checkedName(username);
  return `INSERT INTO team_members (author_id, status, created_at) SELECT id, 'active', '${isoOnly(at)}' FROM authors WHERE username = '${name}' `
    + `ON CONFLICT (author_id) DO UPDATE SET status = 'active', revoked_at = NULL;`;
}

function checkedName(username) {
  if (!USERNAME.test(username) || username !== username.toLowerCase()) throw new Error('invalid username');
  return username;
}

function isoOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error('invalid timestamp');
  return value;
}

export function wranglerArgs(env, sql) {
  const target = ENVIRONMENTS[env];
  return [WRANGLER, 'd1', 'execute', target.database, '--remote', '--config', CONFIG, ...target.envArgs, '--json', '--command', sql];
}

// Runs the installed project wrangler with node directly (no shell). Its output can echo SQL, so it is
// not forwarded; a failure reports only the exit status. Returns the summed changed-row count, or null.
export function runWrangler(args) {
  const result = spawnSync(process.execPath, args, { cwd: API_ROOT, shell: false, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`wrangler d1 execute failed (exit ${result.status ?? 'none'})`);
  try {
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).reduce((sum, item) => sum + (Number(item?.meta?.changes) || 0), 0);
  } catch {
    return null;
  }
}

export function newCode() {
  const code = 'fsi_' + randomBytes(32).toString('base64url');
  return { code, codeHash: createHash('sha256').update(code).digest('hex') };
}

// Returns redacted metadata only. The plaintext code never leaves this function except into --out.
export function run(options, { runner = runWrangler, clock = () => Date.now() } = {}) {
  const at = new Date(clock()).toISOString();
  const target = ENVIRONMENTS[options.env];
  const report = { action: options.action, env: options.env, database: target.database, dryRun: options.dryRun };
  if (options.action !== 'issue') {
    const sql = options.action === 'revoke' ? revokeSql(options.username, at) : admitSql(options.username, at);
    // changes 0 means no such author (or nothing to change); the operator must check it.
    const changes = options.dryRun ? null : runner(wranglerArgs(options.env, sql));
    return { ...report, username: options.username, changes };
  }
  const expiresAtMs = clock() + options.hours * 3600 * 1000;
  const result = { ...report, out: options.out, expiresAt: new Date(expiresAtMs).toISOString() };
  if (options.dryRun) return result;
  const { code, codeHash } = newCode();
  // Exclusive create first so an existing file is never overwritten and nothing is inserted for it.
  const fd = openSync(options.out, 'wx', 0o600);
  let written = false;
  try {
    runner(wranglerArgs(options.env, issueSql(codeHash, at, expiresAtMs)));
    writeSync(fd, code + '\n');
    written = true;
  } finally {
    closeSync(fd);
    if (!written) unlinkSync(options.out);
  }
  return result;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(JSON.stringify(run(options)) + '\n');
  } catch (error) {
    process.stderr.write(`${options.action} failed: ${error.code ?? error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
