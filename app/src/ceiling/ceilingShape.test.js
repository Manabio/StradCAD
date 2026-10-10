// ceilingShape.js（天井区画の形状→高さ関数・注記）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ceilingShapeSolidZ, ceilingShapeMarks } from './ceilingShape.js';
import { rect } from '../plan/planTestFixtures.js';

const RECTS = [rect(1000, 2000, 3000, 4000)]; // 外接 x:1000..3000, y:2000..4000
const BASE = 2400, RISE = 1000;
const slope = dir => ceilingShapeSolidZ({ shape: 'slope', dims: [RISE, dir], baseZ: BASE, rects: RECTS });

test('傾斜: 上がる向き 4 方向それぞれで、低い側の端が baseZ・高い側の端が baseZ+rise・中点が中間。zLo/zHi は最小・最大', () => {
  // [向き, 低い側の点, 高い側の点, 中点]
  const cases = [
    [0, [1000, 3000], [3000, 3000]],     // 右へ上がる
    [90, [2000, 2000], [2000, 4000]],    // 下へ上がる
    [180, [3000, 3000], [1000, 3000]],   // 左へ上がる
    [270, [2000, 4000], [2000, 2000]],   // 上へ上がる
  ];
  for (const [dir, lo, hi] of cases) {
    const { zLo, zHi, zAt } = slope(dir);
    assert.equal(zAt(...lo), BASE, `向き${dir} 低い側`);
    assert.equal(zAt(...hi), BASE + RISE, `向き${dir} 高い側`);
    assert.equal(zAt((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2), BASE + RISE / 2, `向き${dir} 中点`);
    assert.equal(zLo, BASE);
    assert.equal(zHi, BASE + RISE);
  }
});

test('傾斜: 向きに直交する方向では高さが変わらない。範囲外の点は端の値にクランプする', () => {
  const right = slope(0).zAt;
  assert.equal(right(2000, 2000), right(2000, 4000));
  assert.equal(right(-5000, 3000), BASE, '低い側の外');
  assert.equal(right(9000, 3000), BASE + RISE, '高い側の外');
  const up = slope(270).zAt;
  assert.equal(up(2000, 9999), BASE);
  assert.equal(up(2000, -9999), BASE + RISE);
});

test('傾斜: 外接矩形は矩形群の全体（L 字でも低い側＝全体の端）', () => {
  const l = [rect(0, 0, 1000, 1000), rect(1000, 0, 4000, 1000)];
  const { zAt } = ceilingShapeSolidZ({ shape: 'slope', dims: [400, 0], baseZ: 100, rects: l });
  assert.equal(zAt(0, 0), 100);
  assert.equal(zAt(4000, 0), 500);
  assert.equal(zAt(2000, 0), 300);
});

test('平面: zAt なし・zLo = zHi = baseZ。円弧・ドームは S6a では平面と同じ扱い', () => {
  assert.deepEqual(ceilingShapeSolidZ({ shape: 'flat', dims: [], baseZ: BASE, rects: RECTS }), { zLo: BASE, zHi: BASE, zAt: null });
  for (const [shape, dims] of [['arc', [300, 0]], ['dome', [500]]]) {
    assert.deepEqual(ceilingShapeSolidZ({ shape, dims, baseZ: BASE, rects: RECTS }), { zLo: BASE, zHi: BASE, zAt: null }, shape);
  }
});

test('【失敗系】矩形なし・潰れた外接・寸法が形状に合わない・未知の形状は例外にせず平面と同じ', () => {
  const flat = { zLo: BASE, zHi: BASE, zAt: null };
  assert.deepEqual(ceilingShapeSolidZ({ shape: 'slope', dims: [RISE, 0], baseZ: BASE, rects: [] }), flat);
  assert.deepEqual(ceilingShapeSolidZ({ shape: 'slope', dims: [RISE, 0], baseZ: BASE, rects: undefined }), flat);
  assert.deepEqual(ceilingShapeSolidZ({ shape: 'slope', dims: [RISE, 0], baseZ: BASE, rects: [rect(5, 0, 5, 100)] }), flat, '幅 0');
  assert.deepEqual(ceilingShapeSolidZ({ shape: 'slope', dims: [0, 0], baseZ: BASE, rects: RECTS }), flat, 'ライズ 0');
  assert.deepEqual(ceilingShapeSolidZ({ shape: 'slope', dims: [RISE, 45], baseZ: BASE, rects: RECTS }), flat, '向き 45');
  assert.deepEqual(ceilingShapeSolidZ({ shape: 'pyramid', dims: [], baseZ: BASE, rects: RECTS }), flat);
});

test('注記: 傾斜は基準点（面積最大の矩形の中心）に 上がる向きの矢印 と「傾斜 CH低〜高」を詳細だけで付ける', () => {
  const marks = ceilingShapeMarks({ key: 'k', shape: 'slope', dims: [1200, 0], chMm: 2300, rects: [rect(0, 0, 1000, 1000), rect(1000, 0, 4000, 2000)] });
  assert.equal(marks.length, 1);
  assert.deepEqual(marks[0].anchor, { x: 2500, y: 1000 }, '面積最大の矩形の中心');
  const [arrow, text] = marks[0].prims;
  assert.equal(arrow.kind, 'arrow');
  assert.equal(arrow.detailOnly, true);
  assert.ok(arrow.points[2] > arrow.points[0] && arrow.points[3] === arrow.points[1], '向き0＝右へ上がる矢印（先端が右）');
  assert.equal(arrow.head.length, 6);
  assert.equal(text.kind, 'text');
  assert.equal(text.detailOnly, true);
  assert.equal(text.text, '傾斜 CH2300〜3500');
  assert.ok(text.fontSizeMm > 0);
  assert.equal(new Set(marks[0].prims.map(p => p.key)).size, 2, 'key は重複しない');
});

test('注記: 矢印の向きは 上がる向き（90=下・180=左・270=上）。同面積は y1→x1 の小さい矩形', () => {
  const tip = dir => {
    const [m] = ceilingShapeMarks({ key: 'k', shape: 'slope', dims: [500, dir], chMm: 2000, rects: RECTS });
    const [x1, y1, x2, y2] = m.prims[0].points;
    return [Math.sign(x2 - x1), Math.sign(y2 - y1)];
  };
  assert.deepEqual(tip(0), [1, 0]);
  assert.deepEqual(tip(90), [0, 1]);
  assert.deepEqual(tip(180), [-1, 0]);
  assert.deepEqual(tip(270), [0, -1]);
  const [tie] = ceilingShapeMarks({ key: 'k', shape: 'slope', dims: [500, 0], chMm: 2000, rects: [rect(2000, 0, 3000, 1000), rect(0, 0, 1000, 1000)] });
  assert.deepEqual(tie.anchor, { x: 500, y: 500 });
});

test('【失敗系】注記: 平面・円弧・ドーム・矩形なし・寸法不正・CH 非有限は付けない（[]）', () => {
  assert.deepEqual(ceilingShapeMarks({ key: 'k', shape: 'flat', dims: [], chMm: 2400, rects: RECTS }), []);
  assert.deepEqual(ceilingShapeMarks({ key: 'k', shape: 'arc', dims: [300, 0], chMm: 2400, rects: RECTS }), []);
  assert.deepEqual(ceilingShapeMarks({ key: 'k', shape: 'dome', dims: [300], chMm: 2400, rects: RECTS }), []);
  assert.deepEqual(ceilingShapeMarks({ key: 'k', shape: 'slope', dims: [300, 0], chMm: 2400, rects: [] }), []);
  assert.deepEqual(ceilingShapeMarks({ key: 'k', shape: 'slope', dims: [300, 45], chMm: 2400, rects: RECTS }), []);
  assert.deepEqual(ceilingShapeMarks({ key: 'k', shape: 'slope', dims: [300, 0], chMm: NaN, rects: RECTS }), []);
});
