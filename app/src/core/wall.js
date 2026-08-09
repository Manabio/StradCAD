/**
 * Wall（壁）・Opening（開口）。core.js から分離。
 */
import { makeObservable, observable, computed } from 'mobx';
import { ShapeType } from './constants.js';
import { Shape } from './shapeBase.js';
import { coordLo as _coordLo, coordHi as _coordHi } from './_internal.js';

// ----------------------------------------------------------------
// 壁: 軸 CL 参照 + オフセット + 直交 CL 参照端点
//
// 垂直壁 (isVertical=true):
//   x  = axisCL.value + axisOffset  (軸 CL は VERTICAL CL)
//   y1 = clStart.value + startOffset // clStart は HORIZONTAL CL
//   y2 = clEnd.value   + endOffset   // clEnd   は HORIZONTAL CL
//
// 水平壁 (isVertical=false):
//   y  = axisCL.value + axisOffset  (軸 CL は HORIZONTAL CL)
//   x1 = clStart.value + startOffset // clStart は VERTICAL CL
//   x2 = clEnd.value   + endOffset   // clEnd   は VERTICAL CL
// ----------------------------------------------------------------
export class Wall extends Shape {
  constructor(id, axisCL, axisOffset, isVertical, clStart, startOffset, clEnd, endOffset, props) {
    super(id, props);
    this.type        = ShapeType.WALL;
    this.axisCL      = axisCL;        // 軸 CL への参照
    this.axisOffset  = axisOffset;    // axisCL.value からの符号付きオフセット
    this.isVertical  = isVertical;
    this.clStart     = clStart;       // 始点参照 CL
    this.startOffset = startOffset;   // clStart.value からの符号付きオフセット
    this.clEnd       = clEnd;         // 終点参照 CL
    this.endOffset   = endOffset;     // clEnd.value からの符号付きオフセット
    this.isRoomWall  = props?.isRoomWall ?? false; // 部屋外周壁フラグ（chamferWalls で端点を固定）
    this.isExteriorWall = props?.isExteriorWall ?? false; // 外壁フラグ（仕上げモードの外壁ループから生成）
    // 室内側仕上げ厚(mm)。axisOffset = wallBase/2 + wallFinish の内訳のうち仕上げ側のみを保持し、
    // LOD詳細描画で「仕上げ面〜下地境界」の平行線・下地ピッチ線の位置を導出する（生成時のみ確定。null=不明・手動壁。
    // CL偏芯壁は applyCLEccentricity が随時再導出して書き換える）。
    this.wallFinish  = props?.wallFinish ?? null;
    // 下地帯中心の axisCL.value からの符号付きオフセット(mm)。偏芯壁（階段下部屋・CL偏芯等）のみ設定される。
    // null=現行（axisOffsetを中心に対称な下地帯）。生成時のみ確定（CL偏芯壁は applyCLEccentricity が再導出）。
    this.backingOffset = props?.backingOffset ?? null;
    // 下地帯の深さ(mm)。null=現行式（wallBase等から導出）。0は「下地なし＝仕上げのみの薄壁」を表す明示値。
    this.backingDepth  = props?.backingDepth ?? null;
    // 仕上げ面が向く側（±1）。CL偏芯の「仕上げ面合わせ」でCL上に面が一致し dir 導出が
    // 不能になるケースの明示指定。null=Wall.faceDir が sign(axisOffset) から導出する。
    this.finishSide  = props?.finishSide ?? null;
    makeObservable(this, {
      clStart:     observable.ref,
      clEnd:       observable.ref,
      axisOffset:  observable,
      startOffset: observable,
      endOffset:   observable,
      wallFinish:    observable,
      backingOffset: observable,
      backingDepth:  observable,
      finishSide:    observable,
      axisValue:     computed,
      coord1:        computed,
      coord2:        computed,
      materialRange: computed,
      backingRange:  computed,
      faceDir:       computed,
    });
  }

  get axisValue() { return this.axisCL.effectiveValue + this.axisOffset; }
  get coord1()    { return this.clStart.effectiveValue + this.startOffset; }
  get coord2()    { return this.clEnd.effectiveValue   + this.endOffset;   }

  /**
   * 仕上げ面が向く側（±1）。finishSide 明示指定を優先し、無ければ axisOffset の符号
   * （axisValue - axisCL.effectiveValue と同符号。axisValue = axisCL.effectiveValue + axisOffset
   * のため）。axisOffset===0（CL偏芯の仕上げ面合わせで面がCL上に一致するケース）は
   * fallback を返す。materialRange・renderer/finish/openings 各所の dir 導出を集約する単一実装。
   */
  faceDirOr(fallback = 1) { return this.finishSide ?? (Math.sign(this.axisOffset) || fallback); }
  get faceDir() { return this.faceDirOr(1); }

  /**
   * 実際に材が存在する範囲（下地帯 ∪ 仕上げ帯）を、axisCL の厚み方向座標で返す。
   * backingDepth が null（対称壁）の場合は axisValue〜axisCL.effectiveValue の対称範囲
   * （従来どおり）。backingDepth===0 は下地なし＝仕上げ帯のみ。
   * ShapesLayer の詳細LOD cap 描画、階段下壁のコーナートリム（stairUnderWalls.js）で共有する。
   * @returns {{lo:number, hi:number}}
   */
  get materialRange() {
    const axisV = this.axisCL.effectiveValue;
    const faceV = this.axisValue;
    const thickLo = Math.min(axisV, faceV), thickHi = Math.max(axisV, faceV);
    if (this.backingDepth == null) return { lo: thickLo, hi: thickHi };

    const dir = this.faceDir;
    const finBoundary = faceV - dir * (this.wallFinish ?? 0);
    const finLo = Math.min(finBoundary, faceV), finHi = Math.max(finBoundary, faceV);
    if (this.backingDepth === 0) return { lo: finLo, hi: finHi };

    const backingCenterV = axisV + (this.backingOffset ?? 0);
    const halfDepth = this.backingDepth / 2;
    return {
      lo: Math.min(backingCenterV - halfDepth, finLo),
      hi: Math.max(backingCenterV + halfDepth, finHi),
    };
  }

  /**
   * 下地帯（間柱）だけの厚み方向範囲（materialRange から仕上げ帯を除いた部分）。
   * backingDepth===0（下地なし＝仕上げのみの薄壁）は null。backingDepth/backingOffset が
   * null（対称壁の既定式）は axisCL中心・2*(全厚-wallFinish) の対称範囲
   * （ShapesLayer の詳細LOD下地描画の既定式と同じ）。wallFinish が不明（手動壁）な対称壁は
   * 算出不能のため null。壁のT字取り合い描画解決（renderer/wallJunctionResolve.js）で使う。
   * @returns {{lo:number, hi:number}|null}
   */
  get backingRange() {
    const axisV = this.axisCL.effectiveValue;
    if (this.backingDepth === 0) return null;
    if (this.backingDepth != null) {
      const center = axisV + (this.backingOffset ?? 0);
      const half = this.backingDepth / 2;
      return { lo: center - half, hi: center + half };
    }
    // 以下は axisCL中心の対称範囲を仮定するフォールバック枝。CL偏芯（finish/clEccentricity.js
    // applyCLEccentricity）が設定する壁は finishSide とともに backingOffset/backingDepth も
    // 必ず明示するため、finishSide が非nullの壁はこの枝に到達しない前提——到達すると
    // 非対称な実位置と食い違う（対称仮定が破綻する）。
    if (this.wallFinish == null) return null;
    const faceV = this.axisValue;
    const depth = 2 * (Math.abs(faceV - axisV) - this.wallFinish);
    if (!(depth > 0)) return null;
    return { lo: axisV - depth / 2, hi: axisV + depth / 2 };
  }
}

// ----------------------------------------------------------------
// 開口（建具・窓）: 壁と同じ軸CL + オフセット方式で自己完結したアンカーを持つ。
// Wall インスタンスを直接参照しない — 仕上げモード往復で壁は全削除・再生成されるため、
// 表示・編集時に「いまその場所にある壁」を openingGeometry.js の findHostWall で都度検索する。
//
//   wallSide: axisCL のどちら側か（Wall.axisOffset の符号と同義、±1）
//   refCL/refOffset: 壁の長さ方向の基準位置（通常は壁の clStart を流用）
//   hingeSide/swingSide: swing系（片開き戸等）のみ意味を持つ。それ以外は既定値を保持するだけ
//   fixtureType: 建具記号（'AW'|'JW'|'SW'|'AD'|'SD'|'WD'|'WW'|null）。null=未設定（openings/ 層がカテゴリ既定へフォールバック）
//   sillHeight: 窓台高さ(mm、FLからサッシ下端まで、null=未設定)。窓カテゴリのみ意味を持つ
//   height: 建具高さ(mm、null=未設定＝旧データ)。窓は sillHeight〜sillHeight+height が開口範囲
//   finish/materialGlass/hardware/note: 建具表の自由入力項目（string|null、null=未入力）
//   frameDepth: 見込み(mm、null=未設定)。0は不正値としてnull扱い（heightと同じ規約。openings/層で正規化）
// ----------------------------------------------------------------
export class Opening extends Shape {
  constructor(id, axisCL, wallSide, isVertical, refCL, refOffset, width, category, subType, props) {
    super(id, props);
    this.type       = ShapeType.OPENING;
    this.axisCL      = axisCL;     // 壁と同じ軸CL（壁の axisCL と同一参照）
    this.wallSide    = wallSide;   // ±1 — axisCL のどちら側の壁か（Wall.axisOffset の符号と同義）
    this.isVertical  = isVertical; // true: axisCLはVERTICAL, refCLはHORIZONTAL
    this.refCL       = refCL;      // 壁の長さ方向の基準CL（多くは壁の clStart を流用）
    this.refOffset   = refOffset;  // refCL からの符号付きオフセット(mm) — 開口中心位置
    this.width       = width;      // 開口幅(mm)
    this.category    = category;   // OpeningCategory
    this.subType     = subType;    // openingCatalog.js のキー（'singleSwing' 等）
    this.hingeSide   = props?.hingeSide ?? -1; // ±1: 蝶番側（refOffset負/正方向の端）。swing系のみ意味を持つ
    this.swingSide   = props?.swingSide ?? 1;  // ±1: 開く方向（wallSideと同じ/逆の面）。swing系のみ意味を持つ
    this.fixtureType = props?.fixtureType ?? null; // 建具記号 'AW'|'JW'|'SW'|'AD'|'SD'|'WD'|'WW'|null
    this.sillHeight  = props?.sillHeight  ?? null; // 窓台高さ(mm): FLからサッシ下端まで。窓カテゴリのみ意味を持つ
    this.height      = props?.height      ?? null; // 建具高さ(mm、開口下端から上端まで。null=未設定＝旧データ)
    this.finish        = props?.finish        ?? null; // 仕上（建具表の自由入力）
    this.materialGlass  = props?.materialGlass  ?? null; // 材料・ガラス（建具表の自由入力。記号別初期値あり）
    this.frameDepth     = props?.frameDepth     ?? null; // 見込み(mm、null=未設定)
    this.hardware       = props?.hardware       ?? null; // 金物（建具表の自由入力）
    this.note           = props?.note           ?? null; // 備考（建具表の自由入力）
    makeObservable(this, {
      axisCL:      observable.ref,
      wallSide:    observable,
      refCL:       observable.ref,
      refOffset:   observable,
      width:       observable,
      subType:     observable,
      hingeSide:   observable,
      swingSide:   observable,
      fixtureType: observable,
      sillHeight:  observable,
      height:      observable,
      finish:        observable,
      materialGlass: observable,
      frameDepth:    observable,
      hardware:      observable,
      note:          observable,
      centerCoord: computed,
      coord1:      computed,
      coord2:      computed,
    });
  }
  // 壁の「長さ方向」の座標のみ自己完結で計算できる（軸直交方向の座標はホスト壁から得る）
  get centerCoord() { return this.refCL.effectiveValue + this.refOffset; }
  get coord1()       { return _coordLo(this.centerCoord, this.width); }
  get coord2()       { return _coordHi(this.centerCoord, this.width); }
}
