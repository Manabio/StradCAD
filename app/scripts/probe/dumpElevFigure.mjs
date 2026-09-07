// 11.stq の各階・各部屋の展開図の**描画プリミティブ**をJSONへ落とす（回帰の基準）。
//
// 部屋ごとの帯ビルダーの振り分けは modes/ElevationModeState.js の `buildOne` を写す
// ——階段室は buildStairBand・吹抜けは buildVoidBand・上部吹抜けを持つ部屋は
// buildRoomBandWithVoidAbove を通る。全部屋を buildRoomBand で作ると**実機が通らない経路**を
// 比較してしまい、階段室（例: 11.stq 1階の「6」）の差分を取り逃がす。
import fs from 'node:fs';
import path from 'node:path';
import { RoomFeature } from '../../src/core.js';
import { loadDocument } from './loadDoc.mjs';
import { buildRoomBand } from '../../src/elevation/elevationBand.js';
import { buildStairBand } from '../../src/elevation/elevationStair.js';
import { buildVoidBand, buildRoomBandWithVoidAbove, findOverlappingRoom } from '../../src/elevation/elevationVoid.js';
import { selectElevationRooms } from '../../src/elevation/elevationFaces.js';
import { roomBounds } from '../../src/finish/gridCells.js';
import { floorHeightAbove, floorHeightBelow } from '../../src/finish/stair/stairDimensions.js';
import { collectGridCLs } from '../../src/elevation/elevationPrimitives.js';
import { withGraphReadScope } from '../../src/graphReadScope.js';

const outDir = process.argv[2] ?? path.join(import.meta.dirname, 'golden');
const src = process.argv[3] ?? 'D:/tatsuya/Download/11.stq';
fs.mkdirSync(outDir, { recursive: true });
const r = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);

// プリミティブを比較しやすい安定した形へ（数値は丸め、キー順を固定）。
function norm(p) {
  if (Array.isArray(p)) return p.map(x => (x && typeof x === 'object' ? norm(x) : r(x)));
  const out = {};
  for (const k of Object.keys(p).sort()) {
    const v = p[k];
    out[k] = (v && typeof v === 'object') ? norm(v) : r(v);
  }
  return out;
}

const { project } = loadDocument(src);
const tabs = project.orderedTabs;
const summary = [];
for (let i = 0; i < tabs.length; i++) {
  const p = tabs[i];
  const graph = project.graphMap.get(p.id);
  if (!graph) continue;
  const upperGraph = project.graphMap.get(tabs[i + 1]?.id) ?? null;
  const lowerGraph = project.graphMap.get(tabs[i - 1]?.id) ?? null;
  const rows = [];
  const run = () => {
    const gridCLs = collectGridCLs(graph);
    let floorHeightMm = null;
    try { floorHeightMm = floorHeightAbove(project, graph.plane); } catch { floorHeightMm = null; }
    const base = { project, materialMap: new Map(), gridCLs };

    const voidRoomsAbove = upperGraph
      ? selectElevationRooms(upperGraph).filter(x => x.feature === RoomFeature.VOID) : [];
    const ownRooms = selectElevationRooms(graph)
      .filter(x => x.feature !== RoomFeature.VOID || !lowerGraph);
    const ownRoomIds = new Set(ownRooms.map(x => x.id));
    const voidByRoomId = new Map();
    const orphanVoids = [];
    for (const v of voidRoomsAbove) {
      const host = findOverlappingRoom(roomBounds(v.cells, upperGraph), graph, x => x.feature == null);
      if (host && ownRoomIds.has(host.id)) voidByRoomId.set(host.id, v); else orphanVoids.push(v);
    }
    const rooms = [...ownRooms, ...orphanVoids].sort((a, b) => (a.id < b.id ? -1 : 1));
    const stairByRoomId = new Map(graph.stairs.map(s => [s.roomId, s]));

    for (const room of rooms) {
      let kind = 'room';
      try {
        let band;
        if (room.feature === RoomFeature.STAIR) {
          kind = 'stair';
          band = buildStairBand(room, graph, upperGraph, { ...base, stair: stairByRoomId.get(room.id) ?? null });
        } else if (room.feature === RoomFeature.VOID) {
          kind = 'void';
          band = orphanVoids.includes(room)
            ? buildVoidBand(room, upperGraph, graph, { ...base, floorHeightBelowMm: floorHeightMm })
            : buildVoidBand(room, graph, lowerGraph,
              { ...base, floorHeightBelowMm: floorHeightBelow(project, graph.plane) });
        } else if (voidByRoomId.get(room.id)) {
          kind = 'voidAbove';
          band = buildRoomBandWithVoidAbove(room, graph, voidByRoomId.get(room.id), upperGraph,
            { ...base, floorHeightAboveMm: floorHeightMm, solids: { upperGraph, floorHeightMm } });
        } else {
          band = buildRoomBand(room, graph, { ...base, solids: { upperGraph, floorHeightMm } });
        }
        const prims = (band?.primitives ?? band ?? []).map(norm);
        rows.push({ room: room.id, name: room.name ?? null, kind, count: prims.length, prims });
      } catch (e) {
        rows.push({ room: room.id, name: room.name ?? null, kind, error: String(e.message) });
      }
    }
  };
  withGraphReadScope(graph, () => withGraphReadScope(upperGraph, () => withGraphReadScope(lowerGraph, run)));

  const name = p.name.replace(/[^\w一-龥ぁ-んァ-ヶー]/g, '_');
  fs.writeFileSync(path.join(outDir, `elevfig-${name}.json`), JSON.stringify(rows, null, 1));
  summary.push({ plane: p.name, rooms: rows.length,
    prims: rows.reduce((n, x) => n + (x.count ?? 0), 0), errors: rows.filter(x => x.error).length });
}
fs.writeFileSync(path.join(outDir, 'elevfig-summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
