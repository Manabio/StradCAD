/**
 * 直交矩形の**合併境界**を求める純モジュール。平面の壁の取り合い（`.claude/plan-wall-region.md`）の
 * 中核で、「線をトリムする」代わりに「材の領域を合成してその境界を描く」ための唯一の道具。
 *
 * ## なぜこれで足りるか
 * 壁は例外なく軸平行（`Wall.isVertical`。斜め壁は存在しない）で、平面切断面の材は軸平行な矩形の
 * 集まりになる。よって案1（DCEL＋放射ソート）が解く「方位角で隣り合う辺だけを交差させる」問題は
 * 生じず、矩形集合の合併境界を出せば角の取り合いはすべてその帰結として決まる。
 *
 * ## 座標の扱い
 * 入力は mm（小数あり）。内部では **1/1000mm の整数**へ量子化して厳密比較する（許容差による
 * 「触れているか」の判定を持ち込まない——判定の揺れが旧方式の不良の一因だった）。呼び出し側は
 * 矩形を作る時点で面へスナップ済みの値を渡すこと（壁生成側のトリムがそれを保証している）。
 *
 * ## 用語
 * - **辺（edge）**: 矩形の4辺のいずれか。`side` は外向き法線の向き（'xLo'|'xHi'|'yLo'|'yHi'）。
 * - **合併境界**: 領域の内部と外部を分ける辺。ある辺のうち「外向き側が他の矩形に覆われていない」
 *   部分だけが境界に残る。共線で接する辺は1本へ畳む（＝分割された線分が原理的に出ない）。
 *
 * 純モジュール（node:test から単体 import 可能。store.js・*.jsx を静的に引かない）。
 */

/** 量子化の単位（1mm = QUANT 整数）。1/1000mm。 */
export const QUANT = 1000;

/** mm → 整数（1/1000mm 単位）。 */
export function q(mm) { return Math.round(mm * QUANT); }
/** 整数（1/1000mm 単位） → mm。 */
export function unq(v) { return v / QUANT; }

/**
 * @typedef {{xLo:number, xHi:number, yLo:number, yHi:number, id:*, tag?:*, hide?:string[]}} OrthoRect
 *   座標は**量子化済みの整数**（`q()` を通した値）。id/tag は境界の辺へそのまま持ち出される。
 *   `hide` に載せた side は境界として**出さない**（覆い判定には従来どおり参加する）——材の面では
 *   なく内部の継ぎ目である辺（対称壁の軸CL側など）を持ち出さないため。
 */

/**
 * mm の矩形を量子化した OrthoRect にする。lo>hi の入力は入れ替える（呼び出し側の向きに依存しない）。
 * 面積が0（潰れた矩形）は null を返す——領域に寄与しないうえ、境界計算で辺が二重に出る原因になる。
 * @returns {OrthoRect|null}
 */
export function rectFromMm(xLo, xHi, yLo, yHi, id, tag) {
  const x0 = q(Math.min(xLo, xHi)), x1 = q(Math.max(xLo, xHi));
  const y0 = q(Math.min(yLo, yHi)), y1 = q(Math.max(yLo, yHi));
  if (x1 <= x0 || y1 <= y0) return null;
  return { xLo: x0, xHi: x1, yLo: y0, yHi: y1, id, tag };
}

// 区間の集合を正規化（昇順・接するもの／重なるものを畳む）。
function normalize(intervals) {
  if (intervals.length <= 1) return intervals;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1], cur = sorted[i];
    if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else out.push(cur.slice());
  }
  return out;
}

// [lo,hi] から正規化済みの cuts を差し引く。
function subtract(lo, hi, cuts) {
  const out = [];
  let cursor = lo;
  for (const [c0, c1] of cuts) {
    if (c1 <= cursor) continue;
    if (c0 >= hi) break;
    if (c0 > cursor) out.push([cursor, c0]);
    cursor = Math.max(cursor, c1);
    if (cursor >= hi) break;
  }
  if (cursor < hi) out.push([cursor, hi]);
  return out;
}

// 辺の外向き法線が指す側の「すぐ外」に矩形 r があるか（面が接している＝覆っている）。
// 矩形は閉区間として扱い、`at` がその矩形の内部または境界の**外側寄りでない**側にあることを見る。
function coversOutside(side, at, r) {
  switch (side) {
    case 'xLo': return r.xLo < at && r.xHi >= at;   // -x 側から at へ達している
    case 'xHi': return r.xHi > at && r.xLo <= at;   // +x 側から at へ達している
    case 'yLo': return r.yLo < at && r.yHi >= at;
    default:    return r.yHi > at && r.yLo <= at;   // 'yHi'
  }
}

// 辺の走る向き（縦辺なら y、横辺なら x）での矩形の範囲。
function alongRange(side, r) {
  return (side === 'xLo' || side === 'xHi') ? [r.yLo, r.yHi] : [r.xLo, r.xHi];
}

const SIDES = ['xLo', 'xHi', 'yLo', 'yHi'];

/**
 * @typedef {{vertical:boolean, at:number, lo:number, hi:number, side:string,
 *            id:*, tag:*, ids:*[]}} BoundaryEdge
 *   座標は量子化済み整数。`vertical` は**線そのものの向き**（縦線なら true、at=x・lo/hi=y）。
 *   `id`/`tag`/`side` は代表元（最も長く寄与した矩形）のもの。`ids` は同じ1本へ畳まれた矩形の id。
 */

/**
 * 矩形集合の合併境界を返す。
 *
 * 各矩形の4辺について「外向き側を他の矩形が覆っていない部分」を残し、同一直線・同一 side で
 * 共線に接する／重なる断片を1本へ畳む。畳むときに `ids` へ出所を集める——呼び出し側は
 * 「この1本は誰が描くか」を代表元で決められる。
 *
 * 同じ id の矩形が複数あっても互いに覆い合う（層の中では出所を区別しない）。
 *
 * `covers` は**覆い判定にだけ参加し、境界を出さない**矩形——高さクラスが違う領域（全高の壁の材）を
 * 低いクラス（腰壁の天板）から差し引くのに使う: 低いクラスの辺のうち高いクラスの材の中／面上にある
 * 部分は、その高いクラスの線がそこに在るので出さない。
 *
 * @param {OrthoRect[]} rects 量子化済み
 * @param {OrthoRect[]} [covers] 量子化済み。境界を出さず、覆い判定にだけ参加する
 * @returns {BoundaryEdge[]}
 */
export function unionBoundary(rects, covers = []) {
  const raw = [];
  const all = covers.length ? [...rects, ...covers] : rects;
  for (const r of rects) {
    for (const side of SIDES) {
      if (r.hide?.includes(side)) continue; // 材の面ではない継ぎ目（覆い判定には使う）
      const vertical = side === 'xLo' || side === 'xHi';
      const at = r[side];
      const [lo, hi] = alongRange(side, r);
      const cuts = [];
      for (const o of all) {
        if (o === r) continue;
        if (!coversOutside(side, at, o)) continue;
        const [oLo, oHi] = alongRange(side, o);
        if (oHi <= lo || oLo >= hi) continue;
        cuts.push([Math.max(oLo, lo), Math.min(oHi, hi)]);
      }
      for (const [a, b] of subtract(lo, hi, normalize(cuts))) {
        raw.push({ vertical, at, lo: a, hi: b, side, id: r.id, tag: r.tag });
      }
    }
  }
  return mergeCollinear(raw);
}

/**
 * 同一直線（向き・位置・side が同じ）で接する／重なる辺を1本へ畳む。
 * 代表元は**最も長く寄与した**辺（同点なら先に現れたもの）。
 * @param {Array<{vertical:boolean, at:number, lo:number, hi:number, side:string, id:*, tag:*}>} edges
 * @returns {BoundaryEdge[]}
 */
export function mergeCollinear(edges) {
  const buckets = new Map();
  for (const e of edges) {
    // 線種（`tag.styleKey`）が違う辺は畳まない——色・線幅・破線が違う線を1本にすると見た目が変わる。
    const k = `${e.vertical ? 'V' : 'H'}|${e.at}|${e.side}|${e.tag?.styleKey ?? ''}`;
    const b = buckets.get(k);
    if (b) b.push(e); else buckets.set(k, [e]);
  }
  const out = [];
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    let run = null;
    const flush = () => {
      if (!run) return;
      let best = run.parts[0];
      for (const p of run.parts) if (p.hi - p.lo > best.hi - best.lo) best = p;
      out.push({ vertical: best.vertical, at: best.at, lo: run.lo, hi: run.hi, side: best.side,
        id: best.id, tag: best.tag, ids: [...new Set(run.parts.map(p => p.id))] });
      run = null;
    };
    for (const e of bucket) {
      if (run && e.lo <= run.hi) { run.hi = Math.max(run.hi, e.hi); run.parts.push(e); continue; }
      flush();
      run = { lo: e.lo, hi: e.hi, parts: [e] };
    }
    flush();
  }
  return out;
}

// 正規化済みの2つの区間集合の共通部分。
function intersect(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}

/**
 * 辺を矩形集合の**内部**（境界上は含まない）だけに切り詰める。
 * 内側線（`backing` の境界のうち `material` の内部にある部分）を得るのに使う。
 *
 * 「厚み方向で at を挟んでいるか」を**両側の被覆の共通部分**として求める——1つの矩形が
 * at を厳密内包することは要求しない。壁が厚み方向に2枚の矩形（背中合わせのオーナー壁と
 * 仕上げ薄壁など）へ分かれていて、その境目にちょうど内側線が乗る配置では、どちらの矩形も
 * at を厳密内包しないが領域としては内部であり、そこで内側線を落とすと線が途切れる。
 * @param {BoundaryEdge} edge
 * @param {OrthoRect[]} rects
 * @returns {Array<[number,number]>} 走る向きの区間（量子化済み）
 */
export function clipEdgeToInterior(edge, rects) {
  const below = [], above = []; // at より低い側から達している／高い側から達している
  for (const r of rects) {
    const [tLo, tHi] = edge.vertical ? [r.xLo, r.xHi] : [r.yLo, r.yHi];
    if (edge.at < tLo || edge.at > tHi) continue;
    const [aLo, aHi] = edge.vertical ? [r.yLo, r.yHi] : [r.xLo, r.xHi];
    const lo = Math.max(edge.lo, aLo), hi = Math.min(edge.hi, aHi);
    if (hi <= lo) continue;
    if (edge.at > tLo) below.push([lo, hi]);
    if (edge.at < tHi) above.push([lo, hi]);
  }
  return intersect(normalize(below), normalize(above));
}
