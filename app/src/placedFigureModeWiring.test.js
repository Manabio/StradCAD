// 図面モード（姿図配置モード）の配線不変条件。.jsx・フックは node:test から単体 import できないため、
// ソーステキストを走査して固定する（facadeModeWiring.test.js・ui/modeIcons.wiring.test.js と同じ流儀）。
// 検査はコメント（行頭・行末・ブロック）を除いた本体に対して行う（stripCommentsKeepStrings）。
// 文字列リテラルの中へ呼び出しを隠す変異を見逃さないよう、1 行まるごと／前後の文脈つきの正規表現で照合する。
// 設計意図は .claude/mode-system.md の「図面モード」の節。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAppSrc, stripCommentsKeepStrings, extractBalancedBody } from './uiBusySourceScan.js';
import { APP_MODES } from './core/centerLineKindPolicy.js';
import { PLACED_FIGURE_MODE_IDS } from './core/placedFigureModes.js';

const readSrc = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
const code = (rel) => stripCommentsKeepStrings(readSrc(rel));
const appCode = stripCommentsKeepStrings(readAppSrc());
const pointerCode = code('interaction/usePointerInteraction.js');

const count = (text, needle) => text.split(needle).length - 1;

/** `signature`（末尾が本体開始の `{`）の本体。無ければ失敗。 */
function bodyOf(src, signature, label) {
  assert.equal(count(src, signature), 1, `${label}: ${signature} がちょうど 1 つ`);
  return extractBalancedBody(src, signature);
}

const BRANCH = 'if (isPlacedFigureMode(appMode)) {';

/** ポインタの各ハンドラ本体の、図面モードの分岐（1 つだけ）。 */
function placedBranch(handlerSignature) {
  const body = bodyOf(pointerCode, handlerSignature, handlerSignature);
  return { body, branch: bodyOf(body, BRANCH, `${handlerSignature} の図面モードの分岐`) };
}

// ---- App.jsx ----

test('【配線】App.jsx: モード State の動的ロードは isPlacedFigureMode の分岐で PlacedFigureModeState を placedFigureModeOf(appMode) で作り、既定（敷地）の直前にある', () => {
  const start = appCode.indexOf("const loader = appMode === 'floorplan'");
  const end = appCode.indexOf('loader.then(', start);
  assert.ok(start >= 0 && end > start, 'ローダーの式が見つからない');
  const loader = appCode.slice(start, end);
  assert.equal(count(loader, 'isPlacedFigureMode(appMode)'), 1, '分岐はちょうど 1 つ');
  // 図面モードの分岐の直後が既定（SiteModeState）＝既定より前。抜けると敷地の State が黙って載る
  assert.match(loader,
    /:\s*isPlacedFigureMode\(appMode\)\s*\?\s*import\('\.\/modes\/PlacedFigureModeState\.js'\)\.then\(m => new m\.PlacedFigureModeState\(graph, placedFigureModeOf\(appMode\)\)\)\s*:\s*import\('\.\/modes\/SiteModeState\.js'\)/);
  assert.equal(count(loader, 'PlacedFigureModeState'), 2, '図面モードの State の生成は 1 か所（import パス＋new）');
  // 既定（敷地）は連鎖の末尾の 1 つだけで、図面モードの分岐より前に無い
  const SITE_IMPORT = "import('./modes/SiteModeState.js')";
  assert.equal(count(loader, SITE_IMPORT), 1, '敷地のローダーはちょうど 1 つ');
  assert.ok(loader.indexOf('isPlacedFigureMode(appMode)') < loader.indexOf(SITE_IMPORT), '図面モードの分岐が敷地の既定より前');
});

test('【配線】App.jsx: MODE_LOAD_LABELS の図面モード分は定義表から導く（表示名を重ねて書かない）', () => {
  const block = bodyOf(appCode, 'const MODE_LOAD_LABELS = Object.freeze({', 'MODE_LOAD_LABELS');
  assert.match(block, /^\s*\.\.\.Object\.fromEntries\(PLACED_FIGURE_MODE_IDS\.map\(id => \[id, placedFigureModeLabelOf\(id\)\]\)\),\s*$/m);
  assert.match(appCode, /^import \{ PLACED_FIGURE_MODE_IDS, isPlacedFigureMode, placedFigureModeOf, placedFigureModeLabelOf \} from '\.\/core\/placedFigureModes\.js';\s*$/m);
});

test('【配線】App.jsx: modeBoundaries に図面モードを登録しない（突入・脱出で graph を変える処理が無い）', () => {
  const registry = bodyOf(appCode, 'const modeBoundaries = {', 'modeBoundaries');
  assert.ok(!/isPlacedFigureMode|PLACED_FIGURE|placedFigure/i.test(registry), 'modeBoundaries が図面モードに触れている');
  assert.ok(!/plumbing/.test(registry));
});

test('【配線】App.jsx: カーソルは図面モードの配置待ち・移動待ちの間 crosshair、それ以外 default', () => {
  assert.match(appCode,
    /^\s*: isPlacedFigureMode\(appMode\) \? \(\(mode\?\.placingFigureKey != null \|\| mode\?\.movingFigureId != null\) \? 'crosshair' : 'default'\)\s*$/m);
  // 図面モードの行はパン中（isPanning）より後・建具より前
  const iPan = appCode.indexOf(": isPanning        ? 'grabbing'");
  const iPlaced = appCode.indexOf(': isPlacedFigureMode(appMode) ?');
  const iOpening = appCode.indexOf(": appMode === 'opening' ? ((nearOpening || nearWall)");
  assert.ok(iPan >= 0 && iPan < iPlaced && iPlaced < iOpening, 'パン中が勝つ・建具より前');
});

// ---- ModeBar・アイコン ----

test('【配線】ModeBar.jsx: 図面モードのボタンは PLACED_FIGURE_MODE_IDS から導く。手書き ∪ opening ∪ 図面モード ＝ APP_MODES（⊇ 図面モードの全 id）', () => {
  const bar = code('ui/ModeBar.jsx');
  assert.equal(count(bar, 'const MODES = ['), 1);
  const start = bar.indexOf('const MODES = [');
  const end = bar.indexOf('\n];', start);
  assert.ok(start >= 0 && end > start, 'MODES の配列が見つからない');
  const list = bar.slice(start, end);
  assert.match(list, /^\s*\.\.\.PLACED_FIGURE_MODE_IDS\.map\(id => \(\{ mode: id, label: placedFigureModeLabelOf\(id\) \}\)\),\s*$/m);
  assert.match(bar, /^import \{ PLACED_FIGURE_MODE_IDS, placedFigureModeLabelOf \} from '\.\.\/core\/placedFigureModes\.js';\s*$/m);
  const literal = [...list.matchAll(/mode:\s*'([a-z]+)'/g)].map(m => m[1]);
  assert.ok(literal.length >= 4, '手書きの mode 値を抽出できない');
  assert.ok(PLACED_FIGURE_MODE_IDS.length >= 1);
  assert.deepEqual([...new Set([...literal, 'opening', ...PLACED_FIGURE_MODE_IDS])].sort(), [...APP_MODES].sort());
  for (const id of PLACED_FIGURE_MODE_IDS) assert.ok(!literal.includes(id), `${id} を ModeBar に手書きしない`);
});

test('【配線】modeIcons.jsx: 表に無い図面モードは共通アイコン（rect＋circle）へ落ちる', () => {
  const icons = code('ui/modeIcons.jsx');
  assert.match(icons, /^import \{ isPlacedFigureMode \} from '\.\.\/core\/placedFigureModes\.js';\s*$/m);
  assert.match(icons, /^\s*const Icon = MODE_ICONS\[mode\] \?\? \(isPlacedFigureMode\(mode\) \? PlacedFigureIcon : null\);\s*$/m);
  const iStart = icons.indexOf('const PlacedFigureIcon = () => (');
  assert.ok(iStart >= 0, '共通アイコンの部品が見つからない');
  const svg = icons.slice(iStart, icons.indexOf('</svg>', iStart));
  assert.match(svg, /<rect x="3" y="3" width="18" height="18" \/>/);
  assert.match(svg, /<circle cx="12" cy="12" r="4" \/>/);
  assert.ok(!/PlacedFigureIcon/.test(bodyOf(icons, 'const MODE_ICONS = Object.freeze({', 'MODE_ICONS')), '表には載せない（モードごとに足さない）');
});

// ---- usePointerInteraction.js ----

test('【配線】usePointerInteraction.js: pointer down は図面モードの分岐が平面の既定（描画・移動・ガター長押し・長押し開始）より前で、押下の記録とガターのパンだけ', () => {
  const { body, branch } = placedBranch('const handlePointerDown = (e) => {');
  const iBranch = body.indexOf(BRANCH);
  for (const def of ['drawDownRef.current = { x: clientX, y: clientY };', 'gutterLongPress.begin(clientX, clientY);', 'axisLabelLongPress.begin(clientX, clientY);']) {
    const i = body.indexOf(def);
    assert.ok(i >= 0, `${def} が見つからない`);
    assert.ok(iBranch < i, `図面モードの分岐が ${def} より前`);
  }
  assert.ok(iBranch < body.lastIndexOf('longPress.begin(clientX, clientY);'), '最後の（平面の既定の）長押し開始より前');
  assert.match(branch, /^\s*placedFigureDownRef\.current = \{ x: clientX, y: clientY \};\s*$/m);
  assert.match(branch, /^\s*return;\s*$/m);
  assert.ok(!/longPress|updateSnap|startMove|startDraw|drawState|moveState/.test(branch), '図面モードの押下は長押し・スナップ・線の操作を呼ばない');
});

test('【配線】usePointerInteraction.js: pointer move は図面モードの分岐が平面の既定（ガター長押し・CL 移動・描画・スナップ）より前で、押下点から TAP の範囲を出たらパン開始', () => {
  const { body, branch } = placedBranch('const handlePointerMove = (e) => {');
  const iBranch = body.indexOf(BRANCH);
  for (const def of ['if (gutterCLRef.current) {', 'const ms = modeRef.current?.moveState;', 'updateSnap(clientX, clientY);']) {
    const i = body.indexOf(def);
    assert.ok(i >= 0, `${def} が見つからない`);
    assert.ok(iBranch < i, `図面モードの分岐が ${def} より前`);
  }
  assert.match(branch, /^\s*if \(drag\.current\) \{ panTo\(clientX, clientY\); return; \}\s*$/m);
  assert.match(branch, /^\s*if \(!isTapDistance\(Math\.hypot\(clientX - down\.x, clientY - down\.y\)\)\) startPanAt\(clientX, clientY\);\s*$/m);
  assert.ok(!/longPress|updateSnap|startMove|startDraw|drawState|moveState/.test(branch));
});

test('【配線】usePointerInteraction.js: pointer up は図面モードの分岐でタップのとき tapAt を placedFigureTapOptions（viewport.scaleX・CL_THRESHOLD_PX）つきで呼ぶ。平面の既定より前', () => {
  const { body, branch } = placedBranch('const handlePointerUp = (e) => {');
  const iBranch = body.indexOf(BRANCH);
  for (const def of ['const ms2 = modeRef.current?.moveState;', 'shouldFireBayTap(bayTapSignals)', 'completeDraw(']) {
    const i = body.indexOf(def);
    assert.ok(i >= 0, `${def} が見つからない`);
    assert.ok(iBranch < i, `図面モードの分岐が ${def} より前`);
  }
  assert.equal(count(branch, 'tapAt('), 1);
  assert.match(branch, /^\s*modeRef\.current\?\.tapAt\(world\.x, world\.y, placedFigureTapOptions\(viewport\.scaleX, CL_THRESHOLD_PX\)\);\s*$/m);
  // タップの条件: パン中でなく（releaseGesture が 'tap'）、押下点から TAP の範囲内
  assert.match(branch, /^\s*if \(releaseGesture\(\{ fired: false, panned: !!drag\.current \}\) === 'tap' && isTapDistance\(tapDist\)\) \{\s*$/m);
  assert.match(branch, /^\s*const world = viewport\.screenToWorld\(down\.x, down\.y\);\s*$/m);
  assert.match(branch, /^\s*placedFigureDownRef\.current = null;\s*$/m);
  // パンの後始末: drag を残すと、次に押さずに動かしただけで move の panTo が走る（ホバーで画面が動く）
  assert.match(branch, /^\s*drag\.current = null;\s*$/m);
  assert.match(branch, /^\s*setIsPanning\(false\);\s*$/m);
  assert.ok(!/longPress|updateSnap|startMove|startDraw|drawState|moveState/.test(branch));
  assert.match(pointerCode, /^import \{ placedFigureTapOptions \} from '\.\.\/renderer\/placedFigureHit\.js';\s*$/m);
  assert.match(pointerCode, /^import \{ isPlacedFigureMode \} from '\.\.\/core\/placedFigureModes\.js';\s*$/m);
});

test('【配線】usePointerInteraction.js: pointer leave・ホイール・中断（resetGestureRefs）が図面モードの押下記録とズームを扱う', () => {
  const { body: leaveBody, branch: leave } = placedBranch('const handlePointerLeave = () => {');
  assert.ok(leaveBody.indexOf(BRANCH) < leaveBody.lastIndexOf('if (openingDragRef.current) cancelOpeningDrag();'), '平面の既定より前');
  assert.match(leave, /^\s*placedFigureDownRef\.current = null;\s*$/m);
  assert.match(leave, /^\s*drag\.current = null;\s*$/m);
  assert.match(leave, /^\s*setIsPanning\(false\);\s*$/m);

  const wheel = bodyOf(pointerCode, 'const handleWheel = (e) => {', 'handleWheel');
  const iZoom = wheel.indexOf('viewport.zoomAt(e.evt.clientX, e.evt.clientY, factor);');
  const iSkip = wheel.indexOf('if (isPlacedFigureMode(appMode)) return;');
  const iSnap = wheel.indexOf('updateSnap(e.evt.clientX, e.evt.clientY);');
  assert.ok(iZoom >= 0 && iZoom < iSkip && iSkip < iSnap, 'ズームしてから、図面モードはスナップを作らず返す');

  const reset = bodyOf(pointerCode, 'function resetGestureRefs() {', 'resetGestureRefs');
  assert.match(reset, /^\s*placedFigureDownRef\.current = null;\s*$/m, 'ESC・関門で押下記録を戻す');
});

// ---- 描画レイヤ ----

test('【配線】SceneLayers.jsx: PlacedFiguresLayer に subjects（図面モードの分類）と selectedId（図面モードの選択）を渡す。述語は planFigureVisibility.js から', () => {
  const scene = code('renderer/SceneLayers.jsx');
  const i = scene.indexOf('<PlacedFiguresLayer ');
  assert.ok(i >= 0 && count(scene, '<PlacedFiguresLayer ') === 1, 'PlacedFiguresLayer の要素が 1 つ');
  const tag = scene.slice(i, scene.indexOf('/>', i));
  assert.ok(tag.includes('subjects={placedFigureSubjectsFor(appMode)}'), 'subjects を渡す');
  assert.ok(tag.includes('selectedId={showsPlacedFigureSelection(appMode) ? (mode?.selectedPlacedFigureId ?? null) : null}'), 'selectedId を渡す');
  assert.match(scene, /^\s*shouldShowPlacedFigures, shouldShowSiteBoundaryOverlay, placedFigureSubjectsFor, showsPlacedFigureSelection,\s*$/m);
});

test('【配線】PlacedFiguresLayer.jsx: subjects を描画計画へ渡し、計画のキャッシュ鍵に subjects を含める', () => {
  const layer = code('renderer/PlacedFiguresLayer.jsx');
  assert.match(layer, /\(\{ graph, viewport, direction = 'down', selectedId = null, subjects = null \}\) => \{/);
  assert.match(layer,
    /graphComputed\(graph, `placedFigures:\$\{direction\}:\$\{String\(subjects\)\}:\$\{overlayGeneration\(\)\}`, \(\) => placedFigureDrawPlan\(graph\.placedFigures, detailFigureEntry, \{ direction, subjects \}\)\);/);
});

// ---- ラチェット ----

function listSources(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listSources(p));
    else if (/\.(js|jsx)$/.test(ent.name) && !/\.test\.js$/.test(ent.name)) out.push(p);
  }
  return out;
}

test('【ラチェット】製品コードで引用符つきの \'plumbing\' が出てよいのは定義表の 1 行だけ（ほかは registry から導く）', () => {
  const hits = [];
  for (const file of listSources(import.meta.dirname)) {
    const n = [...stripCommentsKeepStrings(fs.readFileSync(file, 'utf8')).matchAll(/(['"`])plumbing\1/g)].length;
    if (n > 0) hits.push(`${path.relative(import.meta.dirname, file).replaceAll('\\', '/')}:${n}`);
  }
  assert.deepEqual(hits, ['core/constants.js:1']);
});
