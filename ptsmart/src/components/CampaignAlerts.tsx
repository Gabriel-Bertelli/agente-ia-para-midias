import React, { useMemo, useState } from 'react';
import {
  AlertTriangle, TrendingUp, TrendingDown, ChevronDown, ChevronRight,
  Bell, Filter, SlidersHorizontal, Info,
} from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, Legend,
} from 'recharts';

// ── Types ──────────────────────────────────────────────────────────────────

type AlertLevel = 'critical' | 'warning' | 'info';

interface DayBucket {
  date:  string;   // yyyy-MM-dd
  label: string;   // dd/MM
  inv:   number;
}

interface CampaignAlert {
  campaign:      string;
  tipo:          string;
  produto:       string;
  platform:      string;
  avg7:          number;   // média últimos 7 dias
  avg60:         number;   // média últimos 60 dias
  delta:         number;   // (avg7 - avg60) / avg60  em %
  level:         AlertLevel;
  direction:     'up' | 'down';
  totalInv7:     number;
  totalInv60:    number;
  history:       DayBucket[];  // últimos 60 dias dia a dia
}

type SortKey = 'delta' | 'avg7' | 'avg60' | 'campaign';
type SortDir = 'asc' | 'desc';

// ── Config ─────────────────────────────────────────────────────────────────

// Thresholds: delta (%) que classifica o alerta
const THRESHOLD_CRITICAL = 60;   // > ±60 % → crítico
const THRESHOLD_WARNING  = 30;   // > ±30 % → aviso
// < 30% → info (só aparece se flag informacional ligada)

const WINDOW_SHORT = 7;
const WINDOW_LONG  = 60;

// Min investment nos últimos 60 dias para entrar no radar
const MIN_INV_60 = 500;

// ── Helpers ─────────────────────────────────────────────────────────────────

const parseLocalDate = (v: any): Date => {
  if (!v) return new Date(NaN);
  if (v instanceof Date) return v;
  return new Date(`${String(v).split('T')[0].split(' ')[0]}T00:00:00`);
};

function safeNum(v: any): number {
  if (v === null || v === undefined || v === '' || v === '(not set)') return 0;
  const s = String(v).trim().replace(/\s/g, '');
  const n = parseFloat(
    s.includes(',') && s.includes('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(',', '.')
  );
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function findField(keys: string[], ...candidates: string[]): string | undefined {
  for (const c of candidates) {
    const f = keys.find(k => k.toLowerCase() === c.toLowerCase());
    if (f) return f;
  }
  for (const c of candidates) {
    const f = keys.find(k => k.toLowerCase().includes(c.toLowerCase()));
    if (f) return f;
  }
}

const fmtBRL    = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const fmtCmpct  = (v: number) => new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
const fmtPct    = (v: number, sign = true) => `${sign && v > 0 ? '+' : ''}${v.toFixed(1)}%`;

function levelColor(level: AlertLevel): string {
  if (level === 'critical') return '#ef4444';
  if (level === 'warning')  return '#f59e0b';
  return '#3b82f6';
}
function levelBg(level: AlertLevel): string {
  if (level === 'critical') return 'rgba(239,68,68,0.08)';
  if (level === 'warning')  return 'rgba(245,158,11,0.08)';
  return 'rgba(59,130,246,0.07)';
}
function levelLabel(level: AlertLevel): string {
  if (level === 'critical') return 'Crítico';
  if (level === 'warning')  return 'Alerta';
  return 'Informação';
}

function getLevel(delta: number): AlertLevel | null {
  const abs = Math.abs(delta);
  if (abs >= THRESHOLD_CRITICAL) return 'critical';
  if (abs >= THRESHOLD_WARNING)  return 'warning';
  return null;  // below threshold — not an alert
}

// ── Core algorithm ──────────────────────────────────────────────────────────

function buildAlerts(data: any[], availableKeys: string[]): CampaignAlert[] {
  if (!data.length) return [];

  const dateField     = findField(availableKeys, 'data', 'date', 'created_at');
  const invField      = findField(availableKeys, 'investimento', 'investment', 'custo');
  const campaignField = findField(availableKeys, 'campaign_name');
  const tipoField     = findField(availableKeys, 'tipo_campanha');
  const produtoField  = findField(availableKeys, 'produto');
  const platformField = findField(availableKeys, 'platform');

  if (!dateField || !invField || !campaignField) return [];

  // Reference point = most recent date in the dataset
  let maxDate = new Date(0);
  for (const d of data) {
    const dd = parseLocalDate(d[dateField]);
    if (!isNaN(dd.getTime()) && dd > maxDate) maxDate = dd;
  }
  if (maxDate.getTime() === 0) return [];

  const cutoff7  = new Date(maxDate); cutoff7.setDate(cutoff7.getDate() - WINDOW_SHORT + 1);
  const cutoff60 = new Date(maxDate); cutoff60.setDate(cutoff60.getDate() - WINDOW_LONG  + 1);

  // Group: campaign → date → { inv, tipo, produto, platform }
  type CampaignBucket = {
    byDate: Record<string, number>;
    tipo: string; produto: string; platform: string;
  };
  const grouped = new Map<string, CampaignBucket>();

  for (const d of data) {
    const dd = parseLocalDate(d[dateField]);
    if (isNaN(dd.getTime()) || dd < cutoff60) continue;

    const campaign = String(d[campaignField] ?? '').trim();
    if (!campaign) continue;

    const dk  = dd.toISOString().split('T')[0];
    const inv = safeNum(d[invField]);

    if (!grouped.has(campaign)) {
      grouped.set(campaign, {
        byDate:   {},
        tipo:     String(d[tipoField     ?? ''] ?? ''),
        produto:  String(d[produtoField  ?? ''] ?? ''),
        platform: String(d[platformField ?? ''] ?? ''),
      });
    }
    const bucket = grouped.get(campaign)!;
    bucket.byDate[dk] = (bucket.byDate[dk] ?? 0) + inv;
  }

  const alerts: CampaignAlert[] = [];

  for (const [campaign, { byDate, tipo, produto, platform }] of grouped) {
    // Build sorted day list within the 60-day window
    const allDays = Object.keys(byDate).sort();

    const days7  = allDays.filter(dk => dk >= cutoff7.toISOString().split('T')[0]);
    const days60 = allDays;

    const totalInv7  = days7.reduce((s, dk)  => s + byDate[dk], 0);
    const totalInv60 = days60.reduce((s, dk) => s + byDate[dk], 0);

    if (totalInv60 < MIN_INV_60) continue;  // too small — skip

    const avg7  = days7.length  > 0 ? totalInv7  / WINDOW_SHORT : 0;
    const avg60 = days60.length > 0 ? totalInv60 / WINDOW_LONG  : 0;

    if (avg60 === 0) continue;

    const delta     = ((avg7 - avg60) / avg60) * 100;
    const level     = getLevel(delta);
    if (!level) continue;   // within normal range

    const direction: 'up' | 'down' = delta >= 0 ? 'up' : 'down';

    // Build history for sparkline (last 60 days, filled with 0 for missing days)
    const history: DayBucket[] = [];
    let cur = new Date(cutoff60);
    while (cur <= maxDate) {
      const dk    = cur.toISOString().split('T')[0];
      const dObj  = new Date(`${dk}T00:00:00`);
      history.push({
        date:  dk,
        label: dObj.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        inv:   byDate[dk] ?? 0,
      });
      cur.setDate(cur.getDate() + 1);
    }

    alerts.push({ campaign, tipo, produto, platform, avg7, avg60, delta, level, direction, totalInv7, totalInv60, history });
  }

  return alerts;
}

// ── Sparkline tooltip ───────────────────────────────────────────────────────

function SparkTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#14141f', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#eeeef8' }}>
      <div style={{ color: '#a0a0bc', marginBottom: 4 }}>{label}</div>
      <div style={{ fontWeight: 700 }}>{fmtBRL(payload[0].value)}</div>
    </div>
  );
}

// ── AlertCard ──────────────────────────────────────────────────────────────

function AlertCard({ alert, expanded, onToggle }: {
  alert: CampaignAlert; expanded: boolean; onToggle: () => void;
}) {
  const color = levelColor(alert.level);
  const bg    = levelBg(alert.level);
  const cut7  = alert.history.slice(-WINDOW_SHORT);

  // Reference lines for the sparkline
  const avg7LineData  = alert.history.map(h => ({ ...h, avg7: alert.avg7 }));
  const avg60LineData = alert.history.map(h => ({ ...h, avg60: alert.avg60 }));

  return (
    <div style={{
      border: `1px solid ${color}30`,
      borderLeft: `4px solid ${color}`,
      borderRadius: 12,
      background: bg,
      overflow: 'hidden',
      transition: 'box-shadow 0.2s',
    }}>
      {/* ── Header row ── */}
      <div
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', cursor: 'pointer' }}
      >
        {/* Alert icon */}
        <div style={{
          width: 36, height: 36, borderRadius: '50%', background: `${color}18`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          {alert.direction === 'up'
            ? <TrendingUp  style={{ width: 18, height: 18, color }} />
            : <TrendingDown style={{ width: 18, height: 18, color }} />}
        </div>

        {/* Campaign name + tags */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {alert.campaign}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            {[alert.produto, alert.tipo, alert.platform].filter(Boolean).map(tag => (
              <span key={tag} style={{ fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 99, background: 'rgba(255,255,255,0.07)', color: '#a0a0bc', border: '1px solid var(--border-subtle)' }}>
                {tag}
              </span>
            ))}
          </div>
        </div>

        {/* Level badge */}
        <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 99, background: `${color}18`, color, border: `1px solid ${color}30`, whiteSpace: 'nowrap' }}>
          {levelLabel(alert.level)}
        </span>

        {/* Delta pill */}
        <div style={{ textAlign: 'right', minWidth: 90 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color, fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}>
            {fmtPct(alert.delta)}
          </div>
          <div style={{ fontSize: 10, color: '#8888a8', marginTop: 2 }}>vs. média 60d</div>
        </div>

        {/* Avg values */}
        <div style={{ textAlign: 'right', minWidth: 120, display: 'none' }} className="md-show">
          <div style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 700 }}>{fmtBRL(alert.avg7)}<span style={{ fontSize: 10, color: '#8888a8', fontWeight: 400 }}>/dia (7d)</span></div>
          <div style={{ fontSize: 12, color: '#8888a8' }}>{fmtBRL(alert.avg60)}<span style={{ fontSize: 10 }}>/dia (60d)</span></div>
        </div>

        {/* Expand toggle */}
        <div style={{ flexShrink: 0, color: '#8888a8' }}>
          {expanded ? <ChevronDown style={{ width: 16, height: 16 }} /> : <ChevronRight style={{ width: 16, height: 16 }} />}
        </div>
      </div>

      {/* ── Expanded detail ── */}
      {expanded && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--border-subtle)' }}>

          {/* KPI summary row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, margin: '14px 0' }}>
            {[
              { label: 'Méd. diária 7d',  value: fmtBRL(alert.avg7),  highlight: true  },
              { label: 'Méd. diária 60d', value: fmtBRL(alert.avg60), highlight: false },
              { label: 'Total inv. 7d',   value: fmtBRL(alert.totalInv7),  highlight: false },
              { label: 'Total inv. 60d',  value: fmtBRL(alert.totalInv60), highlight: false },
            ].map(({ label, value, highlight }) => (
              <div key={label} style={{
                background: 'var(--bg-elevated)', borderRadius: 10,
                padding: '10px 12px', border: '1px solid var(--border-default)',
              }}>
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#8888a8', marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: highlight ? color : 'var(--text-primary)', fontFamily: 'var(--font-display)' }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Sparkline — 60 days */}
          <div style={{ marginTop: 4 }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: '#8888a8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
              Evolução de investimento — últimos 60 dias
            </p>
            <ResponsiveContainer width="100%" height={160}>
              <ComposedChart data={alert.history} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="label" tick={{ fill: '#8888a8', fontSize: 9 }} axisLine={false} tickLine={false}
                  minTickGap={24} interval="preserveStartEnd" />
                <YAxis tick={{ fill: '#8888a8', fontSize: 9 }} axisLine={false} tickLine={false}
                  tickFormatter={v => `R$ ${fmtCmpct(v)}`} width={56} />
                <Tooltip content={<SparkTooltip />} />
                {/* Shading for 7d window */}
                {alert.history.length >= WINDOW_SHORT && (() => {
                  const start7 = alert.history[alert.history.length - WINDOW_SHORT]?.label;
                  return <ReferenceLine x={start7} stroke={color} strokeDasharray="4 2" strokeWidth={1.5} label={{ value: '7d', fill: color, fontSize: 9, position: 'insideTopRight' }} />;
                })()}
                <Bar dataKey="inv" name="Investimento" fill={color} opacity={0.7} radius={[2, 2, 0, 0]} />
                <Line dataKey="avg60" name="Méd. 60d" dot={false} stroke="#a0a0bc" strokeWidth={1.5} strokeDasharray="5 3" legendType="line" />
                <Line dataKey="avg7" name="Méd. 7d" dot={false} stroke={color} strokeWidth={2} legendType="line" />
                <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} formatter={v => <span style={{ color: '#c0c0d8' }}>{v}</span>} />
              </ComposedChart>
            </ResponsiveContainer>
            {/* Inject avg7/avg60 as constant lines */}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function CampaignAlerts({ data }: { data: any[] }) {
  const availableKeys = useMemo(() => data.length ? Object.keys(data[0]) : [], [data]);

  // Unique filter options
  const produtoField  = useMemo(() => findField(availableKeys, 'produto'),       [availableKeys]);
  const tipoField     = useMemo(() => findField(availableKeys, 'tipo_campanha'), [availableKeys]);
  const platformField = useMemo(() => findField(availableKeys, 'platform'),      [availableKeys]);

  const produtos   = useMemo(() => Array.from(new Set(data.map(d => String(d[produtoField   ?? ''] ?? '')).filter(Boolean))).sort(), [data, produtoField]);
  const tipos      = useMemo(() => Array.from(new Set(data.map(d => String(d[tipoField      ?? ''] ?? '')).filter(Boolean))).sort(), [data, tipoField]);
  const platforms  = useMemo(() => Array.from(new Set(data.map(d => String(d[platformField  ?? ''] ?? '')).filter(Boolean))).sort(), [data, platformField]);

  // Filters
  const [filterProduto,  setFilterProduto]  = useState('');
  const [filterTipo,     setFilterTipo]     = useState('');
  const [filterPlatform, setFilterPlatform] = useState('');
  const [showInfo,       setShowInfo]       = useState(false);
  const [sortKey,        setSortKey]        = useState<SortKey>('delta');
  const [sortDir,        setSortDir]        = useState<SortDir>('desc');
  const [expandedIds,    setExpandedIds]    = useState<Set<string>>(new Set());
  const [search,         setSearch]         = useState('');
  const [threshold,      setThreshold]      = useState(THRESHOLD_WARNING);

  // Build all alerts from raw data (memoized — expensive op)
  const allAlerts = useMemo(() => buildAlerts(data, availableKeys), [data, availableKeys]);

  // Apply filters
  const filtered = useMemo(() => {
    return allAlerts
      .filter(a => {
        if (filterProduto  && a.produto  !== filterProduto)  return false;
        if (filterTipo     && a.tipo     !== filterTipo)     return false;
        if (filterPlatform && a.platform !== filterPlatform) return false;
        if (!showInfo && a.level === 'info')                 return false;
        if (Math.abs(a.delta) < threshold)                   return false;
        if (search && !a.campaign.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => {
        let va: number, vb: number;
        if (sortKey === 'campaign') {
          return sortDir === 'asc'
            ? a.campaign.localeCompare(b.campaign)
            : b.campaign.localeCompare(a.campaign);
        }
        va = sortKey === 'delta' ? Math.abs(a.delta) : sortKey === 'avg7' ? a.avg7 : a.avg60;
        vb = sortKey === 'delta' ? Math.abs(b.delta) : sortKey === 'avg7' ? b.avg7 : b.avg60;
        return sortDir === 'desc' ? vb - va : va - vb;
      });
  }, [allAlerts, filterProduto, filterTipo, filterPlatform, showInfo, threshold, search, sortKey, sortDir]);

  const counts = useMemo(() => ({
    critical: allAlerts.filter(a => a.level === 'critical').length,
    warning:  allAlerts.filter(a => a.level === 'warning').length,
    total:    allAlerts.length,
  }), [allAlerts]);

  const toggleExpand = (id: string) => setExpandedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const panel: React.CSSProperties = {
    background: 'var(--bg-surface)', borderRadius: 16,
    border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)',
  };

  const selStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: active ? '1px solid var(--accent)' : '1px solid var(--border-default)',
    background: active ? 'rgba(0,229,160,0.1)' : 'var(--bg-elevated)',
    color: active ? 'var(--accent)' : '#a0a0bc', transition: 'all 0.15s',
  });

  if (!data.length) return (
    <div style={{ ...panel, padding: 48, textAlign: 'center', color: '#8888a8' }}>
      <Bell style={{ width: 48, height: 48, margin: '0 auto 12px', opacity: 0.2 }} />
      <p>Nenhum dado disponível.</p>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── Summary banner ──────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {[
          { label: 'Campanhas críticas',     count: counts.critical, color: '#ef4444', bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.25)'  },
          { label: 'Campanhas em alerta',    count: counts.warning,  color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)' },
          { label: 'Total monitoradas',      count: allAlerts.length, color: '#8888a8', bg: 'var(--bg-surface)',      border: 'var(--border-default)' },
        ].map(({ label, count, color, bg, border }) => (
          <div key={label} style={{ ...panel, padding: '16px 20px', background: bg, border: `1px solid ${border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#8888a8', marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color, fontFamily: 'var(--font-display)', letterSpacing: '-0.03em' }}>{count}</div>
          </div>
        ))}
      </div>

      {/* ── Filter bar ──────────────────────────────────────────────────── */}
      <div style={{ ...panel, padding: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>

          {/* Search */}
          <div style={{ flex: '1 1 200px', minWidth: 160 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#a0a0bc', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Buscar campanha</label>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="nome da campanha..."
              style={{ width: '100%', padding: '7px 12px', fontSize: 13, border: '1px solid var(--border-default)', borderRadius: 8, background: 'var(--bg-elevated)', color: 'var(--text-primary)', outline: 'none' }}
            />
          </div>

          {/* Threshold slider */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#a0a0bc', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              <SlidersHorizontal style={{ width: 10, height: 10, display: 'inline', marginRight: 4 }} />
              Sensibilidade — mín. {threshold}% de variação
            </label>
            <input
              type="range" min={10} max={100} step={5} value={threshold}
              onChange={e => setThreshold(Number(e.target.value))}
              style={{ width: 160, accentColor: 'var(--accent)' }}
            />
          </div>

          {/* Produto */}
          {produtos.length > 0 && (
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#a0a0bc', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Produto</label>
              <select value={filterProduto} onChange={e => setFilterProduto(e.target.value)}
                style={{ padding: '7px 10px', fontSize: 12, border: '1px solid var(--border-default)', borderRadius: 8, background: 'var(--bg-elevated)', color: 'var(--text-primary)', outline: 'none' }}>
                <option value="">Todos</option>
                {produtos.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          )}

          {/* Tipo campanha */}
          {tipos.length > 0 && (
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#a0a0bc', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Tipo</label>
              <select value={filterTipo} onChange={e => setFilterTipo(e.target.value)}
                style={{ padding: '7px 10px', fontSize: 12, border: '1px solid var(--border-default)', borderRadius: 8, background: 'var(--bg-elevated)', color: 'var(--text-primary)', outline: 'none' }}>
                <option value="">Todos</option>
                {tipos.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          )}

          {/* Platform */}
          {platforms.length > 0 && (
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#a0a0bc', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Plataforma</label>
              <select value={filterPlatform} onChange={e => setFilterPlatform(e.target.value)}
                style={{ padding: '7px 10px', fontSize: 12, border: '1px solid var(--border-default)', borderRadius: 8, background: 'var(--bg-elevated)', color: 'var(--text-primary)', outline: 'none' }}>
                <option value="">Todas</option>
                {platforms.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          )}

          {/* Sort */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#a0a0bc', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Ordenar</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {([['delta', '% Variação'], ['avg7', 'Méd. 7d'], ['avg60', 'Méd. 60d']] as [SortKey, string][]).map(([k, lbl]) => (
                <button key={k} onClick={() => { if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(k); setSortDir('desc'); } }}
                  style={selStyle(sortKey === k)}>
                  {lbl} {sortKey === k ? (sortDir === 'desc' ? '↓' : '↑') : ''}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Info box */}
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 8, background: 'rgba(129,140,248,0.07)', border: '1px solid rgba(129,140,248,0.15)' }}>
          <Info style={{ width: 14, height: 14, color: '#818cf8', marginTop: 1, flexShrink: 0 }} />
          <p style={{ fontSize: 12, color: '#a0a0bc', lineHeight: 1.5 }}>
            <strong style={{ color: '#c0c0d8' }}>Regra de alerta:</strong> compara a <strong style={{ color: '#c0c0d8' }}>média diária dos últimos 7 dias</strong> com a <strong style={{ color: '#c0c0d8' }}>média diária dos últimos 60 dias</strong> de investimento por campanha.
            Variação <span style={{ color: '#ef4444', fontWeight: 700 }}>≥ {THRESHOLD_CRITICAL}%</span> = Crítico &nbsp;·&nbsp;
            Variação <span style={{ color: '#f59e0b', fontWeight: 700 }}>≥ {THRESHOLD_WARNING}%</span> = Alerta.
            O threshold atual é <strong style={{ color: 'var(--accent)' }}>{threshold}%</strong>. Arraste para ajustar a sensibilidade.
          </p>
        </div>
      </div>

      {/* ── Alert list ──────────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div style={{ ...panel, padding: 48, textAlign: 'center', color: '#8888a8' }}>
          <AlertTriangle style={{ width: 40, height: 40, margin: '0 auto 12px', opacity: 0.2 }} />
          <p style={{ fontSize: 14 }}>Nenhuma campanha em alerta com os filtros atuais.</p>
          <p style={{ fontSize: 12, marginTop: 6 }}>
            {allAlerts.length > 0
              ? `${allAlerts.length} campanha(s) monitoradas — tente reduzir o threshold de sensibilidade.`
              : 'Verifique se há dados suficientes (mínimo 7 dias) na base carregada.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: '#8888a8', paddingLeft: 2 }}>
            {filtered.length} campanha(s) em alerta · clique para expandir o histórico
          </div>
          {filtered.map(alert => (
            <AlertCard
              key={alert.campaign}
              alert={alert}
              expanded={expandedIds.has(alert.campaign)}
              onToggle={() => toggleExpand(alert.campaign)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
