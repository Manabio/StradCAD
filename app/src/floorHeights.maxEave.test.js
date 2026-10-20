// 階設定表の「最高の軒の高さ」（maxEaveHeightMm。階設定表 S8）。主屋根の軒高（GL〜軒桁上端）と、下屋の軒高
// （GL＋覆う階の FL＋覆う階の階高＝GL＋屋根セルが付く階の FL。裁定 2026-10-20）を比べた最大値。
// floorSettingsRows の view を受けるので draft に即時追従する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxEaveHeightMm, floorSettingsRows } from './floorHeights.js';

const P = (id, elevation, startFloor = 1, stories = 1) => ({ id, name: id, elevation, startFloor, stories });
// 1階0・2階3000・3階6000、最上階の階高 2900 → 軒桁上端 8900。GL=0
const planes3 = () => [P('p1', 0), P('p2', 3000, 2), P('p3', 6000, 3)];
const view = (planes, draft = {}, gl = 0, top = 2900) => floorSettingsRows(planes, draft, top, gl);
const withEave = (v, eaveFromGlMm) => ({ ...v, eaveFromGlMm }); // 軒高を偽装した view（下屋が最大になる分岐の検証用）

test('下屋が無ければ軒高と同じ（GL の正負も軒高に含まれる）', () => {
  const planes = planes3();
  assert.equal(maxEaveHeightMm(planes, view(planes)), 8900);
  assert.equal(maxEaveHeightMm(planes, view(planes, { glBelow1FlMm: 500 })), 9400); // GL が 1FL の 500 下 → GL からは 500 高い
  assert.equal(maxEaveHeightMm(planes, view(planes, { glBelow1FlMm: -300 })), 8600); // GL が 1FL より上
  assert.equal(maxEaveHeightMm(planes, view(planes), []), 8900);
  assert.equal(maxEaveHeightMm(planes, view(planes), undefined), 8900);
});

test('下屋の軒高＝屋根セルが付く階の FL。軒高より低い下屋では最大は軒高のまま', () => {
  const planes = planes3();
  assert.equal(maxEaveHeightMm(planes, view(planes), ['p1']), 8900); // 1FL=0
  assert.equal(maxEaveHeightMm(planes, view(planes), ['p2', 'p1']), 8900); // 3000・0
  assert.equal(maxEaveHeightMm(planes, view(planes), ['p3']), 8900); // 最上階に屋根セル＝最上階の FL 6000（軒高 8900 が大きい）
});

test('下屋が軒高より高い入力（view の軒高を偽装）は下屋が最大: 屋根セルが付く階の FL を使う（次の階の FL ではない）', () => {
  const planes = planes3();
  const v = withEave(view(planes), 2000);
  assert.equal(maxEaveHeightMm(planes, v, ['p2']), 3000, '2階に屋根セル → 2FL=3000（旧式の 3FL=6000 ではない）');
  assert.equal(maxEaveHeightMm(planes, v, ['p1']), 2000, '1FL=0 は軒高 2000 より低い');
  assert.equal(maxEaveHeightMm(planes, v, ['p1', 'p2']), 3000, '複数の下屋は最大');
  assert.equal(maxEaveHeightMm(planes, v, ['p3']), 6000, '最上階に屋根セルがあっても同じ式（最上階の FL）');
});

test('draft の編集に即時追従する: 2階の階高を伸ばすと 3FL（屋根セル階）が上がり、最上階の階高を縮めると軒高が下がる', () => {
  const planes = planes3();
  assert.equal(maxEaveHeightMm(planes, withEave(view(planes, { heights: { p2: '3300' } }), 2000), ['p3']), 6300);
  assert.equal(maxEaveHeightMm(planes, view(planes, { heights: { p3: '2000' } }), ['p3']), 8000);
  // 不正な欄は編集前の値として扱う
  assert.equal(maxEaveHeightMm(planes, withEave(view(planes, { heights: { p2: 'abc' } }), 2000), ['p3']), 6000);
  assert.equal(maxEaveHeightMm(planes, view(planes, { heights: { p3: 'abc' } }), ['p3']), 8900);
});

test('GL が動くと下屋の軒高も GL からの高さで動く', () => {
  const planes = planes3();
  assert.equal(maxEaveHeightMm(planes, withEave(view(planes, { glBelow1FlMm: 500 }), 2000), ['p2']), 3500);
});

test('複層(2-3階の Plane)の下屋は、その Plane の FL（先頭層の床）', () => {
  const planes = [P('p1', 0), P('m', 3000, 2, 2), P('p4', 9000, 4)];
  const v = withEave(view(planes, {}, 0, 2900), 1000);
  assert.equal(maxEaveHeightMm(planes, v, ['m']), 3000);
});

test('【失敗系】階が無い（軒高 null）なら null。planes に無い id は無視する', () => {
  assert.equal(maxEaveHeightMm([], view([]), ['p1']), null);
  const planes = planes3();
  assert.equal(maxEaveHeightMm(planes, view(planes), ['zzz']), 8900);
});
