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
const BEHEER_URL = 'https://reserveren.8-duust.be/beheer.html';

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

// Alles wat als tekst in de HTML terechtkomt moet ge-escaped worden.
function escapeHtml(waarde: unknown): string {
  return String(waarde ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Waarden netjes tonen in de mail; lege velden worden een streepje.
function toon(waarde: unknown): string {
  const tekst = String(waarde ?? '').trim();
  return tekst === '' ? '—' : escapeHtml(tekst);
}

// Klikbare telefoonlink: alleen cijfers en een eventuele landcode, want
// spaties in een tel:-link worden niet door elke mailclient begrepen.
function telHref(telefoon: unknown): string | null {
  const nummer = String(telefoon ?? '').replace(/[^\d+]/g, '');
  return nummer === '' ? null : `tel:${nummer}`;
}

function mailtoHref(email: unknown): string | null {
  const adres = String(email ?? '').trim();
  return adres === '' ? null : `mailto:${encodeURIComponent(adres).replaceAll('%40', '@')}`;
}

// ---------------------------------------------------------------------------
// Bouwstenen voor de mail. Alles inline gestyled en in tabellen: dat is het
// enige dat in Outlook, Gmail en Apple Mail betrouwbaar hetzelfde oogt.
// Kleuren komen uit style.css van de site (groen #23803e, inkt #1c1b18).
// Let op: alle tekst die hier binnenkomt is al ge-escaped door de opbouw
// hierboven; deze functies zetten er geen escaping meer overheen.
// ---------------------------------------------------------------------------

const FONT = 'Arial,Helvetica,sans-serif';
const KADER_ZIJ = 'border-left:1px solid #e6e3dc;border-right:1px solid #e6e3dc';

function detailRij(label: string, waarde: string, laatste = false): string {
  const rand = laatste ? '' : ';border-bottom:1px solid #f0eee8';
  return `<tr>` +
    `<td width="42%" style="width:42%;font-family:${FONT};font-size:14px;line-height:20px;color:#6f6b63;padding:9px 12px 9px 0;vertical-align:top${rand}">${label}</td>` +
    `<td style="font-family:${FONT};font-size:14px;line-height:20px;color:#1c1b18;font-weight:bold;padding:9px 0${rand}">${waarde}</td>` +
    `</tr>`;
}

function prijsRij(label: string, bedrag: string): string {
  return `<tr>` +
    `<td style="font-family:${FONT};font-size:13px;line-height:20px;color:#3d5a47;padding:2px 0">${label}</td>` +
    `<td align="right" style="font-family:${FONT};font-size:13px;line-height:20px;color:#3d5a47;padding:2px 0">${bedrag}</td>` +
    `</tr>`;
}

function knop(href: string, tekst: string, primair: boolean): string {
  const cel = primair
    ? `bgcolor="#23803e" style="border-radius:10px"`
    : `bgcolor="#ffffff" style="border-radius:10px;border:1px solid #d5d2ca"`;
  const kleur = primair ? '#ffffff' : '#1c1b18';
  const padding = primair ? '12px 16px' : '11px 16px';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">` +
    `<tr><td align="center" ${cel}>` +
    `<a href="${href}" style="display:block;padding:${padding};font-family:${FONT};font-size:14px;line-height:20px;font-weight:bold;color:${kleur};text-decoration:none">${tekst}</a>` +
    `</td></tr></table>`;
}

function bouwMailHtml(opties: {
  datumMooi: string;
  samenvatting: string;
  naam: string;
  email: string;
  telefoon: string;
  detailRijen: [string, string][];
  prijsregels: [string, string][];
  totaal: string;
  betalingId: string;
}): string {
  const {
    datumMooi, samenvatting, naam, email, telefoon,
    detailRijen, prijsregels, totaal, betalingId
  } = opties;

  const tel = telHref(telefoon);
  const mailto = mailtoHref(email);

  const contactRegels = [
    mailto ? `<a href="${mailto}" style="color:#1a5c2d;text-decoration:underline">${escapeHtml(email)}</a>` : '',
    tel ? `<a href="${tel}" style="color:#1a5c2d;text-decoration:underline">${escapeHtml(telefoon)}</a>` : ''
  ].filter(Boolean).join('<br>');

  const knoppen = (tel || mailto)
    ? `<tr><td style="padding:0 18px 16px">` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>` +
      (tel ? `<td class="stack" width="49%" style="width:49%">${knop(tel, 'Bellen', true)}</td>` : '') +
      (tel && mailto ? `<td class="stack-gap" width="2%" style="width:2%;font-size:0;line-height:0">&nbsp;</td>` : '') +
      (mailto ? `<td class="stack" width="${tel ? 49 : 100}%" style="width:${tel ? 49 : 100}%">${knop(mailto, 'E-mailen', !tel)}</td>` : '') +
      `</tr></table></td></tr>`
    : '';

  const detailHtml = detailRijen
    .map(([label, waarde], i) => detailRij(label, waarde, i === detailRijen.length - 1))
    .join('');

  const prijsHtml = prijsregels.map(([label, bedrag]) => prijsRij(label, bedrag)).join('');

  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Nieuwe reservatie</title>
<!--[if mso]><style>table,td,div,p,a{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->
<style>
  @media only screen and (max-width:620px){
    .p-out{padding-left:12px !important;padding-right:12px !important;}
    .p-in{padding-left:20px !important;padding-right:20px !important;}
    .stack{display:block !important;width:100% !important;}
    .stack-gap{height:10px !important;line-height:10px !important;}
    .hero-date{font-size:24px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f6f5f2">
<span style="display:none;font-size:1px;color:#f6f5f2;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">Betaling geslaagd — ${datumMooi} is definitief geboekt door ${naam}.</span>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f5f2">
<tr><td align="center" class="p-out" style="padding:24px 16px 40px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px">

  <tr><td style="padding:0 0 10px;font-family:${FONT};font-size:12px;line-height:16px;color:#6f6b63;letter-spacing:0.06em;text-transform:uppercase">8-Duust &nbsp;·&nbsp; Reserveringssysteem</td></tr>

  <tr><td class="p-in" style="background:#23803e;border-radius:16px 16px 0 0;padding:26px 28px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td style="font-family:${FONT};font-size:13px;line-height:18px;color:#cfe6d6;mso-line-height-rule:exactly">Betaling geslaagd · datum definitief bezet</td></tr>
      <tr><td style="font-family:${FONT};font-size:26px;line-height:32px;font-weight:bold;color:#ffffff;padding-top:6px;mso-line-height-rule:exactly">Nieuwe reservatie</td></tr>
    </table>
  </td></tr>

  <tr><td class="p-in" style="background:#ffffff;${KADER_ZIJ};padding:26px 28px 22px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td style="font-family:${FONT};font-size:12px;line-height:16px;color:#6f6b63;text-transform:uppercase;letter-spacing:0.06em">Feestdatum</td></tr>
      <tr><td class="hero-date" style="font-family:${FONT};font-size:28px;line-height:34px;font-weight:bold;color:#1c1b18;padding-top:4px;mso-line-height-rule:exactly">${datumMooi}</td></tr>
      ${samenvatting ? `<tr><td style="font-family:${FONT};font-size:15px;line-height:22px;color:#1c1b18;padding-top:6px">${samenvatting}</td></tr>` : ''}
    </table>
  </td></tr>

  <tr><td class="p-in" style="background:#ffffff;${KADER_ZIJ};padding:0 28px 24px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#faf9f6;border:1px solid #eceae4;border-radius:10px">
      <tr><td style="padding:16px 18px 14px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr><td style="font-family:${FONT};font-size:17px;line-height:24px;font-weight:bold;color:#1c1b18">${naam}</td></tr>
          ${contactRegels ? `<tr><td style="font-family:${FONT};font-size:14px;line-height:22px;color:#6f6b63;padding-top:2px">${contactRegels}</td></tr>` : ''}
        </table>
      </td></tr>
      ${knoppen}
    </table>
  </td></tr>

  <tr><td class="p-in" style="background:#ffffff;${KADER_ZIJ};padding:0 28px 8px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td colspan="2" style="font-family:${FONT};font-size:12px;line-height:16px;color:#6f6b63;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:6px">Gegevens</td></tr>
      ${detailHtml}
    </table>
  </td></tr>

  <tr><td class="p-in" style="background:#ffffff;${KADER_ZIJ};padding:20px 28px 26px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#eef6f0;border:1px solid #d3e8da;border-radius:10px">
      <tr><td style="padding:16px 18px 14px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr><td colspan="2" style="font-family:${FONT};font-size:12px;line-height:16px;color:#3d5a47;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:8px">Betaald via Mollie</td></tr>
          ${prijsHtml}
          <tr><td colspan="2" style="padding:8px 0 0;border-top:1px solid #c4dccd">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr><td style="font-family:${FONT};font-size:14px;line-height:24px;font-weight:bold;color:#15481f">Totaal betaald</td>
                  <td align="right" style="font-family:${FONT};font-size:20px;line-height:24px;font-weight:bold;color:#15481f">${totaal}</td></tr>
            </table>
          </td></tr>
          <tr><td colspan="2" style="font-family:${FONT};font-size:12px;line-height:18px;color:#3d5a47;padding-top:8px">Betaling ${betalingId}</td></tr>
        </table>
      </td></tr>
    </table>
  </td></tr>

  <tr><td class="p-in" style="background:#ffffff;border:1px solid #e6e3dc;border-top:none;border-radius:0 0 16px 16px;padding:18px 28px 22px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td style="font-family:${FONT};font-size:13px;line-height:20px;color:#6f6b63">${mailto ? `Antwoorden op deze mail gaat rechtstreeks naar ${naam}. ` : ''}Alle reservaties bekijk je in het <a href="${BEHEER_URL}" style="color:#1a5c2d;text-decoration:underline">beheerportaal</a>.</td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:16px 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:#8a857c">Automatisch verstuurd door het reserveringssysteem van 8-Duust.</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
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

  // De uren alleen als bereik tonen wanneer ze er allebei zijn; anders komt
  // er "— – —" in de mail te staan.
  const heeftUren = String(details.start_tijd ?? '').trim() !== '' &&
    String(details.eind_tijd ?? '').trim() !== '';
  const uren = heeftUren ? `${toon(details.start_tijd)} – ${toon(details.eind_tijd)}` : '—';

  // Samenvattingsregel onder de datum: alleen de stukken die echt ingevuld
  // zijn, zodat er geen losse streepjes in de zin belanden.
  const personen = String(details.aantal_personen ?? '').trim();
  const typeFeest = String(details.type_feest ?? '').trim();
  const samenvatting = [
    heeftUren ? uren : '',
    personen === '' ? '' : `${escapeHtml(personen)} personen`,
    escapeHtml(typeFeest)
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  // Datum, uren, personen, type feest en de contactgegevens staan bovenaan in
  // de mail; de rest komt in de gegevenstabel.
  const detailRijen: [string, string][] = [
    ['Type feest', toon(details.type_feest)],
    ['Aantal personen', toon(details.aantal_personen)],
    ['Uren', uren],
    ['Opbouw', opbouw]
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
    detailRijen.push(
      ['Eigen foodtruck', keuzes.eigenFoodtruck ? 'Ja (forfait € 25)' : 'Nee'],
      ['BBQ zelf meebrengen', keuzes.bbq ? 'Ja' : 'Nee']
    );
    // Drankkaarten en springkastelen bestaan niet meer en op ma-do is er
    // geen muziekkeuze; alleen tonen wat er bij het boeken echt is vastgelegd.
    if (keuzes.drankkaarten !== undefined) {
      const drankkaarten = (keuzes.drankkaarten ?? {}) as Record<string, unknown>;
      detailRijen.push(['Drankkaarten', DRANKKAART_LABELS[String(drankkaarten.keuze)] ?? '—']);
    }
    if (keuzes.muziek !== undefined) {
      detailRijen.push(['Muziek', MUZIEK_LABELS[String(keuzes.muziek)] ?? '—']);
    }
    if (keuzes.springkasteel !== undefined) {
      detailRijen.push(['Springkasteel', SPRINGKASTEEL_LABELS[String(keuzes.springkasteel)] ?? '—']);
    }
  }
  detailRijen.push(['Opmerkingen', toon(details.opmerkingen)]);

  // De prijsregels staan in het betaalkader; ze tellen samen op tot het
  // totaal. Oude reserveringen zonder extra_opties krijgen één regel.
  const prijsregels: [string, string][] = (extra?.prijsregels ?? [])
    .map((regel) => [toon(regel.label), `€ ${Number(regel.bedrag)}`] as [string, string]);
  if (prijsregels.length === 0) {
    prijsregels.push(['Reservatiekosten', `€ ${Number(details.totaal_bedrag ?? 60)}`]);
  }

  const html = bouwMailHtml({
    datumMooi: escapeHtml(datumMooi),
    samenvatting,
    naam: toon(details.naam),
    email: String(details.email ?? '').trim(),
    telefoon: String(details.telefoon ?? '').trim(),
    detailRijen,
    prijsregels,
    totaal: `€ ${Number(details.totaal_bedrag ?? 60)}`,
    betalingId: toon(betalingId)
  });

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
      subject: `Nieuwe reservatie: ${datumMooi} — ${String(details.naam ?? '').trim()}`,
      html
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
