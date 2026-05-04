/**
 * Phenotype Registry
 *
 * Single import point for all Gene phenotype descriptors.
 * These are the protocol-layer authoritative definitions (RotiferGeneSpec § 4.2).
 *
 * Casing note: fidelity here uses UPPERCASE ("NATIVE" | "HYBRID" | "WRAPPED")
 * per § 4.2. The runtime GENE_REGISTRY in gene-interface.ts uses lowercase for
 * TypeScript dispatch — the two must agree semantically.
 */

import scannerPhenotype from "./scanner.phenotype.json";
import monitorPhenotype from "./monitor.phenotype.json";
import riskPhenotype from "./risk.phenotype.json";
import settlerPhenotype from "./settler.phenotype.json";
import traderPhenotype from "./trader.phenotype.json";
import evolverPhenotype from "./evolver.phenotype.json";

export interface PhenotypeDescriptor {
  gene: string;
  version: string;
  author: string;
  domain: string;
  fidelity: "NATIVE" | "HYBRID" | "WRAPPED";
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  network: { allowedDomains: string[] };
  dependencies: Array<{ id: string; type: string; required: boolean; description?: string }>;
  transparency: {
    deterministic: boolean;
    sideEffects: string;
    stateAccess: string;
    note?: string;
  };
}

export const PHENOTYPE_REGISTRY: PhenotypeDescriptor[] = [
  scannerPhenotype as PhenotypeDescriptor,
  monitorPhenotype as PhenotypeDescriptor,
  riskPhenotype as PhenotypeDescriptor,
  settlerPhenotype as PhenotypeDescriptor,
  traderPhenotype as PhenotypeDescriptor,
  evolverPhenotype as PhenotypeDescriptor,
];

export {
  scannerPhenotype,
  monitorPhenotype,
  riskPhenotype,
  settlerPhenotype,
  traderPhenotype,
  evolverPhenotype,
};
