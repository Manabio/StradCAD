// 在来木造の吹抜け小梁（吹抜け小梁の共通仕様ステップ S3。structural/woodOpeningBeams.js）を実データで
// 確認するためのテスト用 .stq を作るスクリプト。
//
// moku4.stq の2階「廊下」（8セルの親部屋。referenceRoomIds空）の隅のセル1つ
// （x0..1820 × y-10794..-9884）を、仕上げモードの新規部分指定と同じ手順
// （modes/FinishModeState.js: graph.addRoom(cells, '', id, new Set([親.id])) → applyDefaultBaseboard →
// 命名で feature=VOID）で「吹抜け」にする。このセルの辺は
//   外周側 x=0（廊下の外壁）・y=-10794（EVとの間仕切壁）＝壁あり
//   内側   x=1820・y=-9884（同じ廊下の内部）＝壁なし（部分指定の吹抜けは壁を持たない。
//          finish/wallGeneration.js isInteriorWallTarget の部分指定例外に VOID は無い）
// になり、壁なしの2辺だけ梁が無い。本番の壁再生成（structAnchorProbe.mjs runSweep と同じ関数列）→
// 全階の構造再計算（sweepUntilConverged）まで通して、小梁が壁なしの辺だけに最短スパンの辺から順に
// 架かることを実測してから保存する。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeWoodVoidTestDoc.mjs [出力先.stq]
// 既存ファイルは上書きしない。
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, RoomFeature, applyDefaultBaseboard } from '../../src/core.js';
import { cellBoundsFromKey } from '../../src/finish/gridCells.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadMaterialMap, regenerateWalls } from '../../src/finish/wallRegeneration.js';
import { wallFreshnessKey } from '../../src/finish/wallFreshnessKey.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { conformWoodBacking } from '../../src/structural/woodAutoFill.js';
import { wallBackingCenters, mapBackingCenterMoves } from '../../src/structural/wallBeamAxes.js';
import { followWallBeamAxes } from '../../src/structural/wallBeamAxisFollow.js';
import { openingEdgeComponents } from '../../src/structural/openingBeamAxes.js';
import { sweepUntilConverged } from './sweepOrder.mjs';

const outPath = process.argv[2] ?? 'D:/tatsuya/Download/wood-void-test.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

const srcPath = 'D:/tatsuya/Download/moku4.stq';
const { project } = loadDocument(srcPath);
console.log(`=== ${srcPath} を読み込み、2階「廊下」の隅のセルを部分指定の吹抜けにする ===`);

const plane2 = project.planes.find(p => p.name === '2階');
const g2 = project.graphMap.get(plane2.id);

// (1) 親部屋「廊下」と、その隅のセル（x0..1820 × y-10794..-9884）。
const parent = g2.rooms.find(r => r.name === '廊下' && r.referenceRoomIds.size === 0 && r.feature == null);
if (!parent) throw new Error('2階に feature未設定の独立「廊下」部屋が見つかりませんでした（moku4.stqの構成が変わった？）');
const voidKey = [...parent.cells].find(k => {
  const b = cellBoundsFromKey(k, g2);
  return b && b.x1 === 0 && b.x2 === 1820 && b.y1 === -10794 && b.y2 === -9884;
});
if (!voidKey) throw new Error('「廊下」に x0..1820 × y-10794..-9884 のセルが見つかりませんでした');
if (g2.rooms.some(r => r.name === '吹抜け')) throw new Error('2階に既に「吹抜け」部屋があります');

runInAction(() => {
  const room = g2.addRoom(new Set([voidKey]), '', crypto.randomUUID(), new Set([parent.id]));
  applyDefaultBaseboard(room);
  room.setName('吹抜け');
  room.setFeature(RoomFeature.VOID);
});
const voidRoom = g2.rooms.find(r => r.name === '吹抜け');
console.log(`2階: 部分指定の吹抜け(${voidRoom.id.slice(0, 8)}) 親=廊下(${parent.id.slice(0, 8)}) cells=${[...voidRoom.cells]}`);

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
// 部屋を足したので鍵は自動的に不一致になるが、念のため明示的に崩して壁再生成を必ず発火させる。
g2.setWallFreshnessKey(null);
console.log('壁再生成対象階:', await runSweep());

const converged = await sweepUntilConverged(project, 'desc');
if (converged == null) console.error('警告: 構造再計算が収束しなかった（8sweep超もchangedあり）');
else console.log(`構造再計算は ${converged} sweep で収束`);

// ---- 実測: 吹抜けの辺ごとの壁・梁と、生成された小梁 ----
const b = cellBoundsFromKey(voidKey, g2);
const comps = openingEdgeComponents(g2);
console.log(`2階の吹抜け成分: ${comps.length}（セル x${b.x1}..${b.x2} × y${b.y1}..${b.y2}）`);
const beamBrief = (bm) => `${bm.role}${bm.beamType ? `(${bm.beamType})` : ''} ${bm.isVertical ? 'V' : 'H'}${Math.round(bm.axisCL.effectiveValue)} ${Math.round(bm.clStart.effectiveValue)}..${Math.round(bm.clEnd.effectiveValue)} auto=${bm.dimensionStatus === 'auto'}`;
// 辺の上の壁: 同一軸で辺と重なる壁。角に壁の端が壁厚ぶん入り込むだけ（> 100 に満たない）ものは数えない。
const wallOn = (e) => g2.walls.some(w => w.isVertical === e.isVertical && Math.abs(w.axisCL.effectiveValue - e.coord) < 1
  && Math.min(Math.max(w.coord1, w.coord2), e.hi) - Math.max(Math.min(w.coord1, w.coord2), e.lo) > 100);
const beamsOn = (e) => g2.beams.filter(bm => bm.isVertical === e.isVertical && Math.abs(bm.axisCL.effectiveValue - e.coord) < 130
  && Math.min(Math.max(bm.clStart.effectiveValue, bm.clEnd.effectiveValue), e.hi) - Math.max(Math.min(bm.clStart.effectiveValue, bm.clEnd.effectiveValue), e.lo) > 1);
for (const c of comps) {
  for (const e of c) {
    const bs = beamsOn(e);
    const tag = bs.some(x => x.role === 'secondary') ? 'placed(小梁)' : bs.length > 0 ? 'covered' : 'なし';
    console.log(`  辺 ${e.isVertical ? 'V' : 'H'}${e.coord} [${e.lo},${e.hi}] 壁=${wallOn(e) ? 'あり' : 'なし'} → ${tag}`);
    for (const x of bs) console.log(`      ${beamBrief(x)}`);
  }
}
const smalls = g2.beams.filter(x => x.role === 'secondary');
console.log(`2階の role:secondary 小梁 ${smalls.length} 本:`);
for (const x of smalls) console.log(`  ${beamBrief(x)} axisCL由来=${x.axisCL.beamAxisOrigin}`);

// 実測の判定: 壁なしの辺には小梁が架かり、壁ありの辺には小梁が無い。
let ok = comps.length === 1;
for (const e of comps.flat()) {
  const hasSmall = beamsOn(e).some(x => x.role === 'secondary');
  if (wallOn(e) === hasSmall) { ok = false; console.error(`NG: 辺 ${e.isVertical ? 'V' : 'H'}${e.coord} 壁=${wallOn(e)} 小梁=${hasSmall}`); }
}
if (!ok) {
  console.error('NG: 壁なしの辺だけに小梁が架かる、という期待と一致しません');
  process.exit(1);
}
console.log('OK: 壁なしの辺だけに小梁が架かっている');

// ---- 往復テスト（書いて読み直して部屋・壁・柱・小梁のダイジェスト一致を確認） ----
function digestProject(proj) {
  const out = {};
  for (const plane of proj.planes) {
    const g = proj.graphMap.get(plane.id);
    out[plane.name] = {
      walls: g.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${w.axisCL.effectiveValue}`).sort(),
      rooms: g.rooms.map(r => `${r.name}:${r.feature}:${[...r.referenceRoomIds].sort()}:${[...r.cells].sort().join(',')}`).sort(),
      columns: g.columns.map(c => `${Math.round(c.axisX)}:${Math.round(c.axisY)}`).sort(),
      smallBeams: g.beams.filter(x => x.role === 'secondary')
        .map(x => `${x.isVertical}:${Math.round(x.axisCL.effectiveValue)}:${Math.round(x.clStart.effectiveValue)}:${Math.round(x.clEnd.effectiveValue)}`).sort(),
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
  console.log('OK: 往復テスト一致（壁・部屋・柱・小梁のダイジェストが書き戻し後も同一）');
}

if (process.exitCode) process.exit(process.exitCode);

fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');
