/**
 * 展開図: 固定倍率決定・帯（部屋）レイアウト・クランプスクロール・mm→px変換器（純関数群）。
 * 設計意図は .claude/elevation-model.md 参照。
 *
 * 展開モードにはズームが無いため、倍率は画面高さだけで決める（横幅は問わない）。
 * 縦（部屋帯）・横（面）ともクランプスクロール（循環しない。ユーザー指示により循環スクロールは廃止）。
 */
import { chooseScale } from '../structural/sectionFigure/sectionGeometry.js';
import { BAND_GAP_MM } from './elevationStyle.js';

// 画面高さに何段分の帯を収めるかの目安（縮尺決定の基準）。
const VISIBLE_BANDS = 2.2;

/**
 * 帯群の中でもっとも背の高い帯が画面に収まるよう、建築標準スケール(px/mm)を選ぶ。
 * bands=[] のときは NICE_SCALES 内の妥当な既定値を返す（chooseScale(0,0,...)と同じ扱い）。
 * @param {Array<{heightMm:number}>} bands
 * @param {{width:number, height:number}} viewSize
 * @returns {number} px/mm
 */
export function chooseElevationScale(bands, { height }) {
  const tallestMm = bands.reduce((max, b) => Math.max(max, b.heightMm), 0);
  const budgetPx = height / VISIBLE_BANDS;
  return chooseScale(0, tallestMm, Infinity, budgetPx);
}

/**
 * 実画面mm（校正値ベース、ズーム非依存）をモデルmmへ換算する。
 * 展開図の倍率(scale)は面のモデル実寸（高さ）だけで決まるため、この換算は倍率が
 * 確定した後に行うこと——先に確定させてから使う側（ElevationModeState.init）が
 * 「1パス目=倍率決定用の仮ギャップで帯を組む→倍率確定→2パス目=このscaleで実ギャップを
 * 換算して帯を組み直す」という2段階の構成にすることで、倍率決定とギャップ換算の間の
 * 循環参照を避ける（ユーザー指示の注意点）。
 * @param {number} screenMm - 実画面上の物理mm
 * @param {number} screenPxPerMm - 校正値（viewport.pxPerMmX/Yの平均等。物理mm→px）
 * @param {number} scale - 展開図の倍率（モデルmm→px）
 * @returns {number} モデルmm
 */
export function screenMmToModelMm(screenMm, screenPxPerMm, scale) {
  if (!(scale > 0)) return 0;
  return (screenMm * screenPxPerMm) / scale;
}

/**
 * 帯群を縦に積んだレイアウト（帯間 BAND_GAP_MM）。
 * contentHeightMm は最後の帯の下端（帯間の余白は含まない）——循環スクロールを廃止したため、
 * 末尾の帯間ぶんの余白をスクロール可能範囲に含める理由が無い。
 *
 * b.topMarginMm（省略時0）は、この帯を置く直前に追加で空ける距離（QA A2）。
 * FL高さ差（floorOffset）のある部屋は、bounds.minY自体は変えずに（変えるとbandContentOriginMm
 * 経由でfloorOffsetの見た目効果が打ち消される。elevationBand.js/elevationStair.jsのQA A2
 * コメント参照）、この帯自身の上端がfloorOffsetぶん上へせり出しうる——topMarginMmでその分だけ
 * 手前の帯との間を追加で空けることで、bounds.minYには一切触れずに重なりを防ぐ
 * （b.heightMmへの加算＝この帯自身が下へせり出す分の対策と対になる。両方ともQA A2）。
 * @param {Array<{roomId:string, heightMm:number, topMarginMm?:number}>} bands
 * @param {number} [gapMm]
 * @returns {{placements:Array<{roomId:string, topMm:number, heightMm:number}>, contentHeightMm:number}}
 */
export function layoutBands(bands, gapMm = BAND_GAP_MM) {
  const placements = [];
  let top = 0;
  for (const b of bands) {
    const topMm = top + (b.topMarginMm ?? 0);
    placements.push({ roomId: b.roomId, topMm, heightMm: b.heightMm });
    top = topMm + b.heightMm + gapMm;
  }
  const last = placements[placements.length - 1];
  const contentHeightMm = last ? last.topMm + last.heightMm : 0;
  return { placements, contentHeightMm };
}

/**
 * 縦スクロール scrollYMm を有効範囲へクランプする（循環しない）。
 * 上端=0（最初の帯の天部が画面上端）、下端=contentHeightMm-viewHeightMm（最後の帯の底部が
 * 画面下端）。全帯が画面に収まる場合（contentHeightMm<=viewHeightMm）はクランプ範囲が
 * [0,0]に潰れ、スクロール不要になる。
 * @param {number} scrollYMm
 * @param {ReturnType<typeof layoutBands>} layout
 * @param {number} viewHeightMm
 */
export function clampScrollY(scrollYMm, layout, viewHeightMm) {
  const maxScroll = Math.max(0, layout.contentHeightMm - viewHeightMm);
  return Math.min(Math.max(scrollYMm, 0), maxScroll);
}

/**
 * 縦スクロール scrollYMm・画面高さ viewHeightMm に対し、画面内に現れる帯の配置一覧を返す
 * （循環なし。呼び出し側が clampScrollY で正規化済みの scrollYMm を渡す想定だが、
 * 未クランプの値を渡しても単に画面外へ出るだけで例外にはならない）。
 * @param {ReturnType<typeof layoutBands>} layout
 * @param {number} scrollYMm
 * @param {number} viewHeightMm
 * @returns {Array<{roomId:string, topMm:number, heightMm:number}>}
 */
export function visibleBandPlacements(layout, scrollYMm, viewHeightMm) {
  const out = [];
  for (const p of layout.placements) {
    const top = p.topMm - scrollYMm;
    if (top + p.heightMm > 0 && top < viewHeightMm) {
      out.push({ roomId: p.roomId, topMm: top, heightMm: p.heightMm });
    }
  }
  return out;
}

/** 画面上のy座標(mm、描画エリア原点基準)がどの帯に属するかを返す（無ければ null）。循環なし。 */
export function bandIdAtY(layout, scrollYMm, yMm) {
  const localY = yMm + scrollYMm;
  for (const p of layout.placements) {
    if (localY >= p.topMm && localY < p.topMm + p.heightMm) return p.roomId;
  }
  return null;
}

/**
 * 帯の水平スクロール offsetMm を有効範囲へクランプする（循環しない）。
 * 帯の実測 bounds（minX/maxX）を基準にする——bounds.minX は 0 ではない（天井高寸法が
 * face[0]の左端よりさらに左＝負のmmへ張り出すため。QA F9: 旧実装は[0,widthMm]を仮定しており、
 * 帯が画面より広いとoffsetMmが0未満へ絶対に動けず、天井高寸法が常に画面外に切れていた）。
 * 単一のクランプ式 [minX, max(minX, maxX-viewWidthMm)] に統合する（QA F1: 項目10「左三角揃え」
 * のため、旧実装が持っていた「収まる帯は中央寄せの1点に固定」という別分岐（旧F9）は廃止した——
 * その分岐は offsetMm（=faceOffsetForが渡すband.leftAnchorX＝左三角の位置）を握りつぶし、
 * 画面に収まる帯（トイレ等の小部屋で頻出）だけ左三角が中央寄せ位置へズレて全帯の左揃えが崩れて
 * いた）。帯が画面に収まる場合はレンジが[minX,minX]に潰れ、常にminX（=左三角の位置。
 * band.leftAnchorXがminXと一致するよう組み立てられている）を返すため、結果的に全帯が左揃えになる。
 * 帯が画面より広い場合の挙動は変更していない。
 *
 * marginMm（省略時0。項目1）は下限側にのみ効く「左三角のさらに左に確保する余白」——
 * minX（=左三角の位置）そのものは動かさず、クランプの下限だけ minX-marginMm へ広げることで
 * ElevationModeState.faceOffsetFor の既定オフセット（leftAnchorX-marginMm）がここで
 * minXへ引き戻されずに済む（上限側はminXのまま＝画面に収まる帯は従来どおりminXで頭打ち。
 * 上限まで広げると、収まる帯で右側に不要な余白ができてしまうため）。
 * @param {number} offsetMm
 * @param {{bounds?:{minX:number,maxX:number}, widthMm:number}} band
 * @param {number} viewWidthMm
 * @param {number} [marginMm]
 */
export function clampFaceOffset(offsetMm, band, viewWidthMm, marginMm = 0) {
  const minX = band?.bounds?.minX ?? 0;
  const maxX = band?.bounds?.maxX ?? (minX + (band?.widthMm ?? 0));
  return Math.min(Math.max(offsetMm, minX - marginMm), Math.max(minX, maxX - viewWidthMm));
}

/**
 * 帯1件のプリミティブ座標系(y=0が床線)の原点が、画面mm空間（layoutBandsのtopMm系）の
 * どこに来るかを返す（makeElevationTransformのoriginPxYはこれをscale倍したもの）。
 * 帯の実際の描画範囲は band.bounds.minY..maxY（天井高・壁材ラベルはy=0=床線より上＝負、
 * 部屋名枠はy=0より下＝正へ広がるため、bounds.minY!==0）であり、placement.topMmは
 * この実描画範囲の上端（=bounds.minY）に対応させる必要がある——そうしないと
 * 「連続する帯の間隔が正確にBAND_GAP_MM空く」というlayoutBandsの前提が画面上で崩れる
 * （QA F1: 旧実装はplacement.topMmをそのままy=0に対応させており、天井線・開口・壁材
 * ラベルが画面外へはみ出し、天井高が異なる帯同士がBAND_GAP_MMより狭く重なって見えていた）。
 * @param {{topMm:number}} placement - layoutBands/visibleBandPlacements の1件
 * @param {{bounds:{minY:number}}} band
 * @returns {number}
 */
export function bandContentOriginMm(placement, band) {
  return placement.topMm - band.bounds.minY;
}

/** mm→px 変換器（bounds基準ではなく明示原点。倍率固定・スクロールで原点だけ動かす）。 */
export function makeElevationTransform(scale, originPxX, originPxY) {
  return {
    scale,
    tx: mm => originPxX + mm * scale,
    ty: mm => originPxY + mm * scale,
    sx: mm => mm * scale,
  };
}

// ---- スクリーン固定サイズの px 空間ジオメトリ（tag の rPx と同じ考え方。mm換算しない） ----

/**
 * 部屋範囲の留め三角（直角三角形）の3頂点をpx空間で返す。
 * outer=(anchorPxX,anchorPxY)は引出線の端点（垂直辺の下端）、top はそこから真上へheightPxの点、
 * inner は底辺沿いに dir 方向へ「heightPx/tan(angleDeg)」進んだ点（底辺と斜辺のなす角=angleDeg）。
 * @param {number} anchorPxX
 * @param {number} anchorPxY
 * @param {1|-1} dir - 底辺が伸びる向き（+1=右へ、-1=左へ）
 * @param {number} heightPx
 * @param {number} angleDeg
 * @returns {{outer:[number,number], top:[number,number], inner:[number,number]}}
 */
export function miterTriangleVertices(anchorPxX, anchorPxY, dir, heightPx, angleDeg) {
  const basePx = heightPx / Math.tan((angleDeg * Math.PI) / 180);
  return {
    outer: [anchorPxX, anchorPxY],
    top:   [anchorPxX, anchorPxY - heightPx],
    inner: [anchorPxX + dir * basePx, anchorPxY],
  };
}

/**
 * 縦方向(dim dir='v')の寸法値ラベルの配置（天井高寸法。ユーザー仕様「寸法線の左側に、文字の天が
 * 左を向く縦書き回転（反時計回り90°）」）。Konvaのrotationは時計回り正のため-90でCCW90°になる。
 * ラベル本体（幅boxLenPx×厚みthicknessPx）を寸法線からgapPxだけ左にオフセットし、offsetX/offsetY
 * を中心に取ることで (x,y) を「回転後の中心点」として扱える（回転前は寸法線に沿った横長ボックス）。
 * @param {number} lineX - 寸法線のx（px）
 * @param {number} midY - 寸法線の中点y（px）
 * @param {number} [boxLenPx] - 寸法線方向の長さ
 * @param {number} [thicknessPx] - 行の厚み
 * @param {number} [gapPx] - 寸法線からの左オフセット
 * @returns {{x:number, y:number, width:number, height:number, offsetX:number, offsetY:number, rotation:number}}
 */
// 項目3: 寸法値と寸法線の離れ（gapPx）を旧値(8px)の半分にする（horizontalDimLabelBoxと同じ扱い）。
export function verticalDimLabelBox(lineX, midY, boxLenPx = 80, thicknessPx = 14, gapPx = 4) {
  return {
    x: lineX - gapPx, y: midY,
    width: boxLenPx, height: thicknessPx,
    offsetX: boxLenPx / 2, offsetY: thicknessPx / 2,
    rotation: -90,
  };
}

/**
 * 横方向(dim dir='h')の寸法値ラベルの配置（壁芯間・通り芯間寸法。項目5「建築図面の慣習通り
 * 寸法線の上側に値を載せる」）。ボックスの下端が寸法線からgapPxだけ上に来るようyを決める
 * （中央に重ねていた旧実装から変更）。
 * @param {number} midX - 寸法線の中点x（px）
 * @param {number} midY - 寸法線のy（px）
 * @param {number} [boxLenPx] - 寸法線方向の長さ
 * @param {number} [thicknessPx] - 行の厚み
 * @param {number} [gapPx] - 寸法線からの上オフセット
 * @returns {{x:number, y:number, width:number, height:number}}
 */
// 項目3: 寸法値と寸法線の離れ（gapPx）を旧値(2px)の半分にする（ユーザー仕様「現在の半分に」）。
export function horizontalDimLabelBox(midX, midY, boxLenPx = 80, thicknessPx = 14, gapPx = 1) {
  return {
    x: midX - boxLenPx / 2, y: midY - gapPx - thicknessPx,
    width: boxLenPx, height: thicknessPx,
  };
}
