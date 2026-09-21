// structuralOrchestration.test.js と structuralOrchestration.interference.test.js が共有する
// テスト用フィクスチャ・ダンプヘルパ（構造再計算の高速化・B-7是正・2026-09-21）。
//
// 両ファイルが同じ内容のヘルパ（addDefaultDimensionLines・buildWoodFloorForB1・buildCLResolver・
// normalizeStructEntity・allFieldsDumpForGraph・dumpB1AllFloorsAllFields）を複製していたため、
// ここへ集約して import で共有する（内容の乖離を防ぐ）。*.test.js という名前にすると node:test に
// テストファイルとして拾われてしまうため、あえてこの名前にしている（eslint の対象には通常どおり含まれる）。
//
// fake IndexedDB の仕組みは各テストファイル側に残したまま——structuralOrchestration.test.js の
// withFakeIndexedDB（testごとにnew FakeDBし直す）と structuralOrchestration.interference.test.js の
// モジュールレベルfakeDb（storage/db.jsの_dbPromiseキャッシュ対策で1個だけ生成し使い回す）は
// 性質が違うため、無理に統合しない（各ファイルのコメント参照）。
import {
  Discipline,
  HDimensionLine, VDimensionLine, DimensionKind, DimensionSide,
} from '../core.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { serializeGraph } from '../graphSnapshot.js';
import { decode } from '../schema/graphFbs.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';

// 実運用のフロアは store.js の addFloor が GRID/CENTER×4周の寸法線を常設で持たせる
// （applySnapshot が復元後に欠けている行だけ補完する仕様＝グラフ側になければ復元時に新規追加される）。
// テストのfixtureがこれを省くと、save→peekやundoのrestoreGraphの初回だけ寸法線が新規追加され、
// 「復元後は変化しない」はずの比較（byte比較や突入2回目の収束確認）が寸法線の有無だけで
// 意図せず揺れる。本番のフロア生成と同じに揃えるためここでも追加する。
export function addDefaultDimensionLines(graph) {
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.TOP });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.BOTTOM });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.LEFT });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.RIGHT });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.TOP });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.BOTTOM });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.LEFT });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.RIGHT });
}

// 在来木造の1フロアを追加する（gridCLsで指定した矩形1室・その外周壁）。全floorで共有する
// 4本のCL（gx0/gx1/gy0/gy1）は呼び出し側が project.structGraph へ1回だけ生成し、ここへ渡す
// （【QA第2巡Major-1是正】通り芯は階固有の graph.addCenterLine ではなく project.structGraph に
// 置く必要がある——壁のCL参照（axisCLId等）がsaveFloor→本番peek（floorSwapManager.peek）の
// restoreGraphで解決できず、壁が復元後に消える落とし穴があるため）。
export function buildWoodFloorForB1(project, elevation, name, id, gridCLs) {
  const { graph } = project.addPlane(elevation, name, id);
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  addDefaultDimensionLines(graph);
  const { gx0, gx1, gy0, gy1 } = gridCLs;
  const room = graph.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(graph, room);
  return graph;
}

// ==== 全フィールド意味ダンプ（コーディネーター差し戻し・2026-09-21。Minor 1是正で追記）====
// decode(serializeGraph(g))が返す「保存されたバイト列を復元した」全フィールドをそのまま比較する。
// 【Minor 1是正】「decode()そのもの——手で列挙し直さないため漏れない」は事実と異なる（decode()は
// walls/rooms/openings/dimensionLines等、構造再計算（反映処理の経路）が一切書かないフィールドも
// 多数含む——これらまで比較対象にすると無関係な差分でA/Bテストが揺れる）。実際にはdecode()の返す
// キーのうち、構造再計算が書きうるグループを手で列挙している（columns/beams/footings/slabs・
// 除外集合4種・columnAxisOffsets・centerLines(FUSE discipline限定)・clEccentricities・
// structureOverride・woodColumnWidthMmの計13グループ）。
// id・配列順は除く。ただしCL参照（verticalCLId/horizontalCLId/axisCLId/clStartId/clEndId/clId・
// 除外集合4種のキー文字列に埋め込まれたCL id・columnAxisOffsetsのキー＝CL id自体・slabs.cellsの
// 複合キー）は、fixture構築のたびcrypto.randomUUID()で毎回変わる生idのため、raw idのまま比較すると
// （同一内容でも）常に不一致になる——「型:丸めた実効値」（resolveCL）へ解決してから比較する
// （resolveCLは対象graphのg.centerLines＝floor-local CL＋project.structGraphのマージ済みライブCLから
// 解決する。同一ドキュメントを2回ロードするためid自体が一致する、という前提には依存できない
// ——fixtureを2回呼ぶたび毎回新しいidを振るため、CL参照だけはid比較ではなく値比較へ切り替える）。
// 梁芯CL（discipline:FUSE。壁由来の通り芯）自体はtype・effectiveValue・extentの多重集合として
// 別途含める（除外集合・columnAxisOffsetsの「解決先」であると同時に、生成漏れ・extentずれを
// 直接検出する対象でもあるため）。
const UUID_RE_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// CL参照フィールド（raw id→ `type:値` へ解決する対象キー）。id自体は意味を持たないため、
// 解決できたCLの「型+丸めた実効値」に置き換えて比較する（解決できなければ`?${id}`のまま残し、
// 参照切れ自体を検出できるようにする）。clIdはclEccentricitiesのCL参照（Minor 1是正で追加）。
const CL_REF_FIELD_KEYS = new Set(['verticalCLId', 'horizontalCLId', 'axisCLId', 'clStartId', 'clEndId', 'clId']);

export function buildCLResolver(g) {
  const clById = new Map(g.centerLines.map(cl => [cl.id, cl]));
  const resolveId = (id) => {
    if (id == null) return 'null';
    const cl = clById.get(id);
    return cl ? `${cl.centerLineType}:${Math.round(cl.effectiveValue)}` : `?${id}`;
  };
  // 除外集合4種のキー文字列（columnSlotKey `${vCL.id}:${hCL.id}`／spanKey `${axisCL.id}:${clA.id}:${clB.id}`
  // （sillは`sill:`前置）／slabs.cellsの複合キー）に埋め込まれたCL id（UUID形式）だけを置換する
  // （jamb:${openingId}:${side}・off:${axisX}:${axisY}・wallBeamAxisExcludeKey `${'X'|'Y'}:${coord}` は
  // CL idを含まないためそのまま残る——openingIdがUUID形式でも本フィクスチャに建具は無いため無害）。
  const resolveComposite = (s) => s.replace(UUID_RE_GLOBAL, (id) => {
    const cl = clById.get(id);
    return cl ? `${cl.centerLineType}:${Math.round(cl.effectiveValue)}` : id;
  });
  return { resolveId, resolveComposite };
}

// 柱・梁・基礎の1件をid非依存の文字列へ正規化する（decode済みの生オブジェクトを渡す）。
// extraKeys/extraVals（packExtraFields方式）はkey=val文字列へ展開して比較する。
export function normalizeStructEntity(v, resolver) {
  const parts = [];
  for (const k of Object.keys(v).sort()) {
    if (k === 'id' || k === 'extraKeys' || k === 'extraVals') continue;
    if (CL_REF_FIELD_KEYS.has(k)) {
      parts.push(`${k}=${v[k] == null ? 'null' : resolver.resolveId(v[k])}`);
    } else {
      parts.push(`${k}=${JSON.stringify(v[k])}`);
    }
  }
  if (Array.isArray(v.extraKeys)) {
    v.extraKeys.forEach((k, i) => parts.push(`extra.${k}=${v.extraVals[i]}`));
  }
  return parts.join('|');
}

// 1階分のグラフを全フィールド意味ダンプへ変換する（decode(serializeGraph(g)) + CL参照の値解決）。
export function allFieldsDumpForGraph(g) {
  const snap = decode(serializeGraph(g));
  const resolver = buildCLResolver(g);
  const columns = snap.columns.map(c => normalizeStructEntity(c, resolver)).sort();
  const beams = snap.beams.map(b => normalizeStructEntity(b, resolver)).sort();
  const footings = snap.footings.map(f => normalizeStructEntity(f, resolver)).sort();
  const slabs = snap.slabs.map(s => {
    const parts = [];
    for (const k of Object.keys(s).sort()) {
      if (k === 'id' || k === 'extraKeys' || k === 'extraVals' || k === 'cells') continue;
      parts.push(`${k}=${JSON.stringify(s[k])}`);
    }
    parts.push(`cells=${JSON.stringify([...s.cells].map(resolver.resolveComposite).sort())}`);
    if (Array.isArray(s.extraKeys)) s.extraKeys.forEach((k, i) => parts.push(`extra.${k}=${s.extraVals[i]}`));
    return parts.join('|');
  }).sort();
  const excludedColumnSlots  = snap.excludedColumnSlots.map(resolver.resolveComposite).sort();
  const excludedBeamSlots    = snap.excludedBeamSlots.map(resolver.resolveComposite).sort();
  const excludedFootingSlots = snap.excludedFootingSlots.map(resolver.resolveComposite).sort();
  const excludedWallBeamAxes = snap.excludedWallBeamAxes.map(resolver.resolveComposite).sort();
  const columnAxisOffsets = snap.columnAxisOffsetKeys
    .map((clId, i) => `${resolver.resolveId(clId)}=${snap.columnAxisOffsetVals[i]}`)
    .sort();
  // 梁芯CL（discipline:FUSE）自体。ライブのg.centerLinesから直接取る——decode済みcenterLines.valueは
  // refId連鎖を解決していない生の値のため、effectiveValue（連鎖解決済み）が要るここではライブ値を使う。
  const fuseCLs = g.centerLines
    .filter(cl => cl.discipline === Discipline.FUSE)
    .map(cl => `${cl.centerLineType}:${Math.round(cl.effectiveValue)}:` +
      `${cl.extentLo == null ? 'null' : Math.round(cl.extentLo)}..${cl.extentHi == null ? 'null' : Math.round(cl.extentHi)}`)
    .sort();
  // 【Minor 1是正・2026-09-21】clEccentricities（CL偏心。clIdはCL参照のためnormalizeStructEntity経由で
  // 値解決する）・structureOverride・woodColumnWidthMm（ともにCL参照を含まないスカラー）を追加する。
  const clEccentricities = snap.clEccentricities.map(e => normalizeStructEntity(e, resolver)).sort();
  const structureOverride = snap.structureOverride ?? 'null';
  const woodColumnWidthMm = snap.woodColumnWidthMm ?? 'null';
  return {
    columns, beams, footings, slabs, excludedColumnSlots, excludedBeamSlots, excludedFootingSlots, excludedWallBeamAxes,
    columnAxisOffsets, fuseCLs, clEccentricities, structureOverride, woodColumnWidthMm,
  };
}

// アクティブ階はメモリ（project.activeGraph）を直接読み、非アクティブ階だけ実peekで読む
// （実運用と同じ——アクティブ階のauto-saveは確定保存されるまでdirty印だけのため）。
// 屋根専用平面（project.roofPlane）が有れば併せて含める。
export async function dumpB1AllFloorsAllFields(project) {
  const out = {};
  for (const p of [...project.planes, project.roofPlane].filter(Boolean)) {
    const g = p.id === project.activePlaneId ? project.activeGraph : await floorSwapManager.peek(p, project.structGraph);
    out[p.name] = allFieldsDumpForGraph(g);
  }
  return out;
}
