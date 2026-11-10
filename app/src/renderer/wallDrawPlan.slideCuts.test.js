// renderer/wallDrawPlan.js の「壁に入れる建具の穴の区間」（cutsByWall。S3）の単体テスト。
// 外付け引き戸（SLIDE_SINGLE）は穴 cut だけ、他の建具・参照切れ・外壁ホスト（R12）・W≤50 は開口全幅（恒等）で壁を欠く。
// cutsByWall は plan に出ない中間値なので、壁の描画上のスパン（wallLines.get(id).segments＝cuts で分割済み）で確かめる。
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '@core';
import { LodLevel } from '../viewport.js';
import { buildWallDrawPlan } from './wallDrawPlan.js';
import { runInAction } from 'mobx';
import { indexByAxis, findHostWallIndexed } from '../openings/openingGeometry.js';

// 水平の壁（x 0〜6000）。外壁なら isExteriorWall。建具は lo（壁の lo 端からの距離）〜lo+width に置く（refOffset は中心）。
function fixture({ exterior = false } = {}) {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, 0), x1 = cl(CenterLineType.VERTICAL, 6000), y = cl(CenterLineType.HORIZONTAL, 0);
  const wall = graph.addWall(y, 0, false, x0, 0, x1, 0, { isExteriorWall: exterior });
  const open = (subType, lo, width, props = {}, category = OpeningCategory.FITTING) =>
    graph.addOpening(y, 1, false, x0, lo + width / 2, width, category, subType, { swingSide: 1, hingeSide: -1, ...props });
  const segments = (opts) => buildWallDrawPlan(graph, LodLevel.STANDARD, opts).wallLines.get(wall.id).segments;
  return { graph, wall, open, segments };
}

test('引き戸（内壁ホスト）: 穴 cut だけ壁を欠く。W=1550 → 穴 750（戸尻＝hingeSide −1 は hi 側）', () => {
  const { open, segments } = fixture();
  const o = open('sliding', 1000, 1550);
  assert.deepEqual([o.coord1, o.coord2], [1000, 2550], '前提: 建具の範囲');
  assert.deepEqual(segments(), [[0, 1800], [2550, 6000]]);
});

test('引き戸: hingeSide +1 は穴が lo 側（[1000,1750]）', () => {
  const { open, segments } = fixture();
  open('sliding', 1000, 1550, { hingeSide: 1 });
  assert.deepEqual(segments(), [[0, 1000], [1750, 6000]]);
});

test('引き戸以外の建具（片開き戸）は開口全幅を欠く（恒等）', () => {
  const { open, segments } = fixture();
  open('singleSwing', 1000, 800);
  assert.deepEqual(segments(), [[0, 1000], [1800, 6000]]);
});

test('窓（category window の同名キーでも機構は窓の側）は開口全幅を欠く', () => {
  const { open, segments } = fixture();
  open('doubleSliding', 1000, 1600, {}, OpeningCategory.WINDOW);
  assert.deepEqual(segments(), [[0, 1000], [2600, 6000]]);
});

test('複数の建具は lo 昇順に並べて欠く（配置の順に依らない）', () => {
  const { open, segments } = fixture();
  open('singleSwing', 4000, 800);
  open('sliding', 1000, 1550);
  assert.deepEqual(segments(), [[0, 1800], [2550, 4000], [4800, 6000]]);
});

test('天伏の hiddenOpeningIds に入る引き戸は穴を作らない（連なった壁）', () => {
  const { open, segments } = fixture();
  const o = open('sliding', 1000, 1550);
  assert.deepEqual(segments({ hiddenOpeningIds: new Set([o.id]) }), [[0, 6000]]);
  assert.deepEqual(segments({ hiddenOpeningIds: new Set() }), [[0, 1800], [2550, 6000]], '空の集合は従来どおり');
});

test('【失敗系】種別の参照切れ（機構が引けない）は開口全幅を欠く（恒等）', () => {
  const { open, segments } = fixture();
  open('noSuchSubType', 1000, 1550);
  assert.deepEqual(segments(), [[0, 1000], [2550, 6000]]);
});

test('【失敗系】外壁ホストの引き戸は外付けにしない（R12）＝開口全幅を欠く', () => {
  const { open, segments } = fixture({ exterior: true });
  open('sliding', 1000, 1550);
  assert.deepEqual(segments(), [[0, 1000], [2550, 6000]]);
});

test('【失敗系】W≤50 の引き戸は穴が定まらず開口全幅を欠く', () => {
  const { open, segments } = fixture();
  open('sliding', 1000, 50);
  assert.deepEqual(segments(), [[0, 1000], [1050, 6000]]);
});

// 同じ境界に 2 枚の壁（室内向き＝axisOffset −75・外壁＝+75）。建具は wallSide で実ホストが決まり、
// 両方の壁が同じ建具を軸と範囲で拾うが、穴の判定は実ホストで決まる（描いている壁ではない）。
function boundaryFixture() {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const [x0, x1, y] = [cl(CenterLineType.VERTICAL, 0), cl(CenterLineType.VERTICAL, 6000), cl(CenterLineType.HORIZONTAL, 0)];
  const inner = graph.addWall(y, -75, false, x0, 0, x1, 0, { isExteriorWall: false });
  const outer = graph.addWall(y, 75, false, x0, 0, x1, 0, { isExteriorWall: true });
  const slide = (wallSide) => graph.addOpening(y, wallSide, false, x0, 1000 + 1550 / 2, 1550, OpeningCategory.FITTING, 'sliding', { swingSide: 1, hingeSide: -1 });
  const segs = (wall) => buildWallDrawPlan(graph, LodLevel.STANDARD).wallLines.get(wall.id).segments;
  return { graph, inner, outer, slide, segs };
}

test('同じ境界: 室内向き壁がホストの引き戸は、両方の壁で穴 cut だけ欠ける', () => {
  const { inner, outer, slide, segs } = boundaryFixture();
  slide(-1);
  assert.deepEqual(segs(inner), [[0, 1800], [2550, 6000]]);
  assert.deepEqual(segs(outer), [[0, 1800], [2550, 6000]]);
});

test('同じ境界: 外壁ホストの引き戸は、両方の壁で W 全幅を欠く（R12）', () => {
  const { inner, outer, slide, segs } = boundaryFixture();
  slide(1);
  assert.deepEqual(segs(inner), [[0, 1000], [2550, 6000]]);
  assert.deepEqual(segs(outer), [[0, 1000], [2550, 6000]]);
});

test('【失敗系】実ホストが引けない（wallSide が合う壁が無い）引き戸は host null＝外壁でない扱いで cut', () => {
  const { graph, wall, open, segments } = fixture({ exterior: true });
  const o = open('sliding', 1000, 1550); // wallSide 1
  // axisOffset 0 の壁は wallSide によらずホストになるので、負にして wallSide 1 と合わなくする
  runInAction(() => { wall.axisOffset = -75; });
  assert.equal(findHostWallIndexed(o, indexByAxis(graph.walls)), null, '前提: 実ホストが引けない');
  assert.deepEqual(segments(), [[0, 1800], [2550, 6000]], '外壁でも host が引けなければ外壁扱いにならず cut');
});

test('略図 LOD（SCHEMATIC）の単線も穴だけ欠く。外壁ホストは W 全幅', () => {
  const inner = fixture();
  inner.open('sliding', 1000, 1550);
  assert.deepEqual(buildWallDrawPlan(inner.graph, LodLevel.SCHEMATIC).wallLines.get(inner.wall.id).segments, [[0, 1800], [2550, 6000]]);
  const outer = fixture({ exterior: true });
  outer.open('sliding', 1000, 1550);
  assert.deepEqual(buildWallDrawPlan(outer.graph, LodLevel.SCHEMATIC).wallLines.get(outer.wall.id).segments, [[0, 1000], [2550, 6000]]);
});

test('【配線】ShapesLayer の wallDrawPlan のキャッシュ鍵にカタログの世代（overlayGeneration）がある（機構の変化に追従）', () => {
  const lines = fs.readFileSync(path.resolve(import.meta.dirname, 'ShapesLayer.jsx'), 'utf8').split(/\r?\n/)
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'));
  const keyLine = lines.find(l => l.includes('graphComputed(graph, `wallDrawPlan:'));
  assert.ok(keyLine, '前提: wallDrawPlan の graphComputed 呼び出しがある');
  assert.ok(keyLine.includes('${overlayGeneration()}'), 'キャッシュ鍵に overlayGeneration() が無い');
  assert.ok(lines.some(l => /^import \{ overlayGeneration \} from '\.\.\/catalog\/catalogRegistry\.js';/.test(l)), 'overlayGeneration を import していない');
});

test('【失敗系】幅が非有限の建具は壁にぶら下がらず切れ目を作らない', () => {
  const { open, segments } = fixture();
  open('sliding', 1000, NaN);
  assert.deepEqual(segments(), [[0, 6000]]);
});
