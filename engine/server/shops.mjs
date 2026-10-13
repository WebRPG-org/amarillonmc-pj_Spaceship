import {addInventory} from './combat.mjs';

const databases={item:'Items',weapon:'Weapons',armor:'Armors'};
export const shopAllowed=(world,shop)=>!!shop&&(shop.scope==='world'?!world.scenario:shop.scope==='dts'?world.scenario?.type==='dts':!shop.scope);
export function bindShopTag(world,event,text){
  const key=text.match(/engine_shop\s*:\s*([\w-]+)/i)?.[1];if(!key)return;
  event.shopTag=key;
  if(shopAllowed(world,world.content.gameplay?.shops?.[key]))event.service={kind:'shop',shopId:key};
}
function nearbyShop(world,player,shopId,eventId){
  if(player.dead||player._dying||player._transferring)throw new Error('当前无法交易');
  const event=world.maps.get(player.mapId)?.events.get(eventId);
  if(!event||event.erased||event.service?.kind!=='shop'||event.service.shopId!==shopId||Math.abs(player.x-event.x)+Math.abs(player.y-event.y)>1)throw new Error('请靠近对应商店再交易');
  const page=world.events.pageFor(player,event,player.mapId);if(!page||page.engineDisabledReason)throw new Error('商店当前不可用');
  const shop=world.content.gameplay?.shops?.[shopId];if(!shopAllowed(world,shop))throw new Error('商店在当前世界不可用');
  return shop;
}
function goodsFor(world,shop){return(shop.goods||[]).filter(g=>databases[g.kind]&&world.content.database[databases[g.kind]]?.[g.itemId]&&Number.isSafeInteger(g.price)&&g.price>=0);}
export function openShop(world,player,event){
  const shopId=event.service.shopId,shop=nearbyShop(world,player,shopId,event.id);
  world.send(player.id,{type:'shop',eventId:event.id,shop:{id:shopId,name:shop.name||'商店',goods:goodsFor(world,shop),buyOnly:!!shop.buyOnly,sellRate:Math.max(0,Math.min(1,Number(shop.sellRate??.5)))}});
}
export function tradeAtShop(world,player,message,serialize){
  return world.enqueue(player,async()=>{
    const {shopId,eventId,kind,instanceId,requestId,action}=message,itemId=Number(message.itemId),quantity=Number(message.quantity);
    world.validateRequest(requestId);
    if(!['buy','sell'].includes(action)||!databases[kind]||!Number.isSafeInteger(itemId)||!Number.isSafeInteger(quantity)||quantity<1||quantity>999)throw new Error('无效交易内容或数量');
    nearbyShop(world,player,shopId,eventId);
    await world.store.savePlayer(player.id,serialize(player));
    const outcome=await world.store.commitPlayer(player.id,requestId,state=>{
      const shop=nearbyShop(world,player,shopId,eventId),goods=goodsFor(world,shop).find(g=>g.kind===kind&&g.itemId===itemId);
      if(!goods)throw new Error('该商店不交易此物品');
      if(action==='sell'&&shop.buyOnly)throw new Error('该商店不收购物品');
      const price=action==='buy'?goods.price:Math.floor(goods.price*Math.max(0,Math.min(1,Number(shop.sellRate??.5))));
      const total=price*quantity;if(!Number.isSafeInteger(total))throw new Error('交易金额无效');
      if(action==='buy'){
        if((state.gold||0)<total)throw new Error('金币不足');state.gold-=total;addInventory(state,kind,itemId,quantity);
      }else{
        if(kind==='weapon'&&(quantity!==1||typeof instanceId!=='string'))throw new Error('请选择一件具体武器出售');
        const entry=state.inventory.find(i=>i.kind===kind&&i.itemId===itemId&&(!instanceId||i.instanceId===instanceId));
        if(!entry)throw new Error('没有该物品');
        addInventory(state,kind,itemId,-quantity,kind==='weapon'?{instanceId}:{});
        if(!Number.isSafeInteger((state.gold||0)+total))throw new Error('金币数量超出上限');state.gold=(state.gold||0)+total;
        if(state.equips?.[kind]===itemId&&(!state.inventory.some(i=>i.kind===kind&&i.itemId===itemId)||kind==='weapon'&&state.equips.weaponInstanceId===instanceId)){state.equips[kind]=0;if(kind==='weapon')state.equips.weaponInstanceId=null;}
      }
      return {action,kind,itemId,quantity,total};
    });
    if(!outcome.duplicate)world.adoptEconomy(player,outcome.state);
    world.notice(player,outcome.duplicate?'这笔交易已经完成':action==='buy'?'购买成功':'出售成功');
    world.sendSnapshot(player);return outcome;
  });
}
