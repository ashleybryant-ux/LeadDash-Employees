/**
 * The federal NPI Registry (NPPES, run by CMS): every licensed healthcare
 * provider and practice in the US, with practice address, phone and, for a
 * practice, the authorized official (usually the owner). Free and public; no key.
 * https://npiregistry.cms.hhs.gov/api/?version=2.1
 *
 * Riley starts from this list so she works from real, licensed practices, then
 * finds each one's website, email and license on the state board's lookup.
 */

export const NPI_HOST = "https://npiregistry.cms.hhs.gov";

const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const CODES = new Set(Object.values(STATES));

const stateOf = (s: string) => {
  const t = s.trim().replace(/\.$/, "");
  if (/^[A-Za-z]{2}$/.test(t) && CODES.has(t.toUpperCase())) return t.toUpperCase();
  return STATES[t.toLowerCase()] ?? null;
};

/** "Texas", "Austin, TX", "Oklahoma and Texas", "OKC, Oklahoma; Dallas, TX" → places to search. */
export function parseArea(area: string): { state: string; city?: string }[] {
  const out: { state: string; city?: string }[] = [];
  const add = (p: { state: string; city?: string }) => {
    if (!out.some((o) => o.state === p.state && (o.city ?? "") === (p.city ?? ""))) out.push(p);
  };
  for (const part of area.split(/;|\band\b|\bor\b|\//i).map((s) => s.trim()).filter(Boolean)) {
    const bits = part.split(",").map((s) => s.trim()).filter(Boolean);
    if (bits.length >= 2) {
      const st = stateOf(bits[bits.length - 1]);
      if (st) {
        add({ state: st, city: bits.slice(0, -1).join(" ") });
        continue;
      }
    }
    for (const b of bits) {
      const st = stateOf(b);
      if (st) add({ state: st });
    }
  }
  return out.slice(0, 4);
}

export type NpiPractice = {
  npi: string;
  name: string;
  city: string;
  state: string;
  phone: string;
  official: string;
  officialTitle: string;
  specialty: string;
  url: string;
};

/** What to look for. Practices that buy software, or referral partners for a practice. */
const SEARCHES = {
  practices: ["Counselor", "Clinic/Center, Mental Health", "Marriage & Family Therapist", "Social Worker, Clinical", "Psychologist"],
  "Pediatric offices": ["Pediatrics"],
  "Primary care": ["Family Medicine", "Internal Medicine"],
} as Record<string, string[]>;

const title = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Llc|Pllc|Pc|Pa|Lpc|Lcsw|Lmft|Inc)\b/g, (m) => m.toUpperCase());

async function query(params: Record<string, string>): Promise<any[]> {
  const qs = new URLSearchParams({ version: "2.1", enumeration_type: "NPI-2", limit: "200", ...params });
  try {
    const res = await fetch(`${NPI_HOST}/api/?${qs.toString()}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { results?: any[]; Errors?: unknown };
    return Array.isArray(body.results) ? body.results : [];
  } catch {
    return [];
  }
}

/** Practices from the NPI Registry for the given places and kinds, de-duplicated. */
export async function npiPractices(places: { state: string; city?: string }[], kinds: string[], max = 40): Promise<NpiPractice[]> {
  const descs = Array.from(new Set(kinds.flatMap((k) => SEARCHES[k] ?? [])));
  if (!places.length || !descs.length) return [];
  const seen = new Map<string, NpiPractice>();
  for (const place of places) {
    const batches = await Promise.all(descs.map((d) => query({ taxonomy_description: d, state: place.state, ...(place.city ? { city: place.city } : {}) })));
    for (const r of batches.flat()) {
      const b = r?.basic ?? {};
      if (b.status && b.status !== "A") continue;
      const name = String(b.organization_name ?? "").trim();
      if (!name || seen.has(String(r.number))) continue;
      const loc = (r.addresses ?? []).find((a: any) => a.address_purpose === "LOCATION") ?? (r.addresses ?? [])[0] ?? {};
      if (loc.state && loc.state !== place.state) continue;
      const tax = (r.taxonomies ?? []).find((t: any) => t.primary) ?? (r.taxonomies ?? [])[0] ?? {};
      const official = [b.authorized_official_first_name, b.authorized_official_last_name].filter(Boolean).join(" ");
      seen.set(String(r.number), {
        npi: String(r.number),
        name: title(name),
        city: loc.city ? `${title(String(loc.city))}, ${loc.state}` : place.state,
        state: String(loc.state ?? place.state),
        phone: String(loc.telephone_number ?? b.authorized_official_telephone_number ?? ""),
        official: official ? title(official) : "",
        officialTitle: b.authorized_official_title_or_position ? title(String(b.authorized_official_title_or_position)) : "",
        specialty: String(tax.desc ?? ""),
        url: `${NPI_HOST}/provider-view/${r.number}`,
      });
    }
  }
  return Array.from(seen.values()).slice(0, max);
}

/** The NPI kinds that match what Riley is looking for. */
export function npiKinds(sells: "software" | "therapy", partnerTypes: string[]) {
  return sells === "software" ? ["practices"] : partnerTypes.filter((p) => SEARCHES[p]);
}
