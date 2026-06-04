/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Gerador dos PDFs-TEMPLATE fillable do KYS e KYG (uso ÚNICO/manual).
 *
 * Cria dois PDFs com campos de formulário AcroForm NOMEADOS exatamente como as chaves
 * de `buildFormValues()` em kycRoutes.ts. O Documenso preenche esses campos via
 * `formValues` (insertFormValuesInPdf) ao instanciar o documento a partir do template.
 *
 * Rode:  npx tsx scripts/gen-kyc-templates.ts
 * Saída: ./kyc-templates/KYS_template.pdf e KYG_template.pdf
 *
 * Depois, no Documenso (documenso.casahacker.org), faça UMA vez por arquivo:
 *   1. Templates → New Template → suba o PDF.
 *   2. Adicione 1 recipient (placeholder "Signatário") e coloque 1 campo SIGNATURE
 *      (e, se quiser, NAME/DATE) na área "ASSINADO ELETRONICAMENTE" da última página.
 *   3. Salve/abilite e copie o templateId → .env (DOCUMENSO_KYS_TEMPLATE_ID / _KYG_).
 */
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { KYS_SECTIONS, KYG_DECLARACOES } from "../src/kyc/kycTypes";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "kyc-templates");

const A4: [number, number] = [595.28, 841.89];
const M = 48;                       // margem
const INK = rgb(0.1, 0.1, 0.1);
const GRAY = rgb(0.45, 0.45, 0.45);
const LINE = rgb(0.8, 0.8, 0.8);
const BOXBG = rgb(0.98, 0.98, 0.98);

// sanitiza p/ WinAnsi (Helvetica)
const safe = (s: string) => String(s || "").replace(/[→]/g, "->").replace(/[≥]/g, ">=").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/•/g, "-");

function wrap(font: PDFFont, text: string, size: number, maxW: number): string[] {
  const words = safe(text).split(/\s+/);
  const lines: string[] = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(t, size) > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

class Builder {
  doc!: PDFDocument; font!: PDFFont; bold!: PDFFont;
  page!: PDFPage; y = 0; title: string;
  constructor(title: string) { this.title = title; }
  async init() {
    this.doc = await PDFDocument.create();
    this.font = await this.doc.embedFont(StandardFonts.Helvetica);
    this.bold = await this.doc.embedFont(StandardFonts.HelveticaBold);
    this.newPage();
  }
  get W() { return A4[0] - 2 * M; }
  newPage() {
    this.page = this.doc.addPage(A4);
    const { width, height } = this.page.getSize();
    this.page.drawText("CASA HACKER", { x: M, y: height - M + 6, size: 12, font: this.bold, color: INK });
    this.page.drawText(safe(this.title), { x: M, y: height - M - 8, size: 8, font: this.font, color: GRAY });
    this.page.drawLine({ start: { x: M, y: height - M - 16 }, end: { x: width - M, y: height - M - 16 }, thickness: 0.5, color: LINE });
    this.page.drawText("Associacao Casa Hacker - CNPJ 36.038.079/0001-97", { x: M, y: M - 24, size: 7, font: this.font, color: GRAY });
    this.y = height - M - 34;
  }
  ensure(h: number) { if (this.y - h < M + 8) this.newPage(); }
  section(t: string) {
    this.ensure(30); this.y -= 8;
    this.page.drawText(safe(t).toUpperCase(), { x: M, y: this.y, size: 9, font: this.bold, color: INK });
    this.y -= 6; this.page.drawLine({ start: { x: M, y: this.y }, end: { x: M + this.W, y: this.y }, thickness: 0.5, color: INK });
    this.y -= 12;
  }
  // campo rotulado (label em cima, caixa do campo embaixo)
  field(label: string, name: string, opts: { w?: number; h?: number; multiline?: boolean; x?: number } = {}) {
    const w = opts.w ?? this.W; const h = opts.h ?? 16; const x = opts.x ?? M;
    this.ensure(h + 16);
    this.page.drawText(safe(label), { x, y: this.y, size: 7.5, font: this.bold, color: GRAY });
    this.y -= h + 3;
    const tf = this.doc.getForm().createTextField(name);
    if (opts.multiline) tf.enableMultiline();
    tf.addToPage(this.page, { x, y: this.y, width: w, height: h, borderColor: LINE, backgroundColor: BOXBG, borderWidth: 0.5 });
    this.y -= 8;
    return h;
  }
  // duas colunas na mesma linha
  row2(a: { label: string; name: string }, b: { label: string; name: string }, h = 16) {
    const colW = (this.W - 14) / 2;
    const startY = this.y;
    this.field(a.label, a.name, { w: colW, h, x: M });
    const afterA = this.y; this.y = startY;
    this.field(b.label, b.name, { w: colW, h, x: M + colW + 14 });
    this.y = Math.min(afterA, this.y);
  }
  question(text: string, key: string) {
    const lines = wrap(this.font, text, 8.5, this.W);
    this.ensure(lines.length * 11 + 50);
    for (const ln of lines) { this.page.drawText(ln, { x: M, y: this.y, size: 8.5, font: this.font, color: INK }); this.y -= 11; }
    this.y -= 4;
    // resposta (SIM/NAO) + obs
    this.page.drawText("RESPOSTA (SIM / NAO)", { x: M, y: this.y, size: 7, font: this.bold, color: GRAY });
    this.y -= 15;
    this.doc.getForm().createTextField(`${key}_resposta`).addToPage(this.page, { x: M, y: this.y, width: 90, height: 14, borderColor: LINE, backgroundColor: BOXBG, borderWidth: 0.5 });
    this.page.drawText("OBSERVACOES", { x: M + 104, y: this.y + 16, size: 7, font: this.bold, color: GRAY });
    const obs = this.doc.getForm().createTextField(`${key}_obs`); obs.enableMultiline();
    obs.addToPage(this.page, { x: M + 104, y: this.y - 14, width: this.W - 104, height: 28, borderColor: LINE, backgroundColor: BOXBG, borderWidth: 0.5 });
    this.y -= 28 + 10;
  }
  paragraph(text: string, size = 8.5) {
    const lines = wrap(this.font, text, size, this.W);
    this.ensure(lines.length * (size + 2.5) + 6);
    for (const ln of lines) { this.page.drawText(ln, { x: M, y: this.y, size, font: this.font, color: INK }); this.y -= size + 2.5; }
    this.y -= 4;
  }
  signatureArea() {
    this.ensure(70); this.y -= 10;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: M + this.W, y: this.y }, thickness: 0.5, color: LINE });
    this.y -= 16;
    this.page.drawText("ASSINADO ELETRONICAMENTE", { x: M, y: this.y, size: 9, font: this.bold, color: INK });
    this.y -= 12;
    this.page.drawText("(coloque aqui o campo de ASSINATURA do signatario no editor do Documenso)", { x: M, y: this.y, size: 7.5, font: this.font, color: GRAY });
    this.y -= 40;
  }
  async save(file: string) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const bytes = await this.doc.save();
    fs.writeFileSync(path.join(OUT_DIR, file), bytes);
    return this.doc.getForm().getFields().map((f) => f.getName());
  }
}

async function buildKys() {
  const b = new Builder("Formulario de Conformidade para Fornecedores - KYS");
  await b.init();
  b.section("Identificacao da empresa (pessoa juridica)");
  b.row2({ label: "RAZAO SOCIAL", name: "razao_social" }, { label: "CNPJ", name: "cnpj" });
  b.row2({ label: "NOME FANTASIA", name: "nome_fantasia" }, { label: "TELEFONE (CELULAR/FIXO)", name: "empresa_telefone" });
  b.field("ENDERECO (RUA, NUMERO, BAIRRO, COMPLEMENTO, CIDADE, ESTADO E CEP)", "empresa_endereco", { multiline: true, h: 26 });
  b.field("E-MAIL", "empresa_email");
  b.section("Dados bancarios");
  b.row2({ label: "BANCO / INSTITUICAO DE PAGAMENTO", name: "banco" }, { label: "AGENCIA", name: "agencia" });
  b.row2({ label: "CONTA-CORRENTE", name: "conta" }, { label: "CHAVE PIX", name: "chave_pix" });
  b.section("Identificacao do representante legal");
  b.row2({ label: "NOME COMPLETO", name: "rep_nome" }, { label: "CPF", name: "rep_cpf" });
  b.row2({ label: "ESTADO CIVIL", name: "rep_estado_civil" }, { label: "PROFISSAO", name: "rep_profissao" });
  b.field("ENDERECO (RUA, NUMERO, BAIRRO, COMPLEMENTO, CIDADE, ESTADO E CEP)", "rep_endereco", { multiline: true, h: 26 });
  b.row2({ label: "TELEFONE (CELULAR/FIXO)", name: "rep_telefone" }, { label: "E-MAIL", name: "rep_email" });
  for (const sec of KYS_SECTIONS) {
    b.section(sec.title);
    for (const q of sec.questions) b.question(q.text, q.key);
  }
  b.section("Observacoes");
  b.field("OBSERVACOES GERAIS", "observacoes", { multiline: true, h: 50 });
  b.signatureArea();
  return b.save("KYS_template.pdf");
}

async function buildKyg() {
  const b = new Builder("Declaracao de Conformidade - KYG");
  await b.init();
  b.section("Identificacao do proponente");
  b.row2({ label: "NOME / RAZAO SOCIAL", name: "proponente_nome" }, { label: "CPF / CNPJ", name: "proponente_documento" });
  b.field("NOME DO PROJETO", "projeto");
  b.field("ENDERECO (RUA, NUMERO, BAIRRO, COMPLEMENTO, CIDADE, ESTADO E CEP)", "proponente_endereco", { multiline: true, h: 26 });
  b.row2({ label: "TELEFONE", name: "proponente_telefone" }, { label: "E-MAIL", name: "proponente_email" });
  b.section("Dados bancarios (recebimento)");
  b.row2({ label: "BANCO / INSTITUICAO DE PAGAMENTO", name: "banco" }, { label: "AGENCIA", name: "agencia" });
  b.row2({ label: "CONTA-CORRENTE", name: "conta" }, { label: "CHAVE PIX", name: "chave_pix" });
  b.section("Declaracoes (sob as penas da lei)");
  b.paragraph("O proponente declara, sob as penas da lei, que:");
  KYG_DECLARACOES.forEach((d, i) => b.paragraph(`${i + 1}. ${d}`, 8.5));
  b.section("Observacoes");
  b.field("OBSERVACOES GERAIS", "observacoes", { multiline: true, h: 50 });
  b.signatureArea();
  return b.save("KYG_template.pdf");
}

(async () => {
  const kys = await buildKys();
  const kyg = await buildKyg();
  console.log(`KYS_template.pdf  → ${kys.length} campos:`, kys.join(", "));
  console.log(`KYG_template.pdf  → ${kyg.length} campos:`, kyg.join(", "));
  console.log(`\nArquivos em: ${OUT_DIR}`);
})();
