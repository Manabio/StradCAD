import { makeObservable, observable, computed, action } from 'mobx';

class UndoManager {
  _undoStack = [];
  _redoStack = [];

  // 記録時のコンテキスト（{ mode, planeId } 等）を返す関数。App.jsx が設定する。
  // push 時に評価してエントリへ添付し、undo/redo 実行前の「モード・階の巻き戻し」判定に使う。
  contextProvider = null;

  constructor() {
    makeObservable(this, {
      _undoStack: observable.shallow,
      _redoStack: observable.shallow,
      canUndo:    computed,
      canRedo:    computed,
      push:       action,
      undo:       action,
      redo:       action,
    });
  }

  get canUndo() { return this._undoStack.length > 0; }
  get canRedo() { return this._redoStack.length > 0; }

  /**
   * 操作を記録する。呼び元がすでに操作を実行した後に呼ぶ。
   *
   * 軽量操作 → undoFn/redoFn に逆関数を渡す
   * 削除など → undoFn = () => restoreGraph(graph, before)
   *             redoFn = () => restoreGraph(graph, after)
   * @returns {object} 積んだエントリ（amend で後から合成する場合に使う）
   */
  push(undoFn, redoFn) {
    const cmd = { undo: undoFn, redo: redoFn, context: this.contextProvider?.() ?? null };
    this._undoStack.push(cmd);
    this._redoStack.splice(0);
    return cmd;
  }

  /** 次に undo されるエントリ（無ければ null）。実行はしない。 */
  peekUndo() { return this._undoStack[this._undoStack.length - 1] ?? null; }
  /** 次に redo されるエントリ（無ければ null）。実行はしない。 */
  peekRedo() { return this._redoStack[this._redoStack.length - 1] ?? null; }

  /**
   * 既存エントリへ undo/redo を後から合成する。操作の実行後に非同期で確定する
   * 付随変更（階段変換後の上階自動設置など）を、元の操作と同じ1エントリで
   * 巻き戻せるようにするためのもの。cmd がどちらのスタックへ移っていても機能する。
   * undo は追加分→既存分の順（適用の逆順）、redo は既存分→追加分の順で実行する。
   */
  amend(cmd, undoFn, redoFn) {
    const baseUndo = cmd.undo, baseRedo = cmd.redo;
    cmd.undo = () => { undoFn(); baseUndo(); };
    cmd.redo = () => { baseRedo(); redoFn(); };
  }

  undo() {
    if (!this.canUndo) return;
    const cmd = this._undoStack.pop();
    cmd.undo();
    this._redoStack.push(cmd);
  }

  redo() {
    if (!this.canRedo) return;
    const cmd = this._redoStack.pop();
    cmd.redo();
    this._undoStack.push(cmd);
  }
}

export const undoManager = new UndoManager();
