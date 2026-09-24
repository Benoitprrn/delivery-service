-- Étape 5 (docs/work/invoicing-preparation-plan.md §9-§10) : préparation du connecteur SUPER PDP
-- en sandbox. Cette migration ne fait AUCUN appel réseau ; elle prépare uniquement le schéma que
-- l'adaptateur (tranche suivante, Codex) consommera. Le moteur interne (0047) reste la source de
-- vérité métier ; rien ici ne change son comportement pour une commande qui ne serait jamais
-- transmise à un fournisseur externe.

-- 1. Adresse électronique EN16931 du vendeur (BT-34/BT-49, {scheme, value}) — obligatoire côté
--    Super PDP (`seller.electronic_address` required), absente du modèle jusqu'ici (trouvaille
--    Étape 5, corrige §8.6). Snapshotée à l'émission comme le reste de `seller_*`, jamais
--    recalculée après coup. Nullable : les factures déjà émises avant cette migration n'ont pas
--    cette donnée et restent valides côté moteur interne (Super PDP n'est qu'une couche de
--    transmission, jamais la source de vérité — une facture sans adresse électronique reste une
--    facture interne complète, juste non transmissible tant que l'adaptateur ne la complète pas).
--    Le schéma exact ("0225" = Peppol France par SIREN, cohérent avec l'annuaire déjà documenté
--    en §7) n'est PAS validé par la spec JSON elle-même : valeur fournie par la configuration
--    applicative (SUPERPDP_ELECTRONIC_ADDRESS_SCHEME), jamais une constante SQL en dur ici,
--    justement pour pouvoir corriger sans nouvelle migration si le sandbox la rejette.
alter table public.invoices add column seller_electronic_address_scheme text;
alter table public.invoices add column seller_electronic_address_value text;
alter table public.invoices add constraint invoices_seller_electronic_address_pair_check
  check ((seller_electronic_address_scheme is null) = (seller_electronic_address_value is null));

-- 2. Conditions de paiement (BT-20/BT-81/BT-82) — constantes métier réelles (100% des commandes
--    Locadely sont payées par prélèvement SEPA du restaurant, jamais une autre modalité) : valeur
--    par défaut fixe, contrairement à l'adresse électronique ci-dessus qui reste une hypothèse
--    technique à valider. `payment_means_type_code` = "59" (UNTDID 4461, SEPA direct debit) —
--    meilleure estimation documentée, PAS confirmée par un test sandbox réel (voir plan §9.W) ;
--    conservée en colonne modifiable par une future migration si le fournisseur la rejette,
--    jamais recalculée sur les factures déjà émises (immuable comme le reste du contenu légal).
--    BT-9/BT-89/BT-90/BT-91 (échéance précise, référence de mandat SEPA, identifiant créancier)
--    ne sont délibérément PAS ajoutés : non calculables au moment de l'émission (la période de
--    règlement n'est pas encore close, `settlement_line_id` pas encore rattaché) sans fragiliser
--    l'invariant « facture ≠ paiement » (ADR 0006 §3) — décision actée en §9.I, pas un oubli.
-- Le DEFAULT est conservé (jamais retiré) : ce sont de vraies constantes métier, pas une valeur
-- dépendant de la commande — l'émission (apps/api/src/modules/invoices/infrastructure/postgres-
-- invoice-repository.ts) n'a pas besoin de les connaître pour continuer à fonctionner sans
-- modification ; un futur adaptateur peut les lire mais ne les choisit jamais lui-même.
alter table public.invoices add column payment_means_type_code text not null
  default '59' check (btrim(payment_means_type_code) <> '');
alter table public.invoices add column payment_terms_text text not null
  default 'Paiement par prélèvement SEPA automatique, dans le cadre du règlement périodique du restaurant auprès de Locadely.'
  check (btrim(payment_terms_text) <> '');
-- Les deux colonnes ci-dessus rejoignent le contenu légal immuable : le trigger d'immuabilité
-- existant (guard_invoice_immutable) doit désormais les couvrir aussi.
create or replace function public.guard_invoice_immutable() returns trigger language plpgsql set search_path = '' as $$
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
      new.buyer_address_city, new.buyer_address_country_code, new.seller_electronic_address_scheme,
      new.seller_electronic_address_value, new.payment_means_type_code, new.payment_terms_text)
     is distinct from
     (old.id, old.number, old.issuer_kind, old.issuer_driver_id, old.invoice_type_code, old.order_id,
      old.order_public_reference, old.buyer_merchant_id, old.issued_at, old.service_completed_at,
      old.currency_code, old.total_ht_cents, old.total_vat_cents, old.seller_legal_name, old.seller_siren,
      old.seller_siret, old.seller_vat_number, old.seller_vat_regime, old.seller_address_line1,
      old.seller_address_line2, old.seller_address_postal_code, old.seller_address_city,
      old.seller_address_country_code, old.buyer_legal_name, old.buyer_siren, old.buyer_siret,
      old.buyer_vat_number, old.buyer_address_line1, old.buyer_address_line2, old.buyer_address_postal_code,
      old.buyer_address_city, old.buyer_address_country_code, old.seller_electronic_address_scheme,
      old.seller_electronic_address_value, old.payment_means_type_code, old.payment_terms_text) then
    raise exception 'le contenu légal d’une facture émise est immuable — seul un avoir peut le corriger';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_invoice_immutable() from anon, authenticated, public;

-- 3. `invoice_provider_submissions` (créée vide en 0047) : état enrichi pour un vrai worker de
--    soumission/polling (bail, tentatives, résultat ambigu jamais retenté automatiquement — §9.L).
alter table public.invoice_provider_submissions drop constraint invoice_provider_submissions_submission_status_check;
alter table public.invoice_provider_submissions alter column submission_status set default 'prepared';
alter table public.invoice_provider_submissions add constraint invoice_provider_submissions_submission_status_check
  check (submission_status in ('prepared', 'submitting', 'submitted', 'accepted', 'rejected', 'retryable', 'failed', 'unknown_outcome'));
alter table public.invoice_provider_submissions add column locked_until timestamptz;
alter table public.invoice_provider_submissions add column next_attempt_at timestamptz;
alter table public.invoice_provider_submissions add column last_attempt_at timestamptz;
alter table public.invoice_provider_submissions add column document_content_type text;
alter table public.invoice_provider_submissions add column document_sha256 text;
-- Unicité qui tient compte du fournisseur (un seul provider aujourd'hui, mais évite une
-- migration future si un deuxième PA devait un jour être supporté en parallèle).
drop index public.invoice_provider_submissions_invoice_idx;
drop index public.invoice_provider_submissions_credit_note_idx;
create unique index invoice_provider_submissions_provider_invoice_idx
  on public.invoice_provider_submissions (provider, invoice_id) where invoice_id is not null;
create unique index invoice_provider_submissions_provider_credit_note_idx
  on public.invoice_provider_submissions (provider, credit_note_id) where credit_note_id is not null;

-- 4. Curseur global de polling `invoice_events`, par compte/provider — distinct du dernier
--    événement d'une soumission individuelle (qui reste sur invoice_provider_submissions).
create table public.einvoice_provider_event_cursors (
  provider text primary key,
  last_invoice_event_id bigint not null default 0 check (last_invoice_event_id >= 0),
  last_polled_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.einvoice_provider_event_cursors enable row level security;
revoke all privileges on table public.einvoice_provider_event_cursors from anon, authenticated;
insert into public.einvoice_provider_event_cursors (provider) values ('superpdp');

-- 5. Mandat de facturation par tiers du livreur (§9.D). Table unique (pas de séparation
--    métier/provider : le volume et la complexité ne justifient pas deux tables ici, contrairement
--    à l'ébauche initiale de l'analyse — décision produit du 2026-09-23). Contenu légal figé à
--    l'acceptation (snapshot SIREN/nom, texte/hash du mandat, preuve technique d'acceptation, PDF
--    signé) jamais modifié ensuite ; seuls les champs de suivi fournisseur et la révocation sont
--    mutables. Un livreur a au plus UN mandat courant (non révoqué) à la fois — un nouveau mandat
--    (nouvelle version du texte, ou remplacement) révoque l'ancien plutôt que de le réutiliser.
create table public.driver_einvoice_mandates (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id),
  grantor_siren char(9) not null check (grantor_siren ~ '^[0-9]{9}$'),
  grantor_legal_name_snapshot text not null check (btrim(grantor_legal_name_snapshot) <> ''),
  mandate_template_version integer not null check (mandate_template_version > 0),
  mandate_text_hash text not null check (btrim(mandate_text_hash) <> ''),
  accepted_at timestamptz not null,
  acceptance_method text not null check (acceptance_method in ('mobile_checkbox')),
  acceptance_evidence jsonb not null default '{}'::jsonb,
  signed_pdf_storage_path text not null unique,
  signed_pdf_sha256 text not null check (btrim(signed_pdf_sha256) <> ''),
  provider text not null default 'superpdp',
  provider_mandate_id text,
  provider_verification_status text not null default 'not_submitted'
    check (provider_verification_status in ('not_submitted', 'submitted', 'not_verified', 'verified', 'rejected')),
  submitted_at timestamptz,
  verified_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((provider_verification_status = 'verified') = (verified_at is not null)),
  check ((revoked_at is null) = (revocation_reason is null))
);
alter table public.driver_einvoice_mandates enable row level security;
revoke all privileges on table public.driver_einvoice_mandates from anon, authenticated;
create index driver_einvoice_mandates_driver_idx on public.driver_einvoice_mandates (driver_id);
create unique index driver_einvoice_mandates_driver_current_idx
  on public.driver_einvoice_mandates (driver_id) where revoked_at is null;

create function public.guard_driver_einvoice_mandate_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'un mandat de facturation ne peut jamais être supprimé'; end if;
  if (new.id, new.driver_id, new.grantor_siren, new.grantor_legal_name_snapshot, new.mandate_template_version,
      new.mandate_text_hash, new.accepted_at, new.acceptance_method, new.acceptance_evidence,
      new.signed_pdf_storage_path, new.signed_pdf_sha256)
     is distinct from
     (old.id, old.driver_id, old.grantor_siren, old.grantor_legal_name_snapshot, old.mandate_template_version,
      old.mandate_text_hash, old.accepted_at, old.acceptance_method, old.acceptance_evidence,
      old.signed_pdf_storage_path, old.signed_pdf_sha256) then
    raise exception 'le contenu accepté d’un mandat est immuable — une nouvelle version révoque l’ancien mandat';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'un mandat révoqué ne peut pas être « dé-révoqué »';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_driver_einvoice_mandate_immutable() from anon, authenticated, public;
create trigger driver_einvoice_mandates_guard before update or delete on public.driver_einvoice_mandates
  for each row execute function public.guard_driver_einvoice_mandate_immutable();
