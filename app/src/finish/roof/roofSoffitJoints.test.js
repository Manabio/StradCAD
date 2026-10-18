// roofSoffitJoints.js（軒裏の910割付線）の単体テスト。edges は roofFramingRegions.js withOutline が返す形を手で組む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roofSoffitJointLines, SOFFIT_JOINT_PITCH_MM } from './roofSoffitJoints.js';

const edge = (over = {}) => ({ isVertical: false, coord: 0, lo: 0, hi: 3000, outward: -1, overhangMm: 455, ...over });
const pts = lines => lines.map(l => l.points);

test('水平の辺（北向き outward=-1）: lo から 910 ピッチで辺に直交（縦）の線を出幅ぶん。両端は引かない', () => {
  const lines = roofSoffitJointLines({ edges: [edge()] });
  assert.deepEqual(pts(lines), [[910, 0, 910, -455], [1820, 0, 1820, -455], [2730, 0, 2730, -455]]);
  assert.ok(lines.every(l => l.role === 'eaveSoffitJoint' && l.closed === false));
});

test('水平の辺（南向き outward=+1）は y が増える側へ出る', () => {
  assert.deepEqual(pts(roofSoffitJointLines({ edges: [edge({ coord: 4500, outward: 1 })] })).slice(0, 1), [[910, 4500, 910, 4955]]);
});

test('垂直の辺: 辺に直交（横）の線。lo は y 方向の始点', () => {
  const lines = roofSoffitJointLines({ edges: [edge({ isVertical: true, coord: 6000, lo: 1500, hi: 4000, outward: 1 })] });
  assert.deepEqual(pts(lines), [[6000, 2410, 6455, 2410], [6000, 3320, 6455, 3320]]);
});

test('辺の端の tol 内（ちょうど 910 の倍数の端）は引かない', () => {
  assert.equal(roofSoffitJointLines({ edges: [edge({ hi: 1820 })] }).length, 1, 'hi=1820: 910 のみ');
  assert.equal(roofSoffitJointLines({ edges: [edge({ hi: 1820.3 })] }).length, 1, 'hi から tol(0.5) 内の 1820 は引かない');
  assert.equal(roofSoffitJointLines({ edges: [edge({ hi: 1821 })] }).length, 2, 'tol 外なら引く');
  assert.equal(roofSoffitJointLines({ edges: [edge({ hi: 910 })] }).length, 0);
});

test('出幅 0（屋内に接する部分）の辺には引かない', () => {
  assert.deepEqual(roofSoffitJointLines({ edges: [edge({ overhangMm: 0 }), edge({ overhangMm: 0.4 })] }), []);
});

test('出隅の角の正方形（辺の範囲の外）には引かない: 全ての線の位置は (lo, hi) の内側', () => {
  const lines = roofSoffitJointLines({ edges: [edge({ lo: 500, hi: 3500 })] });
  assert.ok(lines.every(l => l.points[0] > 500 && l.points[0] < 3500));
  assert.deepEqual(lines.map(l => l.points[0]), [1410, 2320, 3230]);
});

test('ピッチを変えられる（既定は 910）', () => {
  assert.equal(SOFFIT_JOINT_PITCH_MM, 910);
  assert.deepEqual(roofSoffitJointLines({ edges: [edge()] }, { pitchMm: 1000 }).map(l => l.points[0]), [1000, 2000]);
});

test('【失敗系】edges が無い・空・不正（非有限・outward 不正）・ピッチ不正は []（例外にしない）', () => {
  assert.deepEqual(roofSoffitJointLines(null), []);
  assert.deepEqual(roofSoffitJointLines({}), []);
  assert.deepEqual(roofSoffitJointLines({ edges: [] }), []);
  assert.deepEqual(roofSoffitJointLines({ edges: [edge({ lo: NaN }), edge({ hi: Infinity }), edge({ overhangMm: NaN }), edge({ outward: 0 }), null] }), []);
  assert.deepEqual(roofSoffitJointLines({ edges: [edge()] }, { pitchMm: 0 }), []);
  assert.deepEqual(roofSoffitJointLines({ edges: [edge()] }, { pitchMm: -910 }), []);
});
