// finish/wallRegeneration.js（regenerateWalls・loadMaterialMap）の一般契約テスト。
// 階段固有（2a）のシナリオは finish/stair/stairUnderWalls.test.js 側にある
// （regenerateWalls の冪等性・再脱出でのid保持）。ここは materialMap の有無だけに
// 着目した、階段を含まない最小構成のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { regenerateWalls, loadMaterialMap } from './wallRegeneration.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';

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

// ---- QA F4「発火条件は柱寸法W（woodColumnWidthMm）そのもの」の失敗系 ----
test('【QA失敗系3】regenerateWalls: 非在来（S造）はbandShiftが常に0——柱寸法という概念を持たないため壁のbandOffsetは1本もnull以外にならない', async () => {
  const graph = makeGraph();
  graph.structureOverride = 'S造';
  makeRoom(graph);
  const materialMap = await loadMaterialMap();

  const result = await regenerateWalls(graph, { materialMap });
  assert.equal(result.regenerated, true);
  assert.ok(graph.walls.length > 0, '前提: 壁が生成されている');
  // bandOffset（帯シフト量だけを保持する専用フィールド。core/wall.js Wall.bandOffset）は
  // bandShiftが発火したときだけ非nullになる——backingOffset自体は所有権解決（既存の挙動）で
  // 0を明示される壁もあるためbandOffsetの方で厳密に確認する。
  for (const w of graph.walls) {
    assert.equal(w.bandOffset, null, `S造はbandShift=0のためbandOffsetはnullのまま（壁${w.id}）`);
  }
});

test('【QA失敗系4】regenerateWalls: exteriorWallDimsが解決できない（下地材コードがmaterialMapに無い）場合も例外にならずbandShift=0（bandOffsetはnullのまま）', async () => {
  const graph = makeGraph();
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  graph.setWoodColumnWidthMm(105); // 在来木造・柱寸105（本来ならbandShift=7.5が発火する条件）
  graph.setExteriorWallBacking('NO-SUCH-MATERIAL-CODE'); // exteriorWallDimsをnullに落とす
  makeRoom(graph);
  const materialMap = await loadMaterialMap();

  const result = await regenerateWalls(graph, { materialMap });
  assert.equal(result.regenerated, true, '例外を投げず既定寸法（DEFAULT_WALL_BASE等）で壁を生成し続ける');
  assert.ok(graph.walls.length > 0, '前提: 壁が生成されている');
  for (const w of graph.walls) {
    assert.equal(w.bandOffset, null, 'exteriorWallDims不明時はbandShift=0のためbandOffsetはnullのまま');
  }
});

test('loadMaterialMap: 材コード→材のMapを返す（materials/materialData.js のMATERIALSと同じ件数）', async () => {
  const { MATERIALS } = await import('./materials/materialData.js');
  const map = await loadMaterialMap();
  assert.equal(map.size, MATERIALS.length);
  assert.equal(map.get(MATERIALS[0].code), MATERIALS[0]);
});

// ---- QA F8 test5: 柱寸105で長さ<1mmの縮退壁・逆転スパンの壁が無い ----
// moku2.stq実測で判明した「混在コーナー」（同じ部屋の南辺は建物外周でbandShift対象、
// 東辺は隣室との内部間仕切りでbandShift対象外というL字部屋）を最小構成で再現し、
// 所有権解決で生じうる7.5mmの極小オーナー断片（スタブ壁。QA裁定: 描画・展開・建具・柱への
// 実害なしとして別タスク扱い）以外に、長さ0や逆転スパン（coord1>coord2の異常な壁）が
// 混入しないことを確認する。
function addLShapedRoomPair(graph) {
  const ARCH = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL,   1800, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   3600, ARCH);
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL,   5400, ARCH);
  const yTop = graph.addCenterLine(CenterLineType.HORIZONTAL, -1000, ARCH);
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,     ARCH);
  const yBot = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000,  ARCH);

  // 部屋A（L字。moku2「子ども1」相当）: 上段は狭く(x:0-1800)、下段は広い(x:0-3600)。
  const cell1 = `${x0.id}:${yTop.id}:${xm.id}:${yMid.id}`;
  const cell2 = `${x0.id}:${yMid.id}:${xm.id}:${yBot.id}`;
  const cell3 = `${xm.id}:${yMid.id}:${x1.id}:${yBot.id}`;
  const roomA = graph.addRoom(new Set([cell1, cell2, cell3]), 'A');

  // 部屋B（moku2「主寝室」相当）: 部屋Aの下段の右（x1-x2, y:0-1000）に隣接——
  // 部屋Aの東辺（cell3のR=x1）はここだけ内部間仕切り（bandShift対象外）になる。
  const cellB = `${x1.id}:${yMid.id}:${x2.id}:${yBot.id}`;
  const roomB = graph.addRoom(new Set([cellB]), 'B');

  return { roomA, roomB };
}

test('【QA F8 test5】regenerateWalls: 柱寸105（L字部屋の混在コーナー構成）で長さ<1mmの縮退壁・逆転スパンの壁が無い', async () => {
  const graph = makeGraph();
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  graph.setWoodColumnWidthMm(105);
  addLShapedRoomPair(graph);

  const materialMap = await loadMaterialMap();
  const result = await regenerateWalls(graph, { materialMap, project: null, stairUnderEntries: [], extraStairOpenings: [] });
  assert.equal(result.regenerated, true);
  assert.ok(graph.walls.length > 0, '前提: 壁が生成されている');

  for (const w of graph.walls) {
    const len = w.coord2 - w.coord1; // 符号付き（逆転スパンなら負になる）
    assert.ok(len > 0, `壁(${w.id})のスパンが逆転・退化している（coord1=${w.coord1}, coord2=${w.coord2}）`);
    assert.ok(Math.abs(len) >= 1, `壁(${w.id})が長さ<1mmまで縮退している（length=${len}）`);
  }
});
