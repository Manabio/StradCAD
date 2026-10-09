// 折返し・回り階段の出入口の辺（Stair.entrySide / arrivalSide。StairPortSide＝end|left|right）の本番経路テスト。
// left/right はその口を歩くときの進行方向から見た向き（flip 非依存）。既定（null）は張り出すレーンなら
// 隣レーン側（設置階上階スラブの張り出しに横から取りつく。ユーザー裁定 2026-09-29）。
// フィクスチャは 2列×3行のセル格子（y下向き正）:  d c / a b / e f
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StairPortSide, StructuralMaterialType } from '@core';
import { classifyStairArea, measureStairSpans } from './stairClassify.js';
import { stairPortEdges, buildStairGeometry, laneGapMmFor, insetStairBounds, resolveUTurnPorts, stairSegmentDims, cellsBeyondBreak } from './stairGeometry.js';
import { portSideChange, resetPortSides, alignPortTurnSteps } from './stairSectionEdit.js';
import { roomBounds } from '../gridCells.js';
import { PARTITION_BACKING_MM, PARTITION_THICKNESS_MM } from './stairPartition.js';
import { generateStairPartitionWalls } from './stairPartitionWalls.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../structural/structureRules.js';
import { serializeGraph, restoreGraph } from '../../graphSnapshot.js';

function layout() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), x1 = V(1000), x2 = V(2000), y0 = H(0), y1 = H(1000), y2 = H(2000), y3 = H(3000);
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  return {
    graph,
    c: { d: k(x0, y0, x1, y1), c: k(x1, y0, x2, y1), a: k(x0, y1, x1, y2), b: k(x1, y1, x2, y2), e: k(x0, y2, x1, y3), f: k(x1, y2, x2, y3) },
  };
}
function addByOrder(graph, c, order, extra = {}) {
  const keys = order.map(n => c[n]);
  const cells = new Set(keys);
  const cls = classifyStairArea(cells, graph, 2800, keys);
  // applyNaming（FinishModeState）と同じ受け渡し: 取りつき回転部の蹴上数も Stair へ
  return graph.addStair({
    type: cls.type, cells, upDirection: cls.upDirection, flip: cls.flip, sections: cls.sections,
    entryTurnSteps: cls.entryTurnSteps ?? 0, arrivalTurnSteps: cls.arrivalTurnSteps ?? 0, ...extra,
  });
}
const edge = (stair, graph, port) => stairPortEdges(stair, graph, [port]);
// 描画幾何は設置枠を壁厚ぶん inset するため、レーン中心・基端の座標はセル境界から数十 mm ずれる
const near = (actual, expected, tol = 60) =>
  assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= tol), `${JSON.stringify(actual)} ≈ ${JSON.stringify(expected)}`);
const geom = (stair, graph, view) => buildStairGeometry(stair, roomBounds(stair.cells, graph), {
  view, detail: true, riser: 200, spans: measureStairSpans(stair, graph), laneGap: false,
});

test('往路が長い f,b,c,d,a: 上り口の既定は内側＝f の左辺（e 側）。到達口は a の下辺のまま', () => {
  const { graph, c } = layout();
  const stair = addByOrder(graph, c, ['f', 'b', 'c', 'd', 'a']);
  assert.equal(stair.entrySide, null, '保存値は null＝自動');
  assert.deepEqual(edge(stair, graph, 'entry'),   [{ isVertical: true, value: 1000, lo: 2000, hi: 3000 }]);
  assert.deepEqual(edge(stair, graph, 'arrival'), [{ isVertical: false, value: 2000, lo: 0, hi: 1000 }]);
  // 矢印（U）は f の左辺の中点 (1000, 2500) から横向きに入る
  const arrow = geom(stair, graph, 'install').arrows[0];
  // 上り口が側面なので install でも基端は壁表面（y=3000−57.5）で止まり、辺の中点は 2500 より 28.75 mm 内側
  assert.equal(arrow.x1, 1000);
  assert.ok(Math.abs(arrow.y1 - 2500) <= 60, `${arrow.y1}`);
  near(arrow.points.slice(0, 4), [1000, 2500, 1500, 2500]);
  // f の下辺（走行端）は出入口ではなく側面線になる
  const bottom = geom(stair, graph, 'upper').outline.find(s => Math.abs(s.y1 - s.y2) < 1e-9 && Math.abs(s.y1 - 3000) < 60);
  assert.ok(bottom && bottom.side && !bottom.port, JSON.stringify(bottom));
});

// 内側の出入口辺と矢印の始点は、通り芯(0.5)ではなく隔て板（あき）の帯の向こう側の面（1段目の段板を隔て板側の柱で支える。2026-10-09 ユーザー指摘 moku1-6）
const gapGeom = (stair, graph, view) => buildStairGeometry(stair, roomBounds(stair.cells, graph), {
  view, detail: true, riser: 200, spans: measureStairSpans(stair, graph), laneGap: true, graph,
});
const portSegs = (g, port) => g.outline.filter(s => s.port === port);

test('あきがあるとき内側の上り口は、辺も矢印の始点（U の丸）も帯の向こう側の面（在来＋隔て壁 115 → 中心から 57.5、鉄骨 100 → 50）', () => {
  for (const [label, setup, half] of [
    ['在来＋隔て壁', (graph, stair) => { graph.setStructureOverride('木造（在来）'); stair.structure = StructuralMaterialType.WOOD; }, 57.5],
    ['鉄骨', (graph, stair) => { stair.structure = StructuralMaterialType.STEEL; }, 50],
  ]) {
    const { graph, c } = layout();
    const stair = addByOrder(graph, c, ['f', 'b', 'c', 'd', 'a']);
    setup(graph, stair);
    assert.equal(laneGapMmFor(stair, graph), half * 2, label);
    const g = gapGeom(stair, graph, 'install');
    const segs = portSegs(g, 'entry');
    assert.ok(segs.length > 0, label);
    for (const s of segs) {
      assert.ok(Math.abs(s.x1 - (1000 - half)) < 1e-6 && Math.abs(s.x2 - (1000 - half)) < 1e-6, `${label}: 上り口の辺は帯の向こう側の面 x=${1000 - half}: ${JSON.stringify(s)}`);
    }
    assert.ok(Math.abs(g.arrows[0].x1 - (1000 - half)) < 1e-6, `${label}: 矢印の始点 ${g.arrows[0].x1}`);
    assert.ok(g.arrows[0].labelX < g.arrows[0].x1, `${label}: ラベルは辺の外側（西）`);
  }
});

test('折返し階段（SWITCHBACK）でも、あきがあると内側の上り口の辺と U の丸は帯の向こう側の面（sB）。buildSwitchback のアンカーを守る', () => {
  // 全幅の踊り場 cd（SWITCHBACK）＋往路 b,bf（bf が往路だけの張り出し）＋復路 a。上り口は bf の左辺（内側）
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), x1 = V(1000), x2 = V(2000), y0 = H(0), y1 = H(1000), y2 = H(2000), y3 = H(3000);
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  const c = { cd: k(x0, y0, x2, y1), a: k(x0, y1, x1, y2), b: k(x1, y1, x2, y2), bf: k(x1, y2, x2, y3) };
  const stair = addByOrder(graph, c, ['bf', 'b', 'cd', 'a']);
  graph.setStructureOverride('木造（在来）');
  stair.structure = StructuralMaterialType.WOOD;
  assert.equal(stair.type, StairType.SWITCHBACK);
  assert.equal(laneGapMmFor(stair, graph), 115);
  const g = gapGeom(stair, graph, 'install');
  const segs = portSegs(g, 'entry');
  assert.ok(segs.length > 0, JSON.stringify(g.outline));
  for (const s of segs) assert.ok(Math.abs(s.x1 - 942.5) < 1e-6 && Math.abs(s.x2 - 942.5) < 1e-6, JSON.stringify(s));
  assert.ok(Math.abs(g.arrows[0].x1 - 942.5) < 1e-6, `${g.arrows[0].x1}`);
});

// ---- 段板は端部の柱の角にそのまま取りつく（2026-10-09 ユーザー裁定の角の対応表。逃がさない）----
// 柱は PB で包まれていれば PB の外面（通り芯±57.5）、包まれていなければ柱材の面（±45）。1＝上り口側・往路側、
// 2＝回転部側・往路側、3＝回転部側・復路側、4＝上り口側・復路側（回転部側の柱が P1〜P4、入口柱が Q1〜Q4）。
//   1|2 の段鼻 ＝ 入口柱の上り口側の面（Q1 の y）
//   復路の到達辺（15|16。2026-10-09 裁定で確定）＝ 入口柱の回転部側の面（Q3 の y）。最終段の段板は柱に当たって止まる
//   5|6（往路側の前縁）＝ 回転部側の柱の上り口側の面（P1・P4 の y）。往路側の放射線 5|6〜7|8 の起点 ＝ P1
//   11|12（復路側の前縁）＝ 回転部側の柱の回転部側の面（P2・P3 の y）。復路側の放射線 8|9〜10|11 の起点 ＝ P2
const H = PARTITION_BACKING_MM / 2; // 柱材の半幅 45
const woodStair = (graph, stair) => { graph.setStructureOverride('木造（在来）'); stair.structure = StructuralMaterialType.WOOD; };
const horiz = (t) => Math.abs(t.y1 - t.y2) < 1e-9;
const ptEq = (p, x, y) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6;
// 隔て壁（オーナー壁＋薄壁）を足し、両端の自由端を柱包み（wrapStairPartitionFreeEnds と同じ物理端のはね出し ±57.5）にする
const addPartitionWalls = (graph) => {
  for (const w of generateStairPartitionWalls(graph, { structure: TRADITIONAL_WOOD_STRUCTURE })) {
    const sign = Math.sign(w.clEnd.effectiveValue - w.clStart.effectiveValue) || 1;
    w.startOffset = -sign * 57.5;
    w.endOffset = sign * 57.5;
  }
};
// [名前, 柱の半幅, 壁の追加]。壁が無い graph は柱材の面（半幅 45）、PB 包みの壁があれば PB の外面（半幅 57.5）
const VARIANTS = [['柱材の面（壁なし）', H, () => {}], ['PB の外面（包み壁あり）', PARTITION_THICKNESS_MM / 2, addPartitionWalls]];

test('隔て壁あり・張り出し（f,b,c,d,a）: 1|2 の段鼻と到達辺は入口柱の上り口側の面（Q）、往路側の前縁は P1・復路側の前縁は P2 の面。往路・復路の踏面は柱の面の間を等分', () => {
  for (const [name, half, setup] of VARIANTS) {
    for (const entryTurnSteps of [4, 1, 0]) {
      const tag = `${name} e=${entryTurnSteps}`;
      const { graph, c } = layout();
      const stair = addByOrder(graph, c, ['f', 'b', 'c', 'd', 'a'], { entryTurnSteps });
      woodStair(graph, stair);
      setup(graph);
      const yQ = 2000 + half, yQ3 = 2000 - half, yPA = 1000 + half, yPB = 1000 - half; // 通り芯 y=2000（入口柱）・1000（回転部側の柱）。上り口は南（y が大きい側）
      const g = gapGeom(stair, graph, 'upper');
      // 往路（x>1000）: Q の面 yQ から P1 の面 yPA まで等分
      const laneA = g.treads.filter(t => horiz(t) && Math.min(t.x1, t.x2) > 1000).map(t => t.y1).sort((p, q) => q - p);
      assert.equal(laneA[0], yQ, `${tag}: 1|2 の段鼻（往路初段線）＝Q の面`);
      assert.equal(laneA[laneA.length - 1], yPA, `${tag}: 往路側の前縁＝P1 の面`);
      const pitchA = (yQ - yPA) / (laneA.length - 1);
      laneA.forEach((y, i) => assert.ok(Math.abs(y - (yQ - i * pitchA)) < 1e-6, `${tag}: 往路の等分 ${laneA}`));
      // 復路（x<1000）: P3 の面 yPB（11|12）から到達辺 yQ3 まで等分（往路と同じ長さ・同ピッチ）
      const laneB = g.treads.filter(t => horiz(t) && Math.max(t.x1, t.x2) < 1000).map(t => t.y1).sort((p, q) => p - q);
      assert.ok(Math.abs(laneB[0] - yPB) < 1e-6, `${tag}: 復路側の前縁（11|12）＝P2・P3 の面 ${laneB[0]}`);
      const pitchB = (yQ3 - yPB) / laneB.length;
      laneB.forEach((y, i) => assert.ok(Math.abs(y - (yPB + i * pitchB)) < 1e-6, `${tag}: 復路の等分 ${laneB}`));
      assert.ok(Math.abs((yQ3 - yPB) - (yQ - yPA)) < 1e-6, `${tag}: 復路の区間長＝往路の区間長（P3 面〜Q3 面＝Q1 面〜P1 面）`);
      // 到達辺（15|16）は Q3 の y。隔て板の仕上げ面（x=942.5）から壁仕上げ面まで
      const arrival = portSegs(g, 'arrival');
      assert.ok(arrival.length > 0 && arrival.every(s => Math.abs(s.y1 - yQ3) < 1e-6 && Math.abs(s.y2 - yQ3) < 1e-6 && Math.abs(Math.max(s.x1, s.x2) - 942.5) < 1e-6), `${tag}: ${JSON.stringify(arrival)}`);
      // 出入口の辺 x=942.5 は基端（壁面 2942.5）から Q の面まで（区画 1 段目の出口）
      const entry = portSegs(g, 'entry');
      assert.ok(entry.length > 0 && entry.every(s => Math.abs(s.x1 - 942.5) < 1e-6 && Math.abs(Math.min(s.y1, s.y2) - yQ) < 1e-6 && Math.abs(Math.max(s.y1, s.y2) - 2942.5) < 1e-6), `${tag}: ${JSON.stringify(entry)}`);
      // 扇形（e≥2）の pivot ＝ 出入口の辺×出口境界（x=942.5, yQ）。e=1 は全幅の平場で放射線なし
      const radial = g.treads.filter(t => !horiz(t) && Math.max(t.y1, t.y2) > yQ - 1e-9);
      assert.equal(radial.length, Math.max(0, entryTurnSteps - 1), `${tag}: 放射線`);
      for (const t of radial) assert.ok(ptEq({ x: t.x1, y: t.y1 }, 942.5, yQ) || ptEq({ x: t.x2, y: t.y2 }, 942.5, yQ), `${tag}: ${JSON.stringify(t)}`);
    }
  }
});

test('隔て壁あり: 寸法鎖が柱の面で切れる（取付 2942.5→Q1 / 往路 Q1→P1 / 復路 Q3→P3）。graph を渡さなければ従来の積み方', () => {
  for (const [name, half, setup] of VARIANTS) {
    const { graph, c } = layout();
    const stair = addByOrder(graph, c, ['f', 'b', 'c', 'd', 'a']);
    woodStair(graph, stair);
    setup(graph);
    const b = roomBounds(stair.cells, graph);
    const spans = measureStairSpans(stair, graph);
    const bi = insetStairBounds(stair, b, 'upper', graph, spans);
    const dims = stairSegmentDims(stair, bi, 300, spans, graph);
    const by = (re) => dims.find(d => re.test(d.label));
    const span = (d) => [d.from, d.to].map(v => Math.round(v * 1e6) / 1e6);
    const yQ = 2000 + half, yQ3 = 2000 - half, yPA = 1000 + half, yPB = 1000 - half;
    assert.deepEqual(span(by(/^取付/)), [2942.5, yQ], name);
    assert.deepEqual(span(by(/^往路/)), [yQ, yPA], name);
    assert.deepEqual(span(by(/^復路/)), [yQ3, yPB], name);
    const plain = stairSegmentDims(stair, bi, 300, spans);
    assert.notDeepEqual(span(plain.find(d => /^往路/.test(d.label))), [yQ, yPA], `${name}: graph なしは柱に合わせない`);
  }
});

test('隔て壁あり・等長レーン（走行端の上り口）: 前縁だけが回転部側の柱の面へ動き（往路側＝P1、復路側＝P2）、基端（上り口辺・到達辺）は動かない（Q 側は不変）', () => {
  for (const [name, half, setup] of VARIANTS) {
    const { graph, c } = equalRowsLayout();
    const stair = addByOrder(graph, c, ['b2', 'b1', 'c', 'd', 'a1', 'a2']);
    woodStair(graph, stair);
    setup(graph);
    const g = gapGeom(stair, graph, 'upper');
    const runLine = g.treads.filter(t => horiz(t) && Math.min(t.x1, t.x2) > 1000).map(t => t.y1).sort((p, q) => p - q);
    assert.equal(runLine[0], 1000 + half, `${name}: 往路側の前縁＝P1 の面`);
    const backLine = g.treads.filter(t => horiz(t) && Math.max(t.x1, t.x2) < 1000).map(t => t.y1).sort((p, q) => p - q);
    assert.ok(Math.abs(backLine[0] - (1000 - half)) < 1e-6, `${name}: 復路側の前縁＝P2・P3 の面 ${backLine[0]}`);
    for (const port of ['entry', 'arrival']) {
      const segs = portSegs(g, port);
      assert.ok(segs.length > 0 && segs.every(s => s.y1 === 2942.5 && s.y2 === 2942.5), `${name}: ${port} は基端の壁面のまま: ${JSON.stringify(segs)}`);
    }
  }
});

test('隔て壁あり・回り階段: 往路側半分の放射線は P1（柱の上り口側の面×往路側の面）、復路側半分（中央を含む）は P2（回転部側の面×往路側の面）から出る', () => {
  for (const [name, half, setup] of VARIANTS) {
    const { graph, c } = equalRowsLayout();
    const stair = addByOrder(graph, c, ['b2', 'b1', 'c', 'd', 'a1', 'a2']);
    woodStair(graph, stair);
    setup(graph);
    stair.setField('type', StairType.WINDING);
    stair.setField('sections', [6, 4, 6]);
    assert.equal(stair.flip, true, '前提: 往路は右列（x>1000）');
    const g = gapGeom(stair, graph, 'upper');
    const radial = g.treads.filter(t => !horiz(t));
    const startsAt = (y) => radial.filter(t => Math.abs(t.y1 - y) < 1e-6 || Math.abs(t.y2 - y) < 1e-6)
      .map(t => (Math.abs(t.y1 - y) < 1e-6 ? t.x1 : t.x2));
    // 放射線 3 本（4 マス: u=1/4・1/2・3/4）。u=1/4 は P1（x=1000+half, y=1000+half）、u=1/2・3/4 は P2（x=1000+half, y=1000-half）
    assert.deepEqual(startsAt(1000 + half), [1000 + half], `${name}: 往路側の放射線の起点 P1`);
    assert.deepEqual(startsAt(1000 - half), [1000 + half, 1000 + half], `${name}: 復路側の放射線の起点 P2`);
    // 起点と向こう端を組で見る: 往路側の側面（x>起点の x）へ向かう線は P1 から、復路側（x<起点の x）へ向かう線と
    // 奥へ垂直な線（u=0.5）は P2 から出る（P1・P2 は x が同じなので、起点の y と向こう端の組でしか入替えは分からない）
    const px = 1000 + half;
    assert.equal(radial.length, 3, name);
    for (const t of radial) {
      const [p, far] = Math.abs(t.x1 - px) < 1e-6 && (Math.abs(t.y1 - (1000 + half)) < 1e-6 || Math.abs(t.y1 - (1000 - half)) < 1e-6)
        ? [{ x: t.x1, y: t.y1 }, { x: t.x2, y: t.y2 }] : [{ x: t.x2, y: t.y2 }, { x: t.x1, y: t.y1 }];
      const expectY = far.x > px + 1e-6 ? 1000 + half : 1000 - half;
      assert.ok(Math.abs(p.y - expectY) < 1e-6, `${name}: 向こう端 ${JSON.stringify(far)} の線の起点は y=${expectY}（実際 ${p.y}）`);
    }
  }
});

test('【失敗系】隔て壁が立たない（鉄骨のあき 100・簡略 laneGap:false・在来以外の建物・OPEN_WELL）なら従来の積み方のまま', () => {
  // 鉄骨の階段（建物は在来）: 踊り場前縁は枠の積み方（y=942.5）
  const { graph, c } = layout();
  const steel = addByOrder(graph, c, ['f', 'b', 'c', 'd', 'a']);
  graph.setStructureOverride('木造（在来）');
  steel.structure = StructuralMaterialType.STEEL;
  const frontOf = (g) => g.treads.filter(t => horiz(t) && Math.min(t.x1, t.x2) > 1000).map(t => t.y1).sort((p, q) => p - q)[0];
  assert.equal(laneGapMmFor(steel, graph), 100);
  assert.ok(Math.abs(frontOf(gapGeom(steel, graph, 'upper')) - 1000) < 60, `鉄骨: ${frontOf(gapGeom(steel, graph, 'upper'))}`);
  assert.notEqual(frontOf(gapGeom(steel, graph, 'upper')), 1000 + H);
  // 木造の階段でも簡略 LOD（laneGap:false）は隔て壁なし扱い
  const wood = addByOrder(layout().graph, layout().c, ['f', 'b', 'c', 'd', 'a']);
  const l2 = layout(); const w2 = addByOrder(l2.graph, l2.c, ['f', 'b', 'c', 'd', 'a']);
  woodStair(l2.graph, w2);
  assert.equal(frontOf(geom(w2, l2.graph, 'upper')), frontOf(buildStairGeometry(w2, roomBounds(w2.cells, l2.graph), { view: 'upper', detail: true, riser: 200, spans: measureStairSpans(w2, l2.graph), laneGap: false, graph: l2.graph })));
  assert.notEqual(frontOf(geom(w2, l2.graph, 'upper')), 1000 + H);
  // 在来以外の建物（隔て壁なし）の木造の階段
  const l3 = layout(); const w3 = addByOrder(l3.graph, l3.c, ['f', 'b', 'c', 'd', 'a']);
  l3.graph.setStructureOverride('S造'); w3.structure = StructuralMaterialType.WOOD;
  assert.equal(laneGapMmFor(w3, l3.graph), 0);
  assert.notEqual(frontOf(gapGeom(w3, l3.graph, 'upper')), 1000 + H);
  assert.ok(wood);
  // OPEN_WELL は隔て壁の対象型でない: 建物の構造に依らず同じ幾何
  const open = (structure) => {
    const og = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
    const V = (v) => og.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
    const Hh = (v) => og.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
    const xs = [0, 1000, 2000, 3000].map(V), ys = [0, 1000, 2000, 3000].map(Hh);
    const keys = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) keys.push(`${xs[i].id}:${ys[j].id}:${xs[i + 1].id}:${ys[j + 1].id}`);
    const s = og.addStair({ type: StairType.OPEN_WELL, cells: new Set(keys), upDirection: 'right', flip: false, sections: [4, 1, 4, 1, 4] });
    og.setStructureOverride(structure); s.structure = StructuralMaterialType.WOOD;
    return JSON.stringify(gapGeom(s, og, 'upper'));
  };
  assert.equal(open('木造（在来）'), open('S造'));
});

test('あきがあるとき内側の到達口の辺と下り矢印の始点は復路レーンの内側端（sB）', () => {
  const { graph, c } = layout();
  const stair = addByOrder(graph, c, ['b', 'c', 'd', 'a', 'e']);
  graph.setStructureOverride('木造（在来）');
  stair.structure = StructuralMaterialType.WOOD;
  const g = gapGeom(stair, graph, 'upper');
  const segs = portSegs(g, 'arrival');
  assert.ok(segs.length > 0);
  for (const s of segs) assert.ok(Math.abs(s.x1 - 942.5) < 1e-6 && Math.abs(s.x2 - 942.5) < 1e-6, JSON.stringify(s));
  assert.ok(Math.abs(g.arrows[0].x1 - 942.5) < 1e-6, `${g.arrows[0].x1}`);
});

test('【失敗系】あき 0（簡略）なら内側の出入口辺・矢印の始点は従来どおり通り芯 x=1000', () => {
  const { graph, c } = layout();
  const stair = addByOrder(graph, c, ['f', 'b', 'c', 'd', 'a']);
  const g = geom(stair, graph, 'install');
  for (const s of portSegs(g, 'entry')) assert.equal(s.x1, 1000);
  assert.equal(g.arrows[0].x1, 1000);
});

test('上り口を「走行端」「右（上りから見て）」へ切り替えると出入口辺が f の下辺（i 側）／右辺へ移る。左は既定（内側）と同じ辺', () => {
  const { graph, c } = layout();
  const stair = addByOrder(graph, c, ['f', 'b', 'c', 'd', 'a']);
  stair.setField('entrySide', StairPortSide.END);
  assert.deepEqual(edge(stair, graph, 'entry'), [{ isVertical: false, value: 3000, lo: 1000, hi: 2000 }]);
  near([geom(stair, graph, 'install').arrows[0].x1, geom(stair, graph, 'install').arrows[0].y1], [1500, 3000]);
  stair.setField('entrySide', StairPortSide.LEFT);
  assert.deepEqual(edge(stair, graph, 'entry'), [{ isVertical: true, value: 1000, lo: 2000, hi: 3000 }], '上り（北向き）の左＝西＝既定の内側と同じ辺');
  stair.setField('entrySide', StairPortSide.RIGHT);
  assert.deepEqual(edge(stair, graph, 'entry'), [{ isVertical: true, value: 2000, lo: 2000, hi: 3000 }]);
  // 外側の出入口では、レーン外側の残り（y 1000〜2000）は側面線のまま
  const rest = geom(stair, graph, 'upper').outline.find(s => s.side && Math.abs(s.x1 - s.x2) < 1e-9
    && Math.abs(s.x1 - 2000) < 60 && Math.abs(Math.min(s.y1, s.y2) - 1000) < 60 && Math.abs(Math.max(s.y1, s.y2) - 2000) < 60);
  assert.ok(rest, JSON.stringify(geom(stair, graph, 'upper').outline.filter(s => s.side)));
});

test('復路が長い b,c,d,a,e: 到達口の既定は内側＝e の右辺（f 側）。上り口は b の下辺。到達番号は辺の外側（f 側）', () => {
  const { graph, c } = layout();
  const stair = addByOrder(graph, c, ['b', 'c', 'd', 'a', 'e']);
  assert.deepEqual(edge(stair, graph, 'arrival'), [{ isVertical: true, value: 1000, lo: 2000, hi: 3000 }]);
  assert.deepEqual(edge(stair, graph, 'entry'),   [{ isVertical: false, value: 2000, lo: 1000, hi: 2000 }]);
  const g = geom(stair, graph, 'upper');
  const arrival = g.stepNumbers.find(n => n.text === String(stair.totalSteps));
  assert.ok(arrival, '到達番号があるはず');
  assert.ok(arrival.x > 1000 && arrival.y > 2000 && arrival.y < 3000, `到達番号は e の右辺の外側（f 側）にあるはず: ${JSON.stringify(arrival)}`);
  near([arrival.clipX, arrival.clipY], [1000, 2500]);
  // 下り矢印（D）は e の右辺の中点から出発
  near([g.arrows[0].x1, g.arrows[0].y1], [1000, 2500]);
  stair.setField('arrivalSide', StairPortSide.END);
  assert.deepEqual(edge(stair, graph, 'arrival'), [{ isVertical: false, value: 3000, lo: 0, hi: 1000 }]);
  // 到達口は逆向き（南向き）に歩く: 左＝東＝既定の内側（e の右辺 x=1000）、右＝西（e の左辺 x=0）
  stair.setField('arrivalSide', StairPortSide.LEFT);
  assert.deepEqual(edge(stair, graph, 'arrival'), [{ isVertical: true, value: 1000, lo: 2000, hi: 3000 }]);
  stair.setField('arrivalSide', StairPortSide.RIGHT);
  assert.deepEqual(edge(stair, graph, 'arrival'), [{ isVertical: true, value: 0, lo: 2000, hi: 3000 }]);
});

test('側面の上り口では張り出し区間 f が取りつき回転部になる: 扇形マス（放射線）で埋まり、直進部の踏面線は b から始まる', () => {
  const { graph, c } = layout();
  const stair = addByOrder(graph, c, ['f', 'b', 'c', 'd', 'a']);
  // 木造の初期値: 張り出し 1000 ÷ 踏面 250 = 4 蹴上。総蹴上数 13 に含まれる
  assert.equal(stair.entryTurnSteps, 4);
  assert.equal(stair.totalSteps, 13);
  const g = geom(stair, graph, 'upper');
  const inF = (p) => p.x > 1000 && p.x < 2000 && p.y > 2000 && p.y < 3000;
  const treadsInF = g.treads.filter(t => inF({ x: (t.x1 + t.x2) / 2, y: (t.y1 + t.y2) / 2 }));
  // f 内の踏面線は放射線 3 本（4 マス）で、すべて pivot（f の左上角 ≒ (1000, 2000)）を共有する
  const radial = treadsInF.filter(t => !(Math.abs(t.y1 - t.y2) < 1e-9));
  assert.equal(radial.length, 3, JSON.stringify(treadsInF));
  for (const t of radial) {
    const pivot = Math.hypot(t.x1 - 1000, t.y1 - 2000) < Math.hypot(t.x2 - 1000, t.y2 - 2000) ? { x: t.x1, y: t.y1 } : { x: t.x2, y: t.y2 };
    near([pivot.x, pivot.y], [1000, 2000]);
  }
  // 水平（走行軸に直交）の踏面線は f には無い（i→b 方向の直進扱いではない）。出口境界は f/b の境界 y≒2000
  const horizontalInF = treadsInF.filter(t => Math.abs(t.y1 - t.y2) < 1e-9 && t.y1 > 2060);
  assert.equal(horizontalInF.length, 0, JSON.stringify(horizontalInF));
  const exitLine = g.treads.find(t => Math.abs(t.y1 - t.y2) < 1e-9 && Math.abs(t.y1 - 2000) < 60 && Math.min(t.x1, t.x2) > 900);
  assert.ok(exitLine, '取りつき回転部の出口境界（直進部の初段線）があるはず');
  // 段数字: 取りつき回転部が 1〜4、往路の初段は 5
  const nums = g.stepNumbers.filter(n => inF(n)).map(n => Number(n.text)).sort((a, b) => a - b);
  assert.deepEqual(nums, [1, 2, 3, 4]);
  const runANums = g.stepNumbers.filter(n => n.x > 1000 && n.x < 2000 && n.y > 1000 && n.y < 2000).map(n => Number(n.text));
  assert.equal(Math.min(...runANums), 5);
  // 寸法鎖に「取付 段数4」（entryTurnSteps 編集）が出る
  const dims = stairSegmentDims(stair, roomBounds(stair.cells, graph), 300, measureStairSpans(stair, graph));
  const entryDim = dims.find(d => d.target === 'entryTurnSteps');
  assert.ok(entryDim && entryDim.editable && entryDim.label === '取付 段数4', JSON.stringify(dims.map(d => d.label)));
});

test('上り口を走行端へ戻すと取りつき回転部は無くなり（蹴上 0）、f は直進部の踏面線に戻る。側面へ戻せば初期値が入る', () => {
  const { graph, c } = layout();
  const stair = addByOrder(graph, c, ['f', 'b', 'c', 'd', 'a']);
  const before = [...stair.sections];
  const toEnd = portSideChange(stair, 'entry', StairPortSide.END, 1000);
  assert.deepEqual(toEnd, { entrySide: 'end', entryTurnSteps: 0, sections: [before[0] + 4, before[1], before[2]] }, '取りつき 4 を往路の直進部へ戻す');
  for (const [k, v] of Object.entries(toEnd)) stair.setField(k, v);
  assert.equal(stair.totalSteps, 13, '総蹴上数は保つ（取りつき 4 を直進部へ戻す）');
  const g = geom(stair, graph, 'upper');
  const inF = (t) => (t.x1 + t.x2) / 2 > 1000 && (t.x1 + t.x2) / 2 < 2000 && (t.y1 + t.y2) / 2 > 2060 && (t.y1 + t.y2) / 2 < 3000;
  assert.ok(g.treads.filter(inF).every(t => Math.abs(t.y1 - t.y2) < 1e-9), '走行端の上り口では f の踏面線は走行軸に直交する');
  const back = portSideChange(stair, 'entry', StairPortSide.LEFT, 1000);
  assert.deepEqual(back, { entrySide: 'left', entryTurnSteps: 4, sections: before }, '側面へ戻すと初期値 4 を直進部から引く');
  for (const [k, v] of Object.entries(back)) stair.setField(k, v);
  assert.equal(stair.totalSteps, 13, '往復しても総蹴上数は 13');
  // 辺だけ替える（蹴上が既にある）ときは蹴上も直進部も触らない
  assert.deepEqual(portSideChange(stair, 'entry', StairPortSide.RIGHT, 1000), { entrySide: 'right' });
  // 鉄骨なら初期値 0（平場の踏み込み踊り場）。直進部は触らない
  assert.deepEqual(
    portSideChange({ structure: 'STEEL', tread: 250, sections: [6, 1, 6], entryTurnSteps: 0 }, 'entry', StairPortSide.RIGHT, 1000),
    { entrySide: 'right', entryTurnSteps: 0 });
});

test('【失敗系】portSideChange: 直進部が 2 段未満になる側面への切替は拒否（null）。ちょうど 2 段なら通る', () => {
  const base = { structure: 'WOOD', tread: 250, entryTurnSteps: 0, arrivalTurnSteps: 0 };
  // 木造・区画 1000mm ÷ 250 = 4 蹴上。往路 4 段から 4 引くと 0 段
  assert.equal(portSideChange({ ...base, sections: [4, 1, 9] }, 'entry', StairPortSide.LEFT, 1000), null);
  assert.equal(portSideChange({ ...base, sections: [5, 1, 9] }, 'entry', StairPortSide.LEFT, 1000), null, '5−4=1 段も不可');
  assert.deepEqual(portSideChange({ ...base, sections: [6, 1, 9] }, 'entry', StairPortSide.LEFT, 1000),
    { entrySide: 'left', entryTurnSteps: 4, sections: [2, 1, 9] });
  // 到達口は復路（sections[2]）から引く
  assert.deepEqual(portSideChange({ ...base, sections: [9, 1, 6] }, 'arrival', StairPortSide.RIGHT, 1000),
    { arrivalSide: 'right', arrivalTurnSteps: 4, sections: [9, 1, 2] });
  assert.equal(portSideChange({ ...base, sections: [9, 1, 5] }, 'arrival', StairPortSide.RIGHT, 1000), null);
});

test('resetPortSides: 反転・上り方向の変更で辺を自動へ戻し取りつき蹴上を 0 に（直進部へ戻して総蹴上数は保つ）。alignPortTurnSteps: 走行端に残った蹴上を 0 にそろえる', () => {
  const { graph, c } = layout();
  const stair = addByOrder(graph, c, ['f', 'b', 'c', 'd', 'a'], { entrySide: StairPortSide.RIGHT });
  assert.equal(stair.totalSteps, 13);
  for (const [k, v] of Object.entries(resetPortSides(stair))) stair.setField(k, v);
  assert.equal(stair.entrySide, null);
  assert.equal(stair.arrivalSide, null);
  assert.equal(stair.entryTurnSteps, 0);
  assert.equal(stair.totalSteps, 13);
  // 走行端なのに取りつきが残る状態（解決が end）
  stair.setField('entryTurnSteps', 3);
  assert.equal(stair.totalSteps, 16);
  const fixed = alignPortTurnSteps(stair, { entry: 'end', arrival: 'end' });
  assert.equal(fixed.entryTurnSteps, 0);
  for (const [k, v] of Object.entries(fixed)) stair.setField(k, v);
  assert.equal(stair.totalSteps, 16, '消える蹴上は直進部へ戻る（総蹴上数は保つ）');
  assert.equal(stair.entryTurnSteps, 0);
  // 側面に解決されている口は触らない／出入口の辺を選べない型（曲がり階段ほか）は {}
  assert.deepEqual(alignPortTurnSteps(stair, { entry: 'inner', arrival: 'outer' }), {});
  assert.deepEqual(resetPortSides({ type: StairType.FLARED }), {});
  assert.deepEqual(alignPortTurnSteps({ type: StairType.FLARED }, { entry: 'end', arrival: 'end' }), {});
});

test('復路が長い b,c,d,a,e: 到達口側の取りつき回転部 e は復路の続き番号で、到達番号は総蹴上数', () => {
  const { graph, c } = layout();
  const stair = addByOrder(graph, c, ['b', 'c', 'd', 'a', 'e']);
  assert.equal(stair.arrivalTurnSteps, 4);
  const g = geom(stair, graph, 'upper');
  const inE = (n) => n.x > 0 && n.x < 1000 && n.y > 2000 && n.y < 3000;
  const nums = g.stepNumbers.filter(inE).map(n => Number(n.text)).sort((a, b) => a - b);
  // 回転部 4 マス（続き番号）＋到達番号（辺の外側だが x>1000 なので含まれない）
  assert.equal(nums.length, 4);
  assert.equal(nums[nums.length - 1], stair.totalSteps - 1);
  assert.ok(g.stepNumbers.some(n => n.text === String(stair.totalSteps) && n.x > 1000));
});

// 実データ moku2-2 の構成: 最下段が両レーンにまたがる全幅セル f（追加した中心線が下段まで届いていない）。
//   [ c d ]（全幅の踊り場）
//   [ a | b ]
//   [   f   ]（全幅。上階スラブの張り出し下の踏み込み。e 側＝左辺から取りつく）
function fullBaseLayout() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), x2 = V(2000), y0 = H(0), y1 = H(1000), y2 = H(2000), y3 = H(3000);
  // 実データと同じく、レーンを分ける中心線は下段（f）まで届かない短縮中心線（y0〜y2。
  // isActiveAcrossRange は片側だけの延長指定を「常にアクティブ」とみなすため両端を指定する）
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH,
    extentLoRef: { clId: y0.id, offset: 0 }, extentHiRef: { clId: y2.id, offset: 0 },
  });
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  return { graph, c: { cd: k(x0, y0, x2, y1), a: k(x0, y1, x1, y2), b: k(x1, y1, x2, y2), f: k(x0, y2, x2, y3) } };
}

test('【実データ moku2-2】全幅の最下段セル f から b へ: f は往路の取りつき回転部（全幅）で、上り口は f の左辺（e 側）', () => {
  const { graph, c } = fullBaseLayout();
  const stair = addByOrder(graph, c, ['f', 'b', 'cd', 'a']);
  assert.equal(stair.type, StairType.SWITCHBACK, '全幅の踊り場 → 平踊り場');
  assert.equal(stair.upDirection, 'up');
  assert.equal(stair.flip, true, '往路 b は右列');
  assert.equal(stair.entryTurnSteps, 4, '取りつき 1000mm ÷ 250');
  const spans = measureStairSpans(stair, graph);
  assert.deepEqual(spans.lengths, [2000, 1000, 1000], 'f は往路レーンの被覆に数える');
  assert.equal(spans.entryFull, true);
  assert.deepEqual(edge(stair, graph, 'entry'),   [{ isVertical: true, value: 0, lo: 2000, hi: 3000 }], 'f の左辺');
  assert.deepEqual(edge(stair, graph, 'arrival'), [{ isVertical: false, value: 2000, lo: 0, hi: 1000 }], 'a の下辺＝スラブの縁');
  assert.deepEqual([...cellsBeyondBreak(stair, graph, null)], [c.a]);
  const g = geom(stair, graph, 'install');
  // 矢印は f の左辺の中点から右へ全幅を渡って往路レーン中心へ
  near([g.arrows[0].x1, g.arrows[0].y1], [0, 2500]);
  near(g.arrows[0].points.slice(0, 4), [0, 2500, 1500, 2500]);
  // f 内は pivot（f の左上角 ≒ (0, 2000)）から放射する 3 本の踏面線。走行軸に直交する踏面線（直進扱い）は無い
  const inF = (t) => (t.y1 + t.y2) / 2 > 2060 && (t.y1 + t.y2) / 2 < 3000;
  const treadsInF = g.treads.filter(inF);
  const radial = treadsInF.filter(t => Math.abs(t.y1 - t.y2) >= 1e-9);
  assert.equal(radial.length, 3, JSON.stringify(treadsInF));
  for (const t of radial) {
    const pivot = Math.hypot(t.x1, t.y1 - 2000) < Math.hypot(t.x2, t.y2 - 2000) ? { x: t.x1, y: t.y1 } : { x: t.x2, y: t.y2 };
    near([pivot.x, pivot.y], [0, 2000]);
  }
  assert.equal(treadsInF.filter(t => Math.abs(t.y1 - t.y2) < 1e-9).length, 0, '直進部の踏面線が f に無い');
  // 往路 b の踏面線は b の中（y 1000〜2000）だけ
  const runTreads = g.treads.filter(t => Math.abs(t.y1 - t.y2) < 1e-9 && Math.min(t.x1, t.x2) > 900);
  assert.ok(runTreads.length > 0 && runTreads.every(t => t.y1 > 940 && t.y1 < 2060), JSON.stringify(runTreads));
});

// 取りつき区画が1段（全幅の平場）の番号は、出入口辺の近く（内側 150mm）かつ矢印線と出口境界線の間（矢印線・出口線に載らない）。
// 2段以上の扇形は従来どおり（pivot から外周へ 70%）。2026-10-09 ユーザー目視 moku1-6（取付段数 1）
test('取りつき区画が1段のとき番号「1」は出入口辺寄り・矢印線と出口境界線の間。2段なら従来の扇形位置のまま', () => {
  const { graph, c } = layout();
  const one = addByOrder(graph, c, ['f', 'b', 'c', 'd', 'a'], { entryTurnSteps: 1 });
  const g = geom(one, graph, 'upper');
  const n1 = g.stepNumbers.find(n => n.text === '1');
  const edgeX = 1000, arrowY = 2500; // 出入口辺（f の左辺）と、その中点を渡る矢印線
  const exitY = 2000; // 区画 f の出口境界（直進部の初段線）
  assert.ok(n1, JSON.stringify(g.stepNumbers));
  assert.ok(Math.abs(n1.x - edgeX - 150) <= 10, `辺から 150mm 内側: ${n1.x} / 辺 ${edgeX}`);
  assert.ok(Math.abs(n1.y - arrowY) > 100, `矢印線から離れる: ${n1.y} / ${arrowY}`);
  assert.ok(Math.abs(n1.y - exitY) > 100, `出口線から離れる: ${n1.y}`);
  assert.ok((n1.y - arrowY) * (n1.y - exitY) < 0, `矢印線と出口線の間: ${n1.y}`);
  // 2段: 扇形の初段は pivot（辺×出口線の角）から外周へ寄せた従来位置＝辺から 150mm より遠い
  const l2 = layout();
  const two = addByOrder(l2.graph, l2.c, ['f', 'b', 'c', 'd', 'a'], { entryTurnSteps: 2 });
  const n2 = geom(two, l2.graph, 'upper').stepNumbers.find(n => n.text === '1');
  assert.ok(n2 && Math.abs(n2.x - edgeX - 150) > 100, `${JSON.stringify(n2)}`);
});

test('【実データ moku2-2】上り口を走行端へ切り替えると f の基端（往路側半分）が上り口になる', () => {
  const { graph, c } = fullBaseLayout();
  const stair = addByOrder(graph, c, ['f', 'b', 'cd', 'a']);
  for (const [k, v] of Object.entries(portSideChange(stair, 'entry', StairPortSide.END, 1000))) stair.setField(k, v);
  // 開口辺は footprint 外形線分の全長（全幅セル f の下辺は分割されていないので全幅 1 本）
  assert.deepEqual(edge(stair, graph, 'entry'), [{ isVertical: false, value: 3000, lo: 0, hi: 2000 }]);
});

test('【失敗系】区画を除くと直進部が残らない 2×2（各レーン 1 行）では entrySide/arrivalSide を指定しても走行端のまま', () => {
  const { graph, c } = layout();
  const stair = addByOrder(graph, c, ['a', 'b', 'c', 'd'], { entrySide: StairPortSide.LEFT, arrivalSide: StairPortSide.RIGHT });
  assert.deepEqual(edge(stair, graph, 'entry'),   [{ isVertical: true, value: 0, lo: 1000, hi: 2000 }]);
  assert.deepEqual(edge(stair, graph, 'arrival'), [{ isVertical: true, value: 0, lo: 0, hi: 1000 }]);
  for (const side of [StairPortSide.LEFT, StairPortSide.RIGHT]) {
    const p = resolveUTurnPorts({ ...stair, upDirection: stair.upDirection, flip: stair.flip, entrySide: side, arrivalSide: side },
      { laneLenA: 1000, laneLenB: 1000, firstRowA: 1000, firstRowB: 1000 });
    assert.equal(p.entry, 'end');
    assert.equal(p.arrival, 'end');
    assert.equal(p.entryLonger, false);
    assert.equal(p.arrivalLonger, false);
  }
});

test('【失敗系】resolveUTurnPorts: 不明な値は既定（隣レーン側＝inner）に丸め、区画の無い短いレーン側の指定は無視される', () => {
  const stair = { type: StairType.SWITCHBACK, upDirection: 'up', flip: false, entrySide: 'sideways', arrivalSide: StairPortSide.RIGHT };
  const p = resolveUTurnPorts(stair, { laneLenA: 2000, laneLenB: 1000 });
  assert.equal(p.entry, 'inner');
  assert.equal(p.arrival, 'end', '短いレーンの基端の行（firstRow 未実測＝0）が区画に取れないので走行端');
  assert.equal(p.entryLonger, true);
  assert.equal(p.arrivalLonger, false);
  // 旧語彙（'inner'/'outer'）が万一残っていても不明な値として自動に丸める
  assert.equal(resolveUTurnPorts({ ...stair, entrySide: 'outer' }, { laneLenA: 2000, laneLenB: 1000 }).entry, 'inner');
});

// 等長の 2 行レーン: 上り口 b2→b1、回転部 c,d、到達口 a1→a2（x: 0,1000,2000 / y: 0〜3000。上り方向は上＝北）
//   [d c]   y0〜1000  回転部
//   [a1 b1] y1000〜2000
//   [a2 b2] y2000〜3000
function equalRowsLayout() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), x1 = V(1000), x2 = V(2000), y0 = H(0), y1 = H(1000), y2 = H(2000), y3 = H(3000);
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  return { graph, c: { d: k(x0, y0, x1, y1), c: k(x1, y0, x2, y1), a1: k(x0, y1, x1, y2), b1: k(x1, y1, x2, y2), a2: k(x0, y2, x1, y3), b2: k(x1, y2, x2, y3) } };
}

test('等長レーンで側面（上りから見て右）を指定すると、上り口の出入口辺が b2 の右辺（基端の行）に出る。自動は走行端のまま', () => {
  const { graph, c } = equalRowsLayout();
  const stair = addByOrder(graph, c, ['b2', 'b1', 'c', 'd', 'a1', 'a2']);
  assert.equal(stair.upDirection, 'up');
  assert.equal(stair.flip, true, '往路 b は右列');
  assert.equal(stair.entryTurnSteps, 0, '張り出しが無いので取りつき回転部なし');
  assert.deepEqual(edge(stair, graph, 'entry'), [{ isVertical: false, value: 3000, lo: 1000, hi: 2000 }], '自動は b2 の下辺（走行端）');
  // 分類の既定は往路 5 段（取りつき 4 を引くと 1 段で拒否される）。直進部を 8 段にして側面へ
  assert.equal(portSideChange(stair, 'entry', StairPortSide.RIGHT, 1000), null, '往路 5−4=1 段は拒否');
  stair.setField('sections', [8, 5, 8]);
  const total0 = stair.totalSteps;
  // 右（北向きの右＝東）: 外周側（x=2000）。区画は基端の行 b2 だけ（b1 の右辺は含まない）
  for (const [k, v] of Object.entries(portSideChange(stair, 'entry', StairPortSide.RIGHT, 1000))) stair.setField(k, v);
  assert.equal(stair.entrySide, 'right');
  assert.equal(stair.entryTurnSteps, 4);
  assert.equal(stair.totalSteps, total0, 'portSideChange は総蹴上数を保つ');
  assert.deepEqual(stair.sections, [4, 5, 8], '往路から取りつき 4 を引く');
  assert.deepEqual(edge(stair, graph, 'entry'), [{ isVertical: true, value: 2000, lo: 2000, hi: 3000 }]);
  // 到達口の辺は変わらない
  assert.deepEqual(edge(stair, graph, 'arrival'), [{ isVertical: false, value: 3000, lo: 0, hi: 1000 }]);
  // 取りつき回転部 b2（扇形 4 マス）の外側の辺が側面の出入口。直進部は b1 から始まり、b2/b1 の境界（y=2000）が出口境界
  const g = geom(stair, graph, 'upper');
  const exitLine = g.treads.find(t => Math.abs(t.y1 - t.y2) < 1e-9 && Math.abs(t.y1 - 2000) < 60 && Math.max(t.x1, t.x2) > 1900);
  assert.ok(exitLine, '取りつき回転部 b2 の出口境界');
  const inB2 = (n) => n.x > 1000 && n.x < 2000 && n.y > 2000 && n.y < 3000;
  assert.deepEqual(g.stepNumbers.filter(inB2).map(n => Number(n.text)).sort((p, q) => p - q), [1, 2, 3, 4]);
  // 左（内側）は等長レーンでは隣レーンと共有する辺なので選べない＝自動（走行端）に戻る
  stair.setField('entrySide', StairPortSide.LEFT);
  assert.deepEqual(edge(stair, graph, 'entry'), [{ isVertical: false, value: 3000, lo: 1000, hi: 2000 }]);
});

// 往路が 2 行長い（張り出し区間が 2 行）:
//   [d c]     y0〜1000  回転部
//   [a1 b1]   y1000〜2000
//   [a2 b2]   y2000〜3000
//   [   b3]   y3000〜4000  ← 張り出し（往路のみ）
//   [   b4]   y4000〜5000
function overhangTwoRowsLayout() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), x1 = V(1000), x2 = V(2000), ys = [0, 1000, 2000, 3000, 4000, 5000].map(H);
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  return {
    graph,
    c: {
      d: k(x0, ys[0], x1, ys[1]), c: k(x1, ys[0], x2, ys[1]),
      a1: k(x0, ys[1], x1, ys[2]), b1: k(x1, ys[1], x2, ys[2]),
      a2: k(x0, ys[2], x1, ys[3]), b2: k(x1, ys[2], x2, ys[3]),
      b3: k(x1, ys[3], x2, ys[4]), b4: k(x1, ys[4], x2, ys[5]),
    },
  };
}

test('張り出し区間が 2 行以上でも、側面の出入口は区画の行ぶんのセルの辺をすべて開口辺にする', () => {
  const { graph, c } = overhangTwoRowsLayout();
  const stair = addByOrder(graph, c, ['b4', 'b3', 'b2', 'b1', 'c', 'd', 'a1', 'a2']);
  assert.equal(stair.upDirection, 'up');
  assert.equal(stair.entrySide, null);
  // 既定（内側＝北向きの左＝西 x=1000）: 張り出し b3,b4 の辺 2 本（y 3000〜4000, 4000〜5000）
  assert.deepEqual(edge(stair, graph, 'entry'), [
    { isVertical: true, value: 1000, lo: 3000, hi: 4000 },
    { isVertical: true, value: 1000, lo: 4000, hi: 5000 },
  ]);
  // 右（外側 x=2000）: 張り出し全体（2 行）の外周の辺 2 本
  stair.setField('entrySide', StairPortSide.RIGHT);
  assert.deepEqual(edge(stair, graph, 'entry'), [
    { isVertical: true, value: 2000, lo: 3000, hi: 4000 },
    { isVertical: true, value: 2000, lo: 4000, hi: 5000 },
  ]);
  // 走行端は b4 の下辺 1 本（辺の数は走行端を変えない）
  stair.setField('entrySide', StairPortSide.END);
  assert.deepEqual(edge(stair, graph, 'entry'), [{ isVertical: false, value: 5000, lo: 1000, hi: 2000 }]);
});

test('【install の基端】上り口が側面（自動の内側・右）なら基端は upper と同じく壁表面で止まる。走行端は設置枠の縁（CL）まで', () => {
  const { graph, c } = overhangTwoRowsLayout();
  const stair = addByOrder(graph, c, ['b4', 'b3', 'b2', 'b1', 'c', 'd', 'a1', 'a2']);
  const b = roomBounds(stair.cells, graph);
  const spans = measureStairSpans(stair, graph);
  const inset = (view) => insetStairBounds(stair, b, view, null, spans);
  for (const side of [null, StairPortSide.LEFT, StairPortSide.RIGHT]) {
    stair.setField('entrySide', side);
    assert.deepEqual(inset('install'), inset('upper'), `entrySide=${side}`);
    assert.equal(inset('install').y2, b.y2 - inset('install').sideInsetMm, `entrySide=${side}: 基端は壁表面`);
    // 放射線の端点も壁表面の枠内
    const g = buildStairGeometry(stair, b, { view: 'install', detail: true, riser: 200, spans, laneGap: false });
    const ys = g.treads.flatMap(t => [t.y1, t.y2]);
    assert.ok(Math.max(...ys) <= inset('install').y2 + 1e-6 && Math.max(...ys) >= inset('install').y2 - 1e-6, `entrySide=${side}: 最も基端の踏面線の端点は壁表面`);
  }
  stair.setField('entrySide', StairPortSide.END);
  assert.equal(inset('install').y2, b.y2, '走行端は CL のまま（開口）');
  assert.equal(inset('upper').y2, b.y2 - inset('upper').sideInsetMm, 'upper は従来どおり壁表面');
});

test('旧語彙の出入口の辺（inner/outer）を保存した文書を読むと null（自動）になる。end/left/right は往復する', () => {
  const { graph, c } = layout();
  const cells = new Set([c.a, c.b, c.c, c.d]);
  const mk = (entrySide, arrivalSide) => graph.addStair({ type: StairType.SWITCHBACK, cells, sections: [5, 1, 5], entrySide, arrivalSide });
  const legacy = mk('inner', 'outer');   // 旧語彙（互換なし）
  const fresh = mk(StairPortSide.LEFT, StairPortSide.END);
  const unknown = mk('sideways', null);  // 許可リスト外
  const restored = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  restoreGraph(restored, serializeGraph(graph));
  assert.equal(restored.stairMap.get(legacy.id).entrySide, null);
  assert.equal(restored.stairMap.get(legacy.id).arrivalSide, null);
  assert.equal(restored.stairMap.get(fresh.id).entrySide, 'left');
  assert.equal(restored.stairMap.get(fresh.id).arrivalSide, 'end');
  assert.equal(restored.stairMap.get(unknown.id).entrySide, null);
});
