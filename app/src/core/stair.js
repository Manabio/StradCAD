/**
 * 階段（totalStepsFromSections / Stair）。core.js から分離。
 */
import { makeObservable, observable, action } from 'mobx';
import { StairType, StructuralMaterialType } from './constants.js';

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
    nosing      = 20,      // 蹴込(mm。ユーザー指示2026-08で既定30→20）
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
