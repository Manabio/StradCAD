// 課題(h)（cl-conversion-limits.md 限界16 (h)）S0: 再現用 .stq の作成（実データには USER 梁芯が無く検出力ゼロのため）。
// 目的: 壁由来の梁芯のアンカー解決に範囲判定が無いことの再現データを作る。
//   手順: 元 .stq を読む →（--rc なら主構造を RC造(ラーメン) にし全階の外壁/内壁下地を RC壁にして壁を作り直す）
//   → 収束 → 対象階・対象座標の「由来 wall の梁芯」を依存部材ごと撤去し、同座標に由来 USER の短い梁芯
//   （extent は絶対座標）を置く（near=壁の範囲の前半だけ／far=壁の範囲から離れた区間）→ 収束 → 往復検証 → 保存。
//   variant=base は梁芯を差し替えず（--rc のときの RC 基準データ）、収束して保存するだけ。
// 引数: <元.stq> <出力.stq> <variant: base|near|far> <階名|-> <座標指定: H:-6370 | auto | -> [--rc]
//   auto＝対象階で最長の壁源（RC/木造とも）。出力が既存なら上書きせず終了する。
// 出力: 標準出力に作成内容（置換した梁芯・USER 梁芯・収束前後の壁源数）、.stq（D:/tatsuya/Download/ 推奨）。
// 使い方（ローダー必須。app/ で実行）:
//   node --import ./scripts/testSetup.mjs scripts/probe/hMakeReproDocs.mjs D:/tatsuya/Download/moku4.stq D:/tatsuya/Download/h-wood-near.stq near 2階 H:-6370
//   node --import ./scripts/testSetup.mjs scripts/probe/hMakeReproDocs.mjs D:/tatsuya/Download/13.stq D:/tatsuya/Download/h-rc-base.stq base - - --rc
import fs from 'node:fs';
import { loadDocument } from './loadDoc.mjs';
import {
  serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes,
} from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, Discipline } from '../../src/core.js';
import { centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';
import { findBeamAnchorCL } from '../../src/structural/wallBeamAxes.js';
import { convergeProject, measurePlane, rnd } from './hAnchorCoverageProbe.mjs';

const [srcPath, outPath, variant, floorName, coordSel] = process.argv.slice(2);
const useRc = process.argv.includes('--rc');
if (!srcPath || !outPath || !variant) { console.error('usage: hMakeReproDocs.mjs <src.stq> <out.stq> <base|near|far> <floor|-> <H:-6370|auto|-> [--rc]'); process.exit(1); }
if (fs.existsSync(outPath)) { console.error(`既存ファイルを上書きしません: ${outPath}`); process.exit(1); }

const RC = 'RC造(ラーメン)';
const RC_EXTERIOR = '501000000003'; // RC壁 t=200
const RC_INTERIOR = '501000000002'; // RC壁 t=180

const { project } = loadDocument(srcPath);
if (useRc) {
  project.structuralInfo.setField('mainStructure', RC);
  for (const p of project.planes) {
    const g = project.graphMap.get(p.id);
    g.setExteriorWallBacking(RC_EXTERIOR);
    g.setInteriorWallBacking(RC_INTERIOR);
    g.setWallFreshnessKey(null);
  }
}
let conv = await convergeProject(project);
console.log(`1回目の収束 sweep=${conv}`);
for (const p of project.planes) {
  const m = measurePlane(p, project);
  console.log(`  ${p.name}: ${m.effectiveStructure} wallBeamAxes=${m.wallBeamAxes} 壁源=${m.sources.length}`);
}

if (variant !== 'base') {
  const plane = project.planes.find(p => p.name === floorName);
  if (!plane) throw new Error(`階が無い: ${floorName}`);
  const graph = project.graphMap.get(plane.id);
  const m = measurePlane(plane, project);
  let pick;
  if (coordSel === 'auto') {
    pick = [...m.sources].filter(r => r.anchorKind === 'beam' && r.anchorOrigin === 'wall').sort((a, b) => (b.srcHi - b.srcLo) - (a.srcHi - a.srcLo))[0];
  } else {
    const [dir, val] = coordSel.split(':');
    pick = m.sources.find(r => r.dir === dir && Math.abs(r.coord - Number(val)) < 1);
  }
  if (!pick) throw new Error(`対象の壁源が無い: ${coordSel}`);
  console.log('対象の壁源:', JSON.stringify(pick));
  const type = pick.dir === 'V' ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
  const old = findBeamAnchorCL(graph, type, pick.coord);
  if (!old || centerLineKind(old) !== 'beam' || old.beamAxisOrigin !== 'wall') throw new Error('対象座標のアンカーが由来 wall の梁芯ではない');
  console.log(`撤去する壁由来梁芯: id=${old.id.slice(0, 8)} value=${rnd(old.effectiveValue)} ext=${rnd(old.extentLo)}..${rnd(old.extentHi)}`);
  const value = old.effectiveValue;
  const bLo = pick.bracketLo, bHi = pick.bracketHi;
  const half = Math.round((bLo + (bHi - bLo) / 2) / 10) * 10;
  const ext = variant === 'near' ? [bLo, half] : [bHi + 1000, bHi + 3000];
  graph.removeDependentsOfCenterLine(old.id);
  graph.removeCenterLine(old.id);
  const user = graph.addCenterLine(type, value, {
    labeled: false, discipline: Discipline.FUSE, extentLo: ext[0], extentHi: ext[1], beamAxisOrigin: 'user',
  });
  console.log(`置いた USER 梁芯: id=${user.id.slice(0, 8)} value=${rnd(user.effectiveValue)} ext=${ext[0]}..${ext[1]}（壁の範囲 ${bLo}..${bHi}）`);
  conv = await convergeProject(project);
  console.log(`2回目の収束 sweep=${conv}`);
  const m2 = measurePlane(plane, project);
  console.log('置換後の同座標アンカー:', JSON.stringify(m2.sources.find(r => r.dir === pick.dir && Math.abs(r.coord - pick.coord) < 1)));
}

// ---- 往復検証して保存（makeWoodEvTestDoc.mjs と同じ手順）----
const digest = (proj) => JSON.stringify(proj.planes.map(pl => {
  const g = proj.graphMap.get(pl.id);
  return [pl.name,
    g.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}`).sort(),
    g.centerLines.map(c => `${c.centerLineType}:${Math.round(c.effectiveValue)}:${c.beamAxisOrigin ?? ''}:${c.extentLo ?? ''}:${c.extentHi ?? ''}`).sort(),
    g.columns.map(c => `${Math.round(c.axisX)}:${Math.round(c.axisY)}`).sort(),
    g.beams.map(b => `${b.role}:${Math.round(b.axisValue)}`).sort(),
    [...g.excludedWallBeamAxes].sort()];
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
if (p2.structuralInfo.mainStructure !== project.structuralInfo.mainStructure) { console.error('NG: 主構造が往復で変わった'); process.exit(1); }
fs.writeFileSync(outPath, json);
console.log(`OK: 往復一致・保存 ${outPath} (${json.length} bytes) mainStructure=${p2.structuralInfo.mainStructure}`);
