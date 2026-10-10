// 平面の断面解決の新レイヤ（S4。renderer/PlanSolidsLayer.jsx）を実機で確認するためのテスト用 .stq を作るスクリプト。
//
// moku4.stq（在来木造・3階建て）の2階に、構造リストの「＋追加」と同じ経路（structural/manualMemberAdd.js addManualBeam）で
// 梁を2本足し、天端レベル（levelOffset）と断面（成）を差し替える:
//   (A) 子ども1の中央 V1820（y-7280..-3640）: 断面 WOOD-120x300・天端 FL+1200 → 下端 900。切断高 1500 より下＝見えがかり（細線の帯）
//   (B) 予備室の H-10794（x3640..7280）: 断面 WOOD-120x360・天端 FL+1800 → 下端 1440。切断面をまたぐ＝切断（太線の帯）
// 木造の断面カタログの最大の成は 360 のため、B は成 600・天端 2000 ではなく 360・1800 で切断面（1500）をまたがせる。
// 手動追加材は locked なので、構造の再計算（sweepUntilConverged）を通しても消えない・値が変わらないことを実測してから保存する。
// 保存前に往復テスト（書いて読み直して部屋・壁・梁のダイジェスト一致）を通す。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makePlanSolidsTestDoc.mjs [出力先.stq]
// 既存ファイルは上書きしない。
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, planCutHeightMmOf } from '../../src/core.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { addManualBeam } from '../../src/structural/manualMemberAdd.js';
import { planSolidsLayerPrimitives } from '../../src/plan/planSolidsLayerFilter.js';
import { sweepUntilConverged } from './sweepOrder.mjs';

const outPath = process.argv[2] ?? 'D:/tatsuya/Download/plan-solids-test.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

const srcPath = 'D:/tatsuya/Download/moku4.stq';
const { project } = loadDocument(srcPath);
console.log(`=== ${srcPath} を読み込み、2階に手動の梁を 2 本足す ===`);

const plane2 = project.planes.find(p => p.name === '2階');
const plane1 = project.planes.find(p => p.name === '1階');
const g2 = project.graphMap.get(plane2.id);
const gridAt = (list, v) => {
  const cl = list.find(c => Math.abs(c.effectiveValue - v) < 0.5);
  if (!cl) throw new Error(`通り芯 ${v} が見つかりません（moku4.stq の構成が変わった？）`);
  return cl;
};

// 他階の読み出しは project 内のグラフで済ませる（本番の peek の代わり。makeWoodVoidTestDoc.mjs と同じ）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

// 前提: 追加前の構造が収束していること（追加の影響だけを見るため）。
const base = await sweepUntilConverged(project, 'desc');
if (base == null) { console.error('NG: 追加前に構造再計算が収束しません'); process.exit(1); }
const beamsBefore = g2.beams.length;

// 在来木造は梁の材幅を柱寸（この文書は 120）に揃える再計算が走るので、最初から 120 幅で指定する（成は不変）。
const A = { section: 'WOOD-120x300', levelOffset: 1200 };
const B = { section: 'WOOD-120x360', levelOffset: 1800 };
let beamA, beamB;
runInAction(() => {
  beamA = addManualBeam(g2, project, {
    axisCL: gridAt(g2.gridXs, 1820), isVertical: true, clStart: gridAt(g2.gridYs, -7280), clEnd: gridAt(g2.gridYs, -3640),
  });
  beamB = addManualBeam(g2, project, {
    axisCL: gridAt(g2.gridYs, -10794), isVertical: false, clStart: gridAt(g2.gridXs, 3640), clEnd: gridAt(g2.gridXs, 7280),
  });
  for (const [beam, spec] of [[beamA, A], [beamB, B]]) {
    beam.setField('sectionDefId', spec.section);
    beam.setField('levelOffset', spec.levelOffset);
  }
});
console.log(`2階: 手動梁 A(${beamA.id.slice(0, 8)}) B(${beamB.id.slice(0, 8)}) を追加。梁 ${beamsBefore} → ${g2.beams.length} 本`);

// ---- 構造の再計算を通しても手動梁が消えない・値が変わらない ----
const idsBeforeSweep = new Map(g2.beams.map(b => [b.id, b]));
const brief = (b) => `${b.role} ${b.isVertical ? 'V' : 'H'}${Math.round(b.axisValue)} [${Math.round(b.coord1)},${Math.round(b.coord2)}]`;
const converged = await sweepUntilConverged(project, 'desc');
if (converged == null) { console.error('NG: 追加後に構造再計算が収束しません'); process.exit(1); }
console.log(`構造再計算は ${converged} sweep で収束`);
const same = (beam, spec) => g2.beamMap.get(beam.id) === beam && beam.sectionDefId === spec.section
  && beam.levelOffset === spec.levelOffset && beam.dimensionStatus === 'locked';
if (!same(beamA, A) || !same(beamB, B)) {
  const brief = (beam) => ({ inMap: g2.beamMap.get(beam.id) === beam, section: beam.sectionDefId, levelOffset: beam.levelOffset, status: beam.dimensionStatus, role: beam.role });
  console.error('NG: 構造再計算で手動梁が消えた／値が変わった', { A: brief(beamA), B: brief(beamB) });
  process.exit(1);
}
console.log(`OK: 再計算後も A・B が残り、断面・天端・locked は不変。梁は ${g2.beams.length} 本（追加前 ${beamsBefore} + 2 = ${beamsBefore + 2}）`);
if (g2.beams.length !== beamsBefore + 2) {
  console.log('注意: 再計算で他の梁の本数が変わった（A・B の追加に伴う自動梁の整理）');
  const now = new Set(g2.beams.map(b => b.id));
  for (const [id, b] of idsBeforeSweep) if (!now.has(id)) console.log(`  撤去: ${brief(b)} (${b.dimensionStatus})`);
  for (const b of g2.beams) if (!idsBeforeSweep.has(b.id)) console.log(`  新規: ${brief(b)} (${b.dimensionStatus})`);
}

// ---- 平面の断面解決（S4 と同じ入口）で A が細線・B が太線で出ることを実測 ----
const belowPeek = { graph: project.graphMap.get(plane1.id), floorHeightMm: plane2.elevation - plane1.elevation };
const cutZ = planCutHeightMmOf(plane2);
const prims = planSolidsLayerPrimitives({ graph: g2, belowPeek, cutZ });
let ok = true;
for (const [name, beam, expectCls] of [['A', beamA, 'below'], ['B', beamB, 'cut']]) {
  const lines = prims.filter(p => p.source.id === beam.id);
  const clsSet = [...new Set(lines.map(p => `${p.cls}/${p.weight}`))];
  console.log(`  ${name}: 線 ${lines.length} 本 ${clsSet.join(',')}`);
  for (const p of lines) console.log(`    [${p.points.map(v => Math.round(v * 10) / 10).join(', ')}]`);
  if (lines.length === 0 || lines.some(p => p.cls !== expectCls)) { ok = false; console.error(`NG: ${name} は ${expectCls} の線だけのはず`); }
}
if (!ok) process.exit(1);

// ---- 往復テスト（書いて読み直して部屋・壁・梁のダイジェスト一致を確認） ----
function digestProject(proj) {
  const out = {};
  for (const plane of proj.planes) {
    const g = proj.graphMap.get(plane.id);
    out[plane.name] = {
      walls: g.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${w.axisCL.effectiveValue}`).sort(),
      rooms: g.rooms.map(r => `${r.name}:${r.feature}:${[...r.referenceRoomIds].sort()}:${[...r.cells].sort().join(',')}`).sort(),
      beams: g.beams.map(b => `${b.role}:${b.isVertical}:${Math.round(b.axisCL.effectiveValue)}:${Math.round(b.clStart.effectiveValue)}:${Math.round(b.clEnd.effectiveValue)}:${b.sectionDefId}:${b.levelOffset}:${b.dimensionStatus}`).sort(),
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
  project2.addPlane(p.elevation, p.name, p.id, p.startFloor, p.stories, p.isAlternative, p.referenceId, p.altIndex, p.isRoofPlane, p.roofForPlaneId, p.planCutHeightMm, p.ceilingCutHeightMm);
}
for (const f of doc.floors) {
  const g = project2.graphMap.get(f.planeId);
  if (g) restoreGraph(g, f.bytes);
}
if (activePlaneId && project2.planeMap.has(activePlaneId)) project2.activePlaneId = activePlaneId;

if (digestProject(project) !== digestProject(project2)) {
  console.error('NG: 往復テスト不一致（書いて読み直したダイジェストが元と異なる）');
  process.exit(1);
}
console.log('OK: 往復テスト一致（壁・部屋・梁（断面・天端・状態を含む）のダイジェストが書き戻し後も同一）');

fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');
