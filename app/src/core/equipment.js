/**
 * 昇降機器具行（EquipmentRow）。core.js から分離。core/stair.js と並ぶ。
 *
 * 器具＝EV等1基。設置階のグラフに帰属し、占有セル（cellKeys）と昇降路Room（roomId）を持つ。
 * id・no は全階共通（他階の同一器具行も同じ id・no を持つ——ステップ3は自階ぶんのみ扱う）。
 */
import { makeObservable, observable, action } from 'mobx';
import { ElevatorEquipmentCategory, DEFAULT_EV_USAGE } from './constants.js';

export class EquipmentRow {
  constructor({ id, category, usage, no, cellKeys, roomId = null } = {}) {
    if (id == null)       throw new Error('EquipmentRow: id is required');
    if (category == null) throw new Error('EquipmentRow: category is required');
    if (no == null)        throw new Error('EquipmentRow: no is required');
    if (cellKeys == null) throw new Error('EquipmentRow: cellKeys is required');
    this.id       = id;       // 不変
    this.category = category; // 不変（ElevatorEquipmentCategory）
    this.usage    = usage;
    this.no       = no;
    this.cellKeys = cellKeys; // Set<string>（設置時点のキー。読むときはrefreshCellsを通す）
    this.roomId   = roomId;
    makeObservable(this, {
      usage:        observable,
      no:           observable,
      cellKeys:     observable,
      roomId:       observable,
      setUsage:     action,
      setNo:        action,
      setCellKeys:  action,
      setRoomId:    action,
    });
  }
  setUsage(usage)       { this.usage = usage; }
  setNo(no)             { this.no = no; }
  setCellKeys(set)      { this.cellKeys = set; }
  setRoomId(id)         { this.roomId = id; }

  /** 直列化・undo・FBS が共通して使う plain object 表現。フィールド集合の定義をここへ集約する。 */
  toData() {
    return {
      id: this.id, category: this.category, usage: this.usage, no: this.no,
      cellKeys: [...this.cellKeys], roomId: this.roomId ?? null,
    };
  }

  /**
   * plain object から EquipmentRow を作る（直列化・undo・FBS が共通して使う）。
   * 旧データ・壊れたデータの既定: usage空→DEFAULT_EV_USAGE／category空→'ev'
   * （未知の非空文字列は保持）／no未満1または非有限→1／roomId空→null。
   */
  static fromData(d) {
    const usage = d.usage || DEFAULT_EV_USAGE;
    const category = d.category || ElevatorEquipmentCategory.EV;
    const no = Number.isFinite(d.no) && d.no >= 1 ? d.no : 1;
    return new EquipmentRow({
      id: d.id, category, usage, no,
      cellKeys: new Set(d.cellKeys ?? []),
      roomId: d.roomId || null,
    });
  }
}
