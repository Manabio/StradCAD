// planSolids.js（平面の立体モデル。S2）の単体テスト。実物の PlanGraph / Plane で組む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature, StairType, RoofShape, edgeKey } from '@core';
import {
  planSolids, floorSolidOf, SOLID_KIND_ORDER, layerCeilZ,
} from './planSolids.js';
import { isInsideFootprint } from './planGeometry.js';
import { leanToPlanRegions } from '../structural/roofFramingRegions.js';
import { roofPlanRegionFigure } from '../finish/roof/roofPlanFigure.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';
import { columnWrapSolids } from '../finish/columnWrap.js';
import { stairTreadFootprints } from '../finish/stair/stairTreads.js';
import { planSectionFigure } from './planSectionFigure.js';
import {
  makeGrid, makeRoomGraph, fakeLayer, addBeamH, addColumnAt, rect, solid, linesOf, mergedLines, totalLength,
} from './planTestFixtures.js';

const ofKind = (solids, kind) => solids.filter(s => s.kind === kind);
const self = graph => [fakeLayer({ graph })];

// ================================================================ 梁

test('梁: 天端 = 層のFL + levelOffset、下端 = 天端 − 成。footprint は 芯±幅/2 × スパンの帯。source は梁id・role', () => {
  const graph = fakeLayer().graph;
  const beam = addBeamH(graph, { axis: 1000, from: 0, to: 2000, levelOffset: -20 }); // STEEL-H200x100（幅100・成200）
  const beams = ofKind(planSolids([fakeLayer({ graph, floorZMm: 2800, role: 'above' })]), 'beam');
  assert.equal(beams.length, 1);
  const [b] = beams;
  assert.deepEqual(b.footprint, { rects: [rect(0, 950, 2000, 1050)] });
  assert.equal(b.zHi, 2780, 'zHi = floorZMm(2800) + levelOffset(-20)');
  assert.equal(b.zLo, 2580, 'zLo = zHi − 成(200)');
  assert.deepEqual(b.source, { kind: 'beam', id: beam.id, layerFloorZ: 2800, role: 'primary' });
});

test('梁: 基礎梁・土台・小屋梁は立体にしない。隔て梁・踊り場受け梁を含む他の役割は立体にする', () => {
  const graph = fakeLayer().graph;
  const excluded = ['foundation', 'sill', 'roofBeam'];
  const included = ['primary', 'secondary', 'floor', 'landing', 'partitionBeam'];
  [...excluded, ...included].forEach((role, i) => addBeamH(graph, { axis: 1000 + i * 500, role }));
  const roles = ofKind(planSolids(self(graph)), 'beam').map(s => s.source.role);
  assert.equal(roles.length, included.length, '含める役割だけが残る');
  assert.deepEqual([...roles].sort(), [...included].sort());
});

test('梁: 成は断面カタログ → beamDepth → 既定105。未知の断面でも例外にしない', () => {
  const graph = fakeLayer().graph;
  const unknown = addBeamH(graph, { axis: 500, sectionDefId: 'NO-SUCH-SECTION', material: 'WOOD' });
  const withDepth = addBeamH(graph, { axis: 1500, sectionDefId: 'NO-SUCH-SECTION', material: 'WOOD' });
  withDepth.beamDepth = 240;
  const beams = ofKind(planSolids(self(graph)), 'beam');
  assert.equal(beams.length, 2);
  const depthOf = id => { const s = beams.find(b => b.source.id === id); return s.zHi - s.zLo; };
  assert.equal(depthOf(unknown.id), 105, '未知の断面＝既定105');
  assert.equal(depthOf(withDepth.id), 240, 'カタログに無ければ beamDepth');
});

// ================================================================ 柱

test('柱: 足元 = 層のFL、上端 = 層の天井。ceilZMm があればそれ。杭（foundation）は立体にしない', () => {
  const graph = fakeLayer().graph;
  const col = addColumnAt(graph, 1000, 2000);
  addColumnAt(graph, 3000, 2000, { role: 'foundation' });
  const normal = ofKind(planSolids([fakeLayer({ graph, floorZMm: 2800, role: 'above' })]), 'column');
  assert.equal(normal.length, 1, '杭は除く');
  assert.deepEqual(normal[0].footprint, { rects: [rect(947.5, 1947.5, 1052.5, 2052.5)] });
  assert.equal(normal[0].zLo, 2800);
  assert.equal(normal[0].zHi, 2800 + 2400, '既定の天井高 2400');
  assert.equal(normal[0].source.id, col.id);
  const below = ofKind(planSolids([fakeLayer({ graph, floorZMm: -2800, role: 'below', ceilZMm: -500 })]), 'column');
  assert.equal(below[0].zHi, -500, '層が持つ ceilZMm を優先');
});

test('柱: 仕上げ包みを持つ構造（S造）は壁に接する面が包まれた外形、在来木造は素の断面', () => {
  const place = (structure) => {
    const { graph } = makeRoomGraph(0, 0, 4000, 4000);
    graph.structureOverride = structure;
    addColumnAt(graph, 250, 2000); // 壁面（x=57.5）から150mm以内＝取り合う
    const cols = ofKind(planSolids(self(graph)), 'column');
    assert.equal(cols.length, 1);
    return cols[0].footprint.rects[0];
  };
  const bare = rect(197.5, 1947.5, 302.5, 2052.5);
  assert.deepEqual(place(TRADITIONAL_WOOD_STRUCTURE), bare, '在来木造は包みなし');
  const wrapped = place('S造');
  assert.ok(wrapped.x1 < bare.x1 && wrapped.x2 > bare.x2 && wrapped.y1 < bare.y1 && wrapped.y2 > bare.y2,
    `S造は包まれて外形が広がる: ${JSON.stringify(wrapped)}`);
});

test('柱: 壁の中に完全に納まる柱（columnWrapSolids の hidden）も立体として残す（見える／見えないは幾何が決める）', () => {
  const { graph } = makeRoomGraph(0, 0, 4000, 4000);
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  // 南の壁の材厚（y=3942.5..4045）に収まる 90 角を、壁の長さの中ほどに置く
  addColumnAt(graph, 2000, 3993.75, { sectionDefId: 'WOOD-90x90' });
  addColumnAt(graph, 1000, 2000, { sectionDefId: 'WOOD-90x90' }); // 壁から離れた柱（対照）
  const wrap = columnWrapSolids(graph, { noCover: true });
  assert.deepEqual(wrap.map(w => w.hidden).sort(), [false, true], '前提: 1本は壁に埋まる（hidden）・1本は埋まらない');
  const cols = ofKind(planSolids(self(graph)), 'column');
  assert.equal(cols.length, 2, '壁に埋まる柱も落とさない');
  assert.ok(cols.some(c => c.footprint.rects[0].y1 > 3942.5 && c.footprint.rects[0].y2 < 4045), '壁の中の柱の立体がある');
});

// ================================================================ 壁

function southWallOf(graph, axis = 4000) {
  const wall = graph.walls.find(w => !w.isVertical && w.axisCL.effectiveValue === axis);
  assert.ok(wall, '前提: 壁がある');
  return wall;
}
const wallSolidsOf = (graph, wall) => ofKind(planSolids(self(graph)), 'wall')
  .filter(s => s.source.id === wall.id).sort((a, b) => a.source.part - b.source.part);

test('壁: 全高の壁は FL〜天井。厚み方向は隠せる材の範囲（材＋下地）、長さは壁の端から端', () => {
  const { graph } = makeRoomGraph(0, 0, 4000, 4000);
  const walls = ofKind(planSolids(self(graph)), 'wall');
  assert.equal(walls.length, 4);
  assert.ok(walls.every(s => s.zLo === 0 && s.zHi === 2400));
  const south = wallSolidsOf(graph, southWallOf(graph));
  assert.equal(south.length, 1);
  assert.deepEqual(south[0].footprint, { rects: [rect(57.5, 3942.5, 3942.5, 4045)] });
});

test('壁: 腰壁（knee）は FL〜腰高さ、垂れ壁（drop）は垂れ下端〜天井', () => {
  const { graph, cx } = makeRoomGraph(0, 0, 4000, 4000);
  const wall = southWallOf(graph);
  const key = edgeKey(wall.axisCL.id, cx[0].id, cx[1].id);
  graph.setKneeDropWall(key, { knee: { topHeight: 800 } });
  assert.deepEqual(wallSolidsOf(graph, wall).map(s => [s.zLo, s.zHi]), [[0, 800]]);
  graph.setKneeDropWall(key, { drop: { bottomHeight: 600 } });
  assert.deepEqual(wallSolidsOf(graph, wall).map(s => [s.zLo, s.zHi]), [[1800, 2400]]);
});

test('壁: 腰壁＋垂れ壁の両方はアキ（四角い穴）で 2 件（part 0・1）。他の壁は全高のまま', () => {
  const { graph, cx } = makeRoomGraph(0, 0, 4000, 4000);
  const wall = southWallOf(graph);
  graph.setKneeDropWall(edgeKey(wall.axisCL.id, cx[0].id, cx[1].id), { knee: { topHeight: 800 }, drop: { bottomHeight: 600 } });
  const parts = wallSolidsOf(graph, wall);
  assert.deepEqual(parts.map(s => [s.source.part, s.zLo, s.zHi]), [[0, 0, 800], [1, 1800, 2400]]);
  const others = ofKind(planSolids(self(graph)), 'wall').filter(s => s.source.id !== wall.id);
  assert.equal(others.length, 3);
  assert.ok(others.every(s => s.zLo === 0 && s.zHi === 2400));
});

test('壁: 腰壁レコードの端で壁を分割する（1本の壁が複数区間にまたがる）。レコードが無い区間は全高', () => {
  // 4000 に区切りCLのある 2 セルの部屋（南の壁は 1 本につながる）
  const g = makeGrid([0, 4000, 8000], [0, 4000]);
  g.interior([[0, 0], [1, 0]], { walls: true });
  const wall = southWallOf(g.graph);
  g.graph.setKneeDropWall(edgeKey(wall.axisCL.id, g.cx[0].id, g.cx[1].id), { knee: { topHeight: 800 } });
  const parts = wallSolidsOf(g.graph, wall);
  assert.equal(parts.length, 2, 'レコード端（x=4000）で 2 区間');
  assert.deepEqual(parts.map(s => [s.footprint.rects[0].x1, s.footprint.rects[0].x2, s.zLo, s.zHi]), [
    [57.5, 4000, 0, 800],
    [4000, 7942.5, 0, 2400],
  ]);
});

test('壁: 上端は壁ごとに1つ（両側の部屋の天井高）。レコードの有無で区間ごとに変わらない', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000]);
  const room = g.interior([[0, 0], [1, 0]], { walls: true });
  room.setOverride('ceilingHeight', '3000');
  const wall = southWallOf(g.graph);
  g.graph.setKneeDropWall(edgeKey(wall.axisCL.id, g.cx[0].id, g.cx[1].id), { drop: { bottomHeight: 600 } });
  const parts = wallSolidsOf(g.graph, wall);
  assert.deepEqual(parts.map(s => [s.zLo, s.zHi]), [[2400, 3000], [0, 3000]], '垂れ壁区間も他の区間も上端は部屋CH 3000');
});

test('壁: レコードの無い全高の壁の上端も部屋の天井高（層の既定2400でない）。層の ceilZMm があればそれが優先', () => {
  const { graph, room } = makeRoomGraph(0, 0, 4000, 4000);
  room.setOverride('ceilingHeight', '3000');
  const walls = ofKind(planSolids(self(graph)), 'wall');
  assert.equal(walls.length, 4);
  assert.ok(walls.every(s => s.zLo === 0 && s.zHi === 3000));
  const withLayerCeil = ofKind(planSolids([fakeLayer({ graph, ceilZMm: 2700 })]), 'wall');
  assert.ok(withLayerCeil.length === 4 && withLayerCeil.every(s => s.zHi === 2700));
});

test('壁: 隅で壁端がレコード端の外へはみ出しても細片を作らない（垂れ壁 x4000..8000・壁端 8057.5・部屋CH3000）', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000]);
  g.interior([[0, 0], [1, 0]], { walls: true }).setOverride('ceilingHeight', '3000');
  const wall = southWallOf(g.graph);
  g.graph.setKneeDropWall(edgeKey(wall.axisCL.id, g.cx[1].id, g.cx[2].id), { drop: { bottomHeight: 1000 } });
  wall[wall.coord2 > wall.coord1 ? 'endOffset' : 'startOffset'] = 57.5; // 隅の取り合い（実データの形）
  assert.equal(Math.max(wall.coord1, wall.coord2), 8057.5, '前提: 壁端がレコード端 8000 の外へ 57.5');
  const parts = wallSolidsOf(g.graph, wall);
  const spans = parts.map(s => [s.footprint.rects[0].x1, s.footprint.rects[0].x2, s.zLo, s.zHi]);
  assert.deepEqual(spans, [[57.5, 4000, 0, 3000], [4000, 8057.5, 2000, 3000]]);
  assert.ok(spans.every(([a, b]) => b - a >= 150), '長さ150未満の細片が無い');
});

test('壁: 2セルとも同じ腰壁レコードを持つ1本の壁は、同じ高さの隣り合う区間を結合して 1 件', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000]);
  g.interior([[0, 0], [1, 0]], { walls: true });
  const wall = southWallOf(g.graph);
  g.graph.setKneeDropWall(edgeKey(wall.axisCL.id, g.cx[0].id, g.cx[1].id), { knee: { topHeight: 800 } });
  g.graph.setKneeDropWall(edgeKey(wall.axisCL.id, g.cx[1].id, g.cx[2].id), { knee: { topHeight: 800 } });
  const parts = wallSolidsOf(g.graph, wall);
  assert.equal(parts.length, 1);
  assert.deepEqual([parts[0].footprint.rects[0].x1, parts[0].footprint.rects[0].x2, parts[0].zLo, parts[0].zHi], [57.5, 7942.5, 0, 800]);
});

// ---- 同じ芯で接する帯の結合（下地の壁＋仕上げの薄壁。見下げは帯の外形だけ）

// graph.walls を壁の代役（芯 CL id・帯 materialRange・区間 coord1/2）で差し替えた下階の層。
function wallDoubleLayer(doubles, floorZMm = -3000) {
  const graph = Object.create(fakeLayer().graph); // 実 PlanGraph を継承し walls だけ差し替える
  const walls = doubles.map(({ id, isVertical = true, axis = 'A', band: [lo, hi], span: [c1, c2] }) => ({
    id, isVertical, axisCL: { id: axis }, coord1: c1, coord2: c2, materialRange: { lo, hi }, backingRange: null,
  }));
  Object.defineProperty(graph, 'walls', { value: walls });
  return fakeLayer({ graph, floorZMm, role: 'below' });
}
const wallsOf = layer => ofKind(planSolids([layer]), 'wall');
const OWNER = { id: 'owner', band: [325, 427.5], span: [100, 3100] };
const THIN = { id: 'thin', band: [312.5, 325], span: [100, 3100] };

test('壁の結合: 同じ芯・同じ高さで帯が接し区間が重なる2枚は 1 件（rects 2 個・mergedIds）。代表は壁 id 最小', () => {
  const walls = wallsOf(wallDoubleLayer([THIN, OWNER]));
  assert.equal(walls.length, 1);
  assert.deepEqual(walls[0].footprint, { rects: [rect(325, 100, 427.5, 3100), rect(312.5, 100, 325, 3100)] });
  assert.equal(walls[0].source.id, 'owner');
  assert.deepEqual(walls[0].source.mergedIds, ['owner', 'thin']);
  assert.deepEqual([walls[0].zLo, walls[0].zHi], [-3000, -600]);
});

test('壁の結合: 見下げの線は帯の外形だけ。下地/仕上げの境目（x=325）は描かず、外側の面（312.5・427.5）は残る', () => {
  const layer = wallDoubleLayer([OWNER, THIN]);
  const floor = solid('floor', { rects: [rect(0, 0, 1000, 4000)], holes: [rect(0, 0, 1000, 4000)] }, 0, 0, { id: 'f0', layerFloorZ: 0 });
  const prims = planSectionFigure([...planSolids([layer]), floor], 1000);
  const wallLines = linesOf(prims, 'below', 'wall');
  const verticals = mergedLines(wallLines).filter(l => l[0] === l[2]).map(l => l[0]);
  assert.deepEqual(verticals, [312.5, 427.5], `境目 325 の線が無い: ${JSON.stringify(mergedLines(wallLines))}`);
  assert.equal(totalLength(wallLines.filter(p => p.points[0] === 325 && p.points[2] === 325)), 0);
});

test('壁の結合: 高さ範囲が違う（腰壁＋全高の壁）・芯 CL が違う・向きが違う・区間が重ならない・帯が離れている壁は別のまま', () => {
  const kinds = {
    '芯CLが違う': [OWNER, { ...THIN, axis: 'B' }],
    '向きが違う': [OWNER, { ...THIN, isVertical: false }],
    '区間が重ならない（端が接するだけ）': [OWNER, { ...THIN, span: [3100, 4000] }],
    '帯が離れている': [OWNER, { ...THIN, band: [100, 300] }],
  };
  for (const [name, doubles] of Object.entries(kinds)) {
    const walls = wallsOf(wallDoubleLayer(doubles));
    assert.equal(walls.length, 2, name);
    assert.ok(walls.every(w => w.source.mergedIds === undefined && w.footprint.rects.length === 1), name);
  }
  // 高さ範囲が違う: 腰壁レコードのある側だけ [0,800] になり、全高 [0,2400] の隣と結合しない
  const g = makeGrid([0, 4000, 8000], [0, 4000]);
  g.interior([[0, 0], [1, 0]], { walls: true });
  const wall = southWallOf(g.graph);
  g.graph.setKneeDropWall(edgeKey(wall.axisCL.id, g.cx[0].id, g.cx[1].id), { knee: { topHeight: 800 } });
  const parts = wallSolidsOf(g.graph, wall);
  assert.deepEqual(parts.map(s => [s.zLo, s.zHi]), [[0, 800], [0, 2400]]);
  assert.ok(parts.every(s => s.source.mergedIds === undefined), '同じ壁の高さ違いの区間は結合しない');
});

test('壁の結合: 高さ範囲が違う区間とは、区間が重なり帯が接していても結合しない（同じ高さの区間とだけ結合する）', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000]);
  g.interior([[0, 0], [1, 0]], { walls: true });
  const real = southWallOf(g.graph);
  g.graph.setKneeDropWall(edgeKey(real.axisCL.id, g.cx[0].id, g.cx[1].id), { knee: { topHeight: 800 } });
  // 腰壁レコードの端（x=4000）より 0.5mm だけ先まで伸びる薄壁（仕上げ）。端が 1mm 未満なので分割されず、腰壁区間（中点の高さ）の1件になる。
  // 全高の区間（4000..）とは 0.5mm 重なり、帯も接するが、高さが違うので混ぜない
  const thin = { ...Object.create(real), id: 'thin', axisCL: real.axisCL, isVertical: false, coord1: 57.5, coord2: 4000.5,
    materialRange: { lo: 4045, hi: 4057.5 }, backingRange: null, clStart: undefined, clEnd: undefined };
  const graph = Object.create(g.graph);
  Object.defineProperty(graph, 'walls', { value: [...g.graph.walls.filter(w => w !== real), real, thin] });
  const walls = ofKind(planSolids([fakeLayer({ graph, ceilZMm: 2400 })]), 'wall').filter(s => s.footprint.rects[0].y1 >= 3942.5);
  assert.deepEqual(walls.map(s => [s.zLo, s.zHi, s.footprint.rects.length]).sort((a, b) => a[1] - b[1]), [[0, 800, 2], [0, 2400, 1]]);
  assert.equal(walls.find(s => s.zHi === 2400).source.mergedIds, undefined);
});

test('壁の結合: 壁の入力順を逆にしても、立体（source・rects の順）と線の key まで同一', () => {
  const floor = solid('floor', { rects: [rect(0, 0, 1000, 4000)], holes: [rect(0, 0, 1000, 4000)] }, 0, 0, { id: 'f0', layerFloorZ: 0 });
  const run = order => {
    const solids = planSolids([wallDoubleLayer(order)]);
    return { solids, prims: planSectionFigure([...solids, floor], 1000) };
  };
  const a = run([OWNER, THIN]), b = run([THIN, OWNER]);
  assert.deepEqual(b.solids, a.solids);
  assert.deepEqual(b.prims.map(p => [p.key, p.points]), a.prims.map(p => [p.key, p.points]));
});

test('壁の結合: 連鎖（A-B-C と順に接する）は 1 件にまとまり、出力順は入力の壁の順に依らない', () => {
  const MID = { id: 'mid', band: [427.5, 440], span: [100, 3100] };
  const a = wallsOf(wallDoubleLayer([OWNER, THIN, MID]));
  const b = wallsOf(wallDoubleLayer([MID, THIN, OWNER]));
  assert.equal(a.length, 1);
  assert.equal(a[0].footprint.rects.length, 3);
  assert.deepEqual([...a[0].source.mergedIds].sort(), ['mid', 'owner', 'thin']);
  assert.equal(b.length, 1);
  assert.equal(b[0].footprint.rects.length, 3);
});

// ================================================================ 床

test('床: 建物範囲のセル矩形・zLo=zHi=FL・穴なしは holes 空。部屋が無い階は床なし', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  g.interior([[0, 0], [1, 0]]);
  const floors = ofKind(planSolids([fakeLayer({ graph: g.graph, floorZMm: 2800, role: 'above' })]), 'floor');
  assert.equal(floors.length, 1);
  assert.deepEqual(floors[0].footprint, { rects: [rect(0, 0, 2000, 3000), rect(2000, 0, 4000, 3000)], holes: [] });
  assert.equal(floors[0].zLo, 2800);
  assert.equal(floors[0].zHi, 2800);
  assert.deepEqual(planSolids(self(fakeLayer().graph)), [], '部屋も実体も無い階は何も出さない');
  assert.equal(floorSolidOf(fakeLayer()), null);
});

test('床: rects は y1→x1 昇順（部屋のセルの登録順に依らない）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000, 6000]);
  g.interior([[1, 1], [0, 1], [1, 0], [0, 0]]); // 逆順で登録
  const [floor] = ofKind(planSolids(self(g.graph)), 'floor');
  assert.deepEqual(floor.footprint.rects, [
    rect(0, 0, 2000, 3000), rect(2000, 0, 4000, 3000), rect(0, 3000, 2000, 6000), rect(2000, 3000, 4000, 6000),
  ]);
});

test('床: 吹抜けのセルは穴（内側判定で床でなくなる）。穴の周りは床のまま', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  g.interior([[0, 0], [2, 0]]);
  g.feature([[1, 0]], RoomFeature.VOID);
  const [floor] = ofKind(planSolids(self(g.graph)), 'floor');
  assert.ok(floor, '床がある');
  assert.deepEqual(floor.footprint.holes, [rect(2000, 0, 4000, 3000)]);
  assert.equal(isInsideFootprint(floor.footprint, 3000, 1500), false, '吹抜けの中は床でない');
  assert.equal(isInsideFootprint(floor.footprint, 1000, 1500), true);
  assert.equal(isInsideFootprint(floor.footprint, 5000, 1500), true);
});

test('床: L字の穴はセル矩形の集まり（3セル）。切り欠きのセルは床のまま', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000, 6000]);
  g.interior([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]]);
  g.feature([[1, 0], [2, 0], [2, 1]], RoomFeature.VOID);
  const [floor] = ofKind(planSolids(self(g.graph)), 'floor');
  assert.equal(floor.footprint.holes.length, 3, 'L字の 3 セルがそれぞれ穴の矩形');
  assert.equal(isInsideFootprint(floor.footprint, 3000, 1500), false);
  assert.equal(isInsideFootprint(floor.footprint, 5000, 1500), false);
  assert.equal(isInsideFootprint(floor.footprint, 5000, 4500), false);
  assert.equal(isInsideFootprint(floor.footprint, 3000, 4500), true, 'L字の切り欠き（セル(1,1)）は床');
});

test('床: 屋根セルは建物範囲に入らない（下屋の下に床を張らない）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 1500]);
  g.interior([[0, 0]]);
  g.roof([[1, 0]]);
  const [floor] = ofKind(planSolids(self(g.graph)), 'floor');
  assert.deepEqual(floor.footprint.rects, [rect(0, 0, 2000, 1500)]);
  assert.equal(isInsideFootprint(floor.footprint, 3000, 750), false);
});

function switchbackGraph() {
  const g = makeGrid([0, 1000, 2000], [0, 1500, 4500]);
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

test('床: 階段の破れ先は、下階に同じ階段があるときだけ穴。無い・別位置なら穴にしない', () => {
  const graph = switchbackGraph();
  const layers = self(graph);
  const riserOf = () => 200;
  const holesWith = belowGraphOf => ofKind(planSolids(layers, { riserOf, belowGraphOf }), 'floor')[0].footprint.holes;
  assert.deepEqual(holesWith(undefined), [], '下階を渡さない（設置階自身）＝穴なし');
  assert.deepEqual(holesWith(() => null), [], '下階が無い');
  assert.deepEqual(holesWith(() => switchbackGraph()), [rect(1000, 1500, 2000, 4500)], '下階に同じ階段＝破れ先が穴');
  const other = makeGrid([0, 1000, 2000], [0, 1500, 4500]).graph; // 階段の無い下階
  assert.deepEqual(holesWith(() => other), [], '下階に階段が無い＝穴なし');
});

// ================================================================ 下屋

test('下屋・片流れ: footprint は region.outline の多角形。勾配は水下（軒先＝FL）から壁へ上がり、最高点＝FL + k·tMax', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500]);
  g.interior([[0, 1]]);
  g.roof([[1, 1]]); // 屋内（左）に接する片流れ。高い側＝壁の x=2000、水下＝右の x=4000
  const regions = leanToPlanRegions(g.graph);
  assert.equal(regions.length, 1, '前提: 下屋の region がある');
  const roofs = ofKind(planSolids([fakeLayer({ graph: g.graph, floorZMm: 2800, role: 'above' })]), 'roof');
  assert.equal(roofs.length, 1);
  const [roof] = roofs;
  assert.deepEqual(roof.footprint, { poly: regions[0].outline[0].points });
  assert.equal(typeof roof.zAt, 'function');
  const zs = [2000, 2500, 3000, 3500, 4000].map(x => roof.zAt(x, 2000));
  assert.deepEqual(zs, [3400, 3250, 3100, 2950, 2800], '水上（壁）x=2000 が最高点 → 水下 x=4000 の軒先＝FL へ 0.3/mm（勾配3）ずつ下がる');
  assert.equal(roof.zHi, 3400, '最高点＝FL + k·tMax（0.3×2000）');
  assert.equal(roof.zLo, 2800, '最低点＝軒先＝FL');
  assert.equal(roof.zAt(4400, 2000), 2800, '軒の出（範囲外）も軒先＝FL');
  assert.equal(roof.drawEdges, false, 'footprint は遮蔽専用（輪郭を描かない）');
  assert.equal(roof.source.id, regions[0].key);
});

test('下屋・寄棟: 軒先が FL、棟が FL + k·tMax。傾斜は短手の中央から', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500]);
  g.roof([[0, 0], [1, 0], [2, 0]]).roofSpec.setField('shape', RoofShape.HIP);
  const [roof] = ofKind(planSolids(self(g.graph)), 'roof');
  assert.ok(roof, '寄棟の下屋が立体になる');
  assert.equal(roof.zAt(3000, 750), 225, '棟（短手 1500 の中央）＝ k·tMax = 0.3×750');
  assert.equal(roof.zAt(3000, 0), 0, '軒先＝FL');
  assert.equal(roof.zAt(3000, -455), 0, '軒の出（範囲外。T=−∞）も FL（clamp。外すと −∞）');
  assert.ok(roof.zAt(3000, 400) > roof.zAt(3000, 100) && roof.zAt(3000, 400) < 225, '棟へ向かって単調に上がる');
  assert.deepEqual([roof.zLo, roof.zHi], [0, 225]);
});

test('下屋・S5: innerLines＝壁で切る前の線（外形線・棟木・隅木。roofPlanRegionFigure と同じ）、marks＝水下ごとの傾斜ラベル。どちらも part 0 の1件だけ', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500]);
  g.roof([[0, 0], [1, 0], [2, 0]]).roofSpec.setField('shape', RoofShape.HIP);
  const [region] = leanToPlanRegions(g.graph);
  const fig = roofPlanRegionFigure(region);
  const roofs = ofKind(planSolids(self(g.graph)), 'roof');
  assert.equal(roofs.length, region.outline.length);
  const [first, ...rest] = roofs;
  assert.deepEqual(first.innerLines.map(l => l.role), fig.lines.map(l => l.role));
  assert.deepEqual(first.innerLines.map(l => l.role).sort(), ['hip', 'hip', 'hip', 'hip', 'outline', 'ridge']);
  assert.equal(first.marks.length, 4, '寄棟は水下4面＝ラベル4');
  assert.deepEqual(first.marks.map(m => m.anchor), fig.labels.map(l => l.anchor));
  for (const m of first.marks) assert.deepEqual(m.prims.map(p => p.kind), ['arrow', 'text', 'text']);
  for (const r of rest) assert.ok(!r.innerLines && !r.marks, '2つ目以降の閉路には付けない');
});

test('下屋・S5: 閉じた外形線は先頭の点を末尾へ足す（解決器は閉じる辺を作らない）。開いた折れ線はそのまま', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500]);
  g.roof([[1, 1]]); // 屋内に接しない単独の下屋＝外形線は閉路
  const [region] = leanToPlanRegions(g.graph);
  assert.equal(region.exposedPaths[0].closed, true, '前提: 閉路');
  const [roof] = ofKind(planSolids(self(g.graph)), 'roof');
  const outline = roof.innerLines.find(l => l.role === 'outline').points;
  assert.equal(outline.length, region.exposedPaths[0].points.length + 2);
  assert.deepEqual(outline.slice(-2), outline.slice(0, 2), '先頭の点が末尾にある');
  const open = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500]);
  open.interior([[0, 1]]);
  open.roof([[1, 1]]);
  const [openRegion] = leanToPlanRegions(open.graph);
  assert.equal(openRegion.exposedPaths[0].closed, false, '前提: 開路');
  const [openRoof] = ofKind(planSolids(self(open.graph)), 'roof');
  assert.deepEqual(openRoof.innerLines.find(l => l.role === 'outline').points, openRegion.exposedPaths[0].points);
});

test('下屋・S5: 壁があっても innerLines は壁で切る前の線（通り芯まで。外壁面どまりは解決器が壁立体の遮蔽で導く）', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000]);
  g.interior([[0, 1]]);
  g.roof([[1, 1], [2, 1]]);
  g.graph.addWall(g.cy[1], -75, false, g.cx[0], 0, g.cx[1], 0, { wallFinish: 12.5 }); // 北の外壁。外面 y=1425
  assert.ok(g.graph.walls.length > 0, '前提: 壁がある');
  const [region] = leanToPlanRegions(g.graph);
  const [roof] = ofKind(planSolids(self(g.graph)), 'roof');
  const outline = roof.innerLines.find(l => l.role === 'outline').points;
  assert.deepEqual(outline, region.exposedPaths[0].points, '壁の有無に依らず exposedPaths のまま');
  assert.equal(outline[1], 1500, '端は通り芯 y=1500（外壁面 1425 まで戻していない）');
});

test('下屋・S5: 複数の閉路（屋内を囲む環状の下屋）は閉路ごとに1件。線とラベルは part 0 だけ（二重に描かない）', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 2000, 4000, 6000]);
  g.interior([[1, 1]]);
  g.roof([[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]]).roofSpec.setField('shape', RoofShape.HIP);
  const [region] = leanToPlanRegions(g.graph);
  assert.equal(region.outline.length, 2, '前提: 外周と穴の2閉路');
  const roofs = ofKind(planSolids(self(g.graph)), 'roof');
  assert.deepEqual(roofs.map(r => r.source.part), [0, 1]);
  assert.ok(roofs[0].innerLines.length > 0 && roofs[0].marks.length > 0);
  assert.ok(!roofs[1].innerLines && !roofs[1].marks);
  assert.ok(roofs.every(r => r.drawEdges === false));
});

test('下屋・S5: 外形線だけの region（陸屋根）は棟木・隅木・ラベルが無い（innerLines は外形線のみ・marks なし）', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500]);
  g.roof([[0, 0], [1, 0], [2, 0]]).roofSpec.setField('shape', RoofShape.FLAT);
  const [roof] = ofKind(planSolids(self(g.graph)), 'roof');
  assert.deepEqual(roof.innerLines.map(l => l.role), ['outline']);
  assert.equal(roof.marks, undefined);
});

test('下屋・失敗系: 外形線だけの region（陸屋根）は平ら（zAt なし・zLo=zHi=FL）。屋根が無い階は立体なし', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500]);
  g.roof([[0, 0], [1, 0], [2, 0]]).roofSpec.setField('shape', RoofShape.FLAT);
  assert.equal(leanToPlanRegions(g.graph)[0].outlineOnly, true, '前提: outlineOnly');
  const roofs = ofKind(planSolids([fakeLayer({ graph: g.graph, floorZMm: 100, role: 'above' })]), 'roof');
  assert.equal(roofs.length, 1);
  assert.equal(roofs[0].zAt, undefined);
  assert.deepEqual([roofs[0].zLo, roofs[0].zHi], [100, 100]);
  assert.deepEqual(ofKind(planSolids(self(makeRoomGraph(0, 0, 4000, 4000).graph)), 'roof'), []);
});

// ================================================================ 汎用立体

test('汎用立体: 検証を通ったものは kind=generic で最後に続く（矩形は正規化、style・source を保つ）', () => {
  const extras = [
    solid('generic', { rects: [rect(500, 900, 100, 100)] }, 2000, 2100, { id: 'pipe-b', style: { dash: [8, 4] } }),
    solid('generic', { poly: [0, 0, 100, 0, 100, 100] }, -50, 50, { id: 'duct-a' }),
  ];
  const { graph } = makeRoomGraph(0, 0, 4000, 4000);
  const out = planSolids(self(graph), { extraSolids: extras });
  const tail = out.slice(-2);
  assert.deepEqual(tail.map(s => s.source.id), ['duct-a', 'pipe-b'], 'id 順');
  assert.ok(tail.every(s => s.kind === 'generic'));
  assert.deepEqual(tail[1].footprint, { rects: [rect(100, 100, 500, 900)] }, '逆順の矩形は正規化');
  assert.deepEqual(tail[1].style, { dash: [8, 4] });
  assert.deepEqual([tail[1].zLo, tail[1].zHi], [2000, 2100]);
});

test('汎用立体・失敗系: 高さが逆・非有限・footprint が空/不正・generic 以外の kind・null は黙って捨てる', () => {
  const ok = solid('generic', { rects: [rect(0, 0, 10, 10)] }, 0, 10, { id: 'ok' });
  const bad = [
    solid('generic', { rects: [rect(0, 0, 10, 10)] }, 10, 0, { id: 'inverted' }),
    solid('generic', { rects: [rect(0, 0, 10, 10)] }, NaN, 10, { id: 'nan-z' }),
    solid('generic', { rects: [rect(0, 0, 10, 10)] }, 0, Infinity, { id: 'inf-z' }),
    solid('generic', { rects: [] }, 0, 10, { id: 'empty' }),
    solid('generic', { rects: [rect(0, 0, 10, 10), rect(0, 0, 0, 10)] }, 0, 10, { id: 'mixed-valid-invalid' }),
    solid('generic', { rects: [rect(0, 0, 0, 10)] }, 0, 10, { id: 'flat-rect' }),
    solid('generic', { rects: [rect(0, 0, NaN, 10)] }, 0, 10, { id: 'nan-rect' }),
    solid('generic', { poly: [0, 0, 10, 0] }, 0, 10, { id: 'short-poly' }),
    solid('generic', { poly: [0, 0, 10, 0, 10, NaN] }, 0, 10, { id: 'nan-poly' }),
    solid('generic', undefined, 0, 10, { id: 'no-footprint' }),
    solid('wall', { rects: [rect(0, 0, 10, 10)] }, 0, 10, { id: 'wrong-kind' }),
    null,
  ];
  const out = planSolids([], { extraSolids: [...bad, ok] });
  assert.deepEqual(out.map(s => s.source.id), ['ok'], '通るのは ok だけ');
});

// ================================================================ 層スタックと順序

function threeStoreyLayers() {
  const a = makeRoomGraph(0, 0, 4000, 4000, { id: 'f3', startFloor: 3 });
  addBeamH(a.graph, { axis: 2000, levelOffset: -100, role: 'floor' });
  const s = makeRoomGraph(0, 0, 4000, 4000, { id: 'f2', startFloor: 2 });
  addBeamH(s.graph, { axis: 2000, levelOffset: -100, role: 'floor' });
  addColumnAt(s.graph, 1000, 1000);
  const b = makeRoomGraph(0, 0, 4000, 4000, { id: 'f1', startFloor: 1 });
  addColumnAt(b.graph, 1000, 1000);
  return [
    fakeLayer({ graph: s.graph, floorZMm: 0, role: 'self' }),
    fakeLayer({ graph: a.graph, floorZMm: 2800, role: 'above' }),
    fakeLayer({ graph: b.graph, floorZMm: -2800, role: 'below', ceilZMm: -400 }),
  ];
}

test('層スタック3段: 各層から床・壁・柱・梁が出て、層のFLの高い順→kind表の順に並ぶ', () => {
  const layers = threeStoreyLayers();
  const out = planSolids(layers);
  assert.ok(out.length > 0);
  const zs = out.map(s => s.source.layerFloorZ);
  assert.deepEqual([...new Set(zs)], [2800, 0, -2800], '上階→自階→下階');
  assert.deepEqual(zs, [...zs].sort((p, q) => q - p), '層のFLは降順で連続');
  for (const z of [2800, 0, -2800]) {
    const mine = out.filter(s => s.source.layerFloorZ === z);
    const ranks = mine.map(s => SOLID_KIND_ORDER.indexOf(s.kind));
    assert.ok(ranks.length > 0 && ranks.every(r => r >= 0));
    assert.deepEqual(ranks, [...ranks].sort((p, q) => p - q), `FL ${z}: kind 表の順`);
  }
  const kindsAt = z => new Set(out.filter(s => s.source.layerFloorZ === z).map(s => s.kind));
  assert.deepEqual([...kindsAt(2800)].sort(), ['beam', 'floor', 'wall']);
  assert.deepEqual([...kindsAt(0)].sort(), ['beam', 'column', 'floor', 'wall']);
  assert.deepEqual([...kindsAt(-2800)].sort(), ['column', 'floor', 'wall']);
  const belowColumn = out.find(s => s.kind === 'column' && s.source.layerFloorZ === -2800);
  assert.equal(belowColumn.zHi, -400, '下階の柱の上端は層の ceilZMm');
});

test('順序は決定的: 入力の層を逆順にしても、同じ層の中の梁を逆順に足しても、出力は同一', () => {
  const layers = threeStoreyLayers();
  const forward = planSolids(layers);
  const reversed = planSolids([...layers].reverse());
  assert.ok(forward.length > 0);
  assert.deepEqual(reversed, forward);
  const g = fakeLayer().graph;
  [['b3', 3000], ['b1', 1000], ['b2', 2000]].forEach(([id, axis]) => addBeamH(g, { axis, id }));
  const ids = ofKind(planSolids(self(g)), 'beam').map(s => s.source.id);
  assert.deepEqual(ids, ['b1', 'b2', 'b3'], '同じ kind は source.id 昇順（追加順に依らない）');
});

test('失敗系: 層が無い・空配列・graph が null の層・FL が非有限の層は飛ばす（例外にしない）', () => {
  assert.deepEqual(planSolids(undefined), []);
  assert.deepEqual(planSolids(null), []);
  assert.deepEqual(planSolids([]), []);
  assert.deepEqual(planSolids([{ graph: null, floorZMm: 0, role: 'self' }, { graph: undefined, floorZMm: 0, role: 'above' }]), []);
  const { graph } = makeRoomGraph(0, 0, 4000, 4000);
  assert.deepEqual(planSolids([{ graph, floorZMm: NaN, role: 'self' }]), []);
  const out = planSolids([{ graph: null, floorZMm: 2800, role: 'above' }, fakeLayer({ graph })]);
  assert.ok(out.length > 0, 'graph が null の層だけ飛ばし、他の層は出る');
  assert.ok(out.every(s => s.source.layerFloorZ === 0));
});

test('layerCeilZ: 層の ceilZMm → graph.defaultCeilingHeight → 既定2400 の順', () => {
  const graph = fakeLayer().graph;
  assert.equal(layerCeilZ({ graph, floorZMm: 100 }), 2500);
  graph.setDefaultCeilingHeight(2700);
  assert.equal(layerCeilZ({ graph, floorZMm: 100 }), 2800);
  assert.equal(layerCeilZ({ graph, floorZMm: 100, ceilZMm: 900 }), 900);
  assert.equal(layerCeilZ({ graph: null, floorZMm: 100 }), 2500, 'graph が無ければ既定');
});

// ================================================================ 階段の段（S7b）

test('階段の段: マスごとに1件の立体（kind stairTread・遮蔽専用 drawEdges:false）。天端 = FL + 番号 × 蹴上、厚み 0。source は階段 id・part＝番号', () => {
  const graph = switchbackGraph();
  const stair = graph.stairs[0];
  const treads = ofKind(planSolids(self(graph), { riserOf: () => 200 }), 'stairTread');
  assert.equal(treads.length, stair.totalSteps - 1, '到達番号（上階の床）は段にしない');
  treads.forEach((t, i) => {
    assert.equal(t.zLo, t.zHi, '厚み 0');
    assert.equal(t.zHi, (i + 1) * 200, `段 ${i + 1} の天端`);
    assert.equal(t.drawEdges, false);
    assert.deepEqual(t.source, { kind: 'stairTread', id: String(stair.id), layerFloorZ: 0, part: i + 1 });
    assert.ok(t.footprint.poly.length >= 6 && t.footprint.poly.every(Number.isFinite));
  });
  const all = planSolids(self(graph), { riserOf: () => 200 });
  const rank = k => SOLID_KIND_ORDER.indexOf(k);
  assert.deepEqual(all.map(s => rank(s.kind)), [...all.map(s => rank(s.kind))].sort((a, b) => a - b), '出力は kind 表の順（stairTread は roof の後）');
});

test('階段の段: 蹴上は層ごとに1本——直上の層があればその階高から（下階）、最上の層は opts.riserOf。明示の stair.riser が優先', () => {
  const upper = switchbackGraph(), lower = switchbackGraph();
  const layers = [fakeLayer({ graph: upper }), fakeLayer({ graph: lower, floorZMm: -2800, role: 'below' })];
  const run = (opts) => planSolids(layers, opts).filter(s => s.kind === 'stairTread');
  const tops = (solids, floorZ) => solids.filter(s => s.source.layerFloorZ === floorZ).map(s => s.zHi);
  const solids = run({ riserOf: () => 150 });
  assert.deepEqual(tops(solids, 0), Array.from({ length: 11 }, (_, i) => (i + 1) * 150), '自階は opts.riserOf');
  const H = 2800 / 12; // 12 蹴上
  assert.deepEqual(tops(solids, -2800).map(z => Math.round(z * 1e6) / 1e6), Array.from({ length: 11 }, (_, i) => Math.round((-2800 + (i + 1) * H) * 1e6) / 1e6),
    '下階は階高 2800 / 総蹴上 12（opts.riserOf を使わない）');
  lower.stairs[0].setField('riser', 100);
  assert.deepEqual(tops(run({ riserOf: () => 150 }), -2800), Array.from({ length: 11 }, (_, i) => -2800 + (i + 1) * 100), '明示 riser が階高由来より優先');
  // 3 層: 中間の層の蹴上はその直上の層との階高から
  const mid = switchbackGraph();
  const three = [fakeLayer({ graph: upper }), fakeLayer({ graph: mid, floorZMm: -2400, role: 'below' }), fakeLayer({ graph: switchbackGraph(), floorZMm: -4800, role: 'below' })];
  const t3 = planSolids(three, { riserOf: () => 150 }).filter(s => s.kind === 'stairTread');
  assert.ok(Math.abs(tops(t3, -2400)[10] - (-2400 + 11 * (2400 / 12))) < 1e-6, '中間の層: 階高 2400');
  assert.ok(Math.abs(tops(t3, -4800)[10] - (-4800 + 11 * (2400 / 12))) < 1e-6, '最下の層: 階高 2400（直上の中間の層との差）');
});

test('階段の段: 設置枠の逃がし（insetView）は自階の層が install・下階の層が upper（入れ替えると多角形が変わる）', () => {
  const upper = switchbackGraph(), lower = switchbackGraph();
  const layers = [fakeLayer({ graph: upper }), fakeLayer({ graph: lower, floorZMm: -2800, role: 'below' })];
  const treads = planSolids(layers, { riserOf: () => 200 }).filter(s => s.kind === 'stairTread');
  const polys = z => treads.filter(s => s.source.layerFloorZ === z).map(s => s.footprint.poly);
  const expect = (graph, riser, insetView) => stairTreadFootprints(graph.stairs[0], graph, { riser, insetView }).map(t => t.poly);
  const selfInstall = expect(upper, 200, 'install'), selfUpper = expect(upper, 200, 'upper');
  assert.notDeepEqual(selfInstall, selfUpper, '前提: このフィクスチャは install と upper で多角形が違う');
  assert.deepEqual(polys(0), selfInstall, '自階は install');
  assert.deepEqual(polys(-2800), expect(lower, 2800 / 12, 'upper'), '下階は upper');
});

test('階段の段: 蹴上が求まらない（riserOf が無い・null を返す）なら立体にしない。階段が無い階も 0 件。順序は層・配列の入力順に依らない', () => {
  const graph = switchbackGraph();
  assert.equal(ofKind(planSolids(self(graph)), 'stairTread').length, 0, 'riserOf なし');
  assert.equal(ofKind(planSolids(self(graph), { riserOf: () => null }), 'stairTread').length, 0, 'riserOf が null');
  assert.equal(ofKind(planSolids(self(makeRoomGraph(0, 0, 4000, 4000).graph), { riserOf: () => 200 }), 'stairTread').length, 0, '階段なし');
  const layers = [fakeLayer({ graph }), fakeLayer({ graph: switchbackGraph(), floorZMm: -2800, role: 'below' })];
  const a = planSolids(layers, { riserOf: () => 200 });
  const b = planSolids([...layers].reverse(), { riserOf: () => 200 });
  assert.ok(a.some(s => s.kind === 'stairTread'));
  assert.deepEqual(b.map(s => [s.kind, s.source.layerFloorZ, s.source.id, s.source.part]), a.map(s => [s.kind, s.source.layerFloorZ, s.source.id, s.source.part]));
});

// ================================================================ 天井（見上げ。opts.ceilings）

test('天井: opts.ceilings を省略（または true 以外）なら ceiling は 0 件で、出力は ceilings:true の出力から天井を除いたものと deepEqual（見下げは不変）', () => {
  const { graph } = makeRoomGraph(0, 0, 4000, 4000);
  const base = planSolids(self(graph));
  assert.equal(ofKind(base, 'ceiling').length, 0);
  for (const ceilings of [false, undefined, 1, 'true']) assert.deepEqual(planSolids(self(graph), { ceilings }), base, String(ceilings));
  const withCeilings = planSolids(self(graph), { ceilings: true });
  assert.equal(ofKind(withCeilings, 'ceiling').length, 1);
  assert.deepEqual(withCeilings.filter(s => s.kind !== 'ceiling'), base);
});

test('天井: 高さ＝層のFL＋部屋の天井高（厚み0）。矩形はセルの和、source は部屋 id・層のFL。自階の層にだけ付き、上階・下階の層には付かない', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const a = g.interior([[0, 0]]);
  const b = g.interior([[1, 0]]);
  b.setOverride('ceilingHeight', '2200');
  const out = planSolids([fakeLayer({ graph: g.graph, floorZMm: 100 })], { ceilings: true });
  const ceilings = ofKind(out, 'ceiling'); // 出力順は source.id（部屋 id）順なので id で引く
  assert.equal(ceilings.length, 2);
  const ofRoom = room => ceilings.find(s => s.source.id === room.id);
  assert.deepEqual(ofRoom(a).footprint, { rects: [rect(0, 0, 2000, 3000)] });
  assert.equal(ofRoom(a).zLo, 100 + 2400, '既定の天井高 2400');
  assert.equal(ofRoom(a).zHi, 100 + 2400);
  assert.deepEqual(ofRoom(a).source, { kind: 'ceiling', id: a.id, layerFloorZ: 100 });
  assert.equal(ofRoom(b).zHi, 100 + 2200, '部屋の天井高 2200 は FL＋2200');
  assert.ok(ceilings.every(s => s.drawEdges === undefined), '輪郭は既定どおり描く');
  const layers = [fakeLayer({ graph: g.graph, floorZMm: 2800, role: 'above' }), fakeLayer({ graph: g.graph }), fakeLayer({ graph: g.graph, floorZMm: -2800, role: 'below' })];
  assert.deepEqual(ofKind(planSolids(layers, { ceilings: true }), 'ceiling').map(s => s.source.layerFloorZ), [0, 0]);
});

test('天井の床段差: 部分指定の子（床段差 400・自分の CH 欄なし）の天井の zHi は親と同じ FL+2400。FL−150・CH 2400 の部屋は FL+2250', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const parent = g.interior([[0, 0], [1, 0]]);
  parent.setOverride('ceilingHeight', '2400');
  const child = g.graph.addRoom(new Set([g.cell(1, 0)]), '小上がり', undefined, new Set([parent.id]));
  child.setFloorLevel(400);
  const low = g.interior([[2, 0]]);
  low.setFloorLevel(-150);
  low.setOverride('ceilingHeight', '2400');
  const ceilings = ofKind(planSolids([fakeLayer({ graph: g.graph, floorZMm: 100 })], { ceilings: true }), 'ceiling');
  const zHi = room => ceilings.find(s => s.source.id === room.id).zHi;
  assert.equal(zHi(parent), 100 + 2400);
  assert.equal(zHi(child), 100 + 2400);
  assert.equal(zHi(low), 100 + 2250);
});

test('天井: 屋外・吹抜け・階段・階段吹抜け・未定義・屋根の部屋には作らない', () => {
  const g = makeGrid([0, 1000, 2000, 3000, 4000, 5000, 6000], [0, 1000]);
  const keep = g.interior([[0, 0]]);
  g.feature([[1, 0]], RoomFeature.VOID);
  g.feature([[2, 0]], RoomFeature.STAIR);
  g.feature([[3, 0]], RoomFeature.STAIR_VOID);
  g.feature([[4, 0]], RoomFeature.UNDEFINED);
  g.roof([[5, 0]]);
  assert.deepEqual(ofKind(planSolids(self(g.graph), { ceilings: true }), 'ceiling').map(s => s.source.id), [keep.id]);
});

test('SOLID_KIND_ORDER: ceiling は stairTread と generic の間。既存種別の相対順は不変', () => {
  assert.deepEqual([...SOLID_KIND_ORDER], ['floor', 'wall', 'column', 'beam', 'roof', 'stairTread', 'ceiling', 'generic']);
  const out = planSolids(self(makeRoomGraph(0, 0, 4000, 4000).graph), { ceilings: true });
  const rank = k => SOLID_KIND_ORDER.indexOf(k);
  assert.deepEqual(out.map(s => rank(s.kind)), [...out.map(s => rank(s.kind))].sort((p, q) => p - q), '出力は kind 表の順');
});
