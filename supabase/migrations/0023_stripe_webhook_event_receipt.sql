-- A verified Stripe event is acknowledged only after this minimal durable receipt.
-- The raw webhook payload is deliberately never stored.
alter table stripe_webhook_events
  add column if not exists event_type text,
  add column if not exists stripe_object_id text,
  add column if not exists merchant_id uuid,
  add column if not exists object_status text;

-- Les anciennes réceptions ne contenaient pas les métadonnées désormais requises.
update stripe_webhook_events
set
  event_type = coalesce(event_type, 'legacy.webhook_receipt'),
  stripe_object_id = coalesce(stripe_object_id, 'legacy:' || event_id),
  status = 'processed',
  processed_at = coalesce(processed_at, received_at)
where event_type is null or stripe_object_id is null;

alter table stripe_webhook_events alter column event_type set not null;
alter table stripe_webhook_events alter column stripe_object_id set not null;
alter table stripe_webhook_events drop constraint if exists stripe_webhook_events_status_check;
alter table stripe_webhook_events add constraint stripe_webhook_events_status_check check (status in ('pending', 'processing', 'processed', 'failed'));
create index if not exists stripe_webhook_events_pending_idx
  on stripe_webhook_events (received_at, event_id)
  where status in ('pending', 'failed', 'processing');
