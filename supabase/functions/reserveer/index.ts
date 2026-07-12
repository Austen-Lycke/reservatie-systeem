// Edge function "reserveer": zet de datum 30 minuten vast en start de
// Mollie-betaling van de reservatiekosten. Geeft de checkout-URL terug
// waar de browser naartoe moet.
//
// Vereiste secrets (Edge Functions → Secrets):
//   MOLLIE_API_KEY  – test_... of live_... sleutel uit het Mollie-dashboard
//   SITE_URL        – adres van de reserveringspagina, bijv. https://reserveren.8-duust.be
import { createClient } from 'npm:@supabase/supabase-js@2';

const RESERVATIEKOSTEN = '60.00'; // euro — altijd hier bepaald, nooit door de browser

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function antwoord(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return antwoord(405, { fout: 'Alleen POST is toegestaan.' });

  const mollieSleutel = Deno.env.get('MOLLIE_API_KEY');
  const siteUrl = Deno.env.get('SITE_URL');
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  if (!mollieSleutel || !siteUrl) {
    return antwoord(500, { fout: 'Server niet volledig geconfigureerd (MOLLIE_API_KEY / SITE_URL ontbreekt).' });
  }

  let invoer: Record<string, unknown>;
  try {
    invoer = await req.json();
  } catch {
    return antwoord(400, { fout: 'Ongeldige aanvraag.' });
  }

  const datum = String(invoer.datum ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) {
    return antwoord(400, { fout: 'Ongeldige datum.' });
  }

  const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // 1. Datum vastzetten (geel). De databasefunctie bewaakt alle spelregels
  //    en garandeert dat er nooit twee reserveringen op één dag kunnen bestaan.
  const { error: reserveerFout } = await admin.rpc('maak_reservering', {
    p_datum: datum,
    p_naam: invoer.naam,
    p_email: invoer.email,
    p_telefoon: invoer.telefoon,
    p_aantal_personen: invoer.aantalPersonen,
    p_start_tijd: invoer.startTijd,
    p_eind_tijd: invoer.eindTijd,
    p_opbouw_minuten: invoer.opbouwMinuten,
    p_opbouw_vanaf: invoer.opbouwVanaf,
    p_opmerkingen: invoer.opmerkingen
  });
  if (reserveerFout) {
    const bericht = reserveerFout.message.includes('BEZET')
      ? 'Deze datum is zojuist al door iemand anders gereserveerd.'
      : reserveerFout.message;
    return antwoord(409, { fout: bericht });
  }

  // 2. Mollie-betaling aanmaken.
  const terugUrl = new URL(siteUrl);
  terugUrl.searchParams.set('betaling', datum);

  const mollieAntwoord = await fetch('https://api.mollie.com/v2/payments', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${mollieSleutel}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: { currency: 'EUR', value: RESERVATIEKOSTEN },
      description: `Reservatie privéfeest ${datum}`,
      redirectUrl: terugUrl.toString(),
      webhookUrl: `${supabaseUrl}/functions/v1/mollie-webhook`,
      metadata: { datum }
    })
  });

  if (!mollieAntwoord.ok) {
    // Betaling kon niet gestart worden: datum meteen weer vrijgeven.
    await admin.from('reserveringen').delete().eq('datum', datum);
    console.error('Mollie-fout:', await mollieAntwoord.text().catch(() => '?'));
    return antwoord(502, { fout: 'De betaling kon niet gestart worden. Probeer het later opnieuw.' });
  }

  const betaling = await mollieAntwoord.json();

  // 3. Betalings-id bewaren, zodat de webhook kan controleren dat een late
  //    betaling nog steeds bij déze reservering hoort.
  await admin.from('reservering_details')
    .update({ mollie_betaling_id: betaling.id })
    .eq('datum', datum);

  return antwoord(200, { checkoutUrl: betaling._links?.checkout?.href });
});
