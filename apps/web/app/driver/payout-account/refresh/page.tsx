import { RefreshCcw } from 'lucide-react'

// Page de « refresh_url » Stripe : le lien d'onboarding hébergé a expiré (usage unique, ≈10 min).
// Pas d'appel API ici : aucune session driver n'est disponible dans ce navigateur — l'utilisateur
// doit relancer la demande depuis l'app, qui redemande alors un lien neuf. Bouton de secours vers
// l'app (voir return/page.tsx pour le contexte : un onglet ouvert depuis l'app n'a pas toujours de
// bouton retour évident).
export default function DriverPayoutAccountRefreshPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <RefreshCcw size={48} className="text-amber-600" />
        <h1 className="font-sans-bold text-h2 text-stone-800">Ce lien a expiré</h1>
        <p className="font-sans text-body-lg text-stone-600">
          Retournez dans l’application Locadely Livreur et appuyez à nouveau sur « Ouvrir dans le
          navigateur » pour obtenir un nouveau lien.
        </p>
        <a
          href="deliveryservicedriver://"
          className="mt-2 flex h-touch-comfortable w-full items-center justify-center rounded-lg bg-primary-600 px-6 font-sans-bold text-body-lg text-white"
        >
          Ouvrir l’application
        </a>
      </div>
    </main>
  )
}
