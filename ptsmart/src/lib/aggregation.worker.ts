/**
 * aggregation.worker.ts
 * ─────────────────────
 * Runs heavy aggregation (group-by, filter, sort) off the main thread
 * so 400 k-row datasets don't freeze the UI.
 *
 * Message in  → { type, payload }
 * Message out → { type, result } | { type: 'error', message }
 */

// ── Helpers (duplicated from components — worker cannot import modules) ──────

function safeNum(v: any): number {
  if (v === null || v === undefined || v === '' || v === '(not set)') return 0;
  const s = String(v).trim().replace(/\s/g, '');
  const n = parseFloat(
    s.includes(',') && s.includes('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(',', '.')
  );
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseLocalDate(v: any): number {
  if (!v) return NaN;
  const s = String(v).split('T')[0].split(' ')[0];
  return new Date(`${s}T00:00:00`).getTime();
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

// ── Campaign aggregation ─────────────────────────────────────────────────────

interface CampaignOpts {
  data: any[];
  availableKeys: string[];
  start: string;
  end: string;
  tipoCampanha: string;
  produto: string;
}

function aggregateCampaigns(opts: CampaignOpts) {
  const { data, availableKeys, start, end, tipoCampanha, produto } = opts;
  if (!data.length) return [];

  const dateField         = findField(availableKeys, 'data', 'date', 'created_at');
  const campaignField     = findField(availableKeys, 'campaign_name');
  const invField          = findField(availableKeys, 'investimento', 'investment', 'custo');
  const leadsField        = findField(availableKeys, 'leads');
  const mqlField          = findField(availableKeys, 'mql', 'mqls');
  const inscField         = findField(availableKeys, 'inscricoes', 'inscrições', 'inscricao');
  const matField          = findField(availableKeys, 'matriculas', 'matricula', 'matrículas');
  const tipoCampanhaField = findField(availableKeys, 'tipo_campanha');
  const produtoField      = findField(availableKeys, 'produto');

  if (!campaignField) return [];

  const sDate = start ? new Date(`${start}T00:00:00`).getTime() : null;
  const eDate = end   ? new Date(`${end}T23:59:59`).getTime()   : null;

  const grouped: Record<string, { inv: number; leads: number; mql: number; ins: number; mat: number }> = {};

  for (const d of data) {
    if (dateField && sDate && eDate) {
      const dd = parseLocalDate(d[dateField]);
      if (isNaN(dd) || dd < sDate || dd > eDate) continue;
    }
    if (tipoCampanha && tipoCampanha !== 'all' && tipoCampanhaField) {
      if (d[tipoCampanhaField] !== tipoCampanha) continue;
    }
    if (produto && produto !== 'all' && produtoField) {
      if (d[produtoField] !== produto) continue;
    }

    const campanha = String(d[campaignField] ?? '').trim();
    if (!campanha || campanha === '(not set)') continue;

    if (!grouped[campanha]) grouped[campanha] = { inv: 0, leads: 0, mql: 0, ins: 0, mat: 0 };
    const g = grouped[campanha];
    if (invField)   g.inv   += safeNum(d[invField]);
    if (leadsField) g.leads += safeNum(d[leadsField]);
    if (mqlField)   g.mql   += safeNum(d[mqlField]);
    if (inscField)  g.ins   += safeNum(d[inscField]);
    if (matField)   g.mat   += safeNum(d[matField]);
  }

  return Object.entries(grouped).map(([campanha, g]) => ({
    campanha,
    investimento:  g.inv,
    leads:         g.leads,
    mql:           g.mql,
    inscricoes:    g.ins,
    matriculas:    g.mat,
    cpmql:         g.mql > 0 ? g.inv / g.mql  : null,
    cpi:           g.ins > 0 ? g.inv / g.ins  : null,
    cac:           g.mat > 0 ? g.inv / g.mat  : null,
    conv_mql_mat:  g.mql > 0 ? (g.mat / g.mql) * 100 : null,
  }));
}

// ── Course aggregation ───────────────────────────────────────────────────────

interface CourseOpts {
  data: any[];
  availableKeys: string[];
  start: string;
  end: string;
  tipoCampanha: string;
}

function aggregateCourses(opts: CourseOpts) {
  const { data, availableKeys, start, end, tipoCampanha } = opts;
  if (!data.length) return [];

  const dateField          = findField(availableKeys, 'data', 'date', 'created_at');
  const invField           = findField(availableKeys, 'investimento', 'investment', 'custo');
  const leadsField         = findField(availableKeys, 'leads');
  const mqlField           = findField(availableKeys, 'mql', 'mqls');
  const inscField          = findField(availableKeys, 'inscricoes', 'inscrições', 'inscricao');
  const matField           = findField(availableKeys, 'matriculas', 'matricula', 'matrículas');
  const tipoCampanhaField  = findField(availableKeys, 'tipo_campanha');
  const courseNameCampanha = findField(availableKeys, 'course_name_campanha');
  const courseNameCaptacao = findField(availableKeys, 'course_name_captacao');

  const sDate = start ? new Date(`${start}T00:00:00`).getTime() : null;
  const eDate = end   ? new Date(`${end}T23:59:59`).getTime()   : null;

  const passBase = (d: any): boolean => {
    if (dateField && sDate && eDate) {
      const dd = parseLocalDate(d[dateField]);
      if (isNaN(dd) || dd < sDate || dd > eDate) return false;
    }
    if (tipoCampanha && tipoCampanha !== 'all' && tipoCampanhaField) {
      if (d[tipoCampanhaField] !== tipoCampanha) return false;
    }
    return true;
  };

  const midiaMap:  Record<string, { inv: number }> = {};
  const captMap:   Record<string, { leads: number; mql: number; ins: number; mat: number }> = {};

  for (const d of data) {
    if (!passBase(d)) continue;

    if (courseNameCampanha) {
      const nome = String(d[courseNameCampanha] ?? '').trim();
      if (nome && nome !== '(not set)') {
        if (!midiaMap[nome]) midiaMap[nome] = { inv: 0 };
        if (invField) midiaMap[nome].inv += safeNum(d[invField]);
      }
    }
    if (courseNameCaptacao) {
      const nome = String(d[courseNameCaptacao] ?? '').trim();
      if (nome && nome !== '(not set)') {
        if (!captMap[nome]) captMap[nome] = { leads: 0, mql: 0, ins: 0, mat: 0 };
        if (leadsField) captMap[nome].leads += safeNum(d[leadsField]);
        if (mqlField)   captMap[nome].mql   += safeNum(d[mqlField]);
        if (inscField)  captMap[nome].ins   += safeNum(d[inscField]);
        if (matField)   captMap[nome].mat   += safeNum(d[matField]);
      }
    }
  }

  const allCourses = new Set([...Object.keys(midiaMap), ...Object.keys(captMap)]);
  const rows: any[] = [];

  for (const curso of allCourses) {
    const m = midiaMap[curso] ?? { inv: 0 };
    const c = captMap[curso]  ?? { leads: 0, mql: 0, ins: 0, mat: 0 };
    rows.push({
      curso,
      investimento:  m.inv,
      leads:         c.leads,
      mql:           c.mql,
      inscricoes:    c.ins,
      matriculas:    c.mat,
      cpmql:         c.mql > 0 ? m.inv / c.mql  : null,
      cpi:           c.ins > 0 ? m.inv / c.ins  : null,
      cac:           c.mat > 0 ? m.inv / c.mat  : null,
      conv_mql_mat:  c.mql > 0 ? (c.mat / c.mql) * 100 : null,
    });
  }

  return rows;
}

// ── Message dispatcher ───────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const { type, payload, id } = e.data;
  try {
    let result: any;
    if (type === 'aggregateCampaigns') {
      result = aggregateCampaigns(payload);
    } else if (type === 'aggregateCourses') {
      result = aggregateCourses(payload);
    } else {
      throw new Error(`Unknown message type: ${type}`);
    }
    self.postMessage({ id, type: 'result', result });
  } catch (err: any) {
    self.postMessage({ id, type: 'error', message: err?.message ?? String(err) });
  }
};

export {}; // make TypeScript treat this as a module
