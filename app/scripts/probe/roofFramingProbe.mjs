// 在来木造の小屋梁（role:'roofBeam'。structural/woodRoofFraming.js。ステップC2b）の実データ確認用probe。
// 本番の反映パスと同じ順序（sweepOrder.mjs sweepUntilConverged。小屋伏図→最上階→…→最下階）で構造再計算を収束させ、
//   - 階ごとの保存データ（serializeGraph）の長さ:ハッシュ（UUID は決定化しているので同じコードなら毎回同じ）
//   - 小屋梁の一覧（軸の通り芯名・区間・両端の host の通り芯名・断面・採番）
//   - 母屋・棟木の線ごとの束の間隔の最大値（小屋梁を数えない「前」→数える「後」）
//   - 収束スイープ数（5以下）
// を出す。**全ての母屋・棟木で束の最大間隔が 1820 以下**でなければ exit 1。ただし「支えの無い端の区間」
// （その位置で、線を挟む左右どちらかに host＝線と平行な大梁が無く、小屋梁が構造上かけられない区間）は除き、
// 除いた区間は一覧に出す（structural-model.md の既知の穴＝壁の無い辺の軒桁と同根）。
//
// 【この probe が通る経路】主屋根（屋根専用平面＝小屋伏図）の矩形の切妻・片流れ（mainRoofFramingRegion が region を返す文書）。
//   region が無い文書（在来でない・陸屋根・棟違い・矩形でない・屋根なし）は「対象外」と表示して exit 0
//   （小屋梁が0本のことは、他の確認——13.stq の dump 一致——で見る）。
// 【通らない経路】下屋（実体階の屋根セル＝C2d）、寄棟（C2e）、矩形でない屋根、小屋梁の成の表（C2c。断面は既定のまま）。
//   これらは未実装なので、この probe の合否に影響しない（寄棟の文書は「対象外」）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/roofFramingProbe.mjs [入力.stq]   （既定: moku4）
import crypto from 'node:crypto';

// UUID を連番にして決定化する（階ごとのハッシュを同じコードで再現可能にする。製品コードには影響しない診断専用）。
let uuidCounter = 0;
const detUUID = () => { uuidCounter++; return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`; };
crypto.randomUUID = detUUID;
Object.defineProperty(globalThis.crypto, 'randomUUID', { value: detUUID, configurable: true, writable: true });

const { loadDocument } = await import('./loadDoc.mjs');
const { floorSwapManager } = await import('../../src/storage/FloorSwapManager.js');
const { serializeGraph } = await import('../../src/graphSnapshot.js');
const { sweepUntilConverged, planeLabel } = await import('./sweepOrder.mjs');
const { structuralPlaneBelow } = await import('../../src/structural/drawingDesignation.js');
const { mainRoofFramingRegion } = await import('../../src/structural/roofFramingRegions.js');
const { roofFramingLines, roofStrutPoints } = await import('../../src/structural/roofFramingGeometry.js');
const { roofFramingHostMembers } = await import('../../src/structural/framingDrawing.js');
const { rulesFor, effectiveStructure } = await import('../../src/structural/structureRules.js');
const { assignNumbers, applyNumbers } = await import('../../src/structural/memberNumbering.js');
const { CL_OVERLAP_TOL_MM } = await import('../../src/core/constants.js');
const { CenterLineType } = await import('../../src/core.js');

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';
const MAX_SWEEPS = 8;
const SWEEP_LIMIT = 5; // 収束スイープ数の上限（convergeLimit）
const hash = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);

const { project } = loadDocument(src);
// loadDoc.mjs はインメモリ復元のため、非アクティブ階の peek は graphMap から直接返す（他の wood probe と同じ）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

console.log(`=== ${src} ===`);
console.log('主構造:', project.structuralInfo.mainStructure);
const roofPlane = project.roofPlane;
if (!roofPlane) { console.log('屋根専用平面が無い文書: 対象外（exit 0）'); process.exit(0); }

const convergedAt = await sweepUntilConverged(project, 'desc', MAX_SWEEPS, (i, changedPlanes) => {
  console.log(`sweep${i}: changed=[${changedPlanes.join(',')}]`);
});
// 採番（反映パスの2パス目と同じ。KB の番号を見る）
{
  const tags = assignNumbers(project);
  for (const p of [...project.planes, roofPlane]) applyNumbers(project.graphMap.get(p.id), project, tags);
}

console.log('--- 階ごとの保存データ（長さ:ハッシュ） ---');
for (const p of [...project.planes, roofPlane]) {
  const b = serializeGraph(project.graphMap.get(p.id));
  console.log(`  [${planeLabel(p)}] ${b.length}:${hash(b)}`);
}

const roofGraph = project.graphMap.get(roofPlane.id);
const topPlane = structuralPlaneBelow(roofPlane, project);
const topGraph = topPlane ? project.graphMap.get(topPlane.id) : null;
const region = mainRoofFramingRegion(topGraph, project);
if (!region) {
  console.log('主屋根の小屋組の region なし（在来でない／陸屋根・棟違い／矩形でない／屋根なし）: 対象外（exit 0）');
  console.log(`  小屋梁の本数: ${roofGraph.beams.filter(b => b.role === 'roofBeam').length}（0であるはず）`);
  process.exit(roofGraph.beams.some(b => b.role === 'roofBeam') ? 1 : 0);
}
console.log('region:', JSON.stringify(region));

const rules = rulesFor(effectiveStructure(roofGraph, project));
const F = rules.framing;
const tol = CL_OVERLAP_TOL_MM;
const clName = cl => (cl.labeled ? cl.label
  : `${cl.centerLineType === CenterLineType.VERTICAL ? 'x' : 'y'}=${Math.round(cl.effectiveValue)}${cl.beamAxisOrigin ? `(${cl.beamAxisOrigin})` : ''}`);

// ---- 小屋梁の一覧 ----
const koya = roofGraph.beams.filter(b => b.role === 'roofBeam');
console.log(`--- 小屋梁 ${koya.length} 本（${roofGraph.plane.name || '小屋伏図'}） ---`);
const sorted = [...koya].sort((a, b) => a.axisValue - b.axisValue || Math.min(a.clStart.effectiveValue, a.clEnd.effectiveValue) - Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue));
for (const b of sorted) {
  const lo = Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue);
  const hi = Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue);
  console.log(`  ${b.isVertical ? 'x' : 'y'}=${b.axisValue}（${clName(b.axisCL)}） ${lo}..${hi}  host: ${clName(b.clStart)} → ${clName(b.clEnd)}  断面=${b.sectionDefId} 採番=${b.memberNo} ${b.dimensionStatus}`);
}

// ---- 束の間隔 ----
const { ridges, purlins } = roofFramingLines({
  rect: region.rect, shape: region.shape, ridgeIsVertical: region.ridgeIsVertical, highSide: region.highSide,
  purlinPitchMm: F.purlinPitchMm, purlinStartOffsetsMm: F.purlinStartOffsetsMm, tolMm: tol,
});
const lines = [...ridges.map(l => ({ ...l, kind: '棟木' })), ...purlins.map(l => ({ ...l, kind: '母屋' }))];
const allMembers = roofFramingHostMembers(roofGraph.beams, rules.baseMaterial);
const membersWithoutKoya = roofFramingHostMembers(roofGraph.beams.filter(b => b.role !== 'roofBeam'), rules.baseMaterial);
function gapsOf(line, members) {
  const alongs = [line.lo, line.hi, ...roofStrutPoints([line], members, tol).map(p => (line.isVertical ? p.y : p.x))]
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 0; i + 1 < alongs.length; i++) gaps.push({ a: alongs[i], b: alongs[i + 1], len: alongs[i + 1] - alongs[i] });
  return { alongs, gaps, max: Math.max(...gaps.map(g => g.len)) };
}
// 「支えの無い端の区間」: 位置 p（区間 a..b の中、a から910ごとの全点を試す）で、線を挟む左右の両方に host
// （線と平行で p を跨ぐ大梁）があれば小屋梁をかけられた＝除外しない。どちらかが無ければ構造上かけられない＝除外して一覧に出す。
const parallel = roofGraph.beams.filter(b => b.role === 'primary' && b.materialType === rules.baseMaterial && b.isVertical === lines[0]?.isVertical);
function boundedAt(line, p) {
  const spans = parallel.filter(b => Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue) - tol <= p && p <= Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue) + tol);
  return spans.some(b => b.axisValue < line.coord - tol) && spans.some(b => b.axisValue > line.coord + tol);
}
console.log(`--- 母屋・棟木ごとの束の最大間隔（前＝小屋梁を数えない → 後＝小屋梁を数える。上限 ${F.strutMaxPitchMm}） ---`);
let violations = 0;
const excluded = [];
for (const line of lines) {
  const before = gapsOf(line, membersWithoutKoya);
  const after = gapsOf(line, allMembers);
  const over = after.gaps.filter(g => g.len > F.strutMaxPitchMm + tol);
  const notes = [];
  for (const g of over) {
    // 区間内の910グリッドの全点を試す（2点だけだと、それ以外の位置ならかけられる区間まで除外してしまう）。
    const samples = [];
    for (let p = g.a + F.gridModuleMm; p < g.b - tol; p += F.gridModuleMm) samples.push(p);
    if (samples.some(p => boundedAt(line, p))) { violations++; notes.push(`違反 ${g.a}..${g.b}（${g.len}）`); }
    else { excluded.push({ line, ...g }); notes.push(`除外 ${g.a}..${g.b}（${g.len}。支えの無い端の区間）`); }
  }
  const axisName = line.isVertical ? 'x' : 'y';
  console.log(`  ${line.kind} ${axisName}=${line.coord}（範囲 ${line.lo}..${line.hi}）: ${before.max} → ${after.max}  束 ${after.alongs.length}点${notes.length ? '  ' + notes.join(' / ') : ''}`);
}
if (excluded.length > 0) {
  console.log('--- 除外した区間（支えの無い端） ---');
  for (const e of excluded) console.log(`  ${e.line.kind} ${e.line.isVertical ? 'x' : 'y'}=${e.line.coord} の ${e.a}..${e.b}（${e.len}）`);
}

// ---- 判定 ----
let failed = false;
if (convergedAt === null || convergedAt > SWEEP_LIMIT) {
  console.log(`NG: 収束スイープ数 ${convergedAt ?? '未収束'}（上限 ${SWEEP_LIMIT}）`);
  failed = true;
}
if (violations > 0) {
  console.log(`NG: 束の最大間隔が ${F.strutMaxPitchMm} を超える区間が ${violations} 件（除外対象でない）`);
  failed = true;
}
if (koya.length === 0) {
  console.log('NG: region があるのに小屋梁が0本（この文書は小屋梁が要る形のはず）');
  failed = true;
}
console.log(`収束スイープ数: ${convergedAt}（上限 ${SWEEP_LIMIT}）  小屋梁: ${koya.length}本  除外区間: ${excluded.length}件`);
console.log(failed ? 'RESULT: NG' : 'RESULT: OK');
process.exit(failed ? 1 : 0);
