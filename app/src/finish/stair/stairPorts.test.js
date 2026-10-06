// stairPorts.js（折返し・回り階段の出入口の辺の語彙・解決・候補列挙）の単体テスト。
// フィクスチャは y 下向き正のセル格子（grid の cell(列, 行)）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StairPortSide, RoomFeature, RoomKind } from '@core';
import { classifyStairArea, measureStairSpans, straightEndRows } from './stairClassify.js';
import { makeFrame } from './stairFrame.js';
import { portSideChange } from './stairSectionEdit.js';
import {
  sideToS, sideOfS, portSideValue, portSpansOf, portZone, resolveStairPorts, stairPortCandidates,
  straightPortInfoOf, resolveStraightPorts, resolvePorts, portZoneLen, sideToHi, sideOfHi, hasPortSides,
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

test('【失敗系】stairPortCandidates: stair/graph が null・口が不正なら throw。L字として実測できない矩折・U字・直進系・矩折以外は走行端のみ（floorChecked=false）', () => {
  const { graph, c } = threeRows();
  const stair = addByOrder(graph, ['f', 'b', 'c', 'd', 'a'].map(n => c[n]));
  assert.throws(() => stairPortCandidates(null, graph, 'entry'), /stair/);
  assert.throws(() => stairPortCandidates(stair, null, 'entry'), /graph/);
  assert.throws(() => stairPortCandidates(stair, graph, 'middle'), /entry/);
  assert.throws(() => stairPortCandidates(stair, graph, undefined), /entry/);
  const lTurn = graph.addStair({ type: StairType.L_TURN, cells: new Set([c.a, c.e]) });
  assert.deepEqual(stairPortCandidates(lTurn, graph, 'entry'), { sides: [END], floorChecked: false });
});

// ---- 直進系（ステップ9b。区画は先頭・末尾の行）----

// 直進（北向き）: 幅 cols 列 × 行の高さ ys の階段。上り口＝最下行（y が大きい側）、t=0 が下端
function straightStair(ys, cols = 1, extra = {}) {
  const g = grid(Array.from({ length: cols + 1 }, (_, i) => i * 1000), ys);
  const keys = [];
  for (let j = ys.length - 2; j >= 0; j--) for (let i = 0; i < cols; i++) keys.push(g.cell(i, j));
  const stair = g.graph.addStair({ type: StairType.STRAIGHT, cells: new Set(keys), upDirection: 'up', flip: false, sections: [15], ...extra });
  return { ...g, stair };
}
const ROWS3 = [0, 1000, 2000, 3000];

test('straightEndRows: 先頭・末尾の行の走行長と行数。幅方向に分割された行は1行、走行方向に分割された行は別の行', () => {
  const { graph, stair } = straightStair([0, 1000, 2000, 2400, 3000], 2);
  const r = straightEndRows(stair, graph);
  assert.equal(r.firstRowMm, 600, '先頭（上り口＝最下行 y 2400〜3000）');
  assert.equal(r.lastRowMm, 1000, '末尾（最上行 y 0〜1000）');
  assert.equal(r.rowCount, 4);
  assert.equal(r.firstCells.length, 2, '幅方向に 2 セルの行は 1 行');
  assert.equal(r.lastCells.length, 2);
  assert.equal(r.L, 3000);
  // 1 行だけなら先頭＝末尾＝全長
  const one = straightStair([0, 1000]);
  const r1 = straightEndRows(one.stair, one.graph);
  assert.deepEqual([r1.firstRowMm, r1.lastRowMm, r1.rowCount], [1000, 1000, 1]);
});

test('【失敗系】straightEndRows: セルが無い階段は null。measureStairSpans（直進）の firstRow/lastRow/rowCount と一致', () => {
  const { graph, stair } = straightStair(ROWS3, 2);
  assert.equal(straightEndRows({ ...stair, cells: new Set() }, graph), null);
  const spans = measureStairSpans(stair, graph);
  assert.deepEqual(spans, { lengths: [3000], firstRow: 1000, lastRow: 1000, rowCount: 3 });
  assert.equal(straightPortInfoOf(null), null);
  assert.equal(straightPortInfoOf({ lengths: [3000] }), null, '先頭・末尾の行が無い実測は null');
});

test('候補（直進 3 行）: 上り口・到達口とも end・左・右。区画は先頭・末尾の行', () => {
  const { graph, stair } = straightStair(ROWS3, 2);
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry'), { sides: [END, LEFT, RIGHT], floorChecked: false });
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival'), { sides: [END, LEFT, RIGHT], floorChecked: false });
});

test('候補（直進 1 行）: 区画が全体で直進部が残らないので end だけ（上り口・到達口とも）', () => {
  const { graph, stair } = straightStair([0, 1000], 2);
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry').sides, [END]);
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival').sides, [END]);
});

test('候補（直進 2 行）: 片方の口だけなら側面が選べる。相手の口が側面なら全長に収まらず end だけ（両口とも側面は 3 行以上）', () => {
  const { graph, stair } = straightStair([0, 1000, 2000], 2);
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry').sides, [END, LEFT, RIGHT]);
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival').sides, [END, LEFT, RIGHT]);
  stair.setField('entrySide', LEFT);
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival').sides, [END], '上り口が側面なら到達口の側面は直進部が残らない');
  stair.setField('entrySide', null);
  stair.setField('arrivalSide', RIGHT);
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry').sides, [END]);
  // 3 行なら両口とも側面にできる
  const three = straightStair(ROWS3, 2, { entrySide: LEFT });
  assert.deepEqual(stairPortCandidates(three.stair, three.graph, 'arrival').sides, [END, LEFT, RIGHT]);
});

test('候補（直進）: 取りつき蹴上を足すと直進部が 2 段未満になる側面は候補外。鉄骨は蹴上 0 なので残る', () => {
  const { graph, stair } = straightStair(ROWS3, 2, { sections: [5] });
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry').sides, [END], '5−4=1 段');
  stair.setField('structure', 'STEEL');
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry').sides, [END, LEFT, RIGHT]);
  // 上り口・到達口は同じ sections[0] から引く（sections[0] は上り口の取りつき分を引いた後の値）
  const both = straightStair(ROWS3, 2, { sections: [9], entrySide: LEFT, entryTurnSteps: 4 });
  assert.deepEqual(stairPortCandidates(both.stair, both.graph, 'arrival').sides, [END, LEFT, RIGHT], '9−4=5 ≥ 2');
  both.stair.setField('sections', [5]);
  assert.deepEqual(stairPortCandidates(both.stair, both.graph, 'arrival').sides, [END], '5−4=1 段');
});

test('床の確認（直進）: 上り口は自階、到達口は上階の隣が床のある部屋のときだけ。床なし・部屋なしは候補外', () => {
  const { graph, stair } = straightStair(ROWS3);
  // 階段は x 0〜1000, y 0〜3000。上り口＝最下行（y 2000〜3000）: 左 x -1000〜0（列 0・行 3）・右（列 2・行 3）・下（列 1・行 4）
  const entrySides = (left, right, below = true) => {
    const w = world();
    if (below) room(w, 1, 4);
    if (left !== undefined) room(w, 0, 3, left);
    if (right !== undefined) room(w, 2, 3, right);
    return stairPortCandidates(stair, graph, 'entry', { floorGraph: w.graph });
  };
  assert.deepEqual(entrySides(null, null), { sides: [END, LEFT, RIGHT], floorChecked: true });
  assert.deepEqual(entrySides(RoomFeature.VOID, null).sides, [END, RIGHT], '左が吹抜けなら左は候補外（北向きの左＝西）');
  assert.deepEqual(entrySides(null, RoomFeature.STAIR_VOID).sides, [END, LEFT]);
  assert.deepEqual(entrySides(null, undefined).sides, [END, LEFT], '右が部屋なしなら右は候補外');
  assert.deepEqual(entrySides(null, null, false).sides, [LEFT, RIGHT], '走行端の外が部屋なしなら end も候補外');
  // 到達口＝最上行（y 0〜1000）。上階の隣: 左（列 0・行 1）・右（列 2・行 1）・上（列 1・行 0）。到達口は逆向きに歩くので左右が逆
  const up = world();
  room(up, 1, 0); room(up, 0, 1); room(up, 2, 1, RoomFeature.VOID);
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival', { floorGraph: up.graph }).sides, [END, RIGHT], '到達口から見て右＝西は床、左＝東は吹抜け');
});

test('resolveStraightPorts: 自動は走行端。保存値 left/right は進行方向の左右で s へ。区画が全長・直進部を食うときは走行端へ戻す', () => {
  const { graph, stair } = straightStair(ROWS3, 2);
  const info = straightPortInfoOf(measureStairSpans(stair, graph));
  assert.deepEqual(resolveStraightPorts(stair, info), { entry: 'end', arrival: 'end', entryS: null, arrivalS: null, zoneE: 0, zoneA: 0, total: 3000 });
  const withSides = { ...stair, entrySide: LEFT, arrivalSide: LEFT };
  const r = resolveStraightPorts(withSides, info);
  assert.deepEqual([r.entry, r.arrival, r.entryS, r.arrivalS, r.zoneE, r.zoneA], ['side', 'side', 0, 1, 1000, 1000], '北向きの上り口の左＝s 0、到達口は逆向きなので左＝s 1');
  // 2 行: 上り口を先に確保し、到達口は残りに収まらないので走行端
  const two = straightStair([0, 1000, 2000], 2);
  const info2 = straightPortInfoOf(measureStairSpans(two.stair, two.graph));
  const r2 = resolveStraightPorts({ ...two.stair, entrySide: RIGHT, arrivalSide: RIGHT }, info2);
  assert.deepEqual([r2.entry, r2.arrival], ['side', 'end']);
  // 1 行・実測なし
  const one = straightStair([0, 1000], 2);
  const info1 = straightPortInfoOf(measureStairSpans(one.stair, one.graph));
  assert.equal(resolveStraightPorts({ ...one.stair, entrySide: LEFT }, info1).entry, 'end');
  assert.equal(resolveStraightPorts({ ...stair, entrySide: LEFT }, null).entry, 'end');
  // portSideValue（保存値の語彙へ戻す）
  assert.equal(portSideValue(withSides, 'entry', r), LEFT);
  assert.equal(portSideValue(withSides, 'arrival', r), LEFT);
});

test('resolvePorts/portZoneLen: 型を問わない入口。直進は先頭・末尾の行、U字は区画、矩折は区画の行（直進の実測では null／0）、曲がりほかは null／0', () => {
  const { graph, stair } = straightStair(ROWS3, 2);
  const spans = measureStairSpans(stair, graph);
  assert.equal(portZoneLen(stair, spans, 'entry'), 1000);
  assert.equal(portZoneLen(stair, spans, 'arrival'), 1000);
  assert.equal(resolvePorts(stair, spans).entry, 'end');
  assert.equal(resolvePorts({ ...stair, type: StairType.L_TURN }, spans), null);
  assert.equal(portZoneLen({ ...stair, type: StairType.L_TURN }, spans, 'entry'), 0);
  assert.equal(resolvePorts(stair, null), null, '実測できない直進は null');
  assert.throws(() => portZoneLen(stair, spans, 'middle'), /entry/);
});

// ---- 矩折（ステップ9c。区画はアーム1の基端の行・アーム2の末端の行）----

// 右向き（right）・flip 無しの L 字: 下の横帯（アーム1。x が増える向きに上る）＋コーナー（右下）＋右の縦帯（アーム2。上へ上る）。
// 正規化 (u,v) = (x, y)。arm1/arm2 はアームの行数。階段は x 0〜(arm1+1)*1000, y 0〜(arm2+1)*1000
function lTurnStair(extra = {}, { arm1 = 3, arm2 = 3, type = StairType.L_TURN } = {}) {
  const g = grid(Array.from({ length: arm1 + 2 }, (_, i) => i * 1000), Array.from({ length: arm2 + 2 }, (_, i) => i * 1000));
  const keys = [];
  for (let i = 0; i <= arm1; i++) keys.push(g.cell(i, arm2));
  for (let j = 0; j < arm2; j++) keys.push(g.cell(arm1, j));
  const stair = g.graph.addStair({ type, cells: new Set(keys), upDirection: 'right', flip: false, sections: [10, 1, 10], ...extra });
  return { ...g, stair };
}

test('sideToHi: 進行方向の左右を幅方向の高低へ（上り口はアーム1を +u へ、到達口はアーム2を −v へ歩く）。flip・向きで物理的に入れ替わる。sideOfHi は逆写像', () => {
  const mk = (upDirection, flip) => ({ upDirection, flip });
  // [向き, flip, 上り口の左→高低, 到達口の左→高低]（画面 y 下向き。歩く向きの左手の側に高い側（外周側）があれば 1）
  const table = [
    ['right', false, 0, 0], // 東へ歩く: 左＝北、高い側 v=1 は南 → 0。到達口は北へ歩く: 左＝西、高い側 u=1 は東 → 0
    ['right', true, 1, 1],  // flip で v が反転（高い側 v=1 は北）
    ['down', false, 1, 1],  // 南へ歩く: 左＝東＝v+（高い側）。到達口は西へ歩く: 左＝南＝u+（高い側）
    ['left', false, 1, 1],  // 西へ歩く: 左＝南＝v+。到達口は北へ歩く: 左＝西＝u+（u は西向き）
    ['up', false, 0, 0],    // 北へ歩く: 左＝西、v+ は東 → 0。到達口は西へ歩く: 左＝南、u+ は北 → 0
  ];
  for (const [dir, flip, e, a] of table) {
    assert.equal(sideToHi(mk(dir, flip), 'entry', LEFT), e, `${dir}/${flip} 上り口の左`);
    assert.equal(sideToHi(mk(dir, flip), 'entry', RIGHT), 1 - e);
    assert.equal(sideToHi(mk(dir, flip), 'arrival', LEFT), a, `${dir}/${flip} 到達口の左`);
    assert.equal(sideToHi(mk(dir, flip), 'arrival', RIGHT), 1 - a);
    for (const port of ['entry', 'arrival']) for (const side of [LEFT, RIGHT]) {
      assert.equal(sideOfHi(mk(dir, flip), port, sideToHi(mk(dir, flip), port, side)), side, `${dir}/${flip} ${port} 往復`);
    }
  }
  assert.throws(() => sideToHi(mk('up', false), 'entry', END), /left\/right/);
  assert.throws(() => sideToHi(mk('up', false), 'middle', LEFT), /entry/);
});

test('候補（矩折 3 行ずつ）: 上り口・到達口とも end・左・右。区画は先頭（アーム1の基端）・末尾（アーム2の末端）の行', () => {
  const { graph, stair } = lTurnStair();
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry'), { sides: [END, LEFT, RIGHT], floorChecked: false });
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival'), { sides: [END, LEFT, RIGHT], floorChecked: false });
  assert.equal(hasPortSides(StairType.L_TURN), true);
  assert.equal(hasPortSides(StairType.FLARED), false);
});

test('候補（矩折 1 行のアーム）: そのアームの区画が全体で直進部が残らないので end だけ。もう一方のアームには影響しない', () => {
  const one1 = lTurnStair({}, { arm1: 1 });
  assert.deepEqual(stairPortCandidates(one1.stair, one1.graph, 'entry').sides, [END]);
  assert.deepEqual(stairPortCandidates(one1.stair, one1.graph, 'arrival').sides, [END, LEFT, RIGHT]);
  const one2 = lTurnStair({}, { arm2: 1 });
  assert.deepEqual(stairPortCandidates(one2.stair, one2.graph, 'arrival').sides, [END]);
  assert.deepEqual(stairPortCandidates(one2.stair, one2.graph, 'entry').sides, [END, LEFT, RIGHT]);
  // 2 行なら区画（1 行）を除いても直進部が残る
  const two = lTurnStair({}, { arm1: 2, arm2: 2 });
  assert.deepEqual(stairPortCandidates(two.stair, two.graph, 'entry').sides, [END, LEFT, RIGHT]);
  assert.deepEqual(stairPortCandidates(two.stair, two.graph, 'arrival').sides, [END, LEFT, RIGHT]);
});

test('候補（矩折）: 取りつき蹴上を足すと直進部が 2 段未満になる側面は候補外。鉄骨は蹴上 0 なので残る。上り口はアーム1・到達口はアーム2 の sections で判定', () => {
  const { graph, stair } = lTurnStair({ sections: [5, 1, 10] });
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry').sides, [END], '5−4=1 段');
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival').sides, [END, LEFT, RIGHT], '到達口はアーム2（10 段）で判定');
  stair.setField('structure', 'STEEL');
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry').sides, [END, LEFT, RIGHT]);
  stair.setField('structure', 'WOOD');
  stair.setField('sections', [10, 1, 5]);
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival').sides, [END]);
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry').sides, [END, LEFT, RIGHT]);
});

test('床の確認（矩折）: 上り口は自階、到達口は上階の隣が床のある部屋のときだけ。床なし・部屋なしは候補外。左右は進行方向の左右', () => {
  const { graph, stair } = lTurnStair();
  // 広い格子（x -1000〜6000, y -1000〜6000）。列 i は x=-1000+1000*i、行 j は y=-1000+1000*j から
  const wide = () => grid([-1000, 0, 1000, 2000, 3000, 4000, 5000, 6000], [-1000, 0, 1000, 2000, 3000, 4000, 5000, 6000]);
  // 上り口＝アーム1の基端の行（x 0〜1000, y 3000〜4000）: 走行端の外＝西（列 0・行 4）、左＝北（列 1・行 3）、右＝南（列 1・行 5）
  const entrySides = (west, north, south) => {
    const w = wide();
    if (west !== undefined) room(w, 0, 4, west);
    if (north !== undefined) room(w, 1, 3, north);
    if (south !== undefined) room(w, 1, 5, south);
    return stairPortCandidates(stair, graph, 'entry', { floorGraph: w.graph });
  };
  assert.deepEqual(entrySides(null, null, null), { sides: [END, LEFT, RIGHT], floorChecked: true });
  assert.deepEqual(entrySides(null, RoomFeature.VOID, null).sides, [END, RIGHT], '左（北）が吹抜けなら左は候補外');
  assert.deepEqual(entrySides(null, null, RoomFeature.STAIR_VOID).sides, [END, LEFT]);
  assert.deepEqual(entrySides(null, null, undefined).sides, [END, LEFT], '右（南）が部屋なしなら右は候補外');
  assert.deepEqual(entrySides(undefined, null, null).sides, [LEFT, RIGHT], '走行端の外が部屋なしなら end も候補外');
  // 到達口＝アーム2の末端の行（x 3000〜4000, y 0〜1000）。上階の隣: 走行端の外＝北（列 4・行 0）、西（列 3・行 1）、東（列 5・行 1）。
  // 到達口は北へ歩くので左＝西＝内側、右＝東＝外周側
  const up = wide();
  room(up, 4, 0); room(up, 3, 1, RoomFeature.VOID); room(up, 5, 1);
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival', { floorGraph: up.graph }).sides, [END, RIGHT], '西が吹抜けなら左（西）は候補外');
});

test('候補（矩折）: 曲がり階段（FLARED）は buildLTurn を共有するが end だけ（出入口は走行端固定）。resolvePorts は null、portZoneLen は 0', () => {
  const { graph, stair } = lTurnStair({ sections: [6, 2, 10], entrySide: LEFT }, { type: StairType.FLARED });
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry'), { sides: [END], floorChecked: false });
  assert.deepEqual(stairPortCandidates(stair, graph, 'arrival'), { sides: [END], floorChecked: false });
  const spans = measureStairSpans(stair, graph);
  assert.equal(resolvePorts(stair, spans), null);
  assert.equal(portZoneLen(stair, spans, 'entry'), 0);
});

test('resolvePorts/portZoneLen/portSideValue（矩折）: 区画は先頭・末尾の行。保存値 left/right は高低へ解決し、保存値の語彙へ戻る。選べない値は走行端', () => {
  const { graph, stair } = lTurnStair();
  const spans = measureStairSpans(stair, graph);
  assert.equal(portZoneLen(stair, spans, 'entry'), 1000);
  assert.equal(portZoneLen(stair, spans, 'arrival'), 1000);
  assert.equal(resolvePorts(stair, spans).entry, 'end');
  const withSides = { ...stair, entrySide: RIGHT, arrivalSide: LEFT };
  const r = resolvePorts(withSides, spans);
  assert.deepEqual([r.entry, r.arrival, r.entryHi, r.arrivalHi], ['side', 'side', 1, 0]);
  assert.equal(portSideValue(withSides, 'entry', r), RIGHT);
  assert.equal(portSideValue(withSides, 'arrival', r), LEFT);
  assert.equal(portSideValue(stair, 'entry', resolvePorts(stair, spans)), END);
  const one = lTurnStair({ entrySide: LEFT }, { arm1: 1 });
  assert.equal(resolvePorts(one.stair, measureStairSpans(one.stair, one.graph)).entry, 'end', '1 行のアーム1は走行端へ戻る');
});
