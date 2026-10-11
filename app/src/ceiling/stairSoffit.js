/**
 * 階段の裏面（天伏の見上げ。S13a。純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * N 階の天伏で、N の階段の足元の上にある N+1 階の階段（N の続き）を裏から見た姿のうち、**木造階段の傾斜天井**の立体を作る。
 * 階段裏に天井材仕上げがあるので踏面線は描かず、傾斜する天井面（kind 'ceiling'＝面材として遮蔽に参加）だけを返す。
 * 鉄骨階段は踏面線を全段描く（planSolids の stairTread を drawEdges:true にする側）ので、ここでは [] を返す。
 *
 * 高さは層の FL（N+1 の FL = floorZMm）基準の絶対 z。段 k の天端 = floorZMm + k × 蹴上（stairTreadFootprints と同じ）。
 * 裏面 = 天端 − dz。dz = STAIR_SOFFIT_THICKNESS_MM / cosθ（階段の傾斜に直交して測った厚みの垂直方向への換算。tanθ = 蹴上 / 踏面）。
 *   往路   … 上り口 baseA で「当該階天井」（N の階段の対の部屋の CH＋床段差。N の FL 基準の値で floorZMm は足さない。
 *            対の部屋が無ければ DEFAULT_ROOM_CEILING_HEIGHT）→ 往路側の前縁 frontA で 回転部の最初の段の天端 − dz。
 *   回転部 … マスごとの平らな面（番号 n の天端 − dz）。回り段は扇形ごとの面なので面の輪郭が折れ線になる。
 *            踊り場（SWITCHBACK）は 1 マスの平らな面で折れ線なし。面どうしは 1 蹴上の段差で接する。
 *   復路   … 前縁 front で 最後の回転部マスの天端 − dz → 到達辺 baseB で 総蹴上の天端 − dz。
 *   直進系 … STRAIGHT は base → end、STRAIGHT_LANDING は 直進部1 → 踊り場（平ら）→ 直進部2。
 * 既知の限界: 取りつき回転部（側面の出入口）を往路の平面に含める／L_TURN・FLARED・OPEN_WELL・蹴上が求まらない階段は裏面なし。
 */
import { StairType, StructuralMaterialType, DEFAULT_ROOM_CEILING_HEIGHT } from '@core';
import { STAIR_SOFFIT_THICKNESS_MM } from '../core/constants.js'; // 公開 API（core.js）には出さない内部定数
import { uTurnPlanLayout, straightPlanLayout } from '../finish/stair/stairGeometry.js';
import { stairTreadFootprints } from '../finish/stair/stairTreads.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';

const MIN_SPAN_MM = 1; // 矩形の辺の下限（これ未満は潰れた区間として作らない）

/**
 * 当該階天井（N の FL 基準の mm）: N の階段の対の部屋の CH＋床段差。対の部屋が無ければ既定の天井高。
 * 床段差＋CH の式は ceiling/ceilingSurfaces.js と同じ（共通化は別件）。
 */
export function stairBelowCeilingMm(belowStair, belowGraph) {
  const room = belowStair?.roomId != null ? belowGraph?.rooms?.find(r => r.id === belowStair.roomId) : null;
  if (!room || !belowGraph) return DEFAULT_ROOM_CEILING_HEIGHT;
  const floorStep = belowGraph.effectiveFloorLevel(room) - belowGraph.effectiveFloorLevel(null);
  return roomCeilingHeight(belowGraph, room).mm + floorStep;
}

/**
 * 走行軸 [r0, r1]（世界座標。向きは任意）に沿って z0 → z1 と線形に変わる矩形の立体。run 軸が y（vertical）か x かは vertical で決める。
 * across は [a0, a1]（順不同）。区間が潰れていれば null。
 */
function rampSolid({ vertical, r0, r1, a0, a1, z0, z1 }) {
  if (![r0, r1, a0, a1, z0, z1].every(Number.isFinite)) return null;
  if (Math.abs(r1 - r0) < MIN_SPAN_MM || Math.abs(a1 - a0) < MIN_SPAN_MM) return null;
  const rLo = Math.min(r0, r1), rHi = Math.max(r0, r1), aLo = Math.min(a0, a1), aHi = Math.max(a0, a1);
  const rect = vertical ? { x1: aLo, y1: rLo, x2: aHi, y2: rHi } : { x1: rLo, y1: aLo, x2: rHi, y2: aHi };
  const solid = { footprint: { rects: [rect] }, zLo: Math.min(z0, z1), zHi: Math.max(z0, z1) };
  if (z0 !== z1) {
    solid.zAt = (x, y) => {
      const t = Math.min(Math.max(((vertical ? y : x) - r0) / (r1 - r0), 0), 1);
      return z0 + (z1 - z0) * t;
    };
  }
  return solid;
}

function uTurnParts(stair, graph, ctx) {
  const L = uTurnPlanLayout(stair, graph);
  if (!L) return null;
  const { zTop, zStart } = ctx;
  const { run, across, vertical } = L;
  const lastTurn = L.firstTurnNumber + L.turnCells - 1;
  const parts = [
    rampSolid({ vertical, r0: run.baseA, r1: run.frontA, a0: across.s0, a1: across.sA, z0: zStart, z1: zTop(L.firstTurnNumber) }),
  ];
  for (const t of stairTreadFootprints(stair, graph, { riser: ctx.riser, insetView: 'upper' })) {
    if (t.number < L.firstTurnNumber || t.number > lastTurn) continue;
    const z = zTop(t.number);
    parts.push({ footprint: { poly: t.poly }, zLo: z, zHi: z });
  }
  parts.push(rampSolid({ vertical, r0: run.front, r1: run.baseB, a0: across.sB, a1: across.s1, z0: zTop(lastTurn), z1: zTop(L.totalSteps) }));
  return parts;
}

function straightParts(stair, graph, ctx) {
  const L = straightPlanLayout(stair, graph);
  if (!L) return null;
  const { zTop, zStart } = ctx;
  const { run, across, vertical } = L;
  const seg = (r0, r1, z0, z1) => rampSolid({ vertical, r0, r1, a0: across.s0, a1: across.s1, z0, z1 });
  if (!L.hasLanding) return [seg(run.base, run.end, zStart, zTop(L.totalSteps))];
  const zLand = zTop(L.landingNumber);
  return [
    seg(run.base, run.land1, zStart, zLand),
    seg(run.land1, run.land2, zLand, zLand),
    seg(run.land2, run.end, zLand, zTop(L.totalSteps)),
  ];
}

/**
 * N+1 の階段（木造）の裏面の立体。対象外（鉄骨・L_TURN 等・蹴上や踏面が求まらない・レイアウトが null）は []。
 * @param {{
 *   stair: object, graph: object,        N+1 の階段とその階の graph
 *   belowStair?: object|null, belowGraph?: object|null,  N 側の対の階段と graph（当該階天井の算出）
 *   riser: number|null, floorZMm: number  蹴上と N+1 の FL（層の絶対 z）
 * }} args
 * @returns {import('../plan/planSolids.js').Solid[]}
 */
export function stairSoffitSolids({ stair, graph, belowStair = null, belowGraph = null, riser, floorZMm }) {
  if (!stair || !graph || !Number.isFinite(floorZMm)) return [];
  if (stair.structure !== StructuralMaterialType.WOOD) return [];
  if (!(Number.isFinite(riser) && riser > 0) || !(Number.isFinite(stair.tread) && stair.tread > 0)) return [];
  const dz = STAIR_SOFFIT_THICKNESS_MM * Math.sqrt(1 + (riser / stair.tread) ** 2); // 厚み / cosθ
  const ctx = {
    riser,
    zStart: stairBelowCeilingMm(belowStair, belowGraph),
    zTop: n => floorZMm + n * riser - dz,
  };
  const t = stair.type;
  const parts = t === StairType.SWITCHBACK || t === StairType.WINDING ? uTurnParts(stair, graph, ctx)
    : t === StairType.STRAIGHT || t === StairType.STRAIGHT_LANDING ? straightParts(stair, graph, ctx) : null;
  if (!parts) return [];
  return parts.filter(Boolean).map((p, part) => ({
    kind: 'ceiling', ...p,
    source: { kind: 'stairSoffit', id: String(stair.id), layerFloorZ: floorZMm, part },
  }));
}
