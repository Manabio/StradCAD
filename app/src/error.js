export const KIND_LABEL = { struct: '通り芯', center: '中心線', aux: '補助線', beam: '梁芯', ceiling: '天井芯' };

// QA指摘m-3: 未知種別は KIND_LABEL[kind] が undefined のまま文言へ埋め込まれ、黙って
// 「…があるため…」の「…」が"undefined"になってしまう（呼び出し元のバグを握り潰す）。
// 今回新設・変更した変換用文言（CONVERT系。centerLineKindPolicy.jsのassertKnownKindと同じ
// throw様式）だけをthrowにする——追加用のERR_CL_DUPLICATEは挙動を変えない（既存呼び出し元の
// 前提を崩さないため。centerLineOps.js addCenterLineFromDialogは常に既知の4種別しか渡さない）。
function assertKnownKind(kind) {
  if (!(kind in KIND_LABEL)) throw new Error(`未知のCL種別: ${kind}`);
}

export const ERR_CL_DUPLICATE = (kind) =>
  `既に同じ位置に${KIND_LABEL[kind]}があり、追加できません。`;

// 通り芯の移動の確定が、同じ向きの別の通り芯と同じ座標になる場合の文言（transform/centerLineOps.js
// commitCLMoveOp）。ERR_CL_DUPLICATE('struct') の移動版（動詞だけ「移動できません」）。
export const ERR_CL_MOVE_DUPLICATE =
  `既に同じ位置に${KIND_LABEL.struct}があり、移動できません。`;

// 裁定Q9（線種変更の移籍一本化・2026-09-30）: 実態は削除+新規作成ではなく移籍（既存の中心線を
// そのまま通り芯へ昇格）のため、文言もそれに合わせる。
export const ERR_CL_CENTER_UPGRADED =
  '同位置の中心線を通り芯にしました。';

export const ERR_CL_STRUCT_EXISTS =
  '同位置に通り芯があり、追加できません。';

export const ERR_DRAW = 'Draw error:';

// 仕上げモード突入時、永続化データが参照する材コードが材マスタに存在しない場合
export const ERR_MATERIAL_MISMATCH = '材データが一致しません。';

// 中心線移動時、随伴する図形の連鎖が深すぎる／多すぎる場合（transform/followerGraph.js）
export const ERR_CL_MOVE_TOO_DEEP = (excess, max) =>
  `関連する図形の連鎖が深すぎます。ネストを${excess}段減らして${max}段以内にしてください。`;

export const ERR_CL_MOVE_TOO_MANY = (excess, max) =>
  `関連する図形が多すぎます。あと${excess}個削除して${max}個以内にしてください。`;

export const ERR_CL_MOVE_LOAD_FAILED = 'フロアデータの読み込みに失敗しました。';

// 開口（建具・窓）の配置検証（openings/openingGeometry.js）
export const ERR_OPENING_OUT_OF_WALL = '開口が壁の範囲を超えています。';
export const ERR_OPENING_OVERLAP     = '既存の開口と重なっています。';

// 構造モード突入時、構造情報パネルの主要構造が未指定（'未定'）の場合
export const ERR_STRUCT_MAIN_UNSPECIFIED = '主要構造を指定してください。';

// 柱の長クリック（interaction/columnLongPress.js runColumnMenuAction）の確定時に、長クリックからメニュー選択までの間に
// 編集先の階・柱・交点の状態が変わっていたため中止した場合。
export const ERR_COLUMN_ADD_ABORTED = 'この位置には柱を追加できません。';
export const ERR_COLUMN_DEL_ABORTED = '柱を削除できませんでした。';

// 中心⇔通り芯の入替え（transform/centerLineConvert.js・centerLineOps.js）
export const ERR_CL_CONVERT_NO_GRID   = '直交する通り芯が2本必要です。';
// 降格（通り芯→中心）専用: 同じ軸（X/Y）に他の通り芯が無い＝この通り芯が軸最後の1本の場合
export const ERR_CL_CONVERT_LAST_GRID = 'この軸の最後の通り芯のため中心線にできません。';
export const ERR_CL_CONVERT_ATTACHED  = 'この中心線には斜線・円弧が取り付いているため変換できません。';

// 変換（昇格・降格）の同期ガードが同座標の既存CLで拒否する場合の文言。ERR_CL_DUPLICATE
// （AddCLDialog の追加専用。「…追加できません」）とは動詞が異なるため別関数にする
// （transform/centerLineConvert.js checkPromoteToGridGuards/checkDemoteToCenterGuards 専用）。
export const ERR_CL_CONVERT_DUP = (kind) => {
  assertKnownKind(kind);
  return `同じ位置に${KIND_LABEL[kind]}があるため通り芯にできません。`;
};
export const ERR_CL_CONVERT_DUP_DEMOTE = (kind) => {
  assertKnownKind(kind);
  return `同じ位置に${KIND_LABEL[kind]}があるため中心線にできません。`;
};

// 昇格（中心→通り芯）専用: 他階の同座標に中心線・補助線・梁芯があるため通り芯化できない。
// floorsByKind は [{ name, kind }]（階名・その階での相手種別。findFloorsWithCounterpartCL の戻り値を
// map したもの）。種別ごとにまとめ、種別の並び順は 中心線→補助線→梁芯
// （centerLineKindPolicy.js CROSS_FLOOR_COUNTERPART_KINDS と同じ優先順）に揃える。同種別の階は
// 「・」で、種別が混在する場合は「、」で連結する（例:
// 「1階 の同じ位置に中心線、2階・3階 の同じ位置に梁芯があるため通り芯にできません。」）。
const CROSS_FLOOR_KIND_ORDER = ['center', 'aux', 'beam'];
// floorsByKindの各要素.kindはCROSS_FLOOR_KIND_ORDER（＝centerLineKindPolicy.js
// CROSS_FLOOR_COUNTERPART_KINDSと同じ集合）のいずれかである前提——それ以外（'struct'や未知の
// 文字列）を渡すと、下のmapがCROSS_FLOOR_KIND_ORDERの3種別しか回さないため該当階が黙って
// 出力から欠落する（QA指摘m-3）。事前に検証してthrowする。
function assertCrossFloorKind(kind) {
  if (!CROSS_FLOOR_KIND_ORDER.includes(kind)) throw new Error(`未知のCL種別: ${kind}`);
}
function formatFloorsByKind(floorsByKind) {
  for (const f of floorsByKind) assertCrossFloorKind(f.kind);
  return CROSS_FLOOR_KIND_ORDER
    .map(kind => {
      const names = floorsByKind.filter(f => f.kind === kind).map(f => f.name);
      return names.length ? `${names.join('・')} の同じ位置に${KIND_LABEL[kind]}` : null;
    })
    .filter(Boolean)
    .join('、');
}
export const ERR_CL_CONVERT_DUP_FLOOR = (floorsByKind) =>
  `${formatFloorsByKind(floorsByKind)}があるため通り芯にできません。`;
// 降格（通り芯→中心）専用: DUP_FLOORと逆方向のため文言を分ける（「通り芯にできません」の誤表示防止）。
// 同座標の梁芯は通り芯と共存不可のため原理上他階の相手にはなりえない（降格前は自座標が通り芯のまま
// であり、findFloorsWithCounterpartCLが探す非labeled CLのうち梁芯だけが残る状況は起きない）——
// 実質的な表示は中心線・補助線のみになる。
export const ERR_CL_CONVERT_DUP_FLOOR_DEMOTE = (floorsByKind) =>
  `${formatFloorsByKind(floorsByKind)}があるため中心線にできません。`;

// ダイアログからの通り芯の単体追加・スパン配列専用（線種変更の移籍一本化 ステップ6・裁定Q4〜Q6）:
// ERR_CL_CONVERT_DUP_FLOOR（昇格用「…通り芯にできません」）とは動詞が異なる（「追加できません」）
// ため別関数にする。相手は他平面の補助線・保護される梁芯のみ（中心線・保護されない壁由来梁芯は
// transform/centerLineOps.js addGridLinesWithFloorAbsorption が吸収するため相手にならない）。
export const ERR_CL_ADD_DUP_FLOOR = (floorsByKind) =>
  `${formatFloorsByKind(floorsByKind)}があるため通り芯を追加できません。`;
// スパン配列専用（裁定Q6・QA指摘4是正）: 一部の値だけ他平面の相手と重なる場合、値ごとに軸・値・
// 平面・相手種別を列挙する（例:「X=2000: 2階 の同じ位置に補助線があるため通り芯を追加できません。」）。
// 値と値の区切りは「／」（値の中の種別の区切り「、」＝formatFloorsByKindと衝突しないよう分ける）。
// value は呼び出し側（transform/centerLineOps.js）が画面表示（ui/AddCLDialog.jsx
// `Math.round(sign * value)`。Y軸は符号反転）に合わせて変換済みの値を渡すこと——本関数は受け取った
// 値をそのまま埋め込むだけで変換しない。
// entries: [{ axis: 'X'|'Y', value: number, floorsByKind: [{name, kind}] }]
export const ERR_CL_ADD_DUP_FLOOR_SPAN = (entries) =>
  `${entries.map(({ axis, value, floorsByKind }) => `${axis}=${value}: ${formatFloorsByKind(floorsByKind)}`).join('／')}があるため通り芯を追加できません。`;

// 中心⇔通り芯の入替えの階またぎ同期（centerLineFloorSync.js）がIDB書込等で失敗した場合。
// 昇格は移籍後の吸収失敗（他平面・自階・共有グラフとも巻き戻し済み＝昇格されていない。QA所見5是正・
// 2026-09-30: applyCenterLineAbsorptionOnPromoteをapplyPromoteToGridの後に呼ぶよう変更したため、
// 失敗時は自階・structGraphもbeforeへ戻す）、降格は確定前の複製失敗（全体ロールバック済み＝降格
// されていない）。
export const ERR_CL_CONVERT_SYNC_FAILED = '他階への反映に失敗しました。';

// 裁定Q11（線種変更の移籍一本化）: 既存データに同じidの線が他の平面に残っていた場合の拒否。
// 線の実体をid ごと移す「移籍」に一本化した結果、線idはプロジェクト全体で一意である前提になった
// ——万一この前提が崩れているデータに対しては、書き換えずに拒否して平面名を出す（黙って壊さない）。
// planeNames は他平面の名前一覧（findFloorsWithSameLineId の戻り値をmapしたもの）。
// 昇格（中心線→通り芯）側で使う——昇格時の他平面チェック（線種変更の移籍一本化 ステップ4）で使用する。
export const ERR_CL_CONVERT_SAME_ID_FLOOR = (planeNames) =>
  `${planeNames.join('・')} に同じidの線があるため通り芯にできません。`;
export const ERR_CL_CONVERT_SAME_ID_FLOOR_DEMOTE = (planeNames) =>
  `${planeNames.join('・')} に同じidの線があるため中心線にできません。`;

// 昇格の吸収（線種変更の移籍一本化 ステップ4・centerLineFloorSync.js
// applyCenterLineAbsorptionOnPromote）専用: 他の平面で、吸収する中心線が2本以上あり（同座標に
// 区間違いで複数など）、いずれも通り芯id（cl.id）へ参照をまとめようとした結果、置換後の
// スナップショットで柱芯オフセット（columnAxisOffsets）・CL偏芯（clEccentricities）・腰壁/垂れ壁
// （kneeDropWalls）のいずれかについて、2本それぞれにその通り芯idを指すエントリが残った場合
// （centerLineFloorSync.js hasAbsorptionConflict参照。これらは配列（columnAxisOffsetKeys）や
// 配列内オブジェクト（clEccentricities・kneeDropWalls）として永続化されるため、
// lineIdRemap.js remapLineIdsInSnapshotのキー衝突検出では捕まらない——2本それぞれの値のうち
// どちらを採るか黙って決めず、書き換えずに拒否する）。
export const ERR_CL_CONVERT_ABSORB_CONFLICT_FLOOR = (planeName) =>
  `${planeName} の同じ位置に中心線が複数あり、参照をまとめられないため通り芯にできません。`;

// CL削除（transform/centerLineOps.js deleteCenterLineWithUndo）専用: 同じ軸（X/Y）に他の通り芯が
// 無い＝この通り芯が軸最後の1本の場合。ERR_CL_CONVERT_LAST_GRID（降格用）と判定式は共有するが、
// 「削除できません」と方向が違うため文言は分ける。
export const ERR_CL_DELETE_LAST_GRID = 'この軸の最後の通り芯のため削除できません。';

// CL削除（transform/centerLineOps.js deleteCenterLineWithUndo）専用: 削除しようとしているCLが
// フットプリント（仕上げモードの部屋領域が定義する外壁線）を担っている場合（自階・他階いずれか。
// transform/centerLineConvert.js isFootprintBoundaryCL・centerLineFloorSync.js
// findFloorsWhereFootprintBoundary 参照）。部屋セル・境界エッジが削除済みCL idを指したまま残るのを
// 未然に防ぐ第一段階のガード。
export const ERR_CL_DELETE_FOOTPRINT = '外壁を担うため削除できません。先に仕上げモードで部屋を作り替えるか、CLを移動してください。';

// CL削除（transform/centerLineOps.js deleteCenterLineWithUndo）専用: 削除しようとしているCLを
// 失うと自階の部屋セル・スラブセルのいずれかが対辺2本同時喪失になる、または再解釈除外部屋
// （階段・階段吹抜け・未定義・昇降路・屋根）のセル辺がこのCLを持つ場合（finish/roomReinterpret.js
// findUnresolvableCells。先読みガードとして削除前に判定するほか、削除後の安全網
// （collectUnresolvableCellsの前後差分）でも同じ文言を返す）。長押しメニューの削除項目の
// グレー化（interaction/usePointerInteraction.js・menuItems.js）もこの判定を共有する。
export const ERR_CL_DELETE_UNRESOLVABLE = '部屋の区切りを復元できないため削除できません。';

// CL削除ステップ3（transform/centerLineOps.js deleteCenterLineWithUndo。壁再生成）専用: 削除に
// 先立って壁を作り直すために必要なデータの取得——materialMap取得（finish/wallRegeneration.js
// loadMaterialMap）または壁再生成が動的importする2モジュール（edgeComposition.js・
// clEccentricity.js）の事前読込み（preloadWallRegenerationModules）——のいずれかが
// ERR_CATALOG_DUPLICATE以外の理由（IDB読込失敗・チャンク取得失敗等）で失敗した場合。何も
// 変更していない時点（detach・後始末より前）で判定し拒否する——壁を作り直せないまま削除だけ
// 通すと、壁がdetachで切られたまま再生成されず、wallFreshnessKeyがCL位相を含まないため次の
// 境界でも修復されない事故になる（QA指摘H2・M1'・2026-09-27）。
export const ERR_CL_DELETE_WALLS_UNAVAILABLE = '壁を作り直せないため削除できません。必要なデータの読込みに失敗しました。';

// 階切替の関門（storage/FloorSwapManager.js swap）専用: 保存＋安定確認ループ
// （MAX_SWAP_SAVE_ATTEMPTS回）を試みても、保存の前後でfromGraphの内容が変わり続け安定しない
// 場合（保存awaitの間、編集が絶えず割り込む）。現階のauto-saveは再開されるため、もう一度
// 切替を試せば通常は成功する。
export const ERR_FLOOR_SWITCH_UNSTABLE = '編集が続いているため階を切り替えられませんでした。もう一度お試しください。';

// 階切替の関門（storage/FloorSwapManager.js swap）専用: 次階の読込み（loadFloor）または
// 現階の保存（saveFloor）そのものがIDBエラーで失敗した場合、あるいは次階の復元
// （restoreGraph）が壊れたバイト列で失敗した場合。
export const ERR_FLOOR_SWITCH_FAILED = '階の保存または読込みに失敗したため切り替えられませんでした。';

// セッション排他ロック（storage/sessionLock.js）: 別タブが編集セッションを保持している場合、
// storage/db.js の openDB() がこの文言で reject する。App.jsx は同じ文言を全画面案内に表示する。
export const ERR_SESSION_LOCKED = 'このアプリは別のタブで開いています。編集できるのは1つのタブだけです。';

// カタログのR17重複検出（catalog/catalogMatch.js の assertNoDuplicate・catalog/catalogRegistry.js
// の合成後検査）専用のエラーコード。throwするErrorの.codeにこの値を持たせる
// （2026-09-22 QA指摘B）。文言そのもの（重複した両エントリのキー・名称・出所）は都度組み立てる
// ため、ERR_SESSION_LOCKEDのような固定文言ではなく識別用の定数のみを持つ。
// wallRefresh.js の getMaterialMap 呼び出しの catch は、このコードのときだけ再throwし
// （黙って壁を古いまま残さない）、それ以外は従来どおり materialMap 無しとして扱う。
export const ERR_CATALOG_DUPLICATE = 'ERR_CATALOG_DUPLICATE';

// CL操作の入口（削除・入替え・偏芯確定。App.jsxのrunBusy経由の関門）専用のエラーコード
// （入力規制ステップ3・2026-09-28）。従来は各入口が自前でtry/catchしconsole.error＋
// ERR_CL_CONVERT_SYNC_FAILEDトーストを出していたが、関門化に伴い例外はguardUi層（App.jsx）
// 一本に集約する——各入口は.catch(err => { throw tagCLOpFailure(err); })で投げ直すだけにし、
// floorTransitionErrorMessageがこのcodeを見て同じ文言を返す。
export const ERR_CL_OP_FAILED = 'ERR_CL_OP_FAILED';

// tagCLOpFailure: 既知のcodeは「文字列のcode」に限定する（QA指摘・2026-09-28）——
// storage/db.jsはDOMExceptionで reject することがあり（QuotaExceededError等）、その.codeは
// 数値かつ getter のみで再代入すると例外を投げる（`Cannot set property code of ... which has
// only a getter`）。errがErrorインスタンスでtypeof err.code==='string'（ERR_CATALOG_DUPLICATE等、
// 既に組み立て済みmessageを持つ既知エラー）ならそのまま返す（上書きしない）。それ以外
// （codeが無い・数値codeのDOMException・非Error）はnew Errorで包み、元の例外をcauseに残しつつ
// 必ず文字列codeを持たせる。
export function tagCLOpFailure(err) {
  if (err instanceof Error && typeof err.code === 'string') return err;
  return Object.assign(new Error(err?.message ?? String(err), { cause: err }), { code: ERR_CL_OP_FAILED });
}

// 昇降機の設置（finish/equipment/equipmentFloorSync.js runElevatorInstall）専用のエラーコード
// （ステップ4・S3a）。保存の例外・commitActiveの例外・peek等の読み込み例外で、保存済みの上階を
// beforeへ巻き戻した後（書込みが無い段階ならそのまま）にこのcodeを付けて再スローする
// ——ERR_CATALOG_DUPLICATEと同じ「messageが呼び出し元で組み立て済み」様式（下の
// KNOWN_TRANSITION_ERROR_CODESに載せ、floorTransitionErrorMessageがmessageをそのまま返す）。
export const ERR_ELEVATOR_OP_FAILED = 'ERR_ELEVATOR_OP_FAILED';
export const ERR_ELEVATOR_OP_FAILED_MESSAGE = '昇降機の設置に失敗しました。';

// 昇降機の削除・用途変更（finish/equipment/equipmentFloorSync.js runElevatorRemoval・
// runElevatorUsageChange）専用のエラーコード（ステップ5）。設置と同じ「messageが呼び出し元で
// 組み立て済み」様式——文言はA2（リードの仮定）どおり「昇降機の削除に失敗しました。」
// 「昇降機の用途の変更に失敗しました。」。
export const ERR_ELEVATOR_REMOVE_FAILED = 'ERR_ELEVATOR_REMOVE_FAILED';
export const ERR_ELEVATOR_REMOVE_FAILED_MESSAGE = '昇降機の削除に失敗しました。';
export const ERR_ELEVATOR_USAGE_FAILED = 'ERR_ELEVATOR_USAGE_FAILED';
export const ERR_ELEVATOR_USAGE_FAILED_MESSAGE = '昇降機の用途の変更に失敗しました。';

// 階追加時の昇降機の複製（finish/equipment/equipmentFloorSync.js copyElevatorsToNewFloor）専用の
// エラーコード（昇降機の仕様追加 ステップ6）。設置・削除・用途変更と同じ「messageが呼び出し元で
// 組み立て済み」様式。peek・保存の例外をこのコードで包み直して再スローする（新階の保存は1回だけ
// のため巻き戻しは不要）。
export const ERR_ELEVATOR_COPY_FAILED = 'ERR_ELEVATOR_COPY_FAILED';
export const ERR_ELEVATOR_COPY_FAILED_MESSAGE = '昇降機の複製に失敗しました。';

// 階追加時、直下階の器具行の一部を新階へ複製できなかった（区画できない・新階の階段等と衝突）場合の
// 通知文言（拒否ではなくトースト表示のみ。floorOrderChange.js の elevator follower が使う）。
export const ERR_ELEVATOR_COPY_SKIPPED = (floorName, count) =>
  `${floorName}へ複製できなかった昇降機があります（${count}基）。`;

// 階追加時、当該階の階段を新しい階へ複製する処理（finish/stair/stairFloorSync.js copyStairsToNewFloors）の
// 他階の読み書きが失敗した場合（KNOWN_TRANSITION_ERROR_CODES に載せ、message をそのまま見せる）。
export const ERR_STAIR_COPY_FAILED = 'ERR_STAIR_COPY_FAILED';
export const ERR_STAIR_COPY_FAILED_MESSAGE = '階段の複製に失敗しました。';

// 階追加時、当該階の階段の一部を新しい階へ複製できなかった（足元が昇降路・屋根などと重なる・セルを写せない）
// 場合の通知文言（拒否ではなくトースト表示のみ。floorOrderChange.js の stairCopy follower が使う）。
export const ERR_STAIR_COPY_SKIPPED = (floorName, count) =>
  `${floorName}へ複製できなかった階段があります（${count}件）。`;

// 下階追加で新しい地階へ当該階の外壁の中心線を写す処理（finish/basementFloorInit.js copyExteriorCLsToNewFloors）の
// 他階の読み書きが失敗した場合（KNOWN_TRANSITION_ERROR_CODES に載せ、message をそのまま見せる）。
export const ERR_BASEMENT_CL_COPY_FAILED = 'ERR_BASEMENT_CL_COPY_FAILED';
export const ERR_BASEMENT_CL_COPY_FAILED_MESSAGE = '地階への外壁の中心線の複製に失敗しました。';

// 階設定表を開くとき、全階の階段・下屋を読めなかった場合（階高の変更で蹴上が変わる階段を確かめられないまま
// 確定させないため、表を開かない）。
export const ERR_FLOOR_SETTINGS_LOAD_FAILED = '階の読込みに失敗したため、階設定表を開けませんでした。';

// 階削除に伴う昇降機の再採番（finish/equipment/equipmentFloorSync.js
// renumberEquipmentAfterFloorRemoval）専用のエラーコード（ステップ6）。他階の保存直前の例外で
// 保存済みの階を before へ巻き戻した後、このコードで包み直して再スローする。
export const ERR_ELEVATOR_RENUMBER_FAILED = 'ERR_ELEVATOR_RENUMBER_FAILED';
export const ERR_ELEVATOR_RENUMBER_FAILED_MESSAGE = '階を削除した後、昇降機の番号の詰め直しに失敗しました。';

// 階段の指定の確定（App.jsx convertStairFromNaming が applyRoomNaming へ再入した後）で例外が出た場合。
// 昇降機の設置・削除と同じ「messageが呼び出し元で組み立て済み」様式（KNOWN_TRANSITION_ERROR_CODES に載せ、
// floorTransitionErrorMessage がmessageをそのまま返す＝階切替の汎用文言に丸めない）。
export const ERR_STAIR_DESIGNATE_FAILED = 'ERR_STAIR_DESIGNATE_FAILED';
export const ERR_STAIR_DESIGNATE_FAILED_MESSAGE = '階段の指定に失敗しました。';

// 部屋の削除（finish/FinishModeState.js roomDeleteBlockReason）専用。道連れで消える部分指定の子・孫に
// 階段のペア部屋があると、階段が自階だけ消えて上の階の分身・階段吹抜けが残るため、何も変更せず拒否する。
export const ERR_ROOM_DELETE_HAS_STAIR_CHILD = '部分指定に階段を含む部屋は削除できません。先に階段を削除してください。';
// peek・保存・commitActive の例外を、保存済みの上の階を before へ巻き戻した後（書込み前ならそのまま）
// このコードで包み直して再スローする（昇降機の削除と同じ「messageが呼び出し元で組み立て済み」様式）。
export const ERR_STAIR_DELETE_FAILED = 'ERR_STAIR_DELETE_FAILED';
export const ERR_STAIR_DELETE_FAILED_MESSAGE = '階段の削除に失敗しました。';
// 上の階への保存直前に書込み世代が不一致（他の処理がその階を書き換えた）で中断した場合。
export const ERR_STAIR_FLOORS_CHANGED = '他の処理が階を書き換えたため、階段の削除を中断しました。もう一度実行してください。';

// tagCLOpFailureと同じ「既に文字列codeを持つ既知エラーはそのまま返す（上書きしない・
// 二重ラップしない）」規約（QA指摘m4）。equipmentFloorSync.js（保存・commitActiveの例外）と
// App.jsx installElevatorFromNaming/deleteElevatorEquipment/changeElevatorUsage
// （動的import・structuralSync.whenIdle()の失敗）の両方から使う——どちらから投げても同じ
// 識別コード・同じ文言でトースト表示される。code・messageは呼び出し元が指定する
// （既定は設置のERR_ELEVATOR_OP_FAILED。削除・用途変更はcode・messageを渡す——3操作それぞれに
// tag関数を増やさず、識別を引数で渡す形にまとめている）。
export function tagElevatorOpFailure(err, { code = ERR_ELEVATOR_OP_FAILED, message = ERR_ELEVATOR_OP_FAILED_MESSAGE } = {}) {
  if (err instanceof Error && typeof err.code === 'string') return err;
  return Object.assign(new Error(message, { cause: err }), { code });
}

// 構造パネルの変更（App.jsx handleStructureChanged → structuralOrchestration.js recomputeStructuralComposition）の
// 再計算が失敗した場合。mutate 前へ巻き戻した後に投げ直されるため、文言で「戻した」ことを伝える
// （階切替の汎用文言ERR_FLOOR_SWITCH_FAILEDに丸めない）。tagCLOpFailureと同じ「既に文字列codeを持つ既知エラーはそのまま返す」規約。
export const ERR_STRUCT_CHANGE_FAILED = 'ERR_STRUCT_CHANGE_FAILED';
export const ERR_STRUCT_CHANGE_FAILED_MESSAGE = '構造の変更に失敗したため、変更前に戻しました。';
export function tagStructChangeFailure(err) {
  if (err instanceof Error && typeof err.code === 'string') return err;
  return Object.assign(new Error(ERR_STRUCT_CHANGE_FAILED_MESSAGE, { cause: err }), { code: ERR_STRUCT_CHANGE_FAILED });
}

// 階/モード切替の関門（App.jsxのrunBusy経由の5経路）が捕まえた例外を、どの文言で
// ユーザーへ見せるか決める純関数。関門のコールバック本体はmodeBoundaries.exit/enter（仕上げ脱出の
// 壁再生成等）を経由するため、swap自身のERR_FLOOR_SWITCH_UNSTABLE以外にも、.codeに識別用コードを
// 持つ既知のエラー（例: カタログ重複検出のERR_CATALOG_DUPLICATE）が飛んでくることがある——
// これらは message が呼び出し元で意味のある内容に組み立てられているため、生の技術的な例外
// （IDBエラー等）だけをERR_FLOOR_SWITCH_FAILEDに丸め、既知のものはmessageをそのまま見せる
// （QA指摘F3・2026-09-27）。
const KNOWN_TRANSITION_ERROR_CODES = [
  ERR_CATALOG_DUPLICATE, ERR_STRUCT_CHANGE_FAILED, ERR_ELEVATOR_OP_FAILED, ERR_ELEVATOR_REMOVE_FAILED, ERR_ELEVATOR_USAGE_FAILED,
  ERR_ELEVATOR_COPY_FAILED, ERR_ELEVATOR_RENUMBER_FAILED, ERR_STAIR_DESIGNATE_FAILED,
  ERR_STAIR_DELETE_FAILED, ERR_STAIR_COPY_FAILED, ERR_BASEMENT_CL_COPY_FAILED,
];

// 昇降機の設置（finish/equipment/equipmentOps.js validateElevatorInstall）専用の拒否文言。
// 矩形でない選択（器具単位の矩形判定。isRectangularCellSet）で確定しようとした場合。
export const ERR_ELEVATOR_NOT_RECTANGLE = '昇降機は矩形で指定してください。';
// 屋外区分で確定しようとした場合（昇降機は屋内固定）。
export const ERR_ELEVATOR_EXTERIOR = '昇降機は屋内で指定してください。';
// 新規候補（未指定セルからの新規ドラッグ）でない場合（既存の命名済み部屋の統合＝判定2、
// 部分指定の確定等）。
export const ERR_ELEVATOR_NOT_UNASSIGNED = '昇降機は未指定のエリアから指定してください。';

// 屋根（RoomFeature.ROOF。finish/FinishModeState.js applyNaming）の拒否文言。新規候補（未指定セル・
// 未定義部屋のセルからの新規ドラッグ）でない場合（既存の命名済み部屋・統合・部分指定）、または
// 候補のセルが階段・他の部屋と重なる場合。
export const ERR_ROOF_NOT_UNASSIGNED = '屋根は未指定のエリアから指定してください。';

// 続きの階段の指定（FinishModeState._stairVoidRejection）の拒否文言。直下階の階段の吹抜け（STAIR_VOID）を
// 含む範囲を階段以外（なし・吹抜け・屋根・昇降機）で確定しようとした場合。
export const ERR_STAIR_VOID_NOT_STAIR = '下の階の階段の吹抜けを含む範囲は、階段としてだけ指定できます。';
// 同、範囲が吹抜けの一部だけと重なる場合（吹抜けは全体を含めて指定する）。
export const ERR_STAIR_VOID_PARTIAL = '下の階の階段の吹抜けは、全体を含めて指定してください。';

// 屋根を付けた直後の警告（finish/roof/roofFloorCheck.js findUpperRoomsOverCells）。屋根の上の階の同じ
// 位置に屋内の部屋があるとき。警告だけで、上の階の部屋は自動では変更しない。floorLabels は階名の配列。
export const ERR_ROOF_UPPER_ROOMS = (floorLabels) =>
  `屋根の上の階（${floorLabels.join('・')}）に部屋があります。上の階の部屋は自動では変更されません。`;

// 部分詳細図を建具記号の三方枠（方立・上枠）・窓（方立・上枠・下枠）の寸法に合わせられなかった場合（openings/openingDetailFitCheck.js）。
// 方立の図を流用または既定の断面（solid/bent）で描いており、図面は止まらない。reason は合わせられない理由
// （fit の error.message など）。slot は DetailSlot の値（'jamb'＝方立・'head'＝上枠・'sill'＝下枠。core/constants.js）。
const DETAIL_SLOT_LABELS = Object.freeze({
  jamb: '方立（縦枠）', head: '上枠', sill: '下枠', figure: '姿図', figureBack: '姿図（向こう側）', floorWall: '床と壁', wallCeiling: '壁と天井',
  kneeTop: '腰壁の天端', dropBottom: '垂れ壁の下端', floorStep: '床の段差',
  ceilingStep: '天井の段差',
  fitting: '建具一式', // 建具一式の参照切れ（C7）。「建具個別の指定 の建具一式の詳細図が…」
});
// 部屋の取り合い（Room.detailRefs。S8a）の通知文の主語。ERR_DETAIL_FIT_FAILED の symbolKey・ERR_DETAIL_FIGURE_NOT_FOUND の owner に渡す。
export const detailOwnerRoom = (roomName) => `部屋「${roomName || '（名称なし）'}」`;
// 天井区画（CeilingZone.detailRefs。S8b-4a）の通知文の主語。n＝部屋の区画の番号（天伏パネルの「区画n」と同じ 1 始まり）。
export const detailOwnerCeilingZone = (roomName, n) => `${detailOwnerRoom(roomName)}の区画${n}`;
// 腰壁・垂れ壁の記録（kneeDropWalls の detailRefs。S8b-1）の通知文の主語。roomNames＝区間の両側の部屋名（無名屋外は null・空）。
export const detailOwnerKneeDrop = (roomNames = []) => {
  const names = roomNames.filter(n => typeof n === 'string' && n !== '');
  return `腰壁・垂れ壁（${names.length > 0 ? names.join('／') + (names.length > 1 ? 'の間' : '') : '部屋なし'}）`;
};
// 腰壁・垂れ壁ダイアログの部分詳細欄・表の側の文言（ui/KneeDropWallDialog.jsx。S8b-1）。
export const KNEE_DROP_DETAIL_TEXT = Object.freeze({
  topLabel: '天端の部分詳細', bottomLabel: '下端の部分詳細', frontSideLabel: '表の側', none: 'なし', noRoom: '（部屋なし）',
});
// 仕上げモードの部屋カードの「部分詳細」欄の文言（finish/roomDetailRefsEdit.js）。
export const ROOM_DETAIL_REF_TEXT = Object.freeze({ section: '部分詳細', none: 'なし' });
// 姿図の「図の束」（views）の文言。ヘルパー（ui/detailHelperForm.js）・保守パネルの閲覧・差分表示（catalog/catalogDiffView.js）が共有する。
// キーは DetailPlacementView の値（core/constants.js。ここは葉なので literal で持ち、対応はテストで固定する）。
export const DETAIL_VIEWS_GROUP_LABEL = '図の束';
// 姿図の製品情報（product）の文言。ヘルパー・保守パネルの閲覧・差分表示が共有する。キーは DetailProductField の値（葉なので literal で持つ）。
export const DETAIL_PRODUCT_TEXT = Object.freeze({
  group: '製品情報', name: '名称', maker: 'メーカー', modelNumber: '型番', colorName: '色',
});
// 仕上げモードのタブ「衛生・家具・空調」（姿図の配置。finish/placedFigure/PlacedFigureTab.jsx）の文言。
export const PLACED_FIGURE_TAB_TEXT = Object.freeze({
  place: '配置', tapPoint: '配置点をタップ', cancel: '取消', rotate: '90° 回転', mirror: '鏡像', remove: '削除',
  note: '備考', x: 'X', y: 'Y', height: '高さ', registerHint: '部分詳細図ヘルパーで登録',
});
export const DETAIL_PLACEMENT_VIEW_LABEL_TEXT = Object.freeze({
  front: '正面図', back: '背面図', left: '左側面図', right: '右側面図', ceiling: '見上げ図',
});
export const detailSlotLabel = (slot) => (Object.hasOwn(DETAIL_SLOT_LABELS, slot) ? DETAIL_SLOT_LABELS[slot] : slot);
export const ERR_DETAIL_FIT_FAILED = (label, symbolKey, reason, slot) =>
  `詳細図 ${label} を ${symbolKey} の${detailSlotLabel(slot)}に合わせられません: ${reason}`;
// 外壁をホストにする引き戸（SLIDE_SINGLE）は外付けにできない（R12。壁を枠厚分欠き込むので屋内壁に限る）。建具モード突入時の通知の文言。
export const ERR_SLIDE_WIDTH_TOO_SMALL = '引き戸の間口はこれ以上縮められません。';
export const ERR_SLIDE_ON_EXTERIOR_WALL = '外壁にある引き戸は外付けにできません（従来の描き方のままです）';
// 参照先の詳細図がカタログ（ライブラリ・同梱）に無い場合。owner は参照の持ち主——記号キー、建具個別の指定なら
// DETAIL_OWNER_OPENING、fit のメモ口では図のキー。
export const DETAIL_OWNER_OPENING = '建具個別の指定';
export const DETAIL_OWNER_FITTING = '建具一式';
export const ERR_DETAIL_FIGURE_NOT_FOUND = (owner, slot) =>
  `${owner} の${detailSlotLabel(slot)}の詳細図がカタログに見つかりません（保存ファイルに図が入っていません。以前の保存か、ライブラリから削除された図です）`;
// 詳細図の基準（Datum）が取り付け先（既定は三方枠。建具の姿図なら「建具の姿図」）の供給できない組（role・軸・種別）のとき。
export const DETAIL_TARGET_ELEVATION = '建具の姿図';
export const DETAIL_TARGET_JUNCTION = '部屋の取り合い';
export const DETAIL_TARGET_PART = '腰壁・垂れ壁の部位';
export const DETAIL_TARGET_PART_STEP = '床の段差の部位';
export const DETAIL_TARGET_PART_CEILING_STEP = '天井の段差の部位';
export const DETAIL_TARGET_PLACED_FIGURE = '姿図の配置';
export const ERR_DETAIL_DATUM_UNSUPPORTED = (datumId, role, target = '三方枠') =>
  `基準 ${datumId}（${role}）は${target}では使えません`;
// 姿図の配置（PlacedFigure）に配置図でない分類（category・view・subject）の図を渡したとき（finish/placedFigure/placedFigureTargets.js）。
export const ERR_DETAIL_NOT_PLACED_FIGURE = (classification) =>
  `${DETAIL_TARGET_PLACED_FIGURE}の対象ではありません: ${classification}`;
// 部分詳細図ヘルパー（全画面パネル）の動的 import が失敗したときのトースト。
export const ERR_DETAIL_HELPER_LOAD_FAILED = '部分詳細ヘルパーの読み込みに失敗しました';
// ---- DXF 読込み（部分詳細図 S7a。detail/dxf/ と ui/detailHelperForm.js）----
// 警告（WARN_*。保存は止めない）。コードは core/constants.js の DxfWarning、対応は ui/detailHelperForm.js の describeDxfWarning。
export const WARN_DXF_UNIT_UNKNOWN = '単位（$INSUNITS）が読めないため、1 単位 = 1 mm として読みました。単位を確かめてください';
export const WARN_DXF_CONTOUR_OPEN = '閉じた輪郭になっていません（開いている、または枝分かれしています）';
export const WARN_DXF_SELF_INTERSECT = '輪郭が自己交差しています';
export const WARN_DXF_LICENSE_UNKNOWN = 'ライセンス注記が未記入です（保存はできます）';
export const WARN_DXF_INSERT_DEPTH = (block, max) => `ブロック ${block} の挿入は入れ子が ${max} 段を超えるため展開しませんでした`;
export const WARN_DXF_INSERT_CYCLE = (block) => `ブロック ${block} の挿入が循環しているため、そこで打ち切りました`;
export const WARN_DXF_UNSUPPORTED_ENTITY = (type, count) => `未対応の図形 ${type} を ${count} 件無視しました`;
export const WARN_DXF_NONUNIFORM_SCALE = (block) => `ブロック ${block} は縦横の倍率が違うため、円・円弧を多角形で近似しました`;
export const WARN_DXF_ENTITY_LIMIT = (limit) => `図形が多すぎるため ${limit} 件で打ち切りました`;
export const WARN_DXF_SELF_INTERSECT_UNCHECKED = '図形が密集しているか多すぎるため、輪郭の自己交差は調べていません';
export const ERR_DXF_NOT_BYTES = 'ファイルの内容をバイト列として読めませんでした';
export const WARN_DXF_NO_DIGEST = 'ファイルの sha256 を取れなかったため、出所の sha256 は空になります（読み込みは続けました）';
// 拒否（ERR_*。読み込まない）。コードは DxfReject。
export const ERR_DXF_BINARY = 'バイナリ形式の DXF は読み込めません。ASCII 形式で保存し直してください';
export const ERR_DXF_BAD_GROUP_CODE = (line) => `DXF として読めません（${line} 行目が数値ではありません）`;
export const ERR_DXF_TRUNCATED = 'DXF が途中で切れているため読み込めません';
export const ERR_DXF_UNEXPECTED = (message) => `DXF の読み込み中に想定外の問題が起きました: ${message}`;
export const ERR_DXF_FILE_READ_FAILED = 'ファイルを読み込めませんでした';

// ---- PDF 読込み（部分詳細図 S7b。detail/pdf/ と ui/detailHelperPdf.js）----
// 警告（WARN_PDF_*。保存は止めない）。コードは core/constants.js の PdfWarning、対応は ui/detailHelperPdf.js の describePdfWarning。
export const WARN_PDF_PAGE_LIMIT = (limit, total) => `ページが多いため先頭の ${limit} ページまでしか選べません（全 ${total} ページ）`;
export const WARN_PDF_NO_PATHS = '選んだ範囲に線（パス）がありません。範囲を広げるかページを確かめてください';
export const WARN_PDF_TEXT_IGNORED = (count) => `ページ内の文字 ${count} 件は読み込みません（線だけを写します）`;
export const WARN_PDF_IMAGE_IGNORED = (count) => `ページ内の画像 ${count} 件は読み込みません（線だけを写します）`;
export const WARN_PDF_PATH_LIMIT = (limit) => `線が多すぎるため、先頭の ${limit} 本で打ち切りました`;
export const WARN_PDF_SEGMENT_LIMIT = (limit) => `線分が多すぎるため、${limit} 線分で打ち切りました`;
export const WARN_PDF_UNKNOWN_DRAW_OP = (count) => `未知の描画命令で読めなかった経路が ${count} 件あります（その経路の残りは写していません）`;
export const WARN_PDF_NON_FINITE_SEGMENT = (count) => `座標が数値でない線分 ${count} 件を捨てました`;
export const WARN_PDF_SCALE_MISSING = '縮尺（1/N の N）を入力してください。入力するまで mm に換算できません';
// 拒否（ERR_PDF_*。読み込まない）。コードは PdfReject。
export const ERR_PDF_NOT_PDF = 'PDF として読めません（先頭に %PDF- がありません）';
export const ERR_PDF_LOAD_FAILED = (message) => `PDF を開けませんでした（壊れている・暗号化されているなど）: ${message}`;
export const ERR_PDF_WORKER_UNAVAILABLE = 'PDF の読込み部品を起動できませんでした。再読み込みしてもう一度お試しください';
export const ERR_PDF_SIZE_LIMIT = (limitMb) => `ファイルが大きすぎます（${limitMb} MB まで）`;
export const ERR_PDF_PAGE_NOT_FOUND = (page) => `${page} ページ目は選べません`;
export const ERR_PDF_NO_PAGES = 'ページが 1 つもありません';
export const ERR_PDF_PAGE_FAILED =(message) => `ページを読み込めませんでした: ${message}`;
// 展開モードのトースト用。最初の1件の文言に、残りの件数を添える。
export const ERR_DETAIL_FIT_FAILED_MORE = (firstMessage, restCount) =>
  `${firstMessage}（ほか${restCount}件）`;

// 階段の指定の拒否（finish/stair/stairRoofConflict.js・App.jsx convertStairFromNaming）。階段は上の階へ
// 展開される（中間階は階段、最上階は階段吹抜け）が、その位置に屋根があると屋根セルと重なるため、
// 指定を確定せず何も変更しない。floorLabels は衝突する階名の配列。
export const ERR_STAIR_UPPER_ROOF = (floorLabels) =>
  `${floorLabels.join('・')}の屋根と重なるため、階段を指定できません。`;
// 上の階の読込み（peek）が失敗して屋根との重なりを確かめられなかった場合。何も変更しない。
export const ERR_STAIR_UPPER_CHECK_FAILED = '上の階を確認できなかったため、階段を指定できませんでした。';
// 上の階の確認（非同期）の間にモード・階・部屋が変わり、確認結果が今の状態に当てはまらなくなって
// 指定を中断した場合（昇降機の世代不一致 ERR_ELEVATOR_FLOORS_CHANGED と同じ「もう一度」の様式）。
export const ERR_STAIR_DESIGNATE_ABORTED = '上の階の確認中に状態が変わったため、階段の指定を中断しました。もう一度実行してください。';

// 昇降機の上階事前チェック（finish/equipment/equipmentFloorPlan.js judgeElevatorInstall）専用の
// 拒否文言（ステップ4・S2）。floorLabel は plane.name。
// 上階の変換後セルが命名済み部屋・階段・吹抜け・別グループの器具に重なる場合。targetLabelは
// findShaftInstallConflicts が返す相手の表示名（「階段」「吹抜け」「階段吹抜け」「EV2」「昇降路」
// 「部屋名」等）。
export const ERR_ELEVATOR_UPPER_CONFLICT = (floorLabel, targetLabel) =>
  `${floorLabel}の${targetLabel}と重なるため設置できません。`;
// 上階で対応する中心線はあるが、範囲が足りず変換後セルが矩形に閉じない場合。
export const ERR_ELEVATOR_UPPER_UNCLOSABLE = (floorLabel) =>
  `${floorLabel}では昇降路の範囲を区画できないため設置できません。`;

// 昇降機の設置・削除・用途変更（finish/equipment/equipmentFloorSync.js runElevatorInstall・
// runElevatorRemoval・runElevatorUsageChange）共通。上階（アクティブ以外の階）への保存直前に
// 書込み世代（storage/floorWriteGeneration.js）が不一致＝他の処理がその階のfloorsを書き換えた
// ため中断した場合。ERR_FLOOR_SWITCH_UNSTABLEと同じ「もう一度お試しください」の様式に合わせる。
// 3操作で共有するため文言は操作名（「設置」等）に依存しない形にする（リードの裁定）。
export const ERR_ELEVATOR_FLOORS_CHANGED = '他の処理が階を書き換えたため、昇降機の操作を中断しました。もう一度実行してください。';

export function floorTransitionErrorMessage(err) {
  if (err instanceof Error && err.message === ERR_FLOOR_SWITCH_UNSTABLE) return err.message;
  // CL操作の入口（tagCLOpFailure）が付けたcode。既知のcode一覧（KNOWN_TRANSITION_ERROR_CODES）と
  // 違い、messageは技術的な生の例外のままなので固定文言に丸める（入力規制ステップ3）。
  if (err?.code === ERR_CL_OP_FAILED) return ERR_CL_CONVERT_SYNC_FAILED;
  if (err?.code != null && KNOWN_TRANSITION_ERROR_CODES.includes(err.code)) return err.message;
  return ERR_FLOOR_SWITCH_FAILED;
}
