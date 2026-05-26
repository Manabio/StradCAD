import { makeObservable, observable, computed, action } from 'mobx';

export const DEFAULT_PX_PER_MM = 96 / 25.4;

function loadCalibration() {
  try {
    const x = parseFloat(localStorage.getItem('strad_pxPerMmX'));
    const y = parseFloat(localStorage.getItem('strad_pxPerMmY'));
    if (isFinite(x) && x > 0 && isFinite(y) && y > 0) return [x, y];
    // 旧フォーマット (単一値) にフォールバック
    const v = parseFloat(localStorage.getItem('strad_pxPerMm'));
    if (isFinite(v) && v > 0) return [v, v];
  } catch {}
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
    } catch {}
  }

  // X 軸基準の縮尺分母 (= pxPerMmY / scaleY と等しく保たれる)
  get scaleDenominator() {
    return Math.round(this.pxPerMmX / this.scaleX);
  }
}
