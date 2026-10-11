import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createApplication} from '../server/index.mjs';

// Real browser/WebGL verification, no account or database mutations.
const root=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
const sample=process.env.SAMPLE_3D;
const output=path.join(root,'engine/.artifacts/3d',sample?'samples-'+(process.env.PLUGIN_3D||'mv3d'):process.env.PLUGIN_3D==='mz3d'?'mz3d':'');
await fs.mkdir(output,{recursive:true});
const store={async init(){throw Object.assign(new Error('Preview verification'),{code:'PREVIEW_ONLY'});},async close(){},async listDrops(){return[];}};
const app=await createApplication({projectRoot:sample||root,store});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${app.server.address().port}`;
const modulePath=process.env.PLAYWRIGHT_MODULE || 'C:/Users/mapodoufu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(pathToFileURL(modulePath).href);
let browser;
const report={maps:[],errors:[],failedRequests:[],optionalProbes:[]};
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.route('**/client/app.mjs',route=>route.fulfill({contentType:'text/javascript',body:'// Dedicated rendering fixture.'}));
  page.on('pageerror',error=>{report.errors.push(error.stack||error.message);console.error(error.message);});
  page.on('response',response=>{if(response.status()>=400){const entry={url:response.url().replace(base,''),status:response.status()};
    if(response.request().method()==='HEAD'&&response.status()===404)report.optionalProbes.push(entry);else report.failedRequests.push(entry);}});
  await page.goto(base);
  // Reuse HTTP, modules and renderer in a deterministic full viewport fixture.
  await page.evaluate(async()=>{
    document.body.innerHTML='<canvas id="fixture" style="width:816px;height:624px"></canvas>';
    document.body.style.cssText='margin:0;background:#172120';
    const [{Renderer},{snapshotPreview},content]=await Promise.all([import('/client/renderer.mjs'),import('/client/tile-format.mjs'),fetch('/api/content').then(r=>r.json())]);
    window.qa={renderer:new Renderer(document.getElementById('fixture')),snapshotPreview,content};
    window.qa.load=async(id,pluginName,forceMode)=>{
      const map=await fetch(`/api/maps/${id}`).then(r=>r.json());
      if(pluginName)map.threeD.pluginName=pluginName;
      if(forceMode){map.threeD.enabled=forceMode==='3d';map.note+=`\n<mv3d>enable(${map.threeD.enabled})</mv3d>`;}
      qa.renderer.setMap(map,qa.content.database.Tilesets[map.tilesetId],qa.content.database,qa.content.threeD);
      qa.renderer.accept(qa.snapshotPreview(map,id));
    };
  });
  const requested=(process.env.MAPS_3D || '49,50,51,6').split(',').map(Number);
  for(const id of requested){
    await page.evaluate(({id,plugin,forceMode})=>qa.load(id,plugin,forceMode),{id,plugin:process.env.PLUGIN_3D,forceMode:sample?'3d':null});
    await page.waitForFunction(()=>['ready','error'].includes(qa.renderer.threeD.status),null,{timeout:60000});
    assert.equal(await page.evaluate(()=>qa.renderer.threeD.status),'ready',await page.evaluate(()=>qa.renderer.threeD.frame?.contentWindow.threeDHost?.error?.stack || qa.renderer.threeD.error));
    await page.waitForFunction(()=>{
      const m=qa.renderer.threeD.frame?.contentWindow.mv3d;
      return m?.mapReady && !m.mapUpdating && m.scene.isReady();
    },null,{timeout:60000});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const data=await page.evaluate(()=>{
      const r=qa.renderer,m=r.threeD.frame.contentWindow.mv3d;
      const center=m.getCameraTarget?.();
      const p=r.threeD.project(r.viewCenter.x,r.viewCenter.y);
      const picked=p&&r.threeD.pick(p.x,p.y);
      return {id:r.map.id,status:r.threeD.status,plugin:m.pluginName,width:r.map.width,height:r.map.height,
        meshes:m.scene.meshes.length,materials:m.scene.materials.length,lights:m.scene.lights.length,
        config:m.mapConfigurations,camera:{x:m.cameraStick.x,y:m.cameraStick.y,pitch:m.blendCameraPitch.currentValue(),yaw:m.blendCameraYaw.currentValue(),distance:m.blendCameraDist.currentValue()},
        center: center?{x:center.x,y:center.y}:null,projected:p,picked,missing:[...r.images.missing],frames:m.scene.getFrameId()};
    });
    assert.ok(data.meshes>0,`Map${id} must produce geometry`);
    assert.ok(data.frames>0,`Map${id} must render frames`);
    await page.locator('#fixture').screenshot({path:path.join(output,`Map${String(id).padStart(3,'0')}-3d.png`)});
    report.maps.push(data);console.log(JSON.stringify({map:id,status:data.status,plugin:data.plugin,meshes:data.meshes,lights:data.lights}));
    if(!sample && id>=49){
      const positions={49:[[9,18],[9,11],[18,5]],50:[[4,13],[11,8],[16,6]],51:[[4,13],[19,6]]}[id];
      data.views=[];
      for(const [index,[x,y]]of positions.entries()){
        await page.evaluate(({x,y})=>{
          const r=qa.renderer,actor=qa.content.database.Actors[1],snapshot=qa.snapshotPreview(r.map,r.map.id);
          snapshot.playerId='qa-player';snapshot.players=[{id:'qa-player',name:'测试角色',x,y,direction:8,
            characterName:actor.characterName,characterIndex:actor.characterIndex,hp:100,maxHp:100}];
          r.entities.clear();r.accept(snapshot);
        },{x,y});
        await page.waitForFunction(()=>{const w=qa.renderer.threeD.frame.contentWindow;return w.mv3d.scene.isReady()&&w.$gamePlayer.mv3d_sprite?.model?.mesh?.isVisible;});
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const view=await page.evaluate(()=>{const w=qa.renderer.threeD.frame.contentWindow,c=w.$gamePlayer,s=c.mv3d_sprite;return{x:c._realX,y:c._realY,z:c.z,renderedZ:s.z,walkHeight:w.mv3d.getWalkHeight(c._realX,c._realY)};});
        data.views.push(view);
        await page.locator('#fixture').screenshot({path:path.join(output,`Map${id}-entry-${index+1}.png`)});
      }
      await page.evaluate(async()=>{await qa.renderer.threeD.command({command:'camera yaw 45 0'});await qa.renderer.threeD.command({command:'camera pitch 65 0'});});
      await page.waitForFunction(()=>qa.renderer.threeD.frame.contentWindow.mv3d.blendCameraYaw.currentValue()===45);
      await page.locator('#fixture').screenshot({path:path.join(output,`Map${id}-orbit.png`)});
      if(id===50){
        await page.evaluate(()=>qa.renderer.threeD.command({command:'@player flashlight white 1.5 6 60 0'}));
        await page.waitForFunction(()=>qa.renderer.threeD.frame.contentWindow.$gamePlayer.mv3d_sprite.flashlight);
        data.flashlight=await page.evaluate(()=>{const s=qa.renderer.threeD.frame.contentWindow.$gamePlayer.mv3d_sprite;return {intensity:s.blendFlashlightIntensity.targetValue(),distance:s.blendFlashlightDistance.targetValue()};});
        assert.equal(data.flashlight.intensity,1.5);assert.equal(data.flashlight.distance,6);
      }
    }
    // Every transition must release the prior iframe and retain the regular 2D path.
    await page.evaluate(({id,sample})=>qa.load(sample?id:40,null,'2d'),{id,sample:!!sample});
    assert.equal(await page.evaluate(()=>qa.renderer.threeD.status),'off');
    assert.equal(await page.locator('iframe').count(),0);
  }
  await page.waitForFunction(()=>[...qa.renderer.images.cache.values()].every(image=>image.complete));
  await page.locator('#fixture').screenshot({path:path.join(output,'Map040-return-2d.png')});
  if(!sample){
    await page.evaluate(()=>qa.load(49,null,'2d'));
    assert.equal(await page.locator('iframe').count(),0);
    await page.evaluate(()=>{
      for(const command of ['camera yaw 90 0','enable 2'])qa.renderer.threeDCommand({mapId:49,instanceId:null,command});
    });
    await page.waitForFunction(()=>['ready','error'].includes(qa.renderer.threeD.status),null,{timeout:60000});
    assert.equal(await page.evaluate(()=>qa.renderer.threeD.status),'ready',await page.evaluate(()=>qa.renderer.threeD.error));
    await page.evaluate(()=>qa.renderer.threeD.commandTail);
    assert.equal(await page.evaluate(()=>qa.renderer.threeD.frame.contentWindow.mv3d.blendCameraYaw.targetValue()),90);
    await page.evaluate(()=>{
      qa.renderer.threeD.command({eventId:1,entityId:'preview-1',command:'@self lamp white 1 3 0'});
      return qa.renderer.threeD.command({eventId:1,entityId:'preview-1',command:'@self configure lamp(black,0,3) 0'});
    });
    await page.waitForFunction(()=>qa.renderer.threeD.frame.contentWindow.$gameMap.event(1).mv3d_sprite.blendLampIntensity.targetValue()===0);
    report.orderedCommands=true;
    await page.evaluate(()=>qa.renderer.threeDCommand({mapId:49,instanceId:null,command:'disable 2'}));
    assert.equal(await page.locator('iframe').count(),0);
    report.dynamicEnableDisable=true;
  }
  assert.deepEqual(report.errors,[],'Browser errors');
  assert.deepEqual(report.failedRequests,[],'Missing HTTP assets');
}finally{
  await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(report,null,2));
  await browser?.close();await app.close();
}
console.log(`3D verification saved in ${output}`);
