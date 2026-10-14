// 階段下の部屋の判定の配線（elevationBand.js のソース文字列検査。viewEntryBoundary.wiring.test.js と同じ流儀）。
// 階段付き graph のフィクスチャが無いため、「実セルを渡している」ことを本体の文字列で固定する。
// 包絡矩形（roomBounds）に戻すと L 字の切り欠きの階段室が階段下の部屋になる（moku4-3 2階 廊下。2026-10-14）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(import.meta.dirname, 'elevationBand.js'), 'utf8');
// 行頭コメント・JSDoc 本文・行末コメントを除く
const noComments = src.split(/\r?\n/)
  .filter(line => { const t = line.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
  .map(line => line.replace(/\s\/\/.*$/, '')).join('\n');

/** marker の後の `) {` から対応する `}` までの本体を返す。 */
function functionBody(code, marker) {
  const startIdx = code.indexOf(marker);
  assert.ok(startIdx >= 0, `${marker} が見つからない`);
  const braceStart = code.indexOf('{', code.indexOf(') {', startIdx));
  let depth = 0, i = braceStart;
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) break; }
  }
  return code.slice(braceStart, i + 1);
}
const count = (s, needle) => s.split(needle).length - 1;

test('【配線】stairContributionOverRoom は部屋の実セル（cellBoundsList）を渡し、包絡矩形（roomBounds）を使わない', () => {
  const body = functionBody(noComments, 'export function stairContributionOverRoom(');
  assert.ok(body.includes('cellBoundsList(room.cells, graph)'), 'cellBoundsList(room.cells, graph) が無い');
  assert.ok(!body.includes('roomBounds('), 'roomBounds( が残っている');
  assert.equal(count(body, 'flightsOverRoom(contribution, cellRects)'), 1, 'flightsOverRoom に cellRects を渡していない');
});

test('【配線】appendBandCutContent: flightsOverRoom 2 箇所と stringerSightlineVisible 1 箇所が bandRoomCells を渡す', () => {
  const body = functionBody(noComments, 'export function appendBandCutContent(');
  assert.ok(body.includes('const bandRoomCells = cellBoundsList(room.cells, graph)'), 'bandRoomCells の定義が無い');
  assert.equal(count(body, 'flightsOverRoom(opts.stairOver, bandRoomCells)'), 2, 'flightsOverRoom(…, bandRoomCells) が 2 回でない');
  assert.equal(count(body, 'stringerSightlineVisible(face, graph, opts.stairOver, bandRoomCells)'), 1, 'stringerSightlineVisible(…, bandRoomCells) が 1 回でない');
  assert.equal(count(body, 'flightsOverRoom(opts.stairOver, bandRoomBounds'), 0, 'flightsOverRoom に bandRoomBounds を渡している');
  assert.equal(count(body, 'flightsOverRoom('), 2, 'flightsOverRoom の呼び出しが 2 回でない');
  assert.equal(count(body, 'stringerSightlineVisible('), 1, 'stringerSightlineVisible の呼び出しが 1 回でない');
  assert.ok(!/stringerSightlineVisible\([^)]*bandRoomBounds/.test(body), 'stringerSightlineVisible に bandRoomBounds を渡している');
});
