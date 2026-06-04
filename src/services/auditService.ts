import { AuditItem, AuditResult, AuditVerdict } from "../types";

async function extractPdfText(b64: string): Promise<string> {
  try {
    const clean = b64.includes(",") ? b64.split(",")[1] : b64;
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const fd = new FormData();
    fd.append("file", blob, "document.pdf");
    const r = await fetch("/api/extract-pdf", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { text } = await r.json();
    return text as string;
  } catch (e) {
    console.warn("Falha na extração de PDF server-side:", e);
    return "";
  }
}

export async function processAudit(
  metadata: { organization: string; periodStart: string; periodEnd: string; contractNumber: string },
  csv1: any[],
  csv2: any[],
  pdfNfB64: string,
  pdfPayB64: string,
  onProgress: (step: number, message: string) => void
): Promise<AuditResult> {
  onProgress(1, "Lendo e indexando arquivos recebidos...");
  await new Promise(r => setTimeout(r, 300));

  onProgress(2, "Extraindo texto dos documentos PDF (processamento server-side)...");
  const [pdfNfText, pdfPayText] = await Promise.all([
    extractPdfText(pdfNfB64),
    extractPdfText(pdfPayB64),
  ]);

  onProgress(3, "Auditoria está cruzando 4 camadas de dados para cada lançamento financeiro...");

  const response = await fetch("/api/audit-run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ metadata, csv1, csv2, pdfNfText, pdfPayText }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Erro na auditoria: HTTP ${response.status}`);
  }

  const { items: allItems, findings: allFindings, meta: firstParsedMeta } = await response.json();

  onProgress(4, "Calculando período, métricas e gerando parecer final...");

  // Compute actual period from item dates
  const parseDateTs = (d: string): number => {
    if (!d || d === "N/A") return 0;
    const br = d.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (br) return new Date(+br[3], +br[2] - 1, +br[1]).getTime();
    const ts = Date.parse(d);
    return isNaN(ts) ? 0 : ts;
  };
  const formatBrDate = (ts: number): string => {
    const d = new Date(ts);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  };
  const validTs = allItems.map((i: any) => parseDateTs(i.date)).filter((t: number) => t > 0);
  const actualPeriodStart = validTs.length ? formatBrDate(Math.min(...validTs)) : metadata.periodStart || "N/A";
  const actualPeriodEnd   = validTs.length ? formatBrDate(Math.max(...validTs)) : metadata.periodEnd   || "N/A";

  // Verdict & metrics
  const totalItemsCount = allItems.length;
  const conciliatedCount = allItems.filter((i: any) => i.status === "Conciliado").length;
  const pendingCount = allItems.filter((i: any) => i.status === "Pendente").length;
  const findingsCount = allFindings.length;

  let verdict: AuditVerdict;
  if (pendingCount === 0 && findingsCount === 0) {
    verdict = "APROVADO";
  } else if (conciliatedCount / Math.max(totalItemsCount, 1) >= 0.8) {
    verdict = "APROVADO COM RESSALVAS";
  } else {
    verdict = "DILIGÊNCIA";
  }

  const computedTotalValue = allItems.reduce((acc: number, i: any) => acc + (Number(i.value) || 0), 0);

  const approvedValue = csv1.reduce((sum: number, row: any) => {
    const valStr = row.Valor || row.valor || row.value || row["Valor Total"] || 0;
    let clean = String(valStr).replace(/[^\d.,-]/g, "").replace(",", ".");
    const sep = Math.max(clean.lastIndexOf(","), clean.lastIndexOf("."));
    if (sep > -1) clean = clean.substring(0, sep).replace(/[.,]/g, "") + "." + clean.substring(sep + 1);
    const val = Number(clean);
    return sum + (isNaN(val) ? 0 : val);
  }, 0);

  onProgress(5, "Formatando o relatório de parecer (RAPC) em tela...");

  const emailSubject = firstParsedMeta?.emailTemplate?.subject
    || `Auditoria de Prestação de Contas — ${metadata.contractNumber}`;
  const emailBody = firstParsedMeta?.emailTemplate?.body
    || `Auditoria finalizada. Total de lançamentos: ${totalItemsCount}. Conciliados: ${conciliatedCount}. Pendentes: ${pendingCount}. Parecer: ${verdict}.`;

  const ACCESS_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const shareAccessCode = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map(b => ACCESS_CHARS[b % ACCESS_CHARS.length]).join('');

  return {
    id: crypto.randomUUID(),
    shareToken: crypto.randomUUID(),
    shareAccessCode,
    organization: metadata.organization || "Não informado",
    periodStart: actualPeriodStart,
    periodEnd: actualPeriodEnd,
    contractNumber: metadata.contractNumber || "Não informado",
    date: new Date().toISOString(),
    verdict,
    metrics: {
      totalItems: totalItemsCount,
      conciliatedItems: conciliatedCount,
      findingsCount,
      totalValue: computedTotalValue,
      approvedValue,
    },
    items: allItems,
    findings: allFindings,
    emailTemplate: {
      subject: emailSubject,
      body: emailBody,
    },
  };
}

// ── Reprocess a subset of items — delegates to server-side endpoint ───────────
export async function reprocessItems(
  items: AuditItem[],
  _metadata: { organization: string; periodStart?: string; periodEnd?: string; contractNumber: string },
  _csv1: any[],
  _pdfNfB64: string,
  _pdfPayB64: string,
  _additionalContext: string,
  _onProgress: (step: number, message: string) => void
): Promise<AuditItem[]> {
  // Reprocessing is handled server-side via /api/audits/:id/reprocess
  // This stub exists to satisfy the import in App.tsx (the actual call goes through apiFetch)
  return items;
}
