/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-deep-module-import',
      comment:
        "Un module de apps/api/src/modules/* ne peut être importé par un autre module que via son public.ts. Import direct d'un fichier interne (domain/, application/, ports/, infrastructure/, transport/) depuis un autre module = violation.",
      severity: 'error',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: {
        path: '^apps/api/src/modules/(?!$1/)[^/]+/',
        pathNot: '^apps/api/src/modules/[^/]+/public\\.ts$'
      }
    },
    {
      name: 'no-circular',
      comment: 'Aucune dépendance circulaire, entre modules ou à l\'intérieur d\'un module.',
      severity: 'error',
      from: {},
      to: { circular: true }
    }
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: require('node:path').join(__dirname, 'apps/api/tsconfig.json') },
    exclude: { path: 'node_modules' }
  }
}
