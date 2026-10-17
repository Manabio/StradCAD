/**
 * 天伏（見上げ）の切断高の解決（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。唯一の供給源。
 *
 * 規則（ユーザー裁定 2026-10-18）: 1 階＝1 天伏。切断高は階の 1 値（baseCutMm＝ceilingCutHeightMmOf(plane)。「最も多くの天井面を描ける高さ」を
 * ユーザーが指定する）を基本とし、その高さでは**部屋の天井面全体を描けない部屋**（天井面の最低点 minCeilingZ が baseCutMm 以下＝階段下・
 * 踊り場下など極端に天井が低い部屋）に限り、その部屋の切断高だけを天井面の直下へ下げる。1 天伏に複数の切断高が存在しうるが、
 * 部屋ごとに自由に違うわけではない（例外は「基本の高さでは天井面が切れる部屋」だけ）。
 *
 * 天井面の最低点は、天伏の立体（plan/planSolids.js ceilingSolids）と同じ ceilingShapeSolidZ の zLo（flat＝zMm、sloped/arc/dome＝基準高 baseZ＝最低点）。
 * 床段差込みの絶対 z（FL=0 基準）。部屋の全ての面（残り＋天井区画）の最小。
 * 例外の切断高 cutMm＝minCeilingZ − 分類の許容（plan/planSectionFigure.js DEFAULT_EPS_MM）。見上げの鏡像で天井面が「切断面のすぐ下に見える」側に入る。
 * 天井面を持たない所（吹抜け・屋外・階段吹抜け STAIR_VOID の平らな面・索引外のセル）は baseCutMm。
 *
 * 例外の部屋の切断高の違いを図に示す注記は出さない（未裁定）。exceptions を返すだけ。
 */
import { ceilingCutHeightMmOf, RoomFeature } from '@core';
import { buildCeilingHeightField } from './ceilingHeightField.js';
import { ceilingShapeSolidZ } from './ceilingShape.js';
import { DEFAULT_EPS_MM } from '../plan/planSectionFigure.js';

/**
 * @param {object|null} graph  null は例外なし（基本の高さだけ）
 * @param {{baseCutMm?: number}} [opts]  baseCutMm＝基本の切断高。省略は ceilingCutHeightMmOf(graph?.plane)
 * @returns {{
 *   baseCutMm: number,
 *   roomCutMm: Map<string, number>,
 *   exceptions: Array<{roomId: string, minCeilingZ: number, cutMm: number}>,
 *   cutZAt: (x: number, y: number) => number,
 *   range: {min: number, max: number},
 * }}  roomCutMm＝例外の部屋だけ。range＝cutZAt の取りうる範囲（例外なしは min=max=baseCutMm）
 */
export function ceilingCutResolverOf(graph, opts = {}) {
  const baseCutMm = Number.isFinite(opts.baseCutMm) ? opts.baseCutMm : ceilingCutHeightMmOf(graph?.plane);
  const field = buildCeilingHeightField(graph);
  const minZByRoom = new Map(); // 部屋 id → 全ての面の天井面の最低点
  for (const s of field.surfaces) {
    if (graph.roomMap.get(s.roomId)?.feature === RoomFeature.STAIR_VOID) continue; // 階段吹抜けの面は基本の高さ
    const z = ceilingShapeSolidZ({ shape: s.shape, dims: s.dims, baseZ: s.zMm, rects: s.rects }).zLo;
    if (!Number.isFinite(z)) continue;
    minZByRoom.set(s.roomId, Math.min(minZByRoom.get(s.roomId) ?? Infinity, z));
  }
  const roomCutMm = new Map();
  const exceptions = [];
  for (const [roomId, minCeilingZ] of minZByRoom) {
    if (minCeilingZ > baseCutMm - DEFAULT_EPS_MM) continue; // ちょうど基本の高さの平らな天井は数値の切断高でも描ける
    const cutMm = minCeilingZ - DEFAULT_EPS_MM;
    roomCutMm.set(roomId, cutMm);
    exceptions.push({ roomId, minCeilingZ, cutMm });
  }
  const cutZAt = roomCutMm.size === 0
    ? () => baseCutMm
    : (x, y) => {
      const surface = field.surfaceAt(x, y);
      return surface ? (roomCutMm.get(surface.roomId) ?? baseCutMm) : baseCutMm;
    };
  const range = { min: Math.min(baseCutMm, ...roomCutMm.values()), max: baseCutMm };
  return { baseCutMm, roomCutMm, exceptions, cutZAt, range };
}
