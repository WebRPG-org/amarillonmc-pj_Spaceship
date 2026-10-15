const endpoint='/api/editor/restart';

/** One POST only: a lost acknowledgement must never trigger a second restart. */
export async function restartEngine(api,{instanceId,requestId,onProgress=()=>{},wait=()=>new Promise(resolve=>setTimeout(resolve,500)),attempts=120}={}){
  let value;
  try{value=await api(endpoint,{method:'POST',body:JSON.stringify({instanceId,requestId}),signal:AbortSignal.timeout(5000)});}
  catch(error){if(error.status)throw error;}
  for(let attempt=0;attempt<attempts;attempt++){
    if(value){
      if(value.requestId!==requestId)throw new Error('未能确认本次重启结果，请刷新重启状态后再操作。');
      if(value.state==='failed')throw new Error(value.error||'重启失败，请检查服务日志。');
      if(value.state==='succeeded')return value;
      onProgress(value.state==='saving'?'正在保存玩家数据并重建服务…':'正在检查已保存内容并等待当前操作完成…');
    }
    await wait();
    try{value=await api(endpoint,{signal:AbortSignal.timeout(5000)});}
    catch(error){if(error.status&&error.status<500)throw error;value=null;}
  }
  throw new Error('尚未确认重启完成，服务端可能仍在保存数据。请稍后再次点击重置按钮查看本次结果；未保存编辑仍保留。');
}
