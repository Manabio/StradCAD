/**
 * per-floor CL の階またぎ対応付け（type:value 照合）。
 *
 * per-floor CL（中心線・補助線）は階ごとに別インスタンス（別id）のため、ある階で解決した
 * CL を別階へ持ち越すには「同種別・同座標」で対応先を探す必要がある。通り芯（structGraph
 * 側の CL）は全階共通idのため、この照合は不要——呼び出し側が先に structGraph.shapeMap.has(id)
 * で判定する（本ファイルの translateCLId 参照）。
 *
 * stairFloorSync.js（階段の上階自動同期）・finish/eccentricityFloorSync.js（CL偏芯の階またぎ
 * 連動）・finish/equipment/equipmentFloorPlan.js（昇降機の上階事前チェック）が共用する。
 *
 * translateExtent・translateCellKey・translateCellSet・collectNeededCLs・addMissingCLs は
 * 本体を変えずに finish/stair/stairFloorSync.js から移した（昇降機の仕様追加 ステップ4 S1・
 * 2026-09-29）。stairFloorSync.js は本ファイルから import する。
 *
 * findCounterpartCL・addMissingCLs の任意引数（predicate/isCounterpart）はステップ4 S2で追加した。
 * 省略時は完全に従来どおりの経路（種別を問わず最初の1件）を通る——階段（stairFloorSync.js）は
 * 省略のまま呼ぶため挙動は変わらない。昇降機の経路（equipmentFloorPlan.js）だけが
 * isFinishCellDivider（core/centerLineKindPolicy.js）を渡し、区画を割る種別（通り芯・中心線）
 * だけを対応先として認める——上階の同じ座標に梁芯・補助線しか無い場合は「対応先なし」として
 * 新しい中心線を足す（S0計測で実データに実在を確認済み）。
 */
import { sameCoordCounterparts } from '../core/centerLineKindPolicy.js';

const EPS = 1e-6;

// graph 内で type:value が一致する CL を探す。走査は sameCoordCounterparts（core/centerLineKindPolicy.js）
// 経由——種別条件の無い素の graph.centerLines 走査を個別に書かない（ステップ7、2026-09-20移行。
// tolMm に本ファイル既定の EPS を明示的に渡すため既存の許容誤差は変わらない）。
// 既知の限界: type と value のみで照合し、線種（lineType）・discipline は見ない
// （sameCoordCounterparts自体も種別を見ない走査APIのため、この限界は移行後も変わらない）。同一座標に
// 別種のCL（例: 通り芯と補助線）が併存する構成では誤って別種CLへ解決しうる。stairFloorSync.js
// での既存の実績を踏まえ、挙動は変更しない（影響範囲を読み切れないため）。
// 引数不正（type未指定・valueが数値でない）は null を返す（throwしない）——sameCoordCounterparts自体は
// 引数不正をthrowするが、findCounterpartCLの契約（移行前は `graph.centerLines.find(...)` がどんな
// type/valueでも単に該当なしとして null を返していた）を保つため、ここで先にガードする
// （QA指摘: translateCLId が非CL形状のid（centerLineType/valueを持たない）を渡すケースがあり、
// 移行前は暗黙にnullへ収束していた）。
// predicate（省略可）: 見つかった候補をさらに絞る述語（例: isFinishCellDivider）。省略時
// （null）は絞り込みをせず従来どおり最初の1件を返す——呼び出し側が明示的に渡さない限り
// 挙動は変わらない（team-lessons「明示vs省略のA/B等価テストが既定生成で恒真化する」に沿い、
// 省略＝完全に旧経路、明示＝新経路という2値のみを持つ。既定で別の絞り込みを自動生成しない）。
export function findCounterpartCL(graph, type, value, predicate = null) {
  if (type == null || typeof value !== 'number' || Number.isNaN(value)) return null;
  const matches = sameCoordCounterparts(graph, { centerLineType: type, value, tolMm: EPS });
  return (predicate ? matches.filter(predicate) : matches)[0] ?? null;
}

/**
 * per-floor CL id を別階（またはstructGraph共通）の対応CL idへ変換する。
 * 通り芯（structGraph 側）は全階共通のため同一IDのまま。設置階 per-floor CLは
 * type:value 照合で対象階側の対応CLを探す。解決できなければ null（呼び出し側は安全側でスキップ）。
 * @param {string} id - 変換元グラフ（sourceGraph）に属する CL の id
 * @param {object} sourceGraph - id が属するグラフ
 * @param {object} structGraph - 通り芯共通グラフ（project.structGraph）
 * @param {object} targetGraph - 対応先を探すグラフ
 */
export function translateCLId(id, sourceGraph, structGraph, targetGraph) {
  if (structGraph?.shapeMap.has(id)) return id;
  const cl = sourceGraph.shapeMap.get(id);
  // cl が CL でない（centerLineType を持たない／value が数値でない。壁・柱等の別 Shape が同じ
  // shapeMap から誤って渡されたケース）場合も null——「解決できなければ null」の契約を守る
  // （findCounterpartCL 側の引数ガードとの二重防御。QA指摘）。
  if (!cl || cl.centerLineType == null || typeof cl.value !== 'number' || Number.isNaN(cl.value)) return null;
  const counterpart = findCounterpartCL(targetGraph, cl.centerLineType, cl.value);
  return counterpart ? counterpart.id : null;
}

/**
 * 設置階 CL の side('lo'|'hi') 側 extent を上階グラフ向けに変換する。
 * - 通り芯参照（全階共通の structGraph CL）→ 参照をそのまま維持
 * - 設置階 per-floor CL への参照 → 上階の同 type:value CL へ付け替え
 * - 壁参照・付け替え先なし → 解決済み座標を静的値として持たせる（壁は階固有）
 * @returns {{ref: object|null, staticVal: number|null}}
 */
// isCounterpart はここでは使わない——extentLoRef/HiRefが参照する相手（aux等、分割線とは限らない）を
// 追従参照として持たせるかどうかの判定であり、addMissingCLsの「対応するCLが既に上階にあるか」
// （分割線としての対応。isCounterpart対象）とは別の関心事（S2裁定）。
function translateExtent(src, side, activeGraph, structGraph, upperGraph) {
  const ref       = side === 'lo' ? src.extentLoRef : src.extentHiRef;
  const staticVal = side === 'lo' ? src._extentLo   : src._extentHi;
  const resolved  = side === 'lo' ? src.extentLo    : src.extentHi;
  if (ref?.clId) {
    if (structGraph?.shapeMap.has(ref.clId)) return { ref, staticVal: null };
    const srcRef = activeGraph.shapeMap.get(ref.clId);
    const counterpart = srcRef
      ? findCounterpartCL(upperGraph, srcRef.centerLineType, srcRef.value)
      : null;
    if (counterpart) {
      return { ref: { clId: counterpart.id, offset: ref.offset ?? 0 }, staticVal: null };
    }
    return { ref: null, staticVal: resolved };
  }
  if (ref?.wallId) return { ref: null, staticVal: resolved };
  return { ref: null, staticVal };
}

// セルキー（"leftId:topId:rightId:bottomId"）を上階のCL id集合へ変換する。1つでも解決不能なら null。
function translateCellKey(key, activeGraph, structGraph, upperGraph) {
  const ids = key.split(':').map(id => translateCLId(id, activeGraph, structGraph, upperGraph));
  return ids.every(Boolean) ? ids.join(':') : null;
}

/**
 * cells（Set<string>）を上階の CL id 空間へ type:value 照合で変換する（階段・部屋どちらの
 * セル集合にも使う汎用ヘルパ）。1つでも解決不能なセルがあれば null を返す（安全側。
 * 呼び出し側は該当エンティティの自動追加をスキップする）。
 */
export function translateCellSet(cells, activeGraph, structGraph, upperGraph) {
  const result = new Set();
  for (const key of cells) {
    const translated = translateCellKey(key, activeGraph, structGraph, upperGraph);
    if (!translated) return null;
    result.add(translated);
  }
  return result;
}

/**
 * cellKeys（Set<string>）が参照する per-floor 中心線を type:value で集める（通り芯は
 * sourceGraph.shapeMap に無いため自然にスキップされる）。
 * @returns {Map<string, import('@core').CenterLine>} `${type}:${value}` → CenterLine
 */
export function collectNeededCLs(cellKeys, sourceGraph) {
  const needed = new Map();
  for (const key of cellKeys) {
    for (const clId of key.split(':')) {
      const cl = sourceGraph.shapeMap.get(clId);
      if (!cl) continue;
      needed.set(`${cl.centerLineType}:${cl.value}`, cl);
    }
  }
  return needed;
}

/**
 * needed（collectNeededCLs の結果）のうち upperGraph に無いものを追加し、短縮区間（extent）も
 * translateExtent で写す。stairFloorSync 内の全ての「上階への不足CL同期」処理はこれを使う
 * （二重実装しない）。
 * @param {{isCounterpart?: (cl: object) => boolean}} [opts] - 省略時（既定 null）は種別を問わず
 *   findCounterpartCL の既定どおり最初の1件を「対応先あり」とみなす（階段の既存挙動は不変）。
 *   昇降機の経路は isFinishCellDivider を渡し、区画を割る種別（通り芯・中心線）だけを対応先と
 *   認める——上階の同座標に梁芯・補助線しか無ければ「対応先なし」として新しい中心線を足す。
 * @returns {number} 追加した CL 数（0 なら変更なし）
 */
export function addMissingCLs(needed, sourceGraph, structGraph, upperGraph, { isCounterpart = null } = {}) {
  const added = []; // [元CL, upperGraphに追加したCL]
  for (const cl of needed.values()) {
    if (findCounterpartCL(upperGraph, cl.centerLineType, cl.value, isCounterpart)) continue;
    const nc = upperGraph.addCenterLine(cl.centerLineType, cl.value, {
      labeled: false, trim: false, discipline: cl.discipline,
      lineWeight: cl.lineWeight, lineType: cl.lineType, color: cl.color,
    });
    added.push([cl, nc]);
  }
  for (const [src, nc] of added) {
    for (const side of ['lo', 'hi']) {
      const { ref, staticVal } = translateExtent(src, side, sourceGraph, structGraph, upperGraph);
      if (ref || staticVal != null) upperGraph.setCenterLineExtentRef(nc, side, ref, staticVal);
    }
  }
  return added.length;
}
