import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {parseRichText,richTextDefaults,evaluateTextExpression,renderRichText,applyMessageLayout,loadCustomFonts} from './rich-text.mjs';

const context={variables:{1:7,2:1},switches:{3:true},actors:{1:{name:'小舟',nickname:'旅人',classId:2,faceName:'Actor1',faceIndex:3,level:4,hp:70,mhp:100,mp:8,mmp:20,tp:25,mtp:100,atk:12,def:9,mat:7,mdf:8,agi:4,luk:3,hit:0.95,eva:0.05,cri:0.1,cev:0,mev:0,mrf:0,cnt:0,hrg:0,mrg:0,trg:0,tgr:1,grd:1,rec:1,pha:1,mcr:1,tcr:1,pdr:1,mdr:1,fdr:1,exr:1}},party:[1],inventory:[{kind:'item',itemId:1,quantity:7},{kind:'weapon',itemId:1,quantity:2},{kind:'armor',itemId:1,quantity:3}],enemies:[{name:'蝙蝠',hp:15,mhp:30,level:2,exp:1200,gold:40}],mapId:5,playtime:3661,gold:200,currencyUnit:'金币',database:{Classes:{2:{name:'战士'}},Items:{1:{name:'药水',iconIndex:64}},Weapons:{1:{name:'剑',iconIndex:80}},Armors:{1:{name:'盾',iconIndex:81}},Skills:{1:{name:'火焰',iconIndex:82}},States:{1:{name:'睡眠',iconIndex:83}},Enemies:{1:{name:'恶魔'}},MapInfos:{5:{name:'城市'}}}};
const textTokens=result=>result.tokens.filter(token=>token.type==='text');

test('core data and nested variables resolve while escaped slashes remain literal',()=>{
  const result=parseRichText(String.raw`\V[1] \N[\V[2]] \P[1] \G \\C[2] \ac[1] \an[1] \pc[1] \pn[1]`,context);
  assert.equal(result.plainText,'7 小舟 小舟 金币 \\C[2] 战士 旅人 战士 旅人');assert.deepEqual(result.diagnostics,[]);
});

test('names, faces, all database names and icons',()=>{
  const result=parseRichText(String.raw`\ndc<\N[1]>\af[1]\faceindex[6]\nc[2]/\ni[1]/\nw[1]/\na[1]/\ns[1]/\nt[1]/\ii[1]/\iw[1]/\ia[1]/\is[1]/\it[1]`,context);
  assert.equal(result.meta.name,'小舟');assert.equal(result.meta.nameAlign,'center');assert.equal(result.meta.nameBackground,1);assert.equal(result.meta.faceName,'Actor1');assert.equal(result.meta.faceIndex,6);
  assert.equal(result.plainText,'战士/药水/剑/盾/火焰/睡眠/药水/剑/盾/火焰/睡眠');assert.deepEqual(result.tokens.filter(t=>t.type==='icon').map(t=>t.index),[64,80,81,82,83]);assert.deepEqual(result.diagnostics,[]);
});

test('font controls snapshot styling and reset without mutating preceding text',()=>{
  const result=parseRichText(String.raw`\c[2]\fb\fi\fs[40]\fn<Pixel>甲\hc[00ff00]\oc[3]\ow[2]\{乙\}\fr丙`,context);
  const [a,b,c]=textTokens(result);assert.equal(a.style.color,'#ff784c');assert.equal(a.style.fontSize,40);assert.equal(a.style.fontFace,'Pixel');assert.equal(a.style.bold,true);assert.equal(a.style.italic,true);assert.equal(b.style.fontSize,52);assert.equal(b.style.color,'#00ff00');assert.equal(b.style.outlineWidth,2);assert.equal(c.style.fontSize,28);assert.equal(c.style.bold,false);assert.deepEqual(result.diagnostics,[]);
});

test('extended quantities, actor rates and zero-based enemy stats match plugin semantics',()=>{
  const result=parseRichText(String.raw`\qi[1]/\qw[1]/\qa[1] \alvl[1]/\ahp[1]/\amhp[1]/\ahp%[1]/\amp%[1]/\atp%[1]/\ahit[1] \en[1]/\et[1]/\ehp[0]/\ehp%[0]/\eexp[0]`,context);
  assert.equal(result.plainText,'7/2/3 4/70/100/70%/40%/25%/95% 恶魔/蝙蝠/15/50%/1,200');assert.deepEqual(result.diagnostics,[]);
  for(const key of ['mhp','mmp','atk','def','mat','mdf','agi','luk','hit','eva','cri','cev','mev','mrf','cnt','hrg','mrg','trg','tgr','grd','rec','pha','mcr','tcr','pdr','mdr','fdr','exr'])assert.equal(parseRichText(`\\a${key}[1]`,context).diagnostics.length,0,key);
});

test('safe conditionals and comparisons preserve nested text styling',()=>{
  const result=parseRichText(String.raw`\caseSwitch{3?\C[3]是:否}\caseEval{$gameVariables.value(1) >= 7 && $gameActors.actor(1).hp > 0?活着:死了}\compare<\V[1]:10>不足\compare3<10:7>足够`,context);
  assert.equal(result.plainText,'是活着不足足够');assert.equal(textTokens(result).at(-2).style.color,'#c08080');assert.equal(textTokens(result).at(-1).style.color,'#66cc40');assert.deepEqual(result.diagnostics,[]);
  assert.equal(evaluateTextExpression('!(s[2]) && (v[1] * 2 + 1) === 15',context),true);
  assert.equal(evaluateTextExpression('$gameParty.gold() / 2',context),100);
  assert.equal(parseRichText(String.raw`\caseSwitch{3?I'm ready:no}`,context).plainText,"I'm ready");
  assert.equal(parseRichText(String.raw`\caseEval{'a' == 'a'?he's ready:no}`,context).plainText,"he's ready");
  assert.throws(()=>evaluateTextExpression('globalThis.process.exit()',context),/Unsupported/);
  assert.throws(()=>evaluateTextExpression('$gameActors.actor(1).constructor()',context),/Unsupported/);
  assert.throws(()=>evaluateTextExpression('1 / 0',context),/Invalid/);
});

test('malformed and unsupported controls remain visible with explicit diagnostics',()=>{
  const result=parseRichText(String.raw`\unknown[1] \hc[bad] \caseEval{process.exit()?好:坏} \ahp[99] \C[`,context);
  assert.equal(result.diagnostics.length,5);assert.match(result.plainText,/\\unknown\[1\]/);assert.match(result.plainText,/process.exit/);assert.match(result.plainText,/\\C\[$/);
  assert.equal(parseRichText(String.raw`<img src=x onerror=alert(1)>`,context).plainText,'<img src=x onerror=alert(1)>');
});

test('extended message positioning, wrapping, timers and utilities',()=>{
  const result=parseRichText(String.raw`<WordWrap>\autoevent[4]\msgposx[100]\msgposy[200]\msgrows[6]\msgwidth[320]\px[30]\py[20]\dg[12345] \map[0] \playtime<br>下一行\.\|\w[30]\!\>快\<慢\^\$`,context,{wordWrapSpace:true,faceName:'Actor2',background:1,positionType:0});
  assert.equal(result.meta.width,320);assert.equal(result.meta.rows,6);assert.equal(result.meta.x,100);assert.equal(result.meta.y,200);assert.equal(result.meta.wordWrap,true);assert.equal(result.meta.autoClose,true);assert.deepEqual(result.meta.target,{kind:'event',id:4});assert.equal(result.meta.background,1);assert.equal(result.meta.position,0);assert.equal(result.meta.faceName,'Actor2');assert.match(result.plainText,/12,345 城市 01:01:01\n下一行/);assert.deepEqual(result.tokens.filter(t=>t.type==='wait').map(t=>t.milliseconds),[250,1000,500]);assert.deepEqual(result.diagnostics,[]);
  assert.equal(parseRichText('甲\n乙<br>丙',context,{wordWrap:true,wordWrapSpace:true}).plainText,'甲 乙\n丙');
});

test('all shaking forms and letter sound controls are retained per glyph run',()=>{
  const result=parseRichText(String.raw`\lson\lsn<Cursor2>\lsv[70]\lspi[110]\lspiv[5]\lspa[-20]\lspav[2]\lsi[3]\Shake<1,2,3,4>摇\Wave<.5,6>波\Slide<1,5>滑\Circle圆\ResetShake静\lsoff无声`,context);
  // The original shaking plugin recognizes these names without ASCII delimiters.
  assert.equal(result.diagnostics.length,0);const [a,b,c,d,e,f]=textTokens(result);assert.deepEqual(a.style.effect,{kind:'shake',xSpeed:1,ySpeed:2,xMax:3,yMax:4});assert.equal(a.sound.name,'Cursor2');assert.equal(a.sound.pan,-20);assert.equal(b.style.effect.kind,'wave');assert.equal(c.style.effect.kind,'slide');assert.equal(d.style.effect.kind,'circle');assert.equal(e.style.effect,null);assert.equal(f.sound.enabled,false);
});

test('letter sound reset uses plugin defaults instead of carried previous-message state',()=>{
  const pluginSound=richTextDefaults().letterSound;
  for(const command of ['LSReset','LSR']){
    const parsed=parseRichText(`甲\\${command}乙`,context,{letterSound:{...pluginSound,enabled:true,name:'Previous'},resetLetterSound:pluginSound});
    const [before,after]=textTokens(parsed);assert.equal(before.sound.enabled,true);assert.equal(before.sound.name,'Previous');assert.deepEqual(after.sound,pluginSound);assert.deepEqual(parsed.finalSound,pluginSound);
  }
});

class FakeElement {
  constructor(document,tag='div'){this.ownerDocument=document;this.tagName=tag;this.children=[];this.style={};this.dataset={};this.attributes={};this.textContent='';this.classes=new Set();this.classList={add:(...names)=>names.forEach(n=>this.classes.add(n)),remove:(...names)=>names.forEach(n=>this.classes.delete(n))};}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];this.textContent='';}
  setAttribute(key,value){this.attributes[key]=value;}
  animate(){const handle={cancelled:false,cancel(){this.cancelled=true;}};this.ownerDocument.animations.push(handle);return handle;}
}
const fakeDocument=()=>{const doc={animations:[]};doc.createElement=tag=>new FakeElement(doc,tag);return doc;};
const domText=element=>element.textContent+element.children.map(domText).join('');
function clock(){const tasks=new Map();let index=0;return {schedule:(fn,delay)=>{tasks.set(++index,{fn,delay});return index;},cancel:id=>tasks.delete(id),next:()=>{const [id,task]=tasks.entries().next().value||[];if(task){tasks.delete(id);task.fn();return task.delay;}return null;},tasks};}

test('progressive renderer honors waits, input pause, page clearing and completion',()=>{
  const doc=fakeDocument(),element=doc.createElement('div'),time=clock();let completed=0;
  const parsed=parseRichText('甲\\w[30]乙\\!丙\f丁');
  const controller=renderRichText(element,parsed,{...time,charDelay:20,onComplete:()=>completed++});
  assert.equal(time.next(),0);assert.equal(domText(element),'甲');assert.equal(time.next(),20);assert.equal(time.next(),500);assert.equal(domText(element),'甲乙');time.next();assert.equal(controller.paused,true);assert.equal(controller.done,false);controller.advance();assert.equal(domText(element),'甲乙丙');time.next();assert.equal(controller.paused,true);controller.advance();assert.equal(domText(element),'丁');time.next();assert.equal(controller.done,true);assert.equal(completed,1);assert.equal(controller.advance(),false);controller.destroy();assert.equal(time.tasks.size,0);
});

test('reveal stops at mandatory pause and destruction cancels all timers and animations',()=>{
  const doc=fakeDocument(),element=doc.createElement('div'),time=clock();let completed=0;
  const controller=renderRichText(element,String.raw`\Wave你好\!后文`,{...time,onComplete:()=>completed++});
  controller.advance();assert.equal(domText(element),'你好');assert.equal(controller.paused,true);assert.equal(time.tasks.size,0);assert.equal(doc.animations.length,2);controller.destroy();assert.ok(doc.animations.every(a=>a.cancelled));assert.equal(controller.advance(),false);assert.equal(completed,0);
});

test('row pagination and disabled fast-forward retain every authored line',()=>{
  const doc=fakeDocument(),element=doc.createElement('div'),time=clock();
  const parsed=parseRichText('一\n二\n三',{}, {rows:2,fastForward:false});assert.equal(parsed.plainText,'一\n二\n三');assert.equal(parsed.tokens.filter(t=>t.type==='page').length,1);
  const controller=renderRichText(element,parsed,{...time});assert.equal(controller.advance(),true);assert.equal(domText(element),'');time.next();time.next();time.next();assert.equal(controller.paused,true);assert.equal(domText(element),'一二');controller.advance();assert.equal(domText(element),'三');time.next();assert.equal(controller.done,true);controller.destroy();
});

test('instant render uses textContent and never turns HTML into elements',()=>{
  const doc=fakeDocument(),element=doc.createElement('div');const result=renderRichText(element,'<img onerror=evil>\\!安全',{instant:true});
  assert.equal(result.done,true);assert.equal(domText(element),'<img onerror=evil>安全');assert.ok(element.children[0].children.every(child=>child.tagName==='span'));result.destroy();
});

test('message layout resets prior coordinates and renders face atlas cells',()=>{
  const doc=fakeDocument(),element=doc.createElement('div'),face=doc.createElement('div'),speaker=doc.createElement('div');
  applyMessageLayout(element,parseRichText(String.raw`\n<店主>\af[1]\autoevent[4]`,context).meta,{faceElement:face,speakerElement:speaker,resolveTarget:()=>({x:300,y:200})});
  assert.equal(element.style.left,'300px');assert.equal(element.style.top,'200px');assert.equal(element.style.width,'max-content');assert.equal(face.style.backgroundPosition,'calc(var(--mv-face-size, 144px) * -3) calc(var(--mv-face-size, 144px) * 0)');assert.equal(domText(speaker),'店主');
  applyMessageLayout(element,{faceName:'Actor1',faceIndex:7},{faceElement:face});assert.equal(face.style.backgroundPosition,'calc(var(--mv-face-size, 144px) * -3) calc(var(--mv-face-size, 144px) * -1)');
  applyMessageLayout(element,parseRichText('默认').meta,{faceElement:face});assert.equal(element.style.left,'');assert.equal(element.style.top,'');assert.equal(face.hidden,true);
  applyMessageLayout(element,{position:1,anchorX:.5,anchorY:1});assert.equal(element.style.transform,'translate(-50%,-50%)');
  applyMessageLayout(element,{position:0,x:300,y:200,anchorX:.5,anchorY:1});assert.equal(element.style.transform,'translate(-50%,-100%)');
  applyMessageLayout(element,parseRichText(String.raw`\nt4<旁白>`).meta,{speakerElement:speaker});assert.equal(speaker.style.left,'75%');assert.equal(speaker.style.transform,'translateX(-75%)');assert.equal(speaker.dataset.background,'2');
});

test('custom fonts load exact family/file pairs and report missing or unsafe files',async()=>{
  const added=[];class Font{constructor(family,url){this.family=family;this.url=url;}async load(){if(this.family==='Missing')throw new Error('404');return this;}}
  const result=await loadCustomFonts({'Font Filenames':'字.ttf,missing.ttf,../bad.ttf','Font Families':'Pixel,Missing,Bad'},{FontFace:Font,document:{fonts:{add:font=>added.push(font)}}});
  assert.equal(result[0].loaded,true);assert.equal(added.length,1);assert.match(added[0].url,/%E5%AD%97.ttf/);assert.equal(result[1].error,'404');assert.match(result[2].error,/within fonts/);
  const defaults=richTextDefaults({messageCore:{'Font Size':'32','Word Wrapping':'true'},extended1:{'Enable Sound':'false'}});assert.equal(defaults.fontSize,32);assert.equal(defaults.wordWrap,true);assert.equal(defaults.letterSound.enabled,false);
});

test('all current map and common-event Show Text lines survive imported content parsing',async()=>{
  const {loadContent}=await import('../server/content.mjs');
  const content=await loadContent(fileURLToPath(new URL('../../',import.meta.url)));
  const actualContext={...context,database:{...content.database,MapInfos:content.mapInfos},actors:content.database.Actors,party:content.database.System.partyMembers};
  const defaults=richTextDefaults(content.textConfig);let count=0;
  const lists=[...[...content.maps].flatMap(([mapId,map])=>map.events.filter(Boolean).flatMap(event=>event.pages.map((page,pageIndex)=>({location:`Map${mapId}/event${event.id}/page${pageIndex+1}`,list:page.list})))),...content.database.CommonEvents.filter(Boolean).map(event=>({location:`CommonEvents/${event.id}`,list:event.list}))];
  for(const {location,list} of lists)for(const [index,command] of list.entries())if(command.code===401){
    const source=command.parameters[0],parsed=parseRichText(source,actualContext,defaults);count++;
    assert.deepEqual(parsed.diagnostics,[],`${location}/command${index}: ${source}`);
    // Existing lines currently contain plain text. As controls are authored the
    // diagnostics assertion above remains, while this checks lossless plain text.
    if(!/[\\\x1b\f]/.test(source)&&!/<(?:WordWrap|br|line break)>/i.test(source))assert.equal(parsed.plainText,source,`${location}/command${index}`);
  }
  assert.ok(count>0,'Must inspect real authored Show Text commands');
});
