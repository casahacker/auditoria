/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — cliente Documenso para o envio à assinatura (#139).
 *
 * Reusa a MESMA instância do KYS (DOCUMENSO_URL/DOCUMENSO_API_TOKEN, S3 ligado).
 * Diferença: o contrato tem 2 SIGNATÁRIOS (representante da CONTRATADA + Diretor-
 * Presidente da Casa Hacker) e o solicitante como CC. Envia o PDF ÚNICO do pacote
 * (não template+formValues). Se a API não suportar o upload direto, o chamador cai no
 * fallback (envio manual) — ver #139.
 *
 * Módulo SERVER-ONLY.
 */
// Lê o ambiente preguiçosamente (igual ao jiraClient) — robusto e testável.
const cfg = () => ({
  url: (process.env.DOCUMENSO_URL || "https://documenso.casahacker.org").replace(/\/$/, ""),
  token: process.env.DOCUMENSO_API_TOKEN || "",
});

export const documensoReady = (): boolean => !!cfg().token;
export const documensoHost = (): string => cfg().url;

async function dso(method: string, urlPath: string, body?: any): Promise<any> {
  const c = cfg();
  const r = await fetch(`${c.url}/api/v1${urlPath}`, {
    method,
    headers: { Authorization: c.token, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Documenso ${method} ${urlPath} → ${r.status}`);
  return r.json();
}

export interface SignatarioContrato { name: string; email: string }

export interface EnvioContrato {
  documentId: number;
  signerTokens: { email: string; token?: string }[];
}

/**
 * Cria o documento no Documenso com a ORDEM fixa do processo (assinatura SEQUENTIAL):
 *   APROVADORES (Melissa, Everton) → SIGNER Casa Hacker (Diretor) → SIGNER Contratada → CC (jurídico).
 * Faz upload do PDF do pacote, adiciona um campo SIGNATURE para cada SIGNER (faixa
 * inferior da última página, 2 colunas: Casa Hacker à esquerda, Contratada à direita) e
 * dispara o envio. Aprovadores e CC não recebem campo de assinatura.
 */
export async function enviarContratoParaAssinatura(opts: {
  titulo: string;
  pdf: Buffer;
  totalPaginas: number;
  aprovadores: SignatarioContrato[];   // role APPROVER, na ordem
  signatarios: SignatarioContrato[];   // role SIGNER, na ordem (Casa Hacker/Diretor, depois Contratada)
  cc?: SignatarioContrato;             // role CC
  externalId?: string;
}): Promise<EnvioContrato> {
  let ordem = 1;
  const recipients = [
    ...opts.aprovadores.map((a) => ({ name: a.name, email: a.email, role: "APPROVER", signingOrder: ordem++ })),
    ...opts.signatarios.map((s) => ({ name: s.name, email: s.email, role: "SIGNER", signingOrder: ordem++ })),
    ...(opts.cc ? [{ name: opts.cc.name, email: opts.cc.email, role: "CC", signingOrder: ordem++ }] : []),
  ];
  const gen = await dso("POST", "/documents", {
    title: opts.titulo,
    ...(opts.externalId ? { externalId: opts.externalId } : {}),
    recipients,
    meta: { signingOrder: "SEQUENTIAL", subject: "Contrato de Prestação de Serviços — Casa Hacker", message: "Contrato para aprovação e assinatura eletrônica." },
  });
  const documentId: number = gen.documentId ?? gen.id;
  const uploadUrl: string = gen.uploadUrl;
  const recps: any[] = gen.recipients || [];
  if (!documentId || !uploadUrl) throw new Error("Documenso não retornou documentId/uploadUrl (S3 ligado?)");

  const up = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: opts.pdf, signal: AbortSignal.timeout(60000) });
  if (!up.ok) throw new Error(`Falha no upload do PDF ao S3 (${up.status})`);

  // campo SIGNATURE só para os SIGNER, na faixa inferior da última página.
  // 1º signatário (Casa Hacker/Diretor) → coluna esquerda; 2º (Contratada) → direita.
  const signerEmails = opts.signatarios.map((s) => s.email.toLowerCase());
  const signers = recps.filter((r) => /SIGNER/i.test(r.role));
  const pageNumber = Math.max(1, opts.totalPaginas);
  for (const s of signers) {
    const idx = signerEmails.indexOf(String(s.email || "").toLowerCase());
    const x = idx <= 0 ? 10 : 55; // esquerda (Casa Hacker) / direita (Contratada)
    await dso("POST", `/documents/${documentId}/fields`, {
      recipientId: s.recipientId ?? s.id, type: "SIGNATURE",
      pageNumber, pageX: x, pageY: 84, pageWidth: 35, pageHeight: 6,
    });
  }
  await dso("POST", `/documents/${documentId}/send`, { sendEmail: true });

  return { documentId, signerTokens: signers.map((s) => ({ email: s.email, token: s.token })) };
}

export async function statusDocumento(documentId: number): Promise<string> {
  try { const d = await dso("GET", `/documents/${documentId}`); return d?.status || "PENDING"; }
  catch { return "PENDING"; }
}

export async function baixarAssinado(documentId: number): Promise<Buffer | null> {
  try {
    const d = await dso("GET", `/documents/${documentId}`);
    const url = d?.documentDataUrl || d?.downloadUrl;
    if (!url) return null;
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}
