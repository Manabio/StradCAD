// finish/wallRegeneration.js（regenerateWalls・loadMaterialMap）の一般契約テスト。
// 階段固有（2a）のシナリオは finish/stair/stairUnderWalls.test.js 側にある
// （regenerateWalls の冪等性・再脱出でのid保持）。ここは materialMap の有無だけに
// 着目した、階段を含まない最小構成のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { regenerateWalls, loadMaterialMap } from './wallRegeneration.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function makeRoom(graph, name = '部屋A') {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  return graph.addRoom(new Set([key]), name);
}

function wallDigest(graph) {
  return graph.walls
    .map(w => ({
      axisCLId: w.axisCL.id, axisOffset: w.axisOffset,
      startOffset: w.startOffset, endOffset: w.endOffset, backingDepth: w.backingDepth,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

test('regenerateWalls: materialMap無し（null）→ regenerated:false・undoFns/redoFns空・壁を一切生成しない', async () => {
  const graph = makeGraph();
  makeRoom(graph);
  const result = await regenerateWalls(graph, { materialMap: null });
  assert.deepEqual(result, { regenerated: false, undoFns: [], redoFns: [] });
  assert.deepEqual(graph.walls, []);
});

test('regenerateWalls: materialMap無し（undefined。opts省略）→ regenerated:false・undoFns/redoFns空', async () => {
  const graph = makeGraph();
  makeRoom(graph);
  const result = await regenerateWalls(graph, {});
  assert.deepEqual(result, { regenerated: false, undoFns: [], redoFns: [] });
});

test('【QA F2裁定】regenerateWalls: 既存壁がある状態でmaterialMap無しを渡しても既存壁を一切変更しない（壁ダイジェスト不変）', async () => {
  const graph = makeGraph();
  makeRoom(graph);
  const materialMap = await loadMaterialMap();

  const first = await regenerateWalls(graph, { materialMap });
  assert.equal(first.regenerated, true);
  const digestBefore = wallDigest(graph);
  assert.ok(digestBefore.length > 0, '前提: 1回目のmaterialMapありで壁が生成されている');

  const result = await regenerateWalls(graph, { materialMap: null });
  assert.equal(result.regenerated, false);
  assert.deepEqual(result.undoFns, []);
  assert.deepEqual(result.redoFns, []);
  assert.deepEqual(wallDigest(graph), digestBefore,
    '既存の実材厚壁を既定寸法で壊して作り直す旧挙動（QA F2）は採用しない——materialMap無しは壁に一切触らない');
});

test('loadMaterialMap: 材コード→材のMapを返す（materials/materialData.js のMATERIALSと同じ件数）', async () => {
  const { MATERIALS } = await import('./materials/materialData.js');
  const map = await loadMaterialMap();
  assert.equal(map.size, MATERIALS.length);
  assert.equal(map.get(MATERIALS[0].code), MATERIALS[0]);
});
