// Beheerportaal: alleen-lezen overzicht van alle betaalde reserveringen voor
// de organisatie. Inloggen gaat met een magic link (Supabase Auth); wie
// daarna op de allowlist "beheerders" staat, mag via RLS de details lezen.
import { supabaseConfig } from './supabase-config.js';

// Datumhelpers en maandnamen zijn bewust gekopieerd uit app.js: de publieke
// kalender daar is verweven met de boekingsflow (en mag bijv. niet naar het
// verleden bladeren, dit portaal juist wél).
const MAANDEN = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december'
];

function datumNaarString(d) {
  const maand = String(d.getMonth() + 1).padStart(2, '0');
  const dag = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${maand}-${dag}`;
}

function datumMooi(datumStr) {
  const [j, m, d] = datumStr.split('-').map(Number);
  return new Intl.DateTimeFormat('nl-NL', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  }).format(new Date(j, m - 1, d));
}

// Weergaveteksten voor de extra opties, gelijk aan de bevestigingsmail
// (supabase/functions/mollie-webhook/index.ts).
const MUZIEK_LABELS = {
  eigenDj: 'Eigen DJ (voorziet zelf materiaal)',
  spotify: 'Eigen Spotify-playlist',
  bar: 'Bar verzorgt de muziek'
};
const SPRINGKASTEEL_LABELS = {
  vzw: 'Springkasteel van de vzw',
  eigenLeverancier: 'Eigen leverancier',
  geen: 'Geen'
};
const DRANKKAART_LABELS = {
  vooraf20: 'Vooraf besteld (€ 20 per kaart)',
  vooraf12: 'Vooraf besteld (€ 12 per kaart)',
  terPlaatse: 'Regelt de klant ter plaatse',
  geen: 'Geen'
};

function toon(waarde) {
  const tekst = String(waarde ?? '').trim();
  return tekst === '' ? '—' : tekst;
}

// ---------- Elementen ----------

const foutBannerEl = document.getElementById('fout-banner');
const loginSectieEl = document.getElementById('login-sectie');
const loginFormulierEl = document.getElementById('login-formulier');
const loginEmailEl = document.getElementById('login-email');
const loginKnopEl = document.getElementById('login-knop');
const loginStatusEl = document.getElementById('login-status');
const portaalSectieEl = document.getElementById('portaal-sectie');
const portaalInhoudEl = document.getElementById('portaal-inhoud');
const ingelogdAlsEl = document.getElementById('ingelogd-als');
const kalenderEl = document.getElementById('kalender');
const maandTitelEl = document.getElementById('maand-titel');
const detailPaneelEl = document.getElementById('detail-paneel');
const detailTitelEl = document.getElementById('detail-titel');
const detailLijstEl = document.getElementById('detail-lijst');
const komendeLijstEl = document.getElementById('komende-lijst');
const komendeLeegEl = document.getElementById('komende-leeg');

function toonFoutBanner(tekst) {
  foutBannerEl.textContent = tekst;
  foutBannerEl.classList.remove('verborgen');
}

function verbergFoutBanner() {
  foutBannerEl.classList.add('verborgen');
}

// ---------- Toestand ----------

let client = null;
let reserveringen = {}; // datumstring -> details van een betaalde reservering
let getoondeMaand = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let geselecteerdeDatum = null;
let portaalGestart = false;

// ---------- Kalender ----------

function renderKalender() {
  const jaar = getoondeMaand.getFullYear();
  const maand = getoondeMaand.getMonth();
  maandTitelEl.textContent = `${MAANDEN[maand]} ${jaar}`;
  kalenderEl.innerHTML = '';

  const eersteDag = new Date(jaar, maand, 1);
  const dagenInMaand = new Date(jaar, maand + 1, 0).getDate();
  const offset = (eersteDag.getDay() + 6) % 7; // week begint op maandag

  for (let i = 0; i < offset; i++) {
    const leeg = document.createElement('div');
    leeg.className = 'dag leeg';
    kalenderEl.appendChild(leeg);
  }

  const vandaag = datumNaarString(new Date());
  for (let dag = 1; dag <= dagenInMaand; dag++) {
    const datumStr = datumNaarString(new Date(jaar, maand, dag));
    const cel = document.createElement('div');
    cel.textContent = dag;

    const details = reserveringen[datumStr];
    if (details) {
      cel.className = 'dag bezet klikbaar';
      cel.title = `${toon(details.type_feest)} – ${toon(details.naam)}`;
      cel.tabIndex = 0;
      cel.setAttribute('role', 'button');
      cel.addEventListener('click', () => toonDetails(datumStr));
      cel.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toonDetails(datumStr);
        }
      });
    } else {
      cel.className = 'dag niet-beschikbaar';
    }
    if (datumStr === vandaag) cel.classList.add('vandaag');
    if (datumStr === geselecteerdeDatum) cel.classList.add('geselecteerd');
    kalenderEl.appendChild(cel);
  }
}

// ---------- Detailpaneel ----------

// Zelfde rijen en volgorde als de bevestigingsmail uit de webhook.
function detailRijen(details) {
  const opbouwMinuten = Number(details.opbouw_minuten ?? 0);
  const opbouw = opbouwMinuten > 0
    ? `${opbouwMinuten} minuten vooraf${details.opbouw_vanaf ? ` (vanaf ${toon(details.opbouw_vanaf)})` : ''}`
    : 'geen';

  const rijen = [
    ['Naam', toon(details.naam)],
    ['E-mail', toon(details.email)],
    ['Telefoon', toon(details.telefoon)],
    ['Type feest', toon(details.type_feest)],
    ['Aantal personen', toon(details.aantal_personen)],
    ['Uren', `${toon(details.start_tijd)} – ${toon(details.eind_tijd)}`],
    ['Opbouw', opbouw],
    ['Opmerkingen', toon(details.opmerkingen)]
  ];

  const keuzes = details.extra_opties?.keuzes;
  if (keuzes) {
    const drankkaarten = keuzes.drankkaarten ?? {};
    rijen.push(
      ['Eigen foodtruck', keuzes.eigenFoodtruck ? 'Ja (forfait € 25)' : 'Nee'],
      ['BBQ zelf meebrengen', keuzes.bbq ? 'Ja' : 'Nee'],
      ['Drankkaarten', DRANKKAART_LABELS[String(drankkaarten.keuze)] ?? '—'],
      ['Muziek', MUZIEK_LABELS[String(keuzes.muziek)] ?? '—'],
      ['Springkasteel', SPRINGKASTEEL_LABELS[String(keuzes.springkasteel)] ?? '—']
    );
  }
  for (const regel of details.extra_opties?.prijsregels ?? []) {
    rijen.push([toon(regel.label), `€ ${Number(regel.bedrag)}`]);
  }
  rijen.push(['Totaal betaald', `€ ${Number(details.totaal_bedrag ?? 60)}`]);
  rijen.push(['Mollie-betaling', toon(details.mollie_betaling_id)]);
  if (details.aangemaakt_op) {
    rijen.push(['Geboekt op', new Date(details.aangemaakt_op).toLocaleString('nl-BE')]);
  }
  return rijen;
}

function toonDetails(datumStr) {
  const details = reserveringen[datumStr];
  if (!details) return;
  geselecteerdeDatum = datumStr;

  detailTitelEl.textContent = datumMooi(datumStr);
  detailLijstEl.innerHTML = '';
  for (const [label, waarde] of detailRijen(details)) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    // E-mail en telefoon als klikbare links, de rest als platte tekst.
    if (label === 'E-mail' && waarde !== '—') {
      const a = document.createElement('a');
      a.href = `mailto:${waarde}`;
      a.textContent = waarde;
      dd.appendChild(a);
    } else if (label === 'Telefoon' && waarde !== '—') {
      const a = document.createElement('a');
      a.href = `tel:${waarde.replace(/\s/g, '')}`;
      a.textContent = waarde;
      dd.appendChild(a);
    } else {
      dd.textContent = waarde;
    }
    detailLijstEl.appendChild(dt);
    detailLijstEl.appendChild(dd);
  }
  detailPaneelEl.classList.remove('verborgen');

  // Kalender opnieuw tekenen zodat de geselecteerde dag oplicht, en het
  // paneel in beeld brengen (op een gsm staat het onder de kalender).
  renderKalender();
  detailPaneelEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- Komende reservaties ----------

function renderKomendeLijst() {
  const vandaag = datumNaarString(new Date());
  const komende = Object.keys(reserveringen).filter((d) => d >= vandaag).sort();

  komendeLijstEl.innerHTML = '';
  komendeLeegEl.classList.toggle('verborgen', komende.length > 0);

  for (const datumStr of komende) {
    const details = reserveringen[datumStr];
    const li = document.createElement('li');
    const knop = document.createElement('button');
    knop.type = 'button';
    knop.className = 'komende-knop';
    knop.textContent =
      `${datumMooi(datumStr)} — ${toon(details.type_feest)}, ${toon(details.naam)}` +
      ` (${toon(details.aantal_personen)} pers., ${toon(details.start_tijd)}–${toon(details.eind_tijd)})`;
    knop.addEventListener('click', () => {
      getoondeMaand = new Date(Number(datumStr.slice(0, 4)), Number(datumStr.slice(5, 7)) - 1, 1);
      toonDetails(datumStr);
    });
    li.appendChild(knop);
    komendeLijstEl.appendChild(li);
  }
}

// ---------- Gegevens laden ----------

async function laadReserveringen() {
  // Alleen betaalde reserveringen: de !inner-join filtert op status.
  // RLS zorgt ervoor dat alleen beheerders rijen terugkrijgen.
  const { data, error } = await client
    .from('reservering_details')
    .select('*, reserveringen!inner(status)')
    .eq('reserveringen.status', 'betaald')
    .order('datum');
  if (error) {
    toonFoutBanner('Kan reserveringen niet laden: ' + error.message);
    return;
  }
  reserveringen = {};
  for (const rij of data) reserveringen[rij.datum] = rij;
  renderKalender();
  renderKomendeLijst();
  if (geselecteerdeDatum && reserveringen[geselecteerdeDatum]) {
    toonDetails(geselecteerdeDatum);
  }
}

// ---------- Portaal starten/stoppen ----------

async function startPortaal(session) {
  loginSectieEl.classList.add('verborgen');
  portaalSectieEl.classList.remove('verborgen');
  ingelogdAlsEl.textContent = `Ingelogd als ${session.user.email}`;

  if (portaalGestart) return;
  portaalGestart = true;

  // Eerst controleren of dit account op de allowlist staat; anders zou de
  // beheerder alleen een verwarrend lege kalender zien.
  const { data: isBeheerder, error } = await client.rpc('is_beheerder');
  if (error || !isBeheerder) {
    portaalInhoudEl.classList.add('verborgen');
    toonFoutBanner(
      `Het account ${session.user.email} heeft geen toegang tot het beheer. ` +
      'Neem contact op met de organisatie.'
    );
    return;
  }

  verbergFoutBanner();
  portaalInhoudEl.classList.remove('verborgen');
  await laadReserveringen();

  // Live meebewegen met nieuwe of verwijderde reserveringen, zoals de
  // publieke kalender in app.js.
  client.channel('beheer-live')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'reserveringen' },
      laadReserveringen)
    .subscribe();
}

function toonLogin() {
  portaalSectieEl.classList.add('verborgen');
  loginSectieEl.classList.remove('verborgen');
}

// ---------- Opstarten ----------

function supabaseIsGeconfigureerd() {
  return supabaseConfig && supabaseConfig.url &&
    !String(supabaseConfig.url).startsWith('PLAK_HIER');
}

async function init() {
  if (!supabaseIsGeconfigureerd()) {
    toonFoutBanner('Supabase is niet geconfigureerd; het beheer werkt niet in demo-modus.');
    return;
  }

  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  // De standaardinstellingen (sessie bewaren + magic-link-tokens uit de URL
  // oppikken) zijn precies wat we nodig hebben.
  client = createClient(supabaseConfig.url, supabaseConfig.anonKey);

  document.getElementById('uitlog-knop').addEventListener('click', async () => {
    await client.auth.signOut();
    window.location.reload(); // schone start, ook voor realtime-kanalen
  });

  loginFormulierEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = loginEmailEl.value.trim();
    loginKnopEl.disabled = true;
    loginStatusEl.classList.remove('verborgen');
    loginStatusEl.textContent = 'Inloglink wordt verstuurd…';

    // shouldCreateUser: false → alleen bestaande accounts (de 2 beheerders)
    // krijgen een link; er ontstaan geen losse accounts van vreemden.
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin + window.location.pathname,
        shouldCreateUser: false
      }
    });
    loginKnopEl.disabled = false;
    if (error) {
      loginStatusEl.textContent = /not allowed|not found|signups/i.test(error.message)
        ? 'Dit e-mailadres heeft geen toegang tot het beheer.'
        : 'Inloglink versturen mislukt: ' + error.message;
      return;
    }
    loginStatusEl.textContent =
      `Inloglink verstuurd naar ${email}. Open de link op dit toestel om in te loggen.`;
  });

  document.getElementById('vorige-maand').addEventListener('click', () => {
    getoondeMaand = new Date(getoondeMaand.getFullYear(), getoondeMaand.getMonth() - 1, 1);
    renderKalender();
  });
  document.getElementById('volgende-maand').addEventListener('click', () => {
    getoondeMaand = new Date(getoondeMaand.getFullYear(), getoondeMaand.getMonth() + 1, 1);
    renderKalender();
  });

  // Bij het laden van de pagina én na het aanklikken van de magic link.
  client.auth.onAuthStateChange((_event, session) => {
    if (session) startPortaal(session);
    else toonLogin();
  });
  const { data: { session } } = await client.auth.getSession();
  if (session) startPortaal(session);
  else toonLogin();
}

init();
