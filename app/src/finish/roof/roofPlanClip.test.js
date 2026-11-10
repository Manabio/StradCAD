// 屋根伏せ図の線を上の屋根の軒先線で止める純モジュール（finish/roof/roofPlanClip.js）のテスト。期待値は手計算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointInRings, pointInAnyRings, clipPolylineOutside, clipRoofLinesByCovers } from './roofPlanClip.js';

const TOL = 0.5;
/** 正方形 (0,0)-(100,100) の閉路 */
const SQ = [{ points: [0, 0, 100, 0, 100, 100, 0, 100] }];

test('pointInRings: 内側・外側・境界上（tol 以内は内側）', () => {
  assert.equal(pointInRings({ x: 50, y: 50 }, SQ, TOL), true);
  assert.equal(pointInRings({ x: 150, y: 50 }, SQ, TOL), false);
  assert.equal(pointInRings({ x: 100.3, y: 50 }, SQ, TOL), true, '辺から 0.3 ≤ 0.5 は内側');
  assert.equal(pointInRings({ x: 100.6, y: 50 }, SQ, TOL), false, '辺から 0.6 > 0.5 は外側');
  assert.equal(pointInRings({ x: 100, y: 100 }, SQ, TOL), true, '頂点上');
});

test('pointInRings: 複数閉路（穴なし）はどれかの内側なら内側', () => {
  const rings = [...SQ, { points: [200, 0, 300, 0, 300, 100, 200, 100] }];
  assert.equal(pointInRings({ x: 250, y: 50 }, rings, TOL), true);
  assert.equal(pointInRings({ x: 50, y: 50 }, rings, TOL), true);
  assert.equal(pointInRings({ x: 150, y: 50 }, rings, TOL), false, '2 つの閉路の間');
});

/** 正方形 (50,50)-(150,150)。SQ と (50..100)×(50..100) で重なる */
const SQ2 = [{ points: [50, 50, 150, 50, 150, 150, 50, 150] }];

test('pointInAnyRings: 組の和集合（重なる 2 つの正方形の両方の内側・片方だけの内側は内側、どちらでもなければ外側）', () => {
  assert.equal(pointInAnyRings({ x: 75, y: 75 }, [SQ, SQ2], TOL), true, '両方の内側（偶奇なら外側になってしまう点）');
  assert.equal(pointInAnyRings({ x: 25, y: 25 }, [SQ, SQ2], TOL), true, 'SQ だけ');
  assert.equal(pointInAnyRings({ x: 125, y: 125 }, [SQ, SQ2], TOL), true, 'SQ2 だけ');
  assert.equal(pointInAnyRings({ x: 125, y: 25 }, [SQ, SQ2], TOL), false);
  assert.equal(pointInAnyRings({ x: 0, y: 0 }, [], TOL), false);
});

test('clipPolylineOutside: 重なる 2 つの正方形の両方の内側の区間（x 50..100）も消える（偶奇で打ち消し合わない）', () => {
  assert.deepEqual(clipPolylineOutside([-50, 75, 200, 75], false, [SQ, SQ2], TOL), [
    { points: [-50, 75, 0, 75], closed: false },
    { points: [150, 75, 200, 75], closed: false },
  ]);
});

test('【失敗系】pointInRings: 閉路が空・点が足りない閉路は常に外側', () => {
  assert.equal(pointInRings({ x: 0, y: 0 }, [], TOL), false);
  assert.equal(pointInRings({ x: 0, y: 0 }, [{ points: [0, 0] }], TOL), false);
  assert.equal(pointInRings({ x: 0, y: 0 }, undefined, TOL), false);
});

test('clipPolylineOutside: 矩形を横切る線分は外側の 2 区間（x −50..0 と 100..150）', () => {
  assert.deepEqual(clipPolylineOutside([-50, 50, 150, 50], false, [SQ], TOL), [
    { points: [-50, 50, 0, 50], closed: false },
    { points: [100, 50, 150, 50], closed: false },
  ]);
});

test('clipPolylineOutside: 完全に内側なら []・完全に外なら入力のまま', () => {
  assert.deepEqual(clipPolylineOutside([10, 10, 90, 90], false, [SQ], TOL), []);
  assert.deepEqual(clipPolylineOutside([200, 200, 300, 300], false, [SQ], TOL), [{ points: [200, 200, 300, 300], closed: false }]);
  const closedOutside = [200, 200, 300, 200, 300, 300];
  assert.deepEqual(clipPolylineOutside(closedOutside, true, [SQ], TOL), [{ points: closedOutside, closed: true }], '切れなければ closed を保つ');
});

test('clipPolylineOutside: 外形線に重なる線分は隠れる側（[] ）。はみ出す共線は外の 2 区間だけ残る', () => {
  assert.deepEqual(clipPolylineOutside([0, 0, 100, 0], false, [SQ], TOL), []);
  assert.deepEqual(clipPolylineOutside([0.3, 0.3, 99.7, 0.3], false, [SQ], TOL), [], '0.3 のずれは境界上扱い');
  assert.deepEqual(clipPolylineOutside([-50, 0, 150, 0], false, [SQ], TOL), [
    { points: [-50, 0, 0, 0], closed: false },
    { points: [100, 0, 150, 0], closed: false },
  ]);
});

test('clipPolylineOutside: 閉じた折れ線が一部隠れると、残る区間は 1 本につながる（始点が隠れる側）', () => {
  // 矩形 (50,50)-(250,150)。左上の角が SQ の内側。(50,50)→(100,50) と (50,100)→(50,50) が隠れる
  assert.deepEqual(clipPolylineOutside([50, 50, 250, 50, 250, 150, 50, 150], true, [SQ], TOL), [
    { points: [100, 50, 250, 50, 250, 150, 50, 150, 50, 100], closed: false },
  ]);
});

test('clipPolylineOutside: 閉じた折れ線の始点をまたいで残る区間は 1 本につなぐ（始点が外側）', () => {
  // 矩形 (−50,50)-(150,150)。最後の辺 (150,50)→(−50,50) の x 0..100 だけが隠れる。始点 (−50,50) をまたいで [0,50]→[−50,50]→… が 1 本
  assert.deepEqual(clipPolylineOutside([-50, 50, -50, 150, 150, 150, 150, 50], true, [SQ], TOL), [
    { points: [0, 50, -50, 50, -50, 150, 150, 150, 150, 50, 100, 50], closed: false },
  ]);
});

test('clipPolylineOutside: 交点が閉路の頂点に一致する（角に触れて内側へ入る斜線は外の半分だけ）', () => {
  assert.deepEqual(clipPolylineOutside([-50, -50, 50, 50], false, [SQ], TOL), [{ points: [-50, -50, 0, 0], closed: false }]);
});

test('【失敗系】clipPolylineOutside: 閉路が空なら入力のまま・点が 1 つ以下でも壊れない', () => {
  assert.deepEqual(clipPolylineOutside([0, 0, 10, 10], false, [], TOL), [{ points: [0, 0, 10, 10], closed: false }]);
  assert.deepEqual(clipPolylineOutside([5, 5], false, [SQ], TOL), [{ points: [5, 5], closed: false }]);
});

test('clipRoofLinesByCovers: role を保ち、切れた線は closed:false の複数本。閉路が空なら同じ配列を返す', () => {
  const lines = [
    { role: 'outline', points: [-50, 50, 150, 50], closed: false },
    { role: 'ridge', points: [10, 10, 90, 90], closed: false },
    { role: 'hip', points: [200, 200, 300, 300], closed: false },
  ];
  assert.deepEqual(clipRoofLinesByCovers(lines, [SQ], TOL), [
    { role: 'outline', points: [-50, 50, 0, 50], closed: false },
    { role: 'outline', points: [100, 50, 150, 50], closed: false },
    { role: 'hip', points: [200, 200, 300, 300], closed: false },
  ]);
  assert.equal(clipRoofLinesByCovers(lines, [], TOL), lines);
});
