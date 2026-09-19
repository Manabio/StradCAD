// wallFreeEnds.js（腰壁・垂れ壁の端部材と構造柱が共有する自由端の判定述語）の単体テスト。
// woodAutoFill.test.js と同じく実 core.js（Plane/PlanGraph/Wall）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey } from '../core.js';
import { kneeDropWallAtFreeEnd, isKneeDropFreeEnd, selfWallFreeEnds } from './wallFreeEnds.js';
import { wallRunFreeEnds } from './woodFraming.js';
import { selfWallSegments } from './wallBeamAxes.js';

// woodAutoFill.test.js の addBackingWall と同じ（下地オーナー壁を1本追加。backingOffset=0＝
// 下地帯中心が axisValue）。
function addBackingWall(graph, { axisValue, clStart, clEnd, isVertical, bandOffset = null }) {
  const axisCL = graph.addCenterLine(
    isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL, axisValue, { labeled: false, discipline: Discipline.ARCH });
  return graph.addWall(axisCL, 0, isVertical, clStart, 0, clEnd, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5, bandOffset });
}

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}

test('kneeDropWallAtFreeEnd: 腰壁指定のある辺の自由端は壁とレコードを返す', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1000 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const wall = addBackingWall(graph, { axisValue: 1000, clStart: x0, clEnd: x1000, isVertical: false }); // y=1000, x:0..1000
  graph.setKneeDropWall(edgeKey(wall.axisCL.id, x0.id, x1000.id), { knee: { topHeight: 900 } });
  const fe = { isVertical: false, coord: 1000, along: 1000 }; // 右端(1000,1000)
  const hit = kneeDropWallAtFreeEnd(graph, fe);
  assert.equal(hit?.wall.id, wall.id);
  assert.deepEqual(hit?.rec, { knee: { topHeight: 900 } });
  assert.equal(isKneeDropFreeEnd(graph, fe), true);
});

test('【失敗系】kneeDropWallAtFreeEnd: 指定の無い自由端・該当壁が無い自由端は null', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1000 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(graph, { axisValue: 1000, clStart: x0, clEnd: x1000, isVertical: false }); // 指定なし
  const fe = { isVertical: false, coord: 1000, along: 1000 };
  assert.equal(kneeDropWallAtFreeEnd(graph, fe), null);
  assert.equal(isKneeDropFreeEnd(graph, fe), false);
  // 座標に一致する壁が無い自由端
  assert.equal(kneeDropWallAtFreeEnd(graph, { isVertical: true, coord: 9999, along: 9999 }), null);
});

// ==== 隅の取り合いぶんのはみ出し（隣区間からの小さな重なり）を「区間の壁」と誤認しない ====
// finish/kneeDropWall.test.js の「隅の取り合いぶんの重なりしかない壁スパンは拾わない」と同じ
// 考え方（kneeDropRecordForWallSpan の isConstituentWall＝SPAN_OVERLAP_EPS(150mm)未満の重なりは
// 構成壁と認めない）。腰壁・垂れ壁の端部材（structural/wallEndMember.js）が同じ関数を経由することの
// 確認——二重実装していれば通らないはずの回帰テスト。
test('【失敗系】kneeDropWallAtFreeEnd: 隣区間のレコードに57mmだけ重なる壁の自由端は拾わない', () => {
  const graph = makeGraph();
  // レコードは x:[0,1000] の区間（実在の壁は無くてよい。kneeDropRecordsOnAxisはCLのvalueだけを見る）。
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1000 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  graph.setKneeDropWall(edgeKey(yMid.id, x0.id, x1000.id), { knee: { topHeight: 900 } });
  // 壁B自身のスパンは[943,2000]——レコード[0,1000]との重なりは57mm（<SPAN_OVERLAP_EPS 150）だけ。
  const x943 = graph.addCenterLine(CenterLineType.VERTICAL, 943, { labeled: false, discipline: Discipline.ARCH });
  const x2000 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const wallB = addBackingWall(graph, { axisValue: 1000, clStart: x943, clEnd: x2000, isVertical: false });
  const fe = { isVertical: false, coord: 1000, along: wallB.coord1 }; // 壁B自身の低い側の端(943)
  assert.equal(wallB.coord1, 943, '前提: 壁Bの低い側の端は943（レコード[0,1000]へ57mmだけ食い込む）');
  assert.equal(kneeDropWallAtFreeEnd(graph, fe), null,
    '57mmの食い込みだけでは構成壁と認めない（kneeDropRecordForWallSpanのisConstituentWallと同じ判定）');
});

test('selfWallFreeEnds: 腰壁・垂れ壁の辺の自由端を除いた自由端を返す（wallRunFreeEndsとの差はisKneeDropFreeEndの分だけ）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1000 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const y1000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(graph, { axisValue: 0, clStart: y0, clEnd: y1000, isVertical: true }); // 縦壁 x=0（下端(0,0)が自由端・指定なし）
  const hWall = addBackingWall(graph, { axisValue: 1000, clStart: x0, clEnd: x1000, isVertical: false }); // 横壁 y=1000（右端(1000,1000)が自由端）
  graph.setKneeDropWall(edgeKey(hWall.axisCL.id, x0.id, x1000.id), { knee: { topHeight: 900 } });
  const segments = selfWallSegments(graph);
  const all = wallRunFreeEnds(segments);
  const self = selfWallFreeEnds(graph, segments);
  assert.deepEqual(all.map(fe => `${fe.x},${fe.y}`).sort(), ['0,0', '1000,1000']);
  assert.deepEqual(self.map(fe => `${fe.x},${fe.y}`).sort(), ['0,0'], '腰壁指定のある(1000,1000)は除かれる');
});
