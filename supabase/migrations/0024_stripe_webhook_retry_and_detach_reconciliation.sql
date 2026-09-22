-- Les réceptions Stripe sont rejouables avec un bail court et un backoff borné.
alter table stripe_webhook_events
  add column if not exists attempts integer not null default 0,
  add column if not exists next_attempt_at timestamptz not null default now();

alter table stripe_webhook_events
  drop constraint if exists stripe_webhook_events_status_check;
alter table stripe_webhook_events
  add constraint stripe_webhook_events_status_check
  check (status in ('pending', 'processing', 'processed', 'failed', 'dead_letter'));

create index if not exists stripe_webhook_events_claim_idx
  on stripe_webhook_events (next_attempt_at, received_at, event_id)
  where status in ('pending', 'failed');
create index if not exists stripe_webhook_events_processing_expired_idx
  on stripe_webhook_events (processing_started_at, event_id)
  where status = 'processing';

-- Un détachement Stripe échoué reste réconciliable sans bloquer le moyen actif.
alter table merchant_payment_methods
  add column if not exists detach_attempts integer not null default 0,
  add column if not exists detach_next_attempt_at timestamptz,
  add column if not exists detach_locked_until timestamptz,
  add column if not exists detach_processing_token uuid;

create index if not exists merchant_payment_methods_detach_claim_idx
  on merchant_payment_methods (detach_next_attempt_at, updated_at, id)
  where status = 'detach_pending' and stripe_payment_method_id is not null;
