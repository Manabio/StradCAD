// ================================================================
// 姿図の配置（PlacedFigure）が供給する基準（Datum）の割当て（部分詳細図 S10 P2-2）。
// 配置図は PLACEMENT_ORIGIN の基準（s・t とも origin）だけを持つ。値は局所座標の 0（配置の原点そのもの）。
//   対象: 平面の姿図（FIGURE・PLAN・PLACED_FIGURE_SUBJECTS）と、views が引く立面側の姿図（FIGURE・ELEVATION・同 subject）・見上げの姿図
// 他の role・end・param・material の束縛は供給しない（基準は UNSUPPORTED_DATUM、param・material は fit が UNRESOLVED_*）。
// 依存は constants・error・detail/detailModel.js・finish/roomDetailTargets.js（失敗の語彙 RoomDetailError）だけの葉（roomDetailTargets.js と同型の失敗）。
// ================================================================

import {
  DetailCategory, DetailView, DetailDatumRole, DetailDatumKind, DetailPlacementView, PLACED_FIGURE_SUBJECTS, CEILING_PLACED_FIGURE_SUBJECTS,
} from '../../core/constants.js';
import { canHaveDetailViews } from '../../detail/detailModel.js';
import { ERR_DETAIL_DATUM_UNSUPPORTED, ERR_DETAIL_NOT_PLACED_FIGURE, DETAIL_TARGET_PLACED_FIGURE } from '../../error.js';
import { RoomDetailError } from '../roomDetailTargets.js';

const fail = (code, message) => ({ error: { code, message } });

const ELEVATION_VIEWS = Object.freeze([DetailPlacementView.FRONT, DetailPlacementView.BACK, DetailPlacementView.LEFT, DetailPlacementView.RIGHT]);

const isElevationPlaced = fig => fig?.category === DetailCategory.FIGURE && fig.view === DetailView.ELEVATION && PLACED_FIGURE_SUBJECTS.includes(fig.subject);

/** 配置できる姿図の分類か（平面の姿図 または 立面側の姿図）。平面側の判定は detailModel の canHaveDetailViews と同一。 */
export function isPlacementFigure(fig) {
  return canHaveDetailViews(fig) || isElevationPlaced(fig);
}

/**
 * views の view（DetailPlacementView）に置ける図の分類か。front〜right＝FIGURE/ELEVATION/PLACED_FIGURE_SUBJECTS・
 * ceiling＝FIGURE/PLAN/CEILING_PLACED_FIGURE_SUBJECTS。それ以外の view は false。
 */
export function isPlaceableViewFigure(fig, view) {
  if (ELEVATION_VIEWS.includes(view)) return isElevationPlaced(fig);
  if (view === DetailPlacementView.CEILING) {
    return fig?.category === DetailCategory.FIGURE && fig.view === DetailView.PLAN && CEILING_PLACED_FIGURE_SUBJECTS.includes(fig.subject);
  }
  return false;
}

/**
 * 配置の分類（DetailSubject）を図から引く。figureOf（キー→図エントリ）で図が引け、平面の配置図（canHaveDetailViews）ならその subject。
 * 図が引けない・配置図でない・配置が無いときは null（分類不明）。
 */
export function placedFigureSubjectOf(placedFigure, figureOf) {
  const fig = figureOf(placedFigure?.figureKey);
  return canHaveDetailViews(fig) ? fig.subject : null;
}

/**
 * 配置が図面モード（subjects＝そのモードの分類の配列）に所属するか。描画の絞り・ヒット判定・モード状態はこの関数だけで所属を決める。
 * subjects が null／undefined は絞らない（true）。分類不明（図が引けない・配置図でない）はどのモードにも出す
 * （壊れた参照をどのモードからでも見つけて消せるようにするため）。新しく置く図キーの可否だけは別規則（分類不明は置けない。モード状態の beginFigurePlacement）。
 */
export function placedFigureBelongsTo(placedFigure, figureOf, subjects) {
  if (subjects === null || subjects === undefined) return true;
  const subject = placedFigureSubjectOf(placedFigure, figureOf);
  return subject === null || subjects.includes(subject);
}

/**
 * fitLocal に渡す targets を作る。datums は図の Datum.id をキーにする（fit が id で引くため）。
 * @param {object} fig DetailFigure（不正でも例外にせず fit の検証へ回す）
 * @returns {{targets:{datums:Object<string,number>, params:{}, materials:{}}} | {error:{code:string, message:string}}}
 */
export function placedFigureTargets(fig) {
  if (!isPlacementFigure(fig)) {
    return fail(RoomDetailError.UNSUPPORTED_SLOT, ERR_DETAIL_NOT_PLACED_FIGURE(`${String(fig?.category)}・${String(fig?.view)}・${String(fig?.subject)}`));
  }
  const datums = {};
  for (const d of Array.isArray(fig.datums) ? fig.datums : []) {
    if (d === null || typeof d !== 'object') continue; // 形の不正は fit の検証（INVALID）が理由つきで返す
    if (d.role !== DetailDatumRole.PLACEMENT_ORIGIN || d.kind !== DetailDatumKind.ORIGIN) {
      return fail(RoomDetailError.UNSUPPORTED_DATUM, ERR_DETAIL_DATUM_UNSUPPORTED(d.id, `${d.role}・${d.axis}・${d.kind}`, DETAIL_TARGET_PLACED_FIGURE));
    }
    datums[d.id] = 0;
  }
  // param・材は供給しない（束縛を持つ図は fit が UNRESOLVED_PARAM／UNRESOLVED_MATERIAL を返す）
  return { targets: { datums, params: {}, materials: {} } };
}
