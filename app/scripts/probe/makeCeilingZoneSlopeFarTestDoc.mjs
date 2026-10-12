// 「傾斜の区画のある子・部屋を親が覗く」構成のテスト用 .stq を作るスクリプト（展開図の遠側の天井が傾斜に追従する E3b-1 の検出力用）。
// 元文書 ceiling-zone-far-test.stq（makeCeilingZoneFarTestDoc.mjs の出力）の2つの子の区画を、平面から傾斜（rise 300）へ差し替える:
//   (A) 1階 売場の子「売場の一部」（区画 2700 の平面）→ 傾斜 [300, dirA]
//       親の面 C2（y=−3640・inward −1）の開放スパンの先に子がある。**奥行き方向（y）の傾斜**で、奥（y=0 の壁）へ向かって下がる向きを選ぶ。
//   (B) 2階 収納（予備室の子。区画 2900 の平面）→ 傾斜 [300, dirB]
//       親（予備室）の面 C（y=−9884・inward −1）の開放スパンの先に子がある。**走り方向（x）の傾斜**（遠側の天井線が斜線 1 本になる経路）。
// dirA/dirB の選び方: 4 方向を総当たりし、親の面から見て「奥行き方向か走り方向か」と「奥の端が手前の端より低いか」を面の幾何から求めて表で出す。
//   dirA＝奥行き方向（勾配の軸が面の奥行きの軸）かつ奥の端が低い向き、dirB＝走り方向（勾配の軸が面の走りの軸）の最初の向き。
// 区画の書換えは本番と同じ ceiling/ceilingZones.js updateZoneSpec。
// 手順: 往復テスト先行 → 編集 → 見下げ・仕上げの格子が全階で不変 → 見上げの差分は1階・2階だけ → buildCeilingHeightField の実測
//   → 編集後の往復テスト → 親の帯の遠側の天井線の実測（情報表示のみ。E3b-1 の実装前は区画の高さにならない）→ 書き出し。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeCeilingZoneSlopeFarTestDoc.mjs [出力先.stq]
//   既定の出力先 D:/tatsuya/Download/ceiling-zone-slope-far-test.stq。既存ファイルは上書きしない。
// 展開図 golden の基準採取（E3b-1 の前の姿）:
//   node --import ./scripts/testSetup.mjs scripts/probe/dumpElevFigure.mjs scripts/probe/golden-elev-ceiling/ceiling-zone-slope-far-test D:/tatsuya/Download/ceiling-zone-slope-far-test.stq --regen
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, RoomFeature, planCutHeightMmOf, ceilingCutHeightMmOf } from '../../src/core.js';
import { getAllCells, roomBounds } from '../../src/finish/gridCells.js';
import { updateZoneSpec } from '../../src/ceiling/ceilingZones.js';
import { roomCeilingShapeOf } from '../../src/ceiling/roomCeilingShape.js';
import { buildCeilingHeightField } from '../../src/ceiling/ceilingHeightField.js';
import { ceilingShapeSolidZ } from '../../src/ceiling/ceilingShape.js';
import { planSolidsLayerPrimitives, planSolidsLayerPrimitivesUp } from '../../src/plan/planSolidsLayerFilter.js';
import { stairRiserOf, floorHeightAbove, floorHeightBelow } from '../../src/finish/stair/stairDimensions.js';
import { buildRoomBand } from '../../src/elevation/elevationBand.js';
import { buildStairBand } from '../../src/elevation/elevationStair.js';
import { buildVoidBand, buildRoomBandWithVoidAbove, findOverlappingRoom } from '../../src/elevation/elevationVoid.js';
import { selectElevationRooms } from '../../src/elevation/elevationFaces.js';
import { composeRoomFaces } from '../../src/elevation/elevationFaceList.js';
import { collectGridCLs } from '../../src/elevation/elevationPrimitives.js';
import { PROBE_EPS_MM } from '../../src/elevation/elevationStyle.js';
import { withGraphReadScope } from '../../src/graphReadScope.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { regenerateWalls, loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { conformWoodBacking } from '../../src/structural/woodAutoFill.js';
import { alignPortStairsOnGraph } from '../../src/finish/stair/stairSectionEdit.js';

const outPath = process.argv[2] ?? 'D:/tatsuya/Download/ceiling-zone-slope-far-test.stq';
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

const srcPath = 'D:/tatsuya/Download/ceiling-zone-far-test.stq';
const { project } = loadDocument(srcPath);
console.log(`=== ${srcPath} を読み込み、1階の売場の一部・2階の収納の区画を傾斜へ差し替える ===`);

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

// ---- 展開図の面（壁の再生成後）----
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
// 面の選択は壁の再生成後の姿（実機と同じ）で行うので、別に読み直した文書を再生成して使う（編集対象の project とは別物）
const faceProjectRegen = loadDocument(srcPath).project;
await regen(faceProjectRegen);

const planeOf = name => project.planes.find(p => p.name === name);
const plane1 = planeOf('1階'), plane2 = planeOf('2階');
const g1 = project.graphMap.get(plane1.id), g2 = project.graphMap.get(plane2.id);
const roomOf = (g, floorName, name) => {
  const hits = g.rooms.filter(r => r.name === name);
  if (hits.length !== 1) fail(`${floorName}の「${name}」が ${hits.length} 件（ceiling-zone-far-test.stq の構成が変わった？）`);
  return hits[0];
};

// 親の面のうち、開放スパンの先（farの探査点）が子の矩形に入るものを返す
function facesSeeingChild(proj, floorName, parentName, childName) {
  const g = proj.graphMap.get(proj.planes.find(p => p.name === floorName).id);
  const parent = g.rooms.find(r => r.name === parentName), child = g.rooms.find(r => r.name === childName);
  const cb = roomBounds(child.cells, g);
  const found = [];
  withGraphReadScope(g, () => {
    for (const f of composeRoomFaces(parent, g)) {
      for (const s of f.spans ?? []) {
        if (s.kind !== 'open') continue;
        const mid = f.originWorld + f.dirSign * (s.loX + s.hiX) / 2;
        const axis = f.axisCL.value, far = axis - f.inward * PROBE_EPS_MM;
        const [x, y] = f.isVertical ? [far, mid] : [mid, far];
        if (x > cb.x1 && x < cb.x2 && y > cb.y1 && y < cb.y2) found.push({ face: f, span: s });
      }
    }
  });
  return { found, childBounds: cb };
}
const DIR_VEC = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };
const RISE = 300, A_BASE = 2700, B_BASE = 2900;
// 面から見た 4 方向の表（勾配の軸が奥行きか走りか・奥の端と手前の端の高さ。baseZ は区画の高さ）
function dirTable(face, rect, base) {
  const dd = face.isVertical ? [-face.inward, 0] : [0, -face.inward]; // 奥行き（視線）の向き
  return [0, 90, 180, 270].map(dir => {
    const { zAt } = ceilingShapeSolidZ({ shape: 'slope', dims: [RISE, dir], baseZ: base, rects: [rect] });
    const [vx, vy] = DIR_VEC[dir];
    const alongDepth = vx * dd[0] + vy * dd[1] !== 0;
    const cx = (rect.x1 + rect.x2) / 2, cy = (rect.y1 + rect.y2) / 2;
    // 手前の端・奥の端（視線の向き dd に沿った矩形の辺の中点）
    const nearPt = [cx - dd[0] * (rect.x2 - rect.x1) / 2, cy - dd[1] * (rect.y2 - rect.y1) / 2];
    const farPt = [cx + dd[0] * (rect.x2 - rect.x1) / 2, cy + dd[1] * (rect.y2 - rect.y1) / 2];
    return { dir, alongDepth, zNear: zAt(...nearPt), zFar: zAt(...farPt) };
  });
}
function pickDir(label, face, rect, base, wantAlongDepth) {
  const table = dirTable(face, rect, base);
  console.log(`  ${label} 面 ${face.label}（axis ${face.axisCL.value}・${face.isVertical ? '縦' : '横'}・inward ${face.inward}）`);
  for (const t of table) {
    console.log(`    dir ${String(t.dir).padStart(3)}: 勾配の軸=${t.alongDepth ? '奥行き' : '走り'}  手前の端 ${t.zNear}  奥の端 ${t.zFar}`);
  }
  const hit = wantAlongDepth
    ? table.find(t => t.alongDepth && t.zFar < t.zNear)
    : table.find(t => !t.alongDepth);
  if (!hit) fail(`${label}: 条件に合う向きが無い`);
  return hit.dir;
}

// ---- 2. 編集 ----
const uriba = roomOf(g1, '1階', '売場'), uribaChild = roomOf(g1, '1階', '売場の一部');
const shuno = roomOf(g2, '2階', '収納'), yobi = roomOf(g2, '2階', '予備室');
console.log('--- 向きの選択（親の面の幾何）---');
const seenA = facesSeeingChild(faceProjectRegen, '1階', '売場', '売場の一部');
const seenB = facesSeeingChild(faceProjectRegen, '2階', '予備室', '収納');
if (seenA.found.length !== 1) fail(`1階 売場の面で子「売場の一部」を覗くスパンが ${seenA.found.length} 件（1 件のはず）`);
if (seenB.found.length !== 1) fail(`2階 予備室の面で子「収納」を覗くスパンが ${seenB.found.length} 件（1 件のはず）`);
const dirA = pickDir('(A) 奥行き方向・奥が低い', seenA.found[0].face, seenA.childBounds, A_BASE, true);
const dirB = pickDir('(B) 走り方向', seenB.found[0].face, seenB.childBounds, B_BASE, false);
console.log(`  → dirA=${dirA}（奥行きの軸で奥の端が低い最初の向き）・dirB=${dirB}（走りの軸の最初の向き。鏡像の向きと等価）`);

const zoneOf = r => {
  if (r.ceilingZones.length !== 1) fail(`${r.name} の区画が ${r.ceilingZones.length} 件（1 件のはず）`);
  const z = r.ceilingZones[0];
  if (z.shape !== 'flat') fail(`${r.name} の区画が平面でない`);
  return z;
};
const setSlope = (g, room, base, dir) => {
  const z = zoneOf(room);
  if (z.heightMm !== base) fail(`${room.name} の区画の高さが ${z.heightMm}（${base} のはず）`);
  runInAction(() => room.setCeilingZones(updateZoneSpec(g, room, z.id, { heightMm: base, shape: 'slope', dims: [RISE, dir] })));
};
setSlope(g1, uribaChild, A_BASE, dirA);
setSlope(g2, shuno, B_BASE, dirB);
console.log(`(A) 1階 売場の一部 の区画 ${A_BASE} → 傾斜 [${RISE}, ${dirA}]`);
console.log(`(B) 2階 収納 の区画 ${B_BASE} → 傾斜 [${RISE}, ${dirB}]（親=${yobi.name}、売場=${uriba.name}）`);

// ---- 2'. 他モードに漏れない ----
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

// ---- 3'. 天井高の点問い合わせ（zMm は層 FL 基準。期待値は定義から独立に計算）----
console.log('--- 代表点の天井高（ceilingHeightField.zAt。期待値は baseZ＋ライズ×u の手計算）---');
function expectedZ(base, dir, rect, x, y) {
  const along = dir === 0 || dir === 180 ? [x, rect.x1, rect.x2] : [y, rect.y1, rect.y2];
  let t = (along[0] - along[1]) / (along[2] - along[1]);
  if (dir === 180 || dir === 270) t = 1 - t;
  return base + RISE * Math.min(Math.max(t, 0), 1);
}
for (const [label, g, room, base, dir] of [
  ['売場の一部', g1, uribaChild, A_BASE, dirA],
  ['収納', g2, shuno, B_BASE, dirB],
]) {
  const field = buildCeilingHeightField(g);
  const rect = roomBounds(room.cells, g);
  const fl = g.effectiveFloorLevel(room);
  const cx = (rect.x1 + rect.x2) / 2, cy = (rect.y1 + rect.y2) / 2;
  for (const [x, y] of [[cx, cy], [rect.x1 + 1, rect.y1 + 1], [rect.x2 - 1, rect.y2 - 1]]) {
    const hit = field.zAt(x, y);
    const expected = expectedZ(base, dir, rect, x, y) + fl;
    const ok = hit && Math.abs(hit.zMm - expected) <= 0.01 && hit.roomId === room.id && hit.shape === 'slope';
    console.log(`  ${ok ? 'OK' : 'NG'} ${label} (${x}, ${y}) zMm=${hit?.zMm} 期待 ${expected}`);
    if (!ok) process.exitCode = 1;
  }
}
if (process.exitCode) fail('代表点の天井高が期待値と一致しない');

// ---- 4. 編集後の往復テスト ----
const { json, project2 } = roundTrip(project);
if (digestProject(project) !== digestProject(project2)) fail('往復テスト不一致（編集後。区画が書いて読み直して一致しない）');
for (const [pl, name, dir] of [[plane1, '売場の一部', dirA], [plane2, '収納', dirB]]) {
  const r = project2.graphMap.get(pl.id).rooms.find(x => x.name === name);
  const z = r?.ceilingZones[0];
  if (!z || z.shape !== 'slope' || z.dims.join(',') !== `${RISE},${dir}`) fail(`往復後に${name}の傾斜の区画が失われた`);
}
console.log('OK: 往復テスト一致（編集後）');

// ---- 5. 展開図の帯（情報表示。dumpElevFigure.mjs と同じ振り分け・--regen と同じ壁再生成）----
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
      if (room.feature === RoomFeature.STAIR) band = buildStairBand(room, graph, upperGraph, { ...base, stair: stairBy.get(room.id) ?? null });
      else if (room.feature === RoomFeature.VOID) band = buildVoidBand(room, graph, lowerGraph, { ...base, floorHeightBelowMm: floorHeightBelow(proj, graph.plane) });
      else if (vm.get(room.id)) band = buildRoomBandWithVoidAbove(room, graph, vm.get(room.id), upperGraph, { ...base, floorHeightAboveMm: fh, solids: { upperGraph, floorHeightMm: fh } });
      else band = buildRoomBand(room, graph, { ...base, solids: { upperGraph, floorHeightMm: fh } });
      out.set(room.id, band?.primitives ?? band ?? []);
    }
  };
  withGraphReadScope(graph, () => withGraphReadScope(upperGraph, () => withGraphReadScope(lowerGraph, run)));
  return out;
}
await regen(project2);
for (const [floorName, parentName] of [['1階', '売場'], ['2階', '予備室']]) {
  const bands = bandsOf(project2, floorName);
  const g = project2.graphMap.get(project2.planes.find(p => p.name === floorName).id);
  const parent = g.rooms.find(r => r.name === parentName);
  const lines = (bands.get(parent.id) ?? []).filter(p => p.type === 'line' && p.y1 !== p.y2 && Math.abs(p.y1) > 1500 && Math.abs(p.y2) > 1500 && p.x1 !== p.x2);
  const hl = (bands.get(parent.id) ?? []).filter(p => p.type === 'line' && p.y1 === p.y2 && Math.abs(p.y1) >= 2400 && Math.abs(p.y1) <= 3100);
  console.log(`  ${floorName} ${parentName} の帯: 斜めの線 ${lines.length} 本・高さ 2400..3100 の水平線 ${hl.length} 本（y=${[...new Set(hl.map(p => p.y1))].join(',')}）`);
}

fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');
