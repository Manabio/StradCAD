// 折返し・回り階段の出入口の辺（Stair.entrySide / arrivalSide。StairPortSide＝end|left|right）の本番経路テスト。
// left/right はその口を歩くときの進行方向から見た向き（flip 非依存）。既定（null）は張り出すレーンなら
// 隣レーン側（設置階上階スラブの張り出しに横から取りつく。ユーザー裁定 2026-09-29）。
// フィクスチャは 2列×3行のセル格子（y下向き正）:  d c / a b / e f
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StairPortSide } from '@core';
import { classifyStairArea, measureStairSpans } from './stairClassify.js';
import { stairPortEdges, buildStairGeometry, insetStairBounds, resolveUTurnPorts, stairSegmentDims, cellsBeyondBreak } from './stairGeometry.js';
import { portSideChange, resetPortSides, alignPortTurnSteps } from './stairSectionEdit.js';
import { roomBounds } from '../gridCells.js';
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
