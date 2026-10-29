import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import {
  DESIGN_STRENGTH_OPTIONS, CONCRETE_TYPE_OPTIONS, MAIN_BAR_OPTIONS, HOOP_BAR_OPTIONS,
  SNOW_AREA_OPTIONS, BASIC_WIND_SPEED_OPTIONS, SURFACE_ROUGHNESS_OPTIONS, SEISMIC_ZONE_FACTOR_OPTIONS,
  SelectRow, CheckboxGroup, TranscribedField,
} from '../ui/StructuralInfoDialog.jsx';
import { OTHER_STRUCTURE_OPTIONS, hasBasementFloor, foundationStructureFor, normalizeFoundationTypeFor } from './structureRules.js';
import { commonTabStructureRow, STRUCTURE_ROW, BASEMENT_UNSET_LABEL } from './commonInfoTabModel.js';
import {
  showSteelSlabSection, steelSlabCommonRows, planSlabEdit, commitSteelSlabSpec, SLAB_SECTION_TITLE, SLAB_ROW_KIND,
} from './commonInfoTabSlabModel.js';
import { CatalogKind, kindDef } from '../catalog/catalogKinds.js';
import { composeList } from '../catalog/catalogRegistry.js';
import { FIELD_ERROR_COLOR } from '../core/constants.js';

/** スラブ欄の1行（select / number / 読取専用）。number は入力中は下書きを持ち、blur / Enter で確定する（1打鍵ごとに再計算しない）。 */
const SlabRow = observer(function SlabRow({ row, draft, onDraft, onCommit, error }) {
  const shown = draft ?? (row.value ?? '');
  return (
    <>
      {row.kind === SLAB_ROW_KIND.READONLY ? (
        <TranscribedField label={row.label} note={row.note} value={`${row.value}${row.unit ? ` ${row.unit}` : ''}`} />
      ) : (
        <label className="site-row">
          <span className="site-label">{row.label}</span>
          {row.kind === SLAB_ROW_KIND.SELECT ? (
            <select value={row.value} onChange={e => onCommit(row.key, e.target.value)}>
              {row.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input type="number" min={row.min} value={shown} placeholder={row.placeholder}
              onChange={e => onDraft(row.key, e.target.value)}
              onBlur={() => { if (draft !== undefined) onCommit(row.key, draft); }}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          )}
          {row.unit && <span className="site-pair-unit">{row.unit}</span>}
        </label>
      )}
      {error && <div className="site-row" role="alert" style={{ color: FIELD_ERROR_COLOR }}>{error}</div>}
    </>
  );
});

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

  // S造スラブ欄。材料（プレート）の選択肢は本体カタログ＋ユーザー追加（仕上げモードと同じ composeList）。
  // materialData.js は独立チャンクのため kindDef(...).loadBuiltin() の動的 import で読む（読込み前は空＝照合しない）。
  const [materials, setMaterials] = useState([]);
  const [slabDrafts, setSlabDrafts] = useState({});
  const [slabError, setSlabError] = useState(null);
  useEffect(() => {
    let alive = true;
    kindDef(CatalogKind.MATERIAL).loadBuiltin().then(list => {
      if (alive) setMaterials(composeList(CatalogKind.MATERIAL, list));
    }).catch(() => {
      // 読込みに失敗したら未読込み（slabCatalog=undefined）のまま続ける——照合も「カタログに無い」表示もせず、現在値を保つ。
    });
    return () => { alive = false; };
  }, []);
  // 仕様の実体が替わった（undo/redo・他経路の書込み）ら入力途中の下書きは捨てる。
  const slabSpecRef = info.steelSlabSpec;
  useEffect(() => { setSlabDrafts({}); }, [slabSpecRef]);
  const slabCatalog = materials.length > 0 ? materials : undefined; // 空配列を渡すと全プレートが既定へ正規化されるため未読込みは undefined
  const showSlab = showSteelSlabSection(graph, project);
  const slab = showSlab ? steelSlabCommonRows({ spec: info.steelSlabSpec, materials: slabCatalog }) : null;

  // 共通仕様はS造スラブの子梁の割付けに効くため、再計算と undo 1件をまとめる onStructureChanged へ委譲する。
  // 検証に落ちたら書かず、行の下へ理由を出す。
  function commitSlab(key, value) {
    const { error, patch } = planSlabEdit({ spec: info.steelSlabSpec, key, value, materials: slabCatalog });
    if (error) { setSlabError({ key, message: error }); return; }
    setSlabError(null);
    setSlabDrafts(d => Object.fromEntries(Object.entries(d).filter(([k]) => k !== key)));
    if (patch === null) return; // 値が変わらない確定は書かない
    onStructureChanged(() => commitSteelSlabSpec(info, patch));
  }

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

      {/* 4. スラブ（S造）。S造の建物、または階の上書きがS造の階だけ */}
      {showSlab && (
        <section className="site-section">
          <div className="site-section-title">4. {SLAB_SECTION_TITLE}</div>
          {[slab.kindRow, ...slab.rows].map(r => (
            <SlabRow key={r.key} row={r} draft={slabDrafts[r.key]}
              onDraft={(k, text) => setSlabDrafts(d => ({ ...d, [k]: text }))}
              onCommit={commitSlab}
              error={slabError?.key === r.key ? slabError.message : null} />
          ))}
        </section>
      )}
    </div>
  );
});
