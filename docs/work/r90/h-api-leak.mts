import fs from 'node:fs'
import { CREDENTIALS_FILE, api, evidence, log, signIn } from './lib.mts'
const creds = Object.fromEntries(fs.readFileSync(CREDENTIALS_FILE, 'utf8').trim().split('\n').map((l) => l.split(' ') as [string, string]))
const d = await api('GET', '/api/v1/drivers/me/settlements', await signIn('r90.driver@locadely.test', creds['r90.driver@locadely.test']!))
const keys = new Set<string>(); const walk = (o: any) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { keys.add(k); walk(v) } }; walk(d.json)
const identityKeys = [...keys].filter((k) => /legal|siret|vat|tva|address|adresse|email|phone|iban|acct|stripe|mandate/i.test(k))
log('clés du payload livreur', [...keys].sort().join(','))
const ok = identityKeys.length === 0 && d.json.identityVisible === false
evidence('H-api-driver-identity-check', ok ? 'OK' : 'KO', ['LEG-11', 'MOB-13'], { identityVisible: d.json.identityVisible, sensitiveKeysFound: identityKeys, keys: [...keys].sort(), note: 'le nom commercial du restaurant est affiché par statement (voulu : « Restaurant concerné ») ; aucune identité légale/coordonnée/Stripe' })
