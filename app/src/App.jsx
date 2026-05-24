import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { runInAction } from 'mobx';
import { undoManager } from './undoManager.js';
import { serializeGraph, restoreGraph } from './graphSnapshot.js';
import { Stage, Layer, Group } from 'react-konva';
import { useStore } from './store.js';
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
} from './renderer/CenterLinesLayer.jsx';
import { ShapesLayer }    from './renderer/ShapesLayer.jsx';
import { SnapIndicator }  from './renderer/SnapIndicator.jsx';
import { LongPressIndicator } from './renderer/LongPressIndicator.jsx';
import { DrawPreview }    from './renderer/DrawPreview.jsx';
import { CLAddPreview }   from './renderer/CLAddPreview.jsx';
import { CLMoveInput }    from './renderer/CLMoveInput.jsx';
import { RadialMenu }     from './ui/RadialMenu.jsx';
import { AddCLDialog }    from './ui/AddCLDialog.jsx';
import { WallDialog }     from './ui/WallDialog.jsx';

const SNAP_THRESHOLD_PX = 20;
const CL_THRESHOLD_PX   = 8;

const viewport = new Viewport(window.innerWidth, window.innerHeight);

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

  const drag         = useRef(null);
  const pinch        = useRef(null);
  const snapRef      = useRef(null);
  const nearCLRef    = useRef(null);
  const drawDownRef  = useRef(null);
  const moveDownRef  = useRef(null); // CL移動: pointer-down 記録用
  const cancelDrawRef = useRef(null);
  const cancelMoveRef = useRef(null);

  const graph = project.activeGraph;

  const { drawState, drawStateRef, isDrawing, startDraw, completeDraw, cancelDraw } = useDrawMode(graph);
  const { moveState, moveStateRef, isMoving, startMove, updateMove, commitMove, cancelMove } = useCLMove();

  cancelDrawRef.current = cancelDraw;
  cancelMoveRef.current = cancelMove;

  useEffect(() => { snapRef.current  = snapPoint; }, [snapPoint]);
  useEffect(() => { nearCLRef.current = nearCL;   }, [nearCL]);

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
    if (e.evt.touches) return;
    if (menu) return;
    if (moveStateRef.current) {
      moveDownRef.current = { x: e.evt.clientX, y: e.evt.clientY };
      return;
    }
    if (drawStateRef.current) {
      drawDownRef.current = { x: e.evt.clientX, y: e.evt.clientY };
      return;
    }
    longPress.begin(e.evt.clientX, e.evt.clientY);
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

    // ---- CL 移動モード ----
    if (moveStateRef.current) {
      const world = viewport.screenToWorld(clientX, clientY);
      const cl    = moveStateRef.current.cl;
      const isV   = cl.centerLineType === 'X';
      const snapVal = findCLMoveSnap(graph, cl, world.x, world.y, SNAP_THRESHOLD_PX, viewport.scale);
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
    // CL移動: pointer-down があれば確定
    if (moveStateRef.current && moveDownRef.current) {
      const { cl, originalValue } = moveStateRef.current;
      const newValue = cl.value;
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

  // ---- スナップ & 近傍CL 計算 ----
  function updateSnap(clientX, clientY) {
    const world = viewport.screenToWorld(clientX, clientY);
    const snap  = findNearestIntersection(graph, world.x, world.y, SNAP_THRESHOLD_PX, viewport.scale);
    // 交点スナップ中は CL 検出不要
    const cl    = snap ? null : findNearestCenterLine(graph, world.x, world.y, CL_THRESHOLD_PX, viewport.scale);
    setSnapPoint(snap ?? null);
    setNearCL(cl ?? null);
    setCursorWorld(world);
    setCursorScreen({ x: clientX, y: clientY });
  }

  // ---- メニュー選択 ----
  function handleMenuSelect(item) {
    if (item.id === 'cl-v')    { setClDialog({ type: 'vertical',   worldCoord: menu.worldPos.x }); return; }
    if (item.id === 'cl-h')    { setClDialog({ type: 'horizontal', worldCoord: menu.worldPos.y }); return; }
    if (item.id === 'wall')    { setWallDialog({ worldPos: menu.worldPos }); return; }
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
    undoManager.push(
      () => graph.removeShape(w.id),
      () => graph.addWall(refCL, axisOffset, isRefV, clA, 0, clB, 0),
    );
    setWallDialog(null);
  }

  function handleCLDialogConfirm(value, kind, trim) {
    if (!clDialog) return;
    const clType = clDialog.type === 'vertical' ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const props = {
      ...(kind === 'struct' ? { discipline: Discipline.STRUCT } : {}),
      ...(kind === 'aux'    ? { labeled: false, lineType: 'dashed' } : {}),
      trim: !!trim,
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
            <Group
              x={viewport.offsetX}
              y={viewport.offsetY}
              scaleX={viewport.scale}
              scaleY={viewport.scale}
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
          </Layer>

          <Layer name="overlay">
            <CenterLineLabels
              graph={graph}
              viewport={viewport}
              width={size.width}
              height={size.height}
            />
            {!menu && <SnapIndicator snap={snapPoint} viewport={viewport} />}
          </Layer>

          <Layer name="ui" />
        </Stage>
      </div>

      <div style={{
        position: 'fixed', bottom: 12, right: 16,
        fontSize: 12, color: '#666', pointerEvents: 'none', userSelect: 'none',
      }}>
        1/{viewport.scaleDenominator}
      </div>
    </>
  );
});

export default App;
