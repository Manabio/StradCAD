import { makeObservable, observable, computed, action } from 'mobx';
import { LINE_WEIGHT_MM } from '@core';

export const DEFAULT_PX_PER_MM = 96 / 25.4;

// 壁・開口の3段階LOD描画の閾値（scaleDenominator 基準）
export const LOD_SCHEMATIC_DENOM = 90; // scaleDenominator >= 90 → 略図（1/90 を含む）
export const LOD_DETAIL_DENOM    = 60; // scaleDenominator <= 60 → 詳細（1/60 を含む）
export const LodLevel = { SCHEMATIC: 'schematic', STANDARD: 'standard', DETAIL: 'detail' };

// mm定義 + 校正値(px/mm) から、4段階が常に1px以上の差で見分けられるpxを算出する。
// **線の太さの指定は「実画面上の絶対太さ」**であり、ズーム倍率の影響を受けない（ユーザー確定
// 2026-09）。どの描画モード（LOD）で描くかは倍率で変わるが、指定された太さ自体は変わらない。
// 図面のすべての線（通り芯・寸法・敷地・階段・壁・建具・構造部材）がこの表を唯一の情報源にする。
export function resolveLineWeightsPx(pxPerMm) {
  const toPx = (mm) => Math.max(1, Math.round(mm * pxPerMm));
  const w = {
    thin:       toPx(LINE_WEIGHT_MM.thin),
    medium:     toPx(LINE_WEIGHT_MM.medium),
    thick:      toPx(LINE_WEIGHT_MM.thick),
    ultraThick: toPx(LINE_WEIGHT_MM.ultraThick),
  };
  if (w.medium     <= w.thin)   w.medium     = w.thin + 1;
  if (w.thick      <= w.medium) w.thick      = w.medium + 1;
  if (w.ultraThick <= w.thick)  w.ultraThick = w.thick + 1;
  return w;
}

// lineWeight(mm) → 4段階の名前。LINE_WEIGHT_MM の値は一意なので値から名前を引ける。
const LINE_WEIGHT_NAME_BY_MM = new Map(
  Object.entries(LINE_WEIGHT_MM).map(([name, mm]) => [mm, name]));

/**
 * lineWeight(mm指定) を**実スクリーンpx**へ解決する。
 * 4段階の標準値は `lineWeightsPx`（校正値ベース・段間1px以上を保証した表）をそのまま引く
 * ——注記レイヤーと壁・建具・構造部材で同じ段が同じ太さになるようにするため。表に無いmm
 * （旧データが持つ0.15など）は表と同じ式で個別に換算する。
 * @param {number} lineWeight - mm
 * @param {{thin:number,medium:number,thick:number,ultraThick:number}} [lineWeightsPx] - viewport.lineWeightsPx
 * @param {number} [pxPerMm] - 表に無いmmの換算に使う校正値
 * @returns {number} 実スクリーンpx
 */
export function lineWeightPx(lineWeight, lineWeightsPx, pxPerMm) {
  const name = LINE_WEIGHT_NAME_BY_MM.get(lineWeight);
  if (name && lineWeightsPx?.[name] != null) return lineWeightsPx[name];
  return Math.max(1, Math.round(lineWeight * (pxPerMm ?? DEFAULT_PX_PER_MM)));
}

/**
 * ワールド座標のGroup（Konvaの親Groupが scaleX/scaleY を持つ）内に描く線の strokeWidth。
 * **実スクリーンpx固定の太さ**（`lineWeightPx`）を scale で割って世界mm相当へ戻す
 * ——Konvaが親Groupのscaleを掛け直すので、画面上はズームに関わらず指定pxちょうどになる。
 * SiteLinesLayer・StairLayer・StepSectionLayer が個別に書いていた
 * 「実px ÷ scale」と同じ式で、壁・建具・一般図形・構造部材・柱包みもこれを使う。
 *
 * 旧実装は `Math.max(1 / scale, lineWeight)`（＝画面上 `max(1, mm × scale)` px）で、
 * **指定した太さが倍率で変わる**という解釈違いだった（ユーザー指摘2026-09）。
 * @param {number} lineWeight - mm
 * @param {number} scale - 親Groupのscale（非等倍なら Math.min(scaleX, scaleY)）
 * @param {object} [lineWeightsPx] - viewport.lineWeightsPx
 * @param {number} [pxPerMm] - 表に無いmmの換算に使う校正値
 * @returns {number} 世界mm相当の strokeWidth
 */
export function resolveStrokeWidth(lineWeight, scale, lineWeightsPx, pxPerMm) {
  return lineWeightPx(lineWeight, lineWeightsPx, pxPerMm) / scale;
}

function loadCalibration() {
  try {
    const x = parseFloat(localStorage.getItem('strad_pxPerMmX'));
    const y = parseFloat(localStorage.getItem('strad_pxPerMmY'));
    if (isFinite(x) && x > 0 && isFinite(y) && y > 0) return [x, y];
    // 旧フォーマット (単一値) にフォールバック
    const v = parseFloat(localStorage.getItem('strad_pxPerMm'));
    if (isFinite(v) && v > 0) return [v, v];
  } catch {
    // localStorage 不可時はデフォルト値にフォールバック
  }
  return [DEFAULT_PX_PER_MM, DEFAULT_PX_PER_MM];
}

/**
 * 範囲（mm）が描画エリア（px）に余白込みで収まる最小の縮尺分母を候補から選ぶ。
 * どの候補でも収まらなければ最大の分母（最も縮小）を返す。範囲が点でも最小の分母で収まる。
 * @param {{ minX: number, maxX: number, minY: number, maxY: number }} boundsMm
 * @param {{ width: number, height: number }} areaPx
 * @param {number} pxPerMmX
 * @param {number} pxPerMmY
 * @param {readonly number[]} denoms 縮尺分母の候補（昇順）
 * @param {number} marginPx 範囲と描画エリア内端の間の余白（px。各辺）
 */
export function fitScaleDenominator(boundsMm, areaPx, pxPerMmX, pxPerMmY, denoms, marginPx = 0) {
  const availW = areaPx.width  - marginPx * 2;
  const availH = areaPx.height - marginPx * 2;
  const wMm = boundsMm.maxX - boundsMm.minX;
  const hMm = boundsMm.maxY - boundsMm.minY;
  for (const d of denoms) {
    if (wMm * pxPerMmX / d <= availW && hMm * pxPerMmY / d <= availH) return d;
  }
  return denoms[denoms.length - 1];
}

export class Viewport {
  pxPerMmX = DEFAULT_PX_PER_MM;
  pxPerMmY = DEFAULT_PX_PER_MM;
  offsetX  = 0;
  offsetY  = 0;
  scaleX   = DEFAULT_PX_PER_MM / 100;
  scaleY   = DEFAULT_PX_PER_MM / 100;

  constructor(width, height, gutterX = 0, gutterY = 0) {
    const [pmX, pmY] = loadCalibration();
    this.pxPerMmX = pmX;
    this.pxPerMmY = pmY;
    this.scaleX   = pmX / 100;
    this.scaleY   = pmY / 100;
    this.offsetX  = gutterX + 100;
    this.offsetY  = height - gutterY - 100;
    makeObservable(this, {
      pxPerMmX:         observable,
      pxPerMmY:         observable,
      offsetX:          observable,
      offsetY:          observable,
      scaleX:           observable,
      scaleY:           observable,
      scaleDenominator: computed,
      lodLevel:         computed,
      lineWeightsPx:    computed,
      pan:              action,
      zoomAt:           action,
      reset:            action,
      fitToBounds:      action,
      calibrate:        action,
    });
  }

  /**
   * 範囲（mm）の中心を描画エリア（画面 px の矩形）の中心へ置き、範囲が余白込みで収まる
   * 最小の縮尺分母（候補から選ぶ）にする。縦横比（校正比率）は維持。読込み後の初期表示（initialView.js）用。
   * @param {{ minX: number, maxX: number, minY: number, maxY: number }} boundsMm
   * @param {{ x: number, y: number, width: number, height: number }} areaPx
   * @param {readonly number[]} denoms 縮尺分母の候補（昇順）
   * @param {number} marginPx
   */
  fitToBounds(boundsMm, areaPx, denoms, marginPx = 0) {
    const d = fitScaleDenominator(boundsMm, areaPx, this.pxPerMmX, this.pxPerMmY, denoms, marginPx);
    this.scaleX = this.pxPerMmX / d;
    this.scaleY = this.pxPerMmY / d;
    const cxMm = (boundsMm.minX + boundsMm.maxX) / 2;
    const cyMm = (boundsMm.minY + boundsMm.maxY) / 2;
    this.offsetX = areaPx.x + areaPx.width  / 2 - cxMm * this.scaleX;
    this.offsetY = areaPx.y + areaPx.height / 2 - cyMm * this.scaleY;
  }

  worldToScreen(wx, wy) {
    return { x: wx * this.scaleX + this.offsetX, y: wy * this.scaleY + this.offsetY };
  }

  screenToWorld(sx, sy) {
    return { x: (sx - this.offsetX) / this.scaleX, y: (sy - this.offsetY) / this.scaleY };
  }

  pan(dx, dy) {
    this.offsetX += dx;
    this.offsetY += dy;
  }

  // X スケールを基準にクランプし、縦横比 (校正比率) を維持してズーム
  zoomAt(sx, sy, factor) {
    const wx       = (sx - this.offsetX) / this.scaleX;
    const wy       = (sy - this.offsetY) / this.scaleY;
    const newSX    = Math.max(0.001, Math.min(20, this.scaleX * factor));
    const actual   = newSX / this.scaleX; // クランプ後の実倍率
    this.scaleX  = newSX;
    this.scaleY  = this.scaleY * actual;
    this.offsetX = sx - wx * this.scaleX;
    this.offsetY = sy - wy * this.scaleY;
  }

  reset(width, height, gutterX = 0, gutterY = 0) {
    this.scaleX  = this.pxPerMmX / 100;
    this.scaleY  = this.pxPerMmY / 100;
    this.offsetX = gutterX + 100;
    this.offsetY = height - gutterY - 100;
  }

  // 現在の縮尺分母を保ちつつ校正値を更新
  calibrate(newPxPerMmX, newPxPerMmY) {
    const denom   = this.scaleDenominator;
    this.pxPerMmX = newPxPerMmX;
    this.pxPerMmY = newPxPerMmY;
    this.scaleX   = newPxPerMmX / denom;
    this.scaleY   = newPxPerMmY / denom;
    try {
      localStorage.setItem('strad_pxPerMmX', String(newPxPerMmX));
      localStorage.setItem('strad_pxPerMmY', String(newPxPerMmY));
    } catch {
      // localStorage 不可時は保存をスキップ
    }
  }

  // X 軸基準の縮尺分母 (= pxPerMmY / scaleY と等しく保たれる)
  get scaleDenominator() {
    return Math.round(this.pxPerMmX / this.scaleX);
  }

  // 壁・開口の3段階LOD描画レベル（略図 / 標準 / 詳細）
  get lodLevel() {
    const d = this.scaleDenominator;
    if (d >= LOD_SCHEMATIC_DENOM) return LodLevel.SCHEMATIC;
    if (d <= LOD_DETAIL_DENOM)    return LodLevel.DETAIL;
    return LodLevel.STANDARD;
  }

  // 校正値ベースの注記レイヤー用4段階px（ズーム非依存、校正値が変わった時のみ再計算）
  get lineWeightsPx() {
    return resolveLineWeightsPx((this.pxPerMmX + this.pxPerMmY) / 2);
  }
}
