/**
 * 立面図（外壁立面4面）の入力の組み立て。各階の graph から外壁の外面の線分（finish/finishGuideGeometry.js
 * exteriorGuideSegments。壁が無ければ通り芯値）と、その階の高さ範囲（GL 基準ではなく 1FL=0 の世界 z）を取り出す。
 * 以降の幾何（facadeGeometry.js）は graph を引かない。
 *
 * 対象は採用階のうち地上階だけ（地階・検討案・屋根専用平面は除く）。最下の地上階の zLo は GL（基礎は描かない）、
 * 各階の zHi は次の階の FL、最上階は軒桁上端（floorHeights.js eaveTopZMm。S1 は屋根なし＝平らに終わる）。
 * 例外は外へ出さない: 階ごとに取り出し、取れない階は skipped に理由を載せて飛ばす。
 *
 * 屋根（S2）: opts.roofRegionsOf(graph) が { leanTo, top }（leanToPlanRegions・topRoofPlanRegions の結果）を返せば、
 * 下屋は軒の高さ＝その階の FL（floor-design.md「最高の軒の高さ」）、主屋根・屋根区画は最上階の分だけ軒の高さ＝軒桁上端で
 * facadeRoof.js の屋根にする。region の解決は呼び出し側（roofFramingRegions.js は storage を推移的に引くため facade/ から引かない）。
 *
 * 建具（S3）: 各階の graph.openings のうち外壁の線分に乗るもの（facadeOpenings.js exteriorOpeningsOn）を、壁の座標（coord1/coord2）
 * とその階の FL を読み取りスコープ内で確定して floors[].openings に持たせる（姿図の組み立ては倍率が決まった後＝facadeFigure.js）。
 */
import { FacadeSkipReason, RoomKind } from '../core/constants.js';
import { buildCellToRoom, isEnclosureOutside } from '../finish/edgeClassify.js';
import { worldToCell } from '../finish/gridCells.js';
import { isBasementPlane } from '../structural/structureRules.js';
import { exteriorGuideSegments } from '../finish/finishGuideGeometry.js';
import { eaveTopZMm, resolveTopStoryHeightMm, STORY_HEIGHT_FALLBACK_MM } from '../floorHeights.js';
import { withGraphReadScope } from '../graphReadScope.js';
import { facadeRoofOf } from './facadeRoof.js';
import { exteriorOpeningsOn } from './facadeOpenings.js';
import { collectDetailFigureFailures } from '../openings/openingDetailFitCheck.js';

// 立面の対象の階か（採用・地上階・屋根専用でない）。
const isFacadePlane = plane => !!plane && !plane.isAlternative && !plane.isRoofPlane && !isBasementPlane(plane);

// 1階分の外壁の線分（lo<hi の正規形）。
function exteriorSegmentsOf(graph) {
  return withGraphReadScope(graph, () => exteriorGuideSegments(graph))
    .map(s => ({
      isVertical: s.isVertical,
      value: s.value,
      lo: Math.min(s.start, s.end),
      hi: Math.max(s.start, s.end),
      outwardSign: s.outwardSign,
      axisCLId: s.axisCLId,
      loopType: s.loopType,
    }))
    .filter(s => Number.isFinite(s.value) && Number.isFinite(s.lo) && Number.isFinite(s.hi) && s.hi > s.lo);
}

/**
 * @param {Array<{plane:object, graph:object|null}>} floors - 採用階（elevation 昇順）。graph が null の階は飛ばす
 * @param {{glBelow1FlMm?:number, planes?:Array}} project
 * @param {{roofRegionsOf?: (graph:object)=>{leanTo?:Array<object>, top?:Array<object>}}} [opts]
 * @returns {{ glZMm:number,
 *   floors: Array<{planeId:string, zLoMm:number, zHiMm:number, flMm:number,
 *     segments: Array<{isVertical:boolean, value:number, lo:number, hi:number, outwardSign:number, axisCLId:string, loopType:string}>,
 *     openings: Array<{opening:object, coord1:number, coord2:number, flMm:number, segment:object}>,
 *     placedFigures: object[]}>,
 *   roofs: Array<{planeId:string} & object>,
 *   skipped: Array<{planeId:string, reason:string, message?:string, roofKey?:string}> }}
 */
export function buildFacadeInputs(floors, project, { roofRegionsOf = null } = {}) {
  const glBelow = project?.glBelow1FlMm;
  const glZMm = Number.isFinite(glBelow) ? -glBelow : 0;
  const targets = (floors ?? []).filter(f => isFacadePlane(f?.plane));
  const planes = targets.map(f => f.plane);
  const topHeightMm = resolveTopStoryHeightMm(project);
  const eaveZ = eaveTopZMm(planes, topHeightMm);

  const out = [];
  const roofs = [];
  const skipped = [];
  const detailSeen = new Set(); // 姿図の詳細図の fit 失敗の重複排除（階をまたいで同じ図×寸法は 1 件）
  targets.forEach(({ plane, graph }, i) => {
    const zLoMm = i === 0 ? glZMm : plane.elevation;
    const next = planes[i + 1];
    let zHiMm = next ? next.elevation : eaveZ;
    // 上端が GL 以下の階は地上に出ない。補完より前に判定する（補うと上の階と z が重なる）。
    if (Number.isFinite(zHiMm) && zHiMm <= glZMm) { skipped.push({ planeId: plane.id, reason: FacadeSkipReason.BELOW_GL }); return; }
    if (!Number.isFinite(zHiMm) || !(zHiMm > zLoMm)) zHiMm = zLoMm + STORY_HEIGHT_FALLBACK_MM;

    if (!graph) { skipped.push({ planeId: plane.id, reason: FacadeSkipReason.NO_GRAPH }); return; }
    let segments;
    try {
      segments = exteriorSegmentsOf(graph);
    } catch (err) {
      skipped.push({ planeId: plane.id, reason: FacadeSkipReason.ERROR, message: String(err?.message ?? err) });
      return;
    }
    if (segments.length === 0) { skipped.push({ planeId: plane.id, reason: FacadeSkipReason.NO_EXTERIOR_WALL }); return; }
    out.push({
      planeId: plane.id, zLoMm, zHiMm, flMm: plane.elevation, segments,
      openings: exteriorOpeningsOf(skipped, plane, graph, segments, detailSeen),
      placedFigures: exteriorPlacedFiguresSafe(skipped, plane, graph),
    });
    if (roofRegionsOf) collectRoofs(roofs, skipped, plane, graph, roofRegionsOf, i === targets.length - 1 ? zHiMm : null);
  });
  return { glZMm, floors: out, roofs, skipped };
}

/**
 * 1階分の屋外の姿図の配置（部分詳細図 S10 P6）。屋外＝配置点のセルがどの部屋にも属さない（セルなし＝建物の外を含む）か、
 * 属する部屋が屋外部屋（RoomKind.EXTERIOR）か屋根の部屋（feature ROOF。isEnclosureOutside）＝edgeClassify.js regionOf が
 * 屋内以外とする区分と同じ判定。屋内の配置は立面に出さない。
 * graph.placedFigures が配列でなければ []。読み取りスコープ内で部屋の逆引きを作る。
 * @returns {object[]} PlacedFigure の配列
 */
export function exteriorPlacedFiguresOf(graph) {
  const placed = graph?.placedFigures;
  if (!Array.isArray(placed) || placed.length === 0) return [];
  return withGraphReadScope(graph, () => {
    const cellToRoom = buildCellToRoom(graph);
    return placed.filter(pf => {
      if (pf === null || typeof pf !== 'object') return false;
      const key = worldToCell(pf.x, pf.y, graph)?.key;
      const room = key === undefined ? null : cellToRoom.get(key);
      return !room || isEnclosureOutside(room) || room.kind === RoomKind.EXTERIOR;
    });
  });
}

// 例外は skipped（ERROR）に載せて配置なしで続ける（壁・建具は描く。exteriorOpeningsOf と同じ扱い）。
function exteriorPlacedFiguresSafe(skipped, plane, graph) {
  try {
    return exteriorPlacedFiguresOf(graph);
  } catch (err) {
    skipped.push({ planeId: plane.id, reason: FacadeSkipReason.ERROR, message: String(err?.message ?? err) });
    return [];
  }
}

// 1階分の外壁の建具（S3。facadeOpenings.js exteriorOpeningsOn）。例外は skipped（ERROR）に載せて建具なしで続ける（壁は描く）。
// 建具の姿図の詳細図（S6b）を建具の寸法に合わせられないものは skipped（DETAIL_FIT_FAILED）に載せる（姿図は従来の描き方で描く）。
function exteriorOpeningsOf(skipped, plane, graph, segments, detailSeen) {
  try {
    const list = withGraphReadScope(graph, () => exteriorOpeningsOn(graph.openings, segments, plane.elevation));
    // 集計の失敗は立面を止める理由にしない（通知が出ないだけ。展開・建具モードの init と同じ扱い）。
    try {
      for (const f of collectDetailFigureFailures(list.map(x => x.opening), detailSeen)) {
        skipped.push({ planeId: plane.id, reason: FacadeSkipReason.DETAIL_FIT_FAILED, message: f.message });
      }
    } catch (err) {
      console.error('[facade] 建具の姿図の詳細図の合わせ込み検査に失敗:', err);
    }
    return list;
  } catch (err) {
    skipped.push({ planeId: plane.id, reason: FacadeSkipReason.ERROR, message: String(err?.message ?? err) });
    return [];
  }
}

// 1階分の屋根（下屋＝軒の高さはその階の FL。topEaveZ が有限＝最上階なら主屋根・区画も軒の高さ topEaveZ で）。
function collectRoofs(roofs, skipped, plane, graph, roofRegionsOf, topEaveZ) {
  let regions;
  try {
    regions = withGraphReadScope(graph, () => roofRegionsOf(graph)) ?? {};
  } catch (err) {
    skipped.push({ planeId: plane.id, reason: FacadeSkipReason.ERROR, message: String(err?.message ?? err) });
    return;
  }
  const entries = [
    ...(regions.leanTo ?? []).map(region => [region, plane.elevation]),
    ...(Number.isFinite(topEaveZ) ? (regions.top ?? []).map(region => [region, topEaveZ]) : []),
  ];
  for (const [region, eaveZ] of entries) {
    const { roof, reason, message } = facadeRoofOf(region, eaveZ);
    const roofKey = region?.key ?? null;
    if (!roof) {
      skipped.push({ planeId: plane.id, roofKey, reason, ...(message ? { message } : {}) });
      continue;
    }
    if (roof.flatFallback) skipped.push({ planeId: plane.id, roofKey, reason: FacadeSkipReason.ROOF_FLAT_FALLBACK });
    roofs.push({ planeId: plane.id, ...roof });
  }
}
