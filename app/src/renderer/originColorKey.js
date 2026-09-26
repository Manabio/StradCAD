/**
 * 図形（CL・梁芯・柱）の「由来」から canvasStyle.js の色キーへ変換する純モジュール。
 *
 * import ゼロに近い規約（extractedModuleImportInvariant）: ../core/centerLine.js・
 * ../core/constants.js など core/ 配下だけに依存する。store.js/snap.js/.jsx/react-konva/mobx
 * ストアは静的 import しない——node:test から本ファイルを単体 import 可能に保つため。
 *
 * ステップ1（本ファイル）は CenterLine 用の centerLineOriginColorKey のみ。将来ステップ3で
 * 柱の由来キーを返す columnOriginColorKey をここへ同居させる予定（柱の×表も同じ由来色を使うため）。
 */
import { centerLineKind, BeamAxisOrigin } from '../core/centerLine.js';

/**
 * CenterLine の由来色キー（canvasStyle.js の ORIGIN_HUES のキー）を返す。
 * centerLineKind(cl) の4種別を由来キーへ写像する:
 *   'struct' → 'grid'（通り芯由来）
 *   'center' → 'center'（中心線由来）
 *   'aux'    → 'aux'（補助・手動）
 *   'beam'   → cl.beamAxisOrigin（ステップ2で新設した由来フィールド）で分岐する:
 *              wall/floorBeam（壁・床梁割付けからの自動生成）→ 'generated'
 *              center（中心線由来。S造向け・未実装。色キーのみ予約）→ 'center'
 *              user（AddCLDialogから追加）→ 'aux'
 *              null（既存データ・不明）→ 'none'
 * @param {import('../core/centerLine.js').CenterLine} cl
 * @returns {'grid'|'center'|'aux'|'generated'|'none'}
 */
export function centerLineOriginColorKey(cl) {
  const kind = centerLineKind(cl);
  if (kind === 'struct') return 'grid';
  if (kind === 'beam') {
    switch (cl.beamAxisOrigin) {
      case BeamAxisOrigin.WALL:
      case BeamAxisOrigin.FLOOR_BEAM: return 'generated';
      case BeamAxisOrigin.CENTER:     return 'center';
      case BeamAxisOrigin.USER:       return 'aux';
      default:                        return 'none';
    }
  }
  return kind; // 'center' | 'aux'
}
