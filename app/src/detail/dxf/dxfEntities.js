// ================================================================
// dxfParse の結果（line／arc）→ 図座標 mm の線分列（純関数）。
//   - 単位: opts.unitFactor（ユーザー指定）＞ $INSUNITS の係数（DXF_INSUNITS_TO_MM）＞ 不明なら係数 1 を仮置きして UNIT_UNKNOWN。
//   - 座標系: 図の座標（s＝右、t＝下向き正）へ写す。DXF は y 上向きなので t = −y（見た目の上下を保つ）。
//   - 円弧は弦に分割する。弦と弧の最大のずれ（sagitta）が chordTol 以下になる最少の等分割。円は角度 0 から始め、
//     最後の点は最初の点と同じ座標にする（端点スナップで閉じた成分になる）。楕円弧（非一様スケール後）も半径の大きい方で近似。
//   - 線分数の上限（maxSegments）で打ち切り ENTITY_LIMIT。
// 出力 segments: [{ a:{s,t}, b:{s,t} }]
// ================================================================

import {
  DxfWarning, DXF_INSUNITS_TO_MM, DXF_CHORD_TOL_MM, DXF_MAX_SEGMENTS, DXF_FULL_TURN_EPS,
} from '../../core/constants.js';

// 座標が有限でない図形（桁あふれ）の警告に使う種類名。
const INVALID_COORD_TYPE = '座標が有限でない図形';

const TWO_PI = Math.PI * 2;
const FULL_CIRCLE_MIN_SEGMENTS = 3; // 円を多角形にする最少の辺数（幾何上の下限）
const ARC_MIN_SEGMENTS = 1;

export const DxfUnitSource = Object.freeze({ OVERRIDE: 'override', HEADER: 'header', ASSUMED: 'assumed' });

/** 弧の分割点（DXF 座標 × f。反転前）。分割数が予算を超えるときは予算までに切る。 */
function arcPoints(arc, f, tol, budgetLeft) {
  const radius = Math.max(Math.hypot(arc.u.x, arc.u.y), Math.hypot(arc.v.x, arc.v.y)) * f;
  const sweep = arc.t1 - arc.t0;
  if (!(radius > 0) || !(sweep > 0) || budgetLeft <= 0) return { pts: [], truncated: budgetLeft <= 0 };
  const full = sweep >= TWO_PI - DXF_FULL_TURN_EPS;
  const minSegments = full ? FULL_CIRCLE_MIN_SEGMENTS : ARC_MIN_SEGMENTS;
  // 矢高 r(1−cos(θ/2)) = 2r·sin²(θ/4) が tol 以下になる最大の θ = 4·asin(√(tol/2r))（1−cos の桁落ちを避ける形）。
  // 弧全体の矢高が tol 以下なら分割しない。
  const sag = 2 * radius * Math.sin(sweep / 4) ** 2;
  const step = 4 * Math.asin(Math.min(1, Math.sqrt(tol / (2 * radius))));
  const wanted = Math.max(sag <= tol ? 1 : Math.ceil(sweep / step), minSegments); // step=0（半径が極端に大きい）なら Infinity
  const n = Math.min(wanted, budgetLeft);
  const pts = [];
  for (let k = 0; k <= n; k++) {
    if (full && k === n) { pts.push(pts[0]); break; }
    const th = arc.t0 + sweep * k / n;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    pts.push({ x: (arc.c.x + arc.u.x * cos + arc.v.x * sin) * f, y: (arc.c.y + arc.u.y * cos + arc.v.y * sin) * f });
  }
  return { pts, truncated: wanted > n };
}

function unitOf(header, override) {
  if (Number.isFinite(override) && override > 0) return { factor: override, source: DxfUnitSource.OVERRIDE };
  const u = header?.insUnits;
  if (u !== null && u !== undefined && Object.hasOwn(DXF_INSUNITS_TO_MM, u)) return { factor: DXF_INSUNITS_TO_MM[u], source: DxfUnitSource.HEADER };
  return { factor: 1, source: DxfUnitSource.ASSUMED };
}

/**
 * @param {{header: {insUnits: number|null}, entities: object[]}} parsed dxfParse の結果
 * @param {{unitFactor?: number|null, chordTol?: number, maxSegments?: number}} [opts]
 * @returns {{segments: {a:{s:number,t:number}, b:{s:number,t:number}}[], unitFactor: number, unitSource: string, warnings: object[]}}
 */
export function dxfEntities(parsed, { unitFactor = null, chordTol = DXF_CHORD_TOL_MM, maxSegments = DXF_MAX_SEGMENTS } = {}) {
  const { factor, source } = unitOf(parsed?.header, unitFactor);
  const warnings = [];
  if (source === DxfUnitSource.ASSUMED) warnings.push({ code: DxfWarning.UNIT_UNKNOWN });
  // 0 を足して -0 を作らない（deepStrictEqual・表示で -0 が出ないように）。
  const toFig = p => ({ s: p.x * factor + 0, t: 0 - p.y * factor });
  const segments = [];
  let limited = false;
  let invalid = 0; // 換算で座標が有限でなくなった図形（黙って消さず、件数を警告する）
  const finitePt = p => Number.isFinite(p.s) && Number.isFinite(p.t);
  for (const ent of parsed?.entities ?? []) {
    if (segments.length >= maxSegments) { limited = true; break; }
    if (ent.kind === 'line') {
      const a = toFig(ent.a);
      const b = toFig(ent.b);
      if (finitePt(a) && finitePt(b)) segments.push({ a, b }); else invalid += 1;
    } else if (ent.kind === 'arc') {
      const { pts, truncated } = arcPoints(ent, factor, chordTol, maxSegments - segments.length);
      // arcPoints は既に factor 倍。toFig へは 1/factor を掛けて戻さず、直接 y を反転する。
      const figPts = pts.map(p => ({ s: p.x + 0, t: 0 - p.y }));
      if (!Number.isFinite(factor * Math.hypot(ent.u.x, ent.u.y, ent.v.x, ent.v.y)) || !figPts.every(finitePt)) { invalid += 1; continue; }
      if (truncated) limited = true;
      for (let i = 0; i + 1 < figPts.length; i++) segments.push({ a: figPts[i], b: figPts[i + 1] });
    }
  }
  if (invalid > 0) warnings.push({ code: DxfWarning.UNSUPPORTED_ENTITY, type: INVALID_COORD_TYPE, count: invalid });
  if (limited) warnings.push({ code: DxfWarning.ENTITY_LIMIT, limit: maxSegments });
  return { segments, unitFactor: factor, unitSource: source, warnings };
}
