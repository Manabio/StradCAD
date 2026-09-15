// centerLineOps.test.js と同じ方針: ダックタイピングでは undo/serializeGraph・structGraph 連携の
// 実挙動を再現できないため、実 core.js（Plane/PlanGraph/Project）と実 undoManager を使う。
// composition は「下階なし」（graphForCategory→null）のスタブで足りる範囲に限定し、IDB（floorSwapManager
// 経由の indexedDB アクセス）を要しないシナリオだけをここでは検証する（fixture方針は下記コメント参照）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import {
  recomputeStructuralComposition, reflectStructuralAfterFinishExit,
} from './structuralOrchestration.js';

// 下階なし（基礎伏図相当）composition スタブ。recomputeStructuralComposition は
// belowGraph=null のとき下階分岐（buildStructuralWallGate 等の非同期IDB経路）を一切通らない。
const noBelowComposition = { graphForCategory: () => null };

function makeSinglePlaneProject() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  return { project, graph };
}

// ---- recomputeStructuralComposition ----

test('recomputeStructuralComposition: mutateありならundoが1件積まれ、undoでstructureOverrideが戻る', async () => {
  const { project, graph } = makeSinglePlaneProject();
  const beforeTop = undoManager.peekUndo();

  await recomputeStructuralComposition(noBelowComposition, graph, project, {
    mutate: () => { graph.setStructureOverride('S造'); },
  });

  assert.equal(graph.structureOverride, 'S造');
  assert.notEqual(undoManager.peekUndo(), beforeTop, 'mutate指定時はchanged不問でundoが積まれる');

  undoManager.undo();
  assert.equal(graph.structureOverride, null, 'undoでstructureOverrideが戻る');
});

test('recomputeStructuralComposition: mutateなし・差分なし（同一入力2回目）ならundoを積まない', async () => {
  const { project, graph } = makeSinglePlaneProject();
  project.structuralInfo.mainStructure = 'S造';
  // 2x2グリッド（通り芯4本）を張り、wallGate=null（部屋未定義）フォールバックで交点に柱が
  // 自動生成される状況を作る——初回は生成でchanged:true、2回目は同一入力で冪等changed:falseになる
  // ことを確認する（idempotency）。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });

  await recomputeStructuralComposition(noBelowComposition, graph, project);
  assert.equal(graph.columns.length, 4, '初回は交点4箇所に柱が自動生成される');
  const afterFirst = undoManager.peekUndo();

  await recomputeStructuralComposition(noBelowComposition, graph, project);
  assert.equal(graph.columns.length, 4, '2回目は柱本数が変わらない（冪等）');
  assert.equal(undoManager.peekUndo(), afterFirst, '2回目は差分なしのためundoを積まない');
});

test('recomputeStructuralComposition: onToast未指定でも例外を投げない（optional callbackの失敗パス）', async () => {
  const { project, graph } = makeSinglePlaneProject();
  await assert.doesNotReject(
    recomputeStructuralComposition(noBelowComposition, graph, project, {
      mutate: () => { graph.setStructureOverride('S造'); },
    }),
  );
});

// ---- QA F4: 下階編集経路（主構造変更時等）は直前に立った下階の3b柱を撤去しない ----
test('recomputeStructuralComposition: 下階編集経路は直前に立った下階の3b柱を撤去しない（QA F4）', async () => {
  const project = new Project('proj-f4', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（belowGraph。3b柱の対象階）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階（subjectGraph）
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 1階: 3640×1820の実壁の部屋（4隅が3a交点）＋走行方向アンカー用の通り芯 x=1820（壁は無い）。
  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  const anchorX = g1.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

  // 1階に「直前のreflectStructuralToOtherFloorsで立った」3b柱を模した既存の自動柱を置く（1820,0）。
  const col3b = g1.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', anchorX, gy0, {});
  assert.equal(col3b.dimensionStatus, 'auto', '前提: 自動生成分（撤去対象になりうる）');

  // 2階: 自階柱(1820,0)——1階の3b柱にとっての「1つ上の実体階の柱」役（aboveColumnsForBelow）。
  const xm = g2.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  g2.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, y0, {});

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g1 }; // belowGraph=g1（下階編集経路を通す）
    await recomputeStructuralComposition(composition, g2, project, { mutate: () => {} });
    assert.ok(g1.columnMap.has(col3b.id), '1階の3b柱は下階編集経路の再計算で撤去されない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- reflectStructuralAfterFinishExit ----
// runStructuralModeSetup（syncRoofPlane→collectRoofPlaneGroupsが屋根専用平面をfloorSwapManager.peekし、
// indexedDBに到達する。fake-indexeddb等のIDBモックは本リポジトリの devDependencies に無く新規依存の追加は
// 本タスクの範囲外）は node:test 環境で indexedDB未定義のReferenceErrorになるため断念する（REASONED:
// node --import ./scripts/testSetup.mjs -e での事前検証で実際に indexedDB is not defined を確認済み）。
// reflectStructuralAfterFinishExit は idx===-1／最上階退出の2ケースに限りIDBを一切経由しないため対象にする。

test('reflectStructuralAfterFinishExit: 存在しないplaneId（idx===-1）＋goingToStructure=trueは何もせず例外なし・undo不変', async () => {
  const { project } = makeSinglePlaneProject();
  const beforeTop = undoManager.peekUndo();

  await reflectStructuralAfterFinishExit('does-not-exist', true, project);

  assert.equal(undoManager.peekUndo(), beforeTop, 'idx===-1かつgoingToStructure=trueは自階再計算も他階ループも通らない');
});

test('reflectStructuralAfterFinishExit: 最上階（唯一の実体階）からの退出は上階ループが回らず正常完了', async () => {
  const { project, graph } = makeSinglePlaneProject();

  await assert.doesNotReject(reflectStructuralAfterFinishExit(graph.plane.id, false, project));
});

// ---- 不変条件・ソース走査: 下階編集経路（主構造変更時等）が、上階柱直下の柱（ステップ3b）に
// 必要な aboveColumns（subjectGraph.columns。メモリ上・peek不要）と wallSegments（wallRunSegments）を
// autoFillColumnsForStructure(belowGraph, ...) へ渡していること。これを渡し忘れると、直前の
// reflectStructuralToOtherFloors が作った下階の3b柱が、この経路の再計算で候補から漏れて撤去される
// （woodAutoFill.test.jsの同種テストと同じ手法。fs.readFileSync+正規表現）。----
test('【不変条件・ソース走査】structuralOrchestration.js: 下階編集経路が autoFillColumnsForStructure に subjectGraph.columns と wallRunSegments(...) を渡している', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'structuralOrchestration.js'), 'utf8');
  assert.ok(/autoFillColumnsForStructure\(belowGraph, project, belowGate, aboveColumnsForBelow, belowWallSegments\)/.test(src),
    'autoFillColumnsForStructure(belowGraph, ...) へ aboveColumnsForBelow・belowWallSegments を渡していない');
  assert.ok(/aboveColumnsForBelow\s*=\s*subjectGraph\.columns/.test(src),
    'aboveColumnsForBelow が subjectGraph.columns（メモリ上）から来ていない（誤ってpeekしている可能性）');
  assert.ok(/belowWallSegments\s*=\s*wallRunSegments\(belowGraph, belowBelowGraph, belowStructure\)/.test(src),
    'belowWallSegments が wallRunSegments(belowGraph, belowBelowGraph, belowStructure) から来ていない');
});
