/**
 * 構造モードの「解決コンテキスト」（構造再計算高速化・ステップB-2、2026-09-21）。
 *
 * 背景: 1回の境界処理（構造モード突入・他階への反映・仕上げ脱出後の反映等）の中で、同じ
 * 非アクティブ階を floorSwapManager.peek（IDB読込→restoreGraph→heal）で何十回も読み直している
 * （moku5実測: 初回突入でpeek 98回・約1000ms）。本モジュールは「1回の境界処理」の間だけ各階の
 * peek結果を使い回すための明示的なコンテキストオブジェクトを提供する。
 *
 * ユーザー裁定（2026-09-21）——この設計が従う規律:
 *   1. 明示的な引数でのみ渡す。floorSwapManager.peek自体は変えない。モジュール変数・WeakMap・
 *      graphへのプロパティ付与・composition/React stateへの保持は禁止（保持の生存期間を
 *      呼び出し側のスコープでしか区切れない設計にするため）。
 *   2. 寿命は1回の境界処理。生成した側が try/finally で必ず dispose() する。
 *   3. 保存は現行どおり即時書込み（デバウンス・バッチ化はしない）。
 *   4. 他者の書込みは「階ごとの書込み世代」（storage/floorWriteGeneration.js）の変化で検知して
 *      保持を捨てる（floorsストアを書く全経路を個別に列挙しない）。
 *   5. アクティブ階の扱いは現行のまま——対象が非アクティブ階のときだけ本コンテキストを介する
 *      （buildStructuralWallGateのgraphFor等「主題階はactiveGraphそのまま・他はpeek」という
 *      既存の分岐はそのまま。本コンテキストはpeek側だけを差し替える）。
 *   6. 図面合成の下階バインディング（FigureBindingManager.activate の編集可能peek）は対象外
 *      （別の生存期間・書込みチャネルを持つため、このコンテキストを使わない）。
 *   7. 破棄後に使われた場合は例外にせず、console.warnを1回だけ出してから現行のpeekへ
 *      フォールバックする（storage/db.js・storage/sessionLock.js・structuralOrchestration.js
 *      MAX_REFLECT_PASSESと同じ「フォールバックしつつ警告する」流儀）。
 *
 * 旧裁定「非アクティブ階のgraphは常に1階分だけ生かす」（structuralOrchestration.js
 * reflectStructuralToOtherFloors・recomputeInactiveStructuralのJSDoc参照）は、本コンテキストの
 * 導入により「1回の境界処理の間は複数階分のpeek結果を保持してよい」へ改める（2026-09-21）。
 * 生成・注入するのは structuralOrchestration.js の境界処理（runStructuralModeSetup・
 * reflectStructuralToOtherFloors・reflectStructuralAfterFinishExit・reflectStructuralAfterFloorAdd。
 * withResolveContext の3値規約＝省略なら自前生成して破棄・明示なら借り物・nullなら従来経路）。
 * 1回の反映処理につきコンテキスト1個（突入は内側の反映へ自分のコンテキストを渡す）。
 *
 * 世代検知の設計（graphFor）: 保持エントリの gen と現在の世代が一致すればヒット。不一致（無し／
 * 他者が書いた）ならpeekし直す。peekは非同期のため、await中に他者が書く窓が生じうる——
 * 「peek開始直前に読んだ世代」と「peek完了直後に読んだ世代」を比較し、一致したときだけ保持する。
 * 不一致（await中に割り込まれた）の場合は保持せずそのまま返す（読み直しはしない）——理由:
 *   (a) 単純さ。書込み圧力が続く限りの無限リトライを避けられる。
 *   (b) 正しさは損なわれない。返す値は実際にIDBから読んだ内容であり、次回のgraphForが
 *       最新世代で改めてpeekし直すため、「保持して使い回す」場合と比べて安全側に倒れる
 *       （このコンテキストが無い現行のfloorSwapManager.peek直呼びと同じ最終的な正しさ）。
 *
 * 世代文字列の形式には依存しない（floorWriteGeneration.jsの契約どおり `===` 比較のみで使う）。
 * saveAndNote の「自分の保存で1回分だけ世代が進んだか」の判定も、文字列を解釈せず
 * 「保存呼び出し直後（awaitの前）に読んだ世代」と「保存完了後に読んだ世代」を比較するだけで行う
 * （呼び出しから完了までの間に他者の書込みが割り込まなければ両者は一致する。storage/db.js
 * saveFloorはnoteFloorWriteを関数の同期区間・最初のawaitより前で呼ぶため、この比較で捕捉できる）。
 *
 * 葉モジュールに準じる（store.js/snap.js/.jsxを引かない）——node:testから単体importできるように
 * するため。peek呼び出しの入口 peekVia は structuralPeek.js に置く（wallGate.js・wallBeamAxes.js が
 * それを import し、本ファイルはその両者の cache ファクトリを import するため、同じファイルに
 * 置くと循環importになる）。
 */
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { floorWriteGeneration } from '../storage/floorWriteGeneration.js';
import { saveFloor } from '../storage/db.js';
import { createWallSourceCache } from './wallBeamAxes.js';
import { createFootprintCache } from './wallGate.js';

class StructuralResolveContext {
  constructor({
    peek = (plane, structGraph) => floorSwapManager.peek(plane, structGraph),
    generationOf = floorWriteGeneration,
    save = saveFloor,
  } = {}) {
    this._peek = peek;
    this._generationOf = generationOf;
    this._save = save;
    this._held = new Map(); // planeId → { graph, gen }
    this._inflight = new Map(); // planeId → 進行中の読み（Promise）
    this._disposed = false;
    this._warnedAfterDispose = false;
    // ステップC/Aのキャッシュ（壁区間・フットプリント索引）。structuralRecompute.js
    // recomputeStructuralForGraphがoptions.wallSourceCache/footprintCacheを省略した呼び出しで
    // これを使い回す（ステップB-6）——寿命が「1回のrecompute呼び出し」から「このコンテキストが
    // 生きている間＝1回の境界処理」へ広がる。
    this.wallSourceCache = createWallSourceCache();
    this.footprintCache = createFootprintCache();
    this.stats = { peek: 0, hit: 0, invalidated: 0 };
  }

  /** 規律7: 破棄後に使われた場合、console.warnを1回だけ出す（インスタンス単位）。 */
  _warnOnceAfterDispose() {
    if (this._warnedAfterDispose) return;
    this._warnedAfterDispose = true;
    console.warn('[structuralResolveContext] dispose()後にgraphForが呼ばれました。保持を使わず現行のpeekへフォールバックします。');
  }

  /**
   * 対象階のgraphを返す（peekVia経由の唯一の入口）。保持が新鮮ならpeekせずそれを返す。
   * @param {object} plane
   * @param {object} structGraph
   * @returns {Promise<object|null>}
   */
  async graphFor(plane, structGraph) {
    if (this._disposed) {
      this._warnOnceAfterDispose();
      return this._peek(plane, structGraph);
    }
    const planeId = plane.id;
    const held = this._held.get(planeId);
    if (held && held.gen === this._generationOf(planeId)) {
      this.stats.hit++;
      return held.graph;
    }
    if (held) {
      // 保持していたが世代不一致（他者がその後この階のfloorsを書いた）——古いコピーを返さず読み直す。
      this._held.delete(planeId);
      this.stats.invalidated++;
    }
    // 同じ階の読みが進行中ならそれを共有する——並行して別々にpeekすると、同じ階の別インスタンスが
    // 2つ流通し、片方への変異が保持から外れる（呼び出し側は1インスタンスを前提に変異・保存する）。
    const inflight = this._inflight.get(planeId);
    if (inflight) return inflight;
    const reading = this._peekAndHold(plane, structGraph);
    this._inflight.set(planeId, reading);
    try {
      return await reading;
    } finally {
      this._inflight.delete(planeId);
    }
  }

  async _peekAndHold(plane, structGraph) {
    const planeId = plane.id;
    const genBeforePeek = this._generationOf(planeId);
    this.stats.peek++; // 試行回数（throwしたpeekも1回に数える）
    const graph = await this._peek(plane, structGraph);
    if (graph == null) return graph; // peekが null を返した場合は保持せずそのまま伝える（throwは素通し）
    const genAfterPeek = this._generationOf(planeId);
    if (!this._disposed && genAfterPeek === genBeforePeek) {
      this._held.set(planeId, { graph, gen: genAfterPeek });
    }
    // else: peekのawait中に他者が書いた（または破棄された）——この読みを「最新」として保持し続けない
    // （上記JSDoc参照）。
    return graph;
  }

  /**
   * 自分の保存。保持エントリがあり、保存の間に他者の割込みが無ければ新鮮のまま gen だけ更新する
   * （同じ graph インスタンスを保持し続ける＝直後の graphFor が読み直さない）。割込みがあれば
   * 保持を捨てる（次の graphFor が読み直す）。
   * **graph には bytes の元になった graph インスタンスを渡すこと**——それが保持インスタンスで
   * なければ（編集可能peekのグラフ等、別インスタンスをシリアライズして保存した場合）、保持は
   * 保存内容と食い違うので新鮮扱いにせず捨てる。
   * @param {string} planeId
   * @param {Uint8Array} bytes
   * @param {object} graph - bytes をシリアライズした元の graph
   */
  async saveAndNote(planeId, bytes, graph) {
    if (this._disposed) {
      await this._save(planeId, bytes);
      return;
    }
    const heldBefore = this._held.get(planeId);
    if (heldBefore && heldBefore.graph !== graph) {
      // 別インスタンス由来の保存——世代は進むので放っておいても次のgraphForが読み直すが、
      // 下の「自分の保存」判定で新鮮扱いに戻さないよう、先に手放す。
      this._held.delete(planeId);
      this.stats.invalidated++;
    }
    const savePromise = this._save(planeId, bytes);
    // 呼び出し直後（await前）に読む——注入されたsaveが同期区間でnoteFloorWrite相当を呼ぶ契約
    // （storage/db.js saveFloor と同じ）を前提に、「自分の1回分の書込みが反映された直後」の世代を
    // 捉える。saveが世代を進めない注入（テスト用スタブ）の場合はここが素通り（現在の世代のまま）になり、
    // 以降の比較も一貫してその前提で動く。
    const genAfterOwnWrite = this._generationOf(planeId);
    await savePromise;
    const genFinal = this._generationOf(planeId);
    if (genFinal === genAfterOwnWrite) {
      const held = this._held.get(planeId);
      if (held) this._held.set(planeId, { graph: held.graph, gen: genFinal });
    } else {
      // 保存の完了までの間に他者が割り込んだ——保持を捨てる（次のgraphForが読み直す）。
      if (this._held.delete(planeId)) this.stats.invalidated++;
    }
  }

  /** 指定階の保持だけを手放す（他者書込みの検知に頼らず明示的に無効化したいときに使う）。 */
  drop(planeId) {
    this._held.delete(planeId);
  }

  /** 全保持とcacheを手放す（規律2）。以後の呼び出しは規律7のフォールバックに入る。 */
  dispose() {
    this._disposed = true;
    this._held.clear();
    this._inflight.clear();
    this.wallSourceCache = null;
    this.footprintCache = null;
  }
}

/**
 * StructuralResolveContext のファクトリ。
 * @param {object} [opts]
 * @param {(plane:object, structGraph:object) => Promise<object|null>} [opts.peek]
 * @param {(planeId:string) => string} [opts.generationOf]
 * @param {(planeId:string, bytes:Uint8Array) => Promise<void>} [opts.save]
 */
export function createStructuralResolveContext(opts = {}) {
  return new StructuralResolveContext(opts);
}
