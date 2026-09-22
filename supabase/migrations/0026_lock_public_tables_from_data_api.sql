-- Les tables public sont exposables par la Data API Supabase. L'API métier
-- accède directement à PostgreSQL avec postgres, jamais via la Data API.
-- Chaque future migration qui crée une table public doit aussi exécuter
-- explicitement "enable row level security" sur cette table.
do $$
declare
  relation record;
  routine record;
begin
  for relation in
    select class.oid, namespace.nspname, class.relname
    from pg_class as class
    join pg_namespace as namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relkind in ('r', 'p')
  loop
    execute format(
      'alter table %I.%I enable row level security',
      relation.nspname,
      relation.relname
    );
    execute format(
      'revoke all privileges on table %I.%I from anon, authenticated',
      relation.nspname,
      relation.relname
    );
  end loop;

  for relation in
    select class.oid, namespace.nspname, class.relname
    from pg_class as class
    join pg_namespace as namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relkind = 'S'
  loop
    execute format(
      'revoke all privileges on sequence %I.%I from anon, authenticated',
      relation.nspname,
      relation.relname
    );
  end loop;

  for routine in
    select procedure.oid::regprocedure as identity, procedure.prokind
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
  loop
    if routine.prokind = 'p' then
      execute format(
        'revoke execute on procedure %s from anon, authenticated, public',
        routine.identity
      );
    else
      -- EXECUTE est accordé à PUBLIC par défaut : anon et authenticated
      -- l'hériteraient sinon, même après leur révocation directe.
      execute format(
        'revoke execute on function %s from anon, authenticated, public',
        routine.identity
      );
    end if;
  end loop;
end
$$;

alter default privileges for role postgres in schema public
  revoke all privileges on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all privileges on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all privileges on functions from anon, authenticated;
-- EXECUTE est accordé à PUBLIC par défaut sur les nouvelles fonctions.
alter default privileges for role postgres in schema public
  revoke execute on functions from public;

-- Supabase hébergé peut interdire à postgres de modifier les privilèges par
-- défaut de supabase_admin ; la migration reste alors applicable.
do $$
begin
  alter default privileges for role supabase_admin in schema public
    revoke all privileges on tables from anon, authenticated;
  alter default privileges for role supabase_admin in schema public
    revoke all privileges on sequences from anon, authenticated;
  alter default privileges for role supabase_admin in schema public
    revoke all privileges on functions from anon, authenticated;
  alter default privileges for role supabase_admin in schema public
    revoke execute on functions from public;
exception
  when insufficient_privilege then
    raise notice 'Privilèges par défaut de supabase_admin inchangés : droit insuffisant';
end
$$;
