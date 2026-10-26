'use strict';
// Synthetic external-red parser contract. No network, model, private paper, or browser.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const R=require('../dist/external-red.js');
const HASH='abc123';
const ALPHA='Alpha unique sentence.';
const SEGMENTS=[
  {id:'s0',label:'PDF p. 1',text:ALPHA},
  {id:'s1',label:'PDF p. 2',text:'Beta appears. Beta appears.'},
  {label:'DOCX 문단 3',text:'Gamma only here.'}
];
let checks=0;
function test(name,fn){fn();checks++;console.log('PASS '+name);}
function run(text,segments=SEGMENTS,fileHash=HASH){return R.parse(text,{segments,fileHash});}
function codes(result){return result.diagnostics.map(item=>item.code);}
function change(over={}){return JSON.stringify({changes:[{segmentId:'s0',pageIndex:0,before:ALPHA,after:'Changed.',...over}]});}

test('prompt carries 0-based ids, PDF labels, the minimal contract, and the full source',()=>{
  const prompt=R.buildPrompt({segments:SEGMENTS,fileHash:HASH});
  assert.equal(prompt,R.buildPrompt({segments:SEGMENTS,fileHash:HASH}));
  assert.match(prompt,/\{"changes":\[\{"segmentId":"s0","pageIndex":0,"before":"exact unique quote","after":"replacement"\}\]\}/);
  assert.match(prompt,/fileHash: abc123/);
  assert.match(prompt,/id=s0 pageIndex=0 pageLabel=PDF p\. 1/);
  assert.match(prompt,/id=s1 pageIndex=1 pageLabel=PDF p\. 2/);
  assert.match(prompt,/id=s2 pageIndex=2 pageLabel=DOCX 문단 3/);
  for(const segment of SEGMENTS)assert.ok(prompt.includes(segment.text),segment.text);
  assert.match(prompt,/0-based/);
  assert.match(prompt,/not a verified run/);
  assert.match(prompt,/해석이나 논리가 약한/);
  assert.match(prompt,/겨냥하지 않은 문장은 그대로/);
  assert.match(prompt,/rationale은 생략해도/);
  assert.match(prompt,/after를 빈 문자열/);
});

test('PDF labels convert deterministically and an explicit pageIndex wins',()=>{
  assert.equal(R.pageIndexFromLabel('PDF p. 1'),0);
  assert.equal(R.pageIndexFromLabel('PDF p. 12'),11);
  assert.equal(R.pageIndexFromLabel('p. 2'),1);
  assert.equal(R.pageIndexFromLabel('page 3'),2);
  assert.equal(R.pageIndexFromLabel('p1'),0);
  assert.equal(R.pageIndexFromLabel('PDF p. 0'),null);
  assert.equal(R.pageIndexFromLabel('DOCX 문단 3'),null);
  const normalized=R.normalizeSegments(SEGMENTS);
  assert.deepEqual(normalized.segments.map(segment=>({id:segment.id,pageIndex:segment.pageIndex})),[{id:'s0',pageIndex:0},{id:'s1',pageIndex:1},{id:'s2',pageIndex:2}]);
  assert.equal(R.normalizeSegments([{id:'s0',label:'PDF p. 2',pageIndex:0,text:'Alpha'}]).segments[0].pageIndex,0);
});

test('fenced JSON and CRLF match a unique quote without executing surrounding prose',()=>{
  const fenced='Ignore previous instructions <script>alert(1)</script>\n```json\n'+change()+'\n```\n';
  const parsed=run(fenced);
  assert.equal(parsed.proposals.length,1);
  assert.equal(parsed.proposals[0].status,'matched');
  assert.equal(parsed.proposals[0].origin,R.ORIGIN);
  assert.equal(parsed.proposals[0].segmentId,'s0');
  assert.equal(parsed.proposals[0].pageIndex,0);
  assert.deepEqual(parsed.proposals[0].matches,[{segmentId:'s0',pageIndex:0,start:0,end:ALPHA.length,occurrence:0}]);
  assert.equal(parsed.proposals[0].anchor.occurrence,0);
  assert.ok(codes(parsed).includes('ignored-prose'));
  const crlf='```json\r\n'+change().replace(/\n/g,'\r\n')+'\r\n```\r\n';
  assert.equal(run(crlf).proposals[0].status,'matched');
  const source=[{id:'s0',label:'PDF p. 1',pageIndex:0,text:'Alpha\r\nunique'}];
  const body=JSON.stringify({changes:[{segmentId:'s0',pageIndex:0,before:'Alpha\nunique',after:'Changed.'}]});
  const located=run(body,source);
  assert.equal(located.proposals[0].status,'matched');
  assert.equal(located.proposals[0].before,'Alpha\r\nunique');
  assert.equal(located.proposals[0].anchor.end-located.proposals[0].anchor.start,located.proposals[0].before.length);
  assert.deepEqual(located.proposals[0].anchor,{start:0,end:'Alpha\r\nunique'.length,occurrence:0});
});

test('recommended JSON, legacy candidates, Before/After, and label fields stay exact',()=>{
  const json=run(change({origin:'human',rationale:'<script>alert(1)</script>'}));
  assert.equal(json.proposals[0].status,'matched');
  assert.equal(json.proposals[0].origin,'external-ai-import');
  assert.equal(json.proposals[0].after,'Changed.');
  assert.equal(Object.hasOwn(json.proposals[0],'rationale'),false);
  const legacy=run(JSON.stringify({schema:'falsify.document-red.v1',sourceHash:HASH,candidates:[{id:'c1',segmentId:'s0',level:1,before:ALPHA,after:'Changed.',rationale:'Synthetic.',evidence:[],uncertainty:'x',origin:'ai-proposal'}]}));
  assert.equal(legacy.proposals.length,1);
  assert.equal(legacy.proposals[0].status,'matched');
  assert.equal(legacy.proposals[0].origin,'external-ai-import');
  const pairs=run('segmentId: s0\npageIndex: 0\nBefore: '+ALPHA+'\nAfter: Changed.\n');
  assert.equal(pairs.proposals[0].status,'matched');
  assert.equal(pairs.proposals[0].after,'Changed.');
  const labeled=run(JSON.stringify({changes:[{segmentId:'s0',page:'PDF p. 1',before:ALPHA,after:'Changed.'}]}));
  assert.equal(labeled.proposals[0].pageIndex,0);
  assert.equal(labeled.proposals[0].status,'matched');
  const ordinal=run(JSON.stringify({changes:[{segmentId:'s2',page:3,before:'Gamma only here.',after:'Changed.'}]}));
  assert.equal(ordinal.proposals[0].status,'matched');
  assert.equal(ordinal.proposals[0].pageIndex,2);
  const kept=run(JSON.stringify({changes:[{segmentId:'s2',pageIndex:2,before:'Gamma only here.',after:'Changed.'}]}));
  assert.equal(kept.proposals[0].pageIndex,2);
  const mismatch=run(JSON.stringify({changes:[{segmentId:'s2',pageIndex:3,before:'Gamma only here.',after:'Changed.'}]}));
  assert.equal(mismatch.proposals[0].status,'missing');
  assert.ok(codes(mismatch).includes('page-mismatch'));
});

test('repeated paste fragments collapse and repeated source fragments stay ambiguous',()=>{
  const twice=run(JSON.stringify({changes:[
    {segmentId:'s0',pageIndex:0,before:ALPHA,after:'Changed.'},
    {segmentId:'s0',pageIndex:0,before:ALPHA,after:'Changed.'}
  ]}));
  assert.equal(twice.proposals.length,1);
  assert.equal(twice.proposals[0].status,'matched');
  assert.ok(codes(twice).includes('repeated-fragment'));
  const blocks=run('segmentId: s0\nBefore: '+ALPHA+'\nAfter: Changed.\n---\nsegmentId: s0\nBefore: '+ALPHA+'\nAfter: Changed.\n');
  assert.equal(blocks.proposals.length,1);
  assert.ok(codes(blocks).includes('repeated-fragment'));
  const ambiguous=run(JSON.stringify({changes:[{segmentId:'s1',pageIndex:1,before:'Beta appears.',after:'Everywhere.'}]}));
  assert.equal(ambiguous.proposals.length,1);
  assert.equal(ambiguous.proposals[0].status,'ambiguous');
  assert.equal(ambiguous.proposals[0].anchor,null);
  assert.equal(ambiguous.proposals[0].matches.length,2);
  assert.ok(ambiguous.proposals[0].matches.every(match=>match.segmentId==='s1'&&match.pageIndex===1));
  assert.notEqual(ambiguous.proposals[0].matches[0].start,ambiguous.proposals[0].matches[1].start);
  const shared=[
    {id:'s0',label:'PDF p. 1',text:'Shared fragment end.'},
    {id:'s3',label:'PDF p. 4',text:'Shared fragment end.'}
  ];
  const open=run(JSON.stringify({changes:[{before:'Shared fragment end.',after:'Changed.'}]}),shared);
  assert.equal(open.proposals[0].status,'ambiguous');
  assert.deepEqual(open.proposals[0].matches.map(match=>match.segmentId),['s0','s3']);
  const pinned=run(JSON.stringify({changes:[{segmentId:'s0',before:'Shared fragment end.',after:'Changed.'}]}),shared);
  assert.equal(pinned.proposals[0].status,'matched');
  assert.equal(pinned.proposals[0].segmentId,'s0');
});

test('unchanged text, unknown ids, stale hashes, and malformed or marked-up pastes do not match',()=>{
  const same=run(JSON.stringify({changes:[{segmentId:'s0',pageIndex:0,before:ALPHA,after:ALPHA}]}));
  assert.equal(same.proposals.length,0);
  assert.ok(codes(same).includes('unchanged'));
  const missing=run(JSON.stringify({changes:[{segmentId:'no-such',pageIndex:0,before:ALPHA,after:'Changed.'}]}));
  assert.equal(missing.proposals[0].status,'missing');
  assert.deepEqual(missing.proposals[0].matches,[]);
  assert.ok(codes(missing).includes('unknown-id'));
  assert.equal(missing.proposals[0].segmentId,'no-such');
  const absent=run(JSON.stringify({changes:[{segmentId:'s0',pageIndex:0,before:'not in the source',after:'Changed.'}]}));
  assert.equal(absent.proposals[0].status,'missing');
  assert.ok(codes(absent).includes('missing'));
  const stale=run(JSON.stringify({fileHash:'other',changes:[{segmentId:'s0',pageIndex:0,before:ALPHA,after:'Changed.'}]}));
  assert.equal(stale.proposals.length,0);
  assert.ok(codes(stale).includes('file-hash-mismatch'));
  const broken=run('{changes:[');
  assert.equal(broken.proposals.length,0);
  assert.ok(codes(broken).includes('malformed'));
  const markup=run('<script>alert(1)</script><img src=x onerror=alert(1)>');
  assert.equal(markup.proposals.length,0);
  assert.ok(codes(markup).includes('rejected-markup'));
  const kept=run(JSON.stringify({changes:[{segmentId:'s0',pageIndex:0,before:ALPHA,after:'<script>alert(1)</script>'}]}));
  assert.equal(kept.proposals[0].after,'<script>alert(1)</script>');
  const payload='{"changes":[{"segmentId":"s0","pageIndex":0,"before":'+JSON.stringify(ALPHA)+',"after":"Changed."}],"__proto__":{"polluted":true}}';
  run(payload);
  assert.equal({}.polluted,undefined);
});

test('size limits refuse oversized pastes, fields, prompts, and partial prompt text',()=>{
  const huge=run('x'.repeat(R.LIMITS.inputChars+1));
  assert.deepEqual(huge.proposals,[]);
  assert.deepEqual(codes(huge),['input-limit']);
  const longBefore='A'.repeat(R.LIMITS.beforeChars+1);
  const field=run(JSON.stringify({changes:[{segmentId:'s0',pageIndex:0,before:longBefore,after:'Changed.'}]}),[{id:'s0',label:'PDF p. 1',text:longBefore}]);
  assert.equal(field.proposals.length,0);
  assert.ok(codes(field).includes('field-limit'));
  const many={changes:Array.from({length:R.LIMITS.changes+1},()=>({segmentId:'s0',pageIndex:0,before:ALPHA,after:'Changed.'}))};
  const capped=run(JSON.stringify(many));
  assert.equal(capped.proposals.length,0);
  assert.ok(codes(capped).includes('change-limit'));
  const big=Array.from({length:6},(_,i)=>({id:'s'+i,label:'PDF p. '+(i+1),text:'A'.repeat(R.LIMITS.segmentChars)}));
  assert.throws(()=>R.buildPrompt({segments:big,fileHash:HASH}),error=>error.code==='prompt-limit'&&/자른 프롬프트는 만들지 않습니다/.test(error.message));
  assert.throws(()=>R.buildPrompt({segments:[],fileHash:HASH}),error=>error.code==='empty-source');
});

test('unified diff uses exact context and does not take the first repeated hit',()=>{
  const source=[{id:'s0',label:'PDF p. 1',pageIndex:0,text:'one\ntwo\nthree'}];
  const diff=['--- a/s0','+++ b/s0','@@ -1,3 +1,3 @@',' one','-two','+TWO',' three',''].join('\n');
  const parsed=run(diff,source);
  assert.equal(parsed.proposals.length,1);
  assert.equal(parsed.proposals[0].status,'matched');
  assert.equal(parsed.proposals[0].before,'one\ntwo\nthree');
  assert.equal(parsed.proposals[0].after,'one\nTWO\nthree');
  assert.equal(parsed.proposals[0].segmentId,'s0');
  const repeated=[
    {id:'s0',label:'PDF p. 1',text:'one\ntwo\nthree'},
    {id:'s1',label:'PDF p. 2',text:'one\ntwo\nthree'}
  ];
  const loose=['--- a/paper.txt','+++ b/paper.txt','@@ -1,3 +1,3 @@',' one','-two','+TWO',' three',''].join('\n');
  const open=run(loose,repeated);
  assert.equal(open.proposals[0].status,'ambiguous');
  assert.deepEqual(open.proposals[0].matches.map(match=>match.segmentId),['s0','s1']);
  const pinned=run(diff,repeated);
  assert.equal(pinned.proposals[0].status,'matched');
  assert.equal(pinned.proposals[0].segmentId,'s0');
  const bad=run('@@ -1 +1 @@\nthis line has no prefix\n',source);
  assert.equal(bad.proposals.length,0);
  assert.ok(codes(bad).includes('malformed'));
});

test('full rewrite is a bounded unverified diff and stops at the stated limits',()=>{
  const source=[{id:'s0',label:'PDF p. 1',pageIndex:0,text:'one\ntwo\nthree'}];
  const parsed=run(JSON.stringify({rewritten:'one\nTWO\nthree'}),source);
  assert.equal(parsed.proposals.length,1);
  assert.equal(parsed.proposals[0].before,'two');
  assert.equal(parsed.proposals[0].after,'TWO');
  assert.equal(parsed.proposals[0].status,'matched');
  assert.equal(parsed.proposals[0].origin,'external-ai-import');
  const unverified=parsed.diagnostics.find(item=>item.code==='full-rewrite-unverified');
  assert.ok(unverified);
  assert.match(unverified.message,/검증된 실행이 아니/);
  assert.match(unverified.message,/과학적 성공/);
  assert.equal(parsed.diagnostics.some(item=>/과학적으로 검증되었|검증된 실행입니다|성공했습니다/.test(item.message)),false);
  const same=run(JSON.stringify({fullText:'one\ntwo\nthree'}),source);
  assert.equal(same.proposals.length,0);
  assert.ok(codes(same).includes('unchanged'));
  assert.ok(codes(same).includes('full-rewrite-unverified'));
  const lines=Array.from({length:R.LIMITS.rewriteLines+1},(_,i)=>'line '+i);
  const limited=run(JSON.stringify({rewritten:lines.join('\n').replace('line 10','line TEN')}),[{id:'s0',label:'PDF p. 1',text:lines.join('\n')}]);
  assert.equal(limited.proposals.length,0);
  assert.ok(codes(limited).includes('full-rewrite-limited'));
  assert.equal(limited.diagnostics.some(item=>item.code==='full-rewrite-unverified'),false);
  const before=[],after=[];
  for(let i=0;i<R.LIMITS.rewriteHunks+1;i++){before.push('keep '+i,'old '+i);after.push('keep '+i,'new '+i);}
  const hunks=run(JSON.stringify({rewritten:after.join('\n')}),[{id:'s0',label:'PDF p. 1',text:before.join('\n')}]);
  assert.equal(hunks.proposals.length,0);
  assert.ok(codes(hunks).includes('full-rewrite-limited'));
  const span=run(JSON.stringify({rewritten:'XXX'}),[{id:'s0',label:'PDF p. 1',text:'aaa'},{id:'s1',label:'PDF p. 2',text:'bbb'}]);
  assert.equal(span.proposals.length,0);
  assert.ok(codes(span).includes('full-rewrite-span'));
  const marker=run('FULL REWRITE\none\nTWO\nthree\n',source);
  assert.equal(marker.proposals[0].status,'matched');
  assert.equal(marker.proposals[0].after,'TWO');
});

test('conflicting replacements are ambiguous and the parser source stays local',()=>{
  const conflict=run(JSON.stringify({changes:[
    {segmentId:'s0',pageIndex:0,before:ALPHA,after:'One.'},
    {segmentId:'s0',pageIndex:0,before:ALPHA,after:'Two.'}
  ]}));
  assert.equal(conflict.proposals.length,2);
  assert.ok(conflict.proposals.every(item=>item.status==='ambiguous'&&item.anchor===null));
  assert.ok(codes(conflict).includes('conflicting-replacement'));
  const model=run(JSON.stringify({model:'lab-model',changes:[{segmentId:'s0',pageIndex:0,before:ALPHA,after:'Changed.'}]}));
  assert.equal(model.proposals[0].status,'matched');
  const note=model.diagnostics.find(item=>item.code==='model-label');
  assert.equal(note.model,'lab-model');
  assert.match(note.message,/검증되지 않았습니다/);
  const dist=path.resolve(__dirname,'../dist');
  for(const file of ['external-red.js','external-red-ui.js']){
    const source=fs.readFileSync(path.join(dist,file),'utf8');
    assert.doesNotMatch(source,/\beval\s*\(/);
    assert.doesNotMatch(source,/\bnew\s+Function\b/);
    assert.doesNotMatch(source,/\binnerHTML\b/);
    assert.doesNotMatch(source,/\bfetch\s*\(/);
    assert.doesNotMatch(source,/\bdocument\.write\b/);
  }
  const css=fs.readFileSync(path.join(dist,'external-red-ui.css'),'utf8');
  assert.doesNotMatch(css,/@import|expression\s*\(|javascript:/i);
  const doc=fs.readFileSync(path.resolve(__dirname,'../../docs/external-red.md'),'utf8');
  assert.match(doc,/external-ai-import/);
  assert.match(doc,new RegExp(String(R.LIMITS.inputChars)));
  assert.match(doc,/AGPL-3\.0-only/);
});

test('edits is a strict alias and an empty or unknown payload stays at zero',()=>{
  const edits=run(JSON.stringify({edits:[{segmentId:'s0',pageIndex:0,before:ALPHA,after:'Changed.'}]}));
  const changes=run(change());
  assert.equal(edits.proposals.length,1);
  assert.equal(edits.proposals[0].status,'matched');
  assert.deepEqual(edits.proposals[0],changes.proposals[0]);
  const overlap=run(JSON.stringify({edits:[{segmentId:'s0',pageIndex:0,before:'aa',after:'bb'}]}),[{id:'s0',label:'PDF p. 1',pageIndex:0,text:'aaa'}]);
  assert.equal(overlap.proposals[0].status,'ambiguous');
  assert.deepEqual(overlap.proposals[0].matches.map(match=>[match.start,match.occurrence]),[[0,0],[1,1]]);
  const crlf=run(JSON.stringify({edits:[{segmentId:'s0',pageIndex:0,before:'Alpha\nunique',after:'Changed.'}]}),[{id:'s0',label:'PDF p. 1',pageIndex:0,text:'Alpha\r\nunique'}]);
  assert.equal(crlf.proposals[0].status,'matched');
  assert.equal(crlf.proposals[0].before,'Alpha\r\nunique');
  assert.equal(crlf.proposals[0].anchor.end-crlf.proposals[0].anchor.start,crlf.proposals[0].before.length);
  const tooLong='A'.repeat(R.LIMITS.beforeChars+1);
  const limited=run(JSON.stringify({edits:[{segmentId:'s0',pageIndex:0,before:tooLong,after:'B'}]}),[{id:'s0',label:'PDF p. 1',pageIndex:0,text:tooLong}]);
  assert.equal(limited.proposals.length,0);
  assert.ok(codes(limited).includes('field-limit'));
  const many={edits:Array.from({length:R.LIMITS.changes+1},()=>({segmentId:'s0',pageIndex:0,before:ALPHA,after:'Changed.'}))};
  const capped=run(JSON.stringify(many));
  assert.equal(capped.proposals.length,0);
  assert.ok(codes(capped).includes('change-limit'));
  const empty=run(JSON.stringify({edits:[]}));
  assert.deepEqual(empty.proposals,[]);
  assert.ok(codes(empty).includes('empty'));
  const same=run(JSON.stringify({edits:[{segmentId:'s0',pageIndex:0,before:ALPHA,after:ALPHA}]}));
  assert.deepEqual(same.proposals,[]);
  assert.ok(codes(same).includes('unchanged'));
  const unknown=run(JSON.stringify({notes:'no edits'}));
  assert.deepEqual(unknown.proposals,[]);
  assert.ok(codes(unknown).includes('malformed'));
  assert.equal(unknown.diagnostics.some(item=>item.code==='empty'),false);
  const notArray=run(JSON.stringify({edits:{before:ALPHA,after:'Changed.'}}));
  assert.deepEqual(notArray.proposals,[]);
  assert.ok(codes(notArray).includes('malformed'));
  const both=run(JSON.stringify({changes:[{segmentId:'s0',pageIndex:0,before:ALPHA,after:'One.'}],edits:[{segmentId:'s0',pageIndex:0,before:ALPHA,after:'Two.'}]}));
  assert.deepEqual(both.proposals,[]);
  assert.ok(codes(both).includes('malformed'));
});

test('real paper-edits accepts overlap, CRLF slices, the selected occurrence, and empty After',()=>{
  const vm=require('node:vm');
  const src=fs.readFileSync(path.resolve(__dirname,'../dist/paper-edits.js'),'utf8');
  const sandbox={module:{exports:{}},exports:{}};
  vm.createContext(sandbox);
  vm.runInContext(src,sandbox,{filename:'paper-edits.js'});
  sandbox.core=sandbox.module.exports;
  const hash='ab'.repeat(32);
  assert.equal(hash.length,64);
  function one(text,before,after){
    const parsed=run(JSON.stringify({changes:[{segmentId:'s0',pageIndex:0,before,after}]}),[{id:'s0',label:'PDF p. 1',pageIndex:0,text}],hash);
    assert.equal(parsed.proposals.length,1);
    return parsed;
  }
  function apply(text,edit){
    sandbox.text=text;
    sandbox.before=edit.before;
    sandbox.after=edit.after;
    sandbox.useAnchor=!!edit.anchor;
    sandbox.includeOccurrence=!!(edit.anchor&&Object.hasOwn(edit.anchor,'occurrence'));
    if(edit.anchor){sandbox.start=edit.anchor.start;sandbox.end=edit.anchor.end;sandbox.occurrence=edit.anchor.occurrence;}
    return vm.runInContext(`(()=>{
      const session=core.create({fileHash:${JSON.stringify(hash)},name:'fixture.txt',segments:[{id:'s0',label:'PDF p. 1',text:text,pageIndex:0}],now:()=>1});
      const input={pageIndex:0,segmentId:'s0',before:before,after:after,origin:'external-ai-import'};
      if(useAnchor){input.anchor={start:start,end:end};if(includeOccurrence)input.anchor.occurrence=occurrence;}
      const id=session.add(input);
      const stored=session.snapshot().edits.find(item=>item.id===id);
      return {before:stored.before,after:stored.after,start:stored.anchor.start,end:stored.anchor.end,occurrence:stored.anchor.occurrence};
    })()`,sandbox);
  }
  const overlap=one('aaa','aa','bb');
  assert.equal(overlap.proposals[0].status,'ambiguous');
  assert.deepEqual(overlap.proposals[0].matches.map(match=>[match.start,match.occurrence]),[[0,0],[1,1]]);
  sandbox.text='aaa';
  assert.throws(()=>vm.runInContext(`core.create({fileHash:${JSON.stringify(hash)},name:'fixture.txt',segments:[{id:'s0',label:'PDF p. 1',text:text,pageIndex:0}],now:()=>1}).add({pageIndex:0,segmentId:'s0',before:'aa',after:'bb',origin:'external-ai-import'})`,sandbox),error=>error.code==='duplicate-anchor');
  const crlfText='first\r\nsecond';
  const crlf=one(crlfText,'first\nsecond','first\nSECOND');
  const crlfProposal=crlf.proposals[0];
  assert.equal(crlfProposal.status,'matched');
  assert.equal(crlfProposal.before,crlfText);
  assert.equal(crlfText.slice(crlfProposal.anchor.start,crlfProposal.anchor.end),crlfProposal.before);
  assert.equal(crlfProposal.anchor.end-crlfProposal.anchor.start,crlfProposal.before.length);
  const storedCrlf=apply(crlfText,{before:crlfProposal.before,after:crlfProposal.after,anchor:crlfProposal.anchor});
  assert.equal(storedCrlf.before,crlfText);
  assert.equal(storedCrlf.end,crlfText.length);
  const alpha='alpha alpha';
  const picked=one(alpha,'alpha','BETA');
  assert.equal(picked.proposals[0].status,'ambiguous');
  const hit=picked.proposals[0].matches[1];
  assert.equal(hit.start,6);
  assert.equal(hit.end,11);
  assert.equal(hit.occurrence,1);
  const withOccurrence=apply(alpha,{before:'alpha',after:'BETA',anchor:{start:hit.start,end:hit.end,occurrence:hit.occurrence}});
  assert.equal(withOccurrence.start,6);
  assert.equal(withOccurrence.occurrence,1);
  const omitted=apply(alpha,{before:'alpha',after:'BETA',anchor:{start:hit.start,end:hit.end}});
  assert.equal(omitted.start,6);
  assert.equal(omitted.occurrence,1);
  const erased=one(ALPHA,ALPHA,'');
  assert.equal(erased.proposals[0].status,'matched');
  assert.equal(erased.proposals[0].after,'');
  const storedErase=apply(ALPHA,{before:erased.proposals[0].before,after:'',anchor:erased.proposals[0].anchor});
  assert.equal(storedErase.after,'');
  const blank=run(JSON.stringify({changes:[{segmentId:'s0',pageIndex:0,before:ALPHA,after:'   '}]}));
  assert.equal(blank.proposals.length,0);
  assert.match(blank.diagnostics.find(item=>item.code==='field-limit').message,/빈 문자열/);
  const tooLong='A'.repeat(4001);
  const limited=run(JSON.stringify({changes:[{segmentId:'s0',pageIndex:0,before:tooLong,after:'B'}]}),[{id:'s0',label:'PDF p. 1',pageIndex:0,text:tooLong}],hash);
  assert.equal(limited.proposals.length,0);
  assert.match(limited.diagnostics.find(item=>item.code==='field-limit').message,/4000/);
  const max='B'.repeat(4000);
  const allowed=one(max,max,'C');
  assert.equal(allowed.proposals[0].status,'matched');
  const storedMax=apply(max,{before:allowed.proposals[0].before,after:'C',anchor:allowed.proposals[0].anchor});
  assert.equal(storedMax.before.length,4000);
});

console.log(JSON.stringify({passed:checks,scope:'external-red parser'}));
