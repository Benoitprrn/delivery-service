-- Étape 5, Tranche 4b (docs/work/invoicing-preparation-plan.md §15.4/§15.9/§15.10) : colonnes de
-- travail pour le worker de soumission du mandat livreur à Super PDP. Cet axe (« soumission
-- technique ») est délibérément distinct de `provider_verification_status` (« vérification
-- fournisseur », déjà en base depuis 0048, jamais touché ici) : un mandat peut être
-- `submitting`/`retryable` côté travail tout en restant `not_submitted` côté vérification jusqu'à
-- ce que le worker de polling constate un premier statut réel. Même patron de bail/backoff que
-- `invoice_provider_submissions` (0049) : `attempts`/`last_attempt_at`/`next_attempt_at`/
-- `locked_until`, jamais un appel réseau externe dans la transaction qui les modifie.
--
-- Zéro ligne existante dans `driver_einvoice_mandates` à ce jour (vérifié avant migration, comme
-- pour 0051) : les `default` ci-dessous ne masquent donc aucune donnée réelle, ils fixent
-- seulement l'état initial d'un futur mandat fraîchement accepté (`prepared`, jamais encore
-- soumis).
--
-- Ces colonnes sont volontairement ABSENTES du trigger d'immutabilité `driver_einvoice_mandates_
-- guard` (0048/0051) : elles doivent rester mutables par le worker après l'insertion initiale,
-- contrairement au contenu accepté (snapshot légal, PDF, preuve).

alter table public.driver_einvoice_mandates
  add column submission_status text not null default 'prepared'
    check (submission_status in ('prepared', 'submitting', 'submitted', 'retryable', 'failed', 'unknown_outcome')),
  add column attempts integer not null default 0 check (attempts >= 0),
  add column last_attempt_at timestamptz,
  add column next_attempt_at timestamptz,
  add column locked_until timestamptz;

-- Anti-doublon fournisseur : deux mandats ne peuvent jamais partager le même `provider_mandate_id`
-- pour un même `provider` (protège contre une double création accidentelle qui aurait échappé à
-- l'idempotence applicative). `provider_mandate_id` reste nullable (mandat pas encore soumis) —
-- une contrainte `unique` standard Postgres traite plusieurs `NULL` comme non conflictuels, donc
-- aucun index partiel n'est nécessaire ici.
alter table public.driver_einvoice_mandates
  add constraint driver_einvoice_mandates_provider_mandate_unique unique (provider, provider_mandate_id);
