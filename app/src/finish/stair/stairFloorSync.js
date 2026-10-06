import { floorSwapManager } from '../../storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../../graphSnapshot.js';
import { saveFloor } from '../../storage/db.js';
import { undoManager } from '../../undoManager.js';
import { refreshCells } from '../gridCells.js';
import { ensureStairRooms } from '../roomReinterpret.js';
import { collectNeededCLs, addMissingCLs, translateCellSet } from '../floorCLMap.js';
import { RoomFeature, isRoofFeature } from '@core';
import { setsEqual, isIndoorStair, addStairVoidRoom, reconcileStairVoids } from './stairVoidReconcile.js';
import { upperAdoptedPlanes } from '../roof/roofFloorCheck.js';
import { findStairUpperRoofConflicts } from './stairRoofConflict.js';
import {
  ERR_STAIR_UPPER_ROOF, tagElevatorOpFailure,
  ERR_STAIR_DELETE_FAILED, ERR_STAIR_DELETE_FAILED_MESSAGE, ERR_STAIR_FLOORS_CHANGED,
} from '../../error.js';
import { floorWriteGeneration } from '../../storage/floorWriteGeneration.js';
import { rollbackSavedFloors, applyRecords, amendOnAppliedOnly } from '../floorUndoRecords.js';
import { planStairRemovalCascade, applyStairRemovalToFloor } from './stairRemoval.js';

// setsEqual・isIndoorStair・addStairVoidRoom は純モジュール stairVoidReconcile.js へ移した（挙動は同じ）

/**
 * 階段の新規指定（部屋→階段）の事前チェック。syncUpperFloors が展開する位置（設置階の直上1階の、
 * 屋内階段の footprint に置く階段吹抜け）に屋根（ROOF）があるかを、直上の採用階だけ peek して調べ、
 * あれば拒否のメッセージを返す（無ければ null）。屋外階段は何も置かないので peek せず null。
 * 読むだけ——peek した一時グラフへ CL を足すが保存しない。
 * 呼び出し側（App.jsx convertStairFromNaming）は、graph・他階の保存データを一切変える前にこれを呼び、
 * メッセージがあれば階段の指定を確定しない（昇降機の judgeElevatorInstall と同じ「確定前の拒否」）。
 * peekFn の失敗は握りつぶさず reject する（呼び出し側が「確かめられなかったので指定しない」とする）。
 *
 * @param {object} project
 * @param {object} activeGraph - 設置階（アクティブ）のグラフ
 * @param {Set<string>} cells - 階段にする部屋のセル（raw）
 * @param {boolean} indoor - 屋内階段か（屋外階段は上階に何も置かない）
 * @param {(plane: object) => Promise<object>} [peekFn] - 既定 floorSwapManager.peek（テスト注入用。挙動は変えない）
 * @returns {Promise<string|null>} 拒否メッセージ（衝突なしなら null）
 */
export async function findStairUpperRoofRejection(
  project, activeGraph, cells, indoor,
  peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
) {
  const [next] = upperAdoptedPlanes(project.planes, activeGraph?.plane); // 直上の1階だけ
  if (!next || !indoor) return null;
  const floors = [{ plane: activeGraph.plane, graph: activeGraph }];
  const graph = await peekFn(next);
  if (!graph) throw new Error(`findStairUpperRoofRejection: peek が階のグラフを返しませんでした（plane=${next.id}）`);
  floors.push({ plane: next, graph });
  const conflicts = findStairUpperRoofConflicts({
    structGraph: project.structGraph, floors, activeIndex: 0, cells, indoor,
  });
  return conflicts.length > 0 ? ERR_STAIR_UPPER_ROOF(conflicts.map(c => c.floorLabel)) : null;
}

/**
 * 階段を設置した階（activeGraph）の「直上の採用階1階だけ」へ、階段吹抜け（STAIR_VOID）を整合する
 * （変更があれば peek → saveFloor）。上階には階段実体を置かない。続けて上るときは上階でユーザーが
 * 階段を指定し、同 footprint の吹抜けはペアRoomへ転用される。それより上の階には何もしない。
 *
 * 1. reconcileStairVoids（stairVoidReconcile.js）: 不足CLの補完・屋内階段の足元の写し・孤児の
 *    吹抜けの未定義化・重複の削除・追加を行う（屋外階段は対象外。通り芯だけの階段も置く）。
 * 2. ensureStairRooms: 直上階の roomId なしの階段（ユーザー指定分）へ feature=STAIR の Room を作り
 *    相互リンクする。reconcile の後に回す——同 footprint の吹抜けがペアRoomへ転用される。
 *
 * 壁は生成しない（ユーザー決定：階段設置と同時の壁生成は行わない。上階の外壁は
 * 階段吹抜けの kind=INTERIOR を通じて通常の屋内外判定・外壁生成に委ねる）。階段側の仕上げ壁も
 * ここでは生成しない——階段吹抜け・ペアRoomも通常のRoomと同じ経路
 * （finish/finishBoundary.js runFinishExitBoundary ステップ1〜3）で壁を持つため、
 * その階自身が仕上げモードを脱出したときに生成される。設置階ペアRoomの内装
 * （templateKey・customOverrides）は、仕上げモード脱出時に syncUpperStairInteriors が
 * 別途同期コピーする。
 *
 * 非アクティブ階への変更は floorSwapManager.peek → saveFloor の既存パターンを踏襲する。
 * 対象の階がアクティブ階のとき（syncUpperFloorsAuto 経由）はメモリ上のグラフを直接更新する
 * （本体のコメント参照）。
 *
 * undo: opts.undoEntry（applyNaming が積んだ階段変換エントリ）を渡すと、変更した階の
 * before/after をシリアライズ済みバイト列で記録し、そのエントリへ合成（undoManager.amend）
 * する——変換の Ctrl+Z 1回で直上階の吹抜けもまとめて巻き戻る。復元はその階が
 * アクティブならメモリ上のグラフへ restoreGraph、非アクティブなら saveFloor で IDB へ
 * 書き戻す（peek はキャッシュを持たず毎回 IDB から読むため、これで完全に復元される）。
 * undoEntry を渡さない呼び出し（階追加時の syncUpperFloorsAuto 等）は従来どおり undo 対象外。
 *
 * @param {object} project
 * @param {object} activeGraph - 設置階（アクティブ）のグラフ
 * @param {object} [opts]
 * @param {object|null} [opts.undoEntry] - 合成先の undo エントリ（undoManager.push の戻り値）
 * @param {(plane: object) => Promise<object>} [opts.peekFn] - 既定 floorSwapManager.peek（テスト注入用。挙動は変えない）
 * @param {(planeId: string, bytes: Uint8Array) => Promise<void>} [opts.saveFloorFn] - 既定 saveFloor（テスト注入用。挙動は変えない）
 */
export async function syncUpperFloors(project, activeGraph, {
  undoEntry = null,
  peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
  saveFloorFn = saveFloor,
} = {}) {
  const planes = project.planes; // elevation 昇順・採用フロアのみ（検討フロア/屋根伏図は除外済み）
  const active = activeGraph?.plane;
  if (!active) return;
  const idx = planes.findIndex(p => p.id === active.id);
  if (idx < 0 || idx + 1 >= planes.length) return; // 最上階には上階がない

  const plane = planes[idx + 1]; // 対象は直上の1階だけ
  const undoRecords = []; // { planeId, before, after }（undoEntry がある場合のみ収集）

  // 起点探索付き同期（syncUpperFloorsAuto）ではアクティブ階が同期対象になりうる。
  // アクティブ階を peek→saveFloor で書き換えると、後のモード切替保存（floorSwapManager.swap が
  // メモリ上のグラフを保存する）で上書き消失するため、メモリ上のグラフを直接更新する
  // （永続化は auto-save / floorSwapManager.swap に任せ、saveFloor はスキップする）。
  const isActive = plane.id === project.activePlane?.id;
  const temp = isActive
    ? project.activeGraph
    : await peekFn(plane);
  const beforeBytes = undoEntry ? serializeGraph(temp) : null;
  let changed = false;

  // 1. 直上階の吹抜けを整合する（不足CL補完・足元の写し・孤児/重複の削除・追加）
  if (reconcileStairVoids(temp, activeGraph, project.structGraph).changed) changed = true;

  // 2. ペアRoomの補完: ユーザーが直上階で指定した階段（roomId なし）へ feature=STAIR の Room を
  //    作り相互リンクする（data-model.md の不変条件）。reconcile の後に回すこと——
  //    footprint が一致する階段吹抜けはペア Room へ転用される。
  if (ensureStairRooms(temp).length > 0) changed = true;

  if (changed && !isActive) await saveFloorFn(plane.id, serializeGraph(temp));
  if (changed && undoEntry) {
    undoRecords.push({ planeId: plane.id, before: beforeBytes, after: serializeGraph(temp) });
  }

  // 変更した各階の巻き戻し・再適用を、変換エントリ（undoEntry）へ合成する
  if (undoEntry && undoRecords.length > 0) {
    const applyBytes = (which) => {
      for (const rec of undoRecords) {
        if (project.activePlane?.id === rec.planeId) {
          restoreGraph(project.activeGraph, rec[which]); // undo 時にその階がアクティブなら生きているグラフへ復元
        } else {
          saveFloorFn(rec.planeId, rec[which]).catch(console.error); // 非アクティブ階は IDB のみが正
        }
      }
    };
    undoManager.amend(undoEntry, () => applyBytes('before'), () => applyBytes('after'));
  }
}

/**
 * syncUpperFloors の起点探索付きラッパー（階追加時用）。表示中の階（sourceGraph）に階段が
 * あればそのまま同期し、無ければそれより下の採用フロアを上から順に peek して、階段を持つ
 * 最初の階を起点に同期する。同期されるのは起点の直上1階だけ（syncUpperFloors）。
 * ステップ5で follower ごと置き換える予定。
 */
export async function syncUpperFloorsAuto(project, sourceGraph) {
  if (sourceGraph.stairs.length > 0) return syncUpperFloors(project, sourceGraph);
  const planes = project.planes;
  const idx = planes.findIndex(p => p.id === sourceGraph.plane?.id);
  for (let i = idx - 1; i >= 0; i--) {
    const temp = await floorSwapManager.peek(planes[i], project.structGraph);
    if (temp.stairs.length > 0) return syncUpperFloors(project, temp);
  }
}

/**
 * アクティブ階が最上階（採用）のとき、直下階の屋内階段 footprint へ階段吹抜け（STAIR_VOID）を
 * 補完する（仕上げモード突入時の既存データ修復。syncUpperFloors と同じ自動同期のため undo 対象外）。
 * ステップ5で reconcileStairVoids へ置き換える予定（このステップでは触らない）。
 * @returns {Promise<boolean>} 追加したか
 */
export async function ensureTopStairVoid(project, activeGraph) {
  const planes = project.planes;
  const idx = planes.findIndex(p => p.id === activeGraph?.plane?.id);
  if (idx < 1 || idx !== planes.length - 1) return false; // 最上階のみ・下階必須
  const below = await floorSwapManager.peek(planes[idx - 1], project.structGraph);
  let changed = false;
  for (const stair of below.stairs) {
    if (!isIndoorStair(below, stair)) continue;
    const cells = translateCellSet(stair.cells, below, project.structGraph, activeGraph);
    if (!cells) continue; // CL変換不能 → 安全側でスキップ
    if (addStairVoidRoom(activeGraph, cells)) changed = true;
  }
  return changed;
}

/**
 * 階段設置階の仕上げモード脱出時に、直上1階の階段 footprint（階段吹抜け STAIR_VOID・
 * 同 footprint のペアRoom）へ、設置階ペアRoomの内装（templateKey・customOverrides）を
 * 同期コピーする（階段仕上げ材の参照。以降はその階の Room＝仕上げ表のカードが単一情報源）。
 *
 * 壁はこの同期では生成しない——新モデルでは階段ペアRoom・階段吹抜けも通常のRoomと同じ経路
 * （finish/finishBoundary.js runFinishExitBoundary ステップ1〜3。下地オーナー壁＋仕上げ薄壁方式）で壁を持つため、
 * 上階の壁はその階自身が仕上げモードを脱出した際に生成される。旧データ（同一CL上の二重壁等）の
 * 修復も、その階の仕上げモード脱出時の全削除・再生成（ステップ1）が担う——この同期関数では
 * 何もしない。
 * - 対象は「内装未編集（templateKey なし・customOverrides 空）」の Room のみコピーする。
 *   ユーザーが編集済みの内装は上書きしない。
 * - 直上1階だけが対象。さらに上の階は、続けて上る階段をユーザーが指定した階自身の脱出時に同期される。
 *
 * syncUpperFloors と同じ自動同期のため undo 対象外。呼び出しは仕上げモード脱出時
 * （設置階がアクティブな時）のみ＝同期対象は常に非アクティブ階（peek → saveFloor）。
 *
 * @param {object} project
 * @param {object} activeGraph - 脱出した階（アクティブ）のグラフ
 * @param {object} [opts]
 * @param {(plane: object) => Promise<object>} [opts.peekFn] - 既定 floorSwapManager.peek（テスト注入用。挙動は変えない）
 * @param {(planeId: string, bytes: Uint8Array) => Promise<void>} [opts.saveFloorFn] - 既定 saveFloor（テスト注入用。挙動は変えない）
 */
export async function syncUpperStairInteriors(project, activeGraph, {
  peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
  saveFloorFn = saveFloor,
} = {}) {
  const planes = project.planes;
  const active = activeGraph?.plane;
  if (!active || activeGraph.stairs.length === 0) return;
  const idx = planes.findIndex(p => p.id === active.id);
  if (idx < 0 || idx + 1 >= planes.length) return;

  const plane = planes[idx + 1]; // 直上の1階だけ
  if (plane.id === project.activePlane?.id) return; // 想定外（呼び出しは脱出階がアクティブな時のみ）
  const temp = await peekFn(plane);
  let changed = false;

  for (const stair of activeGraph.stairs) {
    const srcRoom = stair.roomId ? (activeGraph.roomMap.get(stair.roomId) ?? null) : null;
    if (!srcRoom) continue;
    const translated = translateCellSet(stair.cells, activeGraph, project.structGraph, temp);
    if (!translated) continue; // CL変換不能 → 安全側でこの階段はスキップ
    const cells = refreshCells(translated, temp);
    if (cells.size === 0) continue;

    const room = temp.rooms.find(r =>
      (r.feature === RoomFeature.STAIR || r.feature === RoomFeature.STAIR_VOID) &&
      setsEqual(refreshCells(r.cells, temp), cells)) ?? null;
    if (!room) continue;

    // 内装コピー: 未編集の Room のみ（ユーザー編集済みの内装は上書きしない）
    if (room.templateKey == null && room.customOverrides.size === 0) {
      if (srcRoom.templateKey != null) { room.setTemplateKey(srcRoom.templateKey); changed = true; }
      for (const [k, v] of srcRoom.customOverrides) { room.customOverrides.set(k, v); changed = true; }
    }
  }

  if (changed) await saveFloorFn(plane.id, serializeGraph(temp));
}

/**
 * 元階（sourceGraph）に外壁ループ（isExteriorWall の壁）がある状態で階を追加したとき、
 * 新階（newPlane）へ「外壁ループ内側の領域」を1つの Room（部屋名 roomName。例:"2階"）として
 * 自動追加する。外壁線自体はコピーしない（部屋があれば仕上げモード境界の外壁再生成
 * （finish/finishBoundary.js の finish モード退出処理ステップ3）が自動生成するため）。
 *
 * セル集合は元階の全 Room セル ∪ 全階段 footprint セル（refreshCells で現行グリッドへ展開）
 * とする。外壁ループ（'outer'）の内側は、部屋・階段以外に建物内部の領域が無いことから
 * 通常この和集合と一致する。階段は通常 feature=STAIR のペア Room を持ち Room セル側にも
 * 含まれるが（data-model.md）、ペア Room を補完できない互換経路（既存 Room とフットプリント
 * が重なる場合）が残るため、階段 footprint の和集合は安全網として維持する。
 * 完全な一致が崩れるケース（外壁ループに寄与しない離れ部屋等）でも、この和集合を安全側の
 * 近似として採用する（過小に切り詰めるより、部屋が実領域より広く複写される方が実害が小さい）。
 *
 * 部分指定（referenceRoomIds）は作らない（プレーンな addRoom）。
 *
 * @param {object} project
 * @param {object} sourceGraph - 元階（表示中）のグラフ
 * @param {object} newPlane - 追加した新しい Plane
 * @param {string} roomName - 新規 Room の名前（例:"2階"）
 * @param {(plane: object) => Promise<object>} [peekFn] - 既定 floorSwapManager.peek（テスト注入用。挙動は変えない）
 * @param {(planeId: string, bytes: Uint8Array) => Promise<void>} [saveFloorFn] - 既定 saveFloor（テスト注入用。挙動は変えない）
 */
export async function addNewFloorRoomFromSource(
  project, sourceGraph, newPlane, roomName,
  peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
  saveFloorFn = saveFloor,
) {
  const sourceCells = new Set();
  for (const room of sourceGraph.rooms) {
    // 屋根（下屋）のセルは写さない: 屋根の上の階は建物の外（無割当と同値）で、屋内部屋を作ると
    // 屋根の上に部屋ができてしまう。
    if (isRoofFeature(room.feature)) continue;
    for (const key of refreshCells(room.cells, sourceGraph)) sourceCells.add(key);
  }
  for (const stair of sourceGraph.stairs) {
    for (const key of refreshCells(stair.cells, sourceGraph)) sourceCells.add(key);
  }
  if (sourceCells.size === 0) return;

  const temp = await peekFn(newPlane);

  // 不足CLを追加（部屋領域分。階段 footprint 分の不足CLは syncUpperFloors が別途担当する）
  const needed = collectNeededCLs(sourceCells, sourceGraph);
  addMissingCLs(needed, sourceGraph, project.structGraph, temp);

  const translated = translateCellSet(sourceCells, sourceGraph, project.structGraph, temp);
  if (!translated || translated.size === 0) return; // CL変換不能 → 安全側で見送る
  // 新階の格子が元の階より細かい場合（昇降機の複製等が先に per-floor 中心線を足している）、
  // translateCellSet が返す生キーは元の階の粒度のままで、新階側の細かい格子のキーとは
  // 一致しない——refreshCells で現在のグリッド分割へ展開してから assigned と比較する。
  const translatedCells = refreshCells(translated, temp);
  if (translatedCells.size === 0) return;

  // 新階側で既に割当済みのセル（直前の syncUpperFloors が自動指定した階段吹抜け・複製した
  // 昇降機等）は除外する（セルの二重割当防止。階段部は吹抜け側が「屋内」を担うため壁生成にも
  // 影響しない）。
  const assigned = new Set();
  for (const room of temp.rooms) {
    for (const key of refreshCells(room.cells, temp)) assigned.add(key);
  }
  const freeCells = new Set([...translatedCells].filter(k => !assigned.has(k)));
  if (freeCells.size === 0) return;

  temp.addRoom(freeCells, roomName);
  await saveFloorFn(newPlane.id, serializeGraph(temp));
}

/**
 * 階段の削除本体。設置階（アクティブ）で階段を削除するとき、直上1階の同 footprint の階段吹抜け
 * （STAIR_VOID。syncUpperFloors が置いたもの）を全部未定義化する（finish/stair/stairRemoval.js が計画・適用）。
 * 直上階のユーザー指定の階段・それより上の階は触らない。続けて自階に、直下階の階段の足元の吹抜けを
 * reconcileStairVoids で復元する（直下階が無ければ何もしない）。判定→直上階への書込み→設置階の確定
 * （commitActive）→自階の整合→undo 合成の順で進める（昇降機の runElevatorRemoval と同じ順序規則）。
 *
 * - アクティブ階にその階段が無ければ noop。
 * - 検討案の平面（採用階でない）がアクティブなら、自階だけ確定する（判定も上の階の書込みもしない）。
 * - どの階の階段も自分の階で削除できる（拒否しない）。
 * - 上の階の per-floor 中心線は消さない（未定義化した部屋のセルが参照する）。
 * - 必要な実 I/O（peek）はすべて確定（commitActive）より前に済ませ、確定の後に await を挟まない。
 *
 * @param {object} params
 * @param {object} params.project
 * @param {object} params.activeGraph - 設置階（アクティブ）のグラフ
 * @param {string} params.stairId
 * @param {() => object|null} params.commitActive - 設置階の削除を同期で確定し、undo エントリ
 *   （undoManager.push の戻り値）を返す
 * @param {() => boolean} params.isStillValid
 * @param {() => void} [params.onApplied] - 反映後（amend 済み）と undo/redo の適用後に呼ぶ
 * @param {(plane: object) => Promise<object>} [params.peekFn] - 既定 floorSwapManager.peek
 * @param {(planeId: string, bytes: Uint8Array) => Promise<void>} [params.saveFloorFn] - 既定 saveFloor
 * @returns {Promise<
 *   {status:'removed', upperCount:number} |
 *   {status:'rejected', message:string} |
 *   {status:'aborted', message:string|null} |
 *   {status:'noop'}
 * >}
 */
export async function runStairRemoval({
  project, activeGraph, stairId,
  commitActive, isStillValid, onApplied,
  peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
  saveFloorFn = saveFloor,
}) {
  const stair = activeGraph.stairMap.get(stairId);
  if (!stair) return { status: 'noop' };
  const tag = (err) => tagElevatorOpFailure(err, { code: ERR_STAIR_DELETE_FAILED, message: ERR_STAIR_DELETE_FAILED_MESSAGE });
  // 巻き戻し自体が失敗しても、識別コードなしの例外を抜けさせない（rollbackSavedFloors は全件試行後に最初の例外を投げる）。
  const rollback = async (savedPlaneIds, beforeBytesByPlane) => {
    try { await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn); } catch (err) { throw tag(err); }
  };

  const planes = project.planes; // 採用フロアのみ・elevation 昇順
  const activeIndex = planes.findIndex(p => p.id === activeGraph.plane.id);

  // 検討案の平面がアクティブ→自階だけ確定する。上の階は無いが、undo/redo の後も呼び出し側の再読込み
  // （onApplied）が要るため、「何もしない＋onApplied を呼ぶ」だけを合成する。
  if (activeIndex < 0) {
    let entry;
    try { entry = commitActive(); } catch (err) { throw tag(err); }
    if (!entry) throw tag(new Error('runStairRemoval: commitActive returned no undo entry (検討案の平面)'));
    amendOnAppliedOnly(entry, onApplied);
    onApplied?.();
    return { status: 'removed', upperCount: 0 };
  }

  // 1. 直下階（削除後の吹抜けの整合に使う）と直上の1階だけを peek し、直上階は peek 直前の書込み世代・
  // 直後の before を控える。どの階の階段も自分の階で消せる（拒否しない）。ここまでの例外はまだ何も書いて
  // いないので巻き戻さず、識別コードだけ付けて再スローする。
  const genBeforePeek = new Map();      // planeId -> peek 直前の世代
  const beforeBytesByPlane = new Map(); // planeId -> peek 直後のバイト列
  const uppers = [];
  let targets;
  let belowGraph;
  try {
    belowGraph = activeIndex > 0 ? await peekFn(planes[activeIndex - 1]) : null;
    const upperPlane = planes[activeIndex + 1];
    if (upperPlane) {
      genBeforePeek.set(upperPlane.id, floorWriteGeneration(upperPlane.id));
      const graph = await peekFn(upperPlane);
      beforeBytesByPlane.set(upperPlane.id, serializeGraph(graph));
      uppers.push({ plane: upperPlane, graph });
    }
    // 2. 連動して消す対象を決める。
    targets = planStairRemovalCascade({ structGraph: project.structGraph, activeGraph, stair, uppers });
    // アクティブ階を peek→saveFloor で書くと、メモリ上のグラフとの二重書込みになる（黙って上書きしない）。
    const clash = targets.find(t => t.plane.id === activeGraph.plane.id || t.plane.id === project.activePlane?.id);
    if (clash) throw new Error(`runStairRemoval: 連動削除の対象にアクティブ階が含まれています（plane=${clash.plane.id}）`);
  } catch (err) {
    throw tag(err);
  }

  // 3. isStillValid 確認（peek 区間で状態が変わりうる）。偽なら書込みゼロ。
  if (!isStillValid()) return { status: 'aborted', message: null };

  // 4. 対象の各階（昇順）: 世代の一致確認→変更→直列化→保存。平面単位に1回 peek・1回保存。
  // 変更・直列化・保存のどれが例外を投げても、保存済みの階を巻き戻してから識別コード付きで再スローする。
  const savedPlaneIds = [];
  const afterBytesByPlane = new Map();
  for (const target of targets) {
    const { plane, graph } = target;
    if (floorWriteGeneration(plane.id) !== genBeforePeek.get(plane.id)) {
      await rollback(savedPlaneIds, beforeBytesByPlane);
      return { status: 'aborted', message: ERR_STAIR_FLOORS_CHANGED };
    }
    try {
      applyStairRemovalToFloor(graph, target);
      const afterBytes = serializeGraph(graph);
      await saveFloorFn(plane.id, afterBytes);
      afterBytesByPlane.set(plane.id, afterBytes);
      savedPlaneIds.push(plane.id);
    } catch (err) {
      await rollback(savedPlaneIds, beforeBytesByPlane);
      throw tag(err);
    }
  }

  // 5. isStillValid 再確認。偽なら上の階を巻き戻す。
  if (!isStillValid()) {
    await rollback(savedPlaneIds, beforeBytesByPlane);
    return { status: 'aborted', message: null };
  }

  // 6. 設置階の削除を同期で確定する。例外・null なら上の階を巻き戻す。
  let entry;
  try {
    entry = commitActive();
  } catch (err) {
    await rollback(savedPlaneIds, beforeBytesByPlane);
    throw tag(err);
  }
  if (!entry) {
    await rollback(savedPlaneIds, beforeBytesByPlane);
    throw tag(new Error('runStairRemoval: commitActive returned no undo entry'));
  }

  // 6b. 削除後の整合: 自階（設置階）に、直下階の階段の足元の吹抜けを復元する（直下階に階段がある位置の
  // 階段を自階で消したとき、その足元は「直下階の階段の吹抜け」として残る）。直下階は確定前に peek 済みで、
  // ここは同期処理だけ。自階のメモリ上のグラフを直接更新し、変更前後のバイト列を記録へ足す（undo は
  // 6b の前の状態へ戻した後に確定エントリ本体が戻る）。
  const records = savedPlaneIds.map(planeId => ({
    planeId, before: beforeBytesByPlane.get(planeId), after: afterBytesByPlane.get(planeId),
  }));
  let reconcileError = null;
  if (belowGraph) {
    const preBytes = serializeGraph(activeGraph);
    try {
      if (reconcileStairVoids(activeGraph, belowGraph, project.structGraph).changed) {
        records.push({ planeId: activeGraph.plane.id, before: preBytes, after: serializeGraph(activeGraph) });
      }
    } catch (err) {
      reconcileError = err;
      restoreGraph(activeGraph, preBytes); // 途中まで書いた分を戻す（確定エントリ本体の undo は有効のまま）
    }
  }

  // 7. 上の階・6b の before/after を設置階のエントリへ合成する（Ctrl+Z 1回で全階が戻る）。上の階が0件でも、
  // 設置階自体の undo/redo の後に再読込みが要るため同様に amend する。
  undoManager.amend(
    entry,
    () => { applyRecords(project, records, 'before', saveFloorFn); onApplied?.(); },
    () => { applyRecords(project, records, 'after', saveFloorFn); onApplied?.(); },
  );
  onApplied?.();

  if (reconcileError) throw tag(reconcileError); // 合成まで済ませてから知らせる（状態は undo で戻せる）
  return { status: 'removed', upperCount: targets.length };
}
