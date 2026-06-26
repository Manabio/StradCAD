import { useState } from 'react';
import './AddCLDialog.css';

/**
 * 階変更ダイアログ — 開始階（整数）の入力
 */
export function FloorChangeDialog({ currentStartFloor, onConfirm, onCancel }) {
  const [val, setVal] = useState(String(currentStartFloor));

  function handleConfirm() {
    const n = parseInt(val, 10);
    if (isNaN(n) || n === 0) return;
    onConfirm(n);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter')  handleConfirm();
    if (e.key === 'Escape') onCancel();
    e.stopPropagation();
  }

  return (
    <>
      <div className="cl-dialog-backdrop" onPointerDown={onCancel} />
      <div className="cl-dialog" onKeyDown={handleKeyDown}>
        <div className="cl-dialog-title">階変更</div>
        <label className="cl-dialog-row">
          <span className="cl-dialog-label">開始階</span>
          <input
            type="number"
            className="cl-dialog-input"
            value={val}
            autoFocus
            onChange={e => setVal(e.target.value)}
          />
        </label>
        <div className="cl-dialog-actions">
          <button className="cl-dialog-btn cl-dialog-btn--cancel" onClick={onCancel}>キャンセル</button>
          <button className="cl-dialog-btn cl-dialog-btn--ok" onClick={handleConfirm}>OK</button>
        </div>
      </div>
    </>
  );
}
