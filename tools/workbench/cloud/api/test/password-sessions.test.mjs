// Password change and revoke-all. Synthetic accounts only. Resolves miniflare and esbuild
// from this package, or from NODE_PATH when those packages are already installed elsewhere.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, '..');
const repoRoot = path.resolve(apiRoot, '../..');

function cloudRequire() {
  const local = createRequire(import.meta.url);
  try {
    local.resolve('miniflare');
    local.resolve('esbuild');
    return local;
  } catch { /* NODE_PATH below */ }
  for (const dir of (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) {
    if (!existsSync(path.join(dir, 'miniflare', 'package.json')) || !existsSync(path.join(dir, 'esbuild', 'package.json'))) continue;
    const parentPkg = path.join(dir, '..', 'package.json');
    return createRequire(existsSync(parentPkg) ? parentPkg : path.join(dir, 'miniflare', 'package.json'));
  }
  throw new Error('miniflare and esbuild were not found next to this test or on NODE_PATH');
}

const require = cloudRequire();
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');

const integratedCore = path.join(repoRoot, 'app/dist/cloud-records-core.mjs');
const corePath = process.env.FALSIFY_CLOUD_CORE || (existsSync(integratedCore) ? integratedCore : path.resolve(repoRoot, '../contract/app/dist/cloud-records-core.mjs'));
const harnessPath = path.join(repoRoot, 'app/dist/harness-core.js');
const H = require(harnessPath);

const ORIGIN = 'https://shinick-han.github.io';
const LOCAL_ORIGIN = 'http://127.0.0.1:8787';
const PASSWORD = 'correct horse battery';
const NEXT = 'replacement horse battery';
const sha256 = text => createHash('sha256').update(text).digest('hex');

let script;
let statements;
let mf;
let call;

function migrationStatements() {
  const sql = ['0001_shared_records.sql', '0002_invite_membership.sql']
    .map(name => readFileSync(path.join(apiRoot, 'migrations', name), 'utf8'))
    .join('\n');
  return sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(Boolean);
}

async function start(bindings = {}) {
  const instance = new Miniflare(convertV4MiniflareOptions({
    name: 'falsify-password-sessions',
    modules: true,
    script,
    compatibilityDate: '2026-10-19',
    compatibilityFlags: ['nodejs_compat'],
    bindings: { ALLOWED_ORIGINS: `${ORIGIN},${LOCAL_ORIGIN}`, ...bindings },
    d1Databases: ['DB'],
  }));
  const d1 = await instance.getD1Database('DB');
  for (const statement of statements) await d1.prepare(statement).run();
  return instance;
}

function client(instance) {
  return async (method, pathname, { token, body, raw, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) payload = JSON.stringify(body);
    if (payload !== undefined && !Object.keys(h).some(k => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
    const response = await instance.dispatchFetch(`https://api.test${pathname}`, { method, headers: h, body: payload });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
}

async function invite(instance) {
  const code = 'fsi_' + randomBytes(32).toString('base64url');
  const d1 = await instance.getD1Database('DB');
  await d1.prepare('INSERT INTO invitations (code_hash, created_at, expires_at, revoked_at) VALUES (?1, ?2, ?3, NULL)')
    .bind(sha256(code), new Date().toISOString(), Date.now() + 3600e3).run();
  return code;
}

async function register(instance, c, username, password = PASSWORD) {
  return c('POST', '/v1/auth/register', { body: { username, password, inviteCode: await invite(instance) } });
}

const login = (c, username, password = PASSWORD) => c('POST', '/v1/auth/login', { body: { username, password } });

function scryptHash(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFC'), salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$3$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function harnessPayload(id) {
  const config = { schema: 'falsify.harness.v1', id, name: `Synthetic ${id}`, version: '1', role: 'red', instructions: 'Find explicit contradictions.', maxCalls: 4 };
  return { config, hash: await H.hash(config) };
}

async function snapshot(instance, username) {
  const d1 = await instance.getD1Database('DB');
  const author = await d1.prepare('SELECT id, password_hash FROM authors WHERE username = ?1').bind(username).first();
  const sessions = await d1.prepare('SELECT token_hash, revoked_at, expires_at FROM sessions WHERE author_id = ?1 ORDER BY token_hash').bind(author.id).all();
  const records = await d1.prepare('SELECT id, kind, visibility, payload, revision FROM records WHERE owner_id = ?1 ORDER BY id').bind(author.id).all();
  const member = await d1.prepare('SELECT status, revoked_at FROM team_members WHERE author_id = ?1').bind(author.id).first();
  return { author, sessions: sessions.results, records: records.results, member };
}

before(async () => {
  const result = await build({
    entryPoints: [path.join(apiRoot, 'src/index.js')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['node:*'],
    logLevel: 'silent',
    plugins: [{
      name: 'shared-core',
      setup(b) {
        b.onResolve({ filter: /cloud-records-core\.mjs$/ }, () => ({ path: corePath }));
        b.onResolve({ filter: /harness-core\.js$/ }, () => ({ path: harnessPath }));
      },
    }],
  });
  script = result.outputFiles[0].text;
  statements = migrationStatements();
  mf = await start({ REGISTERS_PER_IP_HOUR: '100', LOGIN_FAILURES_PER_USERNAME_HOUR: '100', LOGINS_PER_IP_HOUR: '1000', LOGINS_PER_HOUR: '5000' });
  call = client(mf);
});

after(async () => {
  await mf?.dispose();
});

test('wrong current password does not change the hash or sessions', async () => {
  const created = await register(mf, call, 'ada');
  assert.equal(created.status, 201);
  const before = await snapshot(mf, 'ada');
  const denied = await call('POST', '/v1/auth/password', {
    token: created.body.token,
    body: { currentPassword: 'wrong password value', newPassword: NEXT },
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'invalid_credentials');
  assert.equal(JSON.stringify(denied.body).includes('wrong password value'), false);
  assert.equal(JSON.stringify(denied.body).includes(NEXT), false);
  const after = await snapshot(mf, 'ada');
  assert.equal(after.author.password_hash, before.author.password_hash);
  assert.deepEqual(after.sessions, before.sessions);
  assert.equal((await call('GET', '/v1/me', { token: created.body.token })).status, 200);
  assert.equal((await login(call, 'ada', PASSWORD)).status, 200);
});

test('a correct change rejects the old password, drops every session, and allows a new login', async () => {
  const created = await register(mf, call, 'bea');
  const second = await login(call, 'bea');
  assert.equal(second.status, 200);
  const record = await call('POST', '/v1/records', {
    token: created.body.token,
    body: { kind: 'harness', visibility: 'private', payload: await harnessPayload('bea-harness') },
  });
  assert.equal(record.status, 201);
  const before = await snapshot(mf, 'bea');
  const changed = await call('POST', '/v1/auth/password', {
    token: created.body.token,
    body: { currentPassword: PASSWORD, newPassword: NEXT },
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body, { changed: true });
  const encoded = JSON.stringify(changed.body);
  assert.equal(encoded.includes(NEXT), false);
  assert.equal(encoded.includes(PASSWORD), false);
  assert.equal(encoded.includes('fss_'), false);
  assert.equal(changed.body.token, undefined);
  for (const token of [created.body.token, second.body.token]) {
    assert.equal((await call('GET', '/v1/me', { token })).status, 401);
  }
  assert.equal((await login(call, 'bea', PASSWORD)).status, 401);
  const fresh = await login(call, 'bea', NEXT);
  assert.equal(fresh.status, 200);
  assert.match(fresh.body.token, /^fss_[A-Za-z0-9_-]{43}$/);
  const after = await snapshot(mf, 'bea');
  assert.notEqual(after.author.password_hash, before.author.password_hash);
  assert.ok(after.sessions.filter(s => s.token_hash !== sha256(fresh.body.token)).every(s => s.revoked_at));
  assert.equal(after.sessions.some(s => s.revoked_at === null), true);
  assert.deepEqual(after.records, before.records);
  assert.deepEqual(after.member, before.member);
  const owned = await call('GET', `/v1/records/${record.body.record.id}`, { token: fresh.body.token });
  assert.equal(owned.status, 200);
  assert.equal(owned.body.record.revision, record.body.record.revision);
});

test('a stale current password cannot overwrite the password a concurrent change already stored', async () => {
  const created = await register(mf, call, 'cyd');
  const second = await login(call, 'cyd');
  const other = 'second replacement horse';
  const [left, right] = await Promise.all([
    call('POST', '/v1/auth/password', { token: created.body.token, body: { currentPassword: PASSWORD, newPassword: NEXT } }),
    call('POST', '/v1/auth/password', { token: second.body.token, body: { currentPassword: PASSWORD, newPassword: other } }),
  ]);
  const statuses = [left.status, right.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 401], 'one compare-and-swap winner');
  for (const res of [left, right]) {
    assert.equal(JSON.stringify(res.body).includes(NEXT), false);
    assert.equal(JSON.stringify(res.body).includes(other), false);
    assert.equal(JSON.stringify(res.body).includes('fss_'), false);
  }
  assert.equal((await login(call, 'cyd', PASSWORD)).status, 401);
  const newer = await login(call, 'cyd', NEXT);
  const alternate = await login(call, 'cyd', other);
  const winners = [newer, alternate].filter(res => res.status === 200);
  assert.equal(winners.length, 1);
  const winnerPassword = newer.status === 200 ? NEXT : other;
  const loserPassword = winnerPassword === NEXT ? other : NEXT;
  const stale = await call('POST', '/v1/auth/password', {
    token: winners[0].body.token,
    body: { currentPassword: PASSWORD, newPassword: 'third replacement horse' },
  });
  assert.equal(stale.status, 401);
  assert.equal((await login(call, 'cyd', loserPassword)).status, 401);
  assert.equal((await login(call, 'cyd', 'third replacement horse')).status, 401);
  assert.equal((await login(call, 'cyd', winnerPassword)).status, 200);
});

test('the password batch keeps the first hash when a second batch still names the old hash', async () => {
  const created = await register(mf, call, 'jade');
  assert.equal(created.status, 201);
  const d1 = await mf.getD1Database('DB');
  const row = await d1.prepare('SELECT id, password_hash FROM authors WHERE username = ?1').bind('jade').first();
  const current = await d1.prepare('SELECT token_hash FROM sessions WHERE author_id = ?1 AND revoked_at IS NULL').bind(row.id).first();
  const winner = scryptHash(NEXT);
  const loser = scryptHash('other replacement horse');
  const at = new Date().toISOString();
  // Same two statements as changePassword. The second batch still names the old hash but a live session,
  // so only the hash predicate can reject it.
  const compete = (nextHash, tokenHash) => d1.batch([
    d1.prepare(
      `UPDATE authors SET password_hash = ?1
       WHERE id = ?2 AND password_hash = ?3
         AND EXISTS (
           SELECT 1 FROM sessions
           WHERE token_hash = ?4 AND author_id = ?2 AND revoked_at IS NULL AND expires_at > ?5
         )
         AND EXISTS (
           SELECT 1 FROM team_members WHERE author_id = ?2 AND status = 'active'
         )`
    ).bind(nextHash, row.id, row.password_hash, tokenHash, Date.now()),
    d1.prepare(
      `UPDATE sessions SET revoked_at = ?1 WHERE author_id = ?2 AND revoked_at IS NULL
       AND EXISTS (SELECT 1 FROM authors WHERE id = ?2 AND password_hash = ?3)`
    ).bind(at, row.id, nextHash),
  ]);
  const won = await compete(winner, current.token_hash);
  assert.equal(won[0].meta.changes, 1);
  assert.ok(won[1].meta.changes >= 1);
  const later = sha256('fss_' + randomBytes(32).toString('base64url'));
  await d1.prepare('INSERT INTO sessions (token_hash, author_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(later, row.id, at, Date.now() + 3600e3).run();
  const lost = await compete(loser, later);
  assert.equal(lost[0].meta.changes, 0);
  assert.equal(lost[1].meta.changes, 0);
  const stored = await d1.prepare('SELECT password_hash FROM authors WHERE id = ?1').bind(row.id).first();
  assert.equal(stored.password_hash, winner);
  const survivor = await d1.prepare('SELECT revoked_at FROM sessions WHERE token_hash = ?1').bind(later).first();
  assert.equal(survivor.revoked_at, null);
  assert.equal((await login(call, 'jade', NEXT)).status, 200);
  assert.equal((await login(call, 'jade', 'other replacement horse')).status, 401);
});

test('a revoked current session changes zero password rows and zero sessions', async () => {
  const created = await register(mf, call, 'kira');
  assert.equal(created.status, 201);
  const d1 = await mf.getD1Database('DB');
  const row = await d1.prepare('SELECT id, password_hash FROM authors WHERE username = ?1').bind('kira').first();
  const session = await d1.prepare('SELECT token_hash FROM sessions WHERE author_id = ?1 AND revoked_at IS NULL').bind(row.id).first();
  const at = new Date().toISOString();
  await d1.prepare('UPDATE sessions SET revoked_at = ?1 WHERE token_hash = ?2').bind(at, session.token_hash).run();
  const nextHash = scryptHash(NEXT);
  const lost = await d1.batch([
    d1.prepare(
      `UPDATE authors SET password_hash = ?1
       WHERE id = ?2 AND password_hash = ?3
         AND EXISTS (
           SELECT 1 FROM sessions
           WHERE token_hash = ?4 AND author_id = ?2 AND revoked_at IS NULL AND expires_at > ?5
         )
         AND EXISTS (
           SELECT 1 FROM team_members WHERE author_id = ?2 AND status = 'active'
         )`
    ).bind(nextHash, row.id, row.password_hash, session.token_hash, Date.now()),
    d1.prepare(
      `UPDATE sessions SET revoked_at = ?1 WHERE author_id = ?2 AND revoked_at IS NULL
       AND EXISTS (SELECT 1 FROM authors WHERE id = ?2 AND password_hash = ?3)`
    ).bind(at, row.id, nextHash),
  ]);
  assert.equal(lost[0].meta.changes, 0);
  assert.equal(lost[1].meta.changes, 0);
  const stored = await d1.prepare('SELECT password_hash FROM authors WHERE id = ?1').bind(row.id).first();
  assert.equal(stored.password_hash, row.password_hash);
  const denied = await call('POST', '/v1/auth/password', {
    token: created.body.token,
    body: { currentPassword: PASSWORD, newPassword: NEXT },
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'unauthorized');
  assert.equal(JSON.stringify(denied.body).includes(PASSWORD), false);
  assert.equal(JSON.stringify(denied.body).includes(NEXT), false);
  const after = await d1.prepare('SELECT password_hash FROM authors WHERE id = ?1').bind(row.id).first();
  assert.equal(after.password_hash, row.password_hash);
  assert.equal((await login(call, 'kira', PASSWORD)).status, 200);
  assert.equal((await login(call, 'kira', NEXT)).status, 401);
});

test('revoked and never-admitted members cannot change a password or revoke sessions', async () => {
  const created = await register(mf, call, 'dina');
  const d1 = await mf.getD1Database('DB');
  const author = await d1.prepare('SELECT id FROM authors WHERE username = ?1').bind('dina').first();
  await d1.prepare("UPDATE team_members SET status = 'revoked', revoked_at = ?1 WHERE author_id = ?2").bind(new Date().toISOString(), author.id).run();
  const before = await snapshot(mf, 'dina');
  for (const pathName of ['/v1/auth/password', '/v1/auth/sessions/revoke']) {
    const denied = await call('POST', pathName, {
      token: created.body.token,
      body: pathName.endsWith('password') ? { currentPassword: PASSWORD, newPassword: NEXT } : undefined,
    });
    assert.equal(denied.status, 403, pathName);
    assert.equal(denied.body.error.code, 'membership_required');
  }
  const after = await snapshot(mf, 'dina');
  assert.equal(after.author.password_hash, before.author.password_hash);
  assert.equal(after.sessions[0].revoked_at, null);

  const id = crypto.randomUUID();
  const token = 'fss_' + randomBytes(32).toString('base64url');
  const at = new Date().toISOString();
  await d1.prepare('INSERT INTO authors (id, username, display_name, password_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, 'legacy', 'Legacy', scryptHash(PASSWORD), at).run();
  await d1.prepare('INSERT INTO sessions (token_hash, author_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(sha256(token), id, at, Date.now() + 3600e3).run();
  const change = await call('POST', '/v1/auth/password', { token, body: { currentPassword: PASSWORD, newPassword: NEXT } });
  const revoke = await call('POST', '/v1/auth/sessions/revoke', { token });
  assert.equal(change.status, 403);
  assert.equal(revoke.status, 403);
  const still = await d1.prepare('SELECT revoked_at, password_hash FROM sessions s JOIN authors a ON a.id = s.author_id WHERE a.username = ?1').bind('legacy').first();
  assert.equal(still.revoked_at, null);
  assert.equal(still.password_hash.startsWith('scrypt$'), true);
  assert.equal((await call('POST', '/v1/logout', { token })).status, 200);
});

test('revoke-all drops only the caller sessions and leaves records and other authors', async () => {
  const ada = await register(mf, call, 'erin');
  const erinAgain = await login(call, 'erin');
  const frank = await register(mf, call, 'frank');
  const erinRecord = await call('POST', '/v1/records', {
    token: ada.body.token,
    body: { kind: 'harness', visibility: 'shared', payload: await harnessPayload('erin-shared') },
  });
  const frankRecord = await call('POST', '/v1/records', {
    token: frank.body.token,
    body: { kind: 'harness', visibility: 'private', payload: await harnessPayload('frank-private') },
  });
  assert.equal(erinRecord.status, 201);
  assert.equal(frankRecord.status, 201);
  const erinBefore = await snapshot(mf, 'erin');
  const frankBefore = await snapshot(mf, 'frank');
  const revoked = await call('POST', '/v1/auth/sessions/revoke', { token: ada.body.token });
  assert.deepEqual([revoked.status, revoked.body], [200, { revoked: true }]);
  assert.equal(JSON.stringify(revoked.body).includes('fss_'), false);
  assert.equal((await call('GET', '/v1/me', { token: ada.body.token })).status, 401);
  assert.equal((await call('GET', '/v1/me', { token: erinAgain.body.token })).status, 401);
  assert.equal((await call('GET', '/v1/me', { token: frank.body.token })).status, 200);
  const erinAfter = await snapshot(mf, 'erin');
  const frankAfter = await snapshot(mf, 'frank');
  assert.equal(erinAfter.author.password_hash, erinBefore.author.password_hash);
  assert.deepEqual(erinAfter.records, erinBefore.records);
  assert.deepEqual(erinAfter.member, erinBefore.member);
  assert.ok(erinAfter.sessions.every(s => s.revoked_at));
  assert.deepEqual(frankAfter, frankBefore);
  const again = await login(call, 'erin', PASSWORD);
  assert.equal(again.status, 200);
  assert.equal((await call('GET', `/v1/records/${erinRecord.body.record.id}`, { token: frank.body.token })).status, 200);
  assert.equal((await call('GET', `/v1/records/${frankRecord.body.record.id}`, { token: again.body.token })).status, 404);
  assert.equal((await call('GET', `/v1/records/${frankRecord.body.record.id}`, { token: frank.body.token })).status, 200);
});

test('password and revoke routes keep the existing malformed, size and CORS failures', async () => {
  const created = await register(mf, call, 'gina');
  const token = created.body.token;
  const cases = [
    [await call('POST', '/v1/auth/password', { token, body: { currentPassword: PASSWORD } }), 400, 'invalid_request'],
    [await call('POST', '/v1/auth/password', { token, body: { currentPassword: PASSWORD, newPassword: NEXT, extra: true } }), 400, 'invalid_request'],
    [await call('POST', '/v1/auth/password', { token, body: { currentPassword: 12, newPassword: NEXT } }), 400, 'invalid_request'],
    [await call('POST', '/v1/auth/password', { token, body: { currentPassword: PASSWORD, newPassword: 'short-pass' } }), 400, 'invalid_password'],
    [await call('POST', '/v1/auth/password', { token, raw: '{nope' }), 400, 'invalid_json'],
    [await call('POST', '/v1/auth/password', { token, raw: '{}', headers: { 'Content-Type': 'text/plain' } }), 415, 'unsupported_media_type'],
    [await call('POST', '/v1/auth/password', { token, raw: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'x'.repeat(5000) }) }), 413, 'payload_too_large'],
    [await call('GET', '/v1/auth/password', { token }), 405, 'method_not_allowed'],
    [await call('GET', '/v1/auth/sessions/revoke', { token }), 405, 'method_not_allowed'],
    [await call('POST', '/v1/auth/password', { body: { currentPassword: PASSWORD, newPassword: NEXT } }), 401, 'unauthorized'],
    [await call('POST', '/v1/auth/sessions/revoke'), 401, 'unauthorized'],
  ];
  for (const [res, status, code] of cases) {
    assert.equal(res.status, status, code);
    assert.equal(res.body.error.code, code);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(JSON.stringify(res.body).includes(PASSWORD), false);
  }
  const before = await snapshot(mf, 'gina');
  const loginPreflight = await call('OPTIONS', '/v1/auth/login', { headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  const passwordPreflight = await call('OPTIONS', '/v1/auth/password', { headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  const revokePreflight = await call('OPTIONS', '/v1/auth/sessions/revoke', { headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  for (const preflight of [passwordPreflight, revokePreflight]) {
    assert.equal(preflight.status, loginPreflight.status);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), loginPreflight.headers.get('Access-Control-Allow-Methods'));
    assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), loginPreflight.headers.get('Access-Control-Allow-Headers'));
    assert.equal(preflight.headers.get('Access-Control-Max-Age'), loginPreflight.headers.get('Access-Control-Max-Age'));
  }
  const evil = await call('POST', '/v1/auth/password', {
    token,
    body: { currentPassword: PASSWORD, newPassword: NEXT },
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(evil.status, 403);
  assert.equal(evil.body.error.code, 'origin_not_allowed');
  assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);
  const after = await snapshot(mf, 'gina');
  assert.deepEqual(after.author, before.author);
  assert.deepEqual(after.sessions, before.sessions);
  assert.equal((await call('GET', '/v1/health')).body.auth, 'password');
});

test('password failures use the login cap without locking a different author', async () => {
  const limited = await start({ LOGIN_FAILURES_PER_USERNAME_HOUR: '2', REGISTERS_PER_IP_HOUR: '20', LOGINS_PER_IP_HOUR: '50' });
  try {
    const c = client(limited);
    assert.equal((await register(limited, c, 'hope')).status, 201);
    assert.equal((await register(limited, c, 'iris')).status, 201);
    const hope = await login(c, 'hope');
    const iris = await login(c, 'iris');
    const wrong = () => c('POST', '/v1/auth/password', { token: hope.body.token, body: { currentPassword: 'wrong password value', newPassword: NEXT } });
    assert.equal((await wrong()).status, 401);
    assert.equal((await wrong()).status, 401);
    const locked = await c('POST', '/v1/auth/password', { token: hope.body.token, body: { currentPassword: PASSWORD, newPassword: NEXT } });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, 'rate_limited');
    assert.ok(Number(locked.headers.get('Retry-After')) > 0);
    assert.equal((await login(c, 'hope', PASSWORD)).status, 200, 'password bucket does not consume the login bucket');
    const moved = await c('POST', '/v1/auth/password', { token: iris.body.token, body: { currentPassword: PASSWORD, newPassword: NEXT } });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body, { changed: true });
  } finally {
    await limited.dispose();
  }
});
