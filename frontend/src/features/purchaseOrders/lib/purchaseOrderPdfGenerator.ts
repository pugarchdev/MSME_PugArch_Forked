import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { drawFitImage, loadImageAsDataUrl, moneyPdf, sanitizePdfText } from '../../../lib/pdfEngine';

export interface PurchaseOrderItemData {
  itemIndex: number;
  productCode: string;
  name: string;
  specs?: string;
  hsn: string;
  quantity: number | string;
  unit: string;
  unitPrice: number;
  total: number;
}

export interface PurchaseOrderPdfData {
  poNumber: string;
  poDate: string;
  dueDate: string;
  status: string;
  shipVia: string;
  trackingNumber: string;
  paymentTerms: string;

  // Top issuer branding
  issuerName: string;
  issuerSubtitle?: string;
  issuerLogoUrl?: string | null;

  // Buyer details
  buyer: {
    name: string;
    contactName?: string;
    address: string;
    gstin: string;
    pan: string;
    phone: string;
    email: string;
    logoUrl?: string | null;
    stampUrl?: string | null;
    signatureUrl?: string | null;
  };

  // Seller / Vendor details
  seller: {
    name: string;
    contactName?: string;
    address: string;
    udyamNumber?: string;
    gstin: string;
    pan: string;
    phone: string;
    email: string;
    logoUrl?: string | null;
    stampUrl?: string | null;
    signatureUrl?: string | null;
  };

  items: PurchaseOrderItemData[];

  financials: {
    subtotal: number;
    shipping: number;
    taxAmount: number;
    taxLabel?: string;
    grandTotal: number;
  };

  notes?: string[];
}

export async function generateOfficialPurchaseOrderPdf(data: PurchaseOrderPdfData): Promise<jsPDF> {
  const doc = new jsPDF({
    unit: 'mm',
    format: 'a4',
    orientation: 'p',
  });

  const pageWidth = doc.internal.pageSize.getWidth(); // 210mm
  const pageHeight = doc.internal.pageSize.getHeight(); // 297mm
  const marginX = 12;
  const contentWidth = pageWidth - marginX * 2; // 186mm
  const rightX = marginX + contentWidth; // 198mm

  const effectiveBuyerStampUrl = data.buyer.stampUrl || data.buyer.logoUrl || null;
  const effectiveSellerStampUrl = data.seller.stampUrl || data.seller.logoUrl || null;

  // Pre-load all branding imagery in parallel
  const [
    issuerLogoData,
    buyerLogoData,
    sellerLogoData,
    buyerStampData,
    buyerSigData,
    sellerStampData,
    sellerSigData,
  ] = await Promise.all([
    loadImageAsDataUrl(data.issuerLogoUrl || data.buyer.logoUrl),
    loadImageAsDataUrl(data.buyer.logoUrl),
    loadImageAsDataUrl(data.seller.logoUrl),
    loadImageAsDataUrl(effectiveBuyerStampUrl),
    loadImageAsDataUrl(data.buyer.signatureUrl),
    loadImageAsDataUrl(effectiveSellerStampUrl),
    loadImageAsDataUrl(data.seller.signatureUrl),
  ]);

  let currentY = 12;

  // Draw crisp outer border around page content
  doc.setDrawColor(20, 20, 20);
  doc.setLineWidth(0.4);

  // ─────────────────────────────────────────────────────────────
  // 1. TOP HEADER: Organization branding (left) & PURCHASE ORDER (right)
  // ─────────────────────────────────────────────────────────────
  const headerY = currentY;
  const logoSize = 14;
  let textStartX = marginX;

  if (issuerLogoData) {
    drawFitImage(doc, issuerLogoData, marginX, headerY, logoSize, logoSize, 'left');
    textStartX = marginX + logoSize + 3;
  }

  // Issuer Name & Subtitle (Left)
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  const maxTitleWidth = contentWidth - 75;
  const titleLines = doc.splitTextToSize((data.issuerName || 'PURCHASE ORDER').toUpperCase(), maxTitleWidth);
  let leftY = headerY + 4.5;
  if (titleLines.length > 1) {
    doc.text(titleLines[0], textStartX, leftY);
    leftY += 4.5;
    doc.text(titleLines[1], textStartX, leftY);
    leftY += 4;
  } else {
    doc.text(titleLines[0] || data.issuerName, textStartX, leftY);
    leftY += 5;
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(data.issuerSubtitle || 'Official Purchase Order Document', textStartX, leftY);

  // Document Title & PO Number (Right)
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('PURCHASE ORDER', rightX, headerY + 5.5, { align: 'right' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(51, 65, 85);
  doc.text(data.poNumber, rightX, headerY + 11, { align: 'right' });

  if (data.status) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(`Status: ${data.status}`, rightX, headerY + 15, { align: 'right' });
  }

  currentY = Math.max(leftY + 5, headerY + 17);

  // Thin separator rule below header
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.3);
  doc.line(marginX, currentY, rightX, currentY);
  currentY += 3;

  // ─────────────────────────────────────────────────────────────
  // 2. TABLE 1: VENDOR & PO INFO (4-Column Enterprise Grid)
  // ─────────────────────────────────────────────────────────────
  const sellerPhoneEmail = [data.seller.phone, data.seller.email].filter(Boolean).join(' | ');
  const sellerTax = `GSTIN: ${data.seller.gstin || 'N/A'}${data.seller.pan ? ` | PAN: ${data.seller.pan}` : ''}`;

  autoTable(doc, {
    startY: currentY,
    theme: 'grid',
    margin: { left: marginX, right: marginX },
    tableWidth: contentWidth,
    head: [],
    body: [
      [
        { content: 'Vendor Name:', styles: { fontStyle: 'bold', fillColor: [248, 250, 252], cellWidth: 28 } },
        { content: data.seller.name + (data.seller.contactName ? `\nContact: ${data.seller.contactName}` : ''), styles: { fontStyle: 'bold', cellWidth: 65 } },
        { content: 'PO Date:', styles: { fontStyle: 'bold', fillColor: [248, 250, 252], cellWidth: 28 } },
        { content: data.poDate, styles: { cellWidth: 65 } },
      ],
      [
        { content: 'Vendor Address:', styles: { fontStyle: 'bold', fillColor: [248, 250, 252] } },
        { content: data.seller.address || 'N/A' },
        { content: 'Udyam Reg. No.:', styles: { fontStyle: 'bold', fillColor: [248, 250, 252] } },
        { content: data.seller.udyamNumber || 'N/A', styles: { fontStyle: 'bold' } },
      ],
      [
        { content: 'Vendor Tax Info:', styles: { fontStyle: 'bold', fillColor: [248, 250, 252] } },
        { content: sellerTax },
        { content: 'Vendor Contact:', styles: { fontStyle: 'bold', fillColor: [248, 250, 252] } },
        { content: sellerPhoneEmail || 'N/A' },
      ],
    ],
    styles: {
      fontSize: 7.5,
      cellPadding: 2,
      textColor: [15, 23, 42],
      lineColor: [0, 0, 0],
      lineWidth: 0.25,
      valign: 'middle',
    },
    didDrawCell: (hookData) => {
      // Draw small vendor logo in Vendor Name cell if available
      if (sellerLogoData && hookData.row.index === 0 && hookData.column.index === 1) {
        const logoBadgeSize = 6;
        const lx = hookData.cell.x + hookData.cell.width - logoBadgeSize - 1.5;
        const ly = hookData.cell.y + 1.5;
        drawFitImage(doc, sellerLogoData, lx, ly, logoBadgeSize, logoBadgeSize, 'right');
      }
    },
  });

  currentY = (doc as any).lastAutoTable.finalY + 3;

  // ─────────────────────────────────────────────────────────────
  // 3. TABLE 2: SHIP TO & SHIPPING DETAILS (4-Column Enterprise Grid)
  // ─────────────────────────────────────────────────────────────
  autoTable(doc, {
    startY: currentY,
    theme: 'grid',
    margin: { left: marginX, right: marginX },
    tableWidth: contentWidth,
    head: [],
    body: [
      [
        { content: 'Ship To:', styles: { fontStyle: 'bold', fillColor: [248, 250, 252], cellWidth: 28 } },
        { content: data.buyer.name + (data.buyer.contactName ? `\nAttn: ${data.buyer.contactName}` : ''), styles: { fontStyle: 'bold', cellWidth: 65 } },
        { content: 'Ship Via:', styles: { fontStyle: 'bold', fillColor: [248, 250, 252], cellWidth: 28 } },
        { content: data.shipVia || 'Standard Ground Logistics', styles: { cellWidth: 65 } },
      ],
      [
        { content: 'Delivery Address:', styles: { fontStyle: 'bold', fillColor: [248, 250, 252] } },
        { content: data.buyer.address || 'N/A' },
        { content: 'Tracking Number:', styles: { fontStyle: 'bold', fillColor: [248, 250, 252] } },
        { content: data.trackingNumber || 'Pending Dispatch', styles: { fontStyle: 'bold' } },
      ],
      [
        { content: 'Buyer GSTIN:', styles: { fontStyle: 'bold', fillColor: [248, 250, 252] } },
        { content: data.buyer.gstin || 'N/A' },
        { content: 'Due Date:', styles: { fontStyle: 'bold', fillColor: [248, 250, 252] } },
        { content: data.dueDate || 'N/A' },
      ],
    ],
    styles: {
      fontSize: 7.5,
      cellPadding: 2,
      textColor: [15, 23, 42],
      lineColor: [0, 0, 0],
      lineWidth: 0.25,
      valign: 'middle',
    },
    didDrawCell: (hookData) => {
      // Draw small buyer logo in Ship To cell if available
      if (buyerLogoData && hookData.row.index === 0 && hookData.column.index === 1) {
        const logoBadgeSize = 6;
        const lx = hookData.cell.x + hookData.cell.width - logoBadgeSize - 1.5;
        const ly = hookData.cell.y + 1.5;
        drawFitImage(doc, buyerLogoData, lx, ly, logoBadgeSize, logoBadgeSize, 'right');
      }
    },
  });

  currentY = (doc as any).lastAutoTable.finalY + 3;

  // ─────────────────────────────────────────────────────────────
  // 4. TABLE 3: LINE ITEMS (8-Column Official Grid)
  // ─────────────────────────────────────────────────────────────
  const tableHeaders = ['#', 'Code', 'Product Description', 'HSN/SAC', 'Qty', 'Units', 'Rate [INR]', 'Total [INR]'];
  const tableBody = data.items.map((it, idx) => [
    String(idx + 1),
    it.productCode || `SKU-${idx + 101}`,
    it.name + (it.specs ? `\n${it.specs}` : ''),
    it.hsn || 'N/A',
    String(it.quantity),
    it.unit || 'Nos',
    moneyPdf(it.unitPrice),
    moneyPdf(it.total),
  ]);

  autoTable(doc, {
    startY: currentY,
    theme: 'grid',
    margin: { left: marginX, right: marginX },
    tableWidth: contentWidth,
    head: [tableHeaders],
    body: tableBody,
    headStyles: {
      fillColor: [15, 23, 42], // Official dark slate / black header
      textColor: 255,
      fontStyle: 'bold',
      fontSize: 7.5,
      halign: 'center',
      valign: 'middle',
      cellPadding: 2.2,
      lineColor: [0, 0, 0],
      lineWidth: 0.25,
    },
    styles: {
      fontSize: 7.2,
      cellPadding: 2.2,
      textColor: [15, 23, 42],
      lineColor: [180, 180, 180],
      lineWidth: 0.2,
      overflow: 'linebreak',
    },
    columnStyles: {
      0: { cellWidth: 10, halign: 'center' }, // #
      1: { cellWidth: 22, halign: 'left' },   // Code
      2: { cellWidth: 'auto', halign: 'left' }, // Product Description
      3: { cellWidth: 20, halign: 'center' }, // HSN/SAC
      4: { cellWidth: 14, halign: 'center' }, // Qty
      5: { cellWidth: 14, halign: 'center' }, // Units
      6: { cellWidth: 26, halign: 'right' },  // Rate
      7: { cellWidth: 28, halign: 'right', fontStyle: 'bold' }, // Total
    },
  });

  currentY = (doc as any).lastAutoTable.finalY + 3;

  // ─────────────────────────────────────────────────────────────
  // 5. BOTTOM SECTION: ADDITIONAL NOTES & FINANCIAL SUMMARY
  // ─────────────────────────────────────────────────────────────
  const bottomSectionHeight = 34;
  if (currentY + bottomSectionHeight + 40 > pageHeight - 15) {
    doc.addPage();
    currentY = 15;
  }

  const colWidth = (contentWidth - 3) / 2;
  const leftColX = marginX;
  const rightColX = marginX + colWidth + 3;

  // Left Box: Notes & Terms
  autoTable(doc, {
    startY: currentY,
    theme: 'grid',
    margin: { left: leftColX, right: rightColX },
    tableWidth: colWidth,
    head: [[{ content: 'ADDITIONAL NOTES & TERMS', styles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: 'bold', fontSize: 7.5 } }]],
    body: [
      [
        {
          content: [
            '1. Delivery must strictly adhere to agreed specifications and timeline.',
            `2. Payment Terms: ${data.paymentTerms || 'Escrow Held / Pay on Invoice'}.`,
            '3. Vendor invoice must cross-reference this PO Number and Date.',
            ...(data.notes || []),
          ].join('\n'),
          styles: { fontSize: 7, cellPadding: 2, textColor: [51, 65, 85] },
        },
      ],
    ],
    styles: { lineColor: [0, 0, 0], lineWidth: 0.25 },
  });

  // Right Box: Financial Summary
  autoTable(doc, {
    startY: currentY,
    theme: 'grid',
    margin: { left: rightColX, right: marginX },
    tableWidth: colWidth,
    head: [],
    body: [
      [
        { content: 'Subtotal (Taxable Value):', styles: { fontStyle: 'bold', halign: 'right', cellWidth: colWidth * 0.55 } },
        { content: moneyPdf(data.financials.subtotal), styles: { halign: 'right', cellWidth: colWidth * 0.45 } },
      ],
      [
        { content: 'Shipping & Handling:', styles: { fontStyle: 'bold', halign: 'right' } },
        { content: moneyPdf(data.financials.shipping), styles: { halign: 'right' } },
      ],
      [
        { content: `${data.financials.taxLabel || 'TAX / GST (18%):'}:`, styles: { fontStyle: 'bold', halign: 'right' } },
        { content: moneyPdf(data.financials.taxAmount), styles: { halign: 'right' } },
      ],
      [
        { content: 'TOTAL AMOUNT:', styles: { fontStyle: 'bold', fillColor: [15, 23, 42], textColor: 255, halign: 'right', fontSize: 8.5 } },
        { content: moneyPdf(data.financials.grandTotal), styles: { fontStyle: 'bold', fillColor: [15, 23, 42], textColor: 255, halign: 'right', fontSize: 9 } },
      ],
    ],
    styles: {
      fontSize: 7.5,
      cellPadding: 1.8,
      textColor: [15, 23, 42],
      lineColor: [0, 0, 0],
      lineWidth: 0.25,
    },
  });

  const notesEnd = (doc as any).lastAutoTable.finalY;
  currentY = Math.max(currentY + bottomSectionHeight, notesEnd) + 4;

  // ─────────────────────────────────────────────────────────────
  // 6. SIGNATURES & STAMP ROW (Bilateral Official Signatory)
  // ─────────────────────────────────────────────────────────────
  if (currentY + 36 > pageHeight - 15) {
    doc.addPage();
    currentY = 15;
  }

  // Draw separator above signatures
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.3);
  doc.line(marginX, currentY, rightX, currentY);
  currentY += 2;

  // Buyer Signatory (Left)
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.text(`For ${data.buyer.name || 'Buyer'}:`, marginX, currentY + 3);

  const sigBoxY = currentY + 4.5;
  const stampBoxSize = 13;
  let buyerSigStartX = marginX;

  if (buyerStampData) {
    drawFitImage(doc, buyerStampData, marginX, sigBoxY, stampBoxSize, stampBoxSize, 'left');
    buyerSigStartX = marginX + stampBoxSize + 2;
  }

  if (buyerSigData) {
    drawFitImage(doc, buyerSigData, buyerSigStartX, sigBoxY, 32, stampBoxSize, 'left');
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  if (data.buyer.contactName) {
    doc.text(data.buyer.contactName, marginX, sigBoxY + stampBoxSize + 2.5);
    doc.text('Authorized Signatory (Buyer)', marginX, sigBoxY + stampBoxSize + 6);
  } else {
    doc.text('Authorized Signatory (Buyer)', marginX, sigBoxY + stampBoxSize + 3);
  }

  // Supplier Signatory (Right)
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.text(`For ${data.seller.name || 'Supplier'}:`, rightX, currentY + 3, { align: 'right' });

  const rightSigX = rightX - 48;
  if (sellerStampData) {
    drawFitImage(doc, sellerStampData, rightSigX, sigBoxY, stampBoxSize, stampBoxSize, 'left');
  }
  if (sellerSigData) {
    const sellerSigX = sellerStampData ? rightSigX + stampBoxSize + 2 : rightSigX + 10;
    drawFitImage(doc, sellerSigData, sellerSigX, sigBoxY, 32, stampBoxSize, 'right');
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  if (data.seller.contactName) {
    doc.text(data.seller.contactName, rightX, sigBoxY + stampBoxSize + 2.5, { align: 'right' });
    doc.text('Authorized Signatory (Supplier)', rightX, sigBoxY + stampBoxSize + 6, { align: 'right' });
  } else {
    doc.text('Authorized Signatory (Supplier)', rightX, sigBoxY + stampBoxSize + 3, { align: 'right' });
  }

  // ─────────────────────────────────────────────────────────────
  // 7. FOOTER (Every Page)
  // ─────────────────────────────────────────────────────────────
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(200, 200, 200);
    doc.setLineWidth(0.25);
    doc.line(marginX, pageHeight - 8, rightX, pageHeight - 8);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(140, 150, 160);
    doc.text(`${sanitizePdfText(data.issuerName || 'JSGSMILE Enterprise Procurement Portal')} · Official Document`, marginX, pageHeight - 4.5);
    doc.text(`Page ${i} of ${pageCount}`, rightX, pageHeight - 4.5, { align: 'right' });
  }

  return doc;
}
