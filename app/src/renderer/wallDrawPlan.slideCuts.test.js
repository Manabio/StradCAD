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
  assert.deepEqual(segments(), [[0, 1770], [2580, 6000]]);
});

test('引き戸: hingeSide +1 は穴が lo 側（[970,1780]）', () => {
  const { open, segments } = fixture();
  open('sliding', 1000, 1550, { hingeSide: 1 });
  assert.deepEqual(segments(), [[0, 970], [1780, 6000]]);
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
  assert.deepEqual(segments(), [[0, 1770], [2580, 4000], [4800, 6000]]);
});

test('天伏の hiddenOpeningIds に入る引き戸は穴を作らない（連なった壁）', () => {
  const { open, segments } = fixture();
  const o = open('sliding', 1000, 1550);
  assert.deepEqual(segments({ hiddenOpeningIds: new Set([o.id]) }), [[0, 6000]]);
  assert.deepEqual(segments({ hiddenOpeningIds: new Set() }), [[0, 1770], [2580, 6000]], '空の集合は従来どおり');
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
  assert.deepEqual(segs(inner), [[0, 1770], [2580, 6000]]);
  assert.deepEqual(segs(outer), [[0, 1770], [2580, 6000]]);
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
  assert.deepEqual(segments(), [[0, 1770], [2580, 6000]], '外壁でも host が引けなければ外壁扱いにならず cut');
});

test('略図 LOD（SCHEMATIC）の単線も穴だけ欠く。外壁ホストは W 全幅', () => {
  const inner = fixture();
  inner.open('sliding', 1000, 1550);
  assert.deepEqual(buildWallDrawPlan(inner.graph, LodLevel.SCHEMATIC).wallLines.get(inner.wall.id).segments, [[0, 1770], [2580, 6000]]);
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

// ---- 引き代区間の欠き込み（S3b）。壁は水平・軸 y=0・室内向き壁 axisOffset −t/2（材 y∈[−t/2,0]）。建具の pull＝[1000,1800]（欠き込み帯は J ずれて [970,1770]・穴 [1770,2580]）。
// swingSide −1 → runPerpDir −1（hingeSide −1・水平）＝小さい側の面から深さ 50。
function recessFixture({ t = 150, wallSide = -1, exterior = false, withCounterpart = true } = {}) {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const [x0, x1, y] = [cl(CenterLineType.VERTICAL, 0), cl(CenterLineType.VERTICAL, 6000), cl(CenterLineType.HORIZONTAL, 0)];
  const inner = graph.addWall(y, -t / 2, false, x0, 0, x1, 0, { isExteriorWall: exterior });
  const outer = withCounterpart ? graph.addWall(y, t / 2, false, x0, 0, x1, 0, { isExteriorWall: !exterior }) : null;
  const slide = (props = {}, center = 1775) => graph.addOpening(y, wallSide, false, x0, center, 1550, OpeningCategory.FITTING, 'sliding', { swingSide: -1, hingeSide: -1, ...props });
  const door = () => graph.addOpening(y, wallSide, false, x0, 1400, 800, OpeningCategory.FITTING, 'singleSwing', { swingSide: -1, hingeSide: -1 });
  const lines = (wall, opts) => buildWallDrawPlan(graph, LodLevel.STANDARD, opts).wallLines.get(wall.id).lines;
  return { graph, inner, outer, slide, door, lines };
}
const faceAt = (lines, v) => lines.filter(l => !l.vertical && Math.abs(l.at - v) < 1e-6).map(l => [l.lo, l.hi]).sort((a, b) => a[0] - b[0]);

test('buildWallDrawPlan: 内壁の引き戸は 引き代の帯［970,1770］で走る面（y 小）から 50 欠き込む（面線の段差）', () => {
  const { inner, outer, slide, lines } = recessFixture();
  slide();
  // 室内向き壁（材 y∈[−75,0]）: 面 y=−75 は穴 [1770,2580] と引き代の帯 [970,1770] で途切れ、帯では y=−25 に段差（S3c: 枠の外面まで J 広がる）。
  assert.deepEqual(faceAt(lines(inner), -75), [[0, 970], [2580, 6000]]);
  assert.deepEqual(faceAt(lines(inner), -25), [[970, 1770]]);
  // 外壁側の壁（材 y∈[0,75]）は帯（y∈[−75,−25]）と交わらない＝穴の区間以外は不変。
  assert.deepEqual(faceAt(lines(outer), 75), [[0, 1770], [2580, 6000]]);
});

test('buildWallDrawPlan: 走る面が反対（swingSide +1）なら欠き込みは y 大の面側（外壁側の壁が段差になる）', () => {
  const { inner, outer, slide, lines } = recessFixture();
  slide({ swingSide: 1 });
  assert.deepEqual(faceAt(lines(outer), 75), [[0, 970], [2580, 6000]]);
  assert.deepEqual(faceAt(lines(outer), 25), [[970, 1770]]);
  assert.deepEqual(faceAt(lines(inner), -75), [[0, 1770], [2580, 6000]], '室内向き壁は穴だけ');
});

test('【失敗系】buildWallDrawPlan: 外壁ホストの引き戸は帯なし（R12）＝段差の面線が出ない', () => {
  const e = recessFixture({ wallSide: 1 }); // wallSide +1＝外壁（outer）がホスト
  e.slide();
  for (const wall of [e.inner, e.outer]) {
    assert.equal(faceAt(e.lines(wall), -25).length, 0, '段差の面線なし');
    assert.equal(faceAt(e.lines(wall), 25).length, 0);
  }
  assert.deepEqual(faceAt(e.lines(e.inner), -75), [[0, 1000], [2550, 6000]], '外壁ホストは W 全幅（従来）');
});

test('【失敗系】buildWallDrawPlan: 天伏で描かない建具（hiddenOpeningIds）は欠き込みの帯も作らない（T2）', () => {
  const { inner, slide, lines } = recessFixture();
  const o = slide();
  assert.deepEqual(faceAt(lines(inner, { hiddenOpeningIds: new Set([o.id]) }), -75), [[0, 6000]]);
  assert.equal(faceAt(lines(inner, { hiddenOpeningIds: new Set([o.id]) }), -25).length, 0);
});

test('【失敗系】buildWallDrawPlan: 壁厚≤50（T3）・swingSide 0 は帯なし（穴だけ）', () => {
  const thin = recessFixture({ t: 50 });
  thin.slide();
  assert.deepEqual(faceAt(thin.lines(thin.inner), -25), [[0, 1770], [2580, 6000]], '壁厚 50: 面線は穴だけで途切れ、引き代 970〜1770 に段差なし');
  const zero = recessFixture();
  zero.slide({ swingSide: 0 });
  assert.deepEqual(faceAt(zero.lines(zero.inner), -75), [[0, 1770], [2580, 6000]]);
  assert.equal(faceAt(zero.lines(zero.inner), -25).length, 0);
});

test('buildWallDrawPlan: 引き戸以外（片開き戸）は帯を作らない', () => {
  const { inner, door, lines } = recessFixture();
  door();
  assert.deepEqual(faceAt(lines(inner), -75), [[0, 1000], [1800, 6000]], '開口全幅だけ欠く');
  assert.equal(faceAt(lines(inner), -25).length, 0);
});

test('【失敗系】S3c: 引き戸が壁の端に付くと、穴・欠き込みの J 広がりは壁の外へ出ない（壁端で切れる）', () => {
  // W 1550 を lo 4450〜hi 6000（壁の端）に置く。hingeSide −1＝戸先端 hi・cut [5220,6030]、hingeSide +1＝戸先端 lo・recess [5230,6030]。
  const { open, segments } = fixture();
  open('sliding', 4450, 1550);
  assert.deepEqual(segments(), [[0, 5220]], '穴の 6000〜6030 は壁の外＝捨てる');
  const r = recessFixture();
  r.slide({ hingeSide: 1 }, 5225); // runPerpDir +1＝y 大の面（外壁側の壁）に帯
  const outerLines = r.lines(r.outer);
  assert.deepEqual(faceAt(outerLines, 25), [[5230, 6000]], '欠き込みの段差は壁端 6000 で止まる');
  for (const wall of [r.inner, r.outer]) {
    for (const l of r.lines(wall)) {
      if (!l.vertical) assert.ok(l.hi <= 6000 + 1e-6, `壁端を越える線なし: ${l.lo}〜${l.hi}`);
    }
  }
});

test('S3c: 直交壁の材は引き戸の J 広がりで削られない（欠き込みは同じ軸の壁の矩形からだけ引く）', () => {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const [x0, x1, y0, y1] = [cl(CenterLineType.VERTICAL, 0), cl(CenterLineType.VERTICAL, 6000), cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 3000)];
  graph.addWall(y0, -75, false, x0, 0, x1, 0, { isExteriorWall: false });
  const side = graph.addWall(x1, -75, true, y0, 0, y1, 0, { isExteriorWall: false });
  const linesOf = () => buildWallDrawPlan(graph, LodLevel.STANDARD).wallLines.get(side.id).lines.map(l => [l.vertical, l.at, l.lo, l.hi]);
  const before = linesOf();
  assert.ok(before.length > 0, '前提: 直交壁に線がある');
  graph.addOpening(y0, -1, false, x0, 5225, 1550, OpeningCategory.FITTING, 'sliding', { swingSide: 1, hingeSide: 1 });
  assert.deepEqual(linesOf(), before, '壁端の引き戸（枠の外面は x 6030）を足しても直交壁の線は不変');
});

test('【失敗系】幅が非有限の建具は壁にぶら下がらず切れ目を作らない', () => {
  const { open, segments } = fixture();
  open('sliding', 1000, NaN);
  assert.deepEqual(segments(), [[0, 6000]]);
});
