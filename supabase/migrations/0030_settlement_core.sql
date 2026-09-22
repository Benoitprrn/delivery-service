create table public.settlement_settings (
  id boolean primary key default true check (id),
  go_live_at timestamptz null,
  fee_rate_bps integer not null default 2000 check (fee_rate_bps between 0 and 10000),
  fee_rule_version integer not null default 1 check (fee_rule_version > 0),
  payrun_delay_business_days integer not null default 7 check (payrun_delay_business_days > 0),
  promise_business_days integer not null default 15 check (promise_business_days > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.settlement_settings (id) values (true);

create function public.guard_settlement_settings() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'la suppression des paramètres de règlement est interdite'; end if;
  if old.go_live_at is not null and new.go_live_at is distinct from old.go_live_at then
    raise exception 'go_live_at est immuable une fois défini';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_settlement_settings() from anon, authenticated, public;
create trigger settlement_settings_guard before update or delete on public.settlement_settings for each row execute function public.guard_settlement_settings();

create table public.settlement_periods (
  id uuid primary key default gen_random_uuid(),
  period_start timestamptz not null,
  period_end timestamptz not null,
  status text not null default 'open' check (status in ('open','closing','closed')),
  closed_at timestamptz null,
  go_live_at_snapshot timestamptz null,
  excluded_orders_count integer not null default 0 check (excluded_orders_count >= 0),
  debit_date date null,
  payrun_at timestamptz null,
  promise_deadline date null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint settlement_periods_range_check check (period_end > period_start),
  constraint settlement_periods_closed_fields_check check (status <> 'closed' or (closed_at is not null and debit_date is not null and payrun_at is not null and promise_deadline is not null and go_live_at_snapshot is not null)),
  constraint settlement_periods_no_overlap exclude using gist (tstzrange(period_start, period_end, '[)') with &&)
);

create function public.guard_settlement_period() returns trigger language plpgsql set search_path = '' as $$
declare configured_go_live_at timestamptz;
begin
  select go_live_at into configured_go_live_at from public.settlement_settings where id = true;
  if (tg_op = 'INSERT' and new.status = 'closed') or (tg_op = 'UPDATE' and new.status = 'closed' and old.status is distinct from 'closed') then
    if configured_go_live_at is null then raise exception 'la clôture exige un go_live_at défini'; end if;
    if new.go_live_at_snapshot is distinct from configured_go_live_at then raise exception 'le snapshot go_live_at doit correspondre aux paramètres de règlement'; end if;
  end if;
  if tg_op = 'UPDATE' and old.status = 'closed' and (new.period_start, new.period_end, new.go_live_at_snapshot) is distinct from (old.period_start, old.period_end, old.go_live_at_snapshot) then
    raise exception 'les bornes et le snapshot d’une période clôturée sont immuables';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_settlement_period() from anon, authenticated, public;
create trigger settlement_periods_guard before insert or update on public.settlement_periods for each row execute function public.guard_settlement_period();

create table public.merchant_settlements (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.settlement_periods(id),
  merchant_id uuid not null references public.merchants(id),
  amount_cents bigint not null check (amount_cents >= 0),
  status text not null default 'pending_notification' check (status in ('pending_notification','notified','debit_scheduled','debit_processing','succeeded','failed')),
  pre_notified_at timestamptz null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (period_id, merchant_id), unique (id, amount_cents), unique (id, period_id, merchant_id)
);

create table public.settlement_statements (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.settlement_periods(id),
  driver_id uuid not null references public.drivers(id),
  merchant_id uuid not null references public.merchants(id),
  merchant_settlement_id uuid not null,
  gross_cents bigint not null check (gross_cents >= 0),
  fee_cents bigint not null check (fee_cents >= 0),
  due_cents bigint not null check (due_cents = gross_cents - fee_cents and due_cents >= 0),
  paid_cents bigint not null default 0 check (paid_cents between 0 and due_cents),
  status text not null default 'unpaid' check (status in ('unpaid','waiting_sepa','succeeded_held','unpaid_restaurant','blocked_driver_account','partial','paid')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (period_id, driver_id, merchant_id), unique (id, period_id, driver_id, merchant_id),
  constraint settlement_statements_merchant_settlement_fk foreign key (merchant_settlement_id, period_id, merchant_id) references public.merchant_settlements(id, period_id, merchant_id),
  constraint settlement_statements_paid_status_check check ((status = 'paid') = (paid_cents = due_cents))
);

create function public.guard_settlement_statement() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.period_id,new.driver_id,new.merchant_id,new.merchant_settlement_id,new.gross_cents,new.fee_cents,new.due_cents) is distinct from (old.period_id,old.driver_id,old.merchant_id,old.merchant_settlement_id,old.gross_cents,old.fee_cents,old.due_cents) then
    raise exception 'les identifiants et montants d’un statement sont immuables';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_settlement_statement() from anon, authenticated, public;
create trigger settlement_statements_guard before update on public.settlement_statements for each row execute function public.guard_settlement_statement();

create table public.settlement_lines (
  id uuid primary key default gen_random_uuid(),
  statement_id uuid not null,
  period_id uuid not null,
  driver_id uuid not null,
  merchant_id uuid not null,
  order_id uuid not null unique references public.orders(id),
  final_status text not null check (final_status in ('COMPLETED','RETURNED')),
  finalized_at timestamptz not null,
  order_created_at timestamptz not null,
  merchant_amount_cents bigint not null check (merchant_amount_cents >= 0),
  driver_earning_cents bigint not null check (driver_earning_cents >= 0),
  fee_rate_bps integer not null check (fee_rate_bps between 0 and 10000),
  fee_rule_version integer not null check (fee_rule_version > 0),
  fee_cents bigint not null check (fee_cents >= 0 and fee_cents = (driver_earning_cents * fee_rate_bps) / 10000),
  net_cents bigint generated always as (driver_earning_cents - fee_cents) stored,
  created_at timestamptz not null default now(),
  constraint settlement_lines_statement_fk foreign key (statement_id,period_id,driver_id,merchant_id) references public.settlement_statements(id,period_id,driver_id,merchant_id)
);

create function public.guard_settlement_line() returns trigger language plpgsql set search_path = '' as $$
declare p record; o record; configured_go_live_at timestamptz;
begin
  if tg_op in ('UPDATE','DELETE') then raise exception 'les lignes de règlement sont append-only'; end if;
  select go_live_at into configured_go_live_at from public.settlement_settings where id = true;
  if configured_go_live_at is null or new.order_created_at < configured_go_live_at then raise exception 'la commande est antérieure à go_live_at ou go_live_at est absent'; end if;
  select period_start, period_end into p from public.settlement_periods where id = new.period_id;
  if not found or new.finalized_at < p.period_start or new.finalized_at >= p.period_end then raise exception 'la finalisation doit appartenir à la période demi-ouverte'; end if;
  select merchant_id, driver_id, status::text, created_at, price_cents, driver_earning_cents, completed_at,
    (select min(created_at) from public.order_events where order_id = new.order_id and to_status = 'RETURNED') as returned_at
  into o from public.orders where id = new.order_id;
  if not found or o.merchant_id <> new.merchant_id or o.driver_id <> new.driver_id or o.status <> new.final_status or o.created_at <> new.order_created_at or o.price_cents <> new.merchant_amount_cents or o.driver_earning_cents <> new.driver_earning_cents then
    raise exception 'la commande ne correspond pas au livreur, restaurant, statut final ou snapshot';
  end if;
  if new.final_status = 'COMPLETED' and (o.completed_at is null or new.finalized_at <> o.completed_at) then raise exception 'la finalisation COMPLETED doit correspondre à completed_at'; end if;
  if new.final_status = 'RETURNED' and (o.returned_at is null or new.finalized_at <> o.returned_at) then raise exception 'la finalisation RETURNED doit correspondre à son événement'; end if;
  return new;
end;
$$;
revoke execute on function public.guard_settlement_line() from anon, authenticated, public;
create trigger settlement_lines_guard before insert or update or delete on public.settlement_lines for each row execute function public.guard_settlement_line();

create function public.assert_settlement_ledger_values(statement_to_check uuid) returns void language plpgsql set search_path = '' as $$
declare s record; lines_gross bigint; lines_fees bigint; statement_amount bigint;
begin
  select * into s from public.settlement_statements where id = statement_to_check;
  if not found then return; end if;
  select coalesce(sum(driver_earning_cents),0), coalesce(sum(fee_cents),0) into lines_gross, lines_fees from public.settlement_lines where statement_id = s.id;
  if s.gross_cents <> lines_gross or s.fee_cents <> lines_fees then raise exception 'les totaux du statement ne correspondent pas à ses lignes'; end if;
  select coalesce(sum(merchant_amount_cents),0) into statement_amount from public.settlement_lines l join public.settlement_statements st on st.id=l.statement_id where st.merchant_settlement_id=s.merchant_settlement_id;
  if (select amount_cents from public.merchant_settlements where id=s.merchant_settlement_id) <> statement_amount then raise exception 'le montant du règlement restaurant ne correspond pas à ses statements'; end if;
end;
$$;
revoke execute on function public.assert_settlement_ledger_values(uuid) from anon, authenticated, public;
create function public.assert_settlement_ledger() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'settlement_lines' then
    perform public.assert_settlement_ledger_values(new.statement_id);
  else
    perform public.assert_settlement_ledger_values(new.id);
  end if;
  return null;
end;
$$;
revoke execute on function public.assert_settlement_ledger() from anon, authenticated, public;
create function public.assert_merchant_settlement_ledger() returns trigger language plpgsql set search_path = '' as $$
declare st record; expected_amount bigint;
begin
  select coalesce(sum(l.merchant_amount_cents),0) into expected_amount
    from public.settlement_statements s join public.settlement_lines l on l.statement_id=s.id
   where s.merchant_settlement_id = new.id;
  if new.amount_cents <> expected_amount then
    raise exception 'le montant du règlement restaurant ne correspond pas à ses statements';
  end if;
  for st in select id from public.settlement_statements where merchant_settlement_id = new.id loop perform public.assert_settlement_ledger_values(st.id); end loop;
  return null;
end;
$$;
revoke execute on function public.assert_merchant_settlement_ledger() from anon, authenticated, public;
create constraint trigger settlement_statements_ledger after insert or update on public.settlement_statements deferrable initially deferred for each row execute function public.assert_settlement_ledger();
create constraint trigger settlement_lines_ledger after insert on public.settlement_lines deferrable initially deferred for each row execute function public.assert_settlement_ledger();
create constraint trigger merchant_settlements_ledger after insert or update on public.merchant_settlements deferrable initially deferred for each row execute function public.assert_merchant_settlement_ledger();

create index settlement_lines_statement_id_idx on public.settlement_lines(statement_id);
create index settlement_lines_period_id_idx on public.settlement_lines(period_id);
create index settlement_statements_period_id_idx on public.settlement_statements(period_id);
create index settlement_statements_driver_status_idx on public.settlement_statements(driver_id, status);
create index settlement_statements_merchant_settlement_id_idx on public.settlement_statements(merchant_settlement_id);
create index merchant_settlements_merchant_id_idx on public.merchant_settlements(merchant_id);

alter table public.settlement_settings enable row level security;
alter table public.settlement_periods enable row level security;
alter table public.merchant_settlements enable row level security;
alter table public.settlement_statements enable row level security;
alter table public.settlement_lines enable row level security;
revoke all privileges on table public.settlement_settings, public.settlement_periods, public.merchant_settlements, public.settlement_statements, public.settlement_lines from anon, authenticated;
