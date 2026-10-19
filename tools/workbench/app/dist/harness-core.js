(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyHarness=api;})(globalThis,function(){
  'use strict';
  const keys=['id','instructions','maxCalls','name','role','schema','version'];
  // Built-in CLI executors. Model lists are input suggestions only, never proof that an account can use a model.
  const CLI=Object.freeze({codex:Object.freeze({name:'Codex CLI',defaultModel:'gpt-6.1-sol',models:Object.freeze(['gpt-6.1-sol','gpt-6-astra','gpt-6-luna'])}),claude:Object.freeze({name:'Claude Code CLI',defaultModel:'claude-opus-5-5',models:Object.freeze(['claude-opus-5-5','opus','sonnet','haiku'])})});
  const EFFORTS=Object.freeze(['low','medium','high']),DEFAULT_EFFORT='medium',MODEL=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
  const validModel=m=>typeof m==='string'&&MODEL.test(m);
  // Adapter v1 for built-in CLIs: {type:'codex'|'claude',model?,effort?}. The legacy {type:'codex'} stays valid and unchanged.
  function cliFields(a){if(Object.keys(a).some(k=>!['type','model','effort'].includes(k))||'model' in a&&!validModel(a.model)||'effort' in a&&!EFFORTS.includes(a.effort))throw Error(CLI[a.type].name+' adapter: model은 영문·숫자로 시작하는 ASCII ID(._:- 포함 최대 120자), effort는 low / medium / high');}
  // Existing stdio/http transports. A wrapper target reuses exactly these shapes, so a wrapper never nests another wrapper.
  function transport(a){
    if(a.type==='stdio'&&(Object.keys(a).sort().join()!=='args,executable,type'||typeof a.executable!=='string'||a.executable.includes('\0')||! /^(?:[A-Za-z]:[\\/]|\/)/.test(a.executable)||!Array.isArray(a.args)||a.args.length>32||a.args.some(x=>typeof x!=='string'||x.length>2000||x.includes('\0'))))throw Error('stdio: executable 절대 경로, args 문자열 배열');
    if(a.type==='http'){let u;try{u=new URL(a.url);}catch{throw Error('외부 adapter URL 오류');}if(Object.keys(a).sort().join()!=='type,url'||typeof a.url!=='string'||a.url.length>2000||u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error('외부 adapter는 자격증명·쿼리 없는 HTTPS만 허용');}}
  // Wrapper adapter v1: an existing program behind a pure, deterministic input/output profile. The browser checks shape and
  // pointer/map syntax only; the local backend checks the executable and runs it. Messages are fixed text and never echo user values.
  const WRAPPER_ERRORS=Object.freeze({shape:'wrapper: type·target·input·output 네 필드만 허용합니다. 알 수 없는 필드를 지우세요.',size:'wrapper 설정은 직렬화 32,000자 이내여야 합니다. 매핑을 줄이세요.',
    target:'wrapper target은 stdio(executable 절대 경로와 args 배열) 또는 http(HTTPS URL) 형태만 허용합니다. wrapper 중첩은 지원하지 않습니다.',
    input:'input.mode는 invocation / prompt / template / files 중 하나이며 files는 stdio target에서만 씁니다. template은 template 모드에서만 넣으세요.',
    output:'output.source는 stdout 또는 file(stdio 전용), format은 json 또는 json-fence입니다. path·map·stageMaps 외 필드는 지우세요.',
    placeholder:'args의 {input} · {prompt} · {schema} · {output}은 다른 글자와 섞지 말고 인자 하나 전체로 쓰세요.',
    filesOnly:'args의 {input} · {prompt} · {schema}는 input.mode가 files일 때만 씁니다. {output}은 모든 모드에서 쓸 수 있습니다.',
    pointer:'JSON pointer는 비어 있거나 /로 시작해야 하며, ~는 ~0 또는 ~1로만 씁니다.',proto:'__proto__ · constructor · prototype 키와 경로는 쓸 수 없습니다.',
    directive:'매핑 지시어는 {"$from":"/경로"} 또는 {"$each":"/배열","template":…} 정확한 형태만 허용합니다. $로 시작하는 다른 키는 지우세요.',
    mapSize:'매핑은 깊이 20단계, 항목 1,000개 이내여야 합니다.',stage:'stageMaps 키는 scan / selection / red / blue만 허용합니다.',
    missing:'출력에 매핑 경로가 없습니다. 샘플 출력이나 경로를 확인하세요. 없는 값을 기본값으로 채우지 않습니다.',notArray:'$each 경로가 배열을 가리키지 않습니다. 경로를 확인하세요.',
    parse:'출력을 JSON으로 읽지 못했습니다. format이 json이면 출력 전체가 JSON 값 하나여야 합니다.',
    fence:'json-fence는 출력 전체가 ```json 코드 블록 하나일 때만 읽습니다. 앞뒤 설명 문장이 있는 Markdown은 지원하지 않습니다.',
    outputSize:'출력은 150,000바이트 이내여야 합니다.',resultSize:'매핑 결과가 너무 큽니다. $each 범위를 줄이세요.'});
  const WRAPPER_STAGES=Object.freeze(['scan','selection','red','blue']),WRAPPER_INPUTS=Object.freeze(['invocation','prompt','template','files']),UNSAFE=new Set(['__proto__','constructor','prototype']);
  // Invocation outputSchema top-level array/summary key -> stage, the same selection the backend makes for stageMaps.
  const STAGE_KEYS=Object.freeze({summary:'scan',targets:'selection',candidates:'red',findings:'blue'});
  // null unless exactly one stage key is present, the same rule as the backend stage_of.
  const stageForSchema=s=>{const p=s&&typeof s==='object'&&s.properties;if(!plain(p))return null;const found=Object.keys(STAGE_KEYS).filter(k=>Object.hasOwn(p,k));return found.length===1?STAGE_KEYS[found[0]]:null;};
  function fail(code){const e=Error(WRAPPER_ERRORS[code]);e.code=code;throw e;}
  const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
  const only=(o,allowed,required)=>plain(o)&&Object.keys(o).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(o,k));
  // RFC 6901: '' is the whole value; tokens unescape ~1 then ~0; array indexes are canonical decimals; prototype keys are refused.
  function pointer(p){if(typeof p!=='string'||p.length>2000||p&&p[0]!=='/')fail('pointer');if(!p)return [];
    return p.slice(1).split('/').map(t=>{if(/~(?![01])/.test(t))fail('pointer');const k=t.replace(/~1/g,'/').replace(/~0/g,'~');if(UNSAFE.has(k))fail('proto');return k;});}
  function resolve(v,p){let cur=v;for(const k of pointer(p)){if(Array.isArray(cur)){if(!/^(?:0|[1-9]\d*)$/.test(k)||Number(k)>=cur.length)fail('missing');cur=cur[Number(k)];}else if(plain(cur)&&Object.hasOwn(cur,k))cur=cur[k];else fail('missing');}return cur;}
  function checkMap(t,depth=0,seen={n:0}){if(depth>20||++seen.n>1000)fail('mapSize');
    if(Array.isArray(t)){for(const x of t)checkMap(x,depth+1,seen);return;}
    if(!plain(t)){if(t===null||typeof t==='string'||typeof t==='boolean'||typeof t==='number'&&Number.isFinite(t))return;fail('directive');}
    const ks=Object.keys(t);
    if(Object.hasOwn(t,'$from')){if(ks.length!==1)fail('directive');pointer(t.$from);return;}
    if(Object.hasOwn(t,'$each')){if(ks.length!==2||!Object.hasOwn(t,'template'))fail('directive');pointer(t.$each);checkMap(t.template,depth+1,seen);return;}
    for(const k of ks){if(UNSAFE.has(k))fail('proto');if(k[0]==='$')fail('directive');checkMap(t[k],depth+1,seen);}}
  const own=(o,k,v)=>Object.defineProperty(o,k,{value:v,enumerable:true,writable:true,configurable:true});
  // One budget unit per template node and per copied output node, as the backend _spend counts.
  function spend(v,seen){if(++seen.n>100000)fail('resultSize');if(Array.isArray(v))for(const x of v)spend(x,seen);else if(plain(v))for(const k of Object.keys(v))spend(v[k],seen);}
  // Pure template application: $from copies, $each maps elements relative to each element, everything else is a literal.
  function applyMap(t,src,seen){
    if(plain(t)&&Object.hasOwn(t,'$from')){const v=resolve(src,t.$from);spend(v,seen);return JSON.parse(JSON.stringify(v));}
    if(plain(t)&&Object.hasOwn(t,'$each')){const list=resolve(src,t.$each);if(!Array.isArray(list))fail('notArray');if(list.length>1000)fail('resultSize');spend(null,seen);return list.map(x=>applyMap(t.template,x,seen));}
    spend(null,seen);
    if(Array.isArray(t))return t.map(x=>applyMap(x,src,seen));
    if(!plain(t))return t;
    const out={};for(const k of Object.keys(t))own(out,k,applyMap(t[k],src,seen));return out;}
  function checkOutput(o,targetType){
    if(!only(o,['source','format','path','map','stageMaps'],['source','format'])||!['stdout','file'].includes(o.source)||!['json','json-fence'].includes(o.format)||o.source==='file'&&targetType&&targetType!=='stdio')fail('output');
    if(Object.hasOwn(o,'path'))pointer(o.path);
    if(Object.hasOwn(o,'map'))checkMap(o.map);
    if(Object.hasOwn(o,'stageMaps')){if(!plain(o.stageMaps))fail('stage');for(const k of Object.keys(o.stageMaps)){if(!WRAPPER_STAGES.includes(k))fail('stage');checkMap(o.stageMaps[k]);}}}
  function validateWrapper(a){
    if(!only(a,['type','target','input','output'],['type','target','input','output'])||a.type!=='wrapper')fail('shape');
    let text;try{text=JSON.stringify(a);}catch{fail('shape');}if(text.length>32000)fail('size');
    const t=a.target;if(!plain(t)||!['stdio','http'].includes(t.type))fail('target');try{transport(t);}catch{fail('target');}
    const i=a.input;if(!only(i,['mode','template'],['mode'])||!WRAPPER_INPUTS.includes(i.mode)||(i.mode==='template')!==Object.hasOwn(i,'template')||i.mode==='files'&&t.type!=='stdio')fail('input');
    if(i.mode==='template')checkMap(i.template);
    if(t.type==='stdio'){if(i.mode!=='files'&&t.args.some(x=>['{input}','{prompt}','{schema}'].includes(x)))fail('filesOnly');
      if(t.args.some(x=>!['{input}','{prompt}','{schema}','{output}'].includes(x)&&/\{(?:input|prompt|schema|output)\}/.test(x)))fail('placeholder');}
    checkOutput(a.output,t.type);
    return JSON.parse(text);}
  // JSON.parse turns 1e400 into Infinity, so the parsed value is walked; the backend rejects the same literals.
  function finite(v){if(typeof v==='number'&&!Number.isFinite(v))fail('parse');if(Array.isArray(v))for(const x of v)finite(x);else if(plain(v))for(const k of Object.keys(v))finite(v[k]);}
  // Same rule as the backend FENCE: JSON whitespace around one block, newline before the closing fence, no embedded fence, no BOM.
  function parseOutput(text,format){if(new TextEncoder().encode(text).length>150000)fail('outputSize');
    if(format==='json-fence'){const m=/^[ \t\r\n]*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t\r\n]*$/.exec(text);if(!m||m[1].includes('```'))fail('fence');text=m[1];}
    let v;try{v=JSON.parse(text);}catch{fail('parse');}finite(v);return v;}
  // Browser parity helper: raw text is parsed by format, output.path applies before the map, and an explicit known stage selects its
  // stageMap. An unknown stage or missing stageMap falls back to output.map, then identity. The backend result stays authoritative.
  function transformWrapperOutput(value,output,stage){checkOutput(output);
    let v;if(typeof value==='string')v=parseOutput(value,output.format);else{finite(value);v=JSON.parse(JSON.stringify(value));}
    if(Object.hasOwn(output,'path'))v=resolve(v,output.path);
    const map=typeof stage==='string'&&WRAPPER_STAGES.includes(stage)&&plain(output.stageMaps)&&Object.hasOwn(output.stageMaps,stage)?output.stageMaps[stage]:output.map;
    return map===undefined?v:applyMap(map,v,{n:0});}
  function validate(h,role){
    if(!h||typeof h!=='object'||keys.some(k=>!Object.hasOwn(h,k))||Object.keys(h).some(k=>!keys.includes(k)&&!['adapter','settings'].includes(k))||h.schema!=='falsify.harness.v1'||!['red','blue'].includes(h.role)||role&&h.role!==role)throw Error('harness 스키마·역할·허용 필드를 확인하세요.');
    for(const k of ['id','version'])if(typeof h[k]!=='string'||! /^[A-Za-z0-9_.-]{1,80}$/.test(h[k]))throw Error('ID/버전: 영문·숫자·._- 1–80자');
    for(const [k,n] of [['name',120],['instructions',8000]])if(typeof h[k]!=='string'||!h[k].trim()||h[k].length>n||h[k].includes('\0'))throw Error('이름/지침 길이 제한 초과');
    if(!Number.isInteger(h.maxCalls)||h.maxCalls<1||h.maxCalls>32)throw Error('호출 한도는 1–32회입니다.');
    if(Object.hasOwn(h,'adapter')){const a=h.adapter;if(!a||typeof a!=='object'||Array.isArray(a)||!['codex','claude','stdio','http','wrapper'].includes(a.type))throw Error('adapter: codex / claude / stdio / http / wrapper');
      if(Object.hasOwn(CLI,a.type))cliFields(a);
      if(a.type==='wrapper')validateWrapper(a);else transport(a);}
    if(Object.hasOwn(h,'settings')&&(!h.settings||typeof h.settings!=='object'||Array.isArray(h.settings)||JSON.stringify(h.settings).length>32000))throw Error('settings는 JSON 객체 32,000자 이내');
    return JSON.parse(JSON.stringify(h));
  }
  function sorted(v){return Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;}
  const canonical=h=>JSON.stringify(sorted(validate(h)));
  async function hash(h){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(h))))).map(x=>x.toString(16).padStart(2,'0')).join('');}
  const builtin=role=>validate({schema:'falsify.harness.v1',id:'builtin-'+role,name:'기본 '+role.toUpperCase(),version:'1',role,instructions:'Focus on explicit internal contradictions and quote the exact supporting evidence.',maxCalls:8});
  const cliCapable=h=>!h.adapter||Object.hasOwn(CLI,h.adapter.type);
  function cliSelection(s){if(!s||typeof s!=='object'||!Object.hasOwn(CLI,s.type))throw Error('CLI는 codex 또는 claude만 선택할 수 있습니다.');const out={type:s.type,model:s.model,effort:s.effort};cliFields(out);return out;}
  // A role selection never edits a stored config: it yields a new config with its own content hash. Custom stdio/http executors are returned untouched.
  function withCli(h,s){const base=validate(h);if(!s||!cliCapable(base))return base;return validate({...base,adapter:cliSelection(s)});}
  // Brokers without cliSelection only accept the legacy Codex adapter.
  const needsCliCaps=h=>!!h?.adapter&&(h.adapter.type==='claude'||Object.hasOwn(h.adapter,'model')||Object.hasOwn(h.adapter,'effort'));
  function derivedFrom(h,base){if(!cliCapable(h)||!cliCapable(base))return false;const strip=x=>{const c={...x};delete c.adapter;return canonical(c);};return strip(h)===strip(base);}
  // Record kinds are derived from stored fields only, so legacy records are never rewritten. Only a local broker run counts as an
  // execution of its harness; manual and imported records keep the requested harness, which is not proof that it ran.
  const ORIGINS=Object.freeze({executed:'로컬 broker 실행',manual:'수동 응답 · 실행 미검증',imported:'가져온 기록 · 출처 미검증'});
  const origin=provenance=>provenance==='local-codex'?'executed':provenance==='manual-unverified'?'manual':'imported';
  // executed: the broker reported the stored harness hash AND a well-formed harness canonically equal to the stored one (checked when
  // recorded, re-derived here so a legacy record with a copied hash but another definition stays unknown); requested: selected, never attested.
  function brokerHarness(r){try{return r.response?.harnessHash===r.harnessHash&&canonical(r.response.harness)===canonical(r.harness);}catch{return false;}}
  function attestation(r){const o=origin(r.provenance);return o==='executed'?(brokerHarness(r)?'executed':'unknown'):o==='manual'?'requested':'unknown';}
  const HARNESS_ROLE=Object.freeze({executed:'실행 harness',requested:'요청 harness',unknown:'실행 미확인 harness'});
  const STATUS=Object.freeze({ok:'완료',abstain:'유보',refusal:'거절',unknown:'상태 미상'});
  const count=x=>Number.isSafeInteger(x)&&x>=0?x:null;
  // Coverage counts only for a local broker run. RED coverage.complete=false means the app stopped at a chunk read, so its final
  // synthesis call never ran even when every chunk was read; BLUE coverage carries no synthesis flag. A valid call count is kept
  // even when the completeness flag is missing; an absent or invalid count stays null (unknown), never zero.
  function outcome(role,res,provenance){const status=Object.hasOwn(STATUS,res?.status)?res.status:'unknown',c=res?.coverage,none={status,complete:null,synthesis:null,chunks:null,completedChunks:null,calls:null};
    if(origin(provenance)!=='executed')return {...none,verified:false};
    if(!c||typeof c!=='object')return {...none,verified:true};
    if(typeof c.complete!=='boolean')return {...none,verified:true,calls:count(c.calls)};
    return {status,verified:true,complete:c.complete,synthesis:role==='red'?c.complete:null,chunks:count(c.chunks),completedChunks:count(c.completedChunks),calls:count(c.calls)};}
  function outcomeText(role,res,provenance){const x=outcome(role,res,provenance),parts=['결과 '+STATUS[x.status]];
    if(!x.verified)parts.push((origin(provenance)==='manual'?'수동 응답':'가져온 기록')+'이라 실행·검토 범위 미검증');
    else if(x.complete===null){parts.push('검토 범위 보고 없음');if(x.calls!==null)parts.push('앱 adapter 호출 '+x.calls+'회');}
    else{parts.push(x.complete?'전체 추출 텍스트 전달 완료':'검토 범위 미완료');if(x.chunks>1&&x.completedChunks!==null)parts.push('분할 읽기 '+x.completedChunks+' / '+x.chunks);
      if(x.synthesis!==null)parts.push(x.synthesis?'후보 종합 단계 실행':'후보 종합 단계 미실행');if(x.calls!==null)parts.push('앱 adapter 호출 '+x.calls+'회');}
    return parts.join(' · ');}
  // A final snapshot is not another execution; app adapter calls are summed from broker reports only (user harness internals are separate).
  // Executions without a valid reported count are tallied in callsUnknown, so a missing report never reads as zero calls.
  function counts(runs){const c={executed:0,manual:0,imported:0,snapshots:0,calls:0,callsUnknown:0};for(const r of runs){if(r.snapshotOf){c.snapshots++;continue;}const o=origin(r.provenance);c[o]++;if(o==='executed'){const n=outcome(r.role,r.response,r.provenance).calls;if(n===null)c.callsUnknown++;else c.calls+=n;}}return c;}
  // Known calls are a lower bound when some executions did not report a count; zero is shown only when every execution reported one.
  const callsText=(calls,unknown,executions)=>!unknown?'앱 adapter 호출 '+calls+'회':unknown>=executions?'앱 adapter 호출 수 미보고 '+unknown+'건':'앱 adapter 호출 '+calls+'회 이상, 호출 수 미보고 '+unknown+'건';
  // Groups never mix executed, manual and imported records, so each denominator counts one kind. Means use attested executions only.
  function summarize(runs,reviews){
    const groups=new Map();
    for(const r of runs){const o=origin(r.provenance),a=attestation(r),key=[r.role,o,a,r.harnessHash,r.model,r.sourceHash,r.level||'-',r.maxCalls].join('|');
      if(!groups.has(key))groups.set(key,{role:r.role,origin:o,attestation:a,harness:r.harness,hash:r.harnessHash,model:r.model,sourceHash:r.sourceHash,level:r.level,maxCalls:r.maxCalls,runs:0,reviewed:0,scores:[],uncertain:0,manual:0,statuses:{ok:0,abstain:0,refusal:0,unknown:0},incomplete:0,calls:0,callsUnknown:0});
      const g=groups.get(key),x=outcome(r.role,r.response,r.provenance);g.runs++;if(r.provenance!=='local-codex')g.manual++;g.statuses[x.status]++;if(x.complete===false)g.incomplete++;if(x.calls!==null)g.calls+=x.calls;else if(o==='executed')g.callsUnknown++;
      const latest=reviews.filter(v=>v.runId===r.id).at(-1);if(latest){g.reviewed++;if(latest.verdict==='uncertain')g.uncertain++;if(latest.score!==null&&latest.verdict!=='uncertain')g.scores.push(latest.score);}
    }
    return [...groups.values()].map(g=>({...g,mean:g.attestation==='executed'&&g.scores.length?g.scores.reduce((a,b)=>a+b,0)/g.scores.length:null}));
  }
  return {validate,canonical,hash,builtin,summarize,CLI,EFFORTS,DEFAULT_EFFORT,MODEL,validModel,cliCapable,cliSelection,withCli,needsCliCaps,derivedFrom,ORIGINS,origin,attestation,HARNESS_ROLE,STATUS,outcome,outcomeText,counts,callsText,validateWrapper,transformWrapperOutput,WRAPPER_ERRORS,WRAPPER_STAGES,WRAPPER_INPUTS,stageForSchema};
});
