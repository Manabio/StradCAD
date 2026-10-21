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
  computeFloorInsert, computeFloorAddLowerElevations, removeAddedPlanesForUndo, addedPlaneRedoRecords,
  collectAlternativeMetas, promoteAlternative, applyAltRoleState, collectAltRoleState,
} from './floorOps.js';
import { followRoofPlaneToTop, syncRoofPlane } from './structural/roofPlane.js';
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

  /**
   * withFloorOpUndo('階追加') ＋ executeAddUpper／handleAddFloorConfirm と同じ順。kind は INSERT（表示中の階の直上へ1階）
   * か ADD_LOWER（最下階の下へ n 階）。follower は [] を渡す（階段・EV の写しや構造反映はこのハーネスの範囲外。新階への
   * 切替は switchToAddedFloor follower の代わりに switchRaw で行う）。{ undo, redo, added, metasAfter, diff } を返す。
   */
  async function addFloors(kind, { n = 1 } = {}) {
    const sourcePlaneId = project.activePlaneId;
    const before = await collect();
    const metasBefore = collectPlaneMetas(project);
    const levelsBefore = collectProjectLevels(project);
    const current = project.activePlane;
    const topHeightMm = resolveTopStoryHeightMm(project);
    let updates = [];
    let addPlane;
    if (kind === FLOOR_ORDER_KIND.INSERT) {
      const insert = computeFloorInsert(project.planes, current.id, 1, { topHeightMm });
      const { newPlane } = insert;
      updates = insert.updates;
      addPlane = () => addFloor(newPlane.elevation, newPlane.name, newPlane.startFloor, newPlane.stories, undefined,
        newPlane.planCutHeightMm, newPlane.ceilingCutHeightMm, newPlane.topStoryHeightMm);
    } else {
      const elevations = computeFloorAddLowerElevations(project.planes, n, { topHeightMm });
      addPlane = () => {
        const planes = [];
        for (let i = 1; i <= n; i++) {
          planes.push(addFloor(elevations[i - 1], `地下${i}階`, -i, 1, undefined, current.planCutHeightMm, current.ceilingCutHeightMm).plane);
        }
        return { plane: planes[planes.length - 1], planes };
      };
    }
    const { addedPlane } = await applyFloorOrderChange(project, { kind, updates, addPlane, sourceGraph: project.activeGraph, ui }, []);
    await switchRaw(addedPlane.id);

    const activeAfterId = project.activePlaneId;
    const after = await collect();
    const metasAfter = collectPlaneMetas(project);
    const levelsAfter = collectProjectLevels(project);
    const diff = diffFloorOpSnapshot({ before, after, metasBefore, metasAfter, levelsBefore, levelsAfter });
    const { addedPlanes, changedSiblings } = diff;
    const addedBytes = new Map(addedPlanes.map(pl => [pl.id, after.get(pl.id) ?? null]));
    const taken = [];

    // App.jsx undoFloorOp の状態部分と同じ順
    async function undo() {
      taken.length = 0; // 早期 return より前（中断した undo の後の redo に前回の記録を残さない）
      if (addedPlanes.some(pl => pl.id === project.activePlaneId)) {
        const backId = project.planeMap.has(sourcePlaneId) ? sourcePlaneId : project.planes.find(p => !addedPlanes.some(pl => pl.id === p.id))?.id;
        await trySwitch(backId);
        if (addedPlanes.some(pl => pl.id === project.activePlaneId)) return;
      }
      await removeAddedPlanesForUndo(project, addedPlanes, { getBytes: readBytes, removeFloorFn, taken });
      applyPlaneMetas(project, metasBefore);
      applyProjectLevels(project, levelsBefore);
      for (const rec of changedSiblings) applyBytes(rec.planeId, rec.before);
      followRoof(project);
    }
    // App.jsx redoFloorOp の状態部分と同じ順
    async function redo() {
      applyPlaneMetas(project, metasAfter);
      applyProjectLevels(project, levelsAfter);
      await restoreRemoved(project, addedPlaneRedoRecords(addedPlanes, taken, addedBytes));
      for (const rec of changedSiblings) applyBytes(rec.planeId, rec.after);
      followRoof(project);
      if (activeAfterId !== project.activePlaneId) await switchRaw(activeAfterId);
    }
    return { undo, redo, added: addedPlanes, metasAfter, diff };
  }

  /**
   * withFloorOpUndo（検討案追加／検討案削除）と同じ順。run の前に removalBefore・altsBefore を採り（removalTarget があれば
   * 失敗時に rollbackFloorOp）、run の後に diff（altsBefore／altsAfter 付き）を取る。積むものが無ければ null、
   * あれば { undo, redo, diff }。undo／redo は App.jsx undoFloorOp／redoFloorOp の状態部分と同じ順。
   */
  async function altOp(run, { removalTarget } = {}) {
    const sourcePlaneId = project.activePlaneId;
    const before = await collect();
    const metasBefore = collectPlaneMetas(project);
    const levelsBefore = collectProjectLevels(project);
    const altsBefore = collectAlternativeMetas(project);
    const removalBefore = removalTarget ? await collectRemovalRecords(project, removalTarget, readBytes) : [];
    try { await run(); } catch (err) {
      if (removalTarget) {
        await rollbackFloorOp(project, {
          before, metasBefore, levelsBefore, collectBytes: collect, followRoof, removalBefore, restoreRemoved,
          applyBytes: (_p, id, b) => applyBytes(id, b), saveFloorFn, deleteFloorFn: async (id) => { store.delete(id); },
        }).catch(() => {});
      }
      throw err;
    }
    const activeAfterId = project.activePlaneId;
    const after = await collect();
    const metasAfter = collectPlaneMetas(project);
    const levelsAfter = collectProjectLevels(project);
    const altsAfter = collectAlternativeMetas(project);
    const diff = diffFloorOpSnapshot({
      before, after, metasBefore, metasAfter, levelsBefore, levelsAfter,
      removalBefore, existingIdsAfter: new Set(project.planeMap.keys()), altsBefore, altsAfter,
    });
    if (!diff.hasChanges) return null;
    const { addedPlanes, removedPlanes, changedSiblings } = diff;
    const addedBytes = new Map(addedPlanes.map(pl => [pl.id, after.get(pl.id) ?? null]));
    const addedTaken = [];

    async function undo() {
      addedTaken.length = 0;
      if (addedPlanes.some(pl => pl.id === project.activePlaneId)) {
        const backId = project.planeMap.has(sourcePlaneId)
          ? sourcePlaneId
          : project.planes.find(p => !addedPlanes.some(pl => pl.id === p.id))?.id;
        if (!backId) return;
        await trySwitch(backId);
        if (addedPlanes.some(pl => pl.id === project.activePlaneId)) return;
      }
      await removeAddedPlanesForUndo(project, addedPlanes, { getBytes: readBytes, removeFloorFn, taken: addedTaken });
      applyPlaneMetas(project, metasBefore);
      await restoreRemoved(project, removedPlanes);
      applyProjectLevels(project, levelsBefore);
      for (const rec of changedSiblings) applyBytes(rec.planeId, rec.before);
      followRoof(project);
      const revivedId = (removedPlanes.find(r => !r.isAlternative) ?? removedPlanes[0])?.id;
      if (revivedId && project.planeMap.has(revivedId)) await trySwitch(revivedId);
    }
    async function redo() {
      const removed = await removePlanesForRedo(project, removedPlanes, activeAfterId, { removeFloorFn, switchTo: trySwitch });
      if (!removed) return;
      applyPlaneMetas(project, metasAfter);
      applyProjectLevels(project, levelsAfter);
      await restoreRemoved(project, addedPlaneRedoRecords(addedPlanes, addedTaken, addedBytes));
      for (const rec of changedSiblings) applyBytes(rec.planeId, rec.after);
      followRoof(project);
      if (activeAfterId !== project.activePlaneId) await switchRaw(activeAfterId);
    }
    return { undo, redo, diff, addedPlanes };
  }

  /** runAddAlternative／runCopyAlternative の本体と同じ順（直列化 → 追加 → 切替 → 複製元の書き戻し）を altOp で包む。 */
  async function addAlt(refId, { copy = false, sourcePlane } = {}) {
    return altOp(async () => {
      const bytes = copy ? serializeGraph(project.activeGraph) : null;
      const result = addAlternativeFloor(refId, `alt#${crypto.randomUUID().slice(0, 4)}`, sourcePlane);
      if (!result) return;
      if (!(await trySwitch(result.plane.id))) return;
      if (bytes) restoreGraph(project.activeGraph, bytes);
    });
  }

  /** runDeleteAlternative の本体と同じ順（表示中なら親へ退避 → 再判定 → removeFloor）を altOp で包む。 */
  async function deleteAlt(planeId) {
    return altOp(async () => {
      if (project.activePlaneId === planeId) {
        const fallback = project.planeMap.get(project.planeMap.get(planeId).referenceId);
        if (fallback) await trySwitch(fallback.id);
        if (project.activePlaneId === planeId) return;
      }
      await removeFloorFn(planeId);
    }, { removalTarget: planeId });
  }

  /** App.jsx runPromoteAlternative と同じ形（promoteAlternative → undo／redo は applyAltRoleState）。変化なしは null。 */
  function promote(planeId) {
    const changed = promoteAlternative(project, planeId);
    if (!changed) return null;
    return {
      changed,
      undo: () => applyAltRoleState(project, changed.before),
      redo: () => applyAltRoleState(project, changed.after),
    };
  }

  return { log, switchRaw, readBytes, deleteFloor, addFloors, removeFloorFn, addFloor, addAlternativeFloor, restoreRemoved, addAlt, deleteAlt, promote };
}

/** 表示中の階の graph へ中心線を1本足す編集と、それを掴む undo エントリ（App.jsx cl-extend と同じ: graph インスタンスへ restoreGraph）。 */
function editActiveGraph(project, value = 777) {
  const g = project.activeGraph;
  const b = serializeGraph(g);
  g.addCenterLine(CenterLineType.VERTICAL, value, { labeled: false, discipline: Discipline.ARCH });
  const a = serializeGraph(g);
  return { g, undo: () => restoreGraph(g, b), redo: () => restoreGraph(g, a) };
}
const hasLine = (g, value) => g.centerLines.some(c => c.value === value);

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

test('屋根専用平面(p4 に乗る): 中間階(p3)の削除で p4 が下がると屋根も追従し、undo／redo／undo で roofForPlaneId と elevation が往復する。最上階(p4)の削除では屋根は作り直さず p3 へ付け替わり、undo で p4、redo で p3', async () => {
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

  // 最上階の削除: 屋根は作り直さず 1つ下の p3 へ付け替わり、undo で復活した p4 へ付け替え直る（紐づけは並びから決まる）
  await app.switchRaw('p4');
  const roofId = project.roofPlane.id;
  const c2 = await app.deleteFloor('p4');
  assert.ok(c2);
  const top2 = project.planeMap.get('p3').elevation;
  assert.deepEqual(roofState(), ['p3', top2 + 1], '削除で 1つ下の最上階 p3 へ');
  assert.equal(project.roofPlane.id, roofId, '作り直さない');
  await c2.undo();
  assert.deepEqual(roofState(), ['p4', top0 + 1], 'undo で復活した p4 へ');
  await c2.redo();
  assert.deepEqual(roofState(), ['p3', top2 + 1], 'redo で p3');
  await c2.undo();
  assert.deepEqual(roofState(), ['p4', top0 + 1], 'もう1回 undo で p4');
});

test('【失敗系】最上階(p4)の削除で follower が失敗 → 巻き戻しで屋根専用平面の紐づけが復活した p4 へ戻る', async () => {
  const { project, store } = await setup('p3');
  project.addPlane(project.planeMap.get('p4').elevation + 1, '小屋伏', 'roof', 4, 1, false, null, 0, true, 'p4');
  const app = makeApp(project, store);
  await app.switchRaw('p4');
  const top0 = project.planeMap.get('p4').elevation;
  const boom = { name: 'boom', appliesTo: [FLOOR_ORDER_KIND.DELETE], run() { throw new Error('follower failed'); } };
  await assert.rejects(app.deleteFloor('p4', { extraFollowers: [boom] }), /follower failed/);
  assert.equal(project.planeMap.has('p4'), true, '削除が取り消されている');
  assert.equal(project.roofPlane.roofForPlaneId, 'p4');
  assert.equal(project.roofPlane.elevation, top0 + 1);
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

test('collectRemovalRecords: 存在しない id は空、検討案の id はその1件。採用階→検討案(altIndex昇順)の順で全メタ項目とバイト列を採る', async () => {
  const { project, store } = await setup('p3');
  const getBytes = async (id) => (id === project.activePlaneId ? serializeGraph(project.activeGraph) : store.get(id) ?? null);
  assert.deepEqual((await collectRemovalRecords(project, 'p3a', getBytes)).map(r => r.id), ['p3a'], '検討案は単独で消える');
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

// ---- 階追加の undo/redo は追加した階を同じインスタンスで戻す（追加した階での編集の redo/undo が空振りしない）----
test('T1 INSERT: 新しい階で編集 → 編集 undo → 追加 undo → 追加 redo で同じ Plane／graph が戻り、編集の redo が表示中の階に出る', async () => {
  const { project, app } = await setup('p3');
  const c = await app.addFloors(FLOOR_ORDER_KIND.INSERT);
  const [added] = c.added;
  const plane = project.planeMap.get(added.id);
  const g = project.activeGraph;
  assert.equal(project.activePlaneId, added.id, '追加した階を表示している');
  assert.ok(g === project.graphMap.get(added.id));
  const e = editActiveGraph(project);
  assert.ok(hasLine(g, 777));

  e.undo();
  assert.ok(!hasLine(g, 777));
  await c.undo();
  assert.equal(project.planeMap.has(added.id), false, '追加階が消えた');
  assert.equal(project.activePlaneId, 'p3');
  await c.redo();
  assert.ok(project.planeMap.get(added.id) === plane, 'Plane が同一インスタンス');
  assert.ok(project.graphMap.get(added.id) === g, 'graph が同一インスタンス');
  assert.ok(project.activeGraph === g && project.activePlaneId === added.id, 'redo 後は追加階を表示し activeGraph が元の graph');
  e.redo();
  assert.ok(hasLine(project.activeGraph, 777), '編集の redo が表示中の階に出る');
  e.undo();
  assert.ok(!hasLine(project.activeGraph, 777), '編集の undo も表示中の階に効く');
});

test('T2 往復2回: undo→redo→undo→redo の毎回で同じ Plane／graph。2巡目の後も編集の redo/undo が効く', async () => {
  const { project, app } = await setup('p3');
  const c = await app.addFloors(FLOOR_ORDER_KIND.INSERT);
  const id = c.added[0].id;
  const plane = project.planeMap.get(id);
  const g = project.activeGraph;
  const e = editActiveGraph(project);
  for (let lap = 1; lap <= 2; lap++) {
    e.undo();
    await c.undo();
    assert.equal(project.planeMap.has(id), false, `${lap}巡目の undo で消える`);
    await c.redo();
    assert.ok(project.planeMap.get(id) === plane, `${lap}巡目: Plane 同一`);
    assert.ok(project.graphMap.get(id) === g, `${lap}巡目: graph 同一`);
    assert.ok(project.activeGraph === g, `${lap}巡目: activeGraph 同一`);
    e.redo();
    assert.ok(hasLine(project.activeGraph, 777), `${lap}巡目: 編集の redo が出る`);
  }
  e.undo();
  assert.ok(!hasLine(project.activeGraph, 777), '2巡目の後も編集の undo が効く');
});

test('T3 ADD_LOWER n=2: 2平面とも同一インスタンスで戻る。非表示で after が null の階はメモリの中身（目印の中心線）を保つ', async () => {
  const { project, store, app } = await setup('p1');
  const c = await app.addFloors(FLOOR_ORDER_KIND.ADD_LOWER, { n: 2 });
  assert.equal(c.added.length, 2);
  const [lowest, upper] = c.added; // elevation 昇順: 地下2階（表示中）、地下1階（非表示）
  assert.equal(project.activePlaneId, lowest.id);
  assert.equal(store.has(upper.id), false, '非表示の追加階は IDB に無い（after のバイト列は null）');
  const planes = c.added.map(pl => project.planeMap.get(pl.id));
  const graphs = c.added.map(pl => project.graphMap.get(pl.id));
  graphs[1].addCenterLine(CenterLineType.VERTICAL, 888, { labeled: false, discipline: Discipline.ARCH });

  await c.undo();
  assert.deepEqual(c.added.map(pl => project.planeMap.has(pl.id)), [false, false]);
  await c.redo();
  c.added.forEach((pl, i) => {
    assert.ok(project.planeMap.get(pl.id) === planes[i], `${pl.name}: Plane 同一`);
    assert.ok(project.graphMap.get(pl.id) === graphs[i], `${pl.name}: graph 同一`);
  });
  assert.equal(project.activePlaneId, lowest.id);
  assert.ok(hasLine(graphs[1], 888), '非表示の追加階は一度も保存されておらず、メモリの中身が保たれる');
});

test('T3b ADD_LOWER: 非表示の追加階を後で訪れて離れた（IDB 保存）後の undo→redo は、undo 時の記録のバイト列で中身が戻る', async () => {
  const { project, store, app } = await setup('p1');
  const c = await app.addFloors(FLOOR_ORDER_KIND.ADD_LOWER, { n: 2 });
  const [lowest, upper] = c.added;
  const upperGraph = project.graphMap.get(upper.id);
  upperGraph.addCenterLine(CenterLineType.VERTICAL, 888, { labeled: false, discipline: Discipline.ARCH });
  await app.switchRaw(upper.id); // 訪れる
  await app.switchRaw(lowest.id); // 離れる（保存＋clearFloorData）
  assert.equal(hasLine(upperGraph, 888), false, '離れたので graph は空');
  assert.ok(store.has(upper.id), '離れたときに IDB へ保存された');

  await c.undo();
  assert.equal(store.has(upper.id), false);
  await c.redo();
  assert.ok(project.graphMap.get(upper.id) === upperGraph, 'graph 同一');
  assert.ok(store.has(upper.id), 'redo で記録のバイト列が IDB へ書かれる');
  assert.ok(decode(project, store, upper.id).centerLines.some(cl => cl.value === 888), '保存内容に目印の中心線がある');
});

test('T4 メタ: undo→redo の後、全採用階のメタが操作後（metasAfter）と一致する。追加階の最上階の階高・平面切断高を含む', async () => {
  const { project, app } = await setup('p4');
  project.planeMap.get('p4').planCutHeightMm = 1300; // 新階へ複製される値
  const c = await app.addFloors(FLOOR_ORDER_KIND.INSERT);
  const added = c.metasAfter.find(m => m.id === c.added[0].id);
  assert.equal(typeof added.topStoryHeightMm, 'number', '最上階に足したので新階は最上階の階高を持つ');
  assert.equal(added.planCutHeightMm, 1300);
  await c.undo();
  await c.redo();
  assert.deepEqual(collectPlaneMetas(project), c.metasAfter);
});

test('T5 検討案: 追加階に後から作った検討案も undo で消え、redo で同じインスタンス・referenceId・altIndex で戻る', async () => {
  const { project, app } = await setup('p3');
  const c = await app.addFloors(FLOOR_ORDER_KIND.INSERT);
  const id = c.added[0].id;
  const alt = app.addAlternativeFloor(id, '検討案A');
  alt.graph.addCenterLine(CenterLineType.VERTICAL, 555, { labeled: false, discipline: Discipline.ARCH });
  await c.undo();
  assert.equal(project.planeMap.has(alt.plane.id), false, '検討案も消える');
  await c.redo();
  assert.ok(project.planeMap.get(alt.plane.id) === alt.plane, '検討案 Plane 同一');
  assert.ok(project.graphMap.get(alt.plane.id) === alt.graph, '検討案 graph 同一');
  assert.equal(project.planeMap.get(alt.plane.id).referenceId, id);
  assert.equal(project.planeMap.get(alt.plane.id).altIndex, 0);
  assert.ok(hasLine(alt.graph, 555), '検討案のメモリ上の中身が保たれる');
});

test('【失敗系】F1 undo の退避切替が失敗（何も消えない）→ redo で追加階は重複作成されず、同じインスタンスのまま編集の redo が効く', async () => {
  const { project, store } = await setup('p3');
  const app = makeApp(project, store, { failSwitch: true });
  const c = await app.addFloors(FLOOR_ORDER_KIND.INSERT);
  const id = c.added[0].id;
  const plane = project.planeMap.get(id);
  const g = project.activeGraph;
  const n = project.planeMap.size;
  const e = editActiveGraph(project);
  e.undo();
  await c.undo();
  assert.ok(project.planeMap.get(id) === plane, '切替失敗で何も消えていない');
  assert.equal(project.activePlaneId, id);
  await c.redo();
  assert.equal(project.planeMap.size, n, '重複作成されない');
  assert.ok(project.planeMap.get(id) === plane && project.graphMap.get(id) === g, 'Plane／graph 同一');
  e.redo();
  assert.ok(hasLine(project.activeGraph, 777), '編集の redo が表示中の階に出る');
});

test('【失敗系】F2 ADD_LOWER n=2 で2つ目の removeFloor の IDB 削除が失敗 → undo は例外。redo で1つ目は同一インスタンスで戻り、2つ目は触らない', async () => {
  const { project, store } = await setup('p1');
  const opts = {};
  const app = makeApp(project, store, opts);
  const c = await app.addFloors(FLOOR_ORDER_KIND.ADD_LOWER, { n: 2 });
  const [first, second] = c.added;
  const planes = c.added.map(pl => project.planeMap.get(pl.id));
  const graphs = c.added.map(pl => project.graphMap.get(pl.id));
  graphs[1].addCenterLine(CenterLineType.VERTICAL, 888, { labeled: false, discipline: Discipline.ARCH });
  opts.removeFailsAt = second.id;
  await assert.rejects(c.undo(), /IDB delete failed/);
  assert.equal(project.planeMap.has(first.id), false, '1つ目は消えた');
  assert.equal(project.planeMap.has(second.id), true, '2つ目は残っている');
  const n = project.planeMap.size;
  await c.redo();
  assert.equal(project.planeMap.size, n + 1, '1つ目だけ戻り、重複作成なし');
  assert.ok(project.planeMap.get(first.id) === planes[0] && project.graphMap.get(first.id) === graphs[0], '1つ目: 同一インスタンス');
  assert.ok(project.planeMap.get(second.id) === planes[1] && project.graphMap.get(second.id) === graphs[1], '2つ目: 触らない');
  assert.ok(hasLine(graphs[1], 888), '2つ目の中身も保たれる');
});

test('【失敗系】F4 退避切替の失敗で中断した undo の後の redo は、その間に（undo 対象外で）削除した検討案を復活させない', async () => {
  const { project, store } = await setup('p3');
  const opts = {};
  const app = makeApp(project, store, opts);
  const c = await app.addFloors(FLOOR_ORDER_KIND.INSERT);
  const alt = app.addAlternativeFloor(c.added[0].id, '検討案A');
  await c.undo(); // 記録に検討案 A が入る
  await c.redo();
  assert.equal(project.planeMap.has(alt.plane.id), true, '1回目の redo で A が戻る');
  await app.removeFloorFn(alt.plane.id); // runDeleteAlternative の removeFloor 相当（この階追加のエントリとは別の操作で消えた）
  opts.failSwitch = true;
  await c.undo(); // 退避の切替が失敗して中断
  assert.equal(project.activePlaneId, c.added[0].id);
  await c.redo();
  assert.equal(project.planeMap.has(alt.plane.id), false, '削除した検討案 A が redo で戻らない');
  assert.equal(store.has(alt.plane.id), false);
});

test('【失敗系】F3 addedPlaneRedoRecords: taken に記録が無い階は plane／graph の無い記録になり、restoreRemovedPlanes が addFloor へ topStoryHeightMm まで渡す。バイト列は addedBytes→記録→null の優先', async () => {
  const { project, app } = await setup('p3');
  const meta = { id: 'zz', name: '9階', startFloor: 9, elevation: 12000, stories: 1, planCutHeightMm: 1300, ceilingCutHeightMm: 1500, topStoryHeightMm: 2600 };
  const recs = addedPlaneRedoRecords([meta], [], new Map([['zz', null]]));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].plane, undefined);
  assert.equal(recs[0].graph, undefined);
  assert.equal(recs[0].bytes, null);
  const calls = [];
  const saved = [];
  await restoreRemovedPlanes(project, recs, {
    addFloor: (...args) => { calls.push(args); return app.addFloor(...args); },
    addAlternativeFloor: app.addAlternativeFloor,
    saveFloorFn: async (id, b) => saved.push([id, b]),
  });
  assert.deepEqual(calls, [[12000, '9階', 9, 1, 'zz', 1300, 1500, 2600]], 'addFloor の第8引数まで topStoryHeightMm が渡る');
  assert.deepEqual(saved, [], 'バイト列が無ければ保存しない');
  assert.equal(project.planeMap.get('zz').topStoryHeightMm, 2600);

  const fromTaken = { id: 'zz', bytes: new Uint8Array([7]), plane: 'P', graph: 'G', isAlternative: false };
  const alt = { id: 'zza', bytes: null, isAlternative: true, referenceId: 'zz', altIndex: 0 };
  const opAfter = new Uint8Array([9]);
  assert.equal(addedPlaneRedoRecords([meta], [fromTaken], new Map([['zz', opAfter]]))[0].bytes, opAfter, '操作直後のバイト列が優先');
  const r2 = addedPlaneRedoRecords([meta], [fromTaken, alt], new Map([['zz', null]]));
  assert.deepEqual([...r2[0].bytes], [7], '操作直後が null なら undo 時の記録のバイト列');
  assert.equal(r2[0].plane, 'P', 'インスタンスは記録のもの');
  assert.equal(r2[0].name, '9階', 'メタは操作後のもの');
  assert.deepEqual(r2.map(r => r.id), ['zz', 'zza'], '採用階の後に検討案の記録が続く');
});

// ---- 検討案の追加・コピー・削除・採用の undo/redo（同じ Plane／PlanGraph インスタンスで戻す）----
const altIdsOf = (project, refId) => [...project.planeMap.values()]
  .filter(p => p.isAlternative && p.referenceId === refId).sort((a, b) => a.altIndex - b.altIndex).map(p => p.id);

test('D1 表示中の検討案(p3a)の削除: 親へ退避して消え、undo で同じ Plane／graph・内容・表示が戻り、削除前の編集の undo／redo が復活した検討案に効く。redo→undo でも同様', async () => {
  const { project, store, app } = await setup('p3');
  await app.switchRaw('p3a');
  const plane = project.planeMap.get('p3a');
  const g = project.activeGraph;
  const e = editActiveGraph(project);
  assert.ok(hasLine(g, 777));
  const s0 = await snapshot(project, store);

  const c = await app.deleteAlt('p3a');
  assert.ok(c, '検討案の削除が undo エントリとして積まれる');
  assert.deepEqual(c.diff.removedPlanes.map(r => r.id), ['p3a']);
  assert.deepEqual(app.log.switches, ['p3'], '表示中の検討案は親へ退避してから消す');
  assert.equal(project.planeMap.has('p3a'), false);
  assert.equal(store.has('p3a'), false);
  assert.equal(project.activePlaneId, 'p3');

  await c.undo();
  assert.ok(project.planeMap.get('p3a') === plane, 'Plane 同一');
  assert.ok(project.graphMap.get('p3a') === g, 'graph 同一');
  assert.equal(project.activePlaneId, 'p3a', '復活した検討案を表示する');
  assert.ok(project.activeGraph === g);
  assert.ok(hasLine(g, 777), '削除前の中身（編集後）が戻る');
  assert.equal(plane.planCutHeightMm, 1200);
  assertSameSnapshot(await snapshot(project, store), s0, 'undo');
  e.undo();
  assert.ok(!hasLine(project.activeGraph, 777), '削除前の編集の undo が復活した検討案に効く');
  e.redo();
  assert.ok(hasLine(project.activeGraph, 777), '編集の redo も効く');

  await c.redo();
  assert.equal(project.planeMap.has('p3a'), false);
  assert.equal(project.activePlaneId, 'p3', 'redo は削除直後に表示していた平面へ');
  await c.undo();
  assert.ok(project.graphMap.get('p3a') === g, 'redo→undo でも graph 同一');
  e.undo();
  assert.ok(!hasLine(project.activeGraph, 777), 'redo→undo の後も編集の undo が効く');
});

test('D2 非表示の検討案(p3b)の削除: 退避の切替なし。undo でストアにバイト列が戻り同じインスタンスの検討案を表示する', async () => {
  const { project, store, app } = await setup('p3');
  const plane = project.planeMap.get('p3b');
  const graph = project.graphMap.get('p3b');
  const s0 = await snapshot(project, store);
  const c = await app.deleteAlt('p3b');
  assert.ok(c);
  assert.deepEqual(app.log.switches, [], '表示していないので切替なし');
  assert.equal(store.has('p3b'), false);
  assert.equal(project.activePlaneId, 'p3');

  await c.undo();
  assert.ok(project.planeMap.get('p3b') === plane && project.graphMap.get('p3b') === graph, '同一インスタンス');
  assert.ok(floorBytesEqual(store.get('p3b') ?? serializeGraph(project.activeGraph), s0.bytes.get('p3b')), '内容が戻る');
  assertSameSnapshot(await snapshot(project, store), s0, 'undo');
  assert.equal(project.activePlaneId, 'p3b');
});

test('D3 redo: 表示中なら親(preferred)へ退避して消える。別の階(p1)を表示中なら切替なしで消え、表示は削除直後の平面へ戻る', async () => {
  const { project, store, app } = await setup('p3');
  const c = await app.deleteAlt('p3b');
  await c.undo(); // p3b を表示
  app.log.switches.length = 0;
  await c.redo();
  assert.deepEqual(app.log.switches, ['p3'], '表示中の検討案は削除直後に表示していた p3 へ退避');
  assert.equal(project.planeMap.has('p3b'), false);
  assert.equal(store.has('p3b'), false, 'ストアからも消える');
  assert.equal(project.activePlaneId, 'p3');

  await c.undo();
  await app.switchRaw('p1');
  app.log.switches.length = 0;
  await c.redo();
  assert.deepEqual(app.log.switches, [], '対象を表示していないので退避しない');
  assert.equal(project.planeMap.has('p3b'), false);
  assert.equal(project.activePlaneId, 'p3', '表示は削除直後の平面へ');
});

test('D4 往復2回: 削除→undo→redo→undo→redo の毎回でメタ・バイト列が基準と一致し、2巡目も同じインスタンス', async () => {
  const { project, store, app } = await setup('p3');
  const plane = project.planeMap.get('p3a');
  const s0 = await snapshot(project, store);
  const c = await app.deleteAlt('p3a');
  const s1 = await snapshot(project, store);
  for (let lap = 1; lap <= 2; lap++) {
    await c.undo();
    assert.ok(project.planeMap.get('p3a') === plane, `${lap}巡目: Plane 同一`);
    assertSameSnapshot(await snapshot(project, store), s0, `${lap}巡目の undo`);
    await c.redo();
    assertSameSnapshot(await snapshot(project, store), s1, `${lap}巡目の redo`);
  }
});

test('D5 altIndex: a,b,c から b を削除しても a=0・c=2 のまま（詰め直さない）。undo で b=1・orderedTabs が a,b,c', async () => {
  const { project, store, app } = await setup('p3');
  const { graph } = project.addPlane(6000, '3階#c', 'p3c', 3, 1, true, 'p3', 2);
  store.set('p3c', serializeGraph(graph));
  graph.clearFloorData();
  assert.deepEqual(altIdsOf(project, 'p3'), ['p3a', 'p3b', 'p3c']);

  const c = await app.deleteAlt('p3b');
  assert.ok(c);
  assert.deepEqual(['p3a', 'p3c'].map(id => project.planeMap.get(id).altIndex), [0, 2]);
  await c.undo();
  assert.equal(project.planeMap.get('p3b').altIndex, 1);
  assert.deepEqual(project.orderedTabs.filter(p => p.isAlternative && p.referenceId === 'p3').map(p => p.id), ['p3a', 'p3b', 'p3c']);
  await c.redo();
  assert.deepEqual(altIdsOf(project, 'p3'), ['p3a', 'p3c']);
});

test('A1 検討案の追加: undo で消えて元の平面(p3)へ戻り、redo で同じインスタンス・その検討案を表示。追加した検討案での編集の redo／undo が効く', async () => {
  const { project, store, app } = await setup('p3');
  const s0 = await snapshot(project, store);
  const c = await app.addAlt('p3');
  assert.ok(c, '検討案の追加が undo エントリとして積まれる');
  assert.equal(c.addedPlanes.length, 1);
  assert.equal(c.addedPlanes[0].isAlternative, true);
  const id = c.addedPlanes[0].id;
  const plane = project.planeMap.get(id);
  const g = project.activeGraph;
  assert.equal(project.activePlaneId, id);
  assert.equal(plane.altIndex, 2);
  const e = editActiveGraph(project);

  e.undo();
  await c.undo();
  assert.equal(project.planeMap.has(id), false);
  assert.equal(store.has(id), false);
  assert.equal(project.activePlaneId, 'p3', '操作前の平面へ戻る');
  assertSameSnapshot(await snapshot(project, store), s0, 'undo');

  await c.redo();
  assert.ok(project.planeMap.get(id) === plane && project.graphMap.get(id) === g, '同一インスタンス');
  assert.equal(project.activePlaneId, id, 'redo はその検討案を表示');
  assert.equal(plane.referenceId, 'p3');
  assert.equal(plane.altIndex, 2);
  e.redo();
  assert.ok(hasLine(project.activeGraph, 777), '編集の redo が表示中の検討案に出る');
  e.undo();
  assert.ok(!hasLine(project.activeGraph, 777));
});

test('A2 案コピー: 編集→編集 undo→追加 undo→追加 redo→編集 redo が表示中の検討案に出る。コピー内容(p3 の中心線)は redo で戻る', async () => {
  const { project, app } = await setup('p3');
  editActiveGraph(project, 555); // p3 自体の内容（コピー元）
  const c = await app.addAlt('p3', { copy: true });
  assert.ok(c);
  const id = c.addedPlanes[0].id;
  const g = project.activeGraph;
  assert.ok(project.activePlaneId === id && hasLine(g, 555), 'コピー済みの検討案を表示');
  const e = editActiveGraph(project, 888);

  e.undo();
  await c.undo();
  assert.equal(project.planeMap.has(id), false);
  assert.equal(project.activePlaneId, 'p3');
  assert.ok(hasLine(project.activeGraph, 555), 'コピー元は無傷');
  await c.redo();
  assert.ok(project.graphMap.get(id) === g && project.activeGraph === g);
  assert.ok(hasLine(g, 555), 'コピーした内容が redo で戻る');
  e.redo();
  assert.ok(hasLine(project.activeGraph, 888), '編集の redo が表示中の検討案に出る');
});

test('A3 検討案(p3a)からのコピー: undo で元の検討案(p3a)へ戻る。redo で新しい検討案', async () => {
  const { project, app } = await setup('p3');
  await app.switchRaw('p3a');
  const c = await app.addAlt('p3', { copy: true, sourcePlane: project.planeMap.get('p3a') });
  assert.ok(c);
  const id = c.addedPlanes[0].id;
  assert.equal(project.planeMap.get(id).referenceId, 'p3');
  assert.equal(project.activePlaneId, id);
  await c.undo();
  assert.equal(project.planeMap.has(id), false);
  assert.equal(project.activePlaneId, 'p3a', '追加前に表示していた検討案へ戻る');
  await c.redo();
  assert.equal(project.activePlaneId, id);
});

test('A4 往復2回: 追加の undo→redo→undo→redo の毎回で同じ Plane／graph、2巡目の後も編集の redo／undo が効く', async () => {
  const { project, app } = await setup('p3');
  const c = await app.addAlt('p3');
  const id = c.addedPlanes[0].id;
  const plane = project.planeMap.get(id);
  const g = project.activeGraph;
  const e = editActiveGraph(project);
  for (let lap = 1; lap <= 2; lap++) {
    e.undo();
    await c.undo();
    assert.equal(project.planeMap.has(id), false, `${lap}巡目の undo で消える`);
    await c.redo();
    assert.ok(project.planeMap.get(id) === plane && project.graphMap.get(id) === g, `${lap}巡目: 同一`);
    e.redo();
    assert.ok(hasLine(project.activeGraph, 777), `${lap}巡目: 編集の redo`);
  }
  e.undo();
  assert.ok(!hasLine(project.activeGraph, 777));
});

test('採用の undo: undo で isAlternative・referenceId・altIndex・name が親と全検討案で戻り、redo で採用後へ。往復しても一致', async () => {
  const { project, store, app } = await setup('p3');
  const s0 = await snapshot(project, store);
  const p = app.promote('p3b');
  assert.ok(p);
  const s1 = await snapshot(project, store);
  const pb = project.planeMap.get('p3b');
  assert.equal(pb.isAlternative, false);
  assert.equal(project.planeMap.get('p3').isAlternative, true);
  assert.equal(project.planeMap.get('p3').referenceId, 'p3b');
  assert.ok(project.planeMap.get('p3').name.startsWith('旧'));
  assert.equal(project.planeMap.get('p3a').referenceId, 'p3b', '他の検討案は新しい採用階へ付け替わる');
  assert.deepEqual(p.changed.before.map(s => s.id).sort(), p.changed.after.map(s => s.id).sort(), '前後で同じ平面集合');

  p.undo();
  assert.deepEqual((await snapshot(project, store)).planes, s0.planes, 'undo で全フィールドが戻る');
  p.redo();
  assert.deepEqual((await snapshot(project, store)).planes, s1.planes, 'redo で採用後');
  p.undo();
  assert.deepEqual((await snapshot(project, store)).planes, s0.planes, '2回目の undo');
});

/** 最上階 p4 に乗る屋根専用平面と、p4 の検討案 p4a（elevation・階数が p4 と異なる）を足す。 */
function addRoofAndTopAlt(project) {
  const p4 = project.planeMap.get('p4');
  project.addPlane(p4.elevation + 1, '小屋伏', 'roof', p4.startFloor, p4.stories, false, null, 0, true, 'p4');
  project.addPlane(p4.elevation + 500, '4階#a', 'p4a', p4.startFloor, p4.stories + 1, true, 'p4', 0);
  return p4;
}
const roofOf = (project) => {
  const r = project.roofPlane;
  return { forId: r.roofForPlaneId, elevation: r.elevation, startFloor: r.startFloor, stories: r.stories };
};

test('採用と屋根平面: 最上階の検討案の採用で roofForPlaneId が新採用階へ付け替わり elevation・階数も追従、undo で旧 id と元の値、redo で採用後', async () => {
  const { project, app } = await setup('p3');
  const p4 = addRoofAndTopAlt(project);
  const roofId = project.roofPlane.id;
  const before = roofOf(project);
  assert.equal(before.forId, 'p4');
  const p = app.promote('p4a');
  assert.ok(p);
  const alt = project.planeMap.get('p4a');
  const after = roofOf(project);
  assert.equal(after.forId, 'p4a', '新しい採用階の id へ付け替わる');
  assert.equal(after.elevation, alt.elevation + 1, '新しい最上階＋1');
  assert.equal(after.stories, alt.stories);
  assert.notEqual(after.elevation, before.elevation, '前提: elevation が実際に動く');
  assert.equal(project.roofPlane.id, roofId, '屋根平面は作り直さず同じ id');
  assert.ok(p.changed.before.some(s => s.roofPlane && s.roofForPlaneId === 'p4'));
  assert.ok(p.changed.after.some(s => s.roofPlane && s.roofForPlaneId === 'p4a'));

  p.undo();
  assert.deepEqual(roofOf(project), before, 'undo で旧 id と元の値');
  assert.equal(project.planeMap.get('p4'), p4);
  p.redo();
  assert.deepEqual(roofOf(project), after, 'redo で採用後');
  p.undo();
  assert.deepEqual(roofOf(project), before, '2回目の undo');
});

// ユーザーの要望（紐づけが古い id のまま残り、構造モード突入時の作り直しで屋根の中身が消える）を直接守る
test('採用と屋根平面: 採用後の syncRoofPlane（構造モード突入時）は屋根平面を作り直さない', async () => {
  const { project, app } = await setup('p3');
  addRoofAndTopAlt(project);
  const roof = project.roofPlane;
  assert.ok(app.promote('p4a'));
  const synced = runInAction(() => syncRoofPlane(project));
  assert.ok(synced === roof, '同じ屋根平面のインスタンスを返す（作り直さない）');
  assert.ok(project.roofPlane === roof);
  assert.equal(project.roofPlane.id, 'roof');
  assert.equal(project.roofPlane.roofForPlaneId, 'p4a');
});

test('採用と屋根平面: 最上階でない検討案(p3b)の採用では屋根平面に触れない', async () => {
  const { project, app } = await setup('p3');
  addRoofAndTopAlt(project);
  const before = roofOf(project);
  const p = app.promote('p3b');
  assert.ok(p);
  assert.deepEqual(roofOf(project), before);
  assert.equal(p.changed.before.some(s => s.roofPlane), false);
  assert.equal(p.changed.after.some(s => s.roofPlane), false);
  p.undo();
  assert.deepEqual(roofOf(project), before);
});

test('【失敗系】採用と屋根平面: 屋根平面が無い文書でも最上階の検討案の採用・undo・redo が例外なく動き、屋根平面は生えない', async () => {
  const { project, app } = await setup('p3');
  const p4 = project.planeMap.get('p4');
  project.addPlane(p4.elevation + 500, '4階#a', 'p4a', p4.startFloor, p4.stories, true, 'p4', 0);
  assert.equal(project.roofPlane, null);
  const p = app.promote('p4a');
  assert.ok(p);
  assert.equal(project.planeMap.get('p4a').isAlternative, false);
  assert.equal(project.roofPlane, null);
  p.undo();
  p.redo();
  assert.equal(project.roofPlane, null);
  assert.equal(p.changed.before.some(s => s.roofPlane), false);
});

test('採用と屋根平面: 屋根平面が古い id(\'gone\')を指していても採用で新採用階 p4a へ直り、undo で p4（並びに合う紐づけ）、redo で p4a', async () => {
  const { project, app } = await setup('p3');
  addRoofAndTopAlt(project);
  runInAction(() => { project.roofPlane.roofForPlaneId = 'gone'; });
  const p = app.promote('p4a');
  assert.ok(p);
  const alt = project.planeMap.get('p4a');
  assert.equal(project.roofPlane.roofForPlaneId, 'p4a');
  assert.equal(project.roofPlane.elevation, alt.elevation + 1);
  p.undo();
  assert.equal(project.roofPlane.roofForPlaneId, 'p4', '記録に無い古い id は並びに合う p4 へ（applyAltRoleState の follow）');
  assert.equal(project.roofPlane.elevation, project.planeMap.get('p4').elevation + 1);
  p.redo();
  assert.equal(project.roofPlane.roofForPlaneId, 'p4a');
});

test('【失敗系】採用: 検討案でない・親が無い平面は何も変えず null（undo を積まない）', async () => {
  const { project, store, app } = await setup('p3');
  project.addPlane(6000, '孤児', 'orph', 3, 1, true, 'gone', 0);
  const s0 = await snapshot(project, store);
  assert.equal(app.promote('p3'), null, '採用階は対象外');
  assert.equal(app.promote('orph'), null, '親が無い検討案は対象外');
  assert.equal(app.promote('nope'), null, '存在しない id');
  assert.deepEqual((await snapshot(project, store)).planes, s0.planes);
});

test('【回帰】検討案を追加→採用→undo→undo: 採用の undo を挟むので追加の undo が採用階(p3)を消さない。redo→redo で採用後へ', async () => {
  const { project, store, app } = await setup('p3');
  const stack = [];
  const s0 = await snapshot(project, store);
  const a = await app.addAlt('p3');
  stack.push(a);
  const id = a.addedPlanes[0].id;
  const s1 = await snapshot(project, store);
  const p = app.promote(id);
  stack.push(p);
  const s2 = await snapshot(project, store);
  assert.deepEqual(project.planes.map(x => x.id), ['p1', 'p2', id, 'p4'], '前提: 追加した検討案が採用階になった');

  const top = stack.pop(); await top.undo();
  assert.deepEqual((await snapshot(project, store)).planes, s1.planes, '採用の undo');
  const next = stack.pop(); await next.undo();
  assert.equal(project.planeMap.has(id), false, '追加した検討案が消える');
  assert.equal(project.planeMap.has('p3'), true, '採用階 p3 は消えない');
  assert.equal(project.planeMap.get('p3').isAlternative, false);
  assert.deepEqual(project.planes.map(x => x.id), ['p1', 'p2', 'p3', 'p4']);
  assert.equal(project.activePlaneId, 'p3');
  assertSameSnapshot(await snapshot(project, store), s0, '2回の undo');

  await next.redo();
  await top.redo();
  assert.deepEqual((await snapshot(project, store)).planes, s2.planes, '2回の redo で採用後');
  assert.deepEqual(project.planes.map(x => x.id), ['p1', 'p2', id, 'p4']);
});

test('【失敗系】F1(検討案) 削除の退避の切替が失敗 → 何も消えず undo エントリも積まない(null)', async () => {
  const { project, store } = await setup('p3');
  const app = makeApp(project, store, { failSwitch: true });
  await app.switchRaw('p3a');
  const s0 = await snapshot(project, store);
  const c = await app.deleteAlt('p3a');
  assert.equal(c, null);
  assert.equal(project.planeMap.has('p3a'), true);
  assert.equal(project.activePlaneId, 'p3a');
  assert.deepEqual(app.log.switches, ['p3']);
  assertSameSnapshot(await snapshot(project, store), s0, '中断');
});

test('【失敗系】F2(検討案) 削除の IDB 削除に失敗 → reject。検討案とバイト列が残る', async () => {
  const { project, store } = await setup('p3');
  const app = makeApp(project, store, { removeFailsAt: 'p3b' });
  const s0 = await snapshot(project, store);
  await assert.rejects(app.deleteAlt('p3b'), /IDB delete failed: p3b/);
  assert.equal(project.planeMap.has('p3b'), true);
  assert.ok(floorBytesEqual(store.get('p3b'), s0.bytes.get('p3b')), 'バイト列が残る');
  assert.deepEqual((await snapshot(project, store)).planes, s0.planes);
});

test('【失敗系】F3(検討案) restoreRemovedPlanes: 親の採用階が無い検討案のインスタンス記録は throw し、何も戻さない', async () => {
  const { project, store, app } = await setup('p3');
  const [rec] = await collectRemovalRecords(project, 'p3a', async (id) => store.get(id) ?? null);
  await app.removeFloorFn('p3a');
  await assert.rejects(app.restoreRemoved(project, [{ ...rec, referenceId: 'gone' }]), /親の採用階 gone/);
  assert.equal(project.planeMap.has('p3a'), false);
  await app.restoreRemoved(project, [rec]); // 親が有れば同じインスタンスで戻る
  assert.ok(project.planeMap.get('p3a') === rec.plane);
});

test('【失敗系】F4(検討案) 追加の undo で元へ戻る切替が失敗 → 何も消えず、redo で重複作成されず同じインスタンスのまま', async () => {
  const { project, store } = await setup('p3');
  const opts = {};
  const app = makeApp(project, store, opts);
  const c = await app.addAlt('p3');
  const id = c.addedPlanes[0].id;
  const plane = project.planeMap.get(id);
  const g = project.activeGraph;
  const n = project.planeMap.size;
  opts.failSwitch = true;
  await c.undo();
  assert.ok(project.planeMap.get(id) === plane, '切替失敗で何も消えていない');
  assert.equal(project.activePlaneId, id);
  await c.redo();
  assert.equal(project.planeMap.size, n, '重複作成されない');
  assert.ok(project.graphMap.get(id) === g);
});

test('純関数: collectAlternativeMetas は全検討案を referenceId→altIndex 昇順で全項目つきで採る（採用階は含まない）', async () => {
  const { project } = await setup('p3');
  project.addPlane(3000, '2階#a', 'p2a', 2, 1, true, 'p2', 0);
  const metas = collectAlternativeMetas(project);
  assert.deepEqual(metas.map(m => [m.id, m.referenceId, m.altIndex, m.isAlternative]),
    [['p2a', 'p2', 0, true], ['p3a', 'p3', 0, true], ['p3b', 'p3', 1, true]]);
  assert.equal(metas.find(m => m.id === 'p3a').planCutHeightMm, 1200);
  assert.deepEqual(collectAltRoleState(project, 'p3').map(s => s.id).sort(), ['p3', 'p3a', 'p3b']);
});

test('純関数: collectRemovalRecords は検討案の id で自分1件だけ（親・他の検討案は含まない）', async () => {
  const { project, store } = await setup('p3');
  const recs = await collectRemovalRecords(project, 'p3b', async (id) => store.get(id) ?? null);
  assert.deepEqual(recs.map(r => [r.id, r.isAlternative, r.referenceId, r.altIndex]), [['p3b', true, 'p3', 1]]);
  assert.ok(recs[0].plane === project.planeMap.get('p3b') && recs[0].graph === project.graphMap.get('p3b'));
});

test('純関数: diffFloorOpSnapshot の altsBefore／altsAfter — 増えた検討案は addedPlanes・片方だけで throw・採用階の削除で消えた検討案は追加に数えない・検討案のメタ変化は metasChanged にしない', () => {
  const metas = [{ id: 'a', name: 'A', startFloor: 1, elevation: 0, stories: 1 }];
  const bytes = new Map([['a', new Uint8Array([1])]]);
  const alt = (id, name = id) => ({ id, name, referenceId: 'a', altIndex: 0, isAlternative: true });
  const base = { before: bytes, after: bytes, metasBefore: metas, metasAfter: metas };
  const d = diffFloorOpSnapshot({ ...base, altsBefore: [alt('x')], altsAfter: [alt('x'), alt('y')] });
  assert.deepEqual(d.addedPlanes.map(p => p.id), ['y']);
  assert.equal(d.hasChanges, true);
  assert.equal(d.metasChanged, false);
  assert.throws(() => diffFloorOpSnapshot({ ...base, altsAfter: [alt('y')] }), /altsBefore と altsAfter/);
  assert.throws(() => diffFloorOpSnapshot({ ...base, altsBefore: [alt('y')] }), /altsBefore と altsAfter/);
  const del = diffFloorOpSnapshot({
    ...base, altsBefore: [alt('x')], altsAfter: [],
    removalBefore: [{ id: 'x', isAlternative: true }], existingIdsAfter: new Set(['a']),
  });
  assert.deepEqual(del.addedPlanes, []);
  assert.deepEqual(del.removedPlanes.map(r => r.id), ['x']);
  const renamed = diffFloorOpSnapshot({ ...base, altsBefore: [alt('x', 'n1')], altsAfter: [alt('x', 'n2')] });
  assert.equal(renamed.hasChanges, false);
  assert.equal(diffFloorOpSnapshot(base).hasChanges, false, '省略時は従来どおり');
});

test('純関数: addedPlaneRedoRecords — 検討案は isAlternative を保つ・taken の同じ検討案と重複させない・インスタンスの無い検討案は addAlternativeFloor で作り直す', async () => {
  const { project, app } = await setup('p3');
  const altMeta = { id: 'zz', name: 'n', startFloor: 3, elevation: 6000, stories: 1, isAlternative: true, referenceId: 'p3', altIndex: 2 };
  const taken = [{ id: 'zz', isAlternative: true, referenceId: 'p3', altIndex: 2, plane: 'P', graph: 'G', bytes: new Uint8Array([4]) }];
  const recs = addedPlaneRedoRecords([altMeta], taken, new Map([['zz', null]]));
  assert.equal(recs.length, 1, '重複しない');
  assert.equal(recs[0].isAlternative, true);
  assert.equal(recs[0].plane, 'P');
  assert.deepEqual([...recs[0].bytes], [4]);
  const noInstance = addedPlaneRedoRecords([altMeta], [], new Map([['zz', null]]));
  const calls = [];
  await restoreRemovedPlanes(project, noInstance, {
    addFloor: app.addFloor,
    addAlternativeFloor: (...a) => { calls.push(a); return app.addAlternativeFloor(...a); },
    saveFloorFn: async () => {},
  });
  assert.deepEqual(calls.map(a => [a[0], a[3], a[4]]), [['p3', 'zz', 2]]);
  assert.equal(project.planeMap.get('zz').altIndex, 2);
});

test('純関数: removePlanesForRedo — 親と同時に消える検討案は飛ばす(removeFloorFn は親の1回)。検討案だけなら退避して消す', async () => {
  const { project } = await setup('p4');
  const calls = [];
  const fns = { removeFloorFn: async (id) => calls.push(['remove', id]), switchTo: async (id) => calls.push(['switch', id]) };
  const together = [
    { id: 'p3', isAlternative: false }, { id: 'p3a', isAlternative: true, referenceId: 'p3' }, { id: 'p3b', isAlternative: true, referenceId: 'p3' },
  ];
  assert.equal(await removePlanesForRedo(project, together, 'p4', fns), true);
  assert.deepEqual(calls, [['remove', 'p3']]);
  calls.length = 0;
  assert.equal(await removePlanesForRedo(project, [{ id: 'p3a', isAlternative: true, referenceId: 'p3' }], 'p4', fns), true);
  assert.deepEqual(calls, [['remove', 'p3a']], '単独の検討案は消す');
});

test('純関数: pickRemovalFallback — 検討案が対象で preferred が使えないときは親の採用階(referenceId)。親が無ければ null', async () => {
  const { project } = await setup('p3');
  assert.equal(pickRemovalFallback(project, 'p3a', undefined), 'p3');
  assert.equal(pickRemovalFallback(project, 'p3a', 'p3a'), 'p3', '対象自身は選ばない');
  assert.equal(pickRemovalFallback(project, 'p3a', 'p1'), 'p1', 'preferred が使えるならそれ');
  project.addPlane(6000, '孤児', 'orph', 3, 1, true, 'gone', 0);
  assert.equal(pickRemovalFallback(project, 'orph', undefined), null);
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
  assert.match(undoBody, /const revivedId = \(removedPlanes\.find\(r => !r\.isAlternative\) \?\? removedPlanes\[0\]\)\?\.id;/);
  assert.match(undoBody, /await trySwitchFloor\(\(\) => handleFloorSwitch\(revivedId\)\);/);
  assert.ok(undoBody.indexOf('followRoofPlaneToTop(project)') < undoBody.indexOf('handleFloorSwitch(revivedId)'), '切替は最後（followRoof の後）');
  const redoBody = stripCommentLines(extractFunctionBody(src, 'async function redoFloorOp'));
  const iRemove = redoBody.indexOf('await removePlanesForRedo(project, removedPlanes, activeAfterId');
  assert.ok(iRemove >= 0 && iRemove < redoBody.indexOf('applyPlaneMetas(project, metasAfter);'), 'removePlanesForRedo が metas の前にない');
  assert.match(redoBody, /if \(!removed\) return;/);
});

test('【配線】App.jsx: 検討案の追加・コピー・削除は beginUiTransition → withFloorOpUndo(\'検討案追加\'|\'検討案削除\')。runBusy を直接持たない。削除は rollbackOnError・removalTarget', () => {
  const src = readAppSrc();
  for (const [fn, label] of [['runAddAlternative', '検討案追加'], ['runCopyAlternative', '検討案追加'], ['runDeleteAlternative', '検討案削除']]) {
    const body = stripCommentLines(extractFunctionBody(src, `async function ${fn}`));
    assert.match(body, /^\s*beginUiTransition\(\);\s*$/m, `${fn}: beginUiTransition`);
    assert.match(body, new RegExp(`await withFloorOpUndo\\('${label}', async \\(\\) => \\{`), `${fn}: withFloorOpUndo`);
    assert.doesNotMatch(body, /runBusy\(/, `${fn}: runBusy を直接呼ばない`);
    assert.ok(body.indexOf('beginUiTransition();') < body.indexOf('withFloorOpUndo('), `${fn}: 関門の前に中断処理`);
  }
  const del = stripCommentLines(extractFunctionBody(src, 'async function runDeleteAlternative'));
  assert.match(del, /\}, \{ rollbackOnError: true, removalTarget: planeId \}\);/);
});

test('【配線】App.jsx: withFloorOpUndo は altsBefore を run の前・altsAfter を run の後に採り diffFloorOpSnapshot へ渡す', () => {
  const body = stripCommentLines(extractFunctionBody(readAppSrc(), 'async function withFloorOpUndo'));
  assert.match(body, /const altsBefore = collectAlternativeMetas\(project\);/);
  assert.match(body, /const altsAfter = collectAlternativeMetas\(project\);/);
  assert.match(body, /existingIdsAfter: new Set\(project\.planeMap\.keys\(\)\), altsBefore, altsAfter,/);
  assert.ok(body.indexOf('const altsBefore') < body.indexOf('await run();'), 'altsBefore は run の前');
  assert.ok(body.indexOf('const altsAfter') > body.indexOf('await run();'), 'altsAfter は run の後');
});

test('【配線】App.jsx: 採用(promote)は runPromoteAlternative(planeId) へ委譲し、前後の属性を applyAltRoleState で書き戻す undo を積む', () => {
  const src = readAppSrc();
  const body = stripCommentLines(extractFunctionBody(src, 'function runPromoteAlternative'));
  assert.match(body, /const changed = promoteAlternative\(project, planeId\);/);
  assert.match(body, /if \(!changed\) return;/);
  assert.match(body, /applyAltRoleState\(project, changed\.before\)/);
  assert.match(body, /applyAltRoleState\(project, changed\.after\)/);
  assert.match(body, /undoManager\.push\(/);
  const menu = stripCommentLines(extractFunctionBody(src, 'function handleFloorMenuAction'));
  assert.match(menu, /runPromoteAlternative\(planeId\);/);
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
