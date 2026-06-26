import { memberSymbol } from './memberCatalog.js';

// 部材タグ番号の採番ルール（Phase 1）:
// タグ番号は「荷重バンド」を形状の近似プロキシとして決定的に与える。
//   tag = 記号 + (band + 1)   （band0=最下層帯 → 必ず C1 / G1 ...）
//
// 番号が band だけから決まることで、過去の「登録順（=最初に開いた階）で番号が決まる」採番が
// もたらしていた不具合——上階を先に開くと最下階の柱が C2 になり C1 がその階に出ない——を根治する。
// また band を階数 n に依存しない rank ベースにすることで、上階を増減しても下階のタグが動かない。
//
// project.structuralTagRegistry（registryKey → タグ）は建物全体の台帳として「同一形状＝同一タグ」を
// 記録するチャネル（次フェーズの実断面採番・点検用）。Phase 1 では番号自体が band から決まるため
// 採番の判定には使わず、記録のみ行う。
//
// 手動編集したタグは entity.memberNoLocked=true で保持する（ロック中は上書きしない）。それ以外は
// 決定的な上書きのため、誤った既存タグも構造モード再訪時に自動修復される。
//
// Phase 1 の制限: 同一バンド内で材料が異なる柱・梁は同じ番号に丸められる（実断面マスター実装時に解消）。

const NUMBERED_MAPS = ['columnMap', 'beamMap', 'wallMap', 'slabMap', 'footingMap'];

// 何階ぶんを1バンド（=同一形状の近似）にまとめるか。1=各階を独立した種類として扱う。
// 階数に依存しない固定値にすることで、上階の増減で下階のバンド（=タグ）が変化しないことを保証する。
const FLOORS_PER_BAND = 1;

/** plane の荷重バンド番号(0=最下層)。建物全体（project.planes、elevation昇順）の中での順位(rank)だけで決まり、
 *  階数 n には依存しない（上階を足しても既存階の rank は不変＝タグが動かない）。
 *  屋根専用平面（project.planes に含まれない）は最上の実体平面と同じ最上バンドに乗せる。 */
export function bandIndexForPlane(plane, project) {
  const planes = project.planes;
  const n = planes.length;
  if (plane.isRoofPlane) return n === 0 ? 0 : Math.floor((n - 1) / FLOORS_PER_BAND);
  const rank = planes.findIndex(p => p.id === plane.id); // 0=最下階
  if (rank < 0) return 0;
  return Math.floor(rank / FLOORS_PER_BAND);
}

// Phase 1 の形状キー（材料 + 荷重バンド）。台帳の記録キーに使う。
function shapeKey(entity, plane, project) {
  const band = bandIndexForPlane(plane, project);
  return `${entity.materialType}:band${band}`;
}

/**
 * graph[mapName] の各部材に、荷重バンドから決まる決定的なタグ（記号 + band + 1）を割り当てる。
 * 番号は band から純粋に決まるため、開いた順序や階数に依存せず安定する（既存の誤ったタグも上書きで修正される）。
 * recordRegistry=false のときは台帳（共有・永続）に書き込まない——非アクティブ階の読み取り専用peekを
 * 表示用に採番する場合に使う（共有状態を汚さない）。
 */
export function renumberMembers(graph, project, mapName, recordRegistry = true) {
  const band = bandIndexForPlane(graph.plane, project);
  for (const entity of graph[mapName].values()) {
    if (entity.memberNoLocked) continue; // 手動編集でロックされたタグは保持する
    const symbol = memberSymbol(entity, mapName);
    const tag = `${symbol}${band + 1}`;
    entity.setMemberNo(tag);
    if (recordRegistry) {
      project.setTagRegistryEntry(`${symbol}:${shapeKey(entity, graph.plane, project)}`, tag);
    }
  }
}

/** 構造モード突入時・部材の新規追加時に呼ぶ統合エントリポイント（全分類を採番）。 */
export function renumberAllCategories(graph, project, recordRegistry = true) {
  for (const mapName of NUMBERED_MAPS) renumberMembers(graph, project, mapName, recordRegistry);
}
