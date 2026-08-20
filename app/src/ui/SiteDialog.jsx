import { useRef, useState } from 'react';
import './SiteDialog.css';

// ---- 1. 敷地・環境の状況 ----
const ELEVATION_DIFF_OPTIONS = ['平坦', '傾斜あり（ひな壇）', '道路より高い', '道路より低い'];
const ELEVATION_TREATMENT_OPTIONS = ['擁壁あり（RC造・間知石・コンクリートブロック）', '法地（芝・土）', 'なし'];
const RETAINING_WALL_SOUNDNESS_OPTIONS = ['問題なし', '亀裂・はらみあり', '水抜き穴なし', '適法か不明'];
const NEIGHBOR_WINDOW_OPTIONS = ['敷地側に向いている', '目隠しあり', '壁のみ（窓なし）'];
const BOUNDARY_BARRIER_OPTIONS = ['ブロック塀', 'フェンス', '生垣', 'なし'];
const ENCROACHMENT_OPTIONS = ['なし', 'あり（隣地から：樹木・軒・雨樋・足場 / 自敷地から：配管など）'];
const SUNLIGHT_VENTILATION_OPTIONS = ['良好', '隣家により遮られる', '将来的に高層建築が建つ可能性あり'];
const GROUND_CONDITION_OPTIONS = ['固そう', '軟弱そう（元田畑・水路跡など）', '盛土', '切土'];
const SURFACE_LAYER_OPTIONS = ['アスファルト', 'コンクリート', '土', '砂利', '草地'];

// ---- 2. 道路・接道状況 ----
const ROAD_LENGTH_OPTIONS = ['2m以上確保（建築基準法クリア）', '2m未満（再建築不可の可能性）'];
const DIRECTIONS = ['東', '西', '南', '北'];
const ROAD_TYPE_OPTIONS = [
  '法第42条1項1号（公道）',
  '1項2号（開発道路）',
  '1項3号（既存道路）',
  '1項5号（位置指定道路）',
  '2項道路（みなし道路・セットバック要）',
  '法43条但し書き（許可・認定要）',
  '通路（建築不可）',
];
const ROAD_WIDTH_OPTIONS = ['4m以上', '4m未満（セットバックが必要：中心線から2m / 片側崖地）'];
const ROAD_PAVEMENT_OPTIONS = ['アスファルト舗装', 'コンクリート舗装', '未舗装'];

// ---- 3. 法的規制・公法上の制限 ----
const CITY_PLANNING_AREA_OPTIONS = ['未確認', '市街化区域', '市街化調整区域（原則建築不可）', '未線引き区域'];
const USE_DISTRICT_OPTIONS = [
  '未確認',
  '第一種低層住居専用地域', '第二種低層住居専用地域',
  '第一種中高層住居専用地域', '第二種中高層住居専用地域',
  '第一種住居地域', '第二種住居地域', '準住居地域', '田園住居地域',
  '近隣商業地域', '商業地域', '準工業地域', '工業地域', '工業専用地域',
];
const ABSOLUTE_HEIGHT_LIMIT_OPTIONS = ['なし', '10m', '12m'];
const OBLIQUE_LINE_OPTIONS = ['用途未定につき不明', '道路斜線', '隣地斜線', '北側斜線（適用あり・なし）'];
const SUNSHINE_REGULATION_OPTIONS = ['対象外', '対象（時間規制：3h-2h、4h-2.5hなど）'];
const HEIGHT_DISTRICT_OPTIONS = ['指定なし', '第1種', '第2種', '第3種'];
const FIRE_PROTECTION_OPTIONS = ['防火地域', '準防火地域', '法22条区域', '指定なし'];
const DISTRICT_PLAN_OPTIONS = ['あり（壁面後退、意匠の制限など）', 'なし'];
const LANDSCAPE_ORDINANCE_OPTIONS = ['あり（色彩・高さの制限、届出要）', 'なし'];
const BURIED_PROPERTY_OPTIONS = ['範囲外', '範囲内（試掘調査・届出が必要）'];
const LAND_DEVELOPMENT_REGULATION_OPTIONS = ['区域外', '区域内（許可申請が必要）'];

function createDirectionDetail() {
  return { name: '', roadType: ROAD_TYPE_OPTIONS[0], width: ROAD_WIDTH_OPTIONS[0], pavement: ROAD_PAVEMENT_OPTIONS[0] };
}

function createInitialForm() {
  return {
    address: '',
    siteImageFile: null,
    elevationDiff: ELEVATION_DIFF_OPTIONS[0],
    elevationTreatment: 'なし',
    retainingWallSoundness: RETAINING_WALL_SOUNDNESS_OPTIONS[0],
    neighborWindow: NEIGHBOR_WINDOW_OPTIONS[0],
    boundaryBarrier: 'なし',
    encroachment: ENCROACHMENT_OPTIONS[0],
    sunlightVentilation: SUNLIGHT_VENTILATION_OPTIONS[0],
    groundCondition: GROUND_CONDITION_OPTIONS[0],
    surfaceLayer: '土',
    roadLength: ROAD_LENGTH_OPTIONS[0],
    roadDirections: {}, // { [方位]: { name, roadType, width, pavement } }
    cityPlanningArea: CITY_PLANNING_AREA_OPTIONS[0],
    useDistricts: ['未確認'],
    coverageRatioDesign: '',
    coverageRatioLimit: '',
    floorAreaRatioDesign: '',
    floorAreaRatioLimit: '',
    heightLimitDesign: '',
    heightLimitCategory: ABSOLUTE_HEIGHT_LIMIT_OPTIONS[0],
    obliqueLine: OBLIQUE_LINE_OPTIONS[0],
    sunshineRegulation: SUNSHINE_REGULATION_OPTIONS[0],
    heightDistrict: HEIGHT_DISTRICT_OPTIONS[0],
    fireProtection: FIRE_PROTECTION_OPTIONS[0],
    districtPlan: 'なし',
    landscapeOrdinance: 'なし',
    buriedProperty: BURIED_PROPERTY_OPTIONS[0],
    landDevelopmentRegulation: LAND_DEVELOPMENT_REGULATION_OPTIONS[0],
  };
}

function SelectRow({ label, value, options, onChange, disabled = false }) {
  return (
    <label className="site-row">
      <span className="site-label">{label}</span>
      <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
        {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    </label>
  );
}

function NumberPairRow({ label, design, limit, onDesignChange, onLimitChange, unit }) {
  return (
    <label className="site-row">
      <span className="site-label">{label}</span>
      <span className="site-pair">
        <input type="number" value={design} placeholder="設計値" onChange={e => onDesignChange(e.target.value)} />
        <span className="site-pair-sep">/</span>
        <input type="number" value={limit} placeholder="規制値" onChange={e => onLimitChange(e.target.value)} />
        {unit && <span className="site-pair-unit">{unit}</span>}
      </span>
    </label>
  );
}

function CheckboxGroup({ label, options, selected, onToggle }) {
  return (
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
  );
}

/**
 * 敷地モード — 敷地・環境・道路・法規制の調査情報を入力するダイアログ。
 *
 * 名称は「敷地モード」だが、実装は他モードと切替不要なダイアログ形式とする。
 * initial: 前回コミットしたフォーム値（project.projectInfo.siteInfo。null=未入力）。
 * onClose(form): どの閉じ口（閉じるボタン・背景タップ・ESC）でも現在のフォーム値を渡す
 * ——呼び出し側（App.jsx）がモデルへコミットして永続化する。画像ファイルだけは
 * バックエンド送信想定のため永続化対象外（コミット時に呼び出し側が除外する）。
 */
export function SiteDialog({ initial, onClose }) {
  // 保存済みフォームに無い新規フィールドは既定値で補う（調査票の項目は今後も増えるため）
  const [form, setForm] = useState(() => ({ ...createInitialForm(), ...(initial ?? {}) }));
  const fileInputRef = useRef(null);

  function set(key, value) {
    setForm(f => ({ ...f, [key]: value }));
  }

  function close() {
    onClose(form);
  }

  function handleImagePick() {
    fileInputRef.current?.click();
  }

  function handleImageChange(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) set('siteImageFile', file);
  }

  function toggleDirection(dir) {
    setForm(f => {
      const next = { ...f.roadDirections };
      if (next[dir]) delete next[dir];
      else next[dir] = createDirectionDetail();
      return { ...f, roadDirections: next };
    });
  }

  function setDirectionField(dir, field, value) {
    setForm(f => ({
      ...f,
      roadDirections: { ...f.roadDirections, [dir]: { ...f.roadDirections[dir], [field]: value } },
    }));
  }

  function toggleUseDistrict(name) {
    setForm(f => ({
      ...f,
      useDistricts: f.useDistricts.includes(name)
        ? f.useDistricts.filter(n => n !== name)
        : [...f.useDistricts, name],
    }));
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }

  return (
    <div className="site-dialog-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="site-dialog" onKeyDown={handleKeyDown}>
        <div className="site-dialog-header">敷地情報の入力</div>

        <div className="site-dialog-body">
          {/* 1. 敷地・環境の状況（敷地調査） */}
          <section className="site-section">
            <div className="site-section-title">1. 敷地・環境の状況（敷地調査）</div>

            <label className="site-row">
              <span className="site-label">敷地住所</span>
              <input type="text" value={form.address} onChange={e => set('address', e.target.value)} />
            </label>

            <div className="site-row">
              <span className="site-label">敷地図</span>
              <div className="site-image-row">
                <button type="button" className="site-image-btn" onClick={handleImagePick}>画像を選択...</button>
                <span className="site-image-name">{form.siteImageFile?.name ?? '未選択'}</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={handleImageChange}
                />
              </div>
            </div>

            <SelectRow label="高低差" value={form.elevationDiff} options={ELEVATION_DIFF_OPTIONS}
              onChange={v => set('elevationDiff', v)} />
            <SelectRow label="高低差の処理" value={form.elevationTreatment} options={ELEVATION_TREATMENT_OPTIONS}
              onChange={v => set('elevationTreatment', v)} />
            <SelectRow label="擁壁の健全性" value={form.retainingWallSoundness} options={RETAINING_WALL_SOUNDNESS_OPTIONS}
              onChange={v => set('retainingWallSoundness', v)} disabled={form.elevationTreatment === 'なし'} />

            <div className="site-subsection-title">周辺環境・隣地状況</div>
            <SelectRow label="隣家の窓の位置" value={form.neighborWindow} options={NEIGHBOR_WINDOW_OPTIONS}
              onChange={v => set('neighborWindow', v)} />
            <SelectRow label="隣地境界の障壁" value={form.boundaryBarrier} options={BOUNDARY_BARRIER_OPTIONS}
              onChange={v => set('boundaryBarrier', v)} />
            <SelectRow label="越境物の有無" value={form.encroachment} options={ENCROACHMENT_OPTIONS}
              onChange={v => set('encroachment', v)} />
            <SelectRow label="日照・通風への影響" value={form.sunlightVentilation} options={SUNLIGHT_VENTILATION_OPTIONS}
              onChange={v => set('sunlightVentilation', v)} />

            <div className="site-subsection-title">地盤・土壌の視覚的判断</div>
            <SelectRow label="地盤の状況" value={form.groundCondition} options={GROUND_CONDITION_OPTIONS}
              onChange={v => set('groundCondition', v)} />
            <SelectRow label="地代表層" value={form.surfaceLayer} options={SURFACE_LAYER_OPTIONS}
              onChange={v => set('surfaceLayer', v)} />
          </section>

          {/* 2. 道路・接道状況（道路調査） */}
          <section className="site-section">
            <div className="site-section-title">2. 道路・接道状況（道路調査）</div>

            <SelectRow label="接道長さ" value={form.roadLength} options={ROAD_LENGTH_OPTIONS}
              onChange={v => set('roadLength', v)} />
            <CheckboxGroup label="接道方位" options={DIRECTIONS}
              selected={Object.keys(form.roadDirections)} onToggle={toggleDirection} />

            {DIRECTIONS.filter(dir => form.roadDirections[dir]).map(dir => {
              const detail = form.roadDirections[dir];
              return (
                <div key={dir} className="site-direction-form">
                  <div className="site-subsection-title">{dir}側の道路</div>
                  <label className="site-row">
                    <span className="site-label">名称</span>
                    <input type="text" value={detail.name} onChange={e => setDirectionField(dir, 'name', e.target.value)} />
                  </label>
                  <SelectRow label="道路の種別" value={detail.roadType} options={ROAD_TYPE_OPTIONS}
                    onChange={v => setDirectionField(dir, 'roadType', v)} />
                  <SelectRow label="道路の幅員" value={detail.width} options={ROAD_WIDTH_OPTIONS}
                    onChange={v => setDirectionField(dir, 'width', v)} />
                  <SelectRow label="道路の舗装" value={detail.pavement} options={ROAD_PAVEMENT_OPTIONS}
                    onChange={v => setDirectionField(dir, 'pavement', v)} />
                </div>
              );
            })}
          </section>

          {/* 3. 法的規制・公法上の制限（役所調査） */}
          <section className="site-section">
            <div className="site-section-title">3. 法的規制・公法上の制限（役所調査）</div>

            <div className="site-subsection-title">都市計画・用途地域</div>
            <SelectRow label="都市計画区域" value={form.cityPlanningArea} options={CITY_PLANNING_AREA_OPTIONS}
              onChange={v => set('cityPlanningArea', v)} />
            <CheckboxGroup label="用途地域" options={USE_DISTRICT_OPTIONS}
              selected={form.useDistricts} onToggle={toggleUseDistrict} />
            <NumberPairRow label="建ぺい率" unit="%"
              design={form.coverageRatioDesign} limit={form.coverageRatioLimit}
              onDesignChange={v => set('coverageRatioDesign', v)} onLimitChange={v => set('coverageRatioLimit', v)} />
            <NumberPairRow label="容積率" unit="%"
              design={form.floorAreaRatioDesign} limit={form.floorAreaRatioLimit}
              onDesignChange={v => set('floorAreaRatioDesign', v)} onLimitChange={v => set('floorAreaRatioLimit', v)} />

            <div className="site-subsection-title">高さ制限・その他の規制</div>
            <label className="site-row">
              <span className="site-label">絶対高さ制限</span>
              <span className="site-pair">
                <input type="number" value={form.heightLimitDesign} placeholder="設計値"
                  onChange={e => set('heightLimitDesign', e.target.value)} />
                <span className="site-pair-unit">m</span>
                <span className="site-pair-sep">/</span>
                <select value={form.heightLimitCategory} onChange={e => set('heightLimitCategory', e.target.value)}>
                  {ABSOLUTE_HEIGHT_LIMIT_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </span>
            </label>
            <SelectRow label="斜線制限" value={form.obliqueLine} options={OBLIQUE_LINE_OPTIONS}
              onChange={v => set('obliqueLine', v)} />
            <SelectRow label="日影規制" value={form.sunshineRegulation} options={SUNSHINE_REGULATION_OPTIONS}
              onChange={v => set('sunshineRegulation', v)} />
            <SelectRow label="高度地区" value={form.heightDistrict} options={HEIGHT_DISTRICT_OPTIONS}
              onChange={v => set('heightDistrict', v)} />
            <SelectRow label="防火指定" value={form.fireProtection} options={FIRE_PROTECTION_OPTIONS}
              onChange={v => set('fireProtection', v)} />

            <div className="site-subsection-title">特殊な条例・文化財</div>
            <SelectRow label="地区計画" value={form.districtPlan} options={DISTRICT_PLAN_OPTIONS}
              onChange={v => set('districtPlan', v)} />
            <SelectRow label="景観条例" value={form.landscapeOrdinance} options={LANDSCAPE_ORDINANCE_OPTIONS}
              onChange={v => set('landscapeOrdinance', v)} />
            <SelectRow label="埋蔵文化財包蔵地" value={form.buriedProperty} options={BURIED_PROPERTY_OPTIONS}
              onChange={v => set('buriedProperty', v)} />
            <SelectRow label="宅地造成等工事規制区域" value={form.landDevelopmentRegulation} options={LAND_DEVELOPMENT_REGULATION_OPTIONS}
              onChange={v => set('landDevelopmentRegulation', v)} />
          </section>
        </div>

        <div className="site-dialog-footer">
          <button className="site-dialog-btn" onClick={close}>閉じる</button>
        </div>
      </div>
    </div>
  );
}
