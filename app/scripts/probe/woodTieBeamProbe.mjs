// 在来木造の頭つなぎ・受梁（ステップ3h・autoFillWoodWallBeamsフェーズB／columnSupportBeamCandidates）と、
// それらを「壁とみなして」下階に立てる柱（ステップ3h-2・beamWallCrossPoints／autoFillWoodColumnsの
// aboveTieBeams）の実データ確認用probe。woodWallBeamProbe.mjs を骨格に、全階 recomputeStructuralForGraph
// を複数回回して階ごと・beamType別（頭つなぎ／受梁）の本数の前後と冪等（収束後に再度回してもchanged=false
// で本数不変）を確認する。非在来（S造）は対象外（beamPlacement:'wallRuns'のときだけ生成する）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/woodTieBeamProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';
import { isTraditionalWoodStructure, rulesFor, effectiveStructure } from '../../src/structural/structureRules.js';
import { selfWallSegments, peekAboveGraph, tieBeamSegments } from '../../src/structural/wallBeamAxes.js';
import { beamWallCrossPoints } from '../../src/structural/woodFraming.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku1.stq';
const { project } = loadDocument(src);
// loadDoc.mjs は実IDBを使わないインメモリ復元のため、非アクティブ階のpeekはgraphMapから直接返す
// （woodWallBeamProbe.mjs等と同じ差し替え）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

// 階別のbeamType別本数ヒストグラム（頭つなぎ・受梁のみ抜粋。他beamTypeはwoodWallBeamProbe.mjsが持つ）。
function tieHistogram(graph) {
  const h = { 頭つなぎ: 0, 受梁: 0 };
  for (const b of graph.beams) {
    if (b.beamType === '頭つなぎ' || b.beamType === '受梁') h[b.beamType]++;
  }
  return h;
}

// 非foundation柱の本数（ステップ3h-2による柱総数への影響を見るための素朴なカウント）。
function columnCount(graph) {
  return graph.columns.filter(c => c.role !== 'foundation').length;
}

console.log(`=== ${src} ===`);
console.log('主構造:', project.structuralInfo.mainStructure);

const before = new Map();
const columnsBefore = new Map();
for (const p of project.planes) {
  before.set(p.id, tieHistogram(project.graphMap.get(p.id)));
  columnsBefore.set(p.id, columnCount(project.graphMap.get(p.id)));
}

// 冪等収束チェック（woodWallBeamProbe.mjsと同じ規律）。**在来木造の収束期待はsweep4以内**
// （2026-09-18裁定で3から改定）——3h-2の点源に床梁（role:'floor'）を加えたことで「3階の床梁端→
// 2階柱（3h-2）→（3b）→1階柱（3h-2）→2階梁の分割（3c-2b）」という**3階またぎ**の連鎖が新たに成立し、
// 階順1→2→3の1スイープでは1段ずつしか伝播しないため（2026模試で実測sweep4。3bの「スイープ順に
// よる1回遅れ」節と同種の遅れが1段深くなった）。sweep5以降もchangedが出ればNGのまま
// （収束自体が壊れている＝チェーンが止まらない兆候として扱う）。
const MAX_SWEEPS = 5;
let convergedAt = null;
for (let i = 1; i <= MAX_SWEEPS; i++) {
  const changedPlanes = [];
  for (const p of project.planes) {
    const g = project.graphMap.get(p.id);
    const { changed } = await recomputeStructuralForGraph(g, project, g.structureOverride ?? project.structuralInfo.mainStructure);
    if (changed) changedPlanes.push(p.name);
  }
  console.log(`sweep${i}: changed=[${changedPlanes.join(',')}]`);
  if (changedPlanes.length === 0) { convergedAt = i; break; }
}

console.log(`--- 収束後（sweep${convergedAt ?? MAX_SWEEPS}時点）の階ごと頭つなぎ・受梁本数 ---`);
let totalTie = 0, totalCarrier = 0;
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  const b = before.get(p.id);
  const a = tieHistogram(g);
  console.log(`[${p.name}] 頭つなぎ: ${b.頭つなぎ}→${a.頭つなぎ}  受梁: ${b.受梁}→${a.受梁}`);
  totalTie += a.頭つなぎ; totalCarrier += a.受梁;
}
console.log(`合計: 頭つなぎ=${totalTie} 受梁=${totalCarrier}`);

// ステップ3h-2: 柱総数の前後（頭つなぎ・受梁を「壁とみなして」下階に柱を立てる機能の影響）。
console.log(`--- ステップ3h-2: 階ごと柱本数（非foundation）の前後 ---`);
let totalColBefore = 0, totalColAfter = 0;
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  const b = columnsBefore.get(p.id);
  const a = columnCount(g);
  console.log(`[${p.name}] 柱: ${b}→${a}`);
  totalColBefore += b; totalColAfter += a;
}
console.log(`合計: 柱 ${totalColBefore}→${totalColAfter}`);

// ステップ3h-2: 頭つなぎ・受梁・床梁の下（beamWallCrossPointsの交点）に立った下階柱の本数
// （収束後の安定状態に対して、本番と同じ関数列で交点を求め、既存柱と一致する数を数える）。
// 変更1・2（2026-09-18）: 点源種別（頭つなぎ／受梁／床梁）ごとの内訳と、アンカー種別（CL解決／
// オフセットアンカー＝woodAxisOffset非null）の内訳を追加する。同じ交点が複数の梁種別から
// 重複して求まる場合があるため、種別ごとの件数の合計は「交点=」の件数と一致しないことがある
// （診断目的の内訳であり、正味件数はdedupe後の「交点=」を参照する）。
console.log('--- ステップ3h-2: 頭つなぎ／受梁／床梁の下に立った下階柱の本数（点源種別・アンカー種別の内訳付き） ---');
let totalUnderTie = 0, totalCL = 0, totalOffset = 0;
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  const rules = rulesFor(effectiveStructure(g, project));
  if (!rules.framing) continue;
  const aboveGraph = await peekAboveGraph(g, project);
  const ties = tieBeamSegments(aboveGraph, rules);
  if (ties.length === 0) continue;
  const segs = selfWallSegments(g);
  const crossPoints = beamWallCrossPoints(ties, segs);
  const matchedColumns = crossPoints.map(pt => g.columns.find(c =>
    Math.abs(c.axisX - pt.x) < 1 && Math.abs(c.axisY - pt.y) < 1)).filter(Boolean);
  const underTie = matchedColumns.length;
  const clCount = matchedColumns.filter(c => !c.woodAxisOffset).length;
  const offsetCount = matchedColumns.filter(c => c.woodAxisOffset).length;
  totalUnderTie += underTie; totalCL += clCount; totalOffset += offsetCount;
  // 点源種別ごとの内訳（同じaboveGraphから beamType でフィルタして同じ変換を再適用。診断専用）。
  const bySource = {};
  for (const beamType of ['頭つなぎ', '受梁', '床梁']) {
    const subset = aboveGraph.beams
      .filter(b => b.materialType === rules.baseMaterial && b.beamType === beamType)
      .map(b => ({
        isVertical: b.isVertical, coord: b.axisCL.effectiveValue,
        lo: Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue),
        hi: Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue),
      }));
    if (subset.length === 0) continue;
    bySource[beamType] = beamWallCrossPoints(subset, segs).length;
  }
  console.log(`[${p.name}] 上階の頭つなぎ・受梁・床梁=${ties.length}本(内訳:${JSON.stringify(bySource)}) 交点=${crossPoints.length}件 うち柱あり=${underTie}件（CL解決=${clCount}／オフセット=${offsetCount}）`);
}
console.log(`合計: 頭つなぎ・受梁・床梁の下に立つ柱=${totalUnderTie}件（CL解決=${totalCL}／オフセット=${totalOffset}）`);

// 冪等性の再確認: もう一度全階を回して、頭つなぎ・受梁の本数が変わらないこと（作って→撤去のチャーンが無いこと）。
// 追加スイープ「前」の本数を別Mapに控えてから比較する（m13）——追加スイープ「後」に project.graphMap から
// 読み直した値と afterExtra（同じ後の値）を比べるとトートロジーになり、実際にチャーンしていても常に
// stable=true になってしまう（同一グラフを2回読んでいるだけで、再計算の前後比較になっていなかった）。
const beforeExtra = new Map();
for (const p of project.planes) {
  beforeExtra.set(p.id, tieHistogram(project.graphMap.get(p.id)));
}
const afterExtra = new Map();
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  await recomputeStructuralForGraph(g, project, g.structureOverride ?? project.structuralInfo.mainStructure);
  afterExtra.set(p.id, tieHistogram(g));
}
let stable = true;
for (const p of project.planes) {
  const b = beforeExtra.get(p.id);
  const a = afterExtra.get(p.id);
  if (a.頭つなぎ !== b.頭つなぎ || a.受梁 !== b.受梁) stable = false;
}

// moku3.stq向け（指摘A/B/C・2026-09-18）: wallGateの下階柱免除（指摘A）・延長候補（指摘B）・
// 階段到達辺の合流（指摘C）が実際に効いた位置を座標で示す。他文書（moku1/moku2/2026模試）は
// 該当位置が無いため出力が空になるだけで失敗にはしない（存在確認のみ・非致命）。
function beamsAt(graph, isVertical, coord, tolMm = 5) {
  return graph.beams.filter(b => b.isVertical === isVertical && Math.abs(b.axisValue - coord) < tolMm)
    .map(b => ({
      lo: Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue),
      hi: Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue),
      beamType: b.beamType, role: b.role,
    }));
}
// Minor10（QA第2巡・2026-09-18）: 下の座標（Y7=-12614等）はmoku3.stq固有の通り芯配置に基づく
// ハードコードのため、srcがmoku3のときだけ出す（他文書に対して実行しても無意味な空/無関係な
// 値を出さない）。
if (/moku3/.test(src) && project.planes.length >= 3) {
  const g2 = project.graphMap.get(project.planes[1].id);
  const g3 = project.graphMap.get(project.planes[2].id);
  console.log('=== 以下はmoku3.stq基準の座標（他文書には適用不可） ===');
  console.log('--- 指摘A: 2階 Y7(y=-12614)・Y6(y=-10794) run（ポーチ跨ぎ区間 x:1820..3640 を含むこと） ---');
  console.log('Y7:', beamsAt(g2, false, -12614));
  console.log('Y6:', beamsAt(g2, false, -10794));
  console.log('--- 指摘B: 2階 x=5460（受梁による延長。V方向[-12614..-9884]が期待値） ---');
  console.log(beamsAt(g2, true, 5460));
  console.log('--- 指摘C: 2階 y=-9100 [0..1820]（階段の床開口4辺の梁。3階の同位置にも出る＝開口4辺すべてを run に合流する裁定） ---');
  console.log('2階:', beamsAt(g2, false, -9100));
  console.log('3階:', beamsAt(g3, false, -9100));
}

// 在来木造の収束上限=4（2026-09-18裁定。上記MAX_SWEEPSのコメント参照）。非在来は従来どおり1。
const convergeLimit = isTraditionalWoodStructure(project.structuralInfo.mainStructure) ? 4 : 1;
if (convergedAt != null && convergedAt <= convergeLimit && stable) {
  console.log(`OK: 収束（sweep${convergedAt}で changed=[]）かつ頭つなぎ・受梁の本数が安定`);
} else if (convergedAt == null) {
  console.log(`NG: 収束しない（sweep${MAX_SWEEPS}までchangedの階がある）`);
  process.exitCode = 1;
} else if (!stable) {
  console.log('NG: 頭つなぎ・受梁の本数が再計算のたびに変わる（チャーン）');
  process.exitCode = 1;
} else {
  console.log(`NG: 収束はしたが遅すぎる（sweep${convergedAt}。期待はsweep${convergeLimit}以内）`);
  process.exitCode = 1;
}
