# 用語集

## CL（CenterLine）
座標の源泉となる基準線。`X`(垂直)/`Y`(水平)/`R`(放射)。`value`=確定座標、`pendingDelta`=ドラッグ中の未確定変位、`effectiveValue`=両者の合計（描画・スナップは常にこれを参照）。

## 通り芯 / 中心 / 補助線（AddCLDialogの種別）
| 種別 | discipline | labeled | 意味 |
|---|---|---|---|
| 通り芯 | `struct` | `true` | グリッド軸。ガターラベル・交点自動生成の対象 |
| 中心 | `arch` | `false` | ラベルなし中心線（フロア固有） |
| 補助線 | `arch` | `false` | ラベルなし破線（フロア固有） |

ガターラベル・ガター丸の表示対象は「`discipline==='struct'` かつ `labeled===true`」のみ。

## discipline（分野）
`arch`(意匠・既定) / `struct`(構造) / `fuse`(伏図) / `mep`(設備) / `elec`(電気)。

## Plane / 採用・検討
1フロア分のデータ単位。`isAlternative=false`が採用（実案）、`true`が検討（代替案、親採用を`referenceId`で参照）。

## 屋根専用平面（isRoofPlane）
構造モードのみに存在する合成Plane。`project.planes`/`orderedTabs`から除外、`project.roofPlane`で個別アクセス。
ぞー
## kind / feature（Roomの2軸区分）
`kind`＝屋内/屋外（内外判定はこちらのみ参照）。`feature`＝階段/吹抜け/なし（属性）。旧enumの`void`は読込時に「屋内+吹抜け」へ移行される。設計意図は`.claude/data-model.md`。

## 部分指定 / 参照元
**部分指定**＝既存部屋の一部セルに別名を与えるRoom（`referenceRoomIds`で参照元＝親を指す。外周壁は親が担う）。**参照元**＝`referenceRoomIds`が空のRoom。親の削除は部分指定を道連れにする。

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
構造部材の採番。`記号+(荷重バンド+1)`で決定的に与える（band0=最下層→C1。登録順・階数に非依存）。`memberNoLocked=true`の手動編集タグは自動採番で上書きしない。`project.structuralTagRegistry`は「同一形状＝同一タグ」の記録チャネル。

## 図面合成 / FigureDef / レイヤ / バインディング
1枚の図面を「複数階×複数カテゴリの合成」として持つ仕組み（`.claude/figure.md`）。`FigureDef`＝レイヤ仕様の宣言的リスト。レイヤ＝`(供給階, カテゴリ, スタイル, 役割)`。バインディング＝レイヤが解決された自己完結グラフ（階固有CL＋通り芯参照を内包）。`composition.graphForCategory(mapName)` が描画・編集の対象グラフを一元的に返す。構造伏図は出演階＝`{自階, 自階−1}` の特殊例。

## lodLevel（LOD）
`SCHEMATIC`/`STANDARD`/`DETAIL`の3段階描画詳細度。壁・開口・構造部材（柱梁耐力壁スラブ）が共通の意味で参照する。

## bake
ドラッグ確定時に`pendingDelta`を`value`へ書き込み0に戻す操作（`bakeCLValue`）。

## 実段数 / 踏面 / 直進部 / 踊り場 / 周回部（階段）
**実段数**＝蹴上げを持つ物理的な段の数。**踏面**＝四角形を線分で分割してできる領域の数（実段数−1）。**直進部**＝実段差が2以上ある走行区間（階段設置階から数えて直進部1,2,…）。**周回部**＝平場に1以上の実段差を設けI/L/U字で他区間と接続する部分。**踊り場**＝周回部のうち実段差1のものの別称。設計意図は`.claude/stair-model.md`。


