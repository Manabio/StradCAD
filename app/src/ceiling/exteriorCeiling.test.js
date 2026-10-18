// exteriorCeiling.js（屋外部屋の天井の述語・ON/OFF）の単体テスト。実物の PlanGraph / Room で組む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature, RoomKind } from '@core';
import {
  EXTERIOR_CEILING_KEY, isExteriorCeilingRoom, exteriorCeilingEnabled, setExteriorCeilingEnabled,
} from './exteriorCeiling.js';
import { makeGrid } from '../plan/planTestFixtures.js';

function outdoor(g, cells) {
  const room = g.interior(cells);
  room.setKind(RoomKind.EXTERIOR);
  return room;
}

test('述語: 屋外で feature なしだけが対象。屋内・屋根・屋外階段・昇降路・未定義・階段吹抜け・null は対象外', () => {
  const g = makeGrid([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000], [0, 1000]);
  assert.equal(isExteriorCeilingRoom(outdoor(g, [[0, 0]])), true);
  assert.equal(isExteriorCeilingRoom(g.interior([[1, 0]])), false, '屋内');
  assert.equal(isExteriorCeilingRoom(g.roof([[2, 0]])), false, '屋根');
  const stair = g.feature([[3, 0]], RoomFeature.STAIR);
  stair.setKind(RoomKind.EXTERIOR);
  assert.equal(isExteriorCeilingRoom(stair), false, '屋外階段');
  const ev = g.feature([[4, 0]], RoomFeature.ELEVATOR_EQUIPMENT);
  ev.setKind(RoomKind.EXTERIOR);
  assert.equal(isExteriorCeilingRoom(ev), false, '昇降路');
  const und = g.feature([[5, 0]], RoomFeature.UNDEFINED);
  und.setKind(RoomKind.EXTERIOR);
  assert.equal(isExteriorCeilingRoom(und), false, '未定義');
  const sv = g.feature([[6, 0]], RoomFeature.STAIR_VOID);
  sv.setKind(RoomKind.EXTERIOR);
  assert.equal(isExteriorCeilingRoom(sv), false, '階段吹抜け');
  assert.equal(isExteriorCeilingRoom(null), false);
  assert.equal(isExteriorCeilingRoom(undefined), false);
});

test('既定 ON（キー無し）。\'0\' で OFF。対象外の部屋は ON/OFF にかかわらず false', () => {
  const g = makeGrid([0, 1000, 2000], [0, 1000]);
  const porch = outdoor(g, [[0, 0]]);
  assert.equal(exteriorCeilingEnabled(porch), true);
  porch.setOverride(EXTERIOR_CEILING_KEY, '0');
  assert.equal(exteriorCeilingEnabled(porch), false);
  const inner = g.interior([[1, 0]]);
  assert.equal(exteriorCeilingEnabled(inner), false);
  const roof = g.roof([[1, 0]]);
  assert.equal(exteriorCeilingEnabled(roof), false);
});

test('set の往復: OFF は \'0\' を置き、ON はキーを消す（既定 ON はキー無し）', () => {
  const g = makeGrid([0, 1000], [0, 1000]);
  const porch = outdoor(g, [[0, 0]]);
  setExteriorCeilingEnabled(porch, false);
  assert.equal(porch.customOverrides.get(EXTERIOR_CEILING_KEY), '0');
  assert.equal(exteriorCeilingEnabled(porch), false);
  setExteriorCeilingEnabled(porch, true);
  assert.equal(porch.customOverrides.has(EXTERIOR_CEILING_KEY), false);
  assert.equal(exteriorCeilingEnabled(porch), true);
  setExteriorCeilingEnabled(porch, true); // 既に ON でも落ちない
  assert.equal(porch.customOverrides.size, 0);
});

test('【失敗系】getFinishInfo の無い物体・null・空オブジェクトは false（例外にしない）', () => {
  assert.equal(exteriorCeilingEnabled(null), false);
  assert.equal(exteriorCeilingEnabled(undefined), false);
  assert.equal(exteriorCeilingEnabled({}), false);
  assert.equal(exteriorCeilingEnabled({ kind: RoomKind.EXTERIOR, feature: null }), false, 'getFinishInfo が無い');
});
