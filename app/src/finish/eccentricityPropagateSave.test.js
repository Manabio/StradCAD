// propagateCLEccentricities（プッシュ側）が、連動先の階の内容が実際に変わったときだけ保存する
// ことの回帰テスト。他階のスタブは本番同型: Map のバイト列ストア＋restoreGraph で復元する peek
// （FloorSwapManager.peek と同じ _healDerivedGeometry も通す）。保存はストアへ書く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, PlanGraph, CenterLineType, Discipline, RoomFeature } from '../core.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { floorBytesEqual } from '../floorOps.js';
import { runFinishEntryBoundary } from './finishBoundary.js';
import { loadMaterialMap, regenerateWalls } from './wallRegeneration.js';
import { materialThickness } from './edgeComposition.js';
import { applyCLEccentricity } from './clEccentricity.js';
import { propagateCLEccentricities } from './eccentricityFloorSync.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';

const REC = { mode: 'face', value: 0, side: 1, backing: '' };
const REC2 = { mode: 'value', value: 30, side: 1, backing: '' };

// n 階建て。全階の ym 位置の下側に階段（feature=STAIR）の部屋＋内壁（階段規則で全階連動）。
async function makeFixture(n) {
  const project = new Project('proj', 'test');
  const gs = [];
  for (let i = 1; i <= n; i++) gs.push(project.addPlane((i - 1) * 3000, `${i}階`, `p${i}`).graph);
  project.activePlaneId = `p${n}`;
  const orig = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => gs.find(g => g.plane.id === plane.id);
  const yms = [];
  try {
    for (const g of gs) {
      const x0 = g.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
      const x1 = g.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
      const y0 = g.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
      const ym = g.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
      const y1 = g.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: false, discipline: Discipline.ARCH });
      g.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${ym.id}`]), '階段').setFeature(RoomFeature.STAIR);
      g.addRoom(new Set([`${x0.id}:${ym.id}:${x1.id}:${y1.id}`]), '部屋B');
      g.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
      await runFinishEntryBoundary(g, project);
      yms.push(ym);
    }
  } finally {
    floorSwapManager.peek = orig;
  }
  const materialMap = await loadMaterialMap();
  return { project, gs, yms, materialMap };
}

// ストア＋本番同型の peek/saveFloorFn を使って fn を実行する（peek は必ず元へ戻す）。
// activeIdx 階のグラフは「生きたアクティブ階」としてそのまま渡す。他階は store から復元される。
async function withStore(f, activeIdx, fn) {
  const store = new Map();
  f.gs.forEach((g, i) => { if (i !== activeIdx) store.set(`p${i + 1}`, serializeGraph(g)); });
  const saves = [];
  const peeks = [];
  const saveFloorFn = async (planeId, bytes) => { saves.push(planeId); store.set(planeId, bytes); };
  const orig = floorSwapManager.peek;
  floorSwapManager.peek = async (plane, structGraph) => {
    peeks.push(plane.id);
    const g = new PlanGraph(plane);
    g._structGraph = structGraph;
    const bytes = store.get(plane.id);
    if (bytes) { restoreGraph(g, bytes); floorSwapManager._healDerivedGeometry(g); }
    return g;
  };
  try {
    return await fn({ store, saves, peeks, saveFloorFn });
  } finally {
    floorSwapManager.peek = orig;
  }
}

function setSpec(f, idx, rec) {
  const g = f.gs[idx];
  if (rec) g.setCLEccentricity(f.yms[idx].id, rec); else g.removeCLEccentricity(f.yms[idx].id);
  applyCLEccentricity(g, f.yms[idx].id, { materialMap: f.materialMap });
}

const restored = (f, planeId, bytes) => {
  const g = new PlanGraph(f.project.planes.find(p => p.id === planeId));
  g._structGraph = f.project.structGraph;
  restoreGraph(g, bytes);
  return g;
};

test('【前提】applyCLEccentricity は同じ spec を続けて適用しても直列化結果が変わらない（冪等）', async () => {
  const f = await makeFixture(2);
  setSpec(f, 1, REC);
  const g = f.gs[1];
  const b1 = serializeGraph(g);
  applyCLEccentricity(g, f.yms[1].id, { materialMap: f.materialMap });
  const b2 = serializeGraph(g);
  assert.ok(floorBytesEqual(b1, b2), '2回目の適用で直列化結果が変わった（非冪等）');
});

test('(b) 連動先と値が違う → 保存1回・undoRecords に1件（after がストアと同じ・before≠after）・復元すると新しい値', async () => {
  const f = await makeFixture(2);
  setSpec(f, 1, REC);
  await withStore(f, 1, async ({ store, saves, saveFloorFn }) => {
    const beforeStore = store.get('p1');
    const undoRecords = [];
    await propagateCLEccentricities(f.project, f.gs[1], [f.yms[1].id], { materialMap: f.materialMap, undoRecords, saveFloorFn });
    assert.deepEqual(saves, ['p1']);
    assert.equal(undoRecords.length, 1);
    assert.equal(undoRecords[0].planeId, 'p1');
    assert.ok(!floorBytesEqual(undoRecords[0].before, undoRecords[0].after));
    assert.ok(floorBytesEqual(undoRecords[0].after, store.get('p1')), 'after は保存したバイト列');
    assert.ok(!floorBytesEqual(beforeStore, store.get('p1')));
    const g = restored(f, 'p1', store.get('p1'));
    assert.equal(g.clEccentricities.size, 1, '偏芯レコードが入る');
    assert.deepEqual({ ...[...g.clEccentricities.values()][0] }, REC);
  });
});

test('(a)(e) 連動先が既に同じ指定・同じ壁の状態 → 保存0回・undoRecords 空・ストア不変（同じ呼び出しを2回続けると2回目は0回）', async () => {
  const f = await makeFixture(2);
  setSpec(f, 1, REC);
  await withStore(f, 1, async ({ store, saves, saveFloorFn }) => {
    await propagateCLEccentricities(f.project, f.gs[1], [f.yms[1].id], { materialMap: f.materialMap, saveFloorFn });
    assert.deepEqual(saves, ['p1'], '1回目は保存する（連動対象があることの確認＝空振り防止）');
    const stored = store.get('p1');
    const undoRecords = [];
    await propagateCLEccentricities(f.project, f.gs[1], [f.yms[1].id], { materialMap: f.materialMap, undoRecords, saveFloorFn });
    assert.deepEqual(saves, ['p1'], '2回目は保存しない');
    assert.equal(undoRecords.length, 0);
    assert.ok(floorBytesEqual(stored, store.get('p1')) && stored === store.get('p1'), 'ストアのバイト列は不変');
  });
});

test('(c) 3階建てで連動先が2階あり、片方だけ既に同じ → 違う方だけ保存', async () => {
  const f = await makeFixture(3);
  setSpec(f, 2, REC);
  await withStore(f, 2, async ({ store, saves, saveFloorFn }) => {
    await propagateCLEccentricities(f.project, f.gs[2], [f.yms[2].id], { materialMap: f.materialMap, saveFloorFn });
    assert.deepEqual([...saves].sort(), ['p1', 'p2'], '両方が違う状態から始まるので両方保存（前提）');
    // p2 だけ元（偏芯なし）へ戻す
    const fresh = await makeFixture(3);
    store.set('p2', serializeGraph(fresh.gs[1]));
    saves.length = 0;
    await propagateCLEccentricities(f.project, f.gs[2], [f.yms[2].id], { materialMap: f.materialMap, saveFloorFn });
    assert.deepEqual(saves, ['p2'], '違う方（p2）だけ保存');
  });
});

test('(d) 解除（自階にレコードが無い）: 連動先にレコードが在れば消して保存、既に無ければ保存しない', async () => {
  const f = await makeFixture(2);
  setSpec(f, 1, REC);
  await withStore(f, 1, async ({ store, saves, saveFloorFn }) => {
    await propagateCLEccentricities(f.project, f.gs[1], [f.yms[1].id], { materialMap: f.materialMap, saveFloorFn });
    assert.deepEqual(saves, ['p1']);
    setSpec(f, 1, null);
    saves.length = 0;
    await propagateCLEccentricities(f.project, f.gs[1], [f.yms[1].id], { materialMap: f.materialMap, saveFloorFn });
    assert.deepEqual(saves, ['p1'], 'レコードを消して保存');
    assert.equal(restored(f, 'p1', store.get('p1')).clEccentricities.size, 0);
    saves.length = 0;
    await propagateCLEccentricities(f.project, f.gs[1], [f.yms[1].id], { materialMap: f.materialMap, saveFloorFn });
    assert.deepEqual(saves, [], '既に無ければ保存しない');
  });
});

test('(f)【失敗系】saveFloorFn が throw → 上へ伝わり、積んだ undoRecords は保存に成功した階の分だけ', async () => {
  const f = await makeFixture(3);
  setSpec(f, 2, REC);
  await withStore(f, 2, async ({ store }) => {
    const undoRecords = [];
    const calls = [];
    const saveFloorFn = async (planeId, bytes) => {
      calls.push(planeId);
      if (calls.length === 2) throw new Error('保存失敗');
      store.set(planeId, bytes);
    };
    await assert.rejects(
      propagateCLEccentricities(f.project, f.gs[2], [f.yms[2].id], { materialMap: f.materialMap, undoRecords, saveFloorFn }),
      /保存失敗/);
    assert.equal(calls.length, 2);
    assert.equal(undoRecords.length, 1, '成功した1階ぶんだけ記録（失敗した階は積まない）');
    assert.equal(undoRecords[0].planeId, calls[0]);
  });
});

test('(g) undoRecords を渡さない呼び出し（モード境界の自動再伝播）: 変化なしなら保存0回・変化ありなら保存', async () => {
  const f = await makeFixture(2);
  setSpec(f, 1, REC);
  await withStore(f, 1, async ({ saves, saveFloorFn }) => {
    await propagateCLEccentricities(f.project, f.gs[1], [f.yms[1].id], { materialMap: f.materialMap, saveFloorFn });
    assert.equal(saves.length, 1, '変化あり→保存');
    await propagateCLEccentricities(f.project, f.gs[1], [f.yms[1].id], { materialMap: f.materialMap, saveFloorFn });
    assert.equal(saves.length, 1, '変化なし→保存しない');
  });
});

test('値を変えると再び保存される（REC → REC2。変化の検出が効く）', async () => {
  const f = await makeFixture(2);
  setSpec(f, 1, REC);
  await withStore(f, 1, async ({ saves, saveFloorFn }) => {
    await propagateCLEccentricities(f.project, f.gs[1], [f.yms[1].id], { materialMap: f.materialMap, saveFloorFn });
    setSpec(f, 1, REC2);
    await propagateCLEccentricities(f.project, f.gs[1], [f.yms[1].id], { materialMap: f.materialMap, saveFloorFn });
    assert.deepEqual(saves, ['p1', 'p1']);
  });
});

// ---- 「レコードの値が同じ」だけでは省かない（壁の状態が違えば保存する）ことの固定 ----
// 壁（内周壁）を実際に持たせるため、各階で regenerateWalls を通す。
async function withWalls(f) {
  for (const g of f.gs) await regenerateWalls(g, { materialMap: f.materialMap, project: f.project });
}
const offsetsOn = (g, clId) => g.walls.filter(w => w.axisCL.id === clId && !w.isExteriorWall)
  .map(w => [w.axisOffset, w.wallFinish, w.backingOffset, w.backingDepth, w.finishSide]);
// 内壁の厚み（下地材）を +7mm した materialMap
function thickerMap(f, plus = 7) {
  const code = f.gs[0].interiorWallBacking;
  const ent = f.materialMap.get(code);
  assert.ok(ent, '下地材が材マスタにある（前提）');
  const m = new Map(f.materialMap);
  m.set(code, { ...ent, thickness: materialThickness(ent) + plus });
  return m;
}
// 階 idx（0始まり）の保存バイト列から復元した別インスタンスへ rec を適用した結果（期待値）
function expectedOffsets(f, bytes, planeId, clId, rec, materialMap) {
  const g = restored(f, planeId, bytes);
  g.setCLEccentricity(clId, rec);
  applyCLEccentricity(g, clId, { materialMap });
  return offsetsOn(g, clId);
}

test('T1 連動先のレコードは同じ値だが壁が未適用 → 保存する（レコードの値だけ見て省かない）', async () => {
  const f = await makeFixture(2);
  await withWalls(f);
  const ym0 = f.yms[0].id;
  const bytes0 = serializeGraph(f.gs[0]);
  setSpec(f, 1, REC);
  // 連動先: 一度 REC2 を適用して壁をずらし、その後レコードだけ REC にする（適用しない）
  setSpec(f, 0, REC2);
  f.gs[0].setCLEccentricity(ym0, REC);
  const expected = expectedOffsets(f, bytes0, 'p1', ym0, REC, f.materialMap);
  assert.deepEqual({ ...f.gs[0].clEccentricities.get(ym0) }, REC, '前提: 連動先のレコードは REC と同じ値');
  assert.ok(expected.length > 0, '前提: 対象の壁がある');
  assert.notDeepEqual(offsetsOn(f.gs[0], ym0), expected, '前提: 壁は REC の適用結果と違う');
  await withStore(f, 1, async ({ store, saves, saveFloorFn }) => {
    const undoRecords = [];
    await propagateCLEccentricities(f.project, f.gs[1], [f.yms[1].id], { materialMap: f.materialMap, undoRecords, saveFloorFn });
    assert.deepEqual(saves, ['p1']);
    assert.equal(undoRecords.length, 1);
    assert.deepEqual(offsetsOn(restored(f, 'p1', store.get('p1')), ym0), expected, '保存後の壁は REC を適用した結果');
  });
});

test('T2 連動先のレコードは同じだが材の厚みが違う → 保存する', async () => {
  const f = await makeFixture(2);
  await withWalls(f);
  const ym0 = f.yms[0].id;
  const bytes0 = serializeGraph(f.gs[0]);
  setSpec(f, 1, REC);
  // 連動先: 厚みを変えた materialMap で REC を適用して保存済みにする
  f.gs[0].setCLEccentricity(ym0, REC);
  applyCLEccentricity(f.gs[0], ym0, { materialMap: thickerMap(f) });
  const expected = expectedOffsets(f, bytes0, 'p1', ym0, REC, f.materialMap);
  assert.ok(expected.length > 0, '前提: 対象の壁がある');
  assert.notDeepEqual(offsetsOn(f.gs[0], ym0), expected, '前提: 厚みを変えた適用結果は本来の適用結果と違う');
  await withStore(f, 1, async ({ store, saves, saveFloorFn }) => {
    await propagateCLEccentricities(f.project, f.gs[1], [f.yms[1].id], { materialMap: f.materialMap, saveFloorFn });
    assert.deepEqual(saves, ['p1']);
    assert.deepEqual(offsetsOn(restored(f, 'p1', store.get('p1')), ym0), expected);
  });
});
