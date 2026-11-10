/**
 * 配置指定の頂点（敷地座標の角）の一致判定の純モジュール。
 * schema/graphFbs.js（保存）・modes/SiteModeState.js・site/sitePlacementView.js が共用する。
 * store.js・snap.js・.jsx・storage を静的に import しない（node:test から単体で import できる）。
 */
import { SITE_PLACEMENT_VERTEX_EPS_MM } from '../core/constants.js';

/** 配置指定の頂点どうしが同じ角か（SITE_PLACEMENT_VERTEX_EPS_MM 以内。どちらかが null なら false）。判定の唯一の口。 */
export function samePlacementVertex(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= SITE_PLACEMENT_VERTEX_EPS_MM && Math.abs(a.y - b.y) <= SITE_PLACEMENT_VERTEX_EPS_MM;
}

/**
 * 2 対目の頂点1（共有点）が 1 対目のどちらの頂点と一致するか。1 対目の頂点1 なら 1・頂点2 なら 2・どちらでもなければ null
 * （1 対目の頂点1 が優先）。input は { v1, v2, along: { v1 }|null }（メモリ上の入力・保存値の input のどちらも可）。
 */
export function alongSharedVertex(input) {
  const shared = input?.along?.v1;
  if (samePlacementVertex(input?.v1, shared)) return 1;
  if (samePlacementVertex(input?.v2, shared)) return 2;
  return null;
}
