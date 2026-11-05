import {parseMinimal} from '@unified-latex/unified-latex-util-parse';
import {hex} from './paragraph-pdf-crypto.mjs';
const dec=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),enc=new TextEncoder();
const pos=n=>n?.position?.start?.offset, end=n=>n?.position?.end?.offset;
export function analyzeLatexSource(project) {
 const nodes=[],diagnostics=[],documents=[];
 for(const file of project.files.filter(f=>/\.tex$/i.test(f.path))) { let source,ast; try{source=dec.decode(file.bytes);ast=parseMinimal(source)}catch{diagnostics.push({code:'PARSE_ERROR',message:'Could not parse UTF-8 LaTeX source',path:file.path});continue}
 const add=(kind,start,finish,cs,ce)=>{if(!Number.isInteger(start)||!Number.isInteger(finish)||cs<start||ce>finish||cs>ce)return;const sourceText=source.slice(start,finish),text=source.slice(cs,ce);const id=hex(enc.encode(JSON.stringify([project.id,file.path,kind,start,finish])));nodes.push({id,path:file.path,kind,start,end:finish,contentStart:cs,contentEnd:ce,text,sourceText,displayText:kind==='citation'?'':text,displayStatus:kind==='citation'?'unresolved':'source',displayMap:kind==='citation'?[]:Array.from({length:text.length},(_,i)=>({start:cs+i,end:cs+i+1}))});};
 function macroArgumentIndex(list,i){
 let j=i+1;while(list[j]?.type==='whitespace')j++;
 if(list[j]?.type==='string'&&list[j].content==='*')j++;
 while(list[j]?.type==='whitespace')j++;
 if(list[j]?.type==='string'&&list[j].content==='['){let depth=0;do{if(list[j]?.type==='string'&&list[j].content==='[')depth++;if(list[j]?.type==='string'&&list[j].content===']')depth--;j++;}while(j<list.length&&depth>0);while(list[j]?.type==='whitespace')j++;}
 return j;
 }
 function consumeLayoutArguments(list,i,j,arity){
   let count=0;while(count<arity&&list[j]?.type==='group'){count++;i=j;j++;while(list[j]?.type==='whitespace')j++;}
   if(arity===0)i=Math.max(i,j-1);
   return i;
 }
 function isImmediateMathArgument(kind,inMath,next,e){return kind&&inMath&&next&&pos(next)===e&&next.type==='string';}
 function walkMacro(list,i,n,s,e,inMath){ const map={textsuperscript:'superscript',textsubscript:'subscript',footnote:'footnote',cite:'citation',citep:'citation',citet:'citation','^':'superscript','_':'subscript'}; const kind=map[n.content];const next=list[i+1]; if(kind&&next?.type==='group'&&pos(next)===e){add(kind,s,end(next),pos(next)+1,end(next)-1);return i+1} if(isImmediateMathArgument(kind,inMath,next,e)){add(kind,s,end(next),pos(next),end(next));return i+1}
 // Arguments of unknown and control macros are not evidence of rendered text.
 // Known text wrappers retain their nested source text without expanding macros.
 const textMacros=new Set(['section','subsection','subsubsection','paragraph','subparagraph','chapter','part','textbf','textit','emph','texttt','textrm','textsf','textsc','mbox','caption','title','author']);
 let j=macroArgumentIndex(list,i);
 // Declarations and layout commands have a fixed argument count. A following
 // paragraph group is rendered content, not another argument of that command.
 const layoutArity={selectfont:0,bfseries:0,itshape:0,normalfont:0,rmfamily:0,sffamily:0,ttfamily:0,centering:0,noindent:0,par:0,relax:0,nopagebreak:0,pagebreak:0,newpage:0,clearpage:0,Needspace:1,needspace:1,fontsize:2,setlength:2,addtolength:2,hspace:1,vspace:1};
 if(Object.hasOwn(layoutArity,n.content))return consumeLayoutArguments(list,i,j,layoutArity[n.content]);
 if(kind&&list[j]?.type==='group'){add(kind,s,end(list[j]),pos(list[j])+1,end(list[j])-1);return j}
 if(list[j]?.type==='group'){if(textMacros.has(n.content)){walk(list[j].content,inMath);i=j;}else{do{i=j;j++;while(list[j]?.type==='whitespace')j++;}while(list[j]?.type==='group');}return i}
 return null;
 }
 function walkEnvironment(n,inMath){
   let content=n.content;
   // These environments may consume a leading optional argument; parseMinimal
   // leaves it in the body, including whitespace before the opening bracket.
   if(['figure','figure*','table','table*','itemize','enumerate','description'].includes(n.env)){
     let j=0; while(content?.[j]?.type==='whitespace')j++;
     if(content?.[j]?.type==='string'&&content[j].content==='['){
       let depth=0, k=j;
       for(;k<content.length;k++) {if(content[k].type==='string'&&content[k].content==='[')depth++;if(content[k].type==='string'&&content[k].content===']'&&!--depth){k++;break;}}
       if(depth===0)content=content.slice(k);
     }
   }
   walk(content,inMath);
 }
 function isTextRun(n,s,inMath){return !inMath&&(n.type==='string'||n.type==='whitespace')&&s!==undefined;}
 function walk(list,inMath=false) { if(!Array.isArray(list))return; let runStart=null,runEnd=null; const flush=()=>{if(runStart!==null&&source.slice(runStart,runEnd).trim())add('text',runStart,runEnd,runStart,runEnd);runStart=runEnd=null};
 for(let i=0;i<list.length;i++){const n=list[i],s=pos(n),e=end(n); if(isTextRun(n,s,inMath)){if(runEnd!==null&&runEnd!==s)flush();runStart??=s;runEnd=e;continue} flush();
 if(n.type==='inlinemath'||n.type==='displaymath'){const len=n.type==='displaymath'?2:1;add('math',s,e,s+len,e-len);walk(n.content,true);continue}
 if(n.type==='macro') {const nextIndex=walkMacro(list,i,n,s,e,inMath);if(nextIndex!==null){i=nextIndex;continue}}
 if(n.type==='group')walk(n.content,inMath); else if(n.type==='environment')walkEnvironment(n,inMath);
 }flush(); }
 const document=ast.content.find(n=>n.type==='environment'&&n.env==='document');
 if(document)walk(document.content);else walk(ast.content);
 const ordered=nodes.filter(n=>n.path===file.path).sort((a,b)=>a.start-b.start||b.end-a.end);let last=-1,displayText='',displayMap=[];for(const n of ordered){if(n.start<last)continue;displayText+=n.displayText;displayMap.push(...n.displayMap.map(m=>({...m,nodeId:n.id,kind:n.kind})));last=n.end;}documents.push({path:file.path,displayText,displayMap});
 }
 return {projectId:project.id,nodes,documents,diagnostics};
}
export function locateSourceText(project,{before,path,nodeId}={}) { if(typeof before!=='string'||!before.trim())return {status:'missing',candidates:[]};const {nodes}=analyzeLatexSource(project);const needle=before.trim().replace(/\s+/g,' '),candidates=[];
 function locateInNode(n){if(path&&n.path!==path||nodeId&&n.id!==nodeId)return; const text=n.text;const re=/\S+|\s+/g;let normalized='',map=[];for(const m of text.matchAll(re)){const piece=/^\s+$/.test(m[0])?' ':m[0];for(let i=0;i<piece.length;i++)map.push([m.index+(piece===' '?0:i),m.index+(piece===' '?m[0].length:i+1)]);normalized+=piece;}let index=-1;while((index=normalized.indexOf(needle,index+1))!==-1){const start=n.contentStart+map[index][0],finish=n.contentStart+map[index+needle.length-1][1];candidates.push({anchor:{projectId:project.id,nodeId:n.id,path:n.path,start,end:finish,kind:n.kind},before:text.slice(start-n.contentStart,finish-n.contentStart),displayText:n.displayText});}}
 for(const n of nodes)locateInNode(n);
 return {status:candidates.length===1?'matched':candidates.length?'ambiguous':'missing',candidates}; }
