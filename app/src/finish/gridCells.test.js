// グリッド索引（gridIndexOf）の等価性テスト。
// 読み取りスコープ（graphReadScope.js）でキャッシュしても、スコープ外の素の計算と
// **同じ結果**になることを固定する——高速化は挙動を変えないという不変条件そのもの。
// あわせて「スコープを抜けたらCL変更が反映される」（キャッシュが持ち越されない）も見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { withGraphReadScope } from '../graphReadScope.js';
import { worldToCell, getCellsInRect, getAllCells, refreshCells, cellBoundsFromKey, gridDividerSegments } from './gridCells.js';

// 3x3セルの格子（値0/1000/2000/3000。中央の縦CLだけextent制限してL字結合も踏ませる）
function makeGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const vs = [0, 1000, 2000, 3000].map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, {
    labeled: i === 0 || i === 3, discipline: i === 0 || i === 3 ? Discipline.STRUCT : Discipline.ARCH,
  }));
  const hs = [0, 1000, 2000, 3000].map((v, i) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, {
    labeled: i === 0 || i === 3, discipline: i === 0 || i === 3 ? Discipline.STRUCT : Discipline.ARCH,
  }));
  vs[1].setProps({ _extentLo: 0, _extentHi: 1000 }); // 上段だけを分割する短縮CL（L字領域を作る）
  return { graph, vs, hs };
}

const PROBES = [[500, 500], [1500, 500], [2500, 2500], [1500, 1500], [-100, 500], [500, 3500]];

test('gridCells: worldToCell はスコープの有無で同じ結果を返す', () => {
  const { graph } = makeGraph();
  const bare = PROBES.map(([x, y]) => worldToCell(x, y, graph));
  const scoped = withGraphReadScope(graph, () => PROBES.map(([x, y]) => worldToCell(x, y, graph)));
  assert.deepEqual(scoped, bare);
});

test('gridCells: getCellsInRect / getAllCells / gridDividerSegments はスコープの有無で同じ結果を返す', () => {
  const { graph } = makeGraph();
  const bare = {
    rect: getCellsInRect(0, 0, 3000, 3000, graph),
    all:  getAllCells(graph),
    segs: gridDividerSegments(graph),
  };
  const scoped = withGraphReadScope(graph, () => ({
    rect: getCellsInRect(0, 0, 3000, 3000, graph),
    all:  getAllCells(graph),
    segs: gridDividerSegments(graph),
  }));
  assert.deepEqual(scoped, bare);
});

test('gridCells: refreshCells / cellBoundsFromKey はスコープの有無で同じ結果を返す', () => {
  const { graph } = makeGraph();
  const cells = new Set(getAllCells(graph).map(c => c.key));
  const bare = [...refreshCells(cells, graph)].sort();
  const scoped = withGraphReadScope(graph, () => [...refreshCells(cells, graph)].sort());
  assert.deepEqual(scoped, bare);

  const key = [...cells][0];
  assert.deepEqual(withGraphReadScope(graph, () => cellBoundsFromKey(key, graph)), cellBoundsFromKey(key, graph));
});

test('gridCells: スコープを抜けた後のCL移動は次の呼び出しに反映される（キャッシュを持ち越さない）', () => {
  const { graph, vs } = makeGraph();
  const before = withGraphReadScope(graph, () => worldToCell(2500, 500, graph));
  assert.equal(before.x1, 2000);

  vs[2].value = 2400; // 2本目の分割CLを移動
  const after = withGraphReadScope(graph, () => worldToCell(2500, 500, graph));
  assert.equal(after.x1, 2400);
});
