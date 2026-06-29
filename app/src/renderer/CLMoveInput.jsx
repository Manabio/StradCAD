import { useState, useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { NumPad } from '../ui/NumPad.jsx';
import './CLMoveInput.css';

// 倍率分母の最大桁単位: 151→100, 230→200
export function calcStep(scaleDenom) {
  if (!scaleDenom || scaleDenom <= 0) return 1;
  const exp = Math.floor(Math.log10(scaleDenom));
  const place = Math.pow(10, exp);
  return Math.floor(scaleDenom / place) * place;
}

// CLの表示基準値を返す（相対表示の原点）
export function getDisplayBase(cl, isV, graph) {
  if (cl.refId) return cl._referencedCL?.value ?? 0;
  const gridCLs = isV ? (graph?.gridXs ?? []) : (graph?.gridYs ?? []);
  const originCL = gridCLs.find(c => c.id !== cl.id);
  return originCL ? originCL.value : 0;
}

// 絶対座標をステップ丸めした絶対座標に変換
export function roundAbsToStep(absVal, cl, isV, scaleDenominator, graph) {
  const base = getDisplayBase(cl, isV, graph);
  const displayVal = isV ? absVal - base : -(absVal - base);
  const step = calcStep(scaleDenominator);
  const roundedDisplay = step > 0 ? Math.round(displayVal / step) * step : Math.round(displayVal);
  return isV ? base + roundedDisplay : base - roundedDisplay;
}

// 四則演算の安全な評価（括弧なし・正規表現で事前検証）
export function safeEval(str) {
  if (!str) return NaN;
  if (!/^[+-]?\d+\.?\d*([+\-*/]\d+\.?\d*)*$/.test(str)) return NaN;
  try {
    const result = Function(`'use strict'; return (${str})`)();
    return typeof result === 'number' && isFinite(result) ? result : NaN;
  } catch {
    return NaN;
  }
}

// 先頭が+/-かつ数値1つ → 相対演算
function isRelative(str) {
  return /^[+-]\d+(\.\d+)?$/.test(str);
}

// 末尾が演算子でなく評価可能 → 式完了
export function isComplete(str) {
  if (!str) return false;
  if (/[+\-*/]$/.test(str)) return false;
  return !isNaN(safeEval(str));
}

// 末尾が演算子でない → 演算子を追加できる
function canAppendOp(str) {
  return str.length > 0 && !/[+\-*/]$/.test(str);
}

export const CLMoveInput = observer(function CLMoveInput({
  moveState, screenX, screenY, onUpdate, onCommit, onCancel, graph, scaleDenominator,
}) {
  const cl  = moveState?.cl ?? null;
  const isV = cl?.centerLineType === 'X';

  let displayValue = 0;
  let base = 0;

  if (cl) {
    base = getDisplayBase(cl, isV, graph);
    displayValue = isV ? cl.effectiveValue - base : -(cl.effectiveValue - base);
  }

  const baseRef             = useRef(0);
  const displayValueRef     = useRef(0);
  const scaleDenominatorRef = useRef(100);
  baseRef.current             = base;
  displayValueRef.current     = displayValue;
  scaleDenominatorRef.current = scaleDenominator ?? 100;

  const [inputStr, setInputStr] = useState('');
  const typingRef       = useRef(false);
  const inputStrRef     = useRef('');
  const applyRef        = useRef(null);
  const relativeBaseRef = useRef(0);
  const inputRef        = useRef(null);

  // 新しい移動セッション開始: リセット + オートフォーカス + 全選択
  useEffect(() => {
    if (moveState) {
      typingRef.current = false;
      const step    = calcStep(scaleDenominatorRef.current);
      const rounded = String(step > 0 ? Math.round(displayValueRef.current / step) * step : Math.round(displayValueRef.current));
      inputStrRef.current = rounded;
      setInputStr(rounded);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [moveState]);

  // ドラッグ中: タイピング前のみステップ丸めで追従
  useEffect(() => {
    if (!typingRef.current) {
      const step    = calcStep(scaleDenominatorRef.current);
      const rounded = step > 0 ? Math.round(displayValue / step) * step : Math.round(displayValue);
      const s = String(rounded);
      setInputStr(s);
      inputStrRef.current = s;
    }
  }, [displayValue]);

  function dispToAbs(d) {
    return isV ? baseRef.current + d : baseRef.current - d;
  }

  // 表示値 → onUpdate 呼び出し
  function commitDisplayVal(displayVal) {
    if (!isNaN(displayVal)) onUpdate(dispToAbs(displayVal));
  }

  function resolveDisplay(str) {
    if (!isComplete(str)) return NaN;
    const raw = safeEval(str);
    return isRelative(str) ? relativeBaseRef.current + raw : raw;
  }

  function applyStr(str) {
    // タイピング開始時に相対演算の基準値を取得
    if (!typingRef.current && str !== '') {
      relativeBaseRef.current = Math.round(displayValueRef.current);
    }
    inputStrRef.current = str;
    setInputStr(str);
    typingRef.current = str !== ''; // 空にしたらマウス追従復帰

    if (str !== '') {
      const v = resolveDisplay(str);
      if (!isNaN(v)) commitDisplayVal(v);
    }
  }
  applyRef.current = applyStr;

  // キーボード連携 (INPUT にフォーカスがない時のみ)
  useEffect(() => {
    if (!moveState) return;

    function onKeyDown(e) {
      if (document.activeElement?.tagName === 'INPUT') return;
      const str   = inputStrRef.current;
      const apply = applyRef.current;

      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        apply((str === '' || str === '0') ? e.key : str + e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        apply(str.length > 1 ? str.slice(0, -1) : '');
      } else if (e.key === '.') {
        e.preventDefault();
        if (!str.includes('.')) apply(str + '.');
      } else if (e.key === '-') {
        e.preventDefault();
        if (str === '' || str === '0') apply('-');
        else if (canAppendOp(str)) apply(str + '-');
      } else if (e.key === '+') {
        e.preventDefault();
        if (str === '') apply('+');
        else if (canAppendOp(str)) apply(str + '+');
      } else if (e.key === '*' || e.key === '/') {
        e.preventDefault();
        if (canAppendOp(str)) apply(str + e.key);
      } else if (e.key === 'Enter') {
        const v = resolveDisplay(inputStrRef.current);
        if (!isNaN(v)) commitDisplayVal(v);
        onCommit();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [moveState]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!moveState) return null;

  const axisLabel = isV ? 'X' : 'Y';
  let fromLabel;
  if (cl.refId) {
    fromLabel = `${cl._referencedCL?.label ?? axisLabel}から`;
  } else {
    const gridCLs = isV ? (graph?.gridXs ?? []) : (graph?.gridYs ?? []);
    const originCL = gridCLs.find(c => c.id !== cl.id);
    fromLabel = originCL ? `${originCL.label}から` : `${axisLabel} =`;
  }

  function handleChange(e) {
    const raw = e.target.value;
    if (/[+\-*/][+\-*/]/.test(raw)) return;             // 連続演算子を弾く
    if (raw !== '' && !/^[+-]?[\d.]*([+\-*/][\d.]*)*$/.test(raw)) return; // 無効文字を弾く
    applyStr(raw);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      const v = resolveDisplay(inputStrRef.current);
      if (!isNaN(v)) commitDisplayVal(v);
      onCommit();
    }
    if (e.key === 'Escape') onCancel();
    e.stopPropagation();
  }

  function handleNumConfirm() {
    const v = resolveDisplay(inputStrRef.current);
    if (!isNaN(v)) commitDisplayVal(v);
    onCommit();
  }

  return (
    <>
      <div className="cl-move-input" style={{ left: screenX + 14, top: screenY - 28 }}>
        <span className="cl-move-label">{fromLabel}</span>
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
        label={fromLabel}
        onChange={applyStr}
        onConfirm={handleNumConfirm}
        onCancel={onCancel}
      />
    </>
  );
});
