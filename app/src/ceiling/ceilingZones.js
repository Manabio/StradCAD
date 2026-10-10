/**
 * 天井区画の書込み（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 天伏パネルが「選んだセル群の天井高」を Room.ceilingZones へ書くときの、区画配列の組み立て。graph は変えない
 * （戻り値の配列をパネルが withFinishUndo の中で room.setCeilingZones に渡す。CeilingModeState も graph を変えない）。
 *
 * 書くときの正規化（.claude/ceiling-model.md「天井区画（S5）」）: 確定のたびにその部屋の全区画を refreshCells で
 * 今の分割へ展開し直し、解けないキーを捨て、区画をまたいだ重複は先勝ちにし、空になった区画を消す。部屋の所属との交差は
 * 書くときは取らない（読む側 ceilingSurfaces.js が Z1 として取る）。
 * 階段所属のセル群への入力は S6（傾斜と同時）まで無効（パネルが disabled にする）。この関数群は部屋の区画だけを扱う。
 */
import { CeilingZone, CeilingShape } from '@core';
import { refreshCells } from '../finish/gridCells.js';
import { isEmptyCeilingZone } from '../core/ceilingZone.js';

const isValidHeight = mm => typeof mm === 'number' && Number.isFinite(mm) && mm > 0;

/**
 * 部屋の全区画を今の分割へ展開し直した配列。解けないキー（CL 削除で消えた）は捨て、区画をまたいだ重複は先勝ち、空の区画は消す。
 * @returns {CeilingZone[]}
 */
export function normalizeZones(graph, room) {
  const claimed = new Set();
  const out = [];
  for (const zone of room?.ceilingZones ?? []) {
    const cells = [...refreshCells(new Set(zone.cells), graph)].filter(k => !claimed.has(k));
    const next = zone.withCells(cells);
    if (isEmptyCeilingZone(next)) continue;
    for (const k of next.cells) claimed.add(k);
    out.push(next);
  }
  return out;
}

/** cellKeys を今の分割へ展開した集合（解けないキーは捨てる）。 */
function resolveKeys(graph, cellKeys) {
  return refreshCells(new Set(cellKeys ?? []), graph);
}

/** 各区画から keys を差し引き、空になった区画を消す。 */
function subtractKeys(zones, keys) {
  return zones
    .map(z => z.withCells(z.cells.filter(k => !keys.has(k))))
    .filter(z => !isEmptyCeilingZone(z));
}

/**
 * cellKeys に天井高 heightMm を指定した後の、部屋の区画配列。
 * 全区画から cellKeys を差し引く（Z2: 既存区画のセルは奪う）→ 空を消す → 平面（flat）で同じ高さの区画があればそこへ足し、
 * 無ければ新しい区画（uuid）を末尾に足す。部屋の CH と同じ高さでも区画として残す。
 * 部屋が null・cellKeys が空（解けるキーが無い）・heightMm が正の有限数でない場合は何も足さない
 * （部屋 null は []、他は正規化しただけの現在の区画配列）。
 * @param {object} graph
 * @param {import('@core').Room|null} room
 * @param {Iterable<string>} cellKeys
 * @param {number} heightMm  部屋の FL からの天井高
 * @returns {CeilingZone[]}
 */
export function assignZoneHeight(graph, room, cellKeys, heightMm) {
  if (!room) return [];
  const zones = normalizeZones(graph, room);
  const keys = resolveKeys(graph, cellKeys);
  if (keys.size === 0 || !isValidHeight(heightMm)) return zones;
  // 同じ高さの flat 区画は差し引く前に探す（全セルの再確定で区画が一度空になって id が変わるのを避ける）
  const target = zones.find(z => z.shape === CeilingShape.FLAT && z.dims.length === 0 && z.heightMm === heightMm);
  if (target) {
    return zones
      .map(z => (z === target ? z.withCells([...z.cells, ...keys]) : z.withCells(z.cells.filter(k => !keys.has(k)))))
      .filter(z => !isEmptyCeilingZone(z));
  }
  const rest = subtractKeys(zones, keys);
  rest.push(new CeilingZone({ id: crypto.randomUUID(), cells: [...keys], heightMm }));
  return rest;
}

/**
 * cellKeys を区画から外した後の、部屋の区画配列（区画の解除）。完全一致に限らず、区画のセルから差し引いて空を消す。
 * 部屋が null は []。
 * @returns {CeilingZone[]}
 */
export function clearZoneCells(graph, room, cellKeys) {
  if (!room) return [];
  return subtractKeys(normalizeZones(graph, room), resolveKeys(graph, cellKeys));
}

/**
 * cellKeys の区画の状態。'none'＝どのセルも区画に属さない（部屋の CH）／'uniform'＝全セルが同じ高さの区画（heightMm にその高さ）／
 * 'mixed'＝区画あり・なしが混在、または違う区画（高さ）にまたがる。解けないキーは数えない。部屋 null・セルなしは 'none'。
 * @returns {{state: 'none'|'uniform'|'mixed', heightMm: number|null}}
 */
export function zoneStateOfCells(graph, room, cellKeys) {
  const none = { state: 'none', heightMm: null };
  if (!room) return none;
  const zones = normalizeZones(graph, room);
  const zoneOf = new Map();
  for (const z of zones) for (const k of z.cells) zoneOf.set(k, z);
  const labels = new Set();
  let firstZone = null;
  for (const key of resolveKeys(graph, cellKeys)) {
    const z = zoneOf.get(key) ?? null;
    if (z && !firstZone) firstZone = z;
    labels.add(z ? (z.shape === CeilingShape.FLAT ? `h${z.heightMm}` : `z${z.id}`) : '-');
  }
  if (labels.size === 0 || (labels.size === 1 && labels.has('-'))) return none;
  if (labels.size === 1) return { state: 'uniform', heightMm: firstZone.heightMm };
  return { state: 'mixed', heightMm: null };
}
