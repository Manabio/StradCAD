/**
 * CenterLine（中心線）・centerLineKind。core.js から分離。
 *
 * 通り芯はグリッドの源泉であり、GridX/GridY には依存しない。
 * 中心線が自身の座標 (value) を保持し、Intersection はその交差から派生する。
 *
 *   labeled:true  — グリッド軸として登録、ラベル自動付与 (X1/Y1/R1...)
 *                   VERTICAL/HORIZONTAL は直交する labeled 中心線と Intersection を自動生成
 *   labeled:false — 補助線、グリッド未登録、ラベルなし
 *
 * demoteToAuxiliary() で labeled:true → false に降格すると Intersection が削除される。
 * promoteToGrid()     で labeled:false → true に昇格すると Intersection が再生成される。
 */
import { makeObservable, observable, computed } from 'mobx';
import { Discipline, ShapeKind } from './constants.js';
import { Shape } from './shapeBase.js';

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

/**
 * 「通り芯（丸ナンバーを持つグリッド軸）か」の唯一の判定。
 *
 * **`cl.labeled` だけで判定してはいけない**——UI経路（transform/centerLineOps.js の
 * addCenterLineAt）で作られる中心線(kind:'center')は `labeled:true`（CenterLineコンストラクタの
 * 既定値）かつ `discipline:ARCH` になるため、`labeled` だけでは中心線まで通り芯扱いになる。
 * `_labeledCLs`（core/clQuery.js の系統A＝グリッド軸として交点を張る対象。discipline不問）とは
 * 別物である点に注意——系統Aは「交点を持つ軸か」、本関数は「通り芯として作図・採番される軸か」。
 * ラベル自動採番（_relabelCenterLines）・ガターの丸ラベル・展開図の通り芯丸は全てこちら。
 * @param {import('./centerLine.js').CenterLine} cl
 * @returns {boolean}
 */
export function isGridCenterLine(cl) {
  return !!cl.labeled && centerLineKind(cl) === 'struct';
}
