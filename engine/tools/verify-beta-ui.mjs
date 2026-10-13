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
import {PUBLIC_CITY_SERVICES,PUBLIC_CITY_VERSION} from '../server/public-city.mjs';

// Actual Chromium app UI + WebSocket + dedicated MySQL. Fixture title ownership
// and transfers isolate UI checks; the host tests cover the full recovery walk.
// Never visits port 8098 and never reads or changes a real player account.
const root=fileURLToPath(new URL('../../',import.meta.url)),output=path.join(root,'engine/.artifacts/beta-ui');
const config=text=>Object.fromEntries(text.split(/\r?\n/).filter(line=>/^[A-Za-z_]+=/.test(line)).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
const env=config(await fs.readFile(new URL('../.env',import.meta.url),'utf8'));
const admin=config(await fs.readFile(new URL('../.local/mysql-admin.cnf',import.meta.url),'utf8'));
assert.equal(env.MYSQL_HOST,'127.0.0.1');assert.equal(env.MYSQL_PORT,'3317');assert.equal(admin.host,'127.0.0.1');assert.equal(admin.port,'3317');
const schema=`spaceship_engine_test_beta_ui_${randomBytes(6).toString('hex')}`;
const connection={host:admin.host,port:Number(admin.port),user:admin.user,password:admin.password};
const store=new MySqlStore({...connection,database:schema});
const report={devTools:false,databaseIsolation:true,desktop:{width:1440,height:960},mobile:{width:390,height:844},checks:[],screenshots:[],pageErrors:[],failedRequests:[]};
let app,browser,page,latest,account,stage='initialization';const notices=[];
async function eventually(predicate,label,timeout=10000){const until=Date.now()+timeout;while(Date.now()<until){if(await predicate())return;await delay(25);}throw new Error(`Timed out: ${label}`);}
const player=()=>latest?.players.find(p=>p.id===latest.playerId);
const quantity=(kind,id)=>latest?.self.inventory.filter(i=>i.kind===kind&&i.itemId===id).reduce((sum,i)=>sum+i.quantity,0)||0;
const mark=label=>{report.checks.push(label);console.log(`PASS: ${label}`);};
async function closePanel(){if(await page.locator('#panel-overlay').isVisible())await page.locator('#close-panel').click();}
async function capture(name){
  // Main-world panels are safe to read after transient notifications naturally
  // expire. Hazard/channel evidence is captured immediately during live play.
  if(/(?:title|shop|records)/.test(name)&&!name.includes('active-toast')&&!name.startsWith('failure'))await page.waitForFunction(()=>document.querySelector('#toast-stack').children.length===0);
  await page.screenshot({path:path.join(output,`${name}.png`)});report.screenshots.push(`${name}.png`);
}
async function panelFits(){
  const box=await page.locator('.panel').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,viewport:innerWidth}));
  assert.ok(box.scrollWidth<=box.width+1,`Panel overflow: ${JSON.stringify(box)}`);assert.ok(box.left>=0&&box.right<=box.viewport,`Panel outside viewport: ${JSON.stringify(box)}`);
}
async function mobileToastFits(){
  const layout=await page.evaluate(()=>{const header=document.querySelector('.panel-heading').getBoundingClientRect();const toasts=[...document.querySelectorAll('#toast-stack .toast')].filter(el=>getComputedStyle(el).display!=='none').map(el=>({top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom}));return{headerBottom:header.bottom,toasts};});
  assert.equal(layout.toasts.length,1,'A mobile open panel shows only the newest live toast');assert.ok(layout.toasts[0].top>=layout.headerBottom,'Live notification must not cover the panel title or close button');
}
async function transfer(mapId,x,y,direction=8){
  const p=app.host.getPlayer(account.id),world=app.host.playerWorld(account.id);await world.transfer(p,mapId,x,y);p.direction=direction;world.sendSnapshot(p);
  await eventually(()=>latest?.mapId===mapId&&player()?.x===x&&player()?.y===y,`fixture transfer to ${mapId}`);
  await page.waitForFunction(id=>document.querySelector('#world').dataset.mapId===String(id)&&document.querySelector('#map-loading').hidden,mapId);
}
async function leaveRound(){
  await closePanel();await page.locator('#instance-button').click();await page.getByRole('button',{name:'退出并返回世界',exact:true}).click();
  await eventually(()=>latest&&!latest.instance&&!app.host.transitions.has(account.id),'return to main world');
  await page.getByRole('button',{name:'返回世界',exact:true}).click();
}

await fs.mkdir(output,{recursive:true});
try{
  app=await createApplication({store,devTools:false});assert.equal(app.databaseReady,true);
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');assert.notEqual(app.server.address().port,8098);
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const username=`beta_ui_${randomBytes(4).toString('hex')}`,password='beta-ui-fixture-password';
  account=await store.register(username,password);
  await store.savePlayer(account.id,{...app.world.defaultState(),publicCityVersion:PUBLIC_CITY_VERSION,mapId:42,x:17,y:8,direction:8,gold:200,inventory:[],equips:{weapon:0,armor:0}});
  await store.updateProfile(account.id,{titles:['meteor'],equippedTitle:null,offlineBehavior:'stay'});
  const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'C:/Users/mapodoufu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  page=await browser.newPage({viewport:report.desktop,deviceScaleFactor:1});page.setDefaultTimeout(15000);
  page.on('pageerror',error=>report.pageErrors.push(error.message));
  page.on('requestfailed',request=>{const url=new URL(request.url());if(!url.pathname.includes('/ws'))report.failedRequests.push({path:url.pathname,error:request.failure()?.errorText});});
  page.on('websocket',socket=>socket.on('framereceived',frame=>{try{const message=JSON.parse(String(frame.payload));if(message.type==='snapshot')latest=message;if(message.type==='notice')notices.push(message.message);}catch{}}));
  stage='login';await page.goto(base);await page.locator('#username').fill(username);await page.locator('#password').fill(password);await page.locator('#login-button').click();
  await eventually(()=>latest?.mapId===42,'UI login');await page.locator('#welcome').waitFor({state:'hidden'});
  assert.equal(latest.devTools,false);assert.equal(await page.locator('#dev-section').isVisible(),false);mark('UI login with development controls disabled');

  stage='titles';await page.locator('#titles-button').click();await page.getByRole('button',{name:'装备',exact:true}).click();
  await eventually(()=>latest.self.profile.equippedTitle==='meteor','title equipped');assert.equal((await store.loadProfile(account.id)).equippedTitle,'meteor');
  await panelFits();await capture('desktop-title-active-toast');await page.setViewportSize(report.mobile);await panelFits();await mobileToastFits();await capture('mobile-title-active-toast');await capture('mobile-title');await page.setViewportSize(report.desktop);await capture('desktop-title');mark('title equipped through UI and persisted; desktop/mobile layout fits');
  await closePanel();

  stage='shop';await page.locator('#interact-button').click();await page.getByRole('heading',{name:'商店',exact:true}).waitFor();
  const buy=page.locator('.item-row').filter({has:page.getByRole('spinbutton',{name:'购买面包数量',exact:true})});
  await buy.getByRole('spinbutton').fill('2');await buy.getByRole('button',{name:'购买',exact:true}).click();await eventually(()=>latest.self.gold===180&&quantity('item',102)===2,'buy two bread');
  const sell=page.locator('.item-row').filter({has:page.getByRole('spinbutton',{name:'出售面包数量',exact:true})});
  await sell.getByRole('spinbutton').fill('1');await sell.getByRole('button',{name:'出售',exact:true}).click();await eventually(()=>latest.self.gold===185&&quantity('item',102)===1,'sell one bread');
  const durable=await store.loadPlayer(account.id);assert.equal(durable.state.gold,185);assert.equal(durable.state.inventory.find(i=>i.kind==='item'&&i.itemId===102).quantity,1);
  await page.locator('.panel').evaluate(el=>el.scrollTop=0);await panelFits();await capture('desktop-shop-active-toast');await page.setViewportSize(report.mobile);await panelFits();await mobileToastFits();await capture('mobile-shop-active-toast');await capture('mobile-shop');await page.setViewportSize(report.desktop);await capture('desktop-shop');mark('buy two and sell one through shop UI: 200 → 180 → 185 G; one bread persisted');
  await closePanel();

  stage='empty-records';await page.locator('#records-button').click();await page.getByText('尚无行动记录。前往榆风广场的远征接引员开始探索。',{exact:true}).waitFor();await capture('desktop-records-empty');await closePanel();mark('empty action archive displayed');

  stage='adventure';const entrance=PUBLIC_CITY_SERVICES.instance;await transfer(entrance.mapId,entrance.x,entrance.y+1);
  await page.locator('#interact-button').click();await page.getByRole('button',{name:'开始准备单人冒险',exact:true}).click();await eventually(()=>latest.instance?.definitionId==='meteor-recovery'&&latest.instance.status==='waiting','solo preparation');
  await closePanel();await page.locator('#inventory-button').click();assert.equal(quantity('weapon',65),0);assert.equal(quantity('item',102),2);assert.equal(quantity('item',103),2);assert.equal(latest.self.gold,0);assert.equal(player().level,1);assert.equal(latest.self.equips.armor,121);
  await capture('desktop-adventure-loadout');await closePanel();await page.locator('#instance-button').click();await page.getByRole('button',{name:'开始副本',exact:true}).click();await eventually(()=>latest.instance?.status==='active','solo started');await closePanel();
  const round=app.host.locations.get(account.id);await eventually(()=>latest.hazards?.some(h=>h.kind==='meteor'),'first five-second nine-cell warning',8000);
  const warning=latest.hazards.find(h=>h.kind==='meteor');assert.equal(warning.radius,1);assert.equal(warning.impactAt-warning.startedAt,1000);assert.ok(warning.startedAt-round.startedAt>=5000&&warning.startedAt-round.startedAt<5200);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await capture('desktop-meteor-warning');
  // Return to a real indoor shelter immediately after capturing the live warning.
  await transfer(55,11,17);assert.equal(player().dead,false);await leaveRound();mark('solo selection, LV1 loadout and live 3×3 one-second warning; returned without local loot');
  assert.equal(latest.self.gold,185);assert.equal(quantity('item',102),1);

  stage='title-weapon';await page.locator('#interact-button').click();await page.getByRole('button',{name:'创建 PvE 副本',exact:true}).click();await eventually(()=>latest.instance?.definitionId==='rural-lockdown'&&latest.instance.status==='waiting','DTS preparation');
  assert.equal(quantity('weapon',65),1);await page.getByRole('button',{name:'开始副本',exact:true}).click();await eventually(()=>latest.instance?.status==='active','DTS started');await closePanel();
  assert.deepEqual([latest.mapId,player().x,player().y],[11,18,22],'DTS uses the authored open-ground spawn without relocation');
  await page.locator('#inventory-button').click();const weapon=page.locator('.item-row').filter({has:page.getByText('飞火流星',{exact:true})});await weapon.getByRole('button',{name:'装备',exact:true}).click();await eventually(()=>latest.self.equips.weapon===65,'meteor weapon equipped');await capture('desktop-meteor-equipped');await closePanel();
  const mp=player().mp;assert.ok(mp>0);await page.locator('#attack-button').click();await eventually(()=>latest.hazards?.some(h=>h.kind==='meteor-channel')&&player().mp===0,'UI meteor channel');const channel=latest.hazards.find(h=>h.kind==='meteor-channel');assert.equal(channel.impactAt-channel.startedAt,10000);await capture('desktop-meteor-channel');
  await transfer(11,22,22);await capture('desktop-meteor-channel-under-roof');
  await transfer(12,8,14);await eventually(()=>!latest.hazards?.some(h=>h.kind==='meteor-channel')&&player().mp===0,'indoor channel cancellation');
  assert.equal(app.host.playerWorld(account.id).hazards.channels.size,0);await eventually(()=>notices.some(n=>/飞火流星已取消.*室内/.test(n)),'cancellation notice');await capture('desktop-meteor-cancelled');mark(`weapon UI starts a ten-second channel, consumes ${mp} MP, and indoor transfer cancels without refund`);
  await leaveRound();

  stage='records';await page.locator('#records-button').click();await eventually(async()=>await page.locator('#panel-content .item-row').count()===2,'two action records');await page.setViewportSize(report.mobile);await panelFits();await mobileToastFits();await capture('mobile-records-active-toast');await capture('mobile-records');await page.setViewportSize(report.desktop);await capture('desktop-records');
  assert.equal((await store.listPlayerRecords(account.id)).length,2);assert.deepEqual(report.pageErrors,[]);mark('both departures appear in action archive; zero browser page errors');report.success=true;
}catch(error){report.success=false;report.failure={stage,message:error.message};if(page)await capture(`failure-${stage}`).catch(()=>{});process.exitCode=1;console.error(`UI verification failed at ${stage}: ${error.message}`);
}finally{
  const cleanupErrors=[];
  try{if(browser)await browser.close();}catch(error){cleanupErrors.push(error.message);}
  try{if(app){await eventually(()=>[...app.host.players.values()].every(p=>!p._connected&&!p._disconnecting),'final disconnect',10000).catch(()=>{});await app.close();}else await store.close();}catch(error){cleanupErrors.push(error.message);}
  // Only this script's freshly generated, strictly checked schema may be dropped.
  assert.match(schema,/^spaceship_engine_test_beta_ui_[0-9a-f]{12}$/);const cleanup=await mysql.createConnection(connection);
  try{await cleanup.query(`DROP DATABASE IF EXISTS \`${schema}\``);report.temporarySchemaRemoved=true;}finally{await cleanup.end();}
  if(cleanupErrors.length){report.cleanupErrors=cleanupErrors;report.success=false;process.exitCode=1;}
  await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({success:report.success,checks:report.checks.length,screenshots:report.screenshots.length,pageErrors:report.pageErrors,temporarySchemaRemoved:report.temporarySchemaRemoved,output}));
}
