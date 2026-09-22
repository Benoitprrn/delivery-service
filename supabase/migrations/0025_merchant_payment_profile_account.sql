-- Migration Customer v1 vers Account v2 customer-configured.
-- Une conversion cus_ -> acct_ exige un cutover Stripe séparé : ne jamais la faire ici.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'merchant_payment_profiles' and column_name = 'stripe_customer_id'
  ) then
    if exists (select 1 from merchant_payment_profiles where stripe_customer_id !~ '^acct_') then
      raise exception 'merchant_payment_profiles contient des identifiants Stripe non acct_; un cutover séparé est requis';
    end if;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'merchant_payment_profiles' and column_name = 'stripe_customer_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'merchant_payment_profiles' and column_name = 'stripe_account_id'
  ) then
    alter table merchant_payment_profiles rename column stripe_customer_id to stripe_account_id;
  end if;

  if exists (select 1 from pg_class where relname = 'merchant_payment_profiles_stripe_customer_id_key')
    and not exists (select 1 from pg_class where relname = 'merchant_payment_profiles_stripe_account_id_key') then
    alter index merchant_payment_profiles_stripe_customer_id_key rename to merchant_payment_profiles_stripe_account_id_key;
  end if;
end $$;
