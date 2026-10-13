import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../../data/',import.meta.url);
const db={};for(const name of ['Items','Weapons','Armors','Skills'])db[name]=JSON.parse(await readFile(new URL(`${name}.json`,root),'utf8'));
function put(kind,entry){const existing=db[kind][entry.id];if(existing?.name&&existing.name!==entry.name)throw new Error(`${kind} ${entry.id} is already ${existing.name}`);db[kind][entry.id]=entry;}
const damage={critical:false,elementId:0,formula:'0',type:0,variance:0};
const item={animationId:0,consumable:true,damage,hitType:0,occasion:0,repeats:1,scope:7,speed:0,successRate:100,tpGain:0,itypeId:1,note:''};
put('Items',{...item,id:102,name:'面包',description:'回复350点HP。DTS与基础状态冒险的出发口粮。',iconIndex:244,price:10,effects:[{code:11,dataId:0,value1:0,value2:350}]});
put('Items',{...item,id:103,name:'矿泉水',description:'回复60点MP。补充MP后可以再次使用飞火流星。',iconIndex:179,price:10,effects:[{code:12,dataId:0,value1:0,value2:60}]});
put('Items',{...item,id:104,name:'废城档案磁盘',description:'带回城郊撤离信标完成回收。仅属于本次冒险，不能带回主世界。',iconIndex:190,price:0,consumable:false,itypeId:2,scope:0,effects:[]});
put('Weapons',{id:65,name:'飞火流星',description:'户外使用消耗全部MP，引导10秒后向本人当前位置召唤陨石，九格范围内敌我皆伤，伤害为消耗MP×8。死亡或进入室内取消且不返MP。',iconIndex:97,animationId:123,etypeId:1,wtypeId:1,price:0,params:[0,0,0,0,0,0,0,0],traits:[],note:'<engineWeapon:meteor>'});
put('Armors',{id:121,name:'校服',description:'每次DTS和基础状态冒险的初始服装。',iconIndex:135,atypeId:1,etypeId:4,price:0,params:[0,0,0,4,0,2,0,0],traits:[],note:''});
put('Skills',{...db.Skills[1],id:305,name:'飞火流星',description:'消耗全部MP，10秒后以本人当前位置召唤陨石。敌我不分；室内不能使用，死亡或进室内中断。',iconIndex:97,animationId:123,mpCost:0,tpCost:0,note:'<engineAbility:meteor>'});
db.Items[38].description='随身携带此书解锁基础配方。点击侧栏「合成」查看材料与制作。';
db.Items[40].description='咖喱面包：回复自身90%HP和90%MP。';
db.Items[41].description='珍珠奶茶：回复自身90%HP和90%MP。';
db.Items[42].description='法棍：回复自身90%HP和90%MP。';
db.Items[44].effects=db.Items[44].effects.filter((effect,index,array)=>array.findIndex(other=>JSON.stringify(other)===JSON.stringify(effect))===index);
db.Items[44].description='解除中毒，并完全回复自身HP。';
// Keep RPG Maker's one-entry-per-line layout so native saves and Git diffs stay readable.
for(const [name,entries]of Object.entries(db))await writeFile(new URL(`${name}.json`,root),'[\n'+entries.map(entry=>JSON.stringify(entry)).join(',\n')+'\n]\n');
console.log('Added beta provisions, school uniform, disk and meteor weapon.');
