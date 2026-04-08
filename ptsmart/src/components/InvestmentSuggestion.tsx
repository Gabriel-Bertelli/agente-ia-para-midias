import React, { useMemo, useState } from 'react';
import { TrendingUp, TrendingDown, Minus, AlertCircle, DollarSign, Info,
  ChevronDown, ChevronUp, ChevronsUpDown, Filter, X } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────

interface CampaignMetrics {
  campaign: string;
  inv_current: number;
  inv_30d_total: number;
  cac_60d: number | null;
  cac_30d: number | null;
  cac_14d: number | null;
  cac_7d:  number | null;
  cac_weighted: number | null;
}

interface AllocationResult {
  campaign: string;
  inv_current: number;
  cac_weighted: number | null;
  inv_suggested: number;
  inv_min: number;
  inv_max: number;
  delta_pct: number;
  delta_abs: number;
  capped: boolean;
}

interface SuggestionResult {
  allocations: AllocationResult[];
  total_allocated: number;
  total_target: number;
  leftover: number;
  hit_limit: boolean;
  message: string | null;
}

type SortCol = 'campaign' | 'cac_60d' | 'cac_30d' | 'cac_14d' | 'cac_7d' |
               'cac_weighted' | 'inv_current' | 'inv_suggested' | 'delta_pct';
type SortDir = 'asc' | 'desc';

// ── Helpers ────────────────────────────────────────────────────────────────

const parseLocalDate = (v: any): Date => {
  if (!v) return new Date(NaN);
  if (v instanceof Date) return v;
  const s = String(v).split('T')[0].split(' ')[0];
  return new Date(`${s}T00:00:00`);
};

function safeNum(v: any): number {
  if (v === null || v === undefined || v === '' || v === '(not set)') return 0;
  const s = String(v).trim();
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

const fmtBRL = (v: number) =>
  `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtPct = (v: number) =>
  `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

// ── Window helpers ─────────────────────────────────────────────────────────

function windowBounds(refDate: Date, days: number): { cutoff: Date; end: Date } {
  const end = new Date(refDate);
  end.setHours(23, 59, 59, 999);
  const cutoff = new Date(refDate);
  cutoff.setDate(cutoff.getDate() - days + 1);
  cutoff.setHours(0, 0, 0, 0);
  return { cutoff, end };
}

function calcCacInWindow(
  rows: any[], campaignField: string, invField: string, matField: string,
  dateField: string, campaign: string, refDate: Date, windowDays: number
): number | null {
  const { cutoff, end } = windowBounds(refDate, windowDays);
  let inv = 0, mat = 0;
  for (const d of rows) {
    if (String(d[campaignField]) !== campaign) continue;
    const dd = parseLocalDate(d[dateField]);
    if (isNaN(dd.getTime()) || dd < cutoff || dd > end) continue;
    inv += safeNum(d[invField]);
    mat += safeNum(d[matField]);
  }
  return mat > 0 ? inv / mat : null;
}

function calcInvInWindow(
  rows: any[], campaignField: string, invField: string,
  dateField: string, campaign: string, refDate: Date, windowDays: number
): number {
  const { cutoff, end } = windowBounds(refDate, windowDays);
  let inv = 0;
  for (const d of rows) {
    if (String(d[campaignField]) !== campaign) continue;
    const dd = parseLocalDate(d[dateField]);
    if (isNaN(dd.getTime()) || dd < cutoff || dd > end) continue;
    inv += safeNum(d[invField]);
  }
  return windowDays > 0 ? inv / windowDays : 0;
}

function calcWeightedCac(
  cac_60d: number | null, cac_30d: number | null,
  cac_14d: number | null, cac_7d: number | null
): number | null {
  const slots: [number | null, number][] = [
    [cac_60d, 1], [cac_30d, 2], [cac_14d, 1], [cac_7d, 1],
  ];
  let sum = 0, totalW = 0;
  for (const [cac, w] of slots) {
    if (cac !== null && cac > 0) { sum += cac * w; totalW += w; }
  }
  return totalW > 0 ? sum / totalW : null;
}

// ── Allocation engine ──────────────────────────────────────────────────────
// Algoritmo determinístico water-filling:
// 1. Campanhas sem CAC -> fixado em inv_current * (1 - 0.35), nao redistribui
// 2. Para campanhas com CAC: todos partem do minimo (inv*0.65)
// 3. O orcamento restante e distribuido proporcionalmente ao inverso do CAC
//    ate cada campanha atingir seu teto (inv*1.35)
// 4. Nao ha redistribuicao de overflow — se o alvo nao cabe nos limites, reporta saldo

function allocate(campaigns: CampaignMetrics[], targetTotal: number): SuggestionResult {
  const MAX_CHANGE = 0.35;

  const withCac    = campaigns.filter(c => c.cac_weighted !== null && c.cac_weighted > 0);
  const withoutCac = campaigns.filter(c => c.cac_weighted === null || c.cac_weighted === 0);

  // Campanhas sem CAC: fixado em -35%
  const noCacAllocs: AllocationResult[] = withoutCac.map(c => {
    const inv_min = c.inv_current * (1 - MAX_CHANGE);
    const inv_max = c.inv_current * (1 + MAX_CHANGE);
    const inv_suggested = inv_min;
    return {
      campaign: c.campaign, inv_current: c.inv_current, cac_weighted: null,
      inv_suggested, inv_min, inv_max,
      delta_abs: inv_suggested - c.inv_current,
      delta_pct: c.inv_current > 0 ? ((inv_suggested - c.inv_current) / c.inv_current) * 100 : -35,
      capped: true,
    };
  });

  const fixedTotal   = noCacAllocs.reduce((s, a) => s + a.inv_suggested, 0);
  const budgetForCac = targetTotal - fixedTotal;

  const mins = withCac.map(c => c.inv_current * (1 - MAX_CHANGE));
  const maxs = withCac.map(c => c.inv_current * (1 + MAX_CHANGE));
  const totalMin = mins.reduce((s, v) => s + v, 0);
  const totalMax = maxs.reduce((s, v) => s + v, 0);

  // Clamp orçamento ao possível dentro dos limites
  const effectiveBudget = Math.min(Math.max(budgetForCac, totalMin), totalMax);

  // Todos partem do mínimo; distribui o excedente
  const suggested = [...mins];
  let remaining = effectiveBudget - totalMin;

  const n = withCac.length;
  if (remaining > 0 && n > 0) {
    const invCacs  = withCac.map(c => 1 / c.cac_weighted!);
    const headroom = withCac.map((_, i) => maxs[i] - mins[i]);

    let free = Array.from({ length: n }, (_, i) => i);

    for (let iter = 0; iter < n + 5 && remaining > 0.01 && free.length > 0; iter++) {
      const freeInvCac = free.map(i => invCacs[i]);
      const sumFree    = freeInvCac.reduce((s, v) => s + v, 0);
      if (sumFree === 0) break;

      const newFree: number[] = [];
      let overflow = 0;

      for (let fi = 0; fi < free.length; fi++) {
        const i     = free[fi];
        const share = freeInvCac[fi] / sumFree;
        const extra = share * remaining;

        if (extra >= headroom[i] - 0.01) {
          // Atingiu o teto: fixa e devolve excedente
          overflow += extra - headroom[i];
          suggested[i] = maxs[i];
        } else {
          suggested[i] = mins[i] + extra;
          newFree.push(i);
        }
      }

      // Redistribui apenas o overflow desta iteração para quem ainda tem espaço
      remaining = overflow;
      free = newFree;
    }
  }

  const cacAllocs: AllocationResult[] = withCac.map((c, i) => {
    const inv_suggested = Math.round(suggested[i] * 100) / 100;
    const delta_abs     = inv_suggested - c.inv_current;
    const delta_pct     = c.inv_current > 0 ? (delta_abs / c.inv_current) * 100 : 0;
    const atCap = Math.abs(inv_suggested - maxs[i]) < 0.5 || Math.abs(inv_suggested - mins[i]) < 0.5;
    return {
      campaign: c.campaign, inv_current: c.inv_current, cac_weighted: c.cac_weighted,
      inv_suggested, inv_min: Math.round(mins[i] * 100) / 100, inv_max: Math.round(maxs[i] * 100) / 100,
      delta_abs, delta_pct, capped: atCap,
    };
  });

  const allocations     = [...cacAllocs, ...noCacAllocs];
  const total_allocated = Math.round(allocations.reduce((s, a) => s + a.inv_suggested, 0) * 100) / 100;
  const leftover        = Math.round(Math.abs(targetTotal - total_allocated) * 100) / 100;
  const hit_limit       = leftover > 1.0;

  const message = hit_limit
    ? `Só foi possível alocar ${fmtBRL(total_allocated)} respeitando a regra de alteração de até ±35%. O saldo restante é de ${fmtBRL(leftover)}.`
    : null;

  return { allocations, total_allocated, total_target: targetTotal, leftover, hit_limit, message };
}

// ── Sort helper ────────────────────────────────────────────────────────────

function sortValue(cm: CampaignMetrics, alloc: AllocationResult | undefined, col: SortCol): number | string {
  switch (col) {
    case 'campaign':      return cm.campaign;
    case 'cac_60d':       return cm.cac_60d      ?? Infinity;
    case 'cac_30d':       return cm.cac_30d      ?? Infinity;
    case 'cac_14d':       return cm.cac_14d      ?? Infinity;
    case 'cac_7d':        return cm.cac_7d       ?? Infinity;
    case 'cac_weighted':  return cm.cac_weighted ?? Infinity;
    case 'inv_current':   return cm.inv_current;
    case 'inv_suggested': return alloc?.inv_suggested ?? cm.inv_current;
    case 'delta_pct':     return alloc?.delta_pct     ?? 0;
    default: return 0;
  }
}

// ── Main Component ─────────────────────────────────────────────────────────

export function InvestmentSuggestion({ data }: { data: any[] }) {
  const [targetInput, setTargetInput] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [search,      setSearch]      = useState('');
  const [sortCol,     setSortCol]     = useState<SortCol>('cac_weighted');
  const [sortDir,     setSortDir]     = useState<SortDir>('asc');
  const [filterNoCac, setFilterNoCac] = useState(false);

  const keys = useMemo(() => (data.length > 0 ? Object.keys(data[0]) : []), [data]);

  const dateField     = useMemo(() => findField(keys, 'data', 'date', 'created_at'), [keys]);
  const campaignField = useMemo(() => findField(keys, 'campaign_name'), [keys]);
  const invField      = useMemo(() => findField(keys, 'investimento', 'investment', 'custo'), [keys]);
  const matField      = useMemo(() => findField(keys, 'matriculas', 'matricula', 'matriculas'), [keys]);

  // Stable "today" reference — prevents re-renders caused by new Date() changing across midnight
  const todayRef = useMemo(() => new Date(), []);

  const refDate = useMemo(() => {
    if (!dateField || !data.length) return todayRef;
    const dates = data.map(d => parseLocalDate(d[dateField])).filter(d => !isNaN(d.getTime()));
    if (!dates.length) return todayRef;
    return new Date(Math.max(...dates.map(d => d.getTime())));
  }, [data, dateField, todayRef]);

  const campaigns = useMemo(() => {
    if (!campaignField) return [];
    return Array.from(new Set(data.map(d => String(d[campaignField])).filter(Boolean)));
  }, [data, campaignField]);

  const campaignMetrics = useMemo((): CampaignMetrics[] => {
    if (!campaignField || !invField || !matField || !dateField) return [];

    return campaigns
      .map(campaign => {
        const cac_60d = calcCacInWindow(data, campaignField, invField, matField, dateField, campaign, refDate, 60);
        const cac_30d = calcCacInWindow(data, campaignField, invField, matField, dateField, campaign, refDate, 30);
        const cac_14d = calcCacInWindow(data, campaignField, invField, matField, dateField, campaign, refDate, 14);
        const cac_7d  = calcCacInWindow(data, campaignField, invField, matField, dateField, campaign, refDate, 7);
        const cac_weighted = calcWeightedCac(cac_60d, cac_30d, cac_14d, cac_7d);

        const inv_7d_daily  = calcInvInWindow(data, campaignField, invField, dateField, campaign, refDate, 7);
        const inv_30d_daily = calcInvInWindow(data, campaignField, invField, dateField, campaign, refDate, 30);
        const inv_current   = inv_7d_daily > 0 ? inv_7d_daily : inv_30d_daily;
        const inv_30d_total = inv_30d_daily * 30;

        return { campaign, inv_current, inv_30d_total, cac_60d, cac_30d, cac_14d, cac_7d, cac_weighted };
      })
      .filter(c => c.inv_30d_total > 0);
  }, [data, campaigns, campaignField, invField, matField, dateField, refDate]);

  const currentTotalDaily = useMemo(() =>
    campaignMetrics.reduce((s, c) => s + c.inv_current, 0), [campaignMetrics]);

  const targetValue = useMemo(() => {
    const raw = targetInput.replace(/[R$\s.]/g, '').replace(',', '.');
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [targetInput]);

  const result = useMemo((): SuggestionResult | null => {
    if (targetValue === null || campaignMetrics.length === 0) return null;
    return allocate(campaignMetrics, targetValue);
  }, [targetValue, campaignMetrics]);

  // ── Tabela: filtro + ordenação ─────────────────────────────────────────

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const SortIcon = ({ col }: { col: SortCol }) => {
    if (sortCol !== col) return <ChevronsUpDown className="w-3 h-3 opacity-30" />;
    return sortDir === 'asc'
      ? <ChevronUp   className="w-3 h-3 text-emerald-600" />
      : <ChevronDown className="w-3 h-3 text-emerald-600" />;
  };

  const thCls = (col: SortCol, align: 'left' | 'right' = 'right') =>
    `px-4 py-3 text-${align} text-xs font-semibold uppercase tracking-wide cursor-pointer select-none whitespace-nowrap transition-colors hover:text-emerald-700 ${
      sortCol === col ? 'text-emerald-700 bg-emerald-50/60' : 'text-slate-500'
    }`;

  const displayRows = useMemo(() => {
    let rows = campaignMetrics.slice();
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(c => c.campaign.toLowerCase().includes(q));
    }
    if (filterNoCac) {
      rows = rows.filter(c => c.cac_weighted === null);
    }
    rows.sort((a, b) => {
      const allocA = result?.allocations.find(x => x.campaign === a.campaign);
      const allocB = result?.allocations.find(x => x.campaign === b.campaign);
      const va = sortValue(a, allocA, sortCol);
      const vb = sortValue(b, allocB, sortCol);
      let cmp = 0;
      if (typeof va === 'string' && typeof vb === 'string') cmp = va.localeCompare(vb);
      else cmp = (va as number) - (vb as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [campaignMetrics, search, filterNoCac, sortCol, sortDir, result]);

  // ── Guards ─────────────────────────────────────────────────────────────

  if (!data.length) {
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-12 text-center text-slate-500">
        <DollarSign className="w-12 h-12 mx-auto mb-3 opacity-20" />
        <p>Nenhum dado disponível.</p>
      </div>
    );
  }

  if (!campaignField || !invField || !matField || !dateField) {
    return (
      <div className="bg-amber-50 border border-amber-200 text-amber-700 p-4 rounded-xl text-sm flex items-start gap-3">
        <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
        <p>Campos necessários não encontrados: <code>campaign_name</code>, <code>investimento</code>, <code>matriculas</code>, <code>data</code>.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2 mb-1">
              <DollarSign className="w-5 h-5 text-emerald-600" />
              Sugestão de Investimento por Campanha
            </h2>
            <p className="text-sm text-slate-500">
              CAC ponderado (60d×1 + 30d×2 + 14d×1 + 7d×1) · Referência: <strong>{refDate.toLocaleDateString('pt-BR')}</strong>
            </p>
          </div>
          <button
            onClick={() => setShowDetails(v => !v)}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg px-3 py-1.5 bg-slate-50 hover:bg-slate-100 transition-colors whitespace-nowrap"
          >
            <Info className="w-3.5 h-3.5" />
            {showDetails ? 'Ocultar metodologia' : 'Ver metodologia'}
            {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>

        {showDetails && (
          <div className="mt-4 bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs text-slate-600 space-y-2">
            <p><strong>CAC Ponderado</strong> = (CAC₆₀d×1 + CAC₃₀d×2 + CAC₁₄d×1 + CAC₇d×1) ÷ soma dos pesos com dados</p>
            <p><strong>Alocação:</strong> todas as campanhas partem do mínimo (−35%). O orçamento excedente é distribuído proporcionalmente ao inverso do CAC até o teto (+35%) de cada uma.</p>
            <p><strong>Restrição ±35%:</strong> piso = inv_atual × 0,65 · teto = inv_atual × 1,35. Se o alvo não couber nos limites, o saldo restante é informado.</p>
            <p><strong>Campanhas sem CAC</strong> recebem corte fixo de −35% e não participam da redistribuição.</p>
            <p><strong>Campanhas ativas</strong> = com investimento &gt; 0 nos últimos 30 dias.</p>
          </div>
        )}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Investimento Atual / dia</div>
          <div className="text-2xl font-bold text-slate-900">{fmtBRL(currentTotalDaily)}</div>
          <div className="text-xs text-slate-400 mt-1">Média 7d · {campaignMetrics.length} campanhas ativas</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Campanhas com CAC</div>
          <div className="text-2xl font-bold text-slate-900">
            {campaignMetrics.filter(c => c.cac_weighted !== null).length}
            <span className="text-base font-normal text-slate-400"> / {campaignMetrics.length}</span>
          </div>
          <div className="text-xs text-slate-400 mt-1">Com dados suficientes para alocação</div>
        </div>
        <div className="bg-white rounded-xl border border-emerald-200 shadow-sm p-5">
          <div className="text-xs text-emerald-600 uppercase tracking-wide font-semibold mb-1">Investimento Alvo / dia</div>
          <input
            type="text"
            value={targetInput}
            onChange={e => setTargetInput(e.target.value)}
            placeholder="Ex: 90000"
            className="w-full text-xl font-bold text-slate-900 bg-transparent border-b-2 border-emerald-400 focus:outline-none focus:border-emerald-600 pb-1 placeholder:text-slate-300 placeholder:font-normal placeholder:text-base"
          />
          <div className="text-xs text-slate-400 mt-2">Total diário desejado em R$</div>
        </div>
      </div>

      {/* Status */}
      {result?.hit_limit && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3 text-sm text-amber-800">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-amber-500" />
          <p>{result.message}</p>
        </div>
      )}
      {result && !result.hit_limit && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-start gap-3 text-sm text-emerald-800">
          <TrendingUp className="w-5 h-5 shrink-0 mt-0.5 text-emerald-500" />
          <p>Distribuição calculada. Total alocado: <strong>{fmtBRL(result.total_allocated)}</strong> dentro dos limites de ±35% por campanha.</p>
        </div>
      )}

      {/* Tabela */}
      {campaignMetrics.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">

          {/* Filtros */}
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/50 flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-[200px]">
              <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Buscar campanha..."
                className="w-full pl-8 pr-8 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-400 bg-white"
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <button
              onClick={() => setFilterNoCac(v => !v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                filterNoCac
                  ? 'bg-amber-100 border-amber-300 text-amber-800'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {filterNoCac ? '× ' : ''}Sem CAC
            </button>

            <span className="text-xs text-slate-400 ml-auto">
              {displayRows.length} de {campaignMetrics.length}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th onClick={() => toggleSort('campaign')} className={thCls('campaign', 'left') + ' min-w-[220px]'}>
                    <span className="inline-flex items-center gap-1">Campanha <SortIcon col="campaign" /></span>
                  </th>
                  <th onClick={() => toggleSort('cac_60d')} className={thCls('cac_60d')}>
                    <span className="inline-flex items-center justify-end gap-1">CAC 60d <SortIcon col="cac_60d" /></span>
                  </th>
                  <th onClick={() => toggleSort('cac_30d')} className={thCls('cac_30d')}>
                    <span className="inline-flex items-center justify-end gap-1">CAC 30d <SortIcon col="cac_30d" /></span>
                  </th>
                  <th onClick={() => toggleSort('cac_14d')} className={thCls('cac_14d')}>
                    <span className="inline-flex items-center justify-end gap-1">CAC 14d <SortIcon col="cac_14d" /></span>
                  </th>
                  <th onClick={() => toggleSort('cac_7d')} className={thCls('cac_7d')}>
                    <span className="inline-flex items-center justify-end gap-1">CAC 7d <SortIcon col="cac_7d" /></span>
                  </th>
                  <th onClick={() => toggleSort('cac_weighted')} className={thCls('cac_weighted')}>
                    <span className="inline-flex items-center justify-end gap-1 text-emerald-700">CAC Ponderado <SortIcon col="cac_weighted" /></span>
                  </th>
                  <th onClick={() => toggleSort('inv_current')} className={thCls('inv_current')}>
                    <span className="inline-flex items-center justify-end gap-1">Inv. Atual/dia <SortIcon col="inv_current" /></span>
                  </th>
                  {result && (
                    <>
                      <th onClick={() => toggleSort('inv_suggested')} className={thCls('inv_suggested')}>
                        <span className="inline-flex items-center justify-end gap-1 text-indigo-600">Inv. Sugerido <SortIcon col="inv_suggested" /></span>
                      </th>
                      <th onClick={() => toggleSort('delta_pct')} className={thCls('delta_pct')}>
                        <span className="inline-flex items-center justify-end gap-1">Variação <SortIcon col="delta_pct" /></span>
                      </th>
                    </>
                  )}
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100">
                {displayRows.map((cm, i) => {
                  const alloc  = result?.allocations.find(a => a.campaign === cm.campaign);
                  const delta  = alloc?.delta_pct ?? 0;
                  const isUp   = delta > 0.5;
                  const isDown = delta < -0.5;

                  return (
                    <tr key={cm.campaign} className={`hover:bg-slate-50/60 transition-colors ${i % 2 === 1 ? 'bg-slate-50/20' : ''}`}>
                      <td className="px-4 py-3 font-medium text-slate-800 max-w-[280px]">
                        <span className="line-clamp-2 leading-snug">{cm.campaign}</span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                        {cm.cac_60d !== null ? fmtBRL(cm.cac_60d) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                        {cm.cac_30d !== null ? fmtBRL(cm.cac_30d) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                        {cm.cac_14d !== null ? fmtBRL(cm.cac_14d) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                        {cm.cac_7d !== null ? fmtBRL(cm.cac_7d) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-semibold text-emerald-700">
                        {cm.cac_weighted !== null
                          ? fmtBRL(cm.cac_weighted)
                          : <span className="text-xs text-slate-400 font-normal">sem dados</span>}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                        {fmtBRL(cm.inv_current)}
                      </td>
                      {result && alloc && (
                        <>
                          <td className="px-4 py-3 text-right tabular-nums font-semibold text-indigo-700">
                            {fmtBRL(alloc.inv_suggested)}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                              isUp   ? 'bg-emerald-100 text-emerald-700' :
                              isDown ? 'bg-red-100 text-red-700' :
                                       'bg-slate-100 text-slate-500'
                            }`}>
                              {isUp   ? <TrendingUp   className="w-3 h-3" /> :
                               isDown ? <TrendingDown className="w-3 h-3" /> :
                                        <Minus        className="w-3 h-3" />}
                              {fmtPct(delta)}
                              {alloc.capped && <span title="Limitado pela regra de ±35%">🔒</span>}
                            </span>
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}

                {displayRows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-slate-400 text-sm">
                      Nenhuma campanha encontrada para os filtros aplicados.
                    </td>
                  </tr>
                )}
              </tbody>

              {result && (
                <tfoot>
                  <tr className="bg-slate-100 border-t-2 border-slate-300 font-semibold">
                    <td className="px-4 py-3 text-slate-700 text-xs uppercase tracking-wide" colSpan={6}>
                      Total · {campaignMetrics.length} campanhas ativas
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-800">{fmtBRL(currentTotalDaily)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-indigo-700">{fmtBRL(result.total_allocated)}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                        result.total_allocated > currentTotalDaily ? 'bg-emerald-100 text-emerald-700' :
                        result.total_allocated < currentTotalDaily ? 'bg-red-100 text-red-700' :
                        'bg-slate-100 text-slate-500'
                      }`}>
                        {fmtPct(currentTotalDaily > 0
                          ? ((result.total_allocated - currentTotalDaily) / currentTotalDaily) * 100
                          : 0)}
                      </span>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div className="px-6 py-3 border-t border-slate-100 text-xs text-slate-400 flex flex-wrap gap-4 justify-between">
            <span>🔒 = Limite ±35% atingido · Clique no cabeçalho para ordenar</span>
            <span>Inv. atual = média diária 7d (fallback 30d se pausa recente)</span>
          </div>
        </div>
      )}
    </div>
  );
}
