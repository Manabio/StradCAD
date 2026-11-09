import { SiteLineKind } from '../core/constants.js';

// 敷地図の線の描画規則（三斜 renderer/SiteLinesLayer.jsx・四角 renderer/SiteRectsLayer.jsx 共通）の
// 唯一の供給源。純モジュール（plain Node から import 可能）。
// 最外周＝境界線（一点鎖線・中線）／最外周以外＝細線／色はすべて黒／選択中は線幅を1段上げる。

export const SITE_LINE_COLOR = '#000000';

// 境界線（外周）の一点鎖線パターン（スクリーンpx。実線部・間・点・間）
export const SITE_BOUNDARY_DASH = Object.freeze([40, 4, 2, 4]);

// 境界線の交点・角の丸（スクリーンpx）
export const SITE_CORNER_MARK_RADIUS_PX = 6;
export const SITE_CORNER_MARK_WEIGHT = 'thin'; // viewport.lineWeightsPx のキー

// 敷地の当たり図形（三斜の線・四角の辺・基点の丸）に付ける Konva の name。
// pointerUp の空白判定が「敷地の図形を押したか」を見るために使う
export const SITE_HIT_NODE_NAME = 'site-hit';

// 線分の当たり判定幅（スクリーンpx）
export const HIT_PX_MAX = 12;

// hitStrokeWidth は線長・倍率に依らず固定の画面 px。strokeScaleEnabled=false の Line では
// Konva が hitStrokeWidth を画面 px として扱うため、実寸（/ scaleX）へ直してはならない。
// 線長で狭める案（隣接辺との誤選択防止）は、Konva が最前面1本を選ぶので効果が薄く、
// 短い線が選べなくなる副作用の方が大きいため固定にした。
export function lineHitWidth() {
  return HIT_PX_MAX;
}

// 線幅キー（viewport.lineWeightsPx のキー）。外周: medium（選択 thick）、内側: thin（選択 medium）
export function siteLineWeightKey(isBoundary, isSelected) {
  if (isBoundary) return isSelected ? 'thick' : 'medium';
  return isSelected ? 'medium' : 'thin';
}

// 線種の表示ラベル。外周 ∧ 道路 →「道路」、外周 ∧ それ以外 →「隣地」、内側 →「-」（切替不可）
export function siteLineKindLabel(isBoundary, kind) {
  if (!isBoundary) return '-';
  return kind === SiteLineKind.ROAD ? '道路' : '隣地';
}
