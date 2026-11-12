// 構造リストの「開いているカード」を id で覚える純モジュール（structural/expandedMemberCard.js）の単体テスト。
// 裁定2026-11-12 案A（R1〜R7）。再現（実 graph）は部材追加の実際の入口と同じ関数列を通し、番号がずれて
// 「番号で覚えると別の部材を指す」ことを前提として固定してから id 方式が追従することを確かめる。
// graph につながるオブジェクトは assert に渡さず、id・文字列へ畳む（node:test のヒープ外確保対策）。
// フィクスチャは原点 (0,0) から離した座標にし、筋書きごとに作り直す。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInAction } from 'mobx';
import { Project, CenterLineType, Discipline } from '../core.js';
import { undoManager } from '../undoManager.js';
import { serializeGraph } from '../graphSnapshot.js';
import { commitManualColumnAdd, pushGraphUndo } from './manualMemberCommit.js';
import { addManualFooting, addManualBeam } from './manualMemberAdd.js';
import { renumberMembers } from './memberNumbering.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { findSectionEntry } from './sectionCatalog.js';
import {
  anchorForCard, anchorForFocus, withPrimaryMember,
  resolveExpandedCard, reconcileAnchor, cardListing,
} from './expandedMemberCard.js';

beforeEach(() => {
  while (undoManager.canUndo) undoManager.undo();
  while (undoManager.canRedo) undoManager.redo();
  undoManager._undoStack.splice(0);
  undoManager._redoStack.splice(0);
});

// ---- プレーンな一覧 ----
const sec = (sectionKey, mapName, cards) => ({ sectionKey, mapName, cards });
const card = (tag, ...ids) => ({ tag, ids });
const anchor = (mapName, ids, primaryId = null, tag = null) => ({ mapName, ids, primaryId, tag });
const idsOf = r => (r ? r.ids.join(',') : null);

// ================= 1. 判定順 =================
test('resolve: 主 id を含むカードが、覚えている id の多数側より優先される', () => {
  const sections = [sec('col', 'columnMap', [card('C1', 'a', 'b', 'c'), card('C2', 'd')])];
  const r = resolveExpandedCard(anchor('columnMap', ['a', 'b', 'c', 'd'], 'd'), sections);
  assert.equal(r.tag, 'C2');
  assert.equal(idsOf(r), 'd');
});

test('resolve: 主 id なしは覚えている id を多く含む側', () => {
  const sections = [sec('col', 'columnMap', [card('C1', 'a'), card('C2', 'b', 'c')])];
  const r = resolveExpandedCard(anchor('columnMap', ['a', 'b', 'c']), sections);
  assert.equal(r.tag, 'C2');
});

test('resolve: 同数は一覧順（セクション順→カード順）で先のカード', () => {
  const s1 = [sec('col', 'columnMap', [card('C1', 'a'), card('C2', 'b')])];
  assert.equal(resolveExpandedCard(anchor('columnMap', ['a', 'b']), s1).tag, 'C1');
  const s2 = [sec('x', 'beamMap', [card('G1', 'a2')]), sec('beam', 'beamMap', [card('G2', 'b2')]), sec('beamSub', 'beamMap', [card('G3', 'c2')])];
  const r = resolveExpandedCard(anchor('beamMap', ['c2', 'b2']), s2);
  assert.equal(r.sectionKey, 'beam');
  assert.equal(r.tag, 'G2');
});

test('resolve: 主 id が一覧に無ければ多数へ落ちる', () => {
  const sections = [sec('col', 'columnMap', [card('C1', 'a'), card('C2', 'b', 'c')])];
  const r = resolveExpandedCard(anchor('columnMap', ['a', 'b', 'c', 'gone'], 'gone'), sections);
  assert.equal(r.tag, 'C2');
});

test('resolve: id が 1 つも当たらないときだけ tag で引く', () => {
  const sections = [sec('col', 'columnMap', [card('C1', 'a'), card('C2', 'b')])];
  const r = resolveExpandedCard(anchor('columnMap', ['gone'], null, 'C2'), sections);
  assert.equal(r.tag, 'C2');
  assert.equal(idsOf(r), 'b');
});

test('resolve: id が当たれば tag が別カードに一致しても id を優先する', () => {
  const sections = [sec('col', 'columnMap', [card('C1', 'a'), card('C2', 'b')])];
  const r = resolveExpandedCard(anchor('columnMap', ['a'], null, 'C2'), sections);
  assert.equal(r.tag, 'C1');
});

test('resolve: 同じ mapName の複数セクションで正しい sectionKey を返す', () => {
  const sections = [sec('beam', 'beamMap', [card('G1', 'a')]), sec('beamSub', 'beamMap', [card('G2', 'b')])];
  const r = resolveExpandedCard(anchor('beamMap', ['b'], 'b'), sections);
  assert.equal(r.sectionKey, 'beamSub');
  assert.equal(r.mapName, 'beamMap');
  assert.equal(r.tag, 'G2');
});

test('resolve: 主 id は後ろのセクションにあっても、前のセクションの多数側より優先される', () => {
  const sections = [sec('beam', 'beamMap', [card('G1', 'a', 'b')]), sec('beamSub', 'beamMap', [card('B1', 'p')])];
  const r = resolveExpandedCard(anchor('beamMap', ['a', 'b', 'p'], 'p'), sections);
  assert.equal(r.sectionKey, 'beamSub');
  assert.equal(r.tag, 'B1');
  assert.equal(idsOf(r), 'p');
});

test('resolve: 別 mapName のセクションにある同じ id・同じ tag には当たらない', () => {
  const sections = [sec('foot', 'footingMap', [card('C1', 'a')])];
  assert.equal(resolveExpandedCard(anchor('columnMap', ['a'], 'a', 'C1'), sections), null);
});

test('resolve: anchor null → null／全 id が消えていて tag も無し → null', () => {
  const sections = [sec('col', 'columnMap', [card('C1', 'a')])];
  assert.equal(resolveExpandedCard(null, sections), null);
  assert.equal(resolveExpandedCard(anchor('columnMap', ['gone'], 'gone'), sections), null);
});

test('resolve: 戻り値の ids は新しい配列（入力を変更しない）', () => {
  const sections = [sec('col', 'columnMap', [card('C1', 'a', 'b')])];
  const r = resolveExpandedCard(anchor('columnMap', ['a']), sections);
  r.ids.push('z');
  assert.equal(sections[0].cards[0].ids.join(','), 'a,b');
});

// ================= 2. reconcileAnchor =================
test('reconcile: 参照が違えば current のまま（focusRequest との競合）', () => {
  const from = anchor('columnMap', ['a']);
  const current = anchor('columnMap', ['b'], 'b', 'C9');
  const resolved = { sectionKey: 'col', mapName: 'columnMap', tag: 'C1', ids: ['a'] };
  assert.ok(reconcileAnchor(current, from, resolved) === current);
});

test('reconcile: 参照が違えば resolved が null でも current のまま（古い解決の「閉じる」で新しいアンカーを消さない）', () => {
  const from = anchor('columnMap', ['gone']);
  const current = anchor('columnMap', ['b'], 'b', 'C9');
  assert.ok(reconcileAnchor(current, from, null) === current);
});

test('reconcile: resolved null → null（R4・R7）', () => {
  const a = anchor('columnMap', ['a'], 'a');
  assert.equal(reconcileAnchor(a, a, null), null);
});

test('reconcile: 変化なしは同じ参照を返す', () => {
  const a = anchor('columnMap', ['a', 'b'], 'a');
  const resolved = { sectionKey: 'col', mapName: 'columnMap', tag: 'C1', ids: ['a', 'b'] };
  assert.ok(reconcileAnchor(a, a, resolved) === a);
});

test('reconcile: 部材が増えた・減ったら ids を更新する', () => {
  const a = anchor('columnMap', ['a', 'b'], 'a');
  const resolvedGrown = { sectionKey: 'col', mapName: 'columnMap', tag: 'C1', ids: ['a', 'b', 'n'] };
  const grown = reconcileAnchor(a, a, resolvedGrown);
  assert.equal(grown.ids.join(','), 'a,b,n');
  assert.equal(grown.primaryId, 'a');
  grown.ids.push('z'); // 戻り値の ids は複製（解決結果と配列を共有しない）
  assert.equal(resolvedGrown.ids.join(','), 'a,b,n');
  const shrunk = reconcileAnchor(a, a, { sectionKey: 'col', mapName: 'columnMap', tag: 'C1', ids: ['a'] });
  assert.equal(shrunk.ids.join(','), 'a');
  assert.equal(a.ids.join(','), 'a,b');
});

test('reconcile: 本数が同じでも部材が入れ替わっていれば ids を更新する（同じ参照を返さない）', () => {
  const a = anchor('columnMap', ['a', 'b'], 'a');
  const r = reconcileAnchor(a, a, { sectionKey: 'col', mapName: 'columnMap', tag: 'C1', ids: ['a', 'n'] });
  assert.ok(r !== a, '入れ替わりを変化なしと見なしている');
  assert.equal(r.ids.join(','), 'a,n');
  assert.equal(r.primaryId, 'a');
});

test('reconcile: 主 id が消えたら primaryId は null', () => {
  const a = anchor('columnMap', ['a', 'b'], 'a');
  const r = reconcileAnchor(a, a, { sectionKey: 'col', mapName: 'columnMap', tag: 'C1', ids: ['b'] });
  assert.equal(r.primaryId, null);
  assert.equal(r.ids.join(','), 'b');
});

test('reconcile: tag は消える', () => {
  const a = anchor('columnMap', ['a'], 'a', 'C2');
  const r = reconcileAnchor(a, a, { sectionKey: 'col', mapName: 'columnMap', tag: 'C1', ids: ['a'] });
  assert.equal(r.tag, null);
  assert.equal(r.ids.join(','), 'a');
});

test('reconcile: current null → null', () => {
  const resolved = { sectionKey: 'col', mapName: 'columnMap', tag: 'C1', ids: ['a'] };
  assert.equal(reconcileAnchor(null, null, resolved), null);
  assert.equal(reconcileAnchor(undefined, undefined, resolved), null);
});

test('R7: 伏図タップ（anchorForFocus）がどのカードにも一致しなければ閉じる', () => {
  const a = anchorForFocus({ mapName: 'columnMap', tag: 'C9', fieldKey: 'size', entityId: 'zz' });
  const sections = [sec('col', 'columnMap', [card('C1', 'a')])];
  const r = resolveExpandedCard(a, sections);
  assert.equal(r, null);
  assert.equal(reconcileAnchor(a, a, r), null);
});

// ================= 3. 成功側（呼び出し側の実際の形） =================
test('anchorForCard: ids を複製し tag は null、primaryId の既定は null', () => {
  const ids = ['a', 'b'];
  const r = anchorForCard('columnMap', ids);
  assert.deepEqual(r, { mapName: 'columnMap', ids: ['a', 'b'], primaryId: null, tag: null });
  r.ids.push('z');
  assert.equal(ids.join(','), 'a,b');
  assert.equal(anchorForCard('columnMap', ids, 'b').primaryId, 'b');
});

test('anchorForFocus: { mapName, tag, fieldKey, entityId } から作る。entityId なしは ids 空・primaryId null', () => {
  const req = { mapName: 'columnMap', tag: 'C2', fieldKey: 'size', entityId: 'e1' };
  assert.deepEqual(anchorForFocus(req), { mapName: 'columnMap', ids: ['e1'], primaryId: 'e1', tag: 'C2' });
  assert.deepEqual(anchorForFocus({ mapName: 'beamMap', tag: 'G1' }), { mapName: 'beamMap', ids: [], primaryId: null, tag: 'G1' });
  // 空文字の entityId は「id なし」と同じ（ids が空なのに主 id だけ残る形を作らない）。
  assert.deepEqual(anchorForFocus({ mapName: 'beamMap', tag: 'G1', entityId: '' }), { mapName: 'beamMap', ids: [], primaryId: null, tag: 'G1' });
  assert.equal(req.entityId, 'e1');
});

test('anchorForFocus: mapName または tag が無ければ null（focusRequest 自体が無くても null）', () => {
  assert.equal(anchorForFocus({ mapName: 'columnMap', entityId: 'e1' }), null);
  assert.equal(anchorForFocus({ tag: 'C1', entityId: 'e1' }), null);
  assert.equal(anchorForFocus(null), null);
  assert.equal(anchorForFocus(undefined), null);
});

test('withPrimaryMember: 同じ mapName なら ids と tag を保ち主だけ差し替える（無ければ ids に足す）', () => {
  const a = anchor('columnMap', ['a', 'b'], 'a', 'C2');
  const r1 = withPrimaryMember(a, 'columnMap', 'b');
  assert.deepEqual(r1, { mapName: 'columnMap', ids: ['a', 'b'], primaryId: 'b', tag: 'C2' });
  const r2 = withPrimaryMember(a, 'columnMap', 'z');
  assert.deepEqual(r2, { mapName: 'columnMap', ids: ['a', 'b', 'z'], primaryId: 'z', tag: 'C2' });
  assert.deepEqual(a, { mapName: 'columnMap', ids: ['a', 'b'], primaryId: 'a', tag: 'C2' });
});

test('withPrimaryMember: anchor が null・別 mapName なら単独のアンカー', () => {
  assert.deepEqual(withPrimaryMember(null, 'columnMap', 'z'), { mapName: 'columnMap', ids: ['z'], primaryId: 'z', tag: null });
  const a = anchor('beamMap', ['a'], 'a', 'G1');
  assert.deepEqual(withPrimaryMember(a, 'columnMap', 'z'), { mapName: 'columnMap', ids: ['z'], primaryId: 'z', tag: null });
});

test('cardListing: [[tag, [{id}...]]...] を ListingSection へ畳む（入力は不変）', () => {
  const input = [
    { sectionKey: 'beam', mapName: 'beamMap', tagGroups: [['G1', [{ id: 'a', x: 1 }, { id: 'b' }]], ['G2', [{ id: 'c' }]]] },
    { sectionKey: 'beamSub', mapName: 'beamMap', tagGroups: [] },
  ];
  const snapshot = JSON.stringify(input);
  const out = cardListing(input);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { sectionKey: 'beam', mapName: 'beamMap', cards: [{ tag: 'G1', ids: ['a', 'b'] }, { tag: 'G2', ids: ['c'] }] });
  assert.deepEqual(out[1], { sectionKey: 'beamSub', mapName: 'beamMap', cards: [] });
  assert.equal(JSON.stringify(input), snapshot);
});

// ================= 4. 失敗側 =================
test('失敗側: sections が非配列', () => {
  assert.throws(() => resolveExpandedCard(anchor('columnMap', ['a']), null), /sections/);
  assert.throws(() => resolveExpandedCard(null, undefined), /sections/);
  assert.throws(() => cardListing(null), /sections/);
  assert.throws(() => cardListing({}), /sections/);
});

test('失敗側: anchorForCard の ids が空・非配列', () => {
  assert.throws(() => anchorForCard('columnMap', []), /ids/);
  assert.throws(() => anchorForCard('columnMap', 'a'), /ids/);
  assert.throws(() => anchorForCard('columnMap'), /ids/);
});

test('失敗側: mapName が空・非文字列', () => {
  assert.throws(() => anchorForCard('', ['a']), /mapName/);
  assert.throws(() => anchorForCard(1, ['a']), /mapName/);
  assert.throws(() => withPrimaryMember(null, '', 'a'), /mapName/);
  assert.throws(() => withPrimaryMember(null, null, 'a'), /mapName/);
});

test('失敗側: withPrimaryMember の id 欠落・空', () => {
  assert.throws(() => withPrimaryMember(null, 'columnMap'), /id/);
  assert.throws(() => withPrimaryMember(null, 'columnMap', ''), /id/);
});

test('失敗側: primaryId が数値', () => {
  assert.throws(() => anchorForCard('columnMap', ['a'], 5), /primaryId/);
});

// ================= 5. 再現（実 graph） =================
function makeEnv(structure) {
  const project = new Project('projR', 'repro');
  const { graph } = project.addPlane(0, '1階');
  graph.structureOverride = structure;
  const sg = project.structGraph;
  const xs = [1300, 5300, 9300].map(v => sg.addCenterLine(CenterLineType.VERTICAL, v, { labeled: true, discipline: Discipline.STRUCT }));
  const ys = [2700, 6700, 10700].map(v => sg.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: true, discipline: Discipline.STRUCT }));
  return { project, graph, xs, ys };
}

// 実際の入口（MemberListTab.jsx の追加と同じ関数列）
const ADDERS = {
  columnMap: (env, a) => commitManualColumnAdd(env.graph, env.project, { vCL: a.v, hCL: a.h }),
  footingMap: (env, a) => {
    const before = serializeGraph(env.graph);
    let f;
    runInAction(() => {
      f = addManualFooting(env.graph, env.project, { kind: 'independent', vCL: a.v, hCL: a.h });
      renumberMembers(env.graph, env.project, 'footingMap');
    });
    pushGraphUndo(env.graph, before);
    return f;
  },
  beamMap: (env, a) => {
    const before = serializeGraph(env.graph);
    let b;
    runInAction(() => {
      b = addManualBeam(env.graph, env.project, { axisCL: a.axis, isVertical: true, clStart: a.s, clEnd: a.e });
      renumberMembers(env.graph, env.project, 'beamMap');
    });
    pushGraphUndo(env.graph, before);
    return b;
  },
};

const idsWithTag = (env, mapName, tag) =>
  [...env.graph[mapName].values()].filter(e => e.memberNo === tag).map(e => e.id).sort();

// cardListing の入力形（[[tag, members]]）を memberNo ごと・初出順で作る。MemberListTab の computeTagGroups が行う
// 並べ替え・絞り込み・未採番タグは省いた簡略形（再現 4 例に同数は無いので、同数の判定には使わない）。
function listingFromGraph(env, mapName) {
  const by = new Map();
  for (const e of env.graph[mapName].values()) {
    if (!by.has(e.memberNo)) by.set(e.memberNo, []);
    by.get(e.memberNo).push({ id: e.id });
  }
  return cardListing([{ sectionKey: mapName, mapName, tagGroups: [...by.entries()] }]);
}

// 追加前に openTag を開いた状態から追加し、結果を文字列へ畳んで返す
function runRepro(env, mapName, openTag, addArgs) {
  renumberMembers(env.graph, env.project, mapName);
  const idsBefore = idsWithTag(env, mapName, openTag);
  assert.ok(idsBefore.length > 0, `前提: ${mapName}:${openTag} に部材が無い`);
  // 追加前に覚えていた番号は tag に控える（伏図タップ由来のアンカーと同じ形）。id 優先なので結果には影響しない。
  const remembered = { ...anchorForCard(mapName, idsBefore), tag: openTag };
  const before = new Set(env.graph[mapName].keys());
  const added = ADDERS[mapName](env, addArgs);
  const newId = added.id;
  assert.ok(typeof newId === 'string' && !before.has(newId), '追加した部材 id が新規でない');
  const listing = listingFromGraph(env, mapName);
  const resolved = resolveExpandedCard(remembered, listing);
  assert.ok(resolved !== null, '開いていたカードが解決できない');
  return {
    idsBefore: idsBefore.join(','),
    idsByOldTag: idsWithTag(env, mapName, openTag).join(','),
    resolvedIds: [...resolved.ids].sort().join(','),
    resolvedTag: resolved.tag,
    newId, remembered, resolved,
  };
}

function expectShifted(r, newTag) {
  // 不良の記録: 番号で覚えていたら別の部材を指す（成り立たない fixture は再現でないので落とす）
  assert.notEqual(r.idsByOldTag, r.idsBefore, '前提: 番号がずれていない（再現になっていない）');
  assert.equal(r.resolvedIds, r.idsBefore);
  assert.equal(r.resolvedTag, newTag);
}

test('再現/柱 S造: 250角(C1)・150角(C2) の間に既定200角が入っても C2 を開いていたカードは元の 150 角を指す', () => {
  const env = makeEnv('S造');
  const [x1, x2, x3] = env.xs, [y1, , y3] = env.ys;
  assert.ok(findSectionEntry('STEEL-SQ250x250x9.0') && findSectionEntry('STEEL-SQ150x150x9.0'));
  env.graph.addColumn('STEEL', 'STEEL-SQ250x250x9.0', x1, y1, {});
  env.graph.addColumn('STEEL', 'STEEL-SQ150x150x9.0', x2, y1, {});
  const r = runRepro(env, 'columnMap', 'C2', { v: x3, h: y3 });
  expectShifted(r, 'C3');
});

test('再現/柱 在来木造: 個別柱 120(C1)・90(C2)、階柱寸 105 の共通柱が中間へ入っても C2 は 90 角を指す', () => {
  const env = makeEnv(TRADITIONAL_WOOD_STRUCTURE);
  const [x1, x2, x3] = env.xs, [y1, , y3] = env.ys;
  env.graph.setWoodColumnWidthMm(105);
  env.graph.addColumn('WOOD', 'WOOD-120x120', x1, y1, { woodColumnWidthMm: 120 });
  env.graph.addColumn('WOOD', 'WOOD-90x90', x2, y1, { woodColumnWidthMm: 90 });
  const r = runRepro(env, 'columnMap', 'C2', { v: x3, h: y3 });
  expectShifted(r, 'C3');
});

test('再現/独立基礎: 1500角(F1)・600角(F2) の間に既定 1000 角が入っても F2 は 600 角を指す', () => {
  const env = makeEnv('S造');
  const [x1, x2, x3] = env.xs, [y1, , y3] = env.ys;
  env.graph.addFooting('independent', 'RC-300x300', x1, y1, { materialType: 'RC', widthX: 1500, widthY: 1500 });
  env.graph.addFooting('independent', 'RC-300x300', x2, y1, { materialType: 'RC', widthX: 600, widthY: 600 });
  const r = runRepro(env, 'footingMap', 'F2', { v: x3, h: y3 });
  expectShifted(r, 'F3');
});

test('再現/梁 S造: H400x200(G1)・H150x150(G2) の間に既定 H200x100 が入っても G2 は H150 を指す', () => {
  const env = makeEnv('S造');
  const [x1] = env.xs, [y1, y2, y3] = env.ys;
  assert.ok(findSectionEntry('STEEL-H400x200') && findSectionEntry('STEEL-H150x150'));
  env.graph.addBeam('STEEL', 'STEEL-H400x200', x1, true, y1, y2, {});
  env.graph.addBeam('STEEL', 'STEEL-H150x150', x1, true, y2, y3, {});
  const r = runRepro(env, 'beamMap', 'G2', { axis: env.xs[2], s: y1, e: y2 });
  expectShifted(r, 'G3');
});

test('再現/対照 柱 S造: 追加が既存グループに入るなら同じカードが開いたままで ids に追加分が入る', () => {
  const env = makeEnv('S造');
  const [x1, x2, x3] = env.xs, [y1, , y3] = env.ys;
  env.graph.addColumn('STEEL', 'STEEL-SQ250x250x9.0', x1, y1, {});
  env.graph.addColumn('STEEL', 'STEEL-SQ200x200x9.0', x2, y1, {});
  const r = runRepro(env, 'columnMap', 'C2', { v: x3, h: y3 });
  assert.equal(r.resolvedTag, 'C2');
  const resolvedList = r.resolvedIds.split(',');
  assert.equal(resolvedList.length, r.idsBefore.split(',').length + 1);
  assert.ok(resolvedList.includes(r.newId));
  for (const id of r.idsBefore.split(',')) assert.ok(resolvedList.includes(id));
  // reconcileAnchor 後の ids に追加した id が含まれる
  const next = reconcileAnchor(r.remembered, r.remembered, r.resolved);
  assert.ok(next !== null);
  assert.ok(next.ids.includes(r.newId));
  assert.equal(next.tag, null);
});

// ================= 6. R4 の列 =================
test('R4: 全部材を消した一覧 → resolve null → reconcile null → 同じ id が戻ってもアンカーが null のまま', () => {
  const a = anchorForCard('columnMap', ['a', 'b'], 'a');
  const empty = [sec('col', 'columnMap', [])];
  const r1 = resolveExpandedCard(a, empty);
  assert.equal(r1, null);
  const a2 = reconcileAnchor(a, a, r1);
  assert.equal(a2, null);
  const back = [sec('col', 'columnMap', [card('C1', 'a', 'b')])];
  const r2 = resolveExpandedCard(a2, back);
  assert.equal(r2, null);
  assert.equal(reconcileAnchor(a2, a2, r2), null);
});

// ================= 7. 純モジュール性 =================
test('純モジュール: expandedMemberCard.js のソースに import 文が無い', () => {
  const src = readFileSync(fileURLToPath(new URL('./expandedMemberCard.js', import.meta.url)), 'utf8');
  // コメントはソース全体から除く（行頭だけを見ると「/* … */ import …」のような行を見逃す）。文字列の中に
  // import と書いた場合は誤って赤になる（安全側）。再エクスポート（export … from '…'）も依存なので禁止。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(code.split(/\r?\n/).filter(l => l.trim() !== '').length > 10, 'コメントを除いた本体が空');
  assert.ok(/export function resolveExpandedCard\(/.test(code), '本体を読めていない');
  assert.ok(!/\bimport\b/.test(code), 'import がある');
  assert.ok(!/\bfrom\s*['"]/.test(code), "from '…'（再エクスポート）がある");
  assert.ok(!/\brequire\s*\(/.test(code), 'require( がある');
});
