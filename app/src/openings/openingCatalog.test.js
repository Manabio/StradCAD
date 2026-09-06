import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultOpeningHeight, defaultMaterialGlassFor, FIXTURE_SYMBOLS,
  findCatalogEntry, FITTING_CATALOG, WINDOW_CATALOG, IMPLEMENTED_MECHANISMS, OpeningMechanism,
  normalizeSubType,
} from './openingCatalog.js';

test('defaultOpeningHeight: カタログに存在する種別はdefaultHeightを返す', () => {
  assert.equal(defaultOpeningHeight('window', 'doubleSliding'), 1170);
  assert.equal(defaultOpeningHeight('fitting', 'singleSwing'), 2000);
});

test('defaultOpeningHeight: 未知のsubTypeはカテゴリ既定へフォールバック', () => {
  assert.equal(defaultOpeningHeight('window', 'unknownType'), 1100);
  assert.equal(defaultOpeningHeight('fitting', 'unknownType'), 2000);
});

// ---- 建具表「材料・ガラス」の記号別初期値 ----
test('defaultMaterialGlassFor: 記号ごとの初期値を返す', () => {
  assert.equal(defaultMaterialGlassFor('AW'), 'アルミ');
  assert.equal(defaultMaterialGlassFor('AD'), 'アルミ');
  assert.equal(defaultMaterialGlassFor('WD'), 'ポリ合板フラッシュ戸、木製枠');
  assert.equal(defaultMaterialGlassFor('WW'), '木製');
  assert.equal(defaultMaterialGlassFor('JW'), '樹脂');
  assert.equal(defaultMaterialGlassFor('SW'), 'スチール');
  assert.equal(defaultMaterialGlassFor('SD'), 'スチール');
});

test('defaultMaterialGlassFor: 未知の記号はnull', () => {
  assert.equal(defaultMaterialGlassFor('XX'), null);
});

test('FIXTURE_SYMBOLS: WW（木製窓）が窓カテゴリに存在する', () => {
  const ww = FIXTURE_SYMBOLS.find(f => f.key === 'WW');
  assert.ok(ww);
  assert.equal(ww.category, 'window');
});

// ================================================================
// 窓・扉バリエーション追加（.claude/opening-model.md、実装仕様書 §1・§2）
// ================================================================

// ---- (a) findCatalogEntry: 新規追加キーを返す ----
test('findCatalogEntry: 新規追加した建具キーがFITTING_CATALOGから引ける', () => {
  const doubleSwing = findCatalogEntry('fitting', 'doubleSwing');
  assert.equal(doubleSwing?.mechanism, OpeningMechanism.SWING_DOUBLE);

  const parentChild = findCatalogEntry('fitting', 'parentChild');
  assert.equal(parentChild?.mechanism, OpeningMechanism.SWING_CHILD);
  assert.equal(parentChild?.childRatio, 0.3);

  const fireDoorDouble = findCatalogEntry('fitting', 'fireDoorDouble');
  assert.equal(fireDoorDouble?.mechanism, OpeningMechanism.FIRE_DOOR);
  assert.equal(fireDoorDouble?.fireLeaves, 2);
  assert.equal(fireDoorDouble?.fireAngle, 90);
});

test('findCatalogEntry: 新規追加した窓キーがWINDOW_CATALOGから引ける', () => {
  assert.equal(findCatalogEntry('window', 'inswing')?.mechanism, OpeningMechanism.SWING_IN);
  assert.equal(findCatalogEntry('window', 'drehKipp')?.mechanism, OpeningMechanism.DREH_KIPP);
  assert.equal(findCatalogEntry('window', 'glassBlock')?.mechanism, OpeningMechanism.GLASS_BLOCK);
});

// ---- (b) SLIDE_LAYOUTエントリのslideLayoutパラメータ形状 ----
test('SLIDE_LAYOUT: doubleSliding3(3枚建て)はtracks:3・panels3件（fixなし）', () => {
  const entry = findCatalogEntry('window', 'doubleSliding3');
  assert.equal(entry.mechanism, OpeningMechanism.SLIDE_LAYOUT);
  assert.equal(entry.slideLayout.tracks, 3);
  assert.equal(entry.slideLayout.panels.length, 3);
  assert.deepEqual(entry.slideLayout.panels.map(p => p.arrow), ['neg', 'both', 'pos']);
  assert.ok(entry.slideLayout.panels.every(p => !p.fix));
});

test('SLIDE_LAYOUT: singleSliding(片引き)はtracks:2・panels2件（可動1・fix1）', () => {
  const entry = findCatalogEntry('window', 'singleSliding');
  assert.equal(entry.slideLayout.tracks, 2);
  assert.equal(entry.slideLayout.panels.length, 2);
  assert.equal(entry.slideLayout.panels[0].arrow, 'pos');
  assert.equal(entry.slideLayout.panels[1].fix, true);
});

test('SLIDE_LAYOUT: splitSliding(引き分け)はfix-可動-可動-fixの4パネル', () => {
  const entry = findCatalogEntry('window', 'splitSliding');
  assert.equal(entry.slideLayout.panels.length, 4);
  assert.deepEqual(entry.slideLayout.panels.map(p => (p.fix ? 'fix' : p.arrow)), ['fix', 'neg', 'pos', 'fix']);
});

// ---- IMPLEMENTED_MECHANISMS: 今回平面記号を実装した機構がすべて含まれる ----
test('IMPLEMENTED_MECHANISMS: FITTING_CATALOG/WINDOW_CATALOGの全エントリの機構が実装済みに含まれる', () => {
  for (const entry of [...FITTING_CATALOG, ...WINDOW_CATALOG]) {
    assert.ok(
      IMPLEMENTED_MECHANISMS.has(entry.mechanism),
      `${entry.key}(${entry.mechanism}) がIMPLEMENTED_MECHANISMSに含まれていない`,
    );
  }
});

// ---- 失敗系: 未知のsubTypeはnull（呼び出し側がtick/ラベル表示へフォールバックする前提） ----
test('【失敗系】findCatalogEntry: 未知のsubTypeはnullを返す', () => {
  assert.equal(findCatalogEntry('window', 'unknownWindowType'), null);
  assert.equal(findCatalogEntry('fitting', 'unknownFittingType'), null);
});

// ---- 廃止キーの読み替え（旧データ移行。graphFbs.js のデコードが呼ぶ） ----
test('normalizeSubType: 廃止した swingDoor は singleSwing へ読み替える', () => {
  assert.equal(normalizeSubType('fitting', 'swingDoor'), 'singleSwing');
  assert.equal(findCatalogEntry('fitting', 'swingDoor'), null, 'カタログ本体から削除済みのはず');
  assert.ok(FITTING_CATALOG.some(o => o.key === 'singleSwing' && o.label === '片開き戸'));
});

test('【失敗系】normalizeSubType: 現行キー・未知キー・null はそのまま返す', () => {
  assert.equal(normalizeSubType('fitting', 'singleSwing'), 'singleSwing');
  assert.equal(normalizeSubType('fitting', 'unknownFittingType'), 'unknownFittingType');
  assert.equal(normalizeSubType('window', 'swingDoor'), 'swingDoor'); // 窓カテゴリには読み替え表がない
  assert.equal(normalizeSubType('fitting', null), null);
});
