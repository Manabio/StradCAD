// ================================================================
// 構造種別 × 部材有無マトリクス（問題.md「構造と部材有無リスト」のデータ化）
//
// 主構造ごとに、構造リスト（断面図リスト）へ出す部材種別の有無を宣言的に持つ。
// 静的な参照データ（core.js非依存）。主構造名は StructuralInfoDialog.MAIN_STRUCTURE_OPTIONS
// と一致する正式表記をキーに使う。
//
// 【仕様の不整合についての解釈】
// 問題.md の表はヘッダが7列（柱,梁,基礎,基礎梁,スラブ,壁,耐力壁）だが、
// S造・SRC造・木造の各行は値が6個しか無い。建築的整合（雑壁=「壁」は躯体が
// コンクリートのRC造系のみ構造部材として扱い、S造・木造の外周壁/間仕切りは
// 非構造のため対象外）から、6値行は「壁」列を×とみなし末尾値を「耐力壁」に割り当てた。
// 仕様確定後にここだけ直せばよいよう、判定ロジックではなくこのデータに局所化している。
// ================================================================

// 部材種別キー（マトリクスの列。MEMBER_GROUPS の map とは粒度が異なる概念レベルで持つ）。
export const MEMBER_KIND = Object.freeze({
  COLUMN:         'column',         // 柱
  BEAM:           'beam',           // 梁（大梁・小梁）
  FOUNDATION:     'foundation',     // 基礎（独立基礎・べた基礎等）
  FOUNDATION_BEAM:'foundationBeam', // 基礎梁
  SLAB:           'slab',           // スラブ
  WALL:           'wall',           // 壁（雑壁・RC連層壁等の非耐力扱い）
  BEARING_WALL:   'bearingWall',    // 耐力壁
});

// true=有/false=無。問題.md「構造と部材有無リスト」を上記解釈で展開したもの。
export const STRUCTURE_MEMBER_MATRIX = Object.freeze({
  'RC造(ラーメン)': { column: true,  beam: true,  foundation: true, foundationBeam: true, slab: true,  wall: true,  bearingWall: true  },
  'RC造(壁式)':    { column: false, beam: false, foundation: true, foundationBeam: true, slab: true,  wall: true,  bearingWall: true  },
  'S造':           { column: true,  beam: true,  foundation: true, foundationBeam: true, slab: true,  wall: false, bearingWall: true  },
  'SRC造':         { column: true,  beam: true,  foundation: true, foundationBeam: true, slab: true,  wall: false, bearingWall: true  },
  '木造（在来）':   { column: true,  beam: true,  foundation: true, foundationBeam: false, slab: false, wall: false, bearingWall: true  },
  '木造（2"×4"）': { column: false, beam: true,  foundation: true, foundationBeam: false, slab: false, wall: false, bearingWall: true  },
});

/** 主構造に指定の部材種別があるか。未知の主構造（'未定'等）は全て true（出し分けしない）。 */
export function structureHasMember(mainStructure, memberKind) {
  const row = STRUCTURE_MEMBER_MATRIX[mainStructure];
  return row ? !!row[memberKind] : true;
}

// 構造リストの MEMBER_GROUPS（map単位）→ マトリクスの部材種別キーへの対応。
// footingMap は「基礎」、beamMap は「梁」を代表に判定する（基礎梁は梁グループ内 role:'foundation'、
// 柱脚は基礎グループ内のため、グループ表示の可否はこの代表種別で足りる）。
export const MEMBER_KIND_BY_MAP = Object.freeze({
  columnMap:  MEMBER_KIND.COLUMN,
  footingMap: MEMBER_KIND.FOUNDATION,
  beamMap:    MEMBER_KIND.BEAM,
  slabMap:    MEMBER_KIND.SLAB,
  wallMap:    MEMBER_KIND.BEARING_WALL,
});

/** 主構造で、この map のグループ（構造リストの分類）を表示してよいか。 */
export function structureShowsMap(mainStructure, mapName) {
  const kind = MEMBER_KIND_BY_MAP[mapName];
  return kind ? structureHasMember(mainStructure, kind) : true;
}
