// facade/facadeLayout.js の単体テスト。期待値は sectionGeometry.js の NICE_SCALES と FIGURE_MARGIN_PX=32 から手で計算する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseFacadeScale, layoutFacadeFaces } from './facadeLayout.js';
import { chooseScale } from '../structural/sectionFigure/sectionGeometry.js';

// 画面 1032×1000px・校正 1px/mm。注記: 横＝2×10mm＝20px、縦＝6mm＋見出し13px＝19px、余白 2×32px。
// 使える幅＝1032−20−64＝948px、高さ＝1000−19−64＝917px。
const VIEW = { viewWidthPx: 1032, viewHeightPx: 1000, screenPxPerMm: 1 };

test('chooseFacadeScale: 横長の建物は横幅で決まる（948/10000＝0.0948 → 1/15）', () => {
  assert.equal(chooseFacadeScale({ maxWidthMm: 10000, maxHeightMm: 1000, ...VIEW }), 1 / 15);
});

test('chooseFacadeScale: 縦長は高さで決まる（917/20000＝0.0459 → 1/25）', () => {
  assert.equal(chooseFacadeScale({ maxWidthMm: 1000, maxHeightMm: 20000, ...VIEW }), 1 / 25);
});

test('chooseFacadeScale: 注記の分を差し引くので、注記なしなら 1/10 に収まる幅でも 1/15 になる（948/9600＜0.1≦968/9600）', () => {
  assert.equal(chooseScale(9600, 1000, VIEW.viewWidthPx, VIEW.viewHeightPx), 1 / 10, '前提: 注記なしなら 1/10');
  assert.equal(chooseFacadeScale({ maxWidthMm: 9600, maxHeightMm: 1000, ...VIEW }), 1 / 15);
});

test('layoutFacadeFaces: 面を上から gapMm 空けて積み、各面の bounds の中心を画面の中央に揃える', () => {
  const faces = [
    { direction: 'east', bounds: { minX: -100, minY: -3460, maxX: 6100, maxY: 0 } },
    { direction: 'south', bounds: { minX: -100, minY: -3460, maxX: 8100, maxY: 0 } },
  ];
  // 画面幅 1000px・倍率 0.1 → 10000mm。中心 5000。
  const r = layoutFacadeFaces(faces, { scale: 0.1, viewWidthPx: 1000, gapMm: 200 });
  assert.deepEqual(r.placements, [
    { direction: 'east',  topMm: 0,    heightMm: 3460, originXMm: 2000, originYMm: 3460 },
    { direction: 'south', topMm: 3660, heightMm: 3460, originXMm: 1000, originYMm: 7120 },
  ]);
  assert.equal(r.contentHeightMm, 7120);
  assert.deepEqual(r.layout.placements.map(p => p.roomId), ['east', 'south']);
});

test('【失敗系】layoutFacadeFaces: 面が無ければ空・倍率0でも例外にならない', () => {
  const r = layoutFacadeFaces([], { scale: 0, viewWidthPx: 1000, gapMm: 200 });
  assert.deepEqual(r.placements, []);
  assert.equal(r.contentHeightMm, 0);
});
