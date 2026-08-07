// ================================================================
// 外壁アルミサッシ納まり詳細カタログ — 主要構造・外壁仕上げ材別の平面・断面詳細図パラメータ
//
// openingCatalog.js と同様、フロアプランモードでも使う可能性がある静的データのため
// 動的 import にせず静的 import する。finish/materials/materialData.js（仕上げモードのみ
// 動的import対象）には依存しない（下地材コード→木質判定は backingClass.js のコード集合を
// 使う。x/y寸法・spec本体を含む materialMap は呼び出し側が動的ロードして渡す）。
//
// isWoodStructure（フィン直付け判定の主条件）は「主要構造」であり下地材とは別概念のため、
// structural/structuralAutoFill.js が公開する effectiveStructure（階の上書き優先・なければ
// 建物全体値）をそのまま再利用する（4つ目の重複実装を作らない）。
//
// 出典: cad-freed-rawingsamples.com（アルミサッシ構造・仕上げ材別収まり詳細図集）
//       mado-handbook.com（各解説ページ）
// ================================================================
import { isWoodWallBacking } from '../finish/materials/backingClass.js';
import { effectiveStructure } from '../structural/structuralAutoFill.js';

/** 主要構造 */
export const SashStructure = Object.freeze({
  WOOD:  'wood',
  STEEL: 'steel',
  RC:    'rc',
});

/** 位置決め方式 — フィン基準（下地材へ直付け） / 仕上げ材納まり基準 */
export const SashPositioning = Object.freeze({
  FIN:    'fin',
  FINISH: 'finish',
});

/** 外壁仕上げ系統。resolveSashDetail の finishKey に渡すキー。 */
export const SashFinishFamily = Object.freeze({
  SIDING:            'siding',           // サイディング
  WET:               'wet',              // 湿式（ラスモルタル）
  EXPOSED_CONCRETE:  'exposedConcrete',  // コンクリート打ち放し
  TILE:              'tile',             // タイル
  ALC:               'alc',              // ALC
  ECP:               'ecp',              // ECP（押出成形セメント板）
});

const SOURCE_DETAIL = 'https://cad-freed-rawingsamples.com/';

export const SASH_DETAIL_CATALOG = [
  {
    key: 'woodSiding', label: '木造×サイディング（乾式）',
    structure: SashStructure.WOOD, finish: 'サイディング（乾式）', finishFamily: SashFinishFamily.SIDING,
    frameDepth: 70, frameDepthRange: [70, 100], positioning: SashPositioning.FIN,
    fin: { finToExterior: 35, maxWallThickness: 30 }, // 釘打ちフィンを柱・間柱（下地材）へ直付け
    plan: { trimFaceOptions: [20, 21, 24], interiorChiriSide: 15 },
    section: { interiorChiriTop: 15, interiorChiriBottom: 0 },
    source: SOURCE_DETAIL,
  },
  {
    key: 'woodWet', label: '木造×湿式（ラスモルタル）',
    structure: SashStructure.WOOD, finish: '湿式（ラスモルタル）', finishFamily: SashFinishFamily.WET,
    frameDepth: 70, positioning: SashPositioning.FIN,
    fin: { finToExterior: 35 }, // フィン直付けは woodSiding と同様。フィン上から防水紙・ラス・モルタルの順に施工
    plan: { finLayers: ['防水紙', 'ラス', 'モルタル'] },
    section: { finLayers: ['防水紙', 'ラス', 'モルタル'] },
    source: SOURCE_DETAIL,
  },
  {
    key: 'rcExposedConcrete', label: 'RC×コンクリート打ち放し（抱き納まり）',
    structure: SashStructure.RC, finish: 'コンクリート打ち放し', finishFamily: SashFinishFamily.EXPOSED_CONCRETE,
    frameDepth: 70, frameDepthRange: [70, 100], positioning: SashPositioning.FINISH,
    fin: null,
    plan: { embraceClearance: { min: 25, max: 30, note: '溶接代' }, exteriorChiriSide: 15, interiorChiriSide: 15, trimFace: 25 },
    section: { exteriorChiriTop: 20, interiorChiriTop: 15, interiorChiriBottom: 0, sealType: 'single' }, // 抱き納まりはシングルシール
    source: SOURCE_DETAIL,
  },
  {
    key: 'rcTileEmbrace', label: 'RC×タイル（抱き納まり）',
    structure: SashStructure.RC, finish: 'タイル（抱き納まり）', finishFamily: SashFinishFamily.TILE,
    frameDepth: 70, positioning: SashPositioning.FINISH,
    fin: null,
    plan: { embraceClearance: { min: 25, max: 30, note: '溶接代' }, exteriorChiriSide: 15 },
    section: { exteriorChiriTop: 20, sealType: 'single' },
    source: SOURCE_DETAIL,
  },
  {
    key: 'rcTileFlush', label: 'RC×タイル（同面納まり）',
    structure: SashStructure.RC, finish: 'タイル（同面納まり）', finishFamily: SashFinishFamily.TILE,
    frameDepth: 70, positioning: SashPositioning.FINISH,
    fin: null,
    plan: {},
    section: { sealType: 'double' }, // 同面はダブルシール（雨掛かり大）
    source: SOURCE_DETAIL,
  },
  {
    key: 'steelALC', label: 'S造×ALC',
    structure: SashStructure.STEEL, finish: 'ALC', finishFamily: SashFinishFamily.ALC,
    frameDepth: null, positioning: SashPositioning.FINISH,
    fin: null,
    plan: { method: 'UL工法（乾式軽量フカシ壁）', frameType: 'ALC専用枠' },
    section: { method: 'UL工法（乾式軽量フカシ壁）', frameType: 'ALC専用枠' },
    source: SOURCE_DETAIL,
  },
  {
    key: 'steelECPRainFin', label: 'S造×ECP（外部雨切フィン付）',
    structure: SashStructure.STEEL, finish: 'ECP（外部雨切フィン付）', finishFamily: SashFinishFamily.ECP,
    frameDepth: 70, positioning: SashPositioning.FINISH,
    fin: null,
    plan: {
      setback: 75, // 外壁面から枠をセットバック
      rainDripProjection: { min: 60, max: 80 }, // 雨切材出幅
      rainDripChiri: 15, // 雨切材とECPのチリ
      furringClearance: { min: 25 }, // 枠外〜胴縁クリア
      interiorChiriSide: 15,
    },
    section: {
      interiorChiriTop: 15, interiorChiriBottom: 0,
      sealType: 'double', sealDetail: { primary: 'ECP外面', secondary: 'ECP内面' },
    },
    source: SOURCE_DETAIL,
  },
  {
    key: 'steelECPFlush', label: 'S造×ECP（同面納まり）',
    structure: SashStructure.STEEL, finish: 'ECP（同面納まり）', finishFamily: SashFinishFamily.ECP,
    frameDepth: 70, positioning: SashPositioning.FINISH,
    fin: null,
    plan: { sealJointWidth: 20, jambClearance: 50, trimChiri: 5 },
    section: { sillDrop: 10, trimChiri: 5 },
    source: SOURCE_DETAIL,
  },
  {
    key: 'steelSidingHalfExposed', label: 'S造×サイディング（半外枠）',
    structure: SashStructure.STEEL, finish: 'サイディング（半外枠）', finishFamily: SashFinishFamily.SIDING,
    frameDepth: 70, positioning: SashPositioning.FINISH,
    // 非木造のためフィンは下地材への直付け基準ではなく、仕上げ納まり（positioning='finish'）で位置が決まる
    fin: { finToExterior: { min: 35, max: 40 }, maxWallThickness: 30 },
    plan: { exteriorChiri: { approx: 10 } },
    section: { exteriorChiri: { approx: 10 } },
    source: SOURCE_DETAIL,
  },
  {
    key: 'steelSidingRainDrip', label: 'S造×サイディング（外部雨切材付）',
    structure: SashStructure.STEEL, finish: 'サイディング（外部雨切材付）', finishFamily: SashFinishFamily.SIDING,
    frameDepth: 70, positioning: SashPositioning.FINISH,
    fin: null,
    plan: { rainDripProjection: { approx: 40 }, rainDripChiri: { approx: 15 } },
    section: { rainDripProjection: { approx: 40 }, rainDripChiri: { approx: 15 } },
    source: SOURCE_DETAIL,
  },
];

/**
 * 主要構造・下地材の断面寸法・仕上げ系統から、外壁アルミサッシの収まり詳細エントリを解決する。
 *
 * 規約:
 *   - isWoodStructure===true、または backingDepth(見込み方向)>=90 → フィン下地直付け(positioning='fin')。
 *   - それ以外（非木造・下地90mm未満）→ フィンなし、仕上げ材納まり基準(positioning='finish')。
 *   - finishKey が一致するエントリがあればそれを返す。無ければ最も近い既定にフォールバック
 *     （fin側: woodSiding／finish側: steelSidingHalfExposed）。
 *
 * @param {{isWoodStructure?:boolean, backingDepth?:number, finishKey?:string|null}} [inputs]
 * @returns {object} SASH_DETAIL_CATALOG のエントリ（必ず1件返す）
 */
export function resolveSashDetail({ isWoodStructure = false, backingDepth = 0, finishKey = null } = {}) {
  const useFin = isWoodStructure || backingDepth >= 90;
  const positioning = useFin ? SashPositioning.FIN : SashPositioning.FINISH;
  const bucket = SASH_DETAIL_CATALOG.filter(e => e.positioning === positioning);

  const byFinish = finishKey ? bucket.find(e => e.finishFamily === finishKey) : null;
  if (byFinish) return byFinish;

  const fallbackKey = useFin ? 'woodSiding' : 'steelSidingHalfExposed';
  return SASH_DETAIL_CATALOG.find(e => e.key === fallbackKey) ?? bucket[0] ?? SASH_DETAIL_CATALOG[0];
}

/**
 * 下地材（{ code, x, y, thickness }）の「木造下地材の断面寸法（見込み方向）」を返す。
 * backingClass.js の材コード集合（WOOD_WALL_BACKING_CODES）で木質下地かどうかを判定し、
 * 木質でなければ 0 を返す（RC・鋼下地が「断面寸法90mm以上」条件を誤って満たさないようにするため。
 * 例: RC壁下地 t=150 は thickness:150 を持つが木質ではないので backingDepth=0）。
 * @param {{code?:string, x?:number, y?:number, thickness?:number}|null} backingMaterial
 * @returns {number}
 */
export function woodBackingDepth(backingMaterial) {
  if (!backingMaterial || !isWoodWallBacking(backingMaterial.code)) return 0;
  return backingMaterial.thickness ?? Math.max(backingMaterial.x ?? 0, backingMaterial.y ?? 0);
}

/**
 * graph（階）・project（建物全体）・materialMap（finish/materials/materialData.js の
 * MATERIALS を code → material にした Map。動的ロードは呼び出し側の責務）から
 * 外壁アルミサッシの収まり詳細エントリを解決する。
 *   isWoodStructure ← 実効主構造（structuralAutoFill.js の effectiveStructure。階の
 *                      structureOverride 優先・なければ建物全体の project.structuralInfo.mainStructure）
 *                      が「木造」表記で始まるか（既存の判定パターン。例: drawingDesignation.js）
 *   backingDepth    ← 外壁下地材（graph.exteriorWallBacking）が木質下地の場合のみ、その見込み寸法
 * 呼び出し規約: graph・project は必須（effectiveStructure と同じくnullを許容しない。
 * 未確定の階・建物を渡さないのは呼び出し側の責務）。materialMap のみ未ロードでnull許容。
 * @param {{exteriorWallBacking: string, structureOverride: string|null}} graph
 * @param {{structuralInfo: {mainStructure: string}}} project
 * @param {Map<string, object>|null|undefined} materialMap
 * @param {string|null} [finishKey]
 * @returns {object}
 */
export function resolveSashDetailForGraph(graph, project, materialMap, finishKey = null) {
  const structure = effectiveStructure(graph, project);
  const isWoodStructure = (structure ?? '').startsWith('木造');
  const backing = materialMap?.get(graph.exteriorWallBacking) ?? null;
  const backingDepth = woodBackingDepth(backing);
  return resolveSashDetail({ isWoodStructure, backingDepth, finishKey });
}
