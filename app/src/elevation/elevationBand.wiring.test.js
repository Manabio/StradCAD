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
  // S6（巨大関数の分割）: 階段下の部屋の描画は appendBandCutContent から部品 appendStairOverContent へ移った。
  // appendBandCutContent は bandRoomCells を定義して部品へ渡し、部品が flightsOverRoom／stringerSightlineVisible に渡す。
  const outer = functionBody(noComments, 'export function appendBandCutContent(');
  assert.ok(outer.includes('const bandRoomCells = cellBoundsList(room.cells, graph)'), 'bandRoomCells の定義が無い');
  assert.equal(count(outer, 'appendStairOverContent('), 1, 'appendStairOverContent の呼び出しが 1 回でない');
  assert.ok(/appendStairOverContent\([^)]*bandRoomCells/.test(outer), 'appendStairOverContent に bandRoomCells を渡していない');
  assert.equal(count(outer, 'flightsOverRoom('), 0, 'appendBandCutContent に flightsOverRoom の呼び出しが残っている');
  const body = functionBody(noComments, 'function appendStairOverContent(');
  assert.equal(count(body, 'flightsOverRoom(stairOver, bandRoomCells)'), 2, 'flightsOverRoom(…, bandRoomCells) が 2 回でない');
  assert.equal(count(body, 'stringerSightlineVisible(face, graph, stairOver, bandRoomCells)'), 1, 'stringerSightlineVisible(…, bandRoomCells) が 1 回でない');
  assert.equal(count(body, 'flightsOverRoom(stairOver, bandRoomBounds'), 0, 'flightsOverRoom に bandRoomBounds を渡している');
  assert.equal(count(body, 'flightsOverRoom('), 2, 'flightsOverRoom の呼び出しが 2 回でない');
  assert.equal(count(body, 'stringerSightlineVisible('), 1, 'stringerSightlineVisible の呼び出しが 1 回でない');
  assert.ok(!/stringerSightlineVisible\([^)]*bandRoomBounds/.test(body), 'stringerSightlineVisible に bandRoomBounds を渡している');
});

test('【配線】contentForCut（elevationStairSequence.js）: 壁の端の縦線は階段の実体の天端で切る（clipWallEndVerticalsByStairMass を壁プリミティブに通す）', () => {
  const seqSrc = fs.readFileSync(path.resolve(import.meta.dirname, 'elevationStairSequence.js'), 'utf8');
  assert.equal(seqSrc.split('dashHorizontalsBehindStair(clipWallEndVerticalsByStairMass(wallPrims, cut, columns), occluders)').length - 1, 1);
});

test('【配線】buildStraightFaceSequence（直進系の階段帯）: content は共通経路 buildCutContent を通し、専用経路 buildSectionFigure を呼ばない（S2）', () => {
  const seqSrc = fs.readFileSync(path.resolve(import.meta.dirname, 'elevationStairSequence.js'), 'utf8');
  const code = seqSrc.split(/\r?\n/)
    .filter(line => { const t = line.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
    .map(line => line.replace(/\s\/\/.*$/, '')).join('\n');
  const seqBody = functionBody(code, 'function buildStraightFaceSequence(');
  assert.equal(count(seqBody, 'straightContentForCut('), 1, 'straightContentForCut の呼び出しが 1 回でない');
  assert.equal(count(seqBody, 'bandContextOf('), 1, 'bandContextOf を使っていない');
  const body = functionBody(code, 'function straightContentForCut(');
  assert.equal(count(body, 'buildCutContent('), 1, 'buildCutContent の呼び出しが 1 回でない');
  assert.equal(count(body, 'upperOverhangOf(pcut, columns)'), 1, 'はり出し系のキーを upperOverhangOf から返していない');
  assert.equal(count(body, 'stairPrimitivesForCut('), 1, 'stairPrimitivesForCut の呼び出しが 1 回でない');
  assert.equal(count(code, 'buildSectionFigure'), 0, 'elevationStairSequence.js に buildSectionFigure が残っている');
});

test('【配線】appendBandCutContent: 階段下の部屋の stairPrimitivesForCut は farSide:false を渡す（下から見ると段裏。切断面の奥の段の見えがかりは出さない）', () => {
  // S6: 階段下の部屋の描画は部品 appendStairOverContent にある
  const body = functionBody(noComments, 'function appendStairOverContent(');
  assert.equal(count(body, 'stairPrimitivesForCut('), 1, 'stairPrimitivesForCut の呼び出しが 1 回でない');
  assert.equal(count(body, 'farSide: false'), 1, 'farSide: false が無い');
});

test('【配線】appendBandCutContent: 帯の部屋の巾木高さ（room.finish.baseboardHeight）を buildSectionFromLine へ baseboardMm で渡す（階段室越しの壁・隔て板の小口の巾木。2026-10-15）', () => {
  const body = functionBody(noComments, 'export function appendBandCutContent(');
  assert.equal(count(body, 'parseBaseboardHeightMm(room.finish?.baseboardHeight)'), 1, '部屋の巾木高さを解釈していない');
  assert.equal(count(body, 'upperPlaneOverhang: opts.upperPlaneOverhang, baseboardMm,'), 1, 'baseboardMm を buildSectionFromLine へ渡していない');
});
