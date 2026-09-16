// wallFreshnessKey（壁の鮮度キー）の決定性テストと、鍵の入力が変わりうる箇所を
// 見落とさないための不変条件テスト（壁の再生成をFinishModeStateから独立させる計画のステップ1）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomKind, RoomFeature } from '@core';
import { wallFreshnessKey, WALL_KEY_VERSION } from './wallFreshnessKey.js';
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

test('wallFreshnessKey: 書式は v1|ext=...|int=...|str=...|col=...|rooms=... で、バージョン定数と一致する', () => {
  const graph = makeGraph();
  const key = wallFreshnessKey(graph);
  assert.ok(key.startsWith(`${WALL_KEY_VERSION}|ext=`));
  assert.match(key, /\|ext=[^|]*\|int=[^|]*\|str=[^|]*\|col=[^|]*\|rooms=/);
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

test('【不変条件】wallFreshnessKey.js は structural/structureRules.js 以外を import しない（材マスタ・wallGeneration非依存）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'wallFreshnessKey.js'), 'utf8');
  const importLines = src.split(/\r?\n/).filter(l => /^import /.test(l));
  assert.deepEqual(importLines, ["import { effectiveStructure, woodColumnSectionId } from '../structural/structureRules.js';"]);
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
