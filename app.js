import { supabaseConfig } from './supabase-config.js';

const MAANDEN = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december'
];
const MIN_STARTTIJD = '10:00'; // reserveren kan ten vroegste vanaf 10:00
const MAX_EINDTIJD = '02:00'; // uiterlijk 02:00 's nachts (na middernacht)
// Maandag t/m donderdag gelden strengere regels: enkel teambuildings of
// vergaderingen, tussen 10:00 en 18:00, zonder muziek, vanaf 15 personen.
// De server (edge function + databasefunctie) dwingt dezelfde regels af.
const WEEKDAG_EINDTIJD = '18:00';
const WEEKDAG_MIN_PERSONEN = 15;
const WEEKEND_MIN_PERSONEN = 25;
const TYPE_FEEST_VOORBEELDEN = [
  'lentefeest', 'communie', 'verjaardag', 'pensioenviering',
  'sweet sixteen', 'sweet eighteen', 'personeelsfeest', 'bijeenkomst'
];
const STATUS_BETAALD = 'betaald';
const STATUS_IN_AFWACHTING = 'in_afwachting';

// Prijzen in hele euro's, alleen voor de live totaalweergave. De server
// (supabase/functions/reserveer) is de enige autoriteit over prijzen;
// wijzig prijzen dus altijd op beide plekken.
const PRIJZEN = {
  reservatiekosten: 60,
  frietjesFrikandel: 7,   // per persoon
  hamburgerFrietjes: 8,   // per persoon
  pita: 6,                // per persoon
  eigenFoodtruck: 25      // forfait stroom/water/kabels/afval
};

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

// Maandag t/m donderdag (weekend = vrijdag t/m zondag). De datum wordt uit
// zijn onderdelen opgebouwd, net als in de kalender, zodat de tijdzone geen
// rol speelt.
function isWeekdag(datumStr) {
  const [j, m, d] = datumStr.split('-').map(Number);
  const dag = new Date(j, m - 1, d).getDay();
  return dag >= 1 && dag <= 4;
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

// Vult de starttijd-dropdown met kwartieren: 10:00 t/m 23:45, op weekdagen
// (ma-do) 10:00 t/m 17:45. Wordt bij elke dialoogopening opnieuw opgebouwd
// omdat de gekozen datum de reeks bepaalt.
function vulStartTijden() {
  const select = document.getElementById('start-tijd');
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.defaultSelected = true;
  placeholder.textContent = 'Kies een tijd';
  select.appendChild(placeholder);
  const tot = weekdagBoeking ? tijdNaarMinuten(WEEKDAG_EINDTIJD) : 24 * 60;
  for (let m = tijdNaarMinuten(MIN_STARTTIJD); m < tot; m += 15) {
    const optie = document.createElement('option');
    optie.value = optie.textContent = minutenNaarTijd(m);
    select.appendChild(optie);
  }
}

// Vult de eindtijd-dropdown: van een kwartier na de starttijd tot en met
// uiterlijk 02:00 's nachts (over middernacht heen); op weekdagen (ma-do)
// tot en met 18:00 zonder over middernacht te gaan.
function werkEindTijdenBij() {
  const start = document.getElementById('start-tijd').value;
  const select = document.getElementById('eind-tijd');
  const huidig = select.value;
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.defaultSelected = true;
  placeholder.selected = true;
  placeholder.textContent = start ? 'Kies een tijd' : 'Kies eerst een starttijd';
  select.appendChild(placeholder);
  select.disabled = !start;
  if (!start) return;
  const tot = weekdagBoeking
    ? tijdNaarMinuten(WEEKDAG_EINDTIJD)
    : 24 * 60 + tijdNaarMinuten(MAX_EINDTIJD);
  for (let m = tijdNaarMinuten(start) + 15; m <= tot; m += 15) {
    const optie = document.createElement('option');
    optie.value = optie.textContent = minutenNaarTijd(m);
    select.appendChild(optie);
  }
  // Behoud de eerder gekozen eindtijd als die nog steeds geldig is;
  // anders valt de selectie terug op de placeholder.
  if (huidig) select.value = huidig;
  if (select.value !== huidig) select.value = '';
}

// Eindtijd is geldig als hij ná de starttijd valt (zelfde dag),
// of uiterlijk 02:00 's nachts (over middernacht heen). Op weekdagen (ma-do)
// moet alles tussen 10:00 en 18:00 vallen.
function valideerTijden(start, eind) {
  if (!start || !eind) return 'Vul zowel een starttijd als een eindtijd in.';
  const s = tijdNaarMinuten(start);
  const e = tijdNaarMinuten(eind);
  if (weekdagBoeking) {
    if (s < tijdNaarMinuten(MIN_STARTTIJD) || e > tijdNaarMinuten(WEEKDAG_EINDTIJD) || e <= s) {
      return 'Op maandag t/m donderdag kan je enkel reserveren tussen 10:00 en 18:00.';
    }
    return null;
  }
  const overMiddernacht = e < s && e <= tijdNaarMinuten(MAX_EINDTIJD);
  if (!overMiddernacht && e <= s) {
    return 'De eindtijd moet na de starttijd liggen. Loopt het feest door tot na middernacht, kies dan een eindtijd van uiterlijk 02:00.';
  }
  return null;
}

// ---------- Telefoonnummer automatisch formatteren ----------

// Groepering per nummertype: gsm 0470 12 34 56, vaste lijn met korte zone
// 02 123 45 67, vaste lijn met lange zone 011 22 33 44.
function telefoonGroepen(cijfers) {
  if (/^0(2|3|9|4[23])/.test(cijfers)) return [2, 3, 2, 2];
  if (/^04/.test(cijfers) || cijfers.length <= 2) return [4, 2, 2, 2];
  return [3, 2, 2, 2];
}

function formateerTelefoon(ruw) {
  // +32 of 0032 aan het begin wordt een gewone 0.
  const genormaliseerd = ruw.replace(/^\s*(\+|00)32\s*/, '0');
  // Ander buitenlands nummer: niet aanpassen.
  if (genormaliseerd.trim().startsWith('+')) return ruw;
  let cijfers = genormaliseerd.replace(/\D/g, '');
  const groepen = telefoonGroepen(cijfers);
  cijfers = cijfers.slice(0, groepen.reduce((a, b) => a + b, 0));
  const delen = [];
  let i = 0;
  for (const lengte of groepen) {
    if (i >= cijfers.length) break;
    delen.push(cijfers.slice(i, i + lengte));
    i += lengte;
  }
  return delen.join(' ');
}

function koppelTelefoonFormattering() {
  const veld = document.getElementById('telefoon');
  veld.addEventListener('input', () => {
    const cijfersVoorCaret = veld.value.slice(0, veld.selectionStart).replace(/\D/g, '').length;
    const nieuw = formateerTelefoon(veld.value);
    if (nieuw === veld.value) return;
    veld.value = nieuw;
    // Zet de cursor terug na hetzelfde aantal cijfers als vóór het formatteren.
    let positie = 0;
    for (let geteld = 0; positie < nieuw.length && geteld < cijfersVoorCaret; positie++) {
      if (/\d/.test(nieuw[positie])) geteld++;
    }
    veld.setSelectionRange(positie, positie);
  });
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
  // De bibliotheek wordt zelf gehost (assets/supabase-js-*.min.js, geladen in
  // index.html) en zet één globaal object neer — geen externe CDN.
  const { createClient } = window.supabase;
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

// ---------- Cloudflare Turnstile (optionele anti-bot-controle) ----------

// Alleen actief als er een turnstileSiteKey in supabase-config.js staat
// (de server controleert het token dan met het secret TURNSTILE_SECRET_KEY).
let turnstileWidgetId = null;
let turnstileScript = null; // Promise die het laden van het script bewaakt

function turnstileActief() {
  return supabaseIsGeconfigureerd() && Boolean(supabaseConfig.turnstileSiteKey);
}

function laadTurnstileScript() {
  if (!turnstileScript) {
    turnstileScript = new Promise((klaar, mislukt) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = klaar;
      script.onerror = () => mislukt(new Error('De beveiligingscontrole kon niet geladen worden.'));
      document.head.appendChild(script);
    });
  }
  return turnstileScript;
}

// Toont de widget in het formulier (eerste keer) of zet hem terug op nul
// (tokens zijn eenmalig bruikbaar).
async function toonTurnstile() {
  if (!turnstileActief()) return;
  try {
    await laadTurnstileScript();
    const houder = document.getElementById('turnstile-houder');
    houder.classList.remove('verborgen');
    if (turnstileWidgetId === null) {
      turnstileWidgetId = window.turnstile.render(houder, {
        sitekey: supabaseConfig.turnstileSiteKey
      });
    } else {
      window.turnstile.reset(turnstileWidgetId);
    }
  } catch (fout) {
    // De server weigert de aanvraag dan toch; hier alvast duidelijk zijn.
    toonFormulierFout(fout.message);
  }
}

function turnstileToken() {
  if (!turnstileActief() || turnstileWidgetId === null) return undefined;
  return window.turnstile.getResponse(turnstileWidgetId) || undefined;
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
let weekdagBoeking = false; // geldt de geselecteerde datum als ma-do?

const kalenderEl = document.getElementById('kalender');
const maandTitelEl = document.getElementById('maand-titel');
const dialoogEl = document.getElementById('reserveer-dialoog');
const formulierEl = document.getElementById('reserveer-formulier');
const formulierFoutEl = document.getElementById('formulier-fout');
const toastEl = document.getElementById('toast');

function vandaagString() {
  return datumNaarString(new Date());
}

// Reserveren moet minstens 2 dagen op voorhand: vandaag en morgen zijn te
// kort dag om het feest voor te bereiden. De server hanteert dezelfde grens.
const MIN_DAGEN_VOORUIT = 2;

function eersteBoekbareDatumString() {
  const d = new Date();
  d.setDate(d.getDate() + MIN_DAGEN_VOORUIT);
  return datumNaarString(d);
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
  const eersteBoekbaar = eersteBoekbareDatumString();
  for (let dag = 1; dag <= dagenInMaand; dag++) {
    const datumStr = datumNaarString(new Date(jaar, maand, dag));
    const cel = document.createElement('div');
    cel.textContent = dag;

    const status = reserveringStatus(datumStr);
    if (datumStr < vandaag) {
      cel.className = 'dag niet-beschikbaar';
      cel.title = 'Deze datum is voorbij';
    } else if (datumStr < eersteBoekbaar) {
      cel.className = 'dag niet-beschikbaar';
      cel.title = 'Reserveren kan tot uiterlijk 2 dagen vooraf';
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
    // Op aanraakschermen bestaat er geen hover-title: wie op een grijze,
    // bezette of in-afwachting-dag tikt, krijgt de uitleg als toast te zien.
    if (!cel.classList.contains('beschikbaar')) {
      cel.addEventListener('click', () => toonToast(cel.title));
    }
    kalenderEl.appendChild(cel);
  }
}

// Geanimeerde placeholder voor "Type feest": typt de voorbeelden één voor
// één uit, wist ze weer en gaat door naar het volgende voorbeeld.
let typeFeestTimer = null;

function startTypeFeestAnimatie() {
  const veld = document.getElementById('type-feest');
  // Wie liever geen beweging ziet, krijgt een vaste placeholder.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    stopTypeFeestAnimatie();
    veld.placeholder = `bv. ${TYPE_FEEST_VOORBEELDEN[0]}`;
    return;
  }
  let woordIndex = 0;
  let positie = 0;
  let wissen = false;

  function stap() {
    const woord = TYPE_FEEST_VOORBEELDEN[woordIndex];
    let wachttijd;
    if (!wissen) {
      positie++;
      wachttijd = positie === woord.length ? 1600 : 90; // even blijven staan bij het volledige woord
      if (positie === woord.length) wissen = true;
    } else {
      positie--;
      wachttijd = 40;
      if (positie === 0) {
        wissen = false;
        woordIndex = (woordIndex + 1) % TYPE_FEEST_VOORBEELDEN.length;
        wachttijd = 350;
      }
    }
    veld.placeholder = `bv. ${woord.slice(0, positie)}`;
    typeFeestTimer = setTimeout(stap, wachttijd);
  }

  stopTypeFeestAnimatie();
  stap();
}

function stopTypeFeestAnimatie() {
  clearTimeout(typeFeestTimer);
  typeFeestTimer = null;
}

// ---------- Extra opties ----------

// Toont of verbergt de detailblokken op basis van de gekozen radio's.
// Elk blok draagt data-toon-bij="veldnaam=waarde1|waarde2". De klasse
// 'ingeklapt' laat het blok vloeiend open- en dichtklappen (zie style.css).
// Velden in een dichtgeklapt blok worden ook uitgeschakeld, zodat verlaten
// waarden (bv. eerst gerechten invullen en dan toch "nee" kiezen) nooit
// meetellen of meegaan.
function werkExtraDetailsBij() {
  for (const blok of formulierEl.querySelectorAll('.extra-detail')) {
    const [naam, waarden] = blok.dataset.toonBij.split('=');
    const huidig = formulierEl.elements[naam]?.value;
    const zichtbaar = waarden.split('|').includes(huidig);
    blok.classList.toggle('ingeklapt', !zichtbaar);
    for (const veld of blok.querySelectorAll('input')) veld.disabled = !zichtbaar;
  }
}

function veldAantal(id) {
  const veld = document.getElementById(id);
  if (veld.disabled) return 0;
  return Number(veld.value) || 0;
}

const GERECHTEN = [
  ['ft-frikandel', 'frietjesFrikandel', 'Frietjes met frikandel'],
  ['ft-hamburger', 'hamburgerFrietjes', 'Hamburger met frietjes'],
  ['ft-pita', 'pita', 'Pita']
];

// Spiegel van de berekening op de server, alleen voor de live weergave.
function berekenPrijsregels() {
  const regels = [{ label: 'Reservatiekosten', bedrag: PRIJZEN.reservatiekosten }];
  if (formulierEl.elements.foodtruckVzw.value === 'ja') {
    for (const [id, prijsSleutel, label] of GERECHTEN) {
      const aantal = veldAantal(id);
      if (aantal > 0) {
        regels.push({
          label: `${label} (${aantal} × € ${PRIJZEN[prijsSleutel]})`,
          bedrag: aantal * PRIJZEN[prijsSleutel]
        });
      }
    }
  }
  if (formulierEl.elements.eigenFoodtruck.value === 'ja') {
    regels.push({ label: 'Eigen foodtruck (forfait)', bedrag: PRIJZEN.eigenFoodtruck });
  }
  return regels;
}

// Werkt de prijsregels, het totaal en het knoplabel bij; geeft het totaal terug.
// Verandert het totaal terwijl de dialoog open is, dan 'popt' het bedrag even
// (niet bij het openen zelf: openDialoog zet vorigTotaal eerst op null).
let vorigTotaal = null;

function werkTotaalBij() {
  const regels = berekenPrijsregels();
  const totaal = regels.reduce((som, regel) => som + regel.bedrag, 0);
  document.getElementById('prijs-regels').innerHTML = regels
    .map((regel) => `<div><span>${regel.label}</span><span>€ ${regel.bedrag}</span></div>`)
    .join('');
  const totaalEl = document.getElementById('prijs-totaal');
  totaalEl.textContent = `€ ${totaal}`;
  if (vorigTotaal !== null && totaal !== vorigTotaal) {
    totaalEl.classList.remove('pop');
    void totaalEl.offsetWidth; // herstart de animatie
    totaalEl.classList.add('pop');
  }
  vorigTotaal = totaal;
  const knop = document.getElementById('bevestig-knop');
  if (!knop.disabled) knop.textContent = `Reserveren en € ${totaal} betalen`;
  return totaal;
}

// Bouwt het extras-object dat naar de server gaat. De server hervalideert
// alles en berekent het bedrag opnieuw; dit is alleen de doorgegeven keuze.
function verzamelExtras() {
  const foodtruckGekozen = formulierEl.elements.foodtruckVzw.value === 'ja';
  const extras = {
    foodtruckVzw: foodtruckGekozen
      ? {
          gekozen: true,
          frietjesFrikandel: veldAantal('ft-frikandel'),
          hamburgerFrietjes: veldAantal('ft-hamburger'),
          pita: veldAantal('ft-pita')
        }
      : false,
    eigenFoodtruck: formulierEl.elements.eigenFoodtruck.value === 'ja',
    bbq: formulierEl.elements.bbq.value === 'ja'
  };
  // Op ma-do is muziek niet mogelijk: het veld gaat dan helemaal niet mee.
  if (!weekdagBoeking) extras.muziek = formulierEl.elements.muziek.value;
  return extras;
}

// Controle van de extra opties vóór verzenden; geeft een foutmelding of null.
function valideerExtras(extras) {
  if (extras.foodtruckVzw) {
    const totaalGerechten = extras.foodtruckVzw.frietjesFrikandel +
      extras.foodtruckVzw.hamburgerFrietjes + extras.foodtruckVzw.pita;
    if (totaalGerechten < 1) {
      return 'Kies minstens één gerecht bij de foodtruck van de vzw, of zet die optie op "nee".';
    }
    for (const [id] of GERECHTEN) {
      const waarde = veldAantal(id);
      if (!Number.isInteger(waarde) || waarde < 0 || waarde > 500) {
        return 'Vul bij de foodtruck geldige aantallen in (0 t/m 500).';
      }
    }
  }
  return null;
}

// Past het formulier aan op de gekozen dag: op ma-do een vaste keuzelijst
// voor het type, geen muziekvraag, een lagere personengrens en de kortere
// tijdvenster-hints. Uitgeschakelde velden tellen niet mee voor 'required'
// en komen ook niet in de verzonden gegevens terecht.
function pasWeekdagRegelsToe() {
  document.getElementById('weekdag-info').classList.toggle('verborgen', !weekdagBoeking);

  const typeTekst = document.getElementById('type-feest');
  const typeKeuze = document.getElementById('type-feest-weekdag');
  typeTekst.hidden = typeTekst.disabled = weekdagBoeking;
  typeKeuze.hidden = typeKeuze.disabled = !weekdagBoeking;
  document.getElementById('type-feest-label').htmlFor =
    weekdagBoeking ? 'type-feest-weekdag' : 'type-feest';

  const muziekSectie = document.getElementById('muziek-sectie');
  muziekSectie.classList.toggle('verborgen', weekdagBoeking);
  for (const radio of muziekSectie.querySelectorAll('input')) {
    radio.disabled = weekdagBoeking;
  }

  const minPersonen = weekdagBoeking ? WEEKDAG_MIN_PERSONEN : WEEKEND_MIN_PERSONEN;
  document.getElementById('aantal-personen').min = minPersonen;
  document.getElementById('aantal-personen-hint').textContent = `Vanaf ${minPersonen} personen`;

  document.getElementById('eind-tijd-hint').textContent =
    weekdagBoeking ? 'Uiterlijk 18:00' : 'Uiterlijk 02:00 ’s nachts';
}

function openDialoog(datumStr) {
  geselecteerdeDatum = datumStr;
  weekdagBoeking = isWeekdag(datumStr);
  document.getElementById('dialoog-datum').textContent = datumMooi(datumStr);
  formulierEl.reset();
  vorigTotaal = null; // geen prijs-pop bij het openen van de dialoog
  verbergFormulierFout();
  pasWeekdagRegelsToe();
  vulStartTijden();
  werkEindTijdenBij();
  werkOpbouwHintBij();
  werkExtraDetailsBij();
  werkTotaalBij();
  if (weekdagBoeking) stopTypeFeestAnimatie();
  else startTypeFeestAnimatie();
  dialoogEl.showModal();
  toonTurnstile();
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
  toastEl.classList.remove('toast-verborgen');
  clearTimeout(toonToast.timer);
  toonToast.timer = setTimeout(() => toastEl.classList.add('toast-verborgen'), 6000);
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
  const typeFeest = weekdagBoeking
    ? document.getElementById('type-feest-weekdag').value
    : document.getElementById('type-feest').value.trim();
  const aantalPersonen = Number(document.getElementById('aantal-personen').value);
  const startTijd = document.getElementById('start-tijd').value;
  const eindTijd = document.getElementById('eind-tijd').value;
  const opbouwMinuten = Number(document.getElementById('opbouw').value);
  const opmerkingen = document.getElementById('opmerkingen').value.trim();

  const minPersonen = weekdagBoeking ? WEEKDAG_MIN_PERSONEN : WEEKEND_MIN_PERSONEN;
  if (!(aantalPersonen >= minPersonen)) {
    toonFormulierFout(`Reserveren kan vanaf minimaal ${minPersonen} personen.`);
    return;
  }
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
  const extras = verzamelExtras();
  const extrasFout = valideerExtras(extras);
  if (extrasFout) {
    toonFormulierFout(extrasFout);
    return;
  }
  if (turnstileActief() && !turnstileToken()) {
    toonFormulierFout('Wacht even tot de beveiligingscontrole klaar is en probeer opnieuw.');
    return;
  }

  const details = {
    naam, email, telefoon, typeFeest, aantalPersonen,
    startTijd, eindTijd, opbouwMinuten,
    opbouwVanaf: minutenNaarTijd(tijdNaarMinuten(startTijd) - opbouwMinuten),
    opmerkingen, extras,
    turnstileToken: turnstileToken()
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
    // Turnstile-tokens zijn eenmalig: na een mislukte poging een nieuwe vragen.
    if (turnstileActief() && turnstileWidgetId !== null) {
      window.turnstile.reset(turnstileWidgetId);
    }
  } finally {
    knop.disabled = false;
    werkTotaalBij(); // zet ook het knoplabel ("Reserveren en € X betalen") terug
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

// Laat de kalender kort invegen in de bladerrichting. Alleen bij handmatig
// bladeren — niet bij live updates of de minuutlijkse hertekening.
function animeerMaandWissel(richting) {
  kalenderEl.classList.remove('wissel-vooruit', 'wissel-terug');
  void kalenderEl.offsetWidth; // herstart de animatie
  kalenderEl.classList.add(richting > 0 ? 'wissel-vooruit' : 'wissel-terug');
}

function koppelGebeurtenissen() {
  document.getElementById('vorige-maand').addEventListener('click', () => {
    getoondeMaand = new Date(getoondeMaand.getFullYear(), getoondeMaand.getMonth() - 1, 1);
    renderKalender();
    animeerMaandWissel(-1);
  });
  document.getElementById('volgende-maand').addEventListener('click', () => {
    getoondeMaand = new Date(getoondeMaand.getFullYear(), getoondeMaand.getMonth() + 1, 1);
    renderKalender();
    animeerMaandWissel(1);
  });
  document.getElementById('annuleer-knop').addEventListener('click', sluitDialoog);
  document.getElementById('sluit-knop').addEventListener('click', sluitDialoog);
  // Vangt ook sluiten via Esc af, niet alleen via de annuleerknop.
  dialoogEl.addEventListener('close', stopTypeFeestAnimatie);
  formulierEl.addEventListener('submit', verwerkFormulier);
  document.getElementById('start-tijd').addEventListener('change', () => {
    werkEindTijdenBij();
    werkOpbouwHintBij();
  });
  document.getElementById('opbouw').addEventListener('change', werkOpbouwHintBij);
  // Eén gedelegeerde listener voor alle extra opties: 'input' vuurt zowel
  // voor radio's als voor de aantal-velden.
  document.querySelector('.extra-opties').addEventListener('input', () => {
    werkExtraDetailsBij();
    werkTotaalBij();
  });
  koppelTelefoonFormattering();
}

async function start() {
  const nu = new Date();
  getoondeMaand = new Date(nu.getFullYear(), nu.getMonth(), 1);
  vulStartTijden();
  koppelGebeurtenissen();
  renderKalender();

  const bijUpdate = (alles) => {
    reserveringen = alles;
    renderKalender();
    document.getElementById('live-status').textContent =
      `Live verbonden — laatst bijgewerkt ${new Date().toLocaleTimeString('nl-NL')}`;
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
