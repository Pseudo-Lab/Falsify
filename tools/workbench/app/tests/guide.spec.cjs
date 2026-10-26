// Static checks for the standalone Korean user guide (dist/guide.html). No browser, network or model.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),H=require('../dist/harness-core.js');
const dist=path.join(__dirname,'..','dist'),repo=path.resolve(__dirname,'..','..'),file=path.join(dist,'guide.html');
const html=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');let passed=0;const checks=[];
function check(name,fn){fn();checks.push(name);passed++;}
const unescape=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
const strip=s=>unescape(s.replace(/<[^>]+>/g,''));
const css=(html.match(/<style>([\s\S]*?)<\/style>/)||[])[1]||'';
const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]);
const hrefs=[...html.matchAll(/\shref="([^"]*)"/g)].map(m=>unescape(m[1]));
const uiSources=[path.join(dist,'index.html'),...fs.readdirSync(dist).filter(f=>f.endsWith('.js')).map(f=>path.join(dist,f))].map(f=>fs.readFileSync(f,'utf8')).join('\n');
const chapters=['prereq','launch','connect','red','pdf-export','image','blue','review','harness','results','storage','security','trouble','limits','examples','docs'];

check('standalone HTML document head',()=>{
  assert.match(html,/^<!doctype html>\n<html lang="ko">/i);
  assert.match(html,/<meta charset="utf-8">/i);
  assert.match(html,/<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html,/<title>[^<]*사용 안내<\/title>/);
  assert.ok((strip(html).match(/[가-힣]/g)||[]).length>3000,'substantive Korean text');
  const lines=html.split('\n').length;assert.ok(lines>=250&&lines<=450,'bounded length '+lines);
});
check('no scripts, external assets, fonts, images or tracking',()=>{
  for(const re of [/<script/i,/<link\b/i,/<img\b/i,/<iframe/i,/<object/i,/<embed/i,/@import/i,/@font-face/i,/url\(/i,/\son[a-z]+=/i,/javascript:/i,/analytics|gtag|googletagmanager|beacon|pixel/i])assert.doesNotMatch(html,re);
  assert.ok(!hrefs.some(h=>h.startsWith('http:')),'no plain http links');
});
check('unique ids and resolving in-page anchors',()=>{
  assert.equal(new Set(ids).size,ids.length,'duplicate id');
  for(const h of hrefs.filter(h=>h.startsWith('#')))assert.ok(ids.includes(h.slice(1)),'missing anchor '+h);
});
check('quick use first, then table of contents, then detailed chapters',()=>{
  const at=id=>html.indexOf(' id="'+id+'"');
  assert.ok(at('quick')>0&&at('quick')<at('toc'),'quick before toc');
  for(const c of chapters)assert.ok(at(c)>at('toc'),'chapter after toc: '+c);
  const toc=html.slice(at('toc'),html.indexOf('</nav>'));
  assert.deepEqual([...toc.matchAll(/href="#([^"]+)"/g)].map(m=>m[1]),chapters);
  const quick=strip(html.slice(at('quick'),at('toc')));
  for(const role of ['RED','BLUE','검수'])assert.ok(quick.includes(role),'quick covers '+role);
  assert.match(quick,/RED를 먼저 할 필요가 없습니다/);
});
check('skip link, focus, reading column, mobile and print CSS',()=>{
  assert.match(html,/<a class="skip" href="#quick">/);
  assert.match(css,/:focus-visible/);assert.match(css,/max-width:70ch/);assert.match(css,/font:16px/);
  assert.match(css,/@media \(max-width:640px\)/);assert.match(css,/@media print/);
  assert.equal((css.match(/var\(--yellow\)/g)||[]).length,1,'one yellow sign');
});
check('quoted UI labels exist in the current app',()=>{
  const labels=[...html.matchAll(/<b class="ui">([\s\S]*?)<\/b>/g)].map(m=>strip(m[1]));
  assert.ok(labels.length>=60,'enough concrete labels');
  for(const l of new Set(labels))assert.ok(uiSources.includes(l),'label not in app: '+l);
  for(const l of ['파일 입력','토큰으로 연결','실행','보존 검사 후 완성본 다운로드','변경 계획 JSON 저장','실행','검수 기록 추가','그림 위치 목록 불러오기','새 harness 버전 등록','전체 기록 JSON 백업'])assert.ok(labels.includes(l),'required label '+l);
});
check('key alpha2 facts and boundaries',()=>{
  const t=strip(html);
  for(const s of ['Python 3.10 이상','Python 3.11 이상','Node 24 이상','8비트 RGB 또는 완전 불투명 RGBA PNG','4 MiB','400만 픽셀','8192','텍스트만','N+2','OS 샌드박스가 아닙니다','accuracy나 탐지율이 아닙니다','포함되어 있지 않으며','cd tools/workbench','관리자 권한','API 키','공식 과학 벤치마크나 팀이 승인한 실험 범위가 아니며'])assert.ok(t.includes(s),'missing fact: '+s);
  for(const re of [/샌드박스로 (격리|보호)/,/OS 수준(으로)? 격리합니다/,/Word로 내보냅/,/모든 형식/,/정확도는 \d/,/탐지율 \d/,/성공률/])assert.doesNotMatch(t,re);
});
check('no private paths, tokens or development brief',()=>{
  for(const re of [/[A-Za-z]:[\\/]+Users[\\/]/i,/\/home\/[a-z]/,/jcpuk/i,/sk-[A-Za-z0-9]{10,}/,/ghp_[A-Za-z0-9]{10,}/,/xox[abp]-/,/AKIA[0-9A-Z]{12}/,/Bearer\s+[A-Za-z0-9]/,/api[_-]?key\s*[:=]/i,/coordination|surface-brief|Direction contract|THESIS|OWN-WORLD|impeccable/i])assert.doesNotMatch(html,re);
});
const repoUrl='https://github.com/Pseudo-Lab/Falsify/blob/feat/workbench-html-guide-20261012/tools/workbench/';
check('external links are https on expected hosts; repository links are absolute branch URLs that exist here',()=>{
  const hosts=new Set(['learn.chatgpt.com','code.claude.com','www.python.org','github.com','shinick-han.github.io']);
  for(const h of hrefs.filter(h=>/^[a-z]+:/i.test(h))){const u=new URL(h);assert.equal(u.protocol,'https:');assert.ok(hosts.has(u.hostname),'unexpected host '+u.hostname);assert.ok(!u.username&&!u.password&&!u.search,'clean URL '+h);}
  assert.deepEqual(hrefs.filter(h=>!/^[a-z]+:/i.test(h)&&!h.startsWith('#')),[],'no relative links in a standalone guide');
  assert.doesNotMatch(html,/href="\.\.?\//);
  const repoLinks=hrefs.filter(h=>h.startsWith('https://github.com/Pseudo-Lab/'));
  assert.ok(repoLinks.length>=8,'repository doc/example/license links');
  for(const h of repoLinks){assert.ok(h.startsWith(repoUrl),'branch prefix '+h);const p=path.resolve(repo,h.slice(repoUrl.length).split('#')[0]);assert.ok(p.startsWith(repo+path.sep),'outside repo '+h);assert.ok(fs.existsSync(p),'missing '+h);}
  for(const f of ['docs/pdf-editor.md','docs/harness-contract.md','docs/local-companion.md','docs/pdf-image-editing.md','app/examples/stdio_harness.py','README.md','LICENSE'])assert.ok(hrefs.includes(repoUrl+f),'absolute link '+f);
});
check('harness JSON samples validate against the current core and stay secret-free',()=>{
  const samples=[...html.matchAll(/<pre data-harness><code>([\s\S]*?)<\/code><\/pre>/g)].map(m=>JSON.parse(unescape(m[1])));
  assert.ok(samples.length>=1);
  for(const s of samples){assert.equal(H.validate(s).schema,'falsify.harness.v1');assert.ok(!('settings' in s));assert.doesNotMatch(JSON.stringify(s),/key|token|secret|password/i);}
  assert.ok(samples.some(s=>s.adapter?.type==='stdio'),'stdio sample');
});
const section=id=>{const at=html.indexOf(' id="'+id+'"');assert.ok(at>0,'section '+id);return strip(html.slice(at,html.indexOf('</section>',at)));};
check('primary app link is the hosted page, not a file next to the guide',()=>{
  assert.equal((html.match(/<a class="open-app" href="([^"]+)"/)||[])[1],'https://shinick-han.github.io/falsify-branch-preview/');
  assert.ok(!hrefs.some(h=>/(^|\/)index\.html$/.test(h)),'no index.html file link');
  const sign=strip(html.slice(html.indexOf('<header'),html.indexOf('</header>')));
  assert.ok(sign.includes('http://127.0.0.1:7816/'),'labeled loopback URL');
  assert.match(sign,/오프라인/);assert.match(sign,/파일로 직접 여는 방식은 완전히 지원하지 않습니다/);
  assert.doesNotMatch(strip(html),/공식 (Pseudo-?Lab|팀) ?(Pages|페이지|배포)/i);
});
check('new clones use the explicit Workbench branch and folder; existing installs stay put',()=>{
  const clone='git clone --branch feat/workbench-html-guide-20261012 https://github.com/Pseudo-Lab/Falsify.git';
  for(const id of ['quick','launch']){const t=section(id);assert.ok(t.includes(clone),'clone in '+id);assert.ok(t.includes('cd Falsify/tools/workbench'),'cwd in '+id);assert.match(t,/이미 설치해 쓰던 /);}
  assert.match(section('launch'),/main 브랜치에는 tools\/workbench가 없/);
});
check('setup is optional for browser-only and single-role use',()=>{
  const pre=strip((html.match(/<p><strong>준비물<\/strong>[\s\S]*?<\/p>/)||[''])[0]);
  for(const re of [/브라우저만/,/RED만, BLUE만, 검수만/,/내보낼 때만/])assert.match(pre,re);
  assert.doesNotMatch(pre,/준비물: Windows PC/);
  assert.match(html,/<h3>처음 한 번만 \(companion이 필요할 때\)<\/h3>/);
  assert.match(section('launch'),/macOS\/Linux는/);
});
check('harness JSON persistence risk is stated without promising redaction',()=>{
  const t=section('harness');
  assert.doesNotMatch(t,/저장 기능도 없습니다/);
  for(const s of ['localStorage','전체 기록 JSON 백업','비밀값','자동으로 가려 주지 않','비공개'])assert.ok(t.includes(s),'missing '+s);
});
check('After scope matches the current default text-path validator',()=>{
  const core=fs.readFileSync(path.join(dist,'document-red-core.js'),'utf8');
  const msg=(core.match(/fail\('(이번 범위에서는 [^']+)'\)/)||[])[1];
  assert.ok(msg,'core message');assert.ok(section('red').includes(msg),'exact core message in RED');
  for(const id of ['red','trouble'])for(const s of ['숫자 토큰','대괄호 인용','URL'])assert.ok(section(id).includes(s),id+' '+s);
  for(const re of [/정규식/,/의미적으로 막지 않/,/D1·D2/])assert.match(section('red'),re);
  assert.doesNotMatch(strip(html),/모든 (저자|DOI|서지)[^.]*(막|차단)/);
});
check('no thick side stripes',()=>{
  for(const m of css.matchAll(/border-(?:left|right)\s*:\s*(\d+)px/g))assert.ok(+m[1]<=1,'side stripe '+m[0]);
});
const quickPart=(from,to)=>{const q=html.slice(html.indexOf(' id="quick"'),html.indexOf(' id="toc"'));const a=q.indexOf(from);assert.ok(a>=0,'quick part '+from);const b=to?q.indexOf(to,a):q.length;return q.slice(a,b);};
check('companion and CLI login are scoped separately',()=>{
  const pre=strip((html.match(/<p><strong>준비물<\/strong>[\s\S]*?<\/p>/)||[''])[0]).split(/(?<=다\.) /);
  const exp=pre.find(s=>s.includes('내보낼 때만'));assert.ok(exp,'export sentence');
  assert.match(exp,/companion\(Python 3\.10 이상/);assert.match(exp,/CLI 로그인은 필요 없/);assert.doesNotMatch(exp,/Codex|Claude/);
  const cli=pre.find(s=>/Codex CLI 또는 Claude Code/.test(s));assert.ok(cli,'cli sentence');assert.match(cli,/모델을 실행할 때만/);
  const once=quickPart('<h3>처음 한 번만','<h3>매번');
  const login=[...once.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m=>strip(m[1])).find(s=>s.includes('codex login'));
  assert.ok(login&&login.startsWith('모델을 실행할 때만'),'CLI step optional');
  assert.doesNotMatch(section('image'),/Codex|Claude|codex login/);
  assert.match(strip((html.match(/<tr><td>Codex CLI[\s\S]*?<\/tr>/)||[''])[0]),/그림 교체에는 필요 없/);
});
check('browser-only scope does not overclaim PDF or model data flow',()=>{
  const q=strip(quickPart('<h3>매번','<h3>RED'));
  assert.doesNotMatch(q,/브라우저 안에서만/);
  for(const s of ['후보 After 편집','TXT류 내보내기','수동 JSON 교환','원본 PDF 바이트','companion','밖으로 전송'])assert.ok(q.includes(s),'missing '+s);
});
check('quick RED and BLUE each offer the manual JSON route',()=>{
  for(const [from,to] of [['<h3>RED','<h3>BLUE'],['<h3>BLUE','<h3>검수']]){
    const part=quickPart(from,to);
    assert.match(part,/<b class="ui">수동 JSON 교환 \(로컬 연결 없이\)<\/b>/,'manual route in '+from);
    assert.match(part,/href="#connect"/,'connect link in '+from);
  }
});
check('Python link is cross-platform and official Codex links are kept',()=>{
  assert.ok(hrefs.includes('https://www.python.org/downloads/'));assert.ok(!hrefs.some(h=>/python\.org\/downloads\/(windows|macos)/.test(h)));
  for(const h of ['https://learn.chatgpt.com/docs/codex/cli','https://learn.chatgpt.com/docs/auth'])assert.ok(hrefs.includes(h),'kept '+h);
});
console.log(JSON.stringify({passed,checks},null,2));
