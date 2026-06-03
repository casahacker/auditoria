/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared types for the FEAC / SGPP Processador de Prestação de Contas (Tool B).
 * Pure types only — imported by the React client (src/feac/FeacApp.tsx).
 * The Express backend (feacRoutes.ts) mirrors these shapes with plain objects,
 * matching the server's existing `any`-shaped convention.
 */

/** Loose shape for the CNPJ lookup response surfaced in the lançamento modal. */
export type CNPJDataLike = Record<string, any>;

export type RateioFlag = 'SIM' | 'NAO';

export type FeacMatchStatus =
  | 'OK'                // NF + comprovante matched, values agree
  | 'SEM_NF'            // missing nota fiscal
  | 'SEM_COMPROVANTE'   // missing payment proof
  | 'SEM_AMBOS'         // both missing
  | 'VALOR_DIVERGENTE'  // matched but value mismatch
  | 'DUPLICADO';        // doc claimed by >1 lançamento / duplicate ledger row

export type FeacStage = 'criado' | 'extraido' | 'auditado' | 'tratado' | 'concluido';

export type FeacSourceKind = 'notas' | 'comprovantes' | 'extrato';

export type FeacMatchMethod = 'deterministic' | 'fuzzy' | 'filename' | 'manual';

/** A located source document (a nota fiscal or a comprovante) inside an uploaded bundle. */
export interface FeacDocRef {
  sourceFile: FeacSourceKind;
  pages: number[];          // 1-based page numbers within that source PDF
  confidence: number;       // 0..1 from the matcher
  method: FeacMatchMethod;
  extractedValue?: number;
  extractedDate?: string;   // dd/mm/yyyy
  extractedName?: string;
  extractedTaxId?: string;  // CPF/CNPJ digits
  docNumber?: string;       // NFS-e number / transaction id
}

export interface FeacLancamento {
  id: string;               // STABLE per-item id (uuid) — survives export/import
  rowNum?: number;          // original "#" column (e.g. 198)
  chave: string;            // "Chave" column, e.g. "42026ASSESSORIA DE IMPACTO"
  dataPagamento: string;    // dd/mm/yyyy
  categoria: string;
  descricao: string;
  grupoNatureza: string;    // "grupo da natureza orçamentária (FEAC)"
  natureza: string;         // "natureza orçamentária (FEAC)"
  fornecedor: string;       // ledger "Nome do Fornecedor" (free text)
  razaoSocial?: string;     // official razão social resolved from the CNPJ API (Receita)
  entrada: number;
  saida: number;            // negative in sheet; abs() used for matching
  saldo: number;
  observacao: string;       // holds FIN-#### + CNPJ/PIX details
  finRef?: string;          // parsed FIN-#### from observacao
  taxId?: string;           // parsed CPF/CNPJ from observacao
  rateio: RateioFlag;       // auditor-set in the preliminary report; default 'NAO'
  rateioValorProjeto?: number;
  rateioValorProprio?: number;
  nf?: FeacDocRef | null;
  comprovante?: FeacDocRef | null;
  matchStatus: FeacMatchStatus;
  valorDivergencia?: number; // |doc value − |saida|| when VALOR_DIVERGENTE
  auditorNote?: string;
  treatedPdf?: string;       // filename of merged+stamped+PDF/A output (relative)
}

/** A detected NF/comprovante that matched no ledger row. */
export interface FeacOrphanDoc {
  kind: 'nf' | 'comprovante';
  sourceFile: FeacSourceKind;
  pages: number[];
  extractedValue?: number;
  extractedDate?: string;
  extractedName?: string;
  extractedTaxId?: string;
  docNumber?: string;
}

/** Header fields of the FEAC "Relatório de Prestação de Contas". */
export interface FeacAccountability {
  contractNumber: string;       // "Número do Contrato" (TEXT input, used in stamp)
  notasComplementares: string;  // "Notas Complementares..." (TEXT input, used in stamp)
  projeto?: string;
  competencia?: string;         // month/year derived from ledger (e.g. 04/2026)
  centroCusto?: string;
  periodoInicio?: string;
  periodoFim?: string;
  totalSaidas: number;
  totalEntradas: number;
  saldoFinal: number;
}

export interface FeacTreatmentInfo {
  perItem: boolean;
  zipFile?: string;
  rateioPdf?: string;
  fluxoCaixaUpdated?: string;
  treatedCount?: number;
  errors?: { lancamentoId: string; message: string }[];
  treatedAt?: string;
}

export interface FeacSourceFiles {
  notas?: string;
  comprovantes?: string;
  extrato?: string;
  fluxoCaixa?: string;
}

export interface FeacProcessing {
  id: string;               // STABLE record id (uuid) — the "key"
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  stage: FeacStage;
  schemaVersion: 1;
  accountability: FeacAccountability;
  lancamentos: FeacLancamento[];
  orphans?: FeacOrphanDoc[];
  sourceFiles: FeacSourceFiles;
  treatment?: FeacTreatmentInfo;
  ledgerSheetName?: string;
}

/** Summary row returned by GET /api/feac (list). */
export interface FeacSummary {
  id: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  stage: FeacStage;
  contractNumber: string;
  competencia?: string;
  projeto?: string;
  lancamentosCount: number;
  okCount: number;
  totalSaidas: number;
}

/** The round-trip export/import artifact (download → edit → re-upload). */
export interface FeacExportArtifact {
  kind: 'feac-preliminar';
  schemaVersion: 1;
  id: string;
  exportedAt: string;
  accountability: FeacAccountability;
  lancamentos: FeacLancamento[];
}
