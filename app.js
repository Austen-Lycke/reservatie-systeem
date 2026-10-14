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
const betalingDialoogEl = document.getElementById('betaling-dialoog');
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
  let vrijeDagen = 0;
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
    } else if (datumStr < eersteBoekbaar) {
      cel.className = 'dag niet-beschikbaar';
      cel.title = 'Reserveren kan tot uiterlijk 2 dagen vooraf';
    } else {
      cel.className = 'dag beschikbaar';
      cel.title = 'Vrij – klik om te reserveren';
      cel.tabIndex = 0;
      cel.setAttribute('role', 'button');
      cel.addEventListener('click', () => openDialoog(datumStr));
      cel.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDialoog(datumStr);
        }
      });
      vrijeDagen++;
    }
    // Bezet en "betaling loopt" dragen naast hun lichte kleur ook een
    // vormmarkering (vierkantje / rondje), zodat de staten ook zonder
    // kleurzicht uit elkaar te houden zijn.
    if (status && datumStr >= vandaag) {
      const marker = document.createElement('span');
      marker.className = 'dag-marker';
      marker.setAttribute('aria-hidden', 'true');
      cel.appendChild(marker);
    }
    if (datumStr === vandaag) {
      cel.classList.add('vandaag');
      const label = document.createElement('span');
      label.className = 'dag-vandaag-label';
      label.textContent = 'vandaag';
      cel.appendChild(label);
    }
    if (datumStr === geselecteerdeDatum) cel.classList.add('geselecteerd');
    // Op aanraakschermen bestaat er geen hover-title: wie op een grijze,
    // bezette of in-afwachting-dag tikt, krijgt de uitleg als toast te zien.
    if (!cel.classList.contains('beschikbaar')) {
      cel.addEventListener('click', () => toonToast(cel.title));
    }
    kalenderEl.appendChild(cel);
  }

  document.getElementById('kalender-vrij').textContent =
    vrijeDagen === 0 ? 'Geen dagen vrij' :
    vrijeDagen === 1 ? '1 dag vrij' : `${vrijeDagen} dagen vrij`;
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

// Spiegel van de berekening op de server, alleen voor de live weergave.
function berekenPrijsregels() {
  const regels = [{ label: 'Reservatiekosten', bedrag: PRIJZEN.reservatiekosten }];
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
  // Het totaal staat twee keer: in het donkere prijsblok (stap 3) en als
  // lopend bedrag in de voet van de dialoog (stap 1 en 2).
  for (const totaalEl of [document.getElementById('prijs-totaal'), document.getElementById('voet-totaal')]) {
    totaalEl.textContent = `€ ${totaal}`;
    if (vorigTotaal !== null && totaal !== vorigTotaal) {
      totaalEl.classList.remove('pop');
      void totaalEl.offsetWidth; // herstart de animatie
      totaalEl.classList.add('pop');
    }
  }
  vorigTotaal = totaal;
  const knop = document.getElementById('bevestig-knop');
  if (!knop.disabled) knop.textContent = `Reserveren en € ${totaal} betalen`;
  return totaal;
}

// ---------- Drie stappen ----------

// Stap 1: wanneer (tijden, opbouw, type, personen). Stap 2: contactgegevens.
// Stap 3: extra's, prijsoverzicht, akkoord en betalen. Alle velden zitten in
// één formulier; we tonen er telkens één blok van en controleren de velden
// van dat blok vóór het doorgaan.
const STAPPEN = {
  1: { sublabel: 'Stap 1 van 3 · Wanneer', verder: 'Verder naar je gegevens' },
  2: { sublabel: 'Stap 2 van 3 · Jouw gegevens', verder: 'Verder naar de extra’s' },
  3: { sublabel: 'Stap 3 van 3 · Extra’s en betalen' }
};
let huidigeStap = 1;

function toonStap(nummer) {
  huidigeStap = nummer;
  verbergFormulierFout();
  for (const blok of formulierEl.querySelectorAll('.stap[data-stap]')) {
    blok.hidden = Number(blok.dataset.stap) !== nummer;
  }
  document.querySelectorAll('.stappen-balk span').forEach((streep, i) => {
    streep.classList.toggle('klaar', i < nummer);
  });
  document.getElementById('dialoog-sublabel').textContent = STAPPEN[nummer].sublabel;
  document.getElementById('dialoog-datum').textContent =
    nummer === 1 ? datumMooi(geselecteerdeDatum) :
    nummer === 2 ? 'Wie reserveert?' : 'Nog iets nodig?';

  const laatste = nummer === 3;
  document.getElementById('terug-knop').classList.toggle('verborgen', nummer === 1);
  document.getElementById('annuleer-knop').classList.toggle('verborgen', nummer !== 1);
  document.getElementById('verder-knop').classList.toggle('verborgen', laatste);
  document.getElementById('bevestig-knop').classList.toggle('verborgen', !laatste);
  // In stap 3 staat het totaal al in het prijsblok; de voet krijgt dan
  // alleen de brede betaalknop.
  document.getElementById('voet-totaal-blok').classList.toggle('verborgen', laatste);
  document.getElementById('dialoog-voet').classList.toggle('voet-betalen', laatste);
  if (!laatste) document.getElementById('verder-knop').textContent = STAPPEN[nummer].verder;

  dialoogEl.scrollTop = 0;
  if (laatste) toonTurnstile();
}

// Ingebouwde browsercontrole (required, e-mail, min/max) van de velden in
// één stap. Het formulier heeft novalidate, dus wij vragen de melding zelf
// op bij het eerste veld dat niet klopt.
function stapVeldenGeldig(nummer) {
  const blok = document.getElementById(`stap-${nummer}`);
  for (const veld of blok.querySelectorAll('input, select, textarea')) {
    if (veld.disabled || veld.hidden) continue;
    if (!veld.checkValidity()) {
      veld.reportValidity();
      return false;
    }
  }
  return true;
}

// Eigen controles per stap; geeft een foutmelding of null.
function stapFout(nummer) {
  if (nummer === 1) {
    const minPersonen = weekdagBoeking ? WEEKDAG_MIN_PERSONEN : WEEKEND_MIN_PERSONEN;
    const aantalPersonen = Number(document.getElementById('aantal-personen').value);
    if (!(aantalPersonen >= minPersonen)) {
      return `Reserveren kan vanaf minimaal ${minPersonen} personen.`;
    }
    return valideerTijden(
      document.getElementById('start-tijd').value,
      document.getElementById('eind-tijd').value
    );
  }
  return null;
}

function volgendeStap() {
  if (!stapVeldenGeldig(huidigeStap)) return;
  const fout = stapFout(huidigeStap);
  if (fout) {
    toonFormulierFout(fout);
    return;
  }
  toonStap(huidigeStap + 1);
}

// Bouwt het extras-object dat naar de server gaat. De server hervalideert
// alles en berekent het bedrag opnieuw; dit is alleen de doorgegeven keuze.
function verzamelExtras() {
  const extras = {
    eigenFoodtruck: formulierEl.elements.eigenFoodtruck.value === 'ja',
    bbq: formulierEl.elements.bbq.value === 'ja'
  };
  // Op ma-do is muziek niet mogelijk: het veld gaat dan helemaal niet mee.
  if (!weekdagBoeking) extras.muziek = formulierEl.elements.muziek.value;
  return extras;
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
  document.getElementById('type-feest').placeholder = 'bv. communie';
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
  formulierEl.reset();
  vorigTotaal = null; // geen prijs-pop bij het openen van de dialoog
  pasWeekdagRegelsToe();
  vulStartTijden();
  werkEindTijdenBij();
  werkOpbouwHintBij();
  werkTotaalBij();
  toonStap(1);
  renderKalender(); // de gekozen dag licht op in de kalender
  if (weekdagBoeking) stopTypeFeestAnimatie();
  else startTypeFeestAnimatie();
  dialoogEl.showModal();
}

function sluitDialoog() {
  dialoogEl.close();
}

function toonFormulierFout(tekst) {
  formulierFoutEl.textContent = tekst;
  document.getElementById('stap-fout-houder').hidden = false;
  formulierFoutEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function verbergFormulierFout() {
  document.getElementById('stap-fout-houder').hidden = true;
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

function opbouwMinutenKeuze() {
  return Number(formulierEl.elements.opbouwMinuten.value) || 0;
}

function werkOpbouwHintBij() {
  const start = document.getElementById('start-tijd').value;
  const opbouw = opbouwMinutenKeuze();
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

  // Enter in een veld van stap 1 of 2 verstuurt het formulier ook; dat
  // betekent dan gewoon "verder".
  if (huidigeStap < 3) {
    volgendeStap();
    return;
  }
  if (!stapVeldenGeldig(3)) return;

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
  const opbouwMinuten = opbouwMinutenKeuze();
  const opmerkingen = document.getElementById('opmerkingen').value.trim();

  // Stap 1 is al gecontroleerd bij het doorgaan, maar wie teruggaat kan
  // intussen iets veranderd hebben: daarom hier nog eens alles.
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
      // Voor de bedankpagina na de betaling: de publieke kalender mag de
      // details niet uit de databank lezen, dus onthouden we de eigen
      // keuzes even in deze browser.
      bewaarSamenvatting({
        datum, startTijd, eindTijd,
        opbouwVanaf: opbouwMinuten > 0 ? details.opbouwVanaf : null,
        totaal: werkTotaalBij()
      });
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

// ---------- Samenvatting voor de bedankpagina ----------

// De publieke kalender leest nooit persoonsgegevens uit de databank, dus de
// uren en het bedrag voor de bedankpagina komen uit de eigen browser: we
// bewaren ze vlak vóór het doorsturen naar Mollie (sessionStorage blijft
// binnen dit tabblad en verdwijnt bij het sluiten ervan).
const SAMENVATTING_SLEUTEL = 'reservering-samenvatting';

function bewaarSamenvatting(gegevens) {
  try { sessionStorage.setItem(SAMENVATTING_SLEUTEL, JSON.stringify(gegevens)); }
  catch { /* privémodus of vol: dan gewoon geen detailrijen */ }
}

function leesSamenvatting(datum) {
  try {
    const gegevens = JSON.parse(sessionStorage.getItem(SAMENVATTING_SLEUTEL));
    return gegevens && gegevens.datum === datum ? gegevens : null;
  } catch {
    return null;
  }
}

// 'vr 18 september 2026' — voor de detailrijen op de bedankpagina.
function datumKort(datumStr) {
  const [j, m, d] = datumStr.split('-').map(Number);
  return new Intl.DateTimeFormat('nl-BE', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric'
  }).format(new Date(j, m - 1, d));
}

// '18 september' — voor de kop "De zaal is van jou op 18 september."
function dagEnMaand(datumStr) {
  const [, m, d] = datumStr.split('-').map(Number);
  return `${d} ${MAANDEN[m - 1]}`;
}

// De vier statussen van de betaaldialoog na terugkeer van Mollie. Bij
// 'controle' is de dialoog niet handmatig te sluiten via de knoppen (Esc kan
// wel — het eindresultaat opent de dialoog dan gewoon opnieuw).
const BETALING_STATUSSEN = {
  controle: {
    sublabel: 'Reservering',
    titel: 'We controleren je betaling.',
    tekst: (datum) => `We kijken bij Mollie na of de betaling voor ${datumMooi(datum)} gelukt is.`,
    sluitbaar: false,
    wachten: true
  },
  gelukt: {
    sublabel: 'Betaling gelukt',
    titel: (datum) => `De zaal is van jou op ${dagEnMaand(datum)}.`,
    tekst: () => 'We hebben je een bevestigingsmail gestuurd met alle gegevens. ' +
      'Je hoeft verder niets meer te doen.',
    knop: 'Terug naar de kalender',
    details: true,
    sluitbaar: true
  },
  verwerking: {
    sublabel: 'Reservering',
    titel: 'Je betaling wordt nog verwerkt.',
    tekst: (datum) => `De bevestiging van je betaling voor ${datumMooi(datum)} laat even ` +
      'op zich wachten; dit kan een paar minuten duren. Zodra de betaling bevestigd is, ' +
      'is je reservering definitief en ontvang je automatisch een bevestigingsmail ' +
      'met alle gegevens — je hoeft niets opnieuw te doen.',
    knop: 'Terug naar de kalender',
    sluitbaar: true
  },
  mislukt: {
    sublabel: 'Reservering',
    titel: 'Betaling niet afgerond.',
    tekst: (datum) => `De betaling voor ${datumMooi(datum)} is niet afgerond. ` +
      'De datum is weer vrijgegeven — je kunt opnieuw reserveren als je wilt.',
    knop: 'Opnieuw proberen',
    knopDonker: true,
    bellen: true,
    sluitbaar: true
  }
};

function toonBetalingsDialoog(status, datum) {
  const info = BETALING_STATUSSEN[status];
  const sublabel = document.getElementById('betaling-sublabel');
  sublabel.textContent = info.sublabel;
  sublabel.classList.toggle('is-gelukt', status === 'gelukt');
  document.getElementById('betaling-titel').textContent =
    typeof info.titel === 'function' ? info.titel(datum) : info.titel;
  document.getElementById('betaling-tekst').textContent = info.tekst(datum);
  document.getElementById('betaling-wacht').classList.toggle('verborgen', !info.wachten);

  // Detailrijen (datum, uren, betaald) — alleen bij een geslaagde betaling,
  // en de uren en het bedrag alleen als dit tabblad ze nog kent.
  const detailsEl = document.getElementById('betaling-details');
  detailsEl.innerHTML = '';
  if (info.details) {
    const samenvatting = leesSamenvatting(datum);
    const rijen = [['Datum', datumKort(datum)]];
    if (samenvatting) {
      let uren = `${samenvatting.startTijd}–${samenvatting.eindTijd}`;
      if (samenvatting.opbouwVanaf) uren += ` · opbouw ${samenvatting.opbouwVanaf}`;
      rijen.push(['Uren', uren]);
      rijen.push(['Betaald', `€ ${samenvatting.totaal}`]);
    }
    for (const [label, waarde] of rijen) {
      const rij = document.createElement('div');
      const labelEl = document.createElement('span');
      labelEl.textContent = label;
      const waardeEl = document.createElement('span');
      waardeEl.textContent = waarde;
      rij.append(labelEl, waardeEl);
      detailsEl.appendChild(rij);
    }
  }

  const okKnop = document.getElementById('betaling-ok-knop');
  okKnop.textContent = info.knop || 'Sluiten';
  okKnop.classList.toggle('knop-donker', Boolean(info.knopDonker));
  okKnop.classList.toggle('knop-rood', !info.knopDonker);
  document.getElementById('betaling-bel-knop').classList.toggle('verborgen', !info.bellen);
  document.getElementById('betaling-knoppen').classList.toggle('verborgen', !info.sluitbaar);
  if (!betalingDialoogEl.open) betalingDialoogEl.showModal();
}

// Na terugkeer van de Mollie-betaalpagina: kijken of de betaling gelukt is.
// De webhook kan een paar seconden achterlopen, dus we kijken zo nodig
// een aantal keer opnieuw. De dialoog opent meteen, zodat de bezoeker nooit
// op een "lege" kalender belandt zonder te weten of de betaling gelukt is.
async function verwerkBetalingsTerugkeer(datum) {
  toonBetalingsDialoog('controle', datum);
  for (let poging = 0; poging < 15; poging++) {
    const rij = await opslag.haalStatus(datum);
    if (rij === null) {
      toonBetalingsDialoog('mislukt', datum);
      return;
    }
    if (rij && (rij.status || STATUS_BETAALD) === STATUS_BETAALD) {
      toonBetalingsDialoog('gelukt', datum);
      return;
    }
    await new Promise((klaar) => setTimeout(klaar, 2000));
  }
  toonBetalingsDialoog('verwerking', datum);
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
  document.getElementById('verder-knop').addEventListener('click', volgendeStap);
  document.getElementById('terug-knop').addEventListener('click', () => toonStap(huidigeStap - 1));
  document.getElementById('betaling-ok-knop').addEventListener('click', () => betalingDialoogEl.close());
  // Vangt ook sluiten via Esc af, niet alleen via de annuleerknop. De
  // gekozen dag licht dan niet langer op in de kalender.
  dialoogEl.addEventListener('close', () => {
    stopTypeFeestAnimatie();
    geselecteerdeDatum = null;
    renderKalender();
  });
  formulierEl.addEventListener('submit', verwerkFormulier);
  document.getElementById('start-tijd').addEventListener('change', () => {
    werkEindTijdenBij();
    werkOpbouwHintBij();
  });
  for (const radio of formulierEl.querySelectorAll('input[name="opbouwMinuten"]')) {
    radio.addEventListener('change', werkOpbouwHintBij);
  }
  // Eén gedelegeerde listener voor alle extra opties.
  document.querySelector('.extra-opties').addEventListener('input', werkTotaalBij);
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
      `Live bijgewerkt om ${new Date().toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })}`;
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
