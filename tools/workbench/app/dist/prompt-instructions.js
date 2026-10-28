(function(root){'use strict';
  const PDF='원본 PDF 파일을 이 대화에 첨부하고 그 PDF를 기준으로 작업하세요.';
  const examples={red:'첨부한 논문의 취약한 주장에 대해 원문 인용과 변경안을 제안하세요. 각 변경은 원문 Before와 변경 After를 구분해 제시하세요.',blue:'첨부한 논문을 검토하세요. 발견 사항은 위치, 유형, 심각도, 인용, 이유, 확신도를 포함한 Markdown 표로 정리하고 검토 방법을 보고하세요.'};
  function compose(text,format){return [text,PDF,format].filter(x=>typeof x==='string'&&x.length).join('\n\n');}
  function mount(doc,role,source,status){
    const node=(tag,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
    const button=(text,fn)=>{const b=node('button',text);b.type='button';b.className='button secondary';b.addEventListener('click',fn);return b;};
    const panel=node('div');panel.className='prompt-instructions';
    const prompt=node('textarea');prompt.rows=5;prompt.value=examples[role];prompt.setAttribute('aria-label',role==='blue'?'편집할 BLUE 프롬프트':'편집할 프롬프트');
    const format=node('textarea');format.rows=2;format.setAttribute('aria-label','선택적 응답 형식');
    const name=node('input');name.type='text';name.setAttribute('aria-label','프롬프트 버전 이름');const versions=node('select');versions.setAttribute('aria-label','저장된 프롬프트 버전');
    const key='falsify.prompt-versions.v1.'+role;let saved=[],lastCopied;
    function refresh(){try{saved=JSON.parse(root.localStorage.getItem(key)||'[]');if(!Array.isArray(saved))saved=[];}catch{saved=[];}versions.replaceChildren();const blank=node('option','저장된 버전 선택');blank.value='';versions.append(blank);for(const v of saved){const o=node('option',v.name);o.value=v.id;versions.append(o);}}
    function save(){const label=name.value.trim();if(!label){status.textContent='버전 이름을 입력하세요.';return;}try{const id=root.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);saved.push({id,name:label,text:prompt.value,format:format.value});root.localStorage.setItem(key,JSON.stringify(saved));refresh();versions.value=id;status.textContent='프롬프트 버전을 저장했습니다.';}catch(e){status.textContent='저장하지 못했습니다: '+e.message;}}
    function load(){const v=saved.find(x=>x.id===versions.value);if(!v){status.textContent='불러올 버전을 선택하세요.';return;}prompt.value=v.text;format.value=v.format||'';name.value=v.name;status.textContent='프롬프트 버전을 불러왔습니다.';}
    const stored=node('details'),catalog=node('select');catalog.setAttribute('aria-label','공유 지시문');let catalogRows=[];
    async function refreshCatalog(){try{catalogRows=await root.FalsifyLab?.promptInstructions?.(role)||[];catalog.replaceChildren();const blank=node('option','공유 지시문 선택');blank.value='';catalog.append(blank);catalogRows.forEach((h,i)=>{const o=node('option',h.name+(h.version?' · '+h.version:''));o.value=String(i);catalog.append(o);});}catch(e){status.textContent='지시문 목록을 불러오지 못했습니다: '+e.message;}}
    stored.addEventListener('toggle',()=>{if(stored.open)refreshCatalog();});
    stored.append(node('summary','저장한 지시문·응답 형식'),node('label','버전 이름'),name,button('버전 저장',save),versions,button('버전 불러오기',load),node('label','공유 지시문'),catalog,button('목록 새로고침',refreshCatalog),button('공유 지시문 불러오기',()=>{const h=catalog.value!==''?catalogRows[Number(catalog.value)]:null;if(!h||typeof h.instructions!=='string'){status.textContent='불러올 지시문을 선택하세요.';return;}prompt.value=h.instructions;status.textContent='지시문을 불러왔습니다.';}),node('label','선택적 응답 형식'),format);
    const advanced=node('details');const include=node('input');include.type='checkbox';const includeLabel=node('label','추출된 원문 텍스트 포함');includeLabel.prepend(include);const harness=node('input');harness.type='checkbox';const harnessLabel=node('label','선택한 Harness 지침 포함');harnessLabel.prepend(harness);advanced.append(node('summary','고급 프롬프트 옵션'),includeLabel,harnessLabel);
    function assembled(){let result=compose(prompt.value,format.value);if(harness.checked){const h=root.FalsifyLab?.selectedHarness?.(role);if(h){const instructions=typeof h==='string'?h:h.instructions;if(typeof instructions==='string'&&instructions)result+='\n\n'+instructions;else{status.textContent='선택한 Harness에 지침이 없습니다.';return null;}}else{status.textContent='선택한 Harness가 없습니다.';return null;}}if(include.checked){const s=source();if(!s){status.textContent='원문 텍스트를 포함하려면 파일을 선택하세요.';return null;}const parts=role==='red'?(s.externalSegments||s.segments):s.segments;result+='\n\n'+(parts||[]).map(x=>'--- '+x.id+' ---\n'+x.text).join('\n\n');}return result;}
    panel.append(node('h3','지시문'),prompt,button('프롬프트 복사',async()=>{const text=assembled();if(text===null)return;try{await root.navigator.clipboard.writeText(text);lastCopied=text;status.textContent='복사했습니다. 원본 PDF를 첨부하세요.';}catch{prompt.select();status.textContent='복사하지 못했습니다. 브라우저의 클립보드 권한을 확인하세요.';}}),stored,advanced);refresh();return {panel,prompt,assembled,requested:()=>lastCopied};
  }
  const api={compose,mount,examples,PDF};root.FalsifyPromptInstructions=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis==='object'?globalThis:this);
