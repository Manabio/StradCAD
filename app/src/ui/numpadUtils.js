// 物理キーボードの key を NumPad キー記号へ変換する（数字・記号・Backspace のみ。該当なしは null）
export function toNumpadKey(key) {
  if (/^[0-9]$/.test(key)) return key;
  if (key === 'Backspace') return '⌫';
  if (key === '.')  return '.';
  if (key === '+')  return '+';
  if (key === '-')  return '-';
  if (key === '*')  return '×';
  if (key === '/')  return '÷';
  return null;
}

// 数式文字列を数値評価する（App.jsx evalExpr と同一ロジック）。
// positiveOnly=true（既定）は v>0 のみ許容（CL移動量等）。false は 0以下・負値も許容する
// （CL偏芯量など符号付き入力向け。第2段のSiteInfoPanel.jsx差し替えで使用）。
export function evalNumpadExpr(s, { positiveOnly = true } = {}) {
  if (!s) return NaN;
  try {
    const expr = s.replace(/×/g, '*').replace(/÷/g, '/');
    if (/[+\-*/]$/.test(expr)) return NaN;
    const v = Function(`"use strict"; return (${expr})`)();
    if (typeof v !== 'number' || !isFinite(v)) return NaN;
    return positiveOnly ? (v > 0 ? v : NaN) : v;
  } catch { return NaN; }
}

// NumPad キー 1 つを現在値に適用して新しい値を返す（キーボード入力との共有用）
export function applyKeyToNumpadValue(value, k) {
  function canAppendOp(v) {
    return v.length > 0 && !/[+\-*/]$/.test(v);
  }
  switch (k) {
    case '⌫': return value.length > 1 ? value.slice(0, -1) : '';
    case '.':  return value.includes('.') ? value : value + '.';
    case '+':
    case '-':
      if (value === '') return k;
      if (canAppendOp(value)) return value + k;
      return value;
    case '×':
    case '÷': {
      const op = k === '×' ? '*' : '/';
      return canAppendOp(value) ? value + op : value;
    }
    default: // 数字
      return (value === '' || value === '0') ? k : value + k;
  }
}
