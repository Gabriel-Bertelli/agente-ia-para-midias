/**
 * Web Worker para Agregação de Cursos
 * Executa em thread paralela, não bloqueia UI
 */

// ── Message Types ─────────────────────────────────────────────────────────

interface CourseAggregationRequest {
  id: string;
  type: 'aggregate-courses';
  data: any[];
  availableKeys: string[];
  opts: {
    start: string;
    end: string;
    tipoCampanha: string;
  };
}

interface CourseAggregationResponse {
  id: string;
  type: 'aggregate-courses-result';
  result: Array<{
    curso: string;
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

function aggregateCourses(
  data: any[],
  availableKeys: string[],
  opts: { start: string; end: string; tipoCampanha: string }
) {
  if (!data.length) return [];

  const dateField = findField(availableKeys, 'data', 'date', 'created_at');
  const invField = findField(availableKeys, 'investimento', 'investment', 'custo');
  const leadsField = findField(availableKeys, 'leads');
  const mqlField = findField(availableKeys, 'mql', 'mqls');
  const inscField = findField(availableKeys, 'inscricoes', 'inscrições', 'inscricao');
  const matField = findField(availableKeys, 'matriculas', 'matricula', 'matrículas');
  const tipoCampanhaField = findField(availableKeys, 'tipo_campanha');
  const courseNameCampanha = findField(availableKeys, 'course_name_campanha');
  const courseNameCaptacao = findField(availableKeys, 'course_name_captacao');

  const sDate = opts.start ? new Date(`${opts.start}T00:00:00`) : null;
  const eDate = opts.end ? new Date(`${opts.end}T23:59:59`) : null;

  // Base filter: date + tipo_campanha
  const passBase = (d: any): boolean => {
    if (dateField && sDate && eDate) {
      const dd = parseLocalDate(d[dateField]);
      if (isNaN(dd.getTime()) || dd < sDate || dd > eDate) return false;
    }
    if (opts.tipoCampanha && opts.tipoCampanha !== 'all' && tipoCampanhaField) {
      if (d[tipoCampanhaField] !== opts.tipoCampanha) return false;
    }
    return true;
  };

  const baseRows = data.filter(passBase);

  // Pass 1 — mídia: group by course_name_campanha
  const midiaMap: Record<string, { inv: number }> = {};
  for (const d of baseRows) {
    if (!courseNameCampanha) continue;
    const nome = String(d[courseNameCampanha] ?? '').trim();
    if (!nome || nome === '(not set)') continue;
    if (!midiaMap[nome]) midiaMap[nome] = { inv: 0 };
    if (invField) midiaMap[nome].inv += safeNum(d[invField]);
  }

  // Pass 2 — captação: group by course_name_captacao
  const captMap: Record<string, { leads: number; mql: number; ins: number; mat: number }> = {};
  for (const d of baseRows) {
    if (!courseNameCaptacao) continue;
    const nome = String(d[courseNameCaptacao] ?? '').trim();
    if (!nome || nome === '(not set)') continue;
    if (!captMap[nome]) captMap[nome] = { leads: 0, mql: 0, ins: 0, mat: 0 };
    if (leadsField) captMap[nome].leads += safeNum(d[leadsField]);
    if (mqlField) captMap[nome].mql += safeNum(d[mqlField]);
    if (inscField) captMap[nome].ins += safeNum(d[inscField]);
    if (matField) captMap[nome].mat += safeNum(d[matField]);
  }

  // Merge
  const allCourses = new Set([...Object.keys(midiaMap), ...Object.keys(captMap)]);
  const rows = [];

  for (const curso of allCourses) {
    const m = midiaMap[curso] ?? { inv: 0 };
    const c = captMap[curso] ?? { leads: 0, mql: 0, ins: 0, mat: 0 };

    const inv = m.inv;
    const mql = c.mql;
    const mat = c.mat;
    const ins = c.ins;

    rows.push({
      curso,
      investimento: inv,
      leads: c.leads,
      mql,
      inscricoes: ins,
      matriculas: mat,
      cpmql: mql > 0 ? inv / mql : null,
      cpi: ins > 0 ? inv / ins : null,
      cac: mat > 0 ? inv / mat : null,
      conv_mql_mat: mql > 0 ? (mat / mql) * 100 : null,
    });
  }

  return rows;
}

// ── Worker Message Handler ────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<CourseAggregationRequest>) => {
  const { id, type, data, availableKeys, opts } = event.data;

  if (type !== 'aggregate-courses') {
    self.postMessage({
      id,
      type: 'error',
      message: `Unknown message type: ${type}`,
    } as ErrorResponse);
    return;
  }

  try {
    const startTime = performance.now();
    const result = aggregateCourses(data, availableKeys, opts);
    const endTime = performance.now();

    self.postMessage({
      id,
      type: 'aggregate-courses-result',
      result,
      duration: endTime - startTime,
    } as CourseAggregationResponse);
  } catch (error) {
    self.postMessage({
      id,
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
    } as ErrorResponse);
  }
};

export {};
