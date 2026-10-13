// wallFreshnessKey（壁の鮮度キー）の決定性テストと、鍵の入力が変わりうる箇所を
// 見落とさないための不変条件テスト（壁の再生成をFinishModeStateから独立させる計画のステップ1）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInAction } from 'mobx';
import { Plane, PlanGraph, Project, Stair, CenterLineType, Discipline, RoomKind, RoomFeature } from '@core';
import { wallFreshnessKey, WALL_KEY_VERSION, STAIR_KEY_FIELDS } from './wallFreshnessKey.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function addCL(graph, type, value) {
  return graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.ARCH });
}

function makeRoom(graph, name = '部屋A') {
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 3000);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const y1 = addCL(graph, CenterLineType.HORIZONTAL, 3000);
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  return graph.addRoom(new Set([key]), name);
}

test('wallFreshnessKey: 書式は {version}|ext=...|int=...|shaft=...|str=...|col=...|rooms=...|fh=...|geo=...|cells=...|stairs=... で、バージョン定数と一致する', () => {
  const graph = makeGraph();
  const key = wallFreshnessKey(graph);
  assert.equal(WALL_KEY_VERSION, 'v8');
  assert.ok(key.startsWith(`${WALL_KEY_VERSION}|ext=`));
  assert.match(key, /\|ext=[^|]*\|int=[^|]*\|shaft=[^|]*\|str=[^|]*\|col=[^|]*\|rooms=[^|]*\|fh=[^|]*\|geo=[0-9a-z]+\|cells=[0-9a-z]+\|stairs=[0-9a-z]+$/);
});

test('wallFreshnessKey: 同じ graph から2回計算すると同一の鍵になる（決定性）', () => {
  const graph = makeGraph();
  makeRoom(graph);
  assert.equal(wallFreshnessKey(graph), wallFreshnessKey(graph));
});

test('wallFreshnessKey: 部屋は roomOrder 順に並ぶ（作成順と一致・並べ替えない）', () => {
  const graph = makeGraph();
  const r1 = makeRoom(graph, '部屋A');
  const before = wallFreshnessKey(graph);
  assert.ok(before.includes(`rooms=${r1.id}:`));
});

test('wallFreshnessKey: exteriorWallBacking を変えると鍵が変わる', () => {
  const graph = makeGraph();
  makeRoom(graph);
  const before = wallFreshnessKey(graph);
  graph.setExteriorWallBacking('CHANGED-CODE');
  assert.notEqual(wallFreshnessKey(graph), before);
});

test('wallFreshnessKey: interiorWallBacking を変えると鍵が変わる', () => {
  const graph = makeGraph();
  makeRoom(graph);
  const before = wallFreshnessKey(graph);
  graph.setInteriorWallBacking('CHANGED-CODE');
  assert.notEqual(wallFreshnessKey(graph), before);
});

test('wallFreshnessKey: shaftWallMaterial を変えると鍵が変わる', () => {
  const graph = makeGraph();
  makeRoom(graph);
  const before = wallFreshnessKey(graph);
  graph.setShaftWallMaterial('CHANGED-CODE');
  assert.notEqual(wallFreshnessKey(graph), before);
});

test('wallFreshnessKey: structureOverride（実効主構造）を変えると鍵が変わる（在来木造は柱断面込みでも変わる）', () => {
  const graph = makeGraph();
  makeRoom(graph);
  const before = wallFreshnessKey(graph);
  graph.setStructureOverride(TRADITIONAL_WOOD_STRUCTURE);
  const after = wallFreshnessKey(graph);
  assert.notEqual(after, before);
  assert.ok(after.includes('col=WOOD-120x120'));
});

test('wallFreshnessKey【ステップ4 C-2a】: graph.woodColumnWidthMm（各階柱寸法）を変えると鍵のcol=が変わる', () => {
  const graph = makeGraph();
  graph.setStructureOverride(TRADITIONAL_WOOD_STRUCTURE);
  const before = wallFreshnessKey(graph);
  assert.ok(before.includes('col=WOOD-120x120'));
  graph.setWoodColumnWidthMm(105);
  const after = wallFreshnessKey(graph);
  assert.notEqual(after, before);
  assert.ok(after.includes('col=WOOD-105x105'));
});

test('wallFreshnessKey: 部屋の壁材（wallMaterial）を上書きすると鍵が変わる', () => {
  const graph = makeGraph();
  const room = makeRoom(graph);
  const before = wallFreshnessKey(graph);
  room.setOverride('wallMaterial', 'ANY-PANEL-CODE');
  assert.notEqual(wallFreshnessKey(graph), before);
});

test('wallFreshnessKey: 部屋の壁仕上げ（wallFinish）を上書きすると鍵が変わる', () => {
  const graph = makeGraph();
  const room = makeRoom(graph);
  const before = wallFreshnessKey(graph);
  room.setOverride('wallFinish', 'ANY-FINISH-CODE');
  assert.notEqual(wallFreshnessKey(graph), before);
});

// ---- QA F9: kind/feature は wallMaterial/wallFinish を変えずに壁生成結果を変えるため鍵に含める ----
test('wallFreshnessKey【QA F9】: 部屋のkindを屋外化（EXTERIOR）すると壁材/壁仕上げが同じでも鍵が変わる', () => {
  const graph = makeGraph();
  const room = makeRoom(graph);
  const before = wallFreshnessKey(graph);
  room.setKind(RoomKind.EXTERIOR);
  const after = wallFreshnessKey(graph);
  assert.notEqual(after, before);
  assert.ok(after.includes(`${room.id}:${RoomKind.EXTERIOR}/`));
});

test('wallFreshnessKey【QA F9】: 部屋のfeatureをUNDEFINED化すると壁材/壁仕上げが同じでも鍵が変わる', () => {
  const graph = makeGraph();
  const room = makeRoom(graph);
  const before = wallFreshnessKey(graph);
  room.setFeature(RoomFeature.UNDEFINED);
  const after = wallFreshnessKey(graph);
  assert.notEqual(after, before);
  assert.ok(after.includes(`/${RoomFeature.UNDEFINED}:`));
});

// QA軽微指摘（昇降機の仕様追加ステップ2）: 鍵は room.feature の生文字列をそのまま埋め込む
// （wallFreshnessKey.js `${room.feature ?? ''}`）ため、RoomFeature.ELEVATOR_EQUIPMENT の値
// （'elevatorEquipment'）を変えると、昇降路のある階の保存済みキーが一律不一致になり壁が
// 一度再生成される——この結合（属性の文字列そのものが鍵の一部）を固定する。
test('wallFreshnessKey: 昇降路（feature=ELEVATOR_EQUIPMENT）の部屋があると鍵に /elevatorEquipment: が含まれる', () => {
  const graph = makeGraph();
  const room = makeRoom(graph, '昇降路');
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  const key = wallFreshnessKey(graph);
  assert.ok(key.includes(`/${RoomFeature.ELEVATOR_EQUIPMENT}:`));
  assert.ok(key.includes('/elevatorEquipment:'), '属性の文字列値そのもの（elevatorEquipment）が鍵に含まれる');
});

// ---- 【不変条件】鍵の入力（下地材・主構造・部屋の壁材/壁仕上げ）を変えるsetterの呼び出し元は
// ここで固定する。新しい呼び出し元が増えたらこのテストが落ちる——鍵の対象がそこにも要るか
// レビューする合図にする（鍵の比較・再生成起動はステップ2以降の対象で、ここでは見落とし検知のみ）。
function listSourceFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listSourceFiles(p, out);
    else if (/\.(js|jsx)$/.test(ent.name) && !/\.test\.js$/.test(ent.name)) out.push(p);
  }
  return out;
}

function findCallers(methodName) {
  const srcRoot = path.resolve(import.meta.dirname, '..');
  const re = new RegExp(`\\.${methodName}\\(`);
  const callers = [];
  for (const file of listSourceFiles(srcRoot)) {
    const text = fs.readFileSync(file, 'utf8');
    if (re.test(text)) callers.push(path.relative(srcRoot, file).replace(/\\/g, '/'));
  }
  return callers.sort();
}

test('【不変条件】setExteriorWallBacking の呼び出し元は現状の3ファイルに固定されている', () => {
  assert.deepEqual(findCallers('setExteriorWallBacking'), [
    'finish/FinishTable.jsx', 'graphSnapshot.js', 'structural/woodAutoFill.js',
  ]);
});

test('【不変条件】setInteriorWallBacking の呼び出し元は現状の3ファイルに固定されている', () => {
  assert.deepEqual(findCallers('setInteriorWallBacking'), [
    'finish/FinishTable.jsx', 'graphSnapshot.js', 'structural/woodAutoFill.js',
  ]);
});

test('【不変条件】setStructureOverride の呼び出し元は現状の2ファイルに固定されている', () => {
  assert.deepEqual(findCallers('setStructureOverride'), [
    'graphSnapshot.js', 'structural/CommonInfoTab.jsx',
  ]);
});

// ---- ステップ4: 主構造の入力口が構造モード限定であることの固定 ----
// setMainStructure は CommonInfoTab.jsx のローカル関数（onChange へ渡すだけでメソッド呼び出しの
// 形にならないため findCallers の `.methodName(` パターンでは拾えない）。単純な識別子出現で
// 「宣言・参照とも CommonInfoTab.jsx 以外に無い」ことを確認する——ここが崩れる＝主構造の入力口が
// 構造モード以外（例: wallRefresh.js 等の自動反映経路）にも増えたことを検知する。
test('【不変条件・ステップ4】setMainStructure（主構造の入力口）は structural/CommonInfoTab.jsx 以外から参照されない', () => {
  const srcRoot = path.resolve(import.meta.dirname, '..');
  const referencing = [];
  for (const file of listSourceFiles(srcRoot)) {
    const rel = path.relative(srcRoot, file).replace(/\\/g, '/');
    if (rel === 'structural/CommonInfoTab.jsx') continue;
    // コメント（行コメント・ブロックコメントの行頭）は除外する——他ファイルからの説明的な言及
    // （「この処理はCommonInfoTab.setMainStructureが唯一の入口」等）を誤検知しないため。
    const codeOnly = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
      .join('\n');
    if (/\bsetMainStructure\b/.test(codeOnly)) referencing.push(rel);
  }
  assert.deepEqual(referencing, []);
});

test('【不変条件】wallFreshnessKey.js のソースは exteriorWallBacking・interiorWallBacking・structureOverride を解決する effectiveStructure・部屋の kind/feature/壁材/壁仕上げ（getFinishInfo）を実際に読んでいる', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'wallFreshnessKey.js'), 'utf8');
  for (const token of ['exteriorWallBacking', 'interiorWallBacking', 'effectiveStructure', 'getFinishInfo', 'wallMaterial', 'wallFinish', 'room.kind', 'room.feature']) {
    assert.ok(src.includes(token), `wallFreshnessKey.js に ${token} への参照が無い`);
  }
});

test('【不変条件】wallFreshnessKey.js は structureRules・centerLine・centerLineKindPolicy・stairDimensions 以外を import しない（材マスタ・wallGeneration非依存）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'wallFreshnessKey.js'), 'utf8');
  const importLines = src.split(/\r?\n/).filter(l => /^import /.test(l));
  assert.deepEqual(importLines, [
    "import { effectiveStructure, woodColumnSectionId } from '../structural/structureRules.js';",
    "import { centerLineKind } from '../core/centerLine.js';",
    "import { finishCellDividers, isFinishCellDivider } from '../core/centerLineKindPolicy.js';",
    "import { floorHeightAbove } from './stair/stairDimensions.js';",
  ]);
});

test('【不変条件】finish/wallRegeneration.js は FinishModeState / modes/ / undoManager / floorSwapManager / .jsx / store.js を import しない', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'wallRegeneration.js'), 'utf8');
  // import文（静的・動的 import(...)）だけを対象にする——コメント中に説明として現れる名前は許容する。
  const importLines = src.split(/\r?\n/).filter(l => /^\s*import /.test(l) || /\bimport\(/.test(l));
  const forbidden = [/FinishModeState/, /['"][^'"]*\/modes\//, /undoManager/, /floorSwapManager/, /\.jsx['"]/, /store\.js/];
  for (const line of importLines) {
    for (const re of forbidden) {
      assert.ok(!re.test(line), `wallRegeneration.js の import 文が禁止依存を含む: "${line.trim()}" (${re})`);
    }
  }
});

// ================= v8: 幾何の区画（fh / geo / cells / stairs） =================
const keyPart = (key, name) => key.split('|').find(s => s.startsWith(`${name}=`));

function makeProject() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  return { project, graph };
}

function addStructLine(project, type, value, props = {}) {
  return project.structGraph.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT, ...props });
}

test('wallFreshnessKey【v8】: 通り芯（structGraph）・階の中心線の value を動かすと geo が変わり、他の区画は変わらない', () => {
  const { project, graph } = makeProject();
  const grid = addStructLine(project, CenterLineType.VERTICAL, 0);
  const center = addCL(graph, CenterLineType.HORIZONTAL, 1000);
  const base = wallFreshnessKey(graph, project);
  grid.value = 500;
  const k1 = wallFreshnessKey(graph, project);
  assert.notEqual(keyPart(k1, 'geo'), keyPart(base, 'geo'));
  center.value = 1500;
  const k2 = wallFreshnessKey(graph, project);
  assert.notEqual(keyPart(k2, 'geo'), keyPart(k1, 'geo'));
  assert.equal(keyPart(k2, 'cells'), keyPart(base, 'cells'));
  assert.equal(keyPart(k2, 'stairs'), keyPart(base, 'stairs'));
});

test('wallFreshnessKey【v8】: 梁芯・天井芯・補助線を足す/動かしても鍵は不変（収束条件）', () => {
  const { project, graph } = makeProject();
  addCL(graph, CenterLineType.VERTICAL, 0);
  const base = wallFreshnessKey(graph, project);
  const beam = graph.addCenterLine(CenterLineType.VERTICAL, 700, { labeled: false, discipline: Discipline.FUSE });
  const ceil = graph.addCenterLine(CenterLineType.HORIZONTAL, 800, { labeled: false, discipline: Discipline.CEILING });
  const aux = graph.addCenterLine(CenterLineType.HORIZONTAL, 900, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  assert.equal(wallFreshnessKey(graph, project), base);
  beam.value = 710; ceil.value = 810; aux.value = 910;
  assert.equal(wallFreshnessKey(graph, project), base);
});

test('wallFreshnessKey【v8】: pendingDelta（ドラッグ中の未確定変位）では鍵は不変', () => {
  const { project, graph } = makeProject();
  const cl = addCL(graph, CenterLineType.VERTICAL, 0);
  const base = wallFreshnessKey(graph, project);
  cl.pendingDelta = 123;
  assert.equal(wallFreshnessKey(graph, project), base);
});

test('wallFreshnessKey【v8】: 端の宣言値（extentLoRef.offset・静的 extent）で変わり、壁に結びついた端の解決値では変わらない', () => {
  const { project, graph } = makeProject();
  const ref = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 0, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { clId: ref.id, offset: 0 }, extentHi: 3000,
  });
  const base = wallFreshnessKey(graph, project);
  cl.extentLoRef = { clId: ref.id, offset: -100 };
  const k1 = wallFreshnessKey(graph, project);
  assert.notEqual(keyPart(k1, 'geo'), keyPart(base, 'geo'));
  cl._extentHi = 3500;
  const k2 = wallFreshnessKey(graph, project);
  assert.notEqual(keyPart(k2, 'geo'), keyPart(k1, 'geo'));
  // 壁に結びついた端（解決値）を差し替えても鍵は動かない
  runInAction(() => { cl._extentLoWall = { axisValue: 4242 }; cl._extentHiWall = { axisValue: 9999 }; });
  assert.equal(wallFreshnessKey(graph, project), k2);
});

test('wallFreshnessKey【v8】: 部屋のセル追加・削除・referenceRoomIds の変更で cells が変わる', () => {
  const { project, graph } = makeProject();
  const room = makeRoom(graph);
  const base = wallFreshnessKey(graph, project);
  room.cells.add('extra:cell:key:x');
  const k1 = wallFreshnessKey(graph, project);
  assert.notEqual(keyPart(k1, 'cells'), keyPart(base, 'cells'));
  room.cells.delete('extra:cell:key:x');
  assert.equal(wallFreshnessKey(graph, project), base);
  room.referenceRoomIds.add('other-room');
  assert.notEqual(keyPart(wallFreshnessKey(graph, project), 'cells'), keyPart(base, 'cells'));
});

const STAIR_CHANGES = {
  type: 'switchback', structure: '鉄骨', totalSteps: 17, tread: 240, riser: 190, nosing: 30, width: 1000,
  upDirection: 'left', flip: true, sections: [3, 1, 3], roomId: 'room-x', entrySide: 'left',
  arrivalSide: 'right', entryTurnSteps: 2, arrivalTurnSteps: 1,
};

test('wallFreshnessKey【v8】: STAIR_KEY_FIELDS の各項目と cells を 1 つずつ変えると stairs が変わる（表駆動）', () => {
  assert.deepEqual(Object.keys(STAIR_CHANGES).sort(), [...STAIR_KEY_FIELDS].sort());
  const { project, graph } = makeProject();
  const stair = graph.addStair({ cells: new Set(['a:b:c:d']) });
  for (const f of STAIR_KEY_FIELDS) {
    const before = wallFreshnessKey(graph, project);
    const old = stair[f];
    assert.notDeepEqual(old, STAIR_CHANGES[f], `${f}: テスト値が既定と同じ`);
    stair[f] = STAIR_CHANGES[f];
    assert.notEqual(keyPart(wallFreshnessKey(graph, project), 'stairs'), keyPart(before, 'stairs'), `${f} を変えても stairs が動かない`);
    assert.equal(keyPart(wallFreshnessKey(graph, project), 'cells'), keyPart(before, 'cells'));
    stair[f] = old;
    assert.equal(wallFreshnessKey(graph, project), before, `${f} を戻すと元の鍵に戻る`);
  }
  const before = wallFreshnessKey(graph, project);
  stair.cells.add('e:f:g:h');
  assert.notEqual(keyPart(wallFreshnessKey(graph, project), 'stairs'), keyPart(before, 'stairs'), 'cells');
});

test('wallFreshnessKey【v8・番人】: Stair の own 項目から id を除いた集合 == STAIR_KEY_FIELDS ∪ {cells}（項目を足したら鍵へ）', () => {
  const own = Object.keys(new Stair('probe', {})).filter(k => k !== 'id').sort();
  assert.deepEqual(own, [...STAIR_KEY_FIELDS, 'cells'].sort());
});

test('wallFreshnessKey【v8】: 階段は id 順に正規化される（追加順に依存しない）', () => {
  const a = makeProject(); const b = makeProject();
  a.graph.addStair({ cells: new Set(['1']) }, 's-a'); a.graph.addStair({ cells: new Set(['2']) }, 's-b');
  b.graph.addStair({ cells: new Set(['2']) }, 's-b'); b.graph.addStair({ cells: new Set(['1']) }, 's-a');
  assert.equal(keyPart(wallFreshnessKey(a.graph, a.project), 'stairs'), keyPart(wallFreshnessKey(b.graph, b.project), 'stairs'));
});

test('wallFreshnessKey【v8】: 上の階の elevation を変えると fh が変わる。最上階は fh が空で安定', () => {
  const { project, graph } = makeProject();
  const { plane: p2, graph: g2 } = project.addPlane(3000, '2階', 'p2');
  const base = wallFreshnessKey(graph, project);
  assert.equal(keyPart(base, 'fh'), 'fh=3000');
  p2.elevation = 3200;
  assert.equal(keyPart(wallFreshnessKey(graph, project), 'fh'), 'fh=3200');
  const top = wallFreshnessKey(g2, project);
  assert.equal(keyPart(top, 'fh'), 'fh=');
  p2.elevation = 3300;
  assert.equal(wallFreshnessKey(g2, project), top);
  assert.equal(keyPart(wallFreshnessKey(graph), 'fh'), 'fh=', 'project なしは空');
});

test('wallFreshnessKey【v8】: 同じ線を逆順に足しても鍵は同じ', () => {
  const a = makeProject(); const b = makeProject();
  const specs = [[CenterLineType.VERTICAL, 0, 'l1'], [CenterLineType.VERTICAL, 3000, 'l2'], [CenterLineType.HORIZONTAL, 500, 'l3']];
  for (const [t, v, id] of specs) a.graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH }, id);
  for (const [t, v, id] of [...specs].reverse()) b.graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH }, id);
  assert.equal(keyPart(wallFreshnessKey(a.graph, a.project), 'geo'), keyPart(wallFreshnessKey(b.graph, b.project), 'geo'));
});

test('wallFreshnessKey【v8】: 本番同型の往復（PlanGraph→_structGraph→restoreGraph(serializeGraph)）で鍵が一致する', () => {
  const { project, graph } = makeProject();
  addStructLine(project, CenterLineType.VERTICAL, 0);
  const ref = addCL(graph, CenterLineType.HORIZONTAL, 0);
  graph.addCenterLine(CenterLineType.VERTICAL, 1234.5, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { clId: ref.id, offset: -50 }, extentHi: 3000,
  });
  const room = makeRoom(graph);
  graph.addStair({ cells: new Set(['a:b:c:d']), type: 'switchback', sections: [3, 1, 3], roomId: room.id, entrySide: 'left' });
  project.addPlane(2800, '2階', 'p2');
  const before = wallFreshnessKey(graph, project);
  const g = new PlanGraph(graph.plane);
  g._structGraph = project.structGraph;
  restoreGraph(g, serializeGraph(graph));
  assert.equal(wallFreshnessKey(g, project), before);
});

test('wallFreshnessKey【v8】: ceilingZones・clEccentricities の変更では鍵は不変', () => {
  const { project, graph } = makeProject();
  const room = makeRoom(graph);
  const cl = graph.centerLines[0];
  const base = wallFreshnessKey(graph, project);
  room.setCeilingZones([{ id: 'z1', cells: ['x'] }]);
  graph.setCLEccentricity(cl.id, { offset: 50 });
  assert.equal(wallFreshnessKey(graph, project), base);
});

test('wallFreshnessKey【v8】: 丸め境界（0.001mm）— 1000 と 1000.0004 は同じ鍵、1000.001 は違う鍵', () => {
  const { project, graph } = makeProject();
  const cl = addCL(graph, CenterLineType.VERTICAL, 1000);
  const at1000 = wallFreshnessKey(graph, project);
  cl.value = 1000.0004;
  assert.equal(wallFreshnessKey(graph, project), at1000);
  cl.value = 1000.001;
  assert.notEqual(wallFreshnessKey(graph, project), at1000);
});

test('【不変条件】wallFreshnessKey.js の推移的 import に材マスタ・wallGeneration・store.js・.jsx が含まれない', () => {
  const seen = new Set();
  const stack = [path.resolve(import.meta.dirname, 'wallFreshnessKey.js')];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/^import\s[^;]*?from\s+'(\.[^']+)'/gm)) stack.push(path.resolve(path.dirname(f), m[1]));
  }
  const names = [...seen].map(f => path.relative(path.resolve(import.meta.dirname, '..'), f).replace(/\\/g, '/'));
  for (const bad of ['materialData', 'wallGeneration', 'store.js', '.jsx']) {
    assert.ok(!names.some(n => n.includes(bad)), `推移的 import に ${bad} が含まれる: ${names.join(', ')}`);
  }
});

// ---- QA 指摘（M1・不足テスト） ----
test('wallFreshnessKey【v8・M1】: 中心線の端が補助線を参照するとき、補助線の値を変えると geo が変わる。梁芯の移動では変わらない', () => {
  const { project, graph } = makeProject();
  const aux = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 0, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { clId: aux.id, offset: 0 }, extentHi: 3000,
  });
  assert.ok(cl._extentLoCL, '前提: 参照先が解決済み');
  const beam = graph.addCenterLine(CenterLineType.VERTICAL, 700, { labeled: false, discipline: Discipline.FUSE });
  const base = wallFreshnessKey(graph, project);
  beam.value = 750;
  assert.equal(wallFreshnessKey(graph, project), base, '梁芯の移動では不変');
  aux.value = 1300;
  assert.notEqual(keyPart(wallFreshnessKey(graph, project), 'geo'), keyPart(base, 'geo'), '補助線の値で geo が変わる');
});

test('wallFreshnessKey【v8】: graph=null・plane=null でも例外なく、fh が空で geo/cells/stairs が空入力のハッシュ。2 回呼んで同じ', () => {
  const k0 = wallFreshnessKey(null);
  assert.equal(wallFreshnessKey(null), k0);
  assert.equal(keyPart(k0, 'fh'), 'fh=');
  const g = new PlanGraph(null);
  const k1 = wallFreshnessKey(g, null);
  assert.equal(wallFreshnessKey(g, null), k1);
  assert.equal(keyPart(k1, 'fh'), 'fh=');
  for (const part of ['geo', 'cells', 'stairs']) {
    assert.equal(keyPart(k0, part), keyPart(k1, part), `${part}: graph=null と空グラフは同じ空入力のハッシュ`);
  }
});

test('wallFreshnessKey【v8】: 参照先の無い extentRef（clId が存在しない）は例外なく決定的。restoreGraph で静的化されると鍵が変わり、以後は往復で安定', () => {
  const { project, graph } = makeProject();
  graph.addCenterLine(CenterLineType.VERTICAL, 0, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { clId: 'no-such-cl', offset: 5 }, extentHi: 3000,
  });
  const k0 = wallFreshnessKey(graph, project);
  assert.equal(wallFreshnessKey(graph, project), k0);
  const roundTrip = (g) => {
    const r = new PlanGraph(g.plane);
    r._structGraph = project.structGraph;
    restoreGraph(r, serializeGraph(g));
    return r;
  };
  const r1 = roundTrip(graph);
  const k1 = wallFreshnessKey(r1, project);
  assert.notEqual(k1, k0, '復元で参照が静的化され、宣言値が変わる');
  assert.equal(wallFreshnessKey(roundTrip(r1), project), k1, '静的化後は往復で安定');
});

test('wallFreshnessKey【v8】: 部屋0件の階とセル空の部屋1件の階で cells が違う。階段0件の stairs は空入力のハッシュ', () => {
  const a = makeProject();
  const b = makeProject();
  b.graph.addRoom(new Set(), '空');
  assert.notEqual(keyPart(wallFreshnessKey(a.graph, a.project), 'cells'), keyPart(wallFreshnessKey(b.graph, b.project), 'cells'));
  assert.equal(keyPart(wallFreshnessKey(a.graph, a.project), 'stairs'), keyPart(wallFreshnessKey(null), 'stairs'));
});

test('wallFreshnessKey【v8・番人】: _structGraph が無いグラフでは通り芯が geo に入らない（付けると入る）', () => {
  const g = new PlanGraph(new Plane('p9', 0, '1階', 1, 1));
  addCL(g, CenterLineType.VERTICAL, 0);
  const base = wallFreshnessKey(g);
  const sg = new Project('pp', 'pp').structGraph;
  sg.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(wallFreshnessKey(g), base, '未接続の通り芯は読まない');
  g._structGraph = sg;
  assert.notEqual(keyPart(wallFreshnessKey(g), 'geo'), keyPart(base, 'geo'), '接続すると通り芯が geo に入る');
});
