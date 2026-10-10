// CeilingPanel.jsx の配線（ソーステキスト走査。.jsx は react を静的に引くため node:test から直接 import できない）。
// 区画の高さ欄（S5）: 確定・解除が withFinishUndo で包まれ markDirty される／検証は parsePlanCutHeightInput／階段所属は disabled／
// keydown は伝播させない。1行まるごと一致（m フラグ）で判定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentLines } from '../uiBusySourceScan.js';

const src = stripCommentLines(fs.readFileSync(path.resolve(import.meta.dirname, 'CeilingPanel.jsx'), 'utf8'));
const count = (re) => (src.match(re) ?? []).length;

test('【配線】区画の確定は withFinishUndo で room.setCeilingZones(assignZoneHeight(...)) を包み、markDirty する', () => {
  assert.match(src, /^\s*withFinishUndo\(graph, \(\) => room\.setCeilingZones\(assignZoneHeight\(graph, room, selection\.cellKeys, mm\)\)\);\s*$/m);
  assert.equal(count(/assignZoneHeight\(/g), 1, '区画を書くのは確定の1か所だけ');
});

test('【配線】区画の解除は withFinishUndo で room.setCeilingZones(clearZoneCells(...)) を包み、markDirty する', () => {
  assert.match(src, /^\s*withFinishUndo\(graph, \(\) => room\.setCeilingZones\(clearZoneCells\(graph, room, selection\.cellKeys\)\)\);\s*$/m);
  assert.equal(count(/^\s*markDirty\(\);\s*$/gm), 2, '確定と解除でそれぞれ markDirty');
  assert.equal(count(/room\.setCeilingZones\(/g), 2, '区画の書込みは確定と解除の2か所だけで、どちらも withFinishUndo の中');
});

test('【配線】入力の検証は parsePlanCutHeightInput（0 以下・非数は確定しない）。Enter で確定、keydown は伝播させない', () => {
  assert.match(src, /^\s*const mm = parsePlanCutHeightInput\(text\);\s*$/m);
  assert.match(src, /^\s*if \(mm == null\) \{ setError\(true\); return; \}\s*$/m);
  assert.match(src, /^\s*onKeyDown=\{e => \{ e\.stopPropagation\(\); if \(e\.key === 'Enter' && !disabled\) commit\(\); \}\}\s*$/m);
});

test('【配線】書込み先は ceilingZoneTargetRoom（部屋所属のみ）。無ければ入力・確定が disabled（階段所属は S6 まで無効）', () => {
  assert.match(src, /^\s*const room = ceilingZoneTargetRoom\(graph, selection\);\s*$/m);
  assert.match(src, /^\s*const disabled = !room;\s*$/m);
  assert.match(src, /^\s*disabled=\{disabled\}\s*$/m);
  assert.match(src, /^\s*<button onClick=\{commit\} disabled=\{disabled\} title=\{title\} style=\{\{ fontSize: 12 \}\}>確定<\/button>\s*$/m);
});

test('【配線】区画の欄は選択があるときだけ出す', () => {
  assert.match(src, /^\s*\{mode\.selection && \(\s*$/m);
  assert.match(src, /^\s*<CeilingZoneField key=\{zoneFieldKey\(mode\.selection\)\} graph=\{graph\} selection=\{mode\.selection\} zone=\{summary\?\.zone \?\? null\} \/>\s*$/m);
  assert.match(src, /^const zoneFieldKey = selection => `\$\{selection\.owner\.kind\}:\$\{selection\.owner\.id\}:\$\{\[\.\.\.selection\.cellKeys\]\.sort\(\)\.join\(','\)\}`;\s*$/m, '選択が変わったら欄を作り直す（入力途中の text を持ち越さない）');
});
