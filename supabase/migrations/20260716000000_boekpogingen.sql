-- Bescherming tegen misbruik van de reserveerfunctie: wie in korte tijd veel
-- boekingspogingen doet vanaf hetzelfde IP-adres, wordt tijdelijk geweigerd.
-- Zonder deze rem kan een kwaadwillende met een simpel script alle vrije
-- datums 30 minuten "geel" zetten en dat eindeloos herhalen, waardoor niemand
-- meer kan boeken.
--
-- Privacy: IP-adressen worden uitsluitend hiervoor bewaard en na 24 uur
-- automatisch opgeruimd (gerechtvaardigd belang: fraude-/misbruikpreventie).

create table if not exists public.boekpogingen (
  id bigint generated always as identity primary key,
  ip text not null,
  aangemaakt_op timestamptz not null default now()
);

create index if not exists boekpogingen_ip_tijd
  on public.boekpogingen (ip, aangemaakt_op);

-- RLS aan zonder policies: alleen de service-rol (edge functions) kan erbij.
alter table public.boekpogingen enable row level security;

-- Registreert één boekingspoging en zegt of die is toegestaan.
-- Max. 10 pogingen per IP per uur; oudere registraties dan 24 uur worden
-- bij elke aanroep opportunistisch opgeruimd.
create or replace function public.registreer_boekpoging(p_ip text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_aantal int;
begin
  delete from boekpogingen where aangemaakt_op < now() - interval '24 hours';

  select count(*) into v_aantal
  from boekpogingen
  where ip = p_ip
    and aangemaakt_op > now() - interval '1 hour';

  if v_aantal >= 10 then
    return false;
  end if;

  insert into boekpogingen (ip) values (p_ip);
  return true;
end;
$$;

-- Alleen de server (edge functions met service-rol) mag dit aanroepen.
revoke execute on function public.registreer_boekpoging(text)
  from public, anon, authenticated;
grant execute on function public.registreer_boekpoging(text)
  to service_role;
