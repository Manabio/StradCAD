// ポインタ/タッチ/長押しのジェスチャー配線（App.jsx Step5リファクタで抽出）。
// このフックは mode-system.md の言う「App.jsx 側の ref/state」に含まれる。
// modes/ の MobX クラスへ移さないこと（モード間で共有しないジェスチャー用一時状態のため）。
//
// 「ジェスチャー判別とディスパッチ」だけを持つ。graph 変更＋undo push は既に抽出済みの
// ドメインモジュール（transform/centerLineOps.js 等）呼び出しのまま（描画完成時の
// addDiagonalLine undo 等、数行の例外はそのまま持つ）。
import { useRef, useState } from 'react';
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
import { roundAbsToStep } from '../renderer/clMoveMath.js';
import { inGutter as isInGutter } from '../layout.js';
import { commitCLMoveOp, commitStretchWithUndo } from '../transform/centerLineOps.js';
import { commitSiteTapLine } from '../transform/siteEdit.js';
import { canExtendCenterLine, canShortenCenterLine } from '../transform/centerLineExtend.js';
import { isLastGridOnAxis } from '../transform/centerLineConvert.js';
import { interiorWallSpans } from '../finish/edgeClassify.js';
import { isEligibleWallSpan } from '../finish/kneeDropWall.js';

// project, graph, size, appMode, columnAxisMode, modeRef, menu, setMenu, onToast, onUndo, onRedo
// は毎レンダー App.jsx から渡す（useCallback/useMemo で固定しない——modeRef.current・graph の
// 鮮度が「毎レンダー再生成」前提に依存する）。
export function usePointerInteraction({
  project, graph, size, appMode, columnAxisMode, modeRef,
  menu, setMenu, onToast, onUndo, onRedo,
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
    // 展開モードはズームが存在しない（固定倍率）。viewport.zoomAtを封じる。
    if (appMode === 'elevation') { e.evt.preventDefault(); return; }
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

    // ---- 展開モード ----
    if (appMode === 'elevation') {
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
    // 交点スナップ中なら押下位置を記録（移動閾値超えでストレッチへ）
    if (snapRef.current) stretchDownRef.current = { clientX, clientY, snap: snapRef.current };
    longPress.begin(clientX, clientY);
  };

  // ---- ポインタ Move ----
  const handlePointerMove = (e) => {
    const { clientX, clientY } = e.evt;
    if (menu) return;

    // ---- 展開モード ----
    if (appMode === 'elevation') {
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
    if (toast) onToast(toast);
    modeRef.current?.commitMove();
  }

  // ---- ポインタ Up ----
  const handlePointerUp = (e) => {
    // ---- 展開モード ----
    if (appMode === 'elevation') {
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

  // ---- ポインタ Leave (外アップ扱い) ----
  const handlePointerLeave = () => {
    if (appMode === 'elevation') {
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
  }

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
    resetGestureRefs,
  };
}
