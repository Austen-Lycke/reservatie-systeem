-- Update-script: voer dit uit als je de EERDERE versie van supabase.sql al had
-- uitgevoerd (zonder betalingen). Voor een nieuw project gebruik je supabase.sql.
-- Plakken in: SQL Editor → New query → Run.

-- Nieuwe kolommen voor de betaalstatus.
alter table public.reserveringen
  add column if not exists status text not null default 'betaald'
    check (status in ('in_afwachting', 'betaald')),
  add column if not exists verloopt_op timestamptz;

-- Bestaande reserveringen golden als definitief, dus 'betaald' is de juiste
-- waarde voor oude rijen; nieuwe rijen krijgen hun status via maak_reservering.

alter table public.reservering_details
  add column if not exists mollie_betaling_id text;

-- Vernieuwde reserveringsfunctie: zet de datum 30 minuten vast ('in_afwachting')
-- terwijl de klant betaalt.
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
  p_opmerkingen text
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
  if p_opbouw_minuten < 0 or p_opbouw_minuten > 90 then
    raise exception 'Opbouwtijd mag maximaal 1,5 uur (90 minuten) zijn.';
  end if;
  if not (p_eind_tijd > p_start_tijd or p_eind_tijd <= '02:00') then
    raise exception 'De eindtijd moet na de starttijd liggen, of uiterlijk 02:00.';
  end if;

  delete from reserveringen
  where datum = p_datum
    and status = 'in_afwachting'
    and verloopt_op <= now();

  insert into reserveringen (datum, status, verloopt_op)
  values (p_datum, 'in_afwachting', now() + interval '30 minutes');

  insert into reservering_details
    (datum, naam, email, telefoon, aantal_personen,
     start_tijd, eind_tijd, opbouw_minuten, opbouw_vanaf, opmerkingen)
  values
    (p_datum, trim(p_naam), trim(p_email), trim(p_telefoon), p_aantal_personen,
     p_start_tijd, p_eind_tijd, p_opbouw_minuten, p_opbouw_vanaf, p_opmerkingen);

exception
  when unique_violation then
    raise exception 'BEZET';
end;
$$;

-- Bezoekers mogen deze functie niet meer rechtstreeks aanroepen;
-- reserveren loopt voortaan via de edge function (die ook de betaling start).
revoke execute on function public.maak_reservering(date, text, text, text, int, text, text, int, text, text)
  from public, anon, authenticated;
grant execute on function public.maak_reservering(date, text, text, text, int, text, text, int, text, text)
  to service_role;
