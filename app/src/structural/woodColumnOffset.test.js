// woodColumnOffset.js（在来木造の個別柱が壁の中で偏心する量。B-1・ユーザー裁定2026-09-17）の単体テスト。
// 純モジュール（core/constants・woodFraming.jsのみimport）なので node:test から単体でimportできる
// （.claude/structural-model.md「抽出純モジュールはnode:testから単体import可能に保つ」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { woodColumnEccentricity, ALONG_PROBE_STEP_MM } from './woodColumnOffset.js';

// 縦壁1本（X=0、Y方向に通し）。壁の外側はX<0側（outsideSignがX<0側で+1を返す想定）。
function verticalWallSegment(coord = 0, halfDepth = 60) {
  return { isVertical: true, coord, lo: -1000, hi: 1000, halfDepth };
}
function horizontalWallSegment(coord = 0, halfDepth = 60) {
  return { isVertical: false, coord, lo: -1000, hi: 1000, halfDepth };
}

// outsideSignのテスト用スタブ: 指定した符号を固定で返す（呼び出し引数を記録する）。
function fixedOutsideSign(sign, calls = []) {
  return (axisValue, isVertical, atCross) => {
    calls.push({ axisValue, isVertical, atCross });
    return sign;
  };
}

test('woodColumnEccentricity: 外壁（外側+1）W120/w105 → x=+7.5（外面そろえ＝屋外側へ寄る）', () => {
  const result = woodColumnEccentricity({
    axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: 105,
    segments: [verticalWallSegment(0)], outsideSign: fixedOutsideSign(1),
  });
  assert.equal(result.x, 7.5);
  assert.equal(result.y, 0, 'Y軸に一致する壁が無ければ0');
});

test('【検算】woodColumnEccentricity: 柱寸アップ W105/w120 → x=−7.5（室内へ出る）', () => {
  const result = woodColumnEccentricity({
    axisX: 0, axisY: 0, floorWidthMm: 105, columnWidthMm: 120,
    segments: [verticalWallSegment(0)], outsideSign: fixedOutsideSign(1),
  });
  assert.equal(result.x, -7.5);
});

test('woodColumnEccentricity: 内部壁（外側方向が判定できない＝outsideSignが常に0）は中央(0)', () => {
  const result = woodColumnEccentricity({
    axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: 105,
    segments: [verticalWallSegment(0)], outsideSign: fixedOutsideSign(0),
  });
  assert.equal(result.x, 0);
});

test('woodColumnEccentricity: side指定はoutsideSignより優先される', () => {
  const calls = [];
  const result = woodColumnEccentricity({
    axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: 105,
    side: { x: -1 }, segments: [verticalWallSegment(0)], outsideSign: fixedOutsideSign(1, calls),
  });
  assert.equal(result.x, -7.5, 'side.x=-1を優先し-1*(120-105)/2になる');
  assert.equal(calls.length, 0, 'side指定時はoutsideSignを呼ばない');
});

test('woodColumnEccentricity: side.x=0（中央）はoutsideSignの結果に関わらず0', () => {
  const result = woodColumnEccentricity({
    axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: 105,
    side: { x: 0 }, segments: [verticalWallSegment(0)], outsideSign: fixedOutsideSign(1),
  });
  assert.equal(result.x, 0);
});

test('woodColumnEccentricity: コーナー（両軸に壁）は各軸が独立に偏心する', () => {
  const result = woodColumnEccentricity({
    axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: 105,
    segments: [verticalWallSegment(0), horizontalWallSegment(0)],
    outsideSign: (axisValue, isVertical) => (isVertical ? 1 : -1),
  });
  assert.equal(result.x, 7.5, '縦壁側はoutsideSign(isVertical:true)=+1');
  assert.equal(result.y, -7.5, '横壁側はoutsideSign(isVertical:false)=-1');
});

test('【失敗系】woodColumnEccentricity: 壁が無い軸は0（segments=[]なら両軸とも0）', () => {
  const result = woodColumnEccentricity({
    axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: 105,
    segments: [], outsideSign: fixedOutsideSign(1),
  });
  assert.deepEqual(result, { x: 0, y: 0 });
});

test('【失敗系】woodColumnEccentricity: 共通柱（columnWidthMm===floorWidthMm）はsideがあっても常に{x:0,y:0}', () => {
  const result = woodColumnEccentricity({
    axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: 120,
    side: { x: 1, y: -1 }, segments: [verticalWallSegment(0), horizontalWallSegment(0)], outsideSign: fixedOutsideSign(1),
  });
  assert.deepEqual(result, { x: 0, y: 0 });
});

test('【失敗系】woodColumnEccentricity: floorWidthMmがnull・非数は例外を投げず{x:0,y:0}', () => {
  assert.deepEqual(
    woodColumnEccentricity({ axisX: 0, axisY: 0, floorWidthMm: null, columnWidthMm: 105, segments: [], outsideSign: fixedOutsideSign(1) }),
    { x: 0, y: 0 });
  assert.deepEqual(
    woodColumnEccentricity({ axisX: 0, axisY: 0, floorWidthMm: NaN, columnWidthMm: 105, segments: [], outsideSign: fixedOutsideSign(1) }),
    { x: 0, y: 0 });
});

test('【失敗系】woodColumnEccentricity: columnWidthMmが0・負の非finiteは例外を投げず{x:0,y:0}', () => {
  assert.deepEqual(
    woodColumnEccentricity({ axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: 0, segments: [], outsideSign: fixedOutsideSign(1) }),
    { x: 0, y: 0 });
  assert.deepEqual(
    woodColumnEccentricity({ axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: -105, segments: [], outsideSign: fixedOutsideSign(1) }),
    { x: 0, y: 0 });
});

test('【失敗系】woodColumnEccentricity: outsideSignが例外を投げても落とさず0扱い（内部壁と同じ挙動）', () => {
  const throwing = () => { throw new Error('boom'); };
  const result = woodColumnEccentricity({
    axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: 105,
    segments: [verticalWallSegment(0)], outsideSign: throwing,
  });
  assert.equal(result.x, 0);
});

test('woodColumnEccentricity: 自動判定は柱の走行方向座標がちょうど壁の交点（外側判定0）でも±ALONG_PROBE_STEP_MMでずらして再判定する（両側が一致すれば採用）', () => {
  const calls = [];
  // atCross===0のときだけ0、それ以外(±ALONG_PROBE_STEP_MM)は+1を返すスタブ。
  const outsideSign = (axisValue, isVertical, atCross) => {
    calls.push(atCross);
    return atCross === 0 ? 0 : 1;
  };
  const result = woodColumnEccentricity({
    axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: 105,
    segments: [verticalWallSegment(0)], outsideSign,
  });
  assert.equal(result.x, 7.5, '0番目の候補が0でも、区間内の±100候補が両方非0で一致すれば採用する');
  // QA指摘（B-1）: 食い違い検出のため±100の両候補を必ず評価する（先着した非0だけで確定しない）。
  assert.deepEqual(calls, [0, ALONG_PROBE_STEP_MM, -ALONG_PROBE_STEP_MM]);
  assert.equal(ALONG_PROBE_STEP_MM, 100);
});

test('【QA指摘・B-1】woodColumnEccentricity: 自動判定の±100候補が壁区間の外に出る場合はその候補を評価しない（区間外の別位置の符号を拾わない）', () => {
  // 縦壁の区間は[lo=0, hi=50]（along=0はギリギリ区間内）。along-100は区間外(-100<0)のため
  // 評価しない——along+100も区間外(100>50)のため評価しない。結果は0（内部壁と同じ扱い）。
  const seg = { isVertical: true, coord: 0, lo: 0, hi: 50, halfDepth: 60 };
  const calls = [];
  const outsideSign = (axisValue, isVertical, atCross) => { calls.push(atCross); return atCross === 0 ? 0 : -1; };
  const result = woodColumnEccentricity({
    axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: 105,
    segments: [seg], outsideSign,
  });
  assert.equal(result.x, 0, '区間外の候補は評価せず中央(0)に倒す');
  assert.deepEqual(calls, [0], 'along以外は区間外のため呼ばれない');
});

test('【QA指摘・B-1】woodColumnEccentricity: 自動判定の±100候補が区間内で符号が食い違う（+1と-1）場合は中央(0)に倒す', () => {
  // 区間を広く取り両候補とも区間内にする。+100側は+1、-100側は-1を返す食い違いスタブ。
  const seg = { isVertical: true, coord: 0, lo: -1000, hi: 1000, halfDepth: 60 };
  const outsideSign = (axisValue, isVertical, atCross) => {
    if (atCross === 0) return 0;
    return atCross > 0 ? 1 : -1;
  };
  const result = woodColumnEccentricity({
    axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: 105,
    segments: [seg], outsideSign,
  });
  assert.equal(result.x, 0, '±100候補が食い違う場合は決定不能として中央(0)に倒す');
});

test('woodColumnEccentricity: 自動判定の候補が全て0（内部壁）なら中央(0)で確定する', () => {
  const calls = [];
  const outsideSign = fixedOutsideSign(0, calls);
  const result = woodColumnEccentricity({
    axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: 105,
    segments: [verticalWallSegment(0)], outsideSign,
  });
  assert.equal(result.x, 0);
  assert.equal(calls.length, 3, '3候補すべて試す');
});

test('woodColumnEccentricity: 同軸に複数の壁が一致する場合は距離最小→coord昇順の1件で決める', () => {
  // 2本の縦壁が同じ半厚帯に重なって両方一致するケース（実際には稀だが決定的タイブレークを固定する）。
  const near = { isVertical: true, coord: 1, lo: -1000, hi: 1000, halfDepth: 60 };
  const far  = { isVertical: true, coord: 5, lo: -1000, hi: 1000, halfDepth: 60 };
  const result = woodColumnEccentricity({
    axisX: 0, axisY: 0, floorWidthMm: 120, columnWidthMm: 105,
    segments: [far, near], outsideSign: fixedOutsideSign(1),
  });
  assert.equal(result.x, 7.5, 'dist最小(near, coord=1)が選ばれても符号自体はoutsideSignで決まる（結果は同じ）');
});
