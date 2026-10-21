// 階の追加・削除の自動生成（階段・EV・STAIR_VOID）に関する S0 probe（問題.md「階削除UIと処理の追加／階追加処理の見直し」S0）。
// ソース（app/src/）は一切変更しない。実データ（moku4.stq・13.stq）で、各操作の前後に各階の
// 階段・STAIR_VOID・EV 行・部屋・CL 数・structureOverride を表にする。
//
// 本番との同型性:
//   - 他階 peek・保存は本物の floorSwapManager.peek／storage/db.js saveFloor／loadFloor を使う。
//     Node に IndexedDB が無いため、stairVoidFollower.productionIo.test.js と同じ最小の fake IndexedDB
//     （floors ストアだけ）を globalThis.indexedDB に置く。よって peek は「IDB のバイト列→restoreGraph→
//     healDerivedGeometry」の本番同型（team-lessons「他階 peek のテストスタブが生きたグラフを返す」対応）。
//   - 階操作は floorOrderChange.js の applyFloorOrderChange＋既定の floorOrderFollowers をそのまま通す
//     （App.jsx executeAddUpper／handleAddFloorConfirm 'lower'・'general'／runDeleteFloor と同じ引数）。
//     計算部は floorOps.js の computeFloorInsert／computeFloorAddLowerElevations／computeFloorDeleteReorder。
//   - 階の切替は本物の floorSwapManager.swap（store.js switchFloor と同じ呼び方）。
//   - 非アクティブ階のライブグラフは本番どおり空にして始める（loadDocument は全階を復元するため clearFloorData する）。
//
// 【省略した本番処理】
//   - store.js は react・IDB 初期化を静的に引くため import しない。addFloor／removeFloor は同じ手順を再現:
//     addFloor＝project.addPlane＋既定寸法線 8 本（store.js addDefaultDimensionLines 相当。ライブグラフにだけ載り、
//     IDB には未保存のまま＝本番も peek すると寸法線の無い空グラフが返る）。
//     removeFloor＝deleteFloor（IDB）＋project.removePlane＋インデックスのクリア。検討案の連鎖削除も同様。
//   - withFloorOpUndo（undo スナップショット）・runBusy・beginUiTransition は通さない。undo は今回の対象外。
//     withFloorOpUndo の structuralSync.whenIdle／collectFloorBytes も省く（結果に影響しない）。
//     ただし本番はアクティブ階の IDB が auto-save の遅延で古いことがありうる。probe は操作の直前に
//     アクティブ階を IDB へ書く（他階の peek が自階を読む経路があるため、仕上げ脱出と同じ保存）。
//   - 検討案（isAlternative）の平面は写さない・触らない（仕様どおり。削除では removeFloor が連鎖削除する）。
//   - App.jsx の handleFloorSwitch（構造モード・UI の後処理）は通さない。swap だけ。
//   - 壁の再生成（仕上げモード脱出・鮮度判定）は階操作の follower には含まれない。(a) の Q18 検証でだけ
//     refreshWallsForGraph を直接呼ぶ。
//
// 使い方（app/ で）: node --import ./scripts/testSetup.mjs scripts/probe/floorAddDeleteProbe.mjs [moku4|13|all] [シナリオ名...]
//   シナリオ: insertTop insertMid addLower deleteMid deleteTop orderB orderBMid noBelowRemoval a
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph } from '../../src/graphSnapshot.js';
import { saveFloor, deleteFloor } from '../../src/storage/db.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { applyFloorOrderChange, floorOrderFollowers, FLOOR_ORDER_KIND } from '../../src/floorOrderChange.js';
import {
  computeFloorInsert, computeFloorAddLowerElevations, computeFloorDeleteReorder, blocksFloorRemoval,
} from '../../src/floorOps.js';
import { resolveTopStoryHeightMm } from '../../src/floorHeights.js';
import { makeFloorName } from '../../src/floorNumber.js';
import { subtractSkipZero } from '../../src/floorNumber.js';
import { refreshCells, roomBounds } from '../../src/finish/gridCells.js';
import { collectNeededCLs, addMissingCLs, translateCellSet } from '../../src/finish/floorCLMap.js';
import { loadMaterialMap, regenerateWalls } from '../../src/finish/wallRegeneration.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { RoomFeature } from '../../src/core.js';
import { HDimensionLine, VDimensionLine } from '../../src/core.js';
import { DimensionKind, DimensionSide } from '../../src/core/constants.js';

// ---------------- fake IndexedDB（floors ストアだけ。productionIo.test.js と同じ） ----------------
class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
class FakeStore {
  constructor() { this.data = new Map(); }
  put(value) {
    const req = new FakeRequest();
    this.data.set(value.planeId ?? value.projectId, value);
    queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
    return req;
  }
  get(key) {
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.({ target: { result: this.data.get(key) } }));
    return req;
  }
  delete(key) {
    const req = new FakeRequest();
    this.data.delete(key);
    queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
    return req;
  }
}
const fakeStores = { floors: new FakeStore(), projects: new FakeStore(), savedFloors: new FakeStore() };
const fakeDb = {
  objectStoreNames: { contains: (n) => n in fakeStores },
  transaction(name) { const store = fakeStores[name]; return { objectStore: () => store }; },
};
globalThis.indexedDB = {
  open() {
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.({ target: { result: fakeDb } }));
    return req;
  },
};

const DOCS = {
  moku4: 'D:/tatsuya/Download/moku4.stq',
  13: 'D:/tatsuya/Download/13.stq',
};

// ---------------- 本番の addFloor／removeFloor／switchFloor の再現 ----------------
function addDefaultDimensionLines(graph) {
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.TOP });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.BOTTOM });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.LEFT });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.RIGHT });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.TOP });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.BOTTOM });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.LEFT });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.RIGHT });
}

function makeEnv(project) {
  const toasts = [];
  const addFloor = (elevation, name, startFloor = 1, stories = 1, planeId = crypto.randomUUID(), planCut, ceilCut, topH) => {
    const result = project.addPlane(elevation, name, planeId, startFloor, stories,
      false, null, 0, false, null, planCut, ceilCut, topH);
    addDefaultDimensionLines(result.graph);
    return result;
  };
  const removeFloor = async (planeId) => {
    const plane = project.planeMap.get(planeId);
    if (!plane) return;
    const ids = [planeId];
    if (!plane.isAlternative) {
      for (const [id, p] of project.planeMap) if (p.isAlternative && p.referenceId === planeId) ids.push(id);
    }
    for (const id of ids) await deleteFloor(id);
    runInAction(() => {
      project.removePlane(planeId);
      project.clearMemberNumberIndex();
      project.clearOpeningNumberIndex();
      project.clearEquipmentIndex();
    });
  };
  const switchFloor = async (nextId) => {
    const cur = project.activePlane;
    const curG = project.activeGraph;
    if (cur.id === nextId) return true;
    await floorSwapManager.swap(cur, curG, project.planeMap.get(nextId), project.graphMap.get(nextId), () => {
      project.activePlaneId = nextId;
    });
    return true;
  };
  const ui = {
    notify: (msg) => toasts.push(msg),
    switchFloor,
    onFloorSyncChanged() {},
  };
  return { addFloor, removeFloor, switchFloor, ui, toasts };
}

async function freshProject(path) {
  fakeStores.floors.data.clear();
  const { project } = loadDocument(path);
  const active = project.activePlaneId;
  for (const p of project.planeMap.values()) {
    const g = project.graphMap.get(p.id);
    await saveFloor(p.id, serializeGraph(g));
    if (p.id !== active) runInAction(() => g.clearFloorData()); // 本番: 非アクティブ階のライブグラフは空
  }
  return project;
}

async function saveActive(project) {
  await saveFloor(project.activePlaneId, serializeGraph(project.activeGraph));
}

// ---------------- 表 ----------------
const sid = (id) => String(id).slice(0, 4);
async function readGraph(project, plane) {
  if (plane.id === project.activePlaneId) {
    // アクティブ階も IDB 経由の復元（本番同型）で読む
    await saveActive(project);
  }
  return floorSwapManager.peek(plane, project.structGraph);
}

async function tableRows(project) {
  const rows = [];
  const planes = [...project.planes];
  for (const plane of planes) {
    const g = await readGraph(project, plane);
    const stairs = g.stairs.map(s => `${sid(s.id)}:${s.type}${s.structure ? '/' + s.structure : ''}:${refreshCells(s.cells, g).size}c:steps${s.totalSteps}:riser${s.riser ?? '-'}`);
    const voids = g.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID).map(r => `${sid(r.id)}:${r.name || '-'}:${refreshCells(r.cells, g).size}c`);
    const ev = g.equipmentRows.map(r => `${r.no ?? '-'}#${sid(r.id)}`);
    const roomsByFeature = {};
    for (const r of g.rooms) roomsByFeature[r.feature ?? '-'] = (roomsByFeature[r.feature ?? '-'] ?? 0) + 1;
    rows.push({
      id: sid(plane.id),
      name: plane.name, sf: plane.startFloor, st: plane.stories, elev: plane.elevation,
      active: plane.id === project.activePlaneId ? '*' : '',
      override: g.structureOverride ?? '-',
      stairs, voids, ev,
      rooms: g.rooms.map(r => `${r.name || '-'}[${r.feature ?? '-'}]`),
      // 実行間で比較するための id・セルキー非依存の正規形（セルキーは per-floor 中心線の乱数 id を含むため、幾何〔包絡矩形〕で表す）
      canon: (() => {
        const bb = (cells) => { const b = roomBounds(refreshCells(cells, g), g); return `${b.x1},${b.y1}-${b.x2},${b.y2}`; };
        return {
          stairs: g.stairs.map(s => `${s.type}|${s.structure}|${bb(s.cells)}|c${refreshCells(s.cells, g).size}|n${s.totalSteps}`).sort(),
          voids: g.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID).map(r => `${bb(r.cells)}|c${refreshCells(r.cells, g).size}`).sort(),
          ev: g.equipmentRows.map(r => `no${r.no}|${bb(r.cellKeys)}`).sort(),
          rooms: g.rooms.map(r => `${r.feature ?? '-'}|${r.name || '-'}|${bb(r.cells)}|c${refreshCells(r.cells, g).size}`).sort(),
        };
      })(),
      roomsByFeature,
      cl: g.centerLines.length,
      ownCl: [...g.shapeMap.values()].filter(s => s.constructor?.name === 'CenterLine').length,
      walls: g.walls.length,
      altCount: [...project.planeMap.values()].filter(p => p.isAlternative && p.referenceId === plane.id).length,
    });
  }
  return rows;
}

function printTable(label, rows) {
  console.log(`  [${label}]`);
  for (const r of rows) {
    console.log(`   ${r.active}${r.name} (id ${r.id} sf=${r.sf} st=${r.st} elev=${r.elev}) override=${r.override} CL=${r.cl}(own ${r.ownCl}) walls=${r.walls} alt=${r.altCount}`);
    console.log(`      階段: ${r.stairs.length ? r.stairs.join(' | ') : '(なし)'}`);
    console.log(`      STAIR_VOID: ${r.voids.length ? r.voids.join(' | ') : '(なし)'}`);
    console.log(`      EV行: ${r.ev.length ? r.ev.join(' ') : '(なし)'}`);
    console.log(`      部屋(${r.rooms.length}) feature別=${JSON.stringify(r.roomsByFeature)}: ${r.rooms.slice(0, 14).join(', ')}${r.rooms.length > 14 ? ' …' : ''}`);
  }
}

// ---------------- 本番経路の再現（App.jsx の関数と同じ引数） ----------------
async function opInsert(project, env, currentPlaneId, n, followers) {
  await switchTo(project, env, currentPlaneId);
  await saveActive(project);
  const insert = computeFloorInsert(project.planes, currentPlaneId, n, { topHeightMm: resolveTopStoryHeightMm(project) });
  const { newPlane, updates } = insert;
  return applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT,
    updates,
    addPlane: () => env.addFloor(newPlane.elevation, newPlane.name, newPlane.startFloor, newPlane.stories, undefined, newPlane.planCutHeightMm, newPlane.ceilingCutHeightMm, newPlane.topStoryHeightMm),
    sourceGraph: project.activeGraph,
    newStartFloor: newPlane.startFloor,
    ui: env.ui,
  }, followers);
}

async function opAddLower(project, env, n, followers) {
  const currentPlane = project.planes[0];
  await switchTo(project, env, currentPlane.id);
  await saveActive(project);
  const lowerElevations = computeFloorAddLowerElevations(project.planes, n, { topHeightMm: resolveTopStoryHeightMm(project) });
  let prevFloor = currentPlane.startFloor;
  const addedPlanes = [];
  const addPlane = () => {
    let lastPlane = null;
    for (let i = 1; i <= n; i++) {
      const sf = subtractSkipZero(prevFloor, 1);
      const result = env.addFloor(lowerElevations[i - 1], makeFloorName(sf, 1), sf, 1, undefined, currentPlane.planCutHeightMm, currentPlane.ceilingCutHeightMm);
      lastPlane = result.plane;
      addedPlanes.push(result.plane);
      prevFloor = sf;
    }
    return { plane: lastPlane };
  };
  const r = await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.ADD_LOWER, updates: [], addPlane, ui: env.ui,
  }, followers);
  return { ...r, addedPlanes };
}

async function switchTo(project, env, planeId) {
  if (project.activePlaneId !== planeId) await env.switchFloor(planeId);
}

// runDeleteFloor（App.jsx）と同じ手順。削除対象をアクティブにして「-」を押した状況を再現する
// （アクティブ階なら先に idx+1（無ければ idx-1）へ切替える）。
async function opDelete(project, env, planeId, followers) {
  await switchTo(project, env, planeId);
  const adopted = project.planes;
  const idx = adopted.findIndex(p => p.id === planeId);
  const fallback = adopted[idx + 1] ?? adopted[idx - 1];
  const below = adopted[idx - 1] ?? null;
  if (blocksFloorRemoval(project, planeId)) await env.switchFloor(fallback.id);
  await saveActive(project);
  const afterRemoval = adopted.filter(p => p.id !== planeId);
  const updates = computeFloorDeleteReorder(afterRemoval, idx, { planesBefore: adopted, topHeightMm: resolveTopStoryHeightMm(project) });
  return applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.DELETE,
    updates,
    removePlane: () => env.removeFloor(planeId),
    removedPlane: project.planeMap.get(planeId),
    below,
    ui: env.ui,
  }, followers);
}

// follower 配列の加工（ソースは変えない）
function reorderStairVoidAfterExteriorRoom(followers) {
  const arr = followers.filter(f => f.name !== 'stairVoidReconcile');
  const sv = followers.find(f => f.name === 'stairVoidReconcile');
  const i = arr.findIndex(f => f.name === 'exteriorRoom');
  arr.splice(i + 1, 0, sv);
  return arr;
}
const withoutFollower = (followers, name) => followers.filter(f => f.name !== name);

// ---------------- 昇降機の設置（本番の runElevatorInstall。上階の昇降路も本番どおり自動生成される） ----------------
// 検証データ 2 つはどちらも器具行を持たない（EV 行 0 件）ため、EV 行の追従を見るには設置が要る。
// 最下階の部屋を（名前「EV」→小さい順で）候補にして runElevatorInstall を試し、受理された最初の部屋を使う。
async function installEvOnLowest(project, env) {
  const lowest = project.planes[0];
  await switchTo(project, env, lowest.id);
  await saveActive(project);
  const g = project.activeGraph;
  const { runElevatorInstall } = await import('../../src/finish/equipment/equipmentFloorSync.js');
  const { installEquipment } = await import('../../src/finish/equipment/equipmentOps.js');
  const { undoManager } = await import('../../src/undoManager.js');
  const cands = g.rooms
    .filter(r => r.feature == null || r.feature === undefined)
    .map(r => ({ r, cells: refreshCells(r.cells, g) }))
    .filter(x => x.cells.size > 0)
    .sort((a, b) => (b.r.name === 'EV') - (a.r.name === 'EV') || a.cells.size - b.cells.size);
  const tried = [];
  for (const { r, cells } of cands.slice(0, 15)) {
    const result = await runElevatorInstall({
      project, activeGraph: g, cells: new Set(cells),
      commitActive: (equipment) => {
        const eq = equipment ?? { id: crypto.randomUUID(), category: 'ev', usage: 'passenger', no: 1 };
        installEquipment(g, { ...eq, cells: new Set(cells), candidateRoomId: r.id });
        return undoManager.push(() => {}, () => {});
      },
      isStillValid: () => true, onApplied: () => {},
    });
    tried.push(`${r.name || '-'}(${cells.size}c)=>${result.status}${result.message ? ':' + result.message : ''}`);
    if (result.status === 'installed' || result.status === 'extended') {
      console.log(`  EV 設置: 候補部屋「${r.name || '-'}」(${cells.size}セル) → ${result.status}。試行: ${tried.join(' / ')}`);
      return true;
    }
  }
  // 全候補が上階の部屋と重なって拒否された場合（13.stq の 2 階は全面が部屋）: 利用者が上階の重なる部屋を
  // 削除した（部屋削除＝feature='undefined' 化。undefined-room-spec）状態を再現して再試行する。
  for (const { r, cells } of cands.slice(0, 5)) {
    const undefined_ = [];
    for (const plane of project.planes) {
      if (plane.id === g.plane.id) continue;
      const ug = await floorSwapManager.peek(plane, project.structGraph);
      const { prepareUpperShaftCells } = await import('../../src/finish/equipment/equipmentFloorPlan.js');
      const prepared = prepareUpperShaftCells(ug, g, project.structGraph, new Set(cells)).cells ?? new Set();
      let changed = prepared.size > 0; // 判定が足した CL も保存される（本番の設置も同じ CL を足す）
      for (const ur of ug.rooms) {
        if (ur.feature != null) continue;
        if ([...refreshCells(ur.cells, ug)].some(k => prepared.has(k))) {
          ur.setFeature(RoomFeature.UNDEFINED); changed = true; undefined_.push(`${plane.name}「${ur.name || '-'}」`);
        }
      }
      if (changed) await saveFloor(plane.id, serializeGraph(ug));
    }
    const result = await runElevatorInstall({
      project, activeGraph: g, cells: new Set(cells),
      commitActive: (equipment) => {
        const eq = equipment ?? { id: crypto.randomUUID(), category: 'ev', usage: 'passenger', no: 1 };
        installEquipment(g, { ...eq, cells: new Set(cells), candidateRoomId: r.id });
        return undoManager.push(() => {}, () => {});
      },
      isStillValid: () => true, onApplied: () => {},
    });
    tried.push(`[上階の重なる部屋を未定義化: ${undefined_.join(',') || 'なし'}] ${r.name || '-'}(${cells.size}c)=>${result.status}${result.message ? ':' + result.message : ''}`);
    if (result.status === 'installed' || result.status === 'extended') {
      console.log(`  EV 設置: 候補部屋「${r.name || '-'}」(${cells.size}セル) → ${result.status}（上階の重なる部屋を未定義化: ${undefined_.join(',') || 'なし'}）`);
      return true;
    }
  }
  console.log(`  EV 設置できず。試行: ${tried.join(' / ')}`);
  return false;
}

// ---------------- シナリオ ----------------
// 名前の末尾 "+ev" で、操作の前に最下階へ昇降機を設置しておく。"+up" は先に最上階へ 1 階足して 3 階建て以上にする
// （2 階建ての 13.stq で「途中の階」を作るための前処理。足した階は空の階〔部屋 1 つ〕で、階段・EV は本番の追従どおり）。
async function runScenario(docKey, scenarioName) {
  const path = DOCS[docKey];
  const project = await freshProject(path);
  const env = makeEnv(project);
  const mods = new Set(scenarioName.split('+').slice(1));
  const name = scenarioName.split('+')[0];
  const std = floorOrderFollowers;
  console.log(`\n===== ${docKey} / ${scenarioName} （採用階: ${project.planes.map(p => p.name).join(',')} / 検討案 ${[...project.planeMap.values()].filter(p => p.isAlternative).length} 件 / 初期アクティブ ${project.activePlane?.name}）`);
  if (mods.has('ev')) { if (!(await installEvOnLowest(project, env))) return; }
  // 3 階未満の文書で「途中の階の削除」を作るため、必要なときだけ自動で +up（先に最上階へ 1 階足す）にする
  if (!mods.has('up') && project.planes.length < 3 && (name === 'deleteMid' || name === 'noBelowRemovalMid')) mods.add('up');
  if (mods.has('up')) {
    const top = project.planes[project.planes.length - 1];
    await opInsert(project, env, top.id, 1, std);
    console.log(`  前処理 +up: 最上階の上へ追加 → 採用階 ${project.planes.map(p => p.name).join(',')}（toast ${env.toasts.length}件）`);
  }
  const planes = project.planes;

  // 操作対象の階をアクティブにしてから「前」の表を出す（切替だけで変わる分を操作の差に混ぜない）
  const pre = async (planeId) => { await switchTo(project, env, planeId); await saveActive(project); };
  const run = async (fn, variantLabel) => {
    printTable(`前${variantLabel ? ' ' + variantLabel : ''}`, await tableRows(project));
    const res = await fn();
    printTable(`後${variantLabel ? ' ' + variantLabel : ''}  (toast ${env.toasts.length}件${env.toasts.length ? ': ' + env.toasts.join(' / ') : ''})`, await tableRows(project));
    return res;
  };
  const mid = planes.length >= 3 ? planes[1] : null;

  if (name === 'switchOnly') {
    // 対照: 最上階へ切り替えるだけ（階操作なし）で CL 数などが変わるかを見る
    printTable('前', await tableRows(project));
    await switchTo(project, env, planes[planes.length - 1].id);
    printTable('切替後（操作なし）', await tableRows(project));
  } else if (name === 'insertTop') {
    await pre(planes[planes.length - 1].id);
    await run(() => opInsert(project, env, planes[planes.length - 1].id, 1, std));
  } else if (name === 'insertMid') {
    const cur = mid ?? planes[0]; // 2 階建てなら 1 階の上へ挿入（2 階が押し上がる）
    await pre(cur.id);
    await run(() => opInsert(project, env, cur.id, 1, std));
  } else if (name === 'addLower') {
    await pre(planes[0].id);
    await run(() => opAddLower(project, env, 1, std));
  } else if (name === 'deleteMid') {
    if (!mid) { console.log('  (採用階が3未満のためスキップ。+up を付ける)'); return; }
    await pre(mid.id);
    await run(() => opDelete(project, env, mid.id, std));
  } else if (name === 'deleteTop') {
    const top = planes[planes.length - 1];
    await pre(top.id);
    await run(() => opDelete(project, env, top.id, std));
  } else if (name === 'noBelowRemovalMid' || name === 'noBelowRemovalTop') {
    const tgt = name.endsWith('Mid') ? mid : planes[planes.length - 1];
    if (!tgt) { console.log('  (対象階なし。+up を付ける)'); return; }
    await pre(tgt.id);
    await run(() => opDelete(project, env, tgt.id, withoutFollower(std, 'stairsBelowRemoval')), 'stairsBelowRemoval除外');
  } else {
    console.log(`  未知のシナリオ: ${name}`);
  }
  return project;
}

// (b) follower 順の入れ替え: 標準順と stairVoidReconcile を exteriorRoom の後ろへ移した順で、同じ INSERT を行い
// 各階の階段・STAIR_VOID・EV 行・部屋を機械的に比較する。
async function runOrderCompare(docKey, which, mods = new Set()) {
  const path = DOCS[docKey];
  const results = {};
  for (const variant of ['standard', 'moved']) {
    const project = await freshProject(path);
    const env = makeEnv(project);
    const followers = variant === 'standard' ? floorOrderFollowers : reorderStairVoidAfterExteriorRoom(floorOrderFollowers);
    if (mods.has('ev')) { if (!(await installEvOnLowest(project, env))) return; }
    if (mods.has('up')) await opInsert(project, env, project.planes[project.planes.length - 1].id, 1, floorOrderFollowers);
    const planes = project.planes;
    const cur = which === 'top' ? planes[planes.length - 1] : (planes[1] ?? planes[0]);
    if (!cur) { console.log('  (対象階なし)'); return; }
    await opInsert(project, env, cur.id, 1, followers);
    results[variant] = { rows: await tableRows(project), toasts: [...env.toasts], order: followers.map(f => f.name) };
  }
  console.log(`\n===== ${docKey} / orderB-${which}（INSERT。stairVoidReconcile を exteriorRoom の後ろへ移す）`);
  console.log(`  標準順(INSERT分): ${results.standard.order.filter(n => ['roofPlaneHeight','stairsBelowRemoval','stairVoidReconcile','elevatorCopy','exteriorRoom','mainRoofCarry','switchToAddedFloor','structuralReflect'].includes(n)).join(' > ')}`);
  console.log(`  移動後         : ${results.moved.order.filter(n => ['roofPlaneHeight','stairsBelowRemoval','stairVoidReconcile','elevatorCopy','exteriorRoom','mainRoofCarry','switchToAddedFloor','structuralReflect'].includes(n)).join(' > ')}`);
  printTable('標準順 後', results.standard.rows);
  printTable('移動後 後', results.moved.rows);
  // 比較に使う正規形（幾何・セル数）の要約。差 0 件が空振りでないことを数で示す
  for (const v of ['standard', 'moved']) {
    for (const r of results[v].rows) {
      console.log(`   canon ${v === 'standard' ? '標準' : '移動後'} ${r.name}: stairs=${JSON.stringify(r.canon.stairs)} voids=${JSON.stringify(r.canon.voids)} ev=${JSON.stringify(r.canon.ev)} rooms=${r.canon.rooms.length}件 セル計=${r.canon.rooms.reduce((s, x) => s + Number(x.split('|c')[1]), 0)}`);
    }
  }
  // 機械比較
  const diffs = [];
  const keys = ['stairs', 'voids', 'ev', 'rooms'];
  for (let i = 0; i < Math.max(results.standard.rows.length, results.moved.rows.length); i++) {
    const a = results.standard.rows[i]; const b = results.moved.rows[i];
    if (!a || !b) { diffs.push(`階数が違う: ${a?.name} vs ${b?.name}`); continue; }
    for (const k of keys) {
      const sa = JSON.stringify(a.canon[k]); const sb = JSON.stringify(b.canon[k]);
      if (sa !== sb) diffs.push(`${a.name}.${k}: 標準=${sa} / 移動後=${sb}`);
    }
    // 内容は同じで roomOrder（graph.rooms の並び）だけ違うか
    if (JSON.stringify(a.rooms) !== JSON.stringify(b.rooms) && JSON.stringify(a.canon.rooms) === JSON.stringify(b.canon.rooms)) {
      diffs.push(`${a.name}.roomOrder（内容は同じ・並びだけ違う）: 標準=${JSON.stringify(a.rooms.slice(-4))} / 移動後=${JSON.stringify(b.rooms.slice(-4))}`);
    }
    for (const k of ['cl', 'ownCl', 'walls', 'override', 'name', 'sf', 'elev']) if (a[k] !== b[k]) diffs.push(`${a.name}.${k}: 標準=${a[k]} / 移動後=${b[k]}`);
  }
  console.log(`  比較結果: 差 ${diffs.length} 件 / toast 標準${results.standard.toasts.length}件 移動後${results.moved.toasts.length}件`);
  for (const d of diffs) console.log('   - ' + d);
}

// (a) 空の階（下階追加の新しい階＝通り芯だけ）に階段・昇降路を置けるか／壁の再生成がペア部屋の周りだけに立つか（問題.md Q18）。
// 手順（すべて本番の関数。App.jsx の経路を再現）:
//   1. 下階追加（opAddLower）。新しい階は通り芯だけ（部屋 0・階固有 CL 0）。
//   2. 当該階（1階）の外壁の軸・端点になっている階固有 CL を新しい階へ写す（addMissingCLs。S5c で作る写しの代用。
//      exteriorRoom と同じ関数）。
//   3. 階段: 1階の階段のセルを新しい階へ写し（collectNeededCLs＋addMissingCLs＋translateCellSet）、部屋→
//      FinishModeState.prepareStairNaming/applyNaming（stairRemovalTestFixtures.placeStair と同じ本番の手順）で指定、
//      続けて App.jsx applyRoomNaming と同じく syncUpperFloors（直上階 1階の吹抜け整合）。
//   4. 昇降路（+ev）: 1階の昇降機のセルを prepareUpperShaftCells で新しい階へ写し、本番の runElevatorInstall
//      （直上階 1階以上へも自動設置／下方延長の判定）で設置。
//   5. 壁の再生成: finishBoundary.js と同じ関数列（resolveStairContext → regenerateWalls）を新しい階に対して実行し、
//      立った壁の位置をペア部屋の包絡矩形と比べる。
// 省略: 仕上げモードの undo 合成・構造反映（reflectStructural…）・壁由来梁芯の追従。
async function runScenarioA(docKey, withEv) {
  const project = await freshProject(DOCS[docKey]);
  const env = makeEnv(project);
  console.log(`\n===== ${docKey} / a${withEv ? '+ev' : ''}（空の階へ階段・昇降路）`);
  if (withEv && !(await installEvOnLowest(project, env))) return;
  await opAddLower(project, env, 1, floorOrderFollowers);
  const b1 = project.activeGraph;
  console.log(`  下階追加後のアクティブ階: ${project.activePlane.name}（部屋 ${b1.rooms.length}・階固有CL ${[...b1.shapeMap.values()].filter(s => s.constructor?.name === 'CenterLine').length}・壁 ${b1.walls.length}・階段 ${b1.stairs.length}・EV行 ${b1.equipmentRows.length}）`);
  const lower = project.planes[0];
  if (lower.id !== project.activePlaneId) { console.log('  アクティブ階が最下階でない'); return; }
  const g1 = await floorSwapManager.peek(project.planes[1], project.structGraph); // 当該階（1階）を本番同型 peek
  const sg = project.structGraph;
  const ownCls = (g) => [...g.shapeMap.values()].filter(s => s.constructor?.name === 'CenterLine');

  // 2. 外壁の軸・端点の階固有 CL を写す
  const needed = new Map();
  const ext = g1.walls.filter(w => w.isExteriorWall);
  for (const w of ext) {
    for (const ref of [w.axisCL, w.clStart, w.clEnd]) {
      const cl = typeof ref === 'string' ? g1.shapeMap.get(ref) : ref;
      if (cl && g1.shapeMap.has(cl.id)) needed.set(`${cl.centerLineType}:${cl.value}`, cl);
    }
  }
  const before = ownCls(b1).length;
  const added = addMissingCLs(needed, g1, sg, b1);
  console.log(`  2. 外壁(${ext.length}本)が使う階固有CL ${needed.size}本 → B1 へ ${added} 本追加（B1 の階固有CL ${before}→${ownCls(b1).length}）`);

  // 3. 階段
  const { FinishModeState } = await import('../../src/modes/FinishModeState.js');
  const { floorHeightAbove } = await import('../../src/finish/stair/stairDimensions.js');
  const { syncUpperFloors } = await import('../../src/finish/stair/stairFloorSync.js');
  const { RoomKind } = await import('../../src/core.js');
  const srcStair = g1.stairs[0];
  let stairRoomBounds = null;
  if (srcStair) {
    const srcCells = refreshCells(srcStair.cells, g1);
    addMissingCLs(collectNeededCLs(srcCells, g1), g1, sg, b1);
    const tcells = translateCellSet(srcCells, g1, sg, b1);
    const cells = tcells ? refreshCells(tcells, b1) : new Set();
    console.log(`  3. 1階の階段 ${srcStair.type}/${srcStair.structure} ${srcCells.size}セル → B1 の対応セル ${cells.size}`);
    const room = b1.addRoom(cells, 'ホール');
    room.setKind(RoomKind.INTERIOR);
    const payload = { name: '', kind: RoomKind.INTERIOR, feature: RoomFeature.STAIR };
    const state = new FinishModeState(b1, project);
    state.prepareStairNaming(room.id, payload);
    state.applyNaming(room.id, payload, floorHeightAbove(project, project.activePlane));
    const st = b1.stairs[b1.stairs.length - 1];
    stairRoomBounds = roomBounds(refreshCells(st.cells, b1), b1);
    console.log(`     applyNaming 後: B1 階段 ${b1.stairs.length}件（${st.type}/${st.structure} steps${st.totalSteps} riser${st.riser ?? '(自動)'} 向き${st.upDirection}）。rooms=${b1.rooms.map(x => `${x.name || '-'}[${x.feature ?? '-'}]`).join(',')}`);
    await syncUpperFloors(project, b1);
    const g1after = await floorSwapManager.peek(project.planes[1], project.structGraph);
    console.log(`     syncUpperFloors 後の1階: STAIR_VOID ${g1after.rooms.filter(x => x.feature === RoomFeature.STAIR_VOID).length}件・階段 ${g1after.stairs.length}件（1階の階段は元のまま同じ位置のため吹抜けは重ねられない）`);
  } else console.log('  3. 1階に階段なし');

  // 4. 昇降路
  let evBounds = null;
  if (withEv && g1.equipmentRows.length > 0) {
    const { runElevatorInstall } = await import('../../src/finish/equipment/equipmentFloorSync.js');
    const { installEquipment } = await import('../../src/finish/equipment/equipmentOps.js');
    const { prepareUpperShaftCells } = await import('../../src/finish/equipment/equipmentFloorPlan.js');
    const { undoManager } = await import('../../src/undoManager.js');
    const row = g1.equipmentRows[0];
    const prep = prepareUpperShaftCells(b1, g1, sg, refreshCells(row.cellKeys, g1));
    console.log(`  4. 1階の昇降機 ${row.no}号（${refreshCells(row.cellKeys, g1).size}セル）→ B1 の対応セル ${prep.cells?.size ?? 0}、区画可=${prep.closed}`);
    if (prep.cells && prep.closed) {
      const cells = prep.cells;
      const res = await runElevatorInstall({
        project, activeGraph: b1, cells: new Set(cells),
        commitActive: (equipment) => {
          const eq = equipment ?? { id: crypto.randomUUID(), category: 'ev', usage: 'passenger', no: 1 };
          installEquipment(b1, { ...eq, cells: new Set(cells), candidateRoomId: null });
          return undoManager.push(() => {}, () => {});
        },
        isStillValid: () => true, onApplied: () => {},
      });
      console.log(`     runElevatorInstall → ${JSON.stringify(res)}。B1 EV行 ${b1.equipmentRows.map(x => x.no + '#' + sid(x.id)).join(',')}（1階の行 ${g1.equipmentRows.map(x => x.no + '#' + sid(x.id)).join(',')}）`);
      evBounds = roomBounds(cells, b1);
    }
  }
  printTable('B1 に階段・昇降路を置いた後（壁再生成の前）', (await tableRows(project)).filter(x => x.sf < 0));

  // 5. 壁の再生成
  const materialMap = await loadMaterialMap();
  const peekFn = (plane) => floorSwapManager.peek(plane, project.structGraph);
  const { stairUnderEntries, extraStairOpenings, belowGraph } = await resolveStairContext(b1, project, peekFn);
  const { regenerated } = await regenerateWalls(b1, { materialMap, project, stairUnderEntries, extraStairOpenings, belowGraph });
  const val = (cl, off) => (cl && typeof cl === 'object' ? cl.value : (b1.shapeMap.get(cl)?.value ?? sg.shapeMap?.get?.(cl)?.value ?? NaN)) + (off ?? 0);
  const segs = b1.walls.map(w => {
    const a = val(w.axisCL, w.axisOffset), s = val(w.clStart, w.startOffset), e = val(w.clEnd, w.endOffset);
    return w.isVertical ? { x1: a, x2: a, y1: Math.min(s, e), y2: Math.max(s, e), ext: w.isExteriorWall } : { y1: a, y2: a, x1: Math.min(s, e), x2: Math.max(s, e), ext: w.isExteriorWall };
  });
  const bb = segs.reduce((m, s) => ({ x1: Math.min(m.x1, s.x1), y1: Math.min(m.y1, s.y1), x2: Math.max(m.x2, s.x2), y2: Math.max(m.y2, s.y2) }), { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });
  const fmt = (b) => b ? `(${b.x1},${b.y1})-(${b.x2},${b.y2})` : '-';
  console.log(`  5. 壁の再生成 regenerated=${regenerated}: B1 の壁 ${b1.walls.length} 本（外壁 ${b1.walls.filter(w => w.isExteriorWall).length}）、壁の包絡 ${fmt(bb)}`);
  console.log(`     階段ペア部屋の包絡 ${fmt(stairRoomBounds)} / 昇降路の包絡 ${fmt(evBounds)} / 1階の外壁の包絡 ${fmt(ext.length ? ext.map(w => { const a = w.axisCL.value + w.axisOffset; const s = w.clStart.value + w.startOffset; const e = w.clEnd.value + w.endOffset; return w.isVertical ? { x1: a, x2: a, y1: Math.min(s, e), y2: Math.max(s, e) } : { y1: a, y2: a, x1: Math.min(s, e), x2: Math.max(s, e) }; }).reduce((m, s) => ({ x1: Math.min(m.x1, s.x1), y1: Math.min(m.y1, s.y1), x2: Math.max(m.x2, s.x2), y2: Math.max(m.y2, s.y2) }), { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }) : null)}`);
  for (const s of segs.slice(0, 16)) console.log(`       壁 ${s.ext ? '外' : '内'} (${s.x1},${s.y1})-(${s.x2},${s.y2})`);
}

const arg1 = process.argv[2] ?? 'all';
const docKeys = arg1 === 'all' ? Object.keys(DOCS) : [arg1];
const only = process.argv.slice(3);
const SCENARIOS = ['insertTop', 'insertMid', 'addLower', 'deleteMid', 'deleteTop', 'noBelowRemovalMid', 'noBelowRemovalTop', 'orderBTop', 'orderBMid'];
for (const dk of docKeys) {
  for (const sc of (only.length ? only : SCENARIOS)) {
    const [base, ...mods] = sc.split('+');
    if (base === 'a') await runScenarioA(dk, mods.includes('ev'));
    else if (base === 'orderBTop') await runOrderCompare(dk, 'top', new Set(mods));
    else if (base === 'orderBMid') await runOrderCompare(dk, 'mid', new Set(mods));
    else await runScenario(dk, sc);
  }
}
floorSwapManager.disposeAll();
process.exit(0);
