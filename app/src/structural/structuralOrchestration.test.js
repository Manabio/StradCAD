// centerLineOps.test.js と同じ方針: ダックタイピングでは undo/serializeGraph・structGraph 連携の
// 実挙動を再現できないため、実 core.js（Plane/PlanGraph/Project）と実 undoManager を使う。
// composition は「下階なし」（graphForCategory→null）のスタブで足りる範囲に限定し、IDB（floorSwapManager
// 経由の indexedDB アクセス）を要しないシナリオだけをここでは検証する（fixture方針は下記コメント参照）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline } from '../core.js';
import { undoManager } from '../undoManager.js';
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
