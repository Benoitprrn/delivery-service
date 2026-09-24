-- Étape 3 (docs/work/invoicing-preparation-plan.md §5) : collecter et stocker proprement les
-- informations personnelles, professionnelles et les justificatifs des livreurs et
-- commerçants. Aucune vérification administrative, aucun workflow pending/verified/rejected.

-- 1. Identité personnelle structurée du livreur (prénom/nom), nullable : remplie
--    progressivement via « Mon Compte », comme le reste de l'onboarding dans ce projet.
--    `drivers.name` reste la donnée d'affichage opérationnelle lue par les autres modules
--    (dispatch, commandes) — l'application la tient synchronisée à partir de
--    first_name/last_name dès qu'ils sont renseignés, mais elle n'est jamais éditée
--    directement par l'utilisateur : plus qu'une seule source de vérité côté saisie.
alter table public.drivers add column first_name text null;
alter table public.drivers add column last_name text null;

-- 2. Informations professionnelles du livreur — même structure que
--    merchant_legal_information (0020), sans le volet vérification Sirene (non demandé pour
--    le livreur à cette étape).
create table public.driver_legal_information (
  driver_id uuid primary key references public.drivers(id),
  professional_name text not null check (btrim(professional_name) <> ''),
  siret char(14) not null check (siret ~ '^[0-9]{14}$'),
  siren char(9) not null check (siren ~ '^[0-9]{9}$' and siren = left(siret, 9)),
  legal_address_line1 text not null check (btrim(legal_address_line1) <> ''),
  legal_address_line2 text,
  legal_address_postal_code text not null check (btrim(legal_address_postal_code) <> ''),
  legal_address_city text not null check (btrim(legal_address_city) <> ''),
  legal_address_country_code char(2) not null default 'FR',
  legal_address_commune_code text,
  billing_address_line1 text,
  billing_address_line2 text,
  billing_address_postal_code text,
  billing_address_city text,
  billing_address_country_code char(2),
  billing_address_commune_code text,
  vat_number text,
  -- Jamais déduit automatiquement de vat_number : une saisie explicite distincte.
  vat_regime text check (vat_regime in ('assujetti', 'franchise_en_base', 'exonere')),
  legal_form text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (billing_address_line1 is null and billing_address_line2 is null and billing_address_postal_code is null and billing_address_city is null and billing_address_country_code is null and billing_address_commune_code is null)
    or (billing_address_line1 is not null and billing_address_postal_code is not null and billing_address_city is not null and billing_address_country_code is not null)
  )
);
alter table public.driver_legal_information enable row level security;
revoke all privileges on table public.driver_legal_information from anon, authenticated;

-- 3. Le commerçant a déjà une table légale complète (0020) : seuls deux champs manquent
--    réellement, ajoutés ici plutôt que dupliqués dans une nouvelle table.
alter table public.merchant_legal_information add column legal_form text null;
alter table public.merchant_legal_information add column vat_regime text null
  check (vat_regime in ('assujetti', 'franchise_en_base', 'exonere'));

-- 4. Responsable du compte commerçant (personne physique de l'entreprise) — son e-mail reste
--    celui du compte Supabase Auth existant, jamais dupliqué ici. Aucune preuve d'habilitation
--    à ce stade (hors scope, cf. plan §5).
create table public.merchant_account_contact (
  merchant_id uuid primary key references public.merchants(id),
  first_name text not null check (btrim(first_name) <> ''),
  last_name text not null check (btrim(last_name) <> ''),
  phone text not null check (btrim(phone) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.merchant_account_contact enable row level security;
revoke all privileges on table public.merchant_account_contact from anon, authenticated;

-- 5. Justificatifs (pièce d'identité, justificatif d'entreprise) — métadonnées seulement, le
--    fichier vit dans le bucket Storage privé `account-documents` (policies posées séparément
--    par Supabase, hors migration SQL). `business_registration_document` reste générique :
--    Kbis, extrait RCS/K, attestation SIRENE ou équivalent futur sont tous ce même type côté
--    modèle, seul le libellé change côté UI.
--    Remplacement/suppression : une nouvelle ligne est insérée à chaque dépôt, l'ancienne
--    (s'il y en avait une) reçoit `replaced_at` ; une « suppression » sans remplacement pose
--    aussi `replaced_at` sur la ligne courante (aucune ligne n'est jamais effacée, pour garder
--    une trace d'audit légère) — un document courant = une ligne avec `replaced_at is null`.
--    Aucune colonne verified/rejected/statut : hors scope de cette étape.
create table public.account_documents (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid references public.drivers(id),
  merchant_id uuid references public.merchants(id),
  document_type text not null check (document_type in ('identity_document', 'business_registration_document')),
  storage_path text not null unique,
  original_filename text,
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  uploaded_at timestamptz not null default now(),
  replaced_at timestamptz,
  storage_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  check ((driver_id is not null and merchant_id is null) or (driver_id is null and merchant_id is not null))
);
alter table public.account_documents enable row level security;
revoke all privileges on table public.account_documents from anon, authenticated;

create unique index account_documents_driver_current_idx
  on public.account_documents (driver_id, document_type)
  where replaced_at is null and driver_id is not null;
create unique index account_documents_merchant_current_idx
  on public.account_documents (merchant_id, document_type)
  where replaced_at is null and merchant_id is not null;
create index account_documents_driver_idx on public.account_documents (driver_id) where driver_id is not null;
create index account_documents_merchant_idx on public.account_documents (merchant_id) where merchant_id is not null;
