import React, { useMemo, useState } from 'react';
import { TrendingUp, TrendingDown, Minus, AlertCircle, DollarSign, Info, ChevronDown, ChevronUp } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────

interface CampaignMetrics {
  campaign: string;
  inv_current: number; // investimento médio diário na janela mais recente (usamos 7d)
  cac_60d: number | null;
  cac_30d: number | null;
  cac_14d: number | null;
  cac_7d: number | null;
  cac_weighted: number | null;
  mat_60d: number;
  mat_7d: number;
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
  capped: boolean; // foi limitado pelo +-35%
}

interface SuggestionResult {
  allocations: AllocationResult[];
  total_allocated: number;
  total_target: number;
  leftover: number;
  hit_limit: boolean;
  message: string | null;
}

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
  const n = parseFloat(s.includes(',') && s.includes('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(',', '.'));
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

// ── CAC by window ──────────────────────────────────────────────────────────

function calcCacInWindow(
  rows: any[],
  campaignField: string,
  invField: string,
  matField: string,
  dateField: string,
  campaign: string,
  refDate: Date,
  windowDays: number
): number | null {
  const cutoff = new Date(refDate);
  cutoff.setDate(cutoff.getDate() - windowDays + 1);
  cutoff.setHours(0, 0, 0, 0);

  let inv = 0, mat = 0;
  for (const d of rows) {
    if (String(d[campaignField]) !== campaign) continue;
    const dd = parseLocalDate(d[dateField]);
    if (isNaN(dd.getTime()) || dd < cutoff || dd > refDate) continue;
    inv += safeNum(d[invField]);
    mat += safeNum(d[matField]);
  }
  return mat > 0 ? inv / mat : null;
}

function calcInvInWindow(
  rows: any[],
  campaignField: string,
  invField: string,
  dateField: string,
  campaign: string,
  refDate: Date,
  windowDays: number
): number {
  const cutoff = new Date(refDate);
  cutoff.setDate(cutoff.getDate() - windowDays + 1);
  cutoff.setHours(0, 0, 0, 0);

  let inv = 0;
  for (const d of rows) {
    if (String(d[campaignField]) !== campaign) continue;
    const dd = parseLocalDate(d[dateField]);
    if (isNaN(dd.getTime()) || dd < cutoff || dd > refDate) continue;
    inv += safeNum(d[invField]);
  }
  return windowDays > 0 ? inv / windowDays : 0;
}

// ── Weighted CAC ──────────────────────────────────────────────────────────
// Janela 60d: peso 1 | 30d: peso 2 | 14d: peso 1 | 7d: peso 1
// Só usa as janelas disponíveis (não nulas)

function calcWeightedCac(
  cac_60d: number | null,
  cac_30d: number | null,
  cac_14d: number | null,
  cac_7d: number | null
): number | null {
  const weights: [number | null, number][] = [
    [cac_60d, 1],
    [cac_30d, 2],
    [cac_14d, 1],
    [cac_7d, 1],
  ];
  let sum = 0, totalWeight = 0;
  for (const [cac, w] of weights) {
    if (cac !== null && cac > 0) {
      sum += cac * w;
      totalWeight += w;
    }
  }
  return totalWeight > 0 ? sum / totalWeight : null;
}

// ── Allocation engine ──────────────────────────────────────────────────────
// Distribui o investimento alvo proporcional ao INVERSO do CAC ponderado
// (menor CAC → maior alocação), respeitando +-35% por campanha.

function allocate(campaigns: CampaignMetrics[], targetTotal: number): SuggestionResult {
  const MAX_CHANGE = 0.35;

  // Campanhas sem CAC ponderado recebem o mesmo investimento atual (sem alteração)
  const withCac = campaigns.filter(c => c.cac_weighted !== null && c.cac_weighted > 0);
  const withoutCac = campaigns.filter(c => c.cac_weighted === null || c.cac_weighted === 0);

  // Total atual
  const currentTotal = campaigns.reduce((s, c) => s + c.inv_current, 0);

  // Reserva o investimento REDUZIDO das campanhas sem CAC (-35%)
  const reservedNoData = withoutCac.reduce((s, c) => s + c.inv_current * (1 - MAX_CHANGE), 0);
  const availableForAlloc = Math.max(0, targetTotal - reservedNoData);

  // Pesos = inverso do CAC ponderado (menor CAC = maior peso)
  const invCacs = withCac.map(c => 1 / c.cac_weighted!);
  const sumInvCac = invCacs.reduce((s, v) => s + v, 0);

  // Primeira passagem: distribuição proporcional sem restrição
  let firstPass = withCac.map((c, i) => {
    const share = sumInvCac > 0 ? invCacs[i] / sumInvCac : 1 / withCac.length;
    return share * availableForAlloc;
  });

  // Aplicar limite +-35% por campanha
  let capped: boolean[] = new Array(withCac.length).fill(false);
  let iterations = 0;
  const MAX_ITER = 20;

  while (iterations < MAX_ITER) {
    let overflow = 0;
    let freeWeight = 0;
    const cappedFlags = withCac.map((c, i) => {
      const min = c.inv_current * (1 - MAX_CHANGE);
      const max = c.inv_current * (1 + MAX_CHANGE);
      if (firstPass[i] < min) {
        overflow += firstPass[i] - min; // negativo
        firstPass[i] = min;
        capped[i] = true;
        return true;
      }
      if (firstPass[i] > max) {
        overflow += firstPass[i] - max; // positivo
        firstPass[i] = max;
        capped[i] = true;
        return true;
      }
      return false;
    });

    // Redistribuir overflow entre não-capped
    const freeCampaigns = withCac.filter((_, i) => !cappedFlags[i]);
    const freeInvCacs = freeCampaigns.map((c) => 1 / c.cac_weighted!);
    freeWeight = freeInvCacs.reduce((s, v) => s + v, 0);

    if (Math.abs(overflow) < 0.01 || freeCampaigns.length === 0) break;

    let freeIdx = 0;
    withCac.forEach((_, i) => {
      if (!cappedFlags[i]) {
        const share = freeWeight > 0 ? freeInvCacs[freeIdx] / freeWeight : 1 / freeCampaigns.length;
        firstPass[i] += overflow * share;
        freeIdx++;
      }
    });

    iterations++;
  }

  // Montar resultado
  const allocations: AllocationResult[] = [
    ...withCac.map((c, i) => {
      const inv_suggested = Math.round(firstPass[i] * 100) / 100;
      const delta_abs = inv_suggested - c.inv_current;
      const delta_pct = c.inv_current > 0 ? (delta_abs / c.inv_current) * 100 : 0;
      return {
        campaign: c.campaign,
        inv_current: c.inv_current,
        cac_weighted: c.cac_weighted,
        inv_suggested,
        inv_min: Math.round(c.inv_current * (1 - MAX_CHANGE) * 100) / 100,
        inv_max: Math.round(c.inv_current * (1 + MAX_CHANGE) * 100) / 100,
        delta_pct,
        delta_abs,
        capped: capped[i],
      };
    }),
    ...withoutCac.map(c => {
      const inv_suggested = Math.round(c.inv_current * (1 - MAX_CHANGE) * 100) / 100;
      const delta_abs = inv_suggested - c.inv_current;
      const delta_pct = c.inv_current > 0 ? (delta_abs / c.inv_current) * 100 : 0;
      return {
        campaign: c.campaign,
        inv_current: c.inv_current,
        cac_weighted: null,
        inv_suggested,
        inv_min: inv_suggested,
        inv_max: c.inv_current * (1 + MAX_CHANGE),
        delta_pct,
        delta_abs,
        capped: true,
      };
    }),
  ];

  const total_allocated = allocations.reduce((s, a) => s + a.inv_suggested, 0);
  const leftover = Math.abs(targetTotal - total_allocated);
  const hit_limit = leftover > 1.0;

  let message: string | null = null;
  if (hit_limit) {
    message = `Só foi possível alocar ${fmtBRL(total_allocated)} respeitando a regra de alteração de até ±35%. O saldo restante é de ${fmtBRL(leftover)}.`;
  }

  return { allocations, total_allocated, total_target: targetTotal, leftover, hit_limit, message };
}

// ── Main Component ─────────────────────────────────────────────────────────

export function InvestmentSuggestion({ data }: { data: any[] }) {
  const [targetInput, setTargetInput] = useState('');
  const [showDetails, setShowDetails] = useState(false);

  const keys = useMemo(() => (data.length > 0 ? Object.keys(data[0]) : []), [data]);

  const dateField     = useMemo(() => findField(keys, 'data', 'date', 'created_at'), [keys]);
  const campaignField = useMemo(() => findField(keys, 'campaign_name'), [keys]);
  const invField      = useMemo(() => findField(keys, 'investimento', 'investment', 'custo'), [keys]);
  const matField      = useMemo(() => findField(keys, 'matriculas', 'matricula', 'matrículas'), [keys]);

  // Referência: data mais recente disponível
  const refDate = useMemo(() => {
    if (!dateField || !data.length) return new Date();
    const dates = data.map(d => parseLocalDate(d[dateField])).filter(d => !isNaN(d.getTime()));
    if (!dates.length) return new Date();
    return new Date(Math.max(...dates.map(d => d.getTime())));
  }, [data, dateField]);

  // Lista de campanhas únicas
  const campaigns = useMemo(() => {
    if (!campaignField) return [];
    return Array.from(new Set(data.map(d => String(d[campaignField])).filter(Boolean)));
  }, [data, campaignField]);

  // Calcular métricas por campanha
  const campaignMetrics = useMemo((): CampaignMetrics[] => {
    if (!campaignField || !invField || !matField || !dateField) return [];

    return campaigns.map(campaign => {
      const cac_60d = calcCacInWindow(data, campaignField, invField, matField, dateField, campaign, refDate, 60);
      const cac_30d = calcCacInWindow(data, campaignField, invField, matField, dateField, campaign, refDate, 30);
      const cac_14d = calcCacInWindow(data, campaignField, invField, matField, dateField, campaign, refDate, 14);
      const cac_7d  = calcCacInWindow(data, campaignField, invField, matField, dateField, campaign, refDate, 7);
      const cac_weighted = calcWeightedCac(cac_60d, cac_30d, cac_14d, cac_7d);
      const inv_current  = calcInvInWindow(data, campaignField, invField, dateField, campaign, refDate, 7);

      // mat recent
      const cutoff7 = new Date(refDate);
      cutoff7.setDate(cutoff7.getDate() - 6);
      const cutoff60 = new Date(refDate);
      cutoff60.setDate(cutoff60.getDate() - 59);
      let mat_7d = 0, mat_60d = 0;
      for (const d of data) {
        if (String(d[campaignField]) !== campaign) continue;
        const dd = parseLocalDate(d[dateField]);
        if (isNaN(dd.getTime())) continue;
        if (dd >= cutoff7 && dd <= refDate) mat_7d += safeNum(d[matField]);
        if (dd >= cutoff60 && dd <= refDate) mat_60d += safeNum(d[matField]);
      }

      return { campaign, inv_current, cac_60d, cac_30d, cac_14d, cac_7d, cac_weighted, mat_60d, mat_7d };
    });
  }, [data, campaigns, campaignField, invField, matField, dateField, refDate]);

  const currentTotalDaily = useMemo(() =>
    campaignMetrics.reduce((s, c) => s + c.inv_current, 0),
    [campaignMetrics]);

  // Parse target
  const targetValue = useMemo(() => {
    const raw = targetInput.replace(/[R$\s.]/g, '').replace(',', '.');
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [targetInput]);

  // Compute allocation
  const result = useMemo((): SuggestionResult | null => {
    if (targetValue === null || campaignMetrics.length === 0) return null;
    return allocate(campaignMetrics, targetValue);
  }, [targetValue, campaignMetrics]);

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
        <p>Campos necessários não encontrados nos dados (<code>campaign_name</code>, <code>investimento</code>, <code>matriculas</code>, <code>data</code>).</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* Header Info */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2 mb-1">
              <DollarSign className="w-5 h-5 text-emerald-600" />
              Sugestão de Investimento por Campanha
            </h2>
            <p className="text-sm text-slate-500">
              Baseado no CAC ponderado (60d×1 + 30d×2 + 14d×1 + 7d×1) · Referência: <strong>{refDate.toLocaleDateString('pt-BR')}</strong>
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
            <p><strong>CAC Ponderado</strong> = (CAC₆₀d × 1 + CAC₃₀d × 2 + CAC₁₄d × 1 + CAC₇d × 1) ÷ soma dos pesos disponíveis</p>
            <p><strong>Alocação:</strong> inversamente proporcional ao CAC ponderado — quanto menor o CAC, maior a alocação incremental.</p>
            <p><strong>Restrição:</strong> nenhuma campanha pode ter seu investimento alterado em mais de ±35% do valor atual diário (média dos últimos 7 dias).</p>
            <p><strong>Saldo não alocável:</strong> se o total alvo exige movimentação além dos limites de ±35%, o sistema informa o valor máximo que consegue alocar e o saldo restante.</p>
            <p><strong>Campanhas sem dados de CAC</strong> recebem redução máxima de -35% automaticamente.</p>
          </div>
        )}
      </div>

      {/* Current state + target input */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Investimento Atual / dia</div>
          <div className="text-2xl font-bold text-slate-900">{fmtBRL(currentTotalDaily)}</div>
          <div className="text-xs text-slate-400 mt-1">Média dos últimos 7 dias</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Campanhas com CAC</div>
          <div className="text-2xl font-bold text-slate-900">
            {campaignMetrics.filter(c => c.cac_weighted !== null).length}
            <span className="text-base font-normal text-slate-400"> / {campaignMetrics.length}</span>
          </div>
          <div className="text-xs text-slate-400 mt-1">Campanhas com dados suficientes</div>
        </div>
        <div className="bg-white rounded-xl border border-emerald-200 shadow-sm p-5">
          <div className="text-xs text-emerald-600 uppercase tracking-wide font-semibold mb-1">Investimento Alvo / dia</div>
          <input
            type="text"
            value={targetInput}
            onChange={e => setTargetInput(e.target.value)}
            placeholder="Ex: 15000"
            className="w-full text-xl font-bold text-slate-900 bg-transparent border-b-2 border-emerald-400 focus:outline-none focus:border-emerald-600 pb-1 placeholder:text-slate-300 placeholder:font-normal placeholder:text-base"
          />
          <div className="text-xs text-slate-400 mt-2">Digite o total diário desejado em R$</div>
        </div>
      </div>

      {/* Alert message when limit hit */}
      {result?.hit_limit && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3 text-sm text-amber-800">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-amber-500" />
          <p>{result.message}</p>
        </div>
      )}

      {/* Success summary */}
      {result && !result.hit_limit && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-start gap-3 text-sm text-emerald-800">
          <TrendingUp className="w-5 h-5 shrink-0 mt-0.5 text-emerald-500" />
          <p>
            Distribuição calculada com sucesso. Total alocado: <strong>{fmtBRL(result.total_allocated)}</strong> dentro dos limites de ±35% por campanha.
          </p>
        </div>
      )}

      {/* CAC table + allocation */}
      {campaignMetrics.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/50">
            <h3 className="text-sm font-semibold text-slate-700">CAC por Janela e Alocação Sugerida</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 min-w-[220px]">Campanha</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">CAC 60d</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">CAC 30d</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">CAC 14d</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">CAC 7d</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-emerald-600 whitespace-nowrap">CAC Ponderado</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">Inv. Atual/dia</th>
                  {result && (
                    <>
                      <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-indigo-600 whitespace-nowrap">Inv. Sugerido</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">Variação</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {campaignMetrics
                  .slice()
                  .sort((a, b) => {
                    if (a.cac_weighted === null && b.cac_weighted === null) return 0;
                    if (a.cac_weighted === null) return 1;
                    if (b.cac_weighted === null) return -1;
                    return a.cac_weighted - b.cac_weighted;
                  })
                  .map(cm => {
                    const alloc = result?.allocations.find(a => a.campaign === cm.campaign);
                    const delta_pct = alloc?.delta_pct ?? 0;
                    const isUp = delta_pct > 0.5;
                    const isDown = delta_pct < -0.5;

                    return (
                      <tr key={cm.campaign} className="hover:bg-slate-50/50 transition-colors">
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
                          {cm.cac_weighted !== null ? fmtBRL(cm.cac_weighted) : (
                            <span className="text-xs text-slate-400 font-normal">sem dados</span>
                          )}
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
                                isUp
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : isDown
                                    ? 'bg-red-100 text-red-700'
                                    : 'bg-slate-100 text-slate-500'
                              }`}>
                                {isUp ? <TrendingUp className="w-3 h-3" /> : isDown ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                                {fmtPct(delta_pct)}
                                {alloc.capped && (
                                  <span title="Limitado pela regra de ±35%">🔒</span>
                                )}
                              </span>
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
              </tbody>
              {result && (
                <tfoot>
                  <tr className="bg-slate-100 border-t-2 border-slate-300 font-semibold">
                    <td className="px-4 py-3 text-slate-700 text-xs uppercase tracking-wide" colSpan={6}>
                      Total ({campaignMetrics.length} campanhas)
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-800">
                      {fmtBRL(currentTotalDaily)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-indigo-700">
                      {fmtBRL(result.total_allocated)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                        result.total_allocated > currentTotalDaily
                          ? 'bg-emerald-100 text-emerald-700'
                          : result.total_allocated < currentTotalDaily
                            ? 'bg-red-100 text-red-700'
                            : 'bg-slate-100 text-slate-500'
                      }`}>
                        {fmtPct(currentTotalDaily > 0 ? ((result.total_allocated - currentTotalDaily) / currentTotalDaily) * 100 : 0)}
                      </span>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <div className="px-6 py-3 border-t border-slate-100 text-xs text-slate-400 flex flex-wrap gap-4 justify-between">
            <span>🔒 = Alteração limitada pela regra de ±35%</span>
            <span>Invest. atual = média diária dos últimos 7 dias · Ordenado por CAC Ponderado (menor → maior)</span>
          </div>
        </div>
      )}
    </div>
  );
}
