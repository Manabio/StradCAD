// columnWidthScope.js（在来木造の柱カード「柱寸」欄・適用範囲2択の書き込み先決定）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveColumnWidthEdit, normalizeColumnOverridesToFloor, allowedColumnWidths, isUpsizedWidth, columnWidthChangeNotice } from './columnWidthScope.js';
import { makeColumn, makeGraph } from './memberTestFixtures.js';

test('【ユーザー裁定2026-09-17】resolveColumnWidthEdit: scope=allは常にfloorへ選んだ幅をそのまま書く', () => {
  const result = resolveColumnWidthEdit({ scope: 'all', focusedMember: null, floorWidth: 120, width: 105 });
  assert.deepEqual(result, { target: 'floor', value: 105 });
});

test('【ユーザー裁定2026-09-17】resolveColumnWidthEdit: scope=allはfocusedMemberがあっても無視してfloorへ書く（個別カードでscope=allを選ぶと全体を変える）', () => {
  const result = resolveColumnWidthEdit({ scope: 'all', focusedMember: { id: 'c1' }, floorWidth: 120, width: 90 });
  assert.deepEqual(result, { target: 'floor', value: 90 });
});

test('【ユーザー裁定2026-09-17】resolveColumnWidthEdit: scope=entityでfocusedMemberが無ければ書き込み先が無い（一覧から開いた個別カードは「この部材」がdisabled）', () => {
  const result = resolveColumnWidthEdit({ scope: 'entity', focusedMember: null, floorWidth: 120, width: 105 });
  assert.deepEqual(result, { target: null, value: null });
});

test('【QA裁定の踏襲】resolveColumnWidthEdit: scope=entityで選んだ幅が階の値と異なればmemberへその幅を書く', () => {
  const result = resolveColumnWidthEdit({ scope: 'entity', focusedMember: { id: 'c1' }, floorWidth: 120, width: 105 });
  assert.deepEqual(result, { target: 'member', value: 105 });
});

test('【QA裁定の踏襲・失敗系】resolveColumnWidthEdit: scope=entityで選んだ幅が階の値と同じならmemberへnull（共通へ戻す）を書く', () => {
  const result = resolveColumnWidthEdit({ scope: 'entity', focusedMember: { id: 'c1' }, floorWidth: 120, width: 120 });
  assert.deepEqual(result, { target: 'member', value: null });
});

test('【QA指摘2026-09-17・失敗系】resolveColumnWidthEdit: 未知のscope（"bogus"等）は書き込み先が無い（"all"を明示的に判定し、既定でfloorへ倒さない）', () => {
  const result = resolveColumnWidthEdit({ scope: 'bogus', focusedMember: { id: 'c1' }, floorWidth: 120, width: 105 });
  assert.deepEqual(result, { target: null, value: null });
});

test('【QA指摘2026-09-17】normalizeColumnOverridesToFloor: graph内の柱のうちwoodColumnWidthMmが新しい階の値と同値のものだけnull（共通）へ正規化する', () => {
  const columnA = makeColumn('a', 'WOOD-120x120', { woodColumnWidthMm: 120 }); // 新しい階の値(120)と同値→正規化される
  const columnB = makeColumn('b', 'WOOD-90x90', { woodColumnWidthMm: 90 }); // 階の値と異なる→そのまま
  const columnC = makeColumn('c', 'WOOD-105x105', { woodColumnWidthMm: null }); // 元々共通→そのまま
  const graph = makeGraph('p1', { columnMap: [columnA, columnB, columnC] });
  normalizeColumnOverridesToFloor(graph, 120);
  assert.equal(columnA.woodColumnWidthMm, null, '階の値と同値になった個別指定はnullへ正規化されていない（禁止状態の復活）');
  assert.equal(columnB.woodColumnWidthMm, 90, '階の値と異なる個別指定まで巻き込んで消してはいけない');
  assert.equal(columnC.woodColumnWidthMm, null, '元々共通の柱は無変化のままnull');
});

// ---- 柱寸アップ（ユーザー裁定2026-09-17・B-1）: allowedColumnWidths/isUpsizedWidth ----

test('【B-1】allowedColumnWidths: allowUpsize=falseはfloorWidth以下だけ（floorWidth自身を含む）', () => {
  assert.deepEqual(allowedColumnWidths(105, false), [90, 105]);
  assert.deepEqual(allowedColumnWidths(90, false), [90], 'floorWidthが最小値でも自身は含む');
});

test('【B-1】allowedColumnWidths: allowUpsize=trueは階の値に関わらず全件', () => {
  assert.deepEqual(allowedColumnWidths(105, true), [90, 105, 120]);
  assert.deepEqual(allowedColumnWidths(90, true), [90, 105, 120]);
});

test('【失敗系・B-1】allowedColumnWidths: floorWidthがnull・カタログ外（無効値）は絞り込みできないため全件', () => {
  assert.deepEqual(allowedColumnWidths(null, false), [90, 105, 120]);
  assert.deepEqual(allowedColumnWidths(100, false), [90, 105, 120], 'カタログ外の階の値(100)は絞り込みの基準にできない');
});

test('【B-1】isUpsizedWidth: widthが階の値より大きいときだけtrue', () => {
  assert.equal(isUpsizedWidth(120, 105), true);
  assert.equal(isUpsizedWidth(105, 105), false, '階の値と同値はアップではない');
  assert.equal(isUpsizedWidth(90, 105), false, '階の値未満はアップではない');
});

test('【失敗系・B-1】isUpsizedWidth: 非数の入力は例外を投げずfalse', () => {
  assert.equal(isUpsizedWidth(null, 105), false);
  assert.equal(isUpsizedWidth(120, null), false);
  assert.equal(isUpsizedWidth(undefined, undefined), false);
});

// ---- 階の柱寸変更（縮小・拡大）の注意（ユーザー裁定2026-09-22） ----

test('【ユーザー裁定2026-09-22】columnWidthChangeNotice: 縮小＋壁ありは固定文言を返す', () => {
  const message = columnWidthChangeNotice({ prevWidth: 120, nextWidth: 105, wallCount: 3 });
  assert.equal(message, '柱寸が縮小されました。外壁まわりの柱は、平面モードなどへ切り替えたとき（構造モードを出たとき）に外壁側へ寄せられます。');
});

test('【失敗系・ユーザー裁定2026-09-22】columnWidthChangeNotice: 同値はnull', () => {
  assert.equal(columnWidthChangeNotice({ prevWidth: 120, nextWidth: 120, wallCount: 3 }), null);
});

// 拡大も同じ乖離を持つ（壁が細い柱寸で作られている階を太くすると、構造モードを出るまで柱は寄った
// まま残る）ため、別文言で知らせる（ユーザー裁定2026-09-22・当初の「拡大はnull」から変更）。
test('【ユーザー裁定2026-09-22】columnWidthChangeNotice: 拡大＋壁ありは拡大用の固定文言を返す（縮小の文言とは別）', () => {
  const message = columnWidthChangeNotice({ prevWidth: 105, nextWidth: 120, wallCount: 3 });
  assert.equal(message, '柱寸が拡大されました。外壁まわりの柱の位置は、平面モードなどへ切り替えたとき（構造モードを出たとき）に調整されます。');
  assert.notEqual(message, columnWidthChangeNotice({ prevWidth: 120, nextWidth: 105, wallCount: 3 }), '縮小と拡大で文言を取り違えていない');
});

test('【失敗系・ユーザー裁定2026-09-22】columnWidthChangeNotice: 拡大でも壁0はnull', () => {
  assert.equal(columnWidthChangeNotice({ prevWidth: 105, nextWidth: 120, wallCount: 0 }), null);
});

test('【失敗系・ユーザー裁定2026-09-22】columnWidthChangeNotice: 壁0はnull（壁が無い階では寄せも偏心も起きない）', () => {
  assert.equal(columnWidthChangeNotice({ prevWidth: 120, nextWidth: 105, wallCount: 0 }), null);
  // 壁本数が数でない（渡し忘れ等）も「出さない」側へ倒す。
  assert.equal(columnWidthChangeNotice({ prevWidth: 120, nextWidth: 105, wallCount: undefined }), null);
  assert.equal(columnWidthChangeNotice({ prevWidth: 120, nextWidth: 105, wallCount: null }), null);
  assert.equal(columnWidthChangeNotice({ prevWidth: 120, nextWidth: 105, wallCount: NaN }), null);
});

test('【失敗系・ユーザー裁定2026-09-22】columnWidthChangeNotice: prevWidthがnull/undefined/NaNはnull', () => {
  assert.equal(columnWidthChangeNotice({ prevWidth: null, nextWidth: 105, wallCount: 3 }), null);
  assert.equal(columnWidthChangeNotice({ prevWidth: undefined, nextWidth: 105, wallCount: 3 }), null);
  assert.equal(columnWidthChangeNotice({ prevWidth: NaN, nextWidth: 105, wallCount: 3 }), null);
});

test('【失敗系・ユーザー裁定2026-09-22】columnWidthChangeNotice: nextWidthがnull/NaNはnull', () => {
  assert.equal(columnWidthChangeNotice({ prevWidth: 120, nextWidth: null, wallCount: 3 }), null);
  assert.equal(columnWidthChangeNotice({ prevWidth: 120, nextWidth: NaN, wallCount: 3 }), null);
});
