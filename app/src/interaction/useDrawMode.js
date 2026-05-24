import { useState, useRef } from 'react';
import { CenterLineType } from '@core';

export function useDrawMode(graph) {
  const [drawState, setDrawState] = useState(null);
  const drawStateRef = useRef(null);

  function _set(state) {
    drawStateRef.current = state;
    setDrawState(state);
  }

  function startDraw(itemId, snap, worldPos) {
    switch (itemId) {
      case 'cl-v':
        graph.addCenterLine(CenterLineType.VERTICAL, worldPos.x);
        return;
      case 'cl-h':
        graph.addCenterLine(CenterLineType.HORIZONTAL, worldPos.y);
        return;
      case 'del':
        if (snap) graph.getShapesAtNode(snap).forEach(s => graph.removeShape(s.id));
        return;
      case 'diag':
        _set({ mode: itemId, startSnap: snap, startWorld: worldPos });
        return;
      default:
        return;
    }
  }

  function completeDraw(snap, worldPos) {
    const state = drawStateRef.current;
    if (!state) return null;
    const { mode, startSnap } = state;

    let result = null;
    try {
      if (mode === 'diag' && startSnap && snap) {
        result = graph.addDiagonalLine(startSnap, snap);
      }
    } catch (e) {
      console.error('Draw error:', e);
    }
    _set(null);
    return result;
  }

  function cancelDraw() { _set(null); }

  return {
    drawState,
    drawStateRef,
    isDrawing: drawState !== null,
    startDraw,
    completeDraw,
    cancelDraw,
  };
}
