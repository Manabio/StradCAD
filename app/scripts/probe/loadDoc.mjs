// .stq 文書ファイルを Node へ丸ごと復元するローダ（調査・回帰用。製品コードからは参照しない）。
import fs from 'node:fs';
import { Project } from '../../src/core.js';
import { restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { parseDocumentEnvelope } from '../../src/storage/documentFile.js';

if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}

export function loadDocument(path) {
  const doc = parseDocumentEnvelope(JSON.parse(fs.readFileSync(path, 'utf8')));
  const project = new Project('probe', 'probe');
  if (doc.struct) restoreStructCLs(project.structGraph, project.structuralInfo, doc.struct, project.memberGroupLedger);
  const { planes, activePlaneId } = doc.planes ? decodePlanes(doc.planes) : { planes: [], activePlaneId: null };
  for (const p of planes) {
    project.addPlane(p.elevation, p.name, p.id, p.startFloor, p.stories,
      p.isAlternative, p.referenceId, p.altIndex, p.isRoofPlane, p.roofForPlaneId);
  }
  for (const f of doc.floors) {
    const graph = project.graphMap.get(f.planeId);
    if (!graph) continue;
    restoreGraph(graph, f.bytes);
  }
  if (activePlaneId && project.planeMap.has(activePlaneId)) project.activePlaneId = activePlaneId;
  return { project, doc };
}
