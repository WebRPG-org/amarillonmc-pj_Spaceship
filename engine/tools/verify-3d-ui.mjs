import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(fileURLToPath(new URL('../../',import.meta.url))),out=path.join(root,'engine/.artifacts/3d');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'C:/Users/mapodoufu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--enable-unsafe-swiftshader']});
const errors=[];
try{
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(process.env.ENGINE_URL||'http://127.0.0.1:8098');
  await page.locator('#preview-button').click();
  for(const id of [49,50,51]){
    await page.locator('#map-select').selectOption(String(id));await page.locator('#travel-button').click();
    await page.waitForFunction(id=>document.querySelector('#world').dataset.mapId===String(id)&&document.querySelector('#world').dataset.renderMode==='3d-ready',id,{timeout:60000});
    await page.waitForFunction(()=>{const m=document.querySelector('iframe').contentWindow.mv3d;return m.mapReady&&m.scene.isReady();});
    assert.equal(await page.locator('#three-d-controls').isVisible(),true);
    await page.locator('[data-orbit="-45,0"]').click();
    await page.waitForFunction(()=>{const m=document.querySelector('iframe').contentWindow.mv3d;return Math.abs(m.blendCameraYaw.currentValue()-m.blendCameraYaw.targetValue())<.1;});
    await page.locator('#zoom-in').click();
    await page.screenshot({path:path.join(out,`Map${id}-ui.png`)});
    await page.locator('#zoom-out').click();
  }
  await page.locator('#map-select').selectOption('40');await page.locator('#travel-button').click();
  await page.waitForFunction(()=>document.querySelector('#world').dataset.renderMode==='2d');
  assert.equal(await page.locator('iframe').count(),0);
  assert.equal(await page.locator('#three-d-controls').isVisible(),false);
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(out,'ui-verification.json'),JSON.stringify({maps:[49,50,51],cameraButtons:true,zoom:true,return2d:true,errors},null,2));
  console.log('Actual app UI: preview 49/50/51, rotate, zoom and return to 2D passed.');
}finally{await browser.close();}
