// 展開図の帯プリミティブを部屋ごとにダンプする共有関数（調査用。製品コードから参照しない。lint 対象〔node globals〕）。
// dumpElevFigure.mjs（保存済み／--regen の壁で描く回帰基準）と viewEntryProbe.mjs（展開突入境界の後の帯）が
// 同じ振り分けを使うために切り出した。
//
// 部屋ごとの帯ビルダーの振り分けは modes/ElevationModeState.js の `buildOne` を写す
// ——階段室は buildStairBand・吹抜けは buildVoidBand・上部吹抜けを持つ部屋は
// buildRoomBandWithVoidAbove を通る。全部屋を buildRoomBand で作ると**実機が通らない経路**を
// 比較してしまい、階段室（例: 11.stq 1階の「6」）の差分を取り逃がす。
import { RoomFeature, CenterLine, centerLineKind } from '../../src/core.js';
import { buildRoomBand } from '../../src/elevation/elevationBand.js';
import { memberLayersOf, underStairSoffitsOf } from '../../src/elevation/elevationSolids.js';
import { buildStairBand } from '../../src/elevation/elevationStair.js';
import { buildVoidBand, buildRoomBandWithVoidAbove, findOverlappingRoom } from '../../src/elevation/elevationVoid.js';
import { selectElevationRooms } from '../../src/elevation/elevationFaces.js';
import { roomBounds } from '../../src/finish/gridCells.js';
import { floorHeightAbove, floorHeightBelow } from '../../src/finish/stair/stairDimensions.js';
import { collectGridCLs } from '../../src/elevation/elevationPrimitives.js';
import { withGraphReadScope } from '../../src/graphReadScope.js';

const r = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);

// プリミティブを比較しやすい安定した形へ（数値は丸め、キー順を固定）。
export function norm(p) {
  if (Array.isArray(p)) return p.map(x => (x && typeof x === 'object' ? norm(x) : r(x)));
  const out = {};
  for (const k of Object.keys(p).sort()) {
    const v = p[k];
    out[k] = (v && typeof v === 'object') ? norm(v) : r(v);
  }
  if (p.type === 'arc') {
    // 円弧は始点・終点の座標も載せる（golden で端の取り合いを比べられるように。中心・半径・角度から導出）
    const rad = d => (d * Math.PI) / 180;
    const a1 = rad(p.startDeg), a2 = rad(p.startDeg + p.sweepDeg);
    out.x1 = r(p.cx + p.r * Math.cos(a1)); out.y1 = r(p.cy + p.r * Math.sin(a1));
    out.x2 = r(p.cx + p.r * Math.cos(a2)); out.y2 = r(p.cy + p.r * Math.sin(a2));
  }
  return out;
}

/**
 * 1階ぶんの全部屋の帯を作り、{ room, name, kind, count, prims | error } の配列で返す。
 * @param {object} project
 * @param {object} graph 対象階
 * @param {object|null} upperGraph 直上階（無ければ null）
 * @param {object|null} lowerGraph 直下階（無ければ null）
 */
export function dumpFloorBands(project, graph, upperGraph, lowerGraph) {
  const rows = [];
  const run = () => {
    const gridCLs = collectGridCLs(graph);
    let floorHeightMm;
    try { floorHeightMm = floorHeightAbove(project, graph.plane); } catch { floorHeightMm = null; }
    const base = { project, materialMap: new Map(), gridCLs };
    // ElevationModeState と同じ: 梁・柱の候補の層（memberLayers）は全部屋で 1 つの配列を共有する（部屋ごとに作ると立体を作り直す）
    // 自階の「仕上げ」の階段の裏面（階段下の部屋の帯の天井を頭打ちにする。ElevationModeState と同じ値）
    const solids = {
      upperGraph, floorHeightMm, memberLayers: memberLayersOf(graph, { upperGraph, floorHeightMm }),
      underStairSoffits: underStairSoffitsOf(graph, { upperGraph, floorHeightMm }),
    };

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
          band = buildStairBand(room, graph, upperGraph, { ...base, stair: stairByRoomId.get(room.id) ?? null, lowerGraph });
        } else if (room.feature === RoomFeature.VOID) {
          kind = 'void';
          band = orphanVoids.includes(room)
            ? buildVoidBand(room, upperGraph, graph, { ...base, floorHeightBelowMm: floorHeightMm })
            : buildVoidBand(room, graph, lowerGraph,
              { ...base, floorHeightBelowMm: floorHeightBelow(project, graph.plane) });
        } else if (voidByRoomId.get(room.id)) {
          kind = 'voidAbove';
          band = buildRoomBandWithVoidAbove(room, graph, voidByRoomId.get(room.id), upperGraph,
            { ...base, floorHeightAboveMm: floorHeightMm, solids });
        } else {
          band = buildRoomBand(room, graph, { ...base, solids });
        }
        const prims = (band?.primitives ?? band ?? []).map(norm);
        rows.push({ room: room.id, name: room.name ?? null, kind, count: prims.length, prims });
      } catch (e) {
        rows.push({ room: room.id, name: room.name ?? null, kind, error: String(e.message) });
      }
    }
  };
  withGraphReadScope(graph, () => withGraphReadScope(upperGraph, () => withGraphReadScope(lowerGraph, run)));
  return rows;
}

// ---- --move=<CL id|label|auto>:<mm> の共有実装（dumpElevFigure.mjs・viewEntryProbe.mjs） ----
// 本番の移動確定と同じ commitCLMoveOp（transform/centerLineOps.js。pendingDelta に変位を置いて確定）を使う。
// 構造同期リスナー（setCenterLineStructuralListener）は登録しない＝移動確定が起動する構造再計算は走らない
// （壁・柱・梁は展開突入境界／--regen が再生成するので、それを測る本 probe では未同期のままが目的）。
// 対象: key が 'auto' なら finishCellDividers（壁の鮮度の入力になる線）のうち structGraph の通り芯で refId 無しの先頭。
//       それ以外は id または label が一致する CL（全階の graph.centerLines から先頭）。
import { runInAction } from 'mobx';
import { commitCLMoveOp } from '../../src/transform/centerLineOps.js';
import { finishCellDividers } from '../../src/core/centerLineKindPolicy.js';

export function parseMoveSpec(spec) {
  const i = spec.lastIndexOf(':');
  const mm = Number(spec.slice(i + 1));
  if (i <= 0 || !Number.isFinite(mm)) throw new Error(`--move=<CL id|label|auto>:<mm> の形で指定してください（指定値: ${spec}）`);
  return { key: spec.slice(0, i), mm };
}

export function moveCenterLine(project, spec) {
  const { key, mm } = parseMoveSpec(spec);
  let found = null;
  // 他階の graph が clearFloorData 済みのこと（実アプリの状態）があるので、アクティブ階を先に探す。
  const graphs = [project.activeGraph, ...project.graphMap.values()].filter(Boolean);
  for (const g of graphs) {
    if (key === 'auto') {
      const c = finishCellDividers(g).find(x => project.structGraph.shapeMap.has(x.id) && !x.refId);
      if (c) { found = { graph: g, cl: c }; break; }
    } else {
      const c = g.centerLines.find(x => x.id === key || x.label === key);
      if (c) { found = { graph: g, cl: c }; break; }
    }
  }
  if (!found) throw new Error(`移動対象の CL が見つかりません: ${key}`);
  const { graph, cl } = found;
  const from = cl.effectiveValue;
  runInAction(() => { cl.pendingDelta = mm; });
  commitCLMoveOp(graph, project, cl, from);
  return { graph, cl, from, to: cl.value };
}

// ---- 柱・梁の差を切り分けるための除去（--strip-struct。dumpElevFigure.mjs・viewEntryProbe.mjs） ----
// 突入境界は構造再計算（recomputeActiveStructural＝柱・梁の再生成）まで行うが、dumpElevFigure --regen は
// 壁の再生成までなので、帯の差の一部は柱・梁（壁の内の柱型・梁断面）に由来しうる。両側から柱・梁を除いて
// 比べ、差が消えれば「差は柱・梁だけ」、残れば壁・隔て壁・2a などに由来すると切り分けられる。
// 梁芯（centerLineKind==='beam' の CL。構造再計算が生成し、--regen には無い）も除く。
export function stripStructuralMembers(graph) {
  if (!graph) return;
  runInAction(() => {
    graph.columnMap.clear();
    graph.beamMap.clear();
    for (const [id, s] of [...graph.shapeMap]) if (s instanceof CenterLine && centerLineKind(s) === 'beam') graph.shapeMap.delete(id);
  });
}
