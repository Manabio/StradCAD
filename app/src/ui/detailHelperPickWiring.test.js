// ヘルパー画面の「プレビュー上の矩形で成分を絞る」（S7c-2）の配線を固定する不変条件テスト
// （detailHelperDxfWiring.test.js と同型——コメントを除いたソース本体の正規表現検査＋検出力）。純ロジックは ui/detailHelperPick.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSrc = path.resolve(import.meta.dirname, '..');
const readSrc = rel => fs.readFileSync(path.join(appSrc, rel), 'utf8');

// 文字列リテラルは保持し、// と /* */ のコメントだけを取り除く。
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const two = src.slice(i, i + 2);
    if (two === '//') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (two === '/*') { const end = src.indexOf('*/', i + 2); i = end === -1 ? src.length : end + 2; continue; }
    const ch = src[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// 関数全体（次のトップレベル宣言の直前まで）。波括弧の数え合わせは JSX の {} で崩れないよう、開始位置から次の「\n}\n」まで。
function topLevelBlock(src, startMarker) {
  const s = src.indexOf(startMarker);
  if (s < 0) return null;
  const e = src.indexOf('\n}\n', s);
  return e < 0 ? null : src.slice(s, e + 3);
}

// ---- 判定（本体文字列 → 真偽。検出力テストにも同じ関数を渡す）----
// overlay は DXF タブで scene があるときだけ渡す（ペン入力のプレビューには矩形層を出さない）。
const overlayOnlyWhenScene = src => /overlay=\{showDxf && imported\?\.scene\s*\?[\s\S]*?:\s*undefined\}/.test(src);
// 矩形層には AutoScaledFigure が描画に使った t をそのまま渡す（変換を作り直さない）。
const overlayPassesFigureTransform = src => /overlay=\{[^}]*?\bt => <PickLayer t=\{t\}/.test(src) && !/makeTransform\(/.test(src);
// ドラッグ中（onPointerMove）は部品内 state だけ更新し、親の state（重いプレビューの再描画）を触らない。
const moveHandler = body => {
  const m = /onPointerMove=\{([\s\S]*?)\}\s*\n\s*onPointerUp=/.exec(body ?? '');
  return m ? m[1] : null;
};
const moveTouchesOnlyLocalState = body => {
  const h = moveHandler(body);
  return h !== null && /setLive\(/.test(h) && !/setPickRect|setDxf|setPdf|onPick/.test(h);
};
// 離したとき（onPointerUp）にだけ onPick を呼ぶ。
const upCommitsViaPickRectFromDrag = body => {
  const m = /onPointerUp=\{([\s\S]*?)\}\}\s*\n\s*onPointerCancel=/.exec(body ?? '');
  return !!m && /pickRectFromDrag\(/.test(m[1]) && /onPick\(/.test(m[1]);
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
// AutoScaledFigure: overlay?.(t) は relative の div の中（EditableDimLabel の後・return の前）で呼び、変換は 1 回だけ作る。
const figureCallsOverlayInsideRelativeDiv = src => {
  const rel = src.indexOf('position: \'relative\'');
  const ed = src.indexOf('<EditableDimLabel');
  const ov = src.indexOf('overlay?.(t)');
  const close = src.indexOf('</div>\n  );', ov);
  return rel >= 0 && ed > rel && ov > ed && close > ov && (src.match(/makeTransform\(/g) ?? []).length === 1; // import は括弧なしなので呼び出しだけ数える
};

// 矩形の枠は今有効な矩形（imported＝pdf ?? dxf）から作る。
const passesActiveRectOfImported = src => /pickRect=\{activePickRect\(imported\)\}/.test(src);
// 押下: busy なら受けず、ポインタを捕捉する。
const downGuardsBusyAndCaptures = body => {
  const m = /onPointerDown=\{([\s\S]*?)\}\}?\s*\n\s*onPointerMove=/.exec(body ?? '');
  return !!m && /if \(busy[^)]*\) return;/.test(m[1]) && /e\.currentTarget\.setPointerCapture\(e\.pointerId\)/.test(m[1]);
};
// 画面の点→mm は層自身の矩形（currentTarget）で換算する。
const convertsViaCurrentTarget = body => !!body && /figurePointToMm\(e, e\.currentTarget\.getBoundingClientRect\(\), t\)/.test(body);
// Move・Up・Cancel は押下と同じ pointerId のイベントだけ扱う。
const matchesPointerId = body => {
  const h = moveHandler(body) ?? '';
  const up = /onPointerUp=\{([\s\S]*?)\}\}\s*\n\s*onPointerCancel=/.exec(body ?? '')?.[1] ?? '';
  const cancel = /onPointerCancel=\{([\s\S]*?)\}\}>/.exec(body ?? '')?.[1] ?? '';
  return /pointerId === e\.pointerId/.test(h) && /pointerId !== e\.pointerId\) return/.test(up) && /pointerId !== e\.pointerId\) return/.test(cancel);
};
// 一覧の上に操作のヒントと件数を出す。
const importResultShowsHintAndSummary = body => !!body && /DETAIL_HELPER_TEXT\.pickHint/.test(body) && /pickSummaryOf\(state\)/.test(body);

const panel = () => stripComments(readSrc('ui/DetailHelperPanel.jsx'));
const pickLayerBody = () => topLevelBlock(panel(), 'function PickLayer(');
const importResultBody = () => topLevelBlock(panel(), 'function ImportResult(');

test('【配線】overlay は DXF タブで scene があるときだけ渡し、t は図の描画と同じ変換を受け取る', () => {
  assert.ok(overlayOnlyWhenScene(panel()));
  assert.ok(overlayPassesFigureTransform(panel()));
  assert.ok(passesActiveRectOfImported(panel()));
});

test('【配線】PickLayer: 押下は busy で受けずポインタ捕捉・換算は currentTarget・pointerId が一致するイベントだけ扱う', () => {
  const body = pickLayerBody();
  assert.ok(downGuardsBusyAndCaptures(body), body);
  assert.ok(convertsViaCurrentTarget(body), body);
  assert.ok(matchesPointerId(body), body);
});

test('【配線】ImportResult: ヒントと件数の行を出す', () => {
  assert.ok(importResultShowsHintAndSummary(importResultBody()));
});

test('【検出力】追加の判定は壊れた文字列を落とす', () => {
  assert.equal(passesActiveRectOfImported('pickRect={activePickRect(imported)}'), true);
  assert.equal(passesActiveRectOfImported('pickRect={activePickRect(dxf)}'), false);
  const down = inner => `onPointerDown={e => { ${inner} }}\n      onPointerMove={x}`;
  assert.equal(downGuardsBusyAndCaptures(down('if (busy) return; e.currentTarget.setPointerCapture(e.pointerId);')), true);
  assert.equal(downGuardsBusyAndCaptures(down('e.currentTarget.setPointerCapture(e.pointerId);')), false);
  assert.equal(downGuardsBusyAndCaptures(down('if (busy) return; e.setPointerCapture(e.pointerId);')), false);
  assert.equal(convertsViaCurrentTarget('figurePointToMm(e, e.currentTarget.getBoundingClientRect(), t)'), true);
  assert.equal(convertsViaCurrentTarget('figurePointToMm(e, e.target.getBoundingClientRect(), t)'), false);
  assert.equal(convertsViaCurrentTarget('figurePointToMm(e, document.body.getBoundingClientRect(), t)'), false);
  const ok = 'onPointerMove={e => { if (a?.pointerId === e.pointerId) setLive(1); }}\n onPointerUp={e => { if (from?.pointerId !== e.pointerId) return; go(); }}\n onPointerCancel={e => { if (a?.pointerId !== e.pointerId) return; z(); }}>';
  assert.equal(matchesPointerId(ok), true);
  assert.equal(matchesPointerId(ok.replace('a?.pointerId === e.pointerId', 'a')), false);
  assert.equal(matchesPointerId(ok.replace('from?.pointerId !== e.pointerId', 'false')), false);
  assert.equal(matchesPointerId(ok.replace('a?.pointerId !== e.pointerId', 'false')), false);
  assert.equal(importResultShowsHintAndSummary('{DETAIL_HELPER_TEXT.pickHint} pickSummaryOf(state)'), true);
  assert.equal(importResultShowsHintAndSummary('pickSummaryOf(state)'), false);
  assert.equal(importResultShowsHintAndSummary('{DETAIL_HELPER_TEXT.pickHint}'), false);
});

test('【配線】PickLayer: 移動中は部品内 state だけ・離したときだけ onPick・枠は pickOverlayStyle', () => {
  const body = pickLayerBody();
  assert.ok(body, 'PickLayer が見つからない');
  assert.ok(moveTouchesOnlyLocalState(body), body);
  assert.ok(upCommitsViaPickRectFromDrag(body), body);
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

test('【配線】AutoScaledFigure: overlay?.(t) を relative の div の中で呼び、変換は 1 回だけ作る', () => {
  assert.ok(figureCallsOverlayInsideRelativeDiv(stripComments(readSrc('structural/sectionFigure/AutoScaledFigure.jsx'))));
});

test('【検出力】判定は壊れた配線を落とす（overlay を常に渡す・移動で親 state を触る・pickedComponentRows を通さない・解除を外す・変換の作り直し）', () => {
  assert.equal(overlayOnlyWhenScene('overlay={showDxf && imported?.scene ? t => <X/> : undefined}'), true);
  assert.equal(overlayOnlyWhenScene('overlay={t => <PickLayer t={t} />}'), false);
  assert.equal(overlayPassesFigureTransform('overlay={showDxf ? t => <PickLayer t={t} pickRect={r} /> : undefined}'), true);
  assert.equal(overlayPassesFigureTransform('overlay={showDxf ? () => <PickLayer t={makeTransform(b, s)} /> : undefined}'), false);

  const move = body => `onPointerMove={e => { ${body} }}\n      onPointerUp={x}`;
  assert.equal(moveTouchesOnlyLocalState(move('if (a) setLive(f(e));')), true);
  assert.equal(moveTouchesOnlyLocalState(move('if (a) { setLive(f(e)); setDxf(g); }')), false);
  assert.equal(moveTouchesOnlyLocalState(move('if (a) { setLive(f(e)); onPick(r); }')), false);
  assert.equal(moveTouchesOnlyLocalState(move('if (a) setPickRect(f(e));')), false);
  assert.equal(moveTouchesOnlyLocalState('なし'), false);

  const up = inner => `onPointerUp={e => { ${inner} }}\n      onPointerCancel={y}`;
  assert.equal(upCommitsViaPickRectFromDrag(up('const r = pickRectFromDrag(a, b); if (r) onPick(r);')), true);
  assert.equal(upCommitsViaPickRectFromDrag(up('onPick(clipFromDrag(a, b));')), false);

  assert.equal(framesViaPickOverlayStyle('const s = pickOverlayStyle(live ?? pickRect, t); <div className="dthlp-pdf-clip" />'), true);
  assert.equal(framesViaPickOverlayStyle('const s = pickOverlayStyle(pickRect, t); <div className="dthlp-pdf-clip" />'), false);

  assert.equal(listGoesThroughPick('const rows = pickedComponentRows(state, dxfComponentRows(state));'), true);
  assert.equal(listGoesThroughPick('const rows = dxfComponentRows(state);'), false);
  assert.equal(clearButtonCallsHandler('<button onClick={onClearPick}>{DETAIL_HELPER_TEXT.pickClear}</button>'), true);
  assert.equal(clearButtonCallsHandler('<button>{DETAIL_HELPER_TEXT.pickClear}</button>'), false);
  assert.equal(clearWiredForBoth('onClearPick={() => setDxf(d => clearPickRect(d))}'), false);
  assert.equal(pickWiredForBoth('onPick={r => setDxf(d => setPickRect(d, r))}'), false);

  const fig = "<div style={{ position: 'relative' }}><EditableDimLabel/>{overlay?.(t)}</div>\n  );\nmakeTransform(a);";
  assert.equal(figureCallsOverlayInsideRelativeDiv(fig), true);
  assert.equal(figureCallsOverlayInsideRelativeDiv(`${fig}makeTransform(b);`), false);
  assert.equal(figureCallsOverlayInsideRelativeDiv(fig.replace('{overlay?.(t)}', '')), false);
  assert.equal(figureCallsOverlayInsideRelativeDiv("{overlay?.(t)}<div style={{ position: 'relative' }}><EditableDimLabel/></div>\n  );makeTransform(a);"), false);
});
