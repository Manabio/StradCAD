import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from './core.js';
import { serializeGraph, restoreGraph } from './graphSnapshot.js';

// wallBeamAxes.test.js と同じ方針: ダックタイピングでは effectiveValue 等の実挙動を
// 再現できないため、実 core.js（Plane/PlanGraph）を使う。

function makeGraph(planeId = 'p1', elevation = 0) {
  const plane = new Plane(planeId, elevation, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

// 水平に走る外壁1本 + 引き違い窓1件を持つグラフを作る。
function makeGraphWithWindow(openingProps) {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });
  const o = graph.addOpening(axisCL, 1, false, clStart, 1000, 1690, OpeningCategory.WINDOW, 'doubleSliding', openingProps);
  return { graph, opening: o };
}

test('Opening.fixtureType/sillHeight は FlatBuffers encode→decode で往復する', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2, '復元後に同一IDの開口が存在する');
  assert.equal(o2.fixtureType, 'AW');
  assert.equal(o2.sillHeight, 800);
});

test('Opening.fixtureType/sillHeight 未設定（null）は encode→decode 後も null のまま（既定値に化けない）', () => {
  const { graph, opening } = makeGraphWithWindow({});

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.fixtureType, null);
  assert.equal(o2.sillHeight, null);
});

test('Opening.fixtureType: JW も往復する', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'JW', sillHeight: 0 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.equal(o2.fixtureType, 'JW');
  assert.equal(o2.sillHeight, 0, '0mm（掃き出し窓相当）は null と区別されて保持される');
});

// ---- 失敗系: 未知の fixtureType（想定外値・データ破損等）----
test('Opening.fixtureType: 未知の値("XX")は encode→decode で例外にならずnullへフォールバックし、他フィールドは無傷', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'XX', sillHeight: 950 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  assert.doesNotThrow(() => restoreGraph(restored, bytes));

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.fixtureType, null, '未知のenum値はFIXTURE_TYPE_ENCに無いため0(なし)相当でエンコードされ、復元時null');
  assert.equal(o2.sillHeight, 950, 'fixtureTypeが無効でも他フィールドは無傷');
  assert.equal(o2.width, 1690);
  assert.equal(o2.subType, 'doubleSliding');
  assert.equal(o2.category, OpeningCategory.WINDOW);
});

// ---- Opening削除→undo相当の復元（App.jsx handleMenuSelect 'opening-del' と同じ操作パターン）----
test('Opening削除→undo相当: removeShape後にaddOpening(同id, {fixtureType, sillHeight})で両フィールドが復元される', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 700 });
  const before = {
    fixtureType: opening.fixtureType, sillHeight: opening.sillHeight,
    axisCL: opening.axisCL, wallSide: opening.wallSide, isVertical: opening.isVertical,
    refCL: opening.refCL, refOffset: opening.refOffset, width: opening.width,
    category: opening.category, subType: opening.subType,
    hingeSide: opening.hingeSide, swingSide: opening.swingSide,
  };

  graph.removeShape(opening.id);
  assert.equal(graph.shapeMap.has(opening.id), false, '削除直後は存在しない');

  // App.jsx の undo（opening-del）と同一パターン: 同一IDで addOpening し直す
  const restored = graph.addOpening(
    before.axisCL, before.wallSide, before.isVertical, before.refCL, before.refOffset, before.width,
    before.category, before.subType,
    { hingeSide: before.hingeSide, swingSide: before.swingSide, fixtureType: before.fixtureType, sillHeight: before.sillHeight },
    opening.id,
  );

  assert.equal(restored.id, opening.id);
  assert.equal(restored.fixtureType, 'AW');
  assert.equal(restored.sillHeight, 700);
});

// ---- Opening.height の FlatBuffers 往復（Finding 4 回帰） ----
test('Opening.height は FlatBuffers encode→decode で往復する', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800, height: 1170 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.height, 1170);
});

test('Opening.height 未設定（null）は encode→decode 後も null のまま（既定値に化けない）', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800 });
  assert.equal(opening.height, null, '未指定時はnullが既定');

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.height, null);
});

// ---- Finding 3 の決定を明文化: height=0 は不正値としてnullに正規化される ----
test('Opening.height=0 は不正値として encode→decode 後は null に正規化される（sillHeightの0(掃き出し窓)とは異なる規約）', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800, height: 0 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.height, null, 'graphFbs.js の OP.HEIGHT は「0=未設定」規約（r.f64(OP.HEIGHT) || null）。' +
    'sillHeightの0（掃き出し窓）とは異なり、heightの0は物理的に無効な値のため常にnullへ丸められる');
});
