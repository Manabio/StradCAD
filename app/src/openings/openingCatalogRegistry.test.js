// openingCatalog.js のステップ10c: overlay（doc/user）合成・世代キーによるメモ化の確認。
// setOverlay/clearOverlaysでcatalogRegistry.jsのモジュールスコープ状態を変えるため、汚染を避けて
// openingCatalog.test.jsとは別ファイルにする（structural/sectionCatalog.overlay.test.js と同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogKind, kindDef } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import {
  findCatalogEntry, openingSubTypeList, openingSubTypeBuiltinList, getFittingOptions,
  FITTING_CATALOG, WINDOW_CATALOG, OpeningMechanism,
} from './openingCatalog.js';

test.afterEach(() => clearOverlays());

function userFittingEntry(overrides) {
  return {
    category: 'fitting', key: 'myDoor', label: 'ユーザー追加ドア',
    mechanism: OpeningMechanism.SWING, defaultWidth: 800, defaultHeight: 2000,
    // wallKindsは省略（overlayは両方の壁種別に出す規約）。
    ...overrides,
  };
}

// ---- overlay無し: builtinの内容がcategory付きで引ける・メモ化される ----
test('overlay無し: findCatalogEntryはbuiltinと同内容（category付き）を返し、2回呼んでも同一参照', () => {
  const builtin = FITTING_CATALOG.find(o => o.key === 'singleSwing');
  const entry = findCatalogEntry('fitting', 'singleSwing');
  assert.ok(entry);
  assert.equal(entry.category, 'fitting');
  assert.equal(entry.label, builtin.label);
  assert.equal(entry.mechanism, builtin.mechanism);
  assert.equal(entry.defaultWidth, builtin.defaultWidth);
  assert.equal(entry.defaultHeight, builtin.defaultHeight);

  const again = findCatalogEntry('fitting', 'singleSwing');
  assert.equal(again, entry, 'overlay世代が変わらない間はキャッシュされたMapから同一参照が返るはず');
});

// ---- user overlay ----
test('user overlay: findCatalogEntryで引ける・getFittingOptionsの両wallKindに出る・openingSubTypeListの末尾に付く', () => {
  setOverlay(CatalogKind.OPENING_SUB_TYPE, { user: [userFittingEntry()] });

  const entry = findCatalogEntry('fitting', 'myDoor');
  assert.ok(entry, 'user overlayのエントリがfindCatalogEntryに反映されていない');
  assert.equal(entry.label, 'ユーザー追加ドア');

  const interior = getFittingOptions('interior');
  const exterior = getFittingOptions('exterior');
  assert.ok(interior.some(o => o.key === 'myDoor'), 'wallKinds省略のuserエントリはinteriorにも出るはず');
  assert.ok(exterior.some(o => o.key === 'myDoor'), 'wallKinds省略のuserエントリはexteriorにも出るはず');

  const list = openingSubTypeList('fitting');
  assert.equal(list[0].key, 'singleSwing', 'builtin先頭(catalog[0]フォールバック対象)は変わらないはず');
  assert.equal(list.at(-1).key, 'myDoor', 'user追加分はbuiltinの末尾に付くはず');
});

// ---- doc overlay: doc>user>builtin ----
test('doc overlay: 同キーのbuiltinをdocが上書きする（doc>user>builtin）', () => {
  setOverlay(CatalogKind.OPENING_SUB_TYPE, {
    doc: [{ category: 'fitting', key: 'singleSwing', label: '片開き戸(doc上書き)', mechanism: OpeningMechanism.SWING, wallKinds: ['interior'], defaultWidth: 800, defaultHeight: 2000 }],
  });
  const entry = findCatalogEntry('fitting', 'singleSwing');
  assert.equal(entry.label, '片開き戸(doc上書き)');
});

// ---- メモ化の無効化: setOverlay/clearOverlaysの世代キーでキャッシュが切り替わる ----
test('メモ化の無効化: setOverlay後は新しい結果になり、clearOverlays後はbuiltinへ戻る', () => {
  assert.equal(findCatalogEntry('fitting', 'myDoor'), null, '立てる前はbuiltinに無いのでnull');
  setOverlay(CatalogKind.OPENING_SUB_TYPE, { user: [userFittingEntry()] });
  assert.ok(findCatalogEntry('fitting', 'myDoor'), 'setOverlay後は即座に反映されるはず（世代キー無効化の不具合）');
  clearOverlays();
  assert.equal(findCatalogEntry('fitting', 'myDoor'), null, 'clearOverlays後もキャッシュが残っている（世代キー無効化の不具合）');
});

// ---- openingSubTypeBuiltinList: 件数・loadBuiltinとの整合 ----
test('openingSubTypeBuiltinList: 件数がFITTING_CATALOG+WINDOW_CATALOG、kindDef.loadBuiltin()の結果とdeepEqual', async () => {
  const list = openingSubTypeBuiltinList();
  assert.equal(list.length, FITTING_CATALOG.length + WINDOW_CATALOG.length);

  const viaLoadBuiltin = await kindDef(CatalogKind.OPENING_SUB_TYPE).loadBuiltin();
  assert.deepEqual(viaLoadBuiltin, list);
});

// ---- 失敗系 ----
test('【失敗系】findCatalogEntry: 未知キー・未指定categoryはnull（例外を出さない）', () => {
  assert.equal(findCatalogEntry('fitting', 'unknownFittingType'), null);
  assert.equal(findCatalogEntry('window', 'unknownWindowType'), null);
  assert.equal(findCatalogEntry(undefined, undefined), null);
  assert.equal(findCatalogEntry(null, null), null);
});

// ---- 10c QA 追加分 ----
// openingSubTypeList の category filter はカテゴリ越境を防ぐ唯一の関門（壊しても他のテストは赤くならない）。
test('user overlay: windowカテゴリのエントリはfitting側（一覧・getFittingOptions・findCatalogEntry）へ漏れない', () => {
  setOverlay(CatalogKind.OPENING_SUB_TYPE, {
    user: [{ category: 'window', key: 'myWindow', label: 'ユーザー窓', mechanism: OpeningMechanism.FIXED, defaultWidth: 600, defaultHeight: 600 }],
  });
  const has = list => list.some(e => e.key === 'myWindow');
  assert.equal(has(openingSubTypeList('window')), true);
  assert.equal(has(openingSubTypeList('fitting')), false);
  assert.equal(has(getFittingOptions('interior')), false);
  assert.equal(has(getFittingOptions('exterior')), false);
  assert.equal(findCatalogEntry('fitting', 'myWindow'), null);
  assert.equal(findCatalogEntry('window', 'myWindow').label, 'ユーザー窓');
});

// openingEdit.js placeOpeningWithDefaults の `catalog[0]` フォールバックと「threeSidedFrame は末尾」規約は
// composeList の位置保存に依存する。
test('doc overlay: 同キーの上書きはbuiltinの位置に留まり件数も増えない（catalog[0]フォールバックが動かない）', () => {
  setOverlay(CatalogKind.OPENING_SUB_TYPE, {
    doc: [{ category: 'fitting', key: 'singleSwing', label: '片開き戸(doc上書き)', mechanism: OpeningMechanism.SWING, wallKinds: ['interior'], defaultWidth: 800, defaultHeight: 2000 }],
  });
  const list = openingSubTypeList('fitting');
  assert.equal(list[0].key, FITTING_CATALOG[0].key);
  assert.equal(list[0].label, '片開き戸(doc上書き)');
  assert.equal(list.length, FITTING_CATALOG.length);
  assert.equal(list[list.length - 1].key, FITTING_CATALOG[FITTING_CATALOG.length - 1].key);
});

test('【失敗系】wallKinds: [] のuserエントリはgetFittingOptionsのどちらにも出ない（一覧には出る）', () => {
  setOverlay(CatalogKind.OPENING_SUB_TYPE, { user: [userFittingEntry({ key: 'noWall', wallKinds: [] })] });
  const has = list => list.some(e => e.key === 'noWall');
  assert.equal(has(getFittingOptions('interior')), false);
  assert.equal(has(getFittingOptions('exterior')), false);
  assert.equal(has(openingSubTypeList('fitting')), true);
});

test('【失敗系】openingSubTypeList: 未知のcategory・未指定は空配列（例外を出さない）', () => {
  assert.deepEqual(openingSubTypeList('foo'), []);
  assert.deepEqual(openingSubTypeList(undefined), []);
});
