import React, { useMemo, useState } from 'react';
import {
  TrendingUp, TrendingDown, Minus, AlertCircle, DollarSign, Info,
  ChevronDown, ChevronUp, ChevronsUpDown, Filter, X, BookOpen,
  ToggleLeft, ToggleRight, Settings2,
} from 'lucide-react';

// ── Constants ───────────────────────────────────────────────────────────────

const PAID_TYPES_DEFAULT = new Set([
  'facebook catalogo', 'google youtube', 'lead ads', 'facebook outros',
  'google outros', 'bing ads', 'google pmax', 'google search',
  'lead ads guia', 'meta site', 'outros pagos', 'guia curso site',
]);

const CAC_WINDOW_DAYS  = 20;   // janela de score do curso
const CAC_HISTORY_DAYS = 60;   // janela histórica das campanhas individuais
const MAX_CHANGE       = 0.35; // piso fixo −35% e teto padrão +35%

// Score faixas: delta = (CAC_curso_20d - media_geral) / media_geral
// Negativo = melhor que a média (CAC menor é melhor)
type CourseScore = 'excellent' | 'good' | 'neutral' | 'attention' | 'poor' | 'no_data';

const SCORE_CONFIG: Record<CourseScore, {
  label: string; emoji: string; color: string; bg: string;
  border: string; maxChange: number;
}> = {
  excellent: { label: 'Excelente', emoji: '🟢', color: '#059669', bg: 'rgba(5,150,105,0.08)',   border: 'rgba(5,150,105,0.25)',   maxChange: 0.60 },
  good:      { label: 'Bom',       emoji: '🔵', color: '#2563eb', bg: 'rgba(37,99,235,0.08)',   border: 'rgba(37,99,235,0.25)',   maxChange: 0.50 },
  neutral:   { label: 'Neutro',    emoji: '⚪', color: '#64748b', bg: 'rgba(100,116,139,0.06)', border: 'rgba(100,116,139,0.2)',  maxChange: 0.35 },
  attention: { label: 'Atenção',   emoji: '🟡', color: '#d97706', bg: 'rgba(217,119,6,0.08)',   border: 'rgba(217,119,6,0.25)',   maxChange: 0.15 },
  poor:      { label: 'Ruim',      emoji: '🔴', color: '#dc2626', bg: 'rgba(220,38,38,0.08)',   border: 'rgba(220,38,38,0.25)',   maxChange: 0.00 },
  no_data:   { label: 'Sem dados', emoji: '⚫', color: '#94a3b8', bg: 'rgba(148,163,184,0.06)', border: 'rgba(148,163,184,0.2)',  maxChange: 0.00 },
};

function deltaToScore(delta: number | null): CourseScore {
  if (delta === null) return 'no_data';
  if (delta <= -0.30) return 'excellent';
  if (delta <= -0.10) return 'good';
  if (delta <=  0.10) return 'neutral';
  if (delta <=  0.30) return 'attention';
  return 'poor';
}

// ── Types ───────────────────────────────────────────────────────────────────

interface CourseCAC {
  course:        string;
  cac_paid_20d:  number | null;
  cac_total_20d: number | null;
  inv_20d:       number;
  mat_paid_20d:  number;
  mat_total_20d: number;
  score_paid:    CourseScore;
  score_total:   CourseScore;
  delta_paid:    number | null;
  delta_total:   number | null;
}

interface CampaignMetrics {
  campaign:           string;
  courses:            string[];
  isMultiCourse:      boolean;
  inv_current:        number;
  inv_30d_total:      number;
  cac_20d:            number | null;
  cac_60d:            number | null;
  cac_weighted:       number | null;
  effectiveMaxChange: number;
}

interface AllocationResult {
  campaign:           string;
  courses:            string[];
  isMultiCourse:      boolean;
  inv_current:        number;
  cac_weighted:       number | null;
  inv_suggested:      number;
  inv_min:            number;
  inv_max:            number;
  delta_pct:          number;
  delta_abs:          number;
  capped:             boolean;
  cappedBy:           'max' | 'min' | null;
  courseScore:        CourseScore;
  effectiveMaxChange: number;
}

interface CourseAlert {
  course:          string;
  score:           CourseScore;
  cappedCampaigns: string[];
}

interface SuggestionResult {
  allocations:     AllocationResult[];
  total_allocated: number;
  total_target:    number;
  leftover:        number;
  hit_limit:       boolean;
  courseAlerts:    CourseAlert[];
  message:         string | null;
}

type CacMode = 'paid' | 'total';
type SortCol = 'campaign' | 'course' | 'score' | 'cac_20d' | 'cac_weighted' |
               'inv_current' | 'inv_suggested' | 'delta_pct' | 'effectiveMaxChange';
type SortDir = 'asc' | 'desc';

// ── Helpers ─────────────────────────────────────────────────────────────────

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
const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

function windowBounds(refDate: Date, days: number): { cutoff: Date; end: Date } {
  const end = new Date(refDate);
  end.setHours(23, 59, 59, 999);
  const cutoff = new Date(refDate);
  cutoff.setDate(cutoff.getDate() - days + 1);
  cutoff.setHours(0, 0, 0, 0);
  return { cutoff, end };
}

function inWindow(dd: Date, cutoff: Date, end: Date): boolean {
  return !isNaN(dd.getTime()) && dd >= cutoff && dd <= end;
}

// ── Stage 1: Course CAC engine ───────────────────────────────────────────────

function buildCourseCACMap(
  data: any[],
  keys: string[],
  refDate: Date,
  paidTypesNorm: Set<string>,
): Map<string, CourseCAC> {
  const dateField          = findField(keys, 'data', 'date', 'created_at');
  const invField           = findField(keys, 'investimento', 'investment', 'custo');
  const matField           = findField(keys, 'matriculas', 'matricula', 'matrículas');
  const tipoCampanhaField  = findField(keys, 'tipo_campanha');
  const courseNameCampanha = findField(keys, 'course_name_campanha', 'course_name_campaign');
  const courseNameCaptacao = findField(keys, 'course_name_captacao');

  if (!dateField || !invField || !matField) return new Map();

  const { cutoff: cut20, end: end20 } = windowBounds(refDate, CAC_WINDOW_DAYS);

  const acc = new Map<string, { inv_paid: number; inv_total: number; mat_paid: number; mat_total: number }>();

  const ensure = (course: string) => {
    if (!acc.has(course)) acc.set(course, { inv_paid: 0, inv_total: 0, mat_paid: 0, mat_total: 0 });
    return acc.get(course)!;
  };

  for (const row of data) {
    const dd = parseLocalDate(row[dateField]);
    if (!inWindow(dd, cut20, end20)) continue;

    const tipo   = String(row[tipoCampanhaField ?? ''] ?? '').toLowerCase().trim();
    const isPaid = paidTypesNorm.has(tipo);

    // Cost side: course_name_campanha
    if (courseNameCampanha) {
      const course = String(row[courseNameCampanha] ?? '').trim();
      if (course && course !== '(not set)') {
        const inv = safeNum(row[invField]);
        const b   = ensure(course);
        b.inv_total += inv;
        if (isPaid) b.inv_paid += inv;
      }
    }

    // Conversion side: course_name_captacao
    if (courseNameCaptacao) {
      const course = String(row[courseNameCaptacao] ?? '').trim();
      if (course && course !== '(not set)') {
        const mat = safeNum(row[matField]);
        const b   = ensure(course);
        b.mat_total += mat;
        if (isPaid) b.mat_paid += mat;
      }
    }
  }

  const result = new Map<string, CourseCAC>();
  for (const [course, b] of acc) {
    result.set(course, {
      course,
      cac_paid_20d:  b.mat_paid  > 0 ? b.inv_paid  / b.mat_paid  : null,
      cac_total_20d: b.mat_total > 0 ? b.inv_total / b.mat_total : null,
      inv_20d:       b.inv_total,
      mat_paid_20d:  b.mat_paid,
      mat_total_20d: b.mat_total,
      score_paid:  'no_data',
      score_total: 'no_data',
      delta_paid:  null,
      delta_total: null,
    });
  }

  // Global averages → scores
  const cacsPaid  = Array.from(result.values()).map(c => c.cac_paid_20d).filter((v): v is number => v !== null);
  const cacsTotal = Array.from(result.values()).map(c => c.cac_total_20d).filter((v): v is number => v !== null);
  const avgPaid   = cacsPaid.length  > 0 ? cacsPaid.reduce((s, v)  => s + v, 0)  / cacsPaid.length  : null;
  const avgTotal  = cacsTotal.length > 0 ? cacsTotal.reduce((s, v) => s + v, 0) / cacsTotal.length : null;

  for (const c of result.values()) {
    if (c.cac_paid_20d !== null && avgPaid !== null && avgPaid > 0) {
      c.delta_paid  = (c.cac_paid_20d  - avgPaid)  / avgPaid;
      c.score_paid  = deltaToScore(c.delta_paid);
    }
    if (c.cac_total_20d !== null && avgTotal !== null && avgTotal > 0) {
      c.delta_total = (c.cac_total_20d - avgTotal) / avgTotal;
      c.score_total = deltaToScore(c.delta_total);
    }
  }

  return result;
}

// ── Campaign-level CAC helpers ───────────────────────────────────────────────

function calcCacInWindow(
  rows: any[], campaignField: string, invField: string, matField: string,
  dateField: string, campaign: string, refDate: Date, windowDays: number,
): number | null {
  const { cutoff, end } = windowBounds(refDate, windowDays);
  let inv = 0, mat = 0;
  for (const d of rows) {
    if (String(d[campaignField]) !== campaign) continue;
    const dd = parseLocalDate(d[dateField]);
    if (!inWindow(dd, cutoff, end)) continue;
    inv += safeNum(d[invField]);
    mat += safeNum(d[matField]);
  }
  return mat > 0 ? inv / mat : null;
}

function calcInvInWindow(
  rows: any[], campaignField: string, invField: string,
  dateField: string, campaign: string, refDate: Date, windowDays: number,
): number {
  const { cutoff, end } = windowBounds(refDate, windowDays);
  let inv = 0;
  for (const d of rows) {
    if (String(d[campaignField]) !== campaign) continue;
    const dd = parseLocalDate(d[dateField]);
    if (!inWindow(dd, cutoff, end)) continue;
    inv += safeNum(d[invField]);
  }
  return windowDays > 0 ? inv / windowDays : 0;
}

function calcWeightedCac(cac_60d: number | null, cac_20d: number | null): number | null {
  // 60d×1 + 20d×3 — pesa mais o recente
  const slots: [number | null, number][] = [[cac_60d, 1], [cac_20d, 3]];
  let sum = 0, totalW = 0;
  for (const [cac, w] of slots) {
    if (cac !== null && cac > 0) { sum += cac * w; totalW += w; }
  }
  return totalW > 0 ? sum / totalW : null;
}

// ── Effective max change for a campaign (from course score) ──────────────────

function resolveEffectiveMaxChange(
  courses: string[],
  courseShare: Map<string, number>,
  courseMap: Map<string, CourseCAC>,
  cacMode: CacMode,
): number {
  if (courses.length === 0) return 0; // sem curso = sem dados = teto 0%
  if (courses.length === 1) {
    const c     = courseMap.get(courses[0]);
    const score = c ? (cacMode === 'paid' ? c.score_paid : c.score_total) : 'no_data';
    return SCORE_CONFIG[score].maxChange;
  }
  // Multi-curso: média ponderada por share de investimento
  let totalShare = 0, weightedMax = 0;
  for (const course of courses) {
    const share = courseShare.get(course) ?? 0;
    const c     = courseMap.get(course);
    const score = c ? (cacMode === 'paid' ? c.score_paid : c.score_total) : 'no_data';
    weightedMax += SCORE_CONFIG[score].maxChange * share;
    totalShare  += share;
  }
  return totalShare > 0 ? weightedMax / totalShare : 0;
}

function resolveScore(
  courses: string[],
  courseMap: Map<string, CourseCAC>,
  cacMode: CacMode,
): CourseScore {
  if (courses.length === 0) return 'no_data';
  const c = courseMap.get(courses[0]);
  if (!c) return 'no_data';
  return cacMode === 'paid' ? c.score_paid : c.score_total;
}

// ── Stage 2: Allocation engine ───────────────────────────────────────────────

function allocate(
  campaigns: CampaignMetrics[],
  targetTotal: number,
  courseMap: Map<string, CourseCAC>,
  cacMode: CacMode,
): SuggestionResult {
  const currentTotal = campaigns.reduce((s, c) => s + c.inv_current, 0);
  const isIncreasing = targetTotal >= currentTotal;

  const withLimits = campaigns.map(c => ({
    ...c,
    inv_min: c.inv_current * (1 - MAX_CHANGE),
    inv_max: c.inv_current * (1 + c.effectiveMaxChange),
  }));

  const withCac    = withLimits.filter(c => c.cac_weighted !== null && c.cac_weighted > 0);
  const withoutCac = withLimits.filter(c => c.cac_weighted === null || c.cac_weighted === 0);

  // Campanhas sem CAC: mantém se aumentando, piso se reduzindo
  const noCacAllocs: AllocationResult[] = withoutCac.map(c => {
    const inv_suggested = isIncreasing ? c.inv_current : c.inv_min;
    return {
      campaign: c.campaign, courses: c.courses, isMultiCourse: c.isMultiCourse,
      inv_current: c.inv_current, cac_weighted: null,
      inv_suggested, inv_min: c.inv_min, inv_max: c.inv_max,
      delta_abs: inv_suggested - c.inv_current,
      delta_pct: c.inv_current > 0 ? ((inv_suggested - c.inv_current) / c.inv_current) * 100 : 0,
      capped: !isIncreasing, cappedBy: !isIncreasing ? ('min' as const) : null,
      courseScore: resolveScore(c.courses, courseMap, cacMode),
      effectiveMaxChange: c.effectiveMaxChange,
    };
  });

  const fixedTotal   = noCacAllocs.reduce((s, a) => s + a.inv_suggested, 0);
  const budgetForCac = targetTotal - fixedTotal;

  const mins     = withCac.map(c => c.inv_min);
  const maxs     = withCac.map(c => c.inv_max);
  const totalMin = mins.reduce((s, v) => s + v, 0);
  const totalMax = maxs.reduce((s, v) => s + v, 0);

  const effectiveBudget = Math.min(Math.max(budgetForCac, totalMin), totalMax);
  const suggested       = [...mins];
  let remaining         = effectiveBudget - totalMin;

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
          overflow    += extra - headroom[i];
          suggested[i] = maxs[i];
        } else {
          suggested[i] = mins[i] + extra;
          newFree.push(i);
        }
      }
      remaining = overflow;
      free = newFree;
    }
  }

  const cacAllocs: AllocationResult[] = withCac.map((c, i) => {
    const inv_s     = Math.round(suggested[i] * 100) / 100;
    const delta_abs = inv_s - c.inv_current;
    const atMax     = Math.abs(inv_s - maxs[i]) < 0.5;
    const atMin     = Math.abs(inv_s - mins[i]) < 0.5;
    return {
      campaign: c.campaign, courses: c.courses, isMultiCourse: c.isMultiCourse,
      inv_current: c.inv_current, cac_weighted: c.cac_weighted,
      inv_suggested: inv_s,
      inv_min: Math.round(mins[i] * 100) / 100,
      inv_max: Math.round(maxs[i] * 100) / 100,
      delta_abs,
      delta_pct: c.inv_current > 0 ? (delta_abs / c.inv_current) * 100 : 0,
      capped: atMax || atMin,
      cappedBy: atMax ? ('max' as const) : atMin ? ('min' as const) : null,
      courseScore: resolveScore(c.courses, courseMap, cacMode),
      effectiveMaxChange: c.effectiveMaxChange,
    };
  });

  const allocations     = [...cacAllocs, ...noCacAllocs];
  const total_allocated = Math.round(allocations.reduce((s, a) => s + a.inv_suggested, 0) * 100) / 100;
  const leftover        = Math.round(Math.abs(targetTotal - total_allocated) * 100) / 100;
  const hit_limit       = leftover > 1.0;

  // Alertas: cursos com bom score mas campanhas travadas no teto
  const byPrimaryCourse = new Map<string, AllocationResult[]>();
  for (const alloc of allocations) {
    const course = alloc.courses[0] ?? '(sem curso)';
    if (!byPrimaryCourse.has(course)) byPrimaryCourse.set(course, []);
    byPrimaryCourse.get(course)!.push(alloc);
  }
  const courseAlerts: CourseAlert[] = [];
  for (const [course, allocs] of byPrimaryCourse) {
    const capped = allocs.filter(a => a.cappedBy === 'max').map(a => a.campaign);
    if (capped.length === 0) continue;
    const c     = courseMap.get(course);
    const score = c ? (cacMode === 'paid' ? c.score_paid : c.score_total) : 'no_data';
    if (score === 'excellent' || score === 'good') {
      courseAlerts.push({ course, score, cappedCampaigns: capped });
    }
  }

  const reachableMin = Math.round(allocations.reduce((s, a) => s + a.inv_min, 0) * 100) / 100;
  const reachableMax = Math.round(allocations.reduce((s, a) => s + a.inv_max, 0) * 100) / 100;

  let message: string | null = null;
  if (hit_limit) {
    if (targetTotal > reachableMax) {
      message = `O alvo de ${fmtBRL(targetTotal)}/dia excede o máximo alocável de ${fmtBRL(reachableMax)}/dia com as regras de score por curso e ±35%. Saldo não distribuído: ${fmtBRL(leftover)}.`;
    } else if (targetTotal < reachableMin) {
      message = `O alvo de ${fmtBRL(targetTotal)}/dia está abaixo do mínimo de ${fmtBRL(reachableMin)}/dia com a regra de −35%. Alocado ${fmtBRL(total_allocated)}.`;
    } else {
      message = `Alocado ${fmtBRL(total_allocated)} de ${fmtBRL(targetTotal)}. Saldo restante: ${fmtBRL(leftover)}.`;
    }
  }

  return { allocations, total_allocated, total_target: targetTotal, leftover, hit_limit, courseAlerts, message };
}

// ── Sort helper ──────────────────────────────────────────────────────────────

function sortValue(cm: CampaignMetrics, alloc: AllocationResult | undefined, col: SortCol): number | string {
  switch (col) {
    case 'campaign':           return cm.campaign;
    case 'course':             return cm.courses[0] ?? '';
    case 'score':              return SCORE_CONFIG[alloc?.courseScore ?? 'no_data'].maxChange;
    case 'cac_20d':            return cm.cac_20d      ?? Infinity;
    case 'cac_weighted':       return cm.cac_weighted ?? Infinity;
    case 'inv_current':        return cm.inv_current;
    case 'inv_suggested':      return alloc?.inv_suggested ?? cm.inv_current;
    case 'delta_pct':          return alloc?.delta_pct ?? 0;
    case 'effectiveMaxChange': return cm.effectiveMaxChange;
    default: return 0;
  }
}

// ── Main Component ───────────────────────────────────────────────────────────

export function InvestmentSuggestion({ data }: { data: any[] }) {
  const [targetInput,    setTargetInput]    = useState('');
  const [showDetails,    setShowDetails]    = useState(false);
  const [showPaidConfig, setShowPaidConfig] = useState(false);
  const [search,         setSearch]         = useState('');
  const [sortCol,        setSortCol]        = useState<SortCol>('score');
  const [sortDir,        setSortDir]        = useState<SortDir>('desc');
  const [filterNoCac,    setFilterNoCac]    = useState(false);
  const [cacMode,        setCacMode]        = useState<CacMode>('paid');
  const [paidTypes,      setPaidTypes]      = useState<Set<string>>(() => new Set(PAID_TYPES_DEFAULT));

  const keys = useMemo(() => (data.length > 0 ? Object.keys(data[0]) : []), [data]);

  const dateField          = useMemo(() => findField(keys, 'data', 'date', 'created_at'), [keys]);
  const campaignField      = useMemo(() => findField(keys, 'campaign_name'), [keys]);
  const invField           = useMemo(() => findField(keys, 'investimento', 'investment', 'custo'), [keys]);
  const matField           = useMemo(() => findField(keys, 'matriculas', 'matricula', 'matrículas'), [keys]);
  const tipoCampanhaField  = useMemo(() => findField(keys, 'tipo_campanha'), [keys]);
  const courseNameCampanha = useMemo(() => findField(keys, 'course_name_campanha', 'course_name_campaign'), [keys]);

  // Detect all tipos from base; new ones start unchecked
  const allTipos = useMemo(() => {
    if (!tipoCampanhaField) return [] as string[];
    return Array.from(new Set(
      data.map(d => String(d[tipoCampanhaField] ?? '').trim()).filter(Boolean)
    )).sort();
  }, [data, tipoCampanhaField]);

  const togglePaidType = (tipo: string) => {
    setPaidTypes(prev => {
      const next = new Set(prev);
      next.has(tipo) ? next.delete(tipo) : next.add(tipo);
      return next;
    });
  };

  // Normalize for case-insensitive comparison
  const paidTypesNorm = useMemo(() =>
    new Set(Array.from(paidTypes).map(t => t.toLowerCase().trim())),
  [paidTypes]);

  const todayRef = useMemo(() => new Date(), []);
  const refDate  = useMemo(() => {
    if (!dateField || !data.length) return todayRef;
    const dates = data.map(d => parseLocalDate(d[dateField])).filter(d => !isNaN(d.getTime()));
    if (!dates.length) return todayRef;
    return new Date(Math.max(...dates.map(d => d.getTime())));
  }, [data, dateField, todayRef]);

  // ── Stage 1: Course CAC map ────────────────────────────────────────────────

  const courseMap = useMemo(() =>
    buildCourseCACMap(data, keys, refDate, paidTypesNorm),
  [data, keys, refDate, paidTypesNorm]);

  // ── Campaign list ──────────────────────────────────────────────────────────

  const campaigns = useMemo(() => {
    if (!campaignField) return [] as string[];
    return Array.from(new Set(data.map(d => String(d[campaignField])).filter(Boolean)));
  }, [data, campaignField]);

  // Investment share per course per campaign (for multi-curso weighted teto)
  const campaignCourseShare = useMemo(() => {
    const shareMap = new Map<string, Map<string, number>>();
    if (!campaignField || !courseNameCampanha || !invField) return shareMap;
    for (const row of data) {
      const campaign = String(row[campaignField] ?? '').trim();
      const course   = String(row[courseNameCampanha] ?? '').trim();
      const inv      = safeNum(row[invField]);
      if (!campaign || !course || course === '(not set)') continue;
      if (!shareMap.has(campaign)) shareMap.set(campaign, new Map());
      const m = shareMap.get(campaign)!;
      m.set(course, (m.get(course) ?? 0) + inv);
    }
    return shareMap;
  }, [data, campaignField, courseNameCampanha, invField]);

  // ── Stage 1b: Campaign metrics ─────────────────────────────────────────────

  const campaignMetrics = useMemo((): CampaignMetrics[] => {
    if (!campaignField || !invField || !matField || !dateField) return [];

    return campaigns.map(campaign => {
      const courseShareRaw = campaignCourseShare.get(campaign) ?? new Map<string, number>();
      const totalCourseInv = Array.from(courseShareRaw.values()).reduce((s, v) => s + v, 0);
      const courseShare    = new Map(
        Array.from(courseShareRaw.entries()).map(([c, v]) => [c, totalCourseInv > 0 ? v / totalCourseInv : 0])
      );
      const courseList = Array.from(courseShare.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([c]) => c);

      const cac_20d      = calcCacInWindow(data, campaignField, invField, matField, dateField, campaign, refDate, CAC_WINDOW_DAYS);
      const cac_60d      = calcCacInWindow(data, campaignField, invField, matField, dateField, campaign, refDate, CAC_HISTORY_DAYS);
      const cac_weighted = calcWeightedCac(cac_60d, cac_20d);

      const inv_7d_daily  = calcInvInWindow(data, campaignField, invField, dateField, campaign, refDate, 7);
      const inv_30d_daily = calcInvInWindow(data, campaignField, invField, dateField, campaign, refDate, 30);
      const inv_current   = inv_7d_daily > 0 ? inv_7d_daily : inv_30d_daily;
      const inv_30d_total = inv_30d_daily * 30;

      const effectiveMaxChange = resolveEffectiveMaxChange(courseList, courseShare, courseMap, cacMode);

      return {
        campaign, courses: courseList, isMultiCourse: courseList.length > 1,
        inv_current, inv_30d_total, cac_20d, cac_60d, cac_weighted, effectiveMaxChange,
      };
    }).filter(c => c.inv_30d_total > 0);
  }, [data, campaigns, campaignField, invField, matField, dateField, refDate,
      campaignCourseShare, courseMap, cacMode]);

  const currentTotalDaily = useMemo(() =>
    campaignMetrics.reduce((s, c) => s + c.inv_current, 0), [campaignMetrics]);

  const targetValue = useMemo(() => {
    const raw = targetInput.replace(/[R$\s.]/g, '').replace(',', '.');
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [targetInput]);

  const result = useMemo((): SuggestionResult | null => {
    if (targetValue === null || campaignMetrics.length === 0) return null;
    return allocate(campaignMetrics, targetValue, courseMap, cacMode);
  }, [targetValue, campaignMetrics, courseMap, cacMode]);

  // ── Display rows ───────────────────────────────────────────────────────────

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  const SortIcon = ({ col }: { col: SortCol }) => {
    if (sortCol !== col) return <ChevronsUpDown className="w-3 h-3 opacity-30" />;
    return sortDir === 'asc'
      ? <ChevronUp   className="w-3 h-3 text-emerald-600" />
      : <ChevronDown className="w-3 h-3 text-emerald-600" />;
  };

  const thCls = (col: SortCol, align: 'left' | 'right' = 'right') =>
    `px-3 py-3 text-${align} text-xs font-semibold uppercase tracking-wide cursor-pointer select-none whitespace-nowrap transition-colors hover:text-emerald-700 ${
      sortCol === col ? 'text-emerald-700 bg-emerald-50/60' : 'text-slate-500'
    }`;

  const displayRows = useMemo(() => {
    let rows = campaignMetrics.slice();
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(c =>
        c.campaign.toLowerCase().includes(q) ||
        c.courses.some(cr => cr.toLowerCase().includes(q))
      );
    }
    if (filterNoCac) rows = rows.filter(c => c.cac_weighted === null);

    const allocIndex = new Map(result?.allocations.map(a => [a.campaign, a]) ?? []);
    rows.sort((a, b) => {
      const allocA = allocIndex.get(a.campaign);
      const allocB = allocIndex.get(b.campaign);
      const va = sortValue(a, allocA, sortCol);
      const vb = sortValue(b, allocB, sortCol);
      let cmp = 0;
      if (typeof va === 'string' && typeof vb === 'string') cmp = va.localeCompare(vb);
      else cmp = (va as number) - (vb as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [campaignMetrics, search, filterNoCac, sortCol, sortDir, result]);

  // ── Guards ─────────────────────────────────────────────────────────────────

  if (!data.length) return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-12 text-center text-slate-500">
      <DollarSign className="w-12 h-12 mx-auto mb-3 opacity-20" />
      <p>Nenhum dado disponível.</p>
    </div>
  );

  if (!campaignField || !invField || !matField || !dateField) return (
    <div className="bg-amber-50 border border-amber-200 text-amber-700 p-4 rounded-xl text-sm flex items-start gap-3">
      <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
      <p>Campos necessários não encontrados: <code>campaign_name</code>, <code>investimento</code>, <code>matriculas</code>, <code>data</code>.</p>
    </div>
  );

  const coursesWithScore = Array.from(courseMap.values())
    .filter(c => (cacMode === 'paid' ? c.score_paid : c.score_total) !== 'no_data');

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2 mb-1">
              <DollarSign className="w-5 h-5 text-emerald-600" />
              Sugestão de Investimento — por Curso e Campanha
            </h2>
            <p className="text-sm text-slate-500">
              Score do curso (CAC {CAC_WINDOW_DAYS}d vs média geral) define o teto de cada campanha ·
              Referência: <strong>{refDate.toLocaleDateString('pt-BR')}</strong>
            </p>
          </div>
          <button onClick={() => setShowDetails(v => !v)}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg px-3 py-1.5 bg-slate-50 hover:bg-slate-100 transition-colors whitespace-nowrap">
            <Info className="w-3.5 h-3.5" />
            {showDetails ? 'Ocultar metodologia' : 'Ver metodologia'}
            {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>

        {showDetails && (
          <div className="mt-4 bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs text-slate-600 space-y-2">
            <p><strong>Estágio 1 — Score do curso:</strong> CAC dos últimos {CAC_WINDOW_DAYS} dias comparado à média de todos os cursos. O score define o teto de aumento permitido para as campanhas daquele curso.</p>
            <p><strong>Estágio 2 — Distribuição:</strong> water-filling proporcional ao inverso do CAC individual de cada campanha, dentro dos limites herdados do score do curso.</p>
            <p><strong>Regras de teto por score:</strong> 🟢 Excelente +60% · 🔵 Bom +50% · ⚪ Neutro +35% · 🟡 Atenção +15% · 🔴 Ruim 0% · ⚫ Sem dados 0%</p>
            <p><strong>Piso:</strong> −35% fixo para todas as campanhas, independente do score.</p>
            <p><strong>Multi-curso:</strong> teto calculado como média ponderada dos scores dos cursos, pelo share de investimento da campanha em cada um.</p>
            <p><strong>CAC da campanha:</strong> (CAC₆₀d×1 + CAC₂₀d×3) ÷ soma dos pesos — determina quem recebe mais dentro do mesmo curso.</p>
            <p><strong>CAC pago:</strong> usa apenas linhas com <code>tipo_campanha</code> marcado como pago. <strong>CAC total:</strong> inclui todas as origens.</p>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-center">

        {/* CAC mode toggle */}
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex items-center gap-3 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Driver do score</span>
          <button onClick={() => setCacMode(m => m === 'paid' ? 'total' : 'paid')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              cacMode === 'paid'
                ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                : 'bg-slate-50 border-slate-200 text-slate-600'
            }`}>
            {cacMode === 'paid' ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
            {cacMode === 'paid' ? 'CAC Pago' : 'CAC Total'}
          </button>
          <span className="text-xs text-slate-400">
            {cacMode === 'paid' ? 'Apenas campanhas pagas' : 'Todas as origens'}
          </span>
        </div>

        {/* Paid types config */}
        <button onClick={() => setShowPaidConfig(v => !v)}
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border transition-colors shadow-sm ${
            showPaidConfig
              ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}>
          <Settings2 className="w-3.5 h-3.5" />
          Tipos pagos ({paidTypes.size}/{allTipos.length})
        </button>
      </div>

      {/* Paid types panel */}
      {showPaidConfig && (
        <div className="bg-white rounded-xl border border-indigo-200 shadow-sm p-4">
          <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wide mb-3">
            Tipos de campanha considerados pagos para o CAC pago
          </p>
          <div className="flex flex-wrap gap-2">
            {allTipos.map(tipo => {
              const tipoNorm  = tipo.toLowerCase().trim();
              const checked   = paidTypes.has(tipo) || paidTypesNorm.has(tipoNorm);
              const isDefault = PAID_TYPES_DEFAULT.has(tipoNorm);
              return (
                <button key={tipo} onClick={() => togglePaidType(tipo)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    checked
                      ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                      : 'bg-slate-50 border-slate-200 text-slate-400'
                  }`}>
                  {checked ? '✓ ' : ''}{tipo}
                  {!isDefault && <span className="ml-1 text-amber-500 font-semibold">novo</span>}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-slate-400 mt-3">
            Tipos marcados com <span className="text-amber-500 font-semibold">novo</span> não estavam na lista padrão — verifique antes de incluir.
          </p>
        </div>
      )}

      {/* Course score summary */}
      {courseMap.size > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3 flex items-center gap-2">
            <BookOpen className="w-3.5 h-3.5" />
            Score dos cursos — CAC {CAC_WINDOW_DAYS}d vs média geral
            <span className="font-normal text-slate-400 normal-case">({cacMode === 'paid' ? 'CAC pago' : 'CAC total'})</span>
          </p>
          <div className="flex flex-wrap gap-2">
            {(Object.entries(SCORE_CONFIG) as [CourseScore, typeof SCORE_CONFIG[CourseScore]][]).map(([score, cfg]) => {
              const count = Array.from(courseMap.values()).filter(c =>
                (cacMode === 'paid' ? c.score_paid : c.score_total) === score
              ).length;
              if (count === 0) return null;
              return (
                <div key={score} style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium">
                  <span>{cfg.emoji}</span>
                  <span style={{ color: cfg.color }}>{cfg.label}</span>
                  <span className="font-bold" style={{ color: cfg.color }}>{count}</span>
                  <span className="text-slate-400">
                    cursos · teto {cfg.maxChange > 0 ? `+${(cfg.maxChange * 100).toFixed(0)}%` : '0%'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Investimento Atual / dia</div>
          <div className="text-2xl font-bold text-slate-900">{fmtBRL(currentTotalDaily)}</div>
          <div className="text-xs text-slate-400 mt-1">Média 7d · {campaignMetrics.length} campanhas ativas</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Cursos avaliados</div>
          <div className="text-2xl font-bold text-slate-900">
            {coursesWithScore.length}
            <span className="text-base font-normal text-slate-400"> / {courseMap.size}</span>
          </div>
          <div className="text-xs text-slate-400 mt-1">Com CAC calculado nos últimos {CAC_WINDOW_DAYS}d</div>
        </div>
        <div className="bg-white rounded-xl border border-emerald-200 shadow-sm p-5">
          <div className="text-xs text-emerald-600 uppercase tracking-wide font-semibold mb-1">Investimento Alvo / dia</div>
          <input type="text" value={targetInput} onChange={e => setTargetInput(e.target.value)}
            placeholder="Ex: 90000"
            className="w-full text-xl font-bold text-slate-900 bg-transparent border-b-2 border-emerald-400 focus:outline-none focus:border-emerald-600 pb-1 placeholder:text-slate-300 placeholder:font-normal placeholder:text-base" />
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
          <p>Distribuição calculada. Total alocado: <strong>{fmtBRL(result.total_allocated)}</strong></p>
        </div>
      )}

      {/* Course alerts */}
      {result && result.courseAlerts.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-2">
          <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5" />
            Cursos com bom score mas campanhas no limite individual de +35%
          </p>
          {result.courseAlerts.map(alert => {
            const cfg = SCORE_CONFIG[alert.score];
            return (
              <div key={alert.course} className="text-xs text-blue-800 flex items-start gap-2">
                <span>{cfg.emoji}</span>
                <span>
                  <strong>{alert.course}</strong> — {alert.cappedCampaigns.length > 1 ? 'as campanhas' : 'a campanha'}{' '}
                  {alert.cappedCampaigns.slice(0, 3).map(c => (
                    <code key={c} className="bg-blue-100 px-1 rounded mx-0.5">{c}</code>
                  ))}
                  {alert.cappedCampaigns.length > 3 && ` e mais ${alert.cappedCampaigns.length - 3}`}
                  {' '}atingiu o teto de +35% individual e não pôde absorver mais budget do curso.
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Table */}
      {campaignMetrics.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">

          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/50 flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-[200px]">
              <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Buscar campanha ou curso..."
                className="w-full pl-8 pr-8 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-400 bg-white" />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <button onClick={() => setFilterNoCac(v => !v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                filterNoCac ? 'bg-amber-100 border-amber-300 text-amber-800' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}>
              {filterNoCac ? '× ' : ''}Sem CAC
            </button>
            <span className="text-xs text-slate-400 ml-auto">{displayRows.length} de {campaignMetrics.length}</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th onClick={() => toggleSort('campaign')} className={thCls('campaign', 'left') + ' min-w-[190px]'}>
                    <span className="inline-flex items-center gap-1">Campanha <SortIcon col="campaign" /></span>
                  </th>
                  <th onClick={() => toggleSort('course')} className={thCls('course', 'left') + ' min-w-[150px]'}>
                    <span className="inline-flex items-center gap-1">Curso <SortIcon col="course" /></span>
                  </th>
                  <th onClick={() => toggleSort('score')} className={thCls('score')}>
                    <span className="inline-flex items-center justify-end gap-1">Score <SortIcon col="score" /></span>
                  </th>
                  <th onClick={() => toggleSort('effectiveMaxChange')} className={thCls('effectiveMaxChange')}>
                    <span className="inline-flex items-center justify-end gap-1">Teto <SortIcon col="effectiveMaxChange" /></span>
                  </th>
                  <th onClick={() => toggleSort('cac_20d')} className={thCls('cac_20d')}>
                    <span className="inline-flex items-center justify-end gap-1">CAC {CAC_WINDOW_DAYS}d <SortIcon col="cac_20d" /></span>
                  </th>
                  <th onClick={() => toggleSort('cac_weighted')} className={thCls('cac_weighted')}>
                    <span className="inline-flex items-center justify-end gap-1 text-emerald-700">CAC Pond. <SortIcon col="cac_weighted" /></span>
                  </th>
                  <th onClick={() => toggleSort('inv_current')} className={thCls('inv_current')}>
                    <span className="inline-flex items-center justify-end gap-1">Atual/dia <SortIcon col="inv_current" /></span>
                  </th>
                  {result && (
                    <>
                      <th onClick={() => toggleSort('inv_suggested')} className={thCls('inv_suggested')}>
                        <span className="inline-flex items-center justify-end gap-1 text-indigo-600">Sugerido <SortIcon col="inv_suggested" /></span>
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
                  const score  = alloc?.courseScore ?? 'no_data';
                  const cfg    = SCORE_CONFIG[score];

                  return (
                    <tr key={cm.campaign} className={`hover:bg-slate-50/60 transition-colors ${i % 2 === 1 ? 'bg-slate-50/20' : ''}`}>
                      <td className="px-3 py-3 font-medium text-slate-800 max-w-[220px]">
                        <span className="line-clamp-2 leading-snug text-xs">{cm.campaign}</span>
                      </td>
                      <td className="px-3 py-3 text-left max-w-[190px]">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs text-slate-600 line-clamp-1">{cm.courses[0] ?? '—'}</span>
                          {cm.isMultiCourse && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 border border-purple-200 whitespace-nowrap">
                              +{cm.courses.length - 1} cursos
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full"
                          style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}` }}>
                          {cfg.emoji} {cfg.label}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-xs font-semibold" style={{ color: cfg.color }}>
                        {cm.effectiveMaxChange > 0 ? `+${(cm.effectiveMaxChange * 100).toFixed(0)}%` : '0%'}
                        {cm.isMultiCourse && <span className="text-slate-400 font-normal ml-0.5">pond.</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-600 text-xs">
                        {cm.cac_20d !== null ? fmtBRL(cm.cac_20d) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-semibold text-emerald-700 text-xs">
                        {cm.cac_weighted !== null
                          ? fmtBRL(cm.cac_weighted)
                          : <span className="text-xs text-slate-400 font-normal">sem dados</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-700 text-xs">
                        {fmtBRL(cm.inv_current)}
                      </td>
                      {result && alloc && (
                        <>
                          <td className="px-3 py-3 text-right tabular-nums font-semibold text-indigo-700 text-xs">
                            {fmtBRL(alloc.inv_suggested)}
                          </td>
                          <td className="px-3 py-3 text-right whitespace-nowrap">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                              isUp   ? 'bg-emerald-100 text-emerald-700' :
                              isDown ? 'bg-red-100 text-red-700' :
                                       'bg-slate-100 text-slate-500'
                            }`}>
                              {isUp   ? <TrendingUp   className="w-3 h-3" /> :
                               isDown ? <TrendingDown className="w-3 h-3" /> :
                                        <Minus        className="w-3 h-3" />}
                              {fmtPct(delta)}
                              {alloc.capped && (
                                <span title={alloc.cappedBy === 'max' ? 'Teto do curso atingido' : 'Piso −35% atingido'}>
                                  {alloc.cappedBy === 'max' ? '🔒' : '🔻'}
                                </span>
                              )}
                            </span>
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
                {displayRows.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-10 text-center text-slate-400 text-sm">
                      Nenhuma campanha encontrada.
                    </td>
                  </tr>
                )}
              </tbody>

              {result && (
                <tfoot>
                  <tr className="bg-slate-100 border-t-2 border-slate-300 font-semibold">
                    <td className="px-3 py-3 text-slate-700 text-xs uppercase tracking-wide" colSpan={6}>
                      Total · {campaignMetrics.length} campanhas ativas
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-slate-800 text-xs">{fmtBRL(currentTotalDaily)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-indigo-700 text-xs">{fmtBRL(result.total_allocated)}</td>
                    <td className="px-3 py-3 text-right">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                        result.total_allocated > currentTotalDaily ? 'bg-emerald-100 text-emerald-700' :
                        result.total_allocated < currentTotalDaily ? 'bg-red-100 text-red-700' :
                        'bg-slate-100 text-slate-500'
                      }`}>
                        {fmtPct(currentTotalDaily > 0
                          ? ((result.total_allocated - currentTotalDaily) / currentTotalDaily) * 100 : 0)}
                      </span>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div className="px-5 py-3 border-t border-slate-100 text-xs text-slate-400 flex flex-wrap gap-4 justify-between">
            <span>🔒 teto do curso atingido · 🔻 piso −35% atingido · +N cursos = multi-curso (teto ponderado)</span>
            <span>Inv. atual = média diária 7d (fallback 30d)</span>
          </div>
        </div>
      )}
    </div>
  );
}
