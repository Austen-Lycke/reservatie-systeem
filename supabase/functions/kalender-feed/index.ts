// Edge function "kalender-feed": levert een iCal-feed (ICS) met alle betaalde
// reserveringen, inclusief alle details in de omschrijving. De twee beheerders
// abonneren zich hier één keer op in hun agenda-app (Apple Agenda of Google
// Calendar); nieuwe reserveringen verschijnen daarna vanzelf tussen hun eigen
// afspraken.
//
// Belangrijk: deze functie moet bereikbaar zijn ZONDER Supabase-JWT
// (verify_jwt = false), anders kunnen agenda-apps hem niet ophalen.
// De toegang wordt in plaats daarvan bewaakt met een geheim token in de URL:
//
//   https://<project>.supabase.co/functions/v1/kalender-feed?token=<TOKEN>
//
// Extra secret (Edge Functions → Secrets):
//   KALENDER_FEED_TOKEN – lange willekeurige tekst, bijv. de uitvoer van
//                         `openssl rand -hex 32`. Token lekt uit? Verander
//                         het secret en abonneer de telefoons opnieuw.
import { createClient } from 'npm:@supabase/supabase-js@2';

// Weergaveteksten voor de extra opties, gelijk aan de bevestigingsmail
// (supabase/functions/mollie-webhook/index.ts).
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

// Lege velden worden een streepje.
function toon(waarde: unknown): string {
  const tekst = String(waarde ?? '').trim();
  return tekst === '' ? '—' : tekst;
}

// Vergelijkt het token uit de URL met het secret zonder dat de vergelijking
// via de responstijd iets prijsgeeft: we vergelijken vaste-lengte digests.
async function tokenIsGeldig(gegeven: string, verwacht: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(gegeven)),
    crypto.subtle.digest('SHA-256', encoder.encode(verwacht))
  ]);
  const bytesA = new Uint8Array(a);
  const bytesB = new Uint8Array(b);
  let verschil = 0;
  for (let i = 0; i < bytesA.length; i++) verschil |= bytesA[i] ^ bytesB[i];
  return verschil === 0;
}

// ---------- ICS-hulpfuncties (RFC 5545) ----------

// Tekst escapen voor gebruik in een ICS-waarde.
function escapeIcs(tekst: string): string {
  return tekst
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll('\r\n', '\\n')
    .replaceAll('\n', '\\n');
}

// Regels langer dan 75 bytes moeten "gevouwen" worden: vervolgregels beginnen
// met een spatie. We tellen in bytes en splitsen nooit midden in een
// multibyte-teken (namen kunnen é/ë bevatten).
function vouwRegel(regel: string): string {
  const encoder = new TextEncoder();
  const delen: string[] = [];
  let huidig = '';
  let huidigBytes = 0;
  // Eerste regel mag 75 bytes zijn; vervolgregels 74 (de spatie telt mee).
  let limiet = 75;
  for (const teken of regel) {
    const tekenBytes = encoder.encode(teken).length;
    if (huidigBytes + tekenBytes > limiet) {
      delen.push(huidig);
      huidig = '';
      huidigBytes = 0;
      limiet = 74;
    }
    huidig += teken;
    huidigBytes += tekenBytes;
  }
  delen.push(huidig);
  return delen.join('\r\n ');
}

// "2026-07-17" + "18:00" → "20260717T180000" (lokale tijd Europe/Brussels,
// de tijdzone staat als TZID-parameter bij de eigenschap).
function icsLokaleTijd(datum: string, tijd: string): string {
  return `${datum.replaceAll('-', '')}T${tijd.replaceAll(':', '')}00`;
}

// De dag na een datumstring ("2026-07-17" → "2026-07-18"). Via UTC zodat
// zomer-/wintertijd geen rol speelt.
function volgendeDag(datum: string): string {
  const d = new Date(`${datum}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Tijdzonedefinitie voor Europe/Brussels: wintertijd (CET, +01:00) en
// zomertijd (CEST, +02:00) volgens de vaste EU-regels (laatste zondag van
// maart/oktober). Hiermee tonen Apple én Google de juiste lokale tijden.
const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Brussels',
  'BEGIN:STANDARD',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'END:DAYLIGHT',
  'END:VTIMEZONE'
];

// Bouwt de omschrijving van één agenda-item: alle reservatiegegevens als
// "Label: waarde"-regels, in dezelfde volgorde als de bevestigingsmail.
function maakOmschrijving(details: Record<string, unknown>): string {
  const opbouwMinuten = Number(details.opbouw_minuten ?? 0);
  const opbouw = opbouwMinuten > 0
    ? `${opbouwMinuten} minuten vooraf${details.opbouw_vanaf ? ` (vanaf ${toon(details.opbouw_vanaf)})` : ''}`
    : 'geen';

  const regels: string[] = [
    `Naam: ${toon(details.naam)}`,
    `Telefoon: ${toon(details.telefoon)}`,
    `E-mail: ${toon(details.email)}`,
    `Type feest: ${toon(details.type_feest)}`,
    `Aantal personen: ${toon(details.aantal_personen)}`,
    `Uren: ${toon(details.start_tijd)} – ${toon(details.eind_tijd)}`,
    `Opbouw: ${opbouw}`,
    `Opmerkingen: ${toon(details.opmerkingen)}`
  ];

  const extra = details.extra_opties as {
    keuzes?: Record<string, unknown>;
    prijsregels?: { label: string; bedrag: number }[];
  } | null;
  const keuzes = extra?.keuzes;
  if (keuzes) {
    regels.push(
      `Eigen foodtruck: ${keuzes.eigenFoodtruck ? 'Ja (forfait € 25)' : 'Nee'}`,
      `BBQ zelf meebrengen: ${keuzes.bbq ? 'Ja' : 'Nee'}`
    );
    // Drankkaarten bestaan niet meer en op ma-do is er geen muziekkeuze;
    // alleen tonen wat er bij het boeken echt is vastgelegd.
    if (keuzes.drankkaarten !== undefined) {
      const drankkaarten = (keuzes.drankkaarten ?? {}) as Record<string, unknown>;
      regels.push(`Drankkaarten: ${DRANKKAART_LABELS[String(drankkaarten.keuze)] ?? '—'}`);
    }
    if (keuzes.muziek !== undefined) {
      regels.push(`Muziek: ${MUZIEK_LABELS[String(keuzes.muziek)] ?? '—'}`);
    }
    regels.push(`Springkasteel: ${SPRINGKASTEEL_LABELS[String(keuzes.springkasteel)] ?? '—'}`);
  }
  for (const regel of extra?.prijsregels ?? []) {
    regels.push(`${toon(regel.label)}: € ${Number(regel.bedrag)}`);
  }
  regels.push(`Totaal betaald: € ${Number(details.totaal_bedrag ?? 60)}`);
  if (details.mollie_betaling_id) {
    regels.push(`Mollie-betaling: ${toon(details.mollie_betaling_id)}`);
  }
  return regels.join('\n');
}

// Bouwt één VEVENT voor een betaalde reservering.
function maakEvent(details: Record<string, unknown>, dtstamp: string): string[] {
  const datum = String(details.datum);
  const startTijd = String(details.start_tijd ?? '10:00');
  const eindTijd = String(details.eind_tijd ?? '23:59');
  // Eindtijd op of vóór de starttijd betekent: het feest loopt door tot na
  // middernacht (uiterlijk 02:00), dus het einde valt op de volgende dag.
  const eindDatum = eindTijd <= startTijd ? volgendeDag(datum) : datum;

  const samenvatting = [
    toon(details.type_feest) === '—' ? 'Feest' : String(details.type_feest).trim(),
    '–',
    toon(details.naam),
    `(${toon(details.aantal_personen)} pers.)`
  ].join(' ');

  return [
    'BEGIN:VEVENT',
    // Datum is de primaire sleutel: bij een nieuwe boeking op dezelfde datum
    // vervangt het nieuwe item automatisch het oude in de agenda.
    `UID:${datum}@reserveren.8-duust.be`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=Europe/Brussels:${icsLokaleTijd(datum, startTijd)}`,
    `DTEND;TZID=Europe/Brussels:${icsLokaleTijd(eindDatum, eindTijd)}`,
    `SUMMARY:${escapeIcs(samenvatting)}`,
    `DESCRIPTION:${escapeIcs(maakOmschrijving(details))}`,
    'END:VEVENT'
  ];
}

Deno.serve(async (req) => {
  if (req.method !== 'GET') {
    return new Response('alleen GET', { status: 405 });
  }

  const verwachtToken = Deno.env.get('KALENDER_FEED_TOKEN');
  if (!verwachtToken) {
    return new Response('KALENDER_FEED_TOKEN ontbreekt', { status: 500 });
  }

  // Fout of ontbrekend token: 404, zodat de functie voor buitenstaanders
  // niet eens lijkt te bestaan.
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!token || !(await tokenIsGeldig(token, verwachtToken))) {
    return new Response('niet gevonden', { status: 404 });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Alleen betaalde reserveringen (de !inner-join filtert), tot een jaar
  // terug zodat de feed compact blijft maar de recente historiek zichtbaar is.
  const jaarGeleden = new Date();
  jaarGeleden.setFullYear(jaarGeleden.getFullYear() - 1);
  const { data, error } = await admin
    .from('reservering_details')
    .select('*, reserveringen!inner(status)')
    .eq('reserveringen.status', 'betaald')
    .gte('datum', jaarGeleden.toISOString().slice(0, 10))
    .order('datum');

  if (error) {
    console.error('Feed: reserveringen ophalen mislukt:', error.message);
    return new Response('databankfout', { status: 500 });
  }

  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const regels = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//8-duust//reservaties//NL',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:8-duust reservaties',
    'X-WR-TIMEZONE:Europe/Brussels',
    // Hint voor agenda-apps om elk uur te verversen (Google negeert dit en
    // ververst op eigen tempo, vaak pas na enkele uren).
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...VTIMEZONE,
    ...(data ?? []).flatMap((details) => maakEvent(details, dtstamp)),
    'END:VCALENDAR'
  ];

  const ics = regels.map(vouwRegel).join('\r\n') + '\r\n';
  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="8duust.ics"',
      'Cache-Control': 'no-cache'
    }
  });
});
