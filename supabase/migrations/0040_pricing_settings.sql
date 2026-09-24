-- SF2 (docs/work/pricing-service-fee-plan.md) : réglages tarifaires configurables.
-- Append-only et versionné : changer un tarif = insérer une nouvelle ligne (rule_version+1),
-- jamais modifier une ligne existante. Chaque commande fige le rule_version utilisé à sa
-- création (0042_order_pricing_model.sql) afin qu'un changement de tarif ne recalcule jamais
-- une commande déjà créée.
create table public.pricing_settings (
  rule_version integer primary key check (rule_version > 0),
  pickup_fee_cents integer not null check (pickup_fee_cents >= 0),
  km_rate_cents integer not null check (km_rate_cents >= 0),
  minute_rate_cents integer not null check (minute_rate_cents >= 0),
  minimum_delivery_cents integer not null check (minimum_delivery_cents >= 0),
  service_fee_rate_bps integer not null default 2000 check (service_fee_rate_bps between 0 and 10000),
  created_at timestamptz not null default now()
);

-- Valeurs actuelles (ADR 0002 / ADR 0004), reprises telles quelles : aucun changement de
-- comportement tarifaire à cette étape, seule la source de vérité devient configurable.
insert into public.pricing_settings
  (rule_version, pickup_fee_cents, km_rate_cents, minute_rate_cents, minimum_delivery_cents, service_fee_rate_bps)
values
  (1, 100, 37, 22, 400, 2000);

create function public.guard_pricing_settings() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'pricing_settings est append-only : insérer une nouvelle rule_version plutôt que modifier';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_pricing_settings() from anon, authenticated, public;
create trigger pricing_settings_guard
  before update or delete on public.pricing_settings
  for each row execute function public.guard_pricing_settings();

alter table public.pricing_settings enable row level security;
revoke all privileges on table public.pricing_settings from anon, authenticated;
