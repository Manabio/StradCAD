// 階削除の undo/redo（階の追加・削除の見直し S2）。App.jsx の withFloorOpUndo／runDeleteFloor は import できない
// ため、同じ部品（collectRemovalRecords／diffFloorOpSnapshot／restoreRemovedPlanes／removePlanesForRedo／
// rollbackFloorOp ほか floorOps.js の関数、applyFloorOrderChange の DELETE）を App.jsx と同じ順で呼ぶ小さな
// ハーネスで往復を確かめる（前例: floorHeights.undoRoundtrip.test.js）。配線はこのファイル末尾のソース走査で固定。
// 他階の peek／保存は本番同型（IDB の代わりの Map ストア。peek は new PlanGraph→restoreGraph、検証はバイト列の復号）。
// 階切替は FloorSwapManager.swap と同じ順（保存→復元→clearFloorData→activePlaneId）で模す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { RoomFeature } from '@core';
import { CenterLineType, Discipline } from './core.js';
import { serializeGraph, restoreGraph } from './graphSnapshot.js';
import { applyFloorOrderChange, floorOrderFollowers, FLOOR_ORDER_KIND } from './floorOrderChange.js';
import { resolveTopStoryHeightMm } from './floorHeights.js';
import {
  floorBytesEqual, blocksFloorRemoval, computeFloorDeleteReorder, collectPlaneMetas, applyPlaneMetas,
  collectProjectLevels, applyProjectLevels, diffFloorOpSnapshot, rollbackFloorOp,
  collectRemovalRecords, restoreRemovedPlanes, removePlanesForRedo, pickRemovalFallback,
} from './floorOps.js';
import { followRoofPlaneToTop } from './structural/roofPlane.js';
import { makeStorePeek, makeStoreSave, decodeFloor } from './finish/equipment/equipmentTestFixtures.js';
import { setupProject, addPerFloorV, placeStair } from './finish/stair/stairRemovalTestFixtures.js';
import { syncUpperFloors } from './finish/stair/stairFloorSync.js';
import { readAppSrc, stripCommentLines, extractFunctionBody } from './uiBusySourceScan.js';
import fs from 'node:fs';
import path from 'node:path';

// DELETE に適用される実物 follower のうち、全階の構造反映・昇降機の再採番（このハーネスの範囲外）だけを除く。
// 許可リストにしないのは、他階の階段を消す follower が再登録されたときにこのテスト群で検出するため（S3）。
const followersUnderTest = floorOrderFollowers.filter(f =>
  f.appliesTo.includes(FLOOR_ORDER_KIND.DELETE) && !['structuralReflect', 'elevatorRenumber'].includes(f.name));
const ui = { notify() {}, switchFloor: async () => true, onFloorSyncChanged() {} };

/**
 * p1〜p4（各階に per-floor 中心線）。2階(p2)に階段（3階 p3 に吹抜けが展開される）。3階(p3)に検討案 p3a・p3b
 * （それぞれ別の中心線で内容を区別。p3a は平面切断高を持つ）。最上階 p4 は topStoryHeightMm=2600。
 * 全階を Map ストアへ保存し、非アクティブ階は clearFloorData（本番の状態）。アクティブ階は activeId。
 */
async function setup(activeId = 'p3') {
  const { project, graphs } = setupProject(4);
  addPerFloorV(graphs);
  const [, g2] = graphs;
  const store = new Map(graphs.map(g => [g.plane.id, serializeGraph(g)]));
  placeStair(project, g2); // 2階をアクティブにして階段を指定
  store.set('p2', serializeGraph(g2));
  await syncUpperFloors(project, g2, { peekFn: makeStorePeek(project, store), saveFloorFn: makeStoreSave(store) });
  for (const [i, id] of ['p3a', 'p3b'].entries()) {
    const { graph } = project.addPlane(6000, `3階#${'ab'[i]}`, id, 3, 1, true, 'p3', i, false, null, i === 0 ? 1200 : undefined);
    graph.addCenterLine(CenterLineType.VERTICAL, 700 + i * 100, { labeled: false, discipline: Discipline.ARCH });
    store.set(id, serializeGraph(graph));
    graph.clearFloorData();
  }
  project.planeMap.get('p4').topStoryHeightMm = 2600;
  for (const g of graphs) if (g.plane.id !== 'p2') g.clearFloorData();
  // 組み立て直後の直列化は「復元→直列化」で一度だけ形が変わる（正規化される）。本番のバイト列は常に復元後の
  // グラフから出るので、ストアを一度通して正規化する（しないと undo の往復が形の違いで不一致に見える）
  for (const [id, bytes] of store) {
    const g = makeStorePeek(project, new Map([[id, bytes]]))(project.planeMap.get(id));
    store.set(id, serializeGraph(g));
  }
  const app = makeApp(project, store);
  if (activeId !== 'p2') await app.switchRaw(activeId);
  else restoreGraph(project.activeGraph, store.get('p2'));
  return { project, store, app };
}

function makeApp(project, store, opts = {}) {
  const log = { switches: [] };
  const saveFloorFn = makeStoreSave(store);
  const readBytes = async (id) => (id === project.activePlaneId ? serializeGraph(project.activeGraph) : (store.get(id) ?? null));
  const collect = async () => {
    const map = new Map();
    for (const p of project.planes) map.set(p.id, await readBytes(p.id));
    return map;
  };
  // FloorSwapManager.swap と同じ順: 現階を保存 → 次階を復元 → 現階 clearFloorData → activePlaneId（1つの runInAction）
  const switchRaw = async (id) => {
    const cur = project.activeGraph;
    store.set(project.activePlaneId, serializeGraph(cur));
    const next = project.graphMap.get(id);
    runInAction(() => {
      if (store.get(id)) restoreGraph(next, store.get(id));
      cur.clearFloorData();
      project.activePlaneId = id;
    });
  };
  const trySwitch = async (id) => {
    log.switches.push(id);
    if (opts.failSwitch) return false; // trySwitchFloor が失敗を握って false を返した状態（アクティブは変わらない）
    await switchRaw(id);
    return true;
  };
  // store.js removeFloor と同じ形（採用階なら検討案の IDB 行も消してから project から除く）。failAt の行で IDB 削除が失敗する。
  const removeFloorFn = async (id) => {
    const plane = project.planeMap.get(id);
    if (!plane) return;
    const ids = [id, ...(plane.isAlternative ? [] : [...project.planeMap.values()]
      .filter(p => p.isAlternative && p.referenceId === id).map(p => p.id))];
    for (const x of ids) {
      if (opts.removeFailsAt === x) throw new Error(`IDB delete failed: ${x}`);
      store.delete(x);
    }
    runInAction(() => project.removePlane(id));
  };
  // store.js addFloor／addAlternativeFloor と同じ引数（id・altIndex 指定。wiring テストが本物の側を固定する）
  const addFloor = (elev, name, sf, stories, id, pc, cc, ts) =>
    project.addPlane(elev, name, id, sf, stories, false, null, 0, false, null, pc, cc, ts);
  const addAlternativeFloor = (refId, name, _src, id = crypto.randomUUID(), altIndex = undefined) => {
    const ref = project.planeMap.get(refId);
    if (!ref) return null;
    const n = [...project.planeMap.values()].filter(p => p.isAlternative && p.referenceId === refId).length;
    return project.addPlane(ref.elevation, name, id, ref.startFloor, ref.stories, true, refId, altIndex ?? n,
      false, null, ref.planCutHeightMm, ref.ceilingCutHeightMm);
  };
  const restoreRemoved = (proj, records) => restoreRemovedPlanes(proj, records, { addFloor, addAlternativeFloor, saveFloorFn });
  const applyBytes = (id, bytes) => {
    if (id === project.activePlaneId) { if (bytes != null) restoreGraph(project.activeGraph, bytes); return; }
    if (bytes != null) store.set(id, bytes); else store.delete(id);
  };
  const floorIo = { peekFn: makeStorePeek(project, store), saveFloorFn };
  const followRoof = (p) => runInAction(() => followRoofPlaneToTop(p));

  /** withFloorOpUndo('階削除') ＋ runDeleteFloor と同じ順。積むものが無ければ null、あれば { undo, redo, diff }。 */
  async function deleteFloor(planeId, { extraFollowers = [] } = {}) {
    const before = await collect();
    const metasBefore = collectPlaneMetas(project);
    const levelsBefore = collectProjectLevels(project);
    const removalBefore = await collectRemovalRecords(project, planeId, readBytes);
    const run = async () => {
      const adopted = project.planes;
      const idx = adopted.findIndex(p => p.id === planeId);
      const fallback = adopted[idx + 1] ?? adopted[idx - 1];
      if (blocksFloorRemoval(project, planeId)) {
        if (fallback) await trySwitch(fallback.id);
        if (blocksFloorRemoval(project, planeId)) return;
      }
      const afterRemoval = adopted.filter(p => p.id !== planeId);
      const updates = computeFloorDeleteReorder(afterRemoval, idx, { planesBefore: adopted, topHeightMm: resolveTopStoryHeightMm(project) });
      await applyFloorOrderChange(project, {
        kind: FLOOR_ORDER_KIND.DELETE, updates, removePlane: () => removeFloorFn(planeId),
        removedPlane: project.planeMap.get(planeId), ui, floorIo,
      }, [...followersUnderTest, ...extraFollowers]);
    };
    const rollback = () => rollbackFloorOp(project, {
      before, metasBefore, levelsBefore, collectBytes: collect, followRoof, removalBefore, restoreRemoved,
      applyBytes: (_p, id, b) => applyBytes(id, b), saveFloorFn, deleteFloorFn: async (id) => { store.delete(id); },
    });
    try { await run(); } catch (err) { await rollback(); throw err; }

    const activeAfterId = project.activePlaneId;
    const after = await collect();
    const metasAfter = collectPlaneMetas(project);
    const levelsAfter = collectProjectLevels(project);
    const diff = diffFloorOpSnapshot({
      before, after, metasBefore, metasAfter, levelsBefore, levelsAfter,
      removalBefore, existingIdsAfter: new Set(project.planeMap.keys()),
    });
    if (!diff.hasChanges) return null;
    const { removedPlanes, changedSiblings } = diff;

    // App.jsx undoFloorOp の状態部分と同じ順
    async function undo() {
      await restoreRemoved(project, removedPlanes);
      applyPlaneMetas(project, metasBefore);
      applyProjectLevels(project, levelsBefore);
      for (const rec of changedSiblings) applyBytes(rec.planeId, rec.before);
      followRoof(project);
      const revivedId = removedPlanes.find(r => !r.isAlternative)?.id;
      if (revivedId && project.planeMap.has(revivedId)) await trySwitch(revivedId);
    }
    // App.jsx redoFloorOp の状態部分と同じ順
    async function redo() {
      const removed = await removePlanesForRedo(project, removedPlanes, activeAfterId, { removeFloorFn, switchTo: trySwitch });
      if (!removed) return;
      applyPlaneMetas(project, metasAfter);
      applyProjectLevels(project, levelsAfter);
      for (const rec of changedSiblings) applyBytes(rec.planeId, rec.after);
      followRoof(project);
      if (activeAfterId !== project.activePlaneId) await switchRaw(activeAfterId);
    }
    return { undo, redo, diff };
  }

  return { log, switchRaw, readBytes, deleteFloor, removeFloorFn, addFloor, addAlternativeFloor, restoreRemoved };
}

/** 全平面（採用＋検討）のメタと、全平面のバイト列（アクティブはメモリ、他はストア）。アクティブ階の id は別に比べる。 */
async function snapshot(project, store) {
  const planes = [...project.planeMap.values()]
    .map(p => ({
      id: p.id, name: p.name, startFloor: p.startFloor, elevation: p.elevation, stories: p.stories,
      planCutHeightMm: p.planCutHeightMm, ceilingCutHeightMm: p.ceilingCutHeightMm, topStoryHeightMm: p.topStoryHeightMm,
      isAlternative: p.isAlternative, referenceId: p.referenceId, altIndex: p.altIndex,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const bytes = new Map();
  for (const p of planes) {
    bytes.set(p.id, p.id === project.activePlaneId ? serializeGraph(project.activeGraph) : (store.get(p.id) ?? null));
  }
  return { planes, bytes, adoptedOrder: project.planes.map(p => p.id) };
}

function assertSameSnapshot(actual, expected, label) {
  assert.deepEqual(actual.planes, expected.planes, `${label}: 平面のメタ（id・名前・順序・referenceId・altIndex・切断高）`);
  assert.deepEqual(actual.adoptedOrder, expected.adoptedOrder, `${label}: 採用階の並び`);
  for (const [id, b] of expected.bytes) {
    assert.ok(floorBytesEqual(actual.bytes.get(id), b), `${label}: ${id} のバイト列が一致する`);
  }
}

const decode = (project, store, id) => decodeFloor(project, project.planeMap.get(id), store.get(id));

test('前提（setup）: 4階・p2 に階段・p3 に吹抜け・p3 に検討案2つ（内容が違う）', async () => {
  const { project, store } = await setup();
  assert.equal(decode(project, store, 'p2').stairs.length, 1);
  assert.ok(decode(project, store, 'p3a').centerLines.length !== decode(project, store, 'p3b').centerLines.length
    || !floorBytesEqual(store.get('p3a'), store.get('p3b')), 'p3a と p3b の内容が違う');
  assert.equal(project.activePlaneId, 'p3');
  assert.equal(project.planeMap.get('p3b').altIndex, 1);
});

test('中間階(p3・表示中)の削除 → undo → redo → undo: 階数・id・名前・順序・検討案(id/referenceId/altIndex)・バイト列が往復し、undo 後は復活した階を表示する', async () => {
  const { project, store, app } = await setup('p3');
  const s0 = await snapshot(project, store);
  assert.deepEqual(s0.adoptedOrder, ['p1', 'p2', 'p3', 'p4']);

  const c = await app.deleteFloor('p3');
  assert.ok(c, '積むものがある');
  assert.deepEqual(c.diff.removedPlanes.map(r => r.id), ['p3', 'p3a', 'p3b']);
  assert.deepEqual(app.log.switches, ['p4'], '表示中の階は直上の階へ退避してから消す');
  const s1 = await snapshot(project, store);
  assert.deepEqual(s1.adoptedOrder, ['p1', 'p2', 'p4']);
  assert.equal(project.planeMap.has('p3a'), false);
  assert.equal(store.has('p3b'), false, '検討案の IDB 行も消えている');
  assert.equal(project.activePlaneId, 'p4');
  assert.equal(project.planeMap.get('p4').elevation, 6000, '上の階の振り直し');
  // 階削除で他の階の階段は消さない（S3）。階段は p2 に残り、STAIR_VOID は新しい直上階 p4 へ付く（既存階 p4 のバイト列の差分として戻ること）
  assert.equal(decode(project, store, 'p2').stairs.length, 1, '直下階(p2)の階段は残る');
  assert.ok(!c.diff.changedSiblings.some(r => r.planeId === 'p2'), 'p2 のバイト列は変わらない');
  assert.equal(project.activePlaneId, 'p4');
  assert.equal(project.activeGraph.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID).length, 1, '新しい直上階 p4（表示中）に吹抜け');
  assert.ok(c.diff.changedSiblings.some(r => r.planeId === 'p4'), 'p4 のバイト列の差分が記録されている');

  await c.undo();
  assertSameSnapshot(await snapshot(project, store), s0, 'undo');
  assert.equal(project.activePlaneId, 'p3', 'undo の後は復活した階を表示する（Q11）');
  assert.equal(decode(project, store, 'p2').stairs.length, 1, 'p2 の階段が戻る');
  assert.ok(decode(project, store, 'p2').rooms.some(r => r.feature === RoomFeature.STAIR), 'p2 のペア部屋が戻る');
  assert.ok(decode(project, store, 'p3a') && project.planeMap.get('p3a').planCutHeightMm === 1200, '検討案の切断高が戻る');
  assert.equal(decode(project, store, 'p4').rooms.filter(r => r.feature === RoomFeature.STAIR_VOID).length, 0, 'p4 に付いた吹抜けは undo で消える');

  await c.redo();
  assertSameSnapshot(await snapshot(project, store), s1, 'redo');
  assert.equal(project.activePlaneId, 'p4', 'redo の後は最初の削除後と同じ階を表示する');
  assert.equal(store.has('p3'), false);

  await c.undo();
  assertSameSnapshot(await snapshot(project, store), s0, '2回目の undo');
  assert.equal(project.activePlaneId, 'p3');
});

test('redo: 別の階(p1)を表示中でも対象は消え、表示は最初の削除後の階へ戻る。対象を表示中なら退避してから消す', async () => {
  const { project, store, app } = await setup('p3');
  const c = await app.deleteFloor('p3');
  const s1 = await snapshot(project, store);
  await c.undo();
  await app.switchRaw('p1'); // 復活した p3 から p1 へ移ってから redo
  app.log.switches.length = 0;
  await c.redo();
  assertSameSnapshot(await snapshot(project, store), s1, 'p1 表示中の redo');
  assert.deepEqual(app.log.switches, [], '対象を表示していないので退避の切替はしない');
  assert.equal(project.activePlaneId, 'p4');
});

test('階削除で他の階の階段を消さない（S3）: 中間階(p3)→最上階(p4)と続けて削除しても p2 の階段とペア部屋は残り、STAIR_VOID は新しい直上階に付く。2回分を逆順に undo で完全に戻る', async () => {
  const { project, store, app } = await setup('p3');
  // fixture の p2 は初回の「表示→退避」で一度だけバイト列が正規化される（以後は冪等）。比較の基準を先に揃える
  await app.switchRaw('p2');
  await app.switchRaw('p3');
  const s0 = await snapshot(project, store);
  const stairRoomOk = (g) => g.stairs.length === 1
    && g.roomMap.get(g.stairs[0].roomId)?.feature === RoomFeature.STAIR;
  assert.ok(stairRoomOk(decode(project, store, 'p2')), '前提: p2 の階段にペア部屋がある');

  const c1 = await app.deleteFloor('p3'); // 中間階。p4 が p2 の直上階になる
  assert.ok(c1);
  const s1 = await snapshot(project, store);
  assert.ok(stairRoomOk(decode(project, store, 'p2')), '中間階の削除後も p2 の階段とペア部屋は残る');
  assert.ok(floorBytesEqual(store.get('p2'), s0.bytes.get('p2')), 'p2 のバイト列は不変');
  assert.equal(project.activePlaneId, 'p4');
  assert.equal(project.activeGraph.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID).length, 1, '新しい直上階 p4 に吹抜け');

  const c2 = await app.deleteFloor('p4'); // 最上階。直下階は p2 になる
  assert.ok(c2);
  assert.deepEqual((await snapshot(project, store)).adoptedOrder, ['p1', 'p2']);
  assert.ok(stairRoomOk(decode(project, store, 'p2')), '最上階の削除後も直下階 p2 の階段とペア部屋は残る');
  assert.ok(floorBytesEqual(store.get('p2'), s0.bytes.get('p2')), 'p2 のバイト列は不変');

  await c2.undo();
  assertSameSnapshot(await snapshot(project, store), s1, '最上階の undo');
  await c2.redo();
  assert.ok(stairRoomOk(decode(project, store, 'p2')), 'redo 後も p2 の階段は残る');
  await c2.undo();
  await c1.undo();
  assertSameSnapshot(await snapshot(project, store), s0, '中間階の undo');
  assert.ok(stairRoomOk(decode(project, store, 'p2')));
  assert.equal(decode(project, store, 'p4').rooms.filter(r => r.feature === RoomFeature.STAIR_VOID).length, 0, 'p4 の吹抜けは元どおり無い');
});

test('階削除で直下階の検討案の階段・ペア部屋も消さない（S3。旧 stairsBelowRemoval は直下の採用階＋その検討案を消していた）', async () => {
  const { project, store, app } = await setup('p3');
  // 直下の階 p2 の検討案 p2a に階段＋ペア部屋を作る（アクティブ階 p3 は触らない）
  const { graph: altGraph } = project.addPlane(3000, '2階#a', 'p2a', 2, 1, true, 'p2', 0, false, null);
  addPerFloorV([altGraph]);
  const placed = placeStair(project, altGraph);
  runInAction(() => { project.activePlaneId = 'p3'; });
  store.set('p2a', serializeGraph(altGraph));
  altGraph.clearFloorData();
  const altBefore = store.get('p2a');
  const altCheck = () => {
    const g = decode(project, store, 'p2a');
    return g.stairs.length === 1 && g.roomMap.get(g.stairs[0].roomId)?.feature === RoomFeature.STAIR;
  };
  assert.ok(placed.room && altCheck(), '前提: 検討案 p2a に階段とペア部屋がある');

  const c = await app.deleteFloor('p3'); // 中間階。直下の階は p2（検討案 p2a を持つ）
  assert.ok(c);
  assert.ok(altCheck(), '検討案の階段とペア部屋は残る');
  assert.ok(floorBytesEqual(store.get('p2a'), altBefore), '検討案のバイト列は不変');
  assert.ok(!c.diff.changedSiblings.some(r => r.planeId === 'p2a'), 'p2a は undo の差分にも入らない');
  assert.equal(decode(project, store, 'p2').stairs.length, 1, '直下の採用階の階段も残る');
});

test('最上階(p4)の削除 → undo → redo:最上階の階高(topStoryHeightMm)・新しい最上階のメタが往復し、undo 後は p4 を表示する', async () => {
  const { project, store, app } = await setup('p4');
  const s0 = await snapshot(project, store);
  const c = await app.deleteFloor('p4');
  assert.ok(c);
  const s1 = await snapshot(project, store);
  assert.deepEqual(s1.adoptedOrder, ['p1', 'p2', 'p3']);
  assert.notEqual(project.planeMap.get('p3').topStoryHeightMm, undefined);
  assert.equal(project.activePlaneId, 'p3');

  await c.undo();
  assertSameSnapshot(await snapshot(project, store), s0, '最上階 undo');
  assert.equal(project.planeMap.get('p4').topStoryHeightMm, 2600);
  assert.equal(project.activePlaneId, 'p4');
  await c.redo();
  assertSameSnapshot(await snapshot(project, store), s1, '最上階 redo');
});

test('削除前の編集の undo エントリ（graph インスタンスを掴む本番と同じ形）が、削除→undo→(redo→undo) の後も復活した階に効く。Plane／PlanGraph は同一インスタンス', async () => {
  const { project, store, app } = await setup('p3');
  const plane3 = project.planeMap.get('p3');
  const g = project.activeGraph;
  const alt = project.graphMap.get('p3a');
  // 本番の編集 undo と同形: 編集前のスナップショットを取り、エントリは graph を掴んで restoreGraph する
  const editBefore = serializeGraph(g);
  const clBefore = g.centerLines.length;
  g.addCenterLine(CenterLineType.VERTICAL, 777, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(g.centerLines.length, clBefore + 1);
  const editUndoEntry = () => restoreGraph(g, editBefore);

  const c = await app.deleteFloor('p3');
  assert.ok(c);
  await c.undo();
  // 失敗時に巨大なグラフの差分整形で固まらないよう、インスタンスの同一性は === を assert.ok で見る
  assert.ok(project.graphMap.get('p3') === g, 'PlanGraph が同一インスタンス');
  assert.ok(project.planeMap.get('p3') === plane3, 'Plane が同一インスタンス');
  assert.ok(project.graphMap.get('p3a') === alt, '検討案も同一インスタンス');
  assert.ok(project.activeGraph === g, '復活した階が同一インスタンスでアクティブ');
  assert.equal(g.centerLines.length, clBefore + 1, '復活した階の中身は編集後のまま');
  editUndoEntry();
  assert.equal(g.centerLines.length, clBefore, '編集の undo が復活した階に効く');

  // redo → undo でも同じインスタンスへ戻る
  g.addCenterLine(CenterLineType.VERTICAL, 777, { labeled: false, discipline: Discipline.ARCH });
  await c.redo();
  assert.equal(project.graphMap.has('p3'), false);
  await c.undo();
  assert.ok(project.graphMap.get('p3') === g, 'redo→undo でも同一インスタンス');
  editUndoEntry();
  assert.equal(g.centerLines.length, clBefore);
  assert.equal(store.has('p3'), true);
});

test('屋根専用平面(p4 に乗る): 中間階(p3)の削除で p4 が下がると屋根も追従し、undo／redo／undo で roofForPlaneId と elevation が往復する。最上階(p4)の削除では屋根は p4 のまま（作り直しは構造モード突入時）で往復しても不変', async () => {
  const { project, app } = await setup('p3');
  project.addPlane(project.planeMap.get('p4').elevation + 1, '小屋伏', 'roof', 4, 1, false, null, 0, true, 'p4');
  const roofState = () => [project.roofPlane.roofForPlaneId, project.roofPlane.elevation];
  const top0 = project.planeMap.get('p4').elevation;
  assert.deepEqual(roofState(), ['p4', top0 + 1]);
  const c = await app.deleteFloor('p3');
  assert.ok(c);
  const top1 = project.planeMap.get('p4').elevation;
  assert.ok(top1 < top0, '前提: p4 が下がる');
  assert.deepEqual(roofState(), ['p4', top1 + 1], '削除で屋根が追従');
  await c.undo();
  assert.deepEqual(roofState(), ['p4', top0 + 1], 'undo で戻る');
  await c.redo();
  assert.deepEqual(roofState(), ['p4', top1 + 1]);
  await c.undo();
  assert.deepEqual(roofState(), ['p4', top0 + 1]);

  // 最上階の削除: followRoofPlaneToTop は最上階 id が変わると何もしない（屋根平面は階操作 undo の対象外）。往復で不変
  await app.switchRaw('p4');
  const c2 = await app.deleteFloor('p4');
  assert.ok(c2);
  assert.deepEqual(roofState(), ['p4', top0 + 1]);
  await c2.undo();
  assert.deepEqual(roofState(), ['p4', top0 + 1]);
});

test('【失敗系】退避の階切替が失敗したら中断し、何も変えず undo を積まない（null）', async () => {
  const { project, store } = await setup('p3');
  const app = makeApp(project, store, { failSwitch: true });
  const s0 = await snapshot(project, store);
  const c = await app.deleteFloor('p3');
  assert.equal(c, null, 'undo エントリを積まない');
  assertSameSnapshot(await snapshot(project, store), s0, '中断');
  assert.equal(project.activePlaneId, 'p3');
  assert.deepEqual(app.log.switches, ['p4']);
});

test('【失敗系】removeFloor の IDB 削除が途中で失敗（p3・p3a は消え p3b で失敗）→ 巻き戻して例外を伝える。IDB の行も元へ', async () => {
  const { project, store } = await setup('p3');
  const app = makeApp(project, store, { removeFailsAt: 'p3b' });
  const s0 = await snapshot(project, store);
  await assert.rejects(app.deleteFloor('p3'), /IDB delete failed: p3b/);
  const s = await snapshot(project, store);
  assert.deepEqual(s.planes, s0.planes, '平面は全て残っている');
  for (const id of ['p3', 'p3a', 'p3b']) {
    assert.ok(floorBytesEqual(store.get(id), s0.bytes.get(id)), `${id} の IDB 行が書き戻されている`);
  }
  assert.equal(decode(project, store, 'p2').stairs.length, 1);
});

test('【失敗系】removePlane の後で追従が失敗 → 消えた採用階・検討案を同じ id で作り直し、変わった既存階(p2)のバイト列・メタも戻す', async () => {
  const { project, store } = await setup('p3');
  const app = makeApp(project, store);
  const s0 = await snapshot(project, store);
  const boom = { name: 'boom', appliesTo: [FLOOR_ORDER_KIND.DELETE], run() { throw new Error('follower failed'); } };
  await assert.rejects(app.deleteFloor('p3', { extraFollowers: [boom] }), /follower failed/);
  assert.equal(project.planeMap.has('p3'), true, '削除が取り消されている');
  const s = await snapshot(project, store);
  assert.deepEqual(s.planes, s0.planes, 'メタ（p4 の振り直しも）');
  assert.deepEqual(s.adoptedOrder, s0.adoptedOrder);
  for (const id of ['p2', 'p3', 'p3a', 'p3b', 'p1', 'p4']) {
    assert.ok(floorBytesEqual(store.get(id), s0.bytes.get(id)), `${id} のバイト列が戻っている`);
  }
  assert.equal(decode(project, store, 'p2').stairs.length, 1, 'p2 の階段は残っている');
});

test('diffFloorOpSnapshot: removalBefore のうち操作後に無い id が removedPlanes。削除だけでも hasChanges。existingIdsAfter が無いと throw', () => {
  const metas = [{ id: 'a', name: 'A', startFloor: 1, elevation: 0, stories: 1 }];
  const bytes = new Map([['a', new Uint8Array([1])]]);
  const removalBefore = [{ id: 'x', isAlternative: false }, { id: 'y', isAlternative: true }];
  const d = diffFloorOpSnapshot({
    before: bytes, after: bytes, metasBefore: metas, metasAfter: metas, removalBefore, existingIdsAfter: new Set(['a', 'y']),
  });
  assert.deepEqual(d.removedPlanes.map(r => r.id), ['x']);
  assert.equal(d.hasChanges, true);
  const none = diffFloorOpSnapshot({ before: bytes, after: bytes, metasBefore: metas, metasAfter: metas });
  assert.deepEqual(none.removedPlanes, []);
  assert.equal(none.hasChanges, false);
  assert.throws(() => diffFloorOpSnapshot({
    before: bytes, after: bytes, metasBefore: metas, metasAfter: metas, removalBefore,
  }), /existingIdsAfter/);
});

test('collectRemovalRecords: 採用階以外・存在しない id は空。採用階→検討案(altIndex昇順)の順で全メタ項目とバイト列を採る', async () => {
  const { project, store } = await setup('p3');
  const getBytes = async (id) => (id === project.activePlaneId ? serializeGraph(project.activeGraph) : store.get(id) ?? null);
  assert.deepEqual(await collectRemovalRecords(project, 'p3a', getBytes), []);
  assert.deepEqual(await collectRemovalRecords(project, 'nope', getBytes), []);
  const recs = await collectRemovalRecords(project, 'p3', getBytes);
  assert.deepEqual(recs.map(r => [r.id, r.isAlternative, r.referenceId, r.altIndex]),
    [['p3', false, null, 0], ['p3a', true, 'p3', 0], ['p3b', true, 'p3', 1]]);
  assert.equal(recs[1].planCutHeightMm, 1200);
  assert.ok(recs.every(r => r.bytes instanceof Uint8Array));
});

test('【失敗系】restoreRemovedPlanes: 親の採用階が無い検討案は throw。既に在る id は触らない（再入しても重複しない）', async () => {
  const { project, store, app } = await setup('p3');
  const getBytes = async (id) => (id === project.activePlaneId ? serializeGraph(project.activeGraph) : store.get(id) ?? null);
  const recs = await collectRemovalRecords(project, 'p3', getBytes);
  // 既存の id は何もしない
  await app.restoreRemoved(project, recs);
  assert.equal([...project.planeMap.values()].filter(p => p.id.startsWith('p3')).length, 3);
  // 親(p3)だけを除いて検討案を作ろうとする
  await assert.rejects(app.restoreRemoved(project, [{ ...recs[1], id: 'orphan', referenceId: 'gone', plane: undefined, graph: undefined }]), /親の採用階 gone/);
});

test('removePlanesForRedo: 対象を表示中に退避できなければ false（removeFloor を呼ばない）。pickRemovalFallback は preferred を優先し、対象・その検討案は選ばない', async () => {
  const { project, store } = await setup('p3');
  const calls = [];
  const rec = [{ id: 'p3', isAlternative: false }];
  const ok = await removePlanesForRedo(project, rec, 'p4', {
    removeFloorFn: async (id) => calls.push(['remove', id]), switchTo: async (id) => calls.push(['switch', id]),
  });
  assert.equal(ok, false, '切替が効かない（アクティブ階のまま）→ 中断');
  assert.deepEqual(calls, [['switch', 'p4']]);

  assert.equal(pickRemovalFallback(project, 'p3', 'p4'), 'p4');
  assert.equal(pickRemovalFallback(project, 'p3', 'p3a'), 'p4', '対象の検討案は選ばない（直上の採用階）');
  assert.equal(pickRemovalFallback(project, 'p3', 'p3'), 'p4');
  assert.equal(pickRemovalFallback(project, 'p4', undefined), 'p3', '最上階は直下');
  assert.equal(store.has('p3'), true);
});

// ---- 配線（App.jsx／store.js はテストから import できないためソース走査。コメントの言及と区別するため行頭コメントを除く）----
test('【配線】App.jsx: runDeleteFloor は beginUiTransition → withFloorOpUndo(\'階削除\') ＋ rollbackOnError・removalTarget。runBusy を直接持たない', () => {
  const body = stripCommentLines(extractFunctionBody(readAppSrc(), 'async function runDeleteFloor'));
  assert.match(body, /^\s*beginUiTransition\(\);\s*$/m);
  assert.match(body, /await withFloorOpUndo\('階削除', async \(\) => \{/);
  assert.match(body, /\}, \{ rollbackOnError: true, removalTarget: planeId \}\);/);
  assert.doesNotMatch(body, /runBusy\(/);
});

test('【配線】App.jsx: withFloorOpUndo は removalBefore を採って diff（existingIdsAfter 付き）と rollbackFloorOp（restoreRemoved 付き）へ渡す', () => {
  const body = stripCommentLines(extractFunctionBody(readAppSrc(), 'async function withFloorOpUndo'));
  assert.match(body, /const removalBefore = removalTarget \? await collectRemovalRecords\(project, removalTarget, readPlaneBytes\) : \[\];/);
  assert.match(body, /removalBefore, existingIdsAfter: new Set\(project\.planeMap\.keys\(\)\),/);
  assert.match(body, /removalBefore, restoreRemoved,/);
  // before の採取は run の前
  assert.ok(body.indexOf('const removalBefore') < body.indexOf('await run();'));
});

test('【配線】App.jsx: undoFloorOp は removedPlanes を作り直し（metas の前）、復活した採用階へ切り替える。redoFloorOp は removePlanesForRedo を metas の前に呼ぶ', () => {
  const src = readAppSrc();
  const undoBody = stripCommentLines(extractFunctionBody(src, 'async function undoFloorOp'));
  const iRestore = undoBody.indexOf('await restoreRemoved(project, removedPlanes);');
  const iMetas = undoBody.indexOf('applyPlaneMetas(project, metasBefore);');
  assert.ok(iMetas >= 0 && iMetas < iRestore, '既存階のメタを戻してから restoreRemoved（同じ elevation で並ぶ窓を作らない）');
  assert.match(undoBody, /const revivedId = removedPlanes\.find\(r => !r\.isAlternative\)\?\.id;/);
  assert.match(undoBody, /await trySwitchFloor\(\(\) => handleFloorSwitch\(revivedId\)\);/);
  assert.ok(undoBody.indexOf('followRoofPlaneToTop(project)') < undoBody.indexOf('handleFloorSwitch(revivedId)'), '切替は最後（followRoof の後）');
  const redoBody = stripCommentLines(extractFunctionBody(src, 'async function redoFloorOp'));
  const iRemove = redoBody.indexOf('await removePlanesForRedo(project, removedPlanes, activeAfterId');
  assert.ok(iRemove >= 0 && iRemove < redoBody.indexOf('applyPlaneMetas(project, metasAfter);'), 'removePlanesForRedo が metas の前にない');
  assert.match(redoBody, /if \(!removed\) return;/);
});

test('【配線】App.jsx: restoreRemoved は復活の後に removeFloor と同じ3つのキャッシュ(memberNumber／openingNumber／equipment)を捨てる', () => {
  const src = stripCommentLines(readAppSrc());
  const i = src.indexOf('const restoreRemoved = async (proj, records) => {');
  assert.ok(i >= 0);
  const body = src.slice(i, src.indexOf('};', i));
  const iRestore = body.indexOf('await restoreRemovedPlanes(');
  for (const fn of ['clearMemberNumberIndex', 'clearOpeningNumberIndex', 'clearEquipmentIndex']) {
    assert.ok(body.indexOf(`proj.${fn}()`) > iRestore, `${fn} を復活の後に呼ぶ`);
  }
});

test('【配線】store.js: addAlternativeFloor は planeId と altIndex を addPlane へ渡す（階削除 undo が検討案を同じ id・並びで作り直す）。省略時は従来どおり新規発番＋既存の検討数', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'store.js'), 'utf8');
  const body = stripCommentLines(extractFunctionBody(src, 'export function addAlternativeFloor'));
  assert.match(body, /const newPlaneId = planeId;/);
  assert.match(body, /true, referenceId, altIndex \?\? altCount,/);
  assert.match(src, /addAlternativeFloor\(referenceId, name, sourcePlane = undefined, planeId = crypto\.randomUUID\(\), altIndex = undefined\)/);
});
