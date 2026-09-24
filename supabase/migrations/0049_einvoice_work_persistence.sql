-- Étape 5, Tranche 1 (docs/work/invoicing-preparation-plan.md §11.G) : socle de persistance pour
-- le futur worker de soumission/polling Super PDP. Aucun appel réseau ici ni dans le code qui
-- consomme cette migration — uniquement le modèle permettant à un worker futur de réserver du
-- travail sans double traitement et de conserver les événements fournisseur sans perte.

-- 1. Table d'événements bruts par soumission. `invoice_provider_submissions` (0048) ne conservait
--    qu'un curseur global (`einvoice_provider_event_cursors`) et le dernier event id traité —
--    insuffisant pour la projection CUMULATIVE exigée par ADR 0007 §6 (« jamais le dernier
--    événement seul, toujours l'ensemble connu »). Colonnes minimales utiles (pas de copie brute
--    intégrale de la réponse fournisseur, seulement ce que la projection/l'audit exploitent
--    réellement) : identifiants, code de statut, horodatages provider/réception. Unicité
--    `(provider, provider_event_id)` : rejoue le polling sans jamais dupliquer un événement déjà
--    connu (idempotence). Append-only, comme le reste des documents facture (ADR 0006/0007).
create table public.einvoice_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'superpdp',
  submission_id uuid not null references public.invoice_provider_submissions(id),
  provider_event_id bigint not null check (provider_event_id > 0),
  provider_document_id text not null check (btrim(provider_document_id) <> ''),
  status_code text not null check (btrim(status_code) <> ''),
  status_text text,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);
alter table public.einvoice_events enable row level security;
revoke all privileges on table public.einvoice_events from anon, authenticated;
create index einvoice_events_submission_idx on public.einvoice_events (submission_id, provider_event_id);

create function public.guard_einvoice_events_append_only() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'les événements Super PDP sont append-only';
end;
$$;
revoke execute on function public.guard_einvoice_events_append_only() from anon, authenticated, public;
create trigger einvoice_events_guard before update or delete on public.einvoice_events
  for each row execute function public.guard_einvoice_events_append_only();

-- 2. `invoice_provider_submissions` (0047/0048) a déjà `created_at` (tri `claimDue`),
--    `locked_until`/`attempts`/`next_attempt_at`/`last_attempt_at` (bail/retry, 0048) et
--    `provider_document_id`/`external_id` (identifiants fournisseur) — vérifié suffisante telle
--    quelle pour cette tranche, rien à ajouter côté colonnes.
