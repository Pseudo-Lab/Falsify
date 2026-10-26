'use strict';
// Static contract for the paper-workspace guide. No browser, network, model, or private paper.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dist = path.resolve(__dirname, '../dist');
const guide = fs.readFileSync(path.join(dist, 'guide.html'), 'utf8');
const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');

function ids(html) {
  const found = new Map();
  for (const match of html.matchAll(/\sid=["']([^"']+)["']/g)) {
    const id = match[1];
    found.set(id, (found.get(id) || 0) + 1);
  }
  return found;
}

function anchors(html) {
  const out = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) out.push(match[1]);
  return out;
}

const PHRASES = [
  '편집 반영',
  '원문과 과제 프롬프트 복사',
  '붙여넣은 응답',
  '고른 위치로 확정',
  '현재 편집으로 생성',
  '마지막 생성본 · 현재 편집과 다름',
  '원본 다운로드',
  'BLUE 검토 파일',
  '이 생성본만 BLUE로',
  '검수 기록 추가',
  '팀에 공개',
  '이 수동 기록을 팀원 모두에게 공개합니다',
  '12시간 초안 보관',
  '원본 PDF도 이 브라우저에 12시간 보관',
  'PowerShell 5.1',
  'PowerShell 7',
  'macOS',
  'AI 검토 · 선택 사항',
  '과학적 정확도',
  '레이아웃'
];

function visible(html) {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

test('quick three steps stay short and precede the collapsed reference', () => {
  const quickAt = guide.indexOf('id="quick"');
  const stepsAt = guide.indexOf('<ol id="quick-steps">');
  const referenceAt = guide.indexOf('<details id="reference"');
  assert.ok(quickAt >= 0 && stepsAt > quickAt && referenceAt > stepsAt);
  assert.equal((guide.match(/<details id="reference"[^>]*\sopen\b/) || []).length, 0);
  const quick = guide.slice(quickAt, referenceAt);
  const ol = quick.match(/<ol id="quick-steps">[\s\S]*?<\/ol>/);
  assert.ok(ol, 'quick steps list');
  const items = [...ol[0].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match => visible(match[1]));
  assert.equal(items.length, 3);
  assert.match(items[0], /PDF를 넣습니다/);
  assert.match(items[1], /글자를 선택하고 After를 수정/);
  assert.match(items[2], /미리보고/);
  assert.match(items[2], /다운로드/);
  for (const text of items) {
    const sentences = text.split(/[.!?。]/).map(part => part.trim()).filter(Boolean);
    assert.ok(sentences.length <= 2, text);
    assert.ok(text.length <= 80, text.length + ' ' + text);
  }
  const links = quick.slice(quick.indexOf(ol[0]) + ol[0].length);
  for (const href of ['#external-ai', '#red', '#blue', '#review']) assert.ok(links.includes('href="' + href + '"'), href);
  for (const phrase of ['12시간 초안', '팀에 공개', '과학적 정확도', '고른 위치로 확정', 'PowerShell 5.1']) {
    assert.equal(quick.includes(phrase), false, phrase);
  }
  assert.ok(guide.indexOf('id="paper"') > referenceAt);
  assert.ok(guide.indexOf('</details>') > guide.indexOf('id="docs"'));
});

test('in-page guide links resolve and external links stay public https', () => {
  const found = ids(guide);
  for (const [id, count] of found) assert.equal(count, 1, 'duplicate id ' + id);
  const links = anchors(guide);
  const local = links.filter(href => href.startsWith('#'));
  assert.ok(local.length >= 12, 'expected a table of contents, not a single link');
  for (const href of local) {
    const id = decodeURIComponent(href.slice(1));
    assert.ok(id.length > 1, href);
    assert.ok(found.has(id), 'missing anchor ' + href);
  }
  const remote = links.filter(href => !href.startsWith('#'));
  assert.ok(remote.length >= 4);
  for (const href of remote) {
    assert.match(href, /^https:\/\/[^\s<>"]+$/);
    assert.doesNotMatch(href, /[?#].*(?:token|key|secret)=/i);
  }
});

test('required anchors and terms stay inside the collapsed reference', () => {
  const detail = guide.slice(guide.indexOf('<details id="reference"'), guide.indexOf('</details>'));
  for (const phrase of PHRASES) assert.ok(detail.includes(phrase), phrase);
  assert.match(detail, /회전/);
  assert.match(detail, /1단/);
  assert.match(detail, /동의 체크가 화면에 하나뿐이면 그 체크와 저장 버튼을 따릅니다/);
  assert.doesNotMatch(guide, /0\.2\.0-alpha(?:\.\d+)?/);
  assert.doesNotMatch(guide.slice(0, guide.indexOf('id="reference"')), /alpha\.\d+/);
});

test('guide and the main app page contain no private data', () => {
  const banned = [
    /sk-[A-Za-z0-9_\-]{8,}/,
    /ghp_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/,
    /AKIA[0-9A-Z]{16}/,
    /api[_-]?key\s*[:=]\s*["'][^"']{8,}["']/i,
    /\/Users\/[A-Za-z0-9._-]+/,
    /\/home\/[A-Za-z0-9._-]+/,
    /C:\\Users\\/i,
    /Bearer\s+[A-Za-z0-9\-._~+/]{20,}/,
    /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/
  ];
  for (const [name, text] of [['guide', guide], ['main', index]]) {
    for (const pattern of banned) assert.doesNotMatch(text, pattern, name + ' ' + pattern);
  }
  assert.match(index, /<main\b/);
  assert.doesNotMatch(index, /0\.2\.0-alpha\.7 기준/);
});
