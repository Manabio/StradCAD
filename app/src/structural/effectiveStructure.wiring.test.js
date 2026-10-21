// 実効の構造（階の上書き ?? 建物全体値）の解決は structureRules.js の effectiveStructure に一本化する
// （階段・階の追加削除 S5a。S5b で地階構造を読ませるときの唯一の変更点にするため）。
// ソース走査は行コメント・ブロックコメントを除いてから照合する（コメント文に一致して変異を見逃さない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  effectiveStructure, isBasementPlane, normalizeBasementStructure, BASEMENT_STRUCTURE_OPTIONS,
} from './structureRules.js';

const srcRoot = path.resolve(import.meta.dirname, '..');

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(js|jsx)$/.test(ent.name) && !/\.test\.js$/.test(ent.name)) out.push(p);
  }
  return out;
}

// 入力値そのものを扱う箇所（解決ではない）。ここ以外に `structureOverride ??` を書かない。
//   structureRules.js        : effectiveStructure の定義本体
//   graphSnapshot.js         : 保存用スナップショットへ値を写す（入力値）
//   schema/graphFbs.js       : FlatBuffers へ文字列として書く（入力値）
//   structuralOrchestrationFixtures.js : golden 用の署名文字列の組立て（入力値）
const RAW_READ_ALLOWED = new Set([
  'structural/structureRules.js',
  'graphSnapshot.js',
  'schema/graphFbs.js',
  'structural/structuralOrchestrationFixtures.js',
]);

test('【不変条件】structureOverride ?? の直書きは許可リスト以外に無い（実効の構造は effectiveStructure を通る）', () => {
  const offenders = [];
  for (const file of walk(srcRoot)) {
    const rel = path.relative(srcRoot, file).split(path.sep).join('/');
    if (RAW_READ_ALLOWED.has(rel)) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    if (/structureOverride\s*\?\?/.test(code)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `effectiveStructure を使わず structureOverride ?? を直書きしている: ${offenders.join(', ')}`);
});

test('【不変条件】置き換えた5ファイルが effectiveStructure を呼ぶ', () => {
  const files = [
    'interaction/usePointerInteraction.js',
    'structural/drawingDesignation.js',
    'structural/MemberListTab.jsx',
    'structural/structuralAutoFill.js',
    'structural/structuralOrchestration.js',
  ];
  for (const rel of files) {
    const code = stripComments(fs.readFileSync(path.join(srcRoot, rel), 'utf8'));
    assert.ok(/\beffectiveStructure\(/.test(code), `${rel} が effectiveStructure( を呼んでいない`);
  }
});

test('effectiveStructure: 階の上書き優先・無ければ建物全体値・project 無しは graph の後方参照', () => {
  const project = { structuralInfo: { mainStructure: 'RC造(ラーメン)' } };
  assert.equal(effectiveStructure({ structureOverride: '木造(在来)' }, project), '木造(在来)');
  assert.equal(effectiveStructure({ structureOverride: null }, project), 'RC造(ラーメン)');
  assert.equal(effectiveStructure(null, project), 'RC造(ラーメン)');
  assert.equal(effectiveStructure({ _structuralInfo: { mainStructure: 'S造' } }), 'S造');
});

test('effectiveStructure: 失敗系（どこからも引けない）は undefined', () => {
  assert.equal(effectiveStructure({}, null), undefined);
  assert.equal(effectiveStructure(null, null), undefined);
});

// ---- S5b: 地階構造（建物全体の basementStructure）----
const RAME = 'RC造(ラーメン)';
const WALL = 'RC造(壁式)';
const mkProject = (basementStructure = null, mainStructure = 'S造') => ({ structuralInfo: { mainStructure, basementStructure } });
const mkGraph = (startFloor, extra = {}, planeExtra = {}) => ({
  structureOverride: null, plane: { startFloor, stories: 1, isRoofPlane: false, ...planeExtra }, ...extra,
});

test('【S5b】地階（startFloor<0）は 上書き ?? 地階構造 ?? 主構造。上書きが最優先', () => {
  assert.equal(effectiveStructure(mkGraph(-1), mkProject(RAME)), RAME, '地階構造が主構造に勝つ');
  assert.equal(effectiveStructure(mkGraph(-1), mkProject(WALL)), WALL);
  assert.equal(effectiveStructure(mkGraph(-1, { structureOverride: '木造（在来）' }), mkProject(RAME)), '木造（在来）', '階の上書きが勝つ');
  assert.equal(effectiveStructure(mkGraph(-1), mkProject(null)), 'S造', '地階構造なしは主構造');
});

test('【S5b】地上階（startFloor>=0）は地階構造を読まない（主構造のまま）', () => {
  assert.equal(effectiveStructure(mkGraph(0), mkProject(RAME)), 'S造');
  assert.equal(effectiveStructure(mkGraph(1), mkProject(RAME)), 'S造');
});

test('【S5b】屋根専用平面（startFloor<0 を写す）は地階扱いにしない', () => {
  assert.equal(effectiveStructure(mkGraph(-1, {}, { isRoofPlane: true }), mkProject(RAME)), 'S造');
});

test('【S5b】検討案（isAlternative）も自分の startFloor で判定。複層の地階（stories 2・startFloor -2）も地階扱い', () => {
  assert.equal(effectiveStructure(mkGraph(-1, {}, { isAlternative: true }), mkProject(RAME)), RAME);
  assert.equal(effectiveStructure(mkGraph(-1, {}, { isAlternative: true, parentPlaneId: 'x' }), mkProject(RAME)), RAME);
  assert.equal(effectiveStructure(mkGraph(-2, {}, { stories: 2 }), mkProject(RAME)), RAME);
  assert.equal(effectiveStructure(mkGraph(0, {}, { isAlternative: true }), mkProject(RAME)), 'S造', '地上の検討案は地上');
});

test('【S5b】project 無しでも graph の後方参照（_structuralInfo・_structGraph._structuralInfo）経由で project ありと同値', () => {
  const si = { mainStructure: 'S造', basementStructure: RAME };
  assert.equal(effectiveStructure({ ...mkGraph(-1), _structuralInfo: si }), RAME);
  assert.equal(effectiveStructure({ ...mkGraph(-1), _structGraph: { _structuralInfo: si } }), RAME, 'peek の一時グラフ経路');
  assert.equal(effectiveStructure({ ...mkGraph(0), _structuralInfo: si }), 'S造');
  assert.equal(effectiveStructure({ ...mkGraph(-1), _structuralInfo: { ...si, basementStructure: null } }), 'S造');
});

test('【S5b】plane の無いスタブ・構造専用グラフ（startFloor=1）・graph=null は従来どおり主構造', () => {
  assert.equal(effectiveStructure({ structureOverride: null }, mkProject(RAME)), 'S造');
  assert.equal(effectiveStructure(mkGraph(1), mkProject(RAME)), 'S造');
  assert.equal(effectiveStructure(null, mkProject(RAME)), 'S造');
});

test('【S5b】isBasementPlane / normalizeBasementStructure / BASEMENT_STRUCTURE_OPTIONS', () => {
  assert.equal(isBasementPlane({ startFloor: -1 }), true);
  assert.equal(isBasementPlane({ startFloor: 0 }), false);
  assert.equal(isBasementPlane({ startFloor: -1, isRoofPlane: true }), false);
  assert.equal(isBasementPlane(null), false);
  assert.equal(isBasementPlane(undefined), false);
  assert.deepEqual([...BASEMENT_STRUCTURE_OPTIONS], [RAME, WALL], 'RC 系のみ');
  assert.equal(normalizeBasementStructure(RAME), RAME);
  for (const bad of ['S造', 'RC造', '', null, undefined, 3]) assert.equal(normalizeBasementStructure(bad), null);
});

test('【不変条件・S5b】basementStructure を読むのは許可リストだけ（実効の構造は effectiveStructure を通る）', () => {
  // structureRules.js: 解決本体 / structuralInfo.js: 保持 / graphSnapshot.js・schema/graphFbs.js: 保存形式 /
  // FloorSwapManager.js: dirty 追跡。S5d: structural/commonInfoTabModel.js＝共通タブの行の分岐（表示のために読む。
  // CommonInfoTab.jsx は model 経由で読み、setBasementStructure〔大文字 B のため照合に掛からない〕で書くだけ）。
  // S5c-2: floorOps.js＝階操作の undo/redo が値を採って戻す（collectProjectLevels／applyProjectLevels）／
  // finish/basementFloorInit.js＝下階追加が初期値を書く（値は initialBasementStructureFor。読んで構造を決める箇所ではない）。
  const allowed = new Set([
    'structural/structureRules.js', 'core/structuralInfo.js', 'graphSnapshot.js',
    'schema/graphFbs.js', 'storage/FloorSwapManager.js',
    'floorOps.js', 'finish/basementFloorInit.js', 'structural/commonInfoTabModel.js',
  ]);
  const offenders = [];
  for (const file of walk(srcRoot)) {
    const rel = path.relative(srcRoot, file).split(path.sep).join('/');
    if (allowed.has(rel)) continue;
    if (/basementStructure/.test(stripComments(fs.readFileSync(file, 'utf8')))) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `許可リスト外が basementStructure を直接読んでいる: ${offenders.join(', ')}`);
});
