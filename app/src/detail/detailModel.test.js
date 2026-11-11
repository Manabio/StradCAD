import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis, DetailDash,
  DETAIL_VIEW_COMBOS, DETAIL_SLOT_TARGETS, LINE_WEIGHT_MM, DETAIL_DEFAULT_WEIGHT_ROLE,
  DetailPlacementView, PLACED_FIGURE_SUBJECTS, CEILING_PLACED_FIGURE_SUBJECTS,
  DetailSlot, FittingPartRole, FITTING_PART_TARGETS, FITTING_PART_KEY_SEPARATOR,
} from '../core/constants.js';
import {
  validateDetailFigure, normalizeDetailFigure, isSupportedDetailFigure, moveParts, DetailValidationError as E,
  parseFittingPartKey, fittingPartFigure,
} from './detailModel.js';
import detailBuiltinFigures from './detailBuiltins.js';
import { fitDetailFigure, DetailFitError } from './detailFit.js';
import {
  stretchFigure, rectFigure, figureOf, strokeOf, move, fixedLen, stretchLen, paramLen, materialLen, anchorOf, datumOf, DS0, DT0, vmove,
} from './detailTestFixtures.js';

const codes = fig => validateDetailFigure(fig).errors.map(e => e.code);
function mutated(base, fn) { const f = structuredClone(base); fn(f); return f; }
function assertHasCode(fig, code) {
  const r = validateDetailFigure(fig);
  assert.equal(r.ok, false, `不正のはずが ok: ${code}`);
  assert.ok(r.errors.some(e => e.code === code), `${code} が無い: ${JSON.stringify(r.errors)}`);
}

test('成功系: 矩形（閉）・コの字（開）・V・param・material を含む図は ok', () => {
  assert.deepEqual(validateDetailFigure(rectFigure()), { ok: true, errors: [] });
  assert.deepEqual(validateDetailFigure(stretchFigure()), { ok: true, errors: [] });
  const mixed = figureOf([strokeOf('m', [
    move(PenDir.RIGHT, paramLen('frameFaceWidth', 20)), move(PenDir.DOWN, materialLen('M1', 'thickness', 12)), vmove(fixedLen(5), fixedLen(6)),
  ])]);
  assert.deepEqual(validateDetailFigure(mixed), { ok: true, errors: [] });
});

test('失敗系: 長さ 0・負・NaN・Infinity は BAD_LENGTH', () => {
  for (const bad of [0, -5, NaN, Infinity, -Infinity, '10', undefined]) {
    assertHasCode(mutated(stretchFigure(), f => { f.strokes[0].moves[0].len.mm = bad; }), E.BAD_LENGTH);
  }
  assertHasCode(mutated(figureOf([strokeOf('v', [vmove(fixedLen(5), fixedLen(6))])]), f => { f.strokes[0].moves[0].dy.mm = 0; }), E.BAD_LENGTH);
});

test('失敗系: 未知の dir・mode・role・category・view・subject・kind・axis・weightRole・dashRole', () => {
  assertHasCode(mutated(stretchFigure(), f => { f.strokes[0].moves[0].dir = 'X'; }), E.UNKNOWN_DIR);
  assertHasCode(mutated(stretchFigure(), f => { f.strokes[0].moves[0].len.mode = 'zzz'; }), E.UNKNOWN_MODE);
  assertHasCode(mutated(stretchFigure(), f => { f.datums[0].role = 'zzz'; }), E.UNKNOWN_ROLE);
  assertHasCode(mutated(stretchFigure(), f => { f.category = 'zzz'; }), E.UNKNOWN_CATEGORY);
  assertHasCode(mutated(stretchFigure(), f => { f.view = 'zzz'; }), E.UNKNOWN_VIEW);
  assertHasCode(mutated(stretchFigure(), f => { f.subject = 'zzz'; }), E.UNKNOWN_SUBJECT);
  assertHasCode(mutated(stretchFigure(), f => { f.datums[0].kind = 'zzz'; }), E.UNKNOWN_KIND);
  assertHasCode(mutated(stretchFigure(), f => { f.datums[0].axis = 'zzz'; }), E.UNKNOWN_AXIS);
  assertHasCode(mutated(stretchFigure(), f => { f.strokes[0].line.weightRole = 'zzz'; }), E.UNKNOWN_WEIGHT);
  assertHasCode(mutated(stretchFigure(), f => { f.strokes[0].line.dashRole = 'zzz'; }), E.UNKNOWN_DASH);
  assertHasCode(mutated(figureOf([strokeOf('p', [move(PenDir.RIGHT, paramLen('frameFaceWidth', 5))])]), f => { f.strokes[0].moves[0].len.param = 'zzz'; }), E.UNKNOWN_PARAM);
  assertHasCode(mutated(figureOf([strokeOf('p', [move(PenDir.RIGHT, materialLen('M1', 'x', 5))])]), f => { f.strokes[0].moves[0].len.field = 'zzz'; }), E.UNKNOWN_MATERIAL_FIELD);
  assertHasCode(mutated(figureOf([strokeOf('p', [move(PenDir.RIGHT, materialLen('M1', 'x', 5))])]), f => { f.strokes[0].moves[0].len.code = ''; }), E.BAD_MATERIAL_CODE);
});

test('失敗系: 組合せ表に無い (category, view, subject)', () => {
  assertHasCode(mutated(stretchFigure(), f => { f.category = DetailCategory.PART; f.view = DetailView.PLAN; f.subject = DetailSubject.JAMB; }), E.BAD_COMBO);
});

test('失敗系: Anchor の datumId・strokeId・vertexIndex が無い', () => {
  assertHasCode(mutated(stretchFigure(), f => { f.anchors[0].datumId = 'nope'; }), E.ANCHOR_DATUM_MISSING);
  assertHasCode(mutated(stretchFigure(), f => { f.anchors[0].strokeId = 'nope'; }), E.ANCHOR_STROKE_MISSING);
  assertHasCode(mutated(stretchFigure(), f => { f.anchors[0].vertexIndex = 99; }), E.ANCHOR_VERTEX_MISSING);
  assertHasCode(mutated(stretchFigure(), f => { f.anchors[0].vertexIndex = -1; }), E.ANCHOR_VERTEX_MISSING);
  assertHasCode(mutated(stretchFigure(), f => { f.anchors[0].vertexIndex = 1.5; }), E.ANCHOR_VERTEX_MISSING);
});

test('失敗系: origin の Anchor を持たないストローク', () => {
  const two = figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(5))]), strokeOf('b', [move(PenDir.RIGHT, fixedLen(5))])]);
  two.anchors = two.anchors.filter(a => a.strokeId === 'a');
  assertHasCode(two, E.NO_ORIGIN_ANCHOR);
  // 片方の軸だけ欠けても不正
  const half = figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(5))])]);
  half.anchors = [anchorOf('ds0', 'a', 0)];
  assertHasCode(half, E.NO_ORIGIN_ANCHOR);
});

test('失敗系: origin の Datum が軸ごとに 1 つでない（0 個・2 個）', () => {
  assertHasCode(mutated(rectFigure(), f => { f.datums = [DT0]; f.anchors = f.anchors.filter(a => a.datumId !== 'ds0'); }), E.ORIGIN_DATUM_COUNT);
  const dup = datumOf('ds1', DetailDatumRole.WALL_AXIS, DetailAxis.S, DetailDatumKind.ORIGIN);
  assertHasCode(mutated(rectFigure(), f => { f.datums.push(dup); }), E.ORIGIN_DATUM_COUNT);
});

test('失敗系: end の Datum のある軸で stretch が 0 本・2 本', () => {
  assertHasCode(mutated(stretchFigure(), f => { f.strokes[0].moves[2].len = fixedLen(50); }), E.STRETCH_COUNT);
  assertHasCode(mutated(stretchFigure(), f => { f.strokes[0].moves[1].len = stretchLen(10); }), E.STRETCH_COUNT);
});

test('失敗系: stretch があるのに end の Anchor が無い／end の Datum を誰も使わない／stretch が区間の外', () => {
  assertHasCode(mutated(stretchFigure(), f => { f.datums = [DS0, DT0]; f.anchors = f.anchors.filter(a => a.datumId !== 'dt1'); }), E.STRETCH_WITHOUT_END);
  assertHasCode(mutated(stretchFigure(), f => { f.strokes[0].moves[2].len = fixedLen(50); f.anchors = f.anchors.filter(a => a.datumId !== 'dt1'); }), E.END_DATUM_UNUSED);
  // end を頂点 2 に載せると stretch（手 2）は頂点 0〜2 の外
  assertHasCode(mutated(stretchFigure(), f => { f.anchors[2].vertexIndex = 2; }), E.STRETCH_OUT_OF_SPAN);
});

test('失敗系: version≠1・key 空・ストローク 0 本・手 0 個・id 重複', () => {
  assertHasCode(mutated(stretchFigure(), f => { f.version = 2; }), E.VERSION);
  assertHasCode(mutated(stretchFigure(), f => { f.key = ''; }), E.EMPTY_KEY);
  assertHasCode(mutated(stretchFigure(), f => { f.strokes = []; }), E.NO_STROKES);
  assertHasCode(mutated(stretchFigure(), f => { f.strokes[0].moves = []; }), E.EMPTY_MOVES);
  assertHasCode(mutated(stretchFigure(), f => { f.datums[1].id = 'ds0'; }), E.DUPLICATE_ID);
});

test('失敗系: 同じストローク・同じ軸に origin／end の Anchor が 2 つは DUPLICATE_ANCHOR', () => {
  assertHasCode(mutated(rectFigure(), f => { f.anchors.push(anchorOf('ds0', 'r', 1)); }), E.DUPLICATE_ANCHOR);
  assertHasCode(mutated(stretchFigure(), f => { f.anchors.push(anchorOf('dt1', 'a', 3)); }), E.DUPLICATE_ANCHOR);
});

test('失敗系: 軸 t の end の Datum が 2 つは END_DATUM_COUNT', () => {
  const dt2 = datumOf('dt2', DetailDatumRole.OPENING_INNER, DetailAxis.T, DetailDatumKind.END);
  assertHasCode(mutated(stretchFigure(), f => { f.datums.push(dt2); }), E.END_DATUM_COUNT);
});

test('失敗系: line がオブジェクトでない値（"bold"）は既定に置き換わらず SHAPE', () => {
  assertHasCode(mutated(rectFigure(), f => { f.strokes[0].line = 'bold'; }), E.SHAPE);
  // null・省略は既定で埋まる
  assert.ok(!codes(mutated(rectFigure(), f => { delete f.strokes[0].line; })).includes(E.SHAPE));
});

test('失敗系: closed で mm の終点が始点に一致（4 手で戻る矩形）は CLOSED_RETURNS_TO_START', () => {
  const back = figureOf([strokeOf('r', [
    move(PenDir.RIGHT, fixedLen(100)), move(PenDir.DOWN, fixedLen(50)), move(PenDir.LEFT, fixedLen(100)), move(PenDir.UP, fixedLen(50)),
  ], true)]);
  assertHasCode(back, E.CLOSED_RETURNS_TO_START);
  // 開いたストロークが戻るのは許す。3 手の closed は通る
  assert.ok(!codes(mutated(back, f => { f.strokes[0].closed = false; })).includes(E.CLOSED_RETURNS_TO_START));
  assert.ok(!codes(rectFigure()).includes(E.CLOSED_RETURNS_TO_START));
});

test('失敗系: closed で符号付き V により始点へ戻るのは CLOSED_RETURNS_TO_START', () => {
  const build = (ss, st) => figureOf([strokeOf('r', [
    move(PenDir.RIGHT, fixedLen(100)), move(PenDir.DOWN, fixedLen(50)),
    { dir: PenDir.VECTOR, dx: fixedLen(100), dy: fixedLen(50), ss, st },
  ], true)]);
  assertHasCode(build(-1, -1), E.CLOSED_RETURNS_TO_START);
  assert.ok(!codes(build(1, 1)).includes(E.CLOSED_RETURNS_TO_START)); // 終点 (200,100)
});

test('失敗系: 2 手の closed の同軸往復（R100, L100）は CLOSED_RETURNS_TO_START で CLOSED_TOO_FEW は出ない', () => {
  const c = codes(figureOf([strokeOf('c', [move(PenDir.RIGHT, fixedLen(100)), move(PenDir.LEFT, fixedLen(100))], true)]));
  assert.ok(c.includes(E.CLOSED_RETURNS_TO_START), JSON.stringify(c));
  assert.ok(!c.includes(E.CLOSED_TOO_FEW), JSON.stringify(c));
});

test("normalizeDetailFigure: 'V' 以外の Move に ss/st を足さない・指定済みの ss/st は保つ", () => {
  const r = move(PenDir.RIGHT, fixedLen(10));
  const n = normalizeDetailFigure({ strokes: [{ id: 'a', moves: [r, { dir: PenDir.VECTOR, dx: fixedLen(1), dy: fixedLen(2), ss: -1 }] }] });
  assert.deepEqual(n.strokes[0].moves[0], r);
  assert.equal(Object.hasOwn(n.strokes[0].moves[0], 'ss'), false);
  assert.equal(n.strokes[0].moves[1].ss, -1);
  assert.equal(n.strokes[0].moves[1].st, 1);
});

test('moveParts: U/D/L/R は ss/st を無視する', () => {
  assert.equal(moveParts({ dir: PenDir.RIGHT, len: fixedLen(10), ss: -1, st: -1 })[0].sign, 1);
  assert.equal(moveParts({ dir: PenDir.LEFT, len: fixedLen(10), ss: 1, st: 1 })[0].sign, -1);
  assert.equal(moveParts({ dir: PenDir.DOWN, len: fixedLen(10), ss: -1, st: -1 })[0].sign, 1);
  assert.equal(moveParts({ dir: PenDir.UP, len: fixedLen(10), ss: 1, st: 1 })[0].sign, -1);
});

test("'V' の向き: ss・st が 1／−1 以外は BAD_VECTOR_SIGN。省略は normalize が +1 を埋める", () => {
  const base = figureOf([strokeOf('v', [vmove(fixedLen(5), fixedLen(6))])]);
  assert.deepEqual(codes(mutated(base, f => { Object.assign(f.strokes[0].moves[0], { ss: -1, st: -1 }); })), []);
  assertHasCode(mutated(base, f => { f.strokes[0].moves[0].ss = 0; }), E.BAD_VECTOR_SIGN);
  assertHasCode(mutated(base, f => { f.strokes[0].moves[0].st = '+'; }), E.BAD_VECTOR_SIGN);
  assertHasCode(mutated(base, f => { f.strokes[0].moves[0].st = NaN; }), E.BAD_VECTOR_SIGN);
  const n = normalizeDetailFigure(base);
  assert.equal(n.strokes[0].moves[0].ss, 1);
  assert.equal(n.strokes[0].moves[0].st, 1);
  assert.equal(isSupportedDetailFigure(mutated(base, f => { f.strokes[0].moves[0].ss = 2; })), false);
  assert.equal(isSupportedDetailFigure(mutated(base, f => { f.strokes[0].moves[0].ss = -1; })), true);
});

test('失敗系: closed なのに頂点が 2 以下', () => {
  assertHasCode(figureOf([strokeOf('c', [move(PenDir.RIGHT, fixedLen(5))], true)]), E.CLOSED_TOO_FEW);
  // 頂点 3（2 手）は通る
  assert.ok(!codes(figureOf([strokeOf('c', [move(PenDir.RIGHT, fixedLen(5)), move(PenDir.DOWN, fixedLen(5))], true)])).includes(E.CLOSED_TOO_FEW));
});

test('失敗系: オブジェクトでない・offsetMm 非有限は例外にせず列挙する', () => {
  assert.deepEqual(codes(null), [E.SHAPE]);
  assert.deepEqual(codes('x'), [E.SHAPE]);
  assertHasCode(mutated(stretchFigure(), f => { f.datums[0].offsetMm = NaN; }), E.BAD_OFFSET);
  assertHasCode(mutated(stretchFigure(), f => { f.strokes[0].moves[0] = null; }), E.SHAPE);
});

test('normalizeDetailFigure: 省略項目の既定値を埋める', () => {
  const n = normalizeDetailFigure({ key: 'k', version: 1, category: 'paired', view: 'plan', subject: 'jamb', strokes: [{ id: 'a', moves: [] }], datums: [{ id: 'd' }] });
  assert.deepEqual(n.strokes[0], { id: 'a', moves: [], closed: false, line: { weightRole: 'thin', dashRole: DetailDash.SOLID } });
  assert.equal(n.datums[0].offsetMm, 0);
  assert.deepEqual(n.anchors, []);
  assert.equal(n.note, null);
  assert.equal(n.provenance, null);
  assert.equal(n.label, '');
  const e = normalizeDetailFigure(undefined);
  assert.deepEqual([e.strokes, e.datums, e.anchors], [[], [], []]);
  // 指定済みの値は保つ
  const kept = normalizeDetailFigure({ strokes: [{ id: 'a', moves: [], closed: true, line: { weightRole: 'thick', dashRole: DetailDash.DASHED } }], note: 'n' });
  assert.deepEqual(kept.strokes[0].line, { weightRole: 'thick', dashRole: DetailDash.DASHED });
  assert.equal(kept.strokes[0].closed, true);
  assert.equal(kept.note, 'n');
});

test('normalizeDetailFigure: 省略可能な項目を欠いた図も検証を通る', () => {
  const f = stretchFigure();
  delete f.label; delete f.provenance; delete f.note;
  for (const s of f.strokes) { delete s.closed; delete s.line; }
  f.datums.forEach(d => delete d.offsetMm);
  assert.equal(validateDetailFigure(f).ok, true);
});

test('dashRole swing は有効（UNKNOWN_DASH なし・isSupportedDetailFigure true）。未知の swingX は UNKNOWN_DASH で false', () => {
  const swing = mutated(stretchFigure(), f => { f.strokes[0].line.dashRole = DetailDash.SWING; });
  assert.equal(DetailDash.SWING, 'swing');
  assert.deepEqual(validateDetailFigure(swing), { ok: true, errors: [] });
  assert.equal(isSupportedDetailFigure(swing), true);
  const bad = mutated(stretchFigure(), f => { f.strokes[0].line.dashRole = 'swingX'; });
  assertHasCode(bad, E.UNKNOWN_DASH);
  assert.equal(isSupportedDetailFigure(bad), false);
});

test('isSupportedDetailFigure: 有効な図は true、非有限・負の mm・未知の role・版違い・型違いは false', () => {
  assert.equal(isSupportedDetailFigure(stretchFigure()), true);
  assert.equal(isSupportedDetailFigure(rectFigure()), true);
  assert.equal(isSupportedDetailFigure(mutated(stretchFigure(), f => { f.strokes[0].moves[0].len.mm = NaN; })), false);
  assert.equal(isSupportedDetailFigure(mutated(stretchFigure(), f => { f.strokes[0].moves[0].len.mm = Infinity; })), false);
  assert.equal(isSupportedDetailFigure(mutated(stretchFigure(), f => { f.strokes[0].moves[0].len.mm = -1; })), false);
  assert.equal(isSupportedDetailFigure(mutated(stretchFigure(), f => { f.datums[0].role = 'future'; })), false);
  assert.equal(isSupportedDetailFigure(mutated(stretchFigure(), f => { f.version = 2; })), false);
  assert.equal(isSupportedDetailFigure(mutated(stretchFigure(), f => { f.strokes[0].moves[0].dir = 'Q'; })), false);
  assert.equal(isSupportedDetailFigure(mutated(stretchFigure(), f => { f.strokes[0].line.dashRole = 'wavy'; })), false);
  assert.equal(isSupportedDetailFigure(null), false);
  assert.equal(isSupportedDetailFigure('x'), false);
  // Anchor の規則違反は「読めるが登録できない」図＝supported
  assert.equal(isSupportedDetailFigure(mutated(stretchFigure(), f => { f.anchors = []; })), true);
});

test('列挙: DETAIL_SLOT_TARGETS の全エントリが DETAIL_VIEW_COMBOS に含まれる', () => {
  for (const [slot, t] of Object.entries(DETAIL_SLOT_TARGETS)) {
    assert.ok(DETAIL_VIEW_COMBOS.some(c => c.category === t.category && c.view === t.view && c.subject === t.subject), `${slot} が組合せ表に無い`);
  }
  assert.equal(Object.keys(DETAIL_SLOT_TARGETS).length, 15); // jamb/head/sill/sashSection/nageshi/shikii + figure（S6b）+ figureBack（T2）+ floorWall/wallCeiling（S8a）+ kneeTop/dropBottom（S8b-1）+ floorStep（S8b-3）+ ceilingStep（S8b-4a）+ fitting（C1）
});

test('列挙: DETAIL_VIEW_COMBOS は 28 組・重複なし・全要素が既知の語彙', () => {
  assert.equal(DETAIL_VIEW_COMBOS.length, 28);
  assert.equal(new Set(DETAIL_VIEW_COMBOS.map(c => `${c.category}/${c.view}/${c.subject}`)).size, 28);
  for (const c of DETAIL_VIEW_COMBOS) {
    assert.ok(Object.values(DetailCategory).includes(c.category) && Object.values(DetailView).includes(c.view) && Object.values(DetailSubject).includes(c.subject));
  }
  // 問題0 §4 の代表
  assert.ok(DETAIL_VIEW_COMBOS.some(c => c.category === 'junction' && c.view === 'section' && c.subject === 'floorWall'));
  assert.ok(!DETAIL_VIEW_COMBOS.some(c => c.category === 'junction' && c.view === 'plan'));
});

test('列挙: 件数と既定の線の太さ', () => {
  assert.equal(Object.keys(DetailSubject).length, 17);
  assert.equal(Object.keys(DetailDatumRole).length, 16);
  assert.ok(Object.hasOwn(LINE_WEIGHT_MM, DETAIL_DEFAULT_WEIGHT_ROLE));
  assert.equal(Object.keys(DetailLenMode).length, 4);
  assert.deepEqual(Object.values(DetailPlacementView), ['front', 'back', 'left', 'right', 'ceiling']);
  assert.deepEqual([...PLACED_FIGURE_SUBJECTS], [DetailSubject.SANITARY, DetailSubject.FURNITURE, DetailSubject.HVAC]);
  assert.deepEqual([...CEILING_PLACED_FIGURE_SUBJECTS], [DetailSubject.HVAC]);
  for (const s of PLACED_FIGURE_SUBJECTS) {
    assert.ok(DETAIL_VIEW_COMBOS.some(c => c.category === DetailCategory.FIGURE && c.view === DetailView.PLAN && c.subject === s), `平面の姿図の組合せ表に ${s} が無い`);
  }
});

// ---- views（平面の姿図の束。P2-1）----
const placedFigure = over => figureOf(
  [strokeOf('a', [move(PenDir.RIGHT, fixedLen(20)), move(PenDir.DOWN, fixedLen(30))])],
  { key: 'df-plan', category: DetailCategory.FIGURE, view: DetailView.PLAN, subject: DetailSubject.SANITARY, ...over },
);

test('views: 5 キー全部・一部・空 {} は有効。views 無しも従来どおり', () => {
  assert.deepEqual(validateDetailFigure(placedFigure()), { ok: true, errors: [] });
  assert.deepEqual(validateDetailFigure(placedFigure({ views: undefined })), { ok: true, errors: [] });
  assert.deepEqual(validateDetailFigure(placedFigure({ views: {} })), { ok: true, errors: [] });
  assert.deepEqual(validateDetailFigure(placedFigure({ views: { front: 'df-f' } })), { ok: true, errors: [] });
  const all = { front: 'df-f', back: 'df-b', left: 'df-l', right: 'df-r', ceiling: 'df-c' };
  assert.deepEqual(validateDetailFigure(placedFigure({ views: all })), { ok: true, errors: [] });
  for (const subject of [DetailSubject.FURNITURE, DetailSubject.HVAC]) {
    assert.equal(validateDetailFigure(placedFigure({ subject, views: all })).ok, true);
  }
});

test('views 失敗系: 未知キー・空文字/非文字列の値・配列・自己参照は BAD_VIEWS', () => {
  for (const bad of [{ up: 'df-x' }, { front: '' }, { front: 5 }, { front: null }, { front: ['df-x'] }, ['df-x'], 'df-x', { back: 'df-plan' }]) {
    assertHasCode(placedFigure({ views: bad }), E.BAD_VIEWS);
  }
});

test('views: null は省略と同値（BAD_VIEWS なし・isSupported true）。持てない分類でも null は有効。{} は持てない分類では BAD_VIEWS のまま', () => {
  assert.deepEqual(validateDetailFigure(placedFigure({ views: null })), { ok: true, errors: [] });
  assert.equal(isSupportedDetailFigure(placedFigure({ views: null })), true);
  assert.deepEqual(validateDetailFigure(placedFigure({ views: null, view: DetailView.ELEVATION })), { ok: true, errors: [] });
  assertHasCode(placedFigure({ views: {}, view: DetailView.ELEVATION }), E.BAD_VIEWS);
});

test('views: BAD_VIEWS の図（自己参照の views を持つ平面の姿図）は fitDetailFigure が INVALID（壊れた束は描かれない）', () => {
  const fit = fitDetailFigure(placedFigure({ views: { front: 'df-plan' } }), { datums: {} });
  assert.equal(fit.error.code, DetailFitError.INVALID);
});

test('views 失敗系: 持てない分類（立面の姿図・部品・建具の姿図・枠）に views があれば BAD_VIEWS', () => {
  const v = { views: { front: 'df-f' } };
  assertHasCode(placedFigure({ ...v, view: DetailView.ELEVATION }), E.BAD_VIEWS);
  assertHasCode(placedFigure({ ...v, subject: DetailSubject.OPENING }), E.BAD_VIEWS);
  assertHasCode({ ...rectFigure(), ...v }, E.BAD_VIEWS);
  assertHasCode({ ...rectFigure(), category: DetailCategory.PART, view: DetailView.SECTION, subject: DetailSubject.WALL, ...v }, E.BAD_VIEWS);
  assert.deepEqual(codes(placedFigure({ ...v, view: DetailView.ELEVATION })), [E.BAD_VIEWS], 'ほかの誤りは出ない');
});

test('views が壊れていても図自体は読める（R4）。normalize は views のキーを足さず、JSON 往復で残る', () => {
  assert.equal(isSupportedDetailFigure(placedFigure({ views: { up: '', front: 5 } })), true);
  assert.equal(isSupportedDetailFigure({ ...rectFigure(), views: { front: 'df-f' } }), true);
  assert.equal(Object.hasOwn(normalizeDetailFigure(placedFigure()), 'views'), false);
  assert.equal(Object.hasOwn(normalizeDetailFigure(placedFigure({ views: undefined })), 'views'), true, '明示 undefined は素通し（足すのではなく元のまま）');
  const f = placedFigure({ views: { front: 'df-f', ceiling: 'df-c' } });
  assert.deepEqual(normalizeDetailFigure(f).views, f.views);
  const back = JSON.parse(JSON.stringify(f));
  assert.deepEqual(back.views, { front: 'df-f', ceiling: 'df-c' });
  assert.deepEqual(validateDetailFigure(back), { ok: true, errors: [] });
});

// ---- 建具一式（FITTING。C1）----
// 部品の figure は key・version・label・provenance・note を持たない本体（分類・strokes・datums・anchors）だけ。
function partBody(over = {}) {
  const f = figureOf(rectFigure().strokes, over);
  return { category: f.category, view: f.view, subject: f.subject, strokes: f.strokes, datums: f.datums, anchors: f.anchors };
}
const JAMB_PART = () => ({ id: 'p1', role: FittingPartRole.JAMB, figure: partBody() });
const FIGURE_PART = () => ({
  id: 'p2', role: FittingPartRole.FIGURE,
  figure: partBody({ category: DetailCategory.FIGURE, view: DetailView.ELEVATION, subject: DetailSubject.OPENING }),
});
function fittingSet(over = {}) {
  return {
    key: 'df-fit', version: 1, label: '一式', category: DetailCategory.FITTING, view: DetailView.PLAN, subject: DetailSubject.OPENING,
    strokes: [], datums: [], anchors: [], provenance: null, note: null,
    parts: [JAMB_PART(), FIGURE_PART()],
    ...over,
  };
}

test('建具一式: 部品 2 個（jamb・figure）の一式は ok・読める', () => {
  assert.deepEqual(validateDetailFigure(fittingSet()), { ok: true, errors: [] });
  assert.equal(isSupportedDetailFigure(fittingSet()), true);
  // 組合せ表・スロット表・部品の分類表が整合している
  assert.ok(DETAIL_VIEW_COMBOS.some(c => c.category === DetailCategory.FITTING && c.view === DetailView.PLAN && c.subject === DetailSubject.OPENING));
  assert.deepEqual(DETAIL_SLOT_TARGETS[DetailSlot.FITTING], { category: DetailCategory.FITTING, view: DetailView.PLAN, subject: DetailSubject.OPENING });
  assert.equal(Object.values(FittingPartRole).length, 13);
  assert.deepEqual(Object.keys(FITTING_PART_TARGETS).sort(), Object.values(FittingPartRole).sort());
  for (const t of Object.values(FITTING_PART_TARGETS)) {
    assert.ok(DETAIL_VIEW_COMBOS.some(c => c.category === t.category && c.view === t.view && c.subject === t.subject), JSON.stringify(t));
  }
});

test('建具一式: 最上位の strokes・datums・anchors が空でなければ SHAPE・views があれば BAD_VIEWS', () => {
  assertHasCode(fittingSet({ strokes: rectFigure().strokes }), E.SHAPE);
  assertHasCode(fittingSet({ datums: [DS0] }), E.SHAPE);
  assertHasCode(fittingSet({ anchors: [anchorOf('ds0', 'r', 0)] }), E.SHAPE);
  assertHasCode(fittingSet({ views: { front: 'df-x' } }), E.BAD_VIEWS);
  assert.equal(isSupportedDetailFigure(fittingSet({ strokes: rectFigure().strokes })), false, 'SHAPE は読めない図');
  assert.equal(isSupportedDetailFigure(fittingSet({ views: { front: 'df-x' } })), true, 'BAD_VIEWS は読める図');
});

test('建具一式: parts が配列でない→SHAPE・0 個→PARTS_EMPTY（読める）・部品が非オブジェクト→SHAPE', () => {
  assertHasCode(fittingSet({ parts: undefined }), E.SHAPE);
  assertHasCode(fittingSet({ parts: 'x' }), E.SHAPE);
  assertHasCode(fittingSet({ parts: [] }), E.PARTS_EMPTY);
  assert.equal(isSupportedDetailFigure(fittingSet({ parts: [] })), true);
  assertHasCode(fittingSet({ parts: [null] }), E.SHAPE);
  assertHasCode(fittingSet({ parts: [{ id: 'p1', role: FittingPartRole.JAMB }] }), E.SHAPE);
});

test('建具一式: 部品の id 重複・role 重複は PART_DUPLICATE（読める）・id 空は EMPTY_KEY', () => {
  assertHasCode(fittingSet({ parts: [JAMB_PART(), { ...FIGURE_PART(), id: 'p1' }] }), E.PART_DUPLICATE);
  assertHasCode(fittingSet({ parts: [JAMB_PART(), { ...JAMB_PART(), id: 'p9' }] }), E.PART_DUPLICATE);
  assert.equal(isSupportedDetailFigure(fittingSet({ parts: [JAMB_PART(), { ...JAMB_PART(), id: 'p9' }] })), true);
  assertHasCode(fittingSet({ parts: [{ ...JAMB_PART(), id: '' }] }), E.EMPTY_KEY);
});

test('建具一式: 未知の role は PART_UNKNOWN_ROLE（読めない図）', () => {
  const f = fittingSet({ parts: [{ ...JAMB_PART(), role: 'zzz' }] });
  assertHasCode(f, E.PART_UNKNOWN_ROLE);
  assert.equal(isSupportedDetailFigure(f), false);
  // 未知 role の合成キー（df-fit#zzz）は部品側の検査でも BAD_KEY_CHAR になり、二重に出る（期待値として固定。isSupported は同じ）
  assert.deepEqual(
    validateDetailFigure(f).errors.map(e => [e.code, e.path]),
    [[E.PART_UNKNOWN_ROLE, 'parts[0].role'], [E.BAD_KEY_CHAR, 'parts[0].figure.key']],
  );
});

test('建具一式: 部品の分類が role の表と違えば PART_BAD_TARGET（読める）', () => {
  const f = fittingSet({ parts: [{ ...JAMB_PART(), role: FittingPartRole.HEAD }] }); // jamb の図を head 役に
  assertHasCode(f, E.PART_BAD_TARGET);
  assert.equal(isSupportedDetailFigure(f), true);
});

test('建具一式: 部品本体の誤りは path に parts[i].figure. を前置して返る（ORIGIN_DATUM_COUNT・合成キーは BAD_KEY_CHAR にならない）', () => {
  const f = fittingSet();
  f.parts[1].figure.datums = [DS0]; // 軸 t の origin が無い
  const r = validateDetailFigure(f);
  assert.equal(r.ok, false);
  const e = r.errors.find(x => x.code === E.ORIGIN_DATUM_COUNT);
  assert.ok(e, JSON.stringify(r.errors));
  assert.equal(e.path, 'parts[1].figure.datums');
  assert.equal(r.errors.some(x => x.code === E.BAD_KEY_CHAR), false);
  // 部品本体の SUPPORT_BLOCKING（長さ）は一式全体を読めない図にする
  const g = fittingSet();
  g.parts[0].figure.strokes[0].moves[0].len.mm = 0;
  assertHasCode(g, E.BAD_LENGTH);
  assert.equal(isSupportedDetailFigure(g), false);
  assert.equal(validateDetailFigure(g).errors.find(x => x.code === E.BAD_LENGTH).path, 'parts[0].figure.strokes[0].moves[0].len');
});

test('建具一式: key に # を含む図は BAD_KEY_CHAR（読めない図・どの分類でも）', () => {
  assertHasCode(fittingSet({ key: 'df-a#jamb' }), E.BAD_KEY_CHAR, '一式自身のキーは合成キーの形でも不可');
  assert.equal(isSupportedDetailFigure(fittingSet({ key: 'df-a#jamb' })), false);
  assertHasCode(mutated(stretchFigure(), f => { f.key = 'df-x#y'; }), E.BAD_KEY_CHAR);
  assert.equal(isSupportedDetailFigure(mutated(stretchFigure(), f => { f.key = 'df-x#y'; })), false);
  for (const key of ['df-x#', '#jamb', 'df-x#jamb#head']) assertHasCode(mutated(stretchFigure(), f => { f.key = key; }), E.BAD_KEY_CHAR);
  // 例外: 合成キーの形（'<key>#<role>'）の非一式の図は通す＝fittingPartFigure の戻り（fit に渡す）
  assert.deepEqual(validateDetailFigure(mutated(stretchFigure(), f => { f.key = 'df-x#jamb'; })), { ok: true, errors: [] });
});

test('normalize: 建具一式は冪等・部品の figure に label・provenance・note を足さない', () => {
  const once = normalizeDetailFigure(fittingSet());
  assert.deepEqual(normalizeDetailFigure(once), once);
  const raw = fittingSet();
  for (const p of raw.parts) { delete p.figure.datums[0].offsetMm; delete p.figure.datums[1].offsetMm; }
  const n = normalizeDetailFigure(raw);
  assert.equal(n.parts[0].figure.datums[0].offsetMm, 0, '部品の本体にも既定値を埋める');
  for (const p of n.parts) {
    for (const k of ['label', 'provenance', 'note']) assert.equal(Object.hasOwn(p.figure, k), false, k);
  }
  assert.equal(raw.parts[0].figure.datums[0].offsetMm, undefined, '入力を書き換えない');
  // parts が配列でない値は触らず検証に任せる
  assert.equal(normalizeDetailFigure(fittingSet({ parts: 'x' })).parts, 'x');
});

test('normalize: parts の無い図は従来の正規化とバイト単位で一致（キーの足し方・順序とも。組込み全図＋fixture）', () => {
  // 従来の本体（C1 以前の normalizeDetailFigure と同じ式）
  const legacy = plain => {
    const f = plain !== null && typeof plain === 'object' && !Array.isArray(plain) ? plain : {};
    const isO = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const arr = v => (Array.isArray(v) ? v : []);
    return {
      ...f,
      label: f.label ?? '',
      strokes: arr(f.strokes).map(s => {
        if (!isO(s)) return s;
        return {
          ...s,
          moves: arr(s.moves).map(m => (isO(m) && m.dir === PenDir.VECTOR ? { ...m, ss: m.ss ?? 1, st: m.st ?? 1 } : m)),
          closed: s.closed ?? false,
          line: s.line == null
            ? { weightRole: DETAIL_DEFAULT_WEIGHT_ROLE, dashRole: DetailDash.SOLID }
            : isO(s.line) ? { weightRole: s.line.weightRole ?? DETAIL_DEFAULT_WEIGHT_ROLE, dashRole: s.line.dashRole ?? DetailDash.SOLID } : s.line,
        };
      }),
      datums: arr(f.datums).map(d => (isO(d) ? { ...d, offsetMm: d.offsetMm ?? 0 } : d)),
      anchors: arr(f.anchors),
      provenance: f.provenance ?? null,
      note: f.note ?? null,
    };
  };
  const bare = { key: 'k' }; // label 等が全部無い図でもキーの順序が従来と同じ
  // parts を持つ組込み（建具一式。C4）は対象外（この表明は「parts の無い図」の不変。一式の正規化は openings/openingPlanSymbol.slideFitting.test.js）
  const plainBuiltins = detailBuiltinFigures.filter(f => !Object.hasOwn(f, 'parts'));
  const samples = [...plainBuiltins, stretchFigure(), rectFigure(), placedFigure(), bare, {}, null, 'x'];
  assert.ok(plainBuiltins.length > 0);
  for (const fig of samples) {
    assert.equal(JSON.stringify(normalizeDetailFigure(fig)), JSON.stringify(legacy(fig)));
    assert.equal(Object.hasOwn(normalizeDetailFigure(fig), 'parts'), false);
  }
});

test('parseFittingPartKey: 往復・空側・未知 role・# が 2 つ', () => {
  for (const role of Object.values(FittingPartRole)) {
    assert.deepEqual(parseFittingPartKey(`df-fit${FITTING_PART_KEY_SEPARATOR}${role}`), { setKey: 'df-fit', role });
  }
  assert.equal(parseFittingPartKey('df-fit#'), null);
  assert.equal(parseFittingPartKey('#jamb'), null);
  assert.equal(parseFittingPartKey('df-fit'), null);
  assert.equal(parseFittingPartKey('df-fit#zzz'), null);
  assert.equal(parseFittingPartKey('a#jamb#head'), null, '最初の # で分けるので role が jamb#head になり語彙に無い');
  for (const bad of [undefined, null, 5, {}, '']) assert.equal(parseFittingPartKey(bad), null);
});

test('fittingPartFigure: 部品の合成図（キー・label）・部品無し／一式でないは null・合成図は validate を通る', () => {
  const set = fittingSet();
  const jamb = fittingPartFigure(set, FittingPartRole.JAMB);
  assert.equal(jamb.key, 'df-fit#jamb');
  assert.equal(jamb.label, '一式（jamb）');
  assert.equal(jamb.version, 1);
  assert.deepEqual(parseFittingPartKey(jamb.key), { setKey: 'df-fit', role: 'jamb' });
  for (const role of [FittingPartRole.JAMB, FittingPartRole.FIGURE]) {
    const part = fittingPartFigure(set, role);
    assert.deepEqual(validateDetailFigure(part), { ok: true, errors: [] }, role);
    assert.equal(fitDetailFigure(part, { datums: { ds0: 0, dt0: 0 } }).error, undefined, '合成図は fit できる');
  }
  // 部品の figure が自分で key・version・label を持っていても、合成キー・一式の version・合成 label が勝つ
  const own = fittingSet();
  Object.assign(own.parts[0].figure, { key: 'bogus', version: 999, label: 'x' });
  const won = fittingPartFigure(own, FittingPartRole.JAMB);
  assert.deepEqual([won.key, won.version, won.label], ['df-fit#jamb', 1, '一式（jamb）']);
  assert.equal(fittingPartFigure(set, FittingPartRole.HEAD), null, '部品無し');
  assert.equal(fittingPartFigure(set, 'zzz'), null);
  assert.equal(fittingPartFigure(stretchFigure(), FittingPartRole.JAMB), null, '一式でない');
  assert.equal(fittingPartFigure(null, FittingPartRole.JAMB), null);
  assert.equal(fittingPartFigure(fittingSet({ parts: 'x' }), FittingPartRole.JAMB), null);
});
