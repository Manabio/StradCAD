// 姿図の部分詳細図の「見る側」対応（T2-1）のテスト。
// 開き勝手線（dashRole=SWING）は towardViewer===false のときだけ一点鎖線、slot=figureBack は towardViewer===false のときだけ先に探す。
// 座標は FL を y=0・上方は負。fixture は幅 870・高さ 2030・破線の x（dashX）130／250 と非対称・非ゼロの値にする。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OpeningCategory } from '@core';
import { clearOverlays } from '../catalog/catalogRegistry.js';
import { DetailSlot, DetailDash, DETAIL_PRIM_SOURCE, FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD } from '../core/constants.js';
import { computeEnvelope } from '../detail/detailPlacement.js';
import { buildOpeningElevation } from './openingElevationFigure.js';
import { resolveDetailElevation } from './openingDetailFit.js';
import { elevationFigure, subTypeEntry, installElevationFigures } from './openingDetailTestFixtures.js';

test.afterEach(() => clearOverlays());

const { FIGURE, FIGURE_BACK } = DetailSlot;
const W = 870, H = 2030;
const door = (over = {}) => ({
  category: OpeningCategory.FITTING, subType: 'singleSwing', width: W, height: H, hingeSide: -1, swingSide: 1, ...over,
});

/** elevationFigure の破線ストローク（dash）の役割を差し替えた姿図。dashRole 省略は SWING。 */
function figureWithDash(key, { dashX = 130, dashRole = DetailDash.SWING } = {}) {
  const f = elevationFigure(key, { dashX });
  return { ...f, strokes: f.strokes.map(s => (s.id === 'dash' ? { ...s, line: { weightRole: 'thin', dashRole } } : s)) };
}
const detailPrims = prims => prims.filter(p => p.source === DETAIL_PRIM_SOURCE);
const num = v => v + 0; // -0 → +0
const dashLines = prims => detailPrims(prims).filter(p => p.type === 'line');
// dash ストロークが作る 2 本の線分（(0,0)→(dashX,0)→(dashX,−H)）の端点
const swingLinePoints = dashX => [[0, 0, dashX, 0], [dashX, 0, dashX, -H]];
const linePoints = prims => prims.map(p => [num(p.x1), num(p.y1), num(p.x2), num(p.y2)]);

// ---- 線種 ----

test('SWING の線: towardViewer false→一点鎖線の線分・true／null→実線の折れ線（dash なし）', () => {
  installElevationFigures([figureWithDash('sw')]);
  const o = { ...door(), detailRefs: { [FIGURE]: 'sw' } };

  const away = resolveDetailElevation({ opening: o, towardViewer: false });
  const swing = away.primitives.filter(p => p.type === 'line');
  assert.equal(swing.length, 2);
  assert.ok(swing.every(p => p.dash === 'center' && p.weight === 'thin' && p.source === DETAIL_PRIM_SOURCE));
  assert.deepEqual(linePoints(swing), swingLinePoints(130));

  for (const toward of [true, null]) {
    const r = resolveDetailElevation({ opening: o, towardViewer: toward });
    assert.equal(r.primitives.filter(p => p.type === 'line').length, 0, `towardViewer=${toward}: 線分は無い`);
    const poly = r.primitives.filter(p => p.type === 'polyline' && p.weight === 'thin');
    assert.equal(poly.length, 1);
    assert.equal(poly[0].dash, undefined);
    assert.deepEqual(poly[0].points.map(p => p.map(num)), [[0, 0], [130, 0], [130, -H]]);
  }
  // 省略（既定）は null と同じ
  assert.deepEqual(resolveDetailElevation({ opening: o }).primitives, resolveDetailElevation({ opening: o, towardViewer: null }).primitives);
});

test('DASHED は towardViewer に依らず破線・SOLID は実線のまま不変', () => {
  installElevationFigures([figureWithDash('ds', { dashRole: DetailDash.DASHED })]);
  const o = { ...door(), detailRefs: { [FIGURE]: 'ds' } };
  for (const toward of [false, true, null]) {
    const r = resolveDetailElevation({ opening: o, towardViewer: toward });
    const lines = r.primitives.filter(p => p.type === 'line');
    assert.equal(lines.length, 2, `towardViewer=${toward}`);
    assert.ok(lines.every(p => p.dash === 'dashed'), `towardViewer=${toward}`);
    const solid = r.primitives.filter(p => p.type === 'polyline');
    assert.equal(solid.length, 2, 'lt／br は実線の折れ線');
    assert.ok(solid.every(p => p.dash === undefined && p.weight === 'medium'));
  }
});

// ---- 解決順 ----

const dashXOf = r => {
  const lines = r.primitives.filter(p => p.type === 'line');
  const poly = r.primitives.find(p => p.type === 'polyline' && p.weight === 'thin');
  return lines.length > 0 ? num(lines[0].x2) : num(poly.points[1][0]);
};
const REFS_FIELD = FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD;

test('解決順: towardViewer false は detailRefs.figureBack ＞ 種別.figureBack ＞ figure', () => {
  installElevationFigures([figureWithDash('f-front', { dashX: 130 }), figureWithDash('f-op', { dashX: 250 }), figureWithDash('f-st', { dashX: 310 })]);
  const entry = subTypeEntry('st', null, { [REFS_FIELD]: { [FIGURE]: 'f-front', [FIGURE_BACK]: 'f-st' } });
  const withOpening = { ...door(), detailRefs: { [FIGURE_BACK]: 'f-op' } };
  const r1 = resolveDetailElevation({ opening: withOpening, entry, towardViewer: false });
  assert.equal(r1.slot, FIGURE_BACK);
  assert.equal(dashXOf(r1), 250, 'detailRefs.figureBack が種別の figureBack に勝つ');
  const r2 = resolveDetailElevation({ opening: door(), entry, towardViewer: false });
  assert.equal(r2.slot, FIGURE_BACK);
  assert.equal(dashXOf(r2), 310, '種別の figureBack');
  const r3 = resolveDetailElevation({ opening: { ...door(), detailRefs: { [FIGURE]: 'f-front' } }, towardViewer: false });
  assert.equal(r3.slot, FIGURE, 'figureBack が無ければ figure');
  assert.equal(dashXOf(r3), 130);
});

test('解決順: towardViewer true／null は figureBack があっても figure だけを使う', () => {
  installElevationFigures([figureWithDash('f-front', { dashX: 130 }), figureWithDash('f-back', { dashX: 250 })]);
  const o = { ...door(), detailRefs: { [FIGURE]: 'f-front', [FIGURE_BACK]: 'f-back' } };
  for (const toward of [true, null, undefined]) {
    const r = resolveDetailElevation({ opening: o, towardViewer: toward });
    assert.equal(r.slot, FIGURE, `towardViewer=${toward}`);
    assert.equal(dashXOf(r), 130, `towardViewer=${toward}`);
  }
  assert.equal(resolveDetailElevation({ opening: o, towardViewer: false }).slot, FIGURE_BACK);
});

test('【失敗系】figureBack が参照切れ・fit 不能なら figure へ落ちる／figure も無ければ null／figureBack だけで figure 無しなら向こう側のときだけ描く', () => {
  installElevationFigures([
    figureWithDash('f-front', { dashX: 130 }),
    { ...elevationFigure('f-bad', { dashX: 250, sFixed: 5000 }) }, // 幅 870 では固定寸法が目標を超える
    figureWithDash('f-back', { dashX: 250 }),
  ]);
  const missing = { ...door(), detailRefs: { [FIGURE]: 'f-front', [FIGURE_BACK]: 'no-such-figure' } };
  const r1 = resolveDetailElevation({ opening: missing, towardViewer: false });
  assert.equal(r1.slot, FIGURE);
  assert.equal(dashXOf(r1), 130);

  const bad = { ...door(), detailRefs: { [FIGURE]: 'f-front', [FIGURE_BACK]: 'f-bad' } };
  const r2 = resolveDetailElevation({ opening: bad, towardViewer: false });
  assert.equal(r2.error, undefined);
  assert.equal(r2.slot, FIGURE);
  assert.equal(dashXOf(r2), 130);

  // figureBack が fit 不能で figure も無い: figure 側の解決は null（従来どおり）
  assert.equal(resolveDetailElevation({ opening: { ...door(), detailRefs: { [FIGURE_BACK]: 'f-bad' } }, towardViewer: false }), null);
  assert.equal(resolveDetailElevation({ opening: door(), towardViewer: false }), null, '図が 1 つも無い');
  const onlyBack = { ...door(), detailRefs: { [FIGURE_BACK]: 'f-back' } };
  assert.equal(resolveDetailElevation({ opening: onlyBack, towardViewer: true }), null, '手前側は figureBack を見ない');
  assert.equal(resolveDetailElevation({ opening: onlyBack, towardViewer: false }).slot, FIGURE_BACK);
});

// ---- 配線・本番経路 ----

test('配線: buildOpeningElevation は towardViewer を resolveDetailElevation へ渡す', () => {
  const src = readFileSync(new URL('./openingElevationFigure.js', import.meta.url), 'utf8');
  assert.match(src, /resolveDetailElevation\(\{[^}]*\btowardViewer\b[^}]*\}\)/);
});

test('buildOpeningElevation: 姿図に SWING 線を持つ片開き戸は towardViewer false で開き勝手線だけ一点鎖線・他の線は不変', () => {
  installElevationFigures([figureWithDash('sw')]);
  const o = { ...door(), detailRefs: { [FIGURE]: 'sw' } };
  const opts = { tag: null, entry: null, includeDims: false, includeLevelLine: false };
  const away = buildOpeningElevation(o, { ...opts, towardViewer: false });
  const toward = buildOpeningElevation(o, { ...opts, towardViewer: true });
  const unknown = buildOpeningElevation(o, opts);

  assert.deepEqual(linePoints(dashLines(away)), swingLinePoints(130));
  assert.ok(dashLines(away).every(p => p.dash === 'center'));
  assert.equal(dashLines(toward).length, 0);
  assert.equal(dashLines(unknown).length, 0);
  // 実線の折れ線（枠 2 本）は見る側に依らず同一
  const polys = prims => detailPrims(prims).filter(p => p.type === 'polyline' && p.weight === 'medium');
  assert.equal(polys(away).length, 2);
  assert.deepEqual(polys(away), polys(toward));
  assert.deepEqual(polys(away), polys(unknown));
  // 従来の機構の V 字（吊元の一点鎖線）は詳細図があるので出ない
  assert.equal(away.filter(p => p.source !== DETAIL_PRIM_SOURCE && p.dash === 'center').length, 0);
});

test('buildOpeningElevation: towardViewer false で figureBack があれば向こう側の図で描く（true は figure）', () => {
  installElevationFigures([figureWithDash('f-front', { dashX: 130 }), figureWithDash('f-back', { dashX: 250 })]);
  const o = { ...door(), detailRefs: { [FIGURE]: 'f-front', [FIGURE_BACK]: 'f-back' } };
  const opts = { tag: null, entry: null, includeDims: false, includeLevelLine: false };
  assert.deepEqual(linePoints(dashLines(buildOpeningElevation(o, { ...opts, towardViewer: false }))), swingLinePoints(250));
  const front = detailPrims(buildOpeningElevation(o, { ...opts, towardViewer: true })).find(p => p.type === 'polyline' && p.weight === 'thin');
  assert.deepEqual(front.points.map(p => p.map(num)), [[0, 0], [130, 0], [130, -H]]);
});

// ---- 外形（detailEnvelope）----

test('detailEnvelope: SWING の線は外形の計算に入れない（DASHED と同じ）。SOLID は入る', () => {
  const rect = line => ({ id: 'x', points: [[0, -60], [12, -60], [12, 0], [0, 0]].map(([s, t]) => ({ s, t })), closed: true, line });
  const lineOf = dashRole => ({ weightRole: 'medium', dashRole });
  const solid = computeEnvelope([rect(lineOf(DetailDash.SOLID))], DetailSlot.FLOOR_WALL);
  assert.equal(solid.steps.length, 1, '前提: 実線なら段差が出る');
  for (const role of [DetailDash.SWING, DetailDash.DASHED]) {
    const r = computeEnvelope([rect(lineOf(role))], DetailSlot.FLOOR_WALL);
    assert.deepEqual(r.steps, [], role);
    assert.equal(r.maxDeviationMm, 0, role);
  }
});
