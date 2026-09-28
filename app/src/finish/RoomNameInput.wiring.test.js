// RoomNameInput.jsx（部屋名ダイアログ）は区分/属性の2セレクタで構成される（ステップ2b）。
// .jsx は node:test から単体 import できないため、ソーステキスト検査で配線を固定する
// （renderer/VoidLayer.wiring.test.js と同じ型。ブロックコメント・行コメントを除去してから検査する
// ——team-lessons「ソース文字列を正規表現で検査する配線テストが、コメント文にも一致して変異を見逃す」対応）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve(import.meta.dirname, 'RoomNameInput.jsx');
const src = fs.readFileSync(filePath, 'utf8');

function stripComments(text) {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

const codeOnly = stripComments(src);

test('【不変条件】ROOM_FEATURE_OPTIONS.map( と ROOM_KIND_OPTIONS.map( の呼び出しが各1回', () => {
  const featureMatches = codeOnly.match(/ROOM_FEATURE_OPTIONS\.map\(/g) ?? [];
  const kindMatches    = codeOnly.match(/ROOM_KIND_OPTIONS\.map\(/g) ?? [];
  assert.equal(featureMatches.length, 1, `ROOM_FEATURE_OPTIONS.map( は1回のはず（実際: ${featureMatches.length}）`);
  assert.equal(kindMatches.length, 1,    `ROOM_KIND_OPTIONS.map( は1回のはず（実際: ${kindMatches.length}）`);
});

test('【不変条件】<select が本体にちょうど2つ', () => {
  const matches = codeOnly.match(/<select/g) ?? [];
  assert.equal(matches.length, 2, `<select はちょうど2つのはず（実際: ${matches.length}）`);
});

test('【不変条件】BUTTONS／toggleFeature が存在しない（ボタン方式の撤去）', () => {
  assert.ok(!/\bBUTTONS\b/.test(codeOnly), 'BUTTONS が残っている');
  assert.ok(!/\btoggleFeature\b/.test(codeOnly), 'toggleFeature が残っている');
});

test('【不変条件】属性 select の onChange は selectValueToFeature(e.target.value) の形', () => {
  assert.ok(/onChange=\{e => setFeatureSel\(selectValueToFeature\(e\.target\.value\)\)\}/.test(codeOnly),
    '属性 select の onChange が想定の形で見つからない');
});

// 属性 select は ROOM_FEATURE_OPTIONS を共通 map で描画するため、階段 option だけを
// disabled にする条件は `opt.value === RoomFeature.STAIR && !stairEnabled` の形になる
// （`!stairEnabled` 単独の disabled は select 自体の title 分岐で使われるため、option 側は
// STAIR 判定込みの式であることまで固定する）。
test('【不変条件】階段 option の disabled は opt.value === RoomFeature.STAIR && !stairEnabled の形', () => {
  assert.ok(/disabled=\{opt\.value === RoomFeature\.STAIR && !stairEnabled\}/.test(codeOnly),
    '階段 option の disabled 条件が想定の形で見つからない');
});
