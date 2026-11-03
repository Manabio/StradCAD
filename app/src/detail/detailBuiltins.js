// 本体標準の部分詳細図（共通詳細）。カタログ種別 detailFigure の loadBuiltin 先（S2）。
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis,
  DetailDash, DetailParam, DETAIL_FIGURE_VERSION, KNEE_CAP_THICKNESS_MM, DETAIL_BUILTIN_BASEBOARD_KEY, DETAIL_BUILTIN_KNEE_CAP_KEY,
  DETAIL_BUILTIN_DOOR_JAMB_KEY, DETAIL_BUILTIN_DOOR_HEAD_KEY,
  FRAME_OVERHANG_MM, FRAME_JAMB_WIDTH_MM, FRAME_KAKARI_WIDTH_MM, DOOR_LEAF_THICKNESS_MM,
} from '../core/constants.js';

/** 巾木 出 10（高さは部屋の巾木設定）の詳細図キー（床と壁の取り合い）。部屋に巾木高さがあれば割当て無しでも既定で使う（S8c）。 */
export const BASEBOARD_10_KEY = DETAIL_BUILTIN_BASEBOARD_KEY;
/** 巾木高さ param のプレビュー値（mm。fit が解決する値ではない。LenSpec.mm は正が必須）。 */
const BASEBOARD_PREVIEW_HEIGHT_MM = 60;

/** 天板 厚 20×（12＋壁厚＋12）の詳細図キー（腰壁の天端）。 */
export const KNEE_CAP_20_KEY = DETAIL_BUILTIN_KNEE_CAP_KEY;
/** 天板の出幅（mm。壁の仕上げ面から両側）。平面の天端（finish/kneeDropWall.js CAP_OVERHANG）の出幅 12 と同値。厚は core/constants.js の KNEE_CAP_THICKNESS_MM。 */
const KNEE_CAP_OVERHANG_MM = 12;
/** 壁厚 param のプレビュー値（mm。fit が解決する値ではない。LenSpec.mm は正が必須）。天板・方立・上枠の組込み図が共有する。 */
const PREVIEW_WALL_MM = 100;

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
      { dir: PenDir.LEFT, len: { mm: PREVIEW_WALL_MM, mode: DetailLenMode.PARAM, param: DetailParam.WALL_THICKNESS } },
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

/** 枠の出幅 param のプレビュー値（mm。fit が解決する値ではない）。壁の面から室内外へ出る量の既定と同値。 */
const FRAME_PROJECTION_PREVIEW_MM = FRAME_OVERHANG_MM;
const frameProjection = { mm: FRAME_PROJECTION_PREVIEW_MM, mode: DetailLenMode.PARAM, param: DetailParam.FRAME_PROJECTION };
const stretch = mm => ({ mm, mode: DetailLenMode.STRETCH });
const openingOuterOrigin = { id: 'ds0', role: DetailDatumRole.OPENING_OUTER, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 };
const wallFaceTOrigin = { id: 'dt0', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 };
const wallFaceTEnd = { id: 'dt1', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.T, kind: DetailDatumKind.END, offsetMm: 0 };

// 片開き戸の方立（平面）。s＝開口端から内側へ、t＝壁厚方向で**扉が閉じる側（開く側の面・戸当たりの欠き込み側）が正**（t=0 は反対側の壁面、t=壁厚が開く側の面）。
// 図は 1 つで、開き勝手は取り付け側の t 反転で表す（openingDetailFrame.js placeDetailSides の tSign）。外形は 8 点:
//   (0,−出幅) → (30,−出幅) → (30,0)[t origin] → 伸縮 → (30,壁厚−扉厚) → (20,壁厚−扉厚) → (20,壁厚)[t end] → (20,壁厚+出幅) → (0,壁厚+出幅)。
// 共線の頂点 2 つ（t origin・t end）を除くと、従来の方立（openingPlanSymbol.js jambOutlinePoints）の六角形と同じ点列。
const DOOR_JAMB_30 = Object.freeze({
  key: DETAIL_BUILTIN_DOOR_JAMB_KEY,
  version: DETAIL_FIGURE_VERSION,
  label: `片開き戸の方立（見付 ${FRAME_JAMB_WIDTH_MM}・戸当たり ${FRAME_KAKARI_WIDTH_MM}）`,
  category: DetailCategory.PAIRED,
  view: DetailView.PLAN,
  subject: DetailSubject.JAMB,
  strokes: [{
    id: 'a',
    closed: true,
    line: { weightRole: 'medium', dashRole: DetailDash.SOLID },
    moves: [
      { dir: PenDir.RIGHT, len: fixed(FRAME_JAMB_WIDTH_MM) },
      { dir: PenDir.DOWN, len: frameProjection },
      { dir: PenDir.DOWN, len: stretch(PREVIEW_WALL_MM - DOOR_LEAF_THICKNESS_MM) },
      { dir: PenDir.LEFT, len: fixed(FRAME_KAKARI_WIDTH_MM) },
      { dir: PenDir.DOWN, len: fixed(DOOR_LEAF_THICKNESS_MM) },
      { dir: PenDir.DOWN, len: frameProjection },
      { dir: PenDir.LEFT, len: fixed(FRAME_JAMB_WIDTH_MM - FRAME_KAKARI_WIDTH_MM) },
    ],
  }],
  datums: [openingOuterOrigin, wallFaceTOrigin, wallFaceTEnd],
  anchors: [
    { datumId: 'ds0', strokeId: 'a', vertexIndex: 0 },
    { datumId: 'dt0', strokeId: 'a', vertexIndex: 2 },
    { datumId: 'dt1', strokeId: 'a', vertexIndex: 5 },
  ],
  provenance: null,
  note: null,
});

// 片開き戸の上枠（展開の断面。配線は S8e-2）。方立と同じ向き（t は開く側が正）。外形は 見付 30 × （出幅＋壁厚＋出幅）の閉じた矩形。
const DOOR_HEAD_30 = Object.freeze({
  key: DETAIL_BUILTIN_DOOR_HEAD_KEY,
  version: DETAIL_FIGURE_VERSION,
  label: `片開き戸の上枠（見付 ${FRAME_JAMB_WIDTH_MM}）`,
  category: DetailCategory.PAIRED,
  view: DetailView.SECTION,
  subject: DetailSubject.HEAD,
  strokes: [{
    id: 'a',
    closed: true,
    line: { weightRole: 'medium', dashRole: DetailDash.SOLID },
    moves: [
      { dir: PenDir.RIGHT, len: fixed(FRAME_JAMB_WIDTH_MM) },
      { dir: PenDir.DOWN, len: frameProjection },
      { dir: PenDir.DOWN, len: stretch(PREVIEW_WALL_MM) },
      { dir: PenDir.DOWN, len: frameProjection },
      { dir: PenDir.LEFT, len: fixed(FRAME_JAMB_WIDTH_MM) },
    ],
  }],
  datums: [openingOuterOrigin, wallFaceTOrigin, wallFaceTEnd],
  anchors: [
    { datumId: 'ds0', strokeId: 'a', vertexIndex: 0 },
    { datumId: 'dt0', strokeId: 'a', vertexIndex: 2 },
    { datumId: 'dt1', strokeId: 'a', vertexIndex: 3 },
  ],
  provenance: null,
  note: null,
});

export default [BASEBOARD_10, KNEE_CAP_20, DOOR_JAMB_30, DOOR_HEAD_30];
