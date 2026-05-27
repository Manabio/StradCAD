import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { runInAction } from 'mobx';
import { undoManager } from './undoManager.js';
import { serializeGraph, restoreGraph } from './graphSnapshot.js';
import { Stage, Layer, Group } from 'react-konva';
import { useStore } from './store.js';
import { ERR_CL_DUPLICATE, ERR_CL_CENTER_UPGRADED, ERR_CL_STRUCT_EXISTS } from './error.js';
import { Viewport } from './viewport.js';
import {
  findNearestIntersection,
  findNearestCenterLine,
  findCLMoveSnap,
  findBracketingCLs,
} from './snap.js';
import { useLongPress }  from './interaction/useLongPress.js';
import { useDrawMode }   from './interaction/useDrawMode.js';
import { useCLMove }     from './interaction/useCLMove.js';
import { detectContext, getMenuItems } from './interaction/menuItems.js';
import { CenterLineType, Discipline } from '@core';
import {
  CenterLinesLayer,
  IntersectionMarkers,
  CenterLineLabels,
  GutterCLMarkers,
} from './renderer/CenterLinesLayer.jsx';
import { AxisRulerLayer } from './renderer/AxisRulerLayer.jsx';
import { ShapesLayer }    from './renderer/ShapesLayer.jsx';
import { SnapIndicator }  from './renderer/SnapIndicator.jsx';
import { LongPressIndicator } from './renderer/LongPressIndicator.jsx';
import { DrawPreview }    from './renderer/DrawPreview.jsx';
import { CLAddPreview }   from './renderer/CLAddPreview.jsx';
import { CLMoveInput }    from './renderer/CLMoveInput.jsx';
import { RadialMenu }     from './ui/RadialMenu.jsx';
import { AddCLDialog }    from './ui/AddCLDialog.jsx';
import { WallDialog }          from './ui/WallDialog.jsx';
import { WallRefIndicator }   from './renderer/WallRefIndicator.jsx';
import { CalibrationDialog }  from './ui/CalibrationDialog.jsx';

const SNAP_THRESHOLD_PX = 20;
const CL_THRESHOLD_PX   = 8;
const GUTTER            = 48; // 通り芯表示エリアの幅 (px)

const viewport = new Viewport(window.innerWidth, window.innerHeight, GUTTER, GUTTER);

const App = observer(() => {
  const project = useStore();
  const [size,        setSize]        = useState({ width: window.innerWidth, height: window.innerHeight });
  const [snapPoint,   setSnapPoint]   = useState(null);
  const [pressPos,    setPressPos]    = useState(null);
  const [menu,        setMenu]        = useState(null); // { pos, items, snap, worldPos, cl }
  const [cursorWorld, setCursorWorld] = useState(null);
  const [cursorScreen,setCursorScreen]= useState({ x: 0, y: 0 });
  const [nearCL,      setNearCL]      = useState(null);
  const [clDialog,    setClDialog]    = useState(null); // { type, worldCoord }
  const [clPreview,   setClPreview]   = useState(null);
  const [wallDialog,  setWallDialog]  = useState(null); // { worldPos }
  const [isPanning,   setIsPanning]   = useState(false);
  const [scaleInput,      setScaleInput]      = useState(null); // null=非編集, string=編集中
  const [showCalibration, setShowCalibration] = useState(false);
  const [toast,           setToast]           = useState(null); // { msg, key }

  const drag          = useRef(null);
  const pinch         = useRef(null);
  const snapRef       = useRef(null);
  const nearCLRef     = useRef(null);
  const drawDownRef   = useRef(null);
  const moveDownRef   = useRef(null); // CL移動: pointer-down 記録用
  const cancelDrawRef = useRef(null);
  const cancelMoveRef = useRef(null);
  const gutterCLRef   = useRef(null); // ガター長押し中のCL

  const graph = project.activeGraph;

  const { drawState, drawStateRef, isDrawing, startDraw, completeDraw, cancelDraw } = useDrawMode(graph);
  const { moveState, moveStateRef, isMoving, startMove, updateMove, commitMove, cancelMove } = useCLMove();

  cancelDrawRef.current = cancelDraw;
  cancelMoveRef.current = cancelMove;

  useEffect(() => { snapRef.current  = snapPoint; }, [snapPoint]);
  useEffect(() => { nearCLRef.current = nearCL;   }, [nearCL]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- ガター通り芯 長押しフック ----
  const gutterLongPress = useLongPress({
    onStart:  (sx, sy) => setPressPos({ x: sx, y: sy }),
    onFire:   (sx, sy) => {
      setPressPos(null);
      const cl = gutterCLRef.current;
      if (cl) startMove(cl);
      gutterCLRef.current = null;
    },
    onCancel: () => setPressPos(null),
  });

  // ---- 長押しフック ----
  const longPress = useLongPress({
    onStart:  (sx, sy) => setPressPos({ x: sx, y: sy }),
    onFire:   (sx, sy) => {
      setPressPos(null);
      const snap    = snapRef.current;
      const cl      = nearCLRef.current;
      const context = detectContext(snap, cl);
      const items   = getMenuItems(context, cl);
      setMenu({ pos: { x: sx, y: sy }, items, snap, worldPos: viewport.screenToWorld(sx, sy), cl });
    },
    onCancel: () => setPressPos(null),
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
      cancelDrawRef.current?.();
      cancelMoveRef.current?.();
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
    if (moveStateRef.current) {
      moveDownRef.current = { x: clientX, y: clientY };
      return;
    }
    if (drawStateRef.current) {
      drawDownRef.current = { x: clientX, y: clientY };
      return;
    }
    const inGutter = clientX < GUTTER || clientY < GUTTER ||
                     clientX > size.width - GUTTER || clientY > size.height - GUTTER;
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
    longPress.begin(clientX, clientY);
  };

  // ---- ポインタ Move ----
  const handlePointerMove = (e) => {
    const { clientX, clientY } = e.evt;
    if (menu) return;

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

    // ---- CL 移動モード ----
    if (moveStateRef.current) {
      const world = viewport.screenToWorld(clientX, clientY);
      const cl    = moveStateRef.current.cl;
      const isV   = cl.centerLineType === 'X';
      const snapVal = findCLMoveSnap(graph, cl, world.x, world.y, SNAP_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
      const newVal  = snapVal ?? (isV ? world.x : world.y);
      updateMove(newVal);
      setCursorWorld(world);
      setCursorScreen({ x: clientX, y: clientY });
      // スナップインジケータ: 他CLにスナップ中は表示
      setSnapPoint(snapVal != null
        ? { x: isV ? newVal : world.x, y: isV ? world.y : newVal }
        : null
      );
      return;
    }

    // ---- 描画モード ----
    if (drawStateRef.current) {
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
    const shouldPan = longPress.move(clientX, clientY);
    if (shouldPan) {
      drag.current = { lastX: clientX, lastY: clientY };
      setIsPanning(true);
      return;
    }
    updateSnap(clientX, clientY);
  };

  // ---- ポインタ Up ----
  const handlePointerUp = (e) => {
    if (moveStateRef.current) {
      const { cl, originalValue } = moveStateRef.current;
      const newValue = cl.value;
      // CL が実際に動いた か、明示的な再プレスがあった場合のみ確定
      if (moveDownRef.current || newValue !== originalValue) {
        if (newValue !== originalValue) {
          undoManager.push(
            () => runInAction(() => { cl.value = originalValue; }),
            () => runInAction(() => { cl.value = newValue; }),
          );
        }
        moveDownRef.current = null;
        commitMove();
        drag.current = null;
        return;
      }
      // 長押し直後の離し（移動なし）→ 移動モードを維持
      moveDownRef.current = null;
      return;
    }
    moveDownRef.current = null;

    // 描画モード: タップで完成
    if (drawStateRef.current && !drag.current && drawDownRef.current) {
      const snap  = snapRef.current;
      const world = viewport.screenToWorld(e.evt.clientX, e.evt.clientY);
      const shape = completeDraw(snap, world);
      if (shape) {
        undoManager.push(
          () => graph.removeShape(shape.id),
          () => graph.addDiagonalLine(shape.nodeA, shape.nodeB),
        );
      }
    }
    drawDownRef.current = null;
    longPress.abort();
    gutterLongPress.abort();
    gutterCLRef.current = null;
    drag.current = null;
    setIsPanning(false);
  };

  // ---- ポインタ Leave (外アップ扱い) ----
  const handlePointerLeave = () => {
    // CL移動中にキャンバス外に出たらキャンセル
    if (moveStateRef.current) {
      moveDownRef.current = null;
      cancelMove();
      drag.current = null;
      setSnapPoint(null);
      setCursorWorld(null);
      return;
    }
    drawDownRef.current = null;
    longPress.abort();
    gutterLongPress.abort();
    gutterCLRef.current = null;
    drag.current = null;
    setIsPanning(false);
    setSnapPoint(null);
    setNearCL(null);
    setCursorWorld(null);
  };

  // ---- タッチ: ピンチズーム ----
  const handleTouchMove = (e) => {
    e.evt.preventDefault();
    const touches = e.evt.touches;
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
  };

  // ---- ガター内の通り芯ヒット判定 ----
  function findGutterCL(sx, sy) {
    const HIT = 24; // px
    const cls = graph.centerLines.filter(cl => cl.labeled);
    if (sy < GUTTER || sy > size.height - GUTTER) {
      for (const cl of cls) {
        if (cl.centerLineType !== CenterLineType.VERTICAL) continue;
        if (Math.abs(cl.value * viewport.scaleX + viewport.offsetX - sx) < HIT) return cl;
      }
    }
    if (sx < GUTTER || sx > size.width - GUTTER) {
      for (const cl of cls) {
        if (cl.centerLineType !== CenterLineType.HORIZONTAL) continue;
        if (Math.abs(cl.value * viewport.scaleY + viewport.offsetY - sy) < HIT) return cl;
      }
    }
    return null;
  }

  // ---- スナップ & 近傍CL 計算 ----
  function updateSnap(clientX, clientY) {
    // 通り芯表示エリア内はスナップ・カーソル更新しない
    if (clientX < GUTTER || clientY < GUTTER ||
        clientX > size.width - GUTTER || clientY > size.height - GUTTER) {
      setSnapPoint(null);
      setNearCL(null);
      setCursorWorld(null);
      return;
    }
    const world = viewport.screenToWorld(clientX, clientY);
    const snap  = findNearestIntersection(graph, world.x, world.y, SNAP_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
    // 交点スナップ中は CL 検出不要
    const cl    = snap ? null : findNearestCenterLine(graph, world.x, world.y, CL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
    setSnapPoint(snap ?? null);
    setNearCL(cl ?? null);
    setCursorWorld(world);
    setCursorScreen({ x: clientX, y: clientY });
  }

  // ---- メニュー選択 ----
  function handleMenuSelect(item) {
    if (item.id === 'cl-v')    { setClDialog({ type: 'vertical',   worldCoord: menu.worldPos.x, perpCoord: menu.worldPos.y }); return; }
    if (item.id === 'cl-h')    { setClDialog({ type: 'horizontal', worldCoord: menu.worldPos.y, perpCoord: menu.worldPos.x }); return; }
    if (item.id === 'wall') {
      const pos   = menu.worldPos;
      const txW   = (SNAP_THRESHOLD_PX * 2) / viewport.scaleX;
      const tyW   = (SNAP_THRESHOLD_PX * 2) / viewport.scaleY;
      const nearbyCLs = graph.centerLines
        .filter(cl => {
          if (cl.labeled) return false;
          const dist = cl.centerLineType === CenterLineType.VERTICAL
            ? Math.abs(pos.x - cl.value)
            : Math.abs(pos.y - cl.value);
          return dist <= (cl.centerLineType === CenterLineType.VERTICAL ? txW : tyW);
        })
        .sort((a, b) => {
          const da = a.centerLineType === CenterLineType.VERTICAL ? Math.abs(pos.x - a.value) : Math.abs(pos.y - a.value);
          const db = b.centerLineType === CenterLineType.VERTICAL ? Math.abs(pos.x - b.value) : Math.abs(pos.y - b.value);
          return da - db;
        });
      setWallDialog({ worldPos: pos, nearbyCLs });
      return;
    }
    if (item.id === 'undo')    { undoManager.undo(); return; }
    if (item.id === 'redo')    { undoManager.redo(); return; }
    if (item.id === 'cl-move') { startMove(menu.cl); return; }
    if (item.id === 'cl-del')  {
      const before = serializeGraph(graph);
      graph.removeCenterLine(menu.cl.id);
      const after = serializeGraph(graph);
      undoManager.push(
        () => restoreGraph(graph, before),
        () => restoreGraph(graph, after),
      );
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
    startDraw(item.id, menu?.snap, menu?.worldPos);
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

  function handleCLDialogConfirm(value, kind, trim, refId, refOffset) {
    if (!clDialog) return;
    const clType = clDialog.type === 'vertical' ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;

    // ---- 重複チェック ----
    const OVERLAP_TOL = 0.5; // mm
    const existing = graph.centerLines.find(
      cl => cl.centerLineType === clType && Math.abs(cl.value - value) < OVERLAP_TOL
    );
    if (existing) {
      const existingKind = existing.lineType === 'dashed' ? 'aux'
        : existing.discipline === Discipline.STRUCT ? 'struct'
        : 'center';

      if (kind === existingKind) {
        setToast({ msg: ERR_CL_DUPLICATE(kind), key: Date.now() });
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
        const structCL = graph.addCenterLine(clType, value, structProps);
        const structId = structCL.id;
        undoManager.push(
          () => {
            graph.removeCenterLine(structId);
            graph.addCenterLine(deletedType, deletedRawValue, deletedProps, deletedId);
          },
          () => {
            graph.removeCenterLine(deletedId);
            graph.addCenterLine(clType, value, structProps, structId);
          },
        );
        setClDialog(null);
        setClPreview(null);
        return;
      }

      if (kind === 'center' && existingKind === 'struct') {
        setToast({ msg: ERR_CL_STRUCT_EXISTS, key: Date.now() });
        return;
      }
    }

    // 中心線: 追加時点の全直交CLでブラケット判定し延伸範囲を確定（既存CLの長さは変えない）
    let extentProps = {};
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
      extentProps = {
        labeled:     false,
        extentLoRef: loCL ? { clId: loCL.id, offset: 0 } : null,
        extentHiRef: hiCL ? { clId: hiCL.id, offset: 0 } : null,
        // loCL/hiCL が見つからない場合のみ静的フォールバックを使う
        extentLo:    !loCL ? (perpCLs.length ? Math.min(...perpCLs.map(c => c.value)) : null) : null,
        extentHi:    !hiCL ? (perpCLs.length ? Math.max(...perpCLs.map(c => c.value)) : null) : null,
      };
    }
    const props = {
      ...extentProps,
      ...(kind === 'struct' ? { discipline: Discipline.STRUCT } : {}),
      ...(kind === 'aux'    ? { labeled: false, lineType: 'dashed' } : {}),
      trim: !!trim,
      ...(refId ? { refId, refOffset: refOffset ?? 0 } : {}),
    };
    const cl = graph.addCenterLine(clType, value, props);
    const clId = cl.id;
    undoManager.push(
      () => graph.removeCenterLine(clId),
      () => graph.addCenterLine(clType, value, props, clId),
    );
    setClDialog(null);
    setClPreview(null);
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

  const cursor = menu || clDialog ? 'default'
               : isPanning        ? 'grabbing'
               : isMoving         ? 'grab'
               : isDrawing        ? 'crosshair'
               : snapPoint        ? 'cell'
               : nearCL           ? 'pointer'
               : 'crosshair';

  return (
    <>
      <LongPressIndicator pos={pressPos} />

      <RadialMenu
        pos={menu?.pos ?? null}
        items={menu?.items ?? []}
        onSelect={handleMenuSelect}
        onClose={closeMenu}
      />

      {clDialog && (
        <AddCLDialog
          type={clDialog.type}
          worldCoord={clDialog.worldCoord}
          gridCLs={clDialog.type === 'vertical' ? graph.gridXs : graph.gridYs}
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
          onConfirm={handleWallConfirm}
          onCancel={() => setWallDialog(null)}
        />
      )}

      <CLMoveInput
        moveState={moveState}
        screenX={cursorScreen.x}
        screenY={cursorScreen.y}
        onUpdate={updateMove}
        onCommit={commitMove}
        onCancel={cancelMove}
        graph={graph}
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
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{ cursor }}
        >
          <Layer name="world">
            {/* 描画域を通り芯表示エリアの内側にクリップ */}
            <Group
              clipX={GUTTER}
              clipY={GUTTER}
              clipWidth={size.width  - 2 * GUTTER}
              clipHeight={size.height - 2 * GUTTER}
            >
              <Group
                x={viewport.offsetX}
                y={viewport.offsetY}
                scaleX={viewport.scaleX}
                scaleY={viewport.scaleY}
              >
                <CenterLinesLayer
                  graph={graph}
                  viewport={viewport}
                  width={size.width}
                  height={size.height}
                />
                <ShapesLayer graph={graph} viewport={viewport} />
                <IntersectionMarkers graph={graph} viewport={viewport} />
                <DrawPreview
                  drawState={drawState}
                  snapPoint={snapPoint}
                  cursorWorld={cursorWorld}
                />
                <CLAddPreview value={clPreview} type={clDialog?.type} />
              </Group>
            </Group>
          </Layer>

          <Layer name="overlay">
            <AxisRulerLayer width={size.width} height={size.height} gutter={GUTTER} />
            <GutterCLMarkers
              graph={graph}
              viewport={viewport}
              width={size.width}
              height={size.height}
              gutter={GUTTER}
            />
            <CenterLineLabels
              graph={graph}
              viewport={viewport}
              width={size.width}
              height={size.height}
              gutter={GUTTER}
            />
            {!menu && <SnapIndicator snap={snapPoint} viewport={viewport} />}
            {wallDialog && wallDialog.nearbyCLs?.length > 0 && (
              <WallRefIndicator
                nearbyCLs={wallDialog.nearbyCLs}
                worldPos={wallDialog.worldPos}
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
        {/* 校正ボタン */}
        <span
          onClick={() => setShowCalibration(true)}
          title="画面校正"
          style={{ fontSize: 13, color: '#94a3b8', cursor: 'pointer', userSelect: 'none', lineHeight: 1 }}
        >
          ⚙
        </span>

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
    </>
  );
});

export default App;
