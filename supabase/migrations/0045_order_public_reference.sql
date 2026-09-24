-- Étape 2 (docs/work/invoicing-preparation-plan.md) : référence humaine de livraison. Distincte de
-- orders.id (UUID technique interne) et de orders.tracking_token (secret d'accès au suivi public, migration
-- 0014) : cette colonne ne donne accès à rien, elle sert uniquement d'affichage/support/traçabilité.
-- 8 chiffres, générée en base (jamais côté application, jamais fournie par le client), unique, immuable une
-- fois attribuée, jamais réattribuée après annulation.

alter table public.orders add column public_reference text null;

-- Candidat à 8 chiffres (00000000-99999999, zero-paddé pour préserver l'entropie complète). La contrainte
-- unique posée plus bas reste la seule garantie réelle d'unicité ; cette boucle ne fait que réduire la
-- probabilité de collision au moment de la génération.
create function public.generate_order_public_reference() returns text language plpgsql set search_path = '' as $$
declare
  candidate text;
  attempt int := 0;
begin
  loop
    candidate := lpad((floor(random() * 100000000))::bigint::text, 8, '0');
    attempt := attempt + 1;
    exit when not exists (select 1 from public.orders where public_reference = candidate);
    if attempt > 30 then
      raise exception 'unable to generate a unique order public_reference after % attempts', attempt;
    end if;
  end loop;
  return candidate;
end;
$$;
revoke execute on function public.generate_order_public_reference() from anon, authenticated, public;

-- Rétro-attribution des commandes existantes (aucune sur une base fraîche) : une passe par ligne, même
-- mécanisme que la génération future, pour qu'aucune commande ne reste sans référence.
do $$
declare r record;
begin
  for r in select id from public.orders where public_reference is null loop
    update public.orders set public_reference = public.generate_order_public_reference() where id = r.id;
  end loop;
end;
$$;

alter table public.orders alter column public_reference set not null;
alter table public.orders add constraint orders_public_reference_format_check check (public_reference ~ '^[0-9]{8}$');
alter table public.orders add constraint orders_public_reference_key unique (public_reference);

-- Génération automatique à chaque création : écrase systématiquement toute valeur reçue par ailleurs (elle
-- ne peut de toute façon jamais provenir du client, aucun schéma d'entrée n'expose ce champ).
create function public.set_order_public_reference() returns trigger language plpgsql set search_path = '' as $$
begin
  new.public_reference := public.generate_order_public_reference();
  return new;
end;
$$;
revoke execute on function public.set_order_public_reference() from anon, authenticated, public;
create trigger orders_set_public_reference
  before insert on public.orders
  for each row execute function public.set_order_public_reference();

-- Immuable une fois attribuée (même régime que distance_m/duration_s/price_cents, voir
-- guard_order_pricing_immutable, 0043_settlement_ledger_additive_model.sql).
create function public.guard_order_public_reference_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.public_reference is distinct from old.public_reference then
    raise exception 'public_reference d’une commande est immuable';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_order_public_reference_immutable() from anon, authenticated, public;
create trigger orders_public_reference_immutable
  before update of public_reference on public.orders
  for each row execute function public.guard_order_public_reference_immutable();
