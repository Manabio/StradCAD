// roofFramingGeometry.js eaveBeamCorners と roofFramingRegions.js roofFramingEaveCorners のテスト
// （下屋の軒の側の梁が出隅で勝ち、けらばの出幅ぶん延びる角。伏図の描画だけ）。期待値は手計算（y は下向き正）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, RoomKind, RoomFeature, RoofShape } from '@core';
import { eaveBeamCorners } from './roofFramingGeometry.js';
import { leanToFramingRegions, mainRoofFramingRegion, roofFramingEaveCorners } from './roofFramingRegions.js';
import { rulesFor, TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { createLeanToRoofSpec } from '../finish/roof/roofDefaults.js';
import { LodLevel } from '../viewport.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const TOL = 0.5;
const WOOD = rulesFor(TRADITIONAL_WOOD_STRUCTURE);

function woodProject(structure = TRADITIONAL_WOOD_STRUCTURE) {
  const project = new Project('p', 'test');
  project.structuralInfo.mainStructure = structure;
  return project;
}

/** 格子 xs × ys の階。interior・roof は [i, j] セルの配列から部屋を作る。 */
function makeGrid(xs, ys) {
  const graph = new PlanGraph(new Plane('p2', 0, '2階', 2, 1));
  const cx = xs.map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH, `x${i}`));
  const cy = ys.map((v, j) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH, `y${j}`));
  const cell = (i, j) => `${cx[i].id}:${cy[j].id}:${cx[i + 1].id}:${cy[j + 1].id}`;
  const interior = cells => graph.addRoom(new Set(cells.map(([i, j]) => cell(i, j))), '居間');
  const roof = (cells, shape = null) => {
    const room = graph.addRoom(new Set(cells.map(([i, j]) => cell(i, j))), '屋根');
    room.setKind(RoomKind.EXTERIOR);
    room.setFeature(RoomFeature.ROOF);
    room.setRoofSpec(createLeanToRoofSpec());
    if (shape) room.roofSpec.setField('shape', shape);
    return room;
  };
  return { graph, interior, roof };
}

/** 屋根 1 つの graph から伏図用 region（木造）を取り出す。 */
const regionOf = graph => {
  const regions = leanToFramingRegions(graph, woodProject());
  assert.equal(regions.length, 1, '前提: region が1つ');
  return regions[0];
};
const byPos = (a, b) => a.x - b.x || a.y - b.y;
const corners = region => eaveBeamCorners(region, TOL).sort(byPos);
const C = (x, y, eaveIsVertical, extendMm = 455) => ({ x, y, eaveIsVertical, extendMm });

test('片流れ（上が高い側・壁）: 下の軒の辺とけらばの辺の出隅の2角。上の2角は壁（出幅 0）なので対象外', () => {
  const { graph, interior, roof } = makeGrid([0, 4000, 8000], [0, 1500, 3000]);
  interior([[0, 0], [1, 0]]);
  roof([[0, 1], [1, 1]]);
  const region = regionOf(graph);
  assert.equal(region.highSide, 'top', '前提: 壁（屋内）に接する上が高い側');
  assert.ok(region.edges.some(e => e.overhangMm === 0), '前提: 壁の部分は出幅 0');
  assert.deepEqual(corners(region), [C(0, 3000, false), C(8000, 3000, false)]);
});

test('切妻: 棟が横なら軒の辺は横（上下）・縦なら縦（左右）。けらばの出幅が extendMm（軒と違うとき確かめる）', () => {
  const { graph, roof } = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  const room = roof([[0, 0], [1, 0], [0, 1], [1, 1]]); // 8000×8000・自動の切妻は棟が x 方向
  room.roofSpec.setField('eaveOverhangMm', 600);
  room.roofSpec.setField('gableOverhangMm', 300);
  const h = regionOf(graph);
  assert.equal(h.shape, 'gable');
  assert.deepEqual(corners(h), [C(0, 0, false, 300), C(0, 8000, false, 300), C(8000, 0, false, 300), C(8000, 8000, false, 300)]);
  room.roofSpec.setField('ridgeDirection', 'vertical');
  const v = regionOf(graph);
  assert.deepEqual(corners(v), [C(0, 0, true, 300), C(0, 8000, true, 300), C(8000, 0, true, 300), C(8000, 8000, true, 300)],
    '棟が縦: 縦の辺が軒（出幅 600）・横の辺がけらば（出幅 300）。extendMm は常にけらばの出幅');
});

test('寄棟（全辺が軒）・矩形でない寄棟は対象外（空）', () => {
  const rect = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  rect.roof([[0, 0], [1, 0], [0, 1], [1, 1]], RoofShape.HIP);
  assert.deepEqual(corners(regionOf(rect.graph)), []);
  const l = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  l.interior([[0, 0], [1, 0], [0, 1]]); // L字の建物＝矩形でない主屋根（自動は寄棟。rect:null・rects の region）
  const main = mainRoofFramingRegion(l.graph, woodProject());
  assert.equal(main.shape, 'hip');
  assert.equal(main.rect, null, '前提: 矩形でない寄棟');
  assert.ok(main.edges.some(e => e.overhangMm > 0), '前提: 出幅はある');
  assert.deepEqual(corners(main), []);
});

test('roof-test1 型の L字の片流れ（2つの水下）: 軒の辺（水下）とけらばの出隅 (9100,-9884)・(3640,0) だけ。軒と軒の角・壁との角は対象外', () => {
  const { graph, interior, roof } = makeGrid([3640, 7280, 9100], [-9884, -3640, 0]);
  interior([[0, 0]]); // 壁: x=7280（右翼の左）・y=-3640（下翼の上）
  roof([[1, 0], [1, 1], [0, 1]]);
  const region = regionOf(graph);
  assert.equal(region.rect, null);
  assert.equal(region.leanToDrains.length, 2, '前提: 水下が2つ（右・下）');
  // 右へ流れる面の水下 x=9100 の梁の上端と、下へ流れる面の水下 y=0 の梁の左端
  assert.deepEqual(corners(region), [C(3640, 0, false), C(9100, -9884, true)]);
  const all = corners(region);
  assert.ok(!all.some(c => c.x === 9100 && c.y === 0), '軒と軒の角（長手勝ちのまま）は対象外');
  assert.ok(!all.some(c => (c.x === 7280 && c.y === -9884) || (c.x === 3640 && c.y === -3640)), '壁との角は対象外');
});

test('出幅 0 のけらばは対象外（壁と区別できない。長手勝ちのまま）。軒の出幅 0 も対象外', () => {
  const g = makeGrid([0, 4000, 8000], [0, 1500, 3000]);
  const room = g.roof([[0, 0], [1, 0], [0, 1], [1, 1]]);
  assert.ok(corners(regionOf(g.graph)).length > 0, '前提: 既定の出幅なら角がある');
  room.roofSpec.setField('gableOverhangMm', 0);
  assert.deepEqual(corners(regionOf(g.graph)), [], 'けらば 0');
  room.roofSpec.setField('gableOverhangMm', 455);
  room.roofSpec.setField('eaveOverhangMm', 0);
  assert.deepEqual(corners(regionOf(g.graph)), [], '軒 0');
});

test('【失敗系】eaveBeamCorners: edges が無い・空は空配列。tolMm が負・edges の値が不正・陸屋根の矩形は RangeError', () => {
  assert.deepEqual(eaveBeamCorners({ edges: null }, TOL), []);
  assert.deepEqual(eaveBeamCorners({ edges: [] }, TOL), []);
  assert.deepEqual(eaveBeamCorners(null, TOL), []);
  const e = { isVertical: true, coord: 0, lo: 0, hi: 10, outward: 1, overhangMm: 455 };
  assert.throws(() => eaveBeamCorners({ edges: [e] }, -1), RangeError);
  assert.throws(() => eaveBeamCorners({ edges: [{ ...e, outward: 0 }] }, TOL), RangeError);
  assert.throws(() => eaveBeamCorners({ edges: [{ ...e, overhangMm: -1 }] }, TOL), RangeError);
  assert.throws(() => eaveBeamCorners({ edges: [e], rect: { x1: 0, y1: 0, x2: 1, y2: 1 }, shape: RoofShape.FLAT }, TOL), RangeError);
});

// ---- roofFramingEaveCorners（どの伏図で出すか） ----

test('roofFramingEaveCorners: 実体階の伏図（下屋）は region の角を返す。region は主題階 graph から（memo を通す）', () => {
  const { graph, roof } = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  roof([[0, 0], [1, 0], [0, 1], [1, 1]]);
  const calls = [];
  const memo = (g, key, compute) => { calls.push(key); return compute(); };
  const out = roofFramingEaveCorners({ rules: WOOD, lod: LodLevel.STANDARD, isRoofPlane: false, subjectGraph: graph, topGraph: null, project: woodProject(), memo });
  assert.equal(out.length, 4);
  assert.deepEqual(calls, ['roofFramingLeanRegions'], '小屋組の描画と同じ memo の region');
});

test('切妻の L字（roof-test8 型）: 軒の辺（下辺・右辺）とけらばの辺（左辺・上辺）の出隅の2角。軒と軒の角 (9100,0)・壁（出幅 0）との角は対象外', () => {
  const { graph, interior, roof } = makeGrid([3640, 7280, 9100], [-9884, -3640, 0]);
  interior([[0, 0]]);
  roof([[0, 1], [1, 1], [1, 0]], RoofShape.GABLE);
  const region = regionOf(graph);
  assert.equal(region.shape, 'gable');
  assert.ok(Array.isArray(region.leanToDrains) && region.leanToDrains.length === 4, '前提: 水下（軒の辺）4つを持つ L字の region');
  assert.deepEqual(corners(region), [C(3640, 0, false), C(9100, -9884, true)], '下辺の梁は左端 (3640,0)・右辺の梁は上端 (9100,-9884) でけらばの出幅ぶん勝つ');
});

test('主屋根（屋根専用平面）は []: 切妻の主屋根（けらばに出幅がある）でも軒桁は対象外', () => {
  const top = makeGrid([0, 9000], [0, 6000]);
  top.interior([[0, 0]]); // 9000×6000 の建物・自動の切妻（短手 6000 > 3640）
  const project = woodProject();
  const lean = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  lean.roof([[0, 0], [1, 0], [0, 1], [1, 1]]);
  const mainRegion = mainRoofFramingRegion(top.graph, project);
  assert.equal(mainRegion.shape, 'gable', '前提: 主屋根は切妻');
  assert.ok(eaveBeamCorners(mainRegion, TOL).length > 0, '前提: 主屋根の region をそのまま渡せば角が出る（[] にしているのは roofFramingEaveCorners の条件）');
  const args = { rules: WOOD, lod: LodLevel.STANDARD, subjectGraph: lean.graph, topGraph: top.graph, project };
  assert.equal(roofFramingEaveCorners({ ...args, isRoofPlane: false }).length, 4, '前提: 実体階では下屋の角が出る');
  assert.deepEqual(roofFramingEaveCorners({ ...args, isRoofPlane: true }), []);
});

test('【失敗系】roofFramingEaveCorners: 略図（小屋組を描かない）・非在来・主題階の graph 無し・屋根の無い階は []', () => {
  const { graph, roof } = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  roof([[0, 0], [1, 0], [0, 1], [1, 1]]);
  const base = { rules: WOOD, lod: LodLevel.STANDARD, isRoofPlane: false, subjectGraph: graph, topGraph: null, project: woodProject() };
  assert.equal(roofFramingEaveCorners(base).length, 4, '前提');
  assert.deepEqual(roofFramingEaveCorners({ ...base, lod: LodLevel.SCHEMATIC }), []);
  assert.deepEqual(roofFramingEaveCorners({ ...base, rules: rulesFor('S造') }), []);
  assert.deepEqual(roofFramingEaveCorners({ ...base, subjectGraph: null }), []);
  assert.deepEqual(roofFramingEaveCorners({ ...base, subjectGraph: makeGrid([0, 4000], [0, 4000]).graph }), []);
});
