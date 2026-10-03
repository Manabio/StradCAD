// 読込みファイル名（localSnapshot.js）の単体テスト。localStorage は最小スタブ。
// importDocument / resetAll は store.js（IDB 依存）を実行せず、既存前例
// （catalog/catalogRegistryWiring.test.js）に倣いソース文字列で配線を検査する。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  getOpenedFileName, setOpenedFileName, clearOpenedFileName, saveNameFromOpenedFileName,
} from './localSnapshot.js';

const mem = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  },
});
beforeEach(() => mem.clear());

test('saveNameFromOpenedFileName: 末尾の .stq（大小無視）だけを外す', () => {
  assert.equal(saveNameFromOpenedFileName('家.stq'), '家');
  assert.equal(saveNameFromOpenedFileName('HOUSE.STQ'), 'HOUSE');
  assert.equal(saveNameFromOpenedFileName('plain'), 'plain');
  assert.equal(saveNameFromOpenedFileName('a.json'), 'a.json');
  assert.equal(saveNameFromOpenedFileName('a.stq.bak'), 'a.stq.bak');
  assert.equal(saveNameFromOpenedFileName('a.stq.stq'), 'a.stq');
});

test('get/set/clear: 未設定は null、往復、クリアで null に戻る', () => {
  assert.equal(getOpenedFileName(), null);
  setOpenedFileName('家.stq');
  assert.equal(getOpenedFileName(), '家.stq');
  clearOpenedFileName();
  assert.equal(getOpenedFileName(), null);
});

const storeSrc = fs.readFileSync(new URL('../store.js', import.meta.url), 'utf8');

test('store.js: importDocument は fileName で設定・無ければ消去し、検証より後に触る', () => {
  const m = /export async function importDocument\(envelope, fileName = null\) \{([\s\S]*?)\n\}/.exec(storeSrc);
  assert.ok(m, 'importDocument のシグネチャが見つからない');
  const body = m[1];
  assert.match(body, /^ {2}if \(fileName\) setOpenedFileName\(fileName\); else clearOpenedFileName\(\);$/m);
  assert.ok(body.indexOf('parseDocumentEnvelope') < body.indexOf('setOpenedFileName'));
});

test('store.js: resetAll は clearOpenedFileName を呼ぶ', () => {
  const m = /export async function resetAll\(\) \{([\s\S]*?)\n\}/.exec(storeSrc);
  assert.ok(m);
  assert.match(m[1], /^ {2}clearOpenedFileName\(\);$/m);
});
