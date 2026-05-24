import { useState, useRef } from 'react';
import { runInAction } from 'mobx';

export function useCLMove() {
  const [moveState, setMoveState] = useState(null); // { cl, originalValue } | null
  const moveStateRef = useRef(null);

  function _set(s) { moveStateRef.current = s; setMoveState(s); }

  function startMove(cl) {
    _set({ cl, originalValue: cl.value });
  }

  function updateMove(newValue) {
    if (!moveStateRef.current) return;
    runInAction(() => { moveStateRef.current.cl.value = newValue; });
  }

  function commitMove() { _set(null); }

  function cancelMove() {
    if (moveStateRef.current) {
      runInAction(() => { moveStateRef.current.cl.value = moveStateRef.current.originalValue; });
    }
    _set(null);
  }

  return {
    moveState,
    moveStateRef,
    isMoving: moveState !== null,
    startMove,
    updateMove,
    commitMove,
    cancelMove,
  };
}
