/**
 * 立面図（外壁立面4面）の図の組み立て。facadeGeometry.js の外形線（u・世界 z）を図の座標へ移し、
 * 外壁の建具の姿図（facadeOpenings.js）・▽GL・見出しを足したプリミティブ（elevation/elevationPrimitives.js の語彙）を面ごとに返す。
 *
 * 図の座標: X = u − uMin（建物の左端が 0）、Y = glZMm − z（GL が Y=0・上が負。展開図と同じ規約）。
 * 注記の大きさ（annotationMm）は呼び出し側が倍率確定後に実画面mm→モデルmmへ換算して渡す（2パス方式）。
 */
import { FACADE_TITLE_BY_DIRECTION, FACADE_GL_LABEL } from '../core/constants.js';
import { line, polyline, text } from '../elevation/elevationPrimitives.js';
import { ElevationLineRole, FACE_LABEL_FONT_PX, CANVAS_BG_COLOR } from '../elevation/elevationStyle.js';
import { facadeViews, facadeFloorProfiles, buildFacadeLines, projectedRoofSegments } from './facadeGeometry.js';
import { FACADE_GL_MARK_APEX_DEG, FACADE_LEVEL_FONT_PX } from './facadeStyle.js';
import { buildFacadeOpenings } from './facadeOpenings.js';

const DEG_TO_RAD = Math.PI / 180;

const hasAnySegment = inputs => (inputs?.floors ?? []).some(f => (f.segments ?? []).length > 0);

// 1面の建物の範囲（u の最小・最大、GL からの高さ）。屋根の線（見え隠れによらず全部。軒の出・棟を含む）も含める。何も無ければ null。
function faceExtent(inputs, normal) {
  const profiles = facadeFloorProfiles(inputs, normal);
  if (profiles.length === 0) return null;
  let uMin = Infinity, uMax = -Infinity, zTop = -Infinity;
  for (const f of profiles) {
    for (const p of f.pieces) { uMin = Math.min(uMin, p.lo); uMax = Math.max(uMax, p.hi); }
    zTop = Math.max(zTop, f.zHiMm);
  }
  for (const s of projectedRoofSegments(inputs.roofs, normal)) {
    uMin = Math.min(uMin, s.u1, s.u2);
    uMax = Math.max(uMax, s.u1, s.u2);
    zTop = Math.max(zTop, s.z1, s.z2);
  }
  return { uMin, widthMm: uMax - uMin, heightMm: Math.max(0, zTop - inputs.glZMm) };
}

/**
 * 倍率決定用の建物の寸法（注記を含まない）。
 * @returns {{maxWidthMm:number, maxHeightMm:number, faces:Array<{direction:string, widthMm:number, heightMm:number}>}}
 */
export function facadeExtentsMm(inputs, { northAngleDeg = null } = {}) {
  const faces = facadeViews(northAngleDeg).map(view => {
    const ext = hasAnySegment(inputs) ? faceExtent(inputs, view.normal) : null;
    return { direction: view.direction, widthMm: ext?.widthMm ?? 0, heightMm: ext?.heightMm ?? 0 };
  });
  return {
    maxWidthMm: faces.reduce((m, f) => Math.max(m, f.widthMm), 0),
    maxHeightMm: faces.reduce((m, f) => Math.max(m, f.heightMm), 0),
    faces,
  };
}

// ▽GL（GL の線・▽・「GL」）。▽は左の延長の中ほどに先端を GL の線へ乗せ、「GL」はその左上。
function glPrimitives(widthMm, { glExtendMm, glMarkMm }, bgColor) {
  const tipX = -glExtendMm / 2;
  const halfBase = glMarkMm * Math.tan((FACADE_GL_MARK_APEX_DEG / 2) * DEG_TO_RAD);
  return [
    line(-glExtendMm, 0, widthMm + glExtendMm, 0, ElevationLineRole.CUT),
    { ...polyline([[tipX, 0], [tipX - halfBase, -glMarkMm], [tipX + halfBase, -glMarkMm]], ElevationLineRole.DETAIL),
      closed: true, fill: bgColor },
    text(tipX - halfBase - glMarkMm, -glMarkMm, FACADE_GL_LABEL,
      { anchor: 'middle', baseline: 'middle', size: FACADE_LEVEL_FONT_PX }),
  ];
}

/**
 * 4面（東・南・西・北の順）の図。外壁の線分が1本も無ければ []。
 * @param {object} inputs - buildFacadeInputs の返り値
 * @param {{northAngleDeg?:number|null, annotationMm?:{glExtendMm?:number, glMarkMm?:number, titleGapMm?:number},
 *   bgColor?:string, minFaceMm?:number, entryOf?:Function|null}} [opts]
 *   minFaceMm＝建具の姿図の見付1px保証（展開図と同じ elevationStyle.js faceGapLimitMm の値を呼び出し側が倍率から求めて渡す）。
 *   entryOf＝建具のカタログの解決（省略時は facadeOpenings.js の既定 findCatalogEntry）。
 * @returns {Array<{direction:string, widthMm:number, heightMm:number,
 *   bounds:{minX:number,minY:number,maxX:number,maxY:number}, primitives:object[],
 *   openingCounts:{drawn:number, hidden:number, noEntry:number}}>}
 */
export function buildFacadeModel(inputs, {
  northAngleDeg = null, annotationMm, bgColor = CANVAS_BG_COLOR, minFaceMm = 0, entryOf = null,
} = {}) {
  if (!hasAnySegment(inputs)) return [];
  const { glExtendMm = 0, glMarkMm = 0, titleGapMm = 0 } = annotationMm ?? {};
  const glZ = inputs.glZMm;
  return facadeViews(northAngleDeg).map(view => {
    const ext = faceExtent(inputs, view.normal) ?? { uMin: 0, widthMm: 0, heightMm: 0 };
    const { uMin, widthMm, heightMm } = ext;
    const primitives = buildFacadeLines(inputs, view)
      .map(l => line(l.x1 - uMin, glZ - l.z1, l.x2 - uMin, glZ - l.z2, l.role));
    const openings = buildFacadeOpenings(inputs, view, {
      uMin, profiles: facadeFloorProfiles(inputs, view.normal), minFaceMm, entryOf,
    });
    primitives.push(...openings.primitives);
    primitives.push(...glPrimitives(widthMm, { glExtendMm, glMarkMm }, bgColor));
    const titleY = -heightMm - titleGapMm;
    primitives.push(text(widthMm / 2, titleY, FACADE_TITLE_BY_DIRECTION[view.direction],
      { anchor: 'middle', baseline: 'middle', size: FACE_LABEL_FONT_PX }));
    return {
      direction: view.direction,
      widthMm,
      heightMm,
      // 注記（GL の延長・▽・見出しの中心）を含む範囲。文字の大きさ（px 固定）は含まない。
      bounds: { minX: -glExtendMm, minY: titleY, maxX: widthMm + glExtendMm, maxY: 0 },
      primitives,
      // 建具の件数（描いた／全部隠れた／カタログに無い種別で飛ばした。probe・テスト用）
      openingCounts: openings.counts,
    };
  });
}
