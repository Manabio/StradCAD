// プレビューのズーム／パンの純関数（figureView.js）と、AutoScaledFigure への view の受け渡し。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTransform, chooseScale, FIGURE_MARGIN_PX } from './sectionGeometry.js';
import {
  FIGURE_VIEW_MAX_SCALE, FIGURE_WHEEL_ZOOM_FACTOR,
  viewBounds, viewOfTransform, zoomViewAt, panView, pinchView, fitViewToRect,
  transformOfView, autoScaleOfPrimitives, viewLimitsOf,
} from './figureView.js';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const FRAME = { width: 560, height: 480 };
const CONTENT = { minX: -120, minY: 40, maxX: 680, maxY: 540, width: 800, height: 500 };
const AUTO = chooseScale(CONTENT.width, CONTENT.height, FRAME.width, FRAME.height);
const LIMITS = { minScale: AUTO, maxScale: FIGURE_VIEW_MAX_SCALE };
const tOf = view => makeTransform(viewBounds(view, FRAME), view.scale);

test('定数: 最大 20 px/mm・ホイール 1.1 倍', () => {
  assert.equal(FIGURE_VIEW_MAX_SCALE, 20);
  assert.equal(FIGURE_WHEEL_ZOOM_FACTOR, 1.1);
});

test('viewBounds→makeTransform: pxWidth＝frame.width・pxHeight＝frame.height、中心 (cx,cy) が枠の中央に来る', () => {
  for (const scale of [0.05, 0.5, 4, 20]) {
    const view = { scale, cx: 123, cy: -45 };
    const t = tOf(view);
    approx(t.pxWidth, FRAME.width);
    approx(t.pxHeight, FRAME.height);
    approx(t.tx(view.cx), FRAME.width / 2);
    approx(t.ty(view.cy), FRAME.height / 2);
    approx(t.scale, scale);
  }
});

test('viewOfTransform: 自動縮尺の t と、その view で描いた t は図の四隅・中央の px が一致する（全体から最初のズームで跳ばない）', () => {
  const autoT = makeTransform(CONTENT, AUTO);
  const view = viewOfTransform(autoT, FRAME);
  assert.equal(view.scale, AUTO);
  const viewT = tOf(view);
  const xs = [CONTENT.minX, CONTENT.maxX, (CONTENT.minX + CONTENT.maxX) / 2];
  const ys = [CONTENT.minY, CONTENT.maxY, (CONTENT.minY + CONTENT.maxY) / 2];
  for (const x of xs) approx(viewT.tx(x), autoT.tx(x), 1e-6);
  for (const y of ys) approx(viewT.ty(y), autoT.ty(y), 1e-6);
});

test('zoomViewAt: pivot の画面位置（px）がズームの前後で同じ', () => {
  const view = { scale: 0.5, cx: 100, cy: 200 };
  const pivot = { x: 250, y: 60 };
  for (const factor of [FIGURE_WHEEL_ZOOM_FACTOR, 1 / FIGURE_WHEEL_ZOOM_FACTOR, 3, 0.8]) {
    const next = zoomViewAt(view, pivot, factor, { minScale: 0.01, maxScale: 20 });
    const t0 = tOf(view), t1 = tOf(next);
    approx(t1.tx(pivot.x), t0.tx(pivot.x));
    approx(t1.ty(pivot.y), t0.ty(pivot.y));
    approx(next.scale, view.scale * factor);
  }
});

test('zoomViewAt: 縮尺が minScale 以下になったら null（全体へ戻る）。ちょうど minScale も null', () => {
  const view = { scale: AUTO * 2, cx: 0, cy: 0 };
  assert.equal(zoomViewAt(view, { x: 0, y: 0 }, 0.5, LIMITS), null);
  assert.equal(zoomViewAt(view, { x: 0, y: 0 }, 0.1, LIMITS), null);
  assert.notEqual(zoomViewAt(view, { x: 0, y: 0 }, 0.6, LIMITS), null);
});

test('zoomViewAt: maxScale で頭打ち（超えて拡大しない）。頭打ちでも pivot は保たれる', () => {
  const view = { scale: 15, cx: 10, cy: 10 };
  const pivot = { x: 14, y: 8 };
  const next = zoomViewAt(view, pivot, 10, LIMITS);
  assert.equal(next.scale, FIGURE_VIEW_MAX_SCALE);
  approx(tOf(next).tx(pivot.x), tOf(view).tx(pivot.x));
  const again = zoomViewAt(next, pivot, 1.1, LIMITS);
  assert.equal(again.scale, FIGURE_VIEW_MAX_SCALE);
  approx(again.cx, next.cx);
});

test('panView: 右へ dx px ドラッグすると中心は左へ dx/scale。図の範囲の中ならそのまま', () => {
  const view = { scale: 2, cx: 100, cy: 200 };
  const p = panView(view, 50, -20, CONTENT);
  approx(p.cx, 100 - 25);
  approx(p.cy, 200 + 10);
  assert.equal(p.scale, 2);
});

test('panView: 中心は図の範囲の中へクランプされる（四方）', () => {
  const view = { scale: 2, cx: 100, cy: 200 };
  assert.equal(panView(view, 1e6, 0, CONTENT).cx, CONTENT.minX);
  assert.equal(panView(view, -1e6, 0, CONTENT).cx, CONTENT.maxX);
  assert.equal(panView(view, 0, 1e6, CONTENT).cy, CONTENT.minY);
  assert.equal(panView(view, 0, -1e6, CONTENT).cy, CONTENT.maxY);
});

test('pinchView: 2 指の距離が 2 倍で縮尺 2 倍、指が動かない中点の下の図の点は動かない', () => {
  const start = { scale: 1, cx: 50, cy: 80 };
  const t0 = tOf(start);
  const a0 = { x: 200, y: 200 }, b0 = { x: 300, y: 200 };
  const a1 = { x: 150, y: 200 }, b1 = { x: 350, y: 200 }; // 中点 (250,200) のまま距離 100→200
  const next = pinchView(start, t0, a0, b0, a1, b1, LIMITS, CONTENT);
  approx(next.scale, 2);
  const mm = { x: t0.mmX(250), y: t0.mmY(200) };
  const t1 = tOf(next);
  approx(t1.tx(mm.x), 250);
  approx(t1.ty(mm.y), 200);
});

test('pinchView: 中点の移動はパン（開始の中点の下の図の点が現在の中点に来る）。距離が同じなら縮尺は不変', () => {
  const start = { scale: 1, cx: 50, cy: 80 };
  const t0 = tOf(start);
  const a0 = { x: 200, y: 200 }, b0 = { x: 300, y: 260 };
  const dx = 40, dy = -30;
  const a1 = { x: a0.x + dx, y: a0.y + dy }, b1 = { x: b0.x + dx, y: b0.y + dy };
  const next = pinchView(start, t0, a0, b0, a1, b1, LIMITS, CONTENT);
  approx(next.scale, 1);
  const mid0 = { x: 250, y: 230 };
  const mm = { x: t0.mmX(mid0.x), y: t0.mmY(mid0.y) };
  const t1 = tOf(next);
  approx(t1.tx(mm.x), mid0.x + dx);
  approx(t1.ty(mm.y), mid0.y + dy);
});

test('pinchView: 縮尺が minScale 以下なら null・maxScale で頭打ち・中心は図の範囲へクランプ', () => {
  const start = { scale: AUTO * 2, cx: 50, cy: 80 };
  const t0 = tOf(start);
  const a0 = { x: 200, y: 200 }, b0 = { x: 300, y: 200 };
  assert.equal(pinchView(start, t0, a0, b0, { x: 245, y: 200 }, { x: 255, y: 200 }, LIMITS, CONTENT), null);
  const big = pinchView(start, t0, a0, b0, { x: 0, y: 200 }, { x: 5000, y: 200 }, LIMITS, CONTENT);
  assert.equal(big.scale, FIGURE_VIEW_MAX_SCALE);
  const far = pinchView(start, t0, a0, b0, { x: 1e6, y: 200 }, { x: 1e6 + 100, y: 200 }, LIMITS, CONTENT);
  assert.equal(far.cx, CONTENT.minX);
});

test('fitViewToRect: 矩形が枠（余白除く）に収まる最大の縮尺・中心は矩形の中心', () => {
  const rect = { x: 10, y: 20, w: 40, h: 30 };
  const view = fitViewToRect(rect, FRAME, LIMITS);
  const usableW = FRAME.width - 2 * FIGURE_MARGIN_PX, usableH = FRAME.height - 2 * FIGURE_MARGIN_PX;
  approx(view.scale, Math.min(usableW / 40, usableH / 30));
  assert.equal(view.cx, 30);
  assert.equal(view.cy, 35);
  const t = tOf(view);
  assert.ok(t.tx(rect.x) >= FIGURE_MARGIN_PX - 1e-9 && t.tx(rect.x + rect.w) <= FRAME.width - FIGURE_MARGIN_PX + 1e-9);
  assert.ok(t.ty(rect.y) >= FIGURE_MARGIN_PX - 1e-9 && t.ty(rect.y + rect.h) <= FRAME.height - FIGURE_MARGIN_PX + 1e-9);
  // 縦長の矩形では高さが律速
  const tall = fitViewToRect({ x: 0, y: 0, w: 10, h: 200 }, FRAME, LIMITS);
  approx(tall.scale, usableH / 200);
});

test('fitViewToRect: 極小の矩形は maxScale で頭打ち。全体と同じ以下の縮尺は null', () => {
  assert.equal(fitViewToRect({ x: 0, y: 0, w: 0.1, h: 0.1 }, FRAME, LIMITS).scale, FIGURE_VIEW_MAX_SCALE);
  assert.equal(fitViewToRect({ x: 0, y: 0, w: 1e5, h: 1e5 }, FRAME, LIMITS), null);
});

test('【失敗系】fitViewToRect: 無効な矩形（null・幅 0・負・NaN）は null', () => {
  for (const r of [null, undefined, { x: 0, y: 0, w: 0, h: 10 }, { x: 0, y: 0, w: 10, h: -1 }, { x: NaN, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: Infinity, h: 1 }]) {
    assert.equal(fitViewToRect(r, FRAME, LIMITS), null);
  }
});

test('【失敗系】非有限・scale 0 以下・frame が余白以下・limits 不正は RangeError', () => {
  const ok = { scale: 1, cx: 0, cy: 0 };
  for (const bad of [{ scale: 0, cx: 0, cy: 0 }, { scale: -1, cx: 0, cy: 0 }, { scale: NaN, cx: 0, cy: 0 }, { scale: 1, cx: Infinity, cy: 0 }, null]) {
    assert.throws(() => viewBounds(bad, FRAME), RangeError);
    assert.throws(() => zoomViewAt(bad, { x: 0, y: 0 }, 1.1, LIMITS), RangeError);
    assert.throws(() => panView(bad, 1, 1, CONTENT), RangeError);
  }
  for (const f of [{ width: 2 * FIGURE_MARGIN_PX, height: 480 }, { width: 560, height: 10 }, { width: NaN, height: 480 }, null]) {
    assert.throws(() => viewBounds(ok, f), RangeError);
    assert.throws(() => fitViewToRect({ x: 0, y: 0, w: 1, h: 1 }, f, LIMITS), RangeError);
  }
  assert.throws(() => zoomViewAt(ok, { x: NaN, y: 0 }, 1.1, LIMITS), RangeError);
  assert.throws(() => zoomViewAt(ok, { x: 0, y: 0 }, 0, LIMITS), RangeError);
  assert.throws(() => zoomViewAt(ok, { x: 0, y: 0 }, 1.1, { minScale: 5, maxScale: 1 }), RangeError);
  assert.throws(() => zoomViewAt(ok, { x: 0, y: 0 }, 1.1, { minScale: 0, maxScale: 20 }), RangeError);
  assert.throws(() => panView(ok, NaN, 0, CONTENT), RangeError);
  assert.throws(() => panView(ok, 1, 1, { minX: NaN, maxX: 1, minY: 0, maxY: 1 }), RangeError);
});

test('【失敗系】pinchView: 開始時に 2 指が同じ点は startView をそのまま返す（UI 由来なので例外にしない）。指の位置が非有限は RangeError', () => {
  const start = { scale: 1, cx: 0, cy: 0 };
  const t0 = tOf(start);
  const p = { x: 100, y: 100 };
  assert.equal(pinchView(start, t0, p, p, { x: 0, y: 0 }, { x: 10, y: 0 }, LIMITS, CONTENT), start);
  assert.throws(() => pinchView(start, t0, p, { x: 200, y: 100 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { minScale: 5, maxScale: 1 }, CONTENT), RangeError);
  assert.throws(() => pinchView(start, t0, p, { x: 200, y: 100 }, { x: 0, y: 0 }, { x: 100, y: 0 }, LIMITS, null), RangeError);
  assert.throws(() => fitViewToRect({ x: 0, y: 0, w: 1, h: 1 }, FRAME, { minScale: 5, maxScale: 1 }), RangeError);
  assert.throws(() => zoomViewAt(start, null, 1.1, LIMITS), RangeError);
  assert.throws(() => panView(start, 1, 1, null), RangeError);
  assert.throws(() => viewOfTransform(makeTransform(CONTENT, AUTO), { width: 10, height: 10 }), RangeError);
  assert.throws(() => pinchView(start, t0, p, { x: 200, y: 100 }, { x: NaN, y: 0 }, { x: 10, y: 0 }, LIMITS, CONTENT), RangeError);
});

// ---- AutoScaledFigure への受け渡し・import の守り（ソースの形で固定。AutoScaledFigure.jsx は node:test から読めないため） ----
const here = import.meta.dirname;
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const figureSrc = stripComments(fs.readFileSync(path.join(here, 'AutoScaledFigure.jsx'), 'utf8'));

test('【配線】AutoScaledFigure: view は study が無いときだけ viewBounds で枠を作り、makeTransform は 1 回・overflow hidden は view のときだけ', () => {
  assert.match(figureSrc, /const viewed = !!view && !study;/);
  assert.match(figureSrc, /viewed \? viewBounds\(view, \{ width: maxWidth, height: maxHeight \}\)/);
  assert.match(figureSrc, /const scale = viewed \? view\.scale : autoScale;/);
  assert.equal((figureSrc.match(/makeTransform\(/g) ?? []).length, 1);
  assert.match(figureSrc, /const t = makeTransform\(frameBounds, scale\);/);
  assert.match(figureSrc, /\.\.\.\(viewed \? \{ overflow: 'hidden' \} : null\)/);
  assert.match(figureSrc, /<svg ref=\{svgRef\}/);
  assert.match(figureSrc, /overlay\?\.\(t, \{ autoScale, contentBounds: baseBounds \}\)/);
  // view も overlay も渡さない既存の利用者のための既定値
  assert.match(figureSrc, /view = null, svgRef \}\)/);
});

test('transformOfView: viewBounds→makeTransform と同じ変換。自動縮尺の t から作った view でも同じ mm が同じ px に来る（ジェスチャー層の startT）', () => {
  const view = { scale: 3, cx: 100, cy: 200 };
  const t = transformOfView(view, FRAME);
  approx(t.pxWidth, FRAME.width);
  approx(t.tx(view.cx), FRAME.width / 2);
  approx(t.scale, 3);
  const autoT = makeTransform({ minX: 0, minY: 0, maxX: 300, maxY: 100, width: 300, height: 100 }, 1);
  const base = transformOfView(viewOfTransform(autoT, FRAME), FRAME);
  for (const mm of [0, 120, 300]) {
    approx(base.tx(mm), autoT.tx(mm));
    approx(base.ty(mm), autoT.ty(mm));
  }
});

test('autoScaleOfPrimitives: AutoScaledFigure と同じ式（figureBounds→chooseScale）。viewLimitsOf は全体〜20 で、極小の図では最大を全体に合わせる', () => {
  const prims = [{ type: 'rect', x: 0, y: 0, w: 800, h: 500 }];
  assert.equal(autoScaleOfPrimitives(prims, FRAME), chooseScale(800, 500, FRAME.width, FRAME.height));
  assert.deepEqual(viewLimitsOf(0.5), { minScale: 0.5, maxScale: FIGURE_VIEW_MAX_SCALE });
  assert.deepEqual(viewLimitsOf(25), { minScale: 25, maxScale: 25 });
});

test('【失敗系】autoScaleOfPrimitives: プリミティブが空・frame が余白以下は RangeError', () => {
  assert.throws(() => autoScaleOfPrimitives([], FRAME), RangeError);
  assert.throws(() => autoScaleOfPrimitives([{ type: 'rect', x: 0, y: 0, w: 1, h: 1 }], { width: 40, height: 480 }), RangeError);
});

test('【不変条件】figureView.js の import は sectionGeometry.js だけ（store・snap・.jsx・react を引かない）', () => {
  const src = fs.readFileSync(path.join(here, 'figureView.js'), 'utf8');
  const specs = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.deepEqual(specs, ['./sectionGeometry.js']);
  assert.equal((src.match(/^\s*import\s/gm) ?? []).length, 1);
  assert.equal(/\bimport\(/.test(src), false); // 動的 import も無い
  // sectionGeometry.js 自体も何も引かない（推移的に純）
  const geo = fs.readFileSync(path.join(here, 'sectionGeometry.js'), 'utf8');
  assert.deepEqual([...geo.matchAll(/^\s*import\s/gm)], []);
});
