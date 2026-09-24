-- SF4 (docs/work/pricing-service-fee-plan.md) : sortir orders.price_cents du mécanisme de
-- colonne générée (une colonne générée ne peut pas lire une table de config mutable comme
-- pricing_settings) et préparer le stockage des montants financiers du nouveau modèle
-- (delivery_cents / service_fee_cents). Zéro changement de comportement pour price_cents :
-- même formule, mêmes valeurs, désormais lue depuis pricing_settings au lieu de littéraux
-- SQL en dur. delivery_cents/service_fee_cents restent NULL pour toute nouvelle commande tant
-- que SF5 (calcul applicatif, Codex) ne les alimente pas ; aucune donnée existante modifiée.

-- 1. price_cents quitte le mode généré, conserve les valeurs déjà stockées pour les
--    commandes existantes (DROP EXPRESSION ne réécrit aucune ligne).
alter table public.orders alter column price_cents drop expression;
alter table public.orders alter column price_cents set not null;

-- 2. Nouvelles colonnes du modèle cible, non alimentées à cette étape.
alter table public.orders add column delivery_cents integer null check (delivery_cents >= 0);
alter table public.orders add column service_fee_cents integer null check (service_fee_cents >= 0);
alter table public.orders add column pricing_rule_version integer null
  references public.pricing_settings(rule_version);

-- 3. price_cents et pricing_rule_version calculés à la création, depuis le réglage tarifaire
--    le plus récent (rule_version maximal). Reproduit exactement l'ancienne expression générée
--    (supabase/migrations/0001_init.sql:54-59) à paramètres identiques.
create function public.compute_order_price_cents() returns trigger language plpgsql set search_path = '' as $$
declare active record;
begin
  select rule_version, pickup_fee_cents, km_rate_cents, minute_rate_cents, minimum_delivery_cents
    into active
    from public.pricing_settings
    order by rule_version desc
    limit 1;
  if not found then
    raise exception 'aucun réglage tarifaire disponible (pricing_settings vide)';
  end if;
  new.price_cents := greatest(
    active.minimum_delivery_cents::bigint,
    active.pickup_fee_cents::bigint
      + (new.distance_m::bigint * active.km_rate_cents) / 1000
      + (new.duration_s::bigint * active.minute_rate_cents) / 60
  )::integer;
  new.pricing_rule_version := active.rule_version;
  return new;
end;
$$;
revoke execute on function public.compute_order_price_cents() from anon, authenticated, public;
create trigger orders_compute_price
  before insert on public.orders
  for each row execute function public.compute_order_price_cents();

-- 4. Étend l'immuabilité déjà en vigueur (0034_order_pricing_immutability.sql) :
--    - price_cents / pricing_rule_version : calculés une fois à l'insertion par le trigger
--      ci-dessus, jamais modifiables ensuite (même régime que distance_m/duration_s).
--    - delivery_cents / service_fee_cents : NULL à l'insertion, une seule transition
--      légitime NULL -> valeur autorisée (même régime que driver_earning_cents), peu importe
--      le moment où cette transition survient (SF5 choisit son point d'écriture).
create or replace function public.guard_order_pricing_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.distance_m is distinct from old.distance_m or new.duration_s is distinct from old.duration_s then
    raise exception 'distance_m et duration_s d’une commande sont immuables';
  end if;
  if new.price_cents is distinct from old.price_cents then
    raise exception 'price_cents est immuable après son initialisation';
  end if;
  if new.pricing_rule_version is distinct from old.pricing_rule_version then
    raise exception 'pricing_rule_version est immuable après son initialisation';
  end if;
  if new.driver_earning_cents is distinct from old.driver_earning_cents
     and not (old.driver_earning_cents = 0 and new.driver_earning_cents = old.price_cents) then
    raise exception 'driver_earning_cents est immuable après son initialisation';
  end if;
  if new.delivery_cents is distinct from old.delivery_cents
     and not (old.delivery_cents is null and new.delivery_cents is not null) then
    raise exception 'delivery_cents est immuable après son initialisation';
  end if;
  if new.service_fee_cents is distinct from old.service_fee_cents
     and not (old.service_fee_cents is null and new.service_fee_cents is not null) then
    raise exception 'service_fee_cents est immuable après son initialisation';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_order_pricing_immutable() from anon, authenticated, public;

drop trigger orders_pricing_immutable on public.orders;
create trigger orders_pricing_immutable
  before update of
    distance_m, duration_s, price_cents, pricing_rule_version,
    driver_earning_cents, delivery_cents, service_fee_cents
  on public.orders
  for each row execute function public.guard_order_pricing_immutable();
