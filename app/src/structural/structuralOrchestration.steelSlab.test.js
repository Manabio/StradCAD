// S造スラブ指定（assignSteelSlabBays）を recomputeStructuralComposition の mutate に乗せたときの undo/redo と失敗時の巻き戻し
// （S4・QA 指摘 Major 2）。floorSwapManager.peek / flushEditablePeek を一時的に差し替えるため
// structuralOrchestration.choice.test.js と同じ理由で専用ファイルに分ける（node --test はファイル単位で別プロセス）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, SteelSlab } from '../core.js';
import { SteelSlabKind } from '../core/constants.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { recomputeStructuralComposition } from './structuralOrchestration.js';
import { assignSteelSlabBays } from './steelSlabBays.js';
import { listSlabBays } from './slabSecondaryBeamAxes.js';
import { defaultSteelSlabSpec, projectToKind } from './steelSlabSpec.js';

const stackLen = () => undoManager._undoStack.length;

// S造・2 平面（1階＝基礎伏図扱い、2階＝指定対象）・通り芯 2×2（3000 角の1ベイ）。
function makeProject() {
  const project = new Project('proj-steel-slab', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  project.structuralInfo.setField('mainStructure', 'S造');
  for (const v of [0, 3000]) {
    project.structGraph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: true, discipline: Discipline.STRUCT });
  }
  return { project, g1, g2, composition: { graphForCategory: () => g1 } };
}

// peek を graph マップへ差し替えて fn を実行する（実 IndexedDB を使わない）。
async function withPeek(graphs, fn) {
  const originalPeek = floorSwapManager.peek;
  const originalFlush = floorSwapManager.flushEditablePeek;
  floorSwapManager.peek = async (plane) => graphs[plane.id] ?? null;
  floorSwapManager.flushEditablePeek = async () => {};
  try { return await fn(); } finally {
    floorSwapManager.peek = originalPeek;
    floorSwapManager.flushEditablePeek = originalFlush;
  }
}

test('【S4】assignSteelSlabBays を mutate に乗せると SteelSlab が1枚でき、undo が1件、undo で消え、redo で cells と steelSpec が戻る', async () => {
  const { project, g1, g2, composition } = makeProject();
  await withPeek({ p1: g1, p2: g2 }, async () => {
    await recomputeStructuralComposition(composition, g2, project, {}); // 梁を生成（pushUndo 前の土台）
    const bays = listSlabBays(g2, project, []).filter(b => b.key != null);
    assert.equal(bays.length, 1, '前提: 3000 角の1ベイ（空振りなら以降は何も検証していない）');
    const keys = bays.map(b => b.key);
    const spec = { ...projectToKind(defaultSteelSlabSpec(), SteelSlabKind.ALC) };
    const stack0 = stackLen();

    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => assignSteelSlabBays(g2, project, keys, { openingRects: [], steelSpec: spec }),
    });
    assert.equal(g2.slabs.length, 1);
    const slab = g2.slabs[0];
    assert.ok(slab instanceof SteelSlab);
    assert.deepEqual([...slab.cells], keys);
    assert.equal(slab.steelSpec.kind, SteelSlabKind.ALC);
    assert.equal(stackLen(), stack0 + 1, 'undo は1件');

    undoManager.undo();
    assert.equal(g2.slabMap.size, 0, 'undo でスラブが消える');

    undoManager.redo();
    assert.equal(g2.slabs.length, 1, 'redo でスラブが戻る');
    assert.ok(g2.slabs[0] instanceof SteelSlab);
    assert.deepEqual([...g2.slabs[0].cells], keys, 'redo で cells が戻る');
    assert.equal(g2.slabs[0].steelSpec.kind, SteelSlabKind.ALC, 'redo で steelSpec が戻る');
  });
});

test('【S4・失敗系】存在しないベイキーを含む mutate は reject し、slabMap も undo スタックも変わらない', async () => {
  const { project, g1, g2, composition } = makeProject();
  await withPeek({ p1: g1, p2: g2 }, async () => {
    await recomputeStructuralComposition(composition, g2, project, {});
    const stack0 = stackLen();
    await assert.rejects(
      recomputeStructuralComposition(composition, g2, project, {
        mutate: () => assignSteelSlabBays(g2, project, ['no:such:bay:key'], { openingRects: [] }),
      }),
      /現在のベイではありません/,
    );
    assert.equal(g2.slabMap.size, 0, 'スラブは作られない');
    assert.equal(stackLen(), stack0, 'undo を積まない');
  });
});
