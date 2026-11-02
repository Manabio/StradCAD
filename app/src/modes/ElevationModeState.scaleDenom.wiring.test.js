// ElevationModeState.js の配線の不変条件: 最小描画幅（minDrawnMm）に使う縮尺の分母 scaleDenom は、2 パス目の帯構築だけに渡る。
// 1 パス目（倍率決定用）・単体テスト・golden は未指定＝展開の想定 100（最小幅 50）のまま（2026-11-02 裁定）。
// .jsx ではないが ElevationModeState は多数の依存を静的に引くため、ソース文字列をコメント除去のうえ検査する（team-lessons の流儀）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(import.meta.dirname, 'ElevationModeState.js'), 'utf8').replace(/\r\n/g, '\n');

function stripCommentLines(text) {
  return text.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

/** _buildBands の本体（コメント除去済み）を pass1 / pass2 の呼び出しに割る。 */
function passes(text) {
  const p1 = text.indexOf('const pass1 = buildBandsSafely');
  const p2 = text.indexOf('const { bands, failedRoomNames } = buildBandsSafely');
  assert.ok(p1 >= 0 && p2 > p1, 'pass1 / pass2 の buildBandsSafely が見つからない');
  const decided = text.indexOf('const scale = chooseElevationScale', p1);
  assert.ok(decided > p1 && decided < p2, '倍率決定の行が見つからない');
  return { pass1: text.slice(p1, decided), pass2: text.slice(p2, text.indexOf('failedRoomNames.length', p2)) };
}

test('【不変条件】scaleDenom は screenPxPerMm / scale の丸めで求め、2 パス目の ctx と junctionSectionSwap の判定に使う', () => {
  const { pass2 } = passes(stripCommentLines(SRC));
  assert.match(stripCommentLines(SRC), /const scaleDenom\s*=\s*Math\.round\(screenPxPerMm \/ scale\);/);
  assert.match(pass2, /junctionSectionSwap: scaleDenom <= LOD_DETAIL_DENOM,/);
  assert.match(pass2, /^\s*scaleDenom,$/m, '2 パス目の ctx へ scaleDenom を渡す');
});

test('【不変条件】1 パス目（倍率決定用）には scaleDenom を渡さない（未指定＝100）', () => {
  const { pass1 } = passes(stripCommentLines(SRC));
  assert.doesNotMatch(pass1, /scaleDenom/);
});

test('【検出力】2 パス目から scaleDenom を外した文字列・コメントだけに書いた文字列では落ちる', () => {
  const body = passes(stripCommentLines(SRC)).pass2;
  const broken = body.replace(/^\s*scaleDenom,$/m, '');
  assert.doesNotMatch(broken, /^\s*scaleDenom,$/m);
  const commentOnly = stripCommentLines('const pass1 = buildBandsSafely(\nconst scale = chooseElevationScale(\nconst { bands, failedRoomNames } = buildBandsSafely(\n  // scaleDenom,\nfailedRoomNames.length');
  assert.doesNotMatch(passes(commentOnly).pass2, /scaleDenom/);
});
