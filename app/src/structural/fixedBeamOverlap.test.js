// fixedBeamOverlap.js の単体テスト（指示書 dev直下 260929_手動追加材サイレント撤去回避.md §5 ステップ2）。
// spansOverlapOnAxis の境界（tol=0.5mm）・向き違い・CL id違いでも同座標は同軸、を確かめる。
// 純モジュール: 実CL・PlanGraphは使わず、effectiveValueだけを持つ最小オブジェクトで足りる
// （beamAxisSpan/spansOverlapOnAxisは.effectiveValue/.isVerticalしか読まない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beamAxisSpan, spansOverlapOnAxis, fixedBeamSpans, overlapsAnySpan } from './fixedBeamOverlap.js';

function cl(id, effectiveValue) { return { id, effectiveValue, value: effectiveValue }; }

function beam({ axisCL, isVertical = false, clStart, clEnd, role = 'primary', dimensionStatus = 'auto' }) {
  return { axisCL, isVertical, clStart, clEnd, role, dimensionStatus };
}

test('spansOverlapOnAxis: tol内(0.4mm)の軸ズレは同軸とみなし重なる', () => {
  const y1 = cl('y1', 0), y1b = cl('y1b', 0.4);
  const a = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x1', 0), clEnd: cl('x2', 4000) }));
  const b = beamAxisSpan(beam({ axisCL: y1b, clStart: cl('x1', 0), clEnd: cl('x2', 4000) }));
  assert.equal(spansOverlapOnAxis(a, b), true);
});

test('spansOverlapOnAxis: tol超(1mm)の軸ズレは別軸とみなし重ならない', () => {
  const y1 = cl('y1', 0), y2 = cl('y2', 1);
  const a = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x1', 0), clEnd: cl('x2', 4000) }));
  const b = beamAxisSpan(beam({ axisCL: y2, clStart: cl('x1', 0), clEnd: cl('x2', 4000) }));
  assert.equal(spansOverlapOnAxis(a, b), false);
});

test('spansOverlapOnAxis: 向きが違えば同座標でも重ならない', () => {
  const cl0 = cl('c0', 0);
  const a = beamAxisSpan(beam({ axisCL: cl0, isVertical: false, clStart: cl('x1', 0), clEnd: cl('x2', 4000) }));
  const b = beamAxisSpan(beam({ axisCL: cl0, isVertical: true, clStart: cl('y1', 0), clEnd: cl('y2', 4000) }));
  assert.equal(spansOverlapOnAxis(a, b), false);
});

test('spansOverlapOnAxis: CL idが違っても同座標(effectiveValue)なら同軸として扱う', () => {
  const y1 = cl('y1', 1000), yOther = cl('y-other', 1000); // idは異なるがeffectiveValueが同じ
  const a = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x1', 0), clEnd: cl('x2', 4000) }));
  const b = beamAxisSpan(beam({ axisCL: yOther, clStart: cl('x1', 0), clEnd: cl('x2', 4000) }));
  assert.equal(spansOverlapOnAxis(a, b), true);
});

test('spansOverlapOnAxis: 区間が端点で接するだけは重ならない（開区間）', () => {
  const y1 = cl('y1', 0);
  const a = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x1', 0), clEnd: cl('x2', 4000) }));
  const b = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x2', 4000), clEnd: cl('x3', 8000) }));
  assert.equal(spansOverlapOnAxis(a, b), false);
});

test('spansOverlapOnAxis: 区間が真に重なれば重なる', () => {
  const y1 = cl('y1', 0);
  const a = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x1', 0), clEnd: cl('x3', 8000) }));
  const b = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x1', 0), clEnd: cl('x2', 4000) }));
  assert.equal(spansOverlapOnAxis(a, b), true);
});

test('spansOverlapOnAxis: 左右逆の端点接触（a=[4000,8000], b=[0,4000]）も重ならない', () => {
  const y1 = cl('y1', 0);
  const a = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x2', 4000), clEnd: cl('x3', 8000) }));
  const b = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x1', 0), clEnd: cl('x2', 4000) }));
  assert.equal(spansOverlapOnAxis(a, b), false);
});

test('spansOverlapOnAxis: 区間の重なりがtol内(0.4mm)なら重ならない（a=[0,4000], b=[3999.6,8000]）', () => {
  const y1 = cl('y1', 0);
  const a = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x1', 0), clEnd: cl('x2', 4000) }));
  const b = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x2b', 3999.6), clEnd: cl('x3', 8000) }));
  assert.equal(spansOverlapOnAxis(a, b), false);
});

test('spansOverlapOnAxis: 区間の重なりが1mmなら重なる（a=[0,4000], b=[3999,8000]）', () => {
  const y1 = cl('y1', 0);
  const a = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x1', 0), clEnd: cl('x2', 4000) }));
  const b = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x2b', 3999), clEnd: cl('x3', 8000) }));
  assert.equal(spansOverlapOnAxis(a, b), true);
});

// a.lo < b.hi - tol の等号側（a.lo === b.hi - tol）を狙った境界。上の3件（左右逆の端点接触・重なり
// 0.4mm/1mm）は実測するとどれも「a.hi > b.lo + tol」側の等号で判定が決まり、この条件式の
// 「<」を「<=」に変異させても赤にならない（QA指摘の変異箇所を確認する過程で判明。tol境界は
// 対称な2条件のうちどちらの端で起きるかでケース分けが要る）。この条件式自体の等号を狙うには
// b.hi = a.lo + tol ちょうど（隙間=tolぴったり）にする必要がある。
test('spansOverlapOnAxis: a.lo と b.hi の差がちょうどtol（b.hi = a.lo + tol）なら重ならない', () => {
  const y1 = cl('y1', 0);
  const a = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x2', 4000), clEnd: cl('x3', 8000) }));
  const b = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x0', 0), clEnd: cl('x1b', 4000.5) })); // b.hi=4000.5=a.lo(4000)+tol(0.5)
  assert.equal(spansOverlapOnAxis(a, b), false);
});

test('fixedBeamSpans: role一致・非autoのみ抽出する', () => {
  const y1 = cl('y1', 0);
  const beams = [
    beam({ axisCL: y1, clStart: cl('x1', 0), clEnd: cl('x2', 4000), role: 'primary', dimensionStatus: 'locked' }),
    beam({ axisCL: y1, clStart: cl('x1', 0), clEnd: cl('x2', 4000), role: 'primary', dimensionStatus: 'auto' }), // auto除外
    beam({ axisCL: y1, clStart: cl('x1', 0), clEnd: cl('x2', 4000), role: 'secondary', dimensionStatus: 'locked' }), // role違い除外
  ];
  const spans = fixedBeamSpans(beams, 'primary');
  assert.equal(spans.length, 1);
});

test('overlapsAnySpan: spansが空なら常にfalse', () => {
  const y1 = cl('y1', 0);
  const span = beamAxisSpan(beam({ axisCL: y1, clStart: cl('x1', 0), clEnd: cl('x2', 4000) }));
  assert.equal(overlapsAnySpan(span, []), false);
});
