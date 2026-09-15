// 仕上げモードの突入・脱出境界処理。App.jsx から状態を持たない純粋な形へ抽出したもの
// （挙動は元コードのまま）。React state は一切触らない（事前調査済み）——undo登録・graph変更のみ。
// fmode（modeRef.current＝FinishModeState）は呼び出し側（App.jsx）から引数で受ける。
import { runInAction } from 'mobx';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { resolveStairContext } from './stair/stairUnderRooms.js';
import { snapshotEdges, restoreEdges, syncEdgesFromTopology, interiorWallSpans, buildCellToRoom } from './edgeClassify.js';
import {
  reinterpretRoomsOnEntry, ensureStairRooms, normalizePartialDominance,
  snapshotRoomsState, restoreRoomsState,
} from './roomReinterpret.js';
import { kneeDropWallGeometry } from './kneeDropWall.js';
import { reflectStructuralAfterFinishExit } from '../structural/structuralOrchestration.js';
import { conformWoodBacking } from '../structural/woodAutoFill.js';
import { regenerateWalls, loadMaterialMap } from './wallRegeneration.js';
import { wallFreshnessKey } from './wallFreshnessKey.js';
import { wallBackingCenters, mapBackingCenterMoves } from '../structural/wallBeamAxes.js';
import { followWallBeamAxes } from '../structural/wallBeamAxisFollow.js';
import { refreshWallsAllFloors } from '../wallRefresh.js';
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

  // 在来木造: 共通仕様の壁下地材を柱同寸×30へ自動選択する（structural/woodAutoFill.js。壁の生成が
  // この per-floor 設定から壁厚を決めるため、退出時の壁生成より前＝突入時に揃える）。ここが唯一の
  // 呼び出し元——壁は脱出時にしか再生成されないため、他の経路（構造再計算）で下地材だけ変えると
  // 壁厚とズレる。既存文書の旧厚の壁も、この階が仕上げモードを一度通れば脱出時に新厚で作り直される。
  // 自動導出のため undo では元のコードへ戻す（下の entryUndoFns）。
  const backingChanges = runInAction(() => conformWoodBacking(graph, project));
  if (backingChanges.length > 0) {
    const setter = f => (f === 'exteriorWallBacking' ? 'setExteriorWallBacking' : 'setInteriorWallBacking');
    entryUndoFns.push(() => { for (const c of backingChanges) graph[setter(c.field)](c.from); });
    entryRedoFns.push(() => { for (const c of backingChanges) graph[setter(c.field)](c.to); });
  }

  const roomsBefore = snapshotRoomsState(graph);
  const stairRoomChanges = [];
  runInAction(() => {
    reinterpretRoomsOnEntry(graph);
    // 再解釈（CL変更起因の部分指定化）で部分指定が親の残余より大きくなりうるため正規化する
    normalizePartialDominance(graph);
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
  // （コード分割維持。materialData.js のヘッダコメント参照。loadMaterialMap は
  // wallRegeneration.js に寄せた同じ構築の共有先）。ensureTopStairVoid と同格の
  // 自動同期のため undo 対象外。
  const [{ pullCLEccentricities }, pullMaterialMap] = await Promise.all([
    import('./eccentricityFloorSync.js'),
    loadMaterialMap(),
  ]);
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

  // 壁の再生成（内周壁・階段下壁・外壁の全削除→再生成、突き当たり処理）は
  // finish/wallRegeneration.js の regenerateWalls へ純粋なコード移動済み（挙動不変。
  // 壁の再生成をFinishModeStateから独立させる計画のステップ1）。materialMap が無ければ
  // （fmode が null。モード切替中で材ロードがまだ完了していない等の一時的な状態）壁を
  // 一切触らず、ステップ4・4b・5・構造反映は従来どおり実行する（これらは Room/Edge の
  // トポロジーが対象で、壁の実材寸法には依存しないため）。
  //
  // stairUnderEntries・extraStairOpenings は finish/stair/stairUnderRooms.js の
  // resolveStairContext（wallRefresh.js の全階sweep・scripts/probe/dumpPlanRegen.mjs と
  // 同じ単一ソース）で解決する。直下階は FinishModeState._loadLowerStairs が突入時に既に
  // peek 済みのキャッシュ（fmode._lowerGraph）を「peek相当」として注入し、実IDBの再peekを
  // 避ける（壁の再生成をFinishModeStateから独立させる計画のステップ4）。ただしキャッシュは
  // 「自階の直下階」専用（_loadLowerStairsが自階基準で1回だけ埋める）ため、resolveStairContext
  // が要求するplaneと一致する場合だけ使う——一致しない（キャッシュ無し・別階を指す等）ときは
  // 実peekへフォールバックする（QA V1回帰: フォールバック無しだとキャッシュnullやplane不一致の
  // ときstairUnderEntries/extraStairOpeningsが欠落し壁が変わって無通知になる）。
  const peekLowerGraph = async (plane, structGraph) =>
    (fmode?._lowerGraph?.plane?.id === plane.id ? fmode._lowerGraph : await floorSwapManager.peek(plane, structGraph));
  const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(graph, project, peekLowerGraph);

  const wallKeyBefore = graph.wallFreshnessKey;
  // 壁再生成で下地帯の中心が動いたとき（下地材コード変更で壁厚が変わる等）、壁由来の梁芯CL
  // （discipline:fuse）を追従させるための「動く前」の下地帯中心（壁の再生成をFinishModeStateから
  // 独立させる計画のステップ2。structural/wallBeamAxes.js wallBackingCenters）。
  const backingCentersBefore = wallBackingCenters(graph);
  const { regenerated, undoFns: wallUndoFns, redoFns: wallRedoFns } = await regenerateWalls(graph, {
    materialMap: fmode?.materialMap,
    stairUnderEntries,
    extraStairOpenings,
  });
  undoFns.push(...wallUndoFns);
  redoFns.push(...wallRedoFns);
  // 壁再生成の直後に鮮度キーを書く（ステップ1では鍵の計算・保存のみで、比較・再生成起動は
  // 行わない＝挙動ゼロ変化）。ゲートは regenerateWalls が返す regenerated だけを見る——
  // fmode の有無で判定すると「fmode は生きているが materialMap 未ロード」で regenerated:false
  // なのに鍵だけ書き換わり、壁の undo/redo と無関係な undo エントリが増えてしまう（QA F1・F4）。
  // 鍵の前後値は壁の undo/redo と同じ undoFns/redoFns（＝この境界処理で単一の undoManager.push
  // にまとめられるエントリ）に含める——undo で壁が旧に戻るときは鍵も必ず同じ回で旧に戻る。
  if (regenerated) {
    const wallKeyAfter = wallFreshnessKey(graph, project);
    graph.setWallFreshnessKey(wallKeyAfter);
    if (wallKeyAfter !== wallKeyBefore) {
      undoFns.push(() => graph.setWallFreshnessKey(wallKeyBefore));
      redoFns.push(() => graph.setWallFreshnessKey(wallKeyAfter));
    }

    // 壁由来梁芯の追従（ステップ2）。下地材コードを変えない脱出は下地帯中心が動かないため
    // moves が空になり no-op（golden-regenのmismatch 0を崩さない）。対応先の壁が無くなった
    // 孤児梁芯は撤去しない（2026-09-15裁定）——mapBackingCenterMoves が対応づけないだけで、
    // followWallBeamAxes 側もそれらには一切触れない。undo/redo は壁の undo/redo と同じ
    // undoFns/redoFns（単一の undoManager.push にまとめられるエントリ）へ連結する。
    const backingCentersAfter = wallBackingCenters(graph);
    const backingMoves = mapBackingCenterMoves(backingCentersBefore, backingCentersAfter);
    if (backingMoves.length > 0) {
      // moved/skipped（何が追従し、何が重複でスキップされたか）はここでは意図的に無視する——
      // 単体テスト用の観測点であり、孤児梁芯は撤去しない裁定（2026-09-15）のためトースト等の
      // 通知は不要（skipped も「元の梁芯を壊さず据え置いた」だけで、ユーザー操作の失敗ではない）。
      const { undoFns: axisUndoFns, redoFns: axisRedoFns } = followWallBeamAxes(graph, backingMoves);
      undoFns.push(...axisUndoFns);
      redoFns.push(...axisRedoFns);
    }
  }

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
      const applyFields = (id, f) => runInAction(() => {
        const w = graph.shapeMap.get(id);
        if (!w) return;
        w.axisOffset = f.axisOffset; w.wallFinish = f.wallFinish;
        w.backingOffset = f.backingOffset; w.backingDepth = f.backingDepth;
        w.finishSide = f.finishSide; w.startOffset = f.startOffset; w.endOffset = f.endOffset;
      });
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

  // 自階は上のステップ1〜3で既に処理済みのため対象外（skipActive）。仕上げモードを開かずに
  // 他階の主構造・階別構造・下地材コードが変わっていた場合に備え、鍵不一致の他階だけ壁を
  // 作り直す（壁の再生成をFinishModeStateから独立させる計画のステップ4）。undo対象外
  // （pushUndo:false。recomputeInactiveStructuralと同じ「他階を書き換える経路は undo 対象外」割り切り）。
  await refreshWallsAllFloors(project, { skipActive: true, pushUndo: false });
}
