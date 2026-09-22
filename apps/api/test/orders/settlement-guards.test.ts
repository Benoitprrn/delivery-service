import { describe, expect, it, vi } from 'vitest'
import { AssignOrderUseCase } from '../../src/modules/orders/application/assign-order.js'
import { CreateOrderUseCase } from '../../src/modules/orders/application/create-order.js'
import { ListAvailableOrdersUseCase } from '../../src/modules/orders/application/list-available-orders.js'
import { DriverPayoutAccountNotReadyError, MerchantOnboardingIncompleteError, MerchantPaymentSetupIncompleteError } from '../../src/modules/orders/domain/errors.js'
import { createMerchantSettlementReadiness } from '../../src/modules/orders/infrastructure/merchant-settlement-readiness.js'
import type { DriverCapacityWriter } from '../../src/modules/orders/ports/driver-capacity-writer.js'
import type { MerchantSettlementReadinessReader } from '../../src/modules/orders/ports/merchant-settlement-readiness.js'
import type { OrderRepository } from '../../src/modules/orders/ports/order-repository.js'
import type { RoutingProvider } from '../../src/modules/orders/ports/routing-provider.js'

const merchant = { id: 'merchant', zoneId: 'zone', name: 'Shop', address: '1 Main Street', phonePrimary: '0600000000', phoneSecondary: null, logoUrl: null, lat: 46.2, lng: 5.22, onboardingCompleted: false }
const zone = { id: 'zone', name: 'Zone', centerLat: 46.2, centerLng: 5.22, radiusKm: 2 }
const command = (over: Record<string, unknown> = {}) => ({
  merchant, zone, customerName: 'Customer', customerPhone: '0', deliveryAddress: '2 Main Street', deliveryLat: 46.21, deliveryLng: 5.23,
  pickupScheduledAt: { mode: 'delay' as const, delayMinutes: 45 }, ...over
})

function createOrderHarness(readiness: MerchantSettlementReadinessReader) {
  const getRoute = vi.fn().mockResolvedValue({ distanceM: 100, durationS: 30 })
  const create = vi.fn().mockResolvedValue({ id: 'order' })
  const useCase = new CreateOrderUseCase({ create } as unknown as OrderRepository, { getRoute } as unknown as RoutingProvider, { now: () => new Date('2026-09-13T10:00:00.000Z') }, { isReady: async () => true }, readiness)
  return { useCase, getRoute, create }
}

describe('D-D — a merchant without settlement setup cannot order', () => {
  it('creates the order when the SEPA mandate is active and legal information is complete', async () => {
    const check = vi.fn().mockResolvedValue({ ready: true })
    const { useCase, create } = createOrderHarness({ check })
    await expect(useCase.execute(command())).resolves.toEqual({ id: 'order' })
    expect(check).toHaveBeenCalledWith('merchant')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it.each(['sepa_not_configured', 'legal_information_incomplete'] as const)('refuses with %s before routing and persistence', async reason => {
    const { useCase, getRoute, create } = createOrderHarness({ check: async () => ({ ready: false, reason }) })
    await expect(useCase.execute(command())).rejects.toMatchObject({ name: 'MerchantPaymentSetupIncomplete', reason })
    await expect(useCase.execute(command())).rejects.toBeInstanceOf(MerchantPaymentSetupIncompleteError)
    expect(getRoute).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it.each([
    ['no primary phone', { phonePrimary: null }],
    ['empty name', { name: '' }],
    ['no address', { address: null }],
    ['no coordinates', { lat: null, lng: null }],
    ['no zone', { zoneId: null }]
  ])('refuses incomplete mandatory information (%s) without even querying the settlement setup', async (_label, over) => {
    const check = vi.fn().mockResolvedValue({ ready: true })
    const { useCase, create } = createOrderHarness({ check })
    await expect(useCase.execute(command({ merchant: { ...merchant, ...over } }))).rejects.toBeInstanceOf(MerchantOnboardingIncompleteError)
    expect(check).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('fails closed when the readiness lookup itself fails: nothing is created', async () => {
    const { useCase, create } = createOrderHarness({ check: async () => { throw new Error('database unavailable') } })
    await expect(useCase.execute(command())).rejects.toThrow('database unavailable')
    expect(create).not.toHaveBeenCalled()
  })
})

describe('D-D adapter — only an explicit true passes', () => {
  const build = (sepa: unknown, legal: unknown) => createMerchantSettlementReadiness({ hasActiveSepaMethod: async () => sepa as boolean, isLegalInformationComplete: async () => legal as boolean })
  it('is ready only with an active SEPA mandate AND complete legal information', async () => {
    await expect(build(true, true).check('m')).resolves.toEqual({ ready: true })
    await expect(build(false, true).check('m')).resolves.toEqual({ ready: false, reason: 'sepa_not_configured' })
    await expect(build(true, false).check('m')).resolves.toEqual({ ready: false, reason: 'legal_information_incomplete' })
  })
  it.each([null, undefined, 'true', 1])('treats the unknown value %j as not ready (fail closed)', async unknown => {
    await expect(build(unknown, true).check('m')).resolves.toMatchObject({ ready: false })
    await expect(build(true, unknown).check('m')).resolves.toMatchObject({ ready: false })
  })
  it('does not query legal information when the SEPA mandate is missing and never swallows infrastructure errors', async () => {
    const legal = vi.fn().mockResolvedValue(true)
    await expect(createMerchantSettlementReadiness({ hasActiveSepaMethod: async () => false, isLegalInformationComplete: legal }).check('m')).resolves.toMatchObject({ ready: false })
    expect(legal).not.toHaveBeenCalled()
    await expect(createMerchantSettlementReadiness({ hasActiveSepaMethod: async () => { throw new Error('db down') }, isLegalInformationComplete: legal }).check('m')).rejects.toThrow('db down')
  })
})

describe('D-F — a driver without a ready payout account gets no delivery', () => {
  const capacity = () => ({ increment: vi.fn().mockResolvedValue(undefined), decrement: vi.fn() }) as unknown as DriverCapacityWriter & { increment: ReturnType<typeof vi.fn> }

  it('assigns an eligible driver and increments its capacity', async () => {
    const assign = vi.fn().mockResolvedValue({ id: 'order' })
    const cap = capacity()
    const useCase = new AssignOrderUseCase({ assign } as unknown as OrderRepository, cap, { isEligible: async () => true })
    await expect(useCase.execute({ orderId: 'o', driverId: 'd', expectedVersion: 1, actor: { type: 'driver', id: 'd' } })).resolves.toEqual({ id: 'order' })
    expect(assign).toHaveBeenCalledTimes(1)
    expect(cap.increment).toHaveBeenCalledWith('d')
  })

  it('refuses an ineligible driver with DriverPayoutAccountNotReady and touches nothing', async () => {
    const assign = vi.fn()
    const cap = capacity()
    const useCase = new AssignOrderUseCase({ assign } as unknown as OrderRepository, cap, { isEligible: async () => false })
    await expect(useCase.execute({ orderId: 'o', driverId: 'd', expectedVersion: 1, actor: { type: 'driver', id: 'd' } })).rejects.toBeInstanceOf(DriverPayoutAccountNotReadyError)
    expect(assign).not.toHaveBeenCalled()
    expect(cap.increment).not.toHaveBeenCalled()
  })

  it('fails closed when the eligibility lookup fails', async () => {
    const assign = vi.fn()
    const useCase = new AssignOrderUseCase({ assign } as unknown as OrderRepository, capacity(), { isEligible: async () => { throw new Error('db down') } })
    await expect(useCase.execute({ orderId: 'o', driverId: 'd', expectedVersion: 1, actor: { type: 'driver', id: 'd' } })).rejects.toThrow('db down')
    expect(assign).not.toHaveBeenCalled()
  })

  it('lists available orders only for an available AND eligible driver', async () => {
    const findAvailableInZone = vi.fn().mockResolvedValue([{ id: 'o1' }])
    const repo = { findAvailableInZone } as unknown as OrderRepository
    await expect(new ListAvailableOrdersUseCase(repo, { isAvailable: async () => true }, { isEligible: async () => true }).execute({ driverId: 'd', zoneId: 'z' })).resolves.toEqual([{ id: 'o1' }])
    findAvailableInZone.mockClear()
    await expect(new ListAvailableOrdersUseCase(repo, { isAvailable: async () => true }, { isEligible: async () => false }).execute({ driverId: 'd', zoneId: 'z' })).resolves.toEqual([])
    await expect(new ListAvailableOrdersUseCase(repo, { isAvailable: async () => false }, { isEligible: async () => true }).execute({ driverId: 'd', zoneId: 'z' })).resolves.toEqual([])
    expect(findAvailableInZone).not.toHaveBeenCalled()
  })
})
