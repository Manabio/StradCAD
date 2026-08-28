# 実装方針（全体ルール）

このプロジェクトで必ず遵守する7つの方針。

1. **データ入替えはFlatBuffersのみ**（JSON.stringify/parse禁止）。Uint8Arrayのまま保存・undo・転送する。詳細: `.claude/serialization-fbs.md`。単発操作のundoスナップショット（plain object往復・JSON差分比較）はデータ入替えに該当せず対象外（`.claude/undo-redo.md`）
2. **非アクティブフロアはIndexedDBにスワップアウト**し、アクティブフロアのみメモリに展開する。詳細: `.claude/persistence-idb.md`
3. **モードは動的ロード・破棄するMobXクラス**で書く（Reactフックで新モードを書かない）。詳細: `.claude/mode-system.md`
4. **描画ロジックはApp.jsx/renderer/に共通化**し、モードモジュールがKonva要素を返す構造にしない。
5. **ドラッグ中の変形はpendingDeltaで遅延評価**し、bake（mouseup確定）まで`value`を変更しない。詳細: `.claude/data-model.md`
6. **部材の実寸に依存する描画は、必ず実体側の現在の寸法値を参照する**（固定値・概算値で代用しない）。
7. **一覧の選択・展開がプログラム的に変わったら、その行/カードを可視域へ寄せる**（`ui/useScrollIntoViewWhenActive.js`）。キャンバス側のタップ（部屋・建具・部材タグ）や一覧側の操作結果（構造の部材分割で追加される新番号のカード）で選択が動くのに、対象がスクロール外だと「反応しなかった」ように見えるため。構造・仕上げ・建具で同一フックを共有する（`ui/SiteInfoPanel.jsx`だけは行がコンポーネント化されておらず未統合。同じ挙動を増やすときはフック側に寄せる）。
