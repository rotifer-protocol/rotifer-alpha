function toSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function stripPolymarketNumericSuffix(value: string): string {
  return value.replace(/-\d{2,}$/g, "");
}

function normalizeCompetitionTerms(value: string): string {
  return value
    .replace(/-playoffs-/g, "-")
    .replace(/-finals?$/g, "-champion")
    .replace(/^(next-.+)-actor$/g, "$1")
    .replace(/-(first|second|1st|2nd)-round-winner$/g, "")
    .replace(/-winner$/g, "");
}

function inferFromQuestionShape(value: string): string | null {
  const winMatch = value.match(/^will-.+?-win-(?:the-)?(.+)$/);
  if (winMatch) return normalizeCompetitionTerms(winMatch[1]);

  const beNextMatch = value.match(/^will-.+?-be-(?:the-)?(.+)$/);
  if (beNextMatch) return normalizeCompetitionTerms(beNextMatch[1]);

  const announcedMatch = value.match(/^.+?-(?:announced|named)-as-(?:the-)?(.+)$/);
  if (announcedMatch) return normalizeCompetitionTerms(announcedMatch[1]);

  return null;
}

function canonicalize(value: string): string {
  const slug = normalizeCompetitionTerms(stripPolymarketNumericSuffix(toSlug(value)));
  const inferred = inferFromQuestionShape(slug);
  return inferred || slug;
}

/**
 * Groups correlated child markets into one risk bucket.
 *
 * This is intentionally used only for risk gates, not for persistence/display:
 * paper_trades.slug remains the original Polymarket event slug for auditability.
 */
export function eventFamilyKey(slug?: string | null, question?: string | null): string {
  const candidates = [slug, question]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map(canonicalize)
    .filter(Boolean);

  return candidates[0] || "unknown-event";
}
