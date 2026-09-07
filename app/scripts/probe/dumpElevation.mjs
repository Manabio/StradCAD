// 11.stq の各階・各部屋の展開図の面リスト（composeRoomFaces）をJSONへ落とす。平面側の変更が
// 展開図へ波及していないことの回帰基準。
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { composeRoomFaces } from '../../src/elevation/elevationFaceList.js';
import { withGraphReadScope } from '../../src/graphReadScope.js';

const outDir = process.argv[2] ?? path.join(import.meta.dirname, 'golden');
const src = process.argv[3] ?? 'D:/tatsuya/Download/11.stq';
fs.mkdirSync(outDir, { recursive: true });

const { project } = loadDocument(src);
const summary = [];
for (const p of project.orderedTabs) {
  const graph = project.graphMap.get(p.id);
  if (!graph) continue;
  const rows = [];
  withGraphReadScope(graph, () => {
    for (const room of [...graph.rooms].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      let faces;
      try { faces = composeRoomFaces(room, graph); }
      catch (e) { rows.push({ room: room.id, error: String(e.message) }); continue; }
      rows.push({ room: room.id, name: room.name ?? null, faces: faces.map(f => ({
        letter: f.letter ?? null, kind: f.kind ?? null, panelId: f.panelId ?? null,
        isVertical: f.isVertical ?? null,
        axis: num(f.axisValue), lo: num(f.spanLo ?? f.lo), hi: num(f.spanHi ?? f.hi),
        len: num(f.length), w0: f.hasWallAtLocal0 ?? null, wR: f.hasWallAtLocalRun ?? null,
      })) });
    }
  });
  const name = p.name.replace(/[^\w一-龥ぁ-んァ-ヶー]/g, '_');
  fs.writeFileSync(path.join(outDir, `elev-${name}.json`), JSON.stringify(rows, null, 1));
  summary.push({ plane: p.name, rooms: rows.length, faces: rows.reduce((n, r) => n + (r.faces?.length ?? 0), 0),
    errors: rows.filter(r => r.error).length });
}
function num(v) { return typeof v === 'number' ? Math.round(v * 1000) / 1000 : null; }
fs.writeFileSync(path.join(outDir, 'elev-summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
