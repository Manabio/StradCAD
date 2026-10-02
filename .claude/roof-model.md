# 屋根（下屋）の仕様 — RoofSpec

屋根の壁・境界・他階との整合（feature=ROOF を「部屋の無いセル」と同値に扱う）は `.claude/data-model.md` の屋根の節。ここは屋根の**項目（RoofSpec）**の設計意図だけを書く。

## 2軸の持ち方
- 屋根の部屋は「屋外部屋（kind=EXTERIOR）＋属性ROOF」。**項目（形状・勾配・野地板・防水シート・屋根仕上げ・軒の出・妻側の出・軒裏・備考）は `Room.roofSpec`（`core/roofSpec.js`の`RoofSpec`）の1か所だけ**が保存先。
- `exteriorRows` の連動行は作らない（二重持ちを避ける。外部タブは専用の群 `type:'roof'` に `RoofGroup.jsx` を描く）。
- 別実体（Stairのような `Roof` ＋ roomId）にしない: 屋根は外壁生成から消えたい側で、別実体にする理由（Room を消すと外壁生成から消える）が当てはまらない。Room に載せれば部屋削除・階の複製・検討案のコピーで値が自動で道連れになる。

## 不変条件 I1: feature===ROOF ⇔ roofSpec≠null
- 付与で作る（`FinishModeState.applyNaming`が`createLeanToRoofSpec`）、ROOFでなくなれば`Room.setFeature`が捨てる。
- 復元側の入口は`restoreRoofSpecInto`（`finish/roof/roofDefaults.js`）1つ。`graphSnapshot.restoreGraph`（FBS・JSON・plainの3経路の合流先）と`roomReinterpret.restoreRoomsState`（仕上げモードundo）が共用する。欠けていれば既定値（備考「下野」）で補い、ROOFでないのに付いていれば捨てる。
- **項目集合の唯一の定義は `ROOF_SPEC_KEYS` と `toData()`/`fromData()`**。FBSの読み書き・graphSnapshot・roomReinterpretはどれもこの plain 表現を通す。項目を足すときの追従先は、FBSの`RS`テーブル（末尾追加）・`finishUndo.test.js`／`roofSpec.test.js`のキー集合の突合。

## 形状だけ「自動」を持つ
- `shape: null`＝自動。表示時に`resolveRoofShape`が導く（短手が`ROOF_MONO_MAX_SHORT_SPAN_MM`以下なら片流れ、超えれば切妻）。選ぶと保存され、「自動へ戻す」入口は作らない。他の項目は付与時に既定値を保存する。理由: 材料コードは保存されていないと使用コードの収集（同梱）・読込み時の照合に乗らない。
- 短手＝屋根範囲に内接する全矩形の短辺の最大（`roofShortSpanMm`）。セルの分割の取り方に依存しない。
- 陸屋根は下屋でも選べる（既定になるのは非木造の主屋根だけ＝主屋根は未実装。`resolveRoofShape`の`rules.mainRoofDefaultShape`が引数口）。構造種別を直接比べず`rulesFor`経由にすること。

## 材料コードの照合
- 野地板・防水シートのコードは`codeNormalization.js`の材料walker（`ROOF_SPEC_MATERIAL_FIELDS`）で列挙・読み替えされ、使用コードの収集（同梱）と未解決コードの検出に乗る。`FinishModeState._collectReferencedCodes`も同じ2項目を見る。walkerは零依存の葉モジュールのため項目名を直書きしており、`ROOF_SPEC_KEYS`との一致は`codeNormalization.test.js`が固定する。
- 選択肢は`ROOF_SHEATHING_CODES`／`ROOF_UNDERLAYMENT_CODES`（コード表）＋材データの名前。保存コードが候補に無い・解決できないときは先頭へ補って値を失わない（`shaftWallMaterialOptions`と同じ流儀）。

## 入力の確定
- 1回の確定＝undo 1エントリ（`FinishModeState.setRoofField`が`withFinishUndo`）。入力の検証は`roofInput.js`の純関数（勾配は0.5刻みの正の数・出幅は0以上）。文字・数値欄は draft で持ち、blur/Enterで確定し、不正な数値は確定せず元の値へ戻す。
- 軒の出・妻側の出・屋根仕上げ・軒裏は値の保持だけ（平面・展開図には描かない）。棟・流れの向きの項目は未追加（屋根を描画する段階で足す）。

## 既知の限界
- 形状が自動のとき、導かれた形状と同じ値を選んでも `onChange` が発火しないため、導いた形状を「そのまま固定」するには別の形状を一度選ぶ必要がある。
- 主屋根（`PlanGraph.mainRoofSpec`・最上階の群）は未実装。
