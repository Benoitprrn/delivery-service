-- Le règlement livreurs copie `driver_earning_cents` et `price_cents` dans des lignes figées
-- (docs/adr/0004-driver-settlement.md) : la commande ne doit plus jamais changer ce sur quoi
-- le règlement s'appuie. `distance_m` et `duration_s` (dont dérive `price_cents`) sont immuables ;
-- `driver_earning_cents` ne peut passer qu'UNE fois de son espace réservé 0 à `price_cents`
-- (le flux de création insère 0 puis recopie le prix généré par Postgres), puis est figé.
create function public.guard_order_pricing_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.distance_m is distinct from old.distance_m or new.duration_s is distinct from old.duration_s then
    raise exception 'distance_m et duration_s d’une commande sont immuables';
  end if;
  -- price_cents est une colonne générée : recalculée après les triggers BEFORE, et sans changement possible ici
  -- puisque distance_m/duration_s sont figés ; old.price_cents fait donc foi.
  if new.driver_earning_cents is distinct from old.driver_earning_cents
     and not (old.driver_earning_cents = 0 and new.driver_earning_cents = old.price_cents) then
    raise exception 'driver_earning_cents est immuable après son initialisation';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_order_pricing_immutable() from anon, authenticated, public;
create trigger orders_pricing_immutable
  before update of distance_m, duration_s, driver_earning_cents on public.orders
  for each row execute function public.guard_order_pricing_immutable();
