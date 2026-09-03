/**
 * 展開図: 通常の壁面（buildFaceFigure）への「2.5D立体の加算レイヤ」。
 * 設計意図は .claude/elevation-model.md「2.5D立体の加算レイヤ（全展開図共通）」節参照。
 *
 * 追加仕様2026-08「2.5D仕様の展開ロジックを吹抜け・階段だけでなく、全ての展開図に適用」への
 * 回答実装。**面の描画パイプライン自体（buildFaceFigure）を断面エンジン（section/sectionEngine.js）へ
 * 置き換えるのではなく**、階段帯で既に確立している「純粋な加算レイヤ」（sectionStructure.js。
 * 遮蔽判定に参加しない・レイキャストを持たない）のパターンを通常面へ広げる方式を採る——
 * buildFaceFigureは段差プロファイル・開放スパン・注記帯・巾木・建具姿図・壁2段書き等の
 * 大量の確定仕様を抱えており、ゴールデンゲート（elevationSectionGolden.test.js）で固定されている。
 * 「柱・梁型・作り付け家具の断面を描く」という目的は加算レイヤだけで満たせるため、置き換えの
 * リスクを負う理由が無い（作り付け家具はドメインモデル自体が未実装のため対象外・defer）。
 *
 * 純モジュール（node:testから単体import可能。store.js/snap.js/*.jsx/react-konva/appViewport.jsを
 * 静的importしない）。
 */
import { GAP_EPS_MM as GAP_EPS } from './elevationStyle.js';
import {
  structuralContribution, structuralPrimitivesForCut,
  structuralColumnContribution, structuralColumnPrimitivesForCut,
} from './section/sectionStructure.js';

/**
 * face（buildRoomFacesの1件）→ 断面エンジンの SectionCut 相当のアダプタ。
 * CutLineは「(isVertical, axisCL.value, lo, hi)」がfaceと同型（sectionTypes.js）のためそのまま
 * 移せる。cutOriginWorld(cut)=dirSign>0?line.lo:line.hi は face.originWorld の定義と一致するため、
 * localXOf(cut,...) と localXOf(face,...) は同じ値を返す（＝面のローカル座標のまま合成できる）。
 *
 * 高さの基準は帯そのもの: baseFloorZ=0（帯FL）・zRange=0..CH。
 * layersは自階（floorZMm=0）と、判っていれば上階（floorZMm=floorHeightMm）——梁は「その梁が
 * 実際に立つ階のgraph」に帰属する（sectionStructure.jsヘッダ）ため、1階の天井に現れる梁型は
 * 2階伏図＝上階graphの梁である。
 * @param {object} face
 * @param {{graph:object, ceilingHeight:number, upperGraph?:object|null,
 *   floorHeightMm?:number|null}} opts
 * @returns {import('./section/sectionTypes.js').SectionCut|null}
 *   面の軸位置（axisCL.effectiveValue）・dirSign・lo/hiのいずれかが数値でなければnull
 *   （合成face・単体テストのフェイクface。呼び出し側は何も描かない）。
 */
export function faceSectionCut(face, opts) {
  const axisValue = face?.axisCL?.effectiveValue;
  if (!Number.isFinite(axisValue)) return null;
  if (!Number.isFinite(face.lo) || !Number.isFinite(face.hi)) return null;
  if (face.dirSign !== 1 && face.dirSign !== -1) return null;
  const CH = opts.ceilingHeight;
  if (!Number.isFinite(CH) || CH <= 0) return null;

  const layers = [{ graph: opts.graph, floorZMm: 0, role: 'self' }];
  if (opts.upperGraph && Number.isFinite(opts.floorHeightMm)) {
    layers.push({ graph: opts.upperGraph, floorZMm: opts.floorHeightMm, role: 'above' });
  }
  return {
    seqNo: 'face',
    line: { isVertical: face.isVertical, axisValue, lo: face.lo, hi: face.hi },
    // **ここのviewSignは`sectionCutPlane.js`の`faceViewSign`とは逆の意味**（室内側＝視線の
    // 手前側を正に採る。あちらは「壁を見る向き」＝室内から壁へ向かう世界方向で符号が反対）。
    // 二重定義だが**統一しない**——`faceViewSign`へ差し替えると加算レイヤの`onNearSide`
    // （柱が面のどちら側に出っ張るか）が反転し、ユーザー確認済みの「4」Bの挙動が壊れる。
    // 統合の是非は別件（報告済み）。符号は elevationSolids.test.js の符号固定テストで留める。
    viewSign: face.inward === -1 ? -1 : 1,
    dirSign: face.dirSign,
    layers,
    zRange: { loZ: 0, hiZ: CH },
    baseFloorZ: 0,
  };
}

/**
 * BeamSolid[] を帯の描画z範囲（0..CH）へクリップする。範囲外へ完全に外れる梁は落とす。
 *
 * これが「梁型（下がり天井の梁）だけが出る」という建築的に正しい挙動をそのまま与える——
 * 自階graphの床梁（levelOffset=0＝天端がFL）は帯の床より下で全消し、上階graphの梁は
 * 天端=階高のため、梁成が階高−CHを超えて天井から降りてくる分だけが残る。副次的に、
 * 床より下の細破線が注記帯（tag行・ROW1/ROW2・通り芯丸）へ被る問題も原理的に起きない。
 * @param {object[]} beams - structuralContribution の結果
 * @param {number} loZ
 * @param {number} hiZ
 * @returns {object[]}
 */
function clipBeamsToBand(beams, loZ, hiZ) {
  const out = [];
  for (const b of beams) {
    const top = Math.min(b.topZ, hiZ);
    const bot = Math.max(b.topZ - b.depthMm, loZ);
    if (top - bot <= GAP_EPS) continue;
    out.push({ ...b, topZ: top, depthMm: top - bot });
  }
  return out;
}

/**
 * 面のローカルx範囲 [0, run] へ線プリミティブをクランプする（軸並行の矩形辺しか来ない前提。
 * 斜め線は本レイヤでは生成されない）。範囲外の縦線・退化した水平線は落とす。
 * 構造材は壁中心線（CL）間の実スパンで存在するため、クランプしないと隣の面の領域まで
 * はみ出して描かれる（面間ギャップは寸法線類の実寸で決めており、この加算レイヤ分は
 * 見込んでいない）。
 * @param {object[]} prims
 * @param {number} run
 * @returns {object[]}
 */
function clampPrimsToRun(prims, run) {
  // -0 を 0 へ正規化する（sectionEmit.jsのzToYはz=0に対し-0を返す。buildFaceFigureの既存
  // プリミティブは -0 を作らない規約（elevationFigure.jsのfloorYOf参照）のため、帯へ合流する
  // ここで揃えておく——等値比較・テストの落とし穴を新経路に持ち込まない）。
  const z = v => (v === 0 ? 0 : v);
  const out = [];
  for (const p of prims) {
    const x1 = Math.min(Math.max(p.x1, 0), run);
    const x2 = Math.min(Math.max(p.x2, 0), run);
    // 縦線: クランプで位置が動く＝元々範囲外だったため描かない（幅を偽らない）。
    if (Math.abs(p.x1 - p.x2) < GAP_EPS) {
      if (Math.abs(x1 - p.x1) > GAP_EPS) continue;
      out.push({ ...p, x1: z(p.x1), y1: z(p.y1), x2: z(p.x2), y2: z(p.y2) });
      continue;
    }
    if (Math.abs(x2 - x1) <= GAP_EPS) continue; // 完全に範囲外の水平線
    out.push({ ...p, x1: z(x1), y1: z(p.y1), x2: z(x2), y2: z(p.y2) });
  }
  return out;
}

/**
 * 面1枚へ加算する2.5D立体（構造柱・構造梁）のプリミティブ。
 * - 切断線と直交する梁 → 幅×せいの断面矩形（CUT太線）
 * - 切断線と平行で幅の帯に掛かる梁 → 上端・下端・両端縦線（DETAIL細線）＝梁型の見えがかり
 * - 切断線をまたぐ柱 → 見付け幅の両端縦線（CUT太線）＝柱型
 * いずれも遮蔽判定には参加しない純粋な加算（sectionStructure.jsの方針をそのまま継承）。
 * 基礎・基礎梁・杭は描かない（追加仕様2026-08。sectionStructure.js側で除外）。
 * @param {object} face
 * @param {{graph:object, ceilingHeight:number, upperGraph?:object|null,
 *   floorHeightMm?:number|null}} opts
 * @returns {object[]} 解決できない面・対象部材が無い場合は空配列（例外は投げない）
 */
export function solidPrimitivesForFace(face, opts) {
  const cut = faceSectionCut(face, opts);
  if (!cut) return [];
  const { loZ, hiZ } = cut.zRange;
  const beams = clipBeamsToBand(structuralContribution(cut.layers), loZ, hiZ);
  const prims = [
    ...structuralPrimitivesForCut(beams, cut),
    ...structuralColumnPrimitivesForCut(structuralColumnContribution(cut.layers), cut),
  ];
  return clampPrimsToRun(prims, face.run);
}
