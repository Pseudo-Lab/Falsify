// Falsify shared records API (contract falsify.cloud.v1).
// Authors are self-chosen username/password accounts, not verified identities. Every record is a
// client-reported claim; the server only enforces ownership, visibility, revisions and bounds.
import { Buffer } from 'node:buffer';
import { scrypt, timingSafeEqual } from 'node:crypto';
import H from '../../../app/dist/harness-core.js';
import { validatePayload, publicPayload, payloadHash } from '../../../app/dist/cloud-records-core.mjs';

const SCHEMA = 'falsify.cloud.v1';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_AUTH_BODY_BYTES = 4 * 1024;
const HOUR = 3600;
const SESSION_TTL_MS = 7 * 24 * HOUR * 1000;
const KINDS = ['harness', 'run', 'review'];
const VISIBILITIES = ['private', 'shared'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^fss_[A-Za-z0-9_-]{43}$/;
const INVITE = /^fsi_[A-Za-z0-9_-]{43}$/;
const USERNAME = /^[A-Za-z0-9_-]{3,32}$/;
const CURSOR = /^[1-9][0-9]{0,15}$/;
const UNSAFE_NAME = /[\p{Cc}\u200B\u200C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const ALLOW_METHODS = 'GET, POST, PATCH, DELETE';
const ALLOW_HEADERS = 'authorization, content-type, if-match';
// Fixed memory-hard parameters; stored hashes name them so a mismatch fails closed instead of downgrading.
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const SCRYPT_PREFIX = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$`;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
// Unknown usernames still pay one full derivation against this throwaway salt.
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0x5a);

// Error messages are fixed per code so no request data, payload or storage detail is ever echoed.
const MESSAGES = {
  invalid_request: 'The request is not valid for this endpoint.',
  invalid_json: 'The request body must be a JSON object.',
  invalid_payload: 'The record payload failed validation.',
  invalid_reference: 'A referenced record is missing, not visible, or not allowed for this visibility.',
  invalid_cursor: 'The pagination cursor is not valid.',
  invalid_username: 'Usernames are 3 to 32 characters of A-Z, a-z, 0-9, _ or -.',
  invalid_password: 'Passwords are 12 to 128 characters.',
  invalid_credentials: 'The username or password is incorrect.',
  username_taken: 'This username is not available.',
  unauthorized: 'A valid session is required.',
  invalid_invitation: 'The invitation code is not valid.',
  membership_required: 'An active team membership is required.',
  origin_not_allowed: 'This origin is not allowed.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  revision_conflict: 'The record revision has changed.',
  precondition_required: 'An If-Match revision is required.',
  payload_too_large: 'The request body exceeds 256 KiB.',
  unsupported_media_type: 'The request body must be application/json.',
  quota_exceeded: 'The record quota for this author is exhausted.',
  rate_limited: 'Too many requests; retry later.',
  not_configured: 'The records store is not configured.',
  internal_error: 'Internal error.',
};

class ApiError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
const fail = (status, code, headers) => new ApiError(status, code, headers);

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function settings(env) {
  const origins = new Set();
  for (const item of String(env.ALLOWED_ORIGINS || '').split(',')) {
    const origin = item.trim();
    try {
      if (origin && new URL(origin).origin === origin) origins.add(origin);
    } catch {}
  }
  return {
    origins,
    pageSize: Math.min(positiveInt(env.PAGE_SIZE, 50), 100),
    registersPerIpHour: positiveInt(env.REGISTERS_PER_IP_HOUR, 10),
    registersPerHour: positiveInt(env.REGISTERS_PER_HOUR, 300),
    loginsPerIpHour: positiveInt(env.LOGINS_PER_IP_HOUR, 60),
    loginsPerHour: positiveInt(env.LOGINS_PER_HOUR, 1000),
    loginFailuresPerUsernameHour: positiveInt(env.LOGIN_FAILURES_PER_USERNAME_HOUR, 10),
    writesPerAuthorHour: positiveInt(env.WRITES_PER_AUTHOR_HOUR, 240),
    maxRecordsPerAuthor: positiveInt(env.MAX_RECORDS_PER_AUTHOR, 5000),
  };
}

function json(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function errorResponse(error) {
  return json(error.status, { error: { code: error.code, message: MESSAGES[error.code] } }, error.headers);
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fields(body, allowed, required) {
  if (Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(body, key))) {
    throw fail(400, 'invalid_request');
  }
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const type = (request.headers.get('Content-Type') || '').trim();
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(type)) throw fail(415, 'unsupported_media_type');
  const declared = request.headers.get('Content-Length');
  if (declared !== null && !(Number(declared) <= maxBytes)) throw fail(413, 'payload_too_large');
  if (!request.body) throw fail(400, 'invalid_json');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw fail(413, 'payload_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw fail(400, 'invalid_json');
  }
  if (!isObject(body)) throw fail(400, 'invalid_json');
  return body;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const now = () => new Date().toISOString();

function database(env) {
  if (!env.DB) throw fail(503, 'not_configured');
  return env.DB;
}

const windowStart = seconds => seconds - (seconds % HOUR);
const retryAfter = seconds => ({ 'Retry-After': String(windowStart(seconds) + HOUR - seconds) });

// Fixed-window counter; the upsert is a single atomic statement so concurrent requests cannot both pass.
// Returns the window it counted in so a caller can release exactly that slot.
async function rateLimit(db, bucket, limit) {
  const seconds = Math.floor(Date.now() / 1000);
  const start = windowStart(seconds);
  const row = await db
    .prepare('INSERT INTO rate_counters (bucket, window_start, count) VALUES (?1, ?2, 1) ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(bucket, start)
    .first();
  if (row.count === 1) await db.prepare('DELETE FROM rate_counters WHERE window_start < ?1').bind(start).run();
  if (row.count > limit) throw fail(429, 'rate_limited', retryAfter(seconds));
  return start;
}

// Gives back one slot taken by rateLimit in the same window; never touches other windows or goes below zero.
async function releaseSlot(db, bucket, start) {
  await db.prepare('UPDATE rate_counters SET count = count - 1 WHERE bucket = ?1 AND window_start = ?2 AND count > 0').bind(bucket, start).run();
}

// Rate buckets carry truncated hashes, never a raw IP address or username.
async function bucketKey(prefix, value) {
  return prefix + (await sha256Hex('falsify-rate:' + prefix + value)).slice(0, 24);
}

const clientIp = request => request.headers.get('CF-Connecting-IP') || 'unknown';

// Every session must be valid AND belong to an active team member; only logout skips the membership check
// so a revoked or never-admitted author can still end their own session.
async function authenticate(request, db, { member = true } = {}) {
  const header = request.headers.get('Authorization');
  if (header === null) throw fail(401, 'unauthorized');
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match || !TOKEN.test(match[1])) throw fail(401, 'unauthorized');
  const keyHash = await sha256Hex(match[1]);
  const row = await db
    .prepare(
      `SELECT a.id, a.username, a.display_name, m.status AS member_status FROM sessions s JOIN authors a ON a.id = s.author_id
       LEFT JOIN team_members m ON m.author_id = a.id WHERE s.token_hash = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2`
    )
    .bind(keyHash, Date.now())
    .first();
  if (!row) throw fail(401, 'unauthorized');
  if (member && row.member_status !== 'active') throw fail(403, 'membership_required');
  return { id: row.id, username: row.username, displayName: row.display_name, keyHash };
}

function displayName(value) {
  if (typeof value !== 'string') throw fail(400, 'invalid_request');
  const name = value.normalize('NFC').trim();
  if (!name || [...name].length > 60 || UNSAFE_NAME.test(name)) throw fail(400, 'invalid_request');
  return name;
}

// Usernames are ASCII and case-insensitive: the lowercase form is the stored unique key.
const validUsername = value => typeof value === 'string' && USERNAME.test(value);

// No composition rules; length counts code points after NFC so equivalent input derives the same key.
function passwordText(value) {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFC');
  const length = [...text].length;
  return length >= 12 && length <= 128 ? text : null;
}

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, SCRYPT, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
  const key = await derive(password, salt);
  return SCRYPT_PREFIX + salt.toString('base64url') + '$' + key.toString('base64url');
}

// Always performs exactly one derivation, so unknown users and malformed hashes cost the same as a real check.
async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' && stored.startsWith(SCRYPT_PREFIX) ? stored.slice(SCRYPT_PREFIX.length).split('$') : [];
  const salt = parts.length === 2 ? Buffer.from(parts[0], 'base64url') : null;
  const expected = parts.length === 2 ? Buffer.from(parts[1], 'base64url') : null;
  const usable = salt !== null && salt.length >= SALT_BYTES && expected.length === KEY_BYTES;
  const key = await derive(password, usable ? salt : DUMMY_SALT);
  return usable && timingSafeEqual(key, expected);
}

function authorView(author) {
  return { id: author.id, username: author.username, displayName: author.displayName };
}

async function createSession(db, author) {
  const token = 'fss_' + base64url(crypto.getRandomValues(new Uint8Array(32)));
  const nowMs = Date.now();
  const expiresAt = nowMs + SESSION_TTL_MS;
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE author_id = ?1 AND (expires_at <= ?2 OR revoked_at IS NOT NULL)').bind(author.id, nowMs),
    db.prepare('INSERT INTO sessions (token_hash, author_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)').bind(await sha256Hex(token), author.id, new Date(nowMs).toISOString(), expiresAt),
  ]);
  return { token, author: authorView(author), expiresAt: new Date(expiresAt).toISOString() };
}

// The shared core either returns the normalized payload or throws. A {ok, payload} result is accepted
// for compatibility; any other non-object result is a rejection so nothing unvalidated is stored.
async function normalize(kind, payload) {
  let result;
  try {
    result = await validatePayload(kind, payload, { harness: H });
  } catch (error) {
    throw error?.code === 'payload_too_large' ? fail(413, 'payload_too_large') : fail(422, 'invalid_payload');
  }
  if (isObject(result) && typeof result.ok === 'boolean') {
    if (!result.ok || !isObject(result.payload)) throw fail(422, 'invalid_payload');
    result = result.payload;
  }
  if (!isObject(result)) throw fail(422, 'invalid_payload');
  const stored = JSON.parse(JSON.stringify(result));
  let projected;
  try {
    projected = await publicPayload(kind, stored);
  } catch {
    throw fail(422, 'invalid_payload');
  }
  if (!isObject(projected)) throw fail(422, 'invalid_payload');
  return { stored, projected: JSON.parse(JSON.stringify(projected)), hash: await payloadHash(kind, stored) };
}

function serialize(row, payloadText) {
  return {
    id: row.id,
    owner: { id: row.owner_id, username: row.username, displayName: row.display_name },
    kind: row.kind,
    visibility: row.visibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    payload: JSON.parse(payloadText),
    attestation: 'client-reported',
  };
}

const RECORD_COLUMNS = 'r.seq, r.id, r.owner_id, a.username, a.display_name, r.kind, r.visibility, r.created_at, r.updated_at, r.revision';
// A shared review is public only while the run it references is itself shared.
const PUBLIC_REVIEW_GATE = "(r.kind <> 'review' OR EXISTS (SELECT 1 FROM records x WHERE x.id = r.ref_id AND x.kind = 'run' AND x.visibility = 'shared'))";

async function ownedRecord(db, id, ownerId) {
  return db
    .prepare(`SELECT ${RECORD_COLUMNS}, r.payload FROM records r JOIN authors a ON a.id = r.owner_id WHERE r.id = ?1 AND r.owner_id = ?2`)
    .bind(id, ownerId)
    .first();
}

function health(ctx) {
  database(ctx.env);
  return json(200, { schema: SCHEMA, ready: true, auth: 'password', registration: 'invite-only', sharedAccess: 'members' });
}

const INVITE_USABLE = 'claimed_by IS NULL AND revoked_at IS NULL AND expires_at > ?2';

// Registration needs an unused, unexpired, unrevoked invitation. The cheap invitation check runs after the
// rate limits and before the scrypt derivation; the claim itself is one D1 batch (a single transaction):
// the author insert is conditional on the invitation still being usable, and the claim and membership are
// conditional on that author row, so a lost race or a taken username leaves no author and no used code.
async function register(ctx) {
  const db = database(ctx.env);
  const body = await readJson(ctx.request, MAX_AUTH_BODY_BYTES);
  fields(body, ['username', 'password', 'displayName', 'inviteCode'], ['username', 'password', 'inviteCode']);
  if (!validUsername(body.username)) throw fail(400, 'invalid_username');
  const password = passwordText(body.password);
  if (password === null) throw fail(400, 'invalid_password');
  const name = body.displayName === undefined ? body.username : displayName(body.displayName);
  await rateLimit(db, await bucketKey('register:ip:', clientIp(ctx.request)), ctx.settings.registersPerIpHour);
  await rateLimit(db, 'register:all', ctx.settings.registersPerHour);
  if (typeof body.inviteCode !== 'string' || !INVITE.test(body.inviteCode)) throw fail(403, 'invalid_invitation');
  const codeHash = await sha256Hex(body.inviteCode);
  const usable = await db.prepare(`SELECT 1 AS ok FROM invitations WHERE code_hash = ?1 AND ${INVITE_USABLE}`).bind(codeHash, Date.now()).first();
  if (!usable) throw fail(403, 'invalid_invitation');
  const author = { id: crypto.randomUUID(), username: body.username.toLowerCase(), displayName: name };
  const passwordHash = await hashPassword(password);
  const at = now();
  // Use one eligibility instant for the whole transaction. Separate JS timestamps could let
  // the author insert pass immediately before expiry but make the claim fail after expiry.
  const claimNow = Date.now();
  let results;
  try {
    results = await db.batch([
      db
        .prepare(
          `INSERT INTO authors (id, username, display_name, password_hash, created_at)
           SELECT ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM invitations WHERE code_hash = ?1 AND ${INVITE_USABLE})`
        )
        .bind(codeHash, claimNow, author.id, author.username, author.displayName, passwordHash, at),
      db
        .prepare(`UPDATE invitations SET claimed_by = ?3, claimed_at = ?4 WHERE code_hash = ?1 AND ${INVITE_USABLE} AND EXISTS (SELECT 1 FROM authors WHERE id = ?3)`)
        .bind(codeHash, claimNow, author.id, at),
      db
        .prepare("INSERT INTO team_members (author_id, status, created_at) SELECT ?1, 'active', ?2 WHERE EXISTS (SELECT 1 FROM invitations WHERE claimed_by = ?1)")
        .bind(author.id, at),
    ]);
  } catch (error) {
    // The username unique index aborts the whole batch, so the invitation stays unused.
    const taken = await db.prepare('SELECT 1 AS ok FROM authors WHERE username = ?1').bind(author.username).first();
    if (taken) throw fail(409, 'username_taken');
    throw error;
  }
  const [inserted, claimed, admitted] = results.map(r => r.meta.changes);
  if (inserted !== 1) throw fail(403, 'invalid_invitation');
  if (claimed !== 1 || admitted !== 1) throw new Error('invitation claim invariant');
  return json(201, await createSession(db, author));
}

// Every credential failure is the same 401 after one derivation. Each attempt atomically reserves a
// per-username failure slot (and a global attempt slot) before deriving, so concurrent guesses cannot
// overrun the cap; only a successful login releases its username slot.
async function login(ctx) {
  const db = database(ctx.env);
  const body = await readJson(ctx.request, MAX_AUTH_BODY_BYTES);
  fields(body, ['username', 'password'], ['username', 'password']);
  if (typeof body.username !== 'string' || typeof body.password !== 'string') throw fail(400, 'invalid_request');
  const username = body.username.toLowerCase();
  const failures = await bucketKey('login:user:', username);
  await rateLimit(db, await bucketKey('login:ip:', clientIp(ctx.request)), ctx.settings.loginsPerIpHour);
  await rateLimit(db, 'login:all', ctx.settings.loginsPerHour);
  const reserved = await rateLimit(db, failures, ctx.settings.loginFailuresPerUsernameHour);
  const password = passwordText(body.password);
  const row = validUsername(body.username) && password !== null
    ? await db
        .prepare('SELECT a.id, a.username, a.display_name, a.password_hash, m.status AS member_status FROM authors a LEFT JOIN team_members m ON m.author_id = a.id WHERE a.username = ?1')
        .bind(username)
        .first()
    : null;
  const ok = await verifyPassword(password ?? body.password, row?.password_hash ?? null);
  if (!ok || !row) throw fail(401, 'invalid_credentials');
  // A correct password of a non-member creates no session and keeps its failure slot.
  if (row.member_status !== 'active') throw fail(403, 'membership_required');
  await releaseSlot(db, failures, reserved);
  return json(200, await createSession(db, { id: row.id, username: row.username, displayName: row.display_name }));
}

async function me(ctx) {
  const author = await authenticate(ctx.request, database(ctx.env));
  return json(200, { author: authorView(author) });
}

async function logout(ctx) {
  const db = database(ctx.env);
  const author = await authenticate(ctx.request, db, { member: false });
  await db.prepare('UPDATE sessions SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL').bind(now(), author.keyHash).run();
  return json(200, { revoked: true });
}

function singleParam(params, name) {
  const values = params.getAll(name);
  if (values.length > 1) throw fail(400, 'invalid_request');
  return values.length ? values[0] : null;
}

// Listings always return the public projection; the owner reads full private fields one record at a time.
// Shared means shared with the team: every listing requires an active member session.
async function listRecords(ctx) {
  const db = database(ctx.env);
  const author = await authenticate(ctx.request, db);
  const params = ctx.url.searchParams;
  const scope = singleParam(params, 'scope') ?? 'shared';
  const kind = singleParam(params, 'kind');
  const cursor = singleParam(params, 'cursor');
  const limitParam = singleParam(params, 'limit');
  if (!['mine', 'shared'].includes(scope) || (kind !== null && !KINDS.includes(kind))) throw fail(400, 'invalid_request');
  if (cursor !== null && !CURSOR.test(cursor)) throw fail(400, 'invalid_cursor');
  let limit = ctx.settings.pageSize;
  if (limitParam !== null) {
    if (!/^[1-9][0-9]{0,2}$/.test(limitParam) || Number(limitParam) > 100) throw fail(400, 'invalid_request');
    limit = Number(limitParam);
  }
  const where = [];
  const binds = [];
  if (scope === 'mine') {
    binds.push(author.id);
    where.push(`r.owner_id = ?${binds.length}`);
  } else {
    where.push("r.visibility = 'shared'", PUBLIC_REVIEW_GATE);
  }
  if (kind !== null) {
    binds.push(kind);
    where.push(`r.kind = ?${binds.length}`);
  }
  if (cursor !== null) {
    binds.push(Number(cursor));
    where.push(`r.seq < ?${binds.length}`);
  }
  binds.push(limit + 1);
  const { results } = await db
    .prepare(`SELECT ${RECORD_COLUMNS}, r.public_payload FROM records r JOIN authors a ON a.id = r.owner_id WHERE ${where.join(' AND ')} ORDER BY r.seq DESC LIMIT ?${binds.length}`)
    .bind(...binds)
    .all();
  const page = results.slice(0, limit);
  return json(200, {
    records: page.map(row => serialize(row, row.public_payload)),
    nextCursor: results.length > limit ? String(page[page.length - 1].seq) : null,
  });
}

async function createRecord(ctx) {
  const db = database(ctx.env);
  const author = await authenticate(ctx.request, db);
  const body = await readJson(ctx.request);
  fields(body, ['kind', 'visibility', 'payload'], ['kind', 'payload']);
  const visibility = body.visibility ?? 'private';
  if (!KINDS.includes(body.kind) || !VISIBILITIES.includes(visibility) || !isObject(body.payload)) throw fail(400, 'invalid_request');
  await rateLimit(db, 'writes:' + author.id, ctx.settings.writesPerAuthorHour);
  const { stored, projected, hash: payloadDigest } = await normalize(body.kind, body.payload);
  let refId = null;
  let supersedesId = null;
  if (body.kind === 'review') {
    refId = stored.runId;
    supersedesId = stored.supersedes ?? null;
    if (typeof refId !== 'string' || !UUID.test(refId) || (supersedesId !== null && (typeof supersedesId !== 'string' || !UUID.test(supersedesId)))) {
      throw fail(422, 'invalid_reference');
    }
  }
  const id = crypto.randomUUID();
  const at = now();
  // One statement enforces the quota, reference visibility and per-owner dedup atomically.
  const inserted = await db
    .prepare(
      `INSERT INTO records (id, owner_id, kind, visibility, payload, public_payload, payload_hash, ref_id, supersedes_id, created_at, updated_at, revision)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, 1
       WHERE (SELECT COUNT(*) FROM records WHERE owner_id = ?2) < ?11
         AND (?8 IS NULL OR EXISTS (SELECT 1 FROM records x WHERE x.id = ?8 AND x.kind = 'run' AND (x.visibility = 'shared' OR (?4 = 'private' AND x.owner_id = ?2))))
         AND (?9 IS NULL OR EXISTS (SELECT 1 FROM records s WHERE s.id = ?9 AND s.kind = 'review' AND s.owner_id = ?2 AND s.ref_id = ?8))
       ON CONFLICT (owner_id, kind, payload_hash) DO NOTHING`
    )
    .bind(id, author.id, body.kind, visibility, JSON.stringify(stored), JSON.stringify(projected), payloadDigest, refId, supersedesId, at, ctx.settings.maxRecordsPerAuthor)
    .run();
  if (inserted.meta.changes === 1) {
    const row = await ownedRecord(db, id, author.id);
    return json(201, { record: serialize(row, row.payload) });
  }
  const existing = await db
    .prepare(`SELECT ${RECORD_COLUMNS}, r.payload FROM records r JOIN authors a ON a.id = r.owner_id WHERE r.owner_id = ?1 AND r.kind = ?2 AND r.payload_hash = ?3`)
    .bind(author.id, body.kind, payloadDigest)
    .first();
  if (existing) return json(200, { record: serialize(existing, existing.payload), deduplicated: true });
  const { count } = await db.prepare('SELECT COUNT(*) AS count FROM records WHERE owner_id = ?1').bind(author.id).first();
  if (count >= ctx.settings.maxRecordsPerAuthor) throw fail(403, 'quota_exceeded');
  throw fail(422, 'invalid_reference');
}

async function getRecord(ctx) {
  const db = database(ctx.env);
  const author = await authenticate(ctx.request, db);
  const row = await db
    .prepare(`SELECT ${RECORD_COLUMNS}, r.payload, r.public_payload, ${PUBLIC_REVIEW_GATE} AS review_visible FROM records r JOIN authors a ON a.id = r.owner_id WHERE r.id = ?1`)
    .bind(ctx.id)
    .first();
  if (row && row.owner_id === author.id) return json(200, { record: serialize(row, row.payload) });
  // Private records of other authors are indistinguishable from missing ones.
  if (!row || row.visibility !== 'shared' || !row.review_visible) throw fail(404, 'not_found');
  return json(200, { record: serialize(row, row.public_payload) });
}

async function updateRecord(ctx) {
  const db = database(ctx.env);
  const author = await authenticate(ctx.request, db);
  const body = await readJson(ctx.request);
  fields(body, ['expectedRevision', 'visibility'], ['expectedRevision', 'visibility']);
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 || !VISIBILITIES.includes(body.visibility)) throw fail(400, 'invalid_request');
  await rateLimit(db, 'writes:' + author.id, ctx.settings.writesPerAuthorHour);
  // Compare-and-set on revision; payload is immutable and only visibility may change.
  const updated = await db
    .prepare(
      `UPDATE records SET visibility = ?1, revision = revision + 1, updated_at = ?2
       WHERE id = ?3 AND owner_id = ?4 AND revision = ?5
         AND (?1 = 'private' OR kind <> 'review' OR EXISTS (SELECT 1 FROM records x WHERE x.id = records.ref_id AND x.kind = 'run' AND x.visibility = 'shared'))`
    )
    .bind(body.visibility, now(), ctx.id, author.id, body.expectedRevision)
    .run();
  const row = await ownedRecord(db, ctx.id, author.id);
  if (!row) throw fail(404, 'not_found');
  if (updated.meta.changes === 1) return json(200, { record: serialize(row, row.payload) });
  if (row.revision !== body.expectedRevision) throw fail(409, 'revision_conflict');
  throw fail(422, 'invalid_reference');
}

async function deleteRecord(ctx) {
  const db = database(ctx.env);
  const author = await authenticate(ctx.request, db);
  const header = ctx.request.headers.get('If-Match');
  if (header === null) throw fail(428, 'precondition_required');
  const match = /^(?:W\/)?"?([1-9][0-9]{0,14})"?$/.exec(header.trim());
  if (!match) throw fail(400, 'invalid_request');
  const revision = Number(match[1]);
  await rateLimit(db, 'writes:' + author.id, ctx.settings.writesPerAuthorHour);
  const deleted = await db.prepare('DELETE FROM records WHERE id = ?1 AND owner_id = ?2 AND revision = ?3').bind(ctx.id, author.id, revision).run();
  if (deleted.meta.changes === 1) return json(200, { deleted: true, id: ctx.id });
  const row = await db.prepare('SELECT revision FROM records WHERE id = ?1 AND owner_id = ?2').bind(ctx.id, author.id).first();
  if (!row) throw fail(404, 'not_found');
  throw fail(409, 'revision_conflict');
}

const ROUTES = {
  '/v1/health': { GET: health },
  '/v1/auth/register': { POST: register },
  '/v1/auth/login': { POST: login },
  '/v1/me': { GET: me },
  '/v1/logout': { POST: logout },
  '/v1/records': { GET: listRecords, POST: createRecord },
  '/v1/records/:id': { GET: getRecord, PATCH: updateRecord, DELETE: deleteRecord },
};

function route(pathname) {
  if (Object.hasOwn(ROUTES, pathname) && !pathname.includes(':')) return { template: pathname, id: null };
  const match = /^\/v1\/records\/([^/]+)$/.exec(pathname);
  if (match) return { template: '/v1/records/:id', id: match[1] };
  return null;
}

function withCors(response, origin, allowed) {
  const headers = new Headers(response.headers);
  headers.append('Vary', 'Origin');
  if (origin !== null && allowed) headers.set('Access-Control-Allow-Origin', origin);
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const started = Date.now();
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const config = settings(env);
    const allowed = origin !== null && config.origins.has(origin);
    const matched = route(url.pathname);
    let response;
    try {
      if (origin !== null && !allowed) throw fail(403, 'origin_not_allowed');
      if (!matched) throw fail(404, 'not_found');
      const methods = ROUTES[matched.template];
      if (request.method === 'OPTIONS') {
        response = new Response(null, {
          status: 204,
          headers: { 'Access-Control-Allow-Methods': ALLOW_METHODS, 'Access-Control-Allow-Headers': ALLOW_HEADERS, 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' },
        });
      } else if (!Object.hasOwn(methods, request.method)) {
        throw fail(405, 'method_not_allowed', { Allow: Object.keys(methods).join(', ') });
      } else {
        if (matched.id !== null && !UUID.test(matched.id)) throw fail(404, 'not_found');
        response = await methods[request.method]({ request, env, url, id: matched.id, settings: config });
      }
    } catch (error) {
      if (!(error instanceof ApiError)) {
        // Only the error class name is logged: messages can carry SQL or payload fragments.
        console.error(JSON.stringify({ event: 'unhandled_error', route: matched?.template ?? 'unmatched', name: error?.name ?? 'unknown' }));
        error = fail(500, 'internal_error');
      }
      response = errorResponse(error);
    }
    // Logs carry the route template, method, status and timing only: no URL, ids, query, body, token or IP.
    console.log(JSON.stringify({ event: 'request', method: request.method, route: matched?.template ?? 'unmatched', status: response.status, ms: Date.now() - started }));
    return withCors(response, origin, allowed);
  },
};
