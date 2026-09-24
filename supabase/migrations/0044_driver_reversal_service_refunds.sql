-- SF9.5 (docs/work/pricing-service-fee-plan.md) : remboursement proportionnel des frais de service
-- Locadely au restaurant, quand un reversal `driver_fault` récupère tout ou partie de la livraison
-- d'une commande précise. Mouvement STRICTEMENT SÉPARÉ du reversal du Transfer livreur (table dédiée,
-- jamais une extension de driver_transfer_reversals, jamais merchant_receivables/debit_incidents —
-- ces deux tables représentent une dette DU restaurant, jamais un crédit accordé PAR Locadely).
--
-- Une ligne est créée automatiquement (aucune approbation humaine séparée : conséquence déterministe
-- d'un reversal déjà approuvé) dès qu'un reversal driver_fault avec order_id atteint 'succeeded'.
-- Tout est déjà connu à cet instant (le reversal parent est terminé, reversed_cents est figé) :
-- contrairement à driver_transfer_reversals, il n'y a pas de décision en deux temps ici, tout est
-- figé dès l'insertion.

create table public.driver_reversal_service_refunds (
  id uuid primary key default gen_random_uuid(),
  driver_transfer_reversal_id uuid not null unique references public.driver_transfer_reversals(id),
  order_id uuid not null references public.orders(id),
  merchant_id uuid not null references public.merchants(id),
  debit_attempt_id uuid not null references public.debit_attempts(id),
  stripe_charge_id text not null,
  -- Instantanés figés de la commande (jamais recalculés depuis les réglages courants).
  delivery_cents bigint not null check (delivery_cents > 0),
  service_fee_cents bigint not null check (service_fee_cents >= 0),
  -- Montant cumulé déjà récupéré chez Stripe sur cette commande AVANT ce reversal (somme des
  -- reversed_cents des reversals driver_fault succeeded antérieurs sur le même order_id).
  previously_recovered_cents bigint not null check (previously_recovered_cents >= 0),
  -- Montant réellement récupéré chez Stripe par CE reversal, attribué à cette commande et plafonné
  -- à ce qu'il reste de delivery_cents (jamais > 100% recouvré, même si le Transfer d'origine
  -- couvrait plusieurs commandes) : décision applicative, vérifiée ici par construction de la formule.
  reversed_cents bigint not null check (reversed_cents > 0),
  -- Remboursement CUMULATIF : évite la dérive d'arrondi sur plusieurs reversals partiels du même ordre.
  refund_cents bigint not null check (refund_cents >= 0 and refund_cents <= service_fee_cents),
  status text not null default 'pending' check (status in ('pending','executing','succeeded','failed')),
  stripe_refund_id text null,
  idempotency_key text not null unique,
  claim_token uuid null,
  lease_expires_at timestamptz null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz null,
  last_error_class text null,
  failure_code text null,
  executed_at timestamptz null,
  livemode boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint driver_reversal_service_refunds_claim_check check ((claim_token is null) = (lease_expires_at is null)),
  constraint driver_reversal_service_refunds_failed_check check (status <> 'failed' or failure_code is not null),
  constraint driver_reversal_service_refunds_succeeded_check check (status <> 'succeeded' or (stripe_refund_id is not null and executed_at is not null)),
  -- Formule cumulative figée, vérifiée par la base elle-même (même esprit que settlement_lines_check
  -- pour l'ancien modèle) : refund_cents = floor((précédent+actuel)×service/delivery) − floor(précédent×service/delivery).
  constraint driver_reversal_service_refunds_formula_check check (
    refund_cents = (((previously_recovered_cents + reversed_cents) * service_fee_cents) / delivery_cents)
                 - ((previously_recovered_cents * service_fee_cents) / delivery_cents)
  ),
  constraint driver_reversal_service_refunds_recovered_check check (previously_recovered_cents + reversed_cents <= delivery_cents)
);

create index driver_reversal_service_refunds_order_id_idx on public.driver_reversal_service_refunds(order_id);
create index driver_reversal_service_refunds_due_idx on public.driver_reversal_service_refunds(next_attempt_at) where status in ('pending','executing');

-- merchant_id dérivé en base (jamais saisi par l'application), même précaution que le driver_id de
-- driver_transfer_reversals (fill_driver_transfer_reversal_driver).
create function public.fill_driver_reversal_service_refund_merchant() returns trigger language plpgsql set search_path = '' as $$
begin
  select st.merchant_id into new.merchant_id
    from public.driver_transfer_reversals r
    join public.driver_transfers t on t.id = r.driver_transfer_id
    join public.settlement_statements st on st.id = t.statement_id
   where r.id = new.driver_transfer_reversal_id;
  return new;
end;
$$;
revoke execute on function public.fill_driver_reversal_service_refund_merchant() from anon, authenticated, public;
create trigger driver_reversal_service_refunds_fill_merchant before insert on public.driver_reversal_service_refunds
  for each row execute function public.fill_driver_reversal_service_refund_merchant();

-- Garde d'insertion : le reversal parent doit être driver_fault, succeeded, avec un reversed_cents
-- positif, et porter EXACTEMENT sur la même commande que celle déclarée ici (jamais une autre
-- commande du même statement).
create function public.guard_driver_reversal_service_refund() returns trigger language plpgsql set search_path = '' as $$
declare r record;
begin
  select category, status, order_id, reversed_cents into r from public.driver_transfer_reversals where id = new.driver_transfer_reversal_id;
  if not found or r.status <> 'succeeded' then raise exception 'un remboursement de service exige un reversal réussi'; end if;
  if r.category <> 'driver_fault' then raise exception 'le remboursement de service ne concerne que les reversals driver_fault'; end if;
  if r.order_id is null or r.order_id <> new.order_id then raise exception 'le remboursement de service doit porter sur la commande exacte du reversal'; end if;
  if r.reversed_cents is null or r.reversed_cents <= 0 then raise exception 'un remboursement de service exige un montant réellement récupéré positif'; end if;
  return new;
end;
$$;
revoke execute on function public.guard_driver_reversal_service_refund() from anon, authenticated, public;
create trigger driver_reversal_service_refunds_guard before insert on public.driver_reversal_service_refunds
  for each row execute function public.guard_driver_reversal_service_refund();

-- Immuabilité : décision figée dès l'insertion (tout est déjà connu), seuls statut/résultat Stripe
-- évoluent jusqu'à un état terminal, qui devient alors terminal à son tour.
create function public.guard_driver_reversal_service_refund_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.driver_transfer_reversal_id, new.order_id, new.merchant_id, new.debit_attempt_id, new.stripe_charge_id,
      new.delivery_cents, new.service_fee_cents, new.previously_recovered_cents, new.reversed_cents, new.refund_cents,
      new.idempotency_key, new.livemode)
     is distinct from
     (old.driver_transfer_reversal_id, old.order_id, old.merchant_id, old.debit_attempt_id, old.stripe_charge_id,
      old.delivery_cents, old.service_fee_cents, old.previously_recovered_cents, old.reversed_cents, old.refund_cents,
      old.idempotency_key, old.livemode) then
    raise exception 'la décision d’un remboursement de service (montants, commande, référence) est immuable';
  end if;
  if old.status in ('succeeded','failed') and new.status is distinct from old.status then
    raise exception 'un état final de remboursement de service est terminal';
  end if;
  if old.status in ('succeeded','failed') and old.status = new.status and new.stripe_refund_id is distinct from old.stripe_refund_id then
    raise exception 'le résultat d’un remboursement de service terminé est immuable';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_driver_reversal_service_refund_immutable() from anon, authenticated, public;
create trigger driver_reversal_service_refunds_immutable before update on public.driver_reversal_service_refunds
  for each row execute function public.guard_driver_reversal_service_refund_immutable();

alter table public.driver_reversal_service_refunds enable row level security;
revoke all privileges on table public.driver_reversal_service_refunds from anon, authenticated;
