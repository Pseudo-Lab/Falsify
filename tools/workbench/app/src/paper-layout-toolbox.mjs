import {inspectLayoutDocument,getLayoutBlock,compareLayoutDocuments} from './paper-layout-document-tools.mjs';
import {updateBlockLayout,inspectProjectFonts,setProjectTypography} from './paper-layout-edit-tools.mjs';
import {readLayoutTable,rebuildLayoutTable,getLayoutFigure,placeLayoutFigure,replaceLayoutFigure} from './paper-layout-asset-tools.mjs';
import {createLayoutTargetRegistry} from './paper-layout-targets.mjs';

export function createLayoutToolHandlers({referenceBytes,renderRegion,allowedReplacements=[],project:initialProject,targetMetadata}={}){
 let current=initialProject,registry=initialProject?createLayoutTargetRegistry(initialProject,targetMetadata):null;
 const sync=p=>{if(!registry){registry=createLayoutTargetRegistry(p);current=p;}else if(current.id!==p.id){registry.rebase(current,p);current=p;}return registry;};
 const argumentsFor=(p,args={})=>{const reg=sync(p),out={...args};const resolve=id=>{if(typeof id!=='string'||!id.startsWith('lt1_'))return id;const result=reg.resolve(p,id);if(result.status!=='matched')throw Object.assign(new Error(result.status==='ambiguous'?'대상 위치가 여러 곳입니다. 블록을 확인해 선택하세요.':'이 대상을 다시 확인하세요.'),{code:result.reason||'TARGET_MISSING',candidates:result.candidates});return result.blockId;};if(out.blockId)out.blockId=resolve(out.blockId);if(out.blockIds)out.blockIds=out.blockIds.map(resolve);return out;};
 const shared=()=>({...((referenceBytes instanceof Uint8Array)?{referenceBytes:referenceBytes.slice()}:{}),allowedReplacements:[...allowedReplacements]});
 const read=fn=>async input=>{const observation=await fn({...input,args:argumentsFor(input.project,input.args),...shared()});const reg=sync(input.project);if(fn===inspectLayoutDocument)observation.blocks.items=observation.blocks.items.map(b=>reg.describe(input.project,b));if(fn===getLayoutBlock)observation.block=reg.describe(input.project,observation.block);return {observation};};
 const edit=fn=>async input=>{const output=await fn({...input,args:argumentsFor(input.project,input.args),...shared()});if(output?.project)sync(output.project);return output;};
 return {
  inspect_document:read(inspectLayoutDocument),get_block:read(getLayoutBlock),compare_document:read(compareLayoutDocuments),
  update_layout:edit(updateBlockLayout),inspect_fonts:read(inspectProjectFonts),set_typography:edit(setProjectTypography),
  read_table:read(readLayoutTable),rebuild_table:edit(rebuildLayoutTable),
  get_figure:async input=>({observation:{...await getLayoutFigure({...input,...shared()}),replacementImages:[...allowedReplacements]}}),
  place_figure:edit(placeLayoutFigure),replace_figure:edit(replaceLayoutFigure),
  ...(typeof renderRegion==='function'?{render_region:renderRegion}:{})
  ,getTargetMetadata:p=>{if(p)sync(p);return registry?.serialize()||null;}
 };
}
