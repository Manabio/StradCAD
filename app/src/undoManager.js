import { makeObservable, observable, computed, action } from 'mobx';

class UndoManager {
  _undoStack = [];
  _redoStack = [];

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
   */
  push(undoFn, redoFn) {
    this._undoStack.push({ undo: undoFn, redo: redoFn });
    this._redoStack.splice(0);
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
