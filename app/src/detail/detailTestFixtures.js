// detail/ のテスト共通の図の組み立て（テスト専用。製品コードからは引かない）。
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis,
  DetailDash, DETAIL_FIGURE_VERSION,
} from '../core/constants.js';

export const fixedLen = mm => ({ mm, mode: DetailLenMode.FIXED });
export const stretchLen = mm => ({ mm, mode: DetailLenMode.STRETCH });
export const paramLen = (param, mm) => ({ mm, mode: DetailLenMode.PARAM, param });
export const materialLen = (code, field, mm) => ({ mm, mode: DetailLenMode.MATERIAL, code, field });
export const move = (dir, len) => ({ dir, len });
export const vmove = (dx, dy) => ({ dir: PenDir.VECTOR, dx, dy });
export const strokeOf = (id, moves, closed = false, line = { weightRole: 'medium', dashRole: DetailDash.SOLID }) => ({ id, moves, closed, line });
export const anchorOf = (datumId, strokeId, vertexIndex) => ({ datumId, strokeId, vertexIndex });
export const datumOf = (id, role, axis, kind, offsetMm = 0) => ({ id, role, axis, kind, offsetMm });

export const DS0 = datumOf('ds0', DetailDatumRole.WALL_FINISH_FACE, DetailAxis.S, DetailDatumKind.ORIGIN);
export const DT0 = datumOf('dt0', DetailDatumRole.WALL_FINISH_FACE, DetailAxis.T, DetailDatumKind.ORIGIN);
export const DT1 = datumOf('dt1', DetailDatumRole.OPENING_INNER, DetailAxis.T, DetailDatumKind.END);

/** 最小の有効な図（origin の Datum 2 つ・ストロークは引数）。 */
export function figureOf(strokes, over = {}) {
  return {
    key: 'df-test', version: DETAIL_FIGURE_VERSION, label: 'テスト',
    category: DetailCategory.PAIRED, view: DetailView.PLAN, subject: DetailSubject.JAMB,
    strokes, datums: [DS0, DT0],
    anchors: strokes.flatMap(s => [anchorOf('ds0', s.id, 0), anchorOf('dt0', s.id, 0)]),
    provenance: null, note: null,
    ...over,
  };
}

/**
 * コの字（開）。頂点 0(0,0) 1(20,0) 2(20,10) 3(20,10+x) 4(20,20+x) 5(0,20+x)。
 * 手: R20・D10・D stretch(50)・D10・L20。t の end は頂点 4（目標見込 = 70 のとき x=50）。
 */
export function stretchFigure() {
  const s = strokeOf('a', [
    move(PenDir.RIGHT, fixedLen(20)),
    move(PenDir.DOWN, fixedLen(10)),
    move(PenDir.DOWN, stretchLen(50)),
    move(PenDir.DOWN, fixedLen(10)),
    move(PenDir.LEFT, fixedLen(20)),
  ]);
  return figureOf([s], {
    datums: [DS0, DT0, DT1],
    anchors: [anchorOf('ds0', 'a', 0), anchorOf('dt0', 'a', 0), anchorOf('dt1', 'a', 4)],
  });
}

/** 矩形（閉。3 手・頂点 4。閉じ辺は描画側が補うので始点へ戻る手は書かない）。 */
export function rectFigure(w = 100, h = 50) {
  return figureOf([strokeOf('r', [
    move(PenDir.RIGHT, fixedLen(w)), move(PenDir.DOWN, fixedLen(h)), move(PenDir.LEFT, fixedLen(w)),
  ], true)]);
}
