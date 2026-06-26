import { makeObservable, observable, computed, action } from 'mobx';
import { LINE_WEIGHT_MM } from '@core';

export const DEFAULT_PX_PER_MM = 96 / 25.4;

// 壁・開口の3段階LOD描画の閾値（scaleDenominator 基準）
export const LOD_SCHEMATIC_DENOM = 90; // scaleDenominator >= 90 → 略図（1/90 を含む）
export const LOD_DETAIL_DENOM    = 60; // scaleDenominator <= 60 → 詳細（1/60 を含む）
export const LodLevel = { SCHEMATIC: 'schematic', STANDARD: 'standard', DETAIL: 'detail' };

// lineWeight(mm) をワールド空間の strokeWidth に変換する（ズーム追従、最低1px相当を保証）。
// 壁・開口・一般図形・構造部材（柱・梁・耐力壁・スラブ）が共通で使う。
export function resolveStrokeWidth(lineWeight, scale) {
  return Math.max(1 / scale, lineWeight);
}

// mm定義 + 校正値(px/mm) から、4段階が常に1px以上の差で見分けられるpxを算出する。
// 通り芯・寸法線・敷地線など、ズームに関わらず太さを固定する注記レイヤーが使う。
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
      calibrate:        action,
    });
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
