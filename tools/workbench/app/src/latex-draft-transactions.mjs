export function createDraftTransactions({indexedDB}) {
  let opening=null, disposed=false;
  const open=()=>{if(disposed)return Promise.reject(new Error('Draft store disposed'));return opening??=(new Promise((resolve,reject)=>{
    if(!indexedDB){reject(new Error('기기 저장을 사용할 수 없습니다.'));return;}
    const req=indexedDB.open('falsify-latex-drafts',1);
    req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('drafts'))req.result.createObjectStore('drafts');};
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||new Error('기기 저장을 열지 못했습니다.'));
  })).catch(error=>{opening=null;throw error;});};
  // operation(store) issues its requests synchronously and returns a promise for the
  // transaction's value, or a plain value when no request was issued.
  async function transaction(mode,operation){const db=await open();if(disposed)throw new Error('Draft store disposed');return new Promise((resolve,reject)=>{const tx=db.transaction('drafts',mode);let value;tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(tx.error||new Error('기기 저장을 마치지 못했습니다.'));let out;try{out=operation(tx.objectStore('drafts'));}catch(error){try{tx.abort();}catch{}reject(error);return;}if(out&&typeof out.then==='function')out.then(v=>{value=v;},error=>{try{tx.abort();}catch{}reject(error);});else value=out;});}
  return {transaction,dispose(){disposed=true;opening?.then(db=>db.close(),()=>{});opening=null;}};
}
