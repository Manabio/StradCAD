// 階段の側面の出入口（取りつき区画）と踊場付直進の展開図を、実データに無い構成で実機確認するためのテスト用 .stq を作るスクリプト。
// 問題.md「展開図の階段を平面に揃える（続き）」T1（U 字系の到達口 a=0/a≥1 の暫定規則 Q2/Q3）・T2（直進系）の目視用。
//
// 2026模擬試験.stq（在来木造・3 階建て）の 1 階の階段（直進 15 段・1 セル x0..1820 × y-9100..-7280・上り方向 up＝南の y-7280 が上り口）を
// 土台に、階段の周りの通り芯（y と x）を足して階段のセルを細かくし（セルの保存は refreshCells。区画の実測は保存セルで測るため、
// 細分化後のセルを階段に持たせる）、型・段数・出入口・構造を変えた別々の文書を作る。壁は本番と同じ手順
// （conformWoodBacking → resolveStairContext → regenerateWalls → 鮮度キー）で再生成し、構造再計算（sweepUntilConverged）まで通す。
//   stair-ports-test1.stq … 直進・木造: 上り口が左の側面 e=2・到達口が右の側面 a=1（sections [12]。区画の扇形）
//   stair-ports-test2.stq … 直進・鉄骨: 上り口が左の側面 e=0（平場）・到達口が右の側面 a=0（平場）（sections [15]）
//   stair-ports-test3.stq … 踊場付直進・木造: 走行端の口（sections [7,1,8]。踊り場あり）
//   stair-ports-test4.stq … 折返し・鉄骨: 上り口・到達口とも側面で e=0・a=0（平場。T1 の Q2/Q3 の目視用）
//   stair-ports-test5.stq … 折返し・木造: 上り口 e=1・到達口 a=2（T1 の到達口 a≥1 の目視用）
// 木造の側面の口は取りつき最低 1 段（alignPortStairsOnGraph）なので、平場（0）は鉄骨で作る。
//   stair-ports-test6.stq … 直進・木造・走行端の口・sections [15]・2階にも続きの直進階段（E5-2 の足場。upper）
//   stair-ports-test7.stq … 踊場付直進・木造・[7,1,8]（test3 と同じ ys）・2階にも続きの階段（upper）
// upper の variant は、2階の足元の STAIR_VOID を外して 1階の階段を 2階へ写し（copyStairsToGraph）、3階に STAIR_VOID を作る
// （reconcileStairVoids）。2階の階段が 1階の「続き」（matchingStairBelow）で裏面が引けること・両階の切断線が足元の辺に乗ること
// （straightPlanLayout の run.base の差）を expect で確かめる。
// 作ったあとの確認と golden の採取（app/ から。golden は文書ごとのサブディレクトリ）:
//   node --import ./scripts/testSetup.mjs scripts/probe/diffStairElevPlan.mjs D:/tatsuya/Download/stair-ports-test1.stq   … 不一致 0（exit 0）
//   node --import ./scripts/testSetup.mjs scripts/probe/dumpElevFigure.mjs scripts/probe/golden-elev-stairports/stair-ports-test1 D:/tatsuya/Download/stair-ports-test1.stq --regen
//   node scripts/probe/diffElevGolden.mjs scripts/probe/golden-elev-stairports/stair-ports-test1 <新しい出力dir>   … 一致で exit 0
// （test2〜7 も同じ。採取は stair-ports-test1〜7 の 7 文書）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeStairPortsTestDoc.mjs [出力先の接頭辞（既定 D:/tatsuya/Download/stair-ports-test）] [--variants 6,7]
// 既存ファイルは上書きしない（選んだ variant の出力先 <接頭辞>N.stq が 1 つでも在れば何も作らず終了）。
// --variants 省略時は全 variant が対象、指定時は選んだ番号だけが作成・既存検査の対象（test1〜5 が在っても 6・7 だけ作れる）。
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, CenterLineType, Discipline, StairType, StairPortSide, StructuralMaterialType, RoomFeature } from '../../src/core.js';
import { refreshCells } from '../../src/finish/gridCells.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadMaterialMap, regenerateWalls } from '../../src/finish/wallRegeneration.js';
import { wallFreshnessKey } from '../../src/finish/wallFreshnessKey.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { conformWoodBacking } from '../../src/structural/woodAutoFill.js';
import { wallBackingCenters, mapBackingCenterMoves } from '../../src/structural/wallBeamAxes.js';
import { followWallBeamAxes } from '../../src/structural/wallBeamAxisFollow.js';
import { alignPortStairsOnGraph } from '../../src/finish/stair/stairSectionEdit.js';
import { straightPlanLayout, uTurnPlanLayout } from '../../src/finish/stair/stairGeometry.js';
import { measureStairSpans } from '../../src/finish/stair/stairClassify.js';
import { sweepUntilConverged } from './sweepOrder.mjs';
import { copyStairsToGraph } from '../../src/finish/stair/stairFloorCopy.js';
import { reconcileStairVoids } from '../../src/finish/stair/stairVoidReconcile.js';
import { floorHeightAbove, stairRiserOf } from '../../src/finish/stair/stairDimensions.js';
import { matchingStairBelow } from '../../src/structural/openingBeamAxes.js';
import { stairSoffitAbove } from '../../src/elevation/space/stairSoffitCeiling.js';

const args = process.argv.slice(2);
const vIdx = args.indexOf('--variants');
const variantArg = vIdx >= 0 ? args[vIdx + 1] : null;
if (vIdx >= 0 && (variantArg == null || variantArg.startsWith('--'))) {
  console.error('用法: --variants には番号の並び（例: 6,7）を指定してください');
  process.exit(2);
}
if (vIdx >= 0) args.splice(vIdx, 2);
const prefix = args[0] ?? 'D:/tatsuya/Download/stair-ports-test';
const srcPath = 'D:/tatsuya/Download/2026模擬試験.stq';
const ARCH = { labeled: false, discipline: Discipline.ARCH };
const { LEFT, RIGHT } = StairPortSide;

const X_MID = 910;

// 追加する通り芯（y は上り口側から: 先頭の行の境界・次の境界。x は U 字の中央）
const VARIANTS = [
  {
    n: 1, title: '直進・木造・上り口 e=2（左）・到達口 a=1（右）',
    ys: [-7900, -8500], xs: [],
    apply: () => ({ type: StairType.STRAIGHT, structure: StructuralMaterialType.WOOD, sections: [12], entrySide: LEFT, entryTurnSteps: 2, arrivalSide: RIGHT, arrivalTurnSteps: 1 }),
    expect: (stair, graph) => { const p = straightPlanLayout(stair, graph); return p?.entryPort === 'side' && p.arrivalPort === 'side' && p.entryTurnSteps === 2 && p.arrivalTurnSteps === 1; },
  },
  {
    n: 2, title: '直進・鉄骨・上り口 e=0（左・平場）・到達口 a=0（右・平場）',
    ys: [-7900, -8500], xs: [],
    apply: () => ({ type: StairType.STRAIGHT, structure: StructuralMaterialType.STEEL, sections: [15], entrySide: LEFT, entryTurnSteps: 0, arrivalSide: RIGHT, arrivalTurnSteps: 0 }),
    expect: (stair, graph) => { const p = straightPlanLayout(stair, graph); return p?.entryPort === 'side' && p.arrivalPort === 'side' && p.entryTurnSteps === 0 && p.arrivalTurnSteps === 0 && p.totalSteps === 15; },
  },
  {
    n: 3, title: '踊場付直進・木造・走行端の口（踊り場あり）',
    // 1820 の走行方向を 3 つの区間（直進部 910・踊り場 300・直進部 610）に分ける。y-8190 は元の文書に在る通り芯
    // （階段室の中ほど。通り芯一覧には出ない補助線）なので足さない。実測で 3 区間になること（measureStairSpans）を expect で確かめる
    ys: [-8190, -8490], xs: [],
    apply: () => ({ type: StairType.STRAIGHT_LANDING, structure: StructuralMaterialType.WOOD, sections: [7, 1, 8], entrySide: null, entryTurnSteps: 0, arrivalSide: null, arrivalTurnSteps: 0 }),
    expect: (stair, graph) => {
      const p = straightPlanLayout(stair, graph);
      const lens = measureStairSpans(stair, graph)?.lengths;
      return p?.hasLanding === true && p.entryPort === 'end' && p.arrivalPort === 'end' && p.run.land1 !== p.run.land2
        && Array.isArray(lens) && lens.length === 3 && Math.abs(lens[0] - 910) < 1e-6 && Math.abs(lens[1] - 300) < 1e-6 && Math.abs(lens[2] - 610) < 1e-6;
    },
  },
  {
    n: 4, title: '折返し・鉄骨・上り口 e=0・到達口 a=0（ともに側面・平場）',
    ys: [-7900, -8500], xs: [X_MID],
    apply: () => ({ type: StairType.SWITCHBACK, structure: StructuralMaterialType.STEEL, sections: [6, 1, 6], entryTurnSteps: 0, arrivalTurnSteps: 0 }),
    sides: true,
    expect: (stair, graph) => { const p = uTurnPlanLayout(stair, graph); return p?.entryPort !== 'end' && p?.arrivalPort !== 'end' && p.entryTurnSteps === 0 && p.arrivalTurnSteps === 0; },
  },
  {
    n: 5, title: '折返し・木造・上り口 e=1・到達口 a=2（ともに側面）',
    ys: [-7900, -8500], xs: [X_MID],
    apply: () => ({ type: StairType.SWITCHBACK, structure: StructuralMaterialType.WOOD, sections: [6, 1, 6], entryTurnSteps: 1, arrivalTurnSteps: 2 }),
    sides: true,
    expect: (stair, graph) => { const p = uTurnPlanLayout(stair, graph); return p?.entryPort !== 'end' && p?.arrivalPort !== 'end' && p.entryTurnSteps === 1 && p.arrivalTurnSteps === 2; },
  },
  {
    n: 6, title: '直進・木造・走行端の口・sections [15]・2階にも続きの階段',
    ys: [], xs: [], upper: true,
    apply: () => ({ type: StairType.STRAIGHT, structure: StructuralMaterialType.WOOD, sections: [15], entrySide: null, entryTurnSteps: 0, arrivalSide: null, arrivalTurnSteps: 0 }),
    expect: (stair, graph) => { const p = straightPlanLayout(stair, graph); return p?.entryPort === 'end' && p.arrivalPort === 'end' && p.totalSteps === 15; },
  },
  {
    n: 7, title: '踊場付直進・木造・[7,1,8]・2階にも続きの階段',
    ys: [-8190, -8490], xs: [], upper: true,
    apply: () => ({ type: StairType.STRAIGHT_LANDING, structure: StructuralMaterialType.WOOD, sections: [7, 1, 8], entrySide: null, entryTurnSteps: 0, arrivalSide: null, arrivalTurnSteps: 0 }),
    expect: (stair, graph) => {
      const p = straightPlanLayout(stair, graph);
      const lens = measureStairSpans(stair, graph)?.lengths;
      return p?.hasLanding === true && p.entryPort === 'end' && p.arrivalPort === 'end' && Array.isArray(lens) && lens.length === 3;
    },
  },
];

// 選んだ variant（--variants N,N。省略は全部）。不正な指定は用法違反として終了する
const selected = variantArg == null ? VARIANTS : VARIANTS.filter(v => variantArg.split(',').map(Number).includes(v.n));
if (variantArg != null && (selected.length === 0 || variantArg.split(',').some(s => !VARIANTS.some(v => v.n === Number(s))))) {
  console.error(`不正な --variants: ${variantArg}（有効: ${VARIANTS.map(v => v.n).join(',')}）`);
  process.exit(2);
}

const outOf = (n) => `${prefix}${n}.stq`;
if (selected.some(v => fs.existsSync(outOf(v.n)))) {
  console.error(`既存ファイルを上書きしません: ${selected.map(v => outOf(v.n)).filter(fs.existsSync).join(', ')}`);
  process.exit(1);
}

const materialMap = await loadMaterialMap();

async function runSweep(project) {
  const graphMapPeek = async (plane) => project.graphMap.get(plane.id) ?? null;
  const changed = [];
  for (const p of project.planes) {
    const graph = project.graphMap.get(p.id);
    if (graph.wallFreshnessKey == null && graph.walls.length === 0) continue;
    runInAction(() => conformWoodBacking(graph, project));
    runInAction(() => alignPortStairsOnGraph(graph));
    const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(graph, project, graphMapPeek);
    const before = wallBackingCenters(graph);
    const { regenerated } = await regenerateWalls(graph, { materialMap, project, stairUnderEntries, extraStairOpenings });
    if (!regenerated) continue;
    const moves = mapBackingCenterMoves(before, wallBackingCenters(graph));
    if (moves.length > 0) followWallBeamAxes(graph, moves);
    graph.setWallFreshnessKey(wallFreshnessKey(graph, project));
    changed.push(p.name);
  }
  return changed;
}

function digestProject(proj) {
  const out = {};
  for (const plane of proj.planes) {
    const g = proj.graphMap.get(plane.id);
    out[plane.name] = {
      walls: g.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${w.axisCL.effectiveValue}`).sort(),
      rooms: g.rooms.map(r => `${r.name}:${r.feature}:${[...r.referenceRoomIds].sort()}:${[...r.cells].sort().join(',')}`).sort(),
      stairs: g.stairs.map(s => `${s.type}:${s.structure}:${JSON.stringify(s.sections)}:${s.entrySide}:${s.entryTurnSteps}:${s.arrivalSide}:${s.arrivalTurnSteps}:${s.totalSteps}:${[...s.cells].sort().join(',')}`).sort(),
      columns: g.columns.map(c => `${Math.round(c.axisX)}:${Math.round(c.axisY)}`).sort(),
    };
  }
  return JSON.stringify(out);
}

let failed = false;
for (const v of selected) {
  console.log(`\n=== stair-ports-test${v.n}: ${v.title} ===`);
  const { project } = loadDocument(srcPath);
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  const plane1 = project.planes.find(p => p.name === '1階');
  const g1 = project.graphMap.get(plane1.id);
  const stair = g1.stairs[0];
  if (!stair || g1.stairs.length !== 1) throw new Error('1階に階段が 1 つだけ在る前提（2026模擬試験.stq の構成が変わった？）');

  runInAction(() => {
    // (1) 階段のセルを細かくする通り芯を足す（既存と同じ値があれば足さない）
    const has = (type, value) => g1.centerLines.some(c => c.centerLineType === type && Math.abs(c.effectiveValue - value) < 0.5);
    for (const y of v.ys) if (!has(CenterLineType.HORIZONTAL, y)) g1.addCenterLine(CenterLineType.HORIZONTAL, y, ARCH);
    for (const x of v.xs) if (!has(CenterLineType.VERTICAL, x)) g1.addCenterLine(CenterLineType.VERTICAL, x, ARCH);
    stair.setCells(refreshCells(stair.cells, g1));
    // (2) 型・段数・出入口・構造
    const spec = v.apply(stair);
    for (const [k, val] of Object.entries(spec)) stair.setField(k, val);
    stair.setField('upDirection', 'up');
    stair.setField('flip', false);
  });
  // U 字系の側面は left/right のどちらが側面（inner/outer）になるかを幾何で探す（stairPlanAlign.test.js sideEntrySwitchback と同じ）
  if (v.sides) {
    let found = false;
    for (const [es, as] of [['left', 'left'], ['left', 'right'], ['right', 'left'], ['right', 'right']]) {
      runInAction(() => { stair.setField('entrySide', es); stair.setField('arrivalSide', as); });
      const p = uTurnPlanLayout(stair, g1);
      if (p && p.entryPort !== 'end' && p.arrivalPort !== 'end') { found = true; break; }
    }
    if (!found) throw new Error(`test${v.n}: 上り口・到達口がともに側面になる辺の組が見つかりません`);
  }
  console.log(`  階段: ${stair.type} ${stair.structure} sections=${JSON.stringify(stair.sections)} 総蹴上数=${stair.totalSteps} セル ${stair.cells.size} 個 e=${stair.entryTurnSteps}(${stair.entrySide}) a=${stair.arrivalTurnSteps}(${stair.arrivalSide})`);

  // (2b) upper: 2階へ続きの階段を写し、3階に STAIR_VOID を作る（STAIR_VOID は isCarvableRoom でないので先に外す）
  let g2 = null;
  let g3 = null;
  if (v.upper) {
    const plane2 = project.planes.find(p => p.name === '2階');
    const plane3 = project.planes.find(p => p.name === '3階');
    g2 = project.graphMap.get(plane2.id);
    g3 = project.graphMap.get(plane3.id);
    if (g2.stairs.length !== 0) throw new Error('2階に階段が無い前提（2026模擬試験.stq の構成が変わった？）');
    // 外す STAIR_VOID は 1階の唯一の階段の吹抜け 1 つだけのはず（複数あれば別の階段の吹抜けまで消すので止める）
    const voids2 = g2.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID);
    if (voids2.length !== 1) throw new Error(`test${v.n}: 2階の STAIR_VOID が ${voids2.length} 個（1 個の前提）`);
    runInAction(() => {
      for (const room of voids2) g2.removeRoom(room.id);
      const res = copyStairsToGraph(g2, g1, project.structGraph, { floorHeight: floorHeightAbove(project, plane2) });
      if (res.copied.length !== 1) throw new Error(`test${v.n}: 2階へ階段を写せません: ${JSON.stringify(res.skipped)}`);
      reconcileStairVoids(g3, g2, project.structGraph);
    });
    console.log(`  2階の階段: ${g2.stairs.length} 個・3階の STAIR_VOID: ${g3.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID).length} 個`);
    g2.setWallFreshnessKey(null);
    g3.setWallFreshnessKey(null);
  }

  // (3) 本番と同じ壁の再生成 → 構造再計算
  g1.setWallFreshnessKey(null);
  console.log('  壁再生成対象階:', await runSweep(project));
  const converged = await sweepUntilConverged(project, 'desc');
  if (converged == null) console.error('  警告: 構造再計算が収束しなかった');
  else console.log(`  構造再計算は ${converged} sweep で収束`);

  // (4) 実測: 出入口・段数が意図どおりに解決されること、alignPortStairsOnGraph が値を書き換えないこと
  if (!v.expect(stair, g1)) { console.error(`NG: test${v.n}: 平面の解決値が意図と違います`); failed = true; continue; }
  const changedByAlign = runInAction(() => alignPortStairsOnGraph(g1));
  if (changedByAlign) { console.error(`NG: test${v.n}: alignPortStairsOnGraph が値を書き換えた（木造の平場 0 など）`); failed = true; continue; }
  console.log('  OK: 出入口・取りつき段数は意図どおり（alignPortStairsOnGraph は書き換えなし）');

  // (4b) upper: 2階の階段が 1階の続きと判定され、裏面が引け、切断線の基点が一致すること
  if (v.upper) {
    const plane1p = g1.plane;
    const plane2p = g2.plane;
    const t = g2.stairs[0];
    const floorHeightMm = floorHeightAbove(project, plane1p);
    const riserOf2 = s => stairRiserOf(s, project, plane2p);
    const below = t ? matchingStairBelow(t, g2, g1) : null;
    const soffit = stair ? stairSoffitAbove({ stair, graph: g1, upperGraph: g2, floorHeightMm, riserOf: riserOf2 }) : null;
    const p1 = straightPlanLayout(stair, g1);
    const p2 = t ? straightPlanLayout(t, g2) : null;
    const dBase = p1 && p2 ? Math.abs(p1.run.base - p2.run.base) : NaN;
    console.log(`  expect(upper): matchingStairBelow=${below === stair ? '1階の階段' : below} / stairSoffitAbove=${soffit ? 'あり' : 'null'} / run.base の差=${dBase} mm`);
    if (below !== stair || !soffit || !(dBase <= 0.5)) { console.error(`NG: test${v.n}: 2階の続きの階段の条件を満たしません`); failed = true; continue; }
  }

  // (5) 往復テスト
  const floors = [...project.planes].map(p => ({ planeId: p.id, bytes: serializeGraph(project.graphMap.get(p.id)) }));
  const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const planesBytes = serializePlanes(project);
  const json = buildDocumentJson({ floors, struct, planes: planesBytes, site: null, info: null, bootPlaneId: project.activePlaneId });
  const doc = parseDocumentEnvelope(JSON.parse(json));
  const project2 = new Project('probe', 'probe');
  restoreStructCLs(project2.structGraph, project2.structuralInfo, doc.struct, project2.memberGroupLedger);
  const { planes: decodedPlanes, activePlaneId } = decodePlanes(doc.planes);
  for (const p of decodedPlanes) {
    project2.addPlane(p.elevation, p.name, p.id, p.startFloor, p.stories, p.isAlternative, p.referenceId, p.altIndex, p.isRoofPlane, p.roofForPlaneId, p.planCutHeightMm, p.ceilingCutHeightMm);
  }
  for (const f of doc.floors) {
    const g = project2.graphMap.get(f.planeId);
    if (g) restoreGraph(g, f.bytes);
  }
  if (activePlaneId && project2.planeMap.has(activePlaneId)) project2.activePlaneId = activePlaneId;
  if (digestProject(project) !== digestProject(project2)) { console.error(`NG: test${v.n}: 往復テスト不一致`); failed = true; continue; }
  console.log('  OK: 往復テスト一致（壁・部屋・階段・柱のダイジェストが書き戻し後も同一）');

  fs.writeFileSync(outOf(v.n), json);
  console.log('  wrote', outOf(v.n), json.length, 'bytes');
}
if (failed) process.exit(1);
