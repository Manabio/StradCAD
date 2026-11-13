// 展開図（室内）へ姿図の配置の正面図・背面図・側面図を足す appendPlacedFigures（部分詳細図 S10 P5）の単体テスト。
// 実 graph（PlanGraph＋実の壁生成）と buildRoomFaces の面を使い、図は figureOf の差し替え口で渡す（カタログ・overlay を触らない）。
//
// 部屋 A: 通り芯 x 0..4200・y 0..3300（壁厚 115＝半壁厚 57.5）。部屋 B は A の東隣 x 4200..6000。
// A の面（実測した buildRoomFaces の値）:
//   A 北壁 y=0   水平 inward +1 dirSign +1 originWorld 57.5   run 4085   d=(0,−1)
//   B 東壁 x=4200 垂直 inward −1 dirSign +1 originWorld 57.5   run 3185   d=(+1,0)
//   C 南壁 y=3300 水平 inward −1 dirSign −1 originWorld 4142.5 run 4085   d=(0,+1)
//   D 西壁 x=0   垂直 inward +1 dirSign −1 originWorld 3242.5 run 3185   d=(−1,0)
// 配置 (1300, 700)・回転 90（正面 f＝(−1,0) 西向き）・zMm 850:
//   A: d=(0,−1)・右手 ρ＝(0,−1) で −d＝(0,1) は ρ でない→左側面・x0＝(1300−57.5)＝1242.5
//   B: d=(1,0)＝−f→正面・x0＝(700−57.5)＝642.5
//   C: d=(0,1)・−d＝(0,−1)＝ρ→右側面・x0＝(1300−4142.5)×(−1)＝2842.5
//   D: d=(−1,0)＝f→背面・x0＝(700−3242.5)×(−1)＝2542.5
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CenterLineType, Plane, PlanGraph, Discipline } from '@core';
import { PlacedFigure } from '../core/placedFigure.js';
import {
  PenDir, DetailView, DetailPlacementView, DetailDash, DETAIL_PRIM_SOURCE, LINE_WEIGHT_MM,
} from '../core/constants.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { fixedLen, move } from '../finish/roomDetailTestFixtures.js';
import { square, wallFaceDatums } from '../finish/placedFigure/placedFigureTestFixtures.js';
import { buildRoomFaces } from './elevationFaces.js';
import { ElevationDash, ElevationLineRole, weightForRole } from './elevationStyle.js';
import { appendPlacedFigures } from './elevationPlacedFigures.js';

const { FRONT, BACK, LEFT, RIGHT } = DetailPlacementView;
const ARCH = { labeled: false, discipline: Discipline.ARCH };

function twoRooms() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4200, ARCH);
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 6000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3300, ARCH);
  const a = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  const b = graph.addRoom(new Set([`${x1.id}:${y0.id}:${x2.id}:${y1.id}`]), 'B');
  generateRoomWallsFromOutline(graph, a);
  generateRoomWallsFromOutline(graph, b);
  return { graph, a, b };
}

// 矩形 w×h の立面の姿図。頂点 0 が左上・頂点 1 が右上。originVertex を配置原点にする（0: s 0..w・1: s −w..0。t は 0..h）
function rect(key, w, h, { originVertex = 0, dash = DetailDash.SOLID, over = {} } = {}) {
  return {
    ...square(key, { view: DetailView.ELEVATION }),
    strokes: [{ id: 'a', closed: true, line: { weightRole: 'medium', dashRole: dash }, moves: [
      move(PenDir.RIGHT, fixedLen(w)), move(PenDir.DOWN, fixedLen(h)), move(PenDir.LEFT, fixedLen(w)),
    ] }],
    anchors: [
      { datumId: 'ds0', strokeId: 'a', vertexIndex: originVertex },
      { datumId: 'dt0', strokeId: 'a', vertexIndex: originVertex },
    ],
    ...over,
  };
}
// L 字（頂点 2＝(200,100) が配置原点。s −200..150・t −100..250）
function lShape(key) {
  return {
    ...rect(key, 1, 1),
    strokes: [{ id: 'a', closed: true, line: { weightRole: 'medium', dashRole: DetailDash.SOLID }, moves: [
      move(PenDir.RIGHT, fixedLen(200)), move(PenDir.DOWN, fixedLen(100)), move(PenDir.RIGHT, fixedLen(150)),
      move(PenDir.DOWN, fixedLen(250)), move(PenDir.LEFT, fixedLen(350)),
    ] }],
    anchors: [
      { datumId: 'ds0', strokeId: 'a', vertexIndex: 2 },
      { datumId: 'dt0', strokeId: 'a', vertexIndex: 2 },
    ],
  };
}

const FIGS = [lShape('eF'), rect('eB', 20, 20), rect('eL', 100, 500), rect('eR', 300, 50)];
const VIEWS = { [FRONT]: 'eF', [BACK]: 'eB', [LEFT]: 'eL', [RIGHT]: 'eR' };
const catalogOf = (...figs) => { const m = new Map(figs.map(f => [f.key, f])); return key => m.get(key) ?? null; };
const figureOf = catalogOf(square('main', { views: VIEWS }), ...FIGS);
const PF = { id: 'p1', figureKey: 'main', x: 1300, y: 700, rotationDeg: 90, mirror: false, zMm: 850 };

const withPlaced = (graph, ...specs) => { graph.setPlacedFigures(specs.map(s => new PlacedFigure({ ...PF, ...s }))); return graph; };
const faceOf = (room, graph, letter) => buildRoomFaces(room, graph).find(f => f.letter === letter);
const run = (graph, room, letter, over = {}) => {
  const prims = [];
  appendPlacedFigures(prims, { face: faceOf(room, graph, letter), room, graph, figureOf, floorDyAt: () => 0, ...over });
  return prims;
};
const xyRange = prims => {
  const pts = prims.flatMap(p => (p.type === 'polyline' ? p.points : [[p.x1, p.y1], [p.x2, p.y2]]));
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  return { x: [Math.min(...xs), Math.max(...xs)], y: [Math.min(...ys), Math.max(...ys)] };
};

test('前提: 部屋 A の 4 面の向き・dirSign・originWorld・run が上の実測どおり', () => {
  const { graph, a } = twoRooms();
  const got = ['A', 'B', 'C', 'D'].map(l => { const f = faceOf(a, graph, l); return [f.isVertical, f.inward, f.dirSign, f.originWorld, f.run]; });
  assert.deepEqual(got, [[false, 1, 1, 57.5, 4085], [true, -1, 1, 57.5, 3185], [false, -1, -1, 4142.5, 4085], [true, 1, -1, 3242.5, 3185]]);
});

test('配置 (1300,700)・回転 90: 北＝左側面・東＝正面・南＝右側面・西＝背面。x0＝面ローカル x（dirSign 負の面を含む）・y0＝−zMm', () => {
  const { graph, a } = twoRooms();
  withPlaced(graph, {});
  // [面, 期待 x 範囲, 期待 y 範囲]
  const expected = [
    ['A', [1242.5, 1342.5], [-850, -350]],   // 左側面 eL 100×500（s 0..100・t 0..500）
    ['B', [442.5, 792.5], [-950, -600]],     // 正面 eF（x0 642.5＋s −200..150・y0 −850＋t −100..250）
    ['C', [2842.5, 3142.5], [-850, -800]],   // 右側面 eR 300×50
    ['D', [2542.5, 2562.5], [-850, -830]],   // 背面 eB 20×20
  ];
  for (const [letter, x, y] of expected) {
    const prims = run(graph, a, letter);
    assert.equal(prims.length, 1, `${letter} は 1 本`);
    assert.equal(prims[0].type, 'polyline');
    assert.equal(prims[0].source, DETAIL_PRIM_SOURCE);
    assert.deepEqual(xyRange(prims), { x, y }, `面 ${letter}`);
  }
});

test('鏡像: 左右が入れ替わり（北＝右側面 eR・南＝左側面 eL）、すべての図が s 反転（正面 eF は x0−150..x0+200）', () => {
  const { graph, a } = twoRooms();
  withPlaced(graph, { mirror: true });
  const expected = [
    ['A', [942.5, 1242.5], [-850, -800]],    // 右側面 eR を反転: x0 1242.5 − 300..0
    ['B', [492.5, 842.5], [-950, -600]],     // 正面 eF を反転: x0 642.5 − 150..+200
    ['C', [2742.5, 2842.5], [-850, -350]],   // 左側面 eL を反転: x0 2842.5 − 100..0
    ['D', [2522.5, 2542.5], [-850, -830]],   // 背面 eB を反転: x0 2542.5 − 20..0
  ];
  for (const [letter, x, y] of expected) assert.deepEqual(xyRange(run(graph, a, letter)), { x, y }, `面 ${letter}`);
});

test('左側面の図が無ければ右側面の鏡像で代用する（北面＝eR を反転）。右も無ければ北面は出ない', () => {
  const { graph, a } = twoRooms();
  withPlaced(graph, {});
  const noLeft = catalogOf(square('main', { views: { [FRONT]: 'eF', [RIGHT]: 'eR' } }), ...FIGS);
  assert.deepEqual(xyRange(run(graph, a, 'A', { figureOf: noLeft })), { x: [942.5, 1242.5], y: [-850, -800] });
  const noSide = catalogOf(square('main', { views: { [FRONT]: 'eF' } }), ...FIGS);
  assert.deepEqual(run(graph, a, 'A', { figureOf: noSide }), []);
  assert.equal(run(graph, a, 'B', { figureOf: noSide }).length, 1, '正面は出る');
});

// 鏡像＋左側面の代用（手計算）: mirror・回転 90・(1300,700)・views={front:eF, right:eR}
//   北 A: 左→鏡像で右。本体 eR（代用なし）→ flip＝true（鏡像のみ）→ s −300..0 → x 942.5..1242.5
//   南 C: 右→鏡像で左。left 無し→eR で代用（代用の反転）→ 鏡像の反転と打ち消して flip＝false → s 0..300 → x 2842.5..3142.5
test('鏡像＋左側面の代用: 北面は eR を反転、南面は代用の反転と鏡像の反転が打ち消して反転なし', () => {
  const { graph, a } = twoRooms();
  withPlaced(graph, { mirror: true });
  const sub = catalogOf(square('main', { views: { [FRONT]: 'eF', [RIGHT]: 'eR' } }), ...FIGS);
  assert.deepEqual(xyRange(run(graph, a, 'A', { figureOf: sub })), { x: [942.5, 1242.5], y: [-850, -800] });
  assert.deepEqual(xyRange(run(graph, a, 'C', { figureOf: sub })), { x: [2842.5, 3142.5], y: [-850, -800] });
});

// 鏡像の範囲外判定（手計算）: mirror・回転 90・(1300→4150,700)・北 A は右側面 eOut（s −100..0）を反転して s 0..100
//   x0＝4150−57.5＝4092.5 → 4092.5..4192.5 は run 4085 の右の外（反転しない式なら 3992.5..4092.5 で掛かってしまう）
test('鏡像のときの範囲外判定: 反転後の範囲で判定する', () => {
  const { graph, a } = twoRooms();
  withPlaced(graph, { mirror: true, x: 4150, y: 700 });
  const outFig = catalogOf(square('main', { views: { [RIGHT]: 'eOut' } }), rect('eOut', 100, 40, { originVertex: 1 }));
  assert.deepEqual(run(graph, a, 'A', { figureOf: outFig }), []);
});

test('別の部屋の配置は出ない（部屋 B の配置は A の 4 面に 0 本・B の 4 面に 1 本ずつ）', () => {
  const { graph, a, b } = twoRooms();
  withPlaced(graph, { x: 5000, y: 1000 });
  for (const l of ['A', 'B', 'C', 'D']) assert.deepEqual(run(graph, a, l), [], `A の面 ${l}`);
  for (const l of ['A', 'B', 'C', 'D']) assert.equal(run(graph, b, l).length, 1, `B の面 ${l}`);
});

test('s 範囲が面の [0, run] の外なら出ない（南面 x0=−7.5 の右側面 s −100..0・北面 x0=4092.5 の左側面 s 0..100）。範囲に掛かれば出る', () => {
  const { graph, a } = twoRooms();
  const outFig = catalogOf(square('main', { views: { [RIGHT]: 'eOut', [LEFT]: 'eL' } }), rect('eOut', 100, 40, { originVertex: 1 }), ...FIGS);
  withPlaced(graph, { x: 4150, y: 700 });
  assert.deepEqual(run(graph, a, 'C', { figureOf: outFig }), [], '南面: 範囲 −107.5..−7.5 は面の左の外');
  assert.deepEqual(run(graph, a, 'A', { figureOf: outFig }), [], '北面: 範囲 4092.5..4192.5 は run 4085 の右の外');
  withPlaced(graph, { x: 4000, y: 700 });
  assert.deepEqual(xyRange(run(graph, a, 'C', { figureOf: outFig })).x, [42.5, 142.5], '南面 x0=142.5: 範囲 42.5..142.5 は掛かる');
  assert.equal(run(graph, a, 'A', { figureOf: outFig }).length, 1, '北面 x0=3942.5: 範囲 3942.5..4042.5 は掛かる');
});

test('floorDyAt には x0 が渡り、y0＝floorDyAt(x0)−zMm（z=0 なら y0=floorDyAt(x0)）', () => {
  const { graph, a } = twoRooms();
  withPlaced(graph, {});
  const seen = [];
  const prims = run(graph, a, 'D', { floorDyAt: x => { seen.push(x); return x / 10; } });
  assert.deepEqual(seen, [2542.5]);
  assert.deepEqual(xyRange(prims).y, [254.25 - 850, 254.25 - 850 + 20]);
  withPlaced(graph, { zMm: 0 });
  assert.deepEqual(xyRange(run(graph, a, 'D', { floorDyAt: () => 30 })).y, [30, 50]);
});

test('破線の図は線分ごとの line＋dash（DASHED）・実線は polyline（型は line／polyline だけ）', () => {
  const { graph, a } = twoRooms();
  withPlaced(graph, {});
  const dashedFigureOf = catalogOf(square('main', { views: VIEWS }), ...FIGS.filter(f => f.key !== 'eB'), rect('eB', 20, 20, { dash: DetailDash.DASHED }));
  const prims = run(graph, a, 'D', { figureOf: dashedFigureOf });
  assert.equal(prims.length, 4);
  assert.ok(prims.every(p => p.type === 'line' && p.dash === ElevationDash.DASHED && p.source === DETAIL_PRIM_SOURCE));
  assert.ok(run(graph, a, 'A').every(p => p.type === 'polyline' && p.dash === undefined));
});

// 配置の線の太さは図の指定によらず PLACED_FIGURE_WEIGHT_ROLE（展開図の語彙では細線の見え掛かり＝DETAIL の太さ）。極太・太線を切断線へ寄せない。
const withLine = (fig, line) => ({ ...fig, strokes: fig.strokes.map(s => ({ ...s, line })) });
const lineFigureOf = (line, views = VIEWS) => catalogOf(square('main', { views }), ...FIGS.map(f => withLine(f, line)));
const THIN = weightForRole(ElevationLineRole.DETAIL);

test('細線: 図の線の太さが全ロール（極太・太線を含む）でも、正面・背面・左右・鏡像・左右の鏡像代用の線はすべて細線の太さ（kind なし）', () => {
  assert.equal(THIN, 'thin');
  const roles = Object.keys(LINE_WEIGHT_MM);
  let drawn = 0; // 線が出た組合せの数（全部の面が空になって恒真にならないよう、最後に下限を確かめる）
  for (const weightRole of roles) {
    const fo = lineFigureOf({ weightRole, dashRole: DetailDash.SOLID });
    const sub = lineFigureOf({ weightRole, dashRole: DetailDash.SOLID }, { [FRONT]: 'eF', [RIGHT]: 'eR' });
    for (const mirror of [false, true]) {
      const { graph, a } = twoRooms();
      withPlaced(graph, { mirror });
      for (const letter of ['A', 'B', 'C', 'D']) {
        for (const [name, f] of [['本体', fo], ['左右代用', sub]]) {
          const prims = run(graph, a, letter, { figureOf: f });
          if (prims.length === 0) continue;
          drawn += 1;
          assert.ok(prims.every(p => p.weight === THIN && p.kind === undefined), `${weightRole}・鏡像 ${mirror}・面 ${letter}・${name}`);
        }
      }
    }
  }
  // ロール×鏡像 2×（本体・左右代用）2 の各組で、少なくとも 1 面には線が出ている
  assert.ok(roles.length > 0 && drawn >= roles.length * 2 * 2, `線が出た組合せ ${drawn}`);
});

test('細線: 破線の指定は残る（極太でも line＋DASHED・太さは細線）', () => {
  const { graph, a } = twoRooms();
  withPlaced(graph, {});
  const prims = run(graph, a, 'D', { figureOf: lineFigureOf({ weightRole: 'ultraThick', dashRole: DetailDash.DASHED }) });
  assert.equal(prims.length, 4);
  assert.ok(prims.every(p => p.type === 'line' && p.dash === ElevationDash.DASHED && p.weight === THIN));
});

test('【失敗系】図の参照切れ・分類違い・fit 不能・部屋なし・配置なしは何も足さず例外にしない', () => {
  const { graph, a } = twoRooms();
  withPlaced(graph, {});
  const gone = catalogOf(square('main', { views: { ...VIEWS, [LEFT]: 'nope' } }), ...FIGS);
  assert.deepEqual(run(graph, a, 'A', { figureOf: gone }), [], '左側面の参照切れ（右では代用しない）');
  const wrongClass = catalogOf(square('main', { views: { ...VIEWS, [LEFT]: 'plan' } }), square('plan'), ...FIGS);
  assert.deepEqual(run(graph, a, 'A', { figureOf: wrongClass }), [], '平面の図は側面に置けない');
  const bad = catalogOf(square('main', { views: VIEWS }), ...FIGS.filter(f => f.key !== 'eL'), rect('eL', 100, 500, { over: { datums: wallFaceDatums() } }));
  assert.deepEqual(run(graph, a, 'A', { figureOf: bad }), [], 'fit 不能');
  assert.equal(run(graph, a, 'B', { figureOf: bad }).length, 1, '他の面は出る');
  assert.deepEqual(run(graph, a, 'A', { figureOf: () => null }), [], '主の図の参照切れ');
  assert.deepEqual(run(graph, a, 'A', { room: null }), []);
  assert.deepEqual(run(graph, a, 'A', { room: {} }), []);
  graph.setPlacedFigures([]);
  assert.deepEqual(run(graph, a, 'A'), []);
});
