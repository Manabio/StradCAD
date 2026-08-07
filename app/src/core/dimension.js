/**
 * 寸法線クラス群（DimensionAnchor / DimensionLine / HDimensionLine / VDimensionLine）。
 * core.js から分離。
 *
 * 通り芯間 / 中心線間 / おさえ位置 の距離を表示する寸法図形。
 * 4 周(top/bottom/left/right)に配置可能。
 *
 *   kind === GRID:      labeled struct CL を全自動でアンカー化、ガター内表示、足長0
 *                       CL の追加・削除・移動に effectiveAnchors の computed で自動追従
 *   kind === CENTER:    ラベルなし中心線（補助線除く）を全自動でアンカー化。
 *                       軸ごとに最大2行（side=TOP/BOTTOM または LEFT/RIGHT）持ち、
 *                       各行は直交する最外通り芯（centerBoundary）に到達している中心線のみを拾う。
 *                       「到達」判定はズーム依存のオーバーハングを含む見た目上の延伸範囲（clExtent）基準のため
 *                       viewport が必要 → effectiveAnchors/segments では計算できず、
 *                       renderer/GutterLayer.jsx が centerBoundary を使って直接組み立てる。
 *                       ワールド空間に実寸オフセットして描画。中心線を1本も含まない通り芯間区間は
 *                       生成しない（GRID寸法に表示を委ねる）。
 *   kind === CONTROL:   壁面・開口など face 位置の寸法。明示的なアンカーを保持
 *
 * 軸の表現は 'X' / 'Y'。HDimensionLine が横並び(X間距離)、VDimensionLine が縦並び(Y間距離)。
 * セグメント長は to.value - from.value を整数 mm に丸めて表示。
 *
 * DimensionLine は core/structuralEntities.js の StructuralEntity と同じ半公開扱い:
 * ここでは export するが、core.js からは再エクスポートしない（instanceof 判定用に core.js が import のみする）。
 */
import { makeObservable, observable, computed } from 'mobx';
import { DimensionKind, DimensionSide, ShapeKind } from './constants.js';
import { Shape } from './shapeBase.js';

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
export class DimensionLine extends Shape {
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
