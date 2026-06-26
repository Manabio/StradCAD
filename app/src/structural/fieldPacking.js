// 構造材のサブタイプ別フィールド（mainBars等）を Room.overrides / Edge.overrides と同じ
// 「keys[]/vals[] の文字列ペア配列」方式で永続化するための共通ヘルパー。
// JSON.stringify/parse は使わない（.claude/implementation-policy.md の方針）。
// {size,pitch} 等の1段ネストオブジェクトはドット記法キー（例: "mainBars.size"）にフラット化する。

/** entity から keys で指定したフィールドを読み取り、[keys[], vals[]] のペア配列にする。 */
export function packExtraFields(entity, keys) {
  const outKeys = [];
  const outVals = [];
  for (const key of keys) {
    const value = entity[key];
    if (value == null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      for (const [subKey, subVal] of Object.entries(value)) {
        if (subVal == null) continue;
        outKeys.push(`${key}.${subKey}`);
        outVals.push(String(subVal));
      }
    } else {
      outKeys.push(key);
      outVals.push(String(value));
    }
  }
  return [outKeys, outVals];
}

/** packExtraFields の逆変換。ドット記法キーをネスト復元し、コンストラクタ props 引数を返す。 */
export function unpackExtraFields(keys, vals) {
  const props = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const val = vals[i];
    const dot = key.indexOf('.');
    if (dot > 0) {
      const parent = key.slice(0, dot);
      const child  = key.slice(dot + 1);
      props[parent] = props[parent] ?? {};
      props[parent][child] = coerce(val);
    } else {
      props[key] = coerce(val);
    }
  }
  return props;
}

// 数値らしい文字列は数値に、'true'/'false' は真偽値に復元する（それ以外は文字列のまま）。
function coerce(val) {
  if (val === 'true')  return true;
  if (val === 'false') return false;
  if (val !== '' && !Number.isNaN(Number(val))) return Number(val);
  return val;
}
