import { requestNeededAndroidPermissions, useStripeTerminal } from '@stripe/stripe-terminal-react-native';
import { useMemo, useRef } from 'react';
import { Alert, Platform } from 'react-native';
import { APPROVED_CARD, DECLINED_CARD, DEV_DECLINE_FIRST_SIMULATED_PAYMENT, DEV_PAUSE_AFTER_CONFIRM_MS } from './dev-simulated-card';
import { ReaderError, type ReaderAdapter, type ReaderFamily, type ReaderStatus } from './reader-adapter';

type SdkError = { code?: string; message?: string } | null | undefined;
type SdkReader = { serialNumber?: string | null; deviceType?: string };

const DISCOVERY_TIMEOUT_S = 15;
const DISCOVERY_WAIT_MS = 12_000;

// Codes SDK observés en Sandbox (POC) ou documentés ; tout le reste = `unknown`.
export function mapSdkError(error: SdkError, fallbackKind: ReaderError['kind'] = 'unknown'): ReaderError {
  const code = error?.code ?? '';
  const message = error?.message ?? 'Erreur du lecteur';
  if (code === 'READER_SOFTWARE_UPDATE_FAILED_BATTERY_LOW') return new ReaderError('battery_low', message, code);
  if (code.startsWith('READER_SOFTWARE_UPDATE_FAILED')) return new ReaderError('update_failed', message, code);
  if (code === 'CONNECTION_TOKEN_PROVIDER_ERROR') return new ReaderError('token_error', message, code);
  if (code === 'DECLINED_BY_STRIPE_API' || code === 'DECLINED_BY_READER') return new ReaderError('card_declined', message, code);
  if (code === 'CANCELED') return new ReaderError('collect_canceled', message, code);
  if (code === 'BLUETOOTH_SCAN_TIMED_OUT') return new ReaderError('reader_not_found', message, code);
  if (/NETWORK|OFFLINE|TIMEOUT/i.test(code)) return new ReaderError('network', message, code);
  return new ReaderError(fallbackKind, message, code || undefined);
}

function need(result: { error?: SdkError } | undefined, fallbackKind?: ReaderError['kind']): void {
  if (result?.error) throw mapSdkError(result.error, fallbackKind);
}

// Adaptateur Bluetooth (WisePad 3 en production, lecteur simulé du SDK en
// développement : même chemin de code, seul `simulated` change).
export function useReaderAdapter(family: ReaderFamily, onStatus?: (status: ReaderStatus) => void): ReaderAdapter {
  const readersRef = useRef<SdkReader[]>([]);
  const initializedRef = useRef(false);
  const collectAttemptsRef = useRef(0);
  const emit = useRef(onStatus);
  emit.current = onStatus;
  const notify = (status: ReaderStatus) => emit.current?.(status);

  const terminal = useStripeTerminal({
    onUpdateDiscoveredReaders: (readers) => {
      readersRef.current = readers as SdkReader[];
    },
    onDidStartInstallingUpdate: () => notify({ phase: 'updating', updateProgress: 0 }),
    onDidReportReaderSoftwareUpdateProgress: (progress: string) => notify({ phase: 'updating', updateProgress: Number(progress) })
  });
  const terminalRef = useRef(terminal);
  terminalRef.current = terminal;

  return useMemo<ReaderAdapter>(() => {
    if (family !== 'simulated_bluetooth' && family !== 'bluetooth') {
      throw new Error(`Famille de lecteur non supportée pour l'instant : ${family}`);
    }
    const simulated = family === 'simulated_bluetooth';

    async function ensureInitialized(): Promise<void> {
      if (initializedRef.current) return;
      if (Platform.OS === 'android') {
        const permissions = await requestNeededAndroidPermissions({
          accessFineLocation: { title: 'Localisation', message: 'Requise pour utiliser le lecteur de cartes.', buttonPositive: 'OK' }
        });
        if (permissions.error) throw new ReaderError('permission_denied', 'Autorisez la localisation et les appareils à proximité pour utiliser le lecteur.', permissions.error.code);
      }
      need(await terminalRef.current.initialize());
      initializedRef.current = true;
    }

    async function clearContext(): Promise<void> {
      const t = terminalRef.current;
      const connected = await t.getConnectedReader?.().catch(() => null);
      if (connected) need(await t.disconnectReader());
      need(await t.clearCachedCredentials());
    }

    return {
      family,

      async connect({ locationId, readerSerial }) {
        await ensureInitialized();
        await clearContext();
        readersRef.current = [];
        notify({ phase: 'discovering' });
        const t = terminalRef.current;
        // Le scan Bluetooth continue tant qu'on ne l'annule pas (constaté : BLUETOOTH_SCAN_TIMED_OUT) :
        // on l'annule dès qu'un lecteur (le bon numéro de série s'il est connu) est listé.
        const discovering = t.discoverReaders({ discoveryMethod: 'bluetoothScan', simulated, timeout: DISCOVERY_TIMEOUT_S });
        const startedAt = Date.now();
        // Le simulateur annonce un lecteur par modèle (chipper2X, M2, U200, WisePad 3) : on prend le WisePad 3, modèle cible.
        const pick = () =>
          readersRef.current.find((reader) =>
            readerSerial !== undefined ? reader.serialNumber === readerSerial : !simulated || reader.deviceType === 'wisePad3'
          );
        while (pick() === undefined && Date.now() - startedAt < DISCOVERY_WAIT_MS) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const reader = pick();
        if (reader !== undefined) await t.cancelDiscovering();
        const discovered = await discovering;
        if (reader === undefined) {
          throw new ReaderError('reader_not_found', 'Aucun lecteur trouvé. Allumez-le et rapprochez-le du téléphone.');
        }
        if (!simulated && readerSerial === undefined && readersRef.current.length > 1) {
          throw new ReaderError('multiple_readers', 'Plusieurs lecteurs détectés : choisissez le vôtre.');
        }
        if (discovered.error && !/CANCEL|TIMED_OUT/i.test(String(discovered.error.code))) throw mapSdkError(discovered.error, 'reader_not_found');
        notify({ phase: 'connecting' });
        const connection = await t.connectReader({
          discoveryMethod: 'bluetoothScan',
          reader: reader as Parameters<typeof t.connectReader>[0] extends { reader: infer R } ? R : never,
          locationId,
          autoReconnectOnUnexpectedDisconnect: true
        });
        need(connection);
        notify({ phase: 'connected' });
        return { serial: reader.serialNumber ?? null };
      },

      async collectAndConfirm(paymentIntentClientSecret) {
        const t = terminalRef.current;
        // Test manuel (dev + lecteur simulé uniquement) : 1re carte refusée, suivantes acceptées. La carte simulée persiste : on la fixe à chaque collecte.
        if (__DEV__ && simulated && DEV_DECLINE_FIRST_SIMULATED_PAYMENT) {
          need(await t.setSimulatedCard(collectAttemptsRef.current === 0 ? DECLINED_CARD : APPROVED_CARD));
          collectAttemptsRef.current += 1;
        }
        const retrieved = await t.retrievePaymentIntent(paymentIntentClientSecret);
        need(retrieved);
        if (!retrieved.paymentIntent) throw new ReaderError('unknown', 'PaymentIntent introuvable');
        notify({ phase: 'collecting' });
        const collected = await t.collectPaymentMethod({ paymentIntent: retrieved.paymentIntent });
        need(collected, 'collect_canceled');
        if (!collected.paymentIntent) throw new ReaderError('unknown', 'Collecte incomplète');
        notify({ phase: 'confirming' });
        const confirmed = await t.confirmPaymentIntent({ paymentIntent: collected.paymentIntent });
        need(confirmed);
        if (__DEV__ && simulated && DEV_PAUSE_AFTER_CONFIRM_MS > 0) {
          Alert.alert('TEST — fermeture', 'Carte acceptée. Fermez l’app MAINTENANT (balayez-la dans les apps récentes).');
          await new Promise((resolve) => setTimeout(resolve, DEV_PAUSE_AFTER_CONFIRM_MS));
        }
        notify({ phase: 'connected' });
        // Le SDK expose le statut sous la forme `requiresCapture` ; le serveur reste l'autorité (relit le PI).
        return { status: 'requires_capture' as const };
      },

      async cancelCollection() {
        await terminalRef.current.cancelCollectPaymentMethod();
        notify({ phase: 'connected' });
      },

      async disconnect() {
        const t = terminalRef.current;
        const connected = await t.getConnectedReader?.().catch(() => null);
        if (connected) need(await t.disconnectReader());
        notify({ phase: 'idle' });
      },

      async clearCredentials() {
        need(await terminalRef.current.clearCachedCredentials());
      }
    };
  }, [family]);
}
