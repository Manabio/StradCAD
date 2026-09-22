/**
 * PROJECT (MobX ルートストア)。core.js から分離。
 */
import { makeObservable, observable, computed, action } from 'mobx';
import { Plane } from './plane.js';
import { PlanGraph } from './planGraph.js';
import { Site } from './site.js';
import { StructuralInfo } from './structuralInfo.js';

export class Project {
  constructor(id, name) {
    this.id   = id;
    this.name = name;

    this.planeMap = observable.map();
    this.graphMap = observable.map();

    this.activePlaneId = null;

    // 全階共通の通り芯専用グラフ（labeled struct CL のみ格納）
    const structPlane = new Plane('struct', 0, '__struct__');
    this.structGraph  = new PlanGraph(structPlane);

    this.site = new Site();
    this.structuralInfo = new StructuralInfo();
    this.structGraph._structuralInfo = this.structuralInfo; // 各階graph・peek一時graphが _structGraph 経由で辿る

    // 調査・計画情報（敷地情報／建築情報ダイアログの入力値）。プレーンJSONオブジェクトを
    // 丸ごと保持し、ダイアログを閉じるときに setSiteInfo/setBuildingInfo で全置換する
    // （null=未入力。フィールド単位のobservable化はしない——編集はダイアログ内のReact stateで
    // 完結し、モデル側はスナップショットだけ持てばよいため）。画像ファイルは対象外
    // （バックエンド送信想定。ui/SiteDialog.jsx 参照）。
    this.projectInfo = observable.object({ siteInfo: null, buildingInfo: null }, {}, { deep: false });

    // 部材グループ台帳（建物全体で共有。grp.spec:<gid>/grp.join:<gid>/grp.no:<gid>/grp.mergedInto:<gid> → 文字列）。
    // 分割・統合・手動採番というユーザーの明示操作だけを持つ（既定の集約は毎回 signature から導出する。
    // structural/memberGroups.js・memberNumbering.js 参照）。FBS の tagRegistryKeys/Vals チャネルへ
    // そのまま乗せる（graphSnapshot.js buildStructSnapshot/restoreStructCLs）。
    this.memberGroupLedger = observable.map();
    // 部材番号グループの派生キャッシュ（非永続。モード境界の収集フェーズで再構築される。
    // groupKey → {mapName, symbol, sizeKey, signature, floorRanks:Set<number>, hasRoof, counts:Map<planeId,number>}）。
    this.memberNumberIndex = observable.map();
    // 建具番号グループの派生キャッシュ（非永続。建具モード突入時の収集フェーズで再構築される。
    // signature → { symbol, subType, width, height, sillHeight, counts:Map<planeId,number>, tag }）。
    this.openingNumberIndex = observable.map();

    // カタログのR17（重複登録禁止）合成後例外・overlay読込み失敗等のメッセージ通知
    // （2026-09-22 QA指摘B。2026-09-22 再QA指摘Major-Dで通知専用に整理）。
    // store.js の bootReady は失敗させない設計のため、catch内でconsole.errorに流す代わりに
    // ここへ観測可能な形で残す——App.jsxがmaterialErrorと同じトースト経路で表示する
    // （reaction購読。catalogErrorSeq参照）。他のエラー（IDB読込失敗等）は従来どおり
    // console.errorのまま（catalogErrorは立てない）。
    // catalogErrorSeq: setCatalogErrorを呼ぶたびに増分する（同一文言のメッセージでも
    // App.jsxのreactionが再度発火できるようにするため——MobXの変更検知は値の同一性で
    // 決まるため、同じ文字列を再代入しただけでは反応しない。reactionはこちらを観測する）。
    this.catalogError = null;
    this.catalogErrorSeq = 0;
    // 保存ガード専用のboolean（2026-09-22 再QA指摘Major-D）。catalogOverlayLoaderの
    // overlay読込みに失敗したときだけtrueにする——catalogErrorは「メッセージの内容」に
    // 依存する通知専用のフィールドのため、保存可否の判定（真偽の分岐）と兼用しない
    // （通知文言を変えると保存ガードの意味まで変わってしまう結合を避ける）。
    // store.js saveCatalogDocument はこれだけを見て、文書同梱の保存可否を決める。
    this.catalogOverlayUntrusted = false;

    // 指示UI（ステップ6-3・R10）の行一覧（catalog/resolveQueue.js buildResolveRows の戻り値）。
    // observable.ref——行内のエントリ（targetEntry/candidates）の===同一性を壊さないため
    // （MobXに中身までプロキシ化させない。catalogMap/materialDiffsと同じ理由）。
    // store.js の起動時reconcile（(a)library-conflict/(c)unsupported/propose）と
    // modes/FinishModeState.js init（(b)unresolved-code。モード突入のたびに再計算）の
    // 双方が積む——setCatalogResolveRows は全置換のため、呼び出し側が既存行とマージしてから渡す。
    this.catalogResolveRows = [];

    makeObservable(this, {
      name:          observable,
      activePlaneId: observable,
      catalogError:  observable,
      catalogErrorSeq: observable,
      catalogOverlayUntrusted: observable,
      catalogResolveRows: observable.ref,
      activeGraph:   computed,
      activePlane:   computed,
      planes:        computed,
      orderedTabs:   computed,
      roofPlane:     computed,
      addPlane:      action,
      removePlane:   action,
      clearMemberNumberIndex: action,
      clearOpeningNumberIndex: action,
      setSiteInfo:     action,
      setBuildingInfo: action,
      setCatalogError: action,
      setCatalogOverlayUntrusted: action,
      setCatalogResolveRows: action,
      clearCatalogResolveRows: action,
    });
  }

  setSiteInfo(info)     { this.projectInfo.siteInfo = info; }
  setBuildingInfo(info) { this.projectInfo.buildingInfo = info; }
  /** 都度発火（同一文言でも再通知できるよう毎回 catalogErrorSeq を進める）。 */
  setCatalogError(msg)  { this.catalogError = msg; this.catalogErrorSeq++; }
  setCatalogOverlayUntrusted(v) { this.catalogOverlayUntrusted = v; }
  /** 指示UI（ステップ6-3）の行一覧を全置換する（呼び出し側が既存行とマージ済みのものを渡す）。 */
  setCatalogResolveRows(rows) { this.catalogResolveRows = rows; }
  clearCatalogResolveRows()   { this.catalogResolveRows = []; }

  clearMemberNumberIndex() { this.memberNumberIndex.clear(); }
  clearOpeningNumberIndex() { this.openingNumberIndex.clear(); }

  get activeGraph() {
    return this.activePlaneId ? this.graphMap.get(this.activePlaneId) : undefined;
  }

  get activePlane() {
    return this.activePlaneId ? this.planeMap.get(this.activePlaneId) : undefined;
  }

  /** 採用フロアのみを elevation 昇順で返す（階番号ロジック用。屋根専用平面は対象外） */
  get planes() {
    return [...this.planeMap.values()]
      .filter(p => !p.isAlternative && !p.isRoofPlane)
      .sort((a, b) => a.elevation - b.elevation);
  }

  /** 屋根専用平面（小屋伏／R階伏）。構造モードでのみ存在し、なければ null。 */
  get roofPlane() {
    return [...this.planeMap.values()].find(p => p.isRoofPlane) ?? null;
  }

  /** タブ表示順（採用 + 各採用の検討、elevation 昇順グループ） */
  get orderedTabs() {
    const adopted = this.planes;
    const result = [];
    for (const a of adopted) {
      result.push(a);
      const alts = [...this.planeMap.values()]
        .filter(p => p.isAlternative && p.referenceId === a.id)
        .sort((a, b) => a.altIndex - b.altIndex);
      result.push(...alts);
    }
    return result;
  }

  addPlane(elevation, name, id = crypto.randomUUID(), startFloor = 1, stories = 1,
           isAlternative = false, referenceId = null, altIndex = 0,
           isRoofPlane = false, roofForPlaneId = null) {
    const plane = new Plane(id, elevation, name, startFloor, stories, isAlternative, referenceId, altIndex,
                             isRoofPlane, roofForPlaneId);
    const graph = new PlanGraph(plane);
    graph._structGraph = this.structGraph; // 全階共通の通り芯を参照
    graph._structuralInfo = this.structuralInfo; // 建物全体の構造情報（主構造ルールの解決用）
    this.planeMap.set(plane.id, plane);
    this.graphMap.set(plane.id, graph);
    if (!this.activePlaneId) this.activePlaneId = plane.id;
    return { plane, graph };
  }

  removePlane(planeId) {
    const plane = this.planeMap.get(planeId);
    if (!plane) return;
    if (!plane.isAlternative && !plane.isRoofPlane && this.planes.length <= 1) return; // 採用の最後の1階は削除不可

    if (!plane.isAlternative) {
      // 検討をまとめて削除
      for (const [id, p] of this.planeMap) {
        if (p.isAlternative && p.referenceId === planeId) {
          this.planeMap.delete(id);
          this.graphMap.delete(id);
        }
      }
    }
    this.planeMap.delete(planeId);
    this.graphMap.delete(planeId);
    if (this.activePlaneId === planeId) {
      this.activePlaneId = this.planes[0]?.id ?? null;
    }
  }

}
