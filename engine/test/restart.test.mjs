import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {createApplication} from '../server/index.mjs';
import {PUBLIC_CITY_SERVICES} from '../server/public-city.mjs';
import {TUTORIAL_ID} from '../server/tutorial.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
class MemoryStore {
  constructor(){this.states=new Map();this.profiles=new Map();this.rounds=new Map();this.closed=false;this.aborts=0;}
  async init(){}
  async close(){this.closed=true;}
  async abortUnfinishedRounds(){this.aborts++;}
  async login(){return{id:1,username:'tester'};}
  async loadPlayer(id){return{id,username:'tester',state:structuredClone(this.states.get(id)||{})};}
  async savePlayer(id,state){if(this.failSave)throw new Error('SAVE_UNAVAILABLE');this.states.set(id,structuredClone(state));}
  async listDrops(){return[];}
  async loadProfile(id){return structuredClone(this.profiles.get(id)||{});}
  async updateProfile(id,patch){this.profileStarted?.resolve();if(this.profileGate)await this.profileGate.promise;const profile={...await this.loadProfile(id),...patch};this.profiles.set(id,structuredClone(profile));return profile;}
  async createRound(data){this.roundStarted?.resolve();if(this.roundGate)await this.roundGate.promise;this.rounds.set(data.id,{...data,status:'waiting',scope:new MemoryStore()});}
  forRound(id){return this.rounds.get(id).scope;}
  async joinRound(id,playerId,state){await this.forRound(id).savePlayer(playerId,state);return{id:playerId,username:'tester',state:structuredClone(state)};}
  async finishRound(id,result){const round=this.rounds.get(id);round.status='finished';round.result=structuredClone(result);return{result};}
  async updateRound(id,patch){Object.assign(this.rounds.get(id),patch);}
}

async function eventually(fn,label){for(let i=0;i<200;i++){const result=await fn();if(result)return result;await delay(10);}assert.fail(label);}
async function fixture(t,{devTools=true}={}){
  const projectRoot=await mkdtemp(path.join(tmpdir(),'spaceship-restart-'));
  await cp(new URL('../../data/',import.meta.url),path.join(projectRoot,'data'),{recursive:true});
  await mkdir(path.join(projectRoot,'engine'),{recursive:true});
  await cp(new URL('../content/',import.meta.url),path.join(projectRoot,'engine','content'),{recursive:true});
  const store=new MemoryStore(),app=await createApplication({projectRoot,store,devTools});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const base=`http://127.0.0.1:${app.server.address().port}`,clients=[];
  t.after(async()=>{store.failSave=false;store.profileGate?.resolve();store.roundGate?.resolve();for(const ws of clients)ws.terminate();await app.close();await rm(projectRoot,{recursive:true,force:true});});
  const request=async(route,options={})=>{const res=await fetch(base+route,{...options,headers:{'Content-Type':'application/json','X-Editor-Request':'1',...options.headers}});return{status:res.status,data:await res.json()};};
  const state=async()=>(await request('/api/editor/restart')).data;
  const restart=async(input={})=>request('/api/editor/restart',{method:'POST',body:JSON.stringify({requestId:randomUUID(),instanceId:(await state()).instanceId,...input})});
  const finished=()=>eventually(async()=>{const value=await state();return['succeeded','failed'].includes(value.state)&&value;},'restart should finish');
  async function connect(){const {data:session}=await request('/api/session',{method:'POST',body:JSON.stringify({mode:'login',username:'tester',password:'fixture-password'})});const ws=new WebSocket(`${base.replace('http:','ws:')}/ws?token=${session.token}`);clients.push(ws);const messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw)));ws.on('error',()=>{});await once(ws,'open');await eventually(()=>messages.some(m=>m.type==='snapshot'),'player should connect');return{ws,messages,token:session.token};}
  return{projectRoot,store,app,request,state,restart,finished,connect,base};
}

test('editor restart reimports disk content, settles rounds, flushes players and invalidates sessions',async t=>{
  const f=await fixture(t),client=await f.connect(),oldHost=f.app.host,oldState=await f.state();
  const player=oldHost.getPlayer(1),guide=PUBLIC_CITY_SERVICES.instance;
  await oldHost.world.ensureMap(guide.mapId);
  player.mapId=guide.mapId;player.x=guide.x;player.y=guide.y+1;player.gold=321;
  const round=await oldHost.create(player,'pve',TUTORIAL_ID);
  // Persisted world state must survive, while temporary round inventory is discarded.
  assert.equal(oldHost.rounds.size,1);
  const filename=path.join(f.projectRoot,'data','Map040.json'),map=JSON.parse(await readFile(filename,'utf8'));map.displayName='Restart fixture';await writeFile(filename,JSON.stringify(map));
  const requestId=randomUUID(),response=await f.restart({requestId});assert.equal(response.status,202);
  const result=await f.finished();assert.equal(result.state,'succeeded',result.error);assert.notEqual(result.instanceId,oldState.instanceId);assert.notEqual(f.app.host,oldHost);
  assert.equal(f.app.content.getMap(40).displayName,'Restart fixture');assert.equal(f.store.states.get(1).gold,321);assert.equal(f.store.rounds.get(round.id).status,'finished');assert.equal(f.store.rounds.get(round.id).result.reason,'server-shutdown');
  assert.equal(f.store.closed,false);assert.equal(f.app.host.players.size,0);assert.equal((await f.request('/api/session',{headers:{Authorization:`Bearer ${client.token}`}})).status,401);
  assert.equal((await f.restart({requestId,instanceId:oldState.instanceId})).status,200);assert.equal((await f.state()).instanceId,result.instanceId);
  assert.equal((await f.restart({instanceId:oldState.instanceId})).status,409);
});

test('restart drains in-flight profile writes and round creation, blocks new commands and competing requests',async t=>{
  const f=await fixture(t),client=await f.connect(),player=f.app.host.getPlayer(1),guide=PUBLIC_CITY_SERVICES.instance;
  await f.app.host.world.ensureMap(guide.mapId);
  player.mapId=guide.mapId;player.x=guide.x;player.y=guide.y+1;
  f.store.profileGate=deferred();f.store.profileStarted=deferred();f.store.roundGate=deferred();f.store.roundStarted=deferred();
  client.ws.send(JSON.stringify({type:'offlineBehavior',behavior:'evade'}));await f.store.profileStarted.promise;
  client.ws.send(JSON.stringify({type:'instance',action:'create',mode:'pve',definitionId:TUTORIAL_ID}));await f.store.roundStarted.promise;
  const response=await f.restart();assert.equal(response.status,202);assert.equal((await f.restart()).status,409);
  assert.equal((await f.request('/api/session',{method:'POST',body:'{}'})).status,503);
  assert.equal((await f.request('/api/editor/document?kind=gameplay',{method:'PUT',body:'{}'})).status,503);
  const tick=f.app.host.tick;client.ws.send(JSON.stringify({type:'move',direction:6}));await delay(70);assert.equal(f.app.host.tick,tick);
  assert.equal((await f.state()).state,'preparing');f.store.roundGate.resolve();f.store.profileGate.resolve();
  const result=await f.finished();assert.equal(result.state,'succeeded',result.error);assert.equal(f.store.profiles.get(1).offlineBehavior,'evade');assert.equal([...f.store.rounds.values()][0].status,'finished');
});

test('invalid content leaves the original runtime usable; failed saves retain paused state until explicit retry',async t=>{
  const f=await fixture(t);await f.connect();const host=f.app.host,player=host.getPlayer(1),file=path.join(f.projectRoot,'data','Map040.json'),source=await readFile(file,'utf8');
  await writeFile(file,'{invalid');await f.restart();let result=await f.finished();assert.equal(result.state,'failed');assert.equal(result.maintenance,false);assert.equal(f.app.host,host);assert.equal(host.getPlayer(1),player);
  await writeFile(file,source);player.gold=987;f.store.failSave=true;await f.restart();result=await f.finished();assert.equal(result.state,'failed');assert.equal(result.maintenance,true);assert.equal(host.getPlayer(1).gold,987);assert.equal((await f.request('/api/content')).status,503);
  // A second failed preflight must never resume a partly retired world.
  await writeFile(file,'{invalid');await f.restart();result=await f.finished();assert.equal(result.maintenance,true);
  await writeFile(file,source);f.store.failSave=false;await f.restart();result=await f.finished();assert.equal(result.state,'succeeded',result.error);assert.equal(result.maintenance,false);assert.equal(f.store.states.get(1).gold,987);
});

test('restart waits for an already accepted editor save and imports its completed contents',async t=>{
  const f=await fixture(t),document=(await f.request('/api/editor/document?kind=map&id=40')).data;
  const body=JSON.stringify({revision:document.revision,patch:{properties:{displayName:'Saved before restart'}}});
  const accepted=once(f.app.server,'request');
  let finishResponse;
  const response=new Promise(resolve=>{finishResponse=resolve;});
  const upload=http.request(f.base+'/api/editor/document?kind=map&id=40',{method:'PUT',headers:{'Content-Type':'application/json','X-Editor-Request':'1','Content-Length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>finishResponse(res.statusCode));});
  t.after(()=>upload.destroy());upload.write(body.slice(0,20));await accepted;
  assert.equal((await f.restart()).status,202);await delay(50);assert.equal((await f.state()).state,'preparing');
  upload.end(body.slice(20));assert.equal(await response,200);
  const result=await f.finished();assert.equal(result.state,'succeeded',result.error);assert.equal(f.app.content.getMap(40).displayName,'Saved before restart');
});

test('restart endpoint uses the existing local editor boundary and rejects unsafe methods',async t=>{
  const f=await fixture(t);const body=JSON.stringify({requestId:randomUUID(),instanceId:(await f.state()).instanceId});
  for(const headers of [{'X-Editor-Request':'0'},{Origin:'http://evil.example'},{'X-Forwarded-For':'203.0.113.5'}])assert.equal((await f.request('/api/editor/restart',{method:'POST',headers,body})).status,403,JSON.stringify(headers));
  assert.equal((await f.request('/api/editor/restart',{method:'DELETE'})).status,405);
  assert.equal((await f.request('/api/editor/restart',{method:'POST',body:JSON.stringify({requestId:'bad',instanceId:'bad'})})).status,400);
  assert.equal((await f.state()).state,'idle');
  const locked=await fixture(t,{devTools:false});assert.equal((await locked.request('/api/editor/restart')).status,403);
});
