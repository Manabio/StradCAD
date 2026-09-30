// 中心⇔通り芯の入替えの階またぎ同期。finish/eccentricityFloorSync.js（peek→操作→saveFloor→
// undoManager.amend という階またぎ同期パターン）を雛形にする。
//
// findFloorsWithCounterpartCL は昇格・降格の双方の事前ガードとして使う（スキップ方式は不採用——
// 片階だけ複製漏れすると壁参照が壊れるため、1階でも重複していれば全体を拒否する）:
//   昇格（中心→通り芯）: 通り芯化すると全階の同じグリッドに現れる。既に他階の同じ座標に
//   補助線・保護される梁芯があると座標が重複して混乱するため、昇格前に拒否する。他階の同座標の
//   中心線は拒否せず findCenterLinesToAbsorbOnPromote/applyCenterLineAbsorptionOnPromote が吸収する
//   （`absorbCenter:true`で相手から除外する。線種変更の移籍一本化・裁定Q1・2026-09-30）。
//   降格（通り芯→中心）: 降格後に他階へ複製する座標が、既にその階にある中心線・補助線と
//   衝突しないことを事前に確認する（複製自体は下記 propagateDemotedCenterLine）。
// 降格（通り芯→中心）: アクティブ階にだけ中心線が現れるのは不整合（通り芯は全階共通だった）
// なので、非アクティブの全階へ**新しいid**の中心線を作る（propagateDemotedCenterLine。線種変更の
// 移籍一本化・2026-09-30: 降格前と同じidで複製する「分身」方式は廃止し、線idはプロジェクト全体で
// 一意に保つ——各平面のスナップショット内の通り芯id参照はlineIdRemap.jsで新idへ一括置換する）。
// **降格の移籍前に複製する**（通り芯が project.structGraph に残っている間に peek しないと、
// 他階の壁が graphSnapshot.js の resolveCL で解決できず復元時に捨てられる。2026-09-17実測）。
import { runInAction } from 'mobx';
import { Discipline, CenterLineType, CenterLine, isGridCenterLine, centerLineKind } from '@core';
import {
  sameCoordCounterparts, CROSS_FLOOR_COUNTERPART_KINDS, isPromoteAbsorbedKind,
} from '../core/centerLineKindPolicy.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import {
  serializeGraph, restoreGraph, decodeFloorSnapshot, encodeFloorSnapshot,
} from '../graphSnapshot.js';
import { remapLineIdsInSnapshot, findLineIdOccurrences } from '../lineIdRemap.js';
import { saveFloor } from '../storage/db.js';
import { undoManager } from '../undoManager.js';
import {
  findWallBeamAxisCLs, isProtectedWallBeamAxis, wallBeamSourcesFor, belowPlaneOf,
} from '../structural/wallBeamAxes.js';
import { isFootprintBoundaryCL } from './centerLineConvert.js';
// CL削除ステップ4（ルール2）: 通り芯削除の他階後始末が使う。centerLineOps.jsが既に静的に引いている
// 依存（wallBeamAxes.js経由のFloorSwapManager.js・storage/db.js）と同系統のため、これらを静的import
// してもnode:testからの単体import可能性は壊れない（centerLineOps.js冒頭コメントと同じ理由）。
import {
  findUnresolvableCells, reinterpretRoomsOnEntry, normalizePartialDominance,
  reinterpretSlabsAfterCLRemoval, collectUnresolvableCells,
} from '../finish/roomReinterpret.js';
import { syncEdgesFromTopology } from '../finish/edgeClassify.js';
import { refreshWallsForGraph, hasNeverBuiltWalls } from '../wallRefresh.js';
import { rulesFor, effectiveStructure } from '../structural/structureRules.js';

// アクティブ以外の全 Plane（project.planeMap。検討・屋根 Plane 含む）を返す。
// export: structural/fixedMemberRefs.js（CL削除の固定材事前確認。手動追加材サイレント撤去回避
// 指示書§5ステップ3）が同じ「他階を見る」流儀（otherPlanes＋floorSwapManager.peek）を再利用するため。
export function otherPlanes(project, activeGraph) {
  const activeId = activeGraph?.plane?.id;
  return [...project.planeMap.values()].filter(p => p.id !== activeId);
}

/**
 * 昇格・降格双方の事前ガードとして使う: cl と同じ centerLineType・ほぼ同じ座標に非通り芯CL
 * （中心線・補助線・梁芯。CROSS_FLOOR_COUNTERPART_KINDS）を持つ Plane を、アクティブ以外の全 Plane
 * から探す。昇格（centerLineOps.js の promoteCenterToGridWithUndo）は cl がまだ中心線のときに呼び、
 * 降格（demoteGridToCenterWithUndo）は cl がまだ通り芯のときに呼ぶ——どちらも
 * cl.centerLineType/cl.value は変換前の値をそのまま使えるため、呼び出し側の型は同じでよい。
 * 同一 id の CL は他の判定（Q11・findFloorsWithSameLineId）が呼び出し側の入口で先に検出して拒否する
 * ため、ここでは id による除外は行わない（線種変更の移籍一本化・2026-09-30: 降格が同じidで複製する
 * 「分身」方式を廃止したため、同id除外はもう往復を通すための特別扱いとしては不要——分身の廃止に
 * 伴い、本関数は id の一致・不一致に関わらず座標一致だけで判定する）。
 * 対象種別（CROSS_FLOOR_COUNTERPART_KINDS）は同階内の入替えガード（CONVERT_BLOCKING_KINDS。
 * 方向ごとに別集合）とは別の関係——通り芯は全階共有オブジェクトのため他階では相手たりえない一方、
 * 中心線・補助線・梁芯はいずれも階ローカルの実体のため、方向（昇格・降格）を問わず同じ集合になる
 * （centerLineKindPolicy.js「原始事実6」参照）。
 * 1つの階に複数種別が同座標にあるときは、CROSS_FLOOR_COUNTERPART_KINDS の並び順（中心線＞補助線＞
 * 梁芯。centerLineOps.js addCenterLineFromDialog の優先順と同じ規約）で1つ選んで報告する。
 * 発見④・ユーザー裁定・案A・2026-09-25: `excludeAbsorbableBeam:true`（昇格専用。降格は既存どおり
 * falseのまま）を渡すと、保護されない壁由来梁芯（`isProtectedWallBeamAxis`がfalse）は相手から除外する
 * ——`absorbWallBeamAxesOnPromote`が同じ階を吸収撤去するため、ここで重複扱いにする必要が無い。
 * 相手の識別は`centerLineKind(other)==='beam'`のインライン比較ではなく`findWallBeamAxisCLs`が返す
 * オブジェクトとの同一性比較で行う（G3ガード対策。呼び出し側centerLineOps.jsに種別名を直書きしない
 * のと同じ理由でこちらも避ける）。線種変更の移籍一本化 ステップ6是正（2026-09-30）: 同座標に
 * 区間の離れた梁芯が複数本ありうるため複数形で列挙し、**全部**が保護されない場合だけ除外する
 * （1本でも保護されれば除外せず通常の重複相手として残す——absorbWallBeamAxesOnPromoteの
 * 「1本でも保護されれば階ごと拒否」と対にする）。
 * 裁定Q1・Q2（線種変更の移籍一本化・2026-09-30）: `absorbCenter:true`（昇格専用。降格は渡さず
 * 従来どおりfalseのまま）を渡すと、種別'center'（中心線）は相手から除外する——
 * `findCenterLinesToAbsorbOnPromote`/`applyCenterLineAbsorptionOnPromote`が同じ階の中心線を
 * 吸収するため、ここで重複扱い（拒否）にする必要が無い。
 * @param {{excludeAbsorbableBeam?: boolean, absorbCenter?: boolean}} [opts]
 * @returns {Promise<Array<{plane: Plane, kind: string}>>} 見つかった Plane と相手種別（0件なら変換して問題ない）
 */
export async function findFloorsWithCounterpartCL(project, activeGraph, cl, { excludeAbsorbableBeam = false, absorbCenter = false } = {}) {
  const result = [];
  const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
  for (const plane of otherPlanes(project, activeGraph)) {
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    // 線種変更の移籍一本化 ステップ6是正（2026-09-30）: 同座標に区間の離れた梁芯が複数本ありうる
    // ため findWallBeamAxisCLs（複数形）で列挙する。1本でも保護されていれば（=absorbWallBeamAxesOnPromote
    // 側が拒否する）除外せず通常の重複判定に残す——「全部absorbableなときだけ除外する」規則
    // （absorbWallBeamAxesOnPromoteの「1本でも保護されれば階ごと拒否」と対にする）。
    const absorbableBeamAxes = excludeAbsorbableBeam ? findWallBeamAxisCLs(temp, isVertical, cl.value) : [];
    const allAbsorbable = absorbableBeamAxes.length > 0 && absorbableBeamAxes.every(ax => !isProtectedWallBeamAxis(temp, ax));
    const isExcludedAbsorbable = (other) => allAbsorbable && absorbableBeamAxes.includes(other);
    const counterparts = sameCoordCounterparts(temp, { centerLineType: cl.centerLineType, value: cl.value })
      .filter(other => CROSS_FLOOR_COUNTERPART_KINDS.includes(centerLineKind(other)))
      .filter(other => !isExcludedAbsorbable(other))
      .filter(other => !(absorbCenter && isPromoteAbsorbedKind(other)));
    if (counterparts.length === 0) continue;
    const kind = CROSS_FLOOR_COUNTERPART_KINDS.find(k => counterparts.some(c => centerLineKind(c) === k));
    result.push({ plane, kind });
  }
  return result;
}

/**
 * 昇格・降格双方の事前ガード（裁定Q11・線種変更の移籍一本化）: id はプロジェクト全体で一意という
 * 不変条件（lineIdUniqueness.js 参照）が既存データで崩れていないかを確認する。id（通り芯として
 * project.structGraph に居る、または居ようとしている cl の id）と同じ id を持つ「自グラフ固有」の
 * 中心線（lineIdUniqueness.js floorOwnCenterLineIds と同じ絞り込み——shapeMap の CenterLine のうち
 * 通り芯（GRID種別）を除いたもの）を、アクティブ以外の全 Plane から探す。見つかったら移籍側は
 * 何も書き換えずに拒否する（黙って壊さない）——リリース前の既存データ走査（線種変更の移籍一本化
 * 指示書 §2.5）では0件だったが、防御として昇格・降格の入口に置く。findFloorsWithCounterpartCL
 * とは独立に評価する（座標一致ではなくid一致）。
 * 性能: このステップでは他階を3回peekする経路になる（本関数・findFloorsWithCounterpartCL・
 * propagateDemotedCenterLine/absorb系がそれぞれ独立にpeekするため）ことを受容する——同id判定を
 * findFloorsWithCounterpartCL のpeekへ相乗りさせる余地がある。
 * @param {object} project
 * @param {PlanGraph} activeGraph
 * @param {string} id
 * @returns {Promise<Array<{plane: Plane}>>} 見つかった Plane の配列（空なら問題ない）
 */
export async function findFloorsWithSameLineId(project, activeGraph, id) {
  const result = [];
  for (const plane of otherPlanes(project, activeGraph)) {
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    const shape = temp.shapeMap.get(id);
    const hasSameId = shape instanceof CenterLine && !isGridCenterLine(shape);
    if (hasSameId) result.push({ plane });
  }
  return result;
}

/**
 * 通り芯削除の事前ガード: cl（通り芯。project.structGraph の共有オブジェクト）が、アクティブ以外の
 * いずれかの Plane（検討・屋根含む）でフットプリント境界CL（transform/centerLineConvert.js
 * isFootprintBoundaryCL）になっているかを調べる。通り芯は全階共通のオブジェクトのため、
 * findFloorsWithCounterpartCL のような座標一致による対応物探し（他階では別オブジェクトになる
 * 中心線・補助線・梁芯向けの仕組み）は不要——同じ cl をそのまま各階の temp グラフへ渡せばよい
 * （判定は cl の向き・value・有効区間とその階のフットプリント輪郭線分との幾何照合）。
 * 部屋を持たない階（屋根専用平面等）は footprintCellKeys が空となり isFootprintBoundaryCL が
 * 自然に偽を返す（呼び出し側は無視してよい）。
 * @param {object} project
 * @param {PlanGraph} activeGraph  削除を実行しようとしている階のグラフ（自階。自階判定は呼び出し側が別途行う）
 * @param {CenterLine} cl          通り芯（まだ project.structGraph に居る）
 * @returns {Promise<Array<object>>} フットプリント境界になっている Plane の配列（空なら他階に影響なし）
 */
export async function findFloorsWhereFootprintBoundary(project, activeGraph, cl) {
  const result = [];
  for (const plane of otherPlanes(project, activeGraph)) {
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    if (isFootprintBoundaryCL(temp, cl)) result.push(plane);
  }
  return result;
}

/**
 * 通り芯削除の事前ガード（ステップ4・ルール2）: findFloorsWhereFootprintBoundary と
 * 同じpeek対象・同じ1階1回のpeekで、「フットプリント境界」と「復元不能セル」（finish/roomReinterpret.js
 * findUnresolvableCells。自階のガードと同じ判定）の両方を判定する——2つの独立関数にすると他階を
 * 2回peekすることになるため1本化する。屋根専用平面（isRoofPlane）は部屋を持たないため
 * footprintCellKeys・room/slab/stair.cellsがいずれも空になり、isFootprintBoundaryCL・
 * findUnresolvableCellsのどちらも自然に偽を返す——特別扱いのスキップは行わず、素通しで判定する
 * （判定コスト自体は無害で、部屋を持たない前提が崩れた場合にも正しく動く）。
 * 優先順は自階ガード（deleteCenterLineWithUndo）と同じくフットプリント境界を先に見る
 * （1階がどちらにも該当する場合は境界側として報告する）。
 * anyOtherFloorNeedsWallRegen（QA指摘H1/H2/M1是正の他階版。QA指摘10で見直し・2026-09-27）: 壁再生成に
 * 必要なmaterialMap・遅延チャンク前提のロードを「他階のうちこの通り芯を参照する非屋根階が壁を持つ」
 * ときだけ変更前に行うための判定を、この同じpeekへ相乗りさせる（他階を専用に再peekしない）。
 * この通り芯を一切参照しない階（detachOtherFloorsFromGridCenterLineでskipされる階）・屋根専用平面
 * （isRoofPlane。detachのみで後始末・壁再生成の対象外）・部屋0件・壁も鍵も無い階
 * （wallRefresh.js hasNeverBuiltWalls）は対象外——参照の無い階まで含めると、materialMap取得・
 * カタログ読込み失敗時に無関係な階を理由に削除自体がERR_CL_DELETE_WALLS_UNAVAILABLEで拒否されうる。
 * 判定はdetachOtherFloorsFromGridCenterLineの参照判定（hasExternalCenterLineReferences ||
 * referencesClInCellsOrRecords）と同じものを使う（skip条件が食い違わないようにする）。
 * @param {object} project
 * @param {PlanGraph} activeGraph
 * @param {CenterLine} cl
 * @returns {Promise<{ footprintPlanes: object[], unresolvablePlanes: object[], anyOtherFloorNeedsWallRegen: boolean }>}
 */
export async function findFloorsBlockingGridDeletion(project, activeGraph, cl) {
  const footprintPlanes = [];
  const unresolvablePlanes = [];
  let anyOtherFloorNeedsWallRegen = false;
  for (const plane of otherPlanes(project, activeGraph)) {
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    if (isFootprintBoundaryCL(temp, cl)) footprintPlanes.push(plane);
    else if (findUnresolvableCells(temp, cl.id).length > 0) unresolvablePlanes.push(plane);
    const isRoof = temp.plane?.isRoofPlane === true;
    const hasRefs = temp.hasExternalCenterLineReferences(cl.id) || referencesClInCellsOrRecords(temp, cl.id);
    if (!isRoof && hasRefs && !hasNeverBuiltWalls(temp)) anyOtherFloorNeedsWallRegen = true;
  }
  return { footprintPlanes, unresolvablePlanes, anyOtherFloorNeedsWallRegen };
}

// CL削除ステップ2（transform/centerLineOps.jsから移設。ステップ4・2026-09-27）: 削除するCLを参照する
// 腰壁・垂れ壁レコード（graph.kneeDropWalls）を掃除する。key=edgeKey(axisCLId,startCLId,endCLId)
// （core/room.js edgeKey）——軸・端点いずれかが削除したCLを指すレコードは、削除の時点で先に消しておく
// （残すとfinish/kneeDropWall.jsの走査対象に亡霊レコードとして残り続ける）。他階の後始末
// （applyOtherFloorsGridCenterLineAftermath経由）でも同じ理由で使うため、applyCenterLineRemovalAftermathと同じ
// ファイルへ置く（centerLineOps.js⇄centerLineFloorSync.jsの循環importを避けるため。centerLineOps.jsは
// 引き続きこの関数をここからimportして使う）。
export function removeKneeDropWallsReferencing(graph, clId) {
  for (const key of [...graph.kneeDropWalls.keys()]) {
    if (key.split(':').includes(clId)) graph.removeKneeDropWall(key);
  }
}

/**
 * graph（部屋・スラブ・階段のセルキー・腰壁レコード・トポロジー自動補完の除外集合・柱芯オフセット・
 * CL偏芯・refIdで参照する子CL）が clId を参照しているか（ステップ4・
 * detachOtherFloorsFromGridCenterLineのskip条件見直し用）。
 * hasExternalCenterLineReferences（柱・梁・耐力壁・基礎・スリーブ・一般Shape・他CLのextentRef）が
 * 見ないセル・レコード側の参照をここで補う——セルキーはCL参照ではなく「CL id を含む文字列」のため、
 * hasExternalCenterLineReferencesの走査（_structuralRefsToCL・isReferencedByOtherCL(includeRefId:false)）
 * には現れない。ここで見る種類は`core/planGraph.js`の`removeDependentsOfCenterLine`
 * （柱芯オフセット`columnAxisOffsets`・CL偏芯`clEccentricities`・トポロジー自動補完の除外集合）と
 * `removeCenterLine`が`detachFromCenterLine`の前に呼ぶ`_reparentChildCenterLines`
 * （refIdでこのCLを参照する子CL。`isReferencedByOtherCL(clId,{includeRefId:true})`で判定）の
 * 対応物——この階が処理対象になれば`detachOtherFloorsFromGridCenterLine`が
 * `reparentChildCenterLines`・`detachFromCenterLine`・`removeDependentsOfCenterLine`を呼ぶため、
 * ここで拾った参照は後始末で実際に解消される。
 * @param {import('@core').FloorGraph} graph
 * @param {string} clId
 * @returns {boolean}
 */
function referencesClInCellsOrRecords(graph, clId) {
  for (const room of graph.rooms) {
    for (const key of room.cells) if (key.split(':').includes(clId)) return true;
  }
  for (const slab of graph.slabs) {
    for (const key of slab.cells) if (key.split(':').includes(clId)) return true;
  }
  for (const stair of graph.stairs) {
    for (const key of stair.cells) if (key.split(':').includes(clId)) return true;
  }
  for (const key of graph.kneeDropWalls.keys()) {
    if (key.split(':').includes(clId)) return true;
  }
  for (const set of [graph.excludedColumnSlots, graph.excludedBeamSlots, graph.excludedFootingSlots]) {
    for (const key of set) if (key.split(':').includes(clId)) return true;
  }
  if (graph.columnAxisOffsets.has(clId)) return true;
  if (graph.clEccentricities.has(clId)) return true;
  if (graph.isReferencedByOtherCL(clId, { includeRefId: true })) return true;
  return false;
}

/**
 * 通り芯削除の自階後始末（新ルール1）: 「部屋再解釈→部分指定の正規化→スラブ再解釈→エッジ再同期→
 * 腰壁/垂れ壁の掃除」（runInAction 1本）→ 削除前後の復元不能セル差分による安全網判定 →
 * 壁再生成（wallRefresh.js refreshWallsForGraph。force:true）まで。
 * transform/centerLineOps.js deleteCenterLineWithUndo の struct・非struct両分岐の自階、および
 * applyOtherFloorsGridCenterLineAftermath 経由の他階後始末（ステップ4・ルール2）が共有する（挙動を分岐ごとに
 * 個別実装しない）。呼び出し側は graph からこのCLの detach・removeDependentsOfCenterLine
 * （非struct分岐は graph.removeCenterLine 経由）を、既に済ませてから呼ぶか、`opts.deleteFn`として
 * 渡すこと（自階呼び出しはQA指摘7是正により後者——同じrunInAction 1本に削除と後始末をまとめる。
 * 他階呼び出しはフェーズ1で既にdetach済みのため`opts.deleteFn`を渡さない）。
 *
 * **壁由来梁芯の道連れ削除はここでは行わない**（QA指摘5・2026-09-27是正）: selfAndBelow規則は
 * 「1つ下の実体階」の壁も道連れ判定の根拠にするため、その階が他階側の後始末（フェーズ2）で壁再生成
 * される場合、道連れ判定は自階・全階の壁再生成が終わってから1パスで行う必要がある——ここで自階分だけ
 * 先に評価すると、まだ壁再生成されていない下階の状態を根拠にしてしまう。道連れ削除は
 * `structural/wallBeamAxes.js`の`removeOrphanedWallBeamAxesFor`（呼び出し側が全階の壁再生成の後に呼ぶ）
 * に分離した。
 *
 * `beforeUnresolvable`は必須（QA指摘1・2026-09-27是正）: 削除前後の復元不能セル差分による安全網は、
 * 「CLがgraphに存在する」削除前の状態と比較しないと意味を持たない（`finish/roomReinterpret.js`
 * `cellInteriorPoint`はCLの存在で結果が変わる）。本関数は呼び出し側が既にCLをgraphから取り除いた**後**
 * （struct分岐は`project.structGraph.removeCenterLine`の後、非struct分岐は`graph.removeCenterLine`の後）
 * に呼ばれるため、自身の内部で採ると「削除後」同士の差分になり常に空になる——呼び出し側が削除前
 * （detachより前）に採った集合を渡すこと。
 *
 * 例外処理: 本関数はtry/catchを持たない——呼び出し側（centerLineOps.js既存のtry/catch。struct分岐は
 * restoreStructCLs→restoreGraph→rollbackFloorRecords→再throw、他階呼び出し側
 * applyOtherFloorsGridCenterLineAftermathは呼び出し元のrollbackFloorRecordsに委ねる）がそのまま巻き戻す。
 * @param {import('@core').FloorGraph} graph 削除対象CLの参照を既に切り離し済みのgraph（自階または他階のpeek結果）
 * @param {object} project
 * @param {string} clId 削除したCLのid（削除前に控えたもの）
 * @param {object} opts
 * @param {Set<string>} opts.beforeUnresolvable - 削除前（detachより前）に採取した
 *   `collectUnresolvableCells(graph)`の結果（必須。省略するとthrowする）
 * @param {Map} [opts.materialMap] - 壁再生成に使うmaterialMap（呼び出し側が変更前に取得済みのものを渡す）
 * @param {(plane:object, structGraph:object) => Promise<object|null>} [opts.peek] - refreshWallsForGraphへ
 *   そのまま渡すpeek（resolveStairContext用）
 * @param {boolean} [opts.canCarryWalls=true] - false（補助線・梁芯自身の削除）なら後始末・壁再生成そのものを
 *   スキップする（centerLineOps.js非struct分岐のcanCarryWallsと同じ意味）
 * @param {boolean} [opts.willRegenerateWalls=opts.canCarryWalls] - 呼び出し側が変更前に判定した
 *   「実際に壁再生成が起きるか」（hasNeverBuiltWalls等）。assertStillValidを呼ぶかどうかのゲートにのみ使う
 * @param {Function} [opts.regenerateWallsFn] - refreshWallsForGraphへそのまま渡すテスト差し替え
 * @param {() => void} [opts.assertStillValid] - 壁再生成await直後に呼ぶ防御チェック（自階のみ想定。
 *   例外を投げれば呼び出し側のcatchへ伝播する。他階呼び出しでは省略してよい）
 * @param {() => void} [opts.deleteFn] - 後始末と同じrunInActionの先頭で呼ぶ削除コールバック
 *   （QA指摘7是正・2026-09-27: 削除とその直後の後始末を1つのMobXアクションにまとめるため。
 *   自階呼び出し側が渡す——struct分岐は`detachFromCenterLine`・`removeDependentsOfCenterLine`・
 *   `project.structGraph.removeCenterLine`、非struct分岐は`graph.removeCenterLine`。他階呼び出し
 *   （フェーズ1で既にdetach済み）では省略する）
 * @returns {Promise<{ newlyUnresolved: string[] }>} 非空なら安全網——呼び出し側は変更を取り消すこと
 *   （壁再生成はまだ行っていない）
 */
export async function applyCenterLineRemovalAftermath(graph, project, clId, {
  beforeUnresolvable, materialMap, peek, canCarryWalls = true,
  willRegenerateWalls = canCarryWalls, regenerateWallsFn, assertStillValid, deleteFn,
} = {}) {
  if (!beforeUnresolvable) {
    throw new Error('applyCenterLineRemovalAftermath: opts.beforeUnresolvableは必須です（削除前にcollectUnresolvableCellsで採取してから渡すこと）');
  }
  const afterUnresolvable = runInAction(() => {
    deleteFn?.();
    if (canCarryWalls) {
      reinterpretRoomsOnEntry(graph);
      normalizePartialDominance(graph);
      reinterpretSlabsAfterCLRemoval(graph);
      syncEdgesFromTopology(graph);
      removeKneeDropWallsReferencing(graph, clId);
    }
    return collectUnresolvableCells(graph);
  });
  const newlyUnresolved = [...afterUnresolvable].filter(key => !beforeUnresolvable.has(key));
  if (newlyUnresolved.length > 0) return { newlyUnresolved };

  if (canCarryWalls) {
    await refreshWallsForGraph(graph, project, () => materialMap, {
      peek, pushUndo: false, force: true,
      ...(regenerateWallsFn ? { regenerateWallsFn } : {}),
    });
    if (willRegenerateWalls) assertStillValid?.();
  }
  return { newlyUnresolved: [] };
}

// propagateDemotedCenterLine 共通: ループ途中で例外
// （IDB書込失敗等）が起きても、そこまでに保存できた分だけは undo で戻せるよう必ず amend する
// （一部の階だけ複製された不整合な状態のまま undo 不能になるのを防ぐ）。
// 呼び出し側は finally で呼ぶこと——finally を抜けた後、例外があれば自然に再スローされる
// （catchしていないため）。saveFloorFn は呼び出し時に渡されたものを使う（往復テストのため、
// undo/redo時の書き戻しもテスト用の差し替えに乗せられるようにする）。
// centerLineOps.js の降格（複製フェーズをundoエントリ作成前に行う）からも呼べるよう export する
// （undoEntry が無いうちは no-op で返るため、そこでの呼び出しは安全）。
// amendFloorUndoRecords の内部処理（旧 applyBytes）を export として切り出したもの（挙動不変。
// 2026-09-25）。centerLineOps.js の通り芯削除（deleteCenterLineWithUndo）は、他階への伝播
// （detachOtherFloorsFromGridCenterLine・applyOtherFloorsGridCenterLineAftermath）を自前の
// undo/redoクロージャの中で順序制御して呼ぶため
// （amendではなく、structGraph・自階の復元と同じエントリに直接組み込む——amendFloorUndoRecordsは
// undoManager.amendを内部で呼ぶため、まだエントリが無い段階や順序を自分で組みたい呼び出し元には
// 使えない）、amendに包まれた形ではなく本関数を直接呼べるようにする。
// 発見④・ユーザー裁定・案A・2026-09-25: 同じ階（planeId）が records に複数回現れうる
// （promoteCenterToGridWithUndoが「他階の梁芯吸収（absorbWallBeamAxesOnPromote）」と「他階の中心線吸収
// （applyCenterLineAbsorptionOnPromote。線種変更の移籍一本化・2026-09-30）」の両方の記録を同じ配列へ積む
// ——ユーザー裁定「同じ配列に積んでよい」）。redo（'after'）は記録された順（＝実際に変更が起きた順）
// に適用すれば最後の要素が最終状態を表すため配列順のままでよいが、undo（'before'）は逆順に適用しないと「後で起きた変更の
// before（＝先に起きた変更の後の状態）」が「先に起きた変更のbefore（＝真の元の状態）」を上書きして
// しまい、真の元の状態へ戻らない。単一階が1回しか現れない既存の呼び出し（削除・降格）では順序は
// 結果に影響しない（各要素が異なる階を指すため）ため、挙動不変のまま安全に適用できる。
export function applyFloorUndoRecords(project, records, which, saveFloorFn = saveFloor) {
  const ordered = which === 'before' ? [...records].reverse() : records;
  for (const rec of ordered) {
    if (project.activePlane?.id === rec.planeId) {
      restoreGraph(project.activeGraph, rec[which]); // undo実行時にその階がアクティブなら生きているグラフへ復元
    } else {
      saveFloorFn(rec.planeId, rec[which]).catch(console.error); // 非アクティブ階は IDB のみが正
    }
  }
}

export function amendFloorUndoRecords(project, undoEntry, undoRecords, saveFloorFn = saveFloor) {
  if (!undoEntry || undoRecords.length === 0) return;
  undoManager.amend(
    undoEntry,
    () => applyFloorUndoRecords(project, undoRecords, 'before', saveFloorFn),
    () => applyFloorUndoRecords(project, undoRecords, 'after', saveFloorFn),
  );
}

/**
 * 通り芯削除フェーズ1（ステップ4・ルール2）: アクティブ以外の全 Plane（検討階・屋根を含む）を
 * peekし、この通り芯を参照する階だけ detach＋撤去する（保存はしない。フェーズ2
 * applyOtherFloorsGridCenterLineAftermathが後始末まで行う）。呼び出し側
 * centerLineOps.js の deleteCenterLineWithUndo は、この関数のあとで自階の
 * detachFromCenterLine・removeDependentsOfCenterLine・`project.structGraph.removeCenterLine(cl.id)`
 * を行うこと——通り芯が project.structGraph に残っている間に他階を peek しないと、他階の壁の
 * axisCL/clStart/clEnd が graphSnapshot.js の resolveCL で解決できず、復元時に黙って捨てられる
 * （端点ルール（detachFromCenterLine）が一切効かないまま壁が消える——降格
 * propagateDemotedCenterLine と同じ「複製（ここでは撤去）→移籍」の型。2026-09-17実測の教訓）。
 *
 * **2フェーズに分けた理由（ステップ4・2026-09-27実測）**: 後始末（部屋再解釈。
 * finish/roomReinterpret.js reinterpretRoomsOnEntry等）は「そのCLがgraphに存在しないこと」を
 * 「辺を失った」判定に使う（finish/gridCells.js lostSides・cellInteriorPoint。
 * graph.shapeMap・graph._structGraph.shapeMapの両方を見る）。通り芯はdetach段階ではまだ
 * project.structGraphに実在するため、detachの直後に後始末を呼んでも「辺は1つも失っていない」と
 * 判定され、部屋が併合されない（実測: 2部屋のまま無変更）。後始末は必ず
 * `project.structGraph.removeCenterLine(cl.id)`（自階・他階共通で1回）の**後**に呼ぶこと。
 *
 * **2パスに分けた理由（QA指摘5是正・2026-09-27）**: 在来木造（selfAndBelow）は「1つ下の実体階」の
 * 壁も壁由来梁芯生成・道連れ削除の根拠にする。1パスで「peek→sourcesBefore採取→detach」を階ごとに
 * 順に行うと、後で処理する階の`sourcesBefore`が「先に処理された下階（既にdetach済み）」を参照して
 * しまい、まだ変更されていないはずの下階の状態を誤って読む。1パス目で全階（自階含む）を
 * detachしていない状態でpeek・`sourcesBefore`・`beforeUnresolvable`を採り、2パス目でdetachする
 * （自階分は呼び出し側=centerLineOps.jsが同じタイミングで使えるよう`self`として返す——自階自身は
 * この関数ではdetachしない。自階のbelowGraphが他階の1つと重なる場合でも、1パス目の時点では
 * まだどの階もdetachされていないため一貫した値になる）。
 * `opts.peekBelow`（テスト差し替え）は自階のbelowGraph解決にのみ使う（centerLineOps.js opts.peekBelowと
 * 同じ役割・同じ引数 `(graph, project)`）——他階のbelowGraph解決は常にこの関数のpeekキャッシュを使う
 * （他階同士は差し替える理由が無い）。
 *
 * 参照が1つも無い階（この通り芯と無関係な階）は peek はするが detach しない
 * （hasExternalCenterLineReferences に加え、部屋・スラブ・階段のセルキー・腰壁レコード・トポロジー
 * 自動補完の除外集合・柱芯オフセット・CL偏芯・refIdで参照する子CLが clId を参照していないかも見る
 * ——referencesClInCellsOrRecords。ステップ4・ルール2で見直し: セルキーはCL参照ではなく文字列として
 * CL idを含むため、旧来の hasExternalCenterLineReferences だけでは「部屋セルの辺だけがこのCLを持つ階」
 * 「柱芯オフセット・CL偏芯・refId子CLだけがこのCLを指す階」を誤ってスキップしてしまう）。
 *
 * 何も保存しない（副作用は各階の使い捨てpeekグラフへの変更のみ）ため、この関数自身が例外を投げても
 * ロールバックは不要——呼び出し側はまだ何も永続化していない段階として素通しでよい（N5と同じ
 * 「先に判定・失敗するなら書き込まない」規律の一部）。
 * @param {object} project
 * @param {PlanGraph} activeGraph  削除を実行する階のグラフ（アクティブ階）
 * @param {CenterLine} cl          削除前の通り芯（まだ project.structGraph に居る）
 * @param {{peekBelow?: (graph:object, project:object) => Promise<object|null>}} [opts] - opts.peekBelowは
 *   自階のbelowGraph解決のテスト差し替え（centerLineOps.js opts.peekBelowと同じ契約）
 * @returns {Promise<{
 *   contexts: Array<{plane: object, temp: object, before: Uint8Array, sourcesBefore: Array|null,
 *     beforeUnresolvable: Set<string>|null, belowGraph: object|null, isRoof: boolean, peekCache: Map}>,
 *   orphanOnly: Array<{plane: object, temp: object, before: Uint8Array, sourcesBefore: Array|null,
 *     belowGraph: object|null}>,
 *   self: { belowGraph: object|null, sourcesBefore: Array },
 *   peekCache: Map,
 * }>} contextsはフェーズ2へそのまま渡す（detachが不要だった階は含まれない）。orphanOnlyはこの通り芯を
 *   参照していなかった非屋根他階（呼び出し側=centerLineOps.jsが`structural/wallBeamAxes.js`の
 *   `removeOrphanedWallBeamAxesFor`で道連れ削除だけを評価する——detach・部屋再解釈・壁再生成の対象
 *   ではない）。selfは呼び出し側が自階のwallBeamSourcesFor比較に使う（下階が他階の1つと重なっていても
 *   detach前の一貫した値になっている）。
 */
export async function detachOtherFloorsFromGridCenterLine(project, activeGraph, cl, { peekBelow } = {}) {
  // 他階の道連れ削除（selfAndBelow規則のwallBeamSourcesFor）・壁再生成（resolveStairContext）が
  // 「1つ下の実体階」をpeekする際、このループで既にpeek済みの階を再peekして二重に読まないよう、
  // peekしたgraphインスタンスをplaneId単位でメモ化する（team-lessons「他階の道連れ削除に要る
  // belowGraphはメモ化peekで取得」）。activeGraphは自階自身が「他階のbelowGraph」になりうる
  // （例: 2階建てでp2を削除中、p2のbelowはp1＝activeGraph）ため、生きているグラフのまま種にする
  // ——1パス目ではまだ project.structGraph.removeCenterLine もdetachも起きていないため、
  // activeGraphのwallBeamSourcesForは削除前の状態のまま正しい。フェーズ2へpeekCacheをそのまま渡し、
  // resolveStairContext用のpeekがこのフェーズで温めた（あるいは既に detach 済みの）インスタンスを
  // 再利用できるようにする。
  const peekCache = new Map([[activeGraph.plane.id, activeGraph]]);
  const cachedPeek = async (plane, structGraph) => {
    if (!peekCache.has(plane.id)) peekCache.set(plane.id, await floorSwapManager.peek(plane, structGraph));
    return peekCache.get(plane.id);
  };
  const resolveBelowGraph = async (plane) => {
    const belowPlane = belowPlaneOf(plane, project);
    return belowPlane ? cachedPeek(belowPlane, project.structGraph) : null;
  };

  // 1パス目: 全他階をpeekし、どの階もdetachしていない状態でsourcesBefore・beforeUnresolvableを採る。
  // QA指摘（リード裁定=案i・2026-09-27）: 壁由来梁芯の道連れ削除は「この通り芯を参照していた他階
  // （pending）」だけでなく**全非屋根他階**を評価対象にする——参照を持たない階でも「1つ下の実体階
  // （自階または他階）の壁」だけを根拠にした壁由来梁芯を持つことがあり、その下階が今回の削除の
  // 後始末で壁再生成されると孤児になりうる（下階を持たない・参照もない階は影響を受けないため実害は
  // 無いが、判定自体は全階で行わないと見逃す）。sourcesBefore・belowGraphの採取は既にこのループで
  // 全他階をpeekしているため追加I/Oは無い——pendingに乗せない階（hasRefs===false）もorphanOnlyへ
  // 採取結果を残す。
  const pending = [];
  const orphanOnly = [];
  for (const plane of otherPlanes(project, activeGraph)) {
    const temp = await cachedPeek(plane, project.structGraph);
    const isRoof = temp.plane?.isRoofPlane === true;
    const needsBelowPeek = !isRoof && rulesFor(effectiveStructure(temp, project)).wallBeamAxes === 'selfAndBelow';
    const belowGraph = needsBelowPeek ? await resolveBelowGraph(plane) : null;
    // sourcesBefore・beforeUnresolvableは detach より前の状態で採る（centerLineOps.js 自階分と
    // 同じ規律）。
    const sourcesBefore = !isRoof ? wallBeamSourcesFor(temp, project, belowGraph) : null;

    const hasRefs = temp.hasExternalCenterLineReferences(cl.id) || referencesClInCellsOrRecords(temp, cl.id);
    if (hasRefs) {
      const beforeUnresolvable = !isRoof ? collectUnresolvableCells(temp) : null;
      pending.push({ plane, temp, sourcesBefore, beforeUnresolvable, belowGraph, isRoof });
    } else if (!isRoof) {
      // 参照は持たないが道連れ削除の評価対象にはなる階——detach・保存はまだ行わない
      // （変化が実際に起きた階だけ後で保存する。呼び出し側centerLineOps.jsが
      // structural/wallBeamAxes.js removeOrphanedWallBeamAxesForで評価する）。
      orphanOnly.push({ plane, temp, before: serializeGraph(temp), sourcesBefore, belowGraph });
    }
  }

  // 自階分も同じ1パス目・同じキャッシュから採る（下階が他階の1つと重なっていても、まだどの階も
  // detachされていない一貫した値になる）。
  const needsBelowPeekSelf = rulesFor(effectiveStructure(activeGraph, project)).wallBeamAxes === 'selfAndBelow';
  const selfBelowGraph = needsBelowPeekSelf
    ? await (peekBelow ? peekBelow(activeGraph, project) : resolveBelowGraph(activeGraph.plane))
    : null;
  const selfSourcesBefore = wallBeamSourcesFor(activeGraph, project, selfBelowGraph);

  // 2パス目: 他階をdetach（変更を伴うのはここから）。
  const contexts = [];
  for (const { plane, temp, sourcesBefore, beforeUnresolvable, belowGraph, isRoof } of pending) {
    const before = serializeGraph(temp);
    runInAction(() => {
      // core/planGraph.js removeCenterLineと同じ順序（reparent→detach→teardown相当）。
      // reparentChildCenterLinesは通り芯がthis.shapeMapに無くても_structGraph側から解決する
      // （2026-09-27是正）——この階自身の子CL（refIdでこの通り芯を参照するaux/center）の
      // refIdを繰り上げてから、壁端・extent参照の切り離し・柱芯オフセット等の撤去に進む。
      temp.reparentChildCenterLines(cl.id);
      temp.detachFromCenterLine(cl.id);
      temp.removeDependentsOfCenterLine(cl.id);
    });
    contexts.push({ plane, temp, before, sourcesBefore, beforeUnresolvable, belowGraph, isRoof, peekCache });
  }
  return { contexts, orphanOnly, self: { belowGraph: selfBelowGraph, sourcesBefore: selfSourcesBefore }, peekCache };
}

/**
 * 通り芯削除フェーズ2（ステップ4・ルール2）: detachOtherFloorsFromGridCenterLineが集めた
 * コンテキストへ、自階と同じ後始末（applyCenterLineRemovalAftermath——部屋再解釈→安全網→壁再生成）を
 * 適用する（保存・壁由来梁芯の道連れ削除はここでは行わない——QA指摘5是正。呼び出し側が自階・全階の
 * 処理が揃った後に`removeOrphanedWallBeamAxesFor`→保存の順で行う）。**呼び出し側は
 * `project.structGraph.removeCenterLine(cl.id)` の後にこの関数を呼ぶこと**（フェーズ1のJSDoc
 * 「2フェーズに分けた理由」参照——後始末はCLが実際に無くなっていないと辺の喪失を検出できない）。
 * 屋根専用平面（isRoofPlane）は部屋を持たないため後始末はスキップ——detach伝播のみ（現行どおり）。
 * 壁再生成に必要なmaterialMap・遅延チャンク前提は呼び出し側（centerLineOps.js）が変更前に取得して
 * opts.materialMap で渡すこと——ここでは取得しない（変更後の区間に実I/Oを持ち込まないため。
 * team-lessons参照）。
 *
 * 他階の後始末で新たに復元不能セルが生じた場合は、その階を含めて即座に処理を打ち切り
 * `{ rejectedPlane }` を返す（例外は投げない。まだ何も保存していないため巻き戻しは不要）——
 * 呼び出し側（centerLineOps.js。自階のnewlyUnresolved判定と同じ関数呼び出しの中）がstructGraph・
 * 自階の復元を行う。regenerateWallsFn自体が例外を投げた場合はそのまま再throwし、呼び出し側の
 * 安全網（restoreStructCLs→restoreGraph→再throw）に委ねる。
 * @param {Array} contexts detachOtherFloorsFromGridCenterLineの戻り値（.contexts）
 * @param {object} project
 * @param {string} clId 削除する通り芯のid（`project.structGraph.removeCenterLine`で既に削除済み）
 * @param {{materialMap?: Map, regenerateWallsFn?: Function}} [opts]
 * @returns {Promise<{ rejectedPlane: object|null, processed: Array<{plane, temp, before, sourcesBefore, belowGraph, isRoof}> }>}
 *   rejectedPlaneが非nullなら安全網に掛かった（呼び出し側はundoを積まず巻き戻すこと。processedは
 *   その時点までに正常処理できた分）。rejectedPlaneがnullならprocessedは保存前のcontextsそのまま
 *   （呼び出し側が道連れ削除→保存の順で使う）。
 */
export async function applyOtherFloorsGridCenterLineAftermath(contexts, project, clId, {
  materialMap, regenerateWallsFn,
} = {}) {
  const processed = [];
  for (const { plane, temp, before, sourcesBefore, beforeUnresolvable, belowGraph, isRoof, peekCache } of contexts) {
    if (!isRoof) {
      const cachedPeek = async (p, structGraph) => {
        if (!peekCache.has(p.id)) peekCache.set(p.id, await floorSwapManager.peek(p, structGraph));
        return peekCache.get(p.id);
      };
      const { newlyUnresolved } = await applyCenterLineRemovalAftermath(temp, project, clId, {
        materialMap, peek: cachedPeek, beforeUnresolvable,
        ...(regenerateWallsFn ? { regenerateWallsFn } : {}),
      });
      if (newlyUnresolved.length > 0) return { rejectedPlane: plane, processed };
    }
    processed.push({ plane, temp, before, sourcesBefore, belowGraph, isRoof });
  }
  return { rejectedPlane: null, processed };
}

/**
 * 通り芯削除フェーズ2の仕上げ（QA指摘5是正・2026-09-27）: applyOtherFloorsGridCenterLineAftermathが
 * 集めたprocessed（道連れ削除まで済んだ他階）を保存し、undoRecordsへ記録する。呼び出し側
 * （centerLineOps.js）が自階・全他階の壁由来梁芯の道連れ削除
 * （structural/wallBeamAxes.js removeOrphanedWallBeamAxesFor）を終えた**後**に呼ぶこと——
 * 道連れ削除前の状態を保存してしまわないため。
 * @param {Array} processed applyOtherFloorsGridCenterLineAftermathの戻り値（.processed）
 * @param {{undoRecords?: Array, saveFloorFn?: Function}} [opts]
 * @returns {Promise<Array>} undoRecords（呼び出し側が渡した配列、省略時は内部で新規作成したもの）
 */
export async function saveOtherFloorsAfterGridCenterLineAftermath(processed, { undoRecords = [], saveFloorFn = saveFloor } = {}) {
  for (const { plane, temp, before } of processed) {
    await saveFloorFn(plane.id, serializeGraph(temp));
    undoRecords.push({ planeId: plane.id, before, after: serializeGraph(temp) });
  }
  return undoRecords;
}

/**
 * 降格（通り芯→中心）の**移籍前**に、アクティブ以外の全 Plane へ**新しい id**の中心線を作る
 * （線種変更の移籍一本化・裁定2・Q1: 線の id はプロジェクト全体で一意に保つ——降格前と同じ id で
 * 複製する「分身」方式は廃止した）。呼び出し側は centerLineConvert.js の applyDemoteToCenter より
 * 先にこれを呼ぶこと——通り芯が project.structGraph に残っている間に peek しないと、他階の壁の
 * axisCL/clStart/clEnd が graphSnapshot.js の resolveCL で解決できず復元時に黙って捨てられる
 * （2026-09-17実測）。
 * extent は昇格前と同じ最外郭通り芯2本への ref（loCL/hiCL）にする。複製が読む
 * cl.centerLineType/_value/trim/refId/refOffset は applyDemoteToCenter が変更しないフィールド
 * なので、移籍前に読んでも複製内容は移籍後に読むのと同一。
 * 新しい中心線を追加した直後の snapshot に対し、`lineIdRemap.js`
 * `remapLineIdsInSnapshot(snapshot, Map([[cl.id, newId]]))` で **その平面のスナップショット内の
 * 通り芯id参照を一括で新idへ置き換える**（壁の軸・始終端、建具、セルキー、他の線のrefId/extent参照、
 * 構造材、柱芯オフセット、CL偏芯…参照の種類ごとに書かず1関数で行う——線種変更の移籍一本化
 * 指示書 §5.2）。事後条件として
 * `findLineIdOccurrences(remapped, [cl.id])` が空であることを検査し、非空ならthrowする（黙って
 * 参照を壊さない。message に平面名を含める）。新しい中心線自身の `refId`・extent参照（loCL/hiCL）は
 * 通り芯id（cl.id）とは別のidのため、この置換の影響を受けない。
 * undoEntry を渡すと、変更した各階の before/after を undoManager.amend で合成する。undoEntry が無い
 * 呼び出し（centerLineOps.js の降格はまだ undo エントリを作っていない段階でこれを呼ぶ。CL偏芯の
 * applyCLEccentricityWithUndo も同じ理由でundoRecords配列だけを渡しamendは使わない）でも
 * before/after は常に undoRecords へ記録する——呼び出し側が opts.undoRecords に配列を渡せば、
 * 例外発生時も途中まで積んだ記録を参照できる（ロールバックに使う）。
 * removeFixedMembersFn を渡すと、複製の直前（同じ runInAction の先頭。before採取後・複製の
 * addCenterLine前）に各階のtempへ `removeFixedMembersFn(temp, cl.id)` を呼ぶ（手動追加材
 * サイレント撤去回避 指示書§2.4・§3裁定4・§5ステップ4）。before/afterは1階1レコードのまま
 * （削除も複製も同じrunInAction・同じsaveFloorFn呼び出しに含まれるため、undoで両方が戻り、
 * redoで両方が再び効く）。ここから直接 structural/fixedMemberRefs.js を import しない——
 * fixedMemberRefs.js が本ファイルの otherPlanes を import しており、逆向きimportは循環になる
 * ため、依存注入（呼び出し側のtransform/centerLineOps.jsが実装を渡す）にする。
 * newIdFn はテストの決定性のために注入可能（既定 crypto.randomUUID）。
 * @param {object} project
 * @param {PlanGraph} activeGraph  降格を実行する階のグラフ（アクティブ階）
 * @param {CenterLine} cl          降格前の通り芯（まだ project.structGraph に居る）
 * @param {{loCL, hiCL, undoEntry?: object|null, saveFloorFn?: Function, undoRecords?: Array,
 *   removeFixedMembersFn?: Function|null, newIdFn?: () => string}} opts
 * @returns {Promise<Array>} undoRecords（呼び出し側が渡した配列、省略時は内部で新規作成したもの）
 */
export async function propagateDemotedCenterLine(project, activeGraph, cl, {
  loCL, hiCL, undoEntry = null, saveFloorFn = saveFloor, undoRecords = [], removeFixedMembersFn = null,
  newIdFn = () => crypto.randomUUID(),
}) {
  try {
    for (const plane of otherPlanes(project, activeGraph)) {
      const temp = await floorSwapManager.peek(plane, project.structGraph);
      const before = serializeGraph(temp);
      const newId = newIdFn();
      runInAction(() => {
        if (removeFixedMembersFn) removeFixedMembersFn(temp, cl.id);
        temp.addCenterLine(cl.centerLineType, cl._value, {
          labeled: false, discipline: Discipline.ARCH, lineType: 'center', trim: cl.trim,
          refId: cl.refId, refOffset: cl.refOffset,
          extentLoRef: { clId: loCL.id, offset: 0 },
          extentHiRef: { clId: hiCL.id, offset: 0 },
        }, newId);
        temp.columnAxisOffsets.delete(cl.id);
      });
      const snapshot = decodeFloorSnapshot(serializeGraph(temp));
      const remapped = remapLineIdsInSnapshot(snapshot, new Map([[cl.id, newId]]));
      const leftover = findLineIdOccurrences(remapped, [cl.id]);
      if (leftover.length > 0) {
        throw new Error(`propagateDemotedCenterLine: ${plane.name} に通り芯idの参照が残っています（${leftover.map(o => o.path).join(', ')}）`);
      }
      const after = encodeFloorSnapshot(remapped);
      await saveFloorFn(plane.id, after);
      undoRecords.push({ planeId: plane.id, before, after });
    }
  } finally {
    amendFloorUndoRecords(project, undoEntry, undoRecords, saveFloorFn);
  }
  return undoRecords;
}

/**
 * 昇格（中心線→通り芯）の**移籍前**に、アクティブ以外の全Plane（検討・屋根含む）で、この位置の
 * 壁由来梁芯（discipline:fuse）のうち保護されない（`isProtectedWallBeamAxis`がfalse）ものを吸収撤去する
 * （発見④・ユーザー裁定・案A・2026-09-25）。自階の吸収撤去（`transform/centerLineOps.js`の
 * `promoteCenterToGridWithUndo`。段階(c)発見②）と同じ考え方・同じ保護述語を他階へ広げたもの——
 * 通り芯は全階共通のため、他階にも独立して生成された壁由来梁芯が同座標に残りうる。
 *
 * **移籍前に呼ぶこと**（`propagateDemotedCenterLine`と同じ規律）: 他階の壁は`cl.id`を参照するため、
 * 通り芯化で`cl`を`project.structGraph`へ移した後に他階をpeekすると、その階の壁の
 * `axisCL`/`clStart`/`clEnd`が`graphSnapshot.js`の`resolveCL`で解決できず復元時に黙って捨てられる。
 *
 * 2段階で処理する（保護される階が1つでもあれば無変更のまま拒否理由を返す。N5と同じ「先に判定・
 * 失敗するなら書き込まない」規律）:
 *   1. 全階をpeekして梁芯の有無・保護の要否を確認するだけ（変更しない）。
 *   2. 1つも保護されなければ、実際に撤去してsaveFloorFn・undoRecordsへ記録する。
 * 撤去は`graph.removeCenterLine`（乗っていたauto柱・梁・基礎は`removeDependentsOfCenterLine`で
 * 道連れになり、以後の構造同期で作り直される）。`excludedWallBeamAxes`には触れない——手動削除の
 * 記録ではなく、通り芯化に伴う自然な後始末のため。
 * 呼び出し側（`promoteCenterToGridWithUndo`）がawaitし、途中（フェーズ2のsaveFloorFn）で例外が
 * 起きた場合は自前でrollbackFloorRecordsして再throwすること（このファイル自身は例外を握りつぶさない）。
 * @param {object} project
 * @param {PlanGraph} activeGraph  昇格を実行する階のグラフ（アクティブ階）
 * @param {CenterLine} cl          昇格前の中心線（まだ活性階に居る）
 * @param {{undoRecords?: Array, saveFloorFn?: Function}} [opts]
 * @returns {Promise<{blockedPlanes: Plane[]}>} 保護される梁芯があった階の一覧（空なら吸収は成功・実施済み）
 */
export async function absorbWallBeamAxesOnPromote(project, activeGraph, cl, { undoRecords = [], saveFloorFn = saveFloor } = {}) {
  const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
  const targets = [];
  const blockedPlanes = [];
  for (const plane of otherPlanes(project, activeGraph)) {
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    // 線種変更の移籍一本化 ステップ6是正（2026-09-30）: 同座標に区間の離れた梁芯が複数本ありうる
    // ため findWallBeamAxisCLs（複数形）で全て列挙する——1本でも保護されていれば階ごと拒否、
    // そうでなければ全部撤去する（findWallBeamAxisCL単数形の`.find()`では2本目を見落とす）。
    const beamAxes = findWallBeamAxisCLs(temp, isVertical, cl.value);
    if (beamAxes.length === 0) continue;
    if (beamAxes.some(ax => isProtectedWallBeamAxis(temp, ax))) {
      blockedPlanes.push(plane);
    } else {
      targets.push({ plane, temp, beamAxes });
    }
  }
  if (blockedPlanes.length > 0) return { blockedPlanes };

  for (const { plane, temp, beamAxes } of targets) {
    const before = serializeGraph(temp);
    runInAction(() => { for (const ax of beamAxes) temp.removeCenterLine(ax.id); });
    const after = serializeGraph(temp);
    await saveFloorFn(plane.id, after);
    undoRecords.push({ planeId: plane.id, before, after });
  }
  return { blockedPlanes: [] };
}

/**
 * 昇格・通常追加（中心線→通り芯）の事前調査（QA所見5是正・2026-09-30。線種変更の移籍一本化
 * ステップ6是正・2026-09-30: **平面単位**へまとめた——値ごとに独立してpeekすると、同じ平面を
 * 複数の値で吸収するとき、値ごとに取得した別々の`temp`インスタンスへ順にsaveFloorFnが書き込み、
 * 後で処理した値のbeforeバイトが先に処理した値の吸収結果を上書きして1本しか残らない不良になる
 * （実測。`applyCenterLineAbsorptionForValues`が同じ`temp`から1回のbefore/afterで全値をまとめて
 * 書くことで防ぐ）。
 * アクティブ以外の全Plane（検討・屋根含む）を**1平面につき1回**peekし、値ごとにこの位置の中心線
 * （区間・本数を問わずすべて。裁定Q2）を持つか調べる。**何も書かない**（peekのみ。書込みは
 * `applyCenterLineAbsorptionForValues`が移籍後に行う——他階の壁は自平面の中心線idを参照する側で
 * あり、その参照先（吸収される中心線）はこの時点ではまだ有効なため、ここでのpeek自体は移籍の
 * 前後どちらでも安全）。
 * 補助線・保護される梁芯はここでは扱わない（補助線は拒否、保護されない壁由来梁芯は
 * `absorbWallBeamAxesOnPromote`が別途吸収する——呼び出し側は`findFloorsWithCounterpartCL`に
 * `absorbCenter:true`を渡して中心線だけを相手から除外している前提で使うこと）。
 * @param {object} project
 * @param {PlanGraph} activeGraph  昇格・追加を実行する階のグラフ（アクティブ階）
 * @param {{centerLineType: string, values: number[]}} opts
 * @returns {Promise<Array<{plane: object, temp: object, absorbedIdsByValue: Map<number, string[]>}>>}
 *   吸収対象が1つも無い階は含めない。absorbedIdsByValueは吸収対象があった値だけのMap。
 */
export async function findCenterLinesToAbsorbForValues(project, activeGraph, { centerLineType, values }) {
  const targets = [];
  for (const plane of otherPlanes(project, activeGraph)) {
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    const absorbedIdsByValue = new Map();
    for (const value of values) {
      const ids = sameCoordCounterparts(temp, { centerLineType, value })
        .filter(isPromoteAbsorbedKind)
        .map(other => other.id);
      if (ids.length > 0) absorbedIdsByValue.set(value, ids);
    }
    if (absorbedIdsByValue.size === 0) continue;
    targets.push({ plane, temp, absorbedIdsByValue });
  }
  return targets;
}

/**
 * `findCenterLinesToAbsorbForValues`の値が1つの薄い包み（昇格`promoteCenterToGridWithUndo`専用。
 * 重複実装を避けるため本体は複数形に一本化した）。
 * @param {object} project
 * @param {PlanGraph} activeGraph
 * @param {CenterLine} cl 昇格前の中心線（まだ活性階に居る）
 * @returns {Promise<Array<{plane: object, temp: object, absorbedIds: string[]}>>}
 */
export async function findCenterLinesToAbsorbOnPromote(project, activeGraph, cl) {
  const targets = await findCenterLinesToAbsorbForValues(project, activeGraph, {
    centerLineType: cl.centerLineType, values: [cl.value],
  });
  return targets.map(({ plane, temp, absorbedIdsByValue }) => ({
    plane, temp, absorbedIds: absorbedIdsByValue.get(cl.value) ?? [],
  }));
}

/**
 * 置換後のsnapshotで、吸収により複数の中心線がclIdへ寄ったことに伴う参照の衝突を検査する
 * （QA所見2是正・裁定・2026-09-30）: `columnAxisOffsets`（柱芯オフセット）・`clEccentricities`
 * （CL偏芯）・`kneeDropWalls`（腰壁・垂れ壁。edgeKeyにclIdを含むもの）のいずれかで、clIdを指す
 * エントリが2件以上残っていれば、どちらの値を採るか黙って決めず衝突として拒否する
 * （`remapLineIdsInSnapshot`はこれらを配列・配列内オブジェクトとして保持するため、キー衝突として
 * は検出できない——実測: `columnAxisOffsetKeys`は`Array<string>`、`clEccentricities`・
 * `kneeDropWalls`は`Array<{clId|key, ...}>`であり、いずれもJSオブジェクトの「プロパティ名」として
 * clIdを使わないため、複数のvalsが同じclId/keyに集約されても重複エントリとして残るだけで例外には
 * ならない。graphSnapshot.js buildSnapshot参照）。
 * @param {object} snapshot 吸収後（remapLineIdsInSnapshot適用後）のsnapshot
 * @param {string} clId
 * @returns {boolean}
 */
function hasAbsorptionConflict(snapshot, clId) {
  const eccCount = (snapshot.clEccentricities ?? []).filter(e => e.clId === clId).length;
  if (eccCount >= 2) return true;
  const axisCount = (snapshot.columnAxisOffsetKeys ?? []).filter(k => k === clId).length;
  if (axisCount >= 2) return true;
  const kneeKeyCounts = new Map();
  for (const kw of snapshot.kneeDropWalls ?? []) {
    if (!kw.key.split(':').includes(clId)) continue;
    kneeKeyCounts.set(kw.key, (kneeKeyCounts.get(kw.key) ?? 0) + 1);
  }
  for (const count of kneeKeyCounts.values()) {
    if (count >= 2) return true;
  }
  return false;
}

/**
 * 昇格・通常追加（中心線→通り芯）の中心線吸収の本体（QA所見5是正・2026-09-30: **移籍後**に呼ぶ。
 * 線種変更の移籍一本化 ステップ6是正・2026-09-30: **平面単位**へまとめた——`findCenterLinesToAbsorbFor
 * Values`が集めたtargets（1平面につき1つの`temp`・値ごとの吸収対象idのMap）を受け取り、平面ごとに
 * 「1回のbefore→中心線を全部除く→全値のidを順にremap→衝突検査→事後条件→encode→1回保存」を行う——
 * 値ごとに独立してbefore/afterを作ると、後で処理した値の保存が先に処理した値の吸収結果を上書きして
 * 1本しか残らない不良になる（実測。旧`applyCenterLineAbsorptionOnPromote`を値1つの場合に限定した
 * 薄い包みとして残す）。
 * 吸収する中心線idへの参照（自身の`centerLines`エントリを含む）を、値ごとの通り芯id
 * （`gridIdByValue.get(value)`）へ一括置換する（線種変更の移籍一本化・裁定Q1。降格
 * `propagateDemotedCenterLine`の逆操作）。
 *
 * **移籍後（`applyPromoteToGrid`／`project.structGraph.addCenterLine`の後）に呼ぶこと**——
 * `propagateDemotedCenterLine`・`absorbWallBeamAxesOnPromote`とは逆の順序になる点に注意。他階の壁は
 * **自平面の中心線id**（吸収される側のid）を参照する側であり、通り芯idへの張り替えはこの吸収処理
 * 自身が行うため、移籍前に他階のafterバイトへ通り芯idを書き込んでしまうと、その時点でまだ通り芯が
 * `project.structGraph`に無く（共有グラフに実体が無い状態で他階のバイトだけがそのidを参照する）、
 * 万一その直後にタブが閉じられる／再読込みされると`resolveCL`がidを解決できず他階の壁・部屋が
 * 黙って消える（QA所見5実測）。
 *
 * 1平面につき、吸収する中心線（同じ値・複数値どちらも）が複数あるときは`lineIdRemap.js
 * remapLineIdsInSnapshot`を**1本ずつ順に**呼ぶ（同じ新idを複数の旧idへ同時に割り当てるMapは
 * 使えないため——`remapLineIdsInSnapshot`のidMapは新idの重複を許さない）。置換後は
 * `hasAbsorptionConflict`で参照の衝突（QA所見2）を値ごとに検査し、衝突していればその平面を
 * `conflictPlane`として返す（何も保存しない。呼び出し側がそこまでの`undoRecords`を
 * `rollbackFloorRecords`で巻き戻す）。
 * 例外は握りつぶさない（QA所見3是正: プログラム側の誤りまで「衝突トースト」にすり替えない。
 * `ERR_CL_CONVERT_SYNC_FAILED`（tagCLOpFailure経由）で扱う）。
 * 事後条件（吸収した中心線idがどこにも残っていない）は`findLineIdOccurrences`で検査し、
 * 違反したらthrowする（コード側のバグの安全網。`propagateDemotedCenterLine`と同型）。
 *
 * `columnAxisOffsets`等の吸収した中心線分のキーは削除しない——通り芯idのキーへ移る
 * （`remapLineIdsInSnapshot`の一括置換がそのまま行う）。
 * @param {Array<{plane: object, temp: object, absorbedIdsByValue: Map<number, string[]>}>} targets
 *   `findCenterLinesToAbsorbForValues`の戻り値
 * @param {Map<number, string>} gridIdByValue 値→昇格・追加後の通り芯id（`project.structGraph`に
 *   既に居ること前提）
 * @param {{undoRecords?: Array, saveFloorFn?: Function}} [opts]
 * @returns {Promise<{conflictPlane: object|null}>} conflictPlaneが非nullなら拒否（何も保存していない）
 */
export async function applyCenterLineAbsorptionForValues(targets, gridIdByValue, { undoRecords = [], saveFloorFn = saveFloor } = {}) {
  for (const { plane, temp, absorbedIdsByValue } of targets) {
    const before = serializeGraph(temp);
    // 吸収する中心線自身の centerLines エントリは先に除く（除かずに置換すると、その線自身の
    // idが通り芯idへ書き換わり、通り芯と同じidの「中心線」エントリが残ってしまう）。
    const allAbsorbedIds = [...absorbedIdsByValue.values()].flat();
    let snapshot = decodeFloorSnapshot(before);
    snapshot = { ...snapshot, centerLines: snapshot.centerLines.filter(c => !allAbsorbedIds.includes(c.id)) };
    for (const [value, absorbedIds] of absorbedIdsByValue) {
      const newId = gridIdByValue.get(value);
      for (const absorbedId of absorbedIds) {
        snapshot = remapLineIdsInSnapshot(snapshot, new Map([[absorbedId, newId]]));
      }
    }
    for (const value of absorbedIdsByValue.keys()) {
      if (hasAbsorptionConflict(snapshot, gridIdByValue.get(value))) {
        return { conflictPlane: plane };
      }
    }
    const leftover = findLineIdOccurrences(snapshot, allAbsorbedIds);
    if (leftover.length > 0) {
      throw new Error(`applyCenterLineAbsorptionForValues: ${plane.name} に中心線idの参照が残っています（${leftover.map(o => o.path).join(', ')}）`);
    }
    const after = encodeFloorSnapshot(snapshot);
    await saveFloorFn(plane.id, after);
    undoRecords.push({ planeId: plane.id, before, after });
  }
  return { conflictPlane: null };
}

/**
 * `applyCenterLineAbsorptionForValues`の値が1つの薄い包み（昇格`promoteCenterToGridWithUndo`専用。
 * 重複実装を避けるため本体は複数形に一本化した）。
 * @param {Array<{plane: object, temp: object, absorbedIds: string[]}>} targets
 *   `findCenterLinesToAbsorbOnPromote`の戻り値
 * @param {CenterLine} cl 昇格後の通り芯（`project.structGraph`に既に居ること前提）
 * @param {{undoRecords?: Array, saveFloorFn?: Function}} [opts]
 * @returns {Promise<{conflictPlane: object|null}>}
 */
export async function applyCenterLineAbsorptionOnPromote(targets, cl, opts = {}) {
  const wrapped = targets.map(({ plane, temp, absorbedIds }) => ({
    plane, temp, absorbedIdsByValue: new Map([[cl.value, absorbedIds]]),
  }));
  return applyCenterLineAbsorptionForValues(wrapped, new Map([[cl.value, cl.id]]), opts);
}

/**
 * demoteGridToCenterWithUndo・deleteCenterLineWithUndo・promoteCenterToGridWithUndo 専用の失敗時
 * ロールバック: 複製・伝播フェーズ（propagateDemotedCenterLine・detachOtherFloorsFromGridCenterLine・
 * applyOtherFloorsGridCenterLineAftermath・absorbWallBeamAxesOnPromote）の途中で例外が起きた場合、または
 * 直後の本体処理（applyDemoteToCenter等）がエラーを返した場合に、そこまでに saveFloorFn した階を
 * before バイトで書き戻す（best effort）。undoManager には触れない（呼び出し側がまだ undo エントリを
 * 積んでいない段階でのみ使う）。
 * **project を渡すと、対象階が現在アクティブならIDBではなく生きているgraphへ`restoreGraph`する**
 * （`applyFloorUndoRecords`と同じ分岐。n-1・QA指摘・2026-09-25: project省略時（従来どおりIDBのみ）は、
 * 伝播中に階が切り替わり、切り替え先の階が既に「detach後のバイト」で生きているgraphへ復元・保持
 * されていると、rollbackがIDBへ書き戻したbeforeバイトが後続の自動保存（auto-save）で上書きされ、
 * 壁だけがundoも効かずに消える——生きているgraphが保持する状態と、IDBに書く状態を一致させる必要が
 * ある）。降格側（propagateDemotedCenterLine失敗時）の既存呼び出しはprojectを渡さず据え置く
 * （挙動不変。将来同種の問題が実測されたら同様に直す）。
 * 逆順で書き戻す（線種変更の移籍一本化・2026-09-30）: `applyFloorUndoRecords`の'before'処理と同じ
 * 理由——同じ階（planeId）が records に複数回現れうる（promoteCenterToGridWithUndoが
 * absorbWallBeamAxesOnPromote・applyCenterLineAbsorptionOnPromoteの両方の記録を同じfloorRecordsへ積む
 * ため、1つの平面に両方の吸収が起きた場合に該当する）。記録された順に書き戻すと、後で起きた
 * 変更のbefore（＝先に起きた変更の後の状態）が先に起きた変更のbefore（＝真の元の状態）を上書き
 * してしまう。単一階が1回しか現れない既存の呼び出し（削除・降格・単独の吸収失敗）では順序は
 * 結果に影響しないため、挙動不変のまま安全に適用できる。
 * @param {Array<{planeId, before}>} records
 * @param {Function} [saveFloorFn]
 * @param {object} [project] - 省略時は従来どおりIDB（saveFloorFn）のみで書き戻す。
 */
export async function rollbackFloorRecords(records, saveFloorFn = saveFloor, project = undefined) {
  for (const rec of [...records].reverse()) {
    if (project?.activePlane?.id === rec.planeId) {
      try { restoreGraph(project.activeGraph, rec.before); } catch (err) { console.error(err); }
      continue;
    }
    try { await saveFloorFn(rec.planeId, rec.before); } catch (err) { console.error(err); }
  }
}
