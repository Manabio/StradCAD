// 下屋の外周の梁（軒桁）と下屋の範囲の床梁ガード（ステップ C2d-1。structural-model.md「下屋の外周」）を実データで
// 目視確認するためのテスト用 .stq を作るスクリプト。makeRoofTestDoc.mjs（L字・対象外の下屋）と同型で、こちらは
// **矩形の下屋（小屋組の対象。roofFramingRegions.js leanToFramingRegions が region を返す）**を置く。
//
// 流れ（makeRoofTestDoc.mjs と同じ）:
//   1. loadDoc.mjs で moku4.stq（在来木造3階）を読み、往復テスト（読み→書き→読み）を先に通す。
//   2. 屋根セルは**明示指定**（TARGET）。2階の未定義の部屋のセル（直下の1階に屋内部屋がある・直上の3階に部屋が無い）
//      のうち、通り芯 X3〜X5 × Y2〜Y1 の2セル（x 3640..9100, y -3640..0）。矩形・短手3640＝片流れ・上辺（Y2＝屋内の主寝室に
//      接する辺）が高い側。母屋が入る大きさ。
//   3. 屋根の付与は本番と同じ経路（FinishModeState: 部屋ドラッグ→commitDrag→applyNaming）。
//   4. 壁の再生成と構造再計算は makeRoofTestDoc.mjs と同じ関数列（仕上げ脱出境界の順序＋sweepUntilConverged）。
//   5. 「屋根セルを無割当にした場合」と全階を比べる。
//      **一致を要求するもの（exit 1）**: 壁・境界エッジ・footprint・展開図（屋根セルは壁側では部屋の無いセルと同値＝不変条件 I0）。
//      **一致しなくなったもの（C2d-1 で意図して変わる）**: 柱・梁・スラブ・基礎。対象の下屋は外周に梁（軒桁）が出て、
//      範囲に床梁が出ないため、「無割当と一致」は崩れる（makeRoofTestDoc.mjs は L字＝対象外・13＝S造なので今も一致する）。
//      差は全件を表示し、次の期待を検査する: ①下屋の外周の各辺（屋内との境界を除く）に primary 梁が出る ②下屋の範囲に床梁が無い
//      ③無割当との差に、梁の削除（床梁以外）・壁の差が無い。収束スイープ数は上限5。
//   6. 目視用: 導かれる region（形状・高い側・棟）・母屋の位置・束の位置（外周の梁ができる前後）を出す。
//   7. 書いて読み直したダイジェスト一致を確認してから保存する。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeRoofFramingTestDoc.mjs [入力.stq] [出力.stq]
//   既定: moku4.stq → D:/tatsuya/Download/roof-test3.stq。既存ファイルは上書きしない。.mjs は eslint の対象外。
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, RoomKind, RoomFeature, CenterLineType, RoofSpec, ROOF_SPEC_KEYS, ROOF_SHAPE_LABELS } from '../../src/core.js';
import { CL_OVERLAP_TOL_MM } from '../../src/core/constants.js';
import { resolveRoofShape, roofRoomBounds } from '../../src/finish/roof/roofDefaults.js';
import { roofShortSpanMm } from '../../src/finish/roof/roofGeometry.js';
import { cellBoundsFromKey, refreshCells, worldToCell } from '../../src/finish/gridCells.js';
import { buildCellToRoom, syncEdgesFromTopology } from '../../src/finish/edgeClassify.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadMaterialMap, regenerateWalls } from '../../src/finish/wallRegeneration.js';
import { wallFreshnessKey } from '../../src/finish/wallFreshnessKey.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { subtractCellsFromUndefinedRooms } from '../../src/finish/roomUndefined.js';
import { conformWoodBacking } from '../../src/structural/woodAutoFill.js';
import { wallBackingCenters, mapBackingCenterMoves } from '../../src/structural/wallBeamAxes.js';
import { followWallBeamAxes } from '../../src/structural/wallBeamAxisFollow.js';
import { leanToFramingRegions } from '../../src/structural/roofFramingRegions.js';
import { roofFramingLines, roofStrutPoints } from '../../src/structural/roofFramingGeometry.js';
import { roofFramingHostMembers } from '../../src/structural/framingDrawing.js';
import { rulesFor, effectiveStructure } from '../../src/structural/structureRules.js';
import { FinishModeState } from '../../src/modes/FinishModeState.js';
import { sweepUntilConverged } from './sweepOrder.mjs';
import { decode } from '../../src/schema/graphFbs.js';
import { footprintCellKeys } from '../../src/structural/wallGate.js';
import { buildRoomBand } from '../../src/elevation/elevationBand.js';
import { buildStairBand } from '../../src/elevation/elevationStair.js';
import { buildVoidBand, buildRoomBandWithVoidAbove, findOverlappingRoom } from '../../src/elevation/elevationVoid.js';
import { selectElevationRooms } from '../../src/elevation/elevationFaces.js';
import { collectGridCLs } from '../../src/elevation/elevationPrimitives.js';
import { floorHeightAbove, floorHeightBelow } from '../../src/finish/stair/stairDimensions.js';
import { roomBounds } from '../../src/finish/gridCells.js';
import { withGraphReadScope } from '../../src/graphReadScope.js';

const srcPath = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';
const outPath = process.argv[3] ?? 'D:/tatsuya/Download/roof-test3.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

// 屋根セル（明示指定）。planeIndex は標高順の採用フロア（0=1階）。rects は世界座標のセル範囲（その範囲のセルをそのまま屋根にする）。
const TARGET = {
  planeIndex: 1,
  rects: [
    { x1: 3640, x2: 7280, y1: -3640, y2: 0 },   // X3〜X4 × Y2〜Y1
    { x1: 7280, x2: 9100, y1: -3640, y2: 0 },   // X4〜X5 × Y2〜Y1
  ],
};
const SWEEP_LIMIT = 5; // 収束スイープ数の上限（設計書 C0）

// ---- 共通ヘルパ ----
const num = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
function wallKey(w) {
  return JSON.stringify({
    isVertical: w.isVertical, isRoomWall: w.isRoomWall, isExteriorWall: w.isExteriorWall,
    axis: num(w.axisCL.effectiveValue), axisOffset: num(w.axisOffset),
    start: num(w.clStart.effectiveValue), startOffset: num(w.startOffset),
    end: num(w.clEnd.effectiveValue), endOffset: num(w.endOffset),
    c1: num(w.coord1), c2: num(w.coord2),
    wallFinish: num(w.wallFinish), backingOffset: num(w.backingOffset), backingDepth: num(w.backingDepth),
    finishSide: w.finishSide ?? null, bandOffset: num(w.bandOffset),
  });
}
const wallMultiset = (graph) => graph.walls.map(wallKey).sort();

function digestProject(proj) {
  const out = {};
  for (const plane of proj.planes) {
    const g = proj.graphMap.get(plane.id);
    out[plane.name] = {
      walls: g.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${w.axisCL.effectiveValue}`).sort(),
      rooms: g.rooms.map(r => `${r.name}:${r.kind}:${r.feature}:${[...r.referenceRoomIds].sort()}:${[...r.cells].sort().join(',')}`).sort(),
      columns: g.columns.map(c => `${Math.round(c.axisX)}:${Math.round(c.axisY)}`).sort(),
    };
  }
  return JSON.stringify(out);
}

function encodeDocument(proj) {
  const floors = [...proj.planes].map(p => ({ planeId: p.id, bytes: serializeGraph(proj.graphMap.get(p.id)) }));
  const struct = serializeStructCLs(proj.structGraph, proj.structuralInfo, proj.memberGroupLedger);
  const planesBytes = serializePlanes(proj);
  return buildDocumentJson({ floors, struct, planes: planesBytes, site: null, info: null, bootPlaneId: proj.activePlaneId });
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

// ---- 0. 往復テスト（先に通す）----
{
  const { project: p0 } = loadDocument(srcPath);
  const p0b = decodeDocument(encodeDocument(p0));
  if (digestProject(p0) !== digestProject(p0b)) {
    console.error('NG: 往復テスト不一致（入力文書を書いて読み直した部屋・壁・柱のダイジェストが元と異なる）');
    process.exit(1);
  }
  console.log('OK: 往復テスト一致（入力文書。部屋・壁・柱のダイジェスト）');
}

// ---- 屋根セルの特定（明示指定の矩形に一致するセルを、2階の未定義の部屋のセルから探す）----
const adoptedPlanes = (project) => [...project.planes]
  .filter(p => !p.isAlternative && !p.isRoofPlane)
  .sort((a, b) => a.elevation - b.elevation);
const isRealIndoor = (room) => !!room && room.kind === RoomKind.INTERIOR && room.feature == null;
const centerOf = (key, graph) => {
  const b = cellBoundsFromKey(key, graph);
  return { cx: (b.x1 + b.x2) / 2, cy: (b.y1 + b.y2) / 2, b };
};
const roomAtPoint = (graph, map, x, y) => {
  const c = worldToCell(x, y, graph);
  return c ? (map.get(c.key) ?? null) : null;
};
const near = (a, b) => Math.abs(a - b) < 1;

function findTarget(project) {
  const planes = adoptedPlanes(project);
  const plane = planes[TARGET.planeIndex];
  const g = project.graphMap.get(plane.id);
  const lower = project.graphMap.get(planes[TARGET.planeIndex - 1].id);
  const upper = planes[TARGET.planeIndex + 1] ? project.graphMap.get(planes[TARGET.planeIndex + 1].id) : null;
  const lowerMap = buildCellToRoom(lower);
  const upperMap = upper ? buildCellToRoom(upper) : null;
  const cellKeys = [];
  for (const rect of TARGET.rects) {
    let found = null;
    for (const room of g.rooms) {
      if (room.feature !== RoomFeature.UNDEFINED) continue;
      for (const key of refreshCells(room.cells, g)) {
        const b = cellBoundsFromKey(key, g);
        if (near(b.x1, rect.x1) && near(b.x2, rect.x2) && near(b.y1, rect.y1) && near(b.y2, rect.y2)) found = key;
      }
    }
    if (!found) throw new Error(`${plane.name}に未定義の部屋のセルが見つからない: ${JSON.stringify(rect)}`);
    const { cx, cy } = centerOf(found, g);
    if (!isRealIndoor(roomAtPoint(lower, lowerMap, cx, cy))) throw new Error(`直下階に屋内部屋が無い: ${JSON.stringify(rect)}`);
    if (upper && roomAtPoint(upper, upperMap, cx, cy)) throw new Error(`直上階に部屋がある: ${JSON.stringify(rect)}`);
    cellKeys.push(found);
  }
  return { plane, cellKeys, how: `${plane.name}の未定義セル${cellKeys.length}件（明示指定。直下に屋内部屋・直上に部屋なし）` };
}

// ---- 全階ダイジェスト（屋根と無割当の同値の確認用）----
function labelerOf(project, g) {
  return (id) => {
    if (typeof id !== 'string') return id;
    const s = g.shapeMap.get(id) ?? project.structGraph.shapeMap.get(id);
    if (!s || s.effectiveValue == null) return id;
    return `${s.centerLineType ?? s.type}@${num(s.effectiveValue)}`;
  };
}
function projectObj(obj, L) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'id' || k === 'generatedWallIds' || k === 'memberNo') continue;
    if (Array.isArray(v)) out[k] = v.map(x => (typeof x === 'string' ? L(x) : num(x)));
    else if (typeof v === 'string') out[k] = L(v);
    else if (v && typeof v === 'object') out[k] = projectObj(v, L);
    else out[k] = num(v);
  }
  return JSON.stringify(out);
}
function elevationDigest(project, plane) {
  const tabs = project.orderedTabs;
  const i = tabs.findIndex(t => t.id === plane.id);
  const graph = project.graphMap.get(plane.id);
  const upperGraph = project.graphMap.get(tabs[i + 1]?.id) ?? null;
  const lowerGraph = project.graphMap.get(tabs[i - 1]?.id) ?? null;
  const out = [];
  const run = () => {
    const gridCLs = collectGridCLs(graph);
    let floorHeightMm = null;
    try { floorHeightMm = floorHeightAbove(project, graph.plane); } catch { floorHeightMm = null; }
    const base = { project, materialMap: new Map(), gridCLs };
    const voidRoomsAbove = upperGraph ? selectElevationRooms(upperGraph).filter(x => x.feature === RoomFeature.VOID) : [];
    const ownRooms = selectElevationRooms(graph).filter(x => x.feature !== RoomFeature.VOID || !lowerGraph);
    const ownIds = new Set(ownRooms.map(x => x.id));
    const voidByRoomId = new Map();
    const orphanVoids = [];
    for (const v of voidRoomsAbove) {
      const host = findOverlappingRoom(roomBounds(v.cells, upperGraph), graph, x => x.feature == null);
      if (host && ownIds.has(host.id)) voidByRoomId.set(host.id, v); else orphanVoids.push(v);
    }
    const stairByRoomId = new Map(graph.stairs.map(s => [s.roomId, s]));
    for (const room of [...ownRooms, ...orphanVoids].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      let band;
      if (room.feature === RoomFeature.STAIR) band = buildStairBand(room, graph, upperGraph, { ...base, stair: stairByRoomId.get(room.id) ?? null });
      else if (room.feature === RoomFeature.VOID) {
        band = orphanVoids.includes(room)
          ? buildVoidBand(room, upperGraph, graph, { ...base, floorHeightBelowMm: floorHeightMm })
          : buildVoidBand(room, graph, lowerGraph, { ...base, floorHeightBelowMm: floorHeightBelow(project, graph.plane) });
      } else if (voidByRoomId.get(room.id)) {
        band = buildRoomBandWithVoidAbove(room, graph, voidByRoomId.get(room.id), upperGraph,
          { ...base, floorHeightAboveMm: floorHeightMm, solids: { upperGraph, floorHeightMm } });
      } else band = buildRoomBand(room, graph, { ...base, solids: { upperGraph, floorHeightMm } });
      for (const p of (band?.primitives ?? [])) out.push(`${room.id}:${JSON.stringify(p, (k, v) => (typeof v === 'number' ? num(v) : v))}`);
    }
  };
  withGraphReadScope(graph, () => withGraphReadScope(upperGraph, () => withGraphReadScope(lowerGraph, run)));
  return out.sort();
}
function fullDigest(proj) {
  const res = {};
  for (const p of [...proj.planes, ...(proj.roofPlane ? [proj.roofPlane] : [])]) {
    const g = proj.graphMap.get(p.id);
    const L = labelerOf(proj, g);
    const snap = decode(serializeGraph(g));
    const keyL = (k) => k.split(':').map(L).join(':');
    const d = {
      walls: snap.walls.map(w => projectObj(w, L)).sort(),
      edges: snap.edges.map(e => `${keyL(e.key)}=${e.masterType}/${JSON.stringify(e.overrides)}`).sort(),
      footprint: [...footprintCellKeys(g)].map(keyL).sort(),
      columns: snap.columns.map(c => projectObj(c, L)).sort(),
      beams: snap.beams.map(b => projectObj(b, L)).sort(),
      slabs: snap.slabs.map(s => projectObj({ ...s, cells: (s.cells ?? []).map(keyL).sort() }, L)).sort(),
      footings: snap.footings.map(f => projectObj(f, L)).sort(),
    };
    if (!p.isRoofPlane) d.elevation = elevationDigest(proj, p);
    res[p.name || '屋根'] = d;
  }
  return res;
}
function multisetDiff(a, b) {
  const cnt = new Map();
  for (const x of a) cnt.set(x, (cnt.get(x) ?? 0) + 1);
  for (const x of b) cnt.set(x, (cnt.get(x) ?? 0) - 1);
  const onlyA = [], onlyB = [];
  for (const [x, n] of cnt) { if (n > 0) onlyA.push(x); if (n < 0) onlyB.push(x); }
  return { onlyA, onlyB };
}

// ---- 通り芯名・部材の読みやすい記述（目視用）----
function labelOf(project, graph, isVertical, value) {
  const type = isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
  for (const g of [project.structGraph, graph]) {
    for (const s of g.shapeMap.values()) {
      if (s.centerLineType === type && s.labeled && s.label && Math.abs(s.effectiveValue - value) < 0.5) return s.label;
    }
  }
  return `補助線@${Math.round(value)}`;
}
function describeCell(project, graph, key) {
  const b = cellBoundsFromKey(key, graph);
  return `X:${labelOf(project, graph, true, b.x1)}〜${labelOf(project, graph, true, b.x2)} / Y:${labelOf(project, graph, false, b.y1)}〜${labelOf(project, graph, false, b.y2)}`
    + `（x ${Math.round(b.x1)}..${Math.round(b.x2)}, y ${Math.round(b.y1)}..${Math.round(b.y2)}）`;
}
const clName = (cl) => (cl.labeled ? cl.label
  : `${cl.centerLineType === CenterLineType.VERTICAL ? 'x' : 'y'}=${Math.round(cl.effectiveValue)}${cl.beamAxisOrigin ? `(${cl.beamAxisOrigin})` : ''}`);
const beamLine = (b) => {
  const lo = Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue);
  const hi = Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue);
  return `${b.role} ${b.isVertical ? '縦' : '横'} ${b.isVertical ? 'x' : 'y'}=${Math.round(b.axisValue)}（${clName(b.axisCL)}） ${Math.round(lo)}..${Math.round(hi)} 断面=${b.sectionDefId}`;
};
const columnLine = (c) => `${c.role} (${Math.round(c.axisX)}, ${Math.round(c.axisY)}) 断面=${c.sectionDefId} 由来=${c.woodColumnOrigins ?? '-'}`;
const clLine = (c) => `${c.centerLineType === CenterLineType.VERTICAL ? '縦' : '横'} ${Math.round(c.value)} ${c.labeled ? `通り芯${c.label}` : (c.beamAxisOrigin ?? '補助線')}`;
const planeNameOf = (project, id) => project.planeMap.get(id)?.name ?? id;

// ---- 本番と同じ関数列の壁再生成（finishBoundary.js runFinishExitBoundary の順序。makeRoofTestDoc.mjs と同じ）----
async function runWallPipeline(project, plane, materialMap) {
  const graphMapPeek = async (p) => project.graphMap.get(p.id) ?? null;
  floorSwapManager.peek = graphMapPeek;
  const refreshOne = async (p, force) => {
    const graph = project.graphMap.get(p.id);
    runInAction(() => conformWoodBacking(graph, project));
    if (force) graph.setWallFreshnessKey(null);
    else if (wallFreshnessKey(graph, project) === graph.wallFreshnessKey) return false;
    const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(graph, project, graphMapPeek);
    const before = wallBackingCenters(graph);
    const { regenerated } = await regenerateWalls(graph, { materialMap, project, stairUnderEntries, extraStairOpenings });
    if (!regenerated) return false;
    const moves = mapBackingCenterMoves(before, wallBackingCenters(graph));
    if (moves.length > 0) followWallBeamAxes(graph, moves);
    graph.setWallFreshnessKey(wallFreshnessKey(graph, project));
    runInAction(() => syncEdgesFromTopology(graph));
    return true;
  };
  await refreshOne(plane, true);
  const changed = [plane.name];
  for (const p of project.planes) {
    if (p.id === plane.id) continue;
    const g = project.graphMap.get(p.id);
    if (g.wallFreshnessKey == null && g.walls.length === 0) continue;
    if (await refreshOne(p, false)) changed.push(p.name);
  }
  const converged = await sweepUntilConverged(project, 'desc');
  return { changed, converged };
}

// ---- 1シナリオ（'base'=変更なし / 'roof'=屋根を付ける / 'none'=同じセルを無割当にする）----
async function runScenario(mode, materialMap, target) {
  const { project } = loadDocument(srcPath);
  const plane = project.planeMap.get(target.plane.id);
  const graph = project.graphMap.get(plane.id);
  let roofRoom = null;
  if (mode !== 'base') {
    if (mode === 'roof') {
      const fm = new FinishModeState(graph, project);
      const pts = target.cellKeys.map(k => centerOf(k, graph));
      fm.startDrag(pts[0].cx, pts[0].cy);
      for (const p of pts.slice(1)) fm.updateDrag(p.cx, p.cy);
      fm.commitDrag();
      const id = fm.namingRoomId;
      if (!id) throw new Error('屋根のドラッグでダイアログが開かなかった（セルが未指定扱いになっていない）');
      fm.applyNaming(id, { name: '', kind: RoomKind.INTERIOR, feature: RoomFeature.ROOF });
      if (fm.lastNamingRejection) throw new Error(`屋根の付与が拒否された: ${fm.lastNamingRejection}`);
      roofRoom = graph.roomMap.get(id);
      const got = new Set(refreshCells(roofRoom.cells, graph));
      const want = new Set(target.cellKeys);
      if (got.size !== want.size || [...want].some(k => !got.has(k))) {
        throw new Error(`屋根のセルが意図と一致しない（意図${want.size}件・実際${got.size}件）`);
      }
    } else {
      runInAction(() => subtractCellsFromUndefinedRooms(graph, new Set(target.cellKeys)));
    }
  }
  const result = await runWallPipeline(project, plane, materialMap);
  return { project, plane, graph, roofRoom, ...result };
}

const materialMap = await loadMaterialMap();
const target = findTarget(loadDocument(srcPath).project);
console.log(`=== ${srcPath}: ${target.how} ===`);

const base = await runScenario('base', materialMap, target);
const roof = await runScenario('roof', materialMap, target);
const none = await runScenario('none', materialMap, target);
console.log('壁再生成した階（屋根シナリオ）:', roof.changed, '構造再計算の収束sweep数:', roof.converged,
  `（参考: 変更なし ${base.converged} / 同じセルを無割当 ${none.converged}）`);
let failed = false;
const fail = (msg) => { console.error(`NG: ${msg}`); failed = true; };
if (roof.converged == null || roof.converged > SWEEP_LIMIT) fail(`構造再計算の収束スイープ数 ${roof.converged ?? '未収束'}（上限 ${SWEEP_LIMIT}）`);
console.log('--- 屋根セル（通り芯名）---');
for (const k of target.cellKeys) console.log('  ', describeCell(roof.project, roof.graph, k));

// ---- 壁（屋根セルを無割当にした場合と一致）----
{
  const a = wallMultiset(roof.graph);
  const b = wallMultiset(none.graph);
  const { onlyA, onlyB } = multisetDiff(a, b);
  console.log(`壁（${target.plane.name}）: 屋根=${a.length}本 / 無割当=${b.length}本 / 屋根のみ=${onlyA.length}件 / 無割当のみ=${onlyB.length}件`);
  if (onlyA.length > 0 || onlyB.length > 0) fail('屋根セルの配置が、同じセルを無割当にした配置と壁が一致しない');
  else console.log('OK: 屋根セルの配置は無割当の配置と壁が一致（全属性・多重集合）');
}

// ---- 全階ダイジェスト: 壁・境界エッジ・footprint・展開図は一致を要求、柱梁スラブ基礎は差を表示 ----
// 展開図は柱（柱包み）を描くため、その階の柱・梁・スラブ・基礎に差が出た階（1階に柱が増える）では差を許容する
// （差が柱の増減による＝壁・境界・footprint は一致している、ことで確かめる）。差の無い階は一致を要求する。
const MUST_MATCH = ['walls', 'edges', 'footprint', 'elevation'];
const dRoof = fullDigest(roof.project);
const dNone = fullDigest(none.project);
for (const pn of Object.keys(dRoof)) {
  const parts = [];
  const memberDiff = ['columns', 'beams', 'slabs', 'footings']
    .reduce((n, cat) => { const d = multisetDiff(dRoof[pn][cat], dNone[pn][cat]); return n + d.onlyA.length + d.onlyB.length; }, 0);
  for (const cat of Object.keys(dRoof[pn])) {
    const { onlyA, onlyB } = multisetDiff(dRoof[pn][cat], dNone[pn][cat]);
    const must = MUST_MATCH.includes(cat) && !(cat === 'elevation' && memberDiff > 0);
    parts.push(`${cat} ${dRoof[pn][cat].length}/${dNone[pn][cat].length}(差${onlyA.length}+${onlyB.length}${must ? '' : '・差は許容'})`);
    if (must && onlyA.length + onlyB.length > 0) {
      fail(`${pn} の ${cat} が屋根と無割当で一致しない（差 ${onlyA.length + onlyB.length} 件。壁・境界・展開図は屋根セル＝部屋の無いセルと同値のはず）`);
      for (const x of onlyA.slice(0, 3)) console.error(`   屋根のみ ${pn} ${cat}: ${x.slice(0, 200)}`);
      for (const x of onlyB.slice(0, 3)) console.error(`   無割当のみ ${pn} ${cat}: ${x.slice(0, 200)}`);
    }
  }
  console.log(`  ${pn}: ${parts.join(' | ')}`);
}

// ---- 柱・梁・CL の差（屋根 vs 無割当。全件）----
const planeIds = [...roof.project.planes, ...(roof.project.roofPlane ? [roof.project.roofPlane] : [])].map(p => p.id);
const added = { beams: [], columns: [], cls: [] };
const removed = { beams: [], columns: [], cls: [] };
for (const pid of planeIds) {
  const gr = roof.project.graphMap.get(pid), gn = none.project.graphMap.get(pid);
  const name = planeNameOf(roof.project, pid) || '屋根';
  for (const [kind, line, listOf] of [
    ['beams', beamLine, (g) => g.beams], ['columns', columnLine, (g) => g.columns], ['cls', clLine, (g) => g.centerLines],
  ]) {
    const { onlyA, onlyB } = multisetDiff(listOf(gr).map(line), listOf(gn).map(line));
    for (const x of onlyA) added[kind].push(`${name}: ${x}`);
    for (const x of onlyB) removed[kind].push(`${name}: ${x}`);
  }
}
console.log('--- 屋根を付けたことによる 柱・梁・CL の差（無割当との比較。全件）---');
for (const kind of ['beams', 'columns', 'cls']) {
  const label = { beams: '梁', columns: '柱', cls: 'CL' }[kind];
  console.log(`${label}: 増 ${added[kind].length} / 減 ${removed[kind].length}`);
  for (const x of added[kind].sort()) console.log(`   + ${x}`);
  for (const x of removed[kind].sort()) console.log(`   - ${x}`);
}
const removedNonFloor = removed.beams.filter(x => !x.includes(': floor '));
if (removedNonFloor.length > 0) fail(`床梁以外の梁が屋根を付けたことで消えた（${removedNonFloor.length} 件）`);

// ---- region と、外周の各辺の梁・範囲の床梁の確認 ----
const roofGraph2F = roof.graph;
const regions = leanToFramingRegions(roofGraph2F, roof.project);
if (regions.length !== 1) { fail(`小屋組の region が1件でない（${regions.length} 件）。対象の下屋になっていない`); }
const region = regions[0];
if (region) {
  console.log('--- 下屋の region（導かれる形状・高い側・棟）---');
  console.log(`  rect=${JSON.stringify(region.rect)} 形状=${ROOF_SHAPE_LABELS[region.shape] ?? region.shape} 高い側=${region.highSide ?? '-'} 棟=${region.ridgeIsVertical ? 'y方向' : 'x方向'}`);
  const rules = rulesFor(effectiveStructure(roofGraph2F, roof.project));
  const F = rules.framing;
  const tol = CL_OVERLAP_TOL_MM;
  const { ridges, purlins } = roofFramingLines({
    rect: region.rect, shape: region.shape, ridgeIsVertical: region.ridgeIsVertical, highSide: region.highSide,
    purlinPitchMm: F.purlinPitchMm, purlinStartOffsetsMm: F.purlinStartOffsetsMm, tolMm: tol,
  });
  console.log(`  棟木 ${ridges.length} 本: ${ridges.map(l => `${l.isVertical ? 'x' : 'y'}=${l.coord}（${l.lo}..${l.hi}）`).join(', ') || '（片流れは棟木なし）'}`);
  console.log(`  母屋 ${purlins.length} 本: ${purlins.map(l => `${l.isVertical ? 'x' : 'y'}=${l.coord}（${l.lo}..${l.hi}）`).join(', ')}`);
  // 束の位置（外周の梁がある屋根シナリオ／無い無割当シナリオ。無割当は C2d-1 より前の下屋の見え方）
  const struts = (g) => roofStrutPoints([...ridges, ...purlins], roofFramingHostMembers(g.beams, rules.baseMaterial), tol)
    .map(p => `(${Math.round(p.x)}, ${Math.round(p.y)})`);
  const withPerimeter = struts(roofGraph2F);
  const without = new Set(struts(none.graph));
  console.log(`  束 ${withPerimeter.length} 点（外周の梁あり。無割当シナリオ＝外周の梁なしは ${without.size} 点）`);
  console.log(`   外周の梁ができて増える束: ${withPerimeter.filter(s => !without.has(s)).join(' ') || '（なし）'}`);
  console.log(`   全点: ${withPerimeter.join(' ')}`);

  // 外周の各辺（屋内との境界は対象外）に primary 梁が出たか
  const R = region.rect;
  const primaries = roofGraph2F.beams.filter(b => b.role === 'primary');
  const covers = (isVertical, coord, lo, hi) => {
    const spans = primaries.filter(b => b.isVertical === isVertical && Math.abs(b.axisValue - coord) < 1)
      .map(b => [Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue), Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue)])
      .sort((p, q) => p[0] - q[0]);
    let at = lo;
    for (const [s, e] of spans) { if (s > at + 1) break; at = Math.max(at, e); }
    return at >= hi - 1;
  };
  const lowerWallRuns = (isVertical, coord) => {
    const lowerG = roof.project.graphMap.get(adoptedPlanes(roof.project)[TARGET.planeIndex - 1].id);
    return lowerG.walls.filter(w => w.isVertical === isVertical && Math.abs(w.axisValue - coord) < 80);
  };
  console.log('--- 下屋の外周の各辺（上＝y小・下＝y大・左＝x小・右＝x大）---');
  for (const [name, isVertical, coord, lo, hi] of [
    ['上辺', false, R.y1, R.x1, R.x2], ['下辺', false, R.y2, R.x1, R.x2], ['左辺', true, R.x1, R.y1, R.y2], ['右辺', true, R.x2, R.y1, R.y2],
  ]) {
    const hasWall = lowerWallRuns(isVertical, coord).length > 0;
    console.log(`  ${name}（${isVertical ? 'x' : 'y'}=${coord}、${lo}..${hi}）: primary 梁 ${covers(isVertical, coord, lo, hi) ? '全長あり' : '全長はない'}（1階の壁線${hasWall ? 'あり' : 'なし'}）`);
  }
  const perimeterExterior = [
    ['下辺', false, R.y2, R.x1, R.x2], ['右辺', true, R.x2, R.y1, R.y2],
  ].filter(([, isV, c]) => lowerWallRuns(isV, c).length > 0);
  for (const [name, isVertical, coord, lo, hi] of perimeterExterior) {
    if (!covers(isVertical, coord, lo, hi)) fail(`下屋の外周（${name}）に primary 梁が全長に出ていない`);
  }
  // 範囲の床梁
  const floorInRoof = roofGraph2F.beams.filter(b => b.role === 'floor' && (b.isVertical
    ? b.axisValue > R.x1 - 1 && b.axisValue < R.x2 + 1 && Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue) < R.y2 - 1 && Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue) > R.y1 + 1
    : b.axisValue > R.y1 - 1 && b.axisValue < R.y2 + 1 && Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue) < R.x2 - 1 && Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue) > R.x1 + 1));
  console.log(`  下屋の範囲に掛かる床梁: ${floorInRoof.length} 本${floorInRoof.length > 0 ? '（' + floorInRoof.map(beamLine).join(' / ') + '）' : ''}`);
  if (floorInRoof.length > 0) fail('下屋の範囲に床梁が残っている');
}

// ---- 往復テスト（書いて読み直して部屋・壁・柱のダイジェスト一致。屋根の部屋が残ることも確認）----
roof.project.activePlaneId = target.plane.id;
const json = encodeDocument(roof.project);
const reloaded = decodeDocument(json);
if (digestProject(roof.project) !== digestProject(reloaded)) fail('往復テスト不一致（書いて読み直したダイジェストが元と異なる）');
const roofAfter = reloaded.graphMap.get(target.plane.id).rooms.find(r => r.feature === RoomFeature.ROOF);
if (!roofAfter || roofAfter.kind !== RoomKind.EXTERIOR || roofAfter.name !== '屋根') fail('読み直した文書で屋根の部屋（kind=exterior・name=屋根）が残っていない');
else {
  const expectDefaults = { ...new RoofSpec({ note: '下野' }).toData() };
  const spec = roofAfter.roofSpec;
  if (!spec || JSON.stringify(spec.toData()) !== JSON.stringify(expectDefaults)) fail('読み直した屋根の roofSpec が既定値でない');
  if (spec && Object.keys(spec.toData()).sort().join() !== [...ROOF_SPEC_KEYS].sort().join()) fail('roofSpec のキー集合が ROOF_SPEC_KEYS と一致しない');
  const g = reloaded.graphMap.get(target.plane.id);
  const bounds = roofRoomBounds(roofAfter, g);
  console.log(`  ${target.plane.name} の屋根: セル${roofAfter.cells.size}件 短手=${roofShortSpanMm(bounds)}mm → 形状（自動）=${ROOF_SHAPE_LABELS[resolveRoofShape(roofAfter.roofSpec, { boundsList: bounds })]}`);
}
if (failed) process.exit(1);
console.log('OK: 往復テスト一致（屋根の部屋・RoofSpec も残る）');

fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');
