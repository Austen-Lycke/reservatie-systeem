-- Reserveringssysteem privéfeesten: volledige databaseopzet.
-- Wordt automatisch uitgevoerd door de Supabase GitHub-integratie.
-- Alles hieronder is her-uitvoerbaar: het script werkt zowel op een lege
-- database als op een project waar een eerdere versie al handmatig draaide.
--
-- Opzet:
-- - "reserveringen": publiek zichtbaar, bevat alleen datum + status (geen
--   persoonsgegevens). De datum is de primaire sleutel, dus dubbele boekingen
--   zijn op databaseniveau onmogelijk. status = 'in_afwachting' (geel:
--   betaling gestart, vervalt na 30 min) of 'betaald' (rood).
-- - "reservering_details": contactgegevens van de boeker. NIET publiek leesbaar.
-- - "maak_reservering": zet een datum 30 minuten vast terwijl de klant betaalt.
--   Alleen aanroepbaar door de server (edge functions), niet door bezoekers.

create table if not exists public.reserveringen (
  datum date primary key,
  status text not null default 'in_afwachting'
    check (status in ('in_afwachting', 'betaald')),
  verloopt_op timestamptz,
  aangemaakt_op timestamptz not null default now()
);

create table if not exists public.reservering_details (
  datum date primary key references public.reserveringen (datum) on delete cascade,
  naam text not null,
  email text not null,
  telefoon text not null,
  aantal_personen int,
  start_tijd text not null,
  eind_tijd text not null,
  opbouw_minuten int not null default 0 check (opbouw_minuten between 0 and 90),
  opbouw_vanaf text,
  opmerkingen text,
  mollie_betaling_id text,
  aangemaakt_op timestamptz not null default now()
);

-- Upgrade vanaf de eerste versie (zonder betalingen): ontbrekende kolommen
-- toevoegen. Bestaande reserveringen golden toen als definitief ('betaald').
alter table public.reserveringen
  add column if not exists status text not null default 'betaald'
    check (status in ('in_afwachting', 'betaald')),
  add column if not exists verloopt_op timestamptz;

alter table public.reservering_details
  add column if not exists mollie_betaling_id text;

-- Row Level Security: bezoekers (anon) mogen alleen zien welke dagen bezet zijn.
alter table public.reserveringen enable row level security;
alter table public.reservering_details enable row level security;

drop policy if exists "Iedereen mag bezette dagen zien" on public.reserveringen;
create policy "Iedereen mag bezette dagen zien"
  on public.reserveringen
  for select
  using (true);

-- Geen enkele policy op reservering_details: persoonsgegevens zijn dus
-- onleesbaar en onbewerkbaar voor bezoekers. Jij leest ze via het dashboard;
-- de edge functions schrijven ze met de service-rol.

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
  -- Eindtijd: ná de starttijd (zelfde dag) of uiterlijk 02:00 (na middernacht).
  if not (p_eind_tijd > p_start_tijd or p_eind_tijd <= '02:00') then
    raise exception 'De eindtijd moet na de starttijd liggen, of uiterlijk 02:00.';
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
    (datum, naam, email, telefoon, aantal_personen,
     start_tijd, eind_tijd, opbouw_minuten, opbouw_vanaf, opmerkingen)
  values
    (p_datum, trim(p_naam), trim(p_email), trim(p_telefoon), p_aantal_personen,
     p_start_tijd, p_eind_tijd, p_opbouw_minuten, p_opbouw_vanaf, p_opmerkingen);

exception
  when unique_violation then
    -- De datum bestond al: iemand anders was nét eerder (of betaalt nu).
    raise exception 'BEZET';
end;
$$;

-- Alleen de server (edge functions met service-rol) mag reserveren;
-- bezoekers kunnen deze functie niet rechtstreeks aanroepen.
revoke execute on function public.maak_reservering(date, text, text, text, int, text, text, int, text, text)
  from public, anon, authenticated;
grant execute on function public.maak_reservering(date, text, text, text, int, text, text, int, text, text)
  to service_role;

-- Realtime aanzetten voor de kalender: elke wijziging in "reserveringen"
-- wordt direct naar alle open browsers gestuurd.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'reserveringen'
  ) then
    alter publication supabase_realtime add table public.reserveringen;
  end if;
end $$;
