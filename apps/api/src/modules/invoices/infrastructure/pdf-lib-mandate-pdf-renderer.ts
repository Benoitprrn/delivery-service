import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { MandatePdfRenderer } from '../ports/mandate-pdf-renderer.js'
import { substituteMandateTemplate } from '../domain/mandate-template.js'
export class PdfLibMandatePdfRenderer implements MandatePdfRenderer {
  public async render(input: Parameters<MandatePdfRenderer['render']>[0]): Promise<Buffer> {
    const pdf = await PDFDocument.create(); pdf.setCreationDate(input.acceptedAt); pdf.setModificationDate(input.acceptedAt); pdf.setProducer('Locadely'); pdf.setCreator('Locadely')
    const font = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold); const signature = await pdf.embedPng(input.signatureImage)
    const width = 595.28; const height = 841.89; const margin = 45; const lineHeight = 14; let page = pdf.addPage([width, height]); let y = height - margin
    const addPage = (): void => { page = pdf.addPage([width, height]); y = height - margin }
    const line = (text: string, isBold = false, size = 10): void => { if (y < 110) addPage(); page.drawText(text, { x: margin, y, size, font: isBold ? bold : font, color: rgb(0, 0, 0) }); y -= lineHeight }
    const wrapped = (text: string, size = 10): void => { for (const paragraph of text.split(/\r?\n/)) { const words = paragraph.split(/\s+/); let current = ''; for (const word of words) { const next = current === '' ? word : `${current} ${word}`; if (font.widthOfTextAtSize(next, size) > width - margin * 2 && current !== '') { line(current, false, size); current = word } else current = next } if (current !== '') line(current, false, size); if (paragraph === '') y -= lineHeight } }
    const marker = '{{handwritten_signature}}'; const markerIndex = input.templateText.indexOf(marker); const before = markerIndex === -1 ? input.templateText : input.templateText.slice(0, markerIndex); const after = markerIndex === -1 ? '' : input.templateText.slice(markerIndex + marker.length)
    wrapped(substituteMandateTemplate(before, input.fields))
    if (y < 190) addPage(); const scale = Math.min(180 / signature.width, 70 / signature.height); page.drawImage(signature, { x: margin, y: y - signature.height * scale, width: signature.width * scale, height: signature.height * scale }); y -= signature.height * scale + 20
    wrapped(substituteMandateTemplate(after, input.fields))
    return Buffer.from(await pdf.save({ useObjectStreams: false, addDefaultPage: false }))
  }
}
