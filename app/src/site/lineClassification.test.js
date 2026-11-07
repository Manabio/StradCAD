// computeOuterLineIds（三斜の最外周＝三角形1つにしか属さない辺・三角形が無い線分）のテスト。
// 実 core/site.js の Site を使う（triangleMap/lines の実挙動に依存するため）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site, SiteLineKind } from '../core.js';
import { computeOuterLineIds } from './lineClassification.js';

// 底辺(0,0)-(1000,0)と頂点を持つ三角形1つ（底辺・赤辺・青辺の3線）
function buildTriangle(site, apexX, apexY) {
  const sp = site.addPoint(0, 0);
  const ep = site.addPoint(1000, 0);
  const base = site.addLine(sp, ep, SiteLineKind.SURVEY);
  const apex = site.addPoint(apexX, apexY);
  site.addTriangle(base, apex, SiteLineKind.SURVEY);
  const red  = site.addLine(sp, apex, SiteLineKind.SURVEY);
  const blue = site.addLine(ep, apex, SiteLineKind.SURVEY);
  return { sp, ep, base, apex, red, blue };
}

test('computeOuterLineIds: 線1本（三角形なし）は外周', () => {
  const site = new Site();
  const line = site.addLine(site.addPoint(0, 0), site.addPoint(1000, 0), SiteLineKind.SURVEY);
  assert.deepEqual([...computeOuterLineIds(site)], [line.id]);
});

test('computeOuterLineIds: 三角形1つなら3辺とも外周', () => {
  const site = new Site();
  const t = buildTriangle(site, 640, 480);
  assert.deepEqual([...computeOuterLineIds(site)].sort(), [t.base.id, t.red.id, t.blue.id].sort());
});

test('computeOuterLineIds: 三角形2つで共有される底辺（赤辺を底辺にした2つ目）は内側、残り4辺は外周', () => {
  const site = new Site();
  const t = buildTriangle(site, 640, 480);
  // 赤辺(sp-apex)を底辺として反対側へ2つ目の三角形を作る
  const apex2 = site.addPoint(-200, 600);
  site.addTriangle(t.red, apex2, SiteLineKind.SURVEY);
  const red2  = site.addLine(t.sp, apex2, SiteLineKind.SURVEY);
  const blue2 = site.addLine(t.apex, apex2, SiteLineKind.SURVEY);
  const outer = computeOuterLineIds(site);
  assert.equal(outer.has(t.red.id), false, '2つの三角形に属する辺は内側');
  for (const l of [t.base, t.blue, red2, blue2]) assert.equal(outer.has(l.id), true, `${l.id} は外周`);
  assert.equal(outer.size, 4);
});

test('computeOuterLineIds【失敗系】: 線が空なら空集合／三斜外の種別（OTHER）は対象外', () => {
  const site = new Site();
  assert.equal(computeOuterLineIds(site).size, 0);
  site.addLine(site.addPoint(0, 0), site.addPoint(500, 0), SiteLineKind.OTHER);
  assert.equal(computeOuterLineIds(site).size, 0);
});
