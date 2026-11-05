import {parse} from '@babel/parser';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const functions=new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','ObjectMethod','ClassMethod','ClassPrivateMethod']);
export function javascriptFunctions(source) {
  const tree=parse(source,{sourceType:'unambiguous',plugins:['jsx','typescript'],allowReturnOutsideFunction:true});
  const result=[];
  function scope(node,prefix) {
    const counts=new Map();
    function walk(n,parent) {
      if(!n || typeof n!=='object') return;
      if(functions.has(n.type)) {
        const name=n.id?.name ?? n.key?.name ?? n.key?.value ?? (parent?.type==='VariableDeclarator' ? parent.id?.name : undefined) ?? '<anonymous>';
        const num=(counts.get(name)||0)+1; counts.set(name,num);
        const id=`${prefix}/${name}#${num}`;
        let ccn=1;
        function decisions(x) {
          if(!x || typeof x!=='object') return;
          if(x!==n && (functions.has(x.type) || x.type==='ClassDeclaration' || x.type==='ClassExpression')) return;
          if(['IfStatement','ForStatement','ForInStatement','ForOfStatement','WhileStatement','DoWhileStatement','CatchClause','ConditionalExpression'].includes(x.type)) ccn++;
          if(x.type==='SwitchCase' && x.test) ccn++;
          if(x.type==='LogicalExpression' && ['&&','||','??'].includes(x.operator)) ccn++;
          for(const value of Object.values(x)) if(Array.isArray(value)) value.forEach(decisions); else if(value && typeof value==='object') decisions(value);
        }
        decisions(n);
        result.push({id,ccn,source:source.slice(n.start,n.end)});
        scope({params:n.params,body:n.body},id);
        return;
      }
      if(n.type==='ClassDeclaration' || n.type==='ClassExpression') {scope(n.body,`${prefix}/${n.id?.name ?? '<class>'}`); return;}
      for(const value of Object.values(n)) if(Array.isArray(value)) value.forEach(child=>walk(child,n)); else if(value && typeof value==='object') walk(value,n);
    }
    walk(node);
  }
  scope(tree,'');
  return result;
}
export function pythonFunctions(source,python=process.env.PYTHON || 'python') {
  const run=spawnSync(python,[fileURLToPath(new URL('./python-functions.py',import.meta.url))],{input:source,encoding:'utf8'});
  if(run.error || run.status!==0) throw Error(`Python AST failed: ${run.error || run.stderr}`);
  return JSON.parse(run.stdout);
}
export function violations(before,after,threshold=50,reasons={}) {
  if(!Number.isInteger(threshold) || threshold<0) throw Error('threshold must be a non-negative integer');
  const old=new Map(before.map(x=>[x.id,x]));
  return after.filter(x=>{
    const prior=old.get(x.id);
    if(prior?.source===x.source) return false;
    if(x.ccn<=threshold || (prior && x.ccn<=prior.ccn)) return false;
    const reason=reasons[x.id];
    return !(reason && typeof reason.reason==='string' && reason.reason.trim() && Number.isInteger(reason.ceiling) && x.ccn<=reason.ceiling);
  });
}
