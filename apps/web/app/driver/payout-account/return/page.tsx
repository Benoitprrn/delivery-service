import { Smartphone } from 'lucide-react'

// Page de retour du lien Stripe hébergé (repli de l'onboarding embarqué, R30/R31). Stripe appelle cette URL
// dès que l'utilisateur QUITTE la session hébergée, qu'il ait soumis des informations ou juste annulé — on ne
// peut donc jamais affirmer ici un succès. Pas d'authentification ni d'appel API : l'app relit l'état réel du
// compte elle-même au retour au premier plan (usePayoutAccount). Lien de secours vers l'app car un onglet de
// navigateur système ouvert depuis l'app n'a pas toujours de bouton retour évident (trouvé en test R90, 2026-09-22).
export default function DriverPayoutAccountReturnPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <Smartphone size={48} className="text-primary-600" />
        <h1 className="font-sans-bold text-h2 text-stone-800">Retour à Locadely</h1>
        <p className="font-sans text-body-lg text-stone-600">
          Vous pouvez fermer cette page et retourner dans l’application Locadely Livreur. Votre compte de
          paiement se met à jour automatiquement — si vous n’avez pas terminé, vous pourrez reprendre où
          vous en étiez.
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
