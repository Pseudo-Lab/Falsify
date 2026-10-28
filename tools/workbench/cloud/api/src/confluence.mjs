// Stateless Confluence OAuth and archive relay. No D1, KV, R2, or in-memory record store.
// Sessions and OAuth state are AES-GCM envelopes. Upstream calls stay on fixed Atlassian hosts.
import H from '../../../app/dist/harness-core.js';
import Red from '../../../app/dist/document-red-core.js';
import Blue from '../../../app/dist/document-blue-core.js';
import Review from '../../../app/dist/review-workbench.js';
import Attempt from '../../../app/dist/attempt-ledger.js';
import * as reviewBundleModule from '../../../app/dist/review-bundle.mjs';

export const SITE_URL = 'https://falsify.atlassian.net';
export const SPACE_KEY = 'Falsify';
export const SPACE_ID = '65737';
export const MAX_ARCHIVE_BYTES = 6 * 1024 * 1024;
export const SESSION_HEADER = 'X-Falsify-Confluence-Session';
export const READY_LABEL = 'falsify-archive-ready';
export const PROPERTY_KEY = 'falsify-archive';
const STATE_PURPOSE = 'falsify.confluence.oauth-state.v1';
const SESSION_PURPOSE = 'falsify.confluence.session.v1';
const CURSOR_PURPOSE = 'falsify.confluence.cursor.v1';
const STATE_MS = 10 * 60 * 1000;
const ENVELOPE_MS = 12 * 60 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;
const MAX_ROTATIONS = 16;
const MAX_SEALED = 8192;
const CURSOR = /^[A-Za-z0-9_=-]{1,256}$/;
const CLIENT_CURSOR = /^[A-Za-z0-9_-]{1,2048}$/;
const MEDIA_HOST = 'api.media.atlassian.com';
const MEDIA_BINARY = /^\/file\/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\/binary$/;
const MAX_DOWNLOAD_REDIRECTS = 3;
const MAX_ANCESTORS = 32;
const PAGE_ID = /^[0-9]{1,20}$/;
const ATTACHMENT_ID = /^(?:att)?[0-9]{1,20}$/;
const HEX = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
// Scopes required by the operations this gateway calls. v2 entries come from
// x-atlassian-oauth2-scopes in openapi-v2.v3.json. v1 entries use the classic
// scope marked RECOMMENDED on that operation page.
const SCOPES = [
  'offline_access',
  'read:space:confluence',
  'read:page:confluence',
  'read:content.metadata:confluence',
  'write:page:confluence',
  'read:attachment:confluence',
  'write:confluence-file',
  'readonly:content.attachment:confluence',
  'write:confluence-content',
];

const MESSAGES = {
  not_configured: 'Confluence is not configured.',
  invalid_request: 'The request is not valid for this endpoint.',
  unsupported_media_type: 'The request body must be application/json.',
  team_share_required: 'Publishing requires teamShare true. There is no private archive mode.',
  origin_not_allowed: 'This origin is not allowed.',
  unauthorized: 'A valid Confluence session is required.',
  session_expired: 'The Confluence session has expired. Connect again.',
  state_invalid: 'The connection state is not valid. Connect again.',
  state_expired: 'The connection state has expired. Connect again.',
  site_not_allowed: 'The Atlassian grant is not for the Falsify site.',
  space_not_allowed: 'The archive space is not the Falsify space.',
  parent_not_allowed: 'The archive parent page is missing, restricted, or outside the Falsify space.',
  payload_too_large: 'The archive exceeds 6 MiB.',
  invalid_cursor: 'The pagination cursor is not valid.',
  rate_limited: 'Confluence rate limited the request. Retry later.',
  write_partial: 'The archive page was not finished. Read it back before trying again. Do not retry blindly.',
  write_unknown: 'The archive write outcome is unknown. Read the archive list before trying again. Do not retry blindly.',
  archive_conflict: 'An existing page blocks this archive. It was not overwritten.',
  redirect_refused: 'An upstream redirect was refused.',
  upstream_unavailable: 'Confluence could not be reached.',
  permission_denied: 'Your Atlassian account does not have the required Confluence permission.',
  upstream_invalid: 'Confluence returned a response this gateway will not follow.',
  archive_validator_unavailable: 'Archive validation is not available.',
  invalid_archive: 'The archive failed validation.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  internal_error: 'Internal error.',
};

export class GatewayError extends Error {
  constructor(status, code, headers = {}, extra = null) {
    super(code);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.extra = extra;
  }
}
const fail = (status, code, headers, extra) => { throw new GatewayError(status, code, headers, extra); };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

let injectedReviewBundle = null;
export function setReviewBundleForTests(api) { injectedReviewBundle = api; }

const validators = () => ({ harness: H, red: Red, blue: Blue, review: Review, attempt: Attempt });

function reviewBundle() {
  return injectedReviewBundle || reviewBundleModule;
}

function bytesToBase64url(bytes) {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64ToBytes(text) {
  if (typeof text !== 'string' || !text || text.length > 8192) return null;
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pad)) return null;
  const raw = atob(pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function aesKey(env) {
  const raw = base64ToBytes(env.CONFLUENCE_SESSION_KEY || '');
  if (!raw || raw.length !== 32) return null;
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function seal(key, purpose, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) },
    key,
    encoder.encode(JSON.stringify(payload)),
  ));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToBase64url(out);
}

async function open(key, purpose, token) {
  if (typeof token !== 'string' || token.length < 24 || token.length > MAX_SEALED) return null;
  const bytes = base64ToBytes(token);
  if (!bytes || bytes.length < 13 + 16) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(purpose) },
      key,
      bytes.slice(12),
    );
    const parsed = JSON.parse(decoder.decode(new Uint8Array(plain)));
    if (!parsed || typeof parsed !== 'object' || parsed.purpose !== purpose) return null;
    return parsed;
  } catch {
    return null;
  }
}

function callbackUrl(env) {
  try {
    const url = new URL(String(env.ATLASSIAN_CALLBACK_URL || ''));
    if (url.pathname !== '/v1/confluence/auth/callback' || url.username || url.password || url.search || url.hash) return null;
    const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (url.protocol !== 'https:' && !local) return null;
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

function clientId(env) {
  const id = String(env.ATLASSIAN_CLIENT_ID || '');
  return /^[A-Za-z0-9._~-]{8,128}$/.test(id) ? id : null;
}
function clientSecret(env) {
  const secret = String(env.ATLASSIAN_CLIENT_SECRET || '');
  return secret.length >= 8 && secret.length <= 256 && !/[\u0000-\u001f]/.test(secret) ? secret : null;
}
function parentId(env) {
  const id = String(env.CONFLUENCE_PARENT_PAGE_ID || '');
  return PAGE_ID.test(id) ? id : null;
}

export function confluenceConfig(env) {
  const site = env.CONFLUENCE_SITE_URL || SITE_URL;
  const spaceKey = env.CONFLUENCE_SPACE_KEY || SPACE_KEY;
  const spaceId = String(env.CONFLUENCE_SPACE_ID || SPACE_ID);
  const fixed = site === SITE_URL && spaceKey === SPACE_KEY && spaceId === SPACE_ID;
  const ready = fixed && !!clientId(env) && !!clientSecret(env) && !!parentId(env) && !!callbackUrl(env);
  return {
    fixed,
    configured: ready,
    siteUrl: SITE_URL,
    spaceKey: SPACE_KEY,
    spaceId: SPACE_ID,
    parent: parentId(env),
    callback: callbackUrl(env),
    client: clientId(env),
  };
}

function origins(settings) {
  return settings?.origins instanceof Set ? settings.origins : new Set();
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function errorResponse(error) {
  const body = { error: { code: error.code, message: MESSAGES[error.code] || MESSAGES.internal_error } };
  if (error.extra?.pageId && PAGE_ID.test(error.extra.pageId)) body.pageId = error.extra.pageId;
  if (error.extra?.readBack) body.readBack = true;
  return json(error.status, body, error.headers || {});
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function html(message, origin) {
  const reconnect = 'Reconnect from the Workbench. This window can close.';
  const script = message
    ? `(function(){var message=${scriptJson(message)};var origin=${scriptJson(origin)};var text=${scriptJson(reconnect)};if(window.opener&&!window.opener.closed){window.opener.postMessage(message,origin);text='Connected. You can close this window.';window.close();}document.getElementById('m').textContent=text;})();`
    : `document.getElementById('m').textContent=${scriptJson(reconnect)};`;
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>Falsify</title></head><body><p id="m"></p><script>${script}</script></body></html>`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
  });
}

async function readBounded(response, max) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function readRequestJson(request, max) {
  const type = (request.headers.get('Content-Type') || '').trim();
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(type)) fail(415, 'unsupported_media_type');
  const declared = request.headers.get('Content-Length');
  if (declared !== null && !(Number(declared) <= max)) fail(413, 'payload_too_large');
  if (!request.body) fail(400, 'invalid_request');
  const bytes = await readBounded(request, max);
  if (!bytes) fail(413, 'payload_too_large');
  let body;
  try { body = JSON.parse(decoder.decode(bytes)); } catch { fail(400, 'invalid_request'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request');
  return body;
}

function allowHost(url) {
  return url.protocol === 'https:' && (url.hostname === 'api.atlassian.com' || url.hostname === 'auth.atlassian.com');
}

async function callUpstream(fetchImpl, url, init, writeStarted = false) {
  const method = String(init?.method || 'GET').toUpperCase();
  // A mutating call can land before the error is observed. Rate limits are refusals and stay 429
  // until an earlier archive write has already started.
  const mutating = method === 'POST' || method === 'PUT';
  const unknown = () => fail(409, 'write_unknown', {}, { readBack: true });
  let response;
  try {
    const parsed = new URL(url);
    if (!allowHost(parsed)) fail(502, 'redirect_refused');
    response = await fetchImpl(parsed.toString(), { ...init, redirect: 'manual' });
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (writeStarted || mutating) unknown();
    fail(502, 'upstream_unavailable');
  }
  if (response.status >= 300 && response.status < 400) {
    if (writeStarted || mutating) unknown();
    fail(502, 'redirect_refused');
  }
  if (response.status === 429) {
    const retry = response.headers.get('Retry-After');
    const headers = retry && /^\d{1,6}$/.test(retry) ? { 'Retry-After': retry } : {};
    if (writeStarted) fail(409, 'write_partial', headers, { readBack: true });
    fail(429, 'rate_limited', headers);
  }
  if (response.status >= 500) {
    if (writeStarted || mutating) unknown();
    fail(502, 'upstream_unavailable');
  }
  return response;
}

function promote(error, pageId) {
  if (!pageId || !(error instanceof GatewayError)) throw error;
  const unknown = ['upstream_unavailable', 'redirect_refused', 'write_unknown', 'upstream_invalid'].includes(error.code) || error.status >= 500;
  error.status = 409;
  error.code = unknown ? 'write_unknown' : 'write_partial';
  error.extra = { ...(error.extra || {}), pageId, readBack: true };
  throw error;
}

async function readUpstreamJson(response, writeStarted = false) {
  if (response.status === 401 || response.status === 403) fail(403, 'permission_denied');
  if (response.status < 200 || response.status >= 300) fail(writeStarted ? 409 : 502, writeStarted ? 'write_unknown' : 'upstream_unavailable');
  const bytes = await readBounded(response, 1024 * 1024);
  if (!bytes) fail(502, 'upstream_invalid');
  if (!bytes.length) return null;
  try { return JSON.parse(decoder.decode(bytes)); } catch { fail(502, 'upstream_invalid'); }
}

function cloudBase(cloudId) {
  if (typeof cloudId !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(cloudId)) fail(403, 'site_not_allowed');
  return `https://api.atlassian.com/ex/confluence/${cloudId}`;
}

async function tokenRequest(fetchImpl, env, fields) {
  const body = new URLSearchParams({ client_id: clientId(env), client_secret: clientSecret(env), ...fields });
  const response = await callUpstream(fetchImpl, 'https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const parsed = await readUpstreamJson(response);
  if (!parsed || typeof parsed.access_token !== 'string' || typeof parsed.expires_in !== 'number' || parsed.expires_in < 30 || parsed.expires_in > 86400) {
    fail(502, 'upstream_invalid');
  }
  return parsed;
}

async function accessibleCloud(fetchImpl, accessToken) {
  const response = await callUpstream(fetchImpl, 'https://api.atlassian.com/oauth/token/accessible-resources', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const list = await readUpstreamJson(response);
  if (!Array.isArray(list)) fail(502, 'upstream_invalid');
  const matches = list.filter(item => {
    try { return item && new URL(item.url).origin === SITE_URL; } catch { return false; }
  });
  if (matches.length !== 1 || typeof matches[0].id !== 'string') fail(403, 'site_not_allowed');
  return matches[0].id;
}

async function confine(fetchImpl, accessToken, cloudId, parent) {
  const discovered = await accessibleCloud(fetchImpl, accessToken);
  if (discovered !== cloudId) fail(403, 'site_not_allowed');
  const base = cloudBase(cloudId);
  const spaceResponse = await callUpstream(fetchImpl, `${base}/wiki/api/v2/spaces/${SPACE_ID}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (spaceResponse.status === 403 || spaceResponse.status === 404) fail(403, 'space_not_allowed');
  const space = await readUpstreamJson(spaceResponse);
  if (!space || String(space.id) !== SPACE_ID || space.key !== SPACE_KEY) fail(403, 'space_not_allowed');
  const pageResponse = await callUpstream(fetchImpl, `${base}/wiki/api/v2/pages/${parent}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (pageResponse.status === 403 || pageResponse.status === 404) fail(403, 'parent_not_allowed');
  const page = await readUpstreamJson(pageResponse);
  if (!page || String(page.id) !== parent || String(page.spaceId) !== SPACE_ID) fail(403, 'parent_not_allowed');
  await assertParentReadable(fetchImpl, base, accessToken, parent, cloudId);
  return page;
}

async function assertReadOpen(fetchImpl, base, token, pageId) {
  const response = await callUpstream(fetchImpl, `${base}/wiki/api/v2/pages/${pageId}/restriction-state`, {
    headers: authHeaders(token),
  });
  if (response.status !== 200) fail(403, 'parent_not_allowed');
  const body = await readUpstreamJson(response);
  if (!body || (body.state !== 'OPEN' && body.state !== 'EDIT_RESTRICTED')) fail(403, 'parent_not_allowed');
}

async function assertParentReadable(fetchImpl, base, token, parent, cloudId) {
  await assertReadOpen(fetchImpl, base, token, parent);
  const seen = new Set([parent]);
  let current = parent;
  for (let hop = 0; hop < 8; hop++) {
    const response = await callUpstream(fetchImpl, `${base}/wiki/api/v2/pages/${current}/ancestors?limit=25`, {
      headers: authHeaders(token),
    });
    if (response.status !== 200) fail(403, 'parent_not_allowed');
    const payload = await readUpstreamJson(response);
    const results = payload?.results;
    if (!Array.isArray(results) || results.length > 25) fail(403, 'parent_not_allowed');
    if (!results.length) return;
    const ids = [];
    for (const item of results) {
      if (!item || item.type !== 'page') fail(403, 'parent_not_allowed');
      const id = String(item.id);
      if (!PAGE_ID.test(id)) fail(403, 'parent_not_allowed');
      ids.push(id);
    }
    let added = false;
    for (const id of ids) {
      if (seen.has(id)) continue;
      if (seen.size >= MAX_ANCESTORS) fail(403, 'parent_not_allowed');
      seen.add(id);
      added = true;
      await assertReadOpen(fetchImpl, base, token, id);
    }
    const next = payload?._links?.next;
    if (typeof next === 'string' && next) {
      let url;
      try { url = new URL(next); } catch { fail(403, 'parent_not_allowed'); }
      const match = new RegExp(`^/ex/confluence/${cloudId}/wiki/api/v2/pages/([0-9]{1,20})/ancestors$`).exec(url.pathname);
      if (url.origin !== 'https://api.atlassian.com' || url.username || url.password || !match || !seen.has(match[1])) fail(403, 'parent_not_allowed');
      if (results.length < 25 && !added) return;
      current = match[1];
      continue;
    }
    if (!added || results.length < 25) return;
    if (ids[0] === current) return;
    current = ids[0];
  }
  fail(403, 'parent_not_allowed');
}

function downloadTarget(url, cloudId, pageId, attachmentId) {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
  if (url.origin === 'https://api.atlassian.com') {
    const expected = `/ex/confluence/${cloudId}/wiki/rest/api/content/${pageId}/child/attachment/${attachmentId}/download`;
    return url.pathname === expected && url.search === '';
  }
  // Exact host named as an internal Atlassian API redirect domain in the Forge
  // runtime egress permissions page. The binary path is the one Media Services
  // serves for that redirect. No other host, subdomain, or path is fetched.
  if (url.origin === `https://${MEDIA_HOST}`) return MEDIA_BINARY.test(url.pathname) && url.search.length <= 2048;
  return false;
}

async function downloadAttachment(fetchImpl, start, token, cloudId, pageId, attachmentId, writeStarted) {
  let current = start;
  let sendBearer = true;
  const seen = new Set();
  const refused = () => fail(writeStarted ? 409 : 502, writeStarted ? 'write_unknown' : 'redirect_refused', {}, writeStarted ? { pageId, readBack: true } : null);
  for (let hop = 0; hop <= MAX_DOWNLOAD_REDIRECTS; hop++) {
    if (seen.has(current)) refused();
    seen.add(current);
    let parsed;
    try { parsed = new URL(current); } catch { refused(); }
    if (!downloadTarget(parsed, cloudId, pageId, attachmentId)) refused();
    const headers = { Accept: 'application/json' };
    if (sendBearer) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(parsed.origin + parsed.pathname + parsed.search, { method: 'GET', headers, redirect: 'manual' });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (writeStarted) fail(409, 'write_unknown', {}, { pageId, readBack: true });
      fail(502, 'upstream_unavailable');
    }
    if (response.status >= 300 && response.status < 400) {
      if (![301, 302, 303, 307, 308].includes(response.status) || hop === MAX_DOWNLOAD_REDIRECTS) refused();
      const location = response.headers.get('Location');
      if (!location) refused();
      let next;
      try { next = new URL(location, parsed); } catch { refused(); }
      if (next.hostname !== parsed.hostname) sendBearer = false;
      current = next.origin + next.pathname + next.search;
      continue;
    }
    if (response.status === 429) {
      const retry = response.headers.get('Retry-After');
      const retryHeaders = retry && /^\d{1,6}$/.test(retry) ? { 'Retry-After': retry } : {};
      if (writeStarted) fail(409, 'write_partial', retryHeaders, { pageId, readBack: true });
      fail(429, 'rate_limited', retryHeaders);
    }
    if (response.status >= 500) {
      if (writeStarted) fail(409, 'write_unknown', {}, { pageId, readBack: true });
      fail(502, 'upstream_unavailable');
    }
    return response;
  }
  refused();
}

function needsRefresh(session, now) {
  return session.accessExp - now <= REFRESH_SKEW_MS;
}

async function refreshSession(fetchImpl, env, key, session, now) {
  if (session.envelopeExp <= now) fail(401, 'session_expired');
  if (session.rotations >= MAX_ROTATIONS) fail(401, 'session_expired');
  if (!needsRefresh(session, now)) return { session, sealed: null };
  let parsed;
  try {
    parsed = await tokenRequest(fetchImpl, env, { grant_type: 'refresh_token', refresh_token: session.refreshToken });
  } catch (error) {
    if (error instanceof GatewayError && (error.status === 429 || error.code === 'rate_limited')) throw error;
    fail(401, 'session_expired');
  }
  const next = {
    ...session,
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : session.refreshToken,
    accessExp: now + parsed.expires_in * 1000,
    rotations: session.rotations + 1,
  };
  return { session: next, sealed: await seal(key, SESSION_PURPOSE, next) };
}

async function bearerSession(ctx) {
  const header = ctx.request.headers.get('Authorization');
  if (!header) fail(401, 'unauthorized');
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match || match[1].startsWith('fss_') || match[1].startsWith('fsi_')) fail(401, 'unauthorized');
  const key = await aesKey(ctx.env);
  if (!key) fail(503, 'not_configured');
  const session = await open(key, SESSION_PURPOSE, match[1]);
  if (!session) fail(401, 'unauthorized');
  const now = ctx.now();
  if (session.envelopeExp <= now || session.rotations > MAX_ROTATIONS) fail(401, 'session_expired');
  if (typeof session.accessToken !== 'string' || typeof session.refreshToken !== 'string' || typeof session.cloudId !== 'string') fail(401, 'unauthorized');
  const refreshed = await refreshSession(ctx.fetchImpl, ctx.env, key, session, now);
  if (refreshed.sealed) ctx.refreshed = refreshed.sealed;
  return refreshed.session;
}

function withSession(response, ctx) {
  if (!ctx.refreshed) return response;
  const headers = new Headers(response.headers);
  headers.set(SESSION_HEADER, ctx.refreshed);
  headers.set('Access-Control-Expose-Headers', SESSION_HEADER);
  return new Response(response.body, { status: response.status, headers });
}

function summaryHtml(archive, archiveSha256) {
  const manual = archive.kind === 'paper-edit' ? ' Text and edits only. The source PDF binary is not stored.' : '';
  return '<p>Falsify team archive (' + escapeHtml(archive.kind) + '). Title ' + escapeHtml(archive.title) + '. Id ' + escapeHtml(archive.id)
    + '. SHA-256 ' + escapeHtml(archiveSha256) + '.' + manual + '</p><p>The lossless record is the attachment named ' + escapeHtml(archiveSha256)
    + '.json. This page is only a short summary. JSON only; no PDF is stored. This is not a model execution or a performance result.</p>';
}

function pageTitle(kind, archiveSha256) {
  return `Falsify ${kind} ${archiveSha256}`;
}

function webUrl(page) {
  const path = page?._links?.webui;
  if (typeof path !== 'string' || path.includes('://') || path.startsWith('//') || !path.startsWith('/')) return null;
  const suffix = path.startsWith('/wiki/') ? path.slice(5) : path;
  if (!suffix.startsWith('/')) return null;
  return `${SITE_URL}/wiki${suffix}`;
}

function readyLabel(page) {
  const results = page?.labels?.results;
  return Array.isArray(results) && results.some(label => label && label.name === READY_LABEL);
}
function propertyValue(page) {
  const results = page?.properties?.results;
  if (!Array.isArray(results)) return null;
  const found = results.find(item => item && item.key === PROPERTY_KEY);
  return found && found.value && typeof found.value === 'object' && !Array.isArray(found.value) ? found.value : null;
}

async function loadArchiveModule() {
  const api = reviewBundle();
  if (!api || typeof api.validateArchive !== 'function' || typeof api.archiveHash !== 'function') fail(503, 'archive_validator_unavailable');
  return api;
}

async function normalizeArchive(archive) {
  const api = await loadArchiveModule();
  let normalized;
  let archiveSha256;
  try {
    normalized = await api.validateArchive(archive, validators());
    archiveSha256 = await api.archiveHash(normalized);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    fail(422, 'invalid_archive');
  }
  if (!normalized || normalized.schema !== 'falsify.confluence-archive.v1' || !['experiment', 'harness', 'paper-edit', 'attempt', 'external-response'].includes(normalized.kind)) fail(422, 'invalid_archive');
  if (typeof normalized.id !== 'string' || !normalized.id || normalized.id.length > 200 || /[\u0000-\u001f]/.test(normalized.id)) fail(422, 'invalid_archive');
  if (typeof normalized.title !== 'string' || !normalized.title.trim() || normalized.title.length > 500 || /[\u0000-\u001f\u007f]/.test(normalized.title)) fail(422, 'invalid_archive');
  if (!normalized.data || typeof normalized.data !== 'object' || Array.isArray(normalized.data)) fail(422, 'invalid_archive');
  if (typeof archiveSha256 !== 'string' || !HEX.test(archiveSha256)) fail(422, 'invalid_archive');
  const bytes = encoder.encode(JSON.stringify(normalized));
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) fail(413, 'payload_too_large');
  return { normalized, archiveSha256, bytes };
}

async function verifyBytes(bytes, expectedHash) {
  let parsed;
  try { parsed = JSON.parse(decoder.decode(bytes)); } catch { fail(422, 'invalid_archive'); }
  const again = await normalizeArchive(parsed);
  if (again.archiveSha256 !== expectedHash) fail(422, 'invalid_archive');
  const fileHash = await sha256(bytes);
  const normHash = await sha256(again.bytes);
  if (fileHash !== normHash) fail(422, 'invalid_archive');
  return again;
}

function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extra };
}

async function getPage(fetchImpl, base, token, pageId, writeStarted = false) {
  const response = await callUpstream(fetchImpl, `${base}/wiki/api/v2/pages/${pageId}?include-labels=true&include-properties=true`, {
    headers: authHeaders(token),
  }, writeStarted);
  if (response.status === 404) return null;
  return readUpstreamJson(response, writeStarted);
}

function cursorFromNext(next, pathname) {
  if (!next) return null;
  let url;
  try { url = new URL(next, 'https://api.atlassian.com'); } catch { fail(502, 'upstream_invalid'); }
  if (url.origin !== 'https://api.atlassian.com' || url.pathname !== pathname) fail(502, 'upstream_invalid');
  const cursor = url.searchParams.get('cursor');
  if (!cursor) return null;
  if (!CURSOR.test(cursor)) fail(502, 'upstream_invalid');
  return cursor;
}

async function publish(ctx, session) {
  await requireReady(ctx);
  const config = confluenceConfig(ctx.env);
  const body = await readRequestJson(ctx.request, MAX_ARCHIVE_BYTES + 8192);
  if (Object.keys(body).some(key => key !== 'archive' && key !== 'teamShare') || !Object.hasOwn(body, 'archive') || !Object.hasOwn(body, 'teamShare')) {
    fail(400, 'invalid_request');
  }
  if (body.teamShare !== true) fail(400, 'team_share_required');
  const { normalized, archiveSha256, bytes } = await normalizeArchive(body.archive);
  const parent = config.parent;
  await confine(ctx.fetchImpl, session.accessToken, session.cloudId, parent);
  const base = cloudBase(session.cloudId);
  const title = pageTitle(normalized.kind, archiveSha256);
  const lookupUrl = `${base}/wiki/api/v2/pages?space-id=${SPACE_ID}&title=${encodeURIComponent(title)}&limit=5`;
  const lookup = await callUpstream(ctx.fetchImpl, lookupUrl, { headers: authHeaders(session.accessToken) });
  const found = await readUpstreamJson(lookup);
  const results = Array.isArray(found?.results) ? found.results : null;
  if (!results || results.length > 5) fail(502, 'upstream_invalid');
  const sameTitle = results.filter(page => page && page.title === title && page.status === 'current');
  if (sameTitle.length > 1) fail(409, 'archive_conflict');
  let page = sameTitle[0] ? await getPage(ctx.fetchImpl, base, session.accessToken, String(sameTitle[0].id)) : null;
  if (page && (String(page.parentId) !== parent || String(page.spaceId) !== SPACE_ID)) fail(409, 'archive_conflict');
  if (page && readyLabel(page)) {
    await assertReadOpen(ctx.fetchImpl, base, session.accessToken, String(page.id));
    const prop = propertyValue(page);
    if (prop && prop.ready === true && prop.archiveSha256 === archiveSha256 && prop.id === normalized.id && prop.kind === normalized.kind) {
      const url = webUrl(page);
      if (!url) fail(502, 'upstream_invalid');
      return json(200, { pageId: String(page.id), webUrl: url, archiveSha256, stored: true, alreadyExisted: true });
    }
    fail(409, 'archive_conflict');
  }
  let created = false;
  if (!page) {
    try {
      const response = await callUpstream(ctx.fetchImpl, `${base}/wiki/api/v2/pages`, {
        method: 'POST',
        headers: authHeaders(session.accessToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          spaceId: SPACE_ID,
          status: 'current',
          title,
          parentId: parent,
          body: { representation: 'storage', value: summaryHtml(normalized, archiveSha256) },
        }),
      }, false);
      page = await readUpstreamJson(response);
      created = true;
    } catch (error) {
      throw error;
    }
  }
  const pageId = page && PAGE_ID.test(String(page.id)) ? String(page.id) : null;
  if (!pageId) fail(created ? 409 : 502, created ? 'write_unknown' : 'upstream_invalid', {}, created ? { readBack: true } : null);
  if (String(page.spaceId || SPACE_ID) !== SPACE_ID || (page.parentId && String(page.parentId) !== parent)) {
    fail(409, 'archive_conflict');
  }
  try {
    await ensureAttachment(ctx, base, session.accessToken, session.cloudId, pageId, archiveSha256, bytes);
    await ensureProperty(ctx, base, session.accessToken, pageId, normalized, archiveSha256);
    await ensureLabel(ctx, base, session.accessToken, pageId);
    const fresh = await getPage(ctx.fetchImpl, base, session.accessToken, pageId, true);
    await assertReadOpen(ctx.fetchImpl, base, session.accessToken, pageId);
    const url = webUrl(fresh);
    const prop = propertyValue(fresh);
    if (!url || !readyLabel(fresh) || !prop || prop.ready !== true || prop.archiveSha256 !== archiveSha256 || prop.id !== normalized.id) {
      fail(409, 'write_partial', {}, { pageId, readBack: true });
    }
    return json(201, { pageId, webUrl: url, archiveSha256, stored: true, alreadyExisted: false });
  } catch (error) {
    promote(error, pageId);
  }
}

async function ensureAttachment(ctx, base, token, cloudId, pageId, archiveSha256, bytes) {
  const filename = `${archiveSha256}.json`;
  const listResponse = await callUpstream(ctx.fetchImpl, `${base}/wiki/api/v2/pages/${pageId}/attachments?limit=25`, {
    headers: authHeaders(token),
  }, true);
  const list = await readUpstreamJson(listResponse, true);
  const attachments = Array.isArray(list?.results) ? list.results : null;
  if (!attachments || attachments.length > 25) fail(409, 'write_unknown', {}, { pageId, readBack: true });
  let attachment = attachments.find(item => item && item.title === filename);
  if (!attachment) {
    const boundary = `falsify${crypto.randomUUID().replace(/-/g, '')}`;
    const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/json\r\n\r\n`);
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);
    const uploaded = await callUpstream(ctx.fetchImpl, `${base}/wiki/rest/api/content/${pageId}/child/attachment`, {
      method: 'POST',
      headers: authHeaders(token, {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'X-Atlassian-Token': 'nocheck',
      }),
      body,
    }, true);
    const created = await readUpstreamJson(uploaded, true);
    const results = created?.results || (created?.id ? [created] : null);
    attachment = Array.isArray(results) ? results.find(item => item && item.title === filename) : null;
  }
  if (!attachment || !ATTACHMENT_ID.test(String(attachment.id))) fail(409, 'write_partial', {}, { pageId, readBack: true });
  const download = await downloadAttachment(ctx.fetchImpl, `${base}/wiki/rest/api/content/${pageId}/child/attachment/${attachment.id}/download`, token, cloudId, pageId, String(attachment.id), true);
  const downloaded = await readBounded(download, MAX_ARCHIVE_BYTES);
  if (download.status < 200 || download.status >= 300) fail(409, 'write_partial', {}, { pageId, readBack: true });
  if (!downloaded) fail(413, 'payload_too_large');
  try {
    await verifyBytes(downloaded, archiveSha256);
  } catch (error) {
    promote(error, pageId);
  }
}

async function ensureProperty(ctx, base, token, pageId, archive, archiveSha256) {
  const value = { kind: archive.kind, id: archive.id, title: archive.title, archiveSha256, ready: true };
  const response = await callUpstream(ctx.fetchImpl, `${base}/wiki/api/v2/pages/${pageId}/properties`, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ key: PROPERTY_KEY, value }),
  }, true);
  if (response.status === 409) return;
  await readUpstreamJson(response, true);
}

async function ensureLabel(ctx, base, token, pageId) {
  const response = await callUpstream(ctx.fetchImpl, `${base}/wiki/rest/api/content/${pageId}/label`, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify([{ prefix: 'global', name: READY_LABEL }]),
  }, true);
  await readUpstreamJson(response, true);
}

async function listArchives(ctx, session) {
  await requireReady(ctx);
  const config = confluenceConfig(ctx.env);
  const cursor = ctx.url.searchParams.get('cursor');
  if ([...ctx.url.searchParams.keys()].some(key => key !== 'cursor')) fail(400, 'invalid_request');
  const key = await aesKey(ctx.env);
  let upstreamCursor = null;
  if (cursor !== null) {
    if (!CLIENT_CURSOR.test(cursor)) fail(400, 'invalid_cursor');
    const opened = key ? await open(key, CURSOR_PURPOSE, cursor) : null;
    if (!opened || opened.cloudId !== session.cloudId || opened.parent !== config.parent || typeof opened.cursor !== 'string' || !CURSOR.test(opened.cursor)) {
      fail(400, 'invalid_cursor');
    }
    upstreamCursor = opened.cursor;
  }
  await confine(ctx.fetchImpl, session.accessToken, session.cloudId, config.parent);
  const base = cloudBase(session.cloudId);
  const pathname = `/ex/confluence/${session.cloudId}/wiki/api/v2/pages/${config.parent}/children`;
  const url = `${base}/wiki/api/v2/pages/${config.parent}/children?limit=25${upstreamCursor ? `&cursor=${encodeURIComponent(upstreamCursor)}` : ''}`;
  const response = await callUpstream(ctx.fetchImpl, url, { headers: authHeaders(session.accessToken) });
  const payload = await readUpstreamJson(response);
  const results = Array.isArray(payload?.results) ? payload.results : null;
  if (!results || results.length > 25) fail(502, 'upstream_invalid');
  const items = [];
  for (const child of results) {
    if (!child || !PAGE_ID.test(String(child.id)) || String(child.parentId || config.parent) !== config.parent) continue;
    const page = await getPage(ctx.fetchImpl, base, session.accessToken, String(child.id));
    if (!page || String(page.parentId) !== config.parent || String(page.spaceId) !== SPACE_ID || !readyLabel(page)) continue;
    try { await assertReadOpen(ctx.fetchImpl, base, session.accessToken, String(page.id)); }
    catch (error) { if (error instanceof GatewayError && error.status === 403) continue; throw error; }
    const prop = propertyValue(page);
    if (!prop || prop.ready !== true || typeof prop.archiveSha256 !== 'string' || !HEX.test(prop.archiveSha256)) continue;
    const updatedAt = page.version?.createdAt || page.createdAt;
    const url = webUrl(page);
    if (typeof updatedAt !== 'string' || !url) fail(502, 'upstream_invalid');
    const displayTitle = typeof prop.title === 'string' && prop.title.trim() && prop.title.length <= 500 && !/[\u0000-\u001f\u007f]/.test(prop.title) ? prop.title : String(page.title || '');
    items.push({ pageId: String(page.id), title: displayTitle, updatedAt, webUrl: url });
  }
  const nextRaw = cursorFromNext(payload?._links?.next, pathname);
  const nextCursor = nextRaw && key ? await seal(key, CURSOR_PURPOSE, { purpose: CURSOR_PURPOSE, cloudId: session.cloudId, parent: config.parent, cursor: nextRaw }) : null;
  if (nextCursor && !CLIENT_CURSOR.test(nextCursor)) fail(502, 'upstream_invalid');
  return json(200, { items, nextCursor });
}

async function readArchive(ctx, session, pageId) {
  await requireReady(ctx);
  if (!PAGE_ID.test(pageId)) fail(404, 'not_found');
  const config = confluenceConfig(ctx.env);
  await confine(ctx.fetchImpl, session.accessToken, session.cloudId, config.parent);
  const base = cloudBase(session.cloudId);
  const page = await getPage(ctx.fetchImpl, base, session.accessToken, pageId);
  if (!page || String(page.parentId) !== config.parent || String(page.spaceId) !== SPACE_ID || !readyLabel(page)) fail(404, 'not_found');
  await assertReadOpen(ctx.fetchImpl, base, session.accessToken, pageId);
  const prop = propertyValue(page);
  if (!prop || prop.ready !== true || !HEX.test(prop.archiveSha256 || '')) fail(404, 'not_found');
  const listResponse = await callUpstream(ctx.fetchImpl, `${base}/wiki/api/v2/pages/${pageId}/attachments?limit=25`, {
    headers: authHeaders(session.accessToken),
  });
  const list = await readUpstreamJson(listResponse);
  const filename = `${prop.archiveSha256}.json`;
  const attachments = Array.isArray(list?.results) ? list.results.filter(item => item && item.title === filename) : [];
  if (attachments.length !== 1 || !ATTACHMENT_ID.test(String(attachments[0].id))) fail(422, 'invalid_archive');
  const download = await downloadAttachment(ctx.fetchImpl, `${base}/wiki/rest/api/content/${pageId}/child/attachment/${attachments[0].id}/download`, session.accessToken, session.cloudId, pageId, String(attachments[0].id), false);
  if (download.status < 200 || download.status >= 300) fail(422, 'invalid_archive');
  const bytes = await readBounded(download, MAX_ARCHIVE_BYTES);
  if (!bytes) fail(413, 'payload_too_large');
  const verified = await verifyBytes(bytes, prop.archiveSha256);
  if (verified.normalized.id !== prop.id || verified.normalized.kind !== prop.kind) fail(422, 'invalid_archive');
  const url = webUrl(page);
  if (!url) fail(502, 'upstream_invalid');
  return json(200, { pageId, webUrl: url, archive: verified.normalized, archiveSha256: prop.archiveSha256 });
}

async function requireReady(ctx) {
  if (!confluenceConfig(ctx.env).configured || !(await aesKey(ctx.env))) fail(503, 'not_configured');
}

async function startAuth(ctx) {
  const config = confluenceConfig(ctx.env);
  await requireReady(ctx);
  const origin = ctx.request.headers.get('Origin');
  if (!origin || !origins(ctx.settings).has(origin)) fail(403, 'origin_not_allowed');
  const body = await readRequestJson(ctx.request, 4096);
  if (Object.keys(body).sort().join() !== 'nonce,returnOrigin') fail(400, 'invalid_request');
  if (typeof body.nonce !== 'string' || !NONCE.test(body.nonce)) fail(400, 'invalid_request');
  let returnOrigin;
  try { returnOrigin = new URL(body.returnOrigin).origin; } catch { fail(400, 'invalid_request'); }
  if (returnOrigin !== origin || returnOrigin !== body.returnOrigin || !origins(ctx.settings).has(returnOrigin)) fail(403, 'origin_not_allowed');
  const key = await aesKey(ctx.env);
  const state = await seal(key, STATE_PURPOSE, {
    purpose: STATE_PURPOSE,
    nonce: body.nonce,
    returnOrigin,
    exp: ctx.now() + STATE_MS,
  });
  const authorize = new URL('https://auth.atlassian.com/authorize');
  authorize.searchParams.set('audience', 'api.atlassian.com');
  authorize.searchParams.set('client_id', config.client);
  authorize.searchParams.set('scope', SCOPES.join(' '));
  authorize.searchParams.set('redirect_uri', config.callback);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('prompt', 'consent');
  return json(200, { authorizeUrl: authorize.toString() });
}

async function callback(ctx) {
  const config = confluenceConfig(ctx.env);
  if (!config.configured || !(await aesKey(ctx.env))) return html(null, SITE_URL);
  const stateToken = ctx.url.searchParams.get('state');
  const code = ctx.url.searchParams.get('code');
  const key = await aesKey(ctx.env);
  const state = key && stateToken ? await open(key, STATE_PURPOSE, stateToken) : null;
  if (!state || typeof state.returnOrigin !== 'string' || !origins(ctx.settings).has(state.returnOrigin) || typeof state.nonce !== 'string') {
    return html(null, SITE_URL);
  }
  if (state.exp <= ctx.now()) return html(null, state.returnOrigin);
  if (ctx.url.searchParams.get('error') || typeof code !== 'string' || !/^[A-Za-z0-9._~-]{8,2048}$/.test(code)) return html(null, state.returnOrigin);
  try {
    const token = await tokenRequest(ctx.fetchImpl, ctx.env, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.callback,
    });
    if (typeof token.refresh_token !== 'string') return html(null, state.returnOrigin);
    const cloudId = await accessibleCloud(ctx.fetchImpl, token.access_token);
    await confine(ctx.fetchImpl, token.access_token, cloudId, config.parent);
    const now = ctx.now();
    const session = {
      purpose: SESSION_PURPOSE,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessExp: now + token.expires_in * 1000,
      envelopeExp: now + ENVELOPE_MS,
      rotations: 0,
      cloudId,
      siteUrl: SITE_URL,
    };
    const sealed = await seal(key, SESSION_PURPOSE, session);
    return html({ type: 'falsify.confluence.session.v1', nonce: state.nonce, session: sealed, expiresAt: new Date(session.envelopeExp).toISOString() }, state.returnOrigin);
  } catch {
    return html(null, state.returnOrigin);
  }
}

async function refresh(ctx, session) {
  const key = await aesKey(ctx.env);
  const sealed = ctx.refreshed || await seal(key, SESSION_PURPOSE, session);
  return json(200, { session: sealed, expiresAt: new Date(session.envelopeExp).toISOString() }, ctx.refreshed ? { [SESSION_HEADER]: ctx.refreshed, 'Access-Control-Expose-Headers': SESSION_HEADER } : {});
}

async function capabilities(ctx) {
  const config = confluenceConfig(ctx.env);
  const key = await aesKey(ctx.env);
  return json(200, {
    provider: 'confluence',
    configured: config.configured && !!key,
    siteUrl: SITE_URL,
    spaceKey: SPACE_KEY,
    spaceId: SPACE_ID,
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
  });
}

const ROUTES = {
  '/v1/confluence/capabilities': { GET: ctx => capabilities(ctx) },
  '/v1/confluence/auth/start': { POST: ctx => startAuth(ctx) },
  '/v1/confluence/auth/callback': { GET: ctx => callback(ctx) },
  '/v1/confluence/auth/refresh': { POST: async ctx => refresh(ctx, await bearerSession(ctx)) },
  '/v1/confluence/archives': {
    GET: async ctx => listArchives(ctx, await bearerSession(ctx)),
    POST: async ctx => publish(ctx, await bearerSession(ctx)),
  },
  '/v1/confluence/archives/:pageId': { GET: async ctx => readArchive(ctx, await bearerSession(ctx), ctx.match.pageId) },
};

export function matchConfluence(pathname) {
  if (Object.hasOwn(ROUTES, pathname)) return { template: pathname, pageId: null };
  const match = /^\/v1\/confluence\/archives\/([0-9]{1,20})$/.exec(pathname);
  if (match) return { template: '/v1/confluence/archives/:pageId', pageId: match[1] };
  if (pathname.startsWith('/v1/confluence/')) return { template: '/v1/confluence/unknown', pageId: null };
  return null;
}

export async function handleConfluence(ctx) {
  const context = {
    ...ctx,
    fetchImpl: ctx.fetchImpl || globalThis.fetch.bind(globalThis),
    now: ctx.now || Date.now,
    refreshed: null,
  };
  try {
    const route = ROUTES[ctx.match.template];
    if (!route) fail(404, 'not_found');
    if (ctx.request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' },
      });
    }
    const handler = route[ctx.request.method];
    if (!handler) fail(405, 'method_not_allowed', { Allow: Object.keys(route).join(', ') });
    const response = await handler(context);
    return withSession(response, context);
  } catch (error) {
    const known = error instanceof GatewayError ? error : new GatewayError(500, 'internal_error');
    return withSession(errorResponse(known), context);
  }
}

export function confluenceOnly(env) {
  return env?.CONFLUENCE_ONLY === true || env?.CONFLUENCE_ONLY === 'true';
}

export const LEGACY_WRITES = new Set([
  'POST /v1/auth/register',
  'POST /v1/auth/login',
  'POST /v1/auth/password',
  'POST /v1/auth/sessions/revoke',
  'POST /v1/logout',
  'POST /v1/records',
  'PATCH /v1/records/:id',
  'DELETE /v1/records/:id',
]);
