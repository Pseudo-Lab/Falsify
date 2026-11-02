import {getBundledFonts} from './bundled-fonts.mjs';

/** Load the four publication faces only when creating a flow project. */
export async function loadReconstructionFonts({fetch=globalThis.fetch,signal}={}) {
  const fonts=await getBundledFonts([
    {family:'Liberation Serif'}, {family:'Liberation Serif',bold:true},
    {family:'Liberation Serif',italic:true}, {family:'Liberation Serif',bold:true,italic:true},
    {family:'Liberation Serif',text:'∗∼'}
  ],{fetch:(url,options)=>fetch(url,{...options,signal})});
  return fonts.map(f=>({path:`${f.postscriptName}.${f.family==='STIX Two Math'?'otf':'ttf'}`,bytes:f.bytes.slice(),role:f.family==='STIX Two Math'?'math':'serif',style:f.weight>=700?(f.italic?'bolditalic':'bold'):(f.italic?'italic':'regular')}));
}
