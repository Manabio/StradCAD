// 姿図の配置（finish/placedFigure/）のテスト用の図の組み立て（roomDetailTestFixtures.js と同じ位置づけ）。本体コードは引かない。
import {
  PenDir, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis, DetailDash,
  DETAIL_VIEWS_FIELD, DETAIL_FIGURE_VERSION,
} from '../../core/constants.js';
import { fixedLen, move } from '../roomDetailTestFixtures.js';

const LINE = { weightRole: 'medium', dashRole: DetailDash.SOLID };

/** 正方形の姿図。PLACEMENT_ORIGIN の基準だけを持つ（targets 全 0 で解ける）。datums を渡すと差し替える。 */
export function square(key, { subject = DetailSubject.SANITARY, view = DetailView.PLAN, label = `図${key}`, datums, views } = {}) {
  return {
    key, version: DETAIL_FIGURE_VERSION, label, category: DetailCategory.FIGURE, view, subject,
    strokes: [{ id: 'a', closed: true, line: LINE, moves: [
      move(PenDir.RIGHT, fixedLen(20)), move(PenDir.DOWN, fixedLen(20)), move(PenDir.LEFT, fixedLen(20)),
    ] }],
    datums: datums ?? [
      { id: 'ds0', role: DetailDatumRole.PLACEMENT_ORIGIN, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
      { id: 'dt0', role: DetailDatumRole.PLACEMENT_ORIGIN, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
    ],
    anchors: [
      { datumId: 'ds0', strokeId: 'a', vertexIndex: 0 },
      { datumId: 'dt0', strokeId: 'a', vertexIndex: 0 },
    ],
    provenance: null, note: null,
    ...(views ? { [DETAIL_VIEWS_FIELD]: views } : {}),
  };
}

/** 配置では供給できない WALL_FINISH_FACE の基準を持つ datums（fit が基準の供給失敗になる）。 */
export const wallFaceDatums = () => [
  { id: 'ds0', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
  { id: 'dt0', role: DetailDatumRole.PLACEMENT_ORIGIN, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
];
