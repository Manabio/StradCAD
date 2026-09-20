// 分割格子（getAllCells）・区割り線（gridDividerSegments）・境界マスター種別
// （syncEdgesFromTopology 経由の graph.edges）・境界エッジの軸線区分（classifyAxisLineType の
// 戻り値そのもの）を実データで確認する probe（調査・回帰用。製品コードからは参照しない）。
//
// finish/gridCells.js の isDividerCL・isActiveAcrossRange・gridDividerSegments、
// finish/edgeClassify.js の classifyAxisLineType を種別ベースへ移行する前後で出力を突き合わせ、
// 挙動不変（差分0件）を確認する用途。
//
// axisLineType（classifyAxisLineType の戻り値）を edges とは別に出力するのは、masterType
// （selectBoundaryMaster）が「無名屋外×有名屋外」以外の領域ペアでは classifyAxisLineType の
// 戻り値を一切参照しない（'通り芯'/'中心線'のどちらでも同じ masterType に収束する）ため、
// masterType だけでは classifyAxisLineType の破壊を検出できない箇所があるため（検出力確認済み）。
//
// 【実データが踏まない経路】手元の検証データには、補助線（lineType:'dashed'のCL）・labeled と
// 種別が食い違う線（{labeled:true, discipline:ARCH}等の異常値）・STRUCT かつ破線・直進階段
// （StairType.STRAIGHT）が1件も含まれない。そのため「旧データ限定・種別ベースへ統一」と付記した
// 分岐（isFinishCellDivider・isActiveAcrossRange・gridDividerSegments・axisLineKindOf の異常値側）
// と、階段下分割CL（finish/stair/stairUnderSplit.js）は本 probe では一度も踏まれない——これらは
// 単体テスト（ピン留め・総当り・変異テスト）でのみ保証する。
//
// 【実アプリの境界処理からの意図的な省略】
// finish/finishBoundary.js runFinishEntryBoundary が実際に呼ぶ手順のうち、
// reinterpretRoomsOnEntry→normalizePartialDominance→ensureStairRooms→syncEdgesFromTopology
// の4関数（いずれも同期・graph のみに作用し、cells/edges の形を決める）は本 probe でも
// 同じ順序で呼ぶ。以下は意図的に省く（対象関数の出力に影響しないため）:
//   - ensureTopStairVoid: 最上階への階段吹抜け補完（Stair.roomId の解決）。IndexedDB peek を
//     要求するうえ、isDividerCL・classifyAxisLineType が見る CL の種別・extent を変えない——
//     ただし、これが補完しうる階段吹抜け Room 自体は本 probe では生成されないため、その Room に
//     由来する edge・cell の割当（該当階が最上階でStair.roomIdが未解決の場合のみ発生）は測れない
//     （実データではensureStairRoomsが同種の補完を担っており、この経路が発生する階は無い）。
//   - conformWoodBacking: 壁下地材コードの選択。壁の生成（regenerateWalls）より前段の話で、
//     本 probe が見る CL 種別・Room トポロジーには無関係。
//   - pullCLEccentricities: clEccentricities レコードの取り込みのみで graph.edges・cells の
//     形は変えない。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/finishTopologyProbe.mjs [出力先] [入力.stq]
import fs from 'node:fs';
import path from 'node:path';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { getAllCells, gridDividerSegments } from '../../src/finish/gridCells.js';
import { syncEdgesFromTopology, classifyAxisLineType, edgeGeometry, buildCellToRoom } from '../../src/finish/edgeClassify.js';
import { reinterpretRoomsOnEntry, normalizePartialDominance, ensureStairRooms } from '../../src/finish/roomReinterpret.js';

const outDir = process.argv[2] ?? path.join(import.meta.dirname, 'out', 'finish-topology');
const src = process.argv[3] ?? 'D:/tatsuya/Download/11.stq';
fs.mkdirSync(outDir, { recursive: true });

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const { project } = loadDocument(src);
const summary = [];
for (const p of project.planes) {
  const graph = project.graphMap.get(p.id);
  if (!graph) continue;

  runInAction(() => {
    reinterpretRoomsOnEntry(graph);
    normalizePartialDominance(graph);
    ensureStairRooms(graph);
    syncEdgesFromTopology(graph);
  });

  const cells = getAllCells(graph)
    .map(c => ({ key: c.key, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 }))
    .sort(byKey);
  const segs = gridDividerSegments(graph)
    .map(s => ({ key: s.key, isVertical: s.isVertical, value: s.value, lo: s.lo, hi: s.hi }))
    .sort(byKey);
  const edges = graph.edges
    .map(e => ({ key: e.key, masterType: e.masterType ?? null }))
    .sort(byKey);

  // axisLineType: classifyAxisLineType の戻り値そのもの（境界エッジの軸CLごと）。
  // masterType が収束して見分けが付かない箇所（無名屋外×有名屋外以外のペア）も含めて
  // 全境界エッジで採る——edgeGeometry が解決できないエッジ（軸/端点CL不明）はスキップ。
  const cellToRoom = buildCellToRoom(graph);
  const axisLineTypes = graph.edges
    .map(e => {
      const geo = edgeGeometry(e, graph, cellToRoom);
      if (!geo) return null;
      return { key: e.key, axisLineType: classifyAxisLineType(geo.axisCL) };
    })
    .filter(Boolean)
    .sort(byKey);

  const name = p.name.replace(/[^\w一-龥ぁ-んァ-ヶー]/g, '_');
  fs.writeFileSync(path.join(outDir, `topo-${name}.json`),
    JSON.stringify({ cells, segs, edges, axisLineTypes }, null, 1));
  summary.push({ plane: p.name, cells: cells.length, segs: segs.length, edges: edges.length });
}
fs.writeFileSync(path.join(outDir, 'topo-summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
