/**
 * 昇降機の上階事前チェック・上階自動生成の純関数（graph を読む・一時グラフへ書く。I/O なし。
 * react / store.js / snap.js / .jsx を静的 import しない）。昇降機の仕様追加 ステップ4・S2。
 *
 * 呼び出し側（finish/equipment/equipmentFloorSync.js runElevatorInstall。ステップ4 S3a）が
 * floorSwapManager.peek で取得した一時グラフをそのまま渡す——ここでは peek・saveFloor 等の
 * I/O を一切行わない。
 */
import { isShaftFeature, RoomFeature } from '@core';
import { refreshCells, isRectangularCellSet, roomBounds } from '../gridCells.js';
import { collectNeededCLs, addMissingCLs, translateCellSet } from '../floorCLMap.js';
import { isFinishCellDivider } from '../../core/centerLineKindPolicy.js';
import { subtractCellsFromUndefinedRooms } from '../roomUndefined.js';
import { installEquipment } from './equipmentOps.js';
import { selfFloorEquipmentCatalog, nextEquipmentNo, equipmentSymbols } from './equipmentNumbering.js';
import { ElevatorEquipmentCategory, DEFAULT_EV_USAGE } from '../../core/constants.js';
import { ERR_ELEVATOR_UPPER_CONFLICT, ERR_ELEVATOR_UPPER_UNCLOSABLE } from '../../error.js';

const BOUNDS_EPS = 1e-6;

function boundsEqual(a, b, eps = BOUNDS_EPS) {
  return Math.abs(a.x1 - b.x1) < eps && Math.abs(a.y1 - b.y1) < eps
    && Math.abs(a.x2 - b.x2) < eps && Math.abs(a.y2 - b.y2) < eps;
}

/**
 * 設置階の cells（sourceCells。refresh 済み）を上階グラフ（upperGraph。一時グラフ）向けに
 * 閉じた区画へ変換する。upperGraph に不足する分割CL（中心線。isFinishCellDivider）を足す
 * 副作用を持つ——一時グラフに対してのみ書き込み、拒否されれば呼び出し側が捨てる。
 *
 * 手順: collectNeededCLs → addMissingCLs(…, { isCounterpart: isFinishCellDivider }) →
 * translateCellSet → refreshCells。
 *
 * closed の条件: 変換後のセルが非空・isRectangularCellSet・roomBounds が設置階の世界座標の
 * 矩形と一致（許容差1e-6）。
 *
 * @param {object} upperGraph - 変換先（一時グラフ）。CLが追加される
 * @param {object} sourceGraph - 設置階のグラフ
 * @param {object} structGraph - project.structGraph（通り芯共通グラフ）
 * @param {Set<string>} sourceCells - 設置階の変換元セル（refresh 済み）
 * @returns {{cells: Set<string>|null, closed: boolean}}
 */
export function prepareUpperShaftCells(upperGraph, sourceGraph, structGraph, sourceCells) {
  const needed = collectNeededCLs(sourceCells, sourceGraph);
  addMissingCLs(needed, sourceGraph, structGraph, upperGraph, { isCounterpart: isFinishCellDivider });

  const translated = translateCellSet(sourceCells, sourceGraph, structGraph, upperGraph);
  if (!translated) return { cells: null, closed: false };
  const cells = refreshCells(translated, upperGraph);
  if (cells.size === 0) return { cells: null, closed: false };
  if (!isRectangularCellSet(cells, upperGraph)) return { cells, closed: false };

  const srcBounds = roomBounds(sourceCells, sourceGraph);
  const upBounds = roomBounds(cells, upperGraph);
  return { cells, closed: boundsEqual(srcBounds, upBounds) };
}

// 衝突種別の優先順（階の昇順で最初の階、その階の中では階段>吹抜け>器具>部屋の順で最初の1件を報告する）。
const CONFLICT_KIND_PRIORITY = ['stair', 'void', 'equipment', 'room'];

function pickFirstConflict(conflicts) {
  for (const kind of CONFLICT_KIND_PRIORITY) {
    const found = conflicts.find(c => c.kind === kind);
    if (found) return found;
  }
  return conflicts[0] ?? null;
}

/**
 * cells（変換後・refresh 済み）と重なる相手を分類して列挙する（読むだけ）。
 * 未定義（UNDEFINED）・未指定セル（重なる相手なし）は衝突にしない。
 *
 * 分類と表示名: 階段の実体／feature=STAIR の Room → kind:'stair' 名「階段」／VOID → kind:'void'
 * 名「吹抜け」／STAIR_VOID → kind:'void' 名「階段吹抜け」／別の器具行 → kind:'equipment'
 * 名=記号（equipmentSymbols 参照。関数の中で採番し直さない）／行の無い昇降路Room →
 * kind:'equipment' 名「昇降路」／それ以外（屋外・部分指定を含む） → kind:'room' 名=room.name
 * （空なら「部屋」）。
 *
 * @param {object} graph
 * @param {Set<string>} cells
 * @param {Map<string,string>} equipmentSymbolsById - 建物全体の記号（id→記号）。器具行の衝突表示に使う
 * @returns {Array<{kind:'stair'|'void'|'equipment'|'room', name:string, id:string}>}
 */
export function findShaftInstallConflicts(graph, cells, equipmentSymbolsById) {
  const conflicts = [];

  for (const stair of graph.stairs) {
    const stairCells = refreshCells(stair.cells, graph);
    if ([...stairCells].some(k => cells.has(k))) {
      conflicts.push({ kind: 'stair', name: '階段', id: stair.id });
    }
  }

  for (const room of graph.rooms) {
    const roomCells = refreshCells(room.cells, graph);
    if (![...roomCells].some(k => cells.has(k))) continue;
    if (room.feature === RoomFeature.UNDEFINED) continue;

    if (room.feature === RoomFeature.STAIR) {
      conflicts.push({ kind: 'stair', name: '階段', id: room.id });
      continue;
    }
    if (room.feature === RoomFeature.VOID) {
      conflicts.push({ kind: 'void', name: '吹抜け', id: room.id });
      continue;
    }
    if (room.feature === RoomFeature.STAIR_VOID) {
      conflicts.push({ kind: 'void', name: '階段吹抜け', id: room.id });
      continue;
    }
    if (isShaftFeature(room.feature)) {
      const rows = graph.equipmentRows.filter(r => r.roomId === room.id);
      if (rows.length === 0) {
        conflicts.push({ kind: 'equipment', name: '昇降路', id: room.id });
        continue;
      }
      for (const row of rows) {
        const rowCells = refreshCells(row.cellKeys, graph);
        if ([...rowCells].some(k => cells.has(k))) {
          conflicts.push({ kind: 'equipment', name: equipmentSymbolsById?.get(row.id) ?? row.id, id: row.id });
        }
      }
      continue;
    }
    conflicts.push({ kind: 'room', name: room.name || '部屋', id: room.id });
  }

  return conflicts;
}

/**
 * 直上階（k+1）だけを見て下方延長（2-8）の相手を探す。k+1 で変換後のセルと重なる器具行が
 * ちょうど1件で、その行自身のセル（refresh 済み）の世界座標包絡矩形が設置階の矩形と一致
 * （許容差1e-6）すれば、その行を延長相手として返す。CL変換不能・0件・複数件・矩形不一致は null
 * （新規グループとして判定する。Q3の中間階抜けもここで自然に new 側へ倒れる）。
 * @returns {object|null} 延長相手の EquipmentRow（実オブジェクト）
 */
function findExtensionTarget(sourceGraph, structGraph, sourceCells, upperGraph) {
  const translated = translateCellSet(sourceCells, sourceGraph, structGraph, upperGraph);
  if (!translated) return null;

  const overlapping = upperGraph.equipmentRows.filter(r => {
    const rc = refreshCells(r.cellKeys, upperGraph);
    return [...rc].some(k => translated.has(k));
  });
  if (overlapping.length !== 1) return null;

  const target = overlapping[0];
  const srcBounds = roomBounds(sourceCells, sourceGraph);
  const targetBounds = roomBounds(refreshCells(target.cellKeys, upperGraph), upperGraph);
  return boundsEqual(srcBounds, targetBounds) ? target : null;
}

/**
 * 昇降機の設置可否を、設置階より上の全採用階（事前チェック）・直下階（下方延長）の両方を
 * 踏まえて判定する。上階への書き込み（CL追加）は一時グラフ（floors[i].graph）に対してのみ行う——
 * このグラフをそのまま保存するかどうかは呼び出し側（equipmentFloorSync.js）が決める。
 *
 * @param {object} params
 * @param {object} params.structGraph - project.structGraph
 * @param {Array<{plane:object, graph:object}>} params.floors - 全採用フロア（elevation昇順）。
 *   activeIndex の位置には設置階の生きているグラフを入れる
 * @param {number} params.activeIndex - floors 内の設置階のインデックス
 * @param {Set<string>} params.sourceCells - 設置階の変換元セル（refresh 済み）
 * @returns {
 *   {kind:'reject', conflicts:Array<{planeId:string,floorLabel:string,kind:string,name:string,id:string}>, message:string} |
 *   {kind:'extend', equipment:{id:string,category:string,usage:string,no:number}} |
 *   {kind:'new', equipment:{id:string,category:string,usage:string,no:number}, upperTargets:Array<{plane:object,graph:object,cells:Set<string>}>}
 * }
 */
export function judgeElevatorInstall({ structGraph, floors, activeIndex, sourceCells }) {
  const sourceGraph = floors[activeIndex].graph;

  // 全採用階（上階も下階も）の行から採番（重複は先勝ち＝floorsが昇順のため下階が勝つ）
  const catalog = selfFloorEquipmentCatalog(floors.flatMap(f => f.graph.equipmentRows));
  const equipmentSymbolsById = equipmentSymbols(catalog);

  // 下方延長（2-8）: 直上階（k+1）だけを見る
  if (activeIndex + 1 < floors.length) {
    const target = findExtensionTarget(sourceGraph, structGraph, sourceCells, floors[activeIndex + 1].graph);
    if (target) {
      return { kind: 'extend', equipment: { id: target.id, category: target.category, usage: target.usage, no: target.no } };
    }
  }

  // 新規グループ: 設置階の1つ上から最上階まで事前チェック
  const upperTargets = [];
  for (let i = activeIndex + 1; i < floors.length; i++) {
    const { plane, graph: upperGraph } = floors[i];
    const { cells, closed } = prepareUpperShaftCells(upperGraph, sourceGraph, structGraph, sourceCells);
    if (!closed) {
      return {
        kind: 'reject', conflicts: [],
        message: ERR_ELEVATOR_UPPER_UNCLOSABLE(plane.name),
      };
    }
    const conflicts = findShaftInstallConflicts(upperGraph, cells, equipmentSymbolsById);
    if (conflicts.length > 0) {
      const first = pickFirstConflict(conflicts);
      return {
        kind: 'reject',
        conflicts: [{ planeId: plane.id, floorLabel: plane.name, kind: first.kind, name: first.name, id: first.id }],
        message: ERR_ELEVATOR_UPPER_CONFLICT(plane.name, first.name),
      };
    }
    upperTargets.push({ plane, graph: upperGraph, cells });
  }

  const equipment = {
    id: crypto.randomUUID(),
    category: ElevatorEquipmentCategory.EV,
    usage: DEFAULT_EV_USAGE,
    no: nextEquipmentNo(catalog, ElevatorEquipmentCategory.EV),
  };
  return { kind: 'new', equipment, upperTargets };
}

/**
 * 上階1件ぶんの実際の書き込み（judgeElevatorInstall が 'new' を返したときの upperTargets 各要素に
 * 対して呼ぶ）。未定義Room群からセルを引き抜いてから installEquipment する。
 * @param {object} graph - 上階の一時グラフ
 * @param {{id:string, category:string, usage:string, no:number, cells:Set<string>}} params
 * @returns {{equipmentId:string, roomId:string}}
 */
export function installOnUpperFloor(graph, { id, category, usage, no, cells }) {
  subtractCellsFromUndefinedRooms(graph, cells);
  return installEquipment(graph, { id, category, usage, no, cells, candidateRoomId: null });
}
