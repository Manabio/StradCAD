// S造スラブ指定（assignSteelSlabBays）を recomputeStructuralComposition の mutate に乗せたときの undo/redo と失敗時の巻き戻し
// （S4・QA 指摘 Major 2）。floorSwapManager.peek / flushEditablePeek を一時的に差し替えるため
// structuralOrchestration.choice.test.js と同じ理由で専用ファイルに分ける（node --test はファイル単位で別プロセス）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, SteelSlab } from '../core.js';
import { SteelSlabKind } from '../core/constants.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { recomputeStructuralComposition } from './structuralOrchestration.js';
import { assignSteelSlabBays } from './steelSlabBays.js';
import { listSlabBays } from './slabSecondaryBeamAxes.js';
import { defaultSteelSlabSpec, projectToKind } from './steelSlabSpec.js';

const stackLen = () => undoManager._undoStack.length;

// S造・2 平面（1階＝基礎伏図扱い、2階＝指定対象）・通り芯 2×2（3000 角の1ベイ）。
function makeProject(width = 3000, height = 3000) {
  const project = new Project('proj-steel-slab', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  project.structuralInfo.setField('mainStructure', 'S造');
  for (const v of [0, width]) project.structGraph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: true, discipline: Discipline.STRUCT });
  for (const v of [0, height]) project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: true, discipline: Discipline.STRUCT });
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

test('【S7】ブレースのベイ: 指定・種別変更の mutate で再計算が子梁の梁芯数を 4（デッキ n=5）→2（丸鋼 n=3）→1（L型鋼 n=2）→4 と割り直す', async () => {
  // 5000×12000: デッキ ceil(12000/2500)=5、丸鋼 ceil(12000/√(7000²−5000²))=3、L型鋼 ceil(12000/√(12000²−5000²))=2。3つとも異なる。
  const { project, g1, g2, composition } = makeProject(5000, 12000);
  const slabAxes = () => g2.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM).length;
  await withPeek({ p1: g1, p2: g2 }, async () => {
    await recomputeStructuralComposition(composition, g2, project, {});
    assert.equal(slabAxes(), 4, '前提: ブレース無しはデッキの 2500 ピッチ（空振りなら以降は何も検証していない）');
    const keys = listSlabBays(g2, project, []).filter(b => b.key != null).map(b => b.key);
    assert.equal(keys.length, 1);
    const brace = type => ({ ...projectToKind(defaultSteelSlabSpec(), SteelSlabKind.BRACE), braceMemberType: type });

    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => assignSteelSlabBays(g2, project, keys, { openingRects: [], steelSpec: brace('roundBar') }),
    });
    assert.equal(slabAxes(), 2, '丸鋼 n=3');
    await recomputeStructuralComposition(composition, g2, project, { mutate: () => g2.slabs[0].setSteelSpec(brace('angle')) });
    assert.equal(slabAxes(), 1, 'L型鋼 n=2');
    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => g2.slabs[0].setSteelSpec({ ...projectToKind(defaultSteelSlabSpec(), SteelSlabKind.DECK) }),
    });
    assert.equal(slabAxes(), 4, 'デッキは 2500 ピッチへ戻る');
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
