# 屋根（下屋・主屋根）の仕様 — RoofSpec

屋根の壁・境界・他階との整合（feature=ROOF を「部屋の無いセル」と同値に扱う）は `.claude/data-model.md` の屋根の節。ここは屋根の**項目（RoofSpec）**の設計意図だけを書く。

## 2軸の持ち方
- 屋根の部屋は「屋外部屋（kind=EXTERIOR）＋属性ROOF」。**項目（形状・勾配・野地板・防水シート・屋根仕上げ・軒の出・妻側の出・軒裏・備考・片流れの高い側）は `Room.roofSpec`（`core/roofSpec.js`の`RoofSpec`）の1か所だけ**が保存先。
- `exteriorRows` の連動行は作らない（二重持ちを避ける。外部タブは専用の群 `type:'roof'` に `RoofGroup.jsx` を描く）。
- 別実体（Stairのような `Roof` ＋ roomId）にしない: 屋根は外壁生成から消えたい側で、別実体にする理由（Room を消すと外壁生成から消える）が当てはまらない。Room に載せれば部屋削除・階の複製・検討案のコピーで値が自動で道連れになる。

## 不変条件 I1: feature===ROOF ⇔ roofSpec≠null
- 付与で作る（`FinishModeState.applyNaming`が`createLeanToRoofSpec`）、ROOFでなくなれば`Room.setFeature`が捨てる。
- 復元側の入口は`restoreRoofSpecInto`（`finish/roof/roofDefaults.js`）1つ。`graphSnapshot.restoreGraph`（FBS・JSON・plainの3経路の合流先）と`roomReinterpret.restoreRoomsState`（仕上げモードundo）が共用する。欠けていれば既定値（備考「下野」）で補い、ROOFでないのに付いていれば捨てる。
- **項目集合の唯一の定義は `ROOF_SPEC_KEYS` と `toData()`/`fromData()`**。FBSの読み書き・graphSnapshot・roomReinterpretはどれもこの plain 表現を通す。項目を足すときの追従先は、FBSの`RS`テーブル（末尾追加）・`finishUndo.test.js`／`roofSpec.test.js`のキー集合の突合。

## 形状と高い側だけ「自動」を持つ
- `shape: null`＝自動。表示時に`resolveRoofShape`が導く（短手が`ROOF_MONO_MAX_SHORT_SPAN_MM`以下なら片流れ、超えれば切妻。矩形かどうかは見ない）。選ぶと保存され、「自動へ戻す」入口は作らない。他の項目は付与時に既定値を保存する。**主屋根だけ**、主構造のルールが既定形状を持たない（木造・未定）とき建物範囲が矩形でなければ寄棟（`mainRoof.js`の`resolveMainRoofShape`。ユーザー裁定2026-10-02「下屋は片流れ・主屋根は寄棟」）。範囲が空の階は今までどおり（短手0＝片流れ）、非木造は矩形でなくても陸屋根。下屋は矩形でなくても短手の規則のまま。理由: 材料コードは保存されていないと使用コードの収集（同梱）・読込み時の照合に乗らない。
- 短手＝屋根範囲に内接する全矩形の短辺の最大（`roofShortSpanMm`）。セルの分割の取り方に依存しない。
- 陸屋根は下屋でも選べる（既定になるのは非木造の主屋根だけ。`resolveRoofShape`の`rules.mainRoofDefaultShape`が引数口で、主屋根のときだけ渡す）。構造種別を直接比べず`rulesFor`経由にすること。

## 片流れの高い側（`RoofSpec.highSide`。null＝自動）
- 片流れの向きは「高い側」の辺（top/bottom/left/right。y軸下向きなのでtop＝yが小さい辺）で持つ。形状と同じく「自動へ戻す」入口は作らず、自動のときは導いた辺を選択状態で見せ、選ぶと保存する。切妻・寄棟の棟の向きを上書きする項目は持たない。
- 実効値の導出は`roofGeometry.js`の`resolveRoofHighSide`: 明示値 → **下屋だけ**、屋根範囲の各辺の外側が同じ階の屋内に接する長さが最大の辺（同長は top→bottom→left→right） → 屋内に接しない下屋と主屋根は長手に平行な辺の座標が小さい側（横長＝上・縦長＝左・正方形＝上）。
- 「屋内」は建物範囲と同じ定義（`footprintCellKeys`＝kindがINTERIORのセル。未定義部屋・階段・吹抜けも屋内。階段・階段吹抜けしか無い階は建物範囲が未定義なので0）。屋根セル・屋外部屋・部屋の無いセルは数えない。`roofOrientation.js`の`roofEdgeInteriorAdjacency`。
- 欄の表示判断（`roofHighSideView`）: 形状の実効値が片流れで、屋根範囲が**矩形**のときだけ出す（jsxは`visible`に従うだけ）。矩形でない片流れ（L字の下屋など）は小屋組の決め方が未定のため出さない（明示値があっても出さず、保存値は残る）。
- 保存は`RS`の末尾（`HIGH_SIDE=9`）。nullのときはフィールドを書かないので、highSideを使っていない文書のバイト列は変わらない。

## 材料コードの照合
- 野地板・防水シートのコードは`codeNormalization.js`の材料walker（`ROOF_SPEC_MATERIAL_FIELDS`）で列挙・読み替えされ、使用コードの収集（同梱）と未解決コードの検出に乗る。`FinishModeState._collectReferencedCodes`も同じ2項目を見る。walkerは零依存の葉モジュールのため項目名を直書きしており、`ROOF_SPEC_KEYS`との一致は`codeNormalization.test.js`が固定する。
- 選択肢は`ROOF_SHEATHING_CODES`／`ROOF_UNDERLAYMENT_CODES`（コード表）＋材データの名前。保存コードが候補に無い・解決できないときは先頭へ補って値を失わない（`shaftWallMaterialOptions`と同じ流儀）。

## 入力の確定
- 1回の確定＝undo 1エントリ（`FinishModeState.setRoofField`が`withFinishUndo`）。入力の検証は`roofInput.js`の純関数（勾配は0.5刻みの正の数・出幅は0以上）。文字・数値欄は draft で持ち、blur/Enterで確定し、不正な数値は確定せず元の値へ戻す。
- 軒の出・妻側の出・屋根仕上げ・軒裏は値の保持だけ（平面・展開図には描かない）。片流れの向きは`highSide`（下記）。切妻・寄棟の棟の向きの項目は未追加。

## 選択の導線
- 平面で屋根セルをクリックすると、`FinishModeState.startDrag`（優先0b。`roofRoomAtCell`）がその屋根の部屋を選択するだけでドラッグは始めない（屋根は部屋ドラッグの対象外のまま。広げるときは削除→指定し直し）。選択は屋外部屋と同じ経路で外部タブへ切り替わり、選んだ屋根の群だけを青枠で強調して可視域へ寄せる（判定は`exteriorGroups.js`の`isSelectedRoofGroup`）。
- 逆向き（外部タブの群のクリックで平面の屋根を選ぶ）は、既存の屋外部屋の群も持たないため屋根にも付けていない。

## 主屋根（最上階の屋根）
- 最上階（とその検討案）の外部タブ先頭に、セルを持たない固定の群「屋根」（`type:'mainRoof'`・削除ボタンなし・選択の枠なし）。範囲は最上階の建物範囲（`footprintCellKeys`）、入力項目・入力UI・初期値関数は下屋と同じ（`RoofGroup.jsx`の`RoofSpecFields`を共用）。備考の既定だけ空（下屋は「下野」）。
- 保存先は最上階の**graphの階ごと設定** `PlanGraph.mainRoofSpec`（常に`RoofSpec`。全階が持てるが使われるのは最上階の分だけで、他の階では休眠する）。project・屋根専用平面（R階。構造モード専用で作り直される）には置かない。最上階の判定は`core/project.js`の`isTopFloorPlane`（`project.planes`の末尾。検討案は参照元で判定）。
- **既定値のときは保存データへ何も書かない**（`GS.MAIN_ROOF_SPEC=53`を省く。`isDefaultRoofSpec`が唯一の判定）。主屋根を編集していない文書のバイト列は変わらない。材料コードの収集・照合も既定値のときは出ない。
- 形状の既定は`rulesFor(effectiveStructure).mainRoofDefaultShape`（RC・S・SRC=陸屋根、在来・2×4=null＝短手の規則）。主構造が**未定**のときは`UNSPECIFIED_RULES`が明示でnull（継承に任せると`STEEL_RULES`経由で`flat`になるため）＝木造と同じ短手の規則。導出は`finish/roof/mainRoof.js`（`wallGate.js`が storage 系を連鎖して引くので、`graphSnapshot`が引く`roofDefaults.js`には置かない＝import循環の回避）。
- 主屋根は壁・境界・構造・展開図に影響しない（値の保持と外部タブの表示だけ。壁の鮮度キーにも入れない）。
- 仕上げ undo は別キー`mainRoof`（`PER_FLOOR_SETTERS`は値そのものを入れる形でオブジェクトを相乗りさせない）。確定は`FinishModeState.setMainRoofField`（1確定＝undo 1エントリ）。
- **上に階を追加して最上階が入れ替わったときだけ**、旧最上階の値を新しい最上階へ写す（follower `mainRoofCarry`・`finish/roof/mainRoofFloorSync.js`）。階の削除・並べ替え・階変更・下への追加では写さず、新しい最上階が自分の値を使う。旧最上階の値は残し、旧最上階が既定値なら何も書かない。旧最上階の検討案の主屋根は写さない（採用フロアの値だけ）。階追加のundoは追加階ごと消えるので、旧最上階には何も書かない。

## 小屋組との関係（構造モードの伏図の描画）
- 屋根の入力（形状の実効値・範囲・高い側）は、構造モード（在来木造・矩形の片流れ/切妻/寄棟）の伏図が棟木・母屋・束を描くときの唯一の入力。棟木・母屋・束は保存せず描画時に導く（`structural/roofFramingRegions.js`が既存の形状・範囲・高い側の関数を流用）。設計意図は`.claude/structural-model.md`「小屋組（棟木・母屋・束）は保存せず…」。
- 母屋は棟木側（片流れは高い側の辺）から軒桁へ、910ピッチで、1本目を455か910にして軒桁までの残りが910に近い方でかける（柱の割付と絡むため。規則は`.claude/structural-model.md`の同節）。
- 小屋梁（母屋・棟木と直交する梁）の生成・成は主屋根と矩形の下屋（片流れ・切妻）で実装済み（下屋の小屋梁はその実体階の伏図に載る。設計意図は`.claude/structural-model.md`「下屋の小屋梁」）。寄棟・L字の下屋は未実装。
- 小屋組の対象の下屋（矩形の片流れ・切妻・寄棟）は構造モードで外周に梁（軒桁）が出て、その範囲に床梁は出ない。壁・境界・展開図が「部屋の無いセルと同値」なのは変わらず、梁だけが違う（設計意図は`.claude/structural-model.md`「下屋の外周の梁」）。

## 既知の限界
- 矩形でない屋根（L字の下屋など）が片流れのとき、「高い側」を入力できない（小屋組の決め方が未定）。自動の形状は下屋＝短手の規則・主屋根＝寄棟のまま。
- 形状が自動のとき、導かれた形状と同じ値を選んでも `onChange` が発火しないため、導いた形状を「そのまま固定」するには別の形状を一度選ぶ必要がある。高い側も同じ（自動で導いた辺を固定するには別の辺を一度選ぶ。固定するまで、高い側は隣の部屋の追加・削除に追随して変わる）。
- 高い側の「屋内に接する辺」の「屋内」は建物範囲（`footprintCellKeys`）と同じ定義で、未定義部屋・階段・吹抜け・昇降路も数える。B1b の「上の階」の警告は未定義部屋を数えないので定義が違う（どちらに合わせるかはユーザー確認待ち）。
- 主屋根の形状は最上階の建物範囲から導くだけで、構造材（梁の生成）・平面・展開図・断面には反映しない（構造種別が変わると表示の形状が追従するだけ。構造モードの伏図の小屋組の描画だけがこれを読む）。
- 「既定値は保存しない」の帰結（主屋根）: (a) 既定の野地板・防水シートのコードをユーザーが保守パネルで上書き（本体の編集）していても、主屋根が既定値のままの文書にはその材が同梱されず、別の環境では本体カタログの内容で表示される。(b) 将来、屋根の既定値の定数（`DEFAULT_ROOF_*`）を変えると、主屋根を編集していない文書は新しい既定値に変わる（保存データに値が無いため）。下屋は付与時に値を保存するのでどちらも起きない。
- 最上階が入れ替わっても、階の削除・並べ替えでは主屋根の値は動かない（旧最上階の値は旧最上階に休眠したまま）。
