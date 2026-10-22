/**
 * 天伏（見上げ）で描く建具の判定（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 *
 * 規則（ユーザー裁定 2026-10-22）:
 *   1. 建具は、その壁に定めた断面線（壁の切断高 ceilingCutResolverOf の wallCutAt）がまたぐ場合に限り描く。
 *      建具の位置の壁の切断高が、建具の下端と上端の間（両端を含む）にあるときだけ。
 *   2. 描かない建具の位置では壁を途切れさせない（建具の線・開きの記号・枠はどれも描かない。その位置も連なった壁）。
 *   3. 見下げ（平面など天伏以外）は変えない。
 *
 * 建具の下端・上端は切断高と同じ絶対 z（FL=0 基準・床段差込み）に揃える:
 *   下端＝壁の床面（resolver.wallFloorAt。床段差込み）＋窓台（窓は sillHeight ?? 0・窓以外は 0）。
 *   窓台・高さは展開図・断面と同じ規約。床面は天井のある側の低い方（床段差が違う 2 室の境では、展開図の面の部屋の床〔drawnFloorDeltaAt〕と基準が異なる）、
 *   上端＝下端＋effectiveHeight（未設定はカタログ既定）。
 * 建具の幅の範囲に沿って SAMPLE_FRACTIONS の位置で壁の切断高を引き、**どれか 1 点でも**下端〜上端に入れば描く
 * （幅の中で隣室が替わり切断高が変わる場合、断面線が建具のどこかをまたぐなら建具はある）。
 * 三方枠（FRAME_ONLY）・ガラリなど種類による特例は設けない（高さは種類ごとのカタログ既定で effectiveHeight が解く）。
 */
import { OpeningCategory } from '@core';
import { effectiveHeight } from '../openings/openingNumbering.js';

// 建具の幅に沿って壁の切断高を問う位置（幅の割合。端の点は部屋の矩形の辺に乗るので避け、内側の点で引く）
const SAMPLE_FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9];

/** 建具の下端の床からの高さ(mm)。窓は窓台高さ（未設定 0）・窓以外は 0。 */
function sillOf(opening) {
  return opening.category === OpeningCategory.WINDOW ? (opening.sillHeight ?? 0) : 0;
}

/**
 * 天伏で、この建具の位置に壁の断面線がまたぐか（＝描くか）。
 * @param {object} opening  axisCL・isVertical・coord1・coord2・category・sillHeight・height を持つ建具
 * @param {{wallCutAt: Function, wallFloorAt: Function}} resolver  ceilingCutResolverOf の返り値
 * @returns {boolean}
 */
export function openingCutVisible(opening, resolver) {
  const axis = opening.axisCL?.effectiveValue;
  if (!Number.isFinite(axis) || !Number.isFinite(opening.coord1) || !Number.isFinite(opening.coord2)) return true; // 位置が決まらない建具は従来どおり描く（隠す根拠が無い）
  const sill = sillOf(opening);
  const height = effectiveHeight(opening);
  for (const t of SAMPLE_FRACTIONS) {
    const along = opening.coord1 + (opening.coord2 - opening.coord1) * t;
    const cut = resolver.wallCutAt(opening.isVertical, axis, along);
    const bottom = resolver.wallFloorAt(opening.isVertical, axis, along) + sill;
    if (cut >= bottom && cut <= bottom + height) return true;
  }
  return false;
}

/**
 * 天伏で描かない建具の id の集合。
 * @param {{openings?: Iterable<object>}|null} graph
 * @param {{wallCutAt: Function, wallFloorAt: Function}} resolver
 * @returns {Set<string>}
 */
export function ceilingHiddenOpeningIds(graph, resolver) {
  const hidden = new Set();
  for (const o of graph?.openings ?? []) if (!openingCutVisible(o, resolver)) hidden.add(o.id);
  return hidden;
}
