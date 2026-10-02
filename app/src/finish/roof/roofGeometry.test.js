import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roofShortSpanMm, rectOfBounds, resolveRoofHighSide, roofHighSideView, resolveRoofRidgeIsVertical, roofRidgeDirectionView,
} from './roofGeometry.js';

const rect = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });

test('roofShortSpanMm: 1つの矩形は短辺', () => {
  assert.equal(roofShortSpanMm([rect(0, 0, 4000, 2000)]), 2000);
  assert.equal(roofShortSpanMm([rect(0, 0, 1500, 6000)]), 1500);
});

test('roofShortSpanMm: セルに分割された矩形（格子）も全体の短辺', () => {
  // 4000x3000 を 2x2 のセルに分割
  const cells = [rect(0, 0, 2000, 1500), rect(2000, 0, 4000, 1500), rect(0, 1500, 2000, 3000), rect(2000, 1500, 4000, 3000)];
  assert.equal(roofShortSpanMm(cells), 3000);
});

test('roofShortSpanMm: L字は2本の腕のうち太い方の幅（分割の取り方に依存しない）', () => {
  // 横腕 6000x2000（y:0..2000）＋縦腕 3000 幅（x:0..3000, y:2000..7000）。内接矩形の短辺の最大は縦腕の 3000
  const lShape = [rect(0, 0, 6000, 2000), rect(0, 2000, 3000, 7000)];
  assert.equal(roofShortSpanMm(lShape), 3000);
  // 同じ L 字を別の分割（縦割り）で与えても同じ
  const lShapeOther = [rect(0, 0, 3000, 7000), rect(3000, 0, 6000, 2000)];
  assert.equal(roofShortSpanMm(lShapeOther), 3000);
});

test('roofShortSpanMm: 離れた2成分はそれぞれ測った最大', () => {
  const two = [rect(0, 0, 1000, 8000), rect(5000, 0, 9000, 3000)];
  assert.equal(roofShortSpanMm(two), 3000);
});

test('roofShortSpanMm: 辺で接する2セルは1つの矩形として測る（ちょうど 3640 の境界）', () => {
  const cells = [rect(0, 0, 2000, 3640), rect(2000, 0, 5000, 3640)];
  assert.equal(roofShortSpanMm(cells), 3640);
});

test('【失敗系】roofShortSpanMm: 空・null・面積0だけなら 0', () => {
  assert.equal(roofShortSpanMm([]), 0);
  assert.equal(roofShortSpanMm(null), 0);
  assert.equal(roofShortSpanMm(undefined), 0);
  assert.equal(roofShortSpanMm([rect(0, 0, 0, 1000), null]), 0);
});

test('roofShortSpanMm: 辺が一致しない（角でだけ接する）2矩形は連結せずそれぞれ測る', () => {
  const diag = [rect(0, 0, 2000, 2000), rect(2000, 2000, 5000, 4000)];
  assert.equal(roofShortSpanMm(diag), 2000);
});

test('rectOfBounds: 1つの矩形はそのまま外接矩形', () => {
  assert.deepEqual(rectOfBounds([rect(0, -12614, 7280, -3640)]), rect(0, -12614, 7280, -3640));
});

test('rectOfBounds: 2x2 セルに分割された 4000x3000 は矩形 (0,0,4000,3000)', () => {
  const cells = [rect(0, 0, 2000, 1500), rect(2000, 0, 4000, 1500), rect(0, 1500, 2000, 3000), rect(2000, 1500, 4000, 3000)];
  assert.deepEqual(rectOfBounds(cells), rect(0, 0, 4000, 3000));
});

test('rectOfBounds: 重なりのあるセル矩形でも和集合が矩形なら矩形（面積は和集合で数える）', () => {
  assert.deepEqual(rectOfBounds([rect(0, 0, 3000, 2000), rect(2000, 0, 5000, 2000)]), rect(0, 0, 5000, 2000));
  assert.deepEqual(rectOfBounds([rect(0, 0, 5000, 2000), rect(1000, 0, 2000, 2000)]), rect(0, 0, 5000, 2000));
});

test('rectOfBounds: L字は null（外接矩形に欠けがある）', () => {
  assert.equal(rectOfBounds([rect(0, 0, 6000, 2000), rect(0, 2000, 3000, 7000)]), null);
});

test('rectOfBounds: 離れた2成分は null。角でだけ接する2矩形も null', () => {
  assert.equal(rectOfBounds([rect(0, 0, 1000, 8000), rect(5000, 0, 9000, 3000)]), null);
  assert.equal(rectOfBounds([rect(0, 0, 2000, 2000), rect(2000, 2000, 5000, 4000)]), null);
});

test('【失敗系】rectOfBounds: 空・null・面積0・非有限だけなら null', () => {
  assert.equal(rectOfBounds([]), null);
  assert.equal(rectOfBounds(null), null);
  assert.equal(rectOfBounds(undefined), null);
  assert.equal(rectOfBounds([rect(0, 0, 0, 1000), null, rect(0, 0, NaN, 5)]), null);
});

test('rectOfBounds: 面積0・null の混入は無視して矩形判定', () => {
  assert.deepEqual(rectOfBounds([rect(0, 0, 3000, 2000), null, rect(9000, 9000, 9000, 9500)]), rect(0, 0, 3000, 2000));
});

const adj = (top, bottom, left, right) => ({ top, bottom, left, right });

test('resolveRoofHighSide: 明示値が最優先（接する辺・形に関係なく）', () => {
  assert.equal(resolveRoofHighSide('right', rect(0, 0, 5000, 3000), adj(9000, 0, 0, 0)), 'right');
  assert.equal(resolveRoofHighSide('bottom', null, null), 'bottom');
});

test('resolveRoofHighSide: 屋内に接する長さが最大の辺', () => {
  assert.equal(resolveRoofHighSide(null, rect(0, 0, 5000, 3000), adj(0, 2000, 4500, 1000)), 'left');
  assert.equal(resolveRoofHighSide(null, rect(0, 0, 5000, 3000), adj(0, 0, 0, 3000)), 'right');
});

test('resolveRoofHighSide: 同長は top→bottom→left→right の順', () => {
  assert.equal(resolveRoofHighSide(null, rect(0, 0, 5000, 3000), adj(2000, 2000, 2000, 2000)), 'top');
  assert.equal(resolveRoofHighSide(null, rect(0, 0, 5000, 3000), adj(0, 2000, 2000, 2000)), 'bottom');
  assert.equal(resolveRoofHighSide(null, rect(0, 0, 5000, 3000), adj(0, 0, 2000, 2000)), 'left');
  assert.equal(resolveRoofHighSide(null, rect(0, 0, 5000, 3000), adj(100, 2000, 2000, 2000)), 'bottom');
});

test('resolveRoofHighSide: 接していない（全て 0）・主屋根（adjacency=null）は長手に平行な辺の座標が小さい側', () => {
  assert.equal(resolveRoofHighSide(null, rect(0, 0, 5000, 3000), adj(0, 0, 0, 0)), 'top');   // 横長
  assert.equal(resolveRoofHighSide(null, rect(0, 0, 3000, 5000), adj(0, 0, 0, 0)), 'left');  // 縦長
  assert.equal(resolveRoofHighSide(null, rect(0, 0, 3000, 5000), null), 'left');
  assert.equal(resolveRoofHighSide(null, rect(0, 0, 4000, 4000), null), 'top');               // 正方形
});

test('roofHighSideView: 片流れ＋矩形なら visible。明示値が最優先、無ければ下屋は屋内に接する辺・主屋根は長手の小さい側', () => {
  const r = rect(0, 0, 5000, 3000);
  assert.deepEqual(roofHighSideView({ shape: 'mono', highSide: 'right', rect: r, adjacency: adj(9000, 0, 0, 0) }),
    { visible: true, value: 'right' });
  assert.deepEqual(roofHighSideView({ shape: 'mono', highSide: null, rect: r, adjacency: adj(0, 2000, 4500, 1000) }),
    { visible: true, value: 'left' });
  assert.deepEqual(roofHighSideView({ shape: 'mono', highSide: null, rect: rect(0, 0, 3000, 5000), adjacency: null }),
    { visible: true, value: 'left' }, '主屋根・縦長');
  assert.deepEqual(roofHighSideView({ shape: 'mono', highSide: null, rect: r, adjacency: null }),
    { visible: true, value: 'top' }, '主屋根・横長');
  assert.deepEqual(roofHighSideView({ shape: 'mono', highSide: null, rect: rect(0, 0, 4000, 4000), adjacency: null }),
    { visible: true, value: 'top' }, '正方形');
});

test('【失敗系】roofHighSideView: 片流れ以外は非表示（明示値があっても）。矩形でない片流れも非表示', () => {
  const r = rect(0, 0, 5000, 3000);
  for (const shape of ['gable', 'hip', 'staggered', 'flat', null, undefined]) {
    assert.deepEqual(roofHighSideView({ shape, highSide: 'top', rect: r, adjacency: null }), { visible: false, value: null }, String(shape));
  }
  assert.deepEqual(roofHighSideView({ shape: 'mono', highSide: 'top', rect: null, adjacency: null }), { visible: false, value: null });
  assert.deepEqual(roofHighSideView({ shape: 'mono', highSide: null, rect: null, adjacency: adj(1, 2, 3, 4) }), { visible: false, value: null });
});

test('resolveRoofRidgeIsVertical: 未設定は長手（縦長なら縦・横長なら横・正方形は横）。縦・横の指定が最優先', () => {
  assert.equal(resolveRoofRidgeIsVertical(null, rect(0, 0, 3000, 5000), 0), true, '縦長・自動');
  assert.equal(resolveRoofRidgeIsVertical(null, rect(0, 0, 5000, 3000), 0), false, '横長・自動');
  assert.equal(resolveRoofRidgeIsVertical(null, rect(0, 0, 4000, 4000), 0), false, '正方形・自動');
  assert.equal(resolveRoofRidgeIsVertical(null, rect(0, 0, 4000, 4050), 100), false, '許容差内は正方形');
  assert.equal(resolveRoofRidgeIsVertical('horizontal', rect(0, 0, 3000, 5000), 0), false, '縦長でも横を指定');
  assert.equal(resolveRoofRidgeIsVertical('vertical', rect(0, 0, 5000, 3000), 0), true, '横長でも縦を指定');
  assert.equal(resolveRoofRidgeIsVertical('vertical', rect(0, 0, 4000, 4000), 0), true, '正方形でも縦を指定');
});

test('【失敗系】resolveRoofRidgeIsVertical: 不正値（未知の文字列・大文字違い・highSide の値・数値）は未指定扱い（長手）', () => {
  for (const bad of ['diagonal', 'VERTICAL', 'top', '', 1, {}, undefined]) {
    assert.equal(resolveRoofRidgeIsVertical(bad, rect(0, 0, 3000, 5000), 0), true, `縦長 ${JSON.stringify(bad)}`);
    assert.equal(resolveRoofRidgeIsVertical(bad, rect(0, 0, 5000, 3000), 0), false, `横長 ${JSON.stringify(bad)}`);
  }
});

test('roofRidgeDirectionView: 切妻＋矩形なら visible。値は明示値、未設定（自動）・不正値は null', () => {
  const r = rect(0, 0, 5000, 3000);
  assert.deepEqual(roofRidgeDirectionView({ shape: 'gable', ridgeDirection: null, rect: r }), { visible: true, value: null });
  assert.deepEqual(roofRidgeDirectionView({ shape: 'gable', ridgeDirection: 'vertical', rect: r }), { visible: true, value: 'vertical' });
  assert.deepEqual(roofRidgeDirectionView({ shape: 'gable', ridgeDirection: 'horizontal', rect: r }), { visible: true, value: 'horizontal' });
  assert.deepEqual(roofRidgeDirectionView({ shape: 'gable', ridgeDirection: 'diagonal', rect: r }), { visible: true, value: null }, '不正値は自動表示');
});

test('【失敗系】roofRidgeDirectionView: 切妻以外は非表示（明示値があっても）。矩形でない切妻も非表示', () => {
  const r = rect(0, 0, 5000, 3000);
  for (const shape of ['mono', 'hip', 'staggered', 'flat', null, undefined]) {
    assert.deepEqual(roofRidgeDirectionView({ shape, ridgeDirection: 'vertical', rect: r }), { visible: false, value: null }, String(shape));
  }
  assert.deepEqual(roofRidgeDirectionView({ shape: 'gable', ridgeDirection: 'vertical', rect: null }), { visible: false, value: null });
});

test('【失敗系】resolveRoofHighSide: 不正な明示値は未指定扱い。rect も接触も無ければ null', () => {
  assert.equal(resolveRoofHighSide('up', rect(0, 0, 3000, 5000), null), 'left');
  assert.equal(resolveRoofHighSide('', rect(0, 0, 5000, 3000), adj(0, 0, 1500, 0)), 'left');
  assert.equal(resolveRoofHighSide(null, null, null), null);
  assert.equal(resolveRoofHighSide(null, null, adj(NaN, -5, 0, 0)), null);
});
