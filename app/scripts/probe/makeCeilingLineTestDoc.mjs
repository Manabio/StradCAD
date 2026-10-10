// 天井芯（CL の種別 'ceiling'。S8a）を実機で確認するためのテスト用 .stq を作るスクリプト。
//
// moku4.stq（在来木造・3階建て）の2階の主寝室（3640..7280 × -7280..-3640。仕上げのセルは1つ）に、天井芯を縦に1本
// （x=5460。主寝室の中央）引き、天井芯の両側の天井セルへ高さの違う区画（左 2400・右 3000）を付ける。
//   - 天井芯は discipline 'ceiling'・labeled:false。延長は通り芯 Y-7280・Y-3640 を直交端部に参照する（EXTENT_ANCHOR_STYLE.ceiling='ref'）。
//   - 区画のセルは天井セル（仕上げのセルを天井芯でさらに割った格子）の key。書込みは本番と同じ ceiling/ceilingZones.js assignZoneHeight 相当。
// 手順:
//   1. 往復テスト先行: 元の moku4 を「書いて読み直して」部屋・区画・CL のダイジェストが一致することを、編集前に確かめる。
//   2. 編集（天井芯＋区画）。仕上げ・平面（見下げ）の出力が編集前後で変わらない（天井芯が他モードに漏れない）ことを確かめる。
//   3. 見上げ（--up）の出力は 2階だけ変わる（天井芯の線・区画の境界）。1階・3階は不変。
//   4. 編集後も往復テスト（天井芯と区画が書いて読み直して一致）。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeCeilingLineTestDoc.mjs [出力先.stq]
// 既存ファイルは上書きしない。
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, CenterLineType, Discipline, planCutHeightMmOf, ceilingCutHeightMmOf } from '../../src/core.js';
import { worldToCell, getAllCells, CEILING_CELL_GRID } from '../../src/finish/gridCells.js';
import { assignZoneShape } from '../../src/ceiling/ceilingZones.js';
import { ceilingSurfacesOf } from '../../src/ceiling/ceilingSurfaces.js';
import { planSolidsLayerPrimitives, planSolidsLayerPrimitivesUp } from '../../src/plan/planSolidsLayerFilter.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';

const outPath = process.argv[2] ?? 'D:/tatsuya/Download/ceiling-line-test.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

// ---- 往復（本番の保存〜読込みと同じ経路）と、ダイジェスト ----
function digestProject(proj) {
  const out = {};
  for (const plane of proj.planes) {
    const g = proj.graphMap.get(plane.id);
    out[plane.name] = {
      centerLines: g.centerLines.map(c => `${c.id}:${c.centerLineType}:${c.value}:${c.discipline}:${c.lineType}:${c.labeled}:${c.extentLo}:${c.extentHi}`).sort(),
      walls: g.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${w.axisCL.effectiveValue}`).sort(),
      rooms: g.rooms.map(r => `${r.name}:${r.feature}:${[...r.referenceRoomIds].sort()}:${[...r.cells].sort().join(',')}`).sort(),
      zones: g.rooms.map(r => `${r.id}:${r.ceilingZones.map(z => JSON.stringify(z.toData())).join('|')}`).sort(),
    };
  }
  return JSON.stringify(out);
}
function roundTrip(project) {
  const floors = [...project.planes].map(p => ({ planeId: p.id, bytes: serializeGraph(project.graphMap.get(p.id)) }));
  const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const json = buildDocumentJson({ floors, struct, planes: serializePlanes(project), site: null, info: null, bootPlaneId: project.activePlaneId });
  const doc = parseDocumentEnvelope(JSON.parse(json));
  const project2 = new Project('probe', 'probe');
  restoreStructCLs(project2.structGraph, project2.structuralInfo, doc.struct, project2.memberGroupLedger);
  const { planes, activePlaneId } = decodePlanes(doc.planes);
  for (const p of planes) {
    project2.addPlane(p.elevation, p.name, p.id, p.startFloor, p.stories, p.isAlternative, p.referenceId, p.altIndex, p.isRoofPlane, p.roofForPlaneId, p.planCutHeightMm, p.ceilingCutHeightMm);
  }
  for (const f of doc.floors) {
    const g = project2.graphMap.get(f.planeId);
    if (g) restoreGraph(g, f.bytes);
  }
  if (activePlaneId && project2.planeMap.has(activePlaneId)) project2.activePlaneId = activePlaneId;
  return { json, project2 };
}

const srcPath = 'D:/tatsuya/Download/moku4.stq';
const { project } = loadDocument(srcPath);
console.log(`=== ${srcPath} を読み込み、2階の主寝室に天井芯を1本・両側に区画を付ける ===`);

// ---- 1. 往復テスト先行（編集前）----
{
  const { project2 } = roundTrip(project);
  if (digestProject(project) !== digestProject(project2)) {
    console.error('NG: 往復テスト不一致（編集前。書いて読み直したダイジェストが元と異なる）');
    process.exit(1);
  }
  console.log('OK: 往復テスト一致（編集前。CL・壁・部屋・区画のダイジェスト）');
}

// ---- 編集前の出力（見下げ・見上げ。階ごと）と仕上げの格子 ----
const planes = project.planes;
function outputs(proj) {
  const down = {}, up = {}, finishCells = {};
  proj.planes.forEach((plane, idx) => {
    const graph = proj.graphMap.get(plane.id);
    const below = idx > 0 ? proj.planes[idx - 1] : null;
    const belowGraph = below ? proj.graphMap.get(below.id) : null;
    const belowPeek = belowGraph ? { graph: belowGraph, floorHeightMm: plane.elevation - below.elevation } : null;
    const above = idx + 1 < proj.planes.length ? proj.planes[idx + 1] : null;
    const aboveGraph = above ? proj.graphMap.get(above.id) : null;
    const abovePeek = aboveGraph ? { graph: aboveGraph, floorHeightMm: above.elevation - plane.elevation } : null;
    const selfRiserOf = s => stairRiserOf(s, proj, plane);
    const strip = ps => JSON.stringify(ps.map(p => ({ key: p.key, cls: p.cls, w: p.weight, pts: p.points, style: p.style, src: p.source?.id })));
    down[plane.name] = strip(planSolidsLayerPrimitives({ graph, belowPeek, selfRiserOf, cutZ: planCutHeightMmOf(plane) }));
    up[plane.name] = planSolidsLayerPrimitivesUp({ graph, abovePeek, selfRiserOf, cutZ: ceilingCutHeightMmOf(plane) });
    finishCells[plane.name] = JSON.stringify(getAllCells(graph));
  });
  return { down, up, finishCells };
}
const before = outputs(project);
const beforeUpStr = Object.fromEntries(Object.entries(before.up).map(([k, ps]) => [k, JSON.stringify(ps.map(p => ({ key: p.key, pts: p.points, style: p.style, src: p.source?.id })))]));

// ---- 2. 編集 ----
const plane2 = planes.find(p => p.name === '2階');
const g2 = project.graphMap.get(plane2.id);
const room = g2.rooms.find(r => r.name === '主寝室');
if (!room) { console.error('NG: 2階に主寝室が見つかりません（moku4.stq の構成が変わった？）'); process.exit(1); }
const gridAt = (list, v) => {
  const cl = list.find(c => Math.abs(c.effectiveValue - v) < 0.5);
  if (!cl) throw new Error(`通り芯 ${v} が見つかりません（moku4.stq の構成が変わった？）`);
  return cl;
};
const CEILING_X = 5460; // 主寝室（3640..7280）の中央。moku4 の X5460 は補助線で、主寝室の仕上げのセルは割れていない
let ceilingCL;
runInAction(() => {
  const lo = gridAt(g2.gridYs, -7280), hi = gridAt(g2.gridYs, -3640);
  ceilingCL = g2.addCenterLine(CenterLineType.VERTICAL, CEILING_X, {
    labeled: false, discipline: Discipline.CEILING,
    extentLoRef: { clId: lo.id, offset: 0 }, extentHiRef: { clId: hi.id, offset: 0 },
  });
});
const cellAtX = x => worldToCell(x, -5460, g2, CEILING_CELL_GRID);
const leftCell = cellAtX(4500), rightCell = cellAtX(6400);
console.log(`天井セル: 左 [${leftCell.x1},${leftCell.x2}]・右 [${rightCell.x1},${rightCell.x2}]（y ${leftCell.y1}..${leftCell.y2}）`);
if (leftCell.x1 !== 3640 || leftCell.x2 !== CEILING_X || rightCell.x1 !== CEILING_X || rightCell.x2 !== 7280) {
  console.error('NG: 天井セルが期待どおりに割れていない（天井芯が天井セルの格子に効いていない）');
  process.exit(1);
}
runInAction(() => {
  const flat = mm => ({ heightMm: mm, shape: 'flat', dims: [] });
  room.setCeilingZones(assignZoneShape(g2, room, [leftCell.key], flat(2400)));
  room.setCeilingZones(assignZoneShape(g2, room, [rightCell.key], flat(3000)));
});

// 天井面: 主寝室は「左 2400」「右 3000」の2面（天井芯の両側で別の高さ。残りの面は無い）
const faces = ceilingSurfacesOf(g2).filter(s => s.roomId === room.id);
console.log('主寝室の天井面:', faces.map(s => `${s.zoneId ? '区画' : '残り'} zMm=${s.zMm} 矩形${s.rects.length}`).join(' / '));
if (faces.length !== 2 || !faces.some(s => s.zMm === 2400) || !faces.some(s => s.zMm === 3000)) {
  console.error('NG: 主寝室の天井面が「2400・3000」の2面になっていない');
  process.exit(1);
}

// ---- 2'. 他モードに漏れない: 見下げ・仕上げの格子は全階で編集前後で一致 ----
const after = outputs(project);
let leak = false;
for (const name of Object.keys(before.down)) {
  if (before.down[name] !== after.down[name]) { leak = true; console.error(`NG: 見下げ（平面）の出力が変わった: ${name}`); }
  if (before.finishCells[name] !== after.finishCells[name]) { leak = true; console.error(`NG: 仕上げの格子が変わった: ${name}`); }
}
if (leak) process.exit(1);
console.log('OK: 見下げ（平面）・仕上げの格子は全階で編集前後とも同一（天井芯・区画が他モードに漏れない）');

// ---- 3. 見上げは 2階だけ変わる ----
const afterUpStr = Object.fromEntries(Object.entries(after.up).map(([k, ps]) => [k, JSON.stringify(ps.map(p => ({ key: p.key, pts: p.points, style: p.style, src: p.source?.id })))]));
for (const name of Object.keys(beforeUpStr)) {
  const changed = beforeUpStr[name] !== afterUpStr[name];
  const nb = before.up[name].filter(p => p.kind === 'line').length, na = after.up[name].filter(p => p.kind === 'line').length;
  console.log(`  見上げ ${name}: ${nb} → ${na} 本 ${changed ? '【差分あり】' : '（同一）'}`);
  if (changed !== (name === '2階')) { console.error(`NG: 見上げの差分が 2階だけになっていない（${name}）`); process.exit(1); }
}

// ---- 4. 編集後の往復テスト ----
const { json, project2 } = roundTrip(project);
if (digestProject(project) !== digestProject(project2)) {
  console.error('NG: 往復テスト不一致（編集後。天井芯・区画が書いて読み直して一致しない）');
  process.exit(1);
}
const back = project2.graphMap.get(plane2.id).centerLines.find(c => c.id === ceilingCL.id);
if (back?.discipline !== 'ceiling' || project2.graphMap.get(plane2.id).rooms.find(r => r.id === room.id).ceilingZones.length !== 2) {
  console.error('NG: 往復後に天井芯の種別または区画が失われた');
  process.exit(1);
}
console.log('OK: 往復テスト一致（編集後。天井芯 discipline=ceiling と区画2つが書き戻し後も同一）');

fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');
