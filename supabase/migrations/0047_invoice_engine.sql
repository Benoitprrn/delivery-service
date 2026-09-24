-- Étape 4 (docs/work/invoicing-preparation-plan.md §6-§8, ADR 0006) : moteur de facturation
-- interne. Une livraison COMPLETED = une facture livreur->restaurant (mandat) + une facture
-- Locadely->restaurant, toujours créées ensemble dans une seule transaction locale. Aucun appel
-- réseau à un fournisseur de transmission dans cette migration ni dans le code qui la consomme.

-- 1. Identité légale propre de Locadely (émetteur de la facture "frais de service" et
--    mandataire de la facture livreur). Singleton, même patron que settlement_settings (0030).
--    Toutes les colonnes sont nullable à la création : le worker de facturation refuse
--    d'émettre tant qu'elles ne sont pas complètes (garde applicative, pas de valeur bidon ici).
create table public.platform_legal_identity (
  id boolean primary key default true check (id),
  legal_name text,
  siren char(9) check (siren ~ '^[0-9]{9}$'),
  siret char(14) check (siret ~ '^[0-9]{14}$' and siren = left(siret, 9)),
  vat_number text,
  vat_regime text check (vat_regime in ('assujetti', 'franchise_en_base', 'exonere')),
  address_line1 text,
  address_line2 text,
  address_postal_code text,
  address_city text,
  address_country_code char(2) not null default 'FR',
  updated_at timestamptz not null default now()
);
insert into public.platform_legal_identity (id) values (true);
alter table public.platform_legal_identity enable row level security;
revoke all privileges on table public.platform_legal_identity from anon, authenticated;

create function public.guard_platform_legal_identity() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'la suppression de l’identité légale de la plateforme est interdite'; end if;
  return new;
end;
$$;
revoke execute on function public.guard_platform_legal_identity() from anon, authenticated, public;
create trigger platform_legal_identity_guard before delete on public.platform_legal_identity
  for each row execute function public.guard_platform_legal_identity();

-- 2. Numérotation légale (BT-1). Une série par émetteur réel : une par livreur (il est
--    l'émetteur juridique de sa facture), une unique pour Locadely — jamais mélangées, jamais
--    générées par un fournisseur externe (§7.4 : Super PDP ne génère pas le numéro). Continue,
--    sans réinitialisation annuelle (ADR 0006 §6). `issuer_driver_id` utilise une sentinelle
--    (uuid nul) pour l'émetteur Locadely car une clé primaire ne peut pas contenir NULL ; ce
--    n'est jamais un driver réel (aucune contrainte de clé étrangère sur cette colonne ici).
create table public.invoice_number_sequences (
  doc_kind text not null check (doc_kind in ('invoice', 'credit_note')),
  issuer_kind text not null check (issuer_kind in ('driver', 'locadely')),
  issuer_driver_id uuid not null,
  next_number bigint not null default 1 check (next_number > 0),
  updated_at timestamptz not null default now(),
  primary key (doc_kind, issuer_kind, issuer_driver_id),
  check (
    (issuer_kind = 'locadely' and issuer_driver_id = '00000000-0000-0000-0000-000000000000')
    or (issuer_kind = 'driver' and issuer_driver_id <> '00000000-0000-0000-0000-000000000000')
  )
);
alter table public.invoice_number_sequences enable row level security;
revoke all privileges on table public.invoice_number_sequences from anon, authenticated;

-- Alloue et formate le prochain numéro dans la même transaction que l'insertion du document :
-- l'upsert verrouille la ligne de compteur, deux émissions concurrentes pour le même émetteur
-- sont sérialisées par Postgres (la seconde attend le COMMIT de la première).
create function public.assign_document_number(
  p_doc_kind text, p_issuer_kind text, p_issuer_driver_id uuid, p_seller_siren char(9)
) returns text language plpgsql set search_path = '' as $$
declare v_assigned bigint; v_prefix text;
begin
  insert into public.invoice_number_sequences (doc_kind, issuer_kind, issuer_driver_id, next_number)
  values (p_doc_kind, p_issuer_kind, p_issuer_driver_id, 2)
  on conflict (doc_kind, issuer_kind, issuer_driver_id)
  do update set next_number = public.invoice_number_sequences.next_number + 1, updated_at = now()
  returning next_number - 1 into v_assigned;

  v_prefix := case
    when p_doc_kind = 'invoice' and p_issuer_kind = 'locadely' then 'LOC-'
    when p_doc_kind = 'invoice' and p_issuer_kind = 'driver' then 'DRV-' || p_seller_siren || '-'
    when p_doc_kind = 'credit_note' and p_issuer_kind = 'locadely' then 'AVL-'
    else 'AVD-' || p_seller_siren || '-'
  end;
  return v_prefix || lpad(v_assigned::text, 6, '0');
end;
$$;
revoke execute on function public.assign_document_number(text, text, uuid, char) from anon, authenticated, public;

-- 3. Factures. Une ligne par facture (livreur ou Locadely), toujours rattachée à une commande
--    COMPLETED avec montants figés (garde applicative, doublée par le CHECK sur orders déjà en
--    place depuis SF5/0042 — aucune facture ne peut être créée avec une commande sans montants).
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null,
  issuer_kind text not null check (issuer_kind in ('driver', 'locadely')),
  issuer_driver_id uuid references public.drivers(id),
  invoice_type_code text not null check (invoice_type_code in ('380', '389')),
  order_id uuid not null references public.orders(id),
  order_public_reference text not null check (order_public_reference ~ '^[0-9]{8}$'),
  buyer_merchant_id uuid not null references public.merchants(id),
  settlement_line_id uuid references public.settlement_lines(id),
  issued_at timestamptz not null default now(),
  issue_date date generated always as ((issued_at at time zone 'Europe/Paris')::date) stored,
  service_completed_at timestamptz not null,
  service_date date generated always as ((service_completed_at at time zone 'Europe/Paris')::date) stored,
  currency_code char(3) not null default 'EUR',
  total_ht_cents integer not null check (total_ht_cents >= 0),
  total_vat_cents integer not null check (total_vat_cents >= 0),
  total_ttc_cents integer generated always as (total_ht_cents + total_vat_cents) stored,
  transmission_status text not null default 'not_submitted'
    check (transmission_status in ('not_submitted', 'submitted', 'confirmed', 'rejected')),
  -- Snapshot vendeur (figé à l'émission, jamais relu depuis le profil après coup).
  seller_legal_name text not null check (btrim(seller_legal_name) <> ''),
  seller_siren char(9) not null check (seller_siren ~ '^[0-9]{9}$'),
  seller_siret char(14) check (seller_siret ~ '^[0-9]{14}$' and seller_siren = left(seller_siret, 9)),
  seller_vat_number text,
  seller_vat_regime text not null check (seller_vat_regime in ('assujetti', 'franchise_en_base', 'exonere')),
  seller_address_line1 text not null,
  seller_address_line2 text,
  seller_address_postal_code text not null,
  seller_address_city text not null,
  seller_address_country_code char(2) not null default 'FR',
  -- Snapshot acheteur (restaurant, figé à l'émission).
  buyer_legal_name text not null check (btrim(buyer_legal_name) <> ''),
  buyer_siren char(9) not null check (buyer_siren ~ '^[0-9]{9}$'),
  buyer_siret char(14) not null check (buyer_siret ~ '^[0-9]{14}$' and buyer_siren = left(buyer_siret, 9)),
  buyer_vat_number text,
  buyer_address_line1 text not null,
  buyer_address_line2 text,
  buyer_address_postal_code text not null,
  buyer_address_city text not null,
  buyer_address_country_code char(2) not null default 'FR',
  created_at timestamptz not null default now(),
  unique (order_id, issuer_kind),
  unique (number),
  check ((issuer_kind = 'driver') = (issuer_driver_id is not null)),
  check ((issuer_kind = 'driver' and invoice_type_code = '389') or (issuer_kind = 'locadely' and invoice_type_code = '380'))
);
alter table public.invoices enable row level security;
revoke all privileges on table public.invoices from anon, authenticated;
create index invoices_order_idx on public.invoices (order_id);
create index invoices_buyer_merchant_idx on public.invoices (buyer_merchant_id);
create index invoices_issuer_driver_idx on public.invoices (issuer_driver_id) where issuer_driver_id is not null;

-- Contenu légal immuable ; seuls transmission_status (dimension transmission future, générique,
-- sans détail fournisseur ici) et settlement_line_id (NULL -> valeur, une seule fois, rattachement
-- tardif au règlement) peuvent changer. DELETE toujours interdit (append-only).
create function public.guard_invoice_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'une facture émise ne peut jamais être supprimée'; end if;
  if new.settlement_line_id is distinct from old.settlement_line_id and old.settlement_line_id is not null then
    raise exception 'settlement_line_id d’une facture ne peut être rattaché qu’une seule fois';
  end if;
  if (new.id, new.number, new.issuer_kind, new.issuer_driver_id, new.invoice_type_code, new.order_id,
      new.order_public_reference, new.buyer_merchant_id, new.issued_at, new.service_completed_at,
      new.currency_code, new.total_ht_cents, new.total_vat_cents, new.seller_legal_name, new.seller_siren,
      new.seller_siret, new.seller_vat_number, new.seller_vat_regime, new.seller_address_line1,
      new.seller_address_line2, new.seller_address_postal_code, new.seller_address_city,
      new.seller_address_country_code, new.buyer_legal_name, new.buyer_siren, new.buyer_siret,
      new.buyer_vat_number, new.buyer_address_line1, new.buyer_address_line2, new.buyer_address_postal_code,
      new.buyer_address_city, new.buyer_address_country_code)
     is distinct from
     (old.id, old.number, old.issuer_kind, old.issuer_driver_id, old.invoice_type_code, old.order_id,
      old.order_public_reference, old.buyer_merchant_id, old.issued_at, old.service_completed_at,
      old.currency_code, old.total_ht_cents, old.total_vat_cents, old.seller_legal_name, old.seller_siren,
      old.seller_siret, old.seller_vat_number, old.seller_vat_regime, old.seller_address_line1,
      old.seller_address_line2, old.seller_address_postal_code, old.seller_address_city,
      old.seller_address_country_code, old.buyer_legal_name, old.buyer_siren, old.buyer_siret,
      old.buyer_vat_number, old.buyer_address_line1, old.buyer_address_line2, old.buyer_address_postal_code,
      old.buyer_address_city, old.buyer_address_country_code) then
    raise exception 'le contenu légal d’une facture émise est immuable — seul un avoir peut le corriger';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_invoice_immutable() from anon, authenticated, public;
create trigger invoices_guard before update or delete on public.invoices
  for each row execute function public.guard_invoice_immutable();

-- 4. Lignes de facture. Toujours append-only : une facture émise ne change jamais ses lignes.
create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id),
  line_number smallint not null check (line_number > 0),
  order_id uuid not null references public.orders(id),
  description text not null check (btrim(description) <> ''),
  quantity numeric(10, 3) not null default 1 check (quantity > 0),
  unit text,
  unit_price_ht_cents integer not null check (unit_price_ht_cents >= 0),
  vat_rate_bps integer not null check (vat_rate_bps >= 0),
  vat_exemption_reason_code text,
  vat_exemption_reason_text text,
  line_ht_cents integer not null check (line_ht_cents >= 0),
  line_vat_cents integer not null check (line_vat_cents >= 0 and line_vat_cents = (line_ht_cents * vat_rate_bps) / 10000),
  line_ttc_cents integer generated always as (line_ht_cents + line_vat_cents) stored,
  created_at timestamptz not null default now(),
  unique (invoice_id, line_number)
);
alter table public.invoice_lines enable row level security;
revoke all privileges on table public.invoice_lines from anon, authenticated;
create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id);

create function public.guard_invoice_lines_append_only() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'les lignes de facture sont append-only';
end;
$$;
revoke execute on function public.guard_invoice_lines_append_only() from anon, authenticated, public;
create trigger invoice_lines_guard before update or delete on public.invoice_lines
  for each row execute function public.guard_invoice_lines_append_only();

-- Les totaux de la facture doivent toujours correspondre à la somme de ses lignes. Contrainte
-- différée (vérifiée au COMMIT) : la facture et ses lignes s'insèrent dans la même transaction,
-- l'ordre exact des deux INSERT n'a pas à être figé.
create function public.assert_invoice_totals_match_lines() returns trigger language plpgsql set search_path = '' as $$
declare v_invoice_id uuid; v_ht bigint; v_vat bigint; v_expected_ht bigint; v_expected_vat bigint;
begin
  v_invoice_id := coalesce(new.invoice_id, old.invoice_id);
  select total_ht_cents, total_vat_cents into v_expected_ht, v_expected_vat
    from public.invoices where id = v_invoice_id;
  if not found then return null; end if;
  select coalesce(sum(line_ht_cents), 0), coalesce(sum(line_vat_cents), 0)
    into v_ht, v_vat from public.invoice_lines where invoice_id = v_invoice_id;
  if v_ht <> v_expected_ht or v_vat <> v_expected_vat then
    raise exception 'les totaux de la facture % ne correspondent pas à la somme de ses lignes', v_invoice_id;
  end if;
  return null;
end;
$$;
revoke execute on function public.assert_invoice_totals_match_lines() from anon, authenticated, public;
create constraint trigger invoice_lines_totals_match
  after insert or delete or update on public.invoice_lines
  deferrable initially deferred
  for each row execute function public.assert_invoice_totals_match_lines();

-- Complète le contrôle ci-dessus : celui-ci ne se déclenche que lorsqu'une LIGNE bouge, donc
-- une facture insérée sans aucune ligne (bug applicatif) ne serait jamais vérifiée. Ce second
-- déclencheur, sur la table invoices elle-même, ferme ce trou.
create function public.assert_invoice_has_matching_lines() returns trigger language plpgsql set search_path = '' as $$
declare v_ht bigint; v_vat bigint;
begin
  select coalesce(sum(line_ht_cents), 0), coalesce(sum(line_vat_cents), 0)
    into v_ht, v_vat from public.invoice_lines where invoice_id = new.id;
  if v_ht <> new.total_ht_cents or v_vat <> new.total_vat_cents then
    raise exception 'les totaux de la facture % ne correspondent pas à la somme de ses lignes', new.id;
  end if;
  return null;
end;
$$;
revoke execute on function public.assert_invoice_has_matching_lines() from anon, authenticated, public;
create constraint trigger invoices_have_matching_lines
  after insert on public.invoices
  deferrable initially deferred
  for each row execute function public.assert_invoice_has_matching_lines();

-- 5. Avoirs. Toujours rattachés à une facture d'origine, jamais un endpoint séparé côté
--    transmission plus tard (§7.4 : même famille d'objet "invoice" chez Super PDP, code BT-3 +
--    référence de facture précédente) mais un objet métier distinct ici, sa propre numérotation.
create table public.credit_notes (
  id uuid primary key default gen_random_uuid(),
  number text not null,
  original_invoice_id uuid not null references public.invoices(id),
  issuer_kind text not null check (issuer_kind in ('driver', 'locadely')),
  issuer_driver_id uuid references public.drivers(id),
  buyer_merchant_id uuid not null references public.merchants(id),
  order_id uuid not null references public.orders(id),
  order_public_reference text not null check (order_public_reference ~ '^[0-9]{8}$'),
  decision_reference text not null check (btrim(decision_reference) <> ''),
  decision_reason text not null check (btrim(decision_reason) <> ''),
  issued_at timestamptz not null default now(),
  issue_date date generated always as ((issued_at at time zone 'Europe/Paris')::date) stored,
  currency_code char(3) not null default 'EUR',
  total_ht_cents integer not null check (total_ht_cents > 0),
  total_vat_cents integer not null check (total_vat_cents >= 0),
  total_ttc_cents integer generated always as (total_ht_cents + total_vat_cents) stored,
  transmission_status text not null default 'not_submitted'
    check (transmission_status in ('not_submitted', 'submitted', 'confirmed', 'rejected')),
  created_at timestamptz not null default now(),
  unique (number),
  check ((issuer_kind = 'driver') = (issuer_driver_id is not null))
);
alter table public.credit_notes enable row level security;
revoke all privileges on table public.credit_notes from anon, authenticated;
create index credit_notes_original_invoice_idx on public.credit_notes (original_invoice_id);
create index credit_notes_order_idx on public.credit_notes (order_id);

create function public.guard_credit_notes_append_only() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'un avoir émis ne peut jamais être supprimé'; end if;
  if new.transmission_status is distinct from old.transmission_status
     and (new.id, new.number, new.original_invoice_id, new.issuer_kind, new.issuer_driver_id, new.buyer_merchant_id,
          new.order_id, new.order_public_reference, new.decision_reference, new.decision_reason, new.issued_at,
          new.currency_code, new.total_ht_cents, new.total_vat_cents)
        is not distinct from
         (old.id, old.number, old.original_invoice_id, old.issuer_kind, old.issuer_driver_id, old.buyer_merchant_id,
          old.order_id, old.order_public_reference, old.decision_reference, old.decision_reason, old.issued_at,
          old.currency_code, old.total_ht_cents, old.total_vat_cents) then
    return new;
  end if;
  if (new.id, new.number, new.original_invoice_id, new.issuer_kind, new.issuer_driver_id, new.buyer_merchant_id,
      new.order_id, new.order_public_reference, new.decision_reference, new.decision_reason, new.issued_at,
      new.currency_code, new.total_ht_cents, new.total_vat_cents)
     is distinct from
     (old.id, old.number, old.original_invoice_id, old.issuer_kind, old.issuer_driver_id, old.buyer_merchant_id,
      old.order_id, old.order_public_reference, old.decision_reference, old.decision_reason, old.issued_at,
      old.currency_code, old.total_ht_cents, old.total_vat_cents) then
    raise exception 'le contenu d’un avoir émis est immuable';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_credit_notes_append_only() from anon, authenticated, public;
create trigger credit_notes_guard before update or delete on public.credit_notes
  for each row execute function public.guard_credit_notes_append_only();

create table public.credit_note_lines (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references public.credit_notes(id),
  line_number smallint not null check (line_number > 0),
  original_invoice_line_id uuid not null references public.invoice_lines(id),
  order_id uuid not null references public.orders(id),
  description text not null check (btrim(description) <> ''),
  vat_rate_bps integer not null check (vat_rate_bps >= 0),
  line_ht_cents integer not null check (line_ht_cents > 0),
  line_vat_cents integer not null check (line_vat_cents >= 0 and line_vat_cents = (line_ht_cents * vat_rate_bps) / 10000),
  line_ttc_cents integer generated always as (line_ht_cents + line_vat_cents) stored,
  created_at timestamptz not null default now(),
  unique (credit_note_id, line_number)
);
alter table public.credit_note_lines enable row level security;
revoke all privileges on table public.credit_note_lines from anon, authenticated;
create index credit_note_lines_credit_note_idx on public.credit_note_lines (credit_note_id);
create index credit_note_lines_original_line_idx on public.credit_note_lines (original_invoice_line_id);

create function public.guard_credit_note_lines_append_only() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'les lignes d’avoir sont append-only';
end;
$$;
revoke execute on function public.guard_credit_note_lines_append_only() from anon, authenticated, public;
create trigger credit_note_lines_guard before update or delete on public.credit_note_lines
  for each row execute function public.guard_credit_note_lines_append_only();

-- Un avoir ne peut jamais, cumulativement, dépasser le montant HT de la ligne de facture
-- d'origine qu'il corrige (ADR 0006 §10). Vérifié à chaque insertion, jamais en différé : une
-- violation doit annuler l'INSERT fautif immédiatement, pas seulement au COMMIT.
create function public.guard_credit_note_line_within_original() returns trigger language plpgsql set search_path = '' as $$
declare v_original_ht integer; v_line_invoice_id uuid; v_credit_note_original_invoice_id uuid; v_already_credited bigint;
begin
  select line_ht_cents, invoice_id into v_original_ht, v_line_invoice_id from public.invoice_lines where id = new.original_invoice_line_id;
  if not found then raise exception 'la ligne de facture d’origine est introuvable'; end if;
  select original_invoice_id into v_credit_note_original_invoice_id from public.credit_notes where id = new.credit_note_id;
  if v_line_invoice_id <> v_credit_note_original_invoice_id then
    raise exception 'la ligne créditée n’appartient pas à la facture d’origine de cet avoir';
  end if;
  select coalesce(sum(line_ht_cents), 0) into v_already_credited
    from public.credit_note_lines where original_invoice_line_id = new.original_invoice_line_id;
  if v_already_credited > v_original_ht then
    raise exception 'le cumul des avoirs dépasse le montant HT de la ligne de facture d’origine';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_credit_note_line_within_original() from anon, authenticated, public;
create trigger credit_note_lines_within_original
  after insert on public.credit_note_lines
  for each row execute function public.guard_credit_note_line_within_original();

create function public.assert_credit_note_totals_match_lines() returns trigger language plpgsql set search_path = '' as $$
declare v_credit_note_id uuid; v_ht bigint; v_vat bigint; v_expected_ht bigint; v_expected_vat bigint;
begin
  v_credit_note_id := coalesce(new.credit_note_id, old.credit_note_id);
  select total_ht_cents, total_vat_cents into v_expected_ht, v_expected_vat
    from public.credit_notes where id = v_credit_note_id;
  if not found then return null; end if;
  select coalesce(sum(line_ht_cents), 0), coalesce(sum(line_vat_cents), 0)
    into v_ht, v_vat from public.credit_note_lines where credit_note_id = v_credit_note_id;
  if v_ht <> v_expected_ht or v_vat <> v_expected_vat then
    raise exception 'les totaux de l’avoir % ne correspondent pas à la somme de ses lignes', v_credit_note_id;
  end if;
  return null;
end;
$$;
revoke execute on function public.assert_credit_note_totals_match_lines() from anon, authenticated, public;
create constraint trigger credit_note_lines_totals_match
  after insert or delete or update on public.credit_note_lines
  deferrable initially deferred
  for each row execute function public.assert_credit_note_totals_match_lines();

-- Même complément que pour les factures : un avoir inséré sans aucune ligne ne serait jamais
-- vérifié par le déclencheur ci-dessus seul.
create function public.assert_credit_note_has_matching_lines() returns trigger language plpgsql set search_path = '' as $$
declare v_ht bigint; v_vat bigint;
begin
  select coalesce(sum(line_ht_cents), 0), coalesce(sum(line_vat_cents), 0)
    into v_ht, v_vat from public.credit_note_lines where credit_note_id = new.id;
  if v_ht <> new.total_ht_cents or v_vat <> new.total_vat_cents then
    raise exception 'les totaux de l’avoir % ne correspondent pas à la somme de ses lignes', new.id;
  end if;
  return null;
end;
$$;
revoke execute on function public.assert_credit_note_has_matching_lines() from anon, authenticated, public;
create constraint trigger credit_notes_have_matching_lines
  after insert on public.credit_notes
  deferrable initially deferred
  for each row execute function public.assert_credit_note_has_matching_lines();

-- 6. Rattachement futur à un fournisseur de transmission (Super PDP ou autre PA). Table séparée
--    exprès (ADR 0006 §11) : jamais de colonnes superpdp_* sur invoices/credit_notes. Vide et
--    inutilisée tant que l'adaptateur réseau n'existe pas (tranche suivante).
create table public.invoice_provider_submissions (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references public.invoices(id),
  credit_note_id uuid references public.credit_notes(id),
  provider text not null default 'superpdp',
  external_id text,
  provider_document_id text,
  company_mandate_id text,
  processing_rule text,
  submission_status text not null default 'pending'
    check (submission_status in ('pending', 'submitted', 'accepted', 'rejected')),
  last_invoice_event_id bigint,
  last_error text,
  attempts integer not null default 0 check (attempts >= 0),
  document_storage_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((invoice_id is not null and credit_note_id is null) or (invoice_id is null and credit_note_id is not null))
);
alter table public.invoice_provider_submissions enable row level security;
revoke all privileges on table public.invoice_provider_submissions from anon, authenticated;
create unique index invoice_provider_submissions_invoice_idx
  on public.invoice_provider_submissions (invoice_id) where invoice_id is not null;
create unique index invoice_provider_submissions_credit_note_idx
  on public.invoice_provider_submissions (credit_note_id) where credit_note_id is not null;
