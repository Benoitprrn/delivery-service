export type DriverEntityType = 'individual' | 'company'
export function derivePayoutReadiness(input: { transfersStatus: string; requirementsState: string; payoutsStatus: string }): 'ready' | 'blocked' {
  return input.transfersStatus === 'active' && input.requirementsState !== 'disabled' && input.requirementsState !== 'past_due' ? 'ready' : 'blocked'
}
