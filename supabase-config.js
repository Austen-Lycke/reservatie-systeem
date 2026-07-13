// Plak hier de gegevens van je eigen Supabase-project.
// Zie README.md voor stap-voor-stap instructies.
// Je vindt beide waarden in Supabase onder: Project Settings → API.
//
// Zolang onderstaande waarden niet zijn ingevuld, draait de app in DEMO-MODUS:
// reserveringen worden dan alleen lokaal in deze browser opgeslagen.
export const supabaseConfig = {
  url: "https://mbvvqdvsspersyjzuyqi.supabase.co",
  anonKey: "sb_publishable_F5EWja5tNe14P71P9ac8IA_dFCVDpdY",
  // Optioneel: Cloudflare Turnstile (gratis anti-bot-controle op het
  // reserveringsformulier). Vul hier de SITE key in en zet de SECRET key als
  // Supabase-secret TURNSTILE_SECRET_KEY — zie README. Leeg = uitgeschakeld.
  turnstileSiteKey: ""
};
