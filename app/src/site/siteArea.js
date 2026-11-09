// 敷地の面積表示（三斜・長方形タブ共通の「面積：」行と内訳）の純関数（store.js/.jsx/snap.js を引かない）。
// 要素面積は小数第3位以下切り捨て、合計は切り捨て後の要素の合算。
import { computeUnionAreaM2 } from './siteRectGeometry.js';

/**
 * ㎡ を小数第3位以下切り捨てで 0.01 ㎡単位へ。
 * 微小加算の理由: mm²→㎡ の浮動小数で 11.999999… のように僅かに下振れする値（本来 12.00）を
 * floor で 11.99 にしてしまわないため（例: 1000×290 mm は 0.29×100=28.999999999999996）。
 * 副作用: 境界の下 1e-8 ㎡以内の値（例 12.349999999）は繰り上がる。mm 整数の入力では起きないことを網羅計算で確認済み（QA 2026-11-09）。
 */
export function truncateAreaM2(m2) {
  return Math.floor(m2 * 100 + 1e-6) / 100;
}

/**
 * 三斜の内訳行。番号は三角番号（site.lines 順に底辺を持つ三角形へ 1 始まり。triangleNumber・computeLineTriNums と同じ採番）。
 * formula は求積表の書式「底辺 × 高さ × 1/2」（長方形は「よこ × たて」）。「=」と小計は表の別セルに出す。
 * 高さは切り捨て前の面積から逆算し mm 整数へ丸めて表示する（長方形の w×h も同じ）。
 * 入力は mm 整数が常用なので、式を手計算した値と切り捨て後の面積が端数入力で食い違うことは受容（リード裁定 2026-11-09）。areaM2 は切り捨て後。
 * @returns {{ num:number, formula:string, areaM2:number }[]}
 */
export function buildSanshaAreaRows(site) {
  const triByLine = new Map([...site.triangleMap.values()].map(t => [t.baseLine.id, t]));
  const rows = [];
  let num = 0;
  for (const line of site.lines) {
    const tri = triByLine.get(line.id);
    if (!tri) continue;
    num++;
    const base = line.length;
    const area = tri.area;
    const height = base > 1e-6 ? (area * 2_000_000) / base : 0;
    rows.push({ num, formula: `${base.toFixed(0)} × ${height.toFixed(0)} × 1/2`, areaM2: truncateAreaM2(area) });
  }
  return rows;
}

/**
 * 長方形の内訳行。番号は rects の順（表の番号）。
 * @returns {{ num:number, formula:string, areaM2:number }[]}
 */
export function buildRectAreaRows(rects) {
  return rects.map((r, i) => ({
    num: i + 1,
    formula: `${r.w.toFixed(0)} × ${r.h.toFixed(0)}`,
    areaM2: truncateAreaM2((r.w * r.h) / 1_000_000),
  }));
}

// 切り捨て後の要素面積の合算（合計は素の面積の和ではない）。浮動小数の和の誤差は 0.01 刻みへ丸め直す
export function sumAreaM2(rows) {
  return Math.round(rows.reduce((s, r) => s + r.areaM2, 0) * 100) / 100;
}

// 長方形に重なりがあるか（素の面積の和が和集合より大きい）。重なりは合算に二重に入る。
// 閾値 1e-9 ㎡は浮動小数の誤差より大きく、最小の重なり 1 mm²（1e-6 ㎡）より十分小さい
export function rectsOverlap(rects) {
  const raw = rects.reduce((s, r) => s + (r.w * r.h) / 1_000_000, 0);
  return raw > computeUnionAreaM2(rects) + 1e-9;
}

export const formatAreaM2 = (m2) => m2.toFixed(2);
