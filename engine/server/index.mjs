import http from 'node:http';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {WebSocketServer,WebSocket} from 'ws';
import {loadContent} from './content.mjs';
import {MySqlStore} from './persistence.mjs';
import {GameHost} from './instances.mjs';
import {loadAppearanceCatalog,normalizeAppearance} from './appearance.mjs';

const engineRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ogg':'audio/ogg','.m4a':'audio/mp4','.mp3':'audio/mpeg','.wav':'audio/wav','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.ico':'image/x-icon','.wasm':'application/wasm','.efkefc':'application/octet-stream','.efkmodel':'application/octet-stream','.efkmat':'application/octet-stream','.gltf':'model/gltf+json','.glb':'model/gltf-binary','.obj':'text/plain; charset=utf-8','.mtl':'text/plain; charset=utf-8','.babylon':'application/json; charset=utf-8'};
const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
async function body(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>16384)throw new Error('请求过大');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
function within(base,relative){const resolved=path.resolve(base,relative);return resolved.startsWith(base+path.sep)||resolved===base?resolved:null;}

export async function createApplication({projectRoot=path.resolve(engineRoot,'..'),store,devTools=false}={}) {
  const content=await loadContent(projectRoot),sessions=new Map(),loginAttempts=new Map();
  let databaseReady=false,dbError=null;
  try{await store.init();databaseReady=true;}catch(error){dbError=error.code||'DATABASE_UNAVAILABLE';console.error(`MySQL 未就绪 (${dbError})；素材预览仍可用，请检查 engine/.env 与本地 MySQL。`);}
  const appearance=await loadAppearanceCatalog(projectRoot,content);
  const host=new GameHost({content,store,devTools,appearanceCatalog:appearance});
  if(databaseReady)await host.init?.();
  const world=host.world,profileQueues=new Map(),connections=new Map();
  const publicContent={version:content.version,maps:content.mapInfos.filter(Boolean).filter(m=>content.maps.has(m.id)).map(m=>({id:m.id,name:m.name,width:content.maps.get(m.id).width,height:content.maps.get(m.id).height,tilesetId:content.maps.get(m.id).tilesetId,threeD:content.maps.get(m.id).threeD})),database:content.database,threeD:content.threeD,textConfig:content.textConfig,recipes:content.recipes,weaponProfiles:Object.fromEntries(content.weaponProfiles||[]),coverage:content.coverage,devTools};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
    try{
      const url=new URL(req.url,'http://localhost');
      if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host){json(res,403,{error:'不允许跨站请求'});return;}
      if(url.pathname==='/api/health'){json(res,200,{ok:true,database:databaseReady?'ready':'unavailable',databaseError:dbError,maps:content.maps.size,players:host.players.size,tick:host.tick,devTools});return;}
      if(url.pathname==='/api/appearance'){json(res,200,appearance);return;}
      if(url.pathname==='/api/content'){json(res,200,publicContent);return;}
      if(url.pathname==='/api/coverage'){json(res,200,{...content.coverage,runtime:[...host.runtimeDiagnostics].map(([source,message])=>({source,message}))});return;}
      if(url.pathname==='/api/session'&&req.method==='GET'){
        if(!databaseReady){json(res,503,{valid:false,error:'数据库未就绪'});return;}
        const token=req.headers.authorization?.replace(/^Bearer\s+/i,''),session=sessions.get(token);
        if(!session||session.expires<Date.now()){sessions.delete(token);json(res,401,{valid:false});return;}
        json(res,200,{valid:true,playerId:session.id});return;
      }
      const mapMatch=url.pathname.match(/^\/api\/maps\/(\d+)$/);if(mapMatch){const map=content.getMap(Number(mapMatch[1]));json(res,map?200:404,map||{error:'地图不存在'});return;}
      if(url.pathname==='/api/session'&&req.method==='POST'){
        if(!databaseReady){json(res,503,{error:'MySQL 尚未连接。请先启动项目独立数据库；地图预览仍可使用。'});return;}
        const address=req.socket.remoteAddress,now=Date.now(),attempts=loginAttempts.get(address)||[];
        const recent=attempts.filter(t=>now-t<60000);if(recent.length>=30){json(res,429,{error:'登录尝试过于频繁，请稍后重试'});return;}recent.push(now);loginAttempts.set(address,recent);
        const data=await body(req);if(!['register','login'].includes(data.mode)||typeof data.username!=='string'||typeof data.password!=='string'){json(res,400,{error:'无效登录请求'});return;}
        if(data.username.trim().length<3||data.username.trim().length>32||data.password.length<8||data.password.length>128){json(res,400,{error:'用户名需要3–32个字母、数字或下划线，密码需要8–128个字符'});return;}
        try{const account=await store[data.mode](data.username.trim(),data.password);const token=randomBytes(32).toString('hex');sessions.set(token,{id:account.id,expires:now+86400000});json(res,200,{token,playerId:account.id});}
        catch(error){json(res,400,{error:error.message?.includes('密码')||error.message?.includes('用户')?error.message:'无法登录或注册，请检查账号信息'});}return;
      }
      if(!['GET','HEAD'].includes(req.method)){json(res,405,{error:'Method not allowed'});return;}
      let base,relative;
      if(url.pathname.startsWith('/assets/')){const match=/^(img|audio|fonts|effects|models)\/(.+)$/.exec(decodeURIComponent(url.pathname.slice(8)));if(!match){json(res,404,{error:'Not found'});return;}base=path.join(projectRoot,match[1]);relative=match[2];}
      else if(url.pathname.startsWith('/client/')){base=path.join(engineRoot,'client');relative=decodeURIComponent(url.pathname.slice(8));}
      else if(url.pathname==='/'){base=path.join(engineRoot,'client');relative='index.html';}
      else {json(res,404,{error:'Not found'});return;}
      const file=within(base,relative);if(!file){json(res,403,{error:'Forbidden'});return;}
      const info=await stat(file);if(!info.isFile()){json(res,404,{error:'Not found'});return;}
      const headers={'Content-Type':MIME[path.extname(file).toLowerCase()]||'application/octet-stream','Cache-Control':url.pathname.startsWith('/assets/')?'public, max-age=3600':'no-cache','Accept-Ranges':'bytes'};
      let start=0,end=info.size-1,status=200;
      if(req.headers.range){const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!range){res.writeHead(416);res.end();return;}start=Number(range[1]);if(range[2])end=Math.min(end,Number(range[2]));if(start>end||start>=info.size){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return;}headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;status=206;}
      headers['Content-Length']=Math.max(0,end-start+1);res.writeHead(status,headers);if(req.method==='HEAD'||info.size===0){res.end();return;}
      await pipeline(createReadStream(file,{start,end}),res);
    }catch(error){if(res.headersSent){res.destroy();return;}json(res,error.code==='ENOENT'?404:400,{error:error.code==='ENOENT'?'资源不存在':'请求无法处理'});}
  });
  const sockets=new WebSocketServer({noServer:true,maxPayload:16384});
  server.on('upgrade',(req,socket,head)=>{
    const url=new URL(req.url,'http://localhost'),session=sessions.get(url.searchParams.get('token'));
    const origin=req.headers.origin;let validOrigin=true;try{if(origin)validOrigin=new URL(origin).host===req.headers.host;}catch{validOrigin=false;}
    if(url.pathname!=='/ws'||!databaseReady||!session||session.expires<Date.now()||!validOrigin){socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');socket.destroy();return;}
    sockets.handleUpgrade(req,socket,head,ws=>{ws.accountId=session.id;sockets.emit('connection',ws,req);});
  });
  sockets.on('connection',async ws=>{
    let player,windowStart=Date.now(),count=0;
    ws.on('error',()=>{});
    try{const account=await store.loadPlayer(ws.accountId);if(!account)throw new Error('角色不存在');player=await host.connect(account,msg=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg));});if(ws.readyState!==WebSocket.OPEN){await host.disconnect(player.id);return;}connections.set(player.id,ws);}
    catch(error){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'notice',level:'error',message:error.message}));ws.close(1008,'Session unavailable');return;}
    ws.on('message',raw=>{
      if(connections.get(player.id)!==ws||ws.readyState!==WebSocket.OPEN)return;
      const now=Date.now();if(now-windowStart>1000){count=0;windowStart=now;}if(++count>100){ws.close(1008,'Rate limit');return;}
      let message;try{message=JSON.parse(raw.toString());}catch{ws.close(1007,'Invalid JSON');return;}
      if(['appearance','offlineBehavior'].includes(message?.type)){
        const job=(profileQueues.get(player.id)||Promise.resolve()).then(async()=>{
          const patch=message.type==='appearance'?{appearance:normalizeAppearance(message.appearance,appearance)}:{offlineBehavior:message.behavior};
          if(message.type==='offlineBehavior'&&!['stay','evade','search','hunt'].includes(message.behavior))throw new Error('无效的离线行动策略');
          const profile={...await store.loadProfile(player.id),...patch};
          await store.saveProfile(player.id,profile);
          while(host.transitions.has(player.id))await host.transitions.get(player.id).catch(()=>{});
          await host.updateProfile(player.id,profile);
          host.notice(host.getPlayer(player.id)||player,message.type==='appearance'?'外观已保存为永久角色资料':'离线行动策略已保存，断开连接后生效');
        }).catch(error=>host.notice(host.getPlayer(player.id)||player,error.message));
        profileQueues.set(player.id,job);job.finally(()=>{if(profileQueues.get(player.id)===job)profileQueues.delete(player.id);});return;
      }
      Promise.resolve(host.command(player,message)).catch(error=>host.notice(host.getPlayer(player.id)||player,error.message));
    });
    ws.on('close',()=>{if(connections.get(player.id)!==ws)return;connections.delete(player.id);host.disconnect(player.id).catch(error=>console.error(`保存角色失败: ${error.code||'SAVE_FAILED'}`));});
  });
  const timer=setInterval(()=>{try{host.update(.05);}catch(error){console.error('World tick failed:',error.message);world.runtimeDiagnostics.set('tick',error.message);}},50);
  timer.unref();
  async function close(){clearInterval(timer);await Promise.all(profileQueues.values());for(const ws of sockets.clients)ws.terminate();await host.close();await new Promise(resolve=>server.close(resolve));await store.close();}
  return {server,world,host,appearance,content,close,databaseReady};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||8098),devTools=process.env.DEV_TOOLS==='1';
  if(devTools&&!['127.0.0.1','localhost','::1'].includes(host))throw new Error('开发工具只允许绑定本机地址');
  const store=new MySqlStore({host:process.env.MYSQL_HOST||'127.0.0.1',port:Number(process.env.MYSQL_PORT||3317),user:process.env.MYSQL_USER||'spaceship',password:process.env.MYSQL_PASSWORD||'',database:process.env.MYSQL_DATABASE||'spaceship_engine'});
  const app=await createApplication({store,devTools});app.server.listen(port,host,()=>console.log(`Spaceship Engine: http://${host}:${port} · ${app.content.maps.size} maps · MySQL ${app.databaseReady?'ready':'unavailable'}`));
  let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await app.close();process.exit(0);});
}
