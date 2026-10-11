/* A separate window owns all RPG Maker globals. Only MV3D/MZ3D presentation runs.
 * Map event lists are read as data for comments; their interpreter never runs. */
(() => {
  'use strict';
  const characters=new Map(),sprites=new Set(),appearanceUrls=new Map(),appearanceBitmaps=new Map(),appearanceSources=new Map();
  const noop=()=>{},clone=value=>structuredClone(value);
  let loaded=false,disposed=false,kind='mv',parallax=null,lastUpdate=performance.now(),frameTime=performance.now(),hostZoom=1,appearanceSequence=0;
  let initialEventPages=null;
  let animationRemainder=0;
  const host=window.threeDHost={load,update,resize,command,pick,project,projectEntity,dispose,ready:false,error:null,canvas:null};
  function fail(error){if(disposed)return;host.error=error instanceof Error?error:new Error(String(error));console.error('3D presentation host:',host.error);}
  window.addEventListener('error',event=>fail(event.error||event.message));
  window.addEventListener('unhandledrejection',event=>fail(event.reason));
  function script(src){return new Promise((resolve,reject)=>{const node=document.createElement('script');node.src=src;node.onload=resolve;node.onerror=()=>reject(Error('Cannot load '+src));document.head.appendChild(node);});}
  async function bounded(test,label,timeout=30000){const start=performance.now();while(!test()){if(host.error)throw host.error;if(disposed)throw Error('3D host disposed');if(performance.now()-start>timeout)throw Error('Timed out: '+label);await new Promise(resolve=>setTimeout(resolve,20));}}
  async function load({map,tileset,database={},config={},width=816,height=624,getSnapshot}){
    if(loaded)throw Error('Create a fresh 3D host for each map');loaded=true;
    try{
      kind=(config.pluginName||map.threeD?.pluginName)==='mz3d'?'mz':'mv';
      const base='/client/vendor/3d/'+kind+'/',plugin=kind+'3d';
      const defaults=await fetch(base+'defaults.json').then(r=>{if(!r.ok)throw Error('Missing 3D defaults');return r.json();});
      const libraries=kind==='mv'?['pixi.js','pixi-tilemap.js','pixi-picture.js','lz-string.js']:['pixi.js','pako.min.js','localforage.min.js','effekseer.min.js'];
      for(const name of libraries)await script(base+'libs/'+name);
      const prefix=kind==='mv'?'rpg':'rmmz';
      for(const name of ['core','managers','objects','scenes','sprites','windows'])await script(base+prefix+'_'+name+'.js');
      // No main.js, PluginManager.setup(), SceneManager.run(), database loader or
      // game scene is started. Plugin metadata is the only external script selected.
      window.$plugins=[{name:plugin,status:true,parameters:{...defaults,...config.parameters}}];
      PluginManager._scripts=[plugin];PluginManager.setParameters(plugin,$plugins[0].parameters);
      await script(base+plugin+'.js');
      if(host.error)throw host.error;
      suppressGameRuntime();
      const names=['Actors','Classes','Skills','Items','Weapons','Armors','Enemies','Troops','States','Animations','Tilesets','CommonEvents','System','MapInfos'];
      for(const name of names)window['$data'+name]=clone(database[name]||(name==='System'?{}:[null]));
      const vehicle={characterName:'',characterIndex:0,startMapId:0,startX:0,startY:0,bgm:{name:'',volume:0,pitch:100,pan:0}};
      Object.assign($dataSystem,{boat:$dataSystem.boat||clone(vehicle),ship:$dataSystem.ship||clone(vehicle),airship:$dataSystem.airship||clone(vehicle),partyMembers:$dataSystem.partyMembers||[],switches:$dataSystem.switches||[],variables:$dataSystem.variables||[]});
      $dataSystem.optFollowers=false;
      window.$dataMap=clone(map);$dataMap.events||=[null];
      window.$dataTilesets[$dataMap.tilesetId]=clone(tileset);
      DataManager.extractMetadata($dataMap);
      for(const event of $dataMap.events)if(event)DataManager.extractMetadata(event);
      for(const entry of $dataTilesets)if(entry)DataManager.extractMetadata(entry);
      DataManager.createGameObjects();
      const initialSnapshot=getSnapshot?.();
      if(initialSnapshot&&Number(initialSnapshot.mapId)===Number(map.id)){
        syncVariables(initialSnapshot);
        initialEventPages=new Map((initialSnapshot.events||[]).filter(isNativeEvent).map(event=>[Number(event.eventId),event.pageIndex]));
      }
      $gamePlayer._followers._data=[];
      Graphics._width=Graphics._boxWidth=Math.max(1,Math.round(width));
      Graphics._height=Graphics._boxHeight=Math.max(1,Math.round(height));
      Graphics._realScale=1;
      // Tile rectangles use only these Tilemap data methods, not a Pixi renderer.
      const tileSize=Number($dataSystem.tileSize)||48;
      const tilemap={tileWidth:tileSize,tileHeight:tileSize,flags:tileset.flags||[],_isTableTile:Tilemap.prototype._isTableTile};
      const scene=Object.create(Scene_Map.prototype);
      SceneManager._scene=null;
      scene._active=true;scene._started=true;scene.isStarted=()=>true;scene.isActive=()=>true;
      scene._spriteset={_tilemap:tilemap,_characterSprites:[],_animationSprites:[],_balloonSprites:[]};
      SceneManager.isCurrentSceneStarted=()=>true;
      mv3d.setupInput=noop;mv3d.updateInput=noop;
      await mv3d.setup();mv3d.engine.stopRenderLoop();
      const cameraZoomValue=mv3d.blendCameraZoom.currentValue.bind(mv3d.blendCameraZoom);
      mv3d.blendCameraZoom.currentValue=()=>cameraZoomValue()*hostZoom;
      const loadCharacter=ImageManager.loadCharacter;
      ImageManager.loadCharacter=function(name){return appearanceBitmaps.get(name)||loadCharacter.apply(this,arguments);};
      const getTextureUrl=mv3d.getTextureUrl;
      mv3d.getTextureUrl=function(url){const name=/img\/characters\/([^/]+)\.png$/.exec(url)?.[1];return appearanceSources.has(name)?Promise.resolve(appearanceSources.get(name)):getTextureUrl.apply(this,arguments);};
      const checkFileExists=mv3d.checkFileExists;
      mv3d.checkFileExists=function(url){return String(url).includes('$HostAppearance')?Promise.resolve(false):checkFileExists.apply(this,arguments);};
      mv3d.pixiSprite=new PIXI.Sprite(mv3d.texture);
      mv3d.pixiSprite.scale.set(1/mv3d.RES_SCALE,1/mv3d.RES_SCALE);
      mv3d.viewContainer=new PIXI.Container();mv3d.pixiContainer=new PIXI.Container();mv3d.mv_baseSprite=new PIXI.Container();
      mv3d.viewContainer.addChild(mv3d.pixiSprite);
      mv3d.callFeatures('createViews');
      mv3d._tilemap=tilemap;
      SceneManager._scene=scene;
      host.canvas=document.createElement('canvas');document.body.appendChild(host.canvas);
      resize(width,height);
      // setupBattleback normally starts an unawaited tileset load before map setup
      // completes. This host invokes that asynchronous operation once, below.
      $gameMap.setupBattleback=noop;
      $gameMap.setup(Number(map.id)||1);
      $gameMap._vehicles=[];
      for(const event of $gameMap.events())attachSprite(event);
      const initialPlayer=Number(initialSnapshot?.mapId)===Number(map.id)?initialSnapshot.players?.find(player=>player.id===initialSnapshot.playerId):null;
      $gamePlayer.locate(initialPlayer?.x??map.width/2,initialPlayer?.y??map.height/2);$gamePlayer.setTransparent(true);attachSprite($gamePlayer);
      mv3d.beforeMapLoad(true);mv3d.loadMapSettings();
      await mv3d.loadTilesetSettings();
      mv3d.applyMapSettings();mv3d.afterMapLoad(true);
      if(mv3d.isDisabled())throw Error('A disabled map was passed to the 3D presentation host');
      if(map.parallaxName){parallax=ImageManager.loadParallax(map.parallaxName);}
      mv3d.resetCameraTarget();mv3d.updateBlenders(true);
      mv3d.loadMap();
      await bounded(()=>mv3d.mapReady,'3D map meshes and textures');
      host.ready=true;
      const snapshot=getSnapshot?.()||{};
      update({entities:[...(snapshot.events||[]),...(snapshot.players||[])],snapshot,center:{x:map.width/2,y:map.height/2}});
      return {pluginName:plugin,version:'0.9.2.8',canvas:host.canvas};
    }catch(error){fail(error);throw error;}
  }
  function suppressGameRuntime(){
    // Keep engine data and bitmap classes, but remove every autonomous execution
    // path. All state changes here originate from an authoritative parent snapshot.
    for(const key of ['loadDatabase','loadMapData','loadDataFile','saveGame','saveGameWithoutRescue','loadGame','loadGameWithoutRescue','setupNewGame'])DataManager[key]=noop;
    for(const key of ['run','goto','push','pop','updateMain','requestUpdate','updateScene'])SceneManager[key]=noop;
    for(const key of Object.getOwnPropertyNames(AudioManager))if(/^(play|replay|fade|stop|update|save|create)/.test(key)&&typeof AudioManager[key]==='function')AudioManager[key]=noop;
    ConfigManager.load=noop;ConfigManager.save=noop;
    for(const key of Object.getOwnPropertyNames(StorageManager))if(typeof StorageManager[key]==='function')StorageManager[key]=noop;
    for(const key of ['initialize','update','_setupEventHandlers']){Input[key]=noop;TouchInput[key]=noop;}
    Input.isPressed=Input.isTriggered=Input.isRepeated=()=>false;
    TouchInput.isPressed=TouchInput.isTriggered=TouchInput.isRepeated=TouchInput.isCancelled=()=>false;
    Input.clear();TouchInput.clear();
    Game_Interpreter.prototype.update=noop;
    Game_Interpreter.prototype.executeCommand=()=>false;
    for(const key of Object.getOwnPropertyNames(Game_Interpreter.prototype))if(/^command\d+$/.test(key))Game_Interpreter.prototype[key]=()=>false;
    for(const type of [Game_Map,Game_Player,Game_Event,Game_Character,Game_CharacterBase,Game_Vehicle,Game_Follower]){
      for(const key of ['update','updateRoutineMove','updateSelfMovement','updateParallel','updateInterpreter','checkEventTriggerAuto','start','processMoveCommand','forceMoveRoute','moveByInput'])type.prototype[key]=noop;
    }
    // Event page selection belongs to the server. Page zero is used only by the
    // map preview until its first explicit snapshot arrives.
    Game_Event.prototype.findProperPageIndex=function(){return this._hostPageIndex??(initialEventPages?initialEventPages.get(this._eventId)??-1:(this.event()?.pages?.length?0:-1));};
    Game_Player.prototype.refresh=noop;Game_Player.prototype.canMove=()=>false;
    Game_Player.prototype.reserveTransfer=noop;
    // Asset errors must surface to the parent instead of freezing a load forever.
    const onBitmapError=Bitmap.prototype._onError;
    Bitmap.prototype._onError=function(){onBitmapError?.apply(this,arguments);fail(Error('Cannot load 3D image: '+this._url));};
  }
  function attachSprite(character){
    if(character.mv_sprite)return character.mv_sprite;
    const sprite=new Sprite_Character(character);sprites.add(sprite);
    SceneManager._scene._spriteset._characterSprites.push(sprite);
    sprite.updateBitmap();return sprite;
  }
  function isNativeEvent(entity){
    const eventId=Number(entity.eventId),id=String(entity.id);
    return eventId>0&&(id===`preview-${eventId}`||id===`map:${$dataMap.id}:event:${eventId}`)
      &&(!entity.sourceMapId||Number(entity.sourceMapId)===Number($dataMap.id));
  }
  function displayPage(source={}){
    source||={};
    return {conditions:{},image:{tileId:0,characterName:'',characterIndex:0,direction:2,pattern:1,...source.image},
      directionFix:!!source.directionFix,walkAnime:source.walkAnime!==false,stepAnime:!!source.stepAnime,
      moveSpeed:Number(source.moveSpeed)||4,moveFrequency:3,priorityType:source.priorityType??1,
      moveType:0,through:false,trigger:0,moveRoute:{list:[{code:0,parameters:[]}],repeat:false,skippable:false,wait:false},
      list:(source.list||[]).filter(command=>[0,108,408].includes(command.code)).map(clone)};
  }
  function createDynamicEvent(entity){
    const source=entity.threeDSource;
    const sameMap=!entity.sourceMapId||Number(entity.sourceMapId)===Number($dataMap.id);
    const native=sameMap?$dataMap.events[Number(entity.eventId)]:null;
    if(!source&&!native)return null;
    const id=$dataMap.events.length;
    const raw={id,name:entity.name||native?.name||'Network event',x:entity.x,y:entity.y,
      note:String(source?.note??native?.note??''),pages:source?[displayPage(source.page)]:native.pages.map(displayPage)};
    DataManager.extractMetadata(raw);$dataMap.events[id]=raw;
    // Initialize with the authoritative page already selected. Constructors read
    // comments but cannot execute routes or event lists in this presentation host.
    const character=Object.create(Game_Event.prototype);
    character._hostPageIndex=source?(entity.pageIndex<0?-1:0):(entity.pageIndex??0);
    character._hostSinglePage=!!source;character._hostDynamic=true;
    character._hostSourceSignature=source?JSON.stringify(source):null;
    character.initialize($gameMap.mapId(),id);$gameMap._events[id]=character;
    attachSprite(character);return character;
  }
  function syncDynamicSource(character,entity){
    if(!character._hostDynamic||!entity.threeDSource)return;
    const source=entity.threeDSource,signature=JSON.stringify(source);
    if(character._hostSourceSignature===signature)return;
    const raw=character.event(),note=String(source.note||''),changedNote=raw.note!==note;
    raw.note=note;raw.pages=[displayPage(source.page)];DataManager.extractMetadata(raw);
    character._hostSinglePage=true;character._hostSourceSignature=signature;
    character._hostPageIndex=character._pageIndex=entity.pageIndex<0?-1:0;character.setupPage();
    if(changedNote&&character.mv3d_sprite)delete character.mv3d_sprite.settings_event;
    character.mv3d_needsConfigure=true;
  }
  function syncCharacter(character,entity,appearanceUrl){
    syncDynamicSource(character,entity);
    const x=Number(entity.x)||0,y=Number(entity.y)||0;
    const distance=Math.hypot(character._realX-x,character._realY-y),moved=distance>.001;
    character._x=Number(entity.targetX??x);character._y=Number(entity.targetY??y);
    character._realX=x;character._realY=y;
    character._hostMoving=moved||Number(entity.walkUntil)>frameTime;
    character.isMoving=function(){return this._hostMoving;};
    character._direction=Number(entity.direction)||2;
    character.mv3d_data.direction=character._direction;
    character._opacity=entity.opacity??255;
    character._erased=Boolean(entity.erased||entity.disabled||entity.pageIndex===-1);
    character._transparent=Boolean(entity.transparent||entity.erased||entity.disabled||entity.visible===false);
    const pageIndex=character._hostSinglePage?(entity.pageIndex<0?-1:0):entity.pageIndex;
    if(character instanceof Game_Event&&Number.isInteger(pageIndex)&&character._pageIndex!==pageIndex){
      character._hostPageIndex=pageIndex;character._pageIndex=pageIndex;character.setupPage();
    }
    const image=entity.image||{},name=entity.characterName??image.characterName,index=entity.characterIndex??image.characterIndex;
    const animationKey=JSON.stringify([image.tileId||0,name,index,image.pattern]);
    if(character._hostAnimationKey!==animationKey){
      character._hostAnimationKey=animationKey;
      if(Number.isInteger(image.pattern)){
        character._originalPattern=image.pattern;character.setPattern(image.pattern);
        if(!(character instanceof Game_Event)){
          character.isOriginalPattern=function(){return this.pattern()===this._originalPattern;};
          character.resetPattern=function(){this.setPattern(this._originalPattern);};
        }
      }
    }
    const url=appearanceUrl||entity.appearanceUrl||entity.spriteUrl;
    if(url){
      if(appearanceUrls.get(character)!==url){
        const appearanceName='$HostAppearance'+(++appearanceSequence);
        character._hostAppearanceName=appearanceName;appearanceUrls.set(character,url);
        appearanceSources.set(appearanceName,url);appearanceBitmaps.set(appearanceName,Bitmap.load(url));
        character._characterName=''; // A changed composition needs a fresh material.
        character.mv3d_sprite?._characterName&&(character.mv3d_sprite._characterName='');
      }
      character.setImage(character._hostAppearanceName,0);
    }else if(image.tileId){if(character._tileId!==image.tileId)character.setTileImage(image.tileId);}
    else if(name!==undefined&&(character.characterName()!==name||character.characterIndex()!==(index||0)))character.setImage(name,index||0);
    if(Number.isFinite(entity.z))character.z=entity.z;
    else if(!(character instanceof Game_Event)&&(!character._hostBoundPosition||distance>3)){
      // Preview camera anchors are not a prior player position. A newly bound
      // player or teleport begins on its destination floor, without falling from
      // the old camera's height. Authored event z/elevation remains upstream-owned.
      const sprite=character.mv3d_sprite,ground=mv3d.getWalkHeight(x,y);
      character.z=ground+(sprite?.blendElevation?.currentValue()||0);
      if(sprite){sprite.z=character.z;sprite.platformHeight=ground;sprite.targetElevation=character.z;sprite.prevZ=character.z;sprite.falling=false;}
    }
    character._hostBoundPosition=true;
    if(character.mv3d_sprite)character.mv3d_sprite.needsPositionUpdate=true;
    const sprite=attachSprite(character);sprite.updateBitmap();sprite.updateFrame();
  }
  function update({entities=[],snapshot={},center,zoom=1,time,appearance}={}){
    if(!host.ready||disposed)return;if(host.error)throw host.error;
    try{
      const now=performance.now(),dt=Math.min(.1,(now-lastUpdate)/1000);lastUpdate=now;
      frameTime=Number.isFinite(time)?time:now;
      animationRemainder+=dt*60;const animationSteps=Math.floor(animationRemainder);animationRemainder-=animationSteps;
      const nextZoom=Number.isFinite(zoom)&&zoom>0?zoom:1;
      if(nextZoom!==hostZoom){hostZoom=nextZoom;mv3d.updateBlenders(true);}
      syncVariables(snapshot);
      Graphics.frameCount=(Graphics.frameCount||0)+1;
      const active=new Set(),activeEvents=new Set();let playerSeen=false;
      for(const entity of entities){
        const key=String(entity.id);active.add(key);
        let character=characters.get(key);
        if(entity.id===snapshot.playerId){character=$gamePlayer;playerSeen=true;}
        else if(!character){
          const eventId=Number(entity.eventId??(entity.kind==='event'?entity.id:0));
          character=eventId?(isNativeEvent(entity)?$gameMap.event(eventId):createDynamicEvent(entity)):null;
          if(!character){character=new Game_Character();attachSprite(character);mv3d.createCharacterFor(character,20);}
        }
        character._hostEntityId=key;
        characters.set(key,character);syncCharacter(character,entity,appearance?.(entity));
        if(character instanceof Game_Event)activeEvents.add(character);
        if(!character._erased&&(!character.mv3d_sprite||character.mv3d_sprite.isDisposed()))mv3d.createCharacterFor(character,character===$gamePlayer?30:0);
      }
      for(const [key,character]of characters)if(!active.has(key)){
        character.setTransparent(true);
        if((character._hostDynamic||!(character instanceof Game_Event))&&character!==$gamePlayer){
          const sprite=character.mv3d_sprite;if(sprite&&!sprite.isDisposed())sprite.dispose();
          const bitmapSprite=character.mv_sprite;
          if(bitmapSprite){
            sprites.delete(bitmapSprite);
            const list=SceneManager._scene._spriteset._characterSprites,index=list.indexOf(bitmapSprite);
            if(index>=0)list.splice(index,1);bitmapSprite.destroy?.();
          }
          appearanceUrls.delete(character);
          if(character._hostDynamic){$gameMap._events[character._eventId]=null;$dataMap.events[character._eventId]=null;}
        }
        characters.delete(key);
      }
      for(const event of $gameMap.events())if(!activeEvents.has(event)){event._erased=true;event.setTransparent(true);}
      if(!playerSeen){$gamePlayer.setTransparent(true);if(center){$gamePlayer._x=$gamePlayer._realX=center.x;$gamePlayer._y=$gamePlayer._realY=center.y;$gamePlayer.z=mv3d.getWalkHeight(center.x,center.y);}}
      // Only the original frame-animation methods run at their native 60 Hz.
      // This preserves editor step/walk animation, move speed and original pattern
      // without running character movement, routes, event triggers or scripts.
      for(const character of new Set(characters.values())){
        for(let step=0;step<animationSteps;step++){
          character._stopCount=character.isMoving()?0:character._stopCount+1;
          character.updateAnimation();
        }
        character.refreshBushDepth();
      }
      for(const sprite of sprites){sprite.updateBitmap();sprite.updateFrame();}
      if(parallax)$gameMap.updateParallax();
      mv3d.scene.deltaTime=dt*1000;mv3d.update();mv3d._render();
      compose();
    }catch(error){fail(error);throw error;}
  }
  function compose(){
    const canvas=host.canvas,ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
    if(parallax?.isReady()){
      const img=parallax.canvas||parallax._canvas||parallax._image;
      const pattern=ctx.createPattern(img,'repeat');
      ctx.save();ctx.translate(-$gameMap.parallaxOx(),-$gameMap.parallaxOy());ctx.fillStyle=pattern;ctx.fillRect($gameMap.parallaxOx(),$gameMap.parallaxOy(),canvas.width,canvas.height);ctx.restore();
    }
    const views=mv3d.View?.list||[];
    for(const view of views)if(view.enabled&&view.index<0)ctx.drawImage(view.canvas,0,0,canvas.width,canvas.height);
    ctx.drawImage(mv3d.canvas,0,0,canvas.width,canvas.height);
    for(const view of views)if(view.enabled&&view.index>=0)ctx.drawImage(view.canvas,0,0,canvas.width,canvas.height);
  }
  function resize(width,height){
    if(!window.mv3d?.canvas||disposed)return;
    width=Math.max(1,Math.round(width));height=Math.max(1,Math.round(height));
    if(Graphics._width===width&&Graphics._height===height&&host.canvas?.width===width&&host.canvas?.height===height)return;
    Graphics._width=Graphics._boxWidth=width;Graphics._height=Graphics._boxHeight=height;
    host.canvas.width=width;host.canvas.height=height;
    mv3d.updateCanvas();mv3d.engine.resize(true);mv3d.updateBlenders(true);
    for(const view of mv3d.View?.list||[])view.requestRender();
  }
  async function command({command:source,eventId=0,entityId}={}){
    if(!host.ready||disposed)return;const args=String(source||'').trim().split(/\s+/);
    if(/^(?:mv3d|mz3d)$/i.test(args[0]))args.shift();
    // A cue can arrive just before the snapshot which introduces a copied event.
    // Never accidentally apply its @s command to the editor source with the same id.
    if(entityId!=null&&Number(eventId)>0&&!characters.has(String(entityId)))await bounded(()=>characters.has(String(entityId)),'3D command target '+entityId,5000);
    const character=(entityId!=null&&characters.get(String(entityId)))||$gameMap.event(Number(eventId))||$gamePlayer;
    const pc=new mv3d.PluginCommand();pc.INTERPRETER=new Game_Interpreter();pc.INTERPRETER._eventId=character._eventId||Number(eventId)||0;
    pc.CHAR=character;pc.FULL_COMMAND='mv3d '+args.join(' ');
    if(/^[@＠]/.test(args[0]))pc.CHAR=pc.TARGET_CHAR(args.shift());
    const name=String(args.shift()||'').toLowerCase();
    // Only named upstream command methods, never inherited Object properties or
    // interpreter scripts. The server already classifies accepted commands.
    if(!Object.prototype.hasOwnProperty.call(mv3d.PluginCommand.prototype,name)||typeof pc[name]!=='function')throw Error('Unknown 3D command: '+name);
    return await pc[name](...args);
  }
  function pick(x,y){
    if(!host.ready||disposed)return null;
    const scale=mv3d.RES_SCALE||1;
    const hit=mv3d.scene.pick(x*scale,y*scale,mesh=>mesh.isEnabled()&&mesh.isVisible&&mesh.isPickable&&!mesh.mv3d_noCollision);
    if(!hit?.hit)return null;
    const character=hit.pickedMesh?.character?.char;
    return character?{x:character._realX,y:character._realY,z:character.z||0}:
      {x:hit.pickedPoint.x,y:-hit.pickedPoint.z,z:hit.pickedPoint.y};
  }
  function project(x,y,z){
    if(!host.ready||disposed)return null;
    const point=new BABYLON.Vector3(Number(x),Number.isFinite(z)?z:mv3d.getWalkHeight(x,y),-Number(y));
    return mv3d.getScreenPosition(point);
  }
  function projectEntity(id,offset=.15){
    if(!host.ready||disposed)return null;
    const sprite=characters.get(String(id))?.mv3d_sprite;
    if(!sprite||!sprite.isEnabled()||sprite.visible===false)return null;
    // The sprite origin includes authored x/y/z offsets and elevation; the label
    // sits above its actual scaled height instead of the map's floor elevation.
    return mv3d.getScreenPosition(sprite.spriteOrigin,new BABYLON.Vector3(0,(sprite.spriteHeight||1)+Number(offset||0),0));
  }
  function syncVariables(snapshot){
    if(snapshot.threeD?.variables)for(const [id,value]of Object.entries(snapshot.threeD.variables))$gameVariables._data[Number(id)]=value;
  }
  function dispose(){
    if(disposed)return;disposed=true;host.ready=false;
    if(window.mv3d){mv3d.engine?.stopRenderLoop();mv3d.clearMap?.();mv3d.scene?.dispose();mv3d.skyboxScene?.dispose();mv3d.engine?.dispose();}
    for(const sprite of sprites)sprite.destroy?.();sprites.clear();characters.clear();appearanceUrls.clear();appearanceBitmaps.clear();appearanceSources.clear();
    host.canvas?.remove();host.canvas=null;
  }
})();
