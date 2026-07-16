/** PDF helper — run a pdfkit builder and collect the output into a Buffer. */
import PDFDocument from 'pdfkit';

export function renderPdf(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      build(doc);
      doc.end();
    } catch (e) {
      reject(e as Error);
    }
  });
}

/** Common Dhanam letterhead used across generated PDFs. */
export function letterhead(doc: PDFKit.PDFDocument, title: string, subtitle?: string): void {
  doc.fillColor('#0b3a6f').fontSize(18).font('Helvetica-Bold').text('Dhanam Investment and Finance', { align: 'left' });
  doc.moveDown(0.2);
  doc.fillColor('#1a1d23').fontSize(13).font('Helvetica-Bold').text(title);
  if (subtitle) doc.fillColor('#6b7380').fontSize(9).font('Helvetica').text(subtitle);
  doc.moveTo(48, doc.y + 6).lineTo(547, doc.y + 6).strokeColor('#e4e7ec').stroke();
  doc.moveDown(1);
  doc.fillColor('#1a1d23');
}
