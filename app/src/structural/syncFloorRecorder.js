/**
 * 構造同期（structuralSync.js）が1回の実行中に非アクティブ階へ書いたIDBバイトの前後を、
 * 起動元のCL操作エントリの `floorRecords` 配列（`transform/centerLineFloorSync.js` の
 * `applyFloorUndoRecords` が読む形＝`{planeId, before, after}` の配列）へ記録する純モジュール
 * （段階(g)・2026-09-26）。
 *
 * 葉モジュールに準じる（store.js/snap.js/.jsxを引かない。node:testから単体importできる）——
 * IDB読み書きの実体（loadBytes・下位save）は呼び出し側が注入する。
 *
 * 使い方（structural/structuralSync.js runLoop参照）:
 *   1. 実行前に `captureBefore(nonActivePlaneIds)` で各階の現在のIDBバイトを控える。
 *   2. `wrapSave(save)` で下位のsave関数（storeSave／saveFloor）を包み、structuralOrchestration.js の
 *      recompute へ渡す（saveVia経由の全保存——採番・屋根も自動的に拾う）。
 *   3. 実行完了後（成功・失敗いずれも）`records()` で「実際に変化した階」の配列を取り出し、
 *      起動元エントリの `floorRecords` へ追記する。
 *
 * 「beforeをセーブ時に遅延して読む」方式は採らない——captureBeforeの時点（実行開始前）で
 * 確定した値を使う。実行中に他者が書いた場合の扱いはASSUMED（既知の限界(6)。IDB順序）のまま。
 */
import { floorBytesEqual } from '../floorOps.js';

/**
 * @param {object} opts
 * @param {(planeId: string) => Promise<Uint8Array|null>} opts.loadBytes - 現在のIDBバイトを読む関数
 *   （null＝未保存）。
 * @param {string} [opts.excludePlaneId] - この階への保存は記録しない（起動時のアクティブ階。
 *   アクティブ階の構造変化はメモリ上のgraphの変更であり、起動元エントリのbefore/after
 *   スナップショットに既に写り込むため、二重に記録しない——裁定4「逆関数型エントリは自階の構造を
 *   記録しない」）。
 *   QA指摘m-4（2026-09-26）: 記録の正否を実際に決めているのは captureBefore の対象絞り込み
 *   （呼び出し側が渡す planeIds＝structuralSync.js の nonActivePlaneIds が既にアクティブ階を
 *   除いている）——records() は before を持たない階を出力しないため、captureBefore の対象外なら
 *   excludePlaneId の有無に関わらず記録されない。excludePlaneId は二重チェック（保険）で、
 *   目的は正しさではなく警告ノイズの抑止: recomputeForStructuralSync の'all'パスはアクティブ階
 *   自身も saveVia で保存する（`structuralOrchestration.js` の `saveVia(ctx, active.plane.id, ...)`）
 *   ため、wrapSave 側の除外が無いと毎回「captureBeforeしていないplaneIdへの保存」警告が
 *   誤って出る——records() の出力自体はexcludePlaneIdが無くても変わらない。
 * @returns {{ captureBefore: (planeIds: string[]) => Promise<void>,
 *   wrapSave: (save: (planeId: string, bytes: Uint8Array) => Promise<any>) =>
 *     (planeId: string, bytes: Uint8Array) => Promise<any>,
 *   records: () => Array<{planeId: string, before: Uint8Array, after: Uint8Array}> }}
 */
export function createSyncFloorRecorder({ loadBytes, excludePlaneId = null } = {}) {
  const before = new Map(); // planeId -> bytes|null（captureBefore時点）
  const after = new Map();  // planeId -> bytes（最後にwrapSaveで保存された内容）
  const warnedPlaneIds = new Set(); // 未captureのplaneIdへの警告は1回だけ（planeIdごと）

  async function captureBefore(planeIds) {
    await Promise.all(planeIds.map(async (planeId) => {
      if (planeId === excludePlaneId) return; // 除外階はcaptureしない（QA指摘m-4——呼び出し側の
      // planeIds絞り込み（nonActivePlaneIds）が既にアクティブ階を除いているため、通常は素通り。
      // ここでの除外は呼び出し側の絞り込みが漏れた場合の保険）。
      const bytes = await loadBytes(planeId);
      before.set(planeId, bytes);
    }));
  }

  function wrapSave(save) {
    return (planeId, bytes) => {
      // 除外階は記録せず素通し（保険。QA指摘m-4——正はcaptureBeforeの対象絞り込み。上記JSDoc参照。
      // これが無くてもrecords()の出力は変わらないが、'all'パスがアクティブ階自身もsaveViaで保存する
      // ため、無いと毎回「captureBeforeしていない」警告が誤って出る）。
      if (planeId === excludePlaneId) return save(planeId, bytes);
      if (!before.has(planeId)) {
        if (!warnedPlaneIds.has(planeId)) {
          warnedPlaneIds.add(planeId);
          console.warn(`[syncFloorRecorder] captureBeforeしていないplaneId(${planeId})への保存は記録しません。`);
        }
        return save(planeId, bytes);
      }
      // 下位のsaveを同期区間でそのまま呼ぶ（awaitを挟まない。StructuralResolveContext.saveAndNote が
      // 「saveが同期区間でnoteFloorWrite相当を呼ぶ」ことを前提にするのと同じ理由——このwrapSave自体は
      // その前提を壊さない、saveの呼び出しそのものに何も割り込ませない透過ラッパにする）。
      const p = save(planeId, bytes);
      return p.then((result) => {
        after.set(planeId, bytes);
        return result;
      });
    };
  }

  function records() {
    const out = [];
    for (const [planeId, beforeBytes] of before) {
      if (beforeBytes == null) continue; // beforeがnull（未保存階）は記録しない
      if (!after.has(planeId)) continue; // この実行で保存されなかった階は記録しない
      const afterBytes = after.get(planeId);
      if (floorBytesEqual(beforeBytes, afterBytes)) continue; // 変化なしは記録しない
      out.push({ planeId, before: beforeBytes, after: afterBytes });
    }
    return out;
  }

  return { captureBefore, wrapSave, records };
}
