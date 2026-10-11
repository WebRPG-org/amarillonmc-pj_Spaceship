import test from 'node:test';
import assert from 'node:assert/strict';
import {findPath, getPortals} from '../server/navigation.mjs';

function fixture({blocked = [], portals = [], loop = false} = {}) {
  const raw = {width: 8, height: 6}, walls = new Set(blocked.map(p => p.join(',')));
  const events = new Map(portals.map((p, i) => [`portal${i}`, {id: `portal${i}`, x: p.x, y: p.y, page: {trigger: 1, list: [{code:201,parameters:[0,2,1,1,2,0]}, ...(p.extra || [])]}}]));
  const world = {
    maps: new Map([[1, {events}]]),
    events: {pageFor: (entity, event) => event.page},
    content: {getMap: id => id === 1 || id === 2 ? raw : null, wrapPosition: (id, x, y) => loop ? {x: (x + 8) % 8, y: (y + 6) % 6} : {x, y}},
    canMove: (entity, direction) => {
      const [dx, dy] = {2:[0,1],4:[-1,0],6:[1,0],8:[0,-1]}[direction];
      const p = world.content.wrapPosition(1, entity.x + dx, entity.y + dy);
      return p.x >= 0 && p.x < 8 && p.y >= 0 && p.y < 6 && !walls.has(`${p.x},${p.y}`);
    }
  };
  return {world, entity: {id:'player',mapId:1,x:0,y:0}, walls};
}
function follow(world, entity, path) {
  const p = {...entity}; for (const direction of path) {
    assert.ok(world.canMove(p, direction));
    const [dx,dy] = {2:[0,1],4:[-1,0],6:[1,0],8:[0,-1]}[direction]; Object.assign(p, world.content.wrapPosition(1,p.x+dx,p.y+dy));
  } return p;
}

test('pointer and offline paths follow authoritative collision and stop within interaction range', () => {
  const {world, entity, walls} = fixture({blocked:[[1,0],[1,1],[1,2],[4,0]]});
  const path = findPath(world, entity, {x:4,y:0,range:1});
  assert.ok(path.length > 4); const goal = follow(world,entity,path);
  assert.equal(Math.abs(goal.x-4)+Math.abs(goal.y),1);
  walls.add('0,1'); assert.equal(findPath(world,entity,{x:4,y:0,range:1}),null);
});

test('paths avoid unrelated touch portals and explicitly permit a blocked terminal portal', () => {
  const {world, entity} = fixture({portals:[{x:1,y:0},{x:4,y:0}],blocked:[[4,0]]});
  assert.deepEqual(getPortals(world,entity), [{x:1,y:0,mapId:2,targetX:1,targetY:1,eventId:'portal0'}, {x:4,y:0,mapId:2,targetX:1,targetY:1,eventId:'portal1'}]);
  const normal = findPath(world,entity,{x:3,y:0});
  assert.notEqual(normal[0],6); assert.equal(follow(world,entity,normal).x,3);
  assert.equal(findPath(world,entity,{x:4,y:0}),null);
  const portal = findPath(world,entity,{x:4,y:0,allowBlockedGoal:true});
  assert.ok(portal); const before = follow(world,entity,portal.slice(0,-1));
  const [dx,dy] = {2:[0,1],4:[-1,0],6:[1,0],8:[0,-1]}[portal.at(-1)];
  assert.deepEqual({x:before.x+dx,y:before.y+dy},{x:4,y:0});
});

test('routing never guesses conditional transfers and rejects invalid or unbounded search inputs', () => {
  const {world,entity} = fixture({portals:[{x:1,y:0,extra:[{code:111,parameters:[]}]}]});
  assert.deepEqual(getPortals(world,entity),[]);
  assert.notEqual(findPath(world,entity,{x:2,y:0})[0],6);
  assert.equal(findPath(world,entity,{x:7,y:5,maxNodes:1}),null);
  assert.equal(findPath(world,entity,{x:NaN,y:1}),null);
  assert.equal(findPath(world,entity,{x:8,y:1}),null);
  assert.deepEqual(findPath(world,entity,{x:0,y:0}),[]);
  const loop=fixture({loop:true});assert.deepEqual(findPath(loop.world,loop.entity,{x:7,y:0}),[4]);
});
