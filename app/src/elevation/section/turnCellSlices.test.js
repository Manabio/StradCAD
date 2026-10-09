// turnCellSlices.js（回転部の多角形を切断線で切る純モジュール）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceTurnCells } from './turnCellSlices.js';

// 縦走行（走行軸 y）。y 減少が奥(+t)。矩形セル2枚: A=x0..1000・y1500..1000 / B=同じ x・y1000..500
const rectPoly = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
const CELLS = [
  { poly: rectPoly(0, 1500, 1000, 1000), z: 800, number: 5 },
  { poly: rectPoly(0, 1000, 1000, 500), z: 960, number: 6 },
];
const lane = (x) => ({ isVertical: true, axisValue: x }); // 走行方向に縦に切る線（レーン線）
const cross = (y) => ({ isVertical: false, axisValue: y }); // 走行方向を横切る線（seq1/seq3）
const r3 = (v) => Math.round(v * 1000) / 1000;

test('矩形: レーン線は走行方向の区間（acrossLo=acrossHi=線の位置）、段数字・高さ・桁枠なしを持つ', () => {
  const s = sliceTurnCells(CELLS, lane(500), true, -1);
  assert.deepEqual(s.map(l => [l.runLo, l.runHi, l.acrossLo, l.acrossHi, l.z, l.turnStep, l.isVertical]),
    [[1000, 1500, 500, 500, 800, 5, true], [500, 1000, 500, 500, 960, 6, true]]);
  assert.ok(s.every(l => l.frame.edges.length === 0));
});

test('矩形: 横切る線は幅方向の区間（runLo=runHi=線の位置）', () => {
  const s = sliceTurnCells(CELLS, cross(1200), true, -1);
  assert.deepEqual(s.map(l => [l.runLo, l.runHi, l.acrossLo, l.acrossHi, l.turnStep]), [[1200, 1200, 0, 1000, 5]]);
});

test('辺にちょうど重なる線は回転部の奥（+t）側のセルを採る（fwd=-1: y 減少が奥）。fwd=+1 なら逆側', () => {
  // y=1000 は A と B の境界。奥は y 減少なので B(6) を採る
  assert.deepEqual(sliceTurnCells(CELLS, cross(1000), true, -1).map(l => l.turnStep), [6]);
  assert.deepEqual(sliceTurnCells(CELLS, cross(1000), true, +1).map(l => l.turnStep), [5], 'fwd を反転すれば反対側のセル');
  // 入口の辺 y=1500 は奥側の A、回転部の終端 y=500 は奥側にセルが無いので何も採らない
  assert.deepEqual(sliceTurnCells(CELLS, cross(1500), true, -1).map(l => l.turnStep), [5]);
  assert.deepEqual(sliceTurnCells(CELLS, cross(500), true, -1), []);
});

test('辺から 0.5mm 以内の揺れは辺に乗っているものとして同じセルを採る（±1e-3）', () => {
  for (const dv of [-1e-3, 0, 1e-3]) {
    assert.deepEqual(sliceTurnCells(CELLS, cross(1000 + dv), true, -1).map(l => l.turnStep), [6], `dv=${dv}`);
  }
  assert.deepEqual(sliceTurnCells(CELLS, cross(1000 - 2), true, -1).map(l => l.turnStep), [6], '2mm 奥側（y 減少）は奥のセル');
  assert.deepEqual(sliceTurnCells(CELLS, cross(1000 + 2), true, -1).map(l => l.turnStep), [5], '2mm 手前側は手前のセル（許容幅の外）');
});

test('扇形（pivot から放射するセル）: レーン線との交点が放射線に一致し、隣り合うセルは同じ点を共有する', () => {
  // pivot (1000,1000)。セル1=三角形 pivot-(0,1000)-(0,500)、セル2=pivot-(0,500)-(500,0)... を単純化: 放射線 pivot→(0,500)
  const fan = [
    { poly: [1000, 1000, 0, 1000, 0, 500], z: 100, number: 1 },
    { poly: [1000, 1000, 0, 500, 0, 0, 1000, 0], z: 200, number: 2 },
  ];
  const s = sliceTurnCells(fan, lane(500), true, -1);
  // x=500 上: セル1 は y=1000(底辺)〜放射線 (1000,1000)→(0,500) の y=750。セル2 は 750〜0
  assert.deepEqual(s.map(l => [r3(l.runLo), r3(l.runHi), l.turnStep]), [[750, 1000, 1], [0, 750, 2]]);
  assert.equal(s[0].runLo, s[1].runHi, '放射線との交点は隣り合う2枚で完全に一致（縁の共有）');
});

test('外れる線・空・幅が GAP_EPS 以下の区間は []（捨てる）', () => {
  assert.deepEqual(sliceTurnCells(CELLS, lane(2000), true, -1), [], '多角形の外');
  assert.deepEqual(sliceTurnCells([], lane(500), true, -1), []);
  // 三角形の頂点にだけ触れる線は幅 0 の区間になるので捨てる
  const tri = [{ poly: [0, 0, 1000, 0, 500, 1000], z: 1, number: 1 }];
  assert.deepEqual(sliceTurnCells(tri, lane(1000), true, -1), [], '頂点にだけ触れる');
  assert.equal(sliceTurnCells(tri, lane(500), true, -1).length, 1);
});

test('不正な入力は例外にせず []（非有限・多角形が3点未満・奇数個の座標・cutLine なし・向きが boolean でない）', () => {
  assert.deepEqual(sliceTurnCells(null, lane(500), true), []);
  assert.deepEqual(sliceTurnCells(CELLS, null, true), []);
  assert.deepEqual(sliceTurnCells(CELLS, lane(NaN), true), []);
  assert.deepEqual(sliceTurnCells(CELLS, lane(Infinity), true), []);
  assert.deepEqual(sliceTurnCells(CELLS, { axisValue: 500 }, true), [], 'cutLine.isVertical なし');
  assert.deepEqual(sliceTurnCells(CELLS, lane(500), undefined), [], '階段の向きなし');
  assert.deepEqual(sliceTurnCells([{ poly: [0, 0, 1, 1], z: 1, number: 1 }], lane(0.5), true), [], '2点');
  assert.deepEqual(sliceTurnCells([{ poly: [0, 0, 1, 0, 1], z: 1, number: 1 }], lane(0.5), true), [], '奇数個');
  assert.deepEqual(sliceTurnCells([{ poly: [0, 0, 1000, 0, NaN, 1000], z: 1, number: 1 }], lane(500), true), [], '非有限の座標');
  assert.deepEqual(sliceTurnCells([{ poly: rectPoly(0, 0, 10, 10), z: NaN, number: 1 }], lane(5), true), [], '非有限の z');
});

test('横走行（isVertical=false）: 走行軸が x になり、レーン線は水平・横切る線は鉛直', () => {
  // 90度回した配置: セル A=x0..500・y0..1000、B=x500..1000
  const cells = [
    { poly: [0, 0, 500, 0, 500, 1000, 0, 1000], z: 1, number: 1 },
    { poly: [500, 0, 1000, 0, 1000, 1000, 500, 1000], z: 2, number: 2 },
  ];
  const s = sliceTurnCells(cells, { isVertical: false, axisValue: 500 }, false, 1);
  assert.deepEqual(s.map(l => [l.runLo, l.runHi, l.acrossLo, l.acrossHi, l.isVertical]), [[0, 500, 500, 500, false], [500, 1000, 500, 500, false]]);
  const c = sliceTurnCells(cells, { isVertical: true, axisValue: 500 }, false, 1);
  assert.deepEqual(c.map(l => l.turnStep), [2], '辺 x=500 は奥（+x）側のセル 2');
  assert.deepEqual(c.map(l => [l.runLo, l.runHi, l.acrossLo, l.acrossHi]), [[500, 500, 0, 1000]]);
});
