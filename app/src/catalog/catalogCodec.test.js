import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCatalogBundle, decodeCatalogBundle, assertJsonSafe } from './catalogCodec.js';

const sampleBundle = {
  version: 1,
  catalogs: {
    material: [
      { code: '301000000001', name: 'せっこうボード', spec: 'JIS A 6901', x: 0, y: 0, thickness: 9.5, note: '備考', category: 'panel' },
    ],
  },
  encodings: { material: 'json' },
  aliases: { material: { '999999999999': '301000000001' } },
};

test('encodeCatalogBundle→decodeCatalogBundle: ラウンドトリップする', () => {
  const decoded = decodeCatalogBundle(encodeCatalogBundle(sampleBundle));
  assert.deepEqual(decoded, sampleBundle);
});

test('decodeCatalogBundle: 未知の種別・未知の項目は往復で保持する', () => {
  const bundle = {
    version: 1,
    catalogs: {
      material: [{ code: '301000000001', name: 'x', 未来の項目: 'keep-me' }],
      未来の種別: [{ key: 'a', label: 'b' }],
    },
    encodings: {},
    aliases: {},
  };
  const decoded = decodeCatalogBundle(encodeCatalogBundle(bundle));
  assert.deepEqual(decoded, bundle);
  assert.equal(decoded.catalogs.material[0].未来の項目, 'keep-me');
  assert.deepEqual(decoded.catalogs.未来の種別, [{ key: 'a', label: 'b' }]);
});

// ---- 失敗路: JSON化できない値 ----
test('【失敗系】assertJsonSafe/encodeCatalogBundle: undefinedを含むと例外を投げる', () => {
  assert.throws(() => assertJsonSafe({ a: undefined }), /undefined/);
  assert.throws(() => encodeCatalogBundle({ version: 1, catalogs: { material: [{ code: '1', name: undefined }] } }), /undefined/);
});

test('【失敗系】assertJsonSafe/encodeCatalogBundle: NaN/Infinityを含むと例外を投げる', () => {
  assert.throws(() => assertJsonSafe({ a: NaN }), /NaN\/Infinity/);
  assert.throws(() => assertJsonSafe({ a: Infinity }), /NaN\/Infinity/);
  assert.throws(() => assertJsonSafe({ a: -Infinity }), /NaN\/Infinity/);
});

test('【失敗系】assertJsonSafe: 循環参照は例外を投げる', () => {
  const obj = { a: 1 };
  obj.self = obj;
  assert.throws(() => assertJsonSafe(obj), /循環参照/);
});

test('【失敗系】assertJsonSafe: 関数・Symbolは例外を投げる', () => {
  assert.throws(() => assertJsonSafe({ a: () => {} }), /JSON化できない値/);
  assert.throws(() => assertJsonSafe({ a: Symbol('x') }), /JSON化できない値/);
});

// ---- 失敗路: decode側 ----
test('【失敗系】decodeCatalogBundle: JSONでないバイト列は例外を投げる', () => {
  assert.throws(() => decodeCatalogBundle(new Uint8Array([0xff, 0xfe, 0x00])));
});

test('【失敗系】decodeCatalogBundle: 形が違う（オブジェクトでない）は例外を投げる', () => {
  assert.throws(() => decodeCatalogBundle(new TextEncoder().encode('[1,2,3]')), /形式が不正/);
  assert.throws(() => decodeCatalogBundle(new TextEncoder().encode('"just a string"')), /形式が不正/);
});

test('【失敗系】decodeCatalogBundle: versionが不正なら例外を投げる', () => {
  assert.throws(
    () => decodeCatalogBundle(new TextEncoder().encode(JSON.stringify({ version: 999, catalogs: {} }))),
    /未対応のカタログ束バージョン/,
  );
});

test('【失敗系】decodeCatalogBundle: catalogsが無い/不正なら例外を投げる', () => {
  assert.throws(
    () => decodeCatalogBundle(new TextEncoder().encode(JSON.stringify({ version: 1, catalogs: 'x' }))),
    /catalogsが不正/,
  );
});

// ---- QA指摘M5: encodings/aliasesは定義済みでオブジェクトでなければ例外（未定義のときだけ{}） ----
test('decodeCatalogBundle: encodings/aliasesが未定義（キー自体が無い）なら{}になる', () => {
  const decoded = decodeCatalogBundle(new TextEncoder().encode(JSON.stringify({ version: 1, catalogs: {} })));
  assert.deepEqual(decoded.encodings, {});
  assert.deepEqual(decoded.aliases, {});
});

test('【失敗系】decodeCatalogBundle: encodingsが定義済みでオブジェクトでなければ例外', () => {
  assert.throws(
    () => decodeCatalogBundle(new TextEncoder().encode(JSON.stringify({ version: 1, catalogs: {}, encodings: 'x' }))),
    /encodingsが不正/,
  );
  assert.throws(
    () => decodeCatalogBundle(new TextEncoder().encode(JSON.stringify({ version: 1, catalogs: {}, encodings: null }))),
    /encodingsが不正/,
  );
  assert.throws(
    () => decodeCatalogBundle(new TextEncoder().encode(JSON.stringify({ version: 1, catalogs: {}, encodings: [1, 2] }))),
    /encodingsが不正/,
  );
});

test('【失敗系】decodeCatalogBundle: aliasesが定義済みでオブジェクトでなければ例外', () => {
  assert.throws(
    () => decodeCatalogBundle(new TextEncoder().encode(JSON.stringify({ version: 1, catalogs: {}, aliases: 'x' }))),
    /aliasesが不正/,
  );
  assert.throws(
    () => decodeCatalogBundle(new TextEncoder().encode(JSON.stringify({ version: 1, catalogs: {}, aliases: null }))),
    /aliasesが不正/,
  );
});
