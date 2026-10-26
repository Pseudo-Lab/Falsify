// AI-drafted wrapper connection profile + manual span mapping for unstructured sample output, inside the wrapper builder.
// One explicit click sends the pasted README / examples / sample to the local companion, which asks the logged-in Claude Code
// CLI (no tools, no MCP; Codex is refused) for a DRAFT. Nothing here registers, installs or runs the proposed program; approval only fills the builder fields, and the
// synthetic test and manual mapping read the pasted sample text only. Shown text is fixed copy or values set via textContent.
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else{root.FalsifyHarnessProfile=api;api.watch(root.document);}})(globalThis,function(root){
  'use strict';
  const core=()=>root.FalsifyHarness||(typeof require==='function'?require('./harness-core.js'):null);
  const wrapper=()=>root.FalsifyHarnessWrapper||(typeof require==='function'?require('./harness-wrapper.js'):null);
  const REQUEST='falsify.harness-profile-proposal-request.v1',SCHEMA='falsify.harness-profile-proposal.v1',ROUTE='/api/harness/profile/propose';
  const LIMITS=Object.freeze({readme:24000,examples:12000,sample:12000}),INPUTS=Object.freeze(['role','readme','examples','sample']);
  const PROVIDERS=Object.freeze(['claude']),STATUSES=Object.freeze(['proposed','unknown','manual_mapping']),FIELDS=Object.freeze(['command','input','output','mapping']),SOURCES=Object.freeze(['readme','examples','sample']);
  const DOWNGRADES=Object.freeze({unstructured_output:'샘플 출력이 JSON 하나 / ```json 블록 하나가 아닙니다.',sample_not_declared_format:'붙여넣은 샘플이 제안한 출력 형식으로 읽히지 않습니다.',
    missing_executable:'실행 파일이 확인되지 않았습니다.',missing_command_evidence:'실행 명령을 뒷받침하는 원문 인용이 없습니다.',missing_output_evidence:'출력 형식을 뒷받침하는 샘플 출력 인용이 없습니다.',
    missing_sample:'샘플 출력이 없어 출력 형식을 확인하지 못했습니다.',sample_mapping_failed:'제안한 매핑의 경로가 샘플에 없습니다.',
    sample_schema_mismatch:'제안한 매핑을 샘플에 적용한 결과가 해당 단계 스키마(필드 · 형식 · status 값)와 맞지 않습니다.',ungrounded_command:'실행 파일 이름이나 인자가 README · 명령 예시에 그대로 나오지 않습니다.',
    missing_input_evidence:'입력 전달 방식을 뒷받침하는 README · 명령 예시 인용이 없습니다.',missing_mapping_evidence:'매핑을 뒷받침하는 원문 인용이 없습니다.',input_template_unresolved:'입력 template의 경로가 실제 invocation에 없습니다.'});
  const WARNINGS=Object.freeze({executable_not_absolute:'실행 파일이 절대 경로가 아닙니다. 승인 전에 내 PC의 실제 절대 경로로 바꾸세요.',shell_interpreter:'실행 파일이 shell(cmd · powershell · bash 등)입니다. 인자로 임의 명령을 실행할 수 있으니 직접 확인하세요.',
    shell_metacharacters:'인자에 ; & | < > ` $ 같은 shell 기호가 있습니다. shell 없이 문자 그대로 전달됩니다.',install_or_delete_command:'설치 · 다운로드 · 삭제처럼 보이는 단어가 있습니다. README의 명령을 그대로 믿지 말고 직접 확인하세요.'});
  const STATUS_TEXT=Object.freeze({proposed:'초안 제안됨 · 검토 후 승인할 수 있습니다',unknown:'판단 불가 · 근거가 부족해 승인할 수 없습니다',manual_mapping:'수동 매핑 필요 · 자동 연결 프로필로 확정하지 않았습니다. 샘플이 JSON이 아니면 아래 수동 매핑을 쓰세요'});
  const ERRORS=Object.freeze({invalid_request:'요청 형식이나 길이 제한(README 24,000자 · 명령 예시 12,000자 · 샘플 12,000자)을 확인하세요. README나 명령 예시 중 하나는 필요합니다.',
    companion_busy:'companion이 다른 작업 중입니다. 끝난 뒤 다시 누르세요. 자동으로 다시 시도하지 않습니다.',cli_login_required:'선택한 CLI가 설치 · 로그인되어 있지 않습니다. 로그인한 뒤 다시 누르세요.',
    model_timeout:'모델 응답이 시간 안에 오지 않았습니다. 입력을 줄이거나 다시 누르세요.',model_tool_violation:'모델이 도구를 쓰려 해 결과를 버렸습니다.',unsupported_provider:'AI 초안은 Claude Code CLI만 지원합니다. Codex로는 요청하지 않으며 다른 CLI로 바꿔 보내지도 않습니다.',
    model_failed:'모델 호출이 실패했습니다. CLI 상태를 확인한 뒤 다시 누르세요.',invalid_proposal:'모델 답이 초안 계약(근거 인용의 원문 일치 · 매핑 문법)을 통과하지 못해 버렸습니다. 다시 요청하거나 직접 매핑하세요.'});
  const MSG=Object.freeze({provider:'AI 초안은 Claude Code CLI만 지원합니다. Codex 요청은 보내지 않습니다.',input:'README 또는 명령 예시를 붙여넣으세요. 각 칸의 길이 제한을 넘지 않아야 합니다.',response:'companion 응답이 초안 형식이 아니어서 버렸습니다.',
    stale:'초안을 받은 뒤 README · 예시 · 샘플 · 역할이 바뀌었습니다. 이 초안은 승인 · 시험할 수 없습니다. 다시 요청하세요.',notApprovable:'제안 상태의 초안만 승인할 수 있습니다.',
    noProposal:'먼저 AI 초안을 요청하세요.',link:'연결된 로컬 companion이 필요합니다. 위 연결 패널에서 연결하세요. 수동 매핑은 연결 없이 쓸 수 있습니다.',
    old:'이 companion은 AI 초안을 지원하지 않습니다(구버전). companion을 업데이트하세요. 수동 매핑은 그대로 쓸 수 있습니다.',frozen:'RED/BLUE 작업 중에는 요청하지 않습니다.',
    failed:'AI 초안 요청이 실패했습니다. 연결 · 인증 상태를 확인하세요. 자동으로 다시 시도하지 않습니다.',settings:'빌더의 settings 칸이 JSON 객체가 아니어서 승인 기록을 넣지 못했습니다.',
    sample:'샘플 출력을 붙여넣으세요.',span:'원문에서 비어 있지 않은 구간을 선택하세요. 문자 쌍(이모지 등)의 중간에서 자를 수 없습니다.',path:'연결 위치가 이 단계의 문자열 칸이 아닙니다. 예: findings/0/quote',
    level:'level은 원문 구간이 정확히 1 · 2 · 3 중 하나일 때만 연결합니다.',label:'status는 ok · abstain · refusal 중 하나를 고르고 근거 구간을 선택하세요.',gap:'배열 번호가 비어 있습니다(예: 0 없이 1). 빈 칸을 기본값으로 채우지 않습니다.',
    conversionStale:'샘플 출력이 바뀌어 이 수동 매핑은 무효입니다. 내보낸 뒤 다시 시작하세요.',conversion:'수동 매핑 기록이 원문 · 해시 · 이력과 일치하지 않습니다.',unknown:'처리하지 못한 입력이 있습니다. 각 칸을 확인하세요.'});
  function fixed(m){const e=Error(m);e.fixed=true;return e;}
  const message=e=>e&&(e.fixed||e.code)?e.message:MSG.unknown;
  const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
  const keysAre=(o,ks)=>plain(o)&&Object.keys(o).length===ks.length&&ks.every(k=>Object.hasOwn(o,k));
  const str=(v,n)=>typeof v==='string'&&v.length<=n&&!v.includes('\0');
  const HEX=/^[0-9a-f]{64}$/;
  // Compact synchronous SHA-256 (FIPS 180-4) so conversion history entries are hashed in click order without awaiting.
  const K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function sha256(text){const bytes=new TextEncoder().encode(text),n=bytes.length,total=((n+9+63)>>6)<<6,m=new Uint8Array(total);m.set(bytes);m[n]=0x80;
    const dv=new DataView(m.buffer);dv.setUint32(total-8,Math.floor(n/0x20000000));dv.setUint32(total-4,(n*8)>>>0);
    const h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]),w=new Uint32Array(64),r=(x,s)=>(x>>>s)|(x<<(32-s));
    for(let o=0;o<total;o+=64){for(let i=0;i<16;i++)w[i]=dv.getUint32(o+i*4);
      for(let i=16;i<64;i++)w[i]=(r(w[i-15],7)^r(w[i-15],18)^(w[i-15]>>>3))+w[i-16]+(r(w[i-2],17)^r(w[i-2],19)^(w[i-2]>>>10))+w[i-7];
      let [a,b,c,d,e,f,g,k]=h;
      for(let i=0;i<64;i++){const t1=(k+(r(e,6)^r(e,11)^r(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0,t2=((r(a,2)^r(a,13)^r(a,22))+((a&b)^(a&c)^(b&c)))>>>0;k=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
      h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=k;}
    return Array.from(h,x=>x.toString(16).padStart(8,'0')).join('');}
  const utf8Length=text=>new TextEncoder().encode(text).length;
  // Same bytes as the companion's json.dumps(sort_keys, separators=(',',':'), ensure_ascii=False): keys sorted by code point.
  const byCodePoint=(a,b)=>{const x=Array.from(a),y=Array.from(b);for(let i=0;i<Math.min(x.length,y.length);i++){const d=x[i].codePointAt(0)-y[i].codePointAt(0);if(d)return d;}return x.length-y.length;};
  function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(plain(v))return '{'+Object.keys(v).sort(byCodePoint).map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
  // Evidence offsets are Python code points (first occurrence); occurrences are non-overlapping, like str.count.
  const cpLength=s=>Array.from(s).length;
  function spanOf(text,quote){const i=text.indexOf(quote);if(i<0)return null;const start=cpLength(text.slice(0,i));return {start,end:start+cpLength(quote),occurrences:text.split(quote).length-1};}
  // AI maps may only copy ($from/$each); a literal leaf, array or {} would be an invented status or finding.
  const copyOnly=n=>plain(n)&&Object.keys(n).length>0&&(keysAre(n,['$from'])||(keysAre(n,['$each','template'])?copyOnly(n.template):!Object.keys(n).some(k=>k.startsWith('$'))&&Object.values(n).every(copyOnly)));

  // ---- AI proposal: request, strict response check, staleness, approval, synthetic test ----
  function inputs(f){return Object.freeze({role:f.role==='blue'?'blue':'red',readme:String(f.readme??''),examples:String(f.examples??''),sample:String(f.sample??'')});}
  function requestBody(given,cli){const i=inputs(given);
    if(!(i.readme.trim()||i.examples.trim())||Object.entries(LIMITS).some(([k,n])=>!str(i[k],n)))throw fixed(MSG.input);
    const H=core(),c=plain(cli)?cli:{},provider=c.provider===undefined?PROVIDERS[0]:c.provider;if(!PROVIDERS.includes(provider))throw fixed(MSG.provider);const model=String(c.model??'').trim()||H.CLI[provider].defaultModel,effort=H.EFFORTS.includes(c.effort)?c.effort:H.DEFAULT_EFFORT;
    if(!H.validModel(model))throw fixed(H.CLI[provider].name+' 모델 ID는 영문 · 숫자로 시작하는 ASCII(._:- 포함 최대 120자)입니다.');
    return {schema:REQUEST,role:i.role,readme:i.readme,examples:i.examples,sample:i.sample,cli:{provider,model,effort}};}
  const sentOf=body=>inputs(body);
  // Draft shape: the same wrapper checks the builder applies (placeholders, pointer, map syntax), with a dummy executable because
  // the drafted one is an unverified string; 'unstructured' is checked as json since it can never be approved.
  function draftShape(p){const H=core();
    if(!keysAre(p,['target','input','output'])||!keysAre(p.target,['type','executable','args'])||p.target.type!=='stdio'||!str(p.target.executable,2000)||!Array.isArray(p.target.args))return false;
    const o=p.output;if(!plain(o)||!['json','json-fence','unstructured'].includes(o.format))return false;
    try{H.validateWrapper({type:'wrapper',target:{type:'stdio',executable:'C:/draft',args:p.target.args},input:p.input,output:{...o,format:o.format==='unstructured'?'json':o.format}});}catch{return false;}
    if(Object.hasOwn(o,'stageMaps')&&!Object.values(o.stageMaps).every(copyOnly))return false;if(p.input.mode==='template'&&!copyOnly(p.input.template))return false;
    return !Object.hasOwn(o,'map')&&(!Object.hasOwn(o,'path')||o.path!=='');}
  // The companion's answer is data: every field is re-checked, every evidence quote and offset is recomputed from what this page
  // sent, and both hashes are recomputed here, so the provenance never carries a value this page did not verify.
  function readProposal(data,body){const sent=sentOf(body);
    const keys=['schema','role','inputHash','cli','status','downgrades','summary','proposal','evidence','unknowns','warnings','executed','boundary','proposalHash'];
    const ok=keysAre(data,keys)&&data.schema===SCHEMA&&data.role===sent.role&&HEX.test(data.inputHash)&&HEX.test(data.proposalHash)&&keysAre(data.cli,['provider','model','effort'])&&
      data.cli.provider===body.cli.provider&&data.cli.model===body.cli.model&&data.cli.effort===body.cli.effort&&STATUSES.includes(data.status)&&
      Array.isArray(data.downgrades)&&data.downgrades.every(d=>Object.hasOwn(DOWNGRADES,d))&&str(data.summary,600)&&draftShape(data.proposal)&&
      Array.isArray(data.evidence)&&data.evidence.length<=24&&data.evidence.every(e=>keysAre(e,['field','source','quote','start','end','occurrences','offsetUnit'])&&FIELDS.includes(e.field)&&SOURCES.includes(e.source)&&str(e.quote,300)&&e.quote.trim()&&e.offsetUnit==='codepoint'&&
        (s=>s&&s.start===e.start&&s.end===e.end&&s.occurrences===e.occurrences)(spanOf(sent[e.source],e.quote)))&&
      Array.isArray(data.unknowns)&&data.unknowns.length<=12&&data.unknowns.every(u=>str(u,300))&&Array.isArray(data.warnings)&&data.warnings.every(w=>Object.hasOwn(WARNINGS,w))&&data.executed===false&&typeof data.boundary==='string'&&
      (data.status!=='proposed'||data.downgrades.length===0&&data.proposal.output.format!=='unstructured');
    if(!ok)throw fixed(MSG.response);
    const {proposalHash,...hashed}=data;if(sha256(canonical(hashed))!==proposalHash||sha256(canonical(Object.fromEntries(INPUTS.map(k=>[k,sent[k]]))))!==data.inputHash)throw fixed(MSG.response);
    return Object.freeze({data:JSON.parse(JSON.stringify(data)),sent});}
  const stale=(state,current)=>!state||INPUTS.some(k=>state.sent[k]!==inputs(current)[k]);
  const pretty=v=>v===undefined?'':JSON.stringify(v,null,2);
  // Approval: explicit, only for a current 'proposed' draft; yields builder fields plus a provenance record for settings.
  function approve(state,current,executable){if(!state)throw fixed(MSG.noProposal);if(stale(state,current))throw fixed(MSG.stale);
    const d=state.data,p=d.proposal;if(d.status!=='proposed'||!['json','json-fence'].includes(p.output.format))throw fixed(MSG.notApprovable);
    const fields={role:d.role,targetType:'stdio',executable:String(executable??p.target.executable).trim(),args:JSON.stringify(p.target.args),inputMode:p.input.mode,template:pretty(p.input.template),
      source:p.output.source,format:p.output.format,path:p.output.path??'',advanced:Object.hasOwn(p.output,'stageMaps')?pretty({stageMaps:p.output.stageMaps}):''};
    wrapper().adapterFrom(fields);  // fixed-message validation of the approved profile; existence of the executable is still checked by the companion
    return {fields,provenance:{schema:SCHEMA,proposalHash:d.proposalHash,inputHash:d.inputHash,cli:{...d.cli},approval:'explicit-user-click',
      executableEdited:fields.executable!==p.target.executable,execution:'not run; registration and execution need their existing separate consent'}};}
  function mergeSettings(text,provenance){const s=String(text??'').trim();let v={};if(s){try{v=JSON.parse(s);}catch{throw fixed(MSG.settings);}if(!plain(v))throw fixed(MSG.settings);}
    return pretty({...v,profileProposal:provenance});}
  // Synthetic compatibility test: the draft's output settings over the pasted sample only. No program is launched.
  function synthetic(state,current,stage){if(!state)throw fixed(MSG.noProposal);if(stale(state,current))throw fixed(MSG.stale);
    const o=state.data.proposal.output;if(o.format==='unstructured')throw fixed(DOWNGRADES.unstructured_output);if(!state.sent.sample.trim())throw fixed(MSG.sample);
    const value=core().transformWrapperOutput(state.sent.sample,o,stage),keys=plain(value)?Object.keys(value):[],want=wrapper().EXPECTED[stage]||[];
    return {value,missing:want.filter(k=>!keys.includes(k)),extra:keys.filter(k=>!want.includes(k))};}

  // ---- Manual span mapping for unstructured sample output ----
  const CONVERSION='falsify.sample-conversion.v1',CONVERTER=Object.freeze({id:'falsify.manual-span-mapping',version:'1'});
  const LIMITATIONS=Object.freeze(['sample-only: applies to this pasted sample, not to the program at run time','no inference: every value is an exact span; status is a manual label anchored to a span',
    'string values only, except level from an exact 1/2/3 span','unmapped required fields stay missing; nothing is filled with defaults']);
  // Stage -> string leaves a span may fill; index bounds follow the stage schemas' maxItems (scan evidence 4, targets 8, items 12, evidence 6).
  const range=n=>'(?:'+Array.from({length:n},(_,i)=>i).join('|')+')',EV='evidence/'+range(6)+'/(?:segmentId|quote|relation)';
  const LEAVES=Object.freeze({scan:new RegExp('^(?:summary|evidence/'+range(4)+'/(?:segmentId|quote|relation))$'),selection:new RegExp('^targets/'+range(8)+'/(?:segmentId|anchor|reason)$'),
    red:new RegExp('^candidates/'+range(12)+'/(?:id|segmentId|level|before|after|rationale|uncertainty|'+EV+')$'),blue:new RegExp('^findings/'+range(12)+'/(?:id|segmentId|quote|rationale|uncertainty|'+EV+')$')});
  const LABELS=Object.freeze(['ok','abstain','refusal']);
  const now=clock=>{const t=typeof clock==='function'?clock():new Date();return t instanceof Date&&!isNaN(t)?t.toISOString():null;};
  const freeze=a=>Object.freeze({...a,entries:Object.freeze(a.entries.map(e=>Object.freeze({...e}))),history:Object.freeze(a.history.map(h=>Object.freeze({...h})))});
  function startConversion(raw,stage,clock,previous){const text=String(raw??'');if(!text.trim())throw fixed(MSG.sample);if(!str(text,LIMITS.sample))throw fixed(MSG.input);if(!Object.hasOwn(LEAVES,stage))throw fixed(MSG.path);
    const rawSha256=sha256(text),first={seq:1,op:previous?'restart':'start',at:now(clock),rawSha256,...(previous?{previousRawSha256:previous.rawSha256,previousStage:previous.stage,previousEntries:previous.entries.length}:{})};
    return freeze({schema:CONVERSION,converter:CONVERTER,stage,raw:text,rawEncoding:'utf-8',rawBytes:utf8Length(text),rawSha256,offsetUnit:'utf16',entries:[],history:[first],limitations:LIMITATIONS});}
  function span(a,start,end){if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>a.raw.length)throw fixed(MSG.span);
    const low=i=>{const c=a.raw.charCodeAt(i);return c>=0xdc00&&c<=0xdfff;};if(low(start)||(end<a.raw.length&&low(end)))throw fixed(MSG.span);
    const text=a.raw.slice(start,end);if(!text.trim())throw fixed(MSG.span);return {start,end,text,textSha256:sha256(text)};}
  function record(a,entry,op,clock){const entries=a.entries.filter(e=>e.path!==entry.path).concat(entry).sort((x,y)=>x.path<y.path?-1:x.path>y.path?1:0);
    const replaced=a.entries.some(e=>e.path===entry.path);
    return freeze({...a,entries,history:a.history.concat({seq:a.history.length+1,op:replaced?'replace':op,at:now(clock),path:entry.path,origin:entry.origin,start:entry.start,end:entry.end,textSha256:entry.textSha256,...(entry.origin==='manual-label'?{value:entry.value}:{})})});}
  function mapSpan(a,path,start,end,clock){if(!LEAVES[a.stage].test(String(path)))throw fixed(MSG.path);const s=span(a,start,end);
    let value=s.text;if(path.endsWith('/level')){if(!/^[123]$/.test(s.text))throw fixed(MSG.level);value=Number(s.text);}
    return record(a,{path,origin:'span',value,...s},'map',clock);}
  function labelStatus(a,value,start,end,clock){if(!LABELS.includes(value))throw fixed(MSG.label);return record(a,{path:'status',origin:'manual-label',value,...span(a,start,end)},'label',clock);}
  function unmap(a,path,clock){if(!a.entries.some(e=>e.path===path))return a;return freeze({...a,entries:a.entries.filter(e=>e.path!==path),history:a.history.concat({seq:a.history.length+1,op:'unmap',at:now(clock),path})});}
  // The stage object built only from entries. Array positions must be contiguous; missing required fields are reported, never filled.
  function converted(a){const out={};
    for(const e of a.entries){const parts=e.path.split('/');let cur=out;
      for(let i=0;i<parts.length-1;i++){const k=parts[i],next=/^\d+$/.test(parts[i+1]);if(!Object.hasOwn(cur,k))cur[k]=next?[]:{};cur=cur[k];}
      cur[parts.at(-1)]=e.value;}
    const dense=v=>{if(Array.isArray(v)){for(let i=0;i<v.length;i++)if(!Object.hasOwn(v,i))throw fixed(MSG.gap);v.forEach(dense);}else if(plain(v))Object.values(v).forEach(dense);};dense(out);
    const keys=Object.keys(out),want=wrapper().EXPECTED[a.stage]||[];return {value:out,missing:want.filter(k=>!keys.includes(k)),extra:keys.filter(k=>!want.includes(k))};}
  // Replays the whole history against the preserved raw text with the same operations the page uses, then requires the replayed
  // record (entries, history, converter, limitations, hashes) and the exported result to be identical. Any edit, truncation or
  // forged event fails here.
  function verifyConversion(a){const fail=()=>{throw fixed(MSG.conversion);};
    if(!plain(a)||!Array.isArray(a.history)||!a.history.length||!plain(a.history[0])||Object.hasOwn(a,'exportedAt')!==Object.hasOwn(a,'result'))fail();
    const {exportedAt,result,...record}=a;if(exportedAt!==undefined&&exportedAt!==null&&typeof exportedAt!=='string')fail();
    const at=h=>()=>h.at===null?new Date(NaN):new Date(h.at),h0=a.history[0];let b;
    try{const prev=h0.op==='restart'?{rawSha256:h0.previousRawSha256,stage:h0.previousStage,entries:{length:h0.previousEntries}}:h0.op==='start'?null:fail();
      if(prev&&(!HEX.test(prev.rawSha256)||!Object.hasOwn(LEAVES,prev.stage)||!Number.isSafeInteger(prev.entries.length)||prev.entries.length<0))fail();
      b=startConversion(record.raw,record.stage,at(h0),prev);
      for(const h of a.history.slice(1)){if(!plain(h))fail();const clock=at(h),n=b.history.length;
        if(h.op==='unmap')b=unmap(b,h.path,clock);
        else if(['map','label','replace'].includes(h.op))b=h.origin==='manual-label'?labelStatus(b,h.value,h.start,h.end,clock):h.origin==='span'?mapSpan(b,h.path,h.start,h.end,clock):fail();
        else fail();
        if(b.history.length!==n+1)fail();}}
    catch{fail();}
    if(canonical(b)!==canonical(record))fail();
    if(result!==undefined){let r;try{r=converted(b);}catch(e){r={error:message(e)};}if(canonical(r)!==canonical(result))fail();}
    return true;}
  function exportConversion(a,clock){verifyConversion(a);let result;try{result=converted(a);}catch(e){result={error:message(e)};}
    return JSON.stringify({...a,exportedAt:now(clock),result},null,2)+'\n';}

  // ---- UI ----
  function el(doc,tag,props={},...kids){const e=doc.createElement(tag);for(const [k,v] of Object.entries(props))if(k==='text')e.textContent=v;else if(k in e)e[k]=v;else e.setAttribute(k,v);e.append(...kids);return e;}
  function mount(doc,bridge=root.FalsifyLocalBridge,clock){
    const host=doc.getElementById('harness-wrapper');if(!host)return false;if(doc.getElementById('harness-profile'))return true;
    const x=(tag,props,...kids)=>el(doc,tag,props,...kids),$=id=>doc.getElementById(id),c={};
    const field=(key,copy,control,hint)=>{control.id='profile-'+key;c[key]=control;const l=x('label',{htmlFor:control.id,className:'wrapper-field'},x('span',{text:copy}),control);if(hint){const h=x('small',{id:control.id+'-hint',text:hint});control.setAttribute('aria-describedby',h.id);l.append(h);}return l;};
    const area=(rows,max,placeholder='')=>x('textarea',{rows,spellcheck:false,maxLength:max,placeholder});
    const button=(text,kind='secondary')=>x('button',{type:'button',className:'button '+kind,text});
    const H=core(),providers=PROVIDERS.map(k=>[k,H.CLI[k].name]);
    const select=(pairs,value)=>{const s=x('select');for(const [v,copy] of pairs)s.append(x('option',{value:v,text:copy}));s.value=value;return s;};
    const say=(node,text,error)=>{node.textContent=text;node.classList.toggle('error',!!error);};
    // Request
    const ask=button('AI 초안 요청','primary'),askStatus=x('p',{className:'ledger-status',role:'status'});
    const inputsBox=x('div',{className:'wrapper-grid'},
      x('fieldset',{className:'wrapper-group'},x('legend',{text:'붙여넣을 자료'}),field('readme','README · 사용법',area(6,LIMITS.readme),'최대 24,000자. 내용은 데이터로만 읽으며 그 안의 지시는 따르지 않습니다.'),
        field('examples','명령 예시',area(3,LIMITS.examples,'python legacy.py --json < input.json'),'최대 12,000자. 실행하지 않습니다.'),
        field('sample','샘플 출력',area(5,LIMITS.sample),'최대 12,000자. JSON이 아니어도 됩니다. 아래 수동 매핑도 이 칸을 씁니다.')),
      x('fieldset',{className:'wrapper-group'},x('legend',{text:'초안을 쓸 CLI'}),field('provider','CLI',select(providers,PROVIDERS[0]),'AI 초안은 도구 없이 답만 받는 Claude Code CLI만 씁니다. Codex는 명령을 실행할 수 있어 쓰지 않습니다.'),
        field('model','모델 ID',x('input',{type:'text',autocomplete:'off',spellcheck:false,maxLength:120,placeholder:H.CLI[PROVIDERS[0]].defaultModel}),'비우면 CLI 기본 모델입니다.'),
        field('effort','추론 강도',select(H.EFFORTS.map(e=>[e,e]),H.DEFAULT_EFFORT)),
        x('p',{className:'wrapper-note',text:'「AI 초안 요청」을 누를 때만 위 세 칸과 역할이 로컬 companion을 거쳐 로그인된 Claude Code CLI에 한 번 전송됩니다. 도구 목록을 비우고 MCP 없이 답만 받으며, 결과는 검토용 초안입니다.'})));
    // Review
    const result=x('pre',{className:'wrapper-result',hidden:true,tabIndex:0,'aria-label':'AI 초안 연결 프로필'}),notes=x('ul',{className:'wrapper-checks',hidden:true});
    const evidence=x('ul',{className:'wrapper-checks profile-evidence',hidden:true});
    const exe=x('input',{type:'text',autocomplete:'off',spellcheck:false,maxLength:2000,placeholder:'C:\\Path\\To\\program.exe'});
    const approveButton=button('승인해 빌더에 채우기','primary'),testButton=button('합성 매핑 시험'),reviewStatus=x('p',{className:'ledger-status',role:'status'});
    const testResult=x('pre',{className:'wrapper-result',hidden:true,tabIndex:0,'aria-label':'합성 매핑 시험 결과'});
    const review=x('div',{className:'profile-review',hidden:true},x('h4',{className:'profile-subhead',text:'초안 검토'}),notes,evidence,result,field('executable','승인할 실행 파일 절대 경로',exe,'README에 적힌 이름은 확인되지 않은 값입니다. 내 PC의 실제 절대 경로로 확인 · 수정하세요.'),
      x('div',{className:'button-row'},approveButton,testButton),testResult,reviewStatus);
    // Manual mapping
    const mStage=select(Object.entries({scan:'scan',selection:'selection',red:'red',blue:'blue'}),'red'),mStart=button('수동 매핑 시작'),mStatus=x('p',{className:'ledger-status',role:'status'});
    const raw=x('textarea',{rows:8,spellcheck:false,readOnly:true,id:'profile-raw','aria-describedby':'profile-raw-hint'});
    const mPath=x('input',{type:'text',autocomplete:'off',spellcheck:false,maxLength:80,placeholder:'findings/0/quote'}),mapButton=button('선택 구간 연결');
    const label=select(LABELS.map(v=>[v,v]),'ok'),labelButton=button('선택 구간을 근거로 status 지정'),entries=x('ul',{className:'wrapper-checks profile-entries'});
    const converted_=x('pre',{className:'wrapper-result',hidden:true,tabIndex:0,'aria-label':'수동 매핑 결과'}),exportButton=button('매핑 기록 내보내기 · JSON');
    const work=x('div',{className:'profile-manual-work',hidden:true},x('label',{htmlFor:'profile-raw',className:'wrapper-field'},x('span',{text:'보존된 원문 · 읽기 전용'}),raw,
        x('small',{id:'profile-raw-hint',text:'원문에서 구간을 드래그해 선택한 뒤 연결 위치를 적고 연결하세요. 모든 값은 원문 그대로의 구간이며 앱이 내용을 추론하지 않습니다.'})),
      field('path','연결 위치 · 단계 출력 안의 경로',mPath,'예: findings/0/quote · candidates/0/before · summary · evidence/0/quote'),x('div',{className:'button-row'},mapButton),
      field('label','status 값',label,'status는 원문 구간을 근거로 사람이 고르는 수동 표시이며 그대로 기록됩니다.'),x('div',{className:'button-row'},labelButton),
      entries,converted_,x('div',{className:'button-row'},exportButton));
    const manual=x('section',{className:'wrapper-preview profile-manual','aria-labelledby':'profile-manual-title'},x('h3',{id:'profile-manual-title',text:'구조화되지 않은 샘플 · 수동 매핑'}),
      x('p',{className:'wrapper-note',text:'Markdown 등 JSON이 아닌 샘플 출력을 원문 구간 단위로 단계 스키마 칸에 직접 연결합니다. 원문 · 변환기 ID와 버전 · SHA-256 · 변경 이력을 함께 내보냅니다. 이 기록은 붙여넣은 샘플에만 적용되며 실행 시 프로그램 출력을 변환하지 않습니다.'}),
      field('stage','적용할 단계',mStage),x('div',{className:'button-row'},mStart),work,mStatus);
    const panel=x('section',{id:'harness-profile',className:'wrapper-preview harness-profile','aria-labelledby':'profile-title'},x('h3',{id:'profile-title',text:'README로 연결 프로필 초안 받기 · AI'}),
      x('p',{className:'wrapper-note',text:'README · 명령 예시 · 샘플 출력을 읽고 위 빌더에 넣을 연결 프로필 초안을 제안받습니다. 초안은 실행 · 설치 · 등록되지 않으며, 근거가 부족하면 판단 불가로 끝납니다. 승인하면 빌더 칸만 채우고, 등록과 실행은 기존처럼 따로 동의합니다.'}),
      inputsBox,x('div',{className:'button-row'},ask),askStatus,review,manual);
    let state=null,conversion=null,seq=0;
    const current=()=>({role:$('wrapper-role')?.value,readme:c.readme.value,examples:c.examples.value,sample:c.sample.value});
    const syncModel=()=>{c.model.placeholder=H.CLI[c.provider.value].defaultModel;};
    const freshness=()=>{if(state&&stale(state,current())){approveButton.disabled=testButton.disabled=true;say(reviewStatus,MSG.stale,true);}
      if(conversion){const old=conversion.raw!==c.sample.value||conversion.stage!==mStage.value;mapButton.disabled=labelButton.disabled=old;if(old)say(mStatus,MSG.conversionStale,true);}};
    function renderReview(){review.hidden=!state;if(!state)return;const d=state.data,approvable=d.status==='proposed'&&d.proposal.output.format!=='unstructured';
      result.textContent=pretty(d.proposal);result.hidden=false;exe.value=d.proposal.target.executable;
      notes.replaceChildren(...[STATUS_TEXT[d.status],'요약 · '+d.summary,...d.downgrades.map(k=>'낮춘 이유 · '+DOWNGRADES[k]),...d.warnings.map(k=>'주의 · '+WARNINGS[k]),...d.unknowns.map(u=>'확인 안 됨 · '+u),
        'CLI · '+d.cli.provider+' · '+d.cli.model+' · '+d.cli.effort,'초안 해시 · '+d.proposalHash].map(t=>x('li',{text:t})));notes.hidden=false;
      evidence.replaceChildren(...d.evidence.map(e=>x('li',{},x('span',{text:e.field+' ← '+e.source+' · '}),x('q',{text:e.quote}))));evidence.hidden=!d.evidence.length;
      approveButton.disabled=!approvable;testButton.disabled=d.proposal.output.format==='unstructured';testResult.hidden=true;
      say(reviewStatus,approvable?'초안을 검토한 뒤 승인하세요. 승인은 빌더 칸만 채웁니다.':'이 초안은 승인할 수 없습니다. 근거를 보강해 다시 요청하거나 아래 수동 매핑을 쓰세요.');}
    ask.addEventListener('click',async()=>{const my=++seq;state=null;renderReview();
      let body;try{body=requestBody(current(),{provider:c.provider.value,model:c.model.value,effort:c.effort.value});}catch(e){return say(askStatus,message(e),true);}
      const s=bridge?.state?.(),cap=bridge?.capabilities?.()||s?.cap,link=bridge?.session?.();
      if(!s?.connected||!link)return say(askStatus,MSG.link,true);const offer=cap?.harnessProfileProposal;if(!offer?.available||!offer.providers?.includes(body.cli.provider))return say(askStatus,MSG.old,true);if(s.frozen)return say(askStatus,MSG.frozen,true);
      ask.disabled=true;say(askStatus,'초안을 요청했습니다. 모델 응답을 기다리는 중입니다(최대 약 2분).');
      const controller=typeof AbortController==='function'?new AbortController():null,timer=controller?setTimeout(()=>controller.abort(),150000):null;
      try{const data=await link.request(ROUTE,body,controller?{signal:controller.signal}:undefined);if(my!==seq)return;state=readProposal(data,body);renderReview();freshness();
        say(askStatus,stale(state,current())?MSG.stale:'초안을 받았습니다. 아래에서 검토하세요. 아무것도 실행하지 않았습니다.',stale(state,current()));}
      catch(e){if(my!==seq)return;say(askStatus,e?.fixed?e.message:ERRORS[e?.message]||MSG.failed,true);}
      finally{if(timer)clearTimeout(timer);if(my===seq)ask.disabled=false;}});
    approveButton.addEventListener('click',()=>{try{const a=approve(state,current(),exe.value);const settings=$('wrapper-settings');const merged=mergeSettings(settings?.value,a.provenance);
        for(const [k,v] of Object.entries(a.fields)){const n=$('wrapper-'+k);if(n)n.value=v;}if(settings)settings.value=merged;
        for(const k of ['targetType','inputMode','source']){$('wrapper-'+k)?.dispatchEvent(new Event('change',{bubbles:true}));}
        say(reviewStatus,'승인한 초안으로 위 빌더 칸을 채웠습니다. 아직 등록 · 실행하지 않았습니다. 「형식 검증」과 「편집기에 harness JSON 넣기」 뒤 직접 등록하세요.');}
      catch(e){say(reviewStatus,message(e),true);}});
    testButton.addEventListener('click',()=>{testResult.hidden=true;try{const r=synthetic(state,current(),current().role);testResult.textContent=pretty(r.value);testResult.hidden=false;
        say(reviewStatus,'합성 시험 · '+(r.missing.length?'없는 최상위 필드: '+r.missing.join(', '):'기대 최상위 필드가 모두 있습니다')+(r.extra.length?' · 추가 필드 '+r.extra.length+'개':'')+' · 붙여넣은 샘플 기준이며 프로그램은 실행하지 않았습니다.');}
      catch(e){say(reviewStatus,message(e),true);}});
    function renderConversion(){work.hidden=!conversion;if(!conversion)return;raw.value=conversion.raw;
      entries.replaceChildren(...conversion.entries.map(e=>{const remove=x('button',{type:'button',className:'text-button',text:'연결 해제'});remove.setAttribute('aria-label',e.path+' 연결 해제');
        remove.addEventListener('click',()=>{conversion=unmap(conversion,e.path,clock);renderConversion();});
        return x('li',{},x('code',{text:e.path}),x('span',{text:(e.origin==='manual-label'?' = '+e.value+' · 근거 ':' ← ')+'['+e.start+', '+e.end+') '}),x('q',{text:e.text}),x('span',{text:' '}),remove);}));
      try{const r=converted(conversion);converted_.textContent=pretty(r.value);converted_.hidden=false;say(mStatus,'연결 '+conversion.entries.length+'개 · 이력 '+conversion.history.length+'건 · '+(r.missing.length?'없는 최상위 필드: '+r.missing.join(', '):'기대 최상위 필드가 모두 있습니다')+' · 하위 필수 칸과 인용 근거 검사는 실제 실행 때 앱이 합니다.');}
      catch(e){converted_.hidden=true;say(mStatus,message(e),true);}freshness();}
    mStart.addEventListener('click',()=>{try{conversion=startConversion(c.sample.value,mStage.value,clock,conversion);mapButton.disabled=labelButton.disabled=false;renderConversion();}catch(e){say(mStatus,message(e),true);}});
    mapButton.addEventListener('click',()=>{try{conversion=mapSpan(conversion,mPath.value.trim(),raw.selectionStart,raw.selectionEnd,clock);renderConversion();}catch(e){say(mStatus,message(e),true);}});
    labelButton.addEventListener('click',()=>{try{conversion=labelStatus(conversion,label.value,raw.selectionStart,raw.selectionEnd,clock);renderConversion();}catch(e){say(mStatus,message(e),true);}});
    exportButton.addEventListener('click',()=>{try{const text=exportConversion(conversion,clock),url=URL.createObjectURL(new Blob([text],{type:'application/json'})),a=doc.createElement('a');
        a.href=url;a.download='sample-conversion-'+conversion.rawSha256.slice(0,12)+'.json';doc.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);say(mStatus,'원문 · 해시 · 이력을 담은 매핑 기록을 내보냈습니다.');}
      catch(e){say(mStatus,message(e),true);}});
    for(const n of [c.readme,c.examples,c.sample])n.addEventListener('input',freshness);mStage.addEventListener('change',freshness);c.provider.addEventListener('change',syncModel);
    $('wrapper-role')?.addEventListener('change',freshness);
    const intro=host.querySelector(':scope>p');if(intro)intro.after(panel);else host.append(panel);
    return true;}
  // The wrapper panel is created by another script after load; wait for it with a bounded observer that always disconnects.
  function watch(doc,timeout=30000){if(!doc)return;const start=()=>{if(mount(doc))return;const obs=new MutationObserver(()=>{if(mount(doc))stop();}),timer=setTimeout(()=>stop(),timeout);
    function stop(){obs.disconnect();clearTimeout(timer);}obs.observe(doc.body||doc.documentElement,{childList:true,subtree:true});};
    if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',start,{once:true});else start();}
  return {requestBody,readProposal,canonical,stale,approve,mergeSettings,synthetic,startConversion,mapSpan,labelStatus,unmap,converted,verifyConversion,exportConversion,sha256,mount,watch,
    message,MSG,ERRORS,DOWNGRADES,WARNINGS,LIMITS,ROUTE,SCHEMA,REQUEST,PROVIDERS,CONVERSION,CONVERTER,LEAVES};
});
