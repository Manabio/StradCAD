import { useState } from 'react';
import './AddCLDialog.css';
import { parsePlanCutHeightInput } from './planCutHeightInput.js';

/**
 * 平面の切断高ダイアログ — FL+mm の入力（階の属性。0以下・非数は確定不可）
 */
export function PlanCutHeightDialog({ currentHeightMm, onConfirm, onCancel }) {
  const [val, setVal] = useState(String(currentHeightMm));

  function handleConfirm() {
    const n = parsePlanCutHeightInput(val);
    if (n == null) return;
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
        <div className="cl-dialog-title">平面の切断高</div>
        <label className="cl-dialog-row">
          <span className="cl-dialog-label">FL+ (mm)</span>
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
