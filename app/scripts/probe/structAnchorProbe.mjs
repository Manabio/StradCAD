// 柱アンカー解決の一群（findBeamAnchorCL/findWallBeamAxisCL/findCenterAnchorCL とその呼び出し元）を
// CL種別ベース判定へ移行する作業に向けた検出力補強probe（2026-09-20）。
// dumpStructural.mjs（golden13/struct-*.json）は id/role/no のみで、柱のアンカーCL種別・梁の両端位置・
// 梁芯CLの座標を含まず、かつ構造再計算（recomputeStructuralForGraph）を一切呼ばずに.stq保存時点の
// スナップショットをそのまま出すため、上記関数を壊しても差分が出ない（検出力ゼロ）。本probeは
// wallRefreshProbe.mjs / structureToggleProbe.mjs と同じ関数列（本番の境界処理と同一）を通したうえで、
// 柱のアンカーCL・梁の両端CL・梁芯CLの座標と種別を出す。
//
// 通す関数列（wallRefreshProbe.mjsと同一。conform→壁再生成→梁芯追従→構造再計算の順）:
//   conformWoodBacking → wallFreshnessKey比較 → resolveStairContext → regenerateWalls →
//   wallBackingCenters/mapBackingCenterMoves → followWallBeamAxes → wallFreshnessKey確定
//   → （全階）recomputeStructuralForGraph
// 省いている前処理: IndexedDB書込み（saveFloor）。理由: 本probeはインメモリのみで完結させ、
// 実データを書き換えないため（wallRefreshProbe.mjsと同じ設計）。柱・梁・梁芯CLの計算結果には
// 影響しない（保存は計算結果を書き出すだけの経路）。
// もう1つ省いている前処理: 他階の取得（floorSwapManager.peek）を、本番の「IndexedDBのバイト列から
// restoreGraphで復元する」経路ではなく、project.graphMap（loadDoc.mjsで全階メモリ展開済み）の
// 生きたグラフをそのまま返す差し替えにしている（wallRefreshProbe.mjs・dumpPlanRegen.mjsと同じ設計）。
// このため、復元時にCL参照が解決できず捨てられるような壁・部材（restoreGraphを経由して初めて起こる
// 種類の欠落）はこのprobeでは検出できない——本probeはHEADと移行後を同条件（同じ簡易peek）で比較する
// 用途のためこの限界の影響を受けない。
//
// 実データが踏まない経路（2026-09-20実測）:
//   13.stq（S造）: columnPlacement='gridIntersections' のため findBeamAnchorCL/findCenterAnchorCL
//   （woodAutoFill.js側の柱アンカー解決）を一切通らない。wallBeamAxes=null のため壁由来梁芯生成も無く
//   beamCLs=0本——findWallBeamAxisCLは呼ばれても常にnullの一致確認しかできない。
//   moku4.stq（木造在来）: columnPlacement='wallIntersections'・wallBeamAxes='selfAndBelow' で全経路を通る。
//   手元の検証データ（13.stq・moku4.stq）には補助線（aux）が無く、labeledと種別が食い違う旧データ
//   （通り芯以外でlabeled:trueな線・struct種別でlabeled:falseな線等）も含まれない——本probeは
//   これらの構成に対する挙動を検証できない。tol境界・第2候補（findCenterAnchorCL）の分岐・
//   壁由来梁芯の追従元の判定（findWallBeamAxisCLが通り芯を対象にしないこと）・床梁の既存梁芯
//   再ブラケット・梁芯CL全件列挙（beamAxisCenterLines）・支持長超過の候補選定
//   （SUPPORT_SPAN_COLUMN_KINDS）は実データでは分岐が踏まれない、または差分として現れないため、
//   これらの単体テスト（centerLineKindPolicy.test.js・structural/*.test.js）が唯一の保証になる。
//
// 比較は安定キー（id）ではなく決定的な位置＋役割キーで正規化する——再計算のたびにidが変わりうるため
// （StructuralColumn/Beamのid発番は生成順に依存し、既存golden13のid比較も同じ理由でi番目要素同士の
// 単純比較に頼っていない。columns/beamsはsortMapで安定キー昇順にする）。
import fs from 'node:fs';
import path from 'node:path';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadMaterialMap, regenerateWalls } from '../../src/finish/wallRegeneration.js';
import { wallFreshnessKey } from '../../src/finish/wallFreshnessKey.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { conformWoodBacking } from '../../src/structural/woodAutoFill.js';
import { wallBackingCenters, mapBackingCenterMoves } from '../../src/structural/wallBeamAxes.js';
import { followWallBeamAxes } from '../../src/structural/wallBeamAxisFollow.js';
import { centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';
import { sweepUntilConverged } from './sweepOrder.mjs';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';
const outDir = process.argv[3] ?? null;

const { project } = loadDocument(src);
const graphMapPeek = async (plane) => project.graphMap.get(plane.id) ?? null;
floorSwapManager.peek = graphMapPeek;
const materialMap = await loadMaterialMap();

const r = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : null);
const clInfo = (cl) => (cl ? { kind: centerLineKind(cl), labeled: !!cl.labeled, isVertical: cl.centerLineType === CenterLineType.VERTICAL, value: r(cl.effectiveValue) } : null);

async function runSweep() {
  const changed = [];
  for (const p of project.planes) {
    const graph = project.graphMap.get(p.id);
    if (graph.wallFreshnessKey == null && graph.walls.length === 0) continue;
    runInAction(() => conformWoodBacking(graph, project));
    if (wallFreshnessKey(graph, project) === graph.wallFreshnessKey) continue;
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
await runSweep();
// 構造再計算は1パスでは収束しないことがある（実測: moku4は柱数が1回目42→2回目45で確定、3階の
// center由来3i柱(5460,-3640)は2回のrecomputeでは生成されなかった）。sweepOrder.mjs
// sweepUntilConverged（woodSupportSpanProbe.mjs等9本のwood probeが共有する実装、本番の反映パス
// reflectStructuralToOtherFloorsと同じ降順）で「変化が無くなるまで」計算してから採取する。
const converged = await sweepUntilConverged(project, 'desc');
if (converged == null) {
  console.error(`警告: 構造再計算が収束しなかった（8sweep超もchangedあり）: ${src}`);
}

function dumpPlane(graph) {
  const columns = (graph.columns ?? []).map(c => ({
    role: c.role ?? null, no: c.memberNo ?? null,
    x: r(c.x), y: r(c.y), axisX: r(c.axisX), axisY: r(c.axisY),
    verticalCL: clInfo(c.verticalCL), horizontalCL: clInfo(c.horizontalCL),
    key: `${r(c.axisX)}:${r(c.axisY)}`,
  })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const beams = (graph.beams ?? []).map(b => ({
    role: b.role ?? null, no: b.memberNo ?? null, isVertical: b.isVertical,
    axisValue: r(b.axisValue), axisCL: clInfo(b.axisCL),
    clStart: clInfo(b.clStart), clEnd: clInfo(b.clEnd),
    key: `${b.isVertical}:${r(b.axisValue)}:${r(b.clStart?.effectiveValue)}:${r(b.clEnd?.effectiveValue)}`,
  })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const beamAxisCLs = (graph.centerLines ?? []).filter(cl => centerLineKind(cl) === 'beam').map(cl => ({
    isVertical: cl.centerLineType === CenterLineType.VERTICAL, value: r(cl.effectiveValue),
    extentLo: r(cl.extentLo), extentHi: r(cl.extentHi),
    key: `${cl.centerLineType === CenterLineType.VERTICAL}:${r(cl.effectiveValue)}`,
  })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { columns, beams, beamAxisCLs };
}

const summary = [];
const out = {};
for (const p of project.orderedTabs) {
  const graph = project.graphMap.get(p.id);
  if (!graph) continue;
  const dump = dumpPlane(graph);
  out[p.name] = dump;
  summary.push({ plane: p.name, columns: dump.columns.length, beams: dump.beams.length, beamAxisCLs: dump.beamAxisCLs.length });
}

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, dump] of Object.entries(out)) {
    const safeName = name.replace(/[^\w一-龥ぁ-んァ-ヶー]/g, '_');
    fs.writeFileSync(path.join(outDir, `anchor-${safeName}.json`), JSON.stringify(dump, null, 1));
  }
  fs.writeFileSync(path.join(outDir, 'anchor-summary.json'), JSON.stringify(summary, null, 1));
}
console.log(JSON.stringify(summary));
