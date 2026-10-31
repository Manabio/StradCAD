// catalogRegistry.js の純関数側（overlay を一切立てない経路）。
// overlay を立てる系（setOverlay/clearOverlays）は catalogRegistry.overlay.test.js
// （node:test はファイル単位で別プロセスのため、overlay汚染を避けて専用ファイルに分ける）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeCatalog, composeList, originOf, assertNoDuplicatesInMergedWith } from './catalogRegistry.js';
import { ERR_CATALOG_DUPLICATE } from '../error.js';
import { valuesEqual } from './catalogMatch.js';

function material(overrides) {
  return {
    code: '301000000001', name: 'せっこうボード t=9.5', spec: 'JIS A 6901', x: 0, y: 0, thickness: 9.5, note: '', category: 'panel',
    ...overrides,
  };
}

// ---- overlay空 ----
test('composeCatalog: overlay空のとき new Map(builtin.map(e => [keyOf(e), e])) と同じもの（コピー・凍結・ラップしない）', () => {
  const builtin = [material(), material({ code: '301000000002', name: '別材' })];
  const map = composeCatalog('material', builtin);
  const expected = new Map(builtin.map(e => [e.code, e]));
  assert.equal(map.size, expected.size);
  for (const [key, entry] of expected) {
    assert.equal(map.get(key), entry); // === 同一性（コピーしない）
  }
});

test('composeCatalog: overlay空のときエントリの参照はbuiltin配列の要素そのもの', () => {
  const builtin = [material()];
  const map = composeCatalog('material', builtin);
  assert.equal(map.get(builtin[0].code), builtin[0]);
});

test('composeList: overlay空ならbuiltinと同じ要素・同じ順序', () => {
  const builtin = [material({ code: '301000000001' }), material({ code: '301000000002', name: 'B' }), material({ code: '301000000003', name: 'C' })];
  const list = composeList('material', builtin);
  assert.deepEqual(list, builtin);
  for (let i = 0; i < builtin.length; i++) assert.equal(list[i], builtin[i]); // === 同一性・同順序
});

test('originOf: overlay空なら全件builtin', () => {
  const builtin = [material()];
  assert.equal(originOf('material', builtin[0].code, builtin), 'builtin');
});

test('originOf: 未知のキーはnull', () => {
  const builtin = [material()];
  assert.equal(originOf('material', 'no-such-key', builtin), null);
});

// ---- 重複禁止の合成後の強制（裁定A）: overlay空でもbuiltin自身が重複していれば検出する ----
test('【失敗系】composeCatalog: builtin同士がdedupeFields完全一致（category違いも含む）なら例外', () => {
  const a = material({ code: '301000000001', category: 'panel' });
  const b = material({ code: '301000000002', category: 'backing' }); // 5項目一致・categoryだけ違う
  assert.throws(() => composeCatalog('material', [a, b]), /既に登録されています/);
});

test('【失敗系】composeList: builtin同士がdedupeFields完全一致なら例外', () => {
  const a = material({ code: '301000000001', category: 'panel' });
  const b = material({ code: '301000000002', category: 'backing' });
  assert.throws(() => composeList('material', [a, b]), /既に登録されています/);
});

test('composeCatalog/composeList: dedupeFieldsを持たない種別（section）はbuiltin内で全項目一致でも例外にならない', () => {
  const a = { key: 'a', materialType: 'WOOD', shape: 'rect', width: 90, height: 90, label: '90×90' };
  const b = { key: 'b', materialType: 'WOOD', shape: 'rect', width: 90, height: 90, label: '90×90' };
  assert.doesNotThrow(() => composeCatalog('section', [a, b]));
  assert.doesNotThrow(() => composeList('section', [a, b]));
});

// ---- 2026-09-22 QA指摘B/C: 重複禁止例外の.codeと文言（出所つき） ----
test('【失敗系・2026-09-22 QA指摘B】composeCatalog: 重複禁止例外は.code=ERR_CATALOG_DUPLICATEを持つ', () => {
  const a = material({ code: '301000000001', category: 'panel' });
  const b = material({ code: '301000000002', category: 'backing' });
  try {
    composeCatalog('material', [a, b]);
    assert.fail('例外が投げられなかった');
  } catch (e) {
    assert.equal(e.code, ERR_CATALOG_DUPLICATE);
  }
});

test('【2026-09-22 QA指摘C】composeCatalog: 重複禁止例外メッセージは両方のキー＋名称＋出所(builtin)を含む', () => {
  const a = material({ code: '102000000003', name: 'せっこうボード t=12.5', category: 'panel' });
  const b = material({ code: '302000000001', name: 'せっこうボード t=12.5', category: 'backing' });
  assert.throws(
    () => composeCatalog('material', [a, b]),
    /102000000003（せっこうボード t=12\.5・builtin）.*⇔.*302000000001（せっこうボード t=12\.5・builtin）/,
  );
});

// ---- 2026-09-22 QA指摘・Minor: originOfも重複禁止検査を掛けて挙動を揃える ----
test('【失敗系・2026-09-22 QA指摘・Minor】originOf: builtin同士がdedupeFields完全一致なら例外（composeCatalog/composeListと挙動を揃える）', () => {
  const a = material({ code: '301000000001', category: 'panel' });
  const b = material({ code: '301000000002', category: 'backing' });
  assert.throws(() => originOf('material', a.code, [a, b]), /既に登録されています/);
});

// ---- 2026-09-22 QA指摘D・T6: JSON.stringifyでの比較は禁止。部分詳細図S2で規約変更: 配列・
// プレーンオブジェクトは構造的に正規化する。非プレーンのオブジェクト・トップレベルのbooleanは日本語例外。ダミー行（rankCandidatesWithと同じ
// 方式）で凍結された本番登録表を書き換えずに確認する ----
// 部分詳細図S2（案A）: 配列・オブジェクトは入れ子の厳密比較（deepValuesEqualStrict と同値）で重複判定する。
test('assertNoDuplicatesInMergedWith: dedupeFieldsの配列値は入れ子の厳密比較で重複判定する（同じ中身は重複・違えば通る）', () => {
  const def = { keyOf: e => e.id, dedupeFields: ['layers'] };
  const same = [{ id: 'a', layers: [{ x: 1 }] }, { id: 'b', layers: [{ x: 1 }] }];
  assert.throws(() => assertNoDuplicatesInMergedWith('dummyKind', def, same), /重複禁止/);
  const diff = [{ id: 'a', layers: [{ x: 1 }] }, { id: 'b', layers: [{ x: 2 }] }];
  assert.doesNotThrow(() => assertNoDuplicatesInMergedWith('dummyKind', def, diff));
});

test('assertNoDuplicatesInMergedWith: dedupeFieldsのオブジェクト値はキー順に依らず、キーの有無と null/undefined を区別する', () => {
  const def = { keyOf: e => e.id, dedupeFields: ['slideLayout'] };
  assert.throws(() => assertNoDuplicatesInMergedWith('dummyKind', def, [
    { id: 'a', slideLayout: { tracks: 2, fix: true } }, { id: 'b', slideLayout: { fix: true, tracks: 2 } },
  ]), /重複禁止/);
  assert.doesNotThrow(() => assertNoDuplicatesInMergedWith('dummyKind', def, [
    { id: 'a', slideLayout: { tracks: 2 } }, { id: 'b', slideLayout: { tracks: 2, fix: null } },
  ]));
  assert.doesNotThrow(() => assertNoDuplicatesInMergedWith('dummyKind', def, [
    { id: 'a', slideLayout: { tracks: 2 } }, { id: 'b', slideLayout: { tracks: '2' } },
  ]));
});

test('assertNoDuplicatesInMergedWith: 入れ子の文字列は前後空白を除いて比べる（catalogMatch の valuesEqual と同値）', () => {
  const def = { keyOf: e => e.id, dedupeFields: ['layers'] };
  assert.throws(() => assertNoDuplicatesInMergedWith('dummyKind', def, [
    { id: 'a', layers: [' x'] }, { id: 'b', layers: ['x'] },
  ]), /重複禁止/);
  const def2 = { keyOf: e => e.id, dedupeFields: ['slideLayout'] };
  assert.throws(() => assertNoDuplicatesInMergedWith('dummyKind', def2, [
    { id: 'a', slideLayout: { k: 'x ' } }, { id: 'b', slideLayout: { k: 'x' } },
  ]), /重複禁止/);
  assert.equal(valuesEqual([' x'], ['x']), true);
  assert.equal(valuesEqual({ k: 'x ' }, { k: 'x' }), true);
});

test('assertNoDuplicatesInMergedWith: 長さ接頭辞の衝突と型の区別（別物は例外にならず、-0 と 0 だけ重複）', () => {
  const def = { keyOf: e => e.id, dedupeFields: ['v'] };
  const pairs = [
    [['a,b'], ['a', 'b']],
    [[['a'], 'b'], [['a', 'b']]],
    [[{ 'a=1': 1 }], [{ a: '1=1' }]],
    [[[]], [{}]],
    [[null], [undefined]],
    [[1], ['1']],
  ];
  for (const [x, y] of pairs) {
    assert.doesNotThrow(() => assertNoDuplicatesInMergedWith('dummyKind', def, [{ id: 'a', v: x }, { id: 'b', v: y }]), JSON.stringify([x, y]));
  }
  assert.throws(() => assertNoDuplicatesInMergedWith('dummyKind', def, [{ id: 'a', v: [-0] }, { id: 'b', v: [0] }]), /重複禁止/);
  assert.throws(() => assertNoDuplicatesInMergedWith('dummyKind', def, [{ id: 'a', v: [Object.create(null)] }]), /入れ子に未対応/);
});

test('【失敗系】assertNoDuplicatesInMergedWith: 入れ子の NaN/Infinity は例外（比較不能）', () => {
  const def = { keyOf: e => e.id, dedupeFields: ['layers'] };
  assert.throws(() => assertNoDuplicatesInMergedWith('dummyKind', def, [{ id: 'a', layers: [NaN] }]), /NaN\/Infinity/);
});

test('【失敗系・2026-09-22 QA指摘・Minor】assertNoDuplicatesInMergedWith: dedupeFieldsにboolean値が来ても例外（文言が実際の型(boolean)を言う。配列・オブジェクトに限らず一般化）', () => {
  const def = { keyOf: e => e.id, dedupeFields: ['flag'] };
  const a = { id: 'a', flag: true };
  const b = { id: 'b', flag: true };
  assert.throws(() => assertNoDuplicatesInMergedWith('dummyKind', def, [a, b]), /実際の型: boolean/);
});

test('【失敗系・2026-09-22 QA指摘・Minor】assertNoDuplicatesInMergedWith: dedupeFieldsの数値がNaN/Infinityなら例外（比較不能）', () => {
  const def = { keyOf: e => e.id, dedupeFields: ['value'] };
  const a = { id: 'a', value: NaN };
  const b = { id: 'b', value: NaN };
  assert.throws(() => assertNoDuplicatesInMergedWith('dummyKind', def, [a, b]), /NaN\/Infinity/);
});

test('assertNoDuplicatesInMergedWith: dedupeFieldsを持たないダミー行は常に許容（no-op）', () => {
  const def = { keyOf: e => e.id, dedupeFields: null };
  assert.doesNotThrow(() => assertNoDuplicatesInMergedWith('dummyKind', def, [{ id: 'a' }, { id: 'b' }]));
});
