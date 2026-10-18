/**
 * 階段吹抜けの×（見上げ）を、自階の天井面（階段下の部屋など）を除いた矩形ごとに分けて描くための純モジュール。
 * 上階の階段吹抜けのセル矩形から自階の天井面のセル矩形を引き、残りの片を矩形の群に組んで、壁の面（faceRect）に合わせる。
 * 規則（ユーザー裁定 2026-10-18）: 分割向きはセル群の形を優先。縦・横の両方に分断されるセル（L 字の根元など）は大きい群に吸収。
 * void・shaft には適用しない（規則 V で直下の天井は抜けるので分割の対象外）。
 * store.js / snap.js / *.jsx を import しない（node:test から単体 import 可）。
 */
import { subtractRects } from './planGeometry.js';
import { SPAN_OVERLAP_EPS } from '../finish/kneeDropWall.js';

const EPS = 0.5; // mm。辺の一致・接する判定

const isFiniteRect = r => !!r && [r.x1, r.y1, r.x2, r.y2].every(Number.isFinite);
const norm = r => ({ x1: Math.min(r.x1, r.x2), y1: Math.min(r.y1, r.y2), x2: Math.max(r.x1, r.x2), y2: Math.max(r.y1, r.y2) });
const areaOf = r => (r.x2 - r.x1) * (r.y2 - r.y1);
const near = (a, b) => Math.abs(a - b) <= EPS;
const byRow = (a, b) => a.y1 - b.y1 || a.x1 - b.x1;

// 横（'h'）＝y 範囲が同じで x が接する／縦（'v'）＝x 範囲が同じで y が接する
const touches = (a, b, dir) => (dir === 'h'
  ? near(a.y1, b.y1) && near(a.y2, b.y2) && (near(a.x2, b.x1) || near(b.x2, a.x1))
  : near(a.x1, b.x1) && near(a.x2, b.x2) && (near(a.y2, b.y1) || near(b.y2, a.y1)));

/** pieces（インデックス配列 idxs）を接する連結成分に分ける。 */
function chainsOf(pieces, idxs, dir) {
  const seen = new Set();
  const out = [];
  for (const s of idxs) {
    if (seen.has(s)) continue;
    const comp = [];
    const stack = [s];
    seen.add(s);
    while (stack.length) {
      const i = stack.pop();
      comp.push(i);
      for (const j of idxs) {
        if (!seen.has(j) && touches(pieces[i], pieces[j], dir)) { seen.add(j); stack.push(j); }
      }
    }
    out.push(comp);
  }
  return out;
}

const unionOf = (pieces, idxs) => {
  const rs = idxs.map(i => pieces[i]);
  return {
    x1: Math.min(...rs.map(r => r.x1)), y1: Math.min(...rs.map(r => r.y1)),
    x2: Math.max(...rs.map(r => r.x2)), y2: Math.max(...rs.map(r => r.y2)),
  };
};

/**
 * ×を描く矩形を求める。
 * @param {{
 *   cellRects: Array<object>  上階の階段吹抜けグループのセル矩形（CL 値）
 *   coverRects: Array<object>  自階の天井面のセル矩形（壁で削る前）
 *   cellRect: object  グループの矩形（CL 値）
 *   innerRect: object  グループの faceRect
 * }} args
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number}>} y→x 昇順。innerRect が不正なら []。
 *   覆いが無い（セルが 1 片も削られない）・セル矩形が無いときは [innerRect]。全部覆われれば []。
 */
export function splitCrossRects({ cellRects, coverRects, cellRect, innerRect } = {}) {
  if (!isFiniteRect(innerRect)) return [];
  const inner = norm(innerRect);
  const cells = (cellRects ?? []).filter(isFiniteRect).map(norm).filter(r => areaOf(r) > 0);
  if (cells.length === 0) return [inner];
  const covers = (coverRects ?? []).filter(isFiniteRect).map(norm);
  const pieces = subtractRects(cells, covers).map(norm).filter(r => areaOf(r) > EPS * EPS).sort(byRow);
  const cellArea = cells.reduce((s, r) => s + areaOf(r), 0);
  const pieceArea = pieces.reduce((s, r) => s + areaOf(r), 0);
  if (Math.abs(cellArea - pieceArea) <= EPS * 10) return [inner]; // 覆いなし＝従来どおり 1 枚
  if (pieces.length === 0) return [];

  const all = pieces.map((_, i) => i);
  const groupsOf = dir => chainsOf(pieces, all, dir).filter(c => c.length >= 2)
    .map(members => ({ dir, members, area: members.reduce((s, i) => s + areaOf(pieces[i]), 0) }));
  const hGroups = groupsOf('h');
  const vGroups = groupsOf('v');
  const hOf = new Map(), vOf = new Map();
  for (const g of hGroups) for (const i of g.members) hOf.set(i, g);
  for (const g of vGroups) for (const i of g.members) vOf.set(i, g);

  // 各片の所属: 両方の群に入る片は面積の大きい群（同面積は横）。
  const assign = new Map(); // i → 'h' | 'v' | null
  for (const i of all) {
    const h = hOf.get(i), v = vOf.get(i);
    assign.set(i, h && v ? (v.area > h.area ? 'v' : 'h') : h ? 'h' : v ? 'v' : null);
  }
  const rects = [];
  for (const dir of ['h', 'v']) {
    const idxs = all.filter(i => assign.get(i) === dir);
    for (const comp of chainsOf(pieces, idxs, dir)) {
      rects.push(unionOf(pieces, comp));
    }
  }
  for (const i of all) if (assign.get(i) === null) rects.push({ ...pieces[i] });

  // 併合パス: 和が矩形になる対（y 範囲が同じで x が接する／x 範囲が同じで y が接する）を、変化が無くなるまで併合する。
  // 群の割当てで別々の矩形になった隣り合う矩形（例: 3×2 の右列を覆った残り 2×2 の上下 2 行）を 1 枚に戻す。
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < rects.length && !merged; i++) {
      for (let j = i + 1; j < rects.length && !merged; j++) {
        if (!touches(rects[i], rects[j], 'h') && !touches(rects[i], rects[j], 'v')) continue;
        const a = rects[i], b = rects[j];
        rects.splice(j, 1);
        rects[i] = { x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) };
        merged = true;
      }
    }
  }

  // 壁の面に合わせる: 上階の外周（cellRect）に一致する辺だけ innerRect の辺へ。内側の辺（階段下部屋との境）は CL 値のまま。
  const cr = isFiniteRect(cellRect) ? norm(cellRect) : null;
  const fit = r => {
    if (!cr) return r;
    return {
      x1: near(r.x1, cr.x1) ? inner.x1 : r.x1, y1: near(r.y1, cr.y1) ? inner.y1 : r.y1,
      x2: near(r.x2, cr.x2) ? inner.x2 : r.x2, y2: near(r.y2, cr.y2) ? inner.y2 : r.y2,
    };
  };
  // 壁の中に残る細い×を出さない: 幅または高さが SPAN_OVERLAP_EPS 未満の矩形は捨てる（リード裁定）
  return rects.map(fit).filter(r => r.x2 - r.x1 >= SPAN_OVERLAP_EPS && r.y2 - r.y1 >= SPAN_OVERLAP_EPS).sort(byRow);
}
