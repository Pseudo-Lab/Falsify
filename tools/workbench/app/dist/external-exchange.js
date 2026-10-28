/* Portable, offline external response adapter. AGPL-3.0-only. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./external-red.js'));else root.FalsifyExternalExchange=factory(root.FalsifyExternalRed);})(typeof globalThis==='object'?globalThis:this,function(red){
  'use strict';
  const id=()=>typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():'external-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  const strings=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'):typeof v==='string'&&v?[v]:[];
  const evidence=v=>Array.isArray(v)?v.map(x=>JSON.parse(JSON.stringify(x))):typeof v==='string'&&v?[v]:[];
  // Each output code unit retains the corresponding original start/end offsets.
  function normalize(text){
    let value='',starts=[],ends=[];
    for(let i=0;i<text.length;){
      if(text[i]==='-'&&/\r|\n/.test(text[i+1]||'')){let j=i+1;while(j<text.length&&/\s/.test(text[j]))j++;if(j<text.length&&/[\p{L}]/u.test(text[j])){i=j;continue;}}
      if(/\s/.test(text[i])){let j=i+1;while(j<text.length&&/\s/.test(text[j]))j++;value+=' ';starts.push(i);ends.push(j);i=j;continue;}
      value+=text[i];starts.push(i);ends.push(i+1);i++;
    }
    return {value,starts,ends};
  }
  function locate(item,segments,needle){
    const q=normalize(needle).value.trim();if(!q)return;
    const finder=globalThis.FalsifyPaperAnchors?.find;
    if(typeof finder==='function'){
      const found=finder({quote:needle,segments,pageIndex:item.pageIndex,segmentId:item.segmentId});
      if(found&&Array.isArray(found.matches)){
        item.matches=found.matches;item.matchStatus=found.status;item.anchor=null;
        if(found.status==='matched'&&found.matches.length===1){const m=found.matches[0],s=segments.find(x=>x.id===m.segmentId);if(s&&Number.isInteger(m.start)&&Number.isInteger(m.end)){item.segmentId=m.segmentId;item.pageIndex=m.pageIndex;item.anchor={start:m.start,end:m.end};if(item.kind==='change')item.before=s.text.slice(m.start,m.end);else item.sourceQuote=s.text.slice(m.start,m.end);}}
        return;
      }
    }
    let scope=segments;
    if(item.segmentId)scope=scope.filter(s=>s.id===item.segmentId);
    if(item.pageIndex!=null)scope=scope.filter((s,i)=>(s.pageIndex??red.pageIndexFromLabel(s.label)??segments.indexOf(s))===item.pageIndex);
    const matches=[];
    for(const s of scope){const n=normalize(s.text);let at=0;while((at=n.value.indexOf(q,at))!==-1){const start=n.starts[at],end=n.ends[at+q.length-1],pageIndex=s.pageIndex??red.pageIndexFromLabel(s.label)??segments.indexOf(s);matches.push({segmentId:s.id,pageIndex,start,end});at++;if(matches.length>100)break;}}
    if(!matches.length&&(item.pageIndex!=null||item.segmentId)){const hintPage=item.pageIndex,hintSegment=item.segmentId;item.pageIndex=null;item.segmentId=null;locate(item,segments,needle);if(item.matchStatus==='missing'){item.pageIndex=hintPage;item.segmentId=hintSegment;}return;}
    item.matches=matches;item.matchStatus=matches.length===1?'matched':matches.length?'ambiguous':'missing';
    if(matches.length===1){const m=matches[0],s=segments.find(x=>x.id===m.segmentId);item.segmentId=m.segmentId;item.pageIndex=m.pageIndex;item.anchor={start:m.start,end:m.end};if(item.kind==='change')item.before=s.text.slice(m.start,m.end);else item.sourceQuote=s.text.slice(m.start,m.end);}
    else item.anchor=null;
  }
  function json(raw){const text=raw.trim().replace(/^\uFEFF/,'');try{return JSON.parse(text);}catch{}const fence=/```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);if(fence){try{return JSON.parse(fence[1]);}catch{}}return null;}
  function markdownFindings(raw){
    const lines=raw.split(/\r?\n/), cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(x=>x.trim().replace(/\\\|/g,'|'));
    const names=['번호','쪽','위치(절,그림,표)','유형','심각도','인용한 원문','왜 결함인가','확신'];
    for(let i=0;i+1<lines.length;i++){
      const header=cells(lines[i]).map(x=>x.replace(/\s/g,'')), index=names.map(n=>header.indexOf(n.replace(/\s/g,'')));
      if(index.some(n=>n<0)||!/^\s*\|?[\s:|\-]+\|?\s*$/.test(lines[i+1]))continue;
      const entries=[],malformed=[];let j=i+2;const fenced=i>0&&/^\s*`{3,}(?:\w+)?\s*$/.test(lines[i-1]);
      for(;j<lines.length;j++){if(!lines[j].includes('|')||!lines[j].trim())break;const row=cells(lines[j]);if(row.length<header.length){malformed.push(j+1);continue;}const v=index.map(n=>row[n]);const page=/^\s*(\d+)\s*(?:쪽|p(?:age)?\.?)?\s*$/i.exec(v[1]);entries.push({reportNumber:v[0],page:page?Number(page[1]):undefined,locationLabel:v[2],findingType:v[3],severity:v[4],quote:v[5],rationale:v[6],confidence:v[7]});}
      if(fenced&&/^\s*`{3,}\s*$/.test(lines[j]||''))j++;if(entries.length)return {entries,malformed,report:lines.slice(j).join('\n').trim()};
    }
    return null;
  }
  function parse(raw,options={}){
    if(typeof raw!=='string')throw new TypeError('Response must be text');
    const role=options.role;if(role!=='red'&&role!=='blue')throw new Error('Invalid role');
    const segments=Array.isArray(options.segments)?options.segments.filter(s=>s&&typeof s.id==='string'&&typeof s.text==='string'):[];
    const batch={schema:'falsify.external-batch.v1',id:id(),role,fileHash:options.fileHash,raw,importedAt:new Date().toISOString(),status:'unparsed',items:[],diagnostics:[]};
    for(const key of ['model','prompt','harness','requestId'])if(options[key]!=null)batch[key]=options[key];
    if(raw.length>red.LIMITS.inputChars){batch.diagnostics.push({code:'input-limit',message:'응답이 길이 한도를 넘어 자동으로 읽지 못했습니다. 원문은 보관됩니다.'});return batch;}
    const obj=json(raw);if(obj&&typeof obj==='object'&&!Array.isArray(obj)){
      for(const key of ['model','prompt','harness','requestId'])if(batch[key]==null&&obj[key]!=null)batch[key]=obj[key];
      for(const key of ['fileHash','sourceHash'])if(typeof obj[key]==='string'&&obj[key]&&typeof options[key]==='string'&&obj[key]!==options[key])batch.diagnostics.push({code:'file-hash-mismatch',message:'응답의 원문 식별이 현재 파일과 다릅니다. 확인이 필요합니다.',identity:key,claimed:obj[key]});
      if(typeof obj.role==='string'&&obj.role.toLowerCase()!==role)batch.diagnostics.push({code:'role-mismatch',message:'응답의 역할이 현재 작업과 다릅니다.'});
      if(['abstain','refusal'].includes(obj.status))batch.status=obj.status;
    }
    const table=role==='blue'&&!obj?markdownFindings(raw):null;if(table&&table.report)batch.report=table.report;if(table)for(const line of table.malformed)batch.diagnostics.push({code:'malformed-item',line,message:'이 표 행을 읽지 못했습니다.'});
    let list=table?table.entries:Array.isArray(obj)?obj:obj&&typeof obj==='object'?(role==='red'?(obj.changes??obj.candidates??obj.edits):(obj.findings??obj.items)):null;
    if(!Array.isArray(list)&&obj&&typeof obj==='object'&&(role==='red'?typeof obj.before==='string':typeof obj.quote==='string'||typeof obj.rationale==='string'))list=[obj];
    if(Array.isArray(list)){
      list.forEach((entry,index)=>{
        if(!entry||typeof entry!=='object'||Array.isArray(entry)||(role==='red'&&(typeof entry.before!=='string'||!entry.before.trim()||typeof entry.after!=='string'))){batch.diagnostics.push({code:'malformed-item',index,message:'이 항목을 읽지 못했습니다.'});return;}
        const item={id:id(),kind:role==='red'?'change':'finding',rationale:typeof entry.rationale==='string'?entry.rationale:typeof entry.description==='string'?entry.description:typeof entry.message==='string'?entry.message:'',evidence:evidence(entry.evidence),references:evidence(entry.references),attackTypes:strings(entry.attackTypes),uncertainty:typeof entry.uncertainty==='string'?entry.uncertainty:'',segmentId:typeof entry.segmentId==='string'?entry.segmentId:null,pageIndex:Number.isInteger(entry.pageIndex)&&entry.pageIndex>=0?entry.pageIndex:null,matchStatus:'missing',anchor:null,matches:[]};
        if(role==='blue'){for(const key of ['findingType','severity','confidence','locationLabel','reportNumber'])if(typeof entry[key]==='string')item[key]=entry[key];if(item.pageIndex===null&&Number.isInteger(entry.page)&&entry.page>0)item.pageIndex=entry.page-1;}
        if(role==='red'){item.before=entry.before;item.after=entry.after;locate(item,segments,item.before);}else{if(typeof entry.quote==='string'&&entry.quote){item.quote=entry.quote;locate(item,segments,item.quote);}if(!item.quote&&!item.rationale&&!item.evidence.length){batch.diagnostics.push({code:'malformed-item',index,message:'내용이 없는 지적입니다.'});return;}}
        batch.items.push(item);
      });
    }else if(role==='red'&&red&&segments.length&&options.fileHash){
      const parsed=red.parse(raw,{segments,fileHash:options.fileHash});batch.diagnostics.push(...parsed.diagnostics);
      const chunks=raw.split(/\n[ \t]*---[ \t]*(?:\n|$)/).filter(c=>/(?:^|\n)[ \t]*before[ \t]*:/i.test(c));
      for(const [index,p] of parsed.proposals.entries()){const field=name=>{const m=new RegExp('(?:^|\\n)[ \\t]*'+name+'[ \\t]*:[ \\t]*([^\\n]*)','i').exec(chunks[index]||'');return m?m[1].trim():'';};const item={id:id(),kind:'change',before:p.before,after:p.after,rationale:field('rationale'),evidence:strings(field('evidence')),references:strings(field('references')),attackTypes:[],uncertainty:field('uncertainty'),segmentId:p.segmentId,pageIndex:p.pageIndex,matchStatus:p.status,anchor:p.anchor,matches:p.matches};locate(item,segments,item.before);batch.items.push(item);}
    }else if(role==='blue'&&raw.trim()&&!obj){batch.items.push({id:id(),kind:'finding',rationale:raw.trim(),evidence:[],references:[],attackTypes:[],uncertainty:'',segmentId:null,pageIndex:null,matchStatus:'missing',anchor:null,matches:[]});}
    if(batch.items.length)batch.status='ok';
    return batch;
  }
  function buildPrompt(options={}){const role=options.role==='blue'?'blue':'red';const text=role==='red'?'원문의 취약한 주장에 대한 Before와 After를 제안하세요. 삭제는 빈 After입니다.':'원문의 문제점을 검토하고 근거와 참고자료를 제시하세요. 인용이 없으면 생략하세요.';const shape=role==='red'?'{"changes":[{"before":"원문 인용","after":"변경문","rationale":"이유","evidence":[],"references":[]}]}':'{"findings":[{"quote":"원문 인용 (선택)","rationale":"지적","evidence":[],"references":[]}]}';return [options.prompt||text,options.harness?(typeof options.harness==='string'?options.harness:JSON.stringify(options.harness,null,2)):'',Array.isArray(options.attackTypes)&&options.attackTypes.length?'공격 유형: '+options.attackTypes.join(', '):'', '응답 형식 (선택): '+shape,options.fileHash?'fileHash: '+options.fileHash:'',options.includeSource!==true?'첨부된 원본 PDF를 기준으로 검토하세요.':(options.segments||[]).map(s=>'--- '+s.id+' ---\n'+s.text).join('\n\n')].filter(Boolean).join('\n\n');}
  return {parse,buildPrompt};
});
