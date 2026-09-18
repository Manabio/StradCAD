# 用語集

## CL（CenterLine）
座標の源泉となる基準線。`X`(垂直)/`Y`(水平)/`R`(放射)。`value`=確定座標、`pendingDelta`=ドラッグ中の未確定変位、`effectiveValue`=両者の合計（描画・スナップは常にこれを参照）。

## 通り芯 / 中心 / 補助線 / 梁芯（AddCLDialogの種別）
| 種別 | discipline | labeled | 意味 |
|---|---|---|---|
| 通り芯 | `struct` | `true` | グリッド軸。ガターラベル・交点自動生成の対象 |
| 中心 | `arch` | `false` | ラベルなし中心線（フロア固有） |
| 補助線 | `arch` | `false` | ラベルなし破線（フロア固有） |
| 梁芯 | `fuse` | `false` | ラベルなし中心線（フロア固有）。小梁の自動生成トリガー。構造モード（`appMode==='structure'`）のAddCLDialogではこれのみ選択可 |

ガターラベル・ガター丸の表示対象は「`discipline==='struct'` かつ `labeled===true`」のみ。梁芯は「中心」と同じ表現形式（extentLoRef/HiRef）を使う別種別（`centerLineKind()`が`'beam'`を返す）。設計意図は`.claude/structural-model.md`。

平面モード限定で「通り芯」⇔「中心」は相互変換できる（CL端点のロングタップ→「通り芯に」、通り芯の線上ロングタップ→「中心に」）。id維持のグラフ間移籍（delete+再生成ではない）。設計意図は`.claude/data-model.md`。

構造モード（`appMode==='structure'`）では「中心」「補助線」（`discipline:'arch'`かつ`labeled:false`）は描画・寸法対象から外れる（データは残る。削除ではない）。構造モードで目印にする浮いた線は梁芯に一本化する設計。

## discipline（分野）
`arch`(意匠・既定) / `struct`(構造) / `fuse`(伏図) / `mep`(設備) / `elec`(電気)。

## Plane / 採用・検討
1フロア分のデータ単位。`isAlternative=false`が採用（実案）、`true`が検討（代替案、親採用を`referenceId`で参照）。

## 屋根専用平面（isRoofPlane）
構造モードのみに存在する合成Plane。`project.planes`/`orderedTabs`から除外、`project.roofPlane`で個別アクセス。
ぞー
## kind / feature（Roomの2軸区分）
`kind`＝屋内/屋外（内外判定はこちらのみ参照）。`feature`＝階段/吹抜け/階段吹抜け/なし（属性）。旧enumの`void`は読込時に「屋内+吹抜け」へ移行される。設計意図は`.claude/data-model.md`。

## 階段吹抜け（STAIR_VOID）
最上階の屋内階段footprintへ自動指定される自動管理Room（`feature='stairVoid'`・無名）。ユーザー指定の吹抜け（`feature='void'`）と異なり一切描画せず、仕上げ表・部屋ドラッグの対象外。階追加で中間階になると階段のペアRoomへ転用される。設計意図は`.claude/data-model.md`。

## 部分指定 / 参照元
**部分指定**＝既存部屋の一部セルに別名を与えるRoom（`referenceRoomIds`で参照元＝親を指す。外周壁は親が担う）。**参照元**＝`referenceRoomIds`が空のRoom。親の削除は部分指定を道連れにする。部分指定の面積が親の残余（親セル−全部分指定セル）を上回ると親子は自動で入れ替わる（`finish/roomReinterpret.js`の`normalizePartialDominance`。命名確定・統合・仕上げモード突入時。CH継承・外周壁・展開図の帯の基準も入れ替わる）。部屋名の自動配置は部分指定に奪われていないセルから選ぶ（`finish/roomLabel.js`が描画・クリック判定共通の単一情報源）。

## 段差見付け面（展開図）
部屋**内部**（壁の無い境界）でFLの異なる区間がある箇所に、段差の見えがかり（見付け）を専用の面として展開図に挿入したもの
（`elevation/elevationStepFace.js`。壁際の段差は`wallAdjacentFloorSegments`の床線プロファイルで別途表現する）。設計意図は
`.claude/elevation-model.md`「面リストの合成」節。

## 袖壁（展開図）
面に直交し、面の仕上げ面へ到達して室内側へ一定量以上突き出し室内で終端する壁（外壁・自室外周生成壁・同軸壁は除く）。
展開図では面をその位置で分割し、壁のない端部（`hasWallAtLocal0/Run=false`）として扱う（`elevation/elevationFaces.js`の
`perpendicularWallsOnFace`。設計意図は`.claude/elevation-model.md`）。腰壁は同条件で`kneeDropWalls`にknee指定を持つもの。

## 袖柱（構造・在来木造）
建具（窓・扉・三方枠。全建具対象）の両側にクリアランス5mmを空けて自動生成する構造柱（役柱ではなく`WoodColumn`。階の柱寸と同寸）。展開図の「袖壁」とは無関係。`WoodColumn.woodJambRef={openingId, side, isVertical}`を持つ柱がこれで、走行方向の位置（AXIS）はCLではなく開口位置から都度導出する。他の柱と重なる場合は生成しない。設計意図は`.claude/structural-model.md`「建具の袖柱」節。

## オフセットアンカー柱（構造・在来木造・3b/3h-2/3i）
上階柱直下（3b）・上階の頭つなぎ/受梁/床梁が下階の壁を横切る位置（3h-2）・梁の支持長1820ルール（3i）で、走行方向にCLが無いときに立てる柱（当初は3h-2限定だったが2026-09-19のB-3裁定で3bにも解禁）。`WoodColumn.woodAxisOffset={isVertical, offset}`を持ち、走行方向のAXISは最寄りの解決可能なCL（袖柱と同じプレースホルダ）＋オフセットで決まる。袖柱と同じ「AXISが実位置そのもの」だが、CLの由来（開口位置か最寄りCLか）が異なる別概念。設計意図は`.claude/structural-model.md`「3h-2」「B-3」「3i」節。

## 支持長1820ルール（構造・在来木造・3i）
`role:'primary'`の梁の支持長（3dの`alongCoordOnAxis`と同一の支持点間距離）が1820mmを超える区間へ、1つ下の階に柱を追加する規律。柱を立てられるのは梁の真下を平行に走る壁がある位置のみ。位置は直交する通り芯・意匠中心線を優先し、無ければ910グリッド（`supportSpanColumnPositions`、`woodFraming.js`）。最上階から降順（`.claude/structural-model.md`「反映パスは最上階から」節）に反映することで最下階まで同位置に連鎖する。設計意図は`.claude/structural-model.md`「3i」節。

## 開放スパン（展開図）
壁の無い部屋内部の境界を挟んで、同じ部屋の壁面（面）が「壁のある区間」から先へ連続して延長される区間
（`elevation/elevationOpenSpan.js`のspans。`kind:'wall'|'open'`。openはその先に別の実効FLを持つセルが続き、そちらの床が
見えがかりとして見えることを示す）。段差見付け面と異なり「面自体」を延長する仕組み。`composeRoomFaces`に配線済み。
設計意図は`.claude/elevation-model.md`「開放スパン」節。

## パネル統合（展開図）
壁面の段差でしか分かれていない同letterの面（例: 室の南側境界が途中で1000だけ奥へ折れ、返し壁を挟んで続く）を、
**面は分けたまま**1枚のパネルとして扱う仕組み（`elevation/elevationFaceList.js`の`mergeSteppedFacesIntoPanel`。
共通の`panelId`を与え、接合端の「壁断面の有無」だけをパネル単位で評価し直す）。帯では世界x整合で隙間なく並べ、
面ラベル・採番はパネルで1つ（`labelFaces`はパネル数で数える）。設計意図は`.claude/elevation-model.md`「パネル統合」節。

## Edge（境界エッジ） / boundaryMaster
仕上げモードの部屋境界。`boundaryMaster`はその層構成（壁の材構成）の既定値セット。

## interiorMaster（内装マスター）
部屋種別ごとの壁材・壁仕上げ・天井高さの既定値セット。`Room.templateKey`で参照、`customOverrides`で個別上書き。

## 柱芯（ColumnAxis）／偏芯量
**柱芯**＝柱の中心。**偏芯量**＝通り芯と柱芯の距離。ラーメン系構造（S造/SRC造/RC造(ラーメン)）でのみ非0になり、`columnAxisOffsets: Map<clId, number>`（per-floor）に通り芯からの偏芯量だけを持つ。設計意図は`.claude/structural-model.md`。

## 出幅（columnFaceProjection）
**出幅**＝通り芯から柱外面までの距離。柱芯・偏芯量の真実値で、**1構造×1通り芯**（`structuralInfo.columnFaceProjections`）で持つ。図のX/Y出幅寸法、または描画エリアの○「柱芯」ラベルのロングタップで編集する。設計意図は`.claude/structural-model.md`。

## role（構造部材のrole）
柱=`standard`/`foundation`、梁=`primary`/`secondary`/`foundation`/`eaves`/`roof`/`landing`（踊り場受け梁。記号`LG`）/`sill`（土台。記号`SL`。在来木造の基礎伏図＝最下階専用）。伏図の慣習（基礎伏図に柱なし等）に対応する。

## 伏図記号
伏図（framing plan）の柱記号。×＝下階柱（断面□に対角線2本）、□＝当該階（自階）柱（輪郭のみ）。在来木造のみ（他の主構造は断面そのまま）。設計意図は`.claude/structural-model.md`。

## memberNo（部材番号・タグ）
構造部材の採番結果のキャッシュ（`記号+順位`。導出結果を実体へ書き戻したもので、真実は毎回の採番）。設計意図は`.claude/structural-model.md`。

## 材寸署名（signature） / numberGroupId / 部材グループ台帳（memberGroupLedger）
**材寸署名**＝部材の材料・断面・配筋等から導出する採番グループの既定キー（`memberCatalog.memberSignature`）。**numberGroupId**＝分割・統合・手動採番でのみ設定される明示グループID（null＝署名から自動導出）。**部材グループ台帳**（`project.memberGroupLedger`）＝上記の明示操作だけを持つ建物全体・永続の台帳（`grp.spec`/`grp.join`/`grp.no`/`grp.mergedInto`）。設計意図は`.claude/structural-model.md`。

## 各階柱寸法
在来木造の柱寸（幅mm）を階ごとに持つ値（`graph.woodColumnWidthMm`。null＝ルール既定120角）。構造リスト柱グループ見出しの欄で編集する（既定90/105/120角）。解決は`structural/structureRules.js`の`woodColumnWidthMm`/`woodColumnSectionId`が唯一の入口——柱の材幅（`conformWoodSections`）、壁下地材（`conformWoodBacking`）、壁の鮮度キー（`col=`）はすべてこれを経由する。**梁の材幅（標準材）は自階のこの値ではなく「梁を支える1つ下の実体階」の値を参照する**——下記「標準材（在来）」参照。**柱1本単位では個別指定（下記「共通／個別指定」）が優先する**（`columnWidthMm(column, graph, project)`が唯一の解決子。柱自身の断面はこの値を経由し、各階柱寸法を直接読まない）。設計意図は`.claude/structural-model.md`。

## 共通／個別指定（在来木造の柱寸）
在来木造の柱寸（幅mm）の2層（ステップ3）。**共通**＝`column.woodColumnWidthMm===null`。上記「各階柱寸法」（階の値）に従う。**個別指定**＝`column.woodColumnWidthMm`が木造正角のカタログ幅（`sectionCatalog.js`の`WOOD_SQUARE_WIDTHS`）を持つ状態。「個別指定＝階の値と同値」は存在しない（`MemberListTab.jsx`の`MemberColumnWidthSelect`が選択時に階の値と同じ幅ならnullへ正規化する。台帳の手動タグ（`grp.join`）を持つ共通グループへ、階の値と同幅の個別柱が署名一致で吸収され1本1タグが消える事故の再発防止）。梁幅・梁成算定・壁下地材・壁の鮮度キーには影響しない（柱1本の断面だけを変える機能）。設計意図は`.claude/structural-model.md`「在来木造の柱は『共通』と『個別指定』の2層」節。

## 標準材（在来）
在来木造の非標準梁判定の基準となる断面。**幅＝「梁を支える1つ下の実体階」の各階柱寸法、成＝梁成表の最小成**（`WOOD_BEAM_DEPTH_TABLE.depthsByLoads[0][0]`＝120。`woodRectSectionKey(幅, 120)`）。カタログ外の幅は`rulesFor(在来).defaultSections.beam`＝建物共通の固定値'WOOD-120x120'へフォールバック。個別採番（下記）の対象外を決める基準になる。

下階参照の生の計算は`structural/structureRules.js`の`beamColumnWidthMm(graph, belowGraph, project)`だが、これを直接呼べるのは`structural/structuralRecompute.js`と`structuralOrchestration.js`の下階編集経路（構造再計算そのもの）だけ——再計算のたびに結果を`graph.beamColumnWidthMm`（**非永続**の派生observableフィールド。FlatBuffers/graphSnapshot.jsには含めず、`clear()`でnullへ戻る）へ書き込む「唯一の書き込み元」。それ以外の全消費者（`standardBeamSectionFor`＝`memberNumbering.js`の採番パイプライン`collectFloorGroups`/`applyNumbers`/`renumberMembers`、UI＝`MemberListTab.jsx`、梁芯CL操作＝`transform/centerLineOps.js`）は`resolvedBeamColumnWidthMm(graph, project)`（＝`graph.beamColumnWidthMm ?? woodColumnWidthMm(graph, project)`。未再計算＝nullの間だけ自階の値で暫定）を経由するだけで、belowGraphを一切持ち回らない。

（実機裁定ステップ4 C-2 QA4: 標準材の解決がこの採番パイプラインとUI同期経路で二系統に分かれ、下階の柱寸変更後に構造リストの編集（`renumberMembers`）でタグが往復するバグが実機で見つかった。派生値方式で入口を1つに統一して解消した。）

## 個別採番
在来木造で標準材以外の梁（成が同じでも）を材ごとに個別のグループとして採番する規律（`memberCatalog.isIndividuallyNumbered`/`memberGroupKey`/`memberOrderKey`）。伏図で梁をタップして選択する対象でもある。柱にも同じ規律を適用する（`woodColumnWidthMm`を個別指定した柱は1本1タグ。上記「共通／個別指定」参照）。設計意図は`.claude/structural-model.md`。柱はさらに`columnGroupScope`（在来のみ`'floor'`）で採番グループ自体を階ごとに分ける（共通柱も含む。例1C1/2C1/3C1）——非在来（`'building'`）は建物全体でまとまる従来どおりの挙動（例1~3C1）。

## 図面合成 / FigureDef / レイヤ / バインディング
1枚の図面を「複数階×複数カテゴリの合成」として持つ仕組み（`.claude/figure.md`）。`FigureDef`＝レイヤ仕様の宣言的リスト。レイヤ＝`(供給階, カテゴリ, スタイル, 役割)`。バインディング＝レイヤが解決された自己完結グラフ（階固有CL＋通り芯参照を内包）。`composition.graphForCategory(mapName)` が描画・編集の対象グラフを一元的に返す。構造伏図は出演階＝`{自階, 自階−1}` の特殊例。

## lodLevel（LOD）
`SCHEMATIC`/`STANDARD`/`DETAIL`の3段階描画詳細度。壁・開口・構造部材（柱梁耐力壁スラブ）が共通の意味で参照する。

## 端点（CL端点ルール）
線分編集の結果、直交CLとの交点を失った中心線の端。座標がその場に固定され、延長・短縮の対象外。壁は端点ノードに壁があったと想定した分（下地偏芯量＋仕上げ厚）だけはね出して止まる。設計意図は`.claude/data-model.md`。

## bake
ドラッグ確定時に`pendingDelta`を`value`へ書き込み0に戻す操作（`bakeCLValue`）。

## 文書ファイル（.stq）
「保存」でダウンロードされる文書全体（全階・plane一覧・通り芯/構造情報/採番台帳・敷地・調査/計画情報）のファイル。拡張子は`.stq`（既存3文字拡張子との衝突が実質ない未使用域から選定）。保存ドキュメント（savedFloors/projects）の確定内容をIDBから読み戻してbase64で包んだJSONエンベロープ（`format:'stq-document'`、`storage/documentFile.js`）。「読込み」で全ストア置換→reloadで完全復元する。旧形式（単一グラフFlatBuffers・旧JSONスナップショット）はアクティブ階のみ復元。設計意図は`.claude/persistence-idb.md`。

## セッションロック
Web Locks APIで1タブだけを編集セッションの持ち主にする排他制御（`storage/sessionLock.js`）。非オーナータブは`openDB()`が例外を投げIndexedDBに触れない。自動昇格なし・read-only編集や同期は提供しない。設計意図は`.claude/persistence-idb.md`。

## 履歴ナビゲーション（またぎundo）／amend
**履歴ナビゲーション**＝undo/redo実行前に、エントリ記録時のコンテキスト（モード・階）へ表示を戻してから実行する仕組み。**amend**＝操作の後から非同期で確定した付随変更（階段変換後の上階自動設置等）を既存エントリへ合成する操作（`undoManager.amend`）。設計意図は`.claude/undo-redo.md`。

## 実段数 / 踏面 / 直進部 / 踊り場 / 周回部（階段）
**実段数**＝蹴上げを持つ物理的な段の数。**踏面**＝四角形を線分で分割してできる領域の数（実段数−1）。**直進部**＝実段差が2以上ある走行区間（階段設置階から数えて直進部1,2,…）。**周回部**＝平場に1以上の実段差を設けI/L/U字で他区間と接続する部分。**踊り場**＝周回部のうち実段差1のものの別称。設計意図は`.claude/stair-model.md`。

## 建具記号（fixtureType）
建具・窓の材質×種別を表す記号（`AW`/`JW`/`SW`/`AD`/`SD`/`WD`）。`Opening.fixtureType`の意味拡張（旧「窓の材質記号」→「建具記号」）で表現し、別フィールドを追加しない。記号ごとに独立して`記号-連番`（例`AW-1`）で採番する。設計意図は`.claude/opening-model.md`。

## 姿図（建具モード）
建具1件の正面図（枠・機構表現・寸法）。`openings/openingElevationFigure.js`が純関数でプリミティブ配列を生成し、`structural/sectionFigure/AutoScaledFigure.jsx`で描画する（断面図と同じレンダラを再利用）。

## 建具記号丸
平面図・建具モードに表示する「円に直径横線、上段=建具記号、下段=採番」の注記シンボル。窓は壁面から室内側へオフセット、開き戸は動作扇形の重心に配置し、常に画面に正対（回転なし・ズーム非依存サイズ）する。配置計算は`openings/openingTagPlacement.js`（純関数）、描画は`renderer/OpeningTagLayer.jsx`。設計意図は`.claude/opening-model.md`。

## 壁ラジアル（メニュー）
壁を長押しして開く建具・窓配置や腰壁・垂れ壁選択のメニュー。ヒット域は壁の仕上げ面線とその近傍のみ（壁の真ん中＝通り芯位置は対象外・通り芯側のメニューに譲る）。判定は`snap.js`の`findNearestWall`（本体は`openings/openingGeometry.js`の`nearestWallHit`）。設計意図は`.claude/opening-model.md`。

## 材側
壁の仕上げ面線（`axisValue`）から見て軸CL側。対義語は部屋側（面線から見て材と反対側）。壁ラジアルのヒット域判定（`isWallRadialHit`）で使う区分。

## 展開図の面letter（A/B/C/D）
室内展開図で部屋の4壁を指す記号。A＝平面上側（北）、B＝右（東）、C＝下（南）、D＝左（西）を
室内から見た面（時計回り・12/3/6/9時対応）。L字部屋では同じletterが複数面に分かれ
`B1`/`B2`のように連番が付く（数えるのは面ではなく**パネル**——パネル統合された面は1つと数え同じラベルになる）。
設計意図は`.claude/elevation-model.md`。

## 階段帯の面シーケンス（展開図）
階段部屋の展開図を、A/B/C/Dの部屋一周順ではなく「階段を上っていく順番」で並べたもの
（`elevation/elevationStairSequence.js`の`stairFaceSequence`。SWITCHBACK=1〜5(+2.5/4.5)、
STRAIGHT/STRAIGHT_LANDING=1〜4(+踊り場壁)。中身は下記「2.5D断面エンジン」が組み立てる。
WINDING/L_TURN/FLARED/OPEN_WELLは対象外＝従来面順へフォールバック）。設計意図は
`.claude/elevation-model.md`「階をまたぐ2層帯」節。

## 切断定義（SectionCut） / 2.5D断面エンジン
**切断定義（SectionCut）**＝階段帯の1枚の面が「どこを・どちらを向いて・どう切るか」を表す薄いデータ
（切断線・視線方向・図のx昇順対応・高さ範囲・第3層Flight/Landingへの参照）。タイプ別の表（`elevation/section/cuts/`
配下の`switchbackCuts.js`/`straightCuts.js`/`fanCuts.js`）が組み立てる。**2.5D断面エンジン**＝そのSectionCutを
受け取り、レイキャストで壁・アキ・階段のジグザグ／梯子／床CUT線を導出するタイプ非依存の処理一式
（`elevation/section/`配下。`sectionProbe.js`＝レイキャスト、`sectionEmit.js`＝線種、`sectionEngine.js`＝
列の統合、`sectionStair.js`＝階段幾何）。手書きのタイプ別シーケンスを置き換えたもの。設計意図は
`.claude/elevation-model.md`「階をまたぐ2層帯」節。

## ささら（ささら桁） / 踊り場受け梁
**ささら（ささら桁）**＝鉄骨階段で段板（踏み板）を両側から支える斜め梁（プレート。板厚12mm・成300mm程度。段部はささらの横に付く「横付け」納まりが一般的で、段部の木口はささらに隠れて見えない）。展開図では側面視＝段鼻から成ぶん下げた輪郭（DETAIL細線）、正面視＝断面矩形（CUT太線）で表す（`elevation/elevationStairSection.js`/`elevation/section/sectionStair.js`）。**踊り場受け梁**＝鉄骨階段・RC造階段の踊り場（せいのある帯として1層1ユニットを構成する要素の一つ）を支える下地鉄骨。構造モードで`role:'landing'`（記号`LG`）の梁として踊り場の壁側1辺（直進部レーンと反対側）に自動生成され、梁天端レベル（`levelOffset`。FL基準・上が正）を編集できる。設計意図は`.claude/structural-model.md`「踊り場受け梁」節・`.claude/elevation-model.md`「階をまたぐ2層帯」節参照。

## ドレーキップ窓・常時開放式防火戸/防火折戸・オーバーヘッドドア・非常用進入口・ガラリ
**ドレーキップ窓**＝すべり出し（開き）と内倒しを兼ねる窓（`DREH_KIPP`）。**常時開放式防火戸/防火折戸**＝平常時は開放したまま火災時に自動閉鎖する防火設備（`FIRE_DOOR`/`FIRE_FOLD`。枚数・開放角度はcatalogエントリの`fireLeaves`/`fireAngle`で持つ）。**オーバーヘッドドア**＝天井方向へ跳ね上げる大型建具（`OVERHEAD`）。**非常用進入口**＝消防隊が外部から進入するための開口（`EMERGENCY`）。**ガラリ**＝通気用のルーバー開口（`GARARI`、固定のみ）。いずれも`openingCatalog.js`のFITTING_CATALOG/WINDOW_CATALOGエントリで、機構(`OpeningMechanism`)ごとに平面記号（`renderer/OpeningsLayer.jsx`）・姿図（`openings/openingElevationFigure.js`）を描く。設計意図は`.claude/opening-model.md`。



## 壁ビュー（POJOスナップショット）
**壁ビュー**＝`materialRange`/`coord1,2`/`backingRange`/`faceDir`など壁のcomputedを1回だけ読んで
コピーしたPOJO（`finish/columnWrap.js`・`renderer/wallJunctionResolve.js`）。柱×壁・壁×壁の
総当たりループからMobXの読み出しを取り除くための手口で、`finish/gridCells.js`の分割格子
スナップショットと同じ考え方。公開関数の引数・返り値は変えず、入口でビューを組むだけ。

## 合併境界（平面の壁取り合い）
軸平行な矩形集合の合併領域の輪郭。ある矩形の辺のうち「外向き側を他の矩形が覆っていない部分」だけが残り、
同一直線で接する辺は1本に畳まれる（`renderer/orthoRegion.js` `unionBoundary`。座標は1/1000mm整数）。
平面の壁仕上げ材の線は、線をトリムして作るのではなく、この境界として得る。設計意図は`.claude/plan-wall-region.md`。

## 層（material / backing）
平面切断面の材を表す2つの矩形集合（`renderer/planWallRegion.js`）。**material**＝実際に材が在る範囲
（下地∪仕上げ。対称壁は下地の遠位面まで広げる）、**backing**＝下地帯。`material`の合併境界が面線・妻線、
`backing`の合併境界のうち`material`の内部にある部分が内側線・木口線。腰壁・垂れ壁（天板の輪郭で描く壁）は
切断面に材を持たないので層に入らない。

## 帯シフト（bandOffset）
在来木造で階の柱寸Wが基準120より細いとき、外壁の外面を通り芯±60に固定するために外壁（と外周辺由来の
室生成壁）の下地帯を外側へ寄せる量（`Wall.bandOffset`。(120−W)/2）。`backingOffset`の内訳のうち偏芯壁の
本来の偏芯とは別の成分で、梁芯CL・柱アンカーはこの量を差し引いて通り芯基準を保つ。外壁上の柱の偏心は
この量を壁から受け取る。設計意図は`.claude/structural-model.md`「外壁の面は通り芯±60に固定する」。

## 断面線（FloorProfile）
展開図で「その面の**下側の輪郭**」を表す折れ線（`[[localX, absZ]]`。`elevation/elevationFloorProfile.js`）。
帯の床と、その切断が縦断する階段寄与のmaxで、階段室では2FL断面→階段断面→踊り場断面→壁断面と続く
閉じた輪郭になる。**この線の外（下）は描かない**。天井側の`ceilingProfile`と規約を揃えた双子で、
垂直な段差は同じxを2点・範囲外は端点値を保持する。設計意図は`.claude/elevation-model.md`。

## 探査窓（layerRunWindows）
多層帯で「その層を探査してよい走り方向の世界範囲」（`elevation/section/sectionContent.js`が作り、
`sectionProbe.js`が読む）。**面の端は層ごとに違う**（自階の面は自階の壁で終わるが、同じ通りの
上階の壁はその先へ続きうる）ことを表す。自階の窓は従来の探査範囲そのままで、上階の窓だけが
「平面が続いている量」だけ広い。体裁のはり出し（壁のない端部の`probeExtendLo/HiMm`）とは別物で、
そちらは`cutDrawRange`＝面の外に断面を描かないための枠の情報源のまま。

## 梁 / 受梁 / 床梁 / 頭つなぎ / 火打ち梁（在来木造）
**梁**＝2点間で荷重を支える横架材（梁天端FL−100・材幅は柱同寸）。**受梁**＝当該階の柱の下階に柱のない梁（受梁を受ける梁は受梁同寸）。**床梁**（記号FB）＝上下階とも壁・柱は無いが根太を受けるため柱間・梁間に1820を超えない位置に設ける梁。**頭つなぎ**＝上階に壁は無いが下階の壁上にある横架材（材の性格は梁同等）。**火打ち梁**＝梁の交差する隅角部（四隅）に斜めに架け床の水平剛性を保つ材（16㎡以下の四角の4隅。吹抜けは可、EV・階段内は不可）。値は`structural/structureRules.js`の`TRADITIONAL_WOOD_FRAMING`、適用は`woodFraming.js`。**ステップ3h（頭つなぎ・受梁の自動生成）**では、壁交点から外れた柱（下階柱＝頭つなぎ、自階柱＝受梁）の直上・直下に両端支持の梁を`beamType`付きで新規生成する——用語自体は上記のまま、判定対象が「既存梁の内部荷重点からの導出（3c-3）」と「柱位置からの新規生成（3h）」の2系統になる。

## ルールセット（structureRules）
主構造（6種）と壁下地材分類（木質/RC/その他）ごとに「値」と「処理の選択子」を1か所で持つ表
（`structural/structureRules.js`の`rulesFor`/`backingRulesFor`）。主構造で分岐する処理はここから引き、
主構造の文字列を各所で直接比較しない。設計意図は`.claude/structural-model.md`。

## 三方枠 / 見付 / 出幅（チリ）
三方枠は建具（開口）の枠のみ・扉を持たないもの（記号WF木製/SF鉄製/SSFステンレス製）。**見付**は
枠材を正面から見た幅（壁長さ方向の寸法）、**出幅（チリ）**は壁の仕上げ面から室内外へ枠が
出る量。ともに`Opening.frameFaceWidth`/`frameProjection`（既定20mm/12mm）でユーザーが修正できる。
設計意図は`.claude/opening-model.md`「三方枠は建具サブタイプ＋FRAME_ONLY機構」節。

## 鮮度キー（wallFreshnessKey）
壁の入力（外壁下地・内壁下地の材コード×2・実効主構造・在来木造の柱断面・部屋ごとの**id**・kind/feature/
壁材/壁仕上げ。部屋を作り直すとidが変わり鍵も変わる）を要約した決定的な文字列
（`finish/wallFreshnessKey.js`）。`graph.wallFreshnessKey`へ保存し、「保存キー≠現在キー」を
内周壁・外壁の全削除→導出再生成の起動条件にする（仕上げ脱出・構造脱出・文書読込みの3境界。
`wallRefresh.js`の`refreshWallsAllFloors`）——ただし3境界のうち**仕上げ脱出の自階は無条件**
（鍵を見ずに毎回再生成し、鍵は結果として書く）。数値(mm)は含めない（材コードだけで組み立て、
丸め規約を持たない）。材マスタや生成規則を変えたら`WALL_KEY_VERSION`を上げて既存キーを一律
不一致にする。設計意図は`.claude/data-model.md`「内周壁は鮮度キーが変わった境界で全削除・
導出再生成する」節。

## 非正角材の標記（伏図）
成≠幅の梁（在来木造の伏図のみ）に付ける記号。梁線の端から梁幅の2倍内側へ45度線2本、梁幅の2.5倍
離れた位置に平行線1本を引き、中点に「幅×成」の文字を置く（`structural/framingDrawing.js`の
`beamDepthMarks`）。離れ・トリムは梁幅にのみ依存し梁成によらない。標記は寸法線に見立て、文字サイズ・
ギャップ・線幅は`renderer/dimensionStyle.js`（`NUM_FONT_PX`/`TEXT_GAP_PX`/`DIMENSION_LINE_WEIGHT`）を
寸法線と共有する（`renderer/StructuralLayer.jsx`）。設計意図は`.claude/structural-model.md`。

## 土台 / ネコ土台
**土台**＝1階の壁下・基礎上に必ず設ける、柱同寸の横材（`role:'sill'`、記号`SL`。天端は1FL−100で梁天端と
同じ値を共有）。`structural/woodAutoFill.js`の`autoFillWoodSillBeams`が壁線と基礎梁のスパンの和集合へ
自動生成する。**ネコ土台**＝基礎天端の上に敷く厚み20mmの気密パッキン材（`TRADITIONAL_WOOD_FRAMING.
sillPackingThicknessMm`）。基礎天端＝土台下端−この値という関係だけを定数として持ち、消費先（基礎の
断面図）は未実装（意図的な未消費。基礎梁の`levelOffset`はまだ書かない）。設計意図は
`.claude/structural-model.md`「土台」節。

## 袋綴じ（伏図の帯の閉じ方）
最下階の伏図で、柱記号を持たない（`displayedColumns`が空の）ため梁・土台の帯が全長のまま描かれ、
直交する部材と交わる位置で自然に重なって閉じる描き方。土台（`role:'sill'`）は専用の帯描画を持たず、
他の梁と同じ一般の帯描画（`bandLines`）でこの見え方になる。端を閉じる専用のキャップ線は描かない
——他の部材と交わらない自由端は開いたままになる。設計意図は`.claude/structural-model.md`。

## 柱寸アップ（B-1）
在来木造の柱カードで、個別指定の柱寸として「階の柱寸（各階柱寸法欄）より大きい」値を選べるように
するcheckboxの通称。既定は階の値以下に制限（`columnWidthScope.js`の`allowedColumnWidths`）——
チェック時だけ全カタログ幅を選択肢に出す。既に階の値より大きい柱寸を個別指定済みの柱は
チェックを外せない（`isUpsizedWidth`で判定・disabled固定）。設計意図は`.claude/structural-model.md`
「在来木造の個別柱は壁の中で偏心する」節。

## 通し勝ち（梁の交点処理・B-3）
在来木造の伏図で梁が交わる箇所の描画専用トリム規律：通しの梁（両側に続く梁）が勝ち、T字で
突き当たる梁は負けて勝者の面で止まる。出隅（L字）は長い方が勝ち、同長ならX方向。実体スパン
（`spanForColumns`）は書き換えず、`structural/beamJunction.js`の`resolveBeamJunctionSpans`が
解決した結果を`renderer/StructuralLayer.jsx`が描画時だけ上書きする。設計意図は
`.claude/structural-model.md`「在来木造の梁は交点で『通しが勝つ』」節。

## 偏心（柱）（B-1）
在来木造の個別柱（柱寸が階の柱寸と異なる柱）が、壁の中で外面をそろえるために柱芯からずれる量
（`StructuralColumn.eccentricity`）。真実は向きの指定`WoodColumn.woodOffsetSide`
（`{x?,y?}`。キー欠落＝自動判定）で、偏心量自体は`structural/woodColumnOffset.js`の
`woodColumnEccentricity`が壁位置・柱寸・階の柱寸から毎回導出する派生値（書き手は
`woodAutoFill.js`の`conformWoodColumnEccentricity`のみ）。共通柱（柱寸＝階の値）は常に偏心ゼロ。
設計意図は`.claude/structural-model.md`「在来木造の個別柱は壁の中で偏心する」節。
