/**
 * 立面図（外壁立面4面）の入力の組み立て。各階の graph から外壁の外面の線分（finish/finishGuideGeometry.js
 * exteriorGuideSegments。壁が無ければ通り芯値）と、その階の高さ範囲（GL 基準ではなく 1FL=0 の世界 z）を取り出す。
 * 以降の幾何（facadeGeometry.js）は graph を引かない。
 *
 * 対象は採用階のうち地上階だけ（地階・検討案・屋根専用平面は除く）。最下の地上階の zLo は GL（基礎は描かない）、
 * 各階の zHi は次の階の FL、最上階は軒桁上端（floorHeights.js eaveTopZMm。S1 は屋根なし＝平らに終わる）。
 * 例外は外へ出さない: 階ごとに取り出し、取れない階は skipped に理由を載せて飛ばす。
 */
import { FacadeSkipReason } from '../core/constants.js';
import { isBasementPlane } from '../structural/structureRules.js';
import { exteriorGuideSegments } from '../finish/finishGuideGeometry.js';
import { eaveTopZMm, resolveTopStoryHeightMm, STORY_HEIGHT_FALLBACK_MM } from '../floorHeights.js';
import { withGraphReadScope } from '../graphReadScope.js';

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
 * @returns {{ glZMm:number,
 *   floors: Array<{planeId:string, zLoMm:number, zHiMm:number,
 *     segments: Array<{isVertical:boolean, value:number, lo:number, hi:number, outwardSign:number, axisCLId:string, loopType:string}>}>,
 *   skipped: Array<{planeId:string, reason:string, message?:string}> }}
 */
export function buildFacadeInputs(floors, project) {
  const glBelow = project?.glBelow1FlMm;
  const glZMm = Number.isFinite(glBelow) ? -glBelow : 0;
  const targets = (floors ?? []).filter(f => isFacadePlane(f?.plane));
  const planes = targets.map(f => f.plane);
  const topHeightMm = resolveTopStoryHeightMm(project);
  const eaveZ = eaveTopZMm(planes, topHeightMm);

  const out = [];
  const skipped = [];
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
    out.push({ planeId: plane.id, zLoMm, zHiMm, segments });
  });
  return { glZMm, floors: out, skipped };
}
