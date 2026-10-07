// resolveStairSideLines（側面線の壁有無の解決）の回帰テスト。
// 第4引数 wallGraph（upper エントリ＝上の階から見る側面線は表示中の階の壁で判定）の挙動を固定する。
// フィクスチャ: 縦長1セル（x:0〜1000, y:0〜2800）の直進階段。側面線は x=57.5（左辺・CL値0）と
// x=942.5（右辺・CL値1000）、y は 57.5〜2742.5。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { classifyStairArea, measureStairSpans } from './stairClassify.js';
import { buildStairGeometry, resolveStairSideLines } from './stairGeometry.js';
import { roomBounds } from '../gridCells.js';

function setup() {
  const lower = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => lower.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => lower.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), x1 = V(1000), y0 = H(0), y1 = H(2800);
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const cells = new Set([key]);
  const cls = classifyStairArea(cells, lower, 2800, [key]);
  const stair = lower.addStair({ type: cls.type, cells, upDirection: cls.upDirection, flip: cls.flip, sections: cls.sections });
  const geom = buildStairGeometry(stair, roomBounds(cells, lower), {
    view: 'upper', detail: true, riser: 200, spans: measureStairSpans(stair, lower), laneGap: false,
  });
  return { lower, stair, geom };
}
// 壁だけを差し替えた別オブジェクト（下階グラフ／自階グラフが別物である本番の入力形）
const withWalls = (graph, walls) => Object.create(graph, { walls: { value: walls } });
const vWall = (axisValue, c1, c2) => ({ isVertical: true, axisCL: { value: axisValue }, coord1: c1, coord2: c2 });
const sides = (g) => g.outline.filter(s => s.side);
const leftOf = (g) => sides(g).filter(s => Math.abs(s.x1 - 57.5) < 1);
const rightOf = (g) => sides(g).filter(s => Math.abs(s.x1 - 942.5) < 1);
const spanOf = (s) => [Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)];

test('wallGraph 省略: 従来どおり graph の壁で判定し、floorEdge は付かない', () => {
  const { lower, stair, geom } = setup();
  const g = resolveStairSideLines(stair, withWalls(lower, [vWall(0, 0, 2800)]), geom);
  assert.equal(leftOf(g).length, 0, '左辺は壁で覆われ消える');
  assert.equal(rightOf(g).length, 1);
  assert.equal(rightOf(g)[0].medium, true);
  assert.equal('floorEdge' in rightOf(g)[0], false, 'タグ無し');
});

// StairLayer は install エントリにも { wallGraph: undefined } を渡す（省略ではない）。
test('wallGraph: undefined は省略と同じ結果（install エントリが渡す形）', () => {
  const { lower, stair, geom } = setup();
  const graph = withWalls(lower, [vWall(0, 0, 1000)]);
  const g = resolveStairSideLines(stair, graph, geom, { wallGraph: undefined });
  assert.deepEqual(g.outline, resolveStairSideLines(stair, graph, geom).outline);
  assert.ok(g.outline.every(s => !('floorEdge' in s)));
});

test('wallGraph あり・自階に壁なし（下階には壁あり）: 線が残り floorEdge・medium', () => {
  const { lower, stair, geom } = setup();
  const lowerWithWall = withWalls(lower, [vWall(0, 0, 2800)]);
  const active = withWalls(lower, []);
  const g = resolveStairSideLines(stair, lowerWithWall, geom, { wallGraph: active });
  assert.equal(leftOf(g).length, 1);
  assert.equal(leftOf(g)[0].floorEdge, true);
  assert.equal(leftOf(g)[0].medium, true);
  assert.deepEqual(spanOf(leftOf(g)[0]), [57.5, 2742.5]);
});

test('wallGraph あり・自階に壁あり（下階には壁なし）: 線が消える', () => {
  const { lower, stair, geom } = setup();
  const g = resolveStairSideLines(stair, withWalls(lower, []), geom, { wallGraph: withWalls(lower, [vWall(0, 0, 2800)]) });
  assert.equal(leftOf(g).length, 0);
  assert.equal(rightOf(g).length, 1, '壁の無い右辺は残る');
  assert.equal(rightOf(g)[0].floorEdge, true);
});

test('wallGraph あり・壁が区間の一部だけ: 残り区間だけが floorEdge で残る', () => {
  const { lower, stair, geom } = setup();
  const g = resolveStairSideLines(stair, lower, geom, { wallGraph: withWalls(lower, [vWall(0, 0, 1000)]) });
  assert.equal(leftOf(g).length, 1);
  assert.deepEqual(spanOf(leftOf(g)[0]), [1000, 2742.5]);
  assert.equal(leftOf(g)[0].floorEdge, true);
});

test('wallGraph あり: side でない線分は不変（タグも付かない）', () => {
  const { lower, stair, geom } = setup();
  const g = resolveStairSideLines(stair, lower, geom, { wallGraph: withWalls(lower, []) });
  const before = geom.outline.filter(s => !s.side);
  const after = g.outline.filter(s => !s.side);
  assert.deepEqual(after, before);
  assert.ok(after.every(s => !('floorEdge' in s)));
});
