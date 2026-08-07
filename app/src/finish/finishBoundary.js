// 仕上げモードの突入・脱出境界処理。App.jsx から状態を持たない純粋な形へ抽出したもの
// （挙動は元コードのまま）。React state は一切触らない（事前調査済み）——undo登録・graph変更のみ。
// fmode（modeRef.current＝FinishModeState）は呼び出し側（App.jsx）から引数で受ける。
import { runInAction } from 'mobx';
import { RoomFeature } from '@core';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { stairPortEdges } from './stair/stairGeometry.js';
import {
  generateStairUnderWalls, stairUnderClaimedEdges, trimStairUnderJunctions,
} from './stair/stairUnderWalls.js';
import {
  generateRoomWallsFromOutline, generateExteriorWalls, snapshotWall, restoreWallsFromSnapshots,
  resolveBackingOwnership, applyBackingOwnership,
} from './wallGeneration.js';
import { snapshotEdges, restoreEdges, syncEdgesFromTopology, interiorWallSpans, buildCellToRoom } from './edgeClassify.js';
import { reinterpretRoomsOnEntry, ensureStairRooms, snapshotRoomsState, restoreRoomsState } from './roomReinterpret.js';
import { kneeDropWallGeometry } from './kneeDropWall.js';
import { reflectStructuralAfterFinishExit } from '../structural/structuralOrchestration.js';
// finish/clEccentricity.js は edgeComposition.js 経由で materials/materialData.js（材マスタ全件）を
// 静的に引くため、コード分割維持のため動的 import する（materialData.js のヘッダコメント参照）。

// ---- モード境界: 仕上げモード突入（前回脱出時点のRoom.cellsを現在のCLトポロジーと
// 突き合わせて再解釈した上で、通り芯変更等のトポロジー差分でエッジを再同期する）----
export async function runFinishEntryBoundary(graph, project) {
  // 最上階なら直下階の屋内階段footprintへ階段吹抜け（STAIR_VOID）を補完する
  // （既存データ修復。syncUpperFloors と同じ自動同期のため undo 対象外）
  const { ensureTopStairVoid } = await import('./stair/stairFloorSync.js');
  await ensureTopStairVoid(project, graph);

  const entryUndoFns = [];
  const entryRedoFns = [];

  const roomsBefore = snapshotRoomsState(graph);
  const stairRoomChanges = [];
  runInAction(() => {
    reinterpretRoomsOnEntry(graph);
    // roomIdなしStair（旧データ・上階自動設置分）へ階段Roomを補完（開くだけで修復）
    stairRoomChanges.push(...ensureStairRooms(graph));
  });
  const roomsAfter = snapshotRoomsState(graph);
  if (JSON.stringify(roomsBefore) !== JSON.stringify(roomsAfter)) {
    entryUndoFns.push(() => restoreRoomsState(graph, roomsBefore));
    entryRedoFns.push(() => restoreRoomsState(graph, roomsAfter));
  }
  // 補完した Room 自体は rooms スナップショットが巻き戻すが、Stair.roomId は対象外のため個別に戻す
  if (stairRoomChanges.length > 0) {
    entryUndoFns.push(() => { for (const c of stairRoomChanges) c.stair.setField('roomId', c.prevRoomId); });
    entryRedoFns.push(() => { for (const c of stairRoomChanges) c.stair.setField('roomId', c.room.id); });
  }

  const before = snapshotEdges(graph);
  runInAction(() => syncEdgesFromTopology(graph));
  const after = snapshotEdges(graph);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    entryUndoFns.push(() => restoreEdges(graph, before));
    entryRedoFns.push(() => restoreEdges(graph, after));
  }

  // F3（プル側）: 自階にまだ偏芯レコードが無いCLについて、連動先（階段は設置階〜最上階、
  // 吹抜けはその階と直下階）に既存の指定があれば取り込む。push（handleEccConfirm・
  // runFinishExitBoundary ステップ4c）だけでは、連動先がまだ仕上げモードに入っていない・
  // 内壁指定（部屋名）がまだ無い等でグラフ上のリンクが見えない間は伝播できないため、
  // 突入のたびにここで埋める。pullMaterialMap は fmode（唯一の通常の情報源）がこの時点では
  // まだ生存していないため、clEccentricity.js と同じ理由で独立に動的 import する
  // （コード分割維持。materialData.js のヘッダコメント参照）。ensureTopStairVoid と同格の
  // 自動同期のため undo 対象外。
  const [{ pullCLEccentricities }, pullMatMod] = await Promise.all([
    import('./eccentricityFloorSync.js'),
    import('./materials/materialData.js'),
  ]);
  const pullMaterialMap = new Map(pullMatMod.MATERIALS.map(m => [m.code, m]));
  await pullCLEccentricities(project, graph, { materialMap: pullMaterialMap });

  // 部屋の再解釈→エッジ再同期の順に適用したため、undo は逆順で巻き戻す
  if (entryUndoFns.length > 0) {
    undoManager.push(
      () => { [...entryUndoFns].reverse().forEach(fn => fn()); },
      () => { entryRedoFns.forEach(fn => fn()); },
    );
  }
}

// ---- モード境界: 仕上げモード脱出（部屋ごとの壁自動生成・外壁再生成・構造反映を確定）----
// handleModeChange（appMode切替）と移動スライダーの階切替（appMode維持）の両方から呼ぶ。
// fmode: modeRef.current（脱出直前でまだ生存・材ロード済み）。寸法は実材厚から導出するため必要。
// goingToStructure: 遷移先が構造モードなら reflectStructuralAfterFinishExit 側で
// 自階の再計算をスキップする（構造モード突入境界処理に委ねるため）。
export async function runFinishExitBoundary(graph, project, fmode, { goingToStructure = false } = {}) {
  const undoFns = [];
  const redoFns = [];

  // 壁導出ブロック（ステップ1〜3.5）は fmode が生きている場合のみ実行する。fmode が null
  // （モード切替中で材ロードがまだ完了していない等の一時的な状態）だと roomWallDims/
  // exteriorWallDims が既定寸法へフォールバックし、ステップ1が実材厚で生成済みの既存壁・
  // 2a壁まで全削除して既定寸法で作り直してしまう（不可逆な破壊）。clEccentricity.js が
  // materialMap 未ロード時に適用自体をスキップする方針（適用時は黙って既定値へ潰さず
  // 止める）と同じ考え方（F2）。fmode が null のときは壁を一切触らず、ステップ4・4b・5・
  // 構造反映は従来どおり実行する（これらは Room/Edge のトポロジーが対象で、壁の実材寸法
  // には依存しないため）。
  if (fmode) {
  // 階段下部屋（破れ線先セルに部屋指定された領域。ステップ2a）。壁は一度生成したら不変・
  // claim・トリムの既存仕組みを変更しない——ステップ1の全削除・ステップ2の対象からは
  // 常に除外する。ステップ1・2aの双方で使うため先に1回だけ計算する。
  const stairUnderEntries = fmode?.stairUnderRooms?.(graph) ?? [];
  const under2aRoomIds = new Set(stairUnderEntries.map(e => e.room.id));

  // ステップ1: 内周壁（isRoomWall && 非外壁）を全削除する（外壁ステップ3と同じ思想。
  // 「壁＝部屋指定・内装・偏芯からの導出物」として脱出のたびに全削除→ステップ2で
  // 導出し直す。順序非依存・冪等になり、旧版が個別に行っていた自己修復（孤立壁削除・
  // 階段側壁の個別削除）は不要になった。階段ペアRoom（feature=STAIR）・階段吹抜け
  // （STAIR_VOID）の壁も対象——新モデルでは通常のRoomと同じ経路で壁を持つため、
  // 旧版の特別扱いは廃止した。2a壁（下記 under2aWallIds）だけは対象外。
  const under2aWallIds = new Set();
  for (const room of graph.rooms) {
    if (under2aRoomIds.has(room.id)) for (const id of room.generatedWallIds) under2aWallIds.add(id);
  }
  const staleInteriorSnapshots = [];
  for (const [id, shape] of graph.shapeMap) {
    if (shape.isRoomWall && !shape.isExteriorWall && !under2aWallIds.has(id)) staleInteriorSnapshots.push(snapshotWall(shape));
  }
  if (staleInteriorSnapshots.length > 0) {
    const roomWallIdsBefore = new Map(); // room -> Set<wallId>（undo復元用。2a部屋は対象外）
    for (const room of graph.rooms) {
      if (!under2aRoomIds.has(room.id)) roomWallIdsBefore.set(room, new Set(room.generatedWallIds));
    }
    staleInteriorSnapshots.forEach(s => graph.removeShape(s.id));
    for (const room of roomWallIdsBefore.keys()) room.generatedWallIds.clear();
    undoFns.push(() => {
      restoreWallsFromSnapshots(graph, staleInteriorSnapshots);
      for (const [room, ids] of roomWallIdsBefore) { room.generatedWallIds.clear(); ids.forEach(id => room.generatedWallIds.add(id)); }
    });
    redoFns.push(() => {
      for (const room of roomWallIdsBefore.keys()) room.generatedWallIds.clear();
      staleInteriorSnapshots.forEach(s => graph.removeShape(s.id));
    });
  }

  // 階段の上り口・下り口の開口辺（この辺上に部屋の壁を作らない）。
  // 自階の階段は entry（上り口）＋ arrival（下り口。中間階では下階の同形状階段の到達辺を兼ねる）。
  // 最上階（階段実体なし・階段吹抜けのみ）は直下階の階段の到達辺＝下り口を開口に加える
  // （世界座標は全階共通のため、直下階グラフで計算した辺をそのまま使える）。
  const stairOpenings = graph.stairs.flatMap(s => stairPortEdges(s, graph));
  if (graph.rooms.some(r => r.feature === RoomFeature.STAIR_VOID)) {
    const planes = project.planes;
    const planeIdx = planes.findIndex(p => p.id === graph.plane?.id);
    if (planeIdx > 0) {
      const below = await floorSwapManager.peek(planes[planeIdx - 1], project.structGraph);
      stairOpenings.push(...below.stairs.flatMap(s => stairPortEdges(s, below, ['arrival'])));
    }
  }

  // ステップ2a: 階段下部屋（破れ線先セルに部屋指定された階段下エリア）の壁生成。
  // ステップ2より先に行い、この部屋を generatedWallIds 済みにしてステップ2の通常経路
  // （偏芯を持たない対称壁）から除外する。claimedEdges（underEdges）は破れ線・踊り場境界
  // （無壁）と、この部屋が既に受け持った外周（外側部屋の薄壁を含む）の重複生成を防ぐため、
  // ステップ2・3の開口辺フィルタへ合流させる（生成順: 2a→2→3）。
  // claim（stairUnderClaimedEdges）は壁生成（generateStairUnderWalls）と分離しており、
  // 再脱出時（部屋が既に generatedWallIds を持ち壁は再生成しない）でも毎回行う——冪等性
  // のため。省略すると2回目の脱出でclaimが空になり、ステップ3の外壁（毎回全削除・再生成）
  // で初回に抑止された辺に壁が生成されてしまう。
  // 既知制約: 同一部屋が2階段にまたがる退化構成（stairUnderRoomsが同じroomを複数返す）は
  // 先に処理された stair の claim/壁生成が優先される。
  // step2aEntries: この部屋群が現に持つ2a壁（新規生成分に加え、再脱出時に生成をスキップした
  // 既存分も含む）を { wall, room } で保持する。ステップ3後のトリムパス
  // （trimStairUnderJunctions。隣接壁・外壁との T字/出隅/入隅取り合い）の対象にする
  // ——room は出隅/入隅判定（象限がそのRoomのセルに属するか）に使う。再脱出時も対象に
  // 含めるのは、ステップ3の外壁は毎回全削除・再生成されるため（面位置は決定的なら実質
  // 不変だが、CLがユーザー編集で動いた場合にも追従できるようにする）。既に正しい位置なら
  // トリムは再度no-opになるだけで冪等（REASONED、下記トリムパスの説明を参照）。
  // buildCellToRoom(graph) は2a部屋1件につき claim経路・生成経路の双方で呼ばれると2回
  // 走ってしまう（QA指摘）。壁がまだ1本も追加されていないこの時点でグラフ全体から
  // 1度だけ作り、両経路で共有する（Room.cellsは触っていないため、このループ内で使い回しても
  // 結果は変わらない）。
  const stairUnderCellToRoom = buildCellToRoom(graph);
  const underEdges = [];
  const step2aEntries = [];
  for (const { stair, room, splitCLIds } of stairUnderEntries) {
    underEdges.push(...stairUnderClaimedEdges(graph, stair, room, { stairOpenings, under2aRoomIds, cellToRoom: stairUnderCellToRoom }));
    if (room.generatedWallIds.size > 0) {
      // 再脱出時: 壁は再生成しないが、既存の2a壁はトリム対象として拾う
      for (const id of room.generatedWallIds) {
        const w = graph.shapeMap.get(id);
        if (w) step2aEntries.push({ wall: w, room });
      }
      continue;
    }
    const { walls } = generateStairUnderWalls(
      graph, stair, room, fmode?.roomWallDims?.(graph, room) || {},
      { splitCLIds, dimsOf: r => fmode?.roomWallDims?.(graph, r) || {}, stairOpenings, under2aRoomIds, cellToRoom: stairUnderCellToRoom },
    );
    if (walls.length === 0) continue;

    walls.forEach(w => room.generatedWallIds.add(w.id));
    step2aEntries.push(...walls.map(w => ({ wall: w, room })));
    const snapshots = walls.map(snapshotWall);
    const wallIds = walls.map(w => w.id);

    const r = room;
    undoFns.push(() => { wallIds.forEach(id => graph.removeShape(id)); r.generatedWallIds.clear(); });
    redoFns.push(() => { restoreWallsFromSnapshots(graph, snapshots).forEach(w => r.generatedWallIds.add(w.id)); });
  }

  // ステップ2: 新規壁生成（対象: UNDEFINED・部分指定（referenceRoomIds あり。親が外周壁を
  // 担う）・2a部屋を除く全Room）。generatedWallIds ゲート（size>0でskip）は撤廃した
  // ——ステップ1で対象範囲の壁を全削除済みのため、毎回全再生成してよい（順序非依存・冪等）。
  // UNDEFINED は内周壁を持たない（新モデル＝全再生成方式では、未定義化した時点で内周壁は
  // 消える。外壁線はステップ3が維持するため部屋の輪郭自体は失われない。意図どおりの新挙動）。
  // 階段ペアRoom（feature=STAIR）・階段吹抜け（STAIR_VOID）も同仕様で参加する:
  // 下地オーナー壁＋仕上げ薄壁方式——同一CL上の下地（間柱帯）は1つだけ、各面（部屋側・
  // 階段側）の仕上げ材は面ごとに描画される。所有権解決（resolveBackingOwnership。
  // wallGeneration.js）をこの直後に行い、＋側の壁を下地オーナーに、−側の壁を仕上げ薄壁
  // （backingDepth=0）に確定する（部分重なりは壁を分割する）。
  // 部分指定（referenceRoomIds あり）は通常、親が外周壁を担うため対象外——ただし
  // feature=STAIR（部屋の部分指定から階段変換した階段）は例外で対象に含める。旧版にあった
  // 親隣接面だけの抑止（parentAdjacentEdges）は不要——新モデルでは所有権解決
  // （resolveBackingOwnership）が親側の壁との重なりを検出して自動的に薄壁化するため。
  const wallIdToRoom = new Map(); // wallId -> 生成元Room（所有権解決の分割で generatedWallIds を張り替えるため）
  const roomWallLists = new Map(); // room -> Wall[]（今回生成分。所有権解決前）
  const processedRooms = [];
  for (const room of graph.rooms) {
    if (room.feature === RoomFeature.UNDEFINED) continue;
    if (room.referenceRoomIds?.size > 0 && room.feature !== RoomFeature.STAIR) continue;
    if (under2aRoomIds.has(room.id)) continue;

    const walls = generateRoomWallsFromOutline(graph, room, fmode?.roomWallDims?.(graph, room) || {}, [...stairOpenings, ...underEdges]);
    if (walls.length === 0) continue;

    walls.forEach(w => { room.generatedWallIds.add(w.id); wallIdToRoom.set(w.id, room); });
    roomWallLists.set(room, walls);
    processedRooms.push(room);
  }

  // 所有権解決: 同一CL上の下地を1本に統一する。分割で生じた新壁は wallIdToRoom へ
  // 反映し、旧壁IDを新壁群に張り替える（generatedWallIds も同様に張り替える）。
  const allNewInteriorWalls = processedRooms.flatMap(r => roomWallLists.get(r));
  for (const [oldId, newWalls] of resolveBackingOwnership(graph, allNewInteriorWalls)) {
    const room = wallIdToRoom.get(oldId);
    if (!room) continue;
    room.generatedWallIds.delete(oldId);
    for (const nw of newWalls) { room.generatedWallIds.add(nw.id); wallIdToRoom.set(nw.id, room); }
  }

  // ステップ2b: CL偏芯の適用（内壁指定のあるCLに設定された偏芯仕様を対象壁へ反映する。
  // spec と現材から毎回フル再計算する冪等処理——脱出のたびに材変更を偏芯壁へ反映させる）。
  // ステップ3（外壁の全削除・再生成）より前に行う: 対象は非外壁のみのため実害はないが、
  // 生成済みの内壁（ステップ2）に対して行うのが素直なため直後に置く。
  // fmode?.materialMap が無ければ丸ごとスキップする（applyCLEccentricity 自体も materialMap
  // 無しでは何もしないが、無駄な動的importとループを避ける。QA finding 2）。
  if (graph.clEccentricities.size > 0 && fmode?.materialMap) {
    const { applyCLEccentricity } = await import('./clEccentricity.js');
    const eccTouched = new Map(); // wallId -> 変更前スナップショット（初回遭遇時点）
    for (const clId of graph.clEccentricities.keys()) {
      for (const c of applyCLEccentricity(graph, clId, { materialMap: fmode?.materialMap })) {
        if (!eccTouched.has(c.wall.id)) {
          eccTouched.set(c.wall.id, {
            axisOffset: c.axisOffset, wallFinish: c.wallFinish, backingOffset: c.backingOffset,
            backingDepth: c.backingDepth, finishSide: c.finishSide, startOffset: c.startOffset, endOffset: c.endOffset,
          });
        }
      }
    }
    if (eccTouched.size > 0) {
      const eccChanges = [];
      for (const [id, before] of eccTouched) {
        const w = graph.shapeMap.get(id);
        if (!w) continue;
        eccChanges.push({
          id, before,
          after: {
            axisOffset: w.axisOffset, wallFinish: w.wallFinish, backingOffset: w.backingOffset,
            backingDepth: w.backingDepth, finishSide: w.finishSide, startOffset: w.startOffset, endOffset: w.endOffset,
          },
        });
      }
      const applyFields = (id, f) => {
        const w = graph.shapeMap.get(id);
        if (!w) return;
        w.axisOffset = f.axisOffset; w.wallFinish = f.wallFinish;
        w.backingOffset = f.backingOffset; w.backingDepth = f.backingDepth;
        w.finishSide = f.finishSide; w.startOffset = f.startOffset; w.endOffset = f.endOffset;
      };
      // 実行時は常に no-op になる想定の undo/redo（F7。動作自体は正しいので削除しない）:
      // ここで触れる壁は必ず「ステップ2（内周壁生成＋所有権解決）」の対象Room
      // （generatedWallIds）に属する——applyCLEccentricity の対象抽出・コーナー追従が
      // いずれも room.generatedWallIds を起点にするため。ステップ2側の undo/redo は
      // ステップ3の外壁オーナー化パスの後まで遅延して push される（下記）ため配列内では
      // この push より後に来る。undo は配列を逆順実行するのでステップ2側が先に走り対象の
      // 壁を削除済みにし、redo は順に実行するのでステップ2側が後に走り最終状態
      // （このeccChanges.after込みで取ったスナップショット）で壁を作り直す——結果として
      // ここの applyFields は対象の壁が存在しない時点で呼ばれ、`if (!w) return;` で
      // 無害化される。
      undoFns.push(() => eccChanges.forEach(c => applyFields(c.id, c.before)));
      redoFns.push(() => eccChanges.forEach(c => applyFields(c.id, c.after)));
    }
  }

  // ステップ3: 外壁の再生成（既存の isExteriorWall 壁を削除して作り直す）
  const oldExteriorSnapshots = [];
  for (const shape of graph.shapeMap.values()) {
    if (shape.isExteriorWall) oldExteriorSnapshots.push(snapshotWall(shape));
  }
  if (oldExteriorSnapshots.length > 0) {
    oldExteriorSnapshots.forEach(s => graph.removeShape(s.id));
  }
  const newExteriorWalls = generateExteriorWalls(graph, fmode?.exteriorWallDims?.(graph) || {}, [...stairOpenings, ...underEdges]);

  // 外壁オーナー化パス:「外周CLでは外壁が下地オーナー」の規則で、同一CLでスパンが重なる
  // 内周壁（ステップ2生成分）の covered 区間だけを薄壁化する（部分重なりは
  // applyBackingOwnership 内の分割ヘルパで分割）。setOwnerFields:false — 外壁自身の
  // backingOffset/backingDepth/finishSide は一切書き換えない（外壁は backingRange の
  // 既存フォールバック式が同値の下地帯を返すため明示不要。明示すると materialRange が
  // 既定式ぶん広がる副作用がある）。claimUncovered:false — 内周壁の非covered区間・分割後の
  // 非covered新壁は、ステップ2の所有権解決・ステップ2bのCL偏芯が既に確定した値をそのまま
  // 継承する（ここで既定式に塗り直すとその結果を破壊してしまう。F1）。
  // 内周壁側の分割・薄壁化は wallIdToRoom／室の generatedWallIds へ反映し、下記の内周壁
  // undo/redo（ステップ2の所有権解決結果に、このステップ3の追加分割を合流させたもの）へ
  // 含める——ここより後に内周壁の undo/redo をまとめて push するのはそのため。
  const currentInteriorWalls = [...wallIdToRoom.keys()].map(id => graph.shapeMap.get(id)).filter(Boolean);
  for (const [oldId, newWalls] of applyBackingOwnership(graph, newExteriorWalls, currentInteriorWalls, { setOwnerFields: false, claimUncovered: false })) {
    const room = wallIdToRoom.get(oldId);
    if (!room) continue;
    room.generatedWallIds.delete(oldId);
    for (const nw of newWalls) { room.generatedWallIds.add(nw.id); wallIdToRoom.set(nw.id, room); }
  }

  const newExteriorSnapshots = newExteriorWalls.map(snapshotWall);
  if (oldExteriorSnapshots.length > 0 || newExteriorSnapshots.length > 0) {
    undoFns.push(() => {
      newExteriorSnapshots.forEach(s => graph.removeShape(s.id));
      restoreWallsFromSnapshots(graph, oldExteriorSnapshots);
    });
    redoFns.push(() => {
      oldExteriorSnapshots.forEach(s => graph.removeShape(s.id));
      restoreWallsFromSnapshots(graph, newExteriorSnapshots);
    });
  }

  // ステップ2（内周壁生成＋所有権解決）の undo/redo をここで確定する。ステップ3の外壁
  // オーナー化パスが内周壁をさらに分割しうるため、その反映が終わったこの時点まで遅延させ、
  // 各室の generatedWallIds の最終状態から一括でスナップショットを取る（分割前の中間状態を
  // undo対象にしない）。この時点では室は元々壁を持たなかった（ステップ2の対象は毎回
  // 全削除後のRoomのみ）ため、undo は単純に「今回生成した壁を全削除して generatedWallIds を
  // clear」でよい。
  for (const room of processedRooms) {
    const wallIds = [...room.generatedWallIds];
    if (wallIds.length === 0) continue;
    const snapshots = wallIds.map(id => graph.shapeMap.get(id)).filter(Boolean).map(snapshotWall);
    const r = room;
    undoFns.push(() => { wallIds.forEach(id => graph.removeShape(id)); r.generatedWallIds.clear(); });
    redoFns.push(() => { restoreWallsFromSnapshots(graph, snapshots).forEach(w => r.generatedWallIds.add(w.id)); });
  }

  // ステップ3.5: ステップ2aで生成した階段下壁（偏芯主壁＋薄壁）の突き当たり処理。
  // ステップ3の後に行う: この時点で自室壁（2a）・隣接部屋壁（2）・外壁（3）が全て揃っており、
  // 取り合い相手が出そろっているため。
  // trimStairUnderJunctions（stairUnderWalls.js）を使う: 手動壁の graph.trimIntersectingWalls
  // は相手壁の最近傍端点を無条件にfaceへスナップするため、2a壁の端が既存壁の中間（T字）に
  // 突き当たる場合に既存壁側まで切り詰めてしまう（要件のバグ報告どおり実コードで確認。
  // core.js:1735-1770 の cand 計算に交点までの距離ガードが無い）。手動壁の挙動は変えず、
  // 2a壁専用にT字（既存壁は不変・2a壁側のみ近位faceで止める）/コーナー（出隅は遠位face、
  // 入隅は近位faceへ双方スナップ）を区別する専用関数を stairUnderWalls.js に用意した
  // （判断根拠: 出隅/入隅の材料範囲判定は偏芯壁対応の materialRange・部屋セル象限判定という
  // 2a壁固有の概念を要し、手動壁向けの汎用 core.js API を汚さない方が既存コードの構造に
  // 馴染む）。2a壁同士は trimStairUnderJunctions 内で対象外にする（生成時のコーナーマップで
  // 既に正しく取り合っているため）。
  // undo/redo は壁オブジェクト参照を保持しない（このエントリ内の後続 undo/redo で 2a壁・
  // 隣接部屋壁・外壁が削除→再生成されオブジェクト実体が変わるため）。壁IDで解決し直す
  // before/after 全体差分方式（edgeBefore/edgeAfter と同じ発想）を使う。
  // 再脱出時の冪等性: step2aEntries には壁生成をスキップした既存2a壁も含めているため
  // （このケースでは undoFns/redoFns への 2a壁生成エントリは積まれないが、トリムパスは
  // 毎回走る）、外壁が毎回作り直されても再トリムで同じ face 位置に再収束する（面位置が
  // 前回と不変なら candidate offset も不変で実質no-op。REASONED）。
  if (step2aEntries.length > 0) {
    const touched = new Map(); // wallId -> { before: {startOffset, endOffset} }
    const captureBefore = (id, startOffset, endOffset) => {
      if (!touched.has(id)) touched.set(id, { before: { startOffset, endOffset } });
    };
    const junctionSnaps = trimStairUnderJunctions(graph, step2aEntries);
    for (const snap of junctionSnaps) captureBefore(snap.wall.id, snap.startOffset, snap.endOffset);
    const trimChanges = [];
    for (const [id, rec] of touched) {
      const w = graph.shapeMap.get(id);
      if (!w) continue;
      const after = { startOffset: w.startOffset, endOffset: w.endOffset };
      if (after.startOffset !== rec.before.startOffset || after.endOffset !== rec.before.endOffset) {
        trimChanges.push({ id, before: rec.before, after });
      }
    }
    if (trimChanges.length > 0) {
      undoFns.push(() => {
        for (const c of trimChanges) {
          const w = graph.shapeMap.get(c.id);
          if (w) { w.startOffset = c.before.startOffset; w.endOffset = c.before.endOffset; }
        }
      });
      redoFns.push(() => {
        for (const c of trimChanges) {
          const w = graph.shapeMap.get(c.id);
          if (w) { w.startOffset = c.after.startOffset; w.endOffset = c.after.endOffset; }
        }
      });
    }
  }
  } // if (fmode) — 壁導出ブロック（ステップ1〜3.5）はここまで（F2）

  // ステップ4: 境界エッジのトポロジー差分同期（脱出時に確定・永続化）
  const edgeBefore = snapshotEdges(graph);
  runInAction(() => syncEdgesFromTopology(graph));
  const edgeAfter = snapshotEdges(graph);
  if (JSON.stringify(edgeBefore) !== JSON.stringify(edgeAfter)) {
    undoFns.push(() => restoreEdges(graph, edgeBefore));
    redoFns.push(() => restoreEdges(graph, edgeAfter));
  }

  // 腰壁・垂れ壁の孤児掃除: ステップ4のエッジ再同期直後、区間の幾何が解決できなくなった
  // （対象壁が消えた・CLトポロジーが変わった）キーを削除する（CL偏芯ステップ4bと同じ発想。
  // .claude/data-model.md「CL偏芯はレコードと導出結果を分離する」節参照）。腰壁・垂れ壁は
  // 壁側へ値を焼き込まない（天板の描画のみ）ため、CL偏芯4bのような壁復元は不要。
  if (graph.kneeDropWalls.size > 0) {
    const cellToRoom = buildCellToRoom(graph);
    const staleKneeDropKeys = [...graph.kneeDropWalls.keys()]
      .filter(key => !kneeDropWallGeometry(graph, key, cellToRoom));
    if (staleKneeDropKeys.length > 0) {
      const removedKneeDrop = staleKneeDropKeys.map(key => [key, graph.kneeDropWalls.get(key)]);
      runInAction(() => { for (const key of staleKneeDropKeys) graph.removeKneeDropWall(key); });
      undoFns.push(() => runInAction(() => { for (const [key, rec] of removedKneeDrop) graph.setKneeDropWall(key, rec); }));
      redoFns.push(() => runInAction(() => { for (const key of staleKneeDropKeys) graph.removeKneeDropWall(key); }));
    }
  }

  // ステップ4b: 内壁指定（INTERIOR_WALLエッジ）が消えたCLの偏芯レコードを掃除する
  // （ステップ4のトポロジー再同期後に判定——エッジが無くなった＝もう対象壁が無いCLの
  // レコードを残すと再突入時に亡霊レコードとして残り続ける）。
  // レコード削除の直後に applyCLEccentricity を「解除」として呼び、既に偏芯済みの壁も
  // 既定式へ戻す——レコードだけ消して壁を偏芯したまま孤児化させると、ユーザーが解除できなく
  // なる（QA finding 3）。clEccentricity.js 側は spec なし（解除）の場合 materialMap 不要・
  // スパン消滅後も続行するよう改修済み。壁側の変更差分はステップ2bと同型でundoFns/redoFnsへ
  // 積み、既存のレコード復元undoと併存させる（undo実行時は両方が走り、レコード・壁の双方を
  // 削除前の状態へ戻す）。
  const staleEccIds = [...graph.clEccentricities.keys()].filter(clId => interiorWallSpans(graph, clId).length === 0);
  if (staleEccIds.length > 0) {
    const { applyCLEccentricity } = await import('./clEccentricity.js');
    const removedEcc = staleEccIds.map(clId => [clId, graph.clEccentricities.get(clId)]);
    runInAction(() => { for (const clId of staleEccIds) graph.removeCLEccentricity(clId); });
    undoFns.push(() => runInAction(() => { for (const [clId, rec] of removedEcc) graph.setCLEccentricity(clId, rec); }));
    redoFns.push(() => runInAction(() => { for (const clId of staleEccIds) graph.removeCLEccentricity(clId); }));

    const eccTouched = new Map(); // wallId -> 変更前スナップショット（初回遭遇時点）
    for (const clId of staleEccIds) {
      for (const c of applyCLEccentricity(graph, clId, { materialMap: fmode?.materialMap })) {
        if (!eccTouched.has(c.wall.id)) {
          eccTouched.set(c.wall.id, {
            axisOffset: c.axisOffset, wallFinish: c.wallFinish, backingOffset: c.backingOffset,
            backingDepth: c.backingDepth, finishSide: c.finishSide, startOffset: c.startOffset, endOffset: c.endOffset,
          });
        }
      }
    }
    if (eccTouched.size > 0) {
      const eccChanges = [];
      for (const [id, before] of eccTouched) {
        const w = graph.shapeMap.get(id);
        if (!w) continue;
        eccChanges.push({
          id, before,
          after: {
            axisOffset: w.axisOffset, wallFinish: w.wallFinish, backingOffset: w.backingOffset,
            backingDepth: w.backingDepth, finishSide: w.finishSide, startOffset: w.startOffset, endOffset: w.endOffset,
          },
        });
      }
      const applyFields = (id, f) => {
        const w = graph.shapeMap.get(id);
        if (!w) return;
        w.axisOffset = f.axisOffset; w.wallFinish = f.wallFinish;
        w.backingOffset = f.backingOffset; w.backingDepth = f.backingDepth;
        w.finishSide = f.finishSide; w.startOffset = f.startOffset; w.endOffset = f.endOffset;
      };
      undoFns.push(() => eccChanges.forEach(c => applyFields(c.id, c.before)));
      redoFns.push(() => eccChanges.forEach(c => applyFields(c.id, c.after)));
    }
  }

  // ステップ4c: CL偏芯の階またぎ連動（階段は設置階〜最上階、吹抜けは直下階と共通）を、
  // ステップ4b の掃除後に残っている graph.clEccentricities の内容で連動先の他階へ
  // 再伝播する——脱出のたびに材変更・偏芯編集を連動先へ反映させる自動同期。4b が削除した
  // レコードそのものは伝播しない（4bの条件は緩めない。連動先の孤児レコードが残る既知の
  // 限界はここでは扱わない）。syncUpperStairInteriors（ステップ5）と同格の自動同期のため
  // undo 対象外。バッチ版（propagateCLEccentricities）で階ごとに peek 1回へ畳む（F5）。
  // observable map の keys() を await をまたいで直接 iterate しないよう、先に配列へ
  // スナップショットしてから渡す（F9）。
  if (graph.clEccentricities.size > 0) {
    const { propagateCLEccentricities } = await import('./eccentricityFloorSync.js');
    const clIds = [...graph.clEccentricities.keys()];
    await propagateCLEccentricities(project, graph, clIds, { materialMap: fmode?.materialMap });
  }

  // 全変更を単一の undo エントリとして登録（undo は逆順実行）
  if (undoFns.length > 0) {
    undoManager.push(
      () => { [...undoFns].reverse().forEach(fn => fn()); },
      () => { redoFns.forEach(fn => fn()); },
    );
  }

  // ステップ5: 階段設置階の上階（自動設置ペアRoom・最上階の階段吹抜け）へ、設置階ペアRoomの
  // 内装（templateKey・customOverrides）を同期コピーする（階段仕上げ材の参照）。壁は
  // この同期では生成しない——新モデルでは階段ペアRoom・吹抜けも通常のRoomと同じ経路
  // （ステップ1〜3）で壁を持つため、上階の壁はその階自身が仕上げモードを脱出した際に
  // 生成される。syncUpperFloors と同じ自動同期のため undo 対象外。
  if (graph.stairs.length > 0) {
    const { syncUpperStairInteriors } = await import('./stair/stairFloorSync.js');
    await syncUpperStairInteriors(project, graph);
  }

  // 要件2：フットプリント確定後に構造モードへ問合せ、自階＋上の全階の構造部材を更新する。
  await reflectStructuralAfterFinishExit(graph.plane.id, goingToStructure, project);
}
