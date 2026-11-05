// ================================================================
// 部分詳細図ヘルパー画面（ui/DetailHelperPanel.jsx）の純ロジック。
//   - フォーム（数値は入力欄の文字列のまま持つ）⇄ DetailFigure エントリの往復
//   - ペン操作（方向ボタン→手の追加・ペンを上げる）・下書き履歴（1 手戻し。undoManager には積まない）
//   - 手の長さ／mode・基準（Datum）・載せる頂点（Anchor）の編集
//   - 検証結果・保存ボタンの活性・試し込み（fit）・プレビュー用プリミティブ・ラベル表
// 判断は全部ここに置き、.jsx は配線だけにする。node:test から単体 import できる純モジュール
// （store.js・snap.js・appViewport.js・storage/・.jsx・react を（推移的にも）引かない。ui/detailHelperImportGraph.test.js で固定）。
//
// フォームの形:
//   { key, label, category, view, subject,
//     strokes: [{ id, closed, line, moves: [{ dir, mode, len:'100', param?, code?, field? } | { dir:'V', raw }] }],
//     datums:  [{ id, role, axis, kind, offset:'0' }],
//     anchors: [{ datumId, strokeId, vertexIndex, offsetMm? }],   // offsetMm は数値のまま（DXF から写した下書きだけが持つ）
//     extra:   { version, provenance, note, ...未知の項目 } }   // エントリのうち編集しない項目（前方互換で保持）
// 'V'（斜め）は S7（DXF 由来）で入る。UI では作れず、読んだ図はそのまま保持して往復させる。
// ================================================================

import {
  PenDir, DetailLenMode, DetailDatumRole, DetailDatumKind, DetailAxis, DetailParam,
  DetailMaterialField, DetailDash, DetailProvenanceSource, DETAIL_VIEW_COMBOS, DETAIL_FIGURE_VERSION,
  DETAIL_FIGURE_KEY_PREFIX, DETAIL_DEFAULT_WEIGHT_ROLE, DETAIL_DRAFT_HISTORY_MAX,
  DETAIL_SLOT_TARGETS, DetailSlot, DetailEdgeMark, ROOM_DETAIL_SLOTS, KNEE_DROP_DETAIL_SLOTS, DETAIL_FIT_DEFAULT_STEP_HEIGHT_MM, DETAIL_FIT_DEFAULT_BASEBOARD_HEIGHT_MM, DxfWarning, DxfReject, DXF_INSERT_DEPTH_MAX,
  DXF_PROVENANCE_FIELDS, DXF_PREVIEW_STYLE,
} from '../core/constants.js';
import { readDxf, buildDxfScene } from '../detail/dxf/dxfImport.js';
import { buildDxfProvenance, baseNameOf } from '../detail/dxf/dxfProvenance.js';
import { buildPdfProvenance } from '../detail/pdf/pdfProvenance.js';
import {
  WARN_DXF_UNIT_UNKNOWN, WARN_DXF_CONTOUR_OPEN, WARN_DXF_SELF_INTERSECT, WARN_DXF_LICENSE_UNKNOWN, WARN_DXF_INSERT_DEPTH,
  WARN_DXF_INSERT_CYCLE, WARN_DXF_UNSUPPORTED_ENTITY, WARN_DXF_NONUNIFORM_SCALE, WARN_DXF_ENTITY_LIMIT,
  WARN_DXF_SELF_INTERSECT_UNCHECKED, WARN_DXF_NO_DIGEST, MSG_IMPORTED_DELETE_IN_USE,
  ERR_DXF_BINARY, ERR_DXF_BAD_GROUP_CODE, ERR_DXF_TRUNCATED, ERR_DXF_UNEXPECTED, ERR_DXF_NOT_BYTES,
} from '../error.js';
import { validateDetailFigure, DetailValidationError } from '../detail/detailModel.js';
import { penWalk } from '../detail/detailPen.js';
import { previewPrimitives, airEdgeOverlays, datumGuidePrimitives, previewDimGap, PREVIEW_DIM_GAP_MM, PREVIEW_LABEL_OFFSET_MM, PREVIEW_LABEL_SIZE_PX } from '../detail/detailPreview.js';
import { fitLocal } from '../detail/detailPlacement.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import {
  formatDetailSubjectLabel, formatDetailViewLabel, formatCategoryLabel, categoryOptionsFor, rowEditState, planSaveEntry,
  formatDetailProvenance, isImportedFigure, IMPORTED_SOURCES, planRevertToBuiltin,
} from '../catalog/catalogMaintenance.js';
import { DEFAULT_FRAME_FACE_MM, DEFAULT_FRAME_PROJECTION_MM, findCatalogEntry } from '../openings/openingCatalog.js';
import { detailFrameTargets, detailElevationTargets } from '../openings/openingDetailFrame.js';
import { junctionTargets, partTargets, floorStepTargets, ceilingStepTargets } from '../finish/roomDetailTargets.js';
import { evalNumpadExpr } from './numpadUtils.js';
import { polyline, text } from '../structural/sectionFigure/svgFigurePrimitives.js';

// ---- ラベル表（全 enum 値を持つことをテストで固定する）----
export const DETAIL_ROLE_LABELS = Object.freeze({
  [DetailDatumRole.WALL_FINISH_FACE]: '壁の仕上げ面',
  [DetailDatumRole.WALL_AXIS]:        '壁芯',
  [DetailDatumRole.FL]:               'FL（床の仕上げ面）',
  [DetailDatumRole.CEILING_FACE]:     '天井面',
  [DetailDatumRole.WALL_TOP]:         '腰壁の天端',
  [DetailDatumRole.WALL_BOTTOM]:      '垂れ壁の下端',
  [DetailDatumRole.STEP_EDGE]:        '段差の立ち上がり面（平面・天伏の段差の線の位置）',
  [DetailDatumRole.GL]:               'GL',
  [DetailDatumRole.ROOF_SURFACE]:     '屋根面',
  [DetailDatumRole.EAVE_EDGE]:        '軒先',
  [DetailDatumRole.VERGE_EDGE]:       'けらば先',
  [DetailDatumRole.OPENING_OUTER]:    '開口端（外）',
  [DetailDatumRole.OPENING_INNER]:    '開口端（内）',
  [DetailDatumRole.SILL]:             '下端（窓台）',
  [DetailDatumRole.HEAD]:             '上端（まぐさ）',
  [DetailDatumRole.PLACEMENT_ORIGIN]: '配置原点',
});
export const DETAIL_MODE_LABELS = Object.freeze({
  [DetailLenMode.FIXED]:    '固定',
  [DetailLenMode.STRETCH]:  '伸縮',
  [DetailLenMode.PARAM]:    '寸法項目',
  [DetailLenMode.MATERIAL]: '材',
});
export const DETAIL_PARAM_LABELS = Object.freeze({
  [DetailParam.FRAME_FACE_WIDTH]: '枠の見付',
  [DetailParam.FRAME_PROJECTION]: '枠の出幅',
  [DetailParam.FRAME_DEPTH]:      '枠の見込み',
  [DetailParam.WALL_THICKNESS]:   '壁厚',
  [DetailParam.BASEBOARD_HEIGHT]: '巾木高さ',
});
export const DETAIL_MATERIAL_FIELD_LABELS = Object.freeze({
  [DetailMaterialField.THICKNESS]: '厚み',
  [DetailMaterialField.X]:         'x',
  [DetailMaterialField.Y]:         'y',
});
export const DETAIL_DATUM_KIND_LABELS = Object.freeze({
  [DetailDatumKind.ORIGIN]: '原点',
  [DetailDatumKind.END]:    '端',
});
export const DETAIL_AXIS_LABELS = Object.freeze({
  [DetailAxis.S]: '横（s）',
  [DetailAxis.T]: '縦（t）',
});
/** ペンの方向ボタン（表示順）。 */
export const PEN_BUTTONS = Object.freeze([
  Object.freeze({ dir: PenDir.UP,    label: '↑' }),
  Object.freeze({ dir: PenDir.LEFT,  label: '←' }),
  Object.freeze({ dir: PenDir.RIGHT, label: '→' }),
  Object.freeze({ dir: PenDir.DOWN,  label: '↓' }),
]);
/** 手の一覧に出す向きの記号（'V' は斜め＝UI では作れない）。 */
export const PEN_DIR_LABELS = Object.freeze({
  [PenDir.UP]: '↑', [PenDir.DOWN]: '↓', [PenDir.LEFT]: '←', [PenDir.RIGHT]: '→', [PenDir.VECTOR]: '斜め',
});
/** 画面の固定文言（ボタン・見出し）。1 か所に集める。 */
export const DETAIL_HELPER_TEXT = Object.freeze({
  title: '部分詳細', penUp: 'ペンを上げる', closeShape: '閉じる', openShape: '開く', undo: '1 手戻す',
  save: '保存', remove: '削除', duplicate: '複製', close: '閉じる', newDraft: '新規',
  addDatum: '基準を追加', fitOn: '試し込み', fitOff: '下書き',
  fieldLabel: '呼称', fieldCategory: '分類', fieldView: '向き', fieldSubject: '主題',
  datumHeading: '基準と載せる頂点', noAnchor: '（なし）', validOk: '検証: 問題なし', blankValue: '—',
  approveButton: '承認する',
  // 組込み層（S8d）。組込みは読み取り専用で出し、編集＝同キーのライブラリ項目（上書き）を作る。
  editOverride: '編集（上書きを作る）', revertToBuiltin: '組込みに戻す',
  revertTitle: '標準に戻しますか？', revertAlsoDoc: 'この文書の同梱も標準に合わせる',
  builtinReadOnly: '組込みの図です（読み取り専用）。「編集（上書きを作る）」で同じキーの上書きを作れます',
  originBadge: Object.freeze({ builtin: '組込み', user: 'ライブラリ', override: '上書き' }),
  docDiffBadgeTitle: 'この文書の同梱に、同じキーで内容の違う図があります（そのままでは保存できません）',
  docDiffBadge: '文書', // 同梱に同キーの別内容がある行（保存は止まる。保守パネルの doc-diff と同じ）
  airEdge: '空気との境目', // 手の印（Move.edge='air'）の切替。展開図で中線になる（S8a）
  // DXF 読込み（S7a）
  tabPen: 'ペン', tabDxf: '図面読込み（DXF／PDF）', dxfOpen: 'DXF／PDF を開く', dxfCopy: '下書きへ写す',
  dxfUnit: '単位（1 単位 = ? mm）', dxfUnitDetected: '読み取り値', dxfComponents: '連結成分', dxfProvenance: '出所',
  dxfMaker: 'メーカー', dxfSeries: 'シリーズ', dxfLicense: 'ライセンス注記', dxfWarnings: '警告',
  dxfNoComponents: '輪郭が見つかりません', dxfEmptyPreview: 'DXF／PDF を開くとここに表示されます',
  // PDF 読込み（S7b）
  pdfPage: 'ページ', pdfPrev: '前', pdfNext: '次', pdfPageCount: n => `／ ${n} ページ`, pdfScale: '縮尺 1/N の N',
  pdfClip: '範囲（pt。ページ左上が原点）', pdfClipFields: Object.freeze({ x: 'x', y: 'y', w: '幅', h: '高さ' }),
  pdfDragHint: 'ページ画像をドラッグして、写す範囲を選んでください', pdfExtract: '抽出', pdfNoPage: 'ページを読み込んでいます',
  // 矩形で成分を絞る（S7c。DXF・PDF 共通）
  pickHint: 'プレビューを長押ししてからドラッグして、矩形に収まる成分を選んでください', pickClear: '矩形を解除',
  // プレビューのズーム／パン（S7d）
  viewAll: '全体', viewFitRect: '矩形に寄せる',
  gestureHint: 'ドラッグ＝移動・長押し後のドラッグ＝矩形・ピンチ／ホイール＝拡大縮小',
  gestureHintPen: 'ドラッグ＝移動・ピンチ／ホイール＝拡大縮小',
  // 基準点を指す（S7d-4。ペン入力タブ）
  basePoint: '基準点を指す', basePointHint: '基準にしたい頂点をタップしてください（もう一度ボタンで解除）',
  basePointMiss: '近くに頂点がありません。頂点の近くをタップしてください',
  pickSummary: (inRect, total, selected) => `矩形内 ${inRect} ／ 全 ${total} 成分・選択 ${selected}`,
  // DXF のレイヤ on/off（S7d）
  layers: 'レイヤ', layersAllOn: '全部 on',
  dxfComponentLabel: n => `成分 ${n}`,
  dxfClosedLabel: '閉', dxfOpenLabel: '開', dxfVertexUnit: '頂点',
  // ストロークの線の役割（T2-2）
  lineRole: '線の役割', dashSolid: '実線', dashDashed: '破線', dashSwing: '開き勝手',
});
/** ストロークの線の役割（Line.dashRole）の表示名。 */
export const DETAIL_DASH_LABELS = Object.freeze({
  [DetailDash.SOLID]:  DETAIL_HELPER_TEXT.dashSolid,
  [DetailDash.DASHED]: DETAIL_HELPER_TEXT.dashDashed,
  [DetailDash.SWING]:  DETAIL_HELPER_TEXT.dashSwing,
});

/** 値が空なら「—」を返す表示用（手の長さ・距離・オフセットのボタン文言）。 */
export function displayLen(text) {
  return text === '' || text === null || text === undefined ? DETAIL_HELPER_TEXT.blankValue : String(text);
}
/** 「ストローク n」（n は 1 始まり）。 */
export const strokeLabel = strokeIndex => `ストローク ${strokeIndex + 1}`;
/** ストローク見出し（頂点は P0 始まり）。 */
export const strokeTitle = (strokeIndex, vertexCount) => `${strokeLabel(strokeIndex)}（P0〜P${vertexCount - 1}）`;
/** 手の区間表示（「P0 → P1」）。 */
export const moveSpanLabel = m => `P${m.fromVertex} ${m.dirLabel} P${m.toVertex}`;
/** 距離ボタンの文言。 */
export const distanceButtonLabel = penText => `${DETAIL_NUMPAD_LABELS.penDistance}: ${displayLen(penText)}`;
/** 基準のオフセットボタンの文言。 */
export const offsetButtonLabel = offset => `${DETAIL_NUMPAD_LABELS.offset} ${displayLen(offset)}`;
/** 試し込みの目標値ボタンの文言。 */
export const fitDimButtonLabel = (label, value) => `${label}: ${value}`;
/** ライブラリ行の分類表示。 */
export const libraryMetaLabel = row => `${row.categoryLabel} / ${row.viewLabel} / ${row.subjectLabel}`;
/** 壁厚の材一覧が読めなかったとき（既定値で代用中）の注記。読めていれば null。 */
export function wallThicknessNotice(materialLoadFailed) {
  return materialLoadFailed ? DETAIL_HELPER_MESSAGES.materialLoadFailed : null;
}

/** NumPad の見出し。 */
export const DETAIL_NUMPAD_LABELS = Object.freeze({
  penDistance: '距離', moveLen: '長さ', offset: 'オフセット', wallThickness: '壁厚', faceWidth: '見付', projection: '出幅',
  width: '幅', height: '高さ', sill: '窓台', stepHeight: '段差高', baseboardHeight: '巾木高さ',
});
/** 試し込みの目標値の欄（三方枠。順序＝表示順。field は defaultFitDims／tryFit の項目名）。 */
export const FIT_DIM_FIELDS = Object.freeze([
  Object.freeze({ field: 'wallThickness', label: DETAIL_NUMPAD_LABELS.wallThickness }),
  Object.freeze({ field: 'faceWidth', label: DETAIL_NUMPAD_LABELS.faceWidth }),
  Object.freeze({ field: 'projection', label: DETAIL_NUMPAD_LABELS.projection }),
]);
/** 試し込みの目標値の欄（建具の姿図）。 */
export const ELEVATION_FIT_DIM_FIELDS = Object.freeze([
  Object.freeze({ field: 'width', label: DETAIL_NUMPAD_LABELS.width }),
  Object.freeze({ field: 'height', label: DETAIL_NUMPAD_LABELS.height }),
  Object.freeze({ field: 'sill', label: DETAIL_NUMPAD_LABELS.sill }),
]);

/** 分類が建具の姿図（slot=figure の取り付け先: figure/elevation/opening）か。 */
export function isElevationFigureForm(form) {
  const t = DETAIL_SLOT_TARGETS[DetailSlot.FIGURE];
  return form?.category === t.category && form?.view === t.view && form?.subject === t.subject;
}
/** 試し込みの目標値の欄（部屋の取り合い。壁厚だけ）。 */
export const JUNCTION_FIT_DIM_FIELDS = Object.freeze([FIT_DIM_FIELDS[0]]);

/** 分類が部屋の取り合い（junction/section/床と壁・壁と天井）なら、その slot（DetailSlot の floorWall／wallCeiling）。違えば null。 */
export function junctionSlotOf(form) {
  return ROOM_DETAIL_SLOTS.find(slot => {
    const t = DETAIL_SLOT_TARGETS[slot];
    return form?.category === t.category && form?.view === t.view && form?.subject === t.subject;
  }) ?? null;
}
/**
 * 分類が腰壁・垂れ壁の部位（part/section/wall。S8b-1）なら試し込みに使う slot。腰壁の天端（kneeTop）と垂れ壁の下端（dropBottom）は
 * 同じ分類なので、図の基準の役割で見分ける（t の基準に WALL_BOTTOM があれば dropBottom、無ければ kneeTop）。違えば null。
 */
export function partSlotOf(form) {
  const t = DETAIL_SLOT_TARGETS[DetailSlot.KNEE_TOP];
  if (!(form?.category === t.category && form?.view === t.view && form?.subject === t.subject)) return null;
  return (form.datums ?? []).some(d => d?.role === DetailDatumRole.WALL_BOTTOM) ? DetailSlot.DROP_BOTTOM : DetailSlot.KNEE_TOP;
}
/** 試し込みの目標値の欄（床の段差の部位。段差高だけ）。 */
export const FLOOR_STEP_FIT_DIM_FIELDS = Object.freeze([
  Object.freeze({ field: 'stepHeight', label: DETAIL_NUMPAD_LABELS.stepHeight }),
]);
/** 分類が床の段差の部位（slot=floorStep の取り合わせ先: part/section/floor。S8b-3）か。 */
export function isFloorStepForm(form) {
  const t = DETAIL_SLOT_TARGETS[DetailSlot.FLOOR_STEP];
  return form?.category === t.category && form?.view === t.view && form?.subject === t.subject;
}
/** 分類が天井の段差の部位（slot=ceilingStep の取り合わせ先: part/section/ceiling。S8b-4a。試し込みの欄は床の段差と同じ段差高）か。 */
export function isCeilingStepForm(form) {
  const t = DETAIL_SLOT_TARGETS[DetailSlot.CEILING_STEP];
  return form?.category === t.category && form?.view === t.view && form?.subject === t.subject;
}
/** 試し込みの目標値の欄（床と壁の取り合いで、図が巾木高さの param を使うとき。壁厚＋巾木高さ。S8c）。 */
export const BASEBOARD_FIT_DIM_FIELDS = Object.freeze([
  JUNCTION_FIT_DIM_FIELDS[0],
  Object.freeze({ field: 'baseboardHeight', label: DETAIL_NUMPAD_LABELS.baseboardHeight }),
]);
/** 床と壁の取り合い（floorWall）の図で、手の長さに巾木高さの param（baseboardHeight）を使っているか。 */
export function usesBaseboardHeightParam(form) {
  return junctionSlotOf(form) === DetailSlot.FLOOR_WALL
    && (form?.strokes ?? []).some(s => (s?.moves ?? []).some(m => m?.mode === DetailLenMode.PARAM && m.param === DetailParam.BASEBOARD_HEIGHT));
}
/** 現在の分類に合う試し込みの欄。 */
export const fitDimFieldsFor = form => (isElevationFigureForm(form) ? ELEVATION_FIT_DIM_FIELDS
  : isFloorStepForm(form) || isCeilingStepForm(form) ? FLOOR_STEP_FIT_DIM_FIELDS
    : usesBaseboardHeightParam(form) ? BASEBOARD_FIT_DIM_FIELDS
      : junctionSlotOf(form) || partSlotOf(form) ? JUNCTION_FIT_DIM_FIELDS : FIT_DIM_FIELDS);
/** 保存・破棄・削除の確認の文言。 */
export const DETAIL_HELPER_MESSAGES = Object.freeze({
  saved: '保存しました',
  reverted: '組込みに戻しました',
  revertNotBuiltin: '組込みの図ではないため、組込みに戻せません',
  revertNoOverride: '上書きがないため、組込みに戻せません',
  revertFailed: '組込みに戻す処理に失敗しました: ',
  noop: '変更はありません',
  discard: '保存していない変更があります。破棄して続けますか？',
  discardButton: '破棄して続ける',
  cancelButton: 'キャンセル',
  confirmDeleteButton: '削除',
  emptyPreview: 'ペンで線を描くとここに表示されます',
  materialLoadFailed: '材の一覧を読み込めなかったため、壁厚は既定値で代用中です',
  confirmSyncTitle: 'この文書の同梱を外して保存します。変更項目: ',
  dxfUnitInvalid: '単位は 0 より大きい数で入力してください',
  dxfNothingSelected: '写す輪郭を一覧から選んでください',
  dxfNothingToCopy: '選んだ成分に写せる線がありません',
  pdfPageInvalid: 'ページは 1 以上の整数で入力してください',
  pdfClipInvalid: '範囲は数値で、幅・高さは 0 より大きくしてください',
  pdfNeedClip: '写す範囲をページ画像のドラッグか数値で指定してください',
});

/** ラベル表 → select の選択肢（{value,label}[]）。 */
export function labelOptions(table) {
  return Object.entries(table).map(([value, label]) => ({ value, label }));
}

/** 保存プラン（planSaveEntry の結果）→ 書き込むか・表示する文言。 */
export function saveDecision(plan) {
  if (!plan.ok) return { apply: false, message: plan.message, isError: true };
  if (plan.noop) return { apply: false, message: DETAIL_HELPER_MESSAGES.noop, isError: false };
  return {
    apply: true, message: DETAIL_HELPER_MESSAGES.saved, isError: false,
    // 使用中の同梱を外して保存するとき（doc-same／doc-override）は、変更項目を示して確認する。
    confirmMessage: plan.needsConfirm ? confirmPairsMessage(plan.confirmPairs) : null,
  };
}

/** 同梱を外して保存する確認文（変更項目の名前を並べる。値は大きな構造なので出さない）。 */
export function confirmPairsMessage(pairs) {
  return `${DETAIL_HELPER_MESSAGES.confirmSyncTitle}${pairs.map(p => p.label).join('、')}`;
}

/**
 * 保存の文脈: 開いている図（prevEntry）の行状態を、保守パネルと同じ rowEditState で求める。
 * docKeys＝文書同梱に同じキーがあるキーの集合、diffMap＝docDiffMap(kind, [])（同梱とライブラリの差）。
 * 同梱にも同じキーがあって内容が同じ（doc-same）なら保存で同梱を外す（planSaveEntry が removeDocKey を返す）。
 * 編集できない状態（同梱の内容がライブラリと違う doc-diff）は blocked に理由を返す。新規（prevEntry なし）は rowState=null。
 * 組込み層（S8d）: builtinList（組込みの図）を渡すと、組込みの図を開いて保存する行は rowState='builtin'、
 * ライブラリの同キー（上書き）は 'override' になる。userKeys＝ライブラリに同キーがあるキーの集合
 * （省略は「doc でなければライブラリ」＝従来どおり）。
 * @returns {{rowState: string|null, blocked: string|null}}
 */
export function saveContextFor(prevEntry, { docKeys, diffMap, userKeys = null, builtinList = [] }) {
  if (!prevEntry) return { rowState: null, blocked: null };
  const builtinKeys = new Set(builtinList.map(e => e.key));
  const key = prevEntry.key;
  let origin = 'user';
  if (docKeys.has(key)) origin = 'doc';
  else if (builtinKeys.has(key) && userKeys && !userKeys.has(key)) origin = 'builtin';
  const st = rowEditState(
    CatalogKind.DETAIL_FIGURE,
    { entry: prevEntry, origin, diff: null },
    { diffMap, builtinKeys },
  );
  return { rowState: st.state, blocked: st.canEdit ? null : st.reason };
}

/**
 * 保存プランを作る（planSaveEntry に行状態を添える唯一の入口）。編集できない行状態は { ok:false, message } にする。
 * @param {object} entry 保存するエントリ
 * @param {object|null} prevEntry 開いている図（新規は null）
 * @param {{docKeys: Set<string>, diffMap: Map, userKeys?: Set<string>|null, builtinList?: object[]}} docContext 文書同梱のキー集合・docDiffMap・ライブラリのキー集合・組込みの図
 */
export function planSave(entry, prevEntry, docContext) {
  const ctx = saveContextFor(prevEntry, docContext);
  if (ctx.blocked) return { ok: false, message: ctx.blocked };
  // 組込みと同キーなら planSaveEntry が overridesBuiltin:true を付ける（上書き）。同一内容は noop（変更なし）。
  return planSaveEntry(CatalogKind.DETAIL_FIGURE, entry, { prevEntry, rowState: ctx.rowState, builtinList: docContext.builtinList ?? [] });
}

/**
 * 文書同梱・ライブラリ・組込みの文脈（planSave の第 3 引数）。overlayFor／docDiffMap は呼び出し側が注入する
 * （この純モジュールは catalogRegistry を引かない）。builtinList は組込みの図（省略は組込みなし）。
 */
export function docContextFor(kind, { overlayFor, docDiffMap, builtinList = [] }) {
  const overlay = overlayFor(kind);
  return {
    docKeys: new Set(overlay.doc.map(e => e.key)), diffMap: docDiffMap(kind, builtinList),
    userKeys: new Set((overlay.user ?? []).map(e => e.key)), builtinList,
  };
}

/** 一覧の出所（組込み層。S8d）。 */
export const LIBRARY_ORIGIN = Object.freeze({ BUILTIN: 'builtin', USER: 'user', OVERRIDE: 'override' });
/** キーの出所: ライブラリにあれば（組込みにも同キーなら上書き）、無くて組込みにあれば組込み、どちらも無ければ null。 */
export function libraryOriginOf(key, { builtinKeys, userKeys }) {
  if (userKeys.has(key)) return builtinKeys.has(key) ? LIBRARY_ORIGIN.OVERRIDE : LIBRARY_ORIGIN.USER;
  return builtinKeys.has(key) ? LIBRARY_ORIGIN.BUILTIN : null;
}
/**
 * 出所ごとに許す操作（保守パネルと同じ rowEditState から導く）。組込み＝読み取り専用で「編集」と「複製」だけ（needsUnlock）、
 * 上書き＝編集・組込みに戻す・複製（削除は戻すに置き換え）、ライブラリ＝編集・削除・複製。
 */
export function libraryRowActions(origin, entry, builtinKeys) {
  const st = rowEditState(
    CatalogKind.DETAIL_FIGURE,
    { entry, origin: origin === LIBRARY_ORIGIN.BUILTIN ? 'builtin' : 'user', diff: null },
    { builtinKeys },
  );
  return {
    state: st.state, needsUnlock: st.state === 'builtin',
    canRevert: st.canRevert, canDelete: st.canDelete, canDuplicate: st.canDuplicate,
  };
}
/** 一覧に出すエントリ: ライブラリの同キーがあればそれ、無ければ組込み。 */
export function libraryEntryOf(key, { userEntries, builtinList }) {
  return userEntries.find(e => e.key === key) ?? builtinList.find(e => e.key === key) ?? null;
}
/** 組込みに戻すプラン。組込みでない・上書きが無いキーは失敗文言（planRevertToBuiltin は黙って空振りするため先に検査する）。 */
export function planRevert(key, { builtinKeys, userKeys, alsoRealignDoc = true }) {
  if (!builtinKeys.has(key)) return { ok: false, message: DETAIL_HELPER_MESSAGES.revertNotBuiltin };
  if (!userKeys.has(key)) return { ok: false, message: DETAIL_HELPER_MESSAGES.revertNoOverride };
  return { ok: true, plan: planRevertToBuiltin(CatalogKind.DETAIL_FIGURE, key, { alsoRealignDoc }) };
}

// ---- doc（パネルが持つ { form, history, baseline, prevEntry, penError? }）の組み立て ----
/** 新規の下書き（基準＝そのフォーム＝未編集）。 */
export function freshDocOf(form) {
  return { form, history: [], baseline: form, prevEntry: null };
}
/** ライブラリの図を開いた doc（基準＝開いた直後のフォーム）。 */
export function docFromEntry(entry, { readOnly = false } = {}) {
  const form = formFromEntry(entry);
  return { form, history: [], baseline: form, prevEntry: entry, ...(readOnly ? { readOnly: true } : {}) };
}
/** 組込みの図を読み取り専用で開いた doc を、編集できる状態にする（保存は同キーの上書きになる）。 */
export function unlockDoc(doc) {
  return doc.readOnly ? { ...doc, readOnly: false } : doc;
}
/** 一覧の行を開く doc: 組込み（ライブラリに同キーが無い）は読み取り専用、他は編集可。 */
export function docForLibraryEntry(entry, origin) {
  return docFromEntry(entry, { readOnly: origin === LIBRARY_ORIGIN.BUILTIN });
}
/** 複製の doc: 別キー・基準なし（baseline=null＝常に未保存）・ライブラリの図に紐づかない（prevEntry=null）。 */
export function duplicateDoc(doc, { idFactory }) {
  return { form: duplicateForm(doc.form, { idFactory }), history: [], baseline: null, prevEntry: null };
}
/** 削除の完了を doc へ反映する。削除中に別の図へ切り替わっていた（開いている図が key と違う）なら doc をそのまま返す。 */
export function afterDeleteDoc(doc, key, fresh) {
  return doc.prevEntry?.key === key ? fresh : doc;
}
/** ペン入力の失敗表示を消す（他の編集・1 手戻しの後に古いエラーを残さない）。 */
export function clearPenError(doc) {
  return doc.penError ? { ...doc, penError: null } : doc;
}

/** 保存の完了を doc へ反映する。保存中に別の図へ切り替わっていた（key が違う）なら何も変えない。 */
export function afterSaveDoc(doc, entry, form) {
  if (doc.form.key !== entry.key) return doc;
  return { ...doc, baseline: form, prevEntry: entry };
}

/** 削除の確認文。使用中（文書が参照している）なら同梱へ写すこと、未保存の編集があれば破棄されることを添える。 */
export function deleteConfirmMessage({ label, used, dirty, entry = null }) {
  const imported = isImportedFigure(entry);
  const parts = [`「${label}」をライブラリから削除します。`];
  // DXF・PDF 由来の図は文書の同梱へ写せない（保存ファイルに入らない）ので、同梱へ写す文言ではなく専用の文で告げる。
  if (used && imported) parts.push(MSG_IMPORTED_DELETE_IN_USE);
  else if (used) parts.push('この文書が使用中のため、文書の同梱へ写します（文書は未保存扱いになります）。');
  if (dirty) parts.push('編集中の内容は破棄されます。');
  return parts.join('');
}

/** 試し込みのプレビュー枠（px。AutoScaledFigure の maxWidth/maxHeight）。 */
export const PREVIEW_FRAME_PX = Object.freeze({ width: 560, height: 480 });

// フォーム内の id の接頭辞（一意なら何でもよい。DetailFigure の stroke.id・datum.id）。
const STROKE_ID_PREFIX = 's';
const DATUM_ID_PREFIX = 'd';
// 新しい基準の role の既定（軸ごと。三方枠が供給できる組＝openings/openingDetailFrame.js）。
const DEFAULT_ROLE_BY_AXIS = Object.freeze({
  [DetailAxis.S]: DetailDatumRole.OPENING_OUTER,
  [DetailAxis.T]: DetailDatumRole.WALL_FINISH_FACE,
});

/**
 * 基準の role の既定。三方枠系は軸ごと（DEFAULT_ROLE_BY_AXIS）。建具の姿図は s＝開口端（origin/end とも）・
 * t＝origin が SILL・end が HEAD（detailElevationTargets が供給できる組）。
 */
export function defaultRoleFor(form, axis, kind) {
  if (isElevationFigureForm(form) && axis === DetailAxis.T) {
    return kind === DetailDatumKind.END ? DetailDatumRole.HEAD : DetailDatumRole.SILL;
  }
  // 床の段差の部位（part/section/floor）: s は立ち上がり面・t は FL（高い側の床。end は低い側の床）
  if (isFloorStepForm(form)) return axis === DetailAxis.S ? DetailDatumRole.STEP_EDGE : DetailDatumRole.FL;
  // 天井の段差の部位（part/section/ceiling）: s は立ち上がり面・t は CEILING_FACE（低い側の天井面。end は高い側の天井面）
  if (isCeilingStepForm(form)) return axis === DetailAxis.S ? DetailDatumRole.STEP_EDGE : DetailDatumRole.CEILING_FACE;
  // 腰壁・垂れ壁の部位（part/section/wall）の t の origin は腰壁の天端の面（垂れ壁の下端にしたい図は基準の役割を選び直す）
  if (partSlotOf(form) && axis === DetailAxis.T && kind === DetailDatumKind.ORIGIN) return DetailDatumRole.WALL_TOP;
  return DEFAULT_ROLE_BY_AXIS[axis];
}

// 式の評価値を文字列にするときの丸め（1e-6 mm 単位。0.1+0.2 → '0.3' のような浮動小数の尾を落とす）。
const PEN_LEN_ROUND = 1e6;
const ALL_DIRS =new Set([PenDir.UP, PenDir.DOWN, PenDir.LEFT, PenDir.RIGHT]);
const ALL_LEN_MODES = new Set(Object.values(DetailLenMode));

const defaultLine = () => ({ weightRole: DETAIL_DEFAULT_WEIGHT_ROLE, dashRole: DetailDash.SOLID });

function nextId(prefix, ids) {
  const used = new Set(ids);
  let n = used.size + 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** 入力欄の文字列（または数値）→ mm。数値か四則演算の式。読めなければ NaN（符号・0 はそのまま返す。判定は呼び出し側）。 */
export function parseNumberText(value) {
  if (typeof value === 'number') return value;
  return evalNumpadExpr(String(value ?? ''), { positiveOnly: false });
}

// ================================================================
// フォーム ⇄ エントリ
// ================================================================

function originDatum(form, axis) {
  return { id: nextId(DATUM_ID_PREFIX, form.datums.map(d => d.id)), role: defaultRoleFor(form, axis, DetailDatumKind.ORIGIN), axis, kind: DetailDatumKind.ORIGIN, offset: '0' };
}

/** 新規の下書き。キーは接頭辞＋idFactory()（呼び出し側が crypto.randomUUID を渡す）。分類は組合せ表の先頭。基準は軸ごとの原点 2 つ。 */
export function newDraft({ idFactory }) {
  const first = DETAIL_VIEW_COMBOS[0];
  let form = {
    key: `${DETAIL_FIGURE_KEY_PREFIX}${idFactory()}`,
    label: '',
    category: first.category, view: first.view, subject: first.subject,
    strokes: [], datums: [], anchors: [],
    extra: { version: DETAIL_FIGURE_VERSION, provenance: { source: DetailProvenanceSource.MANUAL }, note: null },
  };
  for (const axis of [DetailAxis.S, DetailAxis.T]) form = { ...form, datums: [...form.datums, originDatum(form, axis)] };
  return form;
}

function formMoveOf(move) {
  if (move?.dir === PenDir.VECTOR) return { dir: PenDir.VECTOR, raw: move };
  const { len, ...rest } = move ?? {};
  const out = { ...rest, mode: len?.mode, len: len?.mm == null ? '' : String(len.mm) };
  if (len?.mode === DetailLenMode.PARAM) out.param = len.param;
  if (len?.mode === DetailLenMode.MATERIAL) { out.code = len.code; out.field = len.field; }
  return out;
}

function entryMoveOf(fm) {
  if (fm.dir === PenDir.VECTOR) return fm.raw;
  const { mode, len: lenText, param, code, field, ...rest } = fm;
  const len = { mm: parseNumberText(lenText), mode };
  if (mode === DetailLenMode.PARAM) len.param = param;
  if (mode === DetailLenMode.MATERIAL) { len.code = code; len.field = field; }
  return { ...rest, len };
}

/** カタログのエントリ → フォーム。数値は String() で文字列にする。エントリが持つ未知の項目は extra に保つ。 */
export function formFromEntry(entry) {
  const { key, label, category, view, subject, strokes, datums, anchors, ...extra } = entry;
  return {
    key, label: label ?? '', category, view, subject,
    strokes: (strokes ?? []).map(s => ({ ...s, line: s.line ?? defaultLine(), closed: s.closed ?? false, moves: (s.moves ?? []).map(formMoveOf) })),
    datums: (datums ?? []).map(d => {
      const { offsetMm, ...rest } = d;
      return { ...rest, offset: offsetMm == null ? '0' : String(offsetMm) };
    }),
    anchors: (anchors ?? []).map(a => ({ ...a })),
    extra,
  };
}

/** フォーム → カタログのエントリ（文字列の数値は parseNumberText で数値へ。読めない欄は NaN になり検証が理由を返す）。 */
export function entryFromForm(form) {
  // DXF・PDF 由来の出所は、編集中の生の入力を保存形（trim 済み）へ揃える。
  const extra = isImportedProvenance(form.extra?.provenance)
    ? { ...form.extra, provenance: normalizedProvenance(form.extra.provenance) }
    : form.extra;
  return {
    ...extra,
    key: form.key, label: form.label, category: form.category, view: form.view, subject: form.subject,
    strokes: form.strokes.map(s => ({ ...s, moves: s.moves.map(entryMoveOf) })),
    datums: form.datums.map(d => {
      const { offset, ...rest } = d;
      return { ...rest, offsetMm: parseNumberText(offset) };
    }),
    anchors: form.anchors.map(a => ({ ...a })),
  };
}

/** 複製: 別キーの下書きへ（呼び出し名は「のコピー」を付けて、同内容・同呼称の重複禁止に当たらないようにする）。 */
export function duplicateForm(form, { idFactory, copySuffix = ' のコピー' }) {
  return { ...form, key: `${DETAIL_FIGURE_KEY_PREFIX}${idFactory()}`, label: `${form.label}${copySuffix}` };
}

/** 未保存の変更があるか（基準＝最後に保存／開いた時点のフォーム）。 */
export function isDraftDirty(form, baseline) {
  return JSON.stringify(form) !== JSON.stringify(baseline);
}

// ================================================================
// 下書き履歴（1 手戻し）
// ================================================================

/** 履歴（古い→新しい）へ現在のフォームを積む。上限を超えたら古いものから捨てる。 */
export function pushHistory(history, form) {
  const next = [...history, form];
  return next.length > DETAIL_DRAFT_HISTORY_MAX ? next.slice(next.length - DETAIL_DRAFT_HISTORY_MAX) : next;
}

/** 1 手戻す。履歴が空なら null。 */
export function undoDraft(history) {
  if (history.length === 0) return null;
  return { form: history[history.length - 1], history: history.slice(0, -1) };
}

// ================================================================
// ペン
// ================================================================

function addStroke(form) {
  const id = nextId(STROKE_ID_PREFIX, form.strokes.map(s => s.id));
  const originAnchors = form.datums
    .filter(d => d.kind === DetailDatumKind.ORIGIN)
    .map(d => ({ datumId: d.id, strokeId: id, vertexIndex: 0 }));
  return { ...form, strokes: [...form.strokes, { id, closed: false, line: defaultLine(), moves: [] }], anchors: [...form.anchors, ...originAnchors] };
}

/**
 * 方向ボタン: 最後のストロークの末尾へ固定の手を足す。距離は数値か四則演算の式（NumPad の入力）。
 * @returns {{form: object} | {error: string}}
 */
export function applyPen(form, dir, lenText) {
  if (!ALL_DIRS.has(dir)) return { error: `未知の方向です: ${String(dir)}` };
  const raw = String(lenText ?? '').trim();
  if (raw === '') return { error: '距離を入力してください' };
  const mm = evalNumpadExpr(raw, { positiveOnly: false });
  if (Number.isNaN(mm)) return { error: '距離は数値か四則演算の式で入力してください' };
  if (mm < 0) return { error: '距離は正の数で入力してください（向きは方向ボタンで決まります）' };
  if (mm === 0) return { error: '距離は 0 より大きい数で入力してください' };
  const base = form.strokes.length === 0 ? addStroke(form) : form;
  const last = base.strokes.length - 1;
  const strokes = base.strokes.map((s, i) => (i === last
    ? { ...s, moves: [...s.moves, { dir, mode: DetailLenMode.FIXED, len: String(Math.round(mm * PEN_LEN_ROUND) / PEN_LEN_ROUND) }] }
    : s));
  return { form: { ...base, strokes } };
}

/**
 * 方向ボタンの 1 手を doc（{form, history, ...}）へ適用する。現在の doc から計算するので連打でも取りこぼさない。
 * 成功なら履歴へ積んで penError を消し、失敗なら form を変えず penError に理由を入れる。
 */
export function penStep(doc, dir, lenText) {
  const r = applyPen(doc.form, dir, lenText);
  if (r.error) return { ...doc, penError: r.error };
  return { ...doc, form: r.form, history: pushHistory(doc.history, doc.form), penError: null };
}

/** ペンを上げる: 次のストロークを始める（最後のストロークがまだ空なら何もしない）。origin の Anchor は各ストロークの頂点 0 を既定にする。 */
export function penUp(form) {
  const last = form.strokes[form.strokes.length - 1];
  if (!last || last.moves.length === 0) return form;
  return addStroke(form);
}

/** ストロークを閉じる／開く。閉じ辺は描画側が補う（始点へ戻る手は書かない）。 */
export function setClosed(form, strokeId, closed) {
  return { ...form, strokes: form.strokes.map(s => (s.id === strokeId ? { ...s, closed: Boolean(closed) } : s)) };
}

/** ストロークの線の役割を変える。未知の役割・無い strokeId は form を変えずそのまま返す（setMoveMode と同じ）。line の他の項目は残す。 */
export function setDashRole(form, strokeId, dashRole) {
  if (!Object.values(DetailDash).includes(dashRole)) return form;
  if (!form.strokes.some(s => s.id === strokeId)) return form;
  return { ...form, strokes: form.strokes.map(s => (s.id === strokeId ? { ...s, line: { ...(s.line ?? defaultLine()), dashRole } } : s)) };
}

// ================================================================
// 手の編集（editKey = { strokeId, moveIndex }。プレビューの dim と一覧が共通で持つ）
// ================================================================

function mapMove(form, editKey, fn) {
  let changed = false;
  const strokes = form.strokes.map(s => {
    if (s.id !== editKey?.strokeId || !s.moves[editKey.moveIndex]) return s;
    changed = true;
    return { ...s, moves: s.moves.map((m, i) => (i === editKey.moveIndex ? fn(m) : m)) };
  });
  return changed ? { ...form, strokes } : form;
}

/** 手の長さ（入力欄の文字列）を書き換える。editKey の手だけが変わる。斜め（V）は変えない。 */
export function setMoveLen(form, editKey, lenText) {
  return mapMove(form, editKey, m => (m.dir === PenDir.VECTOR ? m : { ...m, len: String(lenText ?? '') }));
}

/** 手の mode を変える。param は参照先、material は材コードと項目を opts で指定（省略時は既存値→既定）。 */
export function setMoveMode(form, editKey, mode, { param, code, field } = {}) {
  if (!ALL_LEN_MODES.has(mode)) return form;
  return mapMove(form, editKey, m => {
    if (m.dir === PenDir.VECTOR) return m;
    // 手の未知の項目は残し、mode に属する param／code／field だけを付け外しする。
    const next = { ...m, mode };
    delete next.param;
    delete next.code;
    delete next.field;
    if (mode === DetailLenMode.PARAM) next.param = param ?? m.param ?? DetailParam.FRAME_FACE_WIDTH;
    if (mode === DetailLenMode.MATERIAL) {
      next.code = code ?? m.code ?? '';
      next.field = field ?? m.field ?? DetailMaterialField.THICKNESS;
    }
    return next;
  });
}

/**
 * 手の「空気との境目」の印を付け外しする（S8a）。mark が DetailEdgeMark の値なら付け、null・未知の値なら外す
 * （外すときはキー自体を消す＝印なしの図は byte 不変）。斜め（V）は raw の手に付ける。editKey の手だけが変わる。
 */
export function setMoveEdge(form, editKey, mark) {
  const on = Object.values(DetailEdgeMark).includes(mark);
  const apply = o => {
    const next = { ...o };
    if (on) next.edge = mark; else delete next.edge;
    return next;
  };
  return mapMove(form, editKey, m => (m.dir === PenDir.VECTOR ? { ...m, raw: apply(m.raw) } : apply(m)));
}

/** 命令一覧の行（ストロークごとの見出し付き）。表示用の文字列はここで作る。 */
export function moveRows(form) {
  return form.strokes.map((s, strokeIndex) => ({
    strokeId: s.id, strokeIndex, closed: s.closed, dashRole: s.line?.dashRole ?? DetailDash.SOLID, vertexCount: s.moves.length + 1,
    moves: s.moves.map((m, moveIndex) => ({
      editKey: { strokeId: s.id, moveIndex },
      dir: m.dir, dirLabel: PEN_DIR_LABELS[m.dir] ?? String(m.dir),
      isVector: m.dir === PenDir.VECTOR,
      mode: m.mode, lenText: m.len, param: m.param, code: m.code, field: m.field,
      edge: (m.dir === PenDir.VECTOR ? m.raw?.edge : m.edge) ?? null,
      fromVertex: moveIndex, toVertex: moveIndex + 1,
    })),
  }));
}

// ================================================================
// 基準（Datum）・載せる頂点（Anchor）
// ================================================================

/** 基準を足す（既定は縦軸の端。軸・種別・role は後から select で変える）。原点を足したときは全ストロークの頂点 0 に載せる。 */
export function addDatum(form, { axis = DetailAxis.T, kind = DetailDatumKind.END, role } = {}) {
  const id = nextId(DATUM_ID_PREFIX, form.datums.map(d => d.id));
  const datum = { id, role: role ?? defaultRoleFor(form, axis, kind), axis, kind, offset: '0' };
  const anchors = kind === DetailDatumKind.ORIGIN
    ? [...form.anchors, ...form.strokes.map(s => ({ datumId: id, strokeId: s.id, vertexIndex: 0 }))]
    : form.anchors;
  return { ...form, datums: [...form.datums, datum], anchors };
}

/** 基準を消す（その基準を指す Anchor も消す）。 */
export function removeDatum(form, datumId) {
  return { ...form, datums: form.datums.filter(d => d.id !== datumId), anchors: form.anchors.filter(a => a.datumId !== datumId) };
}

const DATUM_FIELDS = new Set(['role', 'axis', 'kind', 'offset']);

/** 基準の項目（role・axis・kind・offset）を書き換える。 */
export function setDatumField(form, datumId, field, value) {
  if (!DATUM_FIELDS.has(field)) return form;
  return { ...form, datums: form.datums.map(d => (d.id === datumId ? { ...d, [field]: String(value ?? '') } : d)) };
}

/** 基準にストロークの頂点を載せる。vertexIndex が null／'' なら外す。ストローク・基準が無ければ何もしない。
 *  既知の限界: プレビュー値（len.mm）で歩くので、old と new の間に param・material の手があると fit では解決値との差だけずれる
 *  （DXF 由来の図は全部 fixed なので実害なし）。 */
export function setAnchor(form, strokeId, datumId, vertexIndex) {
  if (!form.strokes.some(s => s.id === strokeId) || !form.datums.some(d => d.id === datumId)) return form;
  const rest = form.anchors.filter(a => !(a.strokeId === strokeId && a.datumId === datumId));
  if (vertexIndex === null || vertexIndex === undefined || vertexIndex === '') return { ...form, anchors: rest };
  const next = { datumId, strokeId, vertexIndex: Number(vertexIndex) };
  const old = form.anchors.find(a => a.strokeId === strokeId && a.datumId === datumId);
  // 古い Anchor が有限の offsetMm を持つときだけ、図の位置（shift＝基準＋offsetMm−歩いた頂点）を保つ。
  // 歩けない（長さが未解決・頂点が無い・軸が不明）ときは offset をそのまま引き継ぐ。持たなければ従来どおり（キーを足さない）。
  if (old && Number.isFinite(old.offsetMm)) {
    const axis = form.datums.find(d => d.id === datumId)?.axis;
    const stroke = entryFromForm(form).strokes.find(s => s.id === strokeId);
    const walked = stroke ? penWalk(stroke, len => (typeof len?.mm === 'number' ? len.mm : null)) : null;
    const from = Array.isArray(walked) ? walked[old.vertexIndex] : null;
    const to = Array.isArray(walked) ? walked[next.vertexIndex] : null;
    next.offsetMm = (from && to && (axis === DetailAxis.S || axis === DetailAxis.T))
      ? old.offsetMm + (to[axis] - from[axis])
      : old.offsetMm;
  }
  return { ...form, anchors: [...rest, next] };
}

/**
 * 図の点 P（プレビューの図座標 mm）が origin の基準線に来るよう、図全体を平行移動する（基準点を指す）。
 * 軸ごとに Δ＝(その軸の origin の Datum の offset)−P[軸] を、その軸の基準に載る全 Anchor（origin・end）の offsetMm へ足す。
 * 同じ Δ を両方へ足すので、fit の形（end−origin の差＝伸縮の長さ）は変わらない。
 * offsetMm を持たない Anchor にもキーが付く（rebase を明示した結果。normalize がキーを足さない規約は変えない）。
 * origin の offset 欄が数でない（入力途中など）ときは 0 として扱う（プレビューと同じ）。origin 自体が無い軸、基準の見つからない
 * Anchor は触らない。どの Anchor も変わらなければ同じ form を返す（edit が弾く＝無効な undo の 1 手を積まない）。
 * 既知の限界: origin の Anchor を持たないストロークは動かない。P が有限でなければ RangeError（呼び出し側のバグ）。
 */
export function rebaseOrigin(form, p) {
  const delta = rebaseDelta(form, p);
  const datumAxis = new Map(form.datums.map(d => [d.id, d.axis]));
  let changed = false;
  const anchors = form.anchors.map(a => {
    const dv = delta[datumAxis.get(a.datumId)];
    if (dv === undefined) return a;
    changed = true;
    return { ...a, offsetMm: (Number.isFinite(a.offsetMm) ? a.offsetMm : 0) + dv };
  });
  return changed ? { ...form, anchors } : form;
}

/** rebaseOrigin が各軸へ足す量 { s?, t? }（origin の無い軸はキー無し）。P が有限でなければ RangeError。 */
export function rebaseDelta(form, p) {
  if (!Number.isFinite(p?.s) || !Number.isFinite(p?.t)) throw new RangeError('rebaseOrigin: P は有限の {s, t} が必要です');
  const delta = {};
  for (const axis of [DetailAxis.S, DetailAxis.T]) {
    const origin = form.datums.find(d => d.kind === DetailDatumKind.ORIGIN && d.axis === axis);
    if (!origin) continue;
    const off = parseNumberText(origin.offset);
    delta[axis] = (Number.isFinite(off) ? off : 0) - p[axis];
  }
  return delta;
}

/** あるストロークがある基準に載せている頂点（無ければ null）。 */
export function anchorVertex(form, strokeId, datumId) {
  const a = form.anchors.find(x => x.strokeId === strokeId && x.datumId === datumId);
  return a ? a.vertexIndex : null;
}

/** 頂点の選択肢（P0, P1, …）。 */
export function vertexOptions(form, strokeId) {
  const s = form.strokes.find(x => x.id === strokeId);
  if (!s) return [];
  return Array.from({ length: s.moves.length + 1 }, (_, i) => ({ value: i, label: `P${i}` }));
}

// ================================================================
// 分類
// ================================================================

const optionsOf = (values, labelOf) => values.map(value => ({ value, label: labelOf(value) }));
const uniq = values => [...new Set(values)];

/**
 * 分類の選択肢。組合せ表（DETAIL_VIEW_COMBOS）で絞る: category は全部、view は category に合うもの、
 * subject は (category, view) に合うもの。
 */
export function comboOptions(category, view) {
  const viewsOf = uniq(DETAIL_VIEW_COMBOS.filter(c => c.category === category).map(c => c.view));
  const subjects = uniq(DETAIL_VIEW_COMBOS.filter(c => c.category === category && c.view === view).map(c => c.subject));
  return {
    categories: categoryOptionsFor(CatalogKind.DETAIL_FIGURE),
    views: optionsOf(viewsOf, formatDetailViewLabel),
    subjects: optionsOf(subjects, formatDetailSubjectLabel),
  };
}

/** 分類を変える。上位を変えたら下位は選択肢の先頭へ寄せる（組合せ表に無い状態を作らない）。 */
export function setClassification(form, field, value) {
  let { category, view, subject } = form;
  if (field === 'category') category = value;
  else if (field === 'view') view = value;
  else if (field === 'subject') subject = value;
  else return form;
  if (!DETAIL_VIEW_COMBOS.some(c => c.category === category && c.view === view)) {
    view = DETAIL_VIEW_COMBOS.find(c => c.category === category)?.view ?? view;
  }
  if (!DETAIL_VIEW_COMBOS.some(c => c.category === category && c.view === view && c.subject === subject)) {
    subject = DETAIL_VIEW_COMBOS.find(c => c.category === category && c.view === view)?.subject ?? subject;
  }
  const next = { ...form, category, view, subject };
  // 建具の姿図へ出入りするときは、既定の role のままの基準を移行先の既定へ寄せる（ユーザーが選んだ role は触らない）。
  if (isElevationFigureForm(form) === isElevationFigureForm(next)) return next;
  return {
    ...next,
    datums: next.datums.map(d => (d.role === defaultRoleFor(form, d.axis, d.kind)
      ? { ...d, role: defaultRoleFor(next, d.axis, d.kind) } : d)),
  };
}

// ================================================================
// 検証・保存
// ================================================================

/** validateDetailFigure(entryFromForm(form))。常時表示する。 */
export function validation(form) {
  return validateDetailFigure(entryFromForm(form));
}

/** 保存できない理由の一覧（空なら保存できる）。呼称が空・検証エラーがあるとき。 */
export function saveBlockers(form, validationResult) {
  const reasons = [];
  if (form.label.trim() === '') reasons.push('呼称を入力してください');
  for (const e of validationResult.errors) reasons.push(describeError(e));
  return reasons;
}

// 検証エラーの code → 日本語の文言（loc＝「ストローク n・P i 」などの場所。無ければ空）。表に無い code は元の message を使う。
const ERROR_TEXT = Object.freeze({
  [DetailValidationError.BAD_LENGTH]:              loc => `${loc}の長さが 0 より大きい数ではありません`,
  [DetailValidationError.BAD_OFFSET]:              loc => `${loc}のオフセットが数値ではありません`,
  [DetailValidationError.NO_STROKES]:              () => 'ストロークが 1 本もありません',
  [DetailValidationError.EMPTY_MOVES]:             loc => `${loc}に手がありません`,
  [DetailValidationError.CLOSED_TOO_FEW]:          loc => `${loc}は頂点が少なすぎて閉じられません`,
  [DetailValidationError.CLOSED_RETURNS_TO_START]: loc => `${loc}は終点が始点に戻っているので閉じられません（閉じ辺は自動で補われます）`,
  [DetailValidationError.BAD_MATERIAL_CODE]:       loc => `${loc}の材コードが空です`,
});

// エラーの場所（path）から「ストローク n・P i 」「ストローク n 」「基準 n 」を作る。
function locationOf(path) {
  const move = /^strokes\[(\d+)\]\.moves\[(\d+)\]/.exec(path ?? '');
  if (move) return `${strokeLabel(Number(move[1]))}・P${move[2]} `;
  const stroke = /^strokes\[(\d+)\]/.exec(path ?? '');
  if (stroke) return `${strokeLabel(Number(stroke[1]))} `;
  const datum = /^datums\[(\d+)\]/.exec(path ?? '');
  if (datum) return `基準 ${Number(datum[1]) + 1} `;
  return '';
}

/** 検証エラー 1 件の表示文。 */
export function describeError(e) {
  const text = ERROR_TEXT[e.code];
  return text ? text(locationOf(e.path)) : e.message;
}

/** 保存ボタンの活性。 */
export function saveEnabled(form, validationResult) {
  return validationResult.ok && saveBlockers(form, validationResult).length === 0;
}

/** ライブラリ一覧の行（呼称順）。 */
export function libraryRows(entries) {
  return entries
    .map(e => ({
      key: e.key, label: e.label,
      categoryLabel: formatCategoryLabel(CatalogKind.DETAIL_FIGURE, e.category),
      viewLabel: formatDetailViewLabel(e.view),
      subjectLabel: formatDetailSubjectLabel(e.subject),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ja'));
}

/**
 * ヘルパーの一覧の行（組込み層込み・呼称順）。組込みの図＋ライブラリの図を並べ、組込みと同キーのライブラリは上書き行
 * （組込みの位置に出る＝1 行だけ）。各行に出所（origin）とバッジ（originLabel）を付ける。
 * composeList（catalogRegistry）と同じ合成（上書きは 1 行）。表示は呼称順。この純モジュールは registry を引かないため entries を受け取る。
 * docContext（docKeys・diffMap。saveContextFor と同じ）を渡すと、同梱に同キーの別内容（doc-diff）がある行に docDiff=true を付ける。
 */
export function helperLibraryRows({ userEntries, builtinList, docContext = null }) {
  const builtinKeys = new Set(builtinList.map(e => e.key));
  const userKeys = new Set(userEntries.map(e => e.key));
  const userByKey = new Map(userEntries.map(e => [e.key, e]));
  const shown = [
    ...builtinList.map(b => userByKey.get(b.key) ?? b),
    ...userEntries.filter(e => !builtinKeys.has(e.key)),
  ];
  return libraryRows(shown).map(r => {
    const origin = libraryOriginOf(r.key, { builtinKeys, userKeys });
    const docDiff = Boolean(docContext?.docKeys.has(r.key) && docContext.diffMap?.get(r.key));
    return { ...r, origin, originLabel: DETAIL_HELPER_TEXT.originBadge[origin], docDiff };
  });
}

// ================================================================
// 試し込み（fit）・プレビュー
// ================================================================

/** 試し込みの目標値の既定（文字列）。壁厚は呼び出し側が保守パネルのプレビューと同じ式で求めて渡す。見付・出幅は建具の既定。 */
export function defaultFitDims(wallThickness) {
  return {
    wallThickness: String(wallThickness),
    faceWidth: String(DEFAULT_FRAME_FACE_MM),
    projection: String(DEFAULT_FRAME_PROJECTION_MM),
  };
}

// 姿図の試し込みの既定の建具種別（保守パネルの代表種別 ui/catalogPreview.js fixtureSymbolRepresentativeEntry の fitting 側と同じ）。
// 幅・高さはその defaultWidth／defaultHeight（catalogPreview の openingSubTypePreview と同じ供給源）。窓台 0。
const ELEVATION_FIT_REPRESENTATIVE = Object.freeze({ category: 'fitting', subType: 'singleSwing' });

/**
 * 分類に合う試し込みの目標値の既定（文字列）。三方枠は defaultFitDims、建具の姿図は代表建具種別の既定幅・高さと窓台 0。
 * 代表種別がカタログに無いとき幅・高さは '' （tryFit が入力を促す error を返す）。
 */
export function defaultFitDimsFor(form, wallThickness) {
  if (isFloorStepForm(form) || isCeilingStepForm(form)) return { stepHeight: String(DETAIL_FIT_DEFAULT_STEP_HEIGHT_MM) };
  // 巾木高さの param を使う床と壁の図: 部屋の巾木の既定と同じ高さを試し込みの既定にする
  if (usesBaseboardHeightParam(form)) return { ...defaultFitDims(wallThickness), baseboardHeight: String(DETAIL_FIT_DEFAULT_BASEBOARD_HEIGHT_MM) };
  if (!isElevationFigureForm(form)) return defaultFitDims(wallThickness);
  const entry = findCatalogEntry(ELEVATION_FIT_REPRESENTATIVE.category, ELEVATION_FIT_REPRESENTATIVE.subType);
  return {
    width: entry?.defaultWidth == null ? '' : String(entry.defaultWidth),
    height: entry?.defaultHeight == null ? '' : String(entry.defaultHeight),
    sill: '0',
  };
}

const badFitDim = message => ({ error: { code: 'badFitDim', message } });

// 建具の姿図の試し込み: 幅・高さ・窓台高さ（文字列か数値）に合わせる。基準の対応は openings/openingDetailFrame.js detailElevationTargets。
function tryFitElevation(form, dims) {
  const width = parseNumberText(dims.width);
  const height = parseNumberText(dims.height);
  const sill = parseNumberText(dims.sill);
  if (!Number.isFinite(width) || width <= 0) return badFitDim('幅は正の数で入力してください');
  if (!Number.isFinite(height) || height <= 0) return badFitDim('高さは正の数で入力してください');
  if (!Number.isFinite(sill) || sill < 0) return badFitDim('窓台は 0 以上の数で入力してください');
  const fig = entryFromForm(form);
  const t = detailElevationTargets(fig, { width, height, sill });
  if (t.error) return { error: t.error };
  return fitLocal(fig, t.targets);
}

// 部屋の取り合い（床と壁・壁と天井）の試し込み: 壁厚に合わせる。基準の対応は finish/roomDetailTargets.js。
// 材束縛の図は materialMap（材コード→材。無ければ UNRESOLVED_MATERIAL）で解く。
function tryFitJunction(form, dims, slot, materialMap) {
  const wallThickness = parseNumberText(dims.wallThickness);
  if (!Number.isFinite(wallThickness) || wallThickness <= 0) return badFitDim('壁厚は正の数で入力してください');
  const fig = entryFromForm(form);
  // 腰壁・垂れ壁の部位（kneeTop・dropBottom。S8b-1）は partTargets、取り合い（floorWall・wallCeiling）は junctionTargets
  const targetsOf = KNEE_DROP_DETAIL_SLOTS.includes(slot) ? partTargets : junctionTargets;
  // 巾木高さ（param baseboardHeight。S8c）: 欄が与えられたときだけ供給する（無ければ param 未解決＝使う図は fit 失敗）
  let baseboardHeightMm;
  if (slot === DetailSlot.FLOOR_WALL && dims.baseboardHeight !== undefined) {
    baseboardHeightMm = parseNumberText(dims.baseboardHeight);
    if (!Number.isFinite(baseboardHeightMm) || baseboardHeightMm <= 0) return badFitDim('巾木高さは正の数で入力してください');
  }
  const t = targetsOf(fig, { slot, wallThicknessMm: wallThickness, baseboardHeightMm, materialMap });
  if (t.error) return { error: t.error };
  return fitLocal(fig, t.targets);
}

// 床の段差の部位（floorStep）の試し込み: 段差高に合わせる。基準の対応は finish/roomDetailTargets.js floorStepTargets。
// 天井の段差の部位（ceilingStep。S8b-4a）も同じ欄（段差高）。基準の対応は ceilingStepTargets（t の origin＝低い側の天井面・end＝−段差高）。
function tryFitFloorStep(form, dims, materialMap, targetsOf = floorStepTargets) {
  const stepHeightMm = parseNumberText(dims.stepHeight);
  if (!Number.isFinite(stepHeightMm) || stepHeightMm <= 0) return badFitDim('段差高は正の数で入力してください');
  const fig = entryFromForm(form);
  const t = targetsOf(fig, { stepHeightMm, materialMap });
  if (t.error) return { error: t.error };
  return fitLocal(fig, t.targets);
}

/**
 * 試し込み: 取り付け先の寸法に図を合わせる。建具の姿図（figure/elevation/opening）は幅・高さ・窓台、
 * それ以外は三方枠の寸法（壁厚・見付・出幅。文字列か数値）。
 * 基準の対応は S3／S6b（openings/openingDetailFrame.js）と同じ。失敗は { error:{code,message} }（黙って代用しない）。
 */
export function tryFit(form, dims, { materialMap = null } = {}) {
  if (isElevationFigureForm(form)) return tryFitElevation(form, dims);
  if (isFloorStepForm(form)) return tryFitFloorStep(form, dims, materialMap);
  if (isCeilingStepForm(form)) return tryFitFloorStep(form, dims, materialMap, ceilingStepTargets);
  const junctionSlot = junctionSlotOf(form);
  if (junctionSlot) return tryFitJunction(form, dims, junctionSlot, materialMap);
  const partSlot = partSlotOf(form);
  if (partSlot) return tryFitJunction(form, dims, partSlot, materialMap);
  const wallThickness = parseNumberText(dims.wallThickness);
  const faceWidth = parseNumberText(dims.faceWidth);
  const projection = parseNumberText(dims.projection);
  if (!Number.isFinite(wallThickness) || wallThickness <= 0) return badFitDim('壁厚は正の数で入力してください');
  if (!Number.isFinite(faceWidth) || faceWidth <= 0) return badFitDim('見付は正の数で入力してください');
  if (!Number.isFinite(projection) || projection < 0) return badFitDim('出幅は 0 以上の数で入力してください');
  const fig = entryFromForm(form);
  const t = detailFrameTargets(fig, { wallThickness, faceWidth, projection });
  if (t.error) return { error: t.error };
  return fitLocal(fig, t.targets);
}

// 非有限の offset は 0 に置き換える（プレビューの座標を NaN にしない。エラーは検証が別に表示する）。
function previewEntryOf(form) {
  const entry = entryFromForm(form);
  return { ...entry, datums: entry.datums.map(d => (Number.isFinite(d.offsetMm) ? d : { ...d, offsetMm: 0 })) };
}

// 基準線に出す役割名（表に無ければ役割の文字列のまま）。
const roleLabelOf = role => DETAIL_ROLE_LABELS[role] ?? role;

// 基準線は fit 後の基準の位置＝origin の Anchor が載る頂点（base＋offsetMm）。offsetMm だけでは base≠0 の試し込みでずれる。
// 頂点が見つからない基準は出さない。
function fittedDatums(form, fitted) {
  const entry = entryFromForm(form);
  const out = [];
  for (const d of entry.datums) {
    if (d.kind !== DetailDatumKind.ORIGIN) continue;
    const a = entry.anchors.find(x => x.datumId === d.id);
    const v = fitted.strokes.find(st => st.id === a?.strokeId)?.points[a?.vertexIndex];
    if (v) out.push({ ...d, offsetMm: v[d.axis] - (a.offsetMm ?? 0) }); // 頂点は 基準＋Datum.offsetMm＋Anchor.offsetMm の位置
  }
  return out;
}

function fittedPrimitives(fitted, form) {
  const out = [];
  for (const st of fitted.strokes) {
    const extra = { strokeId: st.id };
    if (st.closed) extra.closed = true;
    if (st.line?.dashRole === DetailDash.DASHED) extra.dash = DetailDash.DASHED;
    out.push(polyline(st.points.map(p => [p.s, p.t]), extra));
    out.push(...airEdgeOverlays(st.points, st.edgeMarks));
    st.points.forEach((p, i) => out.push(text(p.s + PREVIEW_LABEL_OFFSET_MM, p.t - PREVIEW_LABEL_OFFSET_MM, String(i), { size: PREVIEW_LABEL_SIZE_PX })));
  }
  const allPts = fitted.strokes.flatMap(st => st.points);
  // 下書きと同じ gap（図の大きさに比例）で基準線を延ばす
  out.push(...datumGuidePrimitives(fittedDatums(form, fitted), allPts, { gap: previewDimGap(PREVIEW_DIM_GAP_MM, allPts), labelOf: roleLabelOf }));
  return out;
}

/** プレビュー用プリミティブ。fitted（tryFit の成功結果）があれば試し込み後の形、無ければ下書き（各手の dim は editable）。手が 1 つも無ければ []。 */
export function previewPrimitivesOf(form, fitted = null) {
  if (!form.strokes.some(s => s.moves.length > 0)) return [];
  if (fitted && !fitted.error) return fittedPrimitives(fitted, form);
  return previewPrimitives(previewEntryOf(form), { labelOf: roleLabelOf });
}

// ================================================================
// DXF 読込み（S7a）
//   dxf（パネルが持つ状態）= { fileName, sha256, encoding, parsed, scene, unitText, selected:number[], maker, series, licenseNote }
//   読んだ原本のバイト列は持たない（sha256 だけ）。選んだ成分ごとに 1 本以上のストロークで新規下書きへ写す。
// ================================================================

const DXF_WARNING_TEXT = Object.freeze({
  [DxfWarning.UNIT_UNKNOWN]:       () => WARN_DXF_UNIT_UNKNOWN,
  [DxfWarning.CONTOUR_OPEN]:       () => WARN_DXF_CONTOUR_OPEN,
  [DxfWarning.SELF_INTERSECT]:     () => WARN_DXF_SELF_INTERSECT,
  [DxfWarning.LICENSE_UNKNOWN]:    () => WARN_DXF_LICENSE_UNKNOWN,
  [DxfWarning.INSERT_DEPTH]:       w => WARN_DXF_INSERT_DEPTH(w.block, DXF_INSERT_DEPTH_MAX),
  [DxfWarning.INSERT_CYCLE]:       w => WARN_DXF_INSERT_CYCLE(w.block),
  [DxfWarning.UNSUPPORTED_ENTITY]: w => WARN_DXF_UNSUPPORTED_ENTITY(w.type, w.count),
  [DxfWarning.NONUNIFORM_SCALE]:   w => WARN_DXF_NONUNIFORM_SCALE(w.block),
  [DxfWarning.ENTITY_LIMIT]:       w => WARN_DXF_ENTITY_LIMIT(w.limit),
  [DxfWarning.SELF_INTERSECT_UNCHECKED]: () => WARN_DXF_SELF_INTERSECT_UNCHECKED,
  [DxfWarning.NO_DIGEST]:          () => WARN_DXF_NO_DIGEST,
});
const DXF_REJECT_TEXT = Object.freeze({
  [DxfReject.BINARY]:         () => ERR_DXF_BINARY,
  [DxfReject.BAD_GROUP_CODE]: e => ERR_DXF_BAD_GROUP_CODE(e.line),
  [DxfReject.TRUNCATED]:      () => ERR_DXF_TRUNCATED,
  [DxfReject.UNEXPECTED]:     e => ERR_DXF_UNEXPECTED(e.message),
  [DxfReject.NOT_BYTES]:      () => ERR_DXF_NOT_BYTES,
});

/** 左ペインのタブ。 */
export const DETAIL_HELPER_TABS = Object.freeze({ PEN: 'pen', DXF: 'dxf' });

/** 警告 1 件の表示文。未知のコードはコードそのまま。 */
export function describeDxfWarning(w) {
  const f = DXF_WARNING_TEXT[w?.code];
  return f ? f(w) : String(w?.code);
}
/** 拒否（読み込めない）理由の表示文。 */
export function describeDxfReject(error) {
  const f = DXF_REJECT_TEXT[error?.code];
  return f ? f(error) : ERR_DXF_UNEXPECTED(String(error?.message ?? error?.code));
}

/** sha256 を取れなくても読込みは止めない（出所の sha256 を空にして警告 NO_DIGEST で続ける）。DXF・PDF 共通。 */
export async function safeDigest(bytes, digest) {
  let sha256 = '';
  let noDigest = false;
  try {
    sha256 = await digest(bytes);
  } catch {
    noDigest = true;
  }
  if (typeof sha256 !== 'string' || sha256 === '') { sha256 = ''; noDigest = true; }
  return { sha256, noDigest };
}

/**
 * DXF のバイト列を読む（復号→構文解析→成分化。sha256 は注入した digest(bytes)→Promise<hex>）。
 * 失敗は { ok:false, message }（例外にしない）。
 */
export async function loadDxf({ bytes, fileName, digest }) {
  const read = readDxf(bytes);
  if (!read.ok) return { ok: false, message: describeDxfReject(read.error) };
  const { sha256, noDigest } = await safeDigest(bytes, digest);
  const scene = buildDxfScene(read.parsed);
  if (!scene.ok) return { ok: false, message: describeDxfReject(scene.error) };
  return {
    ok: true,
    dxf: {
      fileName: baseNameOf(fileName), sha256, noDigest, encoding: read.encoding, parsed: read.parsed, scene,
      viewEpoch: {}, // プレビューの view の鍵（読込みごとに新しい。sha256 は空になりうるので使わない）。単位変更で作り直し、レイヤ切替は引き継ぐ
      unitText: '', selected: [], maker: '', series: '', licenseNote: '',
    },
  };
}

/** 単位係数（1 単位 = ? mm）を指定し直して成分を作り直す（空文字は自動に戻す）。選択は解除する。失敗は { error } で dxf は変えない。 */
export function setDxfUnit(dxf, unitText) {
  const text = String(unitText ?? '').trim();
  let unitFactor = null;
  if (text !== '') {
    unitFactor = parseNumberText(text);
    if (!Number.isFinite(unitFactor) || unitFactor <= 0) return { dxf, error: DETAIL_HELPER_MESSAGES.dxfUnitInvalid };
  }
  const scene = buildDxfScene(dxf.parsed, { unitFactor });
  if (!scene.ok) return { dxf, error: describeDxfReject(scene.error) };
  return { dxf: { ...dxf, unitText: text, scene, selected: [], viewEpoch: {} }, error: null };
}

/**
 * off にするレイヤ名の集合を指定し直して成分を作り直す（線分の段階で絞る）。選択は解除し、scene は新しいオブジェクトになる
 * （S7c の矩形は scene の同一性に結び付くので自動で無効）。単位の指定（unitText）は保つ。失敗は { error } で dxf は変えない。
 */
export function setDxfLayers(dxf, hiddenLayers) {
  const text = dxf.unitText ?? '';
  const unitFactor = text === '' ? null : parseNumberText(text);
  const scene = buildDxfScene(dxf.parsed, { unitFactor, hiddenLayers });
  if (!scene.ok) return { dxf, error: describeDxfReject(scene.error) };
  return { dxf: { ...dxf, scene, selected: [] }, error: null };
}

/** レイヤ 1 つの on/off を反転する。 */
export function toggleDxfLayer(dxf, name) {
  const hidden = new Set(dxf.scene.hiddenLayers);
  if (hidden.has(name)) hidden.delete(name); else hidden.add(name);
  return setDxfLayers(dxf, hidden);
}

/** レイヤ一覧の行（名前昇順）。レイヤが 1 つ以下なら切り替える意味がないので []。 */
export function dxfLayerRows(dxf) {
  const { layers = [], hiddenLayers = [] } = dxf?.scene ?? {};
  if (layers.length <= 1) return [];
  const hidden = new Set(hiddenLayers);
  return layers.map(l => ({ name: l.name, segmentCount: l.segmentCount, visible: !hidden.has(l.name) }));
}

/** 成分の選択を切り替える（選択は昇順の index 配列）。 */
export function toggleDxfComponent(dxf, index) {
  const has = dxf.selected.includes(index);
  const selected = has ? dxf.selected.filter(i => i !== index) : [...dxf.selected, index].sort((a, b) => a - b);
  return { ...dxf, selected };
}

/** 出所欄（メーカー・シリーズ・ライセンス注記）の項目を書き換える。 */
export function setDxfProvenanceField(dxf, field, value) {
  if (!DXF_PROVENANCE_FIELD_SET.has(field)) return dxf;
  return { ...dxf, [field]: String(value ?? '') };
}
const DXF_PROVENANCE_FIELD_SET = new Set(Object.values(DXF_PROVENANCE_FIELDS));

/** 出所が外部ファイル（DXF・PDF）由来か。 */
function isImportedProvenance(prov) {
  return IMPORTED_SOURCES.includes(prov?.source);
}
/** 出所（DXF・PDF）の保存形（trim 済み）。それぞれの出所の builder を通す。 */
function normalizedProvenance(prov) {
  return prov.source === DetailProvenanceSource.PDF ? buildPdfProvenance(prov).provenance : buildDxfProvenance(prov).provenance;
}

/** 下書き（DXF・PDF 由来）の出所欄を書き換える。外部ファイル由来でない下書き・未知の項目は何もしない。保存時に trim される（entryFromForm）。 */
export function setProvenanceField(form, field, value) {
  const prov = form?.extra?.provenance;
  if (!isImportedProvenance(prov) || !DXF_PROVENANCE_FIELD_SET.has(field)) return form;
  return { ...form, extra: { ...form.extra, provenance: { ...prov, [field]: String(value ?? '') } } };
}

/** 成分一覧の行（頂点数・閉/開・警告）。 */
export function dxfComponentRows(dxf) {
  return dxf.scene.components.map(c => ({
    index: c.index,
    label: DETAIL_HELPER_TEXT.dxfComponentLabel(c.index + 1),
    detail: `${c.vertexCount} ${DETAIL_HELPER_TEXT.dxfVertexUnit}・${c.closed ? DETAIL_HELPER_TEXT.dxfClosedLabel : DETAIL_HELPER_TEXT.dxfOpenLabel}`,
    warnings: c.warnings.map(describeDxfWarning),
    // 表示用: 閉じていない成分の警告（CONTOUR_OPEN）だけ赤で出す。
    warningItems: c.warnings.map(w => ({ text: describeDxfWarning(w), red: w.code === DxfWarning.CONTOUR_OPEN })),
    selected: dxf.selected.includes(c.index),
  }));
}

/** 単位の読み取り結果の表示（「読み取り値: 25.4」）。 */
export function dxfUnitHint(dxf) {
  return `${DETAIL_HELPER_TEXT.dxfUnitDetected}: ${dxf.scene.unitFactor}`;
}

/** ファイル全体の警告（構文解析・単位）と、出所欄から出る警告（ライセンス未記入）の表示文。保存は止めない。 */
export function dxfWarningTexts(dxf) {
  const { warnings } = buildDxfProvenance(dxfProvenanceInput(dxf));
  const digest = dxf.noDigest ? [{ code: DxfWarning.NO_DIGEST }] : [];
  return [...dxf.scene.warnings, ...digest, ...warnings].map(describeDxfWarning);
}

const dxfProvenanceInput = dxf => ({
  fileName: dxf.fileName, sha256: dxf.sha256, maker: dxf.maker, series: dxf.series, licenseNote: dxf.licenseNote,
});

/**
 * 読込み状態（DXF の dxf／PDF の pdf）の出所。PDF（source==='pdf'）は抽出したときのページ・範囲・縮尺（scene が持つ）を載せる。
 * @returns {{provenance: object, warnings: {code:string}[]}}
 */
export function importProvenanceOf(state) {
  if (state.source !== DetailProvenanceSource.PDF) return buildDxfProvenance(dxfProvenanceInput(state));
  const { page, clip, scaleDenominator } = state.scene;
  return buildPdfProvenance({ ...dxfProvenanceInput(state), page, clip, scaleDenominator });
}

/** プレビュー用プリミティブ。全成分を淡色で、選んだ成分を強調して描く（閉じた一筆書きは始点を足して閉じ辺も描く）。 */
export function dxfPreviewPrimitives(dxf) {
  const faint = [];
  const strong = [];
  const selected = new Set(dxf.selected);
  for (const c of dxf.scene.components) {
    const isSelected = selected.has(c.index);
    for (const tr of c.trails) {
      if (tr.points.length < 2) continue;
      const pts = tr.points.map(p => [p.s, p.t]);
      if (tr.closed) pts.push(pts[0]);
      (isSelected ? strong : faint).push(polyline(pts, { ...DXF_PREVIEW_STYLE[isSelected ? 'selected' : 'faint'] }));
    }
  }
  return [...faint, ...strong];
}

/**
 * 選んだ成分を新規下書きのフォームにする（成分ごとに 1 本以上のストローク・全 LenSpec は fixed・線種は既定）。
 * 分類・基準・stretch はユーザーが後から指定する（基準は軸ごとの原点 2 つ、各ストロークの頂点 0 を載せる）。
 * 出所（provenance）はフォームの extra に載り、保存でそのままエントリへ入る。
 * 複数成分の位置関係は Anchor.offsetMm で保つ。basePoint は基準点 P（選んだ成分の bbox 合併の左下。図の座標 mm）。
 * @returns {{form: object, basePoint: {s:number, t:number}} | {error: string}}
 */
export function draftFromDxf({ dxf, idFactory }) {
  const picked = dxf.scene.components.filter(c => dxf.selected.includes(c.index));
  if (picked.length === 0) return { error: DETAIL_HELPER_MESSAGES.dxfNothingSelected };
  const drawn = picked.flatMap(c => c.strokes);
  if (drawn.length === 0) return { error: DETAIL_HELPER_MESSAGES.dxfNothingToCopy };
  const base = entryFromForm(newDraft({ idFactory }));
  const strokes = drawn.map((s, i) => ({ id: `${STROKE_ID_PREFIX}${i + 1}`, closed: s.closed, line: defaultLine(), moves: s.moves }));
  const originDatums = base.datums.filter(d => d.kind === DetailDatumKind.ORIGIN);
  // 位置関係を保つ: 基準点 P＝選んだ成分の bbox の合併の左下（minS, maxT。t は下向き正）。
  // 各ストロークの頂点 0 は P から (start − P) の位置に置く（Anchor.offsetMm。0 でも書く）。
  const boxes = picked.map(c => c.bbox).filter(Boolean);
  const basePoint = {
    s: Math.min(...boxes.map(b => b.minS)),
    t: Math.max(...boxes.map(b => b.maxT)),
  };
  const anchors = strokes.flatMap((s, i) => originDatums.map(d => ({
    datumId: d.id, strokeId: s.id, vertexIndex: 0,
    offsetMm: drawn[i].start[d.axis] - basePoint[d.axis],
  })));
  const { provenance } = importProvenanceOf(dxf);
  const label = dxf.fileName.replace(/\.[^.]*$/, '');
  return { form: formFromEntry({ ...base, label, strokes, anchors, provenance }), basePoint };
}

/** DXF から写した下書きの doc（基準なし＝常に未保存。破棄・閉じる前に確認が出る）。 */
export function draftDocOf(form) {
  return { form, history: [], baseline: null, prevEntry: null };
}

/** 下書きの出所の表示文（DXF・PDF 由来のときだけ。手描きは null）。「この図は保存ファイルに入りません」を含む。 */
export function provenanceNoticeOf(form) {
  return isImportedProvenance(form?.extra?.provenance) ? formatDetailProvenance(form.extra.provenance) : null;
}
