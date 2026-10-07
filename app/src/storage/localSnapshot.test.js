// 読込みファイル名（localSnapshot.js）の単体テスト。localStorage は最小スタブ。
// importDocument / resetAll は store.js（IDB 依存）を実行せず、既存前例
// （catalog/catalogRegistryWiring.test.js）に倣いソース文字列で配線を検査する。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  getOpenedFileName, getOpenedFileInfo, setOpenedFileName, clearOpenedFileName, saveNameFromOpenedFileName,
  openDocumentFileTarget, writeDocumentFileTarget, supportsSaveFilePicker,
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

test('getOpenedFileInfo: 既定は確定、confirmed=false で未確定印が立ち、確定名の再設定・クリアで消える', () => {
  assert.equal(getOpenedFileInfo(), null);
  setOpenedFileName('家.stq'); // 読込み（File.name は実名）
  assert.deepEqual(getOpenedFileInfo(), { name: '家.stq', confirmed: true });
  setOpenedFileName('家.stq', false); // 退避経路で保存
  assert.deepEqual(getOpenedFileInfo(), { name: '家.stq', confirmed: false });
  setOpenedFileName('家 (1).stq', true); // ピッカーで確定
  assert.deepEqual(getOpenedFileInfo(), { name: '家 (1).stq', confirmed: true });
  setOpenedFileName('家.stq', false);
  clearOpenedFileName(); // 新規（全消去）で印も消える
  assert.equal(getOpenedFileInfo(), null);
  setOpenedFileName('家.stq');
  assert.equal(getOpenedFileInfo().confirmed, true, 'クリア後の印が残っていてはならない');
});

function stubPicker(impl) {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: impl ? { showSaveFilePicker: impl } : {} });
}
afterEach(() => { delete globalThis.window; delete globalThis.document; });

test('supportsSaveFilePicker: showSaveFilePicker が関数のときだけ true（無い・関数でない・window 自体が無い→false）', () => {
  stubPicker(async () => ({ name: 'a.stq' }));
  assert.equal(supportsSaveFilePicker(), true);
  stubPicker(null); // window はあるがピッカーが無い（Firefox・Safari 等）
  assert.equal(supportsSaveFilePicker(), false);
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { showSaveFilePicker: 1 } });
  assert.equal(supportsSaveFilePicker(), false, '関数でなければ非対応');
  delete globalThis.window;
  assert.equal(supportsSaveFilePicker(), false, 'window が無くても例外にせず false');
});

test('openDocumentFileTarget: ピッカー対応なら .stq を補った suggestedName を渡し、確定名はハンドルの name', async () => {
  let opts;
  stubPicker(async (o) => { opts = o; return { name: '家 (1).stq' }; });
  const t = await openDocumentFileTarget('家');
  assert.equal(opts.suggestedName, '家.stq');
  assert.equal(t.kind, 'handle');
  assert.equal(t.name, '家 (1).stq');
  assert.equal(t.confirmed, true, 'ピッカー経路は実名＝確定');
});

test('writeDocumentFileTarget: handle は createWritable へ json を write して close', async () => {
  const calls = [];
  const handle = { name: 'a.stq', createWritable: async () => ({ write: async (j) => calls.push(['w', j]), close: async () => calls.push(['c']) }) };
  await writeDocumentFileTarget({ kind: 'handle', handle, name: 'a.stq' }, '{"x":1}');
  assert.deepEqual(calls, [['w', '{"x":1}'], ['c']]);
});

test('writeDocumentFileTarget: write が失敗したら例外を伝え、ストリームを abort して close しない', async () => {
  const calls = [];
  const handle = { name: 'a.stq', createWritable: async () => ({
    write: async () => { throw new Error('disk'); },
    close: async () => calls.push('close'),
    abort: async () => calls.push('abort'),
  }) };
  await assert.rejects(() => writeDocumentFileTarget({ kind: 'handle', handle, name: 'a.stq' }, '{}'), /disk/);
  assert.deepEqual(calls, ['abort']);
});

test('writeDocumentFileTarget: createWritable が失敗したら例外を伝える', async () => {
  const handle = { name: 'a.stq', createWritable: async () => { throw new Error('denied'); } };
  await assert.rejects(() => writeDocumentFileTarget({ kind: 'handle', handle, name: 'a.stq' }, '{}'), /denied/);
});

test('openDocumentFileTarget: AbortError は null、他の例外は throw', async () => {
  stubPicker(async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; });
  assert.equal(await openDocumentFileTarget('家'), null);
  stubPicker(async () => { throw new Error('boom'); });
  await assert.rejects(() => openDocumentFileTarget('家'), /boom/);
});

test('非対応ブラウザ: kind download・要求名、書込みは a.download に .stq 名', async () => {
  stubPicker(null);
  const t = await openDocumentFileTarget('家');
  assert.deepEqual(t, { kind: 'download', name: '家.stq', confirmed: false });
  const a = { click() {}, remove() {} };
  globalThis.document = { createElement: () => a, body: { appendChild() {} } };
  const origURL = { c: URL.createObjectURL, r: URL.revokeObjectURL };
  URL.createObjectURL = () => 'blob:x'; URL.revokeObjectURL = () => {};
  try {
    await writeDocumentFileTarget(t, '{}');
  } finally { URL.createObjectURL = origURL.c; URL.revokeObjectURL = origURL.r; }
  assert.equal(a.download, '家.stq');
});

const appSrc = fs.readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');

test('App.jsx: handleSaveConfirm はピッカーを exportDocument より前に呼び、確定名を保存・表示へ反映', () => {
  const m = /async function handleSaveConfirm\(fileName\) \{([\s\S]*?)\r?\n {2}\}\r?\n/.exec(appSrc);
  assert.ok(m, 'handleSaveConfirm が見つからない');
  const body = m[1];
  const openIdx   = body.indexOf('openDocumentFileTarget(');
  const cancelIdx = body.search(/if \(!target\) return;/);
  const idleIdx   = body.indexOf('structuralSync.whenIdle(');
  const exportIdx = body.indexOf('exportDocument(');
  const writeIdx  = body.indexOf('writeDocumentFileTarget(');
  const nameIdx   = body.indexOf('setOpenedFileName(target.name, target.confirmed)');
  const stateIdx  = body.indexOf('setOpenedFileState({ name: target.name, confirmed: target.confirmed })');
  for (const [k, v] of Object.entries({ openIdx, cancelIdx, idleIdx, exportIdx, writeIdx, nameIdx, stateIdx })) {
    assert.ok(v >= 0, `${k} が見つからない`);
  }
  // ピッカー → 取消の早期 return → 構造同期待ち → export → 書込み → （成功後に）名前の更新、の順
  assert.ok(openIdx < cancelIdx && cancelIdx < idleIdx, '取消の return はピッカー直後・whenIdle より前');
  assert.ok(idleIdx < exportIdx && exportIdx < writeIdx, 'whenIdle → exportDocument → 書込み の順');
  assert.ok(writeIdx < nameIdx && writeIdx < stateIdx, 'ファイル名の更新は書込みの後（失敗時に更新しない）');
});

test('App.jsx: メニュー横の表示は getOpenedFileInfo を初期値にし、未確定なら名前の後ろにグレーの「(?)」を付ける', () => {
  assert.match(appSrc, /useState\(getOpenedFileInfo\)/, '表示 state の初期値が getOpenedFileInfo でない');
  const m = /\{openedFile && \(([\s\S]*?)\n {8}\)\}/.exec(appSrc);
  assert.ok(m, 'openedFile の表示ブロックが見つからない');
  assert.match(m[1], /\{openedFile\.name\}/);
  assert.match(m[1], /\{!openedFile\.confirmed && <span style=\{\{ color: '#94a3b8'[^}]*\}\}>\(\?\)<\/span>\}/,
    '未確定のときだけグレーの「(?)」を付ける span が無い');
  assert.ok(m[1].indexOf('{openedFile.name}') < m[1].indexOf('(?)'), '「(?)」は名前の後ろ');
});

test('App.jsx: handleSaveConfirm は書込み失敗時に markDirty して未保存扱いへ戻し、例外を外側へ伝える', () => {
  const m = /async function handleSaveConfirm\(fileName\) \{([\s\S]*?)\r?\n {2}\}\r?\n/.exec(appSrc);
  assert.ok(m, 'handleSaveConfirm が見つからない');
  // writeDocumentFileTarget を囲む try/catch の中に markDirty() と throw があること
  const w = /try \{\s*await writeDocumentFileTarget\(target, json\);\s*\} catch \((\w+)\) \{([\s\S]*?)\n\s*\}/.exec(m[1]);
  assert.ok(w, 'writeDocumentFileTarget を囲む try/catch が見つからない');
  assert.match(w[2], /^\s*markDirty\(\);$/m, '書込み失敗時に markDirty() していない');
  assert.match(w[2], new RegExp(`^\\s*throw ${w[1]};$`, 'm'), '書込み失敗の例外を外側（失敗トースト）へ伝えていない');
  // 外側の catch（失敗トースト）の前に markDirty が無いこと＝exportDocument 以前の失敗では dirty を触らない
  assert.equal((m[1].match(/markDirty\(\)/g) || []).length, 1, 'markDirty は書込み失敗の1箇所だけ');
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

// 配線: メニュー「保存」はピッカー対応なら SaveFileDialog を出さず handleSaveConfirm へ直行し、
// 非対応なら従来どおり setSaveDialogDefaultName でダイアログを開く（ユーザー裁定2026-10-07）。
test('App.jsx 配線: 保存メニューはピッカー対応ならダイアログを飛ばして直接保存、非対応ならダイアログを開く', () => {
  const src = fs.readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const m = code.match(/if \(id === 'save'\) \{([\s\S]*?)\n {4}\}/);
  assert.ok(m, "'save' 分岐が見つからない");
  assert.match(m[1], /if \(supportsSaveFilePicker\(\)\) return handleSaveConfirm\(defaultName\);/,
    'ピッカー対応時に handleSaveConfirm へ直行していない');
  assert.match(m[1], /setSaveDialogDefaultName\(defaultName\);/,
    '非対応時にダイアログを開く経路が無い');
});
