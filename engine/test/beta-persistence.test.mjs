import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import mysql from 'mysql2/promise';
import {MySqlStore} from '../server/persistence.mjs';

const enabled=process.env.MYSQL_TEST==='1';
const parse=text=>Object.fromEntries(text.split(/\r?\n/).filter(line=>/^[a-zA-Z_]+=/.test(line)).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
test('MySQL beta rewards, account profiles, environmental drops and records remain atomic and isolated',{skip:!enabled,timeout:30000},async t=>{
  const config=parse(await readFile(new URL('../.local/mysql-admin.cnf',import.meta.url),'utf8'));
  assert.equal(config.host,'127.0.0.1');assert.equal(config.port,'3317');
  const database=`spaceship_engine_test_beta_${randomBytes(6).toString('hex')}`;
  const options={host:config.host,port:Number(config.port),user:config.user,password:config.password,database};
  const admin=await mysql.createConnection({...options,database:undefined}),store=new MySqlStore(options);
  try{
    await store.init();
    const [a,b]=await Promise.all(['beta_a','beta_b'].map(name=>store.register(name,'beta-test-password')));
    const outside={schemaVersion:1,mapId:40,x:5,y:5,level:12,gold:88,hp:790,inventory:[{kind:'item',itemId:7,quantity:2}]};
    for(const player of [a,b])await store.savePlayer(player.id,outside);
    await store.updateProfile(a.id,{appearance:{characterName:'Actor1',characterIndex:3},offlineBehavior:'stay'});
    const starter={...outside,mapId:52,level:1,gold:0,inventory:[]};
    const make=async(player,definitionId='meteor-recovery')=>{const round=await store.createRound({definitionId,metadata:{name:'飞火流星 · 废城回收'}});await store.joinRound(round.id,player.id,starter);return round;};
    let completed;
    await t.test('successful settlement and concurrent profile changes retain the title exactly once',async()=>{
      completed=await make(a);
      const result={success:true,name:'飞火流星 · 废城回收',reason:'disk-extracted',durationSeconds:121,reward:{titleId:'meteor',gold:25,items:[{kind:'item',itemId:102,quantity:1}]},participants:[{id:a.id,outcome:'completed'}]};
      const [first,second]=await Promise.all([store.finishRound(completed.id,result),store.finishRound(completed.id,result),store.updateProfile(a.id,{offlineBehavior:'evade'})]);
      assert.equal(Number(first.duplicate)+Number(second.duplicate),1);assert.deepEqual(first.result,second.result);
      const profile=await store.loadProfile(a.id);assert.deepEqual(profile.titles,['meteor']);assert.equal(profile.offlineBehavior,'evade');assert.equal(profile.appearance.characterIndex,3);
      const state=(await store.loadPlayer(a.id)).state;assert.equal(state.gold,113);assert.equal(state.level,12);assert.equal(state.hp,790);assert.deepEqual(state.inventory,[...outside.inventory,{kind:'item',itemId:102,quantity:1}]);
      await store.finishRound(completed.id,{...result,reward:{gold:99999}});assert.equal((await store.loadPlayer(a.id)).state.gold,113);
    });
    await t.test('a lost committed reward response and later replay cannot grant again',async()=>{
      const round=await make(a),original=store.withConnectionTransaction.bind(store);let lose=true;
      store.withConnectionTransaction=async action=>{const answer=await original(action);if(lose){lose=false;throw new Error('simulated lost reward commit');}return answer;};
      const result={success:true,reward:{titleId:'meteor',gold:3},participants:[{id:a.id,outcome:'completed'}]};
      try{await assert.rejects(store.finishRound(round.id,result),/lost reward commit/);}finally{store.withConnectionTransaction=original;}
      const replay=await store.finishRound(round.id,result);assert.equal(replay.duplicate,true);assert.equal(replay.result.rewardsByPlayer[a.id].newTitle,false);assert.equal((await store.loadPlayer(a.id)).state.gold,116);assert.deepEqual((await store.loadProfile(a.id)).titles,['meteor']);
    });
    await t.test('death, failure and an already departed participant receive no completion reward',async()=>{
      for(const outcome of ['dead','failed','left']){
        const round=await make(b);if(outcome==='left')await store.leaveRound(round.id,b.id,{outcome});
        await store.finishRound(round.id,{success:true,reward:{titleId:'meteor',gold:999},participants:[{id:b.id,outcome:outcome==='left'?'completed':outcome}]});
      }
      const round=await make(b);await store.finishRound(round.id,{success:false,reward:{titleId:'meteor'},participants:[{id:b.id,outcome:'completed'}]});
      assert.deepEqual((await store.loadPlayer(b.id)).state,outside);assert.equal((await store.loadProfile(b.id)).titles,undefined);
      const records=await store.listPlayerRecords(a.id);assert.equal(records.length,2);assert.ok(records.some(r=>r.id===completed.id&&r.result.reason==='disk-extracted'));assert.ok(records.every(r=>r.result.participants.some(p=>p.id===a.id)));
      assert.equal((await store.listPlayerRecords(b.id,1.5)).length,1);assert.equal((await store.listPlayerRecords(999999)).length,0);
    });
    await t.test('environmental NPC item and gold drops commit once per world and cannot reappear after pickup',async()=>{
      const round=await make(b),scoped=store.forRound(round.id),drop={kind:'gold',itemId:0,quantity:12,mapId:52,x:3,y:3},requestId='environmental-kill-1';
      const [first,replay]=await Promise.all([scoped.createWorldDrops({requestId,drops:[drop]}),scoped.createWorldDrops({requestId,drops:[drop]})]);
      assert.equal(Number(first.duplicate)+Number(replay.duplicate),1);assert.equal(first.drops[0].id,replay.drops[0].id);
      assert.equal((await scoped.listDrops(52)).length,1);assert.equal((await store.listDrops(52)).length,0);
      const gold=first.drops[0];await scoped.claimDrop({playerId:b.id,requestId:'pick-gold',dropId:gold.id,mutator:(state,value)=>{state.gold+=value.quantity;}});
      assert.equal((await scoped.loadPlayer(b.id)).state.gold,12);assert.equal((await store.loadPlayer(b.id)).state.gold,88);
      const gone=await scoped.createWorldDrops({requestId,drops:[drop]});assert.equal(gone.duplicate,true);assert.deepEqual(gone.drops,[]);assert.deepEqual(await scoped.listDrops(52),[]);
      const main=await store.createWorldDrops({requestId,drops:[drop,{...drop,kind:'item',itemId:102,quantity:1}]});assert.equal(main.drops.length,2);
      await assert.rejects(store.createWorldDrops({requestId:'invalid-gold',drops:[{...drop,itemId:102}]}),{code:'INVALID_DROP'});
      await store.finishRound(round.id,{success:false});await assert.rejects(scoped.createWorldDrops({requestId:'after-end',drops:[drop]}),{code:'ROUND_CLOSED'});
    });
    await t.test('a failed permanent reward rolls back both title and settlement status',async()=>{
      const round=await make(b);
      await assert.rejects(store.finishRound(round.id,{success:true,reward:{titleId:'meteor',items:[{kind:'item',itemId:102,quantity:-1}]},participants:[{id:b.id,outcome:'completed'}]}));
      assert.equal((await store.loadRound(round.id)).status,'waiting');assert.equal((await store.loadProfile(b.id)).titles,undefined);
      await store.finishRound(round.id,{success:false});
    });
    await t.test('ROSE first completion grants a real weapon once across concurrency, lost responses and later rounds',async()=>{
      const rose=await store.register('rose_first_clear','beta-test-password');await store.savePlayer(rose.id,outside);
      const reward={titleId:'red-kill-sword',firstCompletionOnly:true,items:[{kind:'weapon',itemId:66,quantity:1}]};
      const result={success:true,reward,participants:[{id:rose.id,outcome:'completed'}]};
      const first=await make(rose,'rose-orientation'),original=store.withConnectionTransaction.bind(store);let lose=true;
      store.withConnectionTransaction=async action=>{const value=await original(action);if(lose){lose=false;throw new Error('lost ROSE reward response');}return value;};
      try{await assert.rejects(store.finishRound(first.id,result),/lost ROSE/);}finally{store.withConnectionTransaction=original;}
      const replay=await store.finishRound(first.id,result);assert.equal(replay.duplicate,true);assert.equal(replay.result.rewardsByPlayer[rose.id].newTitle,true);assert.equal(replay.result.rewardsByPlayer[rose.id].items[0].itemId,66);
      const second=await make(rose,'rose-orientation');const results=await Promise.all([store.finishRound(second.id,result),store.finishRound(second.id,result)]);
      assert.equal(results.filter(r=>r.duplicate).length,1);assert.equal(results[0].result.rewardsByPlayer[rose.id].newTitle,false);assert.deepEqual(results[0].result.rewardsByPlayer[rose.id].items,[]);
      const state=(await store.loadPlayer(rose.id)).state;assert.equal(state.inventory.filter(i=>i.kind==='weapon'&&i.itemId===66).reduce((n,i)=>n+i.quantity,0),1);assert.equal(state.gold,outside.gold);assert.equal(state.level,outside.level);assert.deepEqual((await store.loadProfile(rose.id)).titles,['red-kill-sword']);
    });
  }finally{
    await store.close();assert.match(database,/^spaceship_engine_test_beta_[0-9a-f]{12}$/);await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);await admin.end();
  }
});
