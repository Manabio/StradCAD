import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site, SiteLineKind } from '../core.js';
import { computeDeletableTriangleIds, rowDeleteAction, triangleNumber } from './triangleDeletion.js';

// 底辺 base(A-B) → tri1（頂点C。赤辺 A-C・青辺 B-C）。chain=true なら
// tri2（底辺＝tri1 の赤辺 A-C、頂点D。赤辺 A-D・青辺 C-D）も足す。
function build({ chain = false, tri = true } = {}) {
  const site = new Site();
  const A = site.addPoint(0, 0), B = site.addPoint(1000, 0);
  const base = site.addLine(A, B, SiteLineKind.SURVEY);
  site.history.push({ type: 'base', lineId: base.id, length: 1000 });
  const out = { site, base };
  if (!tri) return out;
  const C = site.addPoint(640, 480);
  const t1 = site.addTriangle(base, C, SiteLineKind.SURVEY);
  const red1 = site.addLine(A, C, SiteLineKind.SURVEY);
  const blue1 = site.addLine(B, C, SiteLineKind.SURVEY);
  site.history.push({
    type: 'triangle', baseLineId: base.id,
    redLineId: red1.id, redLen: 800, redKind: SiteLineKind.SURVEY,
    blueLineId: blue1.id, blueLen: 600, blueKind: SiteLineKind.SURVEY,
    triangleId: t1.id, triangleLineKind: SiteLineKind.SURVEY, side: 1,
  });
  Object.assign(out, { t1, red1, blue1, A, B, C });
  if (!chain) return out;
  const D = site.addPoint(-200, 600);
  const t2 = site.addTriangle(red1, D, SiteLineKind.SURVEY);
  const red2 = site.addLine(A, D, SiteLineKind.SURVEY);
  const blue2 = site.addLine(C, D, SiteLineKind.SURVEY);
  site.history.push({
    type: 'triangle', baseLineId: red1.id,
    redLineId: red2.id, redLen: 632, redKind: SiteLineKind.SURVEY,
    blueLineId: blue2.id, blueLen: 900, blueKind: SiteLineKind.SURVEY,
    triangleId: t2.id, triangleLineKind: SiteLineKind.SURVEY, side: -1,
  });
  Object.assign(out, { t2, red2, blue2, D });
  return out;
}

test('rowDeleteAction: 三角形が無い最初の1本だけの行は base', () => {
  const { site, base } = build({ tri: false });
  assert.deepEqual(rowDeleteAction(site, base.id), { type: 'base' });
  assert.equal(computeDeletableTriangleIds(site).size, 0);
});

test('rowDeleteAction: 三角形が1つ。赤辺・青辺の行は triangle、底辺の行は null', () => {
  const { site, base, t1, red1, blue1 } = build();
  assert.deepEqual(rowDeleteAction(site, red1.id),  { type: 'triangle', triangleId: t1.id, historyIndex: 1 });
  assert.deepEqual(rowDeleteAction(site, blue1.id), { type: 'triangle', triangleId: t1.id, historyIndex: 1 });
  assert.equal(rowDeleteAction(site, base.id), null, '三角形があれば最初の1本は消せない');
});

test('rowDeleteAction【失敗系】: 履歴に無い線分は null', () => {
  const { site } = build();
  assert.equal(rowDeleteAction(site, 'no-such-line'), null);
});

test('端の三角形: 鎖（tri2 の底辺が tri1 の赤辺）では tri1 は端でなく tri2 だけが端、tri2 を除くと tri1 が端', () => {
  const { site, t1, t2, red1, blue1, red2, blue2 } = build({ chain: true });
  assert.deepEqual([...computeDeletableTriangleIds(site)], [t2.id]);
  assert.equal(rowDeleteAction(site, red1.id), null, 'tri1 の赤辺は tri2 の底辺');
  assert.equal(rowDeleteAction(site, blue1.id), null, '同じ三角形の青辺も出さない');
  assert.deepEqual(rowDeleteAction(site, red2.id), { type: 'triangle', triangleId: t2.id, historyIndex: 2 });
  assert.deepEqual(rowDeleteAction(site, blue2.id), { type: 'triangle', triangleId: t2.id, historyIndex: 2 });

  site.history.splice(2, 1); // tri2 を除いた状態
  assert.deepEqual([...computeDeletableTriangleIds(site)], [t1.id]);
});

test('端の三角形: 青辺だけが後の三角形の底辺でも tri1 は端でない（赤辺・青辺の両方を見る）', () => {
  const { site, red1, blue1, B, C } = build();
  const E = site.addPoint(1300, 700);
  const t2 = site.addTriangle(blue1, E, SiteLineKind.SURVEY);
  const red2 = site.addLine(B, E, SiteLineKind.SURVEY);
  const blue2 = site.addLine(C, E, SiteLineKind.SURVEY);
  site.history.push({
    type: 'triangle', baseLineId: blue1.id,
    redLineId: red2.id, redLen: 500, redKind: SiteLineKind.SURVEY,
    blueLineId: blue2.id, blueLen: 700, blueKind: SiteLineKind.SURVEY,
    triangleId: t2.id, triangleLineKind: SiteLineKind.SURVEY, side: 1,
  });
  assert.deepEqual([...computeDeletableTriangleIds(site)], [t2.id]);
  assert.equal(rowDeleteAction(site, red1.id), null);
  assert.equal(rowDeleteAction(site, blue1.id), null);
});

test('triangleNumber: 底辺の lineMap 順（computeLineTriNums と同じ採番）。無い id は null', () => {
  const { site, t1, t2 } = build({ chain: true });
  assert.equal(triangleNumber(site, t1.id), 1);
  assert.equal(triangleNumber(site, t2.id), 2);
  assert.equal(triangleNumber(site, 'none'), null);
});
