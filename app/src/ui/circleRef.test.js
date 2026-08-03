import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '../core.js';
import { CIRCLE_NUMS, circleRefSymbol, circleRefKindLabel } from './circleRef.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

test('circleRefSymbol: CIRCLE_NUMSの範囲内はUnicode丸数字、超えたら "(n)" にフォールバック', () => {
  assert.equal(circleRefSymbol(0), '①');
  assert.equal(circleRefSymbol(9), CIRCLE_NUMS[9]);
  assert.equal(circleRefSymbol(10), '(11)');
});

test('circleRefKindLabel: 梁芯CL（centerLineKind===beam）は「梁芯」と表記される', () => {
  const graph = makeGraph();
  const beamCL = graph.addCenterLine(CenterLineType.VERTICAL, 2000, {
    labeled: false, discipline: Discipline.FUSE,
  });
  assert.equal(circleRefKindLabel(beamCL), '梁芯');
});

test('circleRefKindLabel: 通常の中心線（discipline:arch等）は従来通り「中心線」と表記される', () => {
  const graph = makeGraph();
  const centerCL = graph.addCenterLine(CenterLineType.VERTICAL, 2000, {
    labeled: false, discipline: Discipline.ARCH,
  });
  assert.equal(circleRefKindLabel(centerCL), '中心線');
});

test('circleRefKindLabel: labelを持つCL（通り芯等）はkindに関わらずそのlabelをそのまま返す', () => {
  const graph = makeGraph();
  const gridCL = graph.addCenterLine(CenterLineType.VERTICAL, 0, {
    labeled: true, discipline: Discipline.STRUCT,
  });
  assert.equal(circleRefKindLabel(gridCL), gridCL.label);
  assert.notEqual(gridCL.label, '');
});

test('circleRefKindLabel: 柱芯参照のような合成オブジェクト（discipline/lineTypeを持たない）でも安全にlabelを返す', () => {
  const synthetic = { id: 'colaxis:x1', clId: 'x1', value: 100, axisOffset: 50, label: 'X1柱芯' };
  assert.equal(circleRefKindLabel(synthetic), 'X1柱芯');
});

test('circleRefKindLabel: 補助線（lineType:dashed）は従来通り「中心線」と表記される（「補助線」にはしない）', () => {
  const graph = makeGraph();
  const auxCL = graph.addCenterLine(CenterLineType.VERTICAL, 2000, {
    labeled: false, lineType: 'dashed',
  });
  assert.equal(circleRefKindLabel(auxCL), '中心線');
});
