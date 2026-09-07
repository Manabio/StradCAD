// 平面の壁描画セグメントから「不良の疑い」を機械的に数える。
//   through … 仕上げ線（face/fin）が他の壁の材を**完全に横切り、両側へ出ている**（＝真の通り抜け。目標0）
//   join    … 仕上げ線の端が他の壁の材の中で終わっている（＝角の合流。確定仕様「内側線どうしが取り合う」
//             では相手の内側線＝材の中の位置で止まるので、参考値として別に数える）
//   split   … 同じ直線上で端点が一致する同種の線分が2本に分かれている（＝1本で描くべき）
//   overlap … 同じ直線上で重なる線分がある（＝多重書き）
// 入力の segs は planSegments.mjs の出力（ゴールデンの plan-*.json をそのまま渡して数え直せる）。
import { ShapeType } from '../../src/core.js';

const EPS = 0.5;

export function analyzeDefects(graph, segs) {
  const walls = graph.generalShapes.filter(s => s.type === ShapeType.WALL).map(w => ({
    id: w.id, vertical: w.isVertical,
    mLo: w.materialRange.lo, mHi: w.materialRange.hi,
    sLo: Math.min(w.coord1, w.coord2), sHi: Math.max(w.coord1, w.coord2),
  }));
  const drawn = new Set(segs.map(s => s.wallId));

  // --- 貫通: face/fin 線（壁と同じ向きに走る）が、直交する壁の材の内部を横切る
  const through = [], join = [];
  for (const s of segs) {
    if (s.kind !== 'face' && s.kind !== 'fin') continue;
    for (const w of walls) {
      if (w.id === s.wallId) continue;
      if (w.vertical === s.vertical) continue;      // 平行な壁は横切らない
      if (!drawn.has(w.id)) continue;               // 描かれていない壁は無視
      // s は (at, lo..hi) に走る。w は長さ方向 sLo..sHi・厚み方向 mLo..mHi。
      // 直交するので、s.at が w の長さ方向範囲に、w の厚み方向範囲が s.lo..hi と交差するか。
      if (!(s.at > w.sLo + EPS && s.at < w.sHi - EPS)) continue;
      const ovLo = Math.max(s.lo, w.mLo + EPS), ovHi = Math.min(s.hi, w.mHi - EPS);
      if (!(ovHi - ovLo > EPS)) continue;
      const rec = { key: s.key, into: w.id, len: +(ovHi - ovLo).toFixed(1) };
      // 両端が相手の材の外＝完全に横切っている。片方でも材の中で終わるなら合流。
      if (s.lo < w.mLo - EPS && s.hi > w.mHi + EPS) through.push(rec); else join.push(rec);
    }
  }

  // --- 分割 / 多重書き: 同一直線（vertical, at）上でグルーピング
  const byLine = new Map();
  for (const s of segs) {
    if (s.kind === 'stud') continue;
    const k = `${s.vertical ? 'V' : 'H'}@${s.at}`;
    (byLine.get(k) ?? byLine.set(k, []).get(k)).push(s);
  }
  const split = [], overlap = [];
  for (const [line, list] of byLine) {
    list.sort((a, b) => a.lo - b.lo);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (b.lo > a.hi + EPS) break;
        // 分割は**同種**の線分どうしだけ（ヘッダの定義どおり）: 天板の端部の出幅ぶん（kdcap）が
        // 全高の壁の面線（face）に端で接するのは、別の描画要素が角で出会っているだけ。
        if (b.lo > a.hi - EPS) { if (a.kind === b.kind) split.push({ line, a: a.key, b: b.key, at: a.hi }); continue; }
        const ov = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
        if (ov > EPS) overlap.push({ line, a: a.key, b: b.key, len: +ov.toFixed(1) });
      }
    }
  }
  return { through, join, split, overlap };
}

/** 集計行（dumpPlan.mjs / recountDefects.mjs が共有）。 */
export function summarizeDefects(plane, segs, defects) {
  return { plane, segs: segs.length,
    through: defects.through.length, join: defects.join.length,
    split: defects.split.length, overlap: defects.overlap.length };
}
