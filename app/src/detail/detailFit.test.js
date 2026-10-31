import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PenDir, DetailAxis, DetailDatumKind, DetailDatumRole, DetailDash } from '../core/constants.js';
import { fitDetailFigure, DetailFitError as F } from './detailFit.js';
import { penWalk, DetailPenError } from './detailPen.js';
import {
  stretchFigure, rectFigure, figureOf, strokeOf, move, vmove, fixedLen, stretchLen, paramLen, materialLen, anchorOf, datumOf,
  DS0, DT0,
} from './detailTestFixtures.js';

const pts = (fitted, i = 0) => fitted.strokes[i].points.map(p => [p.s, p.t]);
const tupleOf = fitted => pts(fitted);
const ZERO = { datums: { ds0: 0, dt0: 0 } };

test('penWalk: U/D/L/R/V の向きと、closed でも終点を重ねない（頂点数 = 手 + 1）', () => {
  const stroke = strokeOf('x', [
    move(PenDir.RIGHT, fixedLen(10)), move(PenDir.DOWN, fixedLen(20)), move(PenDir.LEFT, fixedLen(3)),
    move(PenDir.UP, fixedLen(5)), vmove(fixedLen(7), fixedLen(8)),
  ], true);
  const w = penWalk(stroke, len => len.mm);
  assert.deepEqual(w.map(p => [p.s, p.t]), [[0, 0], [10, 0], [10, 20], [7, 20], [7, 15], [14, 23]]);
});

test('penWalk: 未解決（null）・負・非有限・未知 dir は error', () => {
  const s = strokeOf('x', [move(PenDir.RIGHT, fixedLen(10))]);
  assert.equal(penWalk(s, () => null).error.code, DetailPenError.UNRESOLVED_LENGTH);
  assert.equal(penWalk(s, () => -1).error.code, DetailPenError.BAD_LENGTH);
  assert.equal(penWalk(s, () => NaN).error.code, DetailPenError.BAD_LENGTH);
  assert.equal(penWalk(strokeOf('x', [{ dir: 'Z', len: fixedLen(1) }]), len => len.mm).error.code, DetailPenError.UNKNOWN_DIR);
  assert.deepEqual(penWalk(s, () => 0).map(p => p.s), [0, 0]); // 0 は許す（伸縮の仮置き）
});

test('fit: 矩形（閉）は寸法どおり・origin の頂点が目標に載る', () => {
  const r = fitDetailFigure(rectFigure(100, 50), ZERO);
  assert.equal(r.error, undefined);
  assert.deepEqual(tupleOf(r), [[0, 0], [100, 0], [100, 50], [0, 50]]);
  assert.equal(r.strokes[0].closed, true);
  assert.deepEqual(r.warnings, []);
  // 目標を動かすと平行移動
  assert.deepEqual(tupleOf(fitDetailFigure(rectFigure(100, 50), { datums: { ds0: 300, dt0: -40 } })).slice(0, 2), [[300, -40], [400, -40]]);
});

test('fit: コの字（開）。見込 70 では stretch が 50、105 では 85 に伸び、固定寸法（20・10・10・20）は不変', () => {
  const at70 = fitDetailFigure(stretchFigure(), { datums: { ds0: 0, dt0: 0, dt1: 70 } });
  assert.deepEqual(tupleOf(at70), [[0, 0], [20, 0], [20, 10], [20, 60], [20, 70], [0, 70]]);
  const at105 = fitDetailFigure(stretchFigure(), { datums: { ds0: 0, dt0: 0, dt1: 105 } });
  assert.deepEqual(tupleOf(at105), [[0, 0], [20, 0], [20, 10], [20, 95], [20, 105], [0, 105]]);
  assert.equal(at105.strokes[0].closed, false);
});

test('fit: end が origin より手前の頂点（逆向き）でも stretch は正の長さで決まる', () => {
  // 手: D10・D stretch・D10。origin = 頂点 3、end = 頂点 0（目標は origin が下）。
  const s = strokeOf('a', [move(PenDir.DOWN, fixedLen(10)), move(PenDir.DOWN, stretchLen(5)), move(PenDir.DOWN, fixedLen(10))]);
  const fig = figureOf([s], {
    datums: [DS0, DT0, datumOf('dt1', DetailDatumRole.FL, DetailAxis.T, DetailDatumKind.END)],
    anchors: [anchorOf('ds0', 'a', 0), anchorOf('dt0', 'a', 3), anchorOf('dt1', 'a', 0)],
  });
  // end の目標 = origin の目標 − 100 → 頂点 0〜3 の距離 100 → stretch 80
  const r = fitDetailFigure(fig, { datums: { ds0: 0, dt0: 500, dt1: 400 } });
  assert.deepEqual(pts(r).map(p => p[1]), [400, 410, 490, 500]);
});

test('fit: stretch が s 軸（L/R）でも効く', () => {
  const s = strokeOf('a', [move(PenDir.RIGHT, fixedLen(5)), move(PenDir.RIGHT, stretchLen(1)), move(PenDir.RIGHT, fixedLen(5))]);
  const fig = figureOf([s], {
    datums: [DS0, DT0, datumOf('ds1', DetailDatumRole.OPENING_OUTER, DetailAxis.S, DetailDatumKind.END)],
    anchors: [anchorOf('ds0', 'a', 0), anchorOf('dt0', 'a', 0), anchorOf('ds1', 'a', 3)],
  });
  assert.deepEqual(pts(fitDetailFigure(fig, { datums: { ds0: 0, dt0: 0, ds1: 50 } })).map(p => p[0]), [0, 5, 45, 50]);
});

test('fit: Datum.offsetMm は目標に加算される（FL+900 / 見込の端 −10）', () => {
  const fig = stretchFigure();
  fig.datums = [DS0, datumOf('dt0', DetailDatumRole.FL, DetailAxis.T, DetailDatumKind.ORIGIN, 900), datumOf('dt1', DetailDatumRole.OPENING_INNER, DetailAxis.T, DetailDatumKind.END, -10)];
  // origin = 1000 + 900 = 1900、end = 2100 − 10 = 2090 → 差 190、固定 20 → stretch 170
  const r = fitDetailFigure(fig, { datums: { ds0: 0, dt0: 1000, dt1: 2100 } });
  assert.deepEqual(pts(r).map(p => p[1]), [1900, 1900, 1910, 2080, 2090, 2090]);
});

test('fit: Anchor で始点以外の頂点（vertexIndex 2）を原点に載せる', () => {
  const fig = rectFigure(100, 50);
  fig.anchors = [anchorOf('ds0', 'r', 2), anchorOf('dt0', 'r', 2)];
  assert.deepEqual(tupleOf(fitDetailFigure(fig, ZERO)), [[-100, -50], [0, -50], [0, 0], [-100, 0]]);
});

test('fit: param・material を targets で置換する（LenSpec.mm は無視される）', () => {
  const s = strokeOf('a', [
    move(PenDir.RIGHT, paramLen('frameFaceWidth', 1)),
    move(PenDir.DOWN, materialLen('M1', 'thickness', 1)),
    move(PenDir.LEFT, materialLen('M1', 'x', 1)),
  ]);
  const r = fitDetailFigure(figureOf([s]), { ...ZERO, params: { frameFaceWidth: 25 }, materials: { M1: { thickness: 12, x: 9, y: 3 } } });
  assert.deepEqual(tupleOf(r), [[0, 0], [25, 0], [25, 12], [16, 12]]);
});

test("fit: 'V'（斜め）を歩く", () => {
  const s = strokeOf('a', [move(PenDir.RIGHT, fixedLen(10)), vmove(fixedLen(30), fixedLen(40)), move(PenDir.DOWN, fixedLen(5))]);
  assert.deepEqual(tupleOf(fitDetailFigure(figureOf([s]), ZERO)), [[0, 0], [10, 0], [40, 40], [40, 45]]);
});

test("fit: 'V' の ss・st が −1 なら (−dx, −dy) へ進む。ss・st 省略は +1", () => {
  const neg = { dir: PenDir.VECTOR, dx: fixedLen(30), dy: fixedLen(40), ss: -1, st: -1 };
  const r = fitDetailFigure(figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(100)), neg])]), ZERO);
  assert.deepEqual(tupleOf(r), [[0, 0], [100, 0], [70, -40]]);
  const w = penWalk(strokeOf('x', [neg]), len => len.mm);
  assert.deepEqual(w.map(p => [p.s, p.t]), [[0, 0], [-30, -40]]);
  const mixed = { dir: PenDir.VECTOR, dx: fixedLen(30), dy: fixedLen(40), ss: 1, st: -1 };
  assert.deepEqual(penWalk(strokeOf('x', [mixed]), len => len.mm).map(p => [p.s, p.t]), [[0, 0], [30, -40]]);
});

test('fit: 複数ストロークは同じ origin の Datum を共有して載る', () => {
  const a = strokeOf('a', [move(PenDir.RIGHT, fixedLen(10))]);
  const b = strokeOf('b', [move(PenDir.DOWN, fixedLen(20))]);
  const r = fitDetailFigure(figureOf([a, b]), { datums: { ds0: 5, dt0: 7 } });
  assert.deepEqual(pts(r, 0), [[5, 7], [15, 7]]);
  assert.deepEqual(pts(r, 1), [[5, 7], [5, 27]]);
  assert.deepEqual(r.strokes.map(s => s.id), ['a', 'b']);
});

test('fit: line は正規化された値（省略時 thin・solid）で返る', () => {
  const fig = rectFigure();
  delete fig.strokes[0].line;
  assert.deepEqual(fitDetailFigure(fig, ZERO).strokes[0].line, { weightRole: 'thin', dashRole: DetailDash.SOLID });
});

test('fit 失敗: 固定寸法の和が目標以上（超過・ちょうど 0）', () => {
  const over = fitDetailFigure(stretchFigure(), { datums: { ds0: 0, dt0: 0, dt1: 15 } });
  assert.equal(over.error.code, F.FIXED_EXCEEDS_TARGET);
  const exact = fitDetailFigure(stretchFigure(), { datums: { ds0: 0, dt0: 0, dt1: 20 } });
  assert.equal(exact.error.code, F.FIXED_EXCEEDS_TARGET);
});

test('fit 失敗: 未解決の param・material（targets に無い）', () => {
  const p = figureOf([strokeOf('a', [move(PenDir.RIGHT, paramLen('frameDepth', 10))])]);
  assert.equal(fitDetailFigure(p, ZERO).error.code, F.UNRESOLVED_PARAM);
  assert.equal(fitDetailFigure(p, { ...ZERO, params: {} }).error.code, F.UNRESOLVED_PARAM);
  const m = figureOf([strokeOf('a', [move(PenDir.RIGHT, materialLen('M9', 'thickness', 10))])]);
  assert.equal(fitDetailFigure(m, { ...ZERO, materials: { OTHER: { thickness: 1, x: 1, y: 1 } } }).error.code, F.UNRESOLVED_MATERIAL);
  assert.equal(fitDetailFigure(m, ZERO).error.code, F.UNRESOLVED_MATERIAL);
});

test('fit 失敗: 解決した param が 0・負・NaN は BAD_RESOLVED_LENGTH', () => {
  const p = figureOf([strokeOf('a', [move(PenDir.RIGHT, paramLen('frameDepth', 10))])]);
  for (const bad of [0, -3, NaN, Infinity]) {
    assert.equal(fitDetailFigure(p, { ...ZERO, params: { frameDepth: bad } }).error.code, F.BAD_RESOLVED_LENGTH, String(bad));
  }
});

test('fit 失敗: 解決した material が 0・NaN は BAD_RESOLVED_LENGTH', () => {
  const m = figureOf([strokeOf('a', [move(PenDir.RIGHT, materialLen('M9', 'thickness', 10))])]);
  for (const bad of [0, NaN]) {
    assert.equal(fitDetailFigure(m, { ...ZERO, materials: { M9: { thickness: bad, x: 1, y: 1 } } }).error.code, F.BAD_RESOLVED_LENGTH, String(bad));
  }
});

test('fit 失敗: targets.datums に無い Datum・非有限の目標', () => {
  assert.equal(fitDetailFigure(stretchFigure(), { datums: { ds0: 0, dt0: 0 } }).error.code, F.NO_TARGET_DATUM);
  assert.equal(fitDetailFigure(stretchFigure(), { datums: { ds0: 0, dt0: NaN, dt1: 70 } }).error.code, F.NO_TARGET_DATUM);
  assert.equal(fitDetailFigure(stretchFigure(), undefined).error.code, F.NO_TARGET_DATUM);
});

test('fit 失敗: 検証に通らない図は INVALID（errors に理由）', () => {
  const bad = stretchFigure();
  bad.strokes[0].moves[0].len.mm = -1;
  const r = fitDetailFigure(bad, { datums: { ds0: 0, dt0: 0, dt1: 70 } });
  assert.equal(r.error.code, F.INVALID);
  assert.ok(r.error.errors.length > 0);
  assert.equal(fitDetailFigure(null, ZERO).error.code, F.INVALID);
});

test('fit: 入力の図を書き換えない', () => {
  const fig = stretchFigure();
  const before = JSON.stringify(fig);
  fitDetailFigure(fig, { datums: { ds0: 0, dt0: 0, dt1: 105 } });
  assert.equal(JSON.stringify(fig), before);
});
