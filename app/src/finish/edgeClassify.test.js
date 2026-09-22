// classifyAxisLineType（軸CLの線種分類。selectBoundaryMasterがCANTILEVER_WALL/OUTDOOR_FACILITYの
// 判定に使う）の種別ベース化（centerLineKindPolicy.js統一。ステップ6、2026-09-20）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomKind, edgeKey } from '@core';
import fs from 'node:fs';
import { classifyAxisLineType, selectBoundaryMaster, buildCellToRoom } from './edgeClassify.js';
import { worldToCell } from './gridCells.js';
import { BOUNDARY_MASTERS } from './materials/boundaryMasters.js';

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}

// 4種別×labeled2値の総当り。struct(labeled:true)のみ「通り芯」、aux（lineType:dashed）は
// labeledの値を問わず「補助線」、それ以外（center・beam）は「中心線」——HEADの分岐（struct+labeled
// のみ特別扱いし、dashedかどうかだけで補助線/中心線を分ける）をそのまま踏襲する。
test('classifyAxisLineType: 4種別×labeled2値の総当り', () => {
  const graph = makeGraph();
  let v = 0;
  const cases = [
    { kind: 'struct', discipline: Discipline.STRUCT, lineType: 'center' },
    { kind: 'center', discipline: Discipline.ARCH,   lineType: 'center' },
    { kind: 'aux',    discipline: Discipline.ARCH,   lineType: 'dashed' },
    { kind: 'beam',   discipline: Discipline.FUSE,   lineType: 'center' },
  ];
  for (const { kind, discipline, lineType } of cases) {
    for (const labeled of [true, false]) {
      const cl = graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled, discipline, lineType });
      v += 1000;
      const expected = kind === 'struct' && labeled ? '通り芯'
        : kind === 'aux' ? '補助線'
        : '中心線';
      assert.equal(classifyAxisLineType(cl), expected, `kind=${kind} labeled=${labeled}`);
    }
  }
});

test('【旧データ限定・種別ベースへ統一】classifyAxisLineType: {discipline:STRUCT, labeled:true, lineType:dashed}はHEADの「通り芯」から、移行後は「補助線」になる', () => {
  const graph = makeGraph();
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 0,
    { labeled: true, discipline: Discipline.STRUCT, lineType: 'dashed' });
  assert.equal(classifyAxisLineType(legacy), '補助線',
    '旧実装（discipline===STRUCT&&labeled優先）は「通り芯」だったが、種別ベース（isGridCenterLine。' +
    'centerLineKindがlineType:dashedを先に見る）では「補助線」になる');
});

// ---- selectBoundaryMaster: 「無名屋外×有名屋外」の境界（edgeClassify.js pair(NAMED_EXTERIOR,
// ANON_EXTERIOR)分岐）は classifyAxisLineType(axisCL) の結果だけでOUTDOOR_FACILITY/CANTILEVER_WALLを
// 分ける（他の領域ペアはclassifyAxisLineTypeの結果を一切見ない——finishTopologyProbe.mjsの
// 検出力コメント参照）。
//
// axisProps で指定するCLは境界エッジの axisCLId（classifyAxisLineTypeの対象）としてのみ使う——
// 実際のセル分割（worldToCellが境界の両側で異なるセルを返すこと）は同じ座標に置いた別の中心線
// （divider）が担う。aux（補助線）は finish/gridCells.js 上そもそもセル分割線にならない
// （isFinishCellDivider が FINISH_CELL_DIVIDER_KINDS=['center'] にauxを含めない）ため、
// aux軸CLを使うケースでは分割自体を別のCLに委ねる必要がある——実データでも「分割線だったCLが
// 後から補助線化され、Room.cellsは分割時点のCL idを保持したまま」という遷移状態
// （finish/roomReinterpret.jsが扱う想定内の状態）に相当する。
function makeExteriorBoundaryGraph(axisProps) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const ARCH = { labeled: false, discipline: Discipline.ARCH };
  graph.addCenterLine(CenterLineType.VERTICAL, 0, ARCH); // x0（左端。変数参照は不要）
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, ARCH); // divider（実際の分割線。変数参照は不要）
  const axisCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { ...ARCH, ...axisProps }); // エッジのaxisCLId
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH); // x1（右端。変数参照は不要）
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, ARCH);

  const leftKey = worldToCell(500, 500, graph).key; // dividerが担う左セル
  const exterior = graph.addRoom(new Set([leftKey]), 'テラス');
  exterior.setKind(RoomKind.EXTERIOR);
  // 右セルは未割当のまま（無名屋外）

  const cellToRoom = buildCellToRoom(graph);
  const key = edgeKey(axisCL.id, y0.id, y1.id);
  return { graph, cellToRoom, key };
}

test('selectBoundaryMaster: 無名屋外×有名屋外の境界は、軸CLが補助線ならOUTDOOR_FACILITY・中心線ならCANTILEVER_WALL', () => {
  const aux = makeExteriorBoundaryGraph({ lineType: 'dashed' });
  assert.equal(selectBoundaryMaster(aux.key, aux.graph, aux.cellToRoom), 'OUTDOOR_FACILITY');

  const center = makeExteriorBoundaryGraph({ lineType: 'center' });
  assert.equal(selectBoundaryMaster(center.key, center.graph, center.cellToRoom), 'CANTILEVER_WALL');
});

test('【旧データ限定・種別ベースへ統一】selectBoundaryMaster: 無名屋外×有名屋外の境界で軸CLが{labeled:true, discipline:STRUCT, lineType:dashed}の旧データは、HEADのCANTILEVER_WALLから移行後はOUTDOOR_FACILITYになる', () => {
  const legacy = makeExteriorBoundaryGraph({ labeled: true, discipline: Discipline.STRUCT, lineType: 'dashed' });
  assert.equal(selectBoundaryMaster(legacy.key, legacy.graph, legacy.cellToRoom), 'OUTDOOR_FACILITY',
    '旧実装のclassifyAxisLineTypeはdiscipline===STRUCT&&labeledを最優先するため「通り芯」になり' +
    'CANTILEVER_WALLだったが、種別ベース（axisLineKindOf。centerLineKindがlineType:dashedを先に見る）' +
    'では「補助線」になりOUTDOOR_FACILITYになる');
});

// ---- ステップ7b 不変条件: selectBoundaryMaster が返し得るキーは全て BOUNDARY_MASTERS に実在する ----
// 境界マスターの読み出し口は切替なし（registry合成はしない・設計7b）——ハードコードした
// キー一覧ではなく selectBoundaryMaster 本体のソーステキストから `return 'XXX'` の
// リテラルを実際に抽出して照合する（新しい masterType 分岐がBOUNDARY_MASTERSに無いキーを
// 返す退行を、一覧の手動更新漏れに関係なく検知するため）。
test('【不変条件・ステップ7b】selectBoundaryMasterがソース中で返し得るキーは全てBOUNDARY_MASTERSに実在する（ハードコード一覧ではなくソースから抽出）', () => {
  const src = fs.readFileSync(new URL('./edgeClassify.js', import.meta.url), 'utf8');
  const bodyMatch = /export function selectBoundaryMaster\([\s\S]*?\n\}/.exec(src);
  assert.ok(bodyMatch, 'selectBoundaryMasterの関数本体がソースから見つからない');
  const body = bodyMatch[0];
  const keys = [...body.matchAll(/return '([A-Z_]+)'/g)].map(m => m[1]);
  assert.ok(keys.length >= 6, `抽出できたキーが少なすぎる（抽出漏れの疑い）: ${keys.join(',')}`);
  for (const key of keys) {
    assert.ok(BOUNDARY_MASTERS[key], `BOUNDARY_MASTERSに${key}が存在しない（selectBoundaryMasterのソース中で返している）`);
    assert.equal(BOUNDARY_MASTERS[key].key, key);
  }
});
