import { Linking } from 'react-native';
import { api, ApiError } from './api';
import { showToast } from './toast';

async function open(fetchUrl: () => Promise<string>, failure: string): Promise<boolean> {
  try {
    const url = await fetchUrl();
    // Navigateur SYSTÈME (jamais une WebView) : l'onboarding et le Dashboard Express Stripe l'exigent.
    await Linking.openURL(url);
    return true;
  } catch (error) {
    showToast(error instanceof ApiError ? error.message : failure);
    return false;
  }
}

// Lien d'onboarding hébergé à usage unique (repli du composant embarqué) : toujours demander un lien neuf.
export function openHostedOnboarding(): Promise<boolean> {
  return open(async () => (await api.createPayoutOnboardingLink()).url, 'Impossible d’ouvrir la configuration Stripe.');
}

// Dashboard Express : espace Stripe complet (transactions, virements, informations du compte).
export function openStripeDashboard(): Promise<boolean> {
  return open(async () => (await api.createPayoutDashboardLink()).url, 'Impossible d’ouvrir votre espace Stripe.');
}

// URL signée courte (générée à la demande, jamais persistée) du PDF de mandat déjà signé.
export function openMandatePdf(): Promise<boolean> {
  return open(async () => (await api.getMandatePdfUrl()).url, 'Impossible d’ouvrir votre mandat signé.');
}

// Facture livreur (Compte → Mes factures) : même URL signée courte que sur l'écran d'une commande.
export function openInvoiceDocument(orderId: string, documentId: string): Promise<boolean> {
  return open(async () => (await api.getInvoiceDocumentFacturXUrl(orderId, documentId, 'invoice')).url, 'Impossible d’ouvrir la facture.');
}
