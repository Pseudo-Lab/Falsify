const string={type:'string'},number={type:'number'},integer={type:'integer'},boolean={type:'boolean'};
const strings={type:'array',items:string,maxItems:5000};
const pages={type:'array',items:{type:'integer',minimum:0,maximum:499},maxItems:4,uniqueItems:true};
const bbox={type:'array',items:number,minItems:4,maxItems:4};
const choice=(...values)=>({type:'string',enum:values});
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const plan=object({schema:{const:'falsify.paper-layout-plan.v1',type:'string'},sourcePdfHash:string,frontMatter:strings,order:strings,furniture:{type:'array',items:object({id:string,placement:choice('header','footer')},['id','placement'])},columns:{type:'integer',enum:[1,2]}},['schema','sourcePdfHash','frontMatter','order','furniture','columns']);
const paging={offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:50}};
const items=[
 ['read_source','Read a LaTeX file. Choose path and chunk, or locate before. Returns source text and chunk count.',object({path:string,chunk:integer,before:string},['path'])],
 ['replace_source','Change an existing literal layout setting using one unique before/after source span. Keep document content and asset paths.',object({path:string,before:string,after:string},['path','before','after'])],
 ['compile_pdf','Generate the current PDF. Returns its hash and compiler findings.',object()],
 ['inspect_pdf','Check the current PDF for overlaps, clipping, column and caption findings.',object()],
 ['render_pages','View up to four candidate pages. Page indices start at zero.',object({pages})],
 ['read_reference','Read original PDF text and source regions. Continue each page with its returned next arguments until next is null.',object({pages,offset:{type:'integer',minimum:0},textOffset:{type:'integer',minimum:0},unitOffset:{type:'integer',minimum:0}})],
 ['render_reference_pages','View up to four original pages. Request matching candidate pages with render_pages.',object({pages})],
 ['restructure_source','Set full-width front matter, body order, columns and header/footer units. Include every current unit once.',object({plan},['plan'])],
 ['finish','Return the chosen candidate and a brief account of changes and remaining findings.',object()],
 ['inspect_document','List and search document blocks, fonts and figures. Continue with offset. Geometry identifies original and current positions.',object({query:string,pageIndex:integer,kind:string,...paging})],
 ['get_block','Read one block, its source, positions and associated assets. Continue source text with offset, geometry hits with geometryOffset, and asset paths with assetOffset.',object({blockId:string,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:4096},geometryOffset:{type:'integer',minimum:0},assetOffset:{type:'integer',minimum:0}},['blockId'])],
 ['render_region','View an enlarged original or candidate rectangle. bbox is [left,top,right,bottom] in display points from the top left; use the geometry coordinateFrame.',object({document:choice('original','candidate'),pageIndex:integer,bbox,scale:number,coordinateFrame:choice('pdfjs-display','mupdf-display')},['document','pageIndex','bbox'])],
 ['update_layout','Adjust one block by ID. Set spacing, type size, width, placement or neighboring block. Text stays unchanged.',object({blockId:string,fontSizeBp:number,leadingBp:number,gapBeforeBp:number,gapAfterBp:number,indentBp:number,widthBp:number,columnSpan:{type:'integer',enum:[1,2]},pageBreakBefore:boolean,keepWithNext:boolean,placement:choice('flow','header','footer'),align:choice('left','center','right','justify'),orderBefore:string,orderAfter:string},['blockId'])],
 ['compare_document','Compare candidate content and assets with the captured pre-layout PDF, including the selected RED changes.',object(paging)],
 ['checkpoint','Save the current source as a named revision. A matching generated PDF is saved when available.',object({label:string})],
 ['restore_revision','Return to a saved revision. Use revision IDs listed in execution.checkpoints.',object({revisionId:string},['revisionId'])],
 ['inspect_fonts','List project font files and inspect character coverage for text.',object({text:string,...paging})],
 ['set_typography','Set document type size, leading and a font available in this project.',object({fontPath:string,family:string,bodySizeBp:number,leadingBp:number})],
 ['read_table','Read source tables and cell previews. Select a table ID and continue its rows with rowOffset.',object({blockId:string,tableId:string,pageIndex:integer,...paging,rowOffset:{type:'integer',minimum:0},rowLimit:{type:'integer',minimum:1,maximum:50}})],
 ['rebuild_table','Typeset an observed table with the same cells, labels and precision. Set column widths or span; rows can describe content already present in current blocks.',object({blockId:string,blockIds:strings,tableId:string,columnWidthsBp:{type:'array',items:number,maxItems:100},columnSpan:{type:'integer',enum:[1,2]},repeatHeader:boolean,rows:{type:'array',maxItems:1000,items:{type:'array',maxItems:100,items:{anyOf:[string,object({text:string},['text'])]}}}})],
 ['get_figure','List figures, panels, captions and project images, or read one selected figure.',object({blockId:string,assetPath:string,...paging})],
 ['place_figure','Size and place a figure with its caption. Preserve aspect ratio and image content.',object({blockId:string,widthBp:number,heightBp:number,columnSpan:{type:'integer',enum:[1,2]},placement:choice('top','bottom','here','page'),keepCaption:boolean},['blockId'])],
 ['replace_figure','Replace one figure occurrence with a replacement image supplied by the user. Choose an allowed replacement path.',object({blockId:string,assetPath:string},['blockId','assetPath'])]
];
export const layoutToolCatalog=Object.freeze(items.map(([name,description,parameters])=>({name,description,parameters})));
export const layoutToolNames=Object.freeze(items.map(x=>x[0]));
export const layoutActionSchema={type:'object',properties:{tool:{type:'string',enum:layoutToolNames},args:{anyOf:items.map(x=>x[2])},message:string},required:['tool','args','message'],additionalProperties:false};
// Provider structured output requires every object key; optional inputs use null.
// The application removes nulls before validating the selected tool contract.
function providerSchema(s){
 const next=structuredClone(s);delete next.uniqueItems;
 if(s.type==='object'){const required=new Set(s.required||[]);next.required=Object.keys(s.properties||{});next.properties=Object.fromEntries(Object.entries(s.properties||{}).map(([k,v])=>[k,required.has(k)?providerSchema(v):{anyOf:[providerSchema(v),{type:'null'}]}]));}
 if(s.items)next.items=providerSchema(s.items);if(s.anyOf)next.anyOf=s.anyOf.map(providerSchema);return next;
}
export const layoutProviderActionSchema=providerSchema(layoutActionSchema);
function matchesObject(value,s){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 return (s.required||[]).every(k=>Object.hasOwn(value,k))&&Object.entries(value).every(([k,v])=>s.properties?.[k]&&matches(v,s.properties[k]));
}
function matchesArray(value,s){
 return Array.isArray(value)&&value.length>=(s.minItems||0)&&value.length<=(s.maxItems??5000)&&(!s.uniqueItems||new Set(value).size===value.length)&&value.every(x=>matches(x,s.items));
}
function matchesNumber(value,s){
 return typeof value==='number'&&Number.isFinite(value)&&(s.type!=='integer'||Number.isSafeInteger(value))&&value>=(s.minimum??-Infinity)&&value<=(s.maximum??Infinity);
}
function matches(value,s){
 if(s.anyOf)return s.anyOf.some(x=>matches(value,x));
 if(s.const!==undefined&&value!==s.const)return false;
 if(s.enum&&!s.enum.includes(value))return false;
 if(s.type==='object')return matchesObject(value,s);
 if(s.type==='array')return matchesArray(value,s);
 if(s.type==='string')return typeof value==='string'&&!value.includes('\0')&&value.length<=20000;
 if(s.type==='boolean')return typeof value==='boolean';
 return matchesNumber(value,s);
}
function legacyReadSource(value){
 return {path:value.path,...(value.before?{before:value.before}:{chunk:value.pages[0]||0})};
}
function legacyArguments(value){
 if(!['path','before','after'].every(k=>typeof value[k]==='string'&&value[k].length<=20000)||!matches(value.pages,pages))return null;
 switch(value.tool){
  case 'read_source':return legacyReadSource(value);
  case 'replace_source':return {path:value.path,before:value.before,after:value.after};
  case 'render_pages':case 'render_reference_pages':return {pages:value.pages};
  case 'read_reference':return {pages:value.pages,offset:/^\d+$/.test(value.before)?Number(value.before):0};
  case 'restructure_source':try{return {plan:JSON.parse(value.after)};}catch{return null;}
  case 'compile_pdf':case 'inspect_pdf':case 'finish':return {};
  default:return null;
 }
}
export function normalizeLayoutAction(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!layoutToolNames.includes(value.tool)||typeof value.message!=='string'||value.message.length>4000)return null;
 let args=value.args;
 if(!Object.hasOwn(value,'args')){
  args=legacyArguments(value);
  if(args===null)return null;
 }else if(Object.keys(value).some(k=>!['tool','args','message'].includes(k)))return null;
 const definition=layoutToolCatalog.find(t=>t.name===value.tool);if(!matches(args,definition.parameters))return null;
 return legacyAction(value,args);
}

function legacyAction(value,args){
 const legacy={path:args.path||'',before:args.before||'',after:args.after||'',pages:args.pages||[],message:value.message,tool:value.tool,args:structuredClone(args)};
 if(value.tool==='read_source'&&args.chunk!==undefined)legacy.pages=[args.chunk];
 if(value.tool==='read_reference')legacy.before=String(args.offset||0);
 if(value.tool==='restructure_source')legacy.after=JSON.stringify(args.plan);
 return legacy;
}
