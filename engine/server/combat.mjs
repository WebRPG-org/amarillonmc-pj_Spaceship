import {randomUUID} from 'node:crypto';
/** Evaluate the arithmetic subset used by this project's damage formulas. No eval/Function. */
export function evaluateFormula(source, a, b, variables = {}) {
  const input = String(source || '0');
  const tokens = input.match(/\d+(?:\.\d+)?|[ab]\.(?:mhp|mmp|hp|mp|atk|def|mat|mdf|agi|luk|level)|v\[\d+\]|[()+\-*/%]/g) || [];
  if (tokens.join('') !== input.replace(/\s/g, '')) throw new Error(`Unsupported damage formula: ${input}`);
  let index = 0;
  function primary() {
    const token = tokens[index++];
    if (token === '+' || token === '-') return (token === '-' ? -1 : 1) * primary();
    if (token === '(') { const value = sum(); if (tokens[index++] !== ')') throw new Error('Unclosed formula group'); return value; }
    if (/^\d/.test(token || '')) return Number(token);
    if (/^[ab]\./.test(token || '')) { const [who, key] = token.split('.'); return Number((who === 'a' ? a : b)[key] || 0); }
    if (/^v\[/.test(token || '')) return Number(variables[token.slice(2, -1)] || 0);
    throw new Error('Invalid damage formula');
  }
  function product() { let value = primary(); while (['*','/','%'].includes(tokens[index])) { const op=tokens[index++], right=primary(); value=op==='*'?value*right:op==='/'?value/right:value%right; } return value; }
  function sum() { let value = product(); while (['+','-'].includes(tokens[index])) { const op=tokens[index++], right=product(); value=op==='+'?value+right:value-right; } return value; }
  const result=sum(); if(index!==tokens.length || !Number.isFinite(result)) throw new Error('Invalid formula result');
  return Math.max(0, result);
}

export function battlerStats(entity) {
  return { ...(entity.stats || {}), hp:entity.hp, mp:entity.mp, mhp:entity.maxHp, mmp:entity.maxMp, level:entity.level || 1 };
}

export function computeDamage(skill, source, target, random = Math.random) {
  if (!skill?.damage?.type) return { value:0, missed:false, critical:false };
  if (random()*100 >= (skill.successRate ?? 100)) return {value:0,missed:true,critical:false};
  let value=evaluateFormula(skill.damage.formula,battlerStats(source),battlerStats(target),source.variables);
  const critical=!!skill.damage.critical && random()<.05;
  if(critical)value*=3;
  const variance=Math.max(0, Math.min(100,Number(skill.damage.variance)||0))/100;
  value*=1+(random()*2-1)*variance;
  return {value:Math.max(0,Math.round(value)),critical,missed:false};
}

export function addInventory(state, kind, itemId, quantity, metadata={}) {
  if(!['item','weapon','armor'].includes(kind)||!Number.isSafeInteger(itemId)||itemId<=0||!Number.isSafeInteger(quantity))throw new Error('Invalid inventory operation');
  state.inventory ||= [];
  if(kind==='weapon'){
    if(quantity>0)for(let n=0;n<quantity;n++)state.inventory.push({...structuredClone(metadata),kind,itemId,quantity:1,instanceId:n?randomUUID():(metadata.instanceId||randomUUID())});
    else {
      const candidates=state.inventory.filter(i=>i.kind===kind&&i.itemId===itemId&&(!metadata.instanceId||i.instanceId===metadata.instanceId));
      if(candidates.reduce((n,i)=>n+i.quantity,0)<-quantity)throw new Error('物品数量不足');
      let left=-quantity;for(const item of candidates){const take=Math.min(item.quantity,left);item.quantity-=take;left-=take;if(!left)break;}
      state.inventory=state.inventory.filter(i=>i.quantity>0);
    }
    return;
  }
  const entry=state.inventory.find(i=>i.kind===kind&&i.itemId===itemId),current=entry?.quantity||0;
  if(current+quantity<0)throw new Error('物品数量不足');
  if(entry)entry.quantity+=quantity;else if(quantity>0)state.inventory.push({kind,itemId,quantity});
  state.inventory=state.inventory.filter(i=>i.quantity>0);
}

export function applyRecipe(state, recipe, database) {
  if(!recipe)throw new Error('配方不存在');
  if(recipe.books?.length && !recipe.books.some(id=>state.inventory?.some(i=>i.kind==='item'&&i.itemId===id&&i.quantity>0)))throw new Error('尚未持有配方书');
  if(recipe.level && (state.level||1)<recipe.level)throw new Error('等级不足');
  // Work on a copy: failed validation cannot partially consume the caller's state.
  const next=structuredClone(state);
  for(const ingredient of recipe.ingredients) {
    const amount=Number(ingredient.amount ?? ingredient.quantity);
    if(!Number.isSafeInteger(amount)||amount<=0)throw new Error('配方数量无效');
    if(ingredient.kind==='gold'){if((next.gold||0)<amount)throw new Error('金币不足');next.gold-=amount;}
    else addInventory(next,ingredient.kind,ingredient.itemId,-amount);
  }
  const result=recipe.result, db=database[{item:'Items',weapon:'Weapons',armor:'Armors'}[result.kind]];
  if(!db?.[result.itemId])throw new Error('配方产物不存在');
  addInventory(next,result.kind,result.itemId,Number(result.amount ?? result.quantity ?? 1));
  Object.assign(state,next); return {kind:result.kind,itemId:result.itemId,quantity:Number(result.amount ?? result.quantity ?? 1)};
}
