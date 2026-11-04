// 部分詳細図ヘルパーの組込み層（S8d）: 組込みは読み取り専用で一覧に出る／編集＝同キーの上書き／組込みに戻す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays, overlayFor, docDiffMap } from '../catalog/catalogRegistry.js';
import { applyCatalogEditPlan, planRemoveUserEntry } from '../catalog/catalogMaintenance.js';
import { collectUsedKeysByKind, buildDocumentBundle } from '../catalog/usedEntries.js';
import { bundleEntries } from '../catalog/catalogBundle.js';
import { detailBuiltinFigures } from '../detail/detailPlacement.js';
import { detailFigureCatalog } from '../openings/openingCatalog.js';
import {
  DETAIL_BUILTIN_BASEBOARD_KEY, DETAIL_BUILTIN_KNEE_CAP_KEY, DETAIL_BUILTIN_DOOR_JAMB_KEY, DETAIL_BUILTIN_DOOR_HEAD_KEY,
  DETAIL_BUILTIN_WINDOW_JAMB_KEY, DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY, DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY,
} from '../core/constants.js';
import {
  formFromEntry, entryFromForm, setMoveLen, planSave, saveContextFor, saveDecision, docContextFor, docFromEntry, unlockDoc,
  docForLibraryEntry, helperLibraryRows, libraryOriginOf, libraryRowActions, libraryEntryOf, planRevert, LIBRARY_ORIGIN,
  DETAIL_HELPER_MESSAGES, DETAIL_HELPER_TEXT,
} from './detailHelperForm.js';

const DF = CatalogKind.DETAIL_FIGURE;
const BASEBOARD = detailBuiltinFigures.find(e => e.key === DETAIL_BUILTIN_BASEBOARD_KEY);
const BUILTIN_KEYS = new Set(detailBuiltinFigures.map(e => e.key));
const ctxOf = () => docContextFor(DF, { overlayFor, docDiffMap, builtinList: detailBuiltinFigures });
// 巾木の「出」（固定 10）を 12 に変えた編集後エントリ。
const editedBaseboard = () => entryFromForm(setMoveLen(formFromEntry(BASEBOARD), { strokeId: 'a', moveIndex: 1 }, '12'));
// 保存の完了までを純モジュールで再現（ヘルパーの performSave と同じ applyCatalogEditPlan）。
const apply = (plan, markDirty = () => {}) => applyCatalogEditPlan(DF, plan, { saveFn: async () => {}, markDirty });
const withOverlay = fn => async () => { try { await fn(); } finally { clearOverlays(); } };

test('S8d 一覧: 組込み 7 件が出所バッジ「組込み」つきで出る（ライブラリは「ライブラリ」）', withOverlay(() => {
  const rows = helperLibraryRows({ userEntries: [], builtinList: detailBuiltinFigures });
  assert.deepEqual(rows.map(r => r.key).sort(), [
    DETAIL_BUILTIN_BASEBOARD_KEY, DETAIL_BUILTIN_KNEE_CAP_KEY, DETAIL_BUILTIN_DOOR_JAMB_KEY, DETAIL_BUILTIN_DOOR_HEAD_KEY,
    DETAIL_BUILTIN_WINDOW_JAMB_KEY, DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY, DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY,
  ].sort());
  assert.ok(rows.every(r => r.origin === LIBRARY_ORIGIN.BUILTIN && r.originLabel === '組込み'));
  const user = { ...BASEBOARD, key: 'df-user', label: 'ユーザー図' };
  const rows2 = helperLibraryRows({ userEntries: [user], builtinList: detailBuiltinFigures });
  assert.equal(rows2.length, 8);
  assert.equal(rows2.find(r => r.key === 'df-user').originLabel, 'ライブラリ');
}));

test('S8d 一覧: 組込みと同キーのライブラリは上書き行 1 つだけ（重複しない・バッジ「上書き」・呼称は上書きの内容）', withOverlay(() => {
  const over = { ...BASEBOARD, label: '巾木 出 12', overridesBuiltin: true };
  const rows = helperLibraryRows({ userEntries: [over], builtinList: detailBuiltinFigures });
  const same = rows.filter(r => r.key === DETAIL_BUILTIN_BASEBOARD_KEY);
  assert.equal(same.length, 1);
  assert.equal(same[0].origin, LIBRARY_ORIGIN.OVERRIDE);
  assert.equal(same[0].originLabel, '上書き');
  assert.equal(same[0].label, '巾木 出 12');
  assert.equal(rows.length, 7);
}));

test('S8d 操作: 組込み行は rowState=builtin（編集の解錠と複製だけ・削除と戻すは不可）／上書き行は戻す（削除は戻すに置換）／ライブラリ行は従来どおり削除', () => {
  const b = libraryRowActions(LIBRARY_ORIGIN.BUILTIN, BASEBOARD, BUILTIN_KEYS);
  assert.deepEqual(b, { state: 'builtin', needsUnlock: true, canRevert: false, canDelete: false, canDuplicate: true });
  const o = libraryRowActions(LIBRARY_ORIGIN.OVERRIDE, { ...BASEBOARD, overridesBuiltin: true }, BUILTIN_KEYS);
  assert.deepEqual(o, { state: 'override', needsUnlock: false, canRevert: true, canDelete: false, canDuplicate: true });
  const u = libraryRowActions(LIBRARY_ORIGIN.USER, { ...BASEBOARD, key: 'df-user' }, BUILTIN_KEYS);
  assert.deepEqual(u, { state: 'user', needsUnlock: false, canRevert: false, canDelete: true, canDuplicate: true });
  assert.equal(libraryOriginOf('zzz', { builtinKeys: BUILTIN_KEYS, userKeys: new Set() }), null);
});

test('S8d doc: 組込みは読み取り専用で開き、解錠で編集可になる（prevEntry は組込みのまま）。ライブラリ・上書きは最初から編集可', () => {
  const d = docForLibraryEntry(BASEBOARD, LIBRARY_ORIGIN.BUILTIN);
  assert.equal(d.readOnly, true);
  assert.equal(d.prevEntry, BASEBOARD);
  const un = unlockDoc(d);
  assert.equal(un.readOnly, false);
  assert.equal(un.prevEntry, BASEBOARD);
  assert.equal(docForLibraryEntry(BASEBOARD, LIBRARY_ORIGIN.OVERRIDE).readOnly, undefined);
  assert.equal(docFromEntry(BASEBOARD).readOnly, undefined);
  const free = docFromEntry(BASEBOARD);
  assert.equal(unlockDoc(free), free);
});

test('S8d 編集→上書き: 組込みを開いて保存すると user に同キー・overridesBuiltin:true の図ができ、一覧は上書き行 1 つ、割当て先（detailFigureCatalog）で組込みを覆う', withOverlay(async () => {
  setOverlay(DF, { user: [], doc: [] });
  const ctx = ctxOf();
  assert.deepEqual(saveContextFor(BASEBOARD, ctx), { rowState: 'builtin', blocked: null });
  const edited = editedBaseboard();
  const plan = planSave(edited, BASEBOARD, ctx);
  assert.equal(plan.ok, true);
  assert.equal(plan.noop, false);
  assert.equal(plan.overridesBuiltin, true);
  assert.equal(plan.removeDocKey, null);
  await apply(plan);
  const user = overlayFor(DF).user;
  assert.equal(user.length, 1);
  assert.equal(user[0].key, DETAIL_BUILTIN_BASEBOARD_KEY);
  assert.equal(user[0].overridesBuiltin, true);
  const composed = detailFigureCatalog().get(DETAIL_BUILTIN_BASEBOARD_KEY);
  assert.equal(composed.strokes[0].moves[1].len.mm, 12, '上書きが組込みを覆う');
  assert.equal(BASEBOARD.strokes[0].moves[1].len.mm, 10, '組込み自身は不変');
  const rows = helperLibraryRows({ userEntries: user, builtinList: detailBuiltinFigures });
  assert.equal(rows.filter(r => r.key === DETAIL_BUILTIN_BASEBOARD_KEY).length, 1);
  assert.equal(rows.find(r => r.key === DETAIL_BUILTIN_BASEBOARD_KEY).origin, LIBRARY_ORIGIN.OVERRIDE);
  // 上書き後に開き直した図の行状態は override
  assert.equal(saveContextFor(user[0], ctxOf()).rowState, 'override');
}));

test('S8d 失敗系: 組込みと同一内容のまま保存しようとすると「変更なし」（user を作らない）', withOverlay(async () => {
  setOverlay(DF, { user: [], doc: [] });
  const same = entryFromForm(formFromEntry(BASEBOARD));
  const plan = planSave(same, BASEBOARD, ctxOf());
  assert.equal(plan.ok, true);
  assert.equal(plan.noop, true);
  const decision = saveDecision(plan);
  assert.equal(decision.apply, false);
  assert.equal(decision.message, DETAIL_HELPER_MESSAGES.noop);
  assert.deepEqual(overlayFor(DF).user, []);
}));

test('S8d 失敗系: キーは変えられない（別キーで組込みを開いたまま保存は拒否）', withOverlay(() => {
  setOverlay(DF, { user: [], doc: [] });
  const renamed = { ...editedBaseboard(), key: 'df-other' };
  const plan = planSave(renamed, BASEBOARD, ctxOf());
  assert.equal(plan.ok, false);
  assert.ok(plan.message.length > 0);
}));

test('S8d 重複禁止: 上書きは同キーなので別キー・同内容の禁止に当たらない。別キーで組込みと同内容の新規は従来どおり拒否', withOverlay(() => {
  setOverlay(DF, { user: [], doc: [] });
  const plan = planSave(editedBaseboard(), BASEBOARD, ctxOf());
  assert.equal(plan.ok, true);
  const dup = { ...BASEBOARD, key: 'df-copy' };
  const dupPlan = planSave(dup, null, ctxOf());
  assert.equal(dupPlan.ok, false);
}));

test('S8d 組込みに戻す: user から外れ組込みが戻る。doc の同キーは alsoRealignDoc のとき removeDocKey で外す（markDirty）', withOverlay(async () => {
  const over = { ...editedBaseboard(), overridesBuiltin: true };
  setOverlay(DF, { user: [over], doc: [{ ...over }] });
  assert.equal(detailFigureCatalog().get(DETAIL_BUILTIN_BASEBOARD_KEY).strokes[0].moves[1].len.mm, 12);
  const userKeys = new Set([DETAIL_BUILTIN_BASEBOARD_KEY]);
  const r = planRevert(DETAIL_BUILTIN_BASEBOARD_KEY, { builtinKeys: BUILTIN_KEYS, userKeys });
  assert.equal(r.ok, true);
  assert.equal(r.plan.removeDocKey, DETAIL_BUILTIN_BASEBOARD_KEY);
  let dirty = 0;
  await apply(r.plan, () => { dirty += 1; });
  assert.deepEqual(overlayFor(DF).user, []);
  assert.deepEqual(overlayFor(DF).doc, []);
  assert.equal(dirty, 1);
  assert.equal(detailFigureCatalog().get(DETAIL_BUILTIN_BASEBOARD_KEY).strokes[0].moves[1].len.mm, 10, '組込みが戻る');
  assert.equal(libraryEntryOf(DETAIL_BUILTIN_BASEBOARD_KEY, { userEntries: overlayFor(DF).user, builtinList: detailBuiltinFigures }), BASEBOARD);
}));

test('S8d 組込みに戻す: 同梱を合わせないチェック外しなら doc は残す', withOverlay(async () => {
  const over = { ...editedBaseboard(), overridesBuiltin: true };
  setOverlay(DF, { user: [over], doc: [{ ...over, overridesBuiltin: undefined }] });
  const r = planRevert(DETAIL_BUILTIN_BASEBOARD_KEY, { builtinKeys: BUILTIN_KEYS, userKeys: new Set([over.key]), alsoRealignDoc: false });
  assert.equal(r.plan.removeDocKey, null);
  await apply(r.plan);
  assert.deepEqual(overlayFor(DF).user, []);
  assert.equal(overlayFor(DF).doc.length, 1);
}));

test('S8d 失敗系: 組込みでないキー・上書きの無い組込みは戻せず、失敗文言を返す', () => {
  const notBuiltin = planRevert('df-user', { builtinKeys: BUILTIN_KEYS, userKeys: new Set(['df-user']) });
  assert.deepEqual(notBuiltin, { ok: false, message: DETAIL_HELPER_MESSAGES.revertNotBuiltin });
  const noOverride = planRevert(DETAIL_BUILTIN_BASEBOARD_KEY, { builtinKeys: BUILTIN_KEYS, userKeys: new Set() });
  assert.deepEqual(noOverride, { ok: false, message: DETAIL_HELPER_MESSAGES.revertNoOverride });
  const missing = planRevert('df-nothing', { builtinKeys: BUILTIN_KEYS, userKeys: new Set() });
  assert.equal(missing.ok, false);
});

test('S8d 削除: 組込み・上書きの削除は許さない（操作表）。ライブラリ行の planRemoveUserEntry は従来どおり／存在しないキーは投げる', withOverlay(() => {
  const user = { ...BASEBOARD, key: 'df-user', label: 'ユーザー図' };
  setOverlay(DF, { user: [user], doc: [] });
  assert.equal(libraryRowActions(LIBRARY_ORIGIN.BUILTIN, BASEBOARD, BUILTIN_KEYS).canDelete, false);
  assert.equal(libraryRowActions(LIBRARY_ORIGIN.OVERRIDE, BASEBOARD, BUILTIN_KEYS).canDelete, false);
  assert.equal(libraryRowActions(LIBRARY_ORIGIN.USER, user, BUILTIN_KEYS).canDelete, true);
  assert.deepEqual(planRemoveUserEntry(DF, 'df-user').nextUser, []);
  assert.throws(() => planRemoveUserEntry(DF, DETAIL_BUILTIN_BASEBOARD_KEY), /ユーザーライブラリに無いキー/);
}));

test('S8d 同梱: 暗黙の既定で使う組込み巾木の上書きが同梱され、ライブラリ・本体の無い別環境（doc 層だけ）でも上書きの形で解決される', withOverlay(() => {
  const over = { ...editedBaseboard(), overridesBuiltin: true };
  setOverlay(DF, { user: [over], doc: [] });
  const used = collectUsedKeysByKind([{ rooms: [{ id: 'r1', finish: { baseboardHeight: 'h=60' } }] }], [DF]);
  assert.deepEqual([...used.get(DF)], [DETAIL_BUILTIN_BASEBOARD_KEY]);
  const { bundle, unresolvedKeys } = buildDocumentBundle({ usedKeysByKind: used, resolvedByKind: new Map([[DF, detailFigureCatalog()]]) });
  assert.equal(unresolvedKeys.size, 0);
  const bundled = bundleEntries(bundle, DF);
  assert.equal(bundled.length, 1);
  assert.equal(bundled[0].overridesBuiltin, undefined, '標準を編集の印は同梱に持ち出さない');
  // 別環境: ライブラリ無し・同梱だけ
  setOverlay(DF, { user: [], doc: bundled });
  assert.equal(detailFigureCatalog().get(DETAIL_BUILTIN_BASEBOARD_KEY).strokes[0].moves[1].len.mm, 12);
}));

test('S8d 同梱: 失敗系＝巾木高さの無い文書では組込み巾木を同梱しない（上書きがあっても使用キーに入らない）', withOverlay(() => {
  setOverlay(DF, { user: [{ ...editedBaseboard(), overridesBuiltin: true }], doc: [] });
  const used = collectUsedKeysByKind([{ rooms: [{ id: 'r1', finish: { baseboardHeight: '' } }] }], [DF]);
  assert.equal(used.get(DF).size, 0);
  const { bundle } = buildDocumentBundle({ usedKeysByKind: used, resolvedByKind: new Map([[DF, detailFigureCatalog()]]) });
  assert.deepEqual(bundleEntries(bundle, DF), []);
}));

test('S8d 一覧: 同梱に組込みと同キーの別内容がある行は docDiff（印「文書」）。同内容・同梱なしは印なし', withOverlay(() => {
  const docEntry = editedBaseboard(); // 組込みと別内容の同梱
  setOverlay(DF, { user: [], doc: [docEntry] });
  const ctx = ctxOf();
  const rows = helperLibraryRows({ userEntries: [], builtinList: detailBuiltinFigures, docContext: ctx });
  assert.equal(rows.find(r => r.key === DETAIL_BUILTIN_BASEBOARD_KEY).docDiff, true);
  assert.equal(rows.find(r => r.key === DETAIL_BUILTIN_KNEE_CAP_KEY).docDiff, false);
  assert.equal(DETAIL_HELPER_TEXT.docDiffBadge, '文書');
  // 同内容の同梱は印なし
  setOverlay(DF, { user: [], doc: [BASEBOARD] });
  const same = helperLibraryRows({ userEntries: [], builtinList: detailBuiltinFigures, docContext: ctxOf() });
  assert.ok(same.every(r => r.docDiff === false));
  // docContext 省略（従来呼び出し）は印なし
  assert.ok(helperLibraryRows({ userEntries: [], builtinList: detailBuiltinFigures }).every(r => r.docDiff === false));
}));

test('S8d 保存: 同梱に組込みと同キーの別内容（doc-diff）があると saveContextFor が止め、planSave は失敗する', withOverlay(() => {
  setOverlay(DF, { user: [], doc: [editedBaseboard()] });
  const ctx = ctxOf();
  const sc = saveContextFor(BASEBOARD, ctx);
  assert.equal(sc.rowState, 'doc-diff');
  assert.ok(sc.blocked);
  const plan = planSave(entryFromForm(formFromEntry(BASEBOARD)), BASEBOARD, ctx);
  assert.equal(plan.ok, false);
  assert.equal(plan.message, sc.blocked);
}));

test('S8d 文言: ボタン・バッジの文言（置き場は DETAIL_HELPER_TEXT）', () => {
  assert.equal(DETAIL_HELPER_TEXT.editOverride, '編集（上書きを作る）');
  assert.equal(DETAIL_HELPER_TEXT.revertToBuiltin, '組込みに戻す');
  assert.deepEqual({ ...DETAIL_HELPER_TEXT.originBadge }, { builtin: '組込み', user: 'ライブラリ', override: '上書き' });
  assert.equal(DETAIL_HELPER_TEXT.revertTitle, '標準に戻しますか？');
  assert.equal(DETAIL_HELPER_TEXT.revertAlsoDoc, 'この文書の同梱も標準に合わせる');
});
