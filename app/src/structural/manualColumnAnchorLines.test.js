// core/centerLineKindPolicy.js manualColumnAnchorLines（柱を立てられる線の向き別列挙）のテスト。
// fixture は原点から離した座標に置く（符号・オフセットの変異を拾うため）。.jsx/store.js/snap.js は import しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Project, CenterLineType, Discipline } from '../core.js';
import {
  MANUAL_COLUMN_ANCHOR_KINDS_BY_MODE, manualColumnAnchorLines, beamAxisCenterLines as policyBeamAxisCenterLines,
  APP_MODES, VISIBLE_KINDS_BY_MODE,
} from '../core/centerLineKindPolicy.js';
import { columnAnchorLinesFor, intersectionMemberOptions } from './columnEditTarget.js';
import { beamAxisCenterLines } from './structuralAutoFill.js';
import { rulesFor, effectiveStructure, TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { extractArrowFunctionBody } from '../uiBusySourceScan.js';

const V = CenterLineType.VERTICAL, H = CenterLineType.HORIZONTAL;

// 通り芯（structGraph）・中心線・補助線・梁芯・天井芯を縦横に混ぜた階。追加順は並びの検証のためあえて種別を交互にする。
function makeMixedGraph(structure = 'S造') {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = structure;
  const sg = project.structGraph;
  const gx = [sg.addCenterLine(V, 1300, { labeled: true, discipline: Discipline.STRUCT }),
              sg.addCenterLine(V, 5300, { labeled: true, discipline: Discipline.STRUCT })];
  const gy = [sg.addCenterLine(H, 2700, { labeled: true, discipline: Discipline.STRUCT }),
              sg.addCenterLine(H, 6700, { labeled: true, discipline: Discipline.STRUCT })];
  const center = (t, v) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const aux = (t, v) => graph.addCenterLine(t, v, { labeled: false, lineType: 'dashed' });
  const beam = (t, v) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.FUSE });
  const ceil = (t, v) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.CEILING });
  const lines = {
    cV1: center(V, 2100), bV1: beam(V, 3100), aV: aux(V, 2900), cV2: center(V, 4100), ceV: ceil(V, 3700), bV2: beam(V, 4600),
    cH1: center(H, 3300), bH1: beam(H, 4400), aH: aux(H, 3900), cH2: center(H, 5500), ceH: ceil(H, 4900), bH2: beam(H, 6100),
  };
  return { project, graph, gx, gy, lines };
}
const ids = cls => cls.map(c => c.id);

test('【柱アンカー・平面】通り芯→中心線の順。補助線・梁芯・天井芯は含まない', () => {
  const { graph, gx, gy, lines } = makeMixedGraph();
  const r = manualColumnAnchorLines(graph, 'floorplan');
  assert.deepEqual(ids(r.verticals), ids([...gx, lines.cV1, lines.cV2]));
  assert.deepEqual(ids(r.horizontals), ids([...gy, lines.cH1, lines.cH2]));
});

test('【柱アンカー・平面】beamAxesAllowed を渡しても梁芯は入らない', () => {
  const { graph, gx, gy, lines } = makeMixedGraph();
  const r = manualColumnAnchorLines(graph, 'floorplan', { beamAxesAllowed: true });
  assert.deepEqual(ids(r.verticals), ids([...gx, lines.cV1, lines.cV2]));
  assert.deepEqual(ids(r.horizontals), ids([...gy, lines.cH1, lines.cH2]));
});

test('【柱アンカー・構造】beamAxesAllowed 真＝通り芯→梁芯（beamAxisCenterLines と同集合・同順）。中心線は入らない', () => {
  const { graph, gx, gy } = makeMixedGraph();
  const r = manualColumnAnchorLines(graph, 'structure', { beamAxesAllowed: true });
  const beams = beamAxisCenterLines(graph);
  assert.equal(beams.length, 4, '前提: 梁芯 4 本');
  assert.deepEqual(ids(beams), ids(policyBeamAxisCenterLines(graph)));
  assert.deepEqual(ids(r.verticals), ids([...gx, ...beams.filter(c => c.centerLineType === V)]));
  assert.deepEqual(ids(r.horizontals), ids([...gy, ...beams.filter(c => c.centerLineType === H)]));
});

test('【柱アンカー・構造】beamAxesAllowed 偽＝通り芯だけ', () => {
  const { graph, gx, gy } = makeMixedGraph();
  const r = manualColumnAnchorLines(graph, 'structure', { beamAxesAllowed: false });
  assert.deepEqual(ids(r.verticals), ids(gx));
  assert.deepEqual(ids(r.horizontals), ids(gy));
});

test('【柱アンカー・失敗側】未知の appMode・表に無い appMode・構造で beamAxesAllowed 省略は throw', () => {
  const { graph } = makeMixedGraph();
  assert.throws(() => manualColumnAnchorLines(graph, 'noSuchMode', { beamAxesAllowed: true }), /未対応のappMode/);
  assert.throws(() => manualColumnAnchorLines(graph, 'finish'), /未対応のappMode/);
  assert.throws(() => manualColumnAnchorLines(graph, 'constructor'), /未対応のappMode/);
  assert.throws(() => manualColumnAnchorLines(graph, 'structure'), /beamAxesAllowed/);
  assert.throws(() => manualColumnAnchorLines(graph, 'structure', {}), /beamAxesAllowed/);
});

test('【柱アンカー・表】平面＝中心線・構造＝梁芯（通り芯は表に入れない）', () => {
  assert.deepEqual(MANUAL_COLUMN_ANCHOR_KINDS_BY_MODE.floorplan, ['center']);
  assert.deepEqual(MANUAL_COLUMN_ANCHOR_KINDS_BY_MODE.structure, ['beam']);
  assert.ok(Object.isFrozen(MANUAL_COLUMN_ANCHOR_KINDS_BY_MODE));
  assert.ok(Object.isFrozen(MANUAL_COLUMN_ANCHOR_KINDS_BY_MODE.structure));
});

// 構造リスト「＋追加」の旧式（差し替え前の MemberListTab.jsx と同じ式）と選択肢が一致すること。
function legacyOptions(graph, project, mapName) {
  const wallColumns = mapName === 'columnMap' && rulesFor(effectiveStructure(graph, project)).columnPlacement === 'wallIntersections';
  const beamAxes = wallColumns ? beamAxisCenterLines(graph) : [];
  return {
    verticals: [...graph.gridXs, ...beamAxes.filter(cl => cl.centerLineType === V)],
    horizontals: [...graph.gridYs, ...beamAxes.filter(cl => cl.centerLineType === H)],
  };
}
for (const [label, structure, wood] of [['在来木造（梁芯あり）', TRADITIONAL_WOOD_STRUCTURE, true], ['非在来（S造・通り芯だけ）', 'S造', false]]) {
  test(`【柱アンカー・構造リスト一致】${label}: 旧式と id の列が同じ`, () => {
    const { graph, project } = makeMixedGraph(structure);
    const wallColumns = rulesFor(effectiveStructure(graph, project)).columnPlacement === 'wallIntersections';
    assert.equal(wallColumns, wood, '前提: 梁芯の可否');
    const now = manualColumnAnchorLines(graph, 'structure', { beamAxesAllowed: wallColumns });
    const old = legacyOptions(graph, project, 'columnMap');
    assert.deepEqual(ids(now.verticals), ids(old.verticals));
    assert.deepEqual(ids(now.horizontals), ids(old.horizontals));
    assert.equal(now.verticals.length, wood ? 4 : 2);
  });
}

// 構造リストの選択肢（intersectionMemberOptions）が旧式と id 列で一致すること。柱・基礎(footingMap) × 在来木造・非在来。
// 基礎は在来木造でも梁芯が混ざらない（通り芯だけ）。
for (const mapName of ['columnMap', 'footingMap']) {
  for (const [label, structure] of [['在来木造', TRADITIONAL_WOOD_STRUCTURE], ['非在来', 'S造']]) {
    test(`【構造リスト選択肢】${mapName}×${label}: 旧式の列挙と id の列が同じ`, () => {
      const { graph, project } = makeMixedGraph(structure);
      const now = intersectionMemberOptions(mapName, graph, project);
      const old = legacyOptions(graph, project, mapName);
      assert.deepEqual(ids(now.verticals), ids(old.verticals));
      assert.deepEqual(ids(now.horizontals), ids(old.horizontals));
      const withBeams = mapName === 'columnMap' && structure === TRADITIONAL_WOOD_STRUCTURE;
      assert.equal(now.verticals.length, withBeams ? 4 : 2, '梁芯が入るのは在来木造の柱だけ');
    });
  }
}

test('【柱を立てられる線の口】columnAnchorLinesFor: floorplan＝通り芯＋中心線／structure は主構造で梁芯の可否が決まる', () => {
  const wood = makeMixedGraph(TRADITIONAL_WOOD_STRUCTURE);
  const steel = makeMixedGraph('S造');
  const fp = columnAnchorLinesFor(steel.graph, steel.project, 'floorplan');
  assert.deepEqual(ids(fp.verticals), ids([...steel.gx, steel.lines.cV1, steel.lines.cV2]));
  assert.deepEqual(ids(fp.horizontals), ids([...steel.gy, steel.lines.cH1, steel.lines.cH2]));
  const stWood = columnAnchorLinesFor(wood.graph, wood.project, 'structure');
  assert.deepEqual(ids(stWood.verticals), ids([...wood.gx, wood.lines.bV1, wood.lines.bV2]));
  assert.deepEqual(ids(stWood.horizontals), ids([...wood.gy, wood.lines.bH1, wood.lines.bH2]));
  const stSteel = columnAnchorLinesFor(steel.graph, steel.project, 'structure');
  assert.deepEqual(ids(stSteel.verticals), ids(steel.gx));
  assert.deepEqual(ids(stSteel.horizontals), ids(steel.gy));
  assert.throws(() => columnAnchorLinesFor(steel.graph, steel.project, 'finish'), /未対応のappMode/);
});

// MemberListTab.jsx（.jsx は import できない）の NewIntersectionMemberSelector をソース走査で固定する。
// ブロックコメントを除いたうえで、選択肢の取得行を**1 行まるごと**一致で数える（行末コメントへ移す・文字列リテラルに入れる・
// 別の式に戻す変異は、行の形が変わるので一致しなくなる）。
test('【配線】NewIntersectionMemberSelector は intersectionMemberOptions を 1 行で 1 回呼び、列挙を自前で持たない', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const body = extractArrowFunctionBody(src, 'const NewIntersectionMemberSelector = observer(({ group, graph, project, structure }) => {');
  const wholeLines = line => (body.match(new RegExp(`^\\s*${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'gm')) || []).length;
  const count = needle => body.split(needle).length - 1;
  assert.equal(wholeLines('const { verticals: verticalOptions, horizontals: horizontalOptions } = intersectionMemberOptions(group.mapName, graph, project);'), 1);
  assert.equal(count('intersectionMemberOptions('), 1);
  assert.equal(count('verticalOptions.find('), 1, '縦の選択肢はこの戻り値から取った verticalOptions だけを使う');
  assert.equal(count('horizontalOptions.find('), 1);
  for (const forbidden of ['graph.gridXs', 'graph.gridYs', 'beamAxisCenterLines', 'manualColumnAnchorLines(']) {
    assert.equal(count(forbidden), 0, `${forbidden} が NewIntersectionMemberSelector に残っている`);
  }
  // import は 1 行まるごと（import 行が消える・コメントアウトされる変異を拾う）
  const importLines = src.split(/\r?\n/).filter(l => l === "import { intersectionMemberOptions } from './columnEditTarget.js';");
  assert.equal(importLines.length, 1);
});

test('【表の不変条件】MANUAL_COLUMN_ANCHOR_KINDS_BY_MODE: キーは APP_MODES・各種別はそのモードの可視種別に含まれる', () => {
  for (const [mode, kinds] of Object.entries(MANUAL_COLUMN_ANCHOR_KINDS_BY_MODE)) {
    assert.ok(APP_MODES.includes(mode), `${mode} が APP_MODES に無い`);
    assert.ok(Object.isFrozen(kinds));
    // 平面・構造で可視（描かれて見える）線だけが柱を立てる位置になれる。構造の梁芯は構造モードで可視。
    // 平面の中心線は floorplan で可視。
    for (const k of kinds) assert.ok(VISIBLE_KINDS_BY_MODE[mode].includes(k), `${mode} で ${k} は可視ではない`);
  }
});
