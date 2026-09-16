// centerLineOps.test.js と同じ方針: ダックタイピングでは undo/serializeGraph・structGraph 連携の
// 実挙動を再現できないため、実 core.js（Plane/PlanGraph/Project）と実 undoManager を使う。
// composition は「下階なし」（graphForCategory→null）のスタブで足りる範囲に限定し、IDB（floorSwapManager
// 経由の indexedDB アクセス）を要しないシナリオだけをここでは検証する（fixture方針は下記コメント参照）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Project, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { TRADITIONAL_WOOD_STRUCTURE, rulesFor } from './structureRules.js';
import { collectFloorGroups, totalCountOf, renumberMembers } from './memberNumbering.js';
import { memberGroupKey } from './memberCatalog.js';
import { syncRoofPlane } from './roofPlane.js';
import {
  recomputeStructuralComposition, reflectStructuralAfterFinishExit, columnSetSignature,
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

// ---- 実機裁定ステップ4 C-2 QA2: 「各階柱寸法」欄（下階graphのwoodColumnWidthMm）は
// WoodColumnWidthSelectのonStructureChanged経由でrecomputeStructuralCompositionへ乗る。
// mutateが下階（belowGraph）自身を書き換えるケース——柱グループのgraphは伏図慣習で「1つ下の実体階」
// のため、この欄の変更は必ずbelowGraphを書き換える（.claude/structural-model.md参照）。 ----
test('recomputeStructuralComposition【実機裁定ステップ4 C-2 QA2】: 下階の「各階柱寸法」を変えると下階柱・自階梁（下階柱寸参照）の断面が追従し、undoで断面・柱寸・部材番号のすべてが元に戻る', async () => {
  const project = new Project('proj-c2-qa2', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（belowGraph。柱グループの編集対象）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階（subjectGraph。梁は下階柱寸を参照）
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 通り芯（全階共通）は project.structGraph に置く——階固有graphへ直接addCenterLineすると、
  // 通り芯はserializeGraphの階スナップショットから除外される（buildSnapshot: isStructCLは
  // serializeStructCLs側でだけ復元する前提）ため、undo（restoreGraph）で消えてしまう
  // （graphSnapshot.test.jsの「通り芯復元前にrestoreGraphすると壁が無音で失われる」と同種の落とし穴）。
  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  // 1階: 柱1本（既定120角のまま）。
  const col1F = g1.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x0, y0, {});

  // 2階: 梁1本（成240。材幅は「梁を支える1つ下の実体階＝1階」の柱寸を参照する対象）。
  const beam2F = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x240', y0, false, x0, x1, { role: 'primary' });
  // 成の自動更新（autoFillWoodBeamDepths、ステップ3d）を対象外にし、材幅だけの追従
  // （conformWoodSections。dimensionStatusに関わらず書き換える）を単独で確認する。
  beam2F.setDimensionStatus('locked');

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g1 }; // 柱グループの欄が編集する graph（下階=1階）
    const col1FNoBefore = col1F.memberNo;
    const beam2FNoBefore = beam2F.memberNo;
    const undoBefore = undoManager.peekUndo();

    // WoodColumnWidthSelect.handleChange と同じ形の mutate（belowGraph自身を書き換える）。
    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => { g1.setWoodColumnWidthMm(105); },
    });

    assert.equal(g1.woodColumnWidthMm, 105);
    assert.equal(col1F.sectionDefId, 'WOOD-105x105', '1階柱は105角へそろう（自階の値）');
    assert.equal(beam2F.sectionDefId, 'WOOD-105x240', '2階梁は成240を保ったまま材幅だけ105へ（下階=1階の柱寸を参照。beamColumnWidthMm）');
    assert.notEqual(undoManager.peekUndo(), undoBefore, 'undoエントリが1件積まれる');

    undoManager.undo();
    // restoreGraph は clear()→再構築のため、undo後は id で引き直す（保持していた古いJS参照は
    // 置き換え前の実体を指したままになる。structuralOrchestration.test.js の既存パターン
    // ＝QA F4テストの g1.columnMap.has(col3b.id) と同じ規律）。
    const col1FAfterUndo = g1.columnMap.get(col1F.id);
    const beam2FAfterUndo = g2.beamMap.get(beam2F.id);
    assert.equal(g1.woodColumnWidthMm, null, 'undoで各階柱寸法（下階graphのwoodColumnWidthMm）が戻る');
    assert.equal(col1FAfterUndo.sectionDefId, 'WOOD-120x120', 'undoで1階柱の断面が戻る');
    assert.equal(beam2FAfterUndo.sectionDefId, 'WOOD-120x240', 'undoで2階梁の断面が戻る');
    // 実機観測: 柱寸変更後にundoしても1階の柱番号（グループ表記）が変更前に戻っていなかった
    // （belowGraphのbeforeスナップショットをmutate実行後に取っていたバグ。再発防止）。
    assert.equal(col1FAfterUndo.memberNo, col1FNoBefore, 'undoで1階柱の部材番号も変更前に戻る');
    assert.equal(beam2FAfterUndo.memberNo, beam2FNoBefore, 'undoで2階梁の部材番号も変更前に戻る');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('【失敗系・実機裁定ステップ4 C-2 QA2】recomputeStructuralComposition: 下階が無い（基礎伏図相当）場合は自階の値へフォールバックし梁幅が追従する', async () => {
  const project = new Project('proj-c2-qa2-nobelow', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  const beam1F = g1.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x240', y0, false, x0, x1, { role: 'primary' });
  beam1F.setDimensionStatus('locked'); // 材幅だけの追従を単独で確認する（成の自動更新3dは対象外にする）

  await recomputeStructuralComposition(noBelowComposition, g1, project, {
    mutate: () => { g1.setWoodColumnWidthMm(105); },
  });

  assert.equal(beam1F.sectionDefId, 'WOOD-105x240', '下階が無ければ自階の値へフォールバックする（beamColumnWidthMmの規約）');
});

// ---- 実機再確認（moku1・2階伏図）QA3: undo/redoでentity.memberNoはrestoreGraphで戻るが、
// 建物全体の採番索引（project.memberNumberIndex。非永続キャッシュ）は作り直されないため、
// 構造リストのバッジ表示（floorSpanLabel/totalCountOf。例「1~3F・計106本」）が復元後の実体と
// 食い違って残る（実機観測: undo後に柱グループのバッジが変更前に戻らない・梁グループのバッジが消える）----
test('recomputeStructuralComposition【実機裁定ステップ4 C-2 QA3】: undoで採番索引（floorRanks・counts）が変更前と一致し、redoで変更後と一致する', async () => {
  const project = new Project('proj-c2-qa3', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（belowGraph）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階（subjectGraph）
  const { graph: g3 } = project.addPlane(6000, '3階', 'p3'); // composition対象外（undoで一切触れない階）
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g3.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  project.activePlaneId = 'p2';

  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });

  // 1〜3階すべてに同じ「WOOD-120x120」柱グループへ寄与する柱を置く（建物全体スパン表記
  // "1~3F"の再現に3階分が要る。3階はcompositionのbelowGraphではない＝undoで一切restoreGraphされない）。
  const col1F = g1.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x0, y0, {});
  g2.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x0, y1, {});
  g3.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x0, y0, {});

  // モード境界の反映パス（reflectStructuralToOtherFloors）が構造モード突入時に必ず先に建物全体を
  // 収集済み、という前提を再現する（ここでは直接collectFloorGroupsで模す。3階は今回のundo/redoで
  // 一切触れない階として、その寄与が索引に残ったまま試験する）。
  runInAction(() => {
    collectFloorGroups(g1, project);
    collectFloorGroups(g2, project);
    collectFloorGroups(g3, project);
  });
  const groupKey = memberGroupKey(col1F, 'columnMap', rulesFor(TRADITIONAL_WOOD_STRUCTURE));
  const groupBefore = project.memberNumberIndex.get(groupKey);
  assert.ok(groupBefore, '前提: 1階柱が属する柱グループが索引に存在する');
  const floorRanksBefore = [...groupBefore.floorRanks].sort();
  const countBefore = totalCountOf(groupBefore);
  assert.deepEqual(floorRanksBefore, [0, 1, 2], '前提: 1〜3階すべてが同じ柱グループに寄与している（"1~3F"相当）');
  assert.equal(countBefore, 3);

  const peekMap = { p1: g1, p2: g2, p3: g3 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g1 };
    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => { g1.setWoodColumnWidthMm(105); },
    });

    // 変更直後: 1階の柱が別グループ（105×105）へ移るため、「120×120」グループは2〜3階だけに縮む
    // （実機観測どおり "1~3F・計106本" → "2~3F・計72本" 相当の変化）。
    const groupDuring = project.memberNumberIndex.get(groupKey);
    assert.deepEqual([...groupDuring.floorRanks].sort(), [1, 2], '前提: 変更直後は1階が抜けて2~3階だけになる');
    assert.equal(totalCountOf(groupDuring), 2);

    undoManager.undo();
    const groupAfterUndo = project.memberNumberIndex.get(groupKey);
    assert.ok(groupAfterUndo, 'undo後に「120×120」柱グループの索引エントリが存在する（実機観測: 梁グループのバッジが消えた不具合の回帰防止）');
    assert.deepEqual([...groupAfterUndo.floorRanks].sort(), floorRanksBefore, 'undoで索引のfloorRanksが変更前と一致する（バッジ表示の食い違いの回帰防止）');
    assert.equal(totalCountOf(groupAfterUndo), countBefore, 'undoで索引のcountsが変更前と一致する');

    undoManager.redo();
    const groupAfterRedo = project.memberNumberIndex.get(groupKey);
    assert.deepEqual([...groupAfterRedo.floorRanks].sort(), [1, 2], 'redoで索引のfloorRanksが変更後と一致する');
    assert.equal(totalCountOf(groupAfterRedo), 2, 'redoで索引のcountsが変更後と一致する');
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

// ---- 実機再QA指摘1: 標準材の解決が採番パイプライン（collect/apply）とUI同期経路（renumberMembers・
// MemberListTab.jsx・transform/centerLineOps.js）で二系統に分かれ、下階の柱寸変更後に
// renumberMembers を呼ぶとタグが分裂する実測バグ（105×120の梁が2G18のまま留まらず2G18〜2G26に分裂）。
// 派生値方式（graph.beamColumnWidthMm）採用後は renumberMembers もこの派生値を読むだけになり、
// 分裂しないことを確認する。----
test('renumberMembers【実機裁定ステップ4 C-2 QA4】: 構造リストの編集（renumberMembers）は下階基準の標準材（graph.beamColumnWidthMm）を保つ——105×120の2本が同一タグのまま分裂しない', async () => {
  const project = new Project('proj-c2-qa4', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（各階柱寸法の編集対象）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階（構造リストを編集する階）
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  project.activePlaneId = 'p2';

  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: true, discipline: Discipline.STRUCT });

  // 2階: 105×120（標準材＝柱寸105×梁成表の最小成120）×2 本＋105×330（非標準＝個別採番対象）×1本。
  // 成の自動更新（ステップ3d）を対象外にして材幅の分類だけを確認する。
  const beamStdA = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x120', y0, false, x0, x1, { role: 'primary' });
  const beamStdB = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x120', y1, false, x0, x1, { role: 'primary' });
  const beamNonStd = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x330', y2, false, x0, x1, { role: 'primary' });
  for (const b of [beamStdA, beamStdB, beamNonStd]) b.setDimensionStatus('locked');

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g1 }; // 「各階柱寸法」欄が編集するgraph（下階=1階）
    // 突入時相当の再計算: 1階の柱寸を105にした状態で2階を再計算し、graph.beamColumnWidthMm
    // （下階=1階基準の派生値）を2階へキャッシュさせる。
    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => { g1.setWoodColumnWidthMm(105); },
    });
    assert.equal(g2.beamColumnWidthMm, 105, '前提: 2階の派生値（下階=1階の柱寸）が105になっている');
    assert.equal(beamStdA.memberNo, beamStdB.memberNo, '前提: 105×120の2本は同一タグ（標準材として1グループ）');
    assert.notEqual(beamStdA.memberNo, beamNonStd.memberNo, '前提: 105×330は個別採番対象で別タグ');

    // 「構造リストの編集」相当（分割・統合・手動タグ解除・部材追加/削除はいずれもrenumberMembersを呼ぶ）。
    runInAction(() => renumberMembers(g2, project, 'beamMap'));

    assert.equal(beamStdA.memberNo, beamStdB.memberNo,
      'renumberMembers後も105×120の2本は同一タグのまま分裂しない（実機観測: 2G18が2G18〜2G26に分裂したバグの回帰防止）');
    assert.notEqual(beamStdA.memberNo, beamNonStd.memberNo, '105×330（個別採番対象）は引き続き標準材の2本とは別タグ');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 実機再QA指摘2→再QA指摘4: 建物全体の非アクティブ階を同時にメモリ上へ展開し続ける実装
// （collectで得たtempをそのままapplyまで保持）は同時展開の階数が増えるため撤回した——保持するのは
// collectフェーズで求めた beamColumnWidthMm（数値のみ）だけにし、applyMemberNumbersToFloor は
// 従来どおり都度fresh peekし直してから、保存しておいた数値を書き戻してapplyNumbersを呼ぶ
// （collect時点の標準材判定をapply側でも再現する）。----
test('【不変条件・実機再QA指摘4】structuralOrchestration.js: applyMemberNumbersToFloor は都度peekし、保存された beamColumnWidthMm 数値を書き戻してから applyNumbers を呼ぶ（tempインスタンスを跨いで保持しない）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = stripComments(fs.readFileSync(path.join(here, 'structuralOrchestration.js'), 'utf8'));
  const fnMatch = /async function applyMemberNumbersToFloor\(plane, tags, project, beamColumnWidthMmValue\) \{([\s\S]*?)\r?\n\}/.exec(src);
  assert.ok(fnMatch, 'applyMemberNumbersToFloor(plane, tags, project, beamColumnWidthMmValue)（数値を引数で受け取る宣言）が見つからない');
  const body = fnMatch[1];
  assert.ok(/floorSwapManager\.peek\(/.test(body), 'applyMemberNumbersToFloor が fresh peek していない（tempインスタンスを跨いで保持する実装に戻っている）');
  assert.ok(/setBeamColumnWidthMm\(beamColumnWidthMmValue\)/.test(body), 'applyMemberNumbersToFloor が保存済みの beamColumnWidthMm 数値を書き戻していない（standardBeamSectionFor の判定がcollect時点と食い違う。コメントアウトされている可能性）');
  // 呼び出し側（reflectStructuralToOtherFloors/reflectStructuralAfterFinishExit）が temp インスタンス自体
  // ではなく temp.beamColumnWidthMm（数値）だけを保持していること（同時展開を1階分に戻す配線側の固定）。
  assert.ok(/beamColumnWidthByPlaneId\.set\(plane\.id, temp\.beamColumnWidthMm\)/.test(src),
    'reflectStructuralToOtherFloorsがtempインスタンス自体を保持している（beamColumnWidthMm数値だけを保持する規律に反する）');
  assert.ok(/touched\.push\(\{ plane: planes\[i\], beamColumnWidthMm: temp\.beamColumnWidthMm \}\)/.test(src),
    'reflectStructuralAfterFinishExitがtempインスタンス自体を保持している（beamColumnWidthMm数値だけを保持する規律に反する）');
});

// ---- 実機再QA指摘3: mutate指定時、自階（subjectGraph）自身の再計算が内部で行う下階へのfresh peek
// （floorSwapManagerは毎回IDBから読む）が、mutateで書き換えた下階の編集可能peekのデバウンス保存
// （最大400ms）未反映のまま古い値を読んでしまう競合を、flushEditablePeek()で解消している。
// 自階再計算（recomputeStructuralForGraphの呼び出し＝下階へのfresh peekを含む）より前に
// ちょうど1回awaitされることをスパイで固定する。
// 【前提】このfixtureは壁が無く下階柱集合が変化しない（3a/3b候補が生成されない）——
// columnSetSignatureによる自階再実行（QA3-1〜QA3-6節）は発火しないため、flushは常に1回のまま
// （mutate経路の既存flushのみ）。下階柱集合が変化する場合の2回呼び出しは下の
// 【QA3-6】テストが別に固定する。----
test('recomputeStructuralComposition【実機裁定ステップ4 C-2 QA3】: mutate指定時はflushEditablePeekを自階再計算（下階へのfresh peekを含む）より前に1回awaitする', async () => {
  const project = new Project('proj-c2-qa3-flush', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  const calls = [];
  const originalFlush = floorSwapManager.flushEditablePeek;
  const originalPeek = floorSwapManager.peek;
  const peekMap = { p1: g1, p2: g2 };
  floorSwapManager.flushEditablePeek = () => { calls.push('flush'); return Promise.resolve(); };
  floorSwapManager.peek = async (plane) => { calls.push(`peek:${plane.id}`); return peekMap[plane.id] ?? null; };
  try {
    const composition = { graphForCategory: () => g1 };
    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => { g1.setWoodColumnWidthMm(105); },
    });
    assert.equal(calls.filter(c => c === 'flush').length, 1, 'flushEditablePeekがちょうど1回呼ばれる');
    assert.equal(calls[0], 'flush', 'flushEditablePeekが最初（下階へのfresh peekより前）に呼ばれる');
    assert.ok(calls.slice(1).some(c => c.startsWith('peek:')), '前提: flush後に少なくとも1回はpeekが呼ばれる（自階再計算の下階peek）');
  } finally {
    floorSwapManager.flushEditablePeek = originalFlush;
    floorSwapManager.peek = originalPeek;
  }
});

// ---- QA3-6: mutate（各階柱寸法の変更）と下階柱集合の変化（3a柱の新規生成）が同じ呼び出しの中で
// 同時に起きる組合せ。flushEditablePeekはmutate経路（既存・73行目付近）で1回、下階柱集合変化による
// 自階の再実行（151行目付近）でもう1回の計2回呼ばれる。undoでは下階柱寸法・下階の新規柱・自階の
// 分割された梁のすべてが変更前へ戻ることを確認する（afterスナップショットが2回目の再計算より
// 後で取られていることの間接確認——afterを2回目の前に取っていれば分割前の状態がredoされ、
// このアサーションが失敗する）。----
test('recomputeStructuralComposition【QA3-6】: mutateと下階柱集合の変化が同時に起きても自階が再計算され直り、undoで両方とも変更前に戻る（flushEditablePeekは2回）', async () => {
  const project = new Project('proj-mutate-and-resplit', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（mutateの編集対象＝3a柱も新規に立つ）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 通り芯は project.structGraph に置く（undo対象——階固有graphへ直接追加するとrestoreGraphで消える。
  // QA C2 QA2/QA3テストと同じ規律）。
  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

  // 1階: 3640×1820の実壁の部屋。柱はまだ1本も無い——この呼び出しの下階編集ブロックで3a柱4本が
  // 新規に立ち、下階柱集合（g1.columns）が変化する条件を作る。
  const room = g1.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  const originalFlush = floorSwapManager.flushEditablePeek;
  const calls = [];
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  floorSwapManager.flushEditablePeek = () => { calls.push('flush'); return Promise.resolve(); };
  try {
    const composition = { graphForCategory: () => g1 };
    const undoBefore = undoManager.peekUndo();

    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => { g1.setWoodColumnWidthMm(105); },
    });

    assert.equal(calls.length, 2, 'flushEditablePeekはmutate経路（1回目）と下階柱集合変化による自階再実行（2回目）で計2回呼ばれる');
    assert.ok(g1.columns.length > 0, '前提: 下階に3a柱が新規に立ち、下階柱集合が変化した');
    assert.notEqual(undoManager.peekUndo(), undoBefore, 'undoエントリが1件積まれる');

    undoManager.undo();
    assert.equal(g1.woodColumnWidthMm, null, 'undoで各階柱寸法（下階のmutate）が変更前に戻る');
    assert.equal(g1.columns.length, 0, 'undoで下階に新規に立った3a柱も消える（壁があるだけ・柱ゼロの元の状態へ）');
  } finally {
    floorSwapManager.peek = originalPeek;
    floorSwapManager.flushEditablePeek = originalFlush;
  }
});

// ---- QA3-1: 屋根専用平面の「下階」不一致（2026-09-17指摘）。composition の belowGraph
// （drawingDesignation.js structuralPlaneBelow。屋根なら最上階を返す）と、
// recomputeStructuralForGraph が自前peekする belowGraph（wallBeamAxes.js belowPlaneOf。
// 屋根専用平面はproject.planesに含まれないため常にnull）は別概念——屋根では一致しない。
// 一致しないまま2回目にprecomputedBelowGraph（最上階）を渡すと、1回目（belowGraph=null＝
// 屋根自身の柱寸へフォールバック）と2回目（belowGraph=最上階）とでbeamColumnWidthMmが食い違い、
// 屋根伏図の軒桁材幅が最上階の柱寸へ静かに置き換わる。「屋根専用平面は再実行しない」ガードで
// 固定する。----
test('recomputeStructuralComposition【QA3-1・屋根専用平面】: 最上階の柱寸(105)と屋根自身の柱寸(120)が異なっても、下階(=最上階)柱集合の変化で自階(屋根)を再計算し直さない（軒桁材幅は屋根自身の120のまま）', async () => {
  const project = new Project('proj-roof-below-mismatch', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 最上階
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.setWoodColumnWidthMm(105); // 最上階の柱寸

  const roofPlane = syncRoofPlane(project);
  const roofGraph = project.graphMap.get(roofPlane.id);
  assert.ok(roofGraph.plane.isRoofPlane, '前提: 屋根専用平面が生成されている');
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  roofGraph.setWoodColumnWidthMm(120); // 屋根自身の柱寸（下階が無いときのフォールバック値）

  // 通り芯は project.structGraph（全階共通）に置く。
  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

  // 2階（最上階＝屋根伏図からみた「柱の供給元」）に壁の部屋を新規に置く——この呼び出しの下階編集
  // ブロックで3a柱が新規に立ち、下階柱集合（g2.columns）が変化する条件を作る。
  const room = g2.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(g2, room);

  // 屋根伏図の軒桁（role:'eaves'）。材幅は屋根自身の柱寸（120）にそろうはず。
  const eavesBeam = roofGraph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x240', y0, false, x0, x1, { role: 'eaves' });

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g2 }; // structuralPlaneBelow: 屋根→最上階
    await recomputeStructuralComposition(composition, roofGraph, project, {});

    assert.ok(g2.columns.length > 0, '前提: 下階(=最上階)に3a柱が新規に立ち、下階柱集合が変化した');
    assert.equal(eavesBeam.sectionDefId, 'WOOD-120x240',
      '屋根伏図の軒桁の材幅は屋根自身の柱寸(120)のまま——最上階(105)へ静かに置き換わらない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- QA3-2: precomputedBelowGraph（structuralRecompute.js第4引数）を落とすと全スイート緑になって
// しまう（変異で確認済み）ことへの対策テスト。floorSwapManager.peek が常に「古い（3b柱を含まない）
// シリアライズ済みコピー」を返す状況（IDBが未反映のまま、という本番の実際の状態）を再現し、
// compositionの下階graphは生のライブオブジェクト（peekではない）を返す——2回目の再計算が
// precomputedBelowGraphでこのライブオブジェクトを直接使わず、peekし直していたら（4引数を
// 落とす変異と同じ）、古いコピーを読んで分割されないままになる。----
test('recomputeStructuralComposition【QA3-2】: 下階のpeekが古い（3b柱を含まない）シリアライズ済みコピーを返しても、compositionの下階graphを直接使って自階の梁が分割され直る', async () => {
  const project = new Project('proj-stale-peek', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（peekは常に古いコピーを返す）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT }); // 3b柱アンカー

  const room = g1.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  // このrecompute呼び出し前（柱ゼロ）のg1をIDBの「古い」スナップショットとして固定する——
  // floorSwapManager.peekは常にこのバイト列から作り直したコピーを返し、g1本体への以後の変更
  // （3b柱追加等）を一切反映しない（IDB未反映を模す）。
  const staleG1Bytes = serializeGraph(g1);

  const xMid = project.structGraph.centerLines.find(cl => cl.value === 1820 && cl.centerLineType === CenterLineType.VERTICAL);
  const y0b = y0;
  g2.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, y0b, {});

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => {
    if (plane.id === 'p1') {
      const stale = new PlanGraph(plane);
      stale._structGraph = project.structGraph;
      restoreGraph(stale, staleG1Bytes);
      return stale;
    }
    if (plane.id === 'p2') return g2;
    return null;
  };
  try {
    const composition = { graphForCategory: () => g1 }; // peekではなく生のg1を直接返す
    await recomputeStructuralComposition(composition, g2, project, {});

    assert.ok(g1.columns.length > 0, '前提: 生のg1には3b柱が新規に立った（peekの古いコピーには反映されない）');
    const splitBeams = g2.beams.filter(b => b.role === 'primary' && !b.isVertical && Math.abs(b.axisValue - 0) < 1);
    assert.equal(splitBeams.length, 2,
      'peekが古いコピーを返しても、compositionの下階graphを直接使うことで自階の梁が分割され直る');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 実機再々QA指摘1: reflectStructuralToOtherFloors はアクティブ階を recomputeStructuralForGraph
// （structuralRecompute.js）経由しない「収集だけ」の軽量経路のため、beamColumnWidthMm（下階基準の
// 派生値）を誰も書かない窓ができる——文書読込み直後・構造モードのままの階切替直後
// （runStructuralModeSetupがこのreflectをrecomputeStructuralCompositionより前に呼ぶ）は
// アクティブ階が未再計算=nullのまま自階フォールバックでcollect/applyが走り、標準材の判定が
// 一瞬だけ自階基準へずれる（実機観測: moku1・1階=105・アクティブ2階で、突入直後の反映パスで
// 105×120×9本が2G18〜2G26へ分裂→直後の自階再計算で2G18へ戻る）。----
// コメントを除去してから走査する（memberCatalog.test.js/structureRules.test.js の scanOffenders と
// 同じ方針）——コメントアウトで実装を無効化した変異（mutation test）でも赤くなるようにするため、
// 行コメント（`// …`）・ブロックコメント行（先頭`*`／`/*`）の内容は判定対象から除く。
function stripComments(src) {
  return src.split(/\r?\n/)
    .map(line => (line.trim().startsWith('*') || line.trim().startsWith('/*')) ? '' : line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('【不変条件・実機再々QA指摘1】structuralOrchestration.js: reflectStructuralToOtherFloors はアクティブ階の collectFloorGroups の直前に beamColumnWidthMm の派生値を書く', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = stripComments(fs.readFileSync(path.join(here, 'structuralOrchestration.js'), 'utf8'));
  // reflectStructuralToOtherFloors本体を抜き出し、その中で
  // 「setBeamColumnWidthMm(...) の呼び出し」→「collectFloorGroups(project.activeGraph, project)」の順に
  // 現れることを確認する（間に他の分岐が挟まっても良いが、setBeamColumnWidthMmが必ず先に実行される
  // ソース上の位置関係を固定する）。
  const fnMatch = /export async function reflectStructuralToOtherFloors\(project\) \{([\s\S]*?)\r?\n\}/.exec(src);
  assert.ok(fnMatch, 'reflectStructuralToOtherFloors関数本体が見つからない');
  const body = fnMatch[1];
  const setIdx = body.search(/project\.activeGraph\.setBeamColumnWidthMm\(beamColumnWidthMm\(project\.activeGraph, belowForActive, project\)\)/);
  const collectIdx = body.search(/collectFloorGroups\(project\.activeGraph, project\)/);
  assert.notEqual(setIdx, -1, 'project.activeGraph.setBeamColumnWidthMm(beamColumnWidthMm(...)) が見つからない（コメントアウトされている可能性）');
  assert.notEqual(collectIdx, -1, 'collectFloorGroups(project.activeGraph, project) が見つからない');
  assert.ok(setIdx < collectIdx, 'setBeamColumnWidthMm が collectFloorGroups(project.activeGraph, ...) より後にある（順序が逆）');
});

// reflectStructuralToOtherFloors を直接呼ぶ挙動テスト（アクティブ階以外を実際に peek+recompute する）は
// 本ファイル冒頭のコメント・reflectStructuralAfterFinishExit節のコメントと同じ理由（fake-indexeddb等の
// IDBモックが本リポジトリのdevDependenciesに無く、非アクティブ階でchanged=trueになると
// saveFloor→実indexedDBに到達しReferenceErrorになる）で断念し、上のソース走査（順序の固定）に留める。
// 実データでの挙動確認は golden probe（moku1.stq。既存floorsを事前収束させてchanged=falseにしてから
// reflectStructuralToOtherFloorsを呼び、saveFloorに到達しない状態で検証する）で行う——報告参照。

// ---- 実機再々QA指摘2: resyncTouchedMemberGroups（undo/redo時の派生値再導出。:172,175付近）を
// 梁でも固定する——柱だけでは派生値の書き込みが自明（本ステップ既存テスト参照）に埋もれて検出できない
// ため、105×120の標準材グループがundo後もmemberNumberIndexで1グループのままであることを直接見る。----
test('recomputeStructuralComposition【実機再々QA指摘2】: 1階=105（既存状態）で柱寸を変更→undoすると、memberNumberIndexで105×120の梁が再び1グループに戻る（resyncTouchedMemberGroupsの派生値再導出）', async () => {
  const project = new Project('proj-c2-qa5-undo-beam', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（各階柱寸法の編集対象。既に105＝ドキュメント読込み直後を模す）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g1.setWoodColumnWidthMm(105);
  project.activePlaneId = 'p2';

  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: true, discipline: Discipline.STRUCT });

  const beamStdA = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x120', y0, false, x0, x1, { role: 'primary' });
  const beamStdB = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x120', y1, false, x0, x1, { role: 'primary' });
  const beamNonStd = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x330', y2, false, x0, x1, { role: 'primary' });
  for (const b of [beamStdA, beamStdB, beamNonStd]) b.setDimensionStatus('locked');

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    // 反映パス相当（1階=105が既に効いた状態を収集で確立する。既存QA3テストと同じ手法）。
    runInAction(() => {
      collectFloorGroups(g1, project);
      g2.setBeamColumnWidthMm(105);
      collectFloorGroups(g2, project);
    });
    const groupKeyStd = memberGroupKey(beamStdA, 'beamMap', rulesFor(TRADITIONAL_WOOD_STRUCTURE), 'WOOD-105x120');
    const groupBefore = project.memberNumberIndex.get(groupKeyStd);
    assert.ok(groupBefore, '前提: 1階=105の時点で105×120グループが索引に存在する');
    assert.equal(totalCountOf(groupBefore), 2, '前提: 105×120グループは2本（標準材として1グループ）');

    const composition = { graphForCategory: () => g1 };
    // 柱寸法変更（105→120。標準材が変わり105×120は非標準＝個別採番へ移る）。
    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => { g1.setWoodColumnWidthMm(120); },
    });
    const groupDuring = project.memberNumberIndex.get(groupKeyStd);
    assert.ok(!groupDuring || totalCountOf(groupDuring) < 2, '前提: 変更直後は標準材が120基準になり105×120グループが縮小/消滅する');

    undoManager.undo();

    const groupAfterUndo = project.memberNumberIndex.get(groupKeyStd);
    assert.ok(groupAfterUndo, 'undo後に105×120グループの索引エントリが存在しない（resyncTouchedMemberGroupsが派生値を再導出できていない可能性）');
    assert.equal(totalCountOf(groupAfterUndo), 2, 'undo後は105×120グループが2本へ戻る（分裂したまま復元されない不具合の回帰防止）');
    assert.equal(beamStdA.memberNo, beamStdB.memberNo, 'undo後も105×120の2本は実体レベルでも同一タグ');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 実機再々QA指摘3: 下階編集経路（belowGraph自身のbeamColumnWidthMm書き込み。:107付近）を
// 3階建てで固定する——2階建てのテストではbelowGraph=1階（最下階）でbelowBelowGraph=nullのため
// この書き込みが自明値（自階フォールバック）にしかならず、消しても検出できない。3階建てで
// subject=3階・below=2階・belowBelow=1階にし、1階=105のとき2階自身の梁（105×120）が
// 1グループのままであることを見る。----
test('recomputeStructuralComposition【実機再々QA指摘3】: 3階建て（below=2階自身の梁がbelowBelow=1階の柱寸を参照）で105×120が1グループのまま', async () => {
  const project = new Project('proj-c2-qa5-3f', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // belowGraph（この階自身の梁が対象）
  const { graph: g3 } = project.addPlane(6000, '3階', 'p3'); // subjectGraph
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g3.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g1.setWoodColumnWidthMm(105); // 1階＝belowBelowGraph（既に105。ドキュメント読込み直後を模す）
  project.activePlaneId = 'p3';

  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: true, discipline: Discipline.STRUCT });

  // 2階自身の梁（belowGraphの梁。1階＝belowBelowGraphの柱寸105を参照して初めて「標準材」になる）。
  const beamStdA = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x120', y0, false, x0, x1, { role: 'primary' });
  const beamStdB = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x120', y1, false, x0, x1, { role: 'primary' });
  const beamNonStd = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x330', y2, false, x0, x1, { role: 'primary' });
  for (const b of [beamStdA, beamStdB, beamNonStd]) b.setDimensionStatus('locked');

  const peekMap = { p1: g1, p2: g2, p3: g3 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    // composition対象＝subject=3階、below=2階（各階柱寸法欄が編集する対象は3階の「1つ下」＝2階だが、
    // ここでは2階の柱寸自体は変更しない——2階「自身の梁」が1階の柱寸を参照する経路だけを見る）。
    const composition = { graphForCategory: () => g2 };
    await recomputeStructuralComposition(composition, g3, project, {});

    assert.equal(g2.beamColumnWidthMm, 105, '前提: 2階自身の派生値（belowBelow=1階の柱寸）が105になっている');
    assert.equal(beamStdA.memberNo, beamStdB.memberNo,
      '2階自身の105×120梁2本が同一タグのまま（下階編集経路のbelowGraph自身への書き込みが効いている）');
    assert.notEqual(beamStdA.memberNo, beamNonStd.memberNo, '105×330（個別採番対象）は引き続き別タグ');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- columnSetSignature（下階柱集合の変更検知。ユーザー裁定2026-09-16「分割後に正しい距離を
// 持つことが最適解」の実装で使う純関数）----

test('columnSetSignature: 順序・浮動小数の丸め誤差(0.1mm未満)に依存せず同一シグネチャになる', () => {
  const a = [{ x: 0, y: 0, role: 'standard' }, { x: 1820.02, y: 0, role: 'standard' }];
  const b = [{ x: 1820.04, y: 0, role: 'standard' }, { x: 0, y: 0, role: 'standard' }]; // 順序違い・0.1mm未満の誤差
  assert.equal(columnSetSignature(a), columnSetSignature(b));
});

test('columnSetSignature【失敗系】: 柱の位置・役割・本数のいずれかが変わると別シグネチャになる', () => {
  const base = [{ x: 0, y: 0, role: 'standard' }];
  assert.notEqual(columnSetSignature(base), columnSetSignature([{ x: 100, y: 0, role: 'standard' }]), '位置が変わると別シグネチャ');
  assert.notEqual(columnSetSignature(base), columnSetSignature([{ x: 0, y: 0, role: 'foundation' }]), '役割が変わると別シグネチャ');
  assert.notEqual(columnSetSignature(base), columnSetSignature([]), '柱が増減すると別シグネチャ');
  assert.equal(columnSetSignature([]), columnSetSignature([]), '空集合同士は同一シグネチャ');
});

// ---- ユーザー裁定2026-09-16「分割後に正しい距離を持つことが最適解」: 突入時に下階へ3b柱が
// 新規に立つと、自階の壁線上の通し梁（3c）がその位置で分割され直し、各区間が単一スパンの表引き成に
// なる（分割前＝関数先頭の自階再計算はまだ3b柱の無い下階を見ており、古い1本のまま確定してしまう
// 実機不具合の再現。QA F4テストと同じ壁・アンカー配置だが、col3bをあらかじめ置かない点が異なる）----
test('recomputeStructuralComposition【ユーザー裁定2026-09-16】: 突入時に新規追加された下階の3b柱の位置で、自階の壁線上の通し梁が分割され直る', async () => {
  const project = new Project('proj-3b-resplit', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（3b柱が新規に立つ対象階）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階（壁線上の通し梁が下階柱で分割される）
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 1階: 3640×1820の実壁の部屋（4隅が3a交点）＋走行方向アンカー用の通り芯 x=1820（壁は無い）。
  // wallRunSegments は自階(2階)＋下階(1階)の壁区間を合成するため、2階自身に壁が無くても
  // 1階の y=0, x:[0,3640] の壁が「壁線」として拾われる（QA F4テストと同じ配置）。
  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  g1.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  // （QA F4と異なり）1階に3b柱をあらかじめ置かない——この呼び出しの中で新規に立つケースを見る。

  // 2階: 自階柱(1820,0)——1階の3b柱にとっての「1つ上の実体階の柱」役（aboveColumnsForBelow）。
  const xm = g2.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  g2.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, y0, {});

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g1 };
    await recomputeStructuralComposition(composition, g2, project, {});

    const col3b = g1.columns.find(c => Math.abs(c.x - 1820) < 1 && Math.abs(c.y - 0) < 1);
    assert.ok(col3b, '前提: 1階に3b柱が新規に立った');
    assert.ok(composition.graphForCategory('columnMap').columnMap.has(col3b.id), '新規3b柱がcomposition経由でも見える');

    const splitBeams = g2.beams.filter(b => b.role === 'primary' && !b.isVertical && Math.abs(b.axisValue - 0) < 1);
    assert.equal(splitBeams.length, 2, '3b柱の位置で2本に分割される（古い下階柱のまま1本の3640スパンで確定しない）');
    // run端は壁の取り合い控え（WALL_JUNCTION_TOL_MM。実機コメント「x=0の縦壁に突き当たる横壁は
    // x=57.5から始まる」）ぶん内側へ寄るため、各区間はちょうど1820mmにはならない（実測1760mm）——
    // ここでは「3640一体の1本のまま（旧不具合）ではなく、下階柱で単一スパンの短い2本に割れている」
    // ことと、そのスパンが表の最小区分（1820以下・中間荷重なし=120）に収まることだけを見る。
    for (const b of splitBeams) {
      const span = Math.abs(b.coord2 - b.coord1);
      assert.ok(span > 0 && span < 1820, `分割後の各区間は表の最小区分（1820以下）に収まる短いスパンになる（実測${span}）`);
      assert.equal(b.sectionDefId, 'WOOD-120x120', '単一スパン(1820以下)・中間荷重なしの表引き成（120）になる');
    }
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 上のテストと対をなす不変条件: 下階の柱集合が変わらない（1回目の突入で3a・3b柱とも
// 出そろい、2回目は冪等）ケースでは、自階の再計算をもう一度やり直さない（flushEditablePeekが
// 余分に呼ばれない）。「同一入力2回目ならundoを積まない」テストと同じ「1回目で収束・2回目は
// 冪等」の手法——3a（壁交点）の柱本数を事前に手計算で言い当てる必要がなく、実装の内部詳細に
// 依存しない。----
test('recomputeStructuralComposition: 下階の柱集合が変わらない（2回目・冪等）場合は自階を再計算し直さない（flushEditablePeekが呼ばれない）', async () => {
  const project = new Project('proj-3b-nochange', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  g1.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

  const xm = g2.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  g2.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, y0, {});

  const originalFlush = floorSwapManager.flushEditablePeek;
  const originalPeek = floorSwapManager.peek;
  const peekMap = { p1: g1, p2: g2 };
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g1 };
    // 1回目: 3a（壁交点）・3b（上階柱直下）の柱が新規に立つ（このテストの対象外。上のテストが担当）。
    await recomputeStructuralComposition(composition, g2, project, {});
    const columnsAfterFirst = g1.columns.length;
    assert.ok(columnsAfterFirst > 0, '前提: 1回目で下階に柱が生成されている');

    const calls = [];
    floorSwapManager.flushEditablePeek = () => { calls.push('flush'); return Promise.resolve(); };
    // 2回目: 下階柱集合は変わらない（冪等）はず。
    await recomputeStructuralComposition(composition, g2, project, {});

    assert.equal(g1.columns.length, columnsAfterFirst, '前提: 2回目は下階の柱本数が変わらない（冪等）');
    assert.equal(calls.length, 0, '下階柱集合が変化していないため、自階の再計算をやり直すflushEditablePeekは呼ばれない');
  } finally {
    floorSwapManager.flushEditablePeek = originalFlush;
    floorSwapManager.peek = originalPeek;
  }
});
