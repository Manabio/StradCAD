// 図面モード（姿図配置モード）の定義表からの組み立て（placedFigureModes.js）の単体テスト。
// 本番の定義表は空なので、導出の検証は試験用の行で registry を組んで行う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetailSubject, PLACED_FIGURE_MODES, CORE_APP_MODES } from './constants.js';
import {
  buildPlacedFigureModeRegistry, PLACED_FIGURE_MODE_REGISTRY, PLACED_FIGURE_MODE_IDS,
  isPlacedFigureMode, placedFigureModeOf, placedFigureModeLabelOf, placedFigureModeCeilingSubjectsOf,
} from './placedFigureModes.js';
import {
  ERR_PLACED_FIGURE_MODE_DUPLICATE, ERR_PLACED_FIGURE_MODE_CONFLICT, ERR_PLACED_FIGURE_MODE_NO_SUBJECTS,
  ERR_PLACED_FIGURE_MODE_BAD_SUBJECT, ERR_PLACED_FIGURE_MODE_OVERLAP,
} from '../error.js';

const PLUMBING = { mode: 'plumbingTest', label: '給排水（試験）', subjects: [DetailSubject.SANITARY] };
const HVAC = { mode: 'hvacTest', label: '空調（試験）', subjects: [DetailSubject.HVAC] };

test('空の表: modeIds が空・isMode が常に偽・defOf／labelOf が null・天伏の分類が空', () => {
  const reg = buildPlacedFigureModeRegistry([], CORE_APP_MODES);
  assert.equal(reg.modeIds.length, 0);
  for (const id of [...CORE_APP_MODES, 'plumbingTest', '']) {
    assert.equal(reg.isMode(id), false, id);
    assert.equal(reg.defOf(id), null, id);
    assert.equal(reg.labelOf(id), null, id);
    assert.equal(reg.ceilingSubjectsOf(id).length, 0, id);
  }
});

test('試験用の 2 行: 全導出に 2 行とも現れ、modeIds は行の順', () => {
  const reg = buildPlacedFigureModeRegistry([PLUMBING, HVAC], CORE_APP_MODES);
  assert.deepEqual([...reg.modeIds], ['plumbingTest', 'hvacTest']);
  for (const row of [PLUMBING, HVAC]) {
    assert.equal(reg.isMode(row.mode), true, row.mode);
    assert.equal(reg.labelOf(row.mode), row.label, row.mode);
    assert.equal(reg.defOf(row.mode).mode, row.mode, row.mode);
    assert.deepEqual([...reg.defOf(row.mode).subjects], row.subjects, row.mode);
  }
  assert.equal(reg.ceilingSubjectsOf('plumbingTest').length, 0, '衛生は見上げに出さない');
  assert.deepEqual([...reg.ceilingSubjectsOf('hvacTest')], [DetailSubject.HVAC]);
});

test('同じ行の subjects の重複は最初の出現順で 1 つにまとまる', () => {
  const reg = buildPlacedFigureModeRegistry([{ ...HVAC, subjects: [DetailSubject.HVAC, DetailSubject.ELECTRICAL, DetailSubject.HVAC] }], CORE_APP_MODES);
  assert.deepEqual([...reg.defOf('hvacTest').subjects], [DetailSubject.HVAC, DetailSubject.ELECTRICAL]);
  const dup = buildPlacedFigureModeRegistry([{ ...PLUMBING, subjects: [DetailSubject.SANITARY, DetailSubject.SANITARY] }], CORE_APP_MODES);
  assert.equal(dup.defOf('plumbingTest').subjects.length, 1);
});

test('行の並びを入れ替えると modeIds の並びも入れ替わる', () => {
  const reg = buildPlacedFigureModeRegistry([HVAC, PLUMBING], CORE_APP_MODES);
  assert.deepEqual([...reg.modeIds], ['hvacTest', 'plumbingTest']);
});

test('戻りは凍結されている（registry・modeIds・行・subjects・天伏の分類）', () => {
  const reg = buildPlacedFigureModeRegistry([PLUMBING, HVAC], CORE_APP_MODES);
  assert.ok(Object.isFrozen(reg));
  assert.ok(Object.isFrozen(reg.modeIds));
  assert.ok(Object.isFrozen(reg.defOf('hvacTest')));
  assert.ok(Object.isFrozen(reg.defOf('hvacTest').subjects));
  assert.ok(Object.isFrozen(reg.ceilingSubjectsOf('hvacTest')));
  assert.ok(Object.isFrozen(PLACED_FIGURE_MODES));
});

test('失敗系(a): id の重複は ERR_PLACED_FIGURE_MODE_DUPLICATE', () => {
  assert.throws(() => buildPlacedFigureModeRegistry([PLUMBING, { ...HVAC, mode: 'plumbingTest' }], CORE_APP_MODES),
    { message: ERR_PLACED_FIGURE_MODE_DUPLICATE('plumbingTest') });
});

test('失敗系(b): 既存のモード id との衝突は ERR_PLACED_FIGURE_MODE_CONFLICT', () => {
  assert.throws(() => buildPlacedFigureModeRegistry([{ ...PLUMBING, mode: 'ceiling' }], CORE_APP_MODES),
    { message: ERR_PLACED_FIGURE_MODE_CONFLICT('ceiling') });
});

test('失敗系(c): subjects が空・配列でないは ERR_PLACED_FIGURE_MODE_NO_SUBJECTS', () => {
  assert.throws(() => buildPlacedFigureModeRegistry([{ ...PLUMBING, subjects: [] }], CORE_APP_MODES),
    { message: ERR_PLACED_FIGURE_MODE_NO_SUBJECTS('plumbingTest') });
  assert.throws(() => buildPlacedFigureModeRegistry([{ ...PLUMBING, subjects: DetailSubject.SANITARY }], CORE_APP_MODES),
    { message: ERR_PLACED_FIGURE_MODE_NO_SUBJECTS('plumbingTest') });
});

test('失敗系(d): 配置できない分類は ERR_PLACED_FIGURE_MODE_BAD_SUBJECT', () => {
  assert.throws(() => buildPlacedFigureModeRegistry([{ ...PLUMBING, subjects: [DetailSubject.JAMB] }], CORE_APP_MODES),
    { message: ERR_PLACED_FIGURE_MODE_BAD_SUBJECT('plumbingTest', DetailSubject.JAMB) });
});

test('失敗系(e): 行どうしで分類が重なると ERR_PLACED_FIGURE_MODE_OVERLAP', () => {
  const dup = { mode: 'otherTest', label: '別（試験）', subjects: [DetailSubject.HVAC, DetailSubject.SANITARY] };
  assert.throws(() => buildPlacedFigureModeRegistry([PLUMBING, dup], CORE_APP_MODES),
    { message: ERR_PLACED_FIGURE_MODE_OVERLAP('plumbingTest', 'otherTest', DetailSubject.SANITARY) });
});

test('本番の書き出し: 定義表が空なので空の表の導出と一致する', () => {
  assert.equal(PLACED_FIGURE_MODES.length, 0);
  assert.equal(PLACED_FIGURE_MODE_IDS.length, 0);
  assert.equal(PLACED_FIGURE_MODE_IDS, PLACED_FIGURE_MODE_REGISTRY.modeIds);
  assert.equal(isPlacedFigureMode('floorplan'), false);
  assert.equal(placedFigureModeOf('floorplan'), null);
  assert.equal(placedFigureModeLabelOf('floorplan'), null);
  assert.equal(placedFigureModeCeilingSubjectsOf('floorplan').length, 0);
});
