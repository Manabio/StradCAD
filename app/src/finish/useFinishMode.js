import { useState, useRef } from 'react';
import { worldToCell, getCellsInRect } from './gridCells.js';

export function useFinishMode(graph) {
  const [dragState,      setDragState]      = useState(null);
  const [selectedRoomId, setSelectedRoomId] = useState(null);
  const [namingRoomId,   setNamingRoomId]   = useState(null);
  const dragRef = useRef(null);

  function _set(state) {
    dragRef.current = state;
    setDragState(state);
  }

  function startDrag(wx, wy) {
    const cell = worldToCell(wx, wy, graph);
    if (!cell) return;
    _set({ startCell: cell, currentCell: cell });
  }

  function updateDrag(wx, wy) {
    const state = dragRef.current;
    if (!state) return;
    const cell = worldToCell(wx, wy, graph);
    if (!cell) return;
    _set({ ...state, currentCell: cell });
  }

  function commitDrag() {
    const state = dragRef.current;
    if (!state) return;
    const { startCell, currentCell } = state;
    const xMin = Math.min(startCell.x1, currentCell.x1);
    const yMin = Math.min(startCell.y1, currentCell.y1);
    const xMax = Math.max(startCell.x2, currentCell.x2);
    const yMax = Math.max(startCell.y2, currentCell.y2);
    const cellList = getCellsInRect(xMin, yMin, xMax, yMax, graph);
    if (cellList.length === 0) { _set(null); return; }
    const cells = new Set(cellList.map(c => c.key));
    const room = graph.addRoom(cells);
    _set(null);
    setNamingRoomId(room.id);
    setSelectedRoomId(room.id);
  }

  function cancelDrag() { _set(null); }

  function selectRoom(roomId) { setSelectedRoomId(roomId); }

  function finishNaming(roomId, name) {
    const room = graph.roomMap.get(roomId);
    if (room) room.setName(name || '部屋');
    setNamingRoomId(null);
  }

  function cancelNaming(roomId) {
    graph.removeRoom(roomId);
    setNamingRoomId(null);
    setSelectedRoomId(null);
  }

  // ドラッグ中プレビュー（Konva 描画用）
  const previewCells = dragState ? (() => {
    const { startCell, currentCell } = dragState;
    const xMin = Math.min(startCell.x1, currentCell.x1);
    const yMin = Math.min(startCell.y1, currentCell.y1);
    const xMax = Math.max(startCell.x2, currentCell.x2);
    const yMax = Math.max(startCell.y2, currentCell.y2);
    return getCellsInRect(xMin, yMin, xMax, yMax, graph);
  })() : [];

  return {
    dragState,
    dragRef,
    isDragging: dragState !== null,
    startDrag,
    updateDrag,
    commitDrag,
    cancelDrag,
    selectedRoomId,
    selectRoom,
    namingRoomId,
    finishNaming,
    cancelNaming,
    previewCells,
  };
}
