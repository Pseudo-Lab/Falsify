const assert=require('node:assert/strict'),H=require('../dist/harness-core.js');let passed=0;const checks=[];
function check(name,fn){fn();checks.push(name);passed++;}
const base=H.builtin('blue'),run={id:'r1',role:'blue',harness:base,harnessHash:'a'.repeat(64),model:'fixture',sourceHash:'b'.repeat(64),maxCalls:8,level:null,provenance:'manual-unverified'};
(async()=>{
 check('default role configuration',()=>assert.equal(H.validate(base,'blue').role,'blue'));
 for(const [name,delta] of [['role mismatch',{role:'red'}],['unknown field',{unknown:true}],['missing adapter shape',{adapter:null}],['null settings',{settings:null}],['array settings',{settings:[]}],['fractional calls',{maxCalls:1.5}],['shell string instead of args',{adapter:{type:'stdio',executable:'C:/python.exe',args:'-c code'}}],['userinfo URL',{adapter:{type:'http',url:'https://key@example.com/api'}}],['query secret',{adapter:{type:'http',url:'https://example.com/api?key=x'}}],['too long URL',{adapter:{type:'http',url:'https://example.com/'+ 'x'.repeat(2000)}}]])check(name+' rejected',()=>assert.throws(()=>H.validate({...base,...delta},'blue')));
 check('settings preserve arbitrary structure',()=>assert.deepEqual(H.validate({...base,settings:{strategy:['step1',{tool:'mine'}]}}).settings,{strategy:['step1',{tool:'mine'}]}));
 check('canonical hash stable across key order',()=>assert.equal(H.canonical({...base,settings:{b:2,a:0.00001}}),H.canonical({...base,settings:{a:0.00001,b:2}})));
 const initialHash=await H.hash(base),changedHash=await H.hash({...base,instructions:'Another strategy.'});check('instruction changes immutable hash',()=>assert.notEqual(initialHash,changedHash));
 check('conditions create separate groups',()=>assert.equal(H.summarize([run,{...run,id:'r2',sourceHash:'c'.repeat(64)}],[]).length,2));
 check('latest review only, uncertain excluded',()=>{const groups=H.summarize([run],[{runId:'r1',verdict:'supported',score:5},{runId:'r1',verdict:'uncertain',score:null}]);assert.equal(groups[0].mean,null);assert.equal(groups[0].reviewed,1);assert.equal(groups[0].uncertain,1);assert.equal(groups[0].manual,1);});
 console.log(JSON.stringify({passed,checks},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
