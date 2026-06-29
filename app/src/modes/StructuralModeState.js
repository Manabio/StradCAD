import { makeObservable, observable, action } from 'mobx';

export class StructuralModeState {
  selectedEntityId = null; // 選択中の柱/梁 id | null
  placementState   = null; // 配置中ドラフト | null（配置UI本実装は次フェーズ）
  // 柱芯ラベル ロングタップ → 出幅編集の静止入力窓状態。ドラッグ追従はしない（窓は動かない）。
  // { cl, structure, screenX, screenY, projection } | null
  axisEditState    = null;

  constructor(graph) {
    this.graph = graph;
    makeObservable(this, {
      selectedEntityId: observable,
      placementState:   observable.ref,
      axisEditState:    observable.ref,
      selectEntity:      action,
      clearSelection:    action,
      startAxisEdit:     action,
      updateAxisEdit:    action,
      cancelAxisEdit:    action,
    });
  }

  selectEntity(id) { this.selectedEntityId = id; }

  startAxisEdit(state) { this.axisEditState = state; }
  // 入力中の出幅値だけ差し替える（窓位置・対象CLは不変）。
  updateAxisEdit(projection) {
    if (this.axisEditState) this.axisEditState = { ...this.axisEditState, projection };
  }
  cancelAxisEdit() { this.axisEditState = null; }

  clearSelection() {
    this.selectedEntityId = null;
    this.placementState   = null;
    this.axisEditState    = null;
  }

  dispose() { this.clearSelection(); }
}
