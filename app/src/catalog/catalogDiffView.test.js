import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_DIFF_COLOR, CATALOG_DIFF_MARK, diffTooltip, diffPairs, fieldLabel } from './catalogDiffView.js';

// ---- 定数 ----
test('CATALOG_DIFF_COLOR: #f97316（renderer/SiteLinesLayer.jsxの隣地境界線と同じ値。意味は別）', () => {
  assert.equal(CATALOG_DIFF_COLOR, '#f97316');
});

test('CATALOG_DIFF_MARK: ≠', () => {
  assert.equal(CATALOG_DIFF_MARK, '≠');
});

// ---- diffTooltip ----
test('diffTooltip: 「項目名 現在値（本体 本体値）」を／区切りで連結する（設計の例: 厚15（本体12.5）を含む）', () => {
  const entry = { code: '301000000002', name: 'せっこうボード t=12.5', thickness: 15 };
  const baseEntry = { code: '301000000002', name: 'せっこうボード t=12.5', thickness: 12.5 };
  const text = diffTooltip('material', ['thickness'], entry, baseEntry);
  assert.equal(text, '厚 15（本体 12.5）');
});

test('diffTooltip: 複数項目は／区切りで連結する', () => {
  const entry = { name: 'A', note: '備考A' };
  const baseEntry = { name: 'B', note: '備考B' };
  const text = diffTooltip('material', ['name', 'note'], entry, baseEntry);
  assert.equal(text, '名称 A（本体 B）／備考 備考A（本体 備考B）');
});

test('diffTooltip: diffFieldsが空配列なら空文字', () => {
  assert.equal(diffTooltip('material', [], { name: 'A' }, { name: 'A' }), '');
});

test('diffTooltip: diffFieldsがnullなら空文字', () => {
  assert.equal(diffTooltip('material', null, { name: 'A' }, { name: 'A' }), '');
});

test('diffTooltip: null≡省略（undefined）は「（未設定）」表示にする', () => {
  const entry = { note: undefined };
  const baseEntry = { note: null };
  const text = diffTooltip('material', ['note'], entry, baseEntry);
  assert.equal(text, '備考 （未設定）（本体 （未設定））');
});

test('diffTooltip: 入れ子の値（配列・オブジェクト）はJSON化して表示する（クラッシュしない）', () => {
  const entry = { layers: [{ code: 'X', thickness: 12.5 }] };
  const baseEntry = { layers: [{ code: 'X', thickness: 9.5 }] };
  const text = diffTooltip('boundaryMaster', ['layers'], entry, baseEntry);
  assert.equal(text, `層構成 ${JSON.stringify(entry.layers)}（本体 ${JSON.stringify(baseEntry.layers)}）`);
});

test('【失敗系】diffTooltip: 未知の種別は例外', () => {
  assert.throws(() => diffTooltip('no-such-kind', ['name'], {}, {}), /未知のカタログ種別/);
});

// ---- diffPairs ----
// 2026-09-22 QA指摘Major-1: diffPairsは自前の等価判定を持たない（catalogMatch.jsのdiffEntries/
// valuesEqualへ委譲する）。trim・null≡undefined（トップレベル）・入れ子の厳密比較（キーの有無を
// 区別する等）の意味論そのものは catalogMatch.test.js（valuesEqual/diffEntriesの単体テスト。
// 36-51行目・87-104行目）が既に固定しているため、ここでは重複させず「diffPairsが委譲している
// こと」自体だけを確認する。

test('diffPairs: diffFields省略時はcatalogMatch.jsのdiffEntries(kind, from, to)で求める（自前の等価判定を持たない）', () => {
  const from = { name: 'A', spec: 'S', x: 0, y: 0, thickness: 12.5, category: 'panel', note: '' };
  const to   = { name: 'A', spec: 'S', x: 0, y: 0, thickness: 15,   category: 'panel', note: '' };
  const pairs = diffPairs('material', from, to);
  assert.deepEqual(pairs, [{ field: 'thickness', label: '厚', from: 12.5, to: 15 }]);
});

test('diffPairs: trim・null≡undefinedはcatalogMatch.jsのvaluesEqual規約に従う（差分に含めない）', () => {
  const from = { name: '  同じ名前  ', note: null };
  const to   = { name: '同じ名前', note: undefined };
  assert.deepEqual(diffPairs('material', from, to), []);
});

test('diffPairs: 入れ子オブジェクトの厳密比較（{x:null}≠{}）もcatalogMatch.js経由でそのまま反映される', () => {
  const from = { key: 'k', kind: 'layered', layers: [], derivedFrom: null, fields: { x: null } };
  const to   = { key: 'k', kind: 'layered', layers: [], derivedFrom: null, fields: {} };
  const pairs = diffPairs('boundaryMaster', from, to);
  assert.deepEqual(pairs, [{ field: 'fields', label: '項目', from: { x: null }, to: {} }]);
});

test('diffPairs: 第4引数(diffFields)を渡すと再計算せずそのまま使う（呼び出し側がdocDiffMap等で既に持つ場合の再計算回避）', () => {
  // from/toの内容は完全一致（本来diffEntriesなら差分なし）だが、diffFieldsを明示的に渡せば
  // それを信頼してそのまま使う（等価判定を二重に持たない設計の確認）。
  const from = { name: 'A', thickness: 10 };
  const to   = { name: 'A', thickness: 10 };
  const pairs = diffPairs('material', from, to, ['thickness']);
  assert.deepEqual(pairs, [{ field: 'thickness', label: '厚', from: 10, to: 10 }]);
});

test('【失敗系】diffPairs: 未知の種別は例外', () => {
  assert.throws(() => diffPairs('no-such-kind', {}, {}), /未知のカタログ種別/);
});

// ---- fieldLabel（QA指摘Minor-1・ステップ10f・2026-09-23）: FIELD_LABELSの唯一の読み出し口。
// ui/CatalogMaintenancePanel.jsx の閲覧タブ（ReadonlyKindTab）詳細欄もこれ経由でラベルを引く
// ——ツールチップ（diffTooltip）と詳細欄で別の日本語名が同時に出る二重定義を防ぐ。 ----
test('fieldLabel: FIELD_LABELSに登録済みの項目はその日本語ラベルを返す（material/section/openingSubType）', () => {
  assert.equal(fieldLabel('material', 'thickness'), '厚');
  assert.equal(fieldLabel('section', 'height'), 'せい');
  assert.equal(fieldLabel('section', 'wallThickness'), '管厚');
  assert.equal(fieldLabel('section', 'shape'), '断面形状');
  assert.equal(fieldLabel('openingSubType', 'wallKinds'), '対応壁種');
  assert.equal(fieldLabel('openingSubType', 'fireLeaves'), '防火枚数');
  assert.equal(fieldLabel('openingSubType', 'fireAngle'), '防火角度');
  assert.equal(fieldLabel('openingSubType', 'slideLayout'), '引違い配置');
});

test('fieldLabel: 未知の項目・種別はfield名をそのまま返す（投げない）', () => {
  assert.equal(fieldLabel('material', 'noSuchField'), 'noSuchField');
  assert.equal(fieldLabel('no-such-kind', 'name'), 'name');
});

// Q11裁定（renderer/・figure/ がこのモジュールをimportしないこと）は
// catalogDiffViewWiring.test.js で確認する（重複させない）。
