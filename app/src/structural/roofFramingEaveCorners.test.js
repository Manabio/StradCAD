// roofFramingGeometry.js eaveBeamCorners と roofFramingRegions.js roofFramingEaveCorners のテスト
// （下屋・主屋根（屋根専用平面の軒桁）の軒の側の梁が出隅で勝ち、けらばの出幅ぶん延びる角。伏図の描画だけ）。期待値は手計算（y は下向き正）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, RoomKind, RoomFeature, RoofShape } from '@core';
import { eaveBeamCorners } from './roofFramingGeometry.js';
import { resolveBeamJunctionSpans } from './beamJunction.js';
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
const THROUGH = Object.freeze({ beamJunction: 'throughWins' });
/** resolveBeamJunctionSpans に渡す梁（屋根専用平面の梁は role primary）。半幅 60・同一断面。 */
const beam = (id, isVertical, axisValue, end1, end2) => ({ id, role: 'primary', isVertical, axisValue, end1, end2, base1: end1, base2: end2, halfWidth: 60, sectionKey: 'S' });
const entries = map => JSON.stringify([...map]);

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
  // 2026-10-05: 水下は壁（屋内に接する2辺）を除く下辺・右辺の2つ（旧: 壁の辺も軒＝4つ）。角の結果は変わらない（壁は出幅 0 で対象外だった）
  assert.ok(Array.isArray(region.leanToDrains) && region.leanToDrains.length === 2, '前提: 水下（壁を除く軒の辺）2つを持つ L字の region');
  assert.deepEqual(corners(region), [C(3640, 0, false), C(9100, -9884, true)], '下辺の梁は左端 (3640,0)・右辺の梁は上端 (9100,-9884) でけらばの出幅ぶん勝つ');
});

test('対角だけで接するセルの下屋（切妻）: 対角の接点 (3640,7280) には角を出さない（凸の角だけの判定を守る）', () => {
  // 屋根: 上段 (0,0)(1,0)・右 (1,1)・左下 (0,2)。屋内 (0,1)。(1,1) と (0,2) は点 (3640,7280) でだけ接する
  // 判定（outward の2条件）を両方外すと結果が変わるのは、3×3 格子の 4032 形のうち対角だけで接する型の 37 形だけ（2026-10-05 QA の掃引）。
  // 2条件の片方だけを外しても、この格子の形では結果が変わらない（片方が残れば弾かれる。区別できる形は見つかっていない）
  const { graph, interior, roof } = makeGrid([0, 3640, 7280, 10920], [0, 3640, 7280, 10920]);
  interior([[0, 1]]);
  roof([[0, 0], [1, 0], [0, 2], [1, 1]], RoofShape.GABLE);
  const region = regionOf(graph);
  assert.equal(region.rect, null, '前提: 矩形でない L/S 字の region');
  assert.ok(Array.isArray(region.leanToDrains) && region.leanToDrains.length > 0, '前提: 水下を持つ（角の計算に届く）');
  const all = corners(region);
  assert.deepEqual(all, [C(0, 0, false), C(7280, 7280, true)]);
  assert.ok(!all.some(c => c.x === 3640 && c.y === 7280), '対角の接点（別々のセルの軒の辺とけらばの辺が出会うが、出隅ではない）には角を出さない');
});

// ---- 主屋根（屋根専用平面の軒桁。2026-10-05 ユーザー裁定で下屋から拡大） ----

/** 9000×6000 の建物を最上階に持つ主屋根。subject は屋根専用平面の graph の代役（graph があればよい。region は topGraph から導く）。 */
function mainRoofFixture() {
  const top = makeGrid([0, 9000], [0, 6000]);
  top.interior([[0, 0]]); // 自動の切妻（短手 6000 > 3640）・棟は長手（x 方向）
  const subject = makeGrid([0, 9000], [0, 6000]).graph;
  const project = woodProject();
  const roofArgs = { rules: WOOD, lod: LodLevel.STANDARD, isRoofPlane: true, subjectGraph: subject, topGraph: top.graph, project };
  return { top, subject, project, roofArgs };
}
const sortedMain = args => roofFramingEaveCorners(args).sort(byPos);

test('主屋根（屋根専用平面）の切妻: 4 隅すべてに角。extendMm＝けらばの出幅・棟が横なら軒の辺は横、縦なら縦。region は最上階 graph から（memo キー roofFramingMainRegions）', () => {
  const { top, roofArgs } = mainRoofFixture();
  top.graph.mainRoofSpec.setField('eaveOverhangMm', 600);
  top.graph.mainRoofSpec.setField('gableOverhangMm', 300);
  assert.equal(mainRoofFramingRegion(top.graph, roofArgs.project).shape, 'gable', '前提: 主屋根は切妻');
  assert.deepEqual(sortedMain(roofArgs),
    [C(0, 0, false, 300), C(0, 6000, false, 300), C(9000, 0, false, 300), C(9000, 6000, false, 300)], '棟が横（自動＝長手）: 横の辺が軒');
  top.graph.mainRoofSpec.setField('ridgeDirection', 'vertical');
  assert.deepEqual(sortedMain(roofArgs),
    [C(0, 0, true, 300), C(0, 6000, true, 300), C(9000, 0, true, 300), C(9000, 6000, true, 300)], '棟が縦: 縦の辺が軒');
  const calls = [];
  const memo = (g, key, compute) => { calls.push([g === top.graph, key]); return compute(); };
  roofFramingEaveCorners({ ...roofArgs, memo });
  assert.deepEqual(calls, [[true, 'roofFramingMainRegions']], '小屋組の描画と同じ memo・キー・最上階の graph');
});

test('主屋根の片流れ: 軒の辺（高低の縦の辺）とけらば（横の辺）の4隅。出幅 0 のけらばは対象外', () => {
  const { top, roofArgs } = mainRoofFixture();
  top.graph.mainRoofSpec.setField('shape', RoofShape.MONO);
  top.graph.mainRoofSpec.setField('highSide', 'right');
  top.graph.mainRoofSpec.setField('gableOverhangMm', 300);
  assert.deepEqual(sortedMain(roofArgs),
    [C(0, 0, true, 300), C(0, 6000, true, 300), C(9000, 0, true, 300), C(9000, 6000, true, 300)]);
  top.graph.mainRoofSpec.setField('gableOverhangMm', 0);
  assert.deepEqual(roofFramingEaveCorners(roofArgs), []);
});

test('【失敗系】主屋根の寄棟（全辺が軒）・矩形でない寄棟・陸屋根・主屋根の無い階・topGraph/subjectGraph 無しは [] で例外を投げない', () => {
  const { top, roofArgs } = mainRoofFixture();
  assert.equal(roofFramingEaveCorners(roofArgs).length, 4, '前提: 切妻なら角がある');
  top.graph.mainRoofSpec.setField('shape', RoofShape.HIP);
  assert.deepEqual(roofFramingEaveCorners(roofArgs), [], '矩形の寄棟');
  top.graph.mainRoofSpec.setField('shape', RoofShape.FLAT);
  assert.deepEqual(roofFramingEaveCorners(roofArgs), [], '陸屋根（region なし）');
  top.graph.mainRoofSpec.setField('shape', null);
  assert.equal(roofFramingEaveCorners(roofArgs).length, 4, '前提: 自動に戻せば角が戻る');
  const l = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  l.interior([[0, 0], [1, 0], [0, 1]]); // L字の建物＝矩形でない主屋根（自動は寄棟）
  assert.deepEqual(roofFramingEaveCorners({ ...roofArgs, topGraph: l.graph }), [], '矩形でない寄棟');
  assert.deepEqual(roofFramingEaveCorners({ ...roofArgs, topGraph: makeGrid([0, 4000], [0, 4000]).graph }), [], '建物の無い最上階（region なし）');
  assert.deepEqual(roofFramingEaveCorners({ ...roofArgs, topGraph: null }), [], 'topGraph 無し');
  assert.deepEqual(roofFramingEaveCorners({ ...roofArgs, subjectGraph: null }), [], 'subjectGraph 無し');
  assert.deepEqual(roofFramingEaveCorners({ ...roofArgs, lod: LodLevel.SCHEMATIC }), [], '略図');
  assert.deepEqual(roofFramingEaveCorners({ ...roofArgs, rules: rulesFor('S造') }), [], '非在来');
});

test('実体階の伏図（isRoofPlane:false）は主屋根の角を混ぜない: topGraph を渡しても下屋の角だけ', () => {
  const { top, roofArgs } = mainRoofFixture();
  const lean = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  lean.roof([[0, 0], [1, 0], [0, 1], [1, 1]]);
  const out = roofFramingEaveCorners({ ...roofArgs, isRoofPlane: false, subjectGraph: lean.graph, topGraph: top.graph });
  assert.equal(out.length, 4);
  assert.ok(out.every(c => c.x <= 8000 && c.y <= 8000), '下屋（8000×8000）の角だけで、主屋根（9000×6000）の角 (9000,*) は無い');
  const none = roofFramingEaveCorners({ ...roofArgs, isRoofPlane: false, subjectGraph: makeGrid([0, 4000], [0, 4000]).graph });
  assert.deepEqual(none, [], '屋根の無い階は主屋根があっても []');
});

test('結合: 主屋根の角 → resolveBeamJunctionSpans。屋根専用平面の梁の並び（軒桁・けらば側の梁。ともに role primary）で、軒桁が妻側へけらばの出幅 300 ぶん延び、けらば側の梁は軒桁の面で止まる', () => {
  const { top, roofArgs } = mainRoofFixture();
  top.graph.mainRoofSpec.setField('gableOverhangMm', 300);
  top.graph.mainRoofSpec.setField('ridgeDirection', 'vertical'); // 軒＝縦の辺（x=0・x=9000。長さ 6000）・けらば＝横の辺（y=0・y=6000。長さ 9000）
  const beams = [
    beam('E0', true, 0, 0, 6000), beam('E9', true, 9000, 0, 6000), // 軒桁（縦）
    beam('G0', false, 0, 0, 9000), beam('G6', false, 6000, 0, 9000), // けらば側（横）
  ];
  const before = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(before.get('G0').ends[0].kind, 'cornerClose', '前提: 角を渡さないと長い方（けらば側）が勝つ');
  const j = resolveBeamJunctionSpans(THROUGH, beams, { eaveCorners: roofFramingEaveCorners(roofArgs) });
  assert.equal(j.get('E0').coord1, -300, '軒桁 x=0 の上端（y=0 の角）はけらばの出幅ぶん外へ');
  assert.equal(j.get('E0').coord2, 6300, '軒桁 x=0 の下端（y=6000 の角）');
  assert.equal(j.get('E9').coord1, -300);
  assert.equal(j.get('E9').coord2, 6300);
  assert.deepEqual(j.get('E0').ends, [{ kind: 'eaveExtend', capped: true }, { kind: 'eaveExtend', capped: true }]);
  assert.equal(j.get('G0').coord1, 60, 'けらば側の梁は軒桁の面（半幅 60）で止まる');
  assert.equal(j.get('G0').coord2, 8940);
  assert.equal(j.get('G6').coord1, 60);
});

test('【失敗系】結合: 出幅 0 のけらば・寄棟の主屋根は角が無く、梁の端は今までどおり（長い方が勝つ）', () => {
  const { top, roofArgs } = mainRoofFixture();
  top.graph.mainRoofSpec.setField('ridgeDirection', 'vertical');
  const beams = [beam('E0', true, 0, 0, 6000), beam('G0', false, 0, 0, 9000)];
  const plain = entries(resolveBeamJunctionSpans(THROUGH, beams));
  top.graph.mainRoofSpec.setField('gableOverhangMm', 0);
  assert.equal(entries(resolveBeamJunctionSpans(THROUGH, beams, { eaveCorners: roofFramingEaveCorners(roofArgs) })), plain, '出幅 0');
  top.graph.mainRoofSpec.setField('gableOverhangMm', 300);
  top.graph.mainRoofSpec.setField('shape', RoofShape.HIP);
  assert.equal(entries(resolveBeamJunctionSpans(THROUGH, beams, { eaveCorners: roofFramingEaveCorners(roofArgs) })), plain, '寄棟');
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
