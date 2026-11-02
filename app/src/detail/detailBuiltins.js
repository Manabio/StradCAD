// 本体標準の部分詳細図（共通詳細）。カタログ種別 detailFigure の loadBuiltin 先（S2）。
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis,
  DetailDash, DETAIL_FIGURE_VERSION,
} from '../core/constants.js';

/** 巾木 10×60 の詳細図キー（床と壁の取り合い）。 */
export const BASEBOARD_10X60_KEY = 'df-builtin-baseboard-10x60';

const fixed = mm => ({ mm, mode: DetailLenMode.FIXED });

// 巾木 10×60: 壁の仕上げ面 (s=0)・床仕上げ面 (t=0) の角から、上へ 60・室内側へ 10・下へ 60 の閉じた矩形（固定寸法）。
const BASEBOARD_10X60 = Object.freeze({
  key: BASEBOARD_10X60_KEY,
  version: DETAIL_FIGURE_VERSION,
  label: '巾木 10×60',
  category: DetailCategory.JUNCTION,
  view: DetailView.SECTION,
  subject: DetailSubject.FLOOR_WALL,
  strokes: [{
    id: 'a',
    closed: true,
    line: { weightRole: 'medium', dashRole: DetailDash.SOLID },
    moves: [
      { dir: PenDir.UP, len: fixed(60) },
      { dir: PenDir.RIGHT, len: fixed(10) },
      { dir: PenDir.DOWN, len: fixed(60) },
    ],
  }],
  datums: [
    { id: 'ds0', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
    { id: 'dt0', role: DetailDatumRole.FL, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
  ],
  anchors: [
    { datumId: 'ds0', strokeId: 'a', vertexIndex: 0 },
    { datumId: 'dt0', strokeId: 'a', vertexIndex: 0 },
  ],
  provenance: null,
  note: null,
});

export default [BASEBOARD_10X60];
