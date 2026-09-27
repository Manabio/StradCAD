const KIND_LABEL = { struct: '通り芯', center: '中心線', aux: '補助線', beam: '梁芯' };

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

export const ERR_CL_CENTER_UPGRADED =
  '同位置に中心線があります。その中心線を削除して、追加する通り芯を参照するように変更します。';

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
// 中心⇔通り芯の入替えの階またぎ同期（centerLineFloorSync.js）がIDB書込等で失敗した場合。
// 昇格は確定後の回収失敗（途中分はundoエントリへ合成済み）、降格は確定前の複製失敗（全体ロールバック済み＝降格されていない）。
export const ERR_CL_CONVERT_SYNC_FAILED = '他階への反映に失敗しました。';

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
// （階段・階段吹抜け・未定義）のセル辺がこのCLを持つ場合（finish/roomReinterpret.js
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

// 階/モード切替の関門（App.jsxのrunBusy経由の5経路）が捕まえた例外を、どの文言で
// ユーザーへ見せるか決める純関数。関門のコールバック本体はmodeBoundaries.exit/enter（仕上げ脱出の
// 壁再生成等）を経由するため、swap自身のERR_FLOOR_SWITCH_UNSTABLE以外にも、.codeに識別用コードを
// 持つ既知のエラー（例: カタログ重複検出のERR_CATALOG_DUPLICATE）が飛んでくることがある——
// これらは message が呼び出し元で意味のある内容に組み立てられているため、生の技術的な例外
// （IDBエラー等）だけをERR_FLOOR_SWITCH_FAILEDに丸め、既知のものはmessageをそのまま見せる
// （QA指摘F3・2026-09-27）。
const KNOWN_TRANSITION_ERROR_CODES = [ERR_CATALOG_DUPLICATE];

export function floorTransitionErrorMessage(err) {
  if (err instanceof Error && err.message === ERR_FLOOR_SWITCH_UNSTABLE) return err.message;
  if (err?.code != null && KNOWN_TRANSITION_ERROR_CODES.includes(err.code)) return err.message;
  return ERR_FLOOR_SWITCH_FAILED;
}
