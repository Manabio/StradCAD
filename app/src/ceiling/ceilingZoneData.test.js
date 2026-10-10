// 天井区画（Room.ceilingZones）を Room の項目として列挙する箇所の網羅テスト（undo スナップショット・未定義化・読む側の交差・
// 分割の細分化・部分指定の入れ替え）。FBS の往復は graphSnapshot.test.js、書込みの組み立ては ceilingZones.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CeilingZone, CEILING_ZONE_KEYS, CenterLineType } from '@core';
import { undoManager } from '../undoManager.js';
import { withFinishUndo, snapshotFinishState, restoreFinishState } from '../finish/finishUndo.js';
import { makeRoomUndefined } from '../finish/roomUndefined.js';
import { normalizePartialDominance } from '../finish/roomReinterpret.js';
import { assignZoneShape, clearZoneCells } from './ceilingZones.js';
import { ceilingSurfacesOf } from './ceilingSurfaces.js';
import { makeGrid, ARCH, rect, assignZoneHeight } from '../plan/planTestFixtures.js';

const FULL = { id: 'z1', heightMm: 2700, shape: 'slope', dims: [1200, 270] };

test('不変条件: 仕上げ undo の snapshot の room.ceilingZones[0] のキー集合は CEILING_ZONE_KEYS と一致する', () => {
  const g = makeGrid([0, 1000], [0, 1000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones([new CeilingZone({ ...FULL, cells: [g.cell(0, 0)] })]);
  const [roomSnap] = snapshotFinishState(g.graph).rooms.rooms;
  assert.deepStrictEqual(Object.keys(roomSnap.ceilingZones[0]).sort(), [...CEILING_ZONE_KEYS].sort(),
    'CeilingZone に項目を足したら toData/fromData（唯一の定義）に足す。snapshotRoomsState は toData をそのまま採る');
});

test('不変条件: 全項目を既定以外にした区画は snapshot→restore→snapshot で一致し、各項目が復元される', () => {
  const g = makeGrid([0, 1000], [0, 1000]);
  const room = g.interior([[0, 0]]);
  const fixture = { ...FULL, cells: [g.cell(0, 0)] };
  const defaults = new CeilingZone({ id: 'd' });
  for (const k of CEILING_ZONE_KEYS) {
    if (k !== 'id') assert.notDeepStrictEqual(fixture[k], defaults[k], '前提: fixture の ' + k + ' は既定以外');
  }
  room.setCeilingZones([new CeilingZone(fixture)]);
  const before = snapshotFinishState(g.graph);
  room.setCeilingZones([]);
  restoreFinishState(g.graph, before);
  const restored = g.graph.roomMap.get(room.id).ceilingZones;
  assert.deepStrictEqual(restored.map(z => z.toData()), [{ ...fixture, cells: [...fixture.cells] }]);
  assert.equal(JSON.stringify(snapshotFinishState(g.graph)), JSON.stringify(before));
});

test('undo: withFinishUndo で区画を足すと 1 エントリ。undo で空、redo で戻る。差分が無ければエントリを積まない', () => {
  const g = makeGrid([0, 1000, 2000], [0, 1000]);
  const room = g.interior([[0, 0], [1, 0]]);
  const c0 = g.cell(0, 0);
  const stack = undoManager._undoStack.length;
  withFinishUndo(g.graph, () => room.setCeilingZones(assignZoneHeight(g.graph, room, [c0], 2400)));
  assert.equal(undoManager._undoStack.length, stack + 1);
  const id = room.ceilingZones[0].id;
  undoManager.undo();
  assert.deepEqual([...g.graph.roomMap.get(room.id).ceilingZones], []);
  undoManager.redo();
  const back = g.graph.roomMap.get(room.id).ceilingZones;
  assert.deepEqual(back.map(z => [z.id, z.cells, z.heightMm]), [[id, [c0], 2400]], 'redo で同じ id・セル・高さに戻る');

  // 差分なし: 区画の無い選択を解除してもエントリは積まない
  const before = undoManager._undoStack.length;
  const live = g.graph.roomMap.get(room.id); // undo/redo で Room は作り直されるため引き直す
  withFinishUndo(g.graph, () => live.setCeilingZones(clearZoneCells(g.graph, live, [g.cell(1, 0)])));
  assert.equal(undoManager._undoStack.length, before, '差分なしなら積まない');
  undoManager.undo(); // 後続のテストに積みっぱなしにしない
});

test('傾斜の区画（S6a）: undo/redo で shape・dims が戻る。同じ形状・寸法での再確定は不変で undo を積まない', () => {
  const g = makeGrid([0, 1000, 2000], [0, 1000]);
  const room = g.interior([[0, 0], [1, 0]]);
  const cells = [g.cell(0, 0), g.cell(1, 0)];
  const spec = { heightMm: 2300, shape: 'slope', dims: [1200, 270] };
  const stack = undoManager._undoStack.length;
  withFinishUndo(g.graph, () => room.setCeilingZones(assignZoneShape(g.graph, room, cells, spec)));
  assert.equal(undoManager._undoStack.length, stack + 1);
  const before = room.ceilingZones.map(z => z.toData());
  withFinishUndo(g.graph, () => room.setCeilingZones(assignZoneShape(g.graph, room, cells, spec)));
  assert.equal(undoManager._undoStack.length, stack + 1, '再確定は積まない');
  assert.deepEqual(room.ceilingZones.map(z => z.toData()), before);
  undoManager.undo();
  assert.deepEqual([...g.graph.roomMap.get(room.id).ceilingZones], []);
  undoManager.redo();
  assert.deepEqual(g.graph.roomMap.get(room.id).ceilingZones.map(z => z.toData()), before, 'shape・dims・高さが戻る');
  undoManager.undo();
});

test('区画全体を同じ高さで再確定しても区画配列（id・cells）は不変で、withFinishUndo はエントリを積まない', () => {
  const g = makeGrid([0, 1000, 2000], [0, 1000]);
  const room = g.interior([[0, 0], [1, 0]]);
  const cells = [g.cell(0, 0), g.cell(1, 0)];
  room.setCeilingZones(assignZoneHeight(g.graph, room, cells, 2600));
  const before = room.ceilingZones.map(z => z.toData());
  const stack = undoManager._undoStack.length;
  withFinishUndo(g.graph, () => room.setCeilingZones(assignZoneHeight(g.graph, room, cells, 2600)));
  assert.deepEqual(room.ceilingZones.map(z => z.toData()), before, 'id も cells も不変');
  assert.equal(undoManager._undoStack.length, stack, 'undo エントリを積まない');
  // 一部だけ別の高さへ→同じ高さの区画が id を保ったまま残りを受ける
  room.setCeilingZones(assignZoneHeight(g.graph, room, [cells[1]], 2800));
  room.setCeilingZones(assignZoneHeight(g.graph, room, [cells[1]], 2600));
  assert.equal(room.ceilingZones.length, 1);
  assert.equal(room.ceilingZones[0].id, before[0].id, '元の区画へ足し戻す（id 維持）');
});

test('makeRoomUndefined: 天井区画も空になる', () => {
  const g = makeGrid([0, 1000], [0, 1000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones(assignZoneHeight(g.graph, room, [g.cell(0, 0)], 2400));
  assert.equal(room.ceilingZones.length, 1);
  makeRoomUndefined(room);
  assert.deepEqual([...room.ceilingZones], []);
});

test('Z1（読む側の交差）: 部屋のセルが減ると区画のデータは残るが描画から外れ、セルを戻すと描画も戻る', () => {
  const g = makeGrid([0, 1000, 2000], [0, 1000]);
  const room = g.interior([[0, 0], [1, 0]]);
  const [c0, c1] = [g.cell(0, 0), g.cell(1, 0)];
  room.setCeilingZones(assignZoneHeight(g.graph, room, [c1], 2700));
  const zoneOf = () => ceilingSurfacesOf(g.graph).filter(s => s.zoneId);
  assert.deepEqual(zoneOf().map(s => s.rects), [[rect(1000, 0, 2000, 1000)]]);

  room.setCells(new Set([c0]));
  assert.equal(room.ceilingZones.length, 1, 'データは残る（setCells では間引かない）');
  assert.deepEqual(zoneOf(), [], '描画からは外れる');
  assert.deepEqual(ceilingSurfacesOf(g.graph).map(s => [s.zoneId, s.rects]), [[null, [rect(0, 0, 1000, 1000)]]]);

  room.setCells(new Set([c0, c1]));
  assert.deepEqual(zoneOf().map(s => s.rects), [[rect(1000, 0, 2000, 1000)]], 'セルを戻すと描画も戻る');
});

test('Z1: 別の部屋に取られたセル（buildCellToRoom の帰属が他の部屋）は、区画に入っていても描画しない', () => {
  const g = makeGrid([0, 1000, 2000], [0, 1000]);
  const a = g.interior([[0, 0], [1, 0]]);
  const [, c1] = [g.cell(0, 0), g.cell(1, 0)];
  a.setCeilingZones(assignZoneHeight(g.graph, a, [c1], 2700));
  const b = g.graph.addRoom(new Set([c1]), '後勝ち'); // 同じセルを後の部屋が持つ（buildCellToRoom は後勝ち）
  const surfaces = ceilingSurfacesOf(g.graph);
  assert.deepEqual(surfaces.filter(s => s.roomId === a.id).map(s => s.zoneId), [null], 'a の区画は空になり出ない');
  assert.deepEqual(surfaces.filter(s => s.roomId === b.id).map(s => s.zoneId), [null]);
});

test('分割の細分化: CL を足して格子が細かくなっても、粗いキーの区画は refreshCells で元の領域全体を覆う', () => {
  const g = makeGrid([0, 1000], [0, 1000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones(assignZoneHeight(g.graph, room, [g.cell(0, 0)], 2400));
  g.graph.addCenterLine(CenterLineType.VERTICAL, 500, ARCH, 'split');
  const surfaces = ceilingSurfacesOf(g.graph);
  assert.equal(surfaces.length, 1, '残りは出ない（区画が全域を覆う）');
  assert.equal(surfaces[0].zoneId, room.ceilingZones[0].id);
  const area = surfaces[0].rects.reduce((s, r) => s + (r.x2 - r.x1) * (r.y2 - r.y1), 0);
  assert.equal(area, 1000 * 1000);
  assert.equal(surfaces[0].rects.length, 2, '2セルに分かれて覆う');
});

test('normalizePartialDominance の前後で、セルごとの天井の高さは不変（親子の入れ替えで区画の効きが変わらない）', () => {
  const g = makeGrid([0, 4000, 7000], [0, 3000]);
  const [A, B] = [g.cell(0, 0), g.cell(1, 0)];
  const parent = g.graph.addRoom(new Set([A, B]), '3');
  const partial = g.graph.addRoom(new Set([A]), "3'", undefined, new Set([parent.id]));
  parent.setCeilingZones(assignZoneHeight(g.graph, parent, [A, B], 2700));
  partial.setCeilingZones(assignZoneHeight(g.graph, partial, [A], 2300));
  const zByRect = () => Object.fromEntries(ceilingSurfacesOf(g.graph).flatMap(s => s.rects.map(r => [JSON.stringify(r), s.zMm])));
  const before = zByRect();
  assert.deepEqual(before, { [JSON.stringify(rect(0, 0, 4000, 3000))]: 2300, [JSON.stringify(rect(4000, 0, 7000, 3000))]: 2700 });

  normalizePartialDominance(g.graph);
  assert.equal(partial.referenceRoomIds.size, 0, '前提: 親子が入れ替わった');
  assert.deepEqual(zByRect(), before);
});
