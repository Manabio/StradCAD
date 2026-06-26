import { makeObservable, observable, action, computed, runInAction } from 'mobx';
import { ERR_DRAW, ERR_CL_MOVE_TOO_DEEP, ERR_CL_MOVE_TOO_MANY, ERR_CL_MOVE_LOAD_FAILED } from '../error.js';
import { resolveMoveRange } from '../transform/followerGraph.js';

export class FloorplanModeState {
  drawState    = null; // { mode, startSnap, startWorld } | null
  moveState    = null; // { cl, originalValue, range } | null
  stretchState = null; // { target, originalVVal?, originalHVal?, originalX?, originalY? } | null
  selectedOpeningId = null; // 平面パレットで内容表示中の開口ID | null
  _pendingPreload = null; // { clId, promise } | null — ガター長押し中の先読み結果

  constructor(graph, project) {
    this.graph   = graph;
    this.project = project;
    makeObservable(this, {
      drawState:    observable.ref,
      moveState:    observable.ref,
      stretchState: observable.ref,
      selectedOpeningId: observable,
      selectOpening:     action,
      isDrawing:    computed,
      isMoving:     computed,
      isStretching: computed,
      startDraw:      action,
      completeDraw:   action,
      cancelDraw:     action,
      startMove:      action,
      updateMove:     action,
      commitMove:     action,
      cancelMove:     action,
      startStretch:   action,
      updateStretch:  action,
      commitStretch:  action,
      cancelStretch:  action,
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
  async startMove(cl) {
    const promise = (this._pendingPreload?.clId === cl.id)
      ? this._pendingPreload.promise
      : resolveMoveRange(this.project, this.graph, cl);
    this._pendingPreload = null;

    let result;
    try {
      result = await promise;
    } catch (e) {
      console.error(e);
      return ERR_CL_MOVE_LOAD_FAILED;
    }

    if (result.exceeded) {
      const msgs = [];
      const { depth, count } = result.exceeded;
      if (depth) msgs.push(ERR_CL_MOVE_TOO_DEEP(depth.actual - depth.max, depth.max));
      if (count) msgs.push(ERR_CL_MOVE_TOO_MANY(count.actual - count.max, count.max));
      return msgs.join(' ');
    }

    runInAction(() => {
      this.moveState = { cl, originalValue: cl.value, range: result.range };
    });
    return null;
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

  get isMoving()     { return this.moveState    !== null; }
  get isStretching() { return this.stretchState !== null; }

  // ---- Stretch（交点・自由点の 2D ドラッグ）----

  startStretch(target) {
    const { type, vertex } = target;
    if (type === 'intersection') {
      this.stretchState = {
        target,
        originalVVal: vertex.clVertical.value,
        originalHVal: vertex.clHorizontal.value,
      };
    } else {
      this.stretchState = {
        target,
        originalX: vertex.x,
        originalY: vertex.y,
      };
    }
  }

  updateStretch(wx, wy) {
    if (!this.stretchState) return;
    const { target } = this.stretchState;
    runInAction(() => {
      if (target.type === 'intersection') {
        // cl.value（確定座標）との差分を pendingDelta にセット
        target.vertex.clVertical.pendingDelta   = wx - target.vertex.clVertical.value;
        target.vertex.clHorizontal.pendingDelta = wy - target.vertex.clHorizontal.value;
      } else {
        target.vertex.pendingDX = wx - target.vertex.x;
        target.vertex.pendingDY = wy - target.vertex.y;
      }
    });
  }

  commitStretch() { this.stretchState = null; }

  cancelStretch() {
    if (this.stretchState) {
      runInAction(() => {
        const { target } = this.stretchState;
        if (target.type === 'intersection') {
          target.vertex.clVertical.pendingDelta   = 0;
          target.vertex.clHorizontal.pendingDelta = 0;
        } else {
          target.vertex.pendingDX = 0;
          target.vertex.pendingDY = 0;
        }
      });
    }
    this.stretchState = null;
  }

  // ---- Lifecycle ----

  dispose() {
    this.cancelDraw();
    this.cancelMove();
    this.cancelStretch();
  }
}
