// 天伏モード（appMode 'ceiling'）の配線不変条件（S1a'・S2）。.jsx は node:test から単体 import できないため
// ソーステキスト検査で固定する。1行まるごと一致（m フラグの行頭・行末アンカー）で照合し、行コメントは
// 落としてから検査する（コメント文への誤マッチで変異を見逃さない）。App.jsx の走査は
// uiBusySourceScan.js の共用関数を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAppSrc, stripCommentLines, extractArrowFunctionBody, extractFunctionBody } from './uiBusySourceScan.js';

const readSrc = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
const appCode = stripCommentLines(readAppSrc());

test('【配線】App.jsx: ceiling のローダーは CeilingModeState を new して await s.init() してから返す（材データのロード。finish と同型）', () => {
  assert.match(appCode,
    /^\s*\? import\('\.\/modes\/CeilingModeState\.js'\)\.then\(async m => \{\s*$/m);
  const start = appCode.indexOf("import('./modes/CeilingModeState.js')");
  assert.ok(start >= 0, 'CeilingModeState のローダーが見つからない');
  const block = appCode.slice(start, appCode.indexOf('})', start));
  assert.match(block, /^\s*const s = new m\.CeilingModeState\(\);\s*$/m);
  assert.match(block, /^\s*await s\.init\(\);/m);
  assert.match(block, /^\s*return s;\s*$/m);
  assert.match(appCode, /^\s*: appMode === 'ceiling'\s*$/m);
});

test('【配線】App.jsx: CeilingPanel は appMode === ceiling && mode のときだけマウントし、graph/mode/isLandscape と階高 floorHeight（仕上げ表と同じ floorHeightAbove）を渡す', () => {
  assert.match(appCode, /^\s*\{appMode === 'ceiling' && mode && \(\s*$/m);
  assert.match(appCode, /^\s*<CeilingPanel graph=\{graph\} mode=\{mode\} isLandscape=\{isLandscape\} floorHeight=\{floorHeightAbove\(project, project\.activePlane\)\} \/>\s*$/m);
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
  assert.match(code, /^\s*const rows = mode\.activeTab === 'stair' \? stairRows\(graph, mode\.materialMap\) : interiorRows\(graph, mode\.materialMap\);\s*$/m);
  assert.match(code, /^\s*onClick=\{\(\) => \{ if \(row\.kind === 'room'\) mode\.selectRoom\(row\.id\); \}\}\s*$/m);
  assert.match(code, /<ModePanel title="天伏" /);
  assert.match(code, /<BottomSheet title="天伏" /);
  // S3 で材選択の部品 MaterialSelect だけは仕上げ表から共用する（旧: FinishTable 全般を禁止）。表本体・State は引かない。
  assert.ok(!/FinishModeState|<FinishTable\b/.test(code), 'CeilingPanel が FinishModeState／仕上げ表本体を引いている');
  const finishTableImports = code.split(/\r?\n/).filter(l => /^import .* from '.*FinishTable/.test(l));
  assert.deepEqual(finishTableImports, ["import { MaterialSelect } from '../finish/FinishTable.jsx';"]);
});

test('【配線】CeilingPanel.jsx: 天井材・仕上げの MaterialSelect 2つ（panel／finish）が setOverride／clearOverride を withFinishUndo で包んで部屋に書く。書込み先は ceilingWriteTargetRoom', () => {
  const code = stripCommentLines(readSrc('ceiling/CeilingPanel.jsx'));
  assert.match(code, /^\s*\{ key: 'ceilingPanel', {2}label: '天井材', category: 'panel' \},\s*$/m);
  assert.match(code, /^\s*\{ key: 'ceilingFinish', label: '仕上げ', category: 'finish' \},\s*$/m);
  assert.match(code, /^\s*onChange=\{v => withFinishUndo\(graph, \(\) => \(v === '' \? room\.clearOverride\(f\.key\) : room\.setOverride\(f\.key, v\)\)\)\}\s*$/m);
  assert.match(code, /^\s*<CeilingMaterialFields graph=\{graph\} mode=\{mode\} room=\{ceilingWriteTargetRoom\(graph, mode\.selection\)\} \/>\s*$/m);
  assert.match(code, /^\s*\{mode\.selection && \(\s*$/m);
  assert.match(code, /^import \{ withFinishUndo \} from '\.\.\/finish\/finishUndo\.js';\s*$/m);
});

test('【配線】CeilingPanel.jsx: 部屋の無い階段（room が null）では天井材・仕上げの select は disabled で「—」の1択', () => {
  const code = stripCommentLines(readSrc('ceiling/CeilingPanel.jsx'));
  assert.match(code, /^\s*<select disabled value="" style=\{\{ flex: 1, minWidth: 0 \}\} title="部屋の無い階段には天井材・仕上げを指定できません">\s*$/m);
  assert.match(code, /^\s*<option value="">—<\/option>\s*$/m);
});

test('【配線】FinishTable.jsx: INTERIOR_FIELDS の天井グループは 天井材(panel)・仕上げ(finish)・H・周り縁 の4列で、旧 ceilingMaterial を持たない', () => {
  const code = stripCommentLines(readSrc('finish/FinishTable.jsx'));
  assert.match(code, /^\s*\{ key: 'ceilingPanel',\s+label: '天井材',\s+group: '天井', groupSpan: 4, kind: 'material', category: 'panel',\s+source: 'master' \},\s*$/m);
  assert.match(code, /^\s*\{ key: 'ceilingFinish',\s+label: '仕上げ',\s+group: null,\s+groupSpan: 0, kind: 'material', category: 'finish', source: 'master' \},\s*$/m);
  assert.match(code, /^\s*\{ key: 'ceilingHeight',\s+label: 'H',/m);
  assert.match(code, /^\s*\{ key: 'cornice',\s+label: '周り縁',/m);
  assert.ok(!/ceilingMaterial/.test(code), 'FinishTable.jsx に旧 ceilingMaterial が残っている');
  assert.match(code, /^\s*\['ceilingPanel', 'ceilingFinish'\],\s*$/m);
});

// ---- usePointerInteraction.js: 天伏はガター内パン・ピンチ＋天井セルのドラッグ選択（S2）----
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

test('【配線】usePointerInteraction: pointerDown の ceiling 分岐はガター内ならパン、それ以外は ref を立てて startDrag し、findGutterCL( と longPress.begin( より前で return する', () => {
  const body = extractArrowFunctionBody(pointerSrc, 'const handlePointerDown = (e) => {');
  const block = ceilingBlock(body);
  for (const line of [
    'const inGutter = isInGutter(clientX, clientY, size.width, size.height);',
    'drag.current = { lastX: clientX, lastY: clientY };',
    'setIsPanning(true);',
    'ceilingDragDownRef.current = { x: clientX, y: clientY };',
    'modeRef.current?.startDrag(graph, world.x, world.y);',
    'return;',
  ]) assert.ok(block.includes(line), `down: ${line} が無い`);
  assert.ok(block.indexOf('ceilingDragDownRef.current = { x: clientX, y: clientY };') < block.indexOf('modeRef.current?.startDrag(graph, world.x, world.y);'));
  const i = body.indexOf("if (appMode === 'ceiling') {");
  assert.ok(i < body.indexOf('findGutterCL('), 'ceiling 分岐が findGutterCL( より後ろにある');
  assert.ok(i < body.indexOf('longPress.begin('), 'ceiling 分岐が longPress.begin( より後ろにある');
});

test('【配線】usePointerInteraction: pointerMove の ceiling 分岐はパン維持／ドラッグ中だけ updateDrag（サンプル間隔 4px）して return（updateSnap・移動/描画に落ちない）', () => {
  const body = extractArrowFunctionBody(pointerSrc, 'const handlePointerMove = (e) => {');
  const block = ceilingBlock(body);
  for (const line of [
    'viewport.pan(dx, dy);',
    'if (ceilingDragDownRef.current && modeRef.current?.dragState) {',
    'modeRef.current?.updateDrag(graph, world.x, world.y, CEILING_DRAG_SAMPLE_PX / viewport.scaleX);',
    'return;',
  ]) assert.ok(block.includes(line), `move: ${line} が無い`);
  assert.match(pointerSrc, /^const CEILING_DRAG_SAMPLE_PX = 4;\s*$/m);
  const i = body.indexOf("if (appMode === 'ceiling') {");
  assert.ok(i < body.indexOf('updateSnap('), 'ceiling 分岐が updateSnap( より後ろにある');
  assert.ok(i < body.indexOf('longPress.move('), 'ceiling 分岐が longPress.move( より後ろにある');
});

test('【配線】usePointerInteraction: pointerUp の ceiling 分岐は tapDist<8 で commitDrag してから ref を戻し、パンを解除して return（メニュー・選択に落ちない）', () => {
  const body = extractArrowFunctionBody(pointerSrc, 'const handlePointerUp = (e) => {');
  const block = ceilingBlock(body);
  const commit = block.indexOf('modeRef.current?.commitDrag({ tap: tapDist < 8 });');
  const reset = block.indexOf('ceilingDragDownRef.current = null;');
  const gate = block.indexOf('if (ceilingDragDownRef.current) {');
  assert.ok(gate >= 0 && gate < commit, 'up: if (ceilingDragDownRef.current) { が commitDrag より前に無い');
  assert.ok(commit >= 0, 'up: commitDrag({ tap: tapDist < 8 }) が無い');
  assert.ok(reset > commit, 'up: ref を戻すのが commitDrag より前にある（または無い）');
  for (const line of ['drag.current = null;', 'setIsPanning(false);', 'return;']) {
    assert.ok(block.includes(line), `up: ${line} が無い`);
  }
  assert.ok(body.indexOf("if (appMode === 'ceiling') {") < body.indexOf('commitCLMove('), 'ceiling 分岐が commitCLMove( より後ろにある');
});

test('【配線】usePointerInteraction: pointerLeave の ceiling 分岐は cancelDrag して ref とパンを戻し return。resetGestureRefs も ref を戻す', () => {
  const body = extractArrowFunctionBody(pointerSrc, 'const handlePointerLeave = () => {');
  const block = ceilingBlock(body);
  for (const line of [
    'modeRef.current?.cancelDrag();',
    'ceilingDragDownRef.current = null;',
    'drag.current = null;',
    'setIsPanning(false);',
    'return;',
  ]) assert.ok(block.includes(line), `leave: ${line} が無い`);
  assert.ok(body.indexOf("if (appMode === 'ceiling') {") < body.indexOf('longPress.abort('), 'ceiling 分岐が longPress.abort( より後ろにある');
  const reset = extractFunctionBody(pointerSrc, 'function resetGestureRefs');
  assert.match(reset, /^\s*ceilingDragDownRef\.current = null;\s*$/m);
});

test('【配線】SceneLayers: CeilingSelectionLayer は ceiling のときだけ、平面の線（ShapesLayer）より下にマウントし、mode の選択とプレビューを渡す', () => {
  const code = stripCommentLines(readSrc('renderer/SceneLayers.jsx'));
  assert.match(code, /^import \{ CeilingSelectionLayer \} from '\.\.\/ceiling\/CeilingSelectionLayer\.jsx';\s*$/m);
  const gate = code.search(/^\s*\{appMode === 'ceiling' && mode && \(\s*$/m);
  assert.ok(gate >= 0, "{appMode === 'ceiling' && mode && ( が無い");
  assert.match(code,
    /^\s*<CeilingSelectionLayer graph=\{graph\} viewport=\{viewport\} selectedCellKeys=\{mode\.selectedCellKeys\} previewCells=\{mode\.previewCells\} \/>\s*$/m);
  assert.ok(gate < code.indexOf('<ShapesLayer'), 'CeilingSelectionLayer が ShapesLayer より後ろにある');
});

test('【配線】CeilingPanel.jsx: 選択の要約は selectionSummary(graph, mode.selection)、行の強調は selectedRoomId との一致（階段の行も）', () => {
  const code = stripCommentLines(readSrc('ceiling/CeilingPanel.jsx'));
  assert.match(code, /^\s*const summary = selectionSummary\(graph, mode\.selection\);\s*$/m);
  assert.match(code, /^\s*background: row\.id === mode\.selectedRoomId \? '#eff6ff' : '#fff',\s*$/m);
});
