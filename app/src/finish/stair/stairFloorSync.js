import { floorSwapManager } from '../../storage/FloorSwapManager.js';
import { serializeGraph } from '../../graphSnapshot.js';
import { saveFloor } from '../../storage/db.js';

const EPS = 1e-6;

/**
 * 設置階に置かれた階段の footprint を定義する per-floor 中心線のうち、
 * 上階（設置上階＝elevation が1つ上の採用フロア）に存在しないものを上階へ追加して保存する。
 *
 * 通り芯（labeled struct CL）は全階共通のため対象外（graph.shapeMap に無く自然にスキップされる）。
 * 上階は非アクティブ階なので peek で読み出し、追加があれば IDB へ直接保存する。
 *
 * @param {object} project
 * @param {object} activeGraph - 設置階（アクティブ）のグラフ
 */
export async function syncUpperFloorCLs(project, activeGraph) {
  const planes = project.planes; // elevation 昇順
  const active = activeGraph?.plane;
  if (!active) return;
  const idx = planes.findIndex(p => p.id === active.id);
  const upper = idx >= 0 && idx + 1 < planes.length ? planes[idx + 1] : null;
  if (!upper) return; // 最上階には上階がない

  // 階段 footprint を定義する per-floor 中心線を type:value で集める
  const needed = new Map(); // `${type}:${value}` → CenterLine
  for (const stair of activeGraph.stairs) {
    for (const key of stair.cells) {
      for (const clId of key.split(':')) {
        const cl = activeGraph.shapeMap.get(clId); // 通り芯は structGraph 側なので undefined → スキップ
        if (!cl) continue;
        needed.set(`${cl.centerLineType}:${cl.value}`, cl);
      }
    }
  }
  if (needed.size === 0) return;

  const temp = await floorSwapManager.peek(upper, project.structGraph);
  let changed = false;
  for (const cl of needed.values()) {
    const exists = temp.centerLines.some(
      c => c.centerLineType === cl.centerLineType && Math.abs(c.value - cl.value) < EPS,
    );
    if (exists) continue;
    temp.addCenterLine(cl.centerLineType, cl.value, {
      labeled: false, trim: false, discipline: cl.discipline,
      lineWeight: cl.lineWeight, lineType: cl.lineType, color: cl.color,
    });
    changed = true;
  }
  if (changed) await saveFloor(upper.id, serializeGraph(temp));
}
