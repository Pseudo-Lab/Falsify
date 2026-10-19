// Wrapper connection profile builder for the Harness manager. It only builds, validates and previews JSON in this page: it never
// registers, executes, installs or calls a model. The preview applies the profile to pasted sample text; it is not a compatibility test.
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else{root.FalsifyHarnessWrapper=api;api.watch(root.document);}})(globalThis,function(root){
  'use strict';
  const core=()=>root.FalsifyHarness||(typeof require==='function'?require('./harness-core.js'):null);
  // Top-level keys of each invocation outputSchema. A preview only lists missing/extra keys; the backend schema check stays authoritative.
  const EXPECTED=Object.freeze({scan:['status','summary','evidence'],selection:['status','targets'],red:['status','candidates'],blue:['status','findings']});
  const STAGE_LABEL=Object.freeze({scan:'RED 요약 단계 · scan',selection:'BLUE 대상 선택 · selection',red:'RED 후보 · red',blue:'BLUE 결과 · blue'});
  const MODES=Object.freeze({invocation:['invocation JSON 그대로','stdin으로 invocation JSON 전체(schema · role · prompt · outputSchema · settings · call · maxCalls)를 보냅니다.'],
    prompt:['prompt 텍스트만','stdin으로 prompt 텍스트만 보냅니다. 출력 형식 지시는 prompt 안에 들어 있습니다.'],
    template:['template로 바꾼 JSON','invocation JSON에 아래 template 매핑($from · $each)을 적용한 JSON을 stdin으로 보냅니다.'],
    files:['임시 파일 경로','비공개 임시 폴더에 invocation.json · prompt.txt · schema.json을 쓰고 stdin은 비웁니다. args에서 {input} · {prompt} · {schema} · {output}을 인자 하나로 쓰면 절대 경로로 바뀝니다. 원본 PDF가 아니라 추출 텍스트 / JSON입니다.']});
  const MSG=Object.freeze({args:'명령 인자는 ["--json", "{input}"]처럼 문자열 JSON 배열로 적으세요. 비워 두면 인자가 없습니다.',settings:'settings는 JSON 객체여야 합니다. 비워 두면 {}입니다.',
    template:'template 모드에는 JSON template이 필요합니다. 예: {"text":{"$from":"/prompt"}}',advanced:'고급 매핑은 {"map":…} 또는 {"stageMaps":{"red":…}} 형태의 JSON 객체여야 합니다.',
    editor:'편집기 JSON을 읽지 못했거나 harness 형식이 아닙니다. 편집기 내용을 확인하세요.',noEditor:'Harness 편집기를 찾지 못했습니다. 페이지를 새로 고친 뒤 다시 시도하세요.',
    sample:'미리보기할 샘플 출력을 붙여넣으세요.',unknown:'처리하지 못한 입력이 있습니다. 각 칸의 형식을 확인하세요.'});
  function fixed(m){const e=Error(m);e.fixed=true;return e;}
  // Shown text is always one of the fixed messages above or a fixed core message, never a parser error that may echo user input.
  const message=e=>e&&(e.fixed||e.code)?e.message:MSG.unknown;
  function json(text,msg,empty){const s=String(text??'').trim();if(!s){if(empty!==undefined)return empty;throw fixed(msg);}try{return JSON.parse(s);}catch{throw fixed(msg);}}
  const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
  function adapterFrom(f){
    let target;if(f.targetType==='http')target={type:'http',url:String(f.url??'').trim()};
    else{const args=json(f.args,MSG.args,[]);if(!Array.isArray(args))throw fixed(MSG.args);target={type:'stdio',executable:String(f.executable??'').trim(),args};}
    const input={mode:f.inputMode||'invocation'};if(input.mode==='template')input.template=json(f.template,MSG.template);
    const output={source:f.source||'stdout',format:f.format||'json'},path=String(f.path??'').trim();if(path)output.path=path;
    const adv=json(f.advanced,MSG.advanced,{});if(!object(adv)||Object.keys(adv).some(k=>k!=='map'&&k!=='stageMaps'))throw fixed(MSG.advanced);
    for(const k of ['map','stageMaps'])if(Object.hasOwn(adv,k))output[k]=adv[k];
    return core().validateWrapper({type:'wrapper',target,input,output});}
  // Pure: fields in, one validated falsify.harness.v1 config out. Nothing is stored, registered or sent anywhere.
  function build(f){const H=core(),adapter=adapterFrom(f),settings=json(f.settings,MSG.settings,{});if(!object(settings))throw fixed(MSG.settings);
    const h={schema:'falsify.harness.v1',id:String(f.id??'').trim(),name:String(f.name??'').trim(),version:String(f.version??'').trim(),role:f.role,instructions:String(f.instructions??''),maxCalls:Number(f.maxCalls),adapter,settings};
    try{return H.validate(h);}catch(e){throw e.code?e:fixed(e.message);}}
  // Synthetic preview for one explicitly chosen stage: parse -> output.path -> stage map. Not proof that the real program emits this.
  function preview(f,sample,stage){const output=adapterFrom(f).output,text=String(sample??'');if(!text.trim())throw fixed(MSG.sample);
    const value=core().transformWrapperOutput(text,output,stage),keys=object(value)?Object.keys(value):[],want=EXPECTED[stage]||[];
    return {value,missing:want.filter(k=>!keys.includes(k)),extra:keys.filter(k=>!want.includes(k))};}
  const pretty=v=>v===undefined?'':JSON.stringify(v,null,2);
  // Editor -> fields, for revising an existing wrapper config. Base fields always load; adapter fields only from a wrapper adapter.
  function fieldsFrom(h){const f={role:h.role,id:h.id,name:h.name,version:h.version,maxCalls:String(h.maxCalls),instructions:h.instructions,settings:h.settings?pretty(h.settings):''},a=h.adapter;
    if(a?.type!=='wrapper')return f;const t=a.target,o=a.output,adv={};for(const k of ['map','stageMaps'])if(Object.hasOwn(o,k))adv[k]=o[k];
    return {...f,targetType:t.type,executable:t.executable??'',args:t.args?JSON.stringify(t.args):'',url:t.url??'',inputMode:a.input.mode,template:pretty(a.input.template),source:o.source,format:o.format,path:o.path??'',advanced:Object.keys(adv).length?pretty(adv):''};}
  function el(doc,tag,props={},...kids){const e=doc.createElement(tag);for(const [k,v] of Object.entries(props))if(k==='text')e.textContent=v;else if(k in e)e[k]=v;else e.setAttribute(k,v);e.append(...kids);return e;}
  function mount(doc){
    const manager=doc.getElementById('harness-manager');if(!manager)return false;if(doc.getElementById('harness-wrapper'))return true;
    const x=(tag,props,...kids)=>el(doc,tag,props,...kids),c={};
    const field=(key,copy,control,hint)=>{control.id='wrapper-'+key;c[key]=control;const l=x('label',{htmlFor:control.id,className:'wrapper-field'},x('span',{text:copy}),control);if(hint){const h=x('small',{id:control.id+'-hint',text:hint});control.setAttribute('aria-describedby',h.id);l.append(h);}return l;};
    const input=(value='',props={})=>x('input',{type:'text',value,autocomplete:'off',spellcheck:false,...props});
    const area=(rows,placeholder='')=>x('textarea',{rows,spellcheck:false,placeholder});
    const select=(pairs,value)=>{const s=x('select');for(const [v,copy] of pairs)s.append(x('option',{value:v,text:copy}));s.value=value;return s;};
    const base=core().builtin('red');
    const basic=x('fieldset',{className:'wrapper-group'},x('legend',{text:'기본 정보'}),
      field('role','역할',select([['red','RED'],['blue','BLUE']],'red')),field('id','ID',input('my-wrapper-red',{maxLength:80})),field('name','이름',input('내 프로그램 RED',{maxLength:120})),
      field('version','버전',input('1',{maxLength:80})),field('maxCalls','호출 한도 (1–32)',input('8',{inputMode:'numeric',maxLength:2})),
      field('instructions','지침',Object.assign(area(3),{value:base.instructions,maxLength:8000})));
    const targetBox=x('fieldset',{className:'wrapper-group'},x('legend',{text:'실행 대상'}),
      field('targetType','연결 방식',select([['stdio','로컬 프로그램 · stdio'],['http','HTTPS 서버 · http']],'stdio')),
      field('executable','실행 파일 절대 경로',input('',{placeholder:'C:\\Path\\To\\python.exe',maxLength:2000})),
      field('args','명령 인자 · JSON 배열',area(2,'["C:\\\\Path\\\\To\\\\my_tool.py", "--json"]'),'shell 문자열은 실행하지 않습니다. 인자는 하나씩 문자열로 적으세요.'),
      field('url','HTTPS URL',input('',{placeholder:'https://your-server.example/falsify',maxLength:2000}),'자격증명 · 쿼리 없는 공인 HTTPS만 허용합니다. API 키는 서버 쪽 비밀 저장소에 두세요.'));
    const modeHint=x('small',{id:'wrapper-inputMode-hint'});
    const inputBox=x('fieldset',{className:'wrapper-group'},x('legend',{text:'입력 전달'}),
      field('inputMode','프로그램이 받는 입력',select(Object.entries(MODES).map(([k,[copy]])=>[k,copy]),'invocation')),
      field('template','입력 template · JSON',area(4,'{"text":{"$from":"/prompt"},"task":{"$from":"/role"}}')));
    c.inputMode.setAttribute('aria-describedby',modeHint.id);c.inputMode.parentElement.append(modeHint);
    const sourceHint=x('small',{id:'wrapper-source-hint'});
    const outputBox=x('fieldset',{className:'wrapper-group'},x('legend',{text:'출력 읽기'}),
      field('source','결과 위치',select([['stdout','stdout'],['file','파일 · {output}']],'stdout')),
      field('format','결과 형식',select([['json','JSON 하나'],['json-fence','```json 블록 하나']],'json'),'설명 문장과 코드 블록이 섞인 Markdown은 지원하지 않습니다. 출력 전체가 ```json 블록 하나일 때만 json-fence를 고르세요.'),
      field('path','결과 위치 pointer · 선택',input('',{placeholder:'/result',maxLength:2000}),'RFC 6901 JSON pointer. 비우면 출력 전체를 씁니다. 매핑보다 먼저 적용됩니다.'),
      field('advanced','고급 매핑 · JSON 선택',area(6,'{"stageMaps":{"red":{"status":{"$from":"/state"},"candidates":{"$each":"/items","template":{"before":{"$from":"/old"}}}}}}'),'{"map":…} 또는 {"stageMaps":{"scan" | "selection" | "red" | "blue":…}}. {"$from":"/경로"}는 값을 복사하고 {"$each":"/배열","template":…}는 원소마다 적용합니다. 없는 경로는 오류이며 기본값으로 채우지 않습니다.'),
      field('settings','settings · JSON 객체 선택',area(2,'{"programCommit":"<git commit hash>"}'),'프로그램 commit hash를 적어 두면 해시가 실행 파일 내용을 대신 기록하지 못하는 한계를 보완합니다. 비밀정보는 넣지 마세요.'));
    c.source.setAttribute('aria-describedby',sourceHint.id);c.source.parentElement.append(sourceHint);
    const result=x('pre',{className:'wrapper-result',hidden:true,tabIndex:0,'aria-label':'매핑 미리보기 결과'}),checks=x('ul',{className:'wrapper-checks',hidden:true});
    const previewButton=x('button',{type:'button',className:'button secondary',text:'샘플로 매핑 미리보기'});
    const previewBox=x('section',{className:'wrapper-preview','aria-labelledby':'wrapper-preview-title'},x('h3',{id:'wrapper-preview-title',text:'샘플 출력 매핑 미리보기'}),
      x('p',{className:'wrapper-note',text:'붙여넣은 샘플 텍스트에 위 출력 설정을 적용한 결과만 보여 줍니다. 프로그램 실행 · 설치 · 모델 호출은 하지 않으며 실제 호환성 증명이 아닙니다. 실행 파일 존재와 실제 출력은 로컬 companion이 실행할 때 확인합니다.'}),
      field('stage','적용할 단계',select(Object.entries(STAGE_LABEL),'red')),field('sample','샘플 출력',area(5,'{"state":"ok","items":[{"old":"…"}]}')),
      x('div',{className:'button-row'},previewButton),checks,result);
    const toEditor=x('button',{type:'button',className:'button primary',text:'편집기에 harness JSON 넣기'}),check=x('button',{type:'button',className:'button secondary',text:'형식 검증'});
    const load=x('button',{type:'button',className:'button secondary',text:'편집기에서 불러오기'}),restore=x('button',{type:'button',className:'button secondary',text:'편집기 이전 내용 복원',hidden:true});
    const status=x('p',{id:'wrapper-status',className:'ledger-status',role:'status'});
    const panel=x('details',{id:'harness-wrapper',className:'harness-wrapper'},x('summary',{text:'기존 프로그램 연결 프로필 · wrapper'}),
      x('p',{text:'지금 쓰는 프로그램을 고치지 않고 입력 · 출력 형식만 맞춘 harness JSON을 만듭니다. 이 빌더는 등록 · 실행 · 설치 · 모델 호출을 하지 않으며, 버튼을 누르기 전에는 편집기 내용을 바꾸지 않습니다.'}),
      x('div',{className:'wrapper-grid'},basic,targetBox,inputBox,outputBox),previewBox,x('div',{className:'button-row'},toEditor,check,load,restore),status);
    const say=(text,error)=>{status.textContent=text;status.classList.toggle('error',!!error);};
    const values=()=>Object.fromEntries(Object.entries(c).map(([k,v])=>[k,v.value]));
    const sync=()=>{const http=c.targetType.value==='http';for(const k of ['executable','args'])c[k].parentElement.hidden=http;c.url.parentElement.hidden=!http;
      for(const o of c.source.options)if(o.value==='file')o.disabled=http;for(const o of c.inputMode.options)if(o.value==='files')o.disabled=http;
      if(http&&c.source.value==='file')c.source.value='stdout';if(http&&c.inputMode.value==='files')c.inputMode.value='invocation';
      c.template.parentElement.hidden=c.inputMode.value!=='template';modeHint.textContent=MODES[c.inputMode.value][1];
      sourceHint.textContent=c.source.value==='file'?'프로그램이 args의 {output} 경로(임시 폴더의 output.json 고정)에 결과를 씁니다. 심볼릭 링크 · 일반 파일이 아닌 결과 · 크기 초과는 거부됩니다.':'프로그램이 stdout에 결과 하나를 출력합니다. 회당 180초 · 출력 150KB 제한이 같습니다.';};
    for(const k of ['targetType','inputMode','source'])c[k].addEventListener('change',sync);
    c.role.addEventListener('change',()=>{c.stage.value=c.role.value;});
    let previous=null,inserted=null;
    check.addEventListener('click',()=>{try{build(values());say('형식 검증 통과 · 경로 · 매핑 문법만 확인했습니다. 실행 파일 존재와 실제 출력은 로컬 companion이 확인합니다. 편집기는 바꾸지 않았습니다.');}catch(e){say(message(e),true);}});
    previewButton.addEventListener('click',()=>{result.hidden=true;checks.hidden=true;try{const p=preview(values(),c.sample.value,c.stage.value);result.textContent=pretty(p.value);result.hidden=false;
      const lines=[p.missing.length?'없는 최상위 필드: '+p.missing.join(', '):'기대 최상위 필드가 모두 있습니다.',p.extra.length?'추가 최상위 필드: '+p.extra.length+'개 · 실행 시 스키마 검사에서 거부될 수 있습니다.':'추가 최상위 필드 없음','하위 항목 · 인용 근거 검사는 실제 실행 때 앱이 합니다.'];
      checks.replaceChildren(...lines.map(t=>x('li',{text:t})));checks.hidden=false;say('미리보기 완료 · 합성 샘플 기준이며 실제 프로그램 호환성 확인이 아닙니다.');}catch(e){say(message(e),true);}});
    toEditor.addEventListener('click',()=>{const editor=doc.getElementById('harness-editor');if(!editor)return say(MSG.noEditor,true);
      try{const h=build(values());previous=editor.value;inserted=editor.value=pretty(h);editor.dispatchEvent(new Event('input',{bubbles:true}));restore.hidden=false;
        say('편집기에 넣었습니다. 아직 등록 · 실행하지 않았습니다. 내용을 확인한 뒤 「새 harness 버전 등록」을 직접 누르세요.');}catch(e){say(message(e),true);}});
    restore.addEventListener('click',()=>{const editor=doc.getElementById('harness-editor');if(!editor||previous===null)return;restore.hidden=true;
      if(editor.value!==inserted){previous=null;return say('넣은 뒤 편집기를 직접 고쳐서 되돌리지 않았습니다. 지금 편집기 내용을 그대로 둡니다.');}editor.value=previous;previous=null;restore.hidden=true;editor.dispatchEvent(new Event('input',{bubbles:true}));say('편집기를 넣기 전 내용으로 되돌렸습니다.');});
    load.addEventListener('click',()=>{const editor=doc.getElementById('harness-editor');if(!editor)return say(MSG.noEditor,true);
      try{let h;try{h=core().validate(JSON.parse(editor.value));}catch{throw fixed(MSG.editor);}const f=fieldsFrom(h);for(const [k,v] of Object.entries(f))if(c[k])c[k].value=v;c.stage.value=h.role;sync();
        say(h.adapter?.type==='wrapper'?'편집기의 wrapper 설정을 불러왔습니다.':'편집기의 기본 정보만 불러왔습니다. 이 harness는 wrapper가 아니라서 연결 설정은 그대로입니다.');}catch(e){say(message(e),true);}});
    sync();
    const anchor=manager.querySelector('.button-row');if(anchor)anchor.after(panel);else manager.append(panel);
    return true;}
  // The manager is created by another script after load, so wait for it with a bounded observer that always disconnects.
  function watch(doc,timeout=30000){if(!doc)return;const start=()=>{if(mount(doc))return;const obs=new MutationObserver(()=>{if(mount(doc))stop();}),timer=setTimeout(()=>stop(),timeout);
    function stop(){obs.disconnect();clearTimeout(timer);}obs.observe(doc.body||doc.documentElement,{childList:true,subtree:true});};
    if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',start,{once:true});else start();}
  return {build,preview,fieldsFrom,adapterFrom,message,mount,watch,EXPECTED,MSG};
});
