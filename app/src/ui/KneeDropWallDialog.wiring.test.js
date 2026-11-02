// KneeDropWallDialog.jsx の配線の不変条件（部分詳細図 S8b-1）: 確定は buildKneeDropRecord 経由・select は detailRefsAfterSelectFor・
// detailRefs／frontSide の初期値は既存の記録（existing）から引き継ぐ（引き継ぎが落ちると、値だけ直して確定した記録から割当てが黙って消える）。
// .jsx は node:test から import できないため、ソース文字列をコメント除去のうえ検査する（team-lessons の流儀）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(import.meta.dirname, 'KneeDropWallDialog.jsx'), 'utf8').replace(/\r\n/g, '\n');

function stripComments(text) {
  return text.split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
    .map(l => l.replace(/\s\/\/ .*$/, ''))
    .join('\n');
}
const BODY = stripComments(SRC);

const RE_CONFIRM = /onConfirm\(buildKneeDropRecord\(\{ kneeVal, dropVal, detailRefs, frontSide \}\)\)/;
const RE_SELECT = /onChange=\{e => setDetailRefs\(detailRefsAfterSelectFor\(KNEE_DROP_DETAIL_SLOTS, detailRefs, sel\.slot, e\.target\.value\)\)\}/;
const RE_INIT_REFS = /useState\(existing\?\.detailRefs \?\? null\)/;
const RE_INIT_SIDE = /useState\(kneeDropFrontSideOf\(existing\)\)/;

test('【不変条件】確定は buildKneeDropRecord({kneeVal, dropVal, detailRefs, frontSide}) を onConfirm に渡す', () => {
  assert.match(BODY, RE_CONFIRM);
});

test('【不変条件】select の onChange は detailRefsAfterSelectFor(KNEE_DROP_DETAIL_SLOTS, …) で次の detailRefs を作る', () => {
  assert.match(BODY, RE_SELECT);
});

test('【不変条件】detailRefs／frontSide の初期値は既存の記録（existing）から引き継ぐ', () => {
  assert.match(BODY, RE_INIT_REFS);
  assert.match(BODY, RE_INIT_SIDE);
  assert.match(BODY, /const existing = graph\.kneeDropWalls\.get\(spanKey\) \?\? null;/);
});

test('【検出力】配線を外した・コメントに書いただけの文字列では落ちる', () => {
  const noRefs = BODY.replace(RE_INIT_REFS, 'useState(null)');
  assert.doesNotMatch(noRefs, RE_INIT_REFS, 'detailRefs の引き継ぎを外すと検出される');
  const noSide = BODY.replace(RE_INIT_SIDE, "useState('roomNeg')");
  assert.doesNotMatch(noSide, RE_INIT_SIDE);
  const rawConfirm = BODY.replace(RE_CONFIRM, 'onConfirm({ knee: kneeVal, drop: dropVal })');
  assert.doesNotMatch(rawConfirm, RE_CONFIRM);
  const rawSelect = BODY.replace(RE_SELECT, 'onChange={e => setDetailRefs({ [sel.slot]: e.target.value })}');
  assert.doesNotMatch(rawSelect, RE_SELECT);
  const commentOnly = stripComments("  // onConfirm(buildKneeDropRecord({ kneeVal, dropVal, detailRefs, frontSide }))\n  onConfirm(null);");
  assert.doesNotMatch(commentOnly, RE_CONFIRM);
});
