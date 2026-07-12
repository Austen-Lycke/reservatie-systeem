-- Extra opties (foodtruck, drankkaarten, muziek, springkasteel, ...) bij de
-- reservering opslaan, plus het totaalbedrag dat via Mollie betaald werd.
-- De extra's gaan als jsonb-snapshot de database in: { keuzes, prijsregels }.
-- De prijsregels bevatten de bedragen zoals ze op het boekingsmoment golden,
-- zodat een latere prijswijziging oude reserveringen niet verandert.

alter table public.reservering_details
  add column if not exists extra_opties jsonb,
  add column if not exists totaal_bedrag numeric(8,2);

-- De functie krijgt extra parameters, dus de oude signatuur eerst weg
-- (anders ontstaat er een tweede overload naast de oude).
drop function if exists public.maak_reservering(date, text, text, text, int, text, text, int, text, text, text);

create or replace function public.maak_reservering(
  p_datum date,
  p_naam text,
  p_email text,
  p_telefoon text,
  p_aantal_personen int,
  p_start_tijd text,
  p_eind_tijd text,
  p_opbouw_minuten int,
  p_opbouw_vanaf text,
  p_opmerkingen text,
  p_type_feest text default null,
  p_extra_opties jsonb default null,
  p_totaal_bedrag numeric default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_naam is null or length(trim(p_naam)) = 0 then
    raise exception 'Naam is verplicht.';
  end if;
  if p_email is null or length(trim(p_email)) = 0 then
    raise exception 'E-mailadres is verplicht.';
  end if;
  if p_telefoon is null or length(trim(p_telefoon)) = 0 then
    raise exception 'Telefoonnummer is verplicht.';
  end if;
  if p_datum < current_date then
    raise exception 'Deze datum is voorbij.';
  end if;
  if p_aantal_personen is null or p_aantal_personen < 25 or p_aantal_personen > 500 then
    raise exception 'Reserveren kan vanaf minimaal 25 personen (maximaal 500).';
  end if;
  if p_opbouw_minuten < 0 or p_opbouw_minuten > 90 then
    raise exception 'Opbouwtijd mag maximaal 1,5 uur (90 minuten) zijn.';
  end if;
  -- Eindtijd: ná de starttijd (zelfde dag) of uiterlijk 02:00 (na middernacht).
  if not (p_eind_tijd > p_start_tijd or p_eind_tijd <= '02:00') then
    raise exception 'De eindtijd moet na de starttijd liggen, of uiterlijk 02:00.';
  end if;
  -- Het totaal is minstens de reservatiekosten van € 60; de bovengrens is een
  -- vangnet tegen rekenfouten of gemanipuleerde aanvragen.
  if p_totaal_bedrag is not null and (p_totaal_bedrag < 60 or p_totaal_bedrag > 50000) then
    raise exception 'Ongeldig totaalbedrag.';
  end if;

  -- Een verlopen, onbetaalde reservering op deze datum eerst opruimen.
  delete from reserveringen
  where datum = p_datum
    and status = 'in_afwachting'
    and verloopt_op <= now();

  -- Datum 30 minuten vastzetten terwijl de klant betaalt.
  insert into reserveringen (datum, status, verloopt_op)
  values (p_datum, 'in_afwachting', now() + interval '30 minutes');

  insert into reservering_details
    (datum, naam, email, telefoon, type_feest, aantal_personen,
     start_tijd, eind_tijd, opbouw_minuten, opbouw_vanaf, opmerkingen,
     extra_opties, totaal_bedrag)
  values
    (p_datum, trim(p_naam), trim(p_email), trim(p_telefoon), nullif(trim(p_type_feest), ''),
     p_aantal_personen, p_start_tijd, p_eind_tijd, p_opbouw_minuten, p_opbouw_vanaf, p_opmerkingen,
     p_extra_opties, p_totaal_bedrag);

exception
  when unique_violation then
    -- De datum bestond al: iemand anders was nét eerder (of betaalt nu).
    raise exception 'BEZET';
end;
$$;

-- Alleen de server (edge functions met service-rol) mag reserveren;
-- bezoekers kunnen deze functie niet rechtstreeks aanroepen.
revoke execute on function public.maak_reservering(date, text, text, text, int, text, text, int, text, text, text, jsonb, numeric)
  from public, anon, authenticated;
grant execute on function public.maak_reservering(date, text, text, text, int, text, text, int, text, text, text, jsonb, numeric)
  to service_role;
