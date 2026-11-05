import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningMechanism } from './openingCatalog.js';
import { openingOpensTowardViewer, openingExteriorPerp } from './openingViewSide.js';

const M = OpeningMechanism;
const op = (isVertical, hingeSide, swingSide) => ({ isVertical, hingeSide, swingSide });

// 開く向き openPerp は平面記号の式 (isVertical?1:-1)·swingSide·hingeSide（実効吊元）。期待値は式ではなく手計算の値を直書きする。
test('蝶番系（SWING）: 垂直壁・水平壁 × hingeSide ±1 × swingSide ±1 で viewerPerp と一致すれば手前', () => {
  const cases = [
    // [isVertical, hingeSide, swingSide, openPerp]
    [true, -1, 1, -1], [true, -1, -1, 1], [true, 1, 1, 1], [true, 1, -1, -1],
    [false, -1, 1, 1], [false, -1, -1, -1], [false, 1, 1, -1], [false, 1, -1, 1],
  ];
  for (const [v, h, s, openPerp] of cases) {
    assert.equal(openingOpensTowardViewer(op(v, h, s), M.SWING, { viewerPerp: openPerp }), true, `${v},${h},${s} 手前`);
    assert.equal(openingOpensTowardViewer(op(v, h, s), M.SWING, { viewerPerp: -openPerp }), false, `${v},${h},${s} 向こう`);
  }
});

test('蝶番系: SWING_IN・PROJECT_V・DREH_KIPP・SWING_CHILD も同じ式で判定（PROJECT_V は蝶番系）', () => {
  for (const m of [M.SWING_IN, M.PROJECT_V, M.DREH_KIPP, M.SWING_CHILD]) {
    // 水平壁・hingeSide 1・swingSide 1 → openPerp -1
    assert.equal(openingOpensTowardViewer(op(false, 1, 1), m, { viewerPerp: -1 }), true, m);
    assert.equal(openingOpensTowardViewer(op(false, 1, 1), m, { viewerPerp: 1 }), false, m);
  }
});

test('両開き（SWING_DOUBLE）は実効吊元 -1 で判定し opening.hingeSide を見ない', () => {
  // 実効 hingeSide=-1: 垂直壁 swingSide 1 → -1、水平壁 swingSide 1 → +1
  for (const hingeSide of [-1, 1]) {
    assert.equal(openingOpensTowardViewer(op(true, hingeSide, 1), M.SWING_DOUBLE, { viewerPerp: -1 }), true);
    assert.equal(openingOpensTowardViewer(op(true, hingeSide, 1), M.SWING_DOUBLE, { viewerPerp: 1 }), false);
    assert.equal(openingOpensTowardViewer(op(false, hingeSide, 1), M.SWING_DOUBLE, { viewerPerp: 1 }), true);
  }
});

test('両袖の防火戸（fireLeaves 2・entry 付き）は実効吊元 -1、単袖は opening.hingeSide', () => {
  const two = { fireLeaves: 2 };
  assert.equal(openingOpensTowardViewer(op(true, 1, 1), M.FIRE_DOOR, { viewerPerp: -1, entry: two }), true);
  assert.equal(openingOpensTowardViewer(op(true, 1, 1), M.FIRE_DOOR, { viewerPerp: 1, entry: { fireLeaves: 1 } }), true);
  assert.equal(openingOpensTowardViewer(op(true, 1, 1), M.FIRE_DOOR, { viewerPerp: -1, entry: { fireLeaves: 1 } }), false);
});

test('自由扉（FREE・FREE_DOUBLE）は両方向に開くので null', () => {
  for (const m of [M.FREE, M.FREE_DOUBLE]) {
    for (const viewerPerp of [-1, 1]) assert.equal(openingOpensTowardViewer(op(true, -1, 1), m, { viewerPerp }), null, m);
  }
});

test('吊元を持たない窓: 外開き（PROJECT_OUT・TILT_OUT・AWNING_MULTI）は室外側を見るなら手前', () => {
  for (const m of [M.PROJECT_OUT, M.TILT_OUT, M.AWNING_MULTI]) {
    assert.equal(openingOpensTowardViewer(op(true, -1, 1), m, { viewerPerp: 1, exteriorPerp: 1 }), true, `${m} 外から`);
    assert.equal(openingOpensTowardViewer(op(true, -1, 1), m, { viewerPerp: -1, exteriorPerp: 1 }), false, `${m} 内から`);
    assert.equal(openingOpensTowardViewer(op(true, -1, 1), m, { viewerPerp: -1, exteriorPerp: -1 }), true, `${m} 外(負)から`);
    assert.equal(openingOpensTowardViewer(op(true, -1, 1), m, { viewerPerp: 1, exteriorPerp: -1 }), false, `${m} 内(負)から`);
  }
});

test('吊元を持たない窓: 内倒し（TILT）は室内側を見るなら手前', () => {
  assert.equal(openingOpensTowardViewer(op(false, -1, 1), M.TILT, { viewerPerp: -1, exteriorPerp: 1 }), true);
  assert.equal(openingOpensTowardViewer(op(false, -1, 1), M.TILT, { viewerPerp: 1, exteriorPerp: 1 }), false);
  assert.equal(openingOpensTowardViewer(op(false, -1, 1), M.TILT, { viewerPerp: 1, exteriorPerp: -1 }), true);
});

test('【失敗系】吊元を持たない窓で exteriorPerp が無い（間仕切り・未指定・不正値）は null', () => {
  for (const exteriorPerp of [null, undefined, 0, NaN, 2]) {
    assert.equal(openingOpensTowardViewer(op(true, -1, 1), M.PROJECT_OUT, { viewerPerp: 1, exteriorPerp }), null, String(exteriorPerp));
  }
  assert.equal(openingOpensTowardViewer(op(true, -1, 1), M.TILT, { viewerPerp: 1 }), null);
});

test('【失敗系】引き戸・FIX・回転・折れ戸などは null', () => {
  for (const m of [M.SLIDE_DOUBLE, M.SLIDE_SINGLE, M.SLIDE_LAYOUT, M.FIXED, M.PIVOT, M.PIVOT_H, M.FOLD, M.AWNING, M.HUNG, M.LOUVER, M.FRAME_ONLY]) {
    assert.equal(openingOpensTowardViewer(op(true, -1, 1), m, { viewerPerp: 1, exteriorPerp: 1 }), null, m);
  }
});

test('【失敗系】未知の機構・非有限・不正な入力は例外を投げず null', () => {
  assert.equal(openingOpensTowardViewer(op(true, -1, 1), 'unknown', { viewerPerp: 1, exteriorPerp: 1 }), null);
  assert.equal(openingOpensTowardViewer(op(true, -1, 1), undefined, { viewerPerp: 1 }), null);
  for (const viewerPerp of [NaN, 0, 2, undefined, null, Infinity]) {
    assert.equal(openingOpensTowardViewer(op(true, -1, 1), M.SWING, { viewerPerp }), null, String(viewerPerp));
  }
  assert.equal(openingOpensTowardViewer(op(true, NaN, 1), M.SWING, { viewerPerp: 1 }), null);
  assert.equal(openingOpensTowardViewer(op(true, -1, 0), M.SWING, { viewerPerp: 1 }), null);
  assert.equal(openingOpensTowardViewer(null, M.SWING, { viewerPerp: 1 }), null);
  assert.equal(openingOpensTowardViewer(op(true, -1, 1), M.SWING), null);
});

test('openingExteriorPerp: 吊元を持たない窓以外・graph 無し・ホスト壁無しは null（例外なし）', () => {
  const opening = { isVertical: true, axisCL: { id: 'a' }, wallSide: 1, centerCoord: 1500, coord1: 1100, coord2: 1900 };
  assert.equal(openingExteriorPerp(opening, M.SWING, { walls: [] }), null);
  assert.equal(openingExteriorPerp(opening, M.PROJECT_OUT, null), null);
  assert.equal(openingExteriorPerp(opening, M.PROJECT_OUT, { walls: [] }), null);
});

// 非対称な座標（開口 1100..1900・壁 800..2600）の最小 fake。壁は軸 CL の同一参照・axisOffset の符号で表裏を表す。
const axisCL = { id: 'a' };
const opening = { isVertical: true, axisCL, wallSide: -1, centerCoord: 1500, coord1: 1100, coord2: 1900 };
const wall = (axisOffset, isExteriorWall, faceDir) => ({
  isVertical: true, axisCL, axisOffset, coord1: 800, coord2: 2600, isExteriorWall, faceDir,
});

test('openingExteriorPerp: 外壁のホスト壁なら壁の faceDir', () => {
  assert.equal(openingExteriorPerp(opening, M.TILT_OUT, { walls: [wall(-57.5, true, -1)] }), -1);
  assert.equal(openingExteriorPerp(opening, M.TILT_OUT, { walls: [wall(-57.5, true, 1)] }), 1);
});

test('【失敗系】openingExteriorPerp: ホスト壁も相手側の壁も外壁でない（間仕切り）は null', () => {
  const walls = [wall(-57.5, false, -1), wall(57.5, false, 1)];
  assert.equal(openingExteriorPerp(opening, M.TILT_OUT, { walls }), null);
  assert.equal(openingExteriorPerp(opening, M.TILT_OUT, { walls: [wall(-57.5, false, 1)] }), null);
});

test('openingExteriorPerp: ホスト壁が室内向きで相手側の壁が外壁なら、相手側の faceDir（ホストの向きではない）', () => {
  const host = wall(-57.5, false, -1);
  assert.equal(openingExteriorPerp(opening, M.PROJECT_OUT, { walls: [host, wall(57.5, true, 1)] }), 1);
  assert.equal(openingExteriorPerp(opening, M.PROJECT_OUT, { walls: [host, wall(57.5, true, -1)] }), -1);
});
