import { createHash } from 'node:crypto'
import type { MandateTemplate } from '../ports/mandate-template-repository.js'
export function hasValidMandateTemplateHash(template: MandateTemplate): boolean { return createHash('sha256').update(template.text).digest('hex') === template.textSha256 }
export function substituteMandateTemplate(text: string, fields: Record<string, string>): string { let result = text; for (const [key, value] of Object.entries(fields)) result = result.split(`{{${key}}}`).join(value); return result }
