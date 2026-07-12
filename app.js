import { supabaseConfig } from './supabase-config.js';

const MAANDEN = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december'
];
const MAX_EINDTIJD = '02:00'; // uiterlijk 02:00 's nachts (na middernacht)
const STATUS_BETAALD = 'betaald';
const STATUS_IN_AFWACHTING = 'in_afwachting';

// ---------- Datum-hulpfuncties ----------

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

function tijdNaarMinuten(t) {
  const [uur, min] = t.split(':').map(Number);
  return uur * 60 + min;
}

function minutenNaarTijd(totaal) {
  const genormaliseerd = ((totaal % 1440) + 1440) % 1440;
  const uur = String(Math.floor(genormaliseerd / 60)).padStart(2, '0');
  const min = String(genormaliseerd % 60).padStart(2, '0');
  return `${uur}:${min}`;
}

// Eindtijd is geldig als hij ná de starttijd valt (zelfde dag),
// of uiterlijk 02:00 's nachts (over middernacht heen).
function valideerTijden(start, eind) {
  if (!start || !eind) return 'Vul zowel een starttijd als een eindtijd in.';
  const s = tijdNaarMinuten(start);
  const e = tijdNaarMinuten(eind);
  const overMiddernacht = e < s && e <= tijdNaarMinuten(MAX_EINDTIJD);
  if (!overMiddernacht && e <= s) {
    return 'De eindtijd moet na de starttijd liggen. Loopt het feest door tot na middernacht, kies dan een eindtijd van uiterlijk 02:00.';
  }
  return null;
}

// ---------- Opslag: demo (localStorage) of Supabase ----------

function supabaseIsGeconfigureerd() {
  return supabaseConfig && supabaseConfig.url &&
    !String(supabaseConfig.url).startsWith('PLAK_HIER');
}

// Demo-opslag: alleen lokaal in deze browser. Het 'storage'-event zorgt er wél
// voor dat andere tabbladen op dezelfde computer live meebewegen.
function maakDemoOpslag(onChange) {
  const SLEUTEL = 'demo-reserveringen';
  const lees = () => {
    try { return JSON.parse(localStorage.getItem(SLEUTEL)) || {}; }
    catch { return {}; }
  };
  window.addEventListener('storage', (e) => {
    if (e.key === SLEUTEL) onChange(lees());
  });
  return {
    naam: 'demo',
    start() { onChange(lees()); },
    async reserveer(datum, details) {
      const alles = lees();
      const bestaand = alles[datum];
      // Net als op de server telt een verlopen 'in afwachting' niet als bezet.
      const verlopen = bestaand &&
        (bestaand.status || STATUS_BETAALD) === STATUS_IN_AFWACHTING &&
        bestaand.verloopt_op && new Date(bestaand.verloopt_op) <= new Date();
      if (bestaand && !verlopen) {
        throw new Error('Deze datum is zojuist al door iemand anders gereserveerd.');
      }
      // In demo-modus is er geen echte betaling: meteen 'betaald'.
      alles[datum] = { datum, status: STATUS_BETAALD, details, aangemaaktOp: new Date().toISOString() };
      localStorage.setItem(SLEUTEL, JSON.stringify(alles));
      onChange(alles);
      return null; // geen checkout-URL
    }
  };
}

async function maakSupabaseOpslag(onChange) {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const client = createClient(supabaseConfig.url, supabaseConfig.anonKey);

  async function laadAlles() {
    const { data, error } = await client.from('reserveringen').select('datum, status, verloopt_op');
    if (error) {
      toonFoutBanner('Kan reserveringen niet laden: ' + error.message);
      return;
    }
    const alles = {};
    for (const rij of data) alles[rij.datum] = rij;
    onChange(alles);
  }

  return {
    naam: 'supabase',
    start() {
      laadAlles();
      // Bij elke wijziging in de tabel (nieuwe reservering, of een door jou
      // verwijderde reservering) halen we de lijst opnieuw op.
      client.channel('reserveringen-live')
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'reserveringen' },
          laadAlles)
        .subscribe();
    },
    // Reserveren loopt via de edge function: die zet de datum vast én maakt
    // de Mollie-betaling aan. We krijgen de checkout-URL terug.
    async reserveer(datum, details) {
      let antwoord;
      try {
        antwoord = await fetch(`${supabaseConfig.url}/functions/v1/reserveer`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseConfig.anonKey}`,
            'apikey': supabaseConfig.anonKey
          },
          body: JSON.stringify({ datum, ...details })
        });
      } catch {
        throw new Error('Geen verbinding met de server. Controleer je internet en probeer opnieuw.');
      }
      const data = await antwoord.json().catch(() => ({}));
      if (!antwoord.ok) {
        throw new Error(data.fout || 'Er ging iets mis bij het starten van de betaling.');
      }
      if (!data.checkoutUrl) {
        throw new Error('De betaalpagina kon niet geopend worden. Probeer het opnieuw.');
      }
      return data;
    },
    // Status van één datum opvragen (gebruikt na terugkeer van de betaalpagina).
    async haalStatus(datum) {
      const { data, error } = await client.from('reserveringen')
        .select('datum, status, verloopt_op')
        .eq('datum', datum)
        .maybeSingle();
      if (error) return undefined;
      return data; // null = datum is (weer) vrij
    }
  };
}

// ---------- Applicatie ----------

let reserveringen = {}; // datumstring -> reserveringsgegevens

// Status van een datum: 'betaald' (rood), 'in_afwachting' (geel, betaling
// loopt nog) of null (vrij). Een verlopen 'in_afwachting' telt weer als vrij.
function reserveringStatus(datumStr) {
  const r = reserveringen[datumStr];
  if (!r) return null;
  const status = r.status || STATUS_BETAALD;
  if (status === STATUS_IN_AFWACHTING) {
    if (r.verloopt_op && new Date(r.verloopt_op) <= new Date()) return null;
    return STATUS_IN_AFWACHTING;
  }
  return STATUS_BETAALD;
}
let opslag = null;
let getoondeMaand; // Date, altijd de 1e van de maand
let geselecteerdeDatum = null;

const kalenderEl = document.getElementById('kalender');
const maandTitelEl = document.getElementById('maand-titel');
const dialoogEl = document.getElementById('reserveer-dialoog');
const formulierEl = document.getElementById('reserveer-formulier');
const formulierFoutEl = document.getElementById('formulier-fout');
const toastEl = document.getElementById('toast');

function vandaagString() {
  return datumNaarString(new Date());
}

function renderKalender() {
  const jaar = getoondeMaand.getFullYear();
  const maand = getoondeMaand.getMonth();
  maandTitelEl.textContent = `${MAANDEN[maand]} ${jaar}`;

  // Niet verder terug kunnen bladeren dan de huidige maand
  const nu = new Date();
  const isHuidigeMaand = jaar === nu.getFullYear() && maand === nu.getMonth();
  document.getElementById('vorige-maand').disabled = isHuidigeMaand;

  kalenderEl.innerHTML = '';

  const eersteDag = new Date(jaar, maand, 1);
  const dagenInMaand = new Date(jaar, maand + 1, 0).getDate();
  const offset = (eersteDag.getDay() + 6) % 7; // week begint op maandag

  for (let i = 0; i < offset; i++) {
    const leeg = document.createElement('div');
    leeg.className = 'dag leeg';
    kalenderEl.appendChild(leeg);
  }

  const vandaag = vandaagString();
  for (let dag = 1; dag <= dagenInMaand; dag++) {
    const datumStr = datumNaarString(new Date(jaar, maand, dag));
    const cel = document.createElement('div');
    cel.textContent = dag;

    const status = reserveringStatus(datumStr);
    if (datumStr < vandaag) {
      cel.className = 'dag niet-beschikbaar';
      cel.title = 'Deze datum is voorbij';
    } else if (status === STATUS_BETAALD) {
      cel.className = 'dag bezet';
      cel.title = 'Bezet';
    } else if (status === STATUS_IN_AFWACHTING) {
      cel.className = 'dag in-afwachting';
      cel.title = 'Iemand is deze datum nu aan het betalen';
    } else {
      cel.className = 'dag beschikbaar';
      cel.title = 'Beschikbaar – klik om te reserveren';
      cel.tabIndex = 0;
      cel.setAttribute('role', 'button');
      cel.addEventListener('click', () => openDialoog(datumStr));
      cel.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDialoog(datumStr);
        }
      });
    }
    if (datumStr === vandaag) cel.classList.add('vandaag');
    kalenderEl.appendChild(cel);
  }
}

function openDialoog(datumStr) {
  geselecteerdeDatum = datumStr;
  document.getElementById('dialoog-datum').textContent = datumMooi(datumStr);
  formulierEl.reset();
  verbergFormulierFout();
  werkOpbouwHintBij();
  dialoogEl.showModal();
}

function sluitDialoog() {
  dialoogEl.close();
  geselecteerdeDatum = null;
}

function toonFormulierFout(tekst) {
  formulierFoutEl.textContent = tekst;
  formulierFoutEl.classList.remove('verborgen');
}

function verbergFormulierFout() {
  formulierFoutEl.classList.add('verborgen');
}

function toonToast(tekst) {
  toastEl.textContent = tekst;
  toastEl.classList.remove('verborgen');
  clearTimeout(toonToast.timer);
  toonToast.timer = setTimeout(() => toastEl.classList.add('verborgen'), 6000);
}

function toonFoutBanner(tekst) {
  const banner = document.getElementById('fout-banner');
  banner.textContent = tekst;
  banner.classList.remove('verborgen');
}

function werkOpbouwHintBij() {
  const start = document.getElementById('start-tijd').value;
  const opbouw = Number(document.getElementById('opbouw').value);
  const hint = document.getElementById('opbouw-hint');
  if (start && opbouw > 0) {
    hint.textContent = `Je kunt vanaf ${minutenNaarTijd(tijdNaarMinuten(start) - opbouw)} terecht om in te richten.`;
  } else if (start) {
    hint.textContent = `Je kunt vanaf ${start} terecht.`;
  } else {
    hint.textContent = '';
  }
}

async function verwerkFormulier(event) {
  event.preventDefault();
  verbergFormulierFout();

  const datum = geselecteerdeDatum;
  const naam = document.getElementById('naam').value.trim();
  const email = document.getElementById('email').value.trim();
  const telefoon = document.getElementById('telefoon').value.trim();
  const aantalPersonen = Number(document.getElementById('aantal-personen').value);
  const startTijd = document.getElementById('start-tijd').value;
  const eindTijd = document.getElementById('eind-tijd').value;
  const opbouwMinuten = Number(document.getElementById('opbouw').value);
  const opmerkingen = document.getElementById('opmerkingen').value.trim();

  const tijdFout = valideerTijden(startTijd, eindTijd);
  if (tijdFout) {
    toonFormulierFout(tijdFout);
    return;
  }
  if (datum < vandaagString()) {
    toonFormulierFout('Deze datum is inmiddels voorbij.');
    return;
  }
  if (reserveringStatus(datum)) {
    toonFormulierFout('Deze datum is zojuist al door iemand anders gereserveerd.');
    return;
  }

  const details = {
    naam, email, telefoon, aantalPersonen,
    startTijd, eindTijd, opbouwMinuten,
    opbouwVanaf: minutenNaarTijd(tijdNaarMinuten(startTijd) - opbouwMinuten),
    opmerkingen
  };

  const knop = document.getElementById('bevestig-knop');
  knop.disabled = true;
  knop.textContent = 'Bezig…';
  let doorsturenNaar = null;
  try {
    const resultaat = await opslag.reserveer(datum, details);
    if (resultaat && resultaat.checkoutUrl) {
      doorsturenNaar = resultaat.checkoutUrl;
    } else {
      sluitDialoog();
      toonToast(`Je reservering voor ${datumMooi(datum)} is bevestigd!`);
    }
  } catch (fout) {
    toonFormulierFout(fout.message || 'Er ging iets mis. Probeer het opnieuw.');
  } finally {
    knop.disabled = false;
    knop.textContent = 'Reserveren en € 60 betalen';
  }
  if (doorsturenNaar) {
    knop.disabled = true;
    knop.textContent = 'Doorsturen naar de betaalpagina…';
    window.location.href = doorsturenNaar;
  }
}

// Na terugkeer van de Mollie-betaalpagina: kijken of de betaling gelukt is.
// De webhook kan een paar seconden achterlopen, dus we kijken zo nodig
// een aantal keer opnieuw.
async function verwerkBetalingsTerugkeer(datum) {
  for (let poging = 0; poging < 15; poging++) {
    const rij = await opslag.haalStatus(datum);
    if (rij === null) {
      toonFoutBanner(`De betaling voor ${datumMooi(datum)} is niet afgerond. ` +
        'De datum is weer vrijgegeven — je kunt het opnieuw proberen.');
      return;
    }
    if (rij && (rij.status || STATUS_BETAALD) === STATUS_BETAALD) {
      toonToast(`Betaling gelukt! Je reservering voor ${datumMooi(datum)} is definitief. ` +
        'Je ontvangt de betaalbevestiging van Mollie per e-mail.');
      return;
    }
    await new Promise((klaar) => setTimeout(klaar, 2000));
  }
  toonToast('Je betaling wordt nog verwerkt. De kalender werkt automatisch bij ' +
    'zodra de betaling bevestigd is.');
}

function koppelGebeurtenissen() {
  document.getElementById('vorige-maand').addEventListener('click', () => {
    getoondeMaand = new Date(getoondeMaand.getFullYear(), getoondeMaand.getMonth() - 1, 1);
    renderKalender();
  });
  document.getElementById('volgende-maand').addEventListener('click', () => {
    getoondeMaand = new Date(getoondeMaand.getFullYear(), getoondeMaand.getMonth() + 1, 1);
    renderKalender();
  });
  document.getElementById('annuleer-knop').addEventListener('click', sluitDialoog);
  formulierEl.addEventListener('submit', verwerkFormulier);
  document.getElementById('start-tijd').addEventListener('input', werkOpbouwHintBij);
  document.getElementById('opbouw').addEventListener('change', werkOpbouwHintBij);
}

async function start() {
  const nu = new Date();
  getoondeMaand = new Date(nu.getFullYear(), nu.getMonth(), 1);
  koppelGebeurtenissen();
  renderKalender();

  const bijUpdate = (alles) => {
    reserveringen = alles;
    renderKalender();
    document.getElementById('live-status').textContent =
      `Laatst bijgewerkt: ${new Date().toLocaleTimeString('nl-NL')}`;
  };

  const modusBanner = document.getElementById('modus-banner');
  if (supabaseIsGeconfigureerd()) {
    try {
      opslag = await maakSupabaseOpslag(bijUpdate);
    } catch (fout) {
      toonFoutBanner('Supabase kon niet worden geladen: ' + fout.message);
      return;
    }
  } else {
    opslag = maakDemoOpslag(bijUpdate);
    modusBanner.textContent =
      '⚠️ Demo-modus: Supabase is nog niet geconfigureerd. Reserveringen worden alleen ' +
      'lokaal in deze browser opgeslagen en de betaalstap (€ 60 via Mollie) wordt ' +
      'overgeslagen. Zie README.md om live te gaan.';
    modusBanner.classList.remove('verborgen');
  }
  opslag.start();

  // Elke minuut opnieuw tekenen, zodat verlopen 'in afwachting'-dagen
  // vanzelf weer groen worden.
  setInterval(renderKalender, 60000);

  // Komt de bezoeker net terug van de Mollie-betaalpagina?
  const parameters = new URLSearchParams(window.location.search);
  const betaaldeDatum = parameters.get('betaling');
  if (betaaldeDatum && opslag.haalStatus) {
    history.replaceState(null, '', window.location.pathname);
    verwerkBetalingsTerugkeer(betaaldeDatum);
  }
}

start();
