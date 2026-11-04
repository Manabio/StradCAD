// P1: 部分詳細図ヘルパーのプレビューの描画域＝中央ペイン全域。図の中心は枠の中央（AutoScaledFigure の fill）。
// 枠は ResizeObserver で測り（previewFrameOf で既定へ落とす）、PREVIEW_FRAME_PX の直書きは測った枠 frame に置き換わる。
// AutoScaledFigure.jsx・DetailHelperPanel.jsx は node:test から読めないので、ソースの形（コメント除去後の正規表現）＋壊した文字列との対で固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTransform, chooseScale, figureBounds, FIGURE_MARGIN_PX } from '../structural/sectionFigure/sectionGeometry.js';
import { viewBounds, fillBounds, viewOfTransform, transformOfView, isFrameUsable } from '../structural/sectionFigure/figureView.js';
import { previewFrameOf } from './detailHelperPick.js';
import { PREVIEW_FRAME_PX } from './detailHelperForm.js';

const appSrc = path.resolve(import.meta.dirname, '..');
const readSrc = rel => fs.readFileSync(path.join(appSrc, rel), 'utf8').replace(/\r\n/g, '\n'); // 作業ツリーが CRLF でも同じ形で判定する
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// AutoScaledFigure の fill と同じ手順（fillBounds は AutoScaledFigure も使う純関数）
function fillTransform(prims, frame) {
  const b = figureBounds(prims);
  const scale = chooseScale(b.width, b.height, frame.width, frame.height);
  return { t: makeTransform(fillBounds(b, scale, frame), scale), b, scale };
}

const PRIMS = [{ type: 'rect', x: -120, y: 40, w: 800, h: 500 }];

test('fillBounds: 範囲の中心＝図の中心・幅と高さ＝(枠−余白×2)/縮尺', () => {
  const b = figureBounds(PRIMS);
  const frame = { width: 560, height: 480 };
  for (const scale of [0.05, 0.5, 4]) {
    const fb = fillBounds(b, scale, frame);
    approx((fb.minX + fb.maxX) / 2, (b.minX + b.maxX) / 2);
    approx((fb.minY + fb.maxY) / 2, (b.minY + b.maxY) / 2);
    approx(fb.width, (frame.width - 2 * FIGURE_MARGIN_PX) / scale);
    approx(fb.height, (frame.height - 2 * FIGURE_MARGIN_PX) / scale);
  }
});

test('【失敗系】fillBounds: scale 0・負・非有限、枠が余白以下は RangeError', () => {
  const b = figureBounds(PRIMS);
  const frame = { width: 560, height: 480 };
  assert.throws(() => fillBounds(b, 0, frame), RangeError);
  assert.throws(() => fillBounds(b, -1, frame), RangeError);
  assert.throws(() => fillBounds(b, NaN, frame), RangeError);
  assert.throws(() => fillBounds(b, 1, { width: 2 * FIGURE_MARGIN_PX, height: 480 }), RangeError);
});

test('fill の変換: svg は枠いっぱい・図の中心が枠の中央', () => {
  for (const frame of [{ width: 560, height: 480 }, { width: 1100, height: 700 }, { width: 200, height: 900 }]) {
    const { t, b } = fillTransform(PRIMS, frame);
    approx(t.pxWidth, frame.width);
    approx(t.pxHeight, frame.height);
    approx(t.tx((b.minX + b.maxX) / 2), frame.width / 2);
    approx(t.ty((b.minY + b.maxY) / 2), frame.height / 2);
  }
});

test('fill: 最小段でも収まらない極大の図は中央に置き、両端が対称に切れる（既知の限界）', () => {
  const huge = [{ type: 'rect', x: 0, y: 0, w: 1e6, h: 100 }];
  const frame = { width: 560, height: 480 };
  const { t, b, scale } = fillTransform(huge, frame);
  assert.equal(scale, 1 / 500);
  approx(t.tx((b.minX + b.maxX) / 2), frame.width / 2);
  const left = -t.tx(b.minX);
  const right = t.tx(b.maxX) - frame.width;
  assert.ok(left > 0 && right > 0, `${left} ${right}`);
  approx(left, right, 1e-6);
});

test('fill: 枠が広がれば縮尺の段が上がる（段は NICE_SCALES のまま）', () => {
  const small = fillTransform(PRIMS, { width: 560, height: 480 }).scale;
  const big = fillTransform(PRIMS, { width: 1400, height: 1100 }).scale;
  assert.ok(big > small, `${big} <= ${small}`);
});

test('fill: 極小の図（縮尺が最大段 1 で頭打ち）でも中央に置く', () => {
  const tiny = [{ type: 'rect', x: 10, y: 20, w: 2, h: 3 }];
  const { t, scale } = fillTransform(tiny, { width: 560, height: 480 });
  assert.equal(scale, 1);
  approx(t.tx(11), 280);
  approx(t.ty(21.5), 240);
});

test('fill の t から作った view（viewOfTransform）の transformOfView は fill の t と一致する（最初のズームで跳ばない）', () => {
  const frame = { width: 900, height: 620 };
  const { t } = fillTransform(PRIMS, frame);
  const view = viewOfTransform(t, frame);
  const t2 = transformOfView(view, frame);
  for (const mm of [-120, 0, 300, 680]) approx(t2.tx(mm), t.tx(mm));
  for (const mm of [40, 200, 540]) approx(t2.ty(mm), t.ty(mm));
  approx(t2.pxWidth, t.pxWidth);
});

test('【失敗系】fill の枠が余白以下・非有限は isFrameUsable が偽（fill を諦めて従来の描画）', () => {
  assert.equal(isFrameUsable({ width: 560, height: 480 }), true);
  assert.equal(isFrameUsable({ width: 2 * FIGURE_MARGIN_PX, height: 480 }), false);
  assert.equal(isFrameUsable({ width: 560, height: 0 }), false);
  assert.equal(isFrameUsable({ width: NaN, height: 480 }), false);
  assert.equal(isFrameUsable({ width: Infinity, height: 480 }), false);
  assert.equal(isFrameUsable(null), false);
  assert.throws(() => viewBounds({ scale: 1, cx: 0, cy: 0 }, { width: 0, height: 0 }), RangeError);
});

test('previewFrameOf: 内寸の小数は切り捨て', () => {
  assert.deepEqual(previewFrameOf({ width: 812.9, height: 640.4 }, PREVIEW_FRAME_PX), { width: 812, height: 640 });
});

test('【失敗系】previewFrameOf: 測定前・0・余白以下・非有限は既定の枠へ落ちる（RangeError に届かない）', () => {
  assert.equal(previewFrameOf(null, PREVIEW_FRAME_PX), PREVIEW_FRAME_PX);
  assert.equal(previewFrameOf(undefined, PREVIEW_FRAME_PX), PREVIEW_FRAME_PX);
  assert.equal(previewFrameOf({ width: 0, height: 0 }, PREVIEW_FRAME_PX), PREVIEW_FRAME_PX);
  assert.equal(previewFrameOf({ width: 800, height: 0 }, PREVIEW_FRAME_PX), PREVIEW_FRAME_PX);
  assert.equal(previewFrameOf({ width: 2 * FIGURE_MARGIN_PX + 0.5, height: 500 }, PREVIEW_FRAME_PX), PREVIEW_FRAME_PX); // 切り捨てて余白と同値
  assert.equal(previewFrameOf({ width: NaN, height: 500 }, PREVIEW_FRAME_PX), PREVIEW_FRAME_PX);
  assert.equal(previewFrameOf({ width: -5, height: 500 }, PREVIEW_FRAME_PX), PREVIEW_FRAME_PX);
});

// ---- 配線（ソースの形）----
const figureSrc = stripComments(readSrc('structural/sectionFigure/AutoScaledFigure.jsx'));
const panelSrc = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
const css = readSrc('ui/DetailHelperPanel.css');

const fillIsOptIn = s => /overlay, fill = false, view = null, svgRef \}\) \{/.test(s)
  && /const filled = fill && !viewed && !study && frameUsable;/.test(s)
  && /const frameUsable = isFrameUsable\(\{ width: maxWidth, height: maxHeight \}\);/.test(s)
  && /: filled \? fillBounds\(baseBounds, autoScale, \{ width: maxWidth, height: maxHeight \}\)/.test(s)
  && /\.\.\.\(filled \? \{ overflow: 'hidden' \} : null\)/.test(s)
  && (s.match(/makeTransform\(/g) ?? []).length === 1;
// 測定: ResizeObserver で購読し解除する。contentRect を state に持ち、previewFrameOf で既定へ落として frame にする。
const measuresPreview = s => /<div className="dthlp-preview" ref=\{previewRef\}>/.test(s)
  && /useLayoutEffect\(\(\) => \{\s*const el = previewRef\.current;/.test(s)
  && /keep\(contentSizeOf\(el\)\);[^\n]*\n\s*const ro = new ResizeObserver\(entries => keep\(entries\[entries\.length - 1\]\.contentRect\)\);/.test(s)
  && /el\.clientWidth - parseFloat\(cs\.paddingLeft\) - parseFloat\(cs\.paddingRight\)/.test(s)
  && /el\.clientHeight - parseFloat\(cs\.paddingTop\) - parseFloat\(cs\.paddingBottom\)/.test(s)
  && /ro\.observe\(el\);/.test(s)
  && /return \(\) => ro\.disconnect\(\);/.test(s)
  && /const frame = useMemo\(\(\) => previewFrameOf\(measured, PREVIEW_FRAME_PX\), \[measured\]\);/.test(s);
// 枠を通す箇所: autoScale・AutoScaledFigure・fill・レイヤ・矩形に寄せる。PREVIEW_FRAME_PX は既定値としてだけ残る。
const framePassed = s => /autoScaleOfPrimitives\(shownPrims, frame\)/.test(s)
  && /\[shownPrims, frame\]\);/.test(s)
  && /maxWidth=\{frame\.width\}\s*maxHeight=\{frame\.height\}\s*fill\b/.test(s)
  && /<FigureGestureLayer t=\{t\} info=\{info\} frame=\{frame\}/.test(s)
  && /fitViewToRect\(pickRectNow, frame, /.test(s)
  && (s.match(/PREVIEW_FRAME_PX/g) ?? []).length === 2; // import と previewFrameOf の既定のみ
const previewCss = c => {
  const rule = /\.dthlp-preview \{([^}]*)\}/.exec(c)?.[1] ?? '';
  const center = /\.dthlp-center \{([^}]*)\}/.exec(c)?.[1] ?? '';
  return /flex: 1;/.test(rule) && /min-height: 0;/.test(rule) && /overflow: hidden;/.test(rule)
    && /align-items: stretch;/.test(center) && !/flex-start/.test(center);
};

test('【配線】AutoScaledFigure: fill は任意 prop（既定 false）。view・study が勝ち、枠が使えないときは従来の描画、makeTransform は 1 回', () => {
  assert.ok(fillIsOptIn(figureSrc));
  assert.equal(fillIsOptIn(figureSrc.replace('fill = false', 'fill = true')), false);
  assert.equal(fillIsOptIn(figureSrc.replace('fill && !viewed && !study && frameUsable', 'fill && frameUsable')), false); // view・study が負ける
  assert.equal(fillIsOptIn(figureSrc.replace('fill && !viewed && !study && frameUsable', 'fill && !viewed && !study')), false); // 枠が余白以下でも throw
  assert.equal(fillIsOptIn(figureSrc.replace('fillBounds(baseBounds, autoScale,', 'fillBounds(baseBounds, scale,')), false);
  assert.equal(fillIsOptIn(figureSrc.replace("...(filled ? { overflow: 'hidden' } : null)", '')), false); // fill のはみ出しを切る
  assert.match(figureSrc, /\.\.\.\(viewed \? \{ overflow: 'hidden' \} : null\)/); // 既存の形は不変
});

test('【配線】パネル: 描画域を ResizeObserver で測って frame にし、枠を使う全箇所へ通す', () => {
  assert.ok(measuresPreview(panelSrc));
  assert.ok(framePassed(panelSrc));
  assert.equal(measuresPreview(panelSrc.replace('previewFrameOf(measured, PREVIEW_FRAME_PX)', 'measured')), false); // 0 ガードを外す
  assert.equal(measuresPreview(panelSrc.replace('return () => ro.disconnect();', '')), false); // 解除しない
  assert.equal(measuresPreview(panelSrc.replace(' ref={previewRef}', '')), false);
  assert.equal(measuresPreview(panelSrc.replace('    keep(contentSizeOf(el));', '')), false); // 初回測定なし＝既定の枠から跳ねる
  assert.equal(measuresPreview(panelSrc.replace('useLayoutEffect(() => {\n    const el = previewRef', 'useEffect(() => {\n    const el = previewRef')), false);
  assert.equal(measuresPreview(panelSrc.replace('- parseFloat(cs.paddingLeft) ', '')), false); // padding を引かない
  assert.equal(framePassed(panelSrc.replace('autoScaleOfPrimitives(shownPrims, frame)', 'autoScaleOfPrimitives(shownPrims, PREVIEW_FRAME_PX)')), false);
  assert.equal(framePassed(panelSrc.replace('maxWidth={frame.width}', 'maxWidth={PREVIEW_FRAME_PX.width}')), false);
  assert.equal(framePassed(panelSrc.replace('\n                fill\n', '\n')), false);
  assert.equal(framePassed(panelSrc.replace('info={info} frame={frame}', 'info={info}')), false);
  assert.equal(framePassed(panelSrc.replace('fitViewToRect(pickRectNow, frame,', 'fitViewToRect(pickRectNow, PREVIEW_FRAME_PX,')), false);
});

test('【配線】CSS: 描画域は中央ペインの残り全部（flex:1・min-height:0・overflow hidden）・中央ペインは stretch', () => {
  assert.ok(previewCss(css));
  assert.equal(previewCss(css.replace(/(\.dthlp-preview \{[^}]*?)flex: 1; /, '$1')), false);
  assert.equal(previewCss(css.replace(/(\.dthlp-preview \{[^}]*?)overflow: hidden;/, '$1overflow: auto;')), false);
  assert.equal(previewCss(css.replace('align-items: stretch;', 'align-items: flex-start;')), false);
});
