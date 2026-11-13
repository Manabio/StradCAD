// 姿図の配置を展開図へ出すときの向きと図の選び方（finish/placedFigure/placedFigureViews.js。部分詳細図 S10 P5）の単体テスト。
// viewForFace の表は手計算で固定する（実装の式を写さない）。
//   回転 θ の正面方向 f＝(−sin θ, cos θ)（y 下向き正）: 0→(0,1)南・90→(−1,0)西・180→(0,−1)北・270→(1,0)東
//   右手 ρ＝(−f_y, f_x): 0→(−1,0)西・90→(0,−1)北・180→(1,0)東・270→(0,1)南
//   d＝部屋側から壁へ。f＝−d→正面・f＝d→背面・−d＝ρ→右・それ以外→左
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PenDir, DetailView, DetailPlacementView, DetailDatumRole, DetailDatumKind, DetailAxis, DetailDash, PLACED_FIGURE_WEIGHT_ROLE,
} from '../../core/constants.js';
import { fixedLen, move } from '../roomDetailTestFixtures.js';
import { PlacedFigure } from '../../core/placedFigure.js';
import { square, wallFaceDatums } from './placedFigureTestFixtures.js';
import {
  frontDirOf, rightHandOf, viewForFace, resolvePlacedView, fitPlacedView, sRangeOf, placeViewStrokes,
} from './placedFigureViews.js';

const { FRONT, BACK, LEFT, RIGHT } = DetailPlacementView;
const pfAt = (rotationDeg, mirror = false) => new PlacedFigure({ id: 'p', figureKey: 'k', x: 300, y: 100, rotationDeg, mirror });

test('frontDirOf: 4 回転の正面方向（整数・-0 を含まない）', () => {
  assert.deepEqual(frontDirOf(pfAt(0)), [0, 1]);
  assert.deepEqual(frontDirOf(pfAt(90)), [-1, 0]);
  assert.deepEqual(frontDirOf(pfAt(180)), [0, -1]);
  assert.deepEqual(frontDirOf(pfAt(270)), [1, 0]);
});

test('rightHandOf: 南向き (0,1) の右手は西 (−1,0)・東向き (1,0) の右手は南 (0,1)', () => {
  assert.deepEqual(rightHandOf([0, 1]), [-1, 0]);
  assert.deepEqual(rightHandOf([1, 0]), [0, 1]);
  assert.deepEqual(rightHandOf([0, -1]), [1, 0]);
  assert.deepEqual(rightHandOf([-1, 0]), [0, -1]);
});

// [回転, d, 期待する view]（上のヘッダの手計算）
const TABLE = [
  [0, [0, -1], FRONT], [0, [0, 1], BACK], [0, [1, 0], RIGHT], [0, [-1, 0], LEFT],
  [90, [1, 0], FRONT], [90, [-1, 0], BACK], [90, [0, 1], RIGHT], [90, [0, -1], LEFT],
  [180, [0, 1], FRONT], [180, [0, -1], BACK], [180, [-1, 0], RIGHT], [180, [1, 0], LEFT],
  [270, [-1, 0], FRONT], [270, [1, 0], BACK], [270, [0, -1], RIGHT], [270, [0, 1], LEFT],
];

test('viewForFace: 回転 4 × d 4 方向＝16 通りを手計算の表で固定（鏡像なし。mirrorS は false）', () => {
  for (const [deg, d, view] of TABLE) {
    assert.deepEqual(viewForFace(pfAt(deg), d), { view, mirrorS: false }, `回転 ${deg} d=${JSON.stringify(d)}`);
  }
});

test('viewForFace: 鏡像は LEFT↔RIGHT を入れ替え、全 view で mirrorS が true（FRONT／BACK も s 反転）', () => {
  const swap = { [FRONT]: FRONT, [BACK]: BACK, [LEFT]: RIGHT, [RIGHT]: LEFT };
  for (const [deg, d, view] of TABLE) {
    assert.deepEqual(viewForFace(pfAt(deg, true), d), { view: swap[view], mirrorS: true }, `回転 ${deg} d=${JSON.stringify(d)}`);
  }
});

// 立面側の姿図（L 字。頂点 2（200,100）が配置原点＝局所の s 範囲 −200..150・t 範囲 −100..250）
function lElevation(key, over = {}) {
  return {
    ...square(key, { view: DetailView.ELEVATION }),
    strokes: [{ id: 'a', closed: true, line: { weightRole: 'medium', dashRole: DetailDash.SOLID }, moves: [
      move(PenDir.RIGHT, fixedLen(200)), move(PenDir.DOWN, fixedLen(100)), move(PenDir.RIGHT, fixedLen(150)),
      move(PenDir.DOWN, fixedLen(250)), move(PenDir.LEFT, fixedLen(350)),
    ] }],
    datums: [
      { id: 'ds0', role: DetailDatumRole.PLACEMENT_ORIGIN, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
      { id: 'dt0', role: DetailDatumRole.PLACEMENT_ORIGIN, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
    ],
    anchors: [
      { datumId: 'ds0', strokeId: 'a', vertexIndex: 2 },
      { datumId: 'dt0', strokeId: 'a', vertexIndex: 2 },
    ],
    ...over,
  };
}

const catalogOf = (...figs) => { const m = new Map(figs.map(f => [f.key, f])); return key => m.get(key) ?? null; };
const mainFig = views => square('main', { views });

test('resolvePlacedView: 設定された view の図をそのまま返す（mirrorS は false）', () => {
  const figureOf = catalogOf(lElevation('eL'), lElevation('eR'));
  const r = resolvePlacedView(mainFig({ [LEFT]: 'eL', [RIGHT]: 'eR' }), RIGHT, figureOf);
  assert.equal(r.key, 'eR');
  assert.equal(r.fig.key, 'eR');
  assert.equal(r.mirrorS, false);
});

test('resolvePlacedView: left 無し→right の鏡像・right 無し→left の鏡像で代用（mirrorS true）', () => {
  const figureOf = catalogOf(lElevation('eL'), lElevation('eR'));
  const viaRight = resolvePlacedView(mainFig({ [RIGHT]: 'eR' }), LEFT, figureOf);
  assert.deepEqual({ key: viaRight.key, mirrorS: viaRight.mirrorS }, { key: 'eR', mirrorS: true });
  const viaLeft = resolvePlacedView(mainFig({ [LEFT]: 'eL' }), RIGHT, figureOf);
  assert.deepEqual({ key: viaLeft.key, mirrorS: viaLeft.mirrorS }, { key: 'eL', mirrorS: true });
});

test('【失敗系】resolvePlacedView: front／back が無ければ null（左右の代用は front／back にはしない）', () => {
  const figureOf = catalogOf(lElevation('eF'), lElevation('eR'));
  assert.equal(resolvePlacedView(mainFig({ [RIGHT]: 'eR' }), FRONT, figureOf), null);
  assert.equal(resolvePlacedView(mainFig({ [FRONT]: 'eF' }), BACK, figureOf), null);
  assert.equal(resolvePlacedView(mainFig(undefined), FRONT, figureOf), null);
  assert.equal(resolvePlacedView(null, FRONT, figureOf), null);
});

test('【失敗系】resolvePlacedView: 参照切れ・分類違い（平面の図）は null。設定済みの不良は反対側で代用しない', () => {
  const figureOf = catalogOf(lElevation('eR'), square('plan'));
  assert.equal(resolvePlacedView(mainFig({ [FRONT]: 'gone' }), FRONT, figureOf), null);
  assert.equal(resolvePlacedView(mainFig({ [FRONT]: 'plan' }), FRONT, figureOf), null);
  assert.equal(resolvePlacedView(mainFig({ [LEFT]: 'gone', [RIGHT]: 'eR' }), LEFT, figureOf), null);
  assert.equal(resolvePlacedView(mainFig({ [LEFT]: 'plan', [RIGHT]: 'eR' }), LEFT, figureOf), null);
  assert.equal(resolvePlacedView(mainFig({ [FRONT]: 5 }), FRONT, figureOf), null);
});

test('placeViewStrokes: 線の太さの指定は PLACED_FIGURE_WEIGHT_ROLE へ置換し、破線などの dashRole は残す。入力（fit 済みの図）は変えない', () => {
  const stroke = (weightRole, dashRole) => ({ id: weightRole, closed: false, line: { weightRole, dashRole }, points: [{ s: 0, t: 0 }, { s: 10, t: 5 }] });
  const fitted = { strokes: [stroke('ultraThick', DetailDash.DASHED), stroke('thick', DetailDash.SOLID), stroke('medium', DetailDash.SWING)] };
  const placed = placeViewStrokes(fitted, true);
  assert.deepEqual(placed.map(st => st.line.weightRole), [PLACED_FIGURE_WEIGHT_ROLE, PLACED_FIGURE_WEIGHT_ROLE, PLACED_FIGURE_WEIGHT_ROLE]);
  assert.deepEqual(placed.map(st => st.line.dashRole), [DetailDash.DASHED, DetailDash.SOLID, DetailDash.SWING]);
  assert.deepEqual(fitted.strokes.map(st => st.line.weightRole), ['ultraThick', 'thick', 'medium'], '入力は不変');
  assert.deepEqual(placed[0].points, [[0, 0], [-10, 5]], '座標の写像は従来どおり');
});

test('fitPlacedView／sRangeOf／placeViewStrokes: L 字（配置原点＝頂点 (200,100)）の s 範囲は −200..150。反転すると −150..200', () => {
  const fitted = fitPlacedView(lElevation('eL'));
  assert.equal(fitted.error, undefined);
  assert.deepEqual(sRangeOf(fitted.strokes), { min: -200, max: 150 });
  const xs = strokes => strokes.flatMap(st => st.points.map(p => p[0]));
  assert.deepEqual([Math.min(...xs(placeViewStrokes(fitted, false))), Math.max(...xs(placeViewStrokes(fitted, false)))], [-200, 150]);
  assert.deepEqual([Math.min(...xs(placeViewStrokes(fitted, true))), Math.max(...xs(placeViewStrokes(fitted, true)))], [-150, 200]);
  const ys = placeViewStrokes(fitted, true).flatMap(st => st.points.map(p => p[1]));
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [-100, 250], 't は反転しない');
});

test('【失敗系】fitPlacedView: 基準を供給できない図は {error}（例外にしない）。sRangeOf は点が無ければ null', () => {
  const r = fitPlacedView(lElevation('bad', { datums: wallFaceDatums() }));
  assert.ok(r.error);
  assert.equal(r.strokes, undefined);
  assert.equal(sRangeOf([]), null);
  assert.equal(sRangeOf([{ points: [] }]), null);
});
