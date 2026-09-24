-- Étape 5, Tranche 4a (docs/work/invoicing-preparation-plan.md §15) : fondations du mandat de
-- facturation électronique du livreur — signature manuscrite dans l'app, snapshot légal complet au
-- moment de la signature, gabarit de texte versionné. La soumission Super PDP elle-même (colonnes de
-- travail du worker) reste hors de cette migration : Tranche 4b, sous-tranche suivante, jamais
-- construite en avance de son propre périmètre.

-- 1. Gabarit de mandat — append-only et versionné, même patron que `pricing_settings`
--    (0040_pricing_settings.sql) : un changement de texte insère une nouvelle version, ne réécrit
--    jamais une version existante. Seule source de vérité du texte réellement signé — jamais une
--    chaîne dupliquée en dur côté TypeScript à chaque évolution.
create table public.mandate_templates (
  version integer primary key check (version > 0),
  text text not null check (btrim(text) <> ''),
  text_sha256 text not null check (btrim(text_sha256) <> ''),
  created_at timestamptz not null default now()
);
alter table public.mandate_templates enable row level security;
revoke all privileges on table public.mandate_templates from anon, authenticated;

create function public.guard_mandate_templates() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'mandate_templates est append-only : insérer une nouvelle version plutôt que modifier';
end;
$$;
revoke execute on function public.guard_mandate_templates() from anon, authenticated, public;
create trigger mandate_templates_guard before update or delete on public.mandate_templates
  for each row execute function public.guard_mandate_templates();

-- 2. Snapshot légal complet du livreur au moment de la signature — aujourd'hui seuls
--    `grantor_siren`/`grantor_legal_name_snapshot` existent (0048_superpdp_integration.sql),
--    insuffisant pour représenter fidèlement `driver_legal_information` (professional_name, siret,
--    adresse structurée, TVA, forme juridique). Colonnes ajoutées à LA MÊME table (ADR 0007 §7 :
--    un mandat = une seule table, jamais scindée métier/provider) et immédiatement intégrées au
--    trigger d'immutabilité existant. `not null` directement (jamais un `CHECK` de complétude
--    séparé) : `driver_einvoice_mandates` est vérifiée à zéro ligne dans tous les environnements
--    réels au moment de cette migration (aucun code n'a jamais écrit dedans avant cette tranche —
--    la table existait en avance de son propre usage depuis 0048) ; un `CHECK` de complétude sur une
--    table par ailleurs mutée par un futur worker de suivi aurait bloqué toute mise à jour ultérieure
--    d'une ligne existante (Postgres réévalue un `CHECK` sur la ligne ENTIÈRE à chaque `UPDATE`,
--    y compris `NOT VALID` — vérifié empiriquement pendant cette tranche avant d'écarter l'approche).
alter table public.driver_einvoice_mandates
  add column grantor_name_snapshot text not null,
  add column grantor_professional_name_snapshot text not null,
  add column grantor_siret_snapshot char(14) not null check (grantor_siret_snapshot ~ '^[0-9]{14}$' and grantor_siren = left(grantor_siret_snapshot, 9)),
  add column grantor_legal_address_line1_snapshot text not null,
  add column grantor_legal_address_line2_snapshot text,
  add column grantor_legal_address_postal_code_snapshot text not null,
  add column grantor_legal_address_city_snapshot text not null,
  add column grantor_legal_address_country_code_snapshot char(2) not null default 'FR',
  add column grantor_vat_number_snapshot text,
  add column grantor_vat_regime_snapshot text check (grantor_vat_regime_snapshot is null or grantor_vat_regime_snapshot in ('assujetti', 'franchise_en_base', 'exonere')),
  add column grantor_legal_form_snapshot text;

-- 3. La signature manuscrite dessinée dans l'app est une méthode d'acceptation distincte de la case
--    à cocher historique (jamais retirée : conservée pour compatibilité conceptuelle, une ligne déjà
--    en base peut la porter).
alter table public.driver_einvoice_mandates drop constraint driver_einvoice_mandates_acceptance_method_check;
alter table public.driver_einvoice_mandates add constraint driver_einvoice_mandates_acceptance_method_check
  check (acceptance_method in ('mobile_checkbox', 'mobile_drawn_signature'));

-- 4. Anti-doublon : un même PDF accepté ne doit jamais donner lieu à deux lignes de mandat pour un
--    même livreur (retry accidentel de l'écran d'acceptation, par exemple après une coupure réseau
--    côté mobile avant réception de la réponse).
alter table public.driver_einvoice_mandates add constraint driver_einvoice_mandates_driver_pdf_unique
  unique (driver_id, signed_pdf_sha256);

-- 5. Étend le trigger d'immutabilité existant : chaque nouvelle colonne snapshot rejoint l'ensemble
--    immuable au même titre que les colonnes historiques — jamais mutable après signature.
create or replace function public.guard_driver_einvoice_mandate_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'un mandat de facturation ne peut jamais être supprimé'; end if;
  if (new.id, new.driver_id, new.grantor_siren, new.grantor_legal_name_snapshot, new.mandate_template_version,
      new.mandate_text_hash, new.accepted_at, new.acceptance_method, new.acceptance_evidence,
      new.signed_pdf_storage_path, new.signed_pdf_sha256,
      new.grantor_name_snapshot, new.grantor_professional_name_snapshot, new.grantor_siret_snapshot,
      new.grantor_legal_address_line1_snapshot, new.grantor_legal_address_line2_snapshot,
      new.grantor_legal_address_postal_code_snapshot, new.grantor_legal_address_city_snapshot,
      new.grantor_legal_address_country_code_snapshot, new.grantor_vat_number_snapshot,
      new.grantor_vat_regime_snapshot, new.grantor_legal_form_snapshot)
     is distinct from
     (old.id, old.driver_id, old.grantor_siren, old.grantor_legal_name_snapshot, old.mandate_template_version,
      old.mandate_text_hash, old.accepted_at, old.acceptance_method, old.acceptance_evidence,
      old.signed_pdf_storage_path, old.signed_pdf_sha256,
      old.grantor_name_snapshot, old.grantor_professional_name_snapshot, old.grantor_siret_snapshot,
      old.grantor_legal_address_line1_snapshot, old.grantor_legal_address_line2_snapshot,
      old.grantor_legal_address_postal_code_snapshot, old.grantor_legal_address_city_snapshot,
      old.grantor_legal_address_country_code_snapshot, old.grantor_vat_number_snapshot,
      old.grantor_vat_regime_snapshot, old.grantor_legal_form_snapshot) then
    raise exception 'le contenu accepté d’un mandat est immuable — une nouvelle version révoque l’ancien mandat';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'un mandat révoqué ne peut pas être « dé-révoqué »';
  end if;
  return new;
end;
$$;
