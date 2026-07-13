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

function bedrag(waarde) {
  return `€ ${Number(waarde ?? 0).toLocaleString('nl-BE')}`;
}

// 'za 18 juli' — voor de statkaart en de komende-lijst.
function datumKort(datumStr) {
  const [j, m, d] = datumStr.split('-').map(Number);
  return new Intl.DateTimeFormat('nl-BE', {
    weekday: 'short', day: 'numeric', month: 'long'
  }).format(new Date(j, m - 1, d));
}

// ---------- Elementen ----------

const foutBannerEl = document.getElementById('fout-banner');
const foutBannerLoginEl = document.getElementById('fout-banner-login');
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
const detailSubtitelEl = document.getElementById('detail-subtitel');
const detailLijstEl = document.getElementById('detail-lijst');
const detailPrijsEl = document.getElementById('detail-prijs');
const detailVoetEl = document.getElementById('detail-voet');
const detailBellenEl = document.getElementById('detail-bellen');
const detailMailenEl = document.getElementById('detail-mailen');
const statFeestenEl = document.getElementById('stat-feesten');
const statOntvangenEl = document.getElementById('stat-ontvangen');
const statVolgendEl = document.getElementById('stat-volgend');
const statVolgendLabelEl = document.getElementById('stat-volgend-label');
const komendeLijstEl = document.getElementById('komende-lijst');
const komendeLeegEl = document.getElementById('komende-leeg');
const komendeFilterEl = document.getElementById('komende-filter');

// Vóór het inloggen is het portaal (met zijn foutbanner) verborgen; daarom
// schrijven we fouten ook naar de banner in de inlogkaart.
function toonFoutBanner(tekst) {
  for (const el of [foutBannerEl, foutBannerLoginEl]) {
    el.textContent = tekst;
    el.classList.remove('verborgen');
  }
}

function verbergFoutBanner() {
  for (const el of [foutBannerEl, foutBannerLoginEl]) {
    el.classList.add('verborgen');
  }
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

// Informatieve rijen; type/personen/uren/opbouw staan in de subtitel en de
// prijsregels in het prijsblok eronder.
function detailRijen(details) {
  const rijen = [
    ['Naam', toon(details.naam)],
    ['E-mail', toon(details.email)],
    ['Telefoon', toon(details.telefoon)]
  ];

  const keuzes = details.extra_opties?.keuzes;
  if (keuzes) {
    // Drankkaarten en springkastelen bestaan niet meer en op ma-do is er
    // geen muziekkeuze; alleen tonen wat er bij het boeken echt is
    // vastgelegd (oude reserveringen behouden zo hun rijen).
    if (keuzes.drankkaarten !== undefined) {
      const drankkaarten = keuzes.drankkaarten ?? {};
      let drankkaartTekst = DRANKKAART_LABELS[String(drankkaarten.keuze)] ?? '—';
      if (drankkaarten.aantal) {
        const perKaart = drankkaarten.keuze === 'vooraf12' ? 12 : 20;
        drankkaartTekst = `Vooraf — ${drankkaarten.aantal} × € ${perKaart}`;
      }
      rijen.push(['Drankkaarten', drankkaartTekst]);
    }
    if (keuzes.muziek !== undefined) {
      rijen.push(['Muziek', MUZIEK_LABELS[String(keuzes.muziek)] ?? '—']);
    }
    if (keuzes.springkasteel !== undefined) {
      rijen.push(['Springkasteel', SPRINGKASTEEL_LABELS[String(keuzes.springkasteel)] ?? '—']);
    }
    rijen.push(
      ['Foodtruck / BBQ', `${keuzes.eigenFoodtruck ? 'Ja' : 'Nee'} / ${keuzes.bbq ? 'Ja' : 'Nee'}`]
    );
    if (keuzes.foodtruckVzw && keuzes.foodtruckVzw.gekozen) {
      rijen.push(['Foodtruck vzw', 'Ja — zie prijsregels']);
    }
  }
  rijen.push(['Opmerkingen', toon(details.opmerkingen)]);
  return rijen;
}

function toonDetails(datumStr) {
  const details = reserveringen[datumStr];
  if (!details) return;
  geselecteerdeDatum = datumStr;

  detailTitelEl.textContent = datumMooi(datumStr);

  const opbouwMinuten = Number(details.opbouw_minuten ?? 0);
  const subtitel = [
    toon(details.type_feest),
    `${toon(details.aantal_personen)} personen`,
    `${toon(details.start_tijd)}–${toon(details.eind_tijd)}`
  ];
  if (opbouwMinuten > 0 && details.opbouw_vanaf) {
    subtitel.push(`opbouw vanaf ${details.opbouw_vanaf}`);
  }
  detailSubtitelEl.textContent = subtitel.join(' · ');

  detailLijstEl.innerHTML = '';
  for (const [label, waarde] of detailRijen(details)) {
    const rij = document.createElement('div');
    rij.className = 'detail-rij';
    const labelEl = document.createElement('span');
    labelEl.className = 'label';
    labelEl.textContent = label;
    const waardeEl = document.createElement('span');
    waardeEl.className = 'waarde';
    // E-mail en telefoon als klikbare links, de rest als platte tekst.
    if (label === 'E-mail' && waarde !== '—') {
      const a = document.createElement('a');
      a.href = `mailto:${waarde}`;
      a.textContent = waarde;
      waardeEl.appendChild(a);
    } else if (label === 'Telefoon' && waarde !== '—') {
      const a = document.createElement('a');
      a.href = `tel:${waarde.replace(/\s/g, '')}`;
      a.textContent = waarde;
      waardeEl.appendChild(a);
    } else {
      waardeEl.textContent = waarde;
    }
    rij.appendChild(labelEl);
    rij.appendChild(waardeEl);
    detailLijstEl.appendChild(rij);
  }

  // Prijsblok: de door de server opgeslagen prijsregels plus het totaal.
  detailPrijsEl.innerHTML = '';
  const regels = details.extra_opties?.prijsregels ??
    [{ label: 'Reservatiekosten', bedrag: 60 }];
  for (const regel of regels) {
    const rij = document.createElement('div');
    rij.className = 'prijs-regel';
    const labelEl = document.createElement('span');
    labelEl.className = 'label';
    labelEl.textContent = toon(regel.label);
    const bedragEl = document.createElement('span');
    bedragEl.textContent = bedrag(regel.bedrag);
    rij.appendChild(labelEl);
    rij.appendChild(bedragEl);
    detailPrijsEl.appendChild(rij);
  }
  const totaalRij = document.createElement('div');
  totaalRij.className = 'prijs-totaal';
  const totaalLabel = document.createElement('span');
  totaalLabel.className = 'label';
  totaalLabel.textContent = 'Totaal betaald';
  const totaalBedrag = document.createElement('span');
  totaalBedrag.className = 'bedrag';
  totaalBedrag.textContent = bedrag(details.totaal_bedrag ?? 60);
  totaalRij.appendChild(totaalLabel);
  totaalRij.appendChild(totaalBedrag);
  detailPrijsEl.appendChild(totaalRij);

  // Voetnoot: betalings-ID en boekingsmoment.
  detailVoetEl.innerHTML = '';
  const mollieEl = document.createElement('span');
  mollieEl.textContent = `Mollie-betaling ${toon(details.mollie_betaling_id)}`;
  detailVoetEl.appendChild(mollieEl);
  if (details.aangemaakt_op) {
    const geboektEl = document.createElement('span');
    geboektEl.textContent =
      `Geboekt op ${new Date(details.aangemaakt_op).toLocaleString('nl-BE')}`;
    detailVoetEl.appendChild(geboektEl);
  }

  // Snelknoppen (zichtbaar op mobiel).
  const telefoon = String(details.telefoon ?? '').trim();
  detailBellenEl.href = telefoon ? `tel:${telefoon.replace(/\s/g, '')}` : '#';
  detailBellenEl.classList.toggle('verborgen', !telefoon);
  const email = String(details.email ?? '').trim();
  detailMailenEl.href = email ? `mailto:${email}` : '#';
  detailMailenEl.classList.toggle('verborgen', !email);

  detailPaneelEl.classList.remove('verborgen');

  // Kalender opnieuw tekenen zodat de geselecteerde dag oplicht, en het
  // paneel in beeld brengen (op een gsm staat het onder de kalender).
  renderKalender();
  detailPaneelEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- Statistieken ----------

function renderStatistieken() {
  const nu = new Date();
  const maandPrefix = datumNaarString(nu).slice(0, 7);
  const dezeMaand = Object.values(reserveringen)
    .filter((r) => String(r.datum).startsWith(maandPrefix));
  statFeestenEl.textContent = String(dezeMaand.length);
  statOntvangenEl.textContent =
    bedrag(dezeMaand.reduce((som, r) => som + Number(r.totaal_bedrag ?? 60), 0));

  const vandaag = datumNaarString(nu);
  const volgende = Object.keys(reserveringen).filter((d) => d >= vandaag).sort()[0];
  if (!volgende) {
    statVolgendLabelEl.textContent = 'Volgend feest';
    statVolgendEl.textContent = 'Nog niets gepland';
    return;
  }
  const [j, m, d] = volgende.split('-').map(Number);
  const dagen = Math.round(
    (new Date(j, m - 1, d) - new Date(nu.getFullYear(), nu.getMonth(), nu.getDate())) / 86400000
  );
  const wanneer = dagen === 0 ? 'vandaag' : dagen === 1 ? 'morgen' : `over ${dagen} dagen`;
  statVolgendLabelEl.textContent = `Volgend feest — ${wanneer}`;

  const details = reserveringen[volgende];
  statVolgendEl.textContent = `${datumKort(volgende)} — ${toon(details.type_feest)}`;
  const sub = document.createElement('div');
  sub.className = 'stat-sub';
  sub.textContent =
    `${toon(details.aantal_personen)} pers. · ${toon(details.start_tijd)}–${toon(details.eind_tijd)}`;
  statVolgendEl.appendChild(sub);
}

// ---------- Komende reservaties ----------

let komendeFilter = 'alle'; // 'alle' of 'JJJJ-MM'

function renderKomendeLijst() {
  const vandaag = datumNaarString(new Date());
  const komende = Object.keys(reserveringen).filter((d) => d >= vandaag).sort();

  // Maandfilter opnieuw vullen met de maanden waarin iets gepland staat.
  const maanden = [...new Set(komende.map((d) => d.slice(0, 7)))];
  if (komendeFilter !== 'alle' && !maanden.includes(komendeFilter)) {
    komendeFilter = 'alle';
  }
  komendeFilterEl.innerHTML = '';
  const alleOptie = document.createElement('option');
  alleOptie.value = 'alle';
  alleOptie.textContent = 'Alle maanden';
  komendeFilterEl.appendChild(alleOptie);
  for (const maand of maanden) {
    const optie = document.createElement('option');
    optie.value = maand;
    const [j, m] = maand.split('-').map(Number);
    optie.textContent = `${MAANDEN[m - 1]} ${j}`;
    komendeFilterEl.appendChild(optie);
  }
  komendeFilterEl.value = komendeFilter;

  const zichtbaar = komende.filter(
    (d) => komendeFilter === 'alle' || d.startsWith(komendeFilter)
  );
  komendeLijstEl.innerHTML = '';
  komendeLeegEl.classList.toggle('verborgen', zichtbaar.length > 0);

  for (const datumStr of zichtbaar) {
    const details = reserveringen[datumStr];
    const knop = document.createElement('button');
    knop.type = 'button';
    knop.className = 'komende-rij';

    const datumBlok = document.createElement('span');
    datumBlok.className = 'komende-datum';
    const dagNr = document.createElement('span');
    dagNr.className = 'dag-nr';
    dagNr.textContent = String(Number(datumStr.slice(8, 10)));
    const maandKort = document.createElement('span');
    maandKort.className = 'maand-kort';
    maandKort.textContent = MAANDEN[Number(datumStr.slice(5, 7)) - 1].slice(0, 3);
    datumBlok.appendChild(dagNr);
    datumBlok.appendChild(maandKort);

    const info = document.createElement('span');
    info.className = 'komende-info';
    const titel = document.createElement('span');
    titel.className = 'komende-titel';
    titel.textContent = `${toon(details.type_feest)} — ${toon(details.naam)}`;
    const meta = document.createElement('span');
    meta.className = 'komende-meta';
    meta.textContent =
      `${toon(details.aantal_personen)} pers. · ${toon(details.start_tijd)}–${toon(details.eind_tijd)}`;
    info.appendChild(titel);
    info.appendChild(meta);

    const bedragEl = document.createElement('span');
    bedragEl.className = 'komende-bedrag';
    bedragEl.textContent = bedrag(details.totaal_bedrag ?? 60);

    knop.appendChild(datumBlok);
    knop.appendChild(info);
    knop.appendChild(bedragEl);
    knop.addEventListener('click', () => {
      getoondeMaand = new Date(Number(datumStr.slice(0, 4)), Number(datumStr.slice(5, 7)) - 1, 1);
      toonDetails(datumStr);
    });
    komendeLijstEl.appendChild(knop);
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
  renderStatistieken();
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

  // De bibliotheek wordt zelf gehost (assets/supabase-js-*.min.js, geladen in
  // beheer.html) en zet één globaal object neer — geen externe CDN.
  // De standaardinstellingen (sessie bewaren + magic-link-tokens uit de URL
  // oppikken) zijn precies wat we nodig hebben.
  const { createClient } = window.supabase;
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
  komendeFilterEl.addEventListener('change', () => {
    komendeFilter = komendeFilterEl.value;
    renderKomendeLijst();
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
