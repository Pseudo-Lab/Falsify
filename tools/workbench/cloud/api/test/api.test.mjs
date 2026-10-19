// Local Miniflare + D1 tests for the shared records API. Synthetic data only; no remote resources.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(apiRoot, '../..');
const H = require(path.join(repoRoot, 'app/dist/harness-core.js'));
// Until root integration the shared core lives in the contract worktree; FALSIFY_CLOUD_CORE overrides both.
const integratedCore = path.join(repoRoot, 'app/dist/cloud-records-core.mjs');
const corePath = process.env.FALSIFY_CLOUD_CORE || (existsSync(integratedCore) ? integratedCore : path.resolve(repoRoot, '../contract/app/dist/cloud-records-core.mjs'));

const ORIGIN = 'https://shinick-han.github.io';
const LOCAL_ORIGIN = 'http://127.0.0.1:8787';
const PASSWORD = 'correct horse battery';
const sha256 = text => createHash('sha256').update(text).digest('hex');

let script;
let statements;
let mf;
let call;

async function bundle() {
  const result = await build({
    entryPoints: [path.join(apiRoot, 'src/index.js')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['node:*'],
    logLevel: 'silent',
    plugins: [{ name: 'shared-core', setup: b => b.onResolve({ filter: /cloud-records-core\.mjs$/ }, () => ({ path: corePath })) }],
  });
  return result.outputFiles[0].text;
}

function migrationStatements() {
  const sql = ['0001_shared_records.sql', '0002_invite_membership.sql'].map(name => readFileSync(path.join(apiRoot, 'migrations', name), 'utf8')).join('\n');
  return sql
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

async function start(bindings = {}, { db = true } = {}) {
  const instance = new Miniflare(
    convertV4MiniflareOptions({
      name: 'falsify-cloud-api-test',
      modules: true,
      script,
      compatibilityDate: '2026-10-19',
      compatibilityFlags: ['nodejs_compat'],
      bindings: { ALLOWED_ORIGINS: `${ORIGIN},${LOCAL_ORIGIN}`, ...bindings },
      ...(db ? { d1Databases: ['DB'] } : {}),
    })
  );
  if (db) {
    const d1 = await instance.getD1Database('DB');
    for (const statement of statements) await d1.prepare(statement).run();
  }
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

// Seeds one invitation row directly (only its SHA-256 is stored) and returns the plaintext code.
async function invite(instance = mf, { ttlMs = 3600e3, revoked = false } = {}) {
  const code = 'fsi_' + randomBytes(32).toString('base64url');
  const d1 = await instance.getD1Database('DB');
  await d1
    .prepare('INSERT INTO invitations (code_hash, created_at, expires_at, revoked_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(sha256(code), new Date().toISOString(), Date.now() + ttlMs, revoked ? new Date().toISOString() : null)
    .run();
  return code;
}

// Every registration carries a fresh invitation unless the caller supplies (or omits) inviteCode itself.
async function registerOn(c, instance, username, password = PASSWORD, extra = {}, headers = {}) {
  const body = { username, password, ...(Object.hasOwn(extra, 'inviteCode') ? {} : { inviteCode: await invite(instance) }), ...extra };
  if (body.inviteCode === undefined) delete body.inviteCode;
  return c('POST', '/v1/auth/register', { body, headers });
}
const register = (username, password = PASSWORD, extra = {}, headers = {}) => registerOn(call, mf, username, password, extra, headers);
const login = (username, password = PASSWORD, headers = {}) => call('POST', '/v1/auth/login', { body: { username, password }, headers });

// An oversized body answered before it is consumed can reset a shared keep-alive connection mid-upload, so
// these cases use their own connection: send the headers (and, when chunked, body chunks only until the
// response arrives), read the early response, then drop the socket. The response status is still asserted.
async function oversized(instance, pathname, { token, bytes, chunked = false }) {
  const url = new URL(pathname, await instance.ready);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Connection: 'close' };
  if (!chunked) headers['Content-Length'] = String(bytes);
  return new Promise((resolve, reject) => {
    let answered = false;
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('no early response'));
    }, 10000);
    const req = http.request(url, { method: 'POST', headers, agent: false }, res => {
      answered = true;
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => {
        clearTimeout(timer);
        req.destroy();
        const text = Buffer.concat(parts).toString('utf8');
        resolve({ status: res.statusCode, headers: new Headers(res.headers), body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', error => {
      if (!answered) {
        clearTimeout(timer);
        reject(error);
      }
    });
    req.flushHeaders();
    if (!chunked) return;
    const chunk = Buffer.from('{"kind":"run","payload":{"pad":"' + 'x'.repeat(64 * 1024));
    let sent = 0;
    const pump = () => {
      while (!answered && sent < bytes) {
        sent += chunk.length;
        if (!req.write(chunk)) return req.once('drain', pump);
      }
    };
    pump();
  });
}

async function harnessPayload(id) {
  const config = { schema: 'falsify.harness.v1', id, name: `Synthetic ${id}`, version: '1', role: 'red', instructions: 'Find explicit contradictions.', maxCalls: 4 };
  return { config, hash: await H.hash(config) };
}

function runPayload(localId = 'local-run-1') {
  const segments = [{ id: 's1', label: 'Synthetic', text: 'Synthetic paper text only.' }];
  return {
    localId,
    role: 'red',
    harnessHash: 'a'.repeat(64),
    sourceHash: sha256(segments.map(s => s.text).join('\n\n')),
    fileHash: 'b'.repeat(64),
    model: 'synthetic-model',
    level: 1,
    maxCalls: 4,
    status: 'ok',
    calls: 3,
    provenance: 'local-codex',
    caseLabel: 'case-a',
    protocolVersion: 'p1',
    createdAt: '2026-10-19T00:00:00Z',
    evidence: { segments, response: { status: 'ok', secretFinding: 'private evidence' } },
  };
}

const reviewPayload = (runId, note = 'Synthetic review.') => ({ runId, verdict: 'supported', score: 4, note, caseLabel: 'case-a', protocolVersion: 'p1' });

async function d1All(instance, sql) {
  const d1 = await instance.getD1Database('DB');
  return (await d1.prepare(sql).all()).results;
}

const users = {};

before(async () => {
  script = await bundle();
  statements = migrationStatements();
  mf = await start({ REGISTERS_PER_IP_HOUR: '100', LOGIN_FAILURES_PER_USERNAME_HOUR: '100', LOGINS_PER_IP_HOUR: '1000' });
  call = client(mf);
});

after(async () => {
  await mf?.dispose();
});

test('health reports password auth', async () => {
  const res = await call('GET', '/v1/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { schema: 'falsify.cloud.v1', ready: true, auth: 'password', registration: 'invite-only', sharedAccess: 'members' });
});

test('register validates username and password without composition rules', async () => {
  for (const username of ['ab', 'a'.repeat(33), 'bad name', 'café-user', 'semi;colon']) {
    const res = await register(username);
    assert.equal(res.status, 400, username);
    assert.equal(res.body.error.code, 'invalid_username');
  }
  for (const password of ['a'.repeat(11), 'a'.repeat(129), 42, null]) {
    const res = await register('valid_user', password);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_password');
  }
  assert.equal((await register('valid_user', PASSWORD, { email: 'x@example.invalid' })).body.error.code, 'invalid_request');
  assert.equal((await call('POST', '/v1/auth/register', { body: { username: 'only_name' } })).body.error.code, 'invalid_request');

  const alice = await register('Alice', PASSWORD);
  assert.equal(alice.status, 201);
  assert.match(alice.body.token, /^fss_[A-Za-z0-9_-]{43}$/);
  assert.equal(alice.body.author.username, 'alice');
  assert.equal(alice.body.author.displayName, 'Alice');
  assert.match(alice.body.author.id, /^[0-9a-f-]{36}$/);
  const ttl = Date.parse(alice.body.expiresAt) - Date.now();
  assert.ok(ttl > 6.9 * 86400e3 && ttl <= 7 * 86400e3, 'session expires in 7 days');
  assert.deepEqual(Object.keys(alice.body).sort(), ['author', 'expiresAt', 'token']);
  users.alice = alice.body;

  const simple = await register('bob', 'aaaaaaaaaaaa', { displayName: 'Bob B' });
  assert.equal(simple.status, 201, 'twelve identical characters are allowed');
  assert.equal(simple.body.author.displayName, 'Bob B');
  users.bob = simple.body;

  const taken = await register('ALICE', 'another password!');
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'username_taken');
});

test('concurrent registrations of one username create exactly one account', async () => {
  const codes = [await invite(), await invite()];
  const results = await Promise.all([register('carol', PASSWORD, { inviteCode: codes[0] }), register('Carol', 'different password', { inviteCode: codes[1] })]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  users.carol = results.find(r => r.status === 201).body;
  const claims = await d1All(mf, `SELECT claimed_by FROM invitations WHERE code_hash IN ('${sha256(codes[0])}', '${sha256(codes[1])}')`);
  assert.deepEqual(claims.map(r => r.claimed_by === null).sort(), [false, true], 'the losing registration does not burn its invitation');
  const rows = await d1All(mf, "SELECT id FROM authors WHERE username = 'carol'");
  assert.equal(rows.length, 1);
});

test('only salted scrypt hashes and session token hashes are stored', async () => {
  const authors = await d1All(mf, 'SELECT username, password_hash FROM authors');
  const hashes = authors.map(a => a.password_hash);
  for (const h of hashes) assert.match(h, /^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.equal(new Set(hashes.map(h => h.split('$')[4])).size, hashes.length, 'salts are unique');
  const sessions = await d1All(mf, 'SELECT token_hash FROM sessions');
  assert.ok(sessions.some(s => s.token_hash === sha256(users.alice.token)));
  const dump = JSON.stringify([authors, sessions, await d1All(mf, 'SELECT * FROM rate_counters')]);
  for (const secret of [PASSWORD, 'aaaaaaaaaaaa', users.alice.token, users.bob.token]) assert.ok(!dump.includes(secret));
});

test('login is case-insensitive and failures are one generic 401 after equal work', async () => {
  const ok = await login('ALICE');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.author.id, users.alice.author.id);
  assert.notEqual(ok.body.token, users.alice.token);
  users.alice2 = ok.body;

  const timed = async (username, password) => {
    const begin = performance.now();
    const res = await login(username, password);
    return { res, ms: performance.now() - begin };
  };
  const wrong = await timed('alice', 'wrong password value');
  const unknown = await timed('nobody_here', 'wrong password value');
  const malformed = await timed('no', 'short');
  for (const { res } of [wrong, unknown, malformed]) {
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, wrong.res.body);
  }
  assert.equal(wrong.res.body.error.code, 'invalid_credentials');
  assert.ok(unknown.ms >= wrong.ms * 0.5, `unknown-user login does dummy work (${unknown.ms} vs ${wrong.ms} ms)`);
  assert.ok(malformed.ms >= wrong.ms * 0.5, 'malformed login does dummy work');
  assert.equal((await call('POST', '/v1/auth/login', { body: { username: 'alice', password: 7 } })).status, 400);
});

test('me, logout revocation and session expiry', async () => {
  const me = await call('GET', '/v1/me', { token: users.alice2.token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.author, users.alice.author);
  const out = await call('POST', '/v1/logout', { token: users.alice2.token });
  assert.deepEqual([out.status, out.body], [200, { revoked: true }]);
  assert.equal((await call('GET', '/v1/me', { token: users.alice2.token })).status, 401);
  assert.equal((await call('POST', '/v1/logout', { token: users.alice2.token })).status, 401);
  assert.equal((await call('GET', '/v1/me', { token: users.alice.token })).status, 200, 'other sessions stay valid');

  const temp = await login('carol');
  const d1 = await mf.getD1Database('DB');
  await d1.prepare('UPDATE sessions SET expires_at = ?1 WHERE token_hash = ?2').bind(Date.now() - 1, sha256(temp.body.token)).run();
  const expired = await call('GET', '/v1/me', { token: temp.body.token });
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.code, 'unauthorized');
  for (const header of ['Bearer fss_short', 'Basic abc', `Bearer ${'fsk_' + 'A'.repeat(43)}`]) {
    assert.equal((await call('GET', '/v1/me', { headers: { Authorization: header } })).status, 401);
  }
});

test('private records are isolated between authors', async () => {
  const created = await call('POST', '/v1/records', { token: users.alice.token, body: { kind: 'harness', payload: await harnessPayload('private-h') } });
  assert.equal(created.status, 201);
  const record = created.body.record;
  assert.equal(record.visibility, 'private');
  assert.equal(record.revision, 1);
  assert.equal(record.attestation, 'client-reported');
  assert.deepEqual(record.owner, { id: users.alice.author.id, username: 'alice', displayName: 'Alice' });
  users.privateId = record.id;

  assert.equal((await call('GET', `/v1/records/${record.id}`, { token: users.bob.token })).status, 404);
  assert.equal((await call('GET', `/v1/records/${record.id}`)).status, 401);
  const bobMine = await call('GET', '/v1/records?scope=mine', { token: users.bob.token });
  assert.ok(!bobMine.body.records.some(r => r.id === record.id));
  const shared = await call('GET', '/v1/records?scope=shared', { token: users.bob.token });
  assert.ok(!shared.body.records.some(r => r.id === record.id));
  assert.equal((await call('GET', '/v1/records?scope=mine')).status, 401);
  const aliceMine = await call('GET', '/v1/records?scope=mine', { token: users.alice.token });
  assert.ok(aliceMine.body.records.some(r => r.id === record.id));
  assert.equal((await call('PATCH', `/v1/records/${record.id}`, { token: users.bob.token, body: { expectedRevision: 1, visibility: 'shared' } })).status, 404);
  assert.equal((await call('DELETE', `/v1/records/${record.id}`, { token: users.bob.token, headers: { 'If-Match': '1' } })).status, 404);
});

test('share and unshare use revision compare-and-set; payload is immutable', async () => {
  const id = users.privateId;
  const shared = await call('PATCH', `/v1/records/${id}`, { token: users.alice.token, body: { expectedRevision: 1, visibility: 'shared' } });
  assert.equal(shared.status, 200);
  assert.equal(shared.body.record.revision, 2);
  assert.equal((await call('GET', `/v1/records/${id}`, { token: users.bob.token })).status, 200);
  assert.ok((await call('GET', '/v1/records?scope=shared&kind=harness', { token: users.bob.token })).body.records.some(r => r.id === id));

  const stale = await call('PATCH', `/v1/records/${id}`, { token: users.alice.token, body: { expectedRevision: 1, visibility: 'private' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'revision_conflict');
  const mutate = await call('PATCH', `/v1/records/${id}`, { token: users.alice.token, body: { expectedRevision: 2, visibility: 'shared', payload: {} } });
  assert.equal(mutate.status, 400);

  const unshared = await call('PATCH', `/v1/records/${id}`, { token: users.alice.token, body: { expectedRevision: 2, visibility: 'private' } });
  assert.equal(unshared.body.record.revision, 3);
  assert.equal((await call('GET', `/v1/records/${id}`, { token: users.bob.token })).status, 404);
});

test('public projections redact run evidence and local ids', async () => {
  const created = await call('POST', '/v1/records', { token: users.alice.token, body: { kind: 'run', visibility: 'shared', payload: runPayload() } });
  assert.equal(created.status, 201);
  const id = created.body.record.id;
  users.runId = id;
  assert.ok(created.body.record.payload.evidence, 'owner create response keeps private evidence');
  const owner = await call('GET', `/v1/records/${id}`, { token: users.alice.token });
  assert.equal(owner.body.record.payload.localId, 'local-run-1');
  for (const res of [await call('GET', `/v1/records/${id}`, { token: users.carol.token }), await call('GET', `/v1/records/${id}`, { token: users.bob.token })]) {
    assert.equal(res.status, 200);
    assert.ok(!('evidence' in res.body.record.payload));
    assert.ok(!('localId' in res.body.record.payload));
    assert.ok(!JSON.stringify(res.body).includes('private evidence'));
  }
  const list = await call('GET', '/v1/records?scope=shared&kind=run', { token: users.bob.token });
  assert.ok(list.body.records.some(r => r.id === id));
  assert.ok(!JSON.stringify(list.body).includes('private evidence'));

  const dup = await call('POST', '/v1/records', { token: users.alice.token, body: { kind: 'run', visibility: 'shared', payload: runPayload() } });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.deduplicated, true);
  assert.equal(dup.body.record.id, id);
});

test('reviews require a visible run and disappear when the run is unshared', async () => {
  const review = await call('POST', '/v1/records', { token: users.bob.token, body: { kind: 'review', visibility: 'shared', payload: reviewPayload(users.runId) } });
  assert.equal(review.status, 201);
  const reviewId = review.body.record.id;
  assert.equal((await call('GET', `/v1/records/${reviewId}`, { token: users.carol.token })).status, 200);

  const run = await call('GET', `/v1/records/${users.runId}`, { token: users.alice.token });
  await call('PATCH', `/v1/records/${users.runId}`, { token: users.alice.token, body: { expectedRevision: run.body.record.revision, visibility: 'private' } });
  assert.equal((await call('GET', `/v1/records/${reviewId}`, { token: users.carol.token })).status, 404);
  assert.ok(!(await call('GET', '/v1/records?scope=shared&kind=review', { token: users.carol.token })).body.records.some(r => r.id === reviewId));
  assert.equal((await call('GET', `/v1/records/${reviewId}`, { token: users.bob.token })).status, 200, 'owner still reads own review');

  const hidden = await call('POST', '/v1/records', { token: users.bob.token, body: { kind: 'review', payload: reviewPayload(users.runId, 'Second.') } });
  assert.equal(hidden.status, 422);
  assert.equal(hidden.body.error.code, 'invalid_reference');
  const own = await call('POST', '/v1/records', { token: users.alice.token, body: { kind: 'review', payload: reviewPayload(users.runId, 'Own private.') } });
  assert.equal(own.status, 201, 'owner may review own private run privately');
  const sharedOnPrivate = await call('POST', '/v1/records', { token: users.alice.token, body: { kind: 'review', visibility: 'shared', payload: reviewPayload(users.runId, 'Shared.') } });
  assert.equal(sharedOnPrivate.status, 422);
});

test('pagination is bounded and cursor-validated', async () => {
  for (const id of ['page-1', 'page-2', 'page-3']) {
    const res = await call('POST', '/v1/records', { token: users.bob.token, body: { kind: 'harness', visibility: 'shared', payload: await harnessPayload(id) } });
    assert.equal(res.status, 201);
  }
  const first = await call('GET', '/v1/records?scope=mine&kind=harness&limit=2', { token: users.bob.token });
  assert.equal(first.body.records.length, 2);
  assert.ok(first.body.nextCursor);
  const second = await call('GET', `/v1/records?scope=mine&kind=harness&limit=2&cursor=${first.body.nextCursor}`, { token: users.bob.token });
  assert.equal(second.body.records.length, 1);
  assert.equal(second.body.nextCursor, null);
  const ids = [...first.body.records, ...second.body.records].map(r => r.id);
  assert.equal(new Set(ids).size, 3);
  const token = users.bob.token;
  assert.equal((await call('GET', '/v1/records?cursor=abc', { token })).body.error.code, 'invalid_cursor');
  assert.equal((await call('GET', '/v1/records?limit=101', { token })).status, 400);
  assert.equal((await call('GET', '/v1/records?scope=all', { token })).status, 400);
  assert.equal((await call('GET', '/v1/records?kind=run&kind=review', { token })).status, 400);
});

test('malformed requests get fixed safe errors', async () => {
  const t = users.alice.token;
  const cases = [
    [await call('POST', '/v1/records', { token: t, raw: '{not json' }), 400, 'invalid_json'],
    [await call('POST', '/v1/records', { token: t, raw: '[]' }), 400, 'invalid_json'],
    [await call('POST', '/v1/records', { token: t, raw: '{}', headers: { 'Content-Type': 'text/plain' } }), 415, 'unsupported_media_type'],
    [await call('POST', '/v1/auth/login', { raw: JSON.stringify({ username: 'alice', password: 'x'.repeat(5000) }) }), 413, 'payload_too_large'],
    [await oversized(mf, '/v1/records', { token: t, bytes: 257 * 1024 }), 413, 'payload_too_large'],
    [await oversized(mf, '/v1/records', { token: t, bytes: 1024 * 1024, chunked: true }), 413, 'payload_too_large'],
    [await call('POST', '/v1/records', { token: t, body: { kind: 'run', payload: { role: 'red' } } }), 422, 'invalid_payload'],
    [await call('POST', '/v1/records', { token: t, body: { kind: 'other', payload: {} } }), 400, 'invalid_request'],
    [await call('POST', '/v1/records', { token: t, body: { kind: 'harness', payload: {}, owner: 'x' } }), 400, 'invalid_request'],
    [await call('POST', '/v1/records', { body: { kind: 'harness', payload: {} } }), 401, 'unauthorized'],
    [await call('GET', '/v1/nope'), 404, 'not_found'],
    [await call('PUT', '/v1/records'), 405, 'method_not_allowed'],
    [await call('GET', '/v1/records/not-a-uuid'), 404, 'not_found'],
    [await call('DELETE', `/v1/records/${users.privateId}`, { token: t }), 428, 'precondition_required'],
    [await call('DELETE', `/v1/records/${users.privateId}`, { token: t, headers: { 'If-Match': '1' } }), 409, 'revision_conflict'],
  ];
  for (const [res, status, code] of cases) {
    assert.equal(res.status, status, code);
    assert.equal(res.body.error.code, code);
    assert.equal(typeof res.body.error.message, 'string');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  }
  const deleted = await call('DELETE', `/v1/records/${users.privateId}`, { token: t, headers: { 'If-Match': '3' } });
  assert.deepEqual([deleted.status, deleted.body], [200, { deleted: true, id: users.privateId }]);
  assert.equal((await call('GET', `/v1/records/${users.privateId}`, { token: t })).status, 404);
});

test('CORS allows only exact configured origins', async () => {
  const preflight = await call('OPTIONS', '/v1/records', { headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PATCH' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /PATCH/);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /if-match/);
  const local = await call('GET', '/v1/health', { headers: { Origin: LOCAL_ORIGIN } });
  assert.equal(local.headers.get('Access-Control-Allow-Origin'), LOCAL_ORIGIN);
  for (const origin of ['https://evil.example', `${ORIGIN}.evil.example`, 'null']) {
    const denied = await call('POST', '/v1/auth/login', { body: { username: 'alice', password: PASSWORD }, headers: { Origin: origin } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'origin_not_allowed');
    assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
  }
});

test('auth rate caps, record quota and hashed rate buckets', async () => {
  const limited = await start({ MAX_RECORDS_PER_AUTHOR: '2', REGISTERS_PER_IP_HOUR: '2', LOGIN_FAILURES_PER_USERNAME_HOUR: '2' });
  try {
    const c = client(limited);
    const ip = { 'CF-Connecting-IP': '203.0.113.9' };
    const reg = (u, h) => registerOn(c, limited, u, PASSWORD, {}, h);
    assert.equal((await reg('quota_one', ip)).status, 201);
    const second = await reg('quota_two', ip);
    assert.equal(second.status, 201);
    const third = await reg('quota_three', ip);
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'rate_limited');
    assert.ok(Number(third.headers.get('Retry-After')) > 0);
    assert.equal((await reg('quota_four', { 'CF-Connecting-IP': '203.0.113.10' })).status, 201, 'other IP unaffected');

    const token = second.body.token;
    for (const id of ['q1', 'q2']) assert.equal((await c('POST', '/v1/records', { token, body: { kind: 'harness', payload: await harnessPayload(id) } })).status, 201);
    const over = await c('POST', '/v1/records', { token, body: { kind: 'harness', payload: await harnessPayload('q3') } });
    assert.equal(over.status, 403);
    assert.equal(over.body.error.code, 'quota_exceeded');

    const bad = () => c('POST', '/v1/auth/login', { body: { username: 'QUOTA_ONE', password: 'wrong password value' } });
    assert.equal((await bad()).status, 401);
    assert.equal((await bad()).status, 401);
    const locked = await c('POST', '/v1/auth/login', { body: { username: 'quota_one', password: PASSWORD } });
    assert.equal(locked.status, 429, 'failed-login cap applies per username, even with the right password');
    assert.equal((await c('POST', '/v1/auth/login', { body: { username: 'quota_two', password: PASSWORD } })).status, 200);

    const buckets = JSON.stringify(await d1All(limited, 'SELECT bucket FROM rate_counters'));
    for (const raw of ['203.0.113', 'quota_one', 'quota_two']) assert.ok(!buckets.includes(raw));
  } finally {
    await limited.dispose();
  }
});

const tally = responses => responses.reduce((acc, res) => ({ ...acc, [res.status]: (acc[res.status] || 0) + 1 }), {});

test('concurrent wrong-password logins from many IPs cannot exceed the per-username failure cap', async () => {
  const limited = await start({ LOGIN_FAILURES_PER_USERNAME_HOUR: '10' });
  try {
    const c = client(limited);
    const attempt = (password, i) => c('POST', '/v1/auth/login', { body: { username: 'victim', password }, headers: { 'CF-Connecting-IP': `198.51.100.${i}` } });
    assert.equal((await registerOn(c, limited, 'victim')).status, 201);
    for (let i = 0; i < 12; i++) assert.equal((await attempt(PASSWORD, 200)).status, 200, 'successful logins release their reserved slot');
    const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => attempt('wrong password value', i)));
    assert.deepEqual(tally(burst), { 401: 10, 429: 30 });
    for (const res of burst.filter(r => r.status === 401)) assert.equal(res.body.error.code, 'invalid_credentials');
    for (const res of burst.filter(r => r.status === 429)) {
      assert.equal(res.body.error.code, 'rate_limited');
      assert.ok(Number(res.headers.get('Retry-After')) > 0);
    }
    assert.equal((await attempt(PASSWORD, 201)).status, 429, 'locked username stays locked for the right password');
  } finally {
    await limited.dispose();
  }
});

test('global login attempt cap holds across fresh IPs and usernames', async () => {
  const limited = await start({ LOGINS_PER_HOUR: '5' });
  try {
    const c = client(limited);
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      c('POST', '/v1/auth/login', { body: { username: `ghost_${i}`, password: 'wrong password value' }, headers: { 'CF-Connecting-IP': `192.0.2.${i}` } })
    ));
    assert.deepEqual(tally(burst), { 401: 5, 429: 15 });
    for (const res of burst.filter(r => r.status === 429)) assert.equal(res.body.error.code, 'rate_limited');
    const fresh = await c('POST', '/v1/auth/login', { body: { username: 'ghost_new', password: 'wrong password value' }, headers: { 'CF-Connecting-IP': '192.0.2.250' } });
    assert.equal(fresh.status, 429, 'a new IP and username do not bypass the global cap');
  } finally {
    await limited.dispose();
  }
});

const INVALID_INVITATION = { error: { code: 'invalid_invitation', message: 'The invitation code is not valid.' } };

test('registration requires a usable invitation; every bad code is one fixed 403', async () => {
  assert.equal((await register('no_code', PASSWORD, { inviteCode: undefined })).body.error.code, 'invalid_request', 'inviteCode is a required field');
  const used = await invite();
  assert.equal((await register('first_claim', PASSWORD, { inviteCode: used })).status, 201);
  const cases = {
    malformed: 'fsi_short',
    wrongPrefix: 'fss_' + 'A'.repeat(43),
    nonString: 42,
    unknown: 'fsi_' + randomBytes(32).toString('base64url'),
    expired: await invite(mf, { ttlMs: -1000 }),
    revoked: await invite(mf, { revoked: true }),
    used,
  };
  for (const [label, inviteCode] of Object.entries(cases)) {
    const res = await register(`denied_${label.toLowerCase()}`, PASSWORD, { inviteCode });
    assert.equal(res.status, 403, label);
    assert.deepEqual(res.body, INVALID_INVITATION, label);
  }
  assert.equal((await d1All(mf, "SELECT id FROM authors WHERE username LIKE 'denied_%'")).length, 0, 'no stranded authors');
  const dump = JSON.stringify(await d1All(mf, 'SELECT * FROM invitations'));
  assert.ok(!dump.includes(used) && dump.includes(sha256(used)), 'only invitation hashes are stored');
});

test('invalid invitations are rate limited before any password derivation', async () => {
  const limited = await start({ REGISTERS_PER_IP_HOUR: '2' });
  try {
    const c = client(limited);
    const bad = () => registerOn(c, limited, 'guesser', PASSWORD, { inviteCode: 'fsi_' + randomBytes(32).toString('base64url') }, { 'CF-Connecting-IP': '203.0.113.50' });
    assert.equal((await bad()).status, 403);
    assert.equal((await bad()).status, 403);
    const third = await bad();
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'rate_limited');
  } finally {
    await limited.dispose();
  }
});

test('one invitation admits exactly one of several concurrent registrations', async () => {
  const code = await invite();
  const results = await Promise.all(['race_a', 'race_b', 'race_c'].map(u => register(u, PASSWORD, { inviteCode: code })));
  assert.deepEqual(tally(results), { 201: 1, 403: 2 });
  const winner = results.find(r => r.status === 201).body.author;
  assert.deepEqual(await d1All(mf, "SELECT username FROM authors WHERE username LIKE 'race_%'"), [{ username: winner.username }]);
  const [row] = await d1All(mf, `SELECT claimed_by, claimed_at FROM invitations WHERE code_hash = '${sha256(code)}'`);
  assert.equal(row.claimed_by, winner.id);
  assert.ok(row.claimed_at);
  assert.deepEqual(await d1All(mf, `SELECT status FROM team_members WHERE author_id = '${winner.id}'`), [{ status: 'active' }]);
});

test('a taken username leaves the invitation usable', async () => {
  const code = await invite();
  const taken = await register('ALICE', PASSWORD, { inviteCode: code });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'username_taken');
  assert.deepEqual(await d1All(mf, `SELECT claimed_by FROM invitations WHERE code_hash = '${sha256(code)}'`), [{ claimed_by: null }]);
  assert.equal((await register('alice_two', PASSWORD, { inviteCode: code })).status, 201);
});

test('signed-out and non-member requests never read records', async () => {
  for (const pathname of ['/v1/records', '/v1/records?scope=shared', `/v1/records/${users.runId}`, '/v1/me']) {
    const res = await call('GET', pathname, { headers: { Origin: ORIGIN } });
    assert.equal(res.status, 401, pathname);
    assert.equal(res.body.error.code, 'unauthorized');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.ok(!('records' in res.body) && !('record' in res.body));
  }
  const preflight = await call('OPTIONS', '/v1/records', { headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' } });
  assert.deepEqual([preflight.status, preflight.body], [204, null]);
});

test('authenticated members read other owners only through the shared projection', async () => {
  const run = await call('POST', '/v1/records', { token: users.alice.token, body: { kind: 'run', visibility: 'shared', payload: runPayload('member-projection') } });
  assert.equal(run.status, 201);
  const id = run.body.record.id;
  const privateRun = await call('POST', '/v1/records', { token: users.alice.token, body: { kind: 'run', payload: runPayload('member-private') } });
  for (const token of [users.bob.token, users.carol.token]) {
    const one = await call('GET', `/v1/records/${id}`, { token });
    assert.equal(one.status, 200);
    assert.equal(one.body.record.owner.username, 'alice');
    assert.equal(one.body.record.attestation, 'client-reported');
    assert.ok(!JSON.stringify(one.body).includes('private evidence') && !JSON.stringify(one.body).includes('member-projection'));
    const list = await call('GET', '/v1/records?scope=shared&kind=run', { token });
    assert.ok(list.body.records.some(r => r.id === id));
    assert.ok(!list.body.records.some(r => r.id === privateRun.body.record.id));
    assert.ok(!JSON.stringify(list.body).includes('private evidence'));
    assert.equal((await call('GET', `/v1/records/${privateRun.body.record.id}`, { token })).status, 404);
  }
});

// Runs operator CLI SQL locally; its validated literals never contain ';'.
async function operatorSql(sql) {
  const d1 = await mf.getD1Database('DB');
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await d1.prepare(statement).run();
}

// Mirrors the Worker's stored format so a test can seed an author the way migration 0001 left it.
function scryptHash(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFC'), salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$3$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

test('pre-migration accounts and sessions are denied until an operator admits them; revoke keeps records', async () => {
  const { admitSql, revokeSql } = await import('../scripts/invites.mjs');
  const d1 = await mf.getD1Database('DB');
  const id = crypto.randomUUID();
  const token = 'fss_' + randomBytes(32).toString('base64url');
  const at = new Date().toISOString();
  await d1.prepare('INSERT INTO authors (id, username, display_name, password_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, 'legacy', 'Legacy', scryptHash(PASSWORD), at).run();
  await d1.prepare('INSERT INTO sessions (token_hash, author_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)').bind(sha256(token), id, at, Date.now() + 3600e3).run();
  const shared = await call('GET', '/v1/records?scope=shared', { token: users.alice.token });
  const existingId = shared.body.records[0].id;
  const denied = [
    await call('GET', '/v1/me', { token }),
    await call('GET', '/v1/records?scope=shared', { token }),
    await call('GET', '/v1/records?scope=mine', { token }),
    await call('GET', `/v1/records/${existingId}`, { token }),
    await call('POST', '/v1/records', { token, body: { kind: 'harness', payload: await harnessPayload('legacy-h') } }),
    await call('PATCH', `/v1/records/${existingId}`, { token, body: { expectedRevision: 1, visibility: 'private' } }),
    await call('DELETE', `/v1/records/${existingId}`, { token, headers: { 'If-Match': '1' } }),
  ];
  for (const res of denied) {
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: { code: 'membership_required', message: 'An active team membership is required.' } });
  }
  const before = (await d1All(mf, `SELECT COUNT(*) AS n FROM sessions WHERE author_id = '${id}'`))[0].n;
  const login = await call('POST', '/v1/auth/login', { body: { username: 'legacy', password: PASSWORD } });
  assert.deepEqual([login.status, login.body.error.code], [403, 'membership_required']);
  assert.equal((await d1All(mf, `SELECT COUNT(*) AS n FROM sessions WHERE author_id = '${id}'`))[0].n, before, 'no session for a non-member');
  assert.equal((await call('POST', '/v1/auth/login', { body: { username: 'legacy', password: 'wrong password value' } })).status, 401);

  await operatorSql(admitSql('legacy', new Date().toISOString()));
  assert.equal((await call('GET', '/v1/me', { token })).status, 200, 'admit reactivates the existing session');
  const member = await call('POST', '/v1/auth/login', { body: { username: 'Legacy', password: PASSWORD } });
  assert.equal(member.status, 200);
  const created = await call('POST', '/v1/records', { token: member.body.token, body: { kind: 'harness', payload: await harnessPayload('legacy-kept') } });
  assert.equal(created.status, 201);

  await operatorSql(revokeSql('legacy', new Date().toISOString()));
  for (const t of [token, member.body.token]) assert.equal((await call('GET', '/v1/me', { token: t })).status, 401, 'revoke ends every session');
  assert.equal((await call('POST', '/v1/auth/login', { body: { username: 'legacy', password: PASSWORD } })).status, 403);
  assert.equal((await d1All(mf, `SELECT COUNT(*) AS n FROM records WHERE owner_id = '${id}'`))[0].n, 1, 'records are preserved');
  assert.deepEqual(await d1All(mf, `SELECT status FROM team_members WHERE author_id = '${id}'`), [{ status: 'revoked' }]);
  await operatorSql(admitSql('legacy', new Date().toISOString()));
  assert.equal((await call('POST', '/v1/auth/login', { body: { username: 'legacy', password: PASSWORD } })).status, 200, 'admit after revoke');
});

test('invite CLI: argument validation and environment mapping match wrangler.jsonc', async () => {
  const cli = await import('../scripts/invites.mjs');
  const outside = path.join(os.tmpdir(), 'falsify-invite-never-created.txt');
  const bad = [
    [],
    ['delete', '--env', 'staging'],
    ['issue', '--env', 'dev', '--out', outside],
    ['issue', '--env', 'staging', '--out', 'relative.txt'],
    ['issue', '--env', 'staging', '--out', path.join(repoRoot, 'invite.txt')],
    ['issue', '--env', 'staging', '--out', outside, '--hours', '0'],
    ['issue', '--env', 'staging', '--out', outside, '--hours', '169'],
    ['issue', '--env', 'staging', '--out', outside, '--username', 'alice'],
    ['issue', '--env', 'staging', '--env', 'production', '--out', outside],
    ['admit', '--env', 'staging', '--username', "x'; DROP TABLE authors;--"],
    ['revoke', '--env', 'production'],
  ];
  for (const argv of bad) assert.throws(() => cli.parseArgs(argv), cli.UsageError, argv.join(' '));
  assert.deepEqual(cli.parseArgs(['issue', '--env', 'production', '--out', outside]), { action: 'issue', dryRun: false, env: 'production', out: outside, hours: 168 });
  assert.equal(cli.parseArgs(['admit', '--env', 'staging', '--username', 'Alice']).username, 'alice');
  const config = readFileSync(path.join(apiRoot, 'wrangler.jsonc'), 'utf8');
  const names = [...config.matchAll(/"database_name": "([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(names, [cli.ENVIRONMENTS.production.database, cli.ENVIRONMENTS.staging.database]);
  const args = cli.wranglerArgs('staging', 'SELECT 1;');
  assert.deepEqual(args.slice(1, 6), ['d1', 'execute', 'falsify-harness-records-staging', '--remote', '--config']);
  assert.ok(args.includes('--env') && args[args.indexOf('--env') + 1] === 'staging');
  assert.ok(!cli.wranglerArgs('production', 'SELECT 1;').includes('--env'));
});

test('invite CLI issue writes the code only to an exclusive 0600 file and leaves nothing on failure', async () => {
  const cli = await import('../scripts/invites.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'falsify-invites-'));
  try {
    const out = path.join(dir, 'invite.txt');
    const options = cli.parseArgs(['issue', '--env', 'staging', '--out', out, '--hours', '2']);
    const calls = [];
    const dry = cli.run({ ...options, dryRun: true }, { runner: args => calls.push(args) });
    assert.equal(calls.length, 0);
    assert.ok(!existsSync(out), 'dry run creates no file');
    assert.deepEqual(Object.keys(dry).sort(), ['action', 'database', 'dryRun', 'env', 'expiresAt', 'out']);

    assert.throws(() => cli.run(options, { runner: () => { throw new Error('wrangler d1 execute failed (exit 1)'); } }), /exit 1/);
    assert.ok(!existsSync(out), 'a failed insert leaves no plaintext file');

    const d1 = await mf.getD1Database('DB');
    let sql;
    const report = cli.run(options, { runner: args => { sql = args[args.length - 1]; } });
    const code = readFileSync(out, 'utf8').trim();
    assert.match(code, /^fsi_[A-Za-z0-9_-]{43}$/);
    if (process.platform !== 'win32') assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.ok(sql.includes(sha256(code)) && !sql.includes(code), 'SQL carries the hash only');
    assert.ok(!JSON.stringify(report).includes(code) && !JSON.stringify(report).includes(sha256(code)), 'report is redacted');
    const ttl = Date.parse(report.expiresAt) - Date.now();
    assert.ok(ttl > 1.9 * 3600e3 && ttl <= 2 * 3600e3);
    await operatorSql(sql);
    const res = await register('cli_invited', PASSWORD, { inviteCode: code });
    assert.equal(res.status, 201, 'the issued SQL creates a usable invitation');
    assert.equal((await register('cli_again', PASSWORD, { inviteCode: code })).status, 403, 'single use');

    writeFileSync(out, 'existing');
    let ran = false;
    assert.throws(() => cli.run(options, { runner: () => { ran = true; } }), { code: 'EEXIST' });
    assert.ok(!ran, 'nothing is inserted when --out exists');
    assert.equal(readFileSync(out, 'utf8'), 'existing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invite CLI subprocess: dry run prints redacted metadata and bad usage exits 2', () => {
  const script = path.join(apiRoot, 'scripts/invites.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'falsify-invites-cli-'));
  try {
    const out = path.join(dir, 'code.txt');
    const dry = spawnSync(process.execPath, [script, 'issue', '--env', 'staging', '--out', out, '--dry-run'], { encoding: 'utf8', shell: false });
    assert.equal(dry.status, 0, dry.stderr);
    const report = JSON.parse(dry.stdout);
    assert.deepEqual([report.action, report.env, report.database, report.dryRun, report.out], ['issue', 'staging', 'falsify-harness-records-staging', true, out]);
    assert.ok(!/fsi_/.test(dry.stdout + dry.stderr));
    assert.ok(!existsSync(out));
    const admit = spawnSync(process.execPath, [script, 'admit', '--env', 'production', '--username', 'Alice', '--dry-run'], { encoding: 'utf8', shell: false });
    assert.deepEqual(JSON.parse(admit.stdout), { action: 'admit', env: 'production', database: 'falsify-harness-records', dryRun: true, username: 'alice', changes: null });
    const usage = spawnSync(process.execPath, [script, 'issue', '--env', 'staging'], { encoding: 'utf8', shell: false });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage: invites\.mjs issue/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a D1 binding every endpoint answers not_configured', async () => {
  const bare = await start({}, { db: false });
  try {
    const c = client(bare);
    for (const [method, pathname] of [['GET', '/v1/health'], ['POST', '/v1/auth/login'], ['GET', '/v1/records']]) {
      const res = await c(method, pathname, method === 'POST' ? { body: { username: 'alice', password: PASSWORD } } : {});
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'not_configured');
    }
  } finally {
    await bare.dispose();
  }
});
