import type { NormalizationContext, NormalizedOutput } from '@/lib/normalizer';
import type { SovereignIngestEnvelope } from './ingest-envelope';
import { normalizeIngestEnvelope } from './ingest-pipeline';

export interface ProviderNormalizationResult {
  normalized:        NormalizedOutput[];
  received:          number;
  classified:        number;
  token_classified:  number;
  skipped:           number;
}

export function normalizeProviderEnvelopes(
  envelopes: ReadonlyArray<SovereignIngestEnvelope>,
  ctx: NormalizationContext,
): ProviderNormalizationResult {
  const outputs = envelopes.map(env => normalizeIngestEnvelope(env, ctx));

  const normalized = outputs.filter(
    out => !out.skipped && (out.movement !== null || out.tokenMovement !== null),
  );

  return {
    normalized,
    received:         envelopes.length,
    classified:       outputs.filter(out => out.movement !== null).length,
    token_classified: outputs.filter(out => out.tokenMovement !== null).length,
    skipped:          outputs.filter(
      out => out.skipped || (out.movement === null && out.tokenMovement === null),
    ).length,
  };
}
