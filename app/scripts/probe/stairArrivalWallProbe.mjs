// 「階段の下り口（到達辺）に、直上階の壁が残る」不良の切り分け probe
// （調査用。製品コードから参照しない。.mjs のため `npm run lint` の対象外）。
//
// 不良（問題.md 2026-10-07）: moku1-3.stq の1階で、玄関・ホールの右横の未定義セル5マスを階段に指定 →
// 平面モードへ（1階脱出）→ 1階の壁は消えるが、2階へ移動すると2階の階段下り口に壁が残る。
// 2階で一度仕上げに入って脱出すると消える。仮説 H1〜H5 は報告文を参照。
//
// 使い方（app/ で実行）:
//   node --import ./scripts/testSetup.mjs scripts/probe/stairArrivalWallProbe.mjs [入力.stq] [--case=stale|synced|nowait] [--order=sorted|reverse] [--cellsXY="x,y;x,y;..."] [--no-save]
//   既定は本番どおり脱出に saveActiveFloorFn: saveFloor を渡す（修正後。全ケースで到達辺の線上の壁=0本になる）。
//   --no-save: 渡さない＝修正前の再現（stale/nowait で 1階脱出直後=2本。synced は保存を明示するので 0本のまま。
//   synced は「脱出前に1階を IDB へ同期していれば直る」の確認用で、修正後は全ケースが同じ結果になる）。
//   既定の入力: D:/tatsuya/Download/moku1-3.stq。--case 省略時は3ケースを子プロセスで順に実行する（singleton の floorSwapManager を
//   ケース間で持ち越さないため）。
//   stale  : 階段変換→ syncUpperFloors を await →（IDB の1階が古いまま）即脱出
//   synced : 階段変換→ syncUpperFloors を await → 実際の auto-save（400ms デバウンス）が走るまで 800ms 待つ→脱出
//   nowait : 階段変換→ syncUpperFloors を await せず（本番の fire-and-forget）即脱出
//
// 【ハーネス】finishExitQuiescenceProbe.mjs からコピー: installFakeIndexedDB・callerFrames・fake IDB への全階の種入れ・
// floorSwapManager.activate/swap・runFinishEntryBoundary/runFinishExitBoundary・FinishModeState の生成と init・
// structuralSync.whenIdle・whenCenterLineOpsIdle・runBusy。変えた点: 読込み境界の refreshWallsAllFloors を1回足した／
// 階の巡回の代わりに「階段変換→1階脱出→2階 peek→2階 swap→2階の突入→脱出」を行う／脱出中の floorSwapManager.peek を差し替えて
// 観測する（挙動は変えず素通し）。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadFloor, saveFloor } from '../../src/storage/db.js';
import { floorWriteGeneration } from '../../src/storage/floorWriteGeneration.js';
import { runFinishEntryBoundary, runFinishExitBoundary } from '../../src/finish/finishBoundary.js';
import { FinishModeState } from '../../src/modes/FinishModeState.js';
import { structuralSync } from '../../src/structural/structuralSync.js';
import { whenCenterLineOpsIdle } from '../../src/transform/centerLineOps.js';
import { runBusy } from '../../src/uiBusy.js';
import { serializeGraph } from '../../src/graphSnapshot.js';
import { floorBytesEqual } from '../../src/floorOps.js';
import { refreshWallsAllFloors } from '../../src/wallRefresh.js';
import { RoomFeature, RoomKind } from '../../src/core.js';
import { getAllCells, refreshCells, cellInteriorPoint, cellBoundsFromKey } from '../../src/finish/gridCells.js';
import { stairPortEdges } from '../../src/finish/stair/stairGeometry.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { mapFootprint } from '../../src/finish/stair/stairRemoval.js';
import { isIndoorStair } from '../../src/finish/stair/stairVoidReconcile.js';
import { syncUpperFloors } from '../../src/finish/stair/stairFloorSync.js';
import { floorHeightAbove } from '../../src/finish/stair/stairDimensions.js';
import { wallFreshnessKey } from '../../src/finish/wallFreshnessKey.js';
import { conformWoodBacking } from '../../src/structural/woodAutoFill.js';

// ---- 引数 ----
const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const files = args.filter(a => !a.startsWith('--'));
const flagValue = (name, dflt) => {
  const f = flags.find(x => x.startsWith(`--${name}=`));
  return f ? f.slice(f.indexOf('=') + 1) : dflt;
};
const CASE = flagValue('case', null);
const ORDER = flagValue('order', 'sorted');
const CELLS_XY = flagValue('cellsXY', null);
const FILE = files[0] ?? 'D:/tatsuya/Download/moku1-3.stq';
// 本番（App.jsx finish.exit）は脱出時に saveActiveFloorFn: saveFloor を渡す。既定は本番どおり。
// --no-save は修正前の不良の再現用（渡さない＝IDB の1階が古いまま2階の下り口に壁が立つ）。
const SAVE_ACTIVE = !flags.includes('--no-save');

if (CASE == null) {
  for (const c of ['stale', 'synced', 'nowait']) {
    console.log(`\n################ case=${c} ################`);
    const childArgs = ['--import', './scripts/testSetup.mjs', process.argv[1], FILE, `--case=${c}`, `--order=${ORDER}`];
    if (!SAVE_ACTIVE) childArgs.push('--no-save');
    if (CELLS_XY) childArgs.push(`--cellsXY=${CELLS_XY}`);
    try {
      execFileSync(process.execPath, childArgs, { stdio: 'inherit' });
    } catch (e) {
      console.error(`case=${c} が異常終了: status=${e.status}`);
    }
  }
  process.exit(0);
}

// ---- fake IndexedDB（finishExitQuiescenceProbe.mjs からコピー） ----
const writeLog = []; // { planeId, op, frames }
const lastSavedBytes = new Map();
function installFakeIndexedDB() {
  class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
  class FakeStore {
    constructor(name) { this.name = name; this.data = new Map(); }
    put(value) {
      const req = new FakeRequest();
      const key = value.planeId ?? value.projectId;
      this.data.set(key, value);
      if (this.name === 'floors') {
        lastSavedBytes.set(key, value.bytes);
        writeLog.push({ planeId: key, op: 'put', frames: callerFrames(new Error().stack) });
      }
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
      if (this.name === 'floors') writeLog.push({ planeId: key, op: 'delete', frames: callerFrames(new Error().stack) });
      queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
      return req;
    }
  }
  class FakeDB {
    constructor() {
      this.stores = new Map();
      this.objectStoreNames = { contains: (n) => this.stores.has(n) };
      for (const name of ['floors', 'projects', 'savedFloors']) this.stores.set(name, new FakeStore(name));
    }
    transaction(name) { const store = this.stores.get(name); return { objectStore: () => store }; }
  }
  const fakeDb = new FakeDB();
  globalThis.indexedDB = {
    open() {
      const req = new FakeRequest();
      queueMicrotask(() => req.onsuccess?.({ target: { result: fakeDb } }));
      return req;
    },
  };
  return fakeDb;
}
Error.stackTraceLimit = 40;
function callerFrames(stack) {
  const out = [];
  for (const line of String(stack).split('\n')) {
    const m = line.match(/(src\/[^):\s]+):(\d+)/);
    if (!m) continue;
    if (/src\/storage\/db\.js/.test(m[1])) continue;
    const s = `${m[1].replace(/^src\//, '')}:${m[2]}`;
    if (!out.includes(s)) out.push(s);
    if (out.length >= 3) break;
  }
  return out;
}
const fakeDb = installFakeIndexedDB();

// ---- 観測の道具 ----
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const short = (id) => String(id).slice(0, 8);
const boundsOfKeys = (keys, graph) => {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const k of keys) {
    const b = cellBoundsFromKey(k, graph);
    if (!b) continue;
    x1 = Math.min(x1, b.x1); y1 = Math.min(y1, b.y1); x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2);
  }
  return { x1, y1, x2, y2 };
};
const fmtB = (b) => `[x ${b.x1}..${b.x2}, y ${b.y1}..${b.y2}]`;
const fmtEdge = (e) => `${e.isVertical ? '縦' : '横'} value=${e.value} 区間${e.lo}..${e.hi}`;
function roomRows(graph) {
  return graph.rooms.map(r => ({
    id: r.id, feature: r.feature ?? '-', kind: r.kind, name: r.name, n: refreshCells(r.cells, graph).size,
  }));
}
const fmtRoom = (r) => `${short(r.id)}|${r.feature}|${r.kind}|${r.name || '(無名)'}|cells=${r.n}`;
function diffRooms(before, after) {
  const mb = new Map(before.map(r => [r.id, r])); const ma = new Map(after.map(r => [r.id, r]));
  const out = [];
  for (const r of before) if (!ma.has(r.id)) out.push(`  - 消えた: ${fmtRoom(r)}`);
  for (const r of after) if (!mb.has(r.id)) out.push(`  + 増えた: ${fmtRoom(r)}`);
  for (const r of after) {
    const b = mb.get(r.id);
    if (b && fmtRoom(b) !== fmtRoom(r)) out.push(`  ~ 変化: ${fmtRoom(b)} → ${fmtRoom(r)}`);
  }
  return out.length ? out : ['  (差なし)'];
}
// 辺 edge（縦横・value・区間）の近傍にある壁を列挙する
function wallsNearEdges(graph, edges) {
  const rows = [];
  for (const e of edges) {
    for (const w of graph.walls) {
      if (w.isVertical !== e.isVertical) continue;
      const a = Math.min(w.coord1, w.coord2); const b = Math.max(w.coord1, w.coord2);
      const overlap = Math.min(b, e.hi) - Math.max(a, e.lo);
      if (overlap <= 0) continue;
      const mr = w.materialRange;
      const on = mr.lo - 1 <= e.value && e.value <= mr.hi + 1;
      const dist = Math.abs(w.axisValue - e.value);
      if (!on && dist > 200) continue;
      rows.push({
        edge: fmtEdge(e), id: short(w.id), axis: w.axisValue, range: `${mr.lo}..${mr.hi}`,
        span: `${a}..${b}`, overlap, on, room: w.isRoomWall, ext: w.isExteriorWall,
      });
    }
  }
  return rows;
}
function printWallsNear(label, graph, edges) {
  const rows = wallsNearEdges(graph, edges);
  const onRows = rows.filter(r => r.on);
  console.log(`  ${label}: 到達辺 ${edges.length}本 / 近傍の壁 ${rows.length}本 / うち辺の線上(材が辺を覆う) ${onRows.length}本 / 壁総数 ${graph.walls.length}`);
  for (const r of rows) {
    console.log(`    ${r.on ? 'ON ' : 'near'} wall ${r.id} axis=${r.axis} 材範囲=${r.range} 長手=${r.span} 重なり${r.overlap} isRoomWall=${r.room} isExterior=${r.ext} ← ${r.edge}`);
  }
  return onRows.length;
}
// resolveStairContext の中身を分解して見る（H2 の切り分け）
async function diagStairContext(label, graph2, graph1, project) {
  const planes = project.planes;
  const idx = planes.findIndex(p => p.id === graph2.plane?.id);
  const lines = [`  [${label}] 2階側 graph=${graph2.plane?.name} 直下=${planes[idx - 1]?.name ?? '無し'} / 直下graphの階段 ${graph1.stairs.length}件`];
  const stairSpace = new Set();
  for (const r of graph2.rooms) {
    if (r.feature !== RoomFeature.STAIR_VOID && r.feature !== RoomFeature.STAIR) continue;
    for (const key of refreshCells(r.cells, graph2)) stairSpace.add(key);
  }
  lines.push(`    2階の STAIR_VOID/STAIR 部屋 ${roomRows(graph2).filter(r => r.feature === RoomFeature.STAIR_VOID || r.feature === RoomFeature.STAIR).map(fmtRoom).join(' ; ') || 'なし'} / stairSpace セル ${stairSpace.size}`);
  for (const s of graph1.stairs) {
    const indoor = isIndoorStair(graph1, s);
    const cells = mapFootprint(s, graph1, project.structGraph, graph2);
    const hit = cells ? [...cells].filter(k => stairSpace.has(k)).length : null;
    const arr = stairPortEdges(s, graph1, ['arrival']);
    lines.push(`    stair ${short(s.id)}: isIndoorStair=${indoor} mapFootprint=${cells ? `${cells.size}セル` : 'null'} stairSpaceと交差=${hit} 到達辺=${arr.length}本 ${arr.map(fmtEdge).join(' / ')}`);
  }
  const ctx = await resolveStairContext(graph2, project, async () => graph1);
  lines.push(`    resolveStairContext(2階, 直下=渡した1階graph) → extraStairOpenings ${ctx.extraStairOpenings.length}本 ${ctx.extraStairOpenings.map(fmtEdge).join(' / ')} / stairUnderEntries ${ctx.stairUnderEntries.length}件`);
  for (const e of ctx.stairUnderEntries) lines.push(`      underEntry stair=${short(e.stair.id)} room=${short(e.room.id)}(${e.room.name}) beyond=${e.beyondCells.size}セル`);
  console.log(lines.join('\n'));
  return ctx;
}
const keyOfFresh = async (plane, project) => {
  const t = await floorSwapManager.peek(plane, project.structGraph);
  runInAction(() => conformWoodBacking(t, project));
  return { stored: t.wallFreshnessKey, now: wallFreshnessKey(t, project), temp: t };
};

// ---- 本体 ----
async function main() {
  const { project } = loadDocument(FILE);
  const tour = project.planes.filter(p => !p.isRoofPlane && !p.isAlternative);
  const allPlanes = [...project.planeMap.values()];
  console.log(`file=${FILE} case=${CASE} order=${ORDER}`);
  console.log(`planes(全${allPlanes.length}。巡回${tour.length}): ${allPlanes.map(p => `${p.name}${p.isRoofPlane ? '(屋根専用)' : p.isAlternative ? '(検討案)' : ''}`).join(', ')}`);
  if (tour.length < 2) { console.log('2階未満のため中止'); return; }
  const plane1 = tour[0]; const plane2 = tour[1];

  // 全階を fake IDB に種入れし、1階だけをメモリに展開（finishExitQuiescenceProbe と同じ）
  const floorsStore = fakeDb.stores.get('floors');
  floorsStore.data.clear(); lastSavedBytes.clear(); writeLog.length = 0;
  for (const p of allPlanes) {
    const g = project.graphMap.get(p.id);
    if (g) floorsStore.data.set(p.id, { planeId: p.id, bytes: serializeGraph(g) });
  }
  runInAction(() => { project.activePlaneId = plane1.id; });
  for (const p of allPlanes) project.graphMap.get(p.id)?.clearFloorData();
  await floorSwapManager.activate(plane1, project.graphMap.get(plane1.id));

  // 読込み境界（store.js bootReady と同じ呼び出し）
  const boot = await refreshWallsAllFloors(project, { pushUndo: false, pushActiveStructuralUndo: false });
  console.log(`[1] 読込み境界 refreshWallsAllFloors: changedPlaneIds=[${boot.changedPlaneIds.map(id => project.planeMap.get(id)?.name).join(',')}]`);

  // 2. 1階の仕上げ突入境界 → FinishModeState
  const graph1 = project.activeGraph;
  await runFinishEntryBoundary(graph1, project, { loadFloorFn: loadFloor });
  let fmode = new FinishModeState(graph1, project);
  await fmode.init();

  // 3. セルの特定
  console.log('\n[3] セルの特定（1階）');
  const hallRooms = graph1.rooms.filter(r => /玄関|ホール/.test(r.name ?? ''));
  for (const r of graph1.rooms) {
    console.log(`  room ${fmtRoom({ id: r.id, feature: r.feature ?? '-', kind: r.kind, name: r.name, n: refreshCells(r.cells, graph1).size })} bounds=${fmtB(boundsOfKeys(refreshCells(r.cells, graph1), graph1))}`);
  }
  if (hallRooms.length === 0) { console.log('玄関/ホールの部屋が見つからない。中止'); return; }
  const hb = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  for (const r of hallRooms) {
    const b = boundsOfKeys(refreshCells(r.cells, graph1), graph1);
    hb.x1 = Math.min(hb.x1, b.x1); hb.y1 = Math.min(hb.y1, b.y1); hb.x2 = Math.max(hb.x2, b.x2); hb.y2 = Math.max(hb.y2, b.y2);
  }
  console.log(`  玄関/ホール(${hallRooms.map(r => r.name).join(',')})の外接 ${fmtB(hb)}`);
  const owned = new Set();
  for (const r of graph1.rooms) {
    if (r.feature === RoomFeature.UNDEFINED) continue;
    for (const k of refreshCells(r.cells, graph1)) owned.add(k);
  }
  for (const s of graph1.stairs) for (const k of refreshCells(s.cells, graph1)) owned.add(k);
  const freeCells = getAllCells(graph1).filter(c => !owned.has(c.key));
  const free910 = freeCells.filter(c => c.x2 - c.x1 === 910 && c.y2 - c.y1 === 910);
  console.log(`  全セル ${getAllCells(graph1).length} / 部屋・階段に属さないセル ${freeCells.length} / うち910角 ${free910.length}`);
  for (const c of free910) console.log(`    free910 x ${c.x1}..${c.x2}, y ${c.y1}..${c.y2}`);
  let chosen;
  if (CELLS_XY) {
    chosen = CELLS_XY.split(';').map(s => {
      const [x, y] = s.split(',').map(Number);
      return getAllCells(graph1).find(c => x >= c.x1 && x <= c.x2 && y >= c.y1 && y <= c.y2);
    }).filter(Boolean);
    console.log(`  --cellsXY 指定: ${chosen.length}セル`);
  } else {
    // 「玄関の右端(玄関.x2)以降」かつ y が玄関/ホールの外接の内にある910角の未所属セル
    const entrance = hallRooms.find(r => /玄関/.test(r.name));
    const eRight = boundsOfKeys(refreshCells(entrance.cells, graph1), graph1).x2;
    chosen = free910.filter(c => c.x1 >= eRight - 1 && c.y1 >= hb.y1 - 1 && c.y2 <= hb.y2 + 1);
    console.log(`  玄関の右端 x=${eRight} 以降・y が ${hb.y1}..${hb.y2} の内の910角の未所属セル: ${chosen.length}件`);
  }
  for (const c of chosen) console.log(`    候補 x ${c.x1}..${c.x2}, y ${c.y1}..${c.y2}`);
  if (chosen.length !== 5) {
    console.log('候補が5マスで一意でない。ここで止まる（--cellsXY="x,y;..." で指定して再実行）');
    return;
  }
  chosen.sort((a, b) => (a.x1 - b.x1) || (a.y1 - b.y1));
  if (ORDER === 'reverse') chosen.reverse();

  // 4. 階段への変換（本番経路: startDrag → updateDrag → commitDrag → applyNaming → syncUpperFloors）
  console.log('\n[4] 階段への変換');
  const pt = (c) => cellInteriorPoint(c.key, graph1);
  const p0 = pt(chosen[0]);
  fmode.startDrag(p0.x, p0.y);
  for (const c of chosen.slice(1)) { const p = pt(c); fmode.updateDrag(p.x, p.y); }
  fmode.commitDrag();
  const roomId = fmode.namingRoomId;
  if (!roomId) { console.log('commitDrag でダイアログが開かなかった。中止'); return; }
  const newRoom = graph1.roomMap.get(roomId);
  console.log(`  ダイアログ対象 room=${short(roomId)} cells=${refreshCells(newRoom.cells, graph1).size} isNew=${fmode.namingIsNew} cellOrder長=${fmode.namingCellOrder?.length}`);
  const payload = { name: '', kind: RoomKind.INTERIOR, feature: RoomFeature.STAIR };
  if (!fmode.isStairConversionIntent(roomId, payload)) { console.log('isStairConversionIntent が偽。中止'); return; }
  const prep = fmode.prepareStairNaming(roomId, payload);
  console.log(`  prepareStairNaming: indoor=${prep.indoor} rejection=${prep.rejection}`);
  const floorHeight = floorHeightAbove(project, project.activePlane);
  const stair = fmode.applyNaming(roomId, payload, floorHeight);
  if (!stair) { console.log(`applyNaming が階段を返さない。lastNamingRejection=${fmode.lastNamingRejection}`); return; }
  const undoEntry = fmode.lastNamingUndoEntry ?? null;
  const arrival1 = stairPortEdges(stair, graph1, ['arrival']);
  const entry1 = stairPortEdges(stair, graph1, ['entry']);
  console.log(`  Stair ${short(stair.id)} upDirection=${stair.upDirection} セル ${refreshCells(stair.cells, graph1).size} riser=${stair.riser} kind=${stair.kind ?? '-'}`);
  console.log(`  1階の到達辺(arrival) ${arrival1.length}本: ${arrival1.map(fmtEdge).join(' / ')}`);
  console.log(`  1階の入口辺(entry)   ${entry1.length}本: ${entry1.map(fmtEdge).join(' / ')}`);

  const gens0 = floorWriteGeneration(plane2.id);
  const syncPromise = syncUpperFloors(project, project.activeGraph, { undoEntry });
  if (CASE !== 'nowait') await syncPromise; else syncPromise.catch(console.error);
  console.log(`  syncUpperFloors ${CASE === 'nowait' ? '(await しない)' : '完了'}: 2階の書込み世代 ${gens0} → ${floorWriteGeneration(plane2.id)}`);

  if (CASE === 'synced') {
    // 実 auto-save（FloorSwapManager._startAutoSave）は markDirty するだけで IDB へは書かない（読んで確認し、
    // 本 probe でも 800ms 待って IDB 無書込みを確認済み）。よって本番では脱出時点の IDB の1階は常に古い。
    // このケースは「もし脱出前に1階を IDB へ同期していたら」の仮定の確認（saveFloor を明示的に呼ぶ）。
    await sleep(800);
    console.log(`  800ms 待った後の 1階の IDB 書込み有無（実 auto-save）: ${lastSavedBytes.has(plane1.id) ? 'あり' : 'なし'}`);
    await saveFloor(plane1.id, serializeGraph(graph1));
    console.log('  仮定: saveFloor(1階) を明示的に呼んで IDB を同期した');
  }
  // 1階の IDB がメモリと一致しているか
  const idb1 = floorsStore.data.get(plane1.id)?.bytes;
  const memEqIdb = idb1 ? floorBytesEqual(serializeGraph(graph1), idb1) : null;
  const peek1 = await floorSwapManager.peek(plane1, project.structGraph);
  console.log(`  1階 IDB==メモリ: ${memEqIdb} / IDB の1階の階段 ${peek1.stairs.length}件・メモリの階段 ${graph1.stairs.length}件`);
  // 2階の STAIR_VOID の有無（H4）
  const peek2a = await floorSwapManager.peek(plane2, project.structGraph);
  const voids2 = peek2a.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID);
  console.log(`  [H4] 脱出前の IDB の2階: STAIR_VOID ${voids2.length}件 ${voids2.map(r => `${short(r.id)} cells=${refreshCells(r.cells, peek2a).size} ${fmtB(boundsOfKeys(refreshCells(r.cells, peek2a), peek2a))}`).join(' ; ')} / 壁 ${peek2a.walls.length}本 / 鍵=${peek2a.wallFreshnessKey ? 'あり' : 'なし'}`);

  // 5. 1階脱出（stamps なし・goingToStructure false）。脱出中の peek を観測する
  console.log('\n[5] 1階の脱出境界');
  const k2pre = await keyOfFresh(plane2, project);
  console.log(`  2階の鮮度キー(脱出前の IDB の2階＋conformWoodBacking): stored==now? ${k2pre.stored === k2pre.now}`);
  console.log(`    stored=${k2pre.stored}`);
  console.log(`    now   =${k2pre.now}`);
  const peekLog = [];
  const origPeek = floorSwapManager.peek.bind(floorSwapManager);
  let last2F = null;
  floorSwapManager.peek = async (plane, structGraph) => {
    const t = await origPeek(plane, structGraph);
    const rec = { plane: plane.name, stored: t.wallFreshnessKey ?? null, nowRaw: null, stairs: t.stairs.length, rooms: t.rooms.length, walls: t.walls.length, ctx: null };
    if (plane.id === plane2.id) {
      last2F = t; rec.nowRaw = wallFreshnessKey(t, project);
    } else if (plane.id === plane1.id && last2F) {
      // 2階の resolveStairContext が直下階（IDB の1階）を読んだ瞬間。その入力を使って同じ解決を再現する
      rec.ctx = await diagStairContext('sweep 内: 2階の peek × IDB の1階の peek', last2F, t, project);
      rec.fromAfter2F = true;
    }
    peekLog.push(rec);
    return t;
  };
  const gensBefore = new Map(allPlanes.map(p => [p.id, floorWriteGeneration(p.id)]));
  writeLog.length = 0;
  await structuralSync.whenIdle();
  try {
    await runFinishExitBoundary(graph1, project, fmode, { goingToStructure: false, saveActiveFloorFn: SAVE_ACTIVE ? saveFloor : null });
  } finally {
    floorSwapManager.peek = origPeek;
  }
  console.log('  脱出中の peek 呼出（順）:');
  for (const r of peekLog) {
    console.log(`    peek ${r.plane}: stored鍵=${r.stored ? 'あり' : 'なし'} stairs=${r.stairs} rooms=${r.rooms} walls=${r.walls}${r.nowRaw != null ? ` 鍵一致(stored==now生)=${r.stored === r.nowRaw}` : ''}${r.fromAfter2F ? ' ← 2階の resolveStairContext の直下階 peek（=2階が鍵不一致で再生成に進んだ証拠）' : ''}`);
  }
  const p2calls = peekLog.filter(r => r.plane === plane2.name).length;
  const p1afterP2 = peekLog.filter(r => r.fromAfter2F).length;
  console.log(`  [H1 判定材料] 2階の peek ${p2calls}回 / その後の1階 peek（resolveStairContext 起因）${p1afterP2}回`);
  console.log(`  脱出中の IDB 書込み（世代が変わった階）: ${allPlanes.filter(p => floorWriteGeneration(p.id) !== gensBefore.get(p.id)).map(p => p.name).join(',') || 'なし'}`);
  for (const w of writeLog) console.log(`    put ${project.planeMap.get(w.planeId)?.name} ← ${w.frames.join(' < ')}`);
  const put2 = writeLog.filter(w => w.planeId === plane2.id && w.op === 'put').length;
  console.log(`  [H1 判定材料] 2階への saveFloor 回数 = ${put2}`);

  // 6. 脱出後の IDB の2階
  console.log('\n[6] 1階脱出後の IDB の2階');
  const after2 = await floorSwapManager.peek(plane2, project.structGraph);
  const rooms2After1F = roomRows(after2);
  console.log(`  2階: 部屋 ${after2.rooms.length}件 / 壁 ${after2.walls.length}本 / 鍵=${after2.wallFreshnessKey ? 'あり' : 'なし'}`);
  const k2post = { stored: after2.wallFreshnessKey, now: wallFreshnessKey(after2, project) };
  console.log(`  2階の鮮度キー stored==now? ${k2post.stored === k2post.now}`);
  const arrivalNow = stairPortEdges(graph1.stairs.find(s => s.id === stair.id), graph1, ['arrival']);
  const onAfter1F = printWallsNear('2階(1階脱出直後・IDB)', after2, arrivalNow);
  await diagStairContext('脱出後の IDB の2階 × メモリの1階', after2, graph1, project);

  // 7. 2階へ swap → 突入 → init → 脱出
  console.log('\n[7] 2階へ移動（swap）→ 突入境界 → init → 脱出境界');
  fmode.dispose?.();
  await whenCenterLineOpsIdle();
  const toGraph = project.graphMap.get(plane2.id);
  await runBusy('階切替', async () => {
    await floorSwapManager.swap(plane1, graph1, plane2, toGraph, () => { project.activePlaneId = plane2.id; });
  });
  const graph2 = project.activeGraph;
  const snap = (label) => ({
    label, rooms: roomRows(graph2), walls: graph2.walls.length, key: graph2.wallFreshnessKey ?? null,
    bytes: serializeGraph(graph2),
  });
  const sSwap = snap('swap直後(平面モード・2階)');
  printWallsNear('2階(swap直後・メモリ)', graph2, arrivalNow);
  const wallsSwapOn = wallsNearEdges(graph2, arrivalNow).filter(r => r.on).map(r => r.id).sort().join(',');
  console.log(`  swap直後 == 1階脱出直後の IDB の2階 (バイト): ${floorBytesEqual(sSwap.bytes, serializeGraph(after2))}`);

  await runFinishEntryBoundary(graph2, project, { loadFloorFn: loadFloor });
  const sEntry = snap('突入境界後');
  fmode = new FinishModeState(graph2, project);
  await fmode.init();
  const sInit = snap('init後');
  const lowerStairs = fmode._lowerStairs ?? fmode.lowerStairs ?? null;
  console.log(`  fmode の下階階段キャッシュ: ${lowerStairs ? `${lowerStairs.length}件` : '(取得不可)'} / _lowerGraph=${fmode._lowerGraph ? `あり(階段${fmode._lowerGraph.stairs?.length}件)` : 'なし'}`);
  for (const [a, b] of [[sSwap, sEntry], [sEntry, sInit]]) {
    console.log(`  ${a.label} → ${b.label}: 壁 ${a.walls}→${b.walls} / 鍵 ${a.key === b.key ? '同' : '変化'} / バイト ${floorBytesEqual(a.bytes, b.bytes) ? '同一' : '差あり'}`);
    for (const l of diffRooms(a.rooms, b.rooms)) console.log(l);
  }
  const gensBefore2 = new Map(allPlanes.map(p => [p.id, floorWriteGeneration(p.id)]));
  writeLog.length = 0;
  await structuralSync.whenIdle();
  await runFinishExitBoundary(graph2, project, fmode, { goingToStructure: false, saveActiveFloorFn: SAVE_ACTIVE ? saveFloor : null });
  const sExit = snap('2階の脱出後');
  console.log(`  ${sInit.label} → ${sExit.label}: 壁 ${sInit.walls}→${sExit.walls} / 鍵 ${sInit.key === sExit.key ? '同' : `変化 ${sInit.key ? 'あり' : 'なし'}→${sExit.key ? 'あり' : 'なし'}`}`);
  for (const l of diffRooms(sInit.rooms, sExit.rooms)) console.log(l);
  console.log(`  2階脱出中の IDB 書込み（世代が変わった階）: ${allPlanes.filter(p => floorWriteGeneration(p.id) !== gensBefore2.get(p.id)).map(p => p.name).join(',') || 'なし'}`);
  const onAfter2F = printWallsNear('2階(2階自身の脱出後・メモリ)', graph2, arrivalNow);
  const wallsExitOn = wallsNearEdges(graph2, arrivalNow).filter(r => r.on).map(r => r.id).sort().join(',');

  // 壁の増減（1階脱出直後の IDB の2階 → 2階自身の脱出後。id 付替えがあるので壁の幾何で比べる）
  const sig = (w) => `${w.isVertical ? 'V' : 'H'}:${w.axisValue}:${Math.min(w.coord1, w.coord2)}..${Math.max(w.coord1, w.coord2)}`;
  const before = new Map(); for (const w of after2.walls) before.set(sig(w), (before.get(sig(w)) ?? 0) + 1);
  const afterM = new Map(); for (const w of graph2.walls) afterM.set(sig(w), (afterM.get(sig(w)) ?? 0) + 1);
  const gone = [...before.keys()].filter(k => !afterM.has(k));
  const born = [...afterM.keys()].filter(k => !before.has(k));
  console.log(`\n[7b] 2階の壁の幾何差（1階脱出直後の IDB → 2階自身の脱出後）: 消えた ${gone.length}種 / 増えた ${born.length}種`);
  for (const k of gone) console.log(`    消えた ${k}`);
  for (const k of born) console.log(`    増えた ${k}`);
  console.log('\n[まとめ] case=' + CASE);
  console.log(`  到達辺の線上の壁: 1階脱出直後=${onAfter1F}本 / 2階自身の脱出後=${onAfter2F}本 (id集合 swap直後=[${wallsSwapOn}] 2階脱出後=[${wallsExitOn}])`);
  console.log(`  rooms 2階: 1階脱出直後 ${rooms2After1F.length}件`);
  process.exit(0);
}

main().catch((e) => { console.error('NG', e); process.exit(1); });
