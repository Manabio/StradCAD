// wallBeamAxes.js selfWallSegments の「設計上の端」（designLo/designHi）: 階段の開口で切った端（端CLのままだが
// 実際の端が端CL上の相手の壁の材の外＝隅ではない）は実際の端、隅の端（相手の壁の材の中で終わる）・
// 相手の壁が無い端は従来どおり端CL。判定は core/wall.js isWallEndAtCorner（保存済みの座標だけで決まる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '../core.js';
import { selfWallSegments } from './wallBeamAxes.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };

// 下地オーナー壁（axisOffset=0・backingOffset=0・下地帯 120）を1本。軸CLは axisCL を渡す
function addWall(graph, { axisCL, isVertical, clStart, startOffset = 0, clEnd, endOffset = 0 }) {
  return graph.addWall(axisCL, 0, isVertical, clStart, startOffset, clEnd, endOffset, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
}

function fixture({ endOffset }) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, ARCH), x3 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH), y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, ARCH);
  // 水平壁 H（軸 y=1000, x 0..3000 の辺）。終端 endOffset を変えて、隅の端／開口で切った端にする
  addWall(graph, { axisCL: y1, isVertical: false, clStart: x0, clEnd: x3, endOffset });
  // 左右の垂直壁（軸 x=0 と x=3000）。H の両端CL上の相手の壁
  addWall(graph, { axisCL: x0, isVertical: true, clStart: y0, clEnd: y1 });
  addWall(graph, { axisCL: x3, isVertical: true, clStart: y0, clEnd: y1 });
  return graph;
}
const horizontal = (segs) => segs.find(s => !s.isVertical);

test('selfWallSegments: 隅の端（相手の壁の材の中で終わる）の設計上の端は端CL', () => {
  const seg = horizontal(selfWallSegments(fixture({ endOffset: 30 })));
  assert.equal(seg.designLo, 0);
  assert.equal(seg.designHi, 3000, '右端は x=3000 の垂直壁の材（軸±60）の中で終わる＝隅。設計上の端は端CL');
});

test('selfWallSegments: 開口で切った端（相手の壁の材の外で終わる）の設計上の端は実際の端', () => {
  const seg = horizontal(selfWallSegments(fixture({ endOffset: -1000 }))); // 実際の端は x=2000
  assert.equal(seg.hi, 2000, '前提: 物理の端は 2000');
  assert.equal(seg.designHi, 2000, '切った端の設計上の端は実際の端（端CL=3000 の向こうへ柱が出ない）');
  assert.equal(seg.designLo, 0, '隅の端は従来どおり端CL');
});

test('selfWallSegments: 端CL上に相手の壁が無い端は従来どおり端CL（隅かどうか判別できないので HEAD と同じ）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, ARCH), x3 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, ARCH);
  addWall(graph, { axisCL: y1, isVertical: false, clStart: x0, clEnd: x3, endOffset: -1000 });
  const seg = horizontal(selfWallSegments(graph));
  assert.equal(seg.designLo, 0);
  assert.equal(seg.designHi, 3000);
});
