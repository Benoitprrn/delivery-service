import { describe, expect, it } from 'vitest'
import { pool } from '../../src/platform/db.js'

const dataApiRoles = ['anon', 'authenticated'] as const
const tablePrivileges = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] as const

describe('verrouillage Data API des tables public', () => {
  it('active RLS sur toutes les tables ordinaires public', async () => {
    const result = await pool.query<{ table_name: string }>(`
      select class.relname as table_name
      from pg_class as class
      join pg_namespace as namespace on namespace.oid = class.relnamespace
      where namespace.nspname = 'public'
        and class.relkind in ('r', 'p')
        and not class.relrowsecurity
    `)

    expect(result.rows).toEqual([])
  })

  it('retire tous les privilèges de table aux rôles Data API', async () => {
    const result = await pool.query<{ table_name: string; role_name: string; privilege: string }>(`
      select class.relname as table_name, role_name, privilege
      from pg_class as class
      join pg_namespace as namespace on namespace.oid = class.relnamespace
      cross join unnest($1::name[]) as role_name
      cross join unnest($2::text[]) as privilege
      where namespace.nspname = 'public'
        and class.relkind in ('r', 'p')
        and has_table_privilege(role_name, class.oid, privilege)
    `, [dataApiRoles, tablePrivileges])

    expect(result.rows).toEqual([])
  })

  it('retire tous les privilèges de séquence aux rôles Data API', async () => {
    const result = await pool.query<{ sequence_name: string; role_name: string; privilege: string }>(`
      select class.relname as sequence_name, role_name, privilege
      from pg_class as class
      join pg_namespace as namespace on namespace.oid = class.relnamespace
      cross join unnest($1::name[]) as role_name
      cross join unnest(array['usage', 'select', 'update']::text[]) as privilege
      where namespace.nspname = 'public'
        and class.relkind = 'S'
        and has_sequence_privilege(role_name, class.oid, privilege)
    `, [dataApiRoles])

    expect(result.rows).toEqual([])
  })

  it('retire EXECUTE aux rôles Data API sur les fonctions public', async () => {
    const result = await pool.query<{ function_name: string; role_name: string }>(`
      select procedure.oid::regprocedure::text as function_name, role_name
      from pg_proc as procedure
      join pg_namespace as namespace on namespace.oid = procedure.pronamespace
      cross join unnest($1::name[]) as role_name
      where namespace.nspname = 'public'
        and has_function_privilege(role_name, procedure.oid, 'execute')
    `, [dataApiRoles])

    expect(result.rows).toEqual([])
  })

  it('laisse service_role lire orders', async () => {
    const result = await pool.query<{ allowed: boolean }>(
      "select has_table_privilege('service_role', 'public.orders', 'select') as allowed"
    )

    expect(result.rows[0]?.allowed).toBe(true)
  })

  it.each(dataApiRoles)('refuse la lecture de orders au rôle %s', async role => {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(`set local role ${role}`)
      await expect(client.query('select 1 from public.orders limit 1')).rejects.toMatchObject({ code: '42501' })
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
  })

  it('retire les privilèges par défaut de postgres', async () => {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query('create table public.__lockdown_probe (id integer)')
      const result = await client.query<{ role_name: string; privilege: string }>(`
        select role_name, privilege
        from unnest($1::name[]) as role_name
        cross join unnest($2::text[]) as privilege
        where has_table_privilege(role_name, 'public.__lockdown_probe', privilege)
      `, [dataApiRoles, tablePrivileges])

      expect(result.rows).toEqual([])
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
  })

  it('laisse postgres lire et écrire orders', async () => {
    await expect(pool.query('select count(*) from public.orders')).resolves.toBeDefined()
    await expect(pool.query('update public.orders set id = id where false')).resolves.toBeDefined()
  })
})
