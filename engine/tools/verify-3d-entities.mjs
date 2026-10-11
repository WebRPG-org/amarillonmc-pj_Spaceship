import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createApplication} from '../server/index.mjs';

// Regression: copied events retain unique network identity even when they share
// an editor eventId, including source comments, lights, page changes and @s cues.
const root=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
const output=path.join(root,'engine/.artifacts/3d');await fs.mkdir(output,{recursive:true});
const store={async init(){throw Error('Presentation entity fixture');},async close(){},async listDrops(){return[];}};
const app=await createApplication({projectRoot:root,store});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'C:/Users/mapodoufu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
let browser;const report={versions:[]};
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--enable-unsafe-swiftshader']});
  for(const plugin of ['mv3d','mz3d']){
    const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/client/app.mjs',route=>route.fulfill({contentType:'text/javascript',body:''}));
    await page.goto('http://127.0.0.1:'+app.server.address().port);
    await page.evaluate(async plugin=>{
      document.body.innerHTML='<canvas id="fixture" style="width:816px;height:624px"></canvas>';
      const [{Renderer},{snapshotPreview},content,map]=await Promise.all([import('/client/renderer.mjs'),import('/client/tile-format.mjs'),fetch('/api/content').then(r=>r.json()),fetch('/api/maps/49').then(r=>r.json())]);
      map.threeD.pluginName=plugin;window.qa={renderer:new Renderer(document.getElementById('fixture'))};
      const snapshot=snapshotPreview(map,map.id),native={...snapshot.events.find(e=>e.eventId===1),id:'map:49:event:1',sourceMapId:49,x:10,y:12};
      const a={...native,id:'map:49:event:1:clone-a',x:12,y:12},b={...native,id:'map:49:event:1:clone-b',x:14,y:12};
      const foreign={...native,id:'map:49:event:1:foreign',sourceMapId:999,x:16,y:12,pageIndex:3,
        threeDSource:{note:'<mv3d:lamp(#ff00ff,1.5,4),z(3)>',page:{...map.events[1].pages[0],list:[{code:108,parameters:['<mv3d:scale(0.7)>']},{code:0,parameters:[]}]}}};
      snapshot.events=[native,a,b,foreign];qa.snapshot=snapshot;
      qa.renderer.setMap(map,content.database.Tilesets[map.tilesetId],content.database,content.threeD);
      qa.renderer.accept(snapshot);
    },plugin);
    await page.waitForFunction(()=>['ready','error'].includes(qa.renderer.threeD.status),null,{timeout:60000});
    assert.equal(await page.evaluate(()=>qa.renderer.threeD.status),'ready',await page.evaluate(()=>qa.renderer.threeD.error));
    await page.waitForFunction(()=>{const m=qa.renderer.threeD.frame.contentWindow.mv3d;return m.scene.isReady()&&m.characters.filter(s=>s.char._hostEntityId).length===4;});
    const initial=await page.evaluate(()=>qa.renderer.threeD.frame.contentWindow.mv3d.characters.filter(s=>s.char._hostEntityId).map(s=>({id:s.char._hostEntityId,slot:s.char._eventId,x:s.char._realX,y:s.char._realY,z:s.char.z,lamp:!!s.lamp,page:s.char._pageIndex,scale:s.getConfig('scale')?.x})));
    assert.equal(new Set(initial.map(e=>e.slot)).size,4,'Each entity must own a different Game_Event');
    assert.deepEqual(initial.map(e=>e.x).sort((a,b)=>a-b),[10,12,14,16]);
    const foreign=initial.find(e=>e.id.endsWith(':foreign'));assert.equal(foreign.lamp,true);assert.equal(foreign.scale,.7);assert.equal(foreign.page,0);assert.equal(foreign.z,3);
    await page.evaluate(()=>qa.renderer.threeD.host.command({eventId:1,entityId:'map:49:event:1:clone-b',command:'@s lamp #00ff00 2 4 0'}));
    const targeted=await page.evaluate(()=>qa.renderer.threeD.frame.contentWindow.mv3d.characters.filter(s=>s.char._hostEntityId).map(s=>({id:s.char._hostEntityId,lamp:!!s.lamp,intensity:s.blendLampIntensity?.targetValue()})));
    assert.equal(targeted.find(e=>e.id==='map:49:event:1').lamp,false,'@s must not affect original source event');
    assert.equal(targeted.find(e=>e.id.endsWith(':clone-a')).lamp,false,'@s must not affect another clone');
    assert.equal(targeted.find(e=>e.id.endsWith(':clone-b')).intensity,2);
    await page.evaluate(()=>{
      const snapshot=structuredClone(qa.snapshot);snapshot.events=snapshot.events.filter(e=>!e.id.endsWith(':clone-a'));
      const foreign=snapshot.events.find(e=>e.id.endsWith(':foreign'));foreign.pageIndex=4;foreign.threeDSource.page.list=[{code:108,parameters:['<mv3d:scale(1.3)>']},{code:0,parameters:[]}];
      qa.renderer.entities.clear();qa.renderer.accept(snapshot);
    });
    await page.waitForFunction(()=>{const m=qa.renderer.threeD.frame.contentWindow.mv3d;return m.characters.filter(s=>s.char._hostEntityId).length===3&&m.characters.find(s=>s.char._hostEntityId?.endsWith(':foreign'))?.getConfig('scale')?.x===1.3;});
    assert.equal(await page.evaluate(slot=>qa.renderer.threeD.frame.contentWindow.$gameMap._events[slot]===null,initial.find(e=>e.id.endsWith(':clone-a')).slot),true,'Removed clone releases its dynamic slot');
    await page.evaluate(()=>{
      const snapshot=structuredClone(qa.renderer.snapshot),foreign=snapshot.events.find(e=>e.id.endsWith(':foreign'));
      foreign.pageIndex=-1;foreign.erased=true;foreign.threeDSource.page=null;qa.renderer.accept(snapshot);
    });
    await page.waitForFunction(()=>!qa.renderer.threeD.frame.contentWindow.mv3d.characters.some(s=>s.char._hostEntityId?.endsWith(':foreign')));
    await page.evaluate(()=>{
      const snapshot=structuredClone(qa.renderer.snapshot),foreign=snapshot.events.find(e=>e.id.endsWith(':foreign'));
      Object.assign(foreign,structuredClone(qa.snapshot.events.find(e=>e.id.endsWith(':foreign'))),{erased:false});qa.renderer.accept(snapshot);
    });
    await page.waitForFunction(()=>qa.renderer.threeD.frame.contentWindow.mv3d.characters.some(s=>s.char._hostEntityId?.endsWith(':foreign')&&s.lamp&&s.getConfig('scale')?.x===.7));
    const elevation=await page.evaluate(()=>{
      const renderer=qa.renderer,w=renderer.threeD.frame.contentWindow,host=w.threeDHost,snapshot=structuredClone(renderer.snapshot);
      renderer.draw=()=>{};snapshot.playerId='position-player';
      const player={id:snapshot.playerId,x:9,y:18,direction:2,characterName:'People1',characterIndex:0};
      const at=(x,y)=>{player.x=x;player.y=y;host.update({entities:[...snapshot.events,player],snapshot});return {x,y,z:w.$gamePlayer.z,walkHeight:w.mv3d.getWalkHeight(x,y)};};
      const first=at(9,18),teleport=at(18,5);
      const remote={...player,id:'remote-player',x:9,y:18};host.update({entities:[...snapshot.events,player,remote],snapshot});
      return {first,teleport,remoteZ:w.mv3d.characters.find(s=>s.char._hostEntityId==='remote-player').char.z,authoredEventZ:w.mv3d.characters.find(s=>s.char._hostEntityId?.endsWith(':foreign')).char.z};
    });
    assert.equal(elevation.first.z,elevation.first.walkHeight,'First real player frame must start on the destination floor');
    assert.equal(elevation.teleport.z,elevation.teleport.walkHeight,'Teleport must start on the destination floor');
    assert.equal(elevation.remoteZ,0);assert.equal(elevation.authoredEventZ,3,'Authored event z must survive snapshot synchronization');
    assert.deepEqual(errors,[]);
    report.versions.push({plugin,initial,targeted,pageChangeScale:1.3,removedCloneReleased:true,inactivePageAndRestore:true,elevation});
    await page.close();console.log(plugin+' unique cloned-event rendering passed');
  }
}finally{
  await fs.writeFile(path.join(output,'entity-verification.json'),JSON.stringify(report,null,2)+'\n');
  await browser?.close();await app.close();
}
