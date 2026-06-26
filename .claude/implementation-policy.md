# 実装方針（全体ルール）

このプロジェクトで必ず遵守する6つの方針。

1. **データ入替えはFlatBuffersのみ**（JSON.stringify/parse禁止）。Uint8Arrayのまま保存・undo・転送する。詳細: `.claude/serialization-fbs.md`
2. **非アクティブフロアはIndexedDBにスワップアウト**し、アクティブフロアのみメモリに展開する。詳細: `.claude/persistence-idb.md`
3. **モードは動的ロード・破棄するMobXクラス**で書く（Reactフックで新モードを書かない）。詳細: `.claude/mode-system.md`
4. **描画ロジックはApp.jsx/renderer/に共通化**し、モードモジュールがKonva要素を返す構造にしない。
5. **ドラッグ中の変形はpendingDeltaで遅延評価**し、bake（mouseup確定）まで`value`を変更しない。詳細: `.claude/data-model.md`
6. **部材の実寸に依存する描画は、必ず実体側の現在の寸法値を参照する**（固定値・概算値で代用しない）。
