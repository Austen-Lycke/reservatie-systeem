-- Weekdagregels (maandag t/m donderdag): reserveren kan enkel tussen 10:00 en
-- 18:00, alleen voor teambuildings of vergaderingen, zonder muziek, en vanaf
-- 15 personen (vrijdag t/m zondag blijft 25). Daarnaast controleert de functie
-- voortaan ook het tijdformaat en de minimale starttijd van 10:00 — die werden
-- eerder alleen door het formulier afgedwongen.
--
-- Zelfde signatuur als voorheen; create or replace behoudt de grants.

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
declare
  v_weekdag boolean := extract(isodow from p_datum) between 1 and 4;
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
  if v_weekdag then
    if p_aantal_personen is null or p_aantal_personen < 15 or p_aantal_personen > 500 then
      raise exception 'Op maandag t/m donderdag kan je reserveren vanaf 15 personen (maximaal 500).';
    end if;
  else
    if p_aantal_personen is null or p_aantal_personen < 25 or p_aantal_personen > 500 then
      raise exception 'Reserveren kan vanaf minimaal 25 personen (maximaal 500).';
    end if;
  end if;
  if p_opbouw_minuten < 0 or p_opbouw_minuten > 90 then
    raise exception 'Opbouwtijd mag maximaal 1,5 uur (90 minuten) zijn.';
  end if;
  -- Tijden altijd als HH:MM (tekstvergelijking is anders onbetrouwbaar).
  if p_start_tijd !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or p_eind_tijd !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Ongeldige tijden.';
  end if;
  if p_start_tijd < '10:00' then
    raise exception 'Reserveren kan ten vroegste vanaf 10:00.';
  end if;
  if v_weekdag then
    -- Maandag t/m donderdag: 10:00-18:00, geen overnacht, enkel
    -- teambuildings/vergaderingen, geen muziek.
    if p_eind_tijd > '18:00' or p_eind_tijd <= p_start_tijd then
      raise exception 'Op maandag t/m donderdag kan je enkel reserveren tussen 10:00 en 18:00.';
    end if;
    if lower(trim(coalesce(p_type_feest, ''))) not in ('teambuilding', 'vergadering') then
      raise exception 'Op maandag t/m donderdag zijn enkel teambuildings en vergaderingen mogelijk.';
    end if;
    if p_extra_opties->'keuzes'->>'muziek' is not null then
      raise exception 'Op maandag t/m donderdag is muziek niet mogelijk.';
    end if;
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
