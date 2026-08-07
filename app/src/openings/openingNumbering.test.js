// node:test 用の使い捨てフィクスチャ方針は structural/memberTestFixtures.js と同じ
// （実 core.js / PlanGraph は持ち出さず、採番ロジックが読む最小限のプロパティだけを持つ
// ダックタイピングの代役を使う。openingNumberIndex は実MobXの observable.map()——deepな
// observable.map() は set() に渡した plain object を複製して格納するため（split-brain）、
// plain Map では検出できないバグ（構造memberNumbering.jsで再発済み）をここでも検出できる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observable } from 'mobx';
import {
  collectFloorOpeningGroups, assignOpeningNumbers, applyOpeningTags, renumberOpenings,
  openingGroupsOnFloor, fixtureSymbolOf, openingTagOf, effectiveHeight,
} from './openingNumbering.js';

function makeOpening(id, { fixtureType = 'AW', subType = 'doubleSliding', width = 1690, height = 1170, sillHeight = 800, category = 'window' } = {}) {
  return { id, fixtureType, subType, width, height, sillHeight, category };
}

function makeGraph(planeId, openings) {
  return { plane: { id: planeId }, openings };
}

function makeProject() {
  return { openingNumberIndex: observable.map() };
}

// ---- 正常系: 1F・2Fに同一仕様の窓→同一タグ。幅違い追加で大きい方がAW-1 ----
test('collectFloorOpeningGroups/assignOpeningNumbers: 同一仕様は全階で同一タグ、幅の大きい方が若番', () => {
  const project = makeProject();
  const g1 = makeGraph('p1', [makeOpening('a', { width: 1690 })]);
  const g2 = makeGraph('p2', [makeOpening('b', { width: 1690 })]);

  collectFloorOpeningGroups(g1, project);
  collectFloorOpeningGroups(g2, project);
  applyOpeningTags(project, assignOpeningNumbers(project));

  const groups1 = openingGroupsOnFloor(g1, project);
  const groups2 = openingGroupsOnFloor(g2, project);
  assert.equal(groups1[0].tag, 'AW-1');
  assert.equal(groups2[0].tag, 'AW-1', '同一仕様は全階で同一タグ（採番は全階統一）');

  // 幅の大きい別仕様を1Fへ追加 → 大きい方がAW-1になる
  const g1b = makeGraph('p1', [makeOpening('a', { width: 1690 }), makeOpening('c', { width: 2000 })]);
  collectFloorOpeningGroups(g1b, project);
  applyOpeningTags(project, assignOpeningNumbers(project));
  const groupsAfter = openingGroupsOnFloor(g1b, project);
  const wide = groupsAfter.find(g => g.openings[0].width === 2000);
  const narrow = groupsAfter.find(g => g.openings[0].width === 1690);
  assert.equal(wide.tag, 'AW-1', '幅の大きい方が若番になるはず');
  assert.equal(narrow.tag, 'AW-2');
});

// ---- 記号分離: AW / JW / WD が独立連番 ----
test('assignOpeningNumbers: 記号が違えば独立して連番になる', () => {
  const project = makeProject();
  const g = makeGraph('p1', [
    makeOpening('a', { fixtureType: 'AW', width: 1690 }),
    makeOpening('b', { fixtureType: 'JW', width: 1690 }),
    makeOpening('c', { fixtureType: 'WD', subType: 'singleSwing', width: 800, height: 2000, sillHeight: null, category: 'fitting' }),
  ]);
  collectFloorOpeningGroups(g, project);
  applyOpeningTags(project, assignOpeningNumbers(project));

  const groups = openingGroupsOnFloor(g, project);
  const byOpeningId = (id) => groups.find(gr => gr.openings.some(o => o.id === id)).tag;
  assert.equal(byOpeningId('a'), 'AW-1');
  assert.equal(byOpeningId('b'), 'JW-1');
  assert.equal(byOpeningId('c'), 'WD-1');
});

// ---- 失敗系: fixtureType:null の旧データはカテゴリ既定へフォールバック ----
test('fixtureSymbolOf: fixtureType未設定（旧データ）はwindow→AW、fitting→WDへフォールバック', () => {
  const win = makeOpening('a', { fixtureType: null, category: 'window' });
  const fit = makeOpening('b', { fixtureType: null, category: 'fitting', subType: 'singleSwing', width: 800, height: 2000, sillHeight: null });
  assert.equal(fixtureSymbolOf(win), 'AW');
  assert.equal(fixtureSymbolOf(fit), 'WD');
});

// ---- 失敗系: 2Fから全削除して再collectでゴーストグループが消える ----
test('collectFloorOpeningGroups: 階から開口を全削除すると再collectでゴーストグループが消える', () => {
  const project = makeProject();
  const g1 = makeGraph('p1', [makeOpening('a', { width: 1690 })]);
  const g2 = makeGraph('p2', [makeOpening('b', { width: 1690 })]);
  collectFloorOpeningGroups(g1, project);
  collectFloorOpeningGroups(g2, project);
  applyOpeningTags(project, assignOpeningNumbers(project));
  assert.equal(project.openingNumberIndex.size, 1);

  const g2Empty = makeGraph('p2', []);
  collectFloorOpeningGroups(g2Empty, project);
  assert.equal(project.openingNumberIndex.size, 1, '1Fにまだ残っているので消えない');

  const g1Empty = makeGraph('p1', []);
  collectFloorOpeningGroups(g1Empty, project);
  assert.equal(project.openingNumberIndex.size, 0, 'どの階からも参照されなくなり消える');
});

// ---- 失敗系（再発防止）: その階に1本しかない新規グループが deep observable の複製差し替え忘れで消えないこと ----
test('collectFloorOpeningGroups: その階に1本だけの新規グループでも採番される（複製差し替え忘れの再発防止）', () => {
  const project = makeProject();
  const g = makeGraph('p1', [makeOpening('solo', { fixtureType: 'SW', width: 1234, height: 987, sillHeight: 300 })]);

  collectFloorOpeningGroups(g, project);
  const tags = assignOpeningNumbers(project);
  applyOpeningTags(project, tags);

  assert.equal(project.openingNumberIndex.size, 1, '1本しかなくてもゴースト掃除で消えてはいけない');
  const groups = openingGroupsOnFloor(g, project);
  assert.equal(groups[0].tag, 'SW-1', '唯一の新規グループが番号を得るはず（修正前はnullのまま）');
});

test('renumberOpenings: 自階だけのcollect→assign→applyを1回で行う', () => {
  const project = makeProject();
  const g = makeGraph('p1', [makeOpening('a', { width: 1690 }), makeOpening('b', { fixtureType: 'JW', width: 600, subType: 'casement', height: 900 })]);
  renumberOpenings(g, project);
  const groups = openingGroupsOnFloor(g, project);
  assert.equal(groups.length, 2);
  assert.ok(groups.every(gr => gr.tag != null));
});

// ---- Finding 2 回帰: 11グループ以上ではタグの文字列ソートだとAW-10がAW-2より前に来てしまう ----
test('openingGroupsOnFloor: 11グループ以上でも数値順（AW-1, AW-2, …, AW-10, AW-11）に並ぶ', () => {
  const project = makeProject();
  // 幅を1つずつ変えて11個の独立した記号内グループを作る（幅降順でAW-1〜AW-11が決まる）。
  const openings = Array.from({ length: 11 }, (_, i) => makeOpening(`o${i}`, { width: 2600 - i * 100 }));
  const g = makeGraph('p1', openings);
  renumberOpenings(g, project);

  const groups = openingGroupsOnFloor(g, project);
  assert.equal(groups.length, 11);
  const expectedTags = Array.from({ length: 11 }, (_, i) => `AW-${i + 1}`);
  assert.deepEqual(groups.map(gr => gr.tag), expectedTags,
    '文字列ソートだと AW-10/AW-11 が AW-2 より前に来てしまう（"1" < "2"）。数値順で並ぶはず');
});

// ---- Finding B 回帰: 負値混入（UI経由以外・復元データ等）でも effectiveHeight は正値を返す ----
test('effectiveHeight: height=-500（負値）も不正値としてカタログ既定にフォールバックする（姿図のrect高さが負にならない保証）', () => {
  const opening = makeOpening('a', { height: -500 });
  const h = effectiveHeight(opening);
  assert.ok(h > 0, 'effectiveHeightは常に正値を返すはず');
  assert.equal(h, 1170, 'doubleSlidingのカタログ既定(1170)にフォールバックするはず');
});

// ---- 失敗系: height=null（旧データ）はカタログ既定にフォールバックし、同値の明示データと同一グループ・同一タグになる ----
test('openingSignature: height=null（旧データ）はカタログ既定と同値の明示データと同一タグになる', () => {
  const project = makeProject();
  // doubleSliding のカタログ既定高さは1170mm（openingCatalog.js）。null(旧データ)側は
  // effectiveHeight のフォールバックで同じ1170として扱われ、同一signatureに収束するはず。
  const legacy  = makeOpening('legacy',  { height: null });
  const explicit = makeOpening('explicit', { height: 1170 });
  const g = makeGraph('p1', [legacy, explicit]);
  renumberOpenings(g, project);

  assert.equal(project.openingNumberIndex.size, 1, '同一signatureに収束し1グループになるはず');
  const tagLegacy   = openingTagOf(legacy, project);
  const tagExplicit = openingTagOf(explicit, project);
  assert.ok(tagLegacy, 'height=nullでもタグが確定する');
  assert.equal(tagLegacy, tagExplicit, '同じ仕様として同一タグになるはず');
});
