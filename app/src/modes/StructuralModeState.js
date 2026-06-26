import { makeObservable, observable, action } from 'mobx';

export class StructuralModeState {
  selectedEntityId = null; // 選択中の柱/梁 id | null
  placementState   = null; // 配置中ドラフト | null（配置UI本実装は次フェーズ）

  constructor(graph) {
    this.graph = graph;
    makeObservable(this, {
      selectedEntityId: observable,
      placementState:   observable.ref,
      selectEntity:      action,
      clearSelection:    action,
    });
  }

  selectEntity(id) { this.selectedEntityId = id; }

  clearSelection() {
    this.selectedEntityId = null;
    this.placementState   = null;
  }

  dispose() { this.clearSelection(); }
}
