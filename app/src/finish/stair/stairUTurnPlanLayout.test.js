// uTurnPlanLayout（折返し・回り階段の平面の解決値を数値だけで返す共有口。展開図が平面と同じ位置を使うための入口）の単体テスト。
// 値は buildStairGeometry（install）の踏面線・前縁・到達辺・外周と一致しなければならない（抽出元の resolveUTurnPlan が共通）。
// 実物の PlanGraph / Plane / Stair で組む。フィクスチャは stairPortSide.test.js（張り出し f,b,c,d,a）・stairTreads.test.js（等長レーン）の流儀。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType } from '@core';
import { classifyStairArea, measureStairSpans } from './stairClassify.js';
import { buildStairGeometry, uTurnPlanLayout } from './stairGeometry.js';
import { roomBounds } from '../gridCells.js';
import { PARTITION_BACKING_MM, PARTITION_THICKNESS_MM } from './stairPartition.js';
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
