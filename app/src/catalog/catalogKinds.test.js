import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogKind, CATALOG_KINDS, kindDef, listKinds, MATERIAL_CLASSES, classOf } from './catalogKinds.js';

test('listKinds: 登録済み6種別を返す', () => {
  assert.deepEqual(new Set(listKinds()), new Set([
    'material', 'interiorMaster', 'boundaryMaster', 'section', 'openingSubType', 'fixtureSymbol',
  ]));
  assert.deepEqual(Object.values(CatalogKind).sort(), listKinds().sort());
});

test('CATALOG_KINDS: キー配列の複製ではなく「kind→定義」の登録表そのもの（凍結）', () => {
  assert.deepEqual(Object.keys(CATALOG_KINDS).sort(), listKinds().sort());
  assert.equal(CATALOG_KINDS.material.kind, 'material');
  assert.equal(typeof CATALOG_KINDS.material.keyOf, 'function');
  assert.ok(Object.isFrozen(CATALOG_KINDS));
  // listKinds()はCATALOG_KINDSから導出（列挙手段の三重化を解消。QA指摘・Minor）
  assert.equal(kindDef('material'), CATALOG_KINDS.material);
});

test('【積み残し2026-09-22】CATALOG_KINDS: 行・配列（matchFields等）まで再帰的に凍結されている', () => {
  assert.ok(Object.isFrozen(CATALOG_KINDS.material));
  assert.ok(Object.isFrozen(CATALOG_KINDS.material.matchFields));
  assert.ok(Object.isFrozen(CATALOG_KINDS.material.compareFields));
  assert.ok(Object.isFrozen(CATALOG_KINDS.material.knownFields));
  assert.ok(Object.isFrozen(CATALOG_KINDS.material.dedupeFields));
  assert.ok(Object.isFrozen(CATALOG_KINDS.openingSubType.matchFields));
});

test('kindDef: 各種別の行はkeyOf/matchFields/minMatchFieldsを持つ', () => {
  for (const kind of listKinds()) {
    const def = kindDef(kind);
    assert.equal(def.kind, kind);
    assert.equal(typeof def.keyOf, 'function');
    assert.ok(Array.isArray(def.matchFields));
    assert.equal(typeof def.minMatchFields, 'number');
    assert.equal(typeof def.validate, 'function');
    assert.equal(typeof def.loadBuiltin, 'function');
  }
});

test('【失敗系】kindDef: 未知の種別は例外を投げる', () => {
  assert.throws(() => kindDef('unknownKind'), /未知のカタログ種別/);
});

test('【失敗系・QA指摘M2】kindDef: Object.prototypeの継承メンバー名（toString/constructor等）は未知の種別として例外を投げる', () => {
  assert.throws(() => kindDef('toString'), /未知のカタログ種別/);
  assert.throws(() => kindDef('constructor'), /未知のカタログ種別/);
  assert.throws(() => kindDef('hasOwnProperty'), /未知のカタログ種別/);
  assert.throws(() => kindDef('__proto__'), /未知のカタログ種別/);
});

// ---- keyOf（QA指摘B1: openingSubTypeは複合キー）----
test('openingSubType.keyOf: category:key の複合キーを返す（FITTING/WINDOWのkey衝突を区別する）', () => {
  const def = kindDef('openingSubType');
  assert.equal(def.keyOf({ category: 'fitting', key: 'doubleSliding' }), 'fitting:doubleSliding');
  assert.equal(def.keyOf({ category: 'window', key: 'doubleSliding' }), 'window:doubleSliding');
  assert.notEqual(
    def.keyOf({ category: 'fitting', key: 'doubleSliding' }),
    def.keyOf({ category: 'window', key: 'doubleSliding' }),
  );
});

test('【失敗系・積み残し2026-09-22】openingSubType.keyOf: category/keyが非空文字列でなければ例外（"undefined:…"を作らない）', () => {
  const def = kindDef('openingSubType');
  assert.throws(() => def.keyOf({ key: 'x' }), /category\/key/);
  assert.throws(() => def.keyOf({ category: 'fitting' }), /category\/key/);
  assert.throws(() => def.keyOf({ category: '', key: 'x' }), /category\/key/);
  assert.throws(() => def.keyOf({ category: 'fitting', key: '' }), /category\/key/);
  assert.throws(() => def.keyOf({}), /category\/key/);
});

test('material/section/interiorMaster/boundaryMaster.keyOf: 単一フィールド', () => {
  assert.equal(kindDef('material').keyOf({ code: '301000000001' }), '301000000001');
  assert.equal(kindDef('section').keyOf({ key: 'WOOD-90x90' }), 'WOOD-90x90');
  assert.equal(kindDef('interiorMaster').keyOf({ key: 'LIVING_ROOM' }), 'LIVING_ROOM');
  assert.equal(kindDef('boundaryMaster').keyOf({ key: 'EXTERIOR_WALL' }), 'EXTERIOR_WALL');
});

test('【失敗系・2026-09-22 QA指摘A】material/section/interiorMaster/boundaryMaster.keyOf: キーが非空文字列でなければ例外（openingSubTypeと同じ欠落検査を全種別に揃える）', () => {
  assert.throws(() => kindDef('material').keyOf({}), /codeが不正/);
  assert.throws(() => kindDef('material').keyOf({ code: '' }), /codeが不正/);
  assert.throws(() => kindDef('section').keyOf({}), /keyが不正/);
  assert.throws(() => kindDef('section').keyOf({ key: '' }), /keyが不正/);
  assert.throws(() => kindDef('interiorMaster').keyOf({}), /keyが不正/);
  assert.throws(() => kindDef('boundaryMaster').keyOf({}), /keyが不正/);
});

// ---- QA指摘M1: openingSubTypeのmatchFields順・B2: boundaryMasterのcompareFields/matchFields ----
test('openingSubType.matchFields: category,mechanism,機構パラメータ,wallKinds,defaultWidth,defaultHeight,labelの順（末尾から外す）', () => {
  assert.deepEqual(kindDef('openingSubType').matchFields, [
    'category', 'mechanism', 'childRatio', 'fireLeaves', 'fireAngle', 'slideLayout',
    'wallKinds', 'defaultWidth', 'defaultHeight', 'label',
  ]);
});

// ---- parseKey（keyOfの逆変換。積み残し2026-09-22。ステップ6でOpening.subTypeへ戻すのに使う予定）----
test('【積み残し2026-09-22】material.parseKey: 12桁コードを{code}へ戻す', () => {
  assert.deepEqual(kindDef('material').parseKey('301000000001'), { code: '301000000001' });
});

test('【失敗系・積み残し2026-09-22】material.parseKey: 12桁数字でなければ例外を投げる', () => {
  assert.throws(() => kindDef('material').parseKey('abc'), /キー（コード）が不正/);
  assert.throws(() => kindDef('material').parseKey(''), /キー（コード）が不正/);
});

test('【積み残し2026-09-22】section/interiorMaster/boundaryMaster.parseKey: {key}を返す', () => {
  assert.deepEqual(kindDef('section').parseKey('WOOD-90x90'), { key: 'WOOD-90x90' });
  assert.deepEqual(kindDef('interiorMaster').parseKey('LIVING_ROOM'), { key: 'LIVING_ROOM' });
  assert.deepEqual(kindDef('boundaryMaster').parseKey('EXTERIOR_WALL'), { key: 'EXTERIOR_WALL' });
});

test('【失敗系・積み残し2026-09-22】section/interiorMaster/boundaryMaster.parseKey: 空文字は例外を投げる', () => {
  assert.throws(() => kindDef('section').parseKey(''), /キーが不正/);
  assert.throws(() => kindDef('interiorMaster').parseKey(''), /キーが不正/);
  assert.throws(() => kindDef('boundaryMaster').parseKey(''), /キーが不正/);
});

test('【積み残し2026-09-22】openingSubType.parseKey: "category:key"を{category,key}へ戻す（keyOfの逆変換）', () => {
  assert.deepEqual(kindDef('openingSubType').parseKey('fitting:doubleSliding'), { category: 'fitting', key: 'doubleSliding' });
  assert.deepEqual(kindDef('openingSubType').parseKey('window:doubleSliding'), { category: 'window', key: 'doubleSliding' });
  // keyOf自体と往復できることを確認
  const def = kindDef('openingSubType');
  const entry = { category: 'fitting', key: 'singleSwing' };
  assert.deepEqual(def.parseKey(def.keyOf(entry)), { category: entry.category, key: entry.key });
});

test('【失敗系・積み残し2026-09-22】openingSubType.parseKey: fitting:/window:以外の形式は例外を投げる', () => {
  assert.throws(() => kindDef('openingSubType').parseKey('door:singleSwing'), /fitting:\.\.\.またはwindow:/);
  assert.throws(() => kindDef('openingSubType').parseKey('singleSwing'), /fitting:\.\.\.またはwindow:/);
  assert.throws(() => kindDef('openingSubType').parseKey(''), /fitting:\.\.\.またはwindow:/);
});

test('boundaryMaster.compareFields/matchFields: kind,layers,derivedFrom,fieldsの4項目・minMatchFields=4（完全一致のみ）', () => {
  const def = kindDef('boundaryMaster');
  assert.deepEqual(def.compareFields, ['kind', 'layers', 'derivedFrom', 'fields']);
  assert.deepEqual(def.matchFields, ['kind', 'layers', 'derivedFrom', 'fields']);
  assert.equal(def.minMatchFields, 4);
});

// ---- ステップ12c QA指摘M2（2026-09-24再報告）: material.compareFieldsにbackingClassを含み、
// silentDiffFields（spec/thickness）には含めない（下地区分の不一致は通知あり） ----
test('material.compareFields: backingClassを含み、silentDiffFieldsには含めない（下地区分の差は通知あり）', () => {
  const def = kindDef('material');
  assert.ok(def.compareFields.includes('backingClass'), 'material.compareFieldsにbackingClassが無い');
  assert.ok(!def.silentDiffFields.includes('backingClass'), 'material.silentDiffFieldsにbackingClassが含まれている（下地区分の差が無音化してしまう）');
});

// ---- ステップ12a: keyBoundFields/overrideLockedFields（Q-B確定 2026-09-23）----
test('keyBoundFields/overrideLockedFields: 登録表の6種別が表どおりの固定項目を持つ', () => {
  assert.deepEqual(kindDef('material').keyBoundFields, ['code']);
  assert.deepEqual(kindDef('material').overrideLockedFields, ['category', 'backingClass']);

  assert.deepEqual(kindDef('section').keyBoundFields, [
    'key', 'materialType', 'shape', 'width', 'height', 'webThickness', 'flangeThickness', 'wallThickness',
  ]);
  assert.deepEqual(kindDef('section').overrideLockedFields, []);

  assert.deepEqual(kindDef('openingSubType').keyBoundFields, ['category', 'key', 'mechanism']);
  assert.deepEqual(kindDef('openingSubType').overrideLockedFields, []);

  assert.deepEqual(kindDef('interiorMaster').keyBoundFields, ['key']);
  assert.deepEqual(kindDef('interiorMaster').overrideLockedFields, []);

  assert.deepEqual(kindDef('boundaryMaster').keyBoundFields, ['key']);
  assert.deepEqual(kindDef('boundaryMaster').overrideLockedFields, []);

  assert.deepEqual(kindDef('fixtureSymbol').keyBoundFields, ['key', 'category', 'mechanism']);
  assert.deepEqual(kindDef('fixtureSymbol').overrideLockedFields, []);
});

test('keyBoundFields/overrideLockedFields: 行・配列まで凍結されている（deepFreezeRegistryの対象）', () => {
  assert.ok(Object.isFrozen(CATALOG_KINDS.material.keyBoundFields));
  assert.ok(Object.isFrozen(CATALOG_KINDS.material.overrideLockedFields));
  assert.ok(Object.isFrozen(CATALOG_KINDS.section.keyBoundFields));
});

// QA指摘Minor-3（2026-09-24再報告）: 全kind（listKinds()由来）を回して両配列の存在・型・凍結を
// 確認する——12d等で新しい種別（fixtureSymbol）を登録表に足したとき、keyBoundFields/
// overrideLockedFieldsの付け忘れをここで検出する（上の2テストは個別種別のリテラル値の固定用で、
// 新規種別の追加検出はしない）。
test('【積み残し検出用・QA指摘Minor-3】keyBoundFields/overrideLockedFields: listKinds()の全種別が配列を持ち、凍結されている', () => {
  for (const kind of listKinds()) {
    const def = kindDef(kind);
    assert.ok(Array.isArray(def.keyBoundFields), `${kind}.keyBoundFieldsが配列でない`);
    assert.ok(Array.isArray(def.overrideLockedFields), `${kind}.overrideLockedFieldsが配列でない`);
    assert.ok(Object.isFrozen(def.keyBoundFields), `${kind}.keyBoundFieldsが凍結されていない`);
    assert.ok(Object.isFrozen(def.overrideLockedFields), `${kind}.overrideLockedFieldsが凍結されていない`);
  }
});

// ---- classOf（材料分類。R4/R6/R18・Q13確定2026-09-22）----
test('classOf: 既知の大分類・中分類はラベルを返す', () => {
  assert.deepEqual(classOf(10, 12), { major: 10, majorLabel: '木材', minor: 12, minorLabel: '面材' });
  assert.deepEqual(classOf(30, 24), { major: 30, majorLabel: 'その他建材', minor: 24, minorLabel: '左官' });
  assert.deepEqual(classOf(30, 26), { major: 30, majorLabel: 'その他建材', minor: 26, minorLabel: '石工' });
  assert.deepEqual(classOf(40, 12), { major: 40, majorLabel: '塗装', minor: 12, minorLabel: '防水' });
});

test('classOf: 未知の大分類・中分類はnull', () => {
  assert.equal(classOf(11, 11), null); // 旧体系（未分類）は登録しない
  assert.equal(classOf(10, 99), null);
  assert.equal(classOf(99, 10), null);
});

test('classOf: 50コンクリート/10RC壁（暫定分類・ステップ3追加）', () => {
  assert.deepEqual(classOf(50, 10), { major: 50, majorLabel: 'コンクリート', minor: 10, minorLabel: 'RC壁' });
});

test('MATERIAL_CLASSES: 中分類は全大分類で10始まりの2刻み・11欠番（R6の分類表そのまま）', () => {
  assert.equal(MATERIAL_CLASSES[11], undefined);
  assert.equal(Object.keys(MATERIAL_CLASSES).length, 5);
});

// QA指摘M6: 中分類全件をclassOfで固定する（保存データに焼き付く数値のため）。
// ステップ3（2026-09-22）でコンクリート/RC壁（50/10）を分類表へ追加し、19個になった。
test('MATERIAL_CLASSES: 中分類19個全件をclassOfで固定する（保存データに焼き付く数値）', () => {
  const expected = [
    [10, 10, '木材', '正角材'], [10, 12, '木材', '面材'], [10, 14, '木材', '線材'],
    [20, 10, '鋼材', '構造材'], [20, 12, '鋼材', '軽量鉄骨'], [20, 14, '鋼材', '鉄筋'], [20, 16, '鋼材', 'デッキプレート'],
    [30, 10, 'その他建材', '面材'], [30, 12, 'その他建材', 'ALC'], [30, 14, 'その他建材', '屋根'],
    [30, 16, 'その他建材', 'サイディング'], [30, 18, 'その他建材', '床仕上げ'], [30, 20, 'その他建材', 'シート'],
    [30, 22, 'その他建材', '断熱'], [30, 24, 'その他建材', '左官'], [30, 26, 'その他建材', '石工'],
    [40, 10, '塗装', '塗料'], [40, 12, '塗装', '防水'],
    [50, 10, 'コンクリート', 'RC壁'],
  ];
  assert.equal(expected.length, 19);
  for (const [major, minor, majorLabel, minorLabel] of expected) {
    assert.deepEqual(classOf(major, minor), { major, majorLabel, minor, minorLabel });
  }
  // MATERIAL_CLASSESの実体からも同じ総数が出ることを確認（表の変更に追随して壊れる形にする）
  const totalFromTable = Object.values(MATERIAL_CLASSES)
    .reduce((sum, majorClass) => sum + Object.keys(majorClass.minors).length, 0);
  assert.equal(totalFromTable, 19);
});

// ---- validate（型違い・必須欠落の失敗路）----
test('material.validate: 正常なエントリは例外を投げない', () => {
  assert.doesNotThrow(() => kindDef('material').validate({
    code: '301000000001', name: 'せっこうボード', spec: 'JIS A 6901', x: 0, y: 0, thickness: 9.5, note: '', category: 'panel',
  }));
});

test('【失敗系】material.validate: 必須項目(name)欠落は例外を投げる', () => {
  assert.throws(() => kindDef('material').validate({ code: '301000000001' }), /必須項目が欠落/);
});

test('【失敗系】material.validate: codeが12桁数字でなければ例外を投げる', () => {
  assert.throws(() => kindDef('material').validate(fullMaterial({ code: 'abc' })), /codeが不正/);
  assert.throws(() => kindDef('material').validate(fullMaterial({ code: '123' })), /codeが不正/);
});

test('【失敗系】material.validate: 型違い（xが文字列）は例外を投げる', () => {
  assert.throws(() => kindDef('material').validate(fullMaterial({ x: '10' })), /xが不正/);
});

// QA指摘・Minor（4.5-2）: 未設定はnull・省略は不可。spec/x/y/thicknessの省略を弾く。
function fullMaterial(overrides) {
  return { code: '301000000001', name: 'x', spec: 'JIS A 6901', x: 0, y: 0, thickness: 9.5, ...overrides };
}

test('【失敗系】material.validate: spec省略（undefined）は例外を投げる（nullは許容しない＝4.5-2はthicknessのみnull許容）', () => {
  const e = fullMaterial(); delete e.spec;
  assert.throws(() => kindDef('material').validate(e), /必須項目が欠落.*spec/);
});

test('【失敗系】material.validate: x省略は例外を投げる', () => {
  const e = fullMaterial(); delete e.x;
  assert.throws(() => kindDef('material').validate(e), /必須項目が欠落.*x/);
});

test('【失敗系】material.validate: y省略は例外を投げる', () => {
  const e = fullMaterial(); delete e.y;
  assert.throws(() => kindDef('material').validate(e), /必須項目が欠落.*y/);
});

test('【失敗系】material.validate: thickness省略は例外を投げる（null自体は許容）', () => {
  const e = fullMaterial(); delete e.thickness;
  assert.throws(() => kindDef('material').validate(e), /必須項目が欠落.*thickness/);
  assert.doesNotThrow(() => kindDef('material').validate(fullMaterial({ thickness: null })));
});

// QA指摘Minor2（カタログ保守パネル・2026-09-22）: 負の厚さは拒否する。0・null・正の数は許容。
test('【失敗系】material.validate: thicknessが負の数値なら例外を投げる', () => {
  assert.throws(() => kindDef('material').validate(fullMaterial({ thickness: -1 })), /thicknessが不正/);
  assert.doesNotThrow(() => kindDef('material').validate(fullMaterial({ thickness: 0 })));
  assert.doesNotThrow(() => kindDef('material').validate(fullMaterial({ thickness: null })));
});

test('section.validate: 正常系（RECT=形状別寸法無し／H形鋼=有り）は例外を投げない', () => {
  assert.doesNotThrow(() => kindDef('section').validate({
    key: 'WOOD-90x90', materialType: 'WOOD', shape: 'rect', width: 90, height: 90, label: '90×90',
  }));
  assert.doesNotThrow(() => kindDef('section').validate({
    key: 'STEEL-H300x150', materialType: 'STEEL', shape: 'hSection', width: 150, height: 300,
    webThickness: 6.5, flangeThickness: 9, label: 'H-300×150×6.5×9',
  }));
});

test('【失敗系】section.validate: 必須項目(label)欠落は例外を投げる', () => {
  assert.throws(() => kindDef('section').validate({ key: 'k', materialType: 'WOOD', shape: 'rect', width: 90, height: 90 }), /必須項目が欠落/);
});

// 2026-09-23 QA指摘Minor-2: keyが空文字だとvalidateは通ってしまうがkeyOfは例外を投げる
// 「遅延爆弾」（setOverlayは成功するがcomposeCatalogで初めて落ちる）になっていたため、
// materialのcodeと同じ非空文字列チェックに揃えた。
test('【失敗系・2026-09-23 QA指摘Minor-2】section.validate: keyが空文字は例外を投げる（typeof==="string"だけでは空文字を通していた）', () => {
  assert.throws(() => kindDef('section').validate({
    key: '', materialType: 'WOOD', shape: 'rect', width: 90, height: 90, label: '90×90',
  }), /keyが不正/);
});

test('openingSubType.validate: 正常系（category=fitting/window）', () => {
  assert.doesNotThrow(() => kindDef('openingSubType').validate({
    category: 'fitting', key: 'singleSwing', label: '片開き戸', mechanism: 'swing', defaultWidth: 800, defaultHeight: 2000,
  }));
  assert.doesNotThrow(() => kindDef('openingSubType').validate({
    category: 'window', key: 'doubleSliding', label: '引き違い窓', mechanism: 'slideDouble', defaultWidth: 1690, defaultHeight: 1170,
  }));
});

test('【失敗系】openingSubType.validate: category不正（fitting/window以外）は例外を投げる', () => {
  assert.throws(() => kindDef('openingSubType').validate({
    category: 'door', key: 'k', label: 'x', mechanism: 'swing', defaultWidth: 1, defaultHeight: 1,
  }), /categoryが不正/);
});

// ---- fixtureSymbol（ステップ12d） ----
test('fixtureSymbol.keyOf: keyをそのまま返す（単一フィールド）', () => {
  assert.equal(kindDef('fixtureSymbol').keyOf({ key: 'AW' }), 'AW');
});

test('【失敗系】fixtureSymbol.keyOf: keyが非空文字列でなければ例外', () => {
  assert.throws(() => kindDef('fixtureSymbol').keyOf({}), /keyが不正/);
  assert.throws(() => kindDef('fixtureSymbol').keyOf({ key: '' }), /keyが不正/);
});

test('fixtureSymbol.parseKey: {key}を返す', () => {
  assert.deepEqual(kindDef('fixtureSymbol').parseKey('AW'), { key: 'AW' });
});

test('【失敗系】fixtureSymbol.parseKey: 空文字は例外を投げる', () => {
  assert.throws(() => kindDef('fixtureSymbol').parseKey(''), /キーが不正/);
});

test('fixtureSymbol.validate: 正常系（スコープ無し記号・三方枠専用記号とも）。Q-D確定: keyの書式（英大文字2〜4文字）は検査しない', () => {
  assert.doesNotThrow(() => kindDef('fixtureSymbol').validate({ key: 'AW', label: 'AW（アルミ製窓）', category: 'window' }));
  assert.doesNotThrow(() => kindDef('fixtureSymbol').validate({
    key: 'SF', label: 'SF（鉄製三方枠）', category: 'fitting', mechanism: 'frameOnly', profile: 'bent',
  }));
  // 書式検査なし: 小文字・1文字・5文字以上でもvalidateは通す（保守パネルの追加時だけ検査する契約）。
  assert.doesNotThrow(() => kindDef('fixtureSymbol').validate({ key: 'pw-legacy', label: '旧記号', category: 'window' }));
});

test('【失敗系】fixtureSymbol.validate: 必須項目(label)欠落は例外を投げる', () => {
  assert.throws(() => kindDef('fixtureSymbol').validate({ key: 'ZZ', category: 'window' }), /必須項目が欠落/);
});

test('【失敗系】fixtureSymbol.validate: keyが空文字は例外を投げる（遅延爆弾防止。section等と同型）', () => {
  assert.throws(() => kindDef('fixtureSymbol').validate({
    key: '', label: 'x', category: 'window',
  }), /keyが不正/);
});

test('【失敗系】fixtureSymbol.validate: category不正（fitting/window以外）は例外を投げる', () => {
  assert.throws(() => kindDef('fixtureSymbol').validate({
    key: 'ZZ', label: 'x', category: 'door',
  }), /categoryが不正/);
});

test('【失敗系】fixtureSymbol.validate: mechanism/profile/defaultMaterialGlassが文字列・null・undefined以外は例外を投げる', () => {
  assert.throws(() => kindDef('fixtureSymbol').validate({
    key: 'ZZ', label: 'x', category: 'window', mechanism: 123,
  }), /mechanismが不正/);
  assert.throws(() => kindDef('fixtureSymbol').validate({
    key: 'ZZ', label: 'x', category: 'window', profile: 123,
  }), /profileが不正/);
  assert.throws(() => kindDef('fixtureSymbol').validate({
    key: 'ZZ', label: 'x', category: 'window', defaultMaterialGlass: 123,
  }), /defaultMaterialGlassが不正/);
  // null/undefinedはどちらも許容（既定なし）。
  assert.doesNotThrow(() => kindDef('fixtureSymbol').validate({
    key: 'ZZ', label: 'x', category: 'window', mechanism: null, profile: null, defaultMaterialGlass: null,
  }));
});

test('fixtureSymbol.isSupported: mechanism無し／frameOnlyのみ既知。profile無し／solid・bentのみ既知', () => {
  const def = kindDef('fixtureSymbol');
  assert.equal(def.isSupported({ key: 'AW', category: 'window' }), true);
  assert.equal(def.isSupported({ key: 'WF', category: 'fitting', mechanism: 'frameOnly', profile: 'solid' }), true);
  assert.equal(def.isSupported({ key: 'SF', category: 'fitting', mechanism: 'frameOnly', profile: 'bent' }), true);
});

test('【失敗系】fixtureSymbol.isSupported: 未知のmechanism・未知のprofileはfalse', () => {
  const def = kindDef('fixtureSymbol');
  assert.equal(def.isSupported({ mechanism: 'swing' }), false, 'frameOnly以外のmechanismは未知');
  assert.equal(def.isSupported({ profile: 'hollow' }), false, 'solid/bent以外のprofileは未知');
});

test('fixtureSymbol.matchFields: category,mechanism,profile,defaultMaterialGlass,labelの順（末尾から外す）・minMatchFields=2', () => {
  assert.deepEqual(kindDef('fixtureSymbol').matchFields, ['category', 'mechanism', 'profile', 'defaultMaterialGlass', 'label']);
  assert.equal(kindDef('fixtureSymbol').minMatchFields, 2);
});

test('fixtureSymbol.silentDiffFields: labelのみ（呼称差は通知しない。openingSubTypeと同じ割り切り）', () => {
  assert.deepEqual(kindDef('fixtureSymbol').silentDiffFields, ['label']);
});

test('fixtureSymbol.dedupeFields: null（重複禁止の対象外）', () => {
  assert.equal(kindDef('fixtureSymbol').dedupeFields, null);
});

test('interiorMaster.validate: 正常系', () => {
  assert.doesNotThrow(() => kindDef('interiorMaster').validate({
    key: 'LIVING_ROOM', label: '居室', wallMaterial: '301000000002', wallFinish: '302000000001', ceilingHeight: 2700,
  }));
});

test('【失敗系】interiorMaster.validate: 必須項目(ceilingHeight)欠落は例外を投げる', () => {
  assert.throws(() => kindDef('interiorMaster').validate({
    key: 'k', label: 'x', wallMaterial: 'a', wallFinish: 'b',
  }), /必須項目が欠落/);
});

test('【失敗系・2026-09-23 QA指摘Minor-2】interiorMaster.validate: keyが空文字は例外を投げる（遅延爆弾防止。sectionと同型）', () => {
  assert.throws(() => kindDef('interiorMaster').validate({
    key: '', label: '居室', wallMaterial: '301000000002', wallFinish: '302000000001', ceilingHeight: 2700,
  }), /keyが不正/);
});

test('boundaryMaster.validate: layered=layers必須／meta=layers不要', () => {
  assert.doesNotThrow(() => kindDef('boundaryMaster').validate({
    key: 'EXTERIOR_WALL', label: '外壁', kind: 'layered', layers: [{ role: 'x', code: null }],
  }));
  assert.doesNotThrow(() => kindDef('boundaryMaster').validate({
    key: 'STEP', label: '段差', kind: 'meta', fields: {},
  }));
});

test('【失敗系】boundaryMaster.validate: layeredなのにlayersが無ければ例外を投げる', () => {
  assert.throws(() => kindDef('boundaryMaster').validate({
    key: 'k', label: 'x', kind: 'layered',
  }), /layers.*が必要/);
});

test('【失敗系】boundaryMaster.validate: kindが不正な値なら例外を投げる', () => {
  assert.throws(() => kindDef('boundaryMaster').validate({
    key: 'k', label: 'x', kind: 'other',
  }), /kindが不正/);
});

test('【失敗系・2026-09-23 QA指摘Minor-2】boundaryMaster.validate: keyが空文字は例外を投げる（遅延爆弾防止。sectionと同型）', () => {
  assert.throws(() => kindDef('boundaryMaster').validate({
    key: '', label: '外壁', kind: 'layered', layers: [{ role: 'x', code: null }],
  }), /keyが不正/);
});

// QA指摘B2: derivedFromの型検証（compareFields/matchFieldsに追加されたフィールド）
test('boundaryMaster.validate: derivedFromは省略可・文字列なら例外を投げない', () => {
  assert.doesNotThrow(() => kindDef('boundaryMaster').validate({
    key: 'CANTILEVER_WALL', label: 'はね出し外壁', kind: 'layered', layers: [], derivedFrom: 'EXTERIOR_WALL',
  }));
  assert.doesNotThrow(() => kindDef('boundaryMaster').validate({
    key: 'EXTERIOR_WALL', label: '外壁', kind: 'layered', layers: [],
  }));
});

test('【失敗系】boundaryMaster.validate: derivedFromが文字列でなければ例外を投げる', () => {
  assert.throws(() => kindDef('boundaryMaster').validate({
    key: 'k', label: 'x', kind: 'layered', layers: [], derivedFrom: 123,
  }), /derivedFromが不正/);
});
