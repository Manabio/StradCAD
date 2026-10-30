// .stq の全階から立面図（外壁立面4面。facade/）を組み、面ごとの線の本数・幅・高さ・bounds と飛ばした階を標準出力へ出す。
// 屋根（S2）は本番と同じ region の解決（modes/FacadeModeState.js facadeRoofRegionsResolver）を通し、屋根の一覧（key・軒の高さ・形状・
// 平らか）と、面ごとの壁線・屋根線（SILHOUETTE/DETAIL 別）の本数を出す。建具（S3）は階ごとの外壁の建具／全建具の数と、
// 面ごとの描いた／隠れた／カタログに無い（entry なし）の数を出す。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/dumpFacade.mjs <stq> [--north deg]
// ファイルへは書かない（出力先の削除もしない）。
import { loadDocument } from './loadDoc.mjs';
import { buildFacadeInputs } from '../../src/facade/facadeInputs.js';
import { buildFacadeModel, facadeExtentsMm } from '../../src/facade/facadeFigure.js';
import { facadeViews, buildFacadeLines } from '../../src/facade/facadeGeometry.js';
import { FACADE_ROOF_LINE_KIND } from '../../src/facade/facadeStyle.js';
import { ElevationLineRole } from '../../src/elevation/elevationStyle.js';
import { facadeRoofRegionsResolver } from '../../src/modes/FacadeModeState.js';
import { leanToPlanRegions, topRoofPlanRegions } from '../../src/structural/roofFramingRegions.js';

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
const inputs = buildFacadeInputs(floors, project, { roofRegionsOf: facadeRoofRegionsResolver(project) });
const num = v => Math.round(v * 10) / 10;
const ext = facadeExtentsMm(inputs, { northAngleDeg });
const model = buildFacadeModel(inputs, { northAngleDeg, annotationMm: { glExtendMm: 0, glMarkMm: 0, titleGapMm: 0 } });
// region の形状（shape・outlineOnly）は inputs に残らないので、同じ解決をもう一度だけ読んで key で引く
const shapeByKey = new Map();
for (const { graph } of floors) {
  if (!graph) continue;
  for (const r of [...leanToPlanRegions(graph), ...topRoofPlanRegions(graph, project)]) {
    shapeByKey.set(r.key, `${r.shape}${r.outlineOnly ? '(outlineOnly)' : ''}`);
  }
}
const linesByView = new Map(facadeViews(northAngleDeg).map(v => [v.direction, buildFacadeLines(inputs, v)]));
const count = (lines, pred) => lines.filter(pred).length;

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
    exteriorOpenings: (f.openings ?? []).length,
    allOpenings: (project.graphMap.get(f.planeId)?.openings ?? []).length,
  })),
  roofs: inputs.roofs.map(r => ({
    planeId: r.planeId, floor: project.planeMap.get(r.planeId)?.name ?? null, key: r.key,
    shape: shapeByKey.get(r.key) ?? null, eaveZMm: num(r.eaveZMm), flat: r.flat, segments: r.segments.length,
  })),
  skipped: inputs.skipped,
  maxWidthMm: num(ext.maxWidthMm), maxHeightMm: num(ext.maxHeightMm),
  faces: model.map(f => {
    const lines = linesByView.get(f.direction) ?? [];
    return {
      direction: f.direction,
      lines: f.primitives.filter(p => p.type === 'line' && p.weight === 'medium').length,
      wallLines: count(lines, l => l.kind !== FACADE_ROOF_LINE_KIND),
      roofSilhouette: count(lines, l => l.kind === FACADE_ROOF_LINE_KIND && l.role === ElevationLineRole.SILHOUETTE),
      roofDetail: count(lines, l => l.kind === FACADE_ROOF_LINE_KIND && l.role === ElevationLineRole.DETAIL),
      // 外壁の建具（S3）: 描いた／全部隠れた／カタログに無い種別で飛ばした
      openings: f.openingCounts,
      widthMm: num(f.widthMm), heightMm: num(f.heightMm),
      bounds: Object.fromEntries(Object.entries(f.bounds).map(([k, v]) => [k, num(v)])),
    };
  }),
}, null, 1));
