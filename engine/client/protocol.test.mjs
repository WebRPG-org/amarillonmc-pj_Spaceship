import test from 'node:test';
import assert from 'node:assert/strict';
import { zoneView } from './protocol.mjs';

test('forbidden-zone warning switches on at server startsAt, then clears after endsAt', () => {
  const zone = { startsAt: 10_000, endsAt: 40_000, damage: 10 };
  assert.deepEqual(zoneView(zone, 0), { visible: true, active: false, seconds: 10 });
  assert.deepEqual(zoneView(zone, 9_999), { visible: true, active: false, seconds: 1 });
  assert.deepEqual(zoneView(zone, 10_000), { visible: true, active: true, seconds: 30 });
  assert.deepEqual(zoneView(zone, 39_001), { visible: true, active: true, seconds: 1 });
  assert.deepEqual(zoneView(zone, 40_000), { visible: true, active: true, seconds: 0 });
  assert.deepEqual(zoneView(zone, 40_001), { visible: false, active: false, seconds: 0 });
  assert.equal(zoneView(null, 10_000).visible, false);
});

test('zone display never substitutes a browser clock for a missing authoritative clock', () => {
  assert.equal(zoneView({ startsAt: 10_000 }, undefined).visible, false);
  assert.deepEqual(zoneView({ active: false, startsAt: 10_000 }, 20_000), { visible: true, active: false, seconds: 0 });
  assert.deepEqual(zoneView({ active: true }, 20_000), { visible: true, active: true, seconds: null });
});

import { sceneKey, withCommandContext } from './protocol.mjs';
test('same map number in different instances has a separate renderer identity',()=>{
  assert.notEqual(sceneKey({mapId:11,instance:null}),sceneKey({mapId:11,instance:{id:'round-a'}}));
  assert.notEqual(sceneKey({mapId:11,instance:{id:'round-a'}}),sceneKey({mapId:11,instance:{id:'round-b'}}));
  assert.equal(sceneKey({mapId:11,instance:{id:'round-a',remainingSeconds:30}}),sceneKey({mapId:11,instance:{id:'round-a',remainingSeconds:29}}));
});
test('ordinary commands carry their source world while join commands keep their target room',()=>{
  const a={mapId:11,instance:{id:'round-a'}};
  assert.deepEqual(withCommandContext({type:'pickup',entityId:'bag'},a),{type:'pickup',entityId:'bag',contextInstanceId:'round-a'});
  assert.deepEqual(withCommandContext({type:'move',direction:2},{instance:null}),{type:'move',direction:2,contextInstanceId:null});
  assert.deepEqual(withCommandContext({type:'instance',action:'join',instanceId:'round-b'},a),{type:'instance',action:'join',instanceId:'round-b',contextInstanceId:'round-a'});
});
