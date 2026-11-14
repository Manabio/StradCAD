// ui/detailHelperForm.js（ヘルパー画面の純ロジック）のテスト。期待値は定数で書く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis,
  DetailParam, DetailMaterialField, DetailDash, DetailPlacementView, DetailProductField, DETAIL_VIEW_COMBOS, DETAIL_DRAFT_HISTORY_MAX, SvgFigurePrimitiveType,
} from '../core/constants.js';
import { DetailValidationError } from '../detail/detailModel.js';
import { DEFAULT_FRAME_FACE_MM, DEFAULT_FRAME_PROJECTION_MM, findCatalogEntry } from '../openings/openingCatalog.js';
import { DETAIL_SUBJECT_LABELS, formatDetailSubjectLabel } from '../catalog/catalogMaintenance.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays, docDiffMap } from '../catalog/catalogRegistry.js';
import {
  newDraft, formFromEntry, entryFromForm, duplicateForm, isDraftDirty, pushHistory, undoDraft, applyPen, penUp, setClosed, setDashRole, DETAIL_DASH_LABELS,
  setMoveLen, setMoveMode, moveRows, addDatum, removeDatum, setDatumField, setAnchor, anchorVertex, vertexOptions,
  comboOptions, setClassification, validation, saveBlockers, saveEnabled, libraryRows, defaultFitDims, tryFit,
  isElevationFigureForm, defaultRoleFor, fitDimFieldsFor, defaultFitDimsFor,
  DETAIL_PLACEMENT_VIEW_LABELS, labelOptions, DETAIL_HELPER_TEXT, placementViewOptions, setPlacementView, setProductField,
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

test('T2-2 setDashRole: 指定ストロークの line.dashRole だけ変わり、weightRole・他ストローク・手・closed は不変。moveRows に出て、保存形（entryFromForm）へ届く', () => {
  let f = penUp(drawAll(newDraft({ idFactory }), [[PenDir.RIGHT, '10'], [PenDir.DOWN, '7']]));
  f = drawAll(f, [[PenDir.UP, '3']]);
  const before = f;
  const g = setDashRole(f, 's2', DetailDash.SWING);
  assert.deepEqual(g.strokes.map(s => s.line.dashRole), [DetailDash.SOLID, DetailDash.SWING]);
  assert.equal(g.strokes[1].line.weightRole, before.strokes[1].line.weightRole);
  assert.equal(g.strokes[0], before.strokes[0], '他のストロークは同一参照');
  assert.deepEqual(g.strokes[1].moves, before.strokes[1].moves);
  assert.equal(g.strokes[1].closed, before.strokes[1].closed);
  assert.equal(before.strokes[1].line.dashRole, DetailDash.SOLID, '元の form は変えない');
  assert.deepEqual(moveRows(g).map(r => r.dashRole), [DetailDash.SOLID, DetailDash.SWING]);
  assert.deepEqual(entryFromForm(g).strokes.map(s => s.line.dashRole), [DetailDash.SOLID, DetailDash.SWING]);
  assert.equal(setDashRole(g, 's2', DetailDash.DASHED).strokes[1].line.dashRole, DetailDash.DASHED);
  // line を持たない旧形のストロークでも既定の weightRole を補って役割だけ付く
  const bare = { ...before, strokes: before.strokes.map(s => ({ id: s.id, closed: s.closed, moves: s.moves })) };
  assert.equal(setDashRole(bare, 's1', DetailDash.DASHED).strokes[0].line.dashRole, DetailDash.DASHED);
});

test('T2-2 DETAIL_DASH_LABELS: 線の役割は 3 つ（実線・破線・開き勝手）で DetailDash の全値を過不足なく覆う', () => {
  assert.deepEqual(DETAIL_DASH_LABELS, { [DetailDash.SOLID]: '実線', [DetailDash.DASHED]: '破線', [DetailDash.SWING]: '開き勝手' });
  assert.deepEqual(Object.keys(DETAIL_DASH_LABELS).sort(), Object.values(DetailDash).sort());
});

test('【失敗系】T2-2 setDashRole: 未知の役割・無い strokeId は form を変えずそのまま返す（edit が同一参照を履歴に積まない）', () => {
  const f = drawAll(newDraft({ idFactory }), [[PenDir.RIGHT, '10']]);
  assert.equal(setDashRole(f, 's1', 'zigzag'), f);
  assert.equal(setDashRole(f, 's1', undefined), f);
  assert.equal(setDashRole(f, 'nope', DetailDash.SWING), f);
});

test('T2-2 previewPrimitivesOf: 開き勝手の役割のストロークはプレビューでは実線（dash なし）。破線の役割は破線のまま（R3）', () => {
  const f = drawAll(newDraft({ idFactory }), [[PenDir.RIGHT, '100']]);
  const lineOf = form => previewPrimitivesOf(form).find(p => !p.guide && (p.type === SvgFigurePrimitiveType.POLYLINE || p.type === SvgFigurePrimitiveType.LINE));
  assert.equal(lineOf(setDashRole(f, 's1', DetailDash.SWING)).dash, undefined);
  assert.equal(lineOf(setDashRole(f, 's1', DetailDash.DASHED)).dash, DetailDash.DASHED);
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
  assert.deepEqual(o.categories.map(c => c.value), ['part', 'junction', 'freePart', 'paired', 'figure', 'fitting']);
  const j = comboOptions(DetailCategory.JUNCTION, DetailView.SECTION);
  assert.deepEqual(j.views.map(v => v.value), ['section']);
  assert.deepEqual(j.subjects.map(s => s.value), ['floorWall', 'wallCeiling']);
  assert.deepEqual(comboOptions(DetailCategory.JUNCTION, DetailView.PLAN).subjects, []);
});

test('comboOptions: 姿図の主題の選択肢に電気設備が表示名つきで出る（平面・立面とも）。断面の姿図には出ない', () => {
  for (const view of [DetailView.PLAN, DetailView.ELEVATION]) {
    const s = comboOptions(DetailCategory.FIGURE, view).subjects;
    assert.deepEqual(s.find(o => o.value === DetailSubject.ELECTRICAL), { value: 'electrical', label: '電気設備' });
  }
  assert.equal(comboOptions(DetailCategory.FIGURE, DetailView.SECTION).subjects.some(o => o.value === DetailSubject.ELECTRICAL), false);
  assert.equal(formatDetailSubjectLabel(DetailSubject.ELECTRICAL), '電気設備');
});

test('comboOptions: 分類の選択肢に FITTING（建具一式）を出す（平面・断面のどちらの絞り込みでも）', () => {
  for (const view of [DetailView.PLAN, DetailView.SECTION]) {
    const values = comboOptions(DetailCategory.PAIRED, view).categories.map(c => c.value);
    assert.ok(values.includes(DetailCategory.FITTING));
    for (const c of Object.values(DetailCategory)) assert.ok(values.includes(c), c);
    assert.equal(values.length, 6);
  }
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
  assert.equal(prims.filter(p => p.type === SvgFigurePrimitiveType.TEXT && !p.guide).length, 6);
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

test('ラベル表: 全 enum 値を持つ（subject 18・role 16・mode 4・param 4・材の項目 3・kind 2・axis 2・方向）', () => {
  const keysOf = o => Object.keys(o).sort();
  assert.deepEqual(keysOf(DETAIL_SUBJECT_LABELS), Object.values(DetailSubject).sort());
  assert.equal(Object.keys(DETAIL_SUBJECT_LABELS).length, 18);
  assert.deepEqual(keysOf(DETAIL_ROLE_LABELS), Object.values(DetailDatumRole).sort());
  assert.equal(Object.keys(DETAIL_ROLE_LABELS).length, 16);
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

// 姿図の配置（図/平面/衛生器具）の下書き。R20・D10・R15・D25（開）。頂点 2＝(20,10)・基準 d1（s）・d2（t）とも頂点 2 に載せる。
function placedDraft() {
  let f = newDraft({ idFactory });
  f = setClassification(f, 'category', DetailCategory.FIGURE);
  f = setClassification(f, 'view', DetailView.PLAN);
  f = setClassification(f, 'subject', DetailSubject.SANITARY);
  f = drawAll({ ...f, label: '便器' }, [[PenDir.RIGHT, '20'], [PenDir.DOWN, '10'], [PenDir.RIGHT, '15'], [PenDir.DOWN, '25']]);
  return setAnchor(setAnchor(f, 's1', 'd2', 2), 's1', 'd1', 2);
}

test('姿図の配置: 新規基準の既定 role は s・t とも PLACEMENT_ORIGIN。他の分類の既定は不変', () => {
  const f = placedDraft();
  assert.deepEqual(f.datums.map(d => d.role), [DetailDatumRole.PLACEMENT_ORIGIN, DetailDatumRole.PLACEMENT_ORIGIN]);
  assert.equal(defaultRoleFor(f, DetailAxis.S, DetailDatumKind.ORIGIN), DetailDatumRole.PLACEMENT_ORIGIN);
  assert.equal(defaultRoleFor(f, DetailAxis.T, DetailDatumKind.END), DetailDatumRole.PLACEMENT_ORIGIN);
  assert.equal(addDatum(f, {}).datums.at(-1).role, DetailDatumRole.PLACEMENT_ORIGIN, '追加した基準も配置の原点');
  const frame = newDraft({ idFactory });
  assert.deepEqual(frame.datums.map(d => d.role), [DetailDatumRole.OPENING_OUTER, DetailDatumRole.WALL_FINISH_FACE]);
});

test('姿図の配置: 分類を建具の姿図 ⇄ 配置図に変えると既定 role の基準は移行先の既定へ再計算される（選んだ role は触らない）', () => {
  const placed = placedDraft();
  const toOpening = setClassification(setClassification(placed, 'view', DetailView.ELEVATION), 'subject', DetailSubject.OPENING);
  assert.deepEqual(toOpening.datums.map(d => d.role), [DetailDatumRole.OPENING_OUTER, DetailDatumRole.SILL]);
  const back = setClassification(toOpening, 'subject', DetailSubject.FURNITURE);
  assert.deepEqual(back.datums.map(d => d.role), [DetailDatumRole.PLACEMENT_ORIGIN, DetailDatumRole.PLACEMENT_ORIGIN]);
  // 平面 ⇄ 立面側の配置図どうしは role を変えない
  assert.deepEqual(setClassification(placed, 'view', DetailView.ELEVATION).datums.map(d => d.role), [DetailDatumRole.PLACEMENT_ORIGIN, DetailDatumRole.PLACEMENT_ORIGIN]);
  // ユーザーが選んだ role は配置図へ移っても触らない
  const chosen = setDatumField(toOpening, 'd1', 'role', DetailDatumRole.HEAD);
  assert.equal(setClassification(chosen, 'subject', DetailSubject.HVAC).datums[0].role, DetailDatumRole.HEAD);
  // 三方枠（paired）から配置図へも寄せる
  const fromFrame = setClassification(setClassification(newDraft({ idFactory }), 'category', DetailCategory.FIGURE), 'subject', DetailSubject.SANITARY);
  assert.deepEqual(fromFrame.datums.map(d => d.role), [DetailDatumRole.PLACEMENT_ORIGIN, DetailDatumRole.PLACEMENT_ORIGIN]);
});

test('姿図の配置 tryFit: placedFigureTargets で解ける（寸法欄に依らない）。別 role の基準を持つ配置図は unsupportedDatum', () => {
  const f = placedDraft();
  const fitted = tryFit(f, {});
  assert.equal(fitted.error, undefined);
  assert.deepEqual(fitted.strokes[0].points.map(p => [p.s, p.t]), [[-20, -10], [0, -10], [0, 0], [15, 0], [15, 25]]);
  const bad = tryFit(setDatumField(f, 'd1', 'role', DetailDatumRole.WALL_FINISH_FACE), {});
  assert.equal(bad.error.code, 'unsupportedDatum');
  assert.match(bad.error.message, /姿図の配置では使えません/);
  assert.equal(tryFit({ ...f, strokes: [] }, {}).error.code, 'invalid', '図が不正');
});

// ---- P2-3: 姿図の図の束（views） ----
const mkFig = (key, category, view, subject, label = key) => ({ key, label, category, view, subject });
const VIEW_CATALOG = [
  mkFig('f_front', DetailCategory.FIGURE, DetailView.ELEVATION, DetailSubject.SANITARY, '便器 正面'),
  mkFig('f_front2', DetailCategory.FIGURE, DetailView.ELEVATION, DetailSubject.SANITARY, '便器 正面'),
  mkFig('f_other', DetailCategory.FIGURE, DetailView.ELEVATION, DetailSubject.FURNITURE, '家具 正面'),
  mkFig('f_plan', DetailCategory.FIGURE, DetailView.PLAN, DetailSubject.SANITARY, '便器 平面'),
  mkFig('f_ceil', DetailCategory.FIGURE, DetailView.PLAN, DetailSubject.SANITARY, '便器 見上げ'),
  mkFig('f_hvac_ceil', DetailCategory.FIGURE, DetailView.PLAN, DetailSubject.HVAC, '空調 見上げ'),
  mkFig('f_elec_ceil', DetailCategory.FIGURE, DetailView.PLAN, DetailSubject.ELECTRICAL, '電気 見上げ'),
];

test('DETAIL_PLACEMENT_VIEW_LABELS: DetailPlacementView の全 5 値を網羅し、承認済みの文言と表示の並びになる', () => {
  const labelKeys = new Set(Object.keys(DETAIL_PLACEMENT_VIEW_LABELS));
  const enumValues = new Set(Object.values(DetailPlacementView));
  assert.equal(labelKeys.size, 5);
  assert.equal(enumValues.size, 5);
  assert.equal([...labelKeys].every(k => enumValues.has(k)), true, '全 5 値を網羅');
  // 表示の並び（欄が使う形）。製図の呼び方で 正面図・背面図・左側面図・右側面図・見上げ図＝キーは right が left より先
  const opts = labelOptions(DETAIL_PLACEMENT_VIEW_LABELS);
  assert.deepEqual(opts.map(o => o.value), ['front', 'back', 'right', 'left', 'ceiling']);
  assert.deepEqual(opts.map(o => o.label), ['正面図', '背面図', '左側面図', '右側面図', '見上げ図']);
  assert.deepEqual([DETAIL_PLACEMENT_VIEW_LABELS.left, DETAIL_PLACEMENT_VIEW_LABELS.right], ['右側面図', '左側面図']); // 表示名は製図の呼び方（キー left＝右側面図・right＝左側面図）
  assert.equal(DETAIL_HELPER_TEXT.viewsGroup, '図の束');
});

test('placementViewOptions: 先頭は「なし」。view ごとに置ける図・同じ主題・自分自身以外だけ。同呼称にはキーを添える', () => {
  const f = { ...placedDraft(), key: 'dtl_self' };
  const front = placementViewOptions(f, VIEW_CATALOG, DetailPlacementView.FRONT);
  assert.deepEqual(front, [
    { value: '', label: 'なし' },
    { value: 'f_front', label: '便器 正面（f_front）' },
    { value: 'f_front2', label: '便器 正面（f_front2）' },
  ]);
  // 見上げ図は平面の図の中から（衛生器具は天伏に置けない＝空調だけ）
  assert.deepEqual(placementViewOptions(f, VIEW_CATALOG, DetailPlacementView.CEILING), [{ value: '', label: 'なし' }]);
  const hvac = setClassification(f, 'subject', DetailSubject.HVAC);
  assert.deepEqual(placementViewOptions(hvac, VIEW_CATALOG, DetailPlacementView.CEILING).map(o => o.value), ['', 'f_hvac_ceil']);
  // 電気の配置図には電気の見上げ図だけ（空調・衛生の図は返さない）。衛生の図には電気の図を返さない
  const elec = setClassification(f, 'subject', DetailSubject.ELECTRICAL);
  assert.deepEqual(placementViewOptions(elec, VIEW_CATALOG, DetailPlacementView.CEILING).map(o => o.value), ['', 'f_elec_ceil']);
  assert.equal(placementViewOptions(f, VIEW_CATALOG, DetailPlacementView.CEILING).some(o => o.value === 'f_elec_ceil'), false);
  assert.equal(placementViewOptions(hvac, VIEW_CATALOG, DetailPlacementView.CEILING).some(o => o.value === 'f_elec_ceil'), false);
  // 自分自身は除く
  const self = { ...f, key: 'f_front' };
  assert.deepEqual(placementViewOptions(self, VIEW_CATALOG, DetailPlacementView.FRONT).map(o => o.value), ['', 'f_front2']);
});

test('【失敗系】placementViewOptions: 配置図でない form・未知の view・catalog 無しは「なし」だけ。参照切れ／分類違いのキーは理由付きで残す', () => {
  const none = [{ value: '', label: 'なし' }];
  assert.deepEqual(placementViewOptions(newDraft({ idFactory }), VIEW_CATALOG, DetailPlacementView.FRONT), none);
  assert.deepEqual(placementViewOptions(placedDraft(), VIEW_CATALOG, 'oblique'), none);
  assert.deepEqual(placementViewOptions(placedDraft(), null, DetailPlacementView.FRONT), none);
  const missing = setPlacementView(placedDraft(), DetailPlacementView.BACK, 'gone');
  assert.deepEqual(placementViewOptions(missing, VIEW_CATALOG, DetailPlacementView.BACK).at(-1), { value: 'gone', label: '（見つかりません）gone' });
  const wrong = setPlacementView(placedDraft(), DetailPlacementView.BACK, 'f_other');
  assert.deepEqual(placementViewOptions(wrong, VIEW_CATALOG, DetailPlacementView.BACK).at(-1), { value: 'f_other', label: '（この枠には使えません）f_other' });
});

test('setPlacementView: 設定・上書き・解除。空になったら views ごと消す。他の項目は不変', () => {
  const f = placedDraft();
  const a = setPlacementView(f, DetailPlacementView.FRONT, 'f_front');
  assert.deepEqual(a.views, { front: 'f_front' });
  assert.equal(a.label, f.label);
  const b = setPlacementView(a, DetailPlacementView.LEFT, 'f_l');
  assert.deepEqual(b.views, { front: 'f_front', left: 'f_l' });
  assert.deepEqual(setPlacementView(b, DetailPlacementView.FRONT, 'f_x').views, { front: 'f_x', left: 'f_l' });
  assert.deepEqual(setPlacementView(b, DetailPlacementView.FRONT, '').views, { left: 'f_l' });
  const c = setPlacementView(a, DetailPlacementView.FRONT, '');
  assert.equal(Object.hasOwn(c, 'views'), false, '空になったら項目ごと消える');
  assert.equal(isDraftDirty(c, f), false);
});

test('【失敗系】setPlacementView: views が文字列・配列のとき {} から始める。未知キーは set 時に落とさず残す', () => {
  const f = placedDraft();
  assert.deepEqual(setPlacementView({ ...f, views: 'x' }, DetailPlacementView.FRONT, 'k').views, { front: 'k' });
  assert.deepEqual(setPlacementView({ ...f, views: ['a'] }, DetailPlacementView.FRONT, 'k').views, { front: 'k' });
  assert.deepEqual(setPlacementView({ ...f, views: { oblique: 'z' } }, DetailPlacementView.FRONT, 'k').views, { oblique: 'z', front: 'k' });
});

test('【失敗系】setPlacementView: 配置図でない form・未知の view・文字列でない値は同一参照を返す。無いものの解除も不変', () => {
  const plain = newDraft({ idFactory });
  assert.equal(setPlacementView(plain, DetailPlacementView.FRONT, 'f_front'), plain);
  const f = placedDraft();
  assert.equal(setPlacementView(f, 'oblique', 'f_front'), f);
  assert.equal(setPlacementView(f, DetailPlacementView.FRONT, null), f);
  assert.equal(setPlacementView(f, DetailPlacementView.FRONT, ''), f, 'views の無い form の解除は同一参照');
});

test('views の往復: formFromEntry ⇄ entryFromForm。views 無しは無し・空は書かない・順序は DetailPlacementView の順', () => {
  const f = placedDraft();
  const e0 = entryFromForm(f);
  assert.equal(Object.hasOwn(e0, 'views'), false);
  assert.equal(Object.hasOwn(formFromEntry(e0), 'views'), false);
  const withViews = setPlacementView(setPlacementView(setPlacementView(f, DetailPlacementView.CEILING, 'c'), DetailPlacementView.FRONT, 'a'), DetailPlacementView.LEFT, 'l');
  const e1 = entryFromForm(withViews);
  assert.deepEqual(Object.keys(e1.views), ['front', 'left', 'ceiling']);
  assert.deepEqual(formFromEntry(e1).views, e1.views);
  assert.deepEqual(entryFromForm(formFromEntry(e1)), e1);
  // 保存の並びは表示の並びと別＝right と left を表示順（RIGHT→LEFT）で入れても enum の順
  const rl = setPlacementView(setPlacementView(f, DetailPlacementView.RIGHT, 'r'), DetailPlacementView.LEFT, 'l');
  assert.deepEqual(Object.keys(entryFromForm(rl).views), ['left', 'right']);
  // 空の {} は書かない（持てない分類の {} は BAD_VIEWS のため）。null も無しと同じ
  assert.equal(Object.hasOwn(entryFromForm({ ...f, views: {} }), 'views'), false);
  assert.equal(Object.hasOwn(formFromEntry({ ...e0, views: null }), 'views'), false);
  // 保存形は検証を通る
  assert.equal(validation(withViews).ok, true);
});

test('setClassification: 図の束を持てない分類へ変えると views を落とす（BAD_VIEWS を避ける）。配置図どうしでは保つ', () => {
  const f = setPlacementView(placedDraft(), DetailPlacementView.FRONT, 'f_front');
  assert.deepEqual(setClassification(f, 'subject', DetailSubject.HVAC).views, { front: 'f_front' });
  const toOpening = setClassification(setClassification(f, 'view', DetailView.ELEVATION), 'subject', DetailSubject.OPENING);
  assert.equal(Object.hasOwn(toOpening, 'views'), false);
  assert.equal(validation(toOpening).errors.some(e => e.code === DetailValidationError.BAD_VIEWS), false);
  // 平面の配置図を立面側へ（views を持てない）
  assert.equal(Object.hasOwn(setClassification(f, 'view', DetailView.ELEVATION), 'views'), false);
  // 落とさなければ BAD_VIEWS になる（検出力）
  assert.equal(validation({ ...toOpening, views: { front: 'f_front' } }).errors.some(e => e.code === DetailValidationError.BAD_VIEWS), true);
});

// ---- S1: 製品情報（product） ----
const typedProduct = (form, ...pairs) => pairs.reduce((f, [field, value]) => setProductField(f, field, value), form);

test('setProductField: 4 項目を入力中の生の文字列のまま持つ。他の項目は不変・上書き可', () => {
  const f = placedDraft();
  const a = typedProduct(f, [DetailProductField.MAKER, ' メーカーA '], [DetailProductField.NAME, '洋風便器']);
  assert.deepEqual(a.product, { maker: ' メーカーA ', name: '洋風便器' });
  assert.equal(a.label, f.label);
  assert.equal(setProductField(a, DetailProductField.NAME, '和風便器').product.name, '和風便器');
  assert.equal(isDraftDirty(a, f), true);
});

test('【失敗系】setProductField: 配置図でない form・未知の field・文字列でない値・同じ値は同一参照を返す（履歴に積まない）', () => {
  const plain = newDraft({ idFactory });
  assert.equal(setProductField(plain, DetailProductField.NAME, 'x'), plain);
  const elev = setClassification(placedDraft(), 'view', DetailView.ELEVATION);
  assert.equal(setProductField(elev, DetailProductField.NAME, 'x'), elev);
  const f = placedDraft();
  assert.equal(setProductField(f, 'size', 'x'), f);
  assert.equal(setProductField(f, DetailProductField.NAME, null), f);
  assert.equal(setProductField(f, DetailProductField.NAME, 5), f);
  const a = typedProduct(f, [DetailProductField.NAME, 'x']);
  assert.equal(setProductField(a, DetailProductField.NAME, 'x'), a);
});

test('product の往復: フォーム state → entryFromForm → formFromEntry → entryFromForm が同値（全部・一部・無し）', () => {
  const f = placedDraft();
  const all = typedProduct(f, [DetailProductField.COLOR_NAME, 'ホワイト'], [DetailProductField.MODEL_NUMBER, 'AB-123'],
    [DetailProductField.MAKER, 'メーカーA'], [DetailProductField.NAME, '洋風便器']);
  const eAll = entryFromForm(all);
  assert.deepEqual(Object.keys(eAll.product), ['name', 'maker', 'modelNumber', 'colorName'], '順序は DetailProductField の順');
  assert.deepEqual(formFromEntry(eAll).product, eAll.product);
  assert.equal(JSON.stringify(entryFromForm(formFromEntry(eAll))), JSON.stringify(eAll));
  assert.equal(validation(all).ok, true);
  const part = typedProduct(f, [DetailProductField.MODEL_NUMBER, 'AB-123']);
  const ePart = entryFromForm(part);
  assert.deepEqual(ePart.product, { modelNumber: 'AB-123' });
  assert.equal(JSON.stringify(entryFromForm(formFromEntry(ePart))), JSON.stringify(ePart));
  const e0 = entryFromForm(f);
  assert.equal(Object.hasOwn(e0, 'product'), false);
  assert.equal(Object.hasOwn(formFromEntry(e0), 'product'), false);
  assert.equal(JSON.stringify(entryFromForm(formFromEntry(e0))), JSON.stringify(e0));
});

test('product の保存形: 前後の空白を除き、空の項目を落とし、全部空なら項目ごと持たない（空白だけも空）', () => {
  const f = placedDraft();
  const e = entryFromForm(typedProduct(f, [DetailProductField.NAME, '  洋風便器\t'], [DetailProductField.MAKER, '   '], [DetailProductField.COLOR_NAME, '']));
  assert.deepEqual(e.product, { name: '洋風便器' });
  const blank = entryFromForm(typedProduct(f, [DetailProductField.NAME, ' '], [DetailProductField.MAKER, '']));
  assert.equal(Object.hasOwn(blank, 'product'), false);
  assert.equal(Object.hasOwn(entryFromForm({ ...f, product: {} }), 'product'), false);
  assert.equal(validation(typedProduct(f, [DetailProductField.NAME, ' '])).ok, true);
});

test('product: 編集途中のフォーム state（空文字を持つ）でも検証は保存形に対して行うので通り、保存できる。保存形に空は無い', () => {
  const f = placedDraft();
  for (const pairs of [[[DetailProductField.NAME, '']], [[DetailProductField.NAME, 'A'], [DetailProductField.MAKER, '']], [[DetailProductField.NAME, 'A'], [DetailProductField.NAME, '']]]) {
    const form = typedProduct(f, ...pairs);
    assert.equal(Object.hasOwn(form, 'product'), true, 'フォームには空文字が残る（編集中の正常な状態）');
    assert.equal(validation(form).ok, true, JSON.stringify(form.product));
    assert.equal(saveBlockers(form, validation(form)).length, 0);
    assert.equal(Object.values(entryFromForm(form).product ?? {}).some(v => v === ''), false);
  }
  assert.equal(Object.hasOwn(entryFromForm(typedProduct(f, [DetailProductField.NAME, ''])), 'product'), false);
});

test('【失敗系】product: 壊れた値（null・配列・文字列でない値・未知キー）は保存形でも残り、検証が BAD_PRODUCT で知らせる', () => {
  const f = placedDraft();
  const bad = DetailValidationError.BAD_PRODUCT;
  for (const product of [null, ['x'], 'x', { name: 5 }, { size: 'x' }]) {
    assert.equal(validation({ ...f, product }).errors.some(e => e.code === bad), true, JSON.stringify(product));
  }
  assert.equal(entryFromForm({ ...f, product: null }).product, null);
  assert.equal(formFromEntry({ ...entryFromForm(f), product: null }).product, null, 'null は無しにせず壊れた値として残す');
});

test('setClassification: 持てない分類へ変えると product を落とす（BAD_PRODUCT を避ける）。配置図どうしでは保つ', () => {
  const f = typedProduct(placedDraft(), [DetailProductField.NAME, '洋風便器']);
  assert.deepEqual(setClassification(f, 'subject', DetailSubject.HVAC).product, { name: '洋風便器' });
  const toElev = setClassification(f, 'view', DetailView.ELEVATION);
  assert.equal(Object.hasOwn(toElev, 'product'), false);
  assert.equal(validation(toElev).errors.some(e => e.code === DetailValidationError.BAD_PRODUCT), false);
  const toOpening = setClassification(toElev, 'subject', DetailSubject.OPENING);
  assert.equal(Object.hasOwn(toOpening, 'product'), false);
  // 落とさなければ BAD_PRODUCT になる（検出力）
  assert.equal(validation({ ...toElev, product: { name: '洋風便器' } }).errors.some(e => e.code === DetailValidationError.BAD_PRODUCT), true);
});

test('fitDimFieldsFor: 姿図の配置（平面・立面側とも）は寸法欄を出さない。他の分類は従来どおり', () => {
  assert.deepEqual(fitDimFieldsFor(placedDraft()), []);
  assert.deepEqual(fitDimFieldsFor(setClassification(placedDraft(), 'view', DetailView.ELEVATION)), []);
  assert.ok(fitDimFieldsFor(newDraft({ idFactory })).length > 0);
});

test('displayLen: 空は「—」・それ以外は文字列', () => {
  assert.equal(displayLen(''), '—');
  assert.equal(displayLen(null), '—');
  assert.equal(displayLen('12'), '12');
});
