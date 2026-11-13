// 立面図（外壁立面4面）へ屋外の姿図の配置の正面図・背面図・側面図を足す buildFacadePlacedFigures（部分詳細図 S10 P6）の単体テスト。
// 実 graph（PlanGraph＋実の外壁生成）から buildFacadeInputs で階レコードを作り、図は figureOf の差し替え口で渡す。
//
// 建物: 通り芯 x 0..4000・y 0..3000（外面は 57.5 外）。1 階（FL 0）・GL は FL の 450 下（glZ −450）・軒桁上端 2900。
// 面ごとの法線 n・u の式（u＝ny·x − nx·y）・uMin（面の建物の左端）:
//   南 n(0,1)  u= x  uMin −57.5     東 n(1,0)  u=−y  uMin −3057.5
//   西 n(−1,0) u= y  uMin −57.5     北 n(0,−1) u=−x  uMin −4057.5
// 配置 (1300, 4000)（南外壁の外面 y=3057.5 の外）・回転 0（正面 f＝(0,1)＝南向き）・zMm 850:
//   南: d＝−n＝(0,−1)＝−f → 正面・u0＝1300       東: d＝(−1,0)・右手 ρ＝(−1,0)・−d＝(1,0)≠ρ → left の図・u0＝−4000
//   西: d＝(1,0)・−d＝(−1,0)＝ρ → right の図・u0＝4000   北: d＝(0,1)＝f → 背面・u0＝−1300（建物の北壁に隠れる）
// 図の Y＝glZ − flMm − zMm ＋ t ＝ −450 − 0 − 850 ＋ t ＝ −1300 ＋ t。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CenterLineType, Plane, PlanGraph, Discipline } from '@core';
import { PlacedFigure } from '../core/placedFigure.js';
import {
  PenDir, DetailView, DetailPlacementView, DetailDash, DETAIL_PRIM_SOURCE, FacadeDirection, LINE_WEIGHT_MM,
} from '../core/constants.js';
import { ElevationDash, ElevationLineRole, weightForRole } from '../elevation/elevationStyle.js';
import { generateExteriorWalls } from '../finish/wallGeneration.js';
import { fixedLen, move } from '../finish/roomDetailTestFixtures.js';
import { square, wallFaceDatums, bumpViewFigures, bumpEnds } from '../finish/placedFigure/placedFigureTestFixtures.js';
import { buildFacadeInputs } from './facadeInputs.js';
import { buildFacadeModel, facadeExtentsMm } from './facadeFigure.js';
import { facadeViews, facadeFloorProfiles } from './facadeGeometry.js';
import { buildFacadePlacedFigures } from './facadePlacedFigures.js';

const { FRONT, BACK, LEFT, RIGHT } = DetailPlacementView;
const ARCH = { labeled: false, discipline: Discipline.ARCH };
const GL_BELOW = 450;

function building(elevation = 0, id = 'p1', startFloor = 1) {
  const p1 = new Plane(id, elevation, `${startFloor}階`, startFloor, 1, false, null, 0, false, null, undefined, undefined, 2900);
  const graph = new PlanGraph(p1);
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateExteriorWalls(graph);
  return { p1, graph };
}

// 矩形 w×h の立面の姿図（頂点 0 が左上＝配置原点: s 0..w・t 0..h）
function rect(key, w, h, { over = {} } = {}) {
  return {
    ...square(key, { view: DetailView.ELEVATION }),
    strokes: [{ id: 'a', closed: true, line: { weightRole: 'medium', dashRole: DetailDash.SOLID }, moves: [
      move(PenDir.RIGHT, fixedLen(w)), move(PenDir.DOWN, fixedLen(h)), move(PenDir.LEFT, fixedLen(w)),
    ] }],
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
const PF = { id: 'p1', figureKey: 'main', x: 1300, y: 4000, rotationDeg: 0, mirror: false, zMm: 850 };
const UMIN = { [FacadeDirection.SOUTH]: -57.5, [FacadeDirection.EAST]: -3057.5, [FacadeDirection.WEST]: -57.5, [FacadeDirection.NORTH]: -4057.5 };

function setup(specs, { elevation = 0 } = {}) {
  const { p1, graph } = building(elevation);
  graph.setPlacedFigures(specs.map(s => new PlacedFigure({ ...PF, ...s })));
  const inputs = buildFacadeInputs([{ plane: p1, graph }], { glBelow1FlMm: GL_BELOW, planes: [p1] });
  return { inputs, graph };
}
const run = (inputs, direction, opts = {}) => {
  const view = facadeViews().find(v => v.direction === direction);
  return buildFacadePlacedFigures(inputs, view, {
    uMin: UMIN[direction], profiles: facadeFloorProfiles(inputs, view.normal), figureOf, ...opts,
  });
};
const xyRange = prims => {
  const pts = prims.flatMap(p => (p.type === 'polyline' ? p.points : [[p.x1, p.y1], [p.x2, p.y2]]));
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  return { x: [Math.min(...xs), Math.max(...xs)], y: [Math.min(...ys), Math.max(...ys)] };
};
const { SOUTH, EAST, WEST, NORTH } = FacadeDirection;

test('配置 (1300,4000)・回転 0: 南＝front・東＝left・西＝right・北＝back の図（北壁に隠れて 0 本）。X＝u0−uMin＋s・Y＝−1300＋t', () => {
  const { inputs } = setup([{}]);
  // [面, 期待 X 範囲, 期待 Y 範囲]
  const expected = [
    [SOUTH, [1157.5, 1507.5], [-1400, -1050]],   // 正面 eF: u0 1300−(−57.5)＝1357.5 ＋ s −200..150
    [EAST, [-942.5, -842.5], [-1300, -800]],     // left の図 eL 100×500: u0 −4000−(−3057.5)＝−942.5 ＋ s 0..100
    [WEST, [4057.5, 4357.5], [-1300, -1250]],    // right の図 eR 300×50: u0 4000−(−57.5)＝4057.5 ＋ s 0..300
  ];
  for (const [dir, x, y] of expected) {
    const prims = run(inputs, dir);
    assert.equal(prims.length, 1, `${dir} は 1 本`);
    assert.equal(prims[0].type, 'polyline');
    assert.equal(prims[0].source, DETAIL_PRIM_SOURCE);
    assert.equal(prims[0].kind, undefined, '建具の kind は付けない');
    assert.deepEqual(xyRange(prims), { x, y }, `面 ${dir}`);
  }
  assert.deepEqual(run(inputs, NORTH), [], '北: 背面 eB はあるが北壁（手前）に隠れる');
});

test('鏡像: left と right が入れ替わり（東＝right の図 eR を反転・西＝left の図 eL を反転）、正面 eF は s 反転（−150..200）', () => {
  const { inputs } = setup([{ mirror: true }]);
  const expected = [
    [SOUTH, [1207.5, 1557.5], [-1400, -1050]],   // 正面 eF を反転: 1357.5 − 150..+200
    [EAST, [-1242.5, -942.5], [-1300, -1250]],   // right の図 eR を反転: −942.5 − 300..0
    [WEST, [3957.5, 4057.5], [-1300, -800]],     // left の図 eL を反転: 4057.5 − 100..0
  ];
  for (const [dir, x, y] of expected) assert.deepEqual(xyRange(run(inputs, dir)), { x, y }, `面 ${dir}`);
});

test('left の図が無ければ right の図の鏡像で代用する（東＝eR を反転）。right も無ければ東は出ない。鏡像と代用の反転は打ち消す', () => {
  const noLeft = catalogOf(square('main', { views: { [FRONT]: 'eF', [RIGHT]: 'eR' } }), ...FIGS);
  const { inputs } = setup([{}]);
  assert.deepEqual(xyRange(run(inputs, EAST, { figureOf: noLeft })), { x: [-1242.5, -942.5], y: [-1300, -1250] });
  const noSide = catalogOf(square('main', { views: { [FRONT]: 'eF' } }), ...FIGS);
  assert.deepEqual(run(inputs, EAST, { figureOf: noSide }), []);
  assert.deepEqual(run(inputs, WEST, { figureOf: noSide }), []);
  assert.equal(run(inputs, SOUTH, { figureOf: noSide }).length, 1, '正面は出る');
  const mirrored = setup([{ mirror: true }]).inputs;
  const noRight = catalogOf(square('main', { views: { [FRONT]: 'eF', [LEFT]: 'eL' } }), ...FIGS);
  // 鏡像の西: left の図 eL をそのまま（own）・配置の鏡像で反転 → 3957.5..4057.5。東: right の図（無し）→ eL の代用で反転が打ち消す → −942.5..−842.5
  assert.deepEqual(xyRange(run(mirrored, WEST, { figureOf: noRight })).x, [3957.5, 4057.5]);
  assert.deepEqual(xyRange(run(mirrored, EAST, { figureOf: noRight })).x, [-942.5, -842.5]);
});

// 左右の対応（世界座標で固定）: 非対称の図（bumpViewFigures）は +s の端（s=300）だけが細い帯（t 0..50）。回転 0＝図の +s は世界の +x・正面側は世界の +y。
// 面の u（見る人の右へ増える）から世界の along 座標へ戻す: 南 x＝u・西 y＝u・東 y＝−u（u＝X＋uMin）。
//   西 n(−1,0)（見る人は器具の右手＝西側で東を見る）: right の図・反転なし。X＝u0−uMin＋s → 世界 y＝4000＋s。帯の端は世界 y=4300＝器具の正面側＝見る人の右
//   東 n(1,0)（東側で西を見る）: left が無く right の鏡像。X＝u0−uMin−s → 世界 y＝4000＋s。帯の端は同じく世界 y=4300＝見る人の左
//   南 n(0,1)（正面図を見る面）: front・反転なし。世界 x＝1300＋s。帯の端は世界 x=1600＝見る人の右
const WORLD_OF = { [SOUTH]: u => u, [WEST]: u => u, [EAST]: u => -u };
const bumpCatalog = views => catalogOf(square('main', { views }), ...bumpViewFigures());
const endsOf = (prims, dir) => bumpEnds(prims, x => WORLD_OF[dir](x + UMIN[dir]));

test('左右の対応: 西面は right の図が反転なしで出て、+s の端（帯）は世界 +y（器具の正面側・見る人の右）に来る', () => {
  const { inputs } = setup([{}]);
  const prims = run(inputs, WEST, { figureOf: bumpCatalog({ [FRONT]: 'eBumpF', [RIGHT]: 'eBumpR', [LEFT]: 'eBumpL' }) });
  assert.equal(prims.length, 1);
  assert.deepEqual(xyRange(prims).x, [4057.5, 4357.5], '反転なし: X＝4057.5＋s');
  const e = endsOf(prims,WEST);
  assert.deepEqual([e.wMin, e.wMax], [4000, 4300], '世界 y＝4000＋s（正面側 +y が図の右）');
  assert.deepEqual(e.ysMax, [-1300, -1250], '世界 y=4300 の端は帯（t 0..50）');
  assert.deepEqual(e.ysMin, [-1300, -1150], '世界 y=4000 の端は全高（right の図＝高さ 150）');
});

test('左右の対応: 東面は left が無ければ right の鏡像で、突起の側（帯）はやはり世界 +y（見る人の左）に来る', () => {
  const { inputs } = setup([{}]);
  const prims = run(inputs, EAST, { figureOf: bumpCatalog({ [FRONT]: 'eBumpF', [RIGHT]: 'eBumpR' }) });
  assert.equal(prims.length, 1);
  assert.deepEqual(xyRange(prims).x, [-1242.5, -942.5], '鏡像: X＝−942.5−s');
  const e = endsOf(prims,EAST);
  assert.deepEqual([e.wMin, e.wMax], [4000, 4300]);
  assert.deepEqual(e.ysMax, [-1300, -1250], '世界 y=4300 の端は帯');
  assert.deepEqual(e.ysMin, [-1300, -1150]);
});

test('左右の対応: 南面の front は反転なしで、+s の端（帯）は見る人の右＝世界 +x に来る（平面の配置図の +s と同じ側）', () => {
  const { inputs } = setup([{}]);
  const prims = run(inputs, SOUTH, { figureOf: bumpCatalog({ [FRONT]: 'eBumpF', [RIGHT]: 'eBumpR' }) });
  assert.equal(prims.length, 1);
  assert.deepEqual(xyRange(prims).x, [1357.5, 1657.5], '反転なし: X＝1357.5＋s');
  const e = endsOf(prims,SOUTH);
  assert.deepEqual([e.wMin, e.wMax], [1300, 1600], '世界 x＝1300＋s');
  assert.deepEqual(e.ysMax, [-1300, -1250], '世界 x=1600 の端は帯');
  assert.deepEqual(e.ysMin, [-1300, -1050], '世界 x=1300 の端は全高（front の図＝高さ 250）');
});

test('Y は階の FL を引く（FL 3000 の階: Y＝−450−3000−850＋t）', () => {
  const { inputs } = setup([{}], { elevation: 3000 });
  assert.equal(inputs.floors[0].flMm, 3000);
  assert.deepEqual(xyRange(run(inputs, SOUTH)).y, [-4400, -4050]);
});

test('2 階建て: 2 階の配置は 2 階の flMm を使う（Y＝glZ−FL2−zMm＋t）。1 階の配置は FL 0', () => {
  const b1 = building(0, 'p1', 1), b2 = building(3000, 'p2', 2);
  b1.graph.setPlacedFigures([new PlacedFigure({ ...PF, id: 'f1' })]);
  b2.graph.setPlacedFigures([new PlacedFigure({ ...PF, id: 'f2' })]);
  const inputs = buildFacadeInputs([{ plane: b1.p1, graph: b1.graph }, { plane: b2.p1, graph: b2.graph }],
    { glBelow1FlMm: GL_BELOW, planes: [b1.p1, b2.p1] });
  assert.deepEqual(inputs.floors.map(f => f.flMm), [0, 3000]);
  const prims = run(inputs, SOUTH);
  assert.equal(prims.length, 2);
  assert.deepEqual(prims.map(p => xyRange([p]).y), [[-1400, -1050], [-4400, -4050]]);
});

test('図の z は FL＋zMm−t（t 正＝下へ伸びる）: 北の外・zMm 2800・t 0..300 の正面は軒桁上端 2900 の壁に全部隠れる', () => {
  const r300 = catalogOf(square('main', { views: { [FRONT]: 'r' } }), rect('r', 400, 300));
  assert.deepEqual(run(setup([{ y: -800, zMm: 2800 }]).inputs, SOUTH, { figureOf: r300 }), [], 'z 2500..2800');
  // zMm 3300 なら z 3000..3300 で壁（上端 2900）の上へ出て描かれる
  assert.equal(run(setup([{ y: -800, zMm: 3300 }]).inputs, SOUTH, { figureOf: r300 }).length, 1);
});

test('FL 3000 の階: 北の外の配置は zMm 850 で南面から隠れ、zMm 3000（FL＋3000 で軒桁上端 5900 を越える）なら描く', () => {
  assert.deepEqual(run(setup([{ y: -800, zMm: 850 }], { elevation: 3000 }).inputs, SOUTH), []);
  assert.equal(run(setup([{ y: -800, zMm: 3000 }], { elevation: 3000 }).inputs, SOUTH).length, 1);
});

test('面の範囲（bounds・幅・高さ・倍率用の寸法）に姿図の配置の外接が含まれる（建物の端から離れた配置が枠外に切れない）', () => {
  const dirOf = (model, dir) => model.find(f => f.direction === dir);
  const base = buildFacadeModel(setup([]).inputs, { figureOf });
  const { inputs } = setup([{}]);
  const model = buildFacadeModel(inputs, { figureOf });
  // 東: left の図 eL は u −4000..−3900。建物の u −3057.5..57.5 より 942.5 左へ広がる（幅 3115 → 4057.5）。図は X 0..100
  assert.equal(dirOf(base, EAST).widthMm, 3115);
  assert.equal(dirOf(model, EAST).widthMm, 4057.5);
  assert.equal(dirOf(model, EAST).bounds.maxX, 4057.5);
  assert.deepEqual(xyRange(dirOf(model, EAST).primitives.filter(p => p.source === DETAIL_PRIM_SOURCE)).x, [0, 100]);
  // 西: right の図 eR は u 4000..4300。建物の u −57.5..3057.5 より右へ（幅 3115 → 4357.5）
  assert.equal(dirOf(model, WEST).widthMm, 4357.5);
  // 南: 配置が建物の u の内側なら幅は不変。高さは配置が壁より高ければ伸びる（zMm 5000 → zTop 5100・GL −450 から 5550）
  assert.equal(dirOf(model, SOUTH).widthMm, dirOf(base, SOUTH).widthMm);
  const tall = buildFacadeModel(setup([{ zMm: 5000 }]).inputs, { figureOf });
  assert.equal(dirOf(base, SOUTH).heightMm, 2900 + GL_BELOW);
  assert.equal(dirOf(tall, SOUTH).heightMm, 5100 + GL_BELOW);
  const ext = facadeExtentsMm(inputs, { figureOf });
  assert.equal(ext.faces.find(f => f.direction === EAST).widthMm, 4057.5);
  assert.equal(ext.maxWidthMm, 4357.5);
});

test('隠れ: 5 点すべて壁に隠れたら描かない。一部でも見えれば全部描く。壁より高ければ描く', () => {
  // 北の外（y=−800）の配置を南から見る: 建物の南壁の向こう（奥）・u 1100..1450 は建物の内側 → 全点隠れる
  const hidden = setup([{ y: -800 }]).inputs;
  assert.deepEqual(run(hidden, SOUTH), []);
  // 北の外で建物の東端（u 4057.5）をまたぐ: 正面 400×300（s 0..400）→ u 3900..4300 の左の角は壁の陰・右の角は壁の外
  const rect400 = catalogOf(square('main', { views: { [FRONT]: 'r400' } }), rect('r400', 400, 300));
  const partial = setup([{ y: -800, x: 3900 }]).inputs;
  assert.deepEqual(xyRange(run(partial, SOUTH, { figureOf: rect400 })), { x: [3957.5, 4357.5], y: [-1300, -1000] });
  // 同じ位置でも壁（軒桁上端 2900）より上に置けば隠れない（z を見ている）
  const high = setup([{ y: -800, x: 1300, zMm: 5000 }]).inputs;
  assert.equal(run(high, SOUTH).length, 1);
});

// 配置の線の太さは図の指定によらず細線（立面の語彙では DETAIL の太さ）。極太・太線を切断線へ寄せない。破線は残る。
const withLine = (fig, line) => ({ ...fig, strokes: fig.strokes.map(s => ({ ...s, line })) });
const lineFigureOf = (line, views = VIEWS) => catalogOf(square('main', { views }), ...FIGS.map(f => withLine(f, line)));
const THIN = weightForRole(ElevationLineRole.DETAIL);

test('細線: 図の線の太さが全ロール（極太・太線を含む）でも、正面・左右・鏡像・左右の鏡像代用の線はすべて細線の太さ（kind なし）', () => {
  assert.equal(THIN, 'thin');
  for (const weightRole of Object.keys(LINE_WEIGHT_MM)) {
    const full = lineFigureOf({ weightRole, dashRole: DetailDash.SOLID });
    const sub = lineFigureOf({ weightRole, dashRole: DetailDash.SOLID }, { [FRONT]: 'eF', [RIGHT]: 'eR' });
    for (const mirror of [false, true]) {
      const { inputs } = setup([{ mirror }]);
      for (const dir of [SOUTH, EAST, WEST]) {
        for (const [name, f] of [['本体', full], ['左右代用', sub]]) {
          const prims = run(inputs, dir, { figureOf: f });
          assert.ok(prims.length > 0, `${weightRole}・鏡像 ${mirror}・${dir}・${name} は描く`);
          assert.ok(prims.every(p => p.weight === THIN && p.kind === undefined), `${weightRole}・鏡像 ${mirror}・${dir}・${name}`);
        }
      }
    }
  }
});

test('細線: 破線の指定は残る（極太でも line＋DASHED・太さは細線）。本番の組立て buildFacadeModel を通しても同じ', () => {
  const { inputs } = setup([{}]);
  const dashed = lineFigureOf({ weightRole: 'ultraThick', dashRole: DetailDash.DASHED });
  const prims = run(inputs, SOUTH, { figureOf: dashed });
  assert.equal(prims.length, 6, '正面 eF（L 字）の 6 辺');
  assert.ok(prims.every(p => p.type === 'line' && p.dash === ElevationDash.DASHED && p.weight === THIN));
  const solid = buildFacadeModel(inputs, { figureOf: lineFigureOf({ weightRole: 'thick', dashRole: DetailDash.SOLID }) });
  const detail = solid.flatMap(f => f.primitives).filter(p => p.source === DETAIL_PRIM_SOURCE);
  assert.equal(detail.length, 3);
  assert.ok(detail.every(p => p.weight === THIN));
});

test('【失敗系】図の参照切れ・分類違い・fit 不能・配置なし・不正な要素は何も足さず例外にしない', () => {
  const { inputs } = setup([{}]);
  const gone = catalogOf(square('main', { views: { ...VIEWS, [LEFT]: 'nope' } }), ...FIGS);
  assert.deepEqual(run(inputs, EAST, { figureOf: gone }), [], 'left の参照切れ（right では代用しない）');
  const wrongClass = catalogOf(square('main', { views: { ...VIEWS, [LEFT]: 'plan' } }), square('plan'), ...FIGS);
  assert.deepEqual(run(inputs, EAST, { figureOf: wrongClass }), [], '平面の図は側面に置けない');
  const bad = catalogOf(square('main', { views: VIEWS }), ...FIGS.filter(f => f.key !== 'eL'), rect('eL', 100, 500, { over: { datums: wallFaceDatums() } }));
  assert.deepEqual(run(inputs, EAST, { figureOf: bad }), [], 'fit 不能');
  assert.equal(run(inputs, SOUTH, { figureOf: bad }).length, 1, '他の面は出る');
  assert.deepEqual(run(inputs, SOUTH, { figureOf: () => null }), [], '主の図の参照切れ');
  const broken = { ...inputs, floors: [{ ...inputs.floors[0], placedFigures: [null, 7] }] };
  assert.deepEqual(run(broken, SOUTH), []);
  assert.deepEqual(run({ ...inputs, floors: [{ ...inputs.floors[0], placedFigures: undefined }] }, SOUTH), []);
  assert.deepEqual(run(setup([]).inputs, SOUTH), []);
});

test('配線先 buildFacadeModel: 面ごとの姿図の本数（南 1・東 1・西 1・北 0）が建具・壁とは別に足される', () => {
  const { inputs } = setup([{}]);
  const model = buildFacadeModel(inputs, { figureOf });
  const count = dir => model.find(f => f.direction === dir).primitives.filter(p => p.source === DETAIL_PRIM_SOURCE).length;
  assert.deepEqual([SOUTH, EAST, WEST, NORTH].map(count), [1, 1, 1, 0]);
  const south = model.find(f => f.direction === SOUTH).primitives.find(p => p.source === DETAIL_PRIM_SOURCE);
  assert.deepEqual(xyRange([south]), { x: [1157.5, 1507.5], y: [-1400, -1050] });
});
