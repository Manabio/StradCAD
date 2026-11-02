// ui/detailHelperForm.js（ヘルパー画面の純ロジック）のテスト。期待値は定数で書く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis,
  DetailParam, DetailMaterialField, DETAIL_VIEW_COMBOS, DETAIL_DRAFT_HISTORY_MAX, SvgFigurePrimitiveType,
} from '../core/constants.js';
import { DetailValidationError } from '../detail/detailModel.js';
import { DEFAULT_FRAME_FACE_MM, DEFAULT_FRAME_PROJECTION_MM, findCatalogEntry } from '../openings/openingCatalog.js';
import { DETAIL_SUBJECT_LABELS, formatDetailSubjectLabel } from '../catalog/catalogMaintenance.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays, docDiffMap } from '../catalog/catalogRegistry.js';
import {
  newDraft, formFromEntry, entryFromForm, duplicateForm, isDraftDirty, pushHistory, undoDraft, applyPen, penUp, setClosed,
  setMoveLen, setMoveMode, moveRows, addDatum, removeDatum, setDatumField, setAnchor, anchorVertex, vertexOptions,
  comboOptions, setClassification, validation, saveBlockers, saveEnabled, libraryRows, defaultFitDims, tryFit,
  isElevationFigureForm, fitDimFieldsFor, defaultFitDimsFor,
  previewPrimitivesOf, parseNumberText, planSave, saveContextFor, saveDecision, afterSaveDoc, penStep, describeError,
  wallThicknessNotice, displayLen, freshDocOf, docFromEntry, duplicateDoc, afterDeleteDoc, clearPenError, docContextFor, DETAIL_HELPER_MESSAGES, DETAIL_ROLE_LABELS, DETAIL_MODE_LABELS, DETAIL_PARAM_LABELS,
  DETAIL_MATERIAL_FIELD_LABELS, DETAIL_DATUM_KIND_LABELS, DETAIL_AXIS_LABELS, PEN_BUTTONS, PEN_DIR_LABELS,
} from './detailHelperForm.js';

const idFactory = () => 'abc';
const S1_MOVE_2 = { strokeId: 's1', moveIndex: 2 };

function drawAll(form, steps) {
  let f = form;
  for (const [dir, len] of steps) {
    const r = applyPen(f, dir, len);
    assert.ok(r.form, `applyPen が失敗: ${dir} ${len} ${r.error}`);
    f = r.form;
  }
  return f;
}

// コの字（開）。R20・D10・D50（伸縮）・D10・L20。縦の端の基準 d3 を頂点 4 に載せる。保存できる状態。
function stretchableDraft() {
  let f = { ...newDraft({ idFactory }), label: 'コの字' };
  f = drawAll(f, [[PenDir.RIGHT, '20'], [PenDir.DOWN, '10'], [PenDir.DOWN, '50'], [PenDir.DOWN, '10'], [PenDir.LEFT, '20']]);
  f = setMoveMode(f, S1_MOVE_2, DetailLenMode.STRETCH);
  f = addDatum(f);
  return setAnchor(f, 's1', 'd3', 4);
}

test('newDraft: キーは df-＋idFactory・分類は組合せ表の先頭・原点の基準は軸ごとに 1 つ・ストローク 0 本', () => {
  const f = newDraft({ idFactory });
  assert.equal(f.key, 'df-abc');
  assert.deepEqual([f.category, f.view, f.subject], [DETAIL_VIEW_COMBOS[0].category, DETAIL_VIEW_COMBOS[0].view, DETAIL_VIEW_COMBOS[0].subject]);
  assert.deepEqual(f.datums.map(d => [d.id, d.axis, d.kind, d.offset]), [['d1', 's', 'origin', '0'], ['d2', 't', 'origin', '0']]);
  assert.deepEqual(f.strokes, []);
  assert.deepEqual(f.anchors, []);
});

test('往復: entry → form → entry が同値（数値は文字列で保持・param/material/斜め・未知の項目も保つ）', () => {
  const entry = {
    key: 'df-x', version: 1, label: '往復', category: DetailCategory.PAIRED, view: DetailView.PLAN, subject: DetailSubject.JAMB,
    strokes: [
      {
        id: 's1', closed: true, line: { weightRole: 'medium', dashRole: 'dashed' },
        moves: [
          { dir: 'R', len: { mm: 12.5, mode: DetailLenMode.FIXED } },
          { dir: 'D', len: { mm: 20, mode: DetailLenMode.PARAM, param: DetailParam.FRAME_PROJECTION } },
          { dir: 'L', len: { mm: 9, mode: DetailLenMode.MATERIAL, code: '301000000010', field: DetailMaterialField.THICKNESS } },
          { dir: PenDir.VECTOR, dx: { mm: 3, mode: DetailLenMode.FIXED }, dy: { mm: 4, mode: DetailLenMode.FIXED }, ss: -1, st: 1 },
        ],
      },
    ],
    datums: [{ id: 'd1', role: DetailDatumRole.OPENING_OUTER, axis: 's', kind: 'origin', offsetMm: 900.5 }],
    anchors: [{ datumId: 'd1', strokeId: 's1', vertexIndex: 0 }],
    provenance: { source: 'manual' }, note: null, futureField: { a: [1, 2] },
  };
  const form = formFromEntry(entry);
  assert.equal(form.strokes[0].moves[0].len, '12.5');
  assert.equal(form.datums[0].offset, '900.5');
  assert.deepEqual(form.extra.futureField, { a: [1, 2] });
  assert.deepEqual(entryFromForm(form), entry);
});

test('フォームの値の形: 空文字・式はそのまま保持され、entry では NaN／評価値になり、検証が理由を返す', () => {
  let f = drawAll({ ...newDraft({ idFactory }), label: 'x' }, [[PenDir.RIGHT, '10']]);
  f = setMoveLen(f, { strokeId: 's1', moveIndex: 0 }, '');
  assert.equal(f.strokes[0].moves[0].len, '');
  assert.ok(Number.isNaN(entryFromForm(f).strokes[0].moves[0].len.mm));
  assert.ok(validation(f).errors.some(e => e.code === DetailValidationError.BAD_LENGTH));
  f = setMoveLen(f, { strokeId: 's1', moveIndex: 0 }, '10+5');
  assert.equal(f.strokes[0].moves[0].len, '10+5');
  assert.equal(entryFromForm(f).strokes[0].moves[0].len.mm, 15);
});

test('parseNumberText: 数値はそのまま・文字列は式評価・空文字と式エラーは NaN・負と 0 は値のまま', () => {
  assert.equal(parseNumberText(7), 7);
  assert.equal(parseNumberText('2×3'), 6);
  assert.ok(Number.isNaN(parseNumberText('')));
  assert.ok(Number.isNaN(parseNumberText('1+')));
  assert.equal(parseNumberText('-4'), -4);
  assert.equal(parseNumberText('0'), 0);
});

test('applyPen: 4 方向で固定の手を足す（最初の手でストロークを作り、origin の Anchor は頂点 0）', () => {
  const dirs = [PenDir.UP, PenDir.DOWN, PenDir.LEFT, PenDir.RIGHT];
  const f = drawAll(newDraft({ idFactory }), dirs.map((d, i) => [d, String(10 * (i + 1))]));
  assert.deepEqual(f.strokes[0].moves, [
    { dir: 'U', mode: 'fixed', len: '10' }, { dir: 'D', mode: 'fixed', len: '20' },
    { dir: 'L', mode: 'fixed', len: '30' }, { dir: 'R', mode: 'fixed', len: '40' },
  ]);
  assert.deepEqual(f.anchors, [{ datumId: 'd1', strokeId: 's1', vertexIndex: 0 }, { datumId: 'd2', strokeId: 's1', vertexIndex: 0 }]);
});

test('applyPen: 式は評価して保存する（50+50 → 100）', () => {
  assert.equal(applyPen(newDraft({ idFactory }), PenDir.RIGHT, '50+50').form.strokes[0].moves[0].len, '100');
});

test('applyPen の失敗系: 空文字・負値・0・式エラー・未知の方向は { error } でフォームを変えない', () => {
  const f = newDraft({ idFactory });
  const cases = [
    [PenDir.RIGHT, '', '距離を入力してください'],
    [PenDir.RIGHT, '   ', '距離を入力してください'],
    [PenDir.RIGHT, '-5', '距離は正の数で入力してください（向きは方向ボタンで決まります）'],
    [PenDir.RIGHT, '0', '距離は 0 より大きい数で入力してください'],
    [PenDir.RIGHT, '10+', '距離は数値か四則演算の式で入力してください'],
    [PenDir.RIGHT, 'abc', '距離は数値か四則演算の式で入力してください'],
    [PenDir.VECTOR, '10', '未知の方向です: V'],
  ];
  for (const [dir, len, message] of cases) {
    const r = applyPen(f, dir, len);
    assert.deepEqual(r, { error: message }, `${dir} ${len}`);
  }
});

test('penUp: 新しいストロークを始め、origin の Anchor は新ストロークの頂点 0。最後が空なら何もしない', () => {
  let f = drawAll(newDraft({ idFactory }), [[PenDir.RIGHT, '10']]);
  f = penUp(f);
  assert.deepEqual(f.strokes.map(s => [s.id, s.moves.length]), [['s1', 1], ['s2', 0]]);
  assert.deepEqual(f.anchors.filter(a => a.strokeId === 's2'), [
    { datumId: 'd1', strokeId: 's2', vertexIndex: 0 }, { datumId: 'd2', strokeId: 's2', vertexIndex: 0 },
  ]);
  assert.equal(penUp(f), f);
  assert.equal(penUp(newDraft({ idFactory })).strokes.length, 0);
  f = drawAll(f, [[PenDir.DOWN, '5']]);
  assert.deepEqual(f.strokes.map(s => s.moves.length), [1, 1]);
});

test('setClosed: 指定ストロークだけ閉じる／開く', () => {
  let f = penUp(drawAll(newDraft({ idFactory }), [[PenDir.RIGHT, '10']]));
  f = setClosed(f, 's1', true);
  assert.deepEqual(f.strokes.map(s => s.closed), [true, false]);
  assert.deepEqual(setClosed(f, 's1', false).strokes.map(s => s.closed), [false, false]);
});

test('下書き履歴: pushHistory は上限 DETAIL_DRAFT_HISTORY_MAX で古いものから落ち、undoDraft は直前を返す', () => {
  let h = [];
  for (let i = 0; i < DETAIL_DRAFT_HISTORY_MAX + 1; i++) h = pushHistory(h, { n: i });
  assert.equal(h.length, 50);
  assert.deepEqual(h[0], { n: 1 });
  assert.deepEqual(h[h.length - 1], { n: 50 });
  const r = undoDraft(h);
  assert.deepEqual(r.form, { n: 50 });
  assert.equal(r.history.length, 49);
  assert.equal(undoDraft([]), null);
});

test('setMoveLen / setMoveMode: editKey の手だけが変わる。存在しない editKey は何もしない', () => {
  const f = drawAll(newDraft({ idFactory }), [[PenDir.RIGHT, '10'], [PenDir.DOWN, '20']]);
  const g = setMoveLen(f, { strokeId: 's1', moveIndex: 1 }, '25');
  assert.deepEqual(g.strokes[0].moves.map(m => m.len), ['10', '25']);
  assert.equal(setMoveLen(f, { strokeId: 'zz', moveIndex: 0 }, '1'), f);
  assert.equal(setMoveLen(f, { strokeId: 's1', moveIndex: 9 }, '1'), f);
  const p = setMoveMode(f, { strokeId: 's1', moveIndex: 0 }, DetailLenMode.PARAM);
  assert.deepEqual(p.strokes[0].moves[0], { dir: 'R', mode: 'param', len: '10', param: DetailParam.FRAME_FACE_WIDTH });
  const m = setMoveMode(f, { strokeId: 's1', moveIndex: 0 }, DetailLenMode.MATERIAL, { code: '301000000010' });
  assert.deepEqual(m.strokes[0].moves[0], { dir: 'R', mode: 'material', len: '10', code: '301000000010', field: 'thickness' });
  assert.equal(setMoveMode(f, { strokeId: 's1', moveIndex: 0 }, 'bogus'), f);
  // param から固定へ戻すと param は残らない
  assert.deepEqual(setMoveMode(p, { strokeId: 's1', moveIndex: 0 }, DetailLenMode.FIXED).strokes[0].moves[0], { dir: 'R', mode: 'fixed', len: '10' });
});

test('setMoveMode: 伸縮にすると end の基準・Anchor を要求し、足すと検証が通る', () => {
  let f = { ...newDraft({ idFactory }), label: 'x' };
  f = drawAll(f, [[PenDir.RIGHT, '20'], [PenDir.DOWN, '10'], [PenDir.DOWN, '50'], [PenDir.DOWN, '10']]);
  assert.equal(validation(f).ok, true);
  f = setMoveMode(f, S1_MOVE_2, DetailLenMode.STRETCH);
  assert.deepEqual(validation(f).errors.map(e => e.code), [DetailValidationError.STRETCH_WITHOUT_END]);
  f = addDatum(f);
  assert.ok(validation(f).errors.some(e => e.code === DetailValidationError.END_DATUM_UNUSED));
  f = setAnchor(f, 's1', 'd3', 4);
  assert.deepEqual(validation(f).errors, []);
});

test('moveRows: 手ごとの editKey・向き記号・頂点番号', () => {
  const f = drawAll(newDraft({ idFactory }), [[PenDir.RIGHT, '10'], [PenDir.UP, '5']]);
  const rows = moveRows(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vertexCount, 3);
  assert.deepEqual(rows[0].moves.map(m => [m.editKey, m.dirLabel, m.lenText, m.fromVertex, m.toVertex]), [
    [{ strokeId: 's1', moveIndex: 0 }, '→', '10', 0, 1],
    [{ strokeId: 's1', moveIndex: 1 }, '↑', '5', 1, 2],
  ]);
});

test('基準と Anchor: addDatum（端）・setDatumField・setAnchor（付け替え・外す）・removeDatum・vertexOptions', () => {
  let f = drawAll(newDraft({ idFactory }), [[PenDir.RIGHT, '10'], [PenDir.DOWN, '10']]);
  f = addDatum(f);
  assert.deepEqual(f.datums[2], { id: 'd3', role: DetailDatumRole.WALL_FINISH_FACE, axis: 't', kind: 'end', offset: '0' });
  f = setDatumField(f, 'd3', 'offset', '900');
  f = setDatumField(f, 'd3', 'role', DetailDatumRole.FL);
  assert.deepEqual([f.datums[2].offset, f.datums[2].role], ['900', 'fl']);
  assert.equal(setDatumField(f, 'd3', 'id', 'zz'), f);
  assert.deepEqual(vertexOptions(f, 's1'), [{ value: 0, label: 'P0' }, { value: 1, label: 'P1' }, { value: 2, label: 'P2' }]);
  assert.deepEqual(vertexOptions(f, 'nope'), []);
  f = setAnchor(f, 's1', 'd3', 2);
  assert.equal(anchorVertex(f, 's1', 'd3'), 2);
  f = setAnchor(f, 's1', 'd3', '1');
  assert.equal(anchorVertex(f, 's1', 'd3'), 1);
  assert.equal(f.anchors.filter(a => a.datumId === 'd3').length, 1);
  assert.equal(anchorVertex(setAnchor(f, 's1', 'd3', null), 's1', 'd3'), null);
  assert.equal(setAnchor(f, 'nope', 'd3', 0), f);
  assert.equal(setAnchor(f, 's1', 'nope', 0), f);
  const r = removeDatum(f, 'd3');
  assert.deepEqual(r.datums.map(d => d.id), ['d1', 'd2']);
  assert.equal(r.anchors.some(a => a.datumId === 'd3'), false);
});

test('addDatum: 原点を足したときは全ストロークの頂点 0 に載せる', () => {
  const f = addDatum(penUp(drawAll(newDraft({ idFactory }), [[PenDir.RIGHT, '10']])), { axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN });
  assert.deepEqual(f.anchors.filter(a => a.datumId === 'd3').map(a => a.strokeId), ['s1', 's2']);
});

test('comboOptions: category で view を、(category, view) で subject を絞る', () => {
  const o = comboOptions(DetailCategory.PAIRED, DetailView.SECTION);
  assert.deepEqual(o.views.map(v => v.value), ['plan', 'section']);
  assert.deepEqual(o.subjects.map(s => s.value), ['jamb', 'head', 'sill', 'sashSection', 'nageshi', 'shikii']);
  assert.deepEqual(o.categories.map(c => c.value), ['part', 'junction', 'freePart', 'paired', 'figure']);
  const j = comboOptions(DetailCategory.JUNCTION, DetailView.SECTION);
  assert.deepEqual(j.views.map(v => v.value), ['section']);
  assert.deepEqual(j.subjects.map(s => s.value), ['floorWall', 'wallCeiling']);
  assert.deepEqual(comboOptions(DetailCategory.JUNCTION, DetailView.PLAN).subjects, []);
});

test('setClassification: 上位を変えると下位は組合せ表の先頭へ寄る（表に無い状態を作らない）', () => {
  const f = newDraft({ idFactory });
  const g = setClassification(f, 'category', DetailCategory.FREE_PART);
  assert.deepEqual([g.category, g.view, g.subject], ['freePart', 'section', 'eave']);
  const h = setClassification(f, 'category', DetailCategory.FIGURE);
  assert.deepEqual([h.category, h.view, h.subject], ['figure', 'plan', 'opening']);
  assert.deepEqual([setClassification(h, 'view', DetailView.ELEVATION).view, setClassification(h, 'subject', DetailSubject.HVAC).subject], ['elevation', 'hvac']);
  assert.equal(setClassification(f, 'key', 'x'), f);
});

test('saveEnabled: 検証エラー・呼称が空のときは false、理由を返す', () => {
  const empty = newDraft({ idFactory });
  assert.equal(saveEnabled(empty, validation(empty)), false);
  assert.ok(saveBlockers(empty, validation(empty)).includes('呼称を入力してください'));
  assert.ok(saveBlockers(empty, validation(empty)).some(m => m.includes('ストローク')));

  const ok = stretchableDraft();
  assert.equal(validation(ok).ok, true);
  assert.equal(saveEnabled(ok, validation(ok)), true);
  assert.deepEqual(saveBlockers(ok, validation(ok)), []);

  const noLabel = { ...ok, label: '  ' };
  assert.equal(saveEnabled(noLabel, validation(noLabel)), false);

  const bad = setMoveLen(ok, { strokeId: 's1', moveIndex: 0 }, '');
  assert.equal(validation(bad).ok, false);
  assert.equal(saveEnabled(bad, validation(bad)), false);
  assert.ok(saveBlockers(bad, validation(bad)).length > 0);
});

test('tryFit: 壁厚 105 → 120 で伸縮の 1 本だけが伸び、固定寸法は変わらない', () => {
  const f = stretchableDraft();
  const at = (wall) => tryFit(f, { wallThickness: wall, faceWidth: '20', projection: '12' }).strokes[0].points.map(p => [p.s, p.t]);
  assert.deepEqual(at('105'), [[0, 0], [20, 0], [20, 10], [20, 95], [20, 105], [0, 105]]);
  assert.deepEqual(at('120'), [[0, 0], [20, 0], [20, 10], [20, 110], [20, 120], [0, 120]]);
});

test('tryFit の失敗系: 目標値が不正・基準が三方枠で供給できない・図が不正のとき { error }', () => {
  const f = stretchableDraft();
  const dims = { wallThickness: '105', faceWidth: '20', projection: '12' };
  assert.equal(tryFit(f, { ...dims, wallThickness: '' }).error.code, 'badFitDim');
  assert.equal(tryFit(f, { ...dims, wallThickness: '-1' }).error.code, 'badFitDim');
  assert.equal(tryFit(f, { ...dims, faceWidth: '0' }).error.code, 'badFitDim');
  assert.equal(tryFit(f, { ...dims, projection: 'x' }).error.code, 'badFitDim');
  const unsupported = setDatumField(f, 'd1', 'role', DetailDatumRole.FL);
  assert.equal(tryFit(unsupported, dims).error.code, 'unsupportedDatum');
  const tooShort = tryFit(f, { ...dims, wallThickness: '15' });
  assert.equal(tooShort.error.code, 'fixedExceedsTarget');
  assert.equal(tryFit(newDraft({ idFactory }), dims).error.code, 'invalid');
});

// ---- S6b: 建具の姿図（figure/elevation/opening）の試し込み・既定の基準 ----
function elevationDraft() {
  let f = setClassification(setClassification(newDraft({ idFactory }), 'category', DetailCategory.FIGURE), 'view', DetailView.ELEVATION);
  f = { ...f, label: '姿図' };
  f = drawAll(f, [[PenDir.UP, '50'], [PenDir.RIGHT, '20']]);
  f = setMoveMode(f, { strokeId: 's1', moveIndex: 0 }, DetailLenMode.STRETCH);
  f = addDatum(f); // T の end（姿図では HEAD が既定）
  return setAnchor(f, 's1', 'd3', 1);
}

test('姿図: 分類を figure/elevation/opening にすると既定の基準は s＝開口端・t origin＝SILL・end＝HEAD。出入りで既定のままの role だけ移行し、選んだ role は残す', () => {
  const draft = newDraft({ idFactory });
  assert.deepEqual(draft.datums.map(d => d.role), [DetailDatumRole.OPENING_OUTER, DetailDatumRole.WALL_FINISH_FACE]);
  const el = setClassification(setClassification(draft, 'category', DetailCategory.FIGURE), 'view', DetailView.ELEVATION);
  assert.equal(isElevationFigureForm(el), true);
  assert.deepEqual(el.datums.map(d => d.role), [DetailDatumRole.OPENING_OUTER, DetailDatumRole.SILL]);
  assert.equal(addDatum(el).datums.at(-1).role, DetailDatumRole.HEAD, '足した end の基準は HEAD');
  assert.equal(addDatum(el, { axis: DetailAxis.S }).datums.at(-1).role, DetailDatumRole.OPENING_OUTER);
  const back = setClassification(el, 'category', DetailCategory.PAIRED);
  assert.equal(isElevationFigureForm(back), false);
  assert.deepEqual(back.datums.map(d => d.role), [DetailDatumRole.OPENING_OUTER, DetailDatumRole.WALL_FINISH_FACE]);
  const custom = setDatumField(el, 'd2', 'role', DetailDatumRole.FL);
  assert.equal(setClassification(custom, 'category', DetailCategory.PAIRED).datums[1].role, DetailDatumRole.FL, '選んだ role は触らない');
  // 姿図内での view／subject の移動（figure/plan へ）は姿図でなくなる＝基準を既定へ戻す
  assert.equal(setClassification(el, 'view', DetailView.PLAN).datums[1].role, DetailDatumRole.WALL_FINISH_FACE);
});

test('姿図 tryFit: 幅 800→1000・高さ 2000→2100 で伸縮の 1 本だけが伸び、固定寸法（右 20）は変わらない。窓台は局所座標に影響しない', () => {
  const f = elevationDraft();
  assert.equal(validation(f).ok, true);
  const at = dims => tryFit(f, dims).strokes[0].points.map(p => [p.s, p.t]);
  assert.deepEqual(at({ width: '800', height: '2000', sill: '0' }), [[0, 0], [0, -2000], [20, -2000]]);
  assert.deepEqual(at({ width: '1000', height: '2100', sill: '900' }), [[0, 0], [0, -2100], [20, -2100]]);
});

test('【失敗系】姿図 tryFit: 寸法が不正は badFitDim、三方枠の基準（壁の仕上げ面）は unsupportedDatum、図が不正は invalid。三方枠の寸法欄では試し込めない', () => {
  const f = elevationDraft();
  const dims = { width: '800', height: '2000', sill: '0' };
  assert.equal(tryFit(f, { ...dims, width: '' }).error.code, 'badFitDim');
  assert.equal(tryFit(f, { ...dims, height: '0' }).error.code, 'badFitDim');
  assert.equal(tryFit(f, { ...dims, sill: '-1' }).error.code, 'badFitDim');
  assert.equal(tryFit(setDatumField(f, 'd2', 'role', DetailDatumRole.WALL_FINISH_FACE), dims).error.code, 'unsupportedDatum');
  assert.match(tryFit(setDatumField(f, 'd2', 'role', DetailDatumRole.WALL_FINISH_FACE), dims).error.message, /建具の姿図では使えません/);
  const empty = setClassification(setClassification(newDraft({ idFactory }), 'category', DetailCategory.FIGURE), 'view', DetailView.ELEVATION);
  assert.equal(tryFit(empty, dims).error.code, 'invalid', 'ストロークの無い図');
  assert.equal(tryFit(f, { wallThickness: '105', faceWidth: '20', projection: '12' }).error.code, 'badFitDim');
});

test('姿図の試し込み欄: 分類が姿図なら 幅・高さ・窓台、それ以外は壁厚・見付・出幅。既定は代表の建具種別の既定幅・高さと窓台 0', () => {
  const el = elevationDraft();
  assert.deepEqual(fitDimFieldsFor(el).map(x => x.field), ['width', 'height', 'sill']);
  assert.deepEqual(fitDimFieldsFor(newDraft({ idFactory })).map(x => x.field), ['wallThickness', 'faceWidth', 'projection']);
  const rep = findCatalogEntry('fitting', 'singleSwing');
  assert.deepEqual(defaultFitDimsFor(el, 105), { width: String(rep.defaultWidth), height: String(rep.defaultHeight), sill: '0' });
  assert.ok(Number(rep.defaultWidth) > 0 && Number(rep.defaultHeight) > 0);
  assert.deepEqual(defaultFitDimsFor(newDraft({ idFactory }), 105), defaultFitDims(105));
  assert.equal(tryFit(el, defaultFitDimsFor(el, 105)).error, undefined, '既定の寸法でそのまま試し込める');
});

test('defaultFitDims: 見付・出幅は建具の既定、壁厚は渡した値', () => {
  assert.deepEqual(defaultFitDims(105), { wallThickness: '105', faceWidth: String(DEFAULT_FRAME_FACE_MM), projection: String(DEFAULT_FRAME_PROJECTION_MM) });
  assert.deepEqual([DEFAULT_FRAME_FACE_MM, DEFAULT_FRAME_PROJECTION_MM], [20, 12]);
});

test('previewPrimitivesOf: 下書きは各手の dim が editable＋editKey。dim の editKey から手を特定して長さを書き換えられる', () => {
  let f = drawAll(newDraft({ idFactory }), [[PenDir.RIGHT, '100'], [PenDir.DOWN, '40']]);
  const prims = previewPrimitivesOf(f);
  const dims = prims.filter(p => p.type === SvgFigurePrimitiveType.DIM);
  assert.deepEqual(dims.map(d => [d.editable, d.editKey, d.label]), [
    [true, { strokeId: 's1', moveIndex: 0 }, 100], [true, { strokeId: 's1', moveIndex: 1 }, 40],
  ]);
  f = setMoveLen(f, dims[1].editKey, String(55));
  assert.deepEqual(f.strokes[0].moves.map(m => m.len), ['100', '55']);
  assert.deepEqual(previewPrimitivesOf(newDraft({ idFactory })), []);
});

test('previewPrimitivesOf: 試し込み結果があればその形（dim なし・頂点番号あり）。error なら下書きへ戻る。不正な欄でも座標は NaN にならない', () => {
  const f = stretchableDraft();
  const fitted = tryFit(f, { wallThickness: '105', faceWidth: '20', projection: '12' });
  const prims = previewPrimitivesOf(f, fitted);
  assert.equal(prims.some(p => p.type === SvgFigurePrimitiveType.DIM), false);
  const line = prims.find(p => p.type === SvgFigurePrimitiveType.POLYLINE);
  assert.deepEqual(line.points[4], [20, 105]);
  assert.equal(prims.filter(p => p.type === SvgFigurePrimitiveType.TEXT).length, 6);
  assert.ok(previewPrimitivesOf(f, { error: { code: 'x' } }).some(p => p.type === SvgFigurePrimitiveType.DIM));
  const badOffset = setDatumField(f, 'd1', 'offset', 'zz');
  const pts = previewPrimitivesOf(badOffset).find(p => p.type === SvgFigurePrimitiveType.POLYLINE).points.flat();
  assert.ok(pts.every(Number.isFinite));
});

test('duplicateForm: 別キー・呼称に「のコピー」。内容は同じ', () => {
  const f = stretchableDraft();
  const d = duplicateForm(f, { idFactory: () => 'zzz' });
  assert.equal(d.key, 'df-zzz');
  assert.equal(d.label, 'コの字 のコピー');
  assert.deepEqual(d.strokes, f.strokes);
});

test('isDraftDirty: 基準と同じなら false、編集すると true、戻すと false', () => {
  const base = stretchableDraft();
  assert.equal(isDraftDirty(base, base), false);
  assert.equal(isDraftDirty(base, formFromEntry(entryFromForm(base))), false);
  const edited = setMoveLen(base, { strokeId: 's1', moveIndex: 0 }, '21');
  assert.equal(isDraftDirty(edited, base), true);
  assert.equal(isDraftDirty(setMoveLen(edited, { strokeId: 's1', moveIndex: 0 }, '20'), base), false);
  assert.equal(isDraftDirty({ ...base, label: 'x' }, base), true);
});

test('libraryRows: 呼称順で分類のラベルを持つ', () => {
  const rows = libraryRows([
    { key: 'k2', label: 'い', category: 'paired', view: 'plan', subject: 'jamb' },
    { key: 'k1', label: 'あ', category: 'freePart', view: 'section', subject: 'eave' },
  ]);
  assert.deepEqual(rows.map(r => [r.key, r.categoryLabel, r.viewLabel, r.subjectLabel]), [
    ['k1', '自由部位', '断面', '軒先'], ['k2', '対の部位', '平面', '方立（縦枠）'],
  ]);
});

test('ラベル表: 全 enum 値を持つ（subject 17・role 15・mode 4・param 4・材の項目 3・kind 2・axis 2・方向）', () => {
  const keysOf = o => Object.keys(o).sort();
  assert.deepEqual(keysOf(DETAIL_SUBJECT_LABELS), Object.values(DetailSubject).sort());
  assert.equal(Object.keys(DETAIL_SUBJECT_LABELS).length, 17);
  assert.deepEqual(keysOf(DETAIL_ROLE_LABELS), Object.values(DetailDatumRole).sort());
  assert.equal(Object.keys(DETAIL_ROLE_LABELS).length, 15);
  assert.deepEqual(keysOf(DETAIL_MODE_LABELS), Object.values(DetailLenMode).sort());
  assert.deepEqual(keysOf(DETAIL_PARAM_LABELS), Object.values(DetailParam).sort());
  assert.deepEqual(keysOf(DETAIL_MATERIAL_FIELD_LABELS), Object.values(DetailMaterialField).sort());
  assert.deepEqual(keysOf(DETAIL_DATUM_KIND_LABELS), Object.values(DetailDatumKind).sort());
  assert.deepEqual(keysOf(DETAIL_AXIS_LABELS), Object.values(DetailAxis).sort());
  assert.deepEqual(keysOf(PEN_DIR_LABELS), Object.values(PenDir).sort());
  assert.deepEqual(PEN_BUTTONS.map(b => b.label), ['↑', '←', '→', '↓']);
  for (const table of [DETAIL_SUBJECT_LABELS, DETAIL_ROLE_LABELS, DETAIL_MODE_LABELS, DETAIL_PARAM_LABELS, DETAIL_MATERIAL_FIELD_LABELS]) {
    for (const label of Object.values(table)) assert.ok(typeof label === 'string' && label.length > 0);
  }
});

test('formatDetailSubjectLabel: 既知は日本語・未知や非文字列は投げずに生の値の整形へ', () => {
  assert.equal(formatDetailSubjectLabel('eave'), '軒先');
  assert.equal(formatDetailSubjectLabel('zzz'), 'zzz');
  assert.doesNotThrow(() => formatDetailSubjectLabel(null));
  assert.doesNotThrow(() => formatDetailSubjectLabel('toString'));
});

const DF = CatalogKind.DETAIL_FIGURE;
const docContextOf = () => ({ docKeys: new Set(), diffMap: docDiffMap(DF, []) });

test('T1 planSave: ライブラリと同梱に同じキーの図を編集・保存すると、同梱を外す（removeDocKey）プランになり、確認文を返す', () => {
  const entry = entryFromForm(stretchableDraft());
  try {
    setOverlay(DF, { user: [entry], doc: [entry] });
    const ctx = { docKeys: new Set([entry.key]), diffMap: docDiffMap(DF, []) };
    assert.deepEqual(saveContextFor(entry, ctx), { rowState: 'doc-same', blocked: null });
    const edited = entryFromForm(setMoveLen(formFromEntry(entry), { strokeId: 's1', moveIndex: 0 }, '21'));
    const plan = planSave(edited, entry, ctx);
    assert.equal(plan.ok, true);
    assert.equal(plan.removeDocKey, 'df-abc');
    assert.equal(plan.needsConfirm, true);
    const decision = saveDecision(plan);
    assert.equal(decision.apply, true);
    assert.ok(decision.confirmMessage.includes('線'), decision.confirmMessage);
  } finally {
    clearOverlays();
  }
});

test('T1 planSave: 同梱が無ければ removeDocKey なし・確認なし。同梱の内容がライブラリと違う図は編集不可（blocked）。新規は rowState なし', () => {
  const entry = entryFromForm(stretchableDraft());
  const edited = entryFromForm(setMoveLen(formFromEntry(entry), { strokeId: 's1', moveIndex: 0 }, '21'));
  try {
    setOverlay(DF, { user: [entry] });
    const plan = planSave(edited, entry, docContextOf());
    assert.equal(plan.removeDocKey, null);
    assert.equal(plan.needsConfirm, false);
    assert.equal(saveDecision(plan).confirmMessage, null);
    assert.deepEqual(saveContextFor(entry, docContextOf()), { rowState: 'user', blocked: null });

    const stale = entryFromForm(setMoveLen(formFromEntry(entry), { strokeId: 's1', moveIndex: 0 }, '33'));
    setOverlay(DF, { user: [entry], doc: [stale] });
    const ctx = { docKeys: new Set([entry.key]), diffMap: docDiffMap(DF, []) };
    const blocked = planSave(edited, entry, ctx);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.message.length > 0);
    assert.deepEqual(saveContextFor(null, ctx), { rowState: null, blocked: null });
  } finally {
    clearOverlays();
  }
});

test('T2 afterSaveDoc: 保存中に別の図へ切り替わっていたら doc を変えない。同じ図なら baseline・prevEntry を更新', () => {
  const a = stretchableDraft();
  const b = { ...newDraft({ idFactory: () => 'other' }), label: '別' };
  const entryA = entryFromForm(a);
  const docA = { form: a, history: [], baseline: null, prevEntry: null };
  const docB = { form: b, history: [], baseline: b, prevEntry: null };
  assert.equal(afterSaveDoc(docB, entryA, a), docB);
  const done = afterSaveDoc(docA, entryA, a);
  assert.equal(done.baseline, a);
  assert.equal(done.prevEntry, entryA);
});

test('T5 wallThicknessNotice: 材一覧の読込み失敗のときだけ「既定値で代用中」の注記を返す', () => {
  assert.equal(wallThicknessNotice(false), null);
  assert.equal(wallThicknessNotice(true), DETAIL_HELPER_MESSAGES.materialLoadFailed);
  assert.ok(DETAIL_HELPER_MESSAGES.materialLoadFailed.includes('既定値'));
});

test('T6 setMoveMode: 手の未知の項目は残し、mode に属さない param／code／field は外す', () => {
  const f = drawAll(newDraft({ idFactory }), [[PenDir.RIGHT, '10']]);
  const withFoo = { ...f, strokes: [{ ...f.strokes[0], moves: [{ ...f.strokes[0].moves[0], foo: 1 }] }] };
  const key = { strokeId: 's1', moveIndex: 0 };
  const p = setMoveMode(withFoo, key, DetailLenMode.PARAM);
  assert.deepEqual(p.strokes[0].moves[0], { dir: 'R', mode: 'param', len: '10', foo: 1, param: 'frameFaceWidth' });
  const m = setMoveMode(p, key, DetailLenMode.MATERIAL, { code: 'c' });
  assert.deepEqual(m.strokes[0].moves[0], { dir: 'R', mode: 'material', len: '10', foo: 1, code: 'c', field: 'thickness' });
  assert.deepEqual(setMoveMode(m, key, DetailLenMode.FIXED).strokes[0].moves[0], { dir: 'R', mode: 'fixed', len: '10', foo: 1 });
  assert.equal(entryFromForm(m).strokes[0].moves[0].foo, 1);
});

test('penStep: 現在の doc から計算し、成功は履歴へ積む・失敗は form を変えず penError に理由。連続適用でも取りこぼさない', () => {
  const d0 = { form: newDraft({ idFactory }), history: [], baseline: null, prevEntry: null };
  const d1 = penStep(penStep(d0, PenDir.RIGHT, '10'), PenDir.DOWN, '5');
  assert.deepEqual(d1.form.strokes[0].moves.map(m => m.len), ['10', '5']);
  assert.equal(d1.history.length, 2);
  assert.equal(d1.penError, null);
  const bad = penStep(d1, PenDir.UP, '-3');
  assert.equal(bad.form, d1.form);
  assert.equal(bad.history, d1.history);
  assert.equal(bad.penError, '距離は正の数で入力してください（向きは方向ボタンで決まります）');
  assert.equal(penStep(bad, PenDir.UP, '3').penError, null);
});

test('applyPen: 式の評価値は 1e-6 で丸めてから文字列にする（0.1+0.2 → 0.3）', () => {
  assert.equal(applyPen(newDraft({ idFactory }), PenDir.RIGHT, '0.1+0.2').form.strokes[0].moves[0].len, '0.3');
});

test('saveBlockers: 検証エラーを日本語の場所つきで返す（BAD_LENGTH → ストローク 1・P2 の長さ…）。表に無い code は元の message', () => {
  let f = { ...newDraft({ idFactory }), label: 'x' };
  f = drawAll(f, [[PenDir.RIGHT, '10'], [PenDir.DOWN, '10'], [PenDir.LEFT, '10']]);
  f = setMoveLen(f, { strokeId: 's1', moveIndex: 2 }, '');
  assert.deepEqual(saveBlockers(f, validation(f)), ['ストローク 1・P2 の長さが 0 より大きい数ではありません']);
  const g = setDatumField(drawAll({ ...newDraft({ idFactory }), label: 'x' }, [[PenDir.RIGHT, '10']]), 'd1', 'offset', 'zz');
  assert.deepEqual(saveBlockers(g, validation(g)), ['基準 1 のオフセットが数値ではありません']);
  const raw = { code: DetailValidationError.STRETCH_COUNT, message: '元の文言', path: 'strokes[0]' };
  assert.equal(describeError(raw), '元の文言');
});

test('T2b afterDeleteDoc: 削除したキーを開いている doc だけ新しい下書きへ。削除中に別の図へ切り替わっていたら doc をそのまま', () => {
  const a = stretchableDraft();
  const entryA = entryFromForm(a);
  const docA = docFromEntry(entryA);
  const fresh = freshDocOf(newDraft({ idFactory: () => 'fresh' }));
  assert.equal(afterDeleteDoc(docA, entryA.key, fresh), fresh);
  const other = freshDocOf(newDraft({ idFactory: () => 'other' }));
  assert.equal(afterDeleteDoc(other, entryA.key, fresh), other);
  const dup = duplicateDoc(docA, { idFactory: () => 'dup' });
  assert.equal(afterDeleteDoc(dup, entryA.key, fresh), dup);
});

test('doc の組み立て: freshDocOf は未編集・docFromEntry は開いた直後が基準・duplicateDoc は baseline null／別キー／「のコピー」', () => {
  const f = newDraft({ idFactory });
  const fresh = freshDocOf(f);
  assert.deepEqual(fresh, { form: f, history: [], baseline: f, prevEntry: null });
  assert.equal(isDraftDirty(fresh.form, fresh.baseline), false);
  const entry = entryFromForm(stretchableDraft());
  const opened = docFromEntry(entry);
  assert.equal(opened.prevEntry, entry);
  assert.equal(opened.baseline, opened.form);
  assert.deepEqual(entryFromForm(opened.form), entry);
  const dup = duplicateDoc(opened, { idFactory: () => 'zzz' });
  assert.equal(dup.baseline, null);
  assert.equal(dup.prevEntry, null);
  assert.deepEqual(dup.history, []);
  assert.equal(dup.form.key, 'df-zzz');
  assert.equal(dup.form.label, 'コの字 のコピー');
  assert.equal(isDraftDirty(dup.form, dup.baseline), true);
});

test('clearPenError: エラーがあれば消し、無ければ同じ doc を返す', () => {
  const d = { form: newDraft({ idFactory }), history: [], baseline: null, prevEntry: null, penError: '距離を入力してください' };
  assert.equal(clearPenError(d).penError, null);
  const clean = { ...d, penError: null };
  assert.equal(clearPenError(clean), clean);
});

test('docContextFor: 注入された overlayFor／docDiffMap から同梱キー集合と差分表を作る', () => {
  const diffMap = new Map();
  const ctx = docContextFor('k', { overlayFor: kind => ({ doc: [{ key: 'a' }, { key: 'b' }], user: [], kind }), docDiffMap: (kind, list) => (kind === 'k' && list.length === 0 ? diffMap : null) });
  assert.deepEqual([...ctx.docKeys], ['a', 'b']);
  assert.equal(ctx.diffMap, diffMap);
});

test('displayLen: 空は「—」・それ以外は文字列', () => {
  assert.equal(displayLen(''), '—');
  assert.equal(displayLen(null), '—');
  assert.equal(displayLen('12'), '12');
});
