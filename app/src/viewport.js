import { makeObservable, observable, computed, action } from 'mobx';

export class Viewport {
  offsetX = 0;
  offsetY = 0;
  scale   = 1; // px/mm  (scale=1 → 1:100 相当, scale=0.5 → 1:200)

  constructor(width, height) {
    this.offsetX = 100;
    this.offsetY = height - 100;
    makeObservable(this, {
      offsetX:          observable,
      offsetY:          observable,
      scale:            observable,
      scaleDenominator: computed,
      pan:              action,
      zoomAt:           action,
      reset:            action,
    });
  }

  // ワールド座標 → スクリーン座標
  worldToScreen(wx, wy) {
    return {
      x: wx * this.scale + this.offsetX,
      y: wy * this.scale + this.offsetY,
    };
  }

  // スクリーン座標 → ワールド座標
  screenToWorld(sx, sy) {
    return {
      x: (sx - this.offsetX) / this.scale,
      y: (sy - this.offsetY) / this.scale,
    };
  }

  pan(dx, dy) {
    this.offsetX += dx;
    this.offsetY += dy;
  }

  // スクリーン上の点 (sx, sy) を固定してズーム
  zoomAt(sx, sy, factor) {
    const wx = (sx - this.offsetX) / this.scale;
    const wy = (sy - this.offsetY) / this.scale;
    this.scale   = Math.max(0.02, Math.min(20, this.scale * factor));
    this.offsetX = sx - wx * this.scale;
    this.offsetY = sy - wy * this.scale;
  }

  reset(width, height) {
    this.scale   = 1;
    this.offsetX = 100;
    this.offsetY = height - 100;
  }

  get scaleDenominator() {
    return Math.round(100 / this.scale);
  }
}
