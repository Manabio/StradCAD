import { floorSwapManager } from '../../storage/FloorSwapManager.js';
import { serializeGraph } from '../../graphSnapshot.js';
import { saveFloor } from '../../storage/db.js';
import { cellBoundsList, outlineSegments, refreshCells } from '../gridCells.js';
import { DEFAULT_WALL_BASE, DEFAULT_WALL_FINISH } from '../wallGeneration.js';
import { CenterLineType } from '@core';

const EPS = 1e-6;

// graph 内で type:value が一致する CL を探す
function findCounterpart(graph, type, value) {
  return graph.centerLines.find(
    c => c.centerLineType === type && Math.abs(c.value - value) < EPS,
  ) ?? null;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
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
 * per-floor CL id を上階（またはstructGraph共通）の対応CL idへ変換する。
 * 通り芯（structGraph 側）は全階共通のため同一IDのまま。設置階 per-floor CLは
 * type:value 照合で上階側の対応CLを探す。解決できなければ null（呼び出し側は安全側でスキップ）。
 */
function translateCLId(id, activeGraph, structGraph, upperGraph) {
  if (structGraph?.shapeMap.has(id)) return id;
  const cl = activeGraph.shapeMap.get(id);
  if (!cl) return null;
  const counterpart = findCounterpart(upperGraph, cl.centerLineType, cl.value);
  return counterpart ? counterpart.id : null;
}

// セルキー（"leftId:topId:rightId:bottomId"）を上階のCL id集合へ変換する。1つでも解決不能なら null。
function translateCellKey(key, activeGraph, structGraph, upperGraph) {
  const ids = key.split(':').map(id => translateCLId(id, activeGraph, structGraph, upperGraph));
  return ids.every(Boolean) ? ids.join(':') : null;
}

/**
 * cells（Set<string>）を上階の CL id 空間へ type:value 照合で変換する（階段・部屋どちらの
 * セル集合にも使う汎用ヘルパ）。1つでも解決不能なセルがあれば null を返す（安全側。
 * 呼び出し側は該当エンティティの自動追加をスキップする）。
 */
function translateCellSet(cells, activeGraph, structGraph, upperGraph) {
  const result = new Set();
  for (const key of cells) {
    const translated = translateCellKey(key, activeGraph, structGraph, upperGraph);
    if (!translated) return null;
    result.add(translated);
  }
  return result;
}

/**
 * cellKeys（Set<string>）が参照する per-floor 中心線を type:value で集める（通り芯は
 * sourceGraph.shapeMap に無いため自然にスキップされる）。
 * @returns {Map<string, import('@core').CenterLine>} `${type}:${value}` → CenterLine
 */
function collectNeededCLs(cellKeys, sourceGraph) {
  const needed = new Map();
  for (const key of cellKeys) {
    for (const clId of key.split(':')) {
      const cl = sourceGraph.shapeMap.get(clId);
      if (!cl) continue;
      needed.set(`${cl.centerLineType}:${cl.value}`, cl);
    }
  }
  return needed;
}

/**
 * needed（collectNeededCLs の結果）のうち upperGraph に無いものを追加し、短縮区間（extent）も
 * translateExtent で写す。stairFloorSync 内の全ての「上階への不足CL同期」処理はこれを使う
 * （二重実装しない）。
 * @returns {number} 追加した CL 数（0 なら変更なし）
 */
function addMissingCLs(needed, sourceGraph, structGraph, upperGraph) {
  const added = []; // [元CL, upperGraphに追加したCL]
  for (const cl of needed.values()) {
    if (findCounterpart(upperGraph, cl.centerLineType, cl.value)) continue;
    const nc = upperGraph.addCenterLine(cl.centerLineType, cl.value, {
      labeled: false, trim: false, discipline: cl.discipline,
      lineWeight: cl.lineWeight, lineType: cl.lineType, color: cl.color,
    });
    added.push([cl, nc]);
  }
  for (const [src, nc] of added) {
    for (const side of ['lo', 'hi']) {
      const { ref, staticVal } = translateExtent(src, side, sourceGraph, structGraph, upperGraph);
      if (ref || staticVal != null) upperGraph.setCenterLineExtentRef(nc, side, ref, staticVal);
    }
  }
  return added.length;
}

/**
 * 階段 footprint（cells）の外周に外壁を生成する（Room 非依存の簡易版）。
 * generateExteriorWalls（wallGeneration.js）と同じオフセット規約（wallBase/2+wallFinish、
 * 外壁は室外側）・同じ既定値（DEFAULT_WALL_BASE/DEFAULT_WALL_FINISH）を使うが、Room の
 * コーナーマップ（入隅・出隅ミトレ）は行わない簡易実装（各壁は境界CL位置で単純に突き合わせる）。
 * outlineSegments で得た footprint 外周の各線分について、線分の内外どちら側に実セルが
 * あるかをサンプリングし、外壁は常に「セルが無い側（室外側）」へオフセットする。
 * @returns {import('@core').Wall[]}
 */
export function generateStairExteriorWalls(graph, cells, { wallBase = DEFAULT_WALL_BASE, wallFinish = DEFAULT_WALL_FINISH } = {}) {
  const offset = wallBase / 2 + wallFinish;
  const boundsList = cellBoundsList(cells, graph);
  if (boundsList.length === 0) return [];

  const SAMPLE_EPS = 10; // mm — 境界線からこの距離だけ内側/外側をサンプリングする
  const isInside = (x, y) => boundsList.some(cb => cb.x1 < x && x < cb.x2 && cb.y1 < y && y < cb.y2);

  const walls = [];
  for (const seg of outlineSegments(boundsList)) {
    const mid = (seg.lo + seg.hi) / 2;
    const insideHigh = seg.isVertical ? isInside(seg.value + SAMPLE_EPS, mid) : isInside(mid, seg.value + SAMPLE_EPS);
    const insideLow  = seg.isVertical ? isInside(seg.value - SAMPLE_EPS, mid) : isInside(mid, seg.value - SAMPLE_EPS);
    if (insideHigh === insideLow) continue; // 内外判定不能（安全側でスキップ）
    const axisOffset = insideHigh ? -offset : offset; // 実セルが無い側（室外側）へオフセット

    const axisType = seg.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const perpType = seg.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
    const axisCL  = findCounterpart(graph, axisType, seg.value);
    const startCL = findCounterpart(graph, perpType, seg.lo);
    const endCL   = findCounterpart(graph, perpType, seg.hi);
    if (!axisCL || !startCL || !endCL) continue;

    walls.push(graph.addWall(axisCL, axisOffset, seg.isVertical, startCL, 0, endCL, 0, {
      isRoomWall: true, isExteriorWall: true, wallFinish,
    }));
  }
  return walls;
}

/**
 * 階段を設置した階（activeGraph）の上に採用フロアが複数あるとき、その全階（最上階まで）へ
 * 以下を順に反映する（各階、変更があれば peek → saveFloor）:
 *
 * 1. 中心線の同期: 設置階の階段 footprint を定義する per-floor 中心線のうち、その階に
 *    存在しないものを追加する（短縮区間 extent も写す）。通り芯（structGraph CL）は
 *    全階共通のため対象外。
 * 2. 階段の自動設置: その階の「さらに上」にも採用フロアがある場合のみ（最上階には設置
 *    しない＝階段は次階への到達手段のため）、同 footprint の階段がまだ無ければ設置階と
 *    同じ内容（sections 含む）で追加する（type:value 照合で冪等）。
 * 3. 外壁の自動指定: その階に isExteriorWall の壁が1本も無い場合のみ、階段 footprint の
 *    外周に外壁を生成する（既にあれば何もしない＝冪等）。最上階を含む全上階に適用する
 *    （ユーザー決定：階段が設置されない最上階にも階段形の外壁を生成する）。footprint は
 *    常に設置階の階段セルを変換した translatedCells を使う（最上階には Stair 実体が無いため
 *    temp.stairs には依存しない）。
 *
 * 非アクティブ階への変更はいずれも floorSwapManager.peek → saveFloor の既存パターンを踏襲する
 * （undo 対象外。フェーズ1（中心線同期のみ）と同じ扱い）。
 *
 * @param {object} project
 * @param {object} activeGraph - 設置階（アクティブ）のグラフ
 */
export async function syncUpperFloors(project, activeGraph) {
  const planes = project.planes; // elevation 昇順・採用フロアのみ（検討フロア/屋根伏図は除外済み）
  const active = activeGraph?.plane;
  if (!active) return;
  const idx = planes.findIndex(p => p.id === active.id);
  if (idx < 0 || idx + 1 >= planes.length) return; // 最上階には上階がない

  // 階段 footprint を定義する per-floor 中心線を type:value で集める（全上階で共通・設置階基準）
  const needed = collectNeededCLs(
    activeGraph.stairs.flatMap(s => [...s.cells]), activeGraph,
  );
  if (needed.size === 0) return;

  for (let i = idx + 1; i < planes.length; i++) {
    const plane = planes[i];
    const hasFloorAbove = i + 1 < planes.length; // このフロアの、さらに上に採用フロアがあるか
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    let changed = false;

    // 1. 不足CLを追加（extent も写す）
    if (addMissingCLs(needed, activeGraph, project.structGraph, temp) > 0) changed = true;

    // 2. 階段の自動設置（さらに上に採用フロアがある場合のみ＝最上階には設置しない。
    //    階段は次階への到達手段のため）。
    // 3. 外壁の自動指定（全上階共通。最上階も含む——ユーザー決定により階段設置の有無に
    //    関わらず、footprint 形状の外壁を作る。最上階には階段自体が無いため、footprint は
    //    必ず translatedCells（設置階の階段セルを変換したもの）を使う。temp.stairs には
    //    依存しない）。
    const hadExteriorWall = temp.walls.some(w => w.isExteriorWall);
    for (const stair of activeGraph.stairs) {
      const translatedCells = translateCellSet(stair.cells, activeGraph, project.structGraph, temp);
      if (!translatedCells) continue; // CL変換不能 → 安全側でこの階段はスキップ

      if (hasFloorAbove) {
        const alreadyExists = temp.stairs.some(s => setsEqual(s.cells, translatedCells));
        if (!alreadyExists) {
          temp.addStair({
            type: stair.type, structure: stair.structure, cells: translatedCells,
            totalSteps: stair.totalSteps, tread: stair.tread, riser: stair.riser ?? null,
            nosing: stair.nosing, width: stair.width,
            upDirection: stair.upDirection, flip: stair.flip,
            sections: stair.sections ?? null,
          });
          changed = true;
        }
      }

      if (!hadExteriorWall) {
        const walls = generateStairExteriorWalls(temp, translatedCells);
        if (walls.length > 0) changed = true;
      }
    }

    if (changed) await saveFloor(plane.id, serializeGraph(temp));
  }
}

/**
 * 元階（sourceGraph）に外壁ループ（isExteriorWall の壁）がある状態で階を追加したとき、
 * 新階（newPlane）へ「外壁ループ内側の領域」を1つの Room（部屋名 roomName。例:"2階"）として
 * 自動追加する。外壁線自体はコピーしない（部屋があれば仕上げモード境界の外壁再生成
 * （App.jsx の finish モード退出処理ステップ3）が自動生成するため）。
 *
 * セル集合は元階の全 Room セル ∪ 全階段 footprint セル（refreshCells で現行グリッドへ展開）
 * とする。外壁ループ（'outer'）の内側は、部屋・階段以外に建物内部の領域が無いことから
 * 通常この和集合と一致する（wallGeneration.js の classifyExteriorEdge・edgeClassify.js の
 * buildCellToRoom を確認済み。階段は Room ではないため cellToRoom に現れず、外壁生成側は
 * 階段に隣接する境界を「外側」とみなしうる——これは階段を Room に含めていない既存の仕様上の
 * 制約であり、本関数はそれとは独立に「見えている領域を安全側で丸ごと複写する」方針を取る）。
 * 完全な一致が崩れるケース（外壁ループに寄与しない離れ部屋等）でも、この和集合を安全側の
 * 近似として採用する（過小に切り詰めるより、部屋が実領域より広く複写される方が実害が小さい）。
 *
 * 部分指定（referenceRoomIds）は作らない（プレーンな addRoom）。
 *
 * @param {object} project
 * @param {object} sourceGraph - 元階（表示中）のグラフ
 * @param {object} newPlane - 追加した新しい Plane
 * @param {string} roomName - 新規 Room の名前（例:"2階"）
 */
export async function addNewFloorRoomFromSource(project, sourceGraph, newPlane, roomName) {
  const sourceCells = new Set();
  for (const room of sourceGraph.rooms) {
    for (const key of refreshCells(room.cells, sourceGraph)) sourceCells.add(key);
  }
  for (const stair of sourceGraph.stairs) {
    for (const key of refreshCells(stair.cells, sourceGraph)) sourceCells.add(key);
  }
  if (sourceCells.size === 0) return;

  const temp = await floorSwapManager.peek(newPlane, project.structGraph);

  // 不足CLを追加（部屋領域分。階段 footprint 分の不足CLは syncUpperFloors が別途担当する）
  const needed = collectNeededCLs(sourceCells, sourceGraph);
  addMissingCLs(needed, sourceGraph, project.structGraph, temp);

  const translatedCells = translateCellSet(sourceCells, sourceGraph, project.structGraph, temp);
  if (!translatedCells || translatedCells.size === 0) return; // CL変換不能 → 安全側で見送る

  temp.addRoom(translatedCells, roomName);
  await saveFloor(newPlane.id, serializeGraph(temp));
}
