// structPerfEntry.mjs / structPerfScenario.mjs の --check が共有するゴールデン比較。
// 配列は要素の多重集合（ソート済み文字列）として比較する——柱・梁のid・生成順は
// recomputeStructuralForGraph のたびに変わりうるため、indexでの突き合わせはしない
// （dumpStructural.mjs・structAnchorProbe.mjsと同じ「安定キーで比較する」方針）。
// 数値・文字列はそのまま等値比較する（scenario.mjsのwalls/rooms件数など）。

/** golden/actual の差分を path 付きで列挙する。一致すれば空配列。 */
export function diffDump(golden, actual, pathPrefix = '') {
  const diffs = [];
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  if (Array.isArray(golden) || Array.isArray(actual)) {
    const gArr = [...(golden ?? [])].sort();
    const aArr = [...(actual ?? [])].sort();
    // 同じキーの個数差も差分にする（同位置・同断面・同番号の部材が1本増減しても拾う）。
    const count = (arr) => arr.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
    const surplus = (arr, other) => {
      const rest = count(other);
      return arr.filter((x) => { const n = rest.get(x) ?? 0; rest.set(x, n - 1); return n <= 0; });
    };
    const onlyGolden = surplus(gArr, aArr);
    const onlyActual = surplus(aArr, gArr);
    if (onlyGolden.length || onlyActual.length) {
      diffs.push({ path: pathPrefix || '(root)', onlyGolden, onlyActual });
    }
    return diffs;
  }

  if (isPlainObject(golden) || isPlainObject(actual)) {
    const keys = new Set([...Object.keys(golden ?? {}), ...Object.keys(actual ?? {})]);
    for (const key of [...keys].sort()) {
      const p = pathPrefix ? `${pathPrefix}.${key}` : key;
      diffs.push(...diffDump(golden?.[key], actual?.[key], p));
    }
    return diffs;
  }

  if (golden !== actual) diffs.push({ path: pathPrefix || '(root)', golden, actual });
  return diffs;
}

/** diffDump() の結果を人が読める形でコンソールへ出す（差分の先頭top件まで）。 */
export function reportDiffs(diffs, top = 5) {
  for (const d of diffs) {
    if (d.onlyGolden || d.onlyActual) {
      console.log(`  ${d.path}: golden${d.onlyGolden.length}件のみ/actual${d.onlyActual.length}件のみ`);
      for (const x of d.onlyGolden.slice(0, top)) console.log(`    - ${x}`);
      for (const x of d.onlyActual.slice(0, top)) console.log(`    + ${x}`);
      continue;
    }
    console.log(`  ${d.path}: golden=${JSON.stringify(d.golden)} actual=${JSON.stringify(d.actual)}`);
  }
}
