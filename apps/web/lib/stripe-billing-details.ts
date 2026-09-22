export type BillingDetailsInput = {
  name: string
  email: string
  address: { line1: string; line2: string | null; city: string; postalCode: string; countryCode: string }
}

export type StripeBillingDetails = {
  name: string
  email: string
  address: { line1: string; line2: string; city: string; state: string; postal_code: string; country: string }
}

// Le Payment Element est monté avec `fields.billingDetails.address: 'never'` : Stripe.js exige alors que
// TOUS les sous-champs de l'adresse soient passés à confirmSetup, y compris ceux qu'on n'a pas (chaîne
// vide). Sinon il lève « IntegrationError … did not pass … billing_details.address.state » avant tout
// appel réseau. `state` n'existe pas dans nos adresses postales françaises ; `line2` est facultative.
export function toStripeBillingDetails(details: BillingDetailsInput): StripeBillingDetails {
  return {
    name: details.name,
    email: details.email,
    address: {
      line1: details.address.line1,
      line2: details.address.line2 ?? '',
      city: details.address.city,
      state: '',
      postal_code: details.address.postalCode,
      country: details.address.countryCode
    }
  }
}
