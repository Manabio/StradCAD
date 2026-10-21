// 共通タブの構造の選択（主構造・地階構造・基礎種別）を recomputeStructuralComposition の mutate で変えたときの
// undo/redo と失敗時の巻き戻し（S5d・決定C/C9）。structuralOrchestration.test.js と同じ作法（実 core.js・実 undoManager・
// composition スタブ）。floorSwapManager のメソッドを一時的に差し替えるため専用ファイルに分ける（node --test はファイル単位で別プロセス）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { TRADITIONAL_WOOD_STRUCTURE, hasBasementFloor, foundationStructureFor, normalizeFoundationTypeFor } from './structureRules.js';
import { recomputeStructuralComposition } from './structuralOrchestration.js';

const RAME = 'RC造(ラーメン)';
const WALL = 'RC造(壁式)';
const noBelowComposition = { graphForCategory: () => null };
const stackLen = () => undoManager._undoStack.length;

// 地階1平面（startFloor -1）＋通り芯格子 2x2。構造の選択は呼び出し側が決める。
function makeBasementProject(main) {
  const project = new Project('proj-s5d', 'test');
  const { graph } = project.addPlane(-3000, '地下1階', 'b1', -1, 1);
  project.structuralInfo.setField('mainStructure', main);
  for (const v of [0, 3000]) {
    project.structGraph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: true, discipline: Discipline.STRUCT });
  }
  return { project, graph };
}

// CommonInfoTab.jsx の setBasementStructure と同じ形の mutate。
const basementMutate = (project, v) => () => {
  const info = project.structuralInfo;
  info.setBasementStructure(v);
  const next = normalizeFoundationTypeFor(foundationStructureFor(info, hasBasementFloor(project.planes)), info.foundationType);
  if (next !== info.foundationType) info.setField('foundationType', next);
};

test('【S5d・a】地階構造を変えると自階を再計算して undo が1件、undo で地階構造と部材が戻り、redo で再適用される', async () => {
  const { project, graph } = makeBasementProject(WALL); // 主構造は壁式（柱なし）
  const info = project.structuralInfo;
  const stack0 = stackLen();

  await recomputeStructuralComposition(noBelowComposition, graph, project, { mutate: basementMutate(project, RAME) });
  assert.equal(info.basementStructure, RAME);
  assert.equal(graph.columns.length, 4, 'ラーメンの地階は交点4箇所に柱が立つ（検出力: 地階構造が再計算に効いている）');
  assert.equal(stackLen(), stack0 + 1, 'undo は1件');

  undoManager.undo();
  assert.equal(info.basementStructure, null, 'undo で地階構造が戻る');
  assert.equal(graph.columns.length, 0, 'undo で部材が戻る');

  undoManager.redo();
  assert.equal(info.basementStructure, RAME, 'redo で地階構造が再適用される');
  assert.equal(graph.columns.length, 4, 'redo で部材が再適用される');
});

test('【S5d・e】ラーメン → 壁式へ変えると柱が消え、undo でラーメン・柱4本へ戻る', async () => {
  const { project, graph } = makeBasementProject(WALL);
  const info = project.structuralInfo;
  await recomputeStructuralComposition(noBelowComposition, graph, project, { mutate: basementMutate(project, RAME) });
  assert.equal(graph.columns.length, 4);

  await recomputeStructuralComposition(noBelowComposition, graph, project, { mutate: basementMutate(project, WALL) });
  assert.equal(info.basementStructure, WALL);
  assert.equal(graph.columns.length, 0, '壁式の地階に柱は立たない');

  undoManager.undo();
  assert.equal(info.basementStructure, RAME);
  assert.equal(graph.columns.length, 4);
});

test('【S5d・b】木造の「なし」→ 地階ラーメンで基礎種別が RC の選択肢へ正規化され、undo で「なし」へ戻る（choiceBefore は mutate より前に採る）', async () => {
  const { project, graph } = makeBasementProject(TRADITIONAL_WOOD_STRUCTURE);
  const info = project.structuralInfo;
  info.setField('foundationType', 'なし');

  await recomputeStructuralComposition(noBelowComposition, graph, project, { mutate: basementMutate(project, RAME) });
  assert.equal(info.foundationType, 'ベタ基礎', '正規化された');
  assert.equal(info.basementStructure, RAME);

  undoManager.undo();
  assert.equal(info.foundationType, 'なし', 'undo で基礎種別も戻る（「前」を mutate の後に採っていたら「ベタ基礎」のまま）');
  assert.equal(info.basementStructure, null);
  assert.equal(info.mainStructure, TRADITIONAL_WOOD_STRUCTURE);

  undoManager.redo();
  assert.equal(info.foundationType, 'ベタ基礎');
  assert.equal(info.basementStructure, RAME);
});

test('【S5d・f/C2】主構造の変更を undo すると建物全体の主構造も戻る（今までは部材だけ戻り mainStructure が残っていた）', async () => {
  const { project, graph } = makeBasementProject('S造');
  const info = project.structuralInfo;
  await recomputeStructuralComposition(noBelowComposition, graph, project, {
    mutate: () => { info.setField('mainStructure', '木造（在来）'); },
  });
  assert.equal(info.mainStructure, '木造（在来）');
  undoManager.undo();
  assert.equal(info.mainStructure, 'S造');
  undoManager.redo();
  assert.equal(info.mainStructure, '木造（在来）');
});

test('【S5d・F5】undo は構造の選択を restoreGraph・resyncTouchedMemberGroups より前に戻す（resync が戻した後の実効構造＝木造の柱群〔階ごと採番〕で群を作る）', async () => {
  const project = new Project('proj-s5d-order', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  const info = project.structuralInfo;
  info.setField('mainStructure', TRADITIONAL_WOOD_STRUCTURE);
  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x0, y0, {});
  const columnScopes = () => [...project.memberNumberIndex.values()].filter(g => g.mapName === 'columnMap').map(g => g.columnGroupScope);

  await recomputeStructuralComposition(noBelowComposition, graph, project, {
    mutate: () => { info.setField('mainStructure', 'S造'); },
  });
  assert.deepEqual(columnScopes(), ['building'], '前提: S造では柱群は建物単位の採番');

  undoManager.undo();
  assert.equal(info.mainStructure, TRADITIONAL_WOOD_STRUCTURE);
  assert.deepEqual(columnScopes(), ['floor'], 'undo 後の柱群は戻した後の構造（木造＝階ごと採番）で作られる');
});

test('【S5d】構造の選択が変わらない mutate（階の上書きだけ）の undo は建物全体の値に触らない', async () => {
  const { project, graph } = makeBasementProject('S造');
  const info = project.structuralInfo;
  await recomputeStructuralComposition(noBelowComposition, graph, project, {
    mutate: () => { graph.setStructureOverride('RC造(ラーメン)'); },
  });
  // 後から別経路で建物全体の値が変わった（例: 下階追加の初期値）。この undo はそれを巻き戻さない。
  info.setBasementStructure(WALL);
  undoManager.undo();
  assert.equal(graph.structureOverride, null, '上書きは戻る');
  assert.equal(info.basementStructure, WALL, '建物全体の地階構造は触らない');
});

test('【S5d・失敗系 c】mutate が選択肢外の地階構造で throw したら reject し、途中まで書いた値も戻り、undo は積まない', async () => {
  const { project, graph } = makeBasementProject('S造');
  const info = project.structuralInfo;
  info.setField('foundationType', '布基礎');
  const stack0 = stackLen();
  const before = info.captureStructureChoice();

  await assert.rejects(
    recomputeStructuralComposition(noBelowComposition, graph, project, {
      mutate: () => { info.setField('foundationType', '独立基礎'); info.setBasementStructure('S造'); },
    }),
    /地階構造に使えない値/,
  );
  assert.deepEqual(info.captureStructureChoice(), before, '基礎種別も mutate 前へ戻っている');
  assert.equal(stackLen(), stack0, 'undo を積まない');
});

test('【S5d・失敗系 d】下階ありで再計算中に失敗（flushEditablePeek が throw）したら、構造の選択・自階・下階が mutate 前に戻り undo は積まない', async () => {
  const project = new Project('proj-s5d-fail', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const info = project.structuralInfo;
  info.setField('mainStructure', 'S造');
  info.setField('foundationType', '布基礎');
  const before = info.captureStructureChoice();
  const stack0 = stackLen();

  const originalFlush = floorSwapManager.flushEditablePeek;
  const originalPeek = floorSwapManager.peek;
  let fired = 0;
  floorSwapManager.flushEditablePeek = () => { fired++; return Promise.reject(new Error('flush failed (test)')); };
  floorSwapManager.peek = async (plane) => ({ p1: g1, p2: g2 })[plane.id] ?? null;
  try {
    await assert.rejects(
      recomputeStructuralComposition({ graphForCategory: () => g1 }, g2, project, {
        mutate: () => {
          info.setField('mainStructure', '木造（在来）');
          info.setField('foundationType', 'ベタ基礎');
          g1.setWoodColumnWidthMm(105);
          g2.setStructureOverride('S造');
        },
      }),
      /flush failed/,
    );
  } finally {
    floorSwapManager.flushEditablePeek = originalFlush;
    floorSwapManager.peek = originalPeek;
  }
  assert.equal(fired, 1, '前提: 失敗フックが実際に発火した（空振りなら下の復元の assert は何も検証していない）');
  assert.deepEqual(info.captureStructureChoice(), before, '構造の選択が mutate 前に戻っている');
  assert.equal(g1.woodColumnWidthMm, null, '下階の柱寸が戻っている');
  assert.equal(g2.structureOverride, TRADITIONAL_WOOD_STRUCTURE, '自階の上書きが戻っている');
  assert.equal(stackLen(), stack0, 'undo を積まない');
});
