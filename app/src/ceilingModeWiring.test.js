// 天伏モード（appMode 'ceiling'）の配線不変条件（S1a'）。.jsx は node:test から単体 import できないため
// ソーステキスト検査で固定する。1行まるごと一致（m フラグの行頭・行末アンカー）で照合し、行コメントは
// 落としてから検査する（コメント文への誤マッチで変異を見逃さない）。App.jsx の走査は
// uiBusySourceScan.js の共用関数を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAppSrc, stripCommentLines, extractArrowFunctionBody } from './uiBusySourceScan.js';

const readSrc = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
const appCode = stripCommentLines(readAppSrc());

test('【配線】App.jsx: ceiling のローダーは CeilingModeState を new して返す（init なし・floorplan と同型）', () => {
  assert.match(appCode,
    /^\s*\? import\('\.\/modes\/CeilingModeState\.js'\)\.then\(m => new m\.CeilingModeState\(\)\)\s*$/m);
  assert.match(appCode, /^\s*: appMode === 'ceiling'\s*$/m);
});

test('【配線】App.jsx: CeilingPanel は appMode === ceiling && mode のときだけマウントし、graph/mode/isLandscape を渡す', () => {
  assert.match(appCode, /^\s*\{appMode === 'ceiling' && mode && \(\s*$/m);
  assert.match(appCode, /^\s*<CeilingPanel graph=\{graph\} mode=\{mode\} isLandscape=\{isLandscape\} \/>\s*$/m);
  assert.match(appCode, /^import \{ CeilingPanel \} +from '\.\/ceiling\/CeilingPanel\.jsx';\s*$/m);
});

test('【配線】App.jsx: 天伏は仕上げ表パネルを出さず、modeBoundaries に ceiling: を持たない（graph を変えないので境界処理なし）', () => {
  const start = appCode.indexOf('const modeBoundaries = {');
  assert.ok(start >= 0, 'const modeBoundaries = { が見つからない');
  const end = appCode.indexOf('\n  };', start);
  assert.ok(end > start, 'modeBoundaries の閉じが見つからない');
  assert.ok(!/^\s*ceiling:/m.test(appCode.slice(start, end)), 'modeBoundaries に ceiling: がある');
  assert.ok(!/finishPanelTabIds|tabIds=/.test(appCode), 'App.jsx に仕上げ表の tabIds 絞り込みが残っている（兼用案）');
  assert.match(appCode, /^\s*\{appMode === 'finish' && mode && !mode\.namingRoomId && \(\s*$/m);
});

test('【配線】CeilingPanel.jsx: タブは mode.setActiveTab、行は ceilingPanelRows、横長は ModePanel・縦長は BottomSheet（title 天伏）', () => {
  const code = stripCommentLines(readSrc('ceiling/CeilingPanel.jsx'));
  assert.match(code, /^\s*onClick=\{\(\) => mode\.setActiveTab\(tab\.id\)\}\s*$/m);
  assert.match(code, /^\s*const rows = mode\.activeTab === 'stair' \? stairRows\(graph\) : interiorRows\(graph\);\s*$/m);
  assert.match(code, /^\s*onClick=\{\(\) => \{ if \(row\.kind === 'room'\) mode\.selectRoom\(row\.id\); \}\}\s*$/m);
  assert.match(code, /<ModePanel title="天伏" /);
  assert.match(code, /<BottomSheet title="天伏" /);
  assert.ok(!/FinishTable|FinishModeState/.test(code), 'CeilingPanel が仕上げ表／FinishModeState を引いている');
});

// ---- usePointerInteraction.js: S1a' の天伏はパン・ピンチだけ ----
const pointerSrc = readSrc('interaction/usePointerInteraction.js');
const lines = (code) => code.split(/\r?\n/);

/** ハンドラ本体のうち `if (appMode === 'ceiling') {` ブロック（閉じ括弧まで）の行。 */
function ceilingBlock(body) {
  const all = lines(body);
  const i = all.findIndex(l => l.trim() === "if (appMode === 'ceiling') {");
  assert.ok(i >= 0, "if (appMode === 'ceiling') { が見つからない");
  const indent = all[i].match(/^\s*/)[0];
  const j = all.findIndex((l, k) => k > i && l === `${indent}}`);
  assert.ok(j > i, 'ceiling ブロックの閉じ括弧が見つからない');
  return all.slice(i, j + 1).map(l => l.trim());
}

test('【配線】usePointerInteraction: pointerDown の ceiling 分岐は findGutterCL( と longPress.begin( より前で return する（パンのみ）', () => {
  const body = extractArrowFunctionBody(pointerSrc, 'const handlePointerDown = (e) => {');
  const block = ceilingBlock(body);
  assert.ok(block.includes('drag.current = { lastX: clientX, lastY: clientY };'));
  assert.ok(block.includes('setIsPanning(true);'));
  assert.ok(block.includes('return;'));
  const i = body.indexOf("if (appMode === 'ceiling') {");
  assert.ok(i < body.indexOf('findGutterCL('), 'ceiling 分岐が findGutterCL( より後ろにある');
  assert.ok(i < body.indexOf('longPress.begin('), 'ceiling 分岐が longPress.begin( より後ろにある');
});

test('【配線】usePointerInteraction: pointerMove の ceiling 分岐は viewport.pan して return（updateSnap・移動/描画に落ちない）', () => {
  const body = extractArrowFunctionBody(pointerSrc, 'const handlePointerMove = (e) => {');
  const block = ceilingBlock(body);
  assert.ok(block.includes('viewport.pan(dx, dy);'));
  assert.ok(block.includes('return;'));
  const i = body.indexOf("if (appMode === 'ceiling') {");
  assert.ok(i < body.indexOf('updateSnap('), 'ceiling 分岐が updateSnap( より後ろにある');
  assert.ok(i < body.indexOf('longPress.move('), 'ceiling 分岐が longPress.move( より後ろにある');
});

test('【配線】usePointerInteraction: pointerUp / pointerLeave の ceiling 分岐はパンを解除して return（メニュー・選択に落ちない）', () => {
  for (const [needle, stop] of [
    ['const handlePointerUp = (e) => {', 'commitCLMove('],
    ['const handlePointerLeave = () => {', 'longPress.abort('],
  ]) {
    const body = extractArrowFunctionBody(pointerSrc, needle);
    const block = ceilingBlock(body);
    assert.ok(block.includes('drag.current = null;'), `${needle}: drag.current = null; が無い`);
    assert.ok(block.includes('setIsPanning(false);'), `${needle}: setIsPanning(false); が無い`);
    assert.ok(block.includes('return;'), `${needle}: return; が無い`);
    assert.ok(body.indexOf("if (appMode === 'ceiling') {") < body.indexOf(stop), `${needle}: ceiling 分岐が ${stop} より後ろにある`);
  }
});
