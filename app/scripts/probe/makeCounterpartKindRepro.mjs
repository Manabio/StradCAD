// 課題(i)（cl-conversion-limits.md 限界16 (i)）S0: 再現用 .stq の作成（実データの構成が足りない場合の保険）。
// 目的: 在来木造の2階建てで、ある階の同座標(y=3000)に「梁芯が中心線より先に shapeMap へ並ぶ」配置を作り、
//   1階と2階が吹抜け(VOID)または階段(STAIR/STAIR_VOID の Room feature)で結ばれ、その辺の内壁が y=3000 の中心線上にある文書を書く。
//   構成: x=0,6000 / y=0,3000,6000 の中心線（ARCH）。1階 = 部屋A1(y0..3000)・B1(y3000..6000)。
//   2階 = 部屋(y0..3000, feature あり)・部屋(y3000..6000)。梁芯は FUSE・由来 user・y=3000 の x0..6000。
// 引数: <variant> <出力.stq>
//   ctl-void      梁芯なし。吹抜け連動（対照）
//   a-void-upper  2階(VOID を持つ階)に梁芯を中心線より先に並べる。吹抜け連動。1階をアクティブにすると相手階で、2階をアクティブにすると自階で効く
//   b-shaft-lower 1階に梁芯を中心線より先に並べる。昇降路(ELEVATOR_EQUIPMENT)連動＝階段と同格の stair 連動（1階アクティブで自階の探し直しが効く。
//                 実体の Stair を持たない STAIR/STAIR_VOID の Room は境界処理が feature を undefined に戻すため昇降路で代用）
//   ctl-shaft     梁芯なし。昇降路連動（対照）
//   出力が既存なら上書きせず終了する。
// 使い方（ローダー必須。app/ で実行）:
//   node --import ./scripts/testSetup.mjs scripts/probe/makeCounterpartKindRepro.mjs a-void-upper D:/tatsuya/Download/i-repro-a-void-upper.stq
// 出力: 標準出力に作成内容（各階の同座標の並び順・往復検証結果）、.stq。
import fs from 'node:fs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, CenterLineType, Discipline, RoomFeature } from '../../src/core.js';
import { centerLineKind } from '../../src/core/centerLine.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { runFinishEntryBoundary } from '../../src/finish/finishBoundary.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../src/structural/structureRules.js';
import { convergeProject } from './hAnchorCoverageProbe.mjs';
import { runInAction } from 'mobx';
import { loadMaterialMap, regenerateWalls } from '../../src/finish/wallRegeneration.js';
import { wallFreshnessKey } from '../../src/finish/wallFreshnessKey.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { conformWoodBacking } from '../../src/structural/woodAutoFill.js';

const [variant, outPath] = process.argv.slice(2);
const VARIANTS = {
  'ctl-void':      { link: 'void', beamFirst: [] },
  'a-void-upper':  { link: 'void', beamFirst: ['2階'] },
  'b-shaft-lower': { link: 'shaft', beamFirst: ['1階'] },
  'ctl-shaft':     { link: 'shaft', beamFirst: [] },
};
if (!VARIANTS[variant] || !outPath) { console.error(`usage: makeCounterpartKindRepro.mjs <${Object.keys(VARIANTS).join('|')}> <out.stq>`); process.exit(1); }
if (fs.existsSync(outPath)) { console.error(`既存ファイルを上書きしません: ${outPath}`); process.exit(1); }
const { link, beamFirst } = VARIANTS[variant];

const project = new Project('i-repro', 'i-repro');
project.structuralInfo.setField('mainStructure', TRADITIONAL_WOOD_STRUCTURE);
const { graph: g1 } = project.addPlane(0, '1階', 'p1');
const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
project.activePlaneId = 'p2';
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

function build(graph, name, feats) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 6000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  // 梁芯を中心線 y=3000 より先に並べる（shapeMap の挿入順）。由来 user は自動撤去の対象外。
  if (beamFirst.includes(name)) {
    graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, {
      labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 6000, beamAxisOrigin: 'user',
    });
  }
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: false, discipline: Discipline.ARCH });
  const a = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${ym.id}`]), feats[0].name);
  if (feats[0].feature) a.setFeature(feats[0].feature);
  graph.addRoom(new Set([`${x0.id}:${ym.id}:${x1.id}:${y1.id}`]), feats[1].name);
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
}
// 'shaft' = 昇降路(ELEVATOR_EQUIPMENT)を両階に置く。shaftOrStairLinks では STAIR と同格の「stair」連動。
// 実体の Stair を持たない STAIR/STAIR_VOID の Room は境界処理が feature を undefined に戻すため使えない（実測）。
const f1 = link === 'void' ? [{ name: '部屋A1' }, { name: '部屋B1' }] : [{ name: '昇降路', feature: RoomFeature.ELEVATOR_EQUIPMENT }, { name: '部屋B1' }];
const f2 = link === 'void' ? [{ name: '吹抜け', feature: RoomFeature.VOID }, { name: '部屋B2' }] : [{ name: '昇降路', feature: RoomFeature.ELEVATOR_EQUIPMENT }, { name: '部屋B2' }];
build(g1, '1階', f1);
build(g2, '2階', f2);
await runFinishEntryBoundary(g1, project);
await runFinishEntryBoundary(g2, project);
// 壁を生成する（convergeProject は壁も鍵も無い階を飛ばすため、最初の壁再生成をここで行う）
const materialMap = await loadMaterialMap();
for (const g of [g1, g2]) {
  runInAction(() => conformWoodBacking(g, project));
  const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(g, project, floorSwapManager.peek);
  const { regenerated } = await regenerateWalls(g, { materialMap, project, stairUnderEntries, extraStairOpenings });
  if (regenerated) g.setWallFreshnessKey(wallFreshnessKey(g, project));
}
const conv = await convergeProject(project);
console.log(`variant=${variant} link=${link} beamFirst=${JSON.stringify(beamFirst)} 収束sweep=${conv}`);

// 並び順の確認（graph.centerLines 順で y=3000 の種別）
const orderOf = (g) => g.centerLines.filter(c => c.centerLineType === CenterLineType.HORIZONTAL && Math.abs(c.value - 3000) < 1e-6).map(centerLineKind).join('<');
console.log(`  1階 y=3000 の並び: ${orderOf(g1)} / 2階: ${orderOf(g2)}`);
for (const g of [g1, g2]) console.log(`  ${g.plane.name}: rooms=${g.rooms.map(r => `${r.name}:${r.feature ?? '-'}`).join(',')} INTERIOR_WALLエッジ=${g.edges.filter(e => e.masterType === 'INTERIOR_WALL').length} 壁=${g.walls.length}`);

// 往復検証して保存
const digest = (proj) => JSON.stringify(proj.planes.map(pl => {
  const g = proj.graphMap.get(pl.id);
  return [pl.name, g.walls.length, g.centerLines.map(c => `${c.centerLineType}:${Math.round(c.effectiveValue)}:${centerLineKind(c)}`),
    g.rooms.map(r => `${r.name}:${r.feature ?? ''}`)];
}));
const floors = project.planes.map(p => ({ planeId: p.id, bytes: serializeGraph(project.graphMap.get(p.id)) }));
const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
const json = buildDocumentJson({ floors, struct, planes: serializePlanes(project), site: null, info: null, bootPlaneId: project.activePlaneId });
const doc = parseDocumentEnvelope(JSON.parse(json));
const p2 = new Project('probe', 'probe');
restoreStructCLs(p2.structGraph, p2.structuralInfo, doc.struct, p2.memberGroupLedger);
const { planes: decoded, glBelow1FlMm } = decodePlanes(doc.planes);
for (const p of decoded) {
  p2.addPlane(p.elevation, p.name, p.id, p.startFloor, p.stories, p.isAlternative, p.referenceId, p.altIndex, p.isRoofPlane, p.roofForPlaneId, p.planCutHeightMm, p.ceilingCutHeightMm, p.topStoryHeightMm);
}
p2.setGlBelow1FlMm(glBelow1FlMm ?? 0);
for (const f of doc.floors) restoreGraph(p2.graphMap.get(f.planeId), f.bytes);
if (digest(project) !== digest(p2)) { console.error('NG: 往復不一致'); process.exit(1); }
for (const pl of p2.planes) console.log(`  往復後 ${pl.name} y=3000 の並び: ${orderOf(p2.graphMap.get(pl.id))}`);
if (p2.structuralInfo.mainStructure !== project.structuralInfo.mainStructure) { console.error('NG: 主構造が往復で変わった'); process.exit(1); }
fs.writeFileSync(outPath, json);
console.log(`OK: 往復一致・保存 ${outPath} (${json.length} bytes) mainStructure=${p2.structuralInfo.mainStructure}`);
