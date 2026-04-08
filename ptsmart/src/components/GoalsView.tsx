import React, { useEffect, useMemo, useState } from 'react';
import {
  Target, TrendingUp, TrendingDown, AlertCircle, Loader2, RefreshCw,
  ChevronDown, ChevronRight, BarChart2, Calendar, Filter,
} from 'lucide-react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, LabelList, ReferenceLine,
} from 'recharts';
import { loadGoals, GoalRow } from '../lib/goalsLoader';
import { mapToCanal, mapToBU } from '../lib/goalsMapper';

// ── Types ──────────────────────────────────────────────────────────────────

interface MetricSet {
  investimento: number;
  leads: number;
  matriculas: number;
}

interface GoalActualRow {
  key: string;
  bu: string;
  canal?: string;
  meta: MetricSet;
  real: MetricSet;
}

type ViewMode = 'bu' | 'canal_bu';
type SortDir  = 'asc' | 'desc';
type SortCol  = 'meta_inv' | 'real_inv' | 'pct_inv' | 'meta_leads' | 'real_leads' | 'pct_leads' | 'meta_mat' | 'real_mat' | 'pct_mat' | 'cac_meta' | 'cac_real';
type KpiKey   = 'investimento' | 'leads' | 'matriculas';

// ── Helpers ────────────────────────────────────────────────────────────────

function safeNum(v: any): number {
  if (v === null || v === undefined || v === '' || v === '(not set)') return 0;
  const s = String(v).trim().replace(/\s/g, '');
  const n = parseFloat(s.includes(',') && s.includes('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function findField(keys: string[], ...candidates: string[]): string | undefined {
  for (const c of candidates) { const f = keys.find(k => k.toLowerCase() === c.toLowerCase()); if (f) return f; }
  for (const c of candidates) { const f = keys.find(k => k.toLowerCase().includes(c.toLowerCase())); if (f) return f; }
}

const parseLocalDate = (v: any): Date => {
  if (!v) return new Date(NaN);
  if (v instanceof Date) return v;
  return new Date(`${String(v).split('T')[0].split(' ')[0]}T00:00:00`);
};

const fmtBRL   = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const fmtInt   = (v: number) => v.toLocaleString('pt-BR');
const fmtCmpct = (v: number) => new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
const pct      = (real: number, meta: number): number | null => meta > 0 ? (real / meta) * 100 : null;

const KPI_CONFIG: Record<KpiKey, { label: string; color: string; isCurrency: boolean }> = {
  investimento: { label: 'Investimento',  color: '#3b82f6', isCurrency: true  },
  leads:        { label: 'MQL',           color: '#8b5cf6', isCurrency: false },
  matriculas:   { label: 'Matrículas',    color: '#10b981', isCurrency: false },
};

function formatKpiValue(kpi: KpiKey, v: number, compact = false): string {
  if (KPI_CONFIG[kpi].isCurrency) {
    if (compact) return `R$ ${fmtCmpct(v)}`;
    return fmtBRL(v);
  }
  return compact ? fmtCmpct(v) : fmtInt(Math.round(v));
}

// ── Gauge / DeltaBadge (existing) ─────────────────────────────────────────

function Gauge({ value }: { value: number | null }) {
  if (value == null) return <span style={{ color: '#a0a0c0', fontSize: 12 }}>—</span>;
  const capped  = Math.min(value, 150);
  const color   = value >= 90 ? '#10b981' : value >= 70 ? '#f59e0b' : '#ef4444';
  const textCol = value >= 90 ? '#065f46' : value >= 70 ? '#78350f' : '#7f1d1d';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
      <div style={{ width: 56, height: 5, background: 'rgba(255,255,255,0.1)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${(capped / 150) * 100}%`, background: color, borderRadius: 999, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, fontVariantNumeric: 'tabular-nums', minWidth: 44, textAlign: 'right', color: textCol }}>
        {value.toFixed(1)}%
      </span>
    </div>
  );
}

function DeltaBadge({ real, meta }: { real: number; meta: number }) {
  if (meta === 0) return null;
  const v = real - meta;
  if (Math.abs(v) < 1) return null;
  return v > 0
    ? <span style={{ marginLeft: 4, display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 10, color: '#065f46', background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 4, padding: '1px 5px' }}><TrendingUp style={{ width: 10, height: 10 }} />+{fmtInt(Math.round(v))}</span>
    : <span style={{ marginLeft: 4, display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 10, color: '#7f1d1d', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 4, padding: '1px 5px' }}><TrendingDown style={{ width: 10, height: 10 }} />{fmtInt(Math.round(v))}</span>;
}

// ── Aggregations ────────────────────────────────────────────────────────────

function aggregateActual(
  data: any[],
  availableKeys: string[],
  start: string,
  end: string,
): Map<string, MetricSet> {
  const map = new Map<string, MetricSet>();
  const dateField     = findField(availableKeys, 'data', 'date', 'created_at');
  const invField      = findField(availableKeys, 'investimento', 'investment', 'custo');
  const mqlField      = findField(availableKeys, 'mql', 'mqls');
  const matField      = findField(availableKeys, 'matriculas', 'matricula', 'matrículas');
  const platformField = findField(availableKeys, 'platform');
  const tipoField     = findField(availableKeys, 'tipo_campanha');
  const produtoField  = findField(availableKeys, 'produto');

  const sDate = start ? new Date(`${start}T00:00:00`) : null;
  const eDate = end   ? new Date(`${end}T23:59:59`)   : null;

  for (const d of data) {
    if (dateField && sDate && eDate) {
      const dd = parseLocalDate(d[dateField]);
      if (isNaN(dd.getTime()) || dd < sDate || dd > eDate) continue;
    }
    const bu    = mapToBU(d[produtoField ?? ''] ?? '');
    const canal = mapToCanal(d[platformField ?? ''] ?? '', d[tipoField ?? ''] ?? '');
    if (!bu) continue;

    if (!map.has(bu)) map.set(bu, { investimento: 0, leads: 0, matriculas: 0 });
    const buRow = map.get(bu)!;
    buRow.investimento += safeNum(d[invField ?? '']);
    buRow.leads        += safeNum(d[mqlField ?? '']);
    buRow.matriculas   += safeNum(d[matField ?? '']);

    const ck = `${bu} | ${canal}`;
    if (!map.has(ck)) map.set(ck, { investimento: 0, leads: 0, matriculas: 0 });
    const ckRow = map.get(ck)!;
    ckRow.investimento += safeNum(d[invField ?? '']);
    ckRow.leads        += safeNum(d[mqlField ?? '']);
    ckRow.matriculas   += safeNum(d[matField ?? '']);
  }

  return map;
}

function aggregateGoals(goals: GoalRow[], start: string, end: string): Map<string, MetricSet> {
  const map = new Map<string, MetricSet>();
  const sDate = start ? new Date(`${start}T00:00:00`) : null;
  const eDate = end   ? new Date(`${end}T23:59:59`)   : null;

  for (const g of goals) {
    const gd = new Date(`${g.date}T00:00:00`);
    if (sDate && gd < sDate) continue;
    if (eDate && gd > eDate) continue;
    if (!map.has(g.bu)) map.set(g.bu, { investimento: 0, leads: 0, matriculas: 0 });
    const buRow = map.get(g.bu)!;
    buRow.investimento += g.investimento;
    buRow.leads        += g.leads;
    buRow.matriculas   += g.matriculas;

    const ck = `${g.bu} | ${g.canal}`;
    if (!map.has(ck)) map.set(ck, { investimento: 0, leads: 0, matriculas: 0 });
    const ckRow = map.get(ck)!;
    ckRow.investimento += g.investimento;
    ckRow.leads        += g.leads;
    ckRow.matriculas   += g.matriculas;
  }

  return map;
}

// ── Daily chart data builder ───────────────────────────────────────────────

interface DailyChartRow {
  dateKey:    string;   // yyyy-MM-dd
  label:      string;   // dd/MMM
  real:       number;
  meta:       number;
  realAcum:   number;
  metaAcum:   number;
}

function buildDailyChartData(
  data: any[],
  goals: GoalRow[],
  availableKeys: string[],
  kpi: KpiKey,
  start: string,
  end: string,
  filteredBUs: string[],   // empty = all
): DailyChartRow[] {
  const dateField    = findField(availableKeys, 'data', 'date', 'created_at');
  const invField     = findField(availableKeys, 'investimento', 'investment', 'custo');
  const mqlField     = findField(availableKeys, 'mql', 'mqls');
  const matField     = findField(availableKeys, 'matriculas', 'matricula', 'matrículas');
  const produtoField = findField(availableKeys, 'produto');

  const sDate = start ? new Date(`${start}T00:00:00`) : null;
  const eDate = end   ? new Date(`${end}T23:59:59`)   : null;

  // Map real values per day
  const realMap: Record<string, number> = {};
  for (const d of data) {
    if (!dateField) continue;
    const dd = parseLocalDate(d[dateField]);
    if (isNaN(dd.getTime())) continue;
    if (sDate && dd < sDate) continue;
    if (eDate && dd > eDate) continue;

    const bu = mapToBU(d[produtoField ?? ''] ?? '');
    if (!bu) continue;
    if (filteredBUs.length > 0 && !filteredBUs.includes(bu)) continue;

    const dateKey = dd.toISOString().split('T')[0];
    if (!realMap[dateKey]) realMap[dateKey] = 0;
    if (kpi === 'investimento') realMap[dateKey] += safeNum(d[invField ?? '']);
    if (kpi === 'leads')        realMap[dateKey] += safeNum(d[mqlField ?? '']);
    if (kpi === 'matriculas')   realMap[dateKey] += safeNum(d[matField ?? '']);
  }

  // Map goal values per day — clipped by eDate to respect the user's filter
  const metaMap: Record<string, number> = {};
  for (const g of goals) {
    const gd = new Date(`${g.date}T00:00:00`);
    if (sDate && gd < sDate) continue;
    if (eDate && gd > eDate) continue;
    if (filteredBUs.length > 0 && !filteredBUs.includes(g.bu)) continue;
    if (!metaMap[g.date]) metaMap[g.date] = 0;
    metaMap[g.date] += kpi === 'investimento' ? g.investimento : kpi === 'leads' ? g.leads : g.matriculas;
  }

  // Build sorted date list (union of both)
  const allDates = Array.from(new Set([...Object.keys(realMap), ...Object.keys(metaMap)])).sort();

  let realAcum = 0;
  let metaAcum = 0;
  return allDates.map(dk => {
    const real = realMap[dk] ?? 0;
    const meta = metaMap[dk] ?? 0;
    realAcum += real;
    metaAcum += meta;

    const d = new Date(`${dk}T00:00:00`);
    const label = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

    return { dateKey: dk, label, real, meta, realAcum, metaAcum };
  });
}

// ── To-Go table builder ────────────────────────────────────────────────────

interface ToGoRow {
  date:       string;   // yyyy-MM-dd
  label:      string;
  isFuture:   boolean;
  // Orçamento original
  meta_inv: number; meta_leads: number; meta_mat: number;
  // Realizado
  real_inv: number; real_leads: number; real_mat: number;
  // To-Go ajustado (apenas datas futuras)
  togo_inv?: number; togo_leads?: number; togo_mat?: number;
}

function buildToGoTable(
  data: any[],
  goals: GoalRow[],
  availableKeys: string[],
  start: string,
  end: string,
  filteredBUs: string[],
  today: string,
): ToGoRow[] {
  const dateField    = findField(availableKeys, 'data', 'date', 'created_at');
  const invField     = findField(availableKeys, 'investimento', 'investment', 'custo');
  const mqlField     = findField(availableKeys, 'mql', 'mqls');
  const matField     = findField(availableKeys, 'matriculas', 'matricula', 'matrículas');
  const produtoField = findField(availableKeys, 'produto');

  const sDate = start ? new Date(`${start}T00:00:00`) : null;
  const eDate = end   ? new Date(`${end}T23:59:59`)   : null;

  // Real values per day — clipped by eDate (only past/present data)
  const realMap: Record<string, MetricSet> = {};
  for (const d of data) {
    if (!dateField) continue;
    const dd = parseLocalDate(d[dateField]);
    if (isNaN(dd.getTime())) continue;
    if (sDate && dd < sDate) continue;
    if (eDate && dd > eDate) continue;
    const bu = mapToBU(d[produtoField ?? ''] ?? '');
    if (!bu) continue;
    if (filteredBUs.length > 0 && !filteredBUs.includes(bu)) continue;
    const dk = dd.toISOString().split('T')[0];
    if (!realMap[dk]) realMap[dk] = { investimento: 0, leads: 0, matriculas: 0 };
    realMap[dk].investimento += safeNum(d[invField ?? '']);
    realMap[dk].leads        += safeNum(d[mqlField ?? '']);
    realMap[dk].matriculas   += safeNum(d[matField ?? '']);
  }

  // Goal values per day — NOT clipped by eDate so future dates are always present
  const metaMap: Record<string, MetricSet> = {};
  for (const g of goals) {
    const gd = new Date(`${g.date}T00:00:00`);
    if (sDate && gd < sDate) continue;
    // intentionally no eDate filter here — future meta days must appear
    if (filteredBUs.length > 0 && !filteredBUs.includes(g.bu)) continue;
    if (!metaMap[g.date]) metaMap[g.date] = { investimento: 0, leads: 0, matriculas: 0 };
    metaMap[g.date].investimento += g.investimento;
    metaMap[g.date].leads        += g.leads;
    metaMap[g.date].matriculas   += g.matriculas;
  }

  const allDates = Array.from(new Set([...Object.keys(realMap), ...Object.keys(metaMap)])).sort();

  // Calculate accumulated balance up to today
  let acumReal: MetricSet = { investimento: 0, leads: 0, matriculas: 0 };
  let acumMeta: MetricSet = { investimento: 0, leads: 0, matriculas: 0 };
  const pastDates   = allDates.filter(d => d <= today);
  const futureDates = allDates.filter(d => d > today);

  for (const dk of pastDates) {
    const r = realMap[dk] ?? { investimento: 0, leads: 0, matriculas: 0 };
    const m = metaMap[dk] ?? { investimento: 0, leads: 0, matriculas: 0 };
    acumReal.investimento += r.investimento;
    acumReal.leads        += r.leads;
    acumReal.matriculas   += r.matriculas;
    acumMeta.investimento += m.investimento;
    acumMeta.leads        += m.leads;
    acumMeta.matriculas   += m.matriculas;
  }

  // Saldo to-go = quanto falta para bater a meta total
  // Total meta
  const totalMeta: MetricSet = { investimento: 0, leads: 0, matriculas: 0 };
  for (const dk of allDates) {
    const m = metaMap[dk] ?? { investimento: 0, leads: 0, matriculas: 0 };
    totalMeta.investimento += m.investimento;
    totalMeta.leads        += m.leads;
    totalMeta.matriculas   += m.matriculas;
  }

  const saldo: MetricSet = {
    investimento: Math.max(0, totalMeta.investimento - acumReal.investimento),
    leads:        Math.max(0, totalMeta.leads        - acumReal.leads),
    matriculas:   Math.max(0, totalMeta.matriculas   - acumReal.matriculas),
  };

  // Total meta dos dias futuros (denominator for proportional distribution)
  const futureMeta: MetricSet = { investimento: 0, leads: 0, matriculas: 0 };
  for (const dk of futureDates) {
    const m = metaMap[dk] ?? { investimento: 0, leads: 0, matriculas: 0 };
    futureMeta.investimento += m.investimento;
    futureMeta.leads        += m.leads;
    futureMeta.matriculas   += m.matriculas;
  }

  return allDates.map(dk => {
    const isFuture = dk > today;
    const meta     = metaMap[dk] ?? { investimento: 0, leads: 0, matriculas: 0 };
    const real     = realMap[dk] ?? { investimento: 0, leads: 0, matriculas: 0 };
    const d        = new Date(`${dk}T00:00:00`);
    const label    = d.toLocaleDateString('pt-BR');

    const row: ToGoRow = {
      date: dk, label, isFuture,
      meta_inv: meta.investimento, meta_leads: meta.leads, meta_mat: meta.matriculas,
      real_inv: real.investimento, real_leads: real.leads, real_mat: real.matriculas,
    };

    if (isFuture) {
      // Proportional to-go: day's share of future total
      const shareInv    = futureMeta.investimento > 0 ? meta.investimento / futureMeta.investimento : 0;
      const shareLeads  = futureMeta.leads        > 0 ? meta.leads        / futureMeta.leads        : 0;
      const shareMat    = futureMeta.matriculas   > 0 ? meta.matriculas   / futureMeta.matriculas   : 0;
      row.togo_inv    = saldo.investimento * shareInv;
      row.togo_leads  = saldo.leads        * shareLeads;
      row.togo_mat    = saldo.matriculas   * shareMat;
    }

    return row;
  });
}

// ── Custom tooltip for charts ──────────────────────────────────────────────

function ChartTooltip({ active, payload, label, kpi, isAccum }: any) {
  if (!active || !payload?.length) return null;
  const cfg = KPI_CONFIG[kpi as KpiKey];
  return (
    <div style={{
      background: '#14141f', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 10, padding: '10px 14px', fontSize: 12, color: '#eeeef8',
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    }}>
      <div style={{ color: '#a0a0bc', marginBottom: 6, fontWeight: 600 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, display: 'inline-block' }} />
          <span style={{ color: '#c0c0d8' }}>{p.name}:</span>
          <span style={{ fontWeight: 700 }}>
            {cfg.isCurrency ? `R$ ${fmtCmpct(p.value)}` : fmtCmpct(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Sort helper ────────────────────────────────────────────────────────────

function getSort(row: GoalActualRow, col: SortCol): number {
  switch (col) {
    case 'meta_inv':   return row.meta.investimento;
    case 'real_inv':   return row.real.investimento;
    case 'pct_inv':    return row.meta.investimento > 0 ? row.real.investimento / row.meta.investimento : 0;
    case 'meta_leads': return row.meta.leads;
    case 'real_leads': return row.real.leads;
    case 'pct_leads':  return row.meta.leads > 0 ? row.real.leads / row.meta.leads : 0;
    case 'meta_mat':   return row.meta.matriculas;
    case 'real_mat':   return row.real.matriculas;
    case 'pct_mat':    return row.meta.matriculas > 0 ? row.real.matriculas / row.meta.matriculas : 0;
    case 'cac_meta':   return row.meta.matriculas > 0 ? row.meta.investimento / row.meta.matriculas : Infinity;
    case 'cac_real':   return row.real.matriculas > 0 ? row.real.investimento / row.real.matriculas : Infinity;
  }
}

// ── Main component ─────────────────────────────────────────────────────────

export function GoalsView({ data }: { data: any[] }) {
  const availableKeys = useMemo(() => data.length ? Object.keys(data[0]) : [], [data]);
  const today = useMemo(() => new Date().toISOString().split('T')[0], []);

  const { minDate, maxDate } = useMemo(() => {
    const df = findField(availableKeys, 'data', 'date', 'created_at');
    if (!df || !data.length) return { minDate: '', maxDate: '' };
    const dates = data.map(d => parseLocalDate(d[df])).filter(d => !isNaN(d.getTime()));
    if (!dates.length) return { minDate: '', maxDate: '' };
    return {
      minDate: new Date(dates.reduce((a, b) => a < b ? a : b)).toISOString().split('T')[0],
      maxDate: new Date(dates.reduce((a, b) => a > b ? a : b)).toISOString().split('T')[0],
    };
  }, [data, availableKeys]);

  // All unique BUs in the data
  const produtoField = useMemo(() => findField(availableKeys, 'produto'), [availableKeys]);
  const allBUsInData = useMemo(() => {
    if (!produtoField) return [] as string[];
    return Array.from(new Set(data.map(d => mapToBU(d[produtoField] ?? '')).filter(Boolean))).sort();
  }, [data, produtoField]);

  // Goals state
  const [goals, setGoals]       = useState<GoalRow[]>([]);
  const [goalsLoading, setGoalsLoading] = useState(false);
  const [goalsError, setGoalsError]     = useState('');

  // Shared filters
  const [start, setStart] = useState('');
  const [end, setEnd]     = useState('');

  // BU table state
  const [viewMode, setViewMode] = useState<ViewMode>('bu');
  const [expandedBUs, setExpandedBUs] = useState<Set<string>>(new Set());
  const [sortCol, setSortCol]   = useState<SortCol>('meta_mat');
  const [sortDir, setSortDir]   = useState<SortDir>('desc');

  // Chart section state
  const [chartKpi, setChartKpi]   = useState<KpiKey>('investimento');
  const [chartBUs, setChartBUs]   = useState<string[]>([]);   // empty = all

  // Max date across all goal rows — declared before useEffects that depend on it.
  // Used by buildToGoTable so future To-Go rows remain visible, and by the date
  // input upper bound so users can select future dates present in goals.
  const maxGoalDate = useMemo(() => {
    if (!goals.length) return '';
    return goals.map(g => g.date).reduce((a, b) => a > b ? a : b, '');
  }, [goals]);

  React.useEffect(() => { if (minDate && !start) setStart(minDate); }, [minDate]);
  // Initialize end to the greater of maxDate (real data) and maxGoalDate (goals)
  React.useEffect(() => {
    if (!end) {
      const upper = [maxDate, maxGoalDate].filter(Boolean).sort().at(-1) ?? '';
      if (upper) setEnd(upper);
    }
  }, [maxDate, maxGoalDate]);

  // The end date used for goal aggregations respects the user's filter.
  // buildToGoTable receives maxGoalDate separately so it can show future rows.
  const goalsEnd = end;

  const fetchGoals = async () => {
    setGoalsLoading(true); setGoalsError('');
    try { setGoals(await loadGoals()); }
    catch (e: any) { setGoalsError(e.message ?? 'Erro ao carregar metas.'); }
    finally { setGoalsLoading(false); }
  };
  useEffect(() => { fetchGoals(); }, []);

  // ── Aggregations ──────────────────────────────────────────────────────────

  const actualMap = useMemo(() => aggregateActual(data, availableKeys, start, end),           [data, availableKeys, start, end]);
  const goalMap   = useMemo(() => aggregateGoals(goals, start, goalsEnd),                     [goals, start, goalsEnd]);

  const allBUs = useMemo(() => {
    const s = new Set<string>();
    for (const k of actualMap.keys()) { if (!k.includes(' | ')) s.add(k); }
    for (const k of goalMap.keys())   { if (!k.includes(' | ')) s.add(k); }
    return Array.from(s).sort();
  }, [actualMap, goalMap]);

  const canalsPerBU = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (k: string) => {
      if (!k.includes(' | ')) return;
      const [bu, canal] = k.split(' | ');
      if (!m.has(bu)) m.set(bu, new Set());
      m.get(bu)!.add(canal);
    };
    for (const k of actualMap.keys()) add(k);
    for (const k of goalMap.keys())   add(k);
    return m;
  }, [actualMap, goalMap]);

  const buRows: GoalActualRow[] = useMemo(() =>
    allBUs.map(bu => ({
      key: bu, bu, canal: undefined,
      meta: goalMap.get(bu)   ?? { investimento: 0, leads: 0, matriculas: 0 },
      real: actualMap.get(bu) ?? { investimento: 0, leads: 0, matriculas: 0 },
    })), [allBUs, goalMap, actualMap]);

  const sortedBURows = useMemo(() =>
    [...buRows].sort((a, b) => {
      const va = getSort(a, sortCol), vb = getSort(b, sortCol);
      return sortDir === 'desc' ? vb - va : va - vb;
    }), [buRows, sortCol, sortDir]);

  const totals = useMemo(() => {
    const meta = { investimento: 0, leads: 0, matriculas: 0 };
    const real = { investimento: 0, leads: 0, matriculas: 0 };
    buRows.forEach(r => {
      meta.investimento += r.meta.investimento; meta.leads += r.meta.leads; meta.matriculas += r.meta.matriculas;
      real.investimento += r.real.investimento; real.leads += r.real.leads; real.matriculas += r.real.matriculas;
    });
    return { meta, real };
  }, [buRows]);

  // ── Chart data ────────────────────────────────────────────────────────────

  const dailyData = useMemo(() =>
    buildDailyChartData(data, goals, availableKeys, chartKpi, start, goalsEnd, chartBUs),
    [data, goals, availableKeys, chartKpi, start, goalsEnd, chartBUs]);

  // ── To-Go table ───────────────────────────────────────────────────────────

  const toGoRows = useMemo(() =>
    buildToGoTable(data, goals, availableKeys, start, maxGoalDate || end, chartBUs, today),
    [data, goals, availableKeys, start, end, maxGoalDate, chartBUs, today]);

  // ── Projections & pace ────────────────────────────────────────────────────

  const lastRealDataDate = useMemo(() => {
    const df = findField(availableKeys, 'data', 'date', 'created_at');
    if (!df || !data.length) return today;
    const dates = data.map(d => parseLocalDate(d[df])).filter(d => !isNaN(d.getTime()));
    if (!dates.length) return today;
    return new Date(Math.max(...dates.map(d => d.getTime()))).toISOString().split('T')[0];
  }, [data, availableKeys, today]);

  const projections = useMemo(() => {
    if (!totals.meta.investimento && !totals.meta.leads && !totals.meta.matriculas) return null;
    if (!start || !end) return null;

    const sDate = new Date(`${start}T00:00:00`);
    const eDate = new Date(`${(maxGoalDate || end)}T00:00:00`);
    const lastReal = new Date(`${lastRealDataDate}T00:00:00`);

    const totalDays = Math.max(1, Math.round((eDate.getTime() - sDate.getTime()) / 86400000) + 1);
    const elapsedDays = Math.max(1, Math.round((lastReal.getTime() - sDate.getTime()) / 86400000) + 1);
    const remainingDays = Math.max(0, Math.round((eDate.getTime() - lastReal.getTime()) / 86400000));

    const compute = (real: number, meta: number) => {
      const dailyPace = elapsedDays > 0 ? real / elapsedDays : 0;
      const projected = dailyPace * totalDays;
      const projectedPct = meta > 0 ? (projected / meta) * 100 : 0;
      const exceeded = real >= meta;
      const remaining = Math.max(0, meta - real);
      const dailyRequired = remainingDays > 0 ? remaining / remainingDays : 0;
      return { dailyPace, projected, projectedPct, exceeded, remaining, dailyRequired, remainingDays };
    };

    return {
      inv: compute(totals.real.investimento, totals.meta.investimento),
      leads: compute(totals.real.leads, totals.meta.leads),
      mat: compute(totals.real.matriculas, totals.meta.matriculas),
      lastRealDataDate,
      elapsedDays,
      remainingDays: Math.max(0, Math.round((eDate.getTime() - lastReal.getTime()) / 86400000)),
    };
  }, [totals, start, end, maxGoalDate, lastRealDataDate]);

  // ── Event handlers ────────────────────────────────────────────────────────

  const toggleSort   = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  };
  const toggleExpand = (bu: string) => setExpandedBUs(prev => {
    const next = new Set(prev); next.has(bu) ? next.delete(bu) : next.add(bu); return next;
  });
  const toggleBU = (bu: string) => setChartBUs(prev =>
    prev.includes(bu) ? prev.filter(b => b !== bu) : [...prev, bu]);

  const thCls = (col: SortCol) =>
    `px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide cursor-pointer select-none whitespace-nowrap transition-colors hover:text-indigo-700 ${sortCol === col ? 'text-indigo-700' : 'text-slate-500'}`;

  // ── Guard ─────────────────────────────────────────────────────────────────

  if (!data.length) return (
    <div style={{ background: 'var(--bg-surface)', borderRadius: 16, border: '1px solid var(--border-default)', padding: 48, textAlign: 'center', color: '#8888a8' }}>
      <Target style={{ width: 48, height: 48, margin: '0 auto 12px', opacity: 0.2 }} />
      <p>Nenhum dado disponível.</p>
    </div>
  );

  // ── Panel styles ──────────────────────────────────────────────────────────

  const panel: React.CSSProperties = {
    background: 'var(--bg-surface)', borderRadius: 16,
    border: '1px solid var(--border-default)',
    boxShadow: 'var(--shadow-sm)', overflow: 'hidden',
  };

  const sectionTitle = (icon: React.ReactNode, text: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
      <span style={{ color: 'var(--accent)' }}>{icon}</span>
      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>{text}</span>
    </div>
  );

  const selBtn = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: active ? '1px solid var(--accent)' : '1px solid var(--border-default)',
    background: active ? 'rgba(0,229,160,0.1)' : 'var(--bg-elevated)',
    color: active ? 'var(--accent)' : '#a0a0bc', transition: 'all 0.15s',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Shared filter bar ─────────────────────────────────────────────── */}
      <div style={{ ...panel, padding: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#a0a0bc', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>De</label>
            <input type="date" value={start} min={minDate} max={end || maxGoalDate || maxDate}
              onChange={e => setStart(e.target.value)}
              style={{ padding: '6px 10px', fontSize: 13, border: '1px solid var(--border-default)', borderRadius: 8, background: 'var(--bg-elevated)', color: 'var(--text-primary)', outline: 'none' }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#a0a0bc', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Até</label>
            <input type="date" value={end} min={start || minDate} max={maxGoalDate || maxDate}
              onChange={e => setEnd(e.target.value)}
              style={{ padding: '6px 10px', fontSize: 13, border: '1px solid var(--border-default)', borderRadius: 8, background: 'var(--bg-elevated)', color: 'var(--text-primary)', outline: 'none' }} />
          </div>

          {/* View toggle */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#a0a0bc', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Agrupamento</label>
            <div style={{ display: 'flex', borderRadius: 8, border: '1px solid var(--border-default)', overflow: 'hidden' }}>
              {(['bu', 'canal_bu'] as ViewMode[]).map(m => (
                <button key={m} onClick={() => setViewMode(m)}
                  style={{ padding: '6px 12px', fontSize: 13, cursor: 'pointer', transition: 'all 0.15s', border: 'none',
                    background: viewMode === m ? '#4f46e5' : 'var(--bg-elevated)',
                    color: viewMode === m ? '#fff' : '#a0a0bc', fontWeight: viewMode === m ? 600 : 400 }}>
                  {m === 'bu' ? 'Por BU' : 'Canal × BU'}
                </button>
              ))}
            </div>
          </div>

          {/* Goals status */}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {goalsLoading && <Loader2 style={{ width: 16, height: 16, color: '#818cf8' }} className="animate-spin" />}
            {goalsError && <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#ef4444' }}><AlertCircle style={{ width: 14, height: 14 }} />{goalsError}</span>}
            {!goalsLoading && !goalsError && goals.length > 0 && <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>✓ {goals.length} linhas de meta</span>}
            {!goalsLoading && !goalsError && goals.length === 0 && <span style={{ fontSize: 12, color: '#f59e0b' }}>Configure VITE_GOALS_CSV_URL</span>}
            <button onClick={fetchGoals} title="Recarregar metas"
              style={{ padding: 6, color: '#8888a8', background: 'transparent', border: '1px solid var(--border-default)', borderRadius: 8, cursor: 'pointer' }}>
              <RefreshCw style={{ width: 14, height: 14 }} />
            </button>
          </div>
        </div>
      </div>

      {/* ── Projection & Pace cards ────────────────────────────────────────── */}
      {projections && (
        <>
          {/* Last data date warning */}
          {lastRealDataDate < today && (
            <div style={{ ...panel, padding: '12px 16px', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertCircle style={{ width: 16, height: 16, color: '#f59e0b', flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: '#92400e' }}>
                Último dado real: <strong>{new Date(`${lastRealDataDate}T00:00:00`).toLocaleDateString('pt-BR')}</strong> — dados de {Math.round((new Date(today).getTime() - new Date(lastRealDataDate).getTime()) / 86400000)} dia(s) atrás. As projeções usam este ponto como referência.
              </span>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {([
              { label: 'Investimento', p: projections.inv, isCurrency: true },
              { label: 'MQL', p: projections.leads, isCurrency: false },
              { label: 'Matrículas', p: projections.mat, isCurrency: false },
            ] as const).map(({ label, p, isCurrency }) => {
              const fmtVal = (v: number) => isCurrency ? fmtBRL(v) : fmtInt(Math.round(v));
              const projColor = p.projectedPct >= 90 ? '#059669' : p.projectedPct >= 70 ? '#d97706' : '#dc2626';
              return (
                <div key={label} style={{ ...panel, padding: '14px 16px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#8888a8', marginBottom: 8 }}>{label}</div>
                  {p.exceeded ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: 'rgba(5,150,105,0.12)', color: '#059669' }}>META BATIDA</span>
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 12, color: '#a0a0bc', marginBottom: 4 }}>
                        Projeção: <strong style={{ color: projColor, fontSize: 14 }}>{p.projectedPct.toFixed(0)}%</strong> no ritmo atual
                      </div>
                      <div style={{ fontSize: 12, color: '#a0a0bc', marginBottom: 4 }}>
                        Falta: <strong style={{ color: 'var(--text-primary)' }}>{fmtVal(p.remaining)}</strong>
                      </div>
                      <div style={{ fontSize: 12, color: '#a0a0bc' }}>
                        Ritmo necessário: <strong style={{ color: p.dailyRequired > p.dailyPace * 1.3 ? '#dc2626' : 'var(--text-primary)' }}>{fmtVal(p.dailyRequired)}/dia</strong>
                        {p.dailyRequired > p.dailyPace * 1.3 && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: '#dc2626', fontWeight: 600 }}>
                            ({((p.dailyRequired / Math.max(p.dailyPace, 0.01)) * 100 - 100).toFixed(0)}% acima do ritmo atual)
                          </span>
                        )}
                      </div>
                    </>
                  )}
                  <div style={{ fontSize: 11, color: '#606080', marginTop: 6 }}>
                    {projections.remainingDays} dias restantes · ritmo atual: {fmtVal(p.dailyPace)}/dia
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── BU × Meta table ───────────────────────────────────────────────── */}
      <div style={panel}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          {sectionTitle(<Target style={{ width: 18, height: 18 }} />, 'Realizado vs. Meta — por BU')}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-hover)' }}>
                <th style={{ padding: '10px 12px', textAlign: 'left' }} rowSpan={2} />
                {[
                  ['Investimento', '#4f46e5', 3],
                  ['MQL',          '#7c3aed', 3],
                  ['Matrículas',   '#059669', 3],
                  ['CAC',          '#64748b', 2],
                ].map(([label, color, span]) => (
                  <th key={label as string} colSpan={span as number}
                    style={{ padding: '8px 12px', textAlign: 'center', fontSize: 11, fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '0.06em', color: color as string,
                      borderLeft: '1px solid var(--border-subtle)' }}>
                    {label as string}
                  </th>
                ))}
              </tr>
              <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-default)' }}>
                {[
                  ['meta_inv',   'Meta',      true ], ['real_inv',   'Realizado', false], ['pct_inv',    '% Ating.', false],
                  ['meta_leads', 'Meta',      true ], ['real_leads', 'Realizado', false], ['pct_leads',  '% Ating.', false],
                  ['meta_mat',   'Meta',      true ], ['real_mat',   'Realizado', false], ['pct_mat',    '% Ating.', false],
                  ['cac_meta',   'Meta',      true ], ['cac_real',   'Realizado', false],
                ].map(([col, label, border]) => (
                  <th key={col as string} onClick={() => toggleSort(col as SortCol)}
                    style={{ padding: '8px 10px', textAlign: 'right', fontSize: 10, fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '0.05em', cursor: 'pointer',
                      whiteSpace: 'nowrap', userSelect: 'none',
                      borderLeft: (border as boolean) ? '1px solid var(--border-subtle)' : undefined,
                      color: sortCol === col ? '#818cf8' : '#8888a8' }}>
                    {label as string} {sortCol === col ? (sortDir === 'desc' ? '↓' : '↑') : ''}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {sortedBURows.map((row, i) => {
                const pctInv  = pct(row.real.investimento, row.meta.investimento);
                const pctLead = pct(row.real.leads, row.meta.leads);
                const pctMat  = pct(row.real.matriculas, row.meta.matriculas);
                const cacMeta = row.meta.matriculas > 0 ? row.meta.investimento / row.meta.matriculas : null;
                const cacReal = row.real.matriculas > 0 ? row.real.investimento / row.real.matriculas : null;
                const isExpanded = expandedBUs.has(row.bu);
                const hasCanals  = (canalsPerBU.get(row.bu)?.size ?? 0) > 0;

                const rowBg = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)';

                return (
                  <React.Fragment key={row.bu}>
                    <tr style={{ background: rowBg, borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', minWidth: 180 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {hasCanals
                            ? <button onClick={() => toggleExpand(row.bu)} style={{ color: '#8888a8', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                                {isExpanded ? <ChevronDown style={{ width: 14, height: 14 }} /> : <ChevronRight style={{ width: 14, height: 14 }} />}
                              </button>
                            : <span style={{ width: 14 }} />}
                          {row.bu}
                        </div>
                      </td>
                      <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#a0a0bc', borderLeft: '1px solid var(--border-subtle)' }}>{fmtBRL(row.meta.investimento)}</td>
                      <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', fontWeight: 600 }}>
                        {fmtBRL(row.real.investimento)}<DeltaBadge real={row.real.investimento} meta={row.meta.investimento} />
                      </td>
                      <td style={{ padding: '10px 10px' }}><Gauge value={pctInv} /></td>
                      <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#a0a0bc', borderLeft: '1px solid var(--border-subtle)' }}>{fmtInt(Math.round(row.meta.leads))}</td>
                      <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', fontWeight: 600 }}>
                        {fmtInt(row.real.leads)}<DeltaBadge real={row.real.leads} meta={row.meta.leads} />
                      </td>
                      <td style={{ padding: '10px 10px' }}><Gauge value={pctLead} /></td>
                      <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#a0a0bc', borderLeft: '1px solid var(--border-subtle)' }}>{fmtInt(Math.round(row.meta.matriculas))}</td>
                      <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', fontWeight: 600 }}>
                        {fmtInt(row.real.matriculas)}<DeltaBadge real={row.real.matriculas} meta={row.meta.matriculas} />
                      </td>
                      <td style={{ padding: '10px 10px' }}><Gauge value={pctMat} /></td>
                      <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#a0a0bc', borderLeft: '1px solid var(--border-subtle)' }}>{cacMeta != null ? fmtBRL(cacMeta) : '—'}</td>
                      <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', fontWeight: 600 }}>{cacReal != null ? fmtBRL(cacReal) : '—'}</td>
                    </tr>
                    {isExpanded && Array.from(canalsPerBU.get(row.bu) ?? []).sort().map(canal => {
                      const ck     = `${row.bu} | ${canal}`;
                      const sm     = goalMap.get(ck)   ?? { investimento: 0, leads: 0, matriculas: 0 };
                      const sr     = actualMap.get(ck) ?? { investimento: 0, leads: 0, matriculas: 0 };
                      return (
                        <tr key={ck} style={{ background: 'rgba(129,140,248,0.04)', borderBottom: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '7px 10px 7px 32px', fontSize: 12, color: '#8888a8', whiteSpace: 'nowrap' }}>↳ {canal}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 12, color: '#8888a8', borderLeft: '1px solid var(--border-subtle)' }}>{fmtBRL(sm.investimento)}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>{fmtBRL(sr.investimento)}</td>
                          <td style={{ padding: '7px 10px' }}><Gauge value={pct(sr.investimento, sm.investimento)} /></td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 12, color: '#8888a8', borderLeft: '1px solid var(--border-subtle)' }}>{fmtInt(Math.round(sm.leads))}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>{fmtInt(sr.leads)}</td>
                          <td style={{ padding: '7px 10px' }}><Gauge value={pct(sr.leads, sm.leads)} /></td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 12, color: '#8888a8', borderLeft: '1px solid var(--border-subtle)' }}>{fmtInt(Math.round(sm.matriculas))}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>{fmtInt(sr.matriculas)}</td>
                          <td style={{ padding: '7px 10px' }}><Gauge value={pct(sr.matriculas, sm.matriculas)} /></td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 12, color: '#8888a8', borderLeft: '1px solid var(--border-subtle)' }}>{sm.matriculas > 0 ? fmtBRL(sm.investimento / sm.matriculas) : '—'}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>{sr.matriculas > 0 ? fmtBRL(sr.investimento / sr.matriculas) : '—'}</td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>

            <tfoot>
              <tr style={{ background: 'var(--bg-active)', borderTop: '2px solid var(--border-strong)' }}>
                <td style={{ padding: '10px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#a0a0bc', whiteSpace: 'nowrap' }}>
                  Total ({allBUs.length} BUs)
                </td>
                <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#a0a0bc', borderLeft: '1px solid var(--border-subtle)', fontWeight: 700 }}>{fmtBRL(totals.meta.investimento)}</td>
                <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', fontWeight: 700 }}>{fmtBRL(totals.real.investimento)}</td>
                <td style={{ padding: '10px 10px' }}><Gauge value={pct(totals.real.investimento, totals.meta.investimento)} /></td>
                <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#a0a0bc', borderLeft: '1px solid var(--border-subtle)', fontWeight: 700 }}>{fmtInt(Math.round(totals.meta.leads))}</td>
                <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', fontWeight: 700 }}>{fmtInt(totals.real.leads)}</td>
                <td style={{ padding: '10px 10px' }}><Gauge value={pct(totals.real.leads, totals.meta.leads)} /></td>
                <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#a0a0bc', borderLeft: '1px solid var(--border-subtle)', fontWeight: 700 }}>{fmtInt(Math.round(totals.meta.matriculas))}</td>
                <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', fontWeight: 700 }}>{fmtInt(totals.real.matriculas)}</td>
                <td style={{ padding: '10px 10px' }}><Gauge value={pct(totals.real.matriculas, totals.meta.matriculas)} /></td>
                <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#a0a0bc', borderLeft: '1px solid var(--border-subtle)', fontWeight: 700 }}>
                  {totals.meta.matriculas > 0 ? fmtBRL(totals.meta.investimento / totals.meta.matriculas) : '—'}
                </td>
                <td style={{ padding: '10px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', fontWeight: 700 }}>
                  {totals.real.matriculas > 0 ? fmtBRL(totals.real.investimento / totals.real.matriculas) : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* ── Charts section ────────────────────────────────────────────────── */}
      <div style={panel}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          {sectionTitle(<BarChart2 style={{ width: 18, height: 18 }} />, 'Evolutivo — Realizado vs. Meta')}

          {/* Chart filters */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
            {/* KPI selector */}
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#a0a0bc', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>KPI</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {(Object.keys(KPI_CONFIG) as KpiKey[]).map(k => (
                  <button key={k} onClick={() => setChartKpi(k)} style={selBtn(chartKpi === k)}>
                    {KPI_CONFIG[k].label}
                  </button>
                ))}
              </div>
            </div>

            {/* Produto filter */}
            {allBUsInData.length > 0 && (
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#a0a0bc', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  <Filter style={{ width: 10, height: 10, display: 'inline', marginRight: 4 }} />
                  Produto
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  <button onClick={() => setChartBUs([])} style={selBtn(chartBUs.length === 0)}>Todos</button>
                  {allBUsInData.map(bu => (
                    <button key={bu} onClick={() => toggleBU(bu)} style={selBtn(chartBUs.includes(bu))}>{bu}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {dailyData.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#8888a8', fontSize: 13 }}>Sem dados para o período selecionado.</div>
        ) : (
          <div style={{ padding: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

            {/* Chart 1 — Por período */}
            <div>
              <p style={{ fontSize: 12, fontWeight: 700, color: '#a0a0bc', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                🔥 Evolutivo — {KPI_CONFIG[chartKpi].label} vs. Meta (por período)
              </p>
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={dailyData} margin={{ top: 24, right: 12, left: 0, bottom: 20 }} barCategoryGap="28%">
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="label" axisLine={false} tickLine={false}
                    tick={{ fill: '#a0a0bc', fontSize: 10 }} dy={8} minTickGap={20} interval="preserveStartEnd" />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: '#a0a0bc', fontSize: 10 }}
                    tickFormatter={v => KPI_CONFIG[chartKpi].isCurrency ? `R$ ${fmtCmpct(v)}` : fmtCmpct(v)} width={60} />
                  <Tooltip content={<ChartTooltip kpi={chartKpi} />} />
                  <Legend wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                    formatter={v => <span style={{ color: '#c0c0d8' }}>{v}</span>} />
                  <Bar dataKey="real" name="Realizado" fill={KPI_CONFIG[chartKpi].color} radius={[3, 3, 0, 0]} opacity={0.85}>
                    <LabelList dataKey="real" position="top"
                      formatter={(v: number) => v > 0 ? (KPI_CONFIG[chartKpi].isCurrency ? `R$ ${fmtCmpct(v)}` : fmtCmpct(v)) : ''}
                      style={{ fill: '#c0c0d8', fontSize: 9, fontWeight: 600 }} />
                  </Bar>
                  <Line dataKey="meta" name="Meta" type="monotone" stroke="#1e1e2e" strokeWidth={2.5}
                    dot={false} activeDot={{ r: 4 }}>
                    <LabelList dataKey="meta" position="insideTopRight"
                      formatter={(v: number) => v > 0 ? (KPI_CONFIG[chartKpi].isCurrency ? `R$ ${fmtCmpct(v)}` : fmtCmpct(v)) : ''}
                      style={{ fill: '#1e1e2e', fontSize: 9, fontWeight: 700 }} />
                  </Line>
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Chart 2 — Acumulado */}
            <div>
              <p style={{ fontSize: 12, fontWeight: 700, color: '#a0a0bc', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                🔥 Evolutivo — {KPI_CONFIG[chartKpi].label} vs. Meta (Acumulado)
              </p>
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={dailyData} margin={{ top: 24, right: 12, left: 0, bottom: 20 }} barCategoryGap="28%">
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="label" axisLine={false} tickLine={false}
                    tick={{ fill: '#a0a0bc', fontSize: 10 }} dy={8} minTickGap={20} interval="preserveStartEnd" />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: '#a0a0bc', fontSize: 10 }}
                    tickFormatter={v => KPI_CONFIG[chartKpi].isCurrency ? `R$ ${fmtCmpct(v)}` : fmtCmpct(v)} width={60} />
                  <Tooltip content={<ChartTooltip kpi={chartKpi} isAccum />} />
                  <Legend wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                    formatter={v => <span style={{ color: '#c0c0d8' }}>{v}</span>} />
                  <Bar dataKey="realAcum" name="Inv. Real Acumulado" fill={KPI_CONFIG[chartKpi].color} radius={[3, 3, 0, 0]} opacity={0.75}>
                    <LabelList dataKey="realAcum" position="top"
                      formatter={(v: number) => v > 0 ? (KPI_CONFIG[chartKpi].isCurrency ? `R$ ${fmtCmpct(v)}` : fmtCmpct(v)) : ''}
                      style={{ fill: '#c0c0d8', fontSize: 9, fontWeight: 600 }} />
                  </Bar>
                  <Line dataKey="metaAcum" name="Inv. Meta Acumulado" type="monotone" stroke="#1e1e2e" strokeWidth={2.5}
                    dot={false} activeDot={{ r: 4 }}>
                    <LabelList dataKey="metaAcum" position="insideTopRight"
                      formatter={(v: number) => v > 0 ? (KPI_CONFIG[chartKpi].isCurrency ? `R$ ${fmtCmpct(v)}` : fmtCmpct(v)) : ''}
                      style={{ fill: '#1e1e2e', fontSize: 9, fontWeight: 700 }} />
                  </Line>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {/* ── To-Go KPI Table ───────────────────────────────────────────────── */}
      <div style={panel}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          {sectionTitle(<Calendar style={{ width: 18, height: 18 }} />, 'KPIs Dia a Dia — Orçamento, Realizado e Curva Ajustada To-Go')}
          <p style={{ fontSize: 12, color: '#8888a8', marginTop: 4 }}>
            Dias futuros mostram a <strong style={{ color: '#a0a0bc' }}>meta ajustada to-go</strong> — saldo restante distribuído proporcionalmente à curva de orçamento original.
          </p>
        </div>

        {toGoRows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: '#8888a8', fontSize: 13 }}>Sem dados para o período selecionado.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg-hover)', borderBottom: '1px solid var(--border-default)' }}>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#8888a8', whiteSpace: 'nowrap' }}>Data</th>
                  {/* Orçamento - Meta */}
                  <th colSpan={3} style={{ padding: '8px 12px', textAlign: 'center', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#4f46e5', borderLeft: '1px solid var(--border-subtle)' }}>Orçamento — Meta</th>
                  {/* Realizado */}
                  <th colSpan={3} style={{ padding: '8px 12px', textAlign: 'center', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--accent)', borderLeft: '1px solid var(--border-subtle)' }}>Realizado</th>
                  {/* Curva Ajustada To-Go */}
                  <th colSpan={3} style={{ padding: '8px 12px', textAlign: 'center', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#f59e0b', borderLeft: '1px solid var(--border-subtle)' }}>Curva Ajustada — To-Go</th>
                </tr>
                <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-default)' }}>
                  <th style={{ padding: '6px 12px' }} />
                  {['Investimento', 'MQL', 'Matrículas'].map(l => (
                    <th key={`m-${l}`} style={{ padding: '6px 10px', textAlign: 'right', fontSize: 10, fontWeight: 600, color: '#8888a8', borderLeft: l === 'Investimento' ? '1px solid var(--border-subtle)' : undefined }}>{l}</th>
                  ))}
                  {['Investimento', 'MQL', 'Matrículas'].map(l => (
                    <th key={`r-${l}`} style={{ padding: '6px 10px', textAlign: 'right', fontSize: 10, fontWeight: 600, color: '#8888a8', borderLeft: l === 'Investimento' ? '1px solid var(--border-subtle)' : undefined }}>{l}</th>
                  ))}
                  {['Investimento', 'MQL', 'Matrículas'].map(l => (
                    <th key={`t-${l}`} style={{ padding: '6px 10px', textAlign: 'right', fontSize: 10, fontWeight: 600, color: '#8888a8', borderLeft: l === 'Investimento' ? '1px solid var(--border-subtle)' : undefined }}>{l}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {toGoRows.map((row, i) => {
                  const isToday  = row.date === today;
                  const isFuture = row.isFuture;
                  const rowBg    = isToday  ? 'rgba(0,229,160,0.06)' :
                                   isFuture ? 'rgba(245,158,11,0.04)' :
                                   i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)';
                  const border   = isToday ? '1px solid rgba(0,229,160,0.2)' : '1px solid var(--border-subtle)';

                  return (
                    <tr key={row.date} style={{ background: rowBg, borderBottom: border }}>
                      <td style={{ padding: '8px 12px', fontWeight: isToday ? 800 : isFuture ? 600 : 400, color: isToday ? 'var(--accent)' : isFuture ? '#f59e0b' : 'var(--text-secondary)', whiteSpace: 'nowrap', fontSize: 12 }}>
                        {row.label}{isToday ? ' ← hoje' : ''}
                      </td>
                      {/* Meta */}
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#a0a0bc', borderLeft: '1px solid var(--border-subtle)' }}>{fmtBRL(row.meta_inv)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#a0a0bc' }}>{fmtInt(Math.round(row.meta_leads))}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#a0a0bc' }}>{fmtInt(Math.round(row.meta_mat))}</td>
                      {/* Real */}
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: isFuture ? '#444460' : 'var(--text-primary)', fontWeight: 600, borderLeft: '1px solid var(--border-subtle)' }}>
                        {isFuture ? '—' : fmtBRL(row.real_inv)}
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: isFuture ? '#444460' : 'var(--text-primary)', fontWeight: 600 }}>
                        {isFuture ? '—' : fmtInt(Math.round(row.real_leads))}
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: isFuture ? '#444460' : 'var(--text-primary)', fontWeight: 600 }}>
                        {isFuture ? '—' : fmtInt(Math.round(row.real_mat))}
                      </td>
                      {/* To-Go (apenas futuro) */}
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', borderLeft: '1px solid var(--border-subtle)',
                        color: isFuture ? '#f59e0b' : '#444460', fontWeight: isFuture ? 700 : 400 }}>
                        {isFuture && row.togo_inv != null ? fmtBRL(row.togo_inv) : '—'}
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        color: isFuture ? '#f59e0b' : '#444460', fontWeight: isFuture ? 700 : 400 }}>
                        {isFuture && row.togo_leads != null ? fmtInt(Math.round(row.togo_leads)) : '—'}
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        color: isFuture ? '#f59e0b' : '#444460', fontWeight: isFuture ? 700 : 400 }}>
                        {isFuture && row.togo_mat != null ? fmtInt(Math.round(row.togo_mat)) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p style={{ fontSize: 11, color: '#606080', textAlign: 'right' }}>
        Metas via Google Sheets (VITE_GOALS_CSV_URL) · Realizado via Supabase ·
        MQL = coluna <code style={{ background: 'rgba(255,255,255,0.07)', padding: '1px 5px', borderRadius: 4, color: 'var(--accent)', fontSize: '0.85em' }}>mqls/mql</code>
      </p>
    </div>
  );
}
