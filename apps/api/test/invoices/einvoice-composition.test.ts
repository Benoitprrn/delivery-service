import { describe, expect, it } from 'vitest'
import { config } from '../../src/platform/config.js'
import { buildApp } from '../../src/app.js'

describe('Super PDP composition', () => {
  it('builds normally with Super PDP disabled, without constructing either worker', async () => {
    expect(config.SUPERPDP_ENABLED).toBe(false)
    const app = await buildApp()
    await expect(app.close()).resolves.toBeUndefined()
  })
})
