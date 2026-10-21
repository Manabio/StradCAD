// 実効の構造（階の上書き ?? 建物全体値）の解決は structureRules.js の effectiveStructure に一本化する
// （階段・階の追加削除 S5a。S5b で地階構造を読ませるときの唯一の変更点にするため）。
// ソース走査は行コメント・ブロックコメントを除いてから照合する（コメント文に一致して変異を見逃さない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { effectiveStructure } from './structureRules.js';

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
