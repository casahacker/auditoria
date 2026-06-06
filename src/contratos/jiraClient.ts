/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — cliente Jira (#133).
 *
 * Todo contrato/aditivo nasce vinculado a uma issue do projeto JUR. Esta camada cobre
 * a VALIDAÇÃO obrigatória na criação (a sincronização de eventos é da Fase 3, #140).
 *
 * Segurança: o token vive SÓ no .env do servidor (nunca no front). Dois modos:
 *  - pat   → Authorization: Bearer {JIRA_PAT}        (Jira Data Center/Server)
 *  - basic → Authorization: Basic base64(email:token) (Jira Cloud)
 *
 * O endpoint público da ferramenta (GET /api/contratos/jira/:issueKey) usa validarIssue
 * e devolve summary/status para conferência humana no passo 2 do wizard.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

interface JiraConfig {
  baseUrl: string;
  authMode: "pat" | "basic";
  pat: string;
  email: string;
  apiToken: string;
  projectKey: string;
}

function cfg(): JiraConfig {
  const authMode = (process.env.JIRA_AUTH_MODE || "pat").toLowerCase() === "basic" ? "basic" : "pat";
  return {
    baseUrl: (process.env.JIRA_BASE_URL || "").replace(/\/+$/, ""),
    authMode,
    pat: process.env.JIRA_PAT || "",
    email: process.env.JIRA_EMAIL || "",
    apiToken: process.env.JIRA_API_TOKEN || "",
    projectKey: (process.env.JIRA_PROJECT_KEY || "JUR").toUpperCase(),
  };
}

export function projetoJira(): string {
  return cfg().projectKey;
}

export function jiraConfigured(): boolean {
  const c = cfg();
  if (!c.baseUrl) return false;
  return c.authMode === "basic" ? !!(c.email && c.apiToken) : !!c.pat;
}

function authHeader(c: JiraConfig): Record<string, string> {
  if (c.authMode === "basic") {
    return { Authorization: `Basic ${Buffer.from(`${c.email}:${c.apiToken}`).toString("base64")}` };
  }
  return { Authorization: `Bearer ${c.pat}` };
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  statusCategory: string; // "done" gera alerta com ciência obrigatória (#133)
  issuetype: string;
  project: string;
  isDone: boolean;
}

export type MotivoFalhaJira =
  | "nao_configurado" | "formato" | "nao_encontrado" | "outro_projeto" | "credencial" | "rede";

export interface JiraValidacao {
  ok: boolean;
  issue?: JiraIssue;
  erro?: string;
  motivo?: MotivoFalhaJira;
}

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

/**
 * Valida a existência e o projeto de uma issue Jira.
 * `fetchImpl` permite injeção em testes (mock HTTP) — em produção usa o fetch global.
 * Respeita 429 com backoff exponencial + Retry-After (padrão do serviço de Diligência).
 */
export async function validarIssue(
  issueKey: string,
  opts: { fetchImpl?: typeof fetch; retries?: number } = {},
): Promise<JiraValidacao> {
  const c = cfg();
  const f = opts.fetchImpl || fetch;
  const key = String(issueKey || "").trim().toUpperCase();

  if (!KEY_RE.test(key)) return { ok: false, motivo: "formato", erro: "Formato de issue inválido (esperado PROJ-123)." };
  if (!jiraConfigured()) return { ok: false, motivo: "nao_configurado", erro: "Integração Jira não configurada no servidor." };

  const url = `${c.baseUrl}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,status,issuetype,project`;
  let retries = opts.retries ?? 3;
  let attempt = 0;

  while (true) {
    let r: Response;
    try {
      r = await f(url, { headers: { Accept: "application/json", ...authHeader(c) }, signal: AbortSignal.timeout(12000) });
    } catch (e: any) {
      return { ok: false, motivo: "rede", erro: `Falha de rede ao consultar o Jira: ${e?.message || e}` };
    }

    if (r.status === 429 && retries > 0) {
      const ra = Number(r.headers.get("retry-after"));
      const waitS = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) : Math.min(2 ** attempt, 30);
      retries--; attempt++;
      await sleep(waitS * 1000);
      continue;
    }
    if (r.status === 401 || r.status === 403) return { ok: false, motivo: "credencial", erro: "Credencial do Jira inválida ou sem acesso à issue." };
    if (r.status === 404) return { ok: false, motivo: "nao_encontrado", erro: `Issue ${key} não encontrada no Jira.` };
    if (!r.ok) return { ok: false, motivo: "rede", erro: `O Jira respondeu ${r.status}.` };

    let data: any;
    try { data = await r.json(); } catch { return { ok: false, motivo: "rede", erro: "Resposta do Jira ilegível." }; }

    const project = String(data?.fields?.project?.key || "").toUpperCase();
    const statusCategory = String(
      data?.fields?.status?.statusCategory?.key || data?.fields?.status?.statusCategory?.name || "",
    ).toLowerCase();
    const issue: JiraIssue = {
      key: data?.key || key,
      summary: data?.fields?.summary || "",
      status: data?.fields?.status?.name || "",
      statusCategory,
      issuetype: data?.fields?.issuetype?.name || "",
      project,
      isDone: statusCategory === "done",
    };

    if (project !== c.projectKey) {
      return { ok: false, motivo: "outro_projeto", issue, erro: `A issue ${key} pertence ao projeto ${project || "?"}, não ao ${c.projectKey}.` };
    }
    return { ok: true, issue };
  }
}

// HTTP status de saída por motivo de falha (usado pela rota).
export const HTTP_POR_MOTIVO: Record<MotivoFalhaJira, number> = {
  nao_configurado: 503,
  formato: 400,
  nao_encontrado: 404,
  outro_projeto: 422,
  credencial: 502,
  rede: 502,
};
