// straightPlanLayout（直進・踊場付直進の平面の解決値を数値だけで返す共有口。展開図が平面と同じ位置を使うための入口。
// uTurnPlanLayout の直進系版）の単体テスト。値は buildStairGeometry（install 枠・upper の全段）の踏面線・外周・マスの多角形と
// 一致しなければならない（抽出元の resolveStraightPlan が buildStraight / buildStraightLanding と共通）。
// 実物の PlanGraph / Plane / Stair で組む。フィクスチャは stairStraightPorts.test.js の流儀（歩く順の行の長さで走行軸の境界を作る）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StairPortSide } from '@core';
import { measureStairSpans } from './stairClassify.js';
import { buildStairGeometry, straightPlanLayout } from './stairGeometry.js';
import { roomBounds } from '../gridCells.js';
import { stairTreadFootprints } from './stairTreads.js';

const { LEFT, RIGHT } = StairPortSide;
const EPS = 1e-6;
const DIRS = ['up', 'down', 'left', 'right'];

// walk＝歩く順（上り口から到達端へ）の行の長さ。dir の上り口が走行軸の最小側（down/right）か最大側（up/left）かを吸収して境界を作る
function fixture({ dir = 'up', flip = false, walk = [1000, 1400, 600], cols = 2, type = StairType.STRAIGHT, extra = {} } = {}) {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const vertical = dir === 'up' || dir === 'down';
  const total = walk.reduce((s, v) => s + v, 0);
  const cum = [0];
  for (const w of walk) cum.push(cum.at(-1) + w);
  const along = (dir === 'up' || dir === 'left') ? cum.map(v => total - v).reverse() : cum;
  const across = Array.from({ length: cols + 1 }, (_, i) => i * 1000);
  const xs = vertical ? across : along, ys = vertical ? along : across;
  const ARCH = { labeled: false, discipline: Discipline.ARCH };
  const V = xs.map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
  const H = ys.map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH));
  const keys = [];
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) keys.push(`${V[i].id}:${H[j].id}:${V[i + 1].id}:${H[j + 1].id}`);
  const stair = graph.addStair({ type, cells: new Set(keys), upDirection: dir, flip, ...extra });
  return { graph, stair, vertical, total };
}

// 平面の全段（upper）を install の枠で。stairTreadFootprints と同じ呼び方（detail:false＝段鼻の補正なし）
const planGeom = (stair, graph, riser = 100) => buildStairGeometry(stair, roomBounds(stair.cells, graph), {
  view: 'upper', insetView: 'install', detail: false, riser, spans: measureStairSpans(stair, graph), laneGap: true, graph, collectCells: true,
});
const installGeom = (stair, graph) => buildStairGeometry(stair, roomBounds(stair.cells, graph), {
  view: 'install', detail: true, riser: 100, spans: measureStairSpans(stair, graph), laneGap: true, graph,
});
// 走行軸に直交する線分（縦走行なら水平、横走行なら鉛直）が run の位置にあるもの
const perpAt = (segs, run, vertical) => segs.filter(t => (vertical
  ? Math.abs(t.y1 - t.y2) < EPS && Math.abs(t.y1 - run) < EPS
  : Math.abs(t.x1 - t.x2) < EPS && Math.abs(t.x1 - run) < EPS));
const runOf = (t, vertical) => (vertical ? (t.y1 + t.y2) / 2 : (t.x1 + t.x2) / 2);
// 直交線の幅方向の端 [min,max]
const acrossRange = (t, vertical) => (vertical ? [Math.min(t.x1, t.x2), Math.max(t.x1, t.x2)] : [Math.min(t.y1, t.y2), Math.max(t.y1, t.y2)]);

// マスの多角形の頂点が (run, across) の矩形に収まるか。矩形の面積とマスの面積の和が等しい（余りなく敷く）ことも確かめる
function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i += 2) {
    const j = (i + 2) % poly.length;
    a += poly[i] * poly[j + 1] - poly[j] * poly[i + 1];
  }
  return Math.abs(a) / 2;
}
function assertZoneTiled(cells, range, p, rect, tag, tiled = true) {
  const picked = cells.filter(c => range && c.number >= range.from && c.number <= range.to);
  const [r0, r1] = [Math.min(rect.run0, rect.run1), Math.max(rect.run0, rect.run1)];
  const [a0, a1] = [Math.min(rect.a0, rect.a1), Math.max(rect.a0, rect.a1)];
  let sum = 0;
  for (const c of picked) {
    for (let i = 0; i < c.poly.length; i += 2) {
      const [rr, aa] = p.vertical ? [c.poly[i + 1], c.poly[i]] : [c.poly[i], c.poly[i + 1]];
      assert.ok(rr >= r0 - 0.5 && rr <= r1 + 0.5 && aa >= a0 - 0.5 && aa <= a1 + 0.5, `${tag}: セル ${c.number} の頂点 (${rr},${aa}) が区画の矩形外`);
    }
    sum += polyArea(c.poly);
  }
  if (tiled) assert.ok(Math.abs(sum - (r1 - r0) * (a1 - a0)) < 1, `${tag}: 区画のセルが矩形を余りなく敷く: ${sum} vs ${(r1 - r0) * (a1 - a0)}`);
  return picked.length;
}

// ---------------------------------------------------------------- テスト

test('直進（走行端の口）・4方向×flip: run/across が upper（install 枠）の外周・踏面線と一致。直進部は start1〜exitA を n1−1 マスに等分する', () => {
  for (const dir of DIRS) {
    for (const flip of [false, true]) {
      const tag = `${dir}/flip=${flip}`;
      const { graph, stair, vertical } = fixture({ dir, flip, extra: { sections: [15] } });
      const p = straightPlanLayout(stair, graph);
      assert.ok(p, tag);
      assert.equal(p.vertical, vertical, tag);
      assert.equal(p.hasLanding, false, tag);
      assert.equal(p.entryPort, 'end', tag);
      assert.equal(p.arrivalPort, 'end', tag);
      assert.equal(p.entryNumbers, null, tag);
      assert.equal(p.arrivalNumbers, null, tag);
      assert.equal(p.n1, 15, tag);
      assert.equal(p.n2, 0, tag);
      assert.equal(p.totalSteps, stair.totalSteps, tag);
      assert.equal(p.run.exitE, p.run.base, `${tag}: 走行端の上り口は区画なし`);
      assert.equal(p.run.start1, p.run.base, tag);
      assert.equal(p.run.exitA, p.run.end, `${tag}: 走行端の到達口は区画なし`);
      assert.equal(p.run.land1, null, tag);
      assert.equal(p.run.land2, null, tag);
      assert.equal(p.run.start2, null, tag);
      assert.equal(p.landingNumber, null, tag);
      assert.equal(p.across.entryEdge, null, tag);
      assert.equal(p.across.arrivalEdge, null, tag);
      // 走行方向: 上り口 (base) から到達端 (end) へ。up/left は軸の負方向へ歩く
      const sign = (dir === 'up' || dir === 'left') ? -1 : 1;
      assert.ok((p.run.end - p.run.base) * sign > 0, `${tag}: 歩く向き ${p.run.base}→${p.run.end}`);
      const g = planGeom(stair, graph);
      const all = [...g.treads, ...g.outline];
      for (const key of ['base', 'end']) assert.ok(perpAt(all, p.run[key], vertical).length > 0, `${tag}: ${key}=${p.run[key]} に描画線が在る`);
      // 直進部の踏面線: 内側の n1−2 本が start1〜exitA の等分点（ピッチ＝長さ÷(n1−1)）で全幅
      const pitch = (p.run.exitA - p.run.start1) / 14;
      const inner = g.treads.filter(t => (Math.abs(runOf(t, vertical) - p.run.start1) > EPS && Math.abs(runOf(t, vertical) - p.run.exitA) > EPS)
        && (vertical ? Math.abs(t.y1 - t.y2) < EPS : Math.abs(t.x1 - t.x2) < EPS));
      assert.equal(inner.length, 13, `${tag}: 内側の踏面線 n1−2 本`);
      for (let k = 1; k <= 13; k++) {
        const hit = perpAt(inner, p.run.start1 + k * pitch, vertical);
        assert.equal(hit.length, 1, `${tag}: k=${k} の踏面線`);
        const [lo, hi] = acrossRange(hit[0], vertical);
        assert.ok(Math.abs(lo - Math.min(p.across.s0, p.across.s1)) < EPS && Math.abs(hi - Math.max(p.across.s0, p.across.s1)) < EPS, `${tag}: k=${k} は全幅`);
      }
      // flip は幅方向の向きだけを反転する（s0/s1 の世界座標が入れ替わる）
      assert.equal(p.across.s0 < p.across.s1, !flip, `${tag}: flip で s0/s1 の向き`);
      assert.ok(Math.abs(p.across.mid - (p.across.s0 + p.across.s1) / 2) < EPS, tag);
      // マスの番号は余りなく 1..総蹴上数−1
      const nums = stairTreadFootprints(stair, graph, { riser: 100, insetView: 'install' }).map(c => c.number).sort((x, y) => x - y);
      assert.deepEqual(nums, Array.from({ length: 14 }, (_, i) => i + 1), tag);
    }
  }
});

test('直進・側面の上り口 e=0/1/2（左・右）× 4方向×flip: exitE は全長の 1/3（先頭の行 1000／3000）、区画のセルが 1..e で矩形を敷く', () => {
  for (const dir of DIRS) {
    for (const flip of [false, true]) {
      for (const side of [LEFT, RIGHT]) {
        for (const e of [0, 1, 2]) {
          const tag = `${dir}/flip=${flip}/${side}/e=${e}`;
          const { graph, stair, vertical } = fixture({ dir, flip, extra: { sections: [15 - e], entrySide: side, entryTurnSteps: e } });
          const p = straightPlanLayout(stair, graph);
          assert.ok(p, tag);
          assert.equal(p.entryPort, 'side', tag);
          assert.equal(p.arrivalPort, 'end', tag);
          assert.equal(p.entryTurnSteps, e, tag);
          assert.equal(p.totalSteps, stair.totalSteps, `${tag}: 総蹴上数は Stair の値`);
          assert.equal(p.n1, 15 - e, tag);
          assert.deepEqual(p.entryNumbers, e > 0 ? { from: 1, to: e } : null, tag);
          assert.equal(p.arrivalNumbers, null, tag);
          // 区画の長さの比＝先頭の行 1000／実測全長 3000（枠の逃がしによらない）
          const t = (p.run.exitE - p.run.base) / (p.run.end - p.run.base);
          assert.ok(Math.abs(t - 1 / 3) < 1e-9, `${tag}: t=${t}`);
          assert.equal(p.run.start1, p.run.exitE, tag);
          // 出入口辺: 進行方向の左右。flip なしの up で左＝x 小。辺は s0 か s1 のどちらかの壁面
          assert.ok(Math.abs(p.across.entryEdge - p.across.s0) < EPS || Math.abs(p.across.entryEdge - p.across.s1) < EPS, `${tag}: 出入口辺は側辺`);
          const g = planGeom(stair, graph);
          const all = [...g.treads, ...g.outline];
          assert.ok(perpAt(all, p.run.exitE, vertical).length > 0, `${tag}: exitE に出口境界線`);
          assert.ok(perpAt(g.treads, p.run.exitE, vertical).length > 0, `${tag}: 出口境界線は踏面線`);
          const zone = { run0: p.run.base, run1: p.run.exitE, a0: p.across.s0, a1: p.across.s1 };
          const cells = stairTreadFootprints(stair, graph, { riser: 100, insetView: 'install' });
          assert.equal(assertZoneTiled(cells, p.entryNumbers, p, zone, tag, e > 0), e, `${tag}: 区画のセル数`);
          // 区画の外の番号は e+1.. の直進部（区画のセルと重ならない）
          const rest = cells.filter(c => c.number > e);
          assert.equal(rest.length, 15 - e - 1, tag);
        }
      }
    }
  }
});

test('直進・側面の到達口 a=1/2: arrivalNumbers は S+e..S+e+a−1（stairTreadFootprints の番号）。exitA は全長の 4/5（末尾の行 600／3000）', () => {
  for (const dir of DIRS) {
    for (const flip of [false, true]) {
      for (const a of [1, 2]) {
        const tag = `${dir}/flip=${flip}/a=${a}`;
        const { graph, stair, vertical } = fixture({ dir, flip, extra: { sections: [15 - a], arrivalSide: LEFT, arrivalTurnSteps: a } });
        const p = straightPlanLayout(stair, graph);
        assert.ok(p, tag);
        assert.equal(p.arrivalPort, 'side', tag);
        assert.equal(p.entryPort, 'end', tag);
        assert.equal(p.arrivalTurnSteps, a, tag);
        assert.equal(p.totalSteps, stair.totalSteps, tag);
        // 直進部のマス n1−1 の続き（S＝n1）。到達番号（総蹴上数）は含まない
        assert.deepEqual(p.arrivalNumbers, { from: p.n1, to: p.n1 + a - 1 }, tag);
        assert.equal(p.arrivalNumbers.to, p.totalSteps - 1, tag);
        const t = (p.run.exitA - p.run.base) / (p.run.end - p.run.base);
        assert.ok(Math.abs(t - 1 + 600 / 3000) < 1e-9, `${tag}: t=${t}`);
        assert.ok(Math.abs(p.across.arrivalEdge - p.across.s0) < EPS || Math.abs(p.across.arrivalEdge - p.across.s1) < EPS, tag);
        const g = planGeom(stair, graph);
        assert.ok(perpAt(g.treads, p.run.exitA, vertical).length > 0, `${tag}: 出口境界線`);
        const cells = stairTreadFootprints(stair, graph, { riser: 100, insetView: 'install' });
        const zone = { run0: p.run.exitA, run1: p.run.end, a0: p.across.s0, a1: p.across.s1 };
        assert.equal(assertZoneTiled(cells, p.arrivalNumbers, p, zone, tag), a, `${tag}: 区画のセル数`);
        const nums = cells.map(c => c.number).sort((x, y) => x - y);
        assert.deepEqual(nums, Array.from({ length: p.totalSteps - 1 }, (_, i) => i + 1), `${tag}: 余りなく 1..総蹴上数−1`);
      }
    }
  }
});

test('直進・両口が側面（上り口 e=2・到達口 a=1）: 番号は 1..2 / S+2..S+2、直進部は exitE〜exitA の n1−1 マス', () => {
  const { graph, stair, vertical } = fixture({ extra: { sections: [12], entrySide: LEFT, entryTurnSteps: 2, arrivalSide: RIGHT, arrivalTurnSteps: 1 } });
  const p = straightPlanLayout(stair, graph);
  assert.ok(p);
  assert.equal(stair.totalSteps, 15);
  assert.deepEqual(p.entryNumbers, { from: 1, to: 2 });
  assert.deepEqual(p.arrivalNumbers, { from: 14, to: 14 }, '直進部の番号 3..13 の次');
  assert.equal(p.totalSteps, 15);
  const cells = stairTreadFootprints(stair, graph, { riser: 100, insetView: 'install' });
  assert.deepEqual(cells.map(c => c.number).sort((x, y) => x - y), Array.from({ length: 14 }, (_, i) => i + 1));
  const g = planGeom(stair, graph);
  const pitch = (p.run.exitA - p.run.exitE) / 11;
  for (let k = 1; k <= 10; k++) assert.equal(perpAt(g.treads, p.run.exitE + k * pitch, vertical).length, 1, `k=${k}`);
});

test('踊場付直進（走行端の口）・4方向×flip: land1/land2 は踊場の手前・奥の縁（踏面線）、start2＝land2、直進部は各 n−1 マス。landingNumber は n1', () => {
  for (const dir of DIRS) {
    for (const flip of [false, true]) {
      const tag = `${dir}/flip=${flip}`;
      const { graph, stair, vertical } = fixture({ dir, flip, walk: [2000, 1000, 2000], type: StairType.STRAIGHT_LANDING, extra: { sections: [7, 1, 8] } });
      assert.deepEqual(measureStairSpans(stair, graph).lengths, [2000, 1000, 2000], tag);
      const p = straightPlanLayout(stair, graph);
      assert.ok(p, tag);
      assert.equal(p.hasLanding, true, tag);
      assert.equal(p.n1, 7, tag);
      assert.equal(p.n2, 8, tag);
      assert.equal(p.landingNumber, 7, tag);
      assert.equal(p.totalSteps, 15, tag);
      assert.equal(p.run.start2, p.run.land2, tag);
      assert.equal(p.run.start1, p.run.base, tag);
      assert.equal(p.run.exitA, p.run.end, tag);
      // 走行長の比 2000:1000:2000（枠の逃がしによらない）
      const span = p.run.end - p.run.base;
      assert.ok(Math.abs((p.run.land1 - p.run.base) / span - 0.4) < 1e-9, tag);
      assert.ok(Math.abs((p.run.land2 - p.run.base) / span - 0.6) < 1e-9, tag);
      const g = planGeom(stair, graph);
      for (const key of ['land1', 'land2']) assert.ok(perpAt(g.treads, p.run[key], vertical).length > 0, `${tag}: ${key} は踏面線`);
      // 直進部 1 は n1−1＝6 マス（内側 5 本）、直進部 2 は n2−1＝7 マス（内側 6 本）
      const p1 = (p.run.land1 - p.run.start1) / 6, p2 = (p.run.end - p.run.land2) / 7;
      for (let k = 1; k <= 5; k++) assert.equal(perpAt(g.treads, p.run.start1 + k * p1, vertical).length, 1, `${tag}: 直進部1 k=${k}`);
      for (let k = 1; k <= 6; k++) assert.equal(perpAt(g.treads, p.run.land2 + k * p2, vertical).length, 1, `${tag}: 直進部2 k=${k}`);
      // 踊場のマスの番号は n1（上り口の取りつきなし）
      const cells = stairTreadFootprints(stair, graph, { riser: 100, insetView: 'install' });
      const land = cells.find(c => c.number === p.landingNumber);
      assert.ok(land, tag);
      assert.ok(Math.abs(polyArea(land.poly) - Math.abs(p.run.land2 - p.run.land1) * Math.abs(p.across.s1 - p.across.s0)) < 1, `${tag}: 踊場のマスは全幅の矩形`);
    }
  }
});

test('install の外周: 走行端の口の base は従来どおり設置枠の縁、側面の上り口の base は壁の面（upper と同じ）まで内側', () => {
  const plain = fixture({ extra: { sections: [15] } });
  const side = fixture({ extra: { sections: [11], entrySide: LEFT, entryTurnSteps: 4 } });
  for (const [name, { graph, stair }, inset] of [['走行端', plain, false], ['側面', side, true]]) {
    const p = straightPlanLayout(stair, graph);
    const b = roomBounds(stair.cells, graph);
    const g = installGeom(stair, graph);
    assert.ok(perpAt([...g.treads, ...g.outline], p.run.base, true).length > 0, `${name}: base に install の描画線`);
    // up の始端は y2。壁が無いので逃がしは固定の WALL_INSET（>0）
    assert.equal(p.run.base === b.y2, !inset, `${name}: base=${p.run.base} b.y2=${b.y2}`);
  }
});

test('失敗系: 直進系でない・階段/graph なし・セルが空・解決できないセルなら null（例外にしない）', () => {
  const { graph, stair } = fixture({ extra: { sections: [15] } });
  assert.ok(straightPlanLayout(stair, graph));
  assert.equal(straightPlanLayout(null, graph), null);
  assert.equal(straightPlanLayout(stair, null), null);
  for (const type of [StairType.SWITCHBACK, StairType.WINDING, StairType.L_TURN, StairType.FLARED, StairType.OPEN_WELL]) {
    const fx = fixture({ extra: { sections: [15] } });
    fx.stair.type = type;
    assert.equal(straightPlanLayout(fx.stair, fx.graph), null, type);
  }
  stair.setCells(new Set());
  assert.equal(straightPlanLayout(stair, graph), null, 'セルが空');
  stair.setCells(new Set(['no-such:cell:key:here']));
  assert.equal(straightPlanLayout(stair, graph), null, '解決できないセル');
});

test('失敗系: 選べない保存値（1 行の直進）は走行端と同じ値（entryPort end・numbers null・区画なし）', () => {
  const one = fixture({ walk: [1000], extra: { sections: [11], entrySide: LEFT, entryTurnSteps: 4 } });
  const p = straightPlanLayout(one.stair, one.graph);
  assert.ok(p);
  assert.equal(p.entryPort, 'end');
  assert.equal(p.entryTurnSteps, 0);
  assert.equal(p.entryNumbers, null);
  assert.equal(p.run.exitE, p.run.base);
});

test('straightPlanLayout の呼び出しは描画に影響しない: 前後で buildStairGeometry（install・upper）が変わらず、自身も繰り返して同じ値', () => {
  const cases = [
    fixture({ flip: true, extra: { sections: [15] } }),
    fixture({ extra: { sections: [9], entrySide: LEFT, entryTurnSteps: 3, arrivalSide: RIGHT, arrivalTurnSteps: 3 } }),
    fixture({ walk: [2000, 1000, 2000], type: StairType.STRAIGHT_LANDING, extra: { sections: [7, 1, 8] } }),
  ];
  for (const { graph, stair } of cases) {
    const i1 = installGeom(stair, graph), u1 = planGeom(stair, graph);
    const p1 = straightPlanLayout(stair, graph);
    assert.deepEqual(installGeom(stair, graph), i1, stair.type);
    assert.deepEqual(planGeom(stair, graph), u1, stair.type);
    assert.deepEqual(straightPlanLayout(stair, graph), p1, stair.type);
  }
});
