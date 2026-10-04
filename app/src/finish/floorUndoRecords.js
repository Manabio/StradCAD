/**
 * 全階連動の操作（昇降機の設置・削除・用途変更＝finish/equipment/equipmentFloorSync.js、階段の削除＝
 * finish/stair/stairFloorSync.js）が共有する「他階を before へ巻き戻す／undo エントリへ合成する」手順。
 * equipmentFloorSync.js にあったものを中身を変えずに移した（3つ目の複製を作らないため）。
 *
 * 巻き戻し（rollbackSavedFloors）は transform/centerLineFloorSync.js の rollbackFloorRecords と
 * 同じ規則（1件の失敗でも残りの巻き戻しを続ける）のローカル関数——finish/ から transform/ を
 * import しない（層をまたぐ依存を作らない方針）。ただし本経路は最初の例外を記録し、全件試行後に
 * 再スローする（呼び出し側が識別コード付きで包み直して再スローするため）。
 */
import { restoreGraph } from '../graphSnapshot.js';
import { undoManager } from '../undoManager.js';

// rollbackFloorRecords（transform/centerLineFloorSync.js）と同じ規則: アクティブ階なら
// restoreGraph、そうでなければ saveFloorFn。1件の失敗でも残りの巻き戻しを続ける——ただしこちらは
// 最初の例外を記録し、全件試行後に再スローする（呼び出し側が識別コード付きで包み直す）。
export async function rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn) {
  let firstError = null;
  for (const planeId of savedPlaneIds) {
    const before = beforeBytesByPlane.get(planeId);
    try {
      if (project.activePlane?.id === planeId) {
        restoreGraph(project.activeGraph, before);
      } else {
        await saveFloorFn(planeId, before);
      }
    } catch (err) {
      console.error(err);
      if (!firstError) firstError = err;
    }
  }
  if (firstError) throw firstError;
}

// applyFloorUndoRecords（transform/centerLineFloorSync.js）と同じ規則のローカル関数
// （undoManager.amend のundo/redoコールバックから呼ぶ。同期関数——saveFloorFnは待たない
// ＝stairFloorSync.js applyBytesと同じ「非アクティブ階はfire-and-forget」規約）。
export function applyRecords(project, records, which, saveFloorFn) {
  const ordered = which === 'before' ? [...records].reverse() : records;
  for (const rec of ordered) {
    if (project.activePlane?.id === rec.planeId) {
      restoreGraph(project.activeGraph, rec[which]);
    } else {
      saveFloorFn(rec.planeId, rec[which]).catch(console.error);
    }
  }
}

// 上階への書込みが無い経路（延長・Q5）でも、undo/redo の後に project.equipmentIndex・記号の
// 再読込みが要る（QA指摘M2）ため、記録は増やさず「何もしない＋onApplied を呼ぶ」だけを
// entry へ合成する（undoManager.amend と同じ合成規則。base の undo/redo の前後どちらに
// 副作用を足すかは undoManager.amend 自体が決める——ここでは意味を持たないため気にしない）。
export function amendOnAppliedOnly(entry, onApplied) {
  undoManager.amend(entry, () => onApplied?.(), () => onApplied?.());
}
