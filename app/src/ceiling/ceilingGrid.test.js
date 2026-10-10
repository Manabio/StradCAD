// ceilingGrid.js（天井セル＝仕上げのセルを天井芯でさらに割った格子）の単体テスト。実物の PlanGraph / Room で組む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CenterLineType, Discipline } from '@core';
import { buildCellToRoom } from '../finish/edgeClassify.js';
import { getAllCells, refreshCells, CEILING_CELL_GRID } from '../finish/gridCells.js';
import { withGraphReadScope } from '../graphReadScope.js';
import { makeGrid } from '../plan/planTestFixtures.js';
import { ceilingRegionCellsAt, ceilingCellsWithin, ceilingRefreshCells, buildCeilingCellToRoom } from './ceilingGrid.js';

/** 縦の天井芯を value に足す（extent 未確定＝全高）。 */
function addCeilingV(graph, value, id = `cc${value}`) {
  return graph.addCenterLine(CenterLineType.VERTICAL, value, { labeled: false, discipline: Discipline.CEILING }, id);
}
const rectOf = c => `${c.x1},${c.y1},${c.x2},${c.y2}`;

test('天井芯なし: buildCeilingCellToRoom は buildCellToRoom と key も順序も一致する（部分指定の子の後勝ちを含む）', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const parent = g.interior([[0, 0], [1, 0], [2, 0]]);
  g.graph.addRoom(new Set([g.cell(1, 0)]), '子', 'child-1', new Set([parent.id]));
  const base = buildCellToRoom(g.graph);
  const ceiling = buildCeilingCellToRoom(g.graph);
  assert.ok(base.size >= 3, '前提: 比較対象が空でない');
  assert.deepEqual([...ceiling.keys()], [...base.keys()], 'key とその順序が一致');
  assert.deepEqual([...ceiling.values()].map(r => r.id), [...base.values()].map(r => r.id), '所属する部屋（後勝ち）も一致');
  assert.equal(ceiling.get(g.cell(1, 0)).id, 'child-1', '子のセルは子');
});

test('天井芯あり: 部屋のセルが天井芯の両側の2つに割れ、どちらも同じ部屋に属する。仕上げの buildCellToRoom は変わらない', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  const cc = addCeilingV(g.graph, 1000);
  const finish = buildCellToRoom(g.graph);
  assert.equal(finish.size, 2, '仕上げのセルは割れない（天井芯は仕上げの分割線ではない）');
  const ceiling = buildCeilingCellToRoom(g.graph);
  assert.equal(ceiling.size, 3);
  const nextToCeilingCL = [...ceiling.keys()].filter(k => k.includes(cc.id));
  assert.equal(nextToCeilingCL.length, 2, '天井芯を境界に持つ天井セルは左右の2つ');
  for (const r of ceiling.values()) assert.equal(r.id, room.id);
  // 右のセル(2000..4000)は仕上げのセルと同じ key のまま
  assert.ok(ceiling.has(g.cell(1, 0)));
});

test('ceilingCellsWithin: 矩形に掛かる天井セルを返す（仕上げの getCellsInRect と同じ展開）。反転した矩形（x1>x2）も min/max に正規化して展開する', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  addCeilingV(g.graph, 1000);
  const normal = ceilingCellsWithin({ x1: 0, y1: 0, x2: 2000, y2: 3000 }, g.graph).map(rectOf).sort();
  assert.deepEqual(normal, ['0,0,1000,3000', '1000,0,2000,3000']);
  const inverted = ceilingCellsWithin({ x1: 2000, y1: 3000, x2: 0, y2: 0 }, g.graph).map(rectOf).sort();
  assert.deepEqual(inverted, normal, '反転した矩形でも同じセル群');
});

test('天井芯ゼロで L字（短縮 CL）の併合セルを含む graph でも ceilingRefreshCells は refreshCells と key・順序とも一致する（案A）', () => {
  const g = makeGrid([0, 1000, 2000], [0, 1000, 2000]);
  g.cx[1].setProps({ _extentLo: 0, _extentHi: 1000 });
  g.cy[1].setProps({ _extentLo: 0, _extentHi: 1000 });
  // 名目 key（併合セルより小さい矩形）を含む入力
  const keys = new Set([g.cell(0, 0), g.cell(1, 0), g.cell(0, 1), g.cell(1, 1)]);
  const finish = [...refreshCells(keys, g.graph)];
  const ceiling = [...ceilingRefreshCells(keys, g.graph)];
  assert.ok(finish.length >= 3, '前提: 併合セルを含む');
  assert.deepEqual(ceiling, finish);
});

test('【失敗系】ceilingCellsWithin: null・非有限の矩形は空配列（例外にしない）', () => {
  const g = makeGrid([0, 2000], [0, 3000]);
  assert.deepEqual(ceilingCellsWithin(null, g.graph), []);
  assert.deepEqual(ceilingCellsWithin({ x1: NaN, y1: 0, x2: 1, y2: 1 }, g.graph), []);
  assert.deepEqual(ceilingCellsWithin({ x1: 0, y1: 0, x2: Infinity, y2: 1 }, g.graph), []);
  assert.deepEqual(ceilingCellsWithin({ x1: 0, y1: 0, x2: 0, y2: 3000 }, g.graph), [], '幅0');
});

test('ceilingRefreshCells: 仕上げの key は天井芯で割れたセル群へ、天井の key は同じセルへ展開する', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  g.interior([[0, 0], [1, 0]]);
  const cc = addCeilingV(g.graph, 1000);
  const finishKey = g.cell(0, 0);
  const expanded = ceilingRefreshCells(new Set([finishKey]), g.graph);
  assert.equal(expanded.size, 2);
  assert.ok([...expanded].every(k => k.includes(cc.id)));
  // 天井の key を再展開しても同じ（冪等）
  const again = ceilingRefreshCells(expanded, g.graph);
  assert.deepEqual([...again].sort(), [...expanded].sort());
  // 配列などの Iterable も受ける
  assert.deepEqual([...ceilingRefreshCells([finishKey], g.graph)].sort(), [...expanded].sort());
});

test('【失敗系】ceilingRefreshCells: 解けない key（CL 削除・存在しない id）は捨てる。天井芯を削除すると天井 key は解けず空（部屋の天井高へ戻る受容）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  g.interior([[0, 0], [1, 0]]);
  const cc = addCeilingV(g.graph, 1000);
  const [half] = ceilingRefreshCells(new Set([g.cell(0, 0)]), g.graph);
  assert.ok(half.includes(cc.id));
  const mixed = ceilingRefreshCells(new Set([half, 'no-such:y0:x1:y1', g.cell(1, 0)]), g.graph);
  assert.deepEqual([...mixed].sort(), [half, g.cell(1, 0)].sort(), '解けない key だけ捨てる');
  g.graph.removeCenterLine(cc.id);
  assert.equal(ceilingRefreshCells(new Set([half]), g.graph).size, 0, '天井芯を削除すると天井 key は解けない');
  assert.deepEqual([...ceilingRefreshCells(new Set(), g.graph)], []);
});

test('ceilingRefreshCells: 読み取りスコープ内では同じ Set に対する結果を使い回す（同一オブジェクト）。スコープ外は毎回計算（結果は等価）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  addCeilingV(g.graph, 1000);
  const keys = new Set([g.cell(0, 0)]);
  withGraphReadScope(g.graph, () => {
    assert.equal(ceilingRefreshCells(keys, g.graph), ceilingRefreshCells(keys, g.graph));
  });
  assert.deepEqual([...ceilingRefreshCells(keys, g.graph)].sort(), [...ceilingRefreshCells(keys, g.graph)].sort());
});

test('ceilingRegionCellsAt: 天井芯で領域が分かれる（仕上げの領域は1セル）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  addCeilingV(g.graph, 1000);
  assert.deepEqual(ceilingRegionCellsAt(500, 1500, g.graph).map(rectOf), ['0,0,1000,3000']);
  assert.deepEqual(ceilingRegionCellsAt(1500, 1500, g.graph).map(rectOf), ['1000,0,2000,3000']);
  // 天井の全セル数は仕上げ(2) + 割れた分(1) = 3
  assert.equal(getAllCells(g.graph, CEILING_CELL_GRID).length, 3);
  assert.equal(getAllCells(g.graph).length, 2);
});
