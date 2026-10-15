import test from 'node:test';
import assert from 'node:assert/strict';
import {restartEngine} from './editor-restart.mjs';

const options={instanceId:'old',requestId:'request-1234567890',wait:async()=>{},attempts:3};
const response=state=>({state,requestId:options.requestId,instanceId:state==='succeeded'?'new':'old'});

test('restart waits for confirmed completion and emits progress',async()=>{
  const calls=[],progress=[],queue=[response('preparing'),response('saving'),response('succeeded')];
  const result=await restartEngine(async(path,input)=>{calls.push({path,input});return queue.shift();},{...options,onProgress:message=>progress.push(message)});
  assert.equal(result.instanceId,'new');assert.equal(calls.filter(c=>c.input?.method==='POST').length,1);
  assert.deepEqual(JSON.parse(calls[0].input.body),{instanceId:options.instanceId,requestId:options.requestId});
  assert.equal(progress.length,2);
});

test('a lost POST response is recovered by status polling without another POST',async()=>{
  let posts=0,gets=0;
  const result=await restartEngine(async(path,input)=>{if(input.method==='POST'){posts++;throw new TypeError('network unavailable');}gets++;if(gets===1)throw new TypeError('network unavailable');return response('succeeded');},options);
  assert.equal(result.state,'succeeded');assert.equal(posts,1);assert.equal(gets,2);
});

test('permission errors, server failures and unrelated requests never become success',async()=>{
  let calls=0;await assert.rejects(restartEngine(async()=>{calls++;throw Object.assign(new Error('denied'),{status:403});},options),/denied/);assert.equal(calls,1);
  await assert.rejects(restartEngine(async()=>({...response('failed'),error:'保存失败，服务暂停'}),options),/保存失败/);
  await assert.rejects(restartEngine(async()=>({...response('succeeded'),requestId:'other'}),options),/未能确认/);
  await assert.rejects(restartEngine(async()=>response('saving'),options),/尚未确认重启完成/);
});
