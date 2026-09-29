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

// ---- ステップ1（部屋編集の導線変更）: RoomCard が名称入力・区分/属性セレクタ・onApplyNaming を持つ ----

test('【不変条件】RoomCard は展開時に CardNameInput（名称入力）を描画する', () => {
  assert.ok(/<CardNameInput room=\{room\} onApplyNaming=\{onApplyNaming\} \/>/.test(codeOnly),
    'RoomCard に <CardNameInput room={room} onApplyNaming={onApplyNaming} /> が見つからない');
});

test('【不変条件】CardKindFeatureRow は ROOM_KIND_OPTIONS.map( と CARD_FEATURE_OPTIONS.map( を各1回呼ぶ（昇降路の無いカード用選択肢）', () => {
  const startIdx = codeOnly.indexOf('const CardKindFeatureRow');
  assert.ok(startIdx >= 0, 'const CardKindFeatureRow が見つからない');
  const endIdx = codeOnly.indexOf('));', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 3);
  assert.equal((block.match(/ROOM_KIND_OPTIONS\.map\(/g) ?? []).length, 1,
    'CardKindFeatureRow に ROOM_KIND_OPTIONS.map( が1回見つからない');
  assert.equal((block.match(/CARD_FEATURE_OPTIONS\.map\(/g) ?? []).length, 1,
    'CardKindFeatureRow に CARD_FEATURE_OPTIONS.map( が1回見つからない');
  assert.ok(!/ROOM_FEATURE_OPTIONS\.map\(/.test(block),
    'CardKindFeatureRow が ROOM_FEATURE_OPTIONS（昇降路込み）を使っている——CARD_FEATURE_OPTIONSのはず');
});

test('【不変条件】CardKindFeatureRow の区分・属性 select の onChange は変化した場合のみ onApplyNaming を呼ぶ（無変更でundoを積まない）', () => {
  const startIdx = codeOnly.indexOf('const CardKindFeatureRow');
  const endIdx = codeOnly.indexOf('));', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 3);
  assert.ok(/if \(kind !== room\.kind\) onApplyNaming\(/.test(block),
    '区分 select の onChange が if (kind !== room.kind) onApplyNaming(... の形で見つからない');
  assert.ok(/if \(feature !== room\.feature\) onApplyNaming\(/.test(block),
    '属性 select の onChange が if (feature !== room.feature) onApplyNaming(... の形で見つからない');
});

// T3: CardNameInput の commit は trim後の値が room.name と異なる場合だけ onApplyNaming を呼ぶ。
test('【不変条件・T3】CardNameInput の commit は trimmed !== room.name のときだけ onApplyNaming(room.id, { name: trimmed, kind: room.kind, feature: room.feature }) を呼ぶ', () => {
  const startIdx = codeOnly.indexOf('const CardNameInput');
  assert.ok(startIdx >= 0, 'const CardNameInput が見つからない');
  const endIdx = codeOnly.indexOf('});', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 3);
  assert.ok(/if \(trimmed !== \(room\.name \|\| ''\)\) \{\s*onApplyNaming\(room\.id, \{ name: trimmed, kind: room\.kind, feature: room\.feature \}\);/.test(block),
    'commit が if (trimmed !== (room.name || "")) { onApplyNaming(room.id, { name: trimmed, kind: room.kind, feature: room.feature }); の形で見つからない');
  assert.equal((block.match(/onApplyNaming\(/g) ?? []).length, 1,
    'CardNameInput 内の onApplyNaming( 呼び出しは1回（ガード内のみ）のはず');
});

// T4: RoomCard は展開時にCardKindFeatureRowを描き、InteriorTable→RoomCardへonApplyNaming/stairEnabledを渡す。
test('【不変条件・T4】RoomCard は展開時に <CardKindFeatureRow room={room} onApplyNaming={onApplyNaming} stairEnabled={stairEnabled} /> を描く', () => {
  assert.ok(/<CardKindFeatureRow room=\{room\} onApplyNaming=\{onApplyNaming\} stairEnabled=\{stairEnabled\} \/>/.test(codeOnly),
    'RoomCard に <CardKindFeatureRow room={room} onApplyNaming={onApplyNaming} stairEnabled={stairEnabled} /> が見つからない');
});

test('【不変条件・T4】InteriorTable の <RoomCard ...> は onApplyNaming={onApplyNaming}・stairEnabled={stairEnabled} を渡す', () => {
  const startIdx = codeOnly.indexOf('<RoomCard');
  assert.ok(startIdx >= 0, '<RoomCard が見つからない');
  const endIdx = codeOnly.indexOf('/>', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 2);
  assert.ok(/onApplyNaming=\{onApplyNaming\}/.test(block),
    '<RoomCard ...> に onApplyNaming={onApplyNaming} が見つからない');
  assert.ok(/stairEnabled=\{stairEnabled\}/.test(block),
    '<RoomCard ...> に stairEnabled={stairEnabled} が見つからない');
});

// T5: GroupedExteriorTableは屋外・非階段の連動群の見出しにExteriorPartHeadingを使い、
// その commit は mode.renameExteriorRoom(room.id, draft) を呼ぶ。
test('【不変条件・T5】GroupedExteriorTable は showLevelRow のとき <ExteriorPartHeading room={room} mode={mode} /> を見出しに使う', () => {
  assert.ok(/\? <ExteriorPartHeading room=\{room\} mode=\{mode\} \/>/.test(codeOnly),
    'showLevelRow の三項演算子に <ExteriorPartHeading room={room} mode={mode} /> が見つからない');
});

test('【不変条件・T5】ExteriorPartHeading の commit は mode.renameExteriorRoom(room.id, draft) を呼ぶ', () => {
  const startIdx = codeOnly.indexOf('const ExteriorPartHeading');
  assert.ok(startIdx >= 0, 'const ExteriorPartHeading が見つからない');
  const endIdx = codeOnly.indexOf('});', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 3);
  assert.ok(/mode\.renameExteriorRoom\(room\.id, draft\)/.test(block),
    'ExteriorPartHeading の commit に mode.renameExteriorRoom(room.id, draft) が見つからない');
});
