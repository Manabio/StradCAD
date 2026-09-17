// interaction/beamTap.js の columnAtKonvaTarget（構造モードの柱タップ。ステップ4「柱は共通と個別指定の
// 2層」・在来木造の自階柱□のみ）の単体テストと、配線側（usePointerInteraction.js・renderer/
// StructuralLayer.jsx）のソース走査不変条件。beamAtKonvaTarget と対の関数のため beamTap.js に置くが、
// テストファイル自体は柱タップ専用に分ける（team-lessons「抽出モジュールは呼び出し側もテストで守る」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { columnAtKonvaTarget } from './beamTap.js';

const readSrc = rel => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');

function fakeGraph(columns) {
  return { columnMap: new Map(columns.map(c => [c.id, c])) };
}

test('columnAtKonvaTarget: ターゲット自身がcolumnId属性を持てばgraph.columnMapから解決する', () => {
  const graph = fakeGraph([{ id: 'c1' }]);
  const target = { getAttr: k => (k === 'columnId' ? 'c1' : null) };
  assert.equal(columnAtKonvaTarget(target, graph), graph.columnMap.get('c1'));
});

test('columnAtKonvaTarget: ターゲット自身に無くても祖先の<Group name="column-symbol">のcolumnIdから解決する', () => {
  const graph = fakeGraph([{ id: 'c2' }]);
  const ancestor = { getAttr: k => (k === 'columnId' ? 'c2' : null) };
  const target = { getAttr: () => null, findAncestor: sel => (sel === '.column-symbol' ? ancestor : null) };
  assert.equal(columnAtKonvaTarget(target, graph), graph.columnMap.get('c2'));
});

test('【失敗系】columnAtKonvaTarget: columnId属性が無い・祖先も無い・未知のid・target自体が無い/getAttrを持たない・graphがcolumnMapを持たない場合はnull', () => {
  const graph = fakeGraph([{ id: 'c1' }]);
  const noAttr = { getAttr: () => null, findAncestor: () => null };
  assert.equal(columnAtKonvaTarget(noAttr, graph), null, 'columnId属性・祖先とも無い');
  const unknown = { getAttr: k => (k === 'columnId' ? 'no-such-id' : null) };
  assert.equal(columnAtKonvaTarget(unknown, graph), null, '未知のid');
  assert.equal(columnAtKonvaTarget(null, graph), null, 'targetがnull');
  assert.equal(columnAtKonvaTarget({}, graph), null, 'targetがgetAttrを持たない（非Konvaオブジェクト）');
  assert.equal(columnAtKonvaTarget({ getAttr: k => (k === 'columnId' ? 'c1' : null) }, null), null, 'graphがnullでも例外を投げない');
  assert.equal(columnAtKonvaTarget({ getAttr: k => (k === 'columnId' ? 'c1' : null) }, {}), null, 'graph.columnMapが無くても例外を投げない');
});

// ---- 配線の不変条件（usePointerInteraction.js が実際にこの関数を使っているか）----

test('【不変条件】usePointerInteraction.js: 構造モードの梁タップ分岐に、梁タップの直後・空白タップ判定の前でcolumnAtKonvaTargetを呼ぶ柱タップの分岐がある', () => {
  const src = readSrc('./usePointerInteraction.js');
  assert.ok(/import\s*\{[^}]*\bcolumnAtKonvaTarget\b[^}]*\}\s*from\s*'\.\/beamTap\.js'/.test(src),
    'columnAtKonvaTarget を beamTap.js から import していない');
  assert.ok(/const column = columnAtKonvaTarget\(e\.target,\s*graph\)/.test(src),
    'columnAtKonvaTarget(e.target, graph) の呼び出しが見つからない');
  // 「梁タップ→柱タップ→空白タップ」の順のelse ifチェーンになっている（梁に当たったタップ・
  // 柱に当たったタップの両方で選択解除が走らない構造）。
  assert.ok(/if\s*\(\s*beam\s*\)\s*onMemberClick\(beam,\s*'beamMap'\);\s*\n\s*else if\s*\(\s*column\s*\)\s*onMemberClick\(column,\s*'columnMap'\);/.test(src),
    "if (beam) onMemberClick(beam, 'beamMap'); の直後に else if (column) onMemberClick(column, 'columnMap'); が続いていない");
  assert.ok(/if\s*\(\s*beam\s*\)\s*onMemberClick\(beam,\s*'beamMap'\);[\s\S]{0,600}?else if\s*\(isBlankTapTarget\(e\.target\)\)\s*onMemberDeselect\?\.\(\);/.test(src),
    '梁タップ→柱タップ→空白タップの順のelse ifチェーンが崩れている（blankTapDeselect.test.jsの不変条件と食い違う）');
});

// ---- 配線の不変条件（renderer/StructuralLayer.jsx が自階柱□にだけ pick を有効化しているか）----

test('【不変条件】StructuralLayer.jsx: pickColumnsOnFigureの結果とcategory===columnMapSelfの論理積をColumnsLayerへpickとして渡す', () => {
  const src = readSrc('../renderer/StructuralLayer.jsx');
  assert.ok(/import\s*\{[^}]*\bpickColumnsOnFigure\b[^}]*\}\s*from\s*'\.\.\/structural\/framingDrawing\.js'/.test(src),
    'pickColumnsOnFigure を structural/framingDrawing.js から import していない');
  assert.ok(/const pickColumns = onMemberClick && pickColumnsOnFigure\(/.test(src),
    'pickColumns が pickColumnsOnFigure(...) の否定（onMemberClick 有無との論理積）でゲートされていない');
  assert.ok(/pick=\{pickColumns && g\.category === 'columnMapSelf'\}/.test(src),
    "pick={pickColumns && g.category === 'columnMapSelf'} がColumnsLayerへ渡されていない（下階柱×グループにもpickが有効化される回帰）");
});

test('【不変条件】StructuralLayer.jsx: ColumnsLayerはpick=trueのときだけ<Group name="column-symbol" columnId={column.id}>で包み、onClick/onTapは持たない', () => {
  const src = readSrc('../renderer/StructuralLayer.jsx');
  assert.ok(/name="column-symbol"/.test(src), '<Group name="column-symbol"> が見つからない');
  const groupMatch = /<Group\s*\n\s*key=\{`pick:\$\{column\.id\}`\}\s*\n\s*name="column-symbol"([\s\S]*?)>/.exec(src);
  assert.ok(groupMatch, '<Group key={`pick:${column.id}`} name="column-symbol" ...> が見つからない');
  const groupProps = groupMatch[1];
  assert.ok(/columnId=\{column\.id\}/.test(groupProps), 'columnId={column.id} が渡されていない（usePointerInteraction.jsのcolumnAtKonvaTargetが解決できない回帰）');
  assert.ok(!/onClick=/.test(groupProps), 'onClick が残っている（梁タップと同じ理由でKonvaのonclick/onTapは使わない）');
  assert.ok(!/onTap=/.test(groupProps), 'onTap が残っている（同上）');
  // pick=falseなら配列をそのまま返す（三項）——非pick経路（下階柱×・非在来）はReactツリー不変。
  assert.ok(/return pick\s*\n\s*\?\s*\[/.test(src), 'ColumnsLayerの戻り値がpick時だけ<Group>で包む三項になっていない');
});
