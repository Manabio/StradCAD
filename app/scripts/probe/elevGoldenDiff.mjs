// 展開図プリミティブ（dumpElevFigure.mjs の出力の `prims` 配列）を、
// ゴールデン（旧設計）と新設計の出力で比較するための純モジュール。
// diffElevGolden.mjs（CLI）から使う。io・process.argv等は持たない＝node:testから直接単体テスト可能
// （.claude/skills/team-lessons/SKILL.mdの「抽出純モジュール」規約どおり）。
//
// 展開図プリミティブの語彙は実は3箇所に分散している——
//   1. elevation/*.js（prims.push）が語彙を生む
//   2. elevation/elevationPrimitives.js の translatePrimitive/mirrorPrimitiveX（:80-83の不変条件
//      コメント）が「両関数は同じ型集合を扱うこと」を要求する＝型ごとに必要な属性の一次ソース
//   3. renderer/figurePrimitivesKonva.jsx の renderOne（:128-166）が実際に描画で読む属性
//      （stroke/fill/rx/closed等。weight/dash以外にも見た目に効く属性がある）
// 本モジュールが「どの属性を鍵に使うか」を決めるときは2・3を基準にする。QA指摘2026-09:
// 属性の**白名簿**（型ごとに列挙）方式は、上記3箇所のどこかに新しい属性が増えるたびに
// ここだけ更新漏れが起こり「見た目が違うのに一致」という無言の見逃しを生む。そこで**黒名簿**
// （無視する属性だけを列挙）方式に反転した——未知の属性は常に鍵に含まれるので、型に新属性が
// 増えても黒名簿に無ければ自動的に拾われる（「無視一覧以外は全部キーに使う」）。
//
// 用語:
//   geomKey  … プリミティブの「位置」を表す鍵（IGNORE_FIELDS除く全属性。STYLE_TYPEDな型は
//              weight/dash/dashAnchorを除く）
//   styleKey … 「線種」を表す鍵（STYLE_TYPEDな型のweight/dash/dashAnchorのみ。他は常に空）
//   fullKey  … geomKey+styleKey の完全一致鍵（多重集合比較の単位）
// IGNORE_FIELDS（openingId等のid的な属性）は常に無視する（描画に影響しない）。
//
// 既知の限界（QA指摘2026-09B）: 以下は`--merge`でも偽差分（実際は見た目が同じなのに
// added/removedが出る）になり得る——今回は対応しない。
//   - 斜め線・折れ線の端点の入れ替え（(x1,y1)-(x2,y2)を(x2,y2)-(x1,y1)にしても実線なら見た目は
//     同じだが、`dash:'center'`の一点鎖線は端点順で位相（dashAnchorからの距離）が決まるため
//     一律には正規化しない——順序を畳むと本物の位相ズレを見逃す）。
//   - 閉じたpolyline（closed:true）の開始頂点が違うだけ（同じ輪郭でも配列の先頭点が違うと
//     geomKeyが変わる。decomposePolylinesの対象外＝分解して畳めない）。

const ROUND_DP = 3;
const round = (v) => (typeof v === 'number' ? Math.round(v * 10 ** ROUND_DP) / 10 ** ROUND_DP : v);

// 描画に影響しないid的な属性（全プリミティブ型に共通で無視する）。
// openingId: tag（建具記号丸）がクリック識別のために持つ。見た目（形・色）には使われない。
// __o: elevation/section/sectionEmit.js（:679,698,701,800,806,838,842）がline生成のたびに
//      付ける発生元タグ（'cutOpeningEdge'/'cutEdgeLo'等。デバッグ・由来追跡用）。
//      renderer/figurePrimitivesKonva.jsxのrenderOneは読まない＝見た目に一切影響しない。
//      golden13実測でline 1155件中45件がこの属性を持つ。
const IGNORE_FIELDS = new Set(['openingId', '__o']);

// weight/dash/dashAnchorを「線種」として位置から分離する型。
// 「同一位置・線種違いの変更」判定（changedバケツ）が効くのはこの型だけ——
// line/polyline以外（rect/circle/text/tag/dim/miterTriangle）はweight等の線種属性を
// 持たない（rectのweight等、持つ場合もgeomKeyへそのまま含めるだけでよい。値の違いは
// add/remove対として検出される＝「消えない」ことが目的でchangedへの分類は必須ではない）。
const STYLE_TYPED = new Set(['line', 'polyline']);
const STYLE_FIELD_NAMES = ['weight', 'dash', 'dashAnchor'];

function assertPrim(p) {
  if (!p || typeof p !== 'object' || typeof p.type !== 'string') {
    throw new TypeError(`不正なプリミティブ: ${JSON.stringify(p)}`);
  }
}

function roundDeep(v) {
  if (Array.isArray(v)) return v.map(roundDeep);
  return round(v);
}

function pickKey(p, fields) {
  const out = {};
  for (const f of fields) {
    if (p[f] === undefined) continue;
    out[f] = roundDeep(p[f]);
  }
  return JSON.stringify(out, Object.keys(out).sort());
}

function ownFields(p) {
  return Object.keys(p).filter(k => k !== 'type' && !IGNORE_FIELDS.has(k));
}

/** プリミティブの位置鍵（STYLE_TYPEDな型はweight/dash/dashAnchorを含まない）。 */
export function geomKeyOf(p) {
  assertPrim(p);
  const fields = STYLE_TYPED.has(p.type)
    ? ownFields(p).filter(k => !STYLE_FIELD_NAMES.includes(k))
    : ownFields(p);
  return `${p.type}|${pickKey(p, fields)}`;
}

/** プリミティブの線種鍵（weight/dash/dashAnchor。STYLE_TYPEDでない型は常に空文字）。 */
export function styleKeyOf(p) {
  assertPrim(p);
  return STYLE_TYPED.has(p.type) ? pickKey(p, STYLE_FIELD_NAMES) : '';
}

/** 完全一致鍵（多重集合比較の単位）。 */
export function fullKeyOf(p) {
  return `${geomKeyOf(p)}::${styleKeyOf(p)}`;
}

function bump(map, key, item) {
  const list = map.get(key);
  if (list) list.push(item); else map.set(key, [item]);
}

/**
 * 2つのプリミティブ配列を多重集合として比較する（合併なし）。
 * @returns {{added:object[], removed:object[], changed:{before:object, after:object}[]}}
 *   added   … newPrimsにのみ存在（位置ごと数え上げ後の残り）
 *   removed … goldenPrimsにのみ存在
 *   changed … 同じgeomKeyだがstyleKeyが違う組（線種だけ違う＝同一位置の変更）
 */
export function diffPrimitiveLists(goldenPrims, newPrims) {
  if (!Array.isArray(goldenPrims) || !Array.isArray(newPrims)) {
    throw new TypeError('diffPrimitiveLists: goldenPrims/newPrimsは配列である必要があります');
  }
  // 1. fullKeyで完全一致する分を消し合う。
  const byFullG = new Map();
  for (const p of goldenPrims) bump(byFullG, fullKeyOf(p), p);
  const leftoverG = [];
  const byFullN = new Map();
  for (const p of newPrims) bump(byFullN, fullKeyOf(p), p);
  for (const [key, list] of byFullG) {
    const nList = byFullN.get(key) ?? [];
    const consumed = Math.min(list.length, nList.length);
    for (let i = consumed; i < list.length; i++) leftoverG.push(list[i]);
    byFullN.set(key, nList.slice(consumed));
  }
  const leftoverN = [...byFullN.values()].flat();

  // 2. 残りをgeomKeyでグループ化し、両側にあれば「変更」（線種違い）、片側だけなら追加/削除。
  const byGeomG = new Map();
  for (const p of leftoverG) bump(byGeomG, geomKeyOf(p), p);
  const byGeomN = new Map();
  for (const p of leftoverN) bump(byGeomN, geomKeyOf(p), p);

  const changed = [];
  const removed = [];
  const added = [];
  for (const [key, gList] of byGeomG) {
    const nList = byGeomN.get(key) ?? [];
    const pairCount = Math.min(gList.length, nList.length);
    for (let i = 0; i < pairCount; i++) changed.push({ before: gList[i], after: nList[i] });
    for (let i = pairCount; i < gList.length; i++) removed.push(gList[i]);
    byGeomN.set(key, nList.slice(pairCount));
  }
  for (const list of byGeomN.values()) added.push(...list);

  return { added, removed, changed };
}

// ---- 合併後比較（--merge）----

// sectionEmit.js の mergeIntervals（媒介変数区間[0,1]を1e-9で結合）と同じ「昇順ソート→接する/
// 重なる区間を結合」の形だが、本モジュールの入力はdumpElevFigure.mjsのnorm()で既に小数点以下
// 3桁（0.001mm）へ丸め済みのmm座標——丸め後の浮動小数ノイズ（1e-9未満）は確実に飲み込みつつ、
// 実際に意味のある1mm未満の間隙は「接していない」と判定できるよう、両者の中間の1e-6を使う。
const MERGE_EPS = 1e-6;

/** line型のみ対象。軸に平行（縦 or 横）な線だけを合併候補にする（斜めは対象外＝そのまま通す）。 */
function lineAxis(p) {
  if (p.type !== 'line') return null;
  if (Math.abs(p.x1 - p.x2) < MERGE_EPS) return 'v';
  if (Math.abs(p.y1 - p.y2) < MERGE_EPS) return 'h';
  return null;
}

function mergeGroupKey(p, axis) {
  const fixed = axis === 'v' ? round(p.x1) : round(p.y1);
  return `${axis}|${fixed}|${styleKeyOf(p)}`;
}

function intervalOf(p, axis) {
  const [a, b] = axis === 'v' ? [p.y1, p.y2] : [p.x1, p.x2];
  return [Math.min(a, b), Math.max(a, b)];
}

/** 区間群を昇順に結合する（接する・重なるものを1本へ）。 */
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + MERGE_EPS) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

/**
 * 同一直線上・同一線種の縦/横線分群を、接する/重なる区間ごとに1本へ合併する。
 * 斜めの線・line以外のプリミティブはそのまま素通りする。
 * @returns {object[]} 合併後のプリミティブ配列（合併で生成した線はsample（先頭要素）の
 *   weight/dash/dashAnchorを引き継ぐ。元の配列の順序は保証しない）。
 */
export function mergeCollinearLines(prims) {
  if (!Array.isArray(prims)) throw new TypeError('mergeCollinearLines: prims は配列である必要があります');
  const groups = new Map(); // key -> {axis, fixed, sample, intervals:[]}
  const passthrough = [];
  for (const p of prims) {
    assertPrim(p);
    const axis = lineAxis(p);
    if (!axis) { passthrough.push(p); continue; }
    const key = mergeGroupKey(p, axis);
    const fixed = axis === 'v' ? round(p.x1) : round(p.y1);
    let g = groups.get(key);
    if (!g) { g = { axis, fixed, sample: p, intervals: [] }; groups.set(key, g); }
    g.intervals.push(intervalOf(p, axis));
  }
  const merged = [];
  for (const g of groups.values()) {
    for (const [lo, hi] of mergeIntervals(g.intervals)) {
      const { sample, axis, fixed } = g;
      merged.push(axis === 'v'
        ? { ...sample, x1: fixed, x2: fixed, y1: lo, y2: hi }
        : { ...sample, y1: fixed, y2: fixed, x1: lo, x2: hi });
    }
  }
  return [...passthrough, ...merged];
}

/**
 * 開いた（closed指定なし・fill無し）polylineを、隣接点対ごとのline群へ分解する
 * （points以外の全属性——weight/dash/dashAnchorだけでなくstroke等の描画属性も——をそのまま
 * 引き継ぐ。QA指摘2026-09: 以前はweight/dash/dashAnchorしか引き継がずstroke等を落としていたため、
 * 「開いたpolylineのstroke違い」が分解後は両側とも無属性になって一致扱いになっていた）。
 * 519365cで階段帯の断面線がline群→折れ線輪郭(polyline)へ置き換わったため、「旧設計のline群」と
 * 「新設計の同じ輪郭のpolyline」をmergeCollinearLinesの前段で同じ語彙（line）へ揃えないと、
 * 見た目が同じでも全量added/removedになってしまう。
 * **closed:trueまたはfill指定のあるpolylineは分解しない**——塗り矩形・閉輪郭は「辺の集合」ではなく
 * 1つの面として意味を持つため、分解すると閉じる辺（終点→始点）の有無の違いを見失う。
 * @returns {object[]}
 */
export function decomposePolylines(prims) {
  if (!Array.isArray(prims)) throw new TypeError('decomposePolylines: prims は配列である必要があります');
  const out = [];
  for (const p of prims) {
    assertPrim(p);
    if (p.type !== 'polyline' || p.closed || p.fill != null) { out.push(p); continue; }
    // type/pointsを除いた残り属性（stroke等）だけ引き継ぐ。
    const { type: _type, points: _points, ...rest } = p;
    for (let i = 0; i < p.points.length - 1; i++) {
      const [x1, y1] = p.points[i];
      const [x2, y2] = p.points[i + 1];
      out.push({ ...rest, type: 'line', x1, y1, x2, y2 });
    }
  }
  return out;
}

const isLine = (p) => p.type === 'line';
// decomposePolylinesが分解対象にするpolyline（開いていてfill無し）＝mergeCollinearLinesの
// 合併パイプラインが管理する側。この判定はdecomposePolylinesの分岐条件と必ず同じにすること
// ——こことdecomposePolylinesの条件がずれると、片方だけが「合併管理下」と誤認して二重計上/
// 消失のどちらかが起きる。
const isDecomposablePolyline = (p) => p.type === 'polyline' && !p.closed && p.fill == null;
const isMergeManaged = (p) => isLine(p) || isDecomposablePolyline(p);

/**
 * 部屋1件ぶんのプリミティブ配列を比較する（diffElevGolden.mjsが呼ぶ本体）。
 * merge:true のときは、開いたpolylineをlineへ分解してから合併し、「合併管理下」
 * （line・開いたpolyline）の追加/削除/変更だけを合併後の結果へ差し替える——それ以外
 * （rect/text/dim/閉じたpolyline等）は合併の対象外のため常に素の比較結果（naive）を使う。
 * QA指摘2026-09その1: 以前はnaiveの「非line」を無条件で残していたため、mergeCollinearLinesが
 * 素通りする型（rect/text等）がnaiveとmergedDiffの両方に現れて二重計上されていた
 * →mergedDiff側をline型に限定して解消。
 * QA指摘2026-09その2: decomposePolylines導入後は「開いたpolyline」もmerge管理下に入るため、
 * 二重計上の判定を`isLine`だけでなく`isMergeManaged`（line∪開いたpolyline）に広げる必要がある
 * ——さもないと開いたpolylineの線種違いがnaive側とmergedDiff側の両方でchangedに数えられる。
 * @returns {{added:object[], removed:object[], changed:{before,after}[],
 *   splitMerged:{beforeAdded:number, beforeRemoved:number, afterAdded:number, afterRemoved:number}|null}}
 */
export function diffRoomPrimitives(goldenPrims, newPrims, { merge = false } = {}) {
  const naive = diffPrimitiveLists(goldenPrims, newPrims);
  if (!merge) return { ...naive, splitMerged: null };

  const mergedDiff = diffPrimitiveLists(
    mergeCollinearLines(decomposePolylines(goldenPrims)),
    mergeCollinearLines(decomposePolylines(newPrims)));
  const mergedAddedLines = mergedDiff.added.filter(isLine);
  const mergedRemovedLines = mergedDiff.removed.filter(isLine);
  const mergedChangedLines = mergedDiff.changed.filter(c => isLine(c.before));

  const splitMerged = {
    beforeAdded: naive.added.filter(isMergeManaged).length,
    beforeRemoved: naive.removed.filter(isMergeManaged).length,
    afterAdded: mergedAddedLines.length,
    afterRemoved: mergedRemovedLines.length,
  };
  const added = [...naive.added.filter(p => !isMergeManaged(p)), ...mergedAddedLines];
  const removed = [...naive.removed.filter(p => !isMergeManaged(p)), ...mergedRemovedLines];
  const changed = [...naive.changed.filter(c => !isMergeManaged(c.before)), ...mergedChangedLines];
  return { added, removed, changed, splitMerged };
}
