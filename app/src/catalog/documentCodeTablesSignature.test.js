// documentCodeTablesSignature（文書固有の材コード読み替え表の決定的な署名）のテスト。
// 仕上げ脱出の省略判定（finish/finishExitStamp.js）の一致条件 codeSig の源。
// モジュールスコープの表を変えるため、各テストは finally で全種別を解除する（同じファイル内の他テストへ漏らさない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  documentCodeTablesSignature, setDocumentAliases, setDocumentCodeTable, addDocumentAliases,
  clearDocumentAliases, SNAPSHOT_REF_WALKERS,
} from './codeNormalization.js';

function withCleanTables(fn) {
  clearDocumentAliases();
  try { return fn(); } finally { clearDocumentAliases(); }
}

test('表が空（未設定）でも例外にならず、同じ文字列を返す（決定的）', () => withCleanTables(() => {
  const a = documentCodeTablesSignature();
  assert.equal(typeof a, 'string');
  assert.equal(documentCodeTablesSignature(), a);
  const kinds = Object.keys(SNAPSHOT_REF_WALKERS);
  assert.ok(kinds.length > 0, '前提: 種別が空でない');
  for (const k of kinds) assert.ok(a.includes(`"${k}"`), `署名に種別 ${k} が含まれる`);
}));

test('表に1件足す・値を変える・別の種別に足すと署名が変わる（本番の設定関数）', () => withCleanTables(() => {
  const empty = documentCodeTablesSignature();
  setDocumentAliases('material', { '111111111111': '222222222222' });
  const one = documentCodeTablesSignature();
  assert.notEqual(one, empty, '1件足す');
  setDocumentAliases('material', { '111111111111': '333333333333' });
  const changed = documentCodeTablesSignature();
  assert.notEqual(changed, one, '値を変える');
  assert.notEqual(changed, empty);
  setDocumentAliases('material', { '111111111111': '222222222222' });
  assert.equal(documentCodeTablesSignature(), one, '元へ戻せば元の署名');
  setDocumentAliases('interiorMaster', { A: 'B' });
  assert.notEqual(documentCodeTablesSignature(), one, '別の種別に足す');
  setDocumentAliases('material', null);
  setDocumentAliases('interiorMaster', null);
  assert.equal(documentCodeTablesSignature(), empty, '解除すれば空の署名');
}));

test('追記の挿入順だけが違っても同じ署名', () => withCleanTables(() => {
  addDocumentAliases('material', [{ from: '111111111111', to: '222222222222' }, { from: '333333333333', to: '444444444444' }]);
  const a = documentCodeTablesSignature();
  clearDocumentAliases();
  addDocumentAliases('material', [{ from: '333333333333', to: '444444444444' }, { from: '111111111111', to: '222222222222' }]);
  assert.equal(documentCodeTablesSignature(), a);
}));

test('未設定と明示的に空の表は署名が変わる（空の Map だと本体の振り直し表が効かないため別物）', () => withCleanTables(() => {
  const unset = documentCodeTablesSignature();
  setDocumentCodeTable('material', new Map());
  const emptyTable = documentCodeTablesSignature();
  assert.notEqual(emptyTable, unset);
  setDocumentCodeTable('material', null);
  assert.equal(documentCodeTablesSignature(), unset);
}));

test('表そのものを setDocumentCodeTable で直接差し替えても署名が変わる（currentDocumentAliases ではなく表を見る）', () => withCleanTables(() => {
  const empty = documentCodeTablesSignature();
  setDocumentCodeTable('section', new Map([['x', 'y']]));
  const a = documentCodeTablesSignature();
  assert.notEqual(a, empty);
  setDocumentCodeTable('section', new Map([['x', 'z']]));
  assert.notEqual(documentCodeTablesSignature(), a);
  setDocumentCodeTable('section', new Map([['p', null], ['x', 'z']]));
  const b = documentCodeTablesSignature();
  setDocumentCodeTable('section', new Map([['x', 'z'], ['p', null]]));
  assert.equal(documentCodeTablesSignature(), b, 'Map の挿入順だけが違う');
  setDocumentCodeTable('section', null);
  assert.equal(documentCodeTablesSignature(), empty);
}));
