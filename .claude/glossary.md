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
**部分指定**＝既存部屋の一部セルに別名を与えるRoom（`referenceRoomIds`で参照元＝親を指す。外周壁は親が担う）。**参照元**＝`referenceRoomIds`が空のRoom。親の削除は部分指定を道連れにする。

## 段差見付け面（展開図）
部屋**内部**（壁の無い境界）でFLの異なる区間がある箇所に、段差の見えがかり（見付け）を専用の面として展開図に挿入したもの
（`elevation/elevationStepFace.js`。壁際の段差は`wallAdjacentFloorSegments`の床線プロファイルで別途表現する）。設計意図は
`.claude/elevation-model.md`「面リストの合成」節。

## 袖壁（展開図）
面に直交し、面の仕上げ面へ到達して室内側へ一定量以上突き出し室内で終端する壁（外壁・自室外周生成壁・同軸壁は除く）。
展開図では面をその位置で分割し、壁のない端部（`hasWallAtLocal0/Run=false`）として扱う（`elevation/elevationFaces.js`の
`perpendicularWallsOnFace`。設計意図は`.claude/elevation-model.md`）。腰壁は同条件で`kneeDropWalls`にknee指定を持つもの。

## 開放スパン（展開図）
壁の無い部屋内部の境界を挟んで、同じ部屋の壁面（面）が「壁のある区間」から先へ連続して延長される区間
（`elevation/elevationOpenSpan.js`のspans。`kind:'wall'|'open'`。openはその先に別の実効FLを持つセルが続き、そちらの床が
見えがかりとして見えることを示す）。段差見付け面と異なり「面自体」を延長する仕組み。`composeRoomFaces`に配線済み。
設計意図は`.claude/elevation-model.md`「開放スパン」節。

## Edge（境界エッジ） / boundaryMaster
仕上げモードの部屋境界。`boundaryMaster`はその層構成（壁の材構成）の既定値セット。

## interiorMaster（内装マスター）
部屋種別ごとの壁材・壁仕上げ・天井高さの既定値セット。`Room.templateKey`で参照、`customOverrides`で個別上書き。

## 柱芯（ColumnAxis）／偏芯量
**柱芯**＝柱の中心。**偏芯量**＝通り芯と柱芯の距離。ラーメン系構造（S造/SRC造/RC造(ラーメン)）でのみ非0になり、`columnAxisOffsets: Map<clId, number>`（per-floor）に通り芯からの偏芯量だけを持つ。設計意図は`.claude/structural-model.md`。

## 出幅（columnFaceProjection）
**出幅**＝通り芯から柱外面までの距離。柱芯・偏芯量の真実値で、**1構造×1通り芯**（`structuralInfo.columnFaceProjections`）で持つ。図のX/Y出幅寸法、または描画エリアの○「柱芯」ラベルのロングタップで編集する。設計意図は`.claude/structural-model.md`。

## role（構造部材のrole）
柱=`standard`/`foundation`、梁=`primary`/`secondary`/`foundation`/`eaves`/`roof`。伏図の慣習（基礎伏図に柱なし等）に対応する。

## memberNo（部材番号・タグ）
構造部材の採番結果のキャッシュ（`記号+順位`。導出結果を実体へ書き戻したもので、真実は毎回の採番）。設計意図は`.claude/structural-model.md`。

## 材寸署名（signature） / numberGroupId / 部材グループ台帳（memberGroupLedger）
**材寸署名**＝部材の材料・断面・配筋等から導出する採番グループの既定キー（`memberCatalog.memberSignature`）。**numberGroupId**＝分割・統合・手動採番でのみ設定される明示グループID（null＝署名から自動導出）。**部材グループ台帳**（`project.memberGroupLedger`）＝上記の明示操作だけを持つ建物全体・永続の台帳（`grp.spec`/`grp.join`/`grp.no`/`grp.mergedInto`）。設計意図は`.claude/structural-model.md`。

## 図面合成 / FigureDef / レイヤ / バインディング
1枚の図面を「複数階×複数カテゴリの合成」として持つ仕組み（`.claude/figure.md`）。`FigureDef`＝レイヤ仕様の宣言的リスト。レイヤ＝`(供給階, カテゴリ, スタイル, 役割)`。バインディング＝レイヤが解決された自己完結グラフ（階固有CL＋通り芯参照を内包）。`composition.graphForCategory(mapName)` が描画・編集の対象グラフを一元的に返す。構造伏図は出演階＝`{自階, 自階−1}` の特殊例。

## lodLevel（LOD）
`SCHEMATIC`/`STANDARD`/`DETAIL`の3段階描画詳細度。壁・開口・構造部材（柱梁耐力壁スラブ）が共通の意味で参照する。

## 端点（CL端点ルール）
線分編集の結果、直交CLとの交点を失った中心線の端。座標がその場に固定され、延長・短縮の対象外。壁は端点ノードに壁があったと想定した分（下地偏芯量＋仕上げ厚）だけはね出して止まる。設計意図は`.claude/data-model.md`。

## bake
ドラッグ確定時に`pendingDelta`を`value`へ書き込み0に戻す操作（`bakeCLValue`）。

## 文書ファイル（.stq）
「保存」でダウンロードされる文書全体（全階・plane一覧・通り芯/構造情報/採番台帳・敷地）のファイル。拡張子は`.stq`（既存3文字拡張子との衝突が実質ない未使用域から選定）。保存ドキュメント（savedFloors/projects）の確定内容をIDBから読み戻してbase64で包んだJSONエンベロープ（`format:'stq-document'`、`storage/documentFile.js`）。「開く」で全ストア置換→reloadで完全復元する。旧形式（単一グラフFlatBuffers・旧JSONスナップショット）はアクティブ階のみ復元。設計意図は`.claude/persistence-idb.md`。

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
`B1`/`B2`のように連番が付く。設計意図は`.claude/elevation-model.md`。

## ドレーキップ窓・常時開放式防火戸/防火折戸・オーバーヘッドドア・非常用進入口・ガラリ
**ドレーキップ窓**＝すべり出し（開き）と内倒しを兼ねる窓（`DREH_KIPP`）。**常時開放式防火戸/防火折戸**＝平常時は開放したまま火災時に自動閉鎖する防火設備（`FIRE_DOOR`/`FIRE_FOLD`。枚数・開放角度はcatalogエントリの`fireLeaves`/`fireAngle`で持つ）。**オーバーヘッドドア**＝天井方向へ跳ね上げる大型建具（`OVERHEAD`）。**非常用進入口**＝消防隊が外部から進入するための開口（`EMERGENCY`）。**ガラリ**＝通気用のルーバー開口（`GARARI`、固定のみ）。いずれも`openingCatalog.js`のFITTING_CATALOG/WINDOW_CATALOGエントリで、機構(`OpeningMechanism`)ごとに平面記号（`renderer/OpeningsLayer.jsx`）・姿図（`openings/openingElevationFigure.js`）を描く。設計意図は`.claude/opening-model.md`。


