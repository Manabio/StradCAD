// catalogRegistry.js の overlay を立てる系（setOverlay/clearOverlays）。node:test はファイル単位で
// 別プロセスのため、composeCatalog等の「overlay空」不変条件を確認する catalogRegistry.test.js
// とは別ファイルにして overlay 汚染を避ける。setOverlay → composeCatalog/composeList/originOf →
// clearOverlays → 空に戻ることを、発火回数を assert する形で確認する（空振り防止）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setOverlay, clearOverlays, overlayFor, composeCatalog, composeList, originOf } from './catalogRegistry.js';
import { ERR_CATALOG_DUPLICATE } from '../error.js';
import { assertNoDuplicate } from './catalogMatch.js';

function material(overrides) {
  return {
    code: '301000000001', name: 'せっこうボード t=9.5', spec: 'JIS A 6901', x: 0, y: 0, thickness: 9.5, note: '', category: 'panel',
    ...overrides,
  };
}

test.afterEach(() => clearOverlays());

// ---- 2026-09-22 QA指摘A: setOverlayの検証（非配列・エントリ不正） ----
test('【失敗系・2026-09-22 QA指摘A】setOverlay: docが配列でなければ例外', () => {
  assert.throws(() => setOverlay('material', { doc: 'not-an-array' }), /docは配列/);
});

test('【失敗系・2026-09-22 QA指摘A】setOverlay: userが配列でなければ例外', () => {
  assert.throws(() => setOverlay('material', { user: { code: '999999999999' } }), /userは配列/);
});

test('【失敗系・2026-09-22 QA指摘A】setOverlay: エントリがkindDef(kind).validateを通らなければ例外（材のcode欠落）', () => {
  assert.throws(
    () => setOverlay('material', { doc: [{ name: 'x', spec: 'y', x: 0, y: 0, thickness: 9.5 }] }),
    /必須項目が欠落.*code/,
  );
});

test('【失敗系・2026-09-22 QA指摘A】setOverlay: userのエントリ不正も同様に例外', () => {
  assert.throws(
    () => setOverlay('material', { user: [{ code: '999999999999' }] }),
    /必須項目が欠落/,
  );
});

test('setOverlay: 検証に失敗したら overlay は書き換わらない（前の内容が残る）', () => {
  const docEntry = material({ code: '999999999999' });
  setOverlay('material', { doc: [docEntry] });
  assert.throws(() => setOverlay('material', { doc: [{ code: '301000000001' }] })); // name等欠落で例外
  assert.deepEqual(overlayFor('material').doc, [docEntry]); // 前の内容のまま
});

// ---- 2026-09-22 QA指摘・Minor: setOverlay(kind, {}) は overlay を消す（clearOverlays相当） ----
test('setOverlay(kind, {}): doc/userとも空なら既定値(空配列の組)に戻る', () => {
  setOverlay('material', { doc: [material({ code: '999999999999' })] });
  assert.equal(overlayFor('material').doc.length, 1);
  setOverlay('material', {}); // doc/user省略=空
  assert.deepEqual(overlayFor('material'), { doc: [], user: [] });
});

// ---- 2026-09-22 QA指摘A残存: 第2引数はプレーンオブジェクト限定・未知キーは例外（T5） ----
test('【失敗系・2026-09-22 QA指摘A残存・T5】setOverlay: 第2引数が配列なら例外（分割代入だけでは配列も素通りしてしまうため明示検査）', () => {
  const docEntry = material({ code: '999999999999' });
  setOverlay('material', { doc: [docEntry] });
  assert.throws(() => setOverlay('material', [docEntry]), /プレーンオブジェクト|オブジェクトである必要/);
  assert.deepEqual(overlayFor('material').doc, [docEntry], '例外時は既存overlayが消えない');
});

test('【失敗系・2026-09-22 QA指摘A残存・T5】setOverlay: 第2引数が文字列なら例外', () => {
  const docEntry = material({ code: '999999999999' });
  setOverlay('material', { doc: [docEntry] });
  assert.throws(() => setOverlay('material', 'not-an-object'), /オブジェクトである必要/);
  assert.deepEqual(overlayFor('material').doc, [docEntry], '例外時は既存overlayが消えない');
});

test('【失敗系・2026-09-22 QA指摘A残存・T5】setOverlay: doc/user以外の未知キーは例外（既存overlayは消えない）', () => {
  const docEntry = material({ code: '999999999999' });
  setOverlay('material', { doc: [docEntry] });
  assert.throws(() => setOverlay('material', { doc: [docEntry], typo: [] }), /未知のキー/);
  assert.deepEqual(overlayFor('material').doc, [docEntry], '例外時は既存overlayが消えない');
});

// ---- 2026-09-22 QA指摘A残存・T4: setOverlay(kind,{}) が内部状態を「未設定」に戻すことを
// composeCatalogの結果＝clearOverlays後と同一で観測する（overlays.size等の内部表現には依存しない）----
test('【2026-09-22 QA指摘A残存・T4】setOverlay(kind, {}): composeCatalogの結果がclearOverlays後と同一になる（内部でdelete/空setのどちらでも観測不能な設計）', () => {
  const builtinEntry = material();
  setOverlay('material', { user: [material({ code: '999999999999', name: '別材' })] });
  setOverlay('material', {}); // 空に戻す
  const afterEmptySet = composeCatalog('material', [builtinEntry]);

  clearOverlays();
  const afterClear = composeCatalog('material', [builtinEntry]);

  assert.deepEqual([...afterEmptySet.entries()], [...afterClear.entries()]);
  assert.equal(afterEmptySet.get(builtinEntry.code), afterClear.get(builtinEntry.code));
});

test('setOverlay/overlayFor: 設定した内容がそのまま読める', () => {
  const docEntry = material({ code: '999999999999', note: 'doc' });
  setOverlay('material', { doc: [docEntry] });
  const overlay = overlayFor('material');
  assert.equal(overlay.doc.length, 1);
  assert.equal(overlay.doc[0], docEntry);
  assert.deepEqual(overlay.user, []);
});

test('clearOverlays: setOverlay後にclearOverlaysすると空に戻る', () => {
  setOverlay('material', { user: [material({ code: '999999999999' })] });
  assert.equal(overlayFor('material').user.length, 1);
  clearOverlays();
  assert.deepEqual(overlayFor('material'), { doc: [], user: [] });
});

// ---- 解決順（doc>user>builtin）----
test('composeCatalog: doc > user > builtin の順に勝つ', () => {
  const builtinEntry = material({ note: 'builtin' });
  const userEntry = material({ note: 'user' });
  const docEntry = material({ note: 'doc' });
  setOverlay('material', { doc: [docEntry], user: [userEntry] });
  const map = composeCatalog('material', [builtinEntry]);
  assert.equal(map.get(builtinEntry.code), docEntry);
  assert.equal(map.size, 1);
});

test('composeCatalog: docが無ければuserがbuiltinに勝つ', () => {
  const builtinEntry = material({ note: 'builtin' });
  const userEntry = material({ note: 'user' });
  setOverlay('material', { user: [userEntry] });
  const map = composeCatalog('material', [builtinEntry]);
  assert.equal(map.get(builtinEntry.code), userEntry);
});

// ---- composeList の位置規則 ----
test('composeList: 同キーの上書き(user)はbuiltinの位置に置かれる（並びは変わらない）', () => {
  const b1 = material({ code: '301000000001', name: 'A' });
  const b2 = material({ code: '301000000002', name: 'B' });
  const userOverride = material({ code: '301000000001', name: 'A(user上書き)' });
  setOverlay('material', { user: [userOverride] });
  const list = composeList('material', [b1, b2]);
  assert.equal(list.length, 2);
  assert.equal(list[0], userOverride); // b1と同じ位置(先頭)にuser版が入る
  assert.equal(list[1], b2);
});

test('composeList: builtinに無いuser/docの追加分は末尾に置かれる', () => {
  const b1 = material({ code: '301000000001', name: 'A' });
  const extraUser = material({ code: '999999999998', name: '追加(user)' });
  const extraDoc = material({ code: '999999999999', name: '追加(doc)' });
  setOverlay('material', { user: [extraUser], doc: [extraDoc] });
  const list = composeList('material', [b1]);
  assert.equal(list.length, 3);
  assert.equal(list[0], b1);
  assert.deepEqual(list.slice(1).map(e => e.code).sort(), [extraDoc.code, extraUser.code].sort());
});

// ---- originOf ----
test('originOf: 設定したoverlayに応じてdoc/user/builtinを返す', () => {
  const builtinEntry = material({ code: '301000000001' });
  // dedupeFields（name等）まで同じにするとR17の合成後検査（本テスト追加時に揃えた挙動）に
  // 引っかかってしまうため、docEntryはnameを変えて別内容にする（2026-09-22 QA指摘・Minor対応）。
  const docEntry = material({ code: '301000000002', name: '別材(doc)' });
  setOverlay('material', { doc: [docEntry] });
  assert.equal(originOf('material', builtinEntry.code, [builtinEntry]), 'builtin');
  assert.equal(originOf('material', docEntry.code, [builtinEntry]), 'doc');
});

// ---- R17 合成後の強制（裁定A）----
test('【失敗系】composeCatalog: builtinと5項目一致・categoryだけ違うuserエントリは合成後に例外（裁定A）', () => {
  const builtinEntry = material({ code: '301000000001', category: 'panel' });
  const conflictingUser = material({ code: '301200000002', category: 'backing' }); // 5項目一致・categoryだけ違う
  setOverlay('material', { user: [conflictingUser] });
  assert.throws(() => composeCatalog('material', [builtinEntry]), /既に登録されています/);
});

test('【失敗系】composeList: builtinと5項目一致・categoryだけ違うdocエントリは合成後に例外（裁定A）', () => {
  const builtinEntry = material({ code: '301000000001', category: 'panel' });
  const conflictingDoc = material({ code: '301200000002', category: 'backing' });
  setOverlay('material', { doc: [conflictingDoc] });
  assert.throws(() => composeList('material', [builtinEntry]), /既に登録されています/);
});

// ---- 2026-09-22 QA指摘B/C: R17例外の.codeと文言（doc/builtinの出所を併記） ----
test('【失敗系・2026-09-22 QA指摘B/C】composeCatalog: builtin⇔docの重複例外は.code=ERR_CATALOG_DUPLICATEを持ち、出所(builtin/doc)を併記する', () => {
  const builtinEntry = material({ code: '102000000003', name: 'せっこうボード t=12.5', category: 'panel' });
  const docEntry = material({ code: '302000000001', name: 'せっこうボード t=12.5', category: 'backing' });
  setOverlay('material', { doc: [docEntry] });
  try {
    composeCatalog('material', [builtinEntry]);
    assert.fail('例外が投げられなかった');
  } catch (e) {
    assert.equal(e.code, ERR_CATALOG_DUPLICATE);
    assert.match(e.message, /102000000003（せっこうボード t=12\.5・builtin）/);
    assert.match(e.message, /302000000001（せっこうボード t=12\.5・doc）/);
  }
});

test('【失敗系・2026-09-22 QA指摘・Minor】originOf: overlay込みでdedupeFields完全一致があれば例外（composeCatalog/composeListと挙動を揃える）', () => {
  const builtinEntry = material({ code: '301000000001', category: 'panel' });
  const conflictingUser = material({ code: '301200000002', category: 'backing' });
  setOverlay('material', { user: [conflictingUser] });
  assert.throws(() => originOf('material', builtinEntry.code, [builtinEntry]), /既に登録されています/);
});

// ---- 2026-09-22 QA指摘E: O(n)正規化（catalogRegistry.js normalizeDedupeValue）の意味論を
// 固定する（trim・null≡undefined・null≠0）。変異N1(trim除去)・N2(null≠undefined)・
// N3(0≡nullish)がそれぞれ赤になることを別途 npm test 全体実行で確認する（報告に記載）。----

// T1: 前後空白だけ違う（別code）のdocエントリは重複とみなし例外（trim規則）
test('【失敗系・2026-09-22 QA指摘E・T1】registryのO(n)正規化: 前後空白だけ違う名称は同値とみなし重複例外にする（trim）', () => {
  const builtinEntry = material({ code: '301000000001', name: 'せっこうボード t=9.5' });
  const docEntry = material({ code: '301000000002', name: '  せっこうボード t=9.5  ' }); // 前後空白のみ違う
  setOverlay('material', { doc: [docEntry] });
  assert.throws(() => composeCatalog('material', [builtinEntry]), /既に登録されています/);
});

// T2: thickness:null同士は同値で重複例外。片方省略(undefined)も同様（registry・
// assertNoDuplicate単体の両方で確認）
test('【失敗系・2026-09-22 QA指摘E・T2】registryのO(n)正規化: thickness:null同士は同値とみなし重複例外にする', () => {
  const builtinEntry = material({ code: '301000000001', thickness: null });
  const docEntry = material({ code: '301000000002', thickness: null });
  setOverlay('material', { doc: [docEntry] });
  assert.throws(() => composeCatalog('material', [builtinEntry]), /既に登録されています/);
});

test('【失敗系・2026-09-22 QA指摘E・T2】registryのO(n)正規化: thickness省略(undefined)とnull明示も同値とみなし重複例外にする', () => {
  const builtinEntry = material({ code: '301000000003', thickness: undefined }); // 省略と同義
  const docEntry = material({ code: '301000000004', thickness: null });
  setOverlay('material', { doc: [docEntry] });
  assert.throws(() => composeCatalog('material', [builtinEntry]), /既に登録されています/);
});

test('【失敗系・2026-09-22 QA指摘E・T2】assertNoDuplicate単体でも thickness省略とnull明示は同値（トップレベル同値規則側の確認）', () => {
  const entries = [material({ code: '301000000005', thickness: undefined })];
  const incoming = material({ code: '999999999999', thickness: null });
  assert.throws(() => assertNoDuplicate('material', incoming, entries), /既に登録されています/);
});

// T3: null と 0 は別材として通る（区別は維持）
test('【2026-09-22 QA指摘E・T3】registryのO(n)正規化: null と 0 は別材として通る（区別は維持）', () => {
  const builtinEntry = material({ code: '301000000001', thickness: 0 });
  const docEntry = material({ code: '301000000002', thickness: null });
  setOverlay('material', { doc: [docEntry] });
  assert.doesNotThrow(() => composeCatalog('material', [builtinEntry]));
});

// ---- clearOverlaysで空に戻ったことをcomposeCatalogでも確認（発火回数を明示） ----
test('clearOverlays後はcomposeCatalogがbuiltinのみを返す（前のテストのsetOverlayが漏れていない）', () => {
  const builtinEntry = material();
  const map = composeCatalog('material', [builtinEntry]);
  assert.equal(map.size, 1);
  assert.equal(map.get(builtinEntry.code), builtinEntry);
});
