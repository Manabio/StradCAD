import { makeObservable, observable, action } from 'mobx';

// 建具モードの状態は選択中の開口IDのみ（graph を変える操作は行わない——モード切替時の
// 仮配置・削除・編集は App.jsx のメニューハンドラ層／openings/openingEdit.js に集約する）。
// startMove/startDraw を実装しない: App.jsx（longPress の clState.canMove 判定）はメソッドの
// 有無で移動可否を判定するため、CL移動は自動的に無効になる（.claude/opening-model.md）。
export class OpeningModeState {
  selectedOpeningId = null;

  constructor(graph, project, initialSelectedId = null) {
    this.graph   = graph;
    this.project = project;
    this.selectedOpeningId = initialSelectedId ?? null;
    makeObservable(this, {
      selectedOpeningId: observable,
      selectOpening:     action,
    });
  }

  selectOpening(id) { this.selectedOpeningId = id ?? null; }

  // 階切替時はモード再ロード effect（App.jsx）が新インスタンスを作るため選択は自然リセットされる。
  dispose() {}
}
