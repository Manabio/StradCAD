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
    runInAction(() => {
      const cl = moveStateRef.current.cl;
      if (cl.refId) {
        // 参照ありの場合、refOffset を更新
        const refValue = cl._referencedCL?.value ?? cl._value;
        cl.refOffset = newValue - refValue;
      } else {
        // 参照なしの場合、_value を直接更新
        cl.value = newValue;
      }
    });
  }

  function commitMove() { _set(null); }

  function cancelMove() {
    if (moveStateRef.current) {
      runInAction(() => {
        const cl = moveStateRef.current.cl;
        if (cl.refId) {
          const refValue = cl._referencedCL?.value ?? cl._value;
          cl.refOffset = moveStateRef.current.originalValue - refValue;
        } else {
          cl.value = moveStateRef.current.originalValue;
        }
      });
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
