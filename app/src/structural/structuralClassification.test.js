// structuralClassification.js memberKindOf の単体テスト（ステップC2a: 小屋梁 role:'roofBeam' は表A対象外）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberKindOf, MEMBER_KIND, STRUCTURES, structureHasMemberKind } from './structuralClassification.js';

test('【C2a】memberKindOf: 小屋梁(roofBeam)・軒桁(eaves)・屋根架構(roof)は表A対象外(null)＝ゲートしない', () => {
  for (const role of ['roofBeam', 'eaves', 'roof']) {
    assert.equal(memberKindOf('beamMap', { role }), null, `role:${role}`);
  }
});

test('【C2a】memberKindOf: 既存の梁roleの分類は不変（基礎梁=FOUNDATION_BEAM、それ以外=BEAM）', () => {
  assert.equal(memberKindOf('beamMap', { role: 'foundation' }), MEMBER_KIND.FOUNDATION_BEAM);
  for (const role of ['primary', 'secondary', 'floor', 'landing', 'sill']) {
    assert.equal(memberKindOf('beamMap', { role }), MEMBER_KIND.BEAM, `role:${role}`);
  }
});

test('【C2a】失敗系: 表Aで梁が×の主構造（RC造(壁式)・木造2×4）でも、小屋梁は null のため構造ゲートの削除対象にならない（secondaryは×で削除対象）', () => {
  const noBeam = STRUCTURES.filter(s => !structureHasMemberKind(MEMBER_KIND.BEAM, s));
  assert.ok(noBeam.length > 0, '梁が×の主構造が表Aに存在する（このテストの前提）');
  for (const s of noBeam) {
    assert.equal(structureHasMemberKind(memberKindOf('beamMap', { role: 'secondary' }), s), false, `${s}: 小梁は×`);
    // null（表外）は呼び出し側（deleteClassificationOverflow）が「!kind なら保持」で扱う
    assert.equal(memberKindOf('beamMap', { role: 'roofBeam' }), null);
  }
});
