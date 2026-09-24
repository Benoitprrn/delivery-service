import type { Pool } from 'pg'
import type { MandateTemplate, MandateTemplateRepository } from '../ports/mandate-template-repository.js'
export class PostgresMandateTemplateRepository implements MandateTemplateRepository {
  public constructor(private readonly pool: Pool) {}
  public async findCurrent(): Promise<MandateTemplate | null> { const row = (await this.pool.query<{ version: number; text: string; text_sha256: string }>('select version, text, text_sha256 from mandate_templates order by version desc limit 1')).rows[0]; return row === undefined ? null : { version: row.version, text: row.text, textSha256: row.text_sha256 } }
}
