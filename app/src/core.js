/**
 * 汎用建築CAD - コアクラス定義
 * 状態管理: MobX (mobx)
 * グラフ構造: ngraph.graph
 */
import { makeObservable, observable, computed, action, reaction } from 'mobx';
import createGraph from 'ngraph.graph';
import { INTERIOR_MASTERS } from './finish/materials/interiorMasters.js';
import { coordLo as _coordLo, coordHi as _coordHi } from './core/_internal.js';

// ================================================================
// CONSTANTS — core/constants.js に集約。core.js が内部使用しつつ後方互換のため再エクスポートする。
// ================================================================

import {
  Discipline, ShapeType, ShapeKind, CenterLineType, RoomKind,
  StairType, StructuralMaterialType,
  LINE_WEIGHT_MM, DimensionKind, DimensionSide,
  DEFAULT_WALL_MATERIAL, DEFAULT_EXTERIOR_WALL_BACKING,
  DEFAULT_INTERIOR_WALL_BACKING, DEFAULT_CEILING_BACKING, DEFAULT_FLOOR_BACKING,
  DEFAULT_ROOM_FLOOR_LEVEL, DEFAULT_ROOM_CEILING_HEIGHT,
} from './core/constants.js';

export {
  Discipline, ShapeType, OpeningCategory, ShapeKind, CenterLineType, RoomKind, RoomFeature,
  StairType, StructuralMaterialType, LINE_WEIGHT_MM, DimensionKind, DimensionSide,
  DEFAULT_WALL_MATERIAL, DEFAULT_EXTERIOR_WALL_BACKING,
  DEFAULT_INTERIOR_WALL_BACKING, DEFAULT_CEILING_BACKING, DEFAULT_FLOOR_BACKING,
  DEFAULT_ROOM_FLOOR_LEVEL, DEFAULT_ROOM_CEILING_HEIGHT,
  SiteLineKind, CL_OVERLAP_TOL_MM,
} from './core/constants.js';

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
    // LOD詳細描画で「仕上げ面〜下地境界」の平行線・下地ピッチ線の位置を導出する（生成時のみ確定。null=不明・手動壁。
    // CL偏芯壁は applyCLEccentricity が随時再導出して書き換える）。
    this.wallFinish  = props?.wallFinish ?? null;
    // 下地帯中心の axisCL.value からの符号付きオフセット(mm)。偏芯壁（階段下部屋・CL偏芯等）のみ設定される。
    // null=現行（axisOffsetを中心に対称な下地帯）。生成時のみ確定（CL偏芯壁は applyCLEccentricity が再導出）。
    this.backingOffset = props?.backingOffset ?? null;
    // 下地帯の深さ(mm)。null=現行式（wallBase等から導出）。0は「下地なし＝仕上げのみの薄壁」を表す明示値。
    this.backingDepth  = props?.backingDepth ?? null;
    // 仕上げ面が向く側（±1）。CL偏芯の「仕上げ面合わせ」でCL上に面が一致し dir 導出が
    // 不能になるケースの明示指定。null=従来どおり sign(faceV-axisV) から導出する。
    this.finishSide  = props?.finishSide ?? null;
    makeObservable(this, {
      clStart:     observable.ref,
      clEnd:       observable.ref,
      axisOffset:  observable,
      startOffset: observable,
      endOffset:   observable,
      wallFinish:    observable,
      backingOffset: observable,
      backingDepth:  observable,
      finishSide:    observable,
      axisValue:     computed,
      coord1:        computed,
      coord2:        computed,
      materialRange: computed,
      backingRange:  computed,
    });
  }

  get axisValue() { return this.axisCL.effectiveValue + this.axisOffset; }
  get coord1()    { return this.clStart.effectiveValue + this.startOffset; }
  get coord2()    { return this.clEnd.effectiveValue   + this.endOffset;   }

  /**
   * 実際に材が存在する範囲（下地帯 ∪ 仕上げ帯）を、axisCL の厚み方向座標で返す。
   * backingDepth が null（対称壁）の場合は axisValue〜axisCL.effectiveValue の対称範囲
   * （従来どおり）。backingDepth===0 は下地なし＝仕上げ帯のみ。
   * ShapesLayer の詳細LOD cap 描画、階段下壁のコーナートリム（stairUnderWalls.js）で共有する。
   * @returns {{lo:number, hi:number}}
   */
  get materialRange() {
    const axisV = this.axisCL.effectiveValue;
    const faceV = this.axisValue;
    const thickLo = Math.min(axisV, faceV), thickHi = Math.max(axisV, faceV);
    if (this.backingDepth == null) return { lo: thickLo, hi: thickHi };

    // finishSide 明示指定があれば優先する（CL偏芯の仕上げ面合わせで faceV===axisV となり
    // sign(faceV-axisV) が破綻するケースの対策。7.1参照）。
    const dir = this.finishSide ?? (Math.sign(faceV - axisV) || 1);
    const finBoundary = faceV - dir * (this.wallFinish ?? 0);
    const finLo = Math.min(finBoundary, faceV), finHi = Math.max(finBoundary, faceV);
    if (this.backingDepth === 0) return { lo: finLo, hi: finHi };

    const backingCenterV = axisV + (this.backingOffset ?? 0);
    const halfDepth = this.backingDepth / 2;
    return {
      lo: Math.min(backingCenterV - halfDepth, finLo),
      hi: Math.max(backingCenterV + halfDepth, finHi),
    };
  }

  /**
   * 下地帯（間柱）だけの厚み方向範囲（materialRange から仕上げ帯を除いた部分）。
   * backingDepth===0（下地なし＝仕上げのみの薄壁）は null。backingDepth/backingOffset が
   * null（対称壁の既定式）は axisCL中心・2*(全厚-wallFinish) の対称範囲
   * （ShapesLayer の詳細LOD下地描画の既定式と同じ）。wallFinish が不明（手動壁）な対称壁は
   * 算出不能のため null。壁のT字取り合い描画解決（renderer/wallJunctionResolve.js）で使う。
   * @returns {{lo:number, hi:number}|null}
   */
  get backingRange() {
    const axisV = this.axisCL.effectiveValue;
    if (this.backingDepth === 0) return null;
    if (this.backingDepth != null) {
      const center = axisV + (this.backingOffset ?? 0);
      const half = this.backingDepth / 2;
      return { lo: center - half, hi: center + half };
    }
    // 以下は axisCL中心の対称範囲を仮定するフォールバック枝。CL偏芯（finish/clEccentricity.js
    // applyCLEccentricity）が設定する壁は finishSide とともに backingOffset/backingDepth も
    // 必ず明示するため、finishSide が非nullの壁はこの枝に到達しない前提——到達すると
    // 非対称な実位置と食い違う（対称仮定が破綻する）。
    if (this.wallFinish == null) return null;
    const faceV = this.axisValue;
    const depth = 2 * (Math.abs(faceV - axisV) - this.wallFinish);
    if (!(depth > 0)) return null;
    return { lo: axisV - depth / 2, hi: axisV + depth / 2 };
  }
}

// ----------------------------------------------------------------
// 開口（建具・窓）: 壁と同じ軸CL + オフセット方式で自己完結したアンカーを持つ。
// Wall インスタンスを直接参照しない — 仕上げモード往復で壁は全削除・再生成されるため、
// 表示・編集時に「いまその場所にある壁」を openingGeometry.js の findHostWall で都度検索する。
//
//   wallSide: axisCL のどちら側か（Wall.axisOffset の符号と同義、±1）
//   refCL/refOffset: 壁の長さ方向の基準位置（通常は壁の clStart を流用）
//   hingeSide/swingSide: swing系（片開き戸等）のみ意味を持つ。それ以外は既定値を保持するだけ
//   fixtureType: 建具記号（'AW'|'JW'|'SW'|'AD'|'SD'|'WD'|null）。null=未設定（openings/ 層がカテゴリ既定へフォールバック）
//   sillHeight: 窓台高さ(mm、FLからサッシ下端まで、null=未設定)。窓カテゴリのみ意味を持つ
//   height: 建具高さ(mm、null=未設定＝旧データ)。窓は sillHeight〜sillHeight+height が開口範囲
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
    this.fixtureType = props?.fixtureType ?? null; // 建具記号 'AW'|'JW'|'SW'|'AD'|'SD'|'WD'|null
    this.sillHeight  = props?.sillHeight  ?? null; // 窓台高さ(mm): FLからサッシ下端まで。窓カテゴリのみ意味を持つ
    this.height      = props?.height      ?? null; // 建具高さ(mm、開口下端から上端まで。null=未設定＝旧データ)
    makeObservable(this, {
      axisCL:      observable.ref,
      wallSide:    observable,
      refCL:       observable.ref,
      refOffset:   observable,
      width:       observable,
      subType:     observable,
      hingeSide:   observable,
      swingSide:   observable,
      fixtureType: observable,
      sillHeight:  observable,
      height:      observable,
      centerCoord: computed,
      coord1:      computed,
      coord2:      computed,
    });
  }
  // 壁の「長さ方向」の座標のみ自己完結で計算できる（軸直交方向の座標はホスト壁から得る）
  get centerCoord() { return this.refCL.effectiveValue + this.refOffset; }
  get coord1()       { return _coordLo(this.centerCoord, this.width); }
  get coord2()       { return _coordHi(this.centerCoord, this.width); }
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

// CenterLine の種別（通り芯/中心/補助線）を discipline・lineType から判定する
export function centerLineKind(cl) {
  if (cl.lineType === 'dashed') return 'aux';
  if (cl.discipline === Discipline.STRUCT) return 'struct';
  if (cl.discipline === Discipline.FUSE) return 'beam';
  return 'center';
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
    this.roomId = null; // 階段ペアRoomのID（階段連動行のみ設定。手入力行は null）
    makeObservable(this, {
      part:     observable,
      finish:   observable,
      base:     observable,
      note:     observable,
      roomId:   observable,
      setField: action,
    });
  }
  setField(field, value) { this[field] = value; }
}

// cells は Set<string> — cellKey(xLeftCL, yTopCL) の集合
export class Room {
  constructor(id, name = '', cells = new Set(), referenceRoomIds = new Set(),
              kind = RoomKind.INTERIOR, templateKey = null, feature = null) {
    this.id               = id;
    this.name             = name;
    this.cells            = cells;
    this.referenceRoomIds = referenceRoomIds; // 判定3: 参照先部屋IDセット
    this.kind             = kind; // 内外区分（base軸）: 屋内 / 屋外
    this.feature          = feature; // 属性軸: 'stair' | 'void' | 'stairVoid' | null（なし）
    this.templateKey      = templateKey;      // 内装マスターへのポインタ（null = 未指定）
    this.customOverrides  = observable.map(); // 個別上書きポケット（壁・天井フィールドのみ）
    this.finish           = new RoomFinish();
    this.namePosition     = null;   // { x, y } | null — null = roomBounds 重心を使用
    this.floorLevel       = null;   // 階基準からの符号付き床レベル差(mm)。null = 基準どおり
    this.generatedWallIds = new Set(); // 自動生成された Wall の ID を管理（非 observable）
    makeObservable(this, {
      name:             observable,
      cells:            observable,
      referenceRoomIds: observable,
      kind:             observable,
      feature:          observable,
      templateKey:      observable,
      namePosition:     observable.ref,
      floorLevel:       observable,
      setName:          action,
      addCell:          action,
      removeCell:       action,
      setCells:         action,
      setKind:          action,
      setFeature:       action,
      setTemplateKey:   action,
      setOverride:      action,
      clearOverride:    action,
      setNamePosition:  action,
      setFloorLevel:    action,
    });
  }
  setName(name)              { this.name = name; }
  addCell(key)               { this.cells.add(key); }
  removeCell(key)            { this.cells.delete(key); }
  setCells(cells)            { this.cells = cells; }
  setKind(kind)              { this.kind = kind; }
  setFeature(feature)        { this.feature = feature; } // 'stair' | 'void' | 'stairVoid' | null
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

  /**
   * 内装マスター + 個別上書きをマージした、壁・天井フィールドの実効値。
   * 壁材（wallMaterial）はマスター・上書きとも未指定なら既定（せっこうボード t=12.5）に
   * フォールバックする（壁描画の仕上げ厚導出が部屋の壁材を単一情報源とするため）。
   */
  getFinishInfo() {
    const master = INTERIOR_MASTERS[this.templateKey] ?? {};
    const info = { ...master, ...Object.fromEntries(this.customOverrides) };
    if (!info.wallMaterial) info.wallMaterial = DEFAULT_WALL_MATERIAL;
    return info;
  }
}

// sections（歩行順・区間別の実段数配列。偶数index=直進部、奇数index=踊場・周回部）から総段数を求める。
// 各区間が図に持つマス（踏面）数は、直進部=実段数-1（最終の1段は次区間へ乗る段）、踊場・周回部=実段差ぶん
//（平踊場は1）。総段数 = 総マス数 + 1（設置階上階への到達）= 総蹴上数。
export function totalStepsFromSections(sections) {
  const cells = sections.reduce(
    (a, n, i) => a + (i % 2 === 0 ? Math.max(1, n - 1) : Math.max(1, n)), 0);
  return cells + 1;
}

// 階段（設置階＝下階のグラフに帰属。上階へは描画時に投影する）。
// cells は Room と同じ設置エリア表現（worldToCell のキー集合）。
export class Stair {
  constructor(id, {
    type        = StairType.STRAIGHT,
    structure   = StructuralMaterialType.WOOD, // 木造 / 鉄骨
    cells       = new Set(),
    totalSteps  = 15,
    tread       = 250,     // 踏面(mm)
    riser       = null,    // 蹴上(mm) null=階高/totalSteps で自動
    nosing      = 30,      // 蹴込(mm)
    width       = 900,     // 階段幅(mm)
    upDirection = 'right', // 昇り方向 'up'|'down'|'left'|'right'（向き推定結果）
    flip        = false,
    sections    = null,    // 区間別・実段数（歩行順。偶数=直進部、奇数=踊場・周回部）。未指定はnull
    roomId      = null,    // 変換元 Room の ID（旧データ・上階自動設置分は null）
  } = {}) {
    this.id          = id;
    this.type        = type;
    this.structure   = structure;
    this.cells       = cells;
    this.totalSteps  = sections ? totalStepsFromSections(sections) : totalSteps;
    this.tread       = tread;
    this.riser       = riser;
    this.nosing      = nosing;
    this.width       = width;
    this.upDirection = upDirection;
    this.flip        = flip;
    this.sections    = sections;
    this.roomId      = roomId;
    makeObservable(this, {
      type:        observable,
      structure:   observable,
      cells:       observable,
      totalSteps:  observable,
      tread:       observable,
      riser:       observable,
      nosing:      observable,
      width:       observable,
      upDirection: observable,
      flip:        observable,
      sections:    observable.ref,
      roomId:      observable,
      setField:    action,
      setCells:    action,
    });
  }
  // sections（区間別・実段数配列）を設定すると、totalSteps（総マス数+上階床到達分1）を同期する。
  setField(field, value) {
    this[field] = value;
    if (field === 'sections' && value) this.totalSteps = totalStepsFromSections(value);
  }
  setCells(cells) { this.cells = cells; }
}

// ================================================================
// STRUCTURAL ENTITIES — core/structuralEntities.js に分離。
// PlanGraph が材種別→クラス解決表・キー生成・直接 new するクラスを import して使い、
// 後方互換のため公開クラス／関数を再エクスポートする
// （StructuralEntity / StructuralFooting は元から非公開のため再エクスポートしない）。
// ================================================================

import {
  COLUMN_CLASS_BY_MATERIAL, BEAM_CLASS_BY_MATERIAL,
  WALL_CLASS_BY_MATERIAL, SLAB_CLASS_BY_MATERIAL,
  IndependentFooting, ColumnBase, RcWallOpening, PenetrationSleeve,
  columnSlotKey, spanKey,
} from './core/structuralEntities.js';

export {
  columnSlotKey, spanKey, findHostPrimaryBeam, HOST_BEAM_MATCH_TOL_MM,
  StructuralColumn, WoodColumn, SteelColumn, RcColumn,
  StructuralBeam, WoodBeam, SteelBeam, RcBeam,
  IndependentFooting, ColumnBase,
  StructuralWall, RcBearingWall, RcWallOpening,
  StructuralSlab, RcSlab, PenetrationSleeve,
} from './core/structuralEntities.js';

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
    this.stairMap            = observable.map(); // id → Stair（設置階に帰属）
    this.stairOrder          = observable.array([]); // 階段の表示順 — Stair ID の配列
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

    // CL偏芯（内壁指定のあるCLの偏芯仕様）: clId → レコード。未登録キー=偏芯なし（従来どおり）。
    // レコード形状は setCLEccentricity 参照。壁への反映は finish/clEccentricity.js の
    // applyCLEccentricity が毎回フル再計算して焼き込む（Wall側は導出結果のみを持つ）。
    this.clEccentricities = observable.map();

    // 腰壁・垂れ壁（1区間単位の指定）: edgeKey(axisCLId, startCLId, endCLId) → レコード。
    // レコード形状は setKneeDropWall 参照。区間の解決・輪郭描画は finish/kneeDropWall.js が担う
    // （このクラス自体は保存・削除のみ）。
    this.kneeDropWalls = observable.map();

    // トポロジー自動補完で「ユーザーが明示的に削除した箇所」を記憶する除外集合（per-floor、永続化対象）。
    // キーは柱・フーチング: `${verticalCL.id}:${horizontalCL.id}`、梁: spanKey()（始端終端の順序非依存）。
    this.excludedColumnSlots  = observable.set();
    this.excludedBeamSlots    = observable.set();
    this.excludedFootingSlots = observable.set();
    // 壁由来の梁芯CL自動生成（structural/wallBeamAxes.js）専用の除外集合。梁芯CLそのもの（梁のスロット
    // ではない）の手動削除・移動元を記憶する。キーは座標ベース `${'X'|'Y'}:${Math.round(coord)}`
    // （CL実体のidではない——壁を動かせば別スロットとして扱われ再生成されるのが意図どおりのため）。
    this.excludedWallBeamAxes = observable.set();

    // per-floor 設定（仕上げモード）— 材コード（選択された材として永続化）
    this.exteriorWallBacking = DEFAULT_EXTERIOR_WALL_BACKING; // 外壁下地: 下地材コード
    this.interiorWallBacking = DEFAULT_INTERIOR_WALL_BACKING; // 内壁下地: 下地材コード
    // 天井・床下地は表示のみ（共通仕様タブで保存するが、断面計算には未接続。
    // 将来、天井・床の層構成モデルを導入する際に edgeComposition.js 側で接続する）
    this.ceilingBacking      = DEFAULT_CEILING_BACKING;       // 天井下地: 下地材コード
    this.floorBacking        = DEFAULT_FLOOR_BACKING;         // 床下地: 下地材コード

    // 部屋の既定値（共通仕様タブ per-floor 設定）。部屋側が null のとき参照される。
    this.defaultFloorLevel    = DEFAULT_ROOM_FLOOR_LEVEL;    // FL初期値: 階FLからの相対高さmm
    this.defaultCeilingHeight = DEFAULT_ROOM_CEILING_HEIGHT; // CH初期値: 床面から天井までmm

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
      setCenterLineExtentRef: action,
      removeCenterLine:    action,
      detachFromCenterLine: action,
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
      addStair:                 action,
      removeStair:              action,
      stairs:                   computed,
      addExteriorRow:           action,
      removeExteriorRow:        action,
      removeExteriorRowGroup:   action,
      removeExteriorRowsByRoomId: action,
      exteriorWallBacking:      observable,
      interiorWallBacking:      observable,
      ceilingBacking:           observable,
      floorBacking:             observable,
      defaultFloorLevel:        observable,
      defaultCeilingHeight:     observable,
      floorDatum:               observable,
      structureOverride:        observable,
      setExteriorWallBacking:   action,
      setInteriorWallBacking:   action,
      setCeilingBacking:        action,
      setFloorBacking:          action,
      setDefaultFloorLevel:     action,
      setDefaultCeilingHeight:  action,
      setFloorDatum:            action,
      setStructureOverride:     action,
      setColumnAxisOffset:  action,
      setCLEccentricity:    action,
      removeCLEccentricity: action,
      setKneeDropWall:      action,
      removeKneeDropWall:   action,
      backingMaterials:         computed,
      addBackingMaterial:       action,
      edges:                    computed,
      addEdge:                  action,
      removeEdge:               action,
    });

    // ---- 中心線ラベル自動命名 reaction ----

    reaction(
      () => [...this.shapeMap.values()]
        .filter(s => _isLabeledStructCL(s, CenterLineType.VERTICAL))
        .map(cl => cl.value),
      () => this._relabelCenterLines(CenterLineType.VERTICAL),
      { fireImmediately: true },
    );

    reaction(
      () => [...this.shapeMap.values()]
        .filter(s => _isLabeledStructCL(s, CenterLineType.HORIZONTAL))
        .map(cl => cl.value),
      () => this._relabelCenterLines(CenterLineType.HORIZONTAL),
      { fireImmediately: true },
    );

    reaction(
      () => [...this.shapeMap.values()]
        .filter(s => _isLabeledStructCL(s, CenterLineType.RADIAL))
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
    const own = _labeledCLs(this.shapeMap, CenterLineType.VERTICAL);
    const struct = this._structGraph
      ? _labeledCLs(this._structGraph.shapeMap, CenterLineType.VERTICAL)
      : [];
    return [...struct, ...own].sort((a, b) => a.value - b.value);
  }

  // グリッド軸として機能する labeled:true HORIZONTAL CenterLine (= 旧 GridY 相当)
  get gridYs() {
    const own = _labeledCLs(this.shapeMap, CenterLineType.HORIZONTAL);
    const struct = this._structGraph
      ? _labeledCLs(this._structGraph.shapeMap, CenterLineType.HORIZONTAL)
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

  get stairs() {
    return this.stairOrder
      .filter(id => this.stairMap.has(id))
      .map(id => this.stairMap.get(id));
  }

  addStair(opts = {}, id = crypto.randomUUID()) {
    const stair = new Stair(id, opts);
    this.stairMap.set(stair.id, stair);
    this.stairOrder.push(stair.id);
    return stair;
  }

  removeStair(id) {
    this.stairMap.delete(id);
    const idx = this.stairOrder.indexOf(id);
    if (idx >= 0) this.stairOrder.splice(idx, 1);
  }

  addExteriorRow(category, part = '', roomId = null) {
    const row = new ExteriorFinishRow();
    if (part) row.setField('part', part);
    row.roomId = roomId;
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

  /** roomId にリンクした外部仕上げ行（階段連動。exteriorRowsのみ対象）があれば削除する。 */
  removeExteriorRowsByRoomId(roomId) {
    const arr = this.exteriorRows;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].roomId === roomId) arr.splice(i, 1);
    }
  }

  // ---- per-floor 設定（外壁下地 / 内壁下地 / 天井・床下地）----

  setExteriorWallBacking(code) { this.exteriorWallBacking = code; }
  setInteriorWallBacking(code) { this.interiorWallBacking = code; }
  setCeilingBacking(code)      { this.ceilingBacking      = code; }
  setFloorBacking(code)        { this.floorBacking        = code; }
  setDefaultFloorLevel(mm)     { this.defaultFloorLevel    = mm; }
  setDefaultCeilingHeight(mm)  { this.defaultCeilingHeight = mm; }
  setFloorDatum(mm) { this.floorDatum = mm; }
  setStructureOverride(v) { this.structureOverride = v; }

  /** 柱芯オフセット（CL id → 通り芯からの偏心量mm）を1件設定する。 */
  setColumnAxisOffset(clId, value) { this.columnAxisOffsets.set(clId, value); }

  /**
   * CL偏芯レコードを1件設定する。rec = { mode: 'value'|'face', value:number, side:1|-1, backing:string }。
   * backing==='' は per-floor 既定（interiorWallBacking）を参照する合図。immutableに保つため凍結する。
   */
  setCLEccentricity(clId, rec) { this.clEccentricities.set(clId, Object.freeze({ ...rec })); }
  /** CL偏芯指定を解除する（＝偏芯なしの既定へ戻す）。 */
  removeCLEccentricity(clId)   { this.clEccentricities.delete(clId); }

  /**
   * 腰壁・垂れ壁レコードを1件設定する。key = edgeKey(axisCLId, startCLId, endCLId)（start/endはCL
   * value昇順に正規化）。rec = { knee: {topHeight:number}|null, drop: {bottomHeight:number}|null }。
   * immutableに保つため凍結する（CL偏芯と同方式）。
   */
  setKneeDropWall(key, rec) { this.kneeDropWalls.set(key, Object.freeze({ ...rec })); }
  /** 腰壁・垂れ壁指定を解除する（＝両方nullの既定へ戻す）。 */
  removeKneeDropWall(key)   { this.kneeDropWalls.delete(key); }

  /** 部屋の実効床レベル(mm) = 階基準 + 部屋デルタ（null = FL初期値どおり）。 */
  effectiveFloorLevel(room) {
    return this.floorDatum + (room ? (room.floorLevel ?? this.defaultFloorLevel) : 0);
  }
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

  // extentLoRef/extentHiRef から参照先 CL/Wall を解決する（addCenterLine と共通のロジック）
  _resolveExtentRef(ref) {
    if (!ref) return { cl: null, wall: null };
    if (ref.clId) {
      const cl = this.shapeMap.get(ref.clId) ?? this._structGraph?.shapeMap.get(ref.clId);
      return { cl: cl instanceof CenterLine ? cl : null, wall: null };
    }
    if (ref.wallId) {
      const wall = this.shapeMap.get(ref.wallId);
      return { cl: null, wall: wall?.type === ShapeType.WALL ? wall : null };
    }
    return { cl: null, wall: null };
  }

  // 中心線結合処理用: lo/hi 側の extent 参照を書き換え、解決キャッシュも更新する
  setCenterLineExtentRef(cl, side, ref, staticValue = null) {
    const { cl: refCL, wall: refWall } = this._resolveExtentRef(ref);
    if (side === 'lo') {
      cl.extentLoRef   = ref ?? null;
      cl._extentLoCL   = refCL;
      cl._extentLoWall = refWall;
      cl._extentLo     = ref ? null : staticValue;
    } else {
      cl.extentHiRef   = ref ?? null;
      cl._extentHiCL   = refCL;
      cl._extentHiWall = refWall;
      cl._extentHi     = ref ? null : staticValue;
    }
  }

  /**
   * refId / extentLoRef.clId / extentHiRef.clId が指す CenterLine を再解決する。
   * addCenterLine は呼び出し時点で shapeMap にある CL しか解決できないため、
   * restoreGraph 等で参照先が自分より後に追加される順序だと解決漏れが起きる
   * （問題.md: フロア切替でCLの短縮が解除されY2まで延長される不具合の原因）。
   * 全 CL 追加後に呼び、未解決分だけ解決し直す。
   */
  resolveCenterLineRefs() {
    for (const cl of this.centerLines) {
      if (cl.refId && !cl._referencedCL) {
        const refCL = this.shapeMap.get(cl.refId) ?? this._structGraph?.shapeMap.get(cl.refId);
        if (refCL instanceof CenterLine) cl._referencedCL = refCL;
      }
      if (cl.extentLoRef?.clId && !cl._extentLoCL) {
        const loCL = this.shapeMap.get(cl.extentLoRef.clId) ?? this._structGraph?.shapeMap.get(cl.extentLoRef.clId);
        if (loCL instanceof CenterLine) cl._extentLoCL = loCL;
      }
      if (cl.extentHiRef?.clId && !cl._extentHiCL) {
        const hiCL = this.shapeMap.get(cl.extentHiRef.clId) ?? this._structGraph?.shapeMap.get(cl.extentHiRef.clId);
        if (hiCL instanceof CenterLine) cl._extentHiCL = hiCL;
      }
    }
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
    this.detachFromCenterLine(id); // 端点ルール: teardown より先に壁端・extent を切り離す
    this._teardownCenterLine(id);
    this._removeShape(id);
  }

  /**
   * 指定 CL への参照を切り離す（端点ルール）。CL 削除の直前に呼ぶ。
   *
   * - 他CLの extentLo/HiRef が id を指す場合: 現在座標で静的化する。
   *   交点を失った線分の端は「端点」となり座標が削除位置に固定される
   *   （延長・短縮の除外判定は transform/centerLineExtend.js の isEndpointAt）。
   * - 壁の clStart/clEnd が id の場合: 参照を反対側の端CLへ繰り上げ、端点側は
   *   「端点ノードに壁があったと想定した」分（|axisOffset| = 下地偏芯量＋仕上げ厚）
   *   だけ CL 位置からはね出して止める。
   * - 軸CLが id の壁・両端とも id を参照する壁・id をアンカーとする開口は削除する。
   *
   * 自グラフの CL 削除（removeCenterLine）に加え、通り芯削除時は各階グラフ側の
   * 参照を切り離すため App 側からも呼ばれる（structGraph の teardown は
   * 階グラフの図形に届かないため）。
   */
  detachFromCenterLine(id) {
    for (const w of this.walls) {
      const s = w.clStart.id === id, e = w.clEnd.id === id;
      if (w.axisCL.id === id || (s && e)) { this._removeShape(w.id); continue; }
      if (s) this._endpointWallEnd(w, 'start');
      else if (e) this._endpointWallEnd(w, 'end');
    }
    for (const o of this.openings) {
      if (o.axisCL.id === id || o.refCL.id === id) this._removeShape(o.id);
    }
    for (const cl of this.centerLines) {
      if (cl.extentLoRef?.clId === id) this.setCenterLineExtentRef(cl, 'lo', null, cl.extentLo);
      if (cl.extentHiRef?.clId === id) this.setCenterLineExtentRef(cl, 'hi', null, cl.extentHi);
    }
  }

  // 参照CLを失う壁端を反対側の端CLへ繰り上げ、端点はねだし分を加えたオフセットへ変換する。
  // はねだしは端CLの位置（ノード）基準（トリム済み端も削除前の交点位置から張り直す）。
  _endpointWallEnd(wall, which) {
    const [endCL, otherCL, otherOffset] = which === 'start'
      ? [wall.clStart, wall.clEnd, wall.endOffset]
      : [wall.clEnd, wall.clStart, wall.startOffset];
    const node = endCL.value;
    const dir  = Math.sign(node - (otherCL.value + otherOffset));
    if (dir === 0) { this._removeShape(wall.id); return; }
    const newOffset = node + dir * Math.abs(wall.axisOffset) - otherCL.value;
    if (which === 'start') { wall.clStart = otherCL; wall.startOffset = newOffset; }
    else                   { wall.clEnd   = otherCL; wall.endOffset   = newOffset; }
  }

  // id の CenterLine を削除すると壊れる外部参照があるか（結合による削除の安全ガード用）
  // refId 単体の参照は _reparentChildCenterLines で繰り上がるため対象外。
  hasExternalCenterLineReferences(id) {
    const usesShape = [...this.shapeMap.values()]
      .some(s => !(s instanceof CenterLine) && _shapeUsesCenterLine(s, id));
    if (usesShape) return true;
    const usesStruct =
      [...this.columnMap.values()].some(c => c.verticalCL.id === id || c.horizontalCL.id === id) ||
      [...this.beamMap.values()].some(b => b.axisCL.id === id || b.clStart.id === id || b.clEnd.id === id) ||
      [...this.wallMap.values()].some(w => w.axisCL.id === id || w.clStart.id === id || w.clEnd.id === id) ||
      [...this.footingMap.values()].some(f => f.verticalCL.id === id || f.horizontalCL.id === id) ||
      [...this.sleeveMap.values()].some(s => s.hostType === 'beam' &&
        (s.hostAxisCL?.id === id || s.hostClStart?.id === id || s.hostClEnd?.id === id));
    if (usesStruct) return true;
    return this.centerLines.some(other =>
      other.id !== id && (other.extentLoRef?.clId === id || other.extentHiRef?.clId === id)
    );
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

  removeShape(id) { this._removeShape(id); }

  /** グラフを完全にクリアする（restoreGraph の前処理用）。*/
  clear() { this._resetFloorState(); }

  /**
   * 階固有データのみクリアする（フロア切替時に使用）。
   * structGraph の通り芯・交点には触れない。
   * shapeMap には通り芯が含まれないため clear() と同等だが、
   * 意図を明示するために別メソッドとして定義する。
   */
  clearFloorData() { this._resetFloorState(); }

  // clear() / clearFloorData() 共通の階固有状態リセット本体。
  // structGraph の通り芯・交点には触れない（intersectionMap は階固有交点のみを保持）。
  _resetFloorState() {
    this._graph = createGraph({ multigraph: true });
    this._shapeLinks.clear();
    this.shapeMap.clear();
    this.intersectionMap.clear();
    this.pointMap.clear();
    this.roomMap.clear();
    this.roomOrder.clear();
    this.stairMap.clear();
    this.stairOrder.clear();
    this.exteriorRows.clear();
    this.exteriorFittingRows.clear();
    this.structureRows.clear();
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
    this.excludedWallBeamAxes.clear();
    this.columnAxisOffsets.clear();
    this.clEccentricities.clear();
    this.kneeDropWalls.clear();
    this.exteriorWallBacking = DEFAULT_EXTERIOR_WALL_BACKING;
    this.interiorWallBacking = DEFAULT_INTERIOR_WALL_BACKING;
    this.ceilingBacking      = DEFAULT_CEILING_BACKING;
    this.floorBacking        = DEFAULT_FLOOR_BACKING;
    this.defaultFloorLevel    = DEFAULT_ROOM_FLOOR_LEVEL;
    this.defaultCeilingHeight = DEFAULT_ROOM_CEILING_HEIGHT;
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
    this.clEccentricities.delete(id);
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
    return _labeledCLs(this.shapeMap, CenterLineType.VERTICAL);
  }

  _labeledHorizontals() {
    return _labeledCLs(this.shapeMap, CenterLineType.HORIZONTAL);
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

// labeled な指定軸種の CenterLine か（系統A: discipline 不問・グリッド用）
function _isLabeledCL(s, type) {
  return s instanceof CenterLine && s.centerLineType === type && s.labeled;
}
// labeled かつ構造の指定軸種か（系統B: 自動命名・reaction 用）
function _isLabeledStructCL(s, type) {
  return _isLabeledCL(s, type) && s.discipline === Discipline.STRUCT;
}
// shapeMap から系統A を集める（並べ替えなし）
function _labeledCLs(shapeMap, type) {
  return [...shapeMap.values()].filter(s => _isLabeledCL(s, type));
}

// labeled:true の CenterLine をソートして返す (自動命名対象)
function _sortedCenterLines(shapeMap, type) {
  const all = [...shapeMap.values()].filter(s => _isLabeledStructCL(s, type));
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
// SITE (敷地モード) — core/site.js に分離。core 内部使用（Project.site）のため
// Site を import しつつ、後方互換のため全クラスを再エクスポートする。
// ================================================================

import { Site } from './core/site.js';
export { SitePoint, SiteLine, SiteTriangle, Site } from './core/site.js';

// 構造情報（StructuralInfo） — core/structuralInfo.js に分離。
// core 内部使用（Project.structuralInfo）のため import しつつ再エクスポートする。
import { StructuralInfo } from './core/structuralInfo.js';
export { StructuralInfo } from './core/structuralInfo.js';

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

    // 部材グループ台帳（建物全体で共有。grp.spec:<gid>/grp.join:<gid>/grp.no:<gid>/grp.mergedInto:<gid> → 文字列）。
    // 分割・統合・手動採番というユーザーの明示操作だけを持つ（既定の集約は毎回 signature から導出する。
    // structural/memberGroups.js・memberNumbering.js 参照）。FBS の tagRegistryKeys/Vals チャネルへ
    // そのまま乗せる（graphSnapshot.js buildStructSnapshot/restoreStructCLs）。
    this.memberGroupLedger = observable.map();
    // 部材番号グループの派生キャッシュ（非永続。モード境界の収集フェーズで再構築される。
    // groupKey → {mapName, symbol, sizeKey, signature, floorRanks:Set<number>, hasRoof, counts:Map<planeId,number>}）。
    this.memberNumberIndex = observable.map();
    // 建具番号グループの派生キャッシュ（非永続。建具モード突入時の収集フェーズで再構築される。
    // signature → { symbol, subType, width, height, sillHeight, counts:Map<planeId,number>, tag }）。
    this.openingNumberIndex = observable.map();

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
      clearMemberNumberIndex: action,
      clearOpeningNumberIndex: action,
    });
  }

  clearMemberNumberIndex() { this.memberNumberIndex.clear(); }
  clearOpeningNumberIndex() { this.openingNumberIndex.clear(); }

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
