/* Cops-and-Robbers Co-Evolution Arena (A1): 4-way audit aggregator, bias/flip trackers, team schema exporters, and answer-key-free C1 briefs. */
(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.FalsifyCoevolutionArena=api;
})(typeof globalThis==='object'?globalThis:this,function(root){
  'use strict';

  const LEDGER_KEY='falsify.experiment-ledger.v1';
  const CONDITION_STORAGE_KEY='falsify.arena-conditions.v1';
  const DEFECT_FAMILIES=Object.freeze(['D1','D2','D3','D4-1','S1']);
  const SURFACES=Object.freeze(['prose','table','chart','citation','registry']);
  const CONDITIONS=Object.freeze(['P0','P2','Holdout']);
  const SCORE_CSV_HEADERS=Object.freeze(['paper_id','team','judge_type','model','iteration','location','defect_type','label','evidence','time_sec','tokens','is_holdout']);

  const ATTACK_TO_FAMILY=Object.freeze({
    'numeric-drift':'D1',
    'citation-distortion':'D2',
    contradiction:'D3',
    'condition-omission':'D3',
    'unsupported-inference':'D3',
    'outcome-status-mislabeling':'D4-1',
    'semantic-inversion':'S1'
  });

  const VERDICT_TO_CSV_LABEL=Object.freeze({
    supported:'아님',
    'pre-existing':'아님',
    unsupported:'맞음',
    'spin-boundary':'확인필요',
    'gold-error':'확인필요',
    mixed:'확인필요',
    uncertain:'확인필요',
    pending:'확인필요'
  });

  const FAMILY_RULES=Object.freeze([
    ['openai',/^(?:gpt-|o[134](?:$|-)|codex)/i],
    ['anthropic',/^(?:claude-|opus|sonnet|haiku)/i],
    ['google',/^gemini-/i],
    ['xai',/^grok-/i],
    ['deepseek',/^deepseek-/i]
  ]);

  function emptyRecallBucket(){
    return {injectedTotal:0,detectedStrict:0,detectedInclusive:0,missed:0,pending:0};
  }

  function emptyStrictPrecision(){
    return {supported:0,preExisting:0,spinBoundary:0,goldError:0,pureFp:0,mixed:0};
  }

  function emptyInclusivePrecision(){
    return {...emptyStrictPrecision(),uncertain:0,zeroDropRecovered:0};
  }

  function emptyFamilyMap(){
    const out={};
    for(const fam of DEFECT_FAMILIES)out[fam]={injected:0,detectedStrict:0,detectedInclusive:0,missed:0,pending:0};
    return out;
  }

  function emptySurfaceMap(){
    const out={};
    for(const s of SURFACES)out[s]={injected:0,detectedStrict:0,detectedInclusive:0,missed:0,pending:0};
    return out;
  }

  function emptyConditionBucket(){
    return {runCount:0,redRecall:emptyRecallBucket(),strict:emptyStrictPrecision(),inclusive:emptyInclusivePrecision()};
  }

  function normalizeCondition(raw){
    if(typeof raw!=='string')return null;
    const t=raw.trim().toLowerCase();
    if(t==='p0')return 'P0';
    if(t==='p2')return 'P2';
    if(t==='holdout')return 'Holdout';
    return null;
  }

  function inferCondition(run,latestReview,conditionOverrides){
    const override=conditionOverrides&&run?.id?normalizeCondition(conditionOverrides[run.id]):null;
    if(override)return override;
    const text=[latestReview?.caseLabel,run?.caseLabel,run?.sourceName].filter(Boolean).join(' ');
    if(/holdout|대조군|무결함|clean[\s_-]*control/i.test(text))return 'Holdout';
    if(/\bp2\b|근거\s*팩|oracle/i.test(text))return 'P2';
    return 'P0';
  }

  function readTaxonomyFamily(candidate,patch){
    const classify=root.FalsifyAdversarialTaxonomy?.classifyDefect;
    if(typeof classify!=='function')return '';
    try{
      const res=classify(candidate||patch);
      if(typeof res==='string')return DEFECT_FAMILIES.includes(res)?res:'';
      if(res&&typeof res==='object'){
        const fam=res.family||res.code||res.defectFamily||'';
        if(DEFECT_FAMILIES.includes(fam))return fam;
      }
    }catch{}
    return '';
  }

  function classifyDefectFamily(candidate,patch,redRun){
    const fromTax=readTaxonomyFamily(candidate,patch);
    if(fromTax)return fromTax;
    const types=candidate?.attackTypes||patch?.attackTypes||redRun?.attackTypes||[];
    for(const t of types){
      if(Object.hasOwn(ATTACK_TO_FAMILY,t))return ATTACK_TO_FAMILY[t];
    }
    const labelText=[candidate?.defectType,patch?.defectType,candidate?.findingType].find(Boolean);
    if(typeof labelText==='string'&&DEFECT_FAMILIES.includes(labelText))return labelText;
    return 'D3';
  }

  const SURFACE_PATTERNS=Object.freeze([
    ['chart',/\b(?:fig(?:ure)?|chart|plot)\b|그림|차트/i],
    ['table',/\btable\b|표\s*\d/i],
    ['citation',/\b(?:doi|pmid|reference|citation)\b|참고문헌/i],
    ['registry',/\b(?:nct\d|clinicaltrials|prospero|isrctn|registry)\b|등록부/i]
  ]);

  function classifySurfaceByKind(candidate,patch){
    const kind=candidate?.kind||patch?.kind;
    if(kind==='chart-point'||candidate?.visualTargets?.length)return 'chart';
    if(kind==='table-cell'||candidate?.tableTarget||patch?.tableTarget)return 'table';
    const types=candidate?.attackTypes||patch?.attackTypes||[];
    if(types.includes('citation-distortion'))return 'citation';
    if(types.includes('outcome-status-mislabeling'))return 'registry';
    return '';
  }

  function classifySurface(candidate,patch){
    const explicit=candidate?.surface||patch?.surface;
    if(SURFACES.includes(explicit))return explicit;
    const byKind=classifySurfaceByKind(candidate,patch);
    if(byKind)return byKind;
    const text=[patch?.label,candidate?.label,patch?.before,candidate?.rationale].filter(Boolean).join(' ');
    for(const [surface,pattern] of SURFACE_PATTERNS){
      if(pattern.test(text))return surface;
    }
    return 'prose';
  }

  function findRedCandidate(redRun,patch){
    const list=redRun?.response?.candidates;
    if(!Array.isArray(list)||!patch)return null;
    return list.find(c=>c.id===patch.id&&c.before===patch.before)||list.find(c=>c.id===patch.id)||null;
  }

  function resolveRedRun(runs,blueRun,comparison){
    const id=comparison?.sourceRunId||blueRun?.sourceRunId;
    if(id){
      const direct=runs.find(x=>x.id===id);
      if(direct)return direct;
    }
    if(!blueRun?.fileHash)return null;
    const matches=runs.filter(x=>x.role==='red'&&x.finalState?.outputFileHash===blueRun.fileHash);
    return matches.at(-1)||null;
  }

  function applyRecallVerdict(bucket,verdict){
    bucket.injectedTotal++;
    if(verdict==='detected'){bucket.detectedStrict++;bucket.detectedInclusive++;}
    else if(verdict==='uncertain')bucket.detectedInclusive++;
    else if(verdict==='missed')bucket.missed++;
    else bucket.pending++;
  }

  function applyAxisVerdict(axisBucket,verdict){
    axisBucket.injected++;
    if(verdict==='detected'){axisBucket.detectedStrict++;axisBucket.detectedInclusive++;}
    else if(verdict==='uncertain')axisBucket.detectedInclusive++;
    else if(verdict==='missed')axisBucket.missed++;
    else axisBucket.pending++;
  }

  function accumulatePatchRecall(state,cond,redRun,patch,verdict){
    const candidate=findRedCandidate(redRun,patch);
    const fam=classifyDefectFamily(candidate,patch,redRun);
    const surface=classifySurface(candidate,patch);
    applyRecallVerdict(state.redRecall,verdict);
    applyRecallVerdict(state.byCondition[cond].redRecall,verdict);
    applyAxisVerdict(state.redRecall.byFamily[fam],verdict);
    applyAxisVerdict(state.redRecall.bySurface[surface],verdict);
  }

  function tallyBlueRunRecall(state,runs,blueRun,latestReview,cond,comparedRedIds){
    const comp=latestReview?.comparison;
    const redRun=resolveRedRun(runs,blueRun,comp);
    if(comp&&Array.isArray(comp.assessments)){
      for(let i=0;i<comp.assessments.length;i++){
        const a=comp.assessments[i],patch=comp.selected?.[i];
        accumulatePatchRecall(state,cond,redRun,patch,a?.verdict||'pending');
      }
      return;
    }
    if(cond!=='Holdout'&&redRun?.finalState?.selected?.length&&!comparedRedIds.has(redRun.id)){
      comparedRedIds.add(redRun.id);
      for(const patch of redRun.finalState.selected)accumulatePatchRecall(state,cond,redRun,patch,'pending');
    }
  }

  function incrementPrecisionBucket(strict,inclusive,verdict){
    if(verdict==='supported'){strict.supported++;inclusive.supported++;}
    else if(verdict==='pre-existing'){strict.preExisting++;inclusive.preExisting++;}
    else if(verdict==='spin-boundary'){strict.spinBoundary++;inclusive.spinBoundary++;}
    else if(verdict==='gold-error'){strict.goldError++;inclusive.goldError++;}
    else if(verdict==='unsupported'){strict.pureFp++;inclusive.pureFp++;}
    else if(verdict==='mixed'){strict.mixed++;inclusive.mixed++;}
    else if(verdict==='uncertain')inclusive.uncertain++;
  }

  function tallyFindingAssessments(state,blueRun,latestReview,cond){
    const list=latestReview?.findingAssessments;
    if(!Array.isArray(list))return;
    for(const fa of list){
      const v=fa?.verdict||'pending';
      incrementPrecisionBucket(state.strict,state.inclusive,v);
      incrementPrecisionBucket(state.byCondition[cond].strict,state.byCondition[cond].inclusive,v);
      if(v==='gold-error'){
        state.goldV2Candidates.push({runId:blueRun.id,findingId:fa.id,reviewer:latestReview.reviewer||'',note:fa.note||''});
      }
    }
  }

  function countZeroDropOnRun(run){
    let n=0;
    const res=run?.response;
    if(Number.isInteger(res?.zeroDropRecovered)&&res.zeroDropRecovered>0)n+=res.zeroDropRecovered;
    else if(Array.isArray(res?.zeroDropRecovered))n+=res.zeroDropRecovered.length;
    if(Array.isArray(res?.findings)){
      n+=res.findings.filter(f=>f&&(f.zeroDropRecovered===true||f.recoveredByZeroDrop===true||f.origin==='zero-drop')).length;
    }
    return n;
  }

  function countZeroDropOnExternal(ext){
    let n=0;
    if(Number.isInteger(ext?.zeroDropRecovered)&&ext.zeroDropRecovered>0)return ext.zeroDropRecovered;
    if(Number.isInteger(ext?.snapshot?.zeroDropRecovered)&&ext.snapshot.zeroDropRecovered>0)return ext.snapshot.zeroDropRecovered;
    const items=ext?.snapshot?.items||[];
    for(const item of items){
      if(item&&(item.zeroDropRecovered===true||item.recovered===true||item.origin==='zero-drop'||item.status==='zero-drop-recovered'))n++;
    }
    return n;
  }

  function tallyExternalRecords(state,externalResponses,conditionOverrides){
    for(const ext of externalResponses){
      const role=ext?.snapshot?.role||ext?.role;
      if(role!=='blue')continue;
      const cond=inferCondition(ext,null,conditionOverrides);
      const zd=countZeroDropOnExternal(ext);
      state.inclusive.zeroDropRecovered+=zd;
      state.byCondition[cond].inclusive.zeroDropRecovered+=zd;
      for(const item of ext?.snapshot?.items||[]){
        if(item?.verdict){
          incrementPrecisionBucket(state.strict,state.inclusive,item.verdict);
          incrementPrecisionBucket(state.byCondition[cond].strict,state.byCondition[cond].inclusive,item.verdict);
        }
      }
    }
  }

  function buildLatestReviewMap(runs,reviews){
    const rootMap=new Map(runs.map(r=>[r.id,r.snapshotOf||r.id]));
    const latest=new Map();
    for(const v of reviews){
      if(!v||!v.runId)continue;
      const rootId=rootMap.get(v.runId)||v.runId;
      latest.set(rootId,v);
    }
    return latest;
  }

  function collectComparedRedIds(rootRuns,latestByRun,runs){
    const ids=new Set();
    for(const run of rootRuns){
      if(run.role!=='blue')continue;
      const comp=latestByRun.get(run.id)?.comparison;
      if(!comp?.assessments)continue;
      const redRun=resolveRedRun(runs,run,comp);
      if(redRun?.id)ids.add(redRun.id);
      if(redRun?.snapshotOf)ids.add(redRun.snapshotOf);
    }
    return ids;
  }

  function computeDualScoreboard({runs=[],reviews=[],externalResponses=[],conditionOverrides={}}={}){
    const rootRuns=runs.filter(r=>r&&!r.snapshotOf);
    const latestByRun=buildLatestReviewMap(runs,reviews);
    const comparedRedIds=collectComparedRedIds(rootRuns,latestByRun,runs);
    const state={
      redRecall:{...emptyRecallBucket(),byFamily:emptyFamilyMap(),bySurface:emptySurfaceMap()},
      strict:emptyStrictPrecision(),
      inclusive:emptyInclusivePrecision(),
      byCondition:{P0:emptyConditionBucket(),P2:emptyConditionBucket(),Holdout:emptyConditionBucket()},
      goldV2Candidates:[]
    };
    for(const run of rootRuns){
      if(run.role!=='blue')continue;
      const latest=latestByRun.get(run.id)||null;
      const cond=inferCondition(run,latest,conditionOverrides);
      state.byCondition[cond].runCount++;
      tallyBlueRunRecall(state,runs,run,latest,cond,comparedRedIds);
      tallyFindingAssessments(state,run,latest,cond);
      const zd=countZeroDropOnRun(run);
      state.inclusive.zeroDropRecovered+=zd;
      state.byCondition[cond].inclusive.zeroDropRecovered+=zd;
    }
    tallyExternalRecords(state,externalResponses,conditionOverrides);
    return {
      redRecall:state.redRecall,
      bluePrecisionDual:{strict:state.strict,inclusive:state.inclusive},
      byCondition:state.byCondition,
      goldV2Candidates:state.goldV2Candidates
    };
  }

  function canonicalModelFamily(model){
    if(typeof model!=='string')return null;
    const m=model.trim().toLowerCase();
    if(!m||m==='manual-model-unverified'||m==='unknown'||m==='미확인')return null;
    for(const [family,pattern] of FAMILY_RULES){
      if(pattern.test(m))return family;
    }
    return null;
  }

  function detectModelFamilyBias(redModel,blueModel){
    const redFamily=canonicalModelFamily(redModel);
    const blueFamily=canonicalModelFamily(blueModel);
    const sameFamily=Boolean(redFamily&&blueFamily&&redFamily===blueFamily);
    const warningKo=sameFamily
      ?'동일 모델 계열 경고: RED와 BLUE가 같은 모델 계열을 쓰면 선호 위치·맹점이 겹쳐 탐지 성능이 과대추정될 수 있습니다. 이종 모델 교차 검증을 권장합니다.'
      :'';
    return {sameFamily,redFamily,blueFamily,warningKo};
  }

  function normalizeFindingKey(finding){
    const seg=String(finding?.segmentId||'');
    const quote=String(finding?.quote||'').replace(/\s+/g,' ').trim().slice(0,80);
    return seg+'::'+quote;
  }

  function analyzeRepeatGroup(groupRuns,latestByRun){
    const byKey=new Map();
    for(const run of groupRuns){
      const latest=latestByRun.get(run.id);
      const assessments=latest?.findingAssessments||[];
      const seenInRun=new Set();
      for(const f of run.response?.findings||[]){
        const key=normalizeFindingKey(f);
        if(!byKey.has(key))byKey.set(key,{runs:0,verdicts:new Set()});
        const entry=byKey.get(key);
        if(!seenInRun.has(key)){entry.runs++;seenInRun.add(key);}
        const v=assessments.find(a=>a.id===f.id)?.verdict;
        if(v&&v!=='pending')entry.verdicts.add(v);
      }
    }
    let stableFindingCount=0,flippedFindingCount=0;
    const stableKeys=[],flippedKeys=[];
    for(const [key,entry] of byKey.entries()){
      if(entry.runs===groupRuns.length&&entry.verdicts.size<=1){stableFindingCount++;stableKeys.push(key);}
      else {flippedFindingCount++;flippedKeys.push(key);}
    }
    const first=groupRuns[0];
    return {
      fileHash:first.fileHash,harnessHash:first.harnessHash,
      harnessName:first.harness?.name||'',runIds:groupRuns.map(r=>r.id),
      runCount:groupRuns.length,stableFindingCount,flippedFindingCount,stableKeys,flippedKeys
    };
  }

  function computeRepeatRunFlips(runs=[],reviews=[]){
    const latestByRun=buildLatestReviewMap(runs,reviews);
    const grouped=new Map();
    for(const run of runs){
      if(!run||run.snapshotOf||run.role!=='blue')continue;
      const key=(run.fileHash||'')+'::'+(run.harnessHash||'');
      const list=grouped.get(key)||[];
      list.push(run);
      grouped.set(key,list);
    }
    const groups=[];
    let stableFindingCount=0,flippedFindingCount=0;
    for(const list of grouped.values()){
      if(list.length<2)continue;
      const g=analyzeRepeatGroup(list,latestByRun);
      groups.push(g);
      stableFindingCount+=g.stableFindingCount;
      flippedFindingCount+=g.flippedFindingCount;
    }
    return {groupCount:groups.length,stableFindingCount,flippedFindingCount,groups};
  }

  function csvSafeText(value,neutralizeFormula){
    let s=value===undefined||value===null?'':String(value);
    if(neutralizeFormula&&/^[=+\-@]/.test(s))s="'"+s;
    if(/[",\r\n]/.test(s))return '"'+s.replace(/"/g,'""')+'"';
    return s;
  }

  function formatCsvRow(row){
    const textCols=new Set([0,1,3,5,6,8]);
    return row.map((val,idx)=>csvSafeText(val,textCols.has(idx))).join(',');
  }

  function resolveObservedTimeSec(run){
    if(Number.isFinite(run?.timeSec))return String(run.timeSec);
    if(Number.isFinite(run?.durationSec))return String(run.durationSec);
    if(Number.isFinite(run?.response?.coverage?.timeSec))return String(run.response.coverage.timeSec);
    if(Number.isFinite(run?.durationMs))return (run.durationMs/1000).toFixed(2);
    return '';
  }

  function resolveObservedTokens(run){
    if(Number.isInteger(run?.tokens))return String(run.tokens);
    if(Number.isInteger(run?.response?.coverage?.tokens))return String(run.response.coverage.tokens);
    return '';
  }

  function inferFindingDefectType(finding,run,redRun,latestReview){
    if(typeof finding?.defectType==='string'&&finding.defectType)return finding.defectType;
    const comp=latestReview?.comparison;
    const idx=comp?.assessments?.findIndex(a=>Array.isArray(a.quoteOverlapFindingIds)&&a.quoteOverlapFindingIds.includes(finding.id))??-1;
    if(idx>=0){
      const patch=comp.selected?.[idx];
      return classifyDefectFamily(findRedCandidate(redRun,patch),patch,redRun);
    }
    if(typeof finding?.findingType==='string'&&finding.findingType){
      return ATTACK_TO_FAMILY[finding.findingType]||finding.findingType;
    }
    return '';
  }

  function mapFindingCsvLabel(finding,verdict){
    if(finding?.zeroDropRecovered===true||finding?.recoveredByZeroDrop===true||finding?.origin==='zero-drop'){
      return verdict==='supported'||verdict==='pre-existing'?'아님':'확인필요';
    }
    return VERDICT_TO_CSV_LABEL[verdict]||'확인필요';
  }

  function buildLedgerBlueCsvRows(run,runs,latestByRun,iteration,conditionOverrides,meta){
    const latest=latestByRun.get(run.id)||null;
    const cond=inferCondition(run,latest,conditionOverrides);
    const isHoldout=cond==='Holdout'?'true':'false';
    const paperId=meta.paperId||run.sourceName||(run.fileHash?run.fileHash.slice(0,12):'');
    const team=meta.team||'falsify';
    const model=run.model==='manual-model-unverified'?'unknown':(run.model||'');
    const timeSec=resolveObservedTimeSec(run),tokens=resolveObservedTokens(run);
    const findings=run.response?.findings||[];
    if(!findings.length){
      const label=run.response?.status==='ok'?'맞음':'확인필요';
      return [[paperId,team,'harness',model,String(iteration),'','',label,'지적 없음 ('+(run.response?.status||'unknown')+')',timeSec,tokens,isHoldout]];
    }
    const redRun=resolveRedRun(runs,run,latest?.comparison);
    const assessments=latest?.findingAssessments||[];
    return findings.map(f=>{
      const fa=assessments.find(a=>a.id===f.id);
      const verdict=fa?.verdict||'pending';
      const loc=run.segments?.find(s=>s.id===f.segmentId)?.label||f.segmentId||'';
      const dtype=inferFindingDefectType(f,run,redRun,latest);
      const evidence=[f.rationale,fa?.note].filter(Boolean).join(' | ');
      return [paperId,team,'harness',model,String(f.iteration??iteration),loc,dtype,mapFindingCsvLabel(f,verdict),evidence,timeSec,tokens,isHoldout];
    });
  }

  function externalItemLocation(item){
    if(item.locationLabel)return item.locationLabel;
    if(Number.isInteger(item.pageIndex))return 'p.'+(item.pageIndex+1);
    return item.segmentId||'';
  }

  function externalItemLabel(item){
    if(typeof item.label==='string'&&['아님','맞음','확인필요'].includes(item.label))return item.label;
    const verdict=item.verdict||(item.zeroDropRecovered?'uncertain':'pending');
    return VERDICT_TO_CSV_LABEL[verdict]||'확인필요';
  }

  function externalItemRow(item,batches,paperId,team,isHoldout){
    const refId=item.sourceRefs?.[0]?.batchId;
    const batch=batches.find(b=>b.id===refId)||batches[0]||{};
    const dtype=ATTACK_TO_FAMILY[item.findingType]||item.defectType||item.findingType||'';
    const evidence=item.rationale||item.quote||'';
    return [paperId,team,'external-ai',batch.model||'',String(item.iteration??1),externalItemLocation(item),dtype,externalItemLabel(item),evidence,'','',isHoldout];
  }

  function buildExternalBlueCsvRows(ext,conditionOverrides,meta){
    const role=ext?.snapshot?.role||ext?.role;
    if(role!=='blue')return [];
    const isHoldout=inferCondition(ext,null,conditionOverrides)==='Holdout'?'true':'false';
    const paperId=meta.paperId||ext.sourceName||(ext.fileHash?ext.fileHash.slice(0,12):'');
    const team=meta.team||'falsify';
    const batches=ext.snapshot?.batches||[];
    return (ext.snapshot?.items||[]).map(item=>externalItemRow(item,batches,paperId,team,isHoldout));
  }

  function exportBlueScoreCsv({runs=[],reviews=[],externalResponses=[],conditionOverrides={},meta={}}={}){
    const latestByRun=buildLatestReviewMap(runs,reviews);
    const seenPairs=new Map();
    const rows=[SCORE_CSV_HEADERS.slice()];
    for(const run of runs){
      if(!run||run.snapshotOf||run.role!=='blue')continue;
      const pairKey=(run.fileHash||'')+'::'+(run.harnessHash||'');
      const iter=(seenPairs.get(pairKey)||0)+1;
      seenPairs.set(pairKey,iter);
      for(const r of buildLedgerBlueCsvRows(run,runs,latestByRun,iter,conditionOverrides,meta))rows.push(r);
    }
    for(const ext of externalResponses){
      for(const r of buildExternalBlueCsvRows(ext,conditionOverrides,meta))rows.push(r);
    }
    return rows.map(formatCsvRow).join('\n');
  }

  function hasGoldErrorForRed(redRun,runs,reviews){
    const latestByRun=buildLatestReviewMap(runs,reviews);
    const targetId=redRun?.id;
    const outHash=redRun?.finalState?.outputFileHash;
    for(const v of latestByRun.values()){
      const paired=v?.comparison?.sourceRunId===targetId||(outHash&&v?.comparison?.outputFileHash===outHash);
      if(!paired)continue;
      if((v.findingAssessments||[]).some(fa=>fa.verdict==='gold-error'))return true;
    }
    return reviews.some(v=>{
      const paired=v?.comparison?.sourceRunId===targetId||(outHash&&v?.comparison?.outputFileHash===outHash);
      return paired&&(v.findingAssessments||[]).some(fa=>fa.verdict==='gold-error');
    });
  }

  function buildRedAnswerEntry(p,ctx){
    const candidate=findRedCandidate(ctx.rootRun,p)||findRedCandidate(ctx.effectiveRed,p)||p;
    const seg=ctx.effectiveRed.segments?.find(s=>s.id===p.segmentId);
    const afterVal=p.after??candidate.after??'';
    return {
      paper_id:ctx.paperId,
      team:ctx.team,
      defect_type:classifyDefectFamily(candidate,p,ctx.effectiveRed),
      location:p.label||seg?.label||p.segmentId||'',
      before:p.before??candidate.before??'',
      after:afterVal,
      iterations:ctx.iterations,
      self_check_model:ctx.model,
      patch_v1:candidate.after??afterVal,
      patch_final:afterVal,
      why_hard:String(candidate.rationale||'').slice(0,500),
      ai_assisted:Boolean(ctx.effectiveRed.provenance==='local-codex'||true),
      gold_version:ctx.goldVersion
    };
  }

  function resolveEffectiveRedRuns(redRun,runs){
    const rootRun=redRun.snapshotOf?(runs.find(r=>r.id===redRun.snapshotOf)||redRun):redRun;
    const latestSnap=runs.filter(r=>r.snapshotOf===rootRun.id&&r.finalState?.selected).at(-1);
    const effectiveRed=redRun.finalState?.selected?redRun:(latestSnap||redRun);
    return {rootRun,effectiveRed};
  }

  function buildRedAnswerContext(redRun,runs,reviews,meta){
    const {rootRun,effectiveRed}=resolveEffectiveRedRuns(redRun,runs);
    const goldVersion=hasGoldErrorForRed(effectiveRed,runs,reviews)||hasGoldErrorForRed(rootRun,runs,reviews)?'v2-candidate':'v1';
    const rawModel=effectiveRed.model||'';
    const calls=effectiveRed.response?.coverage?.calls;
    const filePrefix=effectiveRed.fileHash?effectiveRed.fileHash.slice(0,12):'';
    return {
      rootRun,effectiveRed,goldVersion,
      paperId:meta.paperId||effectiveRed.sourceName||filePrefix,
      team:meta.team||'falsify',
      iterations:Number.isInteger(calls)?calls:(meta.iterations??1),
      model:rawModel==='manual-model-unverified'?'':rawModel
    };
  }

  function exportRedAnswerKeyJson({redRun,runs=[],reviews=[],meta={}}={}){
    if(!redRun)return {schema:'falsify.red-answer-key.v1',gold_version:'v1',entries:[]};
    const ctx=buildRedAnswerContext(redRun,runs,reviews,meta);
    const patches=ctx.effectiveRed.finalState?.selected||ctx.effectiveRed.response?.candidates||[];
    return {schema:'falsify.red-answer-key.v1',gold_version:ctx.goldVersion,entries:patches.map(p=>buildRedAnswerEntry(p,ctx))};
  }

  function blueFamilyRules(byFamily){
    const rules=[];
    if(byFamily.D2?.missed>0)rules.push('D2(인용 왜곡) 미탐 '+byFamily.D2.missed+'건: PDF 링크(/URI)와 본문 표기 DOI·서지 정보를 교차 검증하고 중복 참고문헌을 점검하세요.');
    if(byFamily.D1?.missed>0)rules.push('D1(수치 변형) 미탐 '+byFamily.D1.missed+'건: 본문·표·초록 간 표본 수, 효과크기, 신뢰구간, p-값 산술 일관성을 대조하세요.');
    if(byFamily.D3?.missed>0)rules.push('D3(논리 모순) 미탐 '+byFamily.D3.missed+'건: 초록·결론의 단정적 주장과 방법·한계 섹션의 전제·제외 조건 충돌을 확인하세요.');
    if(byFamily['D4-1']?.missed>0)rules.push('D4-1(결과지표·등록부 왜곡) 미탐 '+byFamily['D4-1'].missed+'건: pre-specified/primary outcome 주장을 연구방법 및 등록부 기준과 대조하세요.');
    if(byFamily.S1?.missed>0)rules.push('S1(의미 반전) 미탐 '+byFamily.S1.missed+'건: 부정어·방향성 반전과 상관→인과 과잉 해석을 문맥 단위로 검증하세요.');
    return rules;
  }

  function buildBlueBrief(scoreboard){
    const r=scoreboard?.redRecall||emptyRecallBucket();
    const byFamily=r.byFamily||emptyFamilyMap();
    const s=scoreboard?.bluePrecisionDual?.strict||emptyStrictPrecision();
    const inc=scoreboard?.bluePrecisionDual?.inclusive||emptyInclusivePrecision();
    const holdoutFp=scoreboard?.byCondition?.Holdout?.strict?.pureFp||0;
    const summary='관찰 요약: 적중 '+r.detectedStrict+' / 주입 '+r.injectedTotal+'건(확인필요 포함 '+r.detectedInclusive+'건) · 미탐 '+r.missed+'건 · 순수 오탐 '+s.pureFp+'건 · 원본 기존 오류 '+s.preExisting+'건 · 스핀 경계 '+s.spinBoundary+'건 · Zero-Drop 복구 '+inc.zeroDropRecovered+'건.';
    const rules=blueFamilyRules(byFamily);
    if(s.pureFp>0)rules.push('순수 오탐 '+s.pureFp+'건 완화: 원시 p-값 지적 전 Bonferroni/FDR 다중검정 보정과 부분집합 분모 조건을 먼저 확인하세요.');
    if(holdoutFp>0)rules.push('Holdout 대조군 순수 오탐 '+holdoutFp+'건: 정상 논문의 표준 통계 보정·요약 문장을 결함으로 오인하지 않도록 반증 확인 절차를 강화하세요.');
    if(s.preExisting>0)rules.push('원본 기존 오류 '+s.preExisting+'건 분리: 출판본 자체의 기존 불일치는 순수 오탐과 구분해 별도 근거와 함께 보고하세요.');
    if(inc.zeroDropRecovered>0)rules.push('Zero-Drop 복구 '+inc.zeroDropRecovered+'건 보존: 신뢰도 경계 지적을 즉시 탈락시키지 말고 확인필요(uncertain) 등급으로 유지하세요.');
    if(!rules.length)rules.push('현재 기록된 미탐·순수 오탐은 0건입니다. 본문·표·차트·인용·등록부 교차 검증과 확인필요 분리 원칙을 유지하세요.');
    return {
      role:'blue',
      title:'경찰(BLUE) 검증 도구 보강 지침',
      summary,
      rules,
      instructionsText:['[BLUE Co-Evolution Brief]',summary,...rules.map((line,i)=>(i+1)+'. '+line)].join('\n')
    };
  }

  function buildRedBrief(scoreboard){
    const r=scoreboard?.redRecall||emptyRecallBucket();
    const byFamily=r.byFamily||emptyFamilyMap();
    const s=scoreboard?.bluePrecisionDual?.strict||emptyStrictPrecision();
    const summary='관찰 요약: 주입 '+r.injectedTotal+'건 중 BLUE 확정 탐지 '+r.detectedStrict+'건(확인필요 포함 '+r.detectedInclusive+'건), 미탐 '+r.missed+'건 · 정답표 오류 후보 '+s.goldError+'건.';
    const detectedOnly=[],missedFamilies=[];
    for(const fam of DEFECT_FAMILIES){
      const b=byFamily[fam];
      if(!b||!b.injected)continue;
      if(b.missed>0)missedFamilies.push(fam+'('+b.missed+'/'+b.injected+')');
      else if(b.detectedStrict>0)detectedOnly.push(fam+'('+b.detectedStrict+'/'+b.injected+')');
    }
    const rules=[];
    if(detectedOnly.length)rules.push('기탐지 유형 고도화('+detectedOnly.join(', ')+'): L1 → L2 → L3 → L4 단계로 교차 섹션(본문↔표·차트·참고문헌) 연동을 강화하고 단순 어휘 치환은 피하세요.');
    if(missedFamilies.length)rules.push('미탐 취약 축 유지('+missedFamilies.join(', ')+'): 현재 BLUE 맹점이 확인된 결함 축을 다중 표면 결합 테스트로 확장하세요.');
    if(s.goldError>0)rules.push('정답표 오류 '+s.goldError+'건 재검토: 원문과 양립 가능하거나 모호한 후보는 정답지 v2 개정 시 제외·정교화하세요.');
    if(!rules.length)rules.push('다음 라운드에서는 L1 → L2 → L3 → L4 순으로 본문-표-차트-등록부 교차 일관성 스트레스 테스트를 설계하세요. 정답 힌트나 과장 단서는 남기지 마세요.');
    return {
      role:'red',
      title:'도둑(RED) 스트레스 테스트 고도화 지침',
      summary,
      rules,
      instructionsText:['[RED Co-Evolution Brief]',summary,...rules.map((line,i)=>(i+1)+'. '+line)].join('\n')
    };
  }

  function buildCoevolutionBrief({role,scoreboard}={}){
    return role==='red'?buildRedBrief(scoreboard):buildBlueBrief(scoreboard);
  }

  function loadConditions(storage){
    try{
      const parsed=JSON.parse(storage?.getItem?.(CONDITION_STORAGE_KEY)||'{}');
      return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};
    }catch{return {};}
  }

  function saveConditions(storage,conditions){
    try{storage?.setItem?.(CONDITION_STORAGE_KEY,JSON.stringify(conditions));}catch{}
  }

  async function loadLedgerData(){
    try{
      if(typeof root.FalsifyLab?.reviewSnapshot==='function'){
        const snap=await root.FalsifyLab.reviewSnapshot();
        if(snap)return {runs:snap.runs||[],reviews:snap.reviews||[],externalResponses:snap.externalResponses||[]};
      }
    }catch{}
    try{
      const raw=root.localStorage?.getItem?.(LEDGER_KEY);
      const parsed=raw?JSON.parse(raw):null;
      if(parsed)return {runs:parsed.runs||[],reviews:parsed.reviews||[],externalResponses:parsed.externalResponses||[]};
    }catch{}
    return {runs:[],reviews:[],externalResponses:[]};
  }

  function bumpVersion(ver){
    const raw=typeof ver==='string'&&ver.trim()?ver.trim():'1';
    const m=/^(.*?)(\d+)$/.exec(raw);
    const next=m?m[1]+String(Number(m[2])+1):raw+'.2';
    return next.slice(0,80);
  }

  async function openHarnessDraft(doc,role,brief,statusEl){
    try{
      const list=typeof root.FalsifyLab?.promptInstructions==='function'?await root.FalsifyLab.promptInstructions(role):[];
      const sel=typeof root.FalsifyLab?.selectedHarness==='function'?root.FalsifyLab.selectedHarness(role):null;
      const base=(sel&&list.find(h=>h.id===sel.id&&h.version===sel.version))||list[0]||{id:'builtin-'+role,name:'기본 '+role.toUpperCase(),version:'1',instructions:sel?.instructions||'',role,hash:''};
      const merged=[base.instructions,brief.instructionsText].filter(Boolean).join('\n\n').slice(0,8000);
      const detail={...base,role,version:bumpVersion(base.version),instructions:merged};
      const Ev=root.CustomEvent||globalThis.CustomEvent;
      doc.querySelector('[data-view="'+(role==='red'?'workbench':'blue')+'"]')?.click();
      doc.dispatchEvent(new Ev('falsify:edit-harness-instructions',{detail}));
      doc.dispatchEvent(new Ev('falsify:reveal-prompt',{detail:{role}}));
      if(statusEl)statusEl.textContent=role.toUpperCase()+' Harness 보강 초안을 열었습니다 (v'+detail.version+').';
    }catch(e){
      if(statusEl)statusEl.textContent='Harness 초안을 열지 못했습니다: '+(e?.message||e);
    }
  }

  function downloadBlob(doc,content,mime,filename){
    if(typeof root.Blob!=='function'||typeof root.URL?.createObjectURL!=='function')return false;
    const url=root.URL.createObjectURL(new root.Blob([content],{type:mime}));
    const a=doc.createElement('a');
    a.href=url;a.download=filename;a.click();
    if(typeof root.setTimeout==='function')root.setTimeout(()=>root.URL.revokeObjectURL(url),1000);
    return true;
  }

  function el(doc,tag,text,cls){
    const n=doc.createElement(tag);
    if(text!==undefined)n.textContent=text;
    if(cls)n.className=cls;
    return n;
  }

  function latestModelsForBias(runs){
    const blues=runs.filter(r=>!r.snapshotOf&&r.role==='blue');
    const reds=runs.filter(r=>r.role==='red');
    for(const blue of blues){
      const red=resolveRedRun(runs,blue,null);
      if(!red)continue;
      const bias=detectModelFamilyBias(red.model,blue.model);
      if(bias.sameFamily)return bias;
    }
    return detectModelFamilyBias(reds.at(-1)?.model,blues.at(-1)?.model);
  }

  function renderScoreboardTable(doc,sb){
    const wrap=el(doc,'div',undefined,'arena-table-wrap');
    const table=el(doc,'table',undefined,'arena-table');
    const head=el(doc,'thead'),hr=el(doc,'tr');
    for(const h of ['조건 / 기준','RED 탐지 (엄격 / 확인필요 포함)','확정 지적 · 순수 오탐','기존 오류 · 스핀 · 정답표 오류','확인필요 · Zero-Drop']){
      hr.append(el(doc,'th',h));
    }
    head.append(hr);table.append(head);
    const body=el(doc,'tbody');
    const addRow=(title,rec,strict,inc)=>{
      const tr=el(doc,'tr');
      tr.append(
        el(doc,'td',title),
        el(doc,'td','적중 '+rec.detectedStrict+' / 주입 '+rec.injectedTotal+'건 (포함 '+rec.detectedInclusive+' · 미탐 '+rec.missed+')'),
        el(doc,'td','타당 '+strict.supported+'건 · 순수 오탐 '+strict.pureFp+'건 · 일부 '+strict.mixed+'건'),
        el(doc,'td','원본 기존 오류 '+strict.preExisting+'건 · 스핀 '+strict.spinBoundary+'건 · 정답표 오류 '+strict.goldError+'건'),
        el(doc,'td','확인필요 '+inc.uncertain+'건 · Zero-Drop '+inc.zeroDropRecovered+'건')
      );
      body.append(tr);
    };
    addRow('전체 (확정[아님] vs 확인필요 포함)',sb.redRecall,sb.bluePrecisionDual.strict,sb.bluePrecisionDual.inclusive);
    for(const cond of CONDITIONS){
      const c=sb.byCondition[cond];
      addRow(cond+' ('+c.runCount+'건)',c.redRecall,c.strict,c.inclusive);
    }
    table.append(body);wrap.append(table);return wrap;
  }

  function renderBreakdownCards(doc,sb,flips){
    const grid=el(doc,'div',undefined,'arena-grid');
    const famCard=el(doc,'article',undefined,'arena-card');
    famCard.append(el(doc,'h4','RED 결함 계열별 탐지 관찰 (D1~S1)'));
    const famText=DEFECT_FAMILIES.map(f=>{
      const b=sb.redRecall.byFamily[f];
      return f+': 적중 '+b.detectedStrict+'/'+b.injected+' (미탐 '+b.missed+')';
    }).join(' · ');
    famCard.append(el(doc,'p',famText));
    const surfText=SURFACES.map(s=>{
      const b=sb.redRecall.bySurface[s];
      return s+': '+b.detectedStrict+'/'+b.injected;
    }).join(' · ');
    famCard.append(el(doc,'p','표면별: '+surfText,'muted'));

    const flipCard=el(doc,'article',undefined,'arena-card');
    flipCard.id='arena-flip-summary';
    flipCard.append(el(doc,'h4','반복 실행 판정 변동 (Flip) 추적'));
    flipCard.append(el(doc,'p','동일 파일·Harness 반복 그룹 '+flips.groupCount+'개 · 안정 지적 '+flips.stableFindingCount+'건 · 변동 지적 '+flips.flippedFindingCount+'건'));

    grid.append(famCard,flipCard);
    return grid;
  }

  function renderConditionTagger(doc,runs,conditions,onChange){
    const box=el(doc,'div',undefined,'arena-condition-list');
    const blueRuns=runs.filter(r=>r&&!r.snapshotOf&&r.role==='blue');
    if(!blueRuns.length){box.append(el(doc,'p','조건을 지정할 BLUE 실행 기록이 없습니다.','muted'));return box;}
    for(const r of blueRuns){
      const row=el(doc,'div',undefined,'arena-condition-row');
      row.append(el(doc,'span',(r.sourceName||r.fileHash.slice(0,12))+' · '+r.id.slice(0,8)));
      const sel=el(doc,'select');
      sel.setAttribute('aria-label',(r.sourceName||r.id)+' 실험 조건');
      for(const c of CONDITIONS){const opt=el(doc,'option',c);opt.value=c;sel.append(opt);}
      sel.value=normalizeCondition(conditions[r.id])||inferCondition(r,null,conditions);
      sel.addEventListener('change',()=>onChange(r.id,sel.value));
      row.append(sel);
      box.append(row);
    }
    return box;
  }

  function renderGoldV2Banner(doc,candidates){
    const banner=el(doc,'div',undefined,'arena-banner is-v2');
    banner.id='arena-gold-v2';
    if(!candidates.length){
      banner.append(el(doc,'p','정답표 오류(gold-error)로 표시된 RED v2 개정 후보가 없습니다.'));
      return banner;
    }
    banner.append(el(doc,'strong','RED 정답지 v2 개정 후보 '+candidates.length+'건'));
    const ul=el(doc,'ul',undefined,'arena-gold-list');
    for(const c of candidates){
      ul.append(el(doc,'li',c.runId.slice(0,8)+' · '+c.findingId+(c.reviewer?' ('+c.reviewer+')':'')+(c.note?' — '+c.note:'')));
    }
    banner.append(ul);
    return banner;
  }

  function renderBriefsSection(doc,sb,statusEl){
    const grid=el(doc,'div',undefined,'arena-grid');
    for(const role of ['blue','red']){
      const brief=buildCoevolutionBrief({role,scoreboard:sb});
      const card=el(doc,'article',undefined,'arena-card');
      card.append(el(doc,'h4',brief.title),el(doc,'pre',brief.instructionsText,'arena-brief-preview'));
      const btn=el(doc,'button',role==='blue'?'BLUE Harness 보강 초안 열기 (C1)':'RED Harness 고도화 초안 열기 (C1)','button secondary');
      btn.type='button';
      btn.id='arena-open-'+role+'-brief';
      btn.addEventListener('click',()=>openHarnessDraft(doc,role,brief,statusEl));
      const btnRow=el(doc,'div',undefined,'button-row');
      btnRow.append(btn);
      card.append(btnRow);
      grid.append(card);
    }
    return grid;
  }

  function buildMetaControls(doc){
    const row=el(doc,'div',undefined,'arena-meta-row');
    const paperLabel=el(doc,'label','내보내기 paper_id');
    const paperInput=el(doc,'input');
    paperInput.id='arena-paper-id';paperInput.type='text';paperInput.placeholder='미입력 시 파일명/해시 사용';
    paperLabel.append(paperInput);
    const teamLabel=el(doc,'label','팀명 (team)');
    const teamInput=el(doc,'input');
    teamInput.id='arena-team';teamInput.type='text';teamInput.value='falsify';
    teamLabel.append(teamInput);
    row.append(paperLabel,teamLabel);
    return {row,paperInput,teamInput};
  }

  function buildExportActions(doc,getState){
    const actions=el(doc,'div',undefined,'button-row');
    const csvBtn=el(doc,'button','score.py 호환 12열 BLUE CSV 저장','button primary');
    csvBtn.id='arena-export-csv';csvBtn.type='button';
    const jsonBtn=el(doc,'button','RED 정답지 JSON 저장','button secondary');
    jsonBtn.id='arena-export-red-json';jsonBtn.type='button';
    csvBtn.addEventListener('click',()=>{
      const {data,conditions,meta,statusEl}=getState();
      const csv=exportBlueScoreCsv({...data,conditionOverrides:conditions,meta});
      downloadBlob(doc,csv,'text/csv;charset=utf-8','falsify-blue-score.csv');
      statusEl.textContent='score.py 호환 12열 BLUE CSV를 내보냈습니다.';
    });
    jsonBtn.addEventListener('click',()=>{
      const {data,meta,statusEl}=getState();
      const reds=data.runs.filter(r=>r.role==='red');
      const redRun=reds.filter(r=>r.finalState?.selected?.length).at(-1)||reds.at(-1)||null;
      const payload=exportRedAnswerKeyJson({redRun,runs:data.runs,reviews:data.reviews,meta});
      downloadBlob(doc,JSON.stringify(payload,null,2),'application/json','falsify-red-answer-key.json');
      statusEl.textContent='RED 정답지 JSON을 내보냈습니다 ('+payload.entries.length+'건 · '+payload.gold_version+').';
    });
    actions.append(csvBtn,jsonBtn);
    return actions;
  }

  function mount(doc){
    if(!doc)return null;
    const host=doc.querySelector('#view-results');
    if(!host)return null;
    let section=doc.querySelector('#coevolution-arena');
    if(!section){section=el(doc,'section',undefined,'coevolution-arena document-red');section.id='coevolution-arena';host.append(section);}
    const body=el(doc,'div'),statusEl=el(doc,'p','','arena-status');
    statusEl.setAttribute('role','status');
    const metaUi=buildMetaControls(doc);
    let latestData={runs:[],reviews:[],externalResponses:[]};
    let conditions=loadConditions(root.localStorage);

    async function refresh(){
      latestData=await loadLedgerData();
      conditions=loadConditions(root.localStorage);
      const sb=computeDualScoreboard({...latestData,conditionOverrides:conditions});
      const flips=computeRepeatRunFlips(latestData.runs,latestData.reviews);
      const bias=latestModelsForBias(latestData.runs);
      body.replaceChildren();
      if(bias.sameFamily){
        const warn=el(doc,'div',bias.warningKo,'arena-banner');warn.id='arena-family-bias';body.append(warn);
      }
      body.append(
        renderScoreboardTable(doc,sb),
        renderBreakdownCards(doc,sb,flips),
        renderGoldV2Banner(doc,sb.goldV2Candidates),
        el(doc,'h3','실험 조건 태그 (P0 / P2 / Holdout)'),
        renderConditionTagger(doc,latestData.runs,conditions,(id,val)=>{conditions={...conditions,[id]:val};saveConditions(root.localStorage,conditions);refresh();}),
        el(doc,'h3','정답 미노출 상보 진화 지침 (C1 Harness 초안)'),
        renderBriefsSection(doc,sb,statusEl)
      );
    }

    const head=el(doc,'div',undefined,'arena-head');
    const refreshBtn=el(doc,'button','아레나 새로고침','button secondary');
    refreshBtn.id='arena-refresh';refreshBtn.type='button';
    refreshBtn.addEventListener('click',()=>refresh());
    head.append(el(doc,'h2','경찰(BLUE) ↔ 도둑(RED) 상보적 진화 아레나'),refreshBtn);

    const actions=buildExportActions(doc,()=>({
      data:latestData,
      conditions,
      meta:{paperId:metaUi.paperInput.value.trim(),team:metaUi.teamInput.value.trim()||'falsify'},
      statusEl
    }));
    section.replaceChildren(head,metaUi.row,actions,statusEl,body);

    const resultsTab=doc.querySelector('[data-view="results"]');
    resultsTab?.addEventListener('click',()=>refresh());
    if(root.FalsifyLab?.ready&&typeof root.FalsifyLab.ready.then==='function'){
      root.FalsifyLab.ready.then(()=>refresh(),()=>{});
    }
    refresh();
    return {section,refresh};
  }

  if(root.document){
    if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',()=>mount(root.document),{once:true});
    else mount(root.document);
  }

  return {
    CONDITION_STORAGE_KEY,
    SCORE_CSV_HEADERS,
    DEFECT_FAMILIES,
    SURFACES,
    computeDualScoreboard,
    detectModelFamilyBias,
    computeRepeatRunFlips,
    exportBlueScoreCsv,
    exportRedAnswerKeyJson,
    buildCoevolutionBrief,
    inferCondition,
    classifyDefectFamily,
    classifySurface,
    canonicalModelFamily,
    mount
  };
});
