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
 * 床は zLo = zHi = FL の面。天井（見上げ専用）の面の縁は、セル境界（通り芯）ではなく囲む壁の面（偏芯を含む。
 * 同じ芯で接する帯は結合）で止める——規則は ceilingSolids の説明を参照。
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
import { DEFAULT_ROOM_CEILING_HEIGHT, CL_OVERLAP_TOL_MM, StairType, SoffitOrientation } from '@core';
import { beamDepthMm } from '../structural/sectionCatalog.js';
import { columnWrapSolids, wallConcealRange } from '../finish/columnWrap.js';
import { kneeDropRecordsOnAxis, kneeDropZRangesAt, ceilingTopSectionsAlongWall, uniformCeilingTopMm, SPAN_OVERLAP_EPS } from '../finish/kneeDropWall.js';
import { wallFullHeightSpans } from '../ceiling/ceilingOwners.js';
import { buildCellToRoom } from '../finish/edgeClassify.js';
import { cellBoundsList, roomBounds } from '../finish/gridCells.js';
import { uTurnPlanLayout } from '../finish/stair/stairGeometry.js';
import { arrivalBeamFaceMm, stairPartitionGeometry } from '../finish/stair/stairPartition.js';
import { floorOpeningCellRects } from '../finish/stair/slabOpening.js';
import { stairTreadFootprints } from '../finish/stair/stairTreads.js';
import { riserOf } from '../finish/stair/stairDimensions.js';
import { footprintCellKeys } from '../structural/wallGate.js';
import { stairFilterFor, matchingStairBelow } from '../structural/openingBeamAxes.js';
import { rulesFor, effectiveStructure } from '../structural/structureRules.js';
import { leanToPlanRegions } from '../structural/roofFramingRegions.js';
import { drainArrivalTime } from '../structural/roofFramingGeometry.js';
import { roofPlanRegionFigure } from '../finish/roof/roofPlanFigure.js';
import { roofSoffitJointLines } from '../finish/roof/roofSoffitJoints.js';
import { normalizeRect, isValidRect, subtractRects } from './planGeometry.js';
import { ceilingSurfacesOf } from '../ceiling/ceilingSurfaces.js';
import { ceilingShapeSolidZ, ceilingShapeMarks } from '../ceiling/ceilingShape.js';
import { stairSoffitSolids, stairSoffitFinished, stairUnderReturnSoffit } from '../ceiling/stairSoffit.js';
import { stairFootSurfaces, wallFootIntervals, wallFootTop } from '../ceiling/stairFootWallTop.js';

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

export function beamSolids(layer) {
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
 * 壁の高さの上限は区間ごと（wallCeilProfile。部屋の境の分割CLで割り、区間の両側の部屋の「床段差＋天井高」の低い方、無ければ層の天井）。ただし階段の足元の中の区間だけ
 * 階段の裏面（footSurfaces。階段の構造によらない）で頭打ちにする（wallFootSurfaces）。足元の端で区間を割る。
 * 隔て壁の斜めの天端（wallTop）は S7 まで扱わない。
 * @param {object[]} [footSurfaces] 階段の裏面の面（wallFootSurfaces）
 * @param {Map<string, number>} [underReturnTops] 復路下の壁（木造の生成壁）の壁全長の天端（壁 id → 絶対 z。underReturnWallTops）
 */
function wallSolids(layer, cellToRoom, footSurfaces = [], underReturnTops = new Map()) {
  const graph = layer.graph;
  const hasRecords = (graph.kneeDropWalls?.size ?? 0) > 0;
  const out = [];
  const meta = []; // out と同じ添字: 結合判定用 {axisId, vertical, band, along}
  const views = [];
  for (const wall of graph.walls ?? []) {
    const cr = wallConcealRange(wall);
    if (!cr || !(cr.hi - cr.lo > 0)) continue;
    const wLo0 = Math.min(wall.coord1, wall.coord2), wHi0 = Math.max(wall.coord1, wall.coord2);
    if (!(wHi0 - wLo0 > SPAN_EPS_MM)) continue;
    views.push({ wall, cr, wLo0, wHi0, vertical: !!wall.isVertical });
  }
  const uniformTop = uniformCeilingTopMm(graph); // 全部屋の天井面の高さが同じなら壁の上端は区間に割らずその値（早道）
  // 1周目: 壁レコードの範囲だけで区間と高さを決める（従来どおり）
  for (const v of views) {
    const { wall, cr, wLo0, wHi0 } = v;
    const cuts = hasRecords
      ? kneeDropRecordsOnAxis(graph, wall.axisCL, wLo0, wHi0).flatMap(r => [r.lo, r.hi])
        .filter(c => c > wLo0 + SPAN_EPS_MM && c < wHi0 - SPAN_EPS_MM)
      : [];
    const foot = footSurfaces.length > 0 && !underReturnTops.has(wall.id) ? wallFootIntervals(wall, cr, wLo0, wHi0, footSurfaces) : [];
    const footCuts = foot.flatMap(f => [f.lo, f.hi, ...(wall.isVertical ? f.surface.stepYs : f.surface.stepXs).filter(c => c > f.lo && c < f.hi)]).filter(c => c > wLo0 + SPAN_EPS_MM && c < wHi0 - SPAN_EPS_MM);
    const ceilProfile = wallCeilProfile(layer, wall, cellToRoom, uniformTop);
    const ceilCuts = ceilProfile.cuts.filter(c => c > wLo0 + SPAN_EPS_MM && c < wHi0 - SPAN_EPS_MM);
    const bounds = [...new Set([wLo0, ...cuts, ...footCuts, ...ceilCuts, wHi0])].sort((a, b) => a - b);
    const spans = []; // {lo, hi, ranges, key}
    v.spans = spans;
    // 復路下の壁（木造の生成壁）は、足元の外の端（隔て板の隙間・外周壁への食い込み）も含め壁全長を裏面で平らに止める
    // （従来どおり。この壁は足元の区間割り・区間ごとの天端の対象外＝下地の壁と薄壁が 1 立体にまとまるまま）
    const underTop = underReturnTops.get(wall.id) ?? Infinity;
    for (let i = 0; i + 1 < bounds.length; i++) {
      const lo = bounds[i], hi = bounds[i + 1];
      if (!(hi - lo > 1e-6)) continue;
      const mid = (lo + hi) / 2;
      const wallCeil = Math.min(ceilProfile.zAt(mid), underTop); // 区間ごとの上端（部屋の境で替わる。wallCeilProfile）
      const ceilZ = Math.min(wallCeil, wallFootTop(wall, cr, lo, hi, foot));
      const ranges = kneeDropZRangesAt(graph, wall, mid, layer.floorZMm, ceilZ)
        .filter(r => r.z1 > r.z0);
      // 裏面の天端は平面の補間で float の誤差が乗るので、1e-6 mm で丸めて同じ高さの隣の区間を結合する
      const key = JSON.stringify(ranges.map(r => [Math.round(r.z0 * 1e6), Math.round(r.z1 * 1e6)]));
      const prev = spans[spans.length - 1];
      if (prev && prev.key === key) prev.hi = hi;
      else spans.push({ lo, hi, ranges, key });
    }
  }
  // 2周目: 端が直交壁の帯に接する壁は、角を閉じる分だけ端の区間を延ばして立体にする
  for (const v of views) {
    const { wall, cr } = v;
    const spans = withJoinedCorners(v, views, footSurfaces.length > 0 && !underReturnTops.has(wall.id) ? footSurfaces : []);
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

const JOIN_EPS_MM = 1e-3; // 壁の端と直交壁の帯の境界を「一致」とみなす・区間の内側へ寄せる float 許容

/**
 * 壁 v の立体の区間 [lo, hi]（長さ方向）。端が直交する壁の隠せる材の帯（wallConcealRange）に接している（帯の境界に一致、
 * または帯の中にある）とき、その帯に隣接して連なる帯の連なり（下地の壁の帯と仕上げの薄壁の帯など）の向こう側の面まで端を延ばす。
 * 下地オーナー壁は取り合いで互いの面で止めてある（core/wallChamfer.js chamferWalls）ので、T 字・L 字の角の下地の体積が
 * どの壁の立体にも入らず、下階の見下げで角の 4 辺が四角として見えていた（13.stq 2階「6」の復路 22 段目の右端。2026-10-17）。
 * 展開図は同じ詰めを許容（sectionStructure.js wallSpanTolMm）で吸収する。平面の立体は延長で吸収する。
 * 相手の壁は、長さ方向の範囲が v の帯と重なる・縁で接するもの（L 字の出隅は縁で接するだけ）。壁レコードは変えず立体の区間だけ。
 * 角の区間の高さは端の区間の高さ範囲のまま（高い壁が角を貫く。低い壁の腰壁の角も高い方に合わせる）。ただし角が階段の足元に
 * かかるなら足元の規則（軸が足元の中の壁だけ）で裏面以下に止め、角を埋める相手の壁が v の帯の中央に最も近い所で立体を持たない
 * （足元の下で高さ無し等）ときは角を埋めない。
 * @param {object} v 壁の見え（wall・cr・wLo0・wHi0・vertical・1周目の spans）
 * @param {object[]} views 全壁の見え
 * @param {object[]} [footSurfaces] 階段の裏面の面（この壁が足元で止める対象のとき。復路下の壁・足元の無い層は空）
 * @returns {Array<{lo:number, hi:number, ranges:object[], key:string}>} 角を足した区間（足す角が無ければ v.spans）
 */
function withJoinedCorners(v, views, footSurfaces = []) {
  const { wall, cr, wLo0, wHi0, vertical, spans } = v;
  if (spans.length === 0) return spans;
  const perps = views.filter(p => p.vertical !== vertical && p.wLo0 <= cr.hi + JOIN_EPS_MM && p.wHi0 >= cr.lo - JOIN_EPS_MM);
  if (perps.length === 0) return spans;
  const axisMid = (cr.lo + cr.hi) / 2;
  const topOf = p => {
    const c = Math.min(p.wHi0, Math.max(p.wLo0, axisMid));
    let top = -Infinity;
    for (const s of p.spans) if (c >= s.lo - JOIN_EPS_MM && c <= s.hi + JOIN_EPS_MM) for (const r of s.ranges) top = Math.max(top, r.z1);
    return top;
  };
  // 端 e（向き dir）から、接して連なる直交壁の帯の向こう側の面まで。{t: 到達点, used: 角を埋める壁}
  const reach = (e, dir) => {
    let t = e;
    const used = new Set();
    for (let changed = true; changed;) {
      changed = false;
      for (const p of perps) {
        const [pNear, pFar] = dir > 0 ? [p.cr.lo, p.cr.hi] : [-p.cr.hi, -p.cr.lo];
        // 最初の一枚は端が帯の境界に一致・帯の中、以降は今の到達点に接して連なる帯
        if (pNear <= dir * t + JOIN_EPS_MM && pFar > dir * t + JOIN_EPS_MM) {
          t = dir * pFar;
          used.add(p);
          changed = true;
        }
      }
    }
    return { t, used };
  };
  const cornerSpan = (end, e, dir) => {
    const { t, used } = reach(e, dir);
    if (used.size === 0) return null;
    // 角が階段の足元の中にかかるなら、足元の中の区間と同じ規則（軸が足元の中の壁だけ）で裏面以下に止める
    // （角の区間の全体を 9 点で評価する。足元の端をまたぐ角は安全側＝低い方に寄せる）
    const [cLo, cHi] = [Math.min(e, t), Math.max(e, t)];
    const footCaps = wallFootIntervals(wall, cr, cLo, cHi, footSurfaces)
      .map(f => wallFootTop(wall, cr, cLo, cHi, [{ lo: cLo - 1, hi: cHi + 1, surface: f.surface }]));
    if (![...used].some(p => topOf(p) > -Infinity)) return null; // 角を埋める相手が立体にならない（足元の下で高さ無し等）なら埋めない
    const limit = Math.min(...footCaps);
    const ranges = end.ranges.map(r => ({ ...r, z1: Math.min(r.z1, limit) })).filter(r => r.z1 > r.z0);
    if (ranges.length === 0) return null;
    const key = JSON.stringify(ranges.map(r => [Math.round(r.z0 * 1e6), Math.round(r.z1 * 1e6)]));
    return { lo: Math.min(e, t), hi: Math.max(e, t), ranges, key };
  };
  const out = spans.map(s => ({ ...s }));
  const first = out[0], last = out[out.length - 1];
  const loCorner = cornerSpan(first, wLo0, -1);
  if (loCorner) {
    if (loCorner.key === first.key) first.lo = loCorner.lo;
    else out.unshift(loCorner);
  }
  const hiCorner = cornerSpan(last, wHi0, 1);
  if (hiCorner) {
    if (hiCorner.key === last.key) last.hi = hiCorner.hi;
    else out.push(hiCorner);
  }
  return out;
}

/**
 * 階段の足元の中の壁の天端＝階段の裏面（ceiling/stairSoffit.js stairUndersideSurface。構造・壁の種類によらない。dz は木造と同じ）。
 * 裏面で止めないと壁が部屋の天井まで立ち、見下げで踏面（裏面より上）より高くなって「面材が勝つ」規則（planSectionFigure.js
 * hidesAt）で隠れず、上階の床の穴ごしに下階レイヤの線として現れる（moku4-3 2階の踊り場前縁 y=−8247.5 の復路下の壁の線。
 * 13.stq 2階「6」の階段下の部屋「13」の壁。ユーザー指示 2026-10-17「木造階段同様に Z 座標でクリップ」）。固定 mm の閾値は使わない。
 * 階高は直上の層との差。直上の層が無い最上の層（見下げの自階）は層の蹴上（riserFor）×総段数で戻す（riserOf の逆算。明示の
 * stair.riser はそのまま使われる）。蹴上が決まらない・屋外階段・裏面が組めない型（L_TURN 等）は面を載せない＝従来どおり天井高。
 * 往路の基端の高さは自階の FL（自階の壁に下階の天井は無い）。
 * @param {SolidLayer} layer
 * @param {(stair:object)=>number|null} riserFor 層の蹴上
 * @param {number|undefined} upperZ 直上の層の FL（無ければ undefined）
 * @param {object|null} aboveGraph 直上の層の graph（復路の到達辺。stairTreadSolids と同じ）
 * @returns {object[]} 裏面の面（footprint.rects＋zAt）
 */
function wallFootSurfaces(layer, riserFor, upperZ, aboveGraph = null) {
  return stairFootSurfaces(layer.graph, {
    floorHeightOf: stair => {
      const riser0 = riserFor(stair);
      return upperZ !== undefined ? upperZ - layer.floorZMm
        : (Number.isFinite(riser0) ? riser0 * Math.max(1, stair.totalSteps ?? 1) : null);
    },
    floorZOf: () => layer.floorZMm,
    aboveGraph,
    treadPolysOf: (stair, riser) => treadFootprintsOf(layer, stair, riser, 'upper', aboveGraph).map(t => t.poly),
  });
}

/**
 * 復路下の壁（stairPartitionWalls.js generateStairUnderReturnWalls）の壁全長の天端を、壁 id → 絶対 z で返す（2026-10-17 の
 * 先の裁定の経路。足元の外の端まで平らに止める）。供給源は展開図（sectionProbe.js addUnderReturnTops）と同じ
 * stairUnderReturnSoffit の wallTopZ（壁の軸上・区間の中央で厚み方向 3 点の裏面の最小）。階高・蹴上は wallFootSurfaces と同じ求め方。
 * @returns {Map<string, number>}
 */
function underReturnWallTops(layer, riserFor, upperZ, aboveGraph = null) {
  const tops = new Map();
  for (const stair of layer.graph.stairs ?? []) {
    const riser = riserFor(stair);
    const floorHeight = upperZ !== undefined ? upperZ - layer.floorZMm
      : (Number.isFinite(riser) ? riser * Math.max(1, stair.totalSteps ?? 1) : null);
    if (!Number.isFinite(floorHeight) || floorHeight <= 0) continue;
    const found = stairUnderReturnSoffit(stair, layer.graph, { floorHeight, floorZMm: layer.floorZMm, aboveGraph });
    if (!found || found.wallTopZ == null) continue;
    for (const w of found.walls) tops.set(w.id, found.wallTopZ);
  }
  return tops;
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
 * 壁の上端（絶対 z）の長さ方向の分布。層が ceilZMm を持てばそれ（区間割りなし）、無ければ壁を直交する分割CLで区間に割り、
 * 区間ごとに両側の部屋の「床段差＋天井高」の低い方（kneeDropWall.effectiveCeilingTopFromFloor。ceilingSurfaces の zMm と
 * 同じ式。片側だけ部屋ならその側）、どちらも解決できなければ層の天井。
 * 複数の部屋にまたがる長い壁（外壁など）を部屋ごとの天井に合わせるため、区間ごとに決める（ユーザー裁定 2026-10-22。
 * 旧: 壁ごとに1つ）。隅の取り合いで壁端がレコード端の外へはみ出した細片が別の天井になる問題は、wallSolids が同じ高さの
 * 隣の区間を結合すること（key）で防ぐ（区間の境は部屋の境の分割CLだけなので、細片は部屋が替わる位置にしか出ない）。
 * @returns {{cuts: number[], zAt: (along:number)=>number}} cuts＝区間の境（壁の座標）、zAt＝壁の座標の点の上端
 */
function wallCeilProfile(layer, wall, cellToRoom, uniformTop = null) {
  if (Number.isFinite(layer.ceilZMm)) return { cuts: [], zAt: () => layer.ceilZMm };
  const fallback = layerCeilZ(layer);
  const secs = ceilingTopSectionsAlongWall(layer.graph, wall, Number.isFinite(uniformTop) ? null : cellToRoom(), { uniformTop });
  if (secs.length === 0) return { cuts: [], zAt: () => fallback };
  const zOf = s => (s.top != null ? layer.floorZMm + s.top : fallback);
  return {
    cuts: secs.slice(0, -1).map(s => s.hi),
    zAt: (along) => zOf(secs.find(s => along <= s.hi) ?? secs[secs.length - 1]),
  };
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
  let holeRects = floorOpeningCellRects(graph, {
    riserOf: opts.riserOf ?? (() => null), stairFilter: stairFilterFor(graph, below),
    stairExtent: opts.lookUp === true ? 'full' : 'beyond', // 見上げは続きの階段の足元全体が穴（階段の裏が見える。S13a）
  });
  if (opts.lookUp !== true && below) holeRects = narrowStairVoidHoles(holeRects, graph, below); // 見上げは足元全体のまま（S13a）
  const holes = holeRects.map(({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 }));
  return {
    kind: 'floor', footprint: { rects, holes }, zLo: layer.floorZMm, zHi: layer.floorZMm,
    source: baseSource(layer, 'floor', graph.plane?.id ?? `z${layer.floorZMm}`),
  };
}

/**
 * 見下げの床の穴（階段吹抜け stairVoid・続きの階段の破れ先 stairBeyond）の基端側を、下階の木造 U 字階段の到達辺の面まで狭める（床の立体だけの話）。
 * N+1 の床は上階の床梁の外面＋壁仕上げ（面＝uTurnPlanLayout の run.baseB）まであり、復路の上では更に段鼻（蹴込 stair.nosing）が
 * 張り出すので、梁は床の下に隠れて見えない。往路側（across の s0〜sB。隔て壁の帯を含む）＝面、復路側（sB〜s1）＝面＋蹴込。
 * セルが両側にまたがるときは across.sB で 2 つに割る。対象は到達辺が梁の面に採られた階段（arrivalAtFace かつ梁が見つかった）だけ。
 * 供給源は uTurnPlanLayout（stair-model.md）。floorOpeningCellRects／floorOpeningEdges／slabOpeningRects は変えない。
 */
function narrowStairVoidHoles(holes, graph, below) {
  const EPS = 1;
  let out = holes;
  for (const stair of below.stairs ?? []) {
    if (stair.type !== StairType.SWITCHBACK && stair.type !== StairType.WINDING) continue;
    if (arrivalBeamFaceMm(stair, below, graph) == null) continue;
    const L = uTurnPlanLayout(stair, below, { aboveGraph: graph });
    if (!L?.arrivalAtFace) continue;
    const g = stairPartitionGeometry(stair, below);
    const bd = roomBounds(stair.cells, below);
    if (!g || ![bd.x1, bd.y1, bd.x2, bd.y2].every(Number.isFinite)) continue;
    // 入口柱の通り芯（到達辺を受ける梁の通り芯）。復路の基端は必ずここにある。往路は等長レーンのときだけここに基端がある
    const entryAlong = L.vertical ? g.entryEnd.y : g.entryEnd.x;
    const dir = Math.sign(L.run.back - L.run.baseB) || 1; // 基端から回転部へ向かう向き
    // 続きの階段の破れ先（stairBeyond）は、N+1 の階段が下階のこの階段と足元が一致するときだけ対象
    const continued = (graph.stairs ?? []).some(s => matchingStairBelow(s, graph, below) === stair);
    const nosing = stair.nosing ?? 0;
    const { s0, sB } = L.across;
    const aSign = Math.sign(sB - s0) || 1; // 往路側（s0 側）の幅方向の向き
    const next = [];
    for (const h of out) {
      const inside = (h.source === 'stairVoid' || (h.source === 'stairBeyond' && continued))
        && h.x1 >= bd.x1 - EPS && h.x2 <= bd.x2 + EPS && h.y1 >= bd.y1 - EPS && h.y2 <= bd.y2 + EPS;
      const [r0, r1] = L.vertical ? [h.y1, h.y2] : [h.x1, h.x2]; // 走行方向の範囲
      // 基端側の辺が入口柱の通り芯に乗り、矩形がその通り芯から階段側（回転部側）にあるものだけ
      if (!inside || Math.abs((dir < 0 ? r1 : r0) - entryAlong) > EPS) { next.push(h); continue; }
      const [a0, a1] = L.vertical ? [h.x1, h.x2] : [h.y1, h.y2]; // 幅方向の範囲
      const aSide = aSign > 0 ? [a0, Math.min(a1, sB)] : [Math.max(a0, sB), a1];
      const bSide = aSign > 0 ? [Math.max(a0, sB), a1] : [a0, Math.min(a1, sB)];
      // 往路側を面に狭めるのは等長レーン（両基端が入口柱）のときだけ。張り出しでは往路は通り芯をまたいで続く（途中に床の帯を作らない）
      const pieces = [[bSide, L.run.baseB + dir * nosing, true], [aSide, L.run.baseB, L.columnBases]];
      for (const [[p0, p1], edge, narrow] of pieces) {
        if (p1 - p0 <= EPS) continue;
        const [n0, n1] = !narrow ? [r0, r1] : dir < 0 ? [r0, Math.min(r1, edge)] : [Math.max(r0, edge), r1];
        if (n1 - n0 <= EPS) continue;
        next.push(L.vertical ? { ...h, x1: p0, x2: p1, y1: n0, y2: n1 } : { ...h, y1: p0, y2: p1, x1: n0, x2: n1 });
      }
    }
    out = next;
  }
  return out;
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
 * outline の無い region は矩形のときだけ矩形の閉路で代用し、矩形でなければ落とす。主屋根（最上階の屋根）は見下げでは常に切断面より
 * 上なので立体化しない（見上げの軒裏だけ opts.topRoof で足す。下記）。
 * 見上げ（opts.lookUp）の上階の層（layer.role==='above'）だけ軒裏の表現にする: 線は外形線＋（軒裏の向きが傾斜〔region.soffitOrientation
 * ==='sloped'〕のときだけ）棟木・隅木・谷木＋910割付線（roofSoffitJointLines。詳細 LOD のみ・グレー）で、傾斜ラベル（marks）は付けない。
 * 見上げの自階の層で opts.topRoof（最上階の主屋根・屋根区画の region と軒の高さ。planSolidsLayerSolidsUp が最上階だけ渡す）が
 * あるときは、その region も同じ軒裏の表現で足す（zLo＝軒の高さ＝最上階の階高。source.layerFloorZ もその高さ〔> 0〕にするので、
 * 見上げの「上階の層」の描画・軒先の中線・グレーの割付線の規則がそのまま効き、自階の層の下屋〔見上げでは描かない〕と見分けられる。
 * source.topRoof:true は識別用の印）。自階の天井立体が建物の内側を遮るので、見えるのは外壁の外の軒だけ。
 * それ以外（見下げ・見上げの自階の層の下屋）は従来のまま。
 */
function roofSolids(layer, opts = {}) {
  const lookUp = opts.lookUp === true;
  const out = regionRoofSolids(layer, leanToPlanRegions(layer.graph), lookUp && layer.role === 'above', {});
  if (lookUp && layer.role === 'self' && opts.topRoof?.regions?.length > 0 && Number.isFinite(opts.topRoof.eaveZMm)) {
    const topLayer = { ...layer, floorZMm: opts.topRoof.eaveZMm };
    out.push(...regionRoofSolids(topLayer, opts.topRoof.regions, true, { topRoof: true }));
  }
  return out;
}

/** roofSolids の本体: region ごとの立体。extraSource は立体の source へ足す印（最上階の屋根は topRoof:true）。 */
function regionRoofSolids(layer, regions, soffitView, extraSource) {
  const out = [];
  for (const region of regions) {
    const loops = (region.outline ?? []).map(l => l.points);
    if (loops.length === 0 && region.rect) {
      const { x1, y1, x2, y2 } = region.rect;
      loops.push([x1, y1, x2, y1, x2, y2, x1, y2]);
    }
    const slope = roofZAtOf(layer, region);
    const figure = roofPlanRegionFigure(region);
    const figureLines = soffitView
      ? figure.lines.filter(l => l.role === 'outline' || region.soffitOrientation === SoffitOrientation.SLOPED)
      : figure.lines;
    const innerLines = figureLines.map(l => ({ role: l.role, points: innerLinePoints(l) }));
    if (soffitView) for (const l of roofSoffitJointLines(region)) innerLines.push({ role: l.role, points: l.points });
    const marks = soffitView ? [] : figure.labels.map(l => ({ anchor: l.anchor, prims: l.prims })); // 解決器が weight・cls・detailOnly を付ける
    let first = true;
    loops.forEach((poly, part) => {
      if (poly.length < 6 || !poly.every(Number.isFinite)) return;
      const solid = {
        kind: 'roof', footprint: { poly }, zLo: layer.floorZMm, zHi: slope ? slope.zTop : layer.floorZMm, drawEdges: false,
        source: baseSource(layer, 'roof', region.key, { part, ...extraSource }),
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

// 層の中で同じ階段・蹴上・見え方の段の占有形は1回だけ求める（stairTreadSolids と wallFootSurfaces が共有。出力不変）
// planSolids の呼び出しごとに作り直す（graph の変更・直上の graph の違いを呼び出しをまたいで持ち越さない）
let treadFootprintCache = new WeakMap(); // layer → Map<stair, Map<キー, 段の占有形>>
function treadFootprintsOf(layer, stair, riser, insetView, aboveGraph) {
  let byStair = treadFootprintCache.get(layer);
  if (!byStair) treadFootprintCache.set(layer, byStair = new Map());
  let byKey = byStair.get(stair);
  if (!byKey) byStair.set(stair, byKey = new Map());
  const key = `${insetView}|${riser}`;
  if (!byKey.has(key)) byKey.set(key, stairTreadFootprints(stair, layer.graph, { riser, insetView, aboveGraph }));
  return byKey.get(key);
}

const polyArea2 = p => p.reduce((s, _, i) => (i % 2 ? s : s + p[i] * p[(i + 3) % p.length] - p[(i + 2) % p.length] * p[i + 1]), 0);

/**
 * 階段の段（マス）の立体。**遮蔽専用**（drawEdges:false。階段の線を描くのは StairLayer だけ）。段 n の天端は
 * 層の FL + n × 蹴上、厚みは 0（zLo = zHi。段板の厚みは使わない＝限界）。蹴上が求まらない階段は立体にしない（遮蔽しない）。
 * 多角形はマスごとに1件（source.id＝階段 id・source.part＝段数字と同じ番号）。不正な多角形（6 要素未満・非有限・面積 0）は捨てる。
 * @param {SolidLayer} layer
 * @param {(stair:object)=>number|null} riserFor 階段の蹴上（層ごとに決める。planSolids の riserForLayer）
 * @param {Set<object>} [drawnStairs] 段の輪郭を描く階段（見上げの鉄骨の続き階段＝踏面線を全段描く。省略は全階段が遮蔽専用）
 * @param {Set<object>} [skipStairs] 立体にしない階段（見上げの自階の続き階段。stairsContinuedAbove）
 * @param {object|null} [aboveGraph] この層の直上の層の graph（復路の到達辺＝上階の床梁の外面＋仕上げ。無ければ Q3）
 */
function stairTreadSolids(layer, riserFor, drawnStairs = null, skipStairs = null, aboveGraph = null) {
  const out = [];
  const insetView = layer.role === 'self' ? 'install' : 'upper'; // 自階は設置階の逃がし（StairLayer の beyondBuilt と同じ）、下階は見下げ
  for (const stair of layer.graph.stairs ?? []) {
    if (skipStairs?.has(stair)) continue;
    for (const t of treadFootprintsOf(layer, stair, riserFor(stair), insetView, aboveGraph)) {
      const p = t.poly;
      if (p.length < 6 || p.length % 2 !== 0 || !p.every(Number.isFinite) || Math.abs(polyArea2(p)) < 1e-6) continue;
      const z = layer.floorZMm + t.topZ;
      out.push({
        kind: 'stairTread', footprint: { poly: p }, zLo: z, zHi: z, drawEdges: drawnStairs?.has(stair) === true,
        source: baseSource(layer, 'stairTread', stair.id, { part: t.number }),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 階段上の裏面（見上げ）

/**
 * 見上げ（opts.lookUp）の上階の層で、**下階（自階）に同じ足元の階段がある**階段の扱いを決める（S13a）。
 * 木造は踏面線を描かず階段裏の傾斜天井（stairSoffitSolids）を足す。鉄骨は踏面線を全段描く（stairTread の輪郭を有効にする）。
 * @returns {{soffits: Solid[], drawnTreads: Set<object>}}
 */
function stairUndersideOf(layer, riserFor, belowGraph, aboveGraph = null) {
  const soffits = [], drawnTreads = new Set();
  if (!belowGraph) return { soffits, drawnTreads };
  for (const stair of layer.graph.stairs ?? []) {
    const belowStair = matchingStairBelow(stair, layer.graph, belowGraph);
    if (!belowStair) continue;
    if (stairSoffitFinished(stair)) {
      // aboveGraph＝この層の直上の graph（層スタックに無ければ opts.aboveGraphOf の N+2。無ければ到達辺は Q3）
      soffits.push(...stairSoffitSolids({ stair, graph: layer.graph, belowStair, belowGraph, riser: riserFor(stair), floorZMm: layer.floorZMm, aboveGraph }));
    } else drawnTreads.add(stair);
  }
  return { soffits, drawnTreads };
}

/**
 * 見上げ（opts.lookUp）の自階の層で、上階の層の階段と足元が一致する自階の階段（＝続きのある階段）。
 * 判定は stairUndersideOf・床の穴（stairFilterFor）と同じ述語（matchingStairBelow）で、対象の上階の層も同じ入力
 * （opts.belowGraphOf(上階の graph) が自階の graph のとき）に揃える＝穴・裏面・段の除外が食い違わない。上階の層が無い・belowGraphOf が無ければ空。
 * 見上げは「N の天井面際から N+1 の床を裏から見る」ので、自階の続き階段の段は遮蔽に入れない（裁定 2026-10-11）。
 */
function stairsContinuedAbove(selfLayer, layers, opts) {
  const out = new Set();
  for (const above of layers) {
    if (above?.role !== 'above' || !above.graph) continue;
    if (opts.belowGraphOf?.(above.graph) !== selfLayer.graph) continue;
    for (const stair of above.graph.stairs ?? []) {
      const own = matchingStairBelow(stair, above.graph, selfLayer.graph);
      if (own) out.add(own);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 天井

const BAND_JOIN_EPS_MM = 0.01; // 同じ芯の帯が接するとみなす許容
const BAND_EDGE_GAP_MIN_MM = 1e-6; // 帯の面と縁のすき間がこれを超えるときだけ止める
const BAND_EDGE_GAP_MAX_MM = SPAN_OVERLAP_EPS; // 縁と帯の面のすき間の上限（ceilingOwners.js が「壁の無いすき間の上限」として共用するのと同じ値）

/**
 * 層の壁の帯（wallConcealRange の across × 壁の along）。壁は全高の区間（腰壁だけの区間を除く。ceilingOwners.js wallFullHeightSpans。
 * 腰壁は天井を隔てない）ごとに 1 件。同じ芯（axisCL.id）・同じ向きで across が接する／重なり、かつ along も接する／重なる帯は 1 本に結合する
 * （下地オーナー壁＋仕上げの薄壁が別レコードのため）。結合は along を全帯の端点で区間に割り、区間ごとに across の和を取る
 * （along が離れた帯・端で接するだけの帯は外接矩形にしない）。隣り合う区間で across が同じなら along を結合する。
 * conceal range が無い・座標が非有限の壁は無視。
 * fullHeightOnly=false（S3 の穴の縁。腰壁こそ穴の縁の張り出し）は腰壁だけの区間も帯にする（壁の全長が 1 区間。結合の規則は同じ）。
 * @param {object} graph
 * @param {{fullHeightOnly?: boolean}} [opts]
 * @returns {Array<{vertical:boolean, lo:number, hi:number, a0:number, a1:number}>}
 */
function wallBandsOf(graph, { fullHeightOnly = true } = {}) {
  const groups = new Map();
  let anon = 0;
  for (const wall of graph.walls ?? []) {
    const cr = wallConcealRange(wall);
    if (!cr || !(cr.hi - cr.lo > 0) || ![cr.lo, cr.hi, wall.coord1, wall.coord2].every(Number.isFinite)) continue;
    const vertical = !!wall.isVertical;
    const key = `${vertical}:${wall.axisCL?.id ?? `#${anon++}`}`;
    if (!groups.has(key)) groups.set(key, []);
    const whole = Math.max(wall.coord1, wall.coord2) - Math.min(wall.coord1, wall.coord2) > 1e-6
      ? [[Math.min(wall.coord1, wall.coord2), Math.max(wall.coord1, wall.coord2)]] : [];
    for (const [a0, a1] of fullHeightOnly ? wallFullHeightSpans(graph, wall) : whole) groups.get(key).push({ vertical, lo: cr.lo, hi: cr.hi, a0, a1 });
  }
  const out = [];
  const eps = BAND_JOIN_EPS_MM;
  for (const list of groups.values()) {
    // along を全帯の端点で区間に割り、区間ごとに across が接する／重なる帯の across を和にして 1 帯にする
    // （端で接するだけの帯どうしや、along が離れた帯を、外接矩形でまとめない）
    const cuts = [...new Set(list.flatMap(b => [b.a0, b.a1]))].sort((p, q) => p - q);
    const made = []; // along 昇順
    for (let k = 0; k + 1 < cuts.length; k++) {
      const p = cuts[k], q = cuts[k + 1];
      if (!(q - p > BAND_EDGE_GAP_MIN_MM)) continue;
      const covering = list.filter(b => b.a0 <= p + eps && b.a1 >= q - eps).sort((s, t) => s.lo - t.lo || s.hi - t.hi);
      let cur = null;
      for (const b of covering) {
        if (cur && b.lo <= cur.hi + eps) cur.hi = Math.max(cur.hi, b.hi);
        else { if (cur) made.push(cur); cur = { vertical: b.vertical, lo: b.lo, hi: b.hi, a0: p, a1: q }; }
      }
      if (cur) made.push(cur);
    }
    // 隣り合う区間で across が同じ帯は along を結合して 1 本に戻す
    const joined = [];
    for (const m of made) {
      const prev = joined.find(o => Math.abs(o.lo - m.lo) <= eps && Math.abs(o.hi - m.hi) <= eps && Math.abs(o.a1 - m.a0) <= eps);
      if (prev) prev.a1 = m.a1;
      else joined.push(m);
    }
    out.push(...joined);
  }
  return out;
}

/**
 * 矩形ごとに、壁の帯で止める帯状の矩形（縁と帯の面の間）を求める。帯が矩形の across 範囲の内側に収まり、縁に寄っている
 * （縁との間が 0 超〜SPAN_OVERLAP_EPS 以下）ときだけ。縁をまたぐ帯（芯振り分けの壁）は対象外。両縁が同時に条件を満たす（帯が
 * 矩形の中にあり両側とも近い）ときは両側とも対象（両側を削る）。
 */
function wallBandStrips(rects, bands) {
  const strips = [];
  for (const r of rects) {
    for (const b of bands) {
      const [c1, c2, a1, a2] = b.vertical ? [r.x1, r.x2, r.y1, r.y2] : [r.y1, r.y2, r.x1, r.x2];
      const lo = Math.max(b.a0, a1), hi = Math.min(b.a1, a2);
      if (!(hi - lo > BAND_EDGE_GAP_MIN_MM)) continue;
      if (b.lo < c1 - BAND_JOIN_EPS_MM || b.hi > c2 + BAND_JOIN_EPS_MM) continue;
      const mk = (u0, u1) => (b.vertical ? { x1: u0, x2: u1, y1: lo, y2: hi } : { x1: lo, x2: hi, y1: u0, y2: u1 });
      const gapHi = c2 - b.hi, gapLo = b.lo - c1;
      if (gapHi > BAND_EDGE_GAP_MIN_MM && gapHi <= BAND_EDGE_GAP_MAX_MM) strips.push(mk(b.hi, c2));
      if (gapLo > BAND_EDGE_GAP_MIN_MM && gapLo <= BAND_EDGE_GAP_MAX_MM) strips.push(mk(c1, b.lo));
    }
  }
  return strips;
}

/**
 * 天井の立体（見上げ＝天伏モード専用。`opts.ceilings === true` のときだけ、自階の層に足す）。
 * 部屋ごとに1件（セル矩形の和）、面材（解決器の SURFACE_KINDS）で厚み 0（zLo = zHi = 層の FL + 天井面の高さ zMm。床段差込み）。
 * 輪郭は既定どおり描く。部屋ごとに別立体のため、同じ高さで隣り合う部屋も壁の無い境界では見切り線が出る
 * （同じ立体の矩形群の共有辺だけが消える）。裁定 2026-10-10: 細線グレー（ceiling/ceilingBoundaryStyle.js の後処理）。
 * 算出は ceiling/ceilingSurfaces.js。
 * 縁の規則（S1）: セル境界（通り芯）は図面に現れない。天井面の縁は、それを囲む壁の面（偏芯を含む）。壁の帯（同じ芯の接する帯は結合）が
 * セル矩形の縁に寄って内側に収まる（縁との間が SPAN_OVERLAP_EPS=150 以下）とき、縁と帯の面の間を面から除く。腰壁だけの区間は
 * 帯にしない。縁をまたぐ壁は従来どおり切断の壁が隠す。削るだけ: 向こう側の天井面はセル境界のまま（既知の限界。壁の面まで広げるかは裁定待ち）。
 * 規則 V: N の天井の穴＝N+1 の床の穴（void・shaft）。直上階の吹抜け・昇降路の矩形を面から除く（帯での削りの後）。
 * 階段吹抜け（stairVoid）・破れ先は除かない（階段下部屋の天井は残る）。直上階が無ければ従来どおり。
 * @param {SolidLayer} layer
 * @param {object|null} [upperGraph] 直上の層の graph
 */
function ceilingSolids(layer, upperGraph = null) {
  const holes = upperGraph
    ? floorOpeningCellRects(upperGraph, { stairFilter: () => false, sources: ['void', 'shaft'] }).map(({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 }))
    : [];
  const bands = wallBandsOf(layer.graph);
  const bandRects = bands.map(b => (b.vertical ? { x1: b.lo, x2: b.hi, y1: b.a0, y2: b.a1 } : { x1: b.a0, x2: b.a1, y1: b.lo, y2: b.hi }));
  return ceilingSurfacesOf(layer.graph).map(({ roomId, zoneId, rects, zMm, shape, dims, chMm }) => {
    // 天井面の縁は、セル境界（通り芯）ではなくそれを囲む壁の面。偏芯した壁で縁の外側に残るすき間を削る（削るだけ）。
    // zAt は元の矩形基準のまま（基準を動かさなければ削った面の内側で z は連続する）。marks は削った面（trimmed）の
    // largestRect の中心に置く（面の外へ出ない）
    // 削る帯状の矩形から壁の帯（縦横とも）の和を除く: 壁の下は壁が隠すので削らない（角の取り合いで、直交壁の帯の中に切欠きを作らない）
    const strips = bands.length > 0 ? subtractRects(wallBandStrips(rects, bands), bandRects) : [];
    const stripped = strips.length > 0 ? subtractRects(rects, strips) : rects;
    const trimmed = holes.length > 0 ? subtractRects(stripped, holes) : stripped; // 規則 V
    if (trimmed.length === 0) return null;
    // 区画（S5）の面は `${roomId}#${zoneId}`、残り（部屋の CH）は roomId のまま（区画の無い文書の key・順序は不変）
    const id = zoneId ? `${roomId}#${zoneId}` : roomId;
    // 形状（S6a）: 傾斜は下屋と同じく zAt（勾配）を付ける。基準高の絶対 z＝層の FL＋床段差込みの zMm。平面は zAt なし・厚み 0 のまま
    const { zLo, zHi, zAt } = ceilingShapeSolidZ({ shape, dims, baseZ: layer.floorZMm + zMm, rects });
    const solid = { kind: 'ceiling', footprint: { rects: trimmed }, zLo, zHi, source: baseSource(layer, 'ceiling', id) };
    if (zAt) solid.zAt = zAt;
    const marks = ceilingShapeMarks({ key: id, shape, dims, chMm, rects: trimmed });
    if (marks.length > 0) solid.marks = marks;
    return solid;
  });
}

// ---------------------------------------------------------------- 上階の穴の縁（見上げ・S3）

const OVERHANG_TOUCH_MM = 0.5; // 張り出しが穴の縁・天井面の縁に「接する」とみなす許容
const GEO_EPS = 1e-6;
// eps が要る理由: 縁の座標は float 演算で作るため、縁に乗る点（探索の中点）を内側と誤判定しないよう、縁から eps 以内は内側に含めない
const strictlyIn = (r, x, y) => x > r.x1 + GEO_EPS && x < r.x2 - GEO_EPS && y > r.y1 + GEO_EPS && y < r.y2 - GEO_EPS;
const rectArea = r => (r.x2 - r.x1) * (r.y2 - r.y1);
const bandRectOf = b => (b.vertical ? { x1: b.lo, x2: b.hi, y1: b.a0, y2: b.a1 } : { x1: b.a0, x2: b.a1, y1: b.lo, y2: b.hi });
const intersectRects = (a, b) => ({ x1: Math.max(a.x1, b.x1), x2: Math.min(a.x2, b.x2), y1: Math.max(a.y1, b.y1), y2: Math.min(a.y2, b.y2) });
const hasArea = r => r.x2 - r.x1 > GEO_EPS && r.y2 - r.y1 > GEO_EPS;

/**
 * 上階の床の穴の縁に乗る壁の張り出し（帯と穴の交わり）。帯が穴の和の中に収まる壁は無視（穴の中の壁は縁ではない）。
 * 端は SPAN_OVERLAP_EPS 以内のすき間を閉じる: 端の先が「穴の和の中」かつ「自階の天井面の下でない」かつ「どの帯の中でもない」間、
 * それが切れる所（穴・天井面・帯の縁のうち最も近いもの）まで延ばす。延ばす長さが上限を超えるなら延ばさない。解析的（縁の座標を順に調べる）。
 * @returns {Array<{rect: object, vertical: boolean}>}
 */
function openingOverhangStrips(holes, bands, faceRects) {
  const bandRects = bands.map(bandRectOf);
  const strips = [];
  bands.forEach((b, i) => {
    const br = bandRects[i];
    const pieces = holes.map(h => intersectRects(br, h)).filter(hasArea);
    if (pieces.length === 0) return;
    // 帯が穴の和に収まる（重なる穴でも二重に数えないよう、帯から穴を引いた残りの面積で見る）
    if (subtractRects([br], holes).reduce((s, p) => s + rectArea(p), 0) <= 1e-3) return;
    for (const rect of pieces) strips.push({ rect, vertical: b.vertical });
  });
  const all = [...holes, ...faceRects, ...bandRects];
  const extend = (s, dir) => {
    const { rect, vertical } = s;
    const e = vertical ? (dir > 0 ? rect.y2 : rect.y1) : (dir > 0 ? rect.x2 : rect.x1);
    const c = vertical ? (rect.x1 + rect.x2) / 2 : (rect.y1 + rect.y2) / 2;
    const at = t => (vertical ? [c, t] : [t, c]);
    const free = t => {
      const [x, y] = at(t);
      return holes.some(r => strictlyIn(r, x, y)) && !faceRects.some(r => strictlyIn(r, x, y)) && !bandRects.some(r => strictlyIn(r, x, y));
    };
    const cands = [...new Set(all.flatMap(r => {
      const [c0, c1, a0, a1] = vertical ? [r.x1, r.x2, r.y1, r.y2] : [r.y1, r.y2, r.x1, r.x2];
      return c > c0 + GEO_EPS && c < c1 - GEO_EPS ? [a0, a1] : [];
    }))].filter(t => dir * (t - e) > GEO_EPS).sort((p, q) => dir * (p - q));
    let prev = e;
    for (const t of cands) {
      if (!free((prev + t) / 2)) break;
      prev = t;
    }
    const len = dir * (prev - e);
    return len > GEO_EPS && len <= SPAN_OVERLAP_EPS ? prev : e;
  };
  return strips.map(s => {
    const lo = extend(s, -1), hi = extend(s, 1);
    const r = s.rect;
    return { ...s, rect: s.vertical ? { ...r, y1: lo, y2: hi } : { ...r, x1: lo, x2: hi } };
  });
}

/**
 * 見上げの上階スラブの穴を壁の張り出し（openingOverhangStrips）で狭め、張り出しの面まで自階の天井面を延ばす（S3）。
 * 原則: セル境界（通り芯）は図面に現れない。穴の縁は、それを囲む壁の面。天井面の延長は、strip が接する穴の縁の外側に
 * 縁の座標（±0.5mm）で接し along が重なる面の矩形ごとに、重なり分の帯状矩形を足す（面内・面どうしの重なりは作らない。穴の縁の 1 段だけ）。
 * @param {Solid} upperFloor floorSolidOf(上階の層, opts)
 * @param {object} upperGraph
 * @param {Solid[]} ceilings 自階の天井の立体（S1・S2 まで）
 * @returns {{floor: Solid, ceilings: Solid[]}}
 */
export function narrowOpeningByWalls(upperFloor, upperGraph, ceilings) {
  const holes = upperFloor?.footprint?.holes ?? [];
  if (holes.length === 0) return { floor: upperFloor, ceilings };
  const bands = wallBandsOf(upperGraph, { fullHeightOnly: false });
  if (bands.length === 0) return { floor: upperFloor, ceilings };
  const faceRects = ceilings.flatMap(c => c.footprint.rects);
  const strips = openingOverhangStrips(holes, bands, faceRects);
  if (strips.length === 0) return { floor: upperFloor, ceilings };
  const narrowed = subtractRects(holes, strips.map(s => s.rect));
  const floor = { ...upperFloor, footprint: narrowed.length > 0 ? { ...upperFloor.footprint, holes: narrowed } : { rects: upperFloor.footprint.rects } };
  const added = ceilings.map(() => []);
  const addedAll = [];
  const near = (a, b) => Math.abs(a - b) <= OVERHANG_TOUCH_MM;
  for (const { rect: s, vertical } of strips) {
    for (const h of holes) {
      if (!hasArea(intersectRects(s, h))) continue;
      // strip が接する穴の縁（厚み方向の縁だけ）と、その外側に接する面の矩形
      const edges = vertical
        ? [[near(s.x1, h.x1), r => near(r.x2, h.x1)], [near(s.x2, h.x2), r => near(r.x1, h.x2)]]
        : [[near(s.y1, h.y1), r => near(r.y2, h.y1)], [near(s.y2, h.y2), r => near(r.y1, h.y2)]];
      for (const [touches, abuts] of edges) {
        if (!touches) continue;
        ceilings.forEach((ceil, fi) => {
          for (const r of ceil.footprint.rects) {
            if (!abuts(r)) continue;
            const piece = vertical
              ? { x1: s.x1, x2: s.x2, y1: Math.max(s.y1, r.y1, h.y1), y2: Math.min(s.y2, r.y2, h.y2) }
              : { x1: Math.max(s.x1, r.x1, h.x1), x2: Math.min(s.x2, r.x2, h.x2), y1: s.y1, y2: s.y2 };
            if (!hasArea(piece)) continue;
            const fresh = subtractRects(subtractRects([piece], [...ceil.footprint.rects, ...added[fi]]), addedAll);
            added[fi].push(...fresh);
            addedAll.push(...fresh);
          }
        });
      }
    }
  }
  return {
    floor,
    ceilings: ceilings.map((c, fi) => (added[fi].length > 0 ? { ...c, footprint: { rects: [...c.footprint.rects, ...added[fi]] } } : c)),
  };
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
 * @param {{riserOf?: (stair:object)=>number|null, belowGraphOf?: (graph:object)=>object|null, aboveGraphOf?: (graph:object)=>object|null, extraSolids?: Solid[], ceilings?: boolean, lookUp?: boolean}} [opts]
 *   aboveGraphOf＝層スタックに直上の層が無い層の「直上階」の graph（belowGraphOf の鏡像。見上げの最上の層＝N+1 の N+2。無ければ null＝到達辺は Q3）。直上の層があればそちらが優先。
 *   ceilings＝true のときだけ self の層に天井立体（kind 'ceiling'。見上げ用）を足す。省略（見下げ）の出力は不変。
 *   規則 V: 直上階の void・shaft の穴を天井面から引く。
 *   上階の層の梁は立体にしない（裁定 2026-10-18）。
 *   S3: 上階の床の穴は、穴の縁に乗る上階の壁の張り出し（腰壁含む）の面まで狭め（縁は壁の面）、自階の天井面はその面まで延ばす
 *   （narrowOpeningByWalls。見下げは触らない）。
 *   lookUp＝true は見上げ（天伏。planSolidsLayerSolidsUp だけが渡す）: 上階スラブの続きの階段の穴を足元全体にし（floorSolidOf）、
 *   上階の層の「下階に同じ足元の階段がある」階段について、木造は階段裏の傾斜天井（source.kind 'stairSoffit'）を足し、鉄骨は段の輪郭を描く（stairUndersideOf）。自階の続き階段の段は遮蔽に入れない（stairsContinuedAbove）。
 *   riserOf＝最上の層の階段の蹴上（破れ先の位置・段の高さ）。下の層の階段は直上の層との階高から求める（stairTreadSolids）。belowGraphOf＝graph の直下階の graph（無ければ null。破れ先を穴にするかの判定）。
 * @returns {Solid[]}
 */
export function planSolids(layers, opts = {}) {
  treadFootprintCache = new WeakMap();
  const entries = []; // {solid, layerZ, roleRank}
  const floorZs = (layers ?? []).filter(l => l?.graph && Number.isFinite(l.floorZMm)).map(l => l.floorZMm).sort((a, b) => a - b);
  // 見上げ（S3）: 自階の天井面と上階の床の穴は互いを要する（すき間閉じ・天井面の延長）ので、自階の層の側で先に求める
  const ceilingsOf = new Map(), floorOverride = new Map(); // 自階の層 → 天井の立体、上階の層 → 穴を狭めた床
  if (opts.lookUp === true) {
    for (const layer of layers ?? []) {
      if (!layer?.graph || !Number.isFinite(layer.floorZMm) || layer.role !== 'self') continue;
      const upZ = floorZs.find(z => z > layer.floorZMm);
      const upperLayer = upZ !== undefined ? layers.find(l => l?.graph && l.floorZMm === upZ) : null;
      if (upperLayer?.role !== 'above') continue;
      const ceilings = opts.ceilings === true ? ceilingSolids(layer, upperLayer.graph).filter(Boolean) : [];
      const upperFloor = floorSolidOf(upperLayer, opts);
      if (!upperFloor) continue;
      const narrowed = narrowOpeningByWalls(upperFloor, upperLayer.graph, ceilings);
      floorOverride.set(upperLayer, narrowed.floor);
      if (opts.ceilings === true) ceilingsOf.set(layer, narrowed.ceilings);
    }
  }
  for (const layer of layers ?? []) {
    if (!layer?.graph || !Number.isFinite(layer.floorZMm)) continue;
    let cellToRoom = null;
    const lazyCellToRoom = () => (cellToRoom ??= buildCellToRoom(layer.graph));
    // 階段の蹴上は層ごとに1本: 直上の層があればその階高（直上の FL − この層の FL）から、無ければ（最上の層＝自階）opts.riserOf。
    // 明示指定（stair.riser）は riserOf が優先する。下階の層に自階の riserOf を使うと階高の違う階で段の高さがずれる
    const upperZ = floorZs.find(z => z > layer.floorZMm);
    // 直上の層の graph。層スタックに直上が無ければ opts.aboveGraphOf（belowGraphOf の鏡像。見上げの N+1 の層の N+2）
    const upperGraph = upperZ !== undefined ? layers.find(l => l?.graph && l.floorZMm === upperZ)?.graph ?? null : opts.aboveGraphOf?.(layer.graph) ?? null;
    const riserForLayer = upperZ !== undefined
      ? stair => riserOf(stair, upperZ - layer.floorZMm)
      : stair => opts.riserOf?.(stair) ?? null;
    const underside = opts.lookUp === true && layer.role === 'above'
      ? stairUndersideOf(layer, riserForLayer, opts.belowGraphOf?.(layer.graph) ?? null, upperGraph) : null;
    const solids = [floorOverride.get(layer) ?? floorSolidOf(layer, opts), ...wallSolids(layer, lazyCellToRoom, wallFootSurfaces(layer, riserForLayer, upperZ, upperGraph), underReturnWallTops(layer, riserForLayer, upperZ, upperGraph)), ...columnSolids(layer),
      // 梁は天井より上にある（ユーザー裁定 2026-10-18）。上階の梁は上階 FL の下に 200 ほど垂れ、吹抜けの中では
      // 1 階の天井より上に見えるが、天伏には描かない（描かず・遮蔽にも入れない）
      ...(opts.lookUp === true && layer.role === 'above' ? [] : beamSolids(layer)), ...roofSolids(layer, opts), ...stairTreadSolids(layer, riserForLayer, underside?.drawnTreads,
        opts.lookUp === true && layer.role === 'self' ? stairsContinuedAbove(layer, layers, opts) : null, upperGraph),
      ...(underside?.soffits ?? []),
      ...(opts.ceilings === true && layer.role === 'self' ? ceilingsOf.get(layer) ?? ceilingSolids(layer, upperGraph) : [])].filter(Boolean);
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
