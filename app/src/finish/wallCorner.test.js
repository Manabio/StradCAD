// closeConvexCorners（finish/wallGeneration.js）の出隅取り合いテスト。
// 角を挟む2枚が別々の部屋の輪郭から生成されると、生成時のコーナーマップでは解決できず、
// 角の外側に壁厚ぶんの四角い欠けが残る（ユーザー実機指摘2026-08「21」のX2×Y2+3500の出隅）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { closeConvexCorners } from './wallGeneration.js';

function makeGraph() {
  return new PlanGraph(new Plane('p', 0, '1階', 1, 1));
}
const vCL = (g, v) => g.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
const hCL = (g, v) => g.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
// 部屋壁と同じ寸法（wallBase=90 / wallFinish=12.5 → axisOffset=±57.5）の壁を1本足す。
// props で下地オーナー壁（backingDepth=90）・仕上げ薄壁（backingDepth=0）も作り分ける。
const wall = (g, axisCL, axisOffset, isVertical, clS, offS, clE, offE, props = {}) =>
  g.addWall(axisCL, axisOffset, isVertical, clS, offS, clE, offE, { isRoomWall: true, wallFinish: 12.5, ...props });

test('【実機指摘】closeConvexCorners: 互いの軸CLで終端し合う2枚を相手の材の外面まで伸ばす', () => {
  const g = makeGraph();
  const x0 = vCL(g, 0), y0 = hCL(g, 0), xEnd = vCL(g, -6000), yEnd = hCL(g, -6000);
  // 出隅: 垂直壁はy=0のCLで、水平壁はx=0のCLでそれぞれ止まっている（別部屋の輪郭から生成）
  const v = wall(g, x0, 57.5, true, yEnd, 0, y0, 0);
  const h = wall(g, y0, 57.5, false, xEnd, 0, x0, 0);

  assert.equal(closeConvexCorners([v, h]), 2, '2本とも伸びるはず');
  assert.equal(v.coord2, 57.5, '垂直壁は水平壁の外面(y=+57.5)まで伸びるはず');
  assert.equal(h.coord2, 57.5, '水平壁は垂直壁の外面(x=+57.5)まで伸びるはず');
});

test('【失敗系】closeConvexCorners: 仕上げ面の向きが噛み合わない組（入隅側・逆向き）は伸ばさない', () => {
  const g = makeGraph();
  const x0 = vCL(g, 0), y0 = hCL(g, 0), xEnd = vCL(g, -6000), yEnd = hCL(g, -6000);
  // 水平壁の材が反対側（axisOffset=-57.5）を向いている＝この角に欠けは生じない
  const v = wall(g, x0, 57.5, true, yEnd, 0, y0, 0);
  const h = wall(g, y0, -57.5, false, xEnd, 0, x0, 0);

  assert.equal(closeConvexCorners([v, h]), 0, '伸ばす対象は無いはず');
  assert.equal(v.coord2, 0, '垂直壁の端は不変のはず');
});

test('【失敗系】closeConvexCorners: 分割された通し壁（T字）は角として扱わない', () => {
  const g = makeGraph();
  const x0 = vCL(g, 0), y0 = hCL(g, 0), xW = vCL(g, -6000), xE = vCL(g, 6000), yEnd = hCL(g, 6000);
  const v = wall(g, x0, 57.5, true, yEnd, 0, y0, 0);
  const h = wall(g, y0, 57.5, false, xW, 0, x0, 0);
  // 同じ面(axisValue=57.5)の壁がx=0の先へ隣接して続く＝通し壁がここで分割されているだけ
  wall(g, y0, 57.5, false, x0, 0, xE, 0);

  assert.equal(closeConvexCorners([...g.walls]), 0, 'T字は対象外のはず');
  assert.equal(v.coord2, 0, '垂直壁の端は不変のはず');
  assert.equal(h.coord2, 0, '水平壁の端は不変のはず');
});

test('【失敗系】closeConvexCorners: 相手の材が角のマスを埋めきっている組は伸ばさない', () => {
  // 実機2026-08「21」の2階 X3×(Y1-2000) の角。下地オーナー壁(v)が水平壁の材幅(12.5mm)を
  // 跨いで通り過ぎており、角のマスは v で埋まっている＝欠けはない。ここで薄壁(h)を v の
  // 外面(x=+57.5)まで伸ばすと、v の向こう側（隣室）へ仕上げ線が115mm突き出してしまう。
  const g = makeGraph();
  const x0 = vCL(g, 0), xW = vCL(g, -3000), yUp = hCL(g, -2000), yLow = hCL(g, 0);
  const v = wall(g, x0, 57.5, true, yUp, -57.5, yLow, 0, { backingOffset: 0, backingDepth: 90, finishSide: 1 });
  const h = wall(g, yUp, -57.5, false, xW, 0, x0, -57.5, { backingDepth: 0, finishSide: -1 });

  assert.equal(closeConvexCorners([v, h]), 0, '角のマスが埋まっている組は対象外のはず');
  assert.equal(h.coord2, -57.5, '薄壁の端は垂直壁の手前面のまま不変のはず');
  assert.equal(v.coord1, -2057.5, '垂直壁の端も不変のはず');
});

test('【失敗系】closeConvexCorners: 既に相手の外面へ届いている角（入隅の解決済み端）は何もしない', () => {
  const g = makeGraph();
  const x0 = vCL(g, 0), y0 = hCL(g, 0), xEnd = vCL(g, -6000), yEnd = hCL(g, -6000);
  const v = wall(g, x0, 57.5, true, yEnd, 0, y0, 57.5);
  const h = wall(g, y0, 57.5, false, xEnd, 0, x0, 57.5);

  assert.equal(closeConvexCorners([v, h]), 0, '冪等（2回目以降は何も変えない）はず');
  assert.equal(v.coord2, 57.5);
  assert.equal(h.coord2, 57.5);
});
