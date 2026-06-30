/**
 * 構造情報: 建物全体の既定値（主要構造・標準材料グレード・地域荷重）。
 *
 * core.js から分離した独立島。core の他クラスに依存しない。
 * 後方互換のため core.js が再エクスポートする。
 * 階ごとの例外は PlanGraph.structureOverride（mainStructure のみ。null=この建物全体値を継承）。
 */
import { makeObservable, observable, action } from 'mobx';

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
