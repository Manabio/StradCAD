import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materialThickness } from './edgeComposition.js';
import { MATERIALS } from './materials/materialData.js';
import { RC_WALL_BACKING_CODES } from './materials/backingClass.js';

function findMaterial(code) {
  return MATERIALS.find(m => m.code === code);
}

// ---- QA blocker回帰: RC壁下地3件が厚み0にならないこと ----
// 修正前は BACKING カテゴリを一律 Math.max(x,y) で評価しており、RC壁下地（x:0,y:0,thickness:150/180/200）
// が厚み0になっていた。連鎖: wallBase=0 → backingDepth=0 → backingRange=null →
// isBackingOwnerWall false → collectWallBeamSources 条件(a) が1本も収集しない。
test('materialThickness: RC壁下地3件はそれぞれ thickness(150/180/200) を返す（0にならない）', () => {
  const [t150, t180, t200] = RC_WALL_BACKING_CODES.map(findMaterial);
  assert.equal(materialThickness(t150), 150);
  assert.equal(materialThickness(t180), 180);
  assert.equal(materialThickness(t200), 200);
});

// ---- 既存挙動の回帰固定: 木・鋼下地はx/yの大きい方のまま ----
test('materialThickness: 既存の木・鋼下地（thickness:null）は従来どおり断面の大きい辺を返す（回帰固定）', () => {
  const stud = findMaterial('111111111157'); // □-60×45
  assert.equal(stud.thickness, null, '既存下地材はthickness:nullであることが前提');
  assert.equal(materialThickness(stud), 60);
});
