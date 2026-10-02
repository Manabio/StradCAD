/**
 * 上に階を追加して最上階が入れ替わったとき、旧最上階の主屋根の値を新しい最上階へ写す（ステップ B3。ユーザー裁定）。
 *
 * 写すのは「上に階を追加した」ときだけ（floorOrderChange.js の follower 'mainRoofCarry'。appliesTo は INSERT のみ）。
 * 階の削除・並べ替え・階変更・下への追加では写さない（新しい最上階が自分の値を使う）。途中階への追加は
 * 追加した階が最上階にならないので何も起きない。旧最上階の値は残す（消さない）。旧最上階の検討案が持つ主屋根は
 * 写さない（採用フロアの値だけを引き継ぐ）。旧最上階が既定値のままなら何も書かない。
 *
 * 新しい最上階は非アクティブで IDB にしか無い（階切替の前）ため、他階へ書く既存の流儀
 * （peek → 変更 → serializeGraph → saveFloor。stairFloorSync.js addNewFloorRoomFromSource と同じ）で書く。
 * 階追加の undo は追加階ごと消すため、ここで書いた値も一緒に消える（旧最上階には何も書かない）。
 */
import { runInAction } from 'mobx';
import { RoofSpec, isDefaultRoofSpec } from '@core';
import { serializeGraph } from '../../graphSnapshot.js';
import { saveFloor } from '../../storage/db.js';
import { floorSwapManager } from '../../storage/FloorSwapManager.js';

/**
 * @param {object} project
 * @param {object} addedPlane - 追加した新しい Plane
 * @param {(plane: object) => Promise<object>|object} [peekFn] - 既定 floorSwapManager.peek（テスト注入用。挙動は変えない）
 * @param {(planeId: string, bytes: Uint8Array) => Promise<void>} [saveFloorFn] - 既定 saveFloor（テスト注入用。挙動は変えない）
 * @returns {Promise<'carried'|'notTop'|'default'>}
 *   'carried'＝新しい最上階へ書いた／'notTop'＝追加した階が最上階にならない（または旧最上階が無い）／
 *   'default'＝旧最上階が既定値のまま（何も書かない）
 */
export async function carryMainRoofToNewTop(
  project, addedPlane,
  peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
  saveFloorFn = saveFloor,
) {
  const planes = project.planes;
  const top = planes[planes.length - 1];
  const oldTop = planes[planes.length - 2];
  if (!addedPlane || !top || top.id !== addedPlane.id || !oldTop) return 'notTop';

  // 旧最上階の値。アクティブ階は生きている graph（auto-save 前の未保存の編集を含む）、それ以外は peek
  const oldGraph = project.activePlaneId === oldTop.id ? project.activeGraph : await peekFn(oldTop);
  const spec = oldGraph.mainRoofSpec;
  if (isDefaultRoofSpec(spec)) return 'default';

  const temp = await peekFn(addedPlane);
  runInAction(() => temp.setMainRoofSpec(RoofSpec.fromData(spec.toData())));
  await saveFloorFn(addedPlane.id, serializeGraph(temp));
  return 'carried';
}
