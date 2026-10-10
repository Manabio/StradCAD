/**
 * 天伏パネルの行の組み立て（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 仕上げモードとは独立。仕上げ表との共有はデータ（Room の天井欄）と純モジュールだけ（ユーザー裁定 2026-10-10）。
 *
 * 既知の限界: CH は roomCeilingHeight().raw のみ。仕上げ表の内部タブが上階吹抜けの部屋で併記する計算値
 * （voidCHAbove）は出さない（S1a' の受容。他階 peek を持たないため）。
 *
 * 行: { id, kind, name, ceilingBoard, ceilingFinish, ch }
 *   kind … 'room'（部屋の行。選択できる）| 'stair'（部屋の無い階段の行。id は stair.id。選択対象外）。
 *   ceilingBoard … 天井材。room.getFinishInfo().ceilingPanel（既定は読み時補完）を materialMap で名前に解き
 *                  formatMaterialLabel で略称表示にした文字列（解けなければコードのまま）。
 *   ceilingFinish … 同 .ceilingFinish（天井仕上げ）。表示は ceilingBoard と同じ規則。
 *   ch … roomCeilingHeight(graph, room).raw（レンジ表記は原文のまま）。部屋の無い階段は null。
 * 部屋の無い階段の行の天井材・仕上げは null（描画側が「—」にする。書込み先の部屋が無い）。
 */
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { cellBoundsFromKey } from '../finish/gridCells.js';
import { interiorTabRooms, interiorRoomDisplayName } from '../finish/interiorTabRooms.js';
import { STAIR_TYPE_LABEL } from '../finish/stair/stairTypeLabel.js';
import { DEFAULT_STAIR_ROOM_NAME } from '../finish/roomNamingOptions.js';
import { formatMaterialLabel } from '../finish/materials/materialLabel.js';
import { ceilingSurfacesOf } from './ceilingSurfaces.js';
import { zoneStateOfCells } from './ceilingZones.js';

/** 材コード → 表示名（略称表示）。materialMap が無い・コードが解けない・名前が無いときはコードのまま。 */
export function materialDisplay(materialMap, code) {
  if (!code) return null;
  const name = materialMap?.get(code)?.name;
  return name ? formatMaterialLabel(name) : code;
}

/**
 * 天井区画（S5）が効いている部屋の CH 欄の表記: 部屋ごとに「残りの部屋 CH（残りがあるとき）＋各区画の高さ」の最小～最大
 * （全部同じなら数値）。区画の無い部屋・効いている区画（解けるセルを持つ面）の無い部屋は入れない（呼び側が従来の raw のまま）。
 * 仕上げ表の CH 欄（部屋の ceilingHeight の override）には書かない——ここは表示だけ。区画が1つも無い階は計算を省く。
 * @returns {Map<string, string>} roomId → 表記
 */
export function zoneChLabelsByRoom(graph) {
  const labels = new Map();
  if (!graph || graph.rooms.every(r => r.ceilingZones.length === 0)) return labels;
  const heights = new Map(); // roomId → number[]
  for (const s of ceilingSurfacesOf(graph)) {
    const room = graph.roomMap.get(s.roomId);
    if (!room || room.ceilingZones.length === 0) continue;
    const zone = s.zoneId ? room.ceilingZones.find(z => z.id === s.zoneId) : null;
    if (!heights.has(room.id)) heights.set(room.id, { hasZone: false, mms: [], rawRange: false });
    const h = heights.get(room.id);
    if (s.zoneId) h.hasZone = true;
    if (zone?.heightMm != null) { h.mms.push(zone.heightMm); continue; }
    // 部屋の CH を使う面。欄が数値化できないレンジ表記なら既定値と合成せず raw のまま出す（利用者の入力を消さない）
    const rawCh = room.getFinishInfo().ceilingHeight;
    if (rawCh != null && rawCh !== '' && !Number.isFinite(Number(rawCh))) h.rawRange = true;
    h.mms.push(roomCeilingHeight(graph, room).mm);
  }
  for (const [id, { hasZone, mms, rawRange }] of heights) {
    if (!hasZone || rawRange) continue; // 効いている区画なし／部屋 CH がレンジ表記＝従来どおり（raw）
    const lo = Math.min(...mms), hi = Math.max(...mms);
    labels.set(id, lo === hi ? String(lo) : `${lo}～${hi}`);
  }
  return labels;
}

function roomRow(graph, room, name, materialMap, zoneLabels) {
  const info = room.getFinishInfo();
  return {
    id: room.id,
    kind: 'room',
    name,
    ceilingBoard: materialDisplay(materialMap, info.ceilingPanel),
    ceilingFinish: materialDisplay(materialMap, info.ceilingFinish),
    ch: zoneLabels?.get(room.id) ?? roomCeilingHeight(graph, room).raw,
  };
}

/**
 * 選択中の天井セルの要約（パネル上段）。selection が無ければ null。
 * name・ch は行（内部＋階段）から owner.rowId で引く（見つからなければ name='—'・ch=null）。
 * cellCount は現行の格子で解けるキーの数（CL 削除などで消えたキーは数えない）。
 * zone … 選択セル群の天井区画の状態（S5。zoneStateOfCells）。所属が部屋のときだけ。階段所属は null（階段の区画入力は S6）。
 * @returns {{name: string, cellCount: number, ch: string|null, zone: {state: 'none'|'uniform'|'mixed', heightMm: number|null}|null} | null}
 */
export function selectionSummary(graph, selection) {
  if (!selection) return null;
  const row = [...interiorRows(graph), ...stairRows(graph)].find(r => r.id === selection.owner.rowId);
  let cellCount = 0;
  for (const key of selection.cellKeys) if (cellBoundsFromKey(key, graph)) cellCount++;
  const zone = selection.owner.kind === 'room'
    ? zoneStateOfCells(graph, graph.roomMap.get(selection.owner.id) ?? null, selection.cellKeys)
    : null;
  return { name: row ? row.name : '—', cellCount, ch: row ? row.ch : null, zone };
}

/**
 * 選択中のセル群へ区画の高さを書ける部屋（S5）。所属が部屋のときだけその部屋。階段所属（S6 まで無効）・解けない所属は null。
 * 天井材・仕上げの書込み先 ceilingWriteTargetRoom（階段は対の部屋）とは別: 区画は階段のセルに対しては入力させない。
 * @returns {import('../core/room.js').Room | null}
 */
export function ceilingZoneTargetRoom(graph, selection) {
  if (!selection || selection.owner.kind !== 'room') return null;
  return graph.roomMap.get(selection.owner.id) ?? null;
}

/**
 * 選択中のセル群の天井材・仕上げの書込み先の部屋（「仕上げは部屋に1つ」＝どのセル群でも書込み先は部屋）。
 * 所属が部屋ならその部屋、階段で stair.roomId の部屋があればその部屋、部屋の無い階段・解けない所属は null。
 * @returns {import('../core/room.js').Room | null}
 */
export function ceilingWriteTargetRoom(graph, selection) {
  if (!selection) return null;
  const { kind, id } = selection.owner;
  if (kind === 'room') return graph.roomMap.get(id) ?? null;
  if (kind === 'stair') {
    const stair = graph.stairMap.get(id);
    return stair?.roomId ? (graph.roomMap.get(stair.roomId) ?? null) : null;
  }
  return null;
}

/** 仕上げ表の内部タブと同じ部屋・同じ並び・同じ表示名。 */
export function interiorRows(graph, materialMap = null) {
  const zoneLabels = zoneChLabelsByRoom(graph);
  return interiorTabRooms(graph).map(room => roomRow(graph, room, interiorRoomDisplayName(room), materialMap, zoneLabels));
}

/**
 * 仕上げ表の階段タブが並べる階段（この階の graph.stairs。階段タブの自階メンバーと同じ集合・順）。
 * 名前は変換元の部屋（stair.roomId）があればその名前（空なら階段の既定名）、無ければ階段タブの行表記
 * 「タイプ 段数」。部屋の無い階段（旧データ・上階自動設置分）は仕上げ欄を持たないので ch も null。
 */
export function stairRows(graph, materialMap = null) {
  const zoneLabels = zoneChLabelsByRoom(graph);
  return graph.stairs.map(stair => {
    const room = stair.roomId ? graph.roomMap.get(stair.roomId) : null;
    if (room) return roomRow(graph, room, room.name || DEFAULT_STAIR_ROOM_NAME, materialMap, zoneLabels);
    return {
      id: stair.id,
      kind: 'stair',
      name: `${STAIR_TYPE_LABEL[stair.type] ?? stair.type} ${stair.totalSteps}段`,
      ceilingBoard: null,
      ceilingFinish: null,
      ch: null,
    };
  });
}
