import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // bcrypt (12 rounds, pure-JS via bcryptjs) run several times sequentially
    // in some delivery-code tests; under parallel worker CPU contention the
    // default 5s timeout is too tight.
    testTimeout: 15_000
    // NOTE (essayé puis annulé) : isolate:false semblait prometteur pour
    // réduire la contention CPU responsable du flake occasionnel de
    // test/realtime/outbox-worker.test.ts sous suite complète, mais casse
    // 17/20 fichiers (état de module partagé entre fichiers — pool DB,
    // mocks — qui suppose l'isolation par défaut). Ne pas réessayer sans
    // isoler d'abord précisément quel state est partagé à tort.
  }
})
