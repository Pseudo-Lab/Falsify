(function(root){'use strict';
  const PDF='원본 PDF 파일을 이 대화에 첨부하고 그 PDF를 기준으로 작업하세요.';
  const examples={red:'첨부한 논문의 취약한 주장에 대해 원문 인용과 변경안을 제안하세요. 각 변경은 원문 Before와 변경 After를 구분해 제시하세요.',blue:'첨부한 논문을 검토하세요. 발견 사항은 위치, 유형, 심각도, 인용, 이유, 확신도를 포함한 Markdown 표로 정리하고 검토 방법을 보고하세요.'};
  const BLUE_2STAGE_FORMAT=JSON.stringify({
    candidateLedger:[{candidateId:'C-1',page:1,locationLabel:'Results / Table 1',defectFamily:'D1',quote:'원문 인용',suspicion:'의심 내용'}],
    findings:[{reportNumber:'F-1',candidateId:'C-1',page:1,locationLabel:'Results / Table 1',findingType:'D1',verdictLabel:'아님',severity:'불일치',quote:'원문 인용',rationale:'왜 결함인가 (맞음 판정 시 원문 해소 근거 인용 필수)',confidence:'높음'}]
  },null,2);
  const BLUE_P0_PROMPT=[
    '첨부한 PDF만 사용해 독립·맹검 2단계 검증을 수행하세요.',
    '[맹검 금지 규칙] 논문 제목·저자·DOI에 대한 웹 검색, 외부 DB 조회, 이전 대화 기억을 절대 사용하지 마세요.',
    '[1단계 · candidateLedger 수집] 아래 전술 축에서 의심 후보를 빠짐없이 원장(candidateLedger)에 기록하세요:',
    '- D1 (수치·표·그림·통계): n/N (%) 불일치, 검정통계량–p값 정합성(단, Bonferroni/FDR/Benjamini-Hochberg/Holm/Tukey/Sidak/adjusted p/q-value/다중비교 보정 p가 맥락에 있고 보고 p ≥ 원시 p이면 정상 보정 예외 유의), 95% CI 경계 포함성, 표 합계·본문-표-그림 교차 수치 불일치.',
    '- D2 (참고문헌·링크·인용번호): 중복 참고문헌, 중복/오형식 DOI·하이퍼링크 불일치, 본문 [k] 인용번호 범위 초과.',
    '- D3/D4-1/S1 (범위·사전등록 지위·기전 극성): 하위군/제한 조건 결과를 전체 집단으로 외삽, 유의성 역전, 사후(post-hoc) 분석을 사전지정/1차 지표로 오표기, 기전·마커 극성 역전.',
    '[2단계 · findings 판정 및 Zero-Drop 규칙] candidateLedger의 모든 항목을 원문과 재대조해 판정하세요:',
    '- 아님: PDF 내부 근거만으로 명백한 결함 확정.',
    '- 확인필요: 의심되나 외부 원문·등록부 확인이 필요함. 스스로 탈락시키지 말고 반드시 보고하세요.',
    '- 맞음: 원문 내 해소 근거(resolutionQuote 또는 rationale)를 직접 인용한 경우에만 해소로 분류하세요.',
    '- 심각도 2단계 기준: "결론이 바뀌는 불일치"(주 결과 방향·통계적 유의성·핵심 결론 성립이 뒤집히는 경우만) vs "불일치"(그 외 모든 확정/의심 오류).'
  ].join('\n');
  const BLUE_P2_PROMPT=[
    BLUE_P0_PROMPT,
    '',
    '[P2 외부 오라클 근거 팩 결합 지침]',
    '- 함께 첨부된 결정론적 센서 및 외부 오라클(Crossref·Europe PMC·DataCite·ClinicalTrials.gov) 단서를 첨부 PDF와 대조해 교차 검증하세요.',
    '- 단, API 미검색(예: Crossref 404, 비학술지·단행본·사전출판물)이나 커버리지 공백은 절대 자동 조작 증명이 아니므로 반드시 PDF 원문과 대조한 뒤 판정하세요.'
  ].join('\n');
  const RED_ORACLE_PROMPT=[
    '첨부한 논문에 대해 외부·내부 오라클로 명확히 검증 가능한 결함 변이(D1~D4-1 · S1)를 제안하세요.',
    '- D1: 수치·표 셀·차트 좌표·통계량/백분율/신뢰구간 정합성 변조',
    '- D2: 참고문헌 서지·DOI·하이퍼링크 가로채기 또는 인용번호 불일치',
    '- D3: 하위군 결과를 전체 집단 결론으로 외삽하거나 통계적 유의성 방향 역전(애매한 유의어 완화 금지)',
    '- D4-1: 사후(post-hoc/exploratory) 분석을 사전지정(pre-specified)/1차 평가변수로 오표기',
    '- S1: 생물학적 기전·경로·마커 극성 역전',
    '[주의] "intentional error", "변조본", "수정된 오류" 같은 메타 힌트 문자열을 본문에 절대 남기지 마세요.'
  ].join('\n');
  const PRESETS={
    blue:[
      {id:'blue-p0-blind-2stage',label:'P0 · PDF 단독 맹검 2단계 검증 (기본)',tier:'P0',prompt:BLUE_P0_PROMPT,format:BLUE_2STAGE_FORMAT},
      {id:'blue-p2-oracle-2stage',label:'P2 · 오라클 근거 팩 결합 2단계 검증',tier:'P2',prompt:BLUE_P2_PROMPT,format:BLUE_2STAGE_FORMAT}
    ],
    red:[
      {id:'red-oracle-defects',label:'오라클 검증형 결함 주입 (D1~D4-1 · S1)',prompt:RED_ORACLE_PROMPT,format:JSON.stringify({changes:[{before:'원문 인용',after:'변경문',rationale:'이유',attackTypes:['D1'],evidence:[],references:[]}]},null,2)}
    ]
  };

  function compose(text,format,attachment=PDF){return [text,attachment,format].filter(x=>typeof x==='string'&&x.length).join('\n\n');}
  function attachment(source){if(!source)return '';const name=source.file?.name||source.name||'';return name?'원본 파일 '+name+'을 이 대화에 첨부하고 그 파일을 기준으로 작업하세요.':'선택한 원본 파일을 이 대화에 첨부하고 그 파일을 기준으로 작업하세요.';}
  function getSensor(rootObj){if(rootObj.FalsifyBlueDefectSensor)return rootObj.FalsifyBlueDefectSensor;if(typeof require==='function'){try{return require('./blue-defect-sensor-core.js');}catch{}}return null;}
  function buildEvidenceBlock(rootObj,sourceObj,tier,status){
    const s=sourceObj();
    if(!s){status.textContent='근거 팩을 포함하려면 파일을 선택하세요.';return null;}
    const sensor=getSensor(rootObj);
    if(!sensor){status.textContent='결정론적 센서 모듈이 준비되지 않았습니다.';return null;}
    const report=sensor.getActiveReport?.(s.fileHash)||sensor.scanSegments({fileHash:s.fileHash,segments:s.segments||[]});
    return sensor.formatEvidencePackBlock(report,{tier:tier==='P2'?'P2':'P0'});
  }
  function mountPresetControls(doc,role,stored,applyPreset){
    const presets=nodeWithPresets(doc,PRESETS[role]||[],applyPreset);
    stored.append(...presets);
  }
  function nodeWithPresets(doc,list,applyPreset){
    const label=doc.createElement('label');label.textContent='전술 프리셋';
    const sel=doc.createElement('select');sel.setAttribute('aria-label','전술 프리셋');
    const blank=doc.createElement('option');blank.value='';blank.textContent='전술 프리셋 선택';sel.append(blank);
    for(const p of list){const o=doc.createElement('option');o.value=p.id;o.textContent=p.label;sel.append(o);}
    const btn=doc.createElement('button');btn.type='button';btn.className='button secondary';btn.textContent='프리셋 적용';
    btn.addEventListener('click',()=>applyPreset(list.find(x=>x.id===sel.value)||null));
    return [label,sel,btn];
  }

  function mount(doc,role,source,status){
    const node=(tag,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
    const button=(text,fn)=>{const b=node('button',text);b.type='button';b.className='button secondary';b.addEventListener('click',fn);return b;};
    const panel=node('div');panel.className='prompt-instructions';
    const prompt=node('textarea');prompt.rows=5;prompt.value=examples[role];prompt.setAttribute('aria-label',role==='blue'?'편집할 BLUE 프롬프트':'편집할 프롬프트');
    const format=node('textarea');format.rows=2;format.setAttribute('aria-label','선택적 응답 형식');
    const name=node('input');name.type='text';name.setAttribute('aria-label','프롬프트 버전 이름');const versions=node('select');versions.setAttribute('aria-label','저장된 프롬프트 버전');
    const key='falsify.prompt-versions.v1.'+role;let saved=[],lastCopied,undoDraft=null;
    const undo=button('불러오기 실행 취소',()=>{if(!undoDraft)return;prompt.value=undoDraft.text;format.value=undoDraft.format;name.value=undoDraft.name;versions.value=undoDraft.version;undoDraft=null;undo.hidden=true;harnessDraft=null;harnessEdit.hidden=true;status.textContent='이전 작성 내용을 복원했습니다.';});undo.hidden=true;
    function remember(){undoDraft={text:prompt.value,format:format.value,name:name.value,version:versions.value};undo.hidden=false;}
    function refresh(){try{saved=JSON.parse(root.localStorage.getItem(key)||'[]');if(!Array.isArray(saved))saved=[];}catch{saved=[];}versions.replaceChildren();const blank=node('option','저장된 버전 선택');blank.value='';versions.append(blank);for(const v of saved){const o=node('option',v.name);o.value=v.id;versions.append(o);}}
    function save(){const label=name.value.trim();if(!label){status.textContent='버전 이름을 입력하세요.';return;}try{const id=root.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);saved.push({id,name:label,text:prompt.value,format:format.value});root.localStorage.setItem(key,JSON.stringify(saved));refresh();versions.value=id;status.textContent='프롬프트 버전을 저장했습니다.';}catch(e){status.textContent='저장하지 못했습니다: '+e.message;}}
    function load(){const v=saved.find(x=>x.id===versions.value);if(!v){status.textContent='불러올 버전을 선택하세요.';return;}remember();prompt.value=v.text;format.value=v.format||'';name.value=v.name;status.textContent='버전의 지시문과 응답 형식을 불러왔습니다.';}
    const harnessEdit=node('div');harnessEdit.hidden=true;const harnessVersion=node('input');harnessVersion.type='text';harnessVersion.setAttribute('aria-label','새 Harness 버전');let harnessDraft=null;
    const saveHarness=button('새 Harness 버전 등록',async()=>{try{if(!harnessDraft)return;await root.FalsifyLab.registerHarnessInstructions(harnessDraft.hash,prompt.value,harnessVersion.value.trim());harnessDraft=null;harnessEdit.hidden=true;status.textContent='새 Harness 버전을 등록했습니다. 실행 설정은 그대로입니다.';}catch(e){status.textContent='등록하지 못했습니다: '+e.message;}});
    harnessEdit.append(node('p','지침을 수정하고 새 버전을 등록하세요. 실행 설정은 유지됩니다.'),node('label','새 Harness 버전'),harnessVersion,saveHarness);
    doc.addEventListener('falsify:edit-harness-instructions',e=>{const h=e.detail;if(h?.role!==role)return;remember();harnessDraft=h;prompt.value=h.instructions;harnessVersion.value=h.version;harnessEdit.hidden=false;status.textContent=h.name+' 지침을 편집합니다. 기존 버전은 유지됩니다.';});
    const stored=node('details'),catalog=node('select');catalog.setAttribute('aria-label','공유 지시문');let catalogRows=[];
    async function refreshCatalog(){try{catalogRows=await root.FalsifyLab?.promptInstructions?.(role)||[];catalog.replaceChildren();const blank=node('option','공유 지시문 선택');blank.value='';catalog.append(blank);catalogRows.forEach((h,i)=>{const o=node('option',h.name+(h.version?' · '+h.version:''));o.value=String(i);catalog.append(o);});}catch(e){status.textContent='지시문 목록을 불러오지 못했습니다: '+e.message;}}
    stored.addEventListener('toggle',()=>{if(stored.open)refreshCatalog();});
    stored.append(node('summary','저장한 지시문·응답 형식'),node('label','버전 이름'),name,button('버전 저장',save),versions,button('버전 불러오기',load),node('label','공유 지시문'),catalog,button('목록 새로고침',refreshCatalog),button('공유 지시문 불러오기',()=>{const h=catalog.value!==''?catalogRows[Number(catalog.value)]:null;if(!h||typeof h.instructions!=='string'){status.textContent='불러올 지시문을 선택하세요.';return;}remember();prompt.value=h.instructions;status.textContent='공유 지시문을 불러왔습니다. 응답 형식은 유지됩니다.';}),undo,node('label','선택적 응답 형식'),format);
    const advanced=node('details');const include=node('input');include.type='checkbox';const includeLabel=node('label','추출된 원문 텍스트 포함');includeLabel.prepend(include);const harness=node('input');harness.type='checkbox';const harnessLabel=node('label','선택한 Harness 지침 포함');harnessLabel.prepend(harness);advanced.append(node('summary','고급 프롬프트 옵션'),includeLabel,harnessLabel);
    let includePack=null,tierSelect=null;
    if(role==='blue'){
      includePack=node('input');includePack.type='checkbox';const packLabel=node('label','결정론적 센서 · 오라클 근거 팩 포함');packLabel.prepend(includePack);
      tierSelect=node('select');tierSelect.setAttribute('aria-label','BLUE 근거 범위');
      for(const [val,lbl] of [['P0','P0 · 오프라인 센서 단서만'],['P2','P2 · 외부 오라클 대조 포함']]){const o=node('option',lbl);o.value=val;tierSelect.append(o);}
      advanced.append(packLabel,node('label','BLUE 근거 범위'),tierSelect);
    }
    mountPresetControls(doc,role,stored,preset=>{if(!preset){status.textContent='적용할 전술 프리셋을 선택하세요.';return;}remember();prompt.value=preset.prompt;format.value=preset.format||'';if(tierSelect&&preset.tier)tierSelect.value=preset.tier;status.textContent='전술 프리셋을 적용했습니다: '+preset.label;});
    function appendHarness(result){
      if(!harness.checked)return result;
      const h=root.FalsifyLab?.selectedHarness?.(role);
      const instructions=h?(typeof h==='string'?h:h.instructions):null;
      if(typeof instructions==='string'&&instructions)return result+'\n\n'+instructions;
      status.textContent=h?'선택한 Harness에 지침이 없습니다.':'선택한 Harness가 없습니다.';return null;
    }
    function assembled(){
      let result=compose(prompt.value,format.value,attachment(source()));
      result=appendHarness(result);if(result===null)return null;
      if(include.checked){const s=source();if(!s){status.textContent='원문 텍스트를 포함하려면 파일을 선택하세요.';return null;}const parts=role==='red'?(s.externalSegments||s.segments):s.segments;result+='\n\n'+(parts||[]).map(x=>'--- '+x.id+' ---\n'+x.text).join('\n\n');}
      if(includePack?.checked){const block=buildEvidenceBlock(root,source,tierSelect?.value,status);if(block===null)return null;result+='\n\n'+block;}
      return result;
    }
    const fallback=node('textarea');fallback.rows=8;fallback.readOnly=true;fallback.hidden=true;fallback.setAttribute('aria-label','수동 복사할 완성 프롬프트');
    panel.append(node('h3','지시문'),prompt,button('프롬프트 복사',async()=>{const text=assembled();if(text===null)return;try{await root.navigator.clipboard.writeText(text);lastCopied=text;fallback.hidden=true;status.textContent='복사했습니다. '+attachment(source())+(include.checked?' 추출된 원문 텍스트가 포함되었습니다.':'');}catch{fallback.value=text;fallback.hidden=false;fallback.focus?.();fallback.select();status.textContent='복사하지 못했습니다. 완성된 프롬프트를 선택해 직접 복사하세요.';}}),harnessEdit,stored,advanced,fallback);refresh();return {panel,prompt,assembled,requested:()=>lastCopied};
  }
  const api={compose,mount,examples,PDF,PRESETS};root.FalsifyPromptInstructions=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis==='object'?globalThis:this);
