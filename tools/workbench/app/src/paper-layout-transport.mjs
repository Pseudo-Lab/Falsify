const FAILURE_MESSAGES={invalid_action:'AI의 도구 호출 형식이 맞지 않습니다.',model_timeout:'AI 응답 시간이 초과됐습니다.',model_failed:'AI 응답을 받지 못했습니다.',model_tool_violation:'AI가 앱 밖의 도구 실행을 요청했습니다.',cli_login_required:'Codex 로그인이 필요합니다.',request_limit:'요청이 처리 가능한 크기를 넘었습니다.',invalid_request:'레이아웃 요청 형식을 확인하세요.',companion_busy:'PC에서 다른 작업을 처리하고 있습니다.',job_start_failed:'PC에서 AI 작업을 시작하지 못했습니다.',skill_unavailable:'설치된 배치 지침을 읽지 못했습니다.',fingerprint_mismatch:'요청 내용과 식별 정보가 다릅니다.',layout_step_conflict:'동일 단계에 다른 요청이 접수돼 있습니다.',layout_step_not_found:'이 PC에 해당 요청 기록이 없습니다.'};
export function layoutFailureDetails(error){
 const code=Object.hasOwn(FAILURE_MESSAGES,error?.code)?error.code:Object.hasOwn(FAILURE_MESSAGES,error?.message)?error.message:'request_failed',out={code,reason:FAILURE_MESSAGES[code]||'레이아웃 작업을 마치지 못했습니다.'},r=error?.stepReceipt;
 if(r){const request={};for(const k of ['runId','stepId','projectId','fingerprint','companionInstance'])if(typeof r[k]==='string'&&/^[A-Za-z0-9._:-]{1,160}$/.test(r[k]))request[k]=r[k];if(Number.isSafeInteger(r.step)&&r.step>=0)request.step=r.step;if(Object.keys(request).length)out.request=request;}
 if(Number.isSafeInteger(error?.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599)out.httpStatus=error.httpStatus;
 return out;
}
const ROOT='/api/paper/layout-agent/jobs';
const aborted=()=>new DOMException('취소했습니다.','AbortError');
const pause=(ms,signal)=>new Promise((resolve,reject)=>{if(signal?.aborted){reject(aborted());return;}const cancel=()=>{clearTimeout(timer);reject(aborted());};const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},ms);signal?.addEventListener('abort',cancel,{once:true});});

function validateReceipt(r,owner,id,saved){
    if(r?.schema!=='falsify.layout-step-receipt.v1'||r.runId!==owner||r.stepId!==id||!['running','completed','failed','cancelled'].includes(r.state)||!/^[0-9a-f]{64}$/.test(r.fingerprint||''))throw Object.assign(new Error('레이아웃 접수 정보가 요청과 다릅니다.'),{recovery:'mismatch'});
    if(saved.fingerprint&&saved.fingerprint!==r.fingerprint)throw Object.assign(new Error('저장한 요청과 조회 결과가 다릅니다.'),{recovery:'mismatch'});
    if(saved.companionInstance&&r.companionInstance&&saved.companionInstance!==r.companionInstance)throw Object.assign(new Error('companion이 변경되었습니다. 보류 중인 요청을 버리거나 원본에서 다시 시작하세요.'),{recovery:'mismatch'});
    return r;
}
function prepareStep({recovering,id,owner,request,pendingStep,companionInstance}){
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(owner))throw new Error('레이아웃 요청 ID를 확인하세요.');
  const original=recovering?pendingStep.request:request;
  if(!original||original.projectId!==request.projectId)throw Object.assign(new Error('저장한 요청의 소스가 다릅니다. 보류 중인 요청을 버리거나 원본에서 다시 시작하세요.'),recovering?{recovery:'mismatch'}:{});
  const saved={runId:owner,stepId:id,projectId:original.projectId,step:original.step,request:original,state:'unknown',...(companionInstance?{companionInstance}:{}),...(recovering?pendingStep:{})};
  if(recovering&&saved.companionInstance&&companionInstance&&saved.companionInstance!==companionInstance)throw Object.assign(new Error('이전 companion의 요청입니다. 보류 중인 요청을 버리거나 원본에서 다시 시작하세요.'),{recovery:'mismatch'});
 return {original,saved};
}
function completedResponse(receipt,original,saved){
  if(receipt.state!=='completed')throw Object.assign(new Error(receipt.error?.message||'요청을 마치지 못했습니다. 다시 실행할 수 있습니다.'),{code:Object.hasOwn(FAILURE_MESSAGES,receipt.error?.error)?receipt.error.error:'request_failed',disposition:receipt.state,stepReceipt:saved});
  const response=receipt.result;
  if(response?.schema!=='falsify.paper-layout-agent-action.v1'||response.projectId!==original.projectId||response.step!==original.step||!response.action)throw new Error('레이아웃 응답의 소스·단계가 다릅니다.');
 return response;
}
function transportErrorCode(error){return error&&typeof error==='object'?(Object.hasOwn(FAILURE_MESSAGES,error.code)?error.code:Object.hasOwn(FAILURE_MESSAGES,error.message)?error.message:null):null;}
function notAdmitted(recovering,receipt,code,error){return !recovering&&receipt===undefined&&code==='companion_busy'&&error.httpStatus===409;}
function markRecovery(error,recovering){if(recovering&&error&&typeof error==='object'&&!error.recovery)error.recovery=error.httpStatus===404?'not-found':'unreachable';}
/** Receipt lookup never submits a model request. Unknown delivery remains recoverable. */
export async function layoutStepDecision(link,request,{runId,signal,pendingStep,onPending=()=>{},pollMs=350,companionInstance}={}){
  const recovering=!!pendingStep;
  const id=recovering?pendingStep.stepId:runId+'-s'+request.step;
  const owner=recovering?pendingStep.runId:runId;
  const {original,saved:initialSaved}=prepareStep({recovering,id,owner,request,pendingStep,companionInstance});
  let saved=initialSaved;
  await onPending(saved);
  let receipt;

  try{
    receipt=validateReceipt(await link.request(recovering?ROOT+'/'+id:ROOT,recovering?null:{runId:owner,stepId:id,request:original},{signal}),owner,id,saved);
    while(true){
      saved={...saved,state:receipt.state,fingerprint:receipt.fingerprint,...(receipt.companionInstance?{companionInstance:receipt.companionInstance}:{})};await onPending(saved);
      if(receipt.state!=='running')break;
      await pause(pollMs,signal);receipt=validateReceipt(await link.request(ROOT+'/'+id,null,{signal}),owner,id,saved);
    }
  }catch(error){
    if(signal?.aborted)throw aborted();
    const code=transportErrorCode(error);
    if(notAdmitted(recovering,receipt,code,error)){
      await onPending(null);
      throw Object.assign(new Error('PC에서 다른 작업을 처리하고 있어 이 단계는 접수되지 않았습니다. 끝난 뒤 다시 실행하세요.'),{code:'companion_busy',disposition:'not-admitted',httpStatus:409,stepReceipt:saved});
    }
    markRecovery(error,recovering);
    throw error;
  }
  if(signal?.aborted)throw aborted();
  const response=completedResponse(receipt,original,saved);
  return {response,pendingStep:saved};
}
