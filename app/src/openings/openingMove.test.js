// openingMove.js（建具の壁長さ方向移動: 可動範囲・スナップ候補・確定値）の単体テスト。
// 壁は openingGeometry.test.js と同じ「x=0..3000 の水平壁（axisCL=y0）」を基本にする。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '../core.js';
import {
  openingMoveRange, openingRefOffsetRange, refOffsetRangeOf, clampRefOffset, openingSnapCandidates,
  resolveOpeningRefOffset, snapIndicatorAlong, clCrossesWall, perpendicularWallMaterial,
  elevationDragAlong, previewDxLocalMm,
} from './openingMove.js';

function makeGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

// 水平壁 x=startX..3000（axisCL: y=0）。startX を変えると refCL(clStart) の値が動く。
function makeHorizontalWall(graph, { startX = 0 } = {}) {
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,      { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   startX, { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000,   { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: false });
  return { wall, axisCL, clStart, clEnd };
}

// 垂直壁 y=0..3000（axisCL: x=0）
function makeVerticalWall(graph) {
  const axisCL  = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, 75, true, clStart, 0, clEnd, 0, { isExteriorWall: false });
  return { wall, axisCL, clStart, clEnd };
}

function addOpening(graph, wall, refOffset, width) {
  return graph.addOpening(wall.axisCL, 1, wall.isVertical, wall.clStart, refOffset, width, OpeningCategory.FITTING, 'singleSwing', {});
}

// ================================================================
// openingMoveRange
// ================================================================
test('openingMoveRange: 単独の開口は壁両端から幅の半分だけ内側が可動範囲', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  const o = addOpening(graph, wall, 1500, 800);
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 400, max: 2600 });
});

test('openingMoveRange: 隣接開口の端で範囲が狭まる（lo側は coord2、hi側は coord1）', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  addOpening(graph, wall, 300,  400); // coord 100..500
  addOpening(graph, wall, 2700, 400); // coord 2500..2900
  const o = addOpening(graph, wall, 1500, 800);
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 900, max: 2100 });
});

// ---- 壁を横切る通り芯・中心線はまたげない（ユーザー裁定 2026-09-14） ----
test('openingMoveRange: 壁を横切る中心線（延長範囲なし）は可動範囲の境界になる', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL, 300,  { labeled: false, discipline: Discipline.ARCH });
  const o = addOpening(graph, wall, 1000, 800); // 600..1400
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 700, max: 1600 });
});

test('openingMoveRange: 通り芯（labeled/STRUCT）も同様に境界になる', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const o = addOpening(graph, wall, 1000, 800);
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 400, max: 1600 });
});

test('openingMoveRange: 壁に届かない中心線は境界にしない・壁面で終わる中心線は境界にする', () => {
  // 水平壁: axisCL y=0・仕上げ面 y=75（axisOffset=75）
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  const o = addOpening(graph, wall, 1000, 800);
  const far = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH, extentLo: 500, extentHi: 2500 });
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 400, max: 2600 }, '壁の手前(y=500)で終わる中心線は無関係');
  assert.equal(clCrossesWall(far, wall), false);
  graph.removeShape(far.id);
  const touching = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH, extentLo: 75, extentHi: 2500 });
  assert.equal(clCrossesWall(touching, wall), true, '仕上げ面(y=75)で終わる中心線は壁に突き当たる');
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 400, max: 1600 });
});

test('openingMoveRange: 補助線（破線）・梁芯はまたげる（境界にしない）', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  graph.addCenterLine(CenterLineType.VERTICAL, 2200, { labeled: false, discipline: Discipline.FUSE });
  const o = addOpening(graph, wall, 1000, 800);
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 400, max: 2600 });
});

// ---- 直交壁がある CL は CL 値ではなく材の面で止める（建具枠が壁に埋まらない。実機指摘 2026-09-14） ----
// 水平の host 壁（axisCL y=0・面 y=75）に、x=v の垂直 CL 上の直交壁を足す。spanLo/spanHi は y 方向のスパン。
function addPerpWall(graph, host, v, { axisOffset = 75, spanLo = 0, spanHi = 3000, ...props } = {}) {
  const cl = graph.centerLines.find(c => c.centerLineType === CenterLineType.VERTICAL && c.value === v)
    ?? graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const yLo = graph.addCenterLine(CenterLineType.HORIZONTAL, spanLo, { labeled: false, discipline: Discipline.ARCH });
  const yHi = graph.addCenterLine(CenterLineType.HORIZONTAL, spanHi, { labeled: false, discipline: Discipline.ARCH });
  return graph.addWall(cl, axisOffset, true, yLo, 0, yHi, 0, { isExteriorWall: false, ...props });
}

test('openingMoveRange: 直交壁のある中心線は、CL値ではなく直交壁の材の面が境界になる', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  const o = addOpening(graph, wall, 1000, 800); // 600..1400
  addPerpWall(graph, wall, 2000, { axisOffset: -75 }); // 材 1925..2000（開口側へ75）
  addPerpWall(graph, wall, 300,  { axisOffset: 75 });  // 材 300..375
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 775, max: 1525 });
});

test('openingMoveRange: 偏芯壁（backingOffset）は下地の実位置で止める', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  const o = addOpening(graph, wall, 1000, 800);
  // 面 y... x=1925（axisOffset -75）、下地中心 2000-100=1900・深さ90 → 下地 1855..1945、仕上げ 1925..1937.5
  // → 材 1855..1945（Wall.materialRange）。CL値2000でも面1925でもなく 1855 で止まる。
  const w = addPerpWall(graph, wall, 2000, { axisOffset: -75, backingOffset: -100, backingDepth: 90, wallFinish: 12.5 });
  assert.deepEqual(w.materialRange, { lo: 1855, hi: 1945 });
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 400, max: 1455 });
});

test('openingMoveRange: 境界の反対側から突き当たる直交壁（スパンが境界の厚みに触れる）も境界になる', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  const o = addOpening(graph, wall, 1000, 800);
  // host の境界厚みは y=0..75。y=-3000..0 の壁は y=0 で境界に触れる → 材 1925..2000 で止める
  addPerpWall(graph, wall, 2000, { axisOffset: -75, spanLo: -3000, spanHi: 0 });
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 400, max: 1525 });
});

test('openingMoveRange: 境界に届かない直交壁は無視し、CL自体が中心線ならCL値で止める', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  const o = addOpening(graph, wall, 1000, 800);
  addPerpWall(graph, wall, 2000, { axisOffset: -75, spanLo: -3000, spanHi: -100 }); // y=-100 で終わる＝境界に触れない
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 400, max: 1600 }, 'CL値2000 − 半幅400');
});

test('openingMoveRange: host 壁の端が直交壁の材の中まで伸びていても、材の面で止まる', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph); // span 0..3000
  const o = addOpening(graph, wall, 1000, 800);
  addPerpWall(graph, wall, 3000, { axisOffset: -75 }); // 材 2925..3000（host 端 3000 の内側）
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 400, max: 2525 });
});

test('perpendicularWallMaterial: 同じ CL 上の複数壁（下地オーナー壁＋仕上げ薄壁）の材を合併する', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  const o = addOpening(graph, wall, 1000, 800);
  addPerpWall(graph, wall, 2000, { axisOffset: -57.5, backingOffset: 0, backingDepth: 90, wallFinish: 12.5 }); // 1942.5..2045
  addPerpWall(graph, wall, 2000, { axisOffset: 57.5,  backingOffset: 0, backingDepth: 0,  wallFinish: 12.5 }); // 2045..2057.5
  const cl = graph.centerLines.find(c => c.value === 2000 && c.centerLineType === CenterLineType.VERTICAL);
  assert.deepEqual(perpendicularWallMaterial(cl, wall, { lo: 0, hi: 75 }, graph), { lo: 1942.5, hi: 2057.5 });
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 400, max: 1542.5 });
});

test('【失敗系】openingMoveRange: 今すでにまたいでいるCL（旧データ）は無視して動かせる', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const o = addOpening(graph, wall, 1000, 800); // 600..1400 が CL 1000 をまたぐ
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 400, max: 2600 });
});

test('openingRefOffsetRange: 「位置」欄の範囲にも中心線の境界が効く', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const o = addOpening(graph, wall, 1000, 800);
  assert.deepEqual(openingRefOffsetRange(o, graph), { min: 400, max: 1600 });
});

test('【失敗系】openingMoveRange: 壁長より広い開口は収まる余地が無く null', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  const o = addOpening(graph, wall, 1500, 3200);
  assert.equal(openingMoveRange(wall, o, graph), null);
});

// ================================================================
// openingRefOffsetRange
// ================================================================
test('openingRefOffsetRange: refCL(clStart)基準の整数範囲へ換算する', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph, { startX: 100 }); // 壁 x=100..3000
  const o = addOpening(graph, wall, 1000, 800);                  // 中心 1100
  // 中心範囲 500..2600 → refCL(100)基準 400..2500
  assert.deepEqual(openingRefOffsetRange(o, graph), { min: 400, max: 2500 });
});

test('openingRefOffsetRange: 非整数の中心範囲は内側へ丸める（ceil/floor）', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  const o = addOpening(graph, wall, 1500, 801); // 半幅 400.5 → 中心範囲 400.5..2599.5
  assert.deepEqual(openingRefOffsetRange(o, graph), { min: 401, max: 2599 });
});

test('【失敗系】openingRefOffsetRange: ホスト壁が引けない開口は null（制約なし扱い）', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  const otherAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, 5000, { labeled: false, discipline: Discipline.ARCH });
  const o = graph.addOpening(otherAxis, 1, false, wall.clStart, 1500, 800, OpeningCategory.FITTING, 'singleSwing', {});
  assert.equal(openingRefOffsetRange(o, graph), null);
});

// ================================================================
// clampRefOffset
// ================================================================
test('clampRefOffset: 範囲内はそのまま・範囲外は端へ・range=null は制約なし', () => {
  const range = { min: 400, max: 2600 };
  assert.equal(clampRefOffset(1500, range), 1500);
  assert.equal(clampRefOffset(-50,  range), 400);
  assert.equal(clampRefOffset(9999, range), 2600);
  assert.equal(clampRefOffset(9999, null),  9999);
});

test('【失敗系】clampRefOffset: NaN は握りつぶさずそのまま返す（呼び出し側が検知する）', () => {
  assert.ok(Number.isNaN(clampRefOffset(NaN, { min: 0, max: 100 })));
});

// ================================================================
// openingSnapCandidates
// ================================================================
test('openingSnapCandidates: 補助線（またげる）への中心一致・端一致と範囲端を候補にする', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  const o = addOpening(graph, wall, 1000, 800);
  const range = openingMoveRange(wall, o, graph); // 400..2600（補助線は境界にならない）
  const cands = openingSnapCandidates(wall, o, graph, range);
  const byKind = kind => cands.filter(c => c.kind === kind).map(c => c.value).sort((a, b) => a - b);
  assert.ok(byKind('cl-center').includes(1500), '中心一致 1500');
  assert.deepEqual(byKind('cl-edge').filter(v => v === 1100 || v === 1900), [1100, 1900], '端一致 1100/1900');
  assert.deepEqual(byKind('range-end'), [400, 2600]);
});

test('openingSnapCandidates: またげない中心線は端一致（＝範囲端）だけが候補になり、中心一致は範囲外で落ちる', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: true, discipline: Discipline.STRUCT });
  const o = addOpening(graph, wall, 1000, 800);
  const range = openingMoveRange(wall, o, graph); // 400..1100
  assert.deepEqual(range, { min: 400, max: 1100 });
  const cands = openingSnapCandidates(wall, o, graph, range);
  assert.ok(!cands.some(c => c.kind === 'cl-center' && c.value === 1500), '通り芯1500への中心一致は範囲外');
  assert.ok(cands.some(c => c.kind === 'cl-edge' && c.value === 1100), '通り芯1500への端一致(1100)は残る');
});

test('openingSnapCandidates: 壁と平行なCL（axisCL）・梁芯・範囲外の候補は含めない', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH }); // 平行
  graph.addCenterLine(CenterLineType.VERTICAL,   1500, { labeled: false, discipline: Discipline.FUSE }); // 梁芯
  const o = addOpening(graph, wall, 1000, 800);
  const range = openingMoveRange(wall, o, graph); // 400..2600
  const cands = openingSnapCandidates(wall, o, graph, range);
  assert.ok(!cands.some(c => c.value === 1500), '平行CL・梁芯の1500は候補にならない');
  // clStart(x=0)は範囲外: 中心一致0・端一致-400 は落ち、端一致 +400 だけが残る
  assert.ok(!cands.some(c => c.value < range.min || c.value > range.max), '範囲外の候補は含まない');
  assert.ok(cands.some(c => c.kind === 'cl-edge' && c.value === 400), 'clStartへの端一致(400)は範囲内');
});

test('openingSnapCandidates/openingMoveRange: 垂直壁では水平CLだけが横切るCL（垂直CLは範囲にも候補にも効かない）', () => {
  const graph = makeGraph();
  const { wall } = makeVerticalWall(graph);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true,  discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL,   2000, { labeled: false, discipline: Discipline.ARCH });
  const o = addOpening(graph, wall, 1000, 800);
  const range = openingMoveRange(wall, o, graph);
  assert.deepEqual(range, { min: 400, max: 1600 }, '水平CL y=2000 が境界。垂直CL x=2000 は無関係');
  const edges = openingSnapCandidates(wall, o, graph, range).filter(c => c.kind === 'cl-edge').map(c => c.value);
  assert.ok(edges.includes(1600), '水平CL y=2000 への端一致(1600)');
});

// ================================================================
// resolveOpeningRefOffset
// ================================================================
const RANGE = { min: 400, max: 2600 };
const CANDS = [{ value: 1500, kind: 'cl-center' }, { value: 1100, kind: 'cl-edge' }, { value: 2600, kind: 'range-end' }];

test('resolveOpeningRefOffset: 閾値内なら最も近い候補へスナップする', () => {
  const r = resolveOpeningRefOffset(1480, { refValue: 0, range: RANGE, candidates: CANDS, thresholdMm: 50, stepMm: 100 });
  assert.deepEqual({ refOffset: r.refOffset, snapped: r.snapped, kind: r.candidate.kind }, { refOffset: 1500, snapped: true, kind: 'cl-center' });
  const r2 = resolveOpeningRefOffset(1120, { refValue: 0, range: RANGE, candidates: CANDS, thresholdMm: 50, stepMm: 100 });
  assert.equal(r2.refOffset, 1100);
});

// 実機指摘（2026-09-14「通り芯で止まらない」）の再現: 14.stq では通り芯X2(-3000)が壁端(-3045)の45mm内側を
// 横切り、端一致候補(-2600)・範囲端(-2645)・中心線候補が同じ閾値内に密集する。最近傍だけで選ぶと
// 通り芯が特別扱いされない。
test('resolveOpeningRefOffset: 通り芯の候補は中心線・範囲端より優先する（閾値内なら遠くても通り芯で止まる）', () => {
  const grid = { discipline: Discipline.STRUCT };
  const cands = [
    { value: -2600, kind: 'cl-edge',   cl: grid },                        // 通り芯X2に端一致
    { value: -2640, kind: 'cl-center', cl: { discipline: Discipline.ARCH } }, // 中心線（通り芯ではない）
    { value: -2645, kind: 'range-end', edge: -1 },                        // 壁端
  ];
  const opts = { refValue: 0, range: { min: -2645, max: -1962.5 }, candidates: cands, thresholdMm: 100, stepMm: 100 };
  const r = resolveOpeningRefOffset(-2644, opts);
  assert.deepEqual({ refOffset: r.refOffset, kind: r.candidate.kind }, { refOffset: -2600, kind: 'cl-edge' }, '範囲端・中心線の方が近くても通り芯を採る');
  // 通り芯以外だけが閾値内なら、その中で最近傍（中心線 > 範囲端）
  const r2 = resolveOpeningRefOffset(-2644, { ...opts, candidates: cands.slice(1) });
  assert.equal(r2.candidate.kind, 'cl-center');
  // 閾値の外まで引けばスナップが外れ、クランプで壁端(-2645)へ到達できる
  const r3 = resolveOpeningRefOffset(-2800, opts);
  assert.deepEqual({ refOffset: r3.refOffset, snapped: r3.snapped }, { refOffset: -2645, snapped: false });
});

test('resolveOpeningRefOffset: 閾値外はスナップせず refCL 基準でステップ丸め', () => {
  const r = resolveOpeningRefOffset(1234, { refValue: 0, range: RANGE, candidates: CANDS, thresholdMm: 20, stepMm: 100 });
  assert.deepEqual({ refOffset: r.refOffset, snapped: r.snapped }, { refOffset: 1200, snapped: false });
  // refCL が 100 のとき: rel=1134 → 1100 → 中心 1200
  const r2 = resolveOpeningRefOffset(1234, { refValue: 100, range: RANGE, candidates: [], thresholdMm: 0, stepMm: 100 });
  assert.equal(r2.refOffset, 1100);
});

test('resolveOpeningRefOffset: 範囲外は端へクランプ（丸め後にクランプするので端の値は整数範囲そのもの）', () => {
  const r = resolveOpeningRefOffset(9999, { refValue: 0, range: RANGE, candidates: [], thresholdMm: 0, stepMm: 100 });
  assert.equal(r.refOffset, 2600);
  const r2 = resolveOpeningRefOffset(-9999, { refValue: 0, range: RANGE, candidates: [], thresholdMm: 0, stepMm: 100 });
  assert.equal(r2.refOffset, 400);
});

test('resolveOpeningRefOffset: range は中心座標で受け取り、refCL 基準へ換算してからクランプする', () => {
  // 中心範囲 400..2600・refCL=100 → refOffset 範囲 300..2500。生値 9999 は 2500（中心 2600）で止まる
  const r = resolveOpeningRefOffset(9999, { refValue: 100, range: RANGE, candidates: [], thresholdMm: 0, stepMm: 100 });
  assert.equal(r.refOffset, 2500);
  // 非整数の中心範囲は内側へ丸める
  const r2 = resolveOpeningRefOffset(9999, { refValue: 0, range: { min: 400.5, max: 2599.5 }, candidates: [], thresholdMm: 0, stepMm: 100 });
  assert.equal(r2.refOffset, 2599);
});

test('refOffsetRangeOf: 中心範囲を refCL 基準の整数範囲へ。空なら null・range=null は null', () => {
  assert.deepEqual(refOffsetRangeOf({ min: 400.5, max: 2599.5 }, 100), { min: 301, max: 2499 });
  assert.equal(refOffsetRangeOf({ min: 1000.2, max: 1000.8 }, 0), null);
  assert.equal(refOffsetRangeOf(null, 0), null);
});

test('snapIndicatorAlong: CL系はCLの位置、範囲端は接している開口の端', () => {
  const cl = { value: 1500 };
  assert.equal(snapIndicatorAlong({ value: 1500, kind: 'cl-center', cl }, 400), 1500);
  assert.equal(snapIndicatorAlong({ value: 1900, kind: 'cl-edge',   cl }, 400), 1500);
  assert.equal(snapIndicatorAlong({ value: 400,  kind: 'range-end', edge: -1 }, 400), 0);
  assert.equal(snapIndicatorAlong({ value: 2600, kind: 'range-end', edge: 1 },  400), 3000);
});

test('openingSnapCandidates: 範囲端候補は edge（-1=lo端が接する／+1=hi端）を持つ', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  const o = addOpening(graph, wall, 1000, 800);
  const ends = openingSnapCandidates(wall, o, graph, openingMoveRange(wall, o, graph)).filter(c => c.kind === 'range-end');
  assert.deepEqual(ends.map(c => [c.value, c.edge]), [[400, -1], [2600, 1]]);
});

test('resolveOpeningRefOffset: 非整数CLへのスナップも refOffset は整数（位置欄の規約）', () => {
  const r = resolveOpeningRefOffset(1500, { refValue: 0, range: RANGE, candidates: [{ value: 1500.4, kind: 'cl-center' }], thresholdMm: 10, stepMm: 100 });
  assert.equal(r.refOffset, 1500);
});

test('resolveOpeningRefOffset: stepMm が 0 以下なら整数丸め', () => {
  const r = resolveOpeningRefOffset(1234.6, { refValue: 0, range: RANGE, candidates: [], thresholdMm: 0, stepMm: 0 });
  assert.equal(r.refOffset, 1235);
});

test('【失敗系】resolveOpeningRefOffset: 生値が有限でなければ null（NaN を refOffset へ流さない）', () => {
  assert.equal(resolveOpeningRefOffset(NaN, { refValue: 0, range: RANGE, candidates: CANDS, thresholdMm: 50, stepMm: 100 }), null);
  assert.equal(resolveOpeningRefOffset(Infinity, { refValue: 0, range: RANGE, candidates: CANDS, thresholdMm: 50, stepMm: 100 }), null);
});

// ---- 展開図ドラッグの座標換算: dirSign の往復（画面右へ動かせば、どちら向きの面でも図の上で右へ動く） ----
test('elevationDragAlong/previewDxLocalMm: dirSign=±1 の往復で「画面右へ100px ＝ 図の上で右へ 100/scale mm」', () => {
  for (const dirSign of [1, -1]) {
    const scale = 0.05; // px/mm（1/76相当）
    const along = elevationDragAlong({ downCenter: 3000, downClientX: 400, clientX: 500, scale, dirSign });
    assert.equal(along, 3000 + dirSign * 2000, '世界座標は dirSign の向きへ 2000mm');
    assert.equal(previewDxLocalMm(along, 3000, dirSign), 2000, '帯ローカルでは常に右へ 2000mm');
  }
});

test('openingMoveRange: 補助線（破線）CL上に実在する直交壁は種別を問わず材の面で止める（壁は物理的な障害物）', () => {
  const graph = makeGraph();
  const { wall } = makeHorizontalWall(graph);
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  const o = addOpening(graph, wall, 1000, 800);
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 400, max: 2600 }, '壁の無い補助線はまたげる');
  addPerpWall(graph, wall, 2000, { axisOffset: -75 }); // 材 1925..2000
  assert.deepEqual(openingMoveRange(wall, o, graph), { min: 400, max: 1525 }, '補助線上でも壁があれば材の面で止まる');
});
