/**
 * 汎用建築CAD - コアクラス定義
 * 状態管理: MobX (mobx)
 * グラフ構造: ngraph.graph
 */
import { makeObservable, observable, computed, action, reaction } from 'mobx';
import createGraph from 'ngraph.graph';

// ================================================================
// CONSTANTS
// ================================================================

export const Discipline = Object.freeze({
  ARCH:   'arch',    // 意匠
  STRUCT: 'struct',  // 構造
  FUSE:   'fuse',    // 伏図
  MEP:    'mep',     // 設備
  ELEC:   'elec',    // 電気
});

export const ShapeType = Object.freeze({
  VERTICAL:   'vertical',
  HORIZONTAL: 'horizontal',
  DIAGONAL:   'diagonal',
  ARC:        'arc',
  CIRCLE:     'circle',
  WALL:       'wall',
});

// 図形の種別: 一般図形 / 寸法図形
export const ShapeKind = Object.freeze({
  GENERAL:   'general',    // 一般図形 — 壁・開口・仕上げ等
  DIMENSION: 'dimension',  // 寸法図形 — 中心線・おさえ
});

// 中心線の軸種別 — 自動命名の接頭辞と整列基準を決定する
export const CenterLineType = Object.freeze({
  VERTICAL:   'X',  // 垂直中心線 — value = x座標, 左→右昇順で X1, X2, ...
  HORIZONTAL: 'Y',  // 水平中心線 — value = y座標, 下→上昇順で Y1, Y2, ...
  RADIAL:     'R',  // 放射中心線 — value = 角度(度),  挿入順で  R1, R2, ...
});

// ================================================================
// POINT (自由位置ノード)
// グリッドに拘束されない独立した座標点
// Arc/Circle の中心として使用する
// ================================================================

export class Point {
  constructor(id, x, y) {
    this.id = id;
    this.x  = x;
    this.y  = y;
    makeObservable(this, { x: observable, y: observable });
  }
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
  // CenterLine.value の変化に追従
  get x() { return this.clVertical.value; }
  get y() { return this.clHorizontal.value; }
}

// ================================================================
// SHAPES (グラフエッジ) — 基底クラス
// ================================================================

const SHAPE_DEFAULTS = Object.freeze({
  discipline: Discipline.ARCH,
  layerId:    'default',
  lineWeight: 0.25,
  lineType:   'solid',
  color:      '#000000',
  kind:       ShapeKind.GENERAL,
});

class Shape {
  constructor(id, props = {}) {
    this.id = id;
    const p = { ...SHAPE_DEFAULTS, ...props };
    this.discipline = p.discipline;
    this.layerId    = p.layerId;
    this.lineWeight = p.lineWeight;
    this.lineType   = p.lineType;
    this.color      = p.color;
    this.kind       = p.kind;
    makeObservable(this, {
      discipline: observable,
      layerId:    observable,
      lineWeight: observable,
      lineType:   observable,
      color:      observable,
      kind:       observable,
      setProps:   action,
    });
  }

  setProps(props) { Object.assign(this, props); }
}

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
  get x()  { return this.clVertical.value; }
  get y1() { return this.clHStart.value; }
  get y2() { return this.clHEnd.value; }
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
  get y()  { return this.clHorizontal.value; }
  get x1() { return this.clVStart.value; }
  get x2() { return this.clVEnd.value; }
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

// ----------------------------------------------------------------
// 壁: 軸 CL 参照 + オフセット + 直交 CL 参照端点
//
// 垂直壁 (isVertical=true):
//   x  = axisCL.value + axisOffset  (軸 CL は VERTICAL CL)
//   y1 = clStart.value + startOffset // clStart は HORIZONTAL CL
//   y2 = clEnd.value   + endOffset   // clEnd   は HORIZONTAL CL
//
// 水平壁 (isVertical=false):
//   y  = axisCL.value + axisOffset  (軸 CL は HORIZONTAL CL)
//   x1 = clStart.value + startOffset // clStart は VERTICAL CL
//   x2 = clEnd.value   + endOffset   // clEnd   は VERTICAL CL
// ----------------------------------------------------------------
export class Wall extends Shape {
  constructor(id, axisCL, axisOffset, isVertical, clStart, startOffset, clEnd, endOffset, props) {
    super(id, props);
    this.type        = ShapeType.WALL;
    this.axisCL      = axisCL;        // 軸 CL への参照
    this.axisOffset  = axisOffset;    // axisCL.value からの符号付きオフセット
    this.isVertical  = isVertical;
    this.clStart     = clStart;       // 始点参照 CL
    this.startOffset = startOffset;   // clStart.value からの符号付きオフセット
    this.clEnd       = clEnd;         // 終点参照 CL
    this.endOffset   = endOffset;     // clEnd.value からの符号付きオフセット
    makeObservable(this, {
      axisOffset:  observable,
      startOffset: observable,
      endOffset:   observable,
      axisValue:   computed,
      coord1:      computed,
      coord2:      computed,
    });
  }

  get axisValue() { return this.axisCL.value + this.axisOffset; }
  get coord1()    { return this.clStart.value + this.startOffset; }
  get coord2()    { return this.clEnd.value   + this.endOffset;   }
}

// ================================================================
// CENTER LINE (中心線) — 寸法図形
//
// 通り芯はグリッドの源泉であり、GridX/GridY には依存しない。
// 中心線が自身の座標 (value) を保持し、Intersection はその交差から派生する。
//
//   labeled:true  — グリッド軸として登録、ラベル自動付与 (X1/Y1/R1...)
//                   VERTICAL/HORIZONTAL は直交する labeled 中心線と Intersection を自動生成
//   labeled:false — 補助線、グリッド未登録、ラベルなし
//
// demoteToAuxiliary() で labeled:true → false に降格すると Intersection が削除される。
// promoteToGrid()     で labeled:false → true に昇格すると Intersection が再生成される。
// ================================================================

export class CenterLine extends Shape {
  /**
   * @param {string} id
   * @param {string} centerLineType  CenterLineType の値
   * @param {number} value           x座標(VERTICAL) / y座標(HORIZONTAL) / 角度(RADIAL)
   * @param {object} [props]
   */
  constructor(id, centerLineType, value, props = {}) {
    super(id, {
      kind:       ShapeKind.DIMENSION,
      lineType:   'center',
      lineWeight: 0.15,
      ...props,
    });
    this.centerLineType = centerLineType;
    this._value         = value;              // 絶対座標値（参照なし時）
    this.refId          = props.refId ?? null; // 参照先 CenterLine の id
    this.refOffset      = props.refOffset ?? 0; // 参照先からのオフセット
    this.labeled        = props.labeled ?? true;
    this.trim           = props.trim   ?? false;
    this._extentLo      = props.extentLo  ?? null; // 静的フォールバック（旧データ互換）
    this._extentHi      = props.extentHi  ?? null; // 静的フォールバック（旧データ互換）
    this.extentLoRef    = props.extentLoRef ?? null; // { clId, offset } | null
    this.extentHiRef    = props.extentHiRef ?? null; // { clId, offset } | null
    this._extentLoCL    = null; // 解決済み参照 CL（PlanGraph が設定）
    this._extentHiCL    = null; // 解決済み参照 CL（PlanGraph が設定）
    this.label          = '';
    this._referencedCL  = null; // 参照先 CL の参照を保持（PlanGraph が設定）
    makeObservable(this, {
      _value:       observable,
      refId:        observable,
      refOffset:    observable,
      _referencedCL: observable,
      value:        computed,
      labeled:      observable,
      trim:         observable,
      label:        observable,
      _extentLo:    observable,
      _extentHi:    observable,
      extentLoRef:  observable,
      extentHiRef:  observable,
      _extentLoCL:  observable,
      _extentHiCL:  observable,
      extentLo:     computed,
      extentHi:     computed,
    });
  }

  get value() {
    if (!this.refId) return this._value;
    const refValue = this._referencedCL ? this._referencedCL.value : this._value;
    return refValue + this.refOffset;
  }
  set value(v) {
    this._value = v;
  }

  get extentLo() {
    if (this._extentLoCL && this.extentLoRef != null) {
      return this._extentLoCL.value + (this.extentLoRef.offset ?? 0);
    }
    return this._extentLo;
  }

  get extentHi() {
    if (this._extentHiCL && this.extentHiRef != null) {
      return this._extentHiCL.value + (this.extentHiRef.offset ?? 0);
    }
    return this._extentHi;
  }
}

// ================================================================
// PLANE (平面 = XY平面 1枚 + 高さ 1つ)
// ================================================================

export class Plane {
  constructor(id, elevation, name = '') {
    this.id        = id;
    this.elevation = elevation;
    this.name      = name;
    makeObservable(this, { elevation: observable, name: observable });
  }
}

// ================================================================
// PLAN GRAPH (ngraph ラッパ — 平面図の主グラフ)
//
// ノード : Intersection (clVertical × clHorizontal の交点) + Point (自由位置)
// エッジ : 一般 Shape (VerticalLine / HorizontalLine / DiagonalLine / Arc / Circle)
// 寸法   : CenterLine (shapeMap に格納、ngraph エッジなし)
//
// 中心線管理:
//   addCenterLine()     — CenterLine 追加、labeled:true なら Intersection 自動生成
//   demoteToAuxiliary() — グリッド解除 (labeled:false + Intersection/Shape 連鎖削除)
//   promoteToGrid()     — グリッド復帰 (labeled:true  + Intersection 再生成)
//   removeCenterLine()  — 完全削除 (Intersection/Shape 連鎖削除 + CenterLine 削除)
//
// 自動命名 reaction:
//   VERTICAL  labeled の value 変化・増減 → X1, X2, ...
//   HORIZONTAL labeled の value 変化・増減 → Y1, Y2, ...
//   RADIAL    labeled の増減              → R1, R2, ...
// ================================================================

export class PlanGraph {
  constructor(plane) {
    this.plane = plane;

    this._graph = createGraph({ multigraph: true });

    this.intersectionMap = observable.map(); // id → Intersection
    this.shapeMap        = observable.map(); // id → Shape (CenterLine含む)
    this.pointMap        = observable.map(); // id → Point (自由位置ノード)

    this._shapeLinks = new Map(); // shapeId → ngraph.Link

    makeObservable(this, {
      gridXs:              computed,
      gridYs:              computed,
      intersections:       computed,
      points:              computed,
      shapes:              computed,
      generalShapes:       computed,
      walls:               computed,
      centerLines:         computed,
      addCenterLine:       action,
      removeCenterLine:    action,
      demoteToAuxiliary:   action,
      promoteToGrid:       action,
      addPoint:            action,
      removePoint:         action,
      addVerticalLine:        action,
      addHorizontalLine:      action,
      addDiagonalLine:        action,
      addArc:                 action,
      addCircle:              action,
      addWall:                action,
      removeShape:            action,
      clear:                  action,
      getOrCreateIntersection:action,
      chamferWalls:           action,
      _relabelCenterLines:    action,
    });

    // ---- 中心線ラベル自動命名 reaction ----

    reaction(
      () => [...this.shapeMap.values()]
        .filter(s => s instanceof CenterLine && s.centerLineType === CenterLineType.VERTICAL && s.labeled && s.discipline === Discipline.STRUCT)
        .map(cl => cl.value),
      () => this._relabelCenterLines(CenterLineType.VERTICAL),
      { fireImmediately: true },
    );

    reaction(
      () => [...this.shapeMap.values()]
        .filter(s => s instanceof CenterLine && s.centerLineType === CenterLineType.HORIZONTAL && s.labeled && s.discipline === Discipline.STRUCT)
        .map(cl => cl.value),
      () => this._relabelCenterLines(CenterLineType.HORIZONTAL),
      { fireImmediately: true },
    );

    reaction(
      () => [...this.shapeMap.values()]
        .filter(s => s instanceof CenterLine && s.centerLineType === CenterLineType.RADIAL && s.labeled && s.discipline === Discipline.STRUCT)
        .length,
      () => this._relabelCenterLines(CenterLineType.RADIAL),
      { fireImmediately: true },
    );

    // ---- 壁面取り自動処理 reaction ----
    // startOffset/endOffset は監視しない (chamferWalls が書き換える値のため無限ループ回避)
    reaction(
      () => this.walls.map(w => [w.axisValue, w.isVertical, w.clStart.value, w.clEnd.value]),
      () => this.chamferWalls(),
      { fireImmediately: true },
    );
  }

  // ---- computed views ----

  // グリッド軸として機能する labeled:true VERTICAL CenterLine (= 旧 GridX 相当)
  get gridXs() {
    return [...this.shapeMap.values()]
      .filter(s => s instanceof CenterLine && s.centerLineType === CenterLineType.VERTICAL && s.labeled)
      .sort((a, b) => a.value - b.value);
  }

  // グリッド軸として機能する labeled:true HORIZONTAL CenterLine (= 旧 GridY 相当)
  get gridYs() {
    return [...this.shapeMap.values()]
      .filter(s => s instanceof CenterLine && s.centerLineType === CenterLineType.HORIZONTAL && s.labeled)
      .sort((a, b) => a.value - b.value);
  }

  get intersections() { return [...this.intersectionMap.values()]; }
  get points()        { return [...this.pointMap.values()]; }
  get shapes()        { return [...this.shapeMap.values()]; }
  get generalShapes() { return [...this.shapeMap.values()].filter(s => s.kind === ShapeKind.GENERAL); }
  get walls()         { return [...this.shapeMap.values()].filter(s => s.type === ShapeType.WALL); }
  get centerLines()   { return [...this.shapeMap.values()].filter(s => s instanceof CenterLine); }


  // ---- 中心線操作 ----

  /**
   * 中心線を追加する。
   * labeled:true かつ VERTICAL/HORIZONTAL の場合、既存の直交 labeled 中心線との
   * Intersection を自動生成する。
   * @param {string} centerLineType  CenterLineType の値
   * @param {number} value           x座標(VERTICAL) / y座標(HORIZONTAL) / 角度(RADIAL)
   * @param {object} [props]  refId, refOffset を含む可能性あり
   * @returns {CenterLine}
   */
  addCenterLine(centerLineType, value, props = {}, id = crypto.randomUUID()) {
    const cl = new CenterLine(id, centerLineType, value, props);
    // refId がある場合、参照先 CL への参照を設定
    if (cl.refId) {
      const refCL = this.shapeMap.get(cl.refId);
      if (refCL instanceof CenterLine) cl._referencedCL = refCL;
    }
    // extentLoRef/HiRef がある場合、参照先 CL への参照を解決
    if (cl.extentLoRef) {
      const loCL = this.shapeMap.get(cl.extentLoRef.clId);
      if (loCL instanceof CenterLine) cl._extentLoCL = loCL;
    }
    if (cl.extentHiRef) {
      const hiCL = this.shapeMap.get(cl.extentHiRef.clId);
      if (hiCL instanceof CenterLine) cl._extentHiCL = hiCL;
    }
    this.shapeMap.set(cl.id, cl);
    if (cl.labeled) this._createIntersections(cl);
    return cl;
  }

  /**
   * 中心線を完全削除する。依存する Intersection・Shape も連鎖削除される。
   * @param {string} id  CenterLine の id
   */
  removeCenterLine(id) {
    const cl = this.shapeMap.get(id);
    if (!(cl instanceof CenterLine)) return;
    this._teardownCenterLine(id);
    this._removeShape(id);
  }

  /**
   * グリッド指定を解除し補助線に降格する。
   * Intersection・依存 Shape は削除されるが、中心線自体は残る。
   * @param {string} id  CenterLine の id
   */
  demoteToAuxiliary(id) {
    const cl = this.shapeMap.get(id);
    if (!(cl instanceof CenterLine) || !cl.labeled) return;
    cl.labeled = false;  // reaction 発火 → ラベル再計算
    this._teardownCenterLine(id);
  }

  /**
   * 補助線をグリッド軸に昇格する。
   * 既存の直交 labeled 中心線との Intersection を再生成する。
   * @param {string} id  CenterLine の id
   */
  promoteToGrid(id) {
    const cl = this.shapeMap.get(id);
    if (!(cl instanceof CenterLine) || cl.labeled) return;
    cl.labeled = true;
    this._createIntersections(cl);
  }

  // ---- 自由位置ノード操作 ----

  addPoint(x, y, id = crypto.randomUUID()) {
    const pt = new Point(id, x, y);
    this._graph.addNode(pt.id, pt);
    this.pointMap.set(pt.id, pt);
    return pt;
  }

  removePoint(id) {
    [...this.shapeMap.values()]
      .filter(s => (s.type === ShapeType.ARC || s.type === ShapeType.CIRCLE)
                && s.center instanceof Point && s.center.id === id)
      .forEach(s => this._removeShape(s.id));
    this._graph.removeNode(id);
    this.pointMap.delete(id);
  }

  // ---- 一般図形追加 ----

  addVerticalLine(clVertical, clHStart, clHEnd, props, id = crypto.randomUUID()) {
    const s  = new VerticalLine(id, clVertical, clHStart, clHEnd, props);
    const nA = this._getOrCreateIntersection(clVertical, clHStart);
    const nB = this._getOrCreateIntersection(clVertical, clHEnd);
    this._registerShape(s, this._graph.addLink(nA.id, nB.id, s.id));
    return s;
  }

  addHorizontalLine(clHorizontal, clVStart, clVEnd, props, id = crypto.randomUUID()) {
    const s  = new HorizontalLine(id, clHorizontal, clVStart, clVEnd, props);
    const nA = this._getOrCreateIntersection(clVStart, clHorizontal);
    const nB = this._getOrCreateIntersection(clVEnd, clHorizontal);
    this._registerShape(s, this._graph.addLink(nA.id, nB.id, s.id));
    return s;
  }

  addDiagonalLine(nodeA, nodeB, props, id = crypto.randomUUID()) {
    const s = new DiagonalLine(id, nodeA, nodeB, props);
    this._registerShape(s, this._graph.addLink(nodeA.id, nodeB.id, s.id));
    return s;
  }

  addArc(center, radius, startAngle, includedAngle, props, id = crypto.randomUUID()) {
    this._ensureNode(center);
    const s = new Arc(id, center, radius, startAngle, includedAngle, props);
    this._registerShape(s, this._graph.addLink(center.id, center.id, s.id));
    return s;
  }

  addCircle(center, radius, props, id = crypto.randomUUID()) {
    this._ensureNode(center);
    const s = new Circle(id, center, radius, props);
    this._registerShape(s, this._graph.addLink(center.id, center.id, s.id));
    return s;
  }

  addWall(axisCL, axisOffset, isVertical, clStart, startOffset, clEnd, endOffset, props, id = crypto.randomUUID()) {
    const w = new Wall(id, axisCL, axisOffset, isVertical, clStart, startOffset, clEnd, endOffset, props);
    this.shapeMap.set(w.id, w);
    return w;
  }

  /**
   * 壁同士の面取り処理。
   *
   * 垂直壁と水平壁の全ペアを走査し、端点が交点から tolerance 以内にある場合、
   * startOffset / endOffset を調整して端点を交点にスナップする。
   *
   * @param {number} [tolerance=150]  スナップ判定の距離閾値 (mm)
   */
  chamferWalls(tolerance = 150) {
    const verticals   = this.walls.filter(w =>  w.isVertical);
    const horizontals = this.walls.filter(w => !w.isVertical);

    for (const v of verticals) {
      const vx  = v.axisValue;
      const vys = v.clStart.value;
      const vye = v.clEnd.value;
      const vy1 = Math.min(vys, vye);
      const vy2 = Math.max(vys, vye);

      for (const h of horizontals) {
        const hy  = h.axisValue;
        const hxs = h.clStart.value;
        const hxe = h.clEnd.value;
        const hx1 = Math.min(hxs, hxe);
        const hx2 = Math.max(hxs, hxe);

        // 交差の可能性がない組み合わせはスキップ
        if (vx < hx1 - tolerance || vx > hx2 + tolerance) continue;
        if (hy < vy1 - tolerance || hy > vy2 + tolerance) continue;

        // CL位置基準でスナップ判定（オフセット後座標ではなくCL位置で判断）
        if (Math.abs(vys - hy) <= tolerance) v.startOffset = hy - vys;
        if (Math.abs(vye - hy) <= tolerance) v.endOffset   = hy - vye;

        if (Math.abs(hxs - vx) <= tolerance) h.startOffset = vx - hxs;
        if (Math.abs(hxe - vx) <= tolerance) h.endOffset   = vx - hxe;
      }
    }
  }

  removeShape(id) { this._removeShape(id); }

  /** グラフを完全にクリアする（restoreGraph の前処理用）。*/
  clear() {
    this._graph = createGraph({ multigraph: true });
    this._shapeLinks.clear();
    this.shapeMap.clear();
    this.intersectionMap.clear();
    this.pointMap.clear();
  }

  /** 交点を取得または生成する（restoreGraph の内部参照解決用）。*/
  getOrCreateIntersection(clVertical, clHorizontal) {
    return this._getOrCreateIntersection(clVertical, clHorizontal);
  }

  // ---- クエリ ----

  getShapesAtNode(intersection) {
    const result = [];
    this._graph.forEachLinkedNode(intersection.id, (_node, link) => {
      const s = this.shapeMap.get(link.data);
      if (s) result.push(s);
    }, false);
    return result;
  }

  // ---- 中心線ラベル自動命名 ----

  _relabelCenterLines(type) {
    const sorted = _sortedCenterLines(this.shapeMap, type);
    sorted.forEach((cl, i) => { cl.label = `${type}${i + 1}`; });
  }

  // ---- 内部ヘルパー ----

  // labeled CenterLine と既存の直交 labeled CenterLine との Intersection を生成
  _createIntersections(cl) {
    if (cl.centerLineType === CenterLineType.VERTICAL) {
      for (const clH of this._labeledHorizontals()) {
        this._getOrCreateIntersection(cl, clH);
      }
    } else if (cl.centerLineType === CenterLineType.HORIZONTAL) {
      for (const clV of this._labeledVerticals()) {
        this._getOrCreateIntersection(clV, cl);
      }
    }
  }

  // CenterLine 削除・降格に伴う Shape・Intersection の連鎖削除
  _teardownCenterLine(id) {
    [...this.shapeMap.values()]
      .filter(s => !(s instanceof CenterLine) && _shapeUsesCenterLine(s, id))
      .forEach(s => this._removeShape(s.id));
    [...this.intersectionMap.entries()]
      .filter(([, n]) => n.clVertical.id === id || n.clHorizontal.id === id)
      .forEach(([key, n]) => {
        this._graph.removeNode(n.id);
        this.intersectionMap.delete(key);
      });
  }

  _labeledVerticals() {
    return [...this.shapeMap.values()]
      .filter(s => s instanceof CenterLine && s.centerLineType === CenterLineType.VERTICAL && s.labeled);
  }

  _labeledHorizontals() {
    return [...this.shapeMap.values()]
      .filter(s => s instanceof CenterLine && s.centerLineType === CenterLineType.HORIZONTAL && s.labeled);
  }

  _getOrCreateIntersection(clVertical, clHorizontal) {
    const key = `${clVertical.id}:${clHorizontal.id}`;
    if (!this.intersectionMap.has(key)) {
      const n = new Intersection(clVertical, clHorizontal);
      this._graph.addNode(n.id, n);
      this.intersectionMap.set(n.id, n);
    }
    return this.intersectionMap.get(key);
  }

  _ensureNode(center) {
    if (center instanceof Point && !this._graph.getNode(center.id)) {
      this._graph.addNode(center.id, center);
      this.pointMap.set(center.id, center);
    }
  }

  _registerShape(shape, link) {
    this._shapeLinks.set(shape.id, link);
    this.shapeMap.set(shape.id, shape);
  }

  _removeShape(id) {
    const link = this._shapeLinks.get(id);
    if (link) {
      this._graph.removeLink(link);
      this._shapeLinks.delete(id);
    }
    this.shapeMap.delete(id);
  }
}

// ---- module-private helpers ----

// labeled:true の CenterLine をソートして返す (自動命名対象)
function _sortedCenterLines(shapeMap, type) {
  const all = [...shapeMap.values()]
    .filter(s => s instanceof CenterLine && s.centerLineType === type && s.labeled && s.discipline === Discipline.STRUCT);
  switch (type) {
    case CenterLineType.VERTICAL:   return all.sort((a, b) => a.value - b.value);
    case CenterLineType.HORIZONTAL: return all.sort((a, b) => b.value - a.value);
    case CenterLineType.RADIAL:     return all; // 挿入順
  }
}

// 中心線参照チェック (_teardownCenterLine 用)
// CenterLine 削除時に依存する一般 Shape を特定する
function _shapeUsesCenterLine(shape, id) {
  switch (shape.type) {
    case ShapeType.VERTICAL:
      return shape.clVertical.id === id
          || shape.clHStart.id  === id
          || shape.clHEnd.id    === id;
    case ShapeType.HORIZONTAL:
      return shape.clHorizontal.id === id
          || shape.clVStart.id     === id
          || shape.clVEnd.id       === id;
    case ShapeType.DIAGONAL: {
      const uses = (n) => n instanceof Intersection
        && (n.clVertical.id === id || n.clHorizontal.id === id);
      return uses(shape.nodeA) || uses(shape.nodeB);
    }
    case ShapeType.ARC:
    case ShapeType.CIRCLE:
      return shape.center instanceof Intersection
          && (shape.center.clVertical.id === id || shape.center.clHorizontal.id === id);
    case ShapeType.WALL:
      return shape.axisCL.id === id || shape.clStart.id === id || shape.clEnd.id === id;
    default: return false;
  }
}

// ================================================================
// PROJECT (MobX ルートストア)
// ================================================================

export class Project {
  constructor(id, name) {
    this.id   = id;
    this.name = name;

    this.planeMap = observable.map();
    this.graphMap = observable.map();

    this.activePlaneId = null;

    makeObservable(this, {
      name:          observable,
      activePlaneId: observable,
      activeGraph:   computed,
      addPlane:      action,
    });
  }

  get activeGraph() {
    return this.activePlaneId ? this.graphMap.get(this.activePlaneId) : undefined;
  }

  addPlane(elevation, name) {
    const plane = new Plane(crypto.randomUUID(), elevation, name);
    const graph = new PlanGraph(plane);
    this.planeMap.set(plane.id, plane);
    this.graphMap.set(plane.id, graph);
    if (!this.activePlaneId) this.activePlaneId = plane.id;
    return { plane, graph };
  }

}
