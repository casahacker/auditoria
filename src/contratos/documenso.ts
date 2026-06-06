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
const DOCUMENSO_URL = (process.env.DOCUMENSO_URL || "https://documenso.casahacker.org").replace(/\/$/, "");
const DOCUMENSO_TOKEN = process.env.DOCUMENSO_API_TOKEN || "";

export const documensoReady = (): boolean => !!DOCUMENSO_TOKEN;

async function dso(method: string, urlPath: string, body?: any): Promise<any> {
  const r = await fetch(`${DOCUMENSO_URL}/api/v1${urlPath}`, {
    method,
    headers: { Authorization: DOCUMENSO_TOKEN, "Content-Type": "application/json", Accept: "application/json" },
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
 * Cria o documento no Documenso a partir do PDF do pacote, com 2 signatários + CC,
 * adiciona um campo SIGNATURE para cada signatário e dispara o envio (e-mail).
 * Os campos são posicionados na faixa inferior da última página (2 colunas) — onde o
 * render desenha o bloco de assinaturas.
 */
export async function enviarContratoParaAssinatura(opts: {
  titulo: string;
  pdf: Buffer;
  totalPaginas: number;
  contratada: SignatarioContrato;
  diretor: SignatarioContrato;
  cc?: SignatarioContrato;
}): Promise<EnvioContrato> {
  const recipients = [
    { name: opts.contratada.name, email: opts.contratada.email, role: "SIGNER" },
    { name: opts.diretor.name, email: opts.diretor.email, role: "SIGNER" },
    ...(opts.cc ? [{ name: opts.cc.name, email: opts.cc.email, role: "CC" }] : []),
  ];
  const gen = await dso("POST", "/documents", { title: opts.titulo, recipients });
  const documentId: number = gen.documentId ?? gen.id;
  const uploadUrl: string = gen.uploadUrl;
  const recps: any[] = gen.recipients || [];
  if (!documentId || !uploadUrl) throw new Error("Documenso não retornou documentId/uploadUrl (S3 ligado?)");

  const up = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: opts.pdf, signal: AbortSignal.timeout(60000) });
  if (!up.ok) throw new Error(`Falha no upload do PDF ao S3 (${up.status})`);

  // campo SIGNATURE para cada SIGNER, na faixa inferior da última página (2 colunas).
  const signers = recps.filter((r) => /SIGNER/i.test(r.role));
  const pageNumber = Math.max(1, opts.totalPaginas);
  const posPorEmail: Record<string, { x: number; width: number }> = {
    [opts.contratada.email.toLowerCase()]: { x: 55, width: 35 },
    [opts.diretor.email.toLowerCase()]: { x: 10, width: 35 },
  };
  for (const s of signers) {
    const pos = posPorEmail[String(s.email || "").toLowerCase()] || { x: 10, width: 35 };
    await dso("POST", `/documents/${documentId}/fields`, {
      recipientId: s.recipientId ?? s.id, type: "SIGNATURE",
      pageNumber, pageX: pos.x, pageY: 84, pageWidth: pos.width, pageHeight: 6,
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

export const documensoHost = DOCUMENSO_URL;
