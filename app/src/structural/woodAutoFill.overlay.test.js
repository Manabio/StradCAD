// QA記録-1: structural/woodFraming.js woodBeamSectionForDepth（在来木造の梁の自動選定。
// structural/woodAutoFill.js autoFillWoodBeamDepthsが最終的に呼ぶ「成→断面キー」の唯一の
// 判断口）が structural/sectionCatalog.js woodRectSectionKey 経由で overlay（ユーザーライブラリ）を
// 見ることを固定する。overlayを立てる系はwoodAutoFill.test.js/woodFraming.test.jsとは別ファイルに
// 分ける（sectionCatalog.overlay.test.js / catalogRegistry.overlay.test.js と同じ方針。
// node:testはファイル単位で別プロセスのためoverlay汚染を避けられる）。
//
// 変異=structural/sectionCatalog.js woodRectSectionKeyを`SECTION_CATALOG.some(...)`に戻す退行
// （overlayを無視する）で本ファイルの1本目が赤くなる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { woodBeamSectionForDepth } from './woodFraming.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';

test.afterEach(() => clearOverlays());

test('woodBeamSectionForDepth: overlayにWOOD-120x390をuserで立てると、成390が要求される梁の自動選定がWOOD-120x390を選ぶ', () => {
  setOverlay(CatalogKind.SECTION, {
    user: [{ key: 'WOOD-120x390', materialType: 'WOOD', shape: 'rect', width: 120, height: 390, label: '120×390（ユーザー追加）' }],
  });
  assert.equal(woodBeamSectionForDepth(390, 120), 'WOOD-120x390');
});

test('【失敗系】woodBeamSectionForDepth: overlay無しでは幅120×成390の組合せがカタログに無くnull（呼び出し側autoFillWoodBeamDepthsは既存sectionDefIdのまま据え置く＝既定断面へのフォールバック）', () => {
  assert.equal(woodBeamSectionForDepth(390, 120), null);
});
