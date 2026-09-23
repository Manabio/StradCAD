import { makeObservable, observable, action, runInAction } from 'mobx';
import { CatalogKind, kindDef } from '../catalog/catalogKinds.js';
import { composeCatalog } from '../catalog/catalogRegistry.js';
import { buildResolveRows } from '../catalog/resolveQueue.js';
import { buildCodeTable, currentDocumentAliases, peekUnresolvedCodes } from '../catalog/codeNormalization.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';

/**
 * unresolved配列（{code, location:'opening', openingId}[]）を `${code}::${openingId}` で
 * 重複排除する（QA指摘Major-3・ステップ10e）。最初に現れた要素を残す——呼び出し側が
 * missingUsage（生グラフ走査。実データを直接見ている）を先に並べ、stillUnresolved
 * （peekUnresolvedCodes経由）を後に並べることで、missingUsageを優先させる契約。
 */
function dedupeOpeningUsageByOpeningId(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = `${item.code}::${item.openingId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

// 建具モードの状態は選択中の開口IDのみ（graph を変える操作は行わない——モード切替時の
// 仮配置・削除・編集は App.jsx のメニューハンドラ層／openings/openingEdit.js に集約する）。
// startMove/startDraw を実装しない: interaction/usePointerInteraction.js（longPress の clState.canMove 判定）はメソッドの
// 有無で移動可否を判定するため、CL移動は自動的に無効になる（.claude/opening-model.md）。
export class OpeningModeState {
  selectedOpeningId = null;

  // 指示UI（ステップ10e）場面(b)unresolved-codeの行。init()で組み立て、App.jsxが
  // project.catalogResolveRows（catalog/resolveQueue.js replaceRowsByScenarioで自分の種別だけ
  // 置換）へマージする。StructuralModeState.catalogResolveRowsと同型（materialErrorに相当する
  // ブロッキングエラーは持たない——未解決でも既定フォールバック（defaultOpeningHeight・
  // 描画側のnull時ティック）で図面は止まらない契約のため）。
  catalogResolveRows = [];
  // App.jsx のモードロード後マージ（replaceRowsByScenario）に渡す種別スコープ（ステップ8g型）。
  // FinishModeState（material/interiorMaster/boundaryMaster）・StructuralModeState（section）と
  // 同じ場面（unresolved-code）で行を積むため、種別を絞らないと他モードの突入がもう片方の
  // 行を消してしまう（非observable。モード生存中は不変の定数）。
  catalogResolveKinds = [CatalogKind.OPENING_SUB_TYPE];

  constructor(graph, project, initialSelectedId = null) {
    this.graph   = graph;
    this.project = project;
    this.selectedOpeningId = initialSelectedId ?? null;
    // dispose() 後の非同期継続（init()の他階peekループ）の書き込みを止めるガード
    // （FinishModeState._loadLowerStairs/_loadUpperVoidsと同型。QA指摘Nit-1・ステップ10e）。
    this._disposed = false;
    makeObservable(this, {
      selectedOpeningId: observable,
      catalogResolveRows: observable.ref,
      selectOpening:     action,
    });
  }

  selectOpening(id) { this.selectedOpeningId = id ?? null; }

  /**
   * 建具種別カタログ（openingSubType。CatalogKind.OPENING_SUB_TYPE）の起動時未解決検出
   * （ステップ10e・裁定Q-A: 検出は建具モード突入時）。StructuralModeState.init と同型——
   * overlay込みで合成した種別Map（kindDef(OPENING_SUB_TYPE).loadBuiltin() → composeCatalog。
   * openings/openingCatalog.js findCatalogEntryと同じ合成結果になる）に、全階（採用階。
   * project.planes＝App.jsx collectOpeningNumbersAllFloorsと同じ範囲）の graph.openings が
   * 参照する `${category}:${subType}` が無いものを場面(b)unresolved-codeの行として組み立てる。
   * materialErrorに相当するブロッキングエラーは持たない——未解決でも既定フォールバック
   * （openingNumbering.js effectiveHeight の defaultOpeningHeight・描画側のnull時ティック）で
   * 図面は止まらない契約のため、okは常にtrue（例外はApp.jsxのモード切替まで素通しする。ただし
   * 他階peekの個別失敗はここまで昇格させない——_missingOpeningUsage参照）。
   * @returns {Promise<{ ok: boolean, catalogResolveRows: object[] }>}
   */
  async init() {
    const builtin = await kindDef(CatalogKind.OPENING_SUB_TYPE).loadBuiltin();
    const subTypeMap = composeCatalog(CatalogKind.OPENING_SUB_TYPE, builtin);
    const missingUsage = await this._missingOpeningUsage(subTypeMap);
    // 10b QA指摘Minor-3/4申し送り: peekUnresolvedCodes()（全階累積・全種別）をopeningSubTypeで
    // フィルタし、今のコード表（文書固有の読み替え）で再解決できるものはここで捨てる——ただし
    // reason:'category-mismatch'/'malformed-target' は無条件で残す（カテゴリ跨ぎはtable.get()が
    // 実在キーを返すため通常フィルタで消えてしまうが、opening.subType自体は書き換わっていない
    // ので未解決として残す必要がある。codeNormalization.js normalizeOpenings参照）。
    const table = buildCodeTable({ aliases: currentDocumentAliases(CatalogKind.OPENING_SUB_TYPE) });
    const stillUnresolved = peekUnresolvedCodes().filter(u => u.kind === CatalogKind.OPENING_SUB_TYPE).filter(u => {
      if (u.reason === 'category-mismatch' || u.reason === 'malformed-target') return true;
      const mapped = table.has(u.code) ? table.get(u.code) : u.code;
      return mapped == null || !subTypeMap.has(mapped);
    });
    // QA指摘Major-3（ステップ10e）: missingUsage（生グラフ走査）とstillUnresolved（peek蓄積の
    // 合流）は、文書読込み時に既にpeekUnresolvedCodesへ積まれた開口が今も生きたまま自階/他階の
    // graph.openingsに存在する場合、同じ開口を二重計上してしまう（例: 文書固有aliasでcategory
    // 跨ぎのため据え置かれた開口は、生走査でも「合成Mapに無い」ため両方に載る）。
    // `${code}::${openingId}` で重複排除し、missingUsage（生グラフ走査。実データを直接見ている
    // ため優先）を残す——先頭から見て最初の出現を残すためmissingUsageを先に並べる。
    const catalogResolveRows = buildResolveRows({
      kind: CatalogKind.OPENING_SUB_TYPE,
      unresolved: dedupeOpeningUsageByOpeningId([...missingUsage, ...stillUnresolved]),
      appEntries: [...subTypeMap.values()],
    });
    if (!this._disposed) runInAction(() => { this.catalogResolveRows = catalogResolveRows; });
    return { ok: true, catalogResolveRows };
  }

  /**
   * 全階（採用階。project.planes）の graph.openings を直接走査し、subTypeMap に無い
   * `${category}:${subType}` を usage 配列（buildResolveRowsのunresolved引数の形。
   * {code, location:'opening', openingId}）として集める。件数は生グラフ走査で出す——
   * peekUnresolvedCodes()はkind+code+locationで重複排除するため同じcodeの複数建具が
   * 1件に潰れてしまう（このメソッドは同じcodeのusageを素直に複数積む）。
   * activePlane は this.graph をそのまま見る（App.jsx がモード生成時に渡す実グラフ）。
   * それ以外の採用階は floorSwapManager.peek（App.jsx collectOpeningNumbersAllFloorsと
   * 同じ読み取り専用peek経路）で一時グラフを読む——保存・書き戻しは行わない。
   * QA指摘Major-1（ステップ10e）: 他階のpeekは階ごとにtry/catchで囲み、失敗した階はその階の
   * scanだけを飛ばして続行する（refreshWallsAllFloors=wallRefresh.jsのpeekスキップ規約と同型。
   * 1階でもIDB読込みに失敗するとinit()全体がrejectし、App.jsxの共通.catchはトースト通知のみで
   * setModeされない＝建具モードに一切入れなくなる退行を防ぐ）。
   */
  async _missingOpeningUsage(subTypeMap) {
    const usage = [];
    const scan = (graph) => {
      for (const opening of graph?.openings ?? []) {
        if (!opening?.category || !opening?.subType) continue;
        const code = kindDef(CatalogKind.OPENING_SUB_TYPE).keyOf({ category: opening.category, key: opening.subType });
        if (!subTypeMap.has(code)) usage.push({ code, location: 'opening', openingId: opening.id });
      }
    };
    scan(this.graph);
    const activeId = this.project?.activePlaneId;
    for (const plane of this.project?.planes ?? []) {
      if (plane.id === activeId) continue; // activePlaneは既にthis.graphで走査済み
      let temp;
      try {
        temp = await floorSwapManager.peek(plane, this.project.structGraph);
      } catch (e) {
        console.error(`建具種別カタログの未解決検出: ${plane.name ?? plane.id}のpeekに失敗しました（この階はスキップします）:`, e);
        continue;
      }
      scan(temp);
    }
    return usage;
  }

  // 階切替時はモード再ロード effect（App.jsx）が新インスタンスを作るため選択は自然リセットされる。
  dispose() {
    this._disposed = true;
    this.catalogResolveRows = [];
  }
}
