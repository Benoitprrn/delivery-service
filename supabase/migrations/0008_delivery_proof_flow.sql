alter table orders
  add column delivery_code_hash text null,
  add column delivery_code_plain text null,
  add column delivery_code_generated_at timestamptz null,
  add column delivery_code_expires_at timestamptz null,
  add column delivery_code_failed_attempts smallint not null default 0,
  add column delivery_code_locked_at timestamptz null,
  add column delivery_proof_method text null,
  add constraint orders_delivery_code_failed_attempts_check
    check (delivery_code_failed_attempts between 0 and 3),
  add constraint orders_delivery_proof_method_check
    check (delivery_proof_method in ('code', 'signature', 'photo'));

comment on column orders.delivery_code_plain is
  'TODO: TWILIO — temporary plaintext column: code is exposed to the owning merchant while SMS integration is pending; remove once Twilio is connected.';

alter table order_proof_photos rename to order_proof_assets;
alter table order_proof_assets rename constraint order_proof_photos_pkey to order_proof_assets_pkey;
alter table order_proof_assets drop constraint if exists order_proof_photos_content_check;
alter table order_proof_assets drop constraint if exists order_proof_photos_content_type_check;
alter table order_proof_assets
  add column kind text not null default 'photo',
  add constraint order_proof_assets_kind_check check (kind in ('signature', 'photo')),
  add constraint order_proof_assets_content_type_check check (content_type in ('image/jpeg', 'image/png')),
  add constraint order_proof_assets_content_size_check check (
    (kind = 'photo' and octet_length(content) > 0 and octet_length(content) <= 512000)
    or (kind = 'signature' and octet_length(content) > 0 and octet_length(content) <= 262144)
  );
alter index order_proof_photos_expires_idx rename to order_proof_assets_expires_idx;
