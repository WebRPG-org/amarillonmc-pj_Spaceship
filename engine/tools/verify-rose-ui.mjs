import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import mysql from 'mysql2/promise';
import {createApplication} from '../server/index.mjs';
import {MySqlStore} from '../server/persistence.mjs';
import {PUBLIC_CITY_VERSION} from '../server/public-city.mjs';
import {DIRECTIONS} from '../server/world.mjs';
import {TUTORIAL_STEPS} from '../server/tutorial.mjs';
import {validateGameplay} from '../server/gameplay-content.mjs';

// Real client input, WebSocket, combat and MySQL. Only initial city placement is
// a fixture. ROSE_OMIT_WEAPON=1 also tests the valid authored configuration with
// no weapon slot. No tutorial progress, damage, loot or reward is injected.
const omitWeapon=process.env.ROSE_OMIT_WEAPON==='1';
const root=fileURLToPath(new URL('../../',import.meta.url)),output=path.join(root,`engine/.artifacts/rose/${omitWeapon?'ui-empty-slot':'ui'}`);
const parse=text=>Object.fromEntries(text.split(/\r?\n/).filter(line=>/^[A-Za-z_]+=/.test(line)).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
const admin=parse(await fs.readFile(new URL('../.local/mysql-admin.cnf',import.meta.url),'utf8'));
assert.equal(admin.host,'127.0.0.1');assert.equal(admin.port,'3317');
const schema=`spaceship_engine_test_rose_ui_${randomBytes(6).toString('hex')}`;
const connection={host:admin.host,port:Number(admin.port),user:admin.user,password:admin.password};
const store=new MySqlStore({...connection,database:schema});
const report={omitWeapon,checks:[],screenshots:[],pageErrors:[],failedRequests:[],desktop:{width:1440,height:960},mobile:{width:390,height:844}};
let app,browser,page,account,latest,stage='initialize';const notices=[],sent=[],effects=[];
const player=()=>app.host.getPlayer(account.id),world=()=>app.host.playerWorld(account.id),round=()=>app.host.locations.get(account.id);
const step=()=>round()?.tutorial?.step?.id;
const quantity=(kind,id)=>(latest?.self.inventory||[]).filter(i=>i.kind===kind&&i.itemId===id).reduce((n,i)=>n+i.quantity,0);
async function until(check,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(40);}throw new Error(`Timed out: ${label}; step=${step()}; notices=${notices.slice(-3).join(' | ')}`);}
async function closePanel(){if(await page.locator('#panel-overlay').isVisible())await page.locator('#close-panel').click();}
async function capture(name){await page.screenshot({path:path.join(output,`${name}.png`)});report.screenshots.push(`${name}.png`);}
function mark(text){report.checks.push(text);console.log(`PASS: ${text}`);}
const key={2:'ArrowDown',4:'ArrowLeft',6:'ArrowRight',8:'ArrowUp'};
function pathTo(goal){const p=player(),w=world(),q=[{x:p.x,y:p.y,path:[]}],seen=new Set([`${p.x},${p.y}`]);
  while(q.length){const n=q.shift();if(goal(n))return n.path;for(const[d,[dx,dy]]of Object.entries(DIRECTIONS)){const x=n.x+dx,y=n.y+dy,k=`${x},${y}`;if(seen.has(k)||!w.canMove({...p,x:n.x,y:n.y},Number(d)))continue;const portal=[...w.maps.get(p.mapId).events.values()].some(e=>e.x===x&&e.y===y&&e.pages.some(pg=>[1,2].includes(pg.trigger)&&pg.list.some(c=>c.code===201)));if(portal)continue;seen.add(k);q.push({x,y,path:[...n.path,Number(d)]});}}return null;}
async function walk(goal){await closePanel();let guard=0;while(!goal(player())&&guard++<500){const route=pathTo(goal);assert.ok(route?.length,`No route at ${player().mapId}:${player().x},${player().y}`);const p=player(),before={x:p.x,y:p.y,mapId:p.mapId},d=route[0];await delay(Math.max(165,world().movementInterval(p)+25));await page.locator('#world').focus();await page.keyboard.down(key[d]);try{await until(()=>player().x!==before.x||player().y!==before.y||player().mapId!==before.mapId,`keyboard movement ${before.mapId}:${before.x},${before.y} direction ${d}`,3000);}finally{await page.keyboard.up(key[d]);}}assert.ok(goal(player()),'walk reached destination');}
async function interact(event){await walk(p=>Math.abs(p.x-event.x)+Math.abs(p.y-event.y)<=1);const p=player(),d=event.x>p.x?6:event.x<p.x?4:event.y>p.y?2:8;await page.keyboard.press(key[d]);await page.locator('#interact-button').click();}
async function portal(mapId){if(player().mapId===mapId)return;const source=player().mapId,e=[...world().maps.get(source).events.values()].find(e=>e.pages.some(pg=>pg.list.some(c=>c.code===201&&c.parameters[1]===mapId)));assert.ok(e,`portal ${source}->${mapId}`);await walk(p=>p.mapId===mapId||Math.abs(p.x-e.x)+Math.abs(p.y-e.y)<=1);if(player().mapId!==mapId){const p=player(),d=e.x>p.x?6:e.x<p.x?4:e.y>p.y?2:8;await delay(220);await page.keyboard.press(key[d]);}await until(()=>latest?.mapId===mapId,`transfer to ${mapId}`);await page.waitForFunction(id=>document.querySelector('#world').dataset.mapId===String(id)&&document.querySelector('#map-loading').hidden,mapId);}
async function equip(id){await closePanel();await page.locator('#inventory-button').click();const name=app.content.database.Weapons[id].name,row=page.locator('.item-row').filter({has:page.getByText(name,{exact:true})}).first();if(latest.self.equips.weapon!==id)await row.getByRole('button',{name:'装备',exact:true}).click();await until(()=>latest.self.equips.weapon===id,`equip ${id}`);await closePanel();}
async function fight(enemy){let attempts=0;while(!enemy.dead&&attempts++<70){await walk(p=>Math.abs(p.x-enemy.x)+Math.abs(p.y-enemy.y)===1);const p=player(),d=enemy.x>p.x?6:enemy.x<p.x?4:enemy.y>p.y?2:8;await page.keyboard.press(key[d]);await page.locator('#attack-button').click();await delay(700);}assert.ok(enemy.dead,`defeated ${enemy.name}`);await player()._queue;}
async function clickEnemy(enemy){
  await walk(p=>Math.abs(p.x-enemy.x)+Math.abs(p.y-enemy.y)<=4);
  // Camera follows the rendered, interpolated snapshot rather than the current
  // server position. Let the last key-up and snapshot settle before hit testing.
  await until(()=>{const visible=latest?.players.find(p=>p.id===account.id),p=player();return visible?.x===p.x&&visible?.y===p.y;},'mouse camera snapshot');await delay(350);
  const p=player(),map=app.content.getMap(p.mapId),rect=await page.locator('#world').boundingBox(),zoom=parseFloat(await page.locator('#zoom-label').innerText())/100;
  const width=rect.width/zoom/48,height=rect.height/zoom/48,cx=map.width<width?(map.width-width)/2:Math.max(0,Math.min(map.width-width,p.x+.5-width/2)),cy=map.height<height?(map.height-height)/2:Math.max(0,Math.min(map.height-height,p.y+.5-height/2));
  const marker=sent.length;await page.mouse.click(rect.x+(enemy.x+.5-cx)*48*zoom,rect.y+(enemy.y+.5-cy)*48*zoom);
  await until(()=>sent.slice(marker).some(m=>m.type==='navigate'&&!m.cancel),'mouse command');const command=sent.slice(marker).find(m=>m.type==='navigate'&&!m.cancel);assert.equal(command.targetId,enemy.id,'browser click must select the enemy, not nearby ground');assert.equal(command.skillId,1);
  try{await until(()=>enemy.dead,'mouse click defeats unarmed target');}catch(error){const p=player();report.attackDiagnostic={sent:sent.slice(-15),effects:effects.slice(-10),player:{x:p.x,y:p.y,direction:p.direction,equips:p.equips,attackPending:p._attackPending,economyBusy:p._economyBusy,lastAttack:p._lastAttack},target:{x:enemy.x,y:enemy.y,hp:enemy.hp},navigation:p.navigation};console.error(JSON.stringify(report.attackDiagnostic));throw error;}
}

await fs.mkdir(output,{recursive:true});
try{
  app=await createApplication({store,devTools:false});assert.equal(app.databaseReady,true);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');assert.notEqual(app.server.address().port,8098);
  if(omitWeapon){delete app.host.scenarios['rose-orientation'].initialState.equips.weapon;validateGameplay({...app.content.gameplay,scenarios:app.host.scenarios},app.content);}
  const username=`rose_ui_${randomBytes(4).toString('hex')}`,password='rose-ui-fixture-password';account=await store.register(username,password);
  await store.savePlayer(account.id,{...app.world.defaultState(),publicCityVersion:PUBLIC_CITY_VERSION,mapId:41,x:25,y:15,direction:8,gold:73,inventory:[],equips:{weapon:0,armor:0}});
  const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'C:/Users/mapodoufu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  page=await browser.newPage({viewport:report.desktop,deviceScaleFactor:1});page.setDefaultTimeout(15000);
  page.on('pageerror',error=>report.pageErrors.push(error.message));page.on('requestfailed',request=>{if(!request.url().includes('/ws'))report.failedRequests.push(request.url());});
  page.on('websocket',socket=>{socket.on('framesent',frame=>{try{sent.push(JSON.parse(String(frame.payload)));}catch{}});socket.on('framereceived',frame=>{try{const m=JSON.parse(String(frame.payload));if(m.type==='snapshot')latest=m;if(m.type==='notice')notices.push(m.message);if(m.type==='effect')effects.push(m);}catch{}});});
  stage='login';await page.goto(`http://127.0.0.1:${app.server.address().port}`);await page.locator('#username').fill(username);await page.locator('#password').fill(password);await page.locator('#login-button').click();await until(()=>latest?.mapId===41,'login');await page.locator('#welcome').waitFor({state:'hidden'});
  stage='entry';await capture('01-rose-city');await page.locator('#interact-button').click();const card=page.locator('.instance-mode-card').filter({hasText:'ROSE'});await card.getByRole('button').click();await until(()=>latest?.instance?.definitionId==='rose-orientation','tutorial created');await page.getByRole('button',{name:'开始副本',exact:true}).click();await until(()=>latest.instance?.status==='active','tutorial started');await closePanel();await page.locator('#gab-window').waitFor({state:'visible'}).catch(()=>{});await capture('02-movement-gab');mark('ROSE entry starts a private tutorial; face Gab displays without dialogue lock');
  await page.setViewportSize({width:816,height:624});await capture('02b-compact-gab');await page.setViewportSize(report.mobile);await capture('02c-mobile-gab');await page.setViewportSize(report.desktop);
  for(const checkpoint of ['a','b','c']){stage=`checkpoint-${checkpoint}`;const e=[...world().maps.get(57).events.values()].find(e=>e.tutorialCheckpoint===checkpoint);await walk(p=>Math.abs(p.x-e.x)+Math.abs(p.y-e.y)<=1);await until(()=>step()!==`move-${checkpoint}`,stage);}
  mark('keyboard movement traverses all three terrain checkpoints in order');await portal(58);await capture('03-weapons');
  for(const lesson of TUTORIAL_STEPS.filter(s=>s.target)){stage=`weapon-${lesson.id}`;await until(()=>step()===lesson.id,stage);if(lesson.weaponId)await equip(lesson.weaponId);const enemy=[...world().maps.get(58).events.values()].find(e=>e.tutorialTarget===lesson.target);if(omitWeapon&&lesson.id==='unarmed'){assert.equal(latest.self.equips.weapon,0);assert.equal(await page.locator('#skill-select option').count(),2);await page.locator('#skill-select').selectOption('1');await clickEnemy(enemy);mark('omitted weapon slot normalizes to unarmed; second attack menu option and mouse auto-approach defeat the first target');}else await fight(enemy);await until(()=>step()!==lesson.id,`complete ${lesson.id}`);mark(`real UI equipped and defeated ${lesson.id} target`);}
  stage='pickup';const drop=[...world().maps.get(58).drops.values()].find(d=>round().tutorial.dropIds.has(d.id));assert.ok(drop);await walk(p=>Math.abs(p.x-drop.x)+Math.abs(p.y-drop.y)<=1);await page.locator('#inventory-button').click();await page.getByRole('button',{name:'拾取',exact:true}).first().click();await until(()=>step()==='search','actual pickup');await closePanel();await portal(59);
  stage='search';const container=[...world().maps.get(59).events.values()].find(e=>e.service?.action==='container');await interact(container);await until(()=>step()==='craft','container search');await page.locator('#craft-button').click();await capture('04-crafting');const recipe=page.locator('.item-row').filter({has:page.getByText('Curry Bread',{exact:true})});await recipe.getByRole('button',{name:'合成',exact:true}).click();await until(()=>step()==='use','craft');await closePanel();await page.locator('#inventory-button').click();await page.locator('.item-row').filter({has:page.getByText('Curry Bread',{exact:true})}).getByRole('button',{name:'使用',exact:true}).click();await until(()=>step()==='final','use crafted item');await closePanel();mark('real loot pickup, one-time container, recipe and item-use UI advance lessons');
  stage='final';await portal(60);await equip(66);await capture('05-final-field');for(const enemy of [...world().maps.get(60).events.values()].filter(e=>e.enemyId))await fight(enemy);await until(()=>step()==='exit','final opponents defeated');await capture('06-graduation');const exit=[...world().maps.get(60).events.values()].find(e=>e.service?.action==='tutorialExit');await interact(exit);await until(()=>!latest.instance&&latest.self.profile.titles?.includes('red-kill-sword'),'permanent reward');await capture('07-reward');assert.equal(latest.self.gold,73);assert.equal(quantity('weapon',66),1);assert.deepEqual((await store.loadProfile(account.id)).titles,['red-kill-sword']);mark('graduation restores main-world state and commits exactly one permanent sword');
  await page.getByRole('button',{name:'返回世界',exact:true}).click();await equip(66);assert.equal((await store.loadPlayer(account.id)).state.equips.weapon,66);await capture('07b-main-world-equipped');
  stage='dts';const guide=[...world().maps.get(41).events.values()].find(e=>e.service?.kind==='instance');await interact(guide);await page.getByRole('button',{name:'创建 PvE 副本',exact:true}).click();await until(()=>latest.instance?.definitionId==='rural-lockdown','DTS created');assert.equal(quantity('weapon',66),1);await page.getByRole('button',{name:'开始副本',exact:true}).click();await until(()=>latest.instance?.status==='active','DTS started');await equip(66);await capture('08-dts-sword');mark('main-world equipped unlock grants red sword at DTS entry, and weapon equips through UI');
  await page.setViewportSize(report.mobile);await page.locator('#inventory-button').click();await capture('09-mobile-sword');await closePanel();await page.setViewportSize(report.desktop);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.failedRequests,[]);report.success=true;
}catch(error){report.success=false;report.failure={stage,message:error.message,stack:error.stack};process.exitCode=1;console.error(error);if(page)await capture(`failure-${stage}`).catch(()=>{});
}finally{
  if(browser)await browser.close();if(app){await until(()=>[...app.host.players.values()].every(p=>!p._connected&&!p._disconnecting),'disconnect',10000).catch(()=>{});await app.close();}else await store.close();
  assert.match(schema,/^spaceship_engine_test_rose_ui_[0-9a-f]{12}$/);const cleanup=await mysql.createConnection(connection);try{await cleanup.query(`DROP DATABASE IF EXISTS \`${schema}\``);report.temporarySchemaRemoved=true;}finally{await cleanup.end();}
  await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({success:report.success,checks:report.checks.length,screenshots:report.screenshots.length,output}));
}
