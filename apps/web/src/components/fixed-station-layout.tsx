'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, MapPin, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import {
  candidateSiteReadiness,
  emptyStationNetwork,
  emptySitingConstraints,
  formalCandidateSites,
  sitingConstraintReadiness,
  stationNetworkFinancialReadiness,
  stationNetworkReadiness,
  stationTypeReadiness,
  type CandidateSite,
  type SitingConstraints,
  type CoordinateSystem,
  type OperatingShift,
  type PlanningScenario,
  type Point,
  type PointSource,
  type PowerConnectionPoint,
  type PowerConnectionPointSet,
  type StationNetwork,
  type StationNetworkInput,
  type StationTypeInput,
} from '@haulpath/domain';
import { Dialog } from './app-dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import MapPanel, { type MapCandidate, type MapConfig } from './map-panel';
import { request } from '@/lib/client-request';
import styles from './fixed-station-layout.module.css';

const typeFields = [
  ['bays', '换电工位（个）'],
  ['swapMinutes', '换电时间（分钟）'],
  ['batteryInventory', '电池库存（块）'],
  ['chargingSlots', '充电位（个）'],
  ['chargePowerKw', '站内总充电功率上限（kW）'],
  ['investment', '建站投资（元）'],
  ['annualOperatingCost', '年度运维费用（元）'],
] as const;
type TypeNumber = (typeof typeFields)[number][0];
type TypeDraft = Omit<StationTypeInput, TypeNumber | 'serviceWindows' | 'chargeWindows'> &
  Record<TypeNumber | 'serviceWindows' | 'chargeWindows', string> & { key: string };
type PointDraft = {
  key: string;
  id?: string;
  name: string;
  longitude: string;
  latitude: string;
  coordinateSystem: CoordinateSystem;
  source: PointSource;
  saved?: Point;
};
type SiteDraft = PointDraft & {
  generationBasis?: CandidateSite['generationBasis'];
  siteNotes: string;
  siteConfirmed: boolean;
  powerSourceId: string;
  availablePowerKw: string;
  connectionInvestment: string;
  connectionNotes: string;
  connectionConfirmed: boolean;
};
type PowerDraft = PointDraft & {
  sourcePointId: string;
  availableCapacityKw: string;
  capacitySource: string;
  connectionNotes: string;
  refreshSource: boolean;
};
type Draft = {
  revision: number;
  constraints: Omit<SitingConstraints, 'maxInvestment' | 'maxStations'> & {
    maxInvestment: string;
    maxStations: string;
  };
  types: TypeDraft[];
  sites: SiteDraft[];
  powers: PowerDraft[];
  fixedLayout: StationNetwork['fixedLayout'];
};
type Tab = 'sites' | 'types' | 'powers' | 'layout' | 'constraints';
type PasteRow = { line: number; value?: SiteDraft | TypeDraft; error?: string };
const tabs: [Tab, string][] = [
  ['sites', '候选站址'],
  ['types', '站型'],
  ['powers', '电源快照'],
  ['layout', '固定布局'],
  ['constraints', '选址约束'],
];
const text = (value: number | null | undefined) => (value == null ? '' : String(value));
const message = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试。');
const clock = (minute: number) =>
  `${minute >= 1440 ? '次日' : ''}${String(Math.floor((minute % 1440) / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const windowsText = (windows: OperatingShift[]) =>
  windows.map((window) => `${clock(window.startMinute)}-${clock(window.endMinute)}`).join(';');
function numberOf(value: string, label: string, integer = false): number | null {
  if (!value.trim()) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || (integer && !Number.isSafeInteger(result)))
    throw new Error(`${label}须为非负${integer ? '整数' : '有限数值'}，缺失时留空`);
  return result;
}
function windowsOf(value: string): OperatingShift[] {
  if (!value.trim()) return [];
  const windows = value.split(/[;；]/).map((part) => {
    const match = part.trim().match(/^(\d{1,2}):(\d{2})\s*[-–—]\s*(次日)?(\d{1,2}):(\d{2})$/);
    if (!match) throw new Error('窗口格式为 06:00-18:00；跨午夜写 22:00-次日02:00');
    const [, sh, sm, next, eh, em] = match;
    if (+sh > 23 || +eh > 23 || +sm > 59 || +em > 59) throw new Error('窗口时刻须在00:00–23:59内');
    const startMinute = +sh * 60 + +sm;
    const endMinute = +eh * 60 + +em + (next ? 1440 : 0);
    if (endMinute <= startMinute || endMinute > startMinute + 1440)
      throw new Error('窗口时长须大于零且不超过24小时');
    return { startMinute, endMinute };
  });
  if (
    windows.some((window, index) =>
      windows
        .slice(0, index)
        .some((previous) =>
          [-1440, 0, 1440].some(
            (offset) =>
              window.startMinute < previous.endMinute + offset &&
              window.endMinute > previous.startMinute + offset,
          ),
        ),
    )
  )
    throw new Error('窗口不能重叠，包括跨午夜的周期重叠');
  return windows;
}
function pointInput(row: PointDraft) {
  if (!row.name.trim()) throw new Error('请填写名称');
  const longitude = Number(row.longitude),
    latitude = Number(row.latitude);
  if (!row.longitude.trim() || !Number.isFinite(longitude) || Math.abs(longitude) > 180)
    throw new Error('原始经度须为-180至180的有限数值');
  if (!row.latitude.trim() || !Number.isFinite(latitude) || Math.abs(latitude) > 90)
    throw new Error('原始纬度须为-90至90的有限数值');
  if (!['GCJ-02', 'WGS84'].includes(row.coordinateSystem))
    throw new Error('坐标系须为GCJ-02或WGS84');
  return {
    name: row.name.trim(),
    longitude,
    latitude,
    coordinateSystem: row.coordinateSystem,
    source: row.source,
  };
}
function positiveOf(value: string, label: string, integer = false): number | null {
  const number = numberOf(value, label, integer);
  if (number === 0) throw new Error(`${label}须大于0，缺失时留空`);
  return number;
}
function typeInput(row: TypeDraft): StationTypeInput {
  if (!row.name.trim()) throw new Error('请填写站型名称');
  return {
    ...(row.id ? { id: row.id } : {}),
    name: row.name.trim(),
    bays: positiveOf(row.bays, '换电工位', true),
    swapMinutes: positiveOf(row.swapMinutes, '换电时间'),
    batteryInventory: numberOf(row.batteryInventory, '电池库存', true),
    chargingSlots: numberOf(row.chargingSlots, '充电位', true),
    chargePowerKw: positiveOf(row.chargePowerKw, '站内总充电功率上限'),
    serviceWindows: windowsOf(row.serviceWindows),
    chargeWindows: windowsOf(row.chargeWindows),
    investment: numberOf(row.investment, '建站投资'),
    annualOperatingCost: numberOf(row.annualOperatingCost, '年度运维费用'),
    source: row.source.trim(),
    ...(row.refreshBattery ? { refreshBattery: true } : {}),
  };
}
function blankPoint(): PointDraft {
  return {
    key: crypto.randomUUID(),
    name: '',
    longitude: '',
    latitude: '',
    coordinateSystem: 'GCJ-02',
    source: 'manual',
  };
}
function blankSite(): SiteDraft {
  return {
    ...blankPoint(),
    siteNotes: '',
    siteConfirmed: false,
    powerSourceId: '',
    availablePowerKw: '',
    connectionInvestment: '',
    connectionNotes: '',
    connectionConfirmed: false,
  };
}
function blankType(): TypeDraft {
  return {
    key: crypto.randomUUID(),
    name: '',
    bays: '',
    swapMinutes: '',
    batteryInventory: '',
    chargingSlots: '',
    chargePowerKw: '',
    serviceWindows: '',
    chargeWindows: '',
    investment: '',
    annualOperatingCost: '',
    source: '',
  };
}
function pointDraft(point: Point): PointDraft {
  return {
    ...point,
    key: point.id,
    longitude: String(point.originalLongitude),
    latitude: String(point.originalLatitude),
    saved: point,
  };
}
function siteDraft(site: CandidateSite): SiteDraft {
  return {
    ...pointDraft(site),
    generationBasis: site.generationBasis,
    siteNotes: site.siteNotes,
    siteConfirmed: site.siteConfirmed,
    powerSourceId: site.connection?.powerSourceId ?? '',
    availablePowerKw: text(site.connection?.availablePowerKw),
    connectionInvestment: text(site.connection?.connectionInvestment),
    connectionNotes: site.connection?.notes ?? '',
    connectionConfirmed: site.connection?.confirmed ?? false,
  };
}
function draftOf(scenario: PlanningScenario): Draft {
  const network = scenario.context.stationNetwork ?? emptyStationNetwork();
  return {
    revision: scenario.revision,
    constraints: {
      ...(network.constraints ?? emptySitingConstraints()),
      maxInvestment: text(network.constraints?.maxInvestment),
      maxStations: text(network.constraints?.maxStations),
    },
    types: network.stationTypes.map((type) => ({
      ...type,
      key: type.id,
      bays: text(type.bays),
      swapMinutes: text(type.swapMinutes),
      batteryInventory: text(type.batteryInventory),
      chargingSlots: text(type.chargingSlots),
      chargePowerKw: text(type.chargePowerKw),
      serviceWindows: windowsText(type.serviceWindows),
      chargeWindows: windowsText(type.chargeWindows),
      investment: text(type.investment),
      annualOperatingCost: text(type.annualOperatingCost),
    })),
    sites: network.sites.map(siteDraft),
    powers: network.powerSources.map((power) => ({
      ...pointDraft(power.point),
      key: power.id,
      id: power.id,
      sourcePointId: power.sourcePointId,
      availableCapacityKw: text(power.point.availableCapacityKw),
      capacitySource: power.point.capacitySource,
      connectionNotes: power.point.connectionNotes,
      refreshSource: false,
    })),
    fixedLayout: network.fixedLayout.map((selection) => ({ ...selection })),
  };
}
function constraintsInput(draft: Draft): SitingConstraints {
  return {
    ...draft.constraints,
    maxInvestment: numberOf(draft.constraints.maxInvestment, '总新增投资上限'),
    maxStations: numberOf(draft.constraints.maxStations, '新建站数上限', true),
  };
}
function inputOf(draft: Draft): StationNetworkInput {
  return {
    constraints: constraintsInput(draft),
    stationTypes: draft.types.map((row, i) => {
      try {
        return typeInput(row);
      } catch (error) {
        throw new Error(`站型第 ${i + 1} 行：${message(error)}`);
      }
    }),
    sites: draft.sites.map((row, i) => {
      try {
        return {
          ...pointInput(row),
          ...(row.id ? { id: row.id } : {}),
          ...(row.generationBasis ? { generationBasis: row.generationBasis } : {}),
          siteNotes: row.siteNotes,
          siteConfirmed: row.siteConfirmed,
          connection: row.powerSourceId
            ? {
                powerSourceId: row.powerSourceId,
                availablePowerKw: numberOf(row.availablePowerKw, '可用功率'),
                connectionInvestment: numberOf(row.connectionInvestment, '接电投资'),
                notes: row.connectionNotes,
                confirmed: row.connectionConfirmed,
              }
            : null,
        };
      } catch (error) {
        throw new Error(`站址第 ${i + 1} 行：${message(error)}`);
      }
    }),
    powerSources: draft.powers.map((row, i) => {
      if (!row.id) return { sourcePointId: row.sourcePointId };
      if (row.refreshSource)
        return { id: row.id, sourcePointId: row.sourcePointId, refreshSource: true };
      try {
        return {
          id: row.id,
          sourcePointId: row.sourcePointId,
          point: {
            ...pointInput(row),
            availableCapacityKw: numberOf(row.availableCapacityKw, '可用容量'),
            capacitySource: row.capacitySource,
            connectionNotes: row.connectionNotes,
          },
        };
      } catch (error) {
        throw new Error(`电源第 ${i + 1} 行：${message(error)}`);
      }
    }),
    fixedLayout: draft.fixedLayout,
  };
}
function mapPoint(row: PointDraft): Point | null {
  if (
    row.saved &&
    row.saved.coordinateSystem === row.coordinateSystem &&
    row.saved.originalLongitude === Number(row.longitude) &&
    row.saved.originalLatitude === Number(row.latitude)
  )
    return { ...row.saved, id: row.key, name: row.name };
  if (row.coordinateSystem !== 'GCJ-02') return null;
  try {
    const point = pointInput(row);
    return {
      ...point,
      id: row.key,
      originalLongitude: point.longitude,
      originalLatitude: point.latitude,
    };
  } catch {
    return null;
  }
}

export default function FixedStationLayout({
  scenario,
  disabled,
  onChange,
  onWritingChange,
  onEditingChange,
}: {
  scenario: PlanningScenario;
  disabled: boolean;
  onChange: (scenario: PlanningScenario) => void;
  onWritingChange: (writing: boolean) => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const network = scenario.context.stationNetwork ?? emptyStationNetwork();
  const physical = stationNetworkReadiness(scenario.context);
  const financial = stationNetworkFinancialReadiness(network);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [tab, setTab] = useState<Tab>('sites');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [moving, setMoving] = useState<string | null>(null);
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [resources, setResources] = useState<PowerConnectionPoint[]>([]);
  const [resourceError, setResourceError] = useState('');
  const [loadingResources, setLoadingResources] = useState(false);
  const [resourceReload, setResourceReload] = useState(0);
  const [resourceId, setResourceId] = useState('');
  const [paste, setPaste] = useState('');
  const [pasteKind, setPasteKind] = useState<'sites' | 'types'>('sites');
  const [preview, setPreview] = useState<PasteRow[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [generationNotice, setGenerationNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const writing = useRef(false);
  const alive = useRef(true);
  const editorOpen = draft !== null;
  useEffect(() => {
    onEditingChange?.(editorOpen);
    return () => onEditingChange?.(false);
  }, [editorOpen, onEditingChange]);
  const dirty = !!draft && (JSON.stringify(draft) !== baseline || !!paste.trim());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!editorOpen) return;
    const controller = new AbortController();
    request<MapConfig>('/api/config', 'GET', undefined, controller.signal)
      .then(setConfig)
      .catch(() => {
        if (!controller.signal.aborted)
          setConfig({
            mapKey: '',
            securityProxyPath: '/_AMapService',
            webServiceConfigured: false,
          });
      });
    return () => controller.abort();
  }, [editorOpen]);
  useEffect(() => {
    if (!editorOpen) return;
    const controller = new AbortController();
    request<PowerConnectionPointSet>(
      `/api/projects/${scenario.projectId}/power-connection-points`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((value) => setResources(value.points))
      .catch((failure) => {
        if (!controller.signal.aborted) setResourceError(message(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingResources(false);
      });
    return () => controller.abort();
  }, [editorOpen, scenario.projectId, resourceReload]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, saving]);
  function open() {
    const next = draftOf(scenario);
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setTab('sites');
    setError('');
    setNotice('');
    setPaste('');
    setPreview(null);
    setMoving(null);
    setSearch('');
    setFilter('all');
    setGenerationNotice('');
    setDiscarding(false);
    setLoadingResources(true);
    setResourceError('');
  }
  function close() {
    if (writing.current) return;
    if (dirty) {
      setDiscarding(true);
      return;
    }
    setDraft(null);
    setError('');
  }
  function updateSite(key: string, changes: Partial<SiteDraft>) {
    if (!draft) return;
    const siteChanged = ['longitude', 'latitude', 'coordinateSystem', 'siteNotes'].some(
      (field) => field in changes,
    );
    const connectionChanged = [
      'powerSourceId',
      'availablePowerKw',
      'connectionInvestment',
      'connectionNotes',
    ].some((field) => field in changes);
    setDraft({
      ...draft,
      sites: draft.sites.map((row) =>
        row.key === key
          ? {
              ...row,
              ...changes,
              ...(siteChanged
                ? { siteConfirmed: false, connectionConfirmed: false }
                : connectionChanged
                  ? { connectionConfirmed: false }
                  : {}),
            }
          : row,
      ),
    });
  }
  function updatePower(key: string, changes: Partial<PowerDraft>) {
    if (!draft) return;
    setDraft({
      ...draft,
      powers: draft.powers.map((row) => (row.key === key ? { ...row, ...changes } : row)),
    });
  }
  function candidate(value: MapCandidate) {
    if (!draft || saving) return;
    if (moving) {
      updateSite(moving, {
        longitude: String(value.longitude),
        latitude: String(value.latitude),
        coordinateSystem: 'GCJ-02',
        source: value.source,
      });
      setMoving(null);
    } else
      setDraft({
        ...draft,
        sites: [
          ...draft.sites,
          {
            ...blankSite(),
            name: value.name || `候选站址 ${draft.sites.length + 1}`,
            longitude: String(value.longitude),
            latitude: String(value.latitude),
            source: value.source,
          },
        ],
      });
  }
  async function generate() {
    if (!draft || dirty || writing.current) return;
    writing.current = true;
    setSaving(true);
    onWritingChange(true);
    setError('');
    setGenerationNotice('');
    try {
      const next = await request<PlanningScenario>(
        `/api/projects/${scenario.projectId}/scenarios/${scenario.id}/station-network`,
        'POST',
        { expectedRevision: draft.revision },
      );
      if (!alive.current) return;
      const count = (next.context.stationNetwork?.sites.length ?? 0) - network.sites.length;
      onChange(next);
      const updated = draftOf(next);
      setDraft(updated);
      setBaseline(JSON.stringify(updated));
      setSearch('');
      setFilter('all');
      setGenerationNotice(
        `已保存新增 ${count} 个初步候选。重复来源保留原站址，同址系统建议已合并来源；请核实场地与接电，并为新输入版本准备对应道路资料。`,
      );
    } catch (failure) {
      if (alive.current) setError(message(failure));
    } finally {
      writing.current = false;
      if (alive.current) setSaving(false);
      onWritingChange(false);
    }
  }
  async function save() {
    if (!draft || writing.current) return;
    setError('');
    let networkInput: StationNetworkInput;
    try {
      networkInput = inputOf(draft);
    } catch (failure) {
      setError(message(failure));
      return;
    }
    writing.current = true;
    setSaving(true);
    onWritingChange(true);
    try {
      const next = await request<PlanningScenario>(
        `/api/projects/${scenario.projectId}/scenarios/${scenario.id}/station-network`,
        'PUT',
        { expectedRevision: draft.revision, network: networkInput },
      );
      if (!alive.current) return;
      onChange(next);
      setDraft(null);
      setNotice('站网资料已保存；可重开核对确认状态与固定布局。');
    } catch (failure) {
      if (alive.current) setError(message(failure));
    } finally {
      writing.current = false;
      if (alive.current) setSaving(false);
      onWritingChange(false);
    }
  }
  function inspectPaste(kind: 'sites' | 'types') {
    const lines = paste.replace(/\r/g, '').split('\n');
    while (lines.length && !lines.at(-1)?.trim()) lines.pop();
    if (!paste.trim()) {
      setPreview([{ line: 1, error: '请先粘贴资料' }]);
      return;
    }
    setPreview(
      lines.map((line, i) => {
        try {
          const cells = line.split('\t');
          if (kind === 'sites') {
            if (cells.length < 4 || cells.length > 5)
              throw new Error('须为4–5列：名称、经度、纬度、坐标系、场地条件说明');
            const [name, longitude, latitude, system, notes = ''] = cells;
            const value = {
              ...blankSite(),
              name,
              longitude,
              latitude,
              coordinateSystem: (system || 'GCJ-02') as CoordinateSystem,
              siteNotes: notes,
              source: 'import' as const,
            };
            pointInput(value);
            return { line: i + 1, value };
          }
          if (cells.length !== 11) throw new Error('站型须为11列，缺失数字或窗口保留空列');
          const [
            name,
            bays,
            swapMinutes,
            batteryInventory,
            chargingSlots,
            chargePowerKw,
            serviceWindows,
            chargeWindows,
            investment,
            annualOperatingCost,
            source,
          ] = cells;
          const value = {
            ...blankType(),
            name,
            bays,
            swapMinutes,
            batteryInventory,
            chargingSlots,
            chargePowerKw,
            serviceWindows,
            chargeWindows,
            investment,
            annualOperatingCost,
            source,
          };
          typeInput(value);
          return { line: i + 1, value };
        } catch (failure) {
          return { line: i + 1, error: message(failure) };
        }
      }),
    );
  }
  function draftSiteGaps(site: SiteDraft): string[] {
    const saved = network.sites.find((item) => item.id === site.id);
    if (!saved) return ['新位置待保存和确认'];
    const power = draft?.powers.find((item) => item.id === site.powerSourceId);
    const savedPower = network.powerSources.find((item) => item.id === site.powerSourceId);
    let changedPower = !power || !savedPower;
    if (power && savedPower) {
      try {
        const proposed = power.refreshSource
          ? resources.find((point) => point.id === power.sourcePointId)
          : {
              ...pointInput(power),
              originalLongitude: Number(power.longitude),
              originalLatitude: Number(power.latitude),
              availableCapacityKw: numberOf(power.availableCapacityKw, '可用容量'),
              capacitySource: power.capacitySource.trim(),
              connectionNotes: power.connectionNotes.trim(),
            };
        changedPower =
          !proposed ||
          (
            [
              'name',
              'source',
              'coordinateSystem',
              'originalLongitude',
              'originalLatitude',
              'availableCapacityKw',
              'capacitySource',
              'connectionNotes',
            ] as const
          ).some((field) => proposed[field] !== savedPower.point[field]);
      } catch {
        changedPower = true;
      }
    }
    const connection = site.powerSourceId
      ? {
          powerSourceId: site.powerSourceId,
          availablePowerKw: site.availablePowerKw.trim() ? Number(site.availablePowerKw) : null,
          connectionInvestment: site.connectionInvestment.trim()
            ? Number(site.connectionInvestment)
            : null,
          notes: site.connectionNotes,
          confirmed: site.connectionConfirmed && !changedPower,
        }
      : null;
    return candidateSiteReadiness(
      { ...saved, siteConfirmed: site.siteConfirmed, connection },
      network,
    );
  }
  const draftConstraints = (() => {
    if (!draft) return null;
    try {
      return constraintsInput(draft);
    } catch {
      return null;
    }
  })();
  const constraintGaps =
    draft && draftConstraints
      ? sitingConstraintReadiness({
          ...scenario.context,
          stationNetwork: {
            ...network,
            fixedLayout: draft.fixedLayout,
            constraints: draftConstraints,
          },
        })
      : [];
  const shownSites =
    draft?.sites.filter(
      (site) =>
        site.name.toLowerCase().includes(search.toLowerCase()) &&
        (filter === 'all' ||
          (filter === 'confirmed'
            ? site.siteConfirmed
            : filter === 'formal'
              ? !draftSiteGaps(site).length &&
                !draft?.constraints.excludedSiteIds.includes(site.id ?? '')
              : filter === 'excluded'
                ? draft?.constraints.excludedSiteIds.includes(site.id ?? '')
                : !site.siteConfirmed)),
    ) ?? [];
  const markers = shownSites.map(mapPoint).filter((point): point is Point => !!point);
  return (
    <section className={styles.workspace} aria-label="方案人工固定站网">
      <div className={styles.heading}>
        <div>
          <h3>人工固定站网</h3>
          <p>先确认场地和接电关系，再选定站址与离散站型。</p>
        </div>
        <Button className="button" disabled={disabled} onClick={open}>
          维护人工固定站网
        </Button>
      </div>
      <div className={styles.summary} aria-label="站网确认进度">
        <span>{network.sites.length} 个候选</span>
        <span>{formalCandidateSites(network).length} 个正式候选</span>
        <span>{network.sites.filter((site) => site.siteConfirmed).length} 个场地已确认</span>
        <span>
          {network.sites.filter((site) => site.connection?.confirmed).length} 个接电已确认
        </span>
        <strong>{network.fixedLayout.length} 个固定站</strong>
      </div>
      {notice && (
        <p className={styles.feedback} role="status">
          <Check aria-hidden="true" />
          {notice}
        </p>
      )}
      <p className={styles.note}>
        新建站网资料；尚未运行车辆排程、共享供电或财务计算。未校验重卡限高、限重及货车限行。
      </p>
      {network.fixedLayout.length > 0 && (
        <ul className={styles.savedList} aria-label="已保存固定布局">
          {network.fixedLayout.map((selection) => (
            <li key={selection.siteId}>
              <strong>
                {network.sites.find((site) => site.id === selection.siteId)?.name ?? '站址已删除'}
              </strong>
              <span>
                {network.stationTypes.find((type) => type.id === selection.stationTypeId)?.name ??
                  '站型已删除'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {physical.length > 0 && (
        <details className={styles.gaps}>
          <summary>站网资料待完善 · {physical.length} 项</summary>
          <ul>
            {physical.map((gap, i) => (
              <li key={i}>{gap}</li>
            ))}
          </ul>
        </details>
      )}
      {financial.length > 0 && (
        <details className={styles.gaps}>
          <summary>财务价格待补 · {financial.length} 项</summary>
          <ul>
            {financial.map((gap, i) => (
              <li key={i}>{gap}</li>
            ))}
          </ul>
        </details>
      )}
      {draft && (
        <Dialog title="维护人工固定站网" wide onClose={close} error={error}>
          <div className={styles.editor}>
            <p className="helper">
              方案「{scenario.name}」 · 输入版本 {scenario.inputVersion} · 本次编辑基于修订{' '}
              {draft.revision}。新记录保存后可用于关联和确认。
            </p>
            <nav className={styles.tabs} aria-label="站网资料分区">
              {tabs.map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  aria-pressed={tab === value}
                  onClick={() => {
                    setTab(value);
                    setPreview(null);
                  }}
                  disabled={saving}
                >
                  {label}
                </Button>
              ))}
            </nav>
            <fieldset disabled={saving} className={styles.fields}>
              {tab === 'sites' && (
                <>
                  <div className={styles.generation}>
                    <div>
                      <h4>从业务点与电源提出初步候选</h4>
                      <p className="helper">
                        在已引入线路的业务位置和方案电源快照位置提出建议；相同坐标只建议一次。来源已生成时保留人工修正，不重复追加。几何位置不证明道路可达、场地可用或接电可行。
                      </p>
                    </div>
                    <Button
                      type="button"
                      className="button"
                      disabled={dirty || saving}
                      onClick={() => void generate()}
                    >
                      <Sparkles aria-hidden="true" />
                      生成并保存初步候选
                    </Button>
                    {dirty && <p className="helper">先保存当前站网草稿，再按已保存资料生成。</p>}
                    {!scenario.context.transportCycles?.length && !network.powerSources.length && (
                      <p className="helper">
                        先引入运输循环或在电源快照分区引入并保存电源；无需先准备道路。
                      </p>
                    )}
                    {generationNotice && (
                      <p role="status" className={styles.note}>
                        {generationNotice}
                      </p>
                    )}
                  </div>
                  <div className={styles.toolbar}>
                    <Button
                      type="button"
                      className="button"
                      onClick={() => setDraft({ ...draft, sites: [...draft.sites, blankSite()] })}
                    >
                      <Plus aria-hidden="true" />
                      新增候选站址
                    </Button>
                    <label className="field">
                      搜索站址
                      <Input value={search} onChange={(event) => setSearch(event.target.value)} />
                    </label>
                    <label className="field">
                      场地状态
                      <NativeSelect
                        aria-label="场地状态"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                      >
                        <option value="all">全部候选</option>
                        <option value="pending">待确认位置</option>
                        <option value="confirmed">已确认场地</option>
                        <option value="formal">正式候选</option>
                        <option value="excluded">禁选站址</option>
                      </NativeSelect>
                    </label>
                  </div>
                  <p className="helper">
                    筛选只改变列表和地图显示；持久禁选请到“选址约束”。新增或移动位置保存后，须为当前输入版本准备对应道路资料。
                  </p>
                  <p className="helper">
                    {moving
                      ? `正在移动「${draft.sites.find((site) => site.key === moving)?.name}」：点击地图或选择搜索地点。移动后须重新确认场地及接电。`
                      : '点击地图补充候选；选中下方“地图移动”后点击新位置。未保存的WGS84点须转换后才显示。'}
                    {moving && (
                      <Button type="button" className="text-button" onClick={() => setMoving(null)}>
                        取消移动
                      </Button>
                    )}
                  </p>
                  <div className={styles.map}>
                    <MapPanel
                      purpose="station"
                      config={config}
                      route={null}
                      library={markers}
                      markerLabels={Object.fromEntries(
                        shownSites.map((site) => [site.key, site.siteConfirmed ? '已' : '待']),
                      )}
                      onCandidate={candidate}
                      onLibraryPoint={(point) => setMoving(point.id)}
                    />
                  </div>
                  {!shownSites.length && (
                    <p className={styles.empty}>
                      {draft.sites.length
                        ? '没有匹配站址，请调整筛选。'
                        : '尚无候选站址。可在地图补点，或填写原始坐标。'}
                    </p>
                  )}
                  {shownSites.map((row) => {
                    const i = draft.sites.indexOf(row) + 1;
                    return (
                      <section key={row.key} className={styles.row} aria-label={`候选站址 ${i}`}>
                        <div className={styles.rowHeading}>
                          <h4>{row.name || `候选站址 ${i}`}</h4>
                          <span>
                            {row.siteConfirmed ? '已确认场地' : '待确认位置'} ·{' '}
                            {row.connectionConfirmed ? '接电已确认' : '接电待确认'}
                          </span>
                          <Button
                            type="button"
                            className="icon-button"
                            aria-label={`移除站址 ${i}`}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                sites: draft.sites.filter((item) => item.key !== row.key),
                                fixedLayout: draft.fixedLayout.filter(
                                  (selection) => selection.siteId !== row.id,
                                ),
                              })
                            }
                          >
                            <Trash2 />
                          </Button>
                        </div>
                        {row.generationBasis && (
                          <p className={styles.provenance}>
                            系统初步建议 ·{' '}
                            {row.generationBasis.origins.map((origin) => origin.label).join('；')}
                            。原始生成依据保留，当前位置可人工修正。
                          </p>
                        )}
                        <p className={styles.note}>
                          {draft.constraints.excludedSiteIds.includes(row.id ?? '')
                            ? '已禁选，不进入正式候选集'
                            : draftSiteGaps(row).length
                              ? `尚非正式候选：${draftSiteGaps(row).join('；')}`
                              : '正式候选：场地与供电关系已确认'}
                        </p>
                        <div className={styles.grid}>
                          <label className="field">
                            名称
                            <Input
                              aria-label={`站址 ${i} 名称`}
                              value={row.name}
                              onChange={(event) =>
                                updateSite(row.key, { name: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            原始经度
                            <Input
                              aria-label={`站址 ${i} 原始经度`}
                              value={row.longitude}
                              onChange={(event) =>
                                updateSite(row.key, { longitude: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            原始纬度
                            <Input
                              aria-label={`站址 ${i} 原始纬度`}
                              value={row.latitude}
                              onChange={(event) =>
                                updateSite(row.key, { latitude: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            坐标系
                            <NativeSelect
                              aria-label={`站址 ${i} 坐标系`}
                              value={row.coordinateSystem}
                              onChange={(event) =>
                                updateSite(row.key, {
                                  coordinateSystem: event.target.value as CoordinateSystem,
                                })
                              }
                            >
                              <option>GCJ-02</option>
                              <option>WGS84</option>
                            </NativeSelect>
                          </label>
                        </div>
                        <label className="field">
                          场地条件说明
                          <textarea
                            aria-label={`站址 ${i} 场地条件说明`}
                            value={row.siteNotes}
                            onChange={(event) =>
                              updateSite(row.key, { siteNotes: event.target.value })
                            }
                          />
                        </label>
                        <div className={styles.toolbar}>
                          <label className={styles.check}>
                            <input
                              type="checkbox"
                              aria-label={`站址 ${i} 确认场地`}
                              disabled={!row.id}
                              checked={row.siteConfirmed}
                              onChange={(event) =>
                                updateSite(row.key, { siteConfirmed: event.target.checked })
                              }
                            />
                            确认场地条件
                          </label>
                          <Button
                            className="button"
                            type="button"
                            onClick={() => setMoving(row.key)}
                          >
                            <MapPin aria-hidden="true" />
                            地图移动
                          </Button>
                        </div>
                        {!row.id && (
                          <p className="helper">新位置须先保存，再依据场地资料明确确认。</p>
                        )}
                        <div className={styles.grid}>
                          <label className="field">
                            唯一接电电源
                            <NativeSelect
                              aria-label={`站址 ${i} 接电电源`}
                              value={row.powerSourceId}
                              onChange={(event) =>
                                updateSite(row.key, { powerSourceId: event.target.value })
                              }
                            >
                              <option value="">尚未选择</option>
                              {draft.powers
                                .filter((power) => power.id)
                                .map((power) => (
                                  <option key={power.id} value={power.id}>
                                    {power.name} · {power.availableCapacityKw || '容量待补'} kW
                                  </option>
                                ))}
                              {row.powerSourceId &&
                                !draft.powers.some((power) => power.id === row.powerSourceId) && (
                                  <option value={row.powerSourceId}>电源已删除或不存在</option>
                                )}
                            </NativeSelect>
                          </label>
                          <label className="field">
                            可用功率（kW）
                            <Input
                              aria-label={`站址 ${i} 可用功率（kW）`}
                              value={row.availablePowerKw}
                              onChange={(event) =>
                                updateSite(row.key, { availablePowerKw: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            接电投资（元）
                            <Input
                              aria-label={`站址 ${i} 接电投资（元）`}
                              value={row.connectionInvestment}
                              onChange={(event) =>
                                updateSite(row.key, { connectionInvestment: event.target.value })
                              }
                              placeholder="待补"
                            />
                          </label>
                        </div>
                        <label className="field">
                          接电确认依据
                          <textarea
                            aria-label={`站址 ${i} 接电确认依据`}
                            value={row.connectionNotes}
                            onChange={(event) =>
                              updateSite(row.key, { connectionNotes: event.target.value })
                            }
                          />
                        </label>
                        <label className={styles.check}>
                          <input
                            type="checkbox"
                            aria-label={`站址 ${i} 确认接电关系`}
                            disabled={!row.id || !row.powerSourceId}
                            checked={row.connectionConfirmed}
                            onChange={(event) =>
                              updateSite(row.key, { connectionConfirmed: event.target.checked })
                            }
                          />
                          确认该场地可接此电源、可用功率及投资资料
                        </label>
                        <p className="helper">
                          修改场地、电源资料或接电依据后，保存会清除相关确认；再次核对原样资料后才能重新确认。投资留空会列为财务缺口。空间邻近不代表可接电。
                        </p>
                      </section>
                    );
                  })}
                </>
              )}
              {tab === 'types' && (
                <>
                  <div className={styles.toolbar}>
                    <Button
                      type="button"
                      className="button"
                      onClick={() => setDraft({ ...draft, types: [...draft.types, blankType()] })}
                    >
                      <Plus aria-hidden="true" />
                      新增站型
                    </Button>
                    <span className="helper">
                      统一电池：
                      {scenario.context.operations?.battery?.capacityKwh == null
                        ? '待配置'
                        : `${scenario.context.operations.battery.capacityKwh} kWh`}
                    </span>
                  </div>
                  {!draft.types.length && (
                    <p className={styles.empty}>
                      尚无站型。可保存参数不全的草案；参数齐备且关联当前统一电池后，才可用于新的固定布局。
                    </p>
                  )}
                  {draft.types.map((row, index) => (
                    <section className={styles.row} key={row.key}>
                      <div className={styles.rowHeading}>
                        <h4>站型 {index + 1}</h4>
                        <Button
                          type="button"
                          className="icon-button"
                          aria-label={`移除站型 ${index + 1}`}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              types: draft.types.filter((item) => item.key !== row.key),
                              fixedLayout: draft.fixedLayout.filter(
                                (selection) => selection.stationTypeId !== row.id,
                              ),
                            })
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                      <div className={styles.grid}>
                        <label className="field">
                          站型名称
                          <Input
                            aria-label={`站型 ${index + 1} 名称`}
                            value={row.name}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                types: draft.types.map((item) =>
                                  item.key === row.key
                                    ? { ...item, name: event.target.value }
                                    : item,
                                ),
                              })
                            }
                          />
                        </label>
                        {typeFields.map(([field, label]) => (
                          <label className="field" key={field}>
                            {label}
                            <Input
                              aria-label={`站型 ${index + 1} ${label}`}
                              value={row[field]}
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  types: draft.types.map((item) =>
                                    item.key === row.key
                                      ? { ...item, [field]: event.target.value }
                                      : item,
                                  ),
                                })
                              }
                            />
                          </label>
                        ))}
                        <label className="field">
                          服务窗口
                          <Input
                            aria-label={`站型 ${index + 1} 服务窗口`}
                            value={row.serviceWindows}
                            placeholder="06:00-18:00"
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                types: draft.types.map((item) =>
                                  item.key === row.key
                                    ? { ...item, serviceWindows: event.target.value }
                                    : item,
                                ),
                              })
                            }
                          />
                        </label>
                        <label className="field">
                          充电窗口
                          <Input
                            aria-label={`站型 ${index + 1} 充电窗口`}
                            value={row.chargeWindows}
                            placeholder="22:00-次日02:00"
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                types: draft.types.map((item) =>
                                  item.key === row.key
                                    ? { ...item, chargeWindows: event.target.value }
                                    : item,
                                ),
                              })
                            }
                          />
                        </label>
                      </div>
                      <p className="helper">
                        多个窗口用分号分隔，留空表示缺失，不代表全天；跨午夜须写“次日”。
                      </p>
                      <label className="field">
                        参数来源
                        <Input
                          aria-label={`站型 ${index + 1} 参数来源`}
                          value={row.source}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              types: draft.types.map((item) =>
                                item.key === row.key
                                  ? { ...item, source: event.target.value }
                                  : item,
                              ),
                            })
                          }
                        />
                      </label>
                      {row.id && (
                        <label className={styles.check}>
                          <input
                            type="checkbox"
                            checked={!!row.refreshBattery}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                types: draft.types.map((item) =>
                                  item.key === row.key
                                    ? { ...item, refreshBattery: event.target.checked }
                                    : item,
                                ),
                              })
                            }
                          />
                          显式重新关联当前统一电池
                        </label>
                      )}
                      {row.id && (
                        <p className={styles.gap}>
                          {stationTypeReadiness(
                            network.stationTypes.find((type) => type.id === row.id)!,
                            scenario.context.operations?.battery ?? null,
                          ).join('；') || '已保存站型物理参数齐备'}
                        </p>
                      )}
                    </section>
                  ))}
                </>
              )}
              {tab === 'powers' && (
                <>
                  <p className="helper">
                    从本项目电源引入独立快照。项目源自行修改或删除不会改写此方案；方案内编辑或显式引入更新会清除相关接电确认。
                  </p>
                  <div className={styles.toolbar}>
                    <label className="field">
                      项目电源
                      <NativeSelect
                        aria-label="选择项目电源"
                        value={resourceId}
                        onChange={(event) => setResourceId(event.target.value)}
                      >
                        <option value="">选择要引入的电源</option>
                        {resources
                          .filter(
                            (point) =>
                              !draft.powers.some((power) => power.sourcePointId === point.id),
                          )
                          .map((point) => (
                            <option key={point.id} value={point.id}>
                              {point.name} · {point.availableCapacityKw ?? '容量待补'} kW
                            </option>
                          ))}
                      </NativeSelect>
                    </label>
                    <Button
                      type="button"
                      className="button"
                      disabled={!resourceId || loadingResources}
                      onClick={() => {
                        const point = resources.find((value) => value.id === resourceId);
                        if (!point) return;
                        setDraft({
                          ...draft,
                          powers: [
                            ...draft.powers,
                            {
                              ...pointDraft(point),
                              key: crypto.randomUUID(),
                              id: undefined,
                              sourcePointId: point.id,
                              availableCapacityKw: text(point.availableCapacityKw),
                              capacitySource: point.capacitySource,
                              connectionNotes: point.connectionNotes,
                              refreshSource: false,
                            },
                          ],
                        });
                        setResourceId('');
                      }}
                    >
                      引入电源快照
                    </Button>
                    <Button
                      type="button"
                      className="text-button"
                      disabled={loadingResources}
                      onClick={() => {
                        setLoadingResources(true);
                        setResourceError('');
                        setResourceReload((value) => value + 1);
                      }}
                    >
                      重新读取项目电源
                    </Button>
                  </div>
                  {loadingResources && <p role="status">正在读取项目电源…</p>}
                  {resourceError && <p role="alert">项目电源读取失败：{resourceError}</p>}
                  {!resources.length && !loadingResources && !resourceError && (
                    <p className={styles.empty}>
                      项目尚无电源，请在项目“电源接入点”维护源资料后再引入。
                    </p>
                  )}
                  {draft.powers.map((row, index) => (
                    <section className={styles.row} key={row.key}>
                      <div className={styles.rowHeading}>
                        <h4>{row.name}</h4>
                        <span>{row.id ? '方案内快照' : '保存后可关联站址'}</span>
                        <Button
                          type="button"
                          className="icon-button"
                          aria-label={`移除电源快照 ${index + 1}`}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              powers: draft.powers.filter((item) => item.key !== row.key),
                            })
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                      {row.id && (
                        <label className={styles.check}>
                          <input
                            type="checkbox"
                            aria-label={`电源 ${index + 1} 显式引入更新`}
                            checked={row.refreshSource}
                            onChange={(event) =>
                              updatePower(row.key, { refreshSource: event.target.checked })
                            }
                          />
                          显式引入项目源最新资料
                          {!resources.some((point) => point.id === row.sourcePointId) &&
                            '（源已删除或尚未读取，更新将失败）'}
                        </label>
                      )}
                      <fieldset disabled={!row.id || row.refreshSource}>
                        <div className={styles.grid}>
                          <label className="field">
                            名称
                            <Input
                              aria-label={`电源 ${index + 1} 名称`}
                              value={row.name}
                              onChange={(event) =>
                                updatePower(row.key, { name: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            原始经度
                            <Input
                              aria-label={`电源 ${index + 1} 原始经度`}
                              value={row.longitude}
                              onChange={(event) =>
                                updatePower(row.key, { longitude: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            原始纬度
                            <Input
                              aria-label={`电源 ${index + 1} 原始纬度`}
                              value={row.latitude}
                              onChange={(event) =>
                                updatePower(row.key, { latitude: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            坐标系
                            <NativeSelect
                              aria-label={`电源 ${index + 1} 坐标系`}
                              value={row.coordinateSystem}
                              onChange={(event) =>
                                updatePower(row.key, {
                                  coordinateSystem: event.target.value as CoordinateSystem,
                                })
                              }
                            >
                              <option>GCJ-02</option>
                              <option>WGS84</option>
                            </NativeSelect>
                          </label>
                          <label className="field">
                            可用容量（kW）
                            <Input
                              aria-label={`电源 ${index + 1} 可用容量（kW）`}
                              value={row.availableCapacityKw}
                              onChange={(event) =>
                                updatePower(row.key, { availableCapacityKw: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            容量来源
                            <Input
                              aria-label={`电源 ${index + 1} 容量来源`}
                              value={row.capacitySource}
                              onChange={(event) =>
                                updatePower(row.key, { capacitySource: event.target.value })
                              }
                            />
                          </label>
                        </div>
                        <label className="field">
                          接入资料说明
                          <textarea
                            aria-label={`电源 ${index + 1} 接入资料说明`}
                            value={row.connectionNotes}
                            onChange={(event) =>
                              updatePower(row.key, { connectionNotes: event.target.value })
                            }
                          />
                        </label>
                      </fieldset>
                    </section>
                  ))}
                </>
              )}
              {tab === 'constraints' && (
                <>
                  <h4>选址硬约束</h4>
                  <p className="helper">
                    留空表示不限制，0
                    表示上限为零。可保存冲突草稿以继续修复；新增固定布局选择和每日试算必须满足已启用约束。
                  </p>
                  <div className={styles.grid}>
                    <label className="field">
                      总新增投资上限（元）
                      <Input
                        aria-label="总新增投资上限（元）"
                        inputMode="decimal"
                        value={draft.constraints.maxInvestment}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            constraints: {
                              ...draft.constraints,
                              maxInvestment: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      新建站数上限
                      <Input
                        aria-label="新建站数上限"
                        inputMode="numeric"
                        value={draft.constraints.maxStations}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            constraints: { ...draft.constraints, maxStations: event.target.value },
                          })
                        }
                      />
                    </label>
                  </div>
                  <p className="helper">
                    投资按每个新建站的站型建站投资＋接电投资，逐项四舍五入至分后合计。建站投资需完整涵盖本站新建配置（含备电池等必要投入）；逐年现金流另行核对。启用预算前须补齐所有正式可选站址及可用站型的必要价格；年度运维费不计入新增投资。
                  </p>
                  {draft.sites.map((site) =>
                    site.id ? (
                      <div key={site.key} className={styles.layoutRow}>
                        <div>
                          <h4>{site.name}</h4>
                          <p className={styles.note}>
                            {draftSiteGaps(site).join('；') || '场地与接电已确认'}
                          </p>
                        </div>
                        <label className="field">
                          站址选择约束
                          <NativeSelect
                            aria-label={`选址约束 ${site.name}`}
                            value={
                              draft.constraints.requiredSiteIds.includes(site.id!)
                                ? 'required'
                                : draft.constraints.excludedSiteIds.includes(site.id!)
                                  ? 'excluded'
                                  : 'optional'
                            }
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                constraints: {
                                  ...draft.constraints,
                                  requiredSiteIds: [
                                    ...draft.constraints.requiredSiteIds.filter(
                                      (id) => id !== site.id,
                                    ),
                                    ...(event.target.value === 'required' ? [site.id!] : []),
                                  ],
                                  excludedSiteIds: [
                                    ...draft.constraints.excludedSiteIds.filter(
                                      (id) => id !== site.id,
                                    ),
                                    ...(event.target.value === 'excluded' ? [site.id!] : []),
                                  ],
                                },
                              })
                            }
                          >
                            <option value="optional">可选</option>
                            <option value="required">必选</option>
                            <option value="excluded">禁选</option>
                          </NativeSelect>
                        </label>
                      </div>
                    ) : (
                      <p key={site.key} className={styles.note}>
                        {site.name || '新候选'}：先保存取得站址身份，再设置必选或禁选。
                      </p>
                    ),
                  )}
                  {(['requiredSiteIds', 'excludedSiteIds'] as const).flatMap((field) =>
                    draft.constraints[field]
                      .filter((id) => !draft.sites.some((site) => site.id === id))
                      .map((id) => (
                        <div key={`${field}:${id}`} className={styles.layoutRow}>
                          <p className={styles.gap}>
                            {field === 'requiredSiteIds' ? '必选' : '禁选'}站址已删除（{id}
                            ），请修复约束。
                          </p>
                          <Button
                            type="button"
                            className="button"
                            onClick={() =>
                              setDraft({
                                ...draft,
                                constraints: {
                                  ...draft.constraints,
                                  [field]: draft.constraints[field].filter((item) => item !== id),
                                },
                              })
                            }
                          >
                            移除失效约束
                          </Button>
                        </div>
                      )),
                  )}
                  <section className={styles.constraintCheck} aria-label="选址约束核对">
                    <h4>选址约束核对</h4>
                    <p className="helper">
                      按已保存场地、接电及投资资料核对当前约束与布局；其他资料变更在保存时重新校验。
                    </p>
                    {!draftConstraints ? (
                      <p role="alert">请填写非负有效上限；站数须为整数。</p>
                    ) : constraintGaps.length ? (
                      <ul>
                        {constraintGaps.map((gap, i) => (
                          <li key={i}>{gap}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>当前约束与布局未发现冲突。</p>
                    )}
                  </section>
                </>
              )}
              {tab === 'layout' && (
                <>
                  <p className="helper">
                    仅正式候选可选入，禁选站址不能采用。每站选择一个已确认电源关系和一种离散站型；允许多站共用同一电源。新选择须先保存场地、接电确认与站型。价格缺失可保存，保留财务缺口。
                  </p>
                  {!network.sites.length && (
                    <p className={styles.empty}>先保存候选站址与站型，再选择固定布局。</p>
                  )}
                  {network.sites.map((site) => {
                    const selection = draft.fixedLayout.find((item) => item.siteId === site.id);
                    const gaps = candidateSiteReadiness(site, network);
                    return (
                      <section key={site.id} className={styles.layoutRow}>
                        <div>
                          <h4>{site.name}</h4>
                          <p className={gaps.length ? styles.gap : styles.note}>
                            {gaps.join('；') || '场地与接电已确认'}
                          </p>
                        </div>
                        <label className="field">
                          固定布局站型
                          <NativeSelect
                            aria-label={`固定布局 ${site.name} 站型`}
                            value={selection?.stationTypeId ?? ''}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                fixedLayout: [
                                  ...draft.fixedLayout.filter((item) => item.siteId !== site.id),
                                  ...(event.target.value
                                    ? [{ siteId: site.id, stationTypeId: event.target.value }]
                                    : []),
                                ],
                              })
                            }
                          >
                            <option value="">不选入</option>
                            {network.stationTypes.map((type) => (
                              <option value={type.id} key={type.id}>
                                {type.name}
                                {stationTypeReadiness(
                                  type,
                                  scenario.context.operations?.battery ?? null,
                                ).length
                                  ? ' · 待完善'
                                  : ''}
                              </option>
                            ))}
                            {selection &&
                              !network.stationTypes.some(
                                (type) => type.id === selection.stationTypeId,
                              ) && <option value={selection.stationTypeId}>站型已删除</option>}
                          </NativeSelect>
                        </label>
                      </section>
                    );
                  })}
                  {draft.fixedLayout
                    .filter(
                      (selection) => !network.sites.some((site) => site.id === selection.siteId),
                    )
                    .map((selection) => (
                      <div key={selection.siteId} className={styles.layoutRow}>
                        <p className={styles.gap}>固定布局站址已删除，请移除失效选择。</p>
                        <Button
                          type="button"
                          className="button"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              fixedLayout: draft.fixedLayout.filter(
                                (item) => item.siteId !== selection.siteId,
                              ),
                            })
                          }
                        >
                          移除失效选择
                        </Button>
                      </div>
                    ))}
                </>
              )}
              {(tab === 'sites' || tab === 'types') && (
                <details className={styles.paste}>
                  <summary>批量粘贴{tab === 'sites' ? '候选站址' : '站型'}</summary>
                  <p className="helper">
                    不含表头，列间用制表符分隔。
                    {tab === 'sites'
                      ? '顺序：名称、经度、纬度、坐标系、场地条件说明（可空）。'
                      : '顺序：名称、换电工位、换电分钟、电池库存、充电位、站内总充电功率上限、服务窗口、充电窗口、建站投资、年度运维费用、参数来源。'}
                    全部校验通过后加入未保存草稿。
                  </p>
                  <textarea
                    aria-label="粘贴站网表格"
                    rows={4}
                    value={paste}
                    onChange={(event) => {
                      setPaste(event.target.value);
                      setPreview(null);
                    }}
                  />
                  <Button
                    type="button"
                    className="button"
                    onClick={() => {
                      setPasteKind(tab);
                      inspectPaste(tab);
                    }}
                  >
                    校验粘贴内容
                  </Button>
                  {preview && (
                    <div className={styles.preview} aria-label="站网粘贴预览">
                      {preview.map((row) => (
                        <p className={row.error ? styles.gap : ''} key={row.line}>
                          第 {row.line} 行 · {row.error ?? row.value?.name}
                        </p>
                      ))}
                    </div>
                  )}
                  <Button
                    type="button"
                    className="button"
                    disabled={!preview?.length || preview.some((row) => row.error)}
                    onClick={() => {
                      if (!preview || preview.some((row) => !row.value)) return;
                      setDraft(
                        pasteKind === 'sites'
                          ? {
                              ...draft,
                              sites: [
                                ...draft.sites,
                                ...preview.map((row) => row.value as SiteDraft),
                              ],
                            }
                          : {
                              ...draft,
                              types: [
                                ...draft.types,
                                ...preview.map((row) => row.value as TypeDraft),
                              ],
                            },
                      );
                      setPaste('');
                      setPreview(null);
                    }}
                  >
                    加入站网草稿
                  </Button>
                </details>
              )}
            </fieldset>
            {discarding && (
              <div className={styles.discard} role="alert">
                <p>站网资料尚未保存，离开将放弃草稿。</p>
                <Button type="button" className="button" onClick={() => setDiscarding(false)}>
                  继续编辑
                </Button>
                <Button
                  type="button"
                  className="button"
                  onClick={() => {
                    setDraft(null);
                    setError('');
                  }}
                >
                  放弃站网草稿
                </Button>
              </div>
            )}
            <div className={`dialog-actions ${styles.footer}`}>
              <Button type="button" className="button" onClick={close} disabled={saving}>
                关闭
              </Button>
              <Button
                type="button"
                className="button primary"
                disabled={saving}
                onClick={() => void save()}
              >
                <Save aria-hidden="true" />
                {saving ? '正在保存…' : '保存全部站网资料'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
