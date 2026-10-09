// 展開図（階段室の切断面）の階段の蹴上と、平面の踏面線・放射線の「切断線との交点」を突き合わせる純モジュール。
// diffStairElevPlan.mjs（CLI）から使う。io・process.argv は持たない＝node:test から直接単体テストできる
// （.claude/skills/team-lessons/SKILL.md の「抽出純モジュール」規約。diffElevGolden.mjs ⇄ elevGoldenDiff.mjs と同じ分け方）。
//
// 用語
//   run 座標 … 切断線（世界座標の直線）に沿った座標。切断線が縦（isVertical）なら y、横なら x。
//   面ローカル x … 展開図の面の x（cutOriginWorld を 0 とし dirSign の向きに増える）。
//                 世界の run 座標 = origin + localX * dirSign（sectionTypes.js の worldOf と同じ式）。
// 照合の定義（両方向）
//   展開図の蹴上（縦線）の run 座標の集合 E と、平面の線分と切断線の交点の run 座標の集合 P を ±tol で突き合わせる。
//   E にあって P に無い＝「展開図だけ」、P にあって E に無い＝「平面だけ」。どちらかが 1 本でもあれば不一致。

export const DEFAULT_TOL_MM = 0.5;
const DEDUP_MM = 0.01; // 同じ蹴上が複数のプリミティブに重複して出ても 1 本と数える幅
const AXIS_EPS = 1e-6; // 縦線・平行の判定

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** 昇順に並べ、DEDUP_MM 以内の重複を 1 つにする。非有限は捨てる。 */
export function uniqueSorted(values) {
  const xs = values.filter(finite).sort((a, b) => a - b);
  const out = [];
  for (const v of xs) if (out.length === 0 || v - out[out.length - 1] > DEDUP_MM) out.push(v);
  return out;
}

/**
 * 蹴上のジグザグ polyline（面ローカル。stairRunProfile の points）から各段の段鼻（踏面の先端）の x を取り出す。
 * 平面の踏面線・放射線は段鼻の位置なので、蹴込 k だけ奥に引っ込む蹴込板の縦線ではなく段鼻と比べる
 * （stairPlanAlign.test.js の elevationNoses と同じ量）。点列の規則（elevationStairSection.js stairRunProfile）:
 *   段鼻 ＝ 「上りの線分（y が減る向き）で着いた頂点」で、次の線分が歩行方向へ進む水平線のもの。
 *   polyline の終点が上りで着いた頂点なら最終段の段鼻。ただし着いた線分が垂直（dx=0）で nosingMm>0 のときは
 *   段板厚つき（木造）の最終段で、蹴込板の縦線が段鼻より dir*k 奥にあるため段鼻 = 終点 x − dir*nosingMm。
 * 歩行方向 dir は polyline 全体の x の進み（終点 x − 始点 x）の符号。非有限の点を含む polyline は捨てる。
 * @param {object[]} prims
 * @param {{nosingMm?:number, edgeXs?:number[]}} [opts] edgeXs … 面の描画範囲の端の x（終点がここに寄せられていたら蹴込の補正をしない）
 * @returns {number[]} 面ローカル x（昇順・重複なし）
 */
export function noseLocalXs(prims, { nosingMm = 0, edgeXs = [] } = {}) {
  const xs = [];
  for (const p of prims ?? []) {
    if (p?.type !== 'polyline' || !Array.isArray(p.points) || p.points.length < 2) continue;
    const pts = p.points;
    if (!pts.every(q => Array.isArray(q) && finite(q[0]) && finite(q[1]))) continue;
    const dir = Math.sign(pts[pts.length - 1][0] - pts[0][0]) || 1;
    for (let i = 1; i < pts.length; i++) {
      const up = pts[i][1] < pts[i - 1][1] - AXIS_EPS;
      if (!up) continue;
      if (i === pts.length - 1) {
        const vertical = Math.abs(pts[i][0] - pts[i - 1][0]) < AXIS_EPS;
        // 終点が面の端（edgeXs）に張りついているなら sectionStair.js の clamp で寄せられた縦線（本来の足元は面の外）。
        // 見えている縦線の位置そのものを段鼻として扱う（面端の縦線と平面の辺が重なる見え方を保つ既存仕様）。
        const clamped = edgeXs.some(e => Math.abs(pts[i][0] - e) < AXIS_EPS);
        xs.push(vertical && nosingMm > 0 && !clamped ? pts[i][0] - dir * nosingMm : pts[i][0]);
        continue;
      }
      const next = pts[i + 1];
      const horizontal = Math.abs(next[1] - pts[i][1]) < AXIS_EPS;
      if (horizontal && (next[0] - pts[i][0]) * dir > AXIS_EPS) xs.push(pts[i][0]);
    }
  }
  return uniqueSorted(xs);
}

/** 縦線（x1==x2・y1!=y2 の line）の x。回り段の蹴上線（landingStepRisers）用。非有限は捨てる。 */
export function verticalLineXs(prims) {
  const xs = [];
  for (const p of prims ?? []) {
    if (p?.type !== 'line' || ![p.x1, p.y1, p.x2, p.y2].every(finite)) continue;
    if (Math.abs(p.x1 - p.x2) < AXIS_EPS && Math.abs(p.y1 - p.y2) > AXIS_EPS) xs.push((p.x1 + p.x2) / 2);
  }
  return uniqueSorted(xs);
}

/** 面ローカル x → 世界の run 座標。 */
export function localToWorldRun(localX, originWorld, dirSign) {
  return originWorld + localX * dirSign;
}

/**
 * 平面の線分 {x1,y1,x2,y2}[] と切断線 {isVertical, axisValue} の交点の run 座標。
 * 切断線と平行な線分（重なっていても）は交点なし。範囲 [lo, hi]（±tol）の外は数えない。非有限の線分は捨てる。
 * @returns {number[]} 昇順・重複なし
 */
export function planCrossings(segs, line, { lo = line.lo, hi = line.hi, tol = DEFAULT_TOL_MM } = {}) {
  const out = [];
  for (const s of segs ?? []) {
    if (![s?.x1, s?.y1, s?.x2, s?.y2].every(finite)) continue;
    // 切断線に直交する座標 a（縦の切断線なら x）と沿う座標 r（縦なら y）
    const [a1, r1, a2, r2] = line.isVertical ? [s.x1, s.y1, s.x2, s.y2] : [s.y1, s.x1, s.y2, s.x2];
    if (Math.abs(a1 - a2) < AXIS_EPS) continue; // 平行
    const t = (line.axisValue - a1) / (a2 - a1);
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    out.push(r1 + t * (r2 - r1));
  }
  return uniqueSorted(out).filter(r => r >= lo - tol && r <= hi + tol);
}

/**
 * 2 つの run 座標集合を ±tol で両方向に突き合わせる。
 * @returns {{matched:number, elevOnly:number[], planOnly:number[]}}
 */
export function compareRuns(elevRuns, planRuns, tol = DEFAULT_TOL_MM) {
  const E = uniqueSorted(elevRuns ?? []);
  const P = uniqueSorted(planRuns ?? []);
  const elevOnly = E.filter(e => !P.some(p => Math.abs(p - e) <= tol));
  const planOnly = P.filter(p => !E.some(e => Math.abs(p - e) <= tol));
  return { matched: E.length - elevOnly.length, elevOnly, planOnly };
}

/**
 * runs のうち edgeRuns（面の両端の世界 run 座標）の ±tol にあるものを分ける。
 * @returns {{inner:number[], edge:number[]}}
 */
export function splitEdgeRuns(runs, edgeRuns, tol = DEFAULT_TOL_MM) {
  const edges = (edgeRuns ?? []).filter(finite);
  const inner = [], edge = [];
  for (const r of uniqueSorted(runs ?? [])) (edges.some(e => Math.abs(r - e) <= tol) ? edge : inner).push(r);
  return { inner, edge };
}

/**
 * 1 切断面の照合結果を 1 行（表の行）にする。
 * 面端（edgeRuns の ±tol）の交点・蹴上は照合から外して edgeElev/edgePlan に分ける。面端の縦線は sectionStair.js の
 * computeFlightProfile が [loX,hiX] へクランプするため、真の段鼻が端から少しずれていても同じ位置の縦線になり、
 * 平面と合っているかを判定できない（未検査）。
 * checked … 面端を除いた展開図・平面の蹴上が 1 本でもある（＝実際に突き合わせた）。両方空の行は未検査（判定 '—'）。
 */
export function summarizeCut({ doc, floor, room, seq, kind, elevRuns, planRuns, edgeRuns = [], tol = DEFAULT_TOL_MM }) {
  const e = splitEdgeRuns(elevRuns, edgeRuns, tol);
  const p = splitEdgeRuns(planRuns, edgeRuns, tol);
  const c = compareRuns(e.inner, p.inner, tol);
  const checked = e.inner.length + p.inner.length > 0;
  const clean = c.elevOnly.length === 0 && c.planOnly.length === 0;
  return {
    doc, floor, room, seq, kind,
    elev: e.inner.length, plan: p.inner.length,
    matched: c.matched, elevOnly: c.elevOnly, planOnly: c.planOnly,
    edgeElev: e.edge, edgePlan: p.edge,
    checked, ok: checked && clean,
    status: !checked ? '—' : (clean ? 'OK' : 'NG'),
  };
}

/** 行の合計。checked＝検査した切断面（未検査の行は ok/badCuts に数えない）。edge＝面端（未検査）の本数。 */
export function totalOf(rows) {
  return rows.reduce((t, r) => ({
    cuts: t.cuts + 1, checked: t.checked + (r.checked ? 1 : 0), okCuts: t.okCuts + (r.ok ? 1 : 0),
    elev: t.elev + r.elev, plan: t.plan + r.plan, matched: t.matched + r.matched,
    elevOnly: t.elevOnly + r.elevOnly.length, planOnly: t.planOnly + r.planOnly.length,
    edge: t.edge + r.edgeElev.length + r.edgePlan.length,
    badCuts: t.badCuts + (r.checked && !r.ok ? 1 : 0),
  }), { cuts: 0, checked: 0, okCuts: 0, elev: 0, plan: 0, matched: 0, elevOnly: 0, planOnly: 0, edge: 0, badCuts: 0 });
}

const r1 = (v) => Math.round(v * 10) / 10;

/** 表の文字列（タブ区切り）。verbose なら不一致・面端の run 座標を続けて列挙。 */
export function formatRows(rows, { verbose = false, localOf = null } = {}) {
  const lines = ['doc	階	階段室	切断面	種別	展開図	平面	一致	展開図だけ	平面だけ	面端(未検査)	判定'];
  for (const r of rows) {
    lines.push([r.doc, r.floor, r.room, r.seq, r.kind, r.elev, r.plan, r.matched,
      r.elevOnly.length, r.planOnly.length, r.edgeElev.length + r.edgePlan.length,
      r.status === '—' ? '—（未検査）' : r.status].join('	'));
    if (verbose) {
      for (const [tag, list] of [['展開図だけ', r.elevOnly], ['平面だけ', r.planOnly], ['面端(展開図)', r.edgeElev], ['面端(平面)', r.edgePlan]]) {
        for (const w of list) {
          const loc = localOf ? ` 面ローカルx=${r1(localOf(r, w))}` : '';
          lines.push(`    ${tag}: 世界run=${r1(w)}${loc}`);
        }
      }
    }
  }
  return lines.join('\n');
}
