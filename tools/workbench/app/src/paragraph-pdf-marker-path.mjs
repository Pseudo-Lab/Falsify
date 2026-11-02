import {replaceMarkerGlyph} from './paragraph-pdf-marker-surgery.mjs';
const near=(a,b)=>Number.isFinite(a)&&Math.abs(a-b)<0.025;
function glyphs(doc,index,mupdf) {
 const page=doc.loadPage(index), out=[];
 try { const m=mupdf.Matrix.invert(page.getTransform()), s=page.toStructuredText('preserve-whitespace');
  try { s.walk({onChar(c,o,f,size,quad){out.push({c,fontName:f.getName(),size,pdf:[o[0]*m[0]+o[1]*m[2]+m[4],o[0]*m[1]+o[1]*m[3]+m[5]],quad:[...quad]});}}); } finally {s.destroy();} return out;
 } finally {page.destroy();}
}
function normalize(gs) {let text='',map=[]; for(let i=0;i<gs.length;i++){let c=gs[i].c;if(/\s/u.test(c)){if(text.endsWith(' ')){map[map.length-1][1]=i;continue;}c=' ';} for(const unit of c.split('')){text+=unit;map.push([i,i]);}}return {text,map};}
function abort(signal){if(signal?.aborted)throw new DOMException('PDF editing cancelled.','AbortError');}
export async function trySourceMarkerEdits({bytes,edits,fontSnapshot,signal},{mupdf,scanTextShows}) {
 abort(signal); if(!(bytes instanceof Uint8Array)||!Array.isArray(edits)||!edits.length||!mupdf||!fontSnapshot?.fonts)return null;
 let original;
 try {original=new mupdf.PDFDocument(bytes);if(original.needsPassword())return null;const count=original.countPages(),cache=new Map(),plans=[];
  for(const edit of edits){abort(signal);if(!Number.isInteger(edit.pageIndex)||edit.pageIndex<0||edit.pageIndex>=count||typeof edit.before!=='string'||typeof edit.after!=='string'||!edit.before.trim())return null;
   const before=[...edit.before],after=[...edit.after];if(before.length!==after.length)return null;const diff=before.map((c,i)=>c!==after[i]?i:-1).filter(i=>i>=0);if(diff.length!==1||before[diff[0]].length!==1||after[diff[0]].length!==1)return null;
   const all=cache.get(edit.pageIndex)||glyphs(original,edit.pageIndex,mupdf);cache.set(edit.pageIndex,all);const {text,map}=normalize(all),needle=edit.before.replace(/\s+/g,' '),first=text.indexOf(needle);if(first<0||text.indexOf(needle,first+1)>=0)return null;
   const a=map[first][0],b=map[first+needle.length-1][1];if(plans.some(p=>p.pageIndex===edit.pageIndex&&a<=p.b&&b>=p.a))return null;
   const offset=first+before.slice(0,diff[0]).join('').replace(/\s+/g,' ').length, target=map[offset];if(!target||target[0]!==target[1]||all[target[0]].c!==before[diff[0]])return null;
   plans.push({edit,pageIndex:edit.pageIndex,a,b,target:target[0],replacement:after[diff[0]]});
  }
  let working=bytes.slice();const reports=[];
  for(const plan of plans){abort(signal);const current=new mupdf.PDFDocument(working);let all;try{all=glyphs(current,plan.pageIndex,mupdf);}finally{current.destroy();}const target=all[plan.target];if(!target)return null;let start=plan.target,end=plan.target;
   const same=g=>g&&g.fontName===target.fontName&&near(g.size,target.size)&&near(g.pdf[1],target.pdf[1]);while(start>0&&same(all[start-1]))start--;while(end+1<all.length&&same(all[end+1]))end++;if(end!==plan.target)return null;
   const run=all.slice(start,end+1),face=fontSnapshot.fonts.find(f=>f.postscriptName==='LMRoman7-Regular');if(!face||!/^(?:[A-Z]{6}\+)?(?:CMR7|LMRoman7(?:-Regular)?)$/i.test(target.fontName))return null;
   const result=await replaceMarkerGlyph({bytes:working,pageIndex:plan.pageIndex,glyphs:run,after:run.slice(0,-1).map(g=>g.c).join('')+plan.replacement,fontSnapshot,fontPostscriptName:face.postscriptName,scanTextShows,mupdf});abort(signal);if(!result)return null;working=result.bytes;reports.push({...result.report,id:plan.edit.id});
  }return {bytes:working,pageCount:count,reports};
 }catch(error){abort(signal);return null;}finally{original?.destroy();}
}
