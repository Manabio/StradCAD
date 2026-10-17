// sectionStructure.js 見え掛かりの梁の遮蔽（壁＝規則A・柱の包み込み外形＝規則B）の単体テスト。
// 13.stq「7」C の経緯: 読込み時の構造再計算で上階graphに生まれた踊り場受け梁（LG）の端が、自階の柱包みの
// 中なのに 32.5mm の中線として出た。判定は固定mmでなく構造上の述語（壁が切断線と梁の間／梁の帯が柱外形に収まる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType } from '@core';
import { generateStairPartitionWalls } from '../../finish/stair/stairPartitionWalls.js';
import { structuralPrimitivesForCut } from './sectionStructure.js';

// 水平の切断線 y=0（室内側＝+y。viewSign=1・dirSign=1・local x = world x）。
// 梁は y=500 の空中、x 0..2000、天 1190・成 200。
const beamSolid = (over = {}) => ({
  isVertical: false, axisWorld: 500, spanLo: 0, spanHi: 2000, widthMm: 100,
  topZ: 1190, depthMm: 200, role: 'landing', section: null, ...over,
});
const cutOf = (layers = [], over = {}) => ({
  seqNo: 'c', line: { isVertical: false, axisValue: 0, lo: 0, hi: 2000 },
  viewSign: 1, dirSign: 1, layers, zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0, ...over,
});
// 柱の包み込み外形（ColumnSolid）。厚み方向 y 440..560（梁の帯 450..550 を含む）・スパン方向 x 1900..2100。
const colSolid = (over = {}) => ({
  xLo: 1900, xHi: 2100, yLo: 440, yHi: 560, baseZ: 0, covers: {}, trimmed: {}, wallAxes: [], ...over,
});
const selfLayer = (graph = { walls: [] }, floorZMm = 0) => ({ graph, floorZMm, role: 'self' });
const aboveLayer = { graph: { walls: [] }, floorZMm: 2900, role: 'above' };
const mids = prims => prims.filter(p => p.weight === 'medium' && p.y1 === p.y2);
const rangesOf = prims => mids(prims)
  .map(p => `${Math.min(p.x1, p.x2)}-${Math.max(p.x1, p.x2)}`).sort();
const xSpan = prims => {
  const xs = prims.flatMap(p => [p.x1, p.x2]);
  return [Math.min(...xs), Math.max(...xs)];
};

test('【規則B】airborne: 梁の端が柱包みの中ならその区間の中線を描かない。columnSolids:null の対照では描く', () => {
  const beam = [beamSolid()];
  const withCol = structuralPrimitivesForCut(beam, cutOf(), [], null, { columnSolids: [colSolid()] });
  assert.equal(mids(withCol).length, 2, '天地 2 本（残る区間は 0..1900 の 1 区間）');
  assert.deepEqual(xSpan(withCol), [0, 1900], '柱包みの手前 1900 で止まる');
  const control = structuralPrimitivesForCut(beam, cutOf(), [], null, { columnSolids: null });
  assert.deepEqual(xSpan(control), [0, 2000], 'null は規則Bを使わない（従来どおり全長）');
  // 13.stq「7」C 型: 描画範囲に残る梁は柱包みの中の端だけ
  const endCut = cutOf([], { line: { isVertical: false, axisValue: 0, lo: 1900, hi: 2400 } });
  assert.equal(mids(structuralPrimitivesForCut(beam, endCut, [], null, { columnSolids: [colSolid()] })).length, 0,
    '描画範囲 1900..2400 に残る梁 1900..2000 は全部柱の中');
  assert.equal(mids(structuralPrimitivesForCut(beam, endCut, [], null, { columnSolids: null })).length, 2,
    '対照: 柱を使わなければ中線 2 本が出る');
});

test('【規則B】crosses(柱の中): 切断線が柱の中なら断面を出さない。柱の外なら従来の 4 辺', () => {
  const beam = [beamSolid()];
  const cutAtX = x => ({
    seqNo: 'c', line: { isVertical: true, axisValue: x, lo: 0, hi: 1000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
  });
  const col = colSolid();
  assert.equal(structuralPrimitivesForCut(beam, cutAtX(1950), [], null, { columnSolids: [col] }).length, 0, '柱の中で切る');
  assert.equal(structuralPrimitivesForCut(beam, cutAtX(1950), [], null, { columnSolids: null }).length, 4, '対照: 規則Bなし');
  assert.equal(structuralPrimitivesForCut(beam, cutAtX(1000), [], null, { columnSolids: [col] }).length, 4, '柱の外で切る');
});

test('【規則B】z と厚み方向: 上階の柱・厚み方向が収まらない柱・柱の上端を越える梁は隠さない', () => {
  const beam = [beamSolid()];
  const cut = cutOf([selfLayer(), aboveLayer]);
  const run = columns => xSpan(structuralPrimitivesForCut(beam, cut, [], null, { columnSolids: columns }));
  assert.deepEqual(run([colSolid()]), [0, 1900], '前提: 自階の柱は隠す');
  assert.deepEqual(run([colSolid({ baseZ: 2900 })]), [0, 2000], '上階の柱（baseZ=階高）は 1190 の梁を隠さない');
  assert.deepEqual(run([colSolid({ yLo: 520, yHi: 700 })]), [0, 2000], '梁の帯 450..550 が柱の厚み 520..700 に収まらない');
  const tall = [beamSolid({ topZ: 3500 })]; // 下端 3300 ＞ 直上の床 2900
  const tallCut = cutOf([selfLayer(), aboveLayer], { zRange: { loZ: 0, hiZ: 5400 } });
  assert.deepEqual(xSpan(structuralPrimitivesForCut(tall, tallCut, [], null, { columnSolids: [colSolid()] })), [0, 2000],
    '下端が直上の床より上の梁は、下階の柱の上端を越えるので隠さない');
});

test('【規則B】parallel: 柱に中断される梁は天地が 2 区間に割れ、縦線は元の端だけ', () => {
  const beam = [beamSolid({ axisWorld: 0, spanLo: 0, spanHi: 3000 })];
  const cut = cutOf([], { line: { isVertical: false, axisValue: 0, lo: 0, hi: 3000 } });
  const col = colSolid({ xLo: 1000, xHi: 1200, yLo: -60, yHi: 60 });
  const prims = structuralPrimitivesForCut(beam, cut, [], null, { columnSolids: [col] });
  const horiz = prims.filter(p => p.y1 === p.y2).map(p => `${Math.min(p.x1, p.x2)}-${Math.max(p.x1, p.x2)}`).sort();
  assert.deepEqual(horiz, ['0-1000', '0-1000', '1200-3000', '1200-3000']);
  const verts = prims.filter(p => p.x1 === p.x2).map(p => p.x1).sort((a, b) => a - b);
  assert.deepEqual(verts, [0, 3000], '縦線は元の梁の端 0 と 3000 だけ（柱の際には立てない）');
  assert.equal(structuralPrimitivesForCut(beam, cut, [], null, { columnSolids: null }).length, 4, '対照: 規則Bなしは従来の 4 本');
});

// ---- 規則A: 切断線と梁の間に立つ同じ向きの壁 ----
const wallFake = (over = {}) => ({
  isVertical: false, axisValue: 300, materialRange: { lo: 290, hi: 310 }, coord1: 600, coord2: 1400, ...over,
});

test('【規則A】切断線と梁の間の壁が覆う区間だけ消え、壁の外は残る。向こう側・上階の層・向き違い・面自身の壁は遮蔽しない', () => {
  const beam = [beamSolid()];
  const run = (layers, over) =>
    rangesOf(structuralPrimitivesForCut(beam, cutOf(layers, over), [], null, { columnSolids: null }));
  const FULL = ['0-2000', '0-2000'];
  assert.deepEqual(run([selfLayer({ walls: [wallFake()] })]), ['0-600', '0-600', '1400-2000', '1400-2000'], '壁 600..1400 の区間が消える');
  assert.deepEqual(run([selfLayer({ walls: [] })]), FULL, '対照: 壁なし');
  assert.deepEqual(run([selfLayer({ walls: [wallFake({ axisValue: 700, materialRange: { lo: 690, hi: 710 } })] })]), FULL,
    '梁（手前の縁 450）より向こう側の壁は遮蔽しない');
  assert.deepEqual(run([{ graph: { walls: [wallFake()] }, floorZMm: 2900, role: 'above' }]), FULL, '上階の層（floorZ ≥ hiZ）の壁は遮蔽しない');
  assert.deepEqual(run([selfLayer({ walls: [wallFake({ isVertical: true })] })]), FULL, '向きが違う壁は遮蔽しない');
  assert.deepEqual(run([selfLayer({ walls: [wallFake({ axisValue: 0, materialRange: { lo: -5, hi: 10 } })] })]), FULL,
    '面自身の壁（芯が切断線上）は遮蔽しない');
});

test('【規則A】腰壁（kneeDropWalls のレコードを持つ壁）は遮蔽に使わない', () => {
  const beam = [beamSolid()];
  const graph = new PlanGraph(new Plane('kd', 0, '1階', 1, 1));
  const axis = graph.addCenterLine(CenterLineType.HORIZONTAL, 300, { labeled: true, discipline: Discipline.STRUCT });
  const c0 = graph.addCenterLine(CenterLineType.VERTICAL, 600, { labeled: true, discipline: Discipline.STRUCT });
  const c1 = graph.addCenterLine(CenterLineType.VERTICAL, 1400, { labeled: true, discipline: Discipline.STRUCT });
  // walls は computed で代入できないため、実 graph を原型にした薄い読取り用の殻に偽の壁だけを持たせる
  const shell = Object.create(graph, { walls: { value: [wallFake({ axisCL: axis })] } });
  const count = () => mids(structuralPrimitivesForCut(beam, cutOf([{ graph: shell, floorZMm: 0, role: 'self' }]), [], null, { columnSolids: null })).length;
  assert.equal(count(), 4, '前提: 記録の無い壁は全高として遮蔽し、梁が 2 区間に割れる');
  graph.kneeDropWalls.set(`${axis.id}:${c0.id}:${c1.id}`, { knee: { topHeight: 900 } });
  assert.equal(count(), 2, '腰壁は遮蔽しない（全長 1 区間）');
});

test('【失敗系】layers 無し・walls 無し・columnSolids 空配列・NaN の柱・幅 NaN の梁でも例外を投げず従来どおり描く', () => {
  const beam = [beamSolid()];
  const n = prims => mids(prims).length;
  assert.equal(n(structuralPrimitivesForCut(beam, { ...cutOf(), layers: undefined })), 2, 'layers 無し');
  assert.equal(n(structuralPrimitivesForCut(beam, cutOf([{ graph: {}, floorZMm: 0, role: 'self' }]))), 2, 'walls/columns 無しの graph');
  assert.equal(n(structuralPrimitivesForCut(beam, cutOf(), [], null, { columnSolids: [] })), 2, '空配列');
  assert.equal(n(structuralPrimitivesForCut(beam, cutOf(), [], null, { columnSolids: [colSolid({ yLo: NaN, xHi: NaN })] })), 2, 'NaN の柱は隠さない');
  assert.doesNotThrow(() => structuralPrimitivesForCut([beamSolid({ widthMm: NaN })], cutOf(), [], null, { columnSolids: [colSolid()] }));
});

test('【crosses】切断位置から室内側へ梁が続かない／続きが壁の材厚・柱包みに隠れるなら断面を出さない。続くなら従来どおり描く', () => {
  const cutX = (layers, x, viewSign = 1) => ({
    seqNo: 'c', line: { isVertical: true, axisValue: x, lo: 0, hi: 1000 },
    viewSign, dirSign: 1, layers, zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
  });
  // 梁と直交する（垂直の）壁。材厚 x 940..1060（切断線 x=1000 は壁芯）。スパン y 0..1000 が梁の帯 450..550 を覆う
  const perp = (over = {}) => ({ isVertical: true, axisValue: 1000, materialRange: { lo: 940, hi: 1060 }, coord1: 0, coord2: 1000, ...over });
  const n = (b, { wall = perp(), x = 1000, viewSign = 1, columns = null } = {}) =>
    structuralPrimitivesForCut([b], cutX([selfLayer({ walls: wall ? [wall] : [] })], x, viewSign), [], null, { columnSolids: columns }).length;
  // 1. 梁が壁芯で終わり壁の中（柱なし）→ 0。壁の室内側の面を越えて続く → 描く
  assert.equal(n(beamSolid({ spanLo: 0, spanHi: 1000 })), 0, '梁が切断線（壁芯）で終わり、室内側へ続かない');
  assert.equal(n(beamSolid({ spanLo: 0, spanHi: 1050 })), 0, '壁の材厚 940..1060 の中で終わる');
  assert.equal(n(beamSolid({ spanLo: 0, spanHi: 2000 })), 4, '対照: 壁の室内側の面 1060 を越えて続く');
  // 2. 壁を抜けた先の柱包みの中で終わる（13.stq「7」面 D 型）→ 0。柱包みを使わない対照では残りが見える
  const col = [colSolid({ xLo: 1060, xHi: 1300 })];
  assert.equal(n(beamSolid({ spanLo: 0, spanHi: 1200 }), { columns: col }), 0, '壁の材厚と柱包みを引くと室内側に残らない');
  assert.equal(n(beamSolid({ spanLo: 0, spanHi: 1200 }), { columns: null }), 4, '対照: 柱包みを使わなければ 1060..1200 が残る');
  // 3. 切断線が壁の中に無い（階段帯型。x=1200 は壁の材厚の外）で梁が室内側へ続く → 描く
  assert.equal(n(beamSolid({ spanLo: 0, spanHi: 2000 }), { x: 1200 }), 4, '壁の控除は掛からない');
  assert.equal(n(beamSolid({ spanLo: 0, spanHi: 1200 }), { x: 1200, columns: [colSolid({ xLo: 1150, xHi: 1300 })] }), 0,
    '階段帯型でも柱包みは効く');
  // 4. viewSign -1 側の対称（室内側は x の小さい側）
  assert.equal(n(beamSolid({ spanLo: 1000, spanHi: 2000 }), { viewSign: -1 }), 0, '梁が切断線で終わり室内側（-x）へ続かない');
  assert.equal(n(beamSolid({ spanLo: 0, spanHi: 2000 }), { viewSign: -1 }), 4, '対照: 室内側（-x）へ壁の面 940 を越えて続く');
  // 壁の条件: 梁の帯を覆わない壁・腰壁以外の向き違いの壁は引かない
  assert.equal(n(beamSolid({ spanLo: 0, spanHi: 1050 }), { wall: perp({ coord1: 700, coord2: 1000 }) }), 4, '梁の帯を覆わない壁は引かない');
});

test('【crosses】at を含む壁に隣り合う仕上げ薄壁も連なりとして引く。連ならない壁は引かない', () => {
  const cut = layers => ({
    seqNo: 'c', line: { isVertical: true, axisValue: 1000, lo: 0, hi: 1000 },
    viewSign: 1, dirSign: 1, layers, zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
  });
  const w = (lo, hi) => ({ isVertical: true, axisValue: (lo + hi) / 2, materialRange: { lo, hi }, coord1: 0, coord2: 1000 });
  const n = walls => structuralPrimitivesForCut([beamSolid({ spanLo: 0, spanHi: 1070 })], cut([selfLayer({ walls })]), [], null, { columnSolids: null }).length;
  assert.equal(n([w(940, 1060), w(1060, 1072.5)]), 0, '下地オーナー壁 940..1060 に仕上げ薄壁 1060..1072.5 が連なる');
  assert.equal(n([w(940, 1060)]), 4, '対照: 薄壁が無ければ 1060..1070 が残る');
  assert.equal(n([w(940, 1060), w(1065, 1072.5)]), 4, '隙間のある壁は連ならない');
});

test('【規則A】2層帯で別の層の壁は z が重ならなければ梁を隠さない（梁の z 範囲を完全に覆う全高の壁だけが遮蔽する）', () => {
  const wall = wallFake();
  const run = (layers, beam) => rangesOf(structuralPrimitivesForCut([beam], cutOf(layers, { zRange: { loZ: 0, hiZ: 5800 } }), [], null, { columnSolids: null }));
  const FULL = ['0-2000', '0-2000'];
  const SPLIT = ['0-600', '0-600', '1400-2000', '1400-2000'];
  const lower = [selfLayer({ walls: [wall] }), { graph: { walls: [] }, floorZMm: 2900, role: 'above' }];
  const upper = [selfLayer({ walls: [] }), { graph: { walls: [wall] }, floorZMm: 2900, role: 'above' }];
  assert.deepEqual(run(upper, beamSolid()), FULL, '上階の壁（z 2900〜）は 1 階の梁（z 990..1190）を隠さない');
  assert.deepEqual(run(lower, beamSolid({ topZ: 4090 })), FULL, '1 階の壁（z 0..2900）は 2 階の梁（天 4090）を隠さない');
  assert.deepEqual(run(lower, beamSolid()), SPLIT, '対照: 1 階の壁は 1 階の梁（z 990..1190）を隠す');
  assert.deepEqual(run(upper, beamSolid({ topZ: 4090 })), SPLIT, '対照: 上階の壁は 2 階の梁（天 4090）を隠す');
  assert.deepEqual(run(lower, beamSolid({ topZ: 3100 })), FULL, '壁の上端（次の層の床 2900）をまたぐ梁は完全に覆われないので隠さない');
});

test('【規則A】隔て板（stairPartitionLines に一致する壁）は遮蔽に使わない（天端が斜めで全高でない）。階段が無ければ同じ壁は遮蔽する', () => {
  // 在来木造の U 字階段（踊り場 y0〜1000・往復レーン y1000〜4000）。隔て板は x=1000・y1000〜4000 に立つ
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const vs = new Map(), hs = new Map();
  const V = v => vs.get(v) ?? vs.set(v, graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const H = v => hs.get(v) ?? hs.set(v, graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const cells = new Set([[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]]
    .map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
  graph.addStair({ type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], flip: false, upDirection: 'up' });
  generateStairPartitionWalls(graph, { structure: '木造（在来）' });
  assert.ok(graph.walls.length > 0, '前提: 隔て板が生成される');
  // 切断線 x=0（室内側＋x）と、隔て板（x≈1000）の向こう x=1500 の垂直の梁（y -500〜4500）
  const beam = beamSolid({ isVertical: true, axisWorld: 1500, spanLo: -500, spanHi: 4500 });
  const cut = layers => ({
    seqNo: 'c', line: { isVertical: true, axisValue: 0, lo: -500, hi: 4500 },
    viewSign: 1, dirSign: 1, layers, zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
  });
  const run = g => rangesOf(structuralPrimitivesForCut([beam], cut([selfLayer(g)]), [], null, { columnSolids: null }));
  assert.deepEqual(run(graph), ['0-5000', '0-5000'], '隔て板は遮蔽に使わず、梁は全長で描かれる');
  // 対照: 階段を持たない殻では同じ壁が通常の壁として梁を隠す（隔て板の除外が唯一の違い）
  const noStairs = Object.create(graph, { stairs: { value: [] } });
  assert.notDeepEqual(run(noStairs), ['0-5000', '0-5000'], '対照: 階段が無ければ同じ壁が梁の一部を隠す');
});
