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

// 昇降機の仕様追加ステップ2: 属性選択肢は featureOptionsForDialog(room) を唯一の供給源にする
// （部分指定は昇降機を出さない。S5）——ROOM_FEATURE_OPTIONS を直接 map しない。
// ステップ3（S3）: 判定2（既存の命名済み部屋の統合）では昇降機を出さない（Q1）ため、
// isNew を第2引数で渡す形に変わった（featureOptionsForDialog(room, { isNew })）。
test('【不変条件】featureOptionsForDialog(room, { isNew }).map( と ROOM_KIND_OPTIONS.map( の呼び出しが各1回、ROOM_FEATURE_OPTIONS.map( は直接使わない', () => {
  const featureMatches = codeOnly.match(/featureOptionsForDialog\(room, \{ isNew \}\)\.map\(/g) ?? [];
  const kindMatches    = codeOnly.match(/ROOM_KIND_OPTIONS\.map\(/g) ?? [];
  assert.equal(featureMatches.length, 1, `featureOptionsForDialog(room, { isNew }).map( は1回のはず（実際: ${featureMatches.length}）`);
  assert.equal(kindMatches.length, 1,    `ROOM_KIND_OPTIONS.map( は1回のはず（実際: ${kindMatches.length}）`);
  assert.ok(!/ROOM_FEATURE_OPTIONS\.map\(/.test(codeOnly),
    'ROOM_FEATURE_OPTIONS.map( を直接使っている——featureOptionsForDialog(room, { isNew }) 経由のはず');
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

// ステップ1（部屋編集の導線変更）: 部屋名ダイアログは新規Roomの命名専用にし、削除ボタン・
// 確認ダイアログを廃止する（削除は仕上げ表・内部タブのカードの削除ボタンに一本化）。
test('【不変条件】削除ボタン・onDelete・確認ダイアログが存在しない（新規Room命名専用ダイアログ化）', () => {
  assert.ok(!/onDelete/.test(codeOnly), 'onDelete が残っている');
  assert.ok(!/requestDelete/.test(codeOnly), 'requestDelete が残っている');
  assert.ok(!/deleteConfirmOpen/.test(codeOnly), 'deleteConfirmOpen が残っている');
  assert.ok(!/ConfirmDialog/.test(codeOnly), 'ConfirmDialog の import/使用が残っている');
  assert.ok(!/hasChildren/.test(codeOnly), 'hasChildren が残っている（削除確認の子有無判定は不要）');
  const deleteButtonMatches = codeOnly.match(/削除/g) ?? [];
  assert.equal(deleteButtonMatches.length, 0, '「削除」という文言が残っている（実際: ' + deleteButtonMatches.length + '件）');
});
