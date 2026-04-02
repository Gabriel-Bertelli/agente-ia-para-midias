/**
 * Web Worker para Agregação de Campanhas
 * Executa em thread paralela, não bloqueia UI
 */

// ── Message Types ─────────────────────────────────────────────────────────

interface AggregationRequest {
  id: string;
  type: 'aggregate-campaigns';
  data: any[];
  availableKeys: string[];
  opts: {
    start: string;
    end: string;
    tipoCampanha: string;
    produto: string;
  };
}

interface AggregationResponse {
  id: string;
  type: 'aggregate-campaigns-result';
  result: Array<{
    campanha: string;
    investimento: number;
    leads: number;
    mql: number;
    inscricoes: number;
    matriculas: number;
    cpmql: number | null;
    cpi: number | null;
    cac: number | null;
    conv_mql_mat: number | null;
  }>;
  duration: number;
}

interface ErrorResponse {
  id: string;
  type: 'error';
  message: string;
}

// ── Helper Functions ──────────────────────────────────────────────────────

const parseLocalDate = (v: any): Date => {
  if (!v) return new Date(NaN);
  if (v instanceof Date) return v;
  const s = String(v).split('T')[0].split(' ')[0];
  return new Date(`${s}T00:00:00`);
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

// ── Aggregation Function ──────────────────────────────────────────────────

function aggregateCampaigns(
  data: any[],
  availableKeys: string[],
  opts: { start: string; end: string; tipoCampanha: string; produto: string }
) {
  if (!data.length) return [];

  const dateField = findField(availableKeys, 'data', 'date', 'created_at');
  const campaignField = findField(availableKeys, 'campaign_name');
  const invField = findField(availableKeys, 'investimento', 'investment', 'custo');
  const leadsField = findField(availableKeys, 'leads');
  const mqlField = findField(availableKeys, 'mql', 'mqls');
  const inscField = findField(availableKeys, 'inscricoes', 'inscrições', 'inscricao');
  const matField = findField(availableKeys, 'matriculas', 'matricula', 'matrículas');
  const tipoCampanhaField = findField(availableKeys, 'tipo_campanha');
  const produtoField = findField(availableKeys, 'produto');

  if (!campaignField) return [];

  const sDate = opts.start ? new Date(`${opts.start}T00:00:00`) : null;
  const eDate = opts.end ? new Date(`${opts.end}T23:59:59`) : null;

  const grouped: Record<string, { inv: number; leads: number; mql: number; ins: number; mat: number }> = {};

  for (const d of data) {
    // Date filter
    if (dateField && sDate && eDate) {
      const dd = parseLocalDate(d[dateField]);
      if (isNaN(dd.getTime()) || dd < sDate || dd > eDate) continue;
    }
    // Tipo campanha filter
    if (opts.tipoCampanha && opts.tipoCampanha !== 'all' && tipoCampanhaField) {
      if (d[tipoCampanhaField] !== opts.tipoCampanha) continue;
    }
    // Produto filter
    if (opts.produto && opts.produto !== 'all' && produtoField) {
      if (d[produtoField] !== opts.produto) continue;
    }

    const campanha = String(d[campaignField] ?? '').trim();
    if (!campanha || campanha === '(not set)') continue;

    if (!grouped[campanha]) grouped[campanha] = { inv: 0, leads: 0, mql: 0, ins: 0, mat: 0 };
    const g = grouped[campanha];

    if (invField) g.inv += safeNum(d[invField]);
    if (leadsField) g.leads += safeNum(d[leadsField]);
    if (mqlField) g.mql += safeNum(d[mqlField]);
    if (inscField) g.ins += safeNum(d[inscField]);
    if (matField) g.mat += safeNum(d[matField]);
  }

  return Object.entries(grouped).map(([campanha, g]) => ({
    campanha,
    investimento: g.inv,
    leads: g.leads,
    mql: g.mql,
    inscricoes: g.ins,
    matriculas: g.mat,
    cpmql: g.mql > 0 ? g.inv / g.mql : null,
    cpi: g.ins > 0 ? g.inv / g.ins : null,
    cac: g.mat > 0 ? g.inv / g.mat : null,
    conv_mql_mat: g.mql > 0 ? (g.mat / g.mql) * 100 : null,
  }));
}

// ── Worker Message Handler ────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<AggregationRequest>) => {
  const { id, type, data, availableKeys, opts } = event.data;

  if (type !== 'aggregate-campaigns') {
    self.postMessage({
      id,
      type: 'error',
      message: `Unknown message type: ${type}`,
    } as ErrorResponse);
    return;
  }

  try {
    const startTime = performance.now();
    const result = aggregateCampaigns(data, availableKeys, opts);
    const endTime = performance.now();

    self.postMessage({
      id,
      type: 'aggregate-campaigns-result',
      result,
      duration: endTime - startTime,
    } as AggregationResponse);
  } catch (error) {
    self.postMessage({
      id,
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
    } as ErrorResponse);
  }
};

export {};
