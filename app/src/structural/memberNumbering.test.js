import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectFloorGroups, assignNumbers, applyNumbers, floorSpanLabel, renumberMembers } from './memberNumbering.js';
import { splitGroup, setGroupManualTag } from './memberGroups.js';
import { makeWall, makeBeam, makeColumn, makeGraph, makeProject } from './memberTestFixtures.js';
import { isIndividuallyNumbered, memberOrderKey, noJoinSignatureFor } from './memberCatalog.js';
import { rulesFor, TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';

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

// ---- ステップ4第3単位②: 在来木造の非標準梁（成≠幅の120×330など）は材ごとに個別採番される ----

function woodBeam(id, sectionDefId, extra = {}) {
  return makeBeam(id, sectionDefId, { materialType: 'WOOD', role: 'primary', isVertical: false, coord1: 0, coord2: 1000, ...extra });
}

test('【ステップ4第3単位②】collectFloorGroups/applyNumbers: 在来木造の非標準梁(120×330)は材ごとに個別採番され、標準材(120×120)は従来どおり1グループにまとまる', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  // 挿入順（Map反復順）はあえてaxisValue昇順と揃えない——orderKeyでの並び替えを検証するため
  // （挿入順のまま安定ソートされただけでも一致してしまう検証漏れを避ける）。
  const b1 = woodBeam('b1', 'WOOD-120x330', { axisValue: 100 });
  const b2 = woodBeam('b2', 'WOOD-120x330', { axisValue: 200 });
  const b3 = woodBeam('b3', 'WOOD-120x330', { axisValue: 300 });
  const nonStdInsertOrder = [b3, b1, b2];
  const std = [
    woodBeam('b4', 'WOOD-120x120', { axisValue: 400 }),
    woodBeam('b5', 'WOOD-120x120', { axisValue: 500 }),
  ];
  const g = makeGraph('p1', { beamMap: [...nonStdInsertOrder, ...std] });
  g.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));

  assert.equal(b1.memberNo, 'G1', '非標準梁のaxisValue最小(100)はG1のはず（挿入順ではない）');
  assert.equal(b2.memberNo, 'G2');
  assert.equal(b3.memberNo, 'G3');
  assert.equal(std[0].memberNo, 'G4', '標準材2本は1グループにまとまりG4になるはず');
  assert.equal(std[1].memberNo, 'G4');
});

test('【ステップ4 C-2b QA2】collectFloorGroups/applyNumbers: graph.woodColumnWidthMmを105にすると標準材が120×120から105×120（柱寸×梁成表の最小成）へ切り替わる（120×120が非標準＝個別採番、105×120が標準）', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const nonStd = [
    woodBeam('b1', 'WOOD-120x120', { axisValue: 100 }),
    woodBeam('b2', 'WOOD-120x120', { axisValue: 200 }),
  ];
  const std = [
    woodBeam('b3', 'WOOD-105x120', { axisValue: 300 }),
    woodBeam('b4', 'WOOD-105x120', { axisValue: 400 }),
  ];
  const g = makeGraph('p1', { beamMap: [...nonStd, ...std] });
  g.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g.woodColumnWidthMm = 105;

  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));

  assert.equal(nonStd[0].memberNo, 'G1', '105寸の階では120×120が非標準＝個別採番（axisValue昇順）');
  assert.equal(nonStd[1].memberNo, 'G2');
  assert.equal(std[0].memberNo, 'G3', '105×120（柱寸105×梁成表の最小成120）は標準材として1グループにまとまる');
  assert.equal(std[1].memberNo, 'G3');
});

test('【ステップ4第3単位②】assignNumbers: 個別採番グループの順序はorderKey（axisValue昇順）で決まり、idの大小・並び順・挿入順には依存しない', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  // idはaxisValueの大小と逆の辞書順（'aaa'<'mmm'<'zzz'だがaxisValueは'zzz'が最小）、挿入順（Map反復順）も
  // axisValue昇順と揃えない（zzz→aaa→mmmの順で挿入。安定ソートの副作用による見かけ一致を避ける）。
  const zzz = woodBeam('zzz', 'WOOD-120x330', { axisValue: 100 });
  const mmm = woodBeam('mmm', 'WOOD-120x330', { axisValue: 200 });
  const aaa = woodBeam('aaa', 'WOOD-120x330', { axisValue: 300 });
  const g = makeGraph('p1', { beamMap: [zzz, aaa, mmm] });
  g.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));

  assert.equal(zzz.memberNo, 'G1', 'axisValue=100（最小）がG1のはず（idの辞書順でも挿入順でもない）');
  assert.equal(mmm.memberNo, 'G2');
  assert.equal(aaa.memberNo, 'G3');
});

test('【ステップ4第3単位②】collectFloorGroups/applyNumbers: 個別採番のグループも2回実行でmemberNoが安定する（冪等）', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const beams = [woodBeam('b1', 'WOOD-120x330', { axisValue: 100 }), woodBeam('b2', 'WOOD-120x330', { axisValue: 200 })];
  const g = makeGraph('p1', { beamMap: beams });
  g.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));
  const firstPass = beams.map(b => b.memberNo);

  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));
  const secondPass = beams.map(b => b.memberNo);

  assert.deepEqual(secondPass, firstPass, '2回目の採番で番号が変わってはいけない');
});

test('【ステップ4第3単位②】memberGroupKey: numberGroupId を持つ非標準梁は個別化されず、共通gidで1グループにまとまる', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const beams = [
    woodBeam('b1', 'WOOD-120x330', { axisValue: 100, numberGroupId: 'G#shared' }),
    woodBeam('b2', 'WOOD-120x330', { axisValue: 200, numberGroupId: 'G#shared' }),
  ];
  const g = makeGraph('p1', { beamMap: beams });
  g.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  collectFloorGroups(g, project);
  assert.equal(project.memberNumberIndex.size, 1, 'numberGroupIdが同じ2本は1グループのはず（個別化より優先）');
  applyNumbers(g, project, assignNumbers(project));
  assert.equal(beams[0].memberNo, beams[1].memberNo, '共通gidの2本は同じタグになるはず');
});

test('【失敗系・ステップ4第3単位②】isIndividuallyNumbered/memberOrderKey: 対象外role・材違い・標準断面は個別化されず、coord/axis未定義でも例外を投げない', () => {
  const rules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  const base = { id: 'x', materialType: 'WOOD', sectionDefId: 'WOOD-120x330', role: 'primary' };
  assert.equal(isIndividuallyNumbered({ ...base, role: 'foundation' }, 'beamMap', rules), false, '基礎梁は対象外');
  assert.equal(isIndividuallyNumbered({ ...base, role: 'roof' }, 'beamMap', rules), false, '小屋梁(母屋等)は対象外');
  assert.equal(isIndividuallyNumbered({ ...base, role: 'eaves' }, 'beamMap', rules), false, '軒桁は対象外');
  assert.equal(isIndividuallyNumbered({ ...base, materialType: 'STEEL' }, 'beamMap', rules), false, '主構造の材種と違えば対象外');
  assert.equal(isIndividuallyNumbered({ ...base, sectionDefId: 'WOOD-120x120' }, 'beamMap', rules), false, '標準材（defaultSections.beam）は対象外');
  assert.equal(isIndividuallyNumbered(base, 'columnMap', rules), false, 'beamMap以外は対象外');
  const undef = { ...base, coord1: undefined, coord2: undefined, axisValue: undefined, isVertical: undefined };
  assert.doesNotThrow(() => memberOrderKey(undef, 'beamMap', rules));
  assert.deepEqual(memberOrderKey(undef, 'beamMap', rules), [0, 0, 0], 'coord/axis未定義は全て0にフォールバックするはず');
});

// ---- ステップ3（2026-09-17裁定）: 在来木造の柱寸の個別指定は1本1タグ、共通は1タグにまとまる ----
function woodColumn(id, sectionDefId, extra = {}) {
  return makeColumn(id, sectionDefId, { materialType: 'WOOD', role: 'standard', ...extra });
}

test('【ステップ3】collectFloorGroups/applyNumbers: 個別柱寸(105)を持つ柱2本はそれぞれ別タグになり、共通(120)の柱2本は1タグにまとまる（採番順はsizeKey降順優先＝断面が大きい共通120がC1、個別105は座標昇順でC2・C3）', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  // 挿入順はあえて座標昇順と揃えない（orderKey=[x,y]での並び替えを検証するため）。
  // axisX/axisY（AXIS。偏心を含まない）で並び順を決める（memberOrderKeyのB-1切替。structuralModel参照）。
  const individualB = woodColumn('c1', 'WOOD-105x105', { woodColumnWidthMm: 105, axisX: 2000, axisY: 0 });
  const individualA = woodColumn('c2', 'WOOD-105x105', { woodColumnWidthMm: 105, axisX: 1000, axisY: 0 });
  const commonA = woodColumn('c3', 'WOOD-120x120', { woodColumnWidthMm: null, axisX: 0, axisY: 0 });
  const commonB = woodColumn('c4', 'WOOD-120x120', { woodColumnWidthMm: null, axisX: 3000, axisY: 0 });
  const g = makeGraph('p1', { columnMap: [individualB, individualA, commonA, commonB] });
  g.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));

  // 断面積は共通(120×120=14400)が個別(105×105=11025)より大きい＝sizeKey降順でC1は共通のグループ。
  assert.equal(commonA.memberNo, 'C1', '断面の大きい共通(120角)の柱グループがC1のはず');
  assert.equal(commonB.memberNo, 'C1', '共通の柱2本は同じタグ（C1）にまとまる');
  assert.equal(individualA.memberNo, 'C2', '個別指定の柱はx=1000（座標昇順で先）がC2のはず');
  assert.equal(individualB.memberNo, 'C3', 'もう一方の個別指定の柱（x=2000）はC3');
});

test('【QA提案4・ステップ4】collectFloorGroups/applyNumbers: 共通(105)より断面の大きい個別柱(120)を作ると、sizeKey降順で個別柱がC1・共通がC2になる（前段のテストと共通/個別の大小関係が逆——MemberListTab側の「タップした柱の新しいカードへ追従する」修正が必要な理由の実測）', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const individual = woodColumn('c1', 'WOOD-120x120', { woodColumnWidthMm: 120, axisX: 500, axisY: 0 });
  const commonA = woodColumn('c2', 'WOOD-105x105', { woodColumnWidthMm: null, axisX: 0, axisY: 0 });
  const commonB = woodColumn('c3', 'WOOD-105x105', { woodColumnWidthMm: null, axisX: 1000, axisY: 0 });
  const g = makeGraph('p1', { columnMap: [individual, commonA, commonB] });
  g.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));

  // 断面積は個別(120×120=14400)が共通(105×105=11025)より大きい＝sizeKey降順でC1は個別のグループ
  // （前段のテストとは逆転する組み合わせ——「共通の方が常にC1」ではなく、選んだ幅の大小で反転する）。
  assert.equal(individual.memberNo, 'C1', '断面の大きい個別柱(120角)がC1のはず（タップした柱そのものの新タグ）');
  assert.equal(commonA.memberNo, 'C2', '共通(105角)の柱はC2にまとまる');
  assert.equal(commonB.memberNo, 'C2');
});

test('【QA裁定・ステップ3】renumberMembers: 共通柱グループに手動タグ（grp.join）があっても、own(105)が階の値(120)と異なる個別柱はconformToLedgerの署名一致で吸収されず別タグになる（QA実測: own=階の値の個別柱が吸収され1本1タグが消える事故の再発防止）', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const c1 = woodColumn('c1', 'WOOD-120x120', { woodColumnWidthMm: null, axisX: 0, axisY: 0 }); // 共通（階の値120）
  const g = makeGraph('p1', { columnMap: [c1] });
  g.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // c1へ手動タグを打つ（実UIのcommitManualNumberと同じ流れ。共通柱はnoJoinSignatureFor=nullのため
  // join=trueで台帳に書かれる＝以後同署名の部材はconformToLedgerで自動吸収される）。
  const gid = splitGroup(project, 'columnMap', [c1]);
  setGroupManualTag(project.memberGroupLedger, gid, 'CX');
  renumberMembers(g, project, 'columnMap');
  assert.equal(c1.memberNo, 'CX', '前提: 共通柱の手動タグがCXとして確定している');

  // own=105（階の値120とは異なる）の個別柱を追加。sectionDefIdは conformWoodSections が実際に
  // 生成する値（'WOOD-105x105'）を直接与える——本ファイルは duck-typed fixture のため conform自体は
  // シミュレートしない（既存の個別採番テストと同じ規約）。
  const c2 = woodColumn('c2', 'WOOD-105x105', { woodColumnWidthMm: 105, axisX: 1000, axisY: 0 });
  g.columnMap.set(c2.id, c2);
  renumberMembers(g, project, 'columnMap');

  assert.notEqual(c2.memberNo, 'CX', 'own=105は共通(120)と署名が異なるため、CXグループへ吸収されない');
  assert.equal(c1.memberNo, 'CX', '既存の共通柱の手動タグは変更後も維持される');
});

test('【失敗系・ステップ3】collectFloorGroups/applyNumbers: 非在来（主構造未設定）は柱にwoodColumnWidthMmがあっても個別化されず1グループにまとまる', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const c1 = woodColumn('c1', 'WOOD-105x105', { woodColumnWidthMm: 105, axisX: 0, axisY: 0 });
  const c2 = woodColumn('c2', 'WOOD-105x105', { woodColumnWidthMm: 105, axisX: 1000, axisY: 0 });
  const g = makeGraph('p1', { columnMap: [c1, c2] }); // structureOverride未設定＝主構造未定

  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));

  assert.equal(c1.memberNo, 'C1');
  assert.equal(c2.memberNo, 'C1', '非在来はwoodColumnWidthMmを個別採番の材料に使わない（1グループ）');
});

test('【失敗系・ステップ4第3単位②】collectFloorGroups: 非在来（主構造未設定）は非正角断面(120×330)の梁が複数あっても個別化されず1グループにまとまる', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const beams = [woodBeam('b1', 'WOOD-120x330'), woodBeam('b2', 'WOOD-120x330')];
  const g = makeGraph('p1', { beamMap: beams }); // structureOverrideを設定しない＝主構造未定
  collectFloorGroups(g, project);
  assert.equal(project.memberNumberIndex.size, 1, '主構造未定は非正角断面でも同一材寸なら1グループのはず');
});

// ---- QA指摘F1（重大・機能バグ）: 手動タグの materialize（MemberListTab.jsx commitManualNumber）が
// splitFromSignatureを渡さずjoin=trueで台帳へ書くと、conformToLedgerが同署名の他の個別採番対象まで
// 新gidへ吸収し、個別採番が無効化される（実測: 120×330 ×3本で1本に手動タグを打つと3本ともそのタグに
// 統合された）。修正後はnoJoinSignatureForが個別採番対象に「今の署名」を返しjoinを抑止する。 ----
test('【失敗系・QA指摘F1】手動タグは個別採番を壊さない（120×330 ×3本の1本に手動タグを打っても他の2本は自動採番のまま・グループは3つのまま）', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const b1 = woodBeam('b1', 'WOOD-120x330', { axisValue: 100 });
  const b2 = woodBeam('b2', 'WOOD-120x330', { axisValue: 200 });
  const b3 = woodBeam('b3', 'WOOD-120x330', { axisValue: 300 });
  const g = makeGraph('p1', { beamMap: [b1, b2, b3] });
  g.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const rules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);

  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));
  assert.equal(project.memberNumberIndex.size, 3, '個別採番で3グループに分かれているはず（前提）');

  // MemberListTab.jsx commitManualNumber と同じ手順（b2のカード＝members=[b2]。修正後の形）。
  const gid = splitGroup(project, 'beamMap', [b2], {
    splitFromSignature: noJoinSignatureFor(b2, 'beamMap', rules),
  });
  setGroupManualTag(project.memberGroupLedger, gid, 'G99');
  renumberMembers(g, project, 'beamMap');

  // b1・b3は手動タグを挟んで自動側の番号が詰め直される（欠番を作らない既存仕様。
  // assignNumbers: 手動タグのグループを挟んでも自動グループの番号は連番のまま）——ここで検証したいのは
  // 番号の絶対値ではなく「b1・b3がG99に吸収されず、3グループのまま独立していること」（QA指摘F1）。
  assert.equal(b2.memberNo, 'G99', 'b2は手動タグG99になるはず');
  assert.notEqual(b1.memberNo, 'G99', 'b1がG99に吸収されてはいけない');
  assert.notEqual(b3.memberNo, 'G99', 'b3がG99に吸収されてはいけない');
  assert.notEqual(b1.memberNo, b3.memberNo, 'b1とb3は別グループのまま（同一タグに統合されない）');
  assert.equal(project.memberNumberIndex.size, 3, 'グループは3つのまま（統合されていない）');
});

// ---- QA指摘F5: 既存グループの再同期（collectFloorGroupsのelse分岐）がorderKeyも更新すること ----
test('【QA指摘F5】collectFloorGroups: 梁芯移動（axisValue変更）で個別採番の順序が更新される（既存グループのorderKey再同期）', () => {
  const project = makeProject([{ id: 'p1', startFloor: 1 }]);
  const b1 = woodBeam('b1', 'WOOD-120x330', { axisValue: 100 });
  const b2 = woodBeam('b2', 'WOOD-120x330', { axisValue: 200 });
  const g = makeGraph('p1', { beamMap: [b1, b2] });
  g.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));
  assert.equal(b1.memberNo, 'G1', 'axisValue=100（最小）が先にG1のはず（前提）');
  assert.equal(b2.memberNo, 'G2');

  // 梁芯移動: b1のaxisValueが300へ（groupKeyはsignature#b1のままで不変＝collectFloorGroupsの
  // else分岐＝既存グループの再同期を通る）。
  b1.axisValue = 300;
  collectFloorGroups(g, project);
  applyNumbers(g, project, assignNumbers(project));

  assert.equal(b2.memberNo, 'G1', 'axisValue=200（今は最小）のb2がG1になるはず（orderKeyが更新された証拠）');
  assert.equal(b1.memberNo, 'G2', '移動後300になったb1はG2になるはず');
});
