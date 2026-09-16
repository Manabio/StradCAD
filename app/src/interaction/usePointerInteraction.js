// ポインタ/タッチ/長押しのジェスチャー配線（App.jsx Step5リファクタで抽出）。
// このフックは mode-system.md の言う「App.jsx 側の ref/state」に含まれる。
// modes/ の MobX クラスへ移さないこと（モード間で共有しないジェスチャー用一時状態のため）。
//
// 「ジェスチャー判別とディスパッチ」だけを持つ。graph 変更＋undo push は既に抽出済みの
// ドメインモジュール（transform/centerLineOps.js 等）呼び出しのまま（描画完成時の
// addDiagonalLine undo 等、数行の例外はそのまま持つ）。
import { useRef, useState } from 'react';
import { runInAction } from 'mobx';
import { viewport } from '../appViewport.js';
import { undoManager } from '../undoManager.js';
import {
  findCLMoveSnap,
  findBeamAxisMoveSnap,
  resolvePointerTargets,
  SNAP_THRESHOLD_PX,
} from '../snap.js';
import { useLongPress } from './useLongPress.js';
import { findColumnAxisLabel, findGutterCL } from './gutterHitTest.js';
import { CONTEXT, detectContext, buildMenuState } from './menuItems.js';
import { centerLineKind, CenterLineType } from '@core';
import { roundAbsToStep, calcStep } from '../renderer/clMoveMath.js';
import { findHostWall } from '../openings/openingGeometry.js';
import { beamAtKonvaTarget, shouldFireMemberTap, isBlankTapTarget } from './beamTap.js';
import {
  openingMoveRange, openingSnapCandidates, resolveOpeningRefOffset, snapIndicatorAlong,
  elevationDragAlong, previewDxLocalMm,
} from '../openings/openingMove.js';
import { snapshotOpening, pushOpeningUndo } from '../openings/openingEdit.js';
import { inGutter as isInGutter } from '../layout.js';
import { commitCLMoveOp, commitStretchWithUndo } from '../transform/centerLineOps.js';
import { commitSiteTapLine } from '../transform/siteEdit.js';
import { canExtendCenterLine, canShortenCenterLine } from '../transform/centerLineExtend.js';
import { isLastGridOnAxis } from '../transform/centerLineConvert.js';
import { interiorWallSpans } from '../finish/edgeClassify.js';
import { isEligibleWallSpan } from '../finish/kneeDropWall.js';

// project, graph, size, appMode, columnAxisMode, modeRef, menu, setMenu, onToast, onUndo, onRedo,
// onExitOpeningMode は毎レンダー App.jsx から渡す（useCallback/useMemo で固定しない——
// modeRef.current・graph の鮮度が「毎レンダー再生成」前提に依存する）。
// onExitOpeningMode: 建具モードで建具ターゲット以外の描画エリアをタップしたときの脱出
// （App.jsx の handleModeChange('floorplan')。境界処理を通す唯一の経路をそのまま呼ぶ）。
export function usePointerInteraction({
  project, graph, size, appMode, columnAxisMode, modeRef,
  menu, setMenu, onToast, onUndo, onRedo, onExitOpeningMode, onMemberClick, onMemberDeselect,
}) {
  const [isPanning,   setIsPanning]   = useState(false);
  const [pressPos,    setPressPos]    = useState(null);
  const [cursorWorld, setCursorWorld] = useState(null);
  const [cursorScreen,setCursorScreen]= useState({ x: 0, y: 0 });

  // ---- スナップ系 state と ref（同時更新）----
  // 元は state→ref の同期を useEffect 5本で行っていたが、フック化にあたり
  // 「state と ref を同時更新するラッパー」に統合し、effect を廃した（許容された設計変更）。
  const [snapPoint,      _setSnapPoint]      = useState(null);
  const [nearCL,         _setNearCL]         = useState(null);
  const [nearWall,       _setNearWall]       = useState(null);
  const [nearOpening,    _setNearOpening]    = useState(null);
  const snapRef           = useRef(null);
  const nearCLRef         = useRef(null);
  // nearCLEndpoint は longPress の onFire（ref経由）でのみ参照され、JSX には一切現れない
  // （元コードでも state 化していたのは他4件との対称性のみで、描画に使われたことはない）。
  // state化は不要なので ref のみで持つ（他4件との違いはこの点のみ。挙動は変えない）。
  const nearCLEndpointRef = useRef(null);
  const nearWallRef       = useRef(null);
  const nearOpeningRef    = useRef(null);
  function setSnapPoint(v)      { snapRef.current           = v; _setSnapPoint(v); }
  function setNearCL(v)         { nearCLRef.current          = v; _setNearCL(v); }
  function setNearCLEndpoint(v) { nearCLEndpointRef.current  = v; }
  function setNearWall(v)       { nearWallRef.current         = v; _setNearWall(v); }
  function setNearOpening(v)    { nearOpeningRef.current      = v; _setNearOpening(v); }

  const drag          = useRef(null);
  const pinch         = useRef(null);
  const touchTapRef   = useRef(null);
  const drawDownRef       = useRef(null);
  const moveDownRef       = useRef(null); // CL移動: pointer-down 記録用
  const stretchDownRef    = useRef(null); // ストレッチ開始判定用: { clientX, clientY, snap }
  const gutterCLRef       = useRef(null); // ガター長押し中のCL
  const axisLabelRef      = useRef(null); // 柱芯ラベル長押し中: { cl, sx, sy }
  const finishDragDownRef = useRef(null); // 仕上げモード: pointerDown 座標
  const siteDrawDownRef   = useRef(null); // 敷地モード: ドラッグ開始スクリーン座標
  const elevationDragRef  = useRef(null); // 展開モード: { x, y, axis:'h'|'v'|null, roomId }
  const openingDownRef    = useRef(null); // 建具ドラッグ開始判定用: { clientX, clientY, opening }
  const openingDragRef    = useRef(null); // 建具ドラッグ中: { opening, wall, range, candidates, grabDelta, before }
  const openingDragEndedRef = useRef(false); // 直前の pointerUp が建具ドラッグの確定だったか（記号丸の click を無視するため）

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
        if (err) onToast(err);
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
      // 中心⇔通り芯の入替え（平面モード限定）: RADIAL(R) は _createIntersections がV/H専用・
      // findNearestCenterLine も対象外のため除外する（isPlanar）。
      const isPlanar = (c) => c.centerLineType === CenterLineType.VERTICAL || c.centerLineType === CenterLineType.HORIZONTAL;
      const state = buildMenuState(appMode, {
        snap, cl, clEndpoint, opening, wall,
        canMove: typeof modeRef.current?.startMove === 'function',
        canExtend:  clEndpoint ? canExtendCenterLine(graph, clEndpoint.cl, clEndpoint.side) : undefined,
        canShorten: clEndpoint ? canShortenCenterLine(graph, clEndpoint.cl, clEndpoint.side) : undefined,
        hasInteriorWall: menuContext === CONTEXT.CENTER_LINE ? interiorWallSpans(graph, cl.id).length > 0 : undefined,
        wallEligible:    menuContext === CONTEXT.WALL ? isEligibleWallSpan(wall, graph) : undefined,
        canToGrid: appMode === 'floorplan' && !!clEndpoint
          && centerLineKind(clEndpoint.cl) === 'center' && isPlanar(clEndpoint.cl),
        canToCenter: appMode === 'floorplan' && menuContext === CONTEXT.CENTER_LINE
          && centerLineKind(cl) === 'struct' && isPlanar(cl),
        // cl-to-center・cl-delの両方のグレー化判定に使う共有値（降格ガードcheckDemoteToCenterGuardsの
        // ERR_CL_CONVERT_LAST_GRID・削除ガードdeleteCenterLineWithUndoのERR_CL_DELETE_LAST_GRIDと
        // 同じisLastGridOnAxis判定式）。cl-to-centerはappMode==='floorplan'限定だがcl-del（通り芯の
        // 削除）はモードを問わないため、ここではappMode条件を付けない——struct(通り芯)以外に対して
        // isLastGridOnAxisを呼ぶと同軸通り芯0本でtrueを返しかねないため、centerLineKind(cl)==='struct'
        // のガードだけは必須（menuItems.jsのcl-to-center/cl-del双方がこの値をそのまま使う前提）。
        // cl.labeledも明示的に要求する——処理側ガード（centerLineOps.js deleteCenterLineWithUndoの
        // isStruct = discipline===STRUCT && labeled）と条件を揃え、discipline:STRUCTかつlabeled:false
        // という現状は生成経路が無く到達不能な組合せ（将来demoteToAuxiliary相当が復活した場合の保険）でも
        // UI側と処理側の判定が食い違わないようにする（canToCenterは降格ガードのERR_CL_CONVERT_INVALID
        // 判定=centerLineKind(cl)==='struct'のみと整合させる必要があるため、こちらは変えない）。
        isLastGridOnAxis: menuContext === CONTEXT.CENTER_LINE && centerLineKind(cl) === 'struct' && cl.labeled && isPlanar(cl)
          ? isLastGridOnAxis(graph, cl) : undefined,
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

  // ---- ホイールズーム ----
  const handleWheel = (e) => {
    e.evt.preventDefault();
    // 展開モードはズームが存在しない（固定倍率）。代わりにホイール上下を縦スクロールに
    // 接続する（項目1）。deltaY>0（下スクロール）で下方向＝より下の帯が見える向き
    // （一般的なスクロール可能領域の慣習。ドラッグ時の「コンテンツが指に追従する」向きとは
    // 符号が逆になる——ドラッグはコンテンツをつまむ操作、ホイールは視点を動かす操作のため）。
    // クランプはscrollBy内部（書き込み時クランプ。QA G1）にそのまま委ねる。
    if (appMode === 'elevation') {
      const scale = modeRef.current?.scale;
      if (scale > 0) modeRef.current?.scrollBy(0, -e.evt.deltaY / scale, null);
      return;
    }
    const factor = e.evt.deltaY < 0 ? 1.1 : 1 / 1.1;
    viewport.zoomAt(e.evt.clientX, e.evt.clientY, factor);
    updateSnap(e.evt.clientX, e.evt.clientY);
  };

  // ---- ポインタ Down ----
  const handlePointerDown = (e) => {
    const { clientX, clientY } = e.evt;
    if (e.evt.touches) return;
    if (menu) return;

    // ---- 展開モード ----
    if (appMode === 'elevation') {
      // 建具ターゲット（姿図のヒット矩形・記号丸）の押下は建具ドラッグの候補（8px超で開始）。
      // スクロールにはしない（8px未満の動きでスクロールしないのは許容）。
      openingDragEndedRef.current = false;
      const hit = elevationHitAtTarget(e.target);
      if (hit) {
        openingDownRef.current = { clientX, clientY, opening: hit.opening, dirSign: hit.dirSign };
        return;
      }
      elevationDragRef.current = {
        x: clientX, y: clientY, axis: null,
        roomId: modeRef.current?.bandAtScreenY(clientY) ?? null,
      };
      return;
    }

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
    // 建具ドラッグの起点候補（平面/建具モード）: 記号丸・平面記号の線分（Konva ヒット。openingId 属性）
    // または壁線近傍の建具本体（nearOpening）。ここでは押下を記録するだけで、8px超の移動で開始する
    // （交点ストレッチと同じ規約。長押しが先に成立すれば従来どおりメニュー）。
    openingDragEndedRef.current = false;
    if (appMode === 'floorplan' || appMode === 'opening') {
      const opening = openingAtKonvaTarget(e.target) ?? nearOpeningRef.current;
      if (opening) openingDownRef.current = { clientX, clientY, opening };
    }
    // 交点スナップ中なら押下位置を記録（移動閾値超えでストレッチへ）
    if (snapRef.current) stretchDownRef.current = { clientX, clientY, snap: snapRef.current };
    longPress.begin(clientX, clientY);
  };

  // ---- 建具ドラッグ（壁長さ方向の1次元移動）----
  // 範囲・スナップ候補・確定値は openings/openingMove.js（純関数）。ここは refOffset の書き換えと
  // インジケータ表示のみ。壁の切り欠き・記号・記号丸は refOffset から導出されるため自動で追従する。
  // 確定は pushOpeningUndo（差分が無ければ積まない）。キャンセル（canvas外・ESC）は before へ戻す。
  function openingAtKonvaTarget(target) {
    if (!target || typeof target.getAttr !== 'function') return null;
    const id = target.getAttr('openingId') ?? target.findAncestor?.('.opening-symbol')?.getAttr('openingId');
    return id != null ? (graph?.shapeMap.get(id) ?? null) : null;
  }
  // 平面: 世界座標の壁長さ方向成分（along）。展開図: 押下時の開口中心＋画面x移動×dirSign（下記）。
  function planAlongAt(wall, clientX, clientY) {
    const world = viewport.screenToWorld(clientX, clientY);
    return wall.isVertical ? world.y : world.x;
  }
  // alongAtDownFn(wall) → 押下点の壁長さ方向座標（ホスト壁が決まってから評価する）
  function startOpeningDrag(opening, alongAtDownFn, extra = {}) {
    const wall = findHostWall(opening, graph);
    if (!wall) return false;
    const range = openingMoveRange(wall, opening, graph);
    if (!range) return false;
    openingDragRef.current = {
      opening, wall, range,
      candidates: openingSnapCandidates(wall, opening, graph, range),
      grabDelta: opening.centerCoord - alongAtDownFn(wall), // つまんだ点と開口中心のずれ（中心がカーソルへ飛ばないように）
      before: snapshotOpening(opening),
      ...extra,
    };
    return true;
  }
  // 確定値を求めて refOffset へ書く（平面・展開図共通）。戻り値は resolveOpeningRefOffset の結果（null=無効入力）。
  function applyOpeningDrag(alongNow, thresholdMm, stepMm, { write = true } = {}) {
    const st = openingDragRef.current;
    const r = resolveOpeningRefOffset(alongNow + st.grabDelta, {
      refValue: st.opening.refCL.effectiveValue, range: st.range, candidates: st.candidates, thresholdMm, stepMm,
    });
    if (write && r && r.refOffset !== st.opening.refOffset) runInAction(() => { st.opening.refOffset = r.refOffset; });
    return r;
  }
  function updatePlanOpeningDrag(clientX, clientY) {
    const st = openingDragRef.current;
    const scale = st.wall.isVertical ? viewport.scaleY : viewport.scaleX;
    const r = applyOpeningDrag(planAlongAt(st.wall, clientX, clientY), SNAP_THRESHOLD_PX / scale, calcStep(viewport.scaleDenominator));
    setCursorWorld(viewport.screenToWorld(clientX, clientY));
    setCursorScreen({ x: clientX, y: clientY });
    if (r?.snapped) {
      const a = snapIndicatorAlong(r.candidate, st.opening.width / 2);
      setSnapPoint(st.wall.isVertical ? { x: st.wall.axisValue, y: a } : { x: a, y: st.wall.axisValue });
    } else {
      setSnapPoint(null);
    }
  }
  // 展開図: 押下点からの画面x移動(px)÷mode.scale(px/mm)×dirSign が壁長さ方向の移動量（elevationFigure.js の
  // localXOf の逆）。ドラッグ中は refOffset を書かない——書くたびに ElevationModeState の reaction が帯を
  // 丸ごと再構築して応答が追いつかない（実機指摘 2026-09-14）。代わりに確定値を求めてプレビュー
  // （setOpeningDragPreview: その建具のプリミティブだけを帯ローカルxでずらす。ElevationLayer.jsx）を
  // requestAnimationFrame で1フレーム1回更新し、確定時（flush）に refOffset を1回だけ書く。
  // 刻みと吸着閾値は平面より細かくする（ユーザー指示 2026-09-14）: 展開図は倍率が固定で小さく、平面と
  // 同じ「表示倍率に応じた刻み（1/100なら100mm）」「20px（1/100で約500mm）」では微調整ができない。
  // 刻みは 10mm 固定（画面1px未満＝実質連続。最終値は建具タブの位置欄で手打ちする前提）、吸着は 8px。
  // インジケータは平面専用なので出さない。
  const ELEVATION_DRAG_STEP_MM = 10;
  const ELEVATION_SNAP_THRESHOLD_PX = 8;
  function updateElevationOpeningDrag(clientX) {
    const st = openingDragRef.current;
    const scale = modeRef.current?.scale;
    if (!(scale > 0)) return;
    st.pendingAlong = elevationDragAlong({ downCenter: st.downCenter, downClientX: st.downClientX, clientX, scale, dirSign: st.dirSign });
    if (st.raf != null) return;
    st.raf = requestAnimationFrame(() => {
      st.raf = null;
      if (openingDragRef.current !== st) return;
      const r = applyOpeningDrag(st.pendingAlong, ELEVATION_SNAP_THRESHOLD_PX / scale, ELEVATION_DRAG_STEP_MM, { write: false });
      if (!r) return;
      const newCenter = st.opening.refCL.effectiveValue + r.refOffset;
      modeRef.current?.setOpeningDragPreview?.({ openingId: st.opening.id, dxLocalMm: previewDxLocalMm(newCenter, st.downCenter, st.dirSign) });
    });
  }
  // 確定: 最後の位置で refOffset を1回書き（帯の再構築はこの1回だけ）、プレビューを同じ action 内で消す
  // （別々に行うと「再構築後の帯」に「プレビューのずらし」が重なる1フレームが出る）。
  function flushElevationOpeningDrag() {
    const st = openingDragRef.current;
    if (!st || st.downCenter == null) return; // 平面ドラッグ
    if (st.raf != null) { cancelAnimationFrame(st.raf); st.raf = null; }
    const scale = modeRef.current?.scale;
    const r = scale > 0 && st.pendingAlong != null
      ? applyOpeningDrag(st.pendingAlong, ELEVATION_SNAP_THRESHOLD_PX / scale, ELEVATION_DRAG_STEP_MM, { write: false })
      : null;
    runInAction(() => {
      modeRef.current?.setOpeningDragPreview?.(null);
      if (r && r.refOffset !== st.opening.refOffset) st.opening.refOffset = r.refOffset;
    });
  }
  // 確定（平面・展開図共通）: undo 1件（動いていなければ積まない）＋その建具を選択。
  function finishOpeningDrag() {
    const st = openingDragRef.current;
    flushElevationOpeningDrag();
    openingDragRef.current = null;
    openingDownRef.current = null;
    pushOpeningUndo(graph, project, st.opening, st.before);
    openingDragEndedRef.current = true; // 記号丸から始めた場合、直後に飛ぶ click（モード遷移）を無視させる
    modeRef.current?.selectOpening?.(st.opening.id);
    setSnapPoint(null);
  }
  function cancelOpeningDrag() {
    const st = openingDragRef.current;
    openingDragRef.current = null;
    openingDownRef.current = null;
    if (st?.raf != null) cancelAnimationFrame(st.raf);
    runInAction(() => {
      if (st?.downCenter != null) modeRef.current?.setOpeningDragPreview?.(null); // 展開図プレビューを消す
      if (st && st.opening.refOffset !== st.before.refOffset) st.opening.refOffset = st.before.refOffset;
    });
    setSnapPoint(null);
  }
  // 展開図の建具ターゲット（姿図のヒット矩形・記号丸。openingId と dirSign の Konva 属性を持つ）
  function elevationHitAtTarget(target) {
    if (!target || typeof target.getAttr !== 'function') return null;
    const id = target.getAttr('openingId'), dirSign = target.getAttr('dirSign');
    if (id == null || (dirSign !== 1 && dirSign !== -1)) return null;
    const opening = graph?.shapeMap.get(id);
    return opening ? { opening, dirSign } : null;
  }

  // ---- ポインタ Move ----
  const handlePointerMove = (e) => {
    const { clientX, clientY } = e.evt;
    if (menu) return;

    // ---- 展開モード ----
    if (appMode === 'elevation') {
      // 建具ドラッグ中／起動判定（8px超で開始。押下点＝開口中心をつまんだ扱いなので grabDelta=0）
      if (openingDragRef.current) { updateElevationOpeningDrag(clientX); return; }
      if (openingDownRef.current) {
        const d = openingDownRef.current;
        if (Math.hypot(clientX - d.clientX, clientY - d.clientY) > 8) {
          openingDownRef.current = null;
          const c = d.opening.centerCoord;
          if (startOpeningDrag(d.opening, () => c, { downCenter: c, downClientX: d.clientX, dirSign: d.dirSign, raf: null, pendingAlong: null })) {
            updateElevationOpeningDrag(clientX);
          }
        }
        return;
      }
      const drag = elevationDragRef.current;
      if (!drag) return;
      const dx = clientX - drag.x;
      const dy = clientY - drag.y;
      if (!drag.axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; // 閾値未満はまだ軸ロックしない
        drag.axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      }
      drag.x = clientX;
      drag.y = clientY;
      const scale = modeRef.current?.scale;
      if (scale > 0) {
        const dxMm = drag.axis === 'h' ? dx / scale : 0;
        const dyMm = drag.axis === 'v' ? dy / scale : 0;
        modeRef.current?.scrollBy(dxMm, dyMm, drag.roomId);
      }
      setIsPanning(true);
      return;
    }

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

    // ---- 建具ドラッグ中（平面）----
    if (openingDragRef.current) {
      updatePlanOpeningDrag(clientX, clientY);
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
    // 建具ドラッグ起動判定: 建具ターゲットからの 8px 超のドラッグ（長押し成立前）。ストレッチ・
    // パンより優先する。開始できない（ホスト壁なし・収まる余地なし）ときは従来の判定へ落とす。
    if (openingDownRef.current) {
      const { clientX: dX, clientY: dY, opening } = openingDownRef.current;
      if (Math.hypot(clientX - dX, clientY - dY) > 8) {
        openingDownRef.current = null;
        if (startOpeningDrag(opening, wall => planAlongAt(wall, dX, dY))) {
          stretchDownRef.current = null;
          longPress.abort();
          updatePlanOpeningDrag(clientX, clientY);
          return;
        }
      }
    }
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
    if (toast) onToast(toast);
    modeRef.current?.commitMove();
  }

  // 建具モードの脱出タップか（＝建具ターゲット以外の描画エリアのタップか）。
  // 「建具ターゲット」は2種類あり、判定方法が違う:
  //   ・壁上の建具本体 → nearOpening（snap.js の近傍判定。タップで選択する対象そのもの）
  //   ・記号丸・記号線分 → Konva のヒット結果。記号丸は壁から離れた室内側に置かれ、扉の動作弧も
  //                     壁から離れるため近傍判定では拾えない。OpeningTagLayer の Circle と
  //                     OpeningsLayer の記号線分（建具ドラッグの起点。線分の8pxのみ）だけが listening
  //                     なので、e.target が Stage 以外＝建具ターゲットに当たった、と判定できる。
  // ガター帯（通り芯エリア）は描画エリアではないので脱出させない。
  // 呼び出し側で drag・長押しメニュー・描画/移動中は既に除外済み。加えて「タップ」に限定する
  // ——長押しが成立済み（isPending()===false）なら脱出しない。建具モードの長押しは壁・開口以外で
  // メニューを出さない（menuItems.js）ため、長押ししてそのまま離しただけでモードが変わると驚く。
  // ガター側の押下は longPress.begin を通らないので、この判定だけでも二重に弾かれる。
  function isOpeningModeExitTap(e) {
    if (!longPress.isPending()) return false;
    if (nearOpeningRef.current) return false;
    const stage = e.target?.getStage?.();
    if (!stage || e.target !== stage) return false;
    const { clientX, clientY } = e.evt;
    return !isInGutter(clientX, clientY, size.width, size.height);
  }

  // ---- ポインタ Up ----
  const handlePointerUp = (e) => {
    // ---- 展開モード ----
    if (appMode === 'elevation') {
      if (openingDragRef.current) finishOpeningDrag();
      openingDownRef.current = null;
      elevationDragRef.current = null;
      setIsPanning(false);
      return;
    }

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

    // ---- 建具ドラッグ確定（平面）----
    if (openingDragRef.current) {
      finishOpeningDrag();
      longPress.abort();
      drag.current = null;
      setIsPanning(false);
      return;
    }
    openingDownRef.current = null;

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

    // 構造モード: 伏図の梁タップ（F4。在来木造のみ有効——onMemberClickの真偽＋pickMembersOnFigureの
    // 判定はStructuralLayer.jsx側）。成立条件の判定（interaction/beamTap.js shouldFireMemberTap）は
    // 純関数へ抽出済み——node:testでパン・長押しの各信号を単体検証できる（team-lessons「抽出モジュールは
    // 呼び出し側もテストで守る」）。
    if (shouldFireMemberTap({
      appMode, onMemberClick, menu, panned: !!drag.current, longPressFired: longPress.hasFired(),
      busy: !!drawDownRef.current || !!modeRef.current?.moveState || !!modeRef.current?.drawState,
    })) {
      const beam = beamAtKonvaTarget(e.target, graph);
      if (beam) onMemberClick(beam, 'beamMap');
      // 空白タップ（Stage 自身が target＝どの部材・タグにも当たらない）は選択解除。構造モードには
      // 留まる（ユーザー裁定2026-09-17）。部材タグ（MemberTagLayer）のクリックは target がタグ図形に
      // なるためここには来ない＝タグクリックで開いたカードを同じタップで閉じてしまわない。
      else if (isBlankTapTarget(e.target)) onMemberDeselect?.();
    }

    // 平面モード: 通常タップで開口を選択（パレット表示）/ 空白タップで選択解除。
    // 建具モード: 建具ターゲットのタップで選択（パネルに姿図・フォームを表示）/ それ以外の
    // 描画エリアのタップで平面モードへ脱出（脱出経路2026-09。パネルの×・モードバーに次ぐ3本目）。
    // 描画・移動・パン・長押しメニュー中は対象外。
    if ((appMode === 'floorplan' || appMode === 'opening') && !menu && !drag.current
        && !drawDownRef.current && !modeRef.current?.moveState && !modeRef.current?.drawState) {
      if (appMode === 'opening' && isOpeningModeExitTap(e)) {
        onExitOpeningMode?.();
      } else {
        // 記号線分（OpeningsLayer の Group。壁から離れた動作弧など nearOpening に掛からない部分）の
        // タップも選択にする——線分が listening になった（建具ドラッグの起点）ことで e.target が
        // Stage でなくなり脱出タップにならないため、選択解除で終わらせず当該建具を選ぶ。
        const tapped = openingAtKonvaTarget(e.target) ?? nearOpeningRef.current;
        modeRef.current?.selectOpening?.(tapped?.id ?? null);
      }
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

  // ---- ポインタ Leave (外アップ扱い) ----
  const handlePointerLeave = () => {
    if (appMode === 'elevation') {
      if (openingDragRef.current) cancelOpeningDrag();
      openingDownRef.current = null;
      elevationDragRef.current = null;
      setIsPanning(false);
      return;
    }
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
    // 建具ドラッグ中にキャンバス外に出たらキャンセル（開始前へ戻す）
    if (openingDragRef.current) cancelOpeningDrag();
    openingDownRef.current = null;
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
    // 展開モードはズームが存在しない（固定倍率）。ピンチを封じる。
    if (appMode === 'elevation') { e.evt.preventDefault(); return; }
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
        if (tap.count === 2) onUndo();
        else if (tap.count === 3) onRedo();
      }
      touchTapRef.current = null;
    }
  };

  // ESC（App.jsx のキーボードハンドラ effect）からの呼び出し用: ドラッグ中意図の記録refをクリアする。
  // 元は App.jsx が siteDrawDownRef.current = null; stretchDownRef.current = null; を直接行っていたが、
  // 両refがこのフックへ移動したため、同じ2行をアクセサとして公開する（挙動は変えない）。
  function resetGestureRefs() {
    siteDrawDownRef.current = null;
    stretchDownRef.current = null;
    // 建具ドラッグ中の ESC は開始前へ戻す（CL移動の cancelMove と同じ扱い）
    if (openingDragRef.current) cancelOpeningDrag();
    openingDownRef.current = null;
  }

  // 直前の pointerUp が建具ドラッグの確定だったか。記号丸の Konva click は pointerUp の後に飛ぶため、
  // App.jsx の記号丸クリック（建具モードへの遷移）はこれを見て無視する（ドラッグのたびにモードが
  // 切り替わらないように）。次の pointerDown でリセットされる。
  function didOpeningDragEnd() { return openingDragEndedRef.current; }

  // ---- スナップ & 近傍CL/壁/開口 計算 ----
  // 候補解決は snap.js の resolvePointerTargets に一本化（App側は setState への反映のみ）。
  function updateSnap(clientX, clientY) {
    const r = resolvePointerTargets(graph, viewport, clientX, clientY, { width: size.width, height: size.height, appMode, columnAxisMode });
    setSnapPoint(r.snap);
    setNearCL(r.nearCL);
    setNearCLEndpoint(r.nearCLEndpoint);
    setNearWall(r.nearWall);
    setNearOpening(r.nearOpening);
    setCursorWorld(r.world);
    // ガター帯内（r.world===null）はカーソル座標を更新しない（従来どおり）
    if (r.world) setCursorScreen({ x: clientX, y: clientY });
  }

  return {
    handlers: {
      onWheel:       handleWheel,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp:   handlePointerUp,
      onPointerLeave: handlePointerLeave,
      onTouchStart:  handleTouchStart,
      onTouchMove:   handleTouchMove,
      onTouchEnd:    handleTouchEnd,
    },
    snapPoint, nearCL, nearWall, nearOpening,
    cursorWorld, cursorScreen, pressPos, isPanning,
    commitCLMove,
    setSnapPoint, setNearCL, setNearWall, setNearOpening, setCursorWorld,
    resetGestureRefs, didOpeningDragEnd,
  };
}
