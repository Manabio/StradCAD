// ヘルパー画面の「プレビュー上の矩形で成分を絞る」（S7c-2）の配線を固定する不変条件テスト
// （detailHelperDxfWiring.test.js と同型——コメントを除いたソース本体の正規表現検査＋検出力）。純ロジックは ui/detailHelperPick.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentsKeepStrings as stripComments, topLevelBlock } from '../uiBusySourceScan.js';

const appSrc = path.resolve(import.meta.dirname, '..');
const readSrc = rel => fs.readFileSync(path.join(appSrc, rel), 'utf8');

// ---- 判定（本体文字列 → 真偽。検出力テストにも同じ関数を渡す）----
// ジェスチャー層（S7d-2 で PickLayer から置き換え）は図読込み・ペン入力の両タブで渡す。矩形を引けるのは図読込みで scene があるときだけ（canPick）。
const overlayGivenBothTabs = src => /overlay=\{\(t, info\) => \(\s*<FigureGestureLayer t=\{t\} info=\{info\}[\s\S]*?canPick=\{showDxf && !!imported\?\.scene\}/.test(src);
// 層には AutoScaledFigure が描画に使った t をそのまま渡す（変換を作り直さない）。
const overlayPassesFigureTransform = src => /overlay=\{\(t, info\) => \(\s*<FigureGestureLayer t=\{t\}/.test(src) && !/makeTransform\(/.test(src);
// 層の中の関数（2 スペース字下げの function 宣言。次の「\n  }\n」まで）。
const innerFn = (body, name) => {
  const s = body?.indexOf(`  function ${name}(`) ?? -1;
  if (s < 0) return null;
  const e = body.indexOf('\n  }\n', s);
  return e < 0 ? null : body.slice(s, e + 5);
};
// ドラッグ中（onPointerMove）は部品内 state と svg の CSS だけ動かし、親の state（重いプレビューの再描画）を触らない。
const moveTouchesOnlyLocalState = body => {
  const h = innerFn(body, 'onPointerMove');
  return h !== null && /setLive\(/.test(h) && /style\.transform =/.test(h)
    && !/setPickRect|setDxf|setPdf|setDoc|setImportView|setDraftView|onPick|onView/.test(h);
};
// 離したとき（onPointerEnd）にだけ onPick／onView を呼ぶ。取り消し（commit=false）は確定しない。
const endCommitsOnlyOnRelease = body => {
  const h = innerFn(body, 'onPointerEnd');
  if (h === null) return false;
  const cancel = /if \(!commit\) \{([^}]*)\}/.exec(h)?.[1] ?? 'onView(';
  return /pickRectFromDrag\(/.test(h) && /onPick\(rect\)/.test(h) && /onView\(panView\(/.test(h) && /onView\(pinchView\(/.test(h)
    && !/onPick|onView/.test(cancel);
};
// 枠は pickOverlayStyle で描き、PDF の範囲と同じ見た目（dthlp-pdf-clip）を流用する。
const framesViaPickOverlayStyle = body => !!body && /pickOverlayStyle\(live \?\? pickRect, t\)/.test(body) && /className="dthlp-pdf-clip"/.test(body);
// 一覧は pickedComponentRows を通し、「矩形を解除」は onClearPick を呼ぶ。
const listGoesThroughPick = body => !!body && /pickedComponentRows\(state, dxfComponentRows\(state\)\)/.test(body);
const clearButtonCallsHandler = body => !!body && /onClick=\{onClearPick\}[^>]*>\{DETAIL_HELPER_TEXT\.pickClear\}/.test(body);
// 解除ハンドラは DXF・PDF それぞれの state に clearPickRect を当てる。
const clearWiredForBoth = src => /onClearPick=\{\(\) => setPdf\(p => clearPickRect\(p\)\)\}/.test(src) && /onClearPick=\{\(\) => setDxf\(d => clearPickRect\(d\)\)\}/.test(src);
// 矩形の確定は pdf があれば pdf、なければ dxf の state へ setPickRect。
const pickWiredForBoth = src => /onPick=\{r => \(pdf \? setPdf\(p => setPickRect\(p, r\)\) : setDxf\(d => setPickRect\(d, r\)\)\)\}/.test(src);
// AutoScaledFigure: overlay?.(t, …) は relative の div の中（EditableDimLabel の前・return の前）で呼び、変換は 1 回だけ作る
// （寸法ラベルを層より上に置いてクリックを受けるため。S7d-1 で順序を後→前へ改めた）。
const figureCallsOverlayInsideRelativeDiv = src => {
  const rel = src.indexOf('position: \'relative\'');
  const ed = src.indexOf('<EditableDimLabel');
  const ov = src.indexOf('overlay?.(t,');
  const close = src.indexOf('</div>\n  );', ed);
  return rel >= 0 && ov > rel && ed > ov && close > ed && (src.match(/makeTransform\(/g) ?? []).length === 1; // import は括弧なしなので呼び出しだけ数える
};

// 矩形の枠は今有効な矩形（imported＝pdf ?? dxf。図読込みタブのときだけ）から作る。
const passesActiveRectOfImported = src => /const pickRectNow = showDxf \? activePickRect\(imported\) : null;/.test(src) && /pickRect=\{pickRectNow\}/.test(src);
// 押下: busy なら受けず、ポインタを捕捉し、画面の点→mm は層自身の矩形（currentTarget）で換算する。
const downGuardsBusyAndCaptures = body => {
  const h = innerFn(body, 'onPointerDown');
  return h !== null && /if \(busy\b[^\n]*\) return;/.test(h) && /e\.currentTarget\.setPointerCapture\(e\.pointerId\)/.test(h)
    && /const rect = e\.currentTarget\.getBoundingClientRect\(\);/.test(h) && /figurePointToMm\(e, rect, t\)/.test(h);
};
// 離した指が進行中の操作の指のときだけ扱う（Move は押下と同じ pointerId の指だけ、End は押している指だけ）。
const matchesPointerId = body => {
  const move = innerFn(body, 'onPointerMove') ?? '';
  const end = innerFn(body, 'onPointerEnd') ?? '';
  return /const p = pointers\.current\.get\(e\.pointerId\);\s*if \(!p\) return;/.test(move) && /e\.pointerId === g\.id/.test(move)
    && /const p = pointers\.current\.get\(e\.pointerId\);\s*if \(!p\) return;/.test(end) && /g\.id === e\.pointerId \|\| g\.ids\?\.includes\(e\.pointerId\)/.test(end);
};
// 一覧の上に操作のヒントと件数を出す。
const importResultShowsHintAndSummary = body => !!body && /DETAIL_HELPER_TEXT\.pickHint/.test(body) && /pickSummaryOf\(state\)/.test(body);

const panel = () => stripComments(readSrc('ui/DetailHelperPanel.jsx'));
const pickLayerBody = () => topLevelBlock(panel(), 'function FigureGestureLayer(');
const importResultBody = () => topLevelBlock(panel(), 'function ImportResult(');

test('【配線】overlay は両タブでジェスチャー層を渡し、t は図の描画と同じ変換を受け取る', () => {
  assert.ok(overlayGivenBothTabs(panel()));
  assert.ok(overlayPassesFigureTransform(panel()));
  assert.ok(passesActiveRectOfImported(panel()));
});

test('【配線】FigureGestureLayer: 押下は busy で受けずポインタ捕捉・換算は currentTarget・pointerId が一致する指だけ扱う', () => {
  const body = pickLayerBody();
  assert.ok(downGuardsBusyAndCaptures(body), body);
  assert.ok(matchesPointerId(body), body);
});

test('【配線】ImportResult: ヒントと件数の行を出す', () => {
  assert.ok(importResultShowsHintAndSummary(importResultBody()));
});

test('【検出力】追加の判定は壊れた文字列を落とす', () => {
  const rectOk = 'const pickRectNow = showDxf ? activePickRect(imported) : null; <L pickRect={pickRectNow} />';
  assert.equal(passesActiveRectOfImported(rectOk), true);
  assert.equal(passesActiveRectOfImported(rectOk.replace('activePickRect(imported)', 'activePickRect(dxf)')), false);
  assert.equal(passesActiveRectOfImported(rectOk.replace('pickRect={pickRectNow}', 'pickRect={null}')), false);
  const downOk = '  function onPointerDown(e) {\n    if (busy || x) return;\n    e.currentTarget.setPointerCapture(e.pointerId);\n    const rect = e.currentTarget.getBoundingClientRect();\n    g = figurePointToMm(e, rect, t);\n  }\n';
  assert.equal(downGuardsBusyAndCaptures(downOk), true);
  assert.equal(downGuardsBusyAndCaptures(downOk.replace('if (busy || x) return;', '')), false);
  assert.equal(downGuardsBusyAndCaptures(downOk.replace('e.currentTarget.setPointerCapture', 'e.setPointerCapture')), false);
  assert.equal(downGuardsBusyAndCaptures(downOk.replace('e.currentTarget.getBoundingClientRect()', 'e.target.getBoundingClientRect()')), false);
  assert.equal(downGuardsBusyAndCaptures(downOk.replace('figurePointToMm(e, rect, t)', 'figurePointToMm(e, document.body.getBoundingClientRect(), t)')), false);
  const idOk = '  function onPointerMove(e) {\n    const p = pointers.current.get(e.pointerId);\n    if (!p) return;\n    if (e.pointerId === g.id) go();\n  }\n'
    + '  function onPointerEnd(e, commit) {\n    const p = pointers.current.get(e.pointerId);\n    if (!p) return;\n    const mine = g && (g.id === e.pointerId || g.ids?.includes(e.pointerId));\n  }\n';
  assert.equal(matchesPointerId(idOk), true);
  assert.equal(matchesPointerId(idOk.replace('e.pointerId === g.id', 'true')), false);
  assert.equal(matchesPointerId(idOk.replace('g.id === e.pointerId || g.ids?.includes(e.pointerId)', 'true')), false);
  assert.equal(matchesPointerId(idOk.replace('if (!p) return;', '')), false);
  assert.equal(importResultShowsHintAndSummary('{DETAIL_HELPER_TEXT.pickHint} pickSummaryOf(state)'), true);
  assert.equal(importResultShowsHintAndSummary('pickSummaryOf(state)'), false);
  assert.equal(importResultShowsHintAndSummary('{DETAIL_HELPER_TEXT.pickHint}'), false);
});

test('【配線】FigureGestureLayer: 移動中は部品内 state と svg の CSS だけ・離したときだけ onPick／onView・枠は pickOverlayStyle', () => {
  const body = pickLayerBody();
  assert.ok(body, 'FigureGestureLayer が見つからない');
  assert.ok(moveTouchesOnlyLocalState(body), body);
  assert.ok(endCommitsOnlyOnRelease(body), body);
  assert.ok(framesViaPickOverlayStyle(body), body);
});

test('【配線】ImportResult: 一覧は pickedComponentRows を通し、「矩形を解除」は onClearPick。DXF・PDF の両方に配線', () => {
  const body = importResultBody();
  assert.ok(body, 'ImportResult が見つからない');
  assert.ok(listGoesThroughPick(body), body);
  assert.ok(clearButtonCallsHandler(body), body);
  assert.ok(clearWiredForBoth(panel()));
  assert.ok(pickWiredForBoth(panel()));
});

test('【配線】AutoScaledFigure: overlay?.(t, …) を relative の div の中で呼び、変換は 1 回だけ作る', () => {
  assert.ok(figureCallsOverlayInsideRelativeDiv(stripComments(readSrc('structural/sectionFigure/AutoScaledFigure.jsx'))));
});

test('【検出力】判定は壊れた配線を落とす（overlay を常に渡す・移動で親 state を触る・pickedComponentRows を通さない・解除を外す・変換の作り直し）', () => {
  const ovOk = 'overlay={(t, info) => (\n <FigureGestureLayer t={t} info={info} view={v} canPick={showDxf && !!imported?.scene} />\n )}';
  assert.equal(overlayGivenBothTabs(ovOk), true);
  assert.equal(overlayGivenBothTabs('overlay={showDxf ? (t, info) => <FigureGestureLayer t={t} info={info} /> : undefined}'), false);
  assert.equal(overlayGivenBothTabs(ovOk.replace('canPick={showDxf && !!imported?.scene}', 'canPick')), false);
  assert.equal(overlayPassesFigureTransform(ovOk), true);
  assert.equal(overlayPassesFigureTransform(ovOk.replace('t={t}', 't={makeTransform(b, s)}')), false);

  const move = inner => `  function onPointerMove(e) {\n${inner}\n  }\n`;
  const moveOk = 'if (a) setLive(f(e)); else svgRef.current.style.transform = `x`;';
  assert.equal(moveTouchesOnlyLocalState(move(moveOk)), true);
  assert.equal(moveTouchesOnlyLocalState(move(`${moveOk} setDxf(g);`)), false);
  assert.equal(moveTouchesOnlyLocalState(move(`${moveOk} onPick(r);`)), false);
  assert.equal(moveTouchesOnlyLocalState(move(`${moveOk} onView(v);`)), false);
  assert.equal(moveTouchesOnlyLocalState(move(`${moveOk} setImportView(v);`)), false);
  assert.equal(moveTouchesOnlyLocalState(move('setLive(f(e));')), false); // svg の CSS が無い
  assert.equal(moveTouchesOnlyLocalState('なし'), false);

  const end = inner => `  function onPointerEnd(e, commit) {\n${inner}\n  }\n`;
  const endOk = 'if (!commit) { setLive(null); endDragStyle(v); }\nelse if (r) { const rect = pickRectFromDrag(a, b); if (rect) onPick(rect); }\nelse if (p) onView(panView(1));\nelse if (q) onView(pinchView(1));';
  assert.equal(endCommitsOnlyOnRelease(end(endOk)), true);
  assert.equal(endCommitsOnlyOnRelease(end(endOk.replace('onPick(rect)', 'onPick(clipFromDrag(a, b))'))), false);
  assert.equal(endCommitsOnlyOnRelease(end(endOk.replace('{ setLive(null); endDragStyle(v); }', '{ setLive(null); onView(null); }'))), false); // 取り消しで確定する
  assert.equal(endCommitsOnlyOnRelease(end(endOk.replace('onView(panView(1))', 'noop()'))), false);

  assert.equal(framesViaPickOverlayStyle('const s = pickOverlayStyle(live ?? pickRect, t); <div className="dthlp-pdf-clip" />'), true);
  assert.equal(framesViaPickOverlayStyle('const s = pickOverlayStyle(pickRect, t); <div className="dthlp-pdf-clip" />'), false);

  assert.equal(listGoesThroughPick('const rows = pickedComponentRows(state, dxfComponentRows(state));'), true);
  assert.equal(listGoesThroughPick('const rows = dxfComponentRows(state);'), false);
  assert.equal(clearButtonCallsHandler('<button onClick={onClearPick}>{DETAIL_HELPER_TEXT.pickClear}</button>'), true);
  assert.equal(clearButtonCallsHandler('<button>{DETAIL_HELPER_TEXT.pickClear}</button>'), false);
  assert.equal(clearWiredForBoth('onClearPick={() => setDxf(d => clearPickRect(d))}'), false);
  assert.equal(pickWiredForBoth('onPick={r => setDxf(d => setPickRect(d, r))}'), false);

  const fig = "<div style={{ position: 'relative' }}>{overlay?.(t, { autoScale })}<EditableDimLabel/></div>\n  );\nmakeTransform(a);";
  assert.equal(figureCallsOverlayInsideRelativeDiv(fig), true);
  assert.equal(figureCallsOverlayInsideRelativeDiv(`${fig}makeTransform(b);`), false);
  assert.equal(figureCallsOverlayInsideRelativeDiv(fig.replace('{overlay?.(t, { autoScale })}', '')), false);
  // 旧順序（EditableDimLabel の後）・relative の div の外は偽
  assert.equal(figureCallsOverlayInsideRelativeDiv("<div style={{ position: 'relative' }}><EditableDimLabel/>{overlay?.(t, { autoScale })}</div>\n  );makeTransform(a);"), false);
  assert.equal(figureCallsOverlayInsideRelativeDiv("{overlay?.(t, { autoScale })}<div style={{ position: 'relative' }}><EditableDimLabel/></div>\n  );makeTransform(a);"), false);
});
