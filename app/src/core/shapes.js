/**
 * 一般図形（VerticalLine / HorizontalLine / DiagonalLine / Arc / Circle）。core.js から分離。
 */
import { makeObservable, observable, computed } from 'mobx';
import { ShapeType } from './constants.js';
import { Shape } from './shapeBase.js';

// ----------------------------------------------------------------
// 垂直線: x固定, y1→y2
// エッジ: Intersection(clVertical, clHStart) ↔ Intersection(clVertical, clHEnd)
// ----------------------------------------------------------------
export class VerticalLine extends Shape {
  constructor(id, clVertical, clHStart, clHEnd, props) {
    super(id, props);
    this.type      = ShapeType.VERTICAL;
    this.clVertical = clVertical;  // CenterLine (VERTICAL)
    this.clHStart   = clHStart;    // CenterLine (HORIZONTAL)
    this.clHEnd     = clHEnd;      // CenterLine (HORIZONTAL)
    makeObservable(this, { x: computed, y1: computed, y2: computed });
  }
  get x()  { return this.clVertical.effectiveValue; }
  get y1() { return this.clHStart.effectiveValue; }
  get y2() { return this.clHEnd.effectiveValue; }
}

// ----------------------------------------------------------------
// 水平線: y固定, x1→x2
// エッジ: Intersection(clVStart, clHorizontal) ↔ Intersection(clVEnd, clHorizontal)
// ----------------------------------------------------------------
export class HorizontalLine extends Shape {
  constructor(id, clHorizontal, clVStart, clVEnd, props) {
    super(id, props);
    this.type         = ShapeType.HORIZONTAL;
    this.clHorizontal = clHorizontal;  // CenterLine (HORIZONTAL)
    this.clVStart     = clVStart;      // CenterLine (VERTICAL)
    this.clVEnd       = clVEnd;        // CenterLine (VERTICAL)
    makeObservable(this, { y: computed, x1: computed, x2: computed });
  }
  get y()  { return this.clHorizontal.effectiveValue; }
  get x1() { return this.clVStart.effectiveValue; }
  get x2() { return this.clVEnd.effectiveValue; }
}

// ----------------------------------------------------------------
// 斜線: 交点A→交点B で定義
// ----------------------------------------------------------------
export class DiagonalLine extends Shape {
  constructor(id, nodeA, nodeB, props) {
    super(id, props);
    this.type  = ShapeType.DIAGONAL;
    this.nodeA = nodeA;
    this.nodeB = nodeB;
  }
}

// ----------------------------------------------------------------
// 円弧: 中心(Intersection|Point) + 半径 + 開始角(度) + 内角(度)
// ----------------------------------------------------------------
export class Arc extends Shape {
  constructor(id, center, radius, startAngle, includedAngle, props) {
    super(id, props);
    this.type          = ShapeType.ARC;
    this.center        = center;
    this.radius        = radius;
    this.startAngle    = startAngle;
    this.includedAngle = includedAngle;
    makeObservable(this, {
      radius:        observable,
      startAngle:    observable,
      includedAngle: observable,
      endAngle:      computed,
    });
  }
  get endAngle() { return this.startAngle + this.includedAngle; }
}

// ----------------------------------------------------------------
// 円: 中心(Intersection|Point) + 半径
// ----------------------------------------------------------------
export class Circle extends Shape {
  constructor(id, center, radius, props) {
    super(id, props);
    this.type   = ShapeType.CIRCLE;
    this.center = center;
    this.radius = radius;
    makeObservable(this, { radius: observable });
  }
}
