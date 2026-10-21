import { useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import {
  DESIGN_STRENGTH_OPTIONS, CONCRETE_TYPE_OPTIONS, MAIN_BAR_OPTIONS, HOOP_BAR_OPTIONS,
  SNOW_AREA_OPTIONS, BASIC_WIND_SPEED_OPTIONS, SURFACE_ROUGHNESS_OPTIONS, SEISMIC_ZONE_FACTOR_OPTIONS,
  SelectRow, CheckboxGroup, TranscribedField,
} from '../ui/StructuralInfoDialog.jsx';
import { OTHER_STRUCTURE_OPTIONS, hasBasementFloor, foundationStructureFor, normalizeFoundationTypeFor } from './structureRules.js';
import { commonTabStructureRow, STRUCTURE_ROW, BASEMENT_UNSET_LABEL } from './commonInfoTabModel.js';

/**
 * 共通タブ（旧・構造パレット）。
 * project.structuralInfo（建物全体の既定値）を直接編集する。
 * 主構造のみ graph.structureOverride（階ごとの例外。null=建物全体値を継承）で上書き可能。
 * 表示中の階が地階のときは主構造の代わりに地階構造（ラーメン／壁式）を選ぶ（行の分岐は commonInfoTabModel.js）。
 */
export const CommonInfoTab = observer(function CommonInfoTab({ project, graph, onStructureChanged }) {
  const info = project.structuralInfo;
  const mainStructureRef = useRef(null);
  const hasOverride = graph.structureOverride != null;
  const row = commonTabStructureRow(graph.plane, graph.structureOverride, info);

  // 基礎種別の選択肢は構造（地階があれば地階構造、無ければ主構造。foundationStructureFor）で決まる。新しい構造の
  // 選択肢に現在値が無ければ既定へ正規化する（木造⇄非木造の往来で「なし/土間コン」等の不整合な値が残らないように）。
  // onStructureChanged の mutate の中（undo の「前後」に入る位置）から呼ぶ。階別オーバーライドは建物全体の
  // foundationType に影響しないため、上書きの編集・切替からは呼ばない。
  function normalizeFoundationType() {
    const next = normalizeFoundationTypeFor(foundationStructureFor(info, hasBasementFloor(project.planes)), info.foundationType);
    if (next !== info.foundationType) info.setField('foundationType', next);
  }

  // 主構造（実効値）が変わる操作は onStructureChanged（structuralOrchestration.js の recomputeStructuralComposition。App.jsx の onStructureChanged 経由）へ委譲する。
  // mutate（主構造の書き換え）を渡すと、自階＋下階の生成・材変換・採番と undo 登録をまとめてコア側が行う
  // ——構造伏図に映る下階の柱も実効主構造へ追従させるため、変換の単位を App 側の合成（composition）に揃える。
  function setMainStructure(v) {
    onStructureChanged(() => {
      if (hasOverride) graph.setStructureOverride(v);
      else {
        info.setField('mainStructure', v);
        normalizeFoundationType();
      }
    });
  }

  // 地階構造の変更も同じ経路（自階＋下階の再計算と undo 1件。建物全体値は mutate 前後で採って undo が戻す）。
  // 未設定の表示行を選んでも何も書かない。setBasementStructure を先に呼ぶ（選択肢外はここで throw し、基礎種別は触らない）。
  function setBasementStructure(v) {
    if (v === BASEMENT_UNSET_LABEL) return;
    onStructureChanged(() => {
      info.setBasementStructure(v);
      normalizeFoundationType();
    });
  }

  function toggleOverride(checked) {
    onStructureChanged(() => {
      graph.setStructureOverride(checked ? info.mainStructure : null);
    });
  }

  // マウント時点で主構造が未指定（'未定'）なら該当フィールドへフォーカス。
  useEffect(() => {
    if (row.focusOnMount) {
      mainStructureRef.current?.focus();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="site-dialog-body" style={{ flex: 1 }}>
      {/* 1. 主要構造部 */}
      <section className="site-section">
        <div className="site-section-title">1. 主要構造部</div>
        <SelectRow label={row.label} value={row.value} options={row.options}
          onChange={row.kind === STRUCTURE_ROW.BASEMENT ? setBasementStructure : setMainStructure} selectRef={mainStructureRef} />
        {row.showOverrideToggle && (
          <label className="site-checkbox-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={row.overrideChecked} onChange={e => toggleOverride(e.target.checked)} />
            この階のみ別構造にする
          </label>
        )}
        <CheckboxGroup label="その他" options={OTHER_STRUCTURE_OPTIONS}
          selected={info.otherStructures} onToggle={name => info.toggleOtherStructure(name)} />
      </section>

      {/* 2. 標準材料グレード設定（初期値の自動継承） */}
      <section className="site-section">
        <div className="site-section-title">2. 標準材料グレード設定（初期値の自動継承）</div>

        <div className="site-subsection-title">コンクリート（RC）</div>
        <SelectRow label="標準設計基準強度" value={info.designStrength} options={DESIGN_STRENGTH_OPTIONS}
          onChange={v => info.setField('designStrength', v)} unit="N/mm²" />
        <SelectRow label="コンクリート種類" value={info.concreteType} options={CONCRETE_TYPE_OPTIONS}
          onChange={v => info.setField('concreteType', v)} />

        <div className="site-subsection-title">鉄筋基準強度（SD）</div>
        <SelectRow label="主筋（太径: D19以上）" value={info.mainBar} options={MAIN_BAR_OPTIONS}
          onChange={v => info.setField('mainBar', v)} />
        <SelectRow label="帯筋（細径: D16以下）" value={info.hoopBar} options={HOOP_BAR_OPTIONS}
          onChange={v => info.setField('hoopBar', v)} />
      </section>

      {/* 3. 地域・設計荷重（自動計算パラメーター） */}
      <section className="site-section">
        <div className="site-section-title">3. 地域・設計荷重（自動計算パラメーター）</div>

        <div className="site-subsection-title">建設地・環境条件</div>
        <TranscribedField label="用途地域区分" value="未設定" note="（敷地情報から転写）" />
        <SelectRow label="積雪区域" value={info.snowArea} options={SNOW_AREA_OPTIONS}
          onChange={v => info.setField('snowArea', v)} />

        <div className="site-subsection-title">風荷重・地震荷重</div>
        <SelectRow label="基準風速 (V0)" value={info.basicWindSpeed} options={BASIC_WIND_SPEED_OPTIONS}
          onChange={v => info.setField('basicWindSpeed', Number(v))} unit="m/s （地域から自動判定）" />
        <SelectRow label="地表面粗度区分" value={info.surfaceRoughness} options={SURFACE_ROUGHNESS_OPTIONS}
          onChange={v => info.setField('surfaceRoughness', v)} />
        <SelectRow label="地震地域係数 (Z)" value={info.seismicZoneFactor} options={SEISMIC_ZONE_FACTOR_OPTIONS}
          onChange={v => info.setField('seismicZoneFactor', v)} />
      </section>
    </div>
  );
});
