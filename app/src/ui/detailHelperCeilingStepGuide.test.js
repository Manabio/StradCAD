import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SvgFigurePrimitiveType, DetailDash, DetailDatumRole, DetailCategory, DetailView, DetailLenMode, PenDir } from '../core/constants.js';
import { PREVIEW_DIM_GAP_MM } from '../detail/detailPreview.js';
import {
  formFromEntry, tryFit, previewPrimitivesOf, setDatumField, DETAIL_ROLE_LABELS,
  newDraft, setClassification, applyPen, setMoveMode, addDatum, setAnchor,
} from './detailHelperForm.js';
import { ceilingNoseFigure } from '../finish/roomDetailTestFixtures.js';

const ceilingForm = () => formFromEntry(ceilingNoseFigure('df-cstep'));
const guidesOf = prims => prims.filter(p => p.guide);
const GAP = PREVIEW_DIM_GAP_MM;

test('基準線: 役割名の表は段差の立ち上がり面を床・天井の両方の説明にしている', () => {
  const label = DETAIL_ROLE_LABELS[DetailDatumRole.STEP_EDGE];
  assert.match(label, /段差の立ち上がり面/);
  assert.match(label, /平面・天伏/);
  assert.doesNotMatch(label, /^床の/);
});

test('基準線: 試し込み後は origin の頂点の位置に破線（s=0 は縦線・t=0 は横線）と役割名。end の基準は出ない', () => {
  const f = ceilingForm();
  const fitted = tryFit(f, { stepHeight: '300' });
  assert.equal(fitted.error, undefined);
  const g = guidesOf(previewPrimitivesOf(f, fitted));
  const lines = g.filter(p => p.type === SvgFigurePrimitiveType.POLYLINE);
  assert.equal(lines.length, 2, 'origin の s・t の 2 本だけ');
  for (const l of lines) assert.equal(l.dash, DetailDash.DASHED);
  assert.deepEqual(lines[0].points, [[0, -300 - GAP], [0, GAP]]);
  assert.deepEqual(lines[1].points, [[-GAP, 0], [120 + GAP, 0]]);
  const texts = g.filter(p => p.type === SvgFigurePrimitiveType.TEXT).map(p => p.text);
  assert.ok(texts.includes(DETAIL_ROLE_LABELS[DetailDatumRole.STEP_EDGE]));
  assert.ok(texts.includes(DETAIL_ROLE_LABELS[DetailDatumRole.CEILING_FACE]));
  for (const p of g) assert.equal(p.editable, undefined);
});

test('基準線: 試し込み後も Datum の offset の位置に出る（s の offset 25 → 縦線は s=25）', () => {
  const f = setDatumField(ceilingForm(), 'ds0', 'offset', '25');
  const fitted = tryFit(f, { stepHeight: '300' });
  assert.equal(fitted.error, undefined);
  const vline = guidesOf(previewPrimitivesOf(f, fitted)).find(p => p.type === SvgFigurePrimitiveType.POLYLINE);
  assert.equal(vline.points[0][0], 25);
});

test('基準線: base≠0 の試し込み（姿図の FL＝窓台高さ）は offsetMm ではなく fit 後の頂点の位置に出る', () => {
  let f = setClassification(setClassification(newDraft({ idFactory: () => 'abc' }), 'category', DetailCategory.FIGURE), 'view', DetailView.ELEVATION);
  for (const [dir, len] of [[PenDir.UP, '50'], [PenDir.RIGHT, '20']]) f = applyPen(f, dir, len).form;
  f = setMoveMode(f, { strokeId: 's1', moveIndex: 0 }, DetailLenMode.STRETCH);
  f = addDatum(f); // t の end（HEAD）
  f = setAnchor(f, 's1', 'd3', 1);
  f = setDatumField(setDatumField(f, 'd2', 'role', DetailDatumRole.FL), 'd2', 'offset', '7');
  const sill = 900;
  const fitted = tryFit(f, { width: '800', height: '2000', sill: String(sill) });
  assert.equal(fitted.error, undefined);
  const hline = guidesOf(previewPrimitivesOf(f, fitted))
    .filter(p => p.type === SvgFigurePrimitiveType.POLYLINE).find(p => p.points[0][1] === p.points[1][1]);
  assert.equal(hline.points[0][1], fitted.strokes[0].points[0].t, 't の基準線は origin の頂点の t');
  assert.equal(hline.points[0][1], sill + 7);
  assert.notEqual(hline.points[0][1], 7, 'offsetMm（7）の位置ではない');
});

test('基準線: 下書きは Datum の offset の位置に出る。非有限の offset は 0 に置き換わる（座標が NaN にならない）', () => {
  const f = setDatumField(ceilingForm(), 'ds0', 'offset', '25');
  const vline = guidesOf(previewPrimitivesOf(f)).find(p => p.type === SvgFigurePrimitiveType.POLYLINE);
  assert.equal(vline.points[0][0], 25);
  const bad = setDatumField(ceilingForm(), 'ds0', 'offset', 'zz');
  const g = guidesOf(previewPrimitivesOf(bad));
  assert.ok(g.length > 0);
  assert.ok(g.filter(p => p.points).every(p => p.points.flat().every(Number.isFinite)));
});

test('【失敗系】基準線: 試し込みが error なら下書きへ戻り、手が無ければ基準線も出ない', () => {
  const f = ceilingForm();
  const draft = previewPrimitivesOf(f, tryFit(f, { stepHeight: 'x' }));
  assert.ok(draft.some(p => p.type === SvgFigurePrimitiveType.DIM), '下書きの寸法がある');
  assert.ok(guidesOf(draft).length > 0);
  assert.deepEqual(previewPrimitivesOf({ ...f, strokes: [] }), []);
});
