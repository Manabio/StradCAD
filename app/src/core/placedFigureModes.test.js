// 図面モード（姿図配置モード）の定義表からの組み立て（placedFigureModes.js）の単体テスト。
// 導出の検証は試験用の行で registry を組んで行う（本番の表の 1 行は最後のテストで確かめる）。
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
  ERR_PLACED_FIGURE_MODE_BAD_ID, ERR_PLACED_FIGURE_MODE_BAD_LABEL,
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

test('失敗系(f): id が英字だけ・先頭小文字でない・文字列でない・行が null／非オブジェクトは ERR_PLACED_FIGURE_MODE_BAD_ID', () => {
  for (const bad of ['', 'Plumbing', 'plumbing2', 'plumb-ing', 'plumb ing', '1plumbing', 'あ', undefined, null, 5, ['a']]) {
    assert.throws(() => buildPlacedFigureModeRegistry([{ ...PLUMBING, mode: bad }], CORE_APP_MODES),
      { message: ERR_PLACED_FIGURE_MODE_BAD_ID(bad) }, String(bad));
  }
  for (const badRow of [null, undefined, 'plumbingTest', 7]) {
    assert.throws(() => buildPlacedFigureModeRegistry([badRow], CORE_APP_MODES),
      { message: ERR_PLACED_FIGURE_MODE_BAD_ID(badRow) }, String(badRow));
  }
  // 形の検査は重複・衝突より前（形が不正な id は DUPLICATE／CONFLICT でなく BAD_ID で落ちる）
  assert.throws(() => buildPlacedFigureModeRegistry([PLUMBING, { ...HVAC, mode: 'plumbing-test' }], CORE_APP_MODES),
    { message: ERR_PLACED_FIGURE_MODE_BAD_ID('plumbing-test') });
  // 英字だけ（大文字を含む）なら通る
  assert.doesNotThrow(() => buildPlacedFigureModeRegistry([{ ...PLUMBING, mode: 'camelCaseMode' }], CORE_APP_MODES));
});

test('失敗系(g): label が空・空白だけ・文字列でないは ERR_PLACED_FIGURE_MODE_BAD_LABEL', () => {
  for (const bad of ['', '   ', '\t\n', undefined, null, 3]) {
    assert.throws(() => buildPlacedFigureModeRegistry([{ ...PLUMBING, label: bad }], CORE_APP_MODES),
      { message: ERR_PLACED_FIGURE_MODE_BAD_LABEL('plumbingTest') }, String(bad));
  }
  assert.doesNotThrow(() => buildPlacedFigureModeRegistry([{ ...PLUMBING, label: ' 空調 ' }], CORE_APP_MODES));
});

test('本番の書き出し: 定義表の行から導かれ（衛生を扱う行＝給排水）、既存モードは図面モードでない', () => {
  assert.ok(PLACED_FIGURE_MODES.length >= 1);
  const sanitaryRow = PLACED_FIGURE_MODES.find(r => r.subjects.includes(DetailSubject.SANITARY));
  assert.equal(sanitaryRow?.mode, 'plumbing');
  assert.deepEqual([...PLACED_FIGURE_MODE_IDS], PLACED_FIGURE_MODES.map(r => r.mode));
  assert.equal(PLACED_FIGURE_MODE_IDS, PLACED_FIGURE_MODE_REGISTRY.modeIds);
  for (const row of PLACED_FIGURE_MODES) {
    assert.equal(isPlacedFigureMode(row.mode), true, row.mode);
    assert.equal(placedFigureModeLabelOf(row.mode), row.label, row.mode);
    assert.deepEqual([...placedFigureModeOf(row.mode).subjects], row.subjects, row.mode);
  }
  assert.deepEqual([...placedFigureModeOf(sanitaryRow.mode).subjects], [DetailSubject.SANITARY]);
  assert.equal(placedFigureModeCeilingSubjectsOf(sanitaryRow.mode).length, 0, '衛生は見上げに出さない');
  for (const core of CORE_APP_MODES) {
    assert.equal(isPlacedFigureMode(core), false, core);
    assert.equal(placedFigureModeOf(core), null, core);
    assert.equal(placedFigureModeLabelOf(core), null, core);
    assert.equal(placedFigureModeCeilingSubjectsOf(core).length, 0, core);
  }
});
