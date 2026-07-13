// Edge function "mollie-webhook": wordt door Mollie aangeroepen zodra de
// status van een betaling verandert. Bevestigt de reservering (rood) bij
// een geslaagde betaling, of geeft de datum weer vrij als de betaling is
// afgebroken, mislukt of verlopen. Na een geslaagde betaling gaat er ook
// een e-mail met alle reservatiegegevens naar de organisatie.
//
// Belangrijk: deze functie moet bereikbaar zijn ZONDER Supabase-JWT
// (verify_jwt = false), anders kan Mollie hem niet aanroepen.
//
// Extra secrets voor de e-mail (Edge Functions → Secrets):
//   RESEND_API_KEY  – API-sleutel van https://resend.com (zonder deze sleutel
//                     wordt er simpelweg geen mail gestuurd; de rest werkt gewoon)
//   EMAIL_AFZENDER  – afzenderadres, bijv. "Reservaties <reservaties@8-duust.be>"
//                     (het domein moet in Resend geverifieerd zijn; tijdens het
//                     testen mag je dit weglaten: dan wordt onboarding@resend.dev
//                     gebruikt)
import { createClient } from 'npm:@supabase/supabase-js@2';

const EMAIL_ONTVANGER = 'info@8-duust.be';

// Weergaveteksten voor de extra opties in de mail. Alleen labels — de
// bedragen komen uit de prijsregels die bij het boeken zijn vastgelegd.
const MUZIEK_LABELS: Record<string, string> = {
  eigenDj: 'Eigen DJ (voorziet zelf materiaal)',
  spotify: 'Eigen Spotify-playlist',
  bar: 'Bar verzorgt de muziek'
};
const SPRINGKASTEEL_LABELS: Record<string, string> = {
  vzw: 'Springkasteel van de vzw',
  eigenLeverancier: 'Eigen leverancier',
  geen: 'Geen'
};
const DRANKKAART_LABELS: Record<string, string> = {
  vooraf20: 'Vooraf besteld (€ 20 per kaart)',
  vooraf12: 'Vooraf besteld (€ 12 per kaart)',
  terPlaatse: 'Regelt de klant ter plaatse',
  geen: 'Geen'
};

// Waarden netjes tonen in de mail; lege velden worden een streepje.
function toon(waarde: unknown): string {
  const tekst = String(waarde ?? '').trim();
  return tekst === '' ? '—' : tekst
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// Stuurt de bevestigingsmail naar de organisatie. Mag nooit de webhook laten
// falen: bij problemen loggen we alleen (de reservering is dan al bevestigd).
async function stuurBevestigingsmail(
  details: Record<string, unknown>,
  datum: string,
  betalingId: string
): Promise<void> {
  const resendSleutel = Deno.env.get('RESEND_API_KEY');
  if (!resendSleutel) {
    console.error('RESEND_API_KEY ontbreekt: geen bevestigingsmail gestuurd voor', datum);
    return;
  }
  const afzender = Deno.env.get('EMAIL_AFZENDER') ?? 'Reservaties <onboarding@resend.dev>';

  const datumMooi = new Date(`${datum}T12:00:00`).toLocaleDateString('nl-BE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  const opbouwMinuten = Number(details.opbouw_minuten ?? 0);
  const opbouw = opbouwMinuten > 0
    ? `${opbouwMinuten} minuten vooraf${details.opbouw_vanaf ? ` (vanaf ${toon(details.opbouw_vanaf)})` : ''}`
    : 'geen';

  const rijen: [string, string][] = [
    ['Datum', `${datumMooi}`],
    ['Naam', toon(details.naam)],
    ['E-mail', toon(details.email)],
    ['Telefoon', toon(details.telefoon)],
    ['Type feest', toon(details.type_feest)],
    ['Aantal personen', toon(details.aantal_personen)],
    ['Uren', `${toon(details.start_tijd)} – ${toon(details.eind_tijd)}`],
    ['Opbouw', opbouw],
    ['Opmerkingen', toon(details.opmerkingen)]
  ];

  // Extra opties: keuzes zonder prijs als gewone rijen, daarna de prijsregels
  // zoals ze bij het boeken zijn vastgelegd. Oude reserveringen zonder
  // extra_opties tonen alleen de bestaande rijen.
  const extra = details.extra_opties as {
    keuzes?: Record<string, unknown>;
    prijsregels?: { label: string; bedrag: number }[];
  } | null;
  const keuzes = extra?.keuzes;
  if (keuzes) {
    rijen.push(
      ['Eigen foodtruck', keuzes.eigenFoodtruck ? 'Ja (forfait € 25)' : 'Nee'],
      ['BBQ zelf meebrengen', keuzes.bbq ? 'Ja' : 'Nee']
    );
    // Drankkaarten bestaan niet meer en op ma-do is er geen muziekkeuze;
    // alleen tonen wat er bij het boeken echt is vastgelegd.
    if (keuzes.drankkaarten !== undefined) {
      const drankkaarten = (keuzes.drankkaarten ?? {}) as Record<string, unknown>;
      rijen.push(['Drankkaarten', DRANKKAART_LABELS[String(drankkaarten.keuze)] ?? '—']);
    }
    if (keuzes.muziek !== undefined) {
      rijen.push(['Muziek', MUZIEK_LABELS[String(keuzes.muziek)] ?? '—']);
    }
    rijen.push(['Springkasteel', SPRINGKASTEEL_LABELS[String(keuzes.springkasteel)] ?? '—']);
  }
  for (const regel of extra?.prijsregels ?? []) {
    rijen.push([toon(regel.label), `€ ${Number(regel.bedrag)}`]);
  }
  rijen.push(['Totaal betaald', `€ ${Number(details.totaal_bedrag ?? 60)}`]);
  rijen.push(['Mollie-betaling', toon(betalingId)]);

  const tabel = rijen.map(([label, waarde]) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#555;white-space:nowrap;vertical-align:top">${label}</td>` +
    `<td style="padding:6px 0"><strong>${waarde}</strong></td></tr>`
  ).join('');

  const antwoord = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendSleutel}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: afzender,
      to: [EMAIL_ONTVANGER],
      reply_to: String(details.email ?? '') || undefined,
      subject: `Nieuwe reservatie: ${datumMooi} — ${toon(details.naam)}`,
      html:
        `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">` +
        `<h2 style="margin:0 0 4px">Nieuwe reservatie bevestigd ✅</h2>` +
        `<p style="margin:0 0 16px">De betaling van de reservatiekosten is geslaagd. Alle gegevens:</p>` +
        `<table style="border-collapse:collapse">${tabel}</table>` +
        `<p style="margin:16px 0 0;color:#777;font-size:13px">Deze mail is automatisch verstuurd door het reserveringssysteem.</p>` +
        `</div>`
    })
  });

  if (!antwoord.ok) {
    console.error('Bevestigingsmail versturen mislukt:', antwoord.status,
      await antwoord.text().catch(() => '?'));
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok');

  const mollieSleutel = Deno.env.get('MOLLIE_API_KEY');
  if (!mollieSleutel) return new Response('MOLLIE_API_KEY ontbreekt', { status: 500 });

  // Mollie stuurt alleen een betalings-id; de echte status vragen we altijd
  // zelf bij Mollie op, zodat niemand met een nep-webhook een reservering
  // kan bevestigen.
  let betalingId = '';
  try {
    const form = await req.formData();
    betalingId = String(form.get('id') ?? '');
  } catch {
    // geen geldig formulier
  }
  if (!betalingId) return new Response('geen id', { status: 400 });

  const mollieAntwoord = await fetch(`https://api.mollie.com/v2/payments/${betalingId}`, {
    headers: { 'Authorization': `Bearer ${mollieSleutel}` }
  });
  if (mollieAntwoord.status === 404) return new Response('onbekende betaling');
  if (!mollieAntwoord.ok) {
    // Tijdelijk probleem bij Mollie: met een 5xx-antwoord probeert Mollie
    // de webhook later automatisch opnieuw.
    return new Response('Mollie tijdelijk niet bereikbaar', { status: 502 });
  }

  const betaling = await mollieAntwoord.json();
  const datum: string | undefined = betaling.metadata?.datum;
  if (!datum) return new Response('ok');

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  if (betaling.status === 'paid') {
    // Controleer dat deze betaling nog steeds bij de huidige reservering op
    // deze datum hoort. In het zeldzame geval dat de klant pas ná de
    // wachttijd van 30 minuten betaalde én iemand anders de datum intussen
    // opnieuw boekte, hoort het geld terug naar de trage betaler.
    const { data: details } = await admin.from('reservering_details')
      .select('*')
      .eq('datum', datum)
      .maybeSingle();

    if (!details || details.mollie_betaling_id !== betalingId) {
      console.error(`Betaling ${betalingId} hoort niet (meer) bij ${datum}; terugbetaling gestart.`);
      const terugbetaling = await fetch(`https://api.mollie.com/v2/payments/${betalingId}/refunds`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${mollieSleutel}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          amount: betaling.amount,
          description: `Datum ${datum} was intussen bezet`
        })
      });
      if (!terugbetaling.ok) {
        console.error('Automatische terugbetaling mislukt; handel af via het Mollie-dashboard:',
          await terugbetaling.text().catch(() => '?'));
      }
      return new Response('ok');
    }

    const { data: bevestigd } = await admin.from('reserveringen')
      .update({ status: 'betaald', verloopt_op: null })
      .eq('datum', datum)
      .eq('status', 'in_afwachting')
      .select('datum');

    // Alleen mailen als de reservering nú écht bevestigd werd. Mollie kan
    // dezelfde webhook meerdere keren aanroepen; bij een herhaling was de
    // status al 'betaald' en is er dus al gemaild.
    if (bevestigd && bevestigd.length > 0) {
      await stuurBevestigingsmail(details, datum, betalingId);
    }
  } else if (['expired', 'canceled', 'failed'].includes(betaling.status)) {
    // Betaling gaat definitief niet door: datum weer vrijgeven (groen).
    await admin.from('reserveringen')
      .delete()
      .eq('datum', datum)
      .eq('status', 'in_afwachting');
  }
  // Andere statussen ('open', 'pending', ...) zijn tussenstappen: niets doen.

  return new Response('ok');
});
