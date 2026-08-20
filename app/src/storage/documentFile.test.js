import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocumentJson, isDocumentEnvelope, parseDocumentEnvelope,
  bytesToBase64, base64ToBytes,
} from './documentFile.js';

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
