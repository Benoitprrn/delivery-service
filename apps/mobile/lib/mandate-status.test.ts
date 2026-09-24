import { describe, expect, it } from 'vitest'
import { deriveMandateUi } from './mandate-status'
import type { MandateStatus } from './mandate-types'

const base: MandateStatus = {
  mandateExists: false,
  providerVerificationStatus: null,
  submissionStatus: null,
  lastError: null,
  drift: null,
  template: { text: 't', version: 1 },
  liveLegalInformation: null,
  blockedReason: null,
  previewText: 'preview'
}

describe('deriveMandateUi', () => {
  it('shows a loading state while the status has not loaded yet', () => {
    expect(deriveMandateUi(null).title).toBe('Mandat de facturation')
  })

  it.each([
    ['legal_information_missing', 'complete-profile'],
    ['driver_name_missing', 'complete-profile'],
    ['template_not_configured', 'none'],
    ['platform_identity_missing', 'none']
  ] as const)('explains a blocked prerequisite (%s) without ever offering to sign', (reason, action) => {
    const ui = deriveMandateUi({ ...base, blockedReason: reason })
    expect(ui.action).toBe(action)
    expect(ui.tone).toBe('warning')
  })

  it('offers to sign when nothing is blocked and no mandate exists yet', () => {
    const ui = deriveMandateUi({ ...base })
    expect(ui.action).toBe('sign')
    expect(ui.tone).toBe('neutral')
  })

  it('never offers to sign once a mandate already exists, even if not yet submitted', () => {
    const ui = deriveMandateUi({ ...base, mandateExists: true, providerVerificationStatus: 'not_submitted', submissionStatus: 'prepared' })
    expect(ui.action).toBe('none')
    expect(ui.title).toBe('Envoi en cours')
  })

  it('shows "Envoi en cours" while the submission worker has not finished submitting yet', () => {
    for (const submissionStatus of ['prepared', 'submitting', 'retryable'] as const) {
      const ui = deriveMandateUi({ ...base, mandateExists: true, providerVerificationStatus: 'not_submitted', submissionStatus })
      expect(ui.title).toBe('Envoi en cours')
    }
  })

  it('shows "Vérification en cours" once submitted but not yet verified', () => {
    for (const providerVerificationStatus of ['submitted', 'not_verified'] as const) {
      const ui = deriveMandateUi({ ...base, mandateExists: true, providerVerificationStatus, submissionStatus: 'submitted' })
      expect(ui.title).toBe('Vérification en cours')
    }
  })

  it('shows a clear success state once verified', () => {
    const ui = deriveMandateUi({ ...base, mandateExists: true, providerVerificationStatus: 'verified', submissionStatus: 'submitted' })
    expect(ui.tone).toBe('success')
    expect(ui.title).toBe('Mandat vérifié')
  })

  it('shows "Action requise" (never a raw provider code) on unknown_outcome or failed submission, with no retry action', () => {
    for (const submissionStatus of ['unknown_outcome', 'failed'] as const) {
      const ui = deriveMandateUi({ ...base, mandateExists: true, providerVerificationStatus: 'not_submitted', submissionStatus })
      expect(ui.tone).toBe('danger')
      expect(ui.title).toBe('Action requise')
      expect(ui.action).toBe('none')
      expect(ui.description).not.toMatch(/unknown_outcome|not_submitted|provider_mandate_id/)
    }
  })

  it('shows "Action requise" when the provider rejects the mandate', () => {
    const ui = deriveMandateUi({ ...base, mandateExists: true, providerVerificationStatus: 'rejected', submissionStatus: 'submitted' })
    expect(ui.tone).toBe('danger')
    expect(ui.action).toBe('none')
  })

  it('surfaces a non-blocking drift note alongside the main status, only once a mandate exists', () => {
    const ui = deriveMandateUi({ ...base, mandateExists: true, providerVerificationStatus: 'verified', submissionStatus: 'submitted', drift: { drifted: true, changedFields: ['siret'] } })
    expect(ui.driftNote).not.toBeNull()
    expect(ui.tone).toBe('success') // drift is informational, never overrides the main tone/action
    expect(ui.action).toBe('none')
  })

  it('never shows a drift note before any mandate has ever been signed', () => {
    const ui = deriveMandateUi({ ...base, mandateExists: false, drift: { drifted: true, changedFields: ['siret'] } })
    expect(ui.driftNote).toBeNull()
  })

  it('never leaks jargon strings in any produced title/description across every reachable state', () => {
    const statuses: MandateStatus[] = [
      { ...base },
      { ...base, blockedReason: 'legal_information_missing' },
      { ...base, mandateExists: true, providerVerificationStatus: 'not_submitted', submissionStatus: 'prepared' },
      { ...base, mandateExists: true, providerVerificationStatus: 'submitted', submissionStatus: 'submitted' },
      { ...base, mandateExists: true, providerVerificationStatus: 'verified', submissionStatus: 'submitted' },
      { ...base, mandateExists: true, providerVerificationStatus: 'not_submitted', submissionStatus: 'unknown_outcome' }
    ]
    for (const status of statuses) {
      const ui = deriveMandateUi(status)
      expect(`${ui.title} ${ui.description}`).not.toMatch(/not_verified|provider_mandate_id|unknown_outcome|not_submitted/)
    }
  })
})
