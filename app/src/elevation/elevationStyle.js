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
export const CH_DIM_OFFSET_MM    = 500;  // 天井高寸法の先頭面境界CLからのオフセット
export const WALL_LABEL_LINE_GAP_MM  = 150; // 壁材2段書き: 1段目と2段目の行間（項目4で天井線基準の
// オフセット(WALL_LABEL_GAP_MM)は廃止——位置は面中心(-CH/2)基準＋障害物退避に変更した）
// DIM_ROW_GAP_MM/GRID_ROW_GAP_MM（旧: モデルmm固定値）はQA D1/D2で廃止した。ROW1・ROW2・
// 通り芯丸+面ラベル行は全て、通り芯丸(GRID_TAG_RADIUS_PX=11px)・面ラベル(FACE_LABEL_FONT_PX=13px)
// というスクリーン固定サイズの要素を載せる行のため、床線→水平寸法列(ROW1)までの距離は
// DEFAULT_DIM_ROW_GAP_MM/DIM_ROW_GAP_SCREEN_MM、ROW1→ROW2・ROW2→丸行の距離は
// DEFAULT_GRID_ROW_GAP_MM/GRID_ROW_GAP_SCREEN_MMへ移した（下記「実画面mm基準」節参照。
// QA D1: 旧GRID_ROW_GAP_MM=300固定は1/50で通り芯丸(半径11px)がROW2寸法線に重なっていた）。
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

// 左三角(band.leftAnchorX)のさらに左に確保する画面余白（実画面mm。項目1）。TRIANGLE_OFFSET_SCREEN_MM
// と違い、これは帯のプリミティブ座標（leftAnchorX自体）には一切乗せない——純粋にビューポートの
// 横スクロール既定値・クランプ下限（ElevationModeState.faceOffsetFor/elevationLayout.js の
// clampFaceOffset）だけに効く画面表示上の余白のため、buildRoomBand/buildFaceFigureのctxには
// 通さない（band.leftAnchorX自体は従来どおり「天井高寸法線の外側」の位置を指し続ける）。
export const LEFT_MARGIN_SCREEN_MM = 15;

// 壁のない端部（隅に直交壁が無い面端。上り口・隣室への開放等）で床線・天井線を図の外側へ
// 延長する量（実画面mm。項目1。「続きがある」ことを示す建築表現）。tag等と同じくスクリーン
// 固定サイズの見た目を保つため2パス機構に乗せる。
export const WALL_LESS_END_EXTEND_SCREEN_MM = 5;
export const DEFAULT_WALL_LESS_END_EXTEND_MM = 150; // 倍率決定用の1パス目の仮値

// 展開図での腰壁天端の見付(mm)。実際の天端厚（finish/kneeDropWall.js の CAP_THICKNESS=30）の
// ままだと天端の2本線が縮尺で潰れて読めないため、**作図上だけ**広げて描く（ユーザー明示指示
// 2026-08「見付30のまま2本線だと見えないので50で書いて」）。モデルの寸法（天端の実厚・
// 腰壁高さ）はCAP_THICKNESS側のまま変えない——ここは見えがかりの表現専用の値。
export const KNEE_CAP_FACE_MM = 50;

/**
 * 腰壁の天端の帯の**下端**（床からの高さmm）。天端の上端は呼び出し側が既に描いている位置
 * （面図なら topHeight、断面エンジンなら band.z1）なので、ここは下端だけを答える。
 *
 * 帯が壁の高さに収まらない（天端が見付以下）の退化指定では **null** を返す——このガードを
 * 各所で書くと片方だけ抜けて床線の下へ線が出る。展開図側の唯一の情報源として集約する。
 * 消費者は **断面エンジンだけ**（section/sectionEmit.js の kneeCapUnderline・
 * appendKneeCapEndFaces）——腰壁の天端・端部は壁の実体に属する表現なので、面図側
 * （elevationFigure.js）は持たない。
 * @param {number} topMm 天端の高さ（その壁の足元からの相対値）
 * @returns {number|null}
 */
export function kneeCapBottomMm(topMm) {
  const bottom = topMm - KNEE_CAP_FACE_MM;
  return bottom > GAP_EPS_MM ? bottom : null;
}

// ---- 注記帯の行位置（実画面mm。QA C1→D1/D2で全面改訂） ----
// 建具記号丸(tag。半径16px)・通り芯丸(半径11px)・面ラベル(13px)は、どれもOPENING_TAG_RADIUS_PX/
// GRID_TAG_RADIUS_PX等というスクリーン固定サイズを持つ。これらを載せる行の位置をモデルmm定数の
// まま置くと、縮小側のスケール（例: 1/50・1/100）で床線・上下の寸法行に重なる（QA C1で建具タグ行
// を先に2パス化したが、QA D1でROW2→通り芯丸行の間隔=GRID_ROW_GAP_MM固定300mmが同じ欠陥を
// 抱えたまま残っていたことが発覚。1/50で6px・1/100で8px食い込みまで縮む実測あり）。そのため
// 注記帯の行位置は全てここに集約し、他のスクリーン固定要素と同じ2パス機構
// （screenMmToModelMm。ElevationModeState.init）でモデルmmへ換算する。
//
// QA D2: 「ROW1をタグ行の2倍として式で導出する」設計（QA C1で採用）は、値を機械的に押し上げ
// ユーザーが2回にわたり調整した見た目（ROW1=600mm・GRID_ROW_GAP=300mm、いずれもモデルmm固定
// 時代の値）を大きく踏み外した（1/20で600mm→30pxだった実測が、2倍導出後は105.8pxへ3.5倍化）。
// 各行はそれぞれ独立したスクリーンmm定数にし、下記の不変条件を満たす最小限の値のうち、
// 旧見た目（1/20想定）に最も近いものを選ぶ（既定校正値DEFAULT_PX_PER_MM≈3.78px/mmで換算）。
//   tag行:        床線からもROW1からも16px+余裕のクリアランス
//   ROW2→丸行:    11px+余裕のクリアランス
// 採用値と新旧pxの比較は .claude/elevation-model.md 参照。
export const OPENING_TAG_ROW_SCREEN_MM = 8;  // 床線→tag行。8mm×3.78≈30px（床から16px+14px余裕）
export const DEFAULT_OPENING_TAG_ROW_MM = 300; // 倍率決定用の1パス目の仮値（旧OPENING_TAG_ROW_Yと同値）
// 床線→ROW1（項目2で16→20に再修正）。ROW1の「線」自体だけでなく、線の上に載る寸法値テキスト
// （horizontalDimLabelBox。項目3でgapPxを半分にしたが、それでも線からgapPx+thicknessPx=15px
// ぶん床側=タグ行側へ張り出す）の上端がタグ丸の下端(tagRow_px+16px)と重ならないことまで含めて
// 判定する必要がある——16mmのままだと実測クリアランスが負（テキストがタグ丸に食い込む）。
// 20mm×3.78≈76pxなら、テキスト上端とタグ丸下端の間に約14pxの余裕が残る（既定校正値換算）。
export const DIM_ROW_GAP_SCREEN_MM = 20;
export const DEFAULT_DIM_ROW_GAP_MM = 600; // 倍率決定用の1パス目の仮値（旧DIM_ROW_GAP_MMと同値）
export const GRID_ROW_GAP_SCREEN_MM = 6; // ROW1→ROW2、ROW2→通り芯丸+面ラベル行の共通ギャップ。
// 6mm×3.78≈23px（通り芯丸の半径11px+12px余裕）
export const DEFAULT_GRID_ROW_GAP_MM = 300; // 倍率決定用の1パス目の仮値（旧GRID_ROW_GAP_MMと同値）

// 寸法線の足（CH寸法の引出線）を壁中心線から離す量（実画面mm。ユーザー明示指示2026-08その13
// 「展開図の寸法線の足：CLから画面上実寸3mmぐらい離す（展開図で統一）」）。足はCLに触れず、
// CLの手前で止める——階段展開図で「反対側のCLまで伸ばさない」もこの規則で自動的に満たされる
// （足の終点は必ずその寸法自身の側のCLの手前になるため）。他の実画面mm量と同じ2パス換算に乗せる。
export const DIM_FOOT_GAP_SCREEN_MM = 3;
export const DEFAULT_DIM_FOOT_GAP_MM = 90; // 倍率決定用の1パス目の仮値（WALL_LESS_END_EXTENDと同率）

// 描画エリアの背景色（調整項目5）。通り芯丸(circle)のfillに使い、丸の内側で通り芯の一点鎖線を
// 隠す（線より後に描く。circleがtag=建具記号丸とは別プリミティブである点に注意——建具丸は
// 意図的に背景透明のため、このCANVAS_BG_COLORでは塗らない）。
// QA I2: 定義本体はrenderer/canvasStyle.js（展開モード以外からも参照する汎用値のため。
// index.cssとの同期コメントもそちら参照）。ここでは既存参照（elevationFigure.js等）を
// 壊さないようre-exportするだけ。
export { CANVAS_BG_COLOR } from '../renderer/canvasStyle.js';

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

// 新仕様「ROW1寸法のCL分割」: 分割点候補の併合・boundary端との同一視の許容差(mm)。
// 浮動小数の丸め程度を吸収する目的の小さな値（elevationDimSplit.jsのcollectRow1SplitPoints）。
export const SPLIT_MERGE_EPS_MM = 1;

// R4: 幾何epsilonの一元定義（旧: elevationOpenSpan.js・elevationStepFace.js・
// elevationFloorProfile.jsにそれぞれ個別定義されていた）。
// GAP_EPS_MM  … CL昇格/降格・再スナップ由来のsub-micron誤差や、物理的に意味を持たない極小幅の
//               区間を吸収・除去するための許容差。
// PROBE_EPS_MM… セル境界・輪郭線分を挟んで反対側（near/far、内側/外側）の所有Roomを1点プローブ
//               で判定する際の覗き込み距離(mm)。
export const GAP_EPS_MM   = 1e-6;
export const PROBE_EPS_MM = 5;

// QA修正（幅0の展開図バグ）: composeRoomFacesの最終段で、run（面の実効幅）がこの値未満の面を
// 除去する安全網（elevationFaceList.js）。段差見付け面の隅スナップ・袖壁分割の境界計算等、
// 個別の生成経路をそれぞれ堅牢化した上でも、未知の経路から幅0・極小幅の面が漏れ出た場合に
// 展開図へ実際に描画されてしまう最後の砦として置く。1mm未満は図面上「幅がある」とは呼べない
// 実務上の下限値。
export const MIN_FACE_RUN_MM = 1;
