/**
 * 天伏パネルの行の組み立て（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 仕上げモードとは独立。仕上げ表との共有はデータ（Room の天井欄）と純モジュールだけ（ユーザー裁定 2026-10-10）。
 *
 * 既知の限界: CH は roomCeilingHeight().raw のみ。仕上げ表の内部タブが上階吹抜けの部屋で併記する計算値
 * （voidCHAbove）は出さない（S1a' の受容。他階 peek を持たないため）。
 *
 * パネルは木（ceilingPanelTree）→ 平らな行（ceilingPanelLines）を描くだけ。ノード id は天井セルの群 id（ceilingGroups.js。
 * room:<id>／zone:<部屋id>#<区画id>／stair:<id>）で、選択（selection.groupId）とノードの一致が強調の唯一の判定。
 * 並び替えは持たない（仕上げ表の部屋の並び＝graph.rooms の順をそのまま使う）。
 *
 * 行（interiorRows／stairRows が木の部屋・階段ノードの列を作る）: { id, kind, name, ceilingBoard, ceilingFinish, ch }
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
import { ceilingRefreshCells } from './ceilingGrid.js';
import { ceilingCellOwnersOf, roomHasCeiling } from './ceilingOwners.js';
import { CEILING_SHAPE_OPTIONS, CEILING_DIM_FIELDS } from './ceilingShapeFields.js';
import { ceilingGroupsOf, roomGroupId, zoneGroupId, stairGroupId, stairUnderGroupId } from './ceilingGroups.js';
import { roomCeilingShapeOf } from './roomCeilingShape.js';
import { CeilingShape } from '../core/constants.js';

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
  const plainRoom = r => r.ceilingZones.length === 0 && roomCeilingShapeOf(r).shape === CeilingShape.FLAT; // 区画なし・形状なし（S12a）
  if (!graph || graph.rooms.every(plainRoom)) return labels;
  const heights = new Map(); // roomId → number[]
  for (const s of ceilingSurfacesOf(graph)) {
    const room = graph.roomMap.get(s.roomId);
    if (!room || plainRoom(room)) continue;
    const zone = s.zoneId ? room.ceilingZones.find(z => z.id === s.zoneId) : null;
    if (!heights.has(room.id)) heights.set(room.id, { hasZone: false, mms: [], rawRange: false });
    const h = heights.get(room.id);
    // 区画のある部屋、または残りの面が平面でない部屋（部屋の形状）はレンジ表記にする
    if (s.zoneId || s.shape !== 'flat') h.hasZone = true;
    // 平面以外（傾斜・円弧・ドーム）は基準高〜基準高＋ライズ（図のラベルと同じ範囲。zHi − zLo）
    const rise = s.shape !== 'flat' && Number.isFinite(s.dims?.[0]) ? s.dims[0] : 0;
    if (zone?.heightMm != null) { h.mms.push(zone.heightMm, zone.heightMm + rise); continue; }
    // 部屋の CH を使う面。欄が数値化できないレンジ表記なら既定値と合成せず raw のまま出す（利用者の入力を消さない）
    const rawCh = room.getFinishInfo().ceilingHeight;
    if (rawCh != null && rawCh !== '' && !Number.isFinite(Number(rawCh))) h.rawRange = true;
    const base = roomCeilingHeight(graph, room).mm;
    h.mms.push(base, base + rise);
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
 * 選択中の群（selection.groupId）の現在の姿。群が今は無い（undo などで消えた）・selection が無いときは null。
 * room … 群の書込み先の部屋（zone・room 群は群の部屋、stair 群は対の部屋。無ければ null）／zone … zone 群の区画（なければ null）。
 * MobX の追跡下から呼べるよう読み取りスコープで包まない（ceilingCellOwnersOf と同じ）。
 * @returns {{group: import('./ceilingGroups.js').CeilingGroup, room: import('../core/room.js').Room|null, zone: import('@core').CeilingZone|null} | null}
 */
export function selectionGroupInfo(graph, selection, stairUnderKeys = null) {
  if (!graph || !selection) return null;
  const group = ceilingGroupsOf(graph, ceilingCellOwnersOf(graph), stairUnderKeys).groups.get(selection.groupId);
  if (!group) return null;
  const room = group.roomId ? (graph.roomMap.get(group.roomId) ?? null) : null;
  const zone = group.kind === 'zone' && room ? (room.ceilingZones.find(z => z.id === group.zoneId) ?? null) : null;
  return { group, room, zone };
}

/**
 * パネルが「選択中」として強調するノード id（＝群 id）。selection が無い・群が今は無い（undo などで消えた。S12b 持ち越し）ときは null
 * （パネルは選択なし扱い。selection 自体は触らない）。
 */
export function selectedNodeId(graph, selection, stairUnderKeys = null) {
  return selectionGroupInfo(graph, selection, stairUnderKeys) ? selection.groupId : null;
}

/**
 * 選択中のセル群の外接矩形の幅（x 方向・y 方向。mm）。円弧のライズ上限（幅/2）の検査用（parseCeilingZoneDraft が軸で x/y を選ぶ）。解けるセルが無ければ null。
 * @returns {{xMm: number, yMm: number}|null}
 */
export function selectionSpanMm(graph, selection) {
  if (!selection) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const key of selection.cellKeys) {
    const b = cellBoundsFromKey(key, graph);
    if (!b) continue;
    x1 = Math.min(x1, b.x1, b.x2); x2 = Math.max(x2, b.x1, b.x2);
    y1 = Math.min(y1, b.y1, b.y2); y2 = Math.max(y2, b.y1, b.y2);
  }
  return Number.isFinite(x1) ? { xMm: x2 - x1, yMm: y2 - y1 } : null;
}

/**
 * 天井材・仕上げの書込み先の部屋（「仕上げは部屋に1つ」＝どのノードでも書込み先は部屋）。selection は {owner:{kind,id}} の形。
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

/** 区画の寸法の表記: CEILING_DIM_FIELDS のラベルで「ライズ 500・上がる向き ↑ 上」。select は選択肢の表示名。平面は空文字。 */
function dimsLabelOf(shape, dims) {
  return CEILING_DIM_FIELDS[shape]
    .map((f, i) => {
      const v = dims[i];
      const text = f.input === 'select' ? (f.options.find(o => o.value === v)?.label ?? String(v)) : String(v);
      return `${f.label} ${text}`;
    })
    .join('・');
}

/**
 * 階段の区画の内訳（階段タブの展開用。読むだけ）。区画の配列順に、実際に効くセル（今の天井セルへ展開し、所属索引が
 * この部屋に帰属させるセル。ceilingSurfacesOf の面と同じ採り方・同じ先勝ち）を持つ区画だけ。
 * heightLabel … 基準高。null（部屋の CH を使う）は「部屋 CH」、数値はそのまま文字列。
 * 対の部屋（stair.roomId）の区画のうち、その階段に所属するセル
 * （所属索引で kind==='stair' かつ id===stair.id）を持つ区画だけ。セル数は階段所属のセルの数。残りは出さない。対の部屋が無ければ []。
 */
export function stairZoneDetailRows(graph, stair) {
  const room = graph && stair?.roomId ? graph.roomMap.get(stair.roomId) : null;
  return zoneRowsBy(graph, room, o => o.kind === 'stair' && o.id === stair.id);
}

function zoneRowsBy(graph, room, isMine) {
  if (!graph || !room || room.ceilingZones.length === 0) return [];
  const owners = ceilingCellOwnersOf(graph);
  const taken = new Set();
  const out = [];
  for (const zone of room.ceilingZones) {
    let cellCount = 0;
    for (const key of ceilingRefreshCells(new Set(zone.cells), graph)) {
      const owner = owners.get(key);
      if (taken.has(key) || !owner || !isMine(owner)) continue;
      taken.add(key);
      cellCount++;
    }
    if (cellCount === 0) continue;
    out.push({
      zoneId: zone.id,
      shapeLabel: CEILING_SHAPE_OPTIONS.find(o => o.value === zone.shape)?.label ?? zone.shape,
      heightLabel: zone.heightMm == null ? '部屋 CH' : String(zone.heightMm),
      dimsLabel: dimsLabelOf(zone.shape, zone.dims),
      cellCount,
    });
  }
  return out;
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
    // 行 id は所属の rowId（ceilingOwners と同じ stair.roomId ?? stair.id）に揃える。参照切れの roomId でも選択がこの行に出る
    return {
      id: stair.roomId ?? stair.id,
      kind: 'stair',
      name: stair.roomId ? DEFAULT_STAIR_ROOM_NAME : `${STAIR_TYPE_LABEL[stair.type] ?? stair.type} ${stair.totalSteps}段`,
      ceilingBoard: null,
      ceilingFinish: null,
      ch: null,
    };
  });
}

// ---- 木（S12c）----

const NO_CELLS = new Set();

/**
 * パネルのノード。
 *   id … 群 id（roomGroupId／zoneGroupId／stairGroupId／stairUnderGroupId）  type … 'room' | 'zone' | 'stair' | 'stairUnder'（階段の子の先頭。選択専用の群）
 *   name … 部屋名／「区画n」（部屋の区画の配列順）／階段名    ceilingBoard・ceilingFinish … 天井材・仕上げの表示（zone は null）
 *   ch … 部屋・階段は行と同じ CH 欄、zone は基準高（平面以外は基準高～基準高＋ライズ。null の基準高は部屋の CH）
 *   summary … zone の「形状｜寸法｜Nセル」（colSpan で天井材・仕上げの2列に出す）
 *   room … 書込み先の部屋（階段は対の部屋、無ければ null）  zone … CeilingZone（zone のみ）
 *   hasCeiling … room ノードのみ（roomHasCeiling）  cells … 同じ群 id の群のセル（群が無ければ空）
 *   children … room: 区画のノード（room.ceilingZones の順。面が0件でも出す）→ 部分指定の子の部屋ノード／stair: その階段所属のセルを持つ区画
 */
function zoneNode(graph, room, zone, cellCount, groups) {
  const id = zoneGroupId(room.id, zone.id);
  const rise = zone.shape !== CeilingShape.FLAT && Number.isFinite(zone.dims[0]) ? zone.dims[0] : 0;
  const base = zone.heightMm ?? roomCeilingHeight(graph, room).mm;
  const shapeLabel = CEILING_SHAPE_OPTIONS.find(o => o.value === zone.shape)?.label ?? zone.shape;
  return {
    id,
    type: 'zone',
    name: `区画${room.ceilingZones.indexOf(zone) + 1}`,
    summary: [shapeLabel, dimsLabelOf(zone.shape, zone.dims), `${cellCount}セル`].filter(Boolean).join('｜'),
    ceilingBoard: null,
    ceilingFinish: null,
    ch: rise > 0 ? `${base}～${base + rise}` : String(base),
    room,
    zone,
    cells: groups.get(id)?.cells ?? NO_CELLS,
    children: [],
  };
}

function interiorTree(graph, materialMap, groups) {
  const rooms = interiorTabRooms(graph);
  const rows = interiorRows(graph, materialMap);
  const rowOf = new Map(rooms.map((r, i) => [r.id, rows[i]]));
  // 部分指定の子は、タブにいる最初の親（graph.rooms の順）の下に入れ子。親がタブに無い子は最上位
  const parentOf = new Map();
  for (const r of rooms) {
    if (r.referenceRoomIds.size === 0) continue;
    const parent = rooms.find(p => p !== r && r.referenceRoomIds.has(p.id));
    if (parent) parentOf.set(r.id, parent.id);
  }
  const kidsOf = new Map();
  for (const r of rooms) {
    const pid = parentOf.get(r.id);
    if (pid) kidsOf.set(pid, [...(kidsOf.get(pid) ?? []), r]);
  }
  const placed = new Set();
  const build = room => {
    placed.add(room.id);
    const row = rowOf.get(room.id);
    const id = roomGroupId(room.id);
    const zones = room.ceilingZones.map(z => zoneNode(graph, room, z, groups.get(zoneGroupId(room.id, z.id))?.cells.size ?? 0, groups));
    const kids = (kidsOf.get(room.id) ?? []).filter(k => !placed.has(k.id)).map(build);
    return {
      id,
      type: 'room',
      name: row.name,
      ceilingBoard: row.ceilingBoard,
      ceilingFinish: row.ceilingFinish,
      ch: row.ch,
      room,
      hasCeiling: roomHasCeiling(room),
      cells: groups.get(id)?.cells ?? NO_CELLS,
      children: [...zones, ...kids],
    };
  };
  const roots = rooms.filter(r => !parentOf.has(r.id)).map(build);
  for (const r of rooms) if (!placed.has(r.id)) roots.push(build(r)); // 参照の循環で取り残された部屋も最上位に出す
  return roots;
}

function stairTree(graph, materialMap, groups) {
  const rows = stairRows(graph, materialMap);
  return graph.stairs.map((stair, i) => {
    const row = rows[i];
    const room = ceilingWriteTargetRoom(graph, { owner: { kind: 'stair', id: stair.id } });
    const id = stairGroupId(stair.id);
    const zoneNodes = room
      ? stairZoneDetailRows(graph, stair).map(d => zoneNode(graph, room, room.ceilingZones.find(z => z.id === d.zoneId), d.cellCount, groups))
      : [];
    // 階段下の群（区画に入らなかった階段下のセルが残るときだけ）。区画のノードの前に置く
    const underId = stairUnderGroupId(stair.id);
    const under = groups.get(underId);
    const children = under
      ? [{ id: underId, type: 'stairUnder', name: '階段下', ceilingBoard: row.ceilingBoard, ceilingFinish: row.ceilingFinish, ch: row.ch, room, cells: under.cells, children: [] }, ...zoneNodes]
      : zoneNodes;
    return {
      id,
      type: 'stair',
      name: row.name,
      ceilingBoard: row.ceilingBoard,
      ceilingFinish: row.ceilingFinish,
      ch: row.ch,
      room,
      cells: groups.get(id)?.cells ?? NO_CELLS,
      children,
    };
  });
}

/**
 * パネルの木。内部タブは 仕上げ表と同じ部屋（interiorTabRooms）のうち親（referenceRoomIds なし）が最上位で、部分指定の子は親の下
 * （親がタブに無い子は最上位）。階段タブは graph.stairs の順の階段が最上位。graph が null は []。
 * @param {object} graph
 * @param {'interior'|'stair'|'exterior'} tab  exterior は []（軒裏の行は ceilingExteriorRows）
 * @param {Map<string, object>|null} materialMap
 * @param {Map<string, Set<string>>|null} [stairUnderKeys]  階段下の天井セル（stairUnderCeilingKeys）。あれば階段の子の先頭に「階段下」ノード
 */
export function ceilingPanelTree(graph, tab, materialMap = null, stairUnderKeys = null) {
  if (!graph || tab === 'exterior') return []; // 外部タブ（軒裏）は群を持たない（行は ceilingExteriorRows.js）
  const { groups } = ceilingGroupsOf(graph, ceilingCellOwnersOf(graph), stairUnderKeys);
  return tab === 'stair' ? stairTree(graph, materialMap, groups) : interiorTree(graph, materialMap, groups);
}

/**
 * 木を expandedPath（各段で開いているノード id。各段1つだけ）に従って平らな行にする。行の種類:
 *   'room' | 'zone' | 'stair' … ノードの行（node・expanded を持つ）
 *   'roomFields' … 部屋ノードを開いたときの形状・天井高の欄（天井を持つ部屋のみ。先頭）／'zoneFields' … 区画ノードを開いたときの区画の欄
 *   'note' … 欄の代わりの1行（text）。天井を持たない部屋は「天井なし」、区画の無い階段は「区画なし」（対の部屋が無ければ「区画なし（対の部屋なし）」）
 * 部屋を開くと 欄 → 区画 → 子の部屋 の順（子は1段深い）。階段を開くと その階段の区画だけ（部屋レベルの欄は出さない）。
 * ノードの行は path（最上位からその行までの祖先を含むノード id の経路）を持つ。行クリックはこれをそのまま expandedPath にする。
 * @returns {Array<{key: string, nodeId: string, depth: number, type: string, node: object, expanded?: boolean, path?: string[], text?: string}>}
 */
export function ceilingPanelLines(tree, expandedPath = []) {
  const lines = [];
  // key は親からの経路（同じ対の部屋の区画が複数の階段の下に並んでも一意）
  const walk = (nodes, depth, prefix, ancestors = []) => {
    for (const node of nodes) {
      const expanded = expandedPath[depth] === node.id;
      const key = `${prefix}/${node.id}`;
      const path = [...ancestors, node.id];
      lines.push({ key, nodeId: node.id, depth, type: node.type, node, expanded, path });
      if (!expanded) continue;
      const inner = { nodeId: node.id, depth: depth + 1, node };
      if (node.type === 'room') {
        lines.push(node.hasCeiling
          ? { ...inner, key: `${key}/fields`, type: 'roomFields' }
          : { ...inner, key: `${key}/note`, type: 'note', text: '天井なし' });
      } else if (node.type === 'zone') {
        lines.push({ ...inner, key: `${key}/fields`, type: 'zoneFields' });
      } else if (node.type !== 'stairUnder' && node.children.length === 0) { // 階段下は子を持たない（区画は兄弟）ので注記を出さない // 階段下は子を持たない（区画は兄弟）ので注記を出さない
        lines.push({ ...inner, key: `${key}/note`, type: 'note', text: node.room ? '区画なし' : '区画なし（対の部屋なし）' });
      }
      walk(node.children, depth + 1, key, path);
    }
  };
  walk(tree, 0, '');
  return lines;
}

/**
 * 群 id のノードを開くための expandedPath（最上位から自身までのノード id）。そのタブの木に無ければ null。
 * 例: ['room:親', 'room:子', 'zone:子#Z']（部分指定の子の区画）、['stair:S', 'zone:R#Z']（階段タブ）。
 */
export function nodePathOf(graph, groupId, tab, stairUnderKeys = null) {
  const find = (nodes, trail) => {
    for (const node of nodes) {
      const path = [...trail, node.id];
      if (node.id === groupId) return path;
      const inner = find(node.children, path);
      if (inner) return inner;
    }
    return null;
  };
  return find(ceilingPanelTree(graph, tab, null, stairUnderKeys), []);
}
