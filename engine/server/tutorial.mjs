import {eventTags} from './event-tags.mjs';
import {addInventory} from './combat.mjs';
import {cloneState} from './world.mjs';

export const TUTORIAL_ID='rose-orientation';
const distance=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const lesson=(id,mapId,label,text,extra={})=>({id,mapId,label,text,...extra});
export const TUTORIAL_STEPS=Object.freeze([
  lesson('move-a',57,'沿步道抵达检查点 A','嗨，我是 ROSE！放学后的生存课，开跑啦！WASD／方向键移动，也能点地面寻路。先到蓝色检查点 A；金色水晶去下一课，绿色水晶可回头。',{checkpoint:'a'}),
  lesson('move-b',57,'绕过障碍，抵达检查点 B','转弯很稳嘛！接下来绕过水湾到 B。按住鼠标拖向新格子能改路线；键盘移动、右键或 Esc 都能取消寻路。',{checkpoint:'b'}),
  lesson('move-c',57,'穿过折返通道，抵达检查点 C','最后一段是折返通道，别只顾盯终点哦！跨过第二座窄桥，穿过障碍到 C。Tab／Esc 打开背包，菜单开着时世界仍会继续。',{checkpoint:'c'}),
  lesson('unarmed',58,'前往武器馆，空手击倒「拳脚训练员」','身法合格！进武器馆，先保持空手，面向拳脚训练员按 J／空格或「攻击」。点敌人也会自动靠近攻击；技能选「普通攻击」。',{weaponId:0,target:'unarmed',skillId:1}),
  lesson('slash',58,'装备借用的红杀铁剑，击倒「劈斩训练员」','打开背包装上红杀铁剑，这是课堂借用品！贴近劈斩训练员，用普通攻击横扫面前紧邻的三格。持剑移速慢 25%，先走位再出手，墙后打不到哦。',{weaponId:66,target:'slash',skillId:306}),
  lesson('throw',58,'装备回旋投刃，击倒「投掷训练员」','换回旋投刃试试！对准投掷训练员按普通攻击，直线投射最远六格，每次损耗一点耐久。障碍会挡住投射物，先找开阔角度。',{weaponId:61,target:'throw',skillId:301}),
  lesson('club',58,'装备重型棒槌，击倒「钝击训练员」','棒槌时间！装备重型棒槌，向钝击训练员挥一下。挥击覆盖身边两步以内的菱形区域，适合应付围攻；近战也要留意攻击间隔。',{weaponId:64,target:'club',skillId:304}),
  lesson('firearm',58,'装备短管火枪，击倒「枪械训练员」','装备短管火枪！对准枪械训练员，普通攻击发射子弹，最远八格，每发消耗一份制式弹药。背包里能看弹药，没弹可别硬按呀！',{weaponId:62,target:'firearm',skillId:302}),
  lesson('staff',58,'装备余烬法杖，击倒「杖术训练员」','最后是余烬法杖！对准杖术训练员发射魔法，最远七格，每发消耗四点 MP 和一点耐久。MP 不够时，背包里用恢复药。',{weaponId:63,target:'staff',skillId:303}),
  lesson('pickup',58,'拾取杖术训练员掉落的物品','漂亮！击倒 NPC 后，金币直接结算，掉落要自己拿。点杖术训练员留下的物品，或靠近按 E 拾取，然后去搜刮工坊。'),
  lesson('search',59,'前往搜刮工坊，搜刮教学物资箱','野外的箱子可不能漏！点教学物资箱，或贴近面向它按 E。箱子每局只发一次物资；配方书和材料都在里面。'),
  lesson('craft',59,'打开「合成」，制作 Curry Bread','收获不错！点击「合成」，找到 Curry Bread（咖喱面包），用刚找到的两种材料制作一次。配方书要放在背包里才行。'),
  lesson('use',59,'在背包里使用刚合成的 Curry Bread','热乎乎的咖喱面包，当然要尝一口！打开背包，找到 Curry Bread 点「使用」。恢复道具也在这里用；战斗中记得先找安全位置。'),
  lesson('final',60,'前往毕业演练场，击败所有演练对手','最后是实战！走进毕业演练场，利用转角和掩体，选顺手的武器击败所有对手。受伤了就用补给；我在这里给你加油！'),
  lesson('exit',60,'与毕业出口交互，完成教程','全员击破，毕业啦！到出口交互就能回城。首通会把「红杀铁剑」送进主世界背包；在主世界装备它，下次 DTS 开局就能拿到对应武器。持剑移速减 25%，一挥扫过面前三格！')
]);

/** Progress is owned by the private round; only committed gameplay actions can advance it. */
export class TutorialRuntime {
  constructor(round){this.round=round;this.index=0;this.completed=[];this.dropIds=new Set();this.finalDefeated=new Set();this.lastHint=new Map();}
  get world(){return this.round.world;}
  get step(){return TUTORIAL_STEPS[this.index];}
  active(player){return this.round.status==='active'&&player&&this.world.players.get(player.id)===player&&!player.dead&&!player._dying;}
  snapshot(){return{step:this.step.id,label:this.step.label,mapId:this.step.mapId,index:this.index,total:TUTORIAL_STEPS.length,completed:[...this.completed],hint:this.step.text};}
  hint(player,force=true){if(!this.active(player)||!player._connected)return;this.lastHint.set(player.id,this.round.clock());this.world.events.presentation.enqueueGab(player,{text:`\\C[27]ROSE：\\C[0]${this.step.text}`,compact:true,graphicType:'face',graphicName:'ROSE',graphicIndex:this.step.id==='exit'?7:this.step.id==='final'?2:1,soundName:'',switchId:0},force);}
  advance(player){if(!this.active(player)||this.index>=TUTORIAL_STEPS.length-1)return;this.completed.push(this.step.id);this.index++;this.round.phase='tutorial';this.hint(player);this.world.sendSnapshot(player);}
  decorate(map){
    for(const event of map.events.values()){
      const tags=eventTags(event.raw);event.tutorialTarget=tags.engine_tutorial_target;event.tutorialCheckpoint=tags.engine_tutorial_checkpoint;
      if(tags.engine_service?.toLowerCase()==='tutorialguide')event.service={kind:'round',action:'tutorialGuide'};
      if(tags.engine_service?.toLowerCase()==='tutorialexit')event.service={kind:'round',action:'tutorialExit'};
      if(tags.engine_service?.toLowerCase()==='tutorialcraft')event.service={kind:'round',action:'tutorialCraft'};
      if(event.tutorialTarget&&map.id===58){event._eventRouteOwner='tutorial-stationary-target';event.noRespawn=true;event.name=event.raw.name;event.customDrops=event.tutorialTarget==='staff'?[{kind:'item',itemId:102,quantity:1}]:[];}
      if(map.id===60&&event.enemyId)event.noRespawn=true;
    }
  }
  beforeTransfer(player,mapId){
    const allowed=this.step.mapId;
    if(mapId>allowed)throw new Error(`ROSE：先完成「${this.step.label}」，再去下一课。`);
  }
  beforeHit(source,target,skill,tool){
    if(!target.tutorialTarget||target.mapId!==58)return true;
    if(!this.active(source)||!source._connected||source.mapId!==58)return false;
    if(this.step.target!==target.tutorialTarget){this.wrongTarget(source);return false;}
    const correct=source.equips?.weapon===this.step.weaponId&&skill.id===this.step.skillId;
    if(!correct){this.wrongTarget(source);return false;}
    // Distinguish the two skill-1 tools even if equipment is changed mid-swing.
    if(this.step.id==='unarmed'&&tool?.id!==this.world.content.getToolForSkill(1)?.id)return false;
    target.tutorialQualified=this.step.id;return true;
  }
  wrongTarget(player){if(this.round.clock()-(this.lastWrong||0)>3000){this.lastWrong=this.round.clock();this.world.notice(player,`ROSE：先${this.step.label}，技能选「普通攻击」。`);}}
  onEnemyDeath(enemy,player,outcome){
    if(!this.active(player))return;
    if(enemy.mapId===58&&enemy.tutorialQualified===this.step.id&&enemy.tutorialTarget===this.step.target){
      if(this.step.id==='staff')for(const drop of outcome?.drops||[])this.dropIds.add(drop.id);
      this.advance(player);
    }else if(enemy.mapId===60&&this.step.id==='final'){
      this.finalDefeated.add(enemy.id);
      const enemies=[...this.world.maps.get(60).events.values()].filter(e=>e.enemyId);
      if(enemies.length&&enemies.every(e=>e.dead&&this.finalDefeated.has(e.id)))this.advance(player);
    }
  }
  onPickupAttempt(player,dropId,requestId){if(this.step.id==='pickup'&&this.dropIds.has(dropId))this.pendingPickup={dropId,requestId};}
  onPickup(player,drop){if(this.active(player)&&this.step.id==='pickup'&&player.mapId===58&&this.dropIds.has(drop.id)){this.pendingPickup=null;this.advance(player);}}
  onContainer(player,event,outcome){if(this.active(player)&&this.step.id==='search'&&player.mapId===59&&eventTags(event.raw).engine_container==='tutorial-supplies'&&(outcome.claimed||String(outcome.claimedBy)===String(player.id)))this.advance(player);}
  onCraft(player,recipe){if(this.active(player)&&this.step.id==='craft'&&player.mapId===59&&recipe?.id==='item:40')this.advance(player);}
  onUseItem(player,item){if(this.active(player)&&this.step.id==='use'&&player.mapId===59&&item.id===40)this.advance(player);}
  async interact(player,event){
    if(event.service.action==='tutorialGuide'){
      await this.restock(player);
      if(this.step.id==='pickup'&&this.pendingPickup){const pending=this.pendingPickup;try{await this.world.pickup(player,pending.dropId,pending.requestId);}catch(error){this.world.notice(player,`ROSE：拾取确认暂未完成：${error.message}`);}}
      // A failed NPC drop transaction leaves a dead target without a credited
      // lesson. A guide interaction waits for that player's queue, then retries
      // only these uncredited opponents; completed targets stay defeated.
      for(const target of this.world.maps.get(player.mapId)?.events.values()||[]){
        const uncredited=Boolean(this.step.target)&&this.step.target===target.tutorialTarget||this.step.id==='final'&&target.mapId===60&&target.enemyId&&!this.finalDefeated.has(target.id);
        if(target.dead&&uncredited)Object.assign(target,{dead:false,erased:false,hp:target.maxHp,x:target.homeX,y:target.homeY,respawnAt:Infinity});
      }
      if(this.step.id==='unarmed'&&player.equips?.weapon){await this.world.equip(player,'weapon',0);this.world.notice(player,'ROSE：空手练习先把武器收好，我帮你卸下啦。之后可在背包重新装备。');}
      this.hint(player);return true;
    }
    if(event.service.action==='tutorialCraft'){this.world.send(player.id,{type:'service',service:'craft',action:'open'});this.hint(player);return true;}
    if(event.service.action==='tutorialExit'){
      if(this.step.id!=='exit'||player.mapId!==60)throw new Error(`ROSE：先完成「${this.step.label}」。`);
      await this.round.host.finishRoundNow(this.round,{reason:'tutorial-completed',winnerId:player.id,success:true});return true;
    }
    return false;
  }
  async restock(player){
    // Training supplies stay in this isolated inventory and are never permanent rewards.
    if(this.round.clock()-(player._tutorialRestockedAt||0)<2000)return;
    player._tutorialRestockedAt=this.round.clock();
    const supplies=[{kind:'item',itemId:101,quantity:20},{kind:'item',itemId:14,quantity:3},{kind:'item',itemId:102,quantity:3},...[66,61,62,63,64].map(itemId=>({kind:'weapon',itemId,quantity:1}))];
    if(['craft','use'].includes(this.step.id))supplies.push(...[38,47,48].map(itemId=>({kind:'item',itemId,quantity:2})));
    if(this.step.id==='use')supplies.push({kind:'item',itemId:40,quantity:1});
    await this.world.enqueue(player,async()=>{
      const state=cloneState(player);
      for(const entry of supplies){const quantity=state.inventory.filter(i=>i.kind===entry.kind&&i.itemId===entry.itemId&&(!i.maxDurability||i.durability>0)).reduce((sum,i)=>sum+i.quantity,0);if(quantity<entry.quantity)addInventory(state,entry.kind,entry.itemId,entry.quantity-quantity);}
      this.world.recalculate(state);await this.world.store.savePlayer(player.id,state);this.world.adoptEconomy(player,state);
    });
  }
  update(){
    if(this.round.status!=='active')return;
    for(const player of this.world.players.values()){
      if(!player._connected){player.offlineBehavior='stay';continue;}
      if(!this.active(player))continue;
      if(this.step.checkpoint&&player.mapId===57){const checkpoint=[...this.world.maps.get(57).events.values()].find(e=>e.tutorialCheckpoint===this.step.checkpoint);if(checkpoint&&distance(player,checkpoint)<=1)this.advance(player);}
      if(this.round.clock()-(this.lastHint.get(player.id)||0)>=22000)this.hint(player);
    }
  }
}
