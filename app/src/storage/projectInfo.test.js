import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeProjectInfo, decodeProjectInfo } from './projectInfo.js';

test('encodeProjectInfo→decodeProjectInfo: 日本語を含むフォーム値がラウンドトリップする', () => {
  const info = {
    siteInfo: {
      address: '東京都千代田区1-1',
      useDistricts: ['第一種低層住居専用地域'],
      roadDirections: { 南: { name: '区道', roadType: '法第42条1項1号（公道）' } },
    },
    buildingInfo: { mainUse: '一戸建ての住宅', workType: '新築' },
  };
  assert.deepEqual(decodeProjectInfo(encodeProjectInfo(info)), info);
});

test('encodeProjectInfo: null・欠損フィールドは {siteInfo:null, buildingInfo:null} に正規化される', () => {
  assert.deepEqual(decodeProjectInfo(encodeProjectInfo(null)), { siteInfo: null, buildingInfo: null });
  assert.deepEqual(decodeProjectInfo(encodeProjectInfo({ siteInfo: { a: 1 } })),
    { siteInfo: { a: 1 }, buildingInfo: null });
});

test('【失敗系】decodeProjectInfo: JSONでないバイト列は例外を投げる（呼び出し側がcatchする契約）', () => {
  assert.throws(() => decodeProjectInfo(new Uint8Array([0xff, 0xfe, 0x00])));
});
