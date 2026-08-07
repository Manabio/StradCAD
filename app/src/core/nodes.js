/**
 * Point（自由位置ノード）・Intersection（グリッド交点）。core.js から分離。
 */
import { makeObservable, observable, computed } from 'mobx';

// ================================================================
// POINT (自由位置ノード)
// グリッドに拘束されない独立した座標点
// Arc/Circle の中心として使用する
// ================================================================

export class Point {
  constructor(id, x, y) {
    this.id       = id;
    this.x        = x;
    this.y        = y;
    this.pendingDX = 0;
    this.pendingDY = 0;
    makeObservable(this, {
      x:          observable,
      y:          observable,
      pendingDX:  observable,
      pendingDY:  observable,
      effectiveX: computed,
      effectiveY: computed,
    });
  }
  get effectiveX() { return this.x + this.pendingDX; }
  get effectiveY() { return this.y + this.pendingDY; }
}

// ================================================================
// INTERSECTION (グリッドノード)
//
// 垂直中心線 × 水平中心線 の交点。
// CenterLine が位置の源泉であり、Intersection は派生。
// { id, x, y } を持つ点として Point と共通インターフェイスを満たす。
// ================================================================

export class Intersection {
  constructor(clVertical, clHorizontal) {
    this.id           = `${clVertical.id}:${clHorizontal.id}`;
    this.clVertical   = clVertical;    // CenterLine (VERTICAL)
    this.clHorizontal = clHorizontal;  // CenterLine (HORIZONTAL)
    makeObservable(this, { x: computed, y: computed });
  }
  // CenterLine.effectiveValue の変化に追従
  get x() { return this.clVertical.effectiveValue; }
  get y() { return this.clHorizontal.effectiveValue; }
}
