// ================================================================
// 伏図（framing plan）の描画規則を主構造ルール（structureRules.js drawing）から解決する純モジュール。
//
// 在来木造の伏図（.claude/structural-model.md「ステップ4」節）は全部材が黒（framingPlanColor:'mono'）、
// 柱は下階柱＝断面□に対角線2本（×）、自階柱＝輪郭のみの□（framingColumnSymbol:'crossBox'）で描く。
// 他の主構造（S造/SRC造/RC造×2/木造2"×4"/未定）は従来どおり材種色・断面そのまま
// （framingPlanColor:'material'／framingColumnSymbol:'section'）——ここが恒等写像であることが
// 非在来の伏図を完全不変に保つ唯一の根拠（structureRules.js の値を直書きしない）。
//
// react/konva/store/.jsx を静的に引かない（team-lessons「抽出モジュールは本番経路をテストで守る」）。
// viewport.js は mobx と @core しか import しない純モジュールのため、node:test 単体import制約に
// 抵触しない（openings/openingPlanSymbolGeometry.js と同じ先例）。
// ================================================================
import { findSectionEntry } from './sectionCatalog.js';
import { LodLevel } from '../viewport.js';

/** 伏図の全黒色（PLAN_WALL_LINE_COLOR とは根拠が別＝「平面は柱断面を壁と同じ黒」に対し
 *  こちらは「伏図（躯体図）は全部材を黒で描く」という別の指示。統合しない。 */
export const FRAMING_MONO_COLOR = '#000000';

/** 柱のフォールバック辺長(mm)。sectionDefId がカタログに未登録のときに使う（従来の COLUMN_SIZE_MM と同値）。 */
export const COLUMN_FALLBACK_SIZE_MM = 120;

/** 伏図の柱グループ定義。レンダラはこの配列を map して描くだけにする——「どの記号か」と
 *  「輪郭線を強制するか」を1箇所（ここ）で決め、レンダラ側の条件分岐に判断を持たせない
 *  （持たせると非在来でも輪郭が強制される回帰になる。実機QA指摘2026-09-15）。
 *  配列の先頭要素は常に下階柱（columnMap）——呼び出し側はここに diaphragm を渡す。
 *  drawing.framingColumnSymbol が 'crossBox'（在来木造）以外——'section'（既定）はもちろん、
 *  未知の値もすべて非在来と同じ既定側（下階のみ・断面そのまま・輪郭強制なし）に倒す。 */
export function framingColumnGroups(drawing) {
  if (drawing.framingColumnSymbol === 'crossBox') {
    // 下階柱は×だけ（断面□は描かない）——在来では梁が下階柱の上に乗るため、伏図で見えるのは梁と
    // 自階柱□であり、下階柱の断面外形は見えない。□まで描くと通しの梁の帯の中に柱寸の四角が残り
    // 「柱断面らしきもの」に見える（実機指摘2026-09-17: 自階柱を小さくしても交点に四角が残る）。
    // 通し柱の位置は自階柱□と下階柱×が重なって自然に「□に×」になる。
    return [
      { category: 'columnMap', symbol: 'cross', outline: false },
      { category: 'columnMapSelf', symbol: 'box', outline: true },
    ];
  }
  return [{ category: 'columnMap', symbol: 'section', outline: false }];
}

/** 構造リストの柱グループの一覧ソース（ステップ3・2026-09-17裁定「柱一覧は在来だけ自階柱□」）。
 *  drawing.framingColumnSymbol==='crossBox'（在来木造）→ 'columnMapSelf'（自階柱□の供給階）。
 *  それ以外（既定 'section'。未知値も含む）→ 'columnMap'（恒等写像＝従来どおり1つ下の実体階の柱）。
 *  MemberListTab.jsx の柱グループの graph 解決（composition.resolveCategory）が唯一の消費先。 */
export function columnListCategory(drawing) {
  return drawing?.framingColumnSymbol === 'crossBox' ? 'columnMapSelf' : 'columnMap';
}

/** 伏図の部材線色。drawing.framingPlanColor: 'mono'（在来木造）→ 常に FRAMING_MONO_COLOR。
 *  'material'（既定）→ 引数の材種色をそのまま返す（恒等写像）。 */
export function framingColor(drawing, materialColor) {
  return drawing.framingPlanColor === 'mono' ? FRAMING_MONO_COLOR : materialColor;
}

/** 伏図の柱の色上書き（colorOverride）。drawing.framingPlanColor: 'mono'（在来木造）→ FRAMING_MONO_COLOR。
 *  それ以外（既定）→ null（ColumnsLayer 側の材種色フォールバックに委ねる）。framingColor と値は同じだが、
 *  引数側（materialColor）を持たない colorOverride 専用の形——StructuralLayer.jsx で二重実装しない。 */
export function framingColorOverride(drawing) {
  return drawing.framingPlanColor === 'mono' ? FRAMING_MONO_COLOR : null;
}

/** 伏図の柱記号の輪郭線幅（LINE_WEIGHT_MM のキー）。drawing.framingColumnLineWeight:
 *  'byLod'（在来木造）→ 略図（SCHEMATIC）は medium、標準・詳細は thick。
 *  それ以外（既定 'fixed'。未知値・drawing 自体が undefined/{} のときも含む）→ 常に medium（恒等写像）。 */
export function framingColumnLineWeight(drawing, lod) {
  if (drawing?.framingColumnLineWeight !== 'byLod') return 'medium';
  return lod === LodLevel.SCHEMATIC ? 'medium' : 'thick';
}

/** 伏図の部材タグ（memberNo）を描くか。drawing.memberTags: 'hide'（在来木造）→ false。
 *  それ以外（既定 'show'。未知値・drawing 自体が undefined/{} のときも含む）→ true（恒等写像）。
 *  タグクリックの代替は伏図の梁タップ（pickMembersOnFigure。ステップ4第3単位①）。 */
export function showMemberTags(drawing) {
  return drawing?.memberTags !== 'hide';
}

/** タグクリックの代替（伏図の梁タップで部材カードを開く）を有効にするか。showMemberTags の否定＝
 *  タグを描かない主構造（在来木造）だけタップ選択を有効にする（.claude/structural-model.md
 *  ステップ4第3単位）。判定先はここに一本化する（新しい drawing フィールドは持たない）。 */
export function pickMembersOnFigure(drawing) {
  return !showMemberTags(drawing);
}

/** 伏図の柱タップ（自階柱□をタップして構造リストの共通カードを開く。ステップ4「柱は共通と個別指定の
 *  2層」）を有効にするか。梁タップ（pickMembersOnFigure）が有効な主構造（在来木造のみ）で、かつ
 *  柱一覧の供給元が自階柱□（columnListCategory）のときだけ true。下階柱×は対象外
 *  （renderer/StructuralLayer.jsx が category==='columnMapSelf' のグループにだけこの結果を渡す）。 */
export function pickColumnsOnFigure(drawing) {
  return pickMembersOnFigure(drawing) && columnListCategory(drawing) === 'columnMapSelf';
}

/** 柱の断面外形寸法(mm)。カタログ未登録は COLUMN_FALLBACK_SIZE_MM 角にフォールバックする。 */
export function columnSectionSize(column) {
  const sec = findSectionEntry(column.sectionDefId);
  return { width: sec?.width ?? COLUMN_FALLBACK_SIZE_MM, height: sec?.height ?? COLUMN_FALLBACK_SIZE_MM };
}

/** 柱の実描画サイズ(mm)。LODに依らず常にsectionDefIdのカタログ実寸（矩形等で幅・高さが異なる場合は
 *  大きい方、カタログ未登録はCOLUMN_FALLBACK_SIZE_MM）。renderer/StructuralLayer.jsx・
 *  renderer/MemberTagLayer.jsxの両方がこれだけを参照する単一の実装——柱記号の対角線が使う辺長と
 *  タグのマージン・柱タップの当たり判定幅（hitStrokeWidth）が同じ辺長を見るようにするため
 *  （QA指摘・ステップ4: node:testから直接importして検証できるよう、react-konvaを持たない
 *  この純モジュール側に置く。renderer/StructuralLayer.jsxは本関数を re-export するだけ）。 */
export function columnRenderSize(column) {
  const { width, height } = columnSectionSize(column);
  return Math.max(width, height);
}

/** 下階柱の×が断面□からはみ出す比率（半幅・半成に掛ける倍率。1 なら×の端点は□の4隅ちょうど）。
 *  ユーザー裁定2026-09-16「×をもう少し大きくして当該階柱□からでっぱるように」——同じ位置に自階柱□が
 *  重なると×が□の輪郭に埋もれて下階柱の有無が読めないため、□の外まで対角線を延ばす。 */
export const COLUMN_CROSS_OVERHANG_RATIO = 1.5;

/** 柱の断面に乗せる対角線2本（×）のローカル座標（中心原点）。柱の rotation を持つ親 Group の中で使う想定。
 *  返り値は Konva Line 2本ぶんの points 配列 [[x1,y1,x2,y2], [x1,y1,x2,y2]]。
 *  端点は□の4隅を overhangRatio 倍（既定 COLUMN_CROSS_OVERHANG_RATIO）に延ばした位置＝□の外へ出る。 */
export function columnCrossPointsLocal(width, height, overhangRatio = COLUMN_CROSS_OVERHANG_RATIO) {
  const hw = width / 2 * overhangRatio, hh = height / 2 * overhangRatio;
  return [
    [-hw, -hh, hw, hh],
    [-hw, hh, hw, -hh],
  ];
}

/** 基礎伏図の土台帯（bandLines へ渡す half・線幅キー）を主構造ルール（foundationRules）から解決する。
 *  half は foundationRules.sillWidthMm の半分（帯の全幅=sillWidthMm）、線幅は常に'medium'（LINE_WEIGHT_MM
 *  のキー）。structureRules.js の値を StructuralLayer.jsx が直接算出しない単一の入口
 *  ——woodFoundationBands が bandLines へ渡す値と食い違わせないため。 */
export function sillBandSpec(foundationRules) {
  return { half: foundationRules.sillWidthMm / 2, weight: 'medium' };
}

// ---- 非正角材（成≠幅の梁）の標記（在来木造の伏図。ユーザー裁定2026-09-16。設計意図は
// .claude/structural-model.md ステップ4 第2単位）----
// 梁線の端部から梁内側に45度の単線を両端から2本、梁幅の2倍（トリム量）だけ内側で、梁幅の2.5倍
// （離れ）だけ軸から離れた平行線1本に着地させる。離れ・トリムは梁幅wにのみ依存し梁成hによらない。
// 梁幅×梁成の文字は平行線の中点に置く（配置props自体はrenderer/MemberTagLayer.jsx axisTagsの規約
// ＝offsetX=推定幅/2・offsetY=fontSizeを流用し、ここではワールド座標のx/y/rotation/textだけ返す）。
const BEAM_DEPTH_MARK_TRIM_W     = 2;   // 端からのトリム量・45度線の軸方向投影＝2w
const BEAM_DEPTH_MARK_OFFSET_W   = 2.5; // 平行線の軸からの離れ＝2.5w
const BEAM_DEPTH_MARK_MIN_SPAN_W = 4;   // スパンが4w以下（4w超のときだけ描く）

// (along, across) → ワールド座標。isVertical=true の梁は軸がx方向固定（across=x, along=y）。
function beamDepthMarkPoint(along, across, isVertical) {
  return isVertical ? { x: across, y: along } : { x: along, y: across };
}

// 標記を描く側（+1/-1）。beam と同じ向き（isVertical一致）でスパンが重なる他の梁の位置関係から選ぶ。
// 対称化（2026-09-16裁定）: 片側にしか他梁が無くても、その梁が2.5w以内に近ければ反対側（空いている側）
// へ出す——「隣の梁の標記と重ならない」ことを常に優先する。+側にだけ他梁があり2.5w超なら+1、2.5w以内
// なら−1（反対側は空いているため）。−側も対称に同じ規律。両側にあれば既定+1（ただし+側の最近傍が
// 2.5w以内なら−1）。どちらにも無ければ+1。
function chooseBeamDepthMarkSide(beam, w, lo, hi, others) {
  const overlapsSpan = o => {
    const oLo = Math.min(o.coord1, o.coord2), oHi = Math.max(o.coord1, o.coord2);
    return oLo < hi && oHi > lo;
  };
  const neighbors = others.filter(o => o.id !== beam.id && o.isVertical === beam.isVertical && overlapsSpan(o));
  const plus  = neighbors.filter(o => o.axisValue > beam.axisValue);
  const minus = neighbors.filter(o => o.axisValue < beam.axisValue);
  const threshold = BEAM_DEPTH_MARK_OFFSET_W * w;
  const nearestPlusDist  = plus.length  > 0 ? Math.min(...plus.map(o => o.axisValue - beam.axisValue)) : Infinity;
  const nearestMinusDist = minus.length > 0 ? Math.min(...minus.map(o => beam.axisValue - o.axisValue)) : Infinity;
  if (plus.length > 0 && minus.length === 0) return nearestPlusDist <= threshold ? -1 : 1;
  if (minus.length > 0 && plus.length === 0) return nearestMinusDist <= threshold ? 1 : -1;
  if (plus.length === 0 && minus.length === 0) return 1;
  return nearestPlusDist <= threshold ? -1 : 1;
}

/**
 * 非正角材（成≠幅）の梁の標記を解決する。drawing.beamDepthMark!=='offsetLine'（既定 'none'。非在来）
 * または lod===SCHEMATIC は常に空配列。beams は柱手前でトリム済みの描画スパン
 * （[{id,isVertical,axisValue,coord1,coord2,sectionDefId,role,materialType}]）。
 * 対象は「カタログで引けて成≠幅・role!=='foundation'・スパンが4w超」の梁のみ。
 * @returns {{id, materialType, parallel:number[], slopes:number[][], label:{x,y,rotation,text}}[]}
 */
export function beamDepthMarks(drawing, lod, beams) {
  if (drawing?.beamDepthMark !== 'offsetLine' || lod === LodLevel.SCHEMATIC) return [];
  const marks = [];
  for (const beam of beams ?? []) {
    const sec = findSectionEntry(beam.sectionDefId);
    if (!sec || sec.width === sec.height || beam.role === 'foundation') continue;
    const w = sec.width, h = sec.height;
    const lo = Math.min(beam.coord1, beam.coord2), hi = Math.max(beam.coord1, beam.coord2);
    if (hi - lo <= BEAM_DEPTH_MARK_MIN_SPAN_W * w) continue;
    const s = chooseBeamDepthMarkSide(beam, w, lo, hi, beams);
    const edge     = beam.axisValue + s * w / 2;
    const parallel = beam.axisValue + s * BEAM_DEPTH_MARK_OFFSET_W * w;
    const trim     = BEAM_DEPTH_MARK_TRIM_W * w;
    const p1 = beamDepthMarkPoint(lo + trim, parallel, beam.isVertical);
    const p2 = beamDepthMarkPoint(hi - trim, parallel, beam.isVertical);
    const loEdge = beamDepthMarkPoint(lo, edge, beam.isVertical);
    const loPar  = beamDepthMarkPoint(lo + trim, parallel, beam.isVertical);
    const hiEdge = beamDepthMarkPoint(hi, edge, beam.isVertical);
    const hiPar  = beamDepthMarkPoint(hi - trim, parallel, beam.isVertical);
    const mid = beamDepthMarkPoint((lo + hi) / 2, parallel, beam.isVertical);
    marks.push({
      id: beam.id,
      materialType: beam.materialType,
      parallel: [p1.x, p1.y, p2.x, p2.y],
      slopes: [[loEdge.x, loEdge.y, loPar.x, loPar.y], [hiEdge.x, hiEdge.y, hiPar.x, hiPar.y]],
      label: { x: mid.x, y: mid.y, rotation: beam.isVertical ? -90 : 0, text: `${w}×${h}` },
    });
  }
  return marks;
}
