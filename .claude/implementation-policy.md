# 実装方針（全体ルール）

このプロジェクトで必ず遵守する9つの方針。

1. **データ入替えはFlatBuffersのみ**（JSON.stringify/parse禁止）。Uint8Arrayのまま保存・undo・転送する。詳細: `.claude/serialization-fbs.md`。単発操作のundoスナップショット（plain object往復・JSON差分比較）はデータ入替えに該当せず対象外（`.claude/undo-redo.md`）
2. **非アクティブフロアはIndexedDBにスワップアウト**し、アクティブフロアのみメモリに展開する。詳細: `.claude/persistence-idb.md`
3. **モードは動的ロード・破棄するMobXクラス**で書く（Reactフックで新モードを書かない）。詳細: `.claude/mode-system.md`
4. **描画ロジックはApp.jsx/renderer/に共通化**し、モードモジュールがKonva要素を返す構造にしない。
5. **ドラッグ中の変形はpendingDeltaで遅延評価**し、bake（mouseup確定）まで`value`を変更しない。詳細: `.claude/data-model.md`
6. **部材の実寸に依存する描画は、必ず実体側の現在の寸法値を参照する**（固定値・概算値で代用しない）。
7. **一覧の選択・展開がプログラム的に変わったら、その行/カードを可視域へ寄せる**（`ui/useScrollIntoViewWhenActive.js`）。キャンバス側のタップ（部屋・建具・部材タグ）や一覧側の操作結果（構造の部材分割で追加される新番号のカード）で選択が動くのに、対象がスクロール外だと「反応しなかった」ように見えるため。構造・仕上げ・建具で同一フックを共有する（`ui/SiteInfoPanel.jsx`だけは行がコンポーネント化されておらず未統合。同じ挙動を増やすときはフック側に寄せる）。
8. **graphを変更しない一括処理は`withGraphReadScope`（`src/graphReadScope.js`）で囲む**——MobXのcomputedは
   **観測者がいる間しかキャッシュされない**。モード突入時の一括構築はreactionの外＝観測者ゼロのため、
   `cl.effectiveValue`・`wall.axisValue/coord1/coord2/materialRange`・`graph.centerLines/walls/openings/rooms`
   といったcomputedが読み出しのたびに再計算され、依存のbind/unbindまで毎回走る。「部屋×面×セル」の
   多重ループでは**これが処理時間の大半**になる（展開モード突入の実機実測: 14.2秒→0.52秒）。
   スコープは処理全体をその場限りの`Reaction.track`の追跡下で走らせて直後にdisposeする
   （**autorunは不可**——初回実行がバッチ内だとバッチ終了まで遅延され、`runInAction`中の再構築で
   結果が返らない）。あわせて`graphList(graph,'walls')`（リスト読み）・`scopedValue`（派生索引のmemo）で
   算術的な重複計算も畳む。**キャッシュ寿命をスコープの実行中に限定するのが要点**——無効化の問題が
   原理的に起きず、keepAlive computedのようなリーク（peekで作る一時グラフのcomputedが共有structGraphの
   observerとして残る）も生じない。スコープ内で返る配列・Map・boundsは**読み取り専用**。
9. **平面レンダラの「毎レンダー派生値」は`graphComputed`（`src/renderer/graphDerived.js`）に載せる**——
   `renderer/`のレイヤーはすべて`observer`で、パン・ズーム・ポインタ移動のたびに再レンダーする。
   壁のT字取り合い・柱の仕上げ包み・壁ごとの開口といった**graphだけで決まる派生値**をレンダー本体で
   総当たりすると、1レンダーで60fpsの予算（16.7ms）を使い切る（実測: 壁224本・柱64本で約30ms＝
   平面モードのカクつきの主因）。`graphComputed`はgraph単位・キー単位のMobX computedで、
   observerが読み続ける限りキャッシュされ、graphのobservableが変わったときだけ再計算される。
   - **キーに依存値をすべて符号化する**（LODレベル等）。キーに現れない値をcomputeへ閉じ込めると古い結果が返る。
   - **observableを書き換える処理は載せない**（MobXのcomputedの規約。`refreshCells`を含む階段エントリ構築等）。
   - 返り値は**読み取り専用**（複数レンダーで同じインスタンスを共有する）。
   - 方針8（`withGraphReadScope`）とは住み分ける: 8は**観測者ゼロの一括処理**をその場限りの追跡下に置く
     もの、9は**観測者がいるレンダー**の結果をレンダー間で持ち越すもの。
   - 派生値そのものは`.jsx`に書かず純モジュール（`renderer/wallDrawPlan.js`等）へ出す
     ——`.jsx`はreact-konvaを静的importするためnodeから実行できず、コストを単体で測れない。
