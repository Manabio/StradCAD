import { makeObservable, observable, action, runInAction } from 'mobx';
import { beamAxisMoveRange } from '../structural/beamAxisMove.js';
import { sameIdSet } from '../structural/memberSelection.js';
import { CatalogKind, kindDef } from '../catalog/catalogKinds.js';
import { composeCatalog } from '../catalog/catalogRegistry.js';
import { buildResolveRows } from '../catalog/resolveQueue.js';
import {
  buildCodeTable, currentDocumentAliases, peekUnresolvedCodes, SECTION_MEMBER_LISTS,
} from '../catalog/codeNormalization.js';

const EMPTY_IDS = Object.freeze(new Set());

/**
 * unresolved配列（{code, location, memberId}[]）を `${code}::${location}::${memberId}` で
 * 重複排除する（QA指摘Major-3申し送り・ステップ10e。OpeningModeState.js
 * dedupeOpeningUsageByOpeningIdと同じ穴——_missingSectionUsage（生走査）とpeekUnresolvedCodes
 * 合流の両方に同じ部材が現れうる）。最初に現れた要素を残す——呼び出し側がmissingUsage
 * （生走査。実データを直接見ている）を先に並べ、stillUnresolved（peekUnresolvedCodes経由）を
 * 後に並べることで、missingUsageを優先させる契約。
 */
function dedupeSectionUsageByMemberId(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = `${item.code}::${item.location}::${item.memberId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export class StructuralModeState {
  // 構造リスト（structural/MemberListTab.jsx）で展開中のカードの部材id集合（同一タグの全部材）。
  // renderer/StructuralLayer.jsx が structural/memberSelection.js でハイライト矩形へ写す
  // （ユーザー裁定2026-09-16「構造リストで材を選択すると描画エリアの当該材が選択状態に」）。
  // 書き手は App.jsx→StructuralPanel→MemberListTab の onSelectMembers だけ。空は共有の空Set。
  selectedMemberIds = EMPTY_IDS;
  placementState   = null; // 配置中ドラフト | null（配置UI本実装は次フェーズ）
  // 柱芯ラベル ロングタップ → 出幅編集の静止入力窓状態。ドラッグ追従はしない（窓は動かない）。
  // { cl, structure, screenX, screenY, projection } | null
  axisEditState    = null;
  // 梁芯CL移動（FloorplanModeState.moveState と同型: { cl, originalValue, range }）。
  // 梁芯の移動範囲は同期計算（他フロアのIDB読み込みが不要＝先読みすべき非同期処理が無い）のため
  // preloadMove は no-op、startMove も同期のまま moveState を立てる。
  moveState        = null;

  // 指示UI（ステップ8g）場面(b)unresolved-codeの行。init()で組み立て、App.jsxが
  // project.catalogResolveRows（catalog/resolveQueue.js replaceRowsByScenarioで自分の種別だけ
  // 置換）へマージする。FinishModeState.catalogResolveRowsと同型（materialErrorに相当する
  // ブロッキングエラーは持たない——未解決でも既定フォールバック（findSectionEntry呼び出し側の
  // `?? 300`等）で図面・構造再計算は止まらない契約のため）。
  catalogResolveRows = [];
  // App.jsx のモードロード後マージ（replaceRowsByScenario）に渡す種別スコープ（ステップ8g）。
  // FinishModeState（material/interiorMaster/boundaryMaster）と同じ場面（unresolved-code）で
  // 行を積むため、種別を絞らないと片方のモード突入がもう片方の行を消してしまう
  // （非observable。モード生存中は不変の定数）。
  catalogResolveKinds = [CatalogKind.SECTION];

  constructor(graph) {
    this.graph = graph;
    makeObservable(this, {
      selectedMemberIds: observable.ref,
      placementState:   observable.ref,
      axisEditState:    observable.ref,
      moveState:        observable.ref,
      catalogResolveRows: observable.ref,
      selectMembers:     action,
      clearSelection:    action,
      startAxisEdit:     action,
      updateAxisEdit:    action,
      cancelAxisEdit:    action,
      startMove:         action,
      updateMove:        action,
      commitMove:        action,
      cancelMove:        action,
    });
  }

  /**
   * 断面カタログ（構造断面。CatalogKind.SECTION）の起動時未解決検出（ステップ8g・裁定Q-C:
   * 検出は構造モード突入時）。FinishModeState.init と同型——overlay込みで合成した断面Map
   * （kindDef(SECTION).loadBuiltin() → composeCatalog。structural/sectionCatalog.js
   * findSectionEntryと同じ合成結果になる）に graph.columns/beams/structuralWalls/slabs/
   * footings の sectionDefId が無いものを場面(b)unresolved-codeの行として組み立てる。
   * 境界マスターの未解決（一過性。モード境界でselectBoundaryMasterが再導出して消える）とは
   * 違い、断面の未解決は一過性ではない——構造再計算（structuralRecompute.js）は既存部材の
   * sectionDefId を書き換えない（在来木造の conformWoodSections が導出し直す柱・梁の断面
   * だけは例外——階の柱寸法へ追従して sectionDefId 自体が変わるため、そちらは自然に解消しうる）。
   * materialErrorに相当するブロッキングエラーは持たない——未解決でも既定フォールバック
   * （findSectionEntry呼び出し側の`?? 300`等）で図面・構造再計算は止まらない契約のため、
   * ok は常に true（例外はApp.jsxのモード切替まで素通しする。materialと同じ扱い）。
   * @returns {Promise<{ ok: boolean, catalogResolveRows: object[] }>}
   */
  async init() {
    const builtin = await kindDef(CatalogKind.SECTION).loadBuiltin();
    const sectionMap = composeCatalog(CatalogKind.SECTION, builtin);
    const missingUsage = this._missingSectionUsage(sectionMap);
    // FinishModeState._buildUnresolvedCodeRowsと同型: peekUnresolvedCodes()（全階累積・全種別）
    // をsectionでフィルタし、今のコード表（文書固有の読み替え）で再解決できるものはここで捨てる
    // （section.rewriteは復元時=decodeFloorSnapshot/restoreGraphで既に自階の未知sectionDefIdを
    // 解消しているため実質ほぼ空だが、自階以外で蓄積された未解決が残る場合に備えて合流する）。
    const table = buildCodeTable({ aliases: currentDocumentAliases(CatalogKind.SECTION) });
    const stillUnresolved = peekUnresolvedCodes().filter(u => u.kind === CatalogKind.SECTION).filter(u => {
      const mapped = table.has(u.code) ? table.get(u.code) : u.code;
      return mapped == null || !sectionMap.has(mapped);
    });
    // QA指摘Major-3申し送り（ステップ10e）: missingUsage（生走査）とstillUnresolved（peek合流）の
    // 両方に同じ部材が現れる場合の二重計上を防ぐ（dedupeSectionUsageByMemberId参照）。
    const catalogResolveRows = buildResolveRows({
      kind: CatalogKind.SECTION,
      unresolved: dedupeSectionUsageByMemberId([...missingUsage, ...stillUnresolved]),
      appEntries: [...sectionMap.values()],
    });
    runInAction(() => { this.catalogResolveRows = catalogResolveRows; });
    return { ok: true, catalogResolveRows };
  }

  /**
   * catalog/codeNormalization.js SECTION_MEMBER_LISTS（columns/beams/structuralWalls/slabs/
   * footings。保存済みsnapshotの走査と唯一共有する定義）が参照する断面キー（sectionDefId）の
   * うち、合成後カタログ（sectionMap）に無いものを usage 配列（buildResolveRowsのunresolved
   * 引数の形。{code, location, memberId}）として集める。こちらは保存済みsnapshotではなく
   * 現在のgraphを直接見る——FinishModeState._missingUsageForKindと同じ
   * 「モード側は生グラフを見る」設計に合わせる。
   */
  _missingSectionUsage(sectionMap) {
    const usage = [];
    for (const location of SECTION_MEMBER_LISTS) {
      for (const member of this.graph[location] ?? []) {
        if (member?.sectionDefId && !sectionMap.has(member.sectionDefId)) {
          usage.push({ code: member.sectionDefId, location, memberId: member.id });
        }
      }
    }
    return usage;
  }

  // 選択中の部材id集合を差し替える（同内容なら書き換えない＝observer の無駄な再描画を避ける）。
  // 空・null は共有の空Setへ戻す。
  selectMembers(ids) {
    const next = ids ? new Set(ids) : EMPTY_IDS;
    if (sameIdSet(this.selectedMemberIds, next)) return;
    this.selectedMemberIds = next.size === 0 ? EMPTY_IDS : next;
  }

  startAxisEdit(state) { this.axisEditState = state; }
  // 入力中の出幅値だけ差し替える（窓位置・対象CLは不変）。
  updateAxisEdit(projection) {
    if (this.axisEditState) this.axisEditState = { ...this.axisEditState, projection };
  }
  cancelAxisEdit() { this.axisEditState = null; }

  clearSelection() {
    this.selectedMemberIds = EMPTY_IDS;
    this.placementState   = null;
    this.axisEditState    = null;
  }

  // ---- 梁芯CL移動 ----
  // ガター長押し（FloorplanModeState）と違い、梁芯の範囲計算は他フロアのIDB読み込みを伴わないため
  // 先読みは不要。interaction/usePointerInteraction.js の長押しメニュー表示が canMove の真時に無条件で preloadMove を呼ぶため
  // メソッド自体は必須（無いと長押しの瞬間に TypeError になる）。
  // interaction/usePointerInteraction.js が preloadMove(cl) の形で呼ぶが、梁芯は先読みする非同期処理が無いため引数は使わない。
  preloadMove() {}

  // 長押しメニューの「移動」選択時に呼ぶ。FloorplanModeState.startMove と違い非同期処理が無いため同期のまま。
  startMove(cl) {
    const range = beamAxisMoveRange(this.graph, cl);
    this.moveState = { cl, originalValue: cl.value, range };
    return null;
  }

  updateMove(newValue) {
    if (!this.moveState) return;
    runInAction(() => {
      const { cl, range } = this.moveState;
      const clamped = Math.min(Math.max(newValue, range.min), range.max);
      cl.pendingDelta = clamped - cl.value;
    });
  }

  commitMove() { this.moveState = null; }

  cancelMove() {
    if (this.moveState) {
      runInAction(() => { this.moveState.cl.pendingDelta = 0; });
    }
    this.moveState = null;
  }

  get isMoving() { return this.moveState !== null; }

  // dispose は clearSelection に加えて cancelMove を呼ぶ（clearSelection 自体には入れない——
  // 空白タップ等での意図しない移動中断を避けるため）。断面データ（ステップ8g）はFinishModeState
  // と同じくモード離脱時に破棄する。
  dispose() {
    this.clearSelection();
    this.cancelMove();
    this.catalogResolveRows = [];
  }
}
