import { floorSwapManager } from '../../storage/FloorSwapManager.js';
import { serializeGraph } from '../../graphSnapshot.js';
import { saveFloor } from '../../storage/db.js';

const EPS = 1e-6;

// graph 内で type:value が一致する CL を探す
function findCounterpart(graph, type, value) {
  return graph.centerLines.find(
    c => c.centerLineType === type && Math.abs(c.value - value) < EPS,
  ) ?? null;
}

/**
 * 設置階 CL の side('lo'|'hi') 側 extent を上階グラフ向けに変換する。
 * - 通り芯参照（全階共通の structGraph CL）→ 参照をそのまま維持
 * - 設置階 per-floor CL への参照 → 上階の同 type:value CL へ付け替え
 * - 壁参照・付け替え先なし → 解決済み座標を静的値として持たせる（壁は階固有）
 * @returns {{ref: object|null, staticVal: number|null}}
 */
function translateExtent(src, side, activeGraph, structGraph, upperGraph) {
  const ref       = side === 'lo' ? src.extentLoRef : src.extentHiRef;
  const staticVal = side === 'lo' ? src._extentLo   : src._extentHi;
  const resolved  = side === 'lo' ? src.extentLo    : src.extentHi;
  if (ref?.clId) {
    if (structGraph?.shapeMap.has(ref.clId)) return { ref, staticVal: null };
    const srcRef = activeGraph.shapeMap.get(ref.clId);
    const counterpart = srcRef
      ? findCounterpart(upperGraph, srcRef.centerLineType, srcRef.value)
      : null;
    if (counterpart) {
      return { ref: { clId: counterpart.id, offset: ref.offset ?? 0 }, staticVal: null };
    }
    return { ref: null, staticVal: resolved };
  }
  if (ref?.wallId) return { ref: null, staticVal: resolved };
  return { ref: null, staticVal };
}

/**
 * 設置階に置かれた階段の footprint を定義する per-floor 中心線のうち、
 * 上階（設置上階＝elevation が1つ上の採用フロア）に存在しないものを上階へ追加して保存する。
 * 設置階で短縮されている中心線は、短縮区間（extent）も上階へ写す。
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

  // 1パス目: 不足CLを追加（extent は後段で写す——参照付け替え先に同時追加分の CL も
  // 使えるよう、全 CL の追加を済ませてから2パス目で extent を変換する）
  const added = []; // [設置階の元CL, 上階に追加したCL]
  for (const cl of needed.values()) {
    if (findCounterpart(temp, cl.centerLineType, cl.value)) continue;
    const nc = temp.addCenterLine(cl.centerLineType, cl.value, {
      labeled: false, trim: false, discipline: cl.discipline,
      lineWeight: cl.lineWeight, lineType: cl.lineType, color: cl.color,
    });
    added.push([cl, nc]);
  }

  // 2パス目: 設置階での短縮区間（extent）を上階CLへ写す
  for (const [src, nc] of added) {
    for (const side of ['lo', 'hi']) {
      const { ref, staticVal } = translateExtent(src, side, activeGraph, project.structGraph, temp);
      if (ref || staticVal != null) temp.setCenterLineExtentRef(nc, side, ref, staticVal);
    }
  }

  if (added.length > 0) await saveFloor(upper.id, serializeGraph(temp));
}
