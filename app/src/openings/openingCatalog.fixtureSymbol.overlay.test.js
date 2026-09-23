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
} from './openingCatalog.js';

test.afterEach(() => clearOverlays());

function userEntry(overrides) {
  return { key: 'PW', label: 'PW（樹脂サッシ・独自）', category: 'window', defaultMaterialGlass: '樹脂（独自）', ...overrides };
}

test('fixtureSymbolBuiltinList: FIXTURE_SYMBOLSの10件をdefaultMaterialGlass付きで返す（DEFAULT_MATERIALSに無いWWはnullではなく"木製"）', () => {
  const list = fixtureSymbolBuiltinList();
  assert.equal(list.length, 10);
  const aw = list.find(f => f.key === 'AW');
  assert.equal(aw.defaultMaterialGlass, 'アルミ');
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
