// ヘルパー画面の床の段差（floorStep。part/section/floor）の試し込みと既定（部分詳細図 S8b-3）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailAxis, DetailDatumKind, DETAIL_FIT_DEFAULT_STEP_HEIGHT_MM } from '../core/constants.js';
import {
  newDraft, setClassification, formFromEntry, validation, tryFit, defaultRoleFor, fitDimFieldsFor, defaultFitDimsFor, isFloorStepForm,
  junctionSlotOf, partSlotOf, FLOOR_STEP_FIT_DIM_FIELDS, FIT_DIM_FIELDS, DETAIL_ROLE_LABELS,
} from './detailHelperForm.js';
import { ERR_DETAIL_DATUM_UNSUPPORTED, DETAIL_TARGET_PART_STEP } from '../error.js';
import { stepNoseFigure, junctionFigure, baseboardFigure } from '../finish/roomDetailTestFixtures.js';

const stepForm = () => formFromEntry(stepNoseFigure('df-step'));

test('isFloorStepForm: part/section/floor だけ。junction・腰壁（part/section/wall）・既定は違う。slot 判定（junction・腰壁）とは排他', () => {
  const f = stepForm();
  assert.equal(f.category, DetailCategory.PART);
  assert.equal(f.view, DetailView.SECTION);
  assert.equal(f.subject, DetailSubject.FLOOR);
  assert.equal(isFloorStepForm(f), true);
  assert.equal(isFloorStepForm(setClassification(f, 'subject', DetailSubject.WALL)), false);
  assert.equal(isFloorStepForm(newDraft({ idFactory: () => 'a' })), false);
  assert.equal(isFloorStepForm(null), false);
  assert.equal(junctionSlotOf(f), null);
  assert.equal(partSlotOf(f), null);
});

test('試し込みの欄・既定・基準の既定 role: 段差高だけ（既定 300）。s は立ち上がり面・t は FL', () => {
  const f = stepForm();
  assert.equal(fitDimFieldsFor(f), FLOOR_STEP_FIT_DIM_FIELDS);
  assert.deepEqual(FLOOR_STEP_FIT_DIM_FIELDS.map(x => x.field), ['stepHeight']);
  assert.notEqual(fitDimFieldsFor(newDraft({ idFactory: () => 'a' })), FLOOR_STEP_FIT_DIM_FIELDS);
  assert.equal(fitDimFieldsFor(newDraft({ idFactory: () => 'a' })), FIT_DIM_FIELDS);
  assert.equal(DETAIL_FIT_DEFAULT_STEP_HEIGHT_MM, 300);
  assert.deepEqual(defaultFitDimsFor(f, 120), { stepHeight: String(DETAIL_FIT_DEFAULT_STEP_HEIGHT_MM) });
  assert.equal(defaultRoleFor(f, DetailAxis.S, DetailDatumKind.ORIGIN), DetailDatumRole.STEP_EDGE);
  assert.equal(defaultRoleFor(f, DetailAxis.T, DetailDatumKind.ORIGIN), DetailDatumRole.FL);
  assert.equal(defaultRoleFor(f, DetailAxis.T, DetailDatumKind.END), DetailDatumRole.FL);
  assert.equal(typeof DETAIL_ROLE_LABELS[DetailDatumRole.STEP_EDGE], 'string');
});

test('tryFit: 段差高に合わせる（FL の end＝低い側の床）。段差高が変われば最終頂点の t が追従する。文字列も数値も受ける', () => {
  const f = stepForm();
  assert.equal(validation(f).ok, true, JSON.stringify(validation(f).errors));
  const at300 = tryFit(f, { stepHeight: '300' });
  assert.equal(at300.error, undefined);
  assert.deepEqual(at300.strokes[0].points.map(p => [p.s, p.t]), [[0, 0], [120, 0], [120, 40], [30, 40], [30, 70], [0, 70], [0, 300]]);
  assert.equal(tryFit(f, { stepHeight: 450 }).strokes[0].points.at(-1).t, 450);
});

test('【失敗系】tryFit(floorStep): 段差高が正の数でない・固定寸法の和（70）以下・供給外の基準・取り合いの図は error（黙って代用しない）', () => {
  const f = stepForm();
  for (const bad of ['', 'x', '0', '-5', undefined]) {
    assert.equal(tryFit(f, { stepHeight: bad }).error.code, 'badFitDim', String(bad));
  }
  assert.equal(tryFit(f, { stepHeight: '70' }).error.code, 'fixedExceedsTarget');
  // 壁の仕上げ面を s の基準にした図は床の段差では供給外
  const odd = { ...stepNoseFigure('df-odd'), datums: stepNoseFigure('df-odd').datums.map(d => (d.axis === 's' ? { ...d, role: DetailDatumRole.WALL_FINISH_FACE } : d)) };
  const r = tryFit(formFromEntry(odd), { stepHeight: '300' });
  assert.equal(r.error.code, 'unsupportedDatum');
  assert.equal(r.error.message, ERR_DETAIL_DATUM_UNSUPPORTED('ds0', `${DetailDatumRole.WALL_FINISH_FACE}・s・origin`, DETAIL_TARGET_PART_STEP));
  // 取り合い（junction）の図は壁厚の欄（床の段差の欄にならない）
  assert.equal(isFloorStepForm(formFromEntry(baseboardFigure('df-b'))), false);
  assert.equal(isFloorStepForm(formFromEntry(junctionFigure('df-j', 'floorWall', []))), false);
});
