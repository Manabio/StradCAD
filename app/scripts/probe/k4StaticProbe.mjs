// 課題(k) k4: 静止状態の比較用。各 .stq を読み、収束後の位置キー（梁芯・梁・柱）と収束回数を出す。
// 修正前（worktree）と修正後で同じスクリプトを走らせ、k4StaticCompare.mjs で比べる。
// 引数: <出力.json> <入力.stq...>
// 使い方（app/ で実行）: node --import ./scripts/testSetup.mjs scripts/probe/k4StaticProbe.mjs out.json D:/tatsuya/Download/*.stq
// 出力: [{file, sweeps, planes:[{plane, structure, axes, beams, columns}], error?}]。既存出力は上書きしない。
import fs from 'node:fs';
import { loadDocument } from './loadDoc.mjs';
import { convergeProject, rnd } from './hAnchorCoverageProbe.mjs';
import { planeLabel } from './sweepOrder.mjs';
import { centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';

const [out, ...files] = process.argv.slice(2);
if (!out || files.length === 0) { console.error('usage: k4StaticProbe.mjs <out.json> <in.stq...>'); process.exit(1); }
if (fs.existsSync(out)) { console.error(`既存ファイルを上書きしません: ${out}`); process.exit(1); }
const dirChar = (cl) => (cl.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H');
const res = [];
for (const f of files) {
  const rec = { file: f.split('/').pop(), planes: [] };
  try {
    const { project } = await loadDocument(f);
    rec.sweeps = await convergeProject(project);
    const planes = [...project.planes];
    if (project.roofPlane && !planes.includes(project.roofPlane)) planes.push(project.roofPlane);
    for (const p of planes) {
      const g = project.graphMap.get(p.id);
      if (!g) continue;
      const axes = g.centerLines.filter(c => centerLineKind(c) === 'beam').map(c => `${dirChar(c)}:${rnd(c.effectiveValue)}:${c.beamAxisOrigin ?? '-'}:${rnd(c.extentLo)}:${rnd(c.extentHi)}`).sort();
      const beams = g.beams.map(b => `${b.role}:${b.isVertical ? 'V' : 'H'}:${rnd(b.axisValue)}:${rnd(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue))}:${rnd(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue))}:${b.dimensionStatus}`).sort();
      const columns = g.columns.map(c => `${rnd(c.axisX)}:${rnd(c.axisY)}`).sort();
      rec.planes.push({ plane: planeLabel(p), structure: g.structureOverride ?? project.structuralInfo.mainStructure, axes, beams, columns });
    }
  } catch (e) { rec.error = String(e?.message ?? e).slice(0, 300); }
  res.push(rec);
  console.log(rec.file, rec.error ?? `sweeps=${rec.sweeps} planes=${rec.planes.length}`);
}
fs.writeFileSync(out, JSON.stringify(res));
