// 回り階段（WINDING）の周回部の共有辺。180°周回部を往路側90°・復路側90°の2回転部とみなし、
// マス数 n が偶数のときだけ存在する中央の放射線（u=0.5）を、他の放射線と同じ pivot P から
// 奥の辺（外壁側）へ垂直（走行軸に平行）に引く（ユーザー指示 2026-10-06「pivot はこの踏面だけ変えず、
// そこから外壁へ向かって垂直線」。当初の「閉じ辺の中点 Q から」は差し戻し）。
// 他の放射線・段数字・矢印・閉じ辺は従来のまま。あき0・奇数nは従来の線と一致する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType, totalStepsFromSections } from '@core';
import { buildStairGeometry, makeFrame } from './stairGeometry.js';

const BOUNDS = { x1: 0, y1: 0, x2: 2000, y2: 4000 };
const EPS = 1e-3;
const stairOf = (sections, upDirection = 'up', flip = false, type = StairType.WINDING) => ({
  type, upDirection, flip, tread: 250, totalSteps: totalStepsFromSections(sections), sections,
});
const build = (stair, { laneGap = true, view = 'upper', detail = true } = {}) =>
  buildStairGeometry(stair, BOUNDS, { view, detail, riser: null, spans: null, laneGap });
const near = (a, b) => Math.abs(a - b) < EPS;
const same = (p, q) => near(p.x, q.x) && near(p.y, q.y);
const ends = (s) => [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }];

// 正規化座標（run方向 t・幅方向 s）の逆写像。frame は軸平行なので内積で足りる。
// 描画枠は設置枠から全周 sideInsetMm だけ内側（g.sideInsetMm）。
function normOf(stair, g) {
  const m = g.sideInsetMm;
  const f = makeFrame(stair, { x1: BOUNDS.x1 + m, y1: BOUNDS.y1 + m, x2: BOUNDS.x2 - m, y2: BOUNDS.y2 - m });
  return { f, norm: (p) => ({ t: f.tOf(p), s: f.sOf(p) }) };
}

// 閉じ辺（heavy）と、pivot P（閉じ辺の往路側端）・中点 Q・tRun・sA
function closedEdgeInfo(stair, g) {
  const heavy = g.treads.filter((s) => s.heavy);
  assert.equal(heavy.length, 1);
  const { norm } = normOf(stair, g);
  const [a, b] = ends(heavy[0]);
  const na = norm(a), nb = norm(b);
  const [pn] = na.s < nb.s ? [na] : [nb]; // s が小さい側＝往路側（pivot）
  const P = na.s < nb.s ? a : b;
  return { heavy: heavy[0], P, Q: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, tRun: pn.t, sA: pn.s, norm };
}

// pivot から出る放射線（入口境界・閉じ辺を除く）
function radialsFromP(g, info) {
  return g.treads.filter((s) => {
    if (s.heavy) return false;
    const [a, b] = ends(s);
    const touchesP = same(a, info.P) || same(b, info.P);
    const alongColumn = near(info.norm(a).t, info.tRun) && near(info.norm(b).t, info.tRun);
    return touchesP && !alongColumn;
  });
}

// pivot から出る放射線のうち、奥の辺（t=1）上の s=sA に達する垂直線（＝共有辺）
function sharedEdgesOf(g, info) {
  return radialsFromP(g, info).filter((s) => {
    const [a, b] = ends(s);
    const far = same(a, info.P) ? b : a;
    const nf = info.norm(far);
    return near(nf.t, 1) && near(nf.s, info.sA);
  });
}

const DIRS = ['up', 'down', 'left', 'right'];

for (const upDirection of DIRS) {
  for (const flip of [false, true]) {
    test(`WINDING n=6 ${upDirection}/flip=${flip}: 共有辺は pivot から奥の辺へ垂直（s=sA）に1本、放射線は全部 pivot 起点`, () => {
      const stair = stairOf([7, 6, 4], upDirection, flip);
      const g = build(stair);
      const info = closedEdgeInfo(stair, g);
      assert.ok(info.sA < 0.5, 'あきがある（sA<0.5）');

      // pivot 起点の放射線は n-1=5 本（共有辺を含む）。閉じ辺の中点 Q を端点に持つ線は無い
      assert.equal(radialsFromP(g, info).length, 5);
      assert.equal(g.treads.filter((s) => !s.heavy && ends(s).some((p) => same(p, info.Q))).length, 0, 'Q 起点の線は無い');

      // 共有辺＝pivot から奥の辺の s=sA へ。ちょうど1本で、閉じ辺（幅方向）と直交する
      const shared = sharedEdgesOf(g, info);
      assert.equal(shared.length, 1);
      const hv = { x: info.heavy.x2 - info.heavy.x1, y: info.heavy.y2 - info.heavy.y1 };
      const sv = { x: shared[0].x2 - shared[0].x1, y: shared[0].y2 - shared[0].y1 };
      assert.ok(Math.abs(hv.x * sv.x + hv.y * sv.y) < EPS, '閉じ辺と直交（走行軸に平行）');
    });
  }
}

// HEAD（当初の共有辺の変更前）の出力の写し。n=6・up/flip=false・LANE_GAP・upper・detail。
const HEAD_RADIALS = [
  { x1: 950, y1: 1556.624872, x2: 57.5, y2: 807.062436 },
  { x1: 950, y1: 1556.624872, x2: 57.5, y2: 57.5 },
  { x1: 950, y1: 1556.624872, x2: 1942.5, y2: 57.5 },
  { x1: 950, y1: 1556.624872, x2: 1942.5, y2: 807.062436 },
];
const HEAD_SHARED = { x1: 950, y1: 1556.624872, x2: 1000, y2: 57.5 }; // pivot→perim(0.5)（あき分だけ傾く）
const NEW_SHARED = { x1: 950, y1: 1556.624872, x2: 950, y2: 57.5 };   // pivot→(1, sA)（垂直）
const segNear = (a, b) => ['x1', 'y1', 'x2', 'y2'].every((k) => near(a[k], b[k]));
const hasSeg = (list, seg) => list.some((s) => segNear(s, seg));

test('WINDING n=6: 共有辺以外の放射線は変更前と同一で、共有辺だけが pivot から垂直 (950,1556.6)→(950,57.5) に変わる', () => {
  const g = build(stairOf([7, 6, 4]));
  for (const r of HEAD_RADIALS) assert.ok(hasSeg(g.treads, r), `放射線が消えた/動いた ${JSON.stringify(r)}`);
  assert.ok(!hasSeg(g.treads, HEAD_SHARED), '旧共有辺（perim(0.5) へ傾く線）が残っている');
  assert.ok(!hasSeg(g.treads, { x1: 1000, y1: 1556.624872, x2: 1000, y2: 57.5 }), 'Q 起点の共有辺が残っている');
  assert.ok(hasSeg(g.treads, NEW_SHARED), '新共有辺が無い');
  assert.equal(g.treads.length, 15, '踏面線の本数は変更前と同じ');
});

test('WINDING n=6: 段数字・矢印・閉じ辺・外形は変更前と同一', () => {
  const g = build(stairOf([7, 6, 4]));
  const nums = g.stepNumbers.map((n) => [n.text, Math.round(n.x * 1000) / 1000, Math.round(n.y * 1000) / 1000]);
  assert.deepEqual(nums, [
    ['1', 340.25, 3843.089], ['2', 340.25, 3445.443], ['3', 340.25, 3047.797], ['4', 340.25, 2650.151],
    ['5', 340.25, 2252.505], ['6', 340.25, 1854.859], ['7', 340.25, 1457.213], ['8', 325.25, 769.584],
    ['9', 655.125, 507.237], ['10', 1314.875, 507.237], ['11', 1644.75, 769.584], ['12', 1644.75, 1294.278],
    ['13', 1659.75, 1755.448], ['14', 1659.75, 2550.74], ['15', 1659.75, 3346.031], ['16', 1659.75, 4141.323],
  ]);
  assert.deepEqual(g.arrows[0].points.map((v) => Math.round(v * 1000) / 1000),
    [1496.25, 3942.5, 1496.25, 807.062, 503.75, 807.062, 503.75, 3942.5]);
  assert.equal(g.outline.length, 9);
  assert.ok(g.treads.some((s) => s.heavy && segNear(s, { x1: 950, y1: 1556.624872, x2: 1050, y2: 1556.624872 })));
});

test('WINDING あき0（簡略LOD）: 周回部の踏面線は変更前と一致する（sA=0.5 で共有辺は pivot から奥の辺中点へ）', () => {
  for (const upDirection of DIRS) {
    const stair = stairOf([7, 6, 4], upDirection);
    const g = build(stair, { laneGap: false, detail: false });
    assert.equal(g.treads.filter((s) => s.heavy).length, 0);
    // 変更前の共有辺 = pivot(tRun,0.5) → perim(0.5)=(1,0.5)。新共有辺 pivot→(1,sA=0.5) と端点が同じ。
    const { f, norm } = normOf(stair, g);
    const target = { a: f.pt(1, 0.5) };
    const hit = g.treads.filter((s) => ends(s).some((p) => same(p, target.a)));
    assert.equal(hit.length, 1);
    const other = same(ends(hit[0])[0], target.a) ? ends(hit[0])[1] : ends(hit[0])[0];
    assert.ok(near(norm(other).s, 0.5), 'pivot は s=0.5');
  }
});

test('WINDING あき0: 全踏面線が変更前と同一（up/flip=false の写し）', () => {
  // 変更前の踏面線は共有辺も含め pivot (950+50=1000, 1556.6) 起点。共有辺は (1000,1556.6)→(1000,57.5) で同じ。
  const g = build(stairOf([7, 6, 4]), { laneGap: false, detail: false });
  assert.ok(hasSeg(g.treads, { x1: 1000, y1: 1556.624872, x2: 1000, y2: 57.5 }));
});

test('失敗系: n=5（奇数）は共有辺が無く、pivot から奥の辺の s=sA へ向かう垂直線は0本・放射線4本が pivot 起点のまま', () => {
  const stair = stairOf([7, 5, 4]);
  const g = build(stair);
  const info = closedEdgeInfo(stair, g);
  assert.equal(sharedEdgesOf(g, info).length, 0);
  assert.equal(radialsFromP(g, info).length, 4);
});

test('失敗系: SWITCHBACK（n=1）は周回部の放射線を持たない', () => {
  const stair = stairOf([7, 1, 6], 'up', false, StairType.SWITCHBACK);
  const g = build(stair);
  const heavy = g.treads.find((s) => s.heavy);
  assert.ok(heavy);
  const m = { x: (heavy.x1 + heavy.x2) / 2, y: (heavy.y1 + heavy.y2) / 2 };
  assert.equal(g.treads.filter((s) => !s.heavy && ends(s).some((p) => same(p, m))).length, 0);
});

test('n=2: 唯一の放射線が共有辺（pivot から奥の辺の s=sA への垂直線）になる', () => {
  for (const upDirection of DIRS) {
    const stair = stairOf([7, 2, 4], upDirection);
    const g = build(stair);
    const info = closedEdgeInfo(stair, g);
    assert.equal(radialsFromP(g, info).length, 1, 'pivot 起点の放射線は共有辺の1本だけ');
    assert.equal(sharedEdgesOf(g, info).length, 1);
    assert.equal(g.treads.filter((s) => !s.heavy && ends(s).some((p) => same(p, info.Q))).length, 0, 'Q 起点の線は無い');
  }
});
