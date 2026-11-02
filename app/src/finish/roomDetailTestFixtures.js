// 部屋の取り合い（junction）の部分詳細図（S8a）テスト共通の図の組み立て（テスト専用。製品コードからは引かない）。
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis,
  DetailDash, DetailSlot, DetailParam, DETAIL_FIGURE_VERSION,
} from '../core/constants.js';

const LINE = { weightRole: 'medium', dashRole: DetailDash.SOLID };
export const fixedLen = mm => ({ mm, mode: DetailLenMode.FIXED });
export const stretchLen = mm => ({ mm, mode: DetailLenMode.STRETCH });
export const materialLen = (code, field, mm) => ({ mm, mode: DetailLenMode.MATERIAL, code, field });
export const move = (dir, len) => ({ dir, len });

const SUBJECT_OF = Object.freeze({
  [DetailSlot.FLOOR_WALL]: DetailSubject.FLOOR_WALL,
  [DetailSlot.WALL_CEILING]: DetailSubject.WALL_CEILING,
});
const T_ROLE_OF = Object.freeze({
  [DetailSlot.FLOOR_WALL]: DetailDatumRole.FL,
  [DetailSlot.WALL_CEILING]: DetailDatumRole.CEILING_FACE,
});

/**
 * 取り合いの断面図。ストローク 1 本（id 'a'）。s の origin＝壁の仕上げ面・t の origin＝FL（floorWall）または天井面（wallCeiling）。
 * endVertex を渡すと s の end（壁の反対の面＝−壁厚）をその頂点に載せる（stretch の手が 1 本要る）。
 */
export function junctionFigure(key, slot, moves, { closed = false, endVertex = null, over = {} } = {}) {
  const datums = [
    { id: 'ds0', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
    { id: 'dt0', role: T_ROLE_OF[slot], axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
  ];
  const anchors = [
    { datumId: 'ds0', strokeId: 'a', vertexIndex: 0 },
    { datumId: 'dt0', strokeId: 'a', vertexIndex: 0 },
  ];
  if (endVertex !== null) {
    datums.push({ id: 'ds1', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.S, kind: DetailDatumKind.END, offsetMm: 0 });
    anchors.push({ datumId: 'ds1', strokeId: 'a', vertexIndex: endVertex });
  }
  return {
    key, version: DETAIL_FIGURE_VERSION, label: `テスト${key}`,
    category: DetailCategory.JUNCTION, view: DetailView.SECTION, subject: SUBJECT_OF[slot],
    strokes: [{ id: 'a', closed, line: LINE, moves }],
    datums, anchors, provenance: null, note: null,
    ...over,
  };
}

export const paramLen = (param, mm) => ({ mm, mode: DetailLenMode.PARAM, param });

/**
 * 腰壁・垂れ壁の部位の断面図（part/section/wall。S8b-1）。ストローク 1 本（id 'a'）。s の origin＝表の側の仕上げ面（頂点 sVertex）・
 * t の origin＝腰壁の天端の面（kneeTop）または垂れ壁の下端の面（dropBottom。頂点 tVertex）。
 */
export function partFigure(key, slot, moves, { closed = true, sVertex = 0, tVertex = 0 } = {}) {
  return {
    key, version: DETAIL_FIGURE_VERSION, label: `テスト${key}`,
    category: DetailCategory.PART, view: DetailView.SECTION, subject: DetailSubject.WALL,
    strokes: [{ id: 'a', closed, line: LINE, moves }],
    datums: [
      { id: 'ds0', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
      { id: 'dt0', role: slot === DetailSlot.DROP_BOTTOM ? DetailDatumRole.WALL_BOTTOM : DetailDatumRole.WALL_TOP, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
    ],
    anchors: [
      { datumId: 'ds0', strokeId: 'a', vertexIndex: sVertex },
      { datumId: 'dt0', strokeId: 'a', vertexIndex: tVertex },
    ],
    provenance: null, note: null,
  };
}

/**
 * 表の側だけに出る天板（kneeTop）: 表の側へ 12 出て厚 20・裏の側は出ない。頂点 (12,0)→(12,20)→(0,20)→(−壁厚,20)→(−壁厚,0)（閉）。
 * 表の側から見ると t=20 に段差（出幅 12）がある／裏の側から見ると室内側へ出る部分が無い（段差なし）。
 */
export function frontOnlyCapFigure(key, thickness = 20, overhang = 12) {
  return partFigure(key, DetailSlot.KNEE_TOP, [
    move(PenDir.DOWN, fixedLen(thickness)), move(PenDir.LEFT, fixedLen(overhang)), move(PenDir.LEFT, paramLen(DetailParam.WALL_THICKNESS, 100)),
    move(PenDir.UP, fixedLen(thickness)),
  ], { sVertex: 2, tVertex: 0 });
}

/**
 * 床の段差の段鼻（floorStep。part/section/floor。S8b-3。閉）。頂点 (0,0)=riser 上端 → (出,0) → (出,厚) → (出−見切り幅,厚) → (出−見切り幅,厚+見切り高) →
 * (0,厚+見切り高) → (0, 厚+見切り高+伸縮)。s の origin＝立ち上がり面（頂点 0）・t の origin＝高い側の床（頂点 0）・t の end＝低い側の床（最終頂点）。
 * 形状差（包絡線の最大の出）＝出。段差高が 厚+見切り高 以下だと伸縮が 0 以下で fit 不可（FIXED_EXCEEDS_TARGET）。
 * 既定（出 120・厚 40・見切り 30×30）の包絡線: t 0〜40 が s=120・40〜70 が s=30・以降 0。
 */
export function stepNoseFigure(key, { overhang = 120, thickness = 40, trimWidth = 30, trimHeight = 30 } = {}) {
  return floorStepFigure(key, [
    move(PenDir.RIGHT, fixedLen(overhang)), move(PenDir.DOWN, fixedLen(thickness)), move(PenDir.LEFT, fixedLen(overhang - trimWidth)),
    move(PenDir.DOWN, fixedLen(trimHeight)), move(PenDir.LEFT, fixedLen(trimWidth)), move(PenDir.DOWN, stretchLen(100)),
  ]);
}

/**
 * 床の段差の部位図の組み立て（part/section/floor）。ストローク 1 本（id 'a'）。s の origin＝立ち上がり面（頂点 0）・
 * t の origin＝高い側の床（頂点 0）・t の end＝低い側の床（頂点 endVertex。省略は最終頂点）。
 */
export function floorStepFigure(key, moves, { closed = true, endVertex = moves.length } = {}) {
  return {
    key, version: DETAIL_FIGURE_VERSION, label: `テスト${key}`,
    category: DetailCategory.PART, view: DetailView.SECTION, subject: DetailSubject.FLOOR,
    strokes: [{ id: 'a', closed, line: LINE, moves }],
    datums: [
      { id: 'ds0', role: DetailDatumRole.STEP_EDGE, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
      { id: 'dt0', role: DetailDatumRole.FL, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
      { id: 'dt1', role: DetailDatumRole.FL, axis: DetailAxis.T, kind: DetailDatumKind.END, offsetMm: 0 },
    ],
    anchors: [
      { datumId: 'ds0', strokeId: 'a', vertexIndex: 0 },
      { datumId: 'dt0', strokeId: 'a', vertexIndex: 0 },
      { datumId: 'dt1', strokeId: 'a', vertexIndex: endVertex },
    ],
    provenance: null, note: null,
  };
}

/**
 * 天井の段差の見切り（ceilingStep。part/section/ceiling。S8b-4a。閉）。頂点 (0,0)=低い側の天井の立ち上がり面 → (出,0) → (出,−厚) → (出−見切り幅,−厚) →
 * (出−見切り幅,−厚−見切り高) → (0,−厚−見切り高) → (0, −厚−見切り高−伸縮)。s の origin＝立ち上がり面（頂点 0。高い側が正）・t の origin＝低い側の天井面（頂点 0）・
 * t の end＝高い側の天井面（最終頂点。t は下向き正なので −段差高）。形状差＝出。stepNoseFigure の上下反転。
 * 既定（出 120・厚 40・見切り 30×30）の包絡線: t −40〜0 が s=120・−70〜−40 が s=30・以降 0。
 */
export function ceilingNoseFigure(key, { overhang = 120, thickness = 40, trimWidth = 30, trimHeight = 30 } = {}) {
  return ceilingStepFigure(key, [
    move(PenDir.RIGHT, fixedLen(overhang)), move(PenDir.UP, fixedLen(thickness)), move(PenDir.LEFT, fixedLen(overhang - trimWidth)),
    move(PenDir.UP, fixedLen(trimHeight)), move(PenDir.LEFT, fixedLen(trimWidth)), move(PenDir.UP, stretchLen(100)),
  ]);
}

/**
 * 天井の段差の部位図の組み立て（part/section/ceiling）。ストローク 1 本（id 'a'）。s の origin＝立ち上がり面（頂点 0）・
 * t の origin＝低い側の天井面（頂点 0。role は tRole）・t の end＝高い側の天井面（頂点 endVertex。省略は最終頂点）。
 */
export function ceilingStepFigure(key, moves, { closed = true, endVertex = moves.length, tRole = DetailDatumRole.CEILING_FACE } = {}) {
  return {
    key, version: DETAIL_FIGURE_VERSION, label: `テスト${key}`,
    category: DetailCategory.PART, view: DetailView.SECTION, subject: DetailSubject.CEILING,
    strokes: [{ id: 'a', closed, line: LINE, moves }],
    datums: [
      { id: 'ds0', role: DetailDatumRole.STEP_EDGE, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
      { id: 'dt0', role: tRole, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
      { id: 'dt1', role: tRole, axis: DetailAxis.T, kind: DetailDatumKind.END, offsetMm: 0 },
    ],
    anchors: [
      { datumId: 'ds0', strokeId: 'a', vertexIndex: 0 },
      { datumId: 'dt0', strokeId: 'a', vertexIndex: 0 },
      { datumId: 'dt1', strokeId: 'a', vertexIndex: endVertex },
    ],
    provenance: null, note: null,
  };
}

/** 矩形の巾木（floorWall。閉）。頂点 (0,0) → (0,−h) → (d,−h) → (d,0)。 */
export function baseboardFigure(key, depth = 12, height = 60) {
  return junctionFigure(key, DetailSlot.FLOOR_WALL, [
    move(PenDir.UP, fixedLen(height)), move(PenDir.RIGHT, fixedLen(depth)), move(PenDir.DOWN, fixedLen(height)),
  ], { closed: true });
}

/** 壁厚で fit できる図: 壁の中へ L 固定 5 → L 伸縮（壁の反対の面まで）。壁厚が 5 以下なら fit 不可（FIXED_EXCEEDS_TARGET）。 */
export function wallBackedFigure(key, slot = DetailSlot.FLOOR_WALL, fixedMm = 5) {
  return junctionFigure(key, slot, [move(PenDir.LEFT, fixedLen(fixedMm)), move(PenDir.LEFT, stretchLen(50))], { endVertex: 2 });
}
