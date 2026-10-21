/**
 * 構造情報: 建物全体の既定値（主要構造・標準材料グレード・地域荷重）。
 *
 * core.js から分離した独立島。core の他クラスに依存しない。
 * 後方互換のため core.js が再エクスポートする。
 * 階ごとの例外は PlanGraph.structureOverride（mainStructure のみ。null=この建物全体値を継承）。
 */
import { makeObservable, observable, action } from 'mobx';
import { UNSPECIFIED_STRUCTURE, MAT_FOUNDATION, normalizeBasementStructure } from '../structural/structureRules.js';

/** 建物全体の構造の選択（captureStructureChoice の戻り値）が同じか。undo 登録の要否判定（structuralOrchestration.js）が使う。 */
export function structureChoiceEquals(a, b) {
  return a.mainStructure === b.mainStructure
    && a.basementStructure === b.basementStructure
    && a.foundationType === b.foundationType;
}

export class StructuralInfo {
  constructor() {
    this.mainStructure    = UNSPECIFIED_STRUCTURE;
    this.otherStructures  = observable.array([]);
    this.foundationType   = MAT_FOUNDATION;
    // 出幅（mm）: 通り芯から柱外面までの距離。1構造×1通り芯あたり1値で持つ（columnFaceProjections。
    // キー=`${structure}|${cl.label}`。混構造では構造ごと、X/Y通り芯ごとに別値を指定できる）。
    // ラーメン系の柱芯はこの出幅と自階の柱幅から決定的に導出する（autoFillColumnAxisOffsets）。
    // 0＝外面が通り芯と一致（既定）。columnFaceProjection は旧・建物1値の保持先で、無キー時の移行既定。
    this.columnFaceProjection  = 0;
    this.columnFaceProjections = observable.map();
    // 地階の構造（RC 系のみ。null＝地階構造なし＝主構造に従う）。effectiveStructure が地階で引く。
    this.basementStructure = null;
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
      basementStructure:    observable,
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
      setBasementStructure: action,
      restoreStructureChoice: action,
      toggleOtherStructure: action,
      setColumnFaceProjection: action,
    });
  }
  setField(field, value) { this[field] = value; }
  // 地階構造は null か BASEMENT_STRUCTURE_OPTIONS の値だけ許す（空文字が `??` を素通りして
  // rulesFor('') が未定扱いになるのを防ぐため、汎用 setField ではなく専用 action を通す）。
  setBasementStructure(v) {
    if (normalizeBasementStructure(v) !== v) throw new Error(`地階構造に使えない値: ${String(v)}`);
    this.basementStructure = v;
  }
  // 建物全体の構造の選択（主構造・地階構造・基礎種別）。共通タブの変更（structuralOrchestration.js
  // recomputeStructuralComposition の mutate）を undo/redo で戻すために、mutate の前後で採って戻す。
  // 新しい「構造の選択」項目を足したらここと structureChoiceEquals に足す（テストがキー集合を固定する）。
  captureStructureChoice() {
    return {
      mainStructure: this.mainStructure,
      basementStructure: this.basementStructure,
      foundationType: this.foundationType,
    };
  }
  // 地階構造を先に書く（選択肢外なら setBasementStructure が throw し、他の項目を書き換える前に止まる）。
  restoreStructureChoice(snap) {
    this.setBasementStructure(snap.basementStructure);
    this.setField('mainStructure', snap.mainStructure);
    this.setField('foundationType', snap.foundationType);
  }
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
