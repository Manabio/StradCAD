// 木造EVの4隅柱（実装指示書ステップ8・2026-09-29）を実データで確認するためのテスト用 .stq を作る
// スクリプト。
//
// QA是正（F2・2026-09-29）: 旧版は room.feature を書き換えるだけで壁を再生成しておらず、実際には
// 「壁生成が feature を問わない」ことの検証になっていなかった（moku4.stq の既存「EV」部屋は独立部屋
// （referenceRoomIds空）のため isInteriorWallTarget は元々対象——部分指定（親部屋の中に埋め込んだ
// EV）の不具合はこの経路では踏めない）。本版は
//   (1) moku4.stq の既存「EV」部屋（独立部屋）へ RoomFeature.EV を明示設定
//   (2) 1階「売場」の内部セル1つを親部屋の中の**部分指定EV**として切り出す
//       （FinishModeState.js「その他セル — 新規部分指定」経路と同じ形＝
//       cells={対象セル}, referenceRoomIds={売場.id}）
// の両方を作ったうえで、本番の壁再生成（finish/wallRegeneration.js regenerateWalls。
// structAnchorProbe.mjs runSweep と同じ関数列: conformWoodBacking→wallFreshnessKey比較→
// resolveStairContext→regenerateWalls→wallBackingCenters/followWallBeamAxes）→全階の構造再計算
// （sweepUntilConverged）まで通し、(1)(2) どちらの EV も4隅に柱が立つことを実測してから保存する。
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
console.log(`=== ${srcPath} を読み込み、(1)独立EVへfeature設定 (2)売場の内部セルへ部分指定EVを追加 ===`);

const plane1 = project.planes.find(p => p.name === '1階');
const g1 = project.graphMap.get(plane1.id);

// (1) 独立部屋の「EV」（1〜3階すべて）へ RoomFeature.EV を明示設定。
let independentTouched = 0;
for (const plane of project.planes) {
  const g = project.graphMap.get(plane.id);
  for (const room of g.rooms) {
    if (room.name === 'EV' && room.referenceRoomIds.size === 0 && room.feature == null) {
      room.setFeature(RoomFeature.EV);
      independentTouched++;
      console.log(`${plane.name}: 独立EV部屋(${room.id.slice(0, 8)})へ feature=ev を設定`);
    }
  }
}
if (independentTouched === 0) throw new Error('feature未設定の独立「EV」部屋が見つかりませんでした（moku4.stqの構成が変わった？）');

// (2) 1階「ホール」の内部セル1つを部分指定EVとして切り出す（FinishModeState.js「その他セル —
// 新規部分指定」経路と同じ形）。対象セルは x:0..1820, y:-9884..-9100。
//
// QA是正（2026-09-29 再指摘）: moku4.stq は実データのため構造グリッドが密で、当初選んだ
// 「売場」内部セルの4隅は（部分指定EVを足す前から）他の候補源（3b＝上階柱の直下投影・別の壁の
// 交点）で既に柱があり、isInteriorWallTargetの例外を外しても4隅の柱有無だけでは判別できなかった
// （実測: 修正を外しても4隅とも柱あり。origins=`above,wall`＝この座標は元々本物の壁交点）。
// 1階の全部屋・全セル・全隅を走査し「柱が1本も無い座標」を探したところ、4隅すべてが柱ゼロの
// セルは1つも無かった（moku4はこのくらい密）——そこで「4隅のうち2隅だけ柱ゼロ」の「ホール」の
// セル（x:0..1820,y:-9884..-9100。上2隅(0,-9884)(1820,-9884)は柱ゼロ、下2隅(0,-9100)(1820,-9100)は
// 他の理由で既に柱あり）を選び、**判別力のある2隅**で修正の有無を見分けられるようにした
// （検証結果は下記コメント「修正を外した状態でのNG確認」参照）。
const hall = g1.rooms.find(r => r.name === 'ホール');
if (!hall) throw new Error('1階「ホール」が見つかりません（moku4.stqの構成が変わった？）');
const targetCell = [...hall.cells].find(k => {
  const b = cellBoundsFromKey(k, g1);
  return b && Math.abs(b.x1 - 0) < 1 && Math.abs(b.x2 - 1820) < 1 && Math.abs(b.y1 - (-9884)) < 1 && Math.abs(b.y2 - (-9100)) < 1;
});
if (!targetCell) throw new Error('ホールの対象セル(0..1820, -9884..-9100)が見つかりません');
const partialEv = g1.addRoom(new Set([targetCell]), 'EV(部分指定)', crypto.randomUUID(), new Set([hall.id]));
partialEv.setFeature(RoomFeature.EV);
console.log(`1階: ホール(${hall.id.slice(0, 8)})の内部セルへ部分指定EV(${partialEv.id.slice(0, 8)})を追加`, cellBoundsFromKey(targetCell, g1));
// 判別力のある2隅（修正が無いと柱が立たないはずの座標）。
const discriminatingCorners = [[0, -9884], [1820, -9884]];

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
// 1階に部屋を追加したので鍵は自動的に不一致になり sweep 対象になるが、念のため明示的に鍵を崩す
// （追加した部分指定EVぶんの壁再生成を必ず発火させる）。
g1.setWallFreshnessKey(null);
console.log('壁再生成対象階:', await runSweep());

const converged = await sweepUntilConverged(project, 'desc');
if (converged == null) console.error('警告: 構造再計算が収束しなかった（8sweep超もchangedあり）');

// ---- 実測: 独立EV・部分指定EVそれぞれの4隅に柱が立っているか ----
function cornersOf(key, g) {
  const b = cellBoundsFromKey(key, g);
  return [[b.x1, b.y1], [b.x2, b.y1], [b.x1, b.y2], [b.x2, b.y2]];
}
function columnsNear(g, corners) {
  return corners.map(([cx, cy]) => g.columns.find(c => Math.abs(c.axisX - cx) < 200 && Math.abs(c.axisY - cy) < 200) ?? null);
}
const partialEvCorners = cornersOf(targetCell, g1);
const partialEvCols = columnsNear(g1, partialEvCorners);
console.log('部分指定EVの4隅:', partialEvCorners, '→柱:', partialEvCols.map(c => c ? `${c.axisX},${c.axisY}` : 'なし'));
console.log('部分指定EVの generatedWallIds:', partialEv.generatedWallIds.size);
if (partialEvCols.some(c => !c)) {
  console.error('NG: 部分指定EVの4隅に柱が揃っていません');
  process.exitCode = 1;
}
// QA是正（2026-09-29 再指摘・2点）:
// (a) 4隅の柱有無だけでは、他の候補源（3b等）や既存の壁交点で偶然揃うケースと区別できない——
//     isInteriorWallTargetの例外が効いたかどうかは、部分指定EV自身が壁を生成できたか
//     （generatedWallIds）で直接確かめる。この矩形は4辺のうち1辺（y=-9100側）が別の実在部屋の
//     外周と同位置のため、その1本はEV自身の生成に依らず既に存在する——実測: 修正ありで3本
//     （新規に3辺を自分で生成）・修正無しで0本（実測済み。下記コメント参照）。「0本」との
//     判別が目的のため閾値は1本以上とする。
if (partialEv.generatedWallIds.size < 1) {
  console.error(`NG: 部分指定EVの generatedWallIds が0本——isInteriorWallTargetの対象になっていない`);
  process.exitCode = 1;
}
// (b) 判別力のある2隅（(0,-9884)(1820,-9884)。moku4では他の候補源を持たず、修正が無いと柱ゼロに
//     なることを実測済み）だけは、柱の座標一致だけでなく「起源」まで見る——woodColumnOrigins に
//     'wall'（3a＝壁交点由来）が含まれることを確認する。
for (const [cx, cy] of discriminatingCorners) {
  const col = g1.columns.find(c => Math.abs(c.axisX - cx) < 200 && Math.abs(c.axisY - cy) < 200);
  if (!col) {
    console.error(`NG: 判別力のある隅(${cx},${cy})に柱がありません`);
    process.exitCode = 1;
    continue;
  }
  const origins = String(col.woodColumnOrigins ?? '');
  console.log(`判別力のある隅(${cx},${cy}): 柱 origins=${origins}`);
  if (!origins.includes('wall')) {
    console.error(`NG: 判別力のある隅(${cx},${cy})の柱がwall由来(3a)ではありません（origins=${origins}）`);
    process.exitCode = 1;
  }
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
console.log('OK: 独立EV・部分指定EVいずれも4隅に柱あり');

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
