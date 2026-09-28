// FinishTable.jsx（仕上げ表）の配線不変条件。.jsx は node:test から単体 import できないため、
// ソーステキスト検査で固定する（renderer/VoidLayer.wiring.test.js と同じ型。ブロックコメント・
// 行コメントを除去してから検査する——team-lessons「ソース文字列を正規表現で検査する配線テストが、
// コメント文にも一致して変異を見逃す」対応）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve(import.meta.dirname, 'FinishTable.jsx');
const src = fs.readFileSync(filePath, 'utf8');

function stripComments(text) {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

const codeOnly = stripComments(src);

test('【不変条件】昇降路 壁仕上げ材の options は shaftWallMaterialOptions(graph.shaftWallMaterial, …) を呼んで組み立てる', () => {
  assert.ok(/shaftWallMaterialOptions\(graph\.shaftWallMaterial, /.test(codeOnly),
    'shaftWallMaterialOptions(graph.shaftWallMaterial, ... の呼び出しが見つからない');
});

test('【不変条件】昇降路 壁仕上げ材・防音材の変更は withFinishUndo(graph, () => …) 経由で行う（undo対象）', () => {
  assert.ok(/withFinishUndo\(graph, \(\) => graph\.setShaftWallMaterial\(code\)\)/.test(codeOnly),
    'graph.setShaftWallMaterial(code) が withFinishUndo(graph, () => …) の直接引数になっていない');
  assert.ok(/withFinishUndo\(graph, \(\) => graph\.setShaftSoundproof\(v\)\)/.test(codeOnly),
    'graph.setShaftSoundproof(v) が withFinishUndo(graph, () => …) の直接引数になっていない');
});

test('【不変条件】InteriorTable の部屋一覧フィルタ（const rooms = graph.rooms.filter(...)）は !isShaftFeature(r.feature) を含む（昇降路は内部タブに出さない）', () => {
  const startNeedle = 'const rooms = graph.rooms.filter(';
  const startIdx = codeOnly.indexOf(startNeedle);
  assert.ok(startIdx >= 0, 'const rooms = graph.rooms.filter( が見つからない');
  const endIdx = codeOnly.indexOf(');', startIdx);
  assert.ok(endIdx >= 0, 'const rooms = graph.rooms.filter( の閉じ );  が見つからない');
  const filterBlock = codeOnly.slice(startIdx, endIdx + 2);
  assert.ok(/!isShaftFeature\(r\.feature\)/.test(filterBlock),
    'const rooms = graph.rooms.filter(...) の範囲に !isShaftFeature(r.feature) が見つからない');
});
