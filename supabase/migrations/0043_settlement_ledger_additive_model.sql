-- SF6 (docs/work/pricing-service-fee-plan.md) : le grand livre de règlement passe du modèle
-- "gain livreur - frais = dû" au modèle "livraison + frais de service = dû restaurant, livreur
-- reçoit 100% de la livraison, Locadely reçoit 100% du frais de service". Les lignes de
-- règlement recopient désormais des montants DÉJÀ FIGÉS sur la commande
-- (orders.delivery_cents / orders.service_fee_cents / orders.pricing_rule_version, posés par
-- SF5) : plus aucun taux n'est recalculé au moment de la clôture.
-- Tables vides sur toute base réelle (go_live_at jamais posé avant cette étape) : aucune
-- donnée historique à migrer, changement de schéma direct via ALTER (jamais de réécriture
-- des migrations 0030/0034 déjà appliquées).

-- 1. settlement_lines : retire l'ancien modèle soustractif, ajoute le modèle additif.
alter table public.settlement_lines drop column net_cents;
alter table public.settlement_lines drop column fee_cents;
alter table public.settlement_lines drop column fee_rate_bps;
alter table public.settlement_lines drop column driver_earning_cents;
alter table public.settlement_lines drop column merchant_amount_cents;
alter table public.settlement_lines rename column fee_rule_version to pricing_rule_version;
alter table public.settlement_lines rename constraint settlement_lines_fee_rule_version_check to settlement_lines_pricing_rule_version_check;

alter table public.settlement_lines add column delivery_cents bigint not null check (delivery_cents >= 0);
alter table public.settlement_lines add column service_fee_cents bigint not null check (service_fee_cents >= 0);
-- Conserve le nom historique : toujours "ce que coûte cette commande au restaurant", désormais
-- livraison + service au lieu du seul prix de livraison. Colonne générée : jamais insérée
-- directement (même contrainte que orders.price_cents depuis SF4).
alter table public.settlement_lines add column merchant_amount_cents bigint
  generated always as (delivery_cents + service_fee_cents) stored;

-- 2. settlement_statements : due_cents devient le plein montant dû au livreur (aucune
-- soustraction), plus de gross/fee séparés.
alter table public.settlement_statements drop column gross_cents;
alter table public.settlement_statements drop column fee_cents;
alter table public.settlement_statements add constraint settlement_statements_due_cents_check check (due_cents >= 0);

-- 2bis. Le garde d'immuabilité du statement (0030_settlement_core.sql) comparait aussi
-- gross_cents/fee_cents, désormais supprimés : redéfini sans eux (identité + due_cents).
create or replace function public.guard_settlement_statement() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.period_id,new.driver_id,new.merchant_id,new.merchant_settlement_id,new.due_cents) is distinct from (old.period_id,old.driver_id,old.merchant_id,old.merchant_settlement_id,old.due_cents) then
    raise exception 'les identifiants et montants d’un statement sont immuables';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_settlement_statement() from anon, authenticated, public;

-- 3. merchant_settlements : garde amount_cents (montant réellement débité, inchangé dans son
-- rôle — R50 continue à débiter "ce montant", sans changement) et ajoute la décomposition
-- traçable exigée par ADR 0005 / futur F10 : part livreur, part Locadely.
alter table public.merchant_settlements add column driver_amount_cents bigint not null default 0 check (driver_amount_cents >= 0);
alter table public.merchant_settlements add column service_fee_cents bigint not null default 0 check (service_fee_cents >= 0);
alter table public.merchant_settlements alter column driver_amount_cents drop default;
alter table public.merchant_settlements alter column service_fee_cents drop default;
alter table public.merchant_settlements add constraint merchant_settlements_amount_split_check
  check (amount_cents = driver_amount_cents + service_fee_cents);

-- 4. Lignes figées : recopient orders.delivery_cents/service_fee_cents/pricing_rule_version,
-- jamais orders.price_cents/driver_earning_cents (ancien modèle). Refuse explicitement une
-- commande sans montants figés (créée avant SF5, ne peut structurellement pas être réglée
-- sous le nouveau modèle) plutôt que de silencieusement mal régler.
create or replace function public.guard_settlement_line() returns trigger language plpgsql set search_path = '' as $$
declare p record; o record; configured_go_live_at timestamptz;
begin
  if tg_op in ('UPDATE','DELETE') then raise exception 'les lignes de règlement sont append-only'; end if;
  select go_live_at into configured_go_live_at from public.settlement_settings where id = true;
  if configured_go_live_at is null or new.order_created_at < configured_go_live_at then raise exception 'la commande est antérieure à go_live_at ou go_live_at est absent'; end if;
  select period_start, period_end into p from public.settlement_periods where id = new.period_id;
  if not found or new.finalized_at < p.period_start or new.finalized_at >= p.period_end then raise exception 'la finalisation doit appartenir à la période demi-ouverte'; end if;
  select merchant_id, driver_id, status::text, created_at, delivery_cents, service_fee_cents, pricing_rule_version, completed_at,
    (select min(created_at) from public.order_events where order_id = new.order_id and to_status = 'RETURNED') as returned_at
  into o from public.orders where id = new.order_id;
  if not found then raise exception 'la commande n’existe pas'; end if;
  if o.delivery_cents is null or o.service_fee_cents is null or o.pricing_rule_version is null then
    raise exception 'la commande n’a pas de montants de tarification figés (antérieure au modèle SF5) et ne peut pas être réglée';
  end if;
  if o.merchant_id <> new.merchant_id or o.driver_id <> new.driver_id or o.status <> new.final_status or o.created_at <> new.order_created_at
     or o.delivery_cents <> new.delivery_cents or o.service_fee_cents <> new.service_fee_cents or o.pricing_rule_version <> new.pricing_rule_version then
    raise exception 'la commande ne correspond pas au livreur, restaurant, statut final ou snapshot';
  end if;
  if new.final_status = 'COMPLETED' and (o.completed_at is null or new.finalized_at <> o.completed_at) then raise exception 'la finalisation COMPLETED doit correspondre à completed_at'; end if;
  if new.final_status = 'RETURNED' and (o.returned_at is null or new.finalized_at <> o.returned_at) then raise exception 'la finalisation RETURNED doit correspondre à son événement'; end if;
  return new;
end;
$$;
revoke execute on function public.guard_settlement_line() from anon, authenticated, public;

-- 5. Contraintes différées : totaux lignes -> statement (due_cents = Σ delivery_cents) et
-- statement -> règlement restaurant (amount_cents, driver_amount_cents, service_fee_cents).
create or replace function public.assert_settlement_ledger_values(statement_to_check uuid) returns void language plpgsql set search_path = '' as $$
declare s record; lines_due bigint; settlement_amount bigint; settlement_driver_amount bigint; settlement_service_fee bigint;
begin
  select * into s from public.settlement_statements where id = statement_to_check;
  if not found then return; end if;
  select coalesce(sum(delivery_cents),0) into lines_due from public.settlement_lines where statement_id = s.id;
  if s.due_cents <> lines_due then raise exception 'le montant dû du statement ne correspond pas à ses lignes'; end if;
  select coalesce(sum(l.merchant_amount_cents),0), coalesce(sum(l.delivery_cents),0), coalesce(sum(l.service_fee_cents),0)
    into settlement_amount, settlement_driver_amount, settlement_service_fee
    from public.settlement_lines l join public.settlement_statements st on st.id=l.statement_id where st.merchant_settlement_id=s.merchant_settlement_id;
  if (select amount_cents from public.merchant_settlements where id=s.merchant_settlement_id) <> settlement_amount then raise exception 'le montant du règlement restaurant ne correspond pas à ses statements'; end if;
  if (select driver_amount_cents from public.merchant_settlements where id=s.merchant_settlement_id) <> settlement_driver_amount then raise exception 'la part livreur du règlement restaurant ne correspond pas à ses statements'; end if;
  if (select service_fee_cents from public.merchant_settlements where id=s.merchant_settlement_id) <> settlement_service_fee then raise exception 'la part service Locadely du règlement restaurant ne correspond pas à ses statements'; end if;
end;
$$;
revoke execute on function public.assert_settlement_ledger_values(uuid) from anon, authenticated, public;

create or replace function public.assert_merchant_settlement_ledger() returns trigger language plpgsql set search_path = '' as $$
declare st record; expected_amount bigint; expected_driver_amount bigint; expected_service_fee bigint;
begin
  select coalesce(sum(l.merchant_amount_cents),0), coalesce(sum(l.delivery_cents),0), coalesce(sum(l.service_fee_cents),0)
    into expected_amount, expected_driver_amount, expected_service_fee
    from public.settlement_statements s join public.settlement_lines l on l.statement_id=s.id
   where s.merchant_settlement_id = new.id;
  if new.amount_cents <> expected_amount then
    raise exception 'le montant du règlement restaurant ne correspond pas à ses statements';
  end if;
  if new.driver_amount_cents <> expected_driver_amount then
    raise exception 'la part livreur du règlement restaurant ne correspond pas à ses statements';
  end if;
  if new.service_fee_cents <> expected_service_fee then
    raise exception 'la part service Locadely du règlement restaurant ne correspond pas à ses statements';
  end if;
  for st in select id from public.settlement_statements where merchant_settlement_id = new.id loop perform public.assert_settlement_ledger_values(st.id); end loop;
  return null;
end;
$$;
revoke execute on function public.assert_merchant_settlement_ledger() from anon, authenticated, public;
