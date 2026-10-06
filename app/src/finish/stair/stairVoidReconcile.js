/**
 * 階段吹抜け（STAIR_VOID）の整合（純モジュール。store.js・snap.js・.jsx・storage を静的に引かない）。
 * 直下階の屋内階段と、自階の STAIR_VOID を突き合わせる reconcileStairVoids と、
 * それが使う部品（setsEqual・isIndoorStair・addStairVoidRoom）。後者3つは stairFloorSync.js から移した
 * （stairFloorSync.js は storage を引くため、純モジュールから使えるようここへ置く。挙動は移す前と同じ）。
 */
import { RoomFeature, RoomKind } from '@core';
import { refreshCells, cellBoundsFromKey } from '../gridCells.js';
import { makeRoomUndefined } from '../roomUndefined.js';
import { collectNeededCLs, addMissingCLs, extendDividerExtents, retargetKeysToCoveringCLs, translateCellSet } from '../floorCLMap.js';

export function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// 屋内階段判定: ペア Room の kind が EXTERIOR でなければ屋内（roomId なしの旧データは屋内扱い）
export function isIndoorStair(graph, stair) {
  const room = stair.roomId ? graph.roomMap.get(stair.roomId) : null;
  return (room?.kind ?? RoomKind.INTERIOR) !== RoomKind.EXTERIOR;
}

// 足元から引き抜いてよい部屋か: 未定義（従来どおり。kind は問わない）、通常の部屋（feature なし）・
// 吹抜け（VOID）は屋内（kind≠EXTERIOR）のものだけ。それ以外（屋根・昇降路・階段・別の階段の吹抜け・
// 屋外部屋）と重なる足元には置かない。
function isCarvableRoom(room) {
  if (room.feature === RoomFeature.UNDEFINED) return true;
  if (room.kind === RoomKind.EXTERIOR) return false;
  return room.feature == null || room.feature === RoomFeature.VOID;
}

/**
 * 階段 stair（直下階）の足元が、直上階 graph の引き抜けない部屋（isCarvableRoom でない部屋＝ROOF・昇降路・
 * 階段・吹抜け・屋外部屋）や自階の階段のセルと、面積のある重なり方をしているか（世界座標の矩形で判定。
 * 上階の格子が粗くても、部屋の生キーが指す矩形そのものを使うので、足元の外の部屋を巻き込まない）。
 * 置けないことが確定していれば、上階の格子（中心線の区間）を延ばす意味が無い。
 */
function footprintBlocked(graph, belowGraph, stair) {
  const foot = [...stair.cells].map(k => cellBoundsFromKey(k, belowGraph)).filter(Boolean);
  const hits = (key) => {
    const b = cellBoundsFromKey(key, graph);
    return !!b && foot.some(f => Math.min(b.x2, f.x2) - Math.max(b.x1, f.x1) > 1e-6 && Math.min(b.y2, f.y2) - Math.max(b.y1, f.y1) > 1e-6);
  };
  for (const room of graph.rooms) {
    if (isCarvableRoom(room)) continue;
    if ([...room.cells].some(hits)) return true;
  }
  return graph.stairs.some(s => [...s.cells].some(hits));
}

/**
 * 直上階の階段 footprint へ階段吹抜け（STAIR_VOID）Room を自動指定する。階段の真上の床は必ず開くため、
 * 足元と重なる部屋が引き抜いてよい部屋（未定義・通常の部屋・VOID。isCarvableRoom）だけなら、それらから
 * 足元の原子セルを引き抜いてから置く（部分重なり＝一部が部屋・残りが未割当も同じ。部屋のセルが空になれば
 * 部屋ごと removeRoom。subtractCellsFromUndefinedRooms と同じ扱い）。引き抜き後に部屋のセルが非連結に
 * なっても、部屋はセル集合なので壊れない（部屋再解釈 reinterpretRoomsOnEntry は分割線の消失したセルしか
 * 動かさず、連結性は見ない）。
 * ただし上階の格子が足元の辺で割れておらず、重なる原子セルが足元の矩形からはみ出す（引き抜くと足元の外の
 * 部屋まで削る）ときは通常の部屋・VOID からは引き抜かず skipped にする（未定義だけは従来どおり引き抜く）。
 * 引き抜いてはいけない部屋（ROOF・昇降路・STAIR・STAIR_VOID＝別の階段か同じ足元の吹抜け・屋外部屋）と
 * 1セルでも重なれば何もしない（冪等・二重割当防止）。
 * 重なりは両辺を refreshCells で現行グリッドの原子セルへ展開して比べる（cells は translateCellSet の
 * 生キーで、格子が直下階より細かい階では原子セルと一致しない。生のまま比べると既存の吹抜けを見落とし、
 * 呼ぶたびに増える）。展開後が空（解決できるセルが無い）なら何もしない。
 * 作る Room のセルは渡された cells（生キー）のまま持つ（読む側が refreshCells で展開する）。
 * 注意: 突入時 reconcile・階操作 follower（undo 対象外）でも同じ規則で他階の部屋のセルを削る。
 * @param {object} graph
 * @param {Set<string>} cells
 * @param {Array<{roomId:string, cells:Set<string>}>} [carvedOut] 引き抜いた通常の部屋・VOID（未定義は含めない）を積む出力先
 * @returns {boolean} 追加したか
 */
export function addStairVoidRoom(graph, cells, carvedOut = []) {
  if (cells.size === 0) return false;
  const refreshed = refreshCells(cells, graph);
  if (refreshed.size === 0) return false;
  // 足元の矩形（生キーの bounds）。上階の格子が足元の辺で割れていない（同座標の中心線はあるが区間が
  // 足りず分割線が働かない）と原子セルが足元より大きくなる。その原子セルを部屋から引き抜くと、足元の外の
  // 部屋まで削るので、通常の部屋・VOID は「重なる原子セルが全部足元の矩形に収まる」ときだけ引き抜く。
  const footRects = [...cells].map(k => cellBoundsFromKey(k, graph)).filter(Boolean);
  const insideFoot = (key) => {
    const b = cellBoundsFromKey(key, graph);
    if (!b) return false;
    // 足元の矩形群（互いに重ならない格子セル）との重なり面積が原子セルの面積に等しければ、全体が足元の中
    let covered = 0;
    for (const f of footRects) {
      const w = Math.min(b.x2, f.x2) - Math.max(b.x1, f.x1);
      const h = Math.min(b.y2, f.y2) - Math.max(b.y1, f.y1);
      if (w > 0 && h > 0) covered += w * h;
    }
    return covered >= (b.x2 - b.x1) * (b.y2 - b.y1) - 1e-3;
  };
  const overlapping = [];
  for (const room of graph.rooms) {
    const roomCells = refreshCells(room.cells, graph);
    const hit = [...refreshed].filter(k => roomCells.has(k));
    if (hit.length === 0) continue;
    if (!isCarvableRoom(room)) return false;
    if (room.feature !== RoomFeature.UNDEFINED && !hit.every(insideFoot)) return false;
    overlapping.push({ room, roomCells });
  }
  for (const { room, roomCells } of overlapping) {
    const removed = new Set([...roomCells].filter(k => refreshed.has(k)));
    if (room.feature !== RoomFeature.UNDEFINED) carvedOut.push({ roomId: room.id, cells: removed });
    const remaining = new Set([...roomCells].filter(k => !refreshed.has(k)));
    if (remaining.size === 0) {
      graph.removeRoom(room.id);
      // この部屋を親（referenceRoomIds）に持つ部分指定の子が、削除済み id を指したままにならないよう外す
      // （子は足元の外にセルを持つ場合に残る。親を持たない通常の部屋になる）
      for (const other of graph.rooms) other.referenceRoomIds.delete(room.id);
    } else room.setCells(remaining);
  }
  const room = graph.addRoom(new Set(cells));
  room.setFeature(RoomFeature.STAIR_VOID);
  return true;
}

/**
 * 直下階 belowGraph の屋内階段と、自階 graph の階段吹抜け（STAIR_VOID）の整合を取る（純関数・同期）。
 * 順序: 1.不足の中心線の補完 → 2.足元の写し → 3.孤児の削除 → 4.重複の削除 → 5.追加
 * （追加を孤児削除の後にして、古い足元の孤児と部分的に重なる新しい足元も1回の呼び出しで置く）。
 * 写せない階段があれば孤児の判定を見送る（安全側。既存の吹抜けを消さない）。
 * 自階の階段（ペア部屋あり）と重なる吹抜けは消し、ペア部屋が無い階段との同居は触らない——
 * 呼び出し側は ensureStairRooms をこの関数の後に回す（吹抜けがペア部屋へ転用される）。
 * 屋外階段は一切対象にしない（上に何も置かない）。needed（per-floor 中心線）が空でも続ける
 * （通り芯だけで囲まれた階段にも吹抜けを置く）。
 * @param {object} graph       自階（N+1）。直接書き換える
 * @param {object} belowGraph  直下の採用階（N）。読むだけ
 * @param {object} structGraph 通り芯
 * 追加（手順5）は、足元と重なる通常の部屋・VOID・未定義から足元のセルを引き抜いて置く（addStairVoidRoom。
 * 屋根・昇降路・階段・別の吹抜け・屋外部屋と重なるときだけ skipped 'overlap'）。階段設置時の syncUpperFloors・
 * 仕上げ突入時の reconcileOnFinishEntry・階操作の follower のどれも同じ規則で、突入時・follower は
 * undo 対象外のまま他階（直上階）の部屋のセルを削る。
 * @returns {{ changed: boolean, added: Array<{cells:Set}>, removed: Array<{roomId, reason:'orphan'|'duplicate'}>,
 *             skipped: Array<{cells:Set, reason:'untranslatable'|'overlap'|'covered-by-own-stair'}>,
 *             carved: Array<{roomId:string, cells:Set<string>}> }} carved＝足元の下に敷かれていた通常の部屋・VOID から引き抜いたセル
 */
export function reconcileStairVoids(graph, belowGraph, structGraph) {
  if (!graph) throw new Error('reconcileStairVoids: graph がありません');
  if (!belowGraph) throw new Error('reconcileStairVoids: belowGraph がありません');
  const result = { changed: false, added: [], removed: [], skipped: [], carved: [] };
  const belowIndoor = belowGraph.stairs.filter(s => isIndoorStair(belowGraph, s));

  // 1. 不足の中心線の補完（屋内階段のセルだけ。needed が空でも以降を続ける）
  // 続けて、同座標の中心線が上階にあっても区間が足元の辺に届かないもの（足元の辺で格子が割れず原子セルが
  // 足元より大きくなる）を、辺まで延ばす（floorCLMap.js extendDividerExtents）。
  // 置けないことが確定している足元（屋根・昇降路・階段・別の吹抜け・屋外部屋と重なる）では区間を延ばさない
  // （吹抜けが置かれないのに上階の格子だけ変わるのを避ける。重なり判定は延長より前）
  const footCells = belowIndoor.flatMap(s => [...s.cells]);
  const needed = collectNeededCLs(footCells, belowGraph);
  if (addMissingCLs(needed, belowGraph, structGraph, graph) > 0) result.changed = true;
  const extendCells = belowIndoor.filter(s => !footprintBlocked(graph, belowGraph, s)).flatMap(s => [...s.cells]);
  if (extendDividerExtents(extendCells, belowGraph, structGraph, graph) > 0) result.changed = true;

  // 2. 足元の写し（追加はまだしない）。写せた足元（現行グリッドの原子セル集合）を手順3の孤児判定と手順5に使う
  const mapped = []; // { translated, refreshed }
  for (const stair of belowIndoor) {
    const translatedRaw = translateCellSet(stair.cells, belowGraph, structGraph, graph);
    // 同座標に区間の違う分割線が複数ある上階で、辺を覆わないピースの id がキーに入ると壁が落ちるため付け替える
    const translated = translatedRaw ? retargetKeysToCoveringCLs(translatedRaw, graph, structGraph) : null;
    const refreshed = translated ? refreshCells(translated, graph) : null;
    if (!translated || refreshed.size === 0) {
      result.skipped.push({ cells: new Set(stair.cells), reason: 'untranslatable' });
      continue;
    }
    mapped.push({ translated, refreshed });
  }
  const validFootprints = mapped.map(m => m.refreshed);

  // 3a. 自階の階段（ペア部屋あり）と原子セルが重なる STAIR_VOID は removeRoom（二重所有を残さない）。
  //     ペア部屋が無い階段との同居は触らない（後段の ensureStairRooms がペア部屋へ転用する）。
  const ownPaired = graph.stairs
    .filter(s => s.roomId && graph.roomMap.get(s.roomId)?.feature === RoomFeature.STAIR)
    .map(s => refreshCells(s.cells, graph));
  for (const room of graph.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID)) {
    const cells = refreshCells(room.cells, graph);
    if (!ownPaired.some(sc => [...cells].some(k => sc.has(k)))) continue;
    graph.removeRoom(room.id);
    result.removed.push({ roomId: room.id, reason: 'duplicate' });
    result.changed = true;
  }

  // 3. 孤児の削除: どの足元とも一致しない STAIR_VOID は未定義化（外形を保つ。applyStairRemovalToFloor と同じ）。
  //    追加（手順5）より前に行う——古い足元の孤児と新しい足元が部分的に重なっても、1回の呼び出しで収束させるため。
  //    写せない階段が1つでもあれば孤児の判定そのものを見送る（その階段の既存の吹抜けを誤って消さない。安全側）
  const canJudgeOrphans = !result.skipped.some(s => s.reason === 'untranslatable');
  const keptVoids = [];
  for (const room of graph.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID)) {
    const cells = refreshCells(room.cells, graph);
    if (!canJudgeOrphans || validFootprints.some(fp => setsEqual(fp, cells))) { keptVoids.push({ room, cells }); continue; }
    makeRoomUndefined(room);
    result.removed.push({ roomId: room.id, reason: 'orphan' });
    result.changed = true;
  }

  // 4. 重複の削除: 同 footprint の吹抜けは graph.rooms の並びで先頭だけ残す。
  //    残りは未定義化せず removeRoom で消す——未定義化すると残した吹抜けと同じセルを持つ未定義部屋が
  //    重なって残り（セルの二重所有）、外形は残した吹抜けが既に保っているため未定義部屋は不要。
  const seen = [];
  for (const { room, cells } of keptVoids) {
    if (seen.some(c => setsEqual(c, cells))) {
      graph.removeRoom(room.id);
      result.removed.push({ roomId: room.id, reason: 'duplicate' });
      result.changed = true;
    } else {
      seen.push(cells);
    }
  }

  // 5. 追加
  for (const { translated, refreshed } of mapped) {
    const hasSameVoid = graph.rooms.some(r =>
      r.feature === RoomFeature.STAIR_VOID && setsEqual(refreshCells(r.cells, graph), refreshed));
    if (hasSameVoid) continue; // 冪等

    // 自階の階段と原子セルが1つでも重なれば置かない（ペア部屋の有無によらない）
    const coveredByOwn = graph.rooms.some(r =>
      r.feature === RoomFeature.STAIR && setsEqual(refreshCells(r.cells, graph), refreshed))
      || graph.stairs.some(s => [...refreshCells(s.cells, graph)].some(k => refreshed.has(k)));
    if (coveredByOwn) {
      result.skipped.push({ cells: new Set(translated), reason: 'covered-by-own-stair' });
      continue;
    }

    if (addStairVoidRoom(graph, translated, result.carved)) {
      result.added.push({ cells: new Set(translated) });
      result.changed = true;
    } else {
      result.skipped.push({ cells: new Set(translated), reason: 'overlap' });
    }
  }
  return result;
}

/**
 * 直下の採用階が無い階（最下階）の階段吹抜け（STAIR_VOID）を全部孤児として未定義化する（純関数・同期。
 * 外形を保つ makeRoomUndefined。reconcileStairVoids の孤児処理と同じ扱い）。
 * @param {object} graph 最下階。直接書き換える
 * @returns {{ changed: boolean, removed: Array<{roomId, reason:'orphan'}> }}
 */
export function clearStairVoidsWithoutBelow(graph) {
  if (!graph) throw new Error('clearStairVoidsWithoutBelow: graph がありません');
  const result = { changed: false, removed: [] };
  for (const room of graph.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID)) {
    makeRoomUndefined(room);
    result.removed.push({ roomId: room.id, reason: 'orphan' });
    result.changed = true;
  }
  return result;
}

/**
 * cells（候補の部屋のセル）に触れる階段吹抜け（STAIR_VOID）を、全体が含まれるものと一部だけ重なるものに分ける
 * （純関数・読むだけ）。続きの階段の指定（FinishModeState.applyNaming）が、吸収してよい吹抜けと
 * 拒否すべき部分的な重なりを見分けるのに使う。両辺を refreshCells で現行グリッドの原子セルへ展開して比べる。
 * 重ならない吹抜けはどちらにも入らない。展開後が空の吹抜けは触れていないとみなす。
 * @returns {{ absorbed: Array<object>, partial: boolean }} absorbed＝セルが全部 cells に含まれる吹抜け
 */
export function stairVoidsTouching(graph, cells) {
  const mine = refreshCells(cells, graph);
  const absorbed = [];
  let partial = false;
  for (const room of graph.rooms) {
    if (room.feature !== RoomFeature.STAIR_VOID) continue;
    const own = refreshCells(room.cells, graph);
    if (own.size === 0) continue;
    const hit = [...own].filter(k => mine.has(k)).length;
    if (hit === 0) continue;
    if (hit === own.size) absorbed.push(room);
    else partial = true;
  }
  return { absorbed, partial };
}
