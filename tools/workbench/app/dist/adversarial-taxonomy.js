/* Oracle-centered adversarial defect taxonomy and blindness leakage scanner. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.FalsifyAdversarialTaxonomy=api;
})(globalThis,function(){
  'use strict';
  const SCHEMA='falsify.adversarial-taxonomy.v2';
  const ATTACK_TYPES=[
    'contradiction',
    'condition-omission',
    'unsupported-inference',
    'numeric-drift',
    'citation-distortion',
    'outcome-status-mislabeling',
    'semantic-inversion',
  ];
  const FAMILIES={
    D1:{
      code:'D1',
      labelKo:'수치·표·그림 불일치',
      labelEn:'Numeric/Table/Figure Drift',
      oracleSource:'internal-table-figure-math',
      attackTypes:['numeric-drift'],
      subtypes:['stat-pvalue-mismatch','percentage-mismatch','table-sum-mismatch','cross-modal-mismatch','ci-mismatch'],
    },
    D2:{
      code:'D2',
      labelKo:'인용·서지·링크 왜곡',
      labelEn:'Citation/Bibliography/URI Distortion',
      oracleSource:'bib-db-and-pdf-uri',
      attackTypes:['citation-distortion'],
      subtypes:['full-fabrication','attribute-corruption','identifier-hijack','claim-mismatch'],
    },
    D3:{
      code:'D3',
      labelKo:'근거보다 센 결론·스핀',
      labelEn:'Overclaiming/Spin',
      oracleSource:'internal-methods-results',
      attackTypes:['contradiction','condition-omission','unsupported-inference'],
      subtypes:['value-or-direction-contradiction','statistical-overclaim','scope-extrapolation'],
    },
    'D4-1':{
      code:'D4-1',
      labelKo:'결과 지위 오표기',
      labelEn:'Outcome Status Mislabeling',
      oracleSource:'external-registry-protocol',
      attackTypes:['outcome-status-mislabeling'],
      subtypes:['posthoc-as-prespecified','secondary-as-primary'],
    },
    S1:{
      code:'S1',
      labelKo:'도메인 기전·극성 역전',
      labelEn:'Domain Semantic/Polarity Inversion',
      oracleSource:'domain-mechanism-definition',
      attackTypes:['semantic-inversion'],
      subtypes:['marker-polarity-flip','pathway-direction-flip'],
    },
  };
  const SURFACES=['prose','table','chart','citation','registry'];
  const LEVELS={
    1:{level:1,labelKo:'단일 오라클 즉시 대조',labelEn:'Single-oracle direct comparison'},
    2:{level:2,labelKo:'다중 결함 혼합·주의 분산',labelEn:'Multi-defect mixing and distraction'},
    3:{level:3,labelKo:'절 간 교차 추론 필요',labelEn:'Cross-clause reasoning required'},
    4:{level:4,labelKo:'출판 논문 내재 불일치 수준 고난도 은닉',labelEn:'Published-paper-grade high-stealth inconsistency'},
  };
  const LEVEL4_DEFAULT_TYPES=['contradiction','condition-omission','unsupported-inference','numeric-drift'];
  const FAMILY_BY_ATTACK={
    'numeric-drift':'D1',
    'citation-distortion':'D2',
    'contradiction':'D3',
    'condition-omission':'D3',
    'unsupported-inference':'D3',
    'outcome-status-mislabeling':'D4-1',
    'semantic-inversion':'S1',
  };
  const TEXT_LEAK_RULES=[
    {code:'english_blindness_hint',source:'\\b\\d+\\s+intentional\\s+(?:errors?|defects?|flaws?|mutations?)\\b',flags:'gi'},
    {code:'english_blindness_hint',source:'\\b(?:intentional|injected|planted|synthetic)\\s+(?:errors?|defects?|flaws?|mutations?)\\b',flags:'gi'},
    {code:'english_blindness_hint',source:'\\b(?:answer[\\s_-]*key|tampered[\\s_-]*(?:copy|pdf|version)|red[\\s_-]*team[\\s_-]*injected)\\b',flags:'gi'},
    {code:'korean_blindness_hint',source:'(?:의도적\\s*(?:오류|결함)|변조본|주입된?\\s*결함|결함\\s*\\d+\\s*개|오류\\s*\\d+\\s*개\\s*(?:주입|포함)|정답지|정답표)',flags:'g'},
  ];
  const META_LEAK_RULES=[
    {code:'metadata_blindness_hint',source:'(?:falsify-red|red-plan|tampered|변조|정답)',flags:'gi'},
  ];

  function familyForAttackType(attackType){
    if(typeof attackType!=='string')return null;
    return Object.hasOwn(FAMILY_BY_ATTACK,attackType)?FAMILY_BY_ATTACK[attackType]:null;
  }

  function inferSurface(input){
    const opts=input&&typeof input==='object'?input:{};
    if(opts.kind==='table-cell')return 'table';
    if(opts.kind==='chart-point')return 'chart';
    const list=Array.isArray(opts.attackTypes)?opts.attackTypes:[];
    if(list.includes('citation-distortion'))return 'citation';
    if(list.includes('outcome-status-mislabeling'))return 'registry';
    return 'prose';
  }

  function explicitAttackTypes(item){
    if(Array.isArray(item.attackTypes)){
      const valid=item.attackTypes.filter(x=>ATTACK_TYPES.includes(x));
      if(valid.length)return valid;
    }
    if(Number.isInteger(item.level)){
      if(item.level>=1&&item.level<=3)return [ATTACK_TYPES[item.level-1]];
      if(item.level===4)return LEVEL4_DEFAULT_TYPES.slice();
    }
    return [];
  }

  function tokensMatchDifferent(a,b,re){
    const left=String(a||'').match(re)||[];
    const right=String(b||'').match(re)||[];
    return JSON.stringify(left)!==JSON.stringify(right);
  }

  function inferHeuristicAttackTypes(item){
    const before=String(item.before||''),after=String(item.after||''),rationale=String(item.rationale||'');
    const registryRe=/\b(?:pre-?specified|post-?hoc|primary\s+outcome|secondary\s+outcome|exploratory\s+endpoint|NCT\d{6,}|ISRCTN\d+)\b/i;
    if(registryRe.test(before)||registryRe.test(after)||registryRe.test(rationale)){
      return ['outcome-status-mislabeling'];
    }
    const citeRe=/\[\d+(?:\s*[-,]\s*\d+)*\]|10\.\d{4,9}\/\S+|doi:\s*\S+|https?:\/\/\S+|pmid:\s*\d+/gi;
    if(tokensMatchDifferent(before,after,citeRe))return ['citation-distortion'];
    const polarityRe=/\b(?:H3K\d+\w*|upregulat\w*|downregulat\w*|agonist|antagonist|hypermethylat\w*|hypomethylat\w*)\b/gi;
    if(tokensMatchDifferent(before,after,polarityRe))return ['semantic-inversion'];
    const numRe=/(?<![A-Za-z])-?\d+(?:\.\d+)?%?(?![A-Za-z])/g;
    if(item.kind==='table-cell'||item.kind==='chart-point'||tokensMatchDifferent(before,after,numRe)){
      return ['numeric-drift'];
    }
    return ['contradiction'];
  }

  function classifyDefect(item){
    const src=item&&typeof item==='object'?item:{};
    const explicit=explicitAttackTypes(src);
    const attackTypes=explicit.length?explicit:inferHeuristicAttackTypes(src);
    const defectFamily=familyForAttackType(attackTypes[0]);
    const oracleSource=defectFamily?FAMILIES[defectFamily].oracleSource:null;
    const surface=inferSurface({kind:src.kind,attackTypes,before:src.before,after:src.after});
    return {defectFamily,attackTypes:attackTypes.slice(),oracleSource,surface};
  }

  function snippetAround(text,index,length){
    const start=Math.max(0,index-20),end=Math.min(text.length,index+length+20);
    return text.slice(start,end).replace(/\s+/g,' ').trim();
  }

  function scanRules(text,rules,codeOverride){
    if(typeof text!=='string'||!text)return [];
    const found=[];
    for(const rule of rules){
      const re=new RegExp(rule.source,rule.flags);
      for(let m=re.exec(text);m;m=re.exec(text)){
        found.push({code:codeOverride||rule.code,pattern:rule.source,snippet:snippetAround(text,m.index,m[0].length)});
        if(!re.global)break;
      }
    }
    return found;
  }

  function issueKey(issue){return issue.code+'::'+issue.pattern;}

  function scanCandidateDiff(cand){
    if(!cand||typeof cand!=='object')return [];
    const afterHits=scanRules(String(cand.after||''),TEXT_LEAK_RULES);
    if(!afterHits.length||typeof cand.before!=='string')return afterHits;
    const beforeCounts=new Map();
    for(const hit of scanRules(cand.before,TEXT_LEAK_RULES)){
      const k=issueKey(hit);beforeCounts.set(k,(beforeCounts.get(k)||0)+1);
    }
    const fresh=[];
    for(const hit of afterHits){
      const k=issueKey(hit),rem=beforeCounts.get(k)||0;
      if(rem>0)beforeCounts.set(k,rem-1);
      else fresh.push(hit);
    }
    return fresh;
  }

  function metadataText(meta){
    if(typeof meta==='string')return meta;
    if(meta&&typeof meta==='object')return JSON.stringify(meta);
    return '';
  }

  function scanBlindnessLeaks(input){
    const issues=[];
    if(typeof input==='string'){
      issues.push(...scanRules(input,TEXT_LEAK_RULES));
    }else if(input&&typeof input==='object'){
      if(typeof input.text==='string')issues.push(...scanRules(input.text,TEXT_LEAK_RULES));
      if(Array.isArray(input.candidates))for(const c of input.candidates)issues.push(...scanCandidateDiff(c));
      const meta=metadataText(input.metadata);
      if(meta){
        issues.push(...scanRules(meta,TEXT_LEAK_RULES,'metadata_blindness_hint'));
        issues.push(...scanRules(meta,META_LEAK_RULES,'metadata_blindness_hint'));
      }
      if(typeof input.filename==='string'){
        issues.push(...scanRules(input.filename,META_LEAK_RULES,'filename_blindness_hint'));
      }
    }
    return {clean:issues.length===0,issues};
  }

  return {
    SCHEMA,
    ATTACK_TYPES,
    FAMILIES,
    SURFACES,
    LEVELS,
    familyForAttackType,
    inferSurface,
    classifyDefect,
    scanBlindnessLeaks,
  };
});
