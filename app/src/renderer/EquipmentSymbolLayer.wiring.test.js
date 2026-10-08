// 昇降機の仕様追加ステップ3 S5（描画）: renderer/EquipmentSymbolLayer.jsx が
// 供給された値（symbols）だけを描き、graph を読んで幾何を計算していないことをソーステキスト検査で
// 固定する（.jsx は node:test から単体 import できないため。PlanSolidsLayer.wiring.test.js と同じ型。
// コメントは除外して検査する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve(import.meta.dirname, 'EquipmentSymbolLayer.jsx');
const src = fs.readFileSync(filePath, 'utf8');

function stripComments(text) {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

const codeOnly = stripComments(src);

test('【不変条件】EquipmentSymbolLayer.jsx は graph. を読まない（幾何の判断を持たない。値は props.symbols から取る）', () => {
  assert.ok(!/\bgraph\./.test(codeOnly), 'graph. への参照が見つかった（幾何計算を自分で行っている疑い）');
});

test('【不変条件】EquipmentSymbolLayer.jsx は finish/equipment/equipmentFigure.js を import しない（計算は呼び出し側の責務）', () => {
  const importLines = src.split(/\r?\n/).filter(l => /^import /.test(l));
  assert.ok(!importLines.some(l => /equipmentFigure\.js/.test(l)),
    'equipmentFigure.js を import している（幾何計算をレイヤー内に持ち込んでいる疑い）');
});

test('【不変条件】EquipmentSymbolLayer.jsx は props.symbols をそのまま描画に使う（symbols.map）', () => {
  assert.ok(/symbols\.map\(/.test(codeOnly), 'symbols.map( が見つからない（供給された配列をそのまま描いていない）');
});

// QA指摘（ステップ3全体・C）: 部分一致（コメント除去のみ）は「実装を無効化しつつ元の式を
// 同じ行の行末コメントとして残す変異」を検出できない。1行まるごとをmフラグの行頭・行末
// アンカー（^\s*…$）で照合する形へ直す。
test('【配線・強化】EquipmentSymbolLayer.jsx は return symbols.map(s => { を1行まるごとの形で描く', () => {
  assert.match(src, /^\s*return symbols\.map\(s => \{\s*$/m,
    'return symbols.map(s => { が1行まるごとの形で見つからない');
});
