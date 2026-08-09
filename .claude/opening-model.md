# 建具モードの設計意図

建具・窓の追加・編集は専用モード（`appMode==='opening'`）＋右パネルで行う。フィールド一覧・関数シグネチャはソース（`openings/*.js`）を読めば分かるため省略する。

## 建具記号はfixtureTypeの意味拡張——別フィールドを作らない
`Opening.fixtureType`は元々「窓の材質記号」（`AW`/`JW`）だったが、「建具記号（材質×種別）」へ意味を拡張して`AD`/`SD`/`WD`/`SW`を追加した。既存FBS enum値（`AW=1`/`JW=2`）は温存し追記のみで拡張している（`.claude/serialization-fbs.md`の末尾追加ルール）。新規フィールドを増やさないことで、モデル層に「建具記号」概念を二重に持たない。

## 番号は導出のみ・永続化しない——境界にundoが不要な理由
`project.openingNumberIndex`は建物状態から毎回導出される非永続キャッシュ（`memberNumberIndex`と同格）。entityへ番号を書き戻さないため、モード境界（`opening`の`enter`）はgraphを一切変更しない。`.claude/undo-redo.md`の不変条件「graphを変える境界処理は必ずundoエントリを積む」に抵触せず、FBSスロット追加・他階書き戻し・モード境界のundo問題がすべて生じない。

## countsはplaneIdキー——階削除時にindexを丸ごと捨てる不変条件
採番グループの`counts: Map<planeId, number>`は生存階のplaneIdのみを鍵に持つ。階削除でそのplaneIdの寄与が残るとゴーストグループが消えず番号が欠番のまま固定化するため、`store.js`の`removeFloor`は`clearMemberNumberIndex`と並べて`clearOpeningNumberIndex`を呼ぶ（次のモード境界の反映パスで正しく再収集される）。

## 階プレフィックスを付けない——AW-1 vs C1の書式差
構造部材の採番（`structural/memberNumbering.js`）は出現階が記号内で不揃いなら`2F-C1`のように階プレフィックスを付ける。建具はその逆で、採番は常に全階統一（`記号-連番(-枝番)`のみ）——同じ`AW-1`はどの階にあっても同一仕様を指す（建具表の慣習）。手動タグ台帳（構造の`memberGroupLedger`相当）も持たない。同一仕様（`openingSignature`）の判定は階と無関係。

## 枝番（サッシ図の慣習に合わせた建具表バリアント区別）
基本番号（`AW-1`等）は記号|種別|幅|高さ|窓台高さ（`openingBaseSignature`）だけで決まり、幅降順→高さ降順→窓台高さ昇順→base signature辞書順でソートする（枝番導入前と同じ規則）。同一baseの中に建具表バリアント（仕上|材料・ガラス|見込み|金物|備考＝`openingSubSignature`）が複数あるときだけ、sub signature辞書順で`a`,`b`,…（26件超は`aa`,`ab`,…スプレッドシート列名式）の枝番を付ける——**無印と枝番の混在はしない**（1種類→2種類に増えた瞬間、既存の無印タグも枝番付きへ動く。逆に2種類→1種類に合流すれば枝番は消える）。
`project.openingNumberIndex`は枝番導入後もフラットな`Map<signature, group>`のまま（signature = base+sub結合キー）——base→variantsの入れ子Mapへ構造変更していない。ネスト構造にすると差し替え・ゴースト掃除（下記「countsはplaneIdキー」の隣接コメント）の再発防止パターンを2重に持つことになるため、`assignOpeningNumbers`が採番の瞬間だけ`symbol→baseSignature→variants`の一時マップを組み立てる方式にした。各グループが自身の`baseSignature`を保持し、`no`（base番号）と`branch`（枝番文字|null）を`tag`と一緒に書き戻す。

## 建具表バリアント（Finding 3 = 採番signature範囲）は確定仕様
枝番導入前は「採番signatureに建具表項目を含めるか」が保留事項だったが、上記の枝番方式で確定した——含める（`openingSignature`はbase+subの結合）。

## height<=0（null/0/負値）は不正値としてカタログ既定にフォールバックする
`Opening.height`は物理的に0mm以下があり得ない（窓台高さ`sillHeight`と違い、0mmが正当な値になるケースが無い）。FBS（`graphFbs.js` OP.HEIGHT）は「0=未設定」を既存の規約として持つため、この規約を負値にも広げてモデル層全体に一本化する——`openings/openingNumbering.js`の`effectiveHeight`は`h>0`を明示チェックし、UIを経由しない経路（復元データ・直接代入）からの負値混入でも姿図（rectの高さ）が壊れないよう防御する。入力側（`OpeningEditor.jsx`の幅・高さ・位置・図上dim編集）は数値入力を絶対値化して確定する。窓台高さ0mm=掃き出し窓とは異なりheightの0/負値は常に無効。`frameDepth`（見込み）も同じ理由・同じ規約（0=不正値=null）で扱う。

## 建具表項目: 導出の「取付箇所」 vs 永続の5フィールド
建具表の項目のうち「取付箇所」（隣接部屋名）だけは**永続化しない導出値**——`openings/openingRoomLabel.js`の`openingMountLocation`が呼び出し時点のgraphトポロジー（`findHostWall`で得たホスト壁＋`finish/edgeClassify.js`の`buildCellToRoom`/`worldToCell`）から毎回計算する。部屋名や間取りが変わればOpening側は無編集のまま表示だけ追随する（採番の`project.openingNumberIndex`と同じ「導出は保存しない」思想）。隣接部屋の判定ロジックは`edgeGeometry`（境界エッジのサンプリング方式：軸直交方向へ±10mmの点をセル化→`cellToRoom`で引く）を踏襲し、新しい判定方式を作らない。
一方`finish`/`materialGlass`/`frameDepth`/`hardware`/`note`はユーザー入力の**永続フィールド**（`Opening`本体・FBS末尾追加）。導出値と永続値を混在させないのは、モード境界のundo・全階反映の設計（上記「番号は導出のみ」節）と同じ理由——導出値をentityに書き戻すと、境界処理にgraph変更が紛れ込みundoエントリが必要になってしまう。

## 記号丸の配置と採番の鮮度
建具記号丸（円に直径横線・上段記号／下段採番）の配置計算は`openings/openingTagPlacement.js`が純関数で担い、`renderer/OpeningTagLayer.jsx`はviewport由来のpx→mm換算とKonva描画・クリック配線のみを行う。窓は壁面から室内側へオフセット、開き戸は動作扇形の重心に置く。反転（円弧同士が重なる場合の壁軸鏡映）は位置だけでなく退避方向（u/v基底）も一緒に鏡映する——位置だけ鏡映すると退避方向が元の（壁・扉側へ戻る）向きのままになるため。重なる場合は決定的な順序で退避先を探し、見つからなければ元の位置を返す（配置失敗を握りつぶさない）。障害物は壁の材範囲と開き戸自身の動作扇形のみ——部屋名・寸法・構造部材は対象外（今後の検討課題）。
`project.openingNumberIndex`（採番キャッシュ）は建物状態から導出するため、平面モードでは`App.jsx`が`graph.openings`の署名（`openingSignature`の結合文字列）を`reaction`で監視し、変化のたびに`renumberOpenings`で自階の採番を再計算する——`autorun`ではなくreaction+`runInAction`にしているのは、effect内でindexを変異するとautorunは自己再入してしまうため。建具モード中はこの監視を止める（モード境界の全階収集と競合させない）。

## swingSideの既定値は配置時に決めて保存する——導出ではない
`hingeSide`/`swingSide`（開き戸の蝶番・開く向き）は他の建具表項目と違い、配置後にホスト壁から毎回導出はしない（`findHostWall`が返す壁は仕上げモード往復で作り直されるため、蝶番位置基準の向きを導出し続けると再現性が崩れる）。壁の長押しメニューから配置する瞬間だけ、`placeOpeningWithDefaults`が`swingSide`を決めて`Opening`に固定保存する。開き方向は押下点(`worldPos`)の符号ではなく**ヒットした壁自身が面する向き（`wallFaceDir`）**で決める——壁ラジアルのヒット域には材側へのわずかな許容があり（下記）、その範囲では押下点の直交成分の符号が面の向きと逆になり得るため、押下点の符号に依存すると材側許容域を押したときに逆に開いてしまう。ただし外壁境界は例外——常に室外側へ開く（外壁の開き戸は屋内から押し出す動作が一般的なため）。境界の判定は壁単体の`isExteriorWall`だけでは不十分——1つの境界にWallは2枚あり（下記参照）、壁ラジアルのヒット域限定により実運用では室内向き壁（`isExteriorWall:false`）がホストになるのが主要経路のため、`exteriorSideDir`が境界の反対側の壁（`findCounterpartWall`）まで見て「外壁境界か」を判定する。反対側の壁は**実際に開口が置かれる位置**（`worldPos`でなく`centerCoord`）で特定する——1本の境界の背後が途中まで屋外・途中から隣室（segmented）の平面では、押下位置と無関係な区間の壁を「反対側」と誤認しうるため。種別変更でSWING機構になっても、配置時に保存したこの値がそのまま使われる。

## 壁ラジアルメニューのヒット域は「壁線とその近傍」——壁線そのものを含む
壁の長押しメニュー（建具・窓の配置、腰壁・垂れ壁、カーソルpointer表示——`snap.js`の`findNearestWall`を単一のヒット判定として共有するため用途によって挙動を分けない）は、壁の仕上げ面線（`axisValue`）近傍だけに反応する（`isWallRadialHit`）。壁線には描画上の太さがあるため、部屋側だけでなく材側（軸CL方向）にもわずかな許容を持つ——ただし壁の真ん中（通り芯＝軸CL位置）には決して届かないよう、材側許容は「面線〜軸CLの距離」でクランプする（薄壁でこの距離が許容値より小さい場合は届く直前で止まる）。壁の真ん中は通り芯側の長押しメニューに譲る。1つの境界にWallは2枚ある（部屋間の間仕切り＝両室がそれぞれ自室側に1枚ずつ／建物外周＝室内向き壁＋外向きの外壁）ため、境界にまたがる判定（外壁境界か等）は壁単体でなく`findCounterpartWall`で反対側の壁を見て行う——このとき単純にspanが重なる最初の1本を拾うと、境界が長さ方向で区間分けされた（segmented）平面ではWall登録順しだいで誤った相手を拾うため、押下位置（`along`）を自スパンに含む候補だけに絞る。

## 材料・ガラスの記号別初期値は「新規配置時に設定・記号変更時は未編集なら差し替え」
`openingCatalog.js`の`DEFAULT_MATERIALS`（記号→初期値。AW/AD=アルミ、WD=ポリ合板フラッシュ戸+木製枠、WW=木製、JW=樹脂、SW/SD=スチール）が唯一のマスタ。`placeOpeningWithDefaults`が新規配置時に`materialGlass`へ設定する。エディタで記号（fixtureType）を変更したとき、`openingEdit.js`の`materialGlassAfterFixtureChange`は**現在値が旧記号の初期値と完全一致する場合のみ**新記号の初期値へ差し替える——文字列比較なので、ユーザーが少しでも手を入れた値（初期値と異なる文字列）は記号を変えても上書きされない。
