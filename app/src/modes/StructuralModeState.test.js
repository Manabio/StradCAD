// modes/StructuralModeState.js の選択集合（selectedMemberIds。構造リスト→伏図ハイライト）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StructuralModeState } from './StructuralModeState.js';

test('selectMembers: id集合を Set で保持し、同内容の再設定では参照を変えない（observer の無駄な再描画を避ける）', () => {
  const s = new StructuralModeState(null);
  assert.equal(s.selectedMemberIds.size, 0);
  s.selectMembers(['a', 'b']);
  const first = s.selectedMemberIds;
  assert.deepEqual([...first].sort(), ['a', 'b']);
  s.selectMembers(['b', 'a']);
  assert.equal(s.selectedMemberIds, first, '同内容なら同じ Set 参照のまま');
  s.selectMembers(['a']);
  assert.notEqual(s.selectedMemberIds, first);
  assert.deepEqual([...s.selectedMemberIds], ['a']);
});

test('【失敗系】selectMembers: []・null・undefined は共有の空Setへ戻り、clearSelection でも空になる', () => {
  const s = new StructuralModeState(null);
  const empty = s.selectedMemberIds;
  s.selectMembers(['x']);
  s.selectMembers([]);
  assert.equal(s.selectedMemberIds, empty, '[] は共有の空Set');
  s.selectMembers(['x']);
  s.selectMembers(null);
  assert.equal(s.selectedMemberIds, empty, 'null は共有の空Set');
  s.selectMembers(['x']);
  s.selectMembers(undefined);
  assert.equal(s.selectedMemberIds, empty, 'undefined は共有の空Set');
  s.selectMembers(['y']);
  s.clearSelection();
  assert.equal(s.selectedMemberIds.size, 0);
});
