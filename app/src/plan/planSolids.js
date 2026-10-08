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
 * @typedef {'floor'|'wall'|'column'|'beam'|'roof'|'stairTread'|'generic'} SolidKind
 *   stairTread は予約（S2 では生成しない。純粋な踏面幾何が無い——S7 の前に stairTreadSolids が要る）。
 * @typedef {{points:number[], role:string}} InnerLine
 *   立体の内側の線（屋根の棟木など）。S2 では生成しない（形だけ予約）。
 * @typedef {{
 *   kind: SolidKind,
 *   footprint: Footprint,
 *   zLo: number, zHi: number,
 *   zAt?: (x:number, y:number) => number,
 *   innerLines?: InnerLine[],
 *   source: {kind: string, id: string, layerFloorZ?: number, role?: string, part?: number},
 *   style?: {dash?: number[]},
 * }} Solid
 *   zAt は勾配のある立体（屋根）だけが持つ。style は汎用立体だけ。
 * @typedef {{graph: object|null, floorZMm: number, role: 'self'|'above'|'below', ceilZMm?: number}} SolidLayer
 */
import { DEFAULT_ROOM_CEILING_HEIGHT, CL_OVERLAP_TOL_MM, edgeKey } from '@core';
import { beamDepthMm } from '../elevation/section/sectionStructure.js';
import { kneeDropZRangesAt } from '../elevation/section/sectionHits.js';
import { bareColumnRect, wrapColumnWithFinish, wallConcealRange } from '../finish/columnWrap.js';
import { kneeDropRecordsOnAxis, effectiveCeilingHeight } from '../finish/kneeDropWall.js';
import { buildCellToRoom } from '../finish/edgeClassify.js';
import { cellBoundsList } from '../finish/gridCells.js';
import { floorOpeningCellRects } from '../finish/stair/slabOpening.js';
import { footprintCellKeys } from '../structural/wallGate.js';
import { stairFilterFor } from '../structural/openingBeamAxes.js';
import { rulesFor, effectiveStructure } from '../structural/structureRules.js';
import { leanToPlanRegions } from '../structural/roofFramingRegions.js';
import { drainArrivalTime } from '../structural/roofFramingGeometry.js';
import { normalizeRect, isValidRect } from './planGeometry.js';

/** 出力の kind 順（固定）。 */
export const SOLID_KIND_ORDER = Object.freeze(['floor', 'wall', 'column', 'beam', 'roof', 'stairTread', 'generic']);

/**
 * 梁のうち立体にしない役割。基礎梁・土台は床下、小屋梁は小屋組で、平面の切断面（FL+切断高）に関わらない。
 * 隔て梁（partitionBeam）・踊り場受け梁（landing）は**含める**——展開図の寄与（structuralContribution）は
 * 壁に隠れる梁・隔て梁を先に落とすが、平面では「実在の部材で隠れるか」を幾何（立体の重なり）が決めるため、
 * ここで先回りして落とさない。
 */
const EXCLUDED_BEAM_ROLES = new Set(['foundation', 'sill', 'roofBeam']);
const FOUNDATION_ROLE = 'foundation'; // 柱の杭

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
  const walls = graph.walls ?? [];
  // 柱包みを持たない構造（在来木造）は素の断面（展開図の structuralColumnContribution と同じ判定）。
  const noCover = !rulesFor(effectiveStructure(graph)).drawing.columnFinishWrap;
  const zHi = layerCeilZ(layer);
  const out = [];
  for (const column of graph.columns ?? []) {
    if (column.role === FOUNDATION_ROLE) continue; // 杭
    // 壁の中に納まる柱もここでは落とさない（見える／見えないは幾何が決める）。
    const wrapped = wrapColumnWithFinish(bareColumnRect(column, layer.floorZMm), walls, { noCover });
    const rect = { x1: wrapped.xLo, y1: wrapped.yLo, x2: wrapped.xHi, y2: wrapped.yHi };
    if (!isValidRect(rect)) continue;
    out.push({
      kind: 'column', footprint: { rects: [rect] }, zLo: wrapped.baseZ, zHi,
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
      }
    }
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
 * 勾配 slope/10 の高さへ写す。**最高点＝層の FL**（設計上の仮定。ASSUMED）、水下（T=0）と軒の出（範囲外）が最も低い。
 * T の最大は、水下・矩形の座標の格子点と、その座標対の中点の組での評価の最大で近似する（左右対称な寄棟・切妻・片流れでは厳密。
 * 左右非対称の L 字の谷では最高点が FL から数 mm ずれうる）。
 * 水下が無い・到達時刻が作れない形（valid=false）・勾配が不正は平ら（zAt = FL）。
 * @returns {((x:number,y:number)=>number)|null} null＝平ら
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
  return (x, y) => {
    const raw = arrival.T(x, y);
    const t = raw === Infinity ? tMax : Math.min(Math.max(raw, 0), tMax); // 軒の出（範囲外 -Infinity）は水下の高さ
    return layer.floorZMm + k * (t - tMax);
  };
}

/**
 * 下屋（屋根セルを持つ階の屋根の部屋）の立体。外形は region.outline（軒の出・壁との取り合いを含む閉路）の多角形。
 * outline が複数の閉路なら閉路ごとに1件（source.part）。outline の無い region は矩形のときだけ矩形の閉路で代用し、
 * 矩形でなければ落とす。主屋根（最上階の屋根）は常に切断面より上なので立体化しない（拡張点: ここ）。
 */
function roofSolids(layer) {
  const out = [];
  for (const region of leanToPlanRegions(layer.graph)) {
    const loops = (region.outline ?? []).map(l => l.points);
    if (loops.length === 0 && region.rect) {
      const { x1, y1, x2, y2 } = region.rect;
      loops.push([x1, y1, x2, y1, x2, y2, x1, y2]);
    }
    const zAt = roofZAtOf(layer, region);
    loops.forEach((poly, part) => {
      if (poly.length < 6 || !poly.every(Number.isFinite)) return;
      let zLo = layer.floorZMm;
      if (zAt) {
        for (let i = 0; i + 1 < poly.length; i += 2) zLo = Math.min(zLo, zAt(poly[i], poly[i + 1]));
      }
      const solid = {
        kind: 'roof', footprint: { poly }, zLo, zHi: layer.floorZMm,
        source: baseSource(layer, 'roof', region.key, { part }),
      };
      if (zAt) solid.zAt = zAt;
      out.push(solid);
    });
  }
  return out;
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
 * @param {{riserOf?: (stair:object)=>number|null, belowGraphOf?: (graph:object)=>object|null, extraSolids?: Solid[]}} [opts]
 *   riserOf＝階段の蹴上（破れ先の位置）。belowGraphOf＝graph の直下階の graph（無ければ null。破れ先を穴にするかの判定）。
 * @returns {Solid[]}
 */
export function planSolids(layers, opts = {}) {
  const entries = []; // {solid, layerZ, roleRank}
  for (const layer of layers ?? []) {
    if (!layer?.graph || !Number.isFinite(layer.floorZMm)) continue;
    let cellToRoom = null;
    const lazyCellToRoom = () => (cellToRoom ??= buildCellToRoom(layer.graph));
    const solids = [floorSolidOf(layer, opts), ...wallSolids(layer, lazyCellToRoom), ...columnSolids(layer),
      ...beamSolids(layer), ...roofSolids(layer)].filter(Boolean);
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
