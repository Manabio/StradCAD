// modes/StructuralModeState.js の選択集合（selectedMemberIds。構造リスト→伏図ハイライト）の単体テスト。
// init()（ステップ8g・断面カタログの未解決検出）はsectionCatalog.test.jsの
// 「未知のsectionDefIdを持つ梁はsectionWidthが既定300へ落ち、recomputeStructuralForGraphは
// 例外を投げない」と同じ Project/addPlane フィクスチャ型を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StructuralModeState } from './StructuralModeState.js';
import { Project, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { applyDocumentCodeNormalization, takeUnresolvedCodes, addDocumentAliases, clearDocumentAliases } from '../catalog/codeNormalization.js';
import { CatalogKind } from '../catalog/catalogKinds.js';

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

// ---- init（ステップ8g・断面カタログの未解決検出。裁定Q-C: 検出は構造モード突入時） ----

function makeGraph() {
  const project = new Project('proj-structural-mode-init', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = 'S造'; // S造はwallBeamAxes/framingが無く下階peekが要らないため最小構成で足りる
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  return { project, graph, x0, x1, y0 };
}

test('init: 既知のsectionDefIdだけの柱・梁は場面(b)unresolved-codeの行を作らない。materialErrorに相当するブロッキングエラーも無い', async () => {
  const { graph, x0, x1, y0 } = makeGraph();
  graph.addColumn(StructuralMaterialType.STEEL, 'STEEL-H300x150', x0, y0, {});
  graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-H300x150', y0, false, x0, x1, { role: 'primary' });

  const s = new StructuralModeState(graph);
  const result = await s.init();

  assert.equal(result.ok, true);
  assert.deepEqual(result.catalogResolveRows, []);
  assert.deepEqual(s.catalogResolveRows, []);
});

test('init: 未知のsectionDefIdを持つ梁がある場合、場面(b)unresolved-codeの行が立つ（usage.locationはgraphのプロパティ名）', async () => {
  const { graph, x0, x1, y0 } = makeGraph();
  const unknownBeam = graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-NO-SUCH-KEY', y0, false, x0, x1, { role: 'primary' });

  const s = new StructuralModeState(graph);
  const result = await s.init();

  assert.equal(result.ok, true, '未解決があってもokはtrue（既定フォールバックで図面・構造再計算は止まらない契約）');
  assert.equal(result.catalogResolveRows.length, 1);
  const [row] = result.catalogResolveRows;
  assert.equal(row.kind, 'section');
  assert.equal(row.scenario, 'unresolved-code');
  assert.equal(row.targetKey, 'STEEL-NO-SUCH-KEY');
  assert.equal(row.usage.length, 1);
  assert.equal(row.usage[0].location, 'beams');
  assert.equal(row.usage[0].memberId, unknownBeam.id);
  assert.equal(s.catalogResolveRows, result.catalogResolveRows, 'this.catalogResolveRowsにも戻り値と同じ配列が反映される');
});

test('init: 同じ未知sectionDefIdを複数部材（柱・梁）が参照する場合は1行にまとまり、usageに両方が入る', async () => {
  const { graph, x0, x1, y0 } = makeGraph();
  const unknownColumn = graph.addColumn(StructuralMaterialType.STEEL, 'STEEL-NO-SUCH-KEY', x0, y0, {});
  const unknownBeam = graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-NO-SUCH-KEY', y0, false, x0, x1, { role: 'primary' });

  const s = new StructuralModeState(graph);
  const { catalogResolveRows } = await s.init();

  assert.equal(catalogResolveRows.length, 1, '同じコードは1行にグルーピングされる（buildResolveRowsの契約）');
  const locations = catalogResolveRows[0].usage.map(u => u.location).sort();
  assert.deepEqual(locations, ['beams', 'columns']);
  const memberIds = catalogResolveRows[0].usage.map(u => u.memberId).sort();
  assert.deepEqual(memberIds, [unknownBeam.id, unknownColumn.id].sort());
});

test('【失敗系】init: 未知のsectionDefIdがあっても例外を投げない（sectionWidthは既定300へ落ちる。sectionCatalog.test.jsと同じ契約）', async () => {
  const { graph, x0, x1, y0 } = makeGraph();
  const beam = graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-NO-SUCH-KEY', y0, false, x0, x1, { role: 'primary' });
  assert.equal(beam.sectionWidth, 300);

  const s = new StructuralModeState(graph);
  await assert.doesNotReject(() => s.init());
});

test('init: peekUnresolvedCodes()（全階累積・kind=section）で蓄積された未解決も、自階に生きた参照が無くても合流する（FinishModeState.init._buildUnresolvedCodeRowsと同型）', async () => {
  // codeNormalization.js の documentAliasesByKind/unresolvedAccumulator は全種別共有・
  // モジュールスコープのため、他テストへ漏れないよう try/finally で必ず後始末する。
  // normalizeCode（codeNormalization.js）は「コード表に無い」ではなく「コード表にあって
  // 解決先がnull（廃止まで潰れた）」ときだけunresolvedへ積む——section用のlegacy表は空
  // （legacyTableFor）のため、文書固有の読み替え(addDocumentAliases)にto:nullを明示的に
  // 積んで初めて再現できる（section・boundaryMaster等でこの経路が実際に使われることは
  // 無い＝設計コメント「実質空」の意味そのもの。ここでは仕組みの疎通だけを確認する）。
  try {
    addDocumentAliases(CatalogKind.SECTION, [{ from: 'STEEL-GHOST', to: null }]);
    // 他階のデコード時に蓄積されたのと同じ経路（applyDocumentCodeNormalization）で
    // kind=sectionの未解決コードを1件積む（自階のgraphには一切登場しない架空の部材）。
    applyDocumentCodeNormalization({ beams: [{ id: 'other-floor-beam', sectionDefId: 'STEEL-GHOST' }] });

    const { graph } = makeGraph(); // 自階には未知のsectionDefIdを持つ部材が無い
    const s = new StructuralModeState(graph);
    const { catalogResolveRows } = await s.init();

    assert.equal(catalogResolveRows.length, 1, '自階に無くてもpeekUnresolvedCodes()経由で1行合流する');
    assert.equal(catalogResolveRows[0].targetKey, 'STEEL-GHOST');
    assert.equal(catalogResolveRows[0].usage[0].location, 'beams');
    assert.equal(catalogResolveRows[0].usage[0].memberId, 'other-floor-beam');
  } finally {
    takeUnresolvedCodes(); // 蓄積をリセットし、他テストへ漏らさない
    clearDocumentAliases(); // documentAliasesByKind['section']をリセットし、他テストへ漏らさない
  }
});
