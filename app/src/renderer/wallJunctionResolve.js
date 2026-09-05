import { subtractIntervals } from '../finish/stair/stairGeometry.js';
import { resolveFinVisibility, finishJoinBoundary } from '../finish/wallFinishJoin.js';

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
 * 対象は壁全般（手動壁・部屋壁・外壁・階段下壁を区別しない）。3つの独立したパスからなる。
 *
 * ## パス1: T字（貫通）取り合い — 下地を持つ壁同士のみ対象
 * - 壁A（突き当たり側）: 下地の描画範囲を、直交する壁Bの下地帯（backingRange）のうち
 *   Aが接している側の近位面まで延長する（baseExtend）。
 * - 壁B（通し壁）: Aの材幅に対応する区間で、A側の仕上げ関連要素をカットする。
 *   **仕上げ面線と仕上げ／下地境界線（fin線）は区間が異なる**——fin線はAの下地帯
 *   （backingRange。Aの内側線がちょうど下地の境界にあるため）で切る（finCuts）が、
 *   仕上げ面線はAの仕上げ面から仕上げ面まで（＝Aの物理壁の全材幅。Aが所有権ペアの
 *   一方なら反対側のペア壁の材幅も含める）で切る（faceCuts）——backingRangeで切ると
 *   Aの仕上げ帯の中へ食い込む。Bの下地帯・反対側の仕上げは連続のまま。
 * - B・Aいずれかが薄壁（backingDepth===0＝下地なし）の場合は対象外（貫通元/貫通先の
 *   下地が無い）。
 * - コーナー（Aの直交位置がBの端に近い）・X字（Aの端点がBに近くない＝Aが通り抜ける）は
 *   対象外——コーナーの取り合いはパス2の守備範囲。
 *
 * ## パス2: コーナー（出隅・入隅・十字）取り合い — 仕上げ厚が確定した壁全般が対象
 * ユーザー確定仕様: 「壁同士がT字・十字に取り合う時、交差面にある壁仕上げ材の2本の線は、
 * 内側同士・外側同士の線が取り合う」（L字の部屋の隅も含め、壁が角度をもって取り合う箇所
 * すべてに適用。角のキャップ線は消す）。外側線（仕上げ面線）は相手の外側線と角で既に
 * 合っている（closeConvexCorners・各種トリムが端点をそこへスナップ済み）ため現状維持。
 * 対象は内側線（fin線）で、**その端点を相手の内側線の位置
 * （＝相手のfaceValue − 相手のfaceDir × 相手のwallFinish。ShapesLayerの`boundary`と同じ式）
 * へ置く**（finEnd。2026-09ユーザー確定: 入隅では延長、出隅では短縮になる——どちらも
 * 「内側線同士を交点で合わせる」という同じ規則の帰結）。薄壁（backingRangeなし）もここでは
 * 対象——実際の出隅・入隅の多くは薄壁の面同士が向き合う形で現れる。
 *
 * 入隅・出隅は「この壁の端点が直交壁のどちらの面に一致するか」で見分ける、**別々の述語**
 * として書く。**値としては同じになる**——core/wall.js の materialRange の3分岐
 * （対称/薄壁/下地オーナー、finishSide明示の偏芯壁を含む）はどれも、faceDir方向の遠位端が
 * 常にfaceValueそのものになるよう作られている（owner±/thin±/対称/偏芯の6型で数値確認済み）
 * ため、「materialRangeの遠位面」と「faceValue」は乖離しない。それでも2つに分けて書くのは、
 * **closeConvexCorners（finish/wallGeneration.js）が出隅を判定する条件と同じ語彙で意図を
 * 明示するため**——実際に入隅と出隅を分けているのは値の違いではなく`dir === b.faceDir`
 * かどうかだけであり、これを2つの述語（「faceValueに一致」「materialRangeの遠位面に一致」）
 * として書くことで、どちらの分岐が出隅由来かをコード上で追える:
 * - **入隅（concave）**: この壁の端点が直交壁の**仕上げ面(faceValue)**に一致する
 *   （既存の判定式のまま）。この壁は直交壁の外側に接するだけで材を貫かないため、内側線は
 *   そこから相手の内側線の位置までさらに**延長**する（`dir*(target-coord)>0`のときだけ
 *   採用——後述のTOUCH_TOLERANCEの都合で、この方向ガードを外すと誤検出する）。
 * - **出隅（convex）**: この壁の端点が直交壁の**材の遠位面
 *   （dir>0ならmaterialRange.hi、dir<0ならmaterialRange.lo。closeConvexCornersの`farFace`と
 *   同じ式）**に一致する。closeConvexCornersが壁生成時点でここまで物理端を伸ばし切って
 *   角の欠けを塞いでいるため、この壁は直交壁の材をまるごと貫通しており、内側線は逆に
 *   相手の内側線の位置まで**短縮**する必要がある（`dir*(target-coord)<0`のときだけ採用）。
 * この2つは`dir`（この端が伸びる向き）と直交壁の`faceDir`の関係で機械的に排他になる
 * （`dir===faceDir`なら出隅、`dir===-faceDir`なら入隅——一方の壁が直交壁の面が向く側と
 * 同じ側から到達するか逆側からかで、貫通する/しないが決まるため）。**出隅ではcapSuppressを
 * 立てない**（キャップ線の扱いは現状維持。ユーザー確定仕様は入隅のキャップ抑止のみ）。
 *
 * **方向ガードは省略できない**: TOUCH_TOLERANCE(30mm)はwallFinish(標準12.5mm)より大きく、
 * touchチェック（|coord-faceValue|<=30等）だけでは「本当に flush か、相手の面を最大27.5mm
 * 行き過ぎ/手前で終端しているだけか」を区別できない。行き過ぎ/手前の壁を方向ガード無しで
 * 通すと、入隅のつもりが短縮になったり出隅のつもりが延長になったりして内側線が壊れる
 * （実バグとして再現・修正済み）。
 *
 * 同じ端に複数の候補（入隅・出隅の両方、または複数のB）が競合した場合のタイブレーク
 * （`dir*(target-cur)>0`で上書き）は「dirの向きに最も進んだ値」を採る——出隅（短縮）同士が
 * 競合する場合は結果的に「最も短縮しない（=coordに最も近い）相手」を選ぶ形になる。これが
 * 問題になるのは複数のB候補の面同士がTOUCH_TOLERANCE以下（60mm未満）しか離れていない退化
 * 配置に限られ、標準寸法（オーナー面と薄壁面はaxisOffsetが±57.5で計115mm離れる）では
 * 起こらない。
 *
 * どちらの述語も「直交壁の長さ方向スパンがこの壁の厚み方向位置（faceValue）を含む」ことを
 * 前提とする（すれ違い除外。たまたま値が一致するだけで実際には離れた位置にある壁を弾く）。
 * この述語は「相手のスパンが自分のfaceValueを含むか」で判定する（内側線=fin位置ではなく）
 * ——相手のスパン端は既存トリムによって自分のfaceValueと厳密一致するよう作られているが、
 * fin位置は仕上げ厚ぶんのオフセットが乗るため、こちらを基準にすると許容差の取り方次第で
 * 不安定になる。
 *
 * ## パス3: fin線の直交壁下地貫通防止 — T字の分類に依存しない幾何のみの判定
 * 2026-09ユーザー確定仕様「fin線（仕上げ／下地の境界線）は、直交する壁の下地を横切る区間を
 * 描かない」。パス1のfinCutsはT字の分類（コーナー除外・突き当たり判定・両壁に下地が要る等）
 * で入口を絞っているため、同じ物理状況（fin線が直交壁の下地を通過する）でも分類から外れる
 * 配置（出隅など）では発火しない。パス3はT字/コーナーの区別をせず、幾何だけで判定する:
 * 壁W（fin線を持つ側）のfinBoundaryに対し、直交する壁V（下地を持つもののみ。薄壁は貫通先の
 * 下地が無いため対象外——今回入れた入隅の12.5mm延長を保つ）の「描画上の下地の長さ方向範囲」
 * （V自身のcoord1..coord2を、パス1が計算したVのbaseExtendで延長したもの——**生のcoordでは
 * なく延長後を使う**必要がある。Aが Bへ突き当たる古典的T字では、Aのcoordは Bの仕上げ面で
 * 止まり、下地だけがbaseExtendでBの下地まで伸びるため、生のcoordだと本来カット済みの
 * 配置まで見逃す）がWのfinBoundaryを厳密内側に含み、**かつfbに近い側のVの端点がWの材
 * (materialRange)からTOUCH_TOLERANCE以内にある**なら、VのbackingRange（厚み方向）をWの
 * fin線から差し引く（finCutsへ追加）。後者の「端の近さ」条件が無いと、Vが単にWを素通りする
 * 配置（X字。Vの端点がWから遠く離れて通過するだけ）まで拾ってしまう（実バグとして
 * 再現・修正済み——既存のX字失敗系テストが検出する）。この判定はパス1と同じ語彙
 * 「Vの端点がWの材にflushで触れているか」に揃えている——**「fbからVの端までの距離」を
 * TOUCH_TOLERANCEと比較する初期実装は誤りだった**（2026-09 QA指摘）: 出隅の代表例では
 * closeConvexCornersがVの端点をWのaxisValueへスナップするため、この距離は常にWの
 * wallFinishそのものと一致し、実質「Wの仕上げ厚が30mm以下」というガードになってしまう。
 * fin線が下地を横切る量は仕上げ厚に関係なく常にbackingDepthぶん一定なので、仕上げ厚が
 * 30mmを超える壁（せっこうボード+外壁石材等でUIから到達可能）ではガードが誤って沈黙し、
 * ユーザー確定の不良がそのまま再発する。materialRangeは仕上げ厚に応じて伸縮するため、
 * この比較なら仕上げ厚の大小に関わらず正しく機能する。
 *
 * **パス1のfinCutsを置き換えず追加する（和集合）**——標準的なT字の入口条件（Aの端点がBの
 * 材にflushで触れ、baseExtendがAをBのbackingLo/Hiまで伸ばす）では、core/wall.jsの
 * materialRange/backingRangeの構造上、Aの延長先は常にBのfinBoundaryとちょうど一致し
 * （finBoundaryはbackingLo/Hiの一方と定義上同じ値になる）、厳密内側の条件を満たさない
 * ——つまりパス3は標準的なT字では発火せず、パス1の挙動と衝突しない。パス3が新たに拾うのは
 * パス1が対象外にする配置（出隅の食い込み等）だけであり、置き換えるとパス1がカバーする
 * 「ちょうど境界に触れるだけ」の標準ケースを取りこぼす。
 *
 * **例外: 外壁（isExteriorWall）どうしの組はパス3の対象外**（2026-09ユーザー確定：外壁出隅
 * でも下地側の仕上げ線が角で取り合うべき）。外壁の仕上げは建物の外周を一続きに回り込む
 * 1枚の皮であり、その2本の境界線（fin線）は出隅で角を回って取り合う——パス2が両側の
 * finEndを互いの内側線の交点へ既に合わせているため、そこへパス3の切り欠きを適用すると
 * 合流点の手前でfin線が途切れる回帰になる（実機指摘で発見）。一方、室内壁どうしの出隅は
 * 別々の部屋の仕上げ材が単に突き合うだけで、パス3導入の動機（fin線が直交壁の下地を
 * 横切ってはならない）がそのまま当てはまるため除外しない。区別の軸は**外壁か室内壁か**
 * であり、両方が外壁の組み合わせだけを`&&`で除外する（片方だけ外壁の組は従来どおり対象）。
 */

// 「壁の端点が相手壁のfaceValueに触れている」とみなす許容差(mm)。
// 既存トリムは理論上ゼロ誤差でface位置へスナップするため小さい値で足りるが、
// 厳密スナップを経ていない壁（未トリムの手動壁等）も拾えるよう、代表的な仕上げ厚
// オーダー（DEFAULT_WALL_FINISH 相当。wallGeneration.js 参照）を許容差とする。
// 150mm（パス1のコーナー除外・近接候補探索の許容差）より意図的に小さくし、「明確に
// 離れている（デザイン上の隙間）」壁を誤って取り合い扱いしないようにする。
const TOUCH_TOLERANCE = 30; // mm

// パス1専用: 「Aの直交位置がBの端に近い＝コーナー」とみなす距離。コーナーの取り合いは
// パス2の守備範囲であり対象外にする。trimIntersectingWalls/trimStairUnderJunctions の
// 近接判定tolerance（150mm）と揃え、トリム側が「コーナー」と判定する範囲とこの描画側の
// 除外範囲を一致させる（トリムがコーナー処理した壁を、ここでT字として誤検出しないため）。
const CORNER_EXCLUSION = 150; // mm

// fin線（内側線）の位置・可視性と、取り合い先（相手の内側線の位置）は
// finish/wallFinishJoin.js が唯一の供給源——柱の仕上げ包み（finish/columnWrap.js）と
// **同じ経路**を通す（判定を変えるときはあちらのファイルだけを直す）。ENDPOINT_EPS は
// ShapesLayer.jsx のecap判定が本モジュール経由で引いているため再輸出する。
export { ENDPOINT_EPS, resolveFinVisibility } from '../finish/wallFinishJoin.js';

// 壁1本分のビュー（POJO スナップショット）。
// この解決は壁の総当たり（O(壁²)）で、内側で読む `materialRange` / `backingRange` /
// `axisValue` / `coord1,2` / `faceDir` / `wallFinish` はすべて MobX の computed（または
// フィールド）。実データ規模だとこの読み出し自体が支配的なコストになる（実測）ため、
// 値を1回だけコピーして二重ループはそれを見る（finish/columnWrap.js の壁ビューと同じ手口）。
function makeView(w) {
  const backing = w.backingRange;
  const { finBoundary, finVisible } = resolveFinVisibility(w);
  return {
    id: w.id,
    isVertical: w.isVertical,
    isExteriorWall: w.isExteriorWall ?? false,
    lenLo: Math.min(w.coord1, w.coord2), lenHi: Math.max(w.coord1, w.coord2),
    axisValue: w.axisValue,
    axisCLValue: w.axisCL?.effectiveValue,
    faceDir: w.faceDir,
    wallFinish: w.wallFinish,
    materialRange: w.materialRange,
    finBoundary,
    finVisible,
    backingLo: backing ? Math.min(backing.lo, backing.hi) : null,
    backingHi: backing ? Math.max(backing.lo, backing.hi) : null,
  };
}

// パス1のfaceCuts用: 壁Aの「全材幅（仕上げ面から仕上げ面まで）」を、同一の通り（同じ
// isVertical・同じ軸CL座標）で長さ方向スパインが重なり、faceDirが逆向きの相棒壁
// （所有権ペアの反対側＝thin側）があればその materialRange も含めて返す。相棒が無ければ
// Aの単独 materialRange のまま（それでも従来のbackingRangeより仕上げ帯ぶん広く、
// 「12.5mmの食い込み」自体は解消する）。
const AXIS_EPS = 0.5; // mm
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
 * 壁配列から取り合い（T字・コーナー）を検出し、壁ID → 描画調整のMapを返す。
 * @param {import('@core').Wall[]} walls
 * @returns {Map<string, {
 *   baseExtend:{lo?:number,hi?:number},
 *   faceCuts:[number,number][],
 *   finCuts:[number,number][],
 *   finEnd:{lo?:number,hi?:number},
 *   capSuppress:{lo?:boolean,hi?:boolean},
 * }>}
 */
export function resolveWallTJunctions(walls) {
  const result = new Map();
  const ensure = (id) => {
    if (!result.has(id)) {
      result.set(id, { baseExtend: {}, faceCuts: [], finCuts: [], finEnd: {}, capSuppress: {} });
    }
    return result.get(id);
  };

  // 仕上げ厚が確定した壁全般（パス2の候補。薄壁も含む）を向きで二分する。
  const allVerticals = [], allHorizontals = [];
  for (const w of walls) {
    if (w.wallFinish == null) continue; // 仕上げ厚不明（手動壁で寸法未確定）は対象外
    const view = makeView(w);
    (view.isVertical ? allVerticals : allHorizontals).push(view);
  }

  // ---- パス1: T字（貫通）取り合い。下地を持つ壁同士だけが対象 ----
  const verticals = allVerticals.filter(v => v.backingLo != null);
  const horizontals = allHorizontals.filter(v => v.backingLo != null);

  for (const [sameDir, crossDir, group] of [
    [verticals, horizontals, allVerticals],
    [horizontals, verticals, allHorizontals],
  ]) {
    for (const a of sameDir) {
      const alo = a.lenLo, ahi = a.lenHi;
      const aBackingLo = a.backingLo, aBackingHi = a.backingHi;
      const aFaceRange = fullFaceRange(a, group);

      for (const b of crossDir) {
        const blo = b.lenLo, bhi = b.lenHi;
        const aAxisPos = a.axisValue; // Aの厚み方向位置 = Bの長さ方向での占有位置

        // コーナー除外: Aの直交位置がBの両端の近く（CORNER_EXCLUSION以内）ならコーナー扱い
        if (aAxisPos <= blo + CORNER_EXCLUSION || aAxisPos >= bhi - CORNER_EXCLUSION) continue;

        const bRange = b.materialRange;

        for (const [end, coord, anchor] of [['lo', alo, ahi], ['hi', ahi, alo]]) {
          // Aのこの端点がBの材(materialRange)に触れているか（X字＝Aが素通りする場合は
          // どちらの端点もBの材に近くならないため、この判定だけで自然に除外される）
          if (coord < bRange.lo - TOUCH_TOLERANCE || coord > bRange.hi + TOUCH_TOLERANCE) continue;

          // B側: Aの本体がBの仕上げ面側にあるときだけカットする——反対側（軸〜下地側。
          // 例: 1部屋が複数部屋に面する通し壁で、向かい側の部屋を区切る壁が軸CL位置へ
          // 突き当たるケース）から触れるAはBの仕上げ層を貫通しないため、仕上げ面線は
          // 連続のまま残す（カットすると突き当たり位置で反対側の仕上げ材が分断されて見える）。
          // bodySide===0（anchorがB軸上＝判定不能の退化）は従来どおりカットする。
          const bodySide = Math.sign(anchor - b.axisCLValue);
          if (bodySide === 0 || bodySide === b.faceDir) {
            const rec = ensure(b.id);
            rec.finCuts.push([aBackingLo, aBackingHi]);
            rec.faceCuts.push([aFaceRange.lo, aFaceRange.hi]);
          }

          // A側: Bの下地帯のうち、Aが接している側（bRangeのlo寄りかhi寄りか）の面を延長先にする
          const fromLoSide = Math.abs(coord - bRange.lo) <= Math.abs(coord - bRange.hi);
          const target = fromLoSide ? b.backingLo : b.backingHi;

          // target が現端点(coord)よりさらに外側（anchorの反対方向）にある場合のみ延長する
          // （既にBの下地近位面を超えている等のケースでは縮めない＝現状維持）
          const dir = Math.sign(coord - anchor) || 1;
          if (dir * (target - coord) > 0) {
            ensure(a.id).baseExtend[end] = target;
          }
        }
      }
    }
  }

  // ---- パス3: fin線の直交壁下地貫通防止（T字分類非依存。モジュールヘッダ参照） ----
  // Vはverticals/horizontals（パス1と同じ下地保有フィルタ）に限定——薄壁は対象外。
  // Wはfinが可視な壁のみ（finVisible===falseは描かれる線が無く判定が無意味）。
  // 「fbがVの範囲に含まれる」だけでは、Vが単にWを素通りする配置（X字。Aの端点がBから
  // 遠く離れて通過するだけの配置）まで拾ってしまう——実バグ再現テストで確認済み
  // （X字テストのAはBを7000mm近く素通りし、Bのfin位置はAの端から2000mm以上離れているのに
  // 含有条件だけでは true になる）。除外はパス1と同じ語彙「Vの端がWの材(materialRange)に
  // 触れているか」に揃える（2026-09 QA指摘で是正——旧実装は「fbからVの端までの距離」を
  // TOUCH_TOLERANCEと比較していたが、出隅ではこの距離が常にWの仕上げ厚(wallFinish)そのもの
  // と一致するため、実質「Wの仕上げ厚が30mm以下」というガードになってしまい、厚い仕上げ
  // （せっこうボード+石材等で30mm超）で本来のバグがそのまま再発していた）。
  for (const [wGroup, vGroup] of [[allHorizontals, verticals], [allVerticals, horizontals]]) {
    for (const w of wGroup) {
      if (!w.finVisible) continue;
      const fb = w.finBoundary;
      const mr = w.materialRange;
      for (const v of vGroup) {
        // 向きで二分している（wGroup/vGroupが常に異なるisVerticalの組）ため到達しないが、
        // 将来wGroupの取り方を広げた場合の保険として残す。
        if (v.id === w.id) continue;
        // 外壁どうしの出隅は除外する（2026-09ユーザー確定）: 外壁の仕上げは建物の外周を
        // 一続きに回り込む1枚の皮であり、その2本の境界線（fin線）は出隅で角を回って
        // 取り合う——パス2が両側のfinEndを互いの交点へ合わせているため、パス3で下地帯を
        // 切り欠くと合流点の手前でfin線が途切れる（実機再現。角の交点に届かなくなる）。
        // 一方、室内壁どうしの出隅は別々の部屋の仕上げ材が単に突き合うだけで、パス3導入の
        // 動機だった「直交壁の下地を横切る」問題がそのまま当てはまるため除外しない。
        // 判定は`&&`（両方とも外壁の組み合わせのみ除外）——片方だけ外壁（外壁と室内壁が
        // 取り合う一般的なT字・出隅）は従来どおり切り欠く。
        if (w.isExteriorWall && v.isExteriorWall) continue;
        const ext = result.get(v.id)?.baseExtend;
        const vLo = ext?.lo != null ? Math.min(v.lenLo, ext.lo) : v.lenLo;
        const vHi = ext?.hi != null ? Math.max(v.lenHi, ext.hi) : v.lenHi;
        if (fb <= vLo || fb >= vHi) continue;
        // X字（素通り）除外: fbに近い側のVの端点が、Wの材(materialRange)からTOUCH_TOLERANCE
        // を超えて離れていれば、Vは単にWを素通りするだけ（Vの端はWとは無関係などこか遠くに
        // ある）とみなす。
        const nearEnd = Math.abs(fb - vLo) <= Math.abs(fb - vHi) ? vLo : vHi;
        if (nearEnd < mr.lo - TOUCH_TOLERANCE || nearEnd > mr.hi + TOUCH_TOLERANCE) continue;
        ensure(w.id).finCuts.push([v.backingLo, v.backingHi]);
      }
    }
  }

  // ---- パス2: コーナー（出隅・入隅・十字）取り合い。仕上げ厚確定なら薄壁も対象 ----
  // finVisible（resolveFinVisibility。自壁・相手壁の両方）を要求する——wallFinish>0だけを
  // 見ると、|axisOffset|===wallFinishの薄壁（内側線が軸CL上に潰れる。stairUnderWalls.js
  // ルール2の階段下部屋外側仕上げ薄壁が実際に生成する形状）でfin線自体が描かれないのに
  // finEnd/capSuppressだけ立ってしまい、端にcapもfinも無くなる（実バグとして発生・修正済み）。
  for (const [sameDir, crossDir] of [[allVerticals, allHorizontals], [allHorizontals, allVerticals]]) {
    for (const a of sameDir) {
      if (!a.finVisible) continue;
      const alo = a.lenLo, ahi = a.lenHi;

      for (const b of crossDir) {
        // 置き先: Bの内側線の位置（取り合いの規則は finish/wallFinishJoin.js が唯一の
        // 供給源。柱の仕上げ包み＝finish/columnWrap.js と同じ経路を通す）。fin線が描かれない
        // 壁とはそもそも取り合わない＝null。
        const target = finishJoinBoundary(b);
        if (target == null) continue;
        const blo = b.lenLo, bhi = b.lenHi;

        // すれ違い除外: Bの長さ方向スパンがAの厚み方向位置（faceValue）を含まない＝
        // 値がたまたま一致しても実際には離れた位置にあるBは対象外。
        if (a.axisValue < blo - TOUCH_TOLERANCE || a.axisValue > bhi + TOUCH_TOLERANCE) continue;

        for (const [end, coord, anchor] of [['lo', alo, ahi], ['hi', ahi, alo]]) {
          const dir = Math.sign(coord - anchor) || 1;

          // 入隅・出隅は別々の述語で判定する（モジュールヘッダ参照）。dirとBのfaceDirの
          // 関係で機械的に排他: dir===faceDirなら出隅（この壁がBを貫通済み）、
          // dir===-faceDirなら入隅（この壁はBの外側に接するだけ）。
          const isConvex = dir === b.faceDir;
          if (isConvex) {
            // 出隅: この壁の端点がBの材の遠位面（closeConvexCornersのfarFaceと同じ式）に
            // 一致しているか。
            const farBound = dir > 0 ? b.materialRange.hi : b.materialRange.lo;
            if (Math.abs(coord - farBound) > TOUCH_TOLERANCE) continue;
          } else {
            // 入隅: この壁の端点がBの仕上げ面(faceValue)に一致しているか（既存の判定式）。
            if (Math.abs(coord - b.axisValue) > TOUCH_TOLERANCE) continue;
          }

          // 方向ガード（入隅・出隅で別々に必須）: TOUCH_TOLERANCE(30mm)はwallFinish(標準
          // 12.5mm)より大きく、touchチェックだけでは二値化しない——相手の面を最大27.5mm
          // 行き過ぎて終端する壁も入隅touchを通ってしまい、方向を見ずに置き換えると
          // 内側線が本来と逆に短縮される（出隅も同様に逆へ延長されうる）。入隅は必ず
          // 延長（dir*(target-coord)>0）、出隅は必ず短縮（dir*(target-coord)<0）になる
          // はずなので、それぞれ逆向きの結果が出た場合は誤検出として捨てる。境界
          // delta===0（内側線が既にtarget位置にあり動かす必要が無い）はどちらの式でも
          // 不採用（安全側）——キャップだけ残る自由端相当として扱う。
          const delta = dir * (target - coord);
          if (isConvex ? !(delta < 0) : !(delta > 0)) continue;

          const rec = ensure(a.id);
          const cur = rec.finEnd[end];
          if (cur == null || dir * (target - cur) > 0) {
            rec.finEnd[end] = target;
            // 出隅ではキャップ線の扱いを変えない（現状維持。ユーザー確定仕様は入隅のみ）。
            // 上書き時も必ず再設定する（設定のみだと、先に入隅候補がcapSuppressを立てた後
            // 別候補が勝ってもtrueが残ってしまう——現状の方向ガードの下では入隅が出隅に
            // 負けることはない※が、タイブレークの実装に依存しない防御として明示的に書く）。
            // ※証明: dir>0なら入隅のtargetは常にcoordより大きく出隅のtargetは常にcoordより
            // 小さい（両ガードの定義より）ため、タイブレークの処理順に関わらず入隅が必ず勝つ。
            rec.capSuppress[end] = !isConvex;
          }
        }
      }
    }
  }

  return result;
}

/**
 * fin線（仕上げ／下地の境界線）のセグメント配列を解決する。ShapesLayer.jsx が下していた
 * 「端点をどこに置くか・どこを切り欠くか」の判断をここへ集約し、.jsx は結果を写像するだけに
 * する。
 *
 * `finEnd`は**延長とは限らず短縮もありうる**（入隅=延長・出隅=短縮。2026-09ユーザー確定
 * 「内側線の端点は相手壁の内側線の平面に置く」）。そのため`Math.min`/`Math.max`で外側へ
 * 広げるだけでは短縮を表現できず、**端点をfinEndの値へ置き換える**（ただし以下の場合は
 * 置き換えない）:
 * - **そのセグメントが実際に壁の物理端(lo/hi)から始まっていない場合**——壁端にちょうど
 *   接する開口があると、開口で分割された最初/最後のセグメントは物理端から始まらない
 *   （例: lo=0側に開口[0,800]があると、生き残る最初のセグメントは[800,…]から始まり
 *   lo=0には触れない）。セグメント配列中の「先頭/末尾」というインデックスだけで判定すると、
 *   この場合も置き換えてしまい、fin線が開口を横断して描かれる。
 * - **柱壁カット（columnFinCuts）が物理端に接する区間を含む場合**——延長するケースでは
 *   柱の仕上げ包みの外側に孤立した短い切れ端が残る（先に置き換えてから柱カットで切り欠くと、
 *   延長分だけが柱カットの外側に取り残されるため）。
 * - **置き換えた結果、そのセグメントの lo > hi に反転する場合**——直交壁が自分のスパンの外に
 *   あるような退化した配置で短縮量が壁の長さを超えると起こりうる。反転するくらいなら
 *   両端とも変更しない（元のセグメントのまま安全側に倒す）。
 *
 * @param {{
 *   segments:[number,number][], lo:number, hi:number,
 *   finEnd:{lo?:number,hi?:number}, finCuts:[number,number][], columnFinCuts:[number,number][],
 * }} params
 * @returns {[number,number][]}
 */
export function resolveWallFinSegments({ segments, lo, hi, finEnd, finCuts, columnFinCuts }) {
  const fin = finCuts ?? [];
  const colFin = columnFinCuts ?? [];
  const touchesEnd = (cuts, end) => cuts.some(([c0, c1]) =>
    end === 'lo' ? (c0 <= lo && c1 > lo) : (c1 >= hi && c0 < hi));
  const canSetLo = finEnd?.lo != null && !touchesEnd(colFin, 'lo');
  const canSetHi = finEnd?.hi != null && !touchesEnd(colFin, 'hi');

  const placed = segments.map(([a, b], i, arr) => {
    const na = i === 0 && a <= lo && canSetLo ? finEnd.lo : a;
    const nb = i === arr.length - 1 && b >= hi && canSetHi ? finEnd.hi : b;
    return na > nb ? [a, b] : [na, nb]; // 反転するなら安全側（元のまま）に倒す
  });
  const extraCuts = [...fin, ...colFin];
  return extraCuts.length === 0 ? placed
    : placed.flatMap(([a, b]) => subtractIntervals(a, b, extraCuts));
}

/**
 * cap線（妻線）をこのセグメント境界で描かないか。baseExtend（T字通し壁への下地貫通）または
 * capSuppress（コーナー取り合いで内側線が角で合流）のいずれかが立つ端かつ、自壁の物理両端
 * （最初のセグメントの始点＝lo端／最後のセグメントの終点＝hi端）でのみ抑止する
 * （開口で分割された中間セグメント境界は対象外）。
 * @param {'lo'|'hi'} end
 * @param {number} i - segments配列中のこのセグメントのインデックス
 * @param {number} segCount - segments配列の長さ
 * @param {{baseExtend:{lo?:number,hi?:number}, capSuppress:{lo?:boolean,hi?:boolean}}} params
 * @returns {boolean}
 */
export function isCapSuppressed(end, i, segCount, { baseExtend, capSuppress }) {
  if (end === 'lo') return i === 0 && (baseExtend?.lo != null || !!capSuppress?.lo);
  return i === segCount - 1 && (baseExtend?.hi != null || !!capSuppress?.hi);
}
