// 木造EVの4隅柱（実装指示書ステップ8・2026-09-29）を実データで確認するためのテスト用 .stq を作る
// スクリプト。
//
// QA是正（F2・2026-09-29）: 旧版は room.feature を書き換えるだけで壁を再生成しておらず、実際には
// 「壁生成が feature を問わない」ことの検証になっていなかった。本版は moku4.stq の既存「EV」部屋
// （独立部屋。referenceRoomIds空）へ RoomFeature.ELEVATOR_EQUIPMENT を明示設定したうえで、本番の
// 壁再生成（finish/wallRegeneration.js regenerateWalls。structAnchorProbe.mjs runSweep と同じ
// 関数列: conformWoodBacking→wallFreshnessKey比較→resolveStairContext→regenerateWalls→
// wallBackingCenters/followWallBeamAxes）→全階の構造再計算（sweepUntilConverged）まで通し、
// EV の4隅に柱が立つことを実測してから保存する。
//
// 昇降路（isShaftFeature）は登録済みなら常に独立部屋になり部分指定にはならないため
// （finish/wallGeneration.js isInteriorWallTarget 参照）、部分指定EVの検証は行わない。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeWoodEvTestDoc.mjs [出力先.stq]
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, RoomFeature } from '../../src/core.js';
import { cellBoundsFromKey } from '../../src/finish/gridCells.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadMaterialMap, regenerateWalls } from '../../src/finish/wallRegeneration.js';
import { wallFreshnessKey } from '../../src/finish/wallFreshnessKey.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { conformWoodBacking } from '../../src/structural/woodAutoFill.js';
import { wallBackingCenters, mapBackingCenterMoves } from '../../src/structural/wallBeamAxes.js';
import { followWallBeamAxes } from '../../src/structural/wallBeamAxisFollow.js';
import { sweepUntilConverged } from './sweepOrder.mjs';

const outPath = process.argv[2] ?? 'D:/tatsuya/Download/wood-ev-test.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

const srcPath = 'D:/tatsuya/Download/moku4.stq';
const { project } = loadDocument(srcPath);
console.log(`=== ${srcPath} を読み込み、独立EVへfeature設定 ===`);

const plane1 = project.planes.find(p => p.name === '1階');
const g1 = project.graphMap.get(plane1.id);

// (1) 独立部屋の「EV」（1〜3階すべて）へ RoomFeature.ELEVATOR_EQUIPMENT を明示設定。
let independentTouched = 0;
for (const plane of project.planes) {
  const g = project.graphMap.get(plane.id);
  for (const room of g.rooms) {
    if (room.name === 'EV' && room.referenceRoomIds.size === 0 && room.feature == null) {
      room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
      independentTouched++;
      console.log(`${plane.name}: 独立EV部屋(${room.id.slice(0, 8)})へ feature=elevatorEquipment を設定`);
    }
  }
}
if (independentTouched === 0) throw new Error('feature未設定の独立「EV」部屋が見つかりませんでした（moku4.stqの構成が変わった？）');

// ---- 本番の壁再生成（structAnchorProbe.mjs runSweep と同じ関数列）----
const graphMapPeek = async (plane) => project.graphMap.get(plane.id) ?? null;
floorSwapManager.peek = graphMapPeek;
const materialMap = await loadMaterialMap();

async function runSweep() {
  const changed = [];
  for (const p of project.planes) {
    const graph = project.graphMap.get(p.id);
    if (graph.wallFreshnessKey == null && graph.walls.length === 0) continue;
    runInAction(() => conformWoodBacking(graph, project));
    if (wallFreshnessKey(graph, project) === graph.wallFreshnessKey) continue;
    const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(graph, project, graphMapPeek);
    const before = wallBackingCenters(graph);
    const { regenerated } = await regenerateWalls(graph, { materialMap, project, stairUnderEntries, extraStairOpenings });
    if (!regenerated) continue;
    const moves = mapBackingCenterMoves(before, wallBackingCenters(graph));
    if (moves.length > 0) followWallBeamAxes(graph, moves);
    graph.setWallFreshnessKey(wallFreshnessKey(graph, project));
    changed.push(p.name);
  }
  return changed;
}
// 1階に feature を設定したので鍵は自動的に不一致になり sweep 対象になるが、念のため明示的に
// 鍵を崩す（壁再生成を必ず発火させる）。
g1.setWallFreshnessKey(null);
console.log('壁再生成対象階:', await runSweep());

const converged = await sweepUntilConverged(project, 'desc');
if (converged == null) console.error('警告: 構造再計算が収束しなかった（8sweep超もchangedあり）');

// ---- 実測: 独立EVの4隅に柱が立っているか ----
function cornersOf(key, g) {
  const b = cellBoundsFromKey(key, g);
  return [[b.x1, b.y1], [b.x2, b.y1], [b.x1, b.y2], [b.x2, b.y2]];
}
function columnsNear(g, corners) {
  return corners.map(([cx, cy]) => g.columns.find(c => Math.abs(c.axisX - cx) < 200 && Math.abs(c.axisY - cy) < 200) ?? null);
}
for (const plane of project.planes) {
  const g = project.graphMap.get(plane.id);
  const room = g.rooms.find(r => r.name === 'EV' && r.referenceRoomIds.size === 0);
  if (!room) continue;
  const key = [...room.cells][0];
  const corners = cornersOf(key, g);
  const cols = columnsNear(g, corners);
  console.log(`${plane.name} 独立EVの4隅:`, corners, '→柱:', cols.map(c => c ? `${c.axisX},${c.axisY}` : 'なし'));
  if (cols.some(c => !c)) {
    console.error(`NG: ${plane.name} 独立EVの4隅に柱が揃っていません`);
    process.exitCode = 1;
  }
}
if (process.exitCode) process.exit(process.exitCode);
console.log('OK: 独立EVの4隅に柱あり');

// ---- 往復テスト（既存ファイルは上書きしない。書いて読み直して部屋・壁・柱のダイジェスト一致を確認） ----
function digestProject(proj) {
  const out = {};
  for (const plane of proj.planes) {
    const g = proj.graphMap.get(plane.id);
    out[plane.name] = {
      walls: g.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${w.axisCL.effectiveValue}`).sort(),
      rooms: g.rooms.map(r => `${r.name}:${r.feature}:${[...r.referenceRoomIds].sort()}:${[...r.cells].sort().join(',')}`).sort(),
      columns: g.columns.map(c => `${Math.round(c.axisX)}:${Math.round(c.axisY)}`).sort(),
    };
  }
  return JSON.stringify(out);
}

const floors = [...project.planes].map(p => ({ planeId: p.id, bytes: serializeGraph(project.graphMap.get(p.id)) }));
const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
const planesBytes = serializePlanes(project);
const json = buildDocumentJson({ floors, struct, planes: planesBytes, site: null, info: null, bootPlaneId: project.activePlaneId });

const doc = parseDocumentEnvelope(JSON.parse(json));
const project2 = new Project('probe', 'probe');
restoreStructCLs(project2.structGraph, project2.structuralInfo, doc.struct, project2.memberGroupLedger);
const { planes: decodedPlanes, activePlaneId } = decodePlanes(doc.planes);
for (const p of decodedPlanes) {
  project2.addPlane(p.elevation, p.name, p.id, p.startFloor, p.stories, p.isAlternative, p.referenceId, p.altIndex, p.isRoofPlane, p.roofForPlaneId);
}
for (const f of doc.floors) {
  const g = project2.graphMap.get(f.planeId);
  if (g) restoreGraph(g, f.bytes);
}
if (activePlaneId && project2.planeMap.has(activePlaneId)) project2.activePlaneId = activePlaneId;

const before = digestProject(project);
const after = digestProject(project2);
if (before !== after) {
  console.error('NG: 往復テスト不一致（書いて読み直したダイジェストが元と異なる）');
  process.exitCode = 1;
} else {
  console.log('OK: 往復テスト一致（壁・部屋・柱のダイジェストが書き戻し後も同一）');
}

if (process.exitCode) process.exit(process.exitCode);

fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');
