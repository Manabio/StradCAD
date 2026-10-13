// 展開・天伏の突入境界の配線（App.jsx のソース文字列検査。wallRefresh.test.js の不変条件テストと同じ流儀）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSrc = fs.readFileSync(path.resolve(import.meta.dirname, 'App.jsx'), 'utf8');
const codeOnly = s => s.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');

/** marker の後の最初の `{` から対応する `}` までを返す（marker 自体は引数側の `{` を避けるため `) {` を探す）。 */
function braceBlockAfter(src, marker, { skipParams = false } = {}) {
  const startIdx = src.indexOf(marker);
  assert.ok(startIdx >= 0, `${marker} が見つからない`);
  const from = skipParams ? src.indexOf(') {', startIdx) : startIdx;
  const braceStart = src.indexOf('{', from);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(braceStart, i + 1);
}

const registry = braceBlockAfter(appSrc, 'const modeBoundaries = {');
const CALL = /refreshWallsForViewEntry\(project, \{ saveActiveFloorFn: saveFloor \}\)/;

test('【S3・19a】modeBoundaries の elevation と ceiling がそれぞれ refreshWallsForViewEntry を呼ぶ', () => {
  const elevation = codeOnly(braceBlockAfter(registry, 'elevation:'));
  const ceiling = codeOnly(braceBlockAfter(registry, 'ceiling:'));
  assert.match(elevation, CALL, 'elevation.enter に呼び出しが無い');
  assert.match(ceiling, CALL, 'ceiling.enter に呼び出しが無い');
});

test('【S3・19b】switchHistoryContext（履歴ナビ）は素の切替のまま＝境界も壁の鮮度判定も呼ばない', () => {
  const body = codeOnly(braceBlockAfter(appSrc, 'async function switchHistoryContext', { skipParams: true }));
  assert.ok(!/modeBoundaries/.test(body), 'switchHistoryContext が modeBoundaries を参照している');
  assert.ok(!/refreshWalls/.test(body), 'switchHistoryContext が refreshWalls* を呼んでいる');
});

test('【S3・19c】switchFloorKeepingMode は enter を floorSwitch: true で呼ぶ', () => {
  const body = codeOnly(braceBlockAfter(appSrc, 'async function switchFloorKeepingMode', { skipParams: true }));
  assert.match(body, /boundary\?\.enter\?\.\([^)]*floorSwitch: true/);
});

test('【S3・19d】elevation.enter は壁の鮮度判定が採番収集より前（.then の順）で、async 関数にしない', () => {
  const elevation = codeOnly(braceBlockAfter(registry, 'elevation:'));
  const iRefresh = elevation.indexOf('refreshWallsForViewEntry(');
  const iThen = elevation.indexOf('.then(');
  const iCollect = elevation.indexOf('collectOpeningNumbersAllFloors(');
  assert.ok(iRefresh >= 0 && iThen > iRefresh && iCollect > iThen, '順序が 鮮度判定 → .then → 採番収集 になっていない');
  assert.ok(!/async/.test(elevation), 'elevation.enter を async にしてはいけない（uiBusyClassification の個数固定）');
});
