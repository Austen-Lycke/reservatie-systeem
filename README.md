# Reserveringssysteem Privéfeesten

Een webapp waarmee bezoekers via een kalender een datum reserveren voor een privéfeest
en meteen online de reservatiekosten betalen.

**Spelregels van het systeem:**
- Maximaal **1 feest per dag** — dubbele boekingen zijn technisch onmogelijk.
- Vrije starttijd, eindtijd **uiterlijk 02:00 's nachts**.
- Bezoekers kunnen tot **1,5 uur vóór de starttijd** komen om in te richten.
- **€ 60 reservatiekosten**, direct online te betalen via Mollie (o.a. Bancontact).
  Niet terugbetaalbaar, behalve wanneer de organisatie zelf annuleert.
- Tijdens het betalen staat de datum **30 minuten** vast (geel); wordt er niet
  betaald, dan komt de datum vanzelf weer vrij.
- De organisatie behoudt het recht om achteraf te weigeren; dan wordt het
  volledige bedrag teruggestort.
- **Realtime**: zodra iemand reserveert of betaalt, ziet iedereen dat direct.

**Kleuren in de kalender:**
| Kleur | Betekenis |
|---|---|
| 🟩 Groen | Beschikbaar — klik om te reserveren |
| 🟥 Rood | Bezet (betaald) |
| 🟨 Geel | Iemand is deze datum nu aan het betalen (max. 30 min) |
| ⬜ Grijs | Niet beschikbaar (datum is voorbij) |

---

## Direct uitproberen (demo-modus)

Zolang Supabase nog niet is ingesteld, draait de app in **demo-modus**:
reserveringen worden alleen lokaal in je browser opgeslagen en de betaalstap
wordt overgeslagen. Start een lokale webserver in deze map:

```bash
python3 -m http.server 4173
```

Open daarna http://localhost:4173 in je browser.

---

## Live gaan — deel 1: Supabase koppelen aan GitHub

1. Ga naar https://supabase.com en maak een account aan.
2. Klik **New project**, kies een naam en een regio in Europa (bijv. *West EU*).
3. Koppel deze GitHub-repository: **Project Settings → Integrations → GitHub →
   Connect**. Kies de repo, laat *Working directory* op `.` staan, zet
   *Deploy to production* aan met branch `main`, en klik **Enable integration**.
   Vanaf nu voert Supabase bij elke push naar `main` automatisch uit:
   - het databaseschema uit [`supabase/migrations/`](supabase/migrations/)
     (tabellen, beveiligingsregels, reserveringsfunctie, realtime);
   - de twee edge functions uit [`supabase/functions/`](supabase/functions/).
4. Controleer na de eerste deploy onder **Edge Functions** dat `reserveer` en
   `mollie-webhook` bestaan en dat bij beide **Verify JWT** UIT staat (dat hoort
   automatisch te volgen uit `supabase/config.toml`; zet het anders handmatig uit,
   anders kan Mollie de webhook niet bereiken).
   *(Geen zin in de GitHub-koppeling? Alles kan ook handmatig: plak de inhoud
   van het migratiebestand in de SQL Editor en maak de functies aan via
   Edge Functions → Deploy a new function.)*
5. Ga naar **Project Settings → API** en kopieer de **Project URL** en de
   **anon public**-sleutel naar [`supabase-config.js`](supabase-config.js).

## Live gaan — deel 2: Mollie (betalingen)

De betaallogica draait in de edge functions, zodat de geheime Mollie-sleutel
nooit in de browser of in GitHub terechtkomt.

6. Haal de API-sleutels op uit het Mollie-dashboard (https://my.mollie.com):
   **Developers → API keys**. Begin met de **Test API key** (`test_...`).
7. Zet in Supabase de geheimen klaar: **Edge Functions → Secrets**, en voeg toe:
   - `MOLLIE_API_KEY` = je Mollie-sleutel (eerst `test_...`, later `live_...`)
   - `SITE_URL` = het adres van deze reserveringspagina
     (tijdens het testen: `http://localhost:4173`; live: het echte adres)
8. Herlaad de reserveringspagina en maak een testreservering. Met de testsleutel
   opent Mollie een oefen-betaalpagina waar je zelf kiest of de betaling "slaagt"
   of "mislukt" — er wordt niets echt afgeschreven. Controleer:
   - betaling geslaagd → dag wordt rood, ook in andere open browsers;
   - betaling geannuleerd → dag komt (vrijwel) direct weer vrij.
9. Werkt alles? Vervang dan `MOLLIE_API_KEY` door de **Live API key** en zet
   `SITE_URL` op het echte adres. Let op: Mollie moet je website eerst
   goedkeuren voordat live betalen werkt (de site moet tonen wat je verkoopt,
   met prijs, voorwaarden en contactgegevens).

## Live gaan — deel 3: e-mail bij elke bevestigde reservatie

Zodra een betaling slaagt, stuurt het systeem automatisch een e-mail naar
**info@8-duust.be** met alle reservatiegegevens (naam, datum, type feest, uren,
aantal personen, opbouwtijd, opmerkingen, contactgegevens en het
Mollie-betalingsnummer). Antwoorden op die mail gaat rechtstreeks naar de boeker
(het e-mailadres van de klant staat als reply-to ingesteld).

Hiervoor wordt [Resend](https://resend.com) gebruikt (gratis tot 3.000 mails
per maand — ruim voldoende):

10. Maak een gratis account aan op https://resend.com — **gebruik daarbij
    info@8-duust.be als accountadres**. Zolang je geen eigen domein verifieert,
    mag Resend namelijk alleen mailen naar het adres van je eigen account —
    en dat is precies waar de mails naartoe moeten.
11. Maak in Resend een **API key** aan (API Keys → Create API Key) en voeg die
    in Supabase toe als secret: **Edge Functions → Secrets** →
    `RESEND_API_KEY` = `re_...`
12. Maak een testreservering met de Mollie-testsleutel en kies "betaling
    geslaagd" — binnen enkele seconden valt de mail binnen op info@8-duust.be.
    Komt er niets aan? Kijk in Supabase onder **Edge Functions →
    mollie-webhook → Logs**.
13. *(Optioneel, maar netter)*: verifieer het domein `8-duust.be` in Resend
    (**Domains → Add Domain**; je krijgt een paar DNS-records om bij je
    domeinbeheerder toe te voegen). Voeg daarna in Supabase het secret
    `EMAIL_AFZENDER` toe, bijv. `Reservaties <reservaties@8-duust.be>`.
    De mails komen dan van je eigen domein in plaats van `onboarding@resend.dev`
    en belanden minder snel in spam.

Zonder `RESEND_API_KEY` blijft alles gewoon werken — er wordt dan alleen geen
mail gestuurd (dit staat dan als melding in de logs van de webhook).

### Beheer

- **Reserveringen bekijken**: Supabase → **Table Editor** → `reservering_details`
  (naam, e-mail, telefoon, tijden, opmerkingen én het Mollie-betalingsnummer).
- **Reservering weigeren/annuleren** (de enige situatie waarin terugbetaald wordt):
  1. Zoek de betaling op in het **Mollie-dashboard** (het betalingsnummer staat
     in `reservering_details`) en klik **Refund** — het volledige bedrag gaat
     terug naar de boeker.
  2. Verwijder in Supabase (`reserveringen`) de rij van die datum — de details
     gaan automatisch mee weg en de dag kleurt bij iedereen direct weer groen.
  3. Verwittig de boeker zelf even per e-mail of telefoon.
- Een gele dag hoef je nooit zelf op te ruimen: die wordt vanzelf rood (betaald)
  of komt na maximaal 30 minuten weer vrij.

### De app online zetten

De app zelf is puur statisch (HTML/CSS/JS): host de bestanden op Netlify, Vercel,
GitHub Pages of bij je eigen provider. De site draait los van 8-duust.be
(JouwWeb kan geen eigen code hosten); zet op 8-duust.be een knop "Reserveren"
die naar deze pagina linkt. Mooiste resultaat: een subdomein zoals
`reserveren.8-duust.be` dat naar deze app wijst. Vergeet niet `SITE_URL`
(stap 6) op het definitieve adres te zetten.

---

## Bestanden

| Bestand | Doel |
|---|---|
| `index.html` | Pagina met kalender en reserveringsformulier |
| `app.js` | Kalender, validatie, realtime, betaalflow |
| `style.css` | Basisopmaak (bewust simpel gehouden) |
| `supabase-config.js` | Hier plak je jouw Supabase-URL en anon-sleutel |
| `supabase/migrations/` | Databaseschema + beveiligingsregels (automatisch toegepast via GitHub) |
| `supabase/functions/reserveer/` | Edge function: datum vastzetten + Mollie-betaling starten |
| `supabase/functions/mollie-webhook/` | Edge function: betaling bevestigen of datum vrijgeven + e-mail naar info@8-duust.be |
| `supabase/config.toml` | Functie-instellingen voor de Supabase CLI |

## Hoe het betalen werkt (en waarom het veilig is)

1. De bezoeker vult het formulier in en klikt "Reserveren en € 60 betalen".
2. De edge function zet de datum 30 minuten vast (geel) en vraagt Mollie om een
   betaling van € 60 — het bedrag staat op de server en is dus niet te manipuleren.
3. De bezoeker rekent af op de beveiligde betaalpagina van Mollie (wij zien of
   bewaren dus nooit bankgegevens).
4. Mollie meldt het resultaat aan de webhook-functie: geslaagd → de dag wordt
   definitief rood; mislukt/geannuleerd/verlopen → de dag komt weer vrij.
5. De geheime Mollie-sleutel bestaat alleen als Supabase-secret en staat nergens
   in de website-code.

Dubbele boekingen blijven onmogelijk: de datum is de primaire sleutel in de
database, dus ook als twee mensen tegelijk klikken kan er maar één de datum
vastzetten — de ander krijgt meteen een nette melding.

## Privacy

Bezoekers zien alleen **welke dagen bezet of in behandeling zijn** — nooit wie er
geboekt heeft. Persoonsgegevens staan in een aparte tabel die door Row Level
Security volledig is afgeschermd; alleen jij kunt ze zien via het Supabase-dashboard.
