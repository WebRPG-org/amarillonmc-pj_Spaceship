import {randomUUID} from 'node:crypto';

export const CHAT_LIMITS=Object.freeze({maxLength:280,minIntervalMs:800,windowMs:10000,windowMessages:6});

// Player chat is always plain text. Never send it through event escape-code adapters.
export function normalizeChatText(value){
  if(typeof value!=='string'||value.length>4096)throw new Error('聊天内容格式无效');
  const text=value.normalize('NFC').replace(/[\r\n\t]+/g,' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'').trim();
  if(!text)throw new Error('请输入聊天内容');
  if([...text].length>CHAT_LIMITS.maxLength)throw new Error(`聊天内容最多 ${CHAT_LIMITS.maxLength} 个字符`);
  return text;
}

const bounded=(value,fallback,min,max)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Number(value))):fallback;
export function chatSettings(content){
  const plugin=name=>content.plugins?.find(p=>p.name===name)?.parameters||{};
  const params={...plugin('MMO_iavra_event_popup'),...content.textConfig?.popup},position=plugin('MMO_ChatBox').chatPosition;
  const popup=content.textConfig?.popup||{};
  return {position:['TOP LEFT','TOP RIGHT','BOTTOM LEFT','BOTTOM RIGHT'].includes(position)?position:'BOTTOM LEFT',maxLength:CHAT_LIMITS.maxLength,
    popup:{width:bounded(popup.width??params['Popup Width'],200,64,600),x:bounded(popup.x??params['Offset X'],0,-600,600),y:-42,
      duration:bounded(popup.duration??params['Display Duration'],200,0,3600)*1000/60,
      fadeIn:bounded(popup.fadeIn??params['Fade In Duration'],10,0,600)*1000/60,
      fadeOut:bounded(popup.fadeOut??params['Fade Out Duration'],60,0,600)*1000/60,
      fontName:String(popup.fontName??params['Font Name']??'').slice(0,100),fontSize:bounded(popup.fontSize??params['Font Size'],12,8,72),lineHeight:bounded(popup.lineHeight??params['Line Height'],18,10,100)}};
}

/** A host shares this limiter across reconnects and all of its isolated worlds. */
export class ChatService{
  constructor({clock=Date.now}={}){this.clock=clock;this.sent=new Map();this.lastCleanup=0;}
  send(world,player,message,{instanceId=null}={}){
    if(!player?._connected||world.players.get(player.id)!==player)throw new Error('聊天需要连接到当前角色');
    if(player._transferring)throw new Error('正在切换世界');
    const channel=message.channel??(instanceId?'instance':'global');
    if(!['map','global','instance'].includes(channel))throw new Error('未知聊天频道');
    if(channel==='global'&&instanceId)throw new Error('副本内请使用副本或地图频道');
    if(channel==='instance'&&!instanceId)throw new Error('当前不在副本内');
    const text=normalizeChatText(message.text),now=this.clock();
    if(now-this.lastCleanup>=CHAT_LIMITS.windowMs){for(const[id,times]of this.sent)if(times.at(-1)<=now-CHAT_LIMITS.windowMs)this.sent.delete(id);this.lastCleanup=now;}
    const times=(this.sent.get(player.id)||[]).filter(time=>time>now-CHAT_LIMITS.windowMs);
    if(times.length&&now-times.at(-1)<CHAT_LIMITS.minIntervalMs)throw new Error('发送太快，请稍候再试');
    if(times.length>=CHAT_LIMITS.windowMessages)throw new Error('聊天过于频繁，请稍候再试');
    this.sent.set(player.id,[...times,now]);
    const settings=chatSettings(world.content).popup;
    const packet={type:'chat',id:randomUUID(),senderId:player.id,senderName:player.name,text,channel,mapId:player.mapId,instanceId,createdAt:now,expiresAt:now+settings.fadeIn+settings.duration+settings.fadeOut};
    player._chatBubble={id:packet.id,text,mapId:player.mapId,createdAt:now,expiresAt:packet.expiresAt,...settings};
    for(const recipient of world.players.values())if(recipient._connected&&(channel!=='map'||recipient.mapId===player.mapId))world.send(recipient.id,packet);
    return packet;
  }
}

export function activeChatBubble(player,now){
  const bubble=player._chatBubble;
  if(!player._connected||!bubble||bubble.mapId!==player.mapId||bubble.expiresAt<=now)return null;
  return bubble;
}
