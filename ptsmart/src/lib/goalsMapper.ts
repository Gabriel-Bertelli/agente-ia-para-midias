// ── Goals mapper ───────────────────────────────────────────────────────────
//
// Maps raw Supabase row fields (platform, tipo_campanha, produto) to the
// canonical keys used in the goals sheet (canal, BU).
//
// Canal mapping rules (evaluated in priority order):
//   1. tipo_campanha contains "lead" and "ads"  → "lead_ads"
//   2. tipo_campanha contains "whatsapp"         → "whatsapp_ativo"
//   3. tipo_campanha contains "meta site"        → "meta_site"
//   4. tipo_campanha is a known Google type      → "google"
//   5. tipo_campanha is a known Meta/FB type     → "meta_outros"
//   6. tipo_campanha is a known Bing type        → "bing"
//   7. platform = "Google" (any tipo_campanha)   → "google"
//   8. platform = "Facebook" / "Meta"            → "meta_outros"
//   9. platform = "Bing"                         → "bing"
//  10. everything else                           → "outros"

const GOOGLE_TYPES = ['search', 'pmax', 'google search', 'google pmax', 'google youtube', 'google outros', 'performance max'];
const META_TYPES   = ['facebook catalogo', 'facebook outros', 'meta outros'];
const BING_TYPES   = ['bing ads', 'bing'];

export function mapToCanal(platform: string, tipoCampanha: string): string {
  const tc = (tipoCampanha ?? '').toLowerCase().trim();
  const pl = (platform     ?? '').toLowerCase().trim();

  if (tc.includes('lead') && tc.includes('ads'))                        return 'lead_ads';
  if (tc.includes('whatsapp'))                                          return 'whatsapp_ativo';
  if (tc.includes('meta site') || tc === 'meta_site')                   return 'meta_site';
  if (tc.includes('guia') && tc.includes('site'))                       return 'meta_site';
  if (GOOGLE_TYPES.some(g => tc.includes(g)) || tc.includes('google'))  return 'google';
  if (META_TYPES.some(m => tc === m) || tc.includes('facebook'))        return 'meta_outros';
  if (BING_TYPES.some(b => tc === b) || tc.includes('bing'))            return 'bing';
  if (pl.includes('google'))                                            return 'google';
  if (pl.includes('facebook') || pl.includes('meta'))                   return 'meta_outros';
  if (pl.includes('bing'))                                              return 'bing';
  return 'outros';
}

// BU mapping: produto field in Supabase matches BU in goals sheet exactly.
export function mapToBU(produto: string): string {
  return (produto ?? '').trim();
}
