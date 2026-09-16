import { makeObservable, observable, action, runInAction } from 'mobx';
import { beamAxisMoveRange } from '../structural/beamAxisMove.js';
import { sameIdSet } from '../structural/memberSelection.js';

const EMPTY_IDS = Object.freeze(new Set());

export class StructuralModeState {
  // 構造リスト（structural/MemberListTab.jsx）で展開中のカードの部材id集合（同一タグの全部材）。
  // renderer/StructuralLayer.jsx が structural/memberSelection.js でハイライト矩形へ写す
  // （ユーザー裁定2026-09-16「構造リストで材を選択すると描画エリアの当該材が選択状態に」）。
  // 書き手は App.jsx→StructuralPanel→MemberListTab の onSelectMembers だけ。空は共有の空Set。
  selectedMemberIds = EMPTY_IDS;
  placementState   = null; // 配置中ドラフト | null（配置UI本実装は次フェーズ）
  // 柱芯ラベル ロングタップ → 出幅編集の静止入力窓状態。ドラッグ追従はしない（窓は動かない）。
  // { cl, structure, screenX, screenY, projection } | null
  axisEditState    = null;
  // 梁芯CL移動（FloorplanModeState.moveState と同型: { cl, originalValue, range }）。
  // 梁芯の移動範囲は同期計算（他フロアのIDB読み込みが不要＝先読みすべき非同期処理が無い）のため
  // preloadMove は no-op、startMove も同期のまま moveState を立てる。
  moveState        = null;

  constructor(graph) {
    this.graph = graph;
    makeObservable(this, {
      selectedMemberIds: observable.ref,
      placementState:   observable.ref,
      axisEditState:    observable.ref,
      moveState:        observable.ref,
      selectMembers:     action,
      clearSelection:    action,
      startAxisEdit:     action,
      updateAxisEdit:    action,
      cancelAxisEdit:    action,
      startMove:         action,
      updateMove:        action,
      commitMove:        action,
      cancelMove:        action,
    });
  }

  // 選択中の部材id集合を差し替える（同内容なら書き換えない＝observer の無駄な再描画を避ける）。
  // 空・null は共有の空Setへ戻す。
  selectMembers(ids) {
    const next = ids ? new Set(ids) : EMPTY_IDS;
    if (sameIdSet(this.selectedMemberIds, next)) return;
    this.selectedMemberIds = next.size === 0 ? EMPTY_IDS : next;
  }

  startAxisEdit(state) { this.axisEditState = state; }
  // 入力中の出幅値だけ差し替える（窓位置・対象CLは不変）。
  updateAxisEdit(projection) {
    if (this.axisEditState) this.axisEditState = { ...this.axisEditState, projection };
  }
  cancelAxisEdit() { this.axisEditState = null; }

  clearSelection() {
    this.selectedMemberIds = EMPTY_IDS;
    this.placementState   = null;
    this.axisEditState    = null;
  }

  // ---- 梁芯CL移動 ----
  // ガター長押し（FloorplanModeState）と違い、梁芯の範囲計算は他フロアのIDB読み込みを伴わないため
  // 先読みは不要。interaction/usePointerInteraction.js の長押しメニュー表示が canMove の真時に無条件で preloadMove を呼ぶため
  // メソッド自体は必須（無いと長押しの瞬間に TypeError になる）。
  // interaction/usePointerInteraction.js が preloadMove(cl) の形で呼ぶが、梁芯は先読みする非同期処理が無いため引数は使わない。
  preloadMove() {}

  // 長押しメニューの「移動」選択時に呼ぶ。FloorplanModeState.startMove と違い非同期処理が無いため同期のまま。
  startMove(cl) {
    const range = beamAxisMoveRange(this.graph, cl);
    this.moveState = { cl, originalValue: cl.value, range };
    return null;
  }

  updateMove(newValue) {
    if (!this.moveState) return;
    runInAction(() => {
      const { cl, range } = this.moveState;
      const clamped = Math.min(Math.max(newValue, range.min), range.max);
      cl.pendingDelta = clamped - cl.value;
    });
  }

  commitMove() { this.moveState = null; }

  cancelMove() {
    if (this.moveState) {
      runInAction(() => { this.moveState.cl.pendingDelta = 0; });
    }
    this.moveState = null;
  }

  get isMoving() { return this.moveState !== null; }

  // dispose は clearSelection に加えて cancelMove を呼ぶ（clearSelection 自体には入れない——
  // 空白タップ等での意図しない移動中断を避けるため）。
  dispose() {
    this.clearSelection();
    this.cancelMove();
  }
}
