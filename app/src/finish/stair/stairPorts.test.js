// stairPorts.js（折返し・回り階段の出入口の辺の語彙・解決・候補列挙）の単体テスト。
// フィクスチャは y 下向き正のセル格子（grid の cell(列, 行)）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StairPortSide, RoomFeature, RoomKind } from '@core';
import { classifyStairArea } from './stairClassify.js';
import { makeFrame } from './stairFrame.js';
import { portSideChange } from './stairSectionEdit.js';
import {
  sideToS, sideOfS, portSideValue, portSpansOf, portZone, resolveStairPorts, stairPortCandidates,
} from './stairPorts.js';

const { END, LEFT, RIGHT } = StairPortSide;

function grid(xs, ys) {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const V = xs.map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH }));
  const H = ys.map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH }));
  const cell = (i, j) => `${V[i].id}:${H[j].id}:${V[i + 1].id}:${H[j + 1].id}`;
  return { graph, cell, V, H };
}
function addByOrder(graph, keys, extra = {}) {
  const cells = new Set(keys);
  const cls = classifyStairArea(cells, graph, 2800, keys);
  return graph.addStair({
    type: cls.type, cells, upDirection: cls.upDirection, flip: cls.flip, sections: cls.sections,
    entryTurnSteps: cls.entryTurnSteps ?? 0, arrivalTurnSteps: cls.arrivalTurnSteps ?? 0, ...extra,
  });
}
// 2列×3行: d c / a b / e f（xs=0,1000,2000 ys=0..3000）
function threeRows() {
  const g = grid([0, 1000, 2000], [0, 1000, 2000, 3000]);
  const c = { d: g.cell(0, 0), c: g.cell(1, 0), a: g.cell(0, 1), b: g.cell(1, 1), e: g.cell(0, 2), f: g.cell(1, 2) };
  return { graph: g.graph, c };
}
// 等長 2 行: d c / a1 b1 / a2 b2（上り口 b2→b1、回転部 c,d、到達口 a1→a2）
function equalRows() {
  const g = grid([0, 1000, 2000], [0, 1000, 2000, 3000]);
  const c = { d: g.cell(0, 0), c: g.cell(1, 0), a1: g.cell(0, 1), b1: g.cell(1, 1), a2: g.cell(0, 2), b2: g.cell(1, 2) };
  return { graph: g.graph, c, order: ['b2', 'b1', 'c', 'd', 'a1', 'a2'] };
}
// 往路が 2 行長い（張り出し b3,b4）
function overhangTwo() {
  const g = grid([0, 1000, 2000], [0, 1000, 2000, 3000, 4000, 5000]);
  const c = {
    d: g.cell(0, 0), c: g.cell(1, 0), a1: g.cell(0, 1), b1: g.cell(1, 1), a2: g.cell(0, 2), b2: g.cell(1, 2),
    b3: g.cell(1, 3), b4: g.cell(1, 4),
  };
  return { graph: g.graph, c, order: ['b4', 'b3', 'b2', 'b1', 'c', 'd', 'a1', 'a2'] };
}
// 実データ moku2-2: 最下段が両レーンにまたがる全幅セル f（レーンを分ける中心線は下段まで届かない）
function fullBase() {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), x2 = V(2000), y0 = H(0), y1 = H(1000), y2 = H(2000), y3 = H(3000);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH,
    extentLoRef: { clId: y0.id, offset: 0 }, extentHiRef: { clId: y2.id, offset: 0 },
  });
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  return { graph, c: { cd: k(x0, y0, x2, y1), a: k(x0, y1, x1, y2), b: k(x1, y1, x2, y2), f: k(x0, y2, x2, y3) } };
}
// 床の確認用の「上階」: 階段の格子の外側にも部屋を置ける広い格子（x -1000〜3000, y -1000〜4000）。cell(列, 行)
// 列 i は x=-1000+1000*i、行 j は y=-1000+1000*j から。階段の格子とは別グラフ（CL id が違う）で、世界座標だけが共通。
function world() {
  return grid([-1000, 0, 1000, 2000, 3000], [-1000, 0, 1000, 2000, 3000, 4000]);
}
const room = (g, i, j, feature = null) => {
  const r = g.graph.addRoom(new Set([g.cell(i, j)]));
  if (feature) r.setFeature(feature);
  return r;
};

// ---- sideToS ----

test('sideToS: 北向き（up）の左は s 小側（flip 無し）。flip で s が入れ替わり、到達口は逆向きに歩くので左右が逆', () => {
  const mk = (upDirection, flip) => ({ upDirection, flip });
  assert.equal(sideToS(mk('up', false), 'entry', LEFT), 0);
  assert.equal(sideToS(mk('up', false), 'entry', RIGHT), 1);
  assert.equal(sideToS(mk('up', true), 'entry', LEFT), 1);
  assert.equal(sideToS(mk('up', true), 'entry', RIGHT), 0);
  // 到達口は upDirection の逆向き（南向き）に歩く
  assert.equal(sideToS(mk('up', false), 'arrival', LEFT), 1);
  assert.equal(sideToS(mk('up', false), 'arrival', RIGHT), 0);
  assert.equal(sideToS(mk('up', true), 'arrival', LEFT), 0);
});

test('sideToS: 全 upDirection × flip × 口で、左の辺は進行方向（y 下向き）の左に物理的に位置する（makeFrame で独立に確認）', () => {
  const b = { x1: 0, y1: 0, x2: 100, y2: 100 };
  for (const upDirection of ['up', 'down', 'left', 'right']) {
    for (const flip of [false, true]) {
      for (const port of ['entry', 'arrival']) {
        const stair = { upDirection, flip };
        const f = makeFrame(stair, b);
        const p0 = f.pt(0, 0.5), p1 = f.pt(1, 0.5), mid = f.pt(0.5, 0.5);
        const sign = port === 'entry' ? 1 : -1;
        const w = { x: (p1.x - p0.x) * sign, y: (p1.y - p0.y) * sign };
        const left = { x: w.y, y: -w.x }; // y 下向き座標での左
        const lat = (s) => { const q = f.pt(0.5, s); return { x: q.x - mid.x, y: q.y - mid.y }; };
        const dot = (u, v) => u.x * v.x + u.y * v.y;
        assert.ok(dot(lat(sideToS(stair, port, LEFT)), left) > 0, `${upDirection}/${flip}/${port} left`);
        assert.ok(dot(lat(sideToS(stair, port, RIGHT)), left) < 0, `${upDirection}/${flip}/${port} right`);
        assert.equal(sideToS(stair, port, LEFT) + sideToS(stair, port, RIGHT), 1);
        // sideOfS は sideToS の逆
        assert.equal(sideOfS(stair, port, sideToS(stair, port, LEFT)), LEFT);
        assert.equal(sideOfS(stair, port, sideToS(stair, port, RIGHT)), RIGHT);
      }
    }
  }
});

test('【失敗系】sideToS/sideOfS: 不明な口・left/right 以外の辺は throw', () => {
  const stair = { upDirection: 'up', flip: false };
  assert.throws(() => sideToS(stair, 'middle', LEFT), /entry/);
  assert.throws(() => sideToS(stair, 'entry', END), /left\/right/);
  assert.throws(() => sideToS(stair, 'entry', 'inner'), /left\/right/);
  assert.throws(() => sideOfS(stair, 'x', 0), /entry/);
});

// ---- resolveStairPorts ----

test('resolveStairPorts: 自動は張り出すレーンなら内側（隣レーン側）、他は走行端。保存値 left/right は進行方向の左右で外側／内側へ変換', () => {
  const info = { laneLenA: 2000, laneLenB: 1000, firstRowA: 1000, firstRowB: 1000 };
  const stair = { upDirection: 'up', flip: true, entrySide: null, arrivalSide: null };
  const auto = resolveStairPorts(stair, info);
  assert.equal(auto.entry, 'inner');
  assert.equal(auto.entryS, 1, 'A の内側は s=1');
  assert.equal(portSideValue(stair, 'entry', auto), LEFT, 'flip 無関係に北向きの左＝西');
  assert.equal(auto.arrival, 'end');
  assert.equal(auto.arrivalS, null);
  assert.deepEqual(auto.zoneA, [0, 1000], '区画＝張り出し 1000');
  assert.equal(auto.entryLonger, true);
  const right = resolveStairPorts({ ...stair, entrySide: RIGHT }, info);
  assert.equal(right.entry, 'outer');
  assert.equal(right.entryS, 0);
  assert.equal(portSideValue({ ...stair, entrySide: RIGHT }, 'entry', right), RIGHT);
  assert.equal(resolveStairPorts({ ...stair, entrySide: END }, info).entry, 'end');
});

test('resolveStairPorts: 等長レーンは基端の行が区画。外側だけ選べ、内側・区画なし・直進部が残らない場合は自動（走行端）へ戻す', () => {
  const info = { laneLenA: 2000, laneLenB: 2000, firstRowA: 1000, firstRowB: 1000 };
  const up = { upDirection: 'up', flip: false };
  // flip 無し: A は s 小側、北向きの左＝s 小側＝外側
  const outerA = resolveStairPorts({ ...up, entrySide: LEFT }, info);
  assert.equal(outerA.entry, 'outer');
  assert.deepEqual(outerA.zoneA, [0, 1000]);
  assert.equal(resolveStairPorts({ ...up, entrySide: RIGHT }, info).entry, 'end', '内側は隣レーンと共有する辺');
  // 到達口は南向きに歩く: 左＝s 大側＝B の外側、右＝s 小側＝隣レーンと共有する内側
  const arrOuter = resolveStairPorts({ ...up, arrivalSide: LEFT }, info);
  assert.equal(arrOuter.arrival, 'outer');
  assert.equal(arrOuter.arrivalS, 1);
  assert.equal(resolveStairPorts({ ...up, arrivalSide: RIGHT }, info).arrival, 'end');
});

test('【失敗系】resolveStairPorts: 区画が取れない（firstRow 無し）・区画がレーン全体で直進部が残らない場合は側面を指定しても走行端', () => {
  const up = { upDirection: 'up', flip: false };
  const noRow = resolveStairPorts({ ...up, entrySide: LEFT }, { laneLenA: 2000, laneLenB: 2000 });
  assert.equal(noRow.entry, 'end');
  const whole = resolveStairPorts({ ...up, entrySide: LEFT }, { laneLenA: 1000, laneLenB: 1000, firstRowA: 1000, firstRowB: 1000 });
  assert.equal(whole.entry, 'end');
  assert.throws(() => portZone({ laneLenA: 1, laneLenB: 1 }, 'middle'), /entry/);
  assert.equal(portSpansOf(null), null);
  assert.equal(portSpansOf({ lengths: [1, 2] }), null);
});

// ---- stairPortCandidates（幾何）----

test('候補（張り出しレーン f,b,c,d,a）: 上り口は end・左（内側）・右（外側）。到達口は区画が復路全体になり直進部が残らないので end だけ', () => {
  const { graph, c } = threeRows();
  const stair = addByOrder(graph, ['f', 'b', 'c', 'd', 'a'].map(n => c[n]));
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry'), { sides: [END, LEFT, RIGHT], floorChecked: false });
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival'), { sides: [END], floorChecked: false });
});

test('候補（等長 2 行レーン）: 内側は隣レーンと共有するので候補外。上り口・到達口とも end と外側だけ', () => {
  const { graph, c, order } = equalRows();
  const stair = addByOrder(graph, order.map(n => c[n]));
  assert.equal(stair.entrySide, null);
  stair.setField('sections', [8, 5, 8]); // 取りつき蹴上 4 を引いても直進部が 2 段以上残る
  // 往路 b（右列・flip）。北向きの右＝東＝外側。到達口は南向き: B（a 列）の外側＝西＝右
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry').sides, [END, RIGHT]);
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival').sides, [END, RIGHT]);
});

test('候補（直進部が残らない 2×2）: 区画が各レーン全体なので end だけ', () => {
  const g = grid([0, 1000, 2000], [0, 1000, 2000]);
  const stair = addByOrder(g.graph, [g.cell(0, 1), g.cell(1, 1), g.cell(1, 0), g.cell(0, 0)]);
  assert.ok([StairType.SWITCHBACK, StairType.WINDING].includes(stair.type));
  assert.deepEqual(stairPortCandidates(stair, g.graph, 'entry').sides, [END]);
  assert.deepEqual(stairPortCandidates(stair, g.graph, 'arrival').sides, [END]);
});

test('候補（直進部の段数）: 取りつき蹴上を足すと往路の直進部が 2 段未満になる側面は候補から外れる', () => {
  const { graph, c, order } = equalRows();
  const stair = addByOrder(graph, order.map(n => c[n]));
  assert.deepEqual(stair.sections, [5, 5, 4]);
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry').sides, [END], '往路 5−4=1 段');
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival').sides, [END], '復路 4−4=0 段');
  stair.setField('sections', [8, 5, 8]);
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry').sides, [END, RIGHT]);
  // 鉄骨は初期の取りつき蹴上が 0（段数は食わない）ので小さい直進部でも選べる
  stair.setField('sections', [3, 5, 3]);
  stair.setField('structure', 'STEEL');
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry').sides, [END, RIGHT]);
});

test('候補（張り出し 2 行）: 区画は張り出し区間全体（2 行）。端の行だけでなく全体の辺が外形線分上にある', () => {
  const { graph, c, order } = overhangTwo();
  const stair = addByOrder(graph, order.map(n => c[n]));
  assert.deepEqual(portZone({ laneLenA: 4000, laneLenB: 2000 }, 'entry'), { lane: 'A', longer: true, laneLen: 4000, zoneLen: 2000 });
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry').sides, [END, LEFT, RIGHT]);
});

test('候補（全幅の取りつき f。実データ moku2-2）: 内側は相手レーンの外側の辺（s=1）で、end・左・右が揃う', () => {
  const { graph, c } = fullBase();
  const stair = addByOrder(graph, ['f', 'b', 'cd', 'a'].map(n => c[n]));
  assert.equal(stair.type, StairType.SWITCHBACK);
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry').sides, [END, LEFT, RIGHT]);
});

// ---- stairPortCandidates（床）----

test('床の確認（上り口）: 隣が床のある部屋なら候補、VOID・STAIR_VOID・STAIR・昇降機・UNDEFINED・部屋なしは候補外', () => {
  const { graph, c, order } = equalRows();
  const stair = addByOrder(graph, order.map(n => c[n]));
  stair.setField('sections', [8, 5, 8]);
  // b2 は x 1000〜2000, y 2000〜3000。下（y3000〜4000＝行 4・列 2）と右（x 2000〜3000＝列 3・行 3）が隣
  const sidesWith = (rightFeature, { below = true, right = true } = {}) => {
    const w = world();
    if (below) room(w, 2, 4);
    if (right) room(w, 3, 3, rightFeature);
    return stairPortCandidates(stair, graph, 'entry', { floorGraph: w.graph });
  };
  assert.deepEqual(sidesWith(null), { sides: [END, RIGHT], floorChecked: true }, 'feature=null の部屋は床あり');
  for (const f of [RoomFeature.VOID, RoomFeature.STAIR_VOID, RoomFeature.STAIR, RoomFeature.ELEVATOR_EQUIPMENT, RoomFeature.UNDEFINED, RoomFeature.ROOF]) {
    assert.deepEqual(sidesWith(f).sides, [END], `${f} は床なし`);
  }
  const wExt = world();
  room(wExt, 2, 4);
  room(wExt, 3, 3).setKind(RoomKind.EXTERIOR);
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry', { floorGraph: wExt.graph }).sides, [END, RIGHT], '屋外部屋（feature=null）は床あり');
  assert.deepEqual(sidesWith(null, { right: false }).sides, [END], '部屋なしは床なし');
  assert.deepEqual(sidesWith(null, { below: false }).sides, [RIGHT], '走行端の外が部屋なしなら end も候補外');
});

test('床の確認（到達口）: 上階（別グラフ）の隣が床のある部屋なら候補。床の確認なし（floorGraph=null）は幾何だけで floorChecked=false', () => {
  const { graph, c, order } = equalRows();
  const stair = addByOrder(graph, order.map(n => c[n]));
  stair.setField('sections', [8, 5, 8]);
  // a2 は x 0〜1000, y 2000〜3000。下（列 1・行 4）と左（x -1000〜0＝列 0・行 3）が隣
  const upper = world();
  room(upper, 1, 4);
  room(upper, 0, 3, RoomFeature.STAIR_VOID);
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival', { floorGraph: upper.graph }), { sides: [END], floorChecked: true });
  const upper2 = world();
  room(upper2, 1, 4);
  room(upper2, 0, 3);
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival', { floorGraph: upper2.graph }).sides, [END, RIGHT]);
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival'), { sides: [END, RIGHT], floorChecked: false });
});

test('床の確認: 上階の格子が辺の途中で分かれていても、辺全体の隣がすべて床のときだけ候補（中点1点で判定しない）', () => {
  const { graph, c, order } = equalRows();
  const stair = addByOrder(graph, order.map(n => c[n]));
  stair.setField('sections', [8, 5, 8]);
  // 上り口の右辺（x=2000, y 2000〜3000）の隣の列を y=split で 2 つに分ける。上が床・下が VOID（split=2300 は中点 2500 が下、2700 は上）
  for (const split of [2300, 2700]) {
    const w = grid([-1000, 0, 1000, 2000, 3000], [-1000, 0, 1000, 2000, split, 3000, 4000]);
    room(w, 2, 5);                       // 走行端の下（y 3000〜4000）
    room(w, 3, 3);                       // 右の列の上側 y 2000〜split は床
    room(w, 3, 4, RoomFeature.VOID);     // 下側 split〜3000 は吹抜け
    assert.deepEqual(stairPortCandidates(stair, graph, 'entry', { floorGraph: w.graph }).sides, [END], `split=${split}: 一部が VOID なら右は候補外`);
    const ok = grid([-1000, 0, 1000, 2000, 3000], [-1000, 0, 1000, 2000, split, 3000, 4000]);
    room(ok, 2, 5); room(ok, 3, 3); room(ok, 3, 4);
    assert.deepEqual(stairPortCandidates(stair, graph, 'entry', { floorGraph: ok.graph }).sides, [END, RIGHT], `split=${split}: 全部床なら候補`);
  }
  // 走行端の辺（b2 の下辺 x 1000〜2000）の隣が x=1500 で分かれ、片方が VOID
  const w = grid([-1000, 0, 1000, 1500, 2000, 3000], [-1000, 0, 1000, 2000, 3000, 4000]);
  room(w, 2, 4); room(w, 3, 4, RoomFeature.VOID); room(w, 4, 3);
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry', { floorGraph: w.graph }).sides, [RIGHT], '走行端の隣の一部が VOID なら end は候補外');
});

test('候補の直進部判定は sections=null の階段でも portSideChange と一致する（defaultSections で判定）', () => {
  const { graph, c, order } = equalRows();
  for (const totalSteps of [15, 7]) {
    const stair = addByOrder(graph, order.map(n => c[n]), { sections: null, totalSteps });
    assert.equal(stair.sections, null);
    for (const port of ['entry', 'arrival']) {
      const info = portSpansOf({ lengths: [2000, 1000, 2000], firstRowA: 1000, firstRowB: 1000 });
      const side = stairPortCandidates(stair, graph, port).sides.find(s => s !== END);
      const change = portSideChange(stair, port, RIGHT, portZone(info, port).zoneLen); // 等長レーンでは外側＝右だけが側面の候補
      assert.equal(side !== undefined, change !== null, `total=${totalSteps} ${port}: 候補と切替の結果が一致`);
    }
  }
});

// ---- 失敗系 ----

test('【失敗系】stairPortCandidates: stair/graph が null・口が不正なら throw。U字以外は走行端のみ（floorChecked=false）', () => {
  const { graph, c } = threeRows();
  const stair = addByOrder(graph, ['f', 'b', 'c', 'd', 'a'].map(n => c[n]));
  assert.throws(() => stairPortCandidates(null, graph, 'entry'), /stair/);
  assert.throws(() => stairPortCandidates(stair, null, 'entry'), /graph/);
  assert.throws(() => stairPortCandidates(stair, graph, 'middle'), /entry/);
  assert.throws(() => stairPortCandidates(stair, graph, undefined), /entry/);
  const straight = graph.addStair({ type: StairType.STRAIGHT, cells: new Set([c.a, c.e]) });
  assert.deepEqual(stairPortCandidates(straight, graph, 'entry'), { sides: [END], floorChecked: false });
});
