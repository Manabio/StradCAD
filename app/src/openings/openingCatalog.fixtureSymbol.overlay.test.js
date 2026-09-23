// openings/openingCatalog.js のステップ12d: 建具記号（fixtureSymbol）のoverlay（doc/user）合成・
// 世代キーによるメモ化無効化の確認。setOverlay/clearOverlaysでcatalogRegistry.jsのモジュールスコープ
// 状態を変えるため、汚染を避けてopeningCatalog.test.jsとは別ファイルにする
// （structural/sectionCatalog.overlay.test.js / catalog/catalogRegistry.overlay.test.js と同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays, removeDocEntry } from '../catalog/catalogRegistry.js';
import {
  fixtureSymbolBuiltinList, findFixtureSymbol, getFixtureSymbols, frameProfileFor, defaultMaterialGlassFor,
  defaultFixtureSymbolFor, OpeningMechanism,
} from './openingCatalog.js';
import { fixtureSymbolOptions, fixtureTypeAfterSubTypeChange } from './openingEdit.js';

test.afterEach(() => clearOverlays());

function userEntry(overrides) {
  return { key: 'PW', label: 'PW（樹脂サッシ・独自）', category: 'window', defaultMaterialGlass: '樹脂（独自）', ...overrides };
}

// テスト名は2026-09-24 QA指摘（ステップ12d再報告）で実態に合わせて訂正: WWはDEFAULT_MATERIALS
// にある（'木製'）。10件全てdefaultMaterialGlassがDEFAULT_MATERIALSと一致することをAW・SFの
// 2件で確認する。
test('fixtureSymbolBuiltinList: FIXTURE_SYMBOLSの10件をDEFAULT_MATERIALS通りのdefaultMaterialGlass付きで返す', () => {
  const list = fixtureSymbolBuiltinList();
  assert.equal(list.length, 10);
  const aw = list.find(f => f.key === 'AW');
  assert.equal(aw.defaultMaterialGlass, 'アルミ');
  const sf = list.find(f => f.key === 'SF');
  assert.equal(sf.defaultMaterialGlass, 'スチール');
});

test('user overlayで建具記号を立てると、findFixtureSymbol/getFixtureSymbolsに即反映される（メモ化の無効化）', () => {
  assert.equal(findFixtureSymbol('PW'), null, '立てる前はbuiltinに無いのでnull');
  setOverlay(CatalogKind.FIXTURE_SYMBOL, { user: [userEntry()] });
  const entry = findFixtureSymbol('PW');
  assert.ok(entry, 'user overlayの建具記号がfindFixtureSymbolに反映されていない');
  assert.equal(entry.category, 'window');

  const windowSymbols = getFixtureSymbols('window').map(f => f.key);
  assert.ok(windowSymbols.includes('PW'), 'getFixtureSymbols(window)にuser追加分が出ていない');
});

test('doc overlayはuserより優先し、builtinを上書きする（同キーAWのlabelをdocで上書き）', () => {
  setOverlay(CatalogKind.FIXTURE_SYMBOL, { doc: [{ key: 'AW', label: 'AW（同梱で上書き）', category: 'window' }] });
  const entry = findFixtureSymbol('AW');
  assert.equal(entry.label, 'AW（同梱で上書き）');
});

test('clearOverlays後はoverlayが外れ、findFixtureSymbolはnullに戻る（世代キー無効化）', () => {
  setOverlay(CatalogKind.FIXTURE_SYMBOL, { user: [userEntry()] });
  assert.ok(findFixtureSymbol('PW'), '立てた直後は見えているはず');
  clearOverlays();
  assert.equal(findFixtureSymbol('PW'), null, 'clearOverlays後もキャッシュが残っている（世代キー無効化の不具合）');
});

test('removeDocEntry後もfindFixtureSymbolに反映される（メモ化の無効化）', () => {
  setOverlay(CatalogKind.FIXTURE_SYMBOL, { doc: [userEntry()] });
  assert.ok(findFixtureSymbol('PW'));
  removeDocEntry(CatalogKind.FIXTURE_SYMBOL, 'PW');
  assert.equal(findFixtureSymbol('PW'), null, 'removeDocEntry後もキャッシュが残っている');
});

test('frameProfileFor: overlayで追加した三方枠専用記号のprofileも拾える（overlay込み）', () => {
  setOverlay(CatalogKind.FIXTURE_SYMBOL, {
    user: [{ key: 'TF', label: 'TF（試験用三方枠）', category: 'fitting', mechanism: 'frameOnly', profile: 'bent' }],
  });
  assert.equal(frameProfileFor('TF'), 'bent');
});

test('defaultMaterialGlassFor: overlayで追加した記号のdefaultMaterialGlassも拾える（overlay込み）', () => {
  setOverlay(CatalogKind.FIXTURE_SYMBOL, { user: [userEntry()] });
  assert.equal(defaultMaterialGlassFor('PW'), '樹脂（独自）');
});

test('【失敗系】defaultMaterialGlassFor: overlayに登録されていてもdefaultMaterialGlassが文字列でなければnull', () => {
  setOverlay(CatalogKind.FIXTURE_SYMBOL, { user: [userEntry({ defaultMaterialGlass: null })] });
  assert.equal(defaultMaterialGlassFor('PW'), null);
});

test('getFixtureSymbols: FRAME_ONLY指定時はoverlay追加の三方枠専用記号も末尾に含む（builtinの並びは保たれる）', () => {
  setOverlay(CatalogKind.FIXTURE_SYMBOL, {
    user: [{ key: 'TF', label: 'TF（試験用三方枠）', category: 'fitting', mechanism: 'frameOnly', profile: 'bent' }],
  });
  const keys = getFixtureSymbols('fitting', 'frameOnly').map(f => f.key);
  assert.deepEqual(keys, ['WF', 'SF', 'SSF', 'TF']);
});

// ---- ステップ12e QA指摘: userのwindow記号はcategory/mechanismが一致するスコープにしか出ない ----
test('user記号: windowカテゴリのPWはgetFixtureSymbols("fitting")にもgetFixtureSymbols("window","frameOnly")にも出ない', () => {
  setOverlay(CatalogKind.FIXTURE_SYMBOL, { user: [userEntry()] });
  assert.ok(!getFixtureSymbols('fitting').some(f => f.key === 'PW'), 'category不一致のfittingスコープに出ている');
  assert.ok(!getFixtureSymbols('window', 'frameOnly').some(f => f.key === 'PW'), 'mechanism不一致のframeOnlyスコープに出ている');
  assert.ok(getFixtureSymbols('window').some(f => f.key === 'PW'), '本来のwindowスコープには出るはず');
});

// ---- ステップ12e: fixtureSymbolOptions（openingEdit.js）はoverlayのuser記号を「既知」として扱う ----
test('fixtureSymbolOptions: overlayで立てたuser記号は既知扱いで、選択肢に先頭追加なしで含まれる', () => {
  setOverlay(CatalogKind.FIXTURE_SYMBOL, { user: [userEntry()] });
  const opts = fixtureSymbolOptions('window', undefined, 'PW');
  assert.deepEqual(opts, getFixtureSymbols('window', undefined), 'user記号は絞り込みに含まれるはずなので先頭追加は無いはず');
});

test('fixtureSymbolOptions: clearOverlays後はuser記号が外れ、同じ記号が未知（先頭に「（不明）」追加）扱いに戻る', () => {
  setOverlay(CatalogKind.FIXTURE_SYMBOL, { user: [userEntry()] });
  assert.deepEqual(fixtureSymbolOptions('window', undefined, 'PW'), getFixtureSymbols('window', undefined), '立てた直後は既知のはず');
  clearOverlays();
  const opts = fixtureSymbolOptions('window', undefined, 'PW');
  assert.deepEqual(opts[0], { key: 'PW', label: '（不明）PW', unknown: true }, 'clearOverlays後はuser記号が外れ未知扱いに戻るはず');
});

// ---- 12e QA指摘Minor-1: 未知判定はライブラリ（overlay）込みの findFixtureSymbol で行う。
// 「builtin にある記号だけを既知とみなす」変異では、user 記号 PW がスコープ外の機構へ種別変更しても
// 保持されてしまう（既定記号へ差し替わらない）ため、ここで固定する。 ----
test('fixtureTypeAfterSubTypeChange: overlayのuser記号（PW）は既知扱いで、スコープ外の機構へ種別変更すると既定記号へ差し替わる', () => {
  setOverlay(CatalogKind.FIXTURE_SYMBOL, { user: [userEntry()] });
  const expected = defaultFixtureSymbolFor('window', 'exterior', OpeningMechanism.FRAME_ONLY);
  const result = fixtureTypeAfterSubTypeChange('PW', 'window', 'exterior', OpeningMechanism.FRAME_ONLY);
  assert.notEqual(result, 'PW', 'user記号は既知なのでスコープ判定に回り、三方枠のスコープ外なら保持されないはず');
  assert.equal(result, expected);
  clearOverlays();
  assert.equal(
    fixtureTypeAfterSubTypeChange('PW', 'window', 'exterior', OpeningMechanism.FRAME_ONLY), 'PW',
    'overlayを外すと未知記号になり、種別変更でも保持される（10g QA Minor-3）',
  );
});
