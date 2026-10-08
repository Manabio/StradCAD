/**
 * 平面の断面解決器（純モジュール）。立体（planSolids の Solid）と切断高 cutZ から、平面に描く**線**を解く。
 * 平面を「立体＋水平切断」で描く移行計画の S3（`.claude/plan-section.md`）。描画（Konva）への接続は S4 以降。
 *
 * store.js / snap.js / appViewport.js / *.jsx / graphDerived を import しない（node:test から単体 import 可）。
 * 多角形の演算（クリップ・差・和）は持たない。遮蔽は「線分を遮蔽候補の輪郭との交点で区間に切り、各区間の中点が
 * 遮蔽物の厳密な内側にあるか」だけで決める。
 *
 * 分類（EPS=0.5mm。zHi/zLo は自階 FL=0 の絶対 mm、cutZ も同じ座標）:
 *   zHi <= cutZ+EPS            … below（見えがかり。輪郭を細線）
 *   zLo >= cutZ-EPS            … above（非表示。遮蔽物にも入れない）
 *   それ以外（zLo < cutZ < zHi）… cut（切断。輪郭を太線）
 *   腰壁の天端がちょうど cutZ・厚み0で zHi==cutZ は below。勾配のある立体（zAt）が切断面をまたぐときは
 *   zAt < cutZ の部分の輪郭だけを細線にし、切断面との交線（等高線）は出さない（受容する限界）。
 *
 * 遮蔽（線分 S の区間の中点 p が遮蔽物 O の footprint の**厳密な内側**。境界の上は隠さない）:
 *   (i)  top(O,p) > top(S,p)+EPS
 *   (ii) O が面材（SURFACE_KINDS＝floor・roof）で top(O,p) >= top(S,p)-EPS（面材は同じ高さでも勝つ。梁の天端が
 *        床面・屋根面と同点＝その下。S5 で屋根を加えた）
 *   (iii) O も S も cut（同じ高さで隠し合い、和の輪郭だけが残る）
 *   top は cut の立体なら cutZ、below なら zHi（zAt があれば zAt(p)）。S 自身・above は遮蔽物にしない。
 *   (iii) の補足: cut 同士で S の線が O の境界の上にあるときは、面を接する（S と O の内側が線の反対側）なら共有面なので隠し、
 *   同じ側に重なる外周なら index の小さい方だけが描く（重複線を出さない）。
 *   勾配のある立体が絡む区間は slopeSampleMm ごとに可視を調べ、変わる所を 0.5mm まで二分探索して切る。
 *
 * 層: 自階（source.layerFloorZ === 0。省略も自階）はどこでも見える。下階（layerFloorZ < 0）の線は**自階の床の穴の和の
 * 中だけ**（窓）に限る。自階に floor が無ければ下階は一切出さない。上階（layerFloorZ > 0）は cutZ が階高より低い限り
 * 全部 above なので 0 件。
 *
 * 順序は入力に依らず決定的: cls（cut→below）→ source.kind 固定表 → layerFloorZ 降順 → source.id → 線の (minX, minY)。
 *
 * @typedef {import('./planSolids.js').Solid} Solid
 * @typedef {{
 *   kind: 'line', key: string, points: [number, number, number, number],
 *   weight: 'thick'|'thin', dash?: number[], cls: 'cut'|'below', detailOnly: false,
 *   source: {kind: string, id: string, layerFloorZ?: number, role?: string, part?: number},
 * }} LinePrimitive
 *   weight は viewport.lineWeightsPx のキー名。dash は汎用立体の style.dash だけが付ける。
 *   kind:'polygon'（ポシェ）は予約だけで生成しない。
 * @typedef {{
 *   kind: 'arrow'|'text', key: string, weight: 'thin', cls: 'below', detailOnly: true, source: object,
 * }} MarkPrimitive
 *   立体の marks（傾斜ラベル）の出力。arrow は points・head、text は x・y・text・fontSizeMm を持つ（立体の mark の prims のまま）。
 *   anchor が線の点と同じ可視判定で見えるときだけ出る。LOD の絞りは呼び出し側（planSolidsLayerFilter.visiblePlanPrimitives）。
 * @typedef {LinePrimitive|MarkPrimitive} Primitive
 */
import { SOLID_KIND_ORDER } from './planSolids.js';
import {
  normalizeRect, isValidRect, isInsideFootprint, rectsOutlineSegments, footprintBounds,
} from './planGeometry.js';

/** 線種の対応（唯一の場所）。weight は viewport.lineWeightsPx のキー名。 */
export const PLAN_LINE_STYLE = Object.freeze({
  cut: Object.freeze({ weight: 'thick' }),
  below: Object.freeze({ weight: 'thin' }),
});

const DEFAULT_EPS_MM = 0.5;
const DEFAULT_SLOPE_SAMPLE_MM = 100;
const BISECT_MM = 0.5; // 勾配の切り替わり点の二分探索の収束幅
const GEO_TOL = 1e-6;
const NUDGE = 1e-3; // 共有辺の上の点が和の内部かを見る斜め押し
const SIDE_PROBE = 0.01; // 線の両側のどちらが内側かを見る距離
const CLS_RANK = { cut: 0, below: 1 };
/** 面材（同じ高さでも下の線に勝つ立体の種別。規則 (ii)）。床と屋根（梁の天端＝FL は床・屋根の下）。 */
const SURFACE_KINDS = Object.freeze(['floor', 'roof']);
const DIAGONALS = [[1, 1], [-1, 1], [1, -1], [-1, -1]];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- footprint の準備

/**
 * 同じ直線上の線分を**対称差**（被覆が奇数の区間）で1本ずつに結ぶ。外形の辺と穴の縁が同じ区間に重なる
 * （穴が外形に接する）と、そこは床の無い所なので線を出さない。接する区間は1本に結ぶ。
 * （`renderer/orthoRegion.js` にも同名の関数があるが、引数の形も目的も別物。）
 */
function mergeCollinear(segs) {
  const groups = new Map();
  for (const s of segs) {
    const key = `${s.isVertical ? 'v' : 'h'}:${s.value}`;
    if (!groups.has(key)) groups.set(key, { isVertical: s.isVertical, value: s.value, ivs: [] });
    groups.get(key).ivs.push([Math.min(s.lo, s.hi), Math.max(s.lo, s.hi)]);
  }
  const out = [];
  for (const g of groups.values()) {
    const pts = [...new Set(g.ivs.flat())].sort((a, b) => a - b);
    let cur = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const mid = (pts[i] + pts[i + 1]) / 2;
      const odd = g.ivs.reduce((n, [lo, hi]) => n + (lo < mid && mid < hi ? 1 : 0), 0) % 2 === 1;
      if (!odd) continue;
      if (cur && pts[i] <= cur[1] + GEO_TOL) cur[1] = pts[i + 1];
      else { if (cur) out.push(toEdge(g, cur)); cur = [pts[i], pts[i + 1]]; }
    }
    if (cur) out.push(toEdge(g, cur));
  }
  return out;
}

const toEdge = (g, [lo, hi]) => (g.isVertical ? [g.value, lo, g.value, hi] : [lo, g.value, hi, g.value]);

/** footprint を検証して正規化し、輪郭の辺 [x1,y1,x2,y2][] を作る。不正・面積0は null。 */
function prepareFootprint(fp) {
  if (!fp) return null;
  if (Array.isArray(fp.poly)) {
    const p = fp.poly;
    if (p.length < 6 || p.length % 2 !== 0 || !p.every(Number.isFinite)) return null;
    let area2 = 0;
    const edges = [];
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area2 += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
      if (Math.hypot(p[2 * j] - p[2 * i], p[2 * j + 1] - p[2 * i + 1]) > GEO_TOL) edges.push([p[2 * i], p[2 * i + 1], p[2 * j], p[2 * j + 1]]);
    }
    if (Math.abs(area2) < GEO_TOL || edges.length < 3) return null;
    return { footprint: { poly: [...p] }, edges };
  }
  if (!Array.isArray(fp.rects)) return null;
  const rects = fp.rects.filter(r => r && [r.x1, r.y1, r.x2, r.y2].every(Number.isFinite)).map(normalizeRect).filter(isValidRect);
  if (rects.length === 0) return null;
  const holes = (fp.holes ?? []).filter(r => r && [r.x1, r.y1, r.x2, r.y2].every(Number.isFinite)).map(normalizeRect).filter(isValidRect);
  const segs = [...rectsOutlineSegments(rects), ...rectsOutlineSegments(holes)];
  const edges = mergeCollinear(segs);
  return { footprint: holes.length > 0 ? { rects, holes } : { rects }, edges };
}

/**
 * 点が footprint の厳密な内部か。辺の上は外。矩形群の共有辺の上・複数の立体の継ぎ目の上は、ここでは外とし、
 * 呼び出し側の「和の内部」判定（resolveLine の hiddenByUnion。斜め4点）が扱う。
 */
function insideInterior(fp, x, y) {
  if (!isInsideFootprint(fp, x, y)) return false;
  // isInsideFootprint は穴の「内側」だけを除くので、穴の縁の上の点は内側と数えてしまう。縁の上は外とする
  return !(fp.holes ?? []).some(h => x >= h.x1 && x <= h.x2 && y >= h.y1 && y <= h.y2);
}

function insideRec(rec, x, y) {
  const b = rec.bounds;
  if (x < b.x1 || x > b.x2 || y < b.y1 || y > b.y2) return false;
  return insideInterior(rec.footprint, x, y);
}

function onSegment(e, x, y) {
  const [ax, ay, bx, by] = e;
  const len = Math.hypot(bx - ax, by - ay);
  if (Math.abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) > GEO_TOL * Math.max(1, len)) return false;
  return x >= Math.min(ax, bx) - GEO_TOL && x <= Math.max(ax, bx) + GEO_TOL
    && y >= Math.min(ay, by) - GEO_TOL && y <= Math.max(ay, by) + GEO_TOL;
}

// ---------------------------------------------------------------- 立体の準備

const finiteList = (a, min, even) => Array.isArray(a) && a.length >= min && (!even || a.length % 2 === 0) && a.every(Number.isFinite);

/** marks の検証。anchor が有限・prims に有効な arrow/text が1つ以上ある mark だけ残す（不正は黙って捨てる）。 */
function validMarks(marks) {
  const out = [];
  for (const m of Array.isArray(marks) ? marks : []) {
    const a = m?.anchor;
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Array.isArray(m.prims)) continue;
    const prims = m.prims.filter(p => {
      if (!p || typeof p.key !== 'string') return false;
      if (p.kind === 'arrow') return finiteList(p.points, 4, true) && finiteList(p.head, 2, true);
      if (p.kind === 'text') return Number.isFinite(p.x) && Number.isFinite(p.y) && typeof p.text === 'string' && Number.isFinite(p.fontSizeMm) && p.fontSizeMm > 0;
      return false;
    });
    if (prims.length > 0) out.push({ anchor: { x: a.x, y: a.y }, prims });
  }
  return out;
}

/**
 * Solid を解決用の記録へ。検証に通らない・above は null。
 * 記録: {solid, cls, kind, footprint, edges, bounds, lines, marks, zAt, slopedCut, layerZ, windowed, rank}
 */
function prepareSolid(s, cutZ, eps) {
  if (!s || !Number.isFinite(s.zLo) || !Number.isFinite(s.zHi) || s.zLo > s.zHi) return null;
  let cls;
  if (s.zHi <= cutZ + eps) cls = 'below';
  else if (s.zLo >= cutZ - eps) return null;
  else cls = 'cut';
  const prepared = prepareFootprint(s.footprint);
  if (!prepared) return null;
  // drawEdges:false の立体（下屋）は輪郭を描かない（遮蔽用の edges は保持する）
  const lines = s.drawEdges === false ? [] : prepared.edges.map(points => ({ points, role: null }));
  for (const inner of s.innerLines ?? []) {
    const p = inner?.points;
    if (!Array.isArray(p) || p.length < 4 || p.length % 2 !== 0 || !p.every(Number.isFinite)) continue;
    for (let i = 0; i + 3 < p.length; i += 2) lines.push({ points: [p[i], p[i + 1], p[i + 2], p[i + 3]], role: inner.role ?? null });
  }
  const zAt = typeof s.zAt === 'function' ? s.zAt : null;
  const layerZ = Number.isFinite(s.source?.layerFloorZ) ? s.source.layerFloorZ : 0;
  return {
    solid: s, cls, kind: s.kind, footprint: prepared.footprint, edges: prepared.edges,
    bounds: footprintBounds(prepared.footprint), lines, marks: validMarks(s.marks), zAt,
    slopedCut: cls === 'cut' && zAt !== null, layerZ, windowed: layerZ < 0, rank: 0,
  };
}

const srcKindOf = rec => rec.solid.source?.kind ?? rec.kind;
const kindRankOf = rec => {
  const i = SOLID_KIND_ORDER.indexOf(srcKindOf(rec));
  return i >= 0 ? i : SOLID_KIND_ORDER.length;
};

function compareRecs(a, b) {
  return b.layerZ - a.layerZ || kindRankOf(a) - kindRankOf(b)
    || cmp(String(a.solid.source?.id ?? ''), String(b.solid.source?.id ?? ''))
    || (a.solid.source?.part ?? 0) - (b.solid.source?.part ?? 0)
    || a.solid.zLo - b.solid.zLo || a.solid.zHi - b.solid.zHi
    || a.bounds.x1 - b.bounds.x1 || a.bounds.y1 - b.bounds.y1 || a.bounds.x2 - b.bounds.x2 || a.bounds.y2 - b.bounds.y2;
}

/** 点 (x,y) での実効の上端。cut＝cutZ、below＝zHi（zAt があれば zAt）。勾配のある cut は min(cutZ, zAt)。 */
function topAt(rec, cutZ, x, y) {
  if (rec.cls === 'cut') return rec.zAt ? Math.min(cutZ, rec.zAt(x, y)) : cutZ;
  return rec.zAt ? Math.min(rec.solid.zHi, rec.zAt(x, y)) : rec.solid.zHi;
}

/** 点での実効の分類。勾配のある cut は zAt < cutZ の所だけ below。 */
function clsAt(rec, cutZ, x, y) {
  if (rec.slopedCut) return rec.zAt(x, y) < cutZ ? 'below' : 'cut';
  return rec.cls;
}

// ---------------------------------------------------------------- 線分の分割

const bboxOverlap = (b, minX, minY, maxX, maxY) =>
  !(b.x2 < minX - GEO_TOL || b.x1 > maxX + GEO_TOL || b.y2 < minY - GEO_TOL || b.y1 > maxY + GEO_TOL);

/** 線分 a→a+r と辺の交点（共線なら辺の端点の射影）の媒介変数 t∈(0,1) を ts へ追加する。 */
function pushCutParams(ts, ax, ay, rx, ry, len2, e) {
  const sx = e[2] - e[0], sy = e[3] - e[1];
  const qx = e[0] - ax, qy = e[1] - ay;
  const denom = rx * sy - ry * sx;
  const scale = Math.sqrt(len2) * Math.hypot(sx, sy);
  if (Math.abs(denom) > 1e-9 * scale) {
    const t = (qx * sy - qy * sx) / denom;
    const u = (qx * ry - qy * rx) / denom;
    if (u >= -1e-9 && u <= 1 + 1e-9 && t > 0 && t < 1) ts.push(t);
    return;
  }
  if (Math.abs(qx * ry - qy * rx) > GEO_TOL * Math.sqrt(len2)) return;
  for (const [px, py] of [[e[0], e[1]], [e[2], e[3]]]) {
    const t = ((px - ax) * rx + (py - ay) * ry) / len2;
    if (t > 0 && t < 1) ts.push(t);
  }
}

const round6 = v => Math.round(v * 1e6) / 1e6;

// ---------------------------------------------------------------- 入口

/**
 * 立体と切断高から平面の線を解く。
 * @param {Solid[]} solids  planSolids の出力（汎用立体を含む）。順序に依らない
 * @param {number} cutZ  切断面の高さ（自階 FL=0 の絶対 mm）。有限でなければ TypeError
 * @param {{eps?: number, slopeSampleMm?: number}} [opts]  eps＝分類・高さ比較の許容（既定 0.5）／slopeSampleMm＝勾配の可視を調べる間隔（既定 100）
 * @returns {Primitive[]}
 */
export function planSectionFigure(solids, cutZ, opts = {}) {
  if (!Number.isFinite(cutZ)) throw new TypeError(`planSectionFigure: cutZ は有限の数値が必要です（${String(cutZ)}）`);
  const eps = Number.isFinite(opts.eps) && opts.eps > 0 ? opts.eps : DEFAULT_EPS_MM;
  const sampleMm = Number.isFinite(opts.slopeSampleMm) && opts.slopeSampleMm > 0 ? opts.slopeSampleMm : DEFAULT_SLOPE_SAMPLE_MM;
  if (!Array.isArray(solids)) return [];

  const recs = solids.map(s => prepareSolid(s, cutZ, eps)).filter(Boolean).sort(compareRecs);
  recs.forEach((r, i) => { r.rank = i; });
  if (recs.length === 0) return [];

  // 下階の窓: 自階の床の穴の和（床が無ければ空＝下階は出ない）
  const windowRects = recs.filter(r => r.kind === 'floor' && r.layerZ === 0)
    .flatMap(r => r.footprint.holes ?? []);
  const inWindow = (x, y) => windowRects.some(h => x >= h.x1 - GEO_TOL && x <= h.x2 + GEO_TOL && y >= h.y1 - GEO_TOL && y <= h.y2 + GEO_TOL);

  const out = [];
  for (const S of recs) {
    for (const line of S.lines) {
      const pieces = resolveLine(S, line.points, recs, { cutZ, eps, sampleMm, windowRects, inWindow });
      for (const [x1, y1, x2, y2] of pieces) {
        const cls = S.slopedCut ? 'below' : S.cls;
        const prim = {
          kind: 'line', key: '', points: [x1, y1, x2, y2], weight: PLAN_LINE_STYLE[cls].weight, cls, detailOnly: false,
          source: { ...S.solid.source, ...(line.role ? { role: line.role } : {}) },
        };
        const dash = S.kind === 'generic' ? S.solid.style?.dash : null;
        if (Array.isArray(dash) && dash.length > 0) prim.dash = [...dash];
        out.push({ prim, rec: S });
      }
    }
  }

  out.sort((a, b) => {
    const pa = a.prim.points, pb = b.prim.points;
    return CLS_RANK[a.prim.cls] - CLS_RANK[b.prim.cls] || kindRankOf(a.rec) - kindRankOf(b.rec)
      || b.rec.layerZ - a.rec.layerZ || cmp(String(a.prim.source.id), String(b.prim.source.id))
      || Math.min(pa[0], pa[2]) - Math.min(pb[0], pb[2]) || Math.min(pa[1], pa[3]) - Math.min(pb[1], pb[3])
      || Math.max(pa[0], pa[2]) - Math.max(pb[0], pb[2]) || Math.max(pa[1], pa[3]) - Math.max(pb[1], pb[3])
      || (a.prim.source.part ?? 0) - (b.prim.source.part ?? 0) || a.rec.rank - b.rec.rank
      || pa[0] - pb[0] || pa[1] - pb[1];
  });
  const counters = new Map();
  const lines = out.map(({ prim }) => {
    const base = `${prim.cls}:${prim.source.kind}:${prim.source.id}`;
    const n = counters.get(base) ?? 0;
    counters.set(base, n + 1);
    prim.key = `${base}:${n}`;
    return prim;
  });
  return [...lines, ...resolveMarks(recs, { cutZ, eps, windowRects, inWindow })];
}

/**
 * 立体の marks（傾斜ラベルなどの注記）を解く。基準点（anchor）が線の点と同じ可視判定（buildVisibleAt）で見えるときだけ、
 * その mark の prims を出す（新しい規則は持たない）。出力は細線・below・詳細だけ（detailOnly:true）。順序は立体の順→mark の順。
 */
function resolveMarks(recs, ctx) {
  const out = [];
  for (const S of recs) {
    if (S.marks.length === 0 || (S.windowed && ctx.windowRects.length === 0)) continue;
    for (const { anchor, prims } of S.marks) {
      const cands = recs.filter(O => O !== S && bboxOverlap(O.bounds, anchor.x, anchor.y, anchor.x, anchor.y));
      if (!buildVisibleAt(S, cands, ctx, 0, 0)(anchor.x, anchor.y)) continue;
      for (const p of prims) {
        out.push({
          ...p, key: `below:${S.solid.source.kind}:${S.solid.source.id}:${p.key}`,
          weight: PLAN_LINE_STYLE.below.weight, cls: 'below', detailOnly: true, source: { ...S.solid.source },
        });
      }
    }
  }
  return out;
}

/**
 * 1本の候補線（S の輪郭の辺・内側の線）の可視区間 [x1,y1,x2,y2][]。
 * 遮蔽候補を線分の外接矩形で絞り（最適化。結果は絞らなくても同じ）、輪郭との交点で区間に切って判定する。
 */
function resolveLine(S, pts, recs, ctx) {
  const { eps, sampleMm, windowRects } = ctx;
  const [ax, ay, bx, by] = pts;
  const rx = bx - ax, ry = by - ay;
  const len2 = rx * rx + ry * ry;
  const len = Math.sqrt(len2);
  if (len < eps) return [];
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx), minY = Math.min(ay, by), maxY = Math.max(ay, by);
  if (S.windowed && windowRects.length === 0) return [];
  const nx = -ry / len, ny = rx / len;

  const cands = recs.filter(O => O !== S && bboxOverlap(O.bounds, minX, minY, maxX, maxY));
  const ts = [0, 1];
  for (const O of cands) for (const e of O.edges) pushCutParams(ts, ax, ay, rx, ry, len2, e);
  if (S.windowed) {
    for (const h of windowRects) {
      if (!bboxOverlap(h, minX, minY, maxX, maxY)) continue;
      for (const e of [[h.x1, h.y1, h.x2, h.y1], [h.x2, h.y1, h.x2, h.y2], [h.x2, h.y2, h.x1, h.y2], [h.x1, h.y2, h.x1, h.y1]]) {
        pushCutParams(ts, ax, ay, rx, ry, len2, e);
      }
    }
  }
  ts.sort((p, q) => p - q);
  const cuts = [ts[0]];
  for (const t of ts) if ((t - cuts[cuts.length - 1]) * len >= GEO_TOL) cuts.push(t);
  cuts[cuts.length - 1] = 1;

  const pointAt = t => [rx === 0 ? ax : ax + rx * t, ry === 0 ? ay : ay + ry * t];

  const visibleAt = buildVisibleAt(S, cands, ctx, nx, ny);

  const slopeRelevant = S.zAt !== null || cands.some(O => O.zAt !== null);
  const visible = []; // [t0,t1]
  for (let i = 0; i + 1 < cuts.length; i++) {
    const t0 = cuts[i], t1 = cuts[i + 1];
    if ((t1 - t0) * len < GEO_TOL) continue;
    if (!slopeRelevant) {
      const [mx, my] = pointAt((t0 + t1) / 2);
      if (visibleAt(mx, my)) visible.push([t0, t1]);
      continue;
    }
    // サンプル点は区間の両端の内側（端から BISECT_MM）から等間隔に置く。端ちょうどは遮蔽物の境界の上なので判定に使わない。
    const e = BISECT_MM / len;
    const a = t0 + e, b = t1 - e;
    const n = b > a ? Math.max(1, Math.ceil(((b - a) * len) / sampleMm)) : 0;
    const sampleT = j => (n === 0 ? (t0 + t1) / 2 : a + (j * (b - a)) / n);
    const vis = j => visibleAt(...pointAt(sampleT(j)));
    let start = t0;
    let cur = vis(0);
    for (let j = 0; j < n; j++) {
      const next = vis(j + 1);
      if (next === cur) continue;
      let lo = sampleT(j), hi = sampleT(j + 1);
      while ((hi - lo) * len > BISECT_MM) {
        const mid = (lo + hi) / 2;
        if (visibleAt(...pointAt(mid)) === cur) lo = mid; else hi = mid;
      }
      const c = (lo + hi) / 2;
      if (cur) visible.push([start, c]);
      start = c;
      cur = next;
    }
    if (cur) visible.push([start, t1]);
  }

  // 接する区間を結び、EPS 未満の断片を捨てる
  const merged = [];
  for (const iv of visible) {
    const last = merged[merged.length - 1];
    if (last && (iv[0] - last[1]) * len < GEO_TOL) last[1] = iv[1];
    else merged.push([iv[0], iv[1]]);
  }
  return merged.filter(([t0, t1]) => (t1 - t0) * len >= eps).map(([t0, t1]) => {
    const [x1, y1] = t0 === 0 ? [ax, ay] : pointAt(t0);
    const [x2, y2] = t1 === 1 ? [bx, by] : pointAt(t1);
    return [round6(x1), round6(y1), round6(x2), round6(y2)];
  });
}

/**
 * S の点 (x,y) が見えるか（遮蔽候補 cands に隠されないか）の判定関数。線の点（resolveLine）と傾斜ラベルの基準点
 * （marks の anchor）が**同じ可視判定**を使う。(nx,ny) は線の法線（共有面の判定用。点だけのときは 0,0＝共有面の特例なし）。
 */
function buildVisibleAt(S, cands, ctx, nx, ny) {
  const { cutZ, eps, inWindow } = ctx;
  // O が点 (x,y)（O の厳密な内部）で S を隠す z 規則: (i) 高い方が勝つ (ii) 面材（床・屋根）は同じ高さでも勝つ (iii) cut 同士は隠し合う
  const hides = (O, x, y, tS, cS) => {
    const tO = topAt(O, cutZ, x, y);
    if (tO > tS + eps) return true; // (i)
    if (SURFACE_KINDS.includes(O.kind) && tO >= tS - eps) return true; // (ii)
    return cS === 'cut' && clsAt(O, cutZ, x, y) === 'cut'; // (iii)
  };

  // 遮蔽物の**和の内部**: p がどの遮蔽物の厳密内部でもなくても、p の斜め4点（±NUDGE）がそれぞれ何らかの遮蔽物の
  // 厳密内部にあり、その遮蔽物が上の規則で隠すなら p は隠れる（4点すべてで成立したときだけ）。隣り合う壁の継ぎ目・
  // 矩形群の共有辺の上の線がこれで消える。和の外縁（外へ出る斜め点がある）と単独の立体の面に接する線は残る。
  const hiddenByUnion = (x, y, cS) => {
    const near = cands.filter(O => !(x + NUDGE < O.bounds.x1 || x - NUDGE > O.bounds.x2 || y + NUDGE < O.bounds.y1 || y - NUDGE > O.bounds.y2));
    if (near.length === 0) return false;
    for (const [dx, dy] of DIAGONALS) {
      const qx = x + dx * NUDGE, qy = y + dy * NUDGE;
      const tS = topAt(S, cutZ, qx, qy);
      if (!near.some(O => insideRec(O, qx, qy) && hides(O, qx, qy, tS, cS))) return false;
    }
    return true;
  };

  return (x, y) => {
    if (S.slopedCut && !(S.zAt(x, y) < cutZ)) return false;
    if (S.windowed && !inWindow(x, y)) return false;
    const tS = topAt(S, cutZ, x, y);
    const cS = clsAt(S, cutZ, x, y);
    for (const O of cands) {
      if (insideRec(O, x, y)) {
        if (hides(O, x, y, tS, cS)) return false;
      } else if (cS === 'cut' && clsAt(O, cutZ, x, y) === 'cut' && O.edges.some(e => onSegment(e, x, y))) {
        if (sharedFaceHidden(S, O, x, y, nx, ny)) return false;
      }
    }
    return !hiddenByUnion(x, y, cS);
  };
}

/**
 * cut 同士で S の線が O の境界の上にあるとき、隠すか。S と O の内側が線の反対側なら共有面（隠す）、
 * 同じ側に重なる外周なら index の小さい方（O が先）だけが描く。内側の判別がつかない線（内側の線など）は隠さない。
 */
function sharedFaceHidden(S, O, x, y, nx, ny) {
  const sa = insideRec(S, x + nx * SIDE_PROBE, y + ny * SIDE_PROBE);
  const sb = insideRec(S, x - nx * SIDE_PROBE, y - ny * SIDE_PROBE);
  if (sa === sb) return false;
  const oa = insideRec(O, x + nx * SIDE_PROBE, y + ny * SIDE_PROBE);
  const ob = insideRec(O, x - nx * SIDE_PROBE, y - ny * SIDE_PROBE);
  if (oa === ob) return false;
  if (sa !== oa) return true;
  return O.rank < S.rank;
}
