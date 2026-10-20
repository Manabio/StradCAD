// 階設定表 S3: 階の並びを変える操作（並べ替え・削除・階変更・挿入・下階追加）が、各階の階高を保って
// elevation を積み直す。階高が不均一な並び（地階 B1 2800・1階 3200・2階 2950・3階 3100・最上階 2900）で、
// 全経路の全採用階の elevation と topStoryHeightMm を期待値で照合する。
// 既存の 3000 均一の期待値は floorOps.test.js に残る（不変）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renumberPlanesFrom, computeFloorReorder, computeFloorChangeReorder, computeFloorDeleteReorder,
  computeFloorInsert, computeFloorAddLowerElevations, applyFloorInsert, collectPlaneMetas, applyPlaneMetas,
  normalizeFirstFloorZero,
} from './floorOps.js';
import { resolveTopStoryHeightMm, storyHeightsMm, eaveTopZMm } from './floorHeights.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structural/structureRules.js';
import { Project } from './core/project.js';

// 純関数向けの平面スタブ。
function P(id, startFloor, stories, elevation, extra = {}) {
  return { id, startFloor, stories, elevation, name: `${startFloor}階`, ...extra };
}

// 階高: B1 2800 / F1 3200 / F2 2950 / F3 3100 / F4(最上階) 2900
const TOP = 2900;
function fixture() {
  return [
    P('B1', -1, 1, -2800), P('F1', 1, 1, 0), P('F2', 2, 1, 3200),
    P('F3', 3, 1, 6150), P('F4', 4, 1, 9250, { topStoryHeightMm: TOP }),
  ];
}
// 複層を含む並び: B1 2800 / F1 3200 / F23(stories 2, 1層 2950) / F4(最上階) 2900
function multiFixture() {
  return [
    P('B1', -1, 1, -2800), P('F1', 1, 1, 0), P('F23', 2, 2, 3200, { name: '2・3階' }),
    P('F4', 4, 1, 9100, { topStoryHeightMm: TOP }),
  ];
}
// 地階2層を含む並び: B2 2700 / B1 2800 / F1 3200 / F2(最上階) 2900
function underFixture() {
  return [
    P('B2', -2, 1, -5500), P('B1', -1, 1, -2800), P('F1', 1, 1, 0), P('F2', 2, 1, 3200, { topStoryHeightMm: TOP }),
  ];
}

// planes に updates を重ねた結果の { id: elevation }
function elevations(planes, updates) {
  const out = Object.fromEntries(planes.map(p => [p.id, p.elevation]));
  for (const u of updates) out[u.id] = u.elevation;
  return out;
}
function startFloors(planes, updates) {
  const out = Object.fromEntries(planes.map(p => [p.id, p.startFloor]));
  for (const u of updates) out[u.id] = u.startFloor;
  return out;
}
// 更新一覧のうち topStoryHeightMm を持つもの { id: mm }
function topWrites(updates) {
  return Object.fromEntries(updates.filter(u => u.topStoryHeightMm !== undefined).map(u => [u.id, u.topStoryHeightMm]));
}
// 振り直し後の「各階の1層分の階高」が操作前と同じ（階高を保って移動した）ことの確認用。
function heightsAfter(order, updates, topHeightMm) {
  const elev = elevations(order, updates);
  const moved = order.map(p => ({ ...p, elevation: elev[p.id] }));
  const m = storyHeightsMm(moved, topHeightMm);
  return Object.fromEntries([...m]);
}

// ---- renumberPlanesFrom（heights 引数）----
test('renumberPlanesFrom: heights（添字を揃えた1層分の階高）を保って積む。複層は 階高×層数', () => {
  const planes = [P('a', 1, 1, 0), P('b', 2, 2, 9999), P('c', 4, 1, 9999)];
  const updates = renumberPlanesFrom(planes, 1, [3200, 2950, 2900]);
  assert.deepEqual(updates.map(u => [u.id, u.elevation, u.startFloor]), [['b', 3200, 2], ['c', 3200 + 2 * 2950, 4]]);
});

test('【失敗系】renumberPlanesFrom: heights 省略・欠損要素は 3000 にフォールバック（既存挙動）', () => {
  const planes = [P('a', 1, 1, 0), P('b', 2, 1, 1), P('c', 3, 1, 1)];
  assert.deepEqual(renumberPlanesFrom(planes, 1).map(u => u.elevation), [3000, 6000]);
  assert.deepEqual(renumberPlanesFrom(planes, 1, [3200]).map(u => u.elevation), [3200, 6200]); // 添字1が欠損
});

// ---- 並べ替え ----
test('並べ替え: 最上階を中間へ（F4 を F2 の前へ）。各階は自分の階高を保ち、新しい最上階 F3 に topStoryHeightMm=3100', () => {
  const planes = fixture();
  const updates = computeFloorReorder(planes, 'F4', 2, { topHeightMm: TOP });
  assert.deepEqual(elevations(planes, updates), { B1: -2800, F1: 0, F4: 3200, F2: 6100, F3: 9050 });
  assert.deepEqual(startFloors(planes, updates), { B1: -1, F1: 1, F4: 2, F2: 3, F3: 4 });
  assert.deepEqual(topWrites(updates), { F3: 3100 });
  // 旧最上階 F4 は中間になり、その階高＝それまでの最上階の階高（2900）
  const order = [planes[0], planes[1], planes[4], planes[2], planes[3]];
  const h = heightsAfter(order, updates, 3100);
  assert.deepEqual([h.B1, h.F1, h.F4, h.F2, h.F3], [2800, 3200, 2900, 2950, 3100]);
});

test('並べ替え: 中間を最上階へ（F2 を末尾へ）。F2 に topStoryHeightMm=2950（それまでの自分の階高）', () => {
  const planes = fixture();
  const updates = computeFloorReorder(planes, 'F2', 5, { topHeightMm: TOP });
  assert.deepEqual(elevations(planes, updates), { B1: -2800, F1: 0, F3: 3200, F4: 6300, F2: 9200 });
  assert.deepEqual(topWrites(updates), { F2: 2950 });
});

test('並べ替え: 中間どうしの入替え（F3 を F2 の前へ）。最上階は変わらず topStoryHeightMm を書かない', () => {
  const planes = fixture();
  const updates = computeFloorReorder(planes, 'F3', 2, { topHeightMm: TOP });
  assert.deepEqual(elevations(planes, updates), { B1: -2800, F1: 0, F3: 3200, F2: 6300, F4: 9250 });
  assert.deepEqual(topWrites(updates), {});
});

test('並べ替え: opts 省略（最上階の階高が不明）でも各階の階高は保ち、topStoryHeightMm は書かない', () => {
  const planes = fixture();
  const updates = computeFloorReorder(planes, 'F2', 5);
  // 最上階の階高が不明なので F4 は既定 3000 扱い（F3 3200 → F4 6300 → F2 6300+3000）。他の階の階高は保たれる。
  assert.deepEqual(elevations(planes, updates), { B1: -2800, F1: 0, F3: 3200, F4: 6300, F2: 9300 });
  assert.deepEqual(topWrites(updates), {});
});

test('並べ替え: 複層（stories=2）を含む。最上階 F4 を複層 F23 の前へ → F23 が最上階（topStoryHeightMm=1層分 2950）', () => {
  const planes = multiFixture();
  const updates = computeFloorReorder(planes, 'F4', 2, { topHeightMm: TOP });
  assert.deepEqual(elevations(planes, updates), { B1: -2800, F1: 0, F4: 3200, F23: 6100 });
  assert.deepEqual(startFloors(planes, updates), { B1: -1, F1: 1, F4: 2, F23: 3 });
  assert.deepEqual(topWrites(updates), { F23: 2950 });
  const moved = [planes[0], planes[1], planes[3], planes[2]].map(p => ({ ...p, elevation: elevations(planes, updates)[p.id] }));
  assert.equal(eaveTopZMm(moved, 2950), 6100 + 2 * 2950);
});

test('【失敗系】並べ替え: 最下階・隣接・範囲外は null のまま（階高を渡しても）', () => {
  const planes = fixture();
  assert.equal(computeFloorReorder(planes, 'B1', 3, { topHeightMm: TOP }), null);
  assert.equal(computeFloorReorder(planes, 'F2', 3, { topHeightMm: TOP }), null);
  assert.equal(computeFloorReorder(planes, 'nope', 3, { topHeightMm: TOP }), null);
});

// ---- 削除 ----
function del(planes, id, topHeightMm = TOP) {
  const idx = planes.findIndex(p => p.id === id);
  const after = planes.filter(p => p.id !== id);
  return computeFloorDeleteReorder(after, idx, { planesBefore: planes, topHeightMm });
}

test('削除: 最上階を削除 → 新しい最上階 F3 に topStoryHeightMm＝削除した階との差（3100）。他は動かない', () => {
  const planes = fixture();
  const updates = del(planes, 'F4');
  assert.deepEqual(updates, [{ id: 'F3', name: '3階', startFloor: 3, elevation: 6150, topStoryHeightMm: 3100 }]);
});

test('削除: 中間（F3）を削除 → 上の階は各自の階高を保って詰まる。最上階は変わらず topStoryHeightMm なし', () => {
  const planes = fixture();
  const updates = del(planes, 'F3');
  assert.deepEqual(elevations(planes.filter(p => p.id !== 'F3'), updates), { B1: -2800, F1: 0, F2: 3200, F4: 6150 });
  assert.deepEqual(startFloors(planes.filter(p => p.id !== 'F3'), updates), { B1: -1, F1: 1, F2: 2, F4: 3 });
  assert.deepEqual(topWrites(updates), {});
});

test('削除: 1階（F1）を削除 → 地階の階高で 1FL=0 に詰まる（F2=0・F3=2950・F4=6050）', () => {
  const planes = fixture();
  const updates = del(planes, 'F1');
  assert.deepEqual(elevations(planes.filter(p => p.id !== 'F1'), updates), { B1: -2800, F2: 0, F3: 2950, F4: 6050 });
  assert.deepEqual(startFloors(planes.filter(p => p.id !== 'F1'), updates), { B1: -1, F2: 1, F3: 2, F4: 3 });
  assert.deepEqual(topWrites(updates), {});
});

test('削除: 最下階（地階 B1）を削除 → 残りの階は動かない', () => {
  const planes = fixture();
  assert.deepEqual(del(planes, 'B1'), []);
});

test('削除: 地階2層の最下階（B2）を削除 → 動かない。最上階の F2 を削除 → F1 に topStoryHeightMm=3200', () => {
  const planes = underFixture();
  assert.deepEqual(del(planes, 'B2'), []);
  assert.deepEqual(topWrites(del(planes, 'F2')), { F1: 3200 });
});

test('削除: 複層を含む並びで中間 F1 を削除 → 複層 F23 は 階高×2 を保って積まれる', () => {
  const planes = multiFixture();
  const after = planes.filter(p => p.id !== 'F1');
  const updates = del(planes, 'F1');
  // B1 の階高 2800 で F23 が 0 から。F4 は F23 の天端（2×2950）
  assert.deepEqual(elevations(after, updates), { B1: -2800, F23: 0, F4: 5900 });
});

test('削除: planesBefore を渡さない従来呼び出しは全階を 3000 で積む（互換）', () => {
  const planes = fixture();
  const after = planes.filter(p => p.id !== 'F3');
  assert.deepEqual(elevations(after, computeFloorDeleteReorder(after, 3)), { B1: -2800, F1: 0, F2: 3200, F4: 6200 });
});

test('【失敗系】削除: 削除位置が末尾以降・残り0件でも例外にしない', () => {
  assert.deepEqual(computeFloorDeleteReorder([], 0, { planesBefore: [P('x', 1, 1, 0)], topHeightMm: TOP }), []);
  const planes = fixture();
  assert.deepEqual(computeFloorDeleteReorder(planes, 99, { planesBefore: planes, topHeightMm: TOP }), []);
});

// ---- 階変更 ----
test('階変更: F2 を 5階へ → 以降は 5・6・7 階。全階の elevation は階高を保って不変', () => {
  const planes = fixture();
  const updates = computeFloorChangeReorder(planes, 'F2', 5, { topHeightMm: TOP });
  assert.deepEqual(elevations(planes, updates), { B1: -2800, F1: 0, F2: 3200, F3: 6150, F4: 9250 });
  assert.deepEqual(startFloors(planes, updates), { B1: -1, F1: 1, F2: 5, F3: 6, F4: 7 });
  assert.deepEqual(topWrites(updates), {});
});

test('階変更: 複層を含む並びでも 1層分の階高×層数で積む', () => {
  const planes = multiFixture();
  const updates = computeFloorChangeReorder(planes, 'F1', 3, { topHeightMm: TOP });
  assert.deepEqual(elevations(planes, updates), { B1: -2800, F1: 0, F23: 3200, F4: 9100 });
  assert.deepEqual(startFloors(planes, updates), { B1: -1, F1: 3, F23: 4, F4: 6 });
});

test('【失敗系】階変更: 0 階・存在しない planeId は null', () => {
  const planes = fixture();
  assert.equal(computeFloorChangeReorder(planes, 'F2', 0, { topHeightMm: TOP }), null);
  assert.equal(computeFloorChangeReorder(planes, 'nope', 5, { topHeightMm: TOP }), null);
});

// ---- 挿入 ----
test('挿入: 最上階 F4 の上に追加 → 新階は直下階（F3）の階高 3100 を継ぎ、topStoryHeightMm=3100。updates は空', () => {
  const planes = fixture();
  const { newPlane, updates } = computeFloorInsert(planes, 'F4', 1, { topHeightMm: TOP });
  assert.equal(newPlane.elevation, 9250 + 3100);
  assert.equal(newPlane.startFloor, 5);
  assert.equal(newPlane.topStoryHeightMm, 3100);
  assert.deepEqual(updates, []);
});

test('挿入: 裁定の例（1階 3000・2階が最上階 2900 → 3階追加後は 3000・3000・3000）', () => {
  const planes = [P('F1', 1, 1, 0), P('F2', 2, 1, 3000, { topStoryHeightMm: 2900 })];
  const { newPlane } = computeFloorInsert(planes, 'F2', 1, { topHeightMm: 2900 });
  assert.equal(newPlane.elevation, 6000); // 2階は 3000 に置き換わる
  assert.equal(newPlane.topStoryHeightMm, 3000); // 3階も 3000
});

test('挿入: 1階建て（直下階なし）の最上階の上 → 元の最上階の値（topHeightMm）を保ち、新階も同じ値を継ぐ', () => {
  const planes = [P('F1', 1, 1, 0, { topStoryHeightMm: 2900 })];
  const { newPlane, updates } = computeFloorInsert(planes, 'F1', 1, { topHeightMm: 2900 });
  assert.equal(newPlane.elevation, 2900);
  assert.equal(newPlane.topStoryHeightMm, 2900);
  assert.deepEqual(updates, []);
});

test('挿入: 中間（F2 の上）に追加 → 新階は F2 の階高 2950 を継ぎ、上の階は各自の階高を保って押し上がる。topStoryHeightMm は載せない', () => {
  const planes = fixture();
  const { newPlane, updates } = computeFloorInsert(planes, 'F2', 1, { topHeightMm: TOP });
  assert.equal(newPlane.elevation, 3200 + 2950);
  assert.equal(newPlane.startFloor, 3);
  assert.equal('topStoryHeightMm' in newPlane, false);
  assert.deepEqual(elevations(planes, updates), { B1: -2800, F1: 0, F2: 3200, F3: 9100, F4: 12200 });
  assert.deepEqual(startFloors(planes, updates), { B1: -1, F1: 1, F2: 2, F3: 4, F4: 5 });
  assert.deepEqual(topWrites(updates), {});
});

test('挿入: 複層（stories=2）を中間へ → 新階の高さ＝階高×2、上の階はその分だけ押し上がる', () => {
  const planes = fixture();
  const { newPlane, updates } = computeFloorInsert(planes, 'F2', 2, { topHeightMm: TOP });
  assert.equal(newPlane.stories, 2);
  assert.equal(newPlane.elevation, 6150);
  assert.deepEqual(elevations(planes, updates), { B1: -2800, F1: 0, F2: 3200, F3: 6150 + 2 * 2950, F4: 6150 + 2 * 2950 + 3100 });
});

test('挿入: 複層の最上階側。複層の中間 F23 の上へ追加 → F23 の1層分 2950 を継ぐ（新階 elevation=3200+2×2950）', () => {
  const planes = multiFixture();
  const { newPlane, updates } = computeFloorInsert(planes, 'F23', 1, { topHeightMm: TOP });
  assert.equal(newPlane.elevation, 3200 + 2 * 2950);
  assert.deepEqual(elevations(planes, updates), { B1: -2800, F1: 0, F23: 3200, F4: 9100 + 2950 });
});

test('挿入: 地階 B1 の上へ追加 → 地階側をずらして 1FL=0 を保つ。新階は B1 の階高 2800', () => {
  const planes = underFixture();
  const { newPlane, updates } = computeFloorInsert(planes, 'B1', 1, { topHeightMm: TOP });
  assert.equal(newPlane.startFloor, -1);
  assert.equal(newPlane.elevation, -2800);
  assert.deepEqual(elevations(planes, updates), { B2: -8300, B1: -5600, F1: 0, F2: 3200 });
  assert.deepEqual(startFloors(planes, updates), { B2: -3, B1: -2, F1: 1, F2: 2 });
});

test('挿入: 最下の地階 B2 の上へ追加 → B2 の階高 2700 を継ぎ、B2 だけ 2700 下へ', () => {
  const planes = underFixture();
  const { newPlane, updates } = computeFloorInsert(planes, 'B2', 1, { topHeightMm: TOP });
  assert.equal(newPlane.elevation, -5500);
  assert.deepEqual(elevations(planes, updates), { B2: -8200, B1: -2800, F1: 0, F2: 3200 });
});

test('挿入: 地階 B1 の上へ複層（n=2）→ ずらし量は 階高×n（2800×2）。新階は -5600 から 0 まで', () => {
  const planes = underFixture();
  const { newPlane, updates } = computeFloorInsert(planes, 'B1', 2, { topHeightMm: TOP });
  assert.equal(newPlane.elevation, -5600);
  assert.deepEqual(elevations(planes, updates), { B2: -11100, B1: -8400, F1: 0, F2: 3200 });
});

test('【失敗系】挿入: 存在しない currentPlaneId は null', () => {
  assert.equal(computeFloorInsert(fixture(), 'nope', 1, { topHeightMm: TOP }), null);
});

// ---- 下階追加 ----
test('下階追加: 新しい最下階は元の最下階（B1）の階高 2800 を継ぎ、n 本を 2800 刻みで下へ積む（既存階は動かさない）', () => {
  assert.deepEqual(computeFloorAddLowerElevations(fixture(), 2, { topHeightMm: TOP }), [-5600, -8400]);
});

test('下階追加: 最下階が1階（3200）なら 3200 を継ぐ。1階建て（最下階＝最上階）なら最上階の階高', () => {
  const planes = fixture().slice(1);
  assert.deepEqual(computeFloorAddLowerElevations(planes, 1, { topHeightMm: TOP }), [-3200]);
  assert.deepEqual(computeFloorAddLowerElevations([P('F1', 1, 1, 0)], 2, { topHeightMm: 2900 }), [-2900, -5800]);
});

test('【失敗系】下階追加: n=0・階が空でも例外にしない', () => {
  assert.deepEqual(computeFloorAddLowerElevations(fixture(), 0, { topHeightMm: TOP }), []);
  assert.deepEqual(computeFloorAddLowerElevations([], 1, {}), [-3000]);
});

// ---- 1FL=0 の正規化（全経路の最後。振り直し後に startFloor===1 になる階の elevation を 0 へ）----
test('正規化: 削除 — B2/B1/F1/F2 不揃いで B1 を削除 → 新しい1階（F2）が elevation 0、各階の階高は保たれる', () => {
  const planes = [P('B2', -2, 1, -5350), P('B1', -1, 1, -2750), P('F1', 1, 1, 0), P('F2', 2, 1, 3300, { topStoryHeightMm: 3300 })];
  const after = planes.filter(p => p.id !== 'B1');
  const updates = computeFloorDeleteReorder(after, 1, { planesBefore: planes, topHeightMm: 3300 });
  assert.deepEqual(elevations(after, updates), { B2: -5900, F1: -3300, F2: 0 });
  assert.deepEqual(startFloors(after, updates), { B2: -2, F1: -1, F2: 1 });
  const moved = after.map(p => ({ ...p, elevation: elevations(after, updates)[p.id] }));
  assert.deepEqual([...storyHeightsMm(moved, 3300).values()], [2600, 3300, 3300]);
  // 元の updates に無かった階（最下階 B2）も更新一覧に載る
  assert.ok(updates.some(u => u.id === 'B2' && u.elevation === -5900));
});

test('正規化: 並べ替え — 最上階（legacy 2900）を最下階の直上へ → 1階になった B1 が 0（HEAD は 0 だったので -100 に外さない）', () => {
  const planes = [
    P('B2', -2, 1, -6000), P('B1', -1, 1, -3000), P('F1', 1, 1, 0), P('F2', 2, 1, 3000, { topStoryHeightMm: 2900 }),
  ];
  const updates = computeFloorReorder(planes, 'F2', 1, { topHeightMm: 2900 });
  assert.deepEqual(startFloors(planes, updates), { B2: -2, F2: -1, B1: 1, F1: 2 });
  assert.deepEqual(elevations(planes, updates), { B2: -5900, F2: -2900, B1: 0, F1: 3000 });
  assert.deepEqual(topWrites(updates), { F1: 3000 });
});

test('正規化: 階変更 — 最下の地階 B1 を「1階」へ変更 → 新しい1階の B1 が 0 になり、全階が同じ量だけずれる', () => {
  const planes = [P('B1', -1, 1, -3000), P('F1', 1, 1, 0), P('F2', 2, 1, 3000)];
  const updates = computeFloorChangeReorder(planes, 'B1', 1, { topHeightMm: 3000 });
  assert.deepEqual(startFloors(planes, updates), { B1: 1, F1: 2, F2: 3 });
  assert.deepEqual(elevations(planes, updates), { B1: 0, F1: 3000, F2: 6000 });
});

test('正規化: 地階だけの並び（startFloor===1 の階が無い）はずらさない', () => {
  const planes = [P('B3', -3, 1, -9000), P('B2', -2, 1, -6000), P('B1', -1, 1, -3000, { topStoryHeightMm: 3000 })];
  const after = planes.filter(p => p.id !== 'B2');
  const updates = computeFloorDeleteReorder(after, 1, { planesBefore: planes, topHeightMm: 3000 });
  assert.deepEqual(elevations(after, updates), { B3: -9000, B1: -6000 });
  assert.deepEqual(updates.map(u => u.id), ['B1']);
});

test('正規化: 地上だけの並びの中間削除はずらし量 0（更新一覧に余計な階を載せない）。直接呼んでも 0', () => {
  const planes = [P('F1', 1, 1, 0), P('F2', 2, 1, 3000), P('F3', 3, 1, 6000), P('F4', 4, 1, 9000)];
  const after = planes.filter(p => p.id !== 'F2');
  const updates = computeFloorDeleteReorder(after, 1, { planesBefore: planes, topHeightMm: 3000 });
  assert.deepEqual(updates.map(u => [u.id, u.elevation]), [['F3', 3000], ['F4', 6000]]);
  const own = [{ id: 'x', elevation: 5 }];
  assert.equal(normalizeFirstFloorZero([P('F1', 1, 1, 0)], own), 0);
  assert.deepEqual(own, [{ id: 'x', elevation: 5 }]);
});

test('正規化: 挿入・下階追加は 1階（startFloor===1）を動かさない経路なので正規化を通さない（1FL=0 が保たれている並びでずらし量 0）', () => {
  const planes = underFixture();
  const { newPlane, updates } = computeFloorInsert(planes, 'B1', 1, { topHeightMm: TOP });
  assert.equal(newPlane.elevation, -2800);
  assert.equal(elevations(planes, updates).F1, 0);
});

// ---- 壊れた階高（同じ elevation の階）----
test('【失敗系】壊れたデータ（同じ elevation の階が2つ）: 導いた階高 0 は 3000 に置き換え、新階が重ならない', () => {
  const planes = [P('F1', 1, 1, 0), P('F2', 2, 1, 0), P('F3', 3, 1, 3000, { topStoryHeightMm: 2900 })];
  const { newPlane } = computeFloorInsert(planes, 'F1', 1, { topHeightMm: 2900 });
  assert.equal(newPlane.elevation, 3000);
  assert.deepEqual(computeFloorAddLowerElevations(planes, 1, { topHeightMm: 2900 }), [-3000]);
});

// ---- Project を通す（旧データ legacy・検討案/屋根平面・undo/redo のメタ往復）----
function woodProject(withTopSetting = false) {
  const project = new Project('proj', 'wood');
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  project.addPlane(0, '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  const { plane } = project.addPlane(6000, '3階', 'p3', 3, 1);
  if (withTopSetting) plane.topStoryHeightMm = 2700;
  return project;
}

test('旧データ（topStoryHeightMm=0）の在来木造: 最上階は legacy 2900。中間へ動かすとその階の階高が 2900 になる', () => {
  const project = woodProject();
  assert.equal(resolveTopStoryHeightMm(project), 2900);
  const updates = computeFloorReorder(project.planes, 'p3', 1, { topHeightMm: resolveTopStoryHeightMm(project) });
  assert.deepEqual(elevations(project.planes, updates), { p1: 0, p3: 3000, p2: 5900 });
  assert.deepEqual(topWrites(updates), { p2: 3000 }); // 新しい最上階 p2 は自分の階高 3000
});

test('旧データの在来木造: 最上階を削除 → 新しい最上階に削除した階との差（3000）が書かれる', () => {
  const project = woodProject();
  const planes = project.planes;
  const updates = computeFloorDeleteReorder(planes.filter(p => p.id !== 'p3'), 2,
    { planesBefore: planes, topHeightMm: resolveTopStoryHeightMm(project) });
  assert.deepEqual(topWrites(updates), { p2: 3000 });
});

test('旧データの在来木造: 最上階の上へ挿入 → 直下階（p2＝3000）の階高を新階が継ぐ', () => {
  const project = woodProject();
  const { newPlane } = computeFloorInsert(project.planes, 'p3', 1, { topHeightMm: resolveTopStoryHeightMm(project) });
  assert.equal(newPlane.elevation, 9000);
  assert.equal(newPlane.topStoryHeightMm, 3000);
});

test('設定済みの最上階（2700）を中間へ → その階高は 2700', () => {
  const project = woodProject(true);
  const updates = computeFloorReorder(project.planes, 'p3', 1, { topHeightMm: resolveTopStoryHeightMm(project) });
  assert.equal(elevations(project.planes, updates).p2, 3000 + 2700);
});

test('検討案・屋根専用平面が混ざっても、それらの elevation は触らない（採用階だけが対象）', () => {
  const project = woodProject();
  project.addPlane(3000, '2階#a', 'alt', 2, 1, true, 'p2', 0);
  project.addPlane(6001, '小屋伏', 'roof', 3, 1, false, null, 0, true, 'p3');
  assert.deepEqual(project.planes.map(p => p.id), ['p1', 'p2', 'p3']);
  const updates = computeFloorReorder(project.planes, 'p3', 1, { topHeightMm: resolveTopStoryHeightMm(project) });
  assert.equal(updates.some(u => u.id === 'alt' || u.id === 'roof'), false);
  applyPlaneMetas(project, updates);
  assert.equal(project.planeMap.get('alt').elevation, 3000);
  assert.equal(project.planeMap.get('roof').elevation, 6001);
  assert.deepEqual(collectPlaneMetas(project).map(m => m.id), ['p1', 'p3', 'p2']);
});

test('undo/redo: 最上階の入れ替わりは collectPlaneMetas／applyPlaneMetas の往復で topStoryHeightMm ごと戻る・進む', () => {
  const project = woodProject(true);
  const metasBefore = collectPlaneMetas(project);
  const updates = computeFloorReorder(project.planes, 'p3', 1, { topHeightMm: resolveTopStoryHeightMm(project) });
  applyPlaneMetas(project, updates);
  const metasAfter = collectPlaneMetas(project);
  assert.equal(metasAfter.find(m => m.id === 'p2').topStoryHeightMm, 3000);
  assert.notDeepEqual(metasAfter, metasBefore);
  applyPlaneMetas(project, metasBefore);
  assert.deepEqual(collectPlaneMetas(project), metasBefore);
  applyPlaneMetas(project, metasAfter);
  assert.deepEqual(collectPlaneMetas(project), metasAfter);
});

test('undo/redo: 最上階の上への挿入は、新階の topStoryHeightMm が redo（追加階の作り直し）で保たれる', () => {
  const project = woodProject(true);
  const metasBefore = collectPlaneMetas(project);
  const { newPlane, updates } = computeFloorInsert(project.planes, 'p3', 1, { topHeightMm: resolveTopStoryHeightMm(project) });
  applyFloorInsert(project, updates, () => project.addPlane(newPlane.elevation, newPlane.name, 'new', newPlane.startFloor,
    newPlane.stories, false, null, 0, false, null, newPlane.planCutHeightMm, newPlane.ceilingCutHeightMm, newPlane.topStoryHeightMm));
  const metasAfter = collectPlaneMetas(project);
  const added = metasAfter.find(m => m.id === 'new');
  assert.equal(added.topStoryHeightMm, 3000);
  // undo: 追加階を削除してメタを戻す
  project.removePlane('new');
  applyPlaneMetas(project, metasBefore);
  assert.deepEqual(collectPlaneMetas(project), metasBefore);
  // redo: applyPlaneMetas（追加階はまだ無く飛ばされる）→ pl の値で作り直す
  applyPlaneMetas(project, metasAfter);
  project.addPlane(added.elevation, added.name, added.id, added.startFloor, added.stories, false, null, 0, false, null,
    added.planCutHeightMm, added.ceilingCutHeightMm, added.topStoryHeightMm);
  assert.deepEqual(collectPlaneMetas(project), metasAfter);
});
