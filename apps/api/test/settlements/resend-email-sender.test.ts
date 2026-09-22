import { describe, expect, it, vi } from 'vitest'
import { EmailSendError, ResendEmailSender } from '../../src/modules/settlements/public.js'

const mail = { idempotencyKey: 'settlement-pre-notification-abc', to: 'resto@example.test', subject: 'Sujet', text: 'Texte', html: '<p>Texte</p>' }
const SECRET = 're_test_super_secret_key'
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('ResendEmailSender', () => {
  it('posts the email with the API key and a stable Idempotency-Key, and returns the provider message id', async () => {
    const fetchMock = vi.fn(async () => json(200, { id: 'msg_123' }))
    const sender = new ResendEmailSender(SECRET, 'Locadely <facturation@example.test>', fetchMock as unknown as typeof fetch)
    await expect(sender.send(mail)).resolves.toEqual({ provider: 'resend', messageId: 'msg_123' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${SECRET}`, 'Idempotency-Key': 'settlement-pre-notification-abc' })
    expect(JSON.parse(init.body as string)).toEqual({ from: 'Locadely <facturation@example.test>', to: ['resto@example.test'], subject: 'Sujet', text: 'Texte', html: '<p>Texte</p>' })
  })

  it.each([[500, 'transient'], [429, 'transient'], [409, 'transient'], [422, 'rejected'], [403, 'rejected']])('classifies HTTP %i as %s and never leaks the API key', async (status, kind) => {
    const sender = new ResendEmailSender(SECRET, 'a@example.test', (async () => json(status, { message: `bad ${SECRET}` })) as unknown as typeof fetch)
    const error = await sender.send(mail).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EmailSendError)
    expect((error as EmailSendError).kind).toBe(kind)
    expect(String((error as Error).message)).not.toContain(SECRET)
  })

  it('treats a network failure or a response without message id as a failure, never as sent', async () => {
    const down = new ResendEmailSender(SECRET, 'a@example.test', (async () => { throw new Error(`socket ${SECRET}`) }) as unknown as typeof fetch)
    const error = await down.send(mail).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'transient' })
    expect(String((error as Error).message)).not.toContain(SECRET)
    const noId = new ResendEmailSender(SECRET, 'a@example.test', (async () => json(200, {})) as unknown as typeof fetch)
    await expect(noId.send(mail)).rejects.toBeInstanceOf(EmailSendError)
  })
})
