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
// 旧値(250/300)からおよそ2倍にした（バランスは実装者判断。前回の項目3・4）。今回の調整項目1
// （「寸法線・寸法値・展開図を通り芯ラベルに近づける」）では、この「図本体と幅寸法線の離隔」
// （図と最も近い寸法行=DIM_ROW_GAP_MM）は前回の指示を尊重して戻し過ぎないよう据え置き、
// 詰める対象は寸法行〜通り芯丸行の間隔（GRID_ROW_GAP_MM）に絞った。
export const CH_DIM_OFFSET_MM    = 500;  // 天井高寸法の先頭面境界CLからのオフセット
export const WALL_LABEL_GAP_MM       = 250; // 壁材2段書き: 天井線からのオフセット（openingElevationFigure.jsのat:-250方式）
export const WALL_LABEL_LINE_GAP_MM  = 150; // 壁材2段書き: 1段目と2段目の行間
export const DIM_ROW_GAP_MM      = 600;  // 床線→水平寸法列（壁芯間・通り芯間）までの距離
// 水平寸法列(ROW1)→通り芯間寸法(ROW2)、ROW2→通り芯丸+面ラベルの行、までの距離。
// 調整項目1: 前回2倍にした600から、旧値(300)へ戻す方向で再調整した（「寸法線・寸法値・
// 展開図を通り芯ラベルに近づける」の主対象。DIM_ROW_GAP_MMは据え置き）。
export const GRID_ROW_GAP_MM     = 300;
export const FACE_LABEL_FONT_PX  = 13;   // 面ラベルの文字サイズ(px)
// 通り芯の一点鎖線を天井線より上へ突き出す量（調整項目3。「少し」なので小さめの値にする）。
export const GRID_LINE_ABOVE_CH_MM = 150;
// 帯の描画範囲の上端（天井線・通り芯突き出しの上）に確保する余白（調整項目4）。
// 通り芯突き出し(GRID_LINE_ABOVE_CH_MM)と桁を揃え、突き出した線の先端よりさらに上に
// 余白ができるようにする。
export const BAND_TOP_MARGIN_MM  = 150;

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

// 描画エリアの背景色（調整項目5）。index.css の `html, body, #root { background: #f5f5f0; }`
// （製図用紙色）を映す——Konva Stage自体は透明で背景は#root越しに見えているため、これが
// 実質的な「キャンバス背景色」。通り芯丸(circle)のfillに使い、丸の内側で通り芯の一点鎖線を
// 隠す（線より後に描く。circleがtag=建具記号丸とは別プリミティブである点に注意——建具丸は
// 意図的に背景透明のため、このCANVAS_BG_COLORでは塗らない）。
// QA A3: この値は index.css の `#root` の background と重複定義（1箇所に一本化できず2箇所
// 手動同期になる既知のトレードオフ。index.css側はCSSでJSの定数を参照できないため）。
// 値を変更するときは index.css の該当行も必ず一緒に更新すること。
export const CANVAS_BG_COLOR = '#f5f5f0';

// 面ラベル(A/B/C/D等)と通り芯丸番号の重なり回避（QA A1→B1/B3で改訂）。項目2で両者を同じ段(y)
// に統合したため、通り芯が面の壁芯間中心付近にある（偶数モジュールスパン等でよくある）と
// 面ラベルと通り芯丸が同座標で重なり両方判読不能になる。buildFaceFigure内（レンダラではなく
// 純関数側）で「面ラベルのx」と「各通り芯丸のcx」の距離がこの閾値以下なら退避させる
// （QA B1: 退避先は最広ギャップの中点方式のため、この閾値は「動かすか否か」の衝突判定にのみ
// 使い、退避先の座標計算には使わない——1段固定シフトと違い再チェック不要で決定的に衝突を解消する）。
//
// QA B3: 回避対象の通り芯丸はGRID_TAG_RADIUS_PX(=11px)というスクリーン固定サイズのため、
// 閾値もFACE_GAP_SCREEN_MM等と同じ2パス機構（screenMmToModelMm。ElevationModeState.init）で
// スクリーンmm基準から換算する（以前はモデルmm直書きの目安値だった）。buildFaceFigureはctx経由で
// 換算済みの値（ctx.faceLabelAvoidThresholdModelMm）を受け取り、未指定時はDEFAULT_…_MM（下記）
// にフォールバックする。
export const FACE_LABEL_AVOID_THRESHOLD_SCREEN_MM = 15; // 実画面mm（GRID_TAG_RADIUS_PX相当+余裕）
export const DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM = 400; // 倍率決定用の1パス目の仮値（衝突判定のみに使うためレイアウト高さに影響せず、仮値のままでよい）
