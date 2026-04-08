import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import {
  Sparkles, Send, Bot, User, Settings2, Loader2,
  Code2, FileText, Trash2, Copy, Check, ChevronDown, ChevronUp, Lightbulb,
  Download, FileDown,
} from 'lucide-react';
import Markdown from 'react-markdown';
import { AISettingsPanel } from './AISettingsPanel';
import { AIProviderConfig, getDefaultModel } from '../lib/ai';
import { callAI } from '../lib/ai';
import { PLANNER_PROMPT, ANALYST_PROMPT } from '../lib/aiPrompts';
import { executePlan } from '../lib/analyticsExecutor';
import { buildAnalystContext, buildBenchmarks } from '../lib/analystContextBuilder';

// ── Types ──────────────────────────────────────────────────────────────────

type Status = 'idle' | 'planning' | 'executing' | 'analyzing';

interface ConversationTurn {
  role: 'user' | 'ai';
  intent: string;
}

interface Message {
  role: 'user' | 'ai';
  content: string;
  contentType: 'markdown' | 'html';
  debug?: any;
}

// ── Constants ──────────────────────────────────────────────────────────────

const SUGGESTED_QUESTIONS = [
  'Qual o resumo geral da base? (período, volume, totais)',
  'Qual o CAC e investimento por plataforma?',
  'Evolução mensal de MQLs e matrículas',
  'Top 10 cursos por investimento',
  'Compare os últimos 15 dias com o período anterior',
  'Qual o CPMql por tipo de campanha?',
  'Quais cursos têm melhor conversão MQL → Matrícula?',
];

const STATUS_LABELS: Record<Status, string> = {
  idle:      '',
  planning:  'Interpretando pergunta...',
  executing: 'Agregando dados localmente...',
  analyzing: 'Gerando relatório executivo...',
};

// ── CSS injected into the iframe so the AI HTML renders beautifully ────────

const REPORT_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 14px;
    line-height: 1.65;
    color: #1e1e2e;
    background: #ffffff;
    padding: 32px 40px 48px;
    max-width: 960px;
    margin: 0 auto;
  }

  /* ── Headings ── */
  h1 { font-size: 1.6rem; font-weight: 800; color: #0f172a; margin-bottom: 6px; line-height: 1.2; }
  h2 { font-size: 1.15rem; font-weight: 700; color: #1e293b; margin: 28px 0 12px; padding-bottom: 6px; border-bottom: 2px solid #f1f5f9; }
  h3 { font-size: 1rem; font-weight: 600; color: #334155; margin: 20px 0 8px; }
  h4 { font-size: 0.9rem; font-weight: 600; color: #475569; margin: 14px 0 6px; }

  /* ── Paragraphs & text ── */
  p { margin-bottom: 10px; color: #334155; }
  strong { color: #0f172a; font-weight: 700; }
  em { color: #475569; }

  /* ── Section / report wrapper ── */
  .report, section { margin-bottom: 32px; }

  /* ── KPI / metric cards ── */
  .metrics, .kpi-grid, .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: 14px;
    margin: 16px 0 24px;
  }
  .metric-card, .kpi-card {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 16px;
    text-align: center;
  }
  .metric-card .label, .kpi-card .label, .metric-card p, .kpi-card p {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #64748b;
    margin-bottom: 6px;
  }
  .metric-card .value, .kpi-card .value,
  .metric-card strong, .kpi-card strong {
    display: block;
    font-size: 1.4rem;
    font-weight: 800;
    color: #0f172a;
    line-height: 1;
  }
  .metric-card .delta, .kpi-card .delta {
    font-size: 12px;
    font-weight: 600;
    margin-top: 4px;
    color: #64748b;
  }
  .metric-card .delta.up,   .kpi-card .delta.up   { color: #16a34a; }
  .metric-card .delta.down, .kpi-card .delta.down { color: #dc2626; }

  /* ── Accent highlight ── */
  .highlight, .accent { color: #059669; font-weight: 700; }
  .warn  { color: #d97706; font-weight: 600; }
  .danger { color: #dc2626; font-weight: 600; }

  /* ── Data tables ── */
  .data-table, table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    margin: 16px 0;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid #e2e8f0;
  }
  .data-table th, table th {
    background: #f1f5f9;
    color: #374151;
    font-weight: 700;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 10px 14px;
    text-align: left;
    border-bottom: 1px solid #e2e8f0;
  }
  .data-table td, table td {
    padding: 9px 14px;
    color: #374151;
    border-bottom: 1px solid #f1f5f9;
    vertical-align: middle;
  }
  .data-table tr:last-child td, table tr:last-child td { border-bottom: none; }
  .data-table tr:nth-child(even) td, table tr:nth-child(even) td { background: #fafafa; }
  .data-table tr:hover td, table tr:hover td { background: #f0fdf4; }
  .data-table td:first-child, table td:first-child { font-weight: 600; color: #1e293b; }
  .data-table .number, td.number, td[align="right"] { text-align: right; font-variant-numeric: tabular-nums; }

  /* ── Lists ── */
  ul, ol { padding-left: 20px; margin-bottom: 12px; }
  li { margin-bottom: 4px; color: #374151; }
  li strong { color: #0f172a; }

  /* ── Insight / callout boxes ── */
  .insight, .callout, blockquote {
    background: #f0fdf4;
    border-left: 4px solid #10b981;
    border-radius: 0 8px 8px 0;
    padding: 12px 16px;
    margin: 16px 0;
    color: #065f46;
    font-size: 13.5px;
  }
  .callout.warn, .insight.warn {
    background: #fffbeb;
    border-left-color: #f59e0b;
    color: #78350f;
  }
  .callout.danger, .insight.danger {
    background: #fef2f2;
    border-left-color: #ef4444;
    color: #7f1d1d;
  }

  /* ── Badges / tags ── */
  .badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    background: #dcfce7;
    color: #166534;
  }
  .badge.warn  { background: #fef9c3; color: #713f12; }
  .badge.info  { background: #dbeafe; color: #1e3a8a; }
  .badge.danger { background: #fee2e2; color: #7f1d1d; }

  /* ── Dividers & spacing ── */
  hr { border: none; border-top: 1px solid #f1f5f9; margin: 24px 0; }

  /* ── Report header block ── */
  .report-header {
    margin-bottom: 28px;
    padding-bottom: 20px;
    border-bottom: 2px solid #f1f5f9;
  }
  .report-header .subtitle, .report-header p {
    color: #64748b;
    font-size: 13px;
    margin-top: 4px;
  }

  /* ── Section title with accent bar ── */
  .section-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 1rem;
    font-weight: 700;
    color: #1e293b;
    margin: 24px 0 14px;
  }
  .section-title::before {
    content: '';
    display: block;
    width: 4px;
    height: 18px;
    background: #10b981;
    border-radius: 4px;
    flex-shrink: 0;
  }

  /* ── Trend indicators ── */
  .trend-up   { color: #16a34a; }
  .trend-down { color: #dc2626; }
  .trend-flat { color: #6b7280; }

  /* ── Print tweaks ── */
  @media print {
    body { padding: 20px; }
    .data-table tr:hover td { background: transparent; }
  }
`;

// ── Helpers ────────────────────────────────────────────────────────────────

function extractJson(text: string): any {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/```json\s*([\s\S]*?)\s*```/i) || text.match(/(\{[\s\S]*\})/);
  if (!m) throw new Error('O Planner não retornou um JSON válido.');
  return JSON.parse(m[1]);
}

function extractHtml(text: string): string {
  const t = text.trim();
  if (!t) return '<section class="report"><p>Nenhum conteúdo retornado.</p></section>';
  const m = t.match(/```html\s*([\s\S]*?)\s*```/i);
  return m ? m[1].trim() : t;
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

function buildFullHtmlDoc(bodyHtml: string, title = 'Relatório PTSmart'): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>${REPORT_CSS}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function defaultConfig(role: 'planner' | 'analyst'): AIProviderConfig {
  const envGemini    = (import.meta as any).env?.VITE_GEMINI_API_KEY    || '';
  const envOpenAI    = (import.meta as any).env?.VITE_OPENAI_API_KEY    || '';
  const envAnthropic = (import.meta as any).env?.VITE_ANTHROPIC_API_KEY || '';

  if (envAnthropic) return { provider: 'anthropic', model: getDefaultModel('anthropic', role), apiKey: envAnthropic };
  if (envGemini)    return { provider: 'gemini',    model: getDefaultModel('gemini', role),    apiKey: envGemini };
  if (envOpenAI)    return { provider: 'openai',    model: getDefaultModel('openai', role),    apiKey: envOpenAI };

  return { provider: 'gemini', model: getDefaultModel('gemini', role), apiKey: '' };
}

// ── ReportHtml — renders in an auto-sizing iframe with full CSS ────────────

function ReportHtml({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const safe = useMemo(() => sanitizeHtml(html), [html]);
  const fullDoc = useMemo(() => buildFullHtmlDoc(safe), [safe]);

  // Auto-resize iframe to its content height
  const resize = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument?.body) return;
    const h = iframe.contentDocument.body.scrollHeight;
    iframe.style.height = `${Math.max(h + 32, 200)}px`;
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    iframe.srcdoc = fullDoc;
    iframe.onload = () => {
      resize();
      // Also resize on images loaded inside
      const imgs = iframe.contentDocument?.images;
      if (imgs) Array.from(imgs).forEach(img => { img.onload = resize; });
    };
  }, [fullDoc, resize]);

  return (
    <div style={{
      width: '100%',
      borderRadius: '12px',
      overflow: 'hidden',
      border: '1px solid var(--border-default)',
      background: '#ffffff',
    }}>
      <iframe
        ref={iframeRef}
        title="Relatório IA"
        sandbox="allow-same-origin"
        style={{
          width: '100%',
          height: '300px',
          border: 'none',
          display: 'block',
          background: '#ffffff',
        }}
      />
    </div>
  );
}

// ── Action toolbar under each AI message ──────────────────────────────────

function MessageToolbar({ msg, showDebug }: { msg: Message; showDebug: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopyHtml = async () => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const handleDownloadHtml = () => {
    const full = buildFullHtmlDoc(sanitizeHtml(msg.content));
    const blob = new Blob([full], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relatorio-ptsmart-${Date.now()}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadPdf = () => {
    const full = buildFullHtmlDoc(sanitizeHtml(msg.content));
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1200px;height:1px;visibility:hidden;';
    document.body.appendChild(iframe);
    iframe.srcdoc = full;
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } finally {
        setTimeout(() => document.body.removeChild(iframe), 3000);
      }
    };
  };

  if (msg.contentType !== 'html' && !msg.debug) return null;

  return (
    <div className="flex items-center gap-1.5 pl-1 flex-wrap">
      {msg.contentType === 'html' && (
        <>
          <button
            onClick={handleCopyHtml}
            title="Copiar HTML"
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
              border: '1px solid var(--border-default)', background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)', cursor: 'pointer', transition: 'all 0.15s',
            }}
          >
            {copied ? <Check style={{ width: 12, height: 12, color: 'var(--accent)' }} /> : <Copy style={{ width: 12, height: 12 }} />}
            {copied ? 'Copiado!' : 'Copiar HTML'}
          </button>
          <button
            onClick={handleDownloadHtml}
            title="Baixar como arquivo HTML"
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
              border: '1px solid var(--border-default)', background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)', cursor: 'pointer', transition: 'all 0.15s',
            }}
          >
            <FileDown style={{ width: 12, height: 12 }} />
            Baixar HTML
          </button>
          <button
            onClick={handleDownloadPdf}
            title="Imprimir / Salvar como PDF"
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
              border: '1px solid rgba(0,229,160,0.3)', background: 'rgba(0,229,160,0.08)',
              color: 'var(--accent)', cursor: 'pointer', transition: 'all 0.15s',
            }}
          >
            <Download style={{ width: 12, height: 12 }} />
            Salvar PDF
          </button>
        </>
      )}
      {showDebug && msg.debug && <DebugPanel debug={msg.debug} />}
    </div>
  );
}

function DebugPanel({ debug }: { debug: any }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
      >
        <Code2 className="w-3.5 h-3.5" />
        Debug
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {open && (
        <div className="mt-2 p-3 bg-slate-800 rounded-xl text-xs text-emerald-400 font-mono overflow-x-auto max-h-80 overflow-y-auto">
          {[
            { label: 'Planner JSON', key: 'plan' },
            { label: 'Executor Result', key: 'executionResult' },
          ].map(({ label, key }) => (
            <details key={key} className="mb-2">
              <summary className="cursor-pointer hover:text-emerald-300 text-slate-300 font-semibold">{label}</summary>
              <pre className="mt-1 whitespace-pre-wrap break-all">{JSON.stringify(debug[key], null, 2)}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function AIAssistant({ data }: { data: any[] }) {
  const [query, setQuery]       = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus]     = useState<Status>('idle');
  const [showSettings, setShowSettings] = useState(false);
  const [showDebug, setShowDebug]       = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const conversationHistory = useRef<ConversationTurn[]>([]);
  const benchmarks = useMemo(() => buildBenchmarks(data), [data]);

  const [plannerConfig, setPlannerConfig] = useState<AIProviderConfig>(() => {
    try {
      const s = localStorage.getItem('ai_planner_config');
      return s ? JSON.parse(s) : defaultConfig('planner');
    } catch { return defaultConfig('planner'); }
  });

  const [analystConfig, setAnalystConfig] = useState<AIProviderConfig>(() => {
    try {
      const s = localStorage.getItem('ai_analyst_config');
      return s ? JSON.parse(s) : defaultConfig('analyst');
    } catch { return defaultConfig('analyst'); }
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  const handleSaveSettings = (pc: AIProviderConfig, ac: AIProviderConfig) => {
    setPlannerConfig(pc);
    setAnalystConfig(ac);
    localStorage.setItem('ai_planner_config', JSON.stringify(pc));
    localStorage.setItem('ai_analyst_config', JSON.stringify(ac));
  };

  const handleClear = () => {
    setMessages([]);
    conversationHistory.current = [];
  };

  const handleAsk = async (userMessage: string) => {
    if (!userMessage.trim() || status !== 'idle') return;

    setMessages(prev => [...prev, { role: 'user', content: userMessage, contentType: 'markdown' }]);
    setQuery('');

    try {
      if (!plannerConfig.apiKey || !analystConfig.apiKey) {
        throw new Error('Configure as API Keys clicando na engrenagem ⚙ acima.');
      }

      // ── Step 1: Planner ─────────────────────────────────────────────────
      setStatus('planning');

      // Inject conversation history into the user prompt for context
      const historyContext = conversationHistory.current.length > 0
        ? `\n\nHistórico recente da conversa (para resolver referências como "esse", "esse produto", "período anterior"):\n${conversationHistory.current
            .slice(-4)
            .map(t => `- ${t.role === 'user' ? 'Usuário' : 'IA'}: ${t.intent}`)
            .join('\n')}`
        : '';

      const plannerUserPrompt = `${userMessage}${historyContext}`;
      const plannerResponse   = await callAI(plannerConfig, PLANNER_PROMPT, plannerUserPrompt, true);
      const plan              = extractJson(plannerResponse);

      // ── Step 2: Execute locally ─────────────────────────────────────────
      setStatus('executing');
      const availableKeys    = data.length > 0 ? Object.keys(data[0]) : [];
      const executionResult  = executePlan(plan, data, availableKeys);

      // ── Step 3: Analyst ─────────────────────────────────────────────────
      setStatus('analyzing');
      const analystContext = buildAnalystContext({
        userMessage,
        plan,
        executionResult,
        conversationHistory: conversationHistory.current,
        benchmarks,
      });

      const analystResponse = await callAI(analystConfig, ANALYST_PROMPT, analystContext, false);
      const analystHtml     = extractHtml(analystResponse);

      // Save to conversation memory
      conversationHistory.current.push(
        { role: 'user', intent: plan.intent || userMessage },
        { role: 'ai',   intent: `Relatório gerado: ${plan.intent}` }
      );
      // Keep only last 10 turns
      if (conversationHistory.current.length > 10) {
        conversationHistory.current = conversationHistory.current.slice(-10);
      }

      setMessages(prev => [
        ...prev,
        {
          role: 'ai',
          content: analystHtml,
          contentType: 'html',
          debug: { plan, executionResult },
        },
      ]);
    } catch (err: any) {
      setMessages(prev => [
        ...prev,
        {
          role: 'ai',
          content: `**Erro:** ${err.message}`,
          contentType: 'markdown',
        },
      ]);
    } finally {
      setStatus('idle');
    }
  };

  const onFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleAsk(query);
  };

  const hasApiKeys = plannerConfig.apiKey && analystConfig.apiKey;

  return (
    <div className="flex flex-col h-[calc(100vh-220px)] min-h-[500px] bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 bg-slate-50/60">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-emerald-600" />
          <span className="text-sm font-semibold text-slate-800">Assistente Analítico</span>
          {data.length > 0 && (
            <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
              {data.length.toLocaleString('pt-BR')} linhas
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {messages.length > 0 && (
            <button
              onClick={handleClear}
              title="Limpar conversa"
              className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => setShowDebug(v => !v)}
            title="Modo debug"
            className={`p-1.5 rounded-lg transition-colors ${showDebug ? 'text-emerald-600 bg-emerald-50' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`}
          >
            <Code2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowSettings(true)}
            title="Configurar agentes de IA"
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <Settings2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">

        {/* Empty state */}
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center py-8 space-y-6">
            <div className="text-center space-y-2">
              <FileText className="w-10 h-10 mx-auto text-slate-300" />
              <p className="text-sm text-slate-500 max-w-sm">
                Faça perguntas em linguagem natural sobre os dados carregados.
                O agente interpreta, consulta e gera relatórios executivos em HTML.
              </p>
              {!hasApiKeys && (
                <button
                  onClick={() => setShowSettings(true)}
                  className="inline-flex items-center gap-1.5 text-xs text-emerald-600 font-medium mt-2 hover:underline"
                >
                  <Settings2 className="w-3.5 h-3.5" />
                  Configure as API Keys para começar
                </button>
              )}
            </div>

            {/* Suggested questions */}
            <div className="w-full max-w-xl space-y-2">
              <p className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                <Lightbulb className="w-3.5 h-3.5" />
                Sugestões de perguntas
              </p>
              <div className="grid grid-cols-1 gap-1.5">
                {SUGGESTED_QUESTIONS.map(q => (
                  <button
                    key={q}
                    onClick={() => handleAsk(q)}
                    disabled={!hasApiKeys || status !== 'idle'}
                    className="text-left text-xs px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-emerald-50 hover:border-emerald-200 hover:text-emerald-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Message list */}
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
            {/* Avatar */}
            <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
              msg.role === 'user'
                ? 'bg-slate-900 text-white'
                : 'bg-emerald-100 text-emerald-600'
            }`}>
              {msg.role === 'user'
                ? <User className="w-3.5 h-3.5" />
                : <Bot className="w-3.5 h-3.5" />}
            </div>

            {/* Content */}
            <div className={`max-w-[92%] ${msg.role === 'user' ? 'items-end' : 'items-start'} flex flex-col gap-1.5`}>
              {msg.role === 'user' ? (
                <div className="rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm" style={{ background: 'var(--accent)', color: '#080810', fontWeight: 500 }}>
                  {msg.content}
                </div>
              ) : (
                <>
                  {msg.contentType === 'html'
                    ? <ReportHtml html={msg.content} />
                    : (
                      <div className="rounded-2xl rounded-tl-sm px-4 py-3 prose prose-sm max-w-none text-sm" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                        <Markdown>{msg.content}</Markdown>
                      </div>
                    )
                  }
                  <MessageToolbar msg={msg} showDebug={showDebug} />
                </>
              )}
            </div>
          </div>
        ))}

        {/* Status indicator */}
        {status !== 'idle' && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0">
              <Bot className="w-3.5 h-3.5" />
            </div>
            <div className="flex items-center gap-2.5 px-4 py-2.5 bg-white border border-slate-200 rounded-2xl rounded-tl-sm shadow-sm text-sm text-slate-600">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" />
              {STATUS_LABELS[status]}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Input ── */}
      <div className="px-4 py-3 border-t border-slate-200 bg-white">
        <form onSubmit={onFormSubmit} className="flex items-center gap-2">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={hasApiKeys ? 'Pergunte sobre os dados...' : 'Configure as API Keys ⚙ para começar'}
            disabled={status !== 'idle' || !hasApiKeys}
            className="flex-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 disabled:opacity-50 transition-all"
          />
          <button
            type="submit"
            disabled={!query.trim() || status !== 'idle' || !hasApiKeys}
            className="p-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 text-white rounded-xl transition-colors disabled:cursor-not-allowed"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
        {conversationHistory.current.length > 0 && (
          <p className="text-xs text-slate-400 mt-1.5 pl-1">
            {conversationHistory.current.length / 2} {conversationHistory.current.length / 2 === 1 ? 'pergunta' : 'perguntas'} na memória da conversa
          </p>
        )}
      </div>

      {/* ── Settings modal ── */}
      {showSettings && (
        <AISettingsPanel
          onClose={() => setShowSettings(false)}
          onSave={handleSaveSettings}
          initialPlannerConfig={plannerConfig}
          initialAnalystConfig={analystConfig}
        />
      )}
    </div>
  );
}
