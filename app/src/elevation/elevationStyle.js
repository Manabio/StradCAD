/**
 * 展開図（室内展開図）の線種3段階・単一情報源。
 * 設計意図は .claude/elevation-model.md 参照。
 *
 * 展開モードにはズームが無い（固定倍率・viewport.scaleX/offsetXを変更しない）ため、
 * ズーム追従の resolveStrokeWidth（viewport.js）は使わず、校正値ベースの固定px
 * （viewport.lineWeightsPx）をそのまま使う。ultraThickは展開図では使わない。
 */

// 展開図の線の役割（3段階）。
//   CUT        … 切断面（床線・天井線・両端縦線など、部屋の輪郭そのもの）→ 太
//   SILHOUETTE … 空気と切れる線（開口内法・アキ矩形輪郭など）           → 中
//   DETAIL     … その他（通り芯・記号丸・アキの一点鎖線等）             → 細
export const ElevationLineRole = Object.freeze({
  CUT:        'cut',
  SILHOUETTE: 'silhouette',
  DETAIL:     'detail',
});

const WEIGHT_BY_ROLE = Object.freeze({
  [ElevationLineRole.CUT]:        'thick',
  [ElevationLineRole.SILHOUETTE]: 'medium',
  [ElevationLineRole.DETAIL]:     'thin',
});

/** role（ElevationLineRole の値）→ weight（'thick'|'medium'|'thin'）。未知roleは'thin'。 */
export function weightForRole(role) {
  return WEIGHT_BY_ROLE[role] ?? 'thin';
}

// 天井高寸法の左オフセット・アキ注記等、mm単位の描画定数（単一情報源）。
export const FACE_GAP_MM        = 200;  // 帯内で面同士を横に並べる際の隙間
export const BAND_GAP_MM        = 600;  // 帯（部屋）同士の縦の隙間
export const CH_DIM_OFFSET_MM   = 250;  // 天井高寸法の先頭面左端からのオフセット
export const GRID_TAG_DROP_MM   = 300;  // 通り芯丸番号: 床線から下へのはね出し量
export const WALL_LABEL_GAP_MM       = 250; // 壁材2段書き: 天井線からのオフセット（openingElevationFigure.jsのat:-250方式）
export const WALL_LABEL_LINE_GAP_MM  = 150; // 壁材2段書き: 1段目と2段目の行間

// 記号丸のスクリーン上サイズ(px)。ズームが存在しない展開モードでも常にこの見た目サイズになる
// （renderer/OpeningTagLayer.jsx の TAG_RADIUS_PX と同じ考え方）。
export const OPENING_TAG_RADIUS_PX = 16;
export const OPENING_TAG_FONT_PX   = 11;
export const GRID_TAG_RADIUS_PX    = 11;
export const GRID_TAG_FONT_PX      = 11;
