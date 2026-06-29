/**
 * 汎用建築CAD - コアクラス定義
 * 状態管理: MobX (mobx)
 * グラフ構造: ngraph.graph
 */
import { makeObservable, observable, computed, action, reaction } from 'mobx';
import createGraph from 'ngraph.graph';
import { INTERIOR_MASTERS } from './finish/materials/interiorMasters.js';
import { findSectionEntry, diaphragmProjection } from './structural/sectionCatalog.js';

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
  OPENING:    'opening',
});

// 開口の大区分: 建具(戸) / 窓
export const OpeningCategory = Object.freeze({
  FITTING: 'fitting',
  WINDOW:  'window',
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

// 部屋の内外区分
export const RoomKind = Object.freeze({
  INTERIOR: 'interior',  // 屋内
  VOID:     'void',      // 吹抜け
  EXTERIOR: 'exterior',  // 屋外
});

// 構造材の種別（柱・梁共通）
export const StructuralMaterialType = Object.freeze({
  WOOD:  'WOOD',
  STEEL: 'STEEL',
  RC:    'RC',
});

// 画面描画における線の太さの標準パレット（mm）。出図A2/A3セット準拠。
// ワールドmm系（Shape.lineWeight、構造部材の輪郭線）と
// 画面定数系（viewport.lineWeightsPx）の両方がこの定義だけを参照する。
// A1・A4/A5以下セットは出図機能の実装時に追加する。
export const LINE_WEIGHT_MM = Object.freeze({
  ultraThick: 0.5,
  thick:      0.35,
  medium:     0.25,
  thin:       0.13,
});

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

// ================================================================
// SHAPES (グラフエッジ) — 基底クラス
// ================================================================

const SHAPE_DEFAULTS = Object.freeze({
  discipline: Discipline.ARCH,
  layerId:    'default',
  lineWeight: LINE_WEIGHT_MM.medium,
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
    this.isRoomWall  = props?.isRoomWall ?? false; // 部屋外周壁フラグ（chamferWalls で端点を固定）
    this.isExteriorWall = props?.isExteriorWall ?? false; // 外壁フラグ（仕上げモードの外壁ループから生成）
    // 室内側仕上げ厚(mm)。axisOffset = wallBase/2 + wallFinish の内訳のうち仕上げ側のみを保持し、
    // LOD詳細描画で「仕上げ面〜下地境界」の平行線・下地ピッチ線の位置を導出する（生成時のみ確定。null=不明・手動壁）。
    this.wallFinish  = props?.wallFinish ?? null;
    makeObservable(this, {
      clStart:     observable.ref,
      clEnd:       observable.ref,
      axisOffset:  observable,
      startOffset: observable,
      endOffset:   observable,
      axisValue:   computed,
      coord1:      computed,
      coord2:      computed,
    });
  }

  get axisValue() { return this.axisCL.effectiveValue + this.axisOffset; }
  get coord1()    { return this.clStart.effectiveValue + this.startOffset; }
  get coord2()    { return this.clEnd.effectiveValue   + this.endOffset;   }
}

// ----------------------------------------------------------------
// 開口（建具・窓）: 壁と同じ軸CL + オフセット方式で自己完結したアンカーを持つ。
// Wall インスタンスを直接参照しない — 仕上げモード往復で壁は全削除・再生成されるため、
// 表示・編集時に「いまその場所にある壁」を openingGeometry.js の findHostWall で都度検索する。
//
//   wallSide: axisCL のどちら側か（Wall.axisOffset の符号と同義、±1）
//   refCL/refOffset: 壁の長さ方向の基準位置（通常は壁の clStart を流用）
//   hingeSide/swingSide: swing系（片開き戸等）のみ意味を持つ。それ以外は既定値を保持するだけ
// ----------------------------------------------------------------
export class Opening extends Shape {
  constructor(id, axisCL, wallSide, isVertical, refCL, refOffset, width, category, subType, props) {
    super(id, props);
    this.type       = ShapeType.OPENING;
    this.axisCL      = axisCL;     // 壁と同じ軸CL（壁の axisCL と同一参照）
    this.wallSide    = wallSide;   // ±1 — axisCL のどちら側の壁か（Wall.axisOffset の符号と同義）
    this.isVertical  = isVertical; // true: axisCLはVERTICAL, refCLはHORIZONTAL
    this.refCL       = refCL;      // 壁の長さ方向の基準CL（多くは壁の clStart を流用）
    this.refOffset   = refOffset;  // refCL からの符号付きオフセット(mm) — 開口中心位置
    this.width       = width;      // 開口幅(mm)
    this.category    = category;   // OpeningCategory
    this.subType     = subType;    // openingCatalog.js のキー（'singleSwing' 等）
    this.hingeSide   = props?.hingeSide ?? -1; // ±1: 蝶番側（refOffset負/正方向の端）。swing系のみ意味を持つ
    this.swingSide   = props?.swingSide ?? 1;  // ±1: 開く方向（wallSideと同じ/逆の面）。swing系のみ意味を持つ
    makeObservable(this, {
      axisCL:      observable.ref,
      wallSide:    observable,
      refCL:       observable.ref,
      refOffset:   observable,
      width:       observable,
      subType:     observable,
      hingeSide:   observable,
      swingSide:   observable,
      centerCoord: computed,
      coord1:      computed,
      coord2:      computed,
    });
  }
  // 壁の「長さ方向」の座標のみ自己完結で計算できる（軸直交方向の座標はホスト壁から得る）
  get centerCoord() { return this.refCL.effectiveValue + this.refOffset; }
  get coord1()       { return this.centerCoord - this.width / 2; }
  get coord2()       { return this.centerCoord + this.width / 2; }
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
      kind:     ShapeKind.DIMENSION,
      lineType: 'center',
      ...props,
    });
    this.centerLineType = centerLineType;
    this._value         = value;              // 絶対座標値（参照なし時）
    this.pendingDelta   = 0;                  // ドラッグ中の未確定変位（0 = 確定済み）
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
    this._extentLoWall  = null; // 解決済み参照 Wall（PlanGraph が設定）
    this._extentHiWall  = null; // 解決済み参照 Wall（PlanGraph が設定）
    this.label          = '';
    this._referencedCL  = null; // 参照先 CL の参照を保持（PlanGraph が設定）
    makeObservable(this, {
      _value:         observable,
      pendingDelta:   observable,
      refId:          observable,
      refOffset:      observable,
      _referencedCL:  observable,
      value:          computed,
      effectiveValue: computed,
      labeled:        observable,
      trim:         observable,
      label:        observable,
      _extentLo:    observable,
      _extentHi:    observable,
      extentLoRef:  observable,
      extentHiRef:  observable,
      _extentLoCL:   observable,
      _extentHiCL:   observable,
      _extentLoWall: observable.ref,
      _extentHiWall: observable.ref,
      extentLo:      computed,
      extentHi:      computed,
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

  // ドラッグ中の表示座標（pendingDelta=0 の通常時は value と等しい）
  // 参照先 CL がドラッグ中（pendingDelta != 0）の場合は、その effectiveValue に追従する
  // （value は確定値同士の関係を保つため、ここでは effectiveValue 側だけをリアルタイム連動させる）
  get effectiveValue() {
    if (this.refId && this._referencedCL) {
      return this._referencedCL.effectiveValue + this.refOffset + this.pendingDelta;
    }
    return this.value + this.pendingDelta;
  }

  get extentLo() {
    if (this._extentLoWall) return this._extentLoWall.axisValue;
    if (this._extentLoCL && this.extentLoRef != null) {
      return this._extentLoCL.value + (this.extentLoRef.offset ?? 0);
    }
    return this._extentLo;
  }

  get extentHi() {
    if (this._extentHiWall) return this._extentHiWall.axisValue;
    if (this._extentHiCL && this.extentHiRef != null) {
      return this._extentHiCL.value + (this.extentHiRef.offset ?? 0);
    }
    return this._extentHi;
  }
}

// ================================================================
// DIMENSION (寸法線)
//
// 通り芯間 / 中心線間 / おさえ位置 の距離を表示する寸法図形。
// 4 周(top/bottom/left/right)に配置可能。
//
//   kind === GRID:      labeled struct CL を全自動でアンカー化、ガター内表示、足長0
//                       CL の追加・削除・移動に effectiveAnchors の computed で自動追従
//   kind === CENTER:    ラベルなし中心線（補助線除く）を全自動でアンカー化。
//                       軸ごとに最大2行（side=TOP/BOTTOM または LEFT/RIGHT）持ち、
//                       各行は直交する最外通り芯（centerBoundary）に到達している中心線のみを拾う。
//                       「到達」判定はズーム依存のオーバーハングを含む見た目上の延伸範囲（clExtent）基準のため
//                       viewport が必要 → effectiveAnchors/segments では計算できず、
//                       renderer/GutterLayer.jsx が centerBoundary を使って直接組み立てる。
//                       ワールド空間に実寸オフセットして描画。中心線を1本も含まない通り芯間区間は
//                       生成しない（GRID寸法に表示を委ねる）。
//   kind === CONTROL:   壁面・開口など face 位置の寸法。明示的なアンカーを保持
//
// 軸の表現は 'X' / 'Y'。HDimensionLine が横並び(X間距離)、VDimensionLine が縦並び(Y間距離)。
// セグメント長は to.value - from.value を整数 mm に丸めて表示。
// ================================================================

export const DimensionKind = Object.freeze({
  GRID:    'grid',     // 通り芯寸法
  CENTER:  'center',   // 中心線寸法
  CONTROL: 'control',  // おさえ寸法
});

export const DimensionSide = Object.freeze({
  TOP:    'top',
  BOTTOM: 'bottom',
  LEFT:   'left',
  RIGHT:  'right',
});

// ----------------------------------------------------------------
// 寸法アンカー
//   cl 参照型: CL.value に追従(live)
//   座標固定型: coord を直接使用(凍結値)
// ----------------------------------------------------------------
export class DimensionAnchor {
  constructor({ cl = null, offset = 0, coord = null }) {
    this.cl     = cl;
    this.offset = offset;
    this.coord  = coord;
    makeObservable(this, {
      cl:     observable.ref,
      offset: observable,
      coord:  observable,
      value:  computed,
    });
  }
  get value() {
    return this.cl ? this.cl.effectiveValue + this.offset : this.coord;
  }
}

// ----------------------------------------------------------------
// 寸法線基底
// ----------------------------------------------------------------
class DimensionLine extends Shape {
  constructor(id, axis, props = {}) {
    super(id, {
      kind: ShapeKind.DIMENSION,
      ...props,
    });
    this.type          = `${axis === 'X' ? 'h' : 'v'}dimension`;
    this.axis          = axis;
    this.dimensionKind = props.dimensionKind ?? DimensionKind.GRID;
    this.side          = props.side          ?? (axis === 'X' ? DimensionSide.TOP : DimensionSide.LEFT);
    this.anchors       = props.anchors       ?? [];
    this.footLength    = props.footLength    ?? (this.dimensionKind === DimensionKind.GRID ? 0 : 200);
    this.position      = props.position      ?? null;
    this._planGraph    = null;   // PlanGraph が addDimensionLine 時にセット
    makeObservable(this, {
      dimensionKind:    observable,
      side:             observable,
      anchors:          observable,
      footLength:       observable,
      position:         observable,
      effectiveAnchors: computed,
      segments:         computed,
      centerBoundary:   computed,
    });
  }

  // CENTER: この行が基準とする直交軸の最外通り芯座標。TOP/LEFT=min、BOTTOM/RIGHT=max。
  // 直交軸の通り芯が無ければ null（中心線寸法を出す根拠がない）。
  get centerBoundary() {
    if (this.dimensionKind !== DimensionKind.CENTER || !this._planGraph) return null;
    const perpGrids = this.axis === 'X' ? this._planGraph.gridYs : this._planGraph.gridXs;
    if (perpGrids.length === 0) return null;
    const vals = perpGrids.map(cl => cl.value);
    const isNearSide = this.side === DimensionSide.TOP || this.side === DimensionSide.LEFT;
    return isNearSide ? Math.min(...vals) : Math.max(...vals);
  }

  // GRID: labeled struct CL を value 昇順でアンカー化
  // CENTER: 「到達しているか」の判定がズーム依存のオーバーハングを含む見た目上の延伸範囲
  //         （renderer/CenterLinesLayer.jsx の clExtent）に依存するため、viewport を持たない
  //         ここでは計算できない。アンカー組み立ては renderer/GutterLayer.jsx 側が
  //         centerBoundary を使って直接行う（this.anchors は使わない）。
  // 他種別: 明示 anchors
  get effectiveAnchors() {
    if (this.dimensionKind === DimensionKind.GRID && this._planGraph) {
      const cls = this.axis === 'X' ? this._planGraph.gridXs : this._planGraph.gridYs;
      return [...cls]
        .sort((a, b) => a.value - b.value)
        .map(cl => new DimensionAnchor({ cl }));
    }
    return this.anchors;
  }

  // 隣接アンカー間のセグメント (length は整数 mm に丸め)
  get segments() {
    const a = this.effectiveAnchors;
    return a.slice(0, -1).map((from, i) => ({
      from,
      to:     a[i + 1],
      length: Math.round(a[i + 1].value - from.value),
    }));
  }
}

// 横並び寸法線 — X 座標差を測る (上下ガターに配置)
export class HDimensionLine extends DimensionLine {
  constructor(id, props) { super(id, 'X', props); }
}

// 縦並び寸法線 — Y 座標差を測る (左右ガターに配置)
export class VDimensionLine extends DimensionLine {
  constructor(id, props) { super(id, 'Y', props); }
}

// ================================================================
// WALL BACKING MATERIAL (壁下地材)
//
// 下地に使用する材を 1 種定義する。
// x < y を常に保証する（x = 短辺, y = 長辺）。
// ================================================================

export class WallBackingMaterial {
  constructor(id, name, x, y) {
    this.id   = id;
    this.name = name;
    this.x    = Math.min(x, y);
    this.y    = Math.max(x, y);
    makeObservable(this, {
      name:          observable,
      x:             observable,
      y:             observable,
      setName:       action,
      setDimensions: action,
    });
  }
  setName(name) { this.name = name; }
  setDimensions(x, y) { this.x = Math.min(x, y); this.y = Math.max(x, y); }
}

// ================================================================
// EDGE (境界エッジ — 仕上げモードの部屋境界)
//
// 両端をノード（交点）で挟まれ、両側に名称がついた境界セグメントに附帯する
// 情報をまとめる。座標は持たず、CL-ID ベースの安定キーで同定する:
//   key = `${axisCLId}:${startCLId}:${endCLId}`（CL 移動で不変）
//
// データを小さく保つため、本クラスはデータ＋問合せ・書換えのみを持ち、
// 判定・選定（境界マスター選定など）は仕上げモードの function 側で行う。
//   masterType : 選定結果のキャッシュ（BOUNDARY_MASTERS のキー）| null（都度導出可）
//   overrides  : 材の個別上書きポケット（Room.customOverrides と同方式）
// ================================================================

/** エッジ安定キーを組み立てる。 */
export function edgeKey(axisCLId, startCLId, endCLId) {
  return `${axisCLId}:${startCLId}:${endCLId}`;
}

export class Edge {
  constructor(key, masterType = null, overrides = null) {
    this.key        = key;
    this.masterType = masterType;
    this.overrides  = observable.map(); // field → value（材コード等）
    if (overrides) for (const [k, v] of overrides) this.overrides.set(k, v);
    makeObservable(this, {
      masterType:    observable,
      setMasterType: action,
      setOverride:   action,
      clearOverride: action,
    });
  }

  // key の構成要素（必要時に分解）
  get axisCLId()  { return this.key.split(':')[0]; }
  get startCLId() { return this.key.split(':')[1]; }
  get endCLId()   { return this.key.split(':')[2]; }

  setMasterType(t)          { this.masterType = t; }
  setOverride(field, value) { this.overrides.set(field, value); }
  clearOverride(field)      { this.overrides.delete(field); }
}

// ================================================================
// ROOM (仕上げモード — 部屋領域 + 仕上げ情報)
// ================================================================

// 自由文字列の仕上げフィールド。
// 壁材（wallMaterial）・壁仕上げ（wallFinish）・天井高さ（ceilingHeight）は
// 内装マスター（templateKey）+ customOverrides で管理するため、ここには持たない。
export class RoomFinish {
  constructor() {
    this.floorMaterial     = '';
    this.baseboardMaterial = '';
    this.baseboardHeight   = '';
    this.dadoMaterial      = '';
    this.dadoHeight        = '';
    this.ceilingMaterial   = '';
    this.cornice           = '';
    this.note              = '';
    makeObservable(this, {
      floorMaterial:     observable,
      baseboardMaterial: observable,
      baseboardHeight:   observable,
      dadoMaterial:      observable,
      dadoHeight:        observable,
      ceilingMaterial:   observable,
      cornice:           observable,
      note:              observable,
      setField:          action,
    });
  }
  setField(field, value) { this[field] = value; }
}

export class ExteriorFinishRow {
  constructor() {
    this.id     = crypto.randomUUID();
    this.part   = '';
    this.finish = '';
    this.base   = '';
    this.note   = '';
    makeObservable(this, {
      part:     observable,
      finish:   observable,
      base:     observable,
      note:     observable,
      setField: action,
    });
  }
  setField(field, value) { this[field] = value; }
}

// 内装マスター管理の対象フィールド（壁・天井のみ）。
// これらは Room.templateKey（内装マスター参照）+ customOverrides（個別上書き）で管理し、
// getFinishInfo() でマージした実効値を返す。残りの仕上げフィールドは RoomFinish（自由文字列）。
//   wallMaterial  : 壁材（面材コード）
//   wallFinish    : 壁仕上げ（仕上げ材コード）
//   ceilingHeight : 天井高さ mm
export const ROOM_MASTER_FIELDS = Object.freeze(['wallMaterial', 'wallFinish', 'ceilingHeight']);

// per-floor の既定材コード（材マスタ materialData.js 参照）
export const DEFAULT_INTERIOR_WALL_PANEL   = '111111111166'; // 内壁: せっこうボード t=12.5（面材）
export const DEFAULT_EXTERIOR_WALL_BACKING = '111111111155'; // 外壁下地: □-90×45 間柱（下地材）
export const DEFAULT_INTERIOR_WALL_BACKING = '111111111155'; // 内壁下地: □-90×45 間柱（下地材）
export const DEFAULT_CEILING_BACKING       = '111111111162'; // 天井下地: □-45×36 杉等・野縁（下地材、表示のみ）
export const DEFAULT_FLOOR_BACKING         = '111111111157'; // 床下地: □-60×45 杉・松等・床根太（下地材、表示のみ）

// cells は Set<string> — cellKey(xLeftCL, yTopCL) の集合
export class Room {
  constructor(id, name = '', cells = new Set(), referenceRoomIds = new Set(),
              kind = RoomKind.INTERIOR, templateKey = null) {
    this.id               = id;
    this.name             = name;
    this.cells            = cells;
    this.referenceRoomIds = referenceRoomIds; // 判定3: 参照先部屋IDセット
    this.kind             = kind; // 内外区分: 屋内 / 吹抜け / 屋外
    this.templateKey      = templateKey;      // 内装マスターへのポインタ（null = 未指定）
    this.customOverrides  = observable.map(); // 個別上書きポケット（ROOM_MASTER_FIELDS のみ）
    this.finish           = new RoomFinish();
    this.namePosition     = null;   // { x, y } | null — null = roomBounds 重心を使用
    this.floorLevel       = null;   // 階基準からの符号付き床レベル差(mm)。null = 基準どおり
    this.generatedWallIds = new Set(); // 自動生成された Wall の ID を管理（非 observable）
    makeObservable(this, {
      name:             observable,
      cells:            observable,
      referenceRoomIds: observable,
      kind:             observable,
      templateKey:      observable,
      namePosition:     observable.ref,
      floorLevel:       observable,
      setName:          action,
      addCell:          action,
      setCells:         action,
      setKind:          action,
      setTemplateKey:   action,
      setOverride:      action,
      clearOverride:    action,
      setNamePosition:  action,
      setFloorLevel:    action,
    });
  }
  setName(name)              { this.name = name; }
  addCell(key)               { this.cells.add(key); }
  setCells(cells)            { this.cells = cells; }
  setKind(kind)              { this.kind = kind; }
  setNamePosition(x, y)     { this.namePosition = { x, y }; }
  setFloorLevel(mm)         { this.floorLevel = mm; } // mm | null（null = 階基準どおり）

  setTemplateKey(key)        { this.templateKey = key; }

  /**
   * 個別上書き。マスター値と同値なら override を削除し、ポケットを空に保つ。
   * （数値フィールドの型差を吸収するため緩く比較）
   */
  setOverride(field, value) {
    const master = INTERIOR_MASTERS[this.templateKey] ?? {};
    if (field in master && String(master[field]) === String(value)) {
      this.customOverrides.delete(field);
    } else {
      this.customOverrides.set(field, value);
    }
  }
  clearOverride(field)       { this.customOverrides.delete(field); }

  /** 内装マスター + 個別上書きをマージした、壁・天井フィールドの実効値。 */
  getFinishInfo() {
    const master = INTERIOR_MASTERS[this.templateKey] ?? {};
    return { ...master, ...Object.fromEntries(this.customOverrides) };
  }
}

// ================================================================
// STRUCTURAL ENTITIES (構造モード — ラーメン構造の柱・梁)
//
// 柱・梁は自前の座標 (x,y) を持たず、既存 CenterLine の effectiveValue から
// 都度導出する（「CLが座標の源泉」の原則を継承）。
//   柱（StructuralColumn）: Intersection と同じ「垂直CL × 水平CL」の組で位置を導出
//   梁（StructuralBeam）  : Wall と同じ「軸CL + 始端CL + 終端CL」の組を流用
//
// PlanGraph 側の columnMap/beamMap 管理・永続化（FlatBuffers）は別途対応する
// （壁式構造・配置UI本実装と合わせて今回のスコープ外）。
// ================================================================

// トポロジー自動補完の除外集合（PlanGraph.excludedColumnSlots/excludedBeamSlots）で使うキー生成。
// structural/structuralAutoFill.js からも同じキー形式で参照するため export する。
export function columnSlotKey(verticalCL, horizontalCL) {
  return `${verticalCL.id}:${horizontalCL.id}`;
}
// 梁・耐力壁のスパンキー。始端・終端の順序に依存しないよう CL id を昇順に正規化する。
export function spanKey(axisCL, clA, clB) {
  return `${axisCL.id}:${[clA.id, clB.id].sort().join(':')}`;
}

class StructuralEntity {
  constructor(id, materialType, sectionDefId, props = {}) {
    this.id           = id;
    this.materialType = materialType; // StructuralMaterialType の値
    this.sectionDefId = sectionDefId; // 断面形状マスターへの参照ID（マスタ本体は次フェーズ）
    this.memberNo     = null; // 部材番号（荷重バンドから決定的に自動採番、手動編集も可）
    // 部材番号の手動ロック。true のとき自動採番（renumberMembers）で上書きしない（手動編集タグを保持）。
    this.memberNoLocked = props.memberNoLocked ?? false;
    // 寸法の3状態（Tri-state）。'auto'=自動算定値そのまま | 'locked'=手動固定（自動算定で上書きしない）
    // | 'calculated'=構造計算のチェックを通過（現状は暫定の手動トグル。本物の計算ロジックは次フェーズ）。
    this.dimensionStatus = props.dimensionStatus ?? 'auto';
    makeObservable(this, {
      sectionDefId:     observable,
      memberNo:         observable,
      memberNoLocked:   observable,
      dimensionStatus:  observable,
      setMemberNo:      action,
      setMemberNoLocked: action,
      setDimensionStatus: action,
      setField:         action,
    });
  }
  setMemberNo(no) { this.memberNo = no; }
  setMemberNoLocked(locked) { this.memberNoLocked = locked; }
  setDimensionStatus(status) { this.dimensionStatus = status; }
  /** 構造リストタブのフォームから単一フィールドを更新する汎用セッター（StructuralInfo.setField と同型）。 */
  setField(key, value) { this[key] = value; }
}

// ----------------------------------------------------------------
// 柱（StructuralColumn・抽象） — Intersection と同じ「垂直CL × 水平CL」導出方式
//
//   x = verticalCL.effectiveValue   + eccentricity.x
//   y = horizontalCL.effectiveValue + eccentricity.y
//
// eccentricity は平面 2 軸（柱は点なので XY どちらの方向にもズレ得るため、
// Wall.axisOffset のようなスカラーでは表現できない）。
// ----------------------------------------------------------------
export class StructuralColumn extends StructuralEntity {
  constructor(id, materialType, sectionDefId, verticalCL, horizontalCL, props = {}) {
    super(id, materialType, sectionDefId, props);
    this.verticalCL   = verticalCL;   // 柱が立つ交点の垂直CL（X系）
    this.horizontalCL = horizontalCL; // 柱が立つ交点の水平CL（Y系）
    this.eccentricity = props.eccentricity ?? { x: 0, y: 0 }; // 柱芯からの個別偏心量(mm)
    this.rotation     = props.rotation ?? 0; // 平面上の配置角度（強軸・弱軸の向き）
    // 杭は柱と同一クラス（A-1は断面の縦横比だけで柱状/箱状を区別、データ構造は同一という方針）。
    // role='foundation' で杭を表現する（新規サブクラスは作らない）。
    this.role         = props.role         ?? 'standard'; // 'standard' | 'foundation'（杭）
    this.topLevel     = props.topLevel     ?? 0;    // 上端レベル(mm、floorDatum基準)
    this.bottomLevel  = props.bottomLevel  ?? null; // 下端レベル(mm)。杭は下端=杭先端深度として使用
    this.pileType     = props.pileType     ?? '既製杭'; // role==='foundation'のときのみ意味を持つ
    this.pileDiameter = props.pileDiameter ?? null;     // 杭径(mm)
    // 柱が支える概算負担床面積から算定した柱幅（mm）。柱脚サイズ算定の入力値。
    // sectionDefId（カタログ断面）には連動しない参考値（structural/memberSizing.js）。
    this.tributaryWidth = props.tributaryWidth ?? null;
    this._planGraph   = null; // PlanGraph が addColumn/convertColumnMaterial 時にセット（columnAxisOffsets参照用）
    makeObservable(this, {
      verticalCL:   observable.ref,
      horizontalCL: observable.ref,
      eccentricity: observable,
      rotation:     observable,
      role:         observable,
      topLevel:     observable,
      bottomLevel:  observable,
      pileType:     observable,
      pileDiameter: observable,
      tributaryWidth: observable,
      x: computed,
      y: computed,
    });
  }
  // x/y = 通り芯 + 柱芯オフセット（columnAxisOffsets。ラーメン系のみ非0） + 個別偏心量
  get x() {
    const off = this._planGraph?.columnAxisOffsets.get(this.verticalCL.id) ?? 0;
    return this.verticalCL.effectiveValue + off + this.eccentricity.x;
  }
  get y() {
    const off = this._planGraph?.columnAxisOffsets.get(this.horizontalCL.id) ?? 0;
    return this.horizontalCL.effectiveValue + off + this.eccentricity.y;
  }
}

export class WoodColumn extends StructuralColumn {
  constructor(id, sectionDefId, verticalCL, horizontalCL, props = {}) {
    super(id, StructuralMaterialType.WOOD, sectionDefId, verticalCL, horizontalCL, props);
    this.columnType  = props.columnType  ?? '管柱'; // '管柱' | '通し柱' | '隅柱'
    this.woodSpecies = props.woodSpecies ?? '杉';
    makeObservable(this, { columnType: observable, woodSpecies: observable });
  }
}

export class SteelColumn extends StructuralColumn {
  constructor(id, sectionDefId, verticalCL, horizontalCL, props = {}) {
    super(id, StructuralMaterialType.STEEL, sectionDefId, verticalCL, horizontalCL, props);
    this.basePlateDefId = props.basePlateDefId ?? 'BP-DEFAULT';
    makeObservable(this, { basePlateDefId: observable });
  }
}

export class RcColumn extends StructuralColumn {
  constructor(id, sectionDefId, verticalCL, horizontalCL, props = {}) {
    super(id, StructuralMaterialType.RC, sectionDefId, verticalCL, horizontalCL, props);
    this.mainBars = props.mainBars ?? { count: 4, size: 'D19' };
    this.hoopBars = props.hoopBars ?? { size: 'D10', pitch: 100 };
    makeObservable(this, { mainBars: observable, hoopBars: observable });
  }
}

// ----------------------------------------------------------------
// 梁（StructuralBeam・抽象） — Wall と同じ「軸CL + 始端CL + 終端CL」方式
//
//   axisValue = axisCL.effectiveValue + eccentricity
//   coord1    = clStart.effectiveValue
//   coord2    = clEnd.effectiveValue
//
// eccentricity は軸直交方向 1 軸のみのスカラー（Wall.axisOffset と同じ発想。
// 梁の長さ方向は clStart/clEnd で決まるため、もう1自由度は存在しない）。
// ----------------------------------------------------------------
export class StructuralBeam extends StructuralEntity {
  constructor(id, materialType, sectionDefId, axisCL, isVertical, clStart, clEnd, props = {}) {
    super(id, materialType, sectionDefId, props);
    this.axisCL         = axisCL;     // 梁が沿う通り芯
    this.isVertical      = isVertical;
    this.clStart         = clStart;   // 始端の直交CL
    this.clEnd           = clEnd;     // 終端の直交CL
    this.eccentricity    = props.eccentricity ?? 0; // 柱芯からの個別偏心量(mm。材芯=柱芯+eccentricity)
    // 柱外面と梁縁のギャップ(mm。0=面一)。eccentricity の自動算出の基準（ラベル毎に共有する指定値）。
    // eccentricity は派生値: s*((梁幅-既定柱幅)/2 + faceGap)。s=外周側符号。structuralAutoFill.autoBeamEccentricity 参照。
    this.faceGap         = props.faceGap ?? 0;
    this.jointCondition  = props.jointCondition ?? { start: 'RIGID', end: 'RIGID' }; // 剛接合=ラーメン既定
    // 小梁・基礎梁・軒桁・母屋・垂木はサブクラスを増やさず role + 既定値の組み合わせで表現する。
    this.role             = props.role             ?? 'primary'; // primary/secondary/foundation/eaves/roof
    this.levelOffset      = props.levelOffset      ?? 0; // 梁全体の基準レベル(mm、floorDatum基準)
    this.startLevelOffset = props.startLevelOffset ?? 0; // levelOffsetからの始端追加オフセット（屋根部材の勾配用）
    this.endLevelOffset   = props.endLevelOffset   ?? 0; // levelOffsetからの終端追加オフセット
    // 梁幅b・梁成D（mm）。基礎梁(role:'foundation')のみ自動算定対象（structural/memberSizing.js）。
    // sectionDefId（カタログ断面）には連動しない参考値（columnのtributaryWidthと同じ位置づけ）。
    this.beamWidth = props.beamWidth ?? null;
    this.beamDepth = props.beamDepth ?? null;
    // 木造基礎梁（role:'foundation'）の断面詳細寸法（問題.md）。基礎種別ごとのベース／べた基礎の合成断面を
    // 編集可能フィールドとして保持する。非基礎梁は null（断面図がデフォルト値で補完するため未編集分は持たない）。
    //   embedDepth    : 基礎梁の地中部（GL下。立ち上がり = beamDepth − embedDepth）
    //   baseWidth/baseThickness/baseOverhang : ベース幅・厚・屋外側張り出し（なし／土間コン）
    //   matThickness/matTopAboveGL           : べた基礎の厚・天端（GL+）
    this.foundationSection = props.foundationSection ?? null;
    this._planGraph        = null; // PlanGraph が addBeam/convertBeamMaterial 時にセット（columnAxisOffsets参照用）
    makeObservable(this, {
      clStart:          observable.ref,
      clEnd:            observable.ref,
      eccentricity:     observable,
      faceGap:          observable,
      jointCondition:   observable,
      role:             observable,
      levelOffset:      observable,
      startLevelOffset: observable,
      endLevelOffset:   observable,
      beamWidth:        observable,
      beamDepth:        observable,
      foundationSection: observable,
      axisValue: computed,
      coord1:    computed,
      coord2:    computed,
    });
  }
  // axisValue = 通り芯 + 柱芯オフセット（columnAxisOffsets。ラーメン系のみ非0） + 個別偏心量
  get axisValue() {
    const off = this._planGraph?.columnAxisOffsets.get(this.axisCL.id) ?? 0;
    return this.axisCL.effectiveValue + off + this.eccentricity;
  }
  // 端部の直交CLに立つ柱を columns から探す（垂直梁はaxisCLが垂直CL・perpCLが水平CL、水平梁はその逆）。
  // columns は「その伏図に表示される柱集合」——構造モードでは1つ下の階の柱。梁はその表示中の柱の断面手前で
  // 止めるため、自階graph(_planGraph)固定ではなく描画対象の柱集合を外から受け取る（spanForColumns 経由）。
  _columnAtEnd(perpCL, columns) {
    const verticalCL   = this.isVertical ? this.axisCL : perpCL;
    const horizontalCL  = this.isVertical ? perpCL : this.axisCL;
    return columns.find(
      c => c.verticalCL.id === verticalCL.id && c.horizontalCL.id === horizontalCL.id
    ) ?? null;
  }
  // 端部の中心座標と、柱断面の梁方向半幅（柱が無い端部は中心=CL位置+柱芯オフセット、半幅=0）。
  // 柱がある端部は柱の実位置（個別偏心込み）を中心とし、断面寸法を柱の回転角で投影した半幅だけ手前で止める。
  _endCenterAndHalfWidth(perpCL, columns, diaphragm = false) {
    const column = this._columnAtEnd(perpCL, columns);
    if (!column) {
      const off = this._planGraph?.columnAxisOffsets.get(perpCL.id) ?? 0;
      return { center: perpCL.effectiveValue + off, half: 0 };
    }
    const center = this.isVertical ? column.y : column.x;
    const sec = findSectionEntry(column.sectionDefId);
    if (!sec) return { center, half: 0 };
    const rad = (column.rotation ?? 0) * Math.PI / 180;
    // 詳細描画では梁をダイヤフラム（断面+e の四角）まで止める。e は鋼管のみ非0。
    const e = diaphragm ? diaphragmProjection(sec) : 0;
    const w = sec.width + 2 * e, h = sec.height + 2 * e;
    const extent = this.isVertical
      ? Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))
      : Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
    return { center, half: extent / 2 };
  }
  // 表示する柱集合 columns に対し、両端を柱断面手前で止めた始終端座標を返す。
  // 伏図で別階の柱を表示する場合はレンダラが表示中の柱集合を渡す（StructuralLayer.jsx）。
  // opts.diaphragm=true（詳細描画）なら鋼管柱はダイヤフラム端で止める（梁はダイヤフラムまで）。
  spanForColumns(columns, { diaphragm = false } = {}) {
    const a = this._endCenterAndHalfWidth(this.clStart, columns, diaphragm);
    const b = this._endCenterAndHalfWidth(this.clEnd, columns, diaphragm);
    const dir = Math.sign(b.center - a.center) || 1;
    return { coord1: a.center + dir * a.half, coord2: b.center - dir * b.half };
  }
  // coord1/coord2 = 柱がある端部は柱の断面手前（柱の中心ではなく断面まで）、無ければCL位置まで（自階graphの柱基準）。
  get coord1() { return this.spanForColumns(this._planGraph?.columns ?? []).coord1; }
  get coord2() { return this.spanForColumns(this._planGraph?.columns ?? []).coord2; }
}

export class WoodBeam extends StructuralBeam {
  constructor(id, sectionDefId, axisCL, isVertical, clStart, clEnd, props = {}) {
    super(id, StructuralMaterialType.WOOD, sectionDefId, axisCL, isVertical, clStart, clEnd, {
      ...props,
      jointCondition: props.jointCondition ?? { start: 'PIN', end: 'PIN' }, // 木造は基本ピン接合
    });
    this.beamType = props.beamType ?? '大梁'; // '大梁' | '小梁' | '桁' | '小屋梁'
    makeObservable(this, { beamType: observable });
  }
}

export class SteelBeam extends StructuralBeam {
  constructor(id, sectionDefId, axisCL, isVertical, clStart, clEnd, props = {}) {
    super(id, StructuralMaterialType.STEEL, sectionDefId, axisCL, isVertical, clStart, clEnd, props);
    this.isCambered     = props.isCambered     ?? false;
    this.stiffenerCount = props.stiffenerCount ?? 0;
    makeObservable(this, { isCambered: observable, stiffenerCount: observable });
  }
}

export class RcBeam extends StructuralBeam {
  constructor(id, sectionDefId, axisCL, isVertical, clStart, clEnd, props = {}) {
    super(id, StructuralMaterialType.RC, sectionDefId, axisCL, isVertical, clStart, clEnd, props);
    this.topMainBars    = props.topMainBars    ?? { count: 3, size: 'D22' };
    this.bottomMainBars = props.bottomMainBars ?? { count: 3, size: 'D22' };
    this.stirrupBars    = props.stirrupBars    ?? { size: 'D10', pitch: 200 };
    makeObservable(this, { topMainBars: observable, bottomMainBars: observable, stirrupBars: observable });
  }
}

// materialType（StructuralMaterialType）→ サブクラスの解決表（PlanGraph.addColumn/addBeam 用）
const COLUMN_CLASS_BY_MATERIAL = Object.freeze({
  [StructuralMaterialType.WOOD]:  WoodColumn,
  [StructuralMaterialType.STEEL]: SteelColumn,
  [StructuralMaterialType.RC]:    RcColumn,
});
const BEAM_CLASS_BY_MATERIAL = Object.freeze({
  [StructuralMaterialType.WOOD]:  WoodBeam,
  [StructuralMaterialType.STEEL]: SteelBeam,
  [StructuralMaterialType.RC]:    RcBeam,
});

// ----------------------------------------------------------------
// 基礎・柱脚（StructuralFooting・抽象） — StructuralColumn と同じ「垂直CL × 水平CL」導出方式だが
// 継承関係は持たない（柱状(A-1)/箱状(A-2)の意味的区別をクラス階層でも保つ）。
//
//   x = verticalCL.effectiveValue   + eccentricity.x
//   y = horizontalCL.effectiveValue + eccentricity.y
// ----------------------------------------------------------------
class StructuralFooting extends StructuralEntity {
  constructor(id, materialType, sectionDefId, verticalCL, horizontalCL, props = {}) {
    super(id, materialType, sectionDefId, props);
    this.verticalCL    = verticalCL;
    this.horizontalCL  = horizontalCL;
    this.eccentricity  = props.eccentricity  ?? { x: 0, y: 0 };
    this.topLevel       = props.topLevel       ?? null; // 上端レベル(mm)。既定: 直上の柱/柱脚の下端
    this.bottomLevel    = props.bottomLevel    ?? null; // 下端レベル(mm)
    this.sectionShape   = props.sectionShape   ?? 'rect'; // 'rect' | 'round'
    this.widthX         = props.widthX         ?? 1000; // 矩形: Wx（丸の場合は直径として widthX のみ使用）
    this.widthY         = props.widthY         ?? 1000; // 矩形: Wy（丸の場合は無視）
    this._planGraph      = null; // PlanGraph が addFooting 時にセット（columnAxisOffsets参照用。直上の柱と位置を揃える）
    makeObservable(this, {
      verticalCL:   observable.ref,
      horizontalCL: observable.ref,
      eccentricity: observable,
      topLevel:     observable,
      bottomLevel:  observable,
      sectionShape: observable,
      widthX:       observable,
      widthY:       observable,
      x: computed,
      y: computed,
    });
  }
  // x/y = 通り芯 + 柱芯オフセット（直上の柱・杭と同じ基準で揃える） + 個別偏心量
  get x() {
    const off = this._planGraph?.columnAxisOffsets.get(this.verticalCL.id) ?? 0;
    return this.verticalCL.effectiveValue + off + this.eccentricity.x;
  }
  get y() {
    const off = this._planGraph?.columnAxisOffsets.get(this.horizontalCL.id) ?? 0;
    return this.horizontalCL.effectiveValue + off + this.eccentricity.y;
  }
}

// 独立フーチング（基礎） — 柱・杭の直下に置かれる、最も広がった箱
export class IndependentFooting extends StructuralFooting {
  constructor(id, sectionDefId, verticalCL, horizontalCL, props = {}) {
    super(id, props.materialType ?? StructuralMaterialType.RC, sectionDefId, verticalCL, horizontalCL, props);
    this.footingType = props.footingType ?? '独立基礎'; // '独立基礎' | '複合基礎'
    this.mainBars    = props.mainBars    ?? { size: 'D13', pitch: 200 };
    this.supportType = props.supportType ?? '直接基礎'; // '直接基礎' | '杭基礎'
    makeObservable(this, { footingType: observable, mainBars: observable, supportType: observable });
  }
}

// 柱脚 — 柱と基礎/杭頭の間に入る箱状の接合部材。鉄骨/RCの材質分岐はサブクラスを分けず、
// 両フィールド群を共存させ materialType で使う方を切り替える（コンストラクタの簡潔さ優先）。
export class ColumnBase extends StructuralFooting {
  constructor(id, sectionDefId, verticalCL, horizontalCL, props = {}) {
    super(id, props.materialType ?? StructuralMaterialType.RC, sectionDefId, verticalCL, horizontalCL, props);
    this.baseType        = props.baseType        ?? '固定'; // '露出' | '埋込' | 'ピン' | '固定'
    this.basePlateDefId  = props.basePlateDefId  ?? null; // 鉄骨のみ
    this.anchorBoltCount = props.anchorBoltCount ?? null; // 鉄骨のみ
    this.anchorBoltSize  = props.anchorBoltSize  ?? null; // 鉄骨のみ
    this.mainBars        = props.mainBars        ?? null; // RCのみ
    // 基礎柱(ペデスタル)の埋込み深さ・全高(mm)。柱の負担床面積から算定したtributaryWidthの2.3倍を既定値とする
    // （structural/memberSizing.js）。IndependentFootingには持たせない（種別判定は'pedestalDepth' in entity）。
    this.pedestalDepth   = props.pedestalDepth   ?? null;
    makeObservable(this, {
      baseType: observable, basePlateDefId: observable,
      anchorBoltCount: observable, anchorBoltSize: observable, mainBars: observable,
      pedestalDepth: observable,
    });
  }
}

// ----------------------------------------------------------------
// 耐力壁（StructuralWall・抽象） — StructuralBeam と同じ「軸CL + 始端CL + 終端CL」導出方式
//
//   axisValue = axisCL.effectiveValue + eccentricity
//   coord1    = clStart.effectiveValue
//   coord2    = clEnd.effectiveValue
//   length    = |coord2 - coord1|
//
// 架構の Wall と異なり startOffset/endOffset（面取り対応）を持たない —
// 耐力壁は柱・梁と同じく配置インタラクションで直接生成・削除され、
// 仕上げモードのような全削除→再生成サイクルが無いため、自動面取りの対象外。
// ----------------------------------------------------------------
export class StructuralWall extends StructuralEntity {
  constructor(id, materialType, sectionDefId, axisCL, isVertical, clStart, clEnd, props = {}) {
    super(id, materialType, sectionDefId, props);
    this.axisCL       = axisCL;     // 壁が沿う通り芯
    this.isVertical   = isVertical;
    this.clStart      = clStart;    // 始端の直交CL
    this.clEnd        = clEnd;      // 終端の直交CL
    this.eccentricity = props.eccentricity ?? 0;   // axisCLからの符号付き偏心量(mm)
    this.thickness    = props.thickness    ?? 180; // 壁厚(mm) — 連続値の設計パラメータのため直接保持
    this.bottomLevel  = props.bottomLevel  ?? 0;    // 高さ範囲・下端レベル(mm、floorDatum基準)
    this.topLevel     = props.topLevel     ?? null; // 高さ範囲・上端レベル(mm)。null=階高から自動
    // 耐力壁の種別（問題.md）。RC造='rc'（厚指定）／S造='none'|'brace'|'steelPlate'。
    // 現状クラスはRC専用だが、S造の種別選択はメタ属性として保持する（新クラスは次フェーズ）。
    this.wallType     = props.wallType     ?? 'rc'; // 'rc' | 'none' | 'brace' | 'steelPlate'
    makeObservable(this, {
      clStart:      observable.ref,
      clEnd:        observable.ref,
      eccentricity: observable,
      thickness:    observable,
      bottomLevel:  observable,
      topLevel:     observable,
      wallType:     observable,
      axisValue: computed,
      coord1:    computed,
      coord2:    computed,
      length:    computed,
    });
  }
  get axisValue() { return this.axisCL.effectiveValue + this.eccentricity; }
  get coord1()    { return this.clStart.effectiveValue; }
  get coord2()    { return this.clEnd.effectiveValue; }
  get length()    { return Math.abs(this.coord2 - this.coord1); }
}

export class RcBearingWall extends StructuralWall {
  constructor(id, sectionDefId, axisCL, isVertical, clStart, clEnd, props = {}) {
    super(id, StructuralMaterialType.RC, sectionDefId, axisCL, isVertical, clStart, clEnd, props);
    this.verticalBars   = props.verticalBars   ?? { size: 'D10', pitch: 200 }; // たて筋
    this.horizontalBars = props.horizontalBars ?? { size: 'D10', pitch: 200 }; // よこ筋
    makeObservable(this, {
      verticalBars:   observable,
      horizontalBars: observable,
      isStructuralBearingWall: computed,
      crossSectionalArea:      computed,
    });
  }
  // 壁式RC造の最小制限（学会基準等の目安値）: 壁厚150mm以上・壁長450mm以上
  get isStructuralBearingWall() {
    return this.thickness >= 150 && this.length >= 450;
  }
  get crossSectionalArea() {
    return this.isStructuralBearingWall ? this.length * this.thickness : 0;
  }
}

// ----------------------------------------------------------------
// 耐力壁の開口（RcWallOpening） — 親 RcBearingWall を直接参照する。
// 架構の Opening（Wallを直接参照しない自己完結アンカー）とは非対称な設計だが、
// StructuralWall は仕上げモードのような再生成サイクルが無いため直接参照で安全かつ単純。
// ----------------------------------------------------------------
export class RcWallOpening {
  constructor(id, wall, offset, width, props = {}) {
    this.id     = id;
    this.wall   = wall;    // 親 RcBearingWall への直接参照
    this.offset = offset;  // wall.clStart からの符号付き距離(mm) — 開口中心位置
    this.width  = width;   // 開口幅(mm) — 壁の長さ方向
    this.height     = props.height     ?? 2000; // 開口高さ(mm) — 壁量計算上の準耐力壁判定等に使用
    this.sillHeight = props.sillHeight ?? 0;    // 開口下端の高さ(mm、床上)
    this.lintelBars = props.lintelBars ?? { size: 'D13', count: 2 }; // まぐさ補強筋
    this.affectsEffectiveLength = props.affectsEffectiveLength ?? true; // 有効壁長算定への影響フラグ（計算ロジックは対象外）
    makeObservable(this, {
      wall:        observable.ref,
      offset:      observable,
      width:       observable,
      height:      observable,
      sillHeight:  observable,
      lintelBars:  observable,
      affectsEffectiveLength: observable,
      centerCoord: computed,
      coord1:      computed,
      coord2:      computed,
    });
  }
  get centerCoord() { return this.wall.clStart.effectiveValue + this.offset; }
  get coord1()       { return this.centerCoord - this.width / 2; }
  get coord2()       { return this.centerCoord + this.width / 2; }
}

// ----------------------------------------------------------------
// スラブ（StructuralSlab・抽象） — Room と同じ「cells: Set<cellKey>」導出方式。
// cellKey は finish/gridCells.js と同形式（"leftCLId:topCLId:rightCLId:bottomCLId"）。
// CLが削除されて一部セルキーが解決不能になっても Room と同様にデータは保持し、
// 描画時に解決できないセルを無視するだけに留める（teardown 不要）。
// ----------------------------------------------------------------
export class StructuralSlab extends StructuralEntity {
  constructor(id, materialType, sectionDefId, cells, props = {}) {
    super(id, materialType, sectionDefId, props);
    this.cells      = cells ?? new Set();
    this.thickness  = props.thickness  ?? 150; // スラブ厚(mm)
    this.floorLevel = props.floorLevel ?? null; // Room.floorLevel と同じ「疎な例外」方式（null=floorDatumどおり）
    // スラブ・べた基礎・屋根版はサブクラスを増やさず role で区別する。
    this.role           = props.role           ?? 'slab'; // 'slab' | 'mat_foundation' | 'roof_panel'
    this.levelRef       = props.levelRef       ?? 'top';  // 基準レベルが上端基準か下端基準か
    this.slopeDirection = props.slopeDirection ?? null;    // {dx,dy} | null（水平面内の勾配方向、屋根版用）
    this.slopeAngle     = props.slopeAngle     ?? 0;       // 勾配角度(度、0=水平)
    // 厚指定の種別（問題.md）。'slab'=コンクリートスラブ / 'deck'=デッキプレート。
    this.slabKind       = props.slabKind       ?? 'slab'; // 'slab' | 'deck'
    // デッキ方向（slabKind==='deck'のみ意味を持つ）。'x'=X方向 / 'y'=Y方向。描画エリアの両矢印クリックで90度回転。
    this.deckDirection  = props.deckDirection  ?? 'x';   // 'x' | 'y'
    makeObservable(this, {
      cells:          observable,
      thickness:      observable,
      floorLevel:     observable,
      role:           observable,
      levelRef:       observable,
      slopeDirection: observable,
      slopeAngle:     observable,
      slabKind:       observable,
      deckDirection:  observable,
      setCells:       action,
      toggleDeckDirection: action,
    });
  }
  setCells(cells) { this.cells = new Set(cells); }
  // デッキ方向を90度回転（X⇄Y）。描画エリアの両矢印クリック・構造リストのトグルから呼ぶ。
  toggleDeckDirection() { this.deckDirection = this.deckDirection === 'x' ? 'y' : 'x'; }
}

export class RcSlab extends StructuralSlab {
  constructor(id, sectionDefId, cells, props = {}) {
    super(id, StructuralMaterialType.RC, sectionDefId, cells, props);
    this.mainBars         = props.mainBars         ?? { size: 'D10', pitch: 200 }; // 主筋（短辺方向）
    this.distributionBars = props.distributionBars ?? { size: 'D10', pitch: 200 }; // 配力筋（長辺方向）
    makeObservable(this, { mainBars: observable, distributionBars: observable });
  }
}

// ----------------------------------------------------------------
// 貫通孔（PenetrationSleeve） — 梁(B)・スラブ(C)の配管/配線貫通孔。
// 意匠Openingと同じ設計パターンで、ホスト構造材を直接参照せず自己完結アンカーを持つ
// （StructuralEntity は継承しない＝materialType/sectionDefId/memberNo の採番対象外）。
// ----------------------------------------------------------------
export class PenetrationSleeve {
  constructor(id, hostType, props = {}) {
    this.id       = id;
    this.hostType = hostType; // 'beam' | 'slab'
    // 梁ホスト用アンカー（hostBeamId は同一CL上に複数梁がある場合の連鎖削除の一意特定用）
    this.hostBeamId   = props.hostBeamId   ?? null;
    this.hostAxisCL   = props.hostAxisCL   ?? null;
    this.hostClStart  = props.hostClStart  ?? null;
    this.hostClEnd    = props.hostClEnd    ?? null;
    this.localPos     = props.localPos     ?? 0; // 軸方向ローカル位置(clStartからのmm)
    this.heightOffset = props.heightOffset ?? 0; // 梁上端基準の断面内高さ位置(mm)
    // スラブホスト用アンカー（hostSlabId は連鎖削除の一意特定用）
    this.hostSlabId = props.hostSlabId ?? null;
    this.hostCellKey = props.hostCellKey ?? null;
    this.localX     = props.localX     ?? 0; // セル内ローカルx
    this.localY     = props.localY     ?? 0; // セル内ローカルy
    // 共通
    this.diameter         = props.diameter         ?? 100;   // 径(mm)
    this.hasReinforcement = props.hasReinforcement ?? false; // 補強プレート有無
    makeObservable(this, {
      hostAxisCL:  observable.ref,
      hostClStart: observable.ref,
      hostClEnd:   observable.ref,
      localPos:      observable,
      heightOffset:  observable,
      hostCellKey:   observable,
      localX:        observable,
      localY:        observable,
      diameter:         observable,
      hasReinforcement: observable,
    });
  }
}

// materialType（StructuralMaterialType）→ サブクラスの解決表（PlanGraph.addBearingWall/addSlab 用）
const WALL_CLASS_BY_MATERIAL = Object.freeze({
  [StructuralMaterialType.RC]: RcBearingWall,
});
const SLAB_CLASS_BY_MATERIAL = Object.freeze({
  [StructuralMaterialType.RC]: RcSlab,
});

// ================================================================
// PLANE (平面 = XY平面 1枚 + 高さ 1つ)
// ================================================================

export class Plane {
  constructor(id, elevation, name = '', startFloor = 1, stories = 1,
              isAlternative = false, referenceId = null, altIndex = 0,
              isRoofPlane = false, roofForPlaneId = null) {
    this.id            = id;
    this.elevation     = elevation;
    this.name          = name;
    this.startFloor    = startFloor;
    this.stories       = stories;
    this.isAlternative = isAlternative; // true = 検討
    this.referenceId   = referenceId;   // 検討の場合、採用の plane.id
    this.altIndex      = altIndex;      // 検討の表示順
    // 屋根専用平面（小屋伏／R階伏）。構造モードでのみ使う合成平面で、フロアタブ・階番号ロジックの対象外。
    this.isRoofPlane    = isRoofPlane;
    this.roofForPlaneId = roofForPlaneId; // どの実体平面の上に乗る屋根平面か（structural/roofPlane.js 参照）
    makeObservable(this, {
      elevation:      observable,
      name:           observable,
      startFloor:     observable,
      stories:        observable,
      isAlternative:  observable,
      referenceId:    observable,
      altIndex:       observable,
      isRoofPlane:    observable,
      roofForPlaneId: observable,
    });
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

    this.intersectionMap     = observable.map(); // id → Intersection
    this.shapeMap            = observable.map(); // id → Shape (CenterLine含む)
    this.pointMap            = observable.map(); // id → Point (自由位置ノード)
    this.roomMap             = observable.map(); // id → Room
    this.roomOrder           = observable.array([]); // 仕上げ表の表示順 — Room ID の配列
    this.exteriorRows        = observable.array([]); // 外部仕上げ行
    this.exteriorFittingRows = observable.array([]); // 外部建具仕上げ行
    this.structureRows       = observable.array([]); // 構造仕上げ行
    this.backingMaterialMap  = observable.map(); // id → WallBackingMaterial（手動 WallDialog 用に温存）
    this.edgeMap             = observable.map(); // edgeKey → Edge（仕上げモード境界）
    this.columnMap           = observable.map(); // id → StructuralColumn（構造モード、shapeMap外で管理）
    this.beamMap             = observable.map(); // id → StructuralBeam（構造モード、shapeMap外で管理）
    this.wallMap             = observable.map(); // id → StructuralWall（構造モード・耐力壁、shapeMap外で管理）
    this.wallOpeningMap      = observable.map(); // id → RcWallOpening（耐力壁の開口）
    this.slabMap             = observable.map(); // id → StructuralSlab（構造モード・スラブ、shapeMap外で管理）
    this.footingMap          = observable.map(); // id → IndependentFooting | ColumnBase（構造モード・基礎・柱脚）
    this.sleeveMap           = observable.map(); // id → PenetrationSleeve（構造モード・梁・スラブの貫通孔）

    // 柱芯（ColumnAxis）: labeled struct CL の id → 通り芯からの偏心量(mm)。未登録キー=0（通り芯と一致）。
    // ラーメン系（S造/SRC造/RC造(ラーメン)）でのみ非0になる（structural/structuralAutoFill.js が自動生成）。
    this.columnAxisOffsets = observable.map();

    // トポロジー自動補完で「ユーザーが明示的に削除した箇所」を記憶する除外集合（per-floor、永続化対象）。
    // キーは柱・フーチング: `${verticalCL.id}:${horizontalCL.id}`、梁: spanKey()（始端終端の順序非依存）。
    this.excludedColumnSlots  = observable.set();
    this.excludedBeamSlots    = observable.set();
    this.excludedFootingSlots = observable.set();

    // per-floor 設定（仕上げモード）— 材コード（選択された材として永続化）
    this.interiorWallPanel   = DEFAULT_INTERIOR_WALL_PANEL;   // 内壁: 面材コード
    this.exteriorWallBacking = DEFAULT_EXTERIOR_WALL_BACKING; // 外壁下地: 下地材コード
    this.interiorWallBacking = DEFAULT_INTERIOR_WALL_BACKING; // 内壁下地: 下地材コード
    // 天井・床下地は表示のみ（共通仕様タブで保存するが、断面計算には未接続。
    // 将来、天井・床の層構成モデルを導入する際に edgeComposition.js 側で接続する）
    this.ceilingBacking      = DEFAULT_CEILING_BACKING;       // 天井下地: 下地材コード
    this.floorBacking        = DEFAULT_FLOOR_BACKING;         // 床下地: 下地材コード

    // この階の設計用床レベル(mm)。部屋は Room.floorLevel（基準からの符号付き差）で逸脱を表す。
    this.floorDatum          = 0;

    // 主要構造の階ごとの例外（null = project.structuralInfo.mainStructure を継承）
    this.structureOverride   = null;

    // 全階共通の通り芯グラフ（Project.structGraph）への参照。
    // null = このグラフ自身が structGraph（通り芯専用グラフ）。
    this._structGraph = null;

    this._shapeLinks = new Map(); // shapeId → ngraph.Link

    makeObservable(this, {
      _structGraph:        observable.ref,
      gridXs:              computed,
      gridYs:              computed,
      intersections:       computed,
      points:              computed,
      shapes:              computed,
      generalShapes:       computed,
      walls:               computed,
      openings:            computed,
      columns:             computed,
      beams:               computed,
      structuralWalls:     computed,
      wallOpenings:        computed,
      slabs:               computed,
      footings:            computed,
      sleeves:             computed,
      centerLines:         computed,
      dimensionLines:      computed,
      addCenterLine:          action,
      resolveExtentWallRefs:  action,
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
      addOpening:             action,
      addColumn:              action,
      addBeam:                action,
      removeColumn:           action,
      removeBeam:             action,
      addBearingWall:         action,
      addWallOpening:         action,
      addSlab:                action,
      removeWall:             action,
      removeWallOpening:      action,
      removeSlab:             action,
      addFooting:             action,
      removeFooting:          action,
      addSleeve:              action,
      removeSleeve:           action,
      addDimensionLine:       action,
      removeDimensionLine:    action,
      removeShape:            action,
      clear:                  action,
      clearFloorData:         action,
      getOrCreateIntersection:action,
      chamferWalls:             action,
      trimIntersectingWalls:    action,
      _relabelCenterLines:      action,
      addRoom:                  action,
      removeRoom:               action,
      reorderRooms:             action,
      rooms:                    computed,
      addExteriorRow:           action,
      removeExteriorRow:        action,
      removeExteriorRowGroup:   action,
      interiorWallPanel:        observable,
      exteriorWallBacking:      observable,
      interiorWallBacking:      observable,
      ceilingBacking:           observable,
      floorBacking:             observable,
      floorDatum:               observable,
      structureOverride:        observable,
      setInteriorWallPanel:     action,
      setExteriorWallBacking:   action,
      setInteriorWallBacking:   action,
      setCeilingBacking:        action,
      setFloorBacking:          action,
      setFloorDatum:            action,
      setStructureOverride:     action,
      setColumnAxisOffset:  action,
      backingMaterials:         computed,
      addBackingMaterial:       action,
      removeBackingMaterial:    action,
      edges:                    computed,
      addEdge:                  action,
      removeEdge:               action,
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
    // w.axisValue は effectiveValue 経由なので pendingDelta でも発火してしまう。
    // cl.value を直接参照することで、ドラッグ中（pendingDelta 変化時）の無用な発火を防ぐ。
    reaction(
      () => this.walls.map(w => [w.axisCL.value + w.axisOffset, w.isVertical, w.clStart.value, w.clEnd.value]),
      () => this.chamferWalls(),
      { fireImmediately: true },
    );
  }

  // ---- computed views ----

  // グリッド軸として機能する labeled:true VERTICAL CenterLine (= 旧 GridX 相当)
  // _structGraph がある場合は通り芯（全階共通）も含める
  get gridXs() {
    const own = [...this.shapeMap.values()]
      .filter(s => s instanceof CenterLine && s.centerLineType === CenterLineType.VERTICAL && s.labeled);
    const struct = this._structGraph
      ? [...this._structGraph.shapeMap.values()]
          .filter(s => s instanceof CenterLine && s.centerLineType === CenterLineType.VERTICAL && s.labeled)
      : [];
    return [...struct, ...own].sort((a, b) => a.value - b.value);
  }

  // グリッド軸として機能する labeled:true HORIZONTAL CenterLine (= 旧 GridY 相当)
  get gridYs() {
    const own = [...this.shapeMap.values()]
      .filter(s => s instanceof CenterLine && s.centerLineType === CenterLineType.HORIZONTAL && s.labeled);
    const struct = this._structGraph
      ? [...this._structGraph.shapeMap.values()]
          .filter(s => s instanceof CenterLine && s.centerLineType === CenterLineType.HORIZONTAL && s.labeled)
      : [];
    return [...struct, ...own].sort((a, b) => a.value - b.value);
  }

  // 交点: structGraph の交点（通り芯×通り芯）+ 自グラフの交点（通り芯×階固有CL等）
  get intersections() {
    const own = [...this.intersectionMap.values()];
    if (!this._structGraph) return own;
    return [...this._structGraph.intersectionMap.values(), ...own];
  }

  get points()        { return [...this.pointMap.values()]; }
  get shapes()        { return [...this.shapeMap.values()]; }
  get generalShapes() { return [...this.shapeMap.values()].filter(s => s.kind === ShapeKind.GENERAL); }
  get walls()         { return [...this.shapeMap.values()].filter(s => s.type === ShapeType.WALL); }
  get openings()      { return [...this.shapeMap.values()].filter(s => s.type === ShapeType.OPENING); }
  get columns()       { return [...this.columnMap.values()]; }
  get beams()         { return [...this.beamMap.values()]; }
  get structuralWalls() { return [...this.wallMap.values()]; }
  get wallOpenings()    { return [...this.wallOpeningMap.values()]; }
  get slabs()           { return [...this.slabMap.values()]; }
  get footings()        { return [...this.footingMap.values()]; }
  get sleeves()         { return [...this.sleeveMap.values()]; }

  // CenterLine: 自グラフ（階固有）+ structGraph（通り芯）の両方を返す
  get centerLines() {
    const own = [...this.shapeMap.values()].filter(s => s instanceof CenterLine);
    if (!this._structGraph) return own;
    const struct = [...this._structGraph.shapeMap.values()].filter(s => s instanceof CenterLine);
    return [...struct, ...own];
  }

  get dimensionLines(){ return [...this.shapeMap.values()].filter(s => s instanceof DimensionLine); }
  get rooms() {
    return this.roomOrder
      .filter(id => this.roomMap.has(id))
      .map(id => this.roomMap.get(id));
  }

  addRoom(cells, name = '', id = crypto.randomUUID(), referenceRoomIds = new Set()) {
    const room = new Room(id, name, cells, referenceRoomIds);
    this.roomMap.set(room.id, room);
    // 部分指定（referenceRoomIds あり）は参照先の最後尾の直後に挿入
    if (referenceRoomIds.size > 0) {
      let insertAt = -1;
      for (let i = 0; i < this.roomOrder.length; i++) {
        if (referenceRoomIds.has(this.roomOrder[i])) insertAt = i;
      }
      if (insertAt >= 0) {
        this.roomOrder.splice(insertAt + 1, 0, id);
      } else {
        this.roomOrder.push(id);
      }
    } else {
      this.roomOrder.push(id);
    }
    return room;
  }

  removeRoom(id) {
    this.roomMap.delete(id);
    const idx = this.roomOrder.indexOf(id);
    if (idx >= 0) this.roomOrder.splice(idx, 1);
  }

  reorderRooms(newOrder) {
    this.roomOrder.replace(newOrder);
  }

  addExteriorRow(category, part = '') {
    const row = new ExteriorFinishRow();
    if (part) row.setField('part', part);
    this[category].push(row);
    return row;
  }

  removeExteriorRow(category, id) {
    const arr = this[category];
    const idx = arr.findIndex(r => r.id === id);
    if (idx >= 0) arr.splice(idx, 1);
  }

  removeExteriorRowGroup(category, part) {
    const arr = this[category];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].part === part) arr.splice(i, 1);
    }
  }

  // ---- per-floor 設定（内壁面材 / 外壁下地 / 内壁下地 / 天井・床下地）----

  setInteriorWallPanel(code)   { this.interiorWallPanel   = code; }
  setExteriorWallBacking(code) { this.exteriorWallBacking = code; }
  setInteriorWallBacking(code) { this.interiorWallBacking = code; }
  setCeilingBacking(code)      { this.ceilingBacking      = code; }
  setFloorBacking(code)        { this.floorBacking        = code; }
  setFloorDatum(mm) { this.floorDatum = mm; }
  setStructureOverride(v) { this.structureOverride = v; }

  /** 柱芯オフセット（CL id → 通り芯からの偏心量mm）を1件設定する。 */
  setColumnAxisOffset(clId, value) { this.columnAxisOffsets.set(clId, value); }

  /** 部屋の実効床レベル(mm) = 階基準 + 部屋デルタ（null = 基準どおり）。 */
  effectiveFloorLevel(room) { return this.floorDatum + (room?.floorLevel ?? 0); }
  /** 段差の高低差(mm) = level(roomB) − level(roomA)（導出値・保持しない）。 */
  floorLevelDiff(roomA, roomB) {
    return this.effectiveFloorLevel(roomB) - this.effectiveFloorLevel(roomA);
  }

  // ---- 壁下地材操作（手動 WallDialog 用）----

  get backingMaterials() { return [...this.backingMaterialMap.values()]; }

  addBackingMaterial(name, x, y, id = crypto.randomUUID()) {
    const mat = new WallBackingMaterial(id, name, x, y);
    this.backingMaterialMap.set(mat.id, mat);
    return mat;
  }

  removeBackingMaterial(id) { this.backingMaterialMap.delete(id); }

  // ---- 境界エッジ操作（仕上げモード）----

  get edges() { return [...this.edgeMap.values()]; }

  /** edgeKey でエッジを追加・取得。overrides は [key, value] のイテラブル（任意）。 */
  addEdge(key, masterType = null, overrides = null) {
    const e = new Edge(key, masterType, overrides);
    this.edgeMap.set(e.key, e);
    return e;
  }

  removeEdge(key) { this.edgeMap.delete(key); }
  getEdge(key)    { return this.edgeMap.get(key) ?? null; }

  // ---- 構造材操作（柱・梁、構造モード）----
  // shapeMap・ngraph には参加しない（Wall/Edge と異なり階固有データのみ）。

  /** materialType（StructuralMaterialType）に応じたサブクラスで柱を追加する。
   *  トポロジー自動補完の除外集合（excludedColumnSlots）からも対応キーを解除する
   *  （ユーザーが「＋追加」等で明示的に再追加した場合、以後の自動補完対象に戻す）。 */
  addColumn(materialType, sectionDefId, verticalCL, horizontalCL, props, id = crypto.randomUUID()) {
    const ColumnClass = COLUMN_CLASS_BY_MATERIAL[materialType];
    const c = new ColumnClass(id, sectionDefId, verticalCL, horizontalCL, props);
    c._planGraph = this;
    this.columnMap.set(c.id, c);
    this.excludedColumnSlots.delete(columnSlotKey(verticalCL, horizontalCL));
    return c;
  }

  /** materialType（StructuralMaterialType）に応じたサブクラスで梁を追加する。excludedBeamSlots も同様に解除する。 */
  addBeam(materialType, sectionDefId, axisCL, isVertical, clStart, clEnd, props, id = crypto.randomUUID()) {
    const BeamClass = BEAM_CLASS_BY_MATERIAL[materialType];
    const b = new BeamClass(id, sectionDefId, axisCL, isVertical, clStart, clEnd, props);
    b._planGraph = this;
    this.beamMap.set(b.id, b);
    this.excludedBeamSlots.delete(spanKey(axisCL, clStart, clEnd));
    return b;
  }

  /** 柱を削除する。対応スロットを excludedColumnSlots に記録し、次回以降の自動補完で復活しないようにする。 */
  removeColumn(id) {
    const c = this.columnMap.get(id);
    if (c) this.excludedColumnSlots.add(columnSlotKey(c.verticalCL, c.horizontalCL));
    this.columnMap.delete(id);
  }

  /** 梁を削除する。対応スロットを excludedBeamSlots に記録し、子の PenetrationSleeve（梁ホスト）も連鎖削除する。 */
  removeBeam(id) {
    const b = this.beamMap.get(id);
    if (b) this.excludedBeamSlots.add(spanKey(b.axisCL, b.clStart, b.clEnd));
    [...this.sleeveMap.values()].filter(s => s.hostBeamId === id).forEach(s => this.sleeveMap.delete(s.id));
    this.beamMap.delete(id);
  }

  /** 既存柱を別materialTypeのサブクラスへ変換する（id維持・共通フィールド引き継ぎ、材種別フィールドは新クラス既定値）。
   *  主要構造変更時の部材自動変換（structural/structuralAutoFill.js の convertMembersToEffectiveMaterial）専用。 */
  convertColumnMaterial(column, materialType, sectionDefId) {
    const ColumnClass = COLUMN_CLASS_BY_MATERIAL[materialType];
    const next = new ColumnClass(column.id, sectionDefId, column.verticalCL, column.horizontalCL, {
      eccentricity: column.eccentricity, rotation: column.rotation, role: column.role,
      topLevel: column.topLevel, bottomLevel: column.bottomLevel,
      pileType: column.pileType, pileDiameter: column.pileDiameter,
    });
    next._planGraph = this;
    this.columnMap.set(column.id, next);
    return next;
  }

  /** 既存梁を別materialTypeのサブクラスへ変換する（id維持・共通フィールド引き継ぎ）。 */
  convertBeamMaterial(beam, materialType, sectionDefId) {
    const BeamClass = BEAM_CLASS_BY_MATERIAL[materialType];
    const next = new BeamClass(beam.id, sectionDefId, beam.axisCL, beam.isVertical, beam.clStart, beam.clEnd, {
      eccentricity: beam.eccentricity, jointCondition: beam.jointCondition, role: beam.role,
      levelOffset: beam.levelOffset, startLevelOffset: beam.startLevelOffset, endLevelOffset: beam.endLevelOffset,
    });
    next._planGraph = this;
    this.beamMap.set(beam.id, next);
    return next;
  }

  /** materialType（StructuralMaterialType）に応じたサブクラスで耐力壁を追加する。 */
  addBearingWall(materialType, sectionDefId, axisCL, isVertical, clStart, clEnd, props, id = crypto.randomUUID()) {
    const WallClass = WALL_CLASS_BY_MATERIAL[materialType];
    const w = new WallClass(id, sectionDefId, axisCL, isVertical, clStart, clEnd, props);
    this.wallMap.set(w.id, w);
    return w;
  }

  addWallOpening(wall, offset, width, props, id = crypto.randomUUID()) {
    const o = new RcWallOpening(id, wall, offset, width, props);
    this.wallOpeningMap.set(o.id, o);
    return o;
  }

  /** materialType（StructuralMaterialType）に応じたサブクラスでスラブを追加する。 */
  addSlab(materialType, sectionDefId, cells, props, id = crypto.randomUUID()) {
    const SlabClass = SLAB_CLASS_BY_MATERIAL[materialType];
    const s = new SlabClass(id, sectionDefId, cells, props);
    this.slabMap.set(s.id, s);
    return s;
  }

  // removeWall は子の RcWallOpening も連鎖削除する（架構の壁削除と同じ「親削除で子も消す」規約）
  removeWall(id) {
    [...this.wallOpeningMap.values()]
      .filter(o => o.wall.id === id)
      .forEach(o => this.wallOpeningMap.delete(o.id));
    this.wallMap.delete(id);
  }

  removeWallOpening(id) { this.wallOpeningMap.delete(id); }

  /** スラブを削除する。子の PenetrationSleeve（スラブホスト）も連鎖削除する。 */
  removeSlab(id) {
    [...this.sleeveMap.values()].filter(s => s.hostSlabId === id).forEach(s => this.sleeveMap.delete(s.id));
    this.slabMap.delete(id);
  }

  /** kind（'independent'=独立フーチング | 'base'=柱脚）に応じたクラスで基礎・柱脚を追加する。
   *  トポロジー自動補完の除外集合（excludedFootingSlots）からも対応キーを解除する。 */
  addFooting(kind, sectionDefId, verticalCL, horizontalCL, props, id = crypto.randomUUID()) {
    const FootingClass = kind === 'independent' ? IndependentFooting : ColumnBase;
    const f = new FootingClass(id, sectionDefId, verticalCL, horizontalCL, props);
    f._planGraph = this;
    this.footingMap.set(f.id, f);
    this.excludedFootingSlots.delete(columnSlotKey(verticalCL, horizontalCL));
    return f;
  }

  /** 基礎・柱脚を削除する。対応スロットを excludedFootingSlots に記録し、次回以降の自動補完で復活しないようにする。 */
  removeFooting(id) {
    const f = this.footingMap.get(id);
    if (f) this.excludedFootingSlots.add(columnSlotKey(f.verticalCL, f.horizontalCL));
    this.footingMap.delete(id);
  }

  /** hostType（'beam' | 'slab'）に応じて貫通孔を追加する。 */
  addSleeve(hostType, props, id = crypto.randomUUID()) {
    const s = new PenetrationSleeve(id, hostType, props);
    this.sleeveMap.set(s.id, s);
    return s;
  }

  removeSleeve(id) { this.sleeveMap.delete(id); }

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
    // 自グラフで見つからない場合は _structGraph も検索する（中心線が通り芯を参照するケース）
    if (cl.refId) {
      const refCL = this.shapeMap.get(cl.refId) ?? this._structGraph?.shapeMap.get(cl.refId);
      if (refCL instanceof CenterLine) cl._referencedCL = refCL;
    }
    // extentLoRef/HiRef がある場合、参照先 CL または Wall への参照を解決
    if (cl.extentLoRef) {
      if (cl.extentLoRef.clId) {
        const loCL = this.shapeMap.get(cl.extentLoRef.clId)
                  ?? this._structGraph?.shapeMap.get(cl.extentLoRef.clId);
        if (loCL instanceof CenterLine) cl._extentLoCL = loCL;
      } else if (cl.extentLoRef.wallId) {
        const loWall = this.shapeMap.get(cl.extentLoRef.wallId);
        if (loWall?.type === ShapeType.WALL) cl._extentLoWall = loWall;
      }
    }
    if (cl.extentHiRef) {
      if (cl.extentHiRef.clId) {
        const hiCL = this.shapeMap.get(cl.extentHiRef.clId)
                  ?? this._structGraph?.shapeMap.get(cl.extentHiRef.clId);
        if (hiCL instanceof CenterLine) cl._extentHiCL = hiCL;
      } else if (cl.extentHiRef.wallId) {
        const hiWall = this.shapeMap.get(cl.extentHiRef.wallId);
        if (hiWall?.type === ShapeType.WALL) cl._extentHiWall = hiWall;
      }
    }
    this.shapeMap.set(cl.id, cl);
    if (cl.labeled) this._createIntersections(cl);
    return cl;
  }

  /**
   * 補助線の extentLoRef/HiRef に wallId がある場合、壁への参照を解決する。
   * restoreGraph で壁を追加した後に呼ぶ。
   */
  resolveExtentWallRefs() {
    for (const cl of this.centerLines) {
      if (cl.extentLoRef?.wallId) {
        const loWall = this.shapeMap.get(cl.extentLoRef.wallId);
        if (loWall?.type === ShapeType.WALL) cl._extentLoWall = loWall;
      }
      if (cl.extentHiRef?.wallId) {
        const hiWall = this.shapeMap.get(cl.extentHiRef.wallId);
        if (hiWall?.type === ShapeType.WALL) cl._extentHiWall = hiWall;
      }
    }
  }

  /**
   * 中心線を完全削除する。依存する Intersection・Shape も連鎖削除される。
   * @param {string} id  CenterLine の id
   */
  removeCenterLine(id) {
    const cl = this.shapeMap.get(id);
    if (!(cl instanceof CenterLine)) return;
    this._reparentChildCenterLines(cl);
    this._teardownCenterLine(id);
    this._removeShape(id);
  }

  // 削除される CL を直接参照している子 CL の参照を繰り上げる
  _reparentChildCenterLines(deletedCL) {
    const children = [...this.shapeMap.values()]
      .filter(s => s instanceof CenterLine && s.refId === deletedCL.id);
    for (const child of children) {
      if (deletedCL.refId) {
        child.refOffset = child.refOffset + deletedCL.refOffset;
        child.refId = deletedCL.refId;
        child._referencedCL = deletedCL._referencedCL;
      } else {
        child._value = child.value;
        child.refId = null;
        child._referencedCL = null;
      }

      // (debug logging removed)
    }
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

  addOpening(axisCL, wallSide, isVertical, refCL, refOffset, width, category, subType, props, id = crypto.randomUUID()) {
    const o = new Opening(id, axisCL, wallSide, isVertical, refCL, refOffset, width, category, subType, props);
    this.shapeMap.set(o.id, o);
    return o;
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
        if (!v.isRoomWall && Math.min(Math.abs(vys - hy), Math.abs(vye - hy)) <= tolerance) {
          _trimWallEnd(v, hy, h.axisCL, h.axisOffset);
          _extendWallEnd(v, hy, h.axisCL, h.axisOffset, tolerance);
        }

        if (!h.isRoomWall && Math.min(Math.abs(hxs - vx), Math.abs(hxe - vx)) <= tolerance) {
          _trimWallEnd(h, vx, v.axisCL, v.axisOffset);
          _extendWallEnd(h, vx, v.axisCL, v.axisOffset, tolerance);
        }
      }
    }
  }

  /**
   * 新規壁追加時の入隅・出隅トリム処理。
   *
   * 追加された壁と直交する既存壁を走査し、face 座標ベースで近接する場合、
   * 両壁の最近傍端点を互いの face 位置にスナップする。
   * 入隅（face が壁範囲内に交差）・出隅（face が壁端点から tolerance 以内）の両方を処理する。
   *
   * @param {Wall} newWall  追加直後の壁
   * @param {number} [tolerance=150]  出隅検出の距離閾値 (mm)
   * @returns {{ wall, clStart, startOffset, clEnd, endOffset }[]}  Undo用スナップショット
   */
  trimIntersectingWalls(newWall, tolerance = 150) {
    const snapshots = [];
    const perpWalls = this.walls.filter(w => w !== newWall && w.isVertical !== newWall.isVertical);
    for (const existing of perpWalls) {
      const [v, h] = newWall.isVertical ? [newWall, existing] : [existing, newWall];

      const vx  = v.axisValue;
      const vy1 = Math.min(v.coord1, v.coord2);
      const vy2 = Math.max(v.coord1, v.coord2);
      const hy  = h.axisValue;
      const hx1 = Math.min(h.coord1, h.coord2);
      const hx2 = Math.max(h.coord1, h.coord2);

      // 近接チェック: face 座標が tolerance 以内なら入隅・出隅ともに対象
      if (vx < hx1 - tolerance || vx > hx2 + tolerance) continue;
      if (hy < vy1 - tolerance || hy > vy2 + tolerance) continue;

      snapshots.push({
        wall: existing,
        clStart: existing.clStart, startOffset: existing.startOffset,
        clEnd:   existing.clEnd,   endOffset:   existing.endOffset,
      });

      const MIN_LEN = 1; // mm: 最小残存長

      // 垂直壁: face に最も近い端を faceY にスナップ
      {
        const faceY = h.axisCL.value + h.axisOffset;
        if (v.coord1 <= v.coord2) {
          // coord1 が上側 (小さい y)
          const cand = faceY - v.clStart.value;
          const candCoord1 = v.clStart.value + cand;
          const otherCoord = v.clEnd.value + v.endOffset;
          if (candCoord1 + MIN_LEN < otherCoord) {
            v.startOffset = cand;
          }
        } else {
          // coord2 が上側 (小さい y)
          const cand = faceY - v.clEnd.value;
          const candCoord2 = v.clEnd.value + cand;
          const otherCoord = v.clStart.value + v.startOffset;
          if (candCoord2 + MIN_LEN < otherCoord) {
            v.endOffset = cand;
          }
        }
      }

      // 水平壁: face に最も近い端を faceX にスナップ
      {
        const faceX = v.axisCL.value + v.axisOffset;
        if (h.coord1 <= h.coord2) {
          // coord1 が左側 (小さい x)
          const cand = faceX - h.clStart.value;
          const candCoord1 = h.clStart.value + cand;
          const otherCoord = h.clEnd.value + h.endOffset;
          if (candCoord1 + MIN_LEN < otherCoord) {
            h.startOffset = cand;
          }
        } else {
          // coord2 が左側 (小さい x)
          const cand = faceX - h.clEnd.value;
          const candCoord2 = h.clEnd.value + cand;
          const otherCoord = h.clStart.value + h.startOffset;
          if (candCoord2 + MIN_LEN < otherCoord) {
            h.endOffset = cand;
          }
        }
      }
    }

    return snapshots;
  }

  // ---- 寸法線操作 ----

  /**
   * 寸法線を追加する。
   * @param {typeof HDimensionLine | typeof VDimensionLine} LineClass
   * @param {object} props  dimensionKind / side / anchors / footLength / position
   * @returns {DimensionLine}
   */
  addDimensionLine(LineClass, props = {}, id = crypto.randomUUID()) {
    const d = new LineClass(id, props);
    d._planGraph = this;   // GRID の effectiveAnchors が gridXs/gridYs を引くため
    this.shapeMap.set(d.id, d);
    return d;
  }

  removeDimensionLine(id) {
    const d = this.shapeMap.get(id);
    if (!(d instanceof DimensionLine)) return;
    this.shapeMap.delete(id);
  }

  removeShape(id) { this._removeShape(id); }

  /** グラフを完全にクリアする（restoreGraph の前処理用）。*/
  clear() {
    this._graph = createGraph({ multigraph: true });
    this._shapeLinks.clear();
    this.shapeMap.clear();
    this.intersectionMap.clear();
    this.pointMap.clear();
    this.roomMap.clear();
    this.roomOrder.clear();
    this.edgeMap.clear();
    this.columnMap.clear();
    this.beamMap.clear();
    this.wallMap.clear();
    this.wallOpeningMap.clear();
    this.slabMap.clear();
    this.footingMap.clear();
    this.sleeveMap.clear();
    this.excludedColumnSlots.clear();
    this.excludedBeamSlots.clear();
    this.excludedFootingSlots.clear();
    this.columnAxisOffsets.clear();
    this.interiorWallPanel   = DEFAULT_INTERIOR_WALL_PANEL;
    this.exteriorWallBacking = DEFAULT_EXTERIOR_WALL_BACKING;
    this.interiorWallBacking = DEFAULT_INTERIOR_WALL_BACKING;
    this.ceilingBacking      = DEFAULT_CEILING_BACKING;
    this.floorBacking        = DEFAULT_FLOOR_BACKING;
    this.floorDatum          = 0;
    this.structureOverride   = null;
  }

  /**
   * 階固有データのみクリアする（フロア切替時に使用）。
   * structGraph の通り芯・交点には触れない。
   * shapeMap には通り芯が含まれないため clear() と同等だが、
   * 意図を明示するために別メソッドとして定義する。
   */
  clearFloorData() {
    this._graph = createGraph({ multigraph: true });
    this._shapeLinks.clear();
    this.shapeMap.clear();
    this.intersectionMap.clear(); // 階固有交点（通り芯×階固有CL等）のみ
    this.pointMap.clear();
    this.roomMap.clear();
    this.roomOrder.clear();
    this.edgeMap.clear();
    this.columnMap.clear();
    this.beamMap.clear();
    this.wallMap.clear();
    this.wallOpeningMap.clear();
    this.slabMap.clear();
    this.footingMap.clear();
    this.sleeveMap.clear();
    this.excludedColumnSlots.clear();
    this.excludedBeamSlots.clear();
    this.excludedFootingSlots.clear();
    this.columnAxisOffsets.clear();
    this.interiorWallPanel   = DEFAULT_INTERIOR_WALL_PANEL;
    this.exteriorWallBacking = DEFAULT_EXTERIOR_WALL_BACKING;
    this.interiorWallBacking = DEFAULT_INTERIOR_WALL_BACKING;
    this.ceilingBacking      = DEFAULT_CEILING_BACKING;
    this.floorBacking        = DEFAULT_FLOOR_BACKING;
    this.floorDatum          = 0;
    this.structureOverride   = null;
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
    [...this.columnMap.values()]
      .filter(c => c.verticalCL.id === id || c.horizontalCL.id === id)
      .forEach(c => this.columnMap.delete(c.id));
    [...this.beamMap.values()]
      .filter(b => b.axisCL.id === id || b.clStart.id === id || b.clEnd.id === id)
      .forEach(b => this.beamMap.delete(b.id));
    [...this.wallMap.values()]
      .filter(w => w.axisCL.id === id || w.clStart.id === id || w.clEnd.id === id)
      .forEach(w => this.removeWall(w.id));
    [...this.footingMap.values()]
      .filter(f => f.verticalCL.id === id || f.horizontalCL.id === id)
      .forEach(f => this.footingMap.delete(f.id));
    this.columnAxisOffsets.delete(id);
    // 貫通孔（梁ホストのみ。スラブホストはcellKeyのみのCL非依存アンカーのため対象外、
    // Room/StructuralSlab と同様にteardown不要という設計）
    [...this.sleeveMap.values()]
      .filter(s => s.hostType === 'beam' &&
        (s.hostAxisCL?.id === id || s.hostClStart?.id === id || s.hostClEnd?.id === id))
      .forEach(s => this.sleeveMap.delete(s.id));
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
    // 通り芯×通り芯の交点は structGraph に存在する — そちらを使う
    const structIx = this._structGraph?.intersectionMap.get(key);
    if (structIx) {
      // 自グラフの ngraph にノードが未登録なら登録（addLink 前提）
      if (!this._graph.getNode(structIx.id)) {
        this._graph.addNode(structIx.id, structIx);
      }
      return structIx;
    }
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

// 壁の端点トリム (chamferWalls 用)
// targetCoord に近い端 (coord1 or coord2) を refCL+refOffset の位置にセット
// フェイスがスパン内部にある場合（入隅）のみ処理
function _trimWallEnd(wall, targetCoord, refCL, refOffset) {
  const faceCoord = refCL.value + refOffset;
  const lo = Math.min(wall.coord1, wall.coord2);
  const hi = Math.max(wall.coord1, wall.coord2);
  if (faceCoord <= lo || faceCoord >= hi) return;
  if (Math.abs(wall.coord1 - targetCoord) <= Math.abs(wall.coord2 - targetCoord)) {
    wall.startOffset = faceCoord - wall.clStart.value;
  } else {
    wall.endOffset = faceCoord - wall.clEnd.value;
  }
}

// 壁の端点延長 (chamferWalls 用)
// フェイスがスパン外部にある場合（出隅）、端点をフェイス位置まで延長する
function _extendWallEnd(wall, targetCoord, refCL, refOffset, tolerance) {
  const faceCoord = refCL.value + refOffset;
  const lo = Math.min(wall.coord1, wall.coord2);
  const hi = Math.max(wall.coord1, wall.coord2);
  if (faceCoord > lo && faceCoord < hi) return; // 入隅は _trimWallEnd の担当
  const d1 = Math.abs(wall.coord1 - targetCoord);
  const d2 = Math.abs(wall.coord2 - targetCoord);
  if (Math.min(d1, d2) > tolerance) return;
  const MIN_LEN = 1;
  if (d1 <= d2) {
    if (Math.abs(faceCoord - wall.coord2) < MIN_LEN) return;
    wall.startOffset = faceCoord - wall.clStart.value;
  } else {
    if (Math.abs(faceCoord - wall.coord1) < MIN_LEN) return;
    wall.endOffset = faceCoord - wall.clEnd.value;
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
    case ShapeType.OPENING:
      return shape.axisCL.id === id || shape.refCL.id === id;
    default: return false;
  }
}

// ================================================================
// SITE (敷地モード)
// ================================================================

export const SiteLineKind = Object.freeze({
  BOUNDARY:   'boundary',   // 境界（隣地境界線）
  ROAD:       'road',       // 道路境界
  SURVEY:     'survey',     // 測量
  ROAD_WIDTH: 'roadWidth',  // 道路幅員
  OTHER:      'other',      // その他
});

// 敷地上の端点（SiteLine が共有する）
export class SitePoint {
  constructor(id, x, y) {
    this.id = id;
    this.x  = x;
    this.y  = y;
    makeObservable(this, {
      x: observable,
      y: observable,
    });
  }
}

// 敷地線分: 2つの SitePoint を結ぶ
export class SiteLine {
  // redPointId: 赤端点の SitePoint ID（生成時に1度だけ決定し、以降は不変）
  constructor(id, startPoint, endPoint, lineKind = SiteLineKind.SURVEY, redPointId = startPoint.id) {
    this.id         = id;
    this.startPoint = startPoint; // SitePoint
    this.endPoint   = endPoint;   // SitePoint
    this.lineKind   = lineKind;
    this.redPointId = redPointId;
    makeObservable(this, {
      lineKind: observable,
      length:   computed,
    });
  }
  get length() {
    return Math.hypot(
      this.endPoint.x - this.startPoint.x,
      this.endPoint.y - this.startPoint.y,
    );
  }
}

// 三斜の三角形: 底辺 SiteLine + 頂点 SitePoint
export class SiteTriangle {
  constructor(id, baseLine, apexPoint, lineKind = SiteLineKind.SURVEY) {
    this.id        = id;
    this.baseLine  = baseLine;  // SiteLine（底辺）
    this.apexPoint = apexPoint; // SitePoint（頂点）
    this.lineKind  = lineKind;  // 境界/道路境界/測量
    makeObservable(this, {
      lineKind: observable,
      area:     computed,
    });
  }
  // 外積で三角形面積を算出 (mm² → ㎡)
  get area() {
    const { startPoint: A, endPoint: B } = this.baseLine;
    const C = this.apexPoint;
    const areaMm2 = Math.abs(
      (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y),
    ) / 2;
    return areaMm2 / 1_000_000;
  }
}

// 敷地図全体: 点・線分・三角形を管理する
export class Site {
  constructor() {
    this.pointMap    = observable.map(); // id → SitePoint
    this.lineMap     = observable.map(); // id → SiteLine
    this.triangleMap = observable.map(); // id → SiteTriangle
    this.lineOrder   = observable.array([]); // 三斜タブ表示順 (SiteLine ID)
    // 三斜の作成手順（線分長さ編集時の再計算に使用）
    // [0]:        { type: 'base', lineId, length }
    // [1..]:      { type: 'triangle', baseLineId, redLineId, redLen, redKind,
    //               blueLineId, blueLen, blueKind, triangleId, triangleLineKind, side }
    this.history     = observable.array([]);
    makeObservable(this, {
      points:        computed,
      lines:         computed,
      orderedLines:  computed,
      triangles:     computed,
      addPoint:      action,
      removePoint:   action,
      addLine:       action,
      removeLine:    action,
      addTriangle:   action,
      removeTriangle: action,
    });
  }

  get points()      { return [...this.pointMap.values()]; }
  get lines()       { return [...this.lineMap.values()]; }
  get triangles()   { return [...this.triangleMap.values()]; }

  get orderedLines() {
    return this.lineOrder
      .filter(id => this.lineMap.has(id))
      .map(id => this.lineMap.get(id));
  }

  addPoint(x, y, id = crypto.randomUUID()) {
    const pt = new SitePoint(id, x, y);
    this.pointMap.set(pt.id, pt);
    return pt;
  }

  removePoint(id) {
    this.pointMap.delete(id);
  }

  addLine(startPoint, endPoint, lineKind = SiteLineKind.SURVEY, id = crypto.randomUUID(), redPointId = startPoint.id) {
    const line = new SiteLine(id, startPoint, endPoint, lineKind, redPointId);
    this.lineMap.set(line.id, line);
    this.lineOrder.push(line.id);
    return line;
  }

  removeLine(id) {
    // 底辺として使われている triangle も連鎖削除
    for (const [tid, tri] of this.triangleMap) {
      if (tri.baseLine.id === id) this.triangleMap.delete(tid);
    }
    this.lineMap.delete(id);
    const idx = this.lineOrder.indexOf(id);
    if (idx >= 0) this.lineOrder.splice(idx, 1);
  }

  addTriangle(baseLine, apexPoint, lineKind = SiteLineKind.SURVEY, id = crypto.randomUUID()) {
    const tri = new SiteTriangle(id, baseLine, apexPoint, lineKind);
    this.triangleMap.set(tri.id, tri);
    return tri;
  }

  removeTriangle(id) {
    this.triangleMap.delete(id);
  }
}

// 構造情報: 建物全体の既定値（主要構造・標準材料グレード・地域荷重）。
// 階ごとの例外は PlanGraph.structureOverride（mainStructure のみ。null=この建物全体値を継承）。
export class StructuralInfo {
  constructor() {
    this.mainStructure    = '未定';
    this.otherStructures  = observable.array([]);
    this.foundationType   = 'ベタ基礎';
    // 出幅（mm）: 通り芯から柱外面までの距離。1構造×1通り芯あたり1値で持つ（columnFaceProjections。
    // キー=`${structure}|${cl.label}`。混構造では構造ごと、X/Y通り芯ごとに別値を指定できる）。
    // ラーメン系の柱芯はこの出幅と自階の柱幅から決定的に導出する（autoFillColumnAxisOffsets）。
    // 0＝外面が通り芯と一致（既定）。columnFaceProjection は旧・建物1値の保持先で、無キー時の移行既定。
    this.columnFaceProjection  = 0;
    this.columnFaceProjections = observable.map();
    this.designStrength   = 'Fc24';
    this.concreteType     = '普通コンクリート';
    this.mainBar          = 'SD345';
    this.hoopBar          = 'SD295A';
    this.snowArea         = '一般区域（多雪以外）';
    this.basicWindSpeed   = 34;
    this.surfaceRoughness = 'III';
    this.seismicZoneFactor = '1.0';
    makeObservable(this, {
      mainStructure:        observable,
      foundationType:       observable,
      columnFaceProjection: observable,
      columnFaceProjections: observable,
      designStrength:       observable,
      concreteType:         observable,
      mainBar:              observable,
      hoopBar:              observable,
      snowArea:             observable,
      basicWindSpeed:       observable,
      surfaceRoughness:     observable,
      seismicZoneFactor:    observable,
      setField:             action,
      toggleOtherStructure: action,
      setColumnFaceProjection: action,
    });
  }
  setField(field, value) { this[field] = value; }
  // 出幅キー: 1構造×1通り芯。通り芯ラベル（X1/Y1…）が方向も含めて軸を一意に表す。
  faceProjectionKey(structure, cl) { return `${structure}|${cl.label}`; }
  // 当該構造・通り芯の出幅。無キーは旧・建物1値（移行既定）→0 にフォールバック。
  getColumnFaceProjection(structure, cl) {
    return this.columnFaceProjections.get(this.faceProjectionKey(structure, cl))
      ?? this.columnFaceProjection ?? 0;
  }
  setColumnFaceProjection(structure, cl, value) {
    this.columnFaceProjections.set(this.faceProjectionKey(structure, cl), value);
  }
  toggleOtherStructure(name) {
    const i = this.otherStructures.indexOf(name);
    if (i >= 0) this.otherStructures.splice(i, 1);
    else this.otherStructures.push(name);
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

    // 全階共通の通り芯専用グラフ（labeled struct CL のみ格納）
    const structPlane = new Plane('struct', 0, '__struct__');
    this.structGraph  = new PlanGraph(structPlane);

    this.site = new Site();
    this.structuralInfo = new StructuralInfo();

    // 構造部材タグ台帳（建物全体で共有。registryKey → タグ文字列）。
    // 「同一形状は同一タグ」を階をまたいで実現するため project レベルに置く
    // （columnMap 等は階ごとに独立したインスタンスを持つため、タグの一致は CL 参照ではなく
    //  この台帳のキー一致で判定する。structural/memberNumbering.js 参照）。
    this.structuralTagRegistry = observable.map();

    makeObservable(this, {
      name:          observable,
      activePlaneId: observable,
      activeGraph:   computed,
      activePlane:   computed,
      planes:        computed,
      orderedTabs:   computed,
      roofPlane:     computed,
      addPlane:      action,
      removePlane:   action,
      setTagRegistryEntry: action,
    });
  }

  setTagRegistryEntry(key, tag) { this.structuralTagRegistry.set(key, tag); }

  get activeGraph() {
    return this.activePlaneId ? this.graphMap.get(this.activePlaneId) : undefined;
  }

  get activePlane() {
    return this.activePlaneId ? this.planeMap.get(this.activePlaneId) : undefined;
  }

  /** 採用フロアのみを elevation 昇順で返す（階番号ロジック用。屋根専用平面は対象外） */
  get planes() {
    return [...this.planeMap.values()]
      .filter(p => !p.isAlternative && !p.isRoofPlane)
      .sort((a, b) => a.elevation - b.elevation);
  }

  /** 屋根専用平面（小屋伏／R階伏）。構造モードでのみ存在し、なければ null。 */
  get roofPlane() {
    return [...this.planeMap.values()].find(p => p.isRoofPlane) ?? null;
  }

  /** タブ表示順（採用 + 各採用の検討、elevation 昇順グループ） */
  get orderedTabs() {
    const adopted = this.planes;
    const result = [];
    for (const a of adopted) {
      result.push(a);
      const alts = [...this.planeMap.values()]
        .filter(p => p.isAlternative && p.referenceId === a.id)
        .sort((a, b) => a.altIndex - b.altIndex);
      result.push(...alts);
    }
    return result;
  }

  addPlane(elevation, name, id = crypto.randomUUID(), startFloor = 1, stories = 1,
           isAlternative = false, referenceId = null, altIndex = 0,
           isRoofPlane = false, roofForPlaneId = null) {
    const plane = new Plane(id, elevation, name, startFloor, stories, isAlternative, referenceId, altIndex,
                             isRoofPlane, roofForPlaneId);
    const graph = new PlanGraph(plane);
    graph._structGraph = this.structGraph; // 全階共通の通り芯を参照
    this.planeMap.set(plane.id, plane);
    this.graphMap.set(plane.id, graph);
    if (!this.activePlaneId) this.activePlaneId = plane.id;
    return { plane, graph };
  }

  removePlane(planeId) {
    const plane = this.planeMap.get(planeId);
    if (!plane) return;
    if (!plane.isAlternative && !plane.isRoofPlane && this.planes.length <= 1) return; // 採用の最後の1階は削除不可

    if (!plane.isAlternative) {
      // 検討をまとめて削除
      for (const [id, p] of this.planeMap) {
        if (p.isAlternative && p.referenceId === planeId) {
          this.planeMap.delete(id);
          this.graphMap.delete(id);
        }
      }
    }
    this.planeMap.delete(planeId);
    this.graphMap.delete(planeId);
    if (this.activePlaneId === planeId) {
      this.activePlaneId = this.planes[0]?.id ?? null;
    }
  }

}
