/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Gera, em RUNTIME, o PDF do termo KYS/KYG JÁ PRÉ-PREENCHIDO com os dados do registro
 * (em vez do template AcroForm vazio de scripts/gen-kyc-templates.ts). O PDF é enviado ao
 * Documenso via API (createDocument → S3) e o signatário apenas ASSINA — não redigita nada.
 *
 * Reaproveita o layout "visual law" do gerador de templates. Devolve também a posição do
 * campo de ASSINATURA (página + caixa em % da página, origem top-left = convenção da API
 * de fields do Documenso) para que o backend crie o campo SIGNATURE exatamente ali.
 *
 * Fonte: Helvetica (WinAnsi/CP1252 cobre os acentos PT-BR; os TTF IBM Plex em assets/ estão
 * corrompidos — mesma pegadinha do FEAC). Texto legal vem de src/kyc/kycTypes (fonte única;
 * o Dockerfile copia esse arquivo para o container).
 */
import { PDFDocument, PDFImage, rgb, PDFFont, PDFPage, StandardFonts } from "pdf-lib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  KYS_SECTIONS, KYS_DECLARACOES, KYS_DECLARACOES_INTRO, KYG_DECLARACOES, ASSINATURA_ACEITE,
  addressOneLine, maskCnpj, maskCpf, maskDoc,
} from "./src/kyc/kycTypes";
import type { KycRecord } from "./src/kyc/kycTypes";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, "assets");

const A4: [number, number] = [595.28, 841.89];
const M = 48;
const INK = rgb(0.09, 0.09, 0.09);
const GRAY = rgb(0.42, 0.42, 0.42);
const SOFT = rgb(0.6, 0.6, 0.6);
const LINE = rgb(0.86, 0.86, 0.86);
const GREEN = rgb(0.196, 0.949, 0.588);
const BOXBG = rgb(0.975, 0.985, 0.978);
const VALINK = rgb(0.12, 0.12, 0.12);

/** Campo de assinatura em % da página (origem top-left), p/ POST /documents/{id}/fields. */
export type SigField = { page: number; x: number; y: number; width: number; height: number };

const safe = (s: string) =>
  String(s || "")
    .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"')
    .replace(/[–—]/g, "–").replace(/…/g, "...").replace(/[•●]/g, "-")
    .replace(/[   ]/g, " ").replace(/→/g, "->").replace(/≥/g, ">=");

function wrap(font: PDFFont, text: string, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of safe(text).split("\n")) {
    const words = para.split(/\s+/); let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (font.widthOfTextAtSize(t, size) > maxW && cur) { out.push(cur); cur = w; } else cur = t;
    }
    out.push(cur);
  }
  return out;
}

class Filled {
  doc!: PDFDocument;
  font!: PDFFont; semibold!: PDFFont; bold!: PDFFont;
  logo!: PDFImage; logoW = 0; logoH = 0;
  page!: PDFPage; y = 0; pageIndex = -1;
  pageTitle: string;
  sig: SigField | null = null;
  constructor(pageTitle: string) { this.pageTitle = pageTitle; }
  get W() { return A4[0] - 2 * M; }

  async init() {
    this.doc = await PDFDocument.create();
    this.font = await this.doc.embedFont(StandardFonts.Helvetica);
    this.semibold = await this.doc.embedFont(StandardFonts.HelveticaBold);
    this.bold = this.semibold;
    this.logo = await this.doc.embedPng(fs.readFileSync(path.join(ASSETS, "rateio_logo_header.png")));
    const targetH = 16; const s = targetH / this.logo.height;
    this.logoH = targetH; this.logoW = this.logo.width * s;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage(A4); this.pageIndex++;
    const { width, height } = this.page.getSize();
    this.page.drawImage(this.logo, { x: M, y: height - M - this.logoH + 2, width: this.logoW, height: this.logoH });
    const rt = this.pageTitle;
    this.page.drawText(rt, { x: width - M - this.font.widthOfTextAtSize(rt, 7.5), y: height - M - 6, size: 7.5, font: this.font, color: SOFT });
    const ruleY = height - M - this.logoH - 6;
    this.page.drawLine({ start: { x: M, y: ruleY }, end: { x: width - M, y: ruleY }, thickness: 0.6, color: LINE });
    this.page.drawRectangle({ x: M, y: ruleY - 0.5, width: 34, height: 1.6, color: GREEN });
    this.page.drawText("Associação Casa Hacker · CNPJ 36.038.079/0001-97 · casahacker.org", { x: M, y: M - 24, size: 7, font: this.font, color: SOFT });
    const conf = "CONFIDENCIAL";
    this.page.drawText(conf, { x: (width - this.semibold.widthOfTextAtSize(conf, 7)) / 2, y: M - 24, size: 7, font: this.semibold, color: GRAY });
    this.y = ruleY - 22;
  }

  ensure(h: number) { if (this.y - h < M + 6) this.newPage(); }

  titleBlock(title: string, subtitle: string) {
    this.ensure(60);
    this.page.drawText(safe(title), { x: M, y: this.y - 14, size: 18, font: this.bold, color: INK });
    this.y -= 32;
    this.page.drawText(safe(subtitle), { x: M, y: this.y, size: 9, font: this.font, color: GRAY });
    this.y -= 18;
  }

  section(t: string) {
    this.ensure(34); this.y -= 6;
    this.page.drawRectangle({ x: M, y: this.y - 1, width: 3, height: 11, color: GREEN });
    this.page.drawText(safe(t).toUpperCase(), { x: M + 9, y: this.y, size: 9.5, font: this.semibold, color: INK });
    this.y -= 7; this.page.drawLine({ start: { x: M, y: this.y }, end: { x: M + this.W, y: this.y }, thickness: 0.6, color: LINE });
    this.y -= 14;
  }

  /** Caixa com o VALOR já preenchido (label acima). Multiline faz wrap e cresce em altura. */
  value(label: string, val: string, opts: { w?: number; x?: number; multiline?: boolean } = {}) {
    const w = opts.w ?? this.W; const x = opts.x ?? M;
    const text = safe(val || "—");
    const size = 9;
    const lines = opts.multiline ? wrap(this.font, text, size, w - 12) : [text];
    const boxH = Math.max(opts.multiline ? 17 : 15, lines.length * (size + 3) + 7);
    this.ensure(boxH + 14);
    this.page.drawText(safe(label), { x, y: this.y, size: 7.5, font: this.semibold, color: GRAY });
    this.y -= boxH + 3;
    this.page.drawRectangle({ x, y: this.y, width: w, height: boxH, borderColor: LINE, color: BOXBG, borderWidth: 0.6 });
    lines.forEach((ln, i) => this.page.drawText(ln, { x: x + 6, y: this.y + boxH - 12 - i * (size + 3), size, font: this.font, color: VALINK }));
    this.y -= 9;
  }
  row2(a: { label: string; val: string }, b: { label: string; val: string }) {
    const colW = (this.W - 16) / 2; const startY = this.y;
    this.value(a.label, a.val, { w: colW, x: M });
    const afterA = this.y; this.y = startY;
    this.value(b.label, b.val, { w: colW, x: M + colW + 16 });
    this.y = Math.min(afterA, this.y);
  }

  /** Pergunta KYS com a RESPOSTA marcada (SIM/NÃO) e observação. */
  answered(text: string, resposta: string, obs: string) {
    const lines = wrap(this.font, text, 9, this.W);
    const ans = resposta === "sim" ? "SIM" : resposta === "nao" ? "NÃO" : "—";
    const obsLines = obs ? wrap(this.font, obs, 8.5, this.W - 12) : [];
    const need = lines.length * 12 + 20 + (obsLines.length ? obsLines.length * 12 + 18 : 0);
    this.ensure(need);
    for (const ln of lines) { this.page.drawText(ln, { x: M, y: this.y, size: 9, font: this.font, color: INK }); this.y -= 12; }
    this.y -= 4;
    this.page.drawText("RESPOSTA:", { x: M, y: this.y, size: 8, font: this.semibold, color: GRAY });
    this.page.drawText(safe(ans), { x: M + 56, y: this.y, size: 9, font: this.bold, color: ans === "—" ? SOFT : INK });
    this.y -= 14;
    if (obsLines.length) {
      this.page.drawText("Observações:", { x: M, y: this.y, size: 7.5, font: this.semibold, color: GRAY });
      this.y -= 12;
      for (const ln of obsLines) { this.page.drawText(ln, { x: M + 6, y: this.y, size: 8.5, font: this.font, color: VALINK }); this.y -= 12; }
      this.y -= 4;
    }
    this.y -= 4;
  }

  paragraph(text: string, size = 9, font = this.font, color = INK) {
    const lines = wrap(font, text, size, this.W);
    this.ensure(lines.length * (size + 3.5) + 6);
    for (const ln of lines) { this.page.drawText(ln, { x: M, y: this.y, size, font, color }); this.y -= size + 3.5; }
    this.y -= 5;
  }

  /** Declaração numerada; se accepted!=null, prefixa um marcador de aceite. */
  declaration(n: number, text: string, accepted: boolean | null = null) {
    const numW = 20; const size = 9;
    const mark = accepted === null ? "" : accepted ? "[X] " : "[ ] ";
    const lines = wrap(this.font, mark + text, size, this.W - numW);
    this.ensure(lines.length * (size + 3.5) + 9);
    this.page.drawText(`${n}.`, { x: M, y: this.y, size, font: this.semibold, color: INK });
    lines.forEach((ln, i) => this.page.drawText(ln, { x: M + numW, y: this.y - i * (size + 3.5), size, font: this.font, color: INK }));
    this.y -= lines.length * (size + 3.5) + 9;
  }

  /** Área de assinatura + captura da posição do campo SIGNATURE (em % da página, top-left). */
  signatureArea() {
    this.ensure(96); this.y -= 8;
    const boxTop = this.y + 6; const boxH = 66; const boxBottom = boxTop - boxH;
    this.page.drawRectangle({ x: M, y: boxBottom, width: this.W, height: boxH, borderColor: LINE, borderWidth: 0.8, color: rgb(0.985, 0.99, 0.987) });
    this.page.drawRectangle({ x: M, y: boxTop - 2, width: 90, height: 2, color: GREEN });
    this.page.drawText("ASSINATURA ELETRÔNICA", { x: M + 14, y: boxTop - 18, size: 10, font: this.bold, color: INK });
    this.page.drawText("Assinado eletronicamente pelo representante legal / proponente.", { x: M + 14, y: boxTop - 32, size: 8, font: this.font, color: GRAY });
    // Caixa do campo SIGNATURE: faixa inferior da área (onde a rubrica aparece).
    const sx = M + 14, sw = 240, sh = 24, sy = boxBottom + 8; // pdf-lib: bottom-left, pontos
    const PW = A4[0], PH = A4[1];
    this.sig = {
      page: this.pageIndex + 1, // 1-based
      x: +((sx / PW) * 100).toFixed(2),
      y: +(((PH - (sy + sh)) / PH) * 100).toFixed(2), // topo do campo a partir do topo da página
      width: +((sw / PW) * 100).toFixed(2),
      height: +((sh / PH) * 100).toFixed(2),
    };
    this.y = boxBottom - 8;
  }

  finalize() {
    const pages = this.doc.getPages(); const n = pages.length;
    pages.forEach((p, i) => {
      const t = `Página ${i + 1} de ${n}`;
      p.drawText(safe(t), { x: A4[0] - M - this.font.widthOfTextAtSize(safe(t), 7), y: M - 24, size: 7, font: this.font, color: SOFT });
    });
  }
  async toBuffer(): Promise<Buffer> { this.finalize(); return Buffer.from(await this.doc.save()); }
}

async function buildKys(rec: KycRecord, b: Filled) {
  const k = rec.kys!;
  b.titleBlock("Formulário de Conformidade para Fornecedores", "KYS — Know Your Supplier · pessoa jurídica · Associação Casa Hacker");
  b.section("Identificação da empresa (pessoa jurídica)");
  b.row2({ label: "RAZÃO SOCIAL", val: k.razaoSocial }, { label: "CNPJ", val: maskCnpj(k.cnpj) });
  b.row2({ label: "NOME FANTASIA", val: k.nomeFantasia }, { label: "TELEFONE", val: k.telefone });
  b.value("ENDEREÇO", addressOneLine(k.endereco), { multiline: true });
  b.value("E-MAIL", k.email);
  b.section("Dados bancários");
  b.row2({ label: "BANCO / INSTITUIÇÃO", val: k.banco.banco }, { label: "AGÊNCIA", val: k.banco.agencia });
  b.row2({ label: "CONTA-CORRENTE", val: k.banco.conta }, { label: "CHAVE PIX", val: k.banco.chavePix });
  b.section("Identificação do representante legal");
  b.row2({ label: "NOME COMPLETO", val: k.repNome }, { label: "CPF", val: maskCpf(k.repCpf) });
  b.row2({ label: "ESTADO CIVIL", val: k.repEstadoCivil }, { label: "PROFISSÃO", val: k.repProfissao });
  b.value("ENDEREÇO", addressOneLine(k.repEndereco), { multiline: true });
  b.row2({ label: "TELEFONE", val: k.repTelefone }, { label: "E-MAIL", val: k.repEmail });
  for (const sec of KYS_SECTIONS) {
    b.section(sec.title);
    for (const q of sec.questions) {
      const a = k.respostas?.[q.key];
      b.answered(q.text, a?.resposta || "", a?.obs || "");
    }
  }
  if (k.observacoes) { b.section("Observações"); b.value("OBSERVAÇÕES GERAIS", k.observacoes, { multiline: true }); }
  b.section("Declarações da empresa");
  b.paragraph(KYS_DECLARACOES_INTRO, 9, b.semibold);
  KYS_DECLARACOES.forEach((d, i) => b.declaration(i + 1, d));
  b.paragraph(ASSINATURA_ACEITE, 8.5, b.font, GRAY);
  b.signatureArea();
}

async function buildKyg(rec: KycRecord, b: Filled) {
  const g = rec.kyg!;
  b.titleBlock("Declaração de Conformidade", "KYG — Know Your Grantee · OSC / pessoa física · Associação Casa Hacker");
  b.section("Identificação do proponente");
  b.row2({ label: "NOME / RAZÃO SOCIAL", val: g.nome }, { label: g.documento.length > 11 ? "CNPJ" : "CPF", val: maskDoc(g.documento) });
  b.value("NOME DO PROJETO", g.projeto);
  b.value("ENDEREÇO", addressOneLine(g.endereco), { multiline: true });
  b.row2({ label: "TELEFONE", val: g.telefone }, { label: "E-MAIL", val: g.email });
  b.section("Dados bancários (recebimento)");
  b.row2({ label: "BANCO / INSTITUIÇÃO", val: g.banco.banco }, { label: "AGÊNCIA", val: g.banco.agencia });
  b.row2({ label: "CONTA-CORRENTE", val: g.banco.conta }, { label: "CHAVE PIX", val: g.banco.chavePix });
  b.section("Declarações (sob as penas da lei)");
  b.paragraph("O proponente declara, sob as penas da lei, que:", 9, b.semibold);
  KYG_DECLARACOES.forEach((d, i) => b.declaration(i + 1, d, g.declaracoes?.[i] ?? true));
  if (g.observacoes) { b.section("Observações"); b.value("OBSERVAÇÕES GERAIS", g.observacoes, { multiline: true }); }
  b.paragraph(ASSINATURA_ACEITE, 8.5, b.font, GRAY);
  b.signatureArea();
}

/** Gera o PDF preenchido + a posição do campo de assinatura. */
export async function generateKycPdf(rec: KycRecord): Promise<{ pdf: Buffer; signature: SigField }> {
  const b = new Filled(rec.type === "kys" ? "KYS · Conformidade de Fornecedores" : "KYG · Declaração de Conformidade");
  await b.init();
  if (rec.type === "kys") await buildKys(rec, b);
  else await buildKyg(rec, b);
  const pdf = await b.toBuffer();
  if (!b.sig) throw new Error("kycPdf: área de assinatura não definida");
  return { pdf, signature: b.sig };
}
