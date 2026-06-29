import { observer } from 'mobx-react-lite';
import './SiteDialog.css';

// 構造情報パネル（共通タブ）で使う選択肢・ヘルパーコンポーネント。
// パネル本体（structural/StructuralPanel.jsx）・共通タブ本体（structural/CommonInfoTab.jsx）から参照する。

export const MAIN_STRUCTURE_OPTIONS = ['未定', 'RC造(ラーメン)', 'RC造(壁式)', 'S造', 'SRC造', '木造（在来）', '木造（2"×4"）'];
export const OTHER_STRUCTURE_OPTIONS = ['RC造(ラーメン)', 'RC造(壁式)', 'S造', 'SRC造', '木造（在来）', '木造（2"×4"）'];
export const FOUNDATION_OPTIONS = ['杭基礎（既製コンクリート杭）', '独立基礎', '布基礎', 'ベタ基礎'];
// 木造（在来・2"×4"）の基礎種別（問題.md「なし / べた基礎* / 土間コン」。'べた基礎'＝canonical表記の 'ベタ基礎'）。
export const WOOD_FOUNDATION_OPTIONS = ['なし', 'ベタ基礎', '土間コン'];

/** 木造系（在来・2"×4"）か。基礎種別の選択肢分岐・配置分岐（共通タブ⇄構造リスト）で共用する。 */
export function isWoodStructure(structure) {
  return structure === '木造（在来）' || structure === '木造（2"×4"）';
}

/** 主構造に応じた基礎種別の選択肢。木造系のみ「なし/ベタ基礎/土間コン」、それ以外は従来のRC系選択肢。 */
export function foundationOptionsFor(structure) {
  return isWoodStructure(structure) ? WOOD_FOUNDATION_OPTIONS : FOUNDATION_OPTIONS;
}
export const DESIGN_STRENGTH_OPTIONS = ['Fc21', 'Fc24', 'Fc27', 'Fc30'];
export const CONCRETE_TYPE_OPTIONS = ['普通コンクリート', '軽量コンクリート'];
export const MAIN_BAR_OPTIONS = ['SD345', 'SD390'];
export const HOOP_BAR_OPTIONS = ['SD295A', 'SD295B'];
export const SNOW_AREA_OPTIONS = ['一般区域（多雪以外）', '多雪区域'];
export const BASIC_WIND_SPEED_OPTIONS = [30, 32, 34, 36, 38, 40, 42, 44, 46];
export const SURFACE_ROUGHNESS_OPTIONS = ['I', 'II', 'III', 'IV'];
export const SEISMIC_ZONE_FACTOR_OPTIONS = ['1.0', '0.9', '0.8', '0.7'];

export const SelectRow = observer(({ label, value, options, onChange, unit, selectRef }) => (
  <label className="site-row">
    <span className="site-label">{label}</span>
    <select ref={selectRef} value={value} onChange={e => onChange(e.target.value)}>
      {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
    </select>
    {unit && <span className="site-pair-unit">{unit}</span>}
  </label>
));

export const CheckboxGroup = observer(({ label, options, selected, onToggle }) => (
  <div className="site-row" style={{ alignItems: 'flex-start' }}>
    <span className="site-label">{label}</span>
    <div className="site-checkbox-group">
      {options.map(opt => (
        <label key={opt} className="site-checkbox-row">
          <input type="checkbox" checked={selected.includes(opt)} onChange={() => onToggle(opt)} />
          {opt}
        </label>
      ))}
    </div>
  </div>
));

// 敷地情報から転写される想定の読み取り専用項目。転写ロジックは未実装のため、
// BuildingInfoDialog の AutoCalcField と同様にプレースホルダ表示のみ置く。
export const TranscribedField = observer(({ label, note, value }) => (
  <div className="site-row">
    <span className="site-label">{label}</span>
    <span className="building-info-readout" style={{ width: '100%', textAlign: 'left' }}>{value}</span>
    {note && <span className="site-pair-sep">{note}</span>}
  </div>
));
