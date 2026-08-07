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
  findBeamAxisMoveSnap,
  findBracketingCLs,
  findNearbyCenterLines,
  findNearestWall,
  findOpeningAt,
  overhangMm,
} from './snap.js';
import { findHostWall } from './openings/openingGeometry.js';
import { OpeningPanel } from './openings/OpeningPanel.jsx';
import { OpeningsLayer } from './renderer/OpeningsLayer.jsx';
import { placeOpeningWithDefaults, removeOpeningWithUndo } from './openings/openingEdit.js';
import { collectFloorOpeningGroups, assignOpeningNumbers, applyOpeningTags } from './openings/openingNumbering.js';
import { useLongPress }  from './interaction/useLongPress.js';
import { FinishModeLayer } from './finish/FinishModeLayer.jsx';
import { RoomNameInput }   from './finish/RoomNameInput.jsx';
import { FinishSidebar }   from './finish/FinishSidebar.jsx';
import { FinishHalfModal } from './finish/FinishHalfModal.jsx';
import { StairLayer }      from './renderer/StairLayer.jsx';
import { floorHeightAbove } from './finish/stair/stairDimensions.js';
import { measureStairSpans } from './finish/stair/stairClassify.js';
import { cellsBeyondBreak, stairPortEdges, LANE_GAP } from './finish/stair/stairGeometry.js';
import { stairUnderWallClips } from './finish/stair/stairUnderClip.js';
import { generateStairUnderWalls, stairUnderClaimedEdges, trimStairUnderJunctions } from './finish/stair/stairUnderWalls.js';
import { roomBounds, cellBoundsList, refreshCells } from './finish/gridCells.js';
import { generateRoomWallsFromOutline, generateExteriorWalls, snapshotWall, restoreWallsFromSnapshots, resolveBackingOwnership, applyBackingOwnership } from './finish/wallGeneration.js';
import { snapshotEdges, restoreEdges, syncEdgesFromTopology, interiorWallSpans, buildCellToRoom } from './finish/edgeClassify.js';
// finish/clEccentricity.js は edgeComposition.js 経由で materials/materialData.js（材マスタ全件）を
// 静的に引くため、コード分割維持のため動的 import する（materialData.js のヘッダコメント参照）。
import { reinterpretRoomsOnEntry, ensureStairRooms, snapshotRoomsState, restoreRoomsState } from './finish/roomReinterpret.js';
import { RoomLabelsLayer } from './renderer/RoomLabelsLayer.jsx';
import { StepSectionLayer } from './renderer/StepSectionLayer.jsx';
import { VoidLayer } from './renderer/VoidLayer.jsx';
import { computeVoidCrosses } from './finish/voidGeometry.js';
import { StructuralLayer, ColumnsLayer } from './renderer/StructuralLayer.jsx';
import { MemberTagLayer } from './renderer/MemberTagLayer.jsx';
import { MemberStatusMenu } from './ui/MemberStatusMenu.jsx';
import { PRIMARY_DIMENSION_FIELD_BY_MAP } from './structural/memberCatalog.js';
import { CONTEXT, detectContext, getMenuItems } from './interaction/menuItems.js';
import { CenterLineType, Discipline, SiteLineKind, OpeningCategory, RoomFeature, centerLineKind, CL_OVERLAP_TOL_MM } from '@core';
import { addSkipZero, subtractSkipZero, makeFloorName, makeFloorLevelPrefix, renameFloor } from './floorNumber.js';
import { AddFloorDialog } from './ui/AddFloorDialog.jsx';
import { ConfirmDialog } from './ui/ConfirmDialog.jsx';
import { FloorChangeDialog } from './ui/FloorChangeDialog.jsx';
import { IntersectionMarkers } from './renderer/CenterLinesLayer.jsx';
import { GutterLayer, columnAxisLabelHits } from './renderer/GutterLayer.jsx';
import { ShapesLayer }    from './renderer/ShapesLayer.jsx';
import { SnapIndicator }  from './renderer/SnapIndicator.jsx';
import { LongPressIndicator } from './renderer/LongPressIndicator.jsx';
import { DrawPreview }    from './renderer/DrawPreview.jsx';
import { CLAddPreview }   from './renderer/CLAddPreview.jsx';
import { CLMoveInput } from './renderer/CLMoveInput.jsx';
import { roundAbsToStep, calcStep } from './renderer/clMoveMath.js';
import { AxisFaceInput }     from './renderer/AxisFaceInput.jsx';
import { RadialMenu }     from './ui/RadialMenu.jsx';
import { AddCLDialog }    from './ui/AddCLDialog.jsx';
import { WallDialog }          from './ui/WallDialog.jsx';
import { WallRefIndicator }   from './renderer/WallRefIndicator.jsx';
import { CalibrationDialog }  from './ui/CalibrationDialog.jsx';
import { SiteDialog }          from './ui/SiteDialog.jsx';
import { BuildingInfoDialog }  from './ui/BuildingInfoDialog.jsx';
import { StructuralPanel } from './structural/StructuralPanel.jsx';
import { autoFillColumns, autoFillColumnAxisOffsets, autoFillBeamEccentricity, autoFillColumnSizes, resolveLowestGraph, convertMembersToEffectiveMaterial, deleteClassificationOverflow, axisExteriorSign, autoFillSecondaryBeams } from './structural/structuralAutoFill.js';
import { structureHasMemberKind, MEMBER_KIND } from './structural/structuralClassification.js';
import { buildStructuralWallGate, buildExteriorSide } from './structural/wallGate.js';
import { renumberMembers, collectFloorGroups, assignNumbers, applyNumbers } from './structural/memberNumbering.js';
import { conformToLedger } from './structural/memberGroups.js';
import { resolveSecondaryBeamsForAxis } from './structural/beamAxisMove.js';
import { recomputeStructuralForGraph } from './structural/structuralRecompute.js';
import { syncRoofPlane } from './structural/roofPlane.js';
import { buildStructuralFigureSlots, designationForSlot, firstSlotKeyForPlane } from './structural/structuralFigureSlots.js';
import { figureBindingManager } from './figure/FigureBindingManager.js';
import { floorSwapManager } from './storage/FloorSwapManager.js';
import { saveFloor, loadFloor, deleteFloor as dbDeleteFloor } from './storage/db.js';
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
import { evalNumpadExpr } from './ui/numpadUtils.js';
import { EccentricityDialog } from './ui/EccentricityDialog.jsx';
import { KneeDropWallDialog } from './ui/KneeDropWallDialog.jsx';
import { resolveWallSpanKey, isEligibleWallSpan, kneeDropWallGeometry } from './finish/kneeDropWall.js';

const SNAP_THRESHOLD_PX = 20;
const CL_THRESHOLD_PX   = 8;
const WALL_THRESHOLD_PX = 8;

const viewport = new Viewport(window.innerWidth, window.innerHeight, RULER, RULER);

// CL の pendingDelta を実座標に bake する（ref CL / 通常 CL 両対応）
const evalExpr = (s) => evalNumpadExpr(s, { positiveOnly: true });

function bakeCLValue(cl, newVal) {
  if (cl.refId) {
    cl.refOffset = newVal - (cl._referencedCL?.value ?? cl._value);
  } else {
    cl.value = newVal;
  }
  cl.pendingDelta = 0;
}

// 矩形2つが実質的に重なる（浮動小数の際どい接触は無視）か。EPS(mm) 未満の重なりは無視する。
const RECT_OVERLAP_EPS = 1; // mm
function rectsOverlap(a, b) {
  return a.x1 < b.x2 - RECT_OVERLAP_EPS && a.x2 > b.x1 + RECT_OVERLAP_EPS
      && a.y1 < b.y2 - RECT_OVERLAP_EPS && a.y2 > b.y1 + RECT_OVERLAP_EPS;
}

// listA のいずれかの矩形が listB のいずれかの矩形と重なるか（下階階段の見下げ upper エントリが
// 自階 install エントリと同一 footprint かどうかの判定に使う。cellBounds 同士の総当たり）。
function anyCellBoundsOverlap(listA, listB) {
  if (!listA?.length || !listB?.length) return false;
  return listA.some(a => listB.some(b => rectsOverlap(a, b)));
}

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
      const entries = temp.stairs.map(s => ({
        id: s.id,
        stair: s,
        graph: temp, // 側面線の壁有無判定（resolveStairSideLines）。その階段が実在する下階のグラフを渡す
        bounds: roomBounds(s.cells, temp),
        cellBounds: cellBoundsList(s.cells, temp), // 実セル占有（選択枠用。選択は startDrag 経由で一本化）
        riser: s.riser ?? (floorHeight != null ? floorHeight / Math.max(1, s.totalSteps) : null),
        spans: measureStairSpans(s, temp), // セル実測の区間長（区間長指定の反映）
        view: 'upper',
        selectable: false,
      }));
      setUpperStairEntries(entries);
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
      const context      = detectContext(snap, cl, opening, wall, clEndpoint);
      // 建具モードは壁・開口以外の長押しメニューを出さない（CL移動等の平面編集操作は行わない）。
      if (appMode === 'opening' && context !== CONTEXT.WALL && context !== CONTEXT.OPENING) return;
      const endpointState = clEndpoint ? {
        canExtend:  canExtendCenterLine(graph, clEndpoint.cl, clEndpoint.side),
        canShorten: canShortenCenterLine(graph, clEndpoint.cl, clEndpoint.side),
        isVertical: clEndpoint.cl.centerLineType === CenterLineType.VERTICAL,
        side:       clEndpoint.side,
      } : null;
      // 中心線上メニュー: 移動可否と線の向き（移動アイコンの矢印方向）を渡す。
      // 移動を選ばれたときに備え、移動範囲の計算（他フロアのIDB読み込みを含む）を先読みしておく。
      const clState = context === CONTEXT.CENTER_LINE ? {
        canMove:         typeof modeRef.current?.startMove === 'function',
        isVertical:      cl.centerLineType === CenterLineType.VERTICAL,
        hasInteriorWall: interiorWallSpans(graph, cl.id).length > 0,
      } : null;
      if (clState?.canMove) modeRef.current.preloadMove(cl);
      // 壁上メニュー: 腰壁・垂れ壁の適格性（2a壁は対象外）を渡す。
      const wallState = context === CONTEXT.WALL ? { eligible: isEligibleWallSpan(wall, graph) } : null;
      const items   = getMenuItems(context, endpointState, clState, wallState);
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
        await runStructuralModeSetup(project.activeGraph);
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

  // ---- CL移動の確定処理（ドラッグ確定=handlePointerUp・NumPad/Enter確定=CLMoveInput onCommit の
  // 単一実装。以前は2箇所に重複しており、片方だけ直すと確定経路によって挙動が食い違うバグになるため
  // 抽出した）。呼び出し側は「確定してよいか」（移動が実際にあったか等）を判定してから呼ぶこと——
  // ここでは常に確定する（moveState を閉じる）前提で処理する。
  // 平面モード等（通り芯・中心線・補助線）は従来どおり bake→隣接CLとの結合判定→Undo。
  // 梁芯（centerLineKind(cl)==='beam'）は小梁の局所再解決・再採番が要るため、梁芯の追加・削除と同じ
  // グラフスナップショット方式のUndoにする（mergeCenterLineChain は呼ばない——§3の範囲クランプで
  // 他の梁芯と同一座標に到達できないため共線判定が成立せず、到達不能な分岐を残さないため）。
  function commitCLMove(cl, originalValue) {
    const newValue = cl.effectiveValue;
    if (newValue === originalValue) {
      runInAction(() => { cl.pendingDelta = 0; });
      modeRef.current?.commitMove();
      return;
    }

    if (centerLineKind(cl) !== 'beam') {
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
      modeRef.current?.commitMove();
      return;
    }

    // ---- 梁芯: グラフスナップショット方式（局所再解決・再採番を含む1 undoエントリ）----
    const before = serializeGraph(graph);
    let counts = { before: 0, after: 0 };
    runInAction(() => {
      // 移動＝元位置の放棄と解釈する。次回のモード境界再計算で「壁由来の梁芯自動生成」が元の座標に
      // 復活しないよう、移動前の座標を除外集合へ記録する（cl-del分岐の記録と同じ意味・同じキー形式。
      // 手動追加の梁芯を動かした場合も無害——その座標に壁が無ければ単に使われないキーが残るだけ）。
      const axisKey = cl.centerLineType === CenterLineType.VERTICAL ? 'X' : 'Y';
      graph.excludedWallBeamAxes.add(`${axisKey}:${Math.round(originalValue)}`);
      bakeCLValue(cl, newValue);
      counts = resolveSecondaryBeamsForAxis(graph, cl, project);
      renumberMembers(graph, project, 'beamMap');
    });
    const after = serializeGraph(graph);
    undoManager.push(() => restoreGraph(graph, before), () => restoreGraph(graph, after));
    if (counts.after !== counts.before) {
      setToast({ msg: `小梁を${counts.before}本 → ${counts.after}本 に再構成しました`, key: Date.now() });
    }
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

  // applyNumbers の renumbered（既存タグが別タグへ変わった遷移一覧）から、モード境界の再採番トーストを
  // 1回だけ出す（初回採番=null→タグ は applyNumbers 側で除外済みのためここでは判定不要）。
  // 代表1件＋残りは「他N件」で簡潔に（設計意図: design-member-numbering-ui.md 5節）。
  function reportRenumberToast(renumbered) {
    if (!renumbered.length) return;
    const [first] = renumbered;
    const extra = renumbered.length - 1;
    setToast({
      msg: `材寸の変更にともない部材番号を振り直しました（${first.from} → ${first.to}${extra > 0 ? ` 他${extra}件` : ''}）`,
      key: Date.now(),
    });
  }

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

    // 自階：自動補完・柱芯・材変換・材寸算定・採番の収集（structuralRecompute.js。undo 非依存の純計算）。
    // 番号の確定（assignNumbers/applyNumbers）はまだ行わない——下階分の収集も済んでから1回だけ行う。
    const { changed } = await recomputeStructuralForGraph(subjectGraph, project, belowMainStructure);

    // 1つ下の階（構造伏図に映る柱の供給元）も実効主構造へ揃える。突入時は reflectStructuralToOtherFloors が
    // 事前に下階を反映・永続化済みのため、ここは peek 済みバインディングへの差分適用（通常は差分ゼロ）。
    // 主構造変更時は既に commit 済みで編集可能 peek のため恒久化される——これにより
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
        conformToLedger(belowGraph, project);
        collectFloorGroups(belowGraph, project);
      });
    }

    // 自階＋下階の収集が揃った時点の project.memberNumberIndex（直前の reflectStructuralToOtherFloors が
    // 積んだ他階分を含む）で1回だけ採番し、両方へ適用する（memberNumbering.js の2パス方式）。
    // ここが「ユーザーが今見ている画面の番号が確定する」地点のため、材寸変更にともなう振り直しの
    // トーストもここで報告する（初回採番=null→タグ は applyNumbers 側で除外済み）。
    const tags = assignNumbers(project);
    const renumbered = [];
    runInAction(() => {
      renumbered.push(...applyNumbers(subjectGraph, project, tags).renumbered);
      if (belowGraph) renumbered.push(...applyNumbers(belowGraph, project, tags).renumbered);
    });
    reportRenumberToast(renumbered);
    if (belowGraph && mutate) belowAfter = serializeGraph(belowGraph);

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
  // handleModeChange('structure') と、構造モード中のフロア切替（switchFloorKeepingMode）の両方から呼ぶ。
  async function runStructuralModeSetup(targetGraph) {
    const effectiveMainStructure = targetGraph.structureOverride ?? project.structuralInfo.mainStructure;
    if (effectiveMainStructure === '未定') {
      setToast({ msg: ERR_STRUCT_MAIN_UNSPECIFIED, key: Date.now() });
    }

    // 最上階の直上に屋根専用平面（小屋伏／R階伏）を同期する（undo対象外。建物形状が変わった時点でやり直し前提のインフラ）。
    runInAction(() => syncRoofPlane(project));

    // 突入時点でアクティブ階以外の全実体階へも構造部材を反映・永続化する（undo対象外インフラ）。
    // 自階だけの再計算では「訪れた伏図の階」にしか部材が入らず、他の伏図・他モードの図面が空のままになる。
    // バインディング構築より先に行うことで、下階レイヤの peek は反映済みデータを読む
    // （表示用 autofill は差分ゼロとなり、編集可能 peek のベースラインとも一致する）。
    await reflectStructuralToOtherFloors();

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
  // pushUndo=false は階追加フロー用（withFloorAddUndo が全階分を1エントリで巻き戻すため個別には積まない）。
  async function recomputeActiveStructural(pushUndo = true) {
    const g = project.activeGraph;
    const mainStructure = g.structureOverride ?? project.structuralInfo.mainStructure;
    const { changed, before, after } = await recomputeStructuralForGraph(g, project, mainStructure);
    if (changed && pushUndo) {
      undoManager.push(
        () => restoreGraph(g, before),
        () => restoreGraph(g, after),
      );
    }
  }

  // 非アクティブな実体階を peek して再計算し、変化があれば IDB に直接保存する。
  // syncRoofPlane と同格の「建物形状が変わった時点でやり直すインフラ」として undo 対象外で割り切る
  // （跨ぎフロア undo は単一アクティブ graph モデルでは扱えないため。削除の取消はベースライン保持で担保する）。
  // 採番は収集（conformToLedger + collectFloorGroups。structuralRecompute.js）のみ行い、番号の確定は
  // 呼び出し側（reflectStructuralToOtherFloors 等）が全階の収集後に1回だけ行う。
  async function recomputeInactiveStructural(plane) {
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    const mainStructure = temp.structureOverride ?? project.structuralInfo.mainStructure;
    const { changed } = await recomputeStructuralForGraph(temp, project, mainStructure);
    if (changed) await saveFloor(plane.id, serializeGraph(temp));
  }

  // 採番パス2: 直前に収集済みの project.memberNumberIndex を使って plane 1つへ番号を適用し、
  // 変化があれば保存する（非アクティブ階を peek→適用→保存。全階を同時にメモリ展開しない）。
  async function applyMemberNumbersToFloor(plane, tags) {
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    let changed = false;
    runInAction(() => { ({ changed } = applyNumbers(temp, project, tags)); });
    if (changed) await saveFloor(plane.id, serializeGraph(temp));
  }

  // アクティブ階以外の全実体階の構造部材を peek+再計算+保存で反映する（undo 対象外の決定的インフラ）。
  // 構造モードの境界（突入・脱出）と階追加フローが共有する「他階への構造反映」の単一実装——
  // これが無いと、構造モードで生成・編集した部材が「訪れた伏図の階」にしか入らず、
  // 他モード・他階へ移動したときに他の伏図・平面図へ構造部材が現れない（問題.md）。
  //
  // 材寸グループ採番は建物全体の情報が必要なため2パスで行う（memberNumbering.js）:
  //   パス1（収集）: 自階（メモリ上の現状）＋他の全実体階（peek→recompute→保存）を
  //                  project.memberNumberIndex へ積む。
  //   パス2（採番・適用）: assignNumbers を建物全体で1回だけ実行し、自階＋他の全実体階へ適用する
  //                  （変化があった階のみ保存）。
  // 屋根専用平面（isRoofPlane）は project.planes に含まれない（採番の「実体階」ループの対象外）ため、
  // 上の収集ループでは漏れる。屋根専用平面だけの記号（RF/PR/EG等）が収集から欠けると、記号ごとの
  // 階プレフィックス要否判定（needsPrefix。屋根グループの有無で階集合の同一性が変わる）が
  // 「屋根平面を直接訪れたかどうか」で揺れ、既存タグが行き来する誤った再採番トーストの原因になる。
  // 屋根専用平面には自階再計算（recomputeStructuralForGraph。mainStructureの解決に図面合成が要る）を
  // 素直には適用できないため、最低ラインとして「収集だけ」を常に行う（peekしたグラフは保存しない・
  // 番号も書き戻さない。実際の番号確定はユーザーが屋根伏図を直接訪れたときの通常経路に委ねる）。
  async function collectRoofPlaneGroups() {
    const roofPlane = project.roofPlane;
    if (!roofPlane || roofPlane.id === project.activePlaneId) return; // アクティブなら既に収集済み
    const temp = await floorSwapManager.peek(roofPlane, project.structGraph);
    runInAction(() => {
      conformToLedger(temp, project);
      collectFloorGroups(temp, project);
    });
  }

  async function reflectStructuralToOtherFloors() {
    const activeId = project.activePlaneId;
    runInAction(() => project.clearMemberNumberIndex());
    if (project.activeGraph) runInAction(() => collectFloorGroups(project.activeGraph, project));
    for (const plane of project.planes) {
      if (plane.id === activeId) continue;
      await recomputeInactiveStructural(plane);
    }
    await collectRoofPlaneGroups();
    const tags = assignNumbers(project);
    if (project.activeGraph) runInAction(() => applyNumbers(project.activeGraph, project, tags));
    for (const plane of project.planes) {
      if (plane.id === activeId) continue;
      await applyMemberNumbersToFloor(plane, tags);
    }
  }

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

  // 要件1：階追加後。追加で N（負担階数）・基礎指定が変わるため、全実体階の構造部材を更新する。
  // アクティブ（追加直後の表示階）はメモリ上で、その他の実体階は peek+保存で反映する。
  // undo は個別に積まない（呼び出し元の withFloorAddUndo が階追加フロー全体を1エントリで記録する）。
  // これにより別階・別モードへ移動したとき、更新後の柱・梁・材寸がそのまま描画される。
  async function reflectStructuralAfterFloorAdd() {
    await recomputeActiveStructural(false);
    await reflectStructuralToOtherFloors();
  }

  // 要件2：仕上げモード退出後。フットプリント（外壁線・吹抜け）変更は鉛直連続性ゲートにより
  // 自階と「自階より上の全実体階」のゲートに効く（wallGate.js：基準階＋直下の全階のAND）。
  // そのため自階（アクティブ）＋上の全階を再計算する。下階は影響を受けない。
  // 退出先が構造モードのときは runStructuralModeSetup が自階を再計算するため、自階・番号確定は
  // そちら（reflectStructuralToOtherFloors）に委ねる。退出先が構造モードでない場合はここで
  // 採番も確定する（次に構造モードへ入るまで番号が未確定のままにならないよう、直近の収集結果で確定する）。
  async function reflectStructuralAfterFinishExit(currentPlaneId, goingToStructure) {
    if (!goingToStructure) await recomputeActiveStructural();
    const planes = project.planes; // elevation 昇順
    const idx = planes.findIndex(p => p.id === currentPlaneId);
    const touchedPlanes = [];
    if (idx !== -1) {
      for (let i = idx + 1; i < planes.length; i++) {
        await recomputeInactiveStructural(planes[i]);
        touchedPlanes.push(planes[i]);
      }
    }
    if (!goingToStructure) {
      const tags = assignNumbers(project);
      if (project.activeGraph) runInAction(() => applyNumbers(project.activeGraph, project, tags));
      for (const plane of touchedPlanes) await applyMemberNumbersToFloor(plane, tags);
    }
  }

  // ---- モード境界: 構造モード突入（図面合成の構築・情報ダイアログ）----
  // handleModeChange（appMode切替）と移動スライダーの階切替（appMode維持）の両方から呼ぶ。
  // openInfoDialog: スライダー階切替では毎回ダイアログが開くのはUXとして不合理なため false にする。
  async function runStructuralEntryBoundary(targetGraph, { openInfoDialog = true } = {}) {
    if (openInfoDialog) setShowStructuralInfoDialog(true);
    await runStructuralModeSetup(targetGraph);
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
    if (reflectOtherFloors) await reflectStructuralToOtherFloors();
  }

  // ---- モード境界: 仕上げモード突入（前回脱出時点のRoom.cellsを現在のCLトポロジーと
  // 突き合わせて再解釈した上で、通り芯変更等のトポロジー差分でエッジを再同期する）----
  async function runFinishEntryBoundary(graph) {
    // 最上階なら直下階の屋内階段footprintへ階段吹抜け（STAIR_VOID）を補完する
    // （既存データ修復。syncUpperFloors と同じ自動同期のため undo 対象外）
    const { ensureTopStairVoid } = await import('./finish/stair/stairFloorSync.js');
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
      import('./finish/eccentricityFloorSync.js'),
      import('./finish/materials/materialData.js'),
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
  // goingToStructure: 遷移先が構造モードなら reflectStructuralAfterFinishExit 側で
  // 自階の再計算をスキップする（構造モード突入境界処理に委ねるため）。
  async function runFinishExitBoundary(graph, { goingToStructure = false } = {}) {
    const undoFns = [];
    const redoFns = [];

    // 寸法は実材厚から導出（modeRef.current は脱出直前でまだ生存・材ロード済み）。
    const fmode = modeRef.current;

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
      const { applyCLEccentricity } = await import('./finish/clEccentricity.js');
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
      const { applyCLEccentricity } = await import('./finish/clEccentricity.js');
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
      const { propagateCLEccentricities } = await import('./finish/eccentricityFloorSync.js');
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
      const { syncUpperStairInteriors } = await import('./finish/stair/stairFloorSync.js');
      await syncUpperStairInteriors(project, graph);
    }

    // 要件2：フットプリント確定後に構造モードへ問合せ、自階＋上の全階の構造部材を更新する。
    await reflectStructuralAfterFinishExit(graph.plane.id, goingToStructure);
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
      enter: (graph) => runFinishEntryBoundary(graph),
      exit: (graph, { toMode }) => runFinishExitBoundary(graph, { goingToStructure: toMode === 'structure' }),
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

  // Uint8Array 同士の内容比較（null 同士は等しい）
  function floorBytesEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

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

  // planeId のフロアへスナップショットを適用する。アクティブならメモリ上のグラフへ復元し、
  // 非アクティブなら IDB へ書き戻す（peek はキャッシュを持たないためこれで完全に復元される）。
  // bytes === null は「IDB 未保存」状態への巻き戻し（レコード削除）。
  function applyFloorBytes(planeId, bytes) {
    if (project.activePlaneId === planeId && project.activeGraph) {
      if (bytes != null) restoreGraph(project.activeGraph, bytes);
      return;
    }
    (bytes != null ? saveFloor(planeId, bytes) : dbDeleteFloor(planeId)).catch(console.error);
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
          for (const rec of changedSiblings) applyFloorBytes(rec.planeId, rec.before);
        })().catch(console.error);
      },
      () => {
        (async () => {
          for (const pl of addedPlanes) {
            addFloor(pl.elevation, pl.name, pl.startFloor, pl.stories, pl.id);
            const bytes = addedBytes.get(pl.id);
            if (bytes != null) await saveFloor(pl.id, bytes);
          }
          for (const rec of changedSiblings) applyFloorBytes(rec.planeId, rec.after);
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
      await reflectStructuralAfterFloorAdd();
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
        await reflectStructuralAfterFloorAdd();
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
        await reflectStructuralAfterFloorAdd();
      });
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
        if (tap.count === 2) performUndo();
        else if (tap.count === 3) performRedo();
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
    // 構造モードでは通り芯上でマウスが反応しない（既存仕様）が、梁芯は選択・削除・延長/短縮できる必要が
    // あるため、appModeで丸ごとnullにはせず kindFilter で「構造モード=梁芯のみ／他モード=梁芯以外」に絞る
    // （非表示の梁芯を非構造モードで拾わない・構造モードでは梁芯だけがヒットする、の両方をこれ一本で満たす）。
    const clKindFilter = appMode === 'structure' ? (k => k === 'beam') : (k => k !== 'beam');
    // CL端点（延長/短縮メニュー）は交点スナップより優先度は下だが、CL/開口/壁の排他選択とは別枠で判定する
    const clEndpointCand = findNearestCenterLineEndpoint(graph, world.x, world.y, CL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY, viewport, clKindFilter);
    // 交点スナップ中は CL/開口/壁の検出不要
    let cl = null, opening = null, wall = null;
    if (!snap) {
      const clCand      = findNearestCenterLine(graph, world.x, world.y, CL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY, viewport, clKindFilter);
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
      const cl = menu.cl;
      const isStruct = cl.discipline === Discipline.STRUCT && cl.labeled;
      if (isStruct) {
        // 通り芯の削除 — structGraph をスナップショット経由で Undo。
        // structGraph の teardown は階グラフの図形に届かないため、アクティブ階グラフ側の
        // 壁端・extent 参照を先に切り離す（端点ルール）。階グラフも Undo 対象に含める。
        const beforeArch = serializeGraph(graph);
        const before = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
        graph.detachFromCenterLine(cl.id);
        project.structGraph.removeCenterLine(cl.id);
        const afterArch = serializeGraph(graph);
        const after = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
        undoManager.push(
          () => {
            restoreStructCLs(project.structGraph, project.structuralInfo, before, project.memberGroupLedger);
            restoreGraph(graph, beforeArch);
          },
          () => {
            restoreStructCLs(project.structGraph, project.structuralInfo, after, project.memberGroupLedger);
            restoreGraph(graph, afterArch);
          },
        );
      } else {
        const before = serializeGraph(graph);
        // 梁芯CLの削除は「壁由来の梁芯自動生成」に対する明示的な手動削除として扱う——次回のモード境界
        // 再計算で元の座標に再生成されないよう、座標ベースの除外集合へ記録する（壁の位置自体は削除しない
        // ため、記録しないと自動生成が復活させてしまう）。キーは structural/wallBeamAxes.js と同じ形式。
        runInAction(() => {
          if (centerLineKind(cl) === 'beam') {
            const axisKey = cl.centerLineType === CenterLineType.VERTICAL ? 'X' : 'Y';
            graph.excludedWallBeamAxes.add(`${axisKey}:${Math.round(cl.effectiveValue)}`);
          }
          graph.removeCenterLine(cl.id);
        });
        const after = serializeGraph(graph);
        undoManager.push(
          () => restoreGraph(graph, before),
          () => restoreGraph(graph, after),
        );
      }
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
      const newValues = value.filter(v =>
        !graph.centerLines.some(cl => cl.centerLineType === clType && Math.abs(cl.value - v) < CL_OVERLAP_TOL_MM)
      );
      if (newValues.length === 0) {
        setToast({ msg: ERR_CL_DUPLICATE('struct'), key: Date.now() });
        setClDialog(null); setClPreview(null);
        return;
      }
      const before = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
      newValues.forEach(v =>
        project.structGraph.addCenterLine(clType, v, {
          discipline: Discipline.STRUCT,
          labeled:    true,
          trim:       !!trim,
        })
      );
      const after = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
      undoManager.push(
        () => restoreStructCLs(project.structGraph, project.structuralInfo, before, project.memberGroupLedger),
        () => restoreStructCLs(project.structGraph, project.structuralInfo, after, project.memberGroupLedger),
      );
      setClDialog(null); setClPreview(null);
      maybeSuggestWoodStructure(clType, newValues);
      return;
    }

    // extent 計算: center・beam（梁芯は中心線相当の処理を共用）は直交CL参照、aux は3ケース判定（壁・CL・フリー）
    let extentProps = {};
    let newExtentLo = null, newExtentHi = null;
    if (kind === 'center' || kind === 'beam') {
      const perpType = clType === CenterLineType.VERTICAL ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
      const wc = clDialog.worldCoord;
      const perpCLs = graph.centerLines.filter(cl => {
        if (cl.centerLineType !== perpType) return false;
        if (kind === 'beam') {
          // 梁芯の端部候補は通り芯（labeled）のみに限定する。中心線・補助線を候補に含めると
          // 直交グリッド（autoFillSecondaryBeamsが見るgraph.gridXs/Ys＝通り芯のみ）に存在しない
          // 区画へextentが確定してしまい、小梁が0本になる事故になる（QA指摘）。
          return cl.labeled;
        }
        // center: 梁芯（discipline:'fuse'。構造モード専用表示で他モードでは非表示）は
        // 端部候補から除外する——非表示の線が中心線のextent端部に選ばれるのを防ぐ。
        if (centerLineKind(cl) === 'beam') return false;
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
    const existing = graph.centerLines.find(
      cl => cl.centerLineType === clType && Math.abs(cl.value - value) < CL_OVERLAP_TOL_MM
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

      // 梁芯は他種別（通り芯/中心/補助線）と同位置に共存できない（大梁と完全重複する小梁の生成防止）。
      // 逆方向（既存が梁芯で新規が別種別）も同様に拒否する。
      if (kind !== existingKind && (kind === 'beam' || existingKind === 'beam')) {
        setToast({ msg: ERR_CL_DUPLICATE(existingKind), key: Date.now() });
        return;
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
      ...(kind === 'beam'   ? { discipline: Discipline.FUSE, labeled: false } : {}),
      trim: !!trim,
      ...(isRefResolvable ? { refId, refOffset: refOffset ?? 0 } : {}),
    };

    if (kind === 'beam') {
      // 梁芯CL追加＋直交大梁に挟まれた区間の小梁自動生成＋採番を1 undoエントリにまとめる
      // （グラフスナップショット方式。CL削除連鎖などと同じ既存パターン）。
      const before = serializeGraph(graph);
      runInAction(() => {
        const newCl = graph.addCenterLine(clType, value, props);
        // 壁由来の梁芯自動生成の除外集合を解除する（addColumn/addBeamがexcluded*Slotsを解除する
        // 既存パターンと同型）——手動でこの位置に梁芯を追加した以上、以後の自動生成で復活してよい。
        const axisKey = clType === CenterLineType.VERTICAL ? 'X' : 'Y';
        graph.excludedWallBeamAxes.delete(`${axisKey}:${Math.round(newCl.effectiveValue)}`);
        autoFillSecondaryBeams(graph, project);
        autoFillBeamEccentricity(graph, project);
        renumberMembers(graph, project, 'beamMap');
      });
      const after = serializeGraph(graph);
      undoManager.push(() => restoreGraph(graph, before), () => restoreGraph(graph, after));
      setClDialog(null);
      setClPreview(null);
      return;
    }

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

  // 階段の設置階（install）・上階見下げ（upper）の描画エントリ。StairLayer の描画と
  // 2a壁の描画クリップ（stairUnderClip.js）の双方が使うため、ここで1度だけ計算する
  // （install側は二重計算しない。ただしbuildStairGeometry自体はStairLayerの描画用フル
  // ジオメトリと stairUnderClip.js の breakLine 抽出用で別々に呼ばれる——後者は前者の
  // 出力を再利用しない、別計算）。upperStairEntries は finish/floorplan 以外または
  // 階・モード切替直後の1フレームは null（未解決。該当useEffect参照）。
  // isStairMode: site・structure モードでは階段を描画しないため、cellsBeyondBreak・
  // refreshCells・measureStairSpans 等の無駄な計算と observable 購読（graph.stairs等）を
  // 空配列で止める（QA指摘）。stairUnderClips のゲートも同じ変数で揃える。
  const isStairMode = appMode === 'finish' || appMode === 'floorplan';
  const stairFh = floorHeightAbove(project, project.activePlane);
  const installEntries = isStairMode ? graph.stairs.map(s => {
    const riser = s.riser ?? (stairFh != null ? stairFh / Math.max(1, s.totalSteps) : null);
    // 破れ線先セルはヒット領域から除外する（下階階段の見下げクリック・階段下エリアの
    // 部屋ドラッグは startDrag に一本化されているため、ここでは自階階段の onClick を発火させない）。
    const beyond = cellsBeyondBreak(s, graph, riser);
    const refreshed = refreshCells(s.cells, graph);
    const hitCells = beyond.size > 0
      ? new Set([...refreshed].filter(k => !beyond.has(k)))
      : s.cells;
    return {
      id: s.id,
      stair: s,
      graph, // 側面線の壁有無判定（resolveStairSideLines）に使う
      bounds: roomBounds(s.cells, graph),
      cellBounds: cellBoundsList(s.cells, graph), // 実セル占有（L字等の選択枠用）
      hitCellBounds: cellBoundsList(hitCells, graph), // クリックヒット領域（破れ線先セル除外）
      beyondBreakBounds: cellBoundsList(beyond, graph), // 破れ線先セルのワールド矩形（重なるupperの踏面間引きに使う）
      riser,
      spans: measureStairSpans(s, graph), // セル実測の区間長（区間長指定の反映）
      view: 'install',
      selectable: appMode === 'finish',
    };
  }) : [];
  // 階切替の非同期過渡で同一階段が install/upper 両方に入るのを防ぐ
  // （install が設置階の正であり、upper は直下階由来。重複時は install を優先）
  const installStairIds = new Set(installEntries.map(e => e.id));
  // footprint が自階 install 階段と重なる upper エントリ（下階階段が自階の
  // 自動設置階段と同じ位置に見下げ表示される場合）は installOverlap を付与し、
  // StairLayer 側でプリミティブ別に独立フィルタする: 矢印は install の破れ線で
  // クリップ、踏面線は破れ線先セル（beyondBreakBounds。cellsBeyondBreak で
  // 全タイプ単一ソース判定済み）の中点判定、段数字はアンカー点判定で破れ先の
  // 番号だけ残す（重ならなければ従来どおりフル描画）。
  // upperStairEntries===null（未解決）の間は StairLayer には従来どおり空扱いで渡す
  // （初回マウント時の見た目は元々空だったため変化なし）。中間階ガードの安全側判定は
  // 下記 stairUnderClips 側で null を別途見て行う。isStairMode===false でも空配列に
  // 揃える（site・structure モードでの無駄なフィルタ・マップ計算を止める）。
  const upperEntries = isStairMode
    ? (upperStairEntries ?? [])
        .filter(e => !installStairIds.has(e.id))
        .map(e => {
          const overlapInstall = installEntries.find(ie => anyCellBoundsOverlap(e.cellBounds, ie.cellBounds));
          return overlapInstall
            ? {
                ...e, installOverlap: true, clipAgainstId: overlapInstall.id,
                beyondBreakBounds: overlapInstall.beyondBreakBounds,
              }
            : e;
        })
    : [];

  // 折返し階段の往路・復路の間のあき（簡略LODのみ0）・破れ線の見た目端部のはり出し量。
  // StairLayer の描画と2a壁クリップ計算の双方へ渡す（描かれる破れ線とクリップ線のズレ防止）。
  const stairLaneGapMm = viewport.lodLevel === LodLevel.SCHEMATIC ? 0 : LANE_GAP;
  const stairBreakOverhangMm = overhangMm(viewport, false);

  // 2a壁（階段下部屋の偏芯壁）の破れ線より階段踏面側を描画しないための、壁ID→クリップ多角形。
  // StairLayer と同じ条件（isStairMode）でゲートする——それ以外のモード（site等）では
  // 壁を常にクリップなしで描く（モード間で壁の見え方を変えない）。また upperStairEntries が
  // 未解決（null。階/モード切替直後の1フレーム）の間は中間階ガードが判定不能なため、
  // 安全側で一切クリップしない（QA指摘）。stairUnderWallClips はクリップ対象が0件のとき自ら
  // null を返す（毎レンダー新規の空Mapを渡し続けて observer の差分検出が無駄に走るのを防ぐ）。
  const stairUnderClips = isStairMode && upperStairEntries !== null
    ? stairUnderWallClips(graph, installEntries, {
        laneGapMm: stairLaneGapMm,
        breakOverhangMm: stairBreakOverhangMm,
        detail: viewport.lodLevel === LodLevel.DETAIL,
        lowerStairCellBounds: upperEntries.map(e => e.cellBounds).filter(Boolean).flat(),
      })
    : null;

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
            if (structComposition) recomputeStructuralComposition(structComposition, project.activeGraph, { mutate }).catch(console.error);
            else runInAction(mutate); // 万一 composition 未確立時は変更だけ反映
          }}
        />
      )}
    </>
  );
});

export default App;
