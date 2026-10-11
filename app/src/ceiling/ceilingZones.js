/**
 * 天井区画の書込み（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 天伏パネルが「選んだセル群の天井高」を Room.ceilingZones へ書くときの、区画配列の組み立て。graph は変えない
 * （戻り値の配列をパネルが withFinishUndo の中で room.setCeilingZones に渡す。CeilingModeState も graph を変えない）。
 *
 * 書くときの正規化（.claude/ceiling-model.md「天井区画（S5）」）: 確定のたびにその部屋の全区画を ceilingRefreshCells で
 * 今の天井セルの分割（仕上げの分割＋天井芯。S8a）へ展開し直し、解けないキーを捨て、区画をまたいだ重複は先勝ちにし、空になった区画を消す。部屋の所属との交差は
 * 書くときは取らない（読む側 ceilingSurfaces.js が Z1 として取る）。
 * 階段所属のセル群への入力は S6b まで無効（パネルが disabled にする）。この関数群は部屋の区画だけを扱う。
 */
import { CeilingZone, CeilingShape } from '@core';
import { ceilingRefreshCells } from './ceilingGrid.js';
import { isEmptyCeilingZone, normalizeCeilingShape } from '../core/ceilingZone.js';

const isValidHeight = mm => typeof mm === 'number' && Number.isFinite(mm) && mm > 0;

/**
 * 部屋の全区画を今の分割へ展開し直した配列。解けないキー（CL 削除で消えた）は捨て、区画をまたいだ重複は先勝ち、空の区画は消す。
 * @returns {CeilingZone[]}
 */
export function normalizeZones(graph, room) {
  const claimed = new Set();
  const out = [];
  for (const zone of room?.ceilingZones ?? []) {
    const cells = [...ceilingRefreshCells(new Set(zone.cells), graph)].filter(k => !claimed.has(k));
    const next = zone.withCells(cells);
    if (isEmptyCeilingZone(next)) continue;
    for (const k of next.cells) claimed.add(k);
    out.push(next);
  }
  return out;
}

/** cellKeys を今の分割へ展開した集合（解けないキーは捨てる）。 */
function resolveKeys(graph, cellKeys) {
  return ceilingRefreshCells(new Set(cellKeys ?? []), graph);
}

/** 各区画から keys を差し引き、空になった区画を消す。 */
function subtractKeys(zones, keys) {
  return zones
    .map(z => z.withCells(z.cells.filter(k => !keys.has(k))))
    .filter(z => !isEmptyCeilingZone(z));
}

/**
 * 区画単位の書込み（S12b。ユーザー指定ごとに区画が1つ）。**同じ spec の区画へ統合しない**（旧 assignZoneShape は統合していた。S12c で削除）。
 * cellKeys を今の分割へ展開 → 正規化済みの全区画から差し引く（Z2: 他の区画からセルを奪う。空になった区画は消える）→ 新しい区画（uuid）を末尾に足す。
 * 部屋が null は { zones: [], zoneId: null }。解けるキーが無い・基準高が null でも正の有限数でもない・平面で基準高 null（指定なし）は、
 * 何も足さず正規化しただけの現在の区画配列と zoneId null。
 * @param {object} graph
 * @param {import('@core').Room|null} room
 * @param {Iterable<string>} cellKeys
 * @param {{heightMm: number|null, shape: string, dims: number[]}} spec
 * @returns {{zones: CeilingZone[], zoneId: string|null}}
 */
export function createZone(graph, room, cellKeys, { heightMm, shape, dims }) {
  if (!room) return { zones: [], zoneId: null };
  const zones = normalizeZones(graph, room);
  const keys = resolveKeys(graph, cellKeys);
  if (keys.size === 0 || (heightMm !== null && !isValidHeight(heightMm))) return { zones, zoneId: null };
  const spec = normalizeCeilingShape(shape, dims);
  if (heightMm === null && spec.shape === CeilingShape.FLAT) return { zones, zoneId: null };
  const next = subtractKeys(zones, keys);
  const zoneId = crypto.randomUUID();
  next.push(new CeilingZone({ id: zoneId, cells: [...keys], heightMm, shape: spec.shape, dims: spec.dims }));
  return { zones: next, zoneId };
}

/**
 * 区画 zoneId の形状・基準高・寸法だけを差し替えた後の、部屋の区画配列。id とセルは保ち、他の区画と統合しない。
 * 部屋 null は []。未知の zoneId・不正な基準高・平面で基準高 null（区画を空にする指定）は、正規化しただけの現在の区画配列（変更なし）。
 * @returns {CeilingZone[]}
 */
export function updateZoneSpec(graph, room, zoneId, { heightMm, shape, dims }) {
  if (!room) return [];
  const zones = normalizeZones(graph, room);
  if (!zones.some(z => z.id === zoneId) || (heightMm !== null && !isValidHeight(heightMm))) return zones;
  const spec = normalizeCeilingShape(shape, dims);
  if (heightMm === null && spec.shape === CeilingShape.FLAT) return zones;
  return zones.map(z => (z.id === zoneId ? new CeilingZone({ ...z.toData(), heightMm, shape: spec.shape, dims: spec.dims }) : z));
}

/** 区画 zoneId を消した後の、部屋の区画配列（セルは部屋の残りへ戻る）。部屋 null は []。未知の zoneId は変更なし。 */
export function removeZone(graph, room, zoneId) {
  if (!room) return [];
  return normalizeZones(graph, room).filter(z => z.id !== zoneId);
}
