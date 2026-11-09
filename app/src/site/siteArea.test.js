import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site, SiteLineKind } from '../core.js';
import { triangleNumber } from './triangleDeletion.js';
import { computeLineTriNums } from './lineClassification.js';
import {
  truncateAreaM2, buildSanshaAreaRows, buildRectAreaRows, sumAreaM2, rectsOverlap, formatAreaM2,
} from './siteArea.js';

const R = (id, x, y, w, h) => ({ id, x, y, w, h });

// 底辺 A-B(1000)→tri1（頂点C）→tri2（底辺＝tri1 の赤辺 A-C、頂点D）
function buildChain() {
  const site = new Site();
  const A = site.addPoint(0, 0), B = site.addPoint(1000, 0);
  const base = site.addLine(A, B, SiteLineKind.SURVEY);
  const C = site.addPoint(640, 480);
  const t1 = site.addTriangle(base, C, SiteLineKind.SURVEY);
  const red1 = site.addLine(A, C, SiteLineKind.SURVEY);
  site.addLine(B, C, SiteLineKind.SURVEY);
  const D = site.addPoint(-200, 600);
  const t2 = site.addTriangle(red1, D, SiteLineKind.SURVEY);
  site.addLine(A, D, SiteLineKind.SURVEY);
  site.addLine(C, D, SiteLineKind.SURVEY);
  return { site, t1, t2 };
}

test('truncateAreaM2: 小数第3位以下切り捨て（四捨五入ではない）', () => {
  assert.equal(truncateAreaM2(12.345678), 12.34);
  assert.equal(truncateAreaM2(11.108889), 11.1);
  assert.equal(truncateAreaM2(0), 0);
  assert.equal(truncateAreaM2(12), 12);
  assert.equal(truncateAreaM2(12.999), 12.99, '12.999 は 13.00 に繰り上げない');
});

test('truncateAreaM2: 浮動小数で僅かに下振れする値は本来の値へ（11.9999999999→12.00）', () => {
  assert.equal(truncateAreaM2(11.9999999999), 12);
  assert.equal(formatAreaM2(truncateAreaM2(11.9999999999)), '12.00');
});

test('buildSanshaAreaRows: 番号は三角番号（triangleNumber・computeLineTriNums と一致）・面積は切り捨て後', () => {
  const { site, t1, t2 } = buildChain();
  const rows = buildSanshaAreaRows(site);
  assert.deepEqual(rows.map(r => r.num), [1, 2]);
  assert.equal(triangleNumber(site, t1.id), rows[0].num);
  assert.equal(triangleNumber(site, t2.id), rows[1].num);
  const triNums = computeLineTriNums(site);
  assert.deepEqual([...triNums.values()].flat().filter((n, i, a) => a.indexOf(n) === i).sort(), [1, 2]);
  assert.equal(rows[0].areaM2, truncateAreaM2(t1.area));
  assert.equal(rows[1].areaM2, truncateAreaM2(t2.area));
  assert.match(rows[0].formula, /^1000 × \d+ ÷ 2$/);
  assert.ok(rows[0].areaM2 <= t1.area && t1.area - rows[0].areaM2 < 0.01, '切り捨ては 0.01 ㎡未満の差');
});

test('【失敗系】buildSanshaAreaRows: 三角形が無ければ行なし・合計 0', () => {
  const site = new Site();
  const A = site.addPoint(0, 0), B = site.addPoint(1000, 0);
  site.addLine(A, B, SiteLineKind.SURVEY);
  const rows = buildSanshaAreaRows(site);
  assert.deepEqual(rows, []);
  assert.equal(sumAreaM2(rows), 0);
});

test('buildRectAreaRows / sumAreaM2: 合算は切り捨て後の値の和（素の和 23.108889 と区別）', () => {
  const rects = [R('a', 0, 0, 4000, 3000), R('b', 5000, 0, 3333, 3333)];
  const rows = buildRectAreaRows(rects);
  assert.deepEqual(rows, [
    { num: 1, formula: '4000 × 3000', areaM2: 12 },
    { num: 2, formula: '3333 × 3333', areaM2: 11.1 },
  ]);
  assert.equal(sumAreaM2(rows), 23.1);
  assert.notEqual(sumAreaM2(rows), 23.108889);
});

test('【失敗系】buildRectAreaRows: 長方形が無ければ行なし・合計 0', () => {
  assert.deepEqual(buildRectAreaRows([]), []);
  assert.equal(sumAreaM2([]), 0);
});

test('rectsOverlap: 辺で接する→false・角だけ→false・重なる→true・包含→true・空→false', () => {
  assert.equal(rectsOverlap([R('a', 0, 0, 4000, 3000), R('b', 4000, 0, 4000, 3000)]), false);
  assert.equal(rectsOverlap([R('a', 0, 0, 1000, 1000), R('b', 1000, 1000, 1000, 1000)]), false, '角だけの接触は重なりでない');
  assert.equal(rectsOverlap([R('a', 0, 0, 4000, 3000), R('b', 2000, 0, 4000, 3000)]), true);
  assert.equal(rectsOverlap([R('a', 0, 0, 1000, 1000), R('b', 100, 100, 100, 100)]), true, '包含も重なり');
  assert.equal(rectsOverlap([]), false);
});

test('rectsOverlap: 1 mm² だけの重なりも true（閾値は 1 mm² より十分小さい）', () => {
  assert.equal(rectsOverlap([R('a', 0, 0, 1000, 1000), R('b', 999, 999, 1000, 1000)]), true);
});

test('buildRectAreaRows: 1000×290 は 0.29（0.29×100=28.999…の下振れで 0.28 にしない）', () => {
  assert.equal(buildRectAreaRows([R('a', 0, 0, 1000, 290)])[0].areaM2, 0.29);
});

test('【失敗系】buildSanshaAreaRows: 線も無い空の Site は行なし', () => {
  assert.deepEqual(buildSanshaAreaRows(new Site()), []);
});
