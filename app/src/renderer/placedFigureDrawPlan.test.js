// 姿図の配置を描く計画（renderer/placedFigureDrawPlan.js。部分詳細図 S10 P3）の単体テスト。
// fixture は原点・対称を避ける: L 字（局所の頂点 (20,10) が配置原点）を (300,100) に置く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PenDir, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis, DetailDash, DetailParam,
  DetailPlacementView, DETAIL_VIEWS_FIELD, DETAIL_FIGURE_VERSION, DETAIL_DEFAULT_WEIGHT_ROLE,
} from '../core/constants.js';
import { PlacedFigure } from '../core/placedFigure.js';
import { DetailFitError } from '../detail/detailPlacement.js';
import { RoomDetailError } from '../finish/roomDetailTargets.js';
import { fixedLen, paramLen, move } from '../finish/roomDetailTestFixtures.js';
import { placedFigureDrawPlan } from './placedFigureDrawPlan.js';

const LINE = { weightRole: 'medium', dashRole: DetailDash.SOLID };

// L 字。局所点（配置原点＝頂点 2 を引いた後）: (-20,-10)(0,-10)(0,0)(15,0)(15,25)(-20,25)・閉。
function lShape({ key = 'df-l', category = DetailCategory.FIGURE, view = DetailView.PLAN, subject = DetailSubject.SANITARY, datums, moves, line = LINE, extra } = {}) {
  return {
    key, version: DETAIL_FIGURE_VERSION, label: 'L字', category, view, subject,
    strokes: [{ id: 'a', closed: true, line, moves: moves ?? [
      move(PenDir.RIGHT, fixedLen(20)), move(PenDir.DOWN, fixedLen(10)), move(PenDir.RIGHT, fixedLen(15)),
      move(PenDir.DOWN, fixedLen(25)), move(PenDir.LEFT, fixedLen(35)),
    ] }],
    datums: datums ?? [
      { id: 'ds0', role: DetailDatumRole.PLACEMENT_ORIGIN, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
      { id: 'dt0', role: DetailDatumRole.PLACEMENT_ORIGIN, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
    ],
    anchors: [
      { datumId: 'ds0', strokeId: 'a', vertexIndex: 2 },
      { datumId: 'dt0', strokeId: 'a', vertexIndex: 2 },
    ],
    provenance: null, note: null,
    ...extra,
  };
}
const LOCAL = [[-20, -10], [0, -10], [0, 0], [15, 0], [15, 25], [-20, 25]];
const closedLocal = [...LOCAL, LOCAL[0]];

// 空調の見上げ用: L 字の頂点列に加えて、2 本目の開いた折れ線（局所の頂点 0 → 頂点 1 の 2 点）を足した図（線数 2）。
function withOpenStroke(base) {
  return {
    ...base,
    strokes: [...base.strokes, { id: 'b', closed: false, line: LINE, moves: [move(PenDir.RIGHT, fixedLen(40))] }],
    anchors: [...base.anchors, { datumId: 'ds0', strokeId: 'b', vertexIndex: 0 }, { datumId: 'dt0', strokeId: 'b', vertexIndex: 0 }],
  };
}
const lWithSecondStroke = (key, subject) => withOpenStroke(lShape({ key, subject }));

const figs = (...list) => key => list.find(f => f.key === key) ?? null;
const pf = (over = {}) => new PlacedFigure({ id: 'p1', figureKey: 'df-l', x: 300, y: 100, ...over });
const pairs = flat => { const out = []; for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };

// (a) 回転 4 × 鏡像 2。手計算の式（局所 (s,t) → 世界）。鏡像は s を反転してから回転する。
const EXPECT = [
  [0, false, (s, t) => [300 + s, 100 + t]],
  [90, false, (s, t) => [300 - t, 100 + s]],
  [180, false, (s, t) => [300 - s, 100 - t]],
  [270, false, (s, t) => [300 + t, 100 - s]],
  [0, true, (s, t) => [300 - s, 100 + t]],
  [90, true, (s, t) => [300 - t, 100 - s]],
  [180, true, (s, t) => [300 + s, 100 - t]],
  [270, true, (s, t) => [300 + t, 100 + s]],
];

for (const [rotationDeg, mirror, f] of EXPECT) {
  test(`(a) 回転 ${rotationDeg}°・鏡像 ${mirror}: 世界座標が手計算の期待値と厳密一致（閉は始点を末尾に足す）`, () => {
    const plan = placedFigureDrawPlan([pf({ rotationDeg, mirror })], figs(lShape()));
    assert.equal(plan.lines.length, 1);
    assert.deepEqual(plan.marks, []);
    assert.deepEqual(pairs(plan.lines[0].points), closedLocal.map(([s, t]) => f(s, t)));
    assert.equal(plan.lines[0].key, 'p1:a');
    assert.equal(plan.lines[0].figureId, 'p1');
  });
}

test('(a) 回転 90° の具体値: 局所 (-20,-10) → (310,80)・(15,25) → (275,115)（sy・tx の符号を直接固定）', () => {
  const plan = placedFigureDrawPlan([pf({ rotationDeg: 90 })], figs(lShape()));
  const p = pairs(plan.lines[0].points);
  assert.deepEqual(p[0], [310, 80]);
  assert.deepEqual(p[4], [275, 115]);
});

test('(b) 見下げは衛生・家具・空調の 3 subject すべて描く／見上げは空調だけ（衛生・家具は lines・marks・boxes とも 0）', () => {
  const list = [
    lShape({ key: 'k-s', subject: DetailSubject.SANITARY }),
    lShape({ key: 'k-f', subject: DetailSubject.FURNITURE }),
    lShape({ key: 'k-h', subject: DetailSubject.HVAC }),
  ];
  const placed = [
    new PlacedFigure({ id: 'a', figureKey: 'k-s', x: 300, y: 100 }),
    new PlacedFigure({ id: 'b', figureKey: 'k-f', x: 700, y: 100 }),
    new PlacedFigure({ id: 'c', figureKey: 'k-h', x: 1100, y: 100 }),
  ];
  const down = placedFigureDrawPlan(placed, figs(...list), { direction: 'down' });
  assert.deepEqual(down.lines.map(l => l.figureId), ['a', 'b', 'c']);
  assert.equal(down.boxes.length, 3);
  const up = placedFigureDrawPlan(placed, figs(...list), { direction: 'up' });
  assert.deepEqual(up.lines.map(l => l.figureId), ['c']);
  assert.deepEqual(up.boxes.map(b => b.figureId), ['c']);
  assert.deepEqual(up.marks, []);
  assert.deepEqual(placedFigureDrawPlan(placed.slice(0, 2), figs(...list), { direction: 'up' }), { lines: [], marks: [], boxes: [] });
});

test('(b) 見上げでも xy は鏡像にしない（見下げと同じ世界座標）', () => {
  const hvac = lShape({ key: 'k-h', subject: DetailSubject.HVAC });
  const p = [new PlacedFigure({ id: 'c', figureKey: 'k-h', x: 300, y: 100, rotationDeg: 90 })];
  assert.deepEqual(placedFigureDrawPlan(p, figs(hvac), { direction: 'up' }).lines, placedFigureDrawPlan(p, figs(hvac), { direction: 'down' }).lines);
});

test('(c) 見上げは views.ceiling の図（線数 2）を優先する。見下げは平面図自身（線数 1）', () => {
  const hvac = lShape({ key: 'k-h', subject: DetailSubject.HVAC, extra: { [DETAIL_VIEWS_FIELD]: { [DetailPlacementView.CEILING]: 'k-hc' } } });
  const hvacC = lWithSecondStroke('k-hc', DetailSubject.HVAC);
  const p = [new PlacedFigure({ id: 'c', figureKey: 'k-h', x: 300, y: 100 })];
  assert.equal(placedFigureDrawPlan(p, figs(hvac, hvacC), { direction: 'up' }).lines.length, 2);
  assert.equal(placedFigureDrawPlan(p, figs(hvac, hvacC), { direction: 'down' }).lines.length, 1);
});

test('(c) 【失敗系】views.ceiling が無い・参照切れ・分類違い（衛生の平面図／立面の図）・fit 不能は平面図自身へ落ちる（figureBack と同じ規則）', () => {
  const p = [new PlacedFigure({ id: 'c', figureKey: 'k-h', x: 300, y: 100 })];
  const withCeiling = key => lShape({ key: 'k-h', subject: DetailSubject.HVAC, extra: key === undefined ? {} : { [DETAIL_VIEWS_FIELD]: { [DetailPlacementView.CEILING]: key } } });
  const unfittable = { ...lWithSecondStroke('k-bad', DetailSubject.HVAC), datums: [...lShape().datums, { id: 'dx', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 }] };
  const cases = [
    ['views 無し', withCeiling(undefined), []],
    ['参照切れ', withCeiling('k-none'), []],
    ['分類違い（衛生の平面図）', withCeiling('k-sc'), [lWithSecondStroke('k-sc', DetailSubject.SANITARY)]],
    ['分類違い（空調の立面図）', withCeiling('k-ev'), [{ ...lWithSecondStroke('k-ev', DetailSubject.HVAC), view: DetailView.ELEVATION }]],
    ['fit 不能（別 role の基準を持つ空調の平面図）', withCeiling('k-bad'), [unfittable]],
  ];
  for (const [name, hvac, others] of cases) {
    const plan = placedFigureDrawPlan(p, figs(hvac, ...others), { direction: 'up' });
    assert.equal(plan.lines.length, 1, name);
    assert.deepEqual(plan.marks, [], name);
  }
});

test('(b) 電気: 見下げ・見上げとも描く。見上げでも衛生・家具は描かず、電気だけ残る（lines・marks・boxes）', () => {
  const list = [
    lShape({ key: 'k-e', subject: DetailSubject.ELECTRICAL }),
    lShape({ key: 'k-s', subject: DetailSubject.SANITARY }),
    lShape({ key: 'k-f', subject: DetailSubject.FURNITURE }),
  ];
  const placed = [
    new PlacedFigure({ id: 'e', figureKey: 'k-e', x: 410, y: 130 }),
    new PlacedFigure({ id: 's', figureKey: 'k-s', x: 710, y: 130 }),
    new PlacedFigure({ id: 'f', figureKey: 'k-f', x: 1010, y: 130 }),
  ];
  assert.deepEqual(placedFigureDrawPlan(placed, figs(...list), { direction: 'down' }).lines.map(l => l.figureId), ['e', 's', 'f']);
  const up = placedFigureDrawPlan(placed, figs(...list), { direction: 'up' });
  assert.deepEqual(up.lines.map(l => l.figureId), ['e']);
  assert.deepEqual(up.boxes.map(b => b.figureId), ['e']);
  assert.deepEqual(up.marks, []);
  assert.deepEqual(placedFigureDrawPlan(placed.slice(1), figs(...list), { direction: 'up' }), { lines: [], marks: [], boxes: [] });
});

test('(c) 電気: 見上げは views.ceiling の電気の図（線数 2）を優先・見下げは平面図自身（線数 1）', () => {
  const main = lShape({ key: 'k-e', subject: DetailSubject.ELECTRICAL, extra: { [DETAIL_VIEWS_FIELD]: { [DetailPlacementView.CEILING]: 'k-ec' } } });
  const ceil = lWithSecondStroke('k-ec', DetailSubject.ELECTRICAL);
  const p = [new PlacedFigure({ id: 'e', figureKey: 'k-e', x: 410, y: 130 })];
  assert.equal(placedFigureDrawPlan(p, figs(main, ceil), { direction: 'up' }).lines.length, 2);
  assert.equal(placedFigureDrawPlan(p, figs(main, ceil), { direction: 'down' }).lines.length, 1);
});

test('(c) 【失敗系】電気: views.ceiling が無い・参照切れ・分類違い（衛生の平面図）・fit 不能は平面図自身へ落ちる', () => {
  const p = [new PlacedFigure({ id: 'e', figureKey: 'k-e', x: 410, y: 130 })];
  const withCeiling = key => lShape({ key: 'k-e', subject: DetailSubject.ELECTRICAL, extra: key === undefined ? {} : { [DETAIL_VIEWS_FIELD]: { [DetailPlacementView.CEILING]: key } } });
  const unfittable = { ...lWithSecondStroke('k-bad', DetailSubject.ELECTRICAL), datums: [...lShape().datums, { id: 'dx', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 }] };
  const cases = [
    ['views 無し', withCeiling(undefined), []],
    ['参照切れ', withCeiling('k-none'), []],
    ['分類違い（衛生の平面図）', withCeiling('k-sc'), [lWithSecondStroke('k-sc', DetailSubject.SANITARY)]],
    ['fit 不能', withCeiling('k-bad'), [unfittable]],
  ];
  for (const [name, main, others] of cases) {
    const plan = placedFigureDrawPlan(p, figs(main, ...others), { direction: 'up' });
    assert.equal(plan.lines.length, 1, name);
    assert.deepEqual(plan.marks, [], name);
  }
});

test('(d) 【失敗系】解決できない配置は配置点の印 1 つ（lines・boxes 0）: 参照切れ・分類違い・基準の供給失敗・fit 失敗', () => {
  const datum = d => lShape({ datums: [...lShape().datums, { id: 'dx', offsetMm: 0, ...d }], key: 'df-x' });
  const cases = [
    ['参照切れ', figs(), null],
    ['opening の詳細図（分類違い）', figs(lShape({ key: 'df-l', view: DetailView.ELEVATION, subject: DetailSubject.OPENING })), RoomDetailError.UNSUPPORTED_SLOT],
    ['立面の配置図（平面では置けない＝分類違い。参照切れの null と区別）', figs(lShape({ key: 'df-l', view: DetailView.ELEVATION, subject: DetailSubject.SANITARY })), RoomDetailError.UNSUPPORTED_SLOT],
    ['WALL_FINISH_FACE の基準', figs({ ...datum({ role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN }), key: 'df-l' }), RoomDetailError.UNSUPPORTED_DATUM],
    ['end の基準', figs({ ...datum({ role: DetailDatumRole.PLACEMENT_ORIGIN, axis: DetailAxis.S, kind: DetailDatumKind.END }), key: 'df-l' }), RoomDetailError.UNSUPPORTED_DATUM],
    ['param 束縛', figs(lShape({ key: 'df-l', moves: [move(PenDir.RIGHT, fixedLen(20)), move(PenDir.DOWN, fixedLen(10)), move(PenDir.RIGHT, paramLen(DetailParam.WALL_THICKNESS, 5))] })), DetailFitError.UNRESOLVED_PARAM],
    ['weightRole 不明（fit が INVALID）', figs(lShape({ key: 'df-l', line: { weightRole: 'bogus', dashRole: DetailDash.SOLID } })), DetailFitError.INVALID],
  ];
  for (const [name, figureOf, code] of cases) {
    const plan = placedFigureDrawPlan([pf()], figureOf);
    assert.equal(plan.marks.length, 1, name);
    assert.deepEqual(plan.marks[0], { figureId: 'p1', x: 300, y: 100, code }, name);
    assert.deepEqual(plan.lines, [], name);
    assert.deepEqual(plan.boxes, [], name);
  }
});

test('(d) 見上げで参照切れは印（subject が分からない）、解決できた衛生器具は印も箱も出ない', () => {
  const missing = placedFigureDrawPlan([pf({ figureKey: 'none' })], figs(), { direction: 'up' });
  assert.equal(missing.marks.length, 1);
  assert.equal(missing.marks[0].code, null);
  const sanitary = placedFigureDrawPlan([pf()], figs(lShape()), { direction: 'up' });
  assert.deepEqual(sanitary, { lines: [], marks: [], boxes: [] });
});

test('(d) 見上げでも平面の配置図でない分類（opening の詳細図）は印 1 つ（code UNSUPPORTED_SLOT。subject の絞りより前）', () => {
  const plan = placedFigureDrawPlan([pf()], figs(lShape({ view: DetailView.ELEVATION, subject: DetailSubject.OPENING })), { direction: 'up' });
  assert.deepEqual(plan.marks, [{ figureId: 'p1', x: 300, y: 100, code: RoomDetailError.UNSUPPORTED_SLOT }]);
  assert.deepEqual(plan.lines, []);
});

test('(d) 解決できない配置があっても他の配置は描く（入力順を保つ）', () => {
  const placed = [pf({ id: 'a', figureKey: 'none' }), pf({ id: 'b', x: 500 }), pf({ id: 'c', figureKey: 'none', x: 900 })];
  const plan = placedFigureDrawPlan(placed, figs(lShape()));
  assert.deepEqual(plan.marks.map(m => m.figureId), ['a', 'c']);
  assert.deepEqual(plan.lines.map(l => l.figureId), ['b']);
});

test('(e) 線の太さの役割は図の値、破線は DASHED だけ（SWING・SOLID は実線）', () => {
  const run = line => placedFigureDrawPlan([pf()], figs(lShape({ line }))).lines[0];
  assert.deepEqual([run({ weightRole: 'thick', dashRole: DetailDash.DASHED }).weight, run({ weightRole: 'thick', dashRole: DetailDash.DASHED }).dashed], ['thick', true]);
  assert.equal(run({ weightRole: 'ultraThick', dashRole: DetailDash.SOLID }).weight, 'ultraThick');
  assert.equal(run({ weightRole: 'medium', dashRole: DetailDash.SWING }).dashed, false);
  assert.equal(run({ weightRole: 'medium', dashRole: DetailDash.SOLID }).dashed, false);
});

test('(e) line を省いた図の太さは既定の役割（DETAIL_DEFAULT_WEIGHT_ROLE）・実線', () => {
  const fig = lShape();
  delete fig.strokes[0].line;
  const l = placedFigureDrawPlan([pf()], figs(fig)).lines[0];
  assert.equal(l.weight, DETAIL_DEFAULT_WEIGHT_ROLE);
  assert.equal(l.dashed, false);
});

test('(e) 閉じたストロークは始点を末尾に足し、開いたストロークは足さない', () => {
  const fig = withOpenStroke(lShape());
  const [closed, open] = placedFigureDrawPlan([pf()], figs(fig)).lines;
  assert.equal(closed.points.length, 14);
  assert.deepEqual(closed.points.slice(0, 2), closed.points.slice(-2));
  assert.equal(open.points.length, 4);
});

test('(f) boxes は描いた線の全頂点の外接（回転 90° でも）', () => {
  const plan = placedFigureDrawPlan([pf({ rotationDeg: 90 })], figs(lShape()));
  // 90°: x = 300 - t（t∈[-10,25] → [275,310]）・y = 100 + s（s∈[-20,15] → [80,115]）
  assert.deepEqual(plan.boxes, [{ figureId: 'p1', minX: 275, minY: 80, maxX: 310, maxY: 115 }]);
  const flat = placedFigureDrawPlan([pf()], figs(lShape()));
  assert.deepEqual(flat.boxes, [{ figureId: 'p1', minX: 280, minY: 90, maxX: 315, maxY: 125 }]);
});

test('(g) 配列でない・空の入力は全部空。入力は変更しない', () => {
  const empty = { lines: [], marks: [], boxes: [] };
  for (const input of [null, undefined, {}, 'x', 3, []]) assert.deepEqual(placedFigureDrawPlan(input, figs(lShape())), empty);
  const placed = Object.freeze([pf()]);
  const fig = lShape();
  const snapshot = JSON.stringify(fig);
  placedFigureDrawPlan(placed, figs(fig));
  assert.equal(JSON.stringify(fig), snapshot);
});

test('同じ図を 3 か所に置くと、形は同じで位置だけが違う（fit は図キーごとのキャッシュを使い回す）', () => {
  const placed = [pf({ id: 'a', x: 300 }), pf({ id: 'b', x: 500, y: 40 }), pf({ id: 'c', x: 700, y: 20 })];
  const plan = placedFigureDrawPlan(placed, figs(lShape()));
  assert.equal(plan.lines.length, 3);
  assert.deepEqual(pairs(plan.lines[1].points)[0], [480, 30]);
  assert.deepEqual(pairs(plan.lines[2].points)[0], [680, 10]);
});

test('fit は図キーごとに 1 回（同じ図を 3 か所に置いても図の datums の読み出し回数は 1 か所のときと同じ）', () => {
  const countingFig = () => {
    const fig = lShape();
    const datums = fig.datums;
    const counter = { reads: 0 };
    Object.defineProperty(fig, 'datums', { get() { counter.reads += 1; return datums; }, enumerable: true });
    return [fig, counter];
  };
  const [one, c1] = countingFig();
  placedFigureDrawPlan([pf({ id: 'a' })], figs(one));
  const [three, c3] = countingFig();
  placedFigureDrawPlan([pf({ id: 'a' }), pf({ id: 'b', x: 500, y: 40 }), pf({ id: 'c', x: 700, y: 20 })], figs(three));
  assert.ok(c1.reads > 0, 'fit が datums を読む');
  assert.equal(c3.reads, c1.reads);
});
