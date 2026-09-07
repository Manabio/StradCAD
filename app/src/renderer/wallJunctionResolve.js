import { planWallHeight } from '../finish/kneeDropWall.js';

/**
 * 壁同士の取り合い（T字の突き当たり・出隅/入隅のコーナー）を検出し、詳細LOD描画にのみ
 * 反映する調整結果を返す。
 *
 * ジオメトリ（Wall.startOffset/endOffset 等）は一切変更しない。既存のトリム
 * （core/wallChamfer.js trimIntersectingWalls＝手動壁、stairUnderWalls.js trimStairUnderJunctions＝
 * 階段下壁、finish/wallGeneration.js closeConvexCorners＝出隅）が壁の論理端点を相手壁の
 * face（materialRange の境界）へ既にスナップしている前提の上で、その端点から先の
 * 「見た目だけ」を解決する。resolveStairSideLines（stairGeometry.js）と同様、
 * 「描画ルールを幾何モジュールに集約しレンダラは写像するだけ」という既存パターンに倣う。
 * 対象は壁全般（手動壁・部屋壁・外壁・階段下壁を区別しない）。残るのは2つのパス——パス6（前処理）と
 * パス0（高さが違う壁の取り合い）——だけで、旧パス1・2・3・5（T字の切り欠き・内側線の端点合わせ・
 * fin線の下地貫通防止・妻線抑止）は 2026-09 に撤去した: いずれも材の領域の合併境界
 * （renderer/planWallRegion.js）の帰結、または下地矩形の端の正規化として得られる（`.claude/plan-wall-region.md`）。
 * パス0の結果のうち領域が使うのは `endExtend`（外へ伸ばす分）・`spanCuts`・`endWrap`。
 *
 * ## パス6（前処理）: 直交壁を通り抜けた端は、その壁の手前の面まで詰める
 * 2026-09ユーザー確定「入隅の角の頂点からCLまでの線分と、CL上の壁厚ぶんの線分は不要」。
 * 壁生成は角の欠けを塞ぐために壁の端を相手の材の遠位面まで伸ばす（`closeConvexCorners`）が、
 * 途中に別の壁（部屋側の仕上げ薄壁など）があると、その壁を**通り抜けて**さらに先の壁の面まで
 * 届いてしまう。描画上の端は「最初に当たった壁の手前の面」＝入隅の角の頂点であるべきで、
 * そこから先（CLまで、およびCL上の妻線）は不要。
 * 判定: 端が**どこかの壁の材の中で終わっている**（＝角を塞ぐ延長である）ことを要求したうえで、
 * その端が**完全に通り抜けた**壁のうち最も手前の面まで詰める。材の外で終わる端（自由端・T字の
 * 突き当たり）や、通り抜けていない端（角の相手の材の中で止まっている＝正しい延長）は対象外。
 * 詰めた結果はビューの長さ方向スパンにも反映するので、パス0は詰めたあとの端で判定する。
 * 領域方式（renderer/planWallRegion.js）はこの詰めを材の矩形には使わない——通り抜けた材は合併で
 * 相手に呑まれる。詰めが効くのは `segments`（略図の単線と間柱のピッチ原点）。
 *
 * **どの壁も通り抜けていない端でも、`帯`（同じ軸CL上で向かい合うオーナー壁＋仕上げ薄壁の組。
 * `groupIntoBands`）の内部で止まっていれば同じく帯の手前の面まで詰める**。壁の端は帯の面
 * （手前＝入隅の頂点／遠位＝角を閉じる延長）のどちらかに在るのが前提で、その中間＝帯の中で
 * 隣り合う2枚の境目は描画上の端になりえない。対称壁ではこの境目が軸CL上にあり実際上生じないが、
 * **偏芯壁の帯は軸CLに対して非対称**で、生成側のトリム（`trimStairUnderJunctions` の
 * `snapToMaterialFace` は相手を1枚ずつ見る）が端を「帯の片割れの面」へ合わせると境目で終わる端が
 * 実際に生じる（実機2026-09・1階Y1+3500×X2: 階段下部屋の偏芯壁と、そこで分割された通り芯の
 * オーナー壁の双方）。詰めないと、面線・内側線が相手の帯の中へ仕上げ厚ぶん食い込んだまま描かれ、
 * 妻線が帯を横切る線として残る。
 * ## パス0: 高さが違う壁の取り合い — 高い方が優先し、L字の端部を覆って取り巻く
 * ユーザー確定2026-09。平面切断高さ以下の腰壁は**切断面に存在せず**、天板を見下ろした輪郭で
 * 描かれる。腰壁を普通の壁として取り合わせると、切断面まで在る高い壁の面線・内側線が切られ
 * 妻線が消える——そこには無い壁の痕跡が高い壁の側に出る。そこで:
 *  - **高さが違う壁の組は取り合わない**（高さの供給源は finish/kneeDropWall.js の `planWallHeight`
 *    1箇所）。領域方式では腰壁は全高の領域に入らず、天板の領域（planWallRegion.js）で描かれる。
 *  - 代わりにパス0が、その組の**L字の端部**だけを見る（相手の端がこちらの材に触れている。
 *    通り過ぎるT字・X字は角ではないので対象外）。高い壁の端を低い壁の
 *    **帯全体**（オーナー＋薄壁＝`fullFaceRange`）の遠位面まで伸ばし（`endExtend`）、その端を
 *    仕上げ材で取り巻く（`endWrap`＝外側線は端まで・内側線は仕上げ厚ぶん手前で止めて木口線へ
 *    折れる。「壁仕上げ材の出隅の角はL字処理」）。伸ばさないと低い壁の材幅ぶんの矩形が角に
 *    欠けて残る。伸ばした先に同じ通り・同じ面向きの壁が続くなら端部ではなく通過点なので、
 *    妻線も取り巻きも出さない。
 *  - 低い壁側には`spanCuts`（高い壁の帯に覆われる区間は描かない）を返す。覆う側と譲る側は
 *    同じ1つの取り合いの裏表なので、判定を分けずここで両方を決める。
 *  - **覆われた角の矩形の中に丸ごと収まる壁**（壁生成が交差部に作る短い駒）は、切断面では
 *    高い壁の材の中にあり見えない——`spanCuts`で描かない（描くと、その駒が高い壁の内側線を
 *    下地幅で切る＝実機2026-09 X3通りの不良）。
 *    **ここで隠すのは「覆われた角の矩形の中に完全に収まる壁」だけ**——腰壁の区間の端に
 *    半分だけ掛かる駒（区間の外側では全高の壁が続く）はそのまま全高の壁であり、
 *    腰壁として扱うと全高どうしのT字・十字の取り合いが壊れる（実機で確認した回帰）。
 *  - 逆に、**交差する両方の通りが腰壁**だと、交差部の駒だけが全高のまま残って「高い方」に
 *    なり、角を取り巻いて相手の天板まで切ってしまう。角の矩形に丸ごと埋まった駒
 *    （`isCornerFiller`）は覆う側にせず、自分を`spanCuts`で落とす——角は天板どうしの
 *    取り合い（renderer/planWallRegion.js の天板の領域）に任せる（実機2026-09「10」2階 X3×Y1-2000）。
 * `kneeDropOverlays` を渡さない呼び出し（略図LOD・旧テスト）は全壁が同じ高さ＝パス0は何もしない。
 *
 */

// 「壁の端点が相手壁のfaceValueに触れている」とみなす許容差(mm)。
// 既存トリムは理論上ゼロ誤差でface位置へスナップするため小さい値で足りるが、
// 厳密スナップを経ていない壁（未トリムの手動壁等）も拾えるよう、代表的な仕上げ厚
// オーダー（DEFAULT_WALL_FINISH 相当。wallGeneration.js 参照）を許容差とする。
// 150mm（パス1のコーナー除外・近接候補探索の許容差）より意図的に小さくし、「明確に
// 離れている（デザイン上の隙間）」壁を誤って取り合い扱いしないようにする。
const TOUCH_TOLERANCE = 30; // mm

// 「壁の端から見て角と言える距離」（パス6が「端から遠い壁＝スパン途中の交差」を除くのに使う）。
// trimIntersectingWalls/trimStairUnderJunctions の
// 近接判定tolerance（150mm）と揃え、トリム側が「コーナー」と判定する範囲とこの描画側の
// 除外範囲を一致させる（トリムがコーナー処理した壁を、ここでT字として誤検出しないため）。
const CORNER_EXCLUSION = 150; // mm

// fin線（内側線）の位置・可視性と、取り合い先（相手の内側線の位置）は
// finish/wallFinishJoin.js が唯一の供給源——柱の仕上げ包み（finish/columnWrap.js）と
// **同じ経路**を通す（判定を変えるときはあちらのファイルだけを直す）。

// 壁1本分のビュー（POJO スナップショット）。
// この解決は壁の総当たり（O(壁²)）で、内側で読む `materialRange` / `axisValue` / `coord1,2` /
// `faceDir` はすべて MobX の computed（またはフィールド）。実データ規模だとこの読み出し自体が
// 支配的なコストになる（実測）ため、値を1回だけコピーして二重ループはそれを見る
// （finish/columnWrap.js の壁ビューと同じ手口）。
function makeView(w, kneeDropOverlays) {
  return {
    id: w.id,
    planHeight: planWallHeight(kneeDropOverlays, w.id),
    isVertical: w.isVertical,
    lenLo: Math.min(w.coord1, w.coord2), lenHi: Math.max(w.coord1, w.coord2),
    axisValue: w.axisValue,
    axisCLValue: w.axisCL?.effectiveValue,
    faceDir: w.faceDir,
    materialRange: w.materialRange,
  };
}

// 「覆われた角の矩形に丸ごと収まる」判定の座標許容(mm)。既存トリムは理論上ゼロ誤差で面へ
// スナップするため小さい値で足りる（ENDPOINT_EPS と同値）。
const CONTAIN_EPS = 0.5; // mm

const AXIS_EPS = 0.5; // mm

// 交差する壁を**帯**（同じ軸CL上で背中合わせに向かい合うオーナー壁＋仕上げ薄壁の組）へ束ね、
// 材の範囲と`seams`（帯の中で隣り合う2枚が接する位置＝帯の面ではない内部の境目）を返す。
// 帯の面（=最外の2面）と内部の境目を区別するために要る——対称壁では境目が軸CL上にあり
// そこで終わる端は実際上生じないが、偏芯壁（階段下部屋の偏芯壁・CL偏芯壁）の帯は軸CLに対して
// 非対称で、生成側のトリムが「相手の帯の片割れの面」へ端を合わせると境目で終わる端が実際に
// 生じる（実機2026-09）。境目は**面向きが逆の2枚が接する位置**だけを数える（同じ面向きの壁が
// 重なるだけの退化配置を帯と誤認しないため）。
function groupIntoBands(facing) {
  const bands = new Map();
  for (const b of facing) {
    const cur = bands.get(b.axisCLValue);
    if (cur) {
      cur.lo = Math.min(cur.lo, b.materialRange.lo);
      cur.hi = Math.max(cur.hi, b.materialRange.hi);
      cur.walls.push(b);
    } else {
      bands.set(b.axisCLValue, { lo: b.materialRange.lo, hi: b.materialRange.hi, walls: [b] });
    }
  }
  for (const band of bands.values()) {
    band.seams = [];
    for (const p of band.walls) {
      for (const q of band.walls) {
        if (q.faceDir === p.faceDir) continue;
        if (Math.abs(p.materialRange.hi - q.materialRange.lo) <= CONTAIN_EPS) {
          band.seams.push(p.materialRange.hi);
        }
      }
    }
  }
  return [...bands.values()];
}

function fullFaceRange(a, group) {
  let lo = a.materialRange.lo, hi = a.materialRange.hi;
  for (const s of group) {
    if (s.id === a.id) continue;
    if (Math.abs(s.axisCLValue - a.axisCLValue) > AXIS_EPS) continue;
    if (s.faceDir === a.faceDir) continue; // 反対サイドのペアだけを相棒とみなす
    if (s.lenHi <= a.lenLo || s.lenLo >= a.lenHi) continue; // 長さ方向で重ならない＝別位置の壁
    lo = Math.min(lo, s.materialRange.lo);
    hi = Math.max(hi, s.materialRange.hi);
  }
  return { lo, hi };
}

/**
 * aが「交差部の駒」——低い壁（腰壁）どうしの角の矩形に**丸ごと埋まった全高の壁**——か。
 *
 * 壁生成は部屋の外周を部屋ごとに切り出すため、角にはどちらの辺にも属さない短い駒が残ることが
 * ある。その駒に腰壁の指定は乗らない（区間の端に半分だけ掛かるので構成壁ではない）ので全高の
 * 壁として残り、パス0では**駒が「高い方」になって**角を取り巻き、腰壁の天板を切ってしまう
 * （実機2026-09「10」2階 X3×Y1-2000: 交差部に壁厚2本線のL字が出て、縦の天板が駒の面で切れた）。
 * 駒は角の矩形に完全に埋まっている＝切断面に見えるのは両側の腰壁の天板だけなので、描かない。
 *
 * 判定は**両方向の封じ込め**で行う（片方だけだと普通の壁を消しかねない）:
 *   長さ方向 … 交差壁bの帯（bBand）に丸ごと収まる＝bに突き当たって終わる壁ではなくbの中の駒。
 *   厚み方向 … 同じ通りで隣り合う**低い壁**の材の中に収まる＝腰壁の帯の中の駒。
 * さらに同じ通りに全高の壁が隣接していれば駒ではなく全高の連なりの一部なので対象外
 * （その角は全高どうしの取り合い。低い壁に覆われる駒の非表示はパス0の既存規則が扱う）。
 */
function isCornerFiller(a, bBand, sameDir) {
  if (a.lenLo < bBand.lo - CONTAIN_EPS || a.lenHi > bBand.hi + CONTAIN_EPS) return false;
  let lo = Infinity, hi = -Infinity;
  for (const k of sameDir) {
    if (k.id === a.id) continue;
    if (Math.abs(k.axisCLValue - a.axisCLValue) > AXIS_EPS) continue;
    // 長さ方向で隣り合う（角で接する）壁だけを宿主候補にする
    if (k.lenHi < a.lenLo - TOUCH_TOLERANCE || k.lenLo > a.lenHi + TOUCH_TOLERANCE) continue;
    if (!(k.planHeight < a.planHeight)) return false; // 同じ通りに全高の壁が続く＝駒ではない
    lo = Math.min(lo, k.materialRange.lo);
    hi = Math.max(hi, k.materialRange.hi);
  }
  return a.materialRange.lo >= lo - CONTAIN_EPS && a.materialRange.hi <= hi + CONTAIN_EPS;
}

/**
 * 壁配列から取り合い（T字・コーナー・高さ差）を検出し、壁ID → 描画調整のMapを返す。
 * @param {import('@core').Wall[]} walls
 * @param {Map<string, object>|null} [kneeDropOverlays] finish/kneeDropWall.js の
 *   resolveKneeDropOverlays の結果。平面での壁の高さ（腰壁か否か）の判定に使う
 *   （モジュールヘッダ「パス0」）。省略時は全壁を同じ高さとみなす（従来挙動）。
 * @returns {Map<string, {
 *   endExtend:{lo?:number,hi?:number},
 *   endWrap:{lo?:boolean,hi?:boolean},
 *   spanCuts:[number,number][],
 * }>}
 */
export function resolveWallTJunctions(walls, kneeDropOverlays = null) {
  const result = new Map();
  const ensure = (id) => {
    if (!result.has(id)) {
      result.set(id, { endExtend: {}, endWrap: {}, spanCuts: [] });
    }
    return result.get(id);
  };

  // 仕上げ厚が確定した壁全般（薄壁も含む）を向きで二分する。
  const allVerticals = [], allHorizontals = [];
  for (const w of walls) {
    if (w.wallFinish == null) continue; // 仕上げ厚不明（手動壁で寸法未確定）は対象外
    const view = makeView(w, kneeDropOverlays);
    (view.isVertical ? allVerticals : allHorizontals).push(view);
  }

  // ---- パス6（前処理・パス0より先）: 直交壁を通り抜けた端は、その壁の手前の面まで詰める ----
  // モジュールヘッダ参照。ここで詰めた端はビューの長さ方向スパンへ反映し、以降のパス0〜3が
  // **詰めたあとの端**で判定する（入隅の相手が「通り抜けた先の壁」から「最初に当たった壁」へ
  // 変わり、内側線の合わせ先もその壁の内側線になる）。
  for (const [sameDir, crossDir] of [[allVerticals, allHorizontals], [allHorizontals, allVerticals]]) {
    for (const a of sameDir) {
      for (const end of ['lo', 'hi']) {
        const coord = end === 'lo' ? a.lenLo : a.lenHi;
        const anchorCoord = end === 'lo' ? a.lenHi : a.lenLo;
        const dir = Math.sign(coord - anchorCoord) || 1;
        const facing = crossDir.filter(b => b.planHeight === a.planHeight
          && b.lenLo <= a.axisValue + TOUCH_TOLERANCE && b.lenHi >= a.axisValue - TOUCH_TOLERANCE);
        // 端がどこかの壁の材の中で終わっている（＝角の欠けを塞ぐ延長）ときだけ見る。
        // 材の外で終わる端は自由端・T字の突き当たりで、詰める対象ではない。
        const endsInside = facing.some(b => coord >= b.materialRange.lo - CONTAIN_EPS
          && coord <= b.materialRange.hi + CONTAIN_EPS);
        if (!endsInside) continue;
        let trim = null;
        for (const b of facing) {
          const near = dir > 0 ? b.materialRange.lo : b.materialRange.hi;
          const far  = dir > 0 ? b.materialRange.hi : b.materialRange.lo;
          const beyond = dir * (coord - far);
          if (!(beyond > CONTAIN_EPS)) continue;      // 通り抜けていない＝角の相手
          if (beyond > CORNER_EXCLUSION) continue;    // 端から遠い壁＝スパン途中の交差（角ではない）
          // 相手の手前の面が、自分の本体（anchor側）より端側にあること——交差部の駒のように
          // 自分の全長が相手の帯に収まっている壁は「通り抜けた」のではないので詰めない。
          if (!(dir * (near - anchorCoord) > CONTAIN_EPS)) continue;
          if (trim == null || dir * (near - trim) < 0) trim = near; // 最も手前の壁
        }
        // どの壁も通り抜けていない場合でも、端が**帯の内部**（帯の面のどれでもない位置。
        // 帯の中で隣り合う2枚の境目）で止まっていれば、そこは描画上の端ではない
        // ——帯の手前の面まで詰める（モジュールヘッダ パス6の後半）。
        if (trim == null) {
          // 帯の中で隣り合う2枚の**境目**（seam）にちょうど乗る端だけを見る。どの壁の面でも
          // ない位置で止まった端は相手の材を途中まで貫いただけのT字の突き当たりで、詰めない。
          for (const band of groupIntoBands(facing)) {
            if (!band.seams.some(v => Math.abs(coord - v) <= CONTAIN_EPS)) continue;
            const near = dir > 0 ? band.lo : band.hi;
            const far  = dir > 0 ? band.hi : band.lo;
            if (!(dir * (coord - near) > CONTAIN_EPS)) continue; // 帯の手前の面より外＝詰めない
            if (!(dir * (coord - far) < -CONTAIN_EPS)) continue; // 帯を貫き切った端＝出隅の延長
            if (!(dir * (near - anchorCoord) > CONTAIN_EPS)) continue; // 交差部の駒（自分が帯に収まる）
            if (trim == null || dir * (near - trim) < 0) trim = near;
          }
        }
        if (trim == null || !(dir * (coord - trim) > CONTAIN_EPS)) continue;
        ensure(a.id).endExtend[end] = trim;
        if (end === 'lo') a.lenLo = trim; else a.lenHi = trim;
      }
    }
  }

  // ---- パス0: 高さが違う壁の取り合い（高い方が優先。モジュールヘッダ参照） ----
  // パス6と入口が逆で、**高さが違う組だけ**を見る。
  for (const [sameDir, crossDir] of [[allVerticals, allHorizontals], [allHorizontals, allVerticals]]) {
    for (const a of sameDir) {
      const alo = a.lenLo, ahi = a.lenHi;
      // 判定も結果も**帯単位**で行う（オーナー壁＋仕上げ薄壁を合わせた材幅＝
      // 同じ`fullFaceRange`）。1枚ぶんの材幅で見ると、同じ通りのオーナー壁と薄壁で覆う/覆わないや
      // 覆う深さが食い違い、高い壁の端が段違いになる（実機2026-09で両方を確認: X3通りは深さが
      // 段違い・X2通りは薄壁側だけが覆う判定から外れていた）。
      const aBand = fullFaceRange(a, sameDir);
      for (const b of crossDir) {
        if (!(a.planHeight > b.planHeight)) continue; // 覆うのは高い方だけ
        const bBand = fullFaceRange(b, crossDir);
        // L字の端部か: bの端（=aの厚み方向の位置）がaの帯に触れているか（パス3と同じ語彙）。
        // 通り過ぎるT字・X字ではbの端がaの帯から遠く、角ではないので対象外になる。
        const bNearEnd = Math.abs(b.lenLo - a.axisValue) <= Math.abs(b.lenHi - a.axisValue) ? b.lenLo : b.lenHi;
        if (bNearEnd < aBand.lo - TOUCH_TOLERANCE || bNearEnd > aBand.hi + TOUCH_TOLERANCE) continue;

        // **同じ帯に全高の壁が続いているなら、角はその壁との取り合い**（領域の帰結）に任せる。
        // 低い壁は反対側から寄り付くだけで、aはそこで終わっていない——覆う・取り巻くのは誤り
        // （ユーザー確定2026-09。実機X2通り: 西は全高の壁・東が腰壁で、角は全高どうしの
        // 入隅・出隅として取り合い、そこへ腰壁の天板が出幅ぶん食い込むのが正しい）。
        // 「aの帯の外側へ続く」ことを要求する——aの帯の中に丸ごと収まる壁は交差部の駒であって
        // 角の相手ではない（実機X3通り: 駒を相手と見なすと端部の取り巻きが起きなくなる）。
        // 判定は**aの半分（自分の材）ごと**に行う——同じ通りのオーナー壁と薄壁は帯の反対側に
        // あり、角を共有するのは全高の壁が接している側だけ。帯全体（aBand）で見ると、反対側の
        // 半分まで巻き添えで覆わなくなり、出隅の角が閉じない（実機2026-09 2階X2通り: 東半分は
        // 腰壁しか無いのに西の全高壁を理由に伸ばさず、面線・内側線が角に届かなかった）。
        const sharedByTallWall = crossDir.some(c => c.id !== b.id
          && c.planHeight > b.planHeight
          && c.materialRange.lo < bBand.hi - CONTAIN_EPS && c.materialRange.hi > bBand.lo + CONTAIN_EPS
          && c.lenLo <= a.materialRange.hi + CONTAIN_EPS && c.lenHi >= a.materialRange.lo - CONTAIN_EPS
          && (c.lenLo < aBand.lo - CONTAIN_EPS || c.lenHi > aBand.hi + CONTAIN_EPS));
        if (sharedByTallWall) continue;

        // 角の矩形に丸ごと埋まった駒は覆う側にしない——描かず（spanCutsで全長を落とす）、
        // 角は両側の腰壁の天板どうしの取り合い（renderer/planWallRegion.js の天板の領域）に任せる。
        if (isCornerFiller(a, bBand, sameDir)) {
          ensure(a.id).spanCuts.push([alo, ahi]);
          continue;
        }

        for (const [end, coord, anchorCoord] of [['lo', alo, ahi], ['hi', ahi, alo]]) {
          // aのこの端がbの帯に触れているか（触れていない端＝反対側の自由端は対象外）。
          if (coord < bBand.lo - TOUCH_TOLERANCE || coord > bBand.hi + TOUCH_TOLERANCE) continue;
          const dir = Math.sign(coord - anchorCoord) || 1;
          // 伸ばし先: bの帯の遠位面（出隅のfarFaceと同じ式）＝角の矩形を覆い切る位置。
          const target = dir > 0 ? bBand.hi : bBand.lo;
          const rec = ensure(a.id);
          // 伸ばすのは足りないときだけ（生成時の出隅処理で既に帯を越えて終端している壁は
          // 縮めない）。**覆っている端であることは変わらない**ので、妻線・取り巻きの判断は
          // どちらでも同じように行う——伸長の有無で分けると、同じ端のオーナー壁と薄壁で
          // 木口線の有無が食い違う（実機2026-09 X3通り）。
          const cur = rec.endExtend[end];
          if (dir * (target - coord) > 0 && (cur == null || dir * (target - cur) > 0)) {
            rec.endExtend[end] = target;
          }
          // 低い壁のうち、高い壁の帯に覆われる区間は描かない（天板輪郭が高い壁の帯を横切らない）。
          ensure(b.id).spanCuts.push([aBand.lo, aBand.hi]);
          // 覆われた角の矩形（bの帯 × **この半分の材**）に入る壁（壁生成が交差部に作る駒）は、
          // 切断面では高い壁の材の中にあって見えないのでその区間を描かない。**覆うのは半分ごと**
          // ——両方の半分が覆えば駒は丸ごと消え、片方だけなら残りの半分は描かれる（実機2026-09
          // 2階X2通り: 西半分は全高の壁と角を共有して伸びないので、駒のその部分は残る）。
          for (const c of crossDir) {
            if (c.id === b.id) continue;
            if (!(c.materialRange.lo >= bBand.lo - CONTAIN_EPS && c.materialRange.hi <= bBand.hi + CONTAIN_EPS)) continue;
            if (!(c.lenLo >= aBand.lo - CONTAIN_EPS && c.lenHi <= aBand.hi + CONTAIN_EPS)) continue;
            ensure(c.id).spanCuts.push([a.materialRange.lo, a.materialRange.hi]);
          }
          // 伸ばした先に**同じ通り・同じ面向きの壁が続いている**なら、そこは端部ではなく通過点
          // （部屋ごとに分割された1枚の壁が低い壁を跨ぐ形）——仕上げ材の取り巻きをしない。
          // 伸びた2本が重なって面線・内側線が連続するのは領域の合併の帰結（妻線も出ない）。
          const continued = sameDir.some(c => c.id !== a.id
            && Math.abs(c.axisCLValue - a.axisCLValue) <= AXIS_EPS && c.faceDir === a.faceDir
            && c.lenLo <= target + TOUCH_TOLERANCE && c.lenHi >= target - TOUCH_TOLERANCE);
          rec.endWrap[end] = !continued;
        }
      }
    }
  }
  // 旧パス1（T字の切り欠き・下地延長）・パス3（fin線の下地貫通防止）・パス2（内側線の端点合わせ）・
  // パス5（妻線抑止）は 2026-09 に撤去した——いずれも材の領域の合併境界（renderer/planWallRegion.js）の
  // 帰結、または下地矩形の端の正規化として表現される（`.claude/plan-wall-region.md`）。
  return result;
}
