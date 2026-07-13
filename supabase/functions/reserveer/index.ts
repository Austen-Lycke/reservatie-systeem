// Edge function "reserveer": zet de datum 30 minuten vast en start de
// Mollie-betaling van de reservatiekosten. Geeft de checkout-URL terug
// waar de browser naartoe moet.
//
// Vereiste secrets (Edge Functions → Secrets):
//   MOLLIE_API_KEY  – test_... of live_... sleutel uit het Mollie-dashboard
//   SITE_URL        – adres van de reserveringspagina, bijv. https://reserveren.8-duust.be
import { createClient } from 'npm:@supabase/supabase-js@2';

// Prijzen in hele euro's — altijd hier bepaald, nooit door de browser.
// (De kopie in app.js dient alleen voor de live weergave; wijzig prijzen
// dus altijd op beide plekken.)
const PRIJZEN = {
  reservatiekosten: 60,
  frietjesFrikandel: 7,   // per persoon
  hamburgerFrietjes: 8,   // per persoon
  pita: 6,                // per persoon
  eigenFoodtruck: 25,     // forfait stroom/water/kabels/afval
  springkasteelEigenLeverancier: 15 // forfait stroom/kabels
};

const MUZIEK_KEUZES = ['eigenDj', 'spotify', 'bar'];
const SPRINGKASTEEL_KEUZES = ['vzw', 'eigenLeverancier', 'geen'];

// Maandag t/m donderdag gelden strengere regels: enkel teambuildings of
// vergaderingen, tussen 10:00 en 18:00, zonder muziek, vanaf 15 personen.
const WEEKDAG_TYPES = ['teambuilding', 'vergadering'];

function isWeekdag(datum: string): boolean {
  const dag = new Date(`${datum}T00:00:00Z`).getUTCDay();
  return dag >= 1 && dag <= 4;
}

type Prijsregel = { label: string; bedrag: number };

function geldigAantal(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 500;
}

// Controleert de extra opties en berekent de prijsregels + het totaal.
// Ontbrekende velden gelden als "nee"/"geen", zodat een oude (gecachte)
// versie van het formulier zonder extra's gewoon blijft werken.
function valideerExtras(ruw: unknown, weekdag: boolean):
  { fout: string } | { keuzes: Record<string, unknown>; prijsregels: Prijsregel[]; totaal: number } {
  const extras = (ruw && typeof ruw === 'object' ? ruw : {}) as Record<string, unknown>;
  const prijsregels: Prijsregel[] = [
    { label: 'Reservatiekosten', bedrag: PRIJZEN.reservatiekosten }
  ];

  // Foodtruck van de vzw: aantal personen per gerecht.
  const ft = (extras.foodtruckVzw && typeof extras.foodtruckVzw === 'object'
    ? extras.foodtruckVzw : {}) as Record<string, unknown>;
  const foodtruckGekozen = ft.gekozen === true;
  const gerechten: [keyof typeof PRIJZEN, string, unknown][] = [
    ['frietjesFrikandel', 'Frietjes met frikandel', ft.frietjesFrikandel],
    ['hamburgerFrietjes', 'Hamburger met frietjes', ft.hamburgerFrietjes],
    ['pita', 'Pita', ft.pita]
  ];
  const keuzesFoodtruck: Record<string, number> = {};
  let gerechtenTotaalAantal = 0;
  if (foodtruckGekozen) {
    for (const [sleutel, label, waarde] of gerechten) {
      const aantal = waarde === undefined || waarde === null || waarde === '' ? 0 : Number(waarde);
      if (!geldigAantal(aantal)) return { fout: 'Ongeldige extra opties.' };
      keuzesFoodtruck[sleutel] = aantal;
      gerechtenTotaalAantal += aantal;
      if (aantal > 0) {
        prijsregels.push({
          label: `${label} (${aantal} × € ${PRIJZEN[sleutel]})`,
          bedrag: aantal * PRIJZEN[sleutel]
        });
      }
    }
    if (gerechtenTotaalAantal < 1) {
      return { fout: 'Kies minstens één gerecht bij de foodtruck van de vzw, of zet die optie op "nee".' };
    }
  }

  // Eigen foodtruck: vast forfait.
  const eigenFoodtruck = extras.eigenFoodtruck === true;
  if (eigenFoodtruck) {
    prijsregels.push({
      label: 'Eigen foodtruck (forfait stroom/water/kabels/afval)',
      bedrag: PRIJZEN.eigenFoodtruck
    });
  }

  const bbq = extras.bbq === true;

  // Drankkaarten bestaan niet meer. Een oud (gecacht) formulier kan er nog
  // eentje meesturen; stilzwijgend negeren zou minder aanrekenen dan de klant
  // op het scherm zag, dus expliciet weigeren.
  const dk = (extras.drankkaarten && typeof extras.drankkaarten === 'object'
    ? extras.drankkaarten : {}) as Record<string, unknown>;
  if (dk.keuze === 'vooraf20' || dk.keuze === 'vooraf12') {
    return { fout: 'Drankkaarten worden niet meer aangeboden. Herlaad de pagina en probeer opnieuw.' };
  }

  // Muziek: op ma-do niet mogelijk — het formulier stuurt het veld dan niet
  // mee en de keuze wordt ook niet opgeslagen. In het weekend verplicht.
  let muziek: string | undefined;
  if (weekdag) {
    if (extras.muziek !== undefined) {
      return { fout: 'Op maandag t/m donderdag is muziek niet mogelijk.' };
    }
  } else {
    muziek = extras.muziek === undefined ? 'bar' : String(extras.muziek);
    if (!MUZIEK_KEUZES.includes(muziek)) return { fout: 'Ongeldige extra opties.' };
  }

  const springkasteel = extras.springkasteel === undefined ? 'geen' : String(extras.springkasteel);
  if (!SPRINGKASTEEL_KEUZES.includes(springkasteel)) return { fout: 'Ongeldige extra opties.' };
  if (springkasteel === 'eigenLeverancier') {
    prijsregels.push({
      label: 'Springkasteel eigen leverancier (forfait stroom/kabels)',
      bedrag: PRIJZEN.springkasteelEigenLeverancier
    });
  }

  return {
    keuzes: {
      foodtruckVzw: foodtruckGekozen ? keuzesFoodtruck : false,
      eigenFoodtruck,
      bbq,
      ...(muziek !== undefined && { muziek }),
      springkasteel
    },
    prijsregels,
    totaal: prijsregels.reduce((som, regel) => som + regel.bedrag, 0)
  };
}

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

  const weekdag = isWeekdag(datum);

  const aantalPersonen = Number(invoer.aantalPersonen);
  const minPersonen = weekdag ? 15 : 25;
  if (!Number.isInteger(aantalPersonen) || aantalPersonen < minPersonen || aantalPersonen > 500) {
    return antwoord(400, {
      fout: weekdag
        ? 'Op maandag t/m donderdag kan je reserveren vanaf 15 personen (maximaal 500).'
        : 'Reserveren kan vanaf minimaal 25 personen (maximaal 500).'
    });
  }

  const startTijd = String(invoer.startTijd ?? '');
  const eindTijd = String(invoer.eindTijd ?? '');
  const TIJD_FORMAAT = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!TIJD_FORMAAT.test(startTijd) || !TIJD_FORMAAT.test(eindTijd)) {
    return antwoord(400, { fout: 'Ongeldige tijden.' });
  }
  if (startTijd < '10:00') {
    return antwoord(400, { fout: 'Reserveren kan ten vroegste vanaf 10:00.' });
  }
  if (weekdag) {
    if (eindTijd > '18:00' || eindTijd <= startTijd) {
      return antwoord(400, { fout: 'Op maandag t/m donderdag kan je enkel reserveren tussen 10:00 en 18:00.' });
    }
    if (!WEEKDAG_TYPES.includes(String(invoer.typeFeest ?? '').trim().toLowerCase())) {
      return antwoord(400, { fout: 'Op maandag t/m donderdag zijn enkel teambuildings en vergaderingen mogelijk.' });
    }
  }

  // Extra opties controleren en het totaal berekenen vóór we de datum
  // vastzetten: een ongeldige aanvraag mag de datum nooit blokkeren.
  const extrasResultaat = valideerExtras(invoer.extras, weekdag);
  if ('fout' in extrasResultaat) {
    return antwoord(400, { fout: extrasResultaat.fout });
  }
  const { keuzes, prijsregels, totaal } = extrasResultaat;

  const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // 1. Datum vastzetten (geel). De databasefunctie bewaakt alle spelregels
  //    en garandeert dat er nooit twee reserveringen op één dag kunnen bestaan.
  const { error: reserveerFout } = await admin.rpc('maak_reservering', {
    p_datum: datum,
    p_naam: invoer.naam,
    p_email: invoer.email,
    p_telefoon: invoer.telefoon,
    p_type_feest: invoer.typeFeest,
    p_aantal_personen: invoer.aantalPersonen,
    p_start_tijd: invoer.startTijd,
    p_eind_tijd: invoer.eindTijd,
    p_opbouw_minuten: invoer.opbouwMinuten,
    p_opbouw_vanaf: invoer.opbouwVanaf,
    p_opmerkingen: invoer.opmerkingen,
    p_extra_opties: { keuzes, prijsregels },
    p_totaal_bedrag: totaal
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
      // Hele euro's; toFixed(2) levert het formaat dat Mollie eist ("125.00").
      amount: { currency: 'EUR', value: totaal.toFixed(2) },
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
