// sectionCutPlane.js（仮想断面線をどこへ置くか）の単体テスト。
// ユーザー明示指示2026-08の規則「描画対象の面の壁表面が見える位置まで部屋内側へ下がる／左右の端に
// 柱型があれば柱型の面が見える位置まで下がる／造作家具があれば下がる／多層帯は全層を見る」を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { cutPlaneOffsetMm, faceCutLine, faceViewSign } from './sectionCutPlane.js';
import { composeRoomFaces } from '../elevationFaceList.js';

function makeGraph(name, level) {
  return new PlanGraph(new Plane(name, level, name, 1, 1));
}
function makeRectRoom(graph, x0v, y0v, x1v, y1v, name) {
  const cl = (t, v) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, x0v), x1 = cl(CenterLineType.VERTICAL, x1v);
  const y0 = cl(CenterLineType.HORIZONTAL, y0v), y1 = cl(CenterLineType.HORIZONTAL, y1v);
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}
function facesOf(room, graph) {
  return composeRoomFaces(room, graph).filter(f => f.kind !== 'step');
}
// 幾何を持たない最小の面リテラル（壁・柱が1本も無い層で規則の骨格だけを見る）。
function bareFace(overrides = {}) {
  return {
    isVertical: false, inward: 1, lo: 0, hi: 4000,
    axisCL: { effectiveValue: 0 }, faceValue: 0, dirSign: 1, ...overrides,
  };
}

// ---- 規則1: 壁仕上げ面ぶん下がる ----
test('【明示指示】cutPlaneOffsetMm: 面の壁の中心線→壁仕上げ面ぶん室内側へ下がる', () => {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const layers = [{ graph: g1, floorZMm: 0, role: 'self' }];
  for (const f of facesOf(room, g1)) {
    const d = cutPlaneOffsetMm(f, layers);
    const expected = Math.ceil(Math.abs(f.faceValue - f.axisCL.effectiveValue));
    assert.equal(d, expected, `${f.label}: 壁芯→仕上げ面(${expected})ぶん下がるはず（実際:${d}）`);
    assert.ok(d > 0, `${f.label}: 0のままだと切断面が壁の中を通る（旧実装の不具合）`);
  }
});

test('【明示指示】cutPlaneOffsetMm: 下がる向きは室内側（inwardの符号に従う）', () => {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const layers = [{ graph: g1, floorZMm: 0, role: 'self' }];
  for (const f of facesOf(room, g1)) {
    const line = faceCutLine(f, cutPlaneOffsetMm(f, layers));
    const moved = (line.axisValue - f.axisCL.effectiveValue) * f.inward;
    assert.ok(moved > 0, `${f.label}: 室内側(+inward)へ動くはず（実際の変位:${moved}）`);
  }
});

// ---- 規則: 多層帯は全層の最大 ----
test('【明示指示】cutPlaneOffsetMm: 上階の壁のほうが厚ければ上階側の値が採られる（多層帯は全層を見る）', () => {
  const g1 = makeGraph('1階', 0);
  const room = makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const face = facesOf(room, g1).find(f => f.letter === 'A');
  const selfLayer = { graph: g1, floorZMm: 0, role: 'self' };
  const selfOnly = cutPlaneOffsetMm(face, [selfLayer]);
  assert.ok(selfOnly > 0, '自階の壁仕上げ面ぶんは下がる（フィクスチャの前提）');

  // 上階の同位置に、室内側へより厚く出た壁がある層（graphは判定に必要な形だけを持つ最小の代役）。
  const thick = selfOnly + 200;
  const upperLayer = { floorZMm: 3000, role: 'above', graph: { walls: [{
    isVertical: false, axisCL: { effectiveValue: face.axisCL.effectiveValue },
    coord1: face.lo, coord2: face.hi,
    materialRange: { lo: face.axisCL.effectiveValue - 100, hi: face.axisCL.effectiveValue + thick },
  }] } };

  const both = cutPlaneOffsetMm(face, [selfLayer, upperLayer]);
  assert.equal(both, thick, `全層の最大(${thick})を採るはず（自階だけなら${selfOnly}。実際:${both}）`);
});

// ---- 規則2: 柱型 ----
test('【明示指示】cutPlaneOffsetMm: 面に現れる柱型の室内側への出まで下がる', () => {
  const face = bareFace(); // axisCL=0・inward=+1（室内は+y側）
  const columnSolids = [{
    xLo: 500, xHi: 900, yLo: -100, yHi: 320, baseZ: 0,
    wallAxes: [{ isVertical: false, axisValue: 0 }],
  }];
  assert.equal(cutPlaneOffsetMm(face, [], { columnSolids }), 320,
    '柱型の室内側の面(y=320)まで下がるはず');
});

test('cutPlaneOffsetMm: 面の走り範囲に掛からない柱型は無視する', () => {
  const face = bareFace();
  const columnSolids = [{
    xLo: 9000, xHi: 9400, yLo: -100, yHi: 320, baseZ: 0,
    wallAxes: [{ isVertical: false, axisValue: 0 }],
  }];
  assert.equal(cutPlaneOffsetMm(face, [], { columnSolids }), 0,
    '面(0..4000)の外(9000..9400)に立つ柱は下がる理由にならない');
});

test('cutPlaneOffsetMm: 壁の向こう側（室外）へ出ている柱型は下がる理由にならない', () => {
  const face = bareFace();
  const columnSolids = [{
    xLo: 500, xHi: 900, yLo: -400, yHi: -50, baseZ: 0,
    wallAxes: [{ isVertical: false, axisValue: 0 }],
  }];
  assert.equal(cutPlaneOffsetMm(face, [], { columnSolids }), 0);
});

// ---- 規則3: 造作家具（defer。フックのみ） ----
test('【defer】cutPlaneOffsetMm: 造作家具の出はフック(builtInProjectionMm)で受け取る', () => {
  const face = bareFace();
  assert.equal(cutPlaneOffsetMm(face, [], { builtInProjectionMm: 600 }), 600,
    'カウンター・キッチン等はドメインモデル未実装のため、値は呼び出し側から渡す');
});

test('cutPlaneOffsetMm: 壁・柱・造作家具のうち最大を採る', () => {
  const face = bareFace();
  const columnSolids = [{
    xLo: 500, xHi: 900, yLo: -100, yHi: 320, baseZ: 0,
    wallAxes: [{ isVertical: false, axisValue: 0 }],
  }];
  assert.equal(cutPlaneOffsetMm(face, [], { columnSolids, builtInProjectionMm: 600 }), 600);
  assert.equal(cutPlaneOffsetMm(face, [], { columnSolids, builtInProjectionMm: 100 }), 320);
});

test('cutPlaneOffsetMm: 1mm単位で切り上げる（ユーザー明示指示「切り上げ」）', () => {
  const face = bareFace();
  assert.equal(cutPlaneOffsetMm(face, [], { builtInProjectionMm: 57.5 }), 58);
});

// ---- faceCutLine / faceViewSign ----
test('faceCutLine: lo/hiと向きは動かさず、面の軸はfaceAxisValueとして残す', () => {
  const face = bareFace({ faceValue: 57.5 });
  const line = faceCutLine(face, 58);
  assert.equal(line.lo, 0); assert.equal(line.hi, 4000);
  assert.equal(line.isVertical, false);
  assert.equal(line.axisValue, 58, '切断線は室内側へ58mm下がる');
  assert.equal(line.faceAxisValue, 0, '面の軸CL（柱と面の照合に使う）は別値として残る');
});

test('faceCutLine: buttToleranceMmは「壁仕上げ面までの距離−下がった量」（負にはしない）', () => {
  const face = bareFace({ faceValue: 57.5 });
  assert.equal(faceCutLine(face, 0).buttToleranceMm, 57.5, '壁芯上に置くなら半厚ぶん許容が要る');
  assert.equal(faceCutLine(face, 58).buttToleranceMm, 0, '仕上げ面まで下がれば直交壁は切断線に届く');
  assert.equal(faceCutLine(face, 600).buttToleranceMm, 0, '負にはならない');
});

test('faceViewSign: 視線は室内側の逆＝壁を見る向き（inwardの符号を反転）', () => {
  assert.equal(faceViewSign({ inward: 1 }), -1);
  assert.equal(faceViewSign({ inward: -1 }), 1);
});

// ---- 失敗系 ----
test('【失敗系】cutPlaneOffsetMm: 軸CLやinwardが無い合成faceは0（例外を投げず切断線を動かさない）', () => {
  assert.equal(cutPlaneOffsetMm({ isVertical: false, inward: 1, lo: 0, hi: 1 }, []), 0);
  assert.equal(cutPlaneOffsetMm(bareFace({ inward: 0 }), []), 0);
  assert.equal(cutPlaneOffsetMm(bareFace({ axisCL: {} }), []), 0);
});

test('【失敗系】cutPlaneOffsetMm: 層0件・柱0件でも例外を投げない', () => {
  assert.equal(cutPlaneOffsetMm(bareFace(), []), 0);
  assert.equal(cutPlaneOffsetMm(bareFace(), null, { columnSolids: null }), 0);
});
