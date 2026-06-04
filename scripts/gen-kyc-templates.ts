/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Gerador dos PDFs-TEMPLATE do KYS e KYG (uso ÚNICO/manual) — documentos jurídicos.
 *
 * Design "visual law" alinhado à identidade Casa Hacker (logo casa:hacker, IBM Plex Sans,
 * acento verde #32fa96), com as DECLARAÇÕES OBRIGATÓRIAS e a cláusula de assinatura
 * eletrônica. Os campos AcroForm continuam nomeados (chaves de buildFormValues) caso o
 * formValues volte a ser usado, mas hoje o signatário preenche/assina no próprio Documenso.
 *
 * Rode:  npx tsx scripts/gen-kyc-templates.ts
 * Saída: ./kyc-templates/KYS_template.pdf e KYG_template.pdf
 *
 * No Documenso (UMA vez por arquivo): Templates → New → suba o PDF → 2 recipients NA ORDEM
 *   [0]=CC "Associação Casa Hacker", [1]=SIGNER (fornecedor) → 1 campo SIGNATURE no SIGNER,
 *   na área "ASSINATURA ELETRÔNICA" → habilite → copie o templateId p/ o .env.
 */
import { PDFDocument, PDFImage, rgb, PDFFont, PDFPage, StandardFonts } from "pdf-lib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { KYS_SECTIONS, KYS_DECLARACOES, KYS_DECLARACOES_INTRO, KYG_DECLARACOES, ASSINATURA_ACEITE } from "../src/kyc/kycTypes";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "kyc-templates");
const ASSETS = path.join(__dirname, "..", "assets");

const A4: [number, number] = [595.28, 841.89];
const M = 48;
const INK = rgb(0.09, 0.09, 0.09);
const GRAY = rgb(0.42, 0.42, 0.42);
const SOFT = rgb(0.6, 0.6, 0.6);
const LINE = rgb(0.86, 0.86, 0.86);
const GREEN = rgb(0.196, 0.949, 0.588); // #32f296 — acento da marca Casa Hacker
const BOXBG = rgb(0.975, 0.985, 0.978);

// Helvetica usa WinAnsi (CP1252): cobre acentos PT-BR (ç ã é º ª), travessão e ponto médio.
// Mapeia só os poucos sinais fora do CP1252 (setas, ≥, aspas/curvas exóticas) p/ evitar erro.
const safe = (s: string) =>
  String(s || "")
    .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"')
    .replace(/[–—]/g, "–").replace(/…/g, "...").replace(/[•●]/g, "-")
    .replace(/[   ]/g, " ").replace(/→/g, "->").replace(/≥/g, ">=");

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

class Builder {
  doc!: PDFDocument;
  font!: PDFFont; semibold!: PDFFont; bold!: PDFFont;
  logo!: PDFImage; logoW = 0; logoH = 0;
  page!: PDFPage; y = 0;
  title: string; pageTitle: string;
  constructor(title: string, pageTitle: string) { this.title = title; this.pageTitle = pageTitle; }
  get W() { return A4[0] - 2 * M; }

  async init() {
    this.doc = await PDFDocument.create();
    // Os TTFs IBM Plex vendorizados estão corrompidos (download de página 404); o pdf-lib+
    // @pdf-lib/fontkit também não embute o WOFF. Helvetica (WinAnsi/CP1252) renderiza todos os
    // acentos PT-BR e a pontuação do texto jurídico — fiel ao documento. (Trocar por IBM Plex
    // quando houver um .ttf/.otf válido nos assets.)
    this.font = await this.doc.embedFont(StandardFonts.Helvetica);
    this.semibold = await this.doc.embedFont(StandardFonts.HelveticaBold);
    this.bold = await this.doc.embedFont(StandardFonts.HelveticaBold);
    this.logo = await this.doc.embedPng(fs.readFileSync(path.join(ASSETS, "rateio_logo_header.png")));
    const targetH = 16; const s = targetH / this.logo.height;
    this.logoH = targetH; this.logoW = this.logo.width * s;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage(A4);
    const { width, height } = this.page.getSize();
    // Cabeçalho: logo casa:hacker + título corrente à direita + régua fina
    this.page.drawImage(this.logo, { x: M, y: height - M - this.logoH + 2, width: this.logoW, height: this.logoH });
    const rt = this.pageTitle;
    this.page.drawText(rt, { x: width - M - this.font.widthOfTextAtSize(rt, 7.5), y: height - M - 6, size: 7.5, font: this.font, color: SOFT });
    const ruleY = height - M - this.logoH - 6;
    this.page.drawLine({ start: { x: M, y: ruleY }, end: { x: width - M, y: ruleY }, thickness: 0.6, color: LINE });
    this.page.drawRectangle({ x: M, y: ruleY - 0.5, width: 34, height: 1.6, color: GREEN }); // acento verde
    // Rodapé: identificação institucional
    this.page.drawText("Associação Casa Hacker · CNPJ 36.038.079/0001-97 · casahacker.org", { x: M, y: M - 24, size: 7, font: this.font, color: SOFT });
    this.y = ruleY - 22;
  }

  ensure(h: number) { if (this.y - h < M + 6) this.newPage(); }

  titleBlock(title: string, subtitle: string) {
    this.ensure(60);
    this.page.drawText(title, { x: M, y: this.y - 14, size: 18, font: this.bold, color: INK });
    this.y -= 32;
    this.page.drawText(subtitle, { x: M, y: this.y, size: 9, font: this.font, color: GRAY });
    this.y -= 18;
  }

  section(t: string) {
    this.ensure(34); this.y -= 6;
    this.page.drawRectangle({ x: M, y: this.y - 1, width: 3, height: 11, color: GREEN });
    this.page.drawText(safe(t).toUpperCase(), { x: M + 9, y: this.y, size: 9.5, font: this.semibold, color: INK });
    this.y -= 7; this.page.drawLine({ start: { x: M, y: this.y }, end: { x: M + this.W, y: this.y }, thickness: 0.6, color: LINE });
    this.y -= 14;
  }

  field(label: string, name: string, opts: { w?: number; h?: number; multiline?: boolean; x?: number } = {}) {
    const w = opts.w ?? this.W; const h = opts.h ?? 17; const x = opts.x ?? M;
    this.ensure(h + 17);
    this.page.drawText(label, { x, y: this.y, size: 7.5, font: this.semibold, color: GRAY });
    this.y -= h + 3;
    const tf = this.doc.getForm().createTextField(name);
    if (opts.multiline) tf.enableMultiline();
    tf.addToPage(this.page, { x, y: this.y, width: w, height: h, borderColor: LINE, backgroundColor: BOXBG, borderWidth: 0.6 });
    this.y -= 9;
  }
  row2(a: { label: string; name: string }, b: { label: string; name: string }, h = 17) {
    const colW = (this.W - 16) / 2; const startY = this.y;
    this.field(a.label, a.name, { w: colW, h, x: M });
    const afterA = this.y; this.y = startY;
    this.field(b.label, b.name, { w: colW, h, x: M + colW + 16 });
    this.y = Math.min(afterA, this.y);
  }
  question(text: string, key: string) {
    const lines = wrap(this.font, text, 9, this.W);
    this.ensure(lines.length * 12 + 44);
    for (const ln of lines) { this.page.drawText(ln, { x: M, y: this.y, size: 9, font: this.font, color: INK }); this.y -= 12; }
    this.y -= 3;
    this.page.drawText("RESPOSTA (SIM / NÃO)", { x: M, y: this.y, size: 6.8, font: this.semibold, color: GRAY });
    this.page.drawText("OBSERVAÇÕES", { x: M + 110, y: this.y, size: 6.8, font: this.semibold, color: GRAY });
    this.y -= 16;
    this.doc.getForm().createTextField(`${key}_resposta`).addToPage(this.page, { x: M, y: this.y, width: 96, height: 15, borderColor: LINE, backgroundColor: BOXBG, borderWidth: 0.6 });
    const obs = this.doc.getForm().createTextField(`${key}_obs`); obs.enableMultiline();
    obs.addToPage(this.page, { x: M + 110, y: this.y - 13, width: this.W - 110, height: 28, borderColor: LINE, backgroundColor: BOXBG, borderWidth: 0.6 });
    this.y -= 28 + 12;
  }
  paragraph(text: string, size = 9, font = this.font, color = INK) {
    const lines = wrap(font, text, size, this.W);
    this.ensure(lines.length * (size + 3.5) + 6);
    for (const ln of lines) { this.page.drawText(ln, { x: M, y: this.y, size, font, color }); this.y -= size + 3.5; }
    this.y -= 5;
  }
  declaration(n: number, text: string) {
    const numW = 20; const size = 9;
    const lines = wrap(this.font, text, size, this.W - numW);
    this.ensure(lines.length * (size + 3.5) + 9);
    this.page.drawText(`${n}.`, { x: M, y: this.y, size, font: this.semibold, color: INK });
    lines.forEach((ln, i) => this.page.drawText(ln, { x: M + numW, y: this.y - i * (size + 3.5), size, font: this.font, color: INK }));
    this.y -= lines.length * (size + 3.5) + 9;
  }
  signatureArea() {
    this.ensure(92); this.y -= 8;
    this.page.drawRectangle({ x: M, y: this.y - 60, width: this.W, height: 66, borderColor: LINE, borderWidth: 0.8, color: rgb(0.985, 0.99, 0.987) });
    this.page.drawRectangle({ x: M, y: this.y + 4, width: 90, height: 2, color: GREEN });
    this.page.drawText("ASSINATURA ELETRÔNICA", { x: M + 14, y: this.y - 14, size: 10, font: this.bold, color: INK });
    this.page.drawText("Assinado eletronicamente pelo representante legal / proponente.", { x: M + 14, y: this.y - 30, size: 8, font: this.font, color: GRAY });
    this.page.drawText("[ no editor do Documenso, posicione aqui o campo SIGNATURE do recipient SIGNER ]", { x: M + 14, y: this.y - 44, size: 7.5, font: this.font, color: SOFT });
    this.y -= 72;
  }
  finalize() {
    const pages = this.doc.getPages(); const n = pages.length;
    pages.forEach((p, i) => {
      const t = `Página ${i + 1} de ${n}`;
      p.drawText(t, { x: A4[0] - M - this.font.widthOfTextAtSize(t, 7), y: M - 24, size: 7, font: this.font, color: SOFT });
    });
  }
  async save(file: string) {
    this.finalize();
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, file), await this.doc.save());
    return this.doc.getForm().getFields().map((f) => f.getName());
  }
}

async function buildKys() {
  const b = new Builder("KYS — Conformidade de Fornecedores", "KYS · Conformidade de Fornecedores");
  await b.init();
  b.titleBlock("Formulário de Conformidade para Fornecedores", "KYS — Know Your Supplier · pessoa jurídica · Associação Casa Hacker");
  b.section("Identificação da empresa (pessoa jurídica)");
  b.row2({ label: "RAZÃO SOCIAL", name: "razao_social" }, { label: "CNPJ", name: "cnpj" });
  b.row2({ label: "NOME FANTASIA", name: "nome_fantasia" }, { label: "TELEFONE (CELULAR/FIXO)", name: "empresa_telefone" });
  b.field("ENDEREÇO (RUA, NÚMERO, BAIRRO, COMPLEMENTO, CIDADE, ESTADO E CEP)", "empresa_endereco", { multiline: true, h: 28 });
  b.field("E-MAIL", "empresa_email");
  b.section("Dados bancários");
  b.row2({ label: "BANCO / INSTITUIÇÃO DE PAGAMENTO", name: "banco" }, { label: "AGÊNCIA", name: "agencia" });
  b.row2({ label: "CONTA-CORRENTE", name: "conta" }, { label: "CHAVE PIX", name: "chave_pix" });
  b.section("Identificação do representante legal");
  b.row2({ label: "NOME COMPLETO", name: "rep_nome" }, { label: "CPF", name: "rep_cpf" });
  b.row2({ label: "ESTADO CIVIL", name: "rep_estado_civil" }, { label: "PROFISSÃO", name: "rep_profissao" });
  b.field("ENDEREÇO (RUA, NÚMERO, BAIRRO, COMPLEMENTO, CIDADE, ESTADO E CEP)", "rep_endereco", { multiline: true, h: 28 });
  b.row2({ label: "TELEFONE (CELULAR/FIXO)", name: "rep_telefone" }, { label: "E-MAIL", name: "rep_email" });
  for (const sec of KYS_SECTIONS) {
    b.section(sec.title);
    for (const q of sec.questions) b.question(q.text, q.key);
  }
  b.section("Observações");
  b.field("OBSERVAÇÕES GERAIS", "observacoes", { multiline: true, h: 48 });
  b.section("Declarações da empresa");
  b.paragraph(KYS_DECLARACOES_INTRO, 9, b.semibold);
  KYS_DECLARACOES.forEach((d, i) => b.declaration(i + 1, d));
  b.paragraph(ASSINATURA_ACEITE, 8.5, b.font, GRAY);
  b.signatureArea();
  return b.save("KYS_template.pdf");
}

async function buildKyg() {
  const b = new Builder("KYG — Declaração de Conformidade", "KYG · Declaração de Conformidade");
  await b.init();
  b.titleBlock("Declaração de Conformidade", "KYG — Know Your Grantee · OSC / pessoa física · Associação Casa Hacker");
  b.section("Identificação do proponente");
  b.row2({ label: "NOME / RAZÃO SOCIAL", name: "proponente_nome" }, { label: "CPF / CNPJ", name: "proponente_documento" });
  b.field("NOME DO PROJETO", "projeto");
  b.field("ENDEREÇO (RUA, NÚMERO, BAIRRO, COMPLEMENTO, CIDADE, ESTADO E CEP)", "proponente_endereco", { multiline: true, h: 28 });
  b.row2({ label: "TELEFONE", name: "proponente_telefone" }, { label: "E-MAIL", name: "proponente_email" });
  b.section("Dados bancários (recebimento)");
  b.row2({ label: "BANCO / INSTITUIÇÃO DE PAGAMENTO", name: "banco" }, { label: "AGÊNCIA", name: "agencia" });
  b.row2({ label: "CONTA-CORRENTE", name: "conta" }, { label: "CHAVE PIX", name: "chave_pix" });
  b.section("Declarações (sob as penas da lei)");
  b.paragraph("O proponente declara, sob as penas da lei, que:", 9, b.semibold);
  KYG_DECLARACOES.forEach((d, i) => b.declaration(i + 1, d));
  b.section("Observações");
  b.field("OBSERVAÇÕES GERAIS", "observacoes", { multiline: true, h: 48 });
  b.paragraph(ASSINATURA_ACEITE, 8.5, b.font, GRAY);
  b.signatureArea();
  return b.save("KYG_template.pdf");
}

(async () => {
  const kys = await buildKys();
  const kyg = await buildKyg();
  console.log(`KYS_template.pdf  → ${kys.length} campos`);
  console.log(`KYG_template.pdf  → ${kyg.length} campos`);
  console.log(`\nArquivos em: ${OUT_DIR}`);
})();
