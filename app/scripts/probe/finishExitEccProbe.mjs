// 仕上げモード突入→脱出（何も編集しない）だけで壁が偏芯する不良の診断probe（調査用。製品コードから参照しない）。
// 実アプリの操作列（読込み(bootReady相当)→階切替→仕上げ突入→仕上げ脱出）を同じ関数で再現し、
// 4時点（load直後・bootReady相当後・仕上げ突入後・仕上げ脱出後）の対象階の壁・CL・CL偏芯レコードを
// ダンプして差分を取る。
//
// 使い方（app/ で実行）: node --import ./scripts/testSetup.mjs scripts/probe/finishExitEccProbe.mjs [入力.stq] [対象plane名]
// 対象データ: D:/tatsuya/Download/moku2-1.stq の「2階」（既定）。
// 判定: 壁の全属性（id除く）の多重集合で c(突入後)==d(脱出後)・d==e(2回目脱出後) を比べ、さらに
// c時点の階段下部屋(2a)対象entriesが0件であることを見る。期待出力は「c==d true / d==e true /
// stairUnderEntries=0」と OK で exit 0。外れると NG を出して exit 1（廊下の階段セル二重所有の再発検出）。
import fs from 'node:fs';
import path from 'node:path';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { refreshWallsAllFloors } from '../../src/wallRefresh.js';
import { runFinishEntryBoundary, runFinishExitBoundary } from '../../src/finish/finishBoundary.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { findUnderStairSplitCLs } from '../../src/finish/stair/stairUnderSplit.js';
import { centerLineKind } from '../../src/core/centerLine.js';
import {
  lostSides, cellInteriorPoint, regionCellsAt, isDividerCL, isActiveAcrossRange, refreshCells,
} from '../../src/finish/gridCells.js';
import { cellsBeyondBreak } from '../../src/finish/stair/stairGeometry.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku2-1.stq';
const targetPlaneName = process.argv[3] ?? '2階';
const outDir = path.join(import.meta.dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

const { project } = loadDocument(src);

// graphMap に全階が既に展開済みのため peek は同期的に引くだけでよい（wallRefreshProbe.mjsと同じ手法）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

// reflectStructuralAfterFinishExit（runFinishExitBoundaryが内部で呼ぶ）は他階のsaveFloorに
// storage/db.js経由で実IndexedDBへ到達する——node:test環境と同じ理由でReferenceErrorになるため、
// structuralOrchestration.test.js withFakeIndexedDB と同じ最小限のインメモリシムを使う
// （新規npm依存を追加しない。storage/db.js openDB/saveFloorが使うAPIだけを模す）。
function installFakeIndexedDB() {
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
  }
  class FakeDB {
    constructor() {
      this.stores = new Map();
      this.objectStoreNames = { contains: (n) => this.stores.has(n) };
      for (const name of ['floors', 'projects', 'savedFloors']) this.stores.set(name, new FakeStore());
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
}
installFakeIndexedDB();

const targetPlane = project.planes.find(p => p.name === targetPlaneName);
if (!targetPlane) {
  console.error('対象plane not found. planes =', project.planes.map(p => p.name));
  process.exit(1);
}
const graph = project.graphMap.get(targetPlane.id);

function wallDump(graph) {
  return graph.walls.map(w => ({
    id: w.id,
    clId: w.axisCL?.id ?? null,
    clValue: w.axisCL?.value ?? null,
    clEffectiveValue: w.axisCL?.effectiveValue ?? null,
    // Wall.axisValue（= axisCL.effectiveValue + axisOffset。壁面の実位置）はCLのvalueとは
    // 別物のため、紛らわしい旧フィールド名axisValue（実体はCL.value）と区別して別出力する
    // （QA指摘4・2026-10-01）。
    axisValue: w.axisValue,
    axisOffset: w.axisOffset,
    backingOffset: w.backingOffset,
    bandOffset: w.bandOffset,
    finishSide: w.finishSide,
    backingDepth: w.backingDepth,
    wallFinish: w.wallFinish,
    backingRangeLo: w.backingRange?.lo ?? null,
    backingRangeHi: w.backingRange?.hi ?? null,
    isVertical: w.isVertical,
    coord1: w.coord1,
    coord2: w.coord2,
    isExteriorWall: w.isExteriorWall,
    isRoomWall: w.isRoomWall,
  })).sort((a, b) => (a.clId + ':' + a.coord1).localeCompare(b.clId + ':' + b.coord1));
}

function clDump(graph) {
  const out = [];
  for (const [, cl] of graph.shapeMap) {
    if (cl.centerLineType == null) continue; // 非CLはスキップ（shapeMapにはWall等も入る）
    out.push({
      id: cl.id,
      centerLineType: cl.centerLineType,
      discipline: cl.discipline,
      labeled: cl.labeled,
      value: cl._value ?? cl.value,
      effectiveValue: cl.effectiveValue,
      refId: cl.refId ?? null,
      refOffset: cl.refOffset ?? null,
      beamAxisOrigin: cl.beamAxisOrigin ?? null,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function eccDump(graph) {
  return [...graph.clEccentricities.entries()].map(([clId, rec]) => ({ clId, rec }));
}

function roomDump(graph) {
  return graph.rooms.map(r => ({
    id: r.id, name: r.name, feature: r.feature, generatedWallIds: [...r.generatedWallIds],
  }));
}

function snapshot(label) {
  const data = {
    label,
    walls: wallDump(graph),
    cls: clDump(graph),
    ecc: eccDump(graph),
    rooms: roomDump(graph),
  };
  fs.writeFileSync(path.join(outDir, `finishExitEcc-${label}.json`), JSON.stringify(data, null, 1));
  console.log(`=== ${label} === walls=${data.walls.length} cls=${data.cls.length} ecc=${data.ecc.length} rooms=${data.rooms.length}`);
  return data;
}

// ---- 階段下分割CL（finish/stair/stairUnderSplit.js）・2a対象entries
// （finish/stair/stairUnderRooms.js resolveStairContext）の時点ごとのダンプ。
// コーディネーター追加確認(1)(2): どの分割CLが使われ、どの部屋が2a対象に入るかを直接確認する。
const stairPeek = async (plane) => project.graphMap.get(plane.id) ?? null;
async function dumpStairState(label) {
  const { stairUnderEntries } = await resolveStairContext(graph, project, stairPeek);
  const splitClDetails = new Map(); // clId -> details（複数stairから同じCLが見つかっても1回だけ記録）
  for (const stair of graph.stairs) {
    for (const cl of findUnderStairSplitCLs(stair, graph)) {
      if (splitClDetails.has(cl.id)) continue;
      splitClDetails.set(cl.id, {
        id: cl.id,
        centerLineType: cl.centerLineType,
        kind: centerLineKind(cl),
        discipline: cl.discipline,
        beamAxisOrigin: cl.beamAxisOrigin ?? null,
        labeled: cl.labeled,
        lineType: cl.lineType,
        value: cl._value ?? cl.value,
        extentLo: cl.extentLo,
        extentHi: cl.extentHi,
        refId: cl.refId ?? null,
        refOffset: cl.refOffset ?? null,
        extentLoRef: cl.extentLoRef ?? null,
        extentHiRef: cl.extentHiRef ?? null,
      });
    }
  }
  const entries = stairUnderEntries.map(e => ({
    stairId: e.stair.id,
    roomId: e.room.id,
    roomName: e.room.name,
    splitCLIds: [...e.splitCLIds],
  }));
  const data = { label, entries, splitCls: [...splitClDetails.values()] };
  fs.writeFileSync(path.join(outDir, `finishExitEcc-stair-${label}.json`), JSON.stringify(data, null, 1));
  console.log(`[stair] ${label} entries=`, JSON.stringify(entries));
  console.log(`[stair] ${label} splitCls=`, JSON.stringify(data.splitCls));
  return data;
}

const snapshots = {};
const stairStates = {};
snapshots.a_loaded = snapshot('a_loaded');
stairStates.a_loaded = await dumpStairState('a_loaded');

// (b) bootReady相当: 全階の鍵不一致sweep。project.graphMap が全階を保持済み・このprocessは
// IndexedDBに触れないため、peek/saveFloorFn は graphMap への差し替えで代替する
// （wallRefreshProbe.mjsと同じ手法。他階はpeekしたtemp graphへ直書きされ、saveFloorFnは
// no-op——temp自体がgraphMapの実体のため保存は不要）。
await refreshWallsAllFloors(project, {
  pushUndo: false, pushActiveStructuralUndo: false,
  peek: async (plane) => project.graphMap.get(plane.id) ?? null,
  saveFloorFn: async () => {},
});
snapshots.b_bootReady = snapshot('b_bootReady');
stairStates.b_bootReady = await dumpStairState('b_bootReady');

// ---- コーディネーター追加確認(3回目): lostSides による廊下→階段の再解釈の実測 ----
// lostSides(key, graph) の alive() 判定（finish/gridCells.js:449-453）をそのまま再現し、
// 各辺が失われた理由を「CL不在（ダングリング）」「CLは存在するがdivider種別でない」
// 「divider種別だが区間内で非アクティブ」の3つに区別する（src/は一切変更せず、exportされた
// lostSides/isDividerCL/isActiveAcrossRangeを読むだけ）。
function getCLforProbe(g, id) {
  return g.shapeMap.get(id) ?? g._structGraph?.shapeMap.get(id) ?? null;
}
function clDetail(g, id) {
  const cl = getCLforProbe(g, id);
  if (!cl) return { id, exists: false };
  return {
    id, exists: true, kind: centerLineKind(cl), discipline: cl.discipline,
    labeled: cl.labeled, lineType: cl.lineType, isDivider: isDividerCL(cl),
    value: cl._value ?? cl.value, extentLo: cl.extentLo, extentHi: cl.extentHi,
    beamAxisOrigin: cl.beamAxisOrigin ?? null, refId: cl.refId ?? null,
  };
}
// lostSides と同じ alive() ロジック（finish/gridCells.js:449-453を読み取り専用で再現。
// 喪失理由の分類だけを追加で欲しいため、既存関数を呼ぶだけでは理由が取れない）。
function diagnoseSide(g, cl, rangeLo, rangeHi) {
  if (!cl) return { lost: true, reason: 'CL不在（ダングリング）' };
  if (!isDividerCL(cl)) return { lost: true, reason: `存在するが非divider種別（kind=${centerLineKind(cl)}, discipline=${cl.discipline}）` };
  if (rangeLo == null || rangeHi == null) return { lost: false, reason: null };
  if (!isActiveAcrossRange(cl, rangeLo, rangeHi)) return { lost: true, reason: 'divider種別だが区間内で非アクティブ（extent外）' };
  return { lost: false, reason: null };
}
function diagnoseCellKey(g, key) {
  const [leftId, topId, rightId, bottomId] = key.split(':');
  const left = getCLforProbe(g, leftId), top = getCLforProbe(g, topId);
  const right = getCLforProbe(g, rightId), bottom = getCLforProbe(g, bottomId);
  const vRangeLo = top?.value ?? null, vRangeHi = bottom?.value ?? null;
  const hRangeLo = left?.value ?? null, hRangeHi = right?.value ?? null;
  return {
    key,
    left: { ...clDetail(g, leftId), ...diagnoseSide(g, left, vRangeLo, vRangeHi) },
    right: { ...clDetail(g, rightId), ...diagnoseSide(g, right, vRangeLo, vRangeHi) },
    top: { ...clDetail(g, topId), ...diagnoseSide(g, top, hRangeLo, hRangeHi) },
    bottom: { ...clDetail(g, bottomId), ...diagnoseSide(g, bottom, hRangeLo, hRangeHi) },
  };
}

function cellsOf(set) { return [...set]; }

async function dumpRoomReinterpretDetail(label, g, roomId, stairs) {
  const room = g.rooms.find(r => r.id === roomId);
  if (!room) { console.log(`[lostSides] ${label}: room ${roomId} not found`); return null; }

  // 1. 廊下の全セルキーについてlostSides・診断
  const perCell = [];
  for (const key of room.cells) {
    const lost = lostSides(key, g);
    const detail = diagnoseCellKey(g, key);
    let regionInfo = null;
    if (lost.length > 0) {
      const pt = cellInteriorPoint(key, g);
      if (pt) {
        const region = regionCellsAt(pt.x, pt.y, g);
        regionInfo = {
          pt, regionCellKeys: region.map(c => c.key),
          regionBounds: region.map(c => ({ key: c.key, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 })),
        };
      } else {
        regionInfo = { pt: null, note: '対辺2本同時喪失（復元不能）' };
      }
    }
    perCell.push({ key, lostSides: lost, detail, regionInfo });
  }

  // 2/3. 階段ごとの cells・cellsBeyondBreak・ペアRoom cells と、廊下の再解釈後セルとの重なり
  const stairInfo = [];
  for (const stair of stairs) {
    const riser = stair.riser;
    const beyond = cellsBeyondBreak(stair, g, riser);
    const pairRoom = stair.roomId ? g.rooms.find(r => r.id === stair.roomId) : null;
    const stairCellsRefreshed = cellsOf(refreshCells(stair.cells, g));
    const beyondKeys = cellsOf(beyond);
    const pairRoomCells = pairRoom ? cellsOf(refreshCells(pairRoom.cells, g)) : [];
    stairInfo.push({
      stairId: stair.id, riser, pairRoomId: pairRoom?.id ?? null, pairRoomFeature: pairRoom?.feature ?? null,
      stairCells: stairCellsRefreshed, cellsBeyondBreak: beyondKeys, pairRoomCells,
    });
  }

  // 廊下の「現在のcells（再解釈前そのまま）」と、lostSides>0のセルが regionCellsAt で
  // 置き換わる先（=reinterpretRoomsOnEntryが実際に room.addCell するセル。
  // roomReinterpret.js:343-351「roomIds.size<=1なら対象roomのcellsをregionへ置換」と同じ結果）の
  // 両方で stair.cells/beyond/pairRoomCells との重なりを見る——roomCellsNow（置換前）だけでは
  // 「これから起きる交差」を見落とすため、predictedCellsAfterReinterpret（置換後）も必ず比較する。
  const roomCellsNow = cellsOf(refreshCells(room.cells, g));
  const predictedCellsAfterReinterpret = new Set();
  for (const c of perCell) {
    if (c.lostSides.length === 0) { predictedCellsAfterReinterpret.add(c.key); continue; }
    for (const k of c.regionInfo?.regionCellKeys ?? []) predictedCellsAfterReinterpret.add(k);
  }
  const predictedCells = [...predictedCellsAfterReinterpret];
  const overlapReport = stairInfo.map(si => ({
    stairId: si.stairId,
    before: {
      overlapWithStairCells: roomCellsNow.filter(k => si.stairCells.includes(k)),
      overlapWithBeyond: roomCellsNow.filter(k => si.cellsBeyondBreak.includes(k)),
      overlapWithPairRoomCells: roomCellsNow.filter(k => si.pairRoomCells.includes(k)),
    },
    afterPredicted: {
      overlapWithStairCells: predictedCells.filter(k => si.stairCells.includes(k)),
      overlapWithBeyond: predictedCells.filter(k => si.cellsBeyondBreak.includes(k)),
      overlapWithPairRoomCells: predictedCells.filter(k => si.pairRoomCells.includes(k)),
    },
  }));
  const doubleOwnership = overlapReport.some(r => r.afterPredicted.overlapWithPairRoomCells.length > 0);

  const data = {
    label, roomId, roomCellsNow, predictedCellsAfterReinterpret: predictedCells,
    perCell, stairInfo, overlapReport, doubleOwnership,
  };
  fs.writeFileSync(path.join(outDir, `finishExitEcc-lostSides-${label}.json`), JSON.stringify(data, null, 1));
  console.log(`\n[lostSides] ${label}: 廊下セル数=${room.cells.size} / lostありセル数=${perCell.filter(c => c.lostSides.length > 0).length}`);
  for (const c of perCell) {
    if (c.lostSides.length === 0) continue;
    console.log(`  key=${c.key} lost=${JSON.stringify(c.lostSides)}`);
    for (const side of c.lostSides) console.log(`    ${side}: ${JSON.stringify(c.detail[side])}`);
    if (c.regionInfo?.regionCellKeys) console.log(`    region(${c.regionInfo.regionCellKeys.length}セル)=${JSON.stringify(c.regionInfo.regionCellKeys)}`);
  }
  console.log(`  [重なり] ${JSON.stringify(overlapReport)}`);
  console.log(`  [doubleOwnership（廊下と階段ペアRoomが同じセルを二重に持つか）] ${doubleOwnership}`);
  return data;
}

const corridorRoomId = graph.rooms.find(r => r.name === '廊下')?.id;
const lostSidesDetail2F = await dumpRoomReinterpretDetail('2F_b_bootReady', graph, corridorRoomId, graph.stairs);

// 4. 廊下のセルキーに含まれるCL idが、読込み直後（a_loaded）の時点で存在したか。
// 【probeの既知の不備・訂正】最初の実装は snapshots.a_loaded.cls（clDump()の出力）との
// 突き合わせだったが、clDump() は graph.shapeMap のみを走査し graph._structGraph.shapeMap
// （labeled構造CL・通り芯の格納先）を見ていないため、通り芯（labeled:true, discipline:struct）を
// 全て「存在しない」と誤判定していた（falseな差分）。a_loadedとb_bootReadyの間でCL数は17→17の
// まま変化していないため（壁のみ再生成）、ここでは「今この時点（b_bootReady）のgraphで
// getCLforProbe（shapeMap→_structGraph.shapeMapの順。既存コードと同じ解決順序）が見つけられるか」
// を正しい存在判定として使う——これは a_loaded 時点の集合と同一のはず（CL churn が無いため）。
const corridorCellClIdsAtB = new Set();
for (const c of lostSidesDetail2F?.perCell ?? []) {
  for (const id of c.key.split(':')) corridorCellClIdsAtB.add(id);
}
const clExistenceNow = [...corridorCellClIdsAtB].map(id => ({ id, ...clDetail(graph, id) }));
const missingNow = clExistenceNow.filter(c => !c.exists).map(c => c.id);
console.log(`\n[CL存在確認・訂正版] 廊下セルキーが参照するCL id総数=${corridorCellClIdsAtB.size} / 現存しないid数=${missingNow.length}`);
console.log(`  詳細=${JSON.stringify(clExistenceNow)}`);
fs.writeFileSync(path.join(outDir, 'finishExitEcc-clExistenceCheck.json'), JSON.stringify({
  corridorCellClIdsAtB: [...corridorCellClIdsAtB], clExistenceNow, missingNow,
}, null, 1));

// 5. 他階（1階・3階等。採用済みplane全件のうち対象階以外）でも同じ再解釈が起きるかを確認する。
// 各階について、bootReady直後（この時点ではどの階もまだfinish突入境界を経ていない）のグラフに対し
// 直接 reinterpretRoomsOnEntry 等を呼ばず、対象階と同じ「突入前のstairUnderEntries」を見るだけに
// 留める（他階のgraphを変更すると後続の処理に影響するリスクがあるため、読み取りのみ）。
const { resolveStairUnderEntries } = await import('../../src/finish/stair/stairUnderRooms.js');
const otherFloorsReport = [];
for (const p of project.planes) {
  if (p.id === targetPlane.id) continue;
  const g = project.graphMap.get(p.id);
  const beforeEntries = resolveStairUnderEntries(g, {});
  otherFloorsReport.push({
    plane: p.name, roomsCount: g.rooms.length, stairsCount: g.stairs.length,
    stairUnderEntriesBeforeEntry: beforeEntries.map(e => ({ room: e.room.name, roomId: e.room.id })),
  });
}
console.log('\n[他階] bootReady直後・突入前のstairUnderEntries:', JSON.stringify(otherFloorsReport, null, 1));
fs.writeFileSync(path.join(outDir, 'finishExitEcc-otherFloors.json'), JSON.stringify(otherFloorsReport, null, 1));

// 階切替（floorplan→floorplanはモード境界を持たないため単純にactivePlaneIdを合わせるだけでよい）
runInAction(() => { project.activePlaneId = targetPlane.id; });

// (c) 仕上げ突入境界
await runFinishEntryBoundary(graph, project);
snapshots.c_finishEntry = snapshot('c_finishEntry');
stairStates.c_finishEntry = await dumpStairState('c_finishEntry');

// (d) 仕上げ脱出境界（何も編集せず。fmode相当は materialMap だけ持つ最小オブジェクト）
const materialMap = await loadMaterialMap();
const fmode = { materialMap, _lowerGraph: null };
await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
snapshots.d_finishExit = snapshot('d_finishExit');
stairStates.d_finishExit = await dumpStairState('d_finishExit');

// (e) 2回目の突入→脱出（同じ何もしない操作をもう一度）。regenerateWalls が冪等なら
// d_finishExit と e_finishExit2 は完全一致するはず——一致しなければ「初回migrationで一度だけ
// 変わる」ではなく、regenerateWalls自体が毎回結果の変わる非冪等な処理であることの証拠になる。
await runFinishEntryBoundary(graph, project);
await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
snapshots.e_finishExit2 = snapshot('e_finishExit2');
stairStates.e_finishExit2 = await dumpStairState('e_finishExit2');

// ---- 差分（axisOffset または backingOffset が変わった壁）----
// 壁の全属性（id除く。idは再生成で変わる）を正規化した文字列。同位置に立つ下地オーナー壁と
// 仕上げ薄壁の組も別キーになる（旧キー clId:coord1:coord2 は両者が衝突し誤検出していた）。
const num = (v) => (v == null ? 'null' : String(Math.round(v * 100) / 100));
function wallKey(w) {
  const lo = Math.min(w.coord1, w.coord2), hi = Math.max(w.coord1, w.coord2);
  return [
    w.clId, w.isVertical, num(lo), num(hi), num(w.axisOffset), num(w.axisValue), num(w.backingOffset),
    num(w.backingDepth), num(w.bandOffset), w.finishSide, w.wallFinish, num(w.backingRangeLo), num(w.backingRangeHi),
    w.isExteriorWall, w.isRoomWall,
  ].join('|');
}
function multiset(walls) {
  const m = new Map();
  for (const w of walls) {
    const k = wallKey(w);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(w);
  }
  return m;
}
// 多重集合の差。removed=前にあって後に無い壁、added=後に新しく現れた壁。
function diffWalls(before, after, labelPair) {
  const b = multiset(before.walls), a = multiset(after.walls);
  const removed = [], added = [];
  for (const [k, ws] of b) {
    const n = ws.length - (a.get(k)?.length ?? 0);
    for (let i = 0; i < n; i++) removed.push(ws[i]);
  }
  for (const [k, ws] of a) {
    const n = ws.length - (b.get(k)?.length ?? 0);
    for (let i = 0; i < n; i++) added.push(ws[i]);
  }
  console.log(`\n--- diff ${labelPair} --- removed ${removed.length} / added ${added.length}`);
  for (const w of removed) console.log('  - ' + wallKey(w));
  for (const w of added) console.log('  + ' + wallKey(w));
  return { removed, added };
}

const allDiffs = {
  'a_loaded -> b_bootReady': diffWalls(snapshots.a_loaded, snapshots.b_bootReady, 'a_loaded -> b_bootReady'),
  'b_bootReady -> c_finishEntry': diffWalls(snapshots.b_bootReady, snapshots.c_finishEntry, 'b_bootReady -> c_finishEntry'),
  'c_finishEntry -> d_finishExit': diffWalls(snapshots.c_finishEntry, snapshots.d_finishExit, 'c_finishEntry -> d_finishExit'),
  'd_finishExit -> e_finishExit2': diffWalls(snapshots.d_finishExit, snapshots.e_finishExit2, 'd_finishExit -> e_finishExit2'),
};
fs.writeFileSync(path.join(outDir, 'finishExitEcc-diffs.json'), JSON.stringify(allDiffs, null, 1));

// 変化した壁が属する部屋名（コーディネーター追加確認(3): 対応する時点のroomsで解決する——
// 壁idは再生成のたびに変わるため、pairの「after」側と同じ時点のroomsを使う）。
function roomOfWall(rooms, wallId) {
  return rooms.find(r => r.generatedWallIds.includes(wallId))?.name ?? null;
}

// 2a式かどうかの分類（コーディネーター追加確認(3)）。stairUnderWalls.js ルール1/2の式
// （axisOffset=sign*(base+finish)・backingOffset=sign*(base/2)、finishSideを設定しない＝null）を
// 直接の判定条件にする——通常の室壁の対称式（axisOffset=sign*(base/2+finish)・finishSide=±1）とは
// finishSideの有無とbackingOffsetの大小関係で区別できる。
function classifyWall(w) {
  if (!w) return 'なし';
  const hasBacking = w.backingDepth > 0;
  const bOff = Math.abs(w.backingOffset ?? 0);
  if (hasBacking && w.finishSide == null && bOff > 0 && Math.abs(bOff - w.backingDepth / 2) < 1) {
    return '2a式(オーナー)';
  }
  if (!hasBacking && w.finishSide == null && bOff === 0) {
    // 2a式の薄壁側（ルール2）。通常の非オーナー薄壁（finishSide=±1）と区別する。
    return '2a式(薄壁)';
  }
  if (w.finishSide != null) return '通常式';
  return 'その他';
}

const pairRoomsAfter = {
  'a_loaded -> b_bootReady': snapshots.b_bootReady.rooms,
  'b_bootReady -> c_finishEntry': snapshots.c_finishEntry.rooms,
  'c_finishEntry -> d_finishExit': snapshots.d_finishExit.rooms,
  'd_finishExit -> e_finishExit2': snapshots.e_finishExit2.rooms,
};
const pairRoomsBefore = {
  'a_loaded -> b_bootReady': snapshots.a_loaded.rooms,
  'b_bootReady -> c_finishEntry': snapshots.b_bootReady.rooms,
  'c_finishEntry -> d_finishExit': snapshots.c_finishEntry.rooms,
  'd_finishExit -> e_finishExit2': snapshots.d_finishExit.rooms,
};
const classificationCounts = {};
for (const [k, { removed, added }] of Object.entries(allDiffs)) {
  const tally = (walls, rooms) => {
    const counts = new Map(); // 分類 -> { wallCount, rooms:Set }
    for (const w of walls) {
      const cat = classifyWall(w);
      if (!counts.has(cat)) counts.set(cat, { wallCount: 0, rooms: new Set() });
      const c = counts.get(cat);
      c.wallCount++;
      c.rooms.add(roomOfWall(rooms, w.id) ?? '(不明)');
    }
    return [...counts.entries()].map(([category, c]) => ({ category, wallCount: c.wallCount, rooms: [...c.rooms] }));
  };
  classificationCounts[k] = {
    removed: removed.length, added: added.length,
    removedByCategory: tally(removed, pairRoomsBefore[k]),
    addedByCategory: tally(added, pairRoomsAfter[k]),
  };
}
console.log('\n=== 分類別集計（removed/added・件数・部屋名） ===');
console.log(JSON.stringify(classificationCounts, null, 1));
fs.writeFileSync(path.join(outDir, 'finishExitEcc-classification.json'), JSON.stringify(classificationCounts, null, 1));

// ---- 判定の要約（期待値から外れたら exit 1）----
const same = (d) => d.removed.length === 0 && d.added.length === 0;
const cEqD = same(allDiffs['c_finishEntry -> d_finishExit']);
const dEqE = same(allDiffs['d_finishExit -> e_finishExit2']);
const entriesAtC = stairStates.c_finishEntry.entries.length;
console.log(`\n=== 判定 === c==d ${cEqD} / d==e ${dEqE} / c_finishEntry stairUnderEntries=${entriesAtC}`);
if (!cEqD || !dEqE || entriesAtC !== 0) {
  console.log('NG: 期待値（entries 0件・c==d true・d==e true）から外れた');
  process.exitCode = 1;
} else {
  console.log('OK');
}
