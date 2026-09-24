-- Étape 5, Tranche 3 (docs/work/invoicing-preparation-plan.md §11/§13) : annuaire électronique
-- français (Super PDP `GET /v1.beta/french_directory/entries?number=<SIREN>`) et éligibilité de
-- transmission. Une facture interne existe et reste consultable indépendamment de tout ceci —
-- rien ici ne conditionne jamais `IssueOrderInvoicesUseCase` (Étape 4) : seule la TRANSMISSION
-- provider (Tranches 2-3) en dépend.

-- 1. Référence acheteur / code de routage (BT-10 `buyer_reference`) : concept EN16931 distinct de
--    l'adresse électronique (BT-49) et du code de service/routage éventuel d'un futur PA — jamais
--    fusionné. Texte libre, facultatif, renseigné par le restaurant lui-même dans « Mon Compte »
--    (utile seulement si SON organisation en exige un ; la grande majorité des restaurants n'en
--    ont pas). Aucune validation de format : la valeur est fournie par des tiers (comptable,
--    plateforme du restaurant), jamais normalisée par Locadely.
alter table public.merchant_legal_information add column buyer_reference text null
  check (buyer_reference is null or btrim(buyer_reference) <> '');

-- 2. Cache de résolution d'annuaire — SOURCE TECHNIQUE DE TRANSMISSION, JAMAIS une donnée légale :
--    ne remplace ni ne duplique `merchant_legal_information` (identité) ni un futur registre
--    officiel. Une ligne par commerçant, réécrite (jamais append-only : ce n'est qu'un cache
--    rafraîchissable, contrairement à `invoices`/`credit_notes`). `siren` est celui EFFECTIVEMENT
--    interrogé : si le SIRET du commerçant change ensuite, cette ligne devient obsolète pour la
--    nouvelle valeur tant qu'un nouveau rafraîchissement n'a pas eu lieu (le code applicatif doit
--    comparer `siren` à la valeur courante avant de faire confiance à la ligne, jamais la
--    migration). Une entrée `ready` porte toujours l'adresse retenue ; toute autre statut ne porte
--    jamais d'adresse partielle (garde par CHECK, cohérence structurelle, pas de confiance
--    aveugle dans le code appelant).
create table public.merchant_einvoice_directory_cache (
  merchant_id uuid primary key references public.merchants(id) on delete cascade,
  siren char(9) not null check (siren ~ '^[0-9]{9}$'),
  -- 'ready' = exactement une entrée d'annuaire active, sélection non ambiguë ;
  -- 'not_addressable' = aucune entrée active (silence de l'annuaire, jamais une erreur) ;
  -- 'ambiguous' = plusieurs entrées actives, aucune règle ne permet de choisir sans deviner ;
  -- 'lookup_failed' = échec technique de l'appel annuaire (jamais confondu avec 'not_addressable').
  resolution_status text not null
    check (resolution_status in ('ready', 'not_addressable', 'ambiguous', 'lookup_failed')),
  electronic_address_scheme text,
  electronic_address_value text,
  active_entry_count integer not null default 0 check (active_entry_count >= 0),
  checked_at timestamptz not null,
  updated_at timestamptz not null default now(),
  check (
    (resolution_status = 'ready' and electronic_address_scheme is not null and electronic_address_value is not null)
    or (resolution_status <> 'ready' and electronic_address_scheme is null and electronic_address_value is null)
  )
);
alter table public.merchant_einvoice_directory_cache enable row level security;
revoke all privileges on table public.merchant_einvoice_directory_cache from anon, authenticated;
