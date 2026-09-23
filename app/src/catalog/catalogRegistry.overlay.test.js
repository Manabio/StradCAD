// catalogRegistry.js の overlay を立てる系（setOverlay/clearOverlays）。node:test はファイル単位で
// 別プロセスのため、composeCatalog等の「overlay空」不変条件を確認する catalogRegistry.test.js
// とは別ファイルにして overlay 汚染を避ける。setOverlay → composeCatalog/composeList/originOf →
// clearOverlays → 空に戻ることを、発火回数を assert する形で確認する（空振り防止）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setOverlay, clearOverlays, overlayFor, composeCatalog, composeList, originOf,
  docDiffMap, docDiffFields, removeDocEntry, overlayGeneration,
} from './catalogRegistry.js';
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

// ---- R13: docDiffMap/docDiffFields（ステップ6-2）----
// 判定はcatalogMatch.jsのdiffEntries一本（このファイルでは「doc起源のキーだけが対象」
// 「本体（user優先・無ければbuiltin）との比較」という配線側の規約を確認する）。

test('docDiffMap: docがbuiltinと完全一致なら差分Mapに含まれない', () => {
  const builtinEntry = material({ code: '301000000001' });
  const docEntry = material({ code: '301000000001' }); // 全項目同じ
  setOverlay('material', { doc: [docEntry] });
  const diffs = docDiffMap('material', [builtinEntry]);
  assert.equal(diffs.size, 0);
  assert.equal(docDiffFields('material', '301000000001', [builtinEntry]), null);
});

test('docDiffMap: spec/thicknessだけの差（通知なしのsilentDiffFields）でも差分Mapに含まれる（オレンジ表示は通知と独立）', () => {
  const builtinEntry = material({ code: '301000000002', name: 'せっこうボード t=12.5', thickness: 12.5 });
  const docEntry = material({ code: '301000000002', name: 'せっこうボード t=12.5', thickness: 15 }); // thicknessのみ差
  setOverlay('material', { doc: [docEntry] });
  const diffs = docDiffMap('material', [builtinEntry]);
  assert.equal(diffs.size, 1);
  const entry = diffs.get('301000000002');
  assert.deepEqual(entry.diffFields, ['thickness']);
  assert.equal(entry.baseOrigin, 'builtin');
  assert.equal(entry.baseEntry, builtinEntry); // === 同一性
  assert.deepEqual(docDiffFields('material', '301000000002', [builtinEntry]), ['thickness']);
});

test('docDiffMap: docに同キーのuser/builtinが無ければ（新規追加材）差分Mapに含まれない（比較相手が無い）', () => {
  const builtinEntry = material({ code: '301000000001' });
  const newDocEntry = material({ code: '999999999999', name: '新規同梱材' }); // builtin/userどちらにも無いキー
  setOverlay('material', { doc: [newDocEntry] });
  const diffs = docDiffMap('material', [builtinEntry]);
  assert.equal(diffs.size, 0);
  assert.equal(docDiffFields('material', '999999999999', [builtinEntry]), null);
});

test('docDiffMap: docが無くuserだけがbuiltinと不一致でも差分Mapに含まれない（user起源はオレンジにしない。衝突は別UI）', () => {
  const builtinEntry = material({ code: '301000000001', note: 'builtin' });
  const conflictingUser = material({ code: '301000000001', note: 'user' });
  setOverlay('material', { user: [conflictingUser] });
  const diffs = docDiffMap('material', [builtinEntry]);
  assert.equal(diffs.size, 0);
});

// 2026-09-22 QA指摘Minor-1: 上のテストはdoc空で早期returnするため、走査元をdoc→[...doc,...user]に
// 変える変異（W1）でも緑のままになってしまう（空振り）。docを非空にしたまま、別キーのuserだけが
// builtinと不一致、という構成で「user起源のキー自体がMapに現れない」ことを固定する。
test('docDiffMap: docが非空でも、docとは別キーのuser不一致エントリはMapに現れない（W1の空振り対策）', () => {
  const builtinA = material({ code: '301000000001', note: 'builtin-A' }); // docで上書き
  const builtinB = material({ code: '301000000002', note: 'builtin-B' }); // userだけが不一致（別キー）
  const docA = material({ code: '301000000001', note: 'doc-A' }); // builtinAと不一致→Mapに入るはず
  const conflictingUserB = material({ code: '301000000002', note: 'user-B' }); // builtinBと不一致・docなし
  setOverlay('material', { doc: [docA], user: [conflictingUserB] });
  const diffs = docDiffMap('material', [builtinA, builtinB]);
  assert.deepEqual([...diffs.keys()], ['301000000001'], 'docのキーだけが現れ、userだけのキーは現れない');
  assert.equal(diffs.has('301000000002'), false);
});

test('docDiffMap: 判定はdiffEntries一本（catalogMatch.jsのvaluesEqualと同じtrim規則）——前後空白だけ違う名称は同値で差分Mapに含まれない', () => {
  const builtinEntry = material({ code: '301000000001', name: 'せっこうボード t=9.5' });
  const docEntry = material({ code: '301000000001', name: '  せっこうボード t=9.5  ' }); // 前後空白のみ
  setOverlay('material', { doc: [docEntry] });
  const diffs = docDiffMap('material', [builtinEntry]);
  assert.equal(diffs.size, 0);
});

test('docDiffMap: baseOriginはuserがあればuser、無ければbuiltin（両方存在する場合はuserを本体とする）', () => {
  const builtinA = material({ code: '301000000001', note: 'builtin-A' });
  const userA    = material({ code: '301000000001', note: 'user-A' }); // docと同キーのuser上書きあり
  const builtinB = material({ code: '301000000002', note: 'builtin-B' });
  const docA = material({ code: '301000000001', note: 'doc-A' });
  const docB = material({ code: '301000000002', note: 'doc-B' }); // userに同キー無し→builtinが本体
  setOverlay('material', { doc: [docA, docB], user: [userA] });
  const diffs = docDiffMap('material', [builtinA, builtinB]);

  const entryA = diffs.get('301000000001');
  assert.equal(entryA.baseOrigin, 'user');
  assert.equal(entryA.baseEntry, userA);

  const entryB = diffs.get('301000000002');
  assert.equal(entryB.baseOrigin, 'builtin');
  assert.equal(entryB.baseEntry, builtinB);
});

// ---- removeDocEntry（ステップ6b: 4.7 文書同梱から1件外す。次の保存でbuiltin/user内容が同梱し直される）----

test('removeDocEntry: 指定キーがdocから外れる（userは不変。変異=userも消すと赤）', () => {
  const docA = material({ code: '301000000001', note: 'doc-A' });
  const docB = material({ code: '301000000002', note: 'doc-B' });
  const userEntry = material({ code: '301000000003', note: 'user' });
  setOverlay('material', { doc: [docA, docB], user: [userEntry] });
  removeDocEntry('material', '301000000001');
  const overlay = overlayFor('material');
  assert.deepEqual(overlay.doc.map(e => e.code), ['301000000002']);
  assert.equal(overlay.doc[0], docB); // 残った方は===同一性を保つ（コピーしない）
  assert.equal(overlay.user.length, 1);
  assert.equal(overlay.user[0], userEntry); // userは触らない（===同一性）
});

test('removeDocEntry: docと同キーのuser上書きが存在しても消えない（変異=同キーでuserも一緒に消すと赤。この構成が無いと上のテストは空振り）', () => {
  const docEntry = material({ code: '301000000001', note: 'doc' });
  const userOverride = material({ code: '301000000001', note: 'user' }); // docと同キー
  setOverlay('material', { doc: [docEntry], user: [userOverride] });
  removeDocEntry('material', '301000000001');
  const overlay = overlayFor('material');
  assert.deepEqual(overlay.doc, []);
  assert.equal(overlay.user.length, 1, 'docと同キーのuserエントリも一緒に消えてはいけない');
  assert.equal(overlay.user[0], userOverride);
});

test('removeDocEntry: doc/userとも空になれば overlayFor が既定値(空配列の組)に戻る（setOverlayの仕様を継承）', () => {
  setOverlay('material', { doc: [material({ code: '301000000001' })] });
  removeDocEntry('material', '301000000001');
  assert.deepEqual(overlayFor('material'), { doc: [], user: [] });
});

test('【失敗系】removeDocEntry: docに無いキーは例外（overlayは書き換わらない）', () => {
  const docEntry = material({ code: '301000000001' });
  setOverlay('material', { doc: [docEntry] });
  assert.throws(() => removeDocEntry('material', '999999999999'), /文書同梱に無いキーです/);
  assert.deepEqual(overlayFor('material').doc, [docEntry]); // 例外時は既存overlayが消えない
});

test('【失敗系】removeDocEntry: docが空（未設定）のkindで呼ぶと例外', () => {
  assert.throws(() => removeDocEntry('material', '301000000001'), /文書同梱に無いキーです/);
});

// ---- clearOverlaysで空に戻ったことをcomposeCatalogでも確認（発火回数を明示） ----
test('clearOverlays後はcomposeCatalogがbuiltinのみを返す（前のテストのsetOverlayが漏れていない）', () => {
  const builtinEntry = material();
  const map = composeCatalog('material', [builtinEntry]);
  assert.equal(map.size, 1);
  assert.equal(map.get(builtinEntry.code), builtinEntry);
});

// ================================================================
// ステップ8c: overlay 世代カウンタ（overlayGeneration）。消費者側（sectionCatalog.js等）が
// 合成結果をメモ化するための世代キー——内容比較はせず、set/clearのたびに保守的に++する。
// ================================================================
test('overlayGeneration: setOverlayで内容が変われば++される', () => {
  const before = overlayGeneration();
  setOverlay('material', { doc: [material({ code: '999999999999' })] });
  assert.equal(overlayGeneration(), before + 1);
});

test('overlayGeneration: 同内容でsetOverlayを再実行しても++される（内容比較はしない）', () => {
  const entry = material({ code: '999999999999' });
  setOverlay('material', { doc: [entry] });
  const before = overlayGeneration();
  setOverlay('material', { doc: [entry] }); // 前回と全く同じ内容
  assert.equal(overlayGeneration(), before + 1, '内容が同一でも保守的に++する');
});

test('overlayGeneration: doc/userとも空のsetOverlay（overlays.delete分岐）でも++される', () => {
  setOverlay('material', { doc: [material({ code: '999999999999' })] }); // 前提: overlayを立てておく
  const before = overlayGeneration();
  setOverlay('material', {}); // doc/user省略=空 → overlays.delete(kind)の分岐を通る
  assert.equal(overlayGeneration(), before + 1, 'delete分岐でも++しないと消費者側のキャッシュが腐る');
});

test('overlayGeneration: clearOverlaysで++される', () => {
  setOverlay('material', { doc: [material({ code: '999999999999' })] });
  const before = overlayGeneration();
  clearOverlays();
  assert.equal(overlayGeneration(), before + 1);
});

test('overlayGeneration: composeCatalogを呼んでも変わらない（読み取り専用）', () => {
  const builtinEntry = material();
  const before = overlayGeneration();
  composeCatalog('material', [builtinEntry]);
  composeCatalog('material', [builtinEntry]);
  assert.equal(overlayGeneration(), before, 'composeCatalogはoverlayを変更しないので世代は動かない');
});

// removeDocEntryはsetOverlayの薄いラッパ（overlays直接操作ではない）ので世代も動くはず。
// removeDocEntryの内部実装がoverlays.set/deleteを直接叩く変異（setOverlayを経由しない変異）に
// なると、overlayは変わるのに世代が++されない退行になる——それをここで検知する。
test('overlayGeneration: removeDocEntryで++される（setOverlay経由。overlays直接操作への退行を検知）', () => {
  const docEntry = material({ code: '999999999999' });
  setOverlay('material', { doc: [docEntry] });
  const before = overlayGeneration();
  removeDocEntry('material', '999999999999');
  assert.equal(overlayGeneration(), before + 1, 'removeDocEntryがsetOverlayを経由していれば++されるはず');
});

test('overlayGeneration: composeList/originOf/docDiffMap/overlayForを呼んでも変わらない（いずれも読み取り専用）', () => {
  const builtinEntry = material();
  // R17（dedupeFields完全一致禁止）に触れないよう、matchFields（name等）をbuiltinEntryと変える。
  setOverlay('material', { doc: [material({ code: '999999999999', name: '別材' })] });
  const before = overlayGeneration();
  composeList('material', [builtinEntry]);
  originOf('material', builtinEntry.code, [builtinEntry]);
  docDiffMap('material', [builtinEntry]);
  overlayFor('material');
  assert.equal(overlayGeneration(), before, '読み取り系のAPIはoverlayを変更しないので世代は動かない');
});

// setOverlayがvalidateで例外を投げた場合、既存overlayは変わらない（既存テストで確認済み）のに
// 加えて、世代も動いてはいけない——「++をvalidateの前に移す」変異（例外を投げても世代だけ
// 進んでしまう退行）を検知する。
test('【失敗系】overlayGeneration: validateで弾かれたsetOverlay（材codeが空文字）は世代もoverlayも変化なし', () => {
  setOverlay('material', { doc: [material({ code: '999999999999' })] }); // 前提: overlayを立てておく
  const before = overlayGeneration();
  const overlayBefore = overlayFor('material');
  assert.throws(() => setOverlay('material', { doc: [material({ code: '' })] })); // codeが12桁数字でなく例外
  assert.equal(overlayGeneration(), before, 'validate失敗時は世代を進めてはいけない（++をvalidateより前に置く退行を検知）');
  assert.equal(overlayFor('material'), overlayBefore, 'validate失敗時はoverlayも変わらない');
});
