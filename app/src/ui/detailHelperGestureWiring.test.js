// ヘルパー画面のプレビューのジェスチャー層（S7d-2。ズーム／パン／ピンチ／ホイール／長押し後の矩形）とツールバーの配線を固定する
// 不変条件テスト（detailHelperPickWiring.test.js と同型——コメントを除いたソース本体の正規表現検査＋壊した文字列との対）。
// 純ロジックは structural/sectionFigure/figureView.test.js・ui/detailHelperPick.test.js。矩形・pointerId・移動中の親 state は detailHelperPickWiring.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DETAIL_HELPER_TEXT } from './detailHelperForm.js';

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

function topLevelBlock(src, startMarker) {
  const s = src.indexOf(startMarker);
  if (s < 0) return null;
  const e = src.indexOf('\n}\n', s);
  return e < 0 ? null : src.slice(s, e + 3);
}

const innerFn = (body, name) => {
  const s = body?.indexOf(`  function ${name}(`) ?? -1;
  if (s < 0) return null;
  const e = body.indexOf('\n  }\n', s);
  return e < 0 ? null : body.slice(s, e + 5);
};

// ---- 判定（本体文字列 → 真偽。検出力テストにも同じ関数を渡す）----
// ホイール: React の onWheel（passive）ではなくネイティブの non-passive で受け、preventDefault し、フレームごとに 1 回だけ確定する。後始末も。
const wheelIsNativeNonPassive = body => !!body
  && /el\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/.test(body)
  && /el\.removeEventListener\('wheel', onWheel\)/.test(body)
  && /const onWheel = e => \{\s*e\.preventDefault\(\);/.test(body)
  && /if \(!w\.raf\) w\.raf = requestAnimationFrame\(flush\);/.test(body)
  && /cancelAnimationFrame\(w\.raf\)/.test(body)
  && !/onWheel=\{/.test(body);
// ホイールの倍率は deltaY<0 で拡大（FIGURE_WHEEL_ZOOM_FACTOR）、>0 で縮小。
const wheelFactorDirection = body => !!body
  && /w\.factor \*= e\.deltaY < 0 \? FIGURE_WHEEL_ZOOM_FACTOR : 1 \/ FIGURE_WHEEL_ZOOM_FACTOR;/.test(body);
// ホイールの確定: 全体のときの基準は枠(PREVIEW_FRAME_PX)つき viewOfTransform、zoomViewAt の後に panView(…, 0, 0, 図の範囲) で範囲へ寄せる。全体へ戻るなら onView(null)。
const wheelCommit = body => {
  const flush = /const flush = \(\) => \{([\s\S]*?)\n {4}\};/.exec(body ?? '')?.[1] ?? '';
  return /const next = wheelZoomedView\(\{\s*view: cur\.view, t: cur\.t, frame: PREVIEW_FRAME_PX, client: w, rect: el\.getBoundingClientRect\(\),/.test(flush)
    && /autoScale: cur\.info\.autoScale, contentBounds: cur\.info\.contentBounds,/.test(flush)
    && /if \(next === null\) \{ if \(cur\.view\) cur\.onView\(null\); return; \}/.test(flush)
    && /cur\.onView\(next\);/.test(flush)
    && /if \(!cur \|\| cur\.busy\) return;/.test(flush);
};
// ドラッグ・ピンチ中のホイールは無視する（描き直しで CSS の仮の動きが外れ、押下時の view での確定とずれるため）。
const wheelIgnoredWhileDragging = body => {
  const flush = /const flush = \(\) => \{([\s\S]*?)\n {4}\};/.exec(body ?? '')?.[1] ?? '';
  const guard = flush.indexOf('if (gesture.current) return;');
  return guard >= 0 && guard < flush.indexOf('wheelZoomedView(');
};
// ホイールが読む最新の props は layout effect で更新する（連続ホイールの次のフレームが commit 前の古い view を読まない）。
const latestUpdatedInLayout = body => !!body
  && /useLayoutEffect\(\(\) => \{ latest\.current = \{ t, info, view, onView, busy \}; \}\);/.test(body);
// ピンチの仮表示の倍率は確定（pinchView）と同じ範囲 [min/base, max/base] に収める。
const pinchPreviewClamped = body => !!body
  && /const k = Math\.min\(g\.limits\.maxScale \/ g\.base\.scale, Math\.max\(g\.limits\.minScale \/ g\.base\.scale, Math\.hypot\(/.test(body);
// move は transform を書く直前に必ず beginDragStyle()（冪等）を呼ぶ。パン・ピンチの量は純関数経由、確定も同じ純関数、g.viewed の判定は move・end の両方。
const moveReappliesDragStyle = body => {
  const h = innerFn(body, 'onPointerMove');
  if (h === null) return false;
  const writes = (h.match(/style\.transform =/g) ?? []).length;
  const guarded = (h.match(/beginDragStyle\(\);\s*svgRef\.current\.style\.transform =/g) ?? []).length;
  return writes >= 2 && writes === guarded;
};
const panAndPinchViaPureFns = body => {
  const move = innerFn(body, 'onPointerMove') ?? '';
  const end = innerFn(body, 'onPointerEnd') ?? '';
  return /panDeltaPx\(g, e\)/.test(move) && /panDeltaPx\(g, e\)/.test(end) && /onView\(pinchView\(\.\.\.pinchArgsOf\(g, pinched\)\)\)/.test(end)
    && /g\.kind === 'pan' && g\.viewed/.test(move) && /g\.kind === 'pan' && g\.viewed/.test(end);
};
// 長押し成立で矩形の予告（armed）。指が消えた（capture を失った）ら取り消す。
const armedAndLostCapture = body => !!body
  && /useLongPress\(\{ onFire: \(\) => setArmed\(true\) \}\)/.test(body)
  && /dthlp-pick-layer\$\{armed && canPick \? ' dthlp-pick-layer--armed' : ''\}/.test(body)
  && /onLostPointerCapture=\{e => onPointerEnd\(e, false\)\}/.test(body)
  && (body.match(/setArmed\(false\)/g) ?? []).length >= 2;
// ドラッグ中は div を枠の大きさに広げ（全体表示は小さい div なので切られる）、終わったら描画の大きさに戻す。
const hostResizedWhileDragging = body => !!body
  && /host\.style\.width = `\$\{PREVIEW_FRAME_PX\.width\}px`;/.test(body)
  && /host\.style\.width = `\$\{tNow\.pxWidth\}px`;/.test(body)
  && /host\.style\.height = `\$\{tNow\.pxHeight\}px`;/.test(body);
// 押下: 全体のときの基準 view は枠つき viewOfTransform、ピンチの startT は transformOfView(base, 枠)（auto の t を使わない）、2 本目で進行中の操作を捨てる。
const downBases = body => {
  const h = innerFn(body, 'onPointerDown');
  return h !== null
    && /const base = view \?\? viewOfTransform\(t, PREVIEW_FRAME_PX\);/.test(h)
    && /startT: transformOfView\(base, PREVIEW_FRAME_PX\)/.test(h)
    && /pointers\.current\.size === 2\) \{\s*cancelDrag\(\);/.test(h)
    && /limits: viewLimitsOf\(info\.autoScale\)/.test(h);
};
// 1 本指: 長押しが成立したか(hasFired)で矩形か移動かを dragKindOf に決めさせる（長押しなしで矩形にしない）。移動は閾値超え(move が true)の瞬間に決める。
const moveDecidesByLongPress = body => {
  const h = innerFn(body, 'onPointerMove');
  return h !== null && /longPress\.move\(e\.clientX, e\.clientY\)/.test(h)
    && /g\.kind = dragKindOf\(\{ fired: longPress\.hasFired\(\), canPick \}\);/.test(h)
    && !/g\.kind = 'rect'/.test(h);
};
// 右クリック・長押しの既定メニューは出さない。
const contextMenuSuppressed = body => !!body && /onContextMenu=\{e => \{ e\.preventDefault\(\);/.test(body);
// 確定で親が描き直したら CSS の仮の動きを外す。
const clearsDragStyleOnRender = body => !!body && /useLayoutEffect\(\(\) => \{ endDragStyle\(view, t\); \}, \[t, view, endDragStyle\]\);/.test(body);
// 状態の結び付き: 図読込みは読込みごとのトークン viewEpoch（無ければ scene）・ペン入力は下書きの key。レイヤ切替後の図に reconcileView で合わせる。
const viewBoundToOwner = src => /const viewOwner = showDxf \? \(imported\?\.viewEpoch \?\? imported\?\.scene\) : form\.key;/.test(src)
  && /const keptView = activeView\(showDxf \? importView : draftView, viewOwner\);/.test(src)
  && /reconcileView\(keptView, figureMetrics\.autoScale, figureMetrics\.contentBounds\)/.test(src)
  && /bindView\(viewOwner, next\)/.test(src);
const figureGetsViewAndRef = src => /view=\{shownView\}\s*svgRef=\{figureSvgRef\}/.test(src)
  && /<FigureGestureLayer[^>]*svgRef=\{figureSvgRef\}/.test(src);
// ［全体］は view が null なら disabled、押すと onView(null) 相当。文言は文言表。
const viewAllButton = src => /<button className="dthlp-btn" disabled=\{busy \|\| !shownView\} onClick=\{\(\) => setShownView\(null\)\}>\{DETAIL_HELPER_TEXT\.viewAll\}<\/button>/.test(src);
// ［矩形に寄せる］は図読込みタブで、有効な矩形があるときだけ。fitViewToRect に枠と全体の縮尺つき範囲を渡す。
const fitRectButton = src => /const canFitRect = !busy && !!pickRectNow && shownPrims\.length > 0;/.test(src)
  && /disabled=\{!canFitRect\}/.test(src)
  && /setShownView\(fitViewToRect\(pickRectNow, PREVIEW_FRAME_PX, viewLimitsOf\(figureMetrics\.autoScale\)\)\)/.test(src)
  && /\{DETAIL_HELPER_TEXT\.viewFitRect\}/.test(src);
const hintFromTextTable = src => /<span className="dthlp-hint">\{showDxf \? DETAIL_HELPER_TEXT\.gestureHint : DETAIL_HELPER_TEXT\.gestureHintPen\}/.test(src);
// CSS: 層のルールに grab・選択禁止・iOS の長押しメニュー禁止。
const layerCss = css => {
  const rule = /\.dthlp-pick-layer \{([^}]*)\}/.exec(css)?.[1] ?? '';
  return /cursor: grab;/.test(rule) && /(?:^|[\s{;])user-select: none;/.test(rule) && /-webkit-user-select: none;/.test(rule) && /-webkit-touch-callout: none;/.test(rule) && /touch-action: none;/.test(rule);
};

const panel = () => stripComments(readSrc('ui/DetailHelperPanel.jsx'));
const layerBody = () => topLevelBlock(panel(), 'function FigureGestureLayer(');

test('【配線】FigureGestureLayer: ホイールはネイティブの non-passive で受け、フレームごとに 1 回、全体からは枠つきの基準、確定後に範囲へ寄せる', () => {
  const body = layerBody();
  assert.ok(body, 'FigureGestureLayer が見つからない');
  assert.ok(wheelIsNativeNonPassive(body), body);
  assert.ok(wheelFactorDirection(body), body);
  assert.ok(wheelCommit(body), body);
  assert.ok(wheelIgnoredWhileDragging(body), body);
  assert.ok(latestUpdatedInLayout(body), body);
});

test('【配線】FigureGestureLayer: move は transform を書く前に beginDragStyle()・パン／ピンチは純関数経由・長押しの予告・capture 喪失・ドラッグ中の枠', () => {
  const body = layerBody();
  assert.ok(moveReappliesDragStyle(body), body);
  assert.ok(panAndPinchViaPureFns(body), body);
  assert.ok(armedAndLostCapture(body), body);
  assert.ok(hostResizedWhileDragging(body), body);
  assert.ok(pinchPreviewClamped(body), body);
});

test('【配線】FigureGestureLayer: 押下の基準は枠つき・ピンチの startT は transformOfView・長押しの成立で矩形か移動かを決める・既定メニューを出さない', () => {
  const body = layerBody();
  assert.ok(downBases(body), body);
  assert.ok(moveDecidesByLongPress(body), body);
  assert.ok(contextMenuSuppressed(body), body);
  assert.ok(clearsDragStyleOnRender(body), body);
});

test('【配線】パネル: view はオーナーに結び付き、AutoScaledFigure へ view・svgRef を渡す。［全体］［矩形に寄せる］と案内文は文言表', () => {
  const src = panel();
  assert.ok(viewBoundToOwner(src));
  assert.ok(figureGetsViewAndRef(src));
  assert.ok(viewAllButton(src));
  assert.ok(fitRectButton(src));
  assert.ok(hintFromTextTable(src));
  for (const key of ['viewAll', 'viewFitRect', 'gestureHint', 'gestureHintPen']) {
    assert.equal(typeof DETAIL_HELPER_TEXT[key], 'string', key);
    assert.ok(DETAIL_HELPER_TEXT[key].length > 0, key);
    assert.equal(src.includes(DETAIL_HELPER_TEXT[key]), false, `${key} の文言をパネルへ直書きしない`);
  }
});

test('【配線】CSS: 層は grab・選択禁止・長押しメニュー禁止・touch-action none', () => {
  const css = readSrc('ui/DetailHelperPanel.css');
  assert.ok(layerCss(css));
  assert.match(css, /\.dthlp-pick-layer--armed \{ cursor: crosshair; \}/);
  assert.match(css, /\.dthlp-hint \{/);
});

test('【検出力】判定は壊れた配線を落とす', () => {
  const wheelOk = [
    'const flush = () => {',
    '      const cur = latest.current;',
    '      if (!cur || cur.busy) return;',
    '      if (gesture.current) return;',
    '      const next = wheelZoomedView({',
    '        view: cur.view, t: cur.t, frame: PREVIEW_FRAME_PX, client: w, rect: el.getBoundingClientRect(),',
    '        factor, autoScale: cur.info.autoScale, contentBounds: cur.info.contentBounds,',
    '      });',
    '      if (next === null) { if (cur.view) cur.onView(null); return; }',
    '      cur.onView(next);',
    '    };',
    'const onWheel = e => {\n      e.preventDefault();',
    'w.factor *= e.deltaY < 0 ? FIGURE_WHEEL_ZOOM_FACTOR : 1 / FIGURE_WHEEL_ZOOM_FACTOR;',
    'if (!w.raf) w.raf = requestAnimationFrame(flush);',
    "el.addEventListener('wheel', onWheel, { passive: false });",
    "el.removeEventListener('wheel', onWheel); cancelAnimationFrame(w.raf);",
  ].join('\n');
  assert.equal(wheelIsNativeNonPassive(wheelOk), true);
  assert.equal(wheelIsNativeNonPassive(wheelOk.replace('{ passive: false }', '{ passive: true }')), false);
  assert.equal(wheelIsNativeNonPassive(wheelOk.replace('e.preventDefault();', '')), false);
  assert.equal(wheelIsNativeNonPassive(wheelOk.replace('requestAnimationFrame(flush)', 'flush()')), false);
  assert.equal(wheelIsNativeNonPassive(`${wheelOk} <div onWheel={f} />`), false);
  assert.equal(wheelIsNativeNonPassive(wheelOk.replace("el.removeEventListener('wheel', onWheel);", '')), false);
  assert.equal(wheelFactorDirection(wheelOk), true);
  assert.equal(wheelFactorDirection(wheelOk.replace('e.deltaY < 0', 'e.deltaY > 0')), false);
  assert.equal(wheelCommit(wheelOk), true);
  assert.equal(wheelCommit(wheelOk.replace('frame: PREVIEW_FRAME_PX', 'frame: cur.t')), false); // 枠が違うと最初のズームで図が跳ぶ
  assert.equal(wheelCommit(wheelOk.replace('t: cur.t,', 't: otherT,')), false); // 別の t で中心を換算しない
  assert.equal(wheelCommit(wheelOk.replace('view: cur.view,', 'view: null,')), false);
  assert.equal(wheelCommit(wheelOk.replace('{ if (cur.view) cur.onView(null); return; }', 'return;')), false); // 全体へ戻らない
  assert.equal(wheelCommit(wheelOk.replace('if (!cur || cur.busy) return;', '')), false);
  assert.equal(wheelIgnoredWhileDragging(wheelOk), true);
  assert.equal(wheelIgnoredWhileDragging(wheelOk.replace('if (gesture.current) return;', '')), false);
  assert.equal(wheelIgnoredWhileDragging(wheelOk.replace('if (gesture.current) return;', "if (gesture.current && gesture.current.kind !== 'press') return;")), false); // 長押し待ちのホイールを通すと押下時の基準が古くなる
  const latestOk = 'useEffect(() => { longPressRef.current = longPress; });\n  useLayoutEffect(() => { latest.current = { t, info, view, onView, busy }; });';
  assert.equal(latestUpdatedInLayout(latestOk), true);
  assert.equal(latestUpdatedInLayout(latestOk.replace('useLayoutEffect(() => { latest.current', 'useEffect(() => { latest.current')), false);
  assert.equal(latestUpdatedInLayout(latestOk.replace('view, onView, busy', 'onView, busy')), false);
  const pinchOk = 'const k = Math.min(g.limits.maxScale / g.base.scale, Math.max(g.limits.minScale / g.base.scale, Math.hypot(a, b) / d0));';
  assert.equal(pinchPreviewClamped(pinchOk), true);
  assert.equal(pinchPreviewClamped('const k = Math.hypot(a, b) / d0;'), false);
  assert.equal(pinchPreviewClamped(pinchOk.replace('Math.max(g.limits.minScale / g.base.scale, ', 'Math.max(0, ')), false);

  const moveFnOk = '  function onPointerMove(e) {\n    beginDragStyle();\n    svgRef.current.style.transform = `a`;\n    beginDragStyle();\n    svgRef.current.style.transform = `b`;\n  }\n';
  assert.equal(moveReappliesDragStyle(moveFnOk), true);
  assert.equal(moveReappliesDragStyle(moveFnOk.replace('beginDragStyle();\n    svgRef.current.style.transform = `a`;', 'svgRef.current.style.transform = `a`;')), false);
  const pureOk = '  function onPointerMove(e) {\n    else if (g.kind === \'pan\' && g.viewed && x) { const { dx, dy } = panDeltaPx(g, e); }\n  }\n'
    + '  function onPointerEnd(e, commit) {\n    } else if (g.kind === \'pan\' && g.viewed) {\n      const { dx, dy } = panDeltaPx(g, e);\n    } else if (x) {\n      onView(pinchView(...pinchArgsOf(g, pinched)));\n  }\n';
  assert.equal(panAndPinchViaPureFns(pureOk), true);
  assert.equal(panAndPinchViaPureFns(pureOk.replace('g.kind === \'pan\' && g.viewed && x', 'g.kind === \'pan\' && x')), false); // 全体表示でもパンしてしまう
  assert.equal(panAndPinchViaPureFns(pureOk.replace('pinchArgsOf(g, pinched)', 'g.base, pinched')), false);
  assert.equal(panAndPinchViaPureFns(pureOk.replace('const { dx, dy } = panDeltaPx(g, e);\n    } else if (x)', 'const dx = 0;\n    } else if (x)')), false);
  const armedOk = 'useLongPress({ onFire: () => setArmed(true) }); className={`dthlp-pick-layer${armed && canPick ? \' dthlp-pick-layer--armed\' : \'\'}`} onLostPointerCapture={e => onPointerEnd(e, false)} setArmed(false); setArmed(false);';
  assert.equal(armedAndLostCapture(armedOk), true);
  assert.equal(armedAndLostCapture(armedOk.replace(' onLostPointerCapture={e => onPointerEnd(e, false)}', '')), false);
  assert.equal(armedAndLostCapture(armedOk.replace('armed && canPick', 'armed')), false);
  assert.equal(armedAndLostCapture(armedOk.replace(' setArmed(false);', '')), false);
  const hostOk = 'host.style.width = `${PREVIEW_FRAME_PX.width}px`; host.style.width = `${tNow.pxWidth}px`; host.style.height = `${tNow.pxHeight}px`;';
  assert.equal(hostResizedWhileDragging(hostOk), true);
  assert.equal(hostResizedWhileDragging(hostOk.replace('host.style.height = `${tNow.pxHeight}px`;', '')), false);
  assert.equal(hostResizedWhileDragging(hostOk.replace('${PREVIEW_FRAME_PX.width}', '${tNow.pxWidth}')), false);

  const downOk = '  function onPointerDown(e) {\n    const base = view ?? viewOfTransform(t, PREVIEW_FRAME_PX);\n    const common = { limits: viewLimitsOf(info.autoScale) };\n'
    + '    } else if (pointers.current.size === 2) {\n      cancelDrag();\n      const g = { startT: transformOfView(base, PREVIEW_FRAME_PX) };\n    }\n  }\n';
  assert.equal(downBases(downOk), true);
  assert.equal(downBases(downOk.replace('viewOfTransform(t, PREVIEW_FRAME_PX)', 'viewOfTransform(t, t)')), false);
  assert.equal(downBases(downOk.replace('transformOfView(base, PREVIEW_FRAME_PX)', 't')), false); // 自動縮尺の t は不可
  assert.equal(downBases(downOk.replace('cancelDrag();', '')), false);
  assert.equal(downBases(downOk.replace('viewLimitsOf(info.autoScale)', 'info')), false);

  const moveOk = "  function onPointerMove(e) {\n    if (longPress.move(e.clientX, e.clientY)) {\n      g.kind = dragKindOf({ fired: longPress.hasFired(), canPick });\n    }\n  }\n";
  assert.equal(moveDecidesByLongPress(moveOk), true);
  assert.equal(moveDecidesByLongPress(moveOk.replace('dragKindOf({ fired: longPress.hasFired(), canPick })', "'rect'")), false); // 長押しなしで矩形
  assert.equal(moveDecidesByLongPress(moveOk.replace('longPress.hasFired()', 'true')), false);
  assert.equal(moveDecidesByLongPress(moveOk.replace('longPress.move(e.clientX, e.clientY)', 'true')), false);
  assert.equal(moveDecidesByLongPress(`${moveOk.slice(0, -5)}    g.kind = 'rect';\n  }\n`), false);

  assert.equal(contextMenuSuppressed('onContextMenu={e => { e.preventDefault(); longPress.abort(); }}'), true);
  assert.equal(contextMenuSuppressed('onContextMenu={e => { longPress.abort(); }}'), false);
  assert.equal(clearsDragStyleOnRender('useLayoutEffect(() => { endDragStyle(view, t); }, [t, view, endDragStyle]);'), true);
  assert.equal(clearsDragStyleOnRender('useLayoutEffect(() => { endDragStyle(view, t); }, []);'), false);

  const ownerOk = 'const viewOwner = showDxf ? (imported?.viewEpoch ?? imported?.scene) : form.key;\nconst keptView = activeView(showDxf ? importView : draftView, viewOwner);\n'
    + 'reconcileView(keptView, figureMetrics.autoScale, figureMetrics.contentBounds)\nbindView(viewOwner, next)';
  assert.equal(viewBoundToOwner(ownerOk), true);
  assert.equal(viewBoundToOwner(ownerOk.replace('imported?.viewEpoch ?? ', '')), false); // レイヤ切替でズームが解ける
  assert.equal(viewBoundToOwner(ownerOk.replace('reconcileView(keptView, ', 'reconcileView(null, ')), false);
  assert.equal(viewBoundToOwner(ownerOk.replace('imported?.scene', 'imported')), false);
  assert.equal(viewBoundToOwner(ownerOk.replace('form.key', 'form')), false);
  assert.equal(viewBoundToOwner(ownerOk.replace('bindView(viewOwner, next)', 'bindView(null, next)')), false);
  assert.equal(figureGetsViewAndRef('view={shownView}\n svgRef={figureSvgRef}\n overlay={(t, info) => (<FigureGestureLayer svgRef={figureSvgRef} />)}'), true);
  assert.equal(figureGetsViewAndRef('svgRef={figureSvgRef}\n overlay={(t, info) => (<FigureGestureLayer svgRef={figureSvgRef} />)}'), false);

  const allOk = '<button className="dthlp-btn" disabled={busy || !shownView} onClick={() => setShownView(null)}>{DETAIL_HELPER_TEXT.viewAll}</button>';
  assert.equal(viewAllButton(allOk), true);
  assert.equal(viewAllButton(allOk.replace(' disabled={busy || !shownView}', '')), false);
  assert.equal(viewAllButton(allOk.replace('busy || ', '')), false);
  assert.equal(viewAllButton(allOk.replace('setShownView(null)', 'setShownView(shownView)')), false);
  assert.equal(viewAllButton(allOk.replace('{DETAIL_HELPER_TEXT.viewAll}', '全体')), false);

  const fitOk = 'const canFitRect = !busy && !!pickRectNow && shownPrims.length > 0;\n<button disabled={!canFitRect} onClick={() => setShownView(fitViewToRect(pickRectNow, PREVIEW_FRAME_PX, viewLimitsOf(figureMetrics.autoScale)))}>{DETAIL_HELPER_TEXT.viewFitRect}</button>';
  assert.equal(fitRectButton(fitOk), true);
  assert.equal(fitRectButton(fitOk.replace('!!pickRectNow && ', '')), false);
  assert.equal(fitRectButton(fitOk.replace(' disabled={!canFitRect}', '')), false);
  assert.equal(fitRectButton(fitOk.replace('viewLimitsOf(figureMetrics.autoScale)', '{}')), false);
  const hintOk = '<span className="dthlp-hint">{showDxf ? DETAIL_HELPER_TEXT.gestureHint : DETAIL_HELPER_TEXT.gestureHintPen}</span>';
  assert.equal(hintFromTextTable(hintOk), true);
  assert.equal(hintFromTextTable(hintOk.replace('dthlp-hint', 'dthlp-dxf-file')), false);
  assert.equal(hintFromTextTable('{DETAIL_HELPER_TEXT.gestureHint}'), false);

  const cssOk = '.dthlp-pick-layer { position: absolute; touch-action: none; cursor: grab; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }';
  assert.equal(layerCss(cssOk), true);
  assert.equal(layerCss(cssOk.replace('cursor: grab;', 'cursor: crosshair;')), false);
  assert.equal(layerCss(cssOk.replace('-webkit-touch-callout: none;', '')), false);
  assert.equal(layerCss(cssOk.replace('-webkit-user-select: none;', '')), false);
  assert.equal(layerCss(cssOk.replace(' user-select: none;', '')), false);
});
