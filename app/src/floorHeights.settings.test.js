// 階設定表ダイアログの行モデル（floorSettingsRows。階設定表 S5）。UI を持たない純関数を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorSettingsRows } from './floorHeights.js';

const P = (id, startFloor, elevation, stories = 1, name = `${startFloor}階`) => ({ id, name, startFloor, elevation, stories });
const rows = (planes, heights = {}, top = 2900, gl = 0, glNew) =>
  floorSettingsRows(planes, { heights, glBelow1FlMm: glNew }, top, gl);
const ids = (v) => v.rows.map(r => r.id);
const by = (v, id) => v.rows.find(r => r.id === id);

const four = () => [P('f1', 1, 0), P('f2', 2, 3000), P('f3', 3, 6000), P('f4', 4, 9000)];

test('並びは上＝上階。階名・初期の階高（最上階は resolve 済みの 2900）・nFL（GL 0）', () => {
  const v = rows(four());
  assert.deepEqual(ids(v), ['f4', 'f3', 'f2', 'f1']);
  assert.deepEqual(v.rows.map(r => r.name), ['4階', '3階', '2階', '1階']);
  assert.deepEqual(v.rows.map(r => r.heightText), ['2900', '3000', '3000', '3000']);
  assert.deepEqual(v.rows.map(r => r.nFlMm), [9000, 6000, 3000, 0]);
  assert.deepEqual(v.rows.map(r => r.isTop), [true, false, false, false]);
  assert.ok(v.rows.every(r => !r.edited && !r.invalid && r.error === null));
  assert.equal(v.gl.text, '0');
  assert.ok(v.ok);
  assert.equal(v.changed, false);
});

test('軒高（GL〜軒桁上端）= 最上階 elevation + 最上階の階高 + GL', () => {
  assert.equal(rows(four()).eaveFromGlMm, 9000 + 2900);
  assert.equal(rows(four(), {}, 2900, 500).eaveFromGlMm, 9000 + 2900 + 500);
});

test('nFL は GL を足す（GL 正 = GL は 1FL より下 → nFL が大きい。負 = 小さい）', () => {
  const v = rows(four(), {}, 2900, 500);
  assert.deepEqual(v.rows.map(r => r.nFlMm), [9500, 6500, 3500, 500]);
  const w = rows(four(), {}, 2900, -300);
  assert.deepEqual(w.rows.map(r => r.nFlMm), [8700, 5700, 2700, -300]);
});

test('GL の編集が nFL・軒高へ即時に反映される（GL 欄の text は入力のまま）', () => {
  const v = rows(four(), {}, 2900, 0, '500');
  assert.deepEqual(v.rows.map(r => r.nFlMm), [9500, 6500, 3500, 500]);
  assert.equal(v.eaveFromGlMm, 9000 + 2900 + 500);
  assert.equal(v.gl.text, '500');
  assert.equal(v.gl.edited, true);
  assert.ok(v.ok);
  assert.equal(v.changed, true);
});

test('階高の編集が上の階の nFL・軒高へ即時に反映される（2階 +200 → 3・4階 +200、1・2階は不変）', () => {
  const v = rows(four(), { f2: '3200' });
  assert.deepEqual(v.rows.map(r => r.nFlMm), [9200, 6200, 3000, 0]);
  assert.equal(by(v, 'f2').heightText, '3200');
  assert.equal(by(v, 'f2').edited, true);
  assert.equal(v.eaveFromGlMm, 9200 + 2900);
  assert.equal(v.changed, true);
});

test('最上階の階高の編集は軒高だけを変える（nFL は動かない）', () => {
  const v = rows(four(), { f4: '2600' });
  assert.deepEqual(v.rows.map(r => r.nFlMm), [9000, 6000, 3000, 0]);
  assert.equal(v.eaveFromGlMm, 9000 + 2600);
});

test('全角数字の入力は有効（半角として受ける）', () => {
  const v = rows(four(), { f2: '３２００' });
  assert.equal(by(v, 'f2').invalid, false);
  assert.deepEqual(v.rows.map(r => r.nFlMm), [9200, 6200, 3000, 0]);
});

test('不揃い（2800/3100/3000/最上2900）と複層（stories=2 は1層分）の初期階高', () => {
  const planes = [P('f1', 1, 0), P('f2', 2, 2800), P('f3', 3, 5900), P('f4', 4, 8900)];
  assert.deepEqual(rows(planes).rows.map(r => r.heightText), ['2900', '3000', '3100', '2800']);
  const multi = [P('f1', 1, 0), P('f23', 2, 3200, 2, '2・3階'), P('f4', 4, 9100)];
  const v = rows(multi);
  assert.deepEqual(v.rows.map(r => r.heightText), ['2900', '2950', '3200']);
  assert.deepEqual(v.rows.map(r => r.nFlMm), [9100, 3200, 0]);
});

test('地階を含む並び: nFL は負（B1FL = -3000 + GL）。最下階が一番下の行', () => {
  const planes = [P('b2', -2, -6000), P('b1', -1, -3000), P('f1', 1, 0), P('f2', 2, 3000)];
  const v = rows(planes, {}, 2900, 500);
  assert.deepEqual(ids(v), ['f2', 'f1', 'b1', 'b2']);
  assert.deepEqual(v.rows.map(r => r.nFlMm), [3500, 500, -2500, -5500]);
});

test('旧データの非整数の階高は編集しなくても止まらない（未編集の行は検査しない）', () => {
  const planes = [P('f1', 1, 0), P('f2', 2, 2987.5)];
  const v = rows(planes);
  assert.equal(by(v, 'f1').heightText, '2987.5');
  assert.ok(v.ok);
});

test('【失敗系】不正な階高（空・小数・下限未満・非数）の行は invalid + error、OK 不可。nFL は編集前の値のまま', () => {
  for (const bad of ['', '3000.5', '1449', 'abc', '-3000']) {
    const v = rows(four(), { f2: bad });
    assert.equal(by(v, 'f2').invalid, true, `「${bad}」は不正`);
    assert.ok(by(v, 'f2').error, `「${bad}」に error`);
    assert.equal(by(v, 'f2').heightText, bad);
    assert.equal(v.ok, false);
    assert.equal(v.changed, false);
    assert.deepEqual(v.rows.map(r => r.nFlMm), [9000, 6000, 3000, 0]);
  }
});

test('階高の下限 1450 ちょうどは有効', () => {
  const v = rows(four(), { f2: '1450' });
  assert.equal(by(v, 'f2').invalid, false);
  assert.ok(v.ok);
});

test('【失敗系】不正な GL（空・小数・非数）は gl.invalid、OK 不可。負の整数は有効。軒高・nFL は編集前の GL のまま', () => {
  for (const bad of ['', '1.5', 'x']) {
    const v = rows(four(), {}, 2900, 200, bad);
    assert.equal(v.gl.invalid, true, `「${bad}」は不正`);
    assert.ok(v.gl.error);
    assert.equal(v.ok, false);
    assert.equal(v.eaveFromGlMm, 9000 + 2900 + 200);
  }
  const neg = rows(four(), {}, 2900, 0, '-300');
  assert.equal(neg.gl.invalid, false);
  assert.ok(neg.ok);
});

test('不正な行と有効な行が混在: 有効な行の編集は nFL に反映され、不正な行は印だけ付く', () => {
  const v = rows(four(), { f2: 'zz', f3: '3100' });
  assert.equal(by(v, 'f2').invalid, true);
  assert.equal(by(v, 'f3').invalid, false);
  assert.deepEqual(v.rows.map(r => r.nFlMm), [9100, 6000, 3000, 0]);
  assert.equal(v.ok, false);
});

test('初期値と同じ値を入れ直した行は edited だが changed にならない', () => {
  const v = rows(four(), { f2: '3000' });
  assert.equal(by(v, 'f2').edited, true);
  assert.ok(v.ok);
  assert.equal(v.changed, false);
});

test('Map 形式の draft・数値の draft も受ける。未知の id は無視する', () => {
  const v = floorSettingsRows(four(), { heights: new Map([['f2', 3200], ['zz', 5000]]) }, 2900, 0);
  assert.deepEqual(v.rows.map(r => r.nFlMm), [9200, 6200, 3000, 0]);
  assert.ok(v.ok);
});

test('階が無いとき: 行なし・軒高 null', () => {
  const v = rows([]);
  assert.deepEqual(v.rows, []);
  assert.equal(v.eaveFromGlMm, null);
});
