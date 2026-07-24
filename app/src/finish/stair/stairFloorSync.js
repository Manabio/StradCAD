import { floorSwapManager } from '../../storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../../graphSnapshot.js';
import { saveFloor } from '../../storage/db.js';
import { undoManager } from '../../undoManager.js';
import { refreshCells } from '../gridCells.js';
import { ensureStairRooms } from '../roomReinterpret.js';
import { generateRoomWallsFromOutline } from '../wallGeneration.js';
import { stairPortEdges } from './stairGeometry.js';
import { RoomFeature, RoomKind } from '@core';

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

// 屋内階段判定: ペア Room の kind が EXTERIOR でなければ屋内（roomId なしの旧データは屋内扱い）
function isIndoorStair(graph, stair) {
  const room = stair.roomId ? graph.roomMap.get(stair.roomId) : null;
  return (room?.kind ?? RoomKind.INTERIOR) !== RoomKind.EXTERIOR;
}

/**
 * 最上階の階段 footprint へ階段吹抜け（STAIR_VOID）Room を自動指定する。
 * 既存 Room（stairVoid 自身を含む）とセルが重なる場合は何もしない（冪等・二重割当防止）。
 * @returns {boolean} 追加したか
 */
function addStairVoidRoom(graph, cells) {
  if (cells.size === 0) return false;
  for (const room of graph.rooms) {
    const roomCells = refreshCells(room.cells, graph);
    if ([...cells].some(k => roomCells.has(k))) return false;
  }
  const room = graph.addRoom(new Set(cells));
  room.setFeature(RoomFeature.STAIR_VOID);
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
 * 階段を設置した階（activeGraph）の上に採用フロアが複数あるとき、その全階（最上階まで）へ
 * 以下を順に反映する（各階、変更があれば peek → saveFloor）:
 *
 * 1. 中心線の同期: 設置階の階段 footprint を定義する per-floor 中心線のうち、その階に
 *    存在しないものを追加する（短縮区間 extent も写す）。通り芯（structGraph CL）は
 *    全階共通のため対象外。
 * 2. 階段の自動設置: その階の「さらに上」にも採用フロアがある場合のみ（最上階には設置
 *    しない＝階段は次階への到達手段のため）、同 footprint の階段がまだ無ければ設置階と
 *    同じ内容（sections 含む）で追加する（type:value 照合で冪等）。最上階には代わりに、
 *    屋内階段の footprint へ階段吹抜け（STAIR_VOID）を自動指定する（addStairVoidRoom）。
 * 3. ペアRoomの補完: roomId なしの階段へ feature=STAIR の Room を作り相互リンクする
 *    （ensureStairRooms。設置階と同じ不変条件を上階でも守る——data-model.md）。
 *
 * 壁は生成しない（ユーザー決定：階段設置と同時の壁生成は行わない。上階の外壁は
 * ペアRoom・階段吹抜けの kind=INTERIOR を通じて通常の屋内外判定・外壁生成に委ねる）。
 * 階段側の仕上げ壁は、仕上げモード脱出時に syncUpperStairFinishWalls が別途同期生成する。
 *
 * 非アクティブ階への変更はいずれも floorSwapManager.peek → saveFloor の既存パターンを踏襲する。
 * 同期対象にアクティブ階が含まれる場合（syncUpperFloorsAuto 経由）はメモリ上のグラフを
 * 直接更新する（ループ内コメント参照）。
 *
 * undo: opts.undoEntry（applyNaming が積んだ階段変換エントリ）を渡すと、変更した各階の
 * before/after をシリアライズ済みバイト列で記録し、そのエントリへ合成（undoManager.amend）
 * する——変換の Ctrl+Z 1回で上階の自動設置分もまとめて巻き戻る。復元はその階が
 * アクティブならメモリ上のグラフへ restoreGraph、非アクティブなら saveFloor で IDB へ
 * 書き戻す（peek はキャッシュを持たず毎回 IDB から読むため、これで完全に復元される）。
 * undoEntry を渡さない呼び出し（階追加時の syncUpperFloorsAuto 等）は従来どおり undo 対象外。
 *
 * @param {object} project
 * @param {object} activeGraph - 設置階（アクティブ）のグラフ
 * @param {object} [opts]
 * @param {object|null} [opts.undoEntry] - 合成先の undo エントリ（undoManager.push の戻り値）
 */
export async function syncUpperFloors(project, activeGraph, { undoEntry = null } = {}) {
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

  const undoRecords = []; // { planeId, before, after }（undoEntry がある場合のみ収集）

  for (let i = idx + 1; i < planes.length; i++) {
    const plane = planes[i];
    const hasFloorAbove = i + 1 < planes.length; // このフロアの、さらに上に採用フロアがあるか
    // 起点探索付き同期（syncUpperFloorsAuto）ではアクティブ階が同期対象に含まれうる。
    // アクティブ階を peek→saveFloor で書き換えると、後のモード切替保存（deactivate が
    // メモリ上のグラフを保存する）で上書き消失するため、メモリ上のグラフを直接更新する
    // （永続化は auto-save / deactivate に任せ、saveFloor はスキップする）。
    const isActive = plane.id === project.activePlane?.id;
    const temp = isActive
      ? project.activeGraph
      : await floorSwapManager.peek(plane, project.structGraph);
    const beforeBytes = undoEntry ? serializeGraph(temp) : null;
    let changed = false;

    // 1. 不足CLを追加（extent も写す）
    if (addMissingCLs(needed, activeGraph, project.structGraph, temp) > 0) changed = true;

    // 2. 階段の自動設置（さらに上に採用フロアがある場合のみ＝最上階には設置しない。
    //    階段は次階への到達手段のため）。
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
      } else if (isIndoorStair(activeGraph, stair)) {
        // 最上階: 屋内階段の footprint へ階段吹抜け（STAIR_VOID）を自動指定する
        // （階段実体は置かない。描画・操作対象外の自動管理 Room。屋外階段は吹抜け不要）。
        if (addStairVoidRoom(temp, translatedCells)) changed = true;
      }
    }

    // 3. ペアRoomの補完: 自動設置した階段（今回分・過去分とも）へ feature=STAIR の Room を
    //    作り相互リンクする。Room が無いと部屋指定時の外壁生成が階段エリアを「無名屋外」
    //    とみなし、隣接部屋の周囲に誤った外壁ループができる（data-model.md の不変条件）。
    //    footprint が一致する階段吹抜け（旧最上階の自動指定分）はペア Room へ転用される。
    if (ensureStairRooms(temp).length > 0) changed = true;

    // 4. 中間階に残った階段吹抜けの掃除: 転用（手順3）に乗らなかった STAIR_VOID は
    //    最上階でのみ意味を持つ自動管理 Room のため削除する（footprint 不一致の残骸対策）。
    if (hasFloorAbove) {
      for (const r of temp.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID)) {
        temp.removeRoom(r.id);
        changed = true;
      }
    }

    if (changed && !isActive) await saveFloor(plane.id, serializeGraph(temp));
    if (changed && undoEntry) {
      undoRecords.push({ planeId: plane.id, before: beforeBytes, after: serializeGraph(temp) });
    }
  }

  // 変更した各階の巻き戻し・再適用を、変換エントリ（undoEntry）へ合成する
  if (undoEntry && undoRecords.length > 0) {
    const applyBytes = (which) => {
      for (const rec of undoRecords) {
        if (project.activePlane?.id === rec.planeId) {
          restoreGraph(project.activeGraph, rec[which]); // undo 時にその階がアクティブなら生きているグラフへ復元
        } else {
          saveFloor(rec.planeId, rec[which]).catch(console.error); // 非アクティブ階は IDB のみが正
        }
      }
    };
    undoManager.amend(undoEntry, () => applyBytes('before'), () => applyBytes('after'));
  }
}

/**
 * syncUpperFloors の起点探索付きラッパー（階追加時用）。表示中の階（sourceGraph）に階段が
 * あればそのまま同期し、無ければそれより下の採用フロアを上から順に peek して、階段を持つ
 * 最初の階を起点に同期する（例: 階段の無い最上階を表示したまま階を追加した場合、旧最上階
 * への階段設置と新最上階への階段吹抜け指定は、中間階の階段を起点にしないと走らない）。
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
 * 階段設置階の仕上げモード脱出時に、上階の階段 footprint（自動設置ペアRoom・最上階の
 * 階段吹抜け STAIR_VOID）へ「階段側の仕上げ壁」を同期生成する。
 *
 * 設置階ではペアRoom（feature=STAIR）が脱出時の壁生成（App.jsx ステップ2）で階段側の
 * 仕上げ面・仕上げ線を得るが、上階は脱出処理の対象外のため壁が無く、階段側仕上げ材が
 * 描画されない。この同期がそれを塞ぐ。生成規則は設置階の挙動に揃える:
 * - 対象は「壁が未生成（generatedWallIds が空）」の Room のみ。生成済みの Room には
 *   触れない（設置階の「壁は一度生成したら再生成しない」挙動と同じ）。
 * - 開口辺: 中間階（階段実体あり）＝その階の階段の上り口＋下り口（stairPortEdges）。
 *   最上階（STAIR_VOID）＝直下階の同 footprint 階段の到達辺（下り口）。
 * - 階段仕上げ材の参照（内装コピー方式）: 内装未編集（templateKey なし・個別上書きなし）の
 *   自動 Room へ、設置階ペアRoom の templateKey・customOverrides を写してから壁を生成する。
 *   以降はその階の Room（仕上げ表のカード）が単一情報源になる。
 * - 多層設置: 設置階から最上階まで、footprint 一致の階段実体を連鎖でたどる。
 *
 * syncUpperFloors と同じ自動同期のため undo 対象外。呼び出しは仕上げモード脱出時
 * （設置階がアクティブな時）のみ＝同期対象は常に非アクティブ階（peek → saveFloor）。
 *
 * @param {object} project
 * @param {object} activeGraph - 脱出した階（アクティブ）のグラフ
 * @param {object} [opts]
 * @param {(graph, room) => ({wallBase:number, wallFinish:number}|null)} [opts.dimsOf]
 *   壁寸法の解決（FinishModeState.roomWallDims。graph には対象階の peek グラフを渡す）
 */
export async function syncUpperStairFinishWalls(project, activeGraph, { dimsOf } = {}) {
  const planes = project.planes;
  const active = activeGraph?.plane;
  if (!active || activeGraph.stairs.length === 0) return;
  const idx = planes.findIndex(p => p.id === active.id);
  if (idx < 0 || idx + 1 >= planes.length) return;

  // 階段ごとに「直下階の階段実体」を追跡する連鎖（最上階 STAIR_VOID の到達辺開口の計算に使う）
  let chains = activeGraph.stairs.map(stair => ({
    srcRoom: stair.roomId ? (activeGraph.roomMap.get(stair.roomId) ?? null) : null,
    belowStair: stair,
    belowGraph: activeGraph,
  }));

  for (let i = idx + 1; i < planes.length && chains.length > 0; i++) {
    const plane = planes[i];
    if (plane.id === project.activePlane?.id) return; // 想定外（呼び出しは脱出階がアクティブな時のみ）
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    let changed = false;
    const next = [];

    for (const chain of chains) {
      const translated = translateCellSet(chain.belowStair.cells, chain.belowGraph, project.structGraph, temp);
      if (!translated) continue; // CL変換不能 → 安全側でこの連鎖は打ち切り
      const cells = refreshCells(translated, temp);
      if (cells.size === 0) continue;

      // この階の同 footprint 階段（中間階）。連鎖の次段はこの階段を「直下階の階段」とする
      const tempStair = temp.stairs.find(s => setsEqual(refreshCells(s.cells, temp), cells)) ?? null;
      if (tempStair) next.push({ ...chain, belowStair: tempStair, belowGraph: temp });

      const room = temp.rooms.find(r =>
        (r.feature === RoomFeature.STAIR || r.feature === RoomFeature.STAIR_VOID) &&
        setsEqual(refreshCells(r.cells, temp), cells)) ?? null;
      if (!room || room.generatedWallIds.size > 0) continue;

      // 内装コピー: 未編集の自動 Room のみ（ユーザー編集済みの内装は上書きしない）
      if (chain.srcRoom && room.templateKey == null && room.customOverrides.size === 0) {
        if (chain.srcRoom.templateKey != null) { room.setTemplateKey(chain.srcRoom.templateKey); changed = true; }
        for (const [k, v] of chain.srcRoom.customOverrides) { room.customOverrides.set(k, v); changed = true; }
      }

      const openings = (room.feature === RoomFeature.STAIR && tempStair)
        ? stairPortEdges(tempStair, temp)
        : stairPortEdges(chain.belowStair, chain.belowGraph, ['arrival']);
      const walls = generateRoomWallsFromOutline(temp, room, dimsOf?.(temp, room) || {}, openings);
      if (walls.length > 0) {
        walls.forEach(w => room.generatedWallIds.add(w.id));
        changed = true;
      }
    }

    if (changed) await saveFloor(plane.id, serializeGraph(temp));
    chains = next;
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

  // 新階側で既に割当済みのセル（直前の syncUpperFloors が自動指定した階段吹抜け等）は
  // 除外する（セルの二重割当防止。階段部は吹抜け側が「屋内」を担うため壁生成にも影響しない）
  const assigned = new Set();
  for (const room of temp.rooms) {
    for (const key of refreshCells(room.cells, temp)) assigned.add(key);
  }
  const freeCells = new Set([...translatedCells].filter(k => !assigned.has(k)));
  if (freeCells.size === 0) return;

  temp.addRoom(freeCells, roomName);
  await saveFloor(newPlane.id, serializeGraph(temp));
}
