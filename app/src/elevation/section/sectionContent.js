/**
 * 2.5D断面エンジン: 「1つの切断 → 壁断面・見えがかり・アキのcontent」の**共通経路**。
 *
 * 階段帯（`elevationStairSequence.js`）と吹抜けの多層帯（`elevationVoid.js`）は、どちらも
 * 「切断を1本立てて断面エンジンへ渡す」処理なのに、**別々に手で組み立てていた**——その結果、
 * 階段帯にはある処理が吹抜け帯には無い、という差が静かに溜まった（探査延長・端の凹み側面線の
 * 抑制・アキのバツが吹抜け帯には無かった）。ユーザー指摘「「6」は正しく「5」は誤った出力」の
 * 直接の原因であり、「修正が他の図面にも効くか判定できない」という問題の温床でもある。
 *
 * ここを唯一の入口にすることで、**この関数へ足した修正は階段にも吹抜けにも同時に効く**。
 * タイプ固有の処理（階段のささら・遮蔽、構造材の加算レイヤ）は呼び出し側が返り値の部品
 * （`columns`/`wallPrims`/`gapMarks`）に対して後段で行う——共通経路にタイプ固有の分岐を
 * 持ち込まない、が本モジュールの境界。
 *
 * 純モジュール（store.js/snap.js/*.jsx/react-konva/appViewport.jsを静的importしない）。
 */
import { buildColumns } from './sectionEngine.js';
import { emitColumns, emitOpenGapMarks } from './sectionEmit.js';
import { wallWorldRangesOnFacePlane, planeOverhangBeyondEnds } from './sectionCutPlane.js';
import { hasCutWallStandingOn } from './sectionTypes.js';
import { UPPER_PLANE_OVERHANG_LIMIT_MM, GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';
import { wallLessEndAt } from '../elevationFaces.js';
import { makeProbeContext } from './sectionProbe.js';

/**
 * 端区間の高さ（cutローカルx＝面ローカルxの0側／run側）を区分プロファイルから取り出す。
 * プロファイルが無ければnull（＝gate素通り。階段帯は`ceilProfile`を渡さない＝従来どおり
 * 全端ではり出しを許す）。
 * 図側（`elevationVoid.js`のはり出し量）も**この関数で**端の高さを取る——探査側のgateと
 * 図側のgateが同じ1つの式を読むための共有（別々に書くと段差床の区間で静かに食い違う）。
 * @param {Array<{loX:number, hiX:number}>|undefined} prof
 * @param {(seg:object)=>number} zOf
 * @returns {{atLocal0:number, atLocalRun:number}|null}
 */
export function endZOf(prof, zOf) {
  if (!Array.isArray(prof) || prof.length === 0) return null;
  let first = prof[0], last = prof[0];
  for (const s of prof) {
    if (s.loX < first.loX) first = s;
    if (s.hiX > last.hiX) last = s;
  }
  return { atLocal0: zOf(first), atLocalRun: zOf(last) };
}

/**
 * **その層の平面が、その面の端より外へ続いている量**（面ローカルmm。両端ぶん）。
 *
 * 探査側（`layerRunWindowsOf`→`cut.layerRunWindows`）と図側（`elevationBand.js`の描画範囲・
 * `elevationFigure.js`のはり出し）が**同じ1本の式**を読むための単一実装——別々に書くと、
 * content（壁エッジ）だけが出て閉じる線が無い、といった食い違いが静かに生まれる。
 *
 * 3つの条件をすべて満たした端だけ0でない値を返す:
 *   (1) その端に壁がある（壁のない端の外は体裁のはり出しの領域）
 *   (2) **その層の空間がその端で見えている**（gate。`endBandZ`。null＝素通り）
 *   (3) はり出し量が`UPPER_PLANE_OVERHANG_LIMIT_MM`以下（超えたら**全か無か**で0）
 *
 * gate(2)は上下対称に書く——上階の層なら「その端の帯の**天井**断面が、その層の**床**より上」、
 * 下階の層なら「その端の帯の**床**断面が、その層の**天井**より下」。どちらも
 * 「帯のその端が、その層の空間へ開いているか」の1つの問いで、`towardLayer`（帯からその層へ
 * 向かう向き。+1=上・-1=下）で符号を切り替えるだけになる。gateが無いと、その層へ開いて
 * いない端で層の平面だけが外へ伸び、閉じる線の無い突起になる。
 * @param {object} face - 帯の面（lo/hi/dirSign/hasWallAtLocal0/Run/axisCL/isVertical）
 * @param {object} layerGraph - その層のgraph
 * @param {{towardLayer?:1|-1, layerBoundaryZ:number,
 *   endBandZ:{atLocal0:number, atLocalRun:number}|null}} gate
 *   towardLayer … 帯からその層へ向かう向き（+1=上階・-1=下階。既定+1）
 *   layerBoundaryZ … その層の帯側の境界z（上階＝その層のFL・下階＝その層の天井）
 *   endBandZ … 面ローカルの端区間の、その層側の帯の境界z（上階＝天井断面・下階＝床断面）。
 *     null＝gate素通り。いずれも帯のFL基準z。
 * @returns {{lo:number, hi:number}} 面ローカル（lo＝ローカルx=0側、hi＝run側）
 */
export function planeOverhangForFace(face, layerGraph, { towardLayer = 1, layerBoundaryZ, endBandZ }) {
  if (!face || !layerGraph) return { lo: 0, hi: 0 };
  const world = planeOverhangBeyondEnds(
    wallWorldRangesOnFacePlane(face, layerGraph), { lo: face.lo, hi: face.hi });
  // world lo/hi ↔ 面ローカル 0/run（dirSign>0ならworldのlo側がローカルx=0側）。
  const local = face.dirSign > 0
    ? { lo: world.lo, hi: world.hi }
    : { lo: world.hi, hi: world.lo };
  const openTo = z => !endBandZ || !Number.isFinite(layerBoundaryZ)
    || (z - layerBoundaryZ) * towardLayer > GAP_EPS;
  // QA是正2026-09（§5.12 D2-1是正・項目4）: gateは単一情報源`wallLessEndAt`（elevationFaces.js）
  // の否定——「真に壁のない端部」だけで閉じる。wallFilterで「この帯では数えない」と除外された
  // 壁（hasWall=false だがhiddenWall=true＝wallLessEndAt=false）は、物理的には実在するため、
  // 上階の平面がそこにあるかを探査してよい（実データ「6」D2: 2a壁の除外でhasWallAtLocal0が
  // falseになった端でも、2階床のはり出しは描かれるべき）。真に壁が無い一般の壁のない端部
  // （wallLessEndAt=true）だけ従来どおりgateを閉じる。
  const allow = (v, wallLess, gateOk) =>
    (!wallLess && gateOk && v <= UPPER_PLANE_OVERHANG_LIMIT_MM ? v : 0);
  return {
    lo: allow(local.lo, wallLessEndAt(face, '0'), openTo(endBandZ?.atLocal0)),
    hi: allow(local.hi, wallLessEndAt(face, 'Run'), openTo(endBandZ?.atLocalRun)),
  };
}

/**
 * 層ごとの探査窓（世界座標。`cut.layerRunWindows`）。
 *
 * **面の端は層ごとに違う**（ユーザー実機指摘2026-09「「6」D2: 2階Y2から3500には「21」の
 * 壁エッジが左側に見える」）——自階の面は自階の壁で終わるが、同じ通りの上階の壁はその先へ
 * 続きうる。自階の窓は従来の探査範囲そのまま（＝出力不変）、自階以外の層だけ、その層の平面が
 * 面の端より外へ続いている量だけ窓を広げる。
 *
 * 広げるのは**壁のある端の側だけ**——壁のない端（`openLo/openHi`）の外側は既に体裁のはり出し
 * （`endExtendMm`）の領域で、そこに層ごとの平面照合を足す意味がない。
 * さらに**その層の空間がその端で見えている端だけ**（gate。`planeOverhangForFace`）——
 * 上部吹抜けを持つ部屋帯では、吹抜けが面の端に達していない端で上階の平面だけ外へ伸ばすと、
 * 閉じる線が無いまま天井断面線だけが半壁厚ぶん飛び出す。下階を積む吹抜け帯はその鏡像で、
 * 帯の**床**断面が下階の**天井**より下にある端（＝下階の空間がそこで見えている端）だけ。
 * gateの材料は区分プロファイル（上階＝`ceilProfile`・下階＝`floorZProfile`）で、渡さない帯
 * （階段帯）はgate素通り＝従来どおり。
 * 自階の判定に`layer.role === 'self'`を使う（配列順には依存しない。`sectionLayerStack.js`が
 * 戒める「role名で層を引く」は**層スタックの順序・所有の判断**についての戒めで、ここは
 * 「呼び出し側が自分の階として渡した層はどれか」という出自の情報そのもの）。上下の判別は
 * roleではなく**自階の層とのfloorZMmの大小**で行う（値そのものの比較なので取り違えようがない）。
 * @param {import('./sectionTypes.js').SectionCut} cut - probeExtend付与後のline
 * @returns {Map<object,{lo:number,hi:number}>|null}
 */
function layerRunWindowsOf(cut) {
  const line = cut.line;
  const layers = cut.layers ?? [];
  if (!cut.face || layers.length < 2) return null;
  const selfLo = line.lo - (line.probeExtendLoMm ?? 0);
  const selfHi = line.hi + (line.probeExtendHiMm ?? 0);
  const endCeilZ = endZOf(cut.ceilProfile, s => s.ceilZ);
  const endFloorZ = endZOf(cut.floorZProfile, s => s.floorZ);
  const selfFloorZ = layers.find(l => l?.role === 'self')?.floorZMm ?? 0;
  // QA是正2026-09（§5.12 D2-1是正・項目1/4）: 他層の窓の基準点は単一情報源`wallLessEndAt`
  // （elevationFaces.js）で選ぶ——**真に壁のない端部**（wallLessEndAt=true）だけ
  // `selfLo/Hi`（probeExtendLoMm/HiMm込み。壁のない端部の体裁のはり出し＝extendMm=150ぶん
  // 既に外側へ動いている）を基準にし、wallFilterで除外された実壁がある端
  // （hasWallAtLocal0/Run=falseだがwallLessEndAt=false）は**面自身の真の境界（line.lo/hi）**
  // に戻す——selfLo/Hiを基準にplaneOverhangForFaceの測定量（face.lo/hiからの距離）を足すと、
  // 実壁の位置を150mm近く通り過ぎて二重に外側へずれる（実測: 実データ「6」D2で2F床の小口が
  // 57.5→207.5へ広がっていた根本原因）。
  const worldLoIsWallLess = cut.dirSign > 0 ? wallLessEndAt(cut.face, '0') : wallLessEndAt(cut.face, 'Run');
  const worldHiIsWallLess = cut.dirSign > 0 ? wallLessEndAt(cut.face, 'Run') : wallLessEndAt(cut.face, '0');
  const baseLo = worldLoIsWallLess ? selfLo : line.lo;
  const baseHi = worldHiIsWallLess ? selfHi : line.hi;
  const windows = new Map();
  for (const layer of layers) {
    if (layer?.role === 'self' || !layer?.graph) { windows.set(layer, { lo: selfLo, hi: selfHi }); continue; }
    // 壁のない端・gate・上限はすべて`planeOverhangForFace`が面ローカルで判断する。ここは
    // 面ローカル→世界へ写すだけ（dirSign>0ならローカルx=0側がworldのlo側）。
    const below = layer.floorZMm < selfFloorZ - GAP_EPS;
    const local = planeOverhangForFace(cut.face, layer.graph, below
      // 下階の層: 帯の床断面 vs その層の天井（`ceilZMm`。呼び出し側が層へ載せる。無ければ素通り）。
      ? { towardLayer: -1, layerBoundaryZ: layer.ceilZMm, endBandZ: endFloorZ }
      : { towardLayer: 1, layerBoundaryZ: layer.floorZMm, endBandZ: endCeilZ });
    const world = cut.dirSign > 0 ? { lo: local.lo, hi: local.hi } : { lo: local.hi, hi: local.lo };
    windows.set(layer, { lo: baseLo - world.lo, hi: baseHi + world.hi });
  }
  return windows;
}

/**
 * 壁のない端部の探査延長と、帯の部屋の包絡矩形を載せた cut を作る。
 *
 * 「壁のない端部で線を図の外へ延ばす」のはプリミティブを後から引き伸ばすのではなく
 * **探査範囲そのものを外へ広げる**（ユーザー裁定2026-08 A案。`sectionEmit.js`冒頭参照）——
 * 面の外の列も実データとして生成されるため、延長ぶんの線が通常の帯の縁として自然に出る。
 * `bandRoomBounds`は見えがかり壁の探索を帯自身の部屋の広がりに限るため（`sectionProbe.js`の
 * `withinViewRoom`）。レイキャストだけでなく構造材の判定でも使う。
 * `upperPlaneOverhang`（既定false＝現行と完全同一）を指定すると、これに加えて**層ごとの探査窓**
 * （`layerRunWindows`。上記`layerRunWindowsOf`）を載せる。既定offなのは、面の外を落とす経路が
 * 帯ごとに違う（部屋帯・吹抜け帯の主content＝`clipContentToFace`、吹抜けの上階content＝
 * クリップ無し）ため——広げてよいのは面の外まで自分で描き切る帯だけ。オプトイン済みなのは
 * 階段帯（`elevationStairSequence.js`）と吹抜け帯（`elevationVoid.js`の両ビルダー）で、
 * 既定offのまま残るのは面の外を自分で描き切らない帯があるため。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} endExtendMm
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} [bandRoomBounds]
 * @param {{upperPlaneOverhang?:boolean}} [opts]
 * @returns {import('./sectionTypes.js').SectionCut}
 */
export function withProbeExtension(cut, endExtendMm, bandRoomBounds = null, opts = {}) {
  // QA是正2026-09（§5.12 D2-1是正・第2ラウンド項目5）: 探査は広げる・描画は締める。
  // ここは`hasWallAtLocal0/Run===false`のまま（`wallLessEndAt`へ置換しないこと）——wallFilterで
  // 除外された実壁がある端（hiddenWallAtLocal0/Run=true）も含めて従来どおり探査窓を広げる。
  // 探査まで`wallLessEndAt`で締めると、その壁を手掛かりにする既存描画（`recessLo`等）が
  // 列ごと消える（実測で確認済み）。「描画だけ締める」側は`elevationStairSequence.js`の
  // `clipContentAtHiddenEnds`・`elevationFigure.js`の`drawnX0/Run`・`elevationBand.js`の
  // `faceDrawnXRange`が担当する。
  // 展開図一般化Phase 8: `cut.ends`（面非依存の入口`buildSectionFromLine`が唯一の生成元）が
  // あればそちらを読む——値は`cut.face`から導出した場合と同一（`hasWallAtLocal0/Run===false`）。
  // `ends`の無い手組みcut（既存の階段cut表・単体テスト）はこれまでどおり`cut.face`から導出する。
  const openLo = cut.ends ? cut.ends.openLo : cut.face?.hasWallAtLocal0 === false;
  const openHi = cut.ends ? cut.ends.openHi : cut.face?.hasWallAtLocalRun === false;
  const localLoIsWorldLo = cut.dirSign > 0;
  const extend = !!endExtendMm && (openLo || openHi);
  const extended = { ...cut, bandRoomBounds, line: !extend ? cut.line : { ...cut.line,
    probeExtendLoMm: (localLoIsWorldLo ? openLo : openHi) ? endExtendMm : 0,
    probeExtendHiMm: (localLoIsWorldLo ? openHi : openLo) ? endExtendMm : 0 } };
  if (!opts.upperPlaneOverhang) return extended;
  const windows = layerRunWindowsOf(extended);
  if (!windows) return extended;
  // 探査の実範囲（`sectionProbe.js`の`cutProbeRange`）は全層の窓の和。`probeExtendLo/HiMm`は
  // **書き換えない**——あちらは「面の外へ体裁として伸ばす量」で、`cutDrawRange`（梁・ささらを
  // 面の外に描かないための判定）の情報源だから。層ごとの窓は探査だけを広げる。
  const wins = [...windows.values()];
  const unionLo = Math.min(...wins.map(w => w.lo));
  const unionHi = Math.max(...wins.map(w => w.hi));
  return { ...extended, layerRunWindows: windows, line: { ...extended.line,
    unionExtendLoMm: extended.line.lo - unionLo, unionExtendHiMm: unionHi - extended.line.hi } };
}

/**
 * はり出し区間の**外端に立つ切断壁（上階の腰壁）の向こう側の面**（面ローカルx。端ごと。
 * 切断壁が立っていない端は null）。
 *
 * 上階FLの断面線は、はり出しの外端に切断壁が立つなら**その壁の向こう側の面から外へ**張り出して
 * 終わる（ユーザー裁定2026-09「「6」C・「5」A1: 2FL断面まで下りて外側に向かって張り出して
 * 終了、が正解」）——壁の下（CL〜向こう側の面）には引かない。既存規約「上階の床の断面線は
 * 境界に立つ切断壁の断面の中を通さない」（`sectionEmit.js`の`ceilStepSlabSection`）と同じ
 * 見方で、述語は`hasCutWallStandingOn`に一本化してある。
 *
 * 「切断壁か見えがかり壁か」は**列（`columns`）にしか無い**情報なので、図側
 * （`elevationFigure.js`の`upperFloorEdgeSpans`）へはこの関数の返り値を渡す——図側で壁を
 * 引き直すと、はり出し量と別々の情報源になる。実データ「6」D2の外端は全高の**見えがかり**壁で
 * 切断壁ではないため、ここは null を返す（従来どおり断面線ベースの描き方が残る）。
 * 列は面ローカルxの昇順（`sectionEngine.js`の`buildColumns`）なので、lo側＝先頭列の外縁x0・
 * hi側＝末尾列の外縁x1。
 *
 * **先頭列の外縁＝探査範囲の外端**であり、それが即ち「はり出しの外端」になる——体裁の延長
 * （`withProbeExtension`の`probeExtendLo/HiMm`）が付くのは**壁のない端だけ**で、そこには
 * 定義上、外端に立つ切断壁が無い。逆に切断壁が立つ端では体裁の延長が付かず、探査範囲は
 * はり出し（層ごとの窓）の外端で終わる。**両者は排他**なので、列の外縁を「はり出し外端」と
 * 読み替えてよい（外端でない列の外縁を切断壁の起点と誤読することはない）。
 * @param {import('./sectionTypes.js').SectionColumn[]|undefined} columns
 * @param {number|undefined} upperFloorZ - 上階のFL（帯のFL基準の絶対z）
 * @returns {{lo:number|null, hi:number|null}}
 */
export function upperFloorCutWallEndsOf(columns, upperFloorZ) {
  if (!columns?.length || !Number.isFinite(upperFloorZ)) return { lo: null, hi: null };
  const first = columns[0], last = columns[columns.length - 1];
  return {
    lo: hasCutWallStandingOn(first, upperFloorZ) ? first.x0 : null,
    hi: hasCutWallStandingOn(last, upperFloorZ) ? last.x1 : null,
  };
}

/**
 * `emitColumns`/`emitOpenGapMarks`へ渡す描画コンテキスト。
 * openEndLo/Hi: この面の端に壁が無い（壁面がその先へ続く）なら、描画範囲の端に凹み側面線
 * （`recessLo/Hi`）を出さない（ユーザー実機指摘2026-08「3500左CLにエッジはない」）——隣接列が
 * 無いことは「そこで壁が終わる」ことを意味せず、範囲外は単に未探査。
 *
 * QA是正2026-09（§5.12 D2-1是正・第2ラウンド項目4）: 単一情報源`wallLessEndAt`（真に壁の
 * ない端部か。elevationFaces.js）に統一した——旧`hasWallAtLocal0/Run===false`のままだと、
 * wallFilterで除外された実壁がある端（hiddenWallAtLocal0/Run=true）も「壁のない端部」として
 * `recessLo/Hi`を抑止してしまう（実壁はあるので抑止は誤り）。**置換の影響はHEAD基点diff
 * （13.stq/11.stq/knee-drop-test.stq、floorHeight分岐を含む全帯）で確認済み＝出力完全不変**
 * ——現時点の実データでは`recessLo/Hi`の抑止対象（`!prev`かつ面の端に一致する列）とhidden端の
 * 列が重なるケースが無いため。挙動が変わる可能性が今後あるため旧判定には戻さない。
 * `cut.face`のhasWallAtLocal0/Runがそのままローカルx=0/run側の端に対応する（cut.dirSignと
 * faceのdirSignは呼び出し側で揃えてある前提）。
 * 展開図一般化Phase 8: `cut.ends`（`buildSectionFromLine`が唯一の生成元）があればそちらを読む
 * （値は`cut.face`から`wallLessEndAt`で導出した場合と同一）。`ends`の無い手組みcutは従来どおり
 * `cut.face`から導出する。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {{ceilZ:number|undefined, openEndLo:boolean, openEndHi:boolean}}
 */
export function emitCtxForCut(cut) {
  return {
    ceilZ: cut.zRange?.hiZ,
    openEndLo: cut.ends ? cut.ends.wallLessLo : (cut.face ? wallLessEndAt(cut.face, '0') : false),
    openEndHi: cut.ends ? cut.ends.wallLessHi : (cut.face ? wallLessEndAt(cut.face, 'Run') : false),
  };
}

/**
 * 1つの切断 → 壁断面・見えがかり・アキ（タイプ非依存）。
 *
 * 呼び出し側が後段でタイプ固有の加工をできるよう、まとめた`content`だけでなく途中の部品も返す
 * （階段帯は`wallPrims`を階段の見付けで破線化し、`gapMarks`を階段で分割し、`columns`を
 * ささら・構造材の生成へ渡す）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} probeCtx
 * @param {{endExtendMm?:number, bandRoomBounds?:object|null, scale?:number,
 *   upperPlaneOverhang?:boolean}} [opts]
 * @returns {{cut:object, columns:object[], emitCtx:object,
 *   wallPrims:object[], gapMarks:object[], content:object[]}}
 *   cut … 探査延長・包絡矩形・層ごとの探査窓を載せた後の cut（後段の階段・構造材もこれを使う。
 *   図側のはり出し量`upperOverhang`もこの`layerRunWindows`から写す＝二重計算しない）。
 */
export function buildCutContent(cut, probeCtx, opts = {}) {
  const pcut = withProbeExtension(
    cut, opts.endExtendMm ?? 0, opts.bandRoomBounds ?? cut.bandRoomBounds ?? null,
    { upperPlaneOverhang: opts.upperPlaneOverhang },
  );
  const columns = buildColumns(pcut, probeCtx);
  // scale（px/mm）はアキ標記の省略判定に使う（sectionEmit.jsのemitOpenGapMarks）。
  const emitCtx = { ...emitCtxForCut(pcut), scale: opts.scale };
  const wallPrims = emitColumns(columns, pcut, emitCtx);
  const gapMarks = emitOpenGapMarks(columns, pcut, emitCtx);
  return { cut: pcut, columns, emitCtx, wallPrims, gapMarks, content: [...wallPrims, ...gapMarks] };
}

/**
 * **面非依存の入口**（展開図一般化Phase 8）。「1本の切断線 → 壁断面・見えがかり・アキの
 * content」を、帯（部屋帯・吹抜け帯）と階段cut表の両方が共有する薄いラッパとして提供する。
 * 返り値は`buildCutContent`と同型（`SectionFigure`は返さない——面配置・体裁はこの関数の外）。
 *
 * `face`は「面固有の値の供給元」に降格した——`viewSign`/`dirSign`/`zRange`等の面固有の値は
 * すべて呼び出し側が`opts`で渡す（このエンジンに`zRange`等を導出させると帯種別の`if`が生える
 * ため導出しない）。面述語（`ends`）の導出だけはここ1箇所に集約する。
 * face-lessで呼ぶ（`opts.ends`を渡し`opts.face`を省略する）と: `layerRunWindowsOf`（本ファイル。
 * `cut.face`必須のgate）は層ごとの窓を作らない——これは正しい縮退。ただし`sectionStructure.js:166`
 * の半壁厚許容は0に落ち、`:299`の`faceAxis`は`line.axisValue`にフォールバックする——「真の
 * 面非依存」ではなく、これらの副作用込みの縮退であることに注意（`ends`が面述語の単一導出源で
 * あることまでが本関数の保証で、`face`を読む他の消費側の縮退までは保証しない）。
 * @param {import('./sectionTypes.js').CutLine} line
 * @param {Array<{graph:object, floorZMm:number, role:string}>} layers - `sectionBandLayers.js`の`buildBandLayers`の返り
 * @param {{viewSign:1|-1, dirSign:1|-1, zRange:{loZ:number,hiZ:number}, probeCtx?:object,
 *   baseFloorZ?:number, ceilProfile?:object[], floorZProfile?:object[],
 *   aboveCeilVisibleRanges?:object[], stairCut?:object|null, airRoom?:object,
 *   underRooms?:Set<object>, bandRoomBounds?:object|null, chDimSplitAbsYs?:number[],
 *   seqNo?:string, endExtendMm?:number, upperPlaneOverhang?:boolean, scale?:number,
 *   face?:object, ends?:{openLo:boolean,openHi:boolean,wallLessLo:boolean,wallLessHi:boolean}}} [opts]
 *   - `opts.zRange`は必須（`opts`自体を省略した場合・`zRange`を省略した場合のいずれも、
 *   `baseFloorZ`の既定`zRange.loZ`の参照でTypeErrorになる。導出しない・フォールバックしない）。
 *   probeCtx（省略時のみ`makeProbeContext(layers)`を組む）… 帯経路は面ループの外で作った
 *   probeCtxを**必ず渡す**（毎面ごとに作り直すと空間索引の再構築で性能退行する）。
 *   ends（省略時）… `opts.face`から導出する（`openLo/Hi`＝`hasWallAtLocal0/Run===false`、
 *   `wallLessLo/Hi`＝`wallLessEndAt(face,'0'/'Run')`）。`face`も無ければ全て`false`
 *   （＝「持たない帯」と同じ挙動）。
 * @returns {{cut:object, columns:object[], emitCtx:object,
 *   wallPrims:object[], gapMarks:object[], content:object[]}}
 */
export function buildSectionFromLine(line, layers, opts = {}) {
  const face = opts.face;
  const ends = opts.ends ?? (face
    ? {
      openLo: face.hasWallAtLocal0 === false,
      openHi: face.hasWallAtLocalRun === false,
      wallLessLo: wallLessEndAt(face, '0'),
      wallLessHi: wallLessEndAt(face, 'Run'),
    }
    : { openLo: false, openHi: false, wallLessLo: false, wallLessHi: false });
  const { viewSign, dirSign, zRange } = opts;
  const cut = {
    seqNo: opts.seqNo, line, layers, viewSign, dirSign, zRange,
    baseFloorZ: opts.baseFloorZ ?? zRange.loZ,
    ceilProfile: opts.ceilProfile,
    floorZProfile: opts.floorZProfile,
    aboveCeilVisibleRanges: opts.aboveCeilVisibleRanges,
    stairCut: opts.stairCut ?? null,
    airRoom: opts.airRoom,
    underRooms: opts.underRooms,
    chDimSplitAbsYs: opts.chDimSplitAbsYs,
    face,
    ends,
  };
  const probeCtx = opts.probeCtx ?? makeProbeContext(layers);
  return buildCutContent(cut, probeCtx, {
    endExtendMm: opts.endExtendMm ?? 0,
    bandRoomBounds: opts.bandRoomBounds ?? null,
    scale: opts.scale,
    upperPlaneOverhang: opts.upperPlaneOverhang ?? false,
  });
}
