// 外付け引き戸の袖柱（問題2.md S9・Q-S9）: 袖柱は穴（J 込み cut）の両端に立つ（woodJambRef.outset）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '../core.js';
import { autoFillWoodColumns } from './woodAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { selfWallSegments, autoFillWallBeamAxes } from './wallBeamAxes.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { outsetSlideCutSpanOf } from '../core/slideOutsetGeometry.js';
import { outsetSlideLayout } from '../openings/slideOutset.js';
import { OpeningMechanism } from '../openings/openingCatalog.js';

const PROJECT = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
const COL_HALF = 60; // 柱寸 120 の半分
const CLEAR = 5; // 在来ルールの袖のクリアランス（jambClearanceMm）

// 横壁 y=2000（x:0..4000）に W1550 の建具 1 つ（中心 x=2000→coord1/2=1225/2775）。
function makeGraph({ subType = 'sliding', category = OpeningCategory.FITTING, hingeSide = -1, exterior = false, structGrid = true } = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const disc = structGrid ? Discipline.STRUCT : Discipline.ARCH;
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: structGrid, discipline: disc });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: structGrid, discipline: disc });
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, 0, false, x1, 0, x2, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  if (exterior) wall.isExteriorWall = true;
  const opening = graph.addOpening(wall.axisCL, 1, false, x1, 2000, 1550, category, subType, { swingSide: 1, hingeSide });
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  return { graph, wall, opening };
}
const jambsOf = graph => Object.fromEntries(graph.columns.filter(c => c.woodJambRef).map(c => [c.woodJambRef.side, c]));

test('core: outsetSlideCutSpanOf＝layout.cut（両 tailSide・式の 1 か所化）。W≤50 は null', () => {
  for (const tail of [-1, 1]) {
    const op = { coord1: 1000, coord2: 2550, hingeSide: tail, swingSide: 1, isVertical: false };
    assert.deepEqual(outsetSlideCutSpanOf(1000, 2550, tail), outsetSlideLayout(op, OpeningMechanism.SLIDE_SINGLE).cut);
  }
  assert.deepEqual(outsetSlideCutSpanOf(1000, 2550, -1), [1770, 2580]);
  assert.deepEqual(outsetSlideCutSpanOf(1000, 2550, 1), [970, 1780]);
  assert.equal(outsetSlideCutSpanOf(1000, 1050, -1), null);
  assert.equal(outsetSlideCutSpanOf(NaN, 1050, -1), null);
});

test('core/slideOutsetGeometry.js は constants.js だけを引く（openings/ 等を静的に引かない）', () => {
  const src = fs.readFileSync(new URL('../core/slideOutsetGeometry.js', import.meta.url), 'utf8');
  const froms = [...src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map(m => m[1]);
  assert.deepEqual(froms, ['./constants.js']);
});

test('袖柱（引き戸・hingeSide −1）: woodJambRef.outset が付き、AXIS は cut[1995,2805]の端±(5+柱寸/2)', () => {
  const { graph, opening } = makeGraph();
  autoFillWoodColumns(graph, PROJECT, null);
  const j = jambsOf(graph);
  assert.deepEqual(j[-1].woodJambRef, { openingId: opening.id, side: -1, isVertical: false, outset: true });
  assert.deepEqual(j[1].woodJambRef, { openingId: opening.id, side: 1, isVertical: false, outset: true });
  // W 1550→扉幅 800・穴 750。戸先端 A=hi=2775。cut=[2775−750−30, 2775+30]=[1995,2805]。
  assert.equal(j[-1].x, 1995 - CLEAR - COL_HALF, '1930（W 基準なら 1225−65＝1160）');
  assert.equal(j[1].x, 2805 + CLEAR + COL_HALF, '2870（W 基準なら 2775+65＝2840）');
  assert.equal(j[-1].y, 2000);
});

test('袖柱: hingeSide を反転すると同じ柱（id 不変）の AXIS が cut[1195,2005]基準へ入れ替わり、再計算も冪等', () => {
  const { graph, opening } = makeGraph({ hingeSide: -1 });
  autoFillWoodColumns(graph, PROJECT, null);
  const idsBefore = Object.values(jambsOf(graph)).map(c => c.id).sort();
  opening.setProps({ hingeSide: 1 });
  let j = jambsOf(graph);
  assert.equal(j[-1].x, 1195 - 65, '1130（A=lo=1225、cut=[1195,2005]）');
  assert.equal(j[1].x, 2005 + 65, '2070');
  const second = autoFillWoodColumns(graph, PROJECT, null);
  assert.equal(second.created.length, 0, '冪等（新規なし）');
  assert.deepEqual(second.removed, [], '冪等（撤去なし）');
  j = jambsOf(graph);
  assert.deepEqual(Object.values(j).map(c => c.id).sort(), idsBefore, '同じ柱');
  assert.equal(j[-1].x, 1130);
  const third = autoFillWoodColumns(graph, PROJECT, null);
  assert.equal(third.created.length + third.removed.length, 0);
});

test('袖柱: 他の建具（開き戸）は従来どおり W の両端基準で outset を持たない（deepEqual）', () => {
  const { graph, opening } = makeGraph({ subType: 'singleSwing' });
  autoFillWoodColumns(graph, PROJECT, null);
  const j = jambsOf(graph);
  assert.deepEqual(j[-1].woodJambRef, { openingId: opening.id, side: -1, isVertical: false });
  assert.equal(j[-1].x, 1225 - 65);
  assert.equal(j[1].x, 2775 + 65);
});

test('袖柱: 外壁ホストの引き戸（R12＝外付けにしない）は従来どおり W 基準で outset を持たない', () => {
  const { graph, opening } = makeGraph({ exterior: true });
  autoFillWoodColumns(graph, PROJECT, null);
  const j = jambsOf(graph);
  assert.deepEqual(j[-1].woodJambRef, { openingId: opening.id, side: -1, isVertical: false });
  assert.equal(j[-1].x, 1160);
  assert.equal(j[1].x, 2840);
});

test('【失敗系・後方互換】outset の無い旧 ref は引き戸でも W 基準のまま。次の自動補完で outset 付きへ後勝ち上書きされ穴基準になる', () => {
  const { graph, opening } = makeGraph();
  autoFillWoodColumns(graph, PROJECT, null);
  const col = jambsOf(graph)[-1];
  col.woodJambRef = { openingId: opening.id, side: -1, isVertical: false }; // 旧データ（outset 無し）
  assert.equal(col.x, 1160, '旧 ref は W 基準');
  autoFillWoodColumns(graph, PROJECT, null);
  const after = jambsOf(graph)[-1];
  assert.equal(after.woodJambRef.outset, true, '再計算で outset が付く');
  assert.equal(after.x, 1930);
});

test('【失敗系】outset 付き ref でも W≤50（cut が引けない）は AXIS を導出せず CL 位置へ戻る（NaN にしない）', () => {
  const { graph, opening } = makeGraph();
  autoFillWoodColumns(graph, PROJECT, null);
  const col = jambsOf(graph)[-1];
  opening.setProps({ width: 40 }); // coord1/2=1980/2020。W 基準なら 1980−65＝1915
  assert.ok(Number.isFinite(col.x), `x=${col.x}`);
  assert.notEqual(col.x, 1915, 'W 基準の値を返さない');
  assert.equal(col.x, col.verticalCL.effectiveValue, 'CL 位置へフォールバックする');
});

// 書き戻し（既存の袖柱の outset が今回の判定と食い違うとき参照ごと差し替え）。外壁化・建具種別の変更・手動柱。
function assertOutsetDropped(graph, mutate) {
  autoFillWoodColumns(graph, PROJECT, null);
  const ids = Object.values(jambsOf(graph)).map(c => c.id).sort();
  mutate();
  const first = autoFillWoodColumns(graph, PROJECT, null);
  assert.deepEqual([...first.originsUpdated].filter(id => ids.includes(id)).sort(), ids, '袖柱 2 本が originsUpdated に載る');
  assert.equal(first.created.length, 0);
  assert.equal(first.removed.length, 0);
  const j = jambsOf(graph);
  assert.equal(j[-1].woodJambRef.outset, undefined, 'outset が外れる');
  assert.equal(j[-1].x, 1160, 'W 基準へ戻る');
  assert.equal(j[1].x, 2840);
  const second = autoFillWoodColumns(graph, PROJECT, null);
  assert.equal(second.originsUpdated.length, 0, '2 回目は書き戻しなし（冪等）');
  assert.equal(second.created.length + second.removed.length, 0);
}

test('書き戻し T1: 外壁化すると outset が外れ W 基準へ戻り、originsUpdated に袖柱 2 本・created/removed 0、2 回目は全 0', () => {
  const { graph, wall } = makeGraph();
  assertOutsetDropped(graph, () => { wall.isExteriorWall = true; });
});

test('書き戻し T2: 建具種別を singleSwing に変えると outset が外れる（T1 と同形）', () => {
  const { graph, opening } = makeGraph();
  assertOutsetDropped(graph, () => opening.setProps({ subType: 'singleSwing' }));
});

test('書き戻し T4: 手動の柱（dimensionStatus manual）の woodJambRef は書き戻さない', () => {
  const { graph, opening } = makeGraph();
  autoFillWoodColumns(graph, PROJECT, null);
  const col = jambsOf(graph)[-1];
  col.setDimensionStatus('manual');
  const legacy = { openingId: opening.id, side: -1, isVertical: false };
  col.woodJambRef = legacy;
  const r = autoFillWoodColumns(graph, PROJECT, null);
  assert.deepEqual(col.woodJambRef, legacy, '値そのまま（outset を足さない）');
  assert.ok(!r.originsUpdated.includes(col.id));
});

test('woodJambRef.outset は serializeGraph→restoreGraph の往復で保持され、AXIS も復元後に穴基準', () => {
  const { graph, opening } = makeGraph({ structGrid: false });
  autoFillWoodColumns(graph, PROJECT, null);
  const restored = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  restoreGraph(restored, serializeGraph(graph));
  const j = jambsOf(restored);
  assert.deepEqual(j[-1].woodJambRef, { openingId: opening.id, side: -1, isVertical: false, outset: true });
  assert.equal(j[-1].x, 1930);
  assert.equal(j[1].x, 2870);
});
