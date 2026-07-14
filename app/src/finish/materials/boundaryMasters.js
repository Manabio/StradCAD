// ================================================================
// 境界マスター（エッジ＝部屋境界ごとの層構成の既定値）
//
// 境界マスターの静的シードデータ（CLAUDE.md データモデル参照）。
// 仕上げモードの「境界マスター選定」（selectBoundaryMaster, 後続フェーズ）が
// エッジに割り当てる masterType と、その層構成（外→内の順）を定義する。
//
// 層の供給元（src）が指定された層は、固定材コードではなく実行時に解決する:
//   FLOOR_EXTERIOR_BACKING : graph.exteriorWallBacking（per-floor 設定）
//   FLOOR_INTERIOR_BACKING : graph.interiorWallBacking（per-floor 設定）
//   ROOM_WALL_MATERIAL     : 隣接部屋の壁材（wallMaterial）へ委譲
//   ROOM_FINISH            : 隣接部屋の内装マスター（壁材＋壁仕上げ）へ委譲
// これにより外壁下地・壁材・室側仕上げの単一情報源を保つ。
//
// ※ マスター自体の編集 UI は本課題の範囲外（静的データとして扱う）。
// ※ 材データと同様、仕上げモード突入時に動的 import して使う想定。
// ================================================================

/** 層の供給元（固定コード以外の解決方法）。 */
export const LAYER_SOURCE = Object.freeze({
  FLOOR_EXTERIOR_BACKING: 'floorExteriorBacking',
  FLOOR_INTERIOR_BACKING: 'floorInteriorBacking',
  ROOM_WALL_MATERIAL:     'roomWallMaterial',
  ROOM_FINISH:            'roomFinish',
});

/** マスターの種別。layered = 壁の層スタックを持つ / meta = 属性のみ（描画用の壁実体なし）。 */
export const BOUNDARY_MASTER_KIND = Object.freeze({
  LAYERED: 'layered',
  META:    'meta',
});

// 材コード定数（materialData.js 参照）— マスター内で使う固定材
const SIDING_FIBER_14     = '111111111217'; // 窯業系サイディング 14mm
const FURRING_45x15       = '111111111159'; // □-45×15 通気胴縁
const VAPOR_PERMEABLE     = '111111111202'; // 透湿防水シート
const AIRTIGHT_FILM       = '111111111205'; // 防湿気密フィルム

// ----------------------------------------------------------------
// 外壁（片側が無名屋外）— 単一情報源。内外壁・はね出し外壁はここから導出する。
// 層は外→内の順。
// ----------------------------------------------------------------
const EXTERIOR_WALL_LAYERS = [
  { role: '外壁仕上げ', code: null },                          // 未指定
  { role: '外壁材',     code: SIDING_FIBER_14 },
  { role: '通気胴縁',   code: FURRING_45x15 },
  { role: '透湿防水シート', code: VAPOR_PERMEABLE },
  { role: '外壁下地',   src: LAYER_SOURCE.FLOOR_EXTERIOR_BACKING },
  { role: '室内側仕上げ', src: LAYER_SOURCE.ROOM_FINISH },
];

/** 内外壁（屋内↔有名屋外）= 外壁 ＋ 外壁下地の室内側に気密層を挿入。 */
function makeInnerOuterWallLayers(exteriorLayers) {
  const out = [];
  for (const layer of exteriorLayers) {
    if (layer.role === '室内側仕上げ') {
      out.push({ role: '気密層', code: AIRTIGHT_FILM });
    }
    out.push({ ...layer });
  }
  return out;
}

/**
 * はね出し外壁（両側が外部）= 外壁の鏡像。
 * 外壁の「外壁下地」を中央層とし、その内側に外側層を逆順でミラーする。
 * 室側委譲層（ROOM_FINISH）は外部同士のため含めない。
 */
function makeCantileverWallLayers(exteriorLayers) {
  const outerSide = exteriorLayers.filter(
    l => l.src !== LAYER_SOURCE.ROOM_FINISH && l.role !== '外壁下地',
  );
  const center = exteriorLayers.find(l => l.role === '外壁下地');
  const mirrored = [...outerSide].reverse().map(l => ({ ...l }));
  return [
    ...outerSide.map(l => ({ ...l })),
    { ...center },
    ...mirrored,
  ];
}

// ----------------------------------------------------------------
// 境界マスター定義
// ----------------------------------------------------------------
export const BOUNDARY_MASTERS = Object.freeze({
  // --- layered（壁の層スタックを持つ）---
  EXTERIOR_WALL: Object.freeze({
    key: 'EXTERIOR_WALL',
    label: '外壁',
    kind: BOUNDARY_MASTER_KIND.LAYERED,
    layers: Object.freeze(EXTERIOR_WALL_LAYERS.map(l => Object.freeze({ ...l }))),
  }),

  CANTILEVER_WALL: Object.freeze({
    key: 'CANTILEVER_WALL',
    label: 'はね出し外壁',
    kind: BOUNDARY_MASTER_KIND.LAYERED,
    derivedFrom: 'EXTERIOR_WALL',
    layers: Object.freeze(makeCantileverWallLayers(EXTERIOR_WALL_LAYERS).map(l => Object.freeze(l))),
  }),

  INNER_OUTER_WALL: Object.freeze({
    key: 'INNER_OUTER_WALL',
    label: '内外壁',
    kind: BOUNDARY_MASTER_KIND.LAYERED,
    derivedFrom: 'EXTERIOR_WALL',
    layers: Object.freeze(makeInnerOuterWallLayers(EXTERIOR_WALL_LAYERS).map(l => Object.freeze(l))),
  }),

  INTERIOR_WALL: Object.freeze({
    key: 'INTERIOR_WALL',
    label: '内壁',
    kind: BOUNDARY_MASTER_KIND.LAYERED,
    // 両側が部屋。室側仕上げは両面とも Room（内装マスター）へ委譲。
    layers: Object.freeze([
      { role: '室側仕上げ', src: LAYER_SOURCE.ROOM_FINISH },
      { role: '面材',       src: LAYER_SOURCE.ROOM_WALL_MATERIAL },
      { role: '下地',       src: LAYER_SOURCE.FLOOR_INTERIOR_BACKING },
      { role: '面材',       src: LAYER_SOURCE.ROOM_WALL_MATERIAL },
      { role: '室側仕上げ', src: LAYER_SOURCE.ROOM_FINISH },
    ].map(l => Object.freeze(l))),
  }),

  // --- meta（属性のみ。壁実体は生成しない）---
  STEP: Object.freeze({
    key: 'STEP',
    label: '段差',
    kind: BOUNDARY_MASTER_KIND.META,
    // 高低差は保持せず level(側B) − level(側A) で導出する。
    fields: Object.freeze({ 框: null }),
  }),

  OUTDOOR_FACILITY: Object.freeze({
    key: 'OUTDOOR_FACILITY',
    label: '屋外施設',
    kind: BOUNDARY_MASTER_KIND.META,
    fields: Object.freeze({}),
  }),

  UNDEFINED: Object.freeze({
    key: 'UNDEFINED',
    label: '未定',
    kind: BOUNDARY_MASTER_KIND.META,
    fields: Object.freeze({ 目地: null, 下がり壁: null }),
  }),
});
