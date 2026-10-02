// 屋根（RoomFeature.ROOF。仕上げモードの属性「屋根」＝下屋。ステップB1a）を実データで目視確認するための
// テスト用 .stq を作るスクリプト。
//
// 流れ（makeWoodEvTestDoc.mjs と同型）:
//   1. loadDoc.mjs で既存 .stq を読む。往復テスト（読み→書き→読みで部屋・壁のダイジェスト一致）を先に通す。
//   2. 下屋を置ける場所を探す: 「自階の部屋が未定義（または無い）で、直下階に屋内部屋（feature無しの屋内）があり、
//      直上階に部屋が無い」セル。あればそのセルを屋根にする。無ければ「最上側の階の屋内部屋を1つ削って
//      （deleteRoom＝未定義化。本番のカード削除と同じ）から屋根にする」（直下階に屋内部屋があり、建物の外周に
//      接する部屋のうちセル数が最小のもの）。
//   3. 屋根の付与は本番と同じ経路（FinishModeState: 部屋ドラッグ→commitDrag→applyNaming）で行う。
//   4. 壁の再生成は仕上げ脱出境界（finish/finishBoundary.js runFinishExitBoundary）と同じ順序の関数列で行う:
//      conformWoodBacking → resolveStairContext → regenerateWalls → 鮮度キー更新 → 壁由来梁芯の追従
//      （followWallBeamAxes）→ syncEdgesFromTopology（境界エッジ）→ 他階の鮮度キー不一致の再生成
//      （wallRefresh 相当）→ 全階の構造再計算（sweepUntilConverged＝reflectStructuralAfterFinishExit 相当）。
//      省いたもの: CL偏芯の階またぎ伝播（propagateCLEccentricities）・上階の階段内装コピー
//      （syncUpperStairInteriors）・腰壁垂れ壁/偏芯の孤児掃除。いずれも IndexedDB（floorSwapManager/saveFloor）か
//      CL偏芯レコードを要し、屋根の有無に依存しない（屋根は壁を持たず、これらの入力に現れない）ため。
//   5. 「屋根セルを無割当にした場合」（同じ手順で屋根を付けずセルを無割当にする）と、全階の 壁（全属性の多重集合）・
//      境界エッジ（キーとmasterType）・footprintCellKeys・柱梁スラブ基礎（id・部材番号を除く全フィールド）・
//      展開図のプリミティブが一致することを確かめる。一致しなければ exit 1。
//   6. 書いて読み直したダイジェスト一致を確認してから保存する。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeRoofTestDoc.mjs [入力.stq] [出力.stq]
//   既定: moku4.stq（在来木造）→ D:/tatsuya/Download/roof-test1.stq
//   S造: 13.stq → roof-test2.stq（引数で指定）
// 既存ファイルは上書きしない。.mjs は eslint の対象外。
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, RoomKind, RoomFeature, CenterLineType, RoofSpec, ROOF_SPEC_KEYS, ROOF_SHAPE_LABELS } from '../../src/core.js';
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
const outPath = process.argv[3] ?? 'D:/tatsuya/Download/roof-test1.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

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
  const json0 = encodeDocument(p0);
  const p0b = decodeDocument(json0);
  if (digestProject(p0) !== digestProject(p0b)) {
    console.error('NG: 往復テスト不一致（入力文書を書いて読み直した部屋・壁・柱のダイジェストが元と異なる）');
    process.exit(1);
  }
  console.log('OK: 往復テスト一致（入力文書。部屋・壁・柱のダイジェスト）');
}

// ---- 屋根を付ける場所を探す ----
const adoptedPlanes = (project) => [...project.planes]
  .filter(p => !p.isAlternative && !p.isRoofPlane)
  .sort((a, b) => a.elevation - b.elevation);

const isRealIndoor = (room) => !!room && room.kind === RoomKind.INTERIOR && room.feature == null;

function centerOf(key, graph) {
  const b = cellBoundsFromKey(key, graph);
  return { cx: (b.x1 + b.x2) / 2, cy: (b.y1 + b.y2) / 2, b };
}

function roomAtPoint(graph, map, x, y) {
  const c = worldToCell(x, y, graph);
  return c ? (map.get(c.key) ?? null) : null;
}

function findTarget(project) {
  const planes = adoptedPlanes(project);
  // 候補1: 自階が未定義（deleteされた部屋）で、直下に屋内部屋があり、直上に部屋が無いセル。
  for (let f = planes.length - 1; f >= 1; f--) {
    const g = project.graphMap.get(planes[f].id);
    const lower = project.graphMap.get(planes[f - 1].id);
    const upper = f + 1 < planes.length ? project.graphMap.get(planes[f + 1].id) : null;
    const lowerMap = buildCellToRoom(lower);
    const upperMap = upper ? buildCellToRoom(upper) : null;
    const cells = [];
    for (const room of g.rooms) {
      if (room.feature !== RoomFeature.UNDEFINED) continue;
      for (const key of refreshCells(room.cells, g)) {
        const { cx, cy } = centerOf(key, g);
        if (!isRealIndoor(roomAtPoint(lower, lowerMap, cx, cy))) continue;
        if (upper && roomAtPoint(upper, upperMap, cx, cy)) continue;
        cells.push(key);
      }
    }
    if (cells.length > 0) return { plane: planes[f], deleteRoomId: null, cellKeys: cells, how: `${planes[f].name}の未定義セル（直下に屋内部屋・直上に部屋なし）` };
  }
  // 候補2: 屋内部屋を1つ削って屋根にする。
  for (let f = planes.length - 1; f >= 1; f--) {
    const g = project.graphMap.get(planes[f].id);
    const lower = project.graphMap.get(planes[f - 1].id);
    const upper = f + 1 < planes.length ? project.graphMap.get(planes[f + 1].id) : null;
    const lowerMap = buildCellToRoom(lower);
    const upperMap = upper ? buildCellToRoom(upper) : null;
    const allCells = g.rooms.flatMap(r => [...refreshCells(r.cells, g)]);
    const bounds = allCells.map(k => cellBoundsFromKey(k, g)).filter(Boolean);
    if (bounds.length === 0) continue;
    const minX = Math.min(...bounds.map(b => b.x1)), maxX = Math.max(...bounds.map(b => b.x2));
    const minY = Math.min(...bounds.map(b => b.y1)), maxY = Math.max(...bounds.map(b => b.y2));
    const referenced = new Set(g.rooms.flatMap(r => [...r.referenceRoomIds]));
    const cands = [];
    for (const room of g.rooms) {
      if (!isRealIndoor(room) || room.referenceRoomIds.size > 0 || referenced.has(room.id)) continue;
      if (g.stairs.some(s => s.roomId === room.id)) continue;
      const cells = [...refreshCells(room.cells, g)];
      if (cells.length === 0) continue;
      const ok = cells.every(key => {
        const { cx, cy } = centerOf(key, g);
        return isRealIndoor(roomAtPoint(lower, lowerMap, cx, cy)) && !(upper && roomAtPoint(upper, upperMap, cx, cy));
      });
      if (!ok) continue;
      const touchesOuter = cells.some(key => {
        const b = cellBoundsFromKey(key, g);
        return b.x1 === minX || b.x2 === maxX || b.y1 === minY || b.y2 === maxY;
      });
      if (!touchesOuter) continue;
      cands.push({ room, cells });
    }
    cands.sort((a, b) => a.cells.length - b.cells.length);
    if (cands.length > 0) {
      const c = cands[0];
      return { plane: planes[f], deleteRoomId: c.room.id, cellKeys: c.cells, how: `${planes[f].name}の屋内部屋「${c.room.name}」を削除して屋根にする（直下に屋内部屋・外周に接する・直上に部屋なし）` };
    }
  }
  return null;
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

// ---- 通り芯名（目視用）----
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

// ---- 本番と同じ関数列の壁再生成（finishBoundary.js runFinishExitBoundary の順序）----
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

  await refreshOne(plane, true); // 自階（脱出する階）は必ず再生成
  const changed = [plane.name];
  for (const p of project.planes) { // 他階: 鮮度キー不一致だけ（refreshWallsAllFloors 相当）
    if (p.id === plane.id) continue;
    const g = project.graphMap.get(p.id);
    if (g.wallFreshnessKey == null && g.walls.length === 0) continue;
    if (await refreshOne(p, false)) changed.push(p.name);
  }
  const converged = await sweepUntilConverged(project, 'desc'); // 全階の構造再計算（reflectStructuralAfterFinishExit 相当）
  return { changed, converged };
}

// ---- 1シナリオ（'base'=変更なし / 'roof'=屋根を付ける / 'none'=同じセルを無割当にする）----
async function runScenario(mode, materialMap, target) {
  const { project } = loadDocument(srcPath);
  const plane = project.planeMap.get(target.plane.id);
  const graph = project.graphMap.get(plane.id);
  let roofRoom = null;
  if (mode !== 'base') {
    const fm = new FinishModeState(graph, project);
    if (target.deleteRoomId) fm.deleteRoom(target.deleteRoomId); // 本番のカード削除（未定義化）
    if (mode === 'roof') {
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
if (!target) {
  console.error('NG: 屋根を付けられる場所（直下に屋内部屋・自階が未定義/削除可・直上に部屋なし）が見つかりません');
  process.exit(1);
}
console.log(`=== ${srcPath}: ${target.how}。セル${target.cellKeys.length}件 ===`);

const base = await runScenario('base', materialMap, target);
const roof = await runScenario('roof', materialMap, target);
const none = await runScenario('none', materialMap, target);
console.log('壁再生成した階（屋根シナリオ）:', roof.changed, '構造再計算の収束sweep数:', roof.converged);
if (roof.converged == null) console.error('警告: 構造再計算が収束しなかった');

// ---- 屋根を付けた階の外壁の前後（目視用）----
const extWalls = (g) => g.walls.filter(w => w.isExteriorWall);
const fmtWall = (w) => `${w.isVertical ? '縦' : '横'} 軸=${num(w.axisCL.effectiveValue)} 位置=${num(w.axisValue)} ${Math.round(Math.min(w.coord1, w.coord2))}..${Math.round(Math.max(w.coord1, w.coord2))}`;
console.log(`--- ${target.plane.name} 外壁（屋根を付ける前＝変更なしで再生成）${extWalls(base.graph).length}本 ---`);
for (const l of extWalls(base.graph).map(fmtWall).sort()) console.log('  ', l);
console.log(`--- ${target.plane.name} 外壁（屋根を付けた後）${extWalls(roof.graph).length}本 ---`);
for (const l of extWalls(roof.graph).map(fmtWall).sort()) console.log('  ', l);
console.log('--- 屋根セル（通り芯名）---');
for (const k of target.cellKeys) console.log('  ', describeCell(roof.project, roof.graph, k));

// ---- 屋根セルを無割当にした場合と壁が一致するか ----
const a = wallMultiset(roof.graph);
const b = wallMultiset(none.graph);
const onlyA = a.filter(x => !b.includes(x));
const onlyB = b.filter(x => !a.includes(x));
console.log(`壁（${target.plane.name}）: 屋根=${a.length}本 / 無割当=${b.length}本 / 屋根のみ=${onlyA.length}件 / 無割当のみ=${onlyB.length}件`);
if (a.length !== b.length || onlyA.length > 0 || onlyB.length > 0) {
  console.error('NG: 屋根セルの配置が、同じセルを無割当にした配置と壁が一致しない');
  for (const x of onlyA.slice(0, 5)) console.error('  屋根のみ:', x);
  for (const x of onlyB.slice(0, 5)) console.error('  無割当のみ:', x);
  process.exit(1);
}
console.log('OK: 屋根セルの配置は無割当の配置と壁が一致（全属性・多重集合）');

// 全階の 境界エッジ（キーとmasterType）・footprintCellKeys・柱と梁・スラブ・基礎の属性（位置・断面・role等の
// 全フィールド。id と部材番号を除く）の多重集合・展開図のプリミティブを、屋根/無割当で比べる。
// 一致しなければ exit 1（壁だけでは境界エッジ1件のずれ等を見逃すため）。
const dRoof = fullDigest(roof.project);
const dNone = fullDigest(none.project);
let mismatchTotal = 0;
for (const pn of Object.keys(dRoof)) {
  const parts = [];
  for (const cat of Object.keys(dRoof[pn])) {
    const { onlyA, onlyB } = multisetDiff(dRoof[pn][cat], dNone[pn][cat]);
    mismatchTotal += onlyA.length + onlyB.length;
    parts.push(`${cat} ${dRoof[pn][cat].length}/${dNone[pn][cat].length}(差${onlyA.length}+${onlyB.length})`);
    for (const x of onlyA.slice(0, 3)) console.error(`   屋根のみ ${pn} ${cat}: ${x.slice(0, 200)}`);
    for (const x of onlyB.slice(0, 3)) console.error(`   無割当のみ ${pn} ${cat}: ${x.slice(0, 200)}`);
  }
  console.log(`  ${pn}: ${parts.join(' | ')}`);
}
if (mismatchTotal > 0) {
  console.error(`NG: 屋根の配置が無割当の配置と一致しない（境界エッジ・footprint・柱梁・スラブ・基礎・展開図の差 ${mismatchTotal} 件）`);
  process.exit(1);
}
console.log('OK: 境界エッジ・footprint・柱梁・スラブ・基礎・展開図プリミティブも屋根と無割当で一致（差0件）');

// ---- 往復テスト（書いて読み直して部屋・壁・柱のダイジェスト一致。屋根の部屋が残ることも確認）----
roof.project.activePlaneId = target.plane.id;
const json = encodeDocument(roof.project);
const reloaded = decodeDocument(json);
if (digestProject(roof.project) !== digestProject(reloaded)) {
  console.error('NG: 往復テスト不一致（書いて読み直したダイジェストが元と異なる）');
  process.exit(1);
}
const roofAfter = reloaded.graphMap.get(target.plane.id).rooms.find(r => r.feature === RoomFeature.ROOF);
if (!roofAfter || roofAfter.kind !== RoomKind.EXTERIOR || roofAfter.name !== '屋根') {
  console.error('NG: 読み直した文書で屋根の部屋（kind=exterior・name=屋根）が残っていない');
  process.exit(1);
}
console.log('OK: 往復テスト一致（屋根の部屋も残る）');

// ---- 屋根の仕様（RoofSpec。ステップB2）: 屋根の部屋が既定値の RoofSpec を持ち、保存→読込みで全10項目が残る ----
{
  const roofRoomsOf = (proj) => proj.planes.flatMap(p => proj.graphMap.get(p.id).rooms
    .filter(r => r.feature === RoomFeature.ROOF).map(r => ({ planeName: p.name, room: r })));
  const before = roofRoomsOf(roof.project);
  const after = roofRoomsOf(reloaded);
  if (before.length === 0 || before.length !== after.length) {
    console.error(`NG: 屋根の部屋の数が合わない（保存前 ${before.length} / 読込み後 ${after.length}）`);
    process.exit(1);
  }
  const expectDefaults = { ...new RoofSpec({ note: '下野' }).toData() };
  for (let i = 0; i < before.length; i++) {
    const b = before[i].room.roofSpec;
    const a = after[i].room.roofSpec;
    if (!b || !a) { console.error(`NG: 屋根の部屋に roofSpec が無い（${before[i].planeName}）`); process.exit(1); }
    if (JSON.stringify(b.toData()) !== JSON.stringify(expectDefaults)) {
      console.error('NG: 付与した屋根の roofSpec が既定値（備考「下野」）でない', b.toData());
      process.exit(1);
    }
    if (JSON.stringify(a.toData()) !== JSON.stringify(b.toData())) {
      console.error('NG: 保存→読込みで roofSpec の項目が変わった', b.toData(), a.toData());
      process.exit(1);
    }
    if (Object.keys(a.toData()).sort().join() !== [...ROOF_SPEC_KEYS].sort().join()) {
      console.error('NG: roofSpec のキー集合が ROOF_SPEC_KEYS と一致しない');
      process.exit(1);
    }
  }
  // 屋根以外の部屋に roofSpec が付いていないこと（I1）
  for (const p of reloaded.planes) {
    for (const r of reloaded.graphMap.get(p.id).rooms) {
      if (r.feature !== RoomFeature.ROOF && r.roofSpec) { console.error(`NG: 屋根でない部屋に roofSpec がある（${r.name}）`); process.exit(1); }
    }
  }
  console.log(`OK: 屋根の部屋 ${before.length} 件が既定値の RoofSpec（備考「下野」）を持ち、保存→読込みで全10項目が残る`);
  // 目視用: 屋根の短手と導かれる形状（屋根の部屋ごと）
  for (const { planeName, room } of after) {
    const g = reloaded.graphMap.get(planeName === target.plane.name ? target.plane.id : reloaded.planes.find(p => p.name === planeName).id);
    const bounds = roofRoomBounds(room, g);
    console.log(`  ${planeName} の屋根: セル${room.cells.size}件 短手=${roofShortSpanMm(bounds)}mm → 形状（自動）=${ROOF_SHAPE_LABELS[resolveRoofShape(room.roofSpec, { boundsList: bounds })]}`);
  }
}

fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');
