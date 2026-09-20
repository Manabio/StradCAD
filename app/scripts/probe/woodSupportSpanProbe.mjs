// Step 0（計測）: 「梁の支持長が1820を超える場合の下階柱追加」一般解の設計に向けた実データ計測用probe。
// 既存挙動は一切変更しない（読み取り専用の診断）。woodTieBeamProbe.mjs を骨格に、全階を収束まで
// 再計算してから計測する。.claude/structural-model.md「点源の一般化」「フットプリント境界での分割」の
// 隣接ステップ（3i・支持長1820ルール）の設計材料。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/woodSupportSpanProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { isTraditionalWoodStructure, rulesFor, effectiveStructure, WOOD_DEPTH_BEAM_ROLES } from '../../src/structural/structureRules.js';
import { selfWallSegments, peekBelowGraph, peekAboveGraph, peekRoofGraphAbove, findBeamAnchorCL, wallRunSegments, columnSeedBeamSegments } from '../../src/structural/wallBeamAxes.js';
import { columnSplitPoints, pointsOnWallLines } from '../../src/structural/woodFraming.js';
import { wallLineThroughRuns, autoFillWoodColumns } from '../../src/structural/woodAutoFill.js';
import { buildSelfFootprintGate, footprintBreakCLs, buildStructuralWallGate } from '../../src/structural/wallGate.js';
import { CenterLineType, centerLineKind } from '../../src/core.js';
import { CL_OVERLAP_TOL_MM } from '../../src/core/constants.js';
import { sweepUntilConverged } from './sweepOrder.mjs';

const SUPPORT_SPAN_LIMIT_MM = 1820;
const GRID_STEP_MM = 910;
const MAX_SWEEPS = 8; // 「遅い」と「止まらない」を区別するため8まで回す（moku3のstructural-model.md実測sweep4に余裕を持たせる）。

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';

// sweepUntilConverged（本番の反映パスと同じ並び。屋根が在来なら降順の先頭・昇順の末尾）は
// sweepOrder.mjs（9本のwood probeが共有する単一実装。コーディネーター指示「probeを本番と同じ
// 順序・屋根込みに統一」）へ切り出した。降順（'desc'）が本番の反映パス（reflectStructuralToOtherFloors）
// と同じ順序——convergeLimit（他probeのMAX_SWEEPS判定）は降順の実測値を基準にする。昇順（'asc'）は
// 下記6bの順序不変チェック専用の比較走行であり、上限判定の対象ではない。

function loadFresh() {
  const { project } = loadDocument(src);
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  return project;
}

console.log(`=== ${src} ===`);

// ---- 6. 収束sweep数（階の昇順・降順の両方。それぞれ独立にdocumentを読み直してから計測） ----
const projAsc = loadFresh();
console.log('主構造:', projAsc.structuralInfo.mainStructure);
const ascConverged = await sweepUntilConverged(projAsc, 'asc');
console.log(`--- 6. 収束sweep数 ---`);
console.log(`昇順: ${ascConverged ?? `NG(${MAX_SWEEPS}超もchangedあり)`}`);

const projDesc = loadFresh();
const descConverged = await sweepUntilConverged(projDesc, 'desc');
console.log(`降順: ${descConverged ?? `NG(${MAX_SWEEPS}超もchangedあり)`}`);

// ---- 6b. 順序不変チェック（恒久組み込み。QA裁定2026-09-19）----
// 同じ文書を昇順収束・降順収束の2回、独立に読み直して回し（上のprojAsc/projDescをそのまま使う——
// 二重読み込みしない）、柱座標・梁区間・断面の正規化ダンプ（UUID等の実体idは含めない。座標は
// 0.5mm未満の浮動小数誤差を吸収するため整数mmに丸める）が一致しなければNGとしexit 1にする
// （Major-1のmergePrimaryBeamRuns適用により、階の処理順に依存せず同じ結果に収束することが不変条件
// になったため——.claude/structural-model.md「収束は処理順に依存しない」節参照）。
function normalizedStructuralDump(project) {
  const out = {};
  const roofPlane = project.roofPlane;
  const planes = roofPlane ? [...project.planes, roofPlane] : project.planes; // 屋根込み（在来のときだけ意味を持つ。柱は常に空配列）
  for (const p of planes) {
    const g = project.graphMap.get(p.id);
    out[p.name] = {
      columns: g.columns.map(c => `${c.role}:${Math.round(c.x)},${Math.round(c.y)}:${c.sectionDefId}`).sort(),
      beams: g.beams.map(b => `${b.role}:${b.beamType ?? ''}:${b.isVertical ? 'V' : 'H'}:${Math.round(b.axisValue)}:` +
        `${Math.round(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue))}..` +
        `${Math.round(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue))}:${b.sectionDefId}`).sort(),
    };
  }
  return out;
}
console.log('--- 6b. 順序不変チェック（昇順収束 vs 降順収束の全構造部材ダンプ一致） ---');
const dumpAsc = normalizedStructuralDump(projAsc);
const dumpDesc = normalizedStructuralDump(projDesc);
const orderInvariant = JSON.stringify(dumpAsc) === JSON.stringify(dumpDesc);
console.log(orderInvariant ? 'OK（昇順=降順）' : 'NG（昇順と降順で結果が異なる）');
if (!orderInvariant) {
  for (const plane of new Set([...Object.keys(dumpAsc), ...Object.keys(dumpDesc)])) {
    const a = dumpAsc[plane] ?? { columns: [], beams: [] };
    const d = dumpDesc[plane] ?? { columns: [], beams: [] };
    const colOnlyAsc = a.columns.filter(x => !d.columns.includes(x));
    const colOnlyDesc = d.columns.filter(x => !a.columns.includes(x));
    const beamOnlyAsc = a.beams.filter(x => !d.beams.includes(x));
    const beamOnlyDesc = d.beams.filter(x => !a.beams.includes(x));
    if (colOnlyAsc.length || colOnlyDesc.length || beamOnlyAsc.length || beamOnlyDesc.length) {
      console.log(`  [${plane}] 昇順のみ: columns=${JSON.stringify(colOnlyAsc)} beams=${JSON.stringify(beamOnlyAsc)}`);
      console.log(`  [${plane}] 降順のみ: columns=${JSON.stringify(colOnlyDesc)} beams=${JSON.stringify(beamOnlyDesc)}`);
    }
  }
  process.exitCode = 1;
}

// 以降の計測（1〜5・7）は昇順で収束させた project を使う（woodTieBeamProbe.mjs と同じ規律:
// 「全階を収束まで再計算してから計測する」）。
const project = projAsc;
if (ascConverged == null) {
  console.log('⚠ 昇順で収束しなかったため、以降の計測は非収束状態に対する参考値（比較には使わない）');
}

// ---- 1. 階別・beamType別「支持長>1820のprimary梁」本数と最大支持長 ----
// 支持点の定義は3d（alongCoordOnAxis）と同一の関数（columnSplitPoints）を共有する——
// 梁の両端＋軸上(tol内)かつ両端の内側にある1つ下の階の柱(AXIS)。
console.log('--- 1. 階別・beamType別「支持長>1820mmのprimary梁」本数・最大支持長 ---');
// 2で使う「区間ごとの下階壁カバー有無」・4で使う「フットプリント境界またぎ」も同じ走査でまとめて集計する。
const overLimitSpans = []; // { planeName, beam, lo, hi, len }
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  const rules = rulesFor(effectiveStructure(g, project));
  if (!rules.framing) continue; // 非在来は対象外
  const belowGraph = await peekBelowGraph(g, project);
  const belowSupportColumns = (belowGraph?.columns ?? []).filter(c => c.role !== 'foundation')
    .map(c => ({ x: c.axisX, y: c.axisY }));
  const beams = g.beams.filter(b => b.materialType === rules.baseMaterial && b.role === 'primary');
  const byType = {};
  for (const beam of beams) {
    const lo = Math.min(beam.clStart.effectiveValue, beam.clEnd.effectiveValue);
    const hi = Math.max(beam.clStart.effectiveValue, beam.clEnd.effectiveValue);
    const pts = columnSplitPoints({ lo, hi }, beam.axisValue, beam.isVertical, belowSupportColumns);
    let maxSpan = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const len = pts[i + 1] - pts[i];
      if (len > maxSpan) maxSpan = len;
      if (len > SUPPORT_SPAN_LIMIT_MM) {
        overLimitSpans.push({ planeName: p.name, graph: g, belowGraph, beam, lo: pts[i], hi: pts[i + 1], len, beamType: beam.beamType });
      }
    }
    if (maxSpan > SUPPORT_SPAN_LIMIT_MM) {
      const key = beam.beamType ?? '(未設定)';
      byType[key] = byType[key] ?? { count: 0, maxSpan: 0 };
      byType[key].count++;
      if (maxSpan > byType[key].maxSpan) byType[key].maxSpan = maxSpan;
    }
  }
  const entries = Object.entries(byType);
  if (entries.length === 0) continue;
  console.log(`[${p.name}] ${entries.map(([t, v]) => `${t}=${v.count}本(最大${v.maxSpan.toFixed(0)}mm)`).join(' ')}`);
}
console.log(`超過区間の総数（beamType不問・区間単位）: ${overLimitSpans.length}`);

// ---- 2. 超過区間のうち、1つ下の階で梁の真下を平行に走る壁（selfWallSegments、下地帯内・
//         through-run内）がある区間の本数と延長。壁が無い区間の本数。 ----
console.log('--- 2. 超過区間の下階の壁カバー有無 ---');
let coveredCount = 0, coveredLength = 0, uncoveredCount = 0, uncoveredLength = 0;
for (const span of overLimitSpans) {
  const belowSegs = span.belowGraph ? selfWallSegments(span.belowGraph) : [];
  const lines = wallLineThroughRuns(belowSegs);
  const line = lines.find(l => l.isVertical === span.beam.isVertical && Math.abs(l.coord - span.beam.axisValue) < CL_OVERLAP_TOL_MM);
  const covered = !!line?.runs.some(r => r.lo <= span.lo + CL_OVERLAP_TOL_MM && r.hi >= span.hi - CL_OVERLAP_TOL_MM);
  if (covered) { coveredCount++; coveredLength += span.len; } else { uncoveredCount++; uncoveredLength += span.len; }
}
console.log(`壁あり: ${coveredCount}区間（延長${coveredLength.toFixed(0)}mm） / 壁なし: ${uncoveredCount}区間（延長${uncoveredLength.toFixed(0)}mm）`);

// ---- 3. 超過区間内の、梁と直交する通り芯／意匠中心線（centerLineKindがstruct/center。梁芯・補助線は
//         除く）の本数と、lo側支持点から910の倍数位置の本数 ----
console.log('--- 3. 超過区間内の直交アンカーCL候補・910グリッド一致数 ---');
let totalAnchorCLs = 0, totalGridMatches = 0;
for (const span of overLimitSpans) {
  const crossType = span.beam.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const anchorCLs = span.graph.centerLines.filter(cl =>
    cl.centerLineType === crossType &&
    ['struct', 'center'].includes(centerLineKind(cl)) &&
    cl.effectiveValue > span.lo + CL_OVERLAP_TOL_MM && cl.effectiveValue < span.hi - CL_OVERLAP_TOL_MM);
  totalAnchorCLs += anchorCLs.length;
  const n = Math.floor((span.hi - span.lo) / GRID_STEP_MM);
  for (let k = 1; k < n + 1; k++) {
    const v = span.lo + GRID_STEP_MM * k;
    if (v >= span.hi - CL_OVERLAP_TOL_MM) continue;
    if (span.graph.centerLines.some(cl => cl.centerLineType === crossType && Math.abs(cl.effectiveValue - v) < CL_OVERLAP_TOL_MM)) totalGridMatches++;
  }
}
console.log(`直交アンカーCL候補（struct/center）合計: ${totalAnchorCLs}件 / 910グリッド位置に既存CLがある件数: ${totalGridMatches}件`);

// ---- 4. フットプリント境界: 現行の全primary梁区間のうち「区間の一部が自階フットプリント外にかかって
//         いる（中点は内）」区間の件数と座標（分割すると消えうる区間） ----
console.log('--- 4. フットプリント境界またぎ区間（中点は内・一部は外） ---');
let straddling = 0;
const straddlingCoords = [];
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  const rules = rulesFor(effectiveStructure(g, project));
  if (!rules.framing) continue;
  const gate = buildSelfFootprintGate(g);
  if (!gate) continue;
  const beams = g.beams.filter(b => b.materialType === rules.baseMaterial && b.role === 'primary');
  for (const beam of beams) {
    const lo = Math.min(beam.clStart.effectiveValue, beam.clEnd.effectiveValue);
    const hi = Math.max(beam.clStart.effectiveValue, beam.clEnd.effectiveValue);
    const midInside = gate.spanInBuilding(beam.axisCL, beam.isVertical, { value: lo }, { value: hi });
    if (!midInside) continue;
    const breaks = footprintBreakCLs(gate, g, beam.axisCL, beam.isVertical, lo, hi);
    if (breaks.length > 0) {
      straddling++;
      const coord = beam.axisValue;
      straddlingCoords.push(`[${p.name}] ${beam.isVertical ? 'V' : 'H'} axis=${coord.toFixed(0)} [${lo.toFixed(0)}..${hi.toFixed(0)}] break@${breaks.map(cl => cl.value).join(',')}`);
    }
  }
}
console.log(`該当件数: ${straddling}`);
for (const c of straddlingCoords) console.log(`  ${c}`);
// 2026模試 2階 V x=0 [-10794..-7280] の再現確認（対象文書のときだけ照合）。
if (/2026模試/.test(src)) {
  const hit = straddlingCoords.some(c => c.includes('V axis=0 ') && c.includes('[-10794..-7280]'));
  console.log(`2026模試の既知区間(V x=0 [-10794..-7280])の再現: ${hit ? 'あり' : 'なし（A-1適用後のため解消済みの可能性）'}`);
}

// ---- 5. 3b候補のうち走行方向のアンカーCLが未解決の件数と座標（次の委譲で解禁する対象） ----
// 【ASSUMED・簡略近似】3b本体（autoFillWoodColumns内）はresolveWoodColumnAnchorCL（findBeamAnchorCL→
// findCenterAnchorCLの2段）を使うが、いずれも非exportの内部関数のためprobeからは呼べない。
// ここではfindBeamAnchorCL（1段目）だけで判定する簡略近似——意匠中心線（2段目）でしか解決できない
// candidateも「未解決」に数えてしまうため、実際の3b未解決数はこの値以下（過大に出る近似）。
console.log('--- 5. 3b候補のうち走行方向のアンカーCLが未解決の件数と座標（簡略近似・ASSUMED） ---');
let unresolvedCross = 0;
const unresolvedCoords = [];
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  const rules = rulesFor(effectiveStructure(g, project));
  if (rules.columnPlacement !== 'wallIntersections') continue;
  const segs = selfWallSegments(g);
  if (segs.length === 0) continue;
  const aboveGraph = await peekAboveGraph(g, project);
  const abovePoints = (aboveGraph?.columns ?? []).filter(c => c.role !== 'foundation').map(c => ({ x: c.axisX, y: c.axisY }));
  const matches = pointsOnWallLines(abovePoints, segs, CL_OVERLAP_TOL_MM);
  for (const m of matches) {
    const axisType = m.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const crossType = m.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
    const axisCL = findBeamAnchorCL(g, axisType, m.coord);
    if (!axisCL) continue; // 法線方向すら解決できない候補は5の対象外（3bはそもそも候補にしない）
    const crossCL = findBeamAnchorCL(g, crossType, m.along);
    if (!crossCL) {
      unresolvedCross++;
      unresolvedCoords.push(`[${p.name}] ${m.isVertical ? `x=${m.coord.toFixed(0)},y=${m.along.toFixed(0)}` : `x=${m.along.toFixed(0)},y=${m.coord.toFixed(0)}`}`);
    }
  }
}
console.log(`走行方向アンカー未解決（簡略近似）: ${unresolvedCross}件`);
for (const c of unresolvedCoords) console.log(`  ${c}`);

// ---- 7. 追加柱の座標一覧（階別・由来別）。3iのkind内訳（struct/center/grid）付き ----
// 収束済みのgraphに対して autoFillColumnsForStructure の下層（autoFillWoodColumns）を本番と同じ
// 入力（wallGate・aboveColumns・wallSegments・aboveBeamSegments。structuralRecompute.jsと同じ組み立て）
// で診断用に呼び直す——収束済みのため created は通常0件（副作用は無い）。戻り値の iiPicks
// （3iが採用した候補の一覧。生成の可否判定には使わない診断専用フィールド）から、3iのkind別内訳を
// 精密に得る。3b/3h-2由来のオフセット柱・3a等のCLペア柱は iiPicks との座標一致で除外して分類する
// （データ上は woodAxisOffset の有無でしか区別できず、由来フィールドを持たないため——座標一致による
// 分類は3iがこのパスで採用する位置と既存柱の位置が一致するという前提に依る近似）。
console.log('--- 7. 追加柱の座標一覧（階別・由来別）と3iのkind内訳 ---');
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  const rules = rulesFor(effectiveStructure(g, project));
  if (!rules.framing || rules.columnPlacement !== 'wallIntersections') continue;
  const belowGraph = await peekBelowGraph(g, project);
  // 最上階はpeekAboveGraphが対象外（project.planesに次の実体階が無い）——structuralRecompute.js
  // （ステップ6）と同じくpeekRoofGraphAboveへフォールバックし、屋根の壁線方式の軒桁を3h-2/3iの
  // 点源に含める（含めないと、収束済みのはずのgraphに対しdiagCreated.length>0の誤検知警告が出る）。
  const aboveGraph = (await peekAboveGraph(g, project)) ?? (await peekRoofGraphAbove(g, project));
  const wallGate = await buildStructuralWallGate(g.plane, project, g);
  const structure = effectiveStructure(g, project);
  const wallSegmentsForFloor = wallRunSegments(g, belowGraph, structure);
  const aboveColumnsForFloor = aboveGraph?.columns ?? [];
  const aboveBeamSegmentsForFloor = columnSeedBeamSegments(aboveGraph, aboveGraph ? rulesFor(effectiveStructure(aboveGraph, project)) : rules);
  // R-1裁定（2026-09-19）: 3iのbelow優先候補（belowColumns）も本番と同じ入力で渡す
  // ——省くと収束済みのはずのgraphに対しdiagCreated.length>0の誤検知警告が出る。
  const diag = autoFillWoodColumns(g, project, wallGate, aboveColumnsForFloor, wallSegmentsForFloor, aboveBeamSegmentsForFloor, belowGraph?.columns ?? []);
  const { iiPicks, created: diagCreated } = diag;
  if (diagCreated.length > 0) console.log(`  ⚠ [${p.name}] 診断呼び出しで${diagCreated.length}件生成された（収束済みのはずが未収束の可能性）`);

  const autoColumns = g.columns.filter(c => c.role !== 'foundation' && c.dimensionStatus === 'auto');
  const matchesPick = (c) => iiPicks.find(pk => Math.abs(pk.x - c.axisX) < 1 && Math.abs(pk.y - c.axisY) < 1);
  const jamb = autoColumns.filter(c => c.woodJambRef);
  const iiMatched = autoColumns.filter(c => !c.woodJambRef && matchesPick(c));
  const offsetOther = autoColumns.filter(c => !c.woodJambRef && !matchesPick(c) && c.woodAxisOffset);
  const clPair = autoColumns.filter(c => !c.woodJambRef && !matchesPick(c) && !c.woodAxisOffset);
  const struct = iiPicks.filter(pk => pk.kind === 'struct');
  const center = iiPicks.filter(pk => pk.kind === 'center');
  // below（ユーザー裁定2026-09-19「最下階まで可能な限り同位置に柱を追加」）: 1つ下の実体階の柱位置に
  // 揃えた3i候補。struct/centerに次ぐ優先度（woodFraming.js SUPPORT_SPAN_PRIORITY_ORDER参照）。
  const below = iiPicks.filter(pk => pk.kind === 'below');
  const grid = iiPicks.filter(pk => pk.kind === 'grid');
  if (autoColumns.length === 0) continue;
  console.log(`[${p.name}] auto柱=${autoColumns.length}本 内訳: 袖柱=${jamb.length} 3i(struct=${struct.length}/center=${center.length}/below=${below.length}/grid=${grid.length}) ` +
    `3b・3h-2オフセット=${offsetOther.length} 梁端・壁交点(CLペア。3a/3b/3h-2)=${clPair.length}`);
  for (const pk of struct) console.log(`    3i(struct) (${pk.x.toFixed(0)},${pk.y.toFixed(0)})`);
  for (const pk of center) console.log(`    3i(center) (${pk.x.toFixed(0)},${pk.y.toFixed(0)})`);
  for (const pk of below) console.log(`    3i(below)  (${pk.x.toFixed(0)},${pk.y.toFixed(0)})`);
  for (const pk of grid) console.log(`    3i(grid)   (${pk.x.toFixed(0)},${pk.y.toFixed(0)})`);
}

console.log(isTraditionalWoodStructure(project.structuralInfo.mainStructure) ? '(在来木造)' : '(非在来: 上記1-5,7は対象外のため空)');
