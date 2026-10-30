// 立面モード（appMode 'facade'）の配線不変条件（S1b）。.jsx は node:test から単体 import できないため
// ソーステキスト検査で固定する。1行まるごと一致（m フラグの行頭・行末アンカー）で照合し、行コメントは
// 落としてから検査する（コメント文への誤マッチで変異を見逃さない）。App.jsx の走査は
// uiBusySourceScan.js の共用関数を使う（ceilingModeWiring.test.js と同じ流儀）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAppSrc, stripCommentLines, extractArrowFunctionBody, extractFunctionBody } from './uiBusySourceScan.js';

const readSrc = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
const appCode = stripCommentLines(readAppSrc());
const pointerCode = stripCommentLines(readSrc('interaction/usePointerInteraction.js'));

/** 本体の中の `if (appMode === 'facade') {` の分岐ブロック（波括弧の対応で切り出す。1つだけのはず）。 */
function facadeBranch(body, label) {
  const needle = "if (appMode === 'facade') {";
  assert.equal(body.split(needle).length - 1, 1, `${label} に facade の分岐がちょうど1つ`);
  return extractArrowFunctionBody(body, needle);
}

test('【配線】App.jsx: facade のローダーは FacadeModeState を展開と同じ引数（graph, project, size, screenPxPerMm）で new して await s.init() してから返す', () => {
  assert.match(appCode, /^\s*: appMode === 'facade'\s*$/m);
  assert.match(appCode, /^\s*\? import\('\.\/modes\/FacadeModeState\.js'\)\.then\(async m => \{\s*$/m);
  const start = appCode.indexOf("import('./modes/FacadeModeState.js')");
  assert.ok(start >= 0, 'FacadeModeState のローダーが見つからない');
  const block = appCode.slice(start, appCode.indexOf('})', start));
  assert.match(block, /^\s*const screenPxPerMm = \(viewport\.pxPerMmX \+ viewport\.pxPerMmY\) \/ 2;\s*$/m);
  assert.match(block, /^\s*const s = new m\.FacadeModeState\(graph, project, size, screenPxPerMm\);\s*$/m);
  assert.match(block, /^\s*await s\.init\(\);/m);
  assert.match(block, /^\s*return s;\s*$/m);
});

test('【配線】App.jsx: modeBoundaries の facade: は enter（全階の壁の鮮度判定）だけで exit を持たない', () => {
  const start = appCode.indexOf('const modeBoundaries = {');
  assert.ok(start >= 0, 'const modeBoundaries = { が見つからない');
  const end = appCode.indexOf('\n  };', start);
  assert.ok(end > start, 'modeBoundaries の閉じが見つからない');
  const registry = appCode.slice(start, end);
  const fStart = registry.search(/^\s*facade: \{\s*$/m);
  assert.ok(fStart >= 0, 'modeBoundaries に facade: が無い');
  const facadeBlock = extractArrowFunctionBody(registry.slice(fStart), 'facade: {');
  assert.match(facadeBlock, /^\s*enter: \(\) => refreshWallsForFacadeEntry\(project, \{ saveActiveFloorFn: saveFloor \}\),\s*$/m);
  assert.ok(!/exit:/.test(facadeBlock), 'facade: は exit を持たない（表示専用）');
  assert.ok(!/deferEnterOnModeChange/.test(facadeBlock), 'facade: の突入は関門の中で完了を待つ');
  assert.ok(!/refreshWallsForViewEntry/.test(facadeBlock), '立面は自階と直上・直下ではなく全階');
  assert.match(appCode, /^import \{ refreshWallsAllFloors, refreshWallsForViewEntry, refreshWallsForFacadeEntry \} from '\.\/wallRefresh\.js';\s*$/m);
});

test('【配線】App.jsx: モード名表・カーソル・ScaleIndicator・階設定表の確定での作り直しに facade がある', () => {
  assert.match(appCode, /^\s*floorplan: '平面', finish: '仕上げ', ceiling: '天伏', structure: '構造', opening: '建具', elevation: '展開', facade: '立面', site: '敷地',\s*$/m);
  assert.match(appCode, /^\s*: appMode === 'facade' \? 'grab'\s*$/m);
  assert.match(appCode, /^\s*\{appMode !== 'elevation' && appMode !== 'facade' && <ScaleIndicator width=\{size\.width\} height=\{size\.height\} \/>\}\s*$/m);
  const body = extractFunctionBody(readAppSrc(), 'async function rebuildFiguresAfterHeights');
  assert.match(body, /^\s*if \(m === 'elevation' \|\| m === 'ceiling' \|\| m === 'facade'\) setCatalogReloadKey\(k => k \+ 1\);\s*$/m);
});

test('【配線】SceneLayers.jsx: facade は平面レイヤー群より前に早期 return して FacadeLayer だけを描く', () => {
  const code = stripCommentLines(readSrc('renderer/SceneLayers.jsx'));
  assert.match(code, /^import \{ FacadeLayer \} from '\.\/FacadeLayer\.jsx';\s*$/m);
  const branch = facadeBranch(code, 'SceneLayers');
  assert.match(branch, /^\s*<Layer name="facade">\s*$/m);
  assert.match(branch, /^\s*<FacadeLayer mode=\{mode\} size=\{size\} \/>\s*$/m);
  assert.match(branch, /^\s*return \(\s*$/m);
  const iFacade = code.indexOf("if (appMode === 'facade') {");
  const iPlan = code.indexOf('const showPlanFigure = shouldShowPlanFigure(appMode);');
  assert.ok(iPlan >= 0 && iFacade < iPlan, '早期 return は平面レイヤー群の組み立てより前');
});

test('【配線】ModeBar.jsx: 「立面」は展開の後ろ（最後）', () => {
  const code = stripCommentLines(readSrc('ui/ModeBar.jsx'));
  assert.match(code, /^\s*\{ mode: 'elevation', label: '展開' \},\r?\n\s*\{ mode: 'facade', {4}label: '立面' \},\r?\n\];\s*$/m);
});

test('【配線】usePointerInteraction.js: facade は縦スクロールだけ（ホイール・ドラッグ）。建具ヒット・スナップ・パン・長押しは通らない', () => {
  const wheel = facadeBranch(extractArrowFunctionBody(pointerCode, 'const handleWheel = (e) => {'), 'handleWheel');
  assert.match(wheel, /^\s*if \(scale > 0\) modeRef\.current\?\.scrollBy\(-e\.evt\.deltaY \/ scale\);\s*$/m);
  assert.match(wheel, /^\s*return;\s*$/m);

  const down = facadeBranch(extractArrowFunctionBody(pointerCode, 'const handlePointerDown = (e) => {'), 'handlePointerDown');
  assert.match(down, /^\s*facadeDragRef\.current = \{ y: clientY, started: false \};\s*$/m);
  assert.match(down, /^\s*return;\s*$/m);

  const move = facadeBranch(extractArrowFunctionBody(pointerCode, 'const handlePointerMove = (e) => {'), 'handlePointerMove');
  assert.match(move, /^\s*if \(Math\.abs\(dy\) < TAP_MOVE_PX\) return;\s*$/m);
  assert.match(move, /^\s*if \(scale > 0\) modeRef\.current\?\.scrollBy\(dy \/ scale\);\s*$/m);

  const up = facadeBranch(extractArrowFunctionBody(pointerCode, 'const handlePointerUp = (e) => {'), 'handlePointerUp');
  const leave = facadeBranch(extractArrowFunctionBody(pointerCode, 'const handlePointerLeave = () => {'), 'handlePointerLeave');
  for (const [label, b] of [['up', up], ['leave', leave]]) {
    assert.match(b, /^\s*facadeDragRef\.current = null;\s*$/m, label);
    assert.match(b, /^\s*setIsPanning\(false\);\s*$/m, label);
  }
  const touchMove = extractArrowFunctionBody(pointerCode, 'const handleTouchMove = (e) => {');
  assert.match(touchMove, /^\s*if \(appMode === 'facade'\) \{ e\.evt\.preventDefault\(\); return; \}\s*$/m, 'ピンチを封じる');

  for (const [label, b] of [['wheel', wheel], ['down', down], ['move', move], ['up', up], ['leave', leave]]) {
    assert.ok(!/longPress|updateSnap|panTo|HitAtTarget|startOpeningDrag|viewport\.(pan|zoomAt)/.test(b), `${label}: 立面の分岐が平面の操作を呼んでいる`);
  }
  const reset = extractFunctionBody(pointerCode, 'function resetGestureRefs');
  assert.match(reset, /^\s*facadeDragRef\.current = null;\s*$/m, 'ESC・関門で押下記録を戻す');
});

test('【配線】wallRefresh.js: refreshWallsForFacadeEntry は planeIds: null（全階）で refreshWallsAllFloors を呼ぶ', () => {
  const code = stripCommentLines(readSrc('wallRefresh.js'));
  const body = extractFunctionBody(code, 'export async function refreshWallsForFacadeEntry');
  assert.match(body, /^\s*return refreshWallsAllFloors\(project, \{\s*$/m);
  assert.match(body, /^\s*planeIds: null, saveActiveFloorFn,\s*$/m);
  assert.match(body, /^\s*pushUndo: true, pushActiveStructuralUndo: true,\s*$/m);
  assert.ok(!/viewNeighborPlaneIds/.test(body));
});
