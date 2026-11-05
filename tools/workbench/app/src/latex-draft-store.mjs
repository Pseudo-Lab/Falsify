import {createDraftTransactions} from './latex-draft-transactions.mjs';
import {LAYOUT_RUN_TTL_MS,createWriteIdentity,deleteIfSameWrite} from './paper-layout-run-store.mjs';

const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});

// The user's opt-in source draft includes the layout result. Large archives stay
// out of localStorage; that key contains only a timestamp/migration marker.
// Every write carries a unique writeId; rollback and expiry cleanup delete a row
// only when it is still that exact write (compare-and-delete in one transaction).
export function createLatexDraftStore({indexedDB=globalThis.indexedDB,now=Date.now}={}){
  let memory=null,epoch=0;const nextWriteId=createWriteIdentity();
  const fresh=row=>row?.consent===true&&Number.isFinite(row.savedAt)&&row.savedAt<=now()&&now()-row.savedAt<LAYOUT_RUN_TTL_MS;
  const db=createDraftTransactions({indexedDB});
  const transaction=db.transaction;
  return {
    async put(archive,{consent=false}={}){
      if(consent!==true)return {persisted:false};
      if(typeof archive!=='string')throw new TypeError('Source archive text required');
      const at=epoch,row={archive,consent:true,savedAt:now(),writeId:nextWriteId()};memory=row;
      try{
        // Re-check the epoch when the put is issued; a clear queued later is ordered after it.
        const issued=await transaction('readwrite',store=>{if(at!==epoch)return false;return request(store.put(row,'current')).then(()=>true);});
        // Withdrawn while in flight: remove only this exact write, never a newer re-consented draft.
        if(!issued||at!==epoch){if(issued)await transaction('readwrite',store=>deleteIfSameWrite(store,'current',row));return {persisted:false};}
        return {persisted:true,savedAt:row.savedAt};
      }
      catch(error){return {persisted:false,savedAt:row.savedAt,storageError:error.message};}
    },
    async get(){
      if(memory&&fresh(memory))return memory;
      memory=null;let row;try{row=await transaction('readonly',store=>request(store.get('current')));}catch{return null;}
      if(fresh(row))return row;
      // An expired row is removed only if no newer draft replaced it after this read.
      if(row)try{await transaction('readwrite',store=>deleteIfSameWrite(store,'current',row));}catch{}
      return null;
    },
    async clear(){memory=null;epoch++;try{await transaction('readwrite',store=>request(store.delete('current')));return {cleared:true};}catch(error){return {cleared:false,storageError:error.message};}},
    dispose(){memory=null;db.dispose();epoch++;}
  };
}
