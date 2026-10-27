import {createBrowserFontStore} from './browser-fonts.mjs';
import {getBundledFonts} from './bundled-fonts.mjs';

// Font bytes stay in this browser. Only immutable snapshots enter PDF workers.
export function createPaperFontService({store=createBrowserFontStore(), bundled=getBundledFonts}={}) {
  return Object.freeze({
    get revision(){return store.revision;},
    list:()=>store.list(),
    requestLocalFonts:()=>store.requestLocalFonts(),
    addFiles:files=>store.addFiles(files),
    async resolve(requirements){
      const fallbackFonts=await bundled(requirements);
      const text=requirements.map(r=>r.text||'').join('\n');
      const added=store.list().filter(f=>f.source==='file').map(f=>({family:f.family,bold:f.weight>=600,italic:f.italic,text}));
      return store.resolve([...requirements,...added],{fallbackFonts});
    },
    clear:()=>store.clear(),
  });
}
if(typeof window!=='undefined') window.FalsifyFonts=createPaperFontService();
