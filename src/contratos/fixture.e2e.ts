/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Fixture E2E da Fase 1 (#136, Seção 17) — DoD. Rode com `npm run test:contratos:e2e`.
 *
 * Valida o pipeline ponta a ponta (extração → gate → minuta) contra o gabarito da
 * fixture "TR Assistente de Comunicação". A chamada ao DeepSeek ao vivo exige
 * DEEPSEEK_API_KEY (produção); aqui o gabarito é injetado como aiClient mock para
 * validar a plumbing (zod, lacunas, radar trabalhista, validações, render). O `.docx`
 * real (se presente em referencia/contratos/) é lido com mammoth como bônus.
 */
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mammoth from "mammoth";
import { fileURLToPath } from "node:url";
import { registerContratosRoutes } from "../../contratosRoutes";
import { extrairDados } from "./extracao";
import { renderContratoPdf, renderContratoHtml } from "./render";
import { addMeses } from "./validacoes";
import type { Contrato } from "./contratosTypes";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TR_DOCX = path.resolve(__dirname, "..", "..", "referencia", "contratos", "Termo de Referência_Assistente de Comunicação e Conteúdo.docx");

// ── Gabarito da extração (Seção 17) ──────────────────────────────────────────────
const GABARITO = {
  objeto: { valor: "Serviços de comunicação e produção de conteúdo", trechoFonte: "objeto do TR" },
  resumoEscopo: { valor: "Assistência de comunicação e conteúdo", trechoFonte: "escopo" },
  vigencia: {
    dataInicio: { valor: null, trechoFonte: null },
    dataFim: { valor: null, trechoFonte: null },
    duracaoMeses: { valor: 6, trechoFonte: "6 (seis) meses" },
    prorrogavel: { valor: true, trechoFonte: "prorrogável" },
    prorrogacaoMaxMeses: { valor: 12, trechoFonte: "até 12 meses" },
  },
  valorTotalCentavos: { valor: 1_800_000, trechoFonte: "R$ 18.000,00" },
  parcelas: Array.from({ length: 6 }, (_, i) => ({ numero: i + 1, valorCentavos: 300_000, vencimento: null, descricao: "5º dia útil do mês subsequente" })),
  condicoesPagamento: { valor: "NF conforme CNAEs + Relatório Mensal + validação da Diretoria", trechoFonte: "pagamento" },
  sla: { valor: "resposta em até 4 horas", trechoFonte: "4 horas" },
  localExecucao: { valor: "remoto", trechoFonte: "remoto" },
  equipamentosFornecidosPelaContratante: { valor: "laptop e celular corporativos + acessos", trechoFonte: "equipamentos" },
  lacunas: ["dados da contratada", "data de início", "issue JUR", "número da OC"],
  alertas: [],
  indiciosTrabalhistas: [
    { indicio: "jornada de 30 horas semanais", trecho: "30 horas semanais", gravidade: "alta" },
    { indicio: "tempo de resposta de até 4 horas", trecho: "responder em até 4 horas", gravidade: "media" },
    { indicio: "direcionamentos contínuos da área de Comunicação", trecho: "sob direção da área de Comunicação", gravidade: "media" },
    { indicio: "equipamentos corporativos", trecho: "laptop e celular corporativos", gravidade: "media" },
    { indicio: "integração a rotinas/reuniões internas", trecho: "participar das reuniões internas", gravidade: "baixa" },
  ],
  conflitosComPadrao: [],
};

const parseJsonSafe = (t: string) => { const i = t.indexOf("{"); if (i < 0) return null; try { return JSON.parse(t.slice(i, t.lastIndexOf("}") + 1)); } catch { return null; } };
const mockAi = { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(GABARITO) } }] }) } } };

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FALHA:", m); } };

async function main() {
  // 0) bônus: mammoth no .docx real (se presente)
  if (fs.existsSync(TR_DOCX)) {
    const txt = (await mammoth.extractRawText({ path: TR_DOCX })).value || "";
    ok(txt.length > 1000 && /comunica/i.test(txt), `mammoth lê o TR.docx real (${txt.length} chars)`);
  } else {
    console.log("  · TR.docx ausente em referencia/contratos/ — pulando leitura real (gabarito mockado)");
  }

  // 1) extração bate com o gabarito
  const r = await extrairDados("Termo de Referência — Assistente de Comunicação...", "tr", { aiClient: mockAi as any, parseJsonSafe });
  ok(r.ok, "extração concluída (schema zod válido)");
  const ex = r.extracao!;
  ok(/comunica/i.test(ex.objeto.valor || ""), "objeto: comunicação/produção de conteúdo");
  ok(ex.vigencia.duracaoMeses.valor === 6 && ex.vigencia.prorrogavel.valor === true && ex.vigencia.prorrogacaoMaxMeses.valor === 12, "vigência: 6 meses, prorrogável até 12");
  ok(ex.vigencia.dataInicio.valor === null && ex.vigencia.dataFim.valor === null, "datas de vigência ausentes (lacuna)");
  ok(ex.valorTotalCentavos.valor === 1_800_000, "valor total R$ 18.000,00");
  ok(ex.parcelas.length === 6 && ex.parcelas.every((p) => p.valorCentavos === 300_000), "6 parcelas de R$ 3.000,00");
  ok(["dados da contratada", "data de início", "issue JUR", "número da OC"].every((l) => ex.lacunas.includes(l)), "lacunas: contratada, início, JUR, OC");
  const grav = ex.indiciosTrabalhistas.map((i) => i.gravidade);
  ok(ex.indiciosTrabalhistas.length >= 5 && grav.includes("alta") && grav.filter((g) => g === "media").length >= 3 && grav.includes("baixa"), "radar trabalhista: ≥5 indícios (30h alta, ≥3 média, reuniões baixa)");

  // 2) contrato gerado bate com o gabarito (render)
  const hoje = new Date().toISOString().slice(0, 10);
  const contrato: Contrato = {
    id: "CH-CT-2026-001", status: "em_revisao", cnpj: "11222333000181", jira: { issueKey: "JUR-42" },
    dadosContratada: { cnpj: "11222333000181", razaoSocial: "Comunicação Criativa Ltda", naturezaJuridica: "Sociedade Empresária Limitada",
      endereco: { logradouro: "Rua Exemplo", numero: "100", municipio: "São Paulo", uf: "SP", cep: "01000-000" },
      representante: { nome: "Maria Silva", cpf: "39053344705", estadoCivil: "solteira", cargo: "Sócia-administradora", email: "maria@exemplo.com" } },
    objeto: ex.objeto.valor!, valorTotalCentavos: 1_800_000,
    parcelas: Array.from({ length: 6 }, (_, i) => ({ numero: i + 1, valorCentavos: 300_000, vencimento: addMeses(hoje, i + 1) })),
    vigenciaFim: addMeses(hoje, 7), versaoTC: "2026-05",
    aditivos: [], trilha: [], createdAt: hoje, createdBy: "e2e", updatedAt: hoje,
  };
  const html = renderContratoHtml(contrato);
  ok(/dezoito mil reais/.test(html) && /R\$ 18\.000,00/.test(html), "Cláusula 3ª: R$ 18.000,00 (dezoito mil reais)");
  ok((html.match(/R\$ 3\.000,00/g) || []).length >= 6, "Cláusula 4ª: 6 parcelas de R$ 3.000,00");
  ok(/CLÁUSULA 5ª/.test(html) && /2026-05/.test(html), "Cláusula 5ª referencia T&C versão 2026-05");
  const pdf = await renderContratoPdf(contrato);
  ok(pdf.slice(0, 5).toString() === "%PDF-", "PDF do contrato gerado");

  // 3) gate (16.2): sem KYS/diligência válidos → não chega ao passo 3 (extrair → 422)
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ct-e2e-"));
  const app = express(); app.use(express.json());
  const requireAuth = (req: any, _res: any, next: any) => { req.user = { email: "e2e@casahacker.org" }; next(); };
  const sanitizeSegment = (s: string) => (!s || /[/\\]|\.\./.test(s) ? null : s);
  registerContratosRoutes(app, { DATA_DIR, requireAuth, sanitizeSegment, aiClient: mockAi as any, extractTextFromFile: async () => "", parseJsonSafe });
  const server = app.listen(0); await new Promise<void>((res) => server.once("listening", () => res()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const j = (m: string, u: string, b?: any) => fetch(base + u, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(async (x) => ({ status: x.status, body: (await x.json().catch(() => null)) as any }));
  const id = (await j("POST", "/api/contratos", { cnpj: "11222333000181" })).body.id;
  ok((await j("POST", `/api/contratos/${id}/extrair`, { texto: "x" })).status === 422, "16.2 — sem KYS/diligência → extrair bloqueado (422)");

  // com fixtures (diligência NADA_CONSTA + KYS assinado) → o gate passa e a extração roda
  fs.mkdirSync(path.join(DATA_DIR, "diligencia"), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "kyc"), { recursive: true });
  const ano = new Date().getFullYear();
  fs.writeFileSync(path.join(DATA_DIR, "diligencia", "11222333000181.json"), JSON.stringify({ cnpj: "11222333000181", checkedAt: new Date().toISOString(), verdict: "NADA_CONSTA", receita: { situacao_cadastral: "ATIVA", porte: "DEMAIS", cnae_principal: "comunicação" } }));
  fs.writeFileSync(path.join(DATA_DIR, "kyc", "k.json"), JSON.stringify({ id: "k", type: "kys", status: "assinado", kys: { cnpj: "11222333000181" }, signedAt: new Date().toISOString(), fiscalYear: ano, validUntil: new Date(ano, 11, 31).toISOString() }));
  const ex2 = await j("POST", `/api/contratos/${id}/extrair`, { texto: "TR: 30 horas semanais...", tipoDocumento: "tr" });
  ok(ex2.status === 200 && ex2.body.valorTotalCentavos?.valor === 1_800_000, "elegível → extrair roda e devolve o gabarito");

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "✅ DoD da Fase 1 OK" : "❌ FALHOU"} — ${pass} passaram, ${fail} falharam`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERRO E2E:", e); process.exit(1); });
