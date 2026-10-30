// .stq の全階から立面図（外壁立面4面。facade/）を組み、面ごとの線の本数・幅・高さ・bounds と飛ばした階を標準出力へ出す。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/dumpFacade.mjs <stq> [--north deg]
// ファイルへは書かない（出力先の削除もしない）。
import { loadDocument } from './loadDoc.mjs';
import { buildFacadeInputs } from '../../src/facade/facadeInputs.js';
import { buildFacadeModel, facadeExtentsMm } from '../../src/facade/facadeFigure.js';

const args = process.argv.slice(2);
const src = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--north');
const northIdx = args.indexOf('--north');
const northAngleDeg = northIdx >= 0 ? Number(args[northIdx + 1]) : null;
if (!src) {
  console.error('usage: dumpFacade.mjs <stq> [--north deg]');
  process.exit(1);
}

const { project } = loadDocument(src);
const floors = project.planes.map(plane => ({ plane, graph: project.graphMap.get(plane.id) ?? null }));
const inputs = buildFacadeInputs(floors, project);
const num = v => Math.round(v * 10) / 10;
const ext = facadeExtentsMm(inputs, { northAngleDeg });
const model = buildFacadeModel(inputs, { northAngleDeg, annotationMm: { glExtendMm: 0, glMarkMm: 0, titleGapMm: 0 } });

console.log(JSON.stringify({
  src,
  northAngleDeg,
  glZMm: inputs.glZMm,
  floors: inputs.floors.map(f => ({
    planeId: f.planeId,
    name: project.planeMap.get(f.planeId)?.name ?? null,
    zLoMm: num(f.zLoMm), zHiMm: num(f.zHiMm),
    segments: f.segments.length,
    courtyard: f.segments.filter(s => s.loopType === 'courtyard').length,
  })),
  skipped: inputs.skipped,
  maxWidthMm: num(ext.maxWidthMm), maxHeightMm: num(ext.maxHeightMm),
  faces: model.map(f => ({
    direction: f.direction,
    lines: f.primitives.filter(p => p.type === 'line' && p.weight === 'medium').length,
    widthMm: num(f.widthMm), heightMm: num(f.heightMm),
    bounds: Object.fromEntries(Object.entries(f.bounds).map(([k, v]) => [k, num(v)])),
  })),
}, null, 1));
