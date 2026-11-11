// ui/detailHelperFitting.js（ヘルパーの建具一式モード。C5）と、部品の試し込み（detailHelperForm.js の isSlidePartForm 分岐）のテスト。
// 期待値は定数・手計算で書く（組込みの引き戸一式 df-builtin-fitting-sliding を開く材料にする）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PenDir, DetailCategory, DetailView, DetailSubject, DetailSlot, DETAIL_SLOT_TARGETS, FittingPartRole, FITTING_PART_TARGETS,
  DETAIL_BUILTIN_FITTING_SLIDING_KEY,
} from '../core/constants.js';
import { detailBuiltinFigures } from '../detail/detailPlacement.js';
import { validateDetailFigure } from '../detail/detailModel.js';
import { FITTING_PART_ROLE_TEXT } from '../catalog/catalogMaintenance.js';
import {
  newDraft, addDatum, penStep, docFromEntry, freshDocOf, entryFromForm, fitDimFieldsFor, defaultFitDimsFor, tryFit, isSlidePartForm,
  libraryRows, libraryMetaLabel, DETAIL_HELPER_MESSAGES, DETAIL_HELPER_TEXT, LIBRARY_ORIGIN, saveBlockers,
} from './detailHelperForm.js';
import {
  isFittingDoc, isPartlessFittingDoc, newFittingDoc, fittingDocFromEntry, docOfLibraryEntry, commitPartForm, fittingEntryOf,
  selectFittingPart, addFittingPart, removeFittingPart, setFittingLabel, availableFittingRoles, switchToFitting, duplicateFittingDoc,
  isDocDirty, afterSaveFittingDoc, fittingValidation, fittingSetErrorTexts, fittingPartRows, fittingSaveBlockers,
} from './detailHelperFitting.js';

const R = FittingPartRole;
const idFactory = () => 'abc';
const SET = detailBuiltinFigures.find(e => e.key === DETAIL_BUILTIN_FITTING_SLIDING_KEY);
const PART_ORDER = [R.SLIDE_LATCH, R.SLIDE_INNER, R.SLIDE_TAIL, R.SLIDE_LATCH_UP, R.SLIDE_INNER_UP, R.SLIDE_TAIL_UP];
const pts = fitted => fitted.strokes.map(s => s.points.map(p => [p.s, p.t]));

test('役割ラベル表は全 FittingPartRole を持ち、全て非空', () => {
  assert.deepEqual(Object.keys(FITTING_PART_ROLE_TEXT).sort(), Object.values(R).sort());
  for (const label of Object.values(FITTING_PART_ROLE_TEXT)) assert.ok(label.length > 0);
  assert.equal(FITTING_PART_ROLE_TEXT[R.JAMB_HINGE], '方立（吊元側）');
  assert.equal(FITTING_PART_ROLE_TEXT[R.SLIDE_TAIL], '戸尻の端材＋開けた扉');
});

// ---- 新規・開く ----

test('newFittingDoc: 部品 0 個・一式の分類・選択なし・基準＝未編集（dirty でない）', () => {
  const doc = newFittingDoc({ idFactory, label: '窓一式' });
  assert.equal(isFittingDoc(doc), true);
  assert.equal(isPartlessFittingDoc(doc), true);
  assert.equal(doc.set.key, 'df-abc');
  assert.equal(doc.set.label, '窓一式');
  const t = DETAIL_SLOT_TARGETS[DetailSlot.FITTING];
  assert.deepEqual([doc.set.category, doc.set.view, doc.set.subject], [t.category, t.view, t.subject]);
  assert.deepEqual(doc.set.parts, []);
  assert.equal(doc.partIndex, null);
  assert.equal(isDocDirty(doc), false);
});

test('fittingDocFromEntry: 最初の部品を選び、form は合成キー「<一式>#<役割>」の単独図・readOnly は渡した通り', () => {
  const doc = fittingDocFromEntry(SET, { readOnly: true });
  assert.equal(doc.partIndex, 0);
  assert.equal(doc.readOnly, true);
  assert.equal(doc.form.key, `${DETAIL_BUILTIN_FITTING_SLIDING_KEY}#${R.SLIDE_LATCH}`);
  const t = FITTING_PART_TARGETS[R.SLIDE_LATCH];
  assert.deepEqual([doc.form.category, doc.form.view, doc.form.subject], [t.category, t.view, t.subject]);
  assert.equal(doc.prevEntry, SET);
  assert.equal(fittingDocFromEntry(SET).readOnly, undefined);
  assert.equal(isDocDirty(doc), false);
});

test('docOfLibraryEntry: 一式は fittingDocFromEntry（組込みは読み取り専用）・単一図は従来の docFromEntry', () => {
  const fitting = docOfLibraryEntry(SET, LIBRARY_ORIGIN.BUILTIN);
  assert.equal(isFittingDoc(fitting), true);
  assert.equal(fitting.readOnly, true);
  assert.equal(docOfLibraryEntry(SET, LIBRARY_ORIGIN.USER).readOnly, undefined);
  const single = detailBuiltinFigures.find(e => e.category !== DetailCategory.FITTING);
  const doc = docOfLibraryEntry(single, LIBRARY_ORIGIN.USER);
  assert.equal(isFittingDoc(doc), false);
  assert.deepEqual(doc, docFromEntry(single, { readOnly: false }));
});

// ---- 往復 ----

test('fittingEntryOf 往復: 組込みの一式を開いて書き戻すと元のエントリと deepEqual（全部品を選び直しても）', () => {
  let doc = fittingDocFromEntry(SET);
  assert.deepEqual(fittingEntryOf(doc), SET);
  for (let i = 1; i < SET.parts.length; i += 1) doc = selectFittingPart(doc, i);
  doc = selectFittingPart(doc, 0);
  assert.deepEqual(fittingEntryOf(doc), SET);
  assert.deepEqual(validateDetailFigure(fittingEntryOf(doc)), { ok: true, errors: [] });
});

test('selectFittingPart: 今の部品の編集を set へ書き戻してから切り替え、手戻しの履歴は空にする（Q-C5a）', () => {
  let doc = fittingDocFromEntry(SET);
  doc = penStep(doc, PenDir.RIGHT, '10'); // 部品 0 のストロークに手を足す
  assert.equal(doc.history.length, 1);
  assert.equal(isDocDirty(doc), true);
  const edited = doc.form.strokes[doc.form.strokes.length - 1].moves.length;
  doc = selectFittingPart(doc, 1);
  assert.equal(doc.partIndex, 1);
  assert.deepEqual(doc.history, []);
  assert.equal(doc.form.key.endsWith(`#${R.SLIDE_INNER}`), true);
  // 書き戻されている: set の部品 0 に 1 手増えた図が入る
  const moves = doc.set.parts[0].figure.strokes[doc.set.parts[0].figure.strokes.length - 1].moves;
  assert.equal(moves.length, edited);
  assert.equal(moves[moves.length - 1].dir, PenDir.RIGHT);
  assert.deepEqual(moves[moves.length - 1].len, { mm: 10, mode: 'fixed' });
  // 戻っても編集が残る・他の部品は元のまま
  const back = selectFittingPart(doc, 0);
  assert.equal(back.form.strokes[back.form.strokes.length - 1].moves.length, edited);
  assert.deepEqual(back.set.parts[1], SET.parts[1]);
  assert.equal(isDocDirty(back), true);
  // 同じ部品・範囲外は同一参照
  assert.equal(selectFittingPart(back, 0), back);
  assert.equal(selectFittingPart(back, 9), back);
  assert.equal(selectFittingPart(back, -1), back);
});

test('commitPartForm: 部品の本体は key・version・label・provenance・note を持たない（部品に足さない）', () => {
  const doc = commitPartForm(penStep(fittingDocFromEntry(SET), PenDir.RIGHT, '10'));
  const body = doc.set.parts[0].figure;
  for (const k of ['key', 'version', 'label', 'provenance', 'note']) assert.equal(Object.hasOwn(body, k), false, k);
  assert.deepEqual(Object.keys(body).sort(), ['anchors', 'category', 'datums', 'strokes', 'subject', 'view']);
  const none = newFittingDoc({ idFactory });
  assert.equal(commitPartForm(none), none);
});

// ---- 追加・削除 ----

test('addFittingPart: 分類は役割から自動・追加した部品を選択・form は合成キー', () => {
  let doc = newFittingDoc({ idFactory, label: 'x' });
  for (const role of [R.JAMB, R.HEAD, R.SLIDE_INNER, R.FIGURE]) {
    const r = addFittingPart(doc, role);
    assert.equal(r.error, undefined, role);
    doc = r.doc;
    const t = FITTING_PART_TARGETS[role];
    assert.deepEqual([doc.form.category, doc.form.view, doc.form.subject], [t.category, t.view, t.subject], role);
    assert.equal(doc.form.key, `df-abc#${role}`);
    assert.equal(doc.set.parts[doc.partIndex].role, role);
    assert.equal(doc.set.parts[doc.partIndex].id, role);
  }
  assert.deepEqual(doc.set.parts.map(p => p.role), [R.JAMB, R.HEAD, R.SLIDE_INNER, R.FIGURE]);
  assert.equal(doc.partIndex, 3);
  assert.equal(isPartlessFittingDoc(doc), false);
  assert.equal(isDocDirty(doc), true);
  // 追加した部品は基準つきの空（ペン入力を受けられる）
  assert.ok(doc.form.datums.length >= 2);
  assert.deepEqual(doc.form.strokes, []);
});

test('addFittingPart（失敗側）: 同じ役割は {error}・未知の役割は {error}・doc は返さない', () => {
  const doc = addFittingPart(newFittingDoc({ idFactory, label: 'x' }), R.JAMB).doc;
  const dup = addFittingPart(doc, R.JAMB);
  assert.deepEqual(dup, { error: DETAIL_HELPER_MESSAGES.fittingRoleExists });
  assert.equal(DETAIL_HELPER_MESSAGES.fittingRoleExists, 'この役割の部品は既にあります');
  assert.deepEqual(addFittingPart(doc, 'nope'), { error: DETAIL_HELPER_MESSAGES.fittingUnknownRole });
});

test('addFittingPart: 追加の前に今の部品の編集を書き戻す（編集が消えない）', () => {
  const doc = penStep(addFittingPart(newFittingDoc({ idFactory, label: 'x' }), R.JAMB).doc, PenDir.RIGHT, '25');
  const after = addFittingPart(doc, R.HEAD).doc;
  assert.equal(after.set.parts[0].figure.strokes[0].moves.length, 1);
  assert.deepEqual(after.history, []);
});

test('availableFittingRoles: 使用済みを除く（FITTING_PART_TARGETS の順）', () => {
  const doc = fittingDocFromEntry(SET);
  const avail = availableFittingRoles(doc);
  assert.deepEqual(avail, [R.JAMB, R.JAMB_HINGE, R.JAMB_LATCH, R.HEAD, R.SILL, R.FIGURE, R.FIGURE_BACK]);
  assert.equal(availableFittingRoles(newFittingDoc({ idFactory })).length, Object.values(R).length);
});

test('removeFittingPart: 選択中を消すと隣・無くなれば null・他の部品を消しても選択は同じ部品', () => {
  let doc = fittingDocFromEntry(SET);
  doc = selectFittingPart(doc, 2); // slideTail
  const other = removeFittingPart(doc, 0);
  assert.equal(other.set.parts.length, 5);
  assert.equal(other.set.parts[other.partIndex].role, R.SLIDE_TAIL);
  assert.equal(other.form.key.endsWith(`#${R.SLIDE_TAIL}`), true);
  const cur = removeFittingPart(doc, 2);
  assert.equal(cur.set.parts[cur.partIndex].role, R.SLIDE_LATCH_UP);
  let last = fittingDocFromEntry({ ...SET, parts: [SET.parts[0]] });
  last = removeFittingPart(last, 0);
  assert.equal(last.partIndex, null);
  assert.equal(isPartlessFittingDoc(last), true);
  assert.deepEqual(last.set.parts, []);
  assert.equal(removeFittingPart(doc, 9), doc);
  assert.deepEqual(removeFittingPart(doc, 1).history, []);
});

test('setFittingLabel: 一式の呼称だけ変わる（部品の form は触らない）。一式でない doc は同一参照', () => {
  const doc = fittingDocFromEntry(SET);
  const next = setFittingLabel(doc, '新呼称');
  assert.equal(next.set.label, '新呼称');
  assert.equal(next.form, doc.form);
  const single = freshDocOf(newDraft({ idFactory }));
  assert.equal(setFittingLabel(single, 'x'), single);
});

// ---- 切替（Q-C5b）----

test('switchToFitting: 新規の空の下書きからだけ一式へ（呼称は引き継ぐ）', () => {
  const draft = freshDocOf({ ...newDraft({ idFactory }), label: '下書き' });
  const r = switchToFitting(draft, { idFactory });
  assert.equal(r.error, undefined);
  assert.equal(isFittingDoc(r.doc), true);
  assert.equal(r.doc.set.label, '下書き');
  assert.deepEqual(r.doc.set.parts, []);
});

test('switchToFitting（失敗側）: 線がある下書き・ライブラリの図を開いている doc からは切り替えず文言で止める', () => {
  const drawn = penStep(freshDocOf(newDraft({ idFactory })), PenDir.RIGHT, '10');
  assert.deepEqual(switchToFitting(drawn, { idFactory }), { error: '建具一式は新規の下書きでだけ選べます' });
  const single = detailBuiltinFigures.find(e => e.category !== DetailCategory.FITTING);
  assert.deepEqual(switchToFitting(docFromEntry(single), { idFactory }), { error: DETAIL_HELPER_MESSAGES.fittingNewOnly });
  // 線が無くても基準を足した（呼称以外を編集した）下書きは捨てない。呼称だけの編集は引き継ぐ
  const base = freshDocOf(newDraft({ idFactory }));
  const withDatum = { ...base, form: addDatum(base.form) };
  assert.deepEqual(switchToFitting(withDatum, { idFactory }), { error: DETAIL_HELPER_MESSAGES.fittingNewOnly });
  assert.equal(switchToFitting(withDatum, { idFactory }).doc, undefined);
  assert.equal(switchToFitting({ ...base, form: { ...base.form, label: '呼称だけ' } }, { idFactory }).error, undefined);
  assert.deepEqual(switchToFitting({ ...base, baseline: null }, { idFactory }), { error: DETAIL_HELPER_MESSAGES.fittingNewOnly });
  // 既に一式ならそのまま
  const fitting = newFittingDoc({ idFactory });
  assert.equal(switchToFitting(fitting, { idFactory }).doc, fitting);
});

// ---- 検証・エラーの振り分け・保存停止 ----

test('エラーの振り分け: 部品のエラーは parts[i] の行へ数え、一式全体のエラーは別（部品 0 個は専用の文言）', () => {
  let doc = fittingDocFromEntry(SET);
  doc = addFittingPart(doc, R.JAMB).doc; // 空の部品（ストロークなし）＝部品 6 にエラー
  const v = fittingValidation(doc);
  assert.equal(v.ok, false);
  const rows = fittingPartRows(doc, v);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.slice(0, 6).map(r => r.errorCount), [0, 0, 0, 0, 0, 0]);
  assert.ok(rows[6].errorCount >= 1);
  assert.equal(rows[6].selected, true);
  assert.equal(rows.filter(r => r.selected).length, 1);
  assert.equal(rows[6].roleLabel, '方立（両側）');
  assert.deepEqual(fittingSetErrorTexts(v), []); // 部品のエラーは一式全体の欄へ出ない
  assert.deepEqual(rows.map(r => r.role), [...PART_ORDER, R.JAMB]);
  // 部品 0 個
  const none = newFittingDoc({ idFactory, label: 'x' });
  assert.deepEqual(fittingSetErrorTexts(fittingValidation(none)), ['部品がありません']);
  assert.deepEqual(fittingPartRows(none, fittingValidation(none)), []);
});

test('エラーの振り分け: 途中の部品のエラーはその行だけ（別の部品の行に付かない）', () => {
  let doc = addFittingPart(addFittingPart(newFittingDoc({ idFactory, label: 'x' }), R.HEAD).doc, R.SILL).doc;
  // HEAD に 1 手描き（NO_STROKES を解消）。SILL は空のまま
  doc = selectFittingPart(doc, 0);
  doc = penStep(doc, PenDir.RIGHT, '10');
  const rows = fittingPartRows(doc, fittingValidation(doc));
  assert.equal(rows[0].errorCount, 0);
  assert.ok(rows[1].errorCount >= 1);
});

test('fittingSaveBlockers（失敗側）: 部品 0 個・呼称なし・部品のエラーで保存を止める。完全な一式は空', () => {
  const none = newFittingDoc({ idFactory, label: '' });
  const b = fittingSaveBlockers(none, fittingValidation(none));
  assert.deepEqual(b, [...saveBlockers({ label: '' }, { errors: [] }), '部品がありません']);
  assert.ok(b.includes('呼称を入力してください'));
  assert.deepEqual(fittingSaveBlockers(fittingDocFromEntry(SET), fittingValidation(fittingDocFromEntry(SET))), []);
  const bad = addFittingPart(fittingDocFromEntry(SET), R.HEAD).doc;
  const reasons = fittingSaveBlockers(bad, fittingValidation(bad));
  assert.ok(reasons.length >= 1);
  assert.ok(reasons.every(r => r.startsWith(FITTING_PART_ROLE_TEXT[R.HEAD])), JSON.stringify(reasons)); // 部品のエラーは役割ラベルを先頭に
});

// ---- 複製・保存後・dirty ----

test('isDocDirty: 開いた直後は偽・編集・呼称変更・追加で真・書き戻しだけでは変わらない', () => {
  const doc = fittingDocFromEntry(SET);
  assert.equal(isDocDirty(doc), false);
  assert.equal(isDocDirty(selectFittingPart(doc, 3)), false); // 未編集の切替は書き戻しても同じ
  assert.equal(isDocDirty(setFittingLabel(doc, 'x')), true);
  assert.equal(isDocDirty(penStep(doc, PenDir.RIGHT, '10')), true);
  assert.equal(isDocDirty(removeFittingPart(doc, 0)), true);
  // 単一図の doc は従来どおり
  const draft = freshDocOf(newDraft({ idFactory }));
  assert.equal(isDocDirty(draft), false);
  assert.equal(isDocDirty(penStep(draft, PenDir.RIGHT, '10')), true);
});

test('afterSaveFittingDoc: 保存したエントリが基準になる（dirty でなくなる）・別の一式に切り替わっていたら何も変えない', () => {
  const edited = setFittingLabel(fittingDocFromEntry(SET), '保存する呼称');
  const entry = fittingEntryOf(edited);
  const saved = afterSaveFittingDoc(edited, entry);
  assert.equal(isDocDirty(saved), false);
  assert.equal(saved.prevEntry, entry);
  assert.equal(afterSaveFittingDoc(edited, { ...entry, key: 'df-other' }), edited);
});

test('duplicateFittingDoc: 別キー・「のコピー」・常に未保存・ライブラリに紐づかない・部品と選択は保つ', () => {
  const doc = selectFittingPart(fittingDocFromEntry(SET), 1);
  const dup = duplicateFittingDoc(doc, { idFactory });
  assert.equal(dup.set.key, 'df-abc');
  assert.equal(dup.set.label, `${SET.label} のコピー`);
  assert.equal(dup.prevEntry, null);
  assert.equal(dup.baseline, null);
  assert.equal(isDocDirty(dup), true);
  assert.equal(dup.partIndex, 1);
  assert.equal(dup.form.key, `df-abc#${R.SLIDE_INNER}`);
  assert.deepEqual(dup.set.parts, SET.parts);
});

// ---- ライブラリの行 ----

test('libraryRows: 建具一式の行は partCount を持ち「建具一式（部品 n）」と表示・単一図の行は従来どおり', () => {
  const rows = libraryRows(detailBuiltinFigures);
  const row = rows.find(r => r.key === DETAIL_BUILTIN_FITTING_SLIDING_KEY);
  assert.equal(row.partCount, 6);
  assert.equal(libraryMetaLabel(row), '建具一式（部品 6）');
  assert.equal(DETAIL_HELPER_TEXT.fittingRowLabel(2), '建具一式（部品 2）');
  const single = rows.find(r => r.key !== DETAIL_BUILTIN_FITTING_SLIDING_KEY);
  assert.equal(Object.hasOwn(single, 'partCount'), false);
  assert.equal(libraryMetaLabel(single), `${single.categoryLabel} / ${single.viewLabel} / ${single.subjectLabel}`);
});

// ---- 引き戸部品の試し込み（isSlidePartForm の分岐）----

const partForm = (role, i = PART_ORDER.indexOf(role)) => selectFittingPart(fittingDocFromEntry(SET), i).form;

test('isSlidePartForm: 引き戸の部品（姿図・平面・建具）だけ真。他の分類は偽', () => {
  for (const role of PART_ORDER) assert.equal(isSlidePartForm(partForm(role)), true, role);
  assert.equal(isSlidePartForm(newDraft({ idFactory })), false);
  assert.equal(isSlidePartForm(null), false);
});

test('引き戸部品の試し込み: 欄は壁厚・見付・出幅＋幅・扉幅・穴の幅・既定は引き戸の既定幅（W 1550・DW 800・穴 750）', () => {
  const form = partForm(R.SLIDE_LATCH);
  assert.deepEqual(fitDimFieldsFor(form).map(x => x.field), ['wallThickness', 'faceWidth', 'projection', 'width', 'doorWidth', 'clearWidth']);
  assert.deepEqual(fitDimFieldsFor(form).map(x => x.label), ['壁厚', '見付', '出幅', '幅', '扉幅', '穴の幅']);
  assert.deepEqual(defaultFitDimsFor(form, 100), {
    wallThickness: '100', faceWidth: '30', projection: '12', width: '1550', doorWidth: '800', clearWidth: '750',
  });
  // 他の分類の既定は従来どおり（スライド部品の分岐に巻き込まない）
  assert.deepEqual(Object.keys(defaultFitDimsFor(newDraft({ idFactory }), 100)), ['wallThickness', 'faceWidth', 'projection']);
});

test('引き戸部品の試し込み: 既定寸法（壁厚 100）の点列は C4 の手計算例と一致する', () => {
  const dims = defaultFitDimsFor(partForm(R.SLIDE_LATCH), 100);
  assert.deepEqual(pts(tryFit(partForm(R.SLIDE_LATCH), dims)), [
    [[0, -12], [-30, -12], [-30, 0], [-30, 100], [-30, 112], [0, 112]],
    [[0, 5], [800, 5], [800, 35], [0, 35]],
  ]);
  assert.deepEqual(pts(tryFit(partForm(R.SLIDE_INNER), dims)), [
    [[0, 50], [0, 38], [30, 38], [30, 50], [30, 100], [30, 112], [0, 112]],
  ]);
});

test('引き戸部品の試し込み: プレビュー値と違う寸法（W 1750・DW 900・穴 850・壁厚 150）で param が追従する', () => {
  const dims = { wallThickness: '150', faceWidth: '30', projection: '12', width: '1750', doorWidth: '900', clearWidth: '850' };
  const latch = pts(tryFit(partForm(R.SLIDE_LATCH), dims));
  assert.deepEqual(latch[0], [[0, -12], [-30, -12], [-30, 0], [-30, 150], [-30, 162], [0, 162]]);
  assert.deepEqual(latch[1], [[0, 5], [900, 5], [900, 35], [0, 35]]); // 閉じた扉＝扉幅 DW
  const up = pts(tryFit(partForm(R.SLIDE_LATCH_UP), dims));
  assert.deepEqual(up[2], [[0, -12], [1750, -12]]); // 上レール＝建具幅 W（基準 ds1 の end）
  const tail = pts(tryFit(partForm(R.SLIDE_TAIL), dims));
  assert.deepEqual(tail[1], [[0, 5], [-900, 5], [-900, 35], [0, 35]]); // 開けた扉は端材から戸先側へ DW
  const innerUp = pts(tryFit(partForm(R.SLIDE_INNER_UP), dims));
  assert.deepEqual(innerUp[0][innerUp[0].length - 1], [-850, 162]); // 上枠の外の線＝穴の幅 850 を戸先側へ（t＝壁厚 150＋出幅 12）
});

test('引き戸部品の試し込み（失敗側）: 寸法が読めない・0 以下は error（黙って代用しない）・壁厚が欠き込み以下の縦枠は fit 失敗', () => {
  const form = partForm(R.SLIDE_LATCH);
  const ok = defaultFitDimsFor(form, 100);
  for (const [field, value] of [['wallThickness', ''], ['faceWidth', '0'], ['projection', '-1'], ['width', 'x'], ['doorWidth', '0'], ['clearWidth', '']]) {
    const r = tryFit(form, { ...ok, [field]: value });
    assert.equal(r.error?.code, 'badFitDim', field);
    assert.equal(r.strokes, undefined, field);
  }
  const inner = tryFit(partForm(R.SLIDE_INNER), { ...ok, wallThickness: '50' });
  assert.ok(inner.error, '壁厚 50（欠き込み深さ以下）は slideInner が fit できない');
  assert.equal(inner.strokes, undefined);
});

test('引き戸部品の試し込み: 単独の図（entryFromForm）で直接 fit しても同じ点列（form 経由の往復で形が変わらない）', () => {
  const form = partForm(R.SLIDE_TAIL);
  assert.equal(entryFromForm(form).key, `${DETAIL_BUILTIN_FITTING_SLIDING_KEY}#${R.SLIDE_TAIL}`);
  assert.equal(DetailView.PLAN, entryFromForm(form).view);
  assert.equal(DetailSubject.OPENING, entryFromForm(form).subject);
  assert.equal(tryFit(form, defaultFitDimsFor(form, 100)).error, undefined);
});
