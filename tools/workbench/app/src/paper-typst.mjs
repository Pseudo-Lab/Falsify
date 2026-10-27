// Thin adapter for the pinned Typst.ts 0.7.0 implementation.
export function createTypstCompile({createTypstCompiler, createTypstFontBuilder, loadFonts, getModule, getWrapper}) {
  return async ({source, files={}, fonts={}, signal}) => {
    const abort=()=>{if(signal?.aborted) throw new DOMException('Composition cancelled','AbortError');};
    const options={getModule,getWrapper}, compiler=createTypstCompiler(), builder=createTypstFontBuilder();
    let resolver, world;
    try {
      abort(); await compiler.init({...options,beforeBuild:[loadFonts([], {assets:false})]}); abort();
      await builder.init(options); abort();
      for(const candidate of fonts.candidates || []) {const bytes=candidate.getBytes?.(); if(bytes) await builder.addFontData(bytes);}
      // Use the pinned underlying objects: the public 0.7.0 build/compile helpers
      // do not free their resolver/world if a callback fails.
      // The 0.7.0 WASM wrapper consumes the builder before invoking build, even on rejection.
      const rawBuilder=builder.fontBuilder; builder.fontBuilder=null; resolver=await rawBuilder.build(); abort(); compiler.setFonts(resolver);
      compiler.addSource('/main.typ',source);
      for(const [path, bytes] of Object.entries(files)) compiler.mapShadow('/'+path, bytes);
      world=compiler.compiler.snapshot(undefined,'/main.typ',undefined);
      const result=world.get_artifact(1,3); abort();
      const bytes=result instanceof Uint8Array ? result : result?.result;
      if(!(bytes instanceof Uint8Array)) throw new Error('Typst PDF compilation failed: '+JSON.stringify(result));
      let blockMap=null, blockEnds=null, blockSpans=null, furnitureMap=null, queryError=null;
      try {blockMap=JSON.parse(world.query(0,'<paper-block>','value'));} catch(error) {queryError=String(error?.message || error);}
      try {blockEnds=JSON.parse(world.query(0,'<paper-block-end>','value'));} catch(error) {queryError ||= String(error?.message || error);}
      if (Array.isArray(blockMap) && Array.isArray(blockEnds)) blockSpans=blockMap.map(start=>{const end=blockEnds.find(x=>x.id===start.id); return {id:start.id,sourcePage:start.sourcePage,start,end:end || null};});
      try {furnitureMap=JSON.parse(world.query(0,'<paper-furniture>','value'));} catch(error) {queryError ||= String(error?.message || error);}
      return {bytes,blockMap,blockSpans,furnitureMap,queryError};
    } finally {
      world?.free();
      try {compiler.resetShadow?.();} finally {
        compiler.compiler?.free(); resolver?.free(); builder.fontBuilder?.free();
      }
    }
  };
}
