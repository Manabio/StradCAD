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
export const DEFAULT_FACE_GAP_MM = 200;  // 面間隙間の仮値（倍率決定用の1パス目にのみ使う。QA点3参照）
export const DEFAULT_NAME_GAP_MM = 500;  // 部屋名枠の上余白の仮値（倍率決定用の1パス目にのみ使う。QA G5と同じ2パス方式）
export const BAND_GAP_MM         = 600;  // 帯（部屋）同士の縦の隙間
// 天井高寸法線・幅寸法線（壁芯間・通り芯間）を図から離す距離。ユーザー仕様「もっと離す」により
// 旧値(250/300/300)からおよそ2倍にした（バランスは実装者判断。項目3・4）。
export const CH_DIM_OFFSET_MM    = 500;  // 天井高寸法の先頭面境界CLからのオフセット
export const WALL_LABEL_GAP_MM       = 250; // 壁材2段書き: 天井線からのオフセット（openingElevationFigure.jsのat:-250方式）
export const WALL_LABEL_LINE_GAP_MM  = 150; // 壁材2段書き: 1段目と2段目の行間
export const DIM_ROW_GAP_MM      = 600;  // 床線→水平寸法列（壁芯間・通り芯間）までの距離
export const GRID_ROW_GAP_MM     = 600;  // 水平寸法列→通り芯丸の行までの距離
export const FACE_LABEL_GAP_MM   = 300;  // 通り芯丸の行→面ラベル(A/B/C/D)の行までの距離
export const FACE_LABEL_FONT_PX  = 13;   // 面ラベルの文字サイズ(px)

// 記号丸のスクリーン上サイズ(px)。ズームが存在しない展開モードでも常にこの見た目サイズになる
// （renderer/OpeningTagLayer.jsx の TAG_RADIUS_PX と同じ考え方）。
export const OPENING_TAG_RADIUS_PX = 16;
export const OPENING_TAG_FONT_PX   = 11;
export const GRID_TAG_RADIUS_PX    = 11;
export const GRID_TAG_FONT_PX      = 11;

// ---- 実画面mm基準（校正値 pxPerMm 換算）のスクリーン固定サイズ定数 ----
// 展開図の縮尺（倍率）は面のモデル実寸だけで決まるため、これらは常にモデルmmへ
// 換算してから配置する（screenMmToModelMm。elevationLayout.js）。
export const FACE_GAP_SCREEN_MM      = 30; // 隣接展開図の壁芯間隔（実画面mm）
export const TRIANGLE_HEIGHT_SCREEN_MM = 10; // 部屋範囲三角の高さ（実画面mm。レンダラ側でpx換算＝焼き込まない）
export const TRIANGLE_ANGLE_DEG      = 60;   // 底辺と斜辺のなす角
// 部屋名枠の上余白（実画面mm。QA G5）。通り芯丸のスクリーン固定半径(GRID_TAG_RADIUS_PX=11px
// ≒3mm相当)の下半分と部屋名枠が重ならないよう、余裕を見て10mmにする。
export const NAME_GAP_BELOW_SCREEN_MM = 10;
// 留め三角のアンカー位置オフセット（実画面mm。項目9）。TRIANGLE_HEIGHT_SCREEN_MMと違い、
// こちらは面の配置（leftAnchorX/rightAnchorX）というレイアウト量に効くため、高さのような
// render時px変換ではなくFACE_GAP_SCREEN_MMと同じ2パスmodelMm変換に乗せる
// （ElevationModeState.init参照）。
export const TRIANGLE_OFFSET_SCREEN_MM = 10;
export const DEFAULT_TRIANGLE_OFFSET_MM = 300; // 倍率決定用の1パス目の仮値（高さに影響しないため仮値でよい）
