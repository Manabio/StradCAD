// finish/stepSectionLineJoin.js（renderer/StepSectionLayer.jsxの断面線3線分のL字の角の
// 外角閉じ。第6弾）の回帰テスト。実 core.js（Plane/PlanGraph）+ finish/wallGeneration.js で
// 壁を生成した部屋に対して computeStepSections の実データを使う
// （elevation/elevationStepFace.test.js の makeThreeColumnRoom と同じ構成）。
// 統合テストは常に非恒等（offset/scale≠1）のfakeViewportを使う（他の姉妹モジュールと同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from './wallGeneration.js';
import { computeStepSections } from './stepSection.js';
import { stepSectionProfileRenderProps } from './stepSectionLineJoin.js';

const WEIGHTS = { thin: 1, medium: 2, thick: 3, ultraThick: 4 };

function fakeViewport(scaleX, scaleY = scaleX, offsetX = 37, offsetY = -52) {
  return {
    scaleX, scaleY,
    worldToScreen: (x, y) => ({ x: x * scaleX + offsetX, y: y * scaleY + offsetY }),
    screenToWorld: (x, y) => ({ x: (x - offsetX) / scaleX, y: (y - offsetY) / scaleY }),
  };
}

// 3列(0-2000-4000-6000)×1行(0-3000)のLDKに、右列だけFL+100の子部屋(小上がり)を重ねる。
// 境界(x=4000)は壁のない内部境界＝段差断面の間口になる。
function makeStepSectionGraph(childFL = 100) {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  const graph = new PlanGraph(plane);
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const x3 = graph.addCenterLine(CenterLineType.VERTICAL, 6000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const leftKey  = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const midKey   = `${x1.id}:${y0.id}:${x2.id}:${y1.id}`;
  const rightKey = `${x2.id}:${y0.id}:${x3.id}:${y1.id}`;
  const room = graph.addRoom(new Set([leftKey, midKey, rightKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([rightKey]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(childFL);
  return graph;
}

function firstSection(childFL = 100) {
  const graph = makeStepSectionGraph(childFL);
  const sections = computeStepSections(graph);
  assert.equal(sections.length, 1, 'FL差1境界ぶん、1件のはず');
  return sections[0];
}

// 端点(ox,oy)→(nx,ny)の移動量を実スクリーンpxで返す。
function screenDeltaPx(vp, ox, oy, nx, ny) {
  return Math.hypot((nx - ox) * vp.scaleX, (ny - oy) * vp.scaleY);
}

test('統合: 断面線3本の2つの角が、実px基準で相手半幅(1.5px)ぶん外側へ閉じる', () => {
  const section = firstSection();
  const vp = fakeViewport(0.0378);
  const props = stepSectionProfileRenderProps(section, vp, WEIGHTS);
  assert.equal(props.length, 3);

  const [seg0, seg1, seg2] = section.profileSegs;
  const [p0, p1, p2] = props;

  // 外側2端点(seg0の始端・seg2の終端)は角の対象外——不変のはず。
  assert.ok(Math.abs(p0.points[0] - seg0.x1) < 1e-6 && Math.abs(p0.points[1] - seg0.y1) < 1e-6, '断面線の始端(外側)は不変');
  assert.ok(Math.abs(p2.points[2] - seg2.x2) < 1e-6 && Math.abs(p2.points[3] - seg2.y2) < 1e-6, '断面線の終端(外側)は不変');

  // 角1: seg0の終端とseg1の始端がそれぞれ実1.5px分動く（thick=3px×thick=3px・直角）
  assert.ok(Math.abs(screenDeltaPx(vp, seg0.x2, seg0.y2, p0.points[2], p0.points[3]) - 1.5) < 1e-6, '角1: seg0側は実1.5px延長');
  assert.ok(Math.abs(screenDeltaPx(vp, seg1.x1, seg1.y1, p1.points[0], p1.points[1]) - 1.5) < 1e-6, '角1: seg1側は実1.5px延長');

  // 角2: seg1の終端とseg2の始端
  assert.ok(Math.abs(screenDeltaPx(vp, seg1.x2, seg1.y2, p1.points[2], p1.points[3]) - 1.5) < 1e-6, '角2: seg1側は実1.5px延長');
  assert.ok(Math.abs(screenDeltaPx(vp, seg2.x1, seg2.y1, p2.points[0], p2.points[1]) - 1.5) < 1e-6, '角2: seg2側は実1.5px延長');
});

// 太さの判断（旧 StepSectionLayer.jsx の px(weights.thick)＝thick/scaleX）はこの純関数が唯一の供給源。
// 返り値の strokeWidth を厳密一致で固定する（延長量経由の間接検出だけだと2倍化などが素通りする）。
test('断面線のstrokeWidthはthick/scaleXそのもの（旧px(weights.thick)と同値）', () => {
  const vp = fakeViewport(0.0378);
  const props = stepSectionProfileRenderProps(firstSection(), vp, WEIGHTS);
  props.forEach(p => assert.equal(p.strokeWidth, WEIGHTS.thick / vp.scaleX));
});

test('非等方ズーム(scaleX≠scaleY)でもstrokeWidthはscaleX基準（旧px()と同じ）', () => {
  const vp = fakeViewport(0.0378, 0.05);
  const props = stepSectionProfileRenderProps(firstSection(), vp, WEIGHTS);
  props.forEach(p => assert.equal(p.strokeWidth, WEIGHTS.thick / vp.scaleX)); // scaleY基準なら 60 になり落ちる
});

test('段差線(stepLine)は入力に含まれない——返り値は断面線3本のみで、stepLine由来のkeyを持たない', () => {
  const section = firstSection();
  const vp = fakeViewport(0.0378);
  const props = stepSectionProfileRenderProps(section, vp, WEIGHTS);
  assert.equal(props.length, section.profileSegs.length);
  assert.ok(props.every(p => p.key.includes(':profile:')));
});

test('ズーム非依存: 延長量(mm)×scaleXは、scale∈{0.0378,0.001,20}で一定', () => {
  const section = firstSection();
  const seg0 = section.profileSegs[0];
  const results = [0.0378, 0.001, 20].map(scaleX => {
    const vp = fakeViewport(scaleX);
    const props = stepSectionProfileRenderProps(section, vp, WEIGHTS);
    const [, , x2] = props[0].points;
    return (x2 - seg0.x2) * scaleX; // seg0は水平線（x方向にのみ延長される）
  });
  assert.ok(Math.abs(results[0] - results[1]) < 1e-9, `期待:一定, 実際:${results}`);
  assert.ok(Math.abs(results[0] - results[2]) < 1e-9, `期待:一定, 実際:${results}`);
});

test('失敗系: profileSegsが空配列のsection → 空配列を返す', () => {
  const vp = fakeViewport(0.0378);
  assert.deepEqual(stepSectionProfileRenderProps({ id: 'x', profileSegs: [] }, vp, WEIGHTS), []);
});

test('失敗系: lineWeightsPx欠落 → 例外にならず既定1px扱い（thin相当同士のため延長なし）', () => {
  const section = firstSection();
  const vp = fakeViewport(0.0378);
  assert.doesNotThrow(() => {
    const props = stepSectionProfileRenderProps(section, vp, undefined);
    assert.equal(props.length, 3);
    const seg0 = section.profileSegs[0];
    const [, , x2] = props[0].points;
    assert.ok(Math.abs(x2 - seg0.x2) < 1e-6, '既定1px同士(細線扱い)のため延長なし');
  });
});

test('失敗系: scaleXが極小でも例外にならず有限値を返す（延長量は実px基準で一定=1.5px）', () => {
  const section = firstSection();
  const vp = fakeViewport(1e-9);
  const props = stepSectionProfileRenderProps(section, vp, WEIGHTS);
  const seg0 = section.profileSegs[0];
  const [, , x2] = props[0].points;
  assert.ok(Number.isFinite(x2));
  assert.ok(Math.abs(screenDeltaPx(vp, seg0.x2, seg0.y2, x2, props[0].points[3]) - 1.5) < 1e-6);
});
