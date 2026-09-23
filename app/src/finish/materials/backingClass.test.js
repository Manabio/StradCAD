// backingClass.js（下地材の材コード集合＋分類）のテスト。
// ステップ12c（2026-09-24）: backingClassOf がユーザー追加の下地材（catalog/catalogRegistry.js の
// overlay。category:'backing'）も分類できるようになったことを検証する——固定集合（builtin下地材の
// WOOD_WALL_BACKING_CODES/RC_WALL_BACKING_CODES）を最優先し、無ければoverlay（doc>user）の
// backingClassフィールドを見る。node:test はファイル単位で別プロセスのため、setOverlay汚染を
// 避けるenvironmentとして本ファイルを単独にする（catalogRegistry.overlay.test.jsと同じ配慮）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backingClassOf, BackingClass, RC_WALL_BACKING_CODES, WOOD_WALL_BACKING_CODES,
} from './backingClass.js';
import { setOverlay, clearOverlays, overlayGeneration } from '../../catalog/catalogRegistry.js';
import { CatalogKind } from '../../catalog/catalogKinds.js';

test.afterEach(() => clearOverlays());

function material(overrides) {
  return {
    code: '999000000001', name: 'テスト下地材', spec: '', x: 90, y: 45, thickness: null, note: '',
    category: 'backing',
    ...overrides,
  };
}

// ---- 固定集合優先（builtinのWOOD/RC下地材は overlay に何が乗っていても揺るがない） ----
test('backingClassOf: 固定集合（WOOD_WALL_BACKING_CODES）はoverlayに同キーのbackingClass:\'other\'が乗っていてもWOODのまま', () => {
  const code = WOOD_WALL_BACKING_CODES[0];
  setOverlay(CatalogKind.MATERIAL, { user: [material({ code, backingClass: 'other' })] });
  assert.equal(backingClassOf(code), BackingClass.WOOD);
});

test('backingClassOf: 固定集合（RC_WALL_BACKING_CODES）はoverlayに同キーのbackingClass:\'other\'が乗っていてもRCのまま（同梱\'other\'でもRC）', () => {
  const code = RC_WALL_BACKING_CODES[0];
  setOverlay(CatalogKind.MATERIAL, { doc: [material({ code, backingClass: 'other', x: 0, y: 0, thickness: 150 })] });
  assert.equal(backingClassOf(code), BackingClass.RC);
});

// ---- overlay（ユーザー追加の下地材）由来の判定 ----
test('backingClassOf: overlay（user）のbackingClass:\'wood\'はWOOD（固定集合に無いcode）', () => {
  const code = '999000000002';
  setOverlay(CatalogKind.MATERIAL, { user: [material({ code, backingClass: 'wood' })] });
  assert.equal(backingClassOf(code), BackingClass.WOOD);
});

test('backingClassOf: overlay（user）のbackingClass:\'other\'はOTHER', () => {
  const code = '999000000003';
  setOverlay(CatalogKind.MATERIAL, { user: [material({ code, backingClass: 'other' })] });
  assert.equal(backingClassOf(code), BackingClass.OTHER);
});

test('【失敗系】backingClassOf: overlay（user）のbackingClass:\'rc\'はOTHER（RCは固定集合専用。ユーザーはRCを選べない）', () => {
  const code = '999000000004';
  setOverlay(CatalogKind.MATERIAL, { user: [material({ code, backingClass: 'rc' })] });
  assert.equal(backingClassOf(code), BackingClass.OTHER);
});

test('【失敗系】backingClassOf: 固定集合にもoverlayにも無いcodeはOTHER', () => {
  assert.equal(backingClassOf('999000000099'), BackingClass.OTHER);
});

test('【失敗系】backingClassOf: undefinedはOTHER', () => {
  assert.equal(backingClassOf(undefined), BackingClass.OTHER);
});

test('backingClassOf: doc>userの解決順（同キーはdocが勝つ）', () => {
  const code = '999000000005';
  setOverlay(CatalogKind.MATERIAL, {
    doc: [material({ code, backingClass: 'wood' })],
    user: [material({ code, backingClass: 'other' })],
  });
  assert.equal(backingClassOf(code), BackingClass.WOOD);
});

// ---- メモ化（世代キー）: overlay変更で結果が変わる ----
test('backingClassOf: overlayGenerationがメモ化キー——setOverlayで内容を変えると結果も変わる', () => {
  const code = '999000000006';
  setOverlay(CatalogKind.MATERIAL, { user: [material({ code, backingClass: 'other' })] });
  assert.equal(backingClassOf(code), BackingClass.OTHER);
  const genBefore = overlayGeneration();
  setOverlay(CatalogKind.MATERIAL, { user: [material({ code, backingClass: 'wood' })] });
  assert.ok(overlayGeneration() > genBefore, 'setOverlayでoverlayGenerationが進んでいるはず');
  assert.equal(backingClassOf(code), BackingClass.WOOD, 'overlay変更後は再合成された結果を返すはず');
});

test('backingClassOf: clearOverlaysの後はoverlay由来のWOOD/OTHER判定が無くなる（固定集合外のcodeはOTHERへ戻る）', () => {
  const code = '999000000007';
  setOverlay(CatalogKind.MATERIAL, { user: [material({ code, backingClass: 'wood' })] });
  assert.equal(backingClassOf(code), BackingClass.WOOD);
  clearOverlays();
  assert.equal(backingClassOf(code), BackingClass.OTHER);
});

// ---- ステップ12c QA指摘n1（2026-09-24再報告）: overlayのMapはcategory:'backing'のエントリだけを見る ----
test('【失敗系・ステップ12c QA指摘n1】backingClassOf: overlayエントリのcategoryがbacking以外（面材等に誤ってbackingClassが乗っていた場合）はOTHER（overlay由来のWOOD判定に使わない）', () => {
  const code = '999000000008';
  setOverlay(CatalogKind.MATERIAL, {
    user: [{
      code, name: '面材にbackingClassが混入したケース', spec: '', x: 0, y: 0, thickness: 9, note: '',
      category: 'panel', backingClass: 'wood',
    }],
  });
  assert.equal(backingClassOf(code), BackingClass.OTHER);
});
