/**
 * 平面の立体モデル（純モジュール・単一の情報源）。層スタックの全実体を
 * 「平面の占有形（footprint）＋高さ範囲（zLo..zHi）」の立体へ正規化する。平面を「立体＋水平切断」で描く移行計画の
 * S2（`.claude/plan-section.md`）。描画・切断の分類（S3 の planSectionFigure）は本モジュールの外。
 *
 * store.js / snap.js / appViewport.js / *.jsx / graphDerived を import しない（node:test から単体 import 可）。
 * 展開図の層スタック（`elevation/section/sectionBandLayers.js buildBandLayers`）と同型の layers を**受け取る**
 * だけで、組み立てない（呼び出し側の責務）。
 *
 * z の取り決め: 自階 FL = 0 の絶対 mm・上が正（層の floorZMm が各階の FL）。梁は FL + levelOffset が天端、
 * 柱は FL〜天井、壁は FL〜天井（腰壁・垂れ壁・アキは展開図と同じ `kneeDropZRangesAt` を共有）、
 * 床は zLo = zHi = FL の面。
 *
 * @typedef {import('./planGeometry.js').Rect} Rect
 * @typedef {import('./planGeometry.js').Footprint} Footprint
 * @typedef {'floor'|'wall'|'column'|'beam'|'roof'|'stairTread'|'ceiling'|'generic'} SolidKind
 *   stairTread は階段の段（S7b）。厚み 0（zLo = zHi = 天端）・drawEdges:false の遮蔽専用（描くのは StairLayer だけ）。
 * @typedef {{points:number[], role:string}} InnerLine
 *   立体の内側の線（屋根の外形線・棟木・隅木・谷木。S5 から屋根が生成）。points は折れ線（閉じるなら先頭の点を末尾へ足す）。
 * @typedef {{anchor:{x:number,y:number}, prims:Array<object>}} Mark
 *   立体に付く注記（屋根の傾斜ラベル）。prims は `{kind:'arrow',key,points,head}|{kind:'text',key,x,y,text,fontSizeMm}`。
 *   解決器が anchor の可視判定で出し入れする。
 * @typedef {{
 *   kind: SolidKind,
 *   footprint: Footprint,
 *   zLo: number, zHi: number,
 *   zAt?: (x:number, y:number) => number,
 *   innerLines?: InnerLine[],
 *   marks?: Mark[],
 *   drawEdges?: boolean,
 *   source: {kind: string, id: string, layerFloorZ?: number, role?: string, part?: number, mergedIds?: string[]},
 *   style?: {dash?: number[]},
 * }} Solid
 *   zAt は勾配のある立体（屋根）だけが持つ。style は汎用立体だけ。drawEdges:false は footprint を遮蔽専用にする（輪郭を描かない。
 *   既定 true。屋根が使う）。
 * @typedef {{graph: object|null, floorZMm: number, role: 'self'|'above'|'below', ceilZMm?: number}} SolidLayer
 */
import { DEFAULT_ROOM_CEILING_HEIGHT, CL_OVERLAP_TOL_MM, edgeKey } from '@core';
import { beamDepthMm } from '../elevation/section/sectionStructure.js';
import { kneeDropZRangesAt } from '../elevation/section/sectionHits.js';
import { columnWrapSolids, wallConcealRange } from '../finish/columnWrap.js';
import { kneeDropRecordsOnAxis, effectiveCeilingHeight } from '../finish/kneeDropWall.js';
import { buildCellToRoom } from '../finish/edgeClassify.js';
import { cellBoundsList } from '../finish/gridCells.js';
import { floorOpeningCellRects } from '../finish/stair/slabOpening.js';
import { stairTreadFootprints } from '../finish/stair/stairTreads.js';
import { riserOf } from '../finish/stair/stairDimensions.js';
import { footprintCellKeys } from '../structural/wallGate.js';
import { stairFilterFor } from '../structural/openingBeamAxes.js';
import { rulesFor, effectiveStructure } from '../structural/structureRules.js';
import { leanToPlanRegions } from '../structural/roofFramingRegions.js';
import { drainArrivalTime } from '../structural/roofFramingGeometry.js';
import { roofPlanRegionFigure } from '../finish/roof/roofPlanFigure.js';
import { normalizeRect, isValidRect } from './planGeometry.js';
import { ceilingSurfacesOf } from '../ceiling/ceilingSurfaces.js';

/** 出力の kind 順（固定）。 */
export const SOLID_KIND_ORDER = Object.freeze(['floor', 'wall', 'column', 'beam', 'roof', 'stairTread', 'ceiling', 'generic']);

/**
 * 梁のうち立体にしない役割。基礎梁・土台は床下、小屋梁は小屋組で、平面の切断面（FL+切断高）に関わらない。
 * 隔て梁（partitionBeam）・踊り場受け梁（landing）は**含める**——展開図の寄与（structuralContribution）は
 * 壁に隠れる梁・隔て梁を先に落とすが、平面では「実在の部材で隠れるか」を幾何（立体の重なり）が決めるため、
 * ここで先回りして落とさない。
 */
const EXCLUDED_BEAM_ROLES = new Set(['foundation', 'sill', 'roofBeam']);

const SPAN_EPS_MM = 1; // 壁の分割点を端から離す最小量・潰れた区間の下限

/** 層の天井の絶対 z。層が持つ ceilZMm（下階の anchorRoom 由来）を優先、無ければ graph の既定天井高。 */
export function layerCeilZ(layer) {
  if (Number.isFinite(layer?.ceilZMm)) return layer.ceilZMm;
  return layer.floorZMm + (layer.graph?.defaultCeilingHeight ?? DEFAULT_ROOM_CEILING_HEIGHT);
}

const baseSource = (layer, kind, id, extra = {}) => ({ kind, id: String(id), layerFloorZ: layer.floorZMm, ...extra });

// ---------------------------------------------------------------- 梁

function beamSolids(layer) {
  const out = [];
  for (const beam of layer.graph.beams ?? []) {
    if (EXCLUDED_BEAM_ROLES.has(beam.role)) continue;
    const half = beam.sectionWidth / 2;
    const spanLo = Math.min(beam.coord1, beam.coord2), spanHi = Math.max(beam.coord1, beam.coord2);
    const rect = beam.isVertical
      ? { x1: beam.axisValue - half, x2: beam.axisValue + half, y1: spanLo, y2: spanHi }
      : { x1: spanLo, x2: spanHi, y1: beam.axisValue - half, y2: beam.axisValue + half };
    if (!isValidRect(rect)) continue;
    const zHi = layer.floorZMm + beam.levelOffset;
    out.push({
      kind: 'beam', footprint: { rects: [rect] },
      zLo: zHi - beamDepthMm(beam), zHi,
      source: baseSource(layer, 'beam', beam.id, { role: beam.role }),
    });
  }
  return out;
}

// ---------------------------------------------------------------- 柱

function columnSolids(layer) {
  const graph = layer.graph;
  // 柱包みを持たない構造（在来木造）は素の断面（展開図の structuralColumnContribution と同じ判定）。
  const noCover = !rulesFor(effectiveStructure(graph)).drawing.columnFinishWrap;
  const zHi = layerCeilZ(layer);
  const out = [];
  // 壁の集合は columnWrapSolids が1回だけ作る（柱ごとに作り直すと moku1-6 で planSolids の約64%）。
  // 壁の中に納まる柱（hidden）もここでは落とさない（見える／見えないは幾何が決める）。杭は columnWrapSolids が除く。
  for (const { column, wrapped } of columnWrapSolids(graph, { noCover })) {
    const rect = { x1: wrapped.xLo, y1: wrapped.yLo, x2: wrapped.xHi, y2: wrapped.yHi };
    if (!isValidRect(rect)) continue;
    out.push({
      kind: 'column', footprint: { rects: [rect] }, zLo: layer.floorZMm, zHi,
      source: baseSource(layer, 'column', column.id, column.role ? { role: column.role } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------- 壁

/**
 * 壁1本を、腰壁・垂れ壁レコードの端で区間に割り、区間ごとに高さ範囲（1件、アキなら2件）を立体にする。
 * 高さは展開図と同じ `kneeDropZRangesAt` を共有する（規則を複製しない）。同じ高さ範囲が続く隣の区間は結合する
 * （隅の取り合いで壁端がレコード端を食い込む分の細片を作らない）。
 * 壁の高さの上限は壁ごとに1つ（wallCeilZ。両側の部屋の天井高の低い方、無ければ層の天井）。隔て壁の斜めの天端（wallTop）は S7 まで扱わない。
 */
function wallSolids(layer, cellToRoom) {
  const graph = layer.graph;
  const hasRecords = (graph.kneeDropWalls?.size ?? 0) > 0;
  const out = [];
  const meta = []; // out と同じ添字: 結合判定用 {axisId, vertical, band, along}
  for (const wall of graph.walls ?? []) {
    const cr = wallConcealRange(wall);
    if (!cr || !(cr.hi - cr.lo > 0)) continue;
    const wLo = Math.min(wall.coord1, wall.coord2), wHi = Math.max(wall.coord1, wall.coord2);
    if (!(wHi - wLo > SPAN_EPS_MM)) continue;
    const cuts = hasRecords
      ? kneeDropRecordsOnAxis(graph, wall.axisCL, wLo, wHi).flatMap(r => [r.lo, r.hi])
        .filter(c => c > wLo + SPAN_EPS_MM && c < wHi - SPAN_EPS_MM)
      : [];
    const bounds = [...new Set([wLo, ...cuts, wHi])].sort((a, b) => a - b);
    const spans = []; // {lo, hi, ranges}
    const ceilZ = wallCeilZ(layer, wall, cellToRoom);
    for (let i = 0; i + 1 < bounds.length; i++) {
      const lo = bounds[i], hi = bounds[i + 1];
      if (!(hi - lo > 1e-6)) continue;
      const mid = (lo + hi) / 2;
      const ranges = kneeDropZRangesAt(graph, wall, mid, layer.floorZMm, ceilZ)
        .filter(r => r.z1 > r.z0);
      const key = JSON.stringify(ranges.map(r => [r.z0, r.z1]));
      const prev = spans[spans.length - 1];
      if (prev && prev.key === key) prev.hi = hi;
      else spans.push({ lo, hi, ranges, key });
    }
    let part = 0;
    for (const span of spans) {
      for (const r of span.ranges) {
        const rect = wall.isVertical
          ? { x1: cr.lo, x2: cr.hi, y1: span.lo, y2: span.hi }
          : { x1: span.lo, x2: span.hi, y1: cr.lo, y2: cr.hi };
        out.push({
          kind: 'wall', footprint: { rects: [rect] }, zLo: r.z0, zHi: r.z1,
          source: baseSource(layer, 'wall', wall.id, { part: part++ }),
        });
        meta.push({ axisId: wall.axisCL?.id ?? null, vertical: !!wall.isVertical, band: [cr.lo, cr.hi], along: [span.lo, span.hi] });
      }
    }
  }
  return mergeTouchingWalls(out, meta);
}

/**
 * 同じ芯 CL の上で、同じ高さ範囲（zLo・zHi）の壁の立体のうち、帯（厚み方向の隠せる範囲）が接する・重なり、かつ長さ方向の区間が
 * 重なるものを 1 件の立体（footprint.rects を複数持つ）にまとめる。下地の壁と仕上げの薄壁（隔て板など）が同じ芯で並んでも、
 * 見下げは**帯の外形だけ**を描く（下地/仕上げの境目は描かない）。遮蔽は同じ矩形の和なので不変。
 * 代表は壁 id 最小の立体（入力順に依らない）で、source は代表の壁 id・part に `mergedIds`（まとめた壁 id 全部）を足す。1 件だけのものは不変。
 */
function mergeTouchingWalls(solids, meta) {
  const n = solids.length;
  const parent = solids.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    if (meta[i].axisId == null) continue;
    const key = `${meta[i].vertical}|${meta[i].axisId}|${solids[i].zLo}|${solids[i].zHi}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const TOL = 1e-6;
  for (const idxs of groups.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const A = meta[idxs[a]], B = meta[idxs[b]];
        const touchBand = A.band[0] <= B.band[1] + TOL && B.band[0] <= A.band[1] + TOL;
        const overlapAlong = Math.min(A.along[1], B.along[1]) - Math.max(A.along[0], B.along[0]) > TOL;
        if (!touchBand || !overlapAlong) continue;
        const ra = find(idxs[a]), rb = find(idxs[b]);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); // 代表は最小添字（最初に出した立体）
      }
    }
  }
  const members = new Map(); // 代表添字 → 構成員の添字（昇順）
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!members.has(r)) members.set(r, []);
    members.get(r).push(i);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const ms = members.get(i);
    if (!ms) continue; // 他の代表にまとめられた
    if (ms.length === 1) { out.push(solids[i]); continue; }
    // 代表は壁 id 最小（同じ id は part 最小）。graph.walls の順に依らず source.id・線の key を決める
    const sorted = [...ms].sort((p, q) => cmp(solids[p].source.id, solids[q].source.id) || (solids[p].source.part ?? 0) - (solids[q].source.part ?? 0));
    const rep = solids[sorted[0]];
    out.push({
      ...rep,
      footprint: { rects: sorted.flatMap(k => solids[k].footprint.rects) },
      source: { ...rep.source, mergedIds: [...new Set(sorted.map(k => solids[k].source.id))] },
    });
  }
  return out;
}

/**
 * 壁の上端（絶対 z）。**壁ごとに1つ**: 層が ceilZMm を持てばそれ、無ければ壁の両側の部屋の天井高の低い方
 * （kneeDropWall.effectiveCeilingHeight。片側だけ部屋ならその側）、どちらも解決できなければ層の天井。
 * 区間ごとには決めない——隅の取り合いで壁端がレコード端の外へはみ出した細片だけ別の天井になるのを防ぎ、
 * 展開図（全高の壁にも帯の天井を使う）と揃える。
 */
function wallCeilZ(layer, wall, cellToRoom) {
  if (Number.isFinite(layer.ceilZMm)) return layer.ceilZMm;
  if (wall.axisCL && wall.clStart && wall.clEnd) {
    const ch = effectiveCeilingHeight(layer.graph, edgeKey(wall.axisCL.id, wall.clStart.id, wall.clEnd.id), cellToRoom());
    if (ch != null) return layer.floorZMm + ch;
  }
  return layerCeilZ(layer);
}

// ---------------------------------------------------------------- 床

/**
 * 層の床の立体（穴つきの床）。**スラブ実体の実装後はこの関数の中身だけを差し替える**（裁定 (c)・2026-10-08）。
 * 当面の床＝建物範囲のセル矩形（仕上げの屋内部屋セル。屋根セルは入らない）、穴＝床開口のセル矩形
 * （吹抜け・昇降路・階段吹抜け・階段の破れ先。`finish/stair/slabOpening.js floorOpeningCellRects`）。
 * 破れ先が穴になるのは**下階に同じ階段があるとき**だけ（`stairFilterFor`。設置階自身の床に穴は無い）。
 * @param {SolidLayer} layer
 * @param {{riserOf?: (stair:object)=>number|null, belowGraphOf?: (graph:object)=>object|null}} [opts]
 * @returns {Solid|null} 建物範囲が無い（部屋が無い階）なら null
 */
export function floorSolidOf(layer, opts = {}) {
  const graph = layer?.graph;
  if (!graph) return null;
  const rects = cellBoundsList(footprintCellKeys(graph), graph).map(normalizeRect).filter(isValidRect)
    .sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
  if (rects.length === 0) return null;
  const below = opts.belowGraphOf?.(graph) ?? null;
  const holes = floorOpeningCellRects(graph, { riserOf: opts.riserOf ?? (() => null), stairFilter: stairFilterFor(graph, below) })
    .map(({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 }));
  return {
    kind: 'floor', footprint: { rects, holes }, zLo: layer.floorZMm, zHi: layer.floorZMm,
    source: baseSource(layer, 'floor', graph.plane?.id ?? `z${layer.floorZMm}`),
  };
}

// ---------------------------------------------------------------- 下屋

/**
 * 下屋の屋根面の高さ関数。水下から内側へ向かう到達時刻 T（structural/roofFramingGeometry.js drainArrivalTime）を
 * 勾配 slope/10 の高さへ写す。**軒先（水下 T=0）と軒の出（範囲外）が層の FL、最高点が FL + k·tMax**（k＝勾配/10。
 * S5 で「最高点＝FL」から訂正。「軒先＝FL」は設計上の仮定。ASSUMED）。
 * tMax は、水下・矩形の座標の格子点と、その座標対の中点の組での評価の最大で近似する（左右対称な寄棟・切妻・片流れでは厳密。
 * 左右非対称の L 字の谷では最高点が数 mm ずれうる）。
 * 水下が無い・到達時刻が作れない形（valid=false）・勾配が不正は平ら（zAt なし。zHi = FL）。
 * @returns {{zAt: (x:number,y:number)=>number, zTop: number}|null} null＝平ら
 */
function roofZAtOf(layer, region) {
  const rects = region.rect ? [region.rect] : region.rects;
  const drains = region.planDrains ?? [];
  const slope = region.slope;
  if (region.outlineOnly || drains.length === 0 || !Array.isArray(rects) || !(slope > 0)) return null;
  const arrival = drainArrivalTime({ rects, drains, tolMm: CL_OVERLAP_TOL_MM });
  if (!arrival.valid) return null;
  const xs = [...new Set([...rects.flatMap(r => [r.x1, r.x2]), ...drains.flatMap(d => (d.isVertical ? [d.coord] : [d.lo, d.hi]))])];
  const ys = [...new Set([...rects.flatMap(r => [r.y1, r.y2]), ...drains.flatMap(d => (d.isVertical ? [d.lo, d.hi] : [d.coord]))])];
  const withMids = vs => [...new Set([...vs, ...vs.flatMap((a, i) => vs.slice(i + 1).map(b => (a + b) / 2))])];
  let tMax = 0;
  for (const x of withMids(xs)) {
    for (const y of withMids(ys)) {
      const t = arrival.T(x, y);
      if (Number.isFinite(t) && t > tMax) tMax = t;
    }
  }
  if (!(tMax > 0)) return null;
  const k = slope / 10;
  return {
    zTop: layer.floorZMm + k * tMax,
    // 軒の出（範囲外 -Infinity）は軒先＝FL。T が tMax を超える・Infinity は最高点
    zAt: (x, y) => layer.floorZMm + k * Math.min(Math.max(arrival.T(x, y), 0), tMax),
  };
}

/** 閉じた外形線の点列は先頭の点を末尾へ足す（解決器は閉じる辺を作らない）。 */
const innerLinePoints = ({ points, closed }) => (closed ? [...points, points[0], points[1]] : points);

/**
 * 下屋（屋根セルを持つ階の屋根の部屋）の立体。外形は region.outline（軒の出・壁との取り合いを含む閉路）の多角形で、
 * **遮蔽専用**（drawEdges:false。屋内に接する出幅0の辺を描かない裁定は壁の無い階でも有効で、幾何だけでは再現できないため）。
 * 描く線は innerLines（壁で切る前の外形線 exposedPaths・棟木・隅木・谷木。`roofPlanRegionFigure`）で、外壁面どまりは
 * 壁立体の遮蔽が導く。傾斜ラベルは marks。複数の閉路なら閉路ごとに1件（source.part）で、線とラベルは最初の1件だけに付ける。
 * outline の無い region は矩形のときだけ矩形の閉路で代用し、矩形でなければ落とす。主屋根（最上階の屋根）は常に切断面より
 * 上なので立体化しない（拡張点: ここ）。
 */
function roofSolids(layer) {
  const out = [];
  for (const region of leanToPlanRegions(layer.graph)) {
    const loops = (region.outline ?? []).map(l => l.points);
    if (loops.length === 0 && region.rect) {
      const { x1, y1, x2, y2 } = region.rect;
      loops.push([x1, y1, x2, y1, x2, y2, x1, y2]);
    }
    const slope = roofZAtOf(layer, region);
    const figure = roofPlanRegionFigure(region);
    const innerLines = figure.lines.map(l => ({ role: l.role, points: innerLinePoints(l) }));
    const marks = figure.labels.map(l => ({ anchor: l.anchor, prims: l.prims })); // 解決器が weight・cls・detailOnly を付ける
    let first = true;
    loops.forEach((poly, part) => {
      if (poly.length < 6 || !poly.every(Number.isFinite)) return;
      const solid = {
        kind: 'roof', footprint: { poly }, zLo: layer.floorZMm, zHi: slope ? slope.zTop : layer.floorZMm, drawEdges: false,
        source: baseSource(layer, 'roof', region.key, { part }),
      };
      if (slope) solid.zAt = slope.zAt;
      if (first) {
        if (innerLines.length > 0) solid.innerLines = innerLines;
        if (marks.length > 0) solid.marks = marks;
        first = false;
      }
      out.push(solid);
    });
  }
  return out;
}

// ---------------------------------------------------------------- 階段の段

const polyArea2 = p => p.reduce((s, _, i) => (i % 2 ? s : s + p[i] * p[(i + 3) % p.length] - p[(i + 2) % p.length] * p[i + 1]), 0);

/**
 * 階段の段（マス）の立体。**遮蔽専用**（drawEdges:false。階段の線を描くのは StairLayer だけ）。段 n の天端は
 * 層の FL + n × 蹴上、厚みは 0（zLo = zHi。段板の厚みは使わない＝限界）。蹴上が求まらない階段は立体にしない（遮蔽しない）。
 * 多角形はマスごとに1件（source.id＝階段 id・source.part＝段数字と同じ番号）。不正な多角形（6 要素未満・非有限・面積 0）は捨てる。
 * @param {SolidLayer} layer
 * @param {(stair:object)=>number|null} riserFor 階段の蹴上（層ごとに決める。planSolids の riserForLayer）
 */
function stairTreadSolids(layer, riserFor) {
  const out = [];
  const insetView = layer.role === 'self' ? 'install' : 'upper'; // 自階は設置階の逃がし（StairLayer の beyondBuilt と同じ）、下階は見下げ
  for (const stair of layer.graph.stairs ?? []) {
    for (const t of stairTreadFootprints(stair, layer.graph, { riser: riserFor(stair), insetView })) {
      const p = t.poly;
      if (p.length < 6 || p.length % 2 !== 0 || !p.every(Number.isFinite) || Math.abs(polyArea2(p)) < 1e-6) continue;
      const z = layer.floorZMm + t.topZ;
      out.push({
        kind: 'stairTread', footprint: { poly: p }, zLo: z, zHi: z, drawEdges: false,
        source: baseSource(layer, 'stairTread', stair.id, { part: t.number }),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 天井

/**
 * 天井の立体（見上げ＝天伏モード専用。`opts.ceilings === true` のときだけ、自階の層に足す）。
 * 部屋ごとに1件（セル矩形の和）、面材（解決器の SURFACE_KINDS）で厚み 0（zLo = zHi = 層の FL + 天井面の高さ zMm。床段差込み）。
 * 輪郭は既定どおり描く。部屋ごとに別立体のため、同じ高さで隣り合う部屋も壁の無い境界では見切り線が出る
 * （同じ立体の矩形群の共有辺だけが消える）。裁定 2026-10-10: 細線グレー（ceiling/ceilingBoundaryStyle.js の後処理）。
 * 算出は ceiling/ceilingSurfaces.js。
 * @param {SolidLayer} layer
 */
function ceilingSolids(layer) {
  return ceilingSurfacesOf(layer.graph).map(({ roomId, rects, zMm }) => ({
    kind: 'ceiling', footprint: { rects }, zLo: layer.floorZMm + zMm, zHi: layer.floorZMm + zMm,
    source: baseSource(layer, 'ceiling', roomId),
  }));
}

// ---------------------------------------------------------------- 汎用立体

/**
 * 汎用立体（配管・任意高さの横架材など）の検証。zLo<=zHi が有限・footprint が有限で空でない・kind が generic（省略可）。
 * 通ったものは footprint の矩形を正規化したコピーにする。通らないものは null（黙って捨てる。呼び出し側は件数を見ない）。
 */
function validatedExtra(s) {
  if (!s || (s.kind !== undefined && s.kind !== 'generic')) return null;
  if (!Number.isFinite(s.zLo) || !Number.isFinite(s.zHi) || s.zLo > s.zHi) return null;
  const fp = s.footprint;
  let footprint = null;
  if (fp && Array.isArray(fp.poly)) {
    if (fp.poly.length >= 6 && fp.poly.length % 2 === 0 && fp.poly.every(Number.isFinite)) footprint = { poly: [...fp.poly] };
  } else if (fp && Array.isArray(fp.rects)) {
    const rects = fp.rects.filter(r => r && [r.x1, r.y1, r.x2, r.y2].every(Number.isFinite)).map(normalizeRect).filter(isValidRect);
    const holes = (fp.holes ?? []).filter(r => r && [r.x1, r.y1, r.x2, r.y2].every(Number.isFinite)).map(normalizeRect).filter(isValidRect);
    if (rects.length > 0 && rects.length === fp.rects.length) footprint = holes.length > 0 ? { rects, holes } : { rects };
  }
  if (!footprint) return null;
  const src = s.source ?? {};
  return {
    kind: 'generic', footprint, zLo: s.zLo, zHi: s.zHi,
    source: { kind: src.kind ?? 'generic', id: String(src.id ?? ''), ...(src.layerFloorZ != null ? { layerFloorZ: src.layerFloorZ } : {}) },
    ...(s.style ? { style: s.style } : {}),
  };
}

// ---------------------------------------------------------------- 入口

const ROLE_RANK = { self: 0, above: 1, below: 2 };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 層スタックの全実体を立体へ。決定的な順序: 層の FL の高い順（同じ高さは self→above→below）→ kind（SOLID_KIND_ORDER）→
 * source.id → source.part。入力の層の順・配列の順に依存しない。汎用立体（opts.extraSolids）は最後に kind=generic として
 * source.id 順で続く。
 * graph が無い層は飛ばす。層が空・無ければ []。
 * @param {SolidLayer[]} layers  `elevation/section/sectionBandLayers.js buildBandLayers` の戻り値と同型
 * @param {{riserOf?: (stair:object)=>number|null, belowGraphOf?: (graph:object)=>object|null, extraSolids?: Solid[], ceilings?: boolean}} [opts]
 *   ceilings＝true のときだけ self の層に天井立体（kind 'ceiling'。見上げ用）を足す。省略（見下げ）の出力は不変。
 *   riserOf＝最上の層の階段の蹴上（破れ先の位置・段の高さ）。下の層の階段は直上の層との階高から求める（stairTreadSolids）。belowGraphOf＝graph の直下階の graph（無ければ null。破れ先を穴にするかの判定）。
 * @returns {Solid[]}
 */
export function planSolids(layers, opts = {}) {
  const entries = []; // {solid, layerZ, roleRank}
  const floorZs = (layers ?? []).filter(l => l?.graph && Number.isFinite(l.floorZMm)).map(l => l.floorZMm).sort((a, b) => a - b);
  for (const layer of layers ?? []) {
    if (!layer?.graph || !Number.isFinite(layer.floorZMm)) continue;
    let cellToRoom = null;
    const lazyCellToRoom = () => (cellToRoom ??= buildCellToRoom(layer.graph));
    // 階段の蹴上は層ごとに1本: 直上の層があればその階高（直上の FL − この層の FL）から、無ければ（最上の層＝自階）opts.riserOf。
    // 明示指定（stair.riser）は riserOf が優先する。下階の層に自階の riserOf を使うと階高の違う階で段の高さがずれる
    const upperZ = floorZs.find(z => z > layer.floorZMm);
    const riserForLayer = upperZ !== undefined
      ? stair => riserOf(stair, upperZ - layer.floorZMm)
      : stair => opts.riserOf?.(stair) ?? null;
    const solids = [floorSolidOf(layer, opts), ...wallSolids(layer, lazyCellToRoom), ...columnSolids(layer),
      ...beamSolids(layer), ...roofSolids(layer), ...stairTreadSolids(layer, riserForLayer),
      ...(opts.ceilings === true && layer.role === 'self' ? ceilingSolids(layer) : [])].filter(Boolean);
    for (const solid of solids) entries.push({ solid, layerZ: layer.floorZMm, roleRank: ROLE_RANK[layer.role] ?? 3 });
  }
  const kindRank = k => SOLID_KIND_ORDER.indexOf(k);
  entries.sort((a, b) => b.layerZ - a.layerZ || a.roleRank - b.roleRank
    || kindRank(a.solid.kind) - kindRank(b.solid.kind)
    || cmp(a.solid.source.id, b.solid.source.id) || (a.solid.source.part ?? 0) - (b.solid.source.part ?? 0));
  const extras = (opts.extraSolids ?? []).map(validatedExtra).filter(Boolean)
    .sort((a, b) => cmp(a.source.id, b.source.id));
  return [...entries.map(e => e.solid), ...extras];
}
