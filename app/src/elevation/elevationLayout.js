/**
 * 展開図: 固定倍率決定・帯（部屋）レイアウト・循環スクロール・mm→px変換器（純関数群）。
 * 設計意図は .claude/elevation-model.md 参照。
 *
 * 展開モードにはズームが無いため、倍率は画面高さだけで決める（横幅は問わない）。
 * 縦（部屋帯）は循環スクロール、横（面）は帯ごと独立にクランプスクロールする。
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
 * 帯群を縦に積んだレイアウト（帯間 BAND_GAP_MM）。周期 totalMm は最後の帯の下端＋帯間。
 * @param {Array<{roomId:string, heightMm:number}>} bands
 * @param {number} [gapMm]
 * @returns {{placements:Array<{roomId:string, topMm:number, heightMm:number}>, totalMm:number}}
 */
export function layoutBands(bands, gapMm = BAND_GAP_MM) {
  const placements = [];
  let top = 0;
  for (const b of bands) {
    placements.push({ roomId: b.roomId, topMm: top, heightMm: b.heightMm });
    top += b.heightMm + gapMm;
  }
  return { placements, totalMm: top };
}

/** offsetMm を [0, totalMm) へ正規化する。totalMm<=0 は 0 を返す（安全側）。 */
export function wrapOffset(offsetMm, totalMm) {
  if (!(totalMm > 0)) return 0;
  return ((offsetMm % totalMm) + totalMm) % totalMm;
}

/**
 * 縦スクロール offsetMm・画面高さ viewHeightMm に対し、画面内に現れる帯の配置一覧を返す
 * （循環のため前後 ±totalMm の複製も候補に含める）。offsetMm は totalMm を法として周期的
 * （wrapOffset(o) === wrapOffset(o+totalMm)）。
 * @param {ReturnType<typeof layoutBands>} layout
 * @param {number} offsetMm
 * @param {number} viewHeightMm
 * @returns {Array<{roomId:string, topMm:number, heightMm:number}>}
 */
export function visibleBandPlacements(layout, offsetMm, viewHeightMm) {
  const { placements, totalMm } = layout;
  if (placements.length === 0 || !(totalMm > 0)) return [];
  const wrapped = wrapOffset(offsetMm, totalMm);
  const out = [];
  for (const p of placements) {
    // -totalMm候補: layoutBandsが「各帯の直後に必ずgapMm(>0)を積む」実装のため、
    // 任意の帯についてtopMm+heightMm ≤ totalMm-gapMm < totalMm が常に成立し（最終帯は等号）、
    // 現状の入力（gapMm>0前提）ではこの候補が単独で必要になることはない
    // （QA F8: 削除はしないで残す＝将来layoutBandsの実装が変わった場合の対称性の保険。
    // elevationLayout.test.js のコメントに数学的な証明を残す）。
    for (const shift of [-totalMm, 0, totalMm]) {
      const top = p.topMm - wrapped + shift;
      if (top + p.heightMm > 0 && top < viewHeightMm) {
        out.push({ roomId: p.roomId, topMm: top, heightMm: p.heightMm });
      }
    }
  }
  return out;
}

/** 画面上のy座標(mm、描画エリア原点基準)がどの帯に属するかを返す（無ければ null）。 */
export function bandIdAtY(layout, offsetMm, yMm) {
  const { placements, totalMm } = layout;
  if (placements.length === 0 || !(totalMm > 0)) return null;
  const wrapped = wrapOffset(offsetMm, totalMm);
  const localY = (((yMm + wrapped) % totalMm) + totalMm) % totalMm;
  for (const p of placements) {
    if (localY >= p.topMm && localY < p.topMm + p.heightMm) return p.roomId;
  }
  return null;
}

/**
 * 帯の水平スクロール offsetMm を有効範囲へクランプする（循環しない）。
 * 帯の実測 bounds（minX/maxX）を基準にする——bounds.minX は 0 ではない（天井高寸法が
 * face[0]の左端よりさらに左＝負のmmへ張り出すため。QA F9: 旧実装は[0,widthMm]を仮定しており、
 * 帯が画面より広いとoffsetMmが0未満へ絶対に動けず、天井高寸法が常に画面外に切れていた）。
 * 帯の全幅(widthMm=maxX-minX)が画面幅(viewWidthMm)に収まる場合は中央寄せの1点に固定する
 * （ElevationModeState の初期値と同じ式——収まる帯はドラッグしても動かない）。
 * @param {number} offsetMm
 * @param {{bounds?:{minX:number,maxX:number}, widthMm:number}} band
 * @param {number} viewWidthMm
 */
export function clampFaceOffset(offsetMm, band, viewWidthMm) {
  const minX = band?.bounds?.minX ?? 0;
  const maxX = band?.bounds?.maxX ?? (minX + (band?.widthMm ?? 0));
  const widthMm = maxX - minX;
  if (widthMm <= viewWidthMm) {
    return minX - (viewWidthMm - widthMm) / 2;
  }
  return Math.min(Math.max(offsetMm, minX), maxX - viewWidthMm);
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
