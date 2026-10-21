// 地階構造（StructuralInfo.basementStructure。階の追加・削除 S5b）の検出力用テスト .stq を作るスクリプト。
//
// 13.stq（S造・地階なし）の最下階の下へ B1（startFloor -1）を足し、最下階の中身を複製して
// 構造を再計算し、basementStructure=null 版（地階構造なし＝主構造 S造に従う）と
// 'RC造(ラーメン)' 版を保存する。2版の差は B1 の実効の構造だけ（isBasementPlane が効いていれば
// B1 の柱・梁の材料・断面に差が出る。地上階は2版で同一）。
// 構造再計算は makeWoodEvTestDoc.mjs と同じ本番の関数列（壁再生成→全階 sweepUntilConverged）。
// 既存ファイルは上書きしない。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeBasementTestDoc.mjs [null版.stq] [rc版.stq]
import fs from 'node:fs';
import { loadDocument } from './loadDoc.mjs';
import {
  serializeGraphWithFreshLineIds, serializeGraph, serializeStructCLs, serializePlanes,
  restoreGraph, restoreStructCLs, decodePlanes,
} from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project } from '../../src/core.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { effectiveStructure } from '../../src/structural/structureRules.js';
import { sweepUntilConverged } from './sweepOrder.mjs';

const srcPath = 'D:/tatsuya/Download/13.stq';
const outNull = process.argv[2] ?? 'D:/tatsuya/Download/basement-test-null.stq';
const outRc = process.argv[3] ?? 'D:/tatsuya/Download/basement-test-rc.stq';
for (const p of [outNull, outRc]) {
  if (fs.existsSync(p)) {
    console.error(`既存ファイルを上書きしません: ${p}`);
    process.exit(1);
  }
}

const RC = 'RC造(ラーメン)';

function tally(items, keyFn) {
  const m = new Map();
  for (const it of items) m.set(keyFn(it), (m.get(keyFn(it)) ?? 0) + 1);
  return Object.fromEntries([...m.entries()].sort());
}

async function build(basement) {
  const { project } = loadDocument(srcPath);
  const lowest = project.planes[0];
  const lowestGraph = project.graphMap.get(lowest.id);
  // B1 は最下階の下（elevation を 3000 下げる）。中身は最下階の複製（線 id は振り直す）。
  const { graph: b1 } = project.addPlane(lowest.elevation - 3000, '地下1階', crypto.randomUUID(), -1, 1);
  restoreGraph(b1, serializeGraphWithFreshLineIds(lowestGraph));
  project.structuralInfo.setBasementStructure(basement);

  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  const converged = await sweepUntilConverged(project, 'desc');
  if (converged == null) console.error('警告: 構造再計算が収束しなかった');

  const rows = [];
  for (const plane of project.planes) {
    const g = project.graphMap.get(plane.id);
    rows.push({
      plane: plane.name, startFloor: plane.startFloor, effective: effectiveStructure(g, project),
      columns: g.columns.length, beams: g.beams.length,
      colMaterial: tally(g.columns, c => c.materialType), beamMaterial: tally(g.beams, b => b.materialType),
      colSection: tally(g.columns, c => c.sectionDefId),
    });
  }
  return { project, rows, converged };
}

function save(project, outPath) {
  const floors = [...project.planes].map(p => ({ planeId: p.id, bytes: serializeGraph(project.graphMap.get(p.id)) }));
  const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const planesBytes = serializePlanes(project);
  const json = buildDocumentJson({ floors, struct, planes: planesBytes, site: null, info: null, bootPlaneId: project.activePlaneId });

  // 往復（書いて読み直して部屋・壁・柱・梁と basementStructure が一致）
  const doc = parseDocumentEnvelope(JSON.parse(json));
  const p2 = new Project('probe', 'probe');
  restoreStructCLs(p2.structGraph, p2.structuralInfo, doc.struct, p2.memberGroupLedger);
  const { planes: decodedPlanes } = decodePlanes(doc.planes);
  for (const p of decodedPlanes) {
    p2.addPlane(p.elevation, p.name, p.id, p.startFloor, p.stories, p.isAlternative, p.referenceId, p.altIndex, p.isRoofPlane, p.roofForPlaneId);
  }
  for (const f of doc.floors) restoreGraph(p2.graphMap.get(f.planeId), f.bytes);
  const digest = (proj) => JSON.stringify([
    proj.structuralInfo.basementStructure,
    ...proj.planes.map((pl) => {
      const g = proj.graphMap.get(pl.id);
      return [
        pl.name,
        g.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}`).sort(),
        g.rooms.map(r => `${r.name}:${[...r.cells].sort().join(',')}`).sort(),
        g.columns.map(c => `${Math.round(c.axisX)}:${Math.round(c.axisY)}:${c.materialType}`).sort(),
        g.beams.length,
      ];
    }),
  ]);
  if (digest(project) !== digest(p2)) {
    console.error(`NG: 往復不一致 ${outPath}`);
    process.exit(1);
  }
  fs.writeFileSync(outPath, json);
  console.log(`OK: 往復一致・保存 ${outPath} (${json.length} bytes)`);
}

for (const [label, basement, outPath] of [['null版', null, outNull], ['RC版', RC, outRc]]) {
  const { project, rows, converged } = await build(basement);
  console.log(`=== ${label} (basementStructure=${basement}) 収束sweep数 ${converged} ===`);
  for (const r of rows) console.log(JSON.stringify(r));
  save(project, outPath);
}
