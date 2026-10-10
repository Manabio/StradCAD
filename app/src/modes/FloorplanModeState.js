import { makeObservable, observable, action, computed, runInAction } from 'mobx';
import { ERR_DRAW } from '../error.js';
import { resolveMoveRange } from '../transform/followerGraph.js';
import { prepareCenterLineMove } from './clMove.js';
import { runBusy } from '../uiBusy.js';

export class FloorplanModeState {
  drawState    = null; // { mode, startSnap, startWorld } | null
  moveState    = null; // { cl, originalValue, range } | null
  selectedOpeningId = null; // 平面パレットで内容表示中の開口ID | null
  _pendingPreload = null; // { clId, promise } | null — ガター長押し中の先読み結果

  constructor(graph, project) {
    this.graph   = graph;
    this.project = project;
    makeObservable(this, {
      drawState:    observable.ref,
      moveState:    observable.ref,
      selectedOpeningId: observable,
      selectOpening:     action,
      isDrawing:    computed,
      isMoving:     computed,
      startDraw:      action,
      completeDraw:   action,
      cancelDraw:     action,
      startMove:      action,
      updateMove:     action,
      commitMove:     action,
      cancelMove:     action,
    });
  }

  // ---- Draw ----

  startDraw(itemId, snap, worldPos) {
    if (itemId === 'diag') {
      this.drawState = { mode: itemId, startSnap: snap, startWorld: worldPos };
    }
  }

  completeDraw(snap) {
    const state = this.drawState;
    if (!state) return null;
    let result = null;
    try {
      if (state.mode === 'diag' && state.startSnap && snap) {
        result = this.graph.addDiagonalLine(state.startSnap, snap);
      }
    } catch (e) {
      console.error(ERR_DRAW, e);
    }
    this.drawState = null;
    return result;
  }

  cancelDraw() { this.drawState = null; }

  get isDrawing() { return this.drawState !== null; }

  // ---- 開口の選択（平面パレット表示用）----
  selectOpening(id) { this.selectedOpeningId = id ?? null; }

  // ---- CL Move ----

  // ガター長押し開始（pointerDown）時に呼ぶ。長押し確定までの待ち時間を使って
  // 移動範囲の計算（通り芯の場合は他フロアのIDB読み込みを含む）を先に走らせておく。
  preloadMove(cl) {
    this._pendingPreload = { clId: cl.id, promise: resolveMoveRange(this.project, this.graph, cl) };
  }

  // 長押し確定時に呼ぶ。preloadMove の結果（多くは既に解決済み）を使って移動を開始する。
  // 範囲計算が閾値超過していた場合は moveState を立てずエラーメッセージを返す。
  // 関門（uiBusy.js runBusy）本体はここで開く——呼び出し元（App.jsxのstartCenterLineMove・
  // ガター長押しのonFire）ではbeginUiTransitionを呼ばない。interruptCurrentActionがcancelMoveを
  // 呼ぶため、beginUiTransitionをここより前に挟むと準備中の移動そのものを壊してしまう
  // （入力規制ステップ3）。
  async startMove(cl) {
    const pending = this._pendingPreload;
    this._pendingPreload = null;

    return runBusy('移動準備', async () => {
      // 範囲解決とエラー文言は modes/clMove.js（天伏モードと共有）
      const { moveState, error } = await prepareCenterLineMove(this.project, this.graph, cl, pending);
      if (error) return error;
      runInAction(() => { this.moveState = moveState; });
      return null;
    });
  }

  updateMove(newValue) {
    if (!this.moveState) return;
    runInAction(() => {
      // cl.value は確定済み座標のまま保持。pendingDelta だけ更新することで
      // chamferWalls reaction (cl.value 監視) をドラッグ中に発火させない。
      const { cl, range } = this.moveState;
      const clamped = Math.min(Math.max(newValue, range.min), range.max);
      cl.pendingDelta = clamped - cl.value;
    });
  }

  commitMove() { this.moveState = null; }

  cancelMove() {
    if (this.moveState) {
      runInAction(() => {
        this.moveState.cl.pendingDelta = 0;
      });
    }
    this.moveState = null;
  }

  get isMoving() { return this.moveState !== null; }

  // ---- Lifecycle ----

  dispose() {
    this.cancelDraw();
    this.cancelMove();
  }
}
