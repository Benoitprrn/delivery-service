import { StripeTerminalProvider } from '@stripe/stripe-terminal-react-native';
import type { ReactElement } from 'react';
import { api } from '../api';

// Le SDK appelle le fournisseur de token à sa demande, PLUSIEURS fois par cycle
// de connexion (constaté : 2 à 4 appels). Le token est toujours demandé pour la
// commande active ; le serveur en dérive le restaurant, le compte Stripe et la
// Location — le mobile n'envoie jamais d'identifiant de compte.
let activeOrderId: string | null = null;

export function setTerminalOrder(orderId: string | null): void {
  activeOrderId = orderId;
}

async function tokenProvider(): Promise<string> {
  if (activeOrderId === null) {
    throw new Error('Aucune commande active pour le lecteur.');
  }
  const { secret } = await api.getTerminalConnectionToken(activeOrderId);
  return secret;
}

export function TerminalProvider({ children }: { children: ReactElement | ReactElement[] }) {
  return (
    <StripeTerminalProvider tokenProvider={tokenProvider} logLevel="none">
      {children}
    </StripeTerminalProvider>
  );
}
