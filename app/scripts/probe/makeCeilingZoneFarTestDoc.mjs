// 「区画のある子・部屋を親が覗く」構成のテスト用 .stq を作るスクリプト（展開図の遠側の天井が区画に追従する C2 の検出力用）。
// 元文書 ceiling-zone-test.stq（makeCeilingZoneTestDoc.mjs の出力）へ、部分指定の子の天井に平面の区画（部屋 CH と違う値）を付ける:
//   (A) 1階 売場（4セル・区画なし）の x3640..7280 × y−3640..0 のセルを親の部分指定の子「売場の一部」にして区画 2700（床段差なし）
//   (B) 2階 収納（既存の部分指定の子。親は予備室）に区画 2900
// 親の帯が子の天井を壁・開放スパン越しに見る側（cellsAlong の遠側・開放スパンの farCeilAbsMm・家族の天井の破線）が区画の高さになるかを見る。
// 選び方: 階ごとに「部屋全体に区画」「各セルを子にして区画」を付けて全部屋の帯を C1（dbe239d）と C2 で比べ、親の帯が C1≠C2 になる組を選んだ
//   （階段室・ホール/玄関のような C1 で済んでいる組は C2 の検出力が無い）。
// 区画の書込みは本番と同じ ceiling/ceilingZones.js createZone。子の追加は本番と同じ graph.addRoom（referenceRoomIds＝親）。
// 手順: 往復テスト先行 → 編集 → 見下げ・仕上げの格子が全階で不変 → 見上げの差分は1階・2階だけ → buildCeilingHeightField の実測
//   → 編集後の往復テスト → 展開図の帯（dumpElevFigure.mjs と同じ振り分け・--regen と同じ壁再生成）で親の帯に子の区画の高さの水平線が現れることを確認 → 書き出し。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeCeilingZoneFarTestDoc.mjs [出力先.stq]
//   既定の出力先 D:/tatsuya/Download/ceiling-zone-far-test.stq。既存ファイルは上書きしない。
// 展開図 golden の基準採取（C2 の姿）:
//   node --import ./scripts/testSetup.mjs scripts/probe/dumpElevFigure.mjs scripts/probe/golden-elev-ceiling/ceiling-zone-far-test D:/tatsuya/Download/ceiling-zone-far-test.stq --regen
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, RoomFeature, planCutHeightMmOf, ceilingCutHeightMmOf } from '../../src/core.js';
import { getAllCells, roomBounds } from '../../src/finish/gridCells.js';
import { createZone } from '../../src/ceiling/ceilingZones.js';
import { roomCeilingHeight } from '../../src/finish/roomMetrics.js';
import { roomCeilingShapeOf } from '../../src/ceiling/roomCeilingShape.js';
import { buildCeilingHeightField } from '../../src/ceiling/ceilingHeightField.js';
import { planSolidsLayerPrimitives, planSolidsLayerPrimitivesUp } from '../../src/plan/planSolidsLayerFilter.js';
import { stairRiserOf, floorHeightAbove, floorHeightBelow } from '../../src/finish/stair/stairDimensions.js';
import { buildRoomBand } from '../../src/elevation/elevationBand.js';
import { buildStairBand } from '../../src/elevation/elevationStair.js';
import { buildVoidBand, buildRoomBandWithVoidAbove, findOverlappingRoom } from '../../src/elevation/elevationVoid.js';
import { selectElevationRooms } from '../../src/elevation/elevationFaces.js';
import { collectGridCLs } from '../../src/elevation/elevationPrimitives.js';
import { withGraphReadScope } from '../../src/graphReadScope.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { regenerateWalls, loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { conformWoodBacking } from '../../src/structural/woodAutoFill.js';
import { alignPortStairsOnGraph } from '../../src/finish/stair/stairSectionEdit.js';

const outPath = process.argv[2] ?? 'D:/tatsuya/Download/ceiling-zone-far-test.stq';
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
      shapes: g.rooms.map(r => `${r.id}:${JSON.stringify(roomCeilingShapeOf(r))}`).sort(),
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
const fail = msg => { console.error(`NG: ${msg}`); process.exit(1); };

const srcPath = 'D:/tatsuya/Download/ceiling-zone-test.stq';
const { project } = loadDocument(srcPath);
console.log(`=== ${srcPath} を読み込み、1階の売場・2階の収納へ平面の区画を付ける ===`);

// ---- 1. 往復テスト先行（編集前）----
{
  const { project2 } = roundTrip(project);
  if (digestProject(project) !== digestProject(project2)) fail('往復テスト不一致（編集前。書いて読み直したダイジェストが元と異なる）');
  console.log('OK: 往復テスト一致（編集前）');
}

// ---- 編集前の出力（見下げ・見上げ。階ごと）と仕上げの格子 ----
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
const upStr = ps => JSON.stringify(ps.map(p => ({ key: p.key, pts: p.points, style: p.style, src: p.source?.id })));
const before = outputs(project);
const beforeUpStr = Object.fromEntries(Object.entries(before.up).map(([k, ps]) => [k, upStr(ps)]));

// ---- 2. 編集 ----
const planeOf = name => project.planes.find(p => p.name === name);
const plane1 = planeOf('1階'), plane2 = planeOf('2階');
const g1 = project.graphMap.get(plane1.id), g2 = project.graphMap.get(plane2.id);
const roomOf = (g, floorName, name) => {
  const hits = g.rooms.filter(r => r.name === name);
  if (hits.length !== 1) fail(`${floorName}の「${name}」が ${hits.length} 件（ceiling-zone-test.stq の構成が変わった？）`);
  return hits[0];
};
const flat = mm => ({ heightMm: mm, shape: 'flat', dims: [] });
const chOf = (g, r) => roomCeilingHeight(g, r).mm;
const A_ZONE = 2700, B_ZONE = 2900;

// (A) 1階 売場（4セル・区画なし）の x 3640..7280 × y −3640..0 のセルを部分指定の子にして区画 2700（床段差なし。本番の addRoom と同じ API）
const uriba = roomOf(g1, '1階', '売場');
const aCellKey = [...uriba.cells].find(k => {
  const b = roomBounds(new Set([k]), g1);
  return b.x1 === 3640 && b.y1 === -3640 && b.x2 === 7280 && b.y2 === 0;
});
if (!aCellKey) fail('1階 売場に x3640..7280 × y−3640..0 のセルが無い');
const ufCh = chOf(g1, uriba);
if (ufCh === A_ZONE) fail('売場の CH が区画の値と同じ（検出力が無い）');
let uribaChild = null;
runInAction(() => {
  uribaChild = g1.addRoom(new Set([aCellKey]), '売場の一部', undefined, new Set([uriba.id]));
  uribaChild.setFloorLevel(g1.effectiveFloorLevel(uriba)); // 親と同じ床（段差なし）
  const z = createZone(g1, uribaChild, uribaChild.cells, flat(A_ZONE));
  if (!z.zoneId) fail('売場の子の区画が作れない');
  uribaChild.setCeilingZones(z.zones);
});
console.log(`(A) 1階 売場(${uriba.id}) CH ${ufCh} のセル x3640..7280 × y−3640..0 を部分指定の子「売場の一部」にして平面の区画 ${A_ZONE}`);

// (B) 2階 収納（既存の部分指定の子。親は予備室）に平面の区画 2900
const shuno = roomOf(g2, '2階', '収納');
const yobi = g2.rooms.find(r => shuno.referenceRoomIds.has(r.id));
if (!yobi) fail('2階 収納の親（予備室）が無い');
const shunoCh = chOf(g2, shuno);
if (shunoCh === B_ZONE) fail('収納の CH が区画の値と同じ（検出力が無い）');
runInAction(() => {
  const z = createZone(g2, shuno, shuno.cells, flat(B_ZONE));
  if (!z.zoneId) fail('収納の区画が作れない');
  shuno.setCeilingZones(z.zones);
});
console.log(`(B) 2階 収納(${shuno.id}) CH ${shunoCh}・床 ${g2.effectiveFloorLevel(shuno)}・親=${yobi.name}(${yobi.id}) に平面の区画 ${B_ZONE}`);

// ---- 2'. 他モードに漏れない: 見下げ・仕上げの格子は全階で編集前後で一致（部分指定の子の追加は見下げ・仕上げの格子を変えない）----
const after = outputs(project);
let leak = false;
for (const name of Object.keys(before.down)) {
  if (before.down[name] !== after.down[name]) { leak = true; console.error(`NG: 見下げ（平面）の出力が変わった: ${name}`); }
  if (before.finishCells[name] !== after.finishCells[name]) { leak = true; console.error(`NG: 仕上げの格子が変わった: ${name}`); }
}
if (leak) process.exit(1);
console.log('OK: 見下げ（平面）・仕上げの格子は全階で編集前後とも同一');

// ---- 3. 見上げは 1階・2階だけ変わる ----
for (const name of Object.keys(beforeUpStr)) {
  const changed = beforeUpStr[name] !== upStr(after.up[name]);
  console.log(`  見上げ ${name}: ${changed ? '【差分あり】' : '（同一）'}`);
  if (changed !== (name === '1階' || name === '2階')) fail(`見上げの差分が 1階・2階だけになっていない（${name}）`);
}

// ---- 3'. 天井高の点問い合わせ（zMm は層 FL 基準・床段差込み。期待値は定義から独立に計算）----
console.log('--- 代表点の天井高（ceilingHeightField.zAt）---');
for (const [label, g, room, expected] of [
  ['売場の一部', g1, uribaChild, A_ZONE + g1.effectiveFloorLevel(uribaChild)],
  ['収納', g2, shuno, B_ZONE + g2.effectiveFloorLevel(shuno)],
]) {
  const field = buildCeilingHeightField(g);
  for (const k of room.cells) {
    const b = roomBounds(new Set([k]), g);
    const x = (b.x1 + b.x2) / 2, y = (b.y1 + b.y2) / 2;
    const hit = field.zAt(x, y), z = hit?.zMm;
    const ok = z !== undefined && Math.abs(z - expected) <= 0.01 && hit.roomId === room.id;
    console.log(`  ${ok ? 'OK' : 'NG'} ${label} (${x}, ${y}) zMm=${z} 期待 ${expected}`);
    if (!ok) process.exitCode = 1;
  }
}
if (process.exitCode) fail('代表点の天井高が期待値と一致しない');

// ---- 4. 編集後の往復テスト ----
const { json, project2 } = roundTrip(project);
if (digestProject(project) !== digestProject(project2)) fail('往復テスト不一致（編集後。区画・子が書いて読み直して一致しない）');
const g1b = project2.graphMap.get(plane1.id), g2b = project2.graphMap.get(plane2.id);
for (const [g, name] of [[g1b, '売場の一部'], [g2b, '収納']]) {
  const r = g.rooms.find(x => x.name === name);
  if (!r || r.ceilingZones.map(z => z.shape).join(',') !== 'flat') fail(`往復後に${name}の区画が失われた`);
}
console.log('OK: 往復テスト一致（編集後）');

// ---- 5. C2 の経路が発火する: 展開図の帯（dumpElevFigure.mjs と同じ振り分け・--regen と同じ壁再生成）----
const materialMap = await loadMaterialMap();
async function regen(proj) {
  const origErr = console.error; console.error = () => {};
  try {
    for (const p of proj.planes) {
      const graph = proj.graphMap.get(p.id);
      runInAction(() => conformWoodBacking(graph, proj));
      runInAction(() => alignPortStairsOnGraph(graph));
      const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(graph, proj, async pl => proj.graphMap.get(pl.id) ?? null);
      await regenerateWalls(graph, { materialMap, project: proj, stairUnderEntries, extraStairOpenings });
    }
  } finally { console.error = origErr; }
}
function bandsOf(proj, planeName) {
  const tabs = proj.orderedTabs, i = tabs.findIndex(t => t.name === planeName);
  const graph = proj.graphMap.get(tabs[i].id);
  const upperGraph = proj.graphMap.get(tabs[i + 1]?.id) ?? null, lowerGraph = proj.graphMap.get(tabs[i - 1]?.id) ?? null;
  const out = new Map();
  const run = () => {
    let fh; try { fh = floorHeightAbove(proj, graph.plane); } catch { fh = null; }
    const base = { project: proj, materialMap: new Map(), gridCLs: collectGridCLs(graph) };
    const voidAbove = upperGraph ? selectElevationRooms(upperGraph).filter(x => x.feature === RoomFeature.VOID) : [];
    const own = selectElevationRooms(graph).filter(x => x.feature !== RoomFeature.VOID || !lowerGraph);
    const ids = new Set(own.map(x => x.id)), vm = new Map();
    for (const v of voidAbove) {
      const h = findOverlappingRoom(roomBounds(v.cells, upperGraph), graph, x => x.feature == null);
      if (h && ids.has(h.id)) vm.set(h.id, v);
    }
    const stairBy = new Map(graph.stairs.map(s => [s.roomId, s]));
    for (const room of own) {
      let band;
      if (room.feature === RoomFeature.STAIR) band = buildStairBand(room, graph, upperGraph, { ...base, stair: stairBy.get(room.id) ?? null, lowerGraph });
      else if (room.feature === RoomFeature.VOID) band = buildVoidBand(room, graph, lowerGraph, { ...base, floorHeightBelowMm: floorHeightBelow(proj, graph.plane) });
      else if (vm.get(room.id)) band = buildRoomBandWithVoidAbove(room, graph, vm.get(room.id), upperGraph, { ...base, floorHeightAboveMm: fh, solids: { upperGraph, floorHeightMm: fh } });
      else band = buildRoomBand(room, graph, { ...base, solids: { upperGraph, floorHeightMm: fh } });
      out.set(room.id, band?.primitives ?? band ?? []);
    }
  };
  withGraphReadScope(graph, () => withGraphReadScope(upperGraph, () => withGraphReadScope(lowerGraph, run)));
  return out;
}
const baseProject = loadDocument(srcPath).project;
await regen(baseProject);
await regen(project2);

// 編集前に無かった（同じ座標の線が編集前の帯に無い）高さ y の水平線が編集後にあるか。同じ高さの別の線は編集前にもありうるため、線そのものの集合差で見る。
const addedHLine = (basePrims, afterPrims, y) => {
  const key = p => `${p.x1},${p.y1},${p.x2},${p.y2}`;
  const had = new Set(basePrims.filter(p => p.type === 'line').map(key));
  return afterPrims.some(p => p.type === 'line' && p.y1 === y && p.y2 === y && !had.has(key(p)));
};
for (const [floorName, gAfter, parentName, childName, zone] of [
  ['1階', g1b, '売場', '売場の一部', A_ZONE],
  ['2階', g2b, '予備室', '収納', B_ZONE],
]) {
  const baseBands = bandsOf(baseProject, floorName), afterBands = bandsOf(project2, floorName);
  const parent = gAfter.rooms.find(r => r.name === parentName), child = gAfter.rooms.find(r => r.name === childName);
  const changed = [...afterBands].filter(([id, p]) => JSON.stringify(p) !== JSON.stringify(baseBands.get(id)))
    .map(([id]) => gAfter.rooms.find(r => r.id === id)?.name || id);
  console.log(`  ${floorName} で帯が変わった部屋: ${changed.join('・') || '（なし）'}`);
  // 親の帯: 子の区画（帯の座標は y = −(層 FL 基準の天井 z)。z = zone + 子の床レベル）の水平線が、編集前に無い線として現れる（遠側の天井・家族の天井の破線・開放スパン）
  const y = -(zone + gAfter.effectiveFloorLevel(child));
  if (!baseBands.has(parent.id)) fail(`${floorName} の編集前の帯に ${parentName} が無い`);
  if (!addedHLine(baseBands.get(parent.id), afterBands.get(parent.id), y)) fail(`${floorName} ${parentName} の帯に y=${y} の水平線（${childName}の区画 ${zone}）が現れない`);
  console.log(`OK: ${floorName} ${parentName} の帯に y=${y}（${childName}の区画 ${zone}）の水平線が現れた（編集前には無い線）`);
}

fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');
