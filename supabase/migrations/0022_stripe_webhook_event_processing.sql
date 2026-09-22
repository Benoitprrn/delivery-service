-- 0021 may already have been applied with only event_id/received_at.
-- Do not retain Stripe payloads: only the minimal delivery state is needed.
alter table stripe_webhook_events add column if not exists status text;
alter table stripe_webhook_events add column if not exists processing_started_at timestamptz;
alter table stripe_webhook_events add column if not exists processing_token uuid;
alter table stripe_webhook_events add column if not exists processed_at timestamptz;
alter table stripe_webhook_events add column if not exists last_error text;
alter table stripe_webhook_events add column if not exists event_type text;
alter table stripe_webhook_events add column if not exists stripe_object_id text;
alter table stripe_webhook_events add column if not exists merchant_id uuid;
alter table stripe_webhook_events add column if not exists object_status text;

update stripe_webhook_events set status = 'processed' where status is null;
alter table stripe_webhook_events alter column status set default 'processing';
alter table stripe_webhook_events alter column status set not null;
alter table stripe_webhook_events drop constraint if exists stripe_webhook_events_status_check;
alter table stripe_webhook_events add constraint stripe_webhook_events_status_check check (status in ('processing', 'processed', 'failed'));
