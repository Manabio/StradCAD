// 階設定表の確定の計算部（computeFloorHeightEdit）・入力検査・GL の undo 部品（階設定表 S4）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFloorHeightEdit, validateStoryHeightText, validateGlText } from './floorHeights.js';
import { collectProjectLevels, applyProjectLevels, diffFloorOpSnapshot } from './floorOps.js';
import { Project } from './core/project.js';

const P = (id, startFloor, elevation, stories = 1) => ({ id, name: `${startFloor}階`, startFloor, elevation, stories });
const edit = (planes, heights, top = 2900, gl = 0, glNew) =>
  computeFloorHeightEdit(planes, { heights: new Map(Object.entries(heights)), glBelow1FlMm: glNew }, top, gl);
const elevs = (r) => Object.fromEntries(r.updates.map(u => [u.id, u.elevation]));

// 1〜4階（階高 3000/3000/3000/最上階 2900）
const four = () => [P('f1', 1, 0), P('f2', 2, 3000), P('f3', 3, 6000), P('f4', 4, 9000)];
// B2・B1・1・2階（B2 は B2FL=-6000 から階高 3000、B1 は -3000 から 3000）
const withBase = () => [P('b2', -2, -6000), P('b1', -1, -3000), P('f1', 1, 0), P('f2', 2, 3000)];

test('地上中間(2階)の階高を +200: 3・4階だけ上へ。1・2階と GL は動かない', () => {
  const r = edit(four(), { f2: 3200 });
  assert.deepEqual(elevs(r), { f3: 6200, f4: 9200 });
  assert.equal(r.glBelow1FlMm, null);
  assert.ok(r.ok);
});

test('最下階(1階)の階高を -300: 2〜4階が下へ。1階は 0 のまま', () => {
  const r = edit(four(), { f1: 2700 });
  assert.deepEqual(elevs(r), { f2: 2700, f3: 5700, f4: 8700 });
});

test('最上階の階高だけ変更: elevation は動かず topStoryHeightMm だけ書く', () => {
  const r = edit(four(), { f4: 2600 });
  assert.deepEqual(r.updates, [{ id: 'f4', name: '4階', startFloor: 4, elevation: 9000, topStoryHeightMm: 2600 }]);
});

test('最上階の階高が初期値（resolve 済み 2900）と同じなら変化なし（topStoryHeightMm を書かない）', () => {
  assert.deepEqual(edit(four(), { f4: 2900 }).updates, []);
});

test('複数の階を同時に変更: 累積でずれる（2階 +100・3階 +50 → 3階 +100・4階 +150）', () => {
  const r = edit(four(), { f2: 3100, f3: 3050 });
  assert.deepEqual(elevs(r), { f3: 6100, f4: 9150 });
});

test('不揃いの階高の文書でも、触っていない階は動かない（2800/3100/3000/最上2900）', () => {
  const planes = [P('f1', 1, 0), P('f2', 2, 2800), P('f3', 3, 5900), P('f4', 4, 8900)];
  const r = edit(planes, { f3: 3200 });
  assert.deepEqual(elevs(r), { f4: 9100 });
});

test('地階 B1 の階高を +200: B1 と B2 が 200 下がる。1FL=0 と上階は動かない', () => {
  const r = edit(withBase(), { b1: 3200 });
  assert.deepEqual(elevs(r), { b2: -6200, b1: -3200 });
});

test('地階 B2 の階高を +200: B2 だけ下がる（B1 は動かない）', () => {
  const r = edit(withBase(), { b2: 3200 });
  assert.deepEqual(elevs(r), { b2: -6200 });
});

test('地階 B1 を -300 で縮める: B1・B2 が 300 上がる', () => {
  const r = edit(withBase(), { b1: 2700 });
  assert.deepEqual(elevs(r), { b2: -5700, b1: -2700 });
});

test('地階と地上を同時に変更: 地階側は下へ、地上側は上へ。1階は 0 のまま', () => {
  const r = edit(withBase(), { b1: 3100, f1: 3300 });
  assert.deepEqual(elevs(r), { b2: -6100, b1: -3100, f2: 3300 });
});

test('複層の Plane（stories=2・1 層分の階高 3000）: 階高 +100 は層数ぶん(+200)上をずらす', () => {
  const planes = [P('f1', 1, 0), P('f23', 2, 3000, 2), P('f4', 4, 9000)];
  const r = edit(planes, { f23: 3100 });
  assert.deepEqual(elevs(r), { f4: 9200 });
});

test('複層の最上階: topStoryHeightMm は 1 層分の値', () => {
  const planes = [P('f1', 1, 0), P('f23', 2, 3000, 2)];
  const r = edit(planes, { f23: 2700 });
  assert.deepEqual(r.updates.map(u => [u.id, u.elevation, u.topStoryHeightMm]), [['f23', 3000, 2700]]);
});

test('全階が地階（1FL の階が無い）: 最上の地階を固定して下へずらす（B2 を +300 → B2 が 300 下がる）', () => {
  const planes = [P('b2', -2, -6000), P('b1', -1, -3000)];
  assert.deepEqual(elevs(edit(planes, { b2: 3300 })), { b2: -6300 });
  // 最上の地階の階高は topStoryHeightMm にだけ書く
  const top = edit(planes, { b1: 2600 });
  assert.deepEqual(top.updates.map(u => [u.id, u.elevation, u.topStoryHeightMm]), [['b1', -3000, 2600]]);
});

test('1FL≠0 の文書（f1=100）: 基準階の elevation は動かさず、上だけずれる', () => {
  const planes = [P('f1', 1, 100), P('f2', 2, 3100), P('f3', 3, 6100)];
  const r = edit(planes, { f2: 3200 });
  assert.deepEqual(elevs(r), { f3: 6300 });
});

test('複層の地階（B が stories=2・1 層分 3000）を +100: その地階と下の階が 200 下がる', () => {
  const planes = [P('b3', -3, -9000), P('b21', -2, -6000, 2), P('f1', 1, 0)];
  const r = edit(planes, { b21: 3100 });
  assert.deepEqual(elevs(r), { b3: -9200, b21: -6200 });
});

test('全角数字・全角マイナスは検査の前に半角へ直す（"３２００" → 3200、GL "－５００" → -500）', () => {
  assert.deepEqual(validateStoryHeightText('３２００'), { ok: true, value: 3200, error: null });
  assert.equal(validateGlText('－５００').value, -500);
  assert.equal(validateGlText('−５００').value, -500);
  const r = edit(four(), { f2: '３２００' }, 2900, 0, '－５００');
  assert.deepEqual(elevs(r), { f3: 6200, f4: 9200 });
  assert.equal(r.glBelow1FlMm, -500);
});

test('GL のみの変更: updates は空・GL だけ返る。負の GL も可', () => {
  const r = edit(four(), {}, 2900, 0, 300);
  assert.deepEqual(r.updates, []);
  assert.equal(r.glBelow1FlMm, 300);
  assert.equal(edit(four(), {}, 2900, 0, -450).glBelow1FlMm, -450);
});

test('変化なし: GL が現在値と同じ・階高が初期値と同じなら空', () => {
  const r = edit(four(), { f2: 3000, f1: 3000 }, 2900, 300, 300);
  assert.deepEqual(r.updates, []);
  assert.equal(r.glBelow1FlMm, null);
  assert.ok(r.ok);
});

test('入力検査: 階高 1449 は不可・1450 は可（行 id を invalidIds で返し、updates は空）', () => {
  const bad = edit(four(), { f2: 1449, f3: 3100 });
  assert.deepEqual(bad.invalidIds, ['f2']);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.updates, []);
  const good = edit(four(), { f2: 1450 });
  assert.equal(good.ok, true);
  assert.deepEqual(elevs(good), { f3: 4450, f4: 7450 });
});

test('【失敗系】入力検査: 小数・NaN・テキストの空欄/非数/小数は不可', () => {
  assert.deepEqual(edit(four(), { f2: 3000.5 }).invalidIds, ['f2']);
  assert.deepEqual(edit(four(), { f2: NaN }).invalidIds, ['f2']);
  for (const t of ['', ' ', 'abc', '3000.5', '1e3', '1449']) {
    assert.deepEqual(edit(four(), { f2: t }).invalidIds, ['f2'], JSON.stringify(t));
  }
  assert.equal(edit(four(), { f2: '3200' }).ok, true);
});

test('【失敗系】GL の不正: 小数・非数・空欄は glInvalid', () => {
  for (const g of [0.5, NaN, '', 'x', '1.5']) {
    const r = edit(four(), {}, 2900, 0, g);
    assert.equal(r.glInvalid, true, String(g));
    assert.equal(r.ok, false);
  }
  assert.equal(edit(four(), {}, 2900, 0, '-100').glBelow1FlMm, -100);
});

test('旧データの非整数の階高（draft は編集した行だけ）: 未編集は draft に入らず ok／編集して "2999.5" や 2999.5 は不正', () => {
  const planes = [P('f1', 1, 0), P('f2', 2, 2999.5), P('f3', 3, 6000)];
  // 何も編集していない（draft 空）→ ok・変化なし・GL は null
  const untouched = edit(planes, {});
  assert.equal(untouched.ok, true);
  assert.deepEqual(untouched.invalidIds, []);
  assert.deepEqual(untouched.updates, []);
  assert.equal(untouched.glBelow1FlMm, null);
  // 編集した行は常に検査する（文字列でも数値でも。初期値と同じ非整数でも不正）
  assert.deepEqual(edit(planes, { f1: '2999.5' }).invalidIds, ['f1']);
  assert.deepEqual(edit(planes, { f1: 2999.5 }).invalidIds, ['f1']);
  assert.deepEqual(edit(planes, { f1: 2999.7 }).invalidIds, ['f1']);
  // 編集値が初期値と同じ整数なら検査は通り、変化なし
  assert.deepEqual(edit(four(), { f2: '3000' }).updates, []);
  assert.equal(edit(four(), { f2: '3000' }).ok, true);
  // 整数に直す（触る）のは可。f1 を 3000 にすると f2 以降が +0.5
  assert.deepEqual(elevs(edit(planes, { f1: 3000 })), { f2: 3000, f3: 6000.5 });
  // 別の行を触っても、触っていない非整数の行は動かない（差分の累積で誤差が入らない）
  assert.deepEqual(elevs(edit(planes, { f2: 3100 })), { f3: 6099.5 });
});

test('GL: 現在値が非整数でも未編集（draft に無い）なら ok・null／編集して小数は不正', () => {
  const r = computeFloorHeightEdit(four(), { heights: new Map() }, 2900, 12.5);
  assert.equal(r.ok, true);
  assert.equal(r.glBelow1FlMm, null);
  assert.equal(edit(four(), {}, 2900, 12.5, '12.5').glInvalid, true);
});

test('validateStoryHeightText / validateGlText', () => {
  assert.deepEqual(validateStoryHeightText('1450'), { ok: true, value: 1450, error: null });
  assert.equal(validateStoryHeightText('1449').ok, false);
  assert.equal(validateStoryHeightText('').ok, false);
  assert.equal(validateStoryHeightText('30.5').ok, false);
  assert.equal(validateStoryHeightText(' 3000 ').value, 3000);
  assert.equal(validateStoryHeightText('-3000').ok, false);
  assert.equal(validateStoryHeightText('99999').ok, true, '上限なし');
  assert.equal(validateGlText('-200').value, -200);
  assert.equal(validateGlText('0').ok, true);
  assert.equal(validateGlText('1.5').ok, false);
  assert.equal(validateGlText('').ok, false);
  assert.ok(validateStoryHeightText('x').error.length > 0);
});

// ---- GL を階操作の undo に載せる部品 ----

test('collectProjectLevels / applyProjectLevels: GL を収集し、apply で戻る', () => {
  const project = new Project('proj', 'test');
  const before = collectProjectLevels(project);
  assert.deepEqual(before, { glBelow1FlMm: 0, basementStructure: null }); // 地階構造も採る（S5c-2。未設定＝null）
  project.setGlBelow1FlMm(-250);
  assert.deepEqual(collectProjectLevels(project), { glBelow1FlMm: -250, basementStructure: null });
  applyProjectLevels(project, before);
  assert.equal(project.glBelow1FlMm, 0);
  applyProjectLevels(project, null); // levels 無し＝何もしない
  assert.equal(project.glBelow1FlMm, 0);
});

test('diffFloorOpSnapshot: GL だけが変わった前後は変化あり（levelsChanged）。省略時・同値は従来どおり変化なし', () => {
  const base = { before: new Map(), after: new Map(), metasBefore: [], metasAfter: [] };
  const changed = diffFloorOpSnapshot({ ...base, levelsBefore: { glBelow1FlMm: 0 }, levelsAfter: { glBelow1FlMm: 300 } });
  assert.equal(changed.levelsChanged, true);
  assert.equal(changed.hasChanges, true);
  const same = diffFloorOpSnapshot({ ...base, levelsBefore: { glBelow1FlMm: 100 }, levelsAfter: { glBelow1FlMm: 100 } });
  assert.equal(same.hasChanges, false);
  assert.equal(diffFloorOpSnapshot(base).hasChanges, false, '既存の呼び出し（levels 省略）は不変');
});
