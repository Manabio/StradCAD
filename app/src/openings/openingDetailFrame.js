// ================================================================
// 三方枠（WF/SF/SSF）の方立・上枠へ部分詳細図を反映する純モジュール（部分詳細図 S3）。
//   detailFrameTargets  図の基準（Datum）と param に、三方枠の寸法（壁厚・見付・出幅）を割り当てる（局所座標）
//   placeDetailSides    位置合わせ済み（fitLocal の結果）の図を、開口の両端（coord1 側＝正・coord2 側＝s 軸反転）へ写す
//   detailElevationTargets / placeDetailElevation  建具の姿図（正面図。S6b）への同じ 2 段（基準の値の割当て・写像）
// 局所座標: s＝along（壁の長さ方向。見付方向）、t＝perp（壁厚方向）。t の 0 は壁の面（faceMin）、壁厚は faceMax−faceMin。
// カタログ（図の取得・fit のメモ）は引かない——openingCatalog.js がこのモジュールを引くため（循環回避）。
// 呼び出しの組み立て（図の取得→fit→写像）は openings/openingDetailFit.js。
// openings/ が引いてよい detail/ は detailPlacement.js だけ（openings/importGraph.test.js で固定）。
// ================================================================

import { DetailDatumRole, DetailDatumKind, DetailAxis, DetailParam } from '../core/constants.js';
import { placeStrokes } from '../detail/detailPlacement.js';
import { ERR_DETAIL_DATUM_UNSUPPORTED, DETAIL_TARGET_ELEVATION } from '../error.js';

/** このモジュール自身が返す失敗の種類（fit の失敗は detail/detailFit.js の DetailFitError）。 */
export const DetailFrameError = Object.freeze({
  UNSUPPORTED_DATUM: 'unsupportedDatum', // 三方枠が供給できない基準（role・軸・種別の組）
  NO_FIGURE:         'noFigure',         // 記号が参照する詳細図がカタログに無い（fit のメモ口 fitDetailLocalMemo が返す）
});

export const detailFrameFail = (code, message) => ({ error: { code, message } });
const fail = detailFrameFail;

// 三方枠が供給する基準の値（局所座標）。OPENING_OUTER（s の origin）＝開口端 0、
// WALL_FINISH_FACE（t の origin／end）＝壁の面 0／壁厚。それ以外の組は未対応（undefined）。
function datumBase(d, wallThickness) {
  if (d.role === DetailDatumRole.OPENING_OUTER && d.axis === DetailAxis.S && d.kind === DetailDatumKind.ORIGIN) return 0;
  if (d.role === DetailDatumRole.WALL_FINISH_FACE && d.axis === DetailAxis.T) {
    if (d.kind === DetailDatumKind.ORIGIN) return 0;
    if (d.kind === DetailDatumKind.END) return wallThickness;
  }
  return undefined;
}

/**
 * fitLocal に渡す targets を作る。datums は図の Datum.id をキーにする（fit が id で引くため）。
 * materials は渡さない（材の寸法への束縛は三方枠では未解決＝fit が UNRESOLVED_MATERIAL を返す）。
 * @param {object} fig DetailFigure（カタログのエントリ。不正でも例外にせず fit の検証へ回す）
 * @param {{wallThickness:number, faceWidth:number, projection:number}} dims faceWidth は開口半幅で頭打ちにした後の値
 * @returns {{targets:{datums:Object<string,number>, params:Object<string,number>}} | {error:{code:string, message:string}}}
 */
export function detailFrameTargets(fig, { wallThickness, faceWidth, projection }) {
  const datums = {};
  for (const d of Array.isArray(fig?.datums) ? fig.datums : []) {
    if (d === null || typeof d !== 'object') continue; // 形の不正は fit の検証（INVALID）が理由つきで返す
    const base = datumBase(d, wallThickness);
    if (base === undefined) {
      return fail(DetailFrameError.UNSUPPORTED_DATUM, ERR_DETAIL_DATUM_UNSUPPORTED(d.id, `${d.role}・${d.axis}・${d.kind}`));
    }
    datums[d.id] = base;
  }
  return {
    targets: {
      datums,
      params: { [DetailParam.FRAME_FACE_WIDTH]: faceWidth, [DetailParam.FRAME_PROJECTION]: projection },
    },
  };
}

// 建具の姿図（正面図）が供給する基準の値（局所座標。s＝右向き正・t＝画面下向き正＝ペンの U が t−。t の 0 は窓台上端 SILL）。
//   s: OPENING_OUTER の origin＝0（coord1 側の開口端）・end＝開口幅
//   t: SILL の origin＝0（窓台上端）・FL の origin＝窓台高さ（FL は窓台の sill 下）・HEAD の end＝−高さ（窓台上端から上）
// 建具（fitting）は窓台高さ 0 なので SILL と FL は同じ位置。それ以外の組は未対応（undefined）。
function elevationDatumBase(d, { width, height, sill }) {
  if (d.role === DetailDatumRole.OPENING_OUTER && d.axis === DetailAxis.S) {
    if (d.kind === DetailDatumKind.ORIGIN) return 0;
    if (d.kind === DetailDatumKind.END) return width;
  }
  if (d.axis === DetailAxis.T && d.kind === DetailDatumKind.ORIGIN) {
    if (d.role === DetailDatumRole.SILL) return 0;
    if (d.role === DetailDatumRole.FL) return sill;
  }
  if (d.role === DetailDatumRole.HEAD && d.axis === DetailAxis.T && d.kind === DetailDatumKind.END) return -height;
  return undefined;
}

/**
 * 建具の姿図用の fitLocal の targets。datums は図の Datum.id をキーにする。param・material は供給しない
 * （姿図は寸法を幅・高さの基準だけで決める。param／material 束縛を含む図は fit が UNRESOLVED_* を返す）。
 * @param {object} fig DetailFigure
 * @param {{width:number, height:number, sill:number}} dims 開口幅・高さ・窓台高さ（mm）
 * @returns {{targets:{datums:Object<string,number>, params:{}}} | {error:{code:string, message:string}}}
 */
export function detailElevationTargets(fig, dims) {
  const datums = {};
  for (const d of Array.isArray(fig?.datums) ? fig.datums : []) {
    if (d === null || typeof d !== 'object') continue; // 形の不正は fit の検証（INVALID）が理由つきで返す
    const base = elevationDatumBase(d, dims);
    if (base === undefined) {
      return fail(DetailFrameError.UNSUPPORTED_DATUM,
        ERR_DETAIL_DATUM_UNSUPPORTED(d.id, `${d.role}・${d.axis}・${d.kind}`, DETAIL_TARGET_ELEVATION));
    }
    datums[d.id] = base;
  }
  return { targets: { datums, params: {} } };
}

/**
 * fit 済みの図を建具の姿図の座標（FL を y=0・上方は負）へ写す。局所の s＝x（開口の coord1 側が x=0）、t（下向き正）＝窓台上端
 * からの y。座標の向き（壁の座標昇順＝図の x 昇順）は buildOpeningElevation の正準向きで、鏡像は呼び出し側（展開・立面）が掛ける。
 * @param {{strokes: object[]}} fitted fitLocal の結果（error でないもの）
 * @param {{sillTop:number}} p sillTop＝窓台上端の y（−窓台高さ）
 * @returns {{id:string, points:number[][], closed:boolean, line:object, source:string}[]}
 */
export function placeDetailElevation(fitted, { sillTop }) {
  return placeStrokes(fitted, { ox: 0, oy: sillTop, sx: 1, sy: 0, tx: 0, ty: 1 });
}

/**
 * fit 済みの図を開口の両端へ写す。coord1 側は s が along の正方向、coord2 側は s 軸を反転した鏡像
 * （frameOnlyJambProfiles の dir 規約——coord2 側は内側が −along——と同じ）。t は faceMin を 0 として perp へ。
 * @param {{strokes: object[]}} fitted fitLocal の結果（error でないもの）
 * @param {{coord1:number, coord2:number, faceMin:number}} p
 * @returns {[{points:{along:number,perp:number}[], closed:boolean}[], {points:{along:number,perp:number}[], closed:boolean}[]]}
 *   [coord1 側のストローク列, coord2 側のストローク列]
 */
export function placeDetailSides(fitted, { coord1, coord2, faceMin }) {
  const side = (ox, sx) => placeStrokes(fitted, { ox, oy: faceMin, sx, sy: 0, tx: 0, ty: 1 })
    .map(st => ({ points: st.points.map(([along, perp]) => ({ along, perp })), closed: st.closed }));
  return [side(coord1, 1), side(coord2, -1)];
}
