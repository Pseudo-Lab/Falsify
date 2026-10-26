'use strict';
// Synthetic-DOM checks for the account password and revoke-all controls.
// No browser, network, server, or model calls. Passwords stay in the request body only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const jsPath = process.env.FALSIFY_CLOUD_RECORDS || path.resolve(__dirname, '../legacy/cloud-records.js');
const cssPath = process.env.FALSIFY_CLOUD_RECORDS_CSS || path.join(path.dirname(jsPath), 'cloud-records.css');
const src = fs.readFileSync(jsPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const BASE = 'https://api.test';
const KEY = 'falsify.cloud-session.v1';
const TOKEN = 't'.repeat(43);
const FUTURE = new Date(Date.now() + 864e5).toISOString();
const CURRENT = 'correct horse battery';
const NEXT = 'replacement horse battery';
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const until = async (f, label) => { for (let i = 0; i < 300 && !f(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(f(), label); };

class El extends EventTarget {
  constructor(tag) {
    super();
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], parent: null, attrs: {}, dataset: {}, _text: '', id: '', className: '', value: '', checked: false, disabled: false, hidden: false, open: false });
    const set = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = { toggle: (c, on) => { const s = set(); (on ?? !s.has(c)) ? s.add(c) : s.delete(c); this.className = [...s].join(' '); }, contains: c => set().has(c) };
  }
  get textContent() { return this._text + this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  append(...kids) { for (const c of kids) { if (typeof c === 'object') c.parent = this; this.children.push(c); } }
  prepend(...kids) { for (const c of kids) if (typeof c === 'object') c.parent = this; this.children.unshift(...kids); }
  replaceChildren(...kids) {
    const d = this.ownerDocument, a = d?.activeElement;
    if (a && a !== this && this.contains(a)) d.activeElement = d.body;
    for (const c of this.children) if (typeof c === 'object') c.parent = null;
    this.children = []; this._text = ''; this.append(...kids);
  }
  contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  focus() { if (!this.disabled && this.ownerDocument) this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  *walk() { yield this; for (const c of this.children) if (typeof c === 'object') yield* c.walk(); }
  find(f) { for (const n of this.walk()) if (f(n)) return n; return null; }
}

const meSession = () => JSON.stringify({ apiBase: BASE, token: TOKEN, author: { id: 'author-me', username: 'me', displayName: 'Me' }, expiresAt: FUTURE });

function setup({ store = new Map(), routes = () => ({ status: 404, body: { error: { code: 'not_found' } } }) } = {}) {
  const body = new El('body'), results = new El('section');
  results.id = 'view-results';
  const ledger = new El('section'); ledger.id = 'ledger-board';
  results.append(ledger); body.append(results);
  const writes = [];
  const document = new EventTarget();
  Object.assign(document, {
    readyState: 'complete', body, activeElement: body,
    createElement: t => { const e = new El(t); e.ownerDocument = document; return e; },
    querySelector: s => s.startsWith('#') ? body.find(n => n.id === s.slice(1)) : null,
  });
  body.ownerDocument = document;
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const recorded = { url, method: init.method, headers: { ...init.headers }, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(recorded);
    const r = await routes(init.method, u.pathname, init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
  };
  const localStorage = {
    getItem: k => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => { writes.push([k, String(v)]); store.set(k, String(v)); },
    removeItem: k => store.delete(k),
  };
  const ctx = vm.createContext({
    document, FalsifyCloudConfig: { apiBase: BASE }, localStorage, fetch, URL, URLSearchParams, Blob, AbortController, TextEncoder, Event, console,
    setTimeout: (f, ms) => setTimeout(f, ms >= 15000 ? 20 : ms), clearTimeout, location: { href: 'https://shinick-han.github.io/falsify-workbench/' },
  });
  vm.runInContext(src, ctx, { filename: 'cloud-records.js' });
  const $ = id => body.find(n => n.id === id);
  return { calls, store, writes, body, doc: document, $, ready: ctx.FalsifyCloudRecords.ready };
}

const signedIn = () => new Map([[KEY, meSession()]]);
const storedText = t => JSON.stringify([...t.store.entries(), ...t.writes]);
const submitPassword = (t, current, next, again) => {
  t.$('cloud-current-password').value = current;
  t.$('cloud-new-password').value = next;
  t.$('cloud-confirm-password').value = again;
  t.$('cloud-password-form').dispatchEvent(new Event('submit', { cancelable: true }));
};

test('signed-out account panel has no password change or revoke control', async () => {
  const t = setup();
  await t.ready;
  assert.equal(t.$('cloud-password-form'), null);
  assert.equal(t.$('cloud-revoke-all'), null);
  assert.equal(t.$('cloud-auth-form') !== null, true);
  assert.equal(t.calls.length, 0);
});

test('password fields require an explicit submit and never keep or store the values', async () => {
  const t = setup({ store: signedIn() });
  await t.ready;
  assert.equal(t.$('cloud-password-form') !== null, true);
  for (const [id, hint, auto] of [
    ['cloud-current-password', 'cloud-current-password-hint', 'current-password'],
    ['cloud-new-password', 'cloud-new-password-hint', 'new-password'],
    ['cloud-confirm-password', 'cloud-confirm-password-hint', 'new-password'],
  ]) {
    assert.equal(t.$(id).type, 'password');
    assert.equal(t.$(id).getAttribute('autocomplete'), auto);
    assert.equal(t.$(id).getAttribute('name'), null);
    assert.equal(t.$(id).getAttribute('aria-describedby'), hint);
  }
  t.$('cloud-current-password').value = CURRENT;
  t.$('cloud-new-password').value = NEXT;
  t.$('cloud-confirm-password').value = NEXT;
  await flush();
  assert.equal(t.calls.length, 0, 'typing does not send');
  submitPassword(t, CURRENT, 'short-pass', 'short-pass');
  await flush();
  assert.equal(t.calls.length, 0, 'short new password stays local');
  assert.equal(t.$('cloud-current-password').value, '');
  assert.equal(t.$('cloud-new-password').value, '');
  assert.ok(!storedText(t).includes(CURRENT));
  assert.ok(!t.$('cloud-status').textContent.includes('short-pass'));
  submitPassword(t, CURRENT, NEXT, 'other horse battery');
  await flush();
  assert.equal(t.calls.length, 0, 'confirmation mismatch is not sent');
  assert.equal(t.doc.activeElement, t.$('cloud-confirm-password'));
  assert.equal(t.store.has(KEY), true);
});

test('wrong current password clears the fields and keeps this browser token', async () => {
  const t = setup({
    store: signedIn(),
    routes: (m, p) => m === 'POST' && p === '/v1/auth/password' ? { status: 401, body: { error: { code: 'invalid_credentials', message: CURRENT } } } : { status: 500, body: 'no' },
  });
  await t.ready;
  submitPassword(t, CURRENT, NEXT, NEXT);
  await until(() => t.$('cloud-status').classList.contains('error'), 'password error');
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0].body, { currentPassword: CURRENT, newPassword: NEXT });
  assert.equal(t.calls[0].headers.authorization, 'Bearer ' + TOKEN);
  assert.equal(t.store.has(KEY), true);
  assert.equal(t.$('cloud-password-form') !== null, true);
  assert.equal(t.$('cloud-current-password').value, '');
  assert.equal(t.$('cloud-new-password').value, '');
  assert.equal(t.$('cloud-confirm-password').value, '');
  assert.ok(!t.body.textContent.includes(CURRENT));
  assert.ok(!t.body.textContent.includes(NEXT));
  assert.ok(!storedText(t).includes(CURRENT));
  assert.ok(!storedText(t).includes(NEXT));
  assert.match(t.$('cloud-status').textContent, /세션 토큰은 그대로/);
});

test('a successful password change logs this browser out and does not sign in again', async () => {
  const t = setup({
    store: signedIn(),
    routes: (m, p) => m === 'POST' && p === '/v1/auth/password' ? { status: 200, body: { changed: true, token: 'fss_should_not_stick', newPassword: NEXT } } : { status: 500, body: 'no' },
  });
  await t.ready;
  submitPassword(t, CURRENT, NEXT, NEXT);
  await until(() => !t.store.has(KEY), 'token cleared');
  await flush();
  assert.equal(t.calls.length, 1, 'no follow-up login');
  assert.equal(t.calls[0].url, BASE + '/v1/auth/password');
  assert.deepEqual(Object.keys(t.calls[0].body).sort(), ['currentPassword', 'newPassword']);
  assert.equal(t.$('cloud-password-form'), null);
  assert.equal(t.$('cloud-auth-form') !== null, true);
  assert.match(t.$('cloud-status').textContent, /비밀번호를 바꿨습니다/);
  assert.match(t.$('cloud-account-summary').textContent, /다시 로그인 필요/);
  assert.ok(!t.body.textContent.includes(NEXT));
  assert.ok(!storedText(t).includes(NEXT));
  assert.ok(!storedText(t).includes('fss_should_not_stick'));
});

test('revoke-all waits for confirmation, sends only this session, then clears the token', async () => {
  const t = setup({
    store: signedIn(),
    routes: (m, p) => m === 'POST' && p === '/v1/auth/sessions/revoke' ? { status: 200, body: { revoked: true } } : { status: 500, body: 'no' },
  });
  await t.ready;
  assert.equal(t.$('cloud-revoke-confirm'), null);
  t.$('cloud-revoke-all').click();
  await flush();
  assert.equal(t.calls.length, 0, 'the first button does not call the server');
  assert.equal(t.$('cloud-revoke-confirm') !== null, true);
  t.$('cloud-revoke-cancel').click();
  await flush();
  assert.equal(t.calls.length, 0);
  assert.equal(t.$('cloud-revoke-all') !== null, true);
  t.$('cloud-revoke-all').click();
  t.$('cloud-revoke-confirm').click();
  await until(() => !t.store.has(KEY), 'token cleared after revoke');
  await flush();
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].method, 'POST');
  assert.equal(t.calls[0].url, BASE + '/v1/auth/sessions/revoke');
  assert.equal(t.calls[0].body, undefined);
  assert.equal(t.calls[0].headers.authorization, 'Bearer ' + TOKEN);
  assert.equal(JSON.stringify(t.calls[0]).includes('author-other'), false);
  assert.match(t.$('cloud-status').textContent, /다른 계정의 세션과 기록은 바꾸지 않았습니다/);
  assert.equal(t.$('cloud-revoke-all'), null);
});

test('expired session 401 unauthorized signs out and a missing route 404 does not', async () => {
  const expired = setup({
    store: signedIn(),
    routes: () => ({ status: 401, body: { error: { code: 'unauthorized', message: CURRENT } } }),
  });
  await expired.ready;
  submitPassword(expired, CURRENT, NEXT, NEXT);
  await until(() => !expired.store.has(KEY), 'expired token cleared');
  await flush();
  assert.equal(expired.calls.length, 1);
  assert.match(expired.$('cloud-status').textContent, /세션이 끝나/);
  assert.ok(!expired.body.textContent.includes(CURRENT));
  assert.ok(!expired.body.textContent.includes('invalid_credentials'));

  const missing = setup({
    store: signedIn(),
    routes: (m, p) => m === 'POST' && p === '/v1/auth/password'
      ? { status: 404, body: { error: { code: 'not_found', message: NEXT } } }
      : { status: 500, body: 'no' },
  });
  await missing.ready;
  submitPassword(missing, CURRENT, NEXT, NEXT);
  await until(() => missing.$('cloud-status').classList.contains('error'), 'missing route');
  assert.equal(missing.calls.length, 1);
  assert.equal(missing.store.has(KEY), true);
  assert.match(missing.$('cloud-status').textContent, /서버 업데이트가 필요합니다/);
  assert.ok(!missing.body.textContent.includes('기록을 찾을 수 없습니다'));
  assert.ok(!missing.body.textContent.includes(NEXT));
});

test('an unknown password response is not sent again', async () => {
  const t = setup({
    store: signedIn(),
    routes: (m, p, init) => {
      if (m === 'POST' && p === '/v1/auth/password') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Error('aborted'))));
      return { status: 500, body: 'no' };
    },
  });
  await t.ready;
  submitPassword(t, CURRENT, NEXT, NEXT);
  await until(() => /다시 보내지 않습니다/.test(t.$('cloud-status').textContent), 'no retry copy');
  await flush();
  assert.equal(t.calls.length, 1);
  assert.equal(t.store.has(KEY), true);
  assert.ok(!t.body.textContent.includes(CURRENT));
});

test('account styles cover the password form and the revoke block', () => {
  assert.match(css, /#cloud-password-form/);
  assert.match(css, /#cloud-revoke/);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok - ' + name); }
    catch (e) { failed++; console.error('not ok - ' + name + '\n' + (e.stack || e)); }
  }
  console.log(JSON.stringify({ passed: tests.length - failed, failed }));
  process.exitCode = failed ? 1 : 0;
})();
