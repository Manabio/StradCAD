import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { runInAction } from 'mobx';
import { undoManager } from './undoManager.js';
import { serializeGraph, restoreGraph } from './graphSnapshot.js';
import { Stage, Layer, Group } from 'react-konva';
import { useStore, addFloor, switchFloor, saveToIDB, addAlternativeFloor, removeFloor } from './store.js';
import { isDirty } from './dirtyState.js';
import { LodLevel } from './viewport.js';
import { viewport } from './appViewport.js';
import {
  findCLMoveSnap,
  findBeamAxisMoveSnap,
  findBracketingCLs,
  findNearbyCenterLines,
  overhangMm,
  resolvePointerTargets,
  SNAP_THRESHOLD_PX,
} from './snap.js';
import { OpeningPanel } from './openings/OpeningPanel.jsx';
import { OpeningsLayer } from './renderer/OpeningsLayer.jsx';
import { placeOpeningWithDefaults, removeOpeningWithUndo } from './openings/openingEdit.js';
import { collectFloorOpeningGroups, assignOpeningNumbers, applyOpeningTags } from './openings/openingNumbering.js';
import { useLongPress }  from './interaction/useLongPress.js';
import { findColumnAxisLabel, findGutterCL } from './interaction/gutterHitTest.js';
import { FinishModeLayer } from './finish/FinishModeLayer.jsx';
import { RoomNameInput }   from './finish/RoomNameInput.jsx';
import { FinishSidebar }   from './finish/FinishSidebar.jsx';
import { FinishHalfModal } from './finish/FinishHalfModal.jsx';
import { StairLayer }      from './renderer/StairLayer.jsx';
import { floorHeightAbove } from './finish/stair/stairDimensions.js';
import { buildStairEntries, buildUpperStairPeekEntries } from './finish/stair/stairEntries.js';
import { interiorWallSpans } from './finish/edgeClassify.js';
import { runFinishEntryBoundary, runFinishExitBoundary } from './finish/finishBoundary.js';
import { RoomLabelsLayer } from './renderer/RoomLabelsLayer.jsx';
import { StepSectionLayer } from './renderer/StepSectionLayer.jsx';
import { VoidLayer } from './renderer/VoidLayer.jsx';
import { computeVoidCrosses } from './finish/voidGeometry.js';
import { StructuralLayer, ColumnsLayer } from './renderer/StructuralLayer.jsx';
import { MemberTagLayer } from './renderer/MemberTagLayer.jsx';
import { MemberStatusMenu } from './ui/MemberStatusMenu.jsx';
import { PRIMARY_DIMENSION_FIELD_BY_MAP } from './structural/memberCatalog.js';
import { CONTEXT, detectContext, buildMenuState } from './interaction/menuItems.js';
import { CenterLineType, OpeningCategory, centerLineKind } from '@core';
import { addSkipZero, subtractSkipZero, makeFloorName, makeFloorLevelPrefix, renameFloor } from './floorNumber.js';
import {
  floorBytesEqual, applyFloorBytes, isActiveAnAltOf,
  computeFloorReorder, computeAltReorder, resolveChipReorderTarget, computeFloorChangeReorder,
} from './floorOps.js';
import { AddFloorDialog } from './ui/AddFloorDialog.jsx';
import { buildFloorChipModel } from './ui/floorChipModel.js';
import { ConfirmDialog } from './ui/ConfirmDialog.jsx';
import { FloorChangeDialog } from './ui/FloorChangeDialog.jsx';
import { IntersectionMarkers } from './renderer/CenterLinesLayer.jsx';
import { GutterLayer } from './renderer/GutterLayer.jsx';
import { ShapesLayer }    from './renderer/ShapesLayer.jsx';
import { SnapIndicator }  from './renderer/SnapIndicator.jsx';
import { LongPressIndicator } from './renderer/LongPressIndicator.jsx';
import { DrawPreview }    from './renderer/DrawPreview.jsx';
import { CLAddPreview }   from './renderer/CLAddPreview.jsx';
import { CLMoveInput } from './renderer/CLMoveInput.jsx';
import { roundAbsToStep } from './renderer/clMoveMath.js';
import { AxisFaceInput }     from './renderer/AxisFaceInput.jsx';
import { RadialMenu }     from './ui/RadialMenu.jsx';
import { AddCLDialog }    from './ui/AddCLDialog.jsx';
import { WallDialog }          from './ui/WallDialog.jsx';
import { WallRefIndicator }   from './renderer/WallRefIndicator.jsx';
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
import { readLocalAutosaveRaw, parseAutosaveData, writeLocalAutosave, parseOpenedFileBytes } from './storage/localSnapshot.js';
import { SiteInfoPanel }       from './ui/SiteInfoPanel.jsx';
import { SiteLinesLayer, SiteDrawPreview } from './renderer/SiteLinesLayer.jsx';
import {
  confirmSiteLineLen, confirmSiteTriangle, cycleSiteLineKind, commitSiteTapLine,
} from './transform/siteEdit.js';
import { composeUndoWithMergeChain } from './transform/centerLineMerge.js';
import { extendCenterLine, shortenCenterLine, canExtendCenterLine, canShortenCenterLine } from './transform/centerLineExtend.js';
import {
  commitCLMoveOp, commitStretchWithUndo, deleteCenterLineWithUndo,
  shouldSuggestWoodStructure, addCenterLineFromDialog,
} from './transform/centerLineOps.js';
import { HamburgerMenu }       from './ui/HamburgerMenu.jsx';
import { ModeBar }             from './ui/ModeBar.jsx';
import { FloorDrum }           from './ui/FloorDrum.jsx';
import { AltChip }             from './ui/AltChip.jsx';
import { FloorplanPalette }    from './renderer/FloorplanPalette.jsx';
import { TOP_BAR, INSET, inGutter as isInGutter } from './layout.js';
import { evalNumpadExpr } from './ui/numpadUtils.js';
import { EccentricityDialog } from './ui/EccentricityDialog.jsx';
import { KneeDropWallDialog } from './ui/KneeDropWallDialog.jsx';
import { resolveWallSpanKey, isEligibleWallSpan } from './finish/kneeDropWall.js';

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
  const [snapPoint,   setSnapPoint]   = useState(null);
  const [pressPos,    setPressPos]    = useState(null);
  const [menu,        setMenu]        = useState(null); // { pos, items, snap, worldPos, cl }
  const [statusMenu,  setStatusMenu]  = useState(null); // { entity, pos } | null — 部材タグ右クリック（適合状態の暫定トグル）
  const [memberFocusRequest, setMemberFocusRequest] = useState(null); // { mapName, tag, fieldKey, entityId } | null — 部材タグクリックで構造リストの該当寸法欄を開く（entityIdは「この部材」スコープの対象特定に使う）
  const [cursorWorld, setCursorWorld] = useState(null);
  const [cursorScreen,setCursorScreen]= useState({ x: 0, y: 0 });
  const [nearCL,         setNearCL]         = useState(null);
  const [nearCLEndpoint, setNearCLEndpoint] = useState(null); // { cl, side:'lo'|'hi' } | null
  const [nearWall,    setNearWall]    = useState(null);
  const [nearOpening, setNearOpening] = useState(null);
  const [clDialog,    setClDialog]    = useState(null); // { type, worldCoord }
  const [clPreview,   setClPreview]   = useState(null);
  const [wallDialog,     setWallDialog]     = useState(null); // { worldPos }
  const [eccDialog,      setEccDialog]      = useState(null); // { cl } — CL偏芯ダイアログ
  const [kneeDropWallDialog, setKneeDropWallDialog] = useState(null); // { spanKey, anchor } — 腰壁・垂れ壁ダイアログ
  const [floorDialog,    setFloorDialog]    = useState(null); // { isLowest }
  const [floorConfirm,   setFloorConfirm]   = useState(null); // { message, buttons, onSelect }
  const [floorChangeDlg, setFloorChangeDlg] = useState(null); // { planeId }
  const [isPanning,   setIsPanning]   = useState(false);
  const [scaleInput,      setScaleInput]      = useState(null); // null=非編集, string=編集中
  const [showCalibration, setShowCalibration] = useState(false);
  const [showSiteDialog,  setShowSiteDialog]  = useState(false);
  const [showBuildingInfoDialog, setShowBuildingInfoDialog] = useState(false);
  const [showStructuralInfoDialog, setShowStructuralInfoDialog] = useState(false);
  const [toast,           setToast]           = useState(null); // { msg, key }
  const [appMode,         setAppMode]         = useState('floorplan'); // 'floorplan' | 'finish' | 'structure' | 'site'
  const [structComposition, setStructComposition] = useState(null); // 構造モードの図面合成（自階床下材＋1つ下の階の柱）。各カテゴリの供給グラフを保持する
  // フロア切替時にモードを再ロードするためのトリガー
  const [activeFloorId,   setActiveFloorId]   = useState(project.activePlaneId);
  // 上階ビュー: 直下階の階段を peek して上階表現で描くための解決済みエントリ。
  // null=未解決（初回マウント・階/モード切替直後で peek 未完了）、配列=解決済み（空配列含む）。
  // 2a壁クリップ（stairUnderClips）の中間階ガードは null の間、安全側で判定不能扱いにする
  // （QA指摘: 切替直後の1フレームは前の階の値が残ってしまい中間階ガードが効かない）。
  const [upperStairEntries, setUpperStairEntries] = useState(null);
  // 直上階の吹抜け（feature=VOID）を peek して直下階（自階）へ投影表示するための×座標
  const [upperVoidCrosses, setUpperVoidCrosses] = useState([]);
  // CL偏芯の階またぎ連動（他階のIDBを直接更新）後に、直上階peek系のstateを再計算させるトリガー
  const [floorSyncTick, setFloorSyncTick] = useState(0);
  // 構造モードのスライダーで選択中の図面スロット key（`slotType:planeId`）。1平面に複数スロットが
  // 乗る（木造の基礎伏図＋1階伏図・S造のR階伏図＋小屋伏図）ため、planeId とは別に保持する。
  const [activeStructSlotKey, setActiveStructSlotKey] = useState(null);

  const drag          = useRef(null);
  const fileInputRef  = useRef(null);
  const pinch         = useRef(null);
  const touchTapRef   = useRef(null);
  const snapRef       = useRef(null);
  const nearCLRef     = useRef(null);
  const nearCLEndpointRef = useRef(null);
  const nearWallRef    = useRef(null);
  const nearOpeningRef = useRef(null);
  const drawDownRef       = useRef(null);
  const moveDownRef       = useRef(null); // CL移動: pointer-down 記録用
  const stretchDownRef    = useRef(null); // ストレッチ開始判定用: { clientX, clientY, snap }
  const gutterCLRef       = useRef(null); // ガター長押し中のCL
  const axisLabelRef      = useRef(null); // 柱芯ラベル長押し中: { cl, sx, sy }
  const finishDragDownRef = useRef(null); // 仕上げモード: pointerDown 座標
  const siteDrawDownRef   = useRef(null); // 敷地モード: ドラッグ開始スクリーン座標
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

  useEffect(() => { snapRef.current  = snapPoint; }, [snapPoint]);
  useEffect(() => { nearCLRef.current = nearCL;   }, [nearCL]);
  useEffect(() => { nearCLEndpointRef.current = nearCLEndpoint; }, [nearCLEndpoint]);
  useEffect(() => { nearWallRef.current    = nearWall;    }, [nearWall]);
  useEffect(() => { nearOpeningRef.current = nearOpening; }, [nearOpening]);

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

  // 上階ビュー: 直下階（elevation が1つ下の採用フロア）の階段を peek し、
  // 上階表現（全段）の描画用エントリへ解決する。階切替・モード切替で再計算する。
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
      if (!below || !active || (appMode !== 'finish' && appMode !== 'floorplan')) {
        if (!cancelled) setUpperStairEntries([]);
        return;
      }
      const temp = await floorSwapManager.peek(below, project.structGraph);
      if (cancelled) return;
      const floorHeight = active.elevation - below.elevation; // 直下階の階高
      setUpperStairEntries(buildUpperStairPeekEntries(temp, floorHeight));
    })();
    return () => { cancelled = true; };
  }, [appMode, activeFloorId, floorSyncTick]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (!above || !active || (appMode !== 'finish' && appMode !== 'floorplan')) {
        setUpperVoidCrosses([]);
        return;
      }
      const temp = await floorSwapManager.peek(above, project.structGraph);
      if (cancelled) return;
      setUpperVoidCrosses(computeVoidCrosses(temp));
    })();
    return () => { cancelled = true; };
  }, [appMode, activeFloorId, floorSyncTick]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ---- ガター通り芯 長押しフック ----
  // 長押し確定（500ms後）までの待ち時間を使い、押下直後（onStart）から移動範囲の
  // 計算を先読みしておく（通り芯の場合は他フロアのIDB読み込みを含むため非同期）。
  const gutterLongPress = useLongPress({
    onStart:  (sx, sy) => {
      setPressPos({ x: sx, y: sy });
      if (gutterCLRef.current) modeRef.current?.preloadMove(gutterCLRef.current);
    },
    onFire:   async () => {
      setPressPos(null);
      const cl = gutterCLRef.current;
      gutterCLRef.current = null;
      if (cl) {
        const err = await modeRef.current?.startMove(cl);
        if (err) setToast({ msg: err, key: Date.now() });
      }
    },
    onCancel: () => setPressPos(null),
  });

  // ---- 柱芯ラベル 長押しフック（構造モード・描画エリア内）----
  // 成立で出幅編集の静止入力窓を開く。窓位置はラベルのスクリーン座標に固定（動かない）。
  const axisLabelLongPress = useLongPress({
    onStart:  (sx, sy) => setPressPos({ x: sx, y: sy }),
    onFire:   () => {
      setPressPos(null);
      const hit = axisLabelRef.current;
      axisLabelRef.current = null;
      if (!hit) return;
      const structure  = graph.structureOverride ?? project.structuralInfo.mainStructure;
      const projection = project.structuralInfo.getColumnFaceProjection(structure, hit.cl);
      modeRef.current?.startAxisEdit?.({ cl: hit.cl, structure, screenX: hit.sx, screenY: hit.sy, projection });
    },
    onCancel: () => setPressPos(null),
  });

  // ---- 長押しフック ----
  const longPress = useLongPress({
    onStart:  (sx, sy) => setPressPos({ x: sx, y: sy }),
    onFire:   (sx, sy) => {
      setPressPos(null);
      stretchDownRef.current = null; // ストレッチ意図をキャンセルしてメニューを開く
      const snap         = snapRef.current;
      const clEndpoint   = nearCLEndpointRef.current;
      const cl           = nearCLRef.current;
      const opening      = nearOpeningRef.current;
      const wall         = nearWallRef.current;
      // context 判定・メニュー items 生成は menuItems.js に集約（建具モードは壁・開口以外は null）。
      // menuItems.js は import ゼロ（node:test対応）に保つため、graph 依存の判定値はここで算出して渡す。
      const menuContext = detectContext(snap, cl, opening, wall, clEndpoint);
      const state = buildMenuState(appMode, {
        snap, cl, clEndpoint, opening, wall,
        canMove: typeof modeRef.current?.startMove === 'function',
        canExtend:  clEndpoint ? canExtendCenterLine(graph, clEndpoint.cl, clEndpoint.side) : undefined,
        canShorten: clEndpoint ? canShortenCenterLine(graph, clEndpoint.cl, clEndpoint.side) : undefined,
        hasInteriorWall: menuContext === CONTEXT.CENTER_LINE ? interiorWallSpans(graph, cl.id).length > 0 : undefined,
        wallEligible:    menuContext === CONTEXT.WALL ? isEligibleWallSpan(wall, graph) : undefined,
      });
      if (!state) return;
      // 移動を選ばれたときに備え、移動範囲の計算（他フロアのIDB読み込みを含む）を先読みしておく。
      if (state.clState?.canMove) modeRef.current.preloadMove(cl);
      setMenu({
        pos: { x: sx, y: sy }, items: state.items, snap, worldPos: viewport.screenToWorld(sx, sy),
        cl: clEndpoint ? clEndpoint.cl : cl, wall, opening,
        clEndpointSide: clEndpoint ? clEndpoint.side : null,
      });
    },
    onCancel: () => { setPressPos(null); stretchDownRef.current = null; },
  });

  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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
  performUndoRef.current = performUndo;
  performRedoRef.current = performRedo;

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
      siteDrawDownRef.current = null;
      stretchDownRef.current = null;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- ホイールズーム ----
  const handleWheel = (e) => {
    e.evt.preventDefault();
    const factor = e.evt.deltaY < 0 ? 1.1 : 1 / 1.1;
    viewport.zoomAt(e.evt.clientX, e.evt.clientY, factor);
    updateSnap(e.evt.clientX, e.evt.clientY);
  };

  // ---- ポインタ Down ----
  const handlePointerDown = (e) => {
    const { clientX, clientY } = e.evt;
    if (e.evt.touches) return;
    if (menu) return;

    // ---- 仕上げモード ----
    if (appMode === 'finish') {
      const inGutter = isInGutter(clientX, clientY, size.width, size.height);
      if (inGutter) {
        drag.current = { lastX: clientX, lastY: clientY };
        setIsPanning(true);
      } else {
        finishDragDownRef.current = { x: clientX, y: clientY };
        const world = viewport.screenToWorld(clientX, clientY);
        modeRef.current?.startDrag(world.x, world.y);
      }
      return;
    }

    // ---- 敷地モード ----
    if (appMode === 'site') {
      const inGutter = isInGutter(clientX, clientY, size.width, size.height);
      if (inGutter) {
        drag.current = { lastX: clientX, lastY: clientY };
        setIsPanning(true);
      } else {
        const sm = modeRef.current?.subMode;
        if (sm === 'sansha' || sm === 'other') {
          // ドラッグかタップかを pointerUp で判定するために記録
          siteDrawDownRef.current = { x: clientX, y: clientY };
          drag.current = { lastX: clientX, lastY: clientY };
        }
      }
      return;
    }

    if (modeRef.current?.moveState) {
      moveDownRef.current = { x: clientX, y: clientY };
      return;
    }
    if (modeRef.current?.drawState) {
      drawDownRef.current = { x: clientX, y: clientY };
      return;
    }
    // 構造モード: 描画エリア内の○「柱芯」ラベルをロングタップ → 出幅編集（ガター判定より先）
    if (appMode === 'structure' && columnAxisMode) {
      const hit = findColumnAxisLabel(graph, viewport, size.width, size.height, clientX, clientY);
      if (hit) {
        axisLabelRef.current = { cl: hit.cl, sx: hit.sx, sy: hit.sy };
        axisLabelLongPress.begin(clientX, clientY);
        return;
      }
    }
    const inGutter = isInGutter(clientX, clientY, size.width, size.height);
    if (inGutter) {
      const cl = findGutterCL(graph, viewport, size.width, size.height, clientX, clientY);
      if (cl) {
        gutterCLRef.current = cl;
        gutterLongPress.begin(clientX, clientY);
      } else {
        drag.current = { lastX: clientX, lastY: clientY };
        setIsPanning(true);
      }
      return;
    }
    // 交点スナップ中なら押下位置を記録（移動閾値超えでストレッチへ）
    if (snapRef.current) stretchDownRef.current = { clientX, clientY, snap: snapRef.current };
    longPress.begin(clientX, clientY);
  };

  // ---- ポインタ Move ----
  const handlePointerMove = (e) => {
    const { clientX, clientY } = e.evt;
    if (menu) return;

    // ---- 仕上げモード ----
    if (appMode === 'finish') {
      if (drag.current) {
        const dx = clientX - drag.current.lastX;
        const dy = clientY - drag.current.lastY;
        drag.current.lastX = clientX;
        drag.current.lastY = clientY;
        viewport.pan(dx, dy);
        return;
      }
      if (finishDragDownRef.current && modeRef.current?.dragState) {
        const world = viewport.screenToWorld(clientX, clientY);
        modeRef.current?.updateDrag(world.x, world.y);
      }
      return;
    }

    // ---- 敷地モード ----
    if (appMode === 'site') {
      if (drag.current) {
        const dx = clientX - drag.current.lastX;
        const dy = clientY - drag.current.lastY;
        drag.current.lastX = clientX;
        drag.current.lastY = clientY;
        viewport.pan(dx, dy);
      }
      // 始点確定後はドラッグ中でもマウス位置でプレビューを更新する
      if (modeRef.current?.siteDrawState) {
        const world = viewport.screenToWorld(clientX, clientY);
        modeRef.current.updateSiteDraw(world.x, world.y);
      }
      return;
    }

    // パン中
    if (drag.current) {
      const dx = clientX - drag.current.lastX;
      const dy = clientY - drag.current.lastY;
      drag.current.lastX = clientX;
      drag.current.lastY = clientY;
      viewport.pan(dx, dy);
      setSnapPoint(null);
      setCursorWorld(null);
      return;
    }

    // ---- ガターCL 長押し待機中 ----
    if (gutterCLRef.current) {
      const shouldPan = gutterLongPress.move(clientX, clientY);
      if (shouldPan) {
        gutterCLRef.current = null;
        drag.current = { lastX: clientX, lastY: clientY };
        setIsPanning(true);
      }
      return;
    }

    // ---- 柱芯ラベル 長押し待機中（閾値超過で長押しキャンセル）----
    if (axisLabelRef.current) {
      if (axisLabelLongPress.move(clientX, clientY)) axisLabelRef.current = null;
      return;
    }

    // ---- CL 移動モード ----
    const ms = modeRef.current?.moveState;
    if (ms) {
      const world = viewport.screenToWorld(clientX, clientY);
      const cl    = ms.cl;
      const isV   = cl.centerLineType === 'X';
      const rawVal  = isV ? world.x : world.y;
      const snapVal = appMode === 'structure' && centerLineKind(cl) === 'beam'
        ? findBeamAxisMoveSnap(graph, cl, world.x, world.y, SNAP_THRESHOLD_PX, viewport.scaleX, viewport.scaleY)
        : findCLMoveSnap(graph, cl, world.x, world.y, SNAP_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
      const candidate = snapVal ?? roundAbsToStep(rawVal, cl, isV, viewport.scaleDenominator, graph, appMode === 'structure');
      const newVal  = Math.min(Math.max(candidate, ms.range.min), ms.range.max);
      // 不正なスクリーン座標（clientX/Y欠落等）由来のNaNが cl.pendingDelta を汚さないようにする防御。
      // 一度 pendingDelta が NaN になると effectiveValue も NaN 化し、以後の originalValue 比較
      // （NaN !== 何であっても常に真）で確定分岐を誤らせる・再解決が壊れるおそれがあるため。
      if (Number.isFinite(newVal)) modeRef.current?.updateMove(newVal);
      setCursorWorld(world);
      setCursorScreen({ x: clientX, y: clientY });
      // スナップインジケータ: 他CLにスナップ中（かつ可動範囲内）は表示
      setSnapPoint(snapVal != null && snapVal === newVal
        ? { x: isV ? newVal : world.x, y: isV ? world.y : newVal }
        : null
      );
      return;
    }

    // ---- ストレッチモード（交点・自由点の 2D ドラッグ）----
    const ss = modeRef.current?.stretchState;
    if (ss) {
      const world = viewport.screenToWorld(clientX, clientY);
      const { type, vertex } = ss.target;
      let finalX = world.x;
      let finalY = world.y;
      if (type === 'intersection') {
        const snapX = findCLMoveSnap(graph, vertex.clVertical,   world.x, world.y, SNAP_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
        const snapY = findCLMoveSnap(graph, vertex.clHorizontal, world.x, world.y, SNAP_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
        finalX = snapX ?? world.x;
        finalY = snapY ?? world.y;
        setSnapPoint((snapX != null || snapY != null) ? { x: finalX, y: finalY } : null);
      } else {
        setSnapPoint(null);
      }
      modeRef.current.updateStretch(finalX, finalY);
      setCursorWorld(world);
      setCursorScreen({ x: clientX, y: clientY });
      return;
    }

    // ---- 描画モード ----
    if (modeRef.current?.drawState) {
      if (drawDownRef.current) {
        const ddx = clientX - drawDownRef.current.x;
        const ddy = clientY - drawDownRef.current.y;
        if (Math.hypot(ddx, ddy) > 8) {
          drag.current = { lastX: clientX, lastY: clientY };
          drawDownRef.current = null;
          setIsPanning(true);
          return;
        }
      }
      updateSnap(clientX, clientY);
      return;
    }

    // ---- 通常モード ----
    // ストレッチ起動判定: 交点近傍からのドラッグを検出して longPress パンより優先
    if (stretchDownRef.current) {
      const { clientX: dX, clientY: dY, snap } = stretchDownRef.current;
      if (Math.hypot(clientX - dX, clientY - dY) > 8) {
        stretchDownRef.current = null;
        if (snap) {
          const shapes = graph?.getShapesAtNode(snap) ?? [];
          const target = { type: 'intersection', vertex: snap, shapes };
          longPress.abort();
          modeRef.current?.startStretch(target);
          // 起動フレームで即座に位置更新
          const world = viewport.screenToWorld(clientX, clientY);
          const snapX = findCLMoveSnap(graph, snap.clVertical,   world.x, world.y, SNAP_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
          const snapY = findCLMoveSnap(graph, snap.clHorizontal, world.x, world.y, SNAP_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
          modeRef.current?.updateStretch(snapX ?? world.x, snapY ?? world.y);
          setCursorWorld(world);
          setCursorScreen({ x: clientX, y: clientY });
          setSnapPoint((snapX != null || snapY != null) ? { x: snapX ?? world.x, y: snapY ?? world.y } : null);
          return;
        }
        // snap なし → パンへフォールバック
        drag.current = { lastX: clientX, lastY: clientY };
        setIsPanning(true);
        return;
      }
    }

    const shouldPan = longPress.move(clientX, clientY);
    if (shouldPan) {
      stretchDownRef.current = null;
      drag.current = { lastX: clientX, lastY: clientY };
      setIsPanning(true);
      return;
    }
    updateSnap(clientX, clientY);
  };

  // CL移動確定の実処理は transform/centerLineOps.js の commitCLMoveOp。ここは toast 反映と commitMove() のみ
  // （ドラッグ確定=handlePointerUp・NumPad/Enter確定=CLMoveInput onCommit の単一実装。全経路で最後に
  // commitMove() を呼ぶこと——片方だけ直すと確定経路によって挙動が食い違うバグになる）。
  function commitCLMove(cl, originalValue) {
    const { toast } = commitCLMoveOp(graph, project, cl, originalValue);
    if (toast) setToast({ msg: toast, key: Date.now() });
    modeRef.current?.commitMove();
  }

  // ---- ポインタ Up ----
  const handlePointerUp = (e) => {
    // ---- 仕上げモード ----
    if (appMode === 'finish') {
      if (finishDragDownRef.current && modeRef.current?.dragState) {
        modeRef.current?.commitDrag();
      }
      finishDragDownRef.current = null;
      drag.current = null;
      setIsPanning(false);
      return;
    }

    // ---- 敷地モード ----
    if (appMode === 'site') {
      drag.current = null;
      setIsPanning(false);
      const downPt = siteDrawDownRef.current;
      siteDrawDownRef.current = null;
      if (!downPt) return;
      const { clientX, clientY } = e.evt;
      const moved = Math.hypot(clientX - downPt.x, clientY - downPt.y);
      if (moved >= 10) {
        // ドラッグ → パン完了。描画状態はそのまま維持（パン後も続けて終点をクリックできる）
        return;
      }
      // タップ確定
      const sm = modeRef.current?.subMode;
      if (sm !== 'sansha' && sm !== 'other') return;
      const world = viewport.screenToWorld(clientX, clientY);
      if (!modeRef.current.siteDrawState) {
        if (project.site.lines.length === 0) {
          // 線分が1本もない場合のみ始点確定（三斜入力の最初の1本）
          modeRef.current.startSiteDraw(world.x, world.y);
        } else {
          // 線分が存在する場合: 空白クリック = 選択解除
          modeRef.current.clearSelection();
        }
      } else {
        // 2クリック目: 終点確定 → 線分追加（pointermove が発火しないタップ操作でも
        // 確実に2点目の座標を反映させるため、commit前に終点を更新する）
        modeRef.current.updateSiteDraw(world.x, world.y);
        const result = modeRef.current.commitSiteDraw();
        if (result) {
          const { startWorld, endWorld } = result;
          const { lineId } = commitSiteTapLine(project, viewport, sm, startWorld, endWorld);
          // 三斜入力: 線分aを自動選択し、線分長さ入力欄にフォーカス
          if (sm === 'sansha') {
            modeRef.current.selectLine(lineId);
          }
        }
      }
      return;
    }

    // ---- ストレッチ確定 ----
    const ss = modeRef.current?.stretchState;
    if (ss) {
      commitStretchWithUndo(ss);
      modeRef.current.commitStretch();
      stretchDownRef.current = null;
      drag.current = null;
      return;
    }

    const ms2 = modeRef.current?.moveState;
    if (ms2) {
      const { cl, originalValue } = ms2;
      // ドラッグ中は cl.value が未変更 — effectiveValue（= value + pendingDelta）が実位置
      const newValue = cl.effectiveValue;
      // CL が実際に動いた か、明示的な再プレスがあった場合のみ確定
      if (moveDownRef.current || newValue !== originalValue) {
        commitCLMove(cl, originalValue);
        moveDownRef.current = null;
        drag.current = null;
        return;
      }
      // 長押し直後の離し（移動なし）→ 移動モードを維持
      moveDownRef.current = null;
      return;
    }
    moveDownRef.current = null;

    // 平面モード: 通常タップで開口を選択（パレット表示）/ 空白タップで選択解除。
    // 建具モード: 通常タップで開口を選択（パネルに姿図・フォームを表示）/ 空白タップで選択解除。
    // 描画・移動・パン・長押しメニュー中は対象外。
    if ((appMode === 'floorplan' || appMode === 'opening') && !menu && !drag.current
        && !drawDownRef.current && !modeRef.current?.moveState && !modeRef.current?.drawState) {
      modeRef.current?.selectOpening?.(nearOpeningRef.current?.id ?? null);
    }

    // 描画モード: タップで完成
    if (modeRef.current?.drawState && !drag.current && drawDownRef.current) {
      const snap  = snapRef.current;
      const world = viewport.screenToWorld(e.evt.clientX, e.evt.clientY);
      const shape = modeRef.current?.completeDraw(snap, world);
      if (shape) {
        undoManager.push(
          () => graph.removeShape(shape.id),
          () => graph.addDiagonalLine(shape.nodeA, shape.nodeB),
        );
      }
    }
    drawDownRef.current    = null;
    stretchDownRef.current = null;
    longPress.abort();
    gutterLongPress.abort();
    gutterCLRef.current = null;
    axisLabelLongPress.abort();
    axisLabelRef.current = null;
    drag.current = null;
    setIsPanning(false);
  };

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
    if (id === 'site-info')      { setShowSiteDialog(true);       return; }
    if (id === 'building-info')  { setShowBuildingInfoDialog(true); return; }
    if (id === 'open') {
      fileInputRef.current?.click();
      return;
    }
    if (id === 'save') {
      saveToIDB()
        .then(() => setToast({ msg: '保存しました', key: Date.now() }))
        .catch(() => setToast({ msg: '保存に失敗しました', key: Date.now() }));
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

  function handleFileOpen(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const bytes = new Uint8Array(ev.target.result);
        restoreGraph(graph, parseOpenedFileBytes(bytes));
        setToast({ msg: 'ファイルを開きました', key: Date.now() });
      } catch {
        setToast({ msg: 'ファイルの読み込みに失敗しました', key: Date.now() });
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ---- ポインタ Leave (外アップ扱い) ----
  const handlePointerLeave = () => {
    if (appMode === 'finish') {
      modeRef.current?.cancelDrag();
      finishDragDownRef.current = null;
      drag.current = null;
      setIsPanning(false);
      return;
    }
    if (appMode === 'site') {
      modeRef.current?.cancelSiteDraw();
      siteDrawDownRef.current = null;
      drag.current = null;
      setIsPanning(false);
      return;
    }
    // CL移動中にキャンバス外に出たらキャンセル
    if (modeRef.current?.moveState) {
      moveDownRef.current = null;
      modeRef.current?.cancelMove();
      drag.current = null;
      setSnapPoint(null);
      setCursorWorld(null);
      return;
    }
    drawDownRef.current = null;
    longPress.abort();
    gutterLongPress.abort();
    gutterCLRef.current = null;
    axisLabelLongPress.abort();
    axisLabelRef.current = null;
    drag.current = null;
    setIsPanning(false);
    setSnapPoint(null);
    setNearCL(null);
    setNearWall(null);
    setNearOpening(null);
    setCursorWorld(null);
  };

  // ---- タッチ: マルチ指タップ検出 ----
  const handleTouchStart = (e) => {
    const count = e.evt.touches.length;
    if (count === 2 || count === 3) {
      touchTapRef.current = { count, time: Date.now() };
    } else {
      touchTapRef.current = null;
    }
  };

  // ---- タッチ: ピンチズーム ----
  const handleTouchMove = (e) => {
    e.evt.preventDefault();
    const touches = e.evt.touches;
    if (touches.length >= 2) touchTapRef.current = null; // 動きあり → タップではない
    if (touches.length !== 2) return;
    const [t0, t1] = [touches[0], touches[1]];
    const midX = (t0.clientX + t1.clientX) / 2;
    const midY = (t0.clientY + t1.clientY) / 2;
    const dist  = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    if (pinch.current) {
      viewport.zoomAt(midX, midY, dist / pinch.current.dist);
      viewport.pan(midX - pinch.current.midX, midY - pinch.current.midY);
    }
    pinch.current = { dist, midX, midY };
  };

  const handleTouchEnd = (e) => {
    if (e.evt.touches.length < 2) pinch.current = null;

    // マルチ指タップ判定: 全指が離れたとき
    const tap = touchTapRef.current;
    if (tap && e.evt.touches.length === 0) {
      const elapsed = Date.now() - tap.time;
      if (elapsed < 300) {
        if (tap.count === 2) performUndo();
        else if (tap.count === 3) performRedo();
      }
      touchTapRef.current = null;
    }
  };

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

  // ---- スナップ & 近傍CL/壁/開口 計算 ----
  // 候補解決は snap.js の resolvePointerTargets に一本化（App側は setState への反映のみ）。
  function updateSnap(clientX, clientY) {
    const r = resolvePointerTargets(graph, viewport, clientX, clientY, { width: size.width, height: size.height, appMode });
    setSnapPoint(r.snap);
    setNearCL(r.nearCL);
    setNearCLEndpoint(r.nearCLEndpoint);
    setNearWall(r.nearWall);
    setNearOpening(r.nearOpening);
    setCursorWorld(r.world);
    // ガター帯内（r.world===null）はカーソル座標を更新しない（従来どおり）
    if (r.world) setCursorScreen({ x: clientX, y: clientY });
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
      deleteCenterLineWithUndo(graph, project, menu.cl);
      return;
    }
    if (item.id === 'cl-ecc') {
      setEccDialog({ cl: menu.cl });
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

  // ---- 実スケール適用 ----
  function applyScaleInput() {
    const d = parseInt(scaleInput, 10);
    if (d > 0) {
      viewport.zoomAt(size.width / 2, size.height / 2, viewport.scaleDenominator / d);
    }
    setScaleInput(null);
  }

  const isLandscape = size.width > size.height;

  const isDrawing  = mode?.isDrawing  ?? false;
  const isMoving   = mode?.isMoving   ?? false;
  const isDragging = mode?.isDragging ?? false;

  const cursor = menu || clDialog ? 'default'
               : isPanning        ? 'grabbing'
               : appMode === 'finish' ? (isDragging ? 'crosshair' : 'default')
               : appMode === 'site'   ? (mode?.siteDrawState ? 'crosshair' : 'default')
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
      appMode, viewport, upperStairEntriesPeek: upperStairEntries,
      stairBreakOverhangMm: overhangMm(viewport, false), // stairEntries.js は snap.js に依存しないため、ここで算出して渡す
    });

  return (
    <>
      {/* Undo/Redo ボタン — 左上 */}
      <div style={{
        position: 'fixed', top: 0, left: 6,
        height: TOP_BAR, display: 'flex', alignItems: 'center', gap: 2, zIndex: 200,
      }}>
        {[
          { label: '↩', title: '元に戻す (Ctrl+Z / 2本指タップ)', can: undoManager.canUndo, action: () => performUndo() },
          { label: '↪', title: 'やり直す (Ctrl+Y / 3本指タップ)', can: undoManager.canRedo, action: () => performRedo() },
        ].map(({ label, title, can, action }) => (
          <button
            key={label}
            onClick={action}
            disabled={!can}
            title={title}
            style={{
              width: 32, height: 32, borderRadius: 8,
              border: '1px solid #e2e8f0',
              background: can ? '#fff' : '#f8fafc',
              color: can ? '#334155' : '#cbd5e1',
              fontSize: 16, cursor: can ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              lineHeight: 1,
            }}
          >
            {label}
          </button>
        ))}
      </div>

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
        accept=".strad,application/json"
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
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{ cursor }}
        >
          <Layer name="world">
            {/* ガーターレイヤー（通り芯本体・丸ラベル・通り芯寸法）— window全体・クリップなし・描画エリアと同倍率 */}
            <Group
              x={viewport.offsetX}
              y={viewport.offsetY}
              scaleX={viewport.scaleX}
              scaleY={viewport.scaleY}
            >
              {appMode !== 'site' && <GutterLayer
                graph={graph}
                viewport={viewport}
                width={size.width}
                height={size.height}
                columnAxisMode={columnAxisMode}
                appMode={appMode}
              />}
            </Group>

            {/* 描画域を通り芯表示エリアの内側にクリップ（上端はツールバー＋上ガター分だけ下げる） */}
            <Group
              clipX={INSET.left}
              clipY={INSET.top}
              clipWidth={size.width  - INSET.left - INSET.right}
              clipHeight={size.height - INSET.top - INSET.bottom}
            >
              <Group
                x={viewport.offsetX}
                y={viewport.offsetY}
                scaleX={viewport.scaleX}
                scaleY={viewport.scaleY}
              >
                {appMode === 'finish' && mode && (
                  <FinishModeLayer
                    graph={graph}
                    viewport={viewport}
                    selectedRoomId={mode.selectedRoomId}
                    previewCells={mode.previewCells}
                  />
                )}
                {isStairMode && (
                  <StairLayer
                    entries={[...installEntries, ...upperEntries]}
                    viewport={viewport}
                    detail={viewport.lodLevel === LodLevel.DETAIL}
                    laneGapMm={stairLaneGapMm}
                    breakOverhangMm={stairBreakOverhangMm}
                    selectedStairId={appMode === 'finish' ? mode?.selectedStairId : null}
                    onSelectStair={appMode === 'finish' ? (id => modeRef.current?.selectStair(id)) : null}
                  />
                )}
                {appMode === 'site' && mode && (
                  <SiteLinesLayer
                    site={project.site}
                    viewport={viewport}
                    selectedLineId={mode.selectedLineId}
                    onSelectLine={id => modeRef.current?.selectLine(id)}
                  />
                )}
                {appMode === 'site' && <SiteDrawPreview mode={mode} />}
                {/* 構造モードでは平面図（壁・建具）を描画しない。通り芯と構造部材のみ表示する。 */}
                {appMode !== 'structure' && <ShapesLayer graph={graph} viewport={viewport} stairUnderClips={stairUnderClips} />}
                {appMode !== 'structure' && <OpeningsLayer graph={graph} viewport={viewport} selectedId={appMode === 'opening' ? mode?.selectedOpeningId : null} />}
                {/* 平面モードでは自階の柱（構造モードで生成・保存済み）を表示する。構造モードの伏図と違い
                    1つ下の階ではなく自階graphの柱を描く（その階の平面に立つ柱はその階のもの）。 */}
                {appMode === 'floorplan' && <ColumnsLayer graph={graph} viewport={viewport} />}
                {appMode === 'structure' && <StructuralLayer composition={structComposition} viewport={viewport} project={project} />}
                {appMode === 'structure' && (
                  <MemberTagLayer
                    composition={structComposition}
                    viewport={viewport}
                    onTagClick={(entity, mapName) => {
                      setShowStructuralInfoDialog(true);
                      setMemberFocusRequest({ mapName, tag: entity.memberNo, fieldKey: PRIMARY_DIMENSION_FIELD_BY_MAP[mapName] ?? null, entityId: entity.id });
                    }}
                    onStatusMenuRequest={(entity, pos) => setStatusMenu({ entity, pos })}
                  />
                )}
                {appMode === 'floorplan' && (
                  <RoomLabelsLayer
                    graph={graph}
                    viewport={viewport}
                    floorPrefix={makeFloorLevelPrefix(project.activePlane?.startFloor ?? 1)}
                  />
                )}
                {/* 段差断面: 段差線は全LOD（略図＝細線 / 標準・詳細＝中線）、ハッチ・寸法は詳細のみ
                    ——レイヤー内部でLOD分岐する */}
                {appMode === 'floorplan' && <StepSectionLayer graph={graph} viewport={viewport} />}
                {(appMode === 'floorplan' || appMode === 'finish') && (
                  <VoidLayer graph={graph} viewport={viewport} upperCrosses={upperVoidCrosses} />
                )}
                {appMode !== 'site' && <IntersectionMarkers graph={graph} viewport={viewport} />}
                <DrawPreview
                  drawState={mode?.drawState ?? null}
                  snapPoint={snapPoint}
                  cursorWorld={cursorWorld}
                />
                <CLAddPreview value={clPreview} type={clDialog?.type} />
              </Group>
            </Group>
          </Layer>

          <Layer name="overlay">
            {!menu && <SnapIndicator snap={snapPoint} viewport={viewport} />}
            {wallDialog && wallDialog.nearbyCLs?.length > 0 && (
              <WallRefIndicator
                nearbyCLs={wallDialog.nearbyCLs}
                worldPos={wallDialog.worldPos}
                viewport={viewport}
              />
            )}
            {clDialog && clDialog.nearbyCLs?.length > 0 && (
              <WallRefIndicator
                nearbyCLs={clDialog.nearbyCLs}
                worldPos={clDialog.worldPos}
                viewport={viewport}
              />
            )}
          </Layer>

          <Layer name="ui" />
        </Stage>
      </div>

      <div style={{
        position: 'fixed', bottom: 8, right: 12,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {/* 縮尺表示 / 入力 */}
        {scaleInput === null ? (
          <div
            onClick={() => setScaleInput(String(viewport.scaleDenominator))}
            title="クリックして縮尺を入力"
            style={{ fontSize: 12, color: '#666', cursor: 'pointer', userSelect: 'none' }}
          >
            1/{viewport.scaleDenominator}
          </div>
        ) : (
          <div style={{
            fontSize: 12, color: '#333',
            background: '#fff', border: '1px solid #94a3b8',
            borderRadius: 4, padding: '2px 6px',
            display: 'flex', alignItems: 'center', gap: 2,
          }}>
            1/
            <input
              value={scaleInput}
              onChange={e => setScaleInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter')  applyScaleInput();
                if (e.key === 'Escape') setScaleInput(null);
              }}
              onBlur={() => setScaleInput(null)}
              autoFocus
              style={{
                width: 52, fontSize: 12, border: 'none', outline: 'none',
                textAlign: 'right', padding: 0,
              }}
            />
          </div>
        )}
      </div>

      {/* 仕上げモード: 部屋名入力ポップアップ */}
      {appMode === 'finish' && mode?.namingRoomId && (() => {
        const room = graph.roomMap.get(mode.namingRoomId);
        return room ? (
          <RoomNameInput
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
        />
      )}

      {toast && (
        <div key={toast.key} className="cl-toast" onClick={() => setToast(null)}>
          {toast.msg}
        </div>
      )}

      {showCalibration && (
        <CalibrationDialog
          viewport={viewport}
          onClose={() => setShowCalibration(false)}
        />
      )}

      {showSiteDialog && (
        <SiteDialog onClose={() => setShowSiteDialog(false)} />
      )}

      {showBuildingInfoDialog && (
        <BuildingInfoDialog onClose={() => setShowBuildingInfoDialog(false)} />
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
