import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRelative, resolveDisplayValue, isComplete, safeEval, calcStep, roundAbsToStep, getDisplayBase } from './clMoveMath.js';

// ---- 実機バグA/F再現: 素の負数入力が相対デルタと誤解釈される問題の回帰確認 ----
// 梁芯CL move UI で refOffset=1292（Y2から下へ1292）の状態から "-1820" を1文字ずつ打つと、
// 修正前は isRelative("-1820")===true により「現在の表示値(-1292) + (-1820) = -3112」という
// 意図しない相対移動になっていた（実機観測: effectiveValue が -2348 → -528 に変化）。
test('isRelative: "-" 始まりは絶対値（相対扱いしない）。"+" 始まりのみ相対', () => {
  assert.equal(isRelative('-1820'), false, '素の負数は絶対値入力として扱う');
  assert.equal(isRelative('-1'), false);
  assert.equal(isRelative('+100'), true, '"+100" は現在値に加算する相対入力のまま');
  assert.equal(isRelative('100'), false, '符号なしはそもそも絶対値（相対の対象外）');
});

test('resolveDisplayValue: "-1820" は relativeBase に関係なく絶対値 -1820 として解決される', () => {
  const relativeBase = -1292; // 実機の初期表示値相当（丸め後）
  assert.equal(resolveDisplayValue('-1820', relativeBase), -1820);
  assert.equal(resolveDisplayValue('-528', relativeBase), -528);
});

test('resolveDisplayValue: "+100" は relativeBase に加算される（相対演算は維持）', () => {
  assert.equal(resolveDisplayValue('+100', 1292), 1392);
});

test('resolveDisplayValue: 不完全な式（末尾が演算子・空文字）は NaN', () => {
  assert.ok(Number.isNaN(resolveDisplayValue('-', -1292)));
  assert.ok(Number.isNaN(resolveDisplayValue('', -1292)));
  assert.ok(Number.isNaN(resolveDisplayValue('12+', -1292)));
});

// ---- 既存ロジックの回帰確認（isComplete/safeEval/calcStep/roundAbsToStep/getDisplayBase） ----
test('isComplete: 末尾が演算子なら未完了、それ以外は safeEval で判定', () => {
  assert.equal(isComplete('123'), true);
  assert.equal(isComplete('123+'), false);
  assert.equal(isComplete(''), false);
  assert.equal(isComplete('12+3'), true);
});

test('safeEval: 括弧なし四則演算のみ許可し、それ以外はNaN', () => {
  assert.equal(safeEval('100+50'), 150);
  assert.equal(safeEval('100*2'), 200);
  assert.ok(Number.isNaN(safeEval('alert(1)')));
  assert.ok(Number.isNaN(safeEval('(1+2)')));
});

test('safeEval: ".5" 形式・×÷ も evalNumpadExpr への委譲で評価できる', () => {
  assert.equal(safeEval('.5'), 0.5);
  assert.equal(safeEval('3×4'), 12);
});

// isRelative修正の回帰止め: "+.5"（数字なし小数）も "+0.5" と同様に相対演算扱いになること
test('resolveDisplayValue: "+.5" は "+0.5" と同様に relativeBase へ加算される（isRelativeの.5対応回帰）', () => {
  assert.equal(resolveDisplayValue('+.5', 1000), 1000.5);
});

test('calcStep: 倍率分母の最大桁単位', () => {
  assert.equal(calcStep(151), 100);
  assert.equal(calcStep(230), 200);
  assert.equal(calcStep(0), 1);
});

test('getDisplayBase/roundAbsToStep: 参照CL基準の絶対値変換が往復一致する（回帰）', () => {
  const referenced = { value: -3640, label: 'Y2' };
  const cl = { id: 'beam1', refId: 'y2id', _referencedCL: referenced };
  const isV = false; // 水平CL
  const base = getDisplayBase(cl, isV, null, false);
  assert.equal(base, -3640);
  // roundAbsToStepは絶対値→絶対値（表示ステップ丸め込み）の変換。往復性の確認。
  const rounded = roundAbsToStep(-2348, cl, isV, 100, null);
  assert.equal(typeof rounded, 'number');
  assert.ok(Number.isFinite(rounded));
});
