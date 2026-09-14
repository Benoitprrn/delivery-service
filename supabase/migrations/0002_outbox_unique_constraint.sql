alter table outbox_event
  add constraint outbox_event_aggregate_version_key unique (aggregate_id, aggregate_version);
