import { makeObservable, observable, action } from 'mobx';

// 天伏（天井伏図）モードの状態。仕上げモードとは独立。仕上げ表との共有はデータ（Room の天井欄）と
// 純モジュールだけ（ユーザー裁定 2026-10-10）。FinishModeState を継承しない。
// S1a' は graph を変えず材データも読まない（専用パネルは一覧を読むだけ）。

/** 専用パネルのタブ id（内部＝部屋ごとの天井欄／階段＝階段ごとの天井欄）。 */
export const CEILING_TABS = Object.freeze(['interior', 'stair']);

export class CeilingModeState {
  selectedRoomId = null;     // 一覧で強調中の部屋 ID | null（キャンバスの強調は S2）
  activeTab      = 'interior'; // 'interior' | 'stair'

  // graph は持たない（階切替で古い graph を抱える穴を作らない。パネルは App から渡る graph prop を読む）。
  constructor() {
    makeObservable(this, {
      selectedRoomId: observable,
      activeTab:      observable,
      selectRoom:     action,
      setActiveTab:   action,
    });
  }

  selectRoom(id) { this.selectedRoomId = id ?? null; }

  setActiveTab(tab) {
    if (!CEILING_TABS.includes(tab)) throw new Error(`CeilingModeState.setActiveTab: 未知のタブです: ${tab}`);
    this.activeTab = tab;
  }

  // ---- Lifecycle ----

  dispose() {
    this.selectRoom(null);
  }
}
