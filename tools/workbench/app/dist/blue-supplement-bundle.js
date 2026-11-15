/* Browser BLUE multi-file supplement, table, code & log cross-document audit. AGPL-3.0-only. */
(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.FalsifyBlueSupplementBundle=api;
})(typeof globalThis==='object'?globalThis:this,function(root){
  'use strict';

  const SCHEMA='falsify.blue-supplement-bundle.v1';
  const MAX_FILES=8;
  const MAX_TOTAL_BYTES=20*1024*1024;
  const MAX_SEGMENTS_PER_FILE=200;
  const CODE_EXTS=new Set(['json','log','py','r']);
  const FORBIDDEN_RED_KEYS=Object.freeze(['before','after','patch','gold','why_hard','candidateRationales','plan']);
  const PERCENT_METRICS=new Set(['accuracy','precision','sensitivity','specificity','f1','auc','auroc','auprc','r2']);

  const S_ITEM_PATTERNS=[
    {kind:'table',re:/\b(?:Supplementary|Supplemental|Supp\.?|Supporting|Extended\s+Data)\s+(?:Tables?|Tabs?\.?)\s*(?:S\s*)?(\d+[a-z]?)(?:\s*[-–—]\s*(?:S\s*)?(\d+))?\b/gi},
    {kind:'table',re:/\b(?:Tables?|Tabs?\.?|eTables?)\s+(S\d+[a-z]?)(?:\s*[-–—]\s*(S\d+))?\b/gi},
    {kind:'table',re:/보충\s*표\s*(?:S\s*)?(\d+[a-z]?)(?:\s*[-–—~]\s*(?:S\s*)?(\d+))?/g},
    {kind:'figure',re:/\b(?:Supplementary|Supplemental|Supp\.?|Supporting|Extended\s+Data)\s+(?:Figures?|Figs?\.?)\s*(?:S\s*)?(\d+[a-z]?)(?:\s*[-–—]\s*(?:S\s*)?(\d+))?\b/gi},
    {kind:'figure',re:/\b(?:Figures?|Figs?\.?|eFigures?|eFigs?\.?)\s+(S\d+[a-z]?)(?:\s*[-–—]\s*(S\d+))?\b/gi},
    {kind:'figure',re:/보충\s*(?:그림|도표)\s*(?:S\s*)?(\d+[a-z]?)(?:\s*[-–—~]\s*(?:S\s*)?(\d+))?/g},
    {kind:'data',re:/\b(?:Supplementary|Supplemental|Supp\.?|Supporting)\s+(?:Data|Datasets?|Files?)\s*(?:S\s*)?(\d+[a-z]?)(?:\s*[-–—]\s*(?:S\s*)?(\d+))?\b/gi},
    {kind:'data',re:/\bData\s+(S\d+[a-z]?)\b/gi},
    {kind:'data',re:/보충\s*(?:자료|데이터)\s*(?:S\s*)?(\d+[a-z]?)/g},
    {kind:'note',re:/\b(?:Supplementary|Supplemental|Supp\.?|Supporting)\s+(?:Notes?|Methods?|Text)\s*(?:S\s*)?(\d+[a-z]?)\b/gi},
    {kind:'note',re:/\b(?:Notes?|Methods?)\s+(S\d+[a-z]?)\b/gi},
    {kind:'appendix_table',re:/\bAppendix\s+(?:Table|Tab\.?)\s*([A-Z](?![a-z])|\d+)\b/g},
    {kind:'appendix_table',re:/부록\s*표\s*([A-Z]|\d+)/g},
    {kind:'appendix',re:/\bAppendix\s+([A-Z](?![a-z])|\d+)\b/g},
    {kind:'appendix',re:/부록\s*([A-Z](?![a-z])|\d+)/g}
  ];

  const COHORT_PATTERNS=[
    {tag:'discovery',re:/\bdiscovery(?:\s+cohort|\s+set|\s+sample)?\b/i},
    {tag:'validation',re:/\bvalidation(?:\s+cohort|\s+set|\s+sample)?\b/i},
    {tag:'replication',re:/\breplication(?:\s+cohort|\s+set)?\b/i},
    {tag:'training',re:/\btraining(?:\s+cohort|\s+set)?\b/i},
    {tag:'test',re:/\b(?:test|testing|held[- ]out)(?:\s+cohort|\s+set)?\b/i},
    {tag:'external',re:/\bexternal(?:\s+cohort|\s+validation)?\b/i},
    {tag:'internal',re:/\binternal(?:\s+cohort|\s+validation)?\b/i}
  ];

  const SUBGROUP_RE=/\b(?:subgroup|sub-group|arm\s*[a-z0-9]?|treatment\s+group|control\s+group|placebo|intervention|group\s+[a-z0-9]|per\s+(?:group|arm)|each\s+(?:group|arm)|excluded|dropout|missing|lost\s+to\s+follow|subset|stratum|fold\s*\d+)\b|하위군|대조군|실험군|제외/i;
  const METRIC_RE=/(?:"?(accuracy|acc|auroc|auprc|roc[-_ ]?auc|auc|c[- ]?index|f1(?:[-_ ]?score)?|precision|recall|sensitivity|specificity|r\^?2|r²|rmse|mae|mse|kappa|a?or|a?rr|a?hr|p[-_ ]?val(?:ue)?|\bp\b|정확도|민감도|특이도|정밀도|재현율)"?)\s*(=|:|<|<=|>|>=|≤|≥)\s*([-−]?\d*\.?\d+(?:[eE][-−+]?\d+)?)\s*(%)?/gi;

  function normText(t){
    return String(t||'').replace(/−/g,'-').replace(/≤/g,'<=').replace(/≥/g,'>=');
  }
  function snippet(text,start,end,radius=60){
    const lo=Math.max(0,start-radius),hi=Math.min(text.length,end+radius);
    return text.slice(lo,hi).replace(/\s+/g,' ').trim();
  }
  function countDecimals(tok){
    const m=/\.(\d+)/.exec(String(tok||''));
    return m?m[1].length:0;
  }
  function safeFloat(tok){
    const s=normText(tok).replace(/,/g,'').trim();
    const n=Number(s);
    return Number.isFinite(n)?n:null;
  }
  function pageIndexOf(seg,idx){
    if(Number.isInteger(seg?.pageIndex)&&seg.pageIndex>=0)return seg.pageIndex;
    const m=/(?:PDF p\.|p(?:age)?\.?)\s*(\d+)/i.exec(String(seg?.label||''));
    return m?Math.max(0,Number(m[1])-1):idx;
  }
  function assertNoRedKeys(value,seen=new WeakSet()){
    if(!value||typeof value!=='object')return;
    if(seen.has(value))return;
    seen.add(value);
    if(Array.isArray(value)){
      for(const item of value)assertNoRedKeys(item,seen);
      return;
    }
    for(const key of Object.keys(value)){
      if(FORBIDDEN_RED_KEYS.includes(key))throw new Error('Blindness guard violation: forbidden RED key "'+key+'"');
      assertNoRedKeys(value[key],seen);
    }
  }
  function inferSupplementKind(name){
    const low=String(name||'').toLowerCase();
    if(/\.(?:csv|tsv)$/.test(low))return 'table-data';
    if(/\.(?:py|r|log|json)$/.test(low))return 'code-or-log';
    return 'supplement-doc';
  }
  function kindLabel(kind){
    if(kind==='table-data')return '표·데이터';
    if(kind==='code-or-log')return '코드·로그';
    return '보충문서';
  }

  function formatSItem(kind,tok){
    const clean=String(tok||'').trim();
    if(kind==='table'){const n=clean.replace(/^s/i,'');return {key:'table:s'+n.toLowerCase(),label:'Table S'+n};}
    if(kind==='figure'){const n=clean.replace(/^s/i,'');return {key:'figure:s'+n.toLowerCase(),label:'Figure S'+n};}
    if(kind==='data'){const n=clean.replace(/^s/i,'');return {key:'data:s'+n.toLowerCase(),label:'Supplementary Data '+n};}
    if(kind==='note'){const n=clean.replace(/^s/i,'');return {key:'note:s'+n.toLowerCase(),label:'Supplementary Note '+n};}
    if(kind==='appendix_table')return {key:'appendix-table:'+clean.toLowerCase(),label:'Appendix Table '+clean.toUpperCase()};
    return {key:'appendix:'+clean.toLowerCase(),label:'Appendix '+clean.toUpperCase()};
  }
  function expandSItemTokens(startTok,endTok){
    if(!endTok)return [startTok];
    const a=Number(String(startTok).replace(/^s/i,'')),b=Number(String(endTok).replace(/^s/i,''));
    if(!Number.isInteger(a)||!Number.isInteger(b)||b<a||b-a>20)return [startTok,endTok];
    const list=[];
    for(let i=a;i<=b;i++)list.push(String(i));
    return list;
  }
  function extractSupplementaryItems(text){
    const hay=String(text||''),out=[];
    for(const spec of S_ITEM_PATTERNS){
      spec.re.lastIndex=0;
      let m;
      while((m=spec.re.exec(hay))!==null){
        for(const tok of expandSItemTokens(m[1],m[2])){
          const fmt=formatSItem(spec.kind,tok);
          out.push({...fmt,raw:m[0],index:m.index});
        }
      }
    }
    return out;
  }
  function parentSKey(key){
    const m=/^([a-z-]+:s\d+)[a-z]$/.exec(key);
    return m?m[1]:null;
  }

  function normalizeSegments(raw){
    if(!Array.isArray(raw))return [];
    return raw.filter(s=>s&&typeof s.text==='string'&&s.text.trim()).map((s,i)=>({
      id:s.id||('s'+i),
      label:String(s.label||('구간 '+(i+1))),
      text:s.text,
      pageIndex:pageIndexOf(s,i)
    }));
  }
  function normalizeSupplement(supp,idx){
    const name=String(supp?.name||'supplement-'+(idx+1));
    const kind=supp?.kind||inferSupplementKind(name);
    let segs=normalizeSegments(supp?.segments);
    if(!segs.length&&typeof supp?.text==='string'&&supp.text.trim()){
      segs=[{id:'s0',label:name,text:supp.text,pageIndex:0}];
    }
    return {fileId:supp?.fileId||('supp-file-'+idx),name,fileHash:supp?.fileHash||null,kind,segments:segs};
  }
  function toSupplementalSegments(supplements){
    const list=Array.isArray(supplements)?supplements:[];
    const out=[];
    list.forEach((raw,fileIdx)=>{
      const supp=normalizeSupplement(raw,fileIdx);
      supp.segments.forEach((seg,segIdx)=>{
        out.push({
          id:'supp-'+fileIdx+'-'+segIdx,
          label:'[보충: '+supp.name+' · '+seg.label+']',
          text:seg.text
        });
      });
    });
    return out;
  }

  function nameForSearch(name){
    return String(name||'').replace(/[_-]+/g,' ').replace(/\b([Tt]able|[Ff]ig(?:ure)?)\s*S(\d+)/g,'$1 S$2');
  }
  function collectPresentItems(supps){
    const keys=new Set(),labels=new Map();
    for(const supp of supps){
      const fnItems=extractSupplementaryItems(nameForSearch(supp.name));
      for(const it of fnItems){
        keys.add(it.key);labels.set(it.key,it.label);
        const pk=parentSKey(it.key);if(pk)keys.add(pk);
      }
      for(const seg of supp.segments){
        for(const it of extractSupplementaryItems(seg.label+'\n'+seg.text)){
          keys.add(it.key);labels.set(it.key,it.label);
          const pk=parentSKey(it.key);if(pk)keys.add(pk);
        }
      }
    }
    return {keys,labels:[...labels.values()]};
  }
  function detectMissingSupplements(mainSegs,supps){
    if(!supps.length)return {citedLabels:[],presentLabels:[],signals:[]};
    const present=collectPresentItems(supps);
    const citedMap=new Map(),signals=[];
    const suppNames=supps.map(s=>s.name).slice(0,4).join(', ');
    for(const seg of mainSegs){
      for(const it of extractSupplementaryItems(seg.text)){
        if(!citedMap.has(it.key))citedMap.set(it.key,{...it,seg});
      }
    }
    for(const [key,it] of citedMap){
      if(present.keys.has(key))continue;
      const ex=snippet(it.seg.text,it.index,it.index+it.raw.length);
      signals.push({
        family:'D4-1',category:'D4-1',kind:'missing_supplementary_item',
        segmentId:it.seg.id,pageIndex:it.seg.pageIndex,supplementFile:null,excerpt:ex,
        detail:'본문이 '+it.label+'을(를) 인용했으나 첨부 보충자료('+suppNames+')에 해당 항목이 없습니다.',
        reported:{item:it.label,rawCitation:it.raw},
        computed:{presentItems:present.labels,attachedFiles:supps.map(s=>s.name)}
      });
    }
    return {citedLabels:[...citedMap.values()].map(x=>x.label),presentLabels:present.labels,signals};
  }

  function extractCohortTag(ctx,fileName){
    const text=String(ctx||'')+' '+nameForSearch(fileName);
    for(const spec of COHORT_PATTERNS){
      if(spec.re.test(text))return spec.tag;
    }
    const cm=/\bcohort\s+([A-Z0-9])\b/i.exec(text);
    return cm?'cohort:'+cm[1].toLowerCase():'';
  }
  function pushSampleClaim(claims,seen,value,ctx,meta){
    if(!Number.isInteger(value)||value<2||value>10000000)return;
    const key=meta.fileName+':'+meta.segmentId+':'+value+':'+meta.tag;
    if(seen.has(key))return;
    seen.add(key);
    claims.push({
      value,
      cohortTag:meta.tag||extractCohortTag(ctx,meta.fileName),
      anchorKey:meta.anchorKey||null,
      segmentId:meta.segmentId,
      pageIndex:meta.pageIndex,
      fileName:meta.fileName,
      sourceType:meta.sourceType,
      excerpt:meta.excerpt
    });
  }
  function scanRegexSampleSizes(text,re,claims,seen,meta,guardSubgroup){
    re.lastIndex=0;
    let m;
    while((m=re.exec(text))!==null){
      const ctx=text.slice(Math.max(0,m.index-70),Math.min(text.length,m.index+m[0].length+70));
      if(guardSubgroup&&SUBGROUP_RE.test(ctx)&&!/\b(?:total|overall|entire|all)\b|전체|총/i.test(ctx))continue;
      const val=Number(m[1]);
      const items=extractSupplementaryItems(ctx);
      pushSampleClaim(claims,seen,val,ctx,{...meta,tag:extractCohortTag(ctx,meta.fileName),anchorKey:items[0]?.key||meta.anchorKey,excerpt:snippet(text,m.index,m.index+m[0].length)});
    }
  }
  function extractTextSampleClaims(seg,fileName,isSupplement,defaultAnchor){
    const text=normText(seg.text),claims=[],seen=new Set();
    const base={segmentId:seg.id,pageIndex:seg.pageIndex,fileName,anchorKey:defaultAnchor,sourceType:isSupplement?'supplement_text':'main_text'};
    scanRegexSampleSizes(text,/\bN\s*=\s*(\d{2,7})\b/g,claims,seen,base,true);
    scanRegexSampleSizes(text,/(?:total|overall|entire)\s+(?:sample\s+size|cohort|participants?|patients?|subjects?|samples?|mice)?\s*(?:of|was|were|:|=)?\s*[Nn]?\s*=?\s*(\d{2,7})\b/gi,claims,seen,base,false);
    scanRegexSampleSizes(text,/\bn\s*=\s*(\d{2,7})\s*(?:patients?|participants?|subjects?|individuals?|mice|animals?|samples?|cases?|명|마리|건)(?![A-Za-z0-9가-힣])/g,claims,seen,base,true);
    scanRegexSampleSizes(text,/(?:전체|총)\s*(?:표본|대상자|환자|참여자|샘플|검체|마리|건)?\s*(?:수)?\s*(?:[Nn]\s*=|:)?\s*(\d{2,7})\s*(?:명|마리|개|건)?/g,claims,seen,base,false);
    if(isSupplement){
      scanRegexSampleSizes(text,/"?(?:total_samples|sample_size|sampleSize|n_samples|total_rows|num_samples|total_n|nrow)"?\s*[:=]\s*(\d{2,7})\b/gi,claims,seen,{...base,sourceType:'supplement_log'},false);
      scanRegexSampleSizes(text,/\b(?:Loaded|Analyzed|Processed|Total\s+(?:rows|samples|subjects|patients)|Dataset\s+shape)\s*[:=(]?\s*(\d{2,7})(?:\s*(?:rows|samples|subjects|patients|records)|\s*,\s*\d+\s*\))/gi,claims,seen,{...base,sourceType:'supplement_log'},false);
    }
    return claims;
  }

  function parseDelimitedRows(text){
    const lines=String(text||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    if(lines.length<2)return null;
    const delim=lines[0].includes('\t')?'\t':(lines[0].includes(',')?',':null);
    if(!delim)return null;
    const rows=lines.map(l=>l.split(delim).map(c=>c.trim().replace(/^"|"$/g,'')));
    const cols=rows[0].length;
    if(cols<2||!rows.slice(1,4).every(r=>r.length===cols))return null;
    return rows;
  }
  function looksLikeSummaryTable(headers){
    const joined=headers.join(' ').toLowerCase();
    const hasEntity=/\b(?:id|patient|subject|sample|participant|mouse|animal|case|record|specimen)\b/.test(joined);
    const hasMetric=/\b(?:metric|measure|statistic|model|method|parameter|fold|epoch|auc|accuracy)\b/.test(joined);
    return hasMetric&&!hasEntity;
  }
  function extractCsvSampleClaims(supp,defaultAnchor){
    if(supp.kind!=='table-data'||SUBGROUP_RE.test(nameForSearch(supp.name)))return [];
    const joined=supp.segments.map(s=>s.text).join('\n');
    const rows=parseDelimitedRows(joined);
    if(!rows)return [];
    const hasHeader=rows[0].some(c=>/[A-Za-z가-힣]/.test(c)&&!/^-?\d+(\.\d+)?%?$/.test(c));
    if(hasHeader&&looksLikeSummaryTable(rows[0]))return [];
    const dataRows=rows.slice(hasHeader?1:0).filter(r=>!/^(?:total|summary|mean|overall)$/i.test(r[0]||''));
    if(dataRows.length<5)return [];
    return [{
      value:dataRows.length,
      cohortTag:extractCohortTag('',supp.name),
      anchorKey:defaultAnchor,
      segmentId:supp.segments[0]?.id||'s0',
      pageIndex:0,
      fileName:supp.name,
      sourceType:'csv_row_count',
      excerpt:supp.name+' ('+dataRows.length+' data rows)'
    }];
  }

  function sampleClaimsCompatible(mc,sc){
    if(mc.anchorKey&&sc.anchorKey&&mc.anchorKey!==sc.anchorKey)return false;
    if(mc.cohortTag&&sc.cohortTag&&mc.cohortTag!==sc.cohortTag)return false;
    return true;
  }
  function detectSampleSizeMismatches(mainSegs,supps){
    const mainClaims=[],suppClaims=[];
    for(const seg of mainSegs)mainClaims.push(...extractTextSampleClaims(seg,'main',false,null));
    for(const supp of supps){
      const fnItems=extractSupplementaryItems(nameForSearch(supp.name));
      const defAnchor=fnItems[0]?.key||null;
      for(const seg of supp.segments)suppClaims.push(...extractTextSampleClaims(seg,supp.name,true,defAnchor));
      suppClaims.push(...extractCsvSampleClaims(supp,defAnchor));
    }
    const signals=[],seen=new Set();
    for(const mc of mainClaims){
      const matchingCohort=suppClaims.filter(sc=>sampleClaimsCompatible(mc,sc));
      if(!matchingCohort.length||matchingCohort.some(sc=>sc.value===mc.value))continue;
      const sc=matchingCohort[0];
      const key=mc.value+'!='+sc.value+':'+sc.fileName;
      if(seen.has(key))continue;
      seen.add(key);
      signals.push({
        family:'D1',category:'D1',kind:'cross_file_sample_size_mismatch',
        segmentId:mc.segmentId,pageIndex:mc.pageIndex,supplementFile:sc.fileName,
        excerpt:mc.excerpt,
        detail:'본문 표본 수(N='+mc.value+')가 보충자료 '+sc.fileName+'('+sc.value+')와 일치하지 않습니다.',
        reported:{mainN:mc.value,cohort:mc.cohortTag||null,mainExcerpt:mc.excerpt},
        computed:{supplementN:sc.value,sourceType:sc.sourceType,supplementFile:sc.fileName,supplementExcerpt:sc.excerpt}
      });
    }
    return signals;
  }

  const METRIC_ALIASES=Object.freeze({
    accuracy:'accuracy',acc:'accuracy',정확도:'accuracy',
    auc:'auc',auroc:'auc',rocauc:'auc',cindex:'auc',
    auprc:'auprc',prauc:'auprc',
    f1:'f1',f1score:'f1',
    precision:'precision',정밀도:'precision',
    recall:'sensitivity',sensitivity:'sensitivity',민감도:'sensitivity',재현율:'sensitivity',
    specificity:'specificity',특이도:'specificity',
    r2:'r2','r²':'r2',
    p:'p',pval:'p',pvalue:'p'
  });
  function canonicalMetricKey(raw){
    const k=String(raw||'').toLowerCase().replace(/[^a-z0-9가-힣²]+/g,'');
    return Object.hasOwn(METRIC_ALIASES,k)?METRIC_ALIASES[k]:k;
  }
  function extractMetricsFromText(text,meta){
    const norm=normText(text),out=[];
    METRIC_RE.lastIndex=0;
    let m;
    while((m=METRIC_RE.exec(norm))!==null){
      const val=safeFloat(m[3]);
      if(val===null)continue;
      out.push({
        metricKey:canonicalMetricKey(m[1]),
        op:m[2],
        value:val,
        isPercent:Boolean(m[4]),
        decimals:countDecimals(m[3]),
        anchorKey:meta.anchorKey||null,
        suppKind:meta.suppKind||null,
        fileName:meta.fileName||null,
        segmentId:meta.segmentId,
        pageIndex:meta.pageIndex,
        excerpt:snippet(norm,m.index,m.index+m[0].length)
      });
    }
    return out;
  }
  function extractMainMetricClaims(mainSegs){
    const claims=[];
    for(const seg of mainSegs){
      const sentences=String(seg.text||'').split(/(?<=[.!?])\s+|\r?\n+/);
      for(const sent of sentences){
        const items=extractSupplementaryItems(sent);
        const anchor=items[0]?.key||null;
        claims.push(...extractMetricsFromText(sent,{anchorKey:anchor,segmentId:seg.id,pageIndex:seg.pageIndex,fileName:'main'}));
      }
    }
    return claims;
  }
  function parseCellMetricValue(raw){
    const m=/^\s*([-−]?\d*\.?\d+(?:[eE][-−+]?\d+)?)\s*(%)?\s*$/.exec(normText(raw));
    if(!m)return null;
    const val=safeFloat(m[1]);
    return val===null?null:{value:val,isPercent:Boolean(m[2]),decimals:countDecimals(m[1])};
  }
  function extractCsvMetricClaims(supp,defaultAnchor){
    if(supp.kind!=='table-data')return [];
    const rows=parseDelimitedRows(supp.segments.map(s=>s.text).join('\n'));
    if(!rows||rows.length<2)return [];
    const headers=rows[0].map(canonicalMetricKey),out=[];
    for(const row of rows.slice(1)){
      for(let c=0;c<headers.length;c++){
        const parsed=parseCellMetricValue(row[c]);
        if(!parsed||!headers[c])continue;
        out.push({metricKey:headers[c],op:'=',...parsed,anchorKey:defaultAnchor,suppKind:supp.kind,fileName:supp.name,segmentId:'s0',pageIndex:0,excerpt:row.join(', ').slice(0,140)});
      }
      if(row.length>=2){
        const key=canonicalMetricKey(row[0]),parsed=parseCellMetricValue(row[1]);
        if(key&&parsed)out.push({metricKey:key,op:'=',...parsed,anchorKey:defaultAnchor,suppKind:supp.kind,fileName:supp.name,segmentId:'s0',pageIndex:0,excerpt:row.join(', ').slice(0,140)});
      }
    }
    return out;
  }
  function extractSupplementMetrics(supps){
    const claims=[];
    for(const supp of supps){
      const fnItems=extractSupplementaryItems(nameForSearch(supp.name));
      let activeAnchor=fnItems[0]?.key||null;
      for(const seg of supp.segments){
        const lines=String(seg.text||'').split(/\r?\n/);
        for(const line of lines){
          const found=extractSupplementaryItems(line);
          if(found.length)activeAnchor=found[0].key;
          claims.push(...extractMetricsFromText(line,{anchorKey:activeAnchor,suppKind:supp.kind,fileName:supp.name,segmentId:seg.id,pageIndex:seg.pageIndex}));
        }
      }
      claims.push(...extractCsvMetricClaims(supp,fnItems[0]?.key||null));
    }
    return claims;
  }
  function scaledMetricPair(a,b){
    let va=a.value,da=a.decimals,vb=b.value,db=b.decimals;
    if(a.isPercent!==b.isPercent&&PERCENT_METRICS.has(a.metricKey)){
      if(!a.isPercent&&va>=0&&va<=1.000001){va*=100;da=Math.max(0,da-2);}
      else if(!b.isPercent&&vb>=0&&vb<=1.000001){vb*=100;db=Math.max(0,db-2);}
    }
    return {va,da,vb,db};
  }
  function metricsConsistent(a,b){
    const {va,da,vb,db}=scaledMetricPair(a,b);
    const tol=0.5*Math.pow(10,-Math.min(da,db))+1e-6;
    if(a.op==='<'&&b.op==='=')return vb<va+tol;
    if(a.op==='<='&&b.op==='=')return vb<=va+tol;
    if(a.op==='>'&&b.op==='=')return vb>va-tol;
    if(a.op==='>='&&b.op==='=')return vb>=va-tol;
    if(b.op==='<'&&a.op==='=')return va<vb+tol;
    if(b.op==='<='&&a.op==='=')return va<=vb+tol;
    return Math.abs(va-vb)<=tol;
  }
  function detectMetricMismatches(mainSegs,supps){
    const mainClaims=extractMainMetricClaims(mainSegs);
    const suppClaims=extractSupplementMetrics(supps);
    const signals=[],seen=new Set();
    for(const mc of mainClaims){
      const candidates=suppClaims.filter(sc=>{
        if(sc.metricKey!==mc.metricKey)return false;
        if(mc.anchorKey)return sc.anchorKey===mc.anchorKey;
        return sc.suppKind==='code-or-log';
      });
      if(!candidates.length||candidates.some(sc=>metricsConsistent(mc,sc)))continue;
      const sc=candidates[0];
      const k=mc.metricKey+':'+(mc.anchorKey||'log')+':'+mc.value+'!='+sc.value+':'+sc.fileName;
      if(seen.has(k))continue;
      seen.add(k);
      const loc=mc.anchorKey?mc.anchorKey.replace(':',' ').toUpperCase():sc.fileName;
      signals.push({
        family:'D1',category:'D1',kind:'cross_file_metric_mismatch',
        segmentId:mc.segmentId,pageIndex:mc.pageIndex,supplementFile:sc.fileName,
        excerpt:mc.excerpt,
        detail:'본문 '+mc.metricKey+'='+mc.value+(mc.isPercent?'%':'')+' ('+loc+') ↔ 보충자료 '+sc.fileName+' 보고값 '+sc.value+(sc.isPercent?'%':''),
        reported:{metric:mc.metricKey,anchor:mc.anchorKey,value:mc.value,operator:mc.op,isPercent:mc.isPercent},
        computed:{supplementValue:sc.value,operator:sc.op,isPercent:sc.isPercent,supplementFile:sc.fileName,supplementExcerpt:sc.excerpt}
      });
    }
    return signals;
  }

  function countAuditSignals(signals){
    const byKind={missing_supplementary_item:0,cross_file_sample_size_mismatch:0,cross_file_metric_mismatch:0};
    let d1=0,d4_1=0;
    for(const s of signals){
      if(s.family==='D1')d1++;
      else if(s.family==='D4-1')d4_1++;
      if(Object.hasOwn(byKind,s.kind))byKind[s.kind]++;
    }
    return {total:signals.length,d1,d4_1,byKind};
  }
  function auditMainVsSupplements({mainSegments=[],supplements=[]}={}){
    assertNoRedKeys(mainSegments);
    assertNoRedKeys(supplements);
    const mainSegs=normalizeSegments(mainSegments).filter(s=>!String(s.id).startsWith('supp-'));
    const supps=(Array.isArray(supplements)?supplements:[]).map(normalizeSupplement);
    const miss=detectMissingSupplements(mainSegs,supps);
    const nMismatches=detectSampleSizeMismatches(mainSegs,supps);
    const metricMismatches=detectMetricMismatches(mainSegs,supps);
    const signals=[...miss.signals,...nMismatches,...metricMismatches].map((s,i)=>({...s,id:'SUPP-'+(i+1)}));
    const report={
      schema:SCHEMA,
      supplementCount:supps.length,
      citedItems:miss.citedLabels,
      presentItems:miss.presentLabels,
      signals,
      counts:countAuditSignals(signals)
    };
    assertNoRedKeys(report);
    return report;
  }

  async function sha256Hex(bytes){
    if(root.crypto?.subtle){
      const digest=await root.crypto.subtle.digest('SHA-256',bytes);
      return Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('');
    }
    const {createHash}=require('node:crypto');
    return createHash('sha256').update(bytes).digest('hex');
  }
  function splitTextSegments(text,ext){
    const clean=String(text||'').replace(/\r\n?/g,'\n');
    const blocks=clean.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean);
    const prefix=ext.toUpperCase()+' 구간 ';
    if(!blocks.length)return [];
    return blocks.slice(0,MAX_SEGMENTS_PER_FILE).map((block,i)=>({id:'s'+i,label:prefix+(i+1),text:block}));
  }
  async function readCodeFallback(file,ext){
    let bytes;
    if(typeof file.arrayBuffer==='function'){
      bytes=new Uint8Array(await file.arrayBuffer());
    }else if(typeof file.text==='function'){
      bytes=new TextEncoder().encode(await file.text());
    }else{
      throw new Error('파일을 읽을 수 없습니다.');
    }
    const text=typeof file.text==='function'?await file.text():new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(text.includes('\0'))throw new Error('바이너리 파일은 보충 텍스트로 읽을 수 없습니다.');
    const segments=splitTextSegments(text,ext);
    if(!segments.length)throw new Error('추출 가능한 텍스트가 없습니다.');
    return {bytes,segments,fileHash:await sha256Hex(bytes)};
  }
  async function extractSupplementFile(file,options={}){
    if(!file||!file.name)throw new Error('유효한 보충자료 파일이 아닙니다.');
    const ext=String(file.name.split('.').pop()||'').toLowerCase();
    const importer=root.FalsifyImport;
    if(importer&&typeof importer.extract==='function'){
      try{
        const imported=await importer.extract(file,options);
        const bytes=typeof file.arrayBuffer==='function'?new Uint8Array(await file.arrayBuffer()):new TextEncoder().encode(imported.text||'');
        return {fileId:file.name+':'+bytes.length,name:file.name.slice(0,160),fileHash:await sha256Hex(bytes),kind:inferSupplementKind(file.name),segments:normalizeSegments(imported.segments)};
      }catch(err){
        if(!CODE_EXTS.has(ext)||err?.name==='AbortError')throw err;
      }
    }
    if(!CODE_EXTS.has(ext)&&typeof importer?.extract==='function')throw new Error('지원하지 않는 보충자료 형식입니다.');
    const fb=await readCodeFallback(file,ext||'txt');
    return {fileId:file.name+':'+fb.bytes.length,name:file.name.slice(0,160),fileHash:fb.fileHash,kind:inferSupplementKind(file.name),segments:fb.segments};
  }

  function insertSupplementPanel(host,section){
    const sensor=host.querySelector?.('#blue-defect-sensor')||(typeof host.ownerDocument?.getElementById==='function'?host.ownerDocument.getElementById('blue-defect-sensor'):null);
    if(sensor&&typeof sensor.after==='function'){sensor.after(section);return;}
    const steps=host.querySelectorAll?.('.role-step');
    const first=steps?.length?steps[0]:host.children?.find?.(c=>String(c.className||'').includes('role-step'));
    if(first&&typeof first.after==='function')first.after(section);
    else host.append(section);
  }
  function createEl(doc,tag,text,cls){
    const el=doc.createElement(tag);
    if(text!==undefined)el.textContent=text;
    if(cls)el.className=cls;
    return el;
  }
  function buildPanelDom(doc){
    const section=createEl(doc,'section',undefined,'blue-supplement-panel');
    section.id='blue-supplement-panel';
    const head=createEl(doc,'div',undefined,'blue-supplement-head');
    const titleWrap=createEl(doc,'div',undefined,'blue-supplement-title-wrap');
    titleWrap.append(createEl(doc,'h3','보충자료 · 코드·로그 묶음 교차 검증 (다중 파일)'),createEl(doc,'span','선택 사항 · P0 오프라인','blue-supplement-badge'));
    head.append(titleWrap);
    const help=createEl(doc,'p','보충문서(PDF·DOCX·TXT)·표(CSV·TSV)·코드/로그(.py·.r·.json·.log)를 최대 8개(합계 20 MiB)까지 추가하면 본문과 교차 검증합니다.','blue-supplement-help');
    const controls=createEl(doc,'div',undefined,'blue-supplement-controls');
    const fileLabel=createEl(doc,'label','보충자료 파일 추가','blue-supplement-file-label');
    const fileInput=createEl(doc,'input');
    fileInput.id='blue-supplement-files';fileInput.type='file';fileInput.multiple=true;
    fileInput.accept='.pdf,.txt,.md,.csv,.tsv,.json,.log,.py,.r,.tex,.html,.docx,.odt';
    fileInput.disabled=true;
    fileLabel.append(fileInput);
    const clearBtn=createEl(doc,'button','보충자료 전체 비우기','button secondary');
    clearBtn.type='button';clearBtn.id='blue-supplement-clear';clearBtn.disabled=true;
    controls.append(fileLabel,clearBtn);
    const chips=createEl(doc,'ul',undefined,'blue-supplement-chips');
    const summary=createEl(doc,'p','먼저 주 논문(BLUE) 파일을 선택하세요.','blue-supplement-summary');
    const details=createEl(doc,'details',undefined,'blue-supplement-details');
    details.hidden=true;
    const detailsSummary=createEl(doc,'summary','교차 검증 불일치 단서 (0건)');
    const list=createEl(doc,'ul',undefined,'blue-supplement-list');
    details.append(detailsSummary,list);
    const status=createEl(doc,'p','','blue-supplement-status');
    status.setAttribute('role','status');
    section.append(head,help,controls,chips,summary,details,status);
    return {section,fileInput,clearBtn,chips,summary,details,detailsSummary,list,status};
  }

  function mount(doc,host){
    host=host||doc.getElementById('document-blue');
    if(!host||doc.getElementById('blue-supplement-panel'))return null;
    const ui=buildPanelDom(doc);
    insertSupplementPanel(host,ui.section);

    let attached=[],mainFileHash=null,busy=false,serial=0;
    const bridge=()=>root.FalsifyDocumentBlueExternal;

    function setStatus(text,isError=false){
      ui.status.textContent=text||'';
      ui.status.className=isError?'blue-supplement-status error':'blue-supplement-status';
    }
    function renderChips(){
      ui.chips.replaceChildren();
      for(const supp of attached){
        const li=createEl(doc,'li',undefined,'blue-supplement-chip');
        li.append(createEl(doc,'span',kindLabel(supp.kind),'blue-supplement-chip-kind'));
        li.append(createEl(doc,'span',supp.name+' ('+supp.segments.length+'구간)'));
        const rm=createEl(doc,'button','제거','blue-supplement-chip-remove');
        rm.type='button';rm.disabled=busy;
        rm.setAttribute('aria-label',supp.name+' 제거');
        rm.addEventListener('click',()=>void removeSupplement(supp.fileId));
        li.append(rm);
        ui.chips.append(li);
      }
    }
    function renderAudit(source){
      ui.list.replaceChildren();
      if(!source){
        ui.summary.textContent='먼저 주 논문(BLUE) 파일을 선택하세요.';
        ui.details.hidden=true;ui.detailsSummary.textContent='교차 검증 불일치 단서 (0건)';return;
      }
      if(!attached.length){
        ui.summary.textContent='주 논문 준비됨 · 보충자료 첨부 없음 (단일 파일 모드)';
        ui.details.hidden=true;ui.detailsSummary.textContent='교차 검증 불일치 단서 (0건)';return;
      }
      const mainSegs=(source.segments||[]).filter(s=>!String(s?.id||'').startsWith('supp-'));
      const report=auditMainVsSupplements({mainSegments:mainSegs,supplements:attached});
      ui.summary.textContent='보충자료 '+attached.length+'개 연결됨 · 교차 불일치 단서 '+report.counts.total+'건 (D1 '+report.counts.d1+' · D4-1 '+report.counts.d4_1+')';
      ui.detailsSummary.textContent='교차 검증 불일치 단서 ('+report.counts.total+'건)';
      ui.details.hidden=!report.signals.length;
      for(const sig of report.signals.slice(0,50)){
        const li=createEl(doc,'li',undefined,'blue-supplement-item');
        li.append(createEl(doc,'div','['+sig.family+'] '+sig.kind+' — '+sig.detail,'blue-supplement-item-head'));
        if(sig.excerpt)li.append(createEl(doc,'div','인용: '+sig.excerpt,'blue-supplement-item-quote'));
        ui.list.append(li);
      }
    }
    function syncUi(source){
      const hasMain=!!source;
      ui.fileInput.disabled=!hasMain||busy;
      ui.clearBtn.disabled=!hasMain||busy||!attached.length;
      renderChips();
      renderAudit(source);
    }
    async function pushSupplementsToBlue(expectedHash){
      const api=bridge();
      if(!api||typeof api.setSupplementalSegments!=='function')return;
      await api.setSupplementalSegments(toSupplementalSegments(attached),expectedHash);
    }
    async function removeSupplement(fileId){
      const source=bridge()?.getSource?.();
      if(!source||busy)return;
      attached=attached.filter(s=>s.fileId!==fileId);
      busy=true;syncUi(source);
      try{
        await pushSupplementsToBlue(source.fileHash);
        setStatus(attached.length?'보충자료를 제거하고 교차 검증을 갱신했습니다.':'보충자료를 모두 제거해 원문 단일 상태가 되었습니다.');
      }catch(e){setStatus(e?.message||'보충자료 제거 실패',true);}
      finally{busy=false;syncUi(bridge()?.getSource?.());}
    }
    async function clearAll(){
      const source=bridge()?.getSource?.();
      if(!attached.length&&!ui.fileInput.value)return;
      attached=[];ui.fileInput.value='';
      if(!source){syncUi(null);setStatus('');return;}
      busy=true;syncUi(source);
      try{
        await pushSupplementsToBlue(source.fileHash);
        setStatus('보충자료를 모두 비우고 원문 단일 상태를 복원했습니다.');
      }catch(e){setStatus(e?.message||'보충자료 초기화 실패',true);}
      finally{busy=false;syncUi(bridge()?.getSource?.());}
    }
    function validateBatch(files){
      if(attached.length+files.length>MAX_FILES)throw new Error('보충자료는 최대 '+MAX_FILES+'개까지 첨부할 수 있습니다.');
      const currentBytes=attached.reduce((n,s)=>n+(s.bytes||0),0);
      const addedBytes=files.reduce((n,f)=>n+(f.size||0),0);
      if(currentBytes+addedBytes>MAX_TOTAL_BYTES)throw new Error('보충자료 합계 크기는 20 MiB를 넘을 수 없습니다.');
    }
    async function handleFiles(fileList){
      const files=[...(fileList||[])];
      if(!files.length)return;
      const source=bridge()?.getSource?.();
      if(!source){setStatus('먼저 주 논문(BLUE) 파일을 선택하세요.',true);return;}
      const mine=++serial,targetHash=source.fileHash;
      try{validateBatch(files);}catch(e){ui.fileInput.value='';setStatus(e.message,true);return;}
      busy=true;syncUi(source);setStatus('보충자료 '+files.length+'개를 로컬에서 읽는 중...');
      const extracted=[];
      try{
        for(const f of files){
          const item=await extractSupplementFile(f);
          item.bytes=f.size||0;
          extracted.push(item);
        }
        if(mine!==serial||bridge()?.getSource?.()?.fileHash!==targetHash)return;
        for(const item of extracted){
          if(!attached.some(x=>x.fileHash&&x.fileHash===item.fileHash&&x.name===item.name))attached.push(item);
        }
        await pushSupplementsToBlue(targetHash);
        setStatus('보충자료 '+attached.length+'개 추출 및 교차 검증을 완료했습니다.');
      }catch(e){
        setStatus('보충자료 입력 실패: '+(e?.message||'알 수 없는 오류'),true);
      }finally{
        ui.fileInput.value='';busy=false;syncUi(bridge()?.getSource?.());
      }
    }
    function onBlueState(){
      const source=bridge()?.getSource?.();
      if(!source){
        attached=[];mainFileHash=null;ui.fileInput.value='';setStatus('');syncUi(null);return;
      }
      if(mainFileHash&&mainFileHash!==source.fileHash){
        attached=[];ui.fileInput.value='';setStatus('');
      }
      mainFileHash=source.fileHash;
      syncUi(source);
    }
    function resetPanel(){
      serial++;attached=[];mainFileHash=null;busy=false;ui.fileInput.value='';setStatus('');syncUi(bridge()?.getSource?.());
    }

    ui.fileInput.addEventListener('change',()=>void handleFiles(ui.fileInput.files));
    ui.clearBtn.addEventListener('click',()=>void clearAll());
    doc.addEventListener('falsify:blue-state',onBlueState);
    doc.addEventListener('falsify:blue-supplement-reset',resetPanel);
    doc.addEventListener('falsify:workspace-reset',resetPanel);
    onBlueState();
    return ui.section;
  }

  const api={
    SCHEMA,
    FORBIDDEN_RED_KEYS,
    MAX_FILES,
    MAX_TOTAL_BYTES,
    inferSupplementKind,
    extractSupplementaryItems,
    extractSupplementFile,
    toSupplementalSegments,
    auditMainVsSupplements,
    assertNoRedKeys,
    mount
  };
  if(root.document)mount(root.document);
  return api;
});
