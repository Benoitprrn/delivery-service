-- R41 : pré-notification SEPA du lundi (e-mail Locadely via Resend).
-- Une ligne par règlement restaurant. `merchant_settlements.pre_notified_at` n'est plus qu'un miroir DÉRIVÉ : il ne peut être
-- posé que par le passage d'une notification à `sent` (même montant). Aucun débit (R50) sans notification `sent` d'au moins
-- deux jours calendaires (Europe/Paris) et jamais avant la date de prélèvement annoncée dans l'e-mail.

create table public.settlement_pre_notifications (
  id uuid primary key default gen_random_uuid(),
  merchant_settlement_id uuid not null unique,
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'pending' check (status in ('pending','sending','sent','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  claim_token uuid null,
  lease_expires_at timestamptz null,
  last_error_class text null,
  last_failed_at timestamptz null,
  -- Instantané de ce qui a réellement été envoyé (renseigné à l'envoi réussi uniquement).
  recipient_email text null,
  debit_date date null,
  iban_last4 text null check (iban_last4 ~ '^[0-9A-Za-z]{4}$'),
  mandate_reference text null,
  creditor_id text null,
  provider text null,
  provider_message_id text null,
  sent_at timestamptz null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint settlement_pre_notifications_settlement_fk foreign key (merchant_settlement_id, amount_cents) references public.merchant_settlements(id, amount_cents),
  constraint settlement_pre_notifications_claim_check check ((status = 'sending') = (claim_token is not null and lease_expires_at is not null)),
  constraint settlement_pre_notifications_sent_snapshot_check check (
    (status = 'sent') = (sent_at is not null)
    and (status <> 'sent' or (recipient_email is not null and debit_date is not null and iban_last4 is not null and mandate_reference is not null and creditor_id is not null and provider is not null and provider_message_id is not null))
  ),
  constraint settlement_pre_notifications_notice_check check (status <> 'sent' or debit_date >= (sent_at at time zone 'Europe/Paris')::date + 2)
);
create index settlement_pre_notifications_due_idx on public.settlement_pre_notifications(next_attempt_at) where status in ('pending','failed');

-- Une notification envoyée est un fait : ni modifiable ni supprimable ; le règlement et le montant sont immuables.
create function public.guard_settlement_pre_notification() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'sent' then raise exception 'une pré-notification envoyée est immuable'; end if;
    return old;
  end if;
  if old.status = 'sent' then raise exception 'une pré-notification envoyée est immuable'; end if;
  if (new.merchant_settlement_id, new.amount_cents) is distinct from (old.merchant_settlement_id, old.amount_cents) then
    raise exception 'le règlement et le montant d’une pré-notification sont immuables';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_settlement_pre_notification() from anon, authenticated, public;
create trigger settlement_pre_notifications_guard before update or delete on public.settlement_pre_notifications for each row execute function public.guard_settlement_pre_notification();

-- `sent` => miroir sur le règlement restaurant (date + statut), dans la MÊME transaction.
create function public.mirror_settlement_pre_notification() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'sent' and (tg_op = 'INSERT' or old.status is distinct from 'sent') then
    update public.merchant_settlements
       set pre_notified_at = new.sent_at, status = case when status = 'pending_notification' then 'notified' else status end, updated_at = now()
     where id = new.merchant_settlement_id;
  end if;
  return null;
end;
$$;
revoke execute on function public.mirror_settlement_pre_notification() from anon, authenticated, public;
create trigger settlement_pre_notifications_mirror after insert or update on public.settlement_pre_notifications for each row execute function public.mirror_settlement_pre_notification();

-- `pre_notified_at` : jamais posé à la main, jamais modifié, jamais sans notification `sent` de même montant.
create function public.guard_merchant_settlement_pre_notified_at() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.pre_notified_at is not null then raise exception 'pre_notified_at exige une pré-notification envoyée'; end if;
    return new;
  end if;
  if new.pre_notified_at is distinct from old.pre_notified_at then
    if old.pre_notified_at is not null then raise exception 'pre_notified_at est immuable une fois posé'; end if;
    if new.pre_notified_at is null or not exists (
      select 1 from public.settlement_pre_notifications n
       where n.merchant_settlement_id = new.id and n.amount_cents = new.amount_cents and n.status = 'sent' and n.sent_at = new.pre_notified_at
    ) then raise exception 'pre_notified_at exige une pré-notification envoyée de même montant'; end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_merchant_settlement_pre_notified_at() from anon, authenticated, public;
create trigger merchant_settlements_pre_notified_at_guard before insert or update on public.merchant_settlements for each row execute function public.guard_merchant_settlement_pre_notified_at();

-- Garde du débit : notification `sent` du règlement (le montant est verrouillé par les clés étrangères des deux tables), ≥ 2 jours calendaires (Europe/Paris) avant le débit, et pas avant
-- la date annoncée dans l'e-mail.
create or replace function public.guard_debit_pre_notification() returns trigger language plpgsql set search_path = '' as $$
declare n record; debit_day date;
begin
  select * into n from public.settlement_pre_notifications
   where merchant_settlement_id = new.merchant_settlement_id and status = 'sent';
  if not found then
    raise exception 'le débit exige une pré-notification envoyée (au moins deux jours calendaires avant)';
  end if;
  debit_day := (new.created_at at time zone 'Europe/Paris')::date;
  if (n.sent_at at time zone 'Europe/Paris')::date > debit_day - 2 then
    raise exception 'le débit exige une pré-notification datant d’au moins deux jours calendaires';
  end if;
  if debit_day < n.debit_date then
    raise exception 'le débit ne peut pas précéder la date de prélèvement annoncée dans la pré-notification';
  end if;
  return new;
end;
$$;

alter table public.settlement_pre_notifications enable row level security;
revoke all privileges on table public.settlement_pre_notifications from anon, authenticated;
