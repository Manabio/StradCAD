// uTurnPlanLayout（折返し・回り階段の平面の解決値を数値だけで返す共有口。展開図が平面と同じ位置を使うための入口）の単体テスト。
// 値は buildStairGeometry（install）の踏面線・前縁・到達辺・外周と一致しなければならない（抽出元の resolveUTurnPlan が共通）。
// 実物の PlanGraph / Plane / Stair で組む。フィクスチャは stairPortSide.test.js（張り出し f,b,c,d,a）・stairTreads.test.js（等長レーン）の流儀。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType } from '@core';
import { classifyStairArea, measureStairSpans } from './stairClassify.js';
import { buildStairGeometry, uTurnPlanLayout, turnPivotS } from './stairGeometry.js';
import { roomBounds, refreshCells } from '../gridCells.js';
import { faceRect } from '../wallFaces.js';
import { stairTreadFootprints } from './stairTreads.js';
import { PARTITION_BACKING_MM, PARTITION_THICKNESS_MM, arrivalBeamFaceMm } from './stairPartition.js';
import { generateStairPartitionWalls } from './stairPartitionWalls.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../structural/structureRules.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const EPS = 1e-9;
const H = PARTITION_BACKING_MM / 2; // 柱材の半幅 45

// ---------------------------------------------------------------- フィクスチャ

// 張り出し（往路が長い）: 2列×3行  d c / a b / e f（y下向き正）。f,b,c,d,a の順で歩く（上り口＝f の左辺・到達口＝a の下辺）
function overhangFixture(entryTurnSteps) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH);
  const Hh = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH);
  const x0 = V(0), x1 = V(1000), x2 = V(2000), y0 = Hh(0), y1 = Hh(1000), y2 = Hh(2000), y3 = Hh(3000);
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  const c = { d: k(x0, y0, x1, y1), c: k(x1, y0, x2, y1), a: k(x0, y1, x1, y2), b: k(x1, y1, x2, y2), f: k(x1, y2, x2, y3) };
  const keys = ['f', 'b', 'c', 'd', 'a'].map(n => c[n]);
  const cells = new Set(keys);
  const cls = classifyStairArea(cells, graph, 2800, keys);
  const stair = graph.addStair({
    type: cls.type, cells, upDirection: cls.upDirection, flip: cls.flip, sections: cls.sections,
    entryTurnSteps, arrivalTurnSteps: cls.arrivalTurnSteps ?? 0,
  });
  graph.setStructureOverride('木造（在来）');
  stair.structure = StructuralMaterialType.WOOD;
  return { graph, stair };
}

// 等長レーン＋全幅の踊り場（4方向）。dir＝上り方向。踊り場は上り方向の奥側の1行（幅1000）、往路・復路は残り3000
function equalFixture(type, dir, flip, { wood = true } = {}) {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const vertical = dir === 'up' || dir === 'down';
  // 走行軸の境界（ランディングが奥）。up は y が小さい側が奥、down は大きい側、left は x が小さい側、right は大きい側
  const along = { up: [0, 1000, 4000], down: [0, 3000, 4000], left: [0, 1000, 4000], right: [0, 3000, 4000] }[dir];
  const across = [0, 1000, 2000];
  const xs = vertical ? across : along, ys = vertical ? along : across;
  const V = xs.map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
  const Hl = ys.map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH));
  const cell = (i, j) => `${V[i].id}:${Hl[j].id}:${V[i + 1].id}:${Hl[j + 1].id}`;
  const keys = [];
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) keys.push(cell(i, j));
  const stair = graph.addStair({ type, cells: new Set(keys), sections: [6, type === StairType.WINDING ? 2 : 1, 6], flip, upDirection: dir });
  stair.structure = wood ? StructuralMaterialType.WOOD : StructuralMaterialType.STEEL;
  graph.setStructureOverride('木造（在来）');
  return { graph, stair };
}

// 隔て壁（オーナー壁＋薄壁）を足し、両端の自由端を柱包み（物理端のはね出し ±57.5）にする
const addPartitionWalls = (graph) => {
  for (const w of generateStairPartitionWalls(graph, { structure: TRADITIONAL_WOOD_STRUCTURE })) {
    const sign = Math.sign(w.clEnd.effectiveValue - w.clStart.effectiveValue) || 1;
    w.startOffset = -sign * 57.5;
    w.endOffset = sign * 57.5;
  }
};
// [名前, 柱の半幅, 壁の追加]。壁が無ければ柱材の面（±45）、PB 包みの壁があれば PB の外面（±57.5）
const VARIANTS = [['柱材の面（壁なし）', H, () => {}], ['PB の外面（包み壁あり）', PARTITION_THICKNESS_MM / 2, addPartitionWalls]];

const installGeom = (stair, graph) => buildStairGeometry(stair, roomBounds(stair.cells, graph), {
  view: 'install', detail: true, riser: 200, spans: measureStairSpans(stair, graph), laneGap: true, graph,
});
// 走行軸に直交する線分（縦走行なら水平、横走行なら鉛直）が run の位置にあるか
const perpAt = (segs, run, vertical) => segs.filter(t => (vertical
  ? Math.abs(t.y1 - t.y2) < EPS && Math.abs(t.y1 - run) < EPS
  : Math.abs(t.x1 - t.x2) < EPS && Math.abs(t.x1 - run) < EPS));

// ---------------------------------------------------------------- テスト

test('張り出し（f,b,c,d,a）: run は柱の面（Q1＝exitA・Q3＝baseB・P1＝frontA・P2/P3＝front）。PB 包みあり／なし・取りつき回転部 4/1/0 段', () => {
  for (const [name, half, setup] of VARIANTS) {
    for (const e of [4, 1, 0]) {
      const tag = `${name} e=${e}`;
      const { graph, stair } = overhangFixture(e);
      setup(graph);
      const p = uTurnPlanLayout(stair, graph);
      assert.ok(p, tag);
      assert.equal(p.vertical, true, tag);
      // 通り芯 y=2000（入口柱）・1000（回転部側の柱）。上り口は南（y が大きい側）
      assert.ok(Math.abs(p.run.exitA - (2000 + half)) < EPS, `${tag}: exitA＝Q1 の面 ${p.run.exitA}`);
      assert.ok(Math.abs(p.run.baseB - (2000 - half)) < EPS, `${tag}: baseB＝Q3 の面 ${p.run.baseB}`);
      assert.ok(Math.abs(p.run.frontA - (1000 + half)) < EPS, `${tag}: frontA＝P1 の面 ${p.run.frontA}`);
      assert.ok(Math.abs(p.run.front - (1000 - half)) < EPS, `${tag}: front＝P2・P3 の面 ${p.run.front}`);
      assert.equal(p.run.startA, p.run.exitA, `${tag}: 側面の上り口は直進部が区画の出口から始まる`);
      assert.equal(p.run.startB, p.run.baseB, `${tag}: 到達口は走行端（直進部の終端＝基端）`);
      assert.ok(p.run.baseA > p.run.exitA && p.run.baseA > p.run.baseB, `${tag}: 往路の基端が最も手前（南） ${p.run.baseA}`);
      assert.ok(p.run.back < p.run.front, `${tag}: 奥（北） ${p.run.back}`);
      assert.equal(p.hasColumn, true, tag);
      assert.equal(p.entryPort, 'inner', tag);
      assert.equal(p.arrivalPort, 'end', tag);
      assert.equal(p.entryTurnSteps, e, tag);
      assert.equal(p.arrivalTurnSteps, 0, tag);
      assert.equal(p.n1, stair.sections[0], tag);
      assert.equal(p.n2, stair.sections[2], tag);
      assert.equal(p.turnCells, stair.sections[1], tag);
      // 回転部の最初の段数字＝往路のマス（n1−1）の次＋取りつき回転部の蹴上数
      assert.equal(p.firstTurnNumber, stair.sections[0] + e, tag);

      // 描画（install）と一致: 踏面線・外周が同じ走行座標に在る
      const g = installGeom(stair, graph);
      const all = [...g.treads, ...g.outline];
      for (const key of ['exitA', 'frontA', 'front', 'baseB', 'back']) {
        assert.ok(perpAt(all, p.run[key], true).length > 0, `${tag}: ${key}=${p.run[key]} に描画線が在る`);
      }
      assert.ok(perpAt(g.treads, p.run.frontA, true).length > 0, `${tag}: frontA は踏面線`);
      assert.ok(perpAt(g.treads, p.run.front, true).length > 0, `${tag}: front は踏面線`);
      assert.ok(perpAt(g.outline.filter(s => s.port === 'arrival'), p.run.baseB, true).length > 0, `${tag}: baseB は到達辺`);
      // 幅方向: あき閉じ辺（heavy。front 上で sA→sB）の両端
      const heavy = g.treads.find(t => t.heavy);
      assert.ok(heavy, `${tag}: あき閉じ辺`);
      const xs = [heavy.x1, heavy.x2].sort((a, b) => a - b);
      assert.ok(Math.abs(xs[0] - Math.min(p.across.sA, p.across.sB)) < EPS && Math.abs(xs[1] - Math.max(p.across.sA, p.across.sB)) < EPS, `${tag}: ${xs} vs ${JSON.stringify(p.across)}`);
      assert.ok(Math.abs(Math.abs(p.across.sB - p.across.sA) - PARTITION_THICKNESS_MM) < 1e-6, `${tag}: あき＝隔て壁の総厚`);
      assert.ok(p.across.mid > Math.min(p.across.sA, p.across.sB) - EPS && p.across.mid < Math.max(p.across.sA, p.across.sB) + EPS, `${tag}: mid はあきの中`);
    }
  }
});

test('等長レーン・4方向×flip×SWITCHBACK/WINDING×柱の変種: run/across が install の描画線と一致（縦走行は y・横走行は x）', () => {
  for (const type of [StairType.SWITCHBACK, StairType.WINDING]) {
    for (const dir of ['up', 'down', 'left', 'right']) {
      for (const flip of [false, true]) {
        for (const [name, , setup] of VARIANTS) {
          const tag = `${type}/${dir}/flip=${flip}/${name}`;
          const { graph, stair } = equalFixture(type, dir, flip);
          setup(graph);
          const p = uTurnPlanLayout(stair, graph);
          assert.ok(p, tag);
          const vertical = dir === 'up' || dir === 'down';
          assert.equal(p.vertical, vertical, tag);
          const g = installGeom(stair, graph);
          const all = [...g.treads, ...g.outline];
          for (const key of ['baseA', 'baseB', 'back']) {
            assert.ok(perpAt(g.outline, p.run[key], vertical).length > 0, `${tag}: ${key}=${p.run[key]} は外周線`);
          }
          for (const key of ['frontA', 'front']) {
            assert.ok(perpAt(g.treads, p.run[key], vertical).length > 0, `${tag}: ${key}=${p.run[key]} は踏面線`);
          }
          assert.equal(p.run.startA, p.run.baseA, `${tag}: 走行端の上り口は直進部が基端から始まる`);
          assert.equal(p.run.startB, p.run.baseB, tag);
          assert.ok(all.length > 0, tag);
          // 幅方向: 往路外側 s0 → 往路内側 sA → 復路内側 sB → 復路外側 s1 は単調（flip で向きだけ反転）
          const a = [p.across.s0, p.across.sA, p.across.sB, p.across.s1];
          const inc = a[3] > a[0];
          a.slice(1).forEach((v, i) => assert.ok(inc ? v >= a[i] - EPS : v <= a[i] + EPS, `${tag}: 単調 ${a}`));
          assert.ok(Math.abs(Math.abs(p.across.sB - p.across.sA) - PARTITION_THICKNESS_MM) < 1e-6, `${tag}: あき`);
          assert.equal(p.hasColumn, true, tag);
          assert.equal(p.entryPort, 'end', tag);
          assert.equal(p.entryTurnSteps, 0, tag);
          // 前縁は柱の面: 往路側は上り口側（手前）、復路側は回転部側（奥）へ半幅ぶんずれる
          const sign = Math.sign(p.run.back - p.run.baseA);
          assert.ok((p.run.front - p.run.frontA) * sign > 0, `${tag}: front は frontA より奥 ${p.run.frontA} ${p.run.front}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------- 入口柱が基端にあるレーンの基端（2026-10-13 裁定: 等長レーンも Q1/Q3）

// equalFixture の基端の通り芯座標（走行軸）と、基端→回転部へ向かう符号
const BASE0 = { up: 4000, down: 0, left: 4000, right: 0 };
const TOWARD = { up: -1, down: 1, left: -1, right: 1 };
// 基端の辺（up＝下辺・down＝上辺・left＝右辺・right＝左辺）に壁を足す（室側仕上げ面は通り芯から 72.5 内側）
function addBaseWall(graph, stair, dir) {
  const ks = [...stair.cells].map(k => k.split(':'));
  const cl = (id) => graph.shapeMap.get(id);
  const ls = [...new Set(ks.flatMap(([l, , r]) => [l, r]))].map(cl).sort((a, b) => a.value - b.value);
  const ts = [...new Set(ks.flatMap(([, t, , b]) => [t, b]))].map(cl).sort((a, b) => a.value - b.value);
  const [vLo, vHi] = [ls[0], ls[ls.length - 1]], [hLo, hHi] = [ts[0], ts[ts.length - 1]];
  switch (dir) {
    case 'up':    return graph.addWall(hHi, -72.5, false, vLo, 0, vHi, 0, { isRoomWall: true, wallFinish: 12.5 });
    case 'down':  return graph.addWall(hLo, 72.5, false, vLo, 0, vHi, 0, { isRoomWall: true, wallFinish: 12.5 });
    case 'left':  return graph.addWall(vHi, -72.5, true, hLo, 0, hHi, 0, { isRoomWall: true, wallFinish: 12.5 });
    default:      return graph.addWall(vLo, 72.5, true, hLo, 0, hHi, 0, { isRoomWall: true, wallFinish: 12.5 });
  }
}
// 段 number のマスの走行軸方向の範囲 [lo, hi]
const runExtent = (fps, number, vertical) => {
  const poly = fps.find(c => c.number === number).poly;
  const vs = poly.filter((_, i) => (i % 2 === 1) === vertical);
  return [Math.min(...vs), Math.max(...vs)];
};

test('【等長レーン・上り口が開いている（壁なし）】往路の基端が Q1（通り芯−半幅＝ホール側）・復路の到達辺が Q3（回転部側）。1段目の段鼻は Q1 と面一でピッチは（レーン長＋半幅）/段数', () => {
  for (const type of [StairType.SWITCHBACK, StairType.WINDING]) {
    for (const dir of ['up', 'down', 'left', 'right']) {
      for (const flip of [false, true]) {
        for (const [name, half, setup] of VARIANTS) {
          const tag = `${type}/${dir}/flip=${flip}/${name}`;
          const { graph, stair } = equalFixture(type, dir, flip);
          setup(graph);
          const p = uTurnPlanLayout(stair, graph);
          const d = TOWARD[dir], vertical = dir === 'up' || dir === 'down';
          assert.ok(Math.abs(p.run.baseA - (BASE0[dir] - d * half)) < EPS, `${tag}: baseA＝Q1 ${p.run.baseA}`);
          assert.ok(Math.abs(p.run.baseB - (BASE0[dir] + d * half)) < EPS, `${tag}: baseB＝Q3 ${p.run.baseB}`);
          assert.equal(p.run.startA, p.run.baseA, tag);
          assert.equal(p.run.startB, p.run.baseB, tag);
          // 平面の段: 往路 1 段目は Q1 から、ピッチ＝(frontA−baseA)/往路のマス数
          const fps = stairTreadFootprints(stair, graph, { riser: 100, insetView: 'install' });
          const [lo, hi] = runExtent(fps, 1, vertical);
          const pitchA = Math.abs(p.run.frontA - p.run.baseA) / (stair.sections[0] - 1);
          assert.ok(Math.abs((d > 0 ? lo : hi) - p.run.baseA) < 1e-6, `${tag}: 1段目の段鼻（ホール側の辺）が Q1`);
          assert.ok(Math.abs((hi - lo) - pitchA) < 1e-6, `${tag}: ピッチ ${hi - lo} vs ${pitchA}`);
          // 通り芯基準（従来）のピッチより Q1 の半幅ぶん（÷段数）だけ広い
          assert.ok(Math.abs(pitchA - (Math.abs(p.run.frontA - BASE0[dir]) + half) / (stair.sections[0] - 1)) < 1e-6, `${tag}: 区間は通り芯基準＋半幅`);
        }
      }
    }
  }
});

test('【等長レーン・基端の辺に壁あり】柱が壁の中なので従来どおり枠の辺（基端は通り芯のまま・Q1/Q3 へ出ない）', () => {
  for (const dir of ['up', 'down', 'left', 'right']) {
    for (const [name, , setup] of VARIANTS) {
      const tag = `${dir}/${name}`;
      const { graph, stair } = equalFixture(StairType.SWITCHBACK, dir, false);
      setup(graph);
      addBaseWall(graph, stair, dir);
      const p = uTurnPlanLayout(stair, graph);
      assert.equal(p.hasColumn, true, tag);
      assert.equal(p.run.baseA, BASE0[dir], `${tag}: baseA ${p.run.baseA}`);
      assert.equal(p.run.baseB, BASE0[dir], `${tag}: baseB ${p.run.baseB}`);
    }
  }
});

test('【faceRect が null（壁面が退化して求まらない）は通り芯のまま】壁の有無が不明なら Q1/Q3 へ出さない', () => {
  const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false);
  const ks = [...stair.cells].map(k => k.split(':'));
  const cl = (id) => graph.shapeMap.get(id);
  const vs = [...new Set(ks.flatMap(([l, , r]) => [l, r]))].map(cl).sort((a, b) => a.value - b.value);
  const hs = [...new Set(ks.flatMap(([, t, , b]) => [t, b]))].map(cl).sort((a, b) => a.value - b.value);
  // 左右の壁の室側仕上げ面を 1100 ずつ内側へ寄せ、矩形の幅を 0 以下にする（faceRect が null を返す）
  graph.addWall(vs[0], 1100, true, hs[0], 0, hs[hs.length - 1], 0, { isRoomWall: true, wallFinish: 12.5 });
  graph.addWall(vs[vs.length - 1], -1100, true, hs[0], 0, hs[hs.length - 1], 0, { isRoomWall: true, wallFinish: 12.5 });
  assert.equal(faceRect(refreshCells(stair.cells, graph), graph), null, '前提: faceRect が null');
  const p = uTurnPlanLayout(stair, graph);
  assert.ok(p);
  assert.equal(p.hasColumn, true);
  assert.equal(p.run.baseA, BASE0.up);
  assert.equal(p.run.baseB, BASE0.up);
});

test('【columnBases の外周】復路内側の線は Q3 から始まり、Q1〜Q3 の区間（柱）に出入口の線を出さない', () => {
  for (const [name, half, setup] of VARIANTS) {
    const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false);
    setup(graph);
    const p = uTurnPlanLayout(stair, graph);
    const g = installGeom(stair, graph);
    const q1 = BASE0.up + half, q3 = BASE0.up - half;
    assert.ok(Math.abs(p.run.baseA - q1) < EPS && Math.abs(p.run.baseB - q3) < EPS, name);
    // 縦走行: 走行軸は y。復路内側の辺 x=sB の縦線分
    const onSB = g.outline.filter(s => Math.abs(s.x1 - p.across.sB) < EPS && Math.abs(s.x2 - p.across.sB) < EPS);
    assert.ok(onSB.length > 0, `${name}: sB 上の線がある`);
    // up は奥が y 小。復路内側の線は Q3 から奥へ（Q3 より手前＝y が大きい側へ出ない）
    assert.ok(onSB.every(s => Math.max(s.y1, s.y2) <= q3 + EPS), `${name}: sB の線は Q3 から奥へ`);
    assert.ok(onSB.some(s => Math.abs(Math.max(s.y1, s.y2) - q3) < EPS), `${name}: sB の線の起点は Q3`);
    // Q1〜Q3（q3 < y < q1）の区間に、出入口（thin/port）の線が sA〜sB の幅で出ない
    const inPillar = g.outline.filter(s => (s.thin || s.port)
      && Math.min(s.y1, s.y2) > q3 + EPS && Math.max(s.y1, s.y2) < q1 - EPS);
    assert.equal(inPillar.length, 0, `${name}: 柱の区間に出入口の線なし`);
    // 長さ0の線分が無い
    assert.ok(g.outline.every(s => Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 1e-9), `${name}: 長さ0の外周線なし`);
  }
});

test('【不等長は従来】長い方のレーンの基端は t=0（通り芯）のまま、短い方だけ柱の面（Q1/Q3）', () => {
  for (const [name, half, setup] of VARIANTS) {
    const { graph, stair } = overhangFixture(0);
    setup(graph);
    const p = uTurnPlanLayout(stair, graph);
    // 側面の上り口なので枠の始端も壁面（通り芯 3000 から 57.5）まで逃げる。Q1/Q3 の規則とは無関係に t=0 のまま
    assert.ok(Math.abs(p.run.baseA - (3000 - 57.5)) < EPS, `${name}: 長い往路の基端は枠の辺 ${p.run.baseA}`);
    assert.ok(Math.abs(p.run.baseB - (2000 - half)) < EPS, `${name}: 短い復路は Q3`);
  }
});

test('【隔て壁なし（鉄骨）は不変】基端は通り芯のまま（Q1/Q3 へ出ない）', () => {
  for (const dir of ['up', 'down', 'left', 'right']) {
    const { graph, stair } = equalFixture(StairType.SWITCHBACK, dir, false, { wood: false });
    const p = uTurnPlanLayout(stair, graph);
    assert.equal(p.hasColumn, false, dir);
    assert.equal(p.run.baseA, BASE0[dir], dir);
    assert.equal(p.run.baseB, BASE0[dir], dir);
  }
});

test('【側面出入口（張り出し・取りつき回転部）は不変】等長レーンで上り口・到達口が側面なら基端は枠の辺（壁面まで逃げた位置）のまま', () => {
  const { graph, stair } = sideBothFixture(2, 2);
  const p = uTurnPlanLayout(stair, graph);
  assert.equal(p.entryPort, 'outer');
  assert.equal(p.hasColumn, true);
  // 基端 y=4500 は install でも壁面（4500−57.5）まで逃げる＝柱は壁の中。Q1（4500+半幅）へ出ない
  assert.ok(Math.abs(p.run.baseA - 4442.5) < EPS, `baseA ${p.run.baseA}`);
  assert.ok(Math.abs(p.run.baseB - 4442.5) < EPS, `baseB ${p.run.baseB}`);
});

test('隔て壁が立たない（鉄骨・あき 100）: hasColumn は false、frontA と front は同じ。across のあきは 100', () => {
  const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false, { wood: false });
  const p = uTurnPlanLayout(stair, graph);
  assert.ok(p);
  assert.equal(p.hasColumn, false);
  assert.equal(p.run.frontA, p.run.front);
  assert.ok(Math.abs(Math.abs(p.across.sB - p.across.sA) - 100) < 1e-6, `${p.across.sA} ${p.across.sB}`);
  const g = installGeom(stair, graph);
  assert.ok(perpAt(g.treads, p.run.front, true).length > 0);
});

test('失敗系: U字系でない・階段/graph なし・セルが空・解決できないセルなら null（例外にしない）', () => {
  const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false);
  assert.ok(uTurnPlanLayout(stair, graph));
  assert.equal(uTurnPlanLayout(null, graph), null);
  assert.equal(uTurnPlanLayout(stair, null), null);
  for (const type of [StairType.STRAIGHT, StairType.STRAIGHT_LANDING, StairType.L_TURN, StairType.OPEN_WELL]) {
    const fx = equalFixture(StairType.SWITCHBACK, 'up', false);
    fx.stair.type = type;
    assert.equal(uTurnPlanLayout(fx.stair, fx.graph), null, type);
  }
  stair.setCells(new Set());
  assert.equal(uTurnPlanLayout(stair, graph), null, 'セルが空');
  stair.setCells(new Set(['no-such:cell:key:here']));
  assert.equal(uTurnPlanLayout(stair, graph), null, '解決できないセル');
});

test('uTurnPlanLayout の呼び出しは描画に影響しない: 前後で buildStairGeometry（install・段数字つき）が変わらず、自身も繰り返して同じ値', () => {
  for (const type of [StairType.SWITCHBACK, StairType.WINDING]) {
    const { graph, stair } = equalFixture(type, 'up', true);
    stair.setField('entryTurnSteps', 2); // 等長レーンの走行端の上り口では効かない（0 のまま）が、段数字ずらしの経路は通る
    const g1 = installGeom(stair, graph);
    const p1 = uTurnPlanLayout(stair, graph);
    const g2 = installGeom(stair, graph);
    assert.deepEqual(g2, g1, type);
    assert.deepEqual(uTurnPlanLayout(stair, graph), p1, type);
  }
});

// ---------------------------------------------------------------- 取りつき区画の段数字の範囲（展開図が区画のセルを番号で拾う単一供給源）

// 折返し [6,1,6]。往路・復路の基端の行（y3500..4500）を切り、上り口・到達口を側面（外側）にする（stairPlanAlign.test.js の sideEntrySwitchback と同構成）
function sideBothFixture(entryTurnSteps, arrivalTurnSteps) {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH);
  const Hh = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH);
  const x0 = V(0), xm = V(1000), x1 = V(2000), y0 = Hh(0), ym = Hh(1500), yz = Hh(3500), y1 = Hh(4500);
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  const cells = new Set([k(x0, y0, x1, ym), k(x0, ym, xm, yz), k(x0, yz, xm, y1), k(xm, ym, x1, yz), k(xm, yz, x1, y1)]);
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], upDirection: 'up', flip: false,
    entrySide: 'left', arrivalSide: 'left', entryTurnSteps, arrivalTurnSteps,
  });
  stair.structure = StructuralMaterialType.WOOD;
  graph.setStructureOverride('木造（在来）');
  return { graph, stair };
}

test('entryNumbers / arrivalNumbers は stairTreadFootprints の段数字と同じ範囲（上り口 1..e・到達口 総蹴上数−a..総蹴上数−1）で、全マスの番号を余りなく分ける', () => {
  for (const [e, a] of [[0, 0], [1, 0], [2, 2], [3, 1], [0, 3], [1, 3]]) {
    const { graph, stair } = sideBothFixture(e, a);
    const p = uTurnPlanLayout(stair, graph);
    const tag = `e=${e}/a=${a}`;
    assert.equal(p.entryTurnSteps, e, tag);
    assert.equal(p.arrivalTurnSteps, a, tag);
    assert.equal(p.totalSteps, stair.totalSteps, `${tag}: 総蹴上数は Stair の総蹴上数（sections＋e＋a）`);
    assert.deepEqual(p.entryNumbers, e > 0 ? { from: 1, to: e } : null, tag);
    assert.deepEqual(p.arrivalNumbers, a > 0 ? { from: stair.totalSteps - a, to: stair.totalSteps - 1 } : null, tag);
    // 描画側のマスの番号（emitPortTurn が numberStart を渡す）と一致: 上り口 1..e、直進部・回転部、到達口の順に 1..総蹴上数−1 を余りなく分ける
    const nums = stairTreadFootprints(stair, graph, { riser: 100, insetView: 'install' }).map(c => c.number).sort((x, y) => x - y);
    assert.deepEqual(nums, Array.from({ length: stair.totalSteps - 1 }, (_, i) => i + 1), `${tag}: 段数字は 1..総蹴上数−1（到達番号は含まない）`);
    // 範囲内のセルの多角形は区画の矩形に含まれる（±0.5）: 上り口 baseA..exitA × s0..（隣レーン側の内縁 sB まで）、到達口 startB..baseB × （内縁 sA から）..s1。
    // 区画のセルは出口境界線（s0..sA / sB..s1）より隣レーン側へ、隔て板の面（sB / sA）または中央まで張り出す
    const fps = stairTreadFootprints(stair, graph, { riser: 100, insetView: 'install' });
    const within = (range, runA, runB, accA, accB) => {
      const cells = range ? fps.filter(c => c.number >= range.from && c.number <= range.to) : [];
      const [r0, r1] = [Math.min(runA, runB), Math.max(runA, runB)], [a0, a1] = [Math.min(accA, accB), Math.max(accA, accB)];
      for (const c of cells) {
        for (let i = 0; i < c.poly.length; i += 2) {
          const [rr, aa] = p.vertical ? [c.poly[i + 1], c.poly[i]] : [c.poly[i], c.poly[i + 1]];
          assert.ok(rr >= r0 - 0.5 && rr <= r1 + 0.5 && aa >= a0 - 0.5 && aa <= a1 + 0.5, `${tag}: セル ${c.number} の頂点 (${rr},${aa}) が区画の矩形外`);
        }
      }
      return cells.length;
    };
    assert.equal(within(p.entryNumbers, p.run.baseA, p.run.exitA, p.across.s0, p.across.sB), e, `${tag}: 上り口の範囲のセルは e 個で矩形内`);
    assert.equal(within(p.arrivalNumbers, p.run.startB, p.run.baseB, p.across.sA, p.across.s1), a, `${tag}: 到達口の範囲のセルは a 個で矩形内`);
    // 直進部・回転部の番号と重ならない: 上り口の次は直進部、到達口の前は復路の直進部（回転部の最初の番号＝e+n1）
    assert.equal(p.firstTurnNumber, e + p.n1, tag);
  }
});

test('取りつき区画が走行端の口（entrySide/arrivalSide が end・自動）なら entryNumbers/arrivalNumbers は null（蹴上数が残っていても平面の述語で無視）', () => {
  const { graph, stair } = sideBothFixture(2, 2);
  stair.entrySide = 'end';
  stair.arrivalSide = 'end';
  const p = uTurnPlanLayout(stair, graph);
  assert.equal(p.entryTurnSteps, 0);
  assert.equal(p.arrivalTurnSteps, 0);
  assert.equal(p.entryNumbers, null);
  assert.equal(p.arrivalNumbers, null);
});

test('pivotAcross（回り階段の扇形の起点）: 柱ありは柱の往路側の面（通り芯 1000 から半幅ぶん）、柱なしは sA。向きの反転（s0>s1）でも同じ', () => {
  // 等長レーン（s0<s1）: 往路側の面は通り芯より小さい側。柱材の面は 1000−45、PB の外面は 1000−57.5（＝sA）
  for (const [name, half, setup] of VARIANTS) {
    const { graph, stair } = equalFixture(StairType.WINDING, 'up', false);
    setup(graph);
    const p = uTurnPlanLayout(stair, graph);
    assert.equal(p.hasColumn, true, name);
    assert.ok(Math.abs(p.pivotAcross - (1000 - half)) < EPS, `${name}: pivotAcross ${p.pivotAcross}`);
  }
  // 張り出し（s0>s1 の反転した向き）: 往路側の面は通り芯より大きい側（1000+45・1000+57.5）。frontA≠front
  for (const [name, half, setup] of VARIANTS) {
    const { graph, stair } = overhangFixture(0);
    setup(graph);
    const p = uTurnPlanLayout(stair, graph);
    assert.ok(p.across.s0 > p.across.s1, '幅方向が反転している');
    assert.ok(Math.abs(p.pivotAcross - (1000 + half)) < EPS, `${name}: pivotAcross ${p.pivotAcross}`);
    assert.notEqual(p.run.frontA, p.run.front);
  }
  // 柱なし（鉄骨・隔て壁が立たない）は sA
  const steel = equalFixture(StairType.WINDING, 'up', false, { wood: false });
  const q = uTurnPlanLayout(steel.stair, steel.graph);
  assert.equal(q.hasColumn, false);
  assert.equal(q.pivotAcross, q.across.sA);
});

test('turnPivotS: 柱があれば column.sA、無ければ sA（buildWinding と uTurnPlanLayout の単一供給源）', () => {
  assert.equal(turnPivotS({ sA: 0.47 }, 0.5), 0.47);
  assert.equal(turnPivotS(null, 0.5), 0.5);
});

// ---------------------------------------------------------------- 到達辺＝上階（N+1）の床を受ける横架材の外面＋壁仕上げ（2026-10-16 裁定）

const FINISH = 12.5; // 壁仕上げ（PARTITION_FINISH_MM）
// 上階の graph。到達辺（通り芯 BASE0[dir]）に、走行に直交する木造の梁を 1 本置く。range＝梁の区間（既定は階段の幅方向の全範囲）
function aboveWithBeam(dir, opts = {}) {
  return addAboveBeam(new PlanGraph(new Plane('p2', 3000, '2階', 2, 1)), dir, opts);
}
function addAboveBeam(above, dir, { sec = 'WOOD-120x120', role, range = [0, 2000], axis = BASE0[dir], parallel = false } = {}) {
  const vertical = dir === 'up' || dir === 'down'; // 走行が縦
  const beamVertical = parallel ? vertical : !vertical; // 既定は走行に直交
  const axisCL = above.addCenterLine(beamVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL, axis, { labeled: false, discipline: Discipline.STRUCT });
  const mk = (v) => above.addCenterLine(beamVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.STRUCT });
  above.addBeam(StructuralMaterialType.WOOD, sec, axisCL, beamVertical, mk(range[0]), mk(range[1]), role ? { role } : {});
  return above;
}

test('arrivalBeamFaceMm: 到達辺に乗る直交梁の半幅（幅 120 → 60・幅 105 → 52.5）。複数あれば最大', () => {
  for (const dir of ['up', 'down', 'left', 'right']) {
    const { graph, stair } = equalFixture(StairType.SWITCHBACK, dir, false);
    assert.equal(arrivalBeamFaceMm(stair, graph, aboveWithBeam(dir, { sec: 'WOOD-120x120' })), 60, dir);
    assert.equal(arrivalBeamFaceMm(stair, graph, aboveWithBeam(dir, { sec: 'WOOD-105x105' })), 52.5, dir);
  }
  const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false);
  // 照合は復路レーン側（up・flip=false では x 1000..2000）の範囲だけ。往路側だけの梁は到達辺を受けない（T2）
  assert.equal(arrivalBeamFaceMm(stair, graph, aboveWithBeam('up', { sec: 'WOOD-105x105', range: [0, 1000] })), null, '往路側だけの梁は null');
  const above = aboveWithBeam('up', { sec: 'WOOD-105x105', range: [1000, 2000] });
  assert.equal(arrivalBeamFaceMm(stair, graph, above), 52.5, '復路側だけ');
  addAboveBeam(above, 'up', { sec: 'WOOD-120x120', range: [1000, 2000] });
  assert.equal(arrivalBeamFaceMm(stair, graph, above), 60, '幅の異なる梁が並ぶときは最大');
});

test('arrivalBeamFaceMm: 偏芯した梁の面は軸基準（階段側へ 10 ずれた軸なら +10・反対側なら −10）', () => {
  const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false);
  // up は階段が y の小さい側。軸 3990 は階段側へ 10 ずれる
  assert.equal(arrivalBeamFaceMm(stair, graph, aboveWithBeam('up', { axis: 3990 })), 70);
  assert.equal(arrivalBeamFaceMm(stair, graph, aboveWithBeam('up', { axis: 4010 })), 50);
  assert.equal(arrivalBeamFaceMm(stair, graph, aboveWithBeam('up', { axis: 4061 })), null, '材が通り芯を含まない梁は無視');
});

test('arrivalBeamFaceMm 失敗系: 上階なし・梁なし・平行な梁・区間が重ならない梁・軸がずれた梁・土台/基礎/小屋梁は null', () => {
  const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false);
  assert.equal(arrivalBeamFaceMm(stair, graph, null), null, 'aboveGraph null');
  assert.equal(arrivalBeamFaceMm(stair, null, aboveWithBeam('up')), null, 'graph null');
  assert.equal(arrivalBeamFaceMm(stair, graph, new PlanGraph(new Plane('p2', 3000, '2階', 2, 1))), null, '上階に梁なし');
  assert.equal(arrivalBeamFaceMm(stair, graph, aboveWithBeam('up', { parallel: true })), null, '走行に平行な梁');
  assert.equal(arrivalBeamFaceMm(stair, graph, aboveWithBeam('up', { range: [2000, 3000] })), null, '区間が接するだけ（重ならない）');
  assert.equal(arrivalBeamFaceMm(stair, graph, aboveWithBeam('up', { axis: 3000 })), null, '到達辺と軸がずれた梁');
  for (const role of ['sill', 'foundation', 'roofBeam']) {
    assert.equal(arrivalBeamFaceMm(stair, graph, aboveWithBeam('up', { role })), null, role);
  }
  const noCells = { ...stair, cells: new Set() };
  assert.equal(arrivalBeamFaceMm(noCells, graph, aboveWithBeam('up')), null, 'セルなしの階段');
});

test('【到達辺＝上階の梁の外面＋仕上げ】等長レーン・4方向: baseB は通り芯±(梁の半幅＋12.5)。aboveGraph 省略・梁なし・平行な梁は従来の Q3。段数は不変', () => {
  for (const type of [StairType.SWITCHBACK, StairType.WINDING]) {
    for (const dir of ['up', 'down', 'left', 'right']) {
      for (const [sec, half] of [['WOOD-120x120', 60], ['WOOD-105x105', 52.5]]) {
        const tag = `${type}/${dir}/${sec}`;
        const { graph, stair } = equalFixture(type, dir, false);
        addPartitionWalls(graph);
        const d = TOWARD[dir];
        const base = uTurnPlanLayout(stair, graph);
        const p = uTurnPlanLayout(stair, graph, { aboveGraph: aboveWithBeam(dir, { sec }) });
        assert.ok(Math.abs(base.run.baseB - (BASE0[dir] + d * 57.5)) < EPS, `${tag}: 省略は従来の Q3`);
        assert.ok(Math.abs(p.run.baseB - (BASE0[dir] + d * (half + FINISH))) < EPS, `${tag}: baseB ${p.run.baseB}`);
        assert.equal(p.run.startB, p.run.baseB, tag);
        assert.equal(p.run.baseA, base.run.baseA, `${tag}: 往路の基端は不変`);
        assert.deepEqual([p.totalSteps, p.n1, p.n2], [base.totalSteps, base.n1, base.n2], `${tag}: 段数は不変`);
        // 失敗系: 平行な梁・梁なしは従来どおり
        const par = uTurnPlanLayout(stair, graph, { aboveGraph: aboveWithBeam(dir, { parallel: true }) });
        assert.equal(par.run.baseB, base.run.baseB, `${tag}: 平行な梁は無視`);
        const none = uTurnPlanLayout(stair, graph, { aboveGraph: new PlanGraph(new Plane('p3', 3000, '2階', 2, 1)) });
        assert.equal(none.run.baseB, base.run.baseB, `${tag}: 梁なしは Q3`);
      }
    }
  }
});

test('【短い復路（張り出し）でも同じ式】overhangFixture: baseB は通り芯 2000 から（梁の半幅＋12.5）。梁なしは従来の Q3', () => {
  const { graph, stair } = overhangFixture(0);
  addPartitionWalls(graph);
  const above = aboveWithBeam('up', { axis: 2000 });
  const p = uTurnPlanLayout(stair, graph, { aboveGraph: above });
  assert.ok(Math.abs(p.run.baseB - (2000 - (60 + FINISH))) < EPS, `baseB ${p.run.baseB}`);
  assert.ok(Math.abs(uTurnPlanLayout(stair, graph).run.baseB - (2000 - 57.5)) < EPS, '省略は Q3');
});

test('【見下げ平面の到達辺の線】detail は梁の外面＋仕上げ＋蹴込（stair.nosing）。detail:false・install・梁なしは蹴込を足さない', () => {
  const arrivalLine = (stair, graph, opts) => {
    const g = buildStairGeometry(stair, roomBounds(stair.cells, graph), {
      riser: 100, spans: measureStairSpans(stair, graph), laneGap: true, graph, ...opts,
    });
    return g.outline.filter(s => s.port === 'arrival');
  };
  for (const dir of ['up', 'down', 'left', 'right']) {
    const vertical = dir === 'up' || dir === 'down', d = TOWARD[dir];
    const pos = (s) => (vertical ? s.y1 : s.x1);
    const { graph, stair } = equalFixture(StairType.SWITCHBACK, dir, false);
    addPartitionWalls(graph);
    const aboveGraph = aboveWithBeam(dir);
    const det = arrivalLine(stair, graph, { view: 'upper', detail: true, aboveGraph });
    assert.equal(det.length, 1, dir);
    assert.ok(Math.abs(pos(det[0]) - (BASE0[dir] + d * (60 + FINISH + stair.nosing))) < 1e-6, `${dir}: detail ${pos(det[0])}`);
    const simple = arrivalLine(stair, graph, { view: 'upper', detail: false, aboveGraph });
    assert.ok(Math.abs(pos(simple[0]) - (BASE0[dir] + d * (60 + FINISH + stair.nosing))) > 1e-6, `${dir}: detail:false は蹴込を足さない`);
    const noBeam = arrivalLine(stair, graph, { view: 'upper', detail: true, aboveGraph: null });
    assert.ok(Math.abs(pos(noBeam[0]) - pos(det[0])) > 1, `${dir}: 梁なしは動かない（${pos(noBeam[0])}）`);
    const inst = arrivalLine(stair, graph, { view: 'install', detail: true, aboveGraph });
    assert.ok(Math.abs(pos(inst[0]) - (BASE0[dir] + d * (60 + FINISH))) < 1e-6, `${dir}: install は梁の外面＋仕上げ（蹴込なし）${pos(inst[0])}`);
  }
});

// 復路が長いレーン（2 列 b,c,d,a,e。往路 b だけ・復路 a,e）。入口柱は y=2000、復路の基端は y=3000 側（長い方は t=0＝枠の辺）
function longerReturnFixture() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH);
  const Hh = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH);
  const x0 = V(0), x1 = V(1000), x2 = V(2000), y0 = Hh(0), y1 = Hh(1000), y2 = Hh(2000), y3 = Hh(3000);
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  const c = { d: k(x0, y0, x1, y1), c: k(x1, y0, x2, y1), a: k(x0, y1, x1, y2), b: k(x1, y1, x2, y2), e: k(x0, y2, x1, y3) };
  const keys = ['b', 'c', 'd', 'a', 'e'].map(n => c[n]);
  const cells = new Set(keys);
  const cls = classifyStairArea(cells, graph, 2800, keys);
  const stair = graph.addStair({ type: cls.type, cells, upDirection: cls.upDirection, flip: cls.flip, sections: cls.sections, entryTurnSteps: 0, arrivalTurnSteps: 0 });
  stair.entrySide = 'end'; stair.arrivalSide = 'end'; // 出入口は走行端（到達辺の線 port:arrival が基端の辺に出る）
  graph.setStructureOverride('木造（在来）');
  stair.structure = StructuralMaterialType.WOOD;
  return { graph, stair };
}
const arrivalLineOf = (stair, graph, opts) => buildStairGeometry(stair, roomBounds(stair.cells, graph), {
  riser: 100, spans: measureStairSpans(stair, graph), laneGap: true, graph, ...opts,
}).outline.filter(s => s.port === 'arrival');

test('T1【復路が長いレーンは蹴込を足さない】baseB が面に採られない配置では、上階に梁があっても見下げの到達辺の線は動かない', () => {
  const { graph, stair } = longerReturnFixture();
  addPartitionWalls(graph);
  const above = aboveWithBeam('up', { axis: 2000, range: [0, 2000] });
  const base = arrivalLineOf(stair, graph, { view: 'upper', detail: true });
  const withAbove = arrivalLineOf(stair, graph, { view: 'upper', detail: true, aboveGraph: above });
  assert.equal(base.length, 1);
  assert.notEqual(arrivalBeamFaceMm(stair, graph, above), null, '前提: 梁は照合される（見つからないだけの空振りにしない）');
  const lay = uTurnPlanLayout(stair, graph, { aboveGraph: above });
  assert.ok(Math.abs(lay.run.baseA - lay.run.baseB) > 1, '前提: 不等長レーン');
  assert.deepEqual(withAbove, base, '梁があっても動かない（長いレーンの基端は枠の辺）');
});

test('T2【復路側にだけ梁がある】往路側だけの梁では到達辺は Q3 のまま、復路側の梁なら面（4 方向）', () => {
  const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false);
  addPartitionWalls(graph);
  const q3 = uTurnPlanLayout(stair, graph).run.baseB;
  const onA = uTurnPlanLayout(stair, graph, { aboveGraph: aboveWithBeam('up', { range: [0, 1000] }) }).run.baseB;
  const onB = uTurnPlanLayout(stair, graph, { aboveGraph: aboveWithBeam('up', { range: [1000, 2000] }) }).run.baseB;
  assert.equal(onA, q3, '往路側の梁は無視');
  assert.ok(Math.abs(onB - (4000 - (60 + FINISH))) < EPS, `復路側の梁は面 ${onB}`);
});

test('見下げ（N+1）: 往路の基端は枠の辺のまま・復路の基端だけ面、復路のピッチは面から割り付く。基端の隙間は柱・梁なので内側の線を出さない', () => {
  for (const dir of ['up', 'down', 'left', 'right']) {
    const vertical = dir === 'up' || dir === 'down', d = TOWARD[dir];
    const { graph, stair } = equalFixture(StairType.SWITCHBACK, dir, false);
    addPartitionWalls(graph);
    const aboveGraph = aboveWithBeam(dir);
    const geomOf = (view, insetView) => buildStairGeometry(stair, roomBounds(stair.cells, graph), {
      view, insetView, detail: true, riser: 100, spans: measureStairSpans(stair, graph), laneGap: true, graph, aboveGraph,
    });
    const pos = (s) => (vertical ? s.y1 : s.x1);
    const up = geomOf('upper');
    const arrUp = up.outline.filter(s => s.port === 'arrival');
    assert.ok(Math.abs(pos(arrUp[0]) - (BASE0[dir] + d * (60 + FINISH + stair.nosing))) < 1e-6, `${dir}: 見下げの到達辺＝面＋蹴込`);
    // 往路の上り口の辺は枠の辺（逃げた位置）で、通り芯−半幅の Q1 には出ない
    const entryUp = up.outline.filter(s => s.port === 'entry');
    assert.ok(Math.abs(pos(entryUp[0]) - (BASE0[dir])) > 1, `${dir}: 往路は枠の辺（通り芯と異なる）`);
    // 復路内側の線（sB 上）は到達辺（蹴込つき）から始まり、取りつき区画の内側の線（枠の辺〜面）を出さない
    const sBAt = uTurnPlanLayout(stair, graph, { aboveGraph }).across.sB;
    const onSB = up.outline.filter(s => (vertical ? Math.abs(s.x1 - sBAt) < EPS && Math.abs(s.x2 - sBAt) < EPS : Math.abs(s.y1 - sBAt) < EPS && Math.abs(s.y2 - sBAt) < EPS));
    assert.ok(onSB.length > 0, `${dir}: sB 上の線がある`);
    const nearest = (s) => Math.min((vertical ? s.y1 : s.x1) * d, (vertical ? s.y2 : s.x2) * d);
    assert.ok(onSB.every(s => nearest(s) >= pos(arrUp[0]) * d - EPS), `${dir}: 内側の線は到達辺（蹴込つき）より手前から始まらない`);
    // 復路の踏面（sB より復路側）の間隔
    const lay = uTurnPlanLayout(stair, graph, { aboveGraph });
    const ret = Math.sign(lay.across.sB - lay.across.mid) || 1; // 復路レーンのある側（幅方向）
    const gaps = (g) => {
      const ts = g.treads.filter(s => (vertical
        ? Math.abs(s.y1 - s.y2) < EPS && (s.x1 - sBAt) * ret > -1e-6 && (s.x2 - sBAt) * ret > -1e-6
        : Math.abs(s.x1 - s.x2) < EPS && (s.y1 - sBAt) * ret > -1e-6 && (s.y2 - sBAt) * ret > -1e-6))
        .map(s => (vertical ? s.y1 : s.x1) * d).sort((a, b) => a - b);
      return ts.slice(1).map((v, i) => v - ts[i]);
    };
    assert.ok(gaps(up).length > 1, `${dir}: 復路の踏面がある`);
    // 復路は面（run.baseB）から等ピッチで割り付く: 面〜最初の踏面線の距離 ＝ 踏面線どうしの間隔
    const firstTread = Math.min(...up.treads.filter(s => (vertical
      ? Math.abs(s.y1 - s.y2) < EPS && (s.x1 - sBAt) * ret > -1e-6 && (s.x2 - sBAt) * ret > -1e-6
      : Math.abs(s.x1 - s.x2) < EPS && (s.y1 - sBAt) * ret > -1e-6 && (s.y2 - sBAt) * ret > -1e-6)).map(s => (vertical ? s.y1 : s.x1) * d));
    assert.ok(Math.abs((firstTread - lay.run.baseB * d) - gaps(up)[0]) < 1e-6, `${dir}: 面から等ピッチ ${firstTread - lay.run.baseB * d} vs ${gaps(up)[0]}`);
  }
});

test('T3【自階の破れ先の破線は蹴込を足さない】install の beyond（view upper・insetView install）の到達辺は面。install の到達辺と一致', () => {
  for (const dir of ['up', 'down', 'left', 'right']) {
    const vertical = dir === 'up' || dir === 'down', d = TOWARD[dir];
    const pos = (s) => (vertical ? s.y1 : s.x1);
    const { graph, stair } = equalFixture(StairType.SWITCHBACK, dir, false);
    addPartitionWalls(graph);
    const aboveGraph = aboveWithBeam(dir);
    const beyond = arrivalLineOf(stair, graph, { view: 'upper', insetView: 'install', detail: true, aboveGraph });
    const inst = arrivalLineOf(stair, graph, { view: 'install', detail: true, aboveGraph });
    assert.ok(Math.abs(pos(beyond[0]) - (BASE0[dir] + d * (60 + FINISH))) < 1e-6, `${dir}: beyond＝面（蹴込なし）${pos(beyond[0])}`);
    assert.ok(Math.abs(pos(beyond[0]) - pos(inst[0])) < 1e-6, `${dir}: install の到達辺と一致`);
  }
});

test('到達辺の面は入口柱の面 Q3 より手前に来ない: 外へ 20 偏芯した幅 120 の梁は Q3（57.5）のまま、内向き偏芯・偏芯 0 は従来の値', () => {
  const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false);
  addPartitionWalls(graph);
  const baseB = (axis) => uTurnPlanLayout(stair, graph, { aboveGraph: aboveWithBeam('up', { axis }) }).run.baseB;
  // up は階段が y の小さい側。軸 4020 は階段と反対（外）へ 20 → 面 40+12.5=52.5 < 57.5
  assert.ok(Math.abs(baseB(4020) - (4000 - 57.5)) < EPS, `外向き偏芯は Q3 ${baseB(4020)}`);
  assert.ok(Math.abs(baseB(4000) - (4000 - 72.5)) < EPS, '偏芯 0 は 72.5');
  assert.ok(Math.abs(baseB(3980) - (4000 - 92.5)) < EPS, '内向き偏芯は 92.5');
});

test('arrivalBeamFaceMm 失敗系: カタログに無い断面の梁は照合しない（sectionWidth の既定 300 に落とさない）', () => {
  const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false);
  assert.equal(arrivalBeamFaceMm(stair, graph, aboveWithBeam('up', { sec: 'WOOD-NO-SUCH-SECTION' })), null);
});
