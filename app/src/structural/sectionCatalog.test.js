// structural/sectionCatalog.js の単体テスト（overlayを立てない経路）。
// overlayを立てる系（setOverlay/clearOverlays）はsectionCatalog.overlay.test.js
// （node:testはファイル単位で別プロセスのため、overlay汚染を避けて専用ファイルに分ける。
// catalogRegistry.overlay.test.js / core/room.overlay.test.js と同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Project, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { findSectionEntry, woodRectSectionKey, sectionList, SECTION_CATALOG } from './sectionCatalog.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';

test('findSectionEntry: 未知キーはnull', () => {
  assert.equal(findSectionEntry('NO-SUCH-KEY'), null);
  assert.equal(findSectionEntry(null), null);
  assert.equal(findSectionEntry(undefined), null);
});

test('findSectionEntry: overlay空ならSECTION_CATALOGの要素と同一参照（===）を返す（composeCatalogがコピーしない）', () => {
  const builtinEntry = SECTION_CATALOG.find(s => s.key === 'WOOD-120x120');
  assert.ok(builtinEntry, 'WOOD-120x120がSECTION_CATALOGに無い');
  assert.equal(findSectionEntry('WOOD-120x120'), builtinEntry);
});

test('woodRectSectionKey: overlay空ならカタログに無い組み合わせはnull・あるものはキーを返す', () => {
  assert.equal(woodRectSectionKey(120, 120), 'WOOD-120x120');
  assert.equal(woodRectSectionKey(120, 999), null, '存在しない成はnull');
  assert.equal(woodRectSectionKey(999, 120), null, '存在しない幅はnull');
});

test('sectionList: overlay空ならSECTION_CATALOGと同じ要素・同じ順序（===同一性）', () => {
  const list = sectionList();
  assert.equal(list.length, SECTION_CATALOG.length);
  for (let i = 0; i < SECTION_CATALOG.length; i++) {
    assert.equal(list[i], SECTION_CATALOG[i], `index ${i} の要素が同一参照でない`);
  }
});

// ---- 失敗系: 未知のsectionDefIdを持つ部材でも既定300へ落ち、構造再計算は例外を投げない ----
test('【失敗系】未知のsectionDefIdを持つ梁はsectionWidthが既定300へ落ち、recomputeStructuralForGraphは例外を投げない', async () => {
  const project = new Project('proj-unknown-section', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = 'S造'; // S造はwallBeamAxes/framingが無く下階peekが要らないため最小構成で足りる

  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });

  const beam = graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-NO-SUCH-KEY', y0, false, x0, x1, { role: 'primary' });
  assert.equal(beam.sectionWidth, 300, '未知のsectionDefIdはsectionWidthの既定300へ落ちる');

  await assert.doesNotReject(
    () => recomputeStructuralForGraph(graph, project, 'S造'),
    '未知のsectionDefIdがあってもrecomputeStructuralForGraphは例外を投げない',
  );
});

// ---- wiring: MemberListTab.jsx がSECTION_CATALOGを直参照せずsectionList()を使う ----
test('【不変条件・ステップ8e】MemberListTab.jsx: 断面プルダウンの選択肢はSECTION_CATALOGを直参照せずsectionList()を使う', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(!/\bSECTION_CATALOG\b/.test(src), 'MemberListTab.jsxがSECTION_CATALOGを直参照している');
  assert.ok(/\bsectionList\(\)/.test(src), 'MemberListTab.jsxがsectionList()を呼んでいない');
});
