import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultOpeningHeight, defaultMaterialGlassFor, FIXTURE_SYMBOLS,
  findCatalogEntry, FITTING_CATALOG, WINDOW_CATALOG, IMPLEMENTED_MECHANISMS, OpeningMechanism,
  normalizeSubType, hingeSideMatters, getFixtureSymbols, defaultFixtureSymbolFor, frameProfileFor,
  DEFAULT_FRAME_FACE_MM, DEFAULT_FRAME_PROJECTION_MM, isDoorlessMechanism, DOORLESS_MECHANISMS,
} from './openingCatalog.js';

// ---- 「扉のない建具」判定（展開図のアキ標記の根拠）----
test('isDoorlessMechanism: FRAME_ONLY(三方枠)だけがtrue、扉のある機構・未指定はfalse', () => {
  assert.equal(isDoorlessMechanism(OpeningMechanism.FRAME_ONLY), true);
  assert.equal(isDoorlessMechanism(OpeningMechanism.SWING), false);
  assert.equal(isDoorlessMechanism(OpeningMechanism.SLIDE_DOUBLE), false);
  assert.equal(isDoorlessMechanism(OpeningMechanism.FIXED), false, 'FIX窓はガラスがあるため「抜け」ではない');
  assert.equal(isDoorlessMechanism(undefined), false);
  assert.equal(isDoorlessMechanism(null), false);
  assert.deepEqual([...DOORLESS_MECHANISMS], [OpeningMechanism.FRAME_ONLY]);
});

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

test('【失敗系】defaultMaterialGlassFor: 未知の記号・prototype名・非文字列はnull（関数を返さない）', () => {
  for (const sym of ['XX', 'constructor', 'toString', 'valueOf', '__proto__', null, undefined, 12]) {
    assert.equal(defaultMaterialGlassFor(sym), null, `記号 ${String(sym)} で null にならない`);
  }
});

test('defaultMaterialGlassFor: 未知の記号はnull', () => {
  assert.equal(defaultMaterialGlassFor('XX'), null);
});

test('FIXTURE_SYMBOLS: WW（木製窓）が窓カテゴリに存在する', () => {
  const ww = FIXTURE_SYMBOLS.find(f => f.key === 'WW');
  assert.ok(ww);
  assert.equal(ww.category, 'window');
});

// ---- 三方枠（WF/SF/SSF）: 記号のスコープ・平面断面プロファイル・既定寸法 ----
test('FITTING_CATALOG: 末尾に三方枠(threeSidedFrame・mechanism:FRAME_ONLY)が存在する（catalog[0]フォールバック回避のため末尾必須）', () => {
  assert.equal(FITTING_CATALOG[FITTING_CATALOG.length - 1].key, 'threeSidedFrame');
  assert.equal(FITTING_CATALOG[FITTING_CATALOG.length - 1].mechanism, OpeningMechanism.FRAME_ONLY);
  assert.notEqual(FITTING_CATALOG[0].key, 'threeSidedFrame');
});

test('getFixtureSymbols: mechanism省略時は従来どおりスコープ無しの記号のみ返す（WF/SF/SSFを含まない）', () => {
  const symbols = getFixtureSymbols('fitting').map(f => f.key);
  assert.deepEqual(symbols, ['AD', 'SD', 'WD']);
});

test('getFixtureSymbols: mechanism===FRAME_ONLYは三方枠専用記号(WF/SF/SSF)のみ返す', () => {
  const symbols = getFixtureSymbols('fitting', OpeningMechanism.FRAME_ONLY).map(f => f.key);
  assert.deepEqual(symbols, ['WF', 'SF', 'SSF']);
});

test('getFixtureSymbols: FRAME_ONLY以外の機構を渡してもmechanism省略時と同じ（スコープ無しの記号のみ）', () => {
  const symbols = getFixtureSymbols('fitting', OpeningMechanism.SWING).map(f => f.key);
  assert.deepEqual(symbols, ['AD', 'SD', 'WD']);
});

test('defaultFixtureSymbolFor: mechanism===FRAME_ONLYはwallKind不問で常にWF', () => {
  assert.equal(defaultFixtureSymbolFor('fitting', 'interior', OpeningMechanism.FRAME_ONLY), 'WF');
  assert.equal(defaultFixtureSymbolFor('fitting', 'exterior', OpeningMechanism.FRAME_ONLY), 'WF');
});

test('defaultFixtureSymbolFor: mechanism省略時は従来どおりwallKindで分岐する', () => {
  assert.equal(defaultFixtureSymbolFor('fitting', 'interior'), 'WD');
  assert.equal(defaultFixtureSymbolFor('fitting', 'exterior'), 'AD');
});

test('frameProfileFor: WFはsolid（木材の無垢断面）、SF/SSFはbent（鋼板の曲げ加工）', () => {
  assert.equal(frameProfileFor('WF'), 'solid');
  assert.equal(frameProfileFor('SF'), 'bent');
  assert.equal(frameProfileFor('SSF'), 'bent');
});

test('frameProfileFor: 未知の記号はsolidへフォールバック', () => {
  assert.equal(frameProfileFor('XX'), 'solid');
});

test('DEFAULT_MATERIALS: WF=木製・SF=スチール・SSF=ステンレス', () => {
  assert.equal(defaultMaterialGlassFor('WF'), '木製');
  assert.equal(defaultMaterialGlassFor('SF'), 'スチール');
  assert.equal(defaultMaterialGlassFor('SSF'), 'ステンレス');
});

test('三方枠の見付・出幅の既定値は20mm/12mm', () => {
  assert.equal(DEFAULT_FRAME_FACE_MM, 20);
  assert.equal(DEFAULT_FRAME_PROJECTION_MM, 12);
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

// ---- 吊元(hingeSide)が意味を持つ機構の判定（OpeningEditor.jsx「吊元反転」ボタンの表示条件） ----
test('hingeSideMatters: 片側吊りの機構はtrue、両開き系（吊元が両枠端）はfalse', () => {
  for (const m of [OpeningMechanism.SWING, OpeningMechanism.SWING_CHILD, OpeningMechanism.SWING_IN,
    OpeningMechanism.FREE, OpeningMechanism.PROJECT_V, OpeningMechanism.DREH_KIPP]) {
    assert.equal(hingeSideMatters(m), true, `${m} は吊元が意味を持つはず`);
  }
  assert.equal(hingeSideMatters(OpeningMechanism.SWING_DOUBLE), false, '両開きは吊元が両枠端＝反転が無意味');
  assert.equal(hingeSideMatters(OpeningMechanism.FREE_DOUBLE), false, '自由両開きも同様');
});

test('hingeSideMatters: FIRE_DOORはfireLeaves、FIRE_FOLDはfireAngleで分かれる', () => {
  assert.equal(hingeSideMatters(OpeningMechanism.FIRE_DOOR, findCatalogEntry('fitting', 'fireDoorSingle')), true);
  assert.equal(hingeSideMatters(OpeningMechanism.FIRE_DOOR, findCatalogEntry('fitting', 'fireDoorDouble')), false);
  assert.equal(hingeSideMatters(OpeningMechanism.FIRE_FOLD, findCatalogEntry('fitting', 'fireFold90')), true);
  assert.equal(hingeSideMatters(OpeningMechanism.FIRE_FOLD, findCatalogEntry('fitting', 'fireFold180')), false);
});

test('hingeSideMatters: 非蝶番系（引き戸・FIX等）はfalse', () => {
  assert.equal(hingeSideMatters(OpeningMechanism.SLIDE_DOUBLE), false);
  assert.equal(hingeSideMatters(OpeningMechanism.FIXED), false);
  assert.equal(hingeSideMatters(undefined), false);
});
