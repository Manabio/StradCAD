// [+] ボタンの入口（Q21 案A。S5c-2）: 判定の純関数 resolveAddFloorEntry と、App.jsx／AddFloorDialog.jsx の配線。
// App.jsx は react-konva 等を静的に引き node:test から import できないため、配線はソース走査（コメント行を除いて照合）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveAddFloorEntry, computeFloorInsert } from './floorOps.js';
import { readAppSrc, stripCommentLines, extractFunctionBody } from './uiBusySourceScan.js';

const P = (id, startFloor, elevation, extra = {}) => ({ id, name: id, startFloor, elevation, stories: 1, isAlternative: false, ...extra });

test('最下階が地上階: ダイアログ（isLowest=true＝「下階」あり）', () => {
  const planes = [P('p1', 1, 0), P('p2', 2, 3000)];
  assert.deepEqual(resolveAddFloorEntry(planes, planes[0]), { mode: 'dialog', isLowest: true });
});

test('最下階が2階などの地上階でも「下階」あり（新しい階は地上階になる）', () => {
  const planes = [P('p2', 2, 0), P('p3', 3, 3000)];
  assert.deepEqual(resolveAddFloorEntry(planes, planes[0]), { mode: 'dialog', isLowest: true });
});

test('最下階でない地上階: ダイアログ（isLowest=false＝「一般階」）', () => {
  const planes = [P('p1', 1, 0), P('p2', 2, 3000)];
  assert.deepEqual(resolveAddFloorEntry(planes, planes[1]), { mode: 'dialog', isLowest: false });
});

test('最下階の地階: ダイアログを出さず即時（INSERT の地階分岐）', () => {
  const planes = [P('b1', -1, -3000), P('p1', 1, 0)];
  assert.deepEqual(resolveAddFloorEntry(planes, planes[0]), { mode: 'immediate' });
});

test('最下階でない地階: 即時（今のまま）', () => {
  const planes = [P('b2', -2, -6000), P('b1', -1, -3000), P('p1', 1, 0)];
  assert.deepEqual(resolveAddFloorEntry(planes, planes[1]), { mode: 'immediate' });
});

test('【失敗系】検討案・表示中の階なしは null（何もしない）', () => {
  const planes = [P('p1', 1, 0)];
  assert.equal(resolveAddFloorEntry(planes, P('alt', 1, 0, { isAlternative: true })), null);
  assert.equal(resolveAddFloorEntry(planes, null), null);
  assert.equal(resolveAddFloorEntry(planes, undefined), null);
});

test('最下階の地階に即時の上階追加（INSERT の地階分岐）を実際に流す: 表示中の地階が下へずれ、新しい階がその直上', () => {
  const planes = [P('b1', -1, -3000), P('p1', 1, 0)];
  const ins = computeFloorInsert(planes, 'b1', 1);
  assert.equal(ins.newPlane.startFloor, -1, '新しい階は元の B1 の番号');
  assert.equal(ins.newPlane.elevation, -3000, '新しい階は元の B1 の高さ');
  const moved = ins.updates.find(u => u.id === 'b1');
  assert.equal(moved.startFloor, -2, '元の B1 は B2 へ');
  assert.equal(moved.elevation, -6000, '階高 3000 だけ下へ');
  assert.equal(ins.updates.some(u => u.id === 'p1'), false, '地上階は動かさない');
});

// ---- 配線（ソース走査）----
test('【配線】handleAddFloor は resolveAddFloorEntry の結果で分岐し、immediate は executeAddUpper、dialog は isLowest を渡す', () => {
  const body = extractFunctionBody(readAppSrc(), 'function handleAddFloor');
  assert.match(body, /^\s*const entry = resolveAddFloorEntry\(project\.planes, currentPlane\);/m);
  assert.match(body, /^\s*if \(!entry\) return;/m);
  assert.match(body, /^\s*if \(entry\.mode === 'immediate'\) \{\s*$/m);
  assert.match(body, /^\s*return executeAddUpper\(currentPlane\);/m);
  assert.match(body, /setFloorDialog\(\{ isLowest: entry\.isLowest, anchor:/);
  // 旧判定（最下階でない地階だけ即時）は残っていない
  assert.doesNotMatch(body, /!isLowest && currentPlane\.startFloor < 0/);
});

test('【配線】App.jsx は floorOps.js から resolveAddFloorEntry を import する', () => {
  assert.match(readAppSrc(), /removePlanesForRedo, resolveAddFloorEntry,\s*$/m);
});

test('【配線】AddFloorDialog: 下階（isLowest）は1階分固定（n の入力欄とテンキーを出さず、n は常に 1）', () => {
  const code = stripCommentLines(fs.readFileSync(path.resolve(import.meta.dirname, 'ui/AddFloorDialog.jsx'), 'utf8'));
  assert.match(code, /const n = isLowest \? 1 : Math\.max\(1, Math\.floor\(Number\(nStr\) \|\| 1\)\);/);
  assert.match(code, /^\s*\{!isLowest && \(\s*$/m, 'n の入力欄が !isLowest のときだけ出る形');
  assert.match(code, /const showN\s*= choice === altChoice && !isLowest;/);
  assert.match(code, /const altUnit\s*= isLowest \? '1階分' : '階分';/);
});
