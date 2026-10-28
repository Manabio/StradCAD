import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beamGridCells, bayBeamIsVertical, divideBayEqually, equalDivisionCoords, clearGapDivisionCoords } from './framingCells.js';

const closeTo = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} 期待 ${b} 実際 ${a}`);

test('フランジ間割付け: 7000スパン・境界200・子125×2 → あき3つが等しく式どおりの座標、左右対称', () => {
  // 手計算: あき＝(7000−100−100−125−125)/3＝6550/3＝2183.33…。子1の芯＝−7000+100+2183.33+62.5＝−4654.17（＝−4654−1/6）、
  // 子2の芯＝−7000+100+2·2183.33+125+62.5＝−2345.83（＝−2345−5/6）。関数の式を写さず数値で固定する。
  const c = clearGapDivisionCoords(-7000, 0, 200, 200, [125, 125]);
  assert.equal(c.length, 2);
  closeTo(c[0], -4654 - 1 / 6);
  closeTo(c[1], -2345 - 5 / 6);
  closeTo(0 - c[1], c[0] + 7000, '対称');
});

test('フランジ間割付け: 全幅同一なら equalDivisionCoords と一致（n=2,3,4・longLo=0/-5000・幅0も）', () => {
  for (const lo of [0, -5000]) {
    for (const w of [100, 0]) {
      for (const n of [2, 3, 4]) {
        const got = clearGapDivisionCoords(lo, lo + 6000, w, w, new Array(n - 1).fill(w));
        const exp = equalDivisionCoords(lo, lo + 6000, n);
        assert.equal(got.length, exp.length);
        got.forEach((v, k) => closeTo(v, exp[k], `lo=${lo} w=${w} n=${n}`));
      }
    }
  }
});

test('フランジ間割付け: 子梁の幅が異なる[100,300]でも面どうしのあき3つが等しい（芯±幅/2 から検算）', () => {
  const lo = 0, hi = 6000, wLo = 200, wHi = 150;
  const widths = [100, 300];
  const c = clearGapDivisionCoords(lo, hi, wLo, wHi, widths);
  const gap1 = (c[0] - widths[0] / 2) - (lo + wLo / 2);
  const gap2 = (c[1] - widths[1] / 2) - (c[0] + widths[0] / 2);
  const gap3 = (hi - wHi / 2) - (c[1] + widths[1] / 2);
  closeTo(gap1, gap2);
  closeTo(gap2, gap3);
  assert.ok(gap1 > 0);
});

test('フランジ間割付け: childWidths が空 → []', () => {
  assert.deepEqual(clearGapDivisionCoords(0, 5000, 200, 200, []), []);
});

test('フランジ間割付け: 子梁の幅が異なる3本[100,300,150]でも面どうしのあき4つが等しい（累積和の検算）', () => {
  const lo = 0, hi = 8000, wLo = 200, wHi = 150;
  const widths = [100, 300, 150];
  const c = clearGapDivisionCoords(lo, hi, wLo, wHi, widths);
  assert.equal(c.length, 3);
  const faces = [lo + wLo / 2, ...c.flatMap((v, k) => [v - widths[k] / 2, v + widths[k] / 2]), hi - wHi / 2];
  const gaps = [faces[1] - faces[0], faces[3] - faces[2], faces[5] - faces[4], faces[7] - faces[6]];
  gaps.slice(1).forEach((g, k) => closeTo(g, gaps[0], `あき${k + 2}`));
  assert.ok(gaps[0] > 0);
  assert.ok(c[0] < c[1] && c[1] < c[2], '昇順');
});

test('フランジ間割付け: 幅の合計が区間を超える（gap<0）→ 等分へ退化し例外にしない（非対称: 退化しなければ 650 になる入力）', () => {
  // あき＝(1000−400−100−600)/2＝−50。退化しないと 0+400−50+300＝650 になるので、等分の 500 と区別できる。
  assert.deepEqual(clearGapDivisionCoords(0, 1000, 800, 200, [600]), [500]);
  assert.deepEqual(clearGapDivisionCoords(0, 1000, 800, 200, [600]), equalDivisionCoords(0, 1000, 2));
});

test('フランジ間割付け【失敗系】: 不正な引数は日本語の Error', () => {
  const re = /フランジ間割付けの引数が不正です/;
  assert.throws(() => clearGapDivisionCoords(0, NaN, 100, 100, [100]), re);
  assert.throws(() => clearGapDivisionCoords(5000, 0, 100, 100, [100]), re, 'longHi < longLo（降順の区間）');
  assert.throws(() => clearGapDivisionCoords(0, 5000, -1, 100, [100]), re);
  assert.throws(() => clearGapDivisionCoords(0, 5000, 100, 100, 100), re);
  assert.throws(() => clearGapDivisionCoords(0, 5000, 100, 100, [-1]), re);
  assert.throws(() => clearGapDivisionCoords(0, 5000, 100, 100, ['a']), re);
  assert.throws(() => clearGapDivisionCoords(0, 5000, 100, 100, [Infinity]), re);
});

// 縦線ヘルパ（coord=x, lo/hi=y範囲）
const V = (coord, lo, hi) => ({ isVertical: true, coord, lo, hi });
// 横線ヘルパ（coord=y, lo/hi=x範囲）
const H = (coord, lo, hi) => ({ isVertical: false, coord, lo, hi });

test('田の字（縦3本×横3本、全線が全長）→ 4セル、y1昇順→x1昇順の決定的な順', () => {
  const lines = [
    V(0, 0, 2000), V(1000, 0, 2000), V(2000, 0, 2000),
    H(0, 0, 2000), H(1000, 0, 2000), H(2000, 0, 2000),
  ];
  const cells = beamGridCells(lines);
  assert.deepEqual(cells, [
    { x1: 0,    y1: 0,    x2: 1000, y2: 1000 },
    { x1: 1000, y1: 0,    x2: 2000, y2: 1000 },
    { x1: 0,    y1: 1000, x2: 1000, y2: 2000 },
    { x1: 1000, y1: 1000, x2: 2000, y2: 2000 },
  ]);
});

test('田の字の中央の横線が左半分(x:0..1000)しか無い → 左側は隣接ペアで2セル、右側はその横線に分割されず1×2の縦長セルとして出る（全ペア方式。隣接ペア方式なら右側は出ない）', () => {
  const lines = [
    V(0, 0, 2000), V(1000, 0, 2000), V(2000, 0, 2000),
    H(0, 0, 2000), H(1000, 0, 1000), H(2000, 0, 2000),
  ];
  const cells = beamGridCells(lines);
  // 左側(x:0..1000)は中央の横線がx:0..1000を覆う＝反対側の辺(x=1000)まで届く分割なので2セルに割れる。
  // 右側(x:1000..2000)は中央の横線がx:1000..2000まで届かない（スタブ）ため分割とみなさず、
  // y:0..2000の縦長1セルにまとまる——T字の座標が縦・横クラスタ列に混ざっても隣接ペアで
  // 表現できない大部屋を落とさないための挙動（実データmoku1.stqで再発した欠陥の修正）。
  assert.deepEqual(cells, [
    { x1: 0,    y1: 0, x2: 1000, y2: 1000 },
    { x1: 1000, y1: 0, x2: 2000, y2: 2000 },
    { x1: 0,    y1: 1000, x2: 1000, y2: 2000 },
  ]);
});

test('内部を端から端まで横断する梁がある矩形は分割後の小矩形だけ出る（大矩形自体は候補から除外される）', () => {
  // 縦3本(0,1000,2000。全て全長0..1000)×横2本(0,1000。全て全長0..2000)の「1行2列」。
  // 中央の縦線x=1000は矩形の反対側の辺(y=0..1000)まで届く＝分割している
  // → 大矩形(0,0)-(2000,1000)は候補にならず、左右の1x1セルだけが返る。
  const lines = [
    V(0, 0, 1000), V(1000, 0, 1000), V(2000, 0, 1000),
    H(0, 0, 2000), H(1000, 0, 2000),
  ];
  const cells = beamGridCells(lines);
  assert.deepEqual(cells, [
    { x1: 0,    y1: 0, x2: 1000, y2: 1000 },
    { x1: 1000, y1: 0, x2: 2000, y2: 1000 },
  ]);
});

test('【失敗系】矩形内部へ梁（スタブ含む）が入り込む場合は候補外（横断・スタブを区別しない厳密判定。二重梁の回避）', () => {
  // 縦2本(x=0,2000。全長0..2000)×横2本(y=0,2000。全長0..2000)の外周4辺に加え、内部に
  // 縦のスタブ x=1000（y:0..800、反対側y=2000までは届かない）を追加。反対側まで横断しなくても
  // 矩形の内部（開区間）へ入り込んでいる時点で「壁・柱の無い区画」ではないため候補外——
  // 大矩形(0,0)-(2000,2000)も、スタブが接する側の小矩形(0,0)-(1000,2000)/(1000,0)-(2000,2000)も
  // （後者2つはそもそも右辺／左辺の被覆自体が欠けるため元々候補外）どちらも出ず、結果は空になる。
  const lines = [
    V(0, 0, 2000), V(2000, 0, 2000),
    V(1000, 0, 800), // 矩形内部へ入り込む梁（スタブでも区別しない）
    H(0, 0, 2000), H(2000, 0, 2000),
  ];
  const cells = beamGridCells(lines);
  assert.deepEqual(cells, [], '内部に梁が1本でも入り込む矩形は区画として扱わない');
});

test('線分が2本に分かれていてもtol内の隙間なら連続被覆とみなす', () => {
  const tol = 0.5;
  // 最小2x2グリッド（縦2本・横2本）に固定し、隣接ペア/全ペアの違いとは無関係に
  // 「被覆が区間の和で判定されるか」だけを問う。横線y=1000をx=[0,500]と
  // x=[500.3,1000]の2本に分割（隙間0.3<tol）。
  const lines = [
    V(0, 0, 1000), V(1000, 0, 1000),
    H(0, 0, 1000), H(1000, 0, 500), H(1000, 500.3, 1000),
  ];
  const cells = beamGridCells(lines, tol);
  assert.deepEqual(cells, [{ x1: 0, y1: 0, x2: 1000, y2: 1000 }], '分割されていても連続被覆とみなされセルが出る');
});

test('同一coordの線がtol未満でずれていても同一線として扱う', () => {
  const tol = 0.5;
  // 最小2x2グリッドに固定。縦線x=1000相当をcoordが僅かにずれた(diff=0.3<tol)
  // 2本の線分として登録——同一線として1クラスタにまとまれば1セル、まとまらず
  // 別クラスタ(x=1000とx=1000.3)になれば2列に分かれてしまい被覆判定も変わる。
  const lines = [
    V(0, 0, 1000),
    V(1000,   0, 1000),
    V(1000.3, 0, 1000),
    H(0, 0, 1000), H(1000, 0, 1000),
  ];
  const cells = beamGridCells(lines, tol);
  assert.deepEqual(cells, [{ x1: 0, y1: 0, x2: 1000, y2: 1000 }], '同一線とみなされ縦線coordは2本ぶん（余分な縦分割が出ない）');
});

test('非矩形（縦2本・横1本）→ 空', () => {
  const lines = [V(0, 0, 2000), V(1000, 0, 2000), H(0, 0, 2000)];
  assert.deepEqual(beamGridCells(lines), []);
});

test('線1本のみ → 空', () => {
  assert.deepEqual(beamGridCells([V(0, 0, 2000)]), []);
});

test('空配列 → 空', () => {
  assert.deepEqual(beamGridCells([]), []);
});

test('非数混入 → 空', () => {
  const lines = [
    V(0, 0, 2000),
    { isVertical: true, coord: NaN, lo: 0, hi: 2000 },
    { isVertical: false, coord: 0, lo: NaN, hi: 2000 },
    H(0, 0, 2000),
  ];
  // 有効な線が縦1本・横1本しか残らず、2x2グリッドを組めない
  assert.deepEqual(beamGridCells(lines), []);
});

test('【失敗系】beamGridCells(null) → 空配列（例外を投げない）', () => {
  assert.deepEqual(beamGridCells(null), []);
  assert.deepEqual(beamGridCells(undefined), []);
});

test('入力順序をシャッフルしても同一結果になる（内部でクラスタ化・最終ソートするため順序に依存しない）', () => {
  const lines = [
    V(0, 0, 2000), V(1000, 0, 2000), V(2000, 0, 2000),
    H(0, 0, 2000), H(1000, 0, 2000), H(2000, 0, 2000),
  ];
  const shuffled = [lines[4], lines[1], lines[5], lines[0], lines[3], lines[2]];
  assert.notDeepEqual(shuffled, lines, '前提: 実際に順序が入れ替わっている');
  assert.equal(beamGridCells(lines).length, 4, '前提: 田の字は4セル（シャッフル結果と比較する基準そのものが正しいことを固定する）');
  assert.deepEqual(beamGridCells(shuffled), beamGridCells(lines));
});

test('bayBeamIsVertical: 高さが幅より小さいときだけ縦梁。正方形・高さが長いときは横梁', () => {
  assert.equal(bayBeamIsVertical(7000, 5000), true);
  assert.equal(bayBeamIsVertical(5000, 5000), false, '正方形は横梁（材軸＝X）');
  assert.equal(bayBeamIsVertical(5000, 7000), false);
});

test('divideBayEqually: 5000×7000・最大2500 → 長辺7000を3等分、内部2本。横梁（isVertical:false）で短辺はx方向', () => {
  const r = divideBayEqually({ x1: 0, y1: -7000, x2: 5000, y2: 0 }, 2500);
  assert.equal(r.isVertical, false);
  assert.deepEqual(r.coords, [-7000 + 7000 / 3, -7000 + 2 * (7000 / 3)], '式は longLo + i*(long/n)。丸めない');
  assert.deepEqual([r.shortLo, r.shortHi, r.longLo, r.longHi], [0, 5000, -7000, 0]);
});

test('divideBayEqually: 縦長でないベイ（7000×5000）は縦梁でx方向を等分、短辺はy方向', () => {
  const r = divideBayEqually({ x1: 0, y1: 0, x2: 7000, y2: 5000 }, 2500);
  assert.equal(r.isVertical, true);
  assert.equal(r.coords.length, 2);
  assert.deepEqual([r.shortLo, r.shortHi], [0, 5000]);
});

test('【失敗系】divideBayEqually: 短辺が最大ピッチ以下なら null（ちょうど2500は割らない、2501は割る）', () => {
  assert.equal(divideBayEqually({ x1: 0, y1: 0, x2: 2500, y2: 9000 }, 2500), null);
  assert.equal(divideBayEqually({ x1: 0, y1: 0, x2: 9000, y2: 2500 }, 2500), null);
  assert.equal(divideBayEqually({ x1: 0, y1: 0, x2: 2501, y2: 2501 }, 2500).coords.length, 1);
});

test('divideBayEqually: 木造の床梁と同じ式（最大1820・2730×5460 → 1820/3640）', () => {
  const r = divideBayEqually({ x1: 0, y1: 0, x2: 2730, y2: 5460 }, 1820);
  assert.deepEqual(r.coords, [1820, 3640]);
});
