import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis, DetailDash,
  DETAIL_VIEW_COMBOS, DETAIL_SLOT_TARGETS, LINE_WEIGHT_MM, DETAIL_DEFAULT_WEIGHT_ROLE,
} from '../core/constants.js';
import {
  validateDetailFigure, normalizeDetailFigure, isSupportedDetailFigure, moveParts, DetailValidationError as E,
} from './detailModel.js';
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
  assert.equal(Object.keys(DETAIL_SLOT_TARGETS).length, 6);
});

test('列挙: DETAIL_VIEW_COMBOS は 27 組・重複なし・全要素が既知の語彙', () => {
  assert.equal(DETAIL_VIEW_COMBOS.length, 27);
  assert.equal(new Set(DETAIL_VIEW_COMBOS.map(c => `${c.category}/${c.view}/${c.subject}`)).size, 27);
  for (const c of DETAIL_VIEW_COMBOS) {
    assert.ok(Object.values(DetailCategory).includes(c.category) && Object.values(DetailView).includes(c.view) && Object.values(DetailSubject).includes(c.subject));
  }
  // 問題0 §4 の代表
  assert.ok(DETAIL_VIEW_COMBOS.some(c => c.category === 'junction' && c.view === 'section' && c.subject === 'floorWall'));
  assert.ok(!DETAIL_VIEW_COMBOS.some(c => c.category === 'junction' && c.view === 'plan'));
});

test('列挙: 件数と既定の線の太さ', () => {
  assert.equal(Object.keys(DetailSubject).length, 17);
  assert.equal(Object.keys(DetailDatumRole).length, 13);
  assert.ok(Object.hasOwn(LINE_WEIGHT_MM, DETAIL_DEFAULT_WEIGHT_ROLE));
  assert.equal(Object.keys(DetailLenMode).length, 4);
});
