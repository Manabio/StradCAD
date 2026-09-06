import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { runInAction, reaction } from 'mobx';
import { undoManager } from './undoManager.js';
import { serializeGraph, restoreGraph } from './graphSnapshot.js';
import { Stage } from 'react-konva';
import { useStore, addFloor, switchFloor, addAlternativeFloor, removeFloor, resetAll, bootReady, exportDocument, importDocument } from './store.js';
import { isDirty, markDirty } from './dirtyState.js';
import { viewport } from './appViewport.js';
import {
  findBracketingCLs,
  findNearbyCenterLines,
  overhangMm,
  SNAP_THRESHOLD_PX,
} from './snap.js';
import { OpeningPanel } from './openings/OpeningPanel.jsx';
import { placeOpeningWithDefaults, removeOpeningWithUndo } from './openings/openingEdit.js';
import { collectFloorOpeningGroups, assignOpeningNumbers, applyOpeningTags, renumberOpenings, openingSignature } from './openings/openingNumbering.js';
import { usePointerInteraction } from './interaction/usePointerInteraction.js';
import { RoomNameInput }   from './finish/RoomNameInput.jsx';
import { FinishSidebar }   from './finish/FinishSidebar.jsx';
import { FinishHalfModal } from './finish/FinishHalfModal.jsx';
import { floorHeightAbove } from './finish/stair/stairDimensions.js';
import { buildStairEntries, buildUpperStairPeekEntries } from './finish/stair/stairEntries.js';
import { shouldShowPlanFigure } from './renderer/planFigureVisibility.js';
import { slabOpeningRects, slabOpeningFrames, slabOpeningEdges } from './finish/stair/slabOpening.js';
import { runFinishEntryBoundary, runFinishExitBoundary } from './finish/finishBoundary.js';
import { computeVoidCrosses } from './finish/voidGeometry.js';
import { MemberStatusMenu } from './ui/MemberStatusMenu.jsx';
import { CenterLineType, OpeningCategory, centerLineKind } from '@core';
import { addSkipZero, subtractSkipZero, makeFloorName, renameFloor } from './floorNumber.js';
import {
  floorBytesEqual, applyFloorBytes, isActiveAnAltOf,
  computeFloorReorder, computeAltReorder, resolveChipReorderTarget, computeFloorChangeReorder,
} from './floorOps.js';
import { AddFloorDialog } from './ui/AddFloorDialog.jsx';
import { buildFloorChipModel } from './ui/floorChipModel.js';
import { ConfirmDialog } from './ui/ConfirmDialog.jsx';
import { FloorChangeDialog } from './ui/FloorChangeDialog.jsx';
import { LongPressIndicator } from './renderer/LongPressIndicator.jsx';
import { CLMoveInput } from './renderer/CLMoveInput.jsx';
import { AxisFaceInput }     from './renderer/AxisFaceInput.jsx';
import { RadialMenu }     from './ui/RadialMenu.jsx';
import { AddCLDialog }    from './ui/AddCLDialog.jsx';
import { WallDialog }          from './ui/WallDialog.jsx';
import { CalibrationDialog }  from './ui/CalibrationDialog.jsx';
import { SiteDialog }          from './ui/SiteDialog.jsx';
import { BuildingInfoDialog }  from './ui/BuildingInfoDialog.jsx';
import { StructuralPanel } from './structural/StructuralPanel.jsx';
import { autoFillColumnAxisOffsets, autoFillBeamEccentricity, resolveLowestGraph, axisExteriorSign } from './structural/structuralAutoFill.js';
import { buildExteriorSide } from './structural/wallGate.js';
import { buildStructuralFigureSlots, designationForSlot, firstSlotKeyForPlane } from './structural/structuralFigureSlots.js';
import { recomputeStructuralComposition, runStructuralModeSetup, reflectStructuralToOtherFloors, reflectStructuralAfterFloorAdd } from './structural/structuralOrchestration.js';
import { figureBindingManager } from './figure/FigureBindingManager.js';
import { floorSwapManager } from './storage/FloorSwapManager.js';
import { saveFloor, loadFloor } from './storage/db.js';
import { readLocalAutosaveRaw, parseAutosaveData, writeLocalAutosave, parseOpenedFileBytes, downloadDocumentFile, defaultDocumentFileName } from './storage/localSnapshot.js';
import { SaveFileDialog } from './ui/SaveFileDialog.jsx';
import { isDocumentEnvelope } from './storage/documentFile.js';
import { SiteInfoPanel }       from './ui/SiteInfoPanel.jsx';
import {
  confirmSiteLineLen, confirmSiteTriangle, cycleSiteLineKind,
} from './transform/siteEdit.js';
import { composeUndoWithMergeChain } from './transform/centerLineMerge.js';
import { extendCenterLine, shortenCenterLine } from './transform/centerLineExtend.js';
import {
  deleteCenterLineWithUndo,
  shouldSuggestWoodStructure, addCenterLineFromDialog,
  promoteCenterToGridWithUndo, demoteGridToCenterWithUndo,
} from './transform/centerLineOps.js';
import { ERR_CL_CONVERT_SYNC_FAILED, ERR_SESSION_LOCKED } from './error.js';
import { isSessionOwner } from './storage/sessionLock.js';
import { HamburgerMenu }       from './ui/HamburgerMenu.jsx';
import { ModeBar }             from './ui/ModeBar.jsx';
import { FloorDrum }           from './ui/FloorDrum.jsx';
import { AltChip }             from './ui/AltChip.jsx';
import { HistoryButtons }      from './ui/HistoryButtons.jsx';
import { ScaleIndicator }      from './ui/ScaleIndicator.jsx';
import { FloorplanPalette }    from './renderer/FloorplanPalette.jsx';
import { SceneLayers }         from './renderer/SceneLayers.jsx';
import { TOP_BAR } from './layout.js';
import { evalNumpadExpr } from './ui/numpadUtils.js';
import { EccentricityDialog } from './ui/EccentricityDialog.jsx';
import { KneeDropWallDialog } from './ui/KneeDropWallDialog.jsx';
import { resolveWallSpanKey } from './finish/kneeDropWall.js';

const evalExpr = (s) => evalNumpadExpr(s, { positiveOnly: true });

// 構造モードのAddCLDialogに渡す「柱芯」参照選択肢。columnAxisOffsets（通り芯→柱芯の偏芯量。
// structural-model.md「柱芯は『建物由来の出幅』から導出する」参照）が非0の通り芯のみを対象にする
// （0=通り芯と同位置のため選択肢ノイズになる）。柱芯実位置＝通り芯実位置(cl.value)＋offset
// ——gridCLs構築（graph.gridXs/gridYs、value基準）と同じ座標基準に揃える。
function buildColumnAxisRefs(graph, type) {
  const axisCLs = type === 'vertical' ? graph.gridXs : graph.gridYs;
  const refs = [];
  for (const cl of axisCLs) {
    const offset = graph.columnAxisOffsets.get(cl.id) ?? 0;
    if (offset === 0) continue;
    refs.push({
      id:    `colaxis:${cl.id}`,
      clId:  cl.id,
      value: cl.value + offset,
      axisOffset: offset,
      label: `${cl.label ?? ''} 柱芯`,
    });
  }
  return refs;
}

const App = observer(() => {
  const project = useStore();
  const [size,        setSize]        = useState({ width: window.innerWidth, height: window.innerHeight });
  const [menu,        setMenu]        = useState(null); // { pos, items, snap, worldPos, cl }
  const [statusMenu,  setStatusMenu]  = useState(null); // { entity, pos } | null — 部材タグ右クリック（適合状態の暫定トグル）
  const [memberFocusRequest, setMemberFocusRequest] = useState(null); // { mapName, tag, fieldKey, entityId } | null — 部材タグクリックで構造リストの該当寸法欄を開く（entityIdは「この部材」スコープの対象特定に使う）
  const [clDialog,    setClDialog]    = useState(null); // { type, worldCoord }
  const [clPreview,   setClPreview]   = useState(null);
  const [wallDialog,     setWallDialog]     = useState(null); // { worldPos }
  const [eccDialog,      setEccDialog]      = useState(null); // { cl } — CL偏芯ダイアログ
  const [kneeDropWallDialog, setKneeDropWallDialog] = useState(null); // { spanKey, anchor } — 腰壁・垂れ壁ダイアログ
  const [floorDialog,    setFloorDialog]    = useState(null); // { isLowest }
  const [floorConfirm,   setFloorConfirm]   = useState(null); // { message, buttons, onSelect }
  const [floorChangeDlg, setFloorChangeDlg] = useState(null); // { planeId }
  const [showCalibration, setShowCalibration] = useState(false);
  const [showSiteDialog,  setShowSiteDialog]  = useState(false);
  const [saveDialogDefaultName, setSaveDialogDefaultName] = useState(null); // 非null=保存ファイル名ダイアログ表示中
  const [showBuildingInfoDialog, setShowBuildingInfoDialog] = useState(false);
  const [showStructuralInfoDialog, setShowStructuralInfoDialog] = useState(false);
  const [toast,           setToast]           = useState(null); // { msg, key }
  const [appMode,         setAppMode]         = useState('floorplan'); // 'floorplan' | 'finish' | 'structure' | 'site'
  const [structComposition, setStructComposition] = useState(null); // 構造モードの図面合成（自階床下材＋1つ下の階の柱）。各カテゴリの供給グラフを保持する
  // フロア切替時にモードを再ロードするためのトリガー
  const [activeFloorId,   setActiveFloorId]   = useState(project.activePlaneId);
  // 排他セッションロック（storage/sessionLock.js）: 別タブが編集セッションを保持している場合 true。
  const [lockedOut,       setLockedOut]       = useState(false);
  // 上階ビュー: 直下階の階段を peek して上階表現で描くための解決済みエントリ。
  // null=未解決（初回マウント・階/モード切替直後で peek 未完了）、配列=解決済み（空配列含む）。
  // 2a壁クリップ（stairUnderClips）の中間階ガードは null の間、安全側で判定不能扱いにする
  // （QA指摘: 切替直後の1フレームは前の階の値が残ってしまい中間階ガードが効かない）。
  const [upperStairEntries, setUpperStairEntries] = useState(null);
  // 直上階の吹抜け（feature=VOID）を peek して直下階（自階）へ投影表示するための×座標
  const [upperVoidCrosses, setUpperVoidCrosses] = useState([]);
  // 直上階のスラブ開口（＝上階に床が無い領域）のワールド矩形。破れ線から先の階段を点線で
  // 描くときの可視範囲に使う。null=上階が無い／未解決（クリップしない＝安全側）。
  const [upperSlabOpenings, setUpperSlabOpenings] = useState(null);
  // 同じ開口の「境界CL矩形＋描画用の壁面矩形」。見上げ破線（開口の縁）を描くのに使う。
  const [upperSlabFrames, setUpperSlabFrames] = useState(null);
  // CL偏芯の階またぎ連動（他階のIDBを直接更新）後に、直上階peek系のstateを再計算させるトリガー
  const [floorSyncTick, setFloorSyncTick] = useState(0);
  // 構造モードのスライダーで選択中の図面スロット key（`slotType:planeId`）。1平面に複数スロットが
  // 乗る（木造の基礎伏図＋1階伏図・S造のR階伏図＋小屋伏図）ため、planeId とは別に保持する。
  const [activeStructSlotKey, setActiveStructSlotKey] = useState(null);

  const fileInputRef  = useRef(null);
  const openingSelectRef  = useRef(null); // 建具モードへの遷移直後に選択する開口ID（モードロード時に読み取って消費）

  // アクティブなモード状態 (FloorplanModeState | FinishModeState | null)
  // modeRef: イベントハンドラから同期的にアクセス
  // mode: MobX observer として描画に使用
  const [mode, setMode] = useState(null);
  const modeRef = useRef(null);

  const graph = project.activeGraph;

  // 構造モード・ラーメン系構造（S造/SRC造/RC造(ラーメン)）のときのみ、CENTER寸法行を柱芯（SX,SY）表示に切り替える
  // ラーメン系か否かの判定は autoFillColumnAxisOffsets（自階の実効主構造を見て書き込む唯一の場所）
  // が結果として書き込む columnAxisOffsets の有無で代用する（非ラーメン系は常にclear()される）。
  const columnAxisMode = appMode === 'structure' && graph.columnAxisOffsets.size > 0;

  // ---- ポインタ/タッチ/長押しのジェスチャー配線（interaction/usePointerInteraction.js）----
  const {
    handlers: pointerHandlers,
    snapPoint, nearCL, nearWall, nearOpening,
    cursorWorld, cursorScreen, pressPos, isPanning,
    commitCLMove,
    setSnapPoint, setNearCL, setNearWall, setNearOpening, setCursorWorld,
    resetGestureRefs,
  } = usePointerInteraction({
    project, graph, size, appMode, columnAxisMode, modeRef,
    menu, setMenu,
    onToast: msg => setToast({ msg, key: Date.now() }),
    onUndo: performUndo,
    onRedo: performRedo,
    // 建具モードの脱出（建具ターゲット以外の描画エリアのタップ）。パネルの×と同じ経路を呼ぶ
    // ——handleModeChange を通すことで境界処理（modeBoundaries.opening.exit）が必ず走る。
    onExitOpeningMode: () => handleModeChange('floorplan'),
  });

  // 起動時IDB復元の完了をマウント時1回だけ待ち、activeFloorId をproject.activePlaneIdへ同期する。
  // store.js の起動IIFEは非同期で、初回レンダリング後に restorePlanesFromIDB が
  // project.activePlaneId を差し替え得るが、activeFloorId（useState、初期値はマウント時点の
  // project.activePlaneId）は自動追従しないため（QA Finding 1）。
  // 無条件の reaction にはしない——switchFloorKeepingMode のコメント（下記「境界処理前のグラフで
  // モード状態が生成されてしまう」）が示すとおり、通常のフロア切替はモード境界処理→switchFloor→
  // setActiveFloorId の順序を守る必要があり、activeFloorIdへの無条件追従はその経路と競合する。
  // 起動直後の1回限りの同期はその経路の外（switchFloor系のどの関数も未実行の時点）なので安全。
  useEffect(() => {
    let cancelled = false;
    bootReady.then(() => {
      if (cancelled) return;
      setActiveFloorId(project.activePlaneId);
      setLockedOut(!isSessionOwner());
    }).catch(console.error);
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // モード切替: 旧モードを破棄してから新モジュールを動的ロード
  useEffect(() => {
    let cancelled = false;
    const prev = modeRef.current;
    modeRef.current = null;
    setMode(null);
    prev?.dispose();

    const loader = appMode === 'floorplan'
      ? import('./modes/FloorplanModeState.js').then(m => new m.FloorplanModeState(graph, project))
      : appMode === 'finish'
        ? import('./modes/FinishModeState.js').then(async m => {
            const s = new m.FinishModeState(graph, project);
            await s.init(); // 材データの動的ロード・照合・直下階階段のロード
            return s;
          })
        : appMode === 'structure'
          ? import('./modes/StructuralModeState.js').then(m => new m.StructuralModeState(graph))
          : appMode === 'opening'
            ? import('./modes/OpeningModeState.js').then(m => {
                const s = new m.OpeningModeState(graph, project, openingSelectRef.current);
                openingSelectRef.current = null;
                return s;
              })
            : appMode === 'elevation'
              ? import('./modes/ElevationModeState.js').then(async m => {
                  // screenPxPerMm: 校正値（viewport.pxPerMmX/Yの平均）。ElevationModeState.js
                  // 自体はDOM依存のviewport/appViewport.jsを静的importしない（node:test単体実行のため。
                  // ElevationModeState.test.js参照）ため、呼び出し側のここで解決して渡す。
                  const screenPxPerMm = (viewport.pxPerMmX + viewport.pxPerMmY) / 2;
                  const s = new m.ElevationModeState(graph, project, size, screenPxPerMm);
                  await s.init(); // 材データの動的ロード・直上階のpeek・帯の一括構築
                  return s;
                })
              : import('./modes/SiteModeState.js').then(m => new m.SiteModeState(project.site));

    loader.then(s => {
      if (cancelled) { s.dispose(); return; }
      modeRef.current = s;
      setMode(s);
      // 仕上げモード突入時に材データの照合エラーがあれば通知
      if (s.materialError) setToast({ msg: s.materialError, key: Date.now() });
    });

    return () => { cancelled = true; };
  }, [appMode, activeFloorId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 平面モードの建具記号: 採番キャッシュ(project.openingNumberIndex)の鮮度を保つ ----
  // index を変異するだけで graph は不変 → undoエントリ不要（.claude/opening-model.md）。
  // autorun ではなく reaction: effect 内で index を変異するため autorun だと自己再入する。
  useEffect(() => {
    if (appMode !== 'floorplan') return undefined;
    const g = project.activeGraph;   // 切替直後は activeGraph を読み直す（.claude/floor-design.md）
    if (!g) return undefined;
    return reaction(
      () => g.openings.map(openingSignature).join(';'),
      () => runInAction(() => renumberOpenings(g, project)),
      { fireImmediately: true },
    );
  }, [appMode, activeFloorId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 採用フロアの構成（追加・削除・並べ替え）が変わったら上下階 peek を作り直すためのキー。
  // 階を追加しても activeFloorId は変わらないため、これを deps に入れないと「表示中の階の
  // 直上・直下」が新しくできても前の解決結果（多くは null＝上階なし）が残り続ける。
  const planesKey = project.planes.map(p => p.id).join(',');

  // 上階ビュー: 直下階（elevation が1つ下の採用フロア）の階段を peek し、
  // 上階表現（全段）の描画用エントリへ解決する。階切替・モード切替・階構成の変化で再計算する。
  // CL偏芯の階またぎ連動（floorSyncTick）でも再計算する——連動先の壁面位置が変わりうるため。
  useEffect(() => {
    let cancelled = false;
    // 新しい階・モードの解決が終わるまで「未解決」（null）にする——解決前は前の階の値が
    // 残ったまま中間階ガード（stairUnderClips）が誤判定しうるため（QA指摘）。
    setUpperStairEntries(null);
    (async () => {
      const planes = project.planes; // elevation 昇順
      const active = project.activePlane;
      const idx = planes.findIndex(p => p.id === active?.id);
      const below = idx > 0 ? planes[idx - 1] : null;
      if (!below || !active || !shouldShowPlanFigure(appMode)) {
        if (!cancelled) setUpperStairEntries([]);
        return;
      }
      const temp = await floorSwapManager.peek(below, project.structGraph);
      if (cancelled) return;
      const floorHeight = active.elevation - below.elevation; // 直下階の階高
      setUpperStairEntries(buildUpperStairPeekEntries(temp, floorHeight));
    })().catch(console.error); // 非オーナータブでは peek → openDB が reject する（unhandled rejection防止）
    return () => { cancelled = true; };
  }, [appMode, activeFloorId, floorSyncTick, planesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 吹抜け直下の階ビュー: 直上階（elevation が1つ上の採用フロア）を peek し、その吹抜け
  // （feature=VOID）の×座標を自階へ投影表示する（世界座標は全階共通のため peek 結果の座標を
  // そのまま使える。stairFloorSync.js の stairPortEdges と同じ前提）。CL偏芯の階またぎ連動
  // （floorSyncTick）でも再計算する——連動先の壁面位置が変わりうるため。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const planes = project.planes; // elevation 昇順
      const active = project.activePlane;
      const idx = planes.findIndex(p => p.id === active?.id);
      const above = idx >= 0 && idx + 1 < planes.length ? planes[idx + 1] : null;
      if (!above || !active || !shouldShowPlanFigure(appMode)) {
        setUpperVoidCrosses([]);
        setUpperSlabOpenings(null); // 上階なし＝スラブ開口は判定不能（クリップしない）
        setUpperSlabFrames(null);
        return;
      }
      const temp = await floorSwapManager.peek(above, project.structGraph);
      if (cancelled) return;
      setUpperVoidCrosses(computeVoidCrosses(temp));
      // 上階スラブの開口（吹抜け・階段吹抜けRoom＋上階階段の破れ先セル）。上階階段の破れ位置は
      // その階の蹴上で決まるため、上階のさらに上との階高から riser を解決して渡す。
      const aboveFh = floorHeightAbove(project, above);
      const riserOf = (s) => s.riser ?? (aboveFh != null ? aboveFh / Math.max(1, s.totalSteps) : null);
      const openings = slabOpeningRects(temp, { riserOf });
      setUpperSlabOpenings(openings);
      setUpperSlabFrames(slabOpeningFrames(temp, { riserOf }));
    })().catch(console.error); // 非オーナータブでは peek → openDB が reject する（unhandled rejection防止）
    return () => { cancelled = true; };
  }, [appMode, activeFloorId, floorSyncTick, planesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const handler = (e) => {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 展開モード: 画面サイズ変化を伝える（固定倍率の再計算に使う。viewport.scaleX等は一切変更しない）。
  useEffect(() => {
    modeRef.current?.setViewSize?.(size);
  }, [size, appMode]);

  // ---- モード・フロアまたぎ undo/redo ----
  // 各エントリは記録時のコンテキスト（モード・階）を持つ（undoManager.contextProvider）。
  // 実行前にコンテキストが現在と違えば、先に表示をそのモード・階へ戻してから実行する。
  // 切替は「素の」切替（モード境界の再解釈・壁生成・エッジ同期は行わない——それら自体が
  // undo エントリとして履歴に積まれており、再実行すると履歴と二重適用になるため）。
  // フロア切替でグラフは IDB から同一オブジェクトへ復元されるため、エントリが握る
  // graph 参照は切替後も有効になる（＝フロアまたぎ undo もこれで成立する）。
  undoManager.contextProvider = () => ({ mode: appMode, planeId: project.activePlaneId });

  async function switchHistoryContext(ctx) {
    if (ctx.planeId && ctx.planeId !== project.activePlaneId && project.planeMap.has(ctx.planeId)) {
      await switchFloor(ctx.planeId);
      setActiveFloorId(ctx.planeId);
      setSnapPoint(null);
      setNearCL(null);
      setNearWall(null);
      setNearOpening(null);
      setCursorWorld(null);
      setMenu(null);
      setClDialog(null);
      setWallDialog(null);
    }
    if (ctx.mode && ctx.mode !== appMode) {
      if (appMode === 'structure' && ctx.mode !== 'structure') {
        // 構造モードからの離脱は図面合成バインディングの停止が必須（handleModeChange と同じ後始末。
        // 履歴ナビゲーションは「素の切替」のため他階反映等の境界同期は行わない）
        await figureBindingManager.deactivate();
        setStructComposition(null);
        setShowStructuralInfoDialog(false);
      }
      setMode(null);
      setAppMode(ctx.mode);
      if (ctx.mode === 'structure') {
        // 構造モードへの復帰は図面合成の再構築が必須（自動補完は決定的な冪等インフラで undo を汚さない）
        setActiveStructSlotKey(firstSlotKeyForPlane(buildStructuralFigureSlots(project), project.activePlaneId));
        setStructComposition(await runStructuralModeSetup(project.activeGraph, project, {
          onToast: msg => setToast({ msg, key: Date.now() }),
        }));
      }
    }
  }

  // Ctrl+Z / Ctrl+Y の実体。コンテキスト切替は非同期のため、進行中の多重実行は弾く。
  // 切替中に履歴が動いた（別の push/undo が割り込んだ）場合は実行を中止する。
  const historyNavRef = useRef(false);
  async function performUndo() {
    if (historyNavRef.current) return;
    const cmd = undoManager.peekUndo();
    if (!cmd) return;
    historyNavRef.current = true;
    try {
      if (cmd.context) await switchHistoryContext(cmd.context);
      if (undoManager.peekUndo() === cmd) undoManager.undo();
    } finally {
      historyNavRef.current = false;
    }
  }
  async function performRedo() {
    if (historyNavRef.current) return;
    const cmd = undoManager.peekRedo();
    if (!cmd) return;
    historyNavRef.current = true;
    try {
      if (cmd.context) await switchHistoryContext(cmd.context);
      if (undoManager.peekRedo() === cmd) undoManager.redo();
    } finally {
      historyNavRef.current = false;
    }
  }
  // keydown リスナは初回マウント時のみ登録されるため、最新レンダーのクロージャを ref 経由で呼ぶ
  const performUndoRef = useRef(null);
  const performRedoRef = useRef(null);
  const resetGestureRefsRef = useRef(null);
  performUndoRef.current = performUndo;
  performRedoRef.current = performRedo;
  resetGestureRefsRef.current = resetGestureRefs;

  // ESC / Ctrl+Z / Ctrl+Y
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); performUndoRef.current?.(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); performRedoRef.current?.(); return; }
      if (e.key !== 'Escape') return;
      setMenu(null);
      modeRef.current?.cancelDraw?.();
      modeRef.current?.cancelMove?.();
      modeRef.current?.cancelAxisEdit?.();
      modeRef.current?.cancelStretch?.();
      modeRef.current?.cancelSiteDraw?.();
      resetGestureRefsRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- モード境界: 建具モード突入（記号別採番を全階から収集して確定する）----
  // graph を一切変更しない（他階は peek のみ・保存も書き戻しもしない）ため undo エントリは不要
  // （.claude/undo-redo.md「undo対象外」の割り切りと同型。番号は project.openingNumberIndex という
  // 導出のみのキャッシュへ積むだけで、entity側には何も書かない）。
  async function collectOpeningNumbersAllFloors(activeGraph) {
    const activeId = project.activePlaneId;
    runInAction(() => project.clearOpeningNumberIndex());
    if (activeGraph) runInAction(() => collectFloorOpeningGroups(activeGraph, project));
    for (const plane of project.planes) {
      if (plane.id === activeId) continue;
      const temp = await floorSwapManager.peek(plane, project.structGraph);
      runInAction(() => collectFloorOpeningGroups(temp, project));
    }
    runInAction(() => applyOpeningTags(project, assignOpeningNumbers(project)));
  }

  // ---- モード境界: 構造モード突入（図面合成の構築・情報ダイアログ）----
  // handleModeChange（appMode切替）と移動スライダーの階切替（appMode維持）の両方から呼ぶ。
  // openInfoDialog: スライダー階切替では毎回ダイアログが開くのはUXとして不合理なため false にする。
  async function runStructuralEntryBoundary(targetGraph, { openInfoDialog = true } = {}) {
    if (openInfoDialog) setShowStructuralInfoDialog(true);
    setStructComposition(await runStructuralModeSetup(targetGraph, project, {
      onToast: msg => setToast({ msg, key: Date.now() }),
    }));
  }

  // ---- モード境界: 構造モード脱出（図面合成バインディングの停止・確定保存・他階への反映）----
  // closeInfoDialog: スライダー階切替では情報ダイアログの開閉状態を変更しない。
  // reflectOtherFloors: モード内編集（出幅・主構造・部材編集等）の他階への波及を脱出時に確定する。
  //   モード維持階切替では直後の突入境界が同じ反映を行うため false で省く。
  async function runStructuralExitBoundary({ closeInfoDialog = true, reflectOtherFloors = true } = {}) {
    // 編集可能peek（下階）の保留編集の保存完了まで待つ——直後に同じ階を peek する
    // 他階反映・階切替が、書込み前の古いデータを読む競合を防ぐ。
    await figureBindingManager.deactivate();
    setStructComposition(null);
    if (closeInfoDialog) setShowStructuralInfoDialog(false);
    if (reflectOtherFloors) await reflectStructuralToOtherFloors(project);
  }

  // ---- モード境界レジストリ ----
  // モードの突入（enter）・脱出（exit）境界処理の唯一の登録場所。モード切替（handleModeChange）と
  // 階切替（switchFloorKeepingMode / handleFloorSwitch）は必ずこの表を経由するため、境界処理を持つ
  // モードを追加するときはここに登録するだけで全経路へ適用される（経路ごとの適用漏れが構造的に起きない）。
  // enter/exit は Promise を返す。ctx = { toMode / fromMode, floorSwitch(モード維持階切替か) }。
  //   deferEnterOnModeChange: モード切替時は enter の完了を待たずにモードを切り替える
  //     （構造: 情報ダイアログと画面切替を先行させ、自動補完は裏で進める。階切替時は常に完了を待つ）。
  //   afterFloorSwitch: モード維持階切替の共通後始末に加えるモード固有リセット。
  // floorplan / site は階に紐づく確定処理を持たないため未登録（switchFloor するだけでよい）。
  const modeBoundaries = {
    finish: {
      // 突入: 前回脱出時点のRoom.cellsを現在のCLトポロジーと突き合わせて再解釈した上でエッジを再同期。
      // 脱出: 部屋ごとの壁自動生成・外壁再生成・構造反映を確定。
      enter: (graph) => runFinishEntryBoundary(graph, project),
      exit: (graph, { toMode }) => runFinishExitBoundary(graph, project, modeRef.current, { goingToStructure: toMode === 'structure' }),
    },
    structure: {
      // 突入: 構造情報ダイアログ・図面合成の構築・全階の自動補完反映。脱出: バインディング停止・確定保存・他階反映。
      deferEnterOnModeChange: true,
      enter: (graph, { floorSwitch }) => runStructuralEntryBoundary(graph, { openInfoDialog: !floorSwitch }),
      exit: (graph, { floorSwitch }) => runStructuralExitBoundary({ closeInfoDialog: !floorSwitch, reflectOtherFloors: !floorSwitch }),
      afterFloorSwitch: (planeId) => {
        setActiveStructSlotKey(firstSlotKeyForPlane(buildStructuralFigureSlots(project), planeId));
        setMode(null);
        setClDialog(null);
        setWallDialog(null);
      },
    },
    opening: {
      // 突入: 記号別採番を全階収集して確定する（graph は変えないため exit・undo エントリは不要）。
      // deferEnterOnModeChange: モード切替（handleModeChange）では全階peek（IDB読み）の完了を待たず
      // 画面切替を先行させる（構造モードと同じ扱い）。切替直後の一瞬はタグ未確定（リストは「—」）だが、
      // project.openingNumberIndex は observable.map のため収集完了後にパネルが自動再描画される。
      // 階切替（switchFloorKeepingMode）は常に完了を待つ（mode-system.mdの既定動作、フラグ不参照）。
      deferEnterOnModeChange: true,
      enter: (graph) => collectOpeningNumbersAllFloors(graph),
    },
    elevation: {
      // 突入: 建具記号丸のタグ表示に使うため、建具モードと同じ採番収集を行う。graphは変更しない
      // （表示専用モード）ため exit・undoエントリは不要（openingモードと同じ論証）。
      //
      // openingモードとは異なりdeferEnterOnModeChangeを付けない（=完了を待つ）: 建具モードの
      // タグレイヤは observer で project.openingNumberIndex を毎回読み直すため、採番が遅れて
      // 確定しても後から自動的に再描画される。展開モードは突入時に帯（プリミティブ配列）を
      // 一度だけ構築してスナップショット化する（ElevationModeState.bandsはobservable.refで
      // reactionを持たない）ため、採番の確定を待たずに帯を組むと建具記号丸の番号が
      // 恒久的に空欄のまま固まってしまう。
      enter: (graph) => collectOpeningNumbersAllFloors(graph),
    },
  };

  // ---- モード切り替え ----
  async function handleModeChange(newMode) {
    if (newMode === appMode) { setMode(null); setAppMode(newMode); return; } // 同一モードは境界処理なし

    // 以降のモード固有処理はこの graph を対象とする。R階伏図からの脱出時は降りた先の階で再取得する。
    let graph = project.activeGraph;

    // 旧モードの脱出境界を確定してから切り替える（graph 変更を伴う境界処理は完了を待つ）。
    await modeBoundaries[appMode]?.exit?.(graph, { toMode: newMode, floorSwitch: false });

    // R階伏図（屋根専用平面）は構造モード専用の合成平面で他モードには存在しない。
    // 他モードへ移る場合は直下の実体階（最上階）へ降りてから切り替える。
    if (project.activePlane?.isRoofPlane) {
      const belowId = project.activePlane.roofForPlaneId;
      if (belowId != null && project.planeMap.has(belowId)) {
        await switchFloor(belowId);
        setActiveFloorId(belowId);
        graph = project.activeGraph; // 降りた先のフロアを以降の処理対象にする
      }
    }

    // 新モードの突入境界（構造は deferEnterOnModeChange＝完了を待たずに切替を先行させる）。
    const next = modeBoundaries[newMode];
    if (next?.enter) {
      const entered = next.enter(graph, { fromMode: appMode, floorSwitch: false });
      if (next.deferEnterOnModeChange) entered.catch(console.error);
      else await entered;
    }

    // 旧モードを同期的にクリア。setMode(null) は effect 内（描画後）に走るため、
    // ここでクリアしないと appMode 変更直後の1レンダリングで旧モードのまま
    // モード固有パネルが描画されてしまう（型不一致でクラッシュする）。
    setMode(null);
    setAppMode(newMode);
  }

  // ---- フロア切替（平面モードへ移動する切替。階追加・削除・階段フロー等の共通経路）----
  // どのモードから呼ばれても現モードの脱出境界を先に確定する（モード境界レジストリ経由＝適用漏れ防止）。
  async function handleFloorSwitch(planeId) {
    if (planeId === project.activePlaneId) return;
    await modeBoundaries[appMode]?.exit?.(project.activeGraph, { toMode: 'floorplan', floorSwitch: false });
    await switchFloor(planeId);
    setActiveFloorId(planeId);
    setMode(null);
    setAppMode('floorplan');
    setSnapPoint(null);
    setNearCL(null);
    setNearWall(null);
    setNearOpening(null);
    setCursorWorld(null);
    setMenu(null);
    setClDialog(null);
    setWallDialog(null);
  }

  // ---- フロア切替（モード維持）：現モードを抜けずに別階の同種図面へ移動する ----
  // 「現モードの当該階を確定→階移動→現モードへ再突入」をモード境界レジストリ経由で共通適用する
  // （境界処理を持たないモードは素の switchFloor になる）。
  // 脱出境界処理は switchFloor 前（modeRef.current がまだ切替前階のまま生存＝roomWallDims等が使える）、
  // 突入境界処理は switchFloor 後の graph（project.activeGraph を読み直したもの。.claude/floor-design.md）
  // に対して行い、それが終わってから setActiveFloorId でモード再ロード effect を走らせる
  // （先に activeFloorId を更新すると、境界処理前のグラフでモード状態が生成されてしまう）。
  async function switchFloorKeepingMode(planeId) {
    if (planeId === project.activePlaneId) return;
    const boundary = modeBoundaries[appMode];
    const graph = project.activeGraph; // 切替前階（脱出境界処理の対象）
    await boundary?.exit?.(graph, { toMode: appMode, floorSwitch: true });
    await switchFloor(planeId);
    await boundary?.enter?.(project.activeGraph, { floorSwitch: true }); // 切替後は読み直す
    setActiveFloorId(planeId);
    boundary?.afterFloorSwitch?.(planeId);
    setSnapPoint(null);
    setNearCL(null);
    setNearWall(null);
    setNearOpening(null);
    setCursorWorld(null);
    setMenu(null);
  }

  // ---- フロア切替（構造モード中・planeId 経路：検討チップ）。移動先平面の先頭スロットを選択状態にする。
  // 情報ダイアログの開閉はここでは変更しない（毎回ポップアップするのはUXとして不合理）。
  async function handleStructuralFloorSwitch(planeId) {
    if (planeId === project.activePlaneId) {
      setActiveStructSlotKey(firstSlotKeyForPlane(buildStructuralFigureSlots(project), planeId));
      return;
    }
    await switchFloorKeepingMode(planeId);
  }

  // ---- 図面スロット切替（構造モードのスライダー）：slotType:planeId 単位で選択・移動する ----
  // 同一平面の別スロット（例：基礎伏図⇄1階伏図）は平面移動せずラベル選択のみ。別平面なら通常の階切替。
  async function handleStructuralSlotSwitch(slotKey) {
    const slot = buildStructuralFigureSlots(project).find(s => s.key === slotKey);
    if (!slot) return;
    if (slot.planeId === project.activePlaneId) {
      setActiveStructSlotKey(slotKey); // 同一平面内のスロット選択（部材合成の細分は次フェーズ）
      return;
    }
    await switchFloorKeepingMode(slot.planeId);
    setActiveStructSlotKey(slotKey); // afterFloorSwitch の既定（先頭スロット）を指定スロットで上書き
  }

  function handleAddFloor(e) {
    const currentPlane = project.activePlane;
    if (!currentPlane || currentPlane.isAlternative) return; // 採用のみ

    const isLowest = project.planes[0]?.id === currentPlane.id;

    // ケース2: 最下階でない、かつ地下階（開始階 < 0）→ 上階を即時実行
    if (!isLowest && currentPlane.startFloor < 0) {
      executeAddUpper(currentPlane);
      return;
    }

    // ケース1（最下階）/ ケース3（その他）→ ボタン直下にダイアログを開く
    const rect = e.currentTarget.getBoundingClientRect();
    setFloorDialog({ isLowest, anchor: { x: rect.left, y: rect.bottom } });
  }

  // 階追加（'upper'/'general'のみ対象。'lower' は対象外）: 元階の階段・外壁状態を新階へ引き継ぐ。
  //   1. 下階のどこかに階段があれば、新階（〜最上階）へ階段補助線を同期する（syncUpperFloorsAuto。
  //      表示階に階段が無くても下階から起点を探索する。旧最上階＝中間階へ移行した階には階段が
  //      設置され、階段吹抜けはペアRoomへ転用される。新最上階には CL＋階段吹抜けのみ。壁は生成しない）。
  //   2. 元階に外壁（isExteriorWall）があれば、新階へ「外壁ループ内側」を部屋「n階」として自動追加する
  //      （newStartFloor基準。地下階でも makeFloorName(startFloor, 1) で「地下n階」等に正しく整形される）。
  // addFloor 直後・handleFloorSwitch 前に行う（新階はまだ非アクティブ＝peek→saveFloorの通常経路。
  // handleFloorSwitch 後の activate() は IDB に保存済みの内容を読み込むため反映される）。
  async function syncNewFloorFromSource(sourceGraph, newPlane, newStartFloor) {
    const { syncUpperFloorsAuto, addNewFloorRoomFromSource } = await import('./finish/stair/stairFloorSync.js');
    await syncUpperFloorsAuto(project, sourceGraph);
    if (sourceGraph.walls.some(w => w.isExteriorWall)) {
      await addNewFloorRoomFromSource(project, sourceGraph, newPlane, makeFloorName(newStartFloor, 1));
    }
  }

  // ---- 階追加の undo 記録 ----

  // 現在の全採用フロアの状態を planeId → bytes で収集する（アクティブ階はメモリから、
  // 非アクティブ階は IDB から。IDB 未保存の階は null）。
  async function collectFloorBytes() {
    const map = new Map();
    for (const p of project.planes) {
      map.set(p.id, p.id === project.activePlaneId
        ? serializeGraph(project.activeGraph)
        : (await loadFloor(p.id)) ?? null);
    }
    return map;
  }

  // 階追加フロー全体（addFloor＋新階への同期＋切替＋全階の構造反映）を実行し、
  // 1つの undo エントリとして記録する。
  //   undo: 追加階に居れば元の階へ戻り、追加階を削除し、同期・構造反映で変わった既存階を元へ戻す
  //   redo: 同じ planeId で階を作り直し、追加後状態の bytes を IDB へ書き戻して再度切り替える
  // フロア切替・IDB 書き込みは非同期のため undo/redo 内では投げ放しで実行する
  // （完了前に次の undo を重ねると競合しうるが、通常の操作間隔では問題にならない）。
  async function withFloorAddUndo(run) {
    const sourcePlaneId = project.activePlaneId;
    const before = await collectFloorBytes();

    await run();

    const addedPlanes = project.planes
      .filter(p => !before.has(p.id))
      .map(p => ({ id: p.id, elevation: p.elevation, name: p.name, startFloor: p.startFloor, stories: p.stories }));
    if (addedPlanes.length === 0) return;

    const activeAfterId = project.activePlaneId;
    const after = await collectFloorBytes();
    const addedBytes = new Map(addedPlanes.map(pl => [pl.id, after.get(pl.id) ?? null]));
    const changedSiblings = [];
    for (const [planeId, beforeBytes] of before) {
      const afterBytes = after.get(planeId);
      if (after.has(planeId) && !floorBytesEqual(beforeBytes, afterBytes)) {
        changedSiblings.push({ planeId, before: beforeBytes, after: afterBytes });
      }
    }

    undoManager.push(
      () => {
        (async () => {
          // アクティブ階は削除できないため、追加階に居る場合は先に元の階へ戻る
          // （元の階が消えている防御ケースでは追加階以外の最初の採用フロアへ）
          if (addedPlanes.some(pl => pl.id === project.activePlaneId)) {
            const backId = project.planeMap.has(sourcePlaneId)
              ? sourcePlaneId
              : project.planes.find(p => !addedPlanes.some(pl => pl.id === p.id))?.id;
            if (!backId) return; // 戻り先なし（起こらない想定）
            await handleFloorSwitch(backId);
          }
          for (const pl of addedPlanes) await removeFloor(pl.id);
          for (const rec of changedSiblings) applyFloorBytes(project, rec.planeId, rec.before);
        })().catch(console.error);
      },
      () => {
        (async () => {
          for (const pl of addedPlanes) {
            addFloor(pl.elevation, pl.name, pl.startFloor, pl.stories, pl.id);
            const bytes = addedBytes.get(pl.id);
            if (bytes != null) await saveFloor(pl.id, bytes);
          }
          for (const rec of changedSiblings) applyFloorBytes(project, rec.planeId, rec.after);
          await handleFloorSwitch(activeAfterId); // activate() が保存済み bytes を読み込む
        })().catch(console.error);
      },
    );
  }

  // 上階を追加して切り替える
  async function executeAddUpper(currentPlane) {
    await withFloorAddUndo(async () => {
      const topFloor      = currentPlane.startFloor + currentPlane.stories - 1;
      const newStartFloor = addSkipZero(topFloor, 1);
      const newName       = makeFloorName(newStartFloor, 1);
      const nextElevation = currentPlane.elevation + 3000 * currentPlane.stories;
      const { plane } = addFloor(nextElevation, newName, newStartFloor, 1);
      await syncNewFloorFromSource(project.activeGraph, plane, newStartFloor);
      await handleFloorSwitch(plane.id);
      await reflectStructuralAfterFloorAdd(project);
    });
  }

  // ダイアログ確定: action = 'upper' | 'lower' | 'general'
  async function handleAddFloorConfirm(action, n) {
    setFloorDialog(null);
    const currentPlane = project.activePlane;
    if (!currentPlane) return;

    if (action === 'upper') {
      await executeAddUpper(currentPlane);
      return;
    }

    if (action === 'lower') {
      await withFloorAddUndo(async () => {
        // 下階 n 階分+: 表示中の開始階から連鎖して n 本追加
        const lowestElevation = project.planes[0]?.elevation ?? 0;
        let prevFloor = currentPlane.startFloor;
        let lastPlane = null;
        for (let i = 1; i <= n; i++) {
          const sf   = subtractSkipZero(prevFloor, 1);
          const name = makeFloorName(sf, 1);
          const elev = lowestElevation - 3000 * i;
          const result = addFloor(elev, name, sf, 1);
          lastPlane = result.plane;
          prevFloor = sf;
        }
        // 作成した最も下の階に切り替え
        if (lastPlane) await handleFloorSwitch(lastPlane.id);
        await reflectStructuralAfterFloorAdd(project);
      });
      return;
    }

    if (action === 'general') {
      await withFloorAddUndo(async () => {
        // 上階 n 階分の一般階
        const topFloor      = currentPlane.startFloor + currentPlane.stories - 1;
        const newStartFloor = addSkipZero(topFloor, 1);
        const newName       = makeFloorName(newStartFloor, n);
        const nextElevation = currentPlane.elevation + 3000 * currentPlane.stories;
        const { plane } = addFloor(nextElevation, newName, newStartFloor, n);
        await syncNewFloorFromSource(project.activeGraph, plane, newStartFloor);
        await handleFloorSwitch(plane.id);
        await reflectStructuralAfterFloorAdd(project);
      });
    }
  }

  // ---- フロアタブのドラッグ割り込み ----
  // 並替後の startFloor/elevation/name 再採番は floorOps.js の計算部（computeFloorReorder）に委譲。
  function handleReorderFloor(fromId, toZone) {
    const updates = computeFloorReorder(project.planes, fromId, toZone);
    if (!updates) return;
    runInAction(() => {
      for (const u of updates) {
        const plane = project.planeMap.get(u.id);
        plane.name       = u.name;
        plane.startFloor = u.startFloor;
        plane.elevation  = u.elevation;
      }
    });
  }

  // ---- 階・検討案の並替（検討チップのメニューから。±1で隣と入替え）----
  // 既存の handleReorderFloor / handleReorderAlt（ドロップゾーン方式）を再利用する。
  // 対象（alt/floor）とtoZoneの判定は floorOps.js の計算部（resolveChipReorderTarget）に委譲。
  function handleChipReorder(planeId, direction) {
    const plane = project.planeMap.get(planeId);
    if (!plane) return;
    const alts = plane.isAlternative
      ? [...project.planeMap.values()]
          .filter(p => p.isAlternative && p.referenceId === plane.referenceId)
          .sort((a, b) => a.altIndex - b.altIndex)
      : [];
    const target = resolveChipReorderTarget(plane, alts, project.planes, direction);
    if (!target) return;
    if (target.kind === 'alt') handleReorderAlt(planeId, target.toZone, target.refId);
    else                       handleReorderFloor(planeId, target.toZone);
  }

  // ---- フロアメニュー選択 ----
  async function handleFloorMenuAction(action, planeId) {
    const plane = project.planeMap.get(planeId);
    if (!plane) return;

    if (action === 'move-up' || action === 'move-down') {
      handleChipReorder(planeId, action === 'move-up' ? 1 : -1);
      return;
    }

    if (action === 'floor-change') {
      setFloorChangeDlg({ planeId });
      return;
    }

    if (action === 'add-alt') {
      const refId = plane.isAlternative ? plane.referenceId : planeId;
      const refPlane = project.planeMap.get(refId);
      setFloorConfirm({
        message: '新しい検討図に表示中の平面をコピーしますか？',
        buttons: [
          { label: 'Yes',      value: 'yes',    primary: true },
          { label: 'No',       value: 'no'  },
          { label: 'キャンセル', value: 'cancel' },
        ],
        onSelect: async (v) => {
          setFloorConfirm(null);
          if (v === 'cancel') return;
          const altCount = [...project.planeMap.values()]
            .filter(p => p.isAlternative && p.referenceId === refId).length;
          const letter   = String.fromCharCode('a'.charCodeAt(0) + altCount);
          const altName  = (refPlane?.name ?? '') + '#' + letter;
          const result   = addAlternativeFloor(refId, altName);
          if (!result) return;
          await handleFloorSwitch(result.plane.id);
          if (v === 'yes') {
            restoreGraph(project.activeGraph, serializeGraph(graph));
          }
        },
      });
      return;
    }

    if (action === 'mezzanine') {
      const adopted  = project.planes;
      const idx      = adopted.findIndex(p => p.id === planeId);
      const lower    = adopted[idx - 1];
      const upper    = adopted[idx + 1];
      if (!lower || !upper) return;
      const lowerEnd = lower.startFloor + lower.stories - 1;
      const newSF    = (lowerEnd + upper.startFloor) / 2;
      const newSto   = upper.startFloor - newSF;
      runInAction(() => {
        plane.startFloor = newSF;
        plane.stories    = newSto;
        plane.name       = makeFloorName(newSF, newSto);
      });
      return;
    }

    if (action === 'delete') {
      setFloorConfirm({
        message: 'この階を削除すると、１つ下の階にある階段も削除されます。削除は、採用・検討案共です。この階を削除してよろしいですか？',
        buttons: [
          { label: '削除', value: 'ok', primary: true, danger: true },
          { label: 'キャンセル', value: 'cancel' },
        ],
        onSelect: async (v) => {
          setFloorConfirm(null);
          if (v !== 'ok') return;
          const adopted = project.planes;
          const idx     = adopted.findIndex(p => p.id === planeId);
          const fallback = adopted[idx + 1] ?? adopted[idx - 1];
          const below    = adopted[idx - 1] ?? null; // 直下の採用階（階段が接続していた階）
          if (project.activePlaneId === planeId || isActiveAnAltOf(project, planeId)) {
            if (fallback) await handleFloorSwitch(fallback.id);
          }
          await removeFloor(planeId);
          // 消えた上階(n)に接続していた直下階(n-1)の階段を削除する。採用・検討案の両方。
          if (below) {
            await removeStairsOnFloor(below);
            const belowAlts = [...project.planeMap.values()]
              .filter(p => p.isAlternative && p.referenceId === below.id);
            for (const alt of belowAlts) await removeStairsOnFloor(alt);
          }
          // 右側の採用の startFloor / elevation を再計算
          const newAdopted = project.planes;
          if (idx < newAdopted.length) {
            runInAction(() => {
              const anchor = newAdopted[idx - 1] ?? newAdopted[0];
              let prevSF = anchor.startFloor, prevSto = anchor.stories, prevElev = anchor.elevation;
              const start = anchor === newAdopted[idx - 1] ? idx : idx + 1;
              for (let i = start; i < newAdopted.length; i++) {
                const p = newAdopted[i];
                const sf   = addSkipZero(prevSF + prevSto - 1, 1);
                const elev = prevElev + prevSto * 3000;
                p.name       = p.stories > 1 ? makeFloorName(sf, p.stories) : renameFloor(p.name, sf);
                p.startFloor = sf;
                p.elevation  = elev;
                prevSF = sf; prevSto = p.stories; prevElev = elev;
              }
            });
          }
        },
      });
      return;
    }

    if (action === 'delete-alt') {
      setFloorConfirm({
        message: `「${plane.name}」の平面を削除してよろしいですか？`,
        buttons: [
          { label: '削除', value: 'ok', primary: true, danger: true },
          { label: 'キャンセル', value: 'cancel' },
        ],
        onSelect: async (v) => {
          setFloorConfirm(null);
          if (v !== 'ok') return;
          if (project.activePlaneId === planeId) {
            const fallback = project.planeMap.get(plane.referenceId);
            if (fallback) await handleFloorSwitch(fallback.id);
          }
          await removeFloor(planeId);
        },
      });
      return;
    }

    if (action === 'promote') {
      const refId    = plane.referenceId;
      const adopted  = project.planeMap.get(refId);
      if (!adopted) return;
      runInAction(() => {
        const oldName = adopted.name;
        // plane が新採用になる
        plane.isAlternative = false;
        plane.referenceId   = null;
        plane.altIndex      = 0;
        plane.name          = oldName;
        // adopted が検討に降格
        const newAltCount = [...project.planeMap.values()]
          .filter(p => p.isAlternative && p.referenceId === planeId).length;
        adopted.isAlternative = true;
        adopted.referenceId   = planeId;
        adopted.altIndex      = newAltCount;
        adopted.name          = '旧' + oldName;
        // 他の検討の referenceId を更新
        for (const [, p] of project.planeMap) {
          if (p.isAlternative && p.referenceId === refId && p.id !== planeId) {
            p.referenceId = planeId;
          }
        }
        // altIndex を詰め直す
        const alts = [...project.planeMap.values()]
          .filter(p => p.isAlternative && p.referenceId === planeId)
          .sort((a, b) => a.altIndex - b.altIndex);
        alts.forEach((p, i) => { p.altIndex = i; });
      });
      return;
    }

    if (action === 'copy-alt') {
      const refId   = plane.isAlternative ? plane.referenceId : planeId;
      const newName = plane.name + "'";
      const result  = addAlternativeFloor(refId, newName);
      if (!result) return;
      const bytes = project.activePlaneId === planeId
        ? serializeGraph(graph)
        : null;
      await handleFloorSwitch(result.plane.id);
      if (bytes) restoreGraph(project.activeGraph, bytes);
      return;
    }
  }

  // 指定階の階段をすべて削除する。アクティブ階はライブグラフ、非アクティブ階は peek して保存。
  async function removeStairsOnFloor(plane) {
    const isActive = plane.id === project.activePlaneId;
    const g = isActive ? project.activeGraph : await floorSwapManager.peek(plane, project.structGraph);
    if (g.stairs.length === 0) return;
    runInAction(() => { for (const s of [...g.stairs]) g.removeStair(s.id); });
    if (!isActive) await saveFloor(plane.id, serializeGraph(g)); // アクティブ階は auto-save に委ねる
  }

  // 検討の並び替え（グループ内）。再採番の計算は floorOps.js（computeAltReorder）に委譲。
  function handleReorderAlt(fromId, toZone, refId) {
    const alts = [...project.planeMap.values()]
      .filter(p => p.isAlternative && p.referenceId === refId)
      .sort((a, b) => a.altIndex - b.altIndex);
    const updates = computeAltReorder(alts, fromId, toZone);
    if (!updates) return;
    runInAction(() => { for (const u of updates) { project.planeMap.get(u.id).altIndex = u.altIndex; } });
  }

  // 階変更。再採番の計算は floorOps.js（computeFloorChangeReorder）に委譲。
  function handleFloorChange(planeId, newStartFloor) {
    setFloorChangeDlg(null);
    const updates = computeFloorChangeReorder(project.planes, planeId, newStartFloor);
    if (!updates) return;
    runInAction(() => {
      for (const u of updates) {
        const p = project.planeMap.get(u.id);
        p.name       = u.name;
        p.startFloor = u.startFloor;
        p.elevation  = u.elevation;
      }
    });
  }

  // ---- 三斜 線分長さ確定（NumPad/テキスト入力からの確定） ----
  // 実処理は transform/siteEdit.js の confirmSiteLineLen（内部で editSiteLineLength を呼ぶ）。
  function handleConfirmLineLen() {
    const { toast } = confirmSiteLineLen(project.site, modeRef.current, evalExpr);
    if (toast) setToast({ msg: toast, key: Date.now() });
  }

  // ---- 三斜 頂点確定（赤辺・青辺もまとめて SiteLine として追加） ----
  // 実処理は transform/siteEdit.js の confirmSiteTriangle。
  function handleConfirmTriangle() {
    const { toast } = confirmSiteTriangle(project, modeRef.current, viewport, size, evalExpr);
    if (toast) setToast({ msg: toast, key: Date.now() });
  }

  // ---- 確定済み線分の線種を循環切替（境界 → 道路境界 → 測量 → 境界...） ----
  // 実処理は transform/siteEdit.js の cycleSiteLineKind。
  function handleCycleLineKind(lineId) {
    cycleSiteLineKind(project.site, lineId);
  }

  // ---- ハンバーガーメニュー ----
  function handleHamburgerSelect(id) {
    if (id === 'new') {
      setFloorConfirm({
        message: '保存していない内容も含めてすべて消去します。よろしいですか？',
        buttons: [
          { label: '消去',      value: 'ok', primary: true, danger: true },
          { label: 'キャンセル', value: 'cancel' },
        ],
        onSelect: (v) => {
          setFloorConfirm(null);
          if (v !== 'ok') return;
          resetAll()
            .then(() => window.location.reload())
            .catch((e) => {
              // 失敗の実体は握りつぶさずコンソールへ残す（環境依存の失敗の調査用）
              console.error('[新規] resetAll failed:', e);
              setToast({ msg: '消去に失敗しました', key: Date.now() });
            });
        },
      });
      return;
    }
    if (id === 'site-info')      { setShowSiteDialog(true);       return; }
    if (id === 'building-info')  { setShowBuildingInfoDialog(true); return; }
    if (id === 'open') {
      fileInputRef.current?.click();
      return;
    }
    if (id === 'save') {
      // まずファイル名指定ダイアログを開く（確定時に handleSaveConfirm が保存を実行する）
      setSaveDialogDefaultName(defaultDocumentFileName());
      return;
    }
    if (id === 'load') {
      const raw = readLocalAutosaveRaw();
      if (!raw) { setToast({ msg: '自動保存データが見つかりません', key: Date.now() }); return; }
      try {
        restoreGraph(graph, parseAutosaveData(raw));
        setToast({ msg: '読込み完了', key: Date.now() });
      } catch {
        setToast({ msg: '読込みに失敗しました', key: Date.now() });
      }
      return;
    }
    if (id === 'export') {
      writeLocalAutosave(graph);
      setToast({ msg: '書出し（自動保存）完了', key: Date.now() });
      return;
    }
    if (id === 'settings') {
      setShowCalibration(true);
    }
  }

  // 保存ファイル名ダイアログの確定。文書全体（全階・plane一覧・通り芯/構造情報・敷地・調査/計画情報）を
  // IDB へ明示保存で確定し、同じ内容を .stq 文書ファイルとしてダウンロード書き出しする（「開く」と対）
  function handleSaveConfirm(fileName) {
    setSaveDialogDefaultName(null);
    exportDocument()
      .then((json) => {
        downloadDocumentFile(json, fileName);
        setToast({ msg: '保存しました', key: Date.now() });
      })
      .catch((e) => {
        console.error('[保存] exportDocument failed:', e);
        setToast({ msg: '保存に失敗しました', key: Date.now() });
      });
  }

  function handleFileOpen(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = (ev) => {
      let parsed;
      try {
        parsed = parseOpenedFileBytes(new Uint8Array(ev.target.result));
      } catch {
        setToast({ msg: 'ファイルの読み込みに失敗しました', key: Date.now() });
        return;
      }
      // 文書ファイル（全階・plane一覧・通り芯/構造情報・敷地）: 保存ドキュメントを丸ごと
      // 置き換えて reload（通常のブート復元経路をそのまま使う。resetAll と同じ理由）
      if (isDocumentEnvelope(parsed)) {
        setFloorConfirm({
          message: '文書ファイルを開きます。現在の内容（保存していない編集を含む）は置き換えられます。よろしいですか？',
          buttons: [
            { label: '開く',       value: 'ok', primary: true },
            { label: 'キャンセル', value: 'cancel' },
          ],
          onSelect: (v) => {
            setFloorConfirm(null);
            if (v !== 'ok') return;
            importDocument(parsed)
              .then(() => window.location.reload())
              .catch(() => setToast({ msg: 'ファイルの読み込みに失敗しました', key: Date.now() }));
          },
        });
        return;
      }
      // 旧形式（単一グラフ FlatBuffers / 旧JSONスナップショット）: アクティブ階へ復元
      try {
        restoreGraph(graph, parsed);
        setToast({ msg: 'ファイルを開きました', key: Date.now() });
      } catch {
        setToast({ msg: 'ファイルの読み込みに失敗しました', key: Date.now() });
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ---- 出幅編集の確定 ----
  // axisEditState の出幅を 1構造×1通り芯キーへ書込み、構造伏図に映る全グラフで柱芯オフセットを
  // 再構築する（MobX連鎖で柱・梁・柱芯ラベル・寸法が即再描画）。同一構造の階は同じキーを共有するので
  // 自動で揃う（非アクティブ階は構造モード突入時再計算で反映＝既存 faceProjection 編集と同じ割り切り）。
  async function commitAxisEdit() {
    const es = modeRef.current?.axisEditState;
    if (!es) return;
    const { cl, structure, projection } = es;
    const si  = project.structuralInfo;
    const key = si.faceProjectionKey(structure, cl);
    const oldRaw = si.columnFaceProjections.get(key); // undefined=未登録（移行既定にフォールバック中）

    // 符号権威＝最下階フットプリント（resolveLowestGraph）。R階伏図など部屋の無い主題階を権威にすると
    // buildExteriorSide が部材CL外接矩形へ縮退し、L字ノッチ中通り（X2/Y2）の偏芯が0へ崩れる
    // （再計算 structuralRecompute と同じ単一権威に揃える）。
    const lowest = await resolveLowestGraph(project, graph);
    // 外周軸は出幅＝通り芯からの距離＝正（向きはフットプリント）。内部軸は外側方向が無いので、
    // 入力符号を移動の向きとして保持する（autoFillColumnAxisOffsets が X:+右/−左、Y:+上/−下 で解釈）。
    const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
    const isExterior = axisExteriorSign(buildExteriorSide(lowest), lowest, cl, isVertical) !== 0;
    const newVal = isExterior ? Math.abs(projection ?? 0) : (projection ?? 0);
    if (newVal === si.getColumnFaceProjection(structure, cl)) return; // 実効値に変化なし
    const refill = () => {
      const graphs = structComposition?.bindings?.map(b => b.graph) ?? [graph];
      for (const gg of graphs) {
        autoFillColumnAxisOffsets(gg, project, lowest);
        autoFillBeamEccentricity(gg, project); // 柱芯オフセット変更に梁の柱外面合わせを追従させる
      }
    };
    const apply = (raw) => runInAction(() => {
      if (raw === undefined) si.columnFaceProjections.delete(key);
      else                   si.columnFaceProjections.set(key, raw);
      refill();
    });
    apply(newVal);
    undoManager.push(() => apply(oldRaw), () => apply(newVal));
  }

  // ---- メニュー選択 ----
  function handleMenuSelect(item) {
    if (item.id === 'cl-v' || item.id === 'cl-h') {
      const isV  = item.id === 'cl-v';
      const pos  = menu.worldPos;
      const clType = isV ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
      // findNearbyCenterLines は全モード共通（構造モードの梁芯追加ダイアログでも使う）ため、
      // 種別の絞り込みはここ（appMode既知の呼び出し側）で行う——描画（appMode限定表示。
      // CenterLinesLayer）と同じ条件に揃える。構造モードは梁芯のみ（意匠CLは非表示のため参照候補にも
      // 出さない）、それ以外は梁芯を除外する（従来どおり）。
      const nearbyCLs = findNearbyCenterLines(
        graph, pos.x, pos.y, SNAP_THRESHOLD_PX * 2,
        viewport.scaleX, viewport.scaleY, clType
      ).filter(cl => appMode === 'structure' ? centerLineKind(cl) === 'beam' : centerLineKind(cl) !== 'beam');
      setClDialog({
        type:       isV ? 'vertical' : 'horizontal',
        worldCoord: isV ? pos.x : pos.y,
        perpCoord:  isV ? pos.y : pos.x,
        worldPos:   pos,
        nearbyCLs,
      });
      return;
    }
    if (item.id === 'cl-move') {
      // スナップ移動突入 — ガター長押しと同じ中心線移動処理（moveState）を使う
      (async () => {
        const err = await modeRef.current?.startMove(menu.cl);
        if (err) setToast({ msg: err, key: Date.now() });
      })();
      return;
    }
    if (item.id === 'cl-extend') {
      const cl = menu.cl, side = menu.clEndpointSide;
      let result;
      runInAction(() => { result = extendCenterLine(graph, cl, side, viewport); });
      if (result.extended) {
        const [undoFn, redoFn] = composeUndoWithMergeChain(result.baseUndo, result.baseRedo, result.chainResult);
        undoManager.push(() => runInAction(undoFn), () => runInAction(redoFn));
      }
      return;
    }
    if (item.id === 'cl-shorten') {
      const cl = menu.cl, side = menu.clEndpointSide;
      let result;
      runInAction(() => { result = shortenCenterLine(graph, cl, side, viewport); });
      if (result.shortened) {
        undoManager.push(() => runInAction(result.baseUndo), () => runInAction(result.baseRedo));
      }
      return;
    }
    if (item.id === 'cl-del')  {
      const { toast } = deleteCenterLineWithUndo(graph, project, menu.cl);
      if (toast) setToast({ msg: toast, key: Date.now() });
      return;
    }
    if (item.id === 'cl-ecc') {
      setEccDialog({ cl: menu.cl });
      return;
    }
    if (item.id === 'cl-to-grid' || item.id === 'cl-to-center') {
      const target = menu.cl;
      (async () => {
        const fn = item.id === 'cl-to-grid' ? promoteCenterToGridWithUndo : demoteGridToCenterWithUndo;
        const { toast } = await fn(graph, project, target);
        if (toast) setToast({ msg: toast, key: Date.now() });
        setFloorSyncTick(t => t + 1); // 連動先（他階）の複製・重複判定を反映させる（handleEccConfirmと同じ）
      })().catch(err => {
        // 階またぎ複製（propagateDemotedCenterLine）はIDB書込を含むため失敗しうる——途中まで
        // 保存できた分は centerLineFloorSync.js の finally で既にundoエントリへ合成済みなので、
        // ここでは失敗をトースト表示するだけでよい（cl-move等の既存async IIFEと同じ形）。
        console.error(err);
        setToast({ msg: ERR_CL_CONVERT_SYNC_FAILED, key: Date.now() });
      });
      return;
    }
    if (item.id === 'del') {
      if (menu.snap) {
        const before = serializeGraph(graph);
        graph.getShapesAtNode(menu.snap).forEach(s => graph.removeShape(s.id));
        const after = serializeGraph(graph);
        undoManager.push(
          () => restoreGraph(graph, before),
          () => restoreGraph(graph, after),
        );
      }
      return;
    }
    if (item.id === 'add-fitting' || item.id === 'add-window') {
      const category = item.id === 'add-fitting' ? OpeningCategory.FITTING : OpeningCategory.WINDOW;
      const { opening, error } = placeOpeningWithDefaults(graph, project, menu.wall, menu.worldPos, category);
      if (error) setToast({ msg: error, key: Date.now() });
      else       enterOpeningMode(opening.id);
      return;
    }
    if (item.id === 'opening-edit') {
      enterOpeningMode(menu.opening.id);
      return;
    }
    if (item.id === 'knee-drop-wall') {
      const spanKey = resolveWallSpanKey(menu.wall, menu.worldPos, graph);
      if (spanKey) setKneeDropWallDialog({ spanKey, anchor: menu.pos, isVerticalWall: menu.wall.isVertical, wallOffsetSign: Math.sign(menu.wall.axisOffset) });
      else         setToast({ msg: '区間を特定できません', key: Date.now() });
      return;
    }
    if (item.id === 'opening-del') {
      removeOpeningWithUndo(graph, project, menu.opening);
      return;
    }
    modeRef.current?.startDraw(item.id, menu?.snap, menu?.worldPos);
  }

  // ---- 建具モードへの遷移。既に建具モードなら選択だけ切り替える ----
  function enterOpeningMode(id) {
    if (appMode === 'opening') { modeRef.current?.selectOpening(id); return; }
    openingSelectRef.current = id;
    handleModeChange('opening');
  }

  // ---- 壁追加 ----
  function handleWallConfirm(refCL, dist) {
    if (!wallDialog) return;
    const { worldPos } = wallDialog;
    const isRefV     = refCL.centerLineType === CenterLineType.VERTICAL;
    const coord      = isRefV ? worldPos.x : worldPos.y;
    const dir        = coord >= refCL.value ? 1 : -1;
    const axisOffset = dir * dist;

    // 直交方向の CL を 2 本取得して壁の端点とする
    const perpType  = isRefV ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
    const perpCoord = isRefV ? worldPos.y : worldPos.x;
    const perpCLs   = graph.centerLines.filter(cl => cl.centerLineType === perpType);
    const [clA, clB] = findBracketingCLs(perpCLs, perpCoord);
    if (!clA || !clB) { setWallDialog(null); return; }

    const w = graph.addWall(refCL, axisOffset, isRefV, clA, 0, clB, 0);
    const affected = graph.trimIntersectingWalls(w);

    undoManager.push(
      () => {
        graph.removeShape(w.id);
        for (const snap of affected) {
          snap.wall.clStart    = snap.clStart;
          snap.wall.startOffset = snap.startOffset;
          snap.wall.clEnd      = snap.clEnd;
          snap.wall.endOffset  = snap.endOffset;
        }
      },
      () => {
        const rw = graph.addWall(refCL, axisOffset, isRefV, clA, 0, clB, 0);
        graph.trimIntersectingWalls(rw);
      },
    );
    setWallDialog(null);
  }

  // ---- CL偏芯 ----
  async function handleEccConfirm(rec, materialMap) {
    if (!eccDialog) return;
    const cl = eccDialog.cl;
    const { applyCLEccentricity } = await import('./finish/clEccentricity.js');
    const before = serializeGraph(graph);
    runInAction(() => {
      if (rec) graph.setCLEccentricity(cl.id, rec);
      else     graph.removeCLEccentricity(cl.id);
      applyCLEccentricity(graph, cl.id, { materialMap });
    });
    const after = serializeGraph(graph);
    const entry = undoManager.push(() => restoreGraph(graph, before), () => restoreGraph(graph, after));
    setEccDialog(null);
    // 階段・吹抜けに面する壁の偏芯は、設置階〜最上階／直下階と連動する（同一エントリで undo）
    const { propagateCLEccentricity } = await import('./finish/eccentricityFloorSync.js');
    await propagateCLEccentricity(project, graph, cl.id, { materialMap, undoEntry: entry });
    setFloorSyncTick(t => t + 1); // 連動先の壁面位置が変わりうるため、上階peek系のstateを再計算させる
  }

  // ---- 腰壁・垂れ壁 ----
  // レコード1件のみを書き換える軽量差分undo（serializeGraph全体スナップショットは使わない
  // ——壁の厚みジオメトリ自体は変えず、天板の追加描画（ShapesLayer.jsx）のみに影響するため）。
  function handleKneeDropWallConfirm(rec) {
    if (!kneeDropWallDialog) return;
    const { spanKey } = kneeDropWallDialog;
    const before = graph.kneeDropWalls.get(spanKey) ?? null;
    runInAction(() => {
      if (rec) graph.setKneeDropWall(spanKey, rec);
      else     graph.removeKneeDropWall(spanKey);
    });
    undoManager.push(
      () => runInAction(() => { if (before) graph.setKneeDropWall(spanKey, before); else graph.removeKneeDropWall(spanKey); }),
      () => runInAction(() => { if (rec)    graph.setKneeDropWall(spanKey, rec);    else graph.removeKneeDropWall(spanKey); }),
    );
    setKneeDropWallDialog(null);
  }

  // 木造（在来）の自動判定（問題.md）: 平面モードで主構造が未指定のとき、追加した通り芯が
  // 既存グリッドと910の倍数間隔をなすなら「木造（在来）」を提案する確認ダイアログを出す。
  // 「寸法指定を910で割った余りが0」を、隣接グリッドCLとの最小間隔で判定する（参照なし絶対座標入力にも効く）。
  // 主構造の正式表記は StructuralInfoDialog.MAIN_STRUCTURE_OPTIONS に準拠（'未定' / '木造（在来）'＝全角括弧）。
  function maybeSuggestWoodStructure(clType, newValues) {
    if (!shouldSuggestWoodStructure(graph, project, appMode, clType, newValues)) return;
    setFloorConfirm({
      message: '主要構造を木造（在来）としてよろしいですか？',
      buttons: [
        { label: 'Yes', value: 'yes', primary: true },
        { label: 'No',  value: 'no' },
      ],
      onSelect: (v) => {
        setFloorConfirm(null);
        if (v !== 'yes') return;
        const prev = project.structuralInfo.mainStructure;
        const apply = () => runInAction(() => project.structuralInfo.setField('mainStructure', '木造（在来）'));
        apply();
        undoManager.push(
          () => runInAction(() => project.structuralInfo.setField('mainStructure', prev)),
          apply,
        );
      },
    });
  }

  function handleCLDialogConfirm(value, kind, refId, refOffset) {
    if (!clDialog) return;
    const { done, toast, suggestWood } = addCenterLineFromDialog(
      graph, project, { clDialog, value, kind, refId, refOffset }, viewport,
    );
    if (toast) setToast({ msg: toast, key: Date.now() });
    if (done) { setClDialog(null); setClPreview(null); }
    if (suggestWood) maybeSuggestWoodStructure(suggestWood.clType, suggestWood.newValues);
  }

  const closeMenu = () => setMenu(null);

  const isLandscape = size.width > size.height;

  const isDrawing  = mode?.isDrawing  ?? false;
  const isMoving   = mode?.isMoving   ?? false;
  const isDragging = mode?.isDragging ?? false;

  const cursor = menu || clDialog ? 'default'
               : isPanning        ? 'grabbing'
               : appMode === 'finish' ? (isDragging ? 'crosshair' : 'default')
               : appMode === 'site'   ? (mode?.siteDrawState ? 'crosshair' : 'default')
               : appMode === 'elevation' ? 'grab'
               : appMode === 'opening' ? ((nearOpening || nearWall) ? 'pointer' : 'default')
               : isMoving         ? 'grab'
               : isDrawing        ? 'crosshair'
               : snapPoint        ? 'cell'
               : nearCL           ? 'pointer'
               : (nearOpening || nearWall) ? 'pointer'
               : 'crosshair';

  const floorName = project.activeGraph?.plane?.name ?? '1階';

  // 移動スライダー（ドラム）用の階リスト — 採用階のみ（標高昇順）。
  // 構造モードでは図面スロット列（buildStructuralFigureSlots）を主題とし、呼称（地中梁図・R階伏図 等）に
  // 書き換える。それ以外のモードは採用平面の階名そのまま。
  const structSlots = appMode === 'structure' ? buildStructuralFigureSlots(project) : null;
  // 選択中スロット key。保存値は「アクティブ平面に属するスロット」のときだけ採用する。
  // それ以外（モード退出→別平面で再突入したのに古い屋根スロットkeyが残存／構造変更でスロットが消えた 等）は
  // アクティブ平面の先頭スロットへフォールバックする——key一致だけ見ると、屋根平面は再突入時も同一idで
  // 再利用されるため古い「R階伏図」スロットにヒットし、1階突入なのにR階伏図が選択されてしまう。
  const savedStructSlot = structSlots?.find(s => s.key === activeStructSlotKey) ?? null;
  const activeStructSlot = structSlots
    ? (savedStructSlot?.planeId === project.activePlaneId
        ? savedStructSlot.key
        : firstSlotKeyForPlane(structSlots, project.activePlaneId))
    : null;
  const drumFloors = structSlots
    ? structSlots.map(slot => ({ id: slot.key, name: designationForSlot(slot, slot.key === activeStructSlot) }))
    : project.planes.map(p => ({ id: p.id, name: p.name }));

  // 検討チップ用 — 現在の階の採用＋検討案。
  const { chipActivePlane, chipVariants, chipText, chipManagementItems } = buildFloorChipModel(project, floorName);

  // 階段の設置階（install）・上階見下げ（upper）の描画エントリ。StairLayer の描画と
  // 2a壁の描画クリップ（stairUnderClip.js）の双方が使うため、ここで1度だけ計算する
  // （install側は二重計算しない。ただしbuildStairGeometry自体はStairLayerの描画用フル
  // ジオメトリと stairUnderClip.js の breakLine 抽出用で別々に呼ばれる——後者は前者の
  // 出力を再利用しない、別計算）。upperStairEntries は finish/floorplan 以外または
  // 階・モード切替直後の1フレームは null（未解決。該当useEffect参照）。
  const { isStairMode, installEntries, upperEntries, stairLaneGapMm, stairBreakOverhangMm, stairUnderClips } =
    buildStairEntries(graph, project, {
      appMode, viewport, upperStairEntriesPeek: upperStairEntries, upperSlabOpenings,
      stairBreakOverhangMm: overhangMm(viewport, false), // stairEntries.js は snap.js に依存しないため、ここで算出して渡す
    });
  // 直上階スラブ開口の縁（見上げ破線）。当該階の壁に覆われた区間は既に実線があるので描かない。
  const stairSlabOpeningEdges = isStairMode ? slabOpeningEdges(upperSlabFrames, graph) : [];

  // 排他セッションロック: 別タブが編集セッションを保持している場合、全画面案内のみ表示する
  // （同期・マージ・read-only編集は提供しない）。全hookの後・メインreturnの直前に置く
  // （hookより前のreturnはreact-hooks lintが落ちるため）。
  if (lockedOut) {
    return (
      <ConfirmDialog
        message={ERR_SESSION_LOCKED}
        buttons={[{ label: '再読み込み', value: 'reload', primary: true }]}
        onSelect={() => window.location.reload()}
      />
    );
  }

  return (
    <>
      {/* Undo/Redo ボタン — 左上 */}
      <HistoryButtons onUndo={performUndo} onRedo={performRedo} />

      {/* ハンバーガーメニュー — 右上 */}
      <div style={{
        position: 'fixed', top: 0, right: 6,
        height: TOP_BAR, display: 'flex', alignItems: 'center', zIndex: 210,
      }}>
        <HamburgerMenu onSelect={handleHamburgerSelect} />
      </div>

      {/* モード切替バー — 横長=上部中央 / 縦長=下部中央（常時表示） */}
      <ModeBar
        appMode={appMode}
        onSelect={handleModeChange}
        isLandscape={isLandscape}
      />

      {/* 移動スライダー（ドラム）— 採用階の移動（横長=左端 / 縦長=下部）。
          構造モードでは図面スロット（slotType:planeId）単位で選択・移動する。 */}
      <FloorDrum
        floors={drumFloors}
        activeFloorId={appMode === 'structure' ? activeStructSlot : activeFloorId}
        onSwitch={
          appMode === 'structure' ? handleStructuralSlotSwitch  // スロット単位（slotType:planeId）で移動
          : appMode === 'floorplan' ? handleFloorSwitch          // 平面はモード再設定を伴う従来経路
          : switchFloorKeepingMode                               // その他はモード維持の共通経路（境界レジストリ適用）
        }
        isLandscape={isLandscape}
      />

      {/* ファイル選択 (hidden) */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".stq,application/json"
        style={{ display: 'none' }}
        onChange={handleFileOpen}
      />

      {/* フロアセレクター — 左上（Undo/Redo ボタンの右隣）
          構造モード中はタブのラベル自体を図面呼称（基礎伏図／1階伏図／2階床伏図 等）に書き換える。
          クリックすると構造モードを抜けずに別階の構造伏図へ移動する（handleStructuralFloorSwitch）。
          平面モードに戻すとラベルは元の階名（1階 等）に戻る。 */}
      <div style={{
        position: 'fixed', top: 0, left: 80,
        height: TOP_BAR, display: 'flex', alignItems: 'center', gap: 10, zIndex: 200,
      }}>
        {/* 検討チップ — 採否表示／検討案の追加・切替・管理（屋根専用平面では非表示） */}
        {chipActivePlane && !chipActivePlane.isRoofPlane && (
          <AltChip
            chipText={chipText}
            variants={chipVariants}
            managementItems={chipManagementItems}
            onSwitch={appMode === 'structure' ? handleStructuralFloorSwitch : handleFloorSwitch}
            onTapAdd={() => handleFloorMenuAction('add-alt', project.activePlaneId)}
            onManage={id => handleFloorMenuAction(id, project.activePlaneId)}
          />
        )}

        {/* 階追加 [+] — 採用フロア表示中のみ有効。階切替はドラム、階管理・並替はチップへ集約済み。 */}
        {(() => {
          const canAddFloor = !(project.activePlane?.isAlternative);
          return (
            <button
              onClick={canAddFloor ? handleAddFloor : undefined}
              title={canAddFloor ? '階を追加' : '採用フロアを表示中のときに追加できます'}
              style={{
                width: 24, height: 24, borderRadius: 6,
                border: '1px solid #e2e8f0',
                background: canAddFloor ? '#f8fafc' : '#f1f5f9',
                color: canAddFloor ? '#64748b' : '#cbd5e1',
                fontSize: 15, cursor: canAddFloor ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
              }}
            >
              +
            </button>
          );
        })()}
      </div>

      <LongPressIndicator pos={pressPos} />

      <RadialMenu
        pos={menu?.pos ?? null}
        items={menu?.items ?? []}
        onSelect={handleMenuSelect}
        onClose={closeMenu}
      />

      <MemberStatusMenu
        pos={statusMenu?.pos ?? null}
        isCalculated={statusMenu?.entity.dimensionStatus === 'calculated'}
        onSelect={() => {
          statusMenu.entity.setDimensionStatus(statusMenu.entity.dimensionStatus === 'calculated' ? 'locked' : 'calculated');
          setStatusMenu(null);
        }}
        onClose={() => setStatusMenu(null)}
      />

      {clDialog && (
        <AddCLDialog
          type={clDialog.type}
          worldCoord={clDialog.worldCoord}
          gridCLs={clDialog.type === 'vertical' ? graph.gridXs : graph.gridYs}
          nearbyCLs={clDialog.nearbyCLs ?? []}
          appMode={appMode}
          columnAxisRefs={appMode === 'structure' ? buildColumnAxisRefs(graph, clDialog.type) : []}
          onConfirm={handleCLDialogConfirm}
          onCancel={() => { setClDialog(null); setClPreview(null); }}
          onPreviewChange={setClPreview}
        />
      )}

      {wallDialog && (
        <WallDialog
          worldPos={wallDialog.worldPos}
          allCLs={[...graph.gridXs, ...graph.gridYs]}
          nearbyCLs={wallDialog.nearbyCLs ?? []}
          backingMaterials={graph.backingMaterials}
          onConfirm={handleWallConfirm}
          onCancel={() => setWallDialog(null)}
        />
      )}

      {eccDialog && (
        <EccentricityDialog
          graph={graph}
          cl={eccDialog.cl}
          onConfirm={handleEccConfirm}
          onCancel={() => setEccDialog(null)}
        />
      )}

      {kneeDropWallDialog && (
        <KneeDropWallDialog
          graph={graph}
          spanKey={kneeDropWallDialog.spanKey}
          anchor={kneeDropWallDialog.anchor}
          isVerticalWall={kneeDropWallDialog.isVerticalWall}
          wallOffsetSign={kneeDropWallDialog.wallOffsetSign}
          onConfirm={handleKneeDropWallConfirm}
          onCancel={() => setKneeDropWallDialog(null)}
        />
      )}

      {floorDialog && (
        <AddFloorDialog
          isLowest={floorDialog.isLowest}
          anchor={floorDialog.anchor}
          onConfirm={handleAddFloorConfirm}
          onCancel={() => setFloorDialog(null)}
        />
      )}

      {floorConfirm && (
        <ConfirmDialog
          message={floorConfirm.message}
          buttons={floorConfirm.buttons}
          onSelect={floorConfirm.onSelect}
        />
      )}

      {floorChangeDlg && (
        <FloorChangeDialog
          currentStartFloor={project.planeMap.get(floorChangeDlg.planeId)?.startFloor ?? 1}
          onConfirm={n => handleFloorChange(floorChangeDlg.planeId, n)}
          onCancel={() => setFloorChangeDlg(null)}
        />
      )}

      <CLMoveInput
        moveState={mode?.moveState ?? null}
        screenX={cursorScreen.x}
        screenY={cursorScreen.y}
        onUpdate={v => modeRef.current?.updateMove(v)}
        onCommit={() => {
          const ms = modeRef.current?.moveState;
          if (ms) commitCLMove(ms.cl, ms.originalValue);
        }}
        onCancel={() => modeRef.current?.cancelMove()}
        graph={graph}
        scaleDenominator={viewport.scaleDenominator}
        structural={appMode === 'structure'}
      />

      {/* 柱芯ラベル ロングタップ → 出幅（柱外面⇔通り芯）の静止入力窓。
          確定で出幅を1構造×1通り芯キーへ書込み→構造伏図に映る全グラフで柱芯オフセットを再構築し再描画する。
          同一構造の階は同じ出幅キーを共有するため自動で揃う（非アクティブ階は構造モード突入時再計算で反映）。 */}
      <AxisFaceInput
        editState={mode?.axisEditState ?? null}
        onChange={v => modeRef.current?.updateAxisEdit?.(v)}
        onConfirm={() => { commitAxisEdit(); modeRef.current?.cancelAxisEdit?.(); }}
        onCancel={() => modeRef.current?.cancelAxisEdit?.()}
      />

      <div style={{ width: '100%', height: '100%' }}>
        <Stage
          width={size.width}
          height={size.height}
          onWheel={pointerHandlers.onWheel}
          onPointerDown={pointerHandlers.onPointerDown}
          onPointerMove={pointerHandlers.onPointerMove}
          onPointerUp={pointerHandlers.onPointerUp}
          onPointerLeave={pointerHandlers.onPointerLeave}
          onTouchStart={pointerHandlers.onTouchStart}
          onTouchMove={pointerHandlers.onTouchMove}
          onTouchEnd={pointerHandlers.onTouchEnd}
          style={{ cursor }}
        >
          <SceneLayers
            graph={graph}
            project={project}
            appMode={appMode}
            mode={mode}
            modeRef={modeRef}
            viewport={viewport}
            size={size}
            columnAxisMode={columnAxisMode}
            isStairMode={isStairMode}
            installEntries={installEntries}
            upperEntries={upperEntries}
            stairLaneGapMm={stairLaneGapMm}
            stairBreakOverhangMm={stairBreakOverhangMm}
            stairSlabOpeningEdges={stairSlabOpeningEdges}
            stairUnderClips={stairUnderClips}
            structComposition={structComposition}
            upperVoidCrosses={upperVoidCrosses}
            snapPoint={snapPoint}
            cursorWorld={cursorWorld}
            clPreview={clPreview}
            clDialog={clDialog}
            onOpeningTagClick={enterOpeningMode}
            onElevationOpeningClick={id => modeRef.current?.selectOpening(id)}
            wallDialog={wallDialog}
            menu={menu}
            setShowStructuralInfoDialog={setShowStructuralInfoDialog}
            setMemberFocusRequest={setMemberFocusRequest}
            setStatusMenu={setStatusMenu}
          />
        </Stage>
      </div>

      {/* 縮尺表示 / 入力 — 右下（展開モードは自前の固定倍率ラベルをElevationLayerが描くため非表示） */}
      {appMode !== 'elevation' && <ScaleIndicator width={size.width} height={size.height} />}

      {/* 仕上げモード: 部屋名入力ポップアップ */}
      {appMode === 'finish' && mode?.namingRoomId && (() => {
        const room = graph.roomMap.get(mode.namingRoomId);
        return room ? (
          <RoomNameInput
            // 部屋が変わったら必ず再マウントして、各値（部屋名・屋内外・階段/吹抜け）の初期値を
            // その部屋の元指定の値にする。key が無いと、namingRoomId が null を経由せず
            // 別の部屋へ切り替わる経路（例: ダイアログを開いたまま階段セルをクリック→
            // startDrag が同一アクション内で閉じて開く）で React がコンポーネントを再利用し、
            // useState の初期化が走らず前の部屋の値・入力途中の値が残る（ユーザー指摘2026-08:
            // 新規追加以外のケースの各値の初期値は元指定の値）。
            key={room.id}
            room={room}
            graph={graph}
            viewport={viewport}
            stairEnabled={floorHeightAbove(project, project.activePlane) != null}
            onConfirm={(id, payload) => {
              const floorHeight = floorHeightAbove(project, project.activePlane);
              const convertedStair = modeRef.current?.applyNaming(id, payload, floorHeight);
              if (convertedStair) {
                // 新規に階段変換された場合のみ、設置階の上の全採用フロア（最上階まで）へ
                // 中心線・階段を同期する（非アクティブ階を peek して IDB へ保存。壁は生成しない）。
                // undoEntry を渡し、自動設置分の巻き戻しを変換エントリへ合成する
                // （変換の Ctrl+Z 1回で上階分もまとめて undo される）。
                const undoEntry = modeRef.current?.lastNamingUndoEntry ?? null;
                import('./finish/stair/stairFloorSync.js')
                  .then(m => m.syncUpperFloors(project, project.activeGraph, { undoEntry }))
                  .catch(console.error);
              }
            }}
            onCancel={id => modeRef.current?.cancelNaming(id)}
            onDelete={id => modeRef.current?.deleteFromDialog(id)}
          />
        ) : null;
      })()}

      {/* 仕上げ表パネル（仕上げ表 / 階段 タブ） */}
      {appMode === 'finish' && mode && !mode.namingRoomId && (
        isLandscape
          ? <FinishSidebar
              graph={graph}
              mode={mode}
              project={project}
              selectedRoomId={mode.selectedRoomId}
              onSelectRoom={id => modeRef.current?.selectRoom(id)}
              floorName={floorName}
            />
          : <FinishHalfModal
              graph={graph}
              mode={mode}
              project={project}
              selectedRoomId={mode.selectedRoomId}
              onSelectRoom={id => modeRef.current?.selectRoom(id)}
              floorName={floorName}
            />
      )}

      {/* 平面モード: 開口パレット（選択中の建具・窓の内容） */}
      {appMode === 'floorplan' && mode?.selectedOpeningId && (() => {
        const opening = graph.shapeMap.get(mode.selectedOpeningId);
        return opening ? (
          <FloorplanPalette
            opening={opening}
            isLandscape={isLandscape}
            onClose={() => modeRef.current?.selectOpening(null)}
          />
        ) : null;
      })()}

      {/* 敷地モード: 線分情報パネル（サブモード切替は本パネルのタブが担う） */}
      {appMode === 'site' && mode && (
        <SiteInfoPanel
          site={project.site}
          mode={mode}
          viewport={viewport}
          isLandscape={isLandscape}
          onSelectLine={id => modeRef.current?.selectLine(id)}
          onConfirmLineLen={handleConfirmLineLen}
          onConfirmTriangle={handleConfirmTriangle}
          onCycleLineKind={handleCycleLineKind}
        />
      )}

      {/* 建具モード: 記号別採番リスト＋姿図・数値編集パネル */}
      {appMode === 'opening' && mode && (
        <OpeningPanel
          graph={graph}
          project={project}
          mode={mode}
          isLandscape={isLandscape}
          onToast={msg => setToast({ msg, key: Date.now() })}
          onClose={() => handleModeChange('floorplan')}
        />
      )}

      {/* QA項目3: 展開モード中の建具記号丸クリックで開く建具リストパネル（建具モードと同じ
          OpeningPanel.jsxを再利用。appModeは'elevation'のまま——モード切替は行わない）。
          ×クリックはmode.selectOpening(null)でパネルを閉じるだけ（建具モードを抜けるのとは
          違い、モードはelevationのまま）。 */}
      {appMode === 'elevation' && mode && mode.selectedOpeningId && (
        <OpeningPanel
          graph={graph}
          project={project}
          mode={mode}
          isLandscape={isLandscape}
          onToast={msg => setToast({ msg, key: Date.now() })}
          onClose={() => mode.selectOpening(null)}
        />
      )}

      {toast && (
        <div key={toast.key} className="cl-toast" onClick={() => setToast(null)}>
          {toast.msg}
        </div>
      )}

      {saveDialogDefaultName != null && (
        <SaveFileDialog
          defaultName={saveDialogDefaultName}
          onConfirm={handleSaveConfirm}
          onCancel={() => setSaveDialogDefaultName(null)}
        />
      )}

      {showCalibration && (
        <CalibrationDialog
          viewport={viewport}
          onClose={() => setShowCalibration(false)}
        />
      )}

      {showSiteDialog && (
        <SiteDialog
          initial={project.projectInfo.siteInfo}
          onClose={(form) => {
            // 画像ファイル（File オブジェクト）はバックエンド送信想定のため永続化しない
            const rest = { ...form };
            delete rest.siteImageFile;
            project.setSiteInfo(rest);
            markDirty();
            setShowSiteDialog(false);
          }}
        />
      )}

      {showBuildingInfoDialog && (
        <BuildingInfoDialog
          initial={project.projectInfo.buildingInfo}
          onClose={(form) => {
            project.setBuildingInfo(form);
            markDirty();
            setShowBuildingInfoDialog(false);
          }}
        />
      )}

      {showStructuralInfoDialog && (
        <StructuralPanel
          project={project}
          graph={graph}
          composition={structComposition}
          onClose={() => setShowStructuralInfoDialog(false)}
          isLandscape={isLandscape}
          focusRequest={memberFocusRequest}
          onToast={msg => setToast({ msg, key: Date.now() })}
          onStructureChanged={mutate => {
            // 主構造変更（mutate）→ 構造伏図に映る全グラフ（自階＋下階）を再計算し、下階の柱も実効主構造へ追従させる。
            if (structComposition) {
              recomputeStructuralComposition(structComposition, project.activeGraph, project, {
                mutate, onToast: msg => setToast({ msg, key: Date.now() }),
              }).catch(console.error);
            } else {
              runInAction(mutate); // 万一 composition 未確立時は変更だけ反映
            }
          }}
        />
      )}
    </>
  );
});

export default App;
