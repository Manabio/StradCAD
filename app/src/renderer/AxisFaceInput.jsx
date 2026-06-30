import { useState, useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { NumPad } from '../ui/NumPad.jsx';
import { safeEval, isComplete } from './CLMoveInput.jsx';
import './CLMoveInput.css';

// 柱芯ラベル ロングタップで開く「出幅（柱外面⇔通り芯）」の静止入力窓＋numPad。
// CLMoveInput と違い世界座標ドラッグ追従はしない（窓位置 screenX/Y は開いた時点で固定）。
// スナップなし・数値入力のみ。確定で onConfirm（出幅の永続化は Phase 4 で App 側が担う）。
const LABEL = '柱外面 ⇔ 通り芯';

export const AxisFaceInput = observer(function AxisFaceInput({ editState, onChange, onConfirm, onCancel }) {
  const inputRef    = useRef(null);
  const inputStrRef = useRef('');
  const [inputStr, setInputStr] = useState('');

  // 新しい編集セッション開始: 現在の出幅を表示＋全選択（仕様「当該距離表示かつ選択状態」）。
  useEffect(() => {
    if (editState) {
      const s = String(Math.round(editState.projection ?? 0));
      inputStrRef.current = s;
      setInputStr(s);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editState?.cl]); // セッション識別子。projection更新での再発火（＝再選択）を防ぐ

  if (!editState) return null;

  function apply(str) {
    inputStrRef.current = str;
    setInputStr(str);
    if (str !== '' && isComplete(str)) {
      const v = safeEval(str);
      // 符号を保持して渡す（外周軸では確定側で絶対値化、内部軸は符号＝移動の向き）。
      if (!isNaN(v)) onChange(v);
    }
  }

  function confirm() {
    const v = safeEval(inputStrRef.current);
    if (!isNaN(v)) onChange(v);
    onConfirm();
  }

  function handleChange(e) {
    const raw = e.target.value;
    if (/[+\-*/][+\-*/]/.test(raw)) return;
    if (raw !== '' && !/^[+-]?[\d.]*([+\-*/][\d.]*)*$/.test(raw)) return;
    apply(raw);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter')  confirm();
    if (e.key === 'Escape') onCancel();
    e.stopPropagation();
  }

  return (
    <>
      <div className="cl-move-input" style={{ left: editState.screenX + 14, top: editState.screenY - 28 }}>
        <span className="cl-move-label">{LABEL}</span>
        <input
          ref={inputRef}
          className="cl-move-value"
          type="text"
          inputMode="decimal"
          value={inputStr}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
        <span className="cl-move-unit">mm</span>
      </div>

      <NumPad
        value={inputStr}
        label={LABEL}
        onChange={apply}
        onConfirm={confirm}
        onCancel={onCancel}
      />
    </>
  );
});
