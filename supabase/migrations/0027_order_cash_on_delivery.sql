-- Le snapshot COD reste figé dès AVAILABLE. L'encaissement peut seulement être
-- confirmé une fois, y compris dans la transition atomique vers COMPLETED.
alter table public.orders
  add column if not exists cash_on_delivery_required boolean not null default false,
  add column if not exists cash_on_delivery_amount_cents integer null,
  add column if not exists cash_on_delivery_currency text null,
  add column if not exists cash_on_delivery_created_at timestamptz null,
  add column if not exists cash_on_delivery_collected_at timestamptz null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'orders_cash_on_delivery_consistency_check'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_cash_on_delivery_consistency_check check (
        (
          cash_on_delivery_required = false
          and cash_on_delivery_amount_cents is null
          and cash_on_delivery_currency is null
          and cash_on_delivery_created_at is null
          and cash_on_delivery_collected_at is null
        )
        or (
          cash_on_delivery_required = true
          and cash_on_delivery_amount_cents between 100 and 50000
          and cash_on_delivery_currency = 'eur'
          and cash_on_delivery_created_at is not null
        )
      );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'orders_cash_on_delivery_completed_check'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_cash_on_delivery_completed_check check (
        status <> 'COMPLETED'
        or cash_on_delivery_required = false
        or cash_on_delivery_collected_at is not null
      );
  end if;
end
$$;

create or replace function public.prevent_order_cash_on_delivery_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'CREATED'
    and (
      new.cash_on_delivery_required is distinct from old.cash_on_delivery_required
      or new.cash_on_delivery_amount_cents is distinct from old.cash_on_delivery_amount_cents
      or new.cash_on_delivery_currency is distinct from old.cash_on_delivery_currency
      or new.cash_on_delivery_created_at is distinct from old.cash_on_delivery_created_at
    ) then
    raise exception 'cash_on_delivery snapshot is immutable after CREATED';
  end if;

  if old.cash_on_delivery_collected_at is not null
    and new.cash_on_delivery_collected_at is distinct from old.cash_on_delivery_collected_at then
    raise exception 'cash_on_delivery_collected_at can only be set once';
  end if;

  if old.cash_on_delivery_collected_at is null
    and new.cash_on_delivery_collected_at is not null
    and new.cash_on_delivery_required = false then
    raise exception 'cash_on_delivery_collected_at requires cash_on_delivery_required';
  end if;

  return new;
end;
$$;

revoke execute on function public.prevent_order_cash_on_delivery_mutation()
  from anon, authenticated, public;

drop trigger if exists orders_cash_on_delivery_immutable on public.orders;
create trigger orders_cash_on_delivery_immutable
  before update on public.orders
  for each row execute function public.prevent_order_cash_on_delivery_mutation();
