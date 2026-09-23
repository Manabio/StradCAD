// structural/sectionCatalog.js のステップ8d: overlay（doc/user）合成・世代キーによる
// メモ化無効化の確認。setOverlay/clearOverlaysでcatalogRegistry.jsのモジュールスコープ状態を
// 変えるため、汚染を避けてsectionCatalog.test.jsとは別ファイルにする
// （catalogRegistry.overlay.test.js / core/room.overlay.test.js と同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays, removeDocEntry } from '../catalog/catalogRegistry.js';
import { findSectionEntry, woodRectSectionKey, sectionList, SECTION_CATALOG } from './sectionCatalog.js';

test.afterEach(() => clearOverlays());

function docEntry(overrides) {
  return {
    key: 'WOOD-120x390', materialType: 'WOOD', shape: 'rect', width: 120, height: 390, label: '120×390（doc追加）',
    ...overrides,
  };
}

test('doc overlayで断面を立てると、findSectionEntryに即反映される', () => {
  setOverlay(CatalogKind.SECTION, { doc: [docEntry()] });
  const entry = findSectionEntry('WOOD-120x390');
  assert.ok(entry, 'doc overlayの断面がfindSectionEntryに反映されていない');
  assert.equal(entry.height, 390);
});

test('clearOverlays後はdoc overlayが外れ、findSectionEntryはnullに戻る（メモ化の無効化）', () => {
  setOverlay(CatalogKind.SECTION, { doc: [docEntry()] });
  assert.ok(findSectionEntry('WOOD-120x390'), '立てた直後は見えているはず');
  clearOverlays();
  assert.equal(findSectionEntry('WOOD-120x390'), null, 'clearOverlays後もキャッシュが残っている（世代キー無効化の不具合）');
});

test('removeDocEntry後もfindSectionEntryに反映される（メモ化の無効化）', () => {
  setOverlay(CatalogKind.SECTION, { doc: [docEntry()] });
  assert.ok(findSectionEntry('WOOD-120x390'));
  removeDocEntry(CatalogKind.SECTION, 'WOOD-120x390');
  assert.equal(findSectionEntry('WOOD-120x390'), null, 'removeDocEntry後もキャッシュが残っている');
});

// ---- 裁定Q-A: woodRectSectionKeyはoverlay込み ----
test('裁定Q-A: overlayにWOOD-120x390を足すとwoodRectSectionKey(120,390)が非nullになる', () => {
  assert.equal(woodRectSectionKey(120, 390), null, '立てる前はbuiltinに無いのでnull');
  setOverlay(CatalogKind.SECTION, { doc: [docEntry()] });
  assert.equal(woodRectSectionKey(120, 390), 'WOOD-120x390', 'overlay込みで拾えていない');
});

test('sectionList: overlay追加分はbuiltinの並びの末尾に置かれ、builtinの並びは保たれる', () => {
  setOverlay(CatalogKind.SECTION, { doc: [docEntry()] });
  const list = sectionList();
  assert.equal(list.length, SECTION_CATALOG.length + 1);
  for (let i = 0; i < SECTION_CATALOG.length; i++) {
    assert.equal(list[i].key, SECTION_CATALOG[i].key, `index ${i} のbuiltin順が保たれていない`);
  }
  assert.equal(list.at(-1).key, 'WOOD-120x390', '追加分が末尾に無い');
});

test('sectionList: 同キーのdoc overlayはbuiltinの位置でdoc側の内容に上書きされる', () => {
  const idx = SECTION_CATALOG.findIndex(s => s.key === 'WOOD-120x120');
  assert.ok(idx >= 0);
  setOverlay(CatalogKind.SECTION, { doc: [{ ...SECTION_CATALOG[idx], label: '上書き済み' }] });
  const list = sectionList();
  assert.equal(list.length, SECTION_CATALOG.length, '同キー上書きなので件数は増えない');
  assert.equal(list[idx].key, 'WOOD-120x120');
  assert.equal(list[idx].label, '上書き済み');
});
