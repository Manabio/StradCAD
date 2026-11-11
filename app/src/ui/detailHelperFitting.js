// ================================================================
// 部分詳細図ヘルパーの「建具一式」モード（C5）の純ロジック。
// 一式（DetailCategory.FITTING。最上位は形を持たず parts[] に部品を束ねる）の下書きを doc に持つ。
//   doc = { form, history, baseline, prevEntry, readOnly?, set?, partIndex? }
//   - set: 一式の下書き（エントリ形。一式でない doc では undefined）。partIndex: 選んでいる部品（部品 0 個は null）。
//   - form: 選んでいる部品を fittingPartFigure（合成キー '<一式>#<役割>'）で単独の図にして formFromEntry したもの。
//     これで既存のペン入力・基準・寸法・試し込み・プレビュー・手戻しが部品へそのまま効く（一式のときだけ set が付く）。
//   - 部品の編集は form に溜め、set へ書き戻すのは部品の切替・追加・削除・保存・検証（fittingEntryOf）のとき（確定のたびではない）。
//   - 手戻し（history）は form 単位。部品を切り替えると空にする（Q-C5a）。追加・削除は手戻しの対象外。
// 判断は全部ここに置き、.jsx は配線だけにする。node:test から単体 import できる純モジュール
// （store.js・snap.js・appViewport.js・storage/・.jsx・react を（推移的にも）引かない。ui/detailHelperImportGraph.test.js で固定）。
// ================================================================

import {
  DetailCategory, DetailSlot, DETAIL_SLOT_TARGETS, DETAIL_FIGURE_KEY_PREFIX, DETAIL_FIGURE_VERSION, DetailProvenanceSource,
  FITTING_PART_TARGETS,
} from '../core/constants.js';
import { validateDetailFigure, DetailValidationError, fittingPartFigure } from '../detail/detailModel.js';
import {
  FITTING_PART_ROLE_TEXT, formatCategoryLabel, formatDetailViewLabel, formatDetailSubjectLabel,
} from '../catalog/catalogMaintenance.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import {
  formFromEntry, entryFromForm, newDraft, setClassification, isDraftDirty, duplicateForm, describeError, saveBlockers,
  docForLibraryEntry, LIBRARY_ORIGIN, DETAIL_HELPER_MESSAGES,
} from './detailHelperForm.js';

/** 一式のとき部品の本体として持たない項目（合成図が作り直す・部品には持たせない）。 */
const NON_BODY_FIELDS = Object.freeze(['key', 'version', 'label', 'provenance', 'note']);
// 部品 i のエラーの path は `parts[i]`（部品の枠）／`parts[i].id`・`parts[i].role`／`parts[i].figure.<図の中の path>`（validateFittingSet の前置）。
const PART_INDEX_RE = /^parts\[(\d+)\]/;
const PART_PATH_RE = /^parts\[\d+\]\.?(?:figure\.?)?/; // 図の中の path（strokes[0]… describeError が場所を読む形）だけを残すための前置

/** 一式の doc か。 */
export const isFittingDoc = doc => Boolean(doc?.set);

/** 一式の doc で、選んでいる部品が無い（部品 0 個）か。この間は部品の編集（ペン・基準など）を受けない。 */
export const isPartlessFittingDoc = doc => isFittingDoc(doc) && doc.partIndex == null;

// 部品の form を部品の本体（category/view/subject/strokes/datums/anchors と未知の項目）へ。
function partBodyOfForm(form) {
  return Object.fromEntries(Object.entries(entryFromForm(form)).filter(([k]) => !NON_BODY_FIELDS.includes(k)));
}

// 一式 set と選択から doc を組み立てる。部品が無い（partIndex null）ときの form は一式自身の枠（編集は受けない）。
function docOfSet(set, partIndex, { baseline, prevEntry, readOnly = false, history = [] }) {
  const part = partIndex == null ? null : set.parts[partIndex];
  const fig = part ? fittingPartFigure(set, part.role) : null;
  const form = formFromEntry(fig ?? set);
  return { form, history, baseline, prevEntry, set, partIndex: fig ? partIndex : null, ...(readOnly ? { readOnly: true } : {}) };
}

/** 一式の新規の下書き（部品 0 個。分類は DETAIL_SLOT_TARGETS[FITTING]）。 */
export function newFittingDoc({ idFactory, label = '' }) {
  const t = DETAIL_SLOT_TARGETS[DetailSlot.FITTING];
  const set = {
    key: `${DETAIL_FIGURE_KEY_PREFIX}${idFactory()}`,
    version: DETAIL_FIGURE_VERSION,
    label,
    category: t.category, view: t.view, subject: t.subject,
    strokes: [], datums: [], anchors: [], parts: [],
    provenance: { source: DetailProvenanceSource.MANUAL }, note: null,
  };
  return docOfSet(set, null, { baseline: set, prevEntry: null });
}

/** ライブラリの一式を開いた doc（最初の部品を選択。基準＝開いた直後の fittingEntryOf）。 */
export function fittingDocFromEntry(entry, { readOnly = false } = {}) {
  const parts = Array.isArray(entry.parts) ? entry.parts : [];
  const opened = docOfSet({ ...entry, parts }, parts.length > 0 ? 0 : null, { baseline: null, prevEntry: entry, readOnly });
  return { ...opened, baseline: fittingEntryOf(opened) };
}

/** 一覧の行を開く doc: 一式なら fittingDocFromEntry、それ以外は従来の docForLibraryEntry。組込みは読み取り専用。 */
export function docOfLibraryEntry(entry, origin) {
  return entry.category === DetailCategory.FITTING
    ? fittingDocFromEntry(entry, { readOnly: origin === LIBRARY_ORIGIN.BUILTIN })
    : docForLibraryEntry(entry, origin);
}

/** 選んでいる部品の form を set.parts[partIndex].figure へ書き戻した doc（form・history などは変えない）。一式でない・部品なしは同一参照。 */
export function commitPartForm(doc) {
  if (!isFittingDoc(doc) || doc.partIndex == null) return doc;
  const parts = doc.set.parts.map((p, i) => (i === doc.partIndex ? { ...p, figure: partBodyOfForm(doc.form) } : p));
  return { ...doc, set: { ...doc.set, parts } };
}

/** 保存・検証用の一式エントリ（選んでいる部品の編集を含む）。 */
export const fittingEntryOf = doc => commitPartForm(doc).set;

/** 部品を切り替える。今の部品を書き戻してから切替え、手戻しの履歴は空にする（Q-C5a）。範囲外・同じ部品は同一参照。 */
export function selectFittingPart(doc, index) {
  if (!isFittingDoc(doc) || index === doc.partIndex || !(index >= 0 && index < doc.set.parts.length)) return doc;
  const c = commitPartForm(doc);
  return docOfSet(c.set, index, { baseline: doc.baseline, prevEntry: doc.prevEntry, readOnly: doc.readOnly });
}

/**
 * 部品を追加して選択する。分類は役割から自動（FITTING_PART_TARGETS）。同じ役割が既にあれば { error }（役割は一式の中で一意）。
 * @returns {{doc: object} | {error: string}}
 */
export function addFittingPart(doc, role) {
  const target = FITTING_PART_TARGETS[role];
  if (!target) return { error: DETAIL_HELPER_MESSAGES.fittingUnknownRole };
  const c = commitPartForm(doc);
  if (c.set.parts.some(p => p.role === role)) return { error: DETAIL_HELPER_MESSAGES.fittingRoleExists };
  // 新しい部品の本体は、既定の基準つきの空の下書きを役割の分類へ寄せたもの（基準の既定の役割は分類で変わる）
  let blank = newDraft({ idFactory: () => 'part' });
  for (const field of ['category', 'view', 'subject']) blank = setClassification(blank, field, target[field]);
  const set = { ...c.set, parts: [...c.set.parts, { id: role, role, figure: partBodyOfForm(blank) }] };
  return { doc: docOfSet(set, set.parts.length - 1, { baseline: doc.baseline, prevEntry: doc.prevEntry, readOnly: doc.readOnly }) };
}

/** 部品を削除する。選択は、削除した部品なら隣（無ければ null）、他の部品ならその部品のまま。手戻しの履歴は空にする。 */
export function removeFittingPart(doc, index) {
  if (!isFittingDoc(doc) || !(index >= 0 && index < doc.set.parts.length)) return doc;
  const c = commitPartForm(doc);
  const parts = c.set.parts.filter((_, i) => i !== index);
  let next = null;
  if (parts.length > 0) {
    if (doc.partIndex == null || doc.partIndex === index) next = Math.min(index, parts.length - 1);
    else next = doc.partIndex > index ? doc.partIndex - 1 : doc.partIndex;
  }
  return docOfSet({ ...c.set, parts }, next, { baseline: doc.baseline, prevEntry: doc.prevEntry, readOnly: doc.readOnly });
}

/** 一式の呼称を変える（部品の form の呼称は合成なので触らない）。 */
export function setFittingLabel(doc, label) {
  return isFittingDoc(doc) ? { ...doc, set: { ...doc.set, label } } : doc;
}

/** まだ無い役割（部品を追加する select の選択肢の値）。FITTING_PART_TARGETS の順。 */
export function availableFittingRoles(doc) {
  const used = new Set((doc.set?.parts ?? []).map(p => p.role));
  return Object.keys(FITTING_PART_TARGETS).filter(r => !used.has(r));
}

/**
 * 新規の空の下書きなら一式へ切り替える（呼称は引き継ぐ）。編集中の単一図（ライブラリの図を開いている・線がある）からは
 * 切り替えない（単一図→部品の自動移行はしない。Q-C5b）。既に一式なら同じ doc。
 * @returns {{doc: object} | {error: string}}
 */
export function switchToFitting(doc, { idFactory }) {
  if (isFittingDoc(doc)) return { doc };
  // 呼称は引き継ぐので比べない。基準・アンカー・線など呼称以外を編集済み（baseline なし＝DXF 由来を含む）なら捨てない。
  const edited = isDraftDirty({ ...doc.form, label: '' }, { ...doc.baseline, label: '' });
  if (doc.prevEntry || doc.form.strokes.length > 0 || edited) return { error: DETAIL_HELPER_MESSAGES.fittingNewOnly };
  return { doc: newFittingDoc({ idFactory, label: doc.form.label }) };
}

/** 複製: 別キー・基準なし（常に未保存）・ライブラリの図に紐づかない。選択は保つ。 */
export function duplicateFittingDoc(doc, { idFactory }) {
  const set = fittingEntryOf(doc);
  const dup = duplicateForm({ ...doc.form, label: set.label }, { idFactory });
  return docOfSet({ ...set, key: dup.key, label: dup.label }, doc.partIndex, { baseline: null, prevEntry: null });
}

/** 未保存の変更があるか。一式は書き戻し後のエントリを基準（開いた直後・保存した直後の fittingEntryOf）と比べる。 */
export function isDocDirty(doc) {
  return isFittingDoc(doc)
    ? JSON.stringify(fittingEntryOf(doc)) !== JSON.stringify(doc.baseline)
    : isDraftDirty(doc.form, doc.baseline);
}

/** 保存の完了を一式の doc へ反映する。保存中に別の図へ切り替わっていた（key が違う）なら何も変えない。 */
export function afterSaveFittingDoc(doc, entry) {
  if (doc.set?.key !== entry.key) return doc;
  return { ...doc, baseline: entry, prevEntry: entry };
}

// ---- 検証 ----

/** 一式全体の検証（validateDetailFigure(fittingEntryOf(doc))）。 */
export const fittingValidation = doc => validateDetailFigure(fittingEntryOf(doc));

const partIndexOfPath = path => {
  const m = PART_INDEX_RE.exec(path ?? '');
  return m ? Number(m[1]) : null;
};

/** 一式全体のエラー（parts[i] の外）の表示文の一覧。部品 0 個は専用の文言。 */
export function fittingSetErrorTexts(validationResult) {
  return validationResult.errors
    .filter(e => partIndexOfPath(e.path) === null)
    .map(e => (e.code === DetailValidationError.PARTS_EMPTY ? DETAIL_HELPER_MESSAGES.fittingNoParts : describeError(e)));
}

/** 部品の一覧の行（役割ラベル・分類・エラー件数・選択中）。エラーは path の `parts[i].` で行へ振り分ける。 */
export function fittingPartRows(doc, validationResult) {
  const counts = new Map();
  for (const e of validationResult.errors) {
    const i = partIndexOfPath(e.path);
    if (i !== null) counts.set(i, (counts.get(i) ?? 0) + 1);
  }
  return doc.set.parts.map((p, i) => ({
    index: i, role: p.role,
    roleLabel: FITTING_PART_ROLE_TEXT[p.role] ?? p.role,
    classLabel: `${formatCategoryLabel(CatalogKind.DETAIL_FIGURE, p.figure?.category)} / ${formatDetailViewLabel(p.figure?.view)} / ${formatDetailSubjectLabel(p.figure?.subject)}`,
    errorCount: counts.get(i) ?? 0,
    selected: i === doc.partIndex,
  }));
}

/** 保存できない理由の一覧（空なら保存できる）。呼称・一式全体のエラー・各部品のエラー（先頭に役割ラベル）。一式全体の validate が ok でなければ止める。 */
export function fittingSaveBlockers(doc, validationResult) {
  const set = doc.set;
  const reasons = saveBlockers({ label: set.label ?? '' }, { errors: [] });
  reasons.push(...fittingSetErrorTexts(validationResult));
  for (const e of validationResult.errors) {
    const i = partIndexOfPath(e.path);
    if (i === null) continue;
    const role = set.parts[i]?.role;
    const inner = { ...e, path: (e.path ?? '').replace(PART_PATH_RE, '') };
    reasons.push(`${FITTING_PART_ROLE_TEXT[role] ?? role}: ${describeError(inner)}`);
  }
  return reasons;
}
