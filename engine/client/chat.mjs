export const CHAT_HISTORY_LIMIT=100;
const labels={global:'公共',map:'地图',instance:'副本'};

export class ChatLog{
  constructor(){this.messages=[];this.snapshot=null;}
  updateSnapshot(snapshot){
    if(this.snapshot?.playerId!==snapshot?.playerId)this.messages=[];
    this.snapshot=snapshot;
  }
  receive(packet){
    if(packet?.type!=='chat'||typeof packet.id!=='string'||typeof packet.text!=='string'||typeof packet.senderName!=='string'||!labels[packet.channel])return null;
    if(packet.text.length>1120||packet.senderName.length>200||this.messages.some(m=>m.id===packet.id))return null;
    const snapshot=this.snapshot;
    if(!snapshot||(packet.instanceId||null)!==(snapshot.instance?.id||null)||(packet.channel==='map'&&packet.mapId!==snapshot.mapId))return null;
    const message={id:packet.id,senderId:packet.senderId,senderName:packet.senderName,text:packet.text,channel:packet.channel,createdAt:packet.createdAt};
    this.messages.push(message);if(this.messages.length>CHAT_HISTORY_LIMIT)this.messages.shift();return message;
  }
}

/** DOM text nodes only: player messages deliberately bypass rich event text. */
export function createChatUI({mount,send,onFocusChange=()=>{},canFocus=()=>true}){
  const doc=mount.ownerDocument,log=new ChatLog();let available=false,collapsed=false,scope=null,composing=false,compositionSubmit=false;
  const make=(tag,className,text)=>{const element=doc.createElement(tag);if(className)element.className=className;if(text)element.textContent=text;return element;};
  const root=make('section','chat-panel'),header=make('div','chat-header'),title=make('strong','','玩家聊天'),toggle=make('button','chat-toggle','收起 · F8');
  toggle.type='button';toggle.setAttribute('aria-expanded','true');
  const body=make('div','chat-body'),history=make('div','chat-history'),empty=make('p','chat-empty','Enter 开始聊天，Esc 结束输入。');
  history.setAttribute('role','log');history.setAttribute('aria-live','polite');history.setAttribute('aria-relevant','additions');history.setAttribute('aria-label','聊天记录');history.append(empty);
  const form=make('form','chat-form'),channel=make('select','chat-channel'),input=make('input','chat-input'),submit=make('button','chat-send','发送'),status=make('p','chat-status');
  channel.setAttribute('aria-label','聊天频道');input.type='text';input.maxLength=560;input.autocomplete='off';input.setAttribute('aria-label','聊天内容');input.placeholder='输入消息…';submit.type='submit';status.setAttribute('role','status');
  header.append(title,toggle);form.append(channel,input,submit);body.append(history,form,status);root.append(header,body);mount.append(root);root.hidden=true;
  const focus=()=>{if(available&&canFocus()){collapsed=false;body.hidden=false;toggle.textContent='收起 · F8';toggle.setAttribute('aria-expanded','true');input.focus();}};
  const toggleBody=()=>{collapsed=!collapsed;body.hidden=collapsed;toggle.textContent=collapsed?'展开 · F8':'收起 · F8';toggle.setAttribute('aria-expanded',String(!collapsed));if(collapsed&&root.contains(doc.activeElement))doc.activeElement.blur();};
  toggle.addEventListener('click',toggleBody);
  root.addEventListener('focusin',()=>onFocusChange(true));
  root.addEventListener('focusout',event=>{if(!root.contains(event.relatedTarget))onFocusChange(false);});
  input.addEventListener('compositionstart',()=>{composing=true;});
  input.addEventListener('compositionend',()=>{composing=false;});
  input.addEventListener('keyup',event=>{if(event.code==='Enter')compositionSubmit=false;});
  input.addEventListener('keydown',event=>{
    if(composing||event.isComposing||event.keyCode===229){if(event.code==='Enter'||event.key==='Enter')compositionSubmit=true;event.stopPropagation();return;}
    compositionSubmit=false;
    if(event.code==='Escape'){event.preventDefault();event.stopPropagation();input.blur();}
    else if(event.code==='Enter')event.stopPropagation();
  });
  const onSubmit=event=>{
    event.preventDefault();if(!available||composing||compositionSubmit){compositionSubmit=false;return;}
    const text=input.value.trim(),length=[...text].length,max=log.snapshot?.chat?.maxLength||280;
    if(!length)return;if(length>max){status.textContent=`最多 ${max} 个字符（当前 ${length}）`;return;}
    if(send({type:'chat',channel:channel.value,text})===false){status.textContent='连接尚未就绪';return;}
    status.textContent='';input.value='';input.blur();
  };
  form.addEventListener('submit',onSubmit);
  const onKey=event=>{
    if(!available||event.repeat||event.isComposing||event.keyCode===229||event.ctrlKey||event.altKey||event.metaKey)return;
    if(event.code==='F8'){event.preventDefault();event.stopPropagation();toggleBody();return;}
    if(event.code!=='Enter'||!canFocus()||event.target?.closest?.('input,textarea,select,button,[contenteditable="true"]'))return;
    event.preventDefault();event.stopPropagation();focus();
  };
  doc.addEventListener('keydown',onKey,true);
  function renderHistory(){history.replaceChildren(empty);for(const message of log.messages)appendMessage(message);}
  function appendMessage(message){
    empty.remove();const row=make('p','chat-message'),name=make('strong','chat-name',`[${labels[message.channel]}] ${message.senderName}：`),text=make('span','chat-text',message.text);row.append(name,text);history.append(row);
    while(history.children.length>CHAT_HISTORY_LIMIT)history.firstElementChild.remove();history.scrollTop=history.scrollHeight;
  }
  return {element:root,log,focus,
    receive(packet){const message=log.receive(packet);if(message)appendMessage(message);return !!message;},
    updateSnapshot(snapshot){
      const previousPlayer=log.snapshot?.playerId;log.updateSnapshot(snapshot);if(previousPlayer!==snapshot?.playerId)renderHistory();
      const nextScope=snapshot?.instance?.id||null;
      if(scope!==nextScope||!channel.options.length){scope=nextScope;channel.replaceChildren();for(const key of [scope?'instance':'global','map']){const option=make('option','',labels[key]);option.value=key;channel.append(option);}input.value='';status.textContent='';}
      root.dataset.position=(snapshot?.chat?.position||'BOTTOM LEFT').toLowerCase().replace(' ','-');
    },
    setAvailable(value){available=!!value;root.hidden=!available;input.disabled=!available;submit.disabled=!available;if(!available&&root.contains(doc.activeElement))doc.activeElement.blur();},
    clear(){log.messages=[];log.snapshot=null;input.value='';status.textContent='';scope=null;composing=false;compositionSubmit=false;channel.replaceChildren();renderHistory();},
    destroy(){doc.removeEventListener('keydown',onKey,true);onFocusChange(false);root.remove();}
  };
}
