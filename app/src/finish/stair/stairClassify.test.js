// classifyStairArea（選択順＝歩行順を第一の根拠にする判定）と、その結果を受ける描画・区間実測・
// 破れ先・踊り場矩形（不等長レーン）の本番経路テスト。
// フィクスチャは 2列×3行のセル格子（y下向き正）:  d c / a b / e f
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType } from '@core';
import { classifyStairArea, measureStairSpans, uTurnSpans } from './stairClassify.js';
import { stairPortEdges, cellsBeyondBreak, buildStairGeometry } from './stairGeometry.js';
import { landingRect } from './stairLanding.js';
import { roomBounds } from '../gridCells.js';

function layout(cw = 1000, ch = 1000) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), x1 = V(cw), x2 = V(2 * cw);
  const y0 = H(0), y1 = H(ch), y2 = H(2 * ch), y3 = H(3 * ch);
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  return {
    graph,
    c: {
      d: k(x0, y0, x1, y1), c: k(x1, y0, x2, y1),
      a: k(x0, y1, x1, y2), b: k(x1, y1, x2, y2),
      e: k(x0, y2, x1, y3), f: k(x1, y2, x2, y3),
    },
  };
}
const FH = 2800; // 階高 → 必要蹴上数 ceil(2800/230) = 13

// 選択順 order で分類し、そのまま Stair を追加する（applyNaming と同じ受け渡し）
function classifyAndAdd(graph, c, order, { floorHeight = FH, structure = null, setOrder = null } = {}) {
  const keys = order.map(n => c[n]);
  const cells = new Set((setOrder ?? order).map(n => c[n]));
  const cls = classifyStairArea(cells, graph, floorHeight, keys, structure);
  const stair = graph.addStair({
    type: cls.type, cells, upDirection: cls.upDirection, flip: cls.flip ?? false,
    sections: cls.sections ?? null, ...(structure ? { structure } : {}),
  });
  return { cls, stair };
}
const edge = (stair, graph, port) => stairPortEdges(stair, graph, [port]);

test('2×2 a,b,c,d: 横レーン（upDirection=right）・往路が下段（flip=true）・回り階段。上り口は a の左辺', () => {
  const { graph, c } = layout();
  const { cls, stair } = classifyAndAdd(graph, c, ['a', 'b', 'c', 'd']);
  assert.equal(cls.type, StairType.WINDING);
  assert.equal(cls.upDirection, 'right');
  assert.equal(cls.flip, true);
  // 必要蹴上数13 − 回転部R=4（1000/250） = 9 → 往路5・復路4。sections[1] = R+1 = 5
  assert.deepEqual(cls.sections, [5, 5, 4]);
  assert.equal(cls.totalSteps, 13);
  assert.deepEqual(edge(stair, graph, 'entry'), [{ isVertical: true, value: 0, lo: 1000, hi: 2000 }], 'a の左辺');
  assert.deepEqual(edge(stair, graph, 'arrival'), [{ isVertical: true, value: 0, lo: 0, hi: 1000 }], '到達は d の左辺');
});

test('2×2: 結果は cells（Set）の並び順・セル寸法の縦横比に依存しない', () => {
  for (const [cw, ch] of [[1000, 1000], [1200, 1000], [1000, 1200]]) {
    const ref = layout(cw, ch);
    const base = classifyAndAdd(ref.graph, ref.c, ['a', 'b', 'c', 'd']).cls;
    const { graph, c } = layout(cw, ch);
    const { cls } = classifyAndAdd(graph, c, ['a', 'b', 'c', 'd'], { setOrder: ['d', 'c', 'a', 'b'] });
    for (const f of ['type', 'upDirection', 'flip', 'sections', 'totalSteps']) {
      assert.deepEqual(cls[f], base[f], `${cw}x${ch} ${f}`);
    }
    assert.equal(cls.upDirection, 'right', `${cw}x${ch}`);
    assert.equal(cls.flip, true, `${cw}x${ch}`);
  }
});

test('2×2 d,c,b,a（逆順）は鏡像: upDirection=right・flip=false・上り口は d の左辺', () => {
  const { graph, c } = layout();
  const { cls, stair } = classifyAndAdd(graph, c, ['d', 'c', 'b', 'a']);
  assert.equal(cls.upDirection, 'right');
  assert.equal(cls.flip, false);
  assert.deepEqual(edge(stair, graph, 'entry'), [{ isVertical: true, value: 0, lo: 0, hi: 1000 }]);
});

test('往路が長い f,b,c,d,a: 区間実測 [2000,1000,1000]、上り口は張り出し区間の内側＝f の左辺（e側。既定）、到達 a の下辺、破れ先は a', () => {
  const { graph, c } = layout();
  const { cls, stair } = classifyAndAdd(graph, c, ['f', 'b', 'c', 'd', 'a']);
  assert.equal(cls.upDirection, 'up');
  assert.equal(cls.flip, true);
  assert.deepEqual(measureStairSpans(stair, graph).lengths, [2000, 1000, 1000]);
  assert.deepEqual(edge(stair, graph, 'entry'),   [{ isVertical: true, value: 1000, lo: 2000, hi: 3000 }]);
  assert.deepEqual(edge(stair, graph, 'arrival'), [{ isVertical: false, value: 2000, lo: 0, hi: 1000 }]);
  assert.deepEqual([...cellsBeyondBreak(stair, graph, null)], [c.a]);
  // 短い復路の基端より手前（e との境界）の往路内側（通り芯 x=1000）が上り口辺（thin/port）になり、
  // f の下辺（走行端）は階段の外周（side）になる
  const b = roomBounds(stair.cells, graph);
  const geom = buildStairGeometry(stair, b, { view: 'upper', detail: false, riser: null, spans: measureStairSpans(stair, graph), laneGapMm: 0 });
  //（upper ビューの外周は壁厚ぶん内側へ inset されるため、端点は 2000/3000 から 100mm 未満ずれる）
  const innerPort = geom.outline.find(s => s.port === 'entry' && s.x1 === 1000 && s.x2 === 1000
    && Math.abs(Math.min(s.y1, s.y2) - 2000) < 100 && Math.abs(Math.max(s.y1, s.y2) - 3000) < 100);
  assert.ok(innerPort, `往路内側 x=1000, y∈[2000,3000] が上り口辺のはず: ${JSON.stringify(geom.outline.filter(s => s.port))}`);
  const endSide = geom.outline.find(s => s.side && Math.abs(s.y1 - s.y2) < 1e-9 && Math.abs(s.y1 - 3000) < 100);
  assert.ok(endSide, 'f の下辺は side 線になるはず');
  // 中央仕切り（非 side）は両レーンが並走する区間（y∈[1000,2000]）だけ
  const partition = geom.outline.filter(s => !s.side && !s.port);
  assert.equal(partition.length, 1);
  assert.ok(Math.abs(Math.max(partition[0].y1, partition[0].y2) - 2000) < 100 && Math.abs(Math.min(partition[0].y1, partition[0].y2) - 1000) < 100);
});

test('復路が長い b,c,d,a,e: 区間実測 [1000,1000,2000]、上り口 b の下辺、到達口は張り出し区間の内側＝e の右辺（既定）、破れ先は a,e', () => {
  const { graph, c } = layout();
  const { cls, stair } = classifyAndAdd(graph, c, ['b', 'c', 'd', 'a', 'e']);
  assert.equal(cls.upDirection, 'up');
  assert.equal(cls.flip, true);
  assert.deepEqual(measureStairSpans(stair, graph).lengths, [1000, 1000, 2000]);
  assert.deepEqual(edge(stair, graph, 'entry'),   [{ isVertical: false, value: 2000, lo: 1000, hi: 2000 }]);
  assert.deepEqual(edge(stair, graph, 'arrival'), [{ isVertical: true, value: 1000, lo: 2000, hi: 3000 }]);
  assert.deepEqual([...cellsBeyondBreak(stair, graph, null)].sort(), [c.a, c.e].sort());
});

test('鉄骨: 回転部の初期段数 R=0 → 平踊り場（SWITCHBACK）。13蹴上を往路7・復路6へ配分。踊り場矩形は c∪d', () => {
  const { graph, c } = layout();
  const { cls, stair } = classifyAndAdd(graph, c, ['f', 'b', 'c', 'd', 'a'], { structure: StructuralMaterialType.STEEL });
  assert.equal(cls.type, StairType.SWITCHBACK);
  assert.deepEqual(cls.sections, [7, 1, 6]);
  assert.deepEqual(landingRect(stair, graph), { x1: 0, y1: 0, x2: 2000, y2: 1000 });
});

test('全幅の踊り場セルがある従来の3セル折返し（左レーン→踊り場→右レーン）は SWITCHBACK・flip=false', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), xm = V(1000), x1 = V(2000), y0 = H(0), ym = H(1500), y1 = H(4500);
  const landing = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const left    = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const right   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const cells = new Set([landing, left, right]);
  const cls = classifyStairArea(cells, graph, FH, [left, landing, right]);
  assert.equal(cls.type, StairType.SWITCHBACK);
  assert.equal(cls.upDirection, 'up');
  assert.equal(cls.flip, false);
  assert.deepEqual(cls.sections, [7, 1, 6]);
  // 右レーンから歩き始めれば flip=true
  assert.equal(classifyStairArea(cells, graph, FH, [right, landing, left]).flip, true);
  // 選択順なし（階段セル直クリック等）は従来の幾何推定でも SWITCHBACK
  assert.equal(classifyStairArea(cells, graph, FH, null).type, StairType.SWITCHBACK);
});

test('階高未確定（floorHeight=null）なら段数は区間長÷踏面（往路5・回転部R=4・復路5）', () => {
  const { graph, c } = layout();
  const { cls } = classifyAndAdd(graph, c, ['a', 'b', 'c', 'd'], { floorHeight: null });
  assert.deepEqual(cls.sections, [5, 5, 5]);
});

test('直進（e,a,d）・L字（a,b,c）も選択順から向きを決める。直進の段数は必要蹴上数', () => {
  const { graph, c } = layout();
  const s = classifyAndAdd(graph, c, ['e', 'a', 'd']).cls;
  assert.equal(s.type, StairType.STRAIGHT);
  assert.equal(s.upDirection, 'up');
  assert.deepEqual(s.sections, [13]);
  const g2 = layout();
  const s2 = classifyAndAdd(g2.graph, g2.c, ['d', 'a', 'e']).cls;
  assert.equal(s2.upDirection, 'down');
  const g3 = layout();
  const l = classifyAndAdd(g3.graph, g3.c, ['a', 'b', 'c']).cls;
  assert.ok(l.type === StairType.L_TURN || l.type === StairType.FLARED);
  assert.equal(l.upDirection, 'right', '水平アーム（a→b）が上り始め');
  // 垂直アームから歩き始める逆順（c,b,a）は代替写像（up/down 系）
  const g4 = layout();
  const l2 = classifyAndAdd(g4.graph, g4.c, ['c', 'b', 'a']).cls;
  assert.equal(l2.upDirection, 'down');
});

test('【失敗系】経路が取れない選択順（非隣接 a,c,b,d）は幾何推定へフォールバックし、例外を投げず U字を返す', () => {
  const { graph, c } = layout();
  const cells = new Set(['a', 'b', 'c', 'd'].map(n => c[n]));
  const cls = classifyStairArea(cells, graph, FH, ['a', 'c', 'b', 'd'].map(n => c[n]));
  assert.ok(cls.type === StairType.WINDING || cls.type === StairType.SWITCHBACK);
  assert.ok(['up', 'down', 'left', 'right'].includes(cls.upDirection));
});

test('【失敗系】uTurnSpans: 回転部が走行全長を占める（レーン2列のみ・踊り場なし）は null', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), xm = V(1000), x1 = V(2000), y0 = H(0), y1 = H(900);
  const cells = new Set([`${x0.id}:${y0.id}:${xm.id}:${y1.id}`, `${xm.id}:${y0.id}:${x1.id}:${y1.id}`]);
  const stair = graph.addStair({ type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], upDirection: 'up', flip: false });
  assert.equal(uTurnSpans(stair, graph), null);
  assert.equal(measureStairSpans(stair, graph), null);
  assert.equal(cellsBeyondBreak(stair, graph, null).size, 0);
});
