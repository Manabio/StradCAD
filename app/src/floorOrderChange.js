// 「階の並びが変わった」1つの出来事の唯一の入口。App.jsx はこれを1回呼ぶだけにする。追従処理
// （階段吹抜けの整合・昇降機の複製と再採番・外壁内側の部屋の自動追加・直下階の階段削除・新階への
// 切替・全階の構造反映）は登録制のレジストリ（floorOrderFollowers）にまとめる。階段や昇降機の
// 仕様が今後変わっても、登録先の follower だけ直せば挿入・下階追加・削除・ドラッグ移動・階変更の
// 全経路に効く（modeBoundaries レジストリと同型。途中階の上階追加と階移動の振り直し一本化
// ステップ3・4）。
//
// node:test から単体 import できるよう、react-konva / store.js / snap.js / .jsx を静的に引かない
// （抽出した純モジュールの不変条件。team-lessons「抽出モジュールはreact-konva/store.js/snap.js/.jsx
// を静的に引かないこと」）。階段・昇降機のモジュールは App.jsx と同じく動的 import にする
// （それらは .jsx 等を静的に引く可能性があるため）。mobx・graphSnapshot.js・storage/db.js・
// storage/FloorSwapManager.js・structuralOrchestration.js・floorNumber.js は floorOps.js が
// 既に静的 import しており node:test から import できるため、ここでも静的 import する
// （動的 import にしても App.jsx から既に静的に束ねられ、コード分割の効果が無いため。ビルド時の
// INEFFECTIVE_DYNAMIC_IMPORT 警告で判明）。
import { runInAction } from 'mobx';
import { serializeGraph } from './graphSnapshot.js';
import { saveFloor } from './storage/db.js';
import { floorSwapManager } from './storage/FloorSwapManager.js';
import { refreshWallsAllFloors } from './wallRefresh.js';
import { applyFloorInsert, applyPlaneMetas } from './floorOps.js';
import { reflectStructuralAfterFloorAdd } from './structural/structuralOrchestration.js';
import { followRoofPlaneToTop } from './structural/roofPlane.js';
import { carryMainRoofToNewTop } from './finish/roof/mainRoofFloorSync.js';
import { makeFloorName } from './floorNumber.js';
import { ERR_ELEVATOR_COPY_SKIPPED } from './error.js';
import {
  stairRiserKey, stairItemsOfGraph, stairRiserChanges, floorHeightAboveIn,
} from './finish/stair/stairRiserFollow.js';

// 階操作の種類。'reorder'（ドラッグ移動）・'change'（階変更）も、挿入・削除と同じく
// applyFloorOrderChange 経由で関門・undo・追従処理を伴う（Q1裁定・途中階の上階追加と階移動の
// 振り直し一本化 ステップ4）。
export const FLOOR_ORDER_KIND = Object.freeze({
  INSERT: 'insert',
  ADD_LOWER: 'addLower',
  DELETE: 'delete',
  REORDER: 'reorder',
  CHANGE: 'change',
  // 階設定表の確定（階高・GL の変更。階の並びは不変で elevation と最上階の階高だけが変わる。S4）
  HEIGHTS: 'heights',
});

// below（直下の採用階）の階段をすべて削除する。アクティブ階はライブグラフ、非アクティブ階は
// peekして保存する（App.jsx removeStairsOnFloor をここへ移した。runDeleteFloorからだけ呼ばれていた）。
// 消し方は正規の削除経路 removeStairOnFloor（ペア部屋の未定義化・階段下の分割CL・外部仕上げ行まで。
// ユーザー裁定2026-10-06 Q3）。階段の上の階の吹抜けは、続く stairVoidReconcile が孤児として未定義化する。
// io（テスト注入用。既定は本番の peek／saveFloor）。
async function removeStairsOnPlane(project, plane, {
  peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
  saveFloorFn = saveFloor,
} = {}) {
  const isActive = plane.id === project.activePlaneId;
  const g = isActive ? project.activeGraph : await peekFn(plane);
  if (g.stairs.length === 0) return;
  const { removeStairOnFloor } = await import('./finish/stair/stairRemoval.js');
  runInAction(() => { for (const s of [...g.stairs]) removeStairOnFloor(g, s); });
  if (!isActive) await saveFloorFn(plane.id, serializeGraph(g)); // アクティブ階は auto-save に委ねる
}

// 階設定表の確定（HEIGHTS）で階高（floorHeightAbove）が変わった階の階段の蹴上を追従させる。
// 確定前の elevation は before フックで採った ctx.state.elevationsBefore、確定後は ctx.project.planes。
// 階高が変わった階だけを（アクティブ階はライブ、他階は 1 階 1 回 peek→全変更→1 回保存で）処理する。
// 明示 riser を持つ階段は総段数を保ったまま新しい階高÷総段数に書き換える（裁定 2026-10-20）。明示の無い階段は
// riserOf が自動で追従するので書かず、通知・印の対象にだけ入れる。undo はここでは積まない（withFloorOpUndo の全階バイト列）。
async function followStairRisers(ctx) {
  const before = ctx.state.elevationsBefore;
  if (!before || ctx.updates.length === 0) return;
  const { project } = ctx;
  const after = project.planes.map(p => ({ id: p.id, elevation: p.elevation }));
  const labels = new Map((ctx.stairItems ?? []).map(i => [stairRiserKey(i.planeId, i.stairId), i.label]));
  const {
    peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
    saveFloorFn = saveFloor,
  } = ctx.floorIo ?? {};
  const all = [];
  for (const plane of project.planes) {
    if (floorHeightAboveIn(before, plane.id) === floorHeightAboveIn(after, plane.id)) continue;
    const isActive = plane.id === project.activePlaneId;
    const g = isActive ? project.activeGraph : await peekFn(plane);
    if (!g) continue;
    const items = stairItemsOfGraph(plane.id, g).map(i => ({ ...i, label: labels.get(stairRiserKey(i.planeId, i.stairId)) }));
    const changes = stairRiserChanges(items, before, after);
    if (changes.length === 0) continue;
    const rewrites = changes.filter(c => c.explicit);
    runInAction(() => { for (const c of rewrites) g.stairMap.get(c.stairId).setField('riser', c.to); });
    if (!isActive && rewrites.length > 0) await saveFloorFn(plane.id, serializeGraph(g)); // アクティブ階は auto-save に委ねる
    all.push(...changes);
  }
  // 通知と印は全追従の成功後（呼び出し側が applyFloorOrderChange の戻り値 riserChanges で行う）。
  // ここで出すと後段（wallRefresh 等）の失敗で巻き戻ってもトーストと印が残る。
  ctx.state.riserChanges = all;
}

// 追従処理のレジストリ（登録順＝実行順）。各 follower は { name, appliesTo, before?(ctx), run(ctx) }。
// delete は旧 runDeleteFloor の順序（下階の階段削除 → 振り直し → 昇降機の再採番。再採番は
// HEADどおり後始末の最後に置く——throwしても他の後始末は完了済みにする意図を保つため、delete専用の
// elevatorRenumber を構造反映の後ろへ登録する）、insert は旧 executeAddUpper/'general' の順序
// （階段吹抜けの整合 → 昇降機の複製 → 外壁内側の部屋）を、appliesTo の違い（roofPlaneHeightは全種別・
// elevatorCopyはinsertのみ・elevatorRenumberはdeleteのみ・stairsBelowRemovalはdeleteのみ・
// exteriorRoomはinsertのみ・stairVoidReconcile／structuralReflectは
// insert/addLower/delete/reorder/change）で同じ配列に両立させている（リード指示・F5裁定・
// 2026-10-01。reorder/changeはステップ4でQ1裁定。階段は上階へ実体を自動設置せず、設置階の直上1階に
// 吹抜けだけを置く方式＝2026-10-06 裁定。stairVoidReconcile は stairsBelowRemoval の後・
// structuralReflect の前）。
export const floorOrderFollowers = [
  {
    // 屋根平面の高さは最上階に従属する（最上階 id が同じでも、振り直しで高さ・階番号だけ動くことが
    // ある。§5-8）。structuralReflect が屋根平面を読む前に高さを合わせておく必要があるため先頭に
    // 置く。followRoofPlaneToTop は最上階idが同じときだけ書き換え、idが変わった（最上階そのものが
    // 入れ替わった）ときは何もしない——作り直し（削除→新設）はここで行わない（syncRoofPlaneは呼ば
    // ない）。理由: 屋根平面はPlaneメタのundo記録（collectPlaneMetas）・バイト列のundo記録
    // （collectFloorBytes）のいずれも対象外（project.planesのみを見る）のため、階操作の時点で
    // 作り直すとundoで旧屋根平面が戻らず、新しい屋根平面が削除済みの階を指したまま残る
    // （QA指摘・2026-10-01再裁定）。作り直しは次の構造モード突入のsyncRoofPlaneに任せる。
    // 屋根平面が無いプロジェクトでは（構造モードに入ったことが無い）followRoofPlaneToTopが
    // 何もせずfalseを返すので、ここでも何も起きない。
    name: 'roofPlaneHeight',
    appliesTo: [
      FLOOR_ORDER_KIND.INSERT, FLOOR_ORDER_KIND.ADD_LOWER, FLOOR_ORDER_KIND.DELETE,
      FLOOR_ORDER_KIND.REORDER, FLOOR_ORDER_KIND.CHANGE, FLOOR_ORDER_KIND.HEIGHTS,
    ],
    run(ctx) {
      runInAction(() => followRoofPlaneToTop(ctx.project));
    },
  },
  {
    name: 'stairsBelowRemoval',
    appliesTo: [FLOOR_ORDER_KIND.DELETE],
    async run(ctx) {
      if (!ctx.below) return;
      await removeStairsOnPlane(ctx.project, ctx.below, ctx.floorIo);
      const belowAlts = [...ctx.project.planeMap.values()]
        .filter(p => p.isAlternative && p.referenceId === ctx.below.id);
      for (const alt of belowAlts) await removeStairsOnPlane(ctx.project, alt, ctx.floorIo);
    },
  },
  {
    // 階の並びが変わった後、採用階の隣り合う全ペアで階段吹抜け（STAIR_VOID）を整合する（挿入で
    // 行き先が変わった階・並替え／階変更で直下階が変わった階・削除で直下階の階段が消えた階の孤児の
    // 吹抜けの未定義化）。階段そのものは触らない（行き先が変わるだけ。段数は保つ＝再計算しない）。
    // 削除で直下階の階段を消す stairsBelowRemoval の後に置く（消してから整合を取る）。structuralReflect
    // の前＝壁・梁芯の再計算が整合後の吹抜けを読む。
    name: 'stairVoidReconcile',
    appliesTo: [
      FLOOR_ORDER_KIND.INSERT, FLOOR_ORDER_KIND.ADD_LOWER, FLOOR_ORDER_KIND.DELETE,
      FLOOR_ORDER_KIND.REORDER, FLOOR_ORDER_KIND.CHANGE,
    ],
    async run(ctx) {
      const { reconcileAllStairVoids } = await import('./finish/stair/stairFloorSync.js');
      await reconcileAllStairVoids(ctx.project, ctx.floorIo);
    },
  },
  {
    name: 'elevatorCopy',
    appliesTo: [FLOOR_ORDER_KIND.INSERT],
    async run(ctx) {
      const { copyElevatorsToNewFloor } = await import('./finish/equipment/equipmentFloorSync.js');
      const copied = await copyElevatorsToNewFloor({ project: ctx.project, activeGraph: ctx.sourceGraph, newPlane: ctx.addedPlane });
      if (copied.status === 'copied' && copied.skipped.length > 0) {
        ctx.ui.notify(ERR_ELEVATOR_COPY_SKIPPED(ctx.addedPlane.name, copied.skipped.length));
      }
    },
  },
  {
    name: 'exteriorRoom',
    appliesTo: [FLOOR_ORDER_KIND.INSERT],
    async run(ctx) {
      if (!ctx.sourceGraph.walls.some(w => w.isExteriorWall)) return;
      const { addNewFloorRoomFromSource } = await import('./finish/stair/stairFloorSync.js');
      await addNewFloorRoomFromSource(ctx.project, ctx.sourceGraph, ctx.addedPlane, makeFloorName(ctx.newStartFloor, 1));
    },
  },
  {
    // 上に階を追加して最上階が入れ替わったとき、旧最上階の主屋根の値を新しい最上階へ写す（B3・ユーザー裁定
    // 2026-10-02）。INSERT のみ（ADD_LOWER＝下への追加・DELETE・REORDER・CHANGE では写さず、新しい最上階が
    // 自分の値を使う）。途中階への追加は追加した階が最上階にならないので carryMainRoofToNewTop が何もしない。
    // 新階への書込みなので階の切替（switchToAddedFloor）より前に置く。
    name: 'mainRoofCarry',
    appliesTo: [FLOOR_ORDER_KIND.INSERT],
    async run(ctx) {
      await carryMainRoofToNewTop(ctx.project, ctx.addedPlane);
    },
  },
  {
    name: 'switchToAddedFloor',
    appliesTo: [FLOOR_ORDER_KIND.INSERT, FLOOR_ORDER_KIND.ADD_LOWER],
    async run(ctx) {
      // addPlane()がplaneを返さなかった（'lower'のn=0等、到達しない想定のケース）場合は
      // targetPlaneIdがnullのまま——何もせずtrueを返す（switchFloor(null)を呼んでthrowさせない）。
      if (!ctx.targetPlaneId) return true;
      return await ctx.ui.switchFloor(ctx.targetPlaneId);
    },
  },
  {
    // 階設定表の確定（HEIGHTS）だけの追従。階高が変わった階の階段の蹴上を書き換える（followStairRisers）。
    // wallRefresh より前に置く——蹴上は壁の鮮度キーの入力（fh と階段の riser）で、書き換えた後の値で壁を作り直す。
    // 確定前の elevation は before フック（階の更新を適用する前）で採る。
    name: 'stairRiserFollow',
    appliesTo: [FLOOR_ORDER_KIND.HEIGHTS],
    before(ctx) {
      ctx.state.elevationsBefore = ctx.project.planes.map(p => ({ id: p.id, elevation: p.elevation }));
    },
    async run(ctx) {
      await followStairRisers(ctx);
    },
  },
  {
    // 階設定表の確定（HEIGHTS）だけの追従。階高が変わると壁の鮮度キー（fh＝floorHeightAbove）が変わる階
    // （階高を変えた階）の壁を作り直す。鍵が一致する階は peek 以外何もしない（発火条件＝鍵不一致のみ）。
    // 階の追加・削除・並べ替えには足さない（それらは階高を保ち、鍵の入力が変わらない・または変わる階は
    // 次の境界の鮮度判定に任せる従来どおり）。undo はここでは積まない（withFloorOpUndo が全階のバイト列で
    // 1エントリにする）。他階の処理が自階を peek するため、自階は他階の前に IDB へ書く
    // （refreshWallsAllFloors の saveActiveFloorFn）。仕上げモード中の自階は skipActiveWalls で外す
    // （仕上げ脱出の全再生成に任せる）。壁が変わった階があれば refreshWallsAllFloors が自階→他階の
    // 構造再計算まで行うので、直後の structuralReflect は印（ctx.state.structuralReflected）で省く。
    name: 'wallRefresh',
    appliesTo: [FLOOR_ORDER_KIND.HEIGHTS],
    async run(ctx) {
      // 発火条件＝階高が実際に変わったこと（updates が空＝GL だけの変更・変化なしは、壁にも構造にも影響しない）。
      // 構造反映も要らないので、印（反映済み扱い）を立てて structuralReflect も省く。
      if (ctx.updates.length === 0) { ctx.state.structuralReflected = true; return; }
      const io = ctx.floorIo ?? {};
      // 仕上げモード中（自階の壁は再生成しない）でも、直上階の再生成・構造反映が自階を peek するので、
      // 他階の処理の前に自階を IDB へ書く（仕上げ脱出 finishBoundary.js・構造脱出と同じ保存。
      // 保存は serializeGraph→saveFloor で、未保存文書の意味（dirty）は変えない）。
      if (ctx.skipActiveWalls && ctx.project.activeGraph) {
        await (io.saveFloorFn ?? saveFloor)(ctx.project.activePlaneId, serializeGraph(ctx.project.activeGraph));
      }
      const { changedPlaneIds } = await refreshWallsAllFloors(ctx.project, {
        skipActive: !!ctx.skipActiveWalls,
        pushUndo: false, pushActiveStructuralUndo: false,
        saveActiveFloorFn: io.saveFloorFn ?? saveFloor,
        ...(io.peekFn ? { peek: (p, sg) => io.peekFn(p, sg) } : {}),
        ...(io.saveFloorFn ? { saveFloorFn: io.saveFloorFn } : {}),
        ...(io.loadMaterialMapFn ? { loadMaterialMapFn: io.loadMaterialMapFn } : {}),
      });
      ctx.state.structuralReflected = changedPlaneIds.length > 0;
    },
  },
  {
    name: 'structuralReflect',
    // delete への構造反映は現状（HEAD）には無い追加挙動——指示書§4.3「階の並びが変わった後の
    // 追従処理」に全階の構造反映が含まれ、Q1の根拠「1つ下の階の壁に依存する梁芯」は削除でも
    // 成り立つため、2026-10-01 にリード裁定で追加した（途中階の上階追加と階移動の振り直し
    // 一本化 ステップ3）。reorder（ドラッグ移動）・change（階変更）も同じ根拠（移動後は「1つ下の
    // 階の壁」が変わりうる・階変更は部材番号の階表記が変わる）で追加した（ステップ4・Q1裁定）。
    appliesTo: [
      FLOOR_ORDER_KIND.INSERT, FLOOR_ORDER_KIND.ADD_LOWER, FLOOR_ORDER_KIND.DELETE,
      FLOOR_ORDER_KIND.REORDER, FLOOR_ORDER_KIND.CHANGE, FLOOR_ORDER_KIND.HEIGHTS,
    ],
    async run(ctx) {
      // HEIGHTS: 直前の wallRefresh が壁を作り直した（＝構造も再計算済み）なら二重にしない。
      if (ctx.state.structuralReflected) return;
      await reflectStructuralAfterFloorAdd(ctx.project);
    },
  },
  {
    name: 'elevatorRenumber',
    appliesTo: [FLOOR_ORDER_KIND.DELETE],
    // 削除前に消える階の器具idを読む（削除した後に遅延チャンクの取得を挟まないよう、
    // removeFloorより前に済ませる。既存 runDeleteFloor のコメントを踏襲）。
    async before(ctx) {
      const { readFloorEquipmentIds } = await import('./finish/equipment/equipmentFloorSync.js');
      ctx.state.removedEquipmentIds = await readFloorEquipmentIds(ctx.project, ctx.removedPlane);
    },
    // 昇降機の再採番は既存の後始末（階段削除・振り直し・構造反映）がすべて終わった後に行う——
    // ここで例外が出ても階削除自体の後始末は完了済みにする（HEAD runDeleteFloor のコメントを踏襲。
    // F5裁定・2026-10-01）。
    async run(ctx) {
      const { renumberEquipmentAfterFloorRemoval } = await import('./finish/equipment/equipmentFloorSync.js');
      const renumbered = await renumberEquipmentAfterFloorRemoval({
        project: ctx.project, activeGraph: ctx.project.activeGraph, removedIds: ctx.state.removedEquipmentIds,
      });
      if (renumbered.status === 'renumbered') ctx.ui.onFloorSyncChanged();
    },
  },
];

/**
 * 「階の並びが変わった」1つの出来事を適用する唯一の入口。
 * @param {object} project
 * @param {object} opts
 * @param {string} opts.kind - FLOOR_ORDER_KIND のいずれか
 * @param {Array<{id:string,name:string,startFloor:number,elevation:number}>} opts.updates - 振り直しの更新一覧
 * @param {() => {plane:object}} [opts.addPlane] - 新階を追加する同期関数（insertはaddFloor 1回、
 *   addLowerはn回ループして最も下のplaneを返す）
 * @param {() => Promise<void>} [opts.removePlane] - 階を削除する非同期関数
 * @param {object} [opts.sourceGraph] - 複製元（表示中）のグラフ。insert系の追従処理が使う
 * @param {number} [opts.newStartFloor] - 新階のstartFloor。insert系の追従処理が使う
 * @param {object} [opts.removedPlane] - 削除対象のPlane。deleteの追従処理が使う
 * @param {object|null} [opts.below] - 削除対象の直下の採用階。deleteの追従処理が使う
 * @param {{notify:(msg:string)=>void, switchFloor:(planeId:string)=>Promise<boolean>, onFloorSyncChanged:()=>void}} opts.ui
 * @param {{peekFn?:Function, saveFloorFn?:Function}} [opts.floorIo] - 他階の peek／保存の差し替え（テスト注入用。
 *   省略時は本番の floorSwapManager.peek／saveFloor。階段の削除・吹抜けの整合の follower が使う）
 * @param {boolean} [opts.skipActiveWalls] - HEIGHTS の壁の再生成で自階を除く（仕上げモード中。仕上げ脱出の
 *   全再生成に任せる）。floorIo の peekFn／saveFloorFn／loadMaterialMapFn は wallRefresh follower も使う
 * @param {Array<{planeId:string, stairId:string, label:string}>} [opts.stairItems] - HEIGHTS の蹴上追従のトースト用の
 *   階段の表示名（階設定表を開くときに集めたもの。無ければ「階段」）。書き換えの判定には使わない（graph から再導出する）
 * @param {Array} [followers] - 既定 floorOrderFollowers（テスト用に差し替え可能）
 * @returns {Promise<{addedPlane:object|null, halted:boolean, riserChanges:Array}>} riserChanges＝HEIGHTS で蹴上が変わった
 *   階段の一覧（stairRiserChanges の形）。通知・印は呼び出し側が成功後に行う（announceRiserChanges）
 */
export async function applyFloorOrderChange(project, opts, followers = floorOrderFollowers) {
  const { kind, updates, addPlane, removePlane, sourceGraph, newStartFloor, removedPlane, below, ui, floorIo, skipActiveWalls, stairItems } = opts;
  const ctx = {
    project, kind, updates, sourceGraph, newStartFloor, removedPlane, below, ui, floorIo, skipActiveWalls, stairItems,
    addedPlane: null, targetPlaneId: null, state: {},
  };

  const applicable = followers.filter(f => f.appliesTo.includes(kind));

  for (const f of applicable) {
    if (f.before) await f.before(ctx);
  }

  if (addPlane) {
    const { plane } = applyFloorInsert(project, updates, addPlane);
    // addPlane()がplaneを返さなかった（'lower'のn=0等、到達しない想定のケース）場合は
    // addedPlane/targetPlaneIdをnullのままにする（switchToAddedFloor側でthrowさせない）。
    if (plane) {
      ctx.addedPlane = plane;
      ctx.targetPlaneId = plane.id;
    }
  } else if (removePlane) {
    await removePlane();
    applyPlaneMetas(project, updates);
  } else {
    applyPlaneMetas(project, updates);
  }

  let halted = false;
  for (const f of applicable) {
    const result = await f.run(ctx);
    if (result === false) { halted = true; break; }
  }

  return { addedPlane: ctx.addedPlane, halted, riserChanges: ctx.state.riserChanges ?? [] };
}
