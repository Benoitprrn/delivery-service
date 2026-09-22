// R90 scénario A (1/3) — clôture R40 du lundi 31/08/2026 00:05 Europe/Paris + pré-notifications R41 (e-mails simulés).
import { evidence, log } from './lib.mts'
import { S, closeUseCase, pool, preNotifier, sentEmails, state } from './uc.mts'

const CLOSE_NOW = new Date('2026-08-30T22:05:00Z')
const before = (await pool.query('select count(*)::int as n from settlement_periods')).rows[0].n
const closed = await closeUseCase().execute({ now: CLOSE_NOW })
log('clôture', closed)
const again = await closeUseCase().execute({ now: new Date(CLOSE_NOW.getTime() + 3600_000) })
const period = (await pool.query("select id, period_start, period_end, status, closed_at, debit_date::text as debit_date, payrun_at, promise_deadline, go_live_at_snapshot from settlement_periods where status = 'closed'")).rows
const lines = (await pool.query('select count(*)::int as n, sum(driver_earning_cents)::int as earning, sum(fee_cents)::int as fee from settlement_lines')).rows[0]
const stmts = (await pool.query('select count(*)::int as n, sum(due_cents)::int as due from settlement_statements')).rows[0]
const ms = (await pool.query('select count(*)::int as n, sum(amount_cents)::int as amount from merchant_settlements')).rows[0]
log('agrégats', { period, lines, stmts, ms })
const excluded = (await pool.query("select count(*)::int as n from orders where created_at < (select go_live_at from settlement_settings) and status = 'COMPLETED'")).rows[0].n
const notified = await preNotifier().execute({ now: CLOSE_NOW })
log('pré-notifications', notified)
const notif = (await pool.query("select status, count(*)::int as n from settlement_pre_notifications group by 1")).rows
const sample = sentEmails[0]
evidence('A-close', closed.length === 1 && again.every((x: any) => x.lines === 0 || x.alreadyClosed) ? 'OK' : 'INFO',
  ['DAT-01', 'DAT-02', 'CAL-01', 'PAY-01'],
  { closeResults: closed, replayResults: again, periodsBefore: before, period, lines, statements: stmts, merchantSettlements: ms, excludedPreGoLiveOrders: excluded, preNotifications: notif, emailSample: sample ? { to: sample.to, subject: sample.subject, hasIbanLast4: /\b\d{4}\b/.test(sample.text ?? sample.html ?? '') } : null, emails: sentEmails.length })
await pool.end()
