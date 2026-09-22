// core/room.js のステップ7b（内装マスターの読み出し口をregistry経由に）の単体テスト。
// overlay（setOverlay/clearOverlays）を触るテストは core/room.overlay.test.js に分ける
// （catalogRegistry.overlay.test.js の方針。node:test はファイル単位で別プロセスのため、
// overlay状態を汚染しないテストと分離する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Room } from './room.js';
import { DEFAULT_WALL_MATERIAL } from './constants.js';
import { INTERIOR_MASTERS } from '../finish/materials/interiorMasters.js';

// ---- (a) getFinishInfo()の戻り値形状は旧INTERIOR_MASTERS[key]直参照と完全に同型 ----
// （2026-09-23 QA指摘Major-1: INTERIOR_MASTERS.LIVING_ROOM は label:'居室' を持ち、旧実装の
// getFinishInfo()もlabelを返していた。key（loadBuiltin形式で付加される・旧実装には無い）だけを
// 除去し、labelは残す——deepStrictEqualで「旧直参照と完全に同じ形」であることを固定する。
test('getFinishInfo(): templateKeyをbuiltinのキーに設定すると、旧INTERIOR_MASTERS[key]直参照と完全に同型の戻り値になる（labelは含み・keyは含まない）', () => {
  const room = new Room('r1', '居間', new Set(), new Set(), undefined, 'LIVING_ROOM');
  const info = room.getFinishInfo();
  assert.deepStrictEqual(info, { ...INTERIOR_MASTERS.LIVING_ROOM }, '旧INTERIOR_MASTERS.LIVING_ROOM直参照と完全に同型でない');
  assert.equal('key' in info, false, 'getFinishInfo()の戻り値にkeyが含まれている（loadBuiltin形式の混入＝退行）');
  assert.equal('label' in info, true, 'getFinishInfo()の戻り値にlabelが含まれていない（旧実装もlabelを返していたはず）');
});

test('getFinishInfo(): templateKeyがnull（既定）ならwallMaterialが既定値にフォールバックする（従来どおり）', () => {
  const room = new Room('r1', '未指定', new Set(), new Set());
  const info = room.getFinishInfo();
  assert.equal('key' in info, false);
  assert.equal('label' in info, false); // templateKeyがnullなのでmasterは{}——labelを持つ余地がない
  assert.equal(info.wallMaterial, DEFAULT_WALL_MATERIAL);
});

test('getFinishInfo(): templateKeyが未登録キーなら{}扱い＋既定壁材フォールバックのみ（従来どおり）', () => {
  const room = new Room('r1', '未登録', new Set(), new Set(), undefined, 'NOT_A_REAL_KEY');
  const info = room.getFinishInfo();
  assert.deepEqual(info, { wallMaterial: DEFAULT_WALL_MATERIAL });
});

// ---- (d) setOverrideのfield in master判定はkey/label除去後でも現行どおり ----
test('setOverride: マスターと同値を指定するとcustomOverridesから削除される（key/label除去後も従来どおり判定できる）', () => {
  const room = new Room('r1', '居間', new Set(), new Set(), undefined, 'LIVING_ROOM');
  room.setOverride('wallMaterial', INTERIOR_MASTERS.LIVING_ROOM.wallMaterial);
  assert.equal(room.customOverrides.has('wallMaterial'), false, 'マスターと同値なのにoverrideが残っている');
});

test('setOverride: マスターと異なる値を指定するとcustomOverridesに積まれ、getFinishInfo()に反映される', () => {
  const room = new Room('r1', '居間', new Set(), new Set(), undefined, 'LIVING_ROOM');
  room.setOverride('wallMaterial', '999999999999');
  assert.equal(room.customOverrides.get('wallMaterial'), '999999999999');
  assert.equal(room.getFinishInfo().wallMaterial, '999999999999');
});

// 2026-09-23 QA指摘Major-1: labelはmasterに存在するフィールド（field in master === true）なので、
// masterと同値のlabelを指定してもoverrideは積まれない（旧INTERIOR_MASTERS[key]直参照と同じ挙動）。
test('setOverride: labelはmasterのフィールドである（field in master === true）ため、masterと同値のlabelを指定してもoverrideは積まれない（旧挙動どおり）', () => {
  const room = new Room('r1', '居間', new Set(), new Set(), undefined, 'LIVING_ROOM');
  room.setOverride('label', INTERIOR_MASTERS.LIVING_ROOM.label); // '居室' と同値
  assert.equal(room.customOverrides.has('label'), false, 'labelはmasterに存在するフィールドなので同値指定でoverrideは積まれないはず（旧挙動）');
});

test('setOverride: masterと異なるlabelを指定すればcustomOverridesに積まれ、getFinishInfo()に反映される', () => {
  const room = new Room('r1', '居間', new Set(), new Set(), undefined, 'LIVING_ROOM');
  room.setOverride('label', '別名の居室');
  assert.equal(room.customOverrides.get('label'), '別名の居室');
  assert.equal(room.getFinishInfo().label, '別名の居室');
});

// keyはmasterから除去されている（field in master === false）ため、キーを指定すると
// 常にoverride扱いになる（labelとの対比で境界ケースを固定する）。
test('setOverride: keyはmasterのフィールドではない（field in master === false）ため、keyを指定すると常にoverride扱いになる（境界ケース）', () => {
  const room = new Room('r1', '居間', new Set(), new Set(), undefined, 'LIVING_ROOM');
  room.setOverride('key', 'LIVING_ROOM'); // masterからkeyが除去されているため 'key' in master は false
  assert.equal(room.customOverrides.get('key'), 'LIVING_ROOM');
});

// ---- (c) 不変条件（wiring）: templateKeyがnullならcomposeCatalogを呼ばない短絡が_master()の先頭にある ----
// ESM静的importのcomposeCatalogを実行時にスパイできないため（named importのbindingは
// 呼び出し側から差し替え不可）、catalogRegistryWiring.test.jsと同型のソーステキスト検査で
// 固定する——短絡を外す変異（テストの変異記録参照）でこのテストが赤くなることを確認済み。
test('【不変条件・ステップ7b】core/room.js _master(): `if (!this.templateKey) return {}` の短絡がcomposeCatalog呼び出しより前にある', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, 'room.js'), 'utf8');
  const bodyMatch = /_master\(\)\s*\{([\s\S]*?)\n {2}\}/.exec(src);
  assert.ok(bodyMatch, '_master()の本体がソースから見つからない');
  const body = bodyMatch[1];
  const guardIdx = body.indexOf('if (!this.templateKey) return {};');
  const composeIdx = body.indexOf('composeCatalog(');
  assert.ok(guardIdx >= 0, '短絡 `if (!this.templateKey) return {};` が_master()に無い（ホットパス退行）');
  assert.ok(composeIdx >= 0, '_master()がcomposeCatalogを呼んでいない');
  assert.ok(guardIdx < composeIdx, '短絡がcomposeCatalog呼び出しより後ろにある（templateKeyがnullでもregistryに触れてしまう）');
});
