/* Portable browser-standalone BLUE deterministic defect sensor & Zero-Drop gate. AGPL-3.0-only. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.FalsifyBlueDefectSensor=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';

  const SCHEMA='falsify.blue-defect-sensor.v1';
  const FORBIDDEN_RED_KEYS=Object.freeze(['before','after','patch','gold','why_hard','candidateRationales','plan']);
  const MULTI_TEST_RE=/(?:bonferroni|fdr|benjamini|hochberg|holm|tukey|sidak|adjusted\s*p|p_adj|q-value|다중비교|보정\s*p)/i;
  const REF_HEADER_RE=/^\s*(?:#{1,6}\s*)?(?:\d+\.?\s*)?(?:references|bibliography|참고문헌)\s*:?\s*$/i;
  const REF_STOP_RE=/^\s*(?:#{1,6}\s*)?(?:appendix|supplementary(?:\s+materials?)?|acknowledg(?:e)?ments?)\b/i;
  const REF_ITEM_RE=/^\s*(?:\[(\d{1,4})\]|(\d{1,4})[.)])\s+(.+)$/;
  const BRACKET_CITE_RE=/\[(\d{1,4}(?:\s*[-–—,]\s*\d{1,4})*)\]/g;
  const PCT_RE=/(?<![\d.])(\d{1,7})\s*\/\s*(\d{1,7})\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\)/g;
  const CI_RE=/(?:(a?OR|a?RR|a?HR|IRR|mean|beta|β|diff(?:erence)?|effect)\s*(?:=|:)?\s*)?([-−]?\d+(?:\.\d+)?)\s*[\(\[]\s*(9\d%?\s*CI\s*[:=,]?\s*)?([-−]?\d+(?:\.\d+)?)\s*(?:,\s*|\s+to\s+|\s*[–—]\s*|\s+-\s+|(?<=\d)-(?=[-−]?\d))([-−]?\d+(?:\.\d+)?)\s*[\)\]]/gi;
  const RATIO_OR_CI_TAG=/^(?:a?OR|a?RR|a?HR|IRR|mean|beta|β|diff(?:erence)?|effect)$/i;
  const STAT_PATTERNS=[
    {kind:'z',re:/\bz\s*=\s*([-−]?\d+(?:\.\d+)?)\s*[,;:(\s]*(?:p|P)\s*(=|<|<=|>|>=|≤|≥)\s*(\d*\.?\d+(?:[eE][-−+]?\d+)?)/g},
    {kind:'t',re:/\bt\s*\(\s*(\d+(?:\.\d+)?)\s*\)\s*=\s*([-−]?\d+(?:\.\d+)?)\s*[,;:(\s]*(?:p|P)\s*(=|<|<=|>|>=|≤|≥)\s*(\d*\.?\d+(?:[eE][-−+]?\d+)?)/g},
    {kind:'t_comma',re:/\bt\s*=\s*([-−]?\d+(?:\.\d+)?)\s*,\s*df\s*=\s*(\d+(?:\.\d+)?)\s*[,;:(\s]*(?:p|P)\s*(=|<|<=|>|>=|≤|≥)\s*(\d*\.?\d+(?:[eE][-−+]?\d+)?)/gi},
    {kind:'chi2',re:/(?:χ2|χ²|chi2|chi\^2|chi-square)\s*\(\s*(\d+(?:\.\d+)?)\s*(?:,\s*[Nn]\s*=\s*\d+)?\s*\)\s*=\s*([-−]?\d+(?:\.\d+)?)\s*[,;:(\s]*(?:p|P)\s*(=|<|<=|>|>=|≤|≥)\s*(\d*\.?\d+(?:[eE][-−+]?\d+)?)/gi}
  ];
  const TINY=1e-300;
  const LANCZOS=[0.9999999999998099,676.5203681218851,-1259.1392167224028,771.3234287776531,-176.6150291621406,12.507343278686905,-0.13857109526572012,9.984369578019572e-6,1.5056327351493116e-7];
  const activeReports=new Map();

  function clone(v){return v===undefined?undefined:JSON.parse(JSON.stringify(v));}
  function normText(t){return String(t||'').replace(/−/g,'-').replace(/≤/g,'<=').replace(/≥/g,'>=');}
  function snippet(text,start,end,radius=55){return text.slice(Math.max(0,start-radius),Math.min(text.length,end+radius)).replace(/\s+/g,' ').trim();}
  function countDecimals(token){const m=/\.(\d+)/.exec(String(token||''));return m?m[1].length:0;}
  function safeFloat(token){const n=Number(String(token||'').replace(/−/g,'-').replace(/,/g,'').trim());return Number.isFinite(n)?n:null;}
  function pageIndexOf(seg,idx){
    if(Number.isInteger(seg?.pageIndex)&&seg.pageIndex>=0)return seg.pageIndex;
    const m=/(?:PDF p\.|p(?:age)?\.?)\s*(\d+)/i.exec(String(seg?.label||''));
    return m?Math.max(0,Number(m[1])-1):idx;
  }

  function lnGamma(z){
    if(z<0.5)return Math.log(Math.PI/Math.sin(Math.PI*z))-lnGamma(1-z);
    const s=z-1;let x=LANCZOS[0];
    for(let i=1;i<LANCZOS.length;i++)x+=LANCZOS[i]/(s+i);
    const t=s+7.5;
    return 0.5*Math.log(2*Math.PI)+(s+0.5)*Math.log(t)-t+Math.log(x);
  }
  function gammaLowerSeries(a,x){
    const lp=-x+a*Math.log(x)-lnGamma(a);if(lp<-745)return 0;
    let ap=a,term=1/a,total=term;
    for(let i=0;i<4000;i++){ap+=1;term*=x/ap;total+=term;if(Math.abs(term)<=Math.abs(total)*1e-15)break;}
    return total*Math.exp(lp);
  }
  function gammaUpperCF(a,x){
    const lp=-x+a*Math.log(x)-lnGamma(a);if(lp<-745)return 0;
    let b=x+1-a,c=1/TINY,d=1/(Math.abs(b)>=TINY?b:TINY),h=d;
    for(let i=1;i<4000;i++){
      const an=-i*(i-a);b+=2;
      d=an*d+b;d=Math.abs(d)<TINY?TINY:d;
      c=b+an/c;c=Math.abs(c)<TINY?TINY:c;
      d=1/d;const delta=d*c;h*=delta;
      if(Math.abs(delta-1)<=1e-14)break;
    }
    return h*Math.exp(lp);
  }
  function gammaincc(a,x){
    if(x<=0)return 1;
    if(x<a+1)return Math.max(0,Math.min(1,1-gammaLowerSeries(a,x)));
    return Math.max(0,Math.min(1,gammaUpperCF(a,x)));
  }
  function cfStep(aa,c,d){
    d=1+aa*d;d=Math.abs(d)<TINY?TINY:d;
    c=1+aa/c;c=Math.abs(c)<TINY?TINY:c;
    d=1/d;return [c,d,d*c];
  }
  function betacf(a,b,x){
    const qab=a+b,qap=a+1,qam=a-1;
    let c=1,d=1-qab*x/qap;d=1/(Math.abs(d)<TINY?TINY:d);let h=d;
    for(let m=1;m<4000;m++){
      const m2=2*m;let delta1,delta2;
      [c,d,delta1]=cfStep(m*(b-m)*x/((qam+m2)*(a+m2)),c,d);h*=delta1;
      [c,d,delta2]=cfStep(-(a+m)*(qab+m)*x/((a+m2)*(qap+m2)),c,d);h*=delta2;
      if(Math.abs(delta2-1)<=1e-14)break;
    }
    return h;
  }
  function betainc(a,b,x){
    if(x<=0)return 0;if(x>=1)return 1;
    const lbt=lnGamma(a+b)-lnGamma(a)-lnGamma(b)+a*Math.log(x)+b*Math.log1p(-x);
    const bt=lbt<-745?0:Math.exp(lbt);
    if(x<(a+1)/(a+b+2))return Math.max(0,Math.min(1,bt*betacf(a,b,x)/a));
    return Math.max(0,Math.min(1,1-bt*betacf(b,a,1-x)/b));
  }
  function statPvalue(kind,val,df1){
    if(kind==='z')return gammaincc(0.5,(val*val)/2);
    if(kind==='t')return df1>0?betainc(df1/2,0.5,df1/(df1+val*val)):null;
    if(kind==='chi2')return df1>0&&val>=0?gammaincc(df1/2,val/2):null;
    return null;
  }

  function extractStatFields(kind,m){
    if(kind==='z')return {kind:'z',df1:null,valStr:m[1],op:m[2],pStr:m[3]};
    if(kind==='t_comma')return {kind:'t',df1:safeFloat(m[2]),valStr:m[1],op:m[3],pStr:m[4]};
    return {kind,df1:safeFloat(m[1]),valStr:m[2],op:m[3],pStr:m[4]};
  }
  function pIntervalConsistent(pMin,pMax,op,repP,pDec){
    const tol=pDec===2?0.01:0.5*Math.pow(10,-pDec);
    if(op==='=')return pMax>=repP-tol-1e-9&&pMin<=repP+tol+1e-9;
    if(op==='<')return pMin<repP+1e-9;
    if(op==='<=')return pMin<=repP+1e-9;
    if(op==='>')return pMax>repP-1e-9;
    return pMax>=repP-1e-9;
  }
  function evaluateStatMatch(norm,spec,m,segId,pageIndex){
    const f=extractStatFields(spec.kind,m);
    const val=safeFloat(f.valStr),repP=safeFloat(f.pStr);
    if(val===null||repP===null||repP<0||repP>1)return null;
    const pExact=statPvalue(f.kind,val,f.df1);
    if(pExact===null)return null;
    const sEps=0.5*Math.pow(10,-countDecimals(f.valStr)),base=f.kind==='chi2'?val:Math.abs(val);
    const pMin=statPvalue(f.kind,base+sEps,f.df1),pMax=statPvalue(f.kind,Math.max(0,base-sEps),f.df1);
    if(pIntervalConsistent(pMin,pMax,f.op,repP,countDecimals(f.pStr)))return null;
    const ctx=norm.slice(Math.max(0,m.index-140),Math.min(norm.length,m.index+m[0].length+140));
    if(MULTI_TEST_RE.test(ctx)&&repP>=pExact-1e-6)return null;
    return {
      category:'D1',kind:'stat_pvalue_mismatch',pageIndex,segmentId:segId,
      excerpt:snippet(norm,m.index,m.index+m[0].length),
      reported:{statKind:f.kind,statValue:val,df1:f.df1,operator:f.op,p:repP},
      computed:{p:Number(pExact.toPrecision(5)),pRange:[Number(pMin.toPrecision(5)),Number(pMax.toPrecision(5))]},
      detail:f.kind+'='+val+' 보고 p '+f.op+' '+f.pStr+' ↔ 계산 p='+pExact.toFixed(4)
    };
  }
  function scanStatPvalues(norm,segId,pageIndex){
    const out=[];
    for(const spec of STAT_PATTERNS){
      spec.re.lastIndex=0;let m;
      while((m=spec.re.exec(norm))!==null){const s=evaluateStatMatch(norm,spec,m,segId,pageIndex);if(s)out.push(s);}
    }
    return out;
  }
  function scanPercentages(norm,segId,pageIndex){
    const out=[];PCT_RE.lastIndex=0;let m;
    while((m=PCT_RE.exec(norm))!==null){
      const count=Number(m[1]),total=Number(m[2]),rep=Number(m[3]);
      if(!Number.isFinite(rep)||total<2||count>total)continue;
      const computed=(count/total)*100,ulp=Math.pow(10,-countDecimals(m[3]));
      if(Math.abs(computed-rep)>0.6*ulp+1e-9){
        out.push({
          category:'D1',kind:'percentage_mismatch',pageIndex,segmentId:segId,
          excerpt:snippet(norm,m.index,m.index+m[0].length),
          reported:{count,total,pct:rep},computed:{pct:Number(computed.toFixed(2))},
          detail:count+'/'+total+' 계산값 '+computed.toFixed(2)+'% ↔ 보고 '+m[3]+'%'
        });
      }
    }
    return out;
  }
  function scanCiBounds(norm,segId,pageIndex){
    const out=[];CI_RE.lastIndex=0;let m;
    while((m=CI_RE.exec(norm))!==null){
      if(!m[3]&&(!m[1]||!RATIO_OR_CI_TAG.test(m[1])))continue;
      const est=safeFloat(m[2]),lo=safeFloat(m[4]),hi=safeFloat(m[5]);
      if(est===null||lo===null||hi===null)continue;
      const issue=lo>hi?'inverted_bounds':(est<lo-1e-9||est>hi+1e-9?'point_outside_ci':'');
      if(issue)out.push({
        category:'D1',kind:'ci_bounds_mismatch',pageIndex,segmentId:segId,
        excerpt:snippet(norm,m.index,m.index+m[0].length),
        reported:{measureKind:m[1]||null,estimate:est,lower:lo,upper:hi},computed:{issue},
        detail:'CI 경계 오류('+issue+'): '+est+' ['+lo+', '+hi+']'
      });
    }
    return out;
  }

  function cleanIdentifier(raw){
    let s=String(raw||'').trim().replace(/[.,;\]"']+$/,'');
    while(s.endsWith(')')&&(s.match(/\)/g)||[]).length>(s.match(/\(/g)||[]).length)s=s.slice(0,-1).replace(/[.,;\]"']+$/,'');
    return s;
  }
  function extractRefIdentifiers(body){
    const validDois=[],malformedDois=[],uris=[];
    const doiRe=/(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)([^\s,;[\]>"']+)/gi;
    let m;
    while((m=doiRe.exec(body))!==null){
      const cand=cleanIdentifier(m[1]);
      if(/^10\.\d{4,9}\/[^\s]+$/.test(cand)&&!/\.\.|\/\//.test(cand.slice(3)))validDois.push(cand.toLowerCase());
      else malformedDois.push(cand||m[0]);
    }
    const bareRe=/(?<![A-Za-z0-9./])(10\.\d{1,9}\/[^\s,;[\]>"']*)/g;
    while((m=bareRe.exec(body))!==null){
      const cand=cleanIdentifier(m[1]);
      if(/^10\.\d{4,9}\/[^\s]+$/.test(cand)&&!/\.\.|\/\//.test(cand.slice(3))){
        if(!validDois.includes(cand.toLowerCase()))validDois.push(cand.toLowerCase());
      }else if(!malformedDois.includes(cand))malformedDois.push(cand);
    }
    const urlRe=/https?:\/\/([^\s,;[\]>"']+)/gi;
    while((m=urlRe.exec(body))!==null){
      const rawUrl=cleanIdentifier(m[0]);
      if(!/doi\.org\//i.test(rawUrl))uris.push(rawUrl.toLowerCase().replace(/\/+$/,''));
    }
    return {validDois,malformedDois,uris};
  }
  function collectSegmentLines(segments){
    const lines=[];
    segments.forEach((seg,idx)=>{
      if(!seg||typeof seg.text!=='string')return;
      const pageIndex=pageIndexOf(seg,idx);
      for(const line of normText(seg.text).split(/\r?\n/))lines.push({segmentId:seg.id||('s'+idx),pageIndex,line});
    });
    return lines;
  }
  function parseBibliographyLines(lines){
    const bodyLines=[],refs=[];
    let inRefs=false,current=null;
    for(const item of lines){
      const t=item.line.trim();
      if(!inRefs){
        if(REF_HEADER_RE.test(t)){inRefs=true;continue;}
        bodyLines.push(item);continue;
      }
      if(REF_STOP_RE.test(t)){inRefs=false;current=null;bodyLines.push(item);continue;}
      const m=REF_ITEM_RE.exec(item.line);
      const idx=m?Number(m[1]||m[2]):0;
      if(m&&idx>=1&&idx<=500&&!(idx>=1900&&idx<=2099)){
        current={index:idx,body:m[3].trim(),segmentId:item.segmentId,pageIndex:item.pageIndex};
        refs.push(current);
      }else if(current&&t){current.body+=' '+t;}
    }
    return {bodyLines,refs};
  }
  function normRefBody(body){return String(body||'').toLowerCase().replace(/[^a-z0-9가-힣]+/g,' ').trim();}
  function checkDuplicateRefs(refs){
    const out=[],byBody=new Map(),byId=new Map();
    for(const r of refs){
      const nb=normRefBody(r.body);
      if(nb.length>=20){
        const prev=byBody.get(nb);
        if(prev&&prev.index!==r.index)out.push({category:'D2',kind:'duplicate_reference_entry',pageIndex:r.pageIndex,segmentId:r.segmentId,excerpt:snippet(r.body,0,80),reported:{indices:[prev.index,r.index]},computed:{normalizedMatch:true},detail:'참고문헌 ['+prev.index+']와 ['+r.index+']의 본문이 중복됩니다.'});
        else if(!prev)byBody.set(nb,r);
      }
      const ids=extractRefIdentifiers(r.body);
      r.doi=ids.validDois[0]||null;
      for(const bad of ids.malformedDois)out.push({category:'D2',kind:'malformed_doi',pageIndex:r.pageIndex,segmentId:r.segmentId,excerpt:bad,reported:{index:r.index,doi:bad},computed:{valid:false},detail:'참고문헌 ['+r.index+'] DOI 형식이 올바르지 않습니다: '+bad});
      for(const key of [...ids.validDois.map(d=>'doi:'+d),...ids.uris.map(u=>'uri:'+u)]){
        const prev=byId.get(key);
        if(prev&&prev.index!==r.index)out.push({category:'D2',kind:'duplicate_reference_uri_or_doi',pageIndex:r.pageIndex,segmentId:r.segmentId,excerpt:key.slice(4),reported:{indices:[prev.index,r.index],identifier:key.slice(4)},computed:{duplicate:true},detail:'참고문헌 ['+prev.index+']와 ['+r.index+']가 동일한 식별자('+key.slice(4)+')를 공유합니다.'});
        else if(!prev)byId.set(key,r);
      }
    }
    return out;
  }
  function expandCiteIndices(inner){
    const nums=[];
    for(const part of inner.split(',')){
      const range=/^\s*(\d{1,4})\s*[-–—]\s*(\d{1,4})\s*$/.exec(part);
      if(range){
        const a=Number(range[1]),b=Number(range[2]);
        if(b>=a&&b-a<=50){for(let k=a;k<=b;k++)nums.push(k);}else{nums.push(a,b);}
      }else if(/^\s*(\d{1,4})\s*$/.test(part))nums.push(Number(part.trim()));
    }
    return nums;
  }
  function scanOutOfRangeCitations(bodyLines,maxRefIndex){
    if(maxRefIndex<1)return [];
    const out=[],seen=new Set();
    for(const item of bodyLines){
      BRACKET_CITE_RE.lastIndex=0;let m;
      while((m=BRACKET_CITE_RE.exec(item.line))!==null){
        for(const k of expandCiteIndices(m[1])){
          if(k<=maxRefIndex||(maxRefIndex<1800&&k>=1900&&k<=2099))continue;
          const key=item.pageIndex+':'+k;if(seen.has(key))continue;seen.add(key);
          out.push({category:'D2',kind:'citation_index_out_of_range',pageIndex:item.pageIndex,segmentId:item.segmentId,excerpt:snippet(item.line,m.index,m.index+m[0].length),reported:{citedIndex:k,maxRefIndex},computed:{outOfRange:true},detail:'본문 인용 ['+k+']가 참고문헌 최대 번호('+maxRefIndex+')를 초과합니다.'});
        }
      }
    }
    return out;
  }
  function scanBibliography(segments){
    const {bodyLines,refs}=parseBibliographyLines(collectSegmentLines(segments));
    if(!refs.length)return {signals:[],bibliography:{found:false,count:0,maxIndex:0,entries:[]}};
    const maxIndex=Math.max(...refs.map(r=>r.index));
    const signals=[...checkDuplicateRefs(refs)];
    if(refs.length>=2)signals.push(...scanOutOfRangeCitations(bodyLines,maxIndex));
    return {signals,bibliography:{found:true,count:refs.length,maxIndex,entries:refs.map(r=>({index:r.index,doi:r.doi||null,pageIndex:r.pageIndex}))}};
  }

  function numberSignals(signals){
    return signals.map((s,i)=>({...s,id:s.id||('S-'+(i+1))}));
  }
  function countSignals(signals){
    const d1=signals.filter(s=>s.category==='D1').length;
    const d2=signals.filter(s=>s.category==='D2').length;
    return {d1,d2,companion:signals.length-d1-d2,total:signals.length};
  }
  function scanSegments({fileHash=null,segments=[]}={}){
    const list=Array.isArray(segments)?segments:[],signals=[];
    list.forEach((seg,idx)=>{
      if(!seg||typeof seg.text!=='string')return;
      const norm=normText(seg.text),segId=seg.id||('s'+idx),pageIndex=pageIndexOf(seg,idx);
      signals.push(...scanStatPvalues(norm,segId,pageIndex),...scanPercentages(norm,segId,pageIndex),...scanCiBounds(norm,segId,pageIndex));
    });
    const bib=scanBibliography(list);
    signals.push(...bib.signals);
    const numbered=numberSignals(signals);
    return {schema:SCHEMA,fileHash:fileHash||null,scannedAt:new Date().toISOString(),tier:'P0',signals:numbered,bibliography:bib.bibliography,counts:countSignals(numbered)};
  }

  function assertNoRedKeys(value,seen=new WeakSet()){
    if(!value||typeof value!=='object')return;
    if(seen.has(value))return;seen.add(value);
    if(Array.isArray(value)){for(const item of value)assertNoRedKeys(item,seen);return;}
    for(const key of Object.keys(value)){
      if(FORBIDDEN_RED_KEYS.includes(key))throw new Error('Blindness guard violation: forbidden RED key "'+key+'"');
      assertNoRedKeys(value[key],seen);
    }
  }

  function signalKey(s){
    return JSON.stringify([s.kind||'',s.pageIndex??'',s.segmentId??'',String(s.excerpt||'').replace(/\s+/g,' ').trim(),s.detail||'']);
  }
  function dedupeSignals(listA,listB){
    const merged=[],seen=new Set();
    for(const s of [...listA,...listB]){
      if(!s||typeof s!=='object')continue;
      const item=clone(s);
      if(!item.category&&item.family)item.category=item.family;
      const k=signalKey(item);if(seen.has(k))continue;seen.add(k);merged.push(item);
    }
    return numberSignals(merged);
  }
  function normalizeAcroForm(raw){
    const a=clone(raw);
    if(a.total===undefined)a.total=a.fieldCount??0;
    if(a.filled===undefined)a.filled=a.filledCount??0;
    if(a.blank===undefined)a.blank=a.emptyCount??0;
    return a;
  }
  function mapMismatchEntry(m){
    const detail=m.status||m.detail||m.doi||'';
    return {provider:m.source||'BibOracle',refIndex:m.index??m.refIndex??null,detail};
  }
  function mapRegistryEntry(r){
    const detail=r.verdict||r.status||r.summary||'';
    return {provider:'ClinicalTrials.gov',nctId:r.nctId||r.trialId||'',detail};
  }
  function buildOracleEntries(pack){
    const refs=Array.isArray(pack.mismatchedReferences)?pack.mismatchedReferences:[];
    const regs=Array.isArray(pack.registryComparisons)?pack.registryComparisons:[];
    return [...refs.map(mapMismatchEntry),...regs.map(mapRegistryEntry)];
  }
  function normalizeOraclePack(raw){
    const p=clone(raw);
    if(!Array.isArray(p.entries)&&!Array.isArray(p.items))p.entries=buildOracleEntries(p);
    return p;
  }
  function copyCompanionSections(out,base,companion){
    for(const k of ['uriLinks','acroForm','oraclePack']){
      if(companion[k])out[k]=clone(companion[k]);
      else if(base[k])out[k]=clone(base[k]);
    }
    if(out.acroForm)out.acroForm=normalizeAcroForm(out.acroForm);
    if(out.oraclePack)out.oraclePack=normalizeOraclePack(out.oraclePack);
    const bib=(companion.bibliography?.count||companion.bibliography?.referenceCount)?companion.bibliography:base.bibliography;
    out.bibliography=clone(bib||{found:false,count:0,maxIndex:0,entries:[]});
  }
  function validateCompanionInputs(browserReport,companionReport){
    if(!companionReport||companionReport.schema!==SCHEMA)throw new Error('Invalid companion sensor schema');
    if(browserReport?.fileHash&&companionReport.fileHash&&browserReport.fileHash!==companionReport.fileHash){
      throw new Error('Companion sensor fileHash mismatch');
    }
    assertNoRedKeys(browserReport);assertNoRedKeys(companionReport);
  }
  function mergedTier(base,companion){
    if(companion.oraclePack||companion.tier==='P2')return 'P2';
    return base.tier||'P0';
  }
  function mergeCompanionSensor(browserReport,companionReport){
    validateCompanionInputs(browserReport,companionReport);
    const base=browserReport&&typeof browserReport==='object'?clone(browserReport):{schema:SCHEMA,fileHash:null,signals:[]};
    const numbered=dedupeSignals(base.signals||[],companionReport.signals||[]);
    const out={
      ...base,schema:SCHEMA,fileHash:base.fileHash||companionReport.fileHash||null,
      scannedAt:companionReport.scannedAt||base.scannedAt||new Date().toISOString(),
      tier:mergedTier(base,companionReport),signals:numbered,counts:countSignals(numbered)
    };
    copyCompanionSections(out,base,companionReport);
    assertNoRedKeys(out);
    return out;
  }

  function formatOracleLines(oraclePack){
    const lines=['','### 외부 오라클 대조 단서 (P2 · PDF 원문 대조 필수)'];
    lines.push('- 주의: API 미검색(예: Crossref 404, 비학술지·단행본·사전출판물) 또는 커버리지 공백은 절대 자동 조작 증명이 아닙니다. 반드시 첨부 PDF 본문·서지와 직접 대조하세요.');
    if(typeof oraclePack.summary==='string'&&oraclePack.summary)lines.push('- 요약: '+oraclePack.summary);
    const entries=Array.isArray(oraclePack.entries)?oraclePack.entries:Array.isArray(oraclePack.items)?oraclePack.items:[];
    for(const entry of entries.slice(0,25)){
      const label=entry.provider||entry.source||'Oracle';
      const ref=entry.refIndex!=null?'['+entry.refIndex+'] ':entry.nctId?entry.nctId+' ':'';
      const detail=entry.detail||entry.status||entry.title||JSON.stringify(entry);
      lines.push('- ['+label+'] '+ref+String(detail).slice(0,260));
    }
    return lines;
  }
  function formatSignalLine(s){
    const page=Number.isInteger(s.pageIndex)?'p.'+(s.pageIndex+1)+' ':'';
    const quote=s.excerpt?' | 원문: "'+String(s.excerpt).slice(0,120)+'"':'';
    return '- ['+(s.category||'L0')+'·'+s.kind+'] '+page+(s.detail||'')+quote;
  }
  function appendMetadataLines(lines,report,signals){
    const d1=signals.filter(s=>s.category==='D1').length,d2=signals.filter(s=>s.category==='D2').length;
    lines.push('- 감식 요약: 총 '+signals.length+'건 (D1='+d1+', D2='+d2+')');
    if(report.uriLinks)lines.push('- PDF 하이퍼링크(/URI): 총 '+(report.uriLinks.total??0)+'건, 표시 DOI와 불일치 '+(report.uriLinks.mismatchCount??0)+'건');
    if(report.acroForm)lines.push('- PDF AcroForm 위젯: 전체 '+(report.acroForm.total??0)+'개 (입력됨 '+(report.acroForm.filled??0)+'개, 빈칸 '+(report.acroForm.blank??0)+'개)');
  }
  function formatEvidencePackBlock(report,options={tier:'P0'}){
    if(!report||typeof report!=='object')throw new Error('Sensor report is required');
    assertNoRedKeys(report);
    const tier=options?.tier==='P2'?'P2':'P0';
    const lines=[
      '## [BLUE Layer 0 결정론적 감식 및 근거 팩 ('+tier+')]',
      '*이 단서는 첨부된 PDF와 대조해 직접 확인해야 할 검증 단서(verification clues)이며, 자동 결함 판정이나 조작 증명이 아닙니다.*'
    ];
    const signals=Array.isArray(report.signals)?report.signals:[];
    appendMetadataLines(lines,report,signals);
    for(const s of signals.slice(0,30))lines.push(formatSignalLine(s));
    if(signals.length>30)lines.push('- ... 외 '+(signals.length-30)+'건 생략');
    if(tier==='P2'&&report.oraclePack)lines.push(...formatOracleLines(report.oraclePack));
    return lines.join('\n');
  }

  function normalizeVerdictLabel(raw){
    const v=String(raw||'').trim().toLowerCase();
    if(v==='맞음'||v==='supported-in-source')return '맞음';
    if(v==='아님'||v==='defect')return '아님';
    if(v==='확인필요'||v==='needs-verification')return '확인필요';
    return '';
  }
  function hasResolutionBasis(f){
    return (typeof f?.resolutionQuote==='string'&&f.resolutionQuote.trim().length>0)||(typeof f?.rationale==='string'&&f.rationale.trim().length>0);
  }
  function normQuote(q){return String(q||'').replace(/\s+/g,' ').trim().toLowerCase();}
  function quoteOverlaps12(a,b){
    const qa=normQuote(a),qb=normQuote(b);
    if(qa.length<12||qb.length<12)return false;
    if(qa.includes(qb)||qb.includes(qa))return true;
    const shorter=qa.length<=qb.length?qa:qb,longer=qa.length<=qb.length?qb:qa;
    for(let i=0;i<=shorter.length-12;i++)if(longer.includes(shorter.slice(i,i+12)))return true;
    return false;
  }
  function pageNumberOf(obj){
    if(Number.isInteger(obj?.page)&&obj.page>0)return obj.page;
    if(Number.isInteger(obj?.pageIndex)&&obj.pageIndex>=0)return obj.pageIndex+1;
    return null;
  }
  function locationMatches(a,b){
    const pa=pageNumberOf(a),pb=pageNumberOf(b);
    if(pa===null||pb===null||pa!==pb)return false;
    const la=normQuote(a?.locationLabel),lb=normQuote(b?.locationLabel);
    return !!(la&&lb&&(la===lb||la.includes(lb)||lb.includes(la)));
  }
  function entryMatchesFinding(entry,f){
    const eid=String(entry?.candidateId||entry?.id||'').trim().toLowerCase();
    const fid=String(f?.candidateId||f?.id||f?.reportNumber||'').trim().toLowerCase();
    if(eid&&fid&&eid===fid)return true;
    if(quoteOverlaps12(entry?.quote,f?.quote))return true;
    return locationMatches(entry,f);
  }
  function buildRecoveredFinding(entry,idx){
    const page=pageNumberOf(entry);
    const pageIndex=Number.isInteger(entry?.pageIndex)&&entry.pageIndex>=0?entry.pageIndex:(page?page-1:null);
    return {
      reportNumber:entry?.candidateId||entry?.id||('ZD-'+(idx+1)),
      page:page||undefined,
      pageIndex,
      locationLabel:entry?.locationLabel||'',
      findingType:entry?.defectFamily||'확인필요(누락복원)',
      severity:'불일치',
      verdictLabel:'확인필요',
      confidence:'확인필요 (Zero-Drop 복원)',
      quote:entry?.quote||'',
      rationale:'[Zero-Drop 자동 복원] 1단계 의심 원장에 기록되었으나 2단계 판정에서 해소 근거 없이 누락됨: '+(entry?.suspicion||entry?.note||'원문 재확인 필요'),
      zeroDropRecovered:true
    };
  }
  function partitionStage2(rawFindings){
    const defectFindings=[],resolvedOk=[],invalidResolved=[];
    for(const raw of rawFindings){
      if(!raw||typeof raw!=='object')continue;
      const verdict=normalizeVerdictLabel(raw.verdictLabel);
      const item=verdict?{...raw,verdictLabel:verdict}:{...raw};
      if(verdict==='맞음'){
        if(hasResolutionBasis(item))resolvedOk.push(item);
        else invalidResolved.push(item);
      }else defectFindings.push(item);
    }
    return {defectFindings,resolvedOk,invalidResolved};
  }
  function recoverUnmatchedStage2(item,idx){
    return {...item,reportNumber:item.reportNumber||item.candidateId||item.id||('ZD-S2-'+(idx+1)),findingType:item.findingType||item.defectFamily||'확인필요(누락복원)',severity:item.severity||'불일치',verdictLabel:'확인필요',confidence:item.confidence||'확인필요 (Zero-Drop 복원)',rationale:'[Zero-Drop 자동 복원] 2단계에서 맞음 판정되었으나 해소 근거가 없어 확인필요로 복원됨.',zeroDropRecovered:true};
  }
  function reconcileCandidateLedger(candidateLedger,findings){
    const ledger=Array.isArray(candidateLedger)?candidateLedger.filter(x=>x&&typeof x==='object'):[];
    const stage2=Array.isArray(findings)?findings:[];
    const {defectFindings,resolvedOk,invalidResolved}=partitionStage2(stage2);
    const validTargets=[...defectFindings,...resolvedOk],recovered=[];
    ledger.forEach((entry,idx)=>{
      if(!validTargets.some(f=>entryMatchesFinding(entry,f)))recovered.push(buildRecoveredFinding(entry,idx));
    });
    invalidResolved.forEach((item,idx)=>{
      if(!ledger.some(entry=>entryMatchesFinding(entry,item)))recovered.push(recoverUnmatchedStage2(item,idx));
    });
    const reconciledFindings=[...defectFindings,...recovered];
    return {
      findings:reconciledFindings,
      resolvedOk,
      summary:{stage1Count:ledger.length,resolvedOkCount:resolvedOk.length,reportedDefectCount:defectFindings.length,recoveredCount:recovered.length}
    };
  }

  function setActiveReport(fileHash,report){
    if(typeof fileHash!=='string'||!fileHash)return null;
    if(!report){activeReports.delete(fileHash);return null;}
    assertNoRedKeys(report);
    const copy=clone(report);
    if(activeReports.size>=16&&!activeReports.has(fileHash))activeReports.delete(activeReports.keys().next().value);
    activeReports.set(fileHash,copy);
    return clone(copy);
  }
  function getActiveReport(fileHash){
    if(typeof fileHash!=='string'||!fileHash)return null;
    const found=activeReports.get(fileHash);
    return found?clone(found):null;
  }

  return {
    SCHEMA,
    FORBIDDEN_RED_KEYS,
    scanSegments,
    mergeCompanionSensor,
    formatEvidencePackBlock,
    reconcileCandidateLedger,
    setActiveReport,
    getActiveReport,
    assertNoRedKeys,
    statPvalue
  };
});
