import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { runInAction } from 'mobx';
import { undoManager } from './undoManager.js';
import { serializeGraph, restoreGraph } from './graphSnapshot.js';
import { Stage, Layer, Group } from 'react-konva';
import { useStore, addFloor, switchFloor, saveToIDB, addAlternativeFloor, removeFloor } from './store.js';
import { isDirty } from './dirtyState.js';
import { serializeStructCLs, restoreStructCLs } from './graphSnapshot.js';
import { ERR_CL_DUPLICATE, ERR_CL_CENTER_UPGRADED, ERR_CL_STRUCT_EXISTS, ERR_STRUCT_MAIN_UNSPECIFIED } from './error.js';
import { Viewport, LodLevel } from './viewport.js';
import {
  findNearestIntersection,
  findNearestCenterLine,
  findNearestCenterLineEndpoint,
  findCLMoveSnap,
  findBracketingCLs,
  findNearbyCenterLines,
  findNearestWall,
  findOpeningAt,
  overhangMm,
} from './snap.js';
import { findHostWall } from './openings/openingGeometry.js';
import { OpeningDialog } from './ui/OpeningDialog.jsx';
import { OpeningsLayer } from './renderer/OpeningsLayer.jsx';
import { useLongPress }  from './interaction/useLongPress.js';
import { FinishModeLayer } from './finish/FinishModeLayer.jsx';
import { RoomNameInput }   from './finish/RoomNameInput.jsx';
import { FinishSidebar }   from './finish/FinishSidebar.jsx';
import { FinishHalfModal } from './finish/FinishHalfModal.jsx';
import { StairLayer }      from './renderer/StairLayer.jsx';
import { floorHeightAbove } from './finish/stair/stairDimensions.js';
import { measureStairSpans } from './finish/stair/stairClassify.js';
import { roomBounds }       from './finish/gridCells.js';
import { generateRoomWallsFromOutline, generateExteriorWalls, snapshotWall, restoreWallsFromSnapshots } from './finish/wallGeneration.js';
import { snapshotEdges, restoreEdges, syncEdgesFromTopology, buildCellToRoom } from './finish/edgeClassify.js';
import { EdgeSectionLayer } from './renderer/EdgeSectionLayer.jsx';
import { RoomLabelsLayer } from './renderer/RoomLabelsLayer.jsx';
import { StructuralLayer, ColumnsLayer } from './renderer/StructuralLayer.jsx';
import { MemberTagLayer } from './renderer/MemberTagLayer.jsx';
import { MemberStatusMenu } from './ui/MemberStatusMenu.jsx';
import { PRIMARY_DIMENSION_FIELD_BY_MAP } from './structural/memberCatalog.js';
import { detectContext, getMenuItems } from './interaction/menuItems.js';
import { CenterLineType, Discipline, SiteLineKind, OpeningCategory, centerLineKind } from '@core';
import { addSkipZero, subtractSkipZero, makeFloorName, renameFloor } from './floorNumber.js';
import { AddFloorDialog } from './ui/AddFloorDialog.jsx';
import { ConfirmDialog } from './ui/ConfirmDialog.jsx';
import { StructuralSyncDialog } from './ui/StructuralSyncDialog.jsx';
import { FloorChangeDialog } from './ui/FloorChangeDialog.jsx';
import { IntersectionMarkers } from './renderer/CenterLinesLayer.jsx';
import { GutterLayer, columnAxisLabelHits } from './renderer/GutterLayer.jsx';
import { ShapesLayer }    from './renderer/ShapesLayer.jsx';
import { SnapIndicator }  from './renderer/SnapIndicator.jsx';
import { LongPressIndicator } from './renderer/LongPressIndicator.jsx';
import { DrawPreview }    from './renderer/DrawPreview.jsx';
import { CLAddPreview }   from './renderer/CLAddPreview.jsx';
import { CLMoveInput, roundAbsToStep, calcStep } from './renderer/CLMoveInput.jsx';
import { AxisFaceInput }     from './renderer/AxisFaceInput.jsx';
import { RadialMenu }     from './ui/RadialMenu.jsx';
import { AddCLDialog }    from './ui/AddCLDialog.jsx';
import { WallDialog }          from './ui/WallDialog.jsx';
import { WallRefIndicator }   from './renderer/WallRefIndicator.jsx';
import { CalibrationDialog }  from './ui/CalibrationDialog.jsx';
import { SiteDialog }          from './ui/SiteDialog.jsx';
import { BuildingInfoDialog }  from './ui/BuildingInfoDialog.jsx';
import { StructuralPanel } from './structural/StructuralPanel.jsx';
import { autoFillColumns, autoFillColumnAxisOffsets, autoFillBeamEccentricity, autoFillColumnSizes, resolveLowestGraph, convertMembersToEffectiveMaterial, deleteClassificationOverflow, axisExteriorSign } from './structural/structuralAutoFill.js';
import { structureHasMemberKind, MEMBER_KIND } from './structural/structuralClassification.js';
import { buildStructuralWallGate, buildExteriorSide } from './structural/wallGate.js';
import { renumberAllCategories } from './structural/memberNumbering.js';
import { recomputeStructuralForGraph, analyzeStructuralOverflow, deleteOverflowMembers } from './structural/structuralRecompute.js';
import { syncRoofPlane } from './structural/roofPlane.js';
import { buildStructuralFigureSlots, designationForSlot, firstSlotKeyForPlane } from './structural/structuralFigureSlots.js';
import { figureBindingManager } from './figure/FigureBindingManager.js';
import { floorSwapManager } from './storage/FloorSwapManager.js';
import { saveFloor } from './storage/db.js';
import { getFigure } from './figure/figureRegistry.js';
import { STRUCTURAL_FIGURE_ID } from './structural/structuralFigure.js';
import { SiteInfoPanel }       from './ui/SiteInfoPanel.jsx';
import { SiteLinesLayer, SiteDrawPreview, computeSiteApex, pickRedPointId, getSiteLineRedBlue, computeApexSide } from './renderer/SiteLinesLayer.jsx';
import { findLineHistoryStep, recomputeSiteFromHistory, cloneHistory, computePendingQueue } from './transform/siteHistory.js';
import { mergeCenterLineChain, composeUndoWithMergeChain } from './transform/centerLineMerge.js';
import { extendCenterLine, shortenCenterLine, canExtendCenterLine, canShortenCenterLine } from './transform/centerLineExtend.js';
import { HamburgerMenu }       from './ui/HamburgerMenu.jsx';
import { ModeBar }             from './ui/ModeBar.jsx';
import { FloorDrum }           from './ui/FloorDrum.jsx';
import { AltChip }             from './ui/AltChip.jsx';
import { FloorplanPalette }    from './renderer/FloorplanPalette.jsx';
import { RULER, TOP_BAR, INSET, inGutter as isInGutter } from './layout.js';

const SNAP_THRESHOLD_PX = 20;
const CL_THRESHOLD_PX   = 8;
const WALL_THRESHOLD_PX = 8;

const viewport = new Viewport(window.innerWidth, window.innerHeight, RULER, RULER);

// CL の pendingDelta を実座標に bake する（ref CL / 通常 CL 両対応）
function evalExpr(s) {
  if (!s) return NaN;
  try {
    const expr = s.replace(/×/g, '*').replace(/÷/g, '/');
    if (/[+\-*/]$/.test(expr)) return NaN;
    const v = Function(`"use strict"; return (${expr})`)();
    return typeof v === 'number' && isFinite(v) && v > 0 ? v : NaN;
  } catch { return NaN; }
}

function bakeCLValue(cl, newVal) {
  if (cl.refId) {
    cl.refOffset = newVal - (cl._referencedCL?.value ?? cl._value);
  } else {
    cl.value = newVal;
  }
  cl.pendingDelta = 0;
}

const App = observer(() => {
  const project = useStore();
  const [size,        setSize]        = useState({ width: window.innerWidth, height: window.innerHeight });
  const [snapPoint,   setSnapPoint]   = useState(null);
  const [pressPos,    setPressPos]    = useState(null);
  const [menu,        setMenu]        = useState(null); // { pos, items, snap, worldPos, cl }
  const [statusMenu,  setStatusMenu]  = useState(null); // { entity, pos } | null — 部材タグ右クリック（適合状態の暫定トグル）
  const [memberFocusRequest, setMemberFocusRequest] = useState(null); // { mapName, tag, fieldKey } | null — 部材タグクリックで構造リストの該当寸法欄を開く
  const [cursorWorld, setCursorWorld] = useState(null);
  const [cursorScreen,setCursorScreen]= useState({ x: 0, y: 0 });
  const [nearCL,         setNearCL]         = useState(null);
  const [nearCLEndpoint, setNearCLEndpoint] = useState(null); // { cl, side:'lo'|'hi' } | null
  const [nearWall,    setNearWall]    = useState(null);
  const [nearOpening, setNearOpening] = useState(null);
  const [clDialog,    setClDialog]    = useState(null); // { type, worldCoord }
  const [clPreview,   setClPreview]   = useState(null);
  const [wallDialog,     setWallDialog]     = useState(null); // { worldPos }
  const [openingDialog,  setOpeningDialog]  = useState(null); // { wall, worldPos, category, existing }
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
  // 構造モード外部問合せ：フットプリント外に出た部材の整理セッション。
  // { floors:[{planeId, baseline, overflow}], autoCount, protectedCount, applied } / null
  const [structSync,      setStructSync]      = useState(null);
  const [structSyncOpen,  setStructSyncOpen]  = useState(false); // 整理ダイアログ開閉（閉じても structSync は保持し banner から再オープン可能）
  const [appMode,         setAppMode]         = useState('floorplan'); // 'floorplan' | 'finish' | 'structure' | 'site'
  const [structComposition, setStructComposition] = useState(null); // 構造モードの図面合成（自階床下材＋1つ下の階の柱）。各カテゴリの供給グラフを保持する
  // フロア切替時にモードを再ロードするためのトリガー
  const [activeFloorId,   setActiveFloorId]   = useState(project.activePlaneId);
  // 上階ビュー: 直下階の階段を peek して上階表現で描くための解決済みエントリ
  const [upperStairEntries, setUpperStairEntries] = useState([]);
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
            const s = new m.FinishModeState(graph);
            await s.init(); // 材データの動的ロード・照合
            return s;
          })
        : appMode === 'structure'
          ? import('./modes/StructuralModeState.js').then(m => new m.StructuralModeState(graph))
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
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const planes = project.planes; // elevation 昇順
      const active = project.activePlane;
      const idx = planes.findIndex(p => p.id === active?.id);
      const below = idx > 0 ? planes[idx - 1] : null;
      if (!below || !active || (appMode !== 'finish' && appMode !== 'floorplan')) {
        setUpperStairEntries([]);
        return;
      }
      const temp = await floorSwapManager.peek(below, project.structGraph);
      if (cancelled) return;
      const floorHeight = active.elevation - below.elevation; // 直下階の階高
      const entries = temp.stairs.map(s => ({
        id: s.id,
        stair: s,
        bounds: roomBounds(s.cells, temp),
        riser: s.riser ?? (floorHeight != null ? floorHeight / Math.max(1, s.totalSteps) : null),
        spans: measureStairSpans(s, temp), // セル実測の区間長（区間長指定の反映）
        view: 'upper',
        selectable: false,
      }));
      setUpperStairEntries(entries);
    })();
    return () => { cancelled = true; };
  }, [appMode, activeFloorId]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const context      = detectContext(snap, cl, opening, wall, clEndpoint);
      const endpointState = clEndpoint ? {
        canExtend:  canExtendCenterLine(graph, clEndpoint.cl, clEndpoint.side),
        canShorten: canShortenCenterLine(graph, clEndpoint.cl, clEndpoint.side),
      } : null;
      const items   = getMenuItems(context, endpointState);
      setMenu({
        pos: { x: sx, y: sy }, items, snap, worldPos: viewport.screenToWorld(sx, sy),
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

  // ESC / Ctrl+Z / Ctrl+Y
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undoManager.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); undoManager.redo(); return; }
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
      const hit = findColumnAxisLabel(clientX, clientY);
      if (hit) {
        axisLabelRef.current = { cl: hit.cl, sx: hit.sx, sy: hit.sy };
        axisLabelLongPress.begin(clientX, clientY);
        return;
      }
    }
    const inGutter = isInGutter(clientX, clientY, size.width, size.height);
    if (inGutter) {
      const cl = findGutterCL(clientX, clientY);
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
      const snapVal = findCLMoveSnap(graph, cl, world.x, world.y, SNAP_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
      const candidate = snapVal ?? roundAbsToStep(rawVal, cl, isV, viewport.scaleDenominator, graph);
      const newVal  = Math.min(Math.max(candidate, ms.range.min), ms.range.max);
      modeRef.current?.updateMove(newVal);
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
          const lineKind = sm === 'other' ? SiteLineKind.OTHER : SiteLineKind.SURVEY;
          let spId, epId, lineId, redPointId, sx, sy, ex, ey;
          runInAction(() => {
            const sp   = project.site.addPoint(startWorld.x, startWorld.y);
            const ep   = project.site.addPoint(endWorld.x,   endWorld.y);
            redPointId = pickRedPointId(sp, ep, viewport);
            const line = project.site.addLine(sp, ep, lineKind, undefined, redPointId);
            spId = sp.id; epId = ep.id; lineId = line.id;
            sx = sp.x; sy = sp.y; ex = ep.x; ey = ep.y;
            project.site.history.push({ type: 'base', lineId, length: line.length });
          });
          // 三斜入力: 線分aを自動選択し、線分長さ入力欄にフォーカス
          if (sm === 'sansha') {
            modeRef.current.selectLine(lineId);
          }
          undoManager.push(
            () => runInAction(() => {
              project.site.removeLine(lineId);
              project.site.removePoint(epId);
              project.site.removePoint(spId);
              project.site.history.pop();
            }),
            () => runInAction(() => {
              const sp2 = project.site.addPoint(sx, sy, spId);
              const ep2 = project.site.addPoint(ex, ey, epId);
              const line2 = project.site.addLine(sp2, ep2, lineKind, lineId, redPointId);
              project.site.history.push({ type: 'base', lineId, length: line2.length });
            }),
          );
        }
      }
      return;
    }

    // ---- ストレッチ確定 ----
    const ss = modeRef.current?.stretchState;
    if (ss) {
      const { target } = ss;
      if (target.type === 'intersection') {
        const clV = target.vertex.clVertical;
        const clH = target.vertex.clHorizontal;
        const newVVal  = clV.effectiveValue;
        const newHVal  = clH.effectiveValue;
        const origVVal = ss.originalVVal;
        const origHVal = ss.originalHVal;
        if (newVVal !== origVVal || newHVal !== origHVal) {
          runInAction(() => { bakeCLValue(clV, newVVal); bakeCLValue(clH, newHVal); });
          undoManager.push(
            () => runInAction(() => { bakeCLValue(clV, origVVal); bakeCLValue(clH, origHVal); }),
            () => runInAction(() => { bakeCLValue(clV, newVVal);  bakeCLValue(clH, newHVal);  }),
          );
        } else {
          runInAction(() => { clV.pendingDelta = 0; clH.pendingDelta = 0; });
        }
      } else {
        const pt   = target.vertex;
        const newX = pt.effectiveX, newY = pt.effectiveY;
        const origX = ss.originalX,  origY = ss.originalY;
        if (newX !== origX || newY !== origY) {
          runInAction(() => { pt.x = newX; pt.y = newY; pt.pendingDX = 0; pt.pendingDY = 0; });
          undoManager.push(
            () => runInAction(() => { pt.x = origX; pt.y = origY; }),
            () => runInAction(() => { pt.x = newX;  pt.y = newY;  }),
          );
        } else {
          runInAction(() => { pt.pendingDX = 0; pt.pendingDY = 0; });
        }
      }
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
        if (newValue !== originalValue) {
          let chainResult = { merged: false };
          runInAction(() => {
            bakeCLValue(cl, newValue);
            // 通り芯(labeled:true)は結合対象外。編集確定のたびに隣接する中心線との結合を確認する
            if (!cl.labeled) chainResult = mergeCenterLineChain(graph, cl, { kind: centerLineKind(cl) });
          });
          const [undoFn, redoFn] = composeUndoWithMergeChain(
            () => bakeCLValue(cl, originalValue),
            () => bakeCLValue(cl, newValue),
            chainResult,
          );
          undoManager.push(() => runInAction(undoFn), () => runInAction(redoFn));
        }
        moveDownRef.current = null;
        modeRef.current?.commitMove();
        drag.current = null;
        return;
      }
      // 長押し直後の離し（移動なし）→ 移動モードを維持
      moveDownRef.current = null;
      return;
    }
    moveDownRef.current = null;

    // 平面モード: 通常タップで開口を選択（パレット表示）/ 空白タップで選択解除。
    // 描画・移動・パン・長押しメニュー中は対象外。
    if (appMode === 'floorplan' && !menu && !drag.current
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

  // ---- 構造再計算コア（突入時・主構造変更時で共有）----
  // 既に activate 済みの composition を受け取り、構造伏図に映る全グラフ（自階＋1つ下の階）を再計算する。
  // mutate（主構造の変更操作）を渡すと、自階スナップショットの before 取得後・after 取得前に runInAction で
  // 実行し、主構造変更と部材の生成・材変換・採番をまとめて1つの undo エントリにする（override は graph
  // snapshot に含まれるため undo で戻る。建物全体既定値 mainStructure は project 側のため従来どおり対象外）。
  // 主構造変更時（mutate あり）は下階グラフ（伏図に映る柱の供給元）も同じ undo エントリで戻す。
  // 突入時（mutate なし）は自階 recompute の差分があるときだけ undo を積む（下階は表示用 peek＝undo 非対象。従来挙動を保持）。
  async function recomputeStructuralComposition(composition, subjectGraph, { mutate } = {}) {
    const before = serializeGraph(subjectGraph);
    if (mutate) runInAction(mutate);

    // 自階床下材＝subjectGraph、1つ下の階の柱＝belowGraph。基礎伏図（1つ下が無い）は belowGraph=null。
    const belowGraph = composition.graphForCategory('columnMap');
    const belowMainStructure = belowGraph
      ? belowGraph.structureOverride ?? project.structuralInfo.mainStructure
      : subjectGraph.structureOverride ?? project.structuralInfo.mainStructure;

    // 自階：自動補完・柱芯・材変換・材寸算定・採番（structuralRecompute.js。undo 非依存の純計算）。
    const { changed } = await recomputeStructuralForGraph(subjectGraph, project, belowMainStructure);

    // 1つ下の階（構造伏図に映る柱の供給元）も実効主構造へ揃える。突入時は belowGraph が読み取り専用 peek の
    // ため表示用（非永続）、主構造変更時は既に commit 済みで編集可能 peek のため恒久化される——これにより
    // 「主構造を変えても下階の柱が旧材のまま取り残される」不具合を解消する。convertMembersToEffectiveMaterial は
    // 既存の旧材を変換、autoFillColumns は未生成分を新材で生成する（差分のみ）。
    // 主構造変更時のみ下階の before/after を取り、自階と同じ undo エントリで一括復元する。
    let belowBefore = null, belowAfter = null;
    if (belowGraph) {
      const belowGate = await buildStructuralWallGate(belowGraph.plane, project, subjectGraph);
      const belowLowestGraph = await resolveLowestGraph(project, belowGraph);
      // belowMainStructure 引数は軒桁(eaves)専用。通常階の下階に eaves は無いため自階の実効値で十分。
      const belowBelowMainStructure = belowGraph.structureOverride ?? project.structuralInfo.mainStructure;
      if (mutate) belowBefore = serializeGraph(belowGraph);
      const belowStructure = belowGraph.structureOverride ?? project.structuralInfo.mainStructure;
      runInAction(() => {
        convertMembersToEffectiveMaterial(belowGraph, project, belowBelowMainStructure);
        // 主構造変更で柱が「×」化した場合は、下階の柱を生成せず既存の自動柱を削除する（問題.md「×は削除/○は生成」）。
        if (structureHasMemberKind(MEMBER_KIND.COLUMN, belowStructure)) autoFillColumns(belowGraph, project, belowGate);
        deleteClassificationOverflow(belowGraph, project);
        autoFillColumnAxisOffsets(belowGraph, project, belowLowestGraph);
        autoFillColumnSizes(belowGraph, project, belowGraph.plane);
        renumberAllCategories(belowGraph, project, false);
      });
      if (mutate) belowAfter = serializeGraph(belowGraph);
    }

    const after = serializeGraph(subjectGraph);
    if (mutate || changed) {
      undoManager.push(
        () => {
          restoreGraph(subjectGraph, before);
          if (belowBefore) restoreGraph(belowGraph, belowBefore);
        },
        () => {
          restoreGraph(subjectGraph, after);
          if (belowAfter) restoreGraph(belowGraph, belowAfter);
        },
      );
    }
  }

  // ---- 構造モード突入時のセットアップ（屋根平面同期・バインディング生成・再計算）----
  // handleModeChange('structure') と、構造モード中のフロア切替（onSwitchStructuralFloor）の両方から呼ぶ。
  async function runStructuralModeSetup(targetGraph) {
    const effectiveMainStructure = targetGraph.structureOverride ?? project.structuralInfo.mainStructure;
    if (effectiveMainStructure === '未定') {
      setToast({ msg: ERR_STRUCT_MAIN_UNSPECIFIED, key: Date.now() });
    }

    // 最上階の直上に屋根専用平面（小屋伏／R階伏）を同期する（undo対象外。建物形状が変わった時点でやり直し前提のインフラ）。
    runInAction(() => syncRoofPlane(project));

    // 図面合成（構造伏図＝自階床下材＋1つ下の階の柱）のバインディングを組み立てる。
    // 非アクティブな下階は FigureBindingManager 内部で floorSwapManager.peek() により読み取り専用に覗く
    // （graph.structureOverride はメモリ上信頼できないため。詳細は data-model.md / structural-model.md）。
    const composition = await figureBindingManager.activate(getFigure(STRUCTURAL_FIGURE_ID), targetGraph.plane, targetGraph, project);

    // 自階＋下階の再計算（突入時・主構造変更時で共有する純計算コア）。
    await recomputeStructuralComposition(composition, targetGraph);

    setStructComposition(composition);
    // 下階の柱は、その伏図の構造リストから編集する（描画対象＝編集対象を一致させる）。
    // 表示用 autofill 完了後に commit して secondaryEdit バインディング（下階）を編集可能 peek 化する。
    // 基礎伏図（下階なし）は secondaryEdit バインディングが無く編集チャネルは張られない。
    figureBindingManager.commit(composition);
  }

  // ---- 構造モードへの外部問合せ（階追加・仕上げ退出時に、構造モードに入らず構造部材を更新する）----
  // mainStructure は屋根平面（軒桁）でのみ意味を持つが、ここでの対象は常に実体階なので自階の実効値でよい。

  // アクティブな graph を再計算し、変化があれば undo に積む（通常の auto-save に乗る）。
  // 再計算後（削除前）の baseline と、フットプリント外に出た部材（overflow）を返す。
  async function recomputeActiveStructural() {
    const g = project.activeGraph;
    const mainStructure = g.structureOverride ?? project.structuralInfo.mainStructure;
    const { changed, before, after } = await recomputeStructuralForGraph(g, project, mainStructure);
    if (changed) {
      undoManager.push(
        () => restoreGraph(g, before),
        () => restoreGraph(g, after),
      );
    }
    const overflow = await analyzeStructuralOverflow(g, project);
    return { planeId: g.plane.id, baseline: serializeGraph(g), overflow };
  }

  // 非アクティブな実体階を peek して再計算し、変化があれば IDB に直接保存する。
  // syncRoofPlane と同格の「建物形状が変わった時点でやり直すインフラ」として undo 対象外で割り切る
  // （跨ぎフロア undo は単一アクティブ graph モデルでは扱えないため。削除の取消はベースライン保持で担保する）。
  // 再計算後（削除前）の baseline と overflow を返す。
  async function recomputeInactiveStructural(plane) {
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    const mainStructure = temp.structureOverride ?? project.structuralInfo.mainStructure;
    const { changed } = await recomputeStructuralForGraph(temp, project, mainStructure);
    if (changed) await saveFloor(plane.id, serializeGraph(temp));
    const overflow = await analyzeStructuralOverflow(temp, project);
    return { planeId: plane.id, baseline: serializeGraph(temp), overflow };
  }

  // 収集した各階の overflow を集計し、フットプリント外部材があれば整理ダイアログを開く。
  function promptStructSyncIfOverflow(collected) {
    const floors = collected.filter(f => f.overflow.length > 0);
    if (floors.length === 0) { setStructSync(null); setStructSyncOpen(false); return; }
    const autoCount      = floors.reduce((n, f) => n + f.overflow.filter(m => !m.protected).length, 0);
    const protectedCount = floors.reduce((n, f) => n + f.overflow.filter(m =>  m.protected).length, 0);
    setStructSync({ floors, autoCount, protectedCount, applied: 'keep' });
    setStructSyncOpen(true);
  }

  // 要件1：階追加後。追加で N（負担階数）・基礎指定が変わるため、全実体階の構造部材を更新する。
  // アクティブ（追加直後の表示階）は undo 付きで、その他の実体階は peek+保存で反映する。
  // これにより別階・別モードへ移動したとき、更新後の柱・梁・材寸がそのまま描画される。
  async function reflectStructuralAfterFloorAdd() {
    const activeId = project.activePlaneId;
    const collected = [await recomputeActiveStructural()];
    for (const plane of project.planes) {
      if (plane.id === activeId) continue;
      collected.push(await recomputeInactiveStructural(plane));
    }
    promptStructSyncIfOverflow(collected);
  }

  // 要件2：仕上げモード退出後。フットプリント（外壁線・吹抜け）変更は鉛直連続性ゲートにより
  // 自階と「自階より上の全実体階」のゲートに効く（wallGate.js：基準階＋直下の全階のAND）。
  // そのため自階（アクティブ）＋上の全階を再計算する。下階は影響を受けない。
  // 退出先が構造モードのときは runStructuralModeSetup が自階を再計算するため、自階はそちらに委ねる。
  async function reflectStructuralAfterFinishExit(currentPlaneId, goingToStructure) {
    const collected = [];
    if (!goingToStructure) collected.push(await recomputeActiveStructural());
    const planes = project.planes; // elevation 昇順
    const idx = planes.findIndex(p => p.id === currentPlaneId);
    if (idx !== -1) {
      for (let i = idx + 1; i < planes.length; i++) {
        collected.push(await recomputeInactiveStructural(planes[i]));
      }
    }
    promptStructSyncIfOverflow(collected);
  }

  // 整理ダイアログのオプション適用。各階を baseline（削除前）へ戻してから mode に従い削除＋再計算する。
  // 常に baseline 基準なので非累積——'keep'→'all'→'auto' と何度切り替えても結果は確定的で、'keep' で元に戻る。
  //   mode: 'keep' = 削除しない（baseline のまま） | 'auto' = 自動生成分のみ | 'all' = フットプリント外を全削除。
  async function applyStructSync(mode) {
    if (!structSync) return;
    for (const f of structSync.floors) {
      const plane = project.planeMap.get(f.planeId);
      if (!plane) continue;
      const isActive = plane.id === project.activePlaneId;
      const g = isActive ? project.activeGraph : await floorSwapManager.peek(plane, project.structGraph);
      restoreGraph(g, f.baseline); // 削除前へ巻き戻す
      if (mode !== 'keep') {
        deleteOverflowMembers(g, f.overflow, mode);
        const mainStructure = g.structureOverride ?? project.structuralInfo.mainStructure;
        await recomputeStructuralForGraph(g, project, mainStructure);
      }
      if (!isActive) await saveFloor(plane.id, serializeGraph(g)); // アクティブ階は auto-save に委ねる
    }
    setStructSync(prev => prev ? { ...prev, applied: mode } : null);
  }

  // ---- モード切り替え：finish→floorplan で部屋ごとに壁を自動生成 ----
  async function handleModeChange(newMode) {
    // 以降のモード固有処理はこの graph を対象とする。R階伏図からの脱出時は降りた先の階で再取得する。
    let graph = project.activeGraph;

    // 構造モード突入と同時に構造情報ダイアログをポップアップし、主要構造の指定有無を検証
    // （実効値 = 階の上書きがあればそれ、なければ建物全体の既定値）
    if (appMode !== 'structure' && newMode === 'structure') {
      setShowStructuralInfoDialog(true);
      runStructuralModeSetup(graph).catch(console.error);
    }

    // 構造モードを抜けるときは図面合成のバインディング（編集可能peek）を停止・確定保存する。
    if (appMode === 'structure' && newMode !== 'structure') {
      figureBindingManager.deactivate();
      setStructComposition(null);
      setShowStructuralInfoDialog(false);

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
    }

    // floorplan→finish 再突入: 通り芯変更等のトポロジー差分でエッジを再同期
    if (appMode !== 'finish' && newMode === 'finish') {
      const before = snapshotEdges(graph);
      runInAction(() => syncEdgesFromTopology(graph));
      const after = snapshotEdges(graph);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        undoManager.push(
          () => restoreEdges(graph, before),
          () => restoreEdges(graph, after),
        );
      }
    }

    if (appMode === 'finish' && newMode !== 'finish') {
      // ステップ1: 孤立壁（isRoomWall かつ未 claim）を収集・削除
      const claimedWallIds = new Set();
      for (const room of graph.rooms) {
        for (const id of room.generatedWallIds) claimedWallIds.add(id);
      }
      const orphanSnapshots = [];
      for (const [id, shape] of graph.shapeMap) {
        if (shape.isRoomWall && !claimedWallIds.has(id)) orphanSnapshots.push(snapshotWall(shape));
      }

      const undoFns = [];
      const redoFns = [];

      // 孤立壁の削除（合体で消えた部屋の壁）
      if (orphanSnapshots.length > 0) {
        orphanSnapshots.forEach(s => graph.removeShape(s.id));
        undoFns.push(() => restoreWallsFromSnapshots(graph, orphanSnapshots));
        redoFns.push(() => orphanSnapshots.forEach(s => graph.removeShape(s.id)));
      }

      // ステップ2: 新規壁生成（generatedWallIds なし かつ 部分指定でない部屋）
      // 部分指定（referenceRoomIds あり）は親が外周壁を担うためスキップ
      // 寸法は実材厚から導出（modeRef.current は脱出直前でまだ生存・材ロード済み）。
      const fmode = modeRef.current;
      for (const room of graph.rooms) {
        if (room.generatedWallIds.size > 0) continue;
        if (room.referenceRoomIds && room.referenceRoomIds.size > 0) continue;

        const walls = generateRoomWallsFromOutline(graph, room, fmode?.roomWallDims?.(graph, room) || {});
        if (walls.length === 0) continue;

        walls.forEach(w => room.generatedWallIds.add(w.id));
        const snapshots = walls.map(snapshotWall);
        const wallIds = walls.map(w => w.id);

        const r = room;
        undoFns.push(() => { wallIds.forEach(id => graph.removeShape(id)); r.generatedWallIds.clear(); });
        redoFns.push(() => { restoreWallsFromSnapshots(graph, snapshots).forEach(w => r.generatedWallIds.add(w.id)); });
      }

      // ステップ3: 外壁の再生成（既存の isExteriorWall 壁を削除して作り直す）
      const oldExteriorSnapshots = [];
      for (const shape of graph.shapeMap.values()) {
        if (shape.isExteriorWall) oldExteriorSnapshots.push(snapshotWall(shape));
      }
      if (oldExteriorSnapshots.length > 0) {
        oldExteriorSnapshots.forEach(s => graph.removeShape(s.id));
      }
      const newExteriorWalls = generateExteriorWalls(graph, fmode?.exteriorWallDims?.(graph) || {});
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

      // ステップ4: 境界エッジのトポロジー差分同期（脱出時に確定・永続化）
      const edgeBefore = snapshotEdges(graph);
      runInAction(() => syncEdgesFromTopology(graph));
      const edgeAfter = snapshotEdges(graph);
      if (JSON.stringify(edgeBefore) !== JSON.stringify(edgeAfter)) {
        undoFns.push(() => restoreEdges(graph, edgeBefore));
        redoFns.push(() => restoreEdges(graph, edgeAfter));
      }

      // 全変更を単一の undo エントリとして登録（undo は逆順実行）
      if (undoFns.length > 0) {
        undoManager.push(
          () => { [...undoFns].reverse().forEach(fn => fn()); },
          () => { redoFns.forEach(fn => fn()); },
        );
      }

      // 要件2：フットプリント確定後に構造モードへ問合せ、自階＋上の全階の構造部材を更新する。
      await reflectStructuralAfterFinishExit(graph.plane.id, newMode === 'structure');
    }
    // 旧モードを同期的にクリア。setMode(null) は effect 内（描画後）に走るため、
    // ここでクリアしないと appMode 変更直後の1レンダリングで旧モードのまま
    // モード固有パネルが描画されてしまう（型不一致でクラッシュする）。
    setMode(null);
    setAppMode(newMode);
  }

  // ---- フロア切替 ----
  async function handleFloorSwitch(planeId) {
    if (planeId === project.activePlaneId) return;
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
    setOpeningDialog(null);
  }

  // ---- フロア切替（仕上げモード中）：仕上げモードを抜けずに別階の仕上げ図へ移動する ----
  // setActiveFloorId により mode再ロード effect が走り、新グラフで FinishModeState を再生成（init で材再ロード）。
  // 命名中（namingRoomId）等の過渡状態は FinishModeState ごと破棄され自然にリセットされる。
  async function handleFinishFloorSwitch(planeId) {
    if (planeId === project.activePlaneId) return;
    await switchFloor(planeId);
    setActiveFloorId(planeId);
    setSnapPoint(null);
    setNearCL(null);
    setNearWall(null);
    setNearOpening(null);
    setCursorWorld(null);
    setMenu(null);
  }

  // ---- フロア切替（構造モード中）：構造モードを抜けずに別階の構造伏図へ移動する ----
  // planeId のみ受ける経路（検討チップ）。移動先平面の先頭スロットを選択状態にする。
  async function handleStructuralFloorSwitch(planeId) {
    if (planeId === project.activePlaneId) {
      setActiveStructSlotKey(firstSlotKeyForPlane(buildStructuralFigureSlots(project), planeId));
      return;
    }
    await switchFloor(planeId);
    setActiveFloorId(planeId);
    setActiveStructSlotKey(firstSlotKeyForPlane(buildStructuralFigureSlots(project), planeId));
    setMode(null);
    setSnapPoint(null);
    setNearCL(null);
    setNearWall(null);
    setNearOpening(null);
    setCursorWorld(null);
    setMenu(null);
    setClDialog(null);
    setWallDialog(null);
    setOpeningDialog(null);
    await runStructuralModeSetup(project.activeGraph);
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
    await switchFloor(slot.planeId);
    setActiveFloorId(slot.planeId);
    setActiveStructSlotKey(slotKey);
    setMode(null);
    setSnapPoint(null);
    setNearCL(null);
    setNearWall(null);
    setNearOpening(null);
    setCursorWorld(null);
    setMenu(null);
    setClDialog(null);
    setWallDialog(null);
    setOpeningDialog(null);
    await runStructuralModeSetup(project.activeGraph);
  }

  function handleAddFloor() {
    const currentPlane = project.activePlane;
    if (!currentPlane || currentPlane.isAlternative) return; // 採用のみ

    const isLowest = project.planes[0]?.id === currentPlane.id;

    // ケース2: 最下階でない、かつ地下階（開始階 < 0）→ 上階を即時実行
    if (!isLowest && currentPlane.startFloor < 0) {
      executeAddUpper(currentPlane);
      return;
    }

    // ケース1（最下階）/ ケース3（その他）→ ダイアログを開く
    setFloorDialog({ isLowest });
  }

  // 上階を追加して切り替える
  async function executeAddUpper(currentPlane) {
    const topFloor      = currentPlane.startFloor + currentPlane.stories - 1;
    const newStartFloor = addSkipZero(topFloor, 1);
    const newName       = makeFloorName(newStartFloor, 1);
    const nextElevation = currentPlane.elevation + 3000 * currentPlane.stories;
    const { plane } = addFloor(nextElevation, newName, newStartFloor, 1);
    await handleFloorSwitch(plane.id);
    await reflectStructuralAfterFloorAdd();
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
      await reflectStructuralAfterFloorAdd();
      return;
    }

    if (action === 'general') {
      // 上階 n 階分の一般階
      const topFloor      = currentPlane.startFloor + currentPlane.stories - 1;
      const newStartFloor = addSkipZero(topFloor, 1);
      const newName       = makeFloorName(newStartFloor, n);
      const nextElevation = currentPlane.elevation + 3000 * currentPlane.stories;
      const { plane } = addFloor(nextElevation, newName, newStartFloor, n);
      await handleFloorSwitch(plane.id);
      await reflectStructuralAfterFloorAdd();
    }
  }

  // ---- フロアタブのドラッグ割り込み ----
  function handleReorderFloor(fromId, toZone) {
    // project.planes は elevation 昇順 (= startFloor 昇順と一致)
    const sorted = project.planes;
    const fromIndex = sorted.findIndex(p => p.id === fromId);
    if (fromIndex <= 0) return;  // 最下階（index 0）はドラッグ不可
    if (toZone <= 0) return;     // 最下階の前にはドロップ不可
    if (toZone === fromIndex || toZone === fromIndex + 1) return; // 隣接 = no-op

    // 最下階は固定、index 1.. のみ並び替え
    const bottom = sorted[0];
    const rest   = sorted.slice(1);
    const ri     = fromIndex - 1;  // rest 内のインデックス
    const [moved] = rest.splice(ri, 1);
    let rt = toZone - 1;
    if (rt > ri) rt--;             // splice で詰まった分を補正
    rest.splice(rt, 0, moved);

    const newOrder = [bottom, ...rest];

    runInAction(() => {
      let prevSF      = bottom.startFloor;
      let prevStories = bottom.stories;
      let prevElev    = bottom.elevation;

      for (let i = 1; i < newOrder.length; i++) {
        const plane  = newOrder[i];
        const newSF  = addSkipZero(prevSF + prevStories - 1, 1);
        const newElev = prevElev + prevStories * 3000;
        // 一般階は makeFloorName、それ以外は renameFloor で書式を保持
        plane.name       = plane.stories > 1
          ? makeFloorName(newSF, plane.stories)
          : renameFloor(plane.name, newSF);
        plane.startFloor = newSF;
        plane.elevation  = newElev;
        prevSF      = newSF;
        prevStories = plane.stories;
        prevElev    = newElev;
      }
    });
  }

  // ---- フロアメニュー項目の生成（検討チップのロングタップ・メニュー用）----
  // 検討追加（add-alt）は検討チップの短タップが担うため、ここには含めない。
  // 並替（move-up/move-down）・階管理・検討操作をすべてここに集約する。
  function buildFloorMenuItems(plane) {
    if (plane.isAlternative) {
      const alts = [...project.planeMap.values()]
        .filter(p => p.isAlternative && p.referenceId === plane.referenceId)
        .sort((a, b) => a.altIndex - b.altIndex);
      const i = alts.findIndex(p => p.id === plane.id);
      const items = [];
      if (i > 0)                 items.push({ id: 'move-down', label: '◀ 前の案へ' });
      if (i < alts.length - 1)   items.push({ id: 'move-up',   label: '次の案へ ▶' });
      items.push({ id: 'promote',    label: '採用' });
      items.push({ id: 'copy-alt',   label: '案コピー' });
      items.push({ id: 'delete-alt', label: '削除', danger: true });
      return items;
    }
    const adopted   = project.planes;
    const i         = adopted.findIndex(p => p.id === plane.id);
    const isLowest  = i === 0;
    const isHighest = i === adopted.length - 1;
    const items = [];
    if (isLowest || isLowest === isHighest) items.push({ id: 'floor-change', label: '階変更' });
    if (i >= 2)                items.push({ id: 'move-down', label: '▼ 下の階へ' });
    if (!isHighest && i >= 1)  items.push({ id: 'move-up',   label: '▲ 上の階へ' });
    if (!isLowest && !isHighest) items.push({ id: 'mezzanine', label: '中間階に' });
    if (!isLowest) items.push({ id: 'delete', label: '削除', danger: true });
    return items;
  }

  // ---- 階・検討案の並替（検討チップのメニューから。±1で隣と入替え）----
  // 既存の handleReorderFloor / handleReorderAlt（ドロップゾーン方式）を再利用する。
  function handleChipReorder(planeId, direction) {
    const plane = project.planeMap.get(planeId);
    if (!plane) return;
    if (plane.isAlternative) {
      const alts = [...project.planeMap.values()]
        .filter(p => p.isAlternative && p.referenceId === plane.referenceId)
        .sort((a, b) => a.altIndex - b.altIndex);
      const i = alts.findIndex(p => p.id === planeId);
      handleReorderAlt(planeId, direction > 0 ? i + 2 : i - 1, plane.referenceId);
    } else {
      const i = project.planes.findIndex(p => p.id === planeId);
      handleReorderFloor(planeId, direction > 0 ? i + 2 : i - 1);
    }
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
          if (project.activePlaneId === planeId || isActiveAnAltOf(planeId)) {
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

  // アクティブプレーンが planeId の検討かどうか
  function isActiveAnAltOf(planeId) {
    const active = project.activePlane;
    return active?.isAlternative && active.referenceId === planeId;
  }

  // 指定階の階段をすべて削除する。アクティブ階はライブグラフ、非アクティブ階は peek して保存。
  async function removeStairsOnFloor(plane) {
    const isActive = plane.id === project.activePlaneId;
    const g = isActive ? project.activeGraph : await floorSwapManager.peek(plane, project.structGraph);
    if (g.stairs.length === 0) return;
    runInAction(() => { for (const s of [...g.stairs]) g.removeStair(s.id); });
    if (!isActive) await saveFloor(plane.id, serializeGraph(g)); // アクティブ階は auto-save に委ねる
  }

  // 検討の並び替え（グループ内）
  function handleReorderAlt(fromId, toZone, refId) {
    const alts = [...project.planeMap.values()]
      .filter(p => p.isAlternative && p.referenceId === refId)
      .sort((a, b) => a.altIndex - b.altIndex);
    const fromI = alts.findIndex(p => p.id === fromId);
    if (fromI < 0 || toZone === fromI || toZone === fromI + 1) return;
    const newOrder = [...alts];
    const [moved] = newOrder.splice(fromI, 1);
    let rt = toZone;
    if (rt > fromI) rt--;
    newOrder.splice(rt, 0, moved);
    runInAction(() => { newOrder.forEach((p, i) => { p.altIndex = i; }); });
  }

  // 階変更
  function handleFloorChange(planeId, newStartFloor) {
    setFloorChangeDlg(null);
    if (newStartFloor === 0) return;
    const adopted = project.planes;
    const idx     = adopted.findIndex(p => p.id === planeId);
    if (idx < 0) return;
    runInAction(() => {
      let prevSF   = newStartFloor;
      let prevSto  = 1;
      let prevElev = adopted[idx - 1]
        ? adopted[idx - 1].elevation + adopted[idx - 1].stories * 3000
        : adopted[0].elevation;
      for (let i = idx; i < adopted.length; i++) {
        const p  = adopted[i];
        const sf = i === idx ? newStartFloor : addSkipZero(prevSF + prevSto - 1, 1);
        const el = i === idx ? prevElev : prevElev + prevSto * 3000;
        p.name       = p.stories > 1 ? makeFloorName(sf, p.stories) : renameFloor(p.name, sf);
        p.startFloor = sf;
        p.elevation  = el;
        prevSF = sf; prevSto = p.stories; prevElev = el;
      }
    });
  }

  // ---- 三斜 線分長さ編集（history を起点に再計算してUndo登録）----
  // 戻り値: 成功なら true、対象外/形状不正なら false（呼び出し側で入力欄を維持）
  function handleEditLineLength(lineId, newLen) {
    const site = project.site;
    const step = findLineHistoryStep(site, lineId);
    if (!step) {
      setToast({ msg: '編集できない線分です', key: Date.now() });
      return false;
    }

    // 影響を受ける可能性のある全ての頂点(apex)位置 + line0 の自由端をスナップショット
    const snapshotPositions = () => {
      const map = new Map();
      const base = site.history[0];
      const ln0  = base && site.lineMap.get(base.lineId);
      if (ln0) map.set(ln0.endPoint.id, { x: ln0.endPoint.x, y: ln0.endPoint.y });
      for (let i = 1; i < site.history.length; i++) {
        const st  = site.history[i];
        const tri = site.triangleMap.get(st.triangleId);
        if (tri) map.set(tri.apexPoint.id, { x: tri.apexPoint.x, y: tri.apexPoint.y });
      }
      return map;
    };
    const restorePositions = (snap) => {
      for (const [id, pos] of snap) {
        const pt = site.pointMap.get(id);
        if (pt) { pt.x = pos.x; pt.y = pos.y; }
      }
    };

    const before     = snapshotPositions();
    const histBefore = cloneHistory(site.history);

    let ok = true;
    runInAction(() => {
      if (step.role === 'base') {
        const ln = site.lineMap.get(site.history[0].lineId);
        const sp = ln.startPoint, ep = ln.endPoint;
        const dx = ep.x - sp.x, dy = ep.y - sp.y;
        const d  = Math.hypot(dx, dy);
        if (d < 1e-6) { ok = false; return; }
        ep.x = sp.x + (dx / d) * newLen;
        ep.y = sp.y + (dy / d) * newLen;
        site.history[0].length = newLen;
        ok = recomputeSiteFromHistory(site, 1);
      } else {
        const st = site.history[step.index];
        if (step.role === 'red') st.redLen = newLen; else st.blueLen = newLen;
        ok = recomputeSiteFromHistory(site, step.index);
      }
    });

    if (!ok) {
      runInAction(() => {
        restorePositions(before);
        site.history.replace(histBefore);
      });
      setToast({ msg: '三角形を構成できません（辺長が不正）', key: Date.now() });
      return false;
    }

    const after     = snapshotPositions();
    const histAfter = cloneHistory(site.history);
    undoManager.push(
      () => runInAction(() => { restorePositions(before); site.history.replace(histBefore); }),
      () => runInAction(() => { restorePositions(after);  site.history.replace(histAfter);  }),
    );
    return true;
  }

  // ---- 三斜 線分長さ確定（NumPad/テキスト入力からの確定） ----
  function handleConfirmLineLen() {
    const m = modeRef.current;
    if (!m || !m.inputState || !m.selectedLine || m.inputState.focusedCell !== 'len') return;
    const newLen     = evalExpr(m.inputState.lenValue);
    const isEditOnly = m.inputState.redLen === undefined;
    // 未入力 or 無効値の場合は lenValue を現在の線分長さに戻す
    if (!isFinite(newLen) || newLen <= 0) {
      runInAction(() => {
        m.inputState = isEditOnly
          ? { ...m.inputState, lenValue: m.selectedLine.length.toFixed(0) }
          : { ...m.inputState, focusedCell: 'red', lenValue: m.selectedLine.length.toFixed(0) };
      });
      return;
    }
    if (!handleEditLineLength(m.selectedLine.id, newLen)) return;
    runInAction(() => {
      if (isEditOnly) m.clearInput();
      else            m.setFocusedCell('red');
    });
  }

  // ---- 三斜 頂点確定（赤辺・青辺もまとめて SiteLine として追加） ----
  function handleConfirmTriangle() {
    const m = modeRef.current;
    if (!m || !m.inputState || !m.selectedLine) return;
    const { redLen, blueLen, redKind, blueKind } = m.inputState;
    const rLen = evalExpr(redLen);
    const bLen = evalExpr(blueLen);
    if (!isFinite(rLen) || !isFinite(bLen)) return;

    const apex = computeSiteApex(m.selectedLine, rLen, bLen, viewport, size.width, size.height);
    if (!apex) {
      setToast({ msg: '三角形を構成できません（辺長が不正）', key: Date.now() });
      return;
    }

    const line     = m.selectedLine;
    const lineKind = line.lineKind;
    const { red, blue } = getSiteLineRedBlue(line);
    const redPtId  = red.id;
    const bluePtId = blue.id;
    const side     = computeApexSide(line, apex);
    let triId, apexPtId, ax, ay;
    let redLineId, redLineRedPointId, blueLineId, blueLineRedPointId;
    runInAction(() => {
      const apexPt = project.site.addPoint(apex.x, apex.y);
      const tri    = project.site.addTriangle(line, apexPt, lineKind);
      triId    = tri.id;
      apexPtId = apexPt.id;
      ax = apex.x; ay = apex.y;

      redLineRedPointId  = pickRedPointId(red,  apexPt, viewport);
      const redLine  = project.site.addLine(red,  apexPt, redKind,  undefined, redLineRedPointId);
      redLineId = redLine.id;

      blueLineRedPointId = pickRedPointId(blue, apexPt, viewport);
      const blueLine = project.site.addLine(blue, apexPt, blueKind, undefined, blueLineRedPointId);
      blueLineId = blueLine.id;

      project.site.history.push({
        type: 'triangle',
        baseLineId: line.id,
        redLineId, redLen: rLen, redKind,
        blueLineId, blueLen: bLen, blueKind,
        triangleId: triId, triangleLineKind: lineKind,
        side,
      });
    });
    undoManager.push(
      () => runInAction(() => {
        project.site.removeLine(blueLineId);
        project.site.removeLine(redLineId);
        project.site.removeTriangle(triId);
        project.site.removePoint(apexPtId);
        project.site.history.pop();
      }),
      () => runInAction(() => {
        const ln2 = project.site.lineMap.get(line.id);
        if (!ln2) return;
        const ap2 = project.site.addPoint(ax, ay, apexPtId);
        project.site.addTriangle(ln2, ap2, lineKind, triId);
        const redPt2  = project.site.pointMap.get(redPtId);
        const bluePt2 = project.site.pointMap.get(bluePtId);
        if (redPt2)  project.site.addLine(redPt2,  ap2, redKind,  redLineId,  redLineRedPointId);
        if (bluePt2) project.site.addLine(bluePt2, ap2, blueKind, blueLineId, blueLineRedPointId);
        project.site.history.push({
          type: 'triangle',
          baseLineId: line.id,
          redLineId, redLen: rLen, redKind,
          blueLineId, blueLen: bLen, blueKind,
          triangleId: triId, triangleLineKind: lineKind,
          side,
        });
      }),
    );
    // 連続入力: 次に底辺とすべき線分を自動選択（赤辺入力にフォーカス）
    runInAction(() => {
      const nextId = computePendingQueue(project.site)[0];
      if (nextId) m.selectLine(nextId);
      else        m.clearInput();
    });
  }

  // ---- 確定済み線分の線種を循環切替（境界 → 道路境界 → 測量 → 境界...） ----
  function handleCycleLineKind(lineId) {
    const line = project.site.lineMap.get(lineId);
    if (!line) return;
    const order = [SiteLineKind.BOUNDARY, SiteLineKind.ROAD, SiteLineKind.SURVEY];
    const prev = line.lineKind;
    const next = order[(order.indexOf(prev) + 1) % order.length];
    runInAction(() => { line.lineKind = next; });
    undoManager.push(
      () => runInAction(() => {
        const l = project.site.lineMap.get(lineId);
        if (l) l.lineKind = prev;
      }),
      () => runInAction(() => {
        const l = project.site.lineMap.get(lineId);
        if (l) l.lineKind = next;
      }),
    );
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
      const raw = localStorage.getItem('strad-autosave');
      if (!raw) { setToast({ msg: '自動保存データが見つかりません', key: Date.now() }); return; }
      try {
        // base64 (新形式) と JSON 文字列 (旧形式) の両方に対応
        const data = raw.trimStart().startsWith('{')
          ? JSON.parse(raw)
          : Uint8Array.from(atob(raw), c => c.charCodeAt(0));
        restoreGraph(graph, data);
        setToast({ msg: '読込み完了', key: Date.now() });
      } catch {
        setToast({ msg: '読込みに失敗しました', key: Date.now() });
      }
      return;
    }
    if (id === 'export') {
      const bytes = serializeGraph(graph);
      // Uint8Array → base64 (大容量でも安全な方式)
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      localStorage.setItem('strad-autosave', btoa(binary));
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
        // JSON ファイル (旧形式) と FlatBuffers バイナリ (新形式) の両方に対応
        const data = bytes[0] === 0x7B // '{' = JSON
          ? JSON.parse(new TextDecoder().decode(bytes))
          : bytes;
        restoreGraph(graph, data);
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
        if (tap.count === 2) undoManager.undo();
        else if (tap.count === 3) undoManager.redo();
      }
      touchTapRef.current = null;
    }
  };

  // ---- 描画エリア内の○「柱芯」ラベル ヒット判定 ----
  // ヒットしたラベルの cl と、窓を固定するためのラベル中心スクリーン座標を返す。
  function findColumnAxisLabel(sx, sy) {
    const HIT = 18; // px（丸ラベル半径相当）
    let best = null, bestD = HIT;
    for (const h of columnAxisLabelHits(graph, viewport, size.width, size.height)) {
      const d = Math.hypot(sx - h.sx, sy - h.sy);
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
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

  // ---- ガター内の通り芯ヒット判定 ----
  function findGutterCL(sx, sy) {
    const HIT = 24; // px
    const cls = graph.centerLines.filter(cl => cl.labeled);
    if (sy < INSET.top || sy > size.height - INSET.bottom) {
      for (const cl of cls) {
        if (cl.centerLineType !== CenterLineType.VERTICAL) continue;
        if (Math.abs(cl.value * viewport.scaleX + viewport.offsetX - sx) < HIT) return cl;
      }
    }
    if (sx < INSET.left || sx > size.width - INSET.right) {
      for (const cl of cls) {
        if (cl.centerLineType !== CenterLineType.HORIZONTAL) continue;
        if (Math.abs(cl.value * viewport.scaleY + viewport.offsetY - sy) < HIT) return cl;
      }
    }
    return null;
  }

  // ---- スナップ & 近傍CL/壁/開口 計算 ----
  function updateSnap(clientX, clientY) {
    // 通り芯表示エリア内はスナップ・カーソル更新しない
    if (isInGutter(clientX, clientY, size.width, size.height)) {
      setSnapPoint(null);
      setNearCL(null);
      setNearCLEndpoint(null);
      setNearWall(null);
      setNearOpening(null);
      setCursorWorld(null);
      return;
    }
    const world = viewport.screenToWorld(clientX, clientY);
    const snap  = findNearestIntersection(graph, world.x, world.y, SNAP_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
    // CL端点（延長/短縮メニュー）は交点スナップより優先度は下だが、CL/開口/壁の排他選択とは別枠で判定する
    const clEndpointCand = (appMode === 'structure')
      ? null
      : findNearestCenterLineEndpoint(graph, world.x, world.y, CL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY, viewport);
    // 交点スナップ中は CL/開口/壁の検出不要
    let cl = null, opening = null, wall = null;
    if (!snap) {
      // 構造モードでは通り芯上でマウスが反応しない（カーソル変化・長押しメニュー共に無効）
      const clCand      = appMode === 'structure'
        ? null
        : findNearestCenterLine(graph, world.x, world.y, CL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY, viewport);
      const openingCand = findOpeningAt(graph, world.x, world.y, WALL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
      const wallCand    = findNearestWall(graph, world.x, world.y, WALL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
      // 部屋の壁は軸CLから数十mmしかオフセットしておらず、通常のズームでは
      // CL・開口・壁の判定範囲(8px)が重なる。「CLが常に勝つ」固定優先順位だと
      // 部屋の壁上で常にCLメニュー（削除のみ）になってしまうため、画面距離が
      // 最も近い候補を優先する（同距離なら cl > opening > wall の順で安定ソート）。
      const candidates = [];
      if (clCand) {
        const isV = clCand.centerLineType === CenterLineType.VERTICAL;
        const dist = isV ? Math.abs(clCand.value - world.x) * viewport.scaleX : Math.abs(clCand.value - world.y) * viewport.scaleY;
        candidates.push({ type: 'cl', value: clCand, dist });
      }
      if (openingCand) {
        const host = findHostWall(openingCand, graph);
        if (host) {
          const dist = host.isVertical ? Math.abs(host.axisValue - world.x) * viewport.scaleX : Math.abs(host.axisValue - world.y) * viewport.scaleY;
          candidates.push({ type: 'opening', value: openingCand, dist });
        }
      }
      if (wallCand) {
        const dist = wallCand.isVertical ? Math.abs(wallCand.axisValue - world.x) * viewport.scaleX : Math.abs(wallCand.axisValue - world.y) * viewport.scaleY;
        candidates.push({ type: 'wall', value: wallCand, dist });
      }
      candidates.sort((a, b) => a.dist - b.dist);
      const nearest = candidates[0] ?? null;
      if (nearest?.type === 'cl')      cl = nearest.value;
      if (nearest?.type === 'opening') opening = nearest.value;
      if (nearest?.type === 'wall')    wall = nearest.value;
    }
    setSnapPoint(snap ?? null);
    setNearCL(cl ?? null);
    setNearCLEndpoint(!snap ? (clEndpointCand ?? null) : null);
    setNearOpening(opening ?? null);
    setNearWall(wall ?? null);
    setCursorWorld(world);
    setCursorScreen({ x: clientX, y: clientY });
  }

  // ---- メニュー選択 ----
  function handleMenuSelect(item) {
    if (item.id === 'cl-v' || item.id === 'cl-h') {
      const isV  = item.id === 'cl-v';
      const pos  = menu.worldPos;
      const clType = isV ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
      const nearbyCLs = findNearbyCenterLines(
        graph, pos.x, pos.y, SNAP_THRESHOLD_PX * 2,
        viewport.scaleX, viewport.scaleY, clType
      );
      setClDialog({
        type:       isV ? 'vertical' : 'horizontal',
        worldCoord: isV ? pos.x : pos.y,
        perpCoord:  isV ? pos.y : pos.x,
        worldPos:   pos,
        nearbyCLs,
      });
      return;
    }
    if (item.id === 'cl-move') { modeRef.current?.startMove(menu.cl); return; }
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
      const cl = menu.cl;
      const isStruct = cl.discipline === Discipline.STRUCT && cl.labeled;
      if (isStruct) {
        // 通り芯の削除 — structGraph をスナップショット経由で Undo
        const before = serializeStructCLs(project.structGraph, project.structuralInfo, project.structuralTagRegistry);
        project.structGraph.removeCenterLine(cl.id);
        const after = serializeStructCLs(project.structGraph, project.structuralInfo, project.structuralTagRegistry);
        undoManager.push(
          () => restoreStructCLs(project.structGraph, project.structuralInfo, before, project.structuralTagRegistry),
          () => restoreStructCLs(project.structGraph, project.structuralInfo, after, project.structuralTagRegistry),
        );
      } else {
        const before = serializeGraph(graph);
        graph.removeCenterLine(cl.id);
        const after = serializeGraph(graph);
        undoManager.push(
          () => restoreGraph(graph, before),
          () => restoreGraph(graph, after),
        );
      }
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
      setOpeningDialog({
        wall:     menu.wall,
        worldPos: menu.worldPos,
        category: item.id === 'add-fitting' ? OpeningCategory.FITTING : OpeningCategory.WINDOW,
        existing: null,
      });
      return;
    }
    if (item.id === 'opening-edit') {
      const o    = menu.opening;
      const wall = findHostWall(o, graph);
      setOpeningDialog({ wall, worldPos: menu.worldPos, category: o.category, existing: o });
      return;
    }
    if (item.id === 'opening-del') {
      const o = menu.opening;
      graph.removeShape(o.id);
      undoManager.push(
        () => graph.addOpening(o.axisCL, o.wallSide, o.isVertical, o.refCL, o.refOffset, o.width, o.category, o.subType,
          { hingeSide: o.hingeSide, swingSide: o.swingSide }, o.id),
        () => graph.removeShape(o.id),
      );
      return;
    }
    modeRef.current?.startDraw(item.id, menu?.snap, menu?.worldPos);
  }

  // ---- 開口（建具・窓）追加・編集 ----
  function handleOpeningConfirm({ refCL, refOffset, width, subType, hingeSide, swingSide }) {
    if (!openingDialog) return;
    if (openingDialog.existing) {
      const o = openingDialog.existing;
      const before = { wallSide: o.wallSide, refCL: o.refCL, refOffset: o.refOffset, width: o.width, subType: o.subType, hingeSide: o.hingeSide, swingSide: o.swingSide };
      const after  = { wallSide: o.wallSide, refCL, refOffset, width, subType, hingeSide, swingSide };
      runInAction(() => Object.assign(o, after));
      undoManager.push(
        () => runInAction(() => Object.assign(o, before)),
        () => runInAction(() => Object.assign(o, after)),
      );
    } else {
      const wall = openingDialog.wall;
      const wallSide = Math.sign(wall.axisOffset) || 1;
      const o = graph.addOpening(wall.axisCL, wallSide, wall.isVertical, refCL, refOffset, width, openingDialog.category, subType, { hingeSide, swingSide });
      undoManager.push(
        () => graph.removeShape(o.id),
        () => graph.addOpening(o.axisCL, o.wallSide, o.isVertical, o.refCL, o.refOffset, o.width, o.category, o.subType,
          { hingeSide: o.hingeSide, swingSide: o.swingSide }, o.id),
      );
    }
    setOpeningDialog(null);
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

  // 木造（在来）の自動判定（問題.md）: 平面モードで主構造が未指定のとき、追加した通り芯が
  // 既存グリッドと910の倍数間隔をなすなら「木造（在来）」を提案する確認ダイアログを出す。
  // 「寸法指定を910で割った余りが0」を、隣接グリッドCLとの最小間隔で判定する（参照なし絶対座標入力にも効く）。
  // 主構造の正式表記は StructuralInfoDialog.MAIN_STRUCTURE_OPTIONS に準拠（'未定' / '木造（在来）'＝全角括弧）。
  function maybeSuggestWoodStructure(clType, newValues) {
    if (appMode !== 'floorplan') return;
    if (project.structuralInfo.mainStructure !== '未定') return; // 既に主構造が確定済みなら提案しない
    const grid = (clType === CenterLineType.VERTICAL ? graph.gridXs : graph.gridYs).map(cl => cl.effectiveValue);
    const isWoodModule = newValues.some(v => {
      let nearest = Infinity;
      for (const u of grid) {
        const d = Math.abs(u - v);
        if (d > 0.5 && d < nearest) nearest = d; // 自分自身（d≈0）は除外
      }
      return nearest !== Infinity && Math.round(nearest) % 910 === 0;
    });
    if (!isWoodModule) return;
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

  function handleCLDialogConfirm(value, kind, trim, refId, refOffset) {
    if (!clDialog) return;
    const clType = clDialog.type === 'vertical' ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;

    // ---- スパン配列バッチモード（kind='struct' かつ value が配列）----
    if (Array.isArray(value)) {
      const OVERLAP_TOL = 0.5;
      const newValues = value.filter(v =>
        !graph.centerLines.some(cl => cl.centerLineType === clType && Math.abs(cl.value - v) < OVERLAP_TOL)
      );
      if (newValues.length === 0) {
        setToast({ msg: ERR_CL_DUPLICATE('struct'), key: Date.now() });
        setClDialog(null); setClPreview(null);
        return;
      }
      const before = serializeStructCLs(project.structGraph, project.structuralInfo, project.structuralTagRegistry);
      newValues.forEach(v =>
        project.structGraph.addCenterLine(clType, v, {
          discipline: Discipline.STRUCT,
          labeled:    true,
          trim:       !!trim,
        })
      );
      const after = serializeStructCLs(project.structGraph, project.structuralInfo, project.structuralTagRegistry);
      undoManager.push(
        () => restoreStructCLs(project.structGraph, project.structuralInfo, before, project.structuralTagRegistry),
        () => restoreStructCLs(project.structGraph, project.structuralInfo, after, project.structuralTagRegistry),
      );
      setClDialog(null); setClPreview(null);
      maybeSuggestWoodStructure(clType, newValues);
      return;
    }

    // extent 計算: center は直交CL参照、aux は3ケース判定（壁・CL・フリー）
    let extentProps = {};
    let newExtentLo = null, newExtentHi = null;
    if (kind === 'center') {
      const perpType = clType === CenterLineType.VERTICAL ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
      const wc = clDialog.worldCoord;
      const perpCLs = graph.centerLines.filter(cl => {
        if (cl.centerLineType !== perpType) return false;
        // 非ラベルCL: extentLo/Hi の実範囲（はね出し前）に新規CLの座標が含まれるものだけ対象
        if (!cl.labeled && cl.extentLo != null && cl.extentHi != null) {
          if (wc < cl.extentLo || wc > cl.extentHi) return false;
        }
        return true;
      });
      const [loCL, hiCL] = findBracketingCLs(perpCLs, clDialog.perpCoord);
      newExtentLo = loCL ? loCL.value : (perpCLs.length ? Math.min(...perpCLs.map(c => c.value)) : null);
      newExtentHi = hiCL ? hiCL.value : (perpCLs.length ? Math.max(...perpCLs.map(c => c.value)) : null);
      extentProps = {
        labeled:     false,
        extentLoRef: loCL ? { clId: loCL.id, offset: 0 } : null,
        extentHiRef: hiCL ? { clId: hiCL.id, offset: 0 } : null,
        extentLo:    !loCL ? newExtentLo : null,
        extentHi:    !hiCL ? newExtentHi : null,
      };
    } else if (kind === 'aux') {
      const perpType = clType === CenterLineType.VERTICAL ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
      const isNewV   = clType === CenterLineType.VERTICAL;
      const wc       = clDialog.worldCoord;
      const pc       = clDialog.perpCoord;
      const overhang = overhangMm(viewport, !!trim);

      // フリーエンドポイント用: ポインティング座標をキリ良い数値に丸める
      const niceStep = calcStep(viewport.scaleDenominator);
      const roundToNiceCoord = (coord) =>
        niceStep > 0 ? Math.round(coord / niceStep) * niceStep : Math.round(coord);

      // 直交壁を検出（新CLの座標が壁の長手範囲に含まれるもの）
      const perpWalls = graph.walls.filter(w => {
        if (w.isVertical === isNewV) return false;
        const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
        return c1 <= wc && wc <= c2;
      });
      const loWall = perpWalls.filter(w => w.axisValue <= pc)
        .reduce((best, w) => !best || w.axisValue > best.axisValue ? w : best, null);
      const hiWall = perpWalls.filter(w => w.axisValue >= pc)
        .reduce((best, w) => !best || w.axisValue < best.axisValue ? w : best, null);

      // 直交CLを検出（非ラベルCLは延伸範囲内のもののみ）
      const allPerpCLs = graph.centerLines.filter(cl => {
        if (cl.centerLineType !== perpType) return false;
        if (!cl.labeled && cl.extentLo != null && cl.extentHi != null) {
          if (wc < cl.extentLo || wc > cl.extentHi) return false;
        }
        return true;
      });
      const [loCL, hiCL] = findBracketingCLs(allPerpCLs, pc);

      // 既存補助線が指定CLを extentLoRef/HiRef で参照しているか
      const anyAuxRefsCL = (cl) => graph.centerLines.some(ex =>
        ex.lineType === 'dashed' && !ex.labeled &&
        (ex.extentLoRef?.clId === cl.id || ex.extentHiRef?.clId === cl.id)
      );

      // lo側境界の決定: 壁とCLのうち perpCoordに近い（値が大きい）ものを優先
      let loRef = null, loStaticVal = null;
      const loByCL   = loCL  ? { type: 'cl',   val: loCL.value,       item: loCL   } : null;
      const loByWall = loWall ? { type: 'wall', val: loWall.axisValue, item: loWall } : null;
      const bestLo = (loByCL && loByWall) ? (loByWall.val >= loByCL.val ? loByWall : loByCL)
                   : (loByCL ?? loByWall);

      if (bestLo?.type === 'wall') {
        loRef       = { wallId: bestLo.item.id };
        newExtentLo = bestLo.val;
      } else if (bestLo?.type === 'cl') {
        if (anyAuxRefsCL(bestLo.item)) {
          // 既存補助線が同じCLを参照 → リアクティブ参照（CLと連動してトリム）
          loRef       = { clId: bestLo.item.id, offset: 0 };
          newExtentLo = bestLo.val;
        } else {
          // 既存参照なし → はね出し（静的座標）
          loStaticVal = bestLo.val - overhang;
          newExtentLo = loStaticVal;
        }
      } else {
        // フリーエンドポイント: ポインティング座標をキリ良い数値に丸めて採用
        loStaticVal = roundToNiceCoord(pc);
        newExtentLo = loStaticVal;
      }

      // hi側境界の決定: 壁とCLのうち perpCoordに近い（値が小さい）ものを優先
      let hiRef = null, hiStaticVal = null;
      const hiByCL   = hiCL  ? { type: 'cl',   val: hiCL.value,       item: hiCL   } : null;
      const hiByWall = hiWall ? { type: 'wall', val: hiWall.axisValue, item: hiWall } : null;
      const bestHi = (hiByCL && hiByWall) ? (hiByWall.val <= hiByCL.val ? hiByWall : hiByCL)
                   : (hiByCL ?? hiByWall);

      if (bestHi?.type === 'wall') {
        hiRef       = { wallId: bestHi.item.id };
        newExtentHi = bestHi.val;
      } else if (bestHi?.type === 'cl') {
        if (anyAuxRefsCL(bestHi.item)) {
          hiRef       = { clId: bestHi.item.id, offset: 0 };
          newExtentHi = bestHi.val;
        } else {
          hiStaticVal = bestHi.val + overhang;
          newExtentHi = hiStaticVal;
        }
      } else {
        // フリーエンドポイント: ポインティング座標をキリ良い数値に丸めて採用
        hiStaticVal = roundToNiceCoord(pc);
        newExtentHi = hiStaticVal;
      }

      extentProps = {
        labeled:     false,
        extentLoRef: loRef,
        extentHiRef: hiRef,
        extentLo:    loRef ? null : loStaticVal,
        extentHi:    hiRef ? null : hiStaticVal,
      };
    }

    // ---- 重複チェック（extent計算後に実施） ----
    const OVERLAP_TOL = 0.5; // mm
    const existing = graph.centerLines.find(
      cl => cl.centerLineType === clType && Math.abs(cl.value - value) < OVERLAP_TOL
    );
    if (existing) {
      const existingKind = centerLineKind(existing);

      if (kind === existingKind) {
        if (kind === 'struct') {
          setToast({ msg: ERR_CL_DUPLICATE(kind), key: Date.now() });
          return;
        }
        // center / aux: extent が重ならなければ追加を許可
        const exLo = existing.extentLo;
        const exHi = existing.extentHi;
        const extentsOverlap =
          newExtentLo == null || newExtentHi == null ||
          exLo == null || exHi == null ||
          !(newExtentHi <= exLo || newExtentLo >= exHi);
        if (extentsOverlap) {
          setToast({ msg: ERR_CL_DUPLICATE(kind), key: Date.now() });
          return;
        }
        // 隣接するCLがあれば結合する（線分の端点一致をベクトル演算で確認、多段連鎖にも対応）
        // extentProps.extentLo/Hi は CenterLine コンストラクタ用の静的フォールバック値（ref があれば null）。
        // getCenterLineSegment が読む座標は常に解決済みの newExtentLo/newExtentHi で渡す必要がある。
        const virtualCandidate = { centerLineType: clType, value, ...extentProps, extentLo: newExtentLo, extentHi: newExtentHi };
        const chainResult = runInAction(() => mergeCenterLineChain(graph, virtualCandidate, { kind }));
        if (chainResult.merged) {
          undoManager.push(
            () => runInAction(chainResult.undo),
            () => runInAction(chainResult.redo),
          );
          setClDialog(null);
          setClPreview(null);
          return;
        }
      }

      if (kind === 'struct' && existingKind === 'center') {
        // 既存の中心線を削除して通り芯を新規追加
        setToast({ msg: ERR_CL_CENTER_UPGRADED, key: Date.now() });
        const deletedId = existing.id;
        const deletedType = existing.centerLineType;
        const deletedRawValue = existing._value;
        const deletedProps = {
          labeled: existing.labeled,
          lineType: existing.lineType,
          discipline: existing.discipline,
          trim: existing.trim,
          ...(existing.refId != null ? { refId: existing.refId, refOffset: existing.refOffset } : {}),
          ...(existing.extentLoRef != null ? { extentLoRef: existing.extentLoRef } : {}),
          ...(existing.extentHiRef != null ? { extentHiRef: existing.extentHiRef } : {}),
          ...(existing._extentLo != null ? { extentLo: existing._extentLo } : {}),
          ...(existing._extentHi != null ? { extentHi: existing._extentHi } : {}),
        };
        graph.removeCenterLine(deletedId);
        const structProps = {
          discipline: Discipline.STRUCT,
          trim: !!trim,
          ...(refId ? { refId, refOffset: refOffset ?? 0 } : {}),
        };
        // 通り芯は project.structGraph に追加する
        const structCL = project.structGraph.addCenterLine(clType, value, structProps);
        const structId = structCL.id;
        undoManager.push(
          () => {
            project.structGraph.removeCenterLine(structId);
            graph.addCenterLine(deletedType, deletedRawValue, deletedProps, deletedId);
          },
          () => {
            graph.removeCenterLine(deletedId);
            project.structGraph.addCenterLine(clType, value, structProps, structId);
          },
        );
        setClDialog(null);
        setClPreview(null);
        maybeSuggestWoodStructure(clType, [value]);
        return;
      }

      if (kind === 'center' && existingKind === 'struct') {
        setToast({ msg: ERR_CL_STRUCT_EXISTS, key: Date.now() });
        return;
      }
    }

    // 通り芯は project.structGraph へ、それ以外は activeGraph へ
    const targetGraph = kind === 'struct' ? project.structGraph : graph;
    // refId はターゲットグラフだけでなく structGraph も解決対象に含める
    // （center CL が struct CL を参照するケース）。addCenterLine 側も同じ範囲で
    // _referencedCL を解決するため、ここで解決可能と判定すれば二重加算は起きない。
    const isRefResolvable = refId
      ? !!(targetGraph.shapeMap.get(refId) ?? project.structGraph.shapeMap.get(refId))
      : false;
    const props = {
      ...extentProps,
      ...(kind === 'struct' ? { discipline: Discipline.STRUCT } : {}),
      ...(kind === 'aux'    ? { labeled: false, lineType: 'dashed' } : {}),
      trim: !!trim,
      ...(isRefResolvable ? { refId, refOffset: refOffset ?? 0 } : {}),
    };
    const cl = targetGraph.addCenterLine(clType, value, props);
    const clId = cl.id;
    undoManager.push(
      () => targetGraph.removeCenterLine(clId),
      () => targetGraph.addCenterLine(clType, value, props, clId),
    );
    setClDialog(null);
    setClPreview(null);
    if (kind === 'struct') maybeSuggestWoodStructure(clType, [value]);
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
  const chipActivePlane = project.activePlane;
  const chipRefId  = chipActivePlane?.isAlternative ? chipActivePlane.referenceId : chipActivePlane?.id;
  const chipAdopted = chipRefId != null ? project.planeMap.get(chipRefId) : null;
  const chipAlts = chipRefId != null
    ? [...project.planeMap.values()]
        .filter(p => p.isAlternative && p.referenceId === chipRefId)
        .sort((a, b) => a.altIndex - b.altIndex)
    : [];
  const chipVariants = chipAdopted
    ? [{ id: chipAdopted.id, label: '採用', isActive: project.activePlaneId === chipAdopted.id },
       ...chipAlts.map(p => ({ id: p.id, label: p.name, isActive: project.activePlaneId === p.id }))]
    : [];
  const chipText = chipActivePlane
    ? (chipActivePlane.isAlternative ? chipActivePlane.name : `${chipAdopted?.name ?? floorName}：採用`)
    : floorName;
  const chipManagementItems = chipActivePlane ? buildFloorMenuItems(chipActivePlane) : [];

  return (
    <>
      {/* Undo/Redo ボタン — 左上 */}
      <div style={{
        position: 'fixed', top: 0, left: 6,
        height: TOP_BAR, display: 'flex', alignItems: 'center', gap: 2, zIndex: 200,
      }}>
        {[
          { label: '↩', title: '元に戻す (Ctrl+Z / 2本指タップ)', can: undoManager.canUndo, action: () => undoManager.undo() },
          { label: '↪', title: 'やり直す (Ctrl+Y / 3本指タップ)', can: undoManager.canRedo, action: () => undoManager.redo() },
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
          appMode === 'structure' ? handleStructuralSlotSwitch
          : appMode === 'finish'  ? handleFinishFloorSwitch
          : handleFloorSwitch
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
          クリックすると構造モードを抜けずに別階の構造伏図へ移動する（onSwitchStructural）。
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

      {openingDialog && (
        <OpeningDialog
          wall={openingDialog.wall}
          worldPos={openingDialog.worldPos}
          category={openingDialog.category}
          existing={openingDialog.existing}
          graph={graph}
          onConfirm={handleOpeningConfirm}
          onCancel={() => setOpeningDialog(null)}
        />
      )}

      {floorDialog && (
        <AddFloorDialog
          isLowest={floorDialog.isLowest}
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
          if (ms) {
            const { cl, originalValue } = ms;
            const newValue = cl.effectiveValue;
            if (newValue !== originalValue) {
              let chainResult = { merged: false };
              runInAction(() => {
                bakeCLValue(cl, newValue);
                if (!cl.labeled) chainResult = mergeCenterLineChain(graph, cl, { kind: centerLineKind(cl) });
              });
              const [undoFn, redoFn] = composeUndoWithMergeChain(
                () => bakeCLValue(cl, originalValue),
                () => bakeCLValue(cl, newValue),
                chainResult,
              );
              undoManager.push(() => runInAction(undoFn), () => runInAction(redoFn));
            } else {
              runInAction(() => { cl.pendingDelta = 0; });
            }
          }
          modeRef.current?.commitMove();
        }}
        onCancel={() => modeRef.current?.cancelMove()}
        graph={graph}
        scaleDenominator={viewport.scaleDenominator}
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
                    onSelectRoom={id => modeRef.current?.selectRoom(id)}
                    previewCells={mode.previewCells}
                  />
                )}
                {(appMode === 'finish' || appMode === 'floorplan') && (() => {
                  const fh = floorHeightAbove(project, project.activePlane);
                  const installEntries = graph.stairs.map(s => ({
                    id: s.id,
                    stair: s,
                    bounds: roomBounds(s.cells, graph),
                    riser: s.riser ?? (fh != null ? fh / Math.max(1, s.totalSteps) : null),
                    spans: measureStairSpans(s, graph), // セル実測の区間長（区間長指定の反映）
                    view: 'install',
                    selectable: appMode === 'finish',
                  }));
                  // 階切替の非同期過渡で同一階段が install/upper 両方に入るのを防ぐ
                  // （install が設置階の正であり、upper は直下階由来。重複時は install を優先）
                  const installIds = new Set(installEntries.map(e => e.id));
                  const upperEntries = upperStairEntries.filter(e => !installIds.has(e.id));
                  return (
                    <StairLayer
                      entries={[...installEntries, ...upperEntries]}
                      viewport={viewport}
                      detail={viewport.lodLevel === LodLevel.DETAIL}
                      selectedStairId={appMode === 'finish' ? mode?.selectedStairId : null}
                      onSelectStair={appMode === 'finish' ? (id => modeRef.current?.selectStair(id)) : null}
                    />
                  );
                })()}
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
                {appMode !== 'structure' && <ShapesLayer graph={graph} viewport={viewport} />}
                {appMode !== 'structure' && <OpeningsLayer graph={graph} viewport={viewport} />}
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
                      setMemberFocusRequest({ mapName, tag: entity.memberNo, fieldKey: PRIMARY_DIMENSION_FIELD_BY_MAP[mapName] ?? null });
                    }}
                    onStatusMenuRequest={(entity, pos) => setStatusMenu({ entity, pos })}
                  />
                )}
                {/* LOD 詳細: 仕上げモードかつ詳細レベル時、壁の層構成断面を ShapesLayer の帯の上に重ねて描画 */}
                {appMode === 'finish' && mode?.materialMap && viewport.lodLevel === LodLevel.DETAIL && (
                  <EdgeSectionLayer
                    graph={graph}
                    viewport={viewport}
                    cellToRoom={buildCellToRoom(graph)}
                    resolveEdgeSection={(edge, g, c2r) => modeRef.current?.resolveEdgeSection(edge, g, c2r) ?? null}
                  />
                )}
                {appMode === 'floorplan' && (
                  <RoomLabelsLayer graph={graph} viewport={viewport} />
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
            onConfirm={(id, name) => modeRef.current?.finishNaming(id, name)}
            onCancel={id => modeRef.current?.cancelNaming(id)}
            onConvertToStair={id => {
              modeRef.current?.convertRoomToStair(id, floorHeightAbove(project, project.activePlane));
              // 上階へ不足中心線を追加（非アクティブ階を peek して IDB へ保存）
              import('./finish/stair/stairFloorSync.js')
                .then(m => m.syncUpperFloorCLs(project, project.activeGraph))
                .catch(console.error);
            }}
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

      {toast && (
        <div key={toast.key} className="cl-toast" onClick={() => setToast(null)}>
          {toast.msg}
        </div>
      )}

      {/* 構造部材の整理：閉じた後も structSync を保持し、別階を確認してから再オープンできる banner */}
      {structSync && !structSyncOpen && (
        <div
          className="cl-toast"
          style={{ cursor: 'pointer', background: '#1e293b' }}
          onClick={() => setStructSyncOpen(true)}
        >
          フットプリント外の構造部材 {structSync.autoCount + structSync.protectedCount} 件 ▸ 整理
          <span
            style={{ marginLeft: 10, opacity: 0.7 }}
            onClick={e => { e.stopPropagation(); setStructSync(null); }}
          >✕</span>
        </div>
      )}

      {structSync && structSyncOpen && (
        <StructuralSyncDialog
          summary={{
            autoCount: structSync.autoCount,
            protectedCount: structSync.protectedCount,
            floors: structSync.floors.map(f => ({
              name: project.planeMap.get(f.planeId)?.name ?? '?',
              auto: f.overflow.filter(m => !m.protected).length,
              protected: f.overflow.filter(m => m.protected).length,
            })),
          }}
          applied={structSync.applied}
          onApply={mode => applyStructSync(mode).catch(console.error)}
          onClose={() => setStructSyncOpen(false)}
        />
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
          onStructureChanged={mutate => {
            // 主構造変更（mutate）→ 構造伏図に映る全グラフ（自階＋下階）を再計算し、下階の柱も実効主構造へ追従させる。
            if (structComposition) recomputeStructuralComposition(structComposition, project.activeGraph, { mutate }).catch(console.error);
            else runInAction(mutate); // 万一 composition 未確立時は変更だけ反映
          }}
        />
      )}
    </>
  );
});

export default App;
