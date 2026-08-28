import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observable, configure, autorun, runInAction } from 'mobx';
import {
  renumberMembers, collectFloorGroups, assignNumbers, applyNumbers, floorRankOf, previewSplitTag,
} from './memberNumbering.js';
import {
  splitGroup, releaseFromGroup, mergeGroups, conformToLedger,
  getGroupSpec, getGroupJoin, getGroupManualTag, setGroupManualTag, clearGroupManualTag,
  getMergedInto, snapshotLedger, restoreLedger,
} from './memberGroups.js';
import { memberSymbol, memberSignature, memberSizeKey } from './memberCatalog.js';
import { makeColumn, makeBeam, makeGraph, makeProject } from './memberTestFixtures.js';

// ---- splitGroup → 再採番の番号遷移（Phase B スモークの移植）----
test('splitGroup: 分割→再採番で対象が新gid・新番号になり、グループに戻すと自動署名に戻る', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const columns = [makeColumn('c1', 'RC-300x300'), makeColumn('c2', 'RC-300x300'), makeColumn('c3', 'RC-300x300')];
  const g = makeGraph('p1', { columnMap: columns });

  renumberMembers(g, project, 'columnMap');
  assert.deepEqual(columns.map(c => c.memberNo), ['C1', 'C1', 'C1']);

  const target = columns[0];
  target.setField('sectionDefId', 'RC-ROUND350'); // 350角相当（300角より大きい）
  const gid = splitGroup(project, 'columnMap', [target]);
  assert.match(gid, /^[A-Za-z]+#\d+$/);
  assert.equal(target.numberGroupId, gid);
  assert.ok(getGroupSpec(project.memberGroupLedger, gid)?.includes('sectionDefId=RC-ROUND350'));
  assert.equal(typeof getGroupJoin(project.memberGroupLedger, gid), 'string');

  renumberMembers(g, project, 'columnMap');
  assert.equal(target.memberNo, 'C1', '大きい断面が若番のはず');
  assert.deepEqual([columns[1].memberNo, columns[2].memberNo], ['C2', 'C2']);

  releaseFromGroup([target]);
  assert.equal(target.numberGroupId, null);
  renumberMembers(g, project, 'columnMap');
  assert.ok(getGroupSpec(project.memberGroupLedger, gid) != null, 'グループに戻した後も台帳のgrp.specは残置される');
  assert.notEqual(target.memberNo, columns[1].memberNo, '材寸が異なるため別タグのまま');
});

test('previewSplitTag: dry-runの予定タグが実際の分割結果と一致する', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const cols = [makeColumn('d1', 'RC-300x300'), makeColumn('d2', 'RC-300x300'), makeColumn('d3', 'RC-300x300')];
  const g = makeGraph('p1', { columnMap: cols });
  renumberMembers(g, project, 'columnMap');

  const target = cols[0];
  target.setField('sectionDefId', 'RC-ROUND350'); // 編集後の値（まだsplit/renumberは呼ばない）
  const remainderGroupKey = memberSignature(cols[1], 'columnMap');
  const floorInfo = floorRankOf(g.plane, project);
  const preview = previewSplitTag(
    project, 'columnMap', memberSymbol(target, 'columnMap'),
    memberSizeKey(target, 'columnMap'), memberSignature(target, 'columnMap'),
    floorInfo, { remainderGroupKey, removeFromRemainder: false },
  );
  assert.equal(preview, 'C1');

  splitGroup(project, 'columnMap', [target]);
  renumberMembers(g, project, 'columnMap');
  assert.equal(target.memberNo, preview);
});

// ---- mergeGroups → 再採番の番号遷移（Phase C スモークの移植）----
test('mergeGroups: 複数グループが統合先の材寸へ揃い1つのタグになる', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const g1 = [makeBeam('b1', 'STEEL-H500x200'), makeBeam('b2', 'STEEL-H500x200')]; // 大
  const g2 = [makeBeam('b3', 'STEEL-H400x200')]; // 中
  const g3 = [makeBeam('b4', 'STEEL-H350x175'), makeBeam('b5', 'STEEL-H350x175'), makeBeam('b6', 'STEEL-H350x175')]; // 小
  const all = [...g1, ...g2, ...g3];
  const g = makeGraph('p1', { beamMap: all });

  renumberMembers(g, project, 'beamMap');
  assert.equal(new Set(all.map(b => b.memberNo)).size, 3);

  const gid = mergeGroups(project, 'beamMap', [{ members: g1 }, { members: g2 }, { members: g3 }], 0);
  assert.equal(typeof gid, 'string');
  assert.ok(all.every(b => b.numberGroupId === gid));
  assert.ok(all.every(b => b.sectionDefId === 'STEEL-H500x200'));

  project.memberNumberIndex.clear(); // モード境界相当（実アプリはreflectStructuralToOtherFloorsが毎回clearする）
  renumberMembers(g, project, 'beamMap');
  assert.equal(new Set(all.map(b => b.memberNo)).size, 1);
  assert.equal(all[0].memberNo, 'G1');
});

test('mergeGroups: 他階に残る旧gid部材が grp.mergedInto 経由で次のconformで統合先へ転送される', () => {
  const project = makeProject([{ id: 'pA', startFloor: 1 }, { id: 'pB', startFloor: 2 }]);
  const aBig = [makeBeam('a1', 'STEEL-H500x200'), makeBeam('a2', 'STEEL-H500x200')];
  const aSmall = [makeBeam('a3', 'STEEL-H350x175')];
  const gA = makeGraph('pA', { beamMap: [...aBig, ...aSmall] });
  renumberMembers(gA, project, 'beamMap');
  const smallGid = splitGroup(project, 'beamMap', aSmall); // 他階に残る旧gidを用意
  renumberMembers(gA, project, 'beamMap');

  const bFar = makeBeam('b-far', 'STEEL-H350x175', { numberGroupId: smallGid });
  const gB = makeGraph('pB', { beamMap: [bFar] });

  const gid = mergeGroups(project, 'beamMap', [{ members: aBig }, { members: aSmall }], 0);
  assert.notEqual(gid, smallGid);
  assert.equal(getMergedInto(project.memberGroupLedger, smallGid), gid);
  assert.equal(bFar.numberGroupId, smallGid, '2階の部材はまだ旧gidのまま（未conform）');

  conformToLedger(gB, project); // 次のモード境界を模す
  assert.equal(bFar.numberGroupId, gid, '統合先gidへ転送される');
  assert.equal(bFar.sectionDefId, 'STEEL-H500x200', '採用specへconformされる');

  collectFloorGroups(gA, project);
  collectFloorGroups(gB, project);
  const tags = assignNumbers(project);
  applyNumbers(gA, project, tags);
  applyNumbers(gB, project, tags);
  assert.equal(bFar.memberNo, aBig[0].memberNo, '1階の統合後グループと2階の吸収部材が同一タグになる');
});

// ---- QA6: 材料違いのグループは統合されない（防御）----
test('mergeGroups: 記号・材料が採用グループと異なるグループは無視される', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const rcBeam = makeBeam('rc1', 'RC-300x300', { materialType: 'RC' });
  const steelBeam = makeBeam('s1', 'STEEL-H500x200', { materialType: 'STEEL' });
  const g = makeGraph('p1', { beamMap: [rcBeam, steelBeam] });
  renumberMembers(g, project, 'beamMap');
  const rcTagBefore = rcBeam.memberNo;

  const gid = mergeGroups(project, 'beamMap', [{ members: [steelBeam] }, { members: [rcBeam] }], 0);
  assert.equal(typeof gid, 'string');
  assert.equal(steelBeam.numberGroupId, gid);
  assert.equal(rcBeam.numberGroupId, null, '材料違いのグループは統合対象から無視されnumberGroupIdも変化しない');
  assert.equal(rcBeam.materialType, 'RC', '材寸も変化しない');
  renumberMembers(g, project, 'beamMap');
  assert.equal(rcBeam.memberNo, rcTagBefore, '無視されたグループのタグは統合の影響を受けない');
});

// ---- QA7: 統合で吸収された側の grp.no（手動タグ）が孤児化しない ----
test('mergeGroups: 吸収された側の手動タグ(grp.no)は破棄される', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const chosen = [makeBeam('c1', 'STEEL-H500x200')];
  const absorbed = [makeBeam('a1', 'STEEL-H350x175')];
  const g = makeGraph('p1', { beamMap: [...chosen, ...absorbed] });
  renumberMembers(g, project, 'beamMap');

  const absorbedGid = splitGroup(project, 'beamMap', absorbed);
  setGroupManualTag(project.memberGroupLedger, absorbedGid, 'X-99');
  assert.equal(getGroupManualTag(project.memberGroupLedger, absorbedGid), 'X-99');

  mergeGroups(project, 'beamMap', [{ members: chosen }, { members: absorbed }], 0);

  assert.equal(getGroupManualTag(project.memberGroupLedger, absorbedGid), null, '吸収側のgrp.noは削除される');
});

// ---- QA8: 分割/統合Undoの軽量台帳スナップショット（snapshotLedger/restoreLedger）の等価性 ----
test('snapshotLedger/restoreLedger: 台帳の内容をUndoで正確に往復できる（restoreGraphとの順序に依存しない）', () => {
  const project = { memberGroupLedger: observable.map() }; // .replace() を使うため実際のMobX ObservableMapで検証する
  project.memberGroupLedger.set('grp.spec:C#1', 'sectionDefId=RC-300x300');
  project.memberGroupLedger.set('grp.join:C#1', 'columnMap|C|RC|sectionDefId=RC-300x300');

  const before = snapshotLedger(project);

  // 分割操作相当の変更（新規gid追加）
  project.memberGroupLedger.set('grp.spec:C#2', 'sectionDefId=RC-400x400');
  project.memberGroupLedger.set('grp.no:C#2', 'X-99');
  const after = snapshotLedger(project);
  assert.equal(project.memberGroupLedger.size, 4);

  // Undo（before側へ復元）: restoreGraph の前後どちらで呼んでも結果は同じ（CL参照を持たないため）。
  restoreLedger(project, before);
  assert.equal(project.memberGroupLedger.size, 2);
  assert.equal(project.memberGroupLedger.get('grp.spec:C#1'), 'sectionDefId=RC-300x300');
  assert.equal(project.memberGroupLedger.has('grp.spec:C#2'), false, '復元後は分割操作で追加したキーが消えている');

  // Redo（after側へ復元）
  restoreLedger(project, after);
  assert.equal(project.memberGroupLedger.size, 4);
  assert.equal(project.memberGroupLedger.get('grp.no:C#2'), 'X-99');
});

// ---- 手動番号のグループ格上げ（Phase D スモークの移植）----
test('手動タグ(grp.no)のmaterialize→適用→削除で導出タグへ戻る。applyNumbersのrenumberedは初回採番を含まない', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const columns = [makeColumn('c1', 'RC-300x300'), makeColumn('c2', 'RC-300x300')];
  const g = makeGraph('p1', { columnMap: columns });

  renumberMembers(g, project, 'columnMap');
  assert.equal(columns[0].memberNo, 'C1');

  let gid = columns[0].numberGroupId;
  if (!gid) gid = splitGroup(project, 'columnMap', columns);
  setGroupManualTag(project.memberGroupLedger, gid, 'X-99');
  renumberMembers(g, project, 'columnMap');
  assert.deepEqual(columns.map(c => c.memberNo), ['X-99', 'X-99']);
  assert.equal(getGroupManualTag(project.memberGroupLedger, gid), 'X-99');

  clearGroupManualTag(project.memberGroupLedger, gid);
  project.memberNumberIndex.clear();
  renumberMembers(g, project, 'columnMap');
  assert.equal(columns[0].memberNo, 'C1', 'grp.no削除後は導出タグへ戻る');
  assert.equal(columns[0].numberGroupId, gid, 'numberGroupIdはmaterialize済みのまま（グループに戻すとは別操作）');

  // applyNumbers の renumbered: 初回採番(null→タグ)は含まず、既存タグの変化だけを拾う
  const d = [makeColumn('d1', 'RC-300x300'), makeColumn('d2', 'RC-ROUND350')];
  const g2 = makeGraph('p1', { columnMap: d });
  const project2 = makeProject([{ id: 'p1', startFloor: 1 }]);
  collectFloorGroups(g2, project2);
  const result1 = applyNumbers(g2, project2, assignNumbers(project2), 'columnMap');
  assert.deepEqual(result1.renumbered, [], '初回採番はrenumberedを含まない');
  assert.equal(result1.changed, true);

  d[0].sectionDefId = 'RC-ROUND350';
  d[0].mainBars = { count: 8, size: 'D25' };
  project2.memberNumberIndex.clear();
  collectFloorGroups(g2, project2);
  const result2 = applyNumbers(g2, project2, assignNumbers(project2), 'columnMap');
  assert.ok(result2.renumbered.length > 0, '既存タグが変わった部材がrenumberedに載る');
  assert.ok(result2.renumbered.every(r => r.from && r.to && r.from !== r.to));
});

// ---- バグ調査（「最初の小梁に採番されない」）の副産物: MemberListTab.jsx の手動追加/分割/統合/手動タグの
// 各ハンドラは project.memberNumberIndex（observable.map・deep）を書き換えるが runInAction に包まれて
// いなかった。MemberListTab は observer コンポーネントで memberNumberIndex を能動的に観測しているため、
// enforceActions:'observed'（MobXの既定）のもとで「アクション外での変更」警告が発生する
// （MobX既定はwarnのみで例外は投げないため、採番結果自体は壊れないことを確認済み——バグ本体の再現には
// 至らなかったが、横断チェックで見つけた実在の不整合として runInAction を追加した。MemberListTab.jsx
// 各ハンドラ参照）。runInAction で包めば警告が出ないことを回帰確認する。
test('renumberMembers: observer監視下でも runInAction 越しならMobX強制モード違反を出さない', () => {
  configure({ enforceActions: 'observed' });
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  project.memberNumberIndex = observable.map(); // 実際の Project.memberNumberIndex と同じ deep observable.map()
  project.memberGroupLedger = observable.map();

  const beams = [makeBeam('e1', 'STEEL-H400x200'), makeBeam('e2', 'STEEL-H400x200')];
  const g = makeGraph('p1', { beamMap: beams });

  // MemberListTab.jsx のカード表示が project.memberNumberIndex の各グループを能動的に読み続ける状態を模す。
  const dispose = autorun(() => {
    for (const [, group] of project.memberNumberIndex) {
      void group.mapName; void group.symbol; void [...group.floorRanks]; void group.hasRoof; void [...group.counts.values()];
    }
  });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    // 修正前の MemberListTab.jsx ハンドラと同じ形（runInActionなし）で呼ぶと警告が出ることを確認する
    // （このケース自体は別グループ・別呼び出しにして、後続の「包んだ」ケースの検証に影響させない）。
    const strayBeam = makeBeam('e-stray', 'RC-300x300', { materialType: 'RC' }); // 別記号グループ(C系ではないが材料違いで別グループになる梁)
    g.beamMap.set(strayBeam.id, strayBeam);
    renumberMembers(g, project, 'beamMap'); // 意図的にrunInActionへ包まない（修正前の再現）
    assert.ok(
      warnings.some(w => w.includes('[MobX]')),
      'runInActionに包まないとobserver監視下でMobX強制モード違反の警告が出るはず（修正の必要性を裏付ける）',
    );
    warnings.length = 0;

    // NewSpanMemberSelector.handleAdd 等と同じ形（新規部材追加 → renumberMembers）を runInAction で包む。
    const beam3 = makeBeam('e3', 'STEEL-H400x200');
    g.beamMap.set(beam3.id, beam3);
    runInAction(() => renumberMembers(g, project, 'beamMap'));
  } finally {
    console.warn = originalWarn;
    dispose();
  }

  const mobxWarnings = warnings.filter(w => w.includes('[MobX]'));
  assert.deepEqual(mobxWarnings, [], 'runInActionで包めばobserver監視下でも強制モード違反が出ないはず');
  assert.equal(beams[0].memberNo, 'G1');
  assert.equal(g.beamMap.get('e3').memberNo, 'G1', '新規追加分も同じグループとして即座に採番される');
});

// ---- 【回帰点】署名フィールド以外での分割（実機報告: 分割しても新しい番号のカードが現れない） ----
// SIGNATURE_FIELDS_BY_MAP に含まれないフィールド（梁の接合方法 jointType・天端レベル等）を編集して
// 分割すると、新グループの署名は分割元と同一になる。このとき grp.join を書くと、直後の
// conformToLedger（renumberMembers の第1パス）が「gid未設定かつ同署名」の残り部材を新gidへ吸収し、
// 分割が即座に元へ戻る＝一覧に新カードが出ず「（予定）」表示だけが残る。
test('splitGroup: 署名に含まれないフィールドでの分割は grp.join を書かず、残り部材を吸収し返さない', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const beams = [makeBeam('b1', 'STEEL-H200x100'), makeBeam('b2', 'STEEL-H200x100'), makeBeam('b3', 'STEEL-H200x100')];
  for (const b of beams) b.jointType = 'RIGID';
  const g = makeGraph('p1', { beamMap: beams });

  renumberMembers(g, project, 'beamMap');
  assert.deepEqual(beams.map(b => b.memberNo), ['G1', 'G1', 'G1'], '同材寸なので全て同じ番号');

  const target = beams[0];
  const splitFromSignature = memberSignature(target, 'beamMap');
  target.setField('jointType', 'PIN'); // 署名フィールドではない＝署名は変わらない
  assert.equal(memberSignature(target, 'beamMap'), splitFromSignature, '前提: この編集では署名が変わらない');

  const gid = splitGroup(project, 'beamMap', [target], { splitFromSignature });
  assert.equal(getGroupJoin(project.memberGroupLedger, gid), null, '同署名の分割では grp.join を書かない');

  renumberMembers(g, project, 'beamMap');
  assert.equal(beams[1].numberGroupId, null, '残り部材が新gidへ吸収されていないこと');
  assert.equal(beams[2].numberGroupId, null);
  assert.equal(target.numberGroupId, gid);
  assert.notEqual(target.memberNo, beams[1].memberNo, '分割後は別の番号になる（＝一覧に新カードが出る）');
  assert.equal(beams[1].memberNo, beams[2].memberNo, '残り2本は同じ番号のまま');
});

// splitFromSignature 省略（手動採番からの materialize 等、編集を伴わない呼び出し）と、
// 署名が実際に変わる分割は従来どおり grp.join を書く（他階の同材寸を吸収する経路を保つ）。
test('splitGroup: 署名が変わる分割・splitFromSignature省略時は従来どおり grp.join を書く', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const beams = [makeBeam('b1', 'STEEL-H200x100'), makeBeam('b2', 'STEEL-H200x100')];
  const g = makeGraph('p1', { beamMap: beams });
  renumberMembers(g, project, 'beamMap');

  const target = beams[0];
  const splitFromSignature = memberSignature(target, 'beamMap');
  target.setField('sectionDefId', 'STEEL-H300x150'); // 署名フィールド
  const gid = splitGroup(project, 'beamMap', [target], { splitFromSignature });
  assert.equal(typeof getGroupJoin(project.memberGroupLedger, gid), 'string');

  const gid2 = splitGroup(project, 'beamMap', [beams[1]]); // splitFromSignature 省略
  assert.equal(typeof getGroupJoin(project.memberGroupLedger, gid2), 'string');
});
