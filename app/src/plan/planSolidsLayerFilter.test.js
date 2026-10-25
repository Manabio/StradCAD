// planSolidsLayerFilter.js（S4: 新レイヤへ渡す線の絞り込みと層スタックの組み立て）の単体テスト。実物の PlanGraph で組む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature, RoomKind, StairType, RoofShape } from '@core';
import {
  S4_DRAWN_KINDS, BELOW_DRAWN_KINDS, drawnPrimitives, planSolidsLayerPrimitives, planSolidsLayerSolids, planSolidsLayerCacheSpec, planSolidsLayerResolve, isCenterLineDragging,
  visiblePlanPrimitives, UP_SELF_DRAWN_KINDS, UP_ABOVE_DRAWN_KINDS, planSolidsLayerPrimitivesUp, planSolidsLayerSolidsUp, ownLayerBeamSolids,
} from './planSolidsLayerFilter.js';
import { LodLevel } from '../viewport.js';
import { cellBoundsFromKey } from '../finish/gridCells.js';
import { planSolids } from './planSolids.js';
import { planSectionFigureUp } from './planSectionUp.js';
import { ceilingCutResolverOf } from '../ceiling/ceilingCutHeight.js';
import { buildCeilingHeightField } from '../ceiling/ceilingHeightField.js';
import { isInsideFootprint, subtractRects } from './planGeometry.js';
import { makeGrid, makeRoomGraph, addBeamH, addColumnAt, linesOf, assignZoneSpec } from './planTestFixtures.js';

const CUT = 1500;
const prim = (kind, cls = 'below') => ({ kind: 'line', key: `${kind}-${cls}`, points: [0, 0, 1, 0], weight: 'thin', cls, source: { kind, id: 'x' } });

// ================================================================ 絞り込み

test('自階で描く種別は梁・汎用立体（S4）と下屋＝屋根（S5）だけ（固定）。柱・壁・床・階段の段は描かない。下階の層（layerFloorZ<0）は全種別（S6c）', () => {
  assert.deepEqual([...S4_DRAWN_KINDS], ['beam', 'generic', 'roof']);
  assert.equal(BELOW_DRAWN_KINDS, 'all');
  const kinds = ['floor', 'wall', 'column', 'beam', 'roof', 'stairTread', 'generic'];
  assert.deepEqual(drawnPrimitives(kinds.map(k => prim(k))).map(p => p.source.kind), ['beam', 'roof', 'generic']);
  const lowerPrim = k => ({ ...prim(k), source: { kind: k, id: 'x', layerFloorZ: -2800 } });
  assert.deepEqual(drawnPrimitives(kinds.map(lowerPrim)).map(p => p.source.kind), kinds, '下階の層は全種別（順序も保つ）');
  const selfZero = k => ({ ...prim(k), source: { kind: k, id: 'x', layerFloorZ: 0 } });
  assert.deepEqual(drawnPrimitives(kinds.map(selfZero)).map(p => p.source.kind), ['beam', 'roof', 'generic'], 'layerFloorZ 0 は自階');
  // ラベル（arrow・text）も source.kind で同じ集合に絞る
  const label = { kind: 'arrow', key: 'a', points: [0, 0, 1, 0], head: [], weight: 'thin', cls: 'below', detailOnly: true, source: { kind: 'roof', id: 'r' } };
  assert.deepEqual(drawnPrimitives([label, { ...label, source: { kind: 'wall', id: 'w' } }]), [label]);
});

test('visiblePlanPrimitives: 詳細（DETAIL）は全部、他の LOD は detailOnly（ラベル）を落とす。線（detailOnly:false か未指定）は全 LOD で残り、順序と入力は不変', () => {
  const input = [{ key: 'line', detailOnly: false }, { key: 'arrow', detailOnly: true }, { key: 'plain' }, { key: 'text', detailOnly: true }];
  const before = JSON.stringify(input);
  assert.deepEqual(visiblePlanPrimitives(input, LodLevel.DETAIL).map(p => p.key), ['line', 'arrow', 'plain', 'text']);
  for (const lod of [LodLevel.SCHEMATIC, LodLevel.STANDARD]) assert.deepEqual(visiblePlanPrimitives(input, lod).map(p => p.key), ['line', 'plain'], lod);
  assert.deepEqual(visiblePlanPrimitives([], LodLevel.DETAIL), []);
  assert.deepEqual(visiblePlanPrimitives([], LodLevel.STANDARD), []);
  assert.equal(JSON.stringify(input), before);
});

test('自階の下屋: planSolidsLayerPrimitives は roof の線（外形線）とラベル（arrow・text）を返す。ラベルは detailOnly、線は detailOnly:false', () => {
  const g = makeGrid([0, 2000, 4000], [0, 1500, 3000]);
  g.roof([[0, 1], [1, 1]]);
  const prims = planSolidsLayerPrimitives({ graph: g.graph, cutZ: CUT });
  const roofLines = prims.filter(p => p.kind === 'line' && p.source.kind === 'roof');
  assert.ok(roofLines.length > 0 && roofLines.every(p => p.detailOnly === false && p.cls === 'below' && p.weight === 'thin'));
  const labels = prims.filter(p => p.kind === 'arrow' || p.kind === 'text');
  assert.deepEqual(labels.map(p => p.kind), ['arrow', 'text', 'text'], '片流れは水下1面＝矢印・屋根・傾斜');
  assert.ok(labels.every(p => p.detailOnly === true && p.source.kind === 'roof'));
});

test('絞り込みは順序を保ち、入力を変えない。未定義・不正な要素は落とす（例外にしない）', () => {
  const input = [prim('wall'), prim('beam', 'cut'), prim('column'), prim('beam', 'below'), null, undefined, { kind: 'line' }];
  const before = JSON.stringify(input);
  assert.deepEqual(drawnPrimitives(input).map(p => p.cls), ['cut', 'below']);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(drawnPrimitives(undefined), []);
  assert.deepEqual(drawnPrimitives(null), []);
});

// ================================================================ 自階

function roomWithBeams() {
  const g = makeRoomGraph(0, 0, 4000, 4000); // 壁 4 本・床あり
  // 天端 1200（成 200 の H200x100）＝切断高 1500 より下 → 見えがかり（細線）
  const low = addBeamH(g.graph, { axis: 1000, from: 500, to: 3500, levelOffset: 1200 });
  // 天端 1600・下端 1400 → 切断面をまたぐ（太線）
  const cut = addBeamH(g.graph, { axis: 3000, from: 500, to: 3500, levelOffset: 1600 });
  // 下端 1800 ＞ 切断高 → 非表示
  const high = addBeamH(g.graph, { axis: 2000, from: 500, to: 3500, levelOffset: 2000 });
  return { ...g, low, cut, high };
}

test('自階: 切断高より下の梁は細線（below）、切断面をまたぐ梁は太線（cut）、全部が切断面より上の梁は出ない', () => {
  const { graph, low, cut, high } = roomWithBeams();
  const prims = planSolidsLayerPrimitives({ graph, cutZ: CUT });
  const ids = cls => new Set(linesOf(prims, cls).map(p => p.source.id));
  assert.deepEqual([...ids('below')], [low.id]);
  assert.deepEqual([...ids('cut')], [cut.id]);
  assert.ok(!prims.some(p => p.source.id === high.id), '切断面より上の梁は出ない');
  assert.ok(prims.filter(p => p.cls === 'below').every(p => p.weight === 'thin'));
  assert.ok(prims.filter(p => p.cls === 'cut').every(p => p.weight === 'thick'));
  assert.equal(linesOf(prims, 'below').length, 4, '矩形の 4 辺');
});

test('自階: 柱・壁・床の線は出さない（梁だけ）。ただし壁・柱は遮蔽物として働く（壁の中の梁は見えない）', () => {
  const { graph } = roomWithBeams();
  addColumnAt(graph, 2000, 2200);
  // 西の壁をまたぐ梁（天端 1200 ＜ 壁の上端 2400 → 壁の内部は隠れる）
  const through = addBeamH(graph, { axis: 3500, from: -600, to: 1000, levelOffset: 1200 });
  const prims = planSolidsLayerPrimitives({ graph, cutZ: CUT });
  assert.deepEqual([...new Set(prims.map(p => p.source.kind))], ['beam']);
  const walls = planSolids([{ graph, floorZMm: 0, role: 'self' }]).filter(s => s.kind === 'wall');
  assert.ok(walls.length > 0);
  const mine = prims.filter(p => p.source.id === through.id);
  assert.ok(mine.length > 0, '壁の外の部分は残る');
  for (const p of mine) {
    const mid = [(p.points[0] + p.points[2]) / 2, (p.points[1] + p.points[3]) / 2];
    for (const w of walls) assert.ok(!isInsideFootprint(mid[0], mid[1], w.footprint), `壁の内部に線: ${JSON.stringify(p.points)}`);
  }
});

// ================================================================ 直下階

function twoFloors() {
  // 自階: 左のセルは屋内、右のセルは吹抜け（床開口）。下階: 全面屋内＋壁＋梁。
  const self = makeGrid([0, 2000, 4000], [0, 4000], { id: 'upper', startFloor: 2 });
  self.interior([[0, 0]]);
  self.feature([[1, 0]], RoomFeature.VOID);
  const below = makeGrid([0, 2000, 4000], [0, 4000], { id: 'lower', startFloor: 1 });
  below.interior([[0, 0], [1, 0]], { walls: true });
  // 吹抜けの下の梁（床の穴の中）と、屋内の下の梁（自階の床に隠れる）。下階の FL=-2800、天端は FL+1000（下階自身の床の上）
  const inHole = addBeamH(below.graph, { axis: 3000, from: 2400, to: 3600, levelOffset: 1000 });
  const underFloor = addBeamH(below.graph, { axis: 1000, from: 400, to: 1600, levelOffset: 1000 });
  return { self, below, inHole, underFloor };
}

test('直下階: 自階の床の穴（吹抜け）の中の下階の梁が細線で出る（壁・柱・床は S6c の別テスト）。床の下の梁は出ない。層は layerFloorZ=-階高', () => {
  const { self, below, inHole, underFloor } = twoFloors();
  const belowPeek = { graph: below.graph, floorHeightMm: 2800 };
  const prims = planSolidsLayerPrimitives({ graph: self.graph, belowPeek, cutZ: CUT });
  const ids = new Set(prims.map(p => p.source.id));
  assert.ok(ids.has(inHole.id), '穴の中の梁は見える');
  assert.ok(!ids.has(underFloor.id), '自階の床の下の梁は見えない');
  const mine = prims.filter(p => p.source.id === inHole.id);
  assert.ok(mine.every(p => p.cls === 'below' && p.weight === 'thin' && p.source.layerFloorZ === -2800));
  assert.ok(mine.every(p => p.points[0] >= 2000 - 1e-6 && p.points[2] <= 4000 + 1e-6), '線は穴（x2000..4000）の中');
});

test('S6c 下階の層は全種別（壁・柱・床・梁）を細線で描く。窓（自階の床の穴）の中だけ。自階の壁・柱・床は引き続き出さない', () => {
  const { self, below } = twoFloors();
  addColumnAt(below.graph, 3000, 1500); // 吹抜けの下の柱
  const prims = planSolidsLayerPrimitives({ graph: self.graph, belowPeek: { graph: below.graph, floorHeightMm: 2800 }, cutZ: CUT });
  const lower = prims.filter(p => (p.source.layerFloorZ ?? 0) < 0);
  const kindsOf = ps => new Set(ps.map(p => p.source.kind));
  // 床の外形は下階の壁の帯の下に収まる。壁が取り合いの角を閉じる（planSolids.js withJoinedCorners）ので、角の隙間から床の線が
  // 覗くことはない（旧: 角の隙間の 57.5mm 以下の断片で floor が出ていたのは隙間の副産物）。床の線そのものは planSectionFigure.test.js が見る
  for (const k of ['wall', 'column', 'beam']) assert.ok(kindsOf(lower).has(k), `下階の ${k} の線が出る: ${[...kindsOf(lower)]}`);
  assert.equal(BELOW_DRAWN_KINDS, 'all', '下階の層の描画種別に floor は含まれる（出ないのは線が壁に隠れるから）');
  assert.ok(!kindsOf(lower).has('floor'), `壁が角を閉じるので下階の床の線は壁の下に隠れる: ${[...kindsOf(lower)]}`);
  assert.ok(lower.every(p => p.cls === 'below' && p.weight === 'thin' && p.source.layerFloorZ === -2800), '下階の層は全部 below（細線）。cut は無い');
  for (const p of lower) {
    const [x1, y1, x2, y2] = p.points;
    assert.ok(Math.min(x1, x2) >= 2000 - 1e-6 && Math.max(x1, x2) <= 4000 + 1e-6 && Math.min(y1, y2) >= -1e-6 && Math.max(y1, y2) <= 4000 + 1e-6, `線が穴（x2000..4000 × y0..4000）の中: ${JSON.stringify(p.points)}`);
  }
  // 自階の壁・柱・床は S4 の集合のまま（出さない）
  const selfPrims = prims.filter(p => (p.source.layerFloorZ ?? 0) === 0);
  assert.ok(selfPrims.every(p => S4_DRAWN_KINDS.includes(p.source.kind)), `自階は S4 の種別だけ: ${[...kindsOf(selfPrims)]}`);
  // 下階が無い・階高が不正なら下階の層の線は種別を問わず出ない
  for (const belowPeek of [null, { graph: below.graph, floorHeightMm: 0 }, { graph: below.graph, floorHeightMm: NaN }, { graph: null, floorHeightMm: 2800 }]) {
    const none = planSolidsLayerPrimitives({ graph: self.graph, belowPeek, cutZ: CUT });
    assert.equal(none.filter(p => (p.source.layerFloorZ ?? 0) < 0).length, 0);
  }
});

test('直下階が無い（belowPeek なし）、または階高が不正（0・負・非数）なら下階の線は出ない（例外にしない）', () => {
  const { self, below, inHole } = twoFloors();
  const has = prims => prims.some(p => p.source.id === inHole.id);
  assert.equal(has(planSolidsLayerPrimitives({ graph: self.graph, cutZ: CUT })), false);
  assert.equal(has(planSolidsLayerPrimitives({ graph: self.graph, belowPeek: null, cutZ: CUT })), false);
  for (const floorHeightMm of [0, -2800, NaN, undefined]) {
    assert.equal(has(planSolidsLayerPrimitives({ graph: self.graph, belowPeek: { graph: below.graph, floorHeightMm }, cutZ: CUT })), false, `floorHeightMm=${floorHeightMm}`);
  }
  assert.equal(has(planSolidsLayerPrimitives({ graph: self.graph, belowPeek: { graph: null, floorHeightMm: 2800 }, cutZ: CUT })), false);
});

function switchback(id, { wide = false } = {}) {
  const g = makeGrid(wide ? [0, 1000, 2000, 3000] : [0, 1000, 2000], [0, 1500, 4500], { id });
  const { graph, cx, cy } = g;
  const landing = `${cx[0].id}:${cy[0].id}:${cx[2].id}:${cy[1].id}`;
  const outbound = `${cx[0].id}:${cy[1].id}:${cx[1].id}:${cy[2].id}`;
  const ret = `${cx[1].id}:${cy[1].id}:${cx[2].id}:${cy[2].id}`;
  const room = graph.addRoom(new Set([landing, outbound]), '階段'); // 破れ先 ret は部屋に含めない
  graph.addStair({
    type: StairType.SWITCHBACK, cells: new Set([landing, outbound, ret]), roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
  if (wide) graph.addRoom(new Set([`${cx[2].id}:${cy[1].id}:${cx[3].id}:${cy[2].id}`]), '隣室'); // 階段の右隣（穴の外に残る床）
  return graph;
}

test('蹴上（破れ先の位置）を問われるのは自階の階段だけ。下階に同じ階段があると破れ先が穴になり、その中の下階の梁が見える', () => {
  const self = switchback('upper'), lower = switchback('lower');
  // 破れ先のセル（x1000..2000×y1500..4500）の中で、自階の段（切断高 1500 以下の段は y3900 まで）の外・
  // 下階の段の天端（FL+233〜2567）より上の梁（天端 FL+2700）にする——段の下の梁は隠れる（S7b。別テスト）
  const beam = addBeamH(lower, { axis: 4200, from: 1200, to: 1800, levelOffset: 2700 });
  const asked = [];
  const selfRiserOf = stair => { asked.push(stair); return 150; };
  const belowPeek = { graph: lower, floorHeightMm: 2800 };
  const withBelow = planSolidsLayerPrimitives({ graph: self, belowPeek, selfRiserOf, cutZ: CUT });
  assert.ok(asked.length > 0, '自階の階段の蹴上が問われる');
  assert.ok(asked.every(s => self.stairs.includes(s)), '下階の階段の蹴上は問わない');
  assert.ok(withBelow.some(p => p.source.id === beam.id), '破れ先の穴の中の下階の梁は見える');
  // 下階を渡さなければ（設置階自身）穴はできず、梁は見えない
  assert.ok(!planSolidsLayerPrimitives({ graph: self, selfRiserOf, cutZ: CUT }).some(p => p.source.id === beam.id));
  // 蹴上の供給源が無い（省略）でも例外にしない
  assert.doesNotThrow(() => planSolidsLayerPrimitives({ graph: self, belowPeek, cutZ: CUT }));
});

test('S7b 階段の段は遮蔽物としてだけ参加する: 線は自階でも下階（全種別を描く層）でも 0 本。階段の下の梁は隠れ、段より高い梁は見える', () => {
  const self = switchback('upper'), lower = switchback('lower');
  // 破れ先のセルの中。自階の段（y1500〜3900・天端 FL+1050〜1500）の下、下階の段（y1442〜4442・天端 FL-1167〜-233）の下
  const underSelf = addBeamH(lower, { axis: 3000, from: 1200, to: 1800, levelOffset: 1000 });
  const underLower = addBeamH(lower, { axis: 4200, from: 1200, to: 1800, levelOffset: 1000 }); // 自階の段の外・下階の段の下
  const above = addBeamH(lower, { axis: 4200, from: 1200, to: 1800, levelOffset: 2700 });      // 下階の段より高い
  const prims = planSolidsLayerPrimitives({ graph: self, belowPeek: { graph: lower, floorHeightMm: 2800 }, selfRiserOf: () => 150, cutZ: CUT });
  assert.equal(prims.filter(p => p.source.kind === 'stairTread').length, 0, '段の線は出ない（描くのは StairLayer）');
  assert.ok(prims.some(p => p.source.id === above.id), '前提: 段より高い梁は見える');
  assert.ok(!prims.some(p => p.source.id === underSelf.id), '自階の段の下の梁は隠れる');
  assert.ok(!prims.some(p => p.source.id === underLower.id), '下階の段の下の梁は隠れる');
  // 蹴上の供給源が無い（selfRiserOf 省略）と自階の段は立体にならない（遮蔽しない＝安全側）。下階は階高から求まる
  const solids = planSolidsLayerSolids({ graph: self, belowPeek: { graph: lower, floorHeightMm: 2800 } });
  assert.deepEqual([...new Set(solids.filter(s => s.kind === 'stairTread').map(s => s.source.layerFloorZ))], [-2800], '自階の蹴上が無ければ下階の段だけ');
});

// ================================================================ 置き場・鍵・3状態・ドラッグ中

test('planSolidsLayerCacheSpec: 置き場は直下階 peek の graph（無ければ自階）、鍵は 自階×切断高×直下階。自階と違う階の peek は使わない', () => {
  const { graph } = roomWithBeams();
  const lower = makeRoomGraph(0, 0, 4000, 4000, { id: 'lower' }).graph;
  const peek = { graph: lower, floorHeightMm: 2800, activePlaneId: graph.plane.id };
  const a = planSolidsLayerCacheSpec(graph, peek);
  assert.ok(a.home === lower, 'home は直下階 peek の graph'); // 失敗時にグラフを丸ごと diff 出力しないよう ok で比べる
  assert.equal(a.key, `planSection:${graph.plane.id}:1500:lower`);
  assert.ok(a.peek === peek);
  const none = planSolidsLayerCacheSpec(graph, null);
  assert.ok(none.home === graph);
  assert.equal(none.key, `planSection:${graph.plane.id}:1500:-`);
  assert.equal(none.peek, null);
  const stale = planSolidsLayerCacheSpec(graph, { ...peek, activePlaneId: 'other' });
  assert.ok(stale.home === graph, '前の階の peek は使わない');
  assert.equal(stale.peek, null);
  graph.plane.planCutHeightMm = 1800;
  assert.equal(planSolidsLayerCacheSpec(graph, null).key, `planSection:${graph.plane.id}:1800:-`, '鍵に切断高が入る');
});

test('planSolidsLayerCacheSpec: peek 未解決（undefined）は自階だけの層・置き場は自階・鍵は下階 "-" と区別した pending', () => {
  const { graph } = roomWithBeams();
  const pending = planSolidsLayerCacheSpec(graph, undefined);
  assert.ok(pending.home === graph);
  assert.equal(pending.key, `planSection:${graph.plane.id}:1500:pending`);
  assert.equal(pending.peek, null);
});

test('planSolidsLayerResolve: belowPeek の3状態——undefined（未解決）は自階だけで解決して描く（下階の線なし）／null（下階なし）と peek ありも解決する。peek が届くと通常の鍵で再計算', () => {
  const { graph } = roomWithBeams();
  const lower = makeRoomGraph(0, 0, 4000, 4000, { id: 'lower' }).graph;
  addBeamH(lower, { axis: 1000, from: 500, to: 3500, levelOffset: 1000 });
  const calls = [];
  const memo = (home, key, compute) => { calls.push(key); return compute(); };
  const pending = planSolidsLayerResolve({ graph, belowPeek: undefined, memo });
  assert.ok(Array.isArray(pending) && pending.length > 0, '未解決でも自階の線は描く');
  assert.ok(pending.every(p => (p.source.layerFloorZ ?? 0) === 0), '下階の線は出ない');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /:pending$/);
  const noBelow = planSolidsLayerResolve({ graph, belowPeek: null, memo });
  assert.ok(Array.isArray(noBelow) && noBelow.length > 0);
  assert.match(calls[1], /:-$/);
  const withPeek = planSolidsLayerResolve({ graph, belowPeek: { graph: lower, floorHeightMm: 2800, activePlaneId: graph.plane.id }, memo });
  assert.ok(Array.isArray(withPeek));
  assert.match(calls[2], /:lower$/, 'peek が届くと通常の鍵で再計算');
  assert.equal(calls.length, 3);
  assert.equal(planSolidsLayerResolve({ graph: null, belowPeek: null, memo }), null, 'graph なし');
});

test('isCenterLineDragging: どれかの CL の pendingDelta が 0 でなければ真（階固有の CL も通り芯も）。pendingDelta 欠落は 0 扱い', () => {
  const { graph, cx } = roomWithBeams();
  assert.equal(isCenterLineDragging(graph), false);
  cx[0].pendingDelta = 5;
  assert.equal(isCenterLineDragging(graph), true);
  cx[0].pendingDelta = 0;
  assert.equal(isCenterLineDragging(graph), false);
  assert.equal(isCenterLineDragging(null), false);
  assert.equal(isCenterLineDragging({ centerLines: [{}] }), false);
});

test('不正な入力: graph が無い・切断高が非数なら空配列（例外にしない）', () => {
  const { graph } = roomWithBeams();
  assert.deepEqual(planSolidsLayerPrimitives({ graph: null, cutZ: CUT }), []);
  assert.deepEqual(planSolidsLayerPrimitives({ graph: undefined, cutZ: CUT }), []);
  assert.deepEqual(planSolidsLayerPrimitives({ graph, cutZ: NaN }), []);
  assert.deepEqual(planSolidsLayerPrimitives({ graph, cutZ: undefined }), []);
});

test('切断高が梁を分類する: 切断高を 1100 に下げると天端 1200 の梁は切断（太線）、2100 に上げると太線だった梁は細線', () => {
  const { graph, low, cut } = roomWithBeams();
  const clsOf = (prims, id) => [...new Set(prims.filter(p => p.source.id === id).map(p => p.cls))];
  const lowCut = planSolidsLayerPrimitives({ graph, cutZ: 1100 }); // low: zLo 1000 < 1100 < zHi 1200
  assert.deepEqual(clsOf(lowCut, low.id), ['cut']);
  const hiCut = planSolidsLayerPrimitives({ graph, cutZ: 2100 });
  assert.deepEqual(clsOf(hiCut, cut.id), ['below']);
});

// ================================================================ 見上げ（direction 'up'）

const outline4 = (x1, y1, x2, y2) => [[x1, y1, x2, y1], [x1, y2, x2, y2], [x1, y1, x1, y2], [x2, y1, x2, y2]]
  .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
const sortedPts = prims => prims.map(p => {
  const [a, b, c, d] = p.points;
  return a < c || (a === c && b <= d) ? [a, b, c, d] : [c, d, a, b];
}).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);

/** 自階（天井 2400）と上階（梁の下端 2600・天端 2800）。上階の peek は階高 2800。 */
function upScene({ selfVoid = false, selfWalls = true } = {}) {
  const self = makeGrid([0, 4000], [0, 4000], { id: 'low', startFloor: 1 });
  if (selfVoid) self.feature([[0, 0]], RoomFeature.VOID); else self.interior([[0, 0]], { walls: selfWalls });
  const above = makeGrid([0, 4000], [0, 4000], { id: 'high', startFloor: 2 });
  above.interior([[0, 0]], { walls: true });
  const beam = addBeamH(above.graph, { axis: 1000, from: 500, to: 3500 }); // H200x100・天端=上階FL
  return { self, above, beam, abovePeek: { graph: above.graph, floorHeightMm: 2800, activePlaneId: self.graph.plane.id } };
}

test('見上げ: 自階で描く種別は天井・梁・汎用立体、上階の層は全種別（固定）。direction 省略は従来どおり', () => {
  assert.deepEqual([...UP_SELF_DRAWN_KINDS], ['ceiling', 'beam', 'generic']);
  assert.equal(UP_ABOVE_DRAWN_KINDS, 'all');
  const kinds = ['floor', 'wall', 'column', 'beam', 'roof', 'stairTread', 'ceiling', 'generic'];
  const at = (k, z) => ({ ...prim(k), source: { kind: k, id: 'x', ...(z === undefined ? {} : { layerFloorZ: z }) } });
  assert.deepEqual(drawnPrimitives(kinds.map(k => at(k)), 'up').map(p => p.source.kind), ['beam', 'ceiling', 'generic'], '自階（省略）');
  assert.deepEqual(drawnPrimitives(kinds.map(k => at(k, 0)), 'up').map(p => p.source.kind), ['beam', 'ceiling', 'generic'], '自階（0）');
  assert.deepEqual(drawnPrimitives(kinds.map(k => at(k, 2800)), 'up').map(p => p.source.kind), kinds, '上階の層は全種別');
  assert.deepEqual(drawnPrimitives(kinds.map(k => at(k)), 'down').map(p => p.source.kind), ['beam', 'roof', 'generic'], 'down は S4 の集合');
  assert.deepEqual(drawnPrimitives(kinds.map(k => at(k))), drawnPrimitives(kinds.map(k => at(k)), 'down'), '省略＝down');
});

test('見上げ: 自階の天井の外形は細線で出るが、壁・床は出さない。上階の梁は天井（下端 2400 ≦ 梁の下端 2600）に隠れる', () => {
  const { self, abovePeek, beam } = upScene({ selfWalls: false });
  const prims = planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: CUT });
  assert.deepEqual(sortedPts(prims.filter(p => p.source.kind === 'ceiling')), outline4(0, 0, 4000, 4000));
  assert.ok(prims.filter(p => p.source.kind === 'ceiling').every(p => p.cls === 'below' && p.weight === 'thin' && p.source.layerFloorZ === 0));
  assert.ok(!prims.some(p => p.source.id === beam.id), '天井が上階の梁を隠す');
  assert.ok(prims.every(p => !('viewLayerFloorZ' in p.source)));
});

test('見上げ: 壁のある部屋では天井の外形は壁（切断）が隠す。壁そのものは描かない（ShapesLayer の仕事）。壁が取り合いの角を閉じるので隅の断片も出ない', () => {
  const { self, abovePeek } = upScene();
  const prims = planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: CUT });
  assert.ok(!prims.some(p => p.source.kind === 'wall' && (p.source.layerFloorZ ?? 0) === 0), '自階の壁は描かない');
  // 旧: 壁が互いの面で止まり、隅の 57.5mm 以下の断片だけが天井の外形として覗いていた（角の隙間）。角を閉じた今は 0 本
  const ceil = prims.filter(p => p.source.kind === 'ceiling');
  assert.deepEqual(sortedPts(ceil), [], `天井の外形は壁が全部隠す: ${JSON.stringify(sortedPts(ceil))}`);
});

test('見上げ: 屋外のポーチ（feature なし）の天井の外形が kind:ceiling の線で出る。\'0\' で外すと出ない。見下げは ceiling を描かず不変', () => {
  const { self, abovePeek } = upScene({ selfWalls: false });
  const porch = self.graph.rooms[0];
  porch.setKind(RoomKind.EXTERIOR);
  const up = () => planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: CUT }).filter(p => p.source.kind === 'ceiling');
  assert.deepEqual(sortedPts(up()), outline4(0, 0, 4000, 4000));
  const down = planSolidsLayerPrimitives({ graph: self.graph, cutZ: CUT });
  assert.equal(down.filter(p => p.source.kind === 'ceiling').length, 0, '見下げは ceiling なし');
  porch.setOverride('exteriorCeiling', '0');
  assert.deepEqual(sortedPts(up()), []);
});

/** 4000 角の 1 部屋に、全体の傾斜天井（低い側 2400・ライズ 2000・右へ上がる）を付けた自階。壁なし。 */
function slopeScene() {
  const self = makeGrid([0, 4000], [0, 4000], { id: 'low', startFloor: 1 });
  const room = self.interior([[0, 0]]);
  room.setCeilingZones(assignZoneSpec(self.graph, room, [self.cell(0, 0)], { heightMm: 2400, shape: 'slope', dims: [2000, 0] }));
  return { self, room };
}
const markPrims = prims => prims.filter(p => p.kind === 'arrow' || p.kind === 'text');

test('見上げの傾斜天井（S6a）: 基本の切断高（z=3000）が傾斜の最低点（2400）より上でも、その部屋だけ切断高が最低点の直下へ下がり（部屋ごとの切断高）、輪郭は 4 辺そろって等高線は出ない', () => {
  const { self } = slopeScene();
  const lines = planSolidsLayerPrimitivesUp({ graph: self.graph, cutZ: 3000 }).filter(p => p.kind === 'line' && p.source.kind === 'ceiling');
  assert.ok(lines.length > 0);
  assert.ok(lines.every(p => p.cls === 'below' && p.weight === 'thin'));
  assert.deepEqual(sortedPts(lines), outline4(0, 0, 4000, 4000), '天井面全体が描かれる（x<1200 の部分も欠けない）');
  assert.ok(!lines.some(p => Math.abs(p.points[0] - 1200) < 1 && Math.abs(p.points[2] - 1200) < 1), '等高線は出ない');
  // 階の切断高が傾斜の全体より下でも、部屋の切断高は傾斜の最低点の直下なので、輪郭は 4 辺そろう
  const full = planSolidsLayerPrimitivesUp({ graph: self.graph, cutZ: 1500 }).filter(p => p.kind === 'line' && p.source.kind === 'ceiling');
  assert.deepEqual(sortedPts(full), outline4(0, 0, 4000, 4000));
});

test('見上げの傾斜天井: 注記（矢印・文字）は詳細 LOD だけ。基準点（面の中心）が切断高より上なら出て、下に入れば消える。平面の天井には付かない', () => {
  const { self } = slopeScene();
  const marks = cutZ => markPrims(planSolidsLayerPrimitivesUp({ graph: self.graph, cutZ }));
  const shown = marks(3000); // 中心 x=2000 の高さ 3400 > 切断高
  assert.deepEqual(shown.map(p => p.kind).sort(), ['arrow', 'text']);
  assert.ok(shown.every(p => p.detailOnly === true && p.source.kind === 'ceiling' && p.cls === 'below'));
  assert.equal(shown.find(p => p.kind === 'text').text, '傾斜 CH2400〜4400');
  assert.equal(marks(3600).length, 2, '基本の切断高 3600 が中心の高さ 3400 より上でも、部屋の切断高は最低点の直下に下がるので基準点は見える');
  // LOD: 詳細以外では注記を除く
  const all = planSolidsLayerPrimitivesUp({ graph: self.graph, cutZ: 3000 });
  assert.equal(markPrims(visiblePlanPrimitives(all, LodLevel.DETAIL)).length, 2);
  assert.equal(markPrims(visiblePlanPrimitives(all, LodLevel.STANDARD)).length, 0);
  // 平面の天井
  const flat = makeRoomGraph(0, 0, 4000, 4000);
  assert.equal(markPrims(planSolidsLayerPrimitivesUp({ graph: flat.graph, cutZ: 1500 })).length, 0);
});

test('見上げ: 自階に天井が無い（吹抜け）でも、上階の梁は描かない（梁は天井より上。裁定 2026-10-18）。上階が無い・階高が不正なら上階の線は出ない', () => {
  const { self, abovePeek, beam } = upScene({ selfVoid: true });
  const prims = planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: CUT });
  assert.equal(prims.filter(p => p.source.id === beam.id).length, 0);
  assert.ok(prims.some(p => p.source.layerFloorZ === 2800), '有効な peek なら上階の壁・床は見える');
  for (const peek of [null, undefined, { ...abovePeek, floorHeightMm: 0 }, { ...abovePeek, floorHeightMm: NaN }, { graph: null, floorHeightMm: 2800 }]) {
    const none = planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek: peek, cutZ: CUT });
    assert.equal(none.filter(p => (p.source.layerFloorZ ?? 0) > 0).length, 0);
  }
  assert.deepEqual(planSolidsLayerPrimitivesUp({ graph: null, cutZ: CUT }), []);
  assert.deepEqual(planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: NaN }), []);
});

test('見上げ: 立体の層は自階（FL=0・ceiling あり）＋直上階（FL=階高・role above・ceiling なし）。下階は渡さない', () => {
  const { self, abovePeek } = upScene();
  const solids = planSolidsLayerSolidsUp({ graph: self.graph, abovePeek });
  assert.deepEqual([...new Set(solids.map(s => s.source.layerFloorZ))].sort((a, b) => a - b), [0, 2800]);
  assert.deepEqual(solids.filter(s => s.kind === 'ceiling').map(s => s.source.layerFloorZ), [0]);
  assert.equal(planSolidsLayerSolids({ graph: self.graph }).filter(s => s.kind === 'ceiling').length, 0, '見下げの立体に天井は無い');
});

test('見上げ: 上階に破れ先のある階段があり、自階に同じ階段があると、上階スラブに穴が開く。穴の縁が細線（layerFloorZ=階高）で出る。蹴上は上階の aboveRiserOf で解く', () => {
  const low = switchback('low'), high = switchback('high');
  // 破れ先のセル（x1000..2000×y1500..4500）を上階の別室でも覆い、上階の床がそこにも張られるようにする
  const cells = [...high.stairs[0].cells];
  const retKey = cells.find(k => { const b = cellBoundsFromKey(k, high); return b.x1 === 1000 && b.y1 === 1500; });
  high.addRoom(new Set([retKey]), '部屋');
  const abovePeek = { graph: high, floorHeightMm: 2800, activePlaneId: low.plane.id };
  const asked = [];
  const aboveRiserOf = s => { asked.push(s); return 150; };
  const solids = planSolidsLayerSolidsUp({ graph: low, abovePeek, aboveRiserOf });
  const upFloor = solids.find(s => s.kind === 'floor' && s.source.layerFloorZ === 2800);
  assert.ok(upFloor, '上階の床がある');
  // 見上げの穴は破れ先でなく足元全体（S13a）: 踊り場（2セル）・往路・復路とも穴
  const holes = upFloor.footprint.holes ?? [];
  assert.deepEqual(holes.map(h => [h.x1, h.y1, h.x2, h.y2]).sort(), [[0, 0, 1000, 1500], [0, 1500, 1000, 4500], [1000, 0, 2000, 1500], [1000, 1500, 2000, 4500]].sort(),
    `足元全体が穴: ${JSON.stringify(holes)}`);
  assert.ok(asked.length > 0 && asked.every(s => high.stairs.includes(s)), '最上の層＝上階の階段の蹴上を aboveRiserOf で問う');
  // 自階に同じ階段が無ければ穴にならない
  const noStair = makeGrid([0, 1000, 2000], [0, 1500, 4500], { id: 'bare' });
  noStair.interior([[0, 0], [0, 1], [1, 0], [1, 1]]);
  const flat = planSolidsLayerSolidsUp({ graph: noStair.graph, abovePeek: { ...abovePeek, activePlaneId: noStair.graph.plane.id }, aboveRiserOf });
  assert.equal((flat.find(s => s.kind === 'floor' && s.source.layerFloorZ === 2800).footprint.holes ?? []).length, 0);
  // 穴の縁の線: 天井の無い所（自階の部屋の外）で上階の床の縁が細線で出る
  const prims = planSolidsLayerPrimitivesUp({ graph: low, abovePeek, aboveRiserOf, cutZ: CUT });
  assert.equal(prims.filter(p => p.source.kind === 'floor' && p.source.layerFloorZ === 2800).length, 0, '足元全体が穴で上階の床が残らなければ縁も出ない');
  // 階段の隣に上階の床が残ると、穴の縁（足元の全周）が細線で出る
  const lowW = switchback('lowW', { wide: true }), highW = switchback('highW', { wide: true });
  const wideUp = planSolidsLayerPrimitivesUp({ graph: lowW, abovePeek: { graph: highW, floorHeightMm: 2800, activePlaneId: lowW.plane.id }, aboveRiserOf, cutZ: CUT });
  const edge = wideUp.filter(p => p.source.kind === 'floor' && p.source.layerFloorZ === 2800);
  // 見える穴（穴 − 自階の天井面）の外形の縁は中線（S3）、天井面と接する縁は細線。線の中点の両側 1mm の一方だけが見える穴の内側なら外形
  const wideSolids = planSolidsLayerSolidsUp({ graph: lowW, abovePeek: { graph: highW, floorHeightMm: 2800, activePlaneId: lowW.plane.id }, aboveRiserOf });
  const wideHoles = wideSolids.find(s => s.kind === 'floor' && s.source.layerFloorZ === 2800).footprint.holes ?? [];
  const wideCeil = wideSolids.filter(s => s.kind === 'ceiling' && (s.source.layerFloorZ ?? 0) === 0).flatMap(s => s.footprint.rects);
  const visible = subtractRects(wideHoles, wideCeil);
  const inVisible = (x, y) => visible.some(r => x > r.x1 && x < r.x2 && y > r.y1 && y < r.y2);
  const onOutline = ([x1, y1, x2, y2]) => {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const [a, b] = Math.abs(x1 - x2) < 1e-3 ? [[mx - 1, my], [mx + 1, my]] : [[mx, my - 1], [mx, my + 1]];
    return inVisible(...a) !== inVisible(...b);
  };
  assert.ok(edge.length > 0 && edge.every(p => p.cls === 'below'));
  assert.ok(edge.some(p => p.weight === 'medium') && edge.some(p => p.weight === 'thin'), '検出力: 中線と細線の両方がある配置');
  for (const p of edge) assert.equal(p.weight, onOutline(p.points) ? 'medium' : 'thin', `位置ごとの重み: ${JSON.stringify(p.points)}`);
});

test('見上げの鍵: planSection:up:… で見下げの鍵と衝突しない。置き場は上階 peek の graph（無ければ自階）、pending／- の区別、階の違う peek は使わない', () => {
  const { self, above, abovePeek } = upScene();
  const g = self.graph;
  const a = planSolidsLayerCacheSpec(g, abovePeek, 'up');
  assert.equal(a.key, `planSection:up:${g.plane.id}:1500:high:-`);
  assert.ok(a.home === above.graph && a.peek === abovePeek);
  assert.equal(planSolidsLayerCacheSpec(g, null, 'up').key, `planSection:up:${g.plane.id}:1500:-:-`);
  assert.equal(planSolidsLayerCacheSpec(g, undefined, 'up').key, `planSection:up:${g.plane.id}:1500:pending:-`);
  assert.ok(planSolidsLayerCacheSpec(g, undefined, 'up').home === g);
  const stale = planSolidsLayerCacheSpec(g, { ...abovePeek, activePlaneId: 'other' }, 'up');
  assert.ok(stale.home === g && stale.peek === null);
  // 見下げの鍵は従来の文字列のまま（direction 省略・'down'）
  const down = planSolidsLayerCacheSpec(g, { graph: above.graph, floorHeightMm: 2800, activePlaneId: g.plane.id });
  assert.equal(down.key, `planSection:${g.plane.id}:1500:high`);
  assert.equal(planSolidsLayerCacheSpec(g, null, 'down').key, `planSection:${g.plane.id}:1500:-`);
  assert.notEqual(down.key, a.key);
});

test('見上げの切断高: up の cutZ と鍵は天伏の切断高（ceilingCutHeightMm）を使う。平面の切断高を変えても up は変わらず、天伏の切断高を変えると up だけ変わる（down は逆）', () => {
  const { self } = upScene();
  const g = self.graph;
  const tailOf = (spec, id) => spec.key.split(`${id}:`)[1];
  assert.equal(planSolidsLayerCacheSpec(g, null, 'up').cutZ, 1500);
  g.plane.planCutHeightMm = 1800;
  const up1 = planSolidsLayerCacheSpec(g, null, 'up');
  assert.equal(up1.cutZ, 1500, '平面の切断高を変えても up は不変');
  assert.equal(up1.key, `planSection:up:${g.plane.id}:1500:-:-`);
  const down1 = planSolidsLayerCacheSpec(g, null, 'down');
  assert.equal(down1.cutZ, 1800);
  assert.equal(down1.key, `planSection:${g.plane.id}:1800:-`);
  g.plane.ceilingCutHeightMm = 2100;
  const up2 = planSolidsLayerCacheSpec(g, null, 'up');
  assert.equal(up2.cutZ, 2100, '天伏の切断高を変えると up が変わる');
  assert.equal(up2.key, `planSection:up:${g.plane.id}:2100:-:-`);
  assert.equal(planSolidsLayerCacheSpec(g, null, 'down').key, down1.key, '天伏の切断高は down の鍵に影響しない');
  assert.equal(tailOf(up2, g.plane.id), '2100:-:-');
  // 不正値（0・負・非数）は既定へ倒れる（読み口は ceilingCutHeightMmOf）
  for (const bad of [0, -1, NaN, undefined]) {
    g.plane.ceilingCutHeightMm = bad;
    assert.equal(planSolidsLayerCacheSpec(g, null, 'up').cutZ, 1500, `値 ${String(bad)}`);
  }
  // planSolidsLayerResolve の up は天伏の切断高の鍵で memo する
  g.plane.ceilingCutHeightMm = 1500;
  const memoCalls = [];
  planSolidsLayerResolve({ graph: g, abovePeek: undefined, direction: 'up', memo: (h, k, c) => { memoCalls.push(k); return c(); } });
  g.plane.ceilingCutHeightMm = 1700;
  planSolidsLayerResolve({ graph: g, abovePeek: undefined, direction: 'up', memo: (h, k, c) => { memoCalls.push(k); return c(); } });
  assert.deepEqual(memoCalls, [`planSection:up:${g.plane.id}:1500:pending:-`, `planSection:up:${g.plane.id}:1700:pending:-`]);
});

test('見上げ: planSolidsLayerResolve は abovePeek を使う。同じ graph・同じ置き場で down の後に up を呼んでも down の結果を使い回さない', () => {
  const { self, abovePeek } = upScene({ selfVoid: true });
  const peekDown = { graph: abovePeek.graph, floorHeightMm: 2800, activePlaneId: self.graph.plane.id };
  // graphComputed と同じ「(home, key) ごとに最初の compute を使い回す」memo
  const cache = new Map();
  const memo = (home, key, compute) => {
    if (!cache.has(home)) cache.set(home, new Map());
    const m = cache.get(home);
    if (!m.has(key)) m.set(key, compute());
    return m.get(key);
  };
  const down = planSolidsLayerResolve({ graph: self.graph, belowPeek: peekDown, abovePeek, direction: 'down', memo });
  const up = planSolidsLayerResolve({ graph: self.graph, belowPeek: peekDown, abovePeek, direction: 'up', memo });
  assert.ok(down !== up, '別の鍵＝別の計算');
  assert.ok(up.some(p => (p.source.layerFloorZ ?? 0) > 0), 'up は上階の線を含む');
  assert.ok(!down.some(p => (p.source.layerFloorZ ?? 0) > 0), 'down は上階の線を含まない');
  assert.ok(up.every(p => p.source.kind !== 'ceiling' || p.source.layerFloorZ === 0));
  assert.ok(planSolidsLayerResolve({ graph: self.graph, belowPeek: peekDown, abovePeek, direction: 'up', memo }) === up, '同じ鍵は使い回す');
  // abovePeek が undefined（未解決）でも belowPeek があっても up は pending の鍵で自階だけを解く
  const keys = [];
  planSolidsLayerResolve({ graph: self.graph, belowPeek: peekDown, abovePeek: undefined, direction: 'up', memo: (h, k, c) => { keys.push(k); return c(); } });
  assert.match(keys[0], /^planSection:up:.*:pending:-$/);
  assert.equal(planSolidsLayerResolve({ graph: null, abovePeek, direction: 'up', memo }), null);
  self.cx[0].pendingDelta = 5;
  assert.equal(planSolidsLayerResolve({ graph: self.graph, abovePeek, direction: 'up', prevPrims: ['prev'], memo }).length, 1, 'ドラッグ中は前回の線');
});

// ================================================================ 見上げの切断高（部屋ごと。裁定 2026-10-22）

/** 左 (0..2000) は天井 2400、右 (2000..4000) は天井 1200（階の切断高 1500 より低い＝階段下など）。壁なし。 */
function lowRoomScene() {
  const self = makeGrid([0, 2000, 4000], [0, 3000], { id: 'low', startFloor: 1 });
  const normal = self.interior([[0, 0]]);
  const low = self.interior([[1, 0]]);
  normal.setOverride('ceilingHeight', '2400');
  low.setOverride('ceilingHeight', '1200');
  return { self, normal, low };
}
const ceilingOf = (prims, room) => prims.filter(p => p.kind === 'line' && p.source.kind === 'ceiling' && p.source.id === room.id);

test('見上げ: 天井が基本の切断高（1500）より低い部屋は、その部屋だけ切断高が下がり天井の外形が全部出る。他の部屋は従来どおり', () => {
  const { self, normal, low } = lowRoomScene();
  const prims = planSolidsLayerPrimitivesUp({ graph: self.graph, cutZ: CUT });
  // 隣室との共有辺 x=2000 は 1 本だけ出る（どちらの部屋の線かは同順位の並び＝部屋 id 次第なので、部屋ごとではなく和で見る）
  const all = prims.filter(p => p.kind === 'line' && p.source.kind === 'ceiling');
  assert.deepEqual(sortedPts(all), [[0, 0, 0, 3000], [0, 0, 2000, 0], [0, 3000, 2000, 3000], [2000, 0, 2000, 3000], [2000, 0, 4000, 0], [2000, 3000, 4000, 3000], [4000, 0, 4000, 3000]],
    '低い部屋の天井面全体が出る（切断面の下に隠れない）');
  const lowPts = sortedPts(ceilingOf(prims, low));
  for (const side of [[2000, 0, 4000, 0], [2000, 3000, 4000, 3000], [4000, 0, 4000, 3000]]) assert.ok(lowPts.some(p => p.join() === side.join()), `低い部屋の辺 ${side}`);
  assert.ok(normal && all.every(p => p.cls === 'below' && p.weight === 'thin'));
});

test('見上げ: 全部屋の切断高が階の値と同じ（uniform。天井＝階の値＋1 mm）なら、数値の切断高で解いた線と同一（点・cls・太さ）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000], { id: 'uni', startFloor: 1 });
  g.interior([[0, 0]]).setOverride('ceilingHeight', String(CUT + 1)); // 部屋の切断高＝天井 −1＝階の値
  g.interior([[1, 0]]).setOverride('ceilingHeight', String(CUT + 1));
  assert.equal(ceilingCutResolverOf(g.graph, { baseCutMm: CUT }).uniform, true, '前提: uniform');
  const viaFilter = planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT }).filter(p => p.kind === 'line' && p.source.kind === 'ceiling');
  const numeric = drawnPrimitives(planSectionFigureUp(planSolidsLayerSolidsUp({ graph: g.graph }), CUT), 'up').filter(p => p.kind === 'line' && p.source.kind === 'ceiling');
  assert.ok(numeric.length > 0, '比べる線がある');
  // 同じ辺（隣り合う部屋の共有辺）は重なった線が 1 本にまとまる（markSameHeightCeilingBoundaries）ので、点の組を重複なしで比べる
  const uniq = prims => [...new Set(sortedPts(prims).map(p => p.join()))];
  assert.deepEqual(uniq(viaFilter), uniq(numeric));
  assert.deepEqual([...new Set(viaFilter.map(p => p.cls))], [...new Set(numeric.map(p => p.cls))]);
});

test('見上げ（下がり梁。裁定 2026-10-22）: 天井 2400 の部屋の天井より低い梁（z 1440〜1640）は、部屋の切断高が梁の下端の直下（1439）に下がり、cut でなく見え掛かり（below）の外形が中線で出る。天井の縁など他の線は細線のまま', () => {
  const g = makeGrid([0, 4000], [0, 1000, 4000], { id: 'beamUnder', startFloor: 1 });
  const room = g.interior([[0, 0], [0, 1]], { walls: true });
  room.setOverride('ceilingHeight', '2400');
  room.setCeilingZones(assignZoneSpec(g.graph, room, [g.cell(0, 0)], { heightMm: 2600, shape: 'flat', dims: [] })); // y=1000 に天井の境
  const beam = addBeamH(g.graph, { axis: 1000, from: 500, to: 3500, levelOffset: 1640 }); // 成 200 → z 1440〜1640
  assert.equal(ceilingCutResolverOf(g.graph).roomCutMm.get(room.id), 1439, '前提: 部屋の切断高は梁の下端の直下');
  const prims = planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT });
  const beamLines = prims.filter(p => p.kind === 'line' && p.source.id === beam.id);
  assert.deepEqual(sortedPts(beamLines), outline4(500, 950, 3500, 1050), '梁の外形 4 辺');
  assert.ok(beamLines.every(p => p.cls === 'below' && p.weight === 'medium' && p.droppedBeam === true), '見え掛かり（cut でない）・中線');
  assert.ok(!prims.some(p => p.cls === 'cut'), '切断線なし（階の値 1500 で切ると梁が cut の太線になる）');
  const ceilingLines = prims.filter(p => p.kind === 'line' && p.source.kind === 'ceiling');
  assert.deepEqual(sortedPts(ceilingLines), [[57.5, 1000, 500, 1000], [3500, 1000, 3942.5, 1000]], '梁の上の天井の境は梁に隠れる（500〜3500 が無い）');
  assert.ok(ceilingLines.every(p => p.weight === 'thin'), '天井の線は細線のまま');
  assert.ok(prims.filter(p => p.weight === 'medium').every(p => p.source.id === beam.id), '中線は下がり梁の外形だけ');
});

test('見上げ（下がり梁）: 天井の無い所（吹抜け）の上の梁は階の値で切る（cut の太線のまま・中線にしない）。隣の天井のある部屋は梁に引かれず天井直下', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000], { id: 'beamVoid', startFloor: 1 });
  const room = g.interior([[0, 0]], { walls: true });
  room.setOverride('ceilingHeight', '2400');
  g.feature([[1, 0]], RoomFeature.VOID);
  const beam = addBeamH(g.graph, { axis: 1500, from: 2300, to: 3700, levelOffset: 1640 }); // 吹抜けの上。階の値 1500 をまたぐ
  const resolver = ceilingCutResolverOf(g.graph);
  assert.equal(resolver.roomCutMm.get(room.id), 2399);
  assert.deepEqual(resolver.droppedBeams, []);
  const lines = planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT }).filter(p => p.kind === 'line' && p.source.id === beam.id);
  assert.ok(lines.length > 0 && lines.every(p => p.cls === 'cut' && p.weight === 'thick' && !p.droppedBeam));
});

test('見上げ（下がり梁）: 天井より上の梁（床梁。z 2500〜2700）は部屋を下げず、cut もされず線が出ない（天井の上）', () => {
  const g = makeRoomGraph(0, 0, 4000, 4000, { id: 'beamAbove', startFloor: 1 });
  g.room.setOverride('ceilingHeight', '2400');
  const beam = addBeamH(g.graph, { axis: 1500, from: 500, to: 3500, levelOffset: 2700 });
  assert.equal(ceilingCutResolverOf(g.graph).roomCutMm.get(g.room.id), 2399);
  assert.ok(!planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT }).some(p => p.source.id === beam.id));
});

test('見上げ（下がり梁）: 傾斜天井の高い側でだけ天井より下に見える長い梁も下がり梁（外形は medium）。中心の天井より上にあっても取りこぼさない', () => {
  const s = makeGrid([0, 4000], [0, 4000], { id: 'slopeBeam', startFloor: 1 });
  const room = s.interior([[0, 0]], { walls: true });
  room.setCeilingZones(assignZoneSpec(s.graph, room, [s.cell(0, 0)], { heightMm: 2050, shape: 'slope', dims: [1900, 0] }));
  const field = buildCeilingHeightField(s.graph);
  const zLo = field.zAt(2000, 1000).zMm + 300;
  assert.ok(field.zAt(3900, 1000).zMm - zLo > 100, '前提: 高い側の天井は梁の下端より上');
  const beam = addBeamH(s.graph, { axis: 1000, from: 100, to: 3900, levelOffset: zLo + 200 });
  const lines = planSolidsLayerPrimitivesUp({ graph: s.graph, cutZ: CUT }).filter(p => p.kind === 'line' && p.source.id === beam.id);
  assert.ok(lines.length > 0 && lines.every(p => p.cls === 'below' && p.weight === 'medium' && p.droppedBeam === true), JSON.stringify(lines.map(p => [p.cls, p.weight])));
});

test('見上げ（下がり梁）: 上階の層の梁は下がり梁にしない。上階の梁が自階の天井より低い z にあっても、部屋の切断高は下がらず、中線も付かない', () => {
  const self = makeGrid([0, 4000], [0, 4000], { id: 'selfL', startFloor: 1 });
  const room = self.interior([[0, 0]], { walls: true });
  room.setOverride('ceilingHeight', '2400');
  const upper = makeGrid([0, 4000], [0, 4000], { id: 'upperL', startFloor: 2 });
  upper.interior([[0, 0]], { walls: true });
  const upBeam = addBeamH(upper.graph, { axis: 1500, from: 500, to: 3500, levelOffset: -1800 }); // 上階の床 2800 −1800 → z 800〜1000（自階の天井 2400 より低い）
  const abovePeek = { graph: upper.graph, floorHeightMm: 2800, activePlaneId: self.graph.plane.id };
  const prims = planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: CUT });
  assert.ok(!prims.some(p => p.droppedBeam || p.weight === 'medium' && p.source.id === upBeam.id), '中線なし');
  const ownBeams = ownLayerBeamSolids(planSolidsLayerSolidsUp({ graph: self.graph, abovePeek }));
  assert.equal(ceilingCutResolverOf(self.graph, { beamSolids: ownBeams }).roomCutMm.get(room.id), 2399, '部屋の切断高は天井の直下のまま');
  // 見上げの立体は上階の梁を含めない（lookUp）が、含まれた場合も自階の層だけを下がり梁の判定へ渡す
  const upperSolid = { kind: 'beam', footprint: { rects: [{ x1: 500, y1: 1450, x2: 3500, y2: 1550 }] }, zLo: 800, zHi: 1000, source: { kind: 'beam', id: 'up', layerFloorZ: 2800 } };
  const selfSolid = { ...upperSolid, zLo: 2300, zHi: 2500, source: { kind: 'beam', id: 'own', layerFloorZ: 0 } };
  const noLayer = { ...selfSolid, source: { kind: 'beam', id: 'noLayer' } };
  assert.deepEqual(ownLayerBeamSolids([upperSolid, selfSolid, noLayer, { kind: 'wall', source: { kind: 'wall', id: 'w', layerFloorZ: 0 } }, null]).map(s => s.source.id), ['own', 'noLayer']);
  assert.equal(ceilingCutResolverOf(self.graph, { beamSolids: [upperSolid] }).droppedBeams.length, 1, '前提: 上階の梁を渡せば下がり梁になってしまう');
  assert.equal(ceilingCutResolverOf(self.graph, { beamSolids: ownLayerBeamSolids([upperSolid]) }).droppedBeams.length, 0);
});

test('【失敗系】見上げ: 切断高が非有限なら空配列のまま（部屋ごとの切断高の解決を通らない）', () => {
  const { self } = lowRoomScene();
  assert.deepEqual(planSolidsLayerPrimitivesUp({ graph: self.graph, cutZ: NaN }), []);
  assert.deepEqual(planSolidsLayerPrimitivesUp({ graph: null, cutZ: CUT }), []);
});

/** 下階: 部屋 A（x 0..2000）・部屋 B（x 2000..4000）。上階: B の上が吹抜け（withVoid=false なら B も部屋）。 */
function openingEdgeScene({ withVoid = true } = {}) {
  const self = makeGrid([0, 2000, 4000], [0, 4000], { id: 'low', startFloor: 1 });
  self.interior([[0, 0]]); self.interior([[1, 0]]);
  const above = makeGrid([0, 2000, 4000], [0, 4000], { id: 'high', startFloor: 2 });
  above.interior([[0, 0]]);
  if (withVoid) above.feature([[1, 0]], RoomFeature.VOID); else above.interior([[1, 0]]);
  return { self, abovePeek: { graph: above.graph, floorHeightMm: 2800, activePlaneId: self.graph.plane.id } };
}

test('見上げ: 上階の床の穴の縁（外形線の上）の線は中線（medium）になり、同じ直線上で重ならない。見下げの経路では中線を付けない', () => {
  const { self, abovePeek } = openingEdgeScene();
  const prims = planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: CUT });
  const medium = prims.filter(p => p.kind === 'line' && p.weight === 'medium');
  assert.ok(medium.length > 0, '穴の縁に中線が出る');
  const onHoleEdge = ([x1, y1, x2, y2]) => (x1 === x2 && (x1 === 2000 || x1 === 4000) && Math.min(y1, y2) >= 0 && Math.max(y1, y2) <= 4000)
    || (y1 === y2 && (y1 === 0 || y1 === 4000) && Math.min(x1, x2) >= 2000 && Math.max(x1, x2) <= 4000);
  assert.ok(medium.every(p => onHoleEdge(p.points)), `中線は穴の縁の上だけ: ${JSON.stringify(medium.map(p => p.points))}`);
  // 穴の西の縁 x=2000 は天井の縁・床の縁が重なるが 1 本（総延長 4000）だけ出る
  const west = medium.filter(p => p.points[0] === 2000 && p.points[2] === 2000);
  assert.equal(west.reduce((s, p) => s + Math.abs(p.points[3] - p.points[1]), 0), 4000);
  // 見下げの経路（planSolidsLayerPrimitives）には中線を付けない
  const down = planSolidsLayerPrimitives({ graph: self.graph, belowPeek: null, cutZ: CUT });
  assert.equal(down.filter(p => p.weight === 'medium').length, 0);
});

test('見上げ: 両側が天井の外形線（穴は階段吹抜けで下の天井が残る配置＝13 の階段下部屋相当）は中線にしない。見える穴が無ければ中線 0', () => {
  const self = makeGrid([0, 2000, 4000], [0, 4000], { id: 'low', startFloor: 1 });
  self.interior([[0, 0]]); self.interior([[1, 0]]);
  const above = makeGrid([0, 2000, 4000], [0, 4000], { id: 'high', startFloor: 2 });
  above.interior([[0, 0]]);
  above.feature([[1, 0]], RoomFeature.STAIR_VOID); // 穴にはなるが、自階の天井（規則 V の対象外）は残る
  const abovePeek = { graph: above.graph, floorHeightMm: 2800, activePlaneId: self.graph.plane.id };
  const holes = planSolidsLayerSolidsUp({ graph: self.graph, abovePeek }).find(s => s.kind === 'floor' && s.source.layerFloorZ === 2800).footprint.holes ?? [];
  assert.ok(holes.length > 0, '前提: 上階の床に穴がある');
  const prims = planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: CUT });
  assert.equal(prims.filter(p => p.weight === 'medium').length, 0);
});

test('見上げ: 自階に部屋が無い（天井 0）とき、上階の吹抜けの縁は中線になり落ちない', () => {
  const self = makeGrid([0, 2000, 4000], [0, 4000], { id: 'low', startFloor: 1 }); // 部屋なし
  const above = makeGrid([0, 2000, 4000], [0, 4000], { id: 'high', startFloor: 2 });
  above.interior([[0, 0]]); above.feature([[1, 0]], RoomFeature.VOID);
  const abovePeek = { graph: above.graph, floorHeightMm: 2800, activePlaneId: self.graph.plane.id };
  const prims = planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: CUT });
  assert.ok(prims.some(p => p.kind === 'line' && p.weight === 'medium' && p.points[0] === 2000 && p.points[2] === 2000), 'x=2000 の縁が中線');
});

test('【失敗系】見上げ: 上階に穴が無い・上階が無いときは中線が出ない', () => {
  for (const abovePeek of [openingEdgeScene({ withVoid: false }).abovePeek, null]) {
    const { self } = openingEdgeScene();
    const prims = planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: CUT });
    assert.equal(prims.filter(p => p.weight === 'medium').length, 0);
  }
});

test('見上げ: 直上階の下屋の軒先・けらばの外形線（roof/outline）は中線。見下げの経路・hip・ridge は細線のまま', () => {
  const self = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500], { id: 'low', startFloor: 1 });
  self.interior([[0, 0]]);
  const above = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500], { id: 'high', startFloor: 2 });
  above.roof([[1, 1], [2, 1], [1, 2], [2, 2]]);
  above.graph.rooms.find(r => r.roofSpec).roofSpec.setField('shape', RoofShape.HIP); // 寄棟＝隅木・棟木の線（outline 以外）が出る形
  const abovePeek = { graph: above.graph, floorHeightMm: 2800, activePlaneId: self.graph.plane.id };
  const prims = planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: CUT });
  const outlines = prims.filter(p => p.kind === 'line' && p.source.kind === 'roof' && p.source.role === 'outline');
  assert.ok(outlines.length > 0, '前提: 上階の下屋の外形線が出る');
  assert.ok(outlines.every(p => p.weight === 'medium' && p.source.layerFloorZ > 0), JSON.stringify(outlines.map(p => [p.weight, p.source])));
  const others = prims.filter(p => p.kind === 'line' && p.source.kind === 'roof' && p.source.role !== 'outline');
  assert.ok(others.some(p => p.source.role === 'hip') && others.some(p => p.source.role === 'ridge'), '前提: 隅木・棟木の線が出る');
  assert.ok(others.every(p => p.weight === 'thin'), 'outline 以外の下屋の線は細線');
  // 見下げ（下屋を自階に持つ）では中線にしない
  const down = planSolidsLayerPrimitives({ graph: above.graph, cutZ: CUT });
  const downOutlines = down.filter(p => p.kind === 'line' && p.source.kind === 'roof' && p.source.role === 'outline');
  assert.ok(downOutlines.length > 0 && downOutlines.every(p => p.weight === 'thin'));
});

test('【失敗系】見上げ: 上階に下屋が無ければ roof の線も中線の追加も出ない', () => {
  const self = makeGrid([0, 2000, 4000], [0, 1500, 3000], { id: 'low', startFloor: 1 });
  self.interior([[0, 0]]);
  const above = makeGrid([0, 2000, 4000], [0, 1500, 3000], { id: 'high', startFloor: 2 });
  above.interior([[0, 0]]);
  const abovePeek = { graph: above.graph, floorHeightMm: 2800, activePlaneId: self.graph.plane.id };
  const prims = planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: CUT });
  assert.equal(prims.filter(p => p.source.kind === 'roof').length, 0);
});

test('見上げ: 軒裏の910割付線は本番経路で detailOnly:true・style:eaveSoffitJoint・thin。標準 LOD で落ち詳細で残る。見下げには出ない。水平では隅木が消える', () => {
  const build = orientation => {
    const self = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500], { id: 'low', startFloor: 1 });
    self.interior([[0, 0]]);
    const above = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500], { id: 'high', startFloor: 2 });
    above.roof([[1, 1], [2, 1], [1, 2], [2, 2]]);
    const spec = above.graph.rooms.find(r => r.roofSpec).roofSpec;
    spec.setField('shape', RoofShape.HIP);
    if (orientation) spec.setField('soffitOrientation', orientation);
    return { self, above, abovePeek: { graph: above.graph, floorHeightMm: 2800, activePlaneId: self.graph.plane.id } };
  };
  const { self, above, abovePeek } = build();
  const prims = planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: CUT });
  const joints = prims.filter(p => p.kind === 'line' && p.source.kind === 'roof' && p.source.role === 'eaveSoffitJoint');
  assert.ok(joints.length > 0, '前提: 割付線が出る');
  assert.ok(joints.every(p => p.detailOnly === true && p.style === 'eaveSoffitJoint' && p.weight === 'thin' && p.source.layerFloorZ > 0), JSON.stringify(joints[0]));
  const std = visiblePlanPrimitives(prims, LodLevel.STANDARD);
  const det = visiblePlanPrimitives(prims, LodLevel.DETAIL);
  assert.equal(std.filter(p => p.source?.role === 'eaveSoffitJoint').length, 0, '標準 LOD では落ちる');
  assert.equal(det.filter(p => p.source?.role === 'eaveSoffitJoint').length, joints.length, '詳細 LOD では残る');
  assert.equal(prims.filter(p => p.kind === 'arrow' || p.kind === 'text').filter(p => p.source?.kind === 'roof').length, 0, '傾斜ラベルなし');
  const down = planSolidsLayerPrimitives({ graph: above.graph, cutZ: CUT });
  assert.equal(down.filter(p => p.source?.role === 'eaveSoffitJoint').length, 0, '見下げには出ない');
  const level = build('level');
  const lp = planSolidsLayerPrimitivesUp({ graph: level.self.graph, abovePeek: level.abovePeek, cutZ: CUT });
  const roles = new Set(lp.filter(p => p.kind === 'line' && p.source.kind === 'roof').map(p => p.source.role));
  assert.ok(roles.has('eaveSoffitJoint') && roles.has('outline'), '水平でも外形線・割付線は出る');
  assert.ok(!roles.has('hip') && !roles.has('ridge'), '水平なら棟木・隅木は消える');
});
