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

// 非対称の図 bumpElevationFigure の寸法（mm）: 全幅・+s の端の細い帯の高さ・全高の側の幅
const BUMP_WIDTH_MM = 300;
const BUMP_BAND_MM = 50;
const BUMP_FULL_WIDTH_MM = 100;
// 図ごとに変える全高（どの view の図が選ばれたかを見分ける）
const BUMP_RIGHT_BOTTOM_MM = 150;
const BUMP_FRONT_BOTTOM_MM = 250;
const BUMP_LEFT_BOTTOM_MM = 350;

/**
 * 左右の向きを見分ける非対称の立面の姿図（頂点 0＝配置原点）。s 0..300・t 0..bottom で、+s の端（s=300）だけが細い帯（t 0..50）。
 * 全高の側（s 0..100）の高さ bottom を図ごとに変えると、どの view の図が選ばれたかも見分けられる。
 */
export function bumpElevationFigure(key, bottom, { subject = DetailSubject.SANITARY } = {}) {
  return {
    ...square(key, { subject, view: DetailView.ELEVATION }),
    strokes: [{ id: 'a', closed: true, line: LINE, moves: [
      move(PenDir.RIGHT, fixedLen(BUMP_WIDTH_MM)), move(PenDir.DOWN, fixedLen(BUMP_BAND_MM)),
      move(PenDir.LEFT, fixedLen(BUMP_WIDTH_MM - BUMP_FULL_WIDTH_MM)),
      move(PenDir.DOWN, fixedLen(bottom - BUMP_BAND_MM)), move(PenDir.LEFT, fixedLen(BUMP_FULL_WIDTH_MM)),
    ] }],
  };
}

/** 図の束に入れる非対称の図 3 枚（キー eBumpR＝全高 150・eBumpF＝250・eBumpL＝350）。 */
export const bumpViewFigures = () => [
  bumpElevationFigure('eBumpR', BUMP_RIGHT_BOTTOM_MM),
  bumpElevationFigure('eBumpF', BUMP_FRONT_BOTTOM_MM),
  bumpElevationFigure('eBumpL', BUMP_LEFT_BOTTOM_MM),
];

/**
 * 描いた図（prims の points）を toWorldAlong（図の x → 世界の along 座標。面ごとにテスト側が立てる）で世界へ戻し、
 * along が最大・最小の端の頂点が持つ図の y の組を返す（帯の側か、全高の側かを見分ける）。
 */
export function bumpEnds(prims, toWorldAlong) {
  const pts = prims.flatMap(p => p.points).map(([x, y]) => ({ w: toWorldAlong(x), y }));
  const wMax = Math.max(...pts.map(p => p.w));
  const wMin = Math.min(...pts.map(p => p.w));
  const ysAt = w => [...new Set(pts.filter(p => p.w === w).map(p => p.y))].sort((p, q) => p - q);
  return { wMin, wMax, ysMax: ysAt(wMax), ysMin: ysAt(wMin) };
}

/** 配置では供給できない WALL_FINISH_FACE の基準を持つ datums（fit が基準の供給失敗になる）。 */
export const wallFaceDatums = () => [
  { id: 'ds0', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
  { id: 'dt0', role: DetailDatumRole.PLACEMENT_ORIGIN, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
];
