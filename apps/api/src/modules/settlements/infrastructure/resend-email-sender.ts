import { EmailSendError } from '../ports/pre-notification.js'
import type { EmailSender, OutgoingEmail } from '../ports/pre-notification.js'

/**
 * Envoi via l'API HTTP de Resend (aucune dépendance). La clé d'API n'est ni journalisée ni recopiée dans les erreurs ; l'en-tête
 * `Idempotency-Key` évite un doublon si la même notification est renvoyée dans les 24 h (reprise de bail après un crash).
 */
export class ResendEmailSender implements EmailSender {
  public constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000
  ) {}

  public async send(email: OutgoingEmail): Promise<{ provider: string; messageId: string }> {
    let response: Response
    try {
      response = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': email.idempotencyKey },
        body: JSON.stringify({ from: this.from, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch {
      throw new EmailSendError('Resend request failed', 'transient')
    }
    if (!response.ok) {
      // 4xx (hors 408/409/429) = refus définitif de CE contenu/destinataire ; le reste est transitoire. Dans les deux cas : retenté avec plafond.
      const rejected = response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status)
      throw new EmailSendError(`Resend responded with status ${response.status}`, rejected ? 'rejected' : 'transient')
    }
    const body = await response.json().catch(() => null) as { id?: unknown } | null
    if (typeof body?.id !== 'string' || body.id === '') throw new EmailSendError('Resend response has no message id', 'transient')
    return { provider: 'resend', messageId: body.id }
  }
}
