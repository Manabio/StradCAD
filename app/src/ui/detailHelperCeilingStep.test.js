// ヘルパー画面の天井の段差（ceilingStep。part/section/ceiling）の試し込みと既定（部分詳細図 S8b-4a）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailAxis, DetailDatumKind, DETAIL_FIT_DEFAULT_STEP_HEIGHT_MM } from '../core/constants.js';
import {
  newDraft, setClassification, formFromEntry, validation, tryFit, defaultRoleFor, fitDimFieldsFor, defaultFitDimsFor, isCeilingStepForm, isFloorStepForm,
  junctionSlotOf, partSlotOf, FLOOR_STEP_FIT_DIM_FIELDS, FIT_DIM_FIELDS,
} from './detailHelperForm.js';
import { ERR_DETAIL_DATUM_UNSUPPORTED, DETAIL_TARGET_PART_CEILING_STEP } from '../error.js';
import { ceilingNoseFigure, stepNoseFigure, junctionFigure } from '../finish/roomDetailTestFixtures.js';

const ceilingForm = () => formFromEntry(ceilingNoseFigure('df-cstep'));

test('isCeilingStepForm: part/section/ceiling だけ。床の段差（part/section/floor）・junction・腰壁・既定は違う。slot 判定（junction・腰壁）とは排他', () => {
  const f = ceilingForm();
  assert.deepEqual([f.category, f.view, f.subject], [DetailCategory.PART, DetailView.SECTION, DetailSubject.CEILING]);
  assert.equal(isCeilingStepForm(f), true);
  assert.equal(isFloorStepForm(f), false);
  assert.equal(isCeilingStepForm(setClassification(f, 'subject', DetailSubject.FLOOR)), false);
  assert.equal(isCeilingStepForm(formFromEntry(stepNoseFigure('df-step'))), false);
  assert.equal(isCeilingStepForm(newDraft({ idFactory: () => 'a' })), false);
  assert.equal(isCeilingStepForm(null), false);
  assert.equal(junctionSlotOf(f), null);
  assert.equal(partSlotOf(f), null);
});

test('試し込みの欄・既定・基準の既定 role: 段差高だけ（既定 300・床の段差と同じ欄）。s は立ち上がり面・t は CEILING_FACE', () => {
  const f = ceilingForm();
  assert.equal(fitDimFieldsFor(f), FLOOR_STEP_FIT_DIM_FIELDS);
  assert.equal(fitDimFieldsFor(newDraft({ idFactory: () => 'a' })), FIT_DIM_FIELDS);
  assert.deepEqual(defaultFitDimsFor(f, 120), { stepHeight: String(DETAIL_FIT_DEFAULT_STEP_HEIGHT_MM) });
  assert.equal(defaultRoleFor(f, DetailAxis.S, DetailDatumKind.ORIGIN), DetailDatumRole.STEP_EDGE);
  assert.equal(defaultRoleFor(f, DetailAxis.T, DetailDatumKind.ORIGIN), DetailDatumRole.CEILING_FACE);
  assert.equal(defaultRoleFor(f, DetailAxis.T, DetailDatumKind.END), DetailDatumRole.CEILING_FACE);
});

test('tryFit: 段差高に合わせる（CEILING_FACE の end＝高い側の天井面＝−段差高）。段差高が変われば最終頂点の t が追従する', () => {
  const f = ceilingForm();
  assert.equal(validation(f).ok, true, JSON.stringify(validation(f).errors));
  const at300 = tryFit(f, { stepHeight: '300' });
  assert.equal(at300.error, undefined);
  assert.deepEqual(at300.strokes[0].points.map(p => [p.s, p.t]), [[0, 0], [120, 0], [120, -40], [30, -40], [30, -70], [0, -70], [0, -300]]);
  assert.equal(tryFit(f, { stepHeight: 450 }).strokes[0].points.at(-1).t, -450);
});

test('【失敗系】tryFit(ceilingStep): 段差高が正の数でない・固定寸法の和（70）以下・供給外の基準・FL を使った図は error（黙って代用しない）', () => {
  const f = ceilingForm();
  for (const bad of ['', 'x', '0', '-5', undefined]) {
    assert.equal(tryFit(f, { stepHeight: bad }).error.code, 'badFitDim', String(bad));
  }
  assert.equal(tryFit(f, { stepHeight: '70' }).error.code, 'fixedExceedsTarget');
  const odd = { ...ceilingNoseFigure('df-odd'), datums: ceilingNoseFigure('df-odd').datums.map(d => (d.axis === 's' ? { ...d, role: DetailDatumRole.WALL_FINISH_FACE } : d)) };
  const r = tryFit(formFromEntry(odd), { stepHeight: '300' });
  assert.equal(r.error.code, 'unsupportedDatum');
  assert.equal(r.error.message, ERR_DETAIL_DATUM_UNSUPPORTED('ds0', `${DetailDatumRole.WALL_FINISH_FACE}・s・origin`, DETAIL_TARGET_PART_CEILING_STEP));
  // t の基準が FL の図を天井の段差の分類にしても供給外
  const withFL = { ...ceilingNoseFigure('df-fl'), datums: ceilingNoseFigure('df-fl').datums.map(d => (d.axis === 't' ? { ...d, role: DetailDatumRole.FL } : d)) };
  assert.equal(tryFit(formFromEntry(withFL), { stepHeight: '300' }).error.code, 'unsupportedDatum');
  assert.equal(isCeilingStepForm(formFromEntry(junctionFigure('df-j', 'wallCeiling', []))), false);
});
