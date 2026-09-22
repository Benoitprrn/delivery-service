-- Journal des webhooks Stripe Connect (Direct Charge du paiement carte à la livraison).
--
-- Ces événements arrivent sur un endpoint distinct de celui du SEPA
-- (/api/v1/webhooks/stripe-connect), avec son propre secret de signature.
-- Comme pour stripe_webhook_events, le payload n'est JAMAIS conservé : seuls
-- l'identifiant d'événement, son type, le compte Stripe connecté et quelques
-- identifiants métier minimaux sont stockés. L'événement n'est qu'un
-- déclencheur : la source de vérité est toujours une relecture chez Stripe.
create table if not exists public.stripe_connect_webhook_events (
  event_id text primary key,
  event_type text not null,
  -- Compte Stripe connecté porté par l'événement (`event.account` en v1,
  -- `related_object.id` pour les événements minces v2).
  stripe_account_id text not null,
  stripe_object_id text not null,
  stripe_payment_intent_id text null,
  -- Identifiants issus de la metadata Stripe : jamais une autorité de
  -- rattachement, donc volontairement sans clé étrangère.
  merchant_id uuid null,
  order_id uuid null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  processing_started_at timestamptz null,
  processing_token uuid null,
  processed_at timestamptz null,
  last_error text null,
  received_at timestamptz not null default now(),
  constraint stripe_connect_webhook_events_status_check
    check (status in ('pending', 'processing', 'processed', 'failed', 'dead_letter')),
  constraint stripe_connect_webhook_events_attempts_check check (attempts >= 0)
);

create index if not exists stripe_connect_webhook_events_claim_idx
  on public.stripe_connect_webhook_events (next_attempt_at, received_at, event_id)
  where status in ('pending', 'failed');
create index if not exists stripe_connect_webhook_events_processing_expired_idx
  on public.stripe_connect_webhook_events (processing_started_at, event_id)
  where status = 'processing';

-- Table exposée par la Data API Supabase : RLS activée, aucune policy, aucun
-- privilège pour anon/authenticated (l'API accède directement en postgres).
alter table public.stripe_connect_webhook_events enable row level security;
revoke all privileges on table public.stripe_connect_webhook_events from anon, authenticated;
