import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocumentJson, isDocumentEnvelope, parseDocumentEnvelope,
  bytesToBase64, base64ToBytes,
} from './documentFile.js';

function sampleBundle() {
  return {
    version: 1,
    catalogs: { material: [{ code: '101000000001', name: 'テスト材', spec: '', x: 0, y: 0, thickness: 12.5, category: 'panel' }] },
    encodings: { material: 'json' },
    aliases: {},
  };
}

test('bytesToBase64/base64ToBytes: 全バイト値(0-255)がラウンドトリップする', () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});

test('buildDocumentJson→parseDocumentEnvelope: 全チャネルがラウンドトリップする', () => {
  const doc = {
    floors: [
      { planeId: 'p1', bytes: new Uint8Array([1, 2, 3]) },
      { planeId: 'p2', bytes: new Uint8Array([4, 5]) },
    ],
    struct: new Uint8Array([10, 20]),
    planes: new Uint8Array([30]),
    site:   new Uint8Array([40, 50, 60]),
    info:   { siteInfo: { address: '東京都', useDistricts: ['未確認'] }, buildingInfo: { mainUse: '未定' } },
    bootPlaneId: 'p1',
  };
  const parsed = parseDocumentEnvelope(JSON.parse(buildDocumentJson(doc)));
  assert.equal(parsed.bootPlaneId, 'p1');
  assert.deepEqual(parsed.struct, doc.struct);
  assert.deepEqual(parsed.planes, doc.planes);
  assert.deepEqual(parsed.site, doc.site);
  assert.deepEqual(parsed.info, doc.info);
  assert.deepEqual(parsed.floors, doc.floors);
});

test('buildDocumentJson: JSONは先頭が"{"（parseOpenedFileBytesのJSON判別に乗る）', () => {
  const json = buildDocumentJson({ floors: [], struct: null, planes: null, site: null, bootPlaneId: null });
  assert.equal(json[0], '{');
});

test('null チャネル（struct/planes/site/info 未保存）と空floorsもラウンドトリップする', () => {
  const parsed = parseDocumentEnvelope(JSON.parse(
    buildDocumentJson({ floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null }),
  ));
  assert.equal(parsed.struct, null);
  assert.equal(parsed.planes, null);
  assert.equal(parsed.site, null);
  assert.equal(parsed.info, null);
  assert.equal(parsed.bootPlaneId, null);
  assert.deepEqual(parsed.floors, []);
});

test('isDocumentEnvelope: 旧JSONスナップショット（formatキーなし）はfalse', () => {
  assert.equal(isDocumentEnvelope({ nodes: [], links: [] }), false);
  assert.equal(isDocumentEnvelope(null), false);
  assert.equal(isDocumentEnvelope('stq-document'), false);
});

test('【失敗系】parseDocumentEnvelope: 文書エンベロープでなければ例外を投げる', () => {
  assert.throws(() => parseDocumentEnvelope({ nodes: [] }), /stq文書ファイルではありません/);
});

test('【失敗系】parseDocumentEnvelope: 未対応バージョンは例外を投げる（既存文書を消す前に検証で弾く）', () => {
  const data = JSON.parse(buildDocumentJson({ floors: [], struct: null, planes: null, site: null, bootPlaneId: null }));
  data.version = 999;
  assert.throws(() => parseDocumentEnvelope(data), /未対応の文書バージョン/);
});

test('【失敗系】parseDocumentEnvelope: floorsが配列でない・要素が不正なら例外を投げる', () => {
  const base = () => JSON.parse(buildDocumentJson({ floors: [], struct: null, planes: null, site: null, bootPlaneId: null }));
  const noArray = base();
  noArray.floors = 'broken';
  assert.throws(() => parseDocumentEnvelope(noArray), /フロアデータが不正/);
  const badItem = base();
  badItem.floors = [{ planeId: 'p1' }]; // bytes 欠落
  assert.throws(() => parseDocumentEnvelope(badItem), /フロアデータが不正/);
});

// ---- catalogs（カタログ束の同梱。4.5）----

test('buildDocumentJson→parseDocumentEnvelope: catalogsがラウンドトリップする', () => {
  const bundle = sampleBundle();
  const doc = { floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null, catalogs: bundle };
  const json = buildDocumentJson(doc);
  assert.equal(json[0], '{', 'JSON判別（先頭バイト）はcatalogs追加後も変わらない');
  const parsed = parseDocumentEnvelope(JSON.parse(json));
  assert.deepEqual(parsed.catalogs, bundle);
});

// ステップ7c→8f: 同梱の一般化（material・interiorMaster・boundaryMaster・sectionの4種別）。
// documentFile.js 自体は種別非依存のはず（catalogs はそのままbase64化するだけ）——4種別を
// 含む束でもラウンドトリップすることを固定する。
test('buildDocumentJson→parseDocumentEnvelope: material・interiorMaster・boundaryMaster・sectionの4種別を含むcatalogsがラウンドトリップする', () => {
  const bundle = {
    version: 1,
    catalogs: {
      material: [{ code: '101000000001', name: 'テスト材', spec: '', x: 0, y: 0, thickness: 12.5, category: 'panel' }],
      interiorMaster: [{ key: 'LIVING_ROOM', label: 'LDK', wallMaterial: '301000000001', wallFinish: '302000000001', ceilingHeight: 2400 }],
      boundaryMaster: [{ key: 'EXTERIOR_WALL', label: '外壁', kind: 'layered', layers: [{ role: '外壁材', code: '301600000001' }] }],
      section: [{ key: 'WOOD-120x390', materialType: 'WOOD', shape: 'rect', width: 120, height: 390, label: '120×390（文書同梱）' }],
    },
    encodings: { material: 'json', interiorMaster: 'json', boundaryMaster: 'json', section: 'json' },
    aliases: {},
  };
  const doc = { floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null, catalogs: bundle };
  const parsed = parseDocumentEnvelope(JSON.parse(buildDocumentJson(doc)));
  assert.deepEqual(parsed.catalogs, bundle);
  assert.equal(parsed.catalogs.catalogs.interiorMaster.length, 1);
  assert.equal(parsed.catalogs.catalogs.boundaryMaster.length, 1);
  assert.equal(parsed.catalogs.catalogs.section.length, 1);
});

test('buildDocumentJson: version は catalogs 追加後も 1 のまま', () => {
  const data = JSON.parse(buildDocumentJson({
    floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null, catalogs: sampleBundle(),
  }));
  assert.equal(data.version, 1);
});

test('旧 .stq（catalogsキー自体が無い）はそのまま開ける: catalogsはnullになる', () => {
  const legacyEnvelope = JSON.parse(buildDocumentJson({
    floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null,
  }));
  delete legacyEnvelope.catalogs; // 「catalogsフィールド追加前の.stq」を模す（キー自体が無い）
  const parsed = parseDocumentEnvelope(legacyEnvelope);
  assert.equal(parsed.catalogs, null);
});

test('catalogs未指定（呼び出し側が渡さない）はnullとして保存される', () => {
  const parsed = parseDocumentEnvelope(JSON.parse(
    buildDocumentJson({ floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null }),
  ));
  assert.equal(parsed.catalogs, null);
});

test('【失敗系】parseDocumentEnvelope: catalogsが不正なJSON（decodeCatalogBundle失敗）なら例外を投げる', () => {
  const data = JSON.parse(buildDocumentJson({
    floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null,
  }));
  data.catalogs = bytesToBase64(new TextEncoder().encode('{not-json'));
  assert.throws(() => parseDocumentEnvelope(data), /カタログ束のJSONが不正/);
});

test('【失敗系】parseDocumentEnvelope: catalogsがvalidateBundle失敗（キー重複）なら例外を投げる', () => {
  const bundle = sampleBundle();
  bundle.catalogs.material.push({ ...bundle.catalogs.material[0] }); // 同一codeを重複させる
  const data = JSON.parse(buildDocumentJson({
    floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null, catalogs: bundle,
  }));
  assert.throws(() => parseDocumentEnvelope(data), /キーが重複/);
});

test('【失敗系】parseDocumentEnvelope: catalogsが文字列でなければ例外を投げる', () => {
  const data = JSON.parse(buildDocumentJson({
    floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null,
  }));
  data.catalogs = { not: 'a base64 string' };
  assert.throws(() => parseDocumentEnvelope(data), /カタログ同梱データが不正/);
});
