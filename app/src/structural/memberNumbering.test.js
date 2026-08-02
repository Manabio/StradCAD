import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectFloorGroups, assignNumbers, applyNumbers, floorSpanLabel, renumberMembers } from './memberNumbering.js';
import { splitGroup, setGroupManualTag } from './memberGroups.js';
import { makeWall, makeGraph, makeProject } from './memberTestFixtures.js';

// ---- QA1: collectFloorGroups は既存エントリを更新・除去する（材寸編集で旧グループが消える）----
test('collectFloorGroups: 材寸編集後は旧グループが幽霊として残らない', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const w1 = makeWall('w1', 200), w2 = makeWall('w2', 200);
  const g = makeGraph('p1', { wallMap: [w1, w2] });

  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));
  assert.equal(w1.memberNo, 'W1');

  // 「全体」スコープの材寸編集（150厚へ）。MemberListTab は renumberMembers を呼ぶ（index はclearされない）。
  w1.thickness = 150; w2.thickness = 150;
  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));

  assert.equal(project.memberNumberIndex.size, 1, '建物に壁グループは1つだけのはず');
  assert.equal(w1.memberNo, 'W1', '唯一のグループなのでW1のまま');
});

// ---- 再発防止（「最初の小梁に採番されない」実機バグ）: project.memberNumberIndex は deep な
// observable.map()（core.js）のため、set() に渡した plain object はMobXが別のobservableオブジェクトへ
// 深変換して格納する（値渡しではなく複製＝split-brain）。collectFloorGroups が新規グループ作成直後に
// 格納実体へ差し替えず元のplain objectを変異していた版では、その階に1本しかない新規グループ
// （＝touchedGroups経由で複数回触られる機会が無い）は格納側countsが空のまま残り、collect末尾の
// ゴースト掃除（counts.size===0）で直後に削除されassignNumbersに現れずmemberNoがnullのままになる。
// plain Map（旧フィクスチャ）では深変換が起きずこのバグを検出できない——本テストは実MobXの
// observable.map()（makeProjectが返す）を使うことで初めて検出できる（修正前は本テストがfailすることを
// 確認してから修正を適用した）。
test('collectFloorGroups: その階に1本だけの新規グループ（例：初めての小梁）でも採番される', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const solo = makeWall('solo', 123); // 建物全体でこの階・このグループにしか存在しない1本
  const g = makeGraph('p1', { wallMap: [solo] });

  collectFloorGroups(g, project);
  const tags = assignNumbers(project);
  applyNumbers(g, project, tags);

  assert.equal(project.memberNumberIndex.size, 1, '1本しかなくてもゴースト掃除で消えてはいけない');
  assert.equal(solo.memberNo, 'W1', '唯一の新規グループが番号を得るはず（修正前はnullのまま）');
});

// ---- QA2: gid付きグループ（分割・統合済み）の材寸編集で sizeKey が更新される ----
test('collectFloorGroups: gid付きグループの sizeKey は編集後に更新される', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const a = makeWall('a', 100, { numberGroupId: 'W#1' }); // 分割済みグループ
  const b = makeWall('b', 200); // 自動グループ
  const g = makeGraph('p1', { wallMap: [a, b] });

  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));
  assert.equal(b.memberNo, 'W1', '200厚が若番のはず');
  assert.equal(a.memberNo, 'W2', '100厚(分割済)は後のはず');

  a.thickness = 300; // 分割済みグループを一番厚くする
  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));
  assert.equal(a.memberNo, 'W1', '300厚になった分割済グループが若番になるはず');
  assert.equal(b.memberNo, 'W2');
});

// ---- QA3: 部材を全削除した階の痕跡（floorRanks / counts）が取り消される ----
test('collectFloorGroups: 部材を全削除すると階の痕跡が取り消される', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }, { id: 'p2', startFloor: 2 }]);
  const g1 = makeGraph('p1', { wallMap: [makeWall('a', 200)] });
  const g2 = makeGraph('p2', { wallMap: [makeWall('b', 200)] });
  collectFloorGroups(g1, project);
  collectFloorGroups(g2, project);

  const key = [...project.memberNumberIndex.keys()][0];
  assert.deepEqual([...project.memberNumberIndex.get(key).floorRanks].sort(), [0, 1]);

  g2.wallMap.clear(); // 2階の壁を全削除
  collectFloorGroups(g2, project);

  assert.deepEqual([...project.memberNumberIndex.get(key).floorRanks], [0], '出現階は1Fのみのはず');
  assert.equal(project.memberNumberIndex.get(key).counts.get('p2') ?? 0, 0, '2階の本数は0または未計上のはず');
});

// ---- QA4/QA5: 階削除直後（project.planes が縮んだが index はまだ古いrankを保持）でも例外を投げない ----
test('floorSpanLabel / assignNumbers: planes より大きい rank（階削除直後の孤児）で例外を投げない', () => {
  const grp = {
    mapName: 'columnMap', symbol: 'C', sizeKey: [9, 0], signature: 'sig-a',
    floorRanks: new Set([1, 2]), hasRoof: false, counts: new Map([['p2', 3], ['p3', 3]]),
  };
  const grpB = {
    mapName: 'columnMap', symbol: 'C', sizeKey: [4, 0], signature: 'sig-b',
    floorRanks: new Set([0]), hasRoof: false, counts: new Map([['p1', 3]]),
  };
  // 3階建て→3階を削除した直後（planesは2件だが、indexはrank2を保持したまま）。
  const planes = [{ id: 'p1', startFloor: 1 }, { id: 'p2', startFloor: 2 }];
  const project = { memberNumberIndex: new Map([['a', grp], ['b', grpB]]), memberGroupLedger: new Map(), planes };

  assert.doesNotThrow(() => floorSpanLabel(grp, project));
  assert.doesNotThrow(() => assignNumbers(project));

  const label = floorSpanLabel(grp, project);
  assert.match(label, /F・計6本$/); // rank2は無視され、有効なrank1(2F)のみで組み立てられる
});

// ---- ported from smoke-assignNumbers.mjs: 採番規則（sizeKey降順・階プレフィックス・タイブレーク） ----
test('assignNumbers: sizeKey降順・階プレフィックス・タイブレークの規則', () => {
  function group(mapName, symbol, sizeKey, signature, floorRanksArr, hasRoof = false) {
    return { mapName, symbol, sizeKey, signature, floorRanks: new Set(floorRanksArr), hasRoof, counts: new Map() };
  }
  function withGroups(entries, planes) {
    const project = { memberNumberIndex: new Map(entries), memberGroupLedger: new Map(), planes };
    return assignNumbers(project);
  }

  // 柱1F(600角)・2~3F(500角)、梁は全階同一→プレフィックスなし
  {
    const planes = [{ startFloor: 1 }, { startFloor: 2 }, { startFloor: 3 }];
    const tags = withGroups([
      ['col600', group('columnMap', 'C', [360000, 0], 'sig-col-600', [0])],
      ['col500', group('columnMap', 'C', [250000, 0], 'sig-col-500', [1, 2])],
      ['beamG', group('beamMap', 'G', [500, 200, 0], 'sig-beam-g', [0, 1, 2])],
    ], planes);
    assert.equal(tags.get('col600'), '1C1');
    assert.equal(tags.get('col500'), '2~3C2');
    assert.equal(tags.get('beamG'), 'G1');
  }

  // 非連続階表記 + 同記号内で出現階が異なれば両方にプレフィックス
  {
    const planes = [{ startFloor: 1 }, { startFloor: 2 }, { startFloor: 3 }];
    const tags = withGroups([
      ['wA', group('wallMap', 'W', [200, 0], 'sig-w-a', [0, 2])],
      ['wB', group('wallMap', 'W', [150, 0], 'sig-w-b', [1])],
    ], planes);
    assert.equal(tags.get('wA'), '1,3W1');
    assert.equal(tags.get('wB'), '2W2');
  }

  // 屋根専用平面のみ・単一グループ→プレフィックスなし／屋根と実体階の混在→両方にプレフィックス
  {
    const planes = [{ startFloor: 1 }];
    const tagsSolo = withGroups([['rf1', group('beamMap', 'RF', [150, 45, 0], 'sig-rf', [], true)]], planes);
    assert.equal(tagsSolo.get('rf1'), 'RF1');

    const tagsMixed = withGroups([
      ['gRoof', group('beamMap', 'G', [150, 45, 0], 'sig-g-roof', [], true)],
      ['gFloor', group('beamMap', 'G', [120, 45, 0], 'sig-g-floor', [0])],
    ], planes);
    assert.equal(tagsMixed.get('gRoof'), 'RG1');
    assert.equal(tagsMixed.get('gFloor'), '1G2');
  }

  // 最終同着はsignatureの辞書順でタイブレーク
  {
    const planes = [{ startFloor: 1 }];
    const tags = withGroups([
      ['b', group('slabMap', 'S', [150, 0], 'sig-b', [0])],
      ['a', group('slabMap', 'S', [150, 0], 'sig-a', [0])],
    ], planes);
    assert.equal(tags.get('a'), 'S1');
    assert.equal(tags.get('b'), 'S2');
  }

  // 連続階表記
  {
    const planes = [{ startFloor: 1 }, { startFloor: 2 }, { startFloor: 3 }, { startFloor: 4 }];
    const tags = withGroups([
      ['c1', group('columnMap', 'C', [400000, 0], 'sig-c1', [0])],
      ['c2', group('columnMap', 'C', [300000, 0], 'sig-c2', [1, 2, 3])],
    ], planes);
    assert.equal(tags.get('c1'), '1C1');
    assert.equal(tags.get('c2'), '2~4C2');
  }
});

// ---- nit9: 手動タグのグループがあっても自動グループの番号に欠番ができない ----
test('assignNumbers: 手動タグのグループを挟んでも自動グループの番号は連番のまま', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const big = makeWall('big', 300), mid = makeWall('mid', 200), small = makeWall('small', 100);
  const g = makeGraph('p1', { wallMap: [big, mid, small] });
  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));
  assert.equal(big.memberNo, 'W1');
  assert.equal(mid.memberNo, 'W2');
  assert.equal(small.memberNo, 'W3');

  // 中間（2番目=mid）に手動タグを打つ（グループをmaterializeしてgrp.noを書く、実UIの流れと同じ）
  const gid = splitGroup(project, 'wallMap', [mid]);
  setGroupManualTag(project.memberGroupLedger, gid, 'W-CUSTOM');
  renumberMembers(g, project, 'wallMap');

  assert.equal(mid.memberNo, 'W-CUSTOM');
  assert.equal(big.memberNo, 'W1', '手動グループを挟んでも自動側は連番(欠番なし)のはず');
  assert.equal(small.memberNo, 'W2', '3番目だった自動グループはW3ではなくW2に詰まるはず');
});

// ---- QA再検証(blocker A): 手動タグと同じ完成タグへ自動採番が到達し得る衝突の再現・回帰確認 ----
test('assignNumbers: 手動タグ W3 がある状態で自動グループを増やしても自動側は W3 を採番しない', () => {
  const group = (sizeKey, signature) => ({
    mapName: 'wallMap', symbol: 'W', sizeKey, signature,
    floorRanks: new Set([0]), hasRoof: false, counts: new Map([['p1', 1]]),
  });
  const planes = [{ id: 'p1', startFloor: 1 }];
  const ledger = new Map();

  // 手動タグ "W3" を最大グループへ付けた状態（この時点では自動はW1のみ＝衝突なし）。
  const index = new Map([['big', group([500, 0], 'sig-big')], ['mid', group([300, 0], 'sig-mid')]]);
  ledger.set('grp.no:big', 'W3');
  let tags = assignNumbers({ memberNumberIndex: index, memberGroupLedger: ledger, planes });
  assert.equal(tags.get('big'), 'W3');
  assert.equal(tags.get('mid'), 'W1');

  // あとから小さいグループが2つ増える（部材追加・材寸編集で普通に起こる）。
  index.set('small', group([200, 0], 'sig-small'));
  index.set('tiny', group([100, 0], 'sig-tiny'));
  tags = assignNumbers({ memberNumberIndex: index, memberGroupLedger: ledger, planes });

  const values = [...tags.values()];
  assert.equal(new Set(values).size, values.length, '完成タグに重複があってはならない（衝突なし）');
  assert.notEqual(tags.get('tiny'), 'W3', '自動側は手動タグW3を採番しない');
  assert.equal(tags.get('big'), 'W3');
});
