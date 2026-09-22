import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { api, ApiError } from './api';
import type { PayoutAccountState } from './payout-types';

type PayoutAccountStatus =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; account: PayoutAccountState };

type PayoutAccountContextValue = {
  status: PayoutAccountStatus;
  /** Relit l'état chez le serveur (qui relit Stripe) ; à appeler au retour de l'onboarding. */
  refresh: () => Promise<PayoutAccountState | null>;
};

const PayoutAccountContext = createContext<PayoutAccountContextValue | null>(null);

// Un livreur non authentifié ne charge rien. L'état est relu au montage et à chaque retour au premier plan
// (retour du navigateur système après l'onboarding hébergé), jamais en boucle.
export function PayoutAccountProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [status, setStatus] = useState<PayoutAccountStatus>({ kind: 'loading' });
  const inFlight = useRef<Promise<PayoutAccountState | null> | null>(null);

  const refresh = useCallback((): Promise<PayoutAccountState | null> => {
    if (inFlight.current !== null) return inFlight.current;
    const run = (async () => {
      try {
        const account = await api.getPayoutAccount();
        setStatus({ kind: 'ok', account });
        return account;
      } catch (error) {
        setStatus({ kind: 'error', message: error instanceof ApiError ? error.message : 'Impossible de charger vos paiements.' });
        return null;
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [enabled, refresh]);

  const value = useMemo(() => ({ status, refresh }), [status, refresh]);
  return <PayoutAccountContext.Provider value={value}>{children}</PayoutAccountContext.Provider>;
}

export function usePayoutAccount(): PayoutAccountContextValue {
  const value = useContext(PayoutAccountContext);
  if (value === null) throw new Error('usePayoutAccount doit être utilisé dans PayoutAccountProvider');
  return value;
}
