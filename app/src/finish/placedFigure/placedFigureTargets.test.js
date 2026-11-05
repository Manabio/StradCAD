// 姿図の配置の基準供給（finish/placedFigure/placedFigureTargets.js。部分詳細図 S10 P2-2）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PenDir, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis, DetailDash, DetailParam,
  DetailPlacementView, DETAIL_FIGURE_VERSION,
} from '../../core/constants.js';
import { fitLocal, DetailFitError } from '../../detail/detailPlacement.js';
import { RoomDetailError } from '../roomDetailTargets.js';
import { ERR_DETAIL_DATUM_UNSUPPORTED, DETAIL_TARGET_PLACED_FIGURE } from '../../error.js';
import { fixedLen, stretchLen, paramLen, materialLen, move } from '../roomDetailTestFixtures.js';
import { placedFigureTargets, isPlacementFigure, isPlaceableViewFigure } from './placedFigureTargets.js';

const LINE = { weightRole: 'medium', dashRole: DetailDash.SOLID };

// L 字。右 20・下 10（頂点 2＝(20,10)）→右 15・下 25・左 35（閉）。s・t の PLACEMENT_ORIGIN は頂点 2。
function lShape({ category = DetailCategory.FIGURE, view = DetailView.PLAN, subject = DetailSubject.SANITARY, datums, moves } = {}) {
  return {
    key: 'df-pf', version: DETAIL_FIGURE_VERSION, label: 'L字', category, view, subject,
    strokes: [{ id: 'a', closed: true, line: LINE, moves: moves ?? [
      move(PenDir.RIGHT, fixedLen(20)), move(PenDir.DOWN, fixedLen(10)), move(PenDir.RIGHT, fixedLen(15)),
      move(PenDir.DOWN, fixedLen(25)), move(PenDir.LEFT, fixedLen(35)),
    ] }],
    datums: datums ?? [
      { id: 'ds0', role: DetailDatumRole.PLACEMENT_ORIGIN, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
      { id: 'dt0', role: DetailDatumRole.PLACEMENT_ORIGIN, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
    ],
    anchors: [
      { datumId: 'ds0', strokeId: 'a', vertexIndex: 2 },
      { datumId: 'dt0', strokeId: 'a', vertexIndex: 2 },
    ],
    provenance: null, note: null,
  };
}
const withDatum = (fig, d) => ({ ...fig, datums: [...fig.datums, { id: 'dx', offsetMm: 0, ...d }] });

test('PLACEMENT_ORIGIN だけの L 字は targets が全 0 で、fitLocal が頂点 (20,10) を原点に (−20,−10) 起点へ解く', () => {
  const t = placedFigureTargets(lShape());
  assert.deepEqual(t.targets, { datums: { ds0: 0, dt0: 0 }, params: {}, materials: {} });
  const fitted = fitLocal(lShape(), t.targets);
  assert.equal(fitted.error, undefined);
  assert.deepEqual(fitted.strokes[0].points.map(p => [p.s, p.t]), [[-20, -10], [0, -10], [0, 0], [15, 0], [15, 25], [-20, 25]]);
});

test('立面側の姿図（FIGURE/ELEVATION/家具）・見上げの姿図（FIGURE/PLAN/空調）も同じ関数で解ける', () => {
  for (const fig of [lShape({ view: DetailView.ELEVATION, subject: DetailSubject.FURNITURE }), lShape({ subject: DetailSubject.HVAC })]) {
    const t = placedFigureTargets(fig);
    assert.deepEqual(t.targets.datums, { ds0: 0, dt0: 0 });
    assert.equal(fitLocal(fig, t.targets).error, undefined);
  }
});

test('【失敗系】PLACEMENT_ORIGIN 以外の role・end は UNSUPPORTED_DATUM（文言の主語は「姿図の配置」）', () => {
  const unsupported = [
    { role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN },
    { role: DetailDatumRole.OPENING_OUTER, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN },
    { role: DetailDatumRole.PLACEMENT_ORIGIN, axis: DetailAxis.S, kind: DetailDatumKind.END },
    { role: DetailDatumRole.FL, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN },
  ];
  for (const d of unsupported) {
    const r = placedFigureTargets(withDatum(lShape(), d));
    assert.equal(r.error?.code, RoomDetailError.UNSUPPORTED_DATUM, JSON.stringify(d));
    assert.equal(r.error.message, ERR_DETAIL_DATUM_UNSUPPORTED('dx', `${d.role}・${d.axis}・${d.kind}`, DETAIL_TARGET_PLACED_FIGURE));
  }
  assert.match(placedFigureTargets(withDatum(lShape(), unsupported[0])).error.message, /姿図の配置では使えません/);
});

test('【失敗系】param・材・伸縮の束縛は targets に載せず、fit が UNRESOLVED_PARAM／UNRESOLVED_MATERIAL／INVALID で落とす', () => {
  const run = len => {
    const fig = lShape({ moves: [move(PenDir.RIGHT, fixedLen(20)), move(PenDir.DOWN, fixedLen(10)), move(PenDir.RIGHT, len)] });
    return fitLocal(fig, placedFigureTargets(fig).targets).error?.code;
  };
  assert.equal(run(paramLen(DetailParam.WALL_THICKNESS, 5)), DetailFitError.UNRESOLVED_PARAM);
  assert.equal(run(materialLen('101000000001', 'thickness', 5)), DetailFitError.UNRESOLVED_MATERIAL);
  assert.equal(run(stretchLen(5)), DetailFitError.INVALID, '伸縮は end の基準が無いと図として成立しない');
});

test('【失敗系】配置図でない分類（建具の姿図・paired・part）は UNSUPPORTED_SLOT。fig が null・datums 無しは落ちない', () => {
  for (const over of [
    { view: DetailView.ELEVATION, subject: DetailSubject.OPENING },
    { category: DetailCategory.PAIRED, view: DetailView.PLAN, subject: DetailSubject.JAMB },
    { category: DetailCategory.PART, view: DetailView.SECTION, subject: DetailSubject.WALL },
  ]) {
    assert.equal(placedFigureTargets(lShape(over)).error.code, RoomDetailError.UNSUPPORTED_SLOT, JSON.stringify(over));
  }
  assert.equal(placedFigureTargets(null).error.code, RoomDetailError.UNSUPPORTED_SLOT);
  assert.deepEqual(placedFigureTargets({ ...lShape(), datums: undefined }).targets.datums, {});
  assert.doesNotThrow(() => placedFigureTargets({ ...lShape(), datums: [null, ...lShape().datums] }));
});

test('isPlacementFigure: 平面・立面側の衛生/家具/空調の姿図だけ true', () => {
  for (const subject of [DetailSubject.SANITARY, DetailSubject.FURNITURE, DetailSubject.HVAC]) {
    assert.equal(isPlacementFigure(lShape({ subject })), true);
    assert.equal(isPlacementFigure(lShape({ subject, view: DetailView.ELEVATION })), true);
  }
  assert.equal(isPlacementFigure(lShape({ subject: DetailSubject.OPENING })), false);
  assert.equal(isPlacementFigure(lShape({ view: DetailView.SECTION })), false);
  assert.equal(isPlacementFigure(null), false);
});

test('isPlaceableViewFigure: front〜right は FIGURE/ELEVATION/配置 subject・ceiling は FIGURE/PLAN/空調だけ', () => {
  const elev = lShape({ view: DetailView.ELEVATION, subject: DetailSubject.SANITARY });
  const ceil = lShape({ subject: DetailSubject.HVAC });
  for (const v of [DetailPlacementView.FRONT, DetailPlacementView.BACK, DetailPlacementView.LEFT, DetailPlacementView.RIGHT]) {
    assert.equal(isPlaceableViewFigure(elev, v), true, v);
    assert.equal(isPlaceableViewFigure(ceil, v), false, `平面の図は ${v} に置けない`);
  }
  assert.equal(isPlaceableViewFigure(elev, DetailPlacementView.CEILING), false);
  assert.equal(isPlaceableViewFigure(ceil, DetailPlacementView.CEILING), true);
  // subject 違い・分類違い・未知の view・null
  assert.equal(isPlaceableViewFigure(lShape({ subject: DetailSubject.SANITARY }), DetailPlacementView.CEILING), false, '衛生器具は見上げに出ない');
  assert.equal(isPlaceableViewFigure(lShape({ view: DetailView.ELEVATION, subject: DetailSubject.OPENING }), DetailPlacementView.FRONT), false);
  assert.equal(isPlaceableViewFigure(elev, 'top'), false);
  assert.equal(isPlaceableViewFigure(null, DetailPlacementView.FRONT), false);
});
