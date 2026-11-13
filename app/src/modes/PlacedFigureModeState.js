import { makeObservable, observable, action, computed } from 'mobx';
import { detailFigureEntry } from '../openings/openingCatalog.js';
import { placedFigureSubjectOf, placedFigureBelongsTo } from '../finish/placedFigure/placedFigureTargets.js';
import { updatePlacedFigure as updatePlacedFigureIn } from '../finish/placedFigure/placedFigureOps.js';
import {
  roundPlacedFigurePoint, placeFigure, updatePlacedFigureWithUndo, rotatePlacedFigureWithUndo,
  togglePlacedFigureMirrorWithUndo, removePlacedFigureWithUndo,
} from '../finish/placedFigure/placedFigureCommands.js';
import { placedFigureHitAt } from '../renderer/placedFigureHit.js';

/**
 * 図面モード（姿図配置モード）の汎用 MobX 状態。定義表 PLACED_FIGURE_MODES の 1 行（def＝{mode, label, subjects}）から立つ。
 * 受け持ちは選択・配置待ち・移動待ちだけ。graph の変更は placedFigureCommands.js の命令へ委譲し、自前で graph.setPlacedFigures を組まない
 * （備考 note の入力中の更新だけは FinishModeState と同じ直接更新＝undo は呼び出し側の field undo）。
 * 所属（def.subjects の分類か。分類不明は全モードに所属）は placedFigureBelongsTo の 1 か所で決める。
 * 所属しない配置の id・無い id への操作は何もしない（undo も積まない）。
 */
export class PlacedFigureModeState {
  placingFigureKey = null;        // 配置待ちの図キー（次のタップで置く）
  movingFigureId = null;          // 移動待ちの配置 id（次のタップで動かす）
  selectedPlacedFigureId = null;  // 選択中の配置 id

  constructor(graph, def, { figureOf = detailFigureEntry } = {}) {
    this.graph = graph;
    this.def = def;
    this.figureOf = figureOf;
    makeObservable(this, {
      placingFigureKey: observable,
      movingFigureId: observable,
      selectedPlacedFigureId: observable,
      selectedPlacedFigure: computed,
      movingFigure: computed,
      beginFigurePlacement: action,
      cancelFigurePlacement: action,
      beginFigureMove: action,
      cancelFigureMove: action,
      tapAt: action,
      selectPlacedFigure: action,
      updatePlacedFigure: action,
      rotatePlacedFigure: action,
      togglePlacedFigureMirror: action,
      removePlacedFigure: action,
      setPlacedFigureNote: action,
      cancelDrag: action,
      dispose: action,
    });
  }

  /** この mode に所属する実在の配置（無い・所属しないは undefined）。 */
  _owned(id) {
    const pf = this.graph.placedFigures.find(p => p.id === id);
    return pf !== undefined && placedFigureBelongsTo(pf, this.figureOf, this.def.subjects) ? pf : undefined;
  }

  /** この mode に所属する配置（分類不明を含む）。graph.placedFigures の並びのまま。 */
  placedFiguresInMode() {
    return this.graph.placedFigures.filter(p => placedFigureBelongsTo(p, this.figureOf, this.def.subjects));
  }

  /** 選択中の配置。実在し所属するときだけ（undo で消えた選択は null に見える）。 */
  get selectedPlacedFigure() {
    return this._owned(this.selectedPlacedFigureId) ?? null;
  }

  /** 移動待ちの配置。実在し所属するときだけ（undo で消えた移動待ちは null に見える＝帯・カーソルはこちらで判定する）。 */
  get movingFigure() {
    return this._owned(this.movingFigureId) ?? null;
  }

  /** 配置待ちを始める。空でない文字列で、図の分類が def.subjects に含まれるときだけ（図が引けない・他モードの分類は無視）。移動待ちは解く。 */
  beginFigurePlacement(key) {
    if (typeof key !== 'string' || key === '') return;
    const subject = placedFigureSubjectOf({ figureKey: key }, this.figureOf);
    if (subject === null || !this.def.subjects.includes(subject)) return;
    this.movingFigureId = null;
    this.placingFigureKey = key;
  }

  cancelFigurePlacement() { this.placingFigureKey = null; }

  /** 移動待ちを始める。この mode に所属する実在の配置だけ。配置待ちは解く。動かす配置が分かるよう選択も立てる。 */
  beginFigureMove(id) {
    if (this._owned(id) === undefined) return;
    this.placingFigureKey = null;
    this.movingFigureId = id;
    this.selectedPlacedFigureId = id;
  }

  cancelFigureMove() { this.movingFigureId = null; }

  /**
   * 平面のタップ。優先は 配置待ち ＞ 移動待ち ＞ ヒット。
   * 配置待ち: 丸めた点に置いて選択。移動待ち: 丸めた点へ動かす（id が既に無ければ解くだけ）。どちらでもなければヒットを選択・空振りは選択解除。
   */
  tapAt(wx, wy, { tolMm, mmPerPx } = {}) {
    if (this.placingFigureKey !== null) {
      const id = placeFigure(this.graph, { id: crypto.randomUUID(), figureKey: this.placingFigureKey, x: wx, y: wy });
      this.placingFigureKey = null;
      this.selectedPlacedFigureId = id;
      return;
    }
    if (this.movingFigureId !== null) {
      const id = this.movingFigureId;
      this.movingFigureId = null;
      if (this._owned(id) === undefined) return;
      const p = roundPlacedFigurePoint(wx, wy);
      updatePlacedFigureWithUndo(this.graph, id, { x: p.x, y: p.y });
      return;
    }
    this.selectedPlacedFigureId = placedFigureHitAt(this.graph.placedFigures, this.figureOf, {
      x: wx, y: wy, tolMm, mmPerPx, subjects: this.def.subjects,
    });
  }

  /** 配置を選択する。null で解除。所属しない id・無い id は無視。移動待ちの配置と別の配置を選ぶ・解除すると移動待ちも解く。 */
  selectPlacedFigure(id) {
    if (id === null) { this.selectedPlacedFigureId = null; this.movingFigureId = null; return; }
    if (this._owned(id) === undefined) return;
    this.selectedPlacedFigureId = id;
    // 移動待ちの配置と選択を食い違わせない（選択枠・行の強調が「動かす配置」を示す）。別の配置を選んだら移動待ちを解く
    if (this.movingFigureId !== id) this.movingFigureId = null;
  }

  /** 配置の項目を直す。1回で undo 1エントリ。 */
  updatePlacedFigure(id, changes) {
    if (this._owned(id) === undefined) return;
    updatePlacedFigureWithUndo(this.graph, id, changes);
  }

  rotatePlacedFigure(id) {
    if (this._owned(id) === undefined) return;
    rotatePlacedFigureWithUndo(this.graph, id);
  }

  togglePlacedFigureMirror(id) {
    if (this._owned(id) === undefined) return;
    togglePlacedFigureMirrorWithUndo(this.graph, id);
  }

  /** 配置を消す（undo で戻る）。選択中・移動待ちなら一緒に解く。 */
  removePlacedFigure(id) {
    if (this._owned(id) === undefined) return;
    if (!removePlacedFigureWithUndo(this.graph, id)) return;
    if (this.selectedPlacedFigureId === id) this.selectedPlacedFigureId = null;
    if (this.movingFigureId === id) this.movingFigureId = null;
  }

  /** 備考の入力中の更新。undo は呼び出し側のフォーカス〜ブラーの field undo に任せる（FinishModeState.setPlacedFigureNote と同じ）。 */
  setPlacedFigureNote(id, note) {
    if (this._owned(id) === undefined) return;
    const next = updatePlacedFigureIn(this.graph.placedFigures, id, { note });
    if (next !== null) this.graph.setPlacedFigures(next);
  }

  /** 関門の中断処理から呼ばれる口。配置待ち・移動待ちを解く。 */
  cancelDrag() {
    this.placingFigureKey = null;
    this.movingFigureId = null;
  }

  dispose() {
    this.cancelDrag();
  }
}
