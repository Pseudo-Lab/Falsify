import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutStepDecision} from '../src/paper-layout-transport.mjs';

test('abort after running receipt prevents polling and retains pending receipt',async()=>{
 const hash='a'.repeat(64),controller=new AbortController(),saved=[],calls=[];
 const request={projectId:hash,step:0};
 const link={request:async(path,body)=>{calls.push({path,body});return {schema:'falsify.layout-step-receipt.v1',runId:'r1',stepId:'r1-s0',fingerprint:hash,state:'running'};}};
 await assert.rejects(layoutStepDecision(link,request,{runId:'r1',signal:controller.signal,pollMs:10000,onPending:p=>{saved.push(p);if(p.state==='running')controller.abort();}}),{name:'AbortError'});
 assert.equal(calls.length,1);assert.equal(saved.at(-1).state,'running');
});
