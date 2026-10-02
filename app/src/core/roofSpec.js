/**
 * 屋根の仕様（RoofSpec）。core.js から分離。core/equipment.js と並ぶ値クラス。
 *
 * 屋根（Room.feature===ROOF）の8項目＋備考の唯一の保存先。Room.roofSpec が持つ（不変条件 I1:
 * feature===ROOF ⇔ roofSpec≠null）。項目集合の定義は ROOF_SPEC_KEYS と toData()/fromData() の
 * 1か所だけ——直列化（FBS・graphSnapshot）・仕上げモード undo・テストの突合はここを共通の入口にする。
 * 形状だけ null（＝自動）を持てる。表示時に導く（finish/roof/roofDefaults.js resolveRoofShape）。
 */
import { makeObservable, observable, action } from 'mobx';
import {
  RoofShape, DEFAULT_ROOF_SLOPE, DEFAULT_ROOF_EAVE_OVERHANG_MM, DEFAULT_ROOF_GABLE_OVERHANG_MM,
  DEFAULT_ROOF_SHEATHING, DEFAULT_ROOF_UNDERLAYMENT,
} from './constants.js';

/** RoofSpec の項目集合（toData() のキーと一致する。唯一の定義）。 */
export const ROOF_SPEC_KEYS = Object.freeze([
  'shape', 'slope', 'sheathingMaterial', 'underlaymentMaterial',
  'roofFinish', 'eaveOverhangMm', 'gableOverhangMm', 'soffit', 'note',
]);

const SHAPE_VALUES = new Set(Object.values(RoofShape));

/**
 * spec（RoofSpec または toData() 形式の plain）が既定値（new RoofSpec()）と全項目同じか。
 * 主屋根（PlanGraph.mainRoofSpec）は既定値のとき保存データへ何も書かない（既存文書のバイト列を変えない）
 * 判定の唯一の入口。項目集合は ROOF_SPEC_KEYS で比べるため、項目が増えても追随する。
 * 値が無い（null/undefined）ものは既定値扱い。
 * @param {object|null|undefined} spec
 * @returns {boolean}
 */
export function isDefaultRoofSpec(spec) {
  if (!spec) return true;
  const def = new RoofSpec().toData();
  const data = typeof spec.toData === 'function' ? spec.toData() : spec;
  return ROOF_SPEC_KEYS.every(k => data[k] === def[k]);
}

export class RoofSpec {
  constructor({
    shape = null,
    slope = DEFAULT_ROOF_SLOPE,
    sheathingMaterial = DEFAULT_ROOF_SHEATHING,
    underlaymentMaterial = DEFAULT_ROOF_UNDERLAYMENT,
    roofFinish = '',
    eaveOverhangMm = DEFAULT_ROOF_EAVE_OVERHANG_MM,
    gableOverhangMm = DEFAULT_ROOF_GABLE_OVERHANG_MM,
    soffit = '',
    note = '',
  } = {}) {
    this.shape = shape;                       // RoofShape | null（null＝自動）
    this.slope = slope;                       // 勾配 N/10 の N（0.5 刻みを許す）
    this.sheathingMaterial = sheathingMaterial;       // 野地板の材料コード
    this.underlaymentMaterial = underlaymentMaterial; // 防水シートの材料コード
    this.roofFinish = roofFinish;             // 屋根仕上げ（自由入力）
    this.eaveOverhangMm = eaveOverhangMm;     // 軒の出幅 mm（0 も正当）
    this.gableOverhangMm = gableOverhangMm;   // 妻側の出幅 mm（0 も正当）
    this.soffit = soffit;                     // 軒裏（自由入力）
    this.note = note;                         // 備考
    makeObservable(this, {
      shape:                observable,
      slope:                observable,
      sheathingMaterial:    observable,
      underlaymentMaterial: observable,
      roofFinish:           observable,
      eaveOverhangMm:       observable,
      gableOverhangMm:      observable,
      soffit:               observable,
      note:                 observable,
      setField:             action,
    });
  }

  setField(field, value) {
    if (!ROOF_SPEC_KEYS.includes(field)) throw new Error(`RoofSpec: 未知の項目です: ${field}`);
    this[field] = value;
  }

  /** 直列化・undo・FBS が共通して使う plain object 表現。項目集合の定義をここへ集約する。 */
  toData() {
    return {
      shape: this.shape, slope: this.slope,
      sheathingMaterial: this.sheathingMaterial, underlaymentMaterial: this.underlaymentMaterial,
      roofFinish: this.roofFinish, eaveOverhangMm: this.eaveOverhangMm,
      gableOverhangMm: this.gableOverhangMm, soffit: this.soffit, note: this.note,
    };
  }

  /**
   * plain object から RoofSpec を作る（直列化・undo・FBS が共通して使う）。壊れた値の正規化:
   * 未知の shape→null／slope が非有限または0以下→既定／出幅が非有限または負→既定（0 は正当なので保つ）／
   * 文字列の欠落→''／材料コードの欠落（空・非文字列）→既定。
   */
  static fromData(d) {
    const src = d ?? {};
    const str = v => (typeof v === 'string' ? v : '');
    const code = (v, fallback) => (typeof v === 'string' && v !== '' ? v : fallback);
    const finite = v => typeof v === 'number' && Number.isFinite(v);
    return new RoofSpec({
      shape: SHAPE_VALUES.has(src.shape) ? src.shape : null,
      slope: finite(src.slope) && src.slope > 0 ? src.slope : DEFAULT_ROOF_SLOPE,
      sheathingMaterial: code(src.sheathingMaterial, DEFAULT_ROOF_SHEATHING),
      underlaymentMaterial: code(src.underlaymentMaterial, DEFAULT_ROOF_UNDERLAYMENT),
      roofFinish: str(src.roofFinish),
      eaveOverhangMm: finite(src.eaveOverhangMm) && src.eaveOverhangMm >= 0
        ? src.eaveOverhangMm : DEFAULT_ROOF_EAVE_OVERHANG_MM,
      gableOverhangMm: finite(src.gableOverhangMm) && src.gableOverhangMm >= 0
        ? src.gableOverhangMm : DEFAULT_ROOF_GABLE_OVERHANG_MM,
      soffit: str(src.soffit),
      note: str(src.note),
    });
  }
}
