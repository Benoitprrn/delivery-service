export const CREDIT_NOTE_TYPE_CODE = 381 // UNTDID 1001 hypothesis; isolated here pending sandbox confirmation.
// Montants toujours entiers en centimes (règle absolue du monorepo) — cette conversion en chaîne
// décimale pour EN16931 ne doit jamais passer par une division flottante JavaScript (`cents/100`
// peut perdre en précision pour certaines valeurs). BigInt uniquement, de bout en bout.
export function euro(cents: number): string {
  const value = BigInt(cents)
  const whole = value / 100n
  const remainder = value % 100n
  return `${whole}.${remainder.toString().padStart(2, '0')}`
}
const date = (value: Date): string => value.toISOString().slice(0, 10)

export type TransmissionLine = { lineNumber: number; description: string; quantity: string; unit: string | null; unitPriceHtCents: number; lineHtCents: number; lineVatCents: number; vatRateBps: number; vatExemptionReasonText: string | null }
export type TransmissionInvoice = {
  id: string; number: string; invoiceTypeCode: '380' | '389'; issuedAt: Date; currencyCode: string; totalHtCents: number; totalVatCents: number; totalTtcCents: number;
  buyerReference: string | null;
  seller: { legalName: string; siren: string; vatNumber: string | null; addressLine1: string; addressLine2: string | null; postalCode: string; city: string; countryCode: string; electronicAddressScheme: string | null; electronicAddressValue: string | null };
  buyer: { legalName: string; siren: string; vatNumber: string | null; addressLine1: string; addressLine2: string | null; postalCode: string; city: string; countryCode: string; electronicAddress: { scheme: string; value: string } | null };
  paymentTermsText: string; paymentMeansTypeCode: string; lines: TransmissionLine[]; precedingInvoice?: { number: string; issueDate: Date; typeCode: number }
}

function address(input: { addressLine1: string; addressLine2: string | null; postalCode: string; city: string; countryCode: string }) { return { address_line1: input.addressLine1, ...(input.addressLine2 === null ? {} : { address_line2: input.addressLine2 }), post_code: input.postalCode, city: input.city, country_code: input.countryCode } }
// ISO/IEC 6523 ICD "0002" identifie le SIREN/SIRET INSEE (registre français) — convention EN16931/Peppol
// standard, distincte du schéma d'adresse électronique Peppol "0225" utilisé pour electronic_address.
// Nécessaire pour que Super PDP puisse rapprocher automatiquement le vendeur d'un mandat vérifié par
// SIREN (§7.3) : sans cet identifiant structuré, la facture n'expose aucun SIREN exploitable par leur
// moteur de rapprochement, même si le schéma ne le rend pas strictement `required`.
const FR_SIREN_SCHEME = '0002'
function legalRegistrationIdentifier(siren: string): { scheme: string; value: string } { return { scheme: FR_SIREN_SCHEME, value: siren } }
// Trois mentions légales obligatoires en France sur toute facture B2B (BR-FR-05, Code de
// commerce art. L441-10) — confirmées BLOQUANTES par un vrai rejet Schematron en sandbox le
// 2026-09-23 (`[BR-FR-05]-La mention ... est absente`), pas une hypothèse. Textes strictement
// identiques à ceux produits par le propre générateur de facture de test de Super PDP (source
// fiable, déjà validée par leur propre moteur de validation) — jamais rédigés depuis zéro.
const MANDATORY_FR_NOTES = [
  { subject_code: 'PMT', note: 'L’indemnité forfaitaire légale pour frais de recouvrement est de 40 €.' },
  { subject_code: 'PMD', note: 'À défaut de règlement à la date d’échéance, une pénalité de 10 % du net à payer sera applicable immédiatement.' },
  { subject_code: 'AAB', note: 'Aucun escompte pour paiement anticipé.' }
]
export function mapToEnInvoice(invoice: TransmissionInvoice, electronicAddressScheme: string): Record<string, unknown> {
  const sellerAddress = { scheme: invoice.seller.electronicAddressScheme ?? electronicAddressScheme, value: invoice.seller.electronicAddressValue ?? invoice.seller.siren }
  const taxes = new Map<string, { ht: number; vat: number; rate: number; exemption: string | null }>()
  for (const line of invoice.lines) { const key = `${line.vatRateBps}:${line.vatExemptionReasonText ?? ''}`; const old = taxes.get(key) ?? { ht: 0, vat: 0, rate: line.vatRateBps, exemption: line.vatExemptionReasonText }; old.ht += line.lineHtCents; old.vat += line.lineVatCents; taxes.set(key, old) }
  return {
    number: invoice.number, issue_date: date(invoice.issuedAt), type_code: invoice.precedingInvoice === undefined ? Number(invoice.invoiceTypeCode) : CREDIT_NOTE_TYPE_CODE, currency_code: invoice.currencyCode,
    // BT-23 (business_process_type) : rejeté vide par BR-FR-08 (`[BR-FR-08]-La valeur du mode de
    // facturation est absente`, sandbox 2026-09-23) — "M1" reprend la valeur du propre exemple
    // Super PDP (mode mixte biens/services), valeur sûre pour une prestation de service simple.
    process_control: { business_process_type: 'M1', specification_identifier: 'urn:cen.eu:en16931:2017' },
    notes: MANDATORY_FR_NOTES,
    seller: {
      name: invoice.seller.legalName, electronic_address: sellerAddress, postal_address: address(invoice.seller),
      legal_registration_identifier: legalRegistrationIdentifier(invoice.seller.siren),
      // BT-32, toujours le SIREN même vendeur assujetti : satisfait BR-E-02 (une ligne exonérée
      // exige l'identifiant TVA (BT-31) ET/OU l'identifiant d'enregistrement fiscal (BT-32) —
      // un vendeur en franchise en base n'a structurellement pas de numéro de TVA, donc jamais
      // BT-31 seul) sans jamais fabriquer un faux numéro de TVA pour un vendeur qui n'en a pas.
      tax_registration_identifier: invoice.seller.siren,
      ...(invoice.seller.vatNumber === null ? {} : { vat_identifier: invoice.seller.vatNumber })
    },
    buyer: { name: invoice.buyer.legalName, postal_address: address(invoice.buyer), legal_registration_identifier: legalRegistrationIdentifier(invoice.buyer.siren), ...(invoice.buyer.electronicAddress === null ? {} : { electronic_address: invoice.buyer.electronicAddress }), ...(invoice.buyer.vatNumber === null ? {} : { vat_identifier: invoice.buyer.vatNumber }) },
    ...(invoice.buyerReference === null ? {} : { buyer_reference: invoice.buyerReference }),
    // `total_vat_amount` (BT-110) est un objet `{value, currency_code}` (schéma `amount`), pas une
    // simple chaîne décimale comme les autres totaux — confirmé par un vrai appel sandbox
    // `generate_test_invoice` le 2026-09-23, pas une supposition depuis la description du schéma.
    totals: { sum_invoice_lines_amount: euro(invoice.totalHtCents), total_without_vat: euro(invoice.totalHtCents), total_vat_amount: { value: euro(invoice.totalVatCents), currency_code: invoice.currencyCode }, total_with_vat: euro(invoice.totalTtcCents), amount_due_for_payment: euro(invoice.totalTtcCents) },
    vat_break_down: [...taxes.values()].map((tax) => ({ vat_category_code: tax.rate === 0 ? 'E' : 'S', vat_category_rate: (tax.rate / 100).toFixed(2), vat_category_taxable_amount: euro(tax.ht), vat_category_tax_amount: euro(tax.vat), ...(tax.exemption === null ? {} : { vat_exemption_reason: tax.exemption }) })),
    // Le schéma réel de la TVA par ligne s'appelle `line_vat_information`
    // (`invoiced_item_vat_category_code`/`invoiced_item_vat_rate`/`exemption_reason`), pas
    // `vat_category_code`/`vat_category_rate` (ces noms-là n'existent qu'au niveau document,
    // `vat_break_down`) — confirmé par le même appel sandbox réel, pas deviné.
    // `invoiced_quantity_code` (BT-130, unité de mesure) : rejeté absent par BR-23 en sandbox —
    // jamais omis, "C62" (UN/CEFACT, "unité") par défaut pour une prestation de service sans
    // unité physique naturelle (une livraison), cohérent avec le propre exemple Super PDP.
    lines: invoice.lines.map((line) => ({ identifier: String(line.lineNumber), invoiced_quantity: line.quantity, invoiced_quantity_code: line.unit ?? 'C62', net_amount: euro(line.lineHtCents), price_details: { item_net_price: euro(line.unitPriceHtCents), base_quantity: '1' }, item_information: { name: line.description }, vat_information: { invoiced_item_vat_category_code: line.vatRateBps === 0 ? 'E' : 'S', invoiced_item_vat_rate: (line.vatRateBps / 100).toFixed(2), ...(line.vatExemptionReasonText === null ? {} : { exemption_reason: line.vatExemptionReasonText }) } })),
    payment_terms: invoice.paymentTermsText, payment_instructions: { payment_means_type_code: invoice.paymentMeansTypeCode },
    ...(invoice.precedingInvoice === undefined ? {} : { preceding_invoice_references: [{ reference: invoice.precedingInvoice.number, issue_date: date(invoice.precedingInvoice.issueDate), preceding_invoice_type_code: invoice.precedingInvoice.typeCode }] })
  }
}

/** Cumulative projection: event order and duplication have no bearing on the answer. */
export function projectSubmissionStatus(codes: readonly string[]): 'submitted' | 'accepted' | 'rejected' {
  // Statuses not listed here (including payment fr:211/fr:212 and future codes) are retained as
  // raw events but deliberately have no transmission projection.
  if (codes.some((code) => ['api:invalid', 'fr:501', 'api:rejected', 'fr:210', 'fr:213'].includes(code))) return 'rejected'
  if (codes.some((code) => ['api:accepted', 'fr:205', 'fr:209'].includes(code))) return 'accepted'
  return 'submitted'
}
