// 階段の上階展開（続きの階段＋最上階 STAIR_VOID → 直上階1階だけの STAIR_VOID 方式）の変更前基準採取 probe。
// 読み取り専用: .stq を復元して各階の階段・STAIR_VOID・VOID・階段ペア部屋・上階スラブ開口・規則Oの源を
// 位置由来の安定キー（セルキー＝CL id ではなく cellBoundsFromKey の x1,y1,x2,y2 を sort して結合）でJSONへ落とす。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/stairChainProbe.mjs [stqパス] [出力先ディレクトリ]
//   既定: D:/tatsuya/Download/13.stq → scripts/probe/golden-stair/13.json
// 規則Oは構造再計算を回さず openingBeamSourcesFor（純関数）を直接呼ぶ。入力＝保存済みグラフ・直下階グラフ・
//   stairRiserOf の蹴上。effective＝その建物の実効主構造のルール、steel＝rulesFor('S造') を強制した場合
//   （13/moku4 は S造でないため、規則Oの検出力を持たせる目的）。生成された梁芯CLそのもの（autoFill結果）
//   は対象外（構造再計算が要るため。floorOpeningEdges・源の出力までで止めている）。
// 【lint対象外】.mjs は eslint.config.js の対象外。未使用 import は目視確認。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadDocument } from './loadDoc.mjs';
import { RoomFeature } from '../../src/core.js';
import { refreshCells, cellBoundsFromKey } from '../../src/finish/gridCells.js';
import { stairRiserOf, floorHeightAbove } from '../../src/finish/stair/stairDimensions.js';
import { slabOpeningRects, floorOpeningEdges } from '../../src/finish/stair/slabOpening.js';
import { openingBeamSourcesFor } from '../../src/structural/openingBeamAxes.js';
import { rulesFor, effectiveStructure } from '../../src/structural/structureRules.js';
import { serializeGraph } from '../../src/graphSnapshot.js';
import { syncUpperFloors } from '../../src/finish/stair/stairFloorSync.js';
import { makeStorePeek, makeStoreSave, decodeFloor } from '../../src/finish/equipment/equipmentTestFixtures.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/13.stq';
const outDir = process.argv[3] ?? path.join(import.meta.dirname, 'golden-stair');
const docName = path.basename(src).replace(/\.stq$/i, '');
const r3 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

const { project } = loadDocument(src);
const planes = project.planes; // 採用階・elevation 昇順

// 位置由来のセル集合キー（CL id を含まない）。
function posCells(cells, graph) {
  const out = [];
  for (const key of refreshCells(cells, graph)) {
    const b = cellBoundsFromKey(key, graph);
    out.push(b ? `${r3(b.x1)},${r3(b.y1)},${r3(b.x2)},${r3(b.y2)}` : 'unresolved');
  }
  return out.sort();
}
const footKey = (cells, graph) => posCells(cells, graph).join('|');
const rectKey = (b) => ({ x1: r3(b.x1), y1: r3(b.y1), x2: r3(b.x2), y2: r3(b.y2) });
const sortBy = (arr, f) => [...arr].sort((a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0));

function describeSource(s) {
  return {
    isVertical: s.isVertical, coord: r3(s.coord), lo: r3(s.lo), hi: r3(s.hi), outwardSign: s.outwardSign,
    through: s.through, onGrid: s.onGrid, rcBacked: s.rcBacked, source: s.source, sources: [...(s.sources ?? [])].sort(),
    beamWidthUnresolved: s.beamWidthUnresolved,
  };
}
function describeEdge(e) {
  return {
    isVertical: e.isVertical, coord: r3(e.coord), lo: r3(e.lo), hi: r3(e.hi), outwardSign: e.outwardSign,
    onGrid: e.onGrid, source: e.source, sources: [...e.sources].sort(),
  };
}
function sourcesOf(graph, below, riserOf, rules) {
  try {
    const list = openingBeamSourcesFor(graph, project, { riserOf, belowGraph: below, rules });
    return sortBy(list.map(describeSource), x => JSON.stringify(x));
  } catch (e) { return { error: String(e?.message ?? e) }; }
}

const floors = [];
for (let i = 0; i < planes.length; i++) {
  const plane = planes[i];
  const graph = project.graphMap.get(plane.id);
  const upperPlane = planes[i + 1] ?? null;
  const upperGraph = upperPlane ? project.graphMap.get(upperPlane.id) : null;
  const belowPlane = planes[i - 1] ?? null;
  const belowGraph = belowPlane ? project.graphMap.get(belowPlane.id) : null;
  const fh = floorHeightAbove(project, plane);

  const stairs = sortBy(graph.stairs.map(s => {
    const riserEff = stairRiserOf(s, project, plane);
    const room = s.roomId ? graph.roomMap.get(s.roomId) : null;
    return {
      type: s.type, structure: s.structure, cells: posCells(s.cells, graph), totalSteps: s.totalSteps,
      sections: s.sections ?? null, riser: s.riser ?? null, tread: s.tread,
      hasRoomId: !!s.roomId, roomLinkResolved: !!room, roomFeature: room?.feature ?? null,
      entrySide: s.entrySide ?? null, arrivalSide: s.arrivalSide ?? null,
      entryTurnSteps: s.entryTurnSteps ?? 0, arrivalTurnSteps: s.arrivalTurnSteps ?? 0,
      riserEffective: r3(riserEff),
      // 続きの階段＝直下階に同 footprint（位置一致）の階段がある
      continuation: !!belowGraph && belowGraph.stairs.some(b => footKey(b.cells, belowGraph) === footKey(s.cells, graph)),
    };
  }), x => x.cells.join('|'));

  const roomsOf = (feature) => sortBy(graph.rooms.filter(rm => rm.feature === feature)
    .map(rm => ({ cells: posCells(rm.cells, graph) })), x => x.cells.join('|'));
  const stairVoids = roomsOf(RoomFeature.STAIR_VOID);
  const voids = roomsOf(RoomFeature.VOID);
  const pairRooms = sortBy(graph.rooms.filter(rm => rm.feature === RoomFeature.STAIR).map(rm => {
    const linked = graph.stairs.filter(s => s.roomId === rm.id);
    return { cells: posCells(rm.cells, graph), linkedStairFootprints: linked.map(s => posCells(s.cells, graph).join('|')).sort() };
  }), x => x.cells.join('|'));

  // 上階が解決できる階: 上階スラブ開口（上階視点）
  let upperSlab = null;
  if (upperGraph) {
    const riserOf = (s) => stairRiserOf(s, project, upperPlane);
    const rects = slabOpeningRects(upperGraph, { riserOf });
    upperSlab = { upperPlaneId: upperPlane.id, rects: sortBy((rects ?? []).map(rectKey), x => JSON.stringify(x)) };
  }

  // 自階の床開口辺（規則Oの入力。stairFilter 既定＝全階段を破れ先源に含める）と、規則Oの源
  const riserSelf = (s) => stairRiserOf(s, project, plane);
  const ownEdges = sortBy(floorOpeningEdges(graph, { riserOf: riserSelf }).map(describeEdge), x => JSON.stringify(x));
  const effStructure = effectiveStructure(graph, project) ?? null;
  const ruleO = {
    effectiveStructure: effStructure,
    effective: sourcesOf(graph, belowGraph, riserSelf, undefined),
    steel: sourcesOf(graph, belowGraph, riserSelf, rulesFor('S造')),
  };

  floors.push({
    planeId: plane.id, name: plane.name, elevation: plane.elevation, floorHeight: fh,
    stairs, stairVoids, voids, pairRooms, upperSlab, ownFloorOpeningEdges: ownEdges, ruleO,
  });
}

// 再展開シナリオ（検出力のため）: 保存データの読み取りだけでは syncUpperFloors／addStairVoidRoom が一度も
// 走らず、上階展開ロジックの変更を検出できない。そこで「起点階（直下階に同 footprint の階段が無い階段を持つ階）」
// ごとに、メモリ上の store 複製で (1) 起点より上の全階から、起点の階段 footprint に一致する階段・STAIR_VOID・
// 階段ペア部屋を除去 → (2) 本番の syncUpperFloors（peek/save だけメモリ注入。finish/equipment の
// 本番同型フィクスチャ）を実行 → (3) 全上階の階段・STAIR_VOID・ペア部屋を位置キーで記録する。
// matchesStored＝再展開結果が保存データの上階（階段・STAIR_VOID・ペア部屋の footprint 集合）と一致するか。
// 省略している処理: 仕上げ脱出の他の手順（壁再生成・構造反映・syncUpperStairInteriors）は呼ばない
// （上階展開そのもの＝syncUpperFloors だけが対象）。
function floorStairShape(graph) {
  const fp = (c) => footKey(c, graph);
  return {
    stairs: graph.stairs.map(s => fp(s.cells)).sort(),
    stairVoids: graph.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID).map(r => fp(r.cells)).sort(),
    pairRooms: graph.rooms.filter(r => r.feature === RoomFeature.STAIR).map(r => fp(r.cells)).sort(),
  };
}
const resyncScenarios = [];
for (let k = 0; k < planes.length; k++) {
  const originPlane = planes[k];
  const originGraph = project.graphMap.get(originPlane.id);
  const belowG = k > 0 ? project.graphMap.get(planes[k - 1].id) : null;
  const originStairs = originGraph.stairs.filter(s => !(belowG && belowG.stairs.some(b => footKey(b.cells, belowG) === footKey(s.cells, originGraph))));
  if (originStairs.length === 0) continue;
  const footprints = new Set(originStairs.map(s => footKey(s.cells, originGraph)));

  const store = new Map();
  for (const p of planes) store.set(p.id, serializeGraph(project.graphMap.get(p.id)));
  const peek = makeStorePeek(project, store);
  const save = makeStoreSave(store);
  for (let i = k + 1; i < planes.length; i++) {
    const g = peek(planes[i]);
    for (const s of [...g.stairs]) if (footprints.has(footKey(s.cells, g))) g.removeStair(s.id);
    for (const rm of [...g.rooms]) {
      if ((rm.feature === RoomFeature.STAIR_VOID || rm.feature === RoomFeature.STAIR) && footprints.has(footKey(rm.cells, g))) g.removeRoom(rm.id);
    }
    store.set(planes[i].id, serializeGraph(g));
  }
  project.activePlaneId = originPlane.id;
  await syncUpperFloors(project, originGraph, { peekFn: peek, saveFloorFn: save });

  const upper = [];
  let matchesStored = true;
  for (let i = k + 1; i < planes.length; i++) {
    const g = decodeFloor(project, planes[i], store.get(planes[i].id));
    const shape = floorStairShape(g);
    const stored = floorStairShape(project.graphMap.get(planes[i].id));
    if (JSON.stringify(shape) !== JSON.stringify(stored)) matchesStored = false;
    upper.push({ name: planes[i].name, ...shape });
  }
  resyncScenarios.push({ originFloor: originPlane.name, originFootprints: [...footprints].sort(), matchesStored, upper });
}

const summary = {
  floorCount: planes.length,
  perFloor: floors.map(f => ({
    name: f.name, stairs: f.stairs.length, stairVoids: f.stairVoids.length, voids: f.voids.length,
    pairRooms: f.pairRooms.length, continuationStairs: f.stairs.filter(s => s.continuation).length,
  })),
  resyncScenarioCount: resyncScenarios.length,
  resyncStairVoidsTotal: resyncScenarios.reduce((n, s) => n + s.upper.reduce((m, u) => m + u.stairVoids.length, 0), 0),
  resyncStairsTotal: resyncScenarios.reduce((n, s) => n + s.upper.reduce((m, u) => m + u.stairs.length, 0), 0),
  resyncAllMatchStored: resyncScenarios.every(s => s.matchesStored),
  stairsTotal: floors.reduce((n, f) => n + f.stairs.length, 0),
  stairVoidsTotal: floors.reduce((n, f) => n + f.stairVoids.length, 0),
  continuationStairsTotal: floors.reduce((n, f) => n + f.stairs.filter(s => s.continuation).length, 0),
  upperSlabRectsTotal: floors.reduce((n, f) => n + (f.upperSlab?.rects.length ?? 0), 0),
  ruleOEffectiveSourcesTotal: floors.reduce((n, f) => n + (Array.isArray(f.ruleO.effective) ? f.ruleO.effective.length : 0), 0),
  ruleOSteelSourcesTotal: floors.reduce((n, f) => n + (Array.isArray(f.ruleO.steel) ? f.ruleO.steel.length : 0), 0),
};

let commit = '(unknown)';
try { commit = execSync('git rev-parse --short HEAD', { cwd: import.meta.dirname }).toString().trim(); } catch { /* 読めなければ unknown */ }

const result = { probe: 'stairChainProbe', commit, source: docName, summary, resyncScenarios, floors };
const json = JSON.stringify(result, null, 1);
if (process.env.STAIR_PROBE_STDOUT === '1') {
  console.log(json);
} else {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${docName}.json`), json);
  console.log(JSON.stringify(summary));
}
