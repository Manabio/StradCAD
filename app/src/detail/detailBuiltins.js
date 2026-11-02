// 本体標準の部分詳細図（共通詳細）。カタログ種別 detailFigure の loadBuiltin 先（S2）。
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis,
  DetailDash, DetailParam, DETAIL_FIGURE_VERSION, KNEE_CAP_THICKNESS_MM, DETAIL_BUILTIN_BASEBOARD_KEY, DETAIL_BUILTIN_KNEE_CAP_KEY,
} from '../core/constants.js';

/** 巾木 出 10（高さは部屋の巾木設定）の詳細図キー（床と壁の取り合い）。部屋に巾木高さがあれば割当て無しでも既定で使う（S8c）。 */
export const BASEBOARD_10_KEY = DETAIL_BUILTIN_BASEBOARD_KEY;
/** 巾木高さ param のプレビュー値（mm。fit が解決する値ではない。LenSpec.mm は正が必須）。 */
const BASEBOARD_PREVIEW_HEIGHT_MM = 60;

/** 天板 厚 20×（12＋壁厚＋12）の詳細図キー（腰壁の天端）。 */
export const KNEE_CAP_20_KEY = DETAIL_BUILTIN_KNEE_CAP_KEY;
/** 天板の出幅（mm。壁の仕上げ面から両側）。平面の天端（finish/kneeDropWall.js CAP_OVERHANG）の出幅 12 と同値。厚は core/constants.js の KNEE_CAP_THICKNESS_MM。 */
const KNEE_CAP_OVERHANG_MM = 12;
/** 壁厚 param のプレビュー値（mm。fit が解決する値ではない。LenSpec.mm は正が必須）。 */
const KNEE_CAP_PREVIEW_WALL_MM = 100;

const fixed = mm => ({ mm, mode: DetailLenMode.FIXED });

const baseboardHeight = { mm: BASEBOARD_PREVIEW_HEIGHT_MM, mode: DetailLenMode.PARAM, param: DetailParam.BASEBOARD_HEIGHT };

// 巾木 出 10: 壁の仕上げ面 (s=0)・床仕上げ面 (t=0) の角から、上へ 高さ（param＝部屋の巾木設定 h）・室内側へ 10・下へ 高さ の閉じた矩形。
const BASEBOARD_10 = Object.freeze({
  key: BASEBOARD_10_KEY,
  version: DETAIL_FIGURE_VERSION,
  label: '巾木 出 10（高さは部屋の巾木設定）',
  category: DetailCategory.JUNCTION,
  view: DetailView.SECTION,
  subject: DetailSubject.FLOOR_WALL,
  strokes: [{
    id: 'a',
    closed: true,
    line: { weightRole: 'medium', dashRole: DetailDash.SOLID },
    moves: [
      { dir: PenDir.UP, len: baseboardHeight },
      { dir: PenDir.RIGHT, len: fixed(10) },
      { dir: PenDir.DOWN, len: baseboardHeight },
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

// 天板 厚 20×（12＋壁厚＋12）: 表の側の天端の角 (s=+12, t=0) から、下へ 20 → 室内側と逆へ 12（固定）→ 壁厚（param）→ 12（固定）→ 上へ 20 の
// 閉じた矩形。s の origin（表の側の仕上げ面）＝壁厚の手の始点（s=0）、t の origin（腰壁の天端の面）＝始点（t=0）。
// 幅は壁厚の param で吸うので end の基準・伸縮は持たない（end の基準を置くと stretch が 1 本要る＝検証規則）。
const KNEE_CAP_20 = Object.freeze({
  key: KNEE_CAP_20_KEY,
  version: DETAIL_FIGURE_VERSION,
  label: `天板 厚 ${KNEE_CAP_THICKNESS_MM}×（${KNEE_CAP_OVERHANG_MM}＋壁厚＋${KNEE_CAP_OVERHANG_MM}）`,
  category: DetailCategory.PART,
  view: DetailView.SECTION,
  subject: DetailSubject.WALL,
  strokes: [{
    id: 'a',
    closed: true,
    line: { weightRole: 'medium', dashRole: DetailDash.SOLID },
    moves: [
      { dir: PenDir.DOWN, len: fixed(KNEE_CAP_THICKNESS_MM) },
      { dir: PenDir.LEFT, len: fixed(KNEE_CAP_OVERHANG_MM) },
      { dir: PenDir.LEFT, len: { mm: KNEE_CAP_PREVIEW_WALL_MM, mode: DetailLenMode.PARAM, param: DetailParam.WALL_THICKNESS } },
      { dir: PenDir.LEFT, len: fixed(KNEE_CAP_OVERHANG_MM) },
      { dir: PenDir.UP, len: fixed(KNEE_CAP_THICKNESS_MM) },
    ],
  }],
  datums: [
    { id: 'ds0', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
    { id: 'dt0', role: DetailDatumRole.WALL_TOP, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
  ],
  anchors: [
    { datumId: 'ds0', strokeId: 'a', vertexIndex: 2 },
    { datumId: 'dt0', strokeId: 'a', vertexIndex: 0 },
  ],
  provenance: null,
  note: null,
});

export default [BASEBOARD_10, KNEE_CAP_20];
