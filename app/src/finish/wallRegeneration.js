// 仕上げモード脱出時の壁再生成（内周壁・階段下壁・外壁の全削除→再生成、突き当たり処理）。
// finish/finishBoundary.js の runFinishExitBoundary から「壁導出ブロック（ステップ1〜3.6）」を
// 純粋なコード移動として抽出したもの（挙動不変。ロジックの変更は下記の置換ルールに列挙した
// 箇所だけ）:
//   - fmode?.roomWallDims(graph, room)  → roomWallDims(graph, room, materialMap)（edgeComposition.js）
//   - fmode?.exteriorWallDims(graph)    → exteriorWallDims(graph, materialMap)（edgeComposition.js）
//   - fmode?.materialMap                → 引数 materialMap
//   - fmode?.stairUnderRooms(graph)     → 引数 stairUnderEntries
//   - floorSwapManager.peek(直下階) の到達辺 → 引数 extraStairOpenings（呼び出し側が解決して渡す）
//   - `if (fmode) { … }` ガード          → `if (!materialMap) return { regenerated:false, undoFns:[], redoFns:[] };`
// undoManager は import しない。undoFns/redoFns を返すだけにし、push は呼び出し側
// （runFinishExitBoundary）が従来どおり1エントリでまとめて行う。regenerated は「壁を実際に
// 触ったか」を呼び出し側へ伝える唯一の情報源（鮮度キーの書込み条件はこれだけを見る。QA F1）。
//
// 【重要・不変条件】FinishModeState / modes/ / undoManager / floorSwapManager / .jsx / store.js を
// import しない（wallFreshnessKey.test.js の走査テストが固定する）。
import { runInAction } from 'mobx';
import { stairPortEdges } from './stair/stairGeometry.js';
import {
  generateStairUnderWalls, trimStairUnderJunctions,
} from './stair/stairUnderWalls.js';
import {
  generateRoomWallsFromOutline, generateExteriorWalls, snapshotWall, restoreWallsFromSnapshots,
  resolveBackingOwnership, applyBackingOwnership, closeConvexCorners, isInteriorWallTarget,
} from './wallGeneration.js';
import { buildCellToRoom } from './edgeClassify.js';
import { woodBaseColumnWidthMm, woodColumnWidthMm } from '../structural/structureRules.js';
// edgeComposition.js は materialData.js（材マスタ全件）を静的に import するため、コード分割
// 維持のため regenerateWalls 内で動的 import する（materialData.js のヘッダコメント参照。
// clEccentricity.js と同じ理由——静的 import すると finishBoundary.js → App.jsx 経由で
// メインバンドルに材マスタが常時同梱されてしまう）。

/**
 * 材データを動的 import し、材コード→材の Map を作る（finish/clEccentricity.js と同じ理由で
 * コード分割維持のため動的 import。旧 runFinishEntryBoundary の pullMaterialMap 構築をここへ寄せた）。
 * FinishModeState.init()（:121付近）は同じ構築に加えて materials 配列そのもの（材種一覧UI用）も
 * 要るため、そちらは別構築のままにしてある（F8。二重管理ではあるが委譲すると余計な依存が増える）。
 * @returns {Promise<Map<string, object>>}
 */
export async function loadMaterialMap() {
  const { MATERIALS } = await import('./materials/materialData.js');
  return new Map(MATERIALS.map(m => [m.code, m]));
}

/**
 * 仕上げモード脱出時の壁再生成本体（内周壁の全削除→再生成、階段下壁(2a)、外壁の全削除→再生成、
 * 突き当たり・出隅処理）。materialMap が無ければ何もしない（既存壁を壊さない安全側）。
 * @param {object} graph
 * @param {object} opts
 * @param {Map<string,object>|null|undefined} opts.materialMap - 無ければ何もせず空の undoFns/redoFns を返す
 * @param {object|null} [opts.project] - 柱寸法シフト（bandShift）の実効主構造・階の上書き解決に使う
 *   （structural/structureRules.js woodBaseColumnWidthMm。省略時は graph 単体の後方参照へフォールバック）
 * @param {Array<{stair, room, splitCLIds}>} [opts.stairUnderEntries] - 階段下部屋（2a）。
 *   FinishModeState.stairUnderRooms(graph) / finish/stair/stairUnderRooms.js の
 *   resolveStairUnderEntries(graph, …) の戻り相当
 * @param {Array} [opts.extraStairOpenings] - 直下階階段の到達辺（最上階の階段吹抜けの下り口）。
 *   floorSwapManager.peek の結果を呼び出し側が解決して渡す
 * @returns {Promise<{ regenerated: boolean, undoFns: Function[], redoFns: Function[] }>}
 *   regenerated=false は materialMap が無く壁を一切触らなかったことを示す
 *   （呼び出し側はこれをそのまま「壁が再生成されたか」の唯一の判定源にする——鮮度キーの
 *   書込み条件をここと二重管理しない。QA F1）。
 */
export async function regenerateWalls(graph, { materialMap, project = null, stairUnderEntries = [], extraStairOpenings = [] } = {}) {
  const undoFns = [];
  const redoFns = [];

  // 壁導出ブロックは materialMap がある場合のみ実行する（旧: if (fmode)）。materialMap が無い
  // （モード切替中で材ロードがまだ完了していない等の一時的な状態）と roomWallDims/
  // exteriorWallDims が既定寸法へフォールバックし、ステップ1が実材厚で生成済みの既存壁・
  // 2a壁まで全削除して既定寸法で作り直してしまう（不可逆な破壊）。clEccentricity.js が
  // materialMap 未ロード時に適用自体をスキップする方針（適用時は黙って既定値へ潰さず
  // 止める）と同じ考え方。
  // 【設計裁定 2026-09-15・QA F2】旧 finishBoundary.js は fmode 生存×materialMap 未ロードでも
  // 「既定寸法で全再生成」していた（既存の実材厚壁・2a壁を壊して既定値57.5mm相当で作り直す）。
  // ここではその挙動を引き継がず、materialMap が無ければ何もしない（新の挙動を採用）。
  // 既存壁を破壊するだけの再生成に意味はなく、壁を一切触らない方が安全側のため。
  if (!materialMap) return { regenerated: false, undoFns, redoFns };

  const { roomWallDims, exteriorWallDims } = await import('./edgeComposition.js');

  // 柱寸法が基準（120）より細い階の外壁下地帯シフト量（ステップ1。structural/structureRules.js
  // woodBaseColumnWidthMm 参照）。外壁の外面（下地帯の遠い側）を通り芯±60に固定したまま、
  // 下地帯の中心をこの分だけ室外側へ寄せる——壁厚（wallBase）自体は exteriorWallDims の値
  // （＝柱寸法Wに追従済み。structural/woodAutoFill.js conformWoodBacking）のままなので、
  // ここではルール既定(120)との差だけを見る。
  // 発火条件は柱寸法W（woodColumnWidthMm）そのもの——下地材の実厚（exteriorWallDims.wallBase。
  // conformWoodBackingがWへ追従させた結果）をフォールバックに使わない（QA F4: 下地材コードが
  // 何らかの理由でまだWに追従していない一時状態でも判定はW自身を基準にする）。非在来
  // （woodBaseColumnWidthMm===null。framingを持たない主構造）はbandShift=0。
  // exteriorWallDimsがnull（下地材コードがmaterialMapに解決できない等のデータ不整合。通常
  // 到達しない）の場合もbandShift=0——どの実wallBaseに対してシフトするかが不明な状態で
  // W基準の量だけ動かすと、既定値（DEFAULT_WALL_BASE）にシフトを乗せた不整合な壁になるため。
  // 負（柱寸法が基準以上）は0にクランプする。
  const extDims = exteriorWallDims(graph, materialMap);
  const baseColumnWidth = woodBaseColumnWidthMm(graph, project);
  const bandShift = (extDims && baseColumnWidth != null)
    ? Math.max(0, (baseColumnWidth - woodColumnWidthMm(graph, project)) / 2)
    : 0;

  // 階段下部屋（破れ線先セルに部屋指定された領域。ステップ2a）。専用なのは生成手順
  // （固定ルールの偏芯・委譲・claim・既存壁との重なりスキップ・後追いトリム・生成順
  // 2a→隣室壁→外壁・描画クリップ）だけ——「一度生成したら不変」はステップ3（2026-09-15
  // 裁定「案B」）で撤廃し、他の壁と同じくステップ1の全削除・ステップ2aでの再生成に
  // 毎回参加させる。under2aRoomIds 自体は isInteriorWallTarget・generateStairUnderWalls の
  // opts で使うため残す（ステップ2の通常経路からは引き続き除外）。
  const under2aRoomIds = new Set(stairUnderEntries.map(e => e.room.id));

  // ステップ1: 内周壁（isRoomWall && 非外壁）を全削除する（外壁ステップ3と同じ思想。
  // 「壁＝部屋指定・内装・偏芯からの導出物」として脱出のたびに全削除→ステップ2で
  // 導出し直す。順序非依存・冪等になり、旧版が個別に行っていた自己修復（孤立壁削除・
  // 階段側壁の個別削除）は不要になった。階段ペアRoom（feature=STAIR）・階段吹抜け
  // （STAIR_VOID）の壁も対象——新モデルでは通常のRoomと同じ経路で壁を持つため、
  // 旧版の特別扱いは廃止した。2a壁も対象（ステップ3裁定「案B」。generateStairUnderWalls
  // のルール3「既存壁優先」は makeExistingCovers(graph) が生成開始時点の非外壁をスナップ
  // ショットして判定するため、2a壁を含めて全削除した後は既存カバーが毎回同じ集合
  // （ステップ1で消えない手動壁のみ）になり初回生成と同じ壁が出る＝冪等——stairUnderWalls.js 参照）。
  const staleInteriorSnapshots = [];
  for (const [, shape] of graph.shapeMap) {
    if (shape.isRoomWall && !shape.isExteriorWall) staleInteriorSnapshots.push(snapshotWall(shape));
  }
  if (staleInteriorSnapshots.length > 0) {
    const roomWallIdsBefore = new Map(); // room -> Set<wallId>（undo復元用。2a部屋も対象——ステップ3裁定）
    for (const room of graph.rooms) {
      roomWallIdsBefore.set(room, new Set(room.generatedWallIds));
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
  // 直下階階段の到達辺（最上階の階段吹抜けの下り口）は呼び出し側が floorSwapManager.peek
  // で解決済みのものを渡す（このモジュールは floorSwapManager を import しない）。
  stairOpenings.push(...extraStairOpenings);

  // ステップ2a: 階段下部屋（破れ線先セルに部屋指定された階段下エリア）の壁生成。
  // ステップ2より先に行い、この部屋を generatedWallIds 済みにしてステップ2の通常経路
  // （偏芯を持たない対称壁）から除外する。claimedEdges（generateStairUnderWalls の戻り値。
  // underEdges へ合流）は破れ線・踊り場境界（無壁）と、この部屋が既に受け持った外周
  // （外側部屋の薄壁を含む）の重複生成を防ぐため、ステップ2・3の開口辺フィルタへ合流させる
  // （生成順: 2a→2→3）。claim は walls.length===0（ルール3で全区間スキップ）でも行う必要が
  // あるため、claimedEdges の反映は下記ループ内で walls.length チェックより前に置く
  // （QA U1: 専用の軽量経路 stairUnderClaimedEdges は廃止し、生成本体の戻り値を使う）。
  // 毎回全再生成する（ステップ3裁定「案B」。旧: 部屋が既に generatedWallIds を持つ再脱出時は
  // 壁を再生成せずトリム対象として拾うだけだった——「一度生成したら不変」を撤廃し、
  // ステップ1で全削除済みのため他の壁と同じく毎回生成してよい。壁idは再脱出のたびに
  // 変わるが、makeExistingCovers(graph) が生成開始時点の非外壁をスナップショットする
  // ルール3「既存壁優先」により、既存カバーが毎回同じ集合（ステップ1で消えない手動壁のみ）
  // になる状態から常に同じ形状の壁が出る＝冪等）。
  // 既知制約: 同一部屋が2階段にまたがる退化構成（stairUnderRoomsが同じroomを複数返す）は、
  // claim は先に処理された stair が勝つ（stairOrder 順）。壁生成は後続 stair も走るが、
  // ルール3（既存壁優先）が先行 stair の壁と重なる分を抑止する（ステップ3で early-continue を
  // 撤廃したため。本数は stairUnderWalls.test.js【退化構成・現行順序の固定】が固定する）。
  // step2aEntries: 今回生成した2a壁を { wall, room } で保持する。ステップ3後のトリムパス
  // （trimStairUnderJunctions。隣接壁・外壁との T字/出隅/入隅取り合い）の対象にする
  // ——room は出隅/入隅判定（象限がそのRoomのセルに属するか）に使う。
  // buildCellToRoom(graph) は2a部屋1件につき claim経路・生成経路の双方で呼ばれると2回
  // 走ってしまう（QA指摘）。壁がまだ1本も追加されていないこの時点でグラフ全体から
  // 1度だけ作り、両経路で共有する（Room.cellsは触っていないため、このループ内で使い回しても
  // 結果は変わらない）。
  const stairUnderCellToRoom = buildCellToRoom(graph);
  const underEdges = [];
  const step2aEntries = [];
  for (const { stair, room, splitCLIds } of stairUnderEntries) {
    const { walls, claimedEdges } = generateStairUnderWalls(
      graph, stair, room, roomWallDims(graph, room, materialMap) || {},
      { splitCLIds, dimsOf: r => roomWallDims(graph, r, materialMap) || {}, stairOpenings, under2aRoomIds, cellToRoom: stairUnderCellToRoom },
    );
    // claim は walls.length===0（ルール3で全区間スキップされた等）でも行う——claimedEdges は
    // own（委譲されなかったエッジ）から computeClaimedEdges で作られ、壁の生成有無とは独立
    // （generateStairUnderWalls のJSDoc参照）。ここで先に反映しないと、後続の隣室壁・外壁が
    // この2a部屋の外周に誤って壁を生成してしまう（QA U1: stairUnderClaimedEdges 廃止に伴う移設）。
    underEdges.push(...claimedEdges);
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
  // 階段ペアRoom（feature=STAIR）・階段吹抜け（STAIR_VOID）も同仕様で参加する（ただし
  // 屋外（kind=EXTERIOR）の部屋・階段は対象外——屋外部屋は壁を持たないため、屋外階段も含め
  // 常にスキップする。屋内側の統一ルールのみ以下の説明が適用される）:
  // 下地オーナー壁＋仕上げ薄壁方式——同一CL上の下地（間柱帯）は1つだけ、各面（部屋側・
  // 階段側）の仕上げ材は面ごとに描画される。所有権解決（resolveBackingOwnership。
  // wallGeneration.js）をこの直後に行い、＋側の壁を下地オーナーに、−側の壁を仕上げ薄壁
  // （backingDepth=0）に確定する（部分重なりは壁を分割する）。
  // 部分指定（referenceRoomIds あり）は通常、親が外周壁を担うため対象外——ただし
  // feature=STAIR（部屋の部分指定から階段変換した階段）は例外で対象に含める。旧版にあった
  // 親隣接面だけの抑止（parentAdjacentEdges）は不要——新モデルでは所有権解決
  // （resolveBackingOwnership）が親側の壁との重なりを検出して自動的に薄壁化するため。
  // 対象判定は isInteriorWallTarget（wallGeneration.js）に抽出済み（単体テスト対象）。
  const wallIdToRoom = new Map(); // wallId -> 生成元Room（所有権解決の分割で generatedWallIds を張り替えるため）
  const roomWallLists = new Map(); // room -> Wall[]（今回生成分。所有権解決前）
  const processedRooms = [];
  for (const room of graph.rooms) {
    if (!isInteriorWallTarget(room, under2aRoomIds)) continue;

    const walls = generateRoomWallsFromOutline(graph, room, {
      ...(roomWallDims(graph, room, materialMap) || {}), bandShift, cellToRoom: stairUnderCellToRoom,
    }, [...stairOpenings, ...underEdges]);
    if (walls.length === 0) continue;

    walls.forEach(w => { room.generatedWallIds.add(w.id); wallIdToRoom.set(w.id, room); });
    roomWallLists.set(room, walls);
    processedRooms.push(room);
  }

  // 所有権解決: 同一CL上の下地を1本に統一する。分割で生じた新壁は wallIdToRoom へ
  // 反映し、旧壁IDを新壁群に張り替える（generatedWallIds も同様に張り替える）。
  // 所有権解決・CL偏芯・外壁オーナー化は Wall のフィールド（backingOffset 等）を**直接**
  // 書き換える。graph.addWall/removeShape は action だが直接代入はそうではないため、
  // runFinishExitBoundary が action の外で走る以上ここを包まないとMobX strict-modeの
  // 警告が出る（既に描画で観測済みの壁を書き換えるため。ステップ3.5/3.6と同じ理由・同じ手当て）。
  const allNewInteriorWalls = processedRooms.flatMap(r => roomWallLists.get(r));
  runInAction(() => {
    for (const [oldId, newWalls] of resolveBackingOwnership(graph, allNewInteriorWalls)) {
      const room = wallIdToRoom.get(oldId);
      if (!room) continue;
      room.generatedWallIds.delete(oldId);
      for (const nw of newWalls) { room.generatedWallIds.add(nw.id); wallIdToRoom.set(nw.id, room); }
    }
  });

  // ステップ2b: CL偏芯の適用（内壁指定のあるCLに設定された偏芯仕様を対象壁へ反映する。
  // spec と現材から毎回フル再計算する冪等処理——脱出のたびに材変更を偏芯壁へ反映させる）。
  // ステップ3（外壁の全削除・再生成）より前に行う: 対象は非外壁のみのため実害はないが、
  // 生成済みの内壁（ステップ2）に対して行うのが素直なため直後に置く。
  // materialMap が無ければ丸ごとスキップする（applyCLEccentricity 自体も materialMap
  // 無しでは何もしないが、無駄な動的importとループを避ける。QA finding 2）。
  if (graph.clEccentricities.size > 0 && materialMap) {
    const { applyCLEccentricity } = await import('./clEccentricity.js');
    const eccTouched = new Map(); // wallId -> 変更前スナップショット（初回遭遇時点）
    runInAction(() => {
      for (const clId of graph.clEccentricities.keys()) {
        for (const c of applyCLEccentricity(graph, clId, { materialMap })) {
          if (!eccTouched.has(c.wall.id)) {
            eccTouched.set(c.wall.id, {
              axisOffset: c.axisOffset, wallFinish: c.wallFinish, backingOffset: c.backingOffset,
              backingDepth: c.backingDepth, finishSide: c.finishSide, startOffset: c.startOffset, endOffset: c.endOffset,
            });
          }
        }
      }
    });
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
      const applyFields = (id, f) => runInAction(() => {
        const w = graph.shapeMap.get(id);
        if (!w) return;
        w.axisOffset = f.axisOffset; w.wallFinish = f.wallFinish;
        w.backingOffset = f.backingOffset; w.backingDepth = f.backingDepth;
        w.finishSide = f.finishSide; w.startOffset = f.startOffset; w.endOffset = f.endOffset;
      });
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
  const newExteriorWalls = generateExteriorWalls(graph, { ...(extDims || {}), bandShift }, [...stairOpenings, ...underEdges]);

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
  runInAction(() => {
    for (const [oldId, newWalls] of applyBackingOwnership(graph, newExteriorWalls, currentInteriorWalls, { setOwnerFields: false, claimUncovered: false })) {
      const room = wallIdToRoom.get(oldId);
      if (!room) continue;
      room.generatedWallIds.delete(oldId);
      for (const nw of newWalls) { room.generatedWallIds.add(nw.id); wallIdToRoom.set(nw.id, room); }
    }
  });

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
  // core/wallChamfer.js trimIntersectingWalls の cand 計算に交点までの距離ガードが無い）。
  // 手動壁の挙動は変えず、2a壁専用にT字（既存壁は不変・2a壁側のみ近位faceで止める）/コーナー
  // （出隅は遠位face、入隅は近位faceへ双方スナップ）を区別する専用関数を stairUnderWalls.js
  // に用意した（判断根拠: 出隅/入隅の材料範囲判定は偏芯壁対応の materialRange・部屋セル象限
  // 判定という2a壁固有の概念を要し、手動壁向けの汎用 core.js API を汚さない方が既存コードの
  // 構造に馴染む）。2a壁同士は trimStairUnderJunctions 内で対象外にする（生成時のコーナー
  // マップで既に正しく取り合っているため）。
  // undo/redo は壁オブジェクト参照を保持しない（このエントリ内の後続 undo/redo で 2a壁・
  // 隣接部屋壁・外壁が削除→再生成されオブジェクト実体が変わるため）。壁IDで解決し直す
  // before/after 全体差分方式（edgeBefore/edgeAfter と同じ発想）を使う。
  // 再脱出時の冪等性: 2a壁も毎回作り直される（ステップ3裁定「案B」）ため step2aEntries は
  // 常に今回生成分のみだが、生成手順（偏芯・claim等）自体は不変のため同じ形状の壁が出る。
  // 外壁も毎回作り直されるが、同じ理由で毎回同じ face 位置に再収束する（REASONED）。
  if (step2aEntries.length > 0) {
    const touched = new Map(); // wallId -> { before: {startOffset, endOffset} }
    const captureBefore = (id, startOffset, endOffset) => {
      if (!touched.has(id)) touched.set(id, { before: { startOffset, endOffset } });
    };
    // trimStairUnderJunctions は Wall.startOffset/endOffset を直接書き換えるため action で包む
    // （MobX strict-mode。描画中の ShapesLayer が offset を観測している状態で走る）。
    const junctionSnaps = runInAction(() => trimStairUnderJunctions(graph, step2aEntries));
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
      const applyTrim = (key) => () => runInAction(() => {
        for (const c of trimChanges) {
          const w = graph.shapeMap.get(c.id);
          if (w) { w.startOffset = c[key].startOffset; w.endOffset = c[key].endOffset; }
        }
      });
      undoFns.push(applyTrim('before'));
      redoFns.push(applyTrim('after'));
    }
  }
  // ステップ3.6: 出隅（外側に凸な角）の取り合いを閉じる（closeConvexCorners。wallGeneration.js）。
  // ステップ3.5と同じ理由でここに置く——自室壁・隣接部屋壁・外壁・階段下壁が出そろい、
  // CL偏芯（2b）も反映済みのこの時点でなければ「相手の材の外面」が確定しない。
  // 角を挟む2枚が別々の部屋の輪郭から生成されると生成時のコーナーマップでは解決できず、
  // 角の外側に壁厚ぶんの欠けが残る（ユーザー実機指摘2026-08「21」のX2×Y2+3500の出隅）。
  // undo/redo は3.5と同じ id ベースの before/after 差分方式。
  {
    const before = new Map();
    for (const w of graph.walls) before.set(w.id, { startOffset: w.startOffset, endOffset: w.endOffset });
    runInAction(() => closeConvexCorners([...graph.walls]));
    const cornerChanges = [];
    for (const w of graph.walls) {
      const b = before.get(w.id);
      if (!b) continue;
      if (b.startOffset !== w.startOffset || b.endOffset !== w.endOffset) {
        cornerChanges.push({ id: w.id, before: b, after: { startOffset: w.startOffset, endOffset: w.endOffset } });
      }
    }
    if (cornerChanges.length > 0) {
      const apply = (key) => () => runInAction(() => {
        for (const c of cornerChanges) {
          const w = graph.shapeMap.get(c.id);
          if (w) { w.startOffset = c[key].startOffset; w.endOffset = c[key].endOffset; }
        }
      });
      undoFns.push(apply('before'));
      redoFns.push(apply('after'));
    }
  }

  return { regenerated: true, undoFns, redoFns };
}
