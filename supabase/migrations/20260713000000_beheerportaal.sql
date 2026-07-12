-- Beheerportaal: de twee beheerders van de organisatie mogen na inloggen
-- (Supabase Auth, magic link) de reservatiedetails lezen op beheer.html.
-- Wordt automatisch uitgevoerd door de Supabase GitHub-integratie.
--
-- Opzet:
-- - "beheerders": allowlist met e-mailadressen die toegang hebben. Staat in
--   de databank (niet in de publieke code) en is zelf voor niemand leesbaar;
--   je beheert de lijst via het dashboard (SQL-editor of Table Editor).
-- - "is_beheerder()": controleert of het e-mailadres van de ingelogde
--   gebruiker op de allowlist staat. Security definer, want de allowlist
--   zelf is door RLS onleesbaar voor gewone gebruikers.
-- - Leespolicy op "reservering_details": alleen ingelogde beheerders.
--   Er komen géén schrijf-policies: het portaal is alleen-lezen.

create table if not exists public.beheerders (
  email text primary key
);

-- RLS aan, zonder policies: de allowlist is alleen via het dashboard of de
-- service-rol te lezen en te bewerken.
alter table public.beheerders enable row level security;

-- Is de ingelogde gebruiker een beheerder? Vergelijkt hoofdletterongevoelig
-- met het e-mailadres uit het JWT. Ook rechtstreeks aanroepbaar vanuit
-- beheer.js als "heb ik toegang?"-controle.
create or replace function public.is_beheerder()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from beheerders
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke execute on function public.is_beheerder() from public, anon;
grant execute on function public.is_beheerder() to authenticated;

drop policy if exists "Beheerders mogen details lezen" on public.reservering_details;
create policy "Beheerders mogen details lezen"
  on public.reservering_details
  for select
  to authenticated
  using (public.is_beheerder());

-- De beheerders zelf toevoegen doe je eenmalig via de SQL-editor in het
-- dashboard (of door onderstaande regels in te vullen en te pushen):
-- insert into public.beheerders (email) values
--   ('persoon1@voorbeeld.be'),
--   ('persoon2@voorbeeld.be')
-- on conflict do nothing;
