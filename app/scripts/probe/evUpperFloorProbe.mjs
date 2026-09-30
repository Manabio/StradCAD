// 実データ検証probe（昇降機の上階自動設置→上階に壁・梁芯が生成されない不良の再現・修正確認）。
// 目的: 1階にEVを設置→1階の仕上げ脱出相当（壁再生成→構造反映→他階sweep）→各階の壁・部屋・
// 梁芯を保存バイト列から復号して数える。修正前（hasNeverBuiltWalls=鍵null&&壁0本だけで判定・
// UNSPECIFIED_RULES.openingBeamAxes=null）は上階（EVの昇降路Roomのみ）が sweep 対象外のまま
// 壁0本・梁芯0本に固定される。修正後は部屋（EVの昇降路Room）がある限りsweep対象になり、
// 壁が立ち（構造未定・S造いずれも）開口由来梁芯が全階そろう。
//
// 本番との同型性: peek/saveは finish/equipment/equipmentTestFixtures.js の makeStorePeek/
// makeStoreSave/decodeFloor（本番同型: PlanGraph→_structGraph→restoreGraph）を使い、IndexedDB
// には触れない。壁再生成・構造反映は wallRefresh.js / structural/structuralOrchestration.js の
// 実関数列（regenerateWalls→setWallFreshnessKey→reflectStructuralAfterFinishExit→他階sweep
// （refreshWallsForGraph）→recomputeActiveStructural→reflectStructuralToOtherFloors）をそのまま
// 呼ぶ——finishBoundary.js runFinishExitBoundary・wallRefresh.js refreshWallsAllFloors(skipActive)
// と同じ関数列。末尾の構造反映だけ createStructuralResolveContext({peek, save}) でctx注入し、
// storage/db.js の実IndexedDBへ到達しないようにする（IDB無しのNode環境のため）。
//
// 【省略している処理】runFinishExitBoundary（finishBoundary.js）が本来行う下記はいずれも
// 呼んでいない——EVの初回設置（設置階の下地材コード・壁厚は既存のまま）では該当データが
// 1件も無く、呼んでも結果に差が出ないため:
//   - 壁由来梁芯の追従（wallBackingCenters→mapBackingCenterMoves→followWallBeamAxes。
//     下地帯の中心が動く＝下地材コード変更を伴う操作でないため対象0件）
//   - ステップ4の境界エッジのトポロジー差分同期（snapshotEdges/syncEdgesFromTopology）
//   - 腰壁・垂れ壁の孤児掃除（graph.kneeDropWalls）
//   - ステップ4bのCL偏芯レコード掃除（graph.clEccentricities）
//   - ステップ4cのCL偏芯の階またぎ連動（propagateCLEccentricities）
//   - ステップ5の階段上階連動（syncUpperStairInteriors）
// また、他階sweepで変更があった後の`recomputeActiveStructural`は本番
// （finishBoundary.js経由・reflectStructuralAfterFinishExitやrefreshWallsAllFloorsの既定）は
// pushUndo:true（第2引数省略時の既定）で呼ぶが、本probeはundo機構を使わないため明示的に
// falseで呼ぶ——undoFns/redoFnsの中身が変わるだけで壁・梁芯の生成結果には影響しない。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/evUpperFloorProbe.mjs [stqパス] [steel]
//   例: node --import ./scripts/testSetup.mjs scripts/probe/evUpperFloorProbe.mjs D:/tatsuya/Download/EV-test1.stq
//       node --import ./scripts/testSetup.mjs scripts/probe/evUpperFloorProbe.mjs D:/tatsuya/Download/EV-test1.stq steel
//
// 期待（修正後）: 2〜5階とも walls>0・ext>0（外壁を含む）・key=set。梁芯4本（開口由来。1階と同じ
// 平面位置）——未定（引数省略）・S造（steel指定）のどちらでも出る（柱・梁は未定では生成されない）。
//
// 【lint対象外】本ファイルは.mjsのため eslint.config.js の対象（**/*.{js,jsx}）に含まれない
// （`npx eslint --print-config` で確認済み）。未使用importは目視で確認している。
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph } from '../../src/graphSnapshot.js';
import { undoManager } from '../../src/undoManager.js';
import { worldToCell } from '../../src/finish/gridCells.js';
import { installEquipment } from '../../src/finish/equipment/equipmentOps.js';
import { runElevatorInstall } from '../../src/finish/equipment/equipmentFloorSync.js';
import { makeStorePeek, makeStoreSave, decodeFloor } from '../../src/finish/equipment/equipmentTestFixtures.js';
import { loadMaterialMap, regenerateWalls } from '../../src/finish/wallRegeneration.js';
import { wallFreshnessKey } from '../../src/finish/wallFreshnessKey.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { createStructuralResolveContext } from '../../src/structural/structuralResolveContext.js';
import { reflectStructuralAfterFinishExit, recomputeActiveStructural, reflectStructuralToOtherFloors } from '../../src/structural/structuralOrchestration.js';
import { refreshWallsForGraph } from '../../src/wallRefresh.js';
import { Discipline } from '../../src/core/constants.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/EV-test1.stq';
const steel = process.argv[3] === 'steel';
const { project } = loadDocument(src);
const plane1 = project.planes.find(p => p.name === '1階');
project.activePlaneId = plane1.id;
if (steel) runInAction(() => { project.structuralInfo.mainStructure = 'S造'; });
const g1 = project.graphMap.get(plane1.id);

// 本番同型の peek/save（バイト列ストア）。
const store = new Map();
for (const p of project.planes) store.set(p.id, serializeGraph(project.graphMap.get(p.id)));
const storePeek = makeStorePeek(project, store);
const storeSave = makeStoreSave(store);

const cell = worldToCell(3000, -3000, g1);
console.log('設置セル:', cell.key, 'mainStructure=', project.structuralInfo.mainStructure ?? '(未定)');
const result = await runElevatorInstall({
  project, activeGraph: g1, cells: new Set([cell.key]),
  commitActive: (equipment) => {
    const eq = equipment ?? { id: crypto.randomUUID(), category: 'ev', usage: 'passenger', no: 1 };
    installEquipment(g1, { ...eq, cells: new Set([cell.key]), candidateRoomId: null });
    return undoManager.push(() => {}, () => {});
  },
  isStillValid: () => true, onApplied: () => {},
  peekFn: storePeek, saveFloorFn: storeSave,
});
console.log('runElevatorInstall:', JSON.stringify(result));

// 1階の仕上げ脱出相当（finishBoundary.js runFinishExitBoundary のステップ1〜3＋構造反映＋他階sweep）。
const materialMap = await loadMaterialMap();
const peekFn = (plane) => storePeek(plane);
const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(g1, project, peekFn);
const { regenerated } = await regenerateWalls(g1, { materialMap, project, stairUnderEntries, extraStairOpenings });
if (regenerated) g1.setWallFreshnessKey(wallFreshnessKey(g1, project));
console.log('1階 壁再生成:', regenerated, '壁数=', g1.walls.length);

const ctx = createStructuralResolveContext({ peek: (plane) => storePeek(plane), save: storeSave });
await reflectStructuralAfterFinishExit(plane1.id, false, project, ctx);
ctx.dispose();

// refreshWallsAllFloors(skipActive:true) と同じ関数列（末尾の構造反映だけ ctx 注入でIDBを避ける）。
const changedNames = [];
for (const plane of project.planes) {
  if (plane.id === plane1.id) continue;
  const temp = storePeek(plane);
  const changed = await refreshWallsForGraph(temp, project, async () => materialMap, { peek: peekFn, pushUndo: false });
  if (changed) { await storeSave(plane.id, serializeGraph(temp)); changedNames.push(plane.name); }
}
console.log('他階 sweep changed:', JSON.stringify(changedNames));
if (changedNames.length > 0) {
  const ctx2 = createStructuralResolveContext({ peek: (plane) => storePeek(plane), save: storeSave });
  await recomputeActiveStructural(project, false, ctx2);
  await reflectStructuralToOtherFloors(project, ctx2);
  ctx2.dispose();
}
store.set(plane1.id, serializeGraph(g1));

for (const p of project.planes) {
  const g = decodeFloor(project, p, store.get(p.id));
  const axes = g.centerLines.filter(cl => cl.discipline === Discipline.FUSE);
  const byOrigin = {};
  for (const a of axes) byOrigin[a.beamAxisOrigin ?? '-'] = (byOrigin[a.beamAxisOrigin ?? '-'] ?? 0) + 1;
  const axesDesc = axes.map(a => `${a.type ?? ''}${a.value}`).sort().join(' ');
  const rooms = g.rooms.map(rm => `${rm.name}[${rm.feature ?? '-'}]`).join(',');
  console.log(`${p.name}: walls=${g.walls.length} ext=${g.walls.filter(w => w.isExteriorWall).length} rooms=${rooms} key=${g.wallFreshnessKey == null ? 'null' : 'set'} 梁芯=${axes.length} ${JSON.stringify(byOrigin)} [${axesDesc}] 柱=${g.columns?.length ?? '?'} 梁=${g.beams?.length ?? '?'}`);
}
