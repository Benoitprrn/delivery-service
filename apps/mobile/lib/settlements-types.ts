export type DriverDisplayState =
  | 'awaiting_debit'
  | 'debit_in_progress'
  | 'collected_payment_scheduled'
  | 'payment_delayed'
  | 'sent_to_account'
  | 'awaiting_restaurant_payment'
  | 'restaurant_incident'
  | 'account_action_required';

export type DebtorIdentity = { legalName: string; siret: string; address: string };

export type DriverStatementView = {
  statementId: string;
  merchantId: string;
  merchantName: string;
  dueCents: number;
  paidCents: number;
  remainingCents: number;
  displayState: DriverDisplayState;
  expectedPaymentAt: string | null;
  debtor: DebtorIdentity | null;
};

export type DriverPeriodView = {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  closedAt: string | null;
  payrunAt: string | null;
  promiseDeadline: string | null;
  totalCents: number;
  sentCents: number;
  pendingCents: number;
  unpaidByRestaurantCents: number;
  statements: DriverStatementView[];
};

export type DriverSettlementsResponse = {
  generatedAt: string;
  identityVisible: boolean;
  currentWeek: { periodStart: string; periodEnd: string; deliveries: number; estimatedNetCents: number; closesAt: string } | null;
  totals: { totalCents: number; sentCents: number; pendingCents: number; unpaidByRestaurantCents: number };
  periods: DriverPeriodView[];
};
