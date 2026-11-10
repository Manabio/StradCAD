// ステップ12e「未知の建具記号のUI」の仕上げ。OpeningEditor.jsx の記号selectが未知記号を
// 黙って失わないよう、選択肢の組み立て（既知/未知/別スコープの判断）を openingEdit.js
// fixtureSymbolOptions へ一本化し、jsx側が getFixtureSymbols を直接optionに使わないことを
// ソーステキスト検査で固定する（renderer/OpeningsLayer.wiring.test.js と同じ型）。
// コメント（行頭コメント）は除外する——退行の説明コメントに現れる旧関数名を誤検知しないため
// （team-lessons「ソース文字列を正規表現で検査する配線テストが、コメント文にも一致して変異を
// 見逃す」参照）。行頭コメントしか除外しないため、コード行の末尾コメントに禁止語が現れると
// 安全側（誤って赤になる）に倒れる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve(import.meta.dirname, 'OpeningEditor.jsx');
const src = fs.readFileSync(filePath, 'utf8');

function stripComments(text) {
  return text.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
    .join('\n');
}

const codeOnly = stripComments(src);

test('【不変条件】OpeningEditor.jsx は openingEdit.js の fixtureSymbolOptions を import している', () => {
  // import文が複数行にまたがる（本ファイルの規約）ため、行単位ではなく './openingEdit.js' への
  // import文全体（{...}部分）を1つの塊として取り出して検査する。
  const m = src.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/openingEdit\.js';/);
  assert.ok(m, "'./openingEdit.js' からのimport文が見つからない");
  assert.ok(/\bfixtureSymbolOptions\b/.test(m[1]), 'fixtureSymbolOptions を openingEdit.js から import していない');
});

test('【不変条件】OpeningEditor.jsx の記号selectは getFixtureSymbols を直接optionに使わない（未知記号の保持判断はfixtureSymbolOptionsに一本化）', () => {
  assert.ok(!codeOnly.includes('getFixtureSymbols('), 'getFixtureSymbols( への直接呼び出しが残っている（未知記号の選択肢が黙って失われる旧経路へ退行）');
});

test('【不変条件】反転ボタン群の表示条件に SIDED_SLIDE_MECHANISMS が入り、吊元側は hasHandedSides で判定する', () => {
  assert.ok(/entry\?\.mechanism\s*&&\s*\(HINGED_MECHANISMS\.has\(entry\.mechanism\)\s*\|\|\s*SIDED_SLIDE_MECHANISMS\.has\(entry\.mechanism\)\)\s*&&\s*\(/.test(codeOnly),
    'ボタン群の条件に SIDED_SLIDE_MECHANISMS が無い');
  assert.ok(/hasHandedSides\(entry\.mechanism,\s*entry\)\s*&&\s*\(/.test(codeOnly), '吊元反転ボタンの条件が hasHandedSides でない');
});

test('【不変条件】反転ボタンの文言は sideFlipLabels 経由で、吊元反転等の文字列がコード行に直書きされていない', () => {
  assert.ok(/sideFlipLabels\(entry\.mechanism\)\.hinge/.test(codeOnly), 'hinge 文言が sideFlipLabels 経由でない');
  assert.ok(/sideFlipLabels\(entry\.mechanism\)\.swing/.test(codeOnly), 'swing 文言が sideFlipLabels 経由でない');
  // JSXコメント {/* ... */}（複数行）は行頭コメント除外で落ちないため、ここで塊ごと除く
  const noJsxComments = codeOnly.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  for (const s of ['吊元反転', '開く方向反転', '引き代反転', '走る面反転']) {
    assert.ok(!noJsxComments.includes(s), `${s} がコード行に直書きされている`);
  }
});

test('【不変条件】種別selectの選択肢は fittingSubTypeOptions 経由（現在値を必ず残す。getFittingOptions 直接呼びは不可）', () => {
  assert.ok(/fittingSubTypeOptions\(wallKind,\s*opening\.subType\)/.test(codeOnly), 'fittingSubTypeOptions(wallKind, opening.subType) の呼び出しが無い');
  assert.ok(!/\bgetFittingOptions\(/.test(codeOnly), 'getFittingOptions( の直接呼び出しが残っている');
  assert.ok(/catalog\.map\(o => <option/.test(codeOnly), '種別 select が catalog を map していない');
});

test('【不変条件】記号selectのoptionsはfixtureSymbolOptionsの呼び出し結果をmapするだけ', () => {
  assert.ok(/fixtureSymbolOptions\([\s\S]*?\)\.map\(/.test(codeOnly), 'fixtureSymbolOptions(...).map( の形が見つからない');
});

// ---- S6a: 部分詳細図の上書き欄（判断は openingDetailRefsEdit.js、jsx は配線だけ） ----
test('【不変条件】S6a: 詳細図の select は openingDetailRefSelects の結果を map し、変更は commitEdit 経由で detailRefsAfterSelect の値を代入する', () => {
  assert.ok(/openingDetailRefSelects\(opening, undefined, \{ frameSlots: frameDetailSlotsFor\(opening, isFrameOnly, entry\?\.mechanism\) \}\)/.test(codeOnly), 'openingDetailRefSelects を frameSlots 付きで呼んでいない');
  assert.ok(/detailSelects\.map\(/.test(codeOnly), 'select を detailSelects.map で出していない');
  assert.ok(/onDetailRefChange\s*=\s*\(slot\)\s*=>\s*\(e\)\s*=>\s*commitEdit\(/.test(codeOnly), 'select の変更が commitEdit を通っていない（undo に乗らない）');
  assert.ok(/detailRefsAfterSelect\(opening, slot, e\.target\.value, entry\?\.mechanism\)/.test(codeOnly), '次の detailRefs を純関数で求めていない');
  assert.ok(/opening\.detailRefs\s*=\s*next/.test(codeOnly), 'detailRefs へ代入していない');
});

test('【不変条件】S6a: R16 ボタンは commitEdit 経由で detailDimensionsToCopy の値を書き、値が無ければ disabled。自動の書き戻しは無い', () => {
  assert.ok(/onCopyDetailDimensions\s*=\s*\(\)\s*=>\s*\{[\s\S]*?commitEdit\(/.test(codeOnly), 'R16 が commitEdit を通っていない');
  assert.ok(/disabled=\{detailDimensions == null\}/.test(codeOnly), '値が無いときに disabled にしていない');
  assert.ok(/OPENING_DETAIL_REF_TEXT\.copyDimensions/.test(codeOnly), 'ボタン文言を共通のラベル表から引いていない');
  assert.equal((codeOnly.match(/detailDimensionsToCopy\(/g) ?? []).length, 1, '寸法の導出は 1 箇所（描画のたびに書き戻していない）');
});

test('【不変条件】S6a/S6b/S8e-3/S8f-2: 方立・上枠の slot は frameDetailSlotsFor（三方枠・片開き戸・窓）、R16 は三方枠だけ（R5）。姿図の select は全機構', () => {
  assert.ok(/const detailSelects = openingDetailRefSelects\(opening, undefined, \{ frameSlots: frameDetailSlotsFor\(opening, isFrameOnly, entry\?\.mechanism\) \}\)/.test(codeOnly));
  assert.ok(!/SWING_LEAF_SUBTYPE|SLIDE_DOUBLE/.test(codeOnly), '絞りの判断が jsx に戻っている（frameDetailSlotsFor に一本化）');
  assert.ok(!/frameDetailSlotsApply/.test(codeOnly), '旧判定が残っている');
  assert.ok(/const detailDimensions = isFrameOnly \?/.test(codeOnly));
  assert.ok(/\{isFrameOnly && \(\s*<div style=\{rowStyle\}>\s*<button/.test(codeOnly), 'R16 ボタンが isFrameOnly で絞られていない');
});
