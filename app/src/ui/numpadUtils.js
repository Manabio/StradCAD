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
