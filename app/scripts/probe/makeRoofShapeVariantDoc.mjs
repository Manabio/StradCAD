// 下屋の平面表示（軒先の線・棟木・隅木・谷木。ステップ1。finish/roof/roofPlanFigure.js）を実データで目視確認するための
// テスト用 .stq を作るスクリプト。入力文書の**全下屋（RoomFeature.ROOF の部屋）の形状（roofSpec.shape）を指定値に差し替える**。
// 壁・境界・部屋・セルは変えない（屋根の形状は壁・境界に影響しない）。
//
// 流れ（makeHipRoofTestDoc.mjs と同型）:
//   1. loadDoc.mjs で入力を読み、往復テスト（読み→書き→読みで部屋・壁・柱・梁のダイジェスト一致）を先に通す。
//   2. 全階の下屋の shape を指定値にし、構造再計算を sweepOrder.mjs sweepUntilConverged（本番の反映パスと同じ順序）で収束させる
//      （在来木造では下屋の小屋梁・外周の梁が形状で変わるため）。
//   3. roofPlanFigure の要約（下屋のある階ごとの role 別の線の数）と計算時間（ms）を出す。
//   4. 書いて読み直したダイジェスト一致・全下屋が指定の shape のまま残ることを確かめてから保存する（既存ファイルは上書きしない）。
//
// 使い方（app/ で）:
//   保存: node --import ./scripts/testSetup.mjs scripts/probe/makeRoofShapeVariantDoc.mjs <入力.stq> <shape> <出力.stq>
//         shape = mono | gable | hip | staggered | flat
//   要約だけ（形状を変えず保存もしない。既存の roof-test1〜4 などに）:
//         node --import ./scripts/testSetup.mjs scripts/probe/makeRoofShapeVariantDoc.mjs --summary <入力.stq>
//   目視用の roof-test5〜10（D:/tatsuya/Download）の組合せは本ファイル末尾のコメントを参照。
// .mjs は eslint の対象外。
import fs from 'node:fs';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, RoomFeature, RoofShape, ROOF_SHAPE_LABELS } from '../../src/core.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { leanToPlanRegions } from '../../src/structural/roofFramingRegions.js';
import { roofPlanFigure } from '../../src/finish/roof/roofPlanFigure.js';
import { sweepUntilConverged } from './sweepOrder.mjs';

const args = process.argv.slice(2);
const summaryOnly = args[0] === '--summary';
const srcPath = summaryOnly ? args[1] : args[0];
const shape = summaryOnly ? null : args[1];
const outPath = summaryOnly ? null : args[2];
if (!srcPath || (!summaryOnly && (!shape || !outPath))) {
  console.error('使い方: makeRoofShapeVariantDoc.mjs <入力.stq> <shape> <出力.stq>  /  makeRoofShapeVariantDoc.mjs --summary <入力.stq>');
  process.exit(1);
}
if (!summaryOnly) {
  if (!Object.values(RoofShape).includes(shape)) {
    console.error(`NG: shape が不正です: ${shape}（${Object.values(RoofShape).join(' | ')}）`);
    process.exit(1);
  }
  if (fs.existsSync(outPath)) {
    console.error(`既存ファイルを上書きしません: ${outPath}`);
    process.exit(1);
  }
}
const SWEEP_LIMIT = 5;
const num = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

// ---- 往復（makeHipRoofTestDoc.mjs と同じ。屋根の形状をダイジェストに足す）----
function digestProject(proj) {
  const out = {};
  for (const plane of proj.planes.concat(proj.roofPlane ? [proj.roofPlane] : [])) {
    const g = proj.graphMap.get(plane.id);
    out[plane.name || '屋根'] = {
      walls: g.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${w.axisCL.effectiveValue}`).sort(),
      rooms: g.rooms.map(r => `${r.name}:${r.kind}:${r.feature}:${r.roofSpec?.shape ?? '-'}:${[...r.referenceRoomIds].sort()}:${[...r.cells].sort().join(',')}`).sort(),
      columns: g.columns.map(c => `${Math.round(c.axisX)}:${Math.round(c.axisY)}:${c.role}:${c.sectionDefId}`).sort(),
      beams: g.beams.map(b => `${b.role}:${b.beamType}:${b.isVertical}:${num(b.axisValue)}:${num(b.clStart.effectiveValue)}:${num(b.clEnd.effectiveValue)}:${b.sectionDefId}`).sort(),
    };
  }
  return JSON.stringify(out);
}
function encodeDocument(proj) {
  const floors = [...proj.planes, ...(proj.roofPlane ? [proj.roofPlane] : [])].map(p => ({ planeId: p.id, bytes: serializeGraph(proj.graphMap.get(p.id)) }));
  const struct = serializeStructCLs(proj.structGraph, proj.structuralInfo, proj.memberGroupLedger);
  return buildDocumentJson({ floors, struct, planes: serializePlanes(proj), site: null, info: null, bootPlaneId: proj.activePlaneId });
}
function decodeDocument(json) {
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
  return project2;
}

const roofRoomsOf = (graph) => graph.rooms.filter(r => r.feature === RoomFeature.ROOF && r.roofSpec);

/** roofPlanFigure の要約（下屋のある階ごとに role 別の線の数・region・計算時間）。 */
function printSummary(project) {
  console.log('--- roofPlanFigure の要約（下屋のある階ごと） ---');
  let any = false;
  for (const plane of project.planes) {
    const graph = project.graphMap.get(plane.id);
    const rooms = roofRoomsOf(graph);
    if (rooms.length === 0) continue;
    any = true;
    const times = [];
    let prims = [];
    for (let i = 0; i < 6; i++) { // 初回（JIT 前）と、続く5回の最小
      const t0 = performance.now();
      prims = roofPlanFigure(graph);
      times.push(performance.now() - t0);
    }
    const counts = { outline: 0, ridge: 0, hip: 0, valley: 0 };
    const lines = prims.filter(p => p.kind === 'line');
    const arrows = prims.filter(p => p.kind === 'arrow');
    for (const p of lines) counts[p.role]++;
    const regionMs = (() => { const t0 = performance.now(); leanToPlanRegions(graph); return performance.now() - t0; })();
    console.log(`  [${plane.name || '(無名)'}${plane.isAlternative ? '・検討案' : ''}] 下屋 ${rooms.length} 部屋: 外形線 ${counts.outline} / 棟木 ${counts.ridge} / 隅木 ${counts.hip} / 谷木 ${counts.valley}（線 ${lines.length} 本）・傾斜ラベル ${arrows.length} 面`
      + `  roofPlanFigure 初回 ${times[0].toFixed(1)}ms・以降の最小 ${Math.min(...times.slice(1)).toFixed(1)}ms（leanToPlanRegions 単体 ${regionMs.toFixed(1)}ms）`);
    for (const a of arrows) { // 傾斜ラベルの面ごとの flow（矢印の向き）と基準点（矢印の中点）
      const [tx, ty, hx, hy] = a.points;
      const flow = Math.abs(hx - tx) > Math.abs(hy - ty) ? (hx > tx ? '右' : '左') : (hy > ty ? '下' : '上');
      console.log(`    面 ${a.key.replace(':arrow:', ' #')} flow=${flow} anchor=(${Math.round((tx + hx) / 2)},${Math.round((ty + hy) / 2)})`);
    }
    for (const region of leanToPlanRegions(graph)) {
      const room = rooms.find(r => `lean:${r.id}` === region.key);
      const kind = region.rect ? '矩形' : `L字等（セル矩形 ${region.rects.length}）`;
      const closed = region.exposedPaths.filter(p => p.closed).length;
      console.log(`    ${region.key} 形状=${ROOF_SHAPE_LABELS[region.shape] ?? region.shape}${room?.roofSpec.shape ? '（明示）' : '（自動）'} ${kind}`
        + ` 外形線 ${region.exposedPaths.length} 本（閉 ${closed}・開 ${region.exposedPaths.length - closed}）勾配 ${region.slope}/10${region.leanToWings ? ` 翼 ${region.leanToWings.length}` : ''}`);
    }
  }
  if (!any) console.log('  下屋（屋根の部屋）が1つも無い文書');
}

// ---- 0. 往復テスト（入力文書。先に通す。要約だけのときも通す）----
{
  const { project: p0 } = loadDocument(srcPath);
  const p0b = decodeDocument(encodeDocument(p0));
  if (digestProject(p0) !== digestProject(p0b)) {
    console.error('NG: 往復テスト不一致（入力文書を書いて読み直した部屋・壁・柱・梁のダイジェストが元と異なる）');
    process.exit(1);
  }
  console.log('OK: 往復テスト一致（入力文書。部屋・壁・柱・梁・屋根の形状のダイジェスト）');
}

const { project } = loadDocument(srcPath);
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
console.log(`=== ${srcPath}${summaryOnly ? '（要約だけ。形状は変えない・保存しない）' : `: 全下屋の形状を ${ROOF_SHAPE_LABELS[shape]}（${shape}）へ`} ===`);
console.log('主構造:', project.structuralInfo.mainStructure);

if (summaryOnly) {
  printSummary(project);
  process.exit(0);
}

let changed = 0;
for (const plane of project.planes) {
  for (const room of roofRoomsOf(project.graphMap.get(plane.id))) {
    room.roofSpec.setField('shape', shape);
    changed++;
  }
}
if (changed === 0) {
  console.error('NG: 下屋（屋根の部屋）が1つも無い文書（形状を差し替える対象が無い）');
  process.exit(1);
}
console.log(`形状を差し替えた下屋: ${changed} 部屋`);

const sweeps = await sweepUntilConverged(project, 'desc', 8);
console.log(`収束スイープ数: ${sweeps ?? '未収束'}（上限 ${SWEEP_LIMIT}）`);
if (sweeps == null || sweeps > SWEEP_LIMIT) {
  console.error(`NG: 構造再計算が収束しない（${sweeps ?? '未収束'}）`);
  process.exit(1);
}
printSummary(project);

// ---- 往復（書いて読み直して一致・全下屋が指定の形状のまま）----
if (project.activePlaneId == null || !project.planeMap.has(project.activePlaneId)) project.activePlaneId = project.planes[0].id;
const json = encodeDocument(project);
const reloaded = decodeDocument(json);
if (digestProject(project) !== digestProject(reloaded)) {
  console.error('NG: 往復テスト不一致（書いて読み直したダイジェストが元と異なる）');
  process.exit(1);
}
let remain = 0;
for (const plane of reloaded.planes) {
  for (const room of roofRoomsOf(reloaded.graphMap.get(plane.id))) {
    if (room.roofSpec.shape !== shape) {
      console.error(`NG: 読み直した文書で下屋の形状が ${shape} のまま残っていない（${plane.name}: ${room.roofSpec.shape}）`);
      process.exit(1);
    }
    remain++;
  }
}
if (remain !== changed) {
  console.error(`NG: 読み直した文書の下屋数が合わない（${changed} → ${remain}）`);
  process.exit(1);
}
console.log(`OK: 往復テスト一致（部屋・壁・柱・梁のダイジェスト。下屋 ${remain} 部屋は ${shape} のまま）`);

fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');

// 目視用の組合せ（D:/tatsuya/Download。入力は roof-test1〜3 と同じ文書から作る）:
//   roof-test5  = roof-test3 → gable    roof-test6 = roof-test3 → hip    roof-test7 = roof-test3 → flat
//   roof-test8  = roof-test1 → gable（L字の切妻＝腕ごとに棟木）    roof-test9 = roof-test1 → hip（L字の寄棟）
//   roof-test10 = roof-test2（13＝S造）→ gable
