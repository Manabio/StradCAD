// ModePanel ドロワーの配線テスト。.jsx は node:test から import できないため、
// コメント行を除いた本体に対し、1行まるごと一致（m フラグ・行頭行末アンカー）で検査する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentLines } from '../uiBusySourceScan.js';

const srcRoot = path.resolve(import.meta.dirname, '..');
const read = (rel) => stripCommentLines(fs.readFileSync(path.resolve(srcRoot, rel), 'utf8'));

const SITES = [
  ['finish/FinishSidebar.jsx', /^\s*<ModePanel title="仕上げ表" raiseSignal=\{selectedRoomId\}>\s*$/m],
  ['openings/OpeningPanel.jsx', /^\s*\? <ModePanel title="建具" raiseSignal=\{selectedId\} onClose=\{onClose\}>\{inner\}<\/ModePanel>\s*$/m],
  ['ui/SiteInfoPanel.jsx', /^\s*\? <ModePanel width=\{360\} raiseSignal=\{mode\.selectedLineId\}>\{inner\}<\/ModePanel>\s*$/m],
  ['renderer/FloorplanPalette.jsx', /^\s*\? <ModePanel title="開口" width=\{320\} raiseSignal=\{opening\.id\} onClose=\{onClose\}>\{rows\}<\/ModePanel>\s*$/m],
  ['structural/StructuralPanel.jsx', /^\s*\? <ModePanel title="構造" raiseSignal=\{focusRequest\}>\{inner\}<\/ModePanel>\s*$/m],
];

for (const [rel, re] of SITES) {
  test(`【配線】${rel}: <ModePanel の行が期待する raiseSignal を渡す`, () => {
    assert.match(read(rel), re, `${rel} の <ModePanel 行が期待どおりでない`);
  });
}

test('【配線】ModePanel.jsx: 純モジュールの判定関数を実際に呼ぶ', () => {
  const code = read('ui/ModePanel.jsx');
  assert.match(code, /^\s*if \(shouldOpenOnSignal\(prevSignal, raiseSignal\)\) setOpen\(true\);\s*$/m);
  assert.match(code, /^\s*transform: drawerTransform\(open\),\s*$/m);
});

test('【配線】ModePanel.jsx: 開いて始まり、信号の変化を1度だけ見る', () => {
  const code = read('ui/ModePanel.jsx');
  assert.match(code, /^export function ModePanel\(\{ title, width = 480, onClose, raiseSignal, children \}\) \{\s*$/m);
  assert.match(code, /^\s*const \[open, setOpen\] = useState\(true\);\s*$/m);
  assert.match(code, /^\s*if \(raiseSignal !== prevSignal\) \{\s*$/m);
  assert.match(code, /^\s*setPrevSignal\(raiseSignal\);\s*$/m);
});

test('【配線】ModePanel.jsx: 取っ手は外枠の左外側にあり、タップで開閉を反転する（× は onClose のまま）', () => {
  const code = read('ui/ModePanel.jsx');
  assert.match(code, /^\s*onClick=\{\(\) => setOpen\(o => !o\)\}\s*$/m);
  assert.match(code, /^\s*left: -HANDLE_WIDTH, top: '50%',\s*$/m);
  assert.match(code, /^\s*onClick=\{onClose\}\s*$/m);
  // 外枠を overflow hidden にすると、閉じたとき取っ手が切り取られて開き直せない。
  // overflow の指定は中身の枠の1箇所だけ。
  assert.equal(code.match(/overflow/g).length, 1);
  assert.match(code, /^\s*overflow: 'hidden',\s*$/m);
});

test('【配線】ModePanel.jsx: 閉じている間は中身を inert にする', () => {
  assert.match(read('ui/ModePanel.jsx'), /^\s*inert=\{!open\}\s*$/m);
});
