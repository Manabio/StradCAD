// 折返し・回り階段の出入口の辺（Stair.entrySide / arrivalSide。StairPortSide）の本番経路テスト。
// 張り出すレーン（相手より長いレーン）の出入口だけが側面（inner/outer）を選べ、既定は inner
//（設置階上階スラブの張り出しに横から取りつく。ユーザー裁定 2026-09-29）。
// フィクスチャは 2列×3行のセル格子（y下向き正）:  d c / a b / e f
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StairPortSide } from '@core';
import { classifyStairArea, measureStairSpans } from './stairClassify.js';
import { stairPortEdges, buildStairGeometry, resolveUTurnPorts, stairSegmentDims, cellsBeyondBreak } from './stairGeometry.js';
import { portSideChange } from './stairSectionEdit.js';
import { roomBounds } from '../gridCells.js';

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
  view, detail: true, riser: 200, spans: measureStairSpans(stair, graph), laneGapMm: 0,
});

test('往路が長い f,b,c,d,a: 上り口の既定は内側＝f の左辺（e 側）。到達口は a の下辺のまま', () => {
  const { graph, c } = layout();
  const stair = addByOrder(graph, c, ['f', 'b', 'c', 'd', 'a']);
  assert.equal(stair.entrySide, null, '保存値は null＝自動');
  assert.deepEqual(edge(stair, graph, 'entry'),   [{ isVertical: true, value: 1000, lo: 2000, hi: 3000 }]);
  assert.deepEqual(edge(stair, graph, 'arrival'), [{ isVertical: false, value: 2000, lo: 0, hi: 1000 }]);
  // 矢印（U）は f の左辺の中点 (1000, 2500) から横向きに入る
  const arrow = geom(stair, graph, 'install').arrows[0];
  assert.deepEqual([arrow.x1, arrow.y1], [1000, 2500]);
  near(arrow.points.slice(0, 4), [1000, 2500, 1500, 2500]);
  // f の下辺（走行端）は出入口ではなく側面線になる
  const bottom = geom(stair, graph, 'upper').outline.find(s => Math.abs(s.y1 - s.y2) < 1e-9 && Math.abs(s.y1 - 3000) < 60);
  assert.ok(bottom && bottom.side && !bottom.port, JSON.stringify(bottom));
});

test('上り口を「走行端」「外側」へ切り替えると出入口辺が f の下辺（i 側）／右辺へ移る', () => {
  const { graph, c } = layout();
  const stair = addByOrder(graph, c, ['f', 'b', 'c', 'd', 'a']);
  stair.setField('entrySide', StairPortSide.END);
  assert.deepEqual(edge(stair, graph, 'entry'), [{ isVertical: false, value: 3000, lo: 1000, hi: 2000 }]);
  near([geom(stair, graph, 'install').arrows[0].x1, geom(stair, graph, 'install').arrows[0].y1], [1500, 3000]);
  stair.setField('entrySide', StairPortSide.OUTER);
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
  const toEnd = portSideChange(stair, 'entry', StairPortSide.END, 1000);
  assert.deepEqual(toEnd, { entrySide: 'end', entryTurnSteps: 0 });
  for (const [k, v] of Object.entries(toEnd)) stair.setField(k, v);
  assert.equal(stair.totalSteps, 9, '13 − 取りつき 4');
  const g = geom(stair, graph, 'upper');
  const inF = (t) => (t.x1 + t.x2) / 2 > 1000 && (t.x1 + t.x2) / 2 < 2000 && (t.y1 + t.y2) / 2 > 2060 && (t.y1 + t.y2) / 2 < 3000;
  assert.ok(g.treads.filter(inF).every(t => Math.abs(t.y1 - t.y2) < 1e-9), '走行端の上り口では f の踏面線は走行軸に直交する');
  const back = portSideChange(stair, 'entry', StairPortSide.INNER, 1000);
  assert.deepEqual(back, { entrySide: 'inner', entryTurnSteps: 4 });
  // 鉄骨なら初期値 0（平場の踏み込み踊り場）
  stair.setField('structure', 'STEEL');
  assert.deepEqual(portSideChange(stair, 'entry', StairPortSide.OUTER, 1000), { entrySide: 'outer', entryTurnSteps: 0 });
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

test('【実データ moku2-2】上り口を走行端へ切り替えると f の基端（往路側半分）が上り口になる', () => {
  const { graph, c } = fullBaseLayout();
  const stair = addByOrder(graph, c, ['f', 'b', 'cd', 'a']);
  for (const [k, v] of Object.entries(portSideChange(stair, 'entry', StairPortSide.END, 1000))) stair.setField(k, v);
  // 開口辺は footprint 外形線分の全長（全幅セル f の下辺は分割されていないので全幅 1 本）
  assert.deepEqual(edge(stair, graph, 'entry'), [{ isVertical: false, value: 3000, lo: 0, hi: 2000 }]);
});

test('【失敗系】張り出しの無い等長レーン（2×2）では entrySide/arrivalSide を指定しても走行端のまま', () => {
  const { graph, c } = layout();
  const stair = addByOrder(graph, c, ['a', 'b', 'c', 'd'], { entrySide: StairPortSide.INNER, arrivalSide: StairPortSide.OUTER });
  assert.deepEqual(edge(stair, graph, 'entry'),   [{ isVertical: true, value: 0, lo: 1000, hi: 2000 }]);
  assert.deepEqual(edge(stair, graph, 'arrival'), [{ isVertical: true, value: 0, lo: 0, hi: 1000 }]);
  const ports = resolveUTurnPorts(stair, { laneLenA: 1000, laneLenB: 1000 });
  assert.deepEqual(ports, { entry: 'end', arrival: 'end', entryLonger: false, arrivalLonger: false });
});

test('【失敗系】resolveUTurnPorts: 不明な値は既定（inner）に丸め、短いレーン側の指定は無視される', () => {
  const stair = { type: StairType.SWITCHBACK, entrySide: 'sideways', arrivalSide: StairPortSide.OUTER };
  const p = resolveUTurnPorts(stair, { laneLenA: 2000, laneLenB: 1000 });
  assert.equal(p.entry, 'inner');
  assert.equal(p.arrival, 'end');
  assert.equal(p.entryLonger, true);
  assert.equal(p.arrivalLonger, false);
});
