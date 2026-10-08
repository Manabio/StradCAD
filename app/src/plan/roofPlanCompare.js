/**
 * 下屋の平面図形の新旧比較の道具（テスト・probe 専用。製品コードからは import しない）。
 * 旧＝finish/roof/roofPlanFigure.js roofPlanFigure（端止め trim 済み）、新＝plan/planSolidsLayerFilter.js の roof の線
 * （解決器が壁立体の遮蔽で外壁面どまりを導いた結果）が、**線として同じ**かを見る。
 * 折れ線→線分→同一直線上の重なりを結合→区間の突き合わせ（0.5mm の許容）で、一致（both）・旧のみ（old）・新のみ（new）の
 * 区間に分ける。S5（`.claude/plan-section.md`）の関門 probe（scripts/probe/dumpRoofPlanCompare.mjs）と
 * `roofPlanFigure.test.js` の比較テストが共有する。
 */

const TOL = 0.5;
const r1 = v => Math.round(v * 10) / 10;

/** 折れ線（points）→線分 [x1,y1,x2,y2][]。closed なら末尾→先頭の辺も足す。 */
export function toSegments(points, closed = false) {
  const out = [];
  for (let i = 0; i + 3 < points.length; i += 2) out.push([points[i], points[i + 1], points[i + 2], points[i + 3]]);
  if (closed && points.length >= 6) out.push([points[points.length - 2], points[points.length - 1], points[0], points[1]]);
  return out;
}

/** 線分を {angleKey, dx, dy, off, t0, t1, role} へ（向きを正準にする）。長さ 0 は null。 */
export function toRecord(seg, role = '?') {
  let [x1, y1, x2, y2] = seg;
  let dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  dx /= len; dy /= len;
  if (dx < -1e-9 || (Math.abs(dx) <= 1e-9 && dy < 0)) { dx = -dx; dy = -dy; [x1, y1, x2, y2] = [x2, y2, x1, y1]; }
  const t1 = x1 * dx + y1 * dy, t2 = x2 * dx + y2 * dy;
  return { angleKey: Math.round(Math.atan2(dy, dx) * 1e4), dx, dy, off: -dy * x1 + dx * y1, t0: Math.min(t1, t2), t1: Math.max(t1, t2), role };
}

function unionIntervals(ivs) {
  const s = [...ivs].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + TOL) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * 旧・新の線分の記録（toRecord）から区間の突き合わせをして、{cls:'both'|'old'|'new', roles, len, points} の配列を返す。
 * 0.5mm 未満の区間は捨てる。
 */
export function comparePieces(oldRecs, newRecs) {
  const groups = new Map(); // angleKey -> {dx, dy, items:[{set, rec}]}
  for (const [set, recs] of [['old', oldRecs], ['new', newRecs]]) {
    for (const rec of recs) {
      if (!groups.has(rec.angleKey)) groups.set(rec.angleKey, { dx: rec.dx, dy: rec.dy, items: [] });
      groups.get(rec.angleKey).items.push({ set, rec });
    }
  }
  const pieces = [];
  for (const g of groups.values()) {
    const offs = [...new Set(g.items.map(i => i.rec.off))].sort((a, b) => a - b);
    const rep = new Map();
    let base = null;
    for (const o of offs) { if (base === null || o - base > 0.75) base = o; rep.set(o, base); }
    const byOff = new Map();
    for (const it of g.items) {
      const k = rep.get(it.rec.off);
      if (!byOff.has(k)) byOff.set(k, []);
      byOff.get(k).push(it);
    }
    for (const [off, items] of byOff) {
      const oldU = unionIntervals(items.filter(i => i.set === 'old').map(i => [i.rec.t0, i.rec.t1]));
      const newU = unionIntervals(items.filter(i => i.set === 'new').map(i => [i.rec.t0, i.rec.t1]));
      const bps = [...new Set([...oldU, ...newU].flat())].sort((a, b) => a - b);
      const inU = (u, m) => u.some(([a, b]) => a < m && m < b);
      const local = [];
      let cur = null;
      const flush = () => { if (cur) { local.push(cur); cur = null; } };
      for (let i = 0; i + 1 < bps.length; i++) {
        const m = (bps[i] + bps[i + 1]) / 2;
        const o = inU(oldU, m), n = inU(newU, m);
        if (!o && !n) { flush(); continue; }
        const cls = o && n ? 'both' : o ? 'old' : 'new';
        if (cur && cur.cls === cls && Math.abs(cur.t1 - bps[i]) < 1e-6) cur.t1 = bps[i + 1];
        else { flush(); cur = { cls, t0: bps[i], t1: bps[i + 1], off, dx: g.dx, dy: g.dy }; }
      }
      flush();
      for (const p of local) {
        const cover = items.filter(i => i.rec.t0 <= p.t0 + TOL && i.rec.t1 >= p.t1 - TOL && (p.cls === 'both' || i.set === p.cls));
        p.roles = [...new Set(cover.map(i => i.rec.role))];
        pieces.push(p);
      }
    }
  }
  return pieces.map(p => ({
    cls: p.cls, roles: p.roles, len: r1(p.t1 - p.t0),
    points: [p.t0 * p.dx - p.off * p.dy, p.t0 * p.dy + p.off * p.dx, p.t1 * p.dx - p.off * p.dy, p.t1 * p.dy + p.off * p.dx].map(r1),
  })).filter(p => p.len >= TOL);
}

/** 旧の primitive（roofPlanFigure の線。role・closed を持つ）の線分の記録。 */
export const oldLineRecords = prims => prims.filter(p => p.kind === 'line')
  .flatMap(p => toSegments(p.points, p.closed).map(s => toRecord(s, p.role))).filter(Boolean);

/** 新の primitive（解決器の出力のうち source.kind==='roof'・自階の線）の線分の記録。 */
export const newLineRecords = prims => prims.filter(p => p.kind === 'line' && p.source?.kind === 'roof' && (p.source.layerFloorZ ?? 0) === 0)
  .map(p => toRecord(p.points, p.source.role ?? '?')).filter(Boolean);

/** ラベル（arrow・text）の比較用の文字列（座標・文字まで。key は含めない）。ソート済み。 */
export const labelKeys = prims => prims.filter(p => p.kind === 'arrow' || p.kind === 'text').map(p => (p.kind === 'arrow'
  ? `arrow|${p.points.map(r1).join(',')}|${p.head.map(r1).join(',')}`
  : `text|${r1(p.x)},${r1(p.y)}|${p.text}|${p.fontSizeMm}`)).sort();

/** 旧新の線の差分の区間（both 以外）。空なら線として同じ。 */
export const roofLineDiffs = (oldPrims, newPrims) =>
  comparePieces(oldLineRecords(oldPrims), newLineRecords(newPrims)).filter(p => p.cls !== 'both');
