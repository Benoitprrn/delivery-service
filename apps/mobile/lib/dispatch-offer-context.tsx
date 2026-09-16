import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { api } from './api';
import type { DispatchOfferCreatedPayload } from './dispatch-types';
import { getSocket } from './socket';
import { supabase } from './supabase';

// Écoute globale (montée une fois par session livreur, voir
// (tabs)/_layout.tsx) plutôt que par écran : une offre de dispatch peut
// arriver pendant que le livreur est sur n'importe quel onglet, pas
// seulement la carte. Réutilise le même singleton getSocket() que les
// autres écrans (même zoneId => même connexion, un abonnement de plus).
//
// Limite connue : si le livreur relance l'app (ou reconnecte le socket)
// pendant qu'une offre lui est déjà active côté serveur, cet événement ne
// sera pas rejoué (ce n'est pas un événement d'état, juste une notification
// ponctuelle) — l'offre reste acceptable/refusable via son deep link tant
// que expiresAt n'est pas dépassé, mais rien ne la re-affiche
// automatiquement dans ce cas. Pas traité dans cette passe.
export function useIncomingDispatchOffer(): void {
  const router = useRouter();
  const activeOfferIdRef = useRef<string | null>(null);
  // useRouter() n'est pas garanti stable d'un rendu à l'autre (dépend de la
  // version d'expo-router / react-navigation) — le mettre en dépendance
  // d'effet ferait se déconnecter/reconnecter l'écoute à chaque rendu de
  // TabsNavigator où la référence change (notamment à chaque bascule de
  // disponibilité, depuis que ce hook lit aussi useAvailability() via son
  // parent), avec une fenêtre où plus personne n'écoute pendant l'aller-
  // retour async de connect(). Une ref capture la dernière valeur sans
  // jamais redéclencher l'effet, qui ne doit se monter qu'une fois.
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    let cancelled = false;
    let activeSocket: Socket | null = null;

    function handleOfferCreated(payload: DispatchOfferCreatedPayload) {
      if (activeOfferIdRef.current === payload.offerId) return;
      activeOfferIdRef.current = payload.offerId;
      routerRef.current.push({ pathname: '/dispatch-offer/[id]', params: { id: payload.offerId } });
    }

    async function connect() {
      const profile = await api.getMyDriverProfile();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token === undefined || cancelled) return;
      activeSocket = getSocket(profile.zoneId, token);
      activeSocket.on('dispatch_offer_created', handleOfferCreated);
    }

    void connect();

    return () => {
      cancelled = true;
      activeSocket?.off('dispatch_offer_created', handleOfferCreated);
    };
  }, []);
}
