import { buildApp } from './app.js'
import { config } from './platform/config.js'

async function main(): Promise<void> {
  const app = await buildApp()
  await app.listen({ port: config.PORT, host: '0.0.0.0' })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
