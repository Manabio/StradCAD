// planSolidsLayerFilter.js（S4: 新レイヤへ渡す線の絞り込みと層スタックの組み立て）の単体テスト。実物の PlanGraph で組む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature, StairType } from '@core';
import {
  S4_DRAWN_KINDS, BELOW_DRAWN_KINDS, drawnPrimitives, planSolidsLayerPrimitives, planSolidsLayerSolids, planSolidsLayerCacheSpec, planSolidsLayerResolve, isCenterLineDragging,
  visiblePlanPrimitives, UP_SELF_DRAWN_KINDS, UP_ABOVE_DRAWN_KINDS, planSolidsLayerPrimitivesUp, planSolidsLayerSolidsUp,
} from './planSolidsLayerFilter.js';
import { LodLevel } from '../viewport.js';
import { cellBoundsFromKey } from '../finish/gridCells.js';
import { planSolids } from './planSolids.js';
import { isInsideFootprint } from './planGeometry.js';
import { makeGrid, makeRoomGraph, addBeamH, addColumnAt, linesOf } from './planTestFixtures.js';

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
  for (const k of ['wall', 'column', 'floor', 'beam']) assert.ok(kindsOf(lower).has(k), `下階の ${k} の線が出る: ${[...kindsOf(lower)]}`);
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

function switchback(id) {
  const g = makeGrid([0, 1000, 2000], [0, 1500, 4500], { id });
  const { graph, cx, cy } = g;
  const landing = `${cx[0].id}:${cy[0].id}:${cx[2].id}:${cy[1].id}`;
  const outbound = `${cx[0].id}:${cy[1].id}:${cx[1].id}:${cy[2].id}`;
  const ret = `${cx[1].id}:${cy[1].id}:${cx[2].id}:${cy[2].id}`;
  const room = graph.addRoom(new Set([landing, outbound]), '階段'); // 破れ先 ret は部屋に含めない
  graph.addStair({
    type: StairType.SWITCHBACK, cells: new Set([landing, outbound, ret]), roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
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

test('見上げ: 壁のある部屋では天井の外形は壁（切断）が隠す。壁そのものは描かない（ShapesLayer の仕事）。残るのは壁の取り合いの隅の短い断片だけ', () => {
  const { self, abovePeek } = upScene();
  const prims = planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: CUT });
  assert.ok(!prims.some(p => p.source.kind === 'wall' && (p.source.layerFloorZ ?? 0) === 0), '自階の壁は描かない');
  const ceil = prims.filter(p => p.source.kind === 'ceiling');
  assert.ok(ceil.length > 0 && ceil.every(p => Math.hypot(p.points[2] - p.points[0], p.points[3] - p.points[1]) <= 57.5 + 1e-6), `隅の 57.5mm 以下の断片だけ: ${JSON.stringify(sortedPts(ceil))}`);
});

test('見上げ: 自階に天井が無い（吹抜け）と、上階の梁が細線（layerFloorZ=階高）で見える。上階が無い・階高が不正なら上階の線は出ない', () => {
  const { self, abovePeek, beam } = upScene({ selfVoid: true });
  const prims = planSolidsLayerPrimitivesUp({ graph: self.graph, abovePeek, cutZ: CUT });
  const mine = prims.filter(p => p.source.id === beam.id);
  assert.deepEqual(sortedPts(mine), outline4(500, 950, 3500, 1050));
  assert.ok(mine.every(p => p.cls === 'below' && p.weight === 'thin' && p.source.layerFloorZ === 2800));
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
  assert.ok((upFloor.footprint.holes ?? []).some(h => h.x1 === 1000 && h.y1 === 1500 && h.x2 === 2000 && h.y2 === 4500), `破れ先が穴: ${JSON.stringify(upFloor.footprint.holes)}`);
  assert.ok(asked.length > 0 && asked.every(s => high.stairs.includes(s)), '最上の層＝上階の階段の蹴上を aboveRiserOf で問う');
  // 自階に同じ階段が無ければ穴にならない
  const noStair = makeGrid([0, 1000, 2000], [0, 1500, 4500], { id: 'bare' });
  noStair.interior([[0, 0], [0, 1], [1, 0], [1, 1]]);
  const flat = planSolidsLayerSolidsUp({ graph: noStair.graph, abovePeek: { ...abovePeek, activePlaneId: noStair.graph.plane.id }, aboveRiserOf });
  assert.equal((flat.find(s => s.kind === 'floor' && s.source.layerFloorZ === 2800).footprint.holes ?? []).length, 0);
  // 穴の縁の線: 天井の無い所（自階の部屋の外）で上階の床の縁が細線で出る
  const prims = planSolidsLayerPrimitivesUp({ graph: low, abovePeek, aboveRiserOf, cutZ: CUT });
  const edge = prims.filter(p => p.source.kind === 'floor' && p.source.layerFloorZ === 2800);
  assert.ok(edge.length > 0 && edge.every(p => p.cls === 'below' && p.weight === 'thin'), `穴の縁が細線で出る: ${edge.length}`);
});

test('見上げの鍵: planSection:up:… で見下げの鍵と衝突しない。置き場は上階 peek の graph（無ければ自階）、pending／- の区別、階の違う peek は使わない', () => {
  const { self, above, abovePeek } = upScene();
  const g = self.graph;
  const a = planSolidsLayerCacheSpec(g, abovePeek, 'up');
  assert.equal(a.key, `planSection:up:${g.plane.id}:1500:high`);
  assert.ok(a.home === above.graph && a.peek === abovePeek);
  assert.equal(planSolidsLayerCacheSpec(g, null, 'up').key, `planSection:up:${g.plane.id}:1500:-`);
  assert.equal(planSolidsLayerCacheSpec(g, undefined, 'up').key, `planSection:up:${g.plane.id}:1500:pending`);
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
  assert.equal(up1.key, `planSection:up:${g.plane.id}:1500:-`);
  const down1 = planSolidsLayerCacheSpec(g, null, 'down');
  assert.equal(down1.cutZ, 1800);
  assert.equal(down1.key, `planSection:${g.plane.id}:1800:-`);
  g.plane.ceilingCutHeightMm = 2100;
  const up2 = planSolidsLayerCacheSpec(g, null, 'up');
  assert.equal(up2.cutZ, 2100, '天伏の切断高を変えると up が変わる');
  assert.equal(up2.key, `planSection:up:${g.plane.id}:2100:-`);
  assert.equal(planSolidsLayerCacheSpec(g, null, 'down').key, down1.key, '天伏の切断高は down の鍵に影響しない');
  assert.equal(tailOf(up2, g.plane.id), '2100:-');
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
  assert.deepEqual(memoCalls, [`planSection:up:${g.plane.id}:1500:pending`, `planSection:up:${g.plane.id}:1700:pending`]);
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
  assert.match(keys[0], /^planSection:up:.*:pending$/);
  assert.equal(planSolidsLayerResolve({ graph: null, abovePeek, direction: 'up', memo }), null);
  self.cx[0].pendingDelta = 5;
  assert.equal(planSolidsLayerResolve({ graph: self.graph, abovePeek, direction: 'up', prevPrims: ['prev'], memo }).length, 1, 'ドラッグ中は前回の線');
});
