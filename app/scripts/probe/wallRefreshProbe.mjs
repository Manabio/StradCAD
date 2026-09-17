// 壁の再生成をFinishModeStateから独立させる計画のステップ4（wallRefresh.js
// refreshWallsAllFloors）を、実データ（.stq）に適用した効果を確認するprobe。
// IndexedDBを使わず project.graphMap（loadDoc.mjsで全階メモリ展開済み）を
// floorSwapManager.peek の代わりに使う（scripts/probe/dumpPlanRegen.mjsと同じ考え方。
// 構造再計算のwallGate等が内部で使うpeekにも同じ差し替えを効かせるため、
// floorSwapManager.peek 自体をこのプロセス内だけ上書きする）。
// structuralOrchestration.js の recomputeInactiveStructural 等が使う saveFloor（IndexedDB
// 書込み）はこのprobeでは通らない経路（recomputeStructuralForGraph を各階へ直接・
// インメモリで適用し、保存はしない）を使うため、Node上で完結する。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/wallRefreshProbe.mjs [入力.stq]
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadMaterialMap, regenerateWalls } from '../../src/finish/wallRegeneration.js';
import { wallFreshnessKey } from '../../src/finish/wallFreshnessKey.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { conformWoodBacking } from '../../src/structural/woodAutoFill.js';
import { wallBackingCenters, mapBackingCenterMoves } from '../../src/structural/wallBeamAxes.js';
import { followWallBeamAxes } from '../../src/structural/wallBeamAxisFollow.js';
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku1.stq';
const { project } = loadDocument(src);
// graphMap に全階が既に展開済みのため peek は同期的に引くだけでよい（IDB抜き。
// dumpPlanRegen.mjs・wallRefresh.js と同じ finish/stair/stairUnderRooms.js の
// resolveStairContext を使う。階段コンテキスト解決の単一ソース化）。
const graphMapPeek = async (plane) => project.graphMap.get(plane.id) ?? null;

function exteriorWallThickness(graph) {
  const wall = graph.walls.find(w => w.isExteriorWall);
  if (!wall?.backingRange) return null;
  return Math.round(wall.backingRange.hi - wall.backingRange.lo);
}

function report(label) {
  console.log(`=== ${label} ===`);
  for (const p of project.planes) {
    const g = project.graphMap.get(p.id);
    console.log(JSON.stringify({
      plane: p.name, structureOverride: g.structureOverride, interiorWallBacking: g.interiorWallBacking,
      exteriorWallBacking: g.exteriorWallBacking, columns: g.columns.length,
      exteriorWallThicknessMm: exteriorWallThickness(g), wallFreshnessKey: g.wallFreshnessKey,
    }));
  }
}

// 壁の形状だけを比較するダイジェスト（wall id等は再生成のたびに変わるため、実座標
// （axisValue・両端・下地帯）で幾何のみを比較する。finish/finishBoundary.test.js の
// wallDigest・scripts/probe/diffPlanRegen.mjs と同じ考え方）。
function wallDigest(graph) {
  return graph.walls.map(w => [
    w.isVertical, Math.round(w.axisValue), Math.round(w.coord1), Math.round(w.coord2),
    Math.round(w.materialRange?.lo ?? NaN), Math.round(w.materialRange?.hi ?? NaN),
  ].join(':')).sort().join('|');
}

function digestSummary() {
  return project.planes.map(p => {
    const g = project.graphMap.get(p.id);
    return { plane: p.name, walls: g.walls.length, digestHash: wallDigest(g).length };
  });
}

// ステップ4/5: 壁の再生成（鍵不一致の階だけ。wallRefresh.js refreshWallsForGraph 相当。
// ステップ5: 文書読込み直後にこのsweepを1回通す想定と同じ入力で確認する）。
const materialMap = await loadMaterialMap();
async function runSweep() {
  const changedPlaneIds = [];
  for (const p of project.planes) {
    const graph = project.graphMap.get(p.id);
    // S4-1裁定: 壁0本・鍵nullの階（未脱出階）はsweep対象外——wallRefresh.jsのrefreshWallsForGraphと
    // 同じガード（woodAutoFill.jsの「壁0本の階は柱を保全」2026-09-14裁定と整合）。
    if (graph.wallFreshnessKey == null && graph.walls.length === 0) continue;
    runInAction(() => conformWoodBacking(graph, project));
    const keyNow = wallFreshnessKey(graph, project);
    if (keyNow === graph.wallFreshnessKey) continue;

    const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(graph, project, graphMapPeek);
    const backingCentersBefore = wallBackingCenters(graph);
    const { regenerated } = await regenerateWalls(graph, { materialMap, project, stairUnderEntries, extraStairOpenings });
    if (!regenerated) continue;
    const backingCentersAfter = wallBackingCenters(graph);
    const moves = mapBackingCenterMoves(backingCentersBefore, backingCentersAfter);
    if (moves.length > 0) followWallBeamAxes(graph, moves);
    graph.setWallFreshnessKey(wallFreshnessKey(graph, project));
    changedPlaneIds.push(p.id);
  }
  return changedPlaneIds;
}

report('before');

// 1回目のsweep（文書読込み直後に相当。鍵不一致の階だけ壁を作り直す）。
const changedPlaneIds1st = await runSweep();
console.log('1回目 changedPlaneIds', changedPlaneIds1st);
console.log('1回目後の壁ダイジェスト', JSON.stringify(digestSummary()));

// 壁交点柱・conformWoodSections（既存プリミティブ）を全階へインメモリで適用する
// （wallRefresh.js は recomputeActiveStructural / reflectStructuralToOtherFloors 経由で
// これを行うが、両者は非アクティブ階の保存に IndexedDB の saveFloor を使うため、
// このprobeでは対応するコア計算 recomputeStructuralForGraph を直接・全階へ適用し、
// 保存はしない＝柱本数・壁厚の検証だけが目的のため無害）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
for (const p of project.planes) {
  const graph = project.graphMap.get(p.id);
  const mainStructure = graph.structureOverride ?? project.structuralInfo.mainStructure;
  await recomputeStructuralForGraph(graph, project, mainStructure);
}

report('after');

// 2回目のsweep（同じ文書に対しもう一度読込みが起きた想定）。鍵が全階一致しているはずなので
// no-op（changedPlaneIdsが空）になることを確認する——ステップ5の「鍵一致で何も変わらなければ
// dirtyにしない」の裏取り。
const changedPlaneIds2nd = await runSweep();
console.log('2回目 changedPlaneIds（no-opなら空配列のはず）', changedPlaneIds2nd);
if (changedPlaneIds2nd.length > 0) {
  console.error('NG: 2回目のsweepでchangedPlaneIdsが空でない（no-opになっていない）', changedPlaneIds2nd);
  process.exitCode = 1;
} else {
  console.log('OK: 2回目のsweepはno-op');
}
