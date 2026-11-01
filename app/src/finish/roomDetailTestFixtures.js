// 部屋の取り合い（junction）の部分詳細図（S8a）テスト共通の図の組み立て（テスト専用。製品コードからは引かない）。
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis,
  DetailDash, DetailSlot, DETAIL_FIGURE_VERSION,
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
