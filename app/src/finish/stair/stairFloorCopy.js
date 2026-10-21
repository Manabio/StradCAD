/**
 * 階追加で、当該階（写し元）の階段を新しい階（写し先）へ写す（純モジュール。store.js・storage・.jsx・
 * FinishModeState.js を静的に引かない）。昇降機の copyElevatorRowsToGraph（equipmentFloorPlan.js）と同じ形。
 *
 * 階段は applyNaming（仕上げモードの階段指定）を通さず、写し元の Stair の値をそのまま写して直接組み立てる。
 * applyNaming を通すと、選択順（保存されない一時値）が無いため向き・出入口辺が既定値に落ち、
 * 仕上げの undo も別に積まれる。選択順の結果は type・sections・upDirection・flip・entrySide 等に入っている。
 * 蹴上 riser は写し元の値のまま（null＝階高から自動、は null のまま。明示は明示のまま）。
 *
 * 置けない階段（足元が写し先の昇降路・屋根・別の階段などと重なる／セルを写せない）は飛ばして skipped に積む。
 * 重なり判定は stairVoidReconcile の footprintBlocked と同じ規則で、CL を足す前に行う（飛ばすなら写し先は不変）。
 */
import { RoomFeature, RoomKind } from '@core';
import { refreshCells } from '../gridCells.js';
import {
  collectNeededCLs, addMissingCLs, extendDividerExtents, retargetKeysToCoveringCLs, translateCellSet,
} from '../floorCLMap.js';
import { FINISH_FIELDS } from '../roomReinterpret.js';
import { footprintBlocked, carveFootprint } from './stairVoidReconcile.js';
import { ensureUnderStairSplit } from './stairUnderSplit.js';
import { riserOf } from './stairDimensions.js';

// 写す Stair の値（id・cells・roomId は写し先で付け替える。sections は複製する）。Stair の項目を足したら
// ここにも足す（stairFloorCopy.test.js の不変条件テストが検出する）。
export const COPIED_STAIR_FIELDS = [
  'type', 'structure', 'totalSteps', 'tread', 'riser', 'nosing', 'width', 'upDirection', 'flip', 'sections',
  'entrySide', 'arrivalSide', 'entryTurnSteps', 'arrivalTurnSteps',
];

// 外部タブの連動行から写す項目（roomId は新しいペア部屋へ付け替える。finishUndo.js の EXTERIOR_FIELDS と同じ）
const EXTERIOR_ROW_FIELDS = ['finish', 'base', 'note'];

function stairOptions(src, cells, roomId) {
  const opts = { cells, roomId };
  for (const f of COPIED_STAIR_FIELDS) opts[f] = f === 'sections' ? (src.sections ? [...src.sections] : null) : src[f];
  return opts;
}

// 写し元のペア部屋（無ければ null）の項目を新しいペア部屋へ写す（C4）。feature は STAIR 固定。
// 写し元にペア部屋が無い旧データは name ''・kind INTERIOR（isIndoorStair の既定）。
function createPairRoom(dst, cells, srcRoom) {
  const room = dst.addRoom(new Set(cells), srcRoom?.name ?? '');
  room.setKind(srcRoom?.kind ?? RoomKind.INTERIOR);
  room.setFeature(RoomFeature.STAIR);
  if (!srcRoom) return room;
  room.setTemplateKey(srcRoom.templateKey);
  for (const [k, v] of srcRoom.customOverrides) room.customOverrides.set(k, v);
  for (const k of FINISH_FIELDS) if (srcRoom.finish[k]) room.finish.setField(k, srcRoom.finish[k]);
  if (srcRoom.namePosition) room.setNamePosition(srcRoom.namePosition.x, srcRoom.namePosition.y);
  if (srcRoom.floorLevel != null) room.setFloorLevel(srcRoom.floorLevel);
  if (srcRoom.exteriorSlope != null) room.setExteriorSlope(srcRoom.exteriorSlope);
  room.setExteriorLevelRef(srcRoom.exteriorLevelRef);
  if (srcRoom.exteriorLevel != null) room.setExteriorLevel(srcRoom.exteriorLevel);
  return room;
}

// 屋外階段: 写し元の外部タブの連動行（roomId が写し元のペア部屋）を新しいペア部屋へ写す
function copyExteriorRows(dst, src, srcRoomId, newRoomId) {
  for (const row of src.exteriorRows.filter(r => r.roomId === srcRoomId)) {
    const copy = dst.addExteriorRow('exteriorRows', row.part, newRoomId);
    for (const f of EXTERIOR_ROW_FIELDS) if (row[f]) copy.setField(f, row[f]);
  }
}

/**
 * srcGraph の階段を dstGraph へ写す（dstGraph を直接書き換える。srcGraph は読むだけ）。
 * 手順（1階段ごと・stairOrder 順）: 1.重なり判定 → 2.不足 CL の補完と区間延長 → 3.セルの付け替え →
 * 4.足元の引き抜き → 5.ペア部屋 → 6.階段 → 7.屋外階段の外部タブ行 → 8.直進の階段下分割CL。
 * 注意: 手順2の extendDividerExtents は結合で dstGraph を作り直す（restoreGraph）ので、Room・Stair の
 * 参照を階段をまたいで持たない（id で引き直す）。
 * @param {object} dstGraph    写し先（新しい階のグラフ）
 * @param {object} srcGraph    写し元（当該階のグラフ）
 * @param {object} structGraph project.structGraph
 * @param {{floorHeight?: number|null}} [opts] floorHeight＝写し先の階の階高（直上階まで。最上階は null）。
 *   直進階段の階段下分割CL（破れ線位置）の蹴上の導出に使う
 * @returns {{ changed: boolean,
 *   copied: Array<{srcStairId:string, stairId:string, roomId:string}>,
 *   skipped: Array<{srcStairId:string, reason:'overlap'|'untranslatable'}> }}
 */
export function copyStairsToGraph(dstGraph, srcGraph, structGraph, { floorHeight = null } = {}) {
  if (!dstGraph) throw new Error('copyStairsToGraph: dstGraph がありません');
  if (!srcGraph) throw new Error('copyStairsToGraph: srcGraph がありません');
  const result = { changed: false, copied: [], skipped: [] };

  for (const stair of srcGraph.stairs) {
    // 1. 重なり: CL を足す前に判定する（飛ばすなら写し先は一切変えない）
    if (footprintBlocked(dstGraph, srcGraph, stair)) { result.skipped.push({ srcStairId: stair.id, reason: 'overlap' }); continue; }

    // 2. 不足 CL の補完と、同座標の分割線の区間延長（reconcileStairVoids の手順1と同じ）
    const needed = collectNeededCLs(stair.cells, srcGraph);
    if (addMissingCLs(needed, srcGraph, structGraph, dstGraph) > 0) result.changed = true;
    if (extendDividerExtents(stair.cells, srcGraph, structGraph, dstGraph) > 0) result.changed = true;

    // 3. セルの付け替え（写し先の線 id へ。同座標の区間違いの分割線は辺を覆うものへ）
    const translatedRaw = translateCellSet(stair.cells, srcGraph, structGraph, dstGraph);
    const cells = translatedRaw ? retargetKeysToCoveringCLs(translatedRaw, dstGraph, structGraph) : null;
    if (!cells || refreshCells(cells, dstGraph).size === 0) {
      result.skipped.push({ srcStairId: stair.id, reason: 'untranslatable' });
      continue;
    }

    // 4. 足元の引き抜き（addStairVoidRoom と同じ規則）。置けなければ飛ばす（二重の守り）
    if (!carveFootprint(dstGraph, cells)) { result.skipped.push({ srcStairId: stair.id, reason: 'overlap' }); continue; }
    result.changed = true;

    // 5-6. ペア部屋と階段
    const srcRoom = stair.roomId ? srcGraph.roomMap.get(stair.roomId) ?? null : null;
    const pair = createPairRoom(dstGraph, cells, srcRoom);
    const created = dstGraph.addStair(stairOptions(stair, new Set(cells), pair.id));

    // 7. 屋外階段の外部タブの連動行
    if (srcRoom && srcRoom.kind === RoomKind.EXTERIOR) copyExteriorRows(dstGraph, srcGraph, srcRoom.id, pair.id);

    // 8. 直進階段は階段下の分割CL（applyNaming と同じ。蹴上は写し先の階高から）
    ensureUnderStairSplit(created, dstGraph, riserOf(created, floorHeight));

    result.copied.push({ srcStairId: stair.id, stairId: created.id, roomId: pair.id });
  }
  return result;
}
