// 矩形の寄棟の小屋梁（ステップ C2e-1b。structural-model.md「小屋梁」の寄棟）を実データで目視確認するためのテスト用 .stq を作る
// スクリプト。makeRoofFramingTestDoc.mjs と同型で、こちらは**最上階の主屋根（mainRoofSpec）を寄棟にした** moku4.stq を作る。
//
// 流れ:
//   1. loadDoc.mjs で moku4.stq（在来木造3階・主屋根は自動＝切妻）を読み、往復テスト（読み→書き→読み）を先に通す。
//   2. 最上階の mainRoofSpec.shape を寄棟にする（切妻のままのシナリオと並べて比べる）。
//   3. 構造再計算を sweepOrder.mjs sweepUntilConverged（本番の反映パスと同じ順序。小屋伏図→最上階→…→最下階）で収束させる。
//      壁の再生成は要らない（屋根の形状は壁・境界に影響しない。主屋根は屋根専用平面の梁だけが変わる）。
//   4. 検査（NG は exit 1）:
//      ① 小屋伏図に第1段の小屋梁（beamType '小屋梁'）と飛び梁（beamType '飛び梁'）ができる
//      ② 全ての棟木・母屋で束の最大間隔が上限（1820）以下（線の両端を含む）
//      ③ 全ての棟木の両端に束がある（棟木の両端＝隅木の上端の下に横架材がある）
//      ④ 柱は切妻のときと全階で同じ（寄棟の小屋梁は柱を生まない）
//      ⑤ 収束スイープ数が上限（5）以下
//      ⑥ 書いて読み直したダイジェスト（部屋・壁・柱・梁）が一致し、主屋根の形状が寄棟のまま残る
//   5. 目視用に、region・棟木・母屋・小屋梁・飛び梁（軸・区間・host・断面）・束の最大間隔を出す。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeHipRoofTestDoc.mjs [入力.stq] [出力.stq]
//   既定: moku4.stq → D:/tatsuya/Download/roof-test4.stq。既存ファイルは上書きしない。.mjs は eslint の対象外。
import fs from 'node:fs';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, CenterLineType, RoofShape, ROOF_SHAPE_LABELS } from '../../src/core.js';
import { CL_OVERLAP_TOL_MM } from '../../src/core/constants.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { mainRoofFramingRegion } from '../../src/structural/roofFramingRegions.js';
import { roofFramingLines, roofStrutPoints } from '../../src/structural/roofFramingGeometry.js';
import { roofFramingHostMembers } from '../../src/structural/framingDrawing.js';
import { rulesFor, effectiveStructure } from '../../src/structural/structureRules.js';
import { structuralPlaneBelow } from '../../src/structural/drawingDesignation.js';
import { sweepUntilConverged } from './sweepOrder.mjs';

const srcPath = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';
const outPath = process.argv[3] ?? 'D:/tatsuya/Download/roof-test4.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}
const SWEEP_LIMIT = 5; // 収束スイープ数の上限（設計書 C0）
const tol = CL_OVERLAP_TOL_MM;
const num = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

// ---- 往復（makeRoofFramingTestDoc.mjs と同じ。梁のダイジェストを足す）----
function digestProject(proj) {
  const out = {};
  for (const plane of proj.planes.concat(proj.roofPlane ? [proj.roofPlane] : [])) {
    const g = proj.graphMap.get(plane.id);
    out[plane.name || '屋根'] = {
      walls: g.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${w.axisCL.effectiveValue}`).sort(),
      rooms: g.rooms.map(r => `${r.name}:${r.kind}:${r.feature}:${[...r.referenceRoomIds].sort()}:${[...r.cells].sort().join(',')}`).sort(),
      columns: g.columns.map(c => `${Math.round(c.axisX)}:${Math.round(c.axisY)}:${c.role}:${c.sectionDefId}`).sort(),
      beams: g.beams.map(b => `${b.role}:${b.beamType}:${b.isVertical}:${num(b.axisValue)}:${num(b.clStart.effectiveValue)}:${num(b.clEnd.effectiveValue)}:${b.sectionDefId}`).sort(),
    };
  }
  return JSON.stringify(out);
}
function encodeDocument(proj) {
  const floors = [...proj.planes, ...(proj.roofPlane ? [proj.roofPlane] : [])].map(p => ({ planeId: p.id, bytes: serializeGraph(proj.graphMap.get(p.id)) }));
  const struct = serializeStructCLs(proj.structGraph, proj.structuralInfo, proj.memberGroupLedger);
  return buildDocumentJson({ floors, struct, planes: serializePlanes(proj), site: null, info: null, bootPlaneId: proj.activePlaneId });
}
function decodeDocument(json) {
  const doc = parseDocumentEnvelope(JSON.parse(json));
  const project2 = new Project('probe', 'probe');
  restoreStructCLs(project2.structGraph, project2.structuralInfo, doc.struct, project2.memberGroupLedger);
  const { planes: decodedPlanes, activePlaneId } = decodePlanes(doc.planes);
  for (const p of decodedPlanes) {
    project2.addPlane(p.elevation, p.name, p.id, p.startFloor, p.stories, p.isAlternative, p.referenceId, p.altIndex, p.isRoofPlane, p.roofForPlaneId);
  }
  for (const f of doc.floors) {
    const g = project2.graphMap.get(f.planeId);
    if (g) restoreGraph(g, f.bytes);
  }
  if (activePlaneId && project2.planeMap.has(activePlaneId)) project2.activePlaneId = activePlaneId;
  return project2;
}

// ---- 0. 往復テスト（入力文書。先に通す）----
{
  const { project: p0 } = loadDocument(srcPath);
  const p0b = decodeDocument(encodeDocument(p0));
  if (digestProject(p0) !== digestProject(p0b)) {
    console.error('NG: 往復テスト不一致（入力文書を書いて読み直した部屋・壁・柱・梁のダイジェストが元と異なる）');
    process.exit(1);
  }
  console.log('OK: 往復テスト一致（入力文書。部屋・壁・柱・梁のダイジェスト）');
}

// ---- 1シナリオ（主屋根の形状を指定して収束させる）----
async function runScenario(shape) {
  const { project } = loadDocument(srcPath);
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  const roofPlane = project.roofPlane;
  if (!roofPlane) throw new Error('屋根専用平面が無い文書');
  const topPlane = structuralPlaneBelow(roofPlane, project);
  const topGraph = project.graphMap.get(topPlane.id);
  topGraph.mainRoofSpec.setField('shape', shape);
  const sweeps = await sweepUntilConverged(project, 'desc', 8);
  return { project, roofPlane, topPlane, topGraph, roofGraph: project.graphMap.get(roofPlane.id), sweeps };
}

const gable = await runScenario(RoofShape.GABLE);
const hip = await runScenario(RoofShape.HIP);
console.log(`=== ${srcPath}: 最上階（${hip.topPlane.name}）の主屋根を寄棟へ ===`);
console.log(`収束スイープ数: 寄棟=${hip.sweeps}（参考: 切妻 ${gable.sweeps}。上限 ${SWEEP_LIMIT}）`);

let failed = false;
const fail = (msg) => { console.error(`NG: ${msg}`); failed = true; };
if (hip.sweeps == null || hip.sweeps > SWEEP_LIMIT) fail(`構造再計算の収束スイープ数 ${hip.sweeps ?? '未収束'}（上限 ${SWEEP_LIMIT}）`);

// ---- 小屋梁・飛び梁の一覧 ----
const clName = cl => (cl.labeled ? cl.label
  : `${cl.centerLineType === CenterLineType.VERTICAL ? 'x' : 'y'}=${Math.round(cl.effectiveValue)}${cl.beamAxisOrigin ? `(${cl.beamAxisOrigin})` : ''}`);
const spanOf = b => [Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue), Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue)];
const beamLine = b => `${b.isVertical ? 'x' : 'y'}=${Math.round(b.axisValue)}（${clName(b.axisCL)}） ${Math.round(spanOf(b)[0])}..${Math.round(spanOf(b)[1])}  host: ${clName(b.clStart)} → ${clName(b.clEnd)}  断面=${b.sectionDefId} ${b.dimensionStatus}`;
const roofGraph = hip.roofGraph;
const koya = roofGraph.beams.filter(b => b.role === 'roofBeam' && b.beamType === '小屋梁');
const tobibari = roofGraph.beams.filter(b => b.role === 'roofBeam' && b.beamType === '飛び梁');
const byAxis = (a, b) => a.axisValue - b.axisValue || spanOf(a)[0] - spanOf(b)[0];
console.log(`--- 小屋伏図の小屋梁${koya.length} 本（第1段） / 飛び梁 ${tobibari.length} 本（第2段） ---`);
for (const b of [...koya].sort(byAxis)) console.log(`  小屋梁 ${beamLine(b)}`);
for (const b of [...tobibari].sort(byAxis)) console.log(`  飛び梁 ${beamLine(b)}`);
if (koya.length === 0) fail('第1段の小屋梁が1本も出ていない');
if (tobibari.length === 0) fail('飛び梁が1本も出ていない（この文書の寄棟は妻側の線が1820を超えるはず）');
const strayType = roofGraph.beams.filter(b => b.role === 'roofBeam' && b.beamType !== '小屋梁' && b.beamType !== '飛び梁');
if (strayType.length > 0) fail(`小屋梁でも飛び梁でもない beamType の roofBeam がある（${strayType.length} 本）`);

// ---- region・線・束 ----
const region = mainRoofFramingRegion(hip.topGraph, hip.project);
if (!region || region.shape !== RoofShape.HIP) fail(`主屋根の region が寄棟でない（${region ? region.shape : 'region なし'}）`);
else {
  const rules = rulesFor(effectiveStructure(roofGraph, hip.project));
  const F = rules.framing;
  console.log(`region: rect=${JSON.stringify(region.rect)} 形状=${ROOF_SHAPE_LABELS[region.shape]}`);
  const { ridges, purlins } = roofFramingLines({
    rect: region.rect, shape: region.shape, ridgeIsVertical: region.ridgeIsVertical, highSide: region.highSide,
    purlinPitchMm: F.purlinPitchMm, purlinStartOffsetsMm: F.purlinStartOffsetsMm, tolMm: tol,
  });
  console.log(`  棟木 ${ridges.length} 本: ${ridges.map(l => `${l.isVertical ? 'x' : 'y'}=${l.coord}（${l.lo}..${l.hi}）`).join(', ') || '（なし）'}`);
  console.log(`  母屋 ${purlins.length} 本: ${purlins.map(l => `${l.isVertical ? 'x' : 'y'}=${l.coord}（${l.lo}..${l.hi}）`).join(', ')}`);
  const members = roofFramingHostMembers(roofGraph.beams, rules.baseMaterial);
  console.log('--- 棟木・母屋ごとの束の最大間隔（線の両端を含む。上限 ' + F.strutMaxPitchMm + '） ---');
  for (const [kind, line] of [...ridges.map(l => ['棟木', l]), ...purlins.map(l => ['母屋', l])]) {
    const points = roofStrutPoints([line], members, tol).map(p => (line.isVertical ? p.y : p.x));
    const alongs = [line.lo, line.hi, ...points].sort((a, b) => a - b);
    let max = 0;
    for (let i = 0; i + 1 < alongs.length; i++) max = Math.max(max, alongs[i + 1] - alongs[i]);
    const endsOk = kind !== '棟木' || [line.lo, line.hi].every(e => points.some(p => Math.abs(p - e) <= tol));
    console.log(`  ${kind} ${line.isVertical ? 'x' : 'y'}=${line.coord}（${line.lo}..${line.hi}）: 最大間隔 ${max}  束 ${points.length}点${kind === '棟木' ? `  両端の束 ${endsOk ? 'あり' : 'なし'}` : ''}`);
    if (max > F.strutMaxPitchMm + tol) fail(`束の間隔が上限を超える: ${kind} ${line.isVertical ? 'x' : 'y'}=${line.coord}（${max}）`);
    if (!endsOk) fail(`棟木の端に束が無い: ${line.isVertical ? 'x' : 'y'}=${line.coord}`);
  }
}

// ---- 柱は切妻のときと全階で同じ ----
const colSig = g => g.columns.map(c => `${Math.round(c.axisX)},${Math.round(c.axisY)},${c.role},${c.sectionDefId}`).sort().join('|');
console.log('--- 柱（寄棟 / 切妻。全階） ---');
for (const p of [...hip.project.planes, hip.roofPlane]) {
  const a = hip.project.graphMap.get(p.id);
  const b = gable.project.graphMap.get(p.id);
  const same = colSig(a) === colSig(b);
  console.log(`  ${p.name || '屋根'}: ${a.columns.length} / ${b.columns.length}  ${same ? '一致' : '不一致'}`);
  if (!same) fail(`${p.name || '屋根'} の柱が切妻のときと一致しない`);
}

// ---- 往復（書いて読み直して一致・主屋根が寄棟のまま）----
hip.project.activePlaneId = hip.topPlane.id;
const json = encodeDocument(hip.project);
const reloaded = decodeDocument(json);
if (digestProject(hip.project) !== digestProject(reloaded)) fail('往復テスト不一致（書いて読み直したダイジェストが元と異なる）');
if (reloaded.graphMap.get(hip.topPlane.id).mainRoofSpec.shape !== RoofShape.HIP) fail('読み直した文書で主屋根が寄棟のまま残っていない');
if (failed) process.exit(1);
console.log('OK: 往復テスト一致（部屋・壁・柱・梁のダイジェスト。主屋根は寄棟のまま）');

fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');
