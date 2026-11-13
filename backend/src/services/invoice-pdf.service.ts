import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { db, notifyWorkflowSoon } from './workflow/workflow-common.js';
import { getFileContent } from './storage/storage.service.js';
import { logger } from '../config/logger.js';
import { isEncrypted, decryptField } from '../utils/crypto.js';

const safeDecryptText = (val: unknown): string => {
  if (typeof val === 'string' && isEncrypted(val)) {
    try {
      return decryptField(val);
    } catch {
      return val;
    }
  }
  return typeof val === 'string' || typeof val === 'number' ? String(val).trim() : '';
};

/**
 * Validate external image URLs against SSRF:
 * - Must use HTTP/HTTPS protocol
 * - Blocks metadata services (169.254.169.254, metadata.google.internal)
 * - Blocks loopback (127.0.0.1, localhost, ::1, 0.0.0.0)
 * - Blocks RFC 1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16)
 * - Blocks integer/octal/hex IP notations
 * - Requires hostname to match allowlisted domains
 */
export function isSafeFetchUrl(
  urlStr: string,
  allowedDomains: string[] = ['jsgsmile.in', 'storage.googleapis.com', 'res.cloudinary.com']
): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }

  // Only allow HTTP/HTTPS
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const hostname = parsed.hostname.toLowerCase();

  // Loopback addresses
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
    return false;
  }

  // Cloud metadata services
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal' || hostname.endsWith('.metadata.google.internal')) {
    return false;
  }

  // RFC 1918 Private IPv4 address ranges & link-local
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;

  // Decimal, octal, hex IP notation bypassing string regex (e.g. 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) return false;

  // Domain whitelist check
  const isAllowed = allowedDomains.some(d => hostname === d || hostname.endsWith('.' + d));
  return isAllowed;
}

export interface TaxInvoicePdfInput {
  id?: number;
  invoiceNumber: string;
  createdAt?: Date | string;
  amount?: number | string;
  taxableAmount?: number | string;
  cgstAmount?: number | string;
  sgstAmount?: number | string;
  igstAmount?: number | string;
  totalTaxAmount?: number | string;
  tdsAmount?: number | string;
  interstate?: boolean;
  sellerId?: number;
  buyerId?: number;
  fileAssetId?: number | null;
  invoiceFileId?: number | null;
  purchaseOrder?: any;
  seller?: any;
  buyer?: any;
  items?: any[];
}

/**
 * Format currency to standard INR representation.
 */
function formatInr(val: number | string | undefined | null): string {
  const num = Number(val || 0);
  if (!Number.isFinite(num)) return 'INR 0.00';
  return `INR ${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'] as const;

function formatDate(val: unknown): string {
  if (!val) return '—';
  const d = val instanceof Date ? val : new Date(String(val));
  if (Number.isNaN(d.getTime())) return '—';
  const day = d.getDate();
  const month = MONTH_NAMES[d.getMonth()] ?? '';
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

/**
 * Converts numbers into official Indian currency words representation.
 */
function numberToWords(amount: number): string {
  const num = Math.round(Number(amount || 0));
  if (!Number.isFinite(num) || num <= 0) return 'Zero Rupees Only';

  const units = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const toWords = (n: number): string => {
    if (n < 20) return units[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + units[n % 10] : '');
    if (n < 1000) return units[Math.floor(n / 100)] + ' Hundred' + (n % 100 !== 0 ? ' and ' + toWords(n % 100) : '');
    if (n < 100000) return toWords(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 !== 0 ? ' ' + toWords(n % 1000) : '');
    if (n < 10000000) return toWords(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 !== 0 ? ' ' + toWords(n % 100000) : '');
    return toWords(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 !== 0 ? ' ' + toWords(n % 10000000) : '');
  };

  const whole = Math.floor(num);
  const fraction = Math.round((Number(amount) - whole) * 100);

  let words = toWords(whole) + ' Rupees';
  if (fraction > 0) {
    words += ' and ' + toWords(fraction) + ' Paise';
  }
  return words + ' Only';
}

/**
 * Resolves an asset input (fileAssetId, /api/files/:id/view, data URL, GCS URL, or disk file) into a clean image Buffer.
 */
async function resolveImageBuffer(
  input: string | number | null | undefined,
  fallbackUserId?: number
): Promise<Buffer | null> {
  if (!input) return null;
  try {
    let rawBuffer: Buffer | null = null;

    if (typeof input === 'number') {
      try {
        const stored = await getFileContent(input, { id: fallbackUserId || 1, role: 'admin' });
        if (stored?.buffer && stored.buffer.length > 0) {
          rawBuffer = stored.buffer;
        }
      } catch {}
    } else if (typeof input === 'string') {
      const trimmed = input.trim();
      if (trimmed) {
        if (trimmed.startsWith('data:image/')) {
          const base64Index = trimmed.indexOf(';base64,');
          if (base64Index !== -1) {
            rawBuffer = Buffer.from(trimmed.substring(base64Index + 8), 'base64');
          }
        } else {
          const m = trimmed.match(/\/api\/(?:public\/)?files\/(\d+)/);
          let candidateFileId: number | null = m && m[1] ? parseInt(m[1], 10) : null;

          if (candidateFileId) {
            try {
              const stored = await getFileContent(candidateFileId, { id: fallbackUserId || 1, role: 'admin' });
              if (stored?.buffer && stored.buffer.length > 0) {
                rawBuffer = stored.buffer;
              }
            } catch {}
          }

          if (!rawBuffer) {
            const cleanUrl = trimmed.split('?')[0];
            try {
              const asset = await db.fileAsset.findFirst({
                where: {
                  OR: [
                    { url: cleanUrl },
                    { key: cleanUrl },
                    { key: { endsWith: path.basename(cleanUrl) } }
                  ],
                  status: 'active'
                },
                select: { id: true, url: true }
              });
              if (asset?.id) {
                try {
                  const stored = await getFileContent(asset.id, { id: fallbackUserId || 1, role: 'admin' });
                  if (stored?.buffer && stored.buffer.length > 0) {
                    rawBuffer = stored.buffer;
                  }
                } catch {}

                if (!rawBuffer && asset.url && isSafeFetchUrl(asset.url)) {
                  try {
                    const resp = await fetch(asset.url, { signal: AbortSignal.timeout(4000) });
                    if (resp.ok) {
                      rawBuffer = Buffer.from(await resp.arrayBuffer());
                    }
                  } catch {}
                }
              }
            } catch {}
          }

          if (!rawBuffer) {
            const localCandidates = [
              path.resolve(process.cwd(), trimmed.replace(/^\//, '')),
              path.resolve(process.cwd(), 'uploads', path.basename(trimmed)),
              path.resolve(process.cwd(), '../frontend/public', trimmed.replace(/^\//, '')),
              path.resolve(process.cwd(), 'public', trimmed.replace(/^\//, ''))
            ];
            for (const cand of localCandidates) {
              if (fs.existsSync(cand) && !fs.statSync(cand).isDirectory()) {
                rawBuffer = fs.readFileSync(cand);
                break;
              }
            }
          }

          if (!rawBuffer && isSafeFetchUrl(trimmed)) {
            try {
              const resp = await fetch(trimmed, { signal: AbortSignal.timeout(4000) });
              if (resp.ok) {
                rawBuffer = Buffer.from(await resp.arrayBuffer());
              }
            } catch {}
          }
        }
      }
    }

    if (!rawBuffer || rawBuffer.length === 0) return null;

    try {
      const sharpMod: any = await import('sharp');
      const sharpFn = (sharpMod && (sharpMod.default || sharpMod)) as any;
      if (typeof sharpFn === 'function') {
        // Convert to clean, standardized PNG buffer to eliminate malformed JPEG EXIF headers that crash PDFKit's jpeg-exif parser
        return await sharpFn(rawBuffer).png().toBuffer();
      }
      return rawBuffer;
    } catch {
      return rawBuffer;
    }
  } catch (err) {
    logger.warn({ err, input }, 'Failed to resolve image buffer');
    return null;
  }
}

/**
 * Safely renders an image buffer in PDFKit without crashing the stream.
 */
function safeDrawImage(doc: any, buffer: Buffer | null, x: number, y: number, options: any): boolean {
  if (!buffer || buffer.length === 0) return false;
  try {
    doc.image(buffer, x, y, options);
    return true;
  } catch (err) {
    logger.warn({ err }, 'PDFKit safeDrawImage failed to draw image');
    return false;
  }
}

/**
 * Generates an official, high-precision GST Tax Invoice PDF Buffer matching the portal ERP design.
 */
export async function generateInvoicePdfBuffer(invoice: TaxInvoicePdfInput): Promise<Buffer> {
  const po = invoice.purchaseOrder || {};
  const seller = invoice.seller || po.seller || {};
  const buyer = invoice.buyer || po.buyer || {};
  const sellerReg = (seller.registrationDetails as Record<string, any>) || {};
  const buyerReg = (buyer.registrationDetails as Record<string, any>) || {};

  // Check fallback branding from organization owner if missing
  if ((!sellerReg.stampUrl || !sellerReg.signatureUrl || !sellerReg.logoUrl) && seller.organizationId) {
    const orgSeller = await db.user.findFirst({
      where: { organizationId: seller.organizationId, registrationDetails: { not: null } },
      select: { registrationDetails: true }
    });
    if (orgSeller?.registrationDetails) {
      const osReg = orgSeller.registrationDetails as Record<string, any>;
      if (!sellerReg.stampUrl && osReg.stampUrl) sellerReg.stampUrl = osReg.stampUrl;
      if (!sellerReg.signatureUrl && osReg.signatureUrl) sellerReg.signatureUrl = osReg.signatureUrl;
      if (!sellerReg.logoUrl && osReg.logoUrl) sellerReg.logoUrl = osReg.logoUrl;
    }
  }

  // Pre-fetch seller images in parallel
  const [sellerLogoBuf, sellerStampBuf, sellerSigBuf] = await Promise.all([
    resolveImageBuffer(sellerReg.logoUrl || seller.organization?.profile?.logoUrl || seller.organization?.organizationLogoFileId, seller.id),
    resolveImageBuffer(sellerReg.stampUrl, seller.id),
    resolveImageBuffer(sellerReg.signatureUrl, seller.id)
  ]);

  const sellerName = seller.organization?.organizationName || seller.sellerProfile?.businessName || seller.sellerProfile?.companyName || sellerReg.companyName || sellerReg.businessName || seller.name || 'N/A';
  const sellerAddress = seller.organization?.address || seller.sellerProfile?.registeredAddress || seller.organization?.profile?.registeredAddress || sellerReg.registeredAddress || sellerReg.address || 'N/A';
  const sellerGstin = seller.organization?.gstin || seller.sellerProfile?.gst || sellerReg.gstin || sellerReg.gstDetails?.gstin || 'N/A';
  const sellerCin = seller.organization?.cinNumber || seller.sellerProfile?.cin || sellerReg.cin || 'N/A';
  const sellerPhone = seller.mobile || seller.sellerProfile?.mobile || sellerReg.mobile || 'N/A';
  const sellerEmail = seller.email || sellerReg.email || 'N/A';

  const buyerName = buyer.organization?.organizationName || buyer.buyerProfile?.organizationName || buyer.buyerProfile?.companyName || buyerReg.companyName || buyerReg.businessName || buyer.name || 'N/A';
  const buyerAddress = po.deliveryAddress || buyer.organization?.address || buyer.buyerProfile?.registeredAddress || buyerReg.registeredAddress || buyerReg.address || 'N/A';
  const buyerGstin = buyer.organization?.gstin || buyer.buyerProfile?.gst || buyerReg.gstin || buyerReg.gstDetails?.gstin || 'N/A';
  const buyerPan = buyer.organization?.panNumber || buyer.buyerProfile?.pan || buyerReg.pan || buyerReg.gstDetails?.pan || 'N/A';

  const invNo = invoice.invoiceNumber || `INV-${po.poNumber || invoice.id || '2026-001'}`;
  const dateStr = formatDate(invoice.createdAt || new Date());
  const sellerGstinCode = (sellerGstin || '').trim().substring(0, 2);
  const buyerGstinCode = (buyerGstin || '').trim().substring(0, 2);
  const isInterstate = Boolean(
    invoice.interstate ||
    Number(invoice.igstAmount) > 0 ||
    (/^\d{2}$/.test(sellerGstinCode) && /^\d{2}$/.test(buyerGstinCode) && sellerGstinCode !== buyerGstinCode) ||
    (sellerReg.state && buyerReg.state && String(sellerReg.state).toLowerCase() !== String(buyerReg.state).toLowerCase())
  );
  const buyerStateName = buyer.buyerProfile?.state || buyerReg.state || (buyerGstinCode === '21' ? 'Odisha' : 'Other State');
  const placeOfSupply = isInterstate
    ? `${buyerStateName}${buyerGstinCode ? ` (${buyerGstinCode})` : ''} - Inter-State (IGST)`
    : `${seller.sellerProfile?.state || sellerReg.state || 'Maharashtra'} - State (CGST + SGST)`;

  const rawItems = invoice.items?.length ? invoice.items : (po.items?.length ? po.items : []);
  const totalAmountNum = Number(invoice.amount || po.amount || 0);

  const items = rawItems.length > 0
    ? rawItems.map((item: any, idx: number) => {
        const qty = Number(item.quantity || 1);
        let unitPrice = Number(item.unitPrice || item.priceUnit || 0);
        let lineTaxable = Number(item.taxableAmount || (unitPrice > 0 ? unitPrice * qty : 0));
        if (qty > 1 && totalAmountNum > 0 && (unitPrice * qty) > (totalAmountNum * 1.5)) {
          unitPrice = Number((unitPrice / qty).toFixed(2));
          lineTaxable = Number((unitPrice * qty).toFixed(2));
        } else if (lineTaxable > 0 && (!unitPrice || unitPrice === lineTaxable)) {
          unitPrice = Number((lineTaxable / qty).toFixed(2));
        }
        return {
          srNo: idx + 1,
          description: item.itemName || item.description || po.title || 'Order Item',
          hsn: item.hsnCode || item.hsn || item.product?.hsnCode || '-',
          qty,
          unitPrice: unitPrice || (lineTaxable / Math.max(qty, 1)),
          totalAmount: lineTaxable
        };
      })
    : [{
        srNo: 1,
        description: po.title || `Purchase Order #${po.poNumber || invoice.id}`,
        hsn: '-',
        qty: 1,
        unitPrice: Number(invoice.taxableAmount || (totalAmountNum > 0 ? totalAmountNum / 1.18 : 0)),
        totalAmount: Number(invoice.taxableAmount || (totalAmountNum > 0 ? totalAmountNum / 1.18 : 0))
      }];

  const subtotalNum = Number(invoice.taxableAmount) || items.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0) || (totalAmountNum > 0 ? Number((totalAmountNum / 1.18).toFixed(2)) : 0);
  const cgstNum = isInterstate ? 0 : (Number(invoice.cgstAmount) || Math.round(subtotalNum * 0.09 * 100) / 100);
  const sgstNum = isInterstate ? 0 : (Number(invoice.sgstAmount) || Math.round(subtotalNum * 0.09 * 100) / 100);
  const igstNum = isInterstate ? (Number(invoice.igstAmount) || Math.round(subtotalNum * 0.18 * 100) / 100) : 0;
  const grandTotalNum = totalAmountNum || Math.round((subtotalNum + (isInterstate ? igstNum : (cgstNum + sgstNum))) * 100) / 100;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 36 });
      const buffers: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err: Error) => reject(err));

      const pageMargin = 36;
      const contentWidth = 595.28 - (pageMargin * 2); // 523.28
      const rightX = pageMargin + contentWidth;

      let currentY = 28;

      // 1. TOP HEADER BOX: Seller details (left) & Logo + CIN (right)
      const headerBoxHeight = 65;
      doc.rect(pageMargin, currentY, contentWidth, headerBoxHeight).strokeColor('#1e293b').lineWidth(0.5).stroke();

      // Left: Seller Info
      doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold').text(sellerName, pageMargin + 10, currentY + 8, { width: contentWidth - 170, ellipsis: true });
      doc.fillColor('#334155').fontSize(7.5).font('Helvetica').text(sellerAddress, pageMargin + 10, currentY + 22, { width: contentWidth - 170, height: 24, ellipsis: true });
      doc.fillColor('#0f172a').fontSize(7.5).font('Helvetica-Bold').text(`GST NO: ${sellerGstin}  |  Phone: ${sellerPhone}`, pageMargin + 10, currentY + 48, { width: contentWidth - 170, ellipsis: true });

      // Right: Seller Logo & CIN
      if (sellerLogoBuf) {
        safeDrawImage(doc, sellerLogoBuf, rightX - 145, currentY + 8, { fit: [135, 34], align: 'right' });
      }
      if (sellerCin && sellerCin !== 'N/A') {
        doc.fillColor('#0f172a').fontSize(7.5).font('Helvetica-Bold').text(`CIN: ${sellerCin}`, rightX - 160, currentY + 48, { width: 150, align: 'right' });
      }

      currentY += headerBoxHeight;

      // 2. TITLE BAR: TAX INVOICE - ORIGINAL COPY FOR RECIPIENT
      const titleHeight = 18;
      doc.rect(pageMargin, currentY, contentWidth, titleHeight).strokeColor('#1e293b').lineWidth(0.5).stroke();
      doc.fillColor('#0f172a').fontSize(9.5).font('Helvetica-Bold').text('TAX INVOICE - ORIGINAL COPY FOR RECIPIENT', pageMargin, currentY + 4.5, { width: contentWidth, align: 'center' });

      currentY += titleHeight;

      // 3. METADATA ROW: INV No & Date (left), Place of Supply (right)
      const metaHeight = 18;
      const midDividerX = pageMargin + (contentWidth / 2);
      doc.rect(pageMargin, currentY, contentWidth, metaHeight).strokeColor('#1e293b').lineWidth(0.5).stroke();
      doc.moveTo(midDividerX, currentY).lineTo(midDividerX, currentY + metaHeight).strokeColor('#1e293b').lineWidth(0.5).stroke();

      doc.fillColor('#0f172a').fontSize(8).font('Helvetica-Bold').text(`INV No: ${invNo}    Date: ${dateStr}`, pageMargin + 10, currentY + 5);
      doc.fillColor('#0f172a').fontSize(8).font('Helvetica-Bold').text(`Place Of Supply: ${placeOfSupply}`, midDividerX + 10, currentY + 5);

      currentY += metaHeight;

      // 4. BILL TO & SHIP TO SECTION (2 Columns with divider)
      const billShipHeight = 70;
      doc.rect(pageMargin, currentY, contentWidth, billShipHeight).strokeColor('#1e293b').lineWidth(0.5).stroke();
      doc.moveTo(midDividerX, currentY).lineTo(midDividerX, currentY + billShipHeight).strokeColor('#1e293b').lineWidth(0.5).stroke();

      // Bill To Column
      doc.fillColor('#0f172a').fontSize(8).font('Helvetica-Bold').text('Bill To:', pageMargin + 10, currentY + 6);
      doc.fillColor('#0f172a').fontSize(8.5).font('Helvetica-Bold').text(buyerName, pageMargin + 10, currentY + 18, { width: (contentWidth / 2) - 20, ellipsis: true });
      doc.fillColor('#475569').fontSize(7.5).font('Helvetica').text(buyerAddress, pageMargin + 10, currentY + 30, { width: (contentWidth / 2) - 20, height: 20, ellipsis: true });
      doc.fillColor('#0f172a').fontSize(7.5).font('Helvetica-Bold').text(`PAN: ${buyerPan}  |  GSTIN: ${buyerGstin}`, pageMargin + 10, currentY + 54, { width: (contentWidth / 2) - 20, ellipsis: true });

      // Ship To Column
      doc.fillColor('#0f172a').fontSize(8).font('Helvetica-Bold').text('Ship To:', midDividerX + 10, currentY + 6);
      doc.fillColor('#0f172a').fontSize(8.5).font('Helvetica-Bold').text(buyerName, midDividerX + 10, currentY + 18, { width: (contentWidth / 2) - 20, ellipsis: true });
      doc.fillColor('#475569').fontSize(7.5).font('Helvetica').text(buyerAddress, midDividerX + 10, currentY + 30, { width: (contentWidth / 2) - 20, height: 24, ellipsis: true });

      currentY += billShipHeight;

      // 5. ITEMS TABLE
      const colX = [pageMargin, pageMargin + 30, pageMargin + 250, pageMargin + 320, pageMargin + 380, pageMargin + 445];
      const colW = [30, 220, 70, 60, 65, 78.28];

      // Table Header Row
      doc.rect(pageMargin, currentY, contentWidth, 18).strokeColor('#1e293b').lineWidth(0.5).stroke();
      doc.fillColor('#0f172a').fontSize(8).font('Helvetica-Bold');
      doc.text('Sr. No.', colX[0] + 4, currentY + 5, { width: colW[0] - 8, align: 'center' });
      doc.text('Description of Goods / Services', colX[1] + 4, currentY + 5, { width: colW[1] - 8, align: 'left' });
      doc.text('HSN/SAC', colX[2] + 4, currentY + 5, { width: colW[2] - 8, align: 'center' });
      doc.text('Qty', colX[3] + 4, currentY + 5, { width: colW[3] - 8, align: 'center' });
      doc.text('Price/Unit', colX[4] + 4, currentY + 5, { width: colW[4] - 8, align: 'right' });
      doc.text('Amount', colX[5] + 4, currentY + 5, { width: colW[5] - 8, align: 'right' });

      currentY += 18;

      // Items Rows
      items.forEach((item, idx) => {
        if (currentY + 20 > 841.89 - 180) {
          doc.addPage();
          currentY = 36;
        }
        const rowBg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
        doc.rect(pageMargin, currentY, contentWidth, 20).fill(rowBg);
        doc.rect(pageMargin, currentY, contentWidth, 20).strokeColor('#cbd5e1').lineWidth(0.5).stroke();

        doc.fillColor('#334155').fontSize(7.5).font('Helvetica');
        doc.text(String(item.srNo), colX[0] + 4, currentY + 6, { width: colW[0] - 8, align: 'center' });
        doc.font('Helvetica-Bold').fillColor('#0f172a').text(item.description, colX[1] + 4, currentY + 6, { width: colW[1] - 8, height: 12, ellipsis: true });
        doc.font('Helvetica').fillColor('#475569').text(item.hsn, colX[2] + 4, currentY + 6, { width: colW[2] - 8, align: 'center' });
        doc.text(String(item.qty), colX[3] + 4, currentY + 6, { width: colW[3] - 8, align: 'center' });
        doc.text(formatInr(item.unitPrice), colX[4] + 4, currentY + 6, { width: colW[4] - 8, align: 'right' });
        doc.font('Helvetica-Bold').fillColor('#0f172a').text(formatInr(item.totalAmount), colX[5] + 4, currentY + 6, { width: colW[5] - 8, align: 'right' });

        currentY += 20;
      });

      // 6. SUBTOTAL & TAX CALCULATIONS (Right aligned)
      const summaryBoxW = 240;
      const summaryBoxX = rightX - summaryBoxW;

      const drawCalcRow = (label: string, valStr: string, isBold = false) => {
        doc.rect(summaryBoxX, currentY, summaryBoxW, 16).strokeColor('#cbd5e1').lineWidth(0.5).stroke();
        doc.fillColor(isBold ? '#0f172a' : '#475569').fontSize(isBold ? 8.5 : 8).font(isBold ? 'Helvetica-Bold' : 'Helvetica');
        doc.text(label, summaryBoxX + 10, currentY + 4);
        doc.text(valStr, summaryBoxX + 10, currentY + 4, { width: summaryBoxW - 20, align: 'right' });
        currentY += 16;
      };

      drawCalcRow('Sub Total (Taxable Amount):', formatInr(subtotalNum));
      if (isInterstate) {
        drawCalcRow('IGST (18%):', formatInr(igstNum));
      } else {
        drawCalcRow('CGST (9%):', formatInr(cgstNum));
        drawCalcRow('SGST (9%):', formatInr(sgstNum));
      }
      drawCalcRow('TOTAL INVOICE AMOUNT:', formatInr(grandTotalNum), true);

      // Amount in words
      doc.fillColor('#64748b').fontSize(7.5).font('Helvetica-Oblique').text(`Amount in words: ${numberToWords(grandTotalNum)}`, pageMargin + 10, currentY - 30, { width: contentWidth - summaryBoxW - 20 });

      currentY += 8;

      // 7. FOOTER SECTION: Bank Details (left) & Stamp / Signature (right)
      const footerBoxHeight = 85;
      const footerDividerX = pageMargin + (contentWidth / 2) + 20;
      doc.rect(pageMargin, currentY, contentWidth, footerBoxHeight).strokeColor('#1e293b').lineWidth(0.5).stroke();
      doc.moveTo(footerDividerX, currentY).lineTo(footerDividerX, currentY + footerBoxHeight).strokeColor('#1e293b').lineWidth(0.5).stroke();

      // Bank Details (Left side)
      const bankName = sellerReg.bankDetails?.bankName || sellerReg.bankName || seller.sellerProfile?.bankAccounts?.[0]?.bankName || seller.sellerProfile?.bankName || 'State Bank of India';
      const accountName = sellerReg.bankDetails?.accountHolderName || sellerReg.accountHolderName || seller.sellerProfile?.bankAccounts?.[0]?.holderName || seller.sellerProfile?.accountHolderName || sellerName;
      const accountNo = sellerReg.bankDetails?.accountNumber || sellerReg.accountNumber || seller.sellerProfile?.bankAccounts?.[0]?.accountNumberMasked || seller.sellerProfile?.bankAccounts?.[0]?.accountNumber || seller.sellerProfile?.bankAccountNo || 'N/A';
      const ifscCode = sellerReg.bankDetails?.ifscCode || sellerReg.ifscCode || seller.sellerProfile?.bankAccounts?.[0]?.ifsc || seller.sellerProfile?.bankAccounts?.[0]?.ifscCode || seller.sellerProfile?.bankIfsc || 'N/A';

      doc.fillColor('#0f172a').fontSize(8.5).font('Helvetica-Bold').text('Bank Details:', pageMargin + 10, currentY + 8);
      doc.fillColor('#475569').fontSize(7.5).font('Helvetica').text(`Bank Name: ${bankName}`, pageMargin + 10, currentY + 22);
      doc.text(`Bank Account No: ${accountNo}`, pageMargin + 10, currentY + 34);
      doc.text(`IFSC CODE: ${ifscCode}`, pageMargin + 10, currentY + 46);
      doc.text(`Account Name: ${accountName}`, pageMargin + 10, currentY + 58);
      doc.fillColor('#059669').fontSize(7).font('Helvetica-Bold').text('Status: GST Tax Invoice Created & Verified', pageMargin + 10, currentY + 72);

      // Signatory Box (Right side)
      const stampBoxWidth = rightX - footerDividerX;
      doc.fillColor('#0f172a').fontSize(8).font('Helvetica-Bold').text(`For ${sellerName}`, footerDividerX + 10, currentY + 8, { width: stampBoxWidth - 20, align: 'right', ellipsis: true });

      // Render Official Stamp if present
      if (sellerStampBuf) {
        safeDrawImage(doc, sellerStampBuf, footerDividerX + 15, currentY + 18, { fit: [55, 38], align: 'left' });
      }

      // Render Official Signature if present
      if (sellerSigBuf) {
        safeDrawImage(doc, sellerSigBuf, rightX - 95, currentY + 34, { fit: [80, 26], align: 'right' });
      }

      doc.fillColor('#64748b').fontSize(7.5).font('Helvetica').text('Authorized Signatory', footerDividerX + 10, currentY + footerBoxHeight - 12, { width: stampBoxWidth - 20, align: 'right' });

      // Page bottom footer
      doc.strokeColor('#cbd5e1').lineWidth(0.5);
      doc.moveTo(pageMargin, 810).lineTo(rightX, 810).stroke();
      doc.fillColor('#94a3b8').fontSize(7).font('Helvetica').text('GST Tax Compliant Invoice - Government MSME Portal ERP', pageMargin, 816);
      doc.text('Page 1 of 1', pageMargin, 816, { width: contentWidth, align: 'right' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Retrieves existing stored PDF buffer or generates exact Tax Invoice PDF buffer.
 */
export async function getOrGenerateInvoicePdfBuffer(invoice: any): Promise<{ buffer: Buffer; filename: string }> {
  let fullInvoice = invoice;
  const invId = typeof invoice === 'number' ? invoice : invoice?.id;
  if (invId && (!invoice?.seller?.registrationDetails || !invoice?.buyer?.registrationDetails || !invoice?.purchaseOrder?.items)) {
    try {
      const dbInv = await db.invoice.findUnique({
        where: { id: invId },
        include: {
          items: true,
          purchaseOrder: {
            include: {
              items: true,
              buyer: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  mobile: true,
                  registrationDetails: true,
                  buyerProfile: true,
                  organizationId: true,
                  organization: { include: { profile: true } }
                }
              },
              seller: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  mobile: true,
                  registrationDetails: true,
                  sellerProfile: true,
                  organizationId: true,
                  organization: { include: { profile: true } }
                }
              }
            }
          },
          seller: {
            select: {
              id: true,
              name: true,
              email: true,
              mobile: true,
              registrationDetails: true,
              sellerProfile: true,
              organizationId: true,
              organization: { include: { profile: true } }
            }
          },
          buyer: {
            select: {
              id: true,
              name: true,
              email: true,
              mobile: true,
              registrationDetails: true,
              buyerProfile: true,
              organizationId: true,
              organization: { include: { profile: true } }
            }
          }
        }
      });
      if (dbInv) {
        fullInvoice = { ...invoice, ...dbInv };
      }
    } catch (fetchErr) {
      logger.warn({ fetchErr, invId }, 'Failed to fetch complete invoice relations for PDF');
    }
  }

  const filename = `Invoice_${fullInvoice.invoiceNumber || `INV-${fullInvoice.id || 'N/A'}`}.pdf`;
  const buffer = await generateInvoicePdfBuffer(fullInvoice);
  return { buffer, filename };
}

/**
 * Generates an official, high-precision Purchase Order PDF Buffer using PDFKit matching the portal ERP design.
 */
export async function generatePurchaseOrderPdfBuffer(po: any): Promise<Buffer> {
  const buyer = po.buyer || {};
  const seller = po.seller || {};
  const meta = (typeof po.metadata === 'object' && po.metadata !== null ? po.metadata : {}) as Record<string, any>;
  const deliveryDetails = (meta.deliveryDetails || {}) as Record<string, any>;
  const billingDetails = (meta.billingDetails || {}) as Record<string, any>;

  const buyerReg = (buyer.registrationDetails as Record<string, any>) || {};
  const sellerReg = (seller.registrationDetails as Record<string, any>) || {};

  // Check fallback branding from organization owners if missing
  if ((!buyerReg.stampUrl || !buyerReg.signatureUrl || !buyerReg.logoUrl) && buyer.organizationId) {
    const orgBuyer = await db.user.findFirst({
      where: { organizationId: buyer.organizationId, registrationDetails: { not: null } },
      select: { registrationDetails: true }
    });
    if (orgBuyer?.registrationDetails) {
      const obReg = orgBuyer.registrationDetails as Record<string, any>;
      if (!buyerReg.stampUrl && obReg.stampUrl) buyerReg.stampUrl = obReg.stampUrl;
      if (!buyerReg.signatureUrl && obReg.signatureUrl) buyerReg.signatureUrl = obReg.signatureUrl;
      if (!buyerReg.logoUrl && obReg.logoUrl) buyerReg.logoUrl = obReg.logoUrl;
    }
  }

  if ((!sellerReg.stampUrl || !sellerReg.signatureUrl || !sellerReg.logoUrl) && seller.organizationId) {
    const orgSeller = await db.user.findFirst({
      where: { organizationId: seller.organizationId, registrationDetails: { not: null } },
      select: { registrationDetails: true }
    });
    if (orgSeller?.registrationDetails) {
      const osReg = orgSeller.registrationDetails as Record<string, any>;
      if (!sellerReg.stampUrl && osReg.stampUrl) sellerReg.stampUrl = osReg.stampUrl;
      if (!sellerReg.signatureUrl && osReg.signatureUrl) sellerReg.signatureUrl = osReg.signatureUrl;
      if (!sellerReg.logoUrl && osReg.logoUrl) sellerReg.logoUrl = osReg.logoUrl;
    }
  }

  // Pre-fetch images in parallel
  const [buyerLogoBuf, buyerStampBuf, buyerSigBuf, sellerLogoBuf, sellerStampBuf, sellerSigBuf] = await Promise.all([
    resolveImageBuffer(buyerReg.logoUrl || buyer.organization?.profile?.logoUrl || buyer.organization?.organizationLogoFileId, buyer.id),
    resolveImageBuffer(buyerReg.stampUrl, buyer.id),
    resolveImageBuffer(buyerReg.signatureUrl, buyer.id),
    resolveImageBuffer(sellerReg.logoUrl || seller.organization?.profile?.logoUrl || seller.organization?.organizationLogoFileId, seller.id),
    resolveImageBuffer(sellerReg.stampUrl, seller.id),
    resolveImageBuffer(sellerReg.signatureUrl, seller.id)
  ]);

  const buyerName =
    billingDetails.companyName ||
    buyer.organization?.organizationName ||
    buyer.buyerProfile?.organizationName ||
    buyer.buyerProfile?.companyName ||
    buyerReg.companyName ||
    buyerReg.businessName ||
    buyer.name ||
    'N/A';

  const buyerAddress =
    po.deliveryAddress ||
    billingDetails.billingAddress ||
    deliveryDetails.address ||
    buyer.organization?.address ||
    buyer.buyerProfile?.registeredAddress ||
    buyerReg.registeredAddress ||
    buyerReg.officeZoneName ||
    buyerReg.address ||
    'N/A';

  const buyerGstin = safeDecryptText(
    billingDetails.gstin ||
    buyer.organization?.gstin ||
    buyer.buyerProfile?.gst ||
    buyerReg.gstin ||
    buyerReg.gstDetails?.gstin ||
    buyerReg.gstDetails?.gstNumber
  ) || 'N/A';

  const buyerPan = safeDecryptText(
    buyer.organization?.panNumber ||
    buyer.buyerProfile?.pan ||
    buyerReg.pan ||
    buyerReg.orgPan ||
    buyerReg.personalPan ||
    buyerReg.gstDetails?.pan
  ) || 'N/A';

  const buyerPhone = safeDecryptText(
    deliveryDetails.mobileNumber ||
    buyer.mobile ||
    buyer.buyerProfile?.mobile ||
    buyerReg.mobile ||
    buyerReg.phone
  ) || 'N/A';

  const buyerEmail = safeDecryptText(buyer.email || buyerReg.email || buyerReg.userId) || 'N/A';

  const sellerName =
    seller.organization?.organizationName ||
    seller.sellerProfile?.businessName ||
    seller.sellerProfile?.companyName ||
    sellerReg.companyName ||
    sellerReg.businessName ||
    seller.name ||
    'N/A';

  const sellerAddress =
    seller.organization?.address ||
    seller.sellerProfile?.registeredAddress ||
    seller.organization?.profile?.registeredAddress ||
    sellerReg.registeredAddress ||
    sellerReg.address ||
    'N/A';

  const sellerGstin = safeDecryptText(
    seller.organization?.gstin ||
    seller.sellerProfile?.gst ||
    sellerReg.gstin ||
    sellerReg.gstDetails?.gstin ||
    sellerReg.gstDetails?.gstNumber
  ) || 'N/A';

  const sellerPan = safeDecryptText(
    seller.organization?.panNumber ||
    seller.sellerProfile?.pan ||
    sellerReg.pan ||
    sellerReg.orgPan ||
    sellerReg.personalPan ||
    sellerReg.gstDetails?.pan
  ) || 'N/A';

  const sellerUdyam =
    seller.organization?.udyamNumber ||
    seller.sellerProfile?.udyamNumber ||
    sellerReg.udyamNumber ||
    sellerReg.udyamDetails?.udyamNumber ||
    sellerReg.udyam ||
    null;

  const sellerPhone = safeDecryptText(
    seller.mobile ||
    seller.sellerProfile?.mobile ||
    sellerReg.mobile ||
    sellerReg.phone
  ) || 'N/A';

  const sellerEmail = safeDecryptText(seller.email || sellerReg.email) || 'N/A';

  const poNum = po.poNumber || `PO-${po.id || 'N/A'}`;
  const dateStr = formatDate(po.createdAt || new Date());
  const deliveryDateStr = po.expectedDelivery ? formatDate(po.expectedDelivery) : 'As per schedule';
  const orderStatus = String(po.status || 'Issued').toUpperCase();
  const paymentTerms = String(po.paymentTerms || 'PAY ON INVOICE').toUpperCase();
  const deliveryType = String(po.deliveryType || 'Standard delivery').toUpperCase();
  const acknowledgedAt = po.acceptedAt ? formatDate(po.acceptedAt) : 'Pending / Not recorded';
  const poRef = `ID #${po.id}`;
  const poTitle = po.title || 'Purchase Order';

  const rawItems = po.items?.length ? po.items : [];
  const totalAmountNum = Number(po.amount || po.totalValue || 0);

  const items = rawItems.length > 0
    ? rawItems.map((item: any, idx: number) => {
        const qty = Number(item.quantity || 1);
        const unitPrice = Number(item.unitPrice || 0);
        const lineTotal = Number(item.totalAmount || qty * unitPrice || totalAmountNum);
        return {
          srNo: idx + 1,
          description: item.itemName || po.title || 'Order Item',
          hsn: item.hsnCode || 'N/A',
          qty,
          unitPrice: unitPrice || (lineTotal / Math.max(qty, 1)),
          totalAmount: lineTotal
        };
      })
    : [{
        srNo: 1,
        description: po.title || `Purchase Order #${poNum}`,
        hsn: 'N/A',
        qty: 1,
        unitPrice: totalAmountNum,
        totalAmount: totalAmountNum
      }];

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 36 });
      const buffers: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err: Error) => reject(err));

      const pageMargin = 36;
      const contentWidth = 595.28 - (pageMargin * 2); // 523.28
      const rightX = pageMargin + contentWidth;

      // 1. TOP HEADER BANNER (Deep Navy #0b2447)
      const bannerHeight = 44;
      doc.rect(pageMargin, 28, contentWidth, bannerHeight).fill('#0b2447');

      // Left: Buyer / Issuer Logo & Company Name
      const logoToUse = buyerLogoBuf || sellerLogoBuf;
      const textStartX = logoToUse ? pageMargin + 48 : pageMargin + 12;

      if (logoToUse) {
        safeDrawImage(doc, logoToUse, pageMargin + 8, 32, { fit: [36, 36], align: 'left' });
      }

      doc.fillColor('#ffffff').fontSize(10.5).font('Helvetica-Bold').text(buyerName.toUpperCase(), textStartX, 34, { width: contentWidth - (logoToUse ? 230 : 200), ellipsis: true });
      doc.fillColor('#94a3b8').fontSize(7.5).font('Helvetica').text('Official Purchase Order Document', textStartX, 52);

      // Right: Document Title, PO Number, Date, Status
      doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold').text('PURCHASE ORDER', pageMargin, 33, { width: contentWidth - 10, align: 'right' });
      doc.fillColor('#e2e8f0').fontSize(8).font('Helvetica').text(`No: ${poNum}`, pageMargin, 47, { width: contentWidth - 10, align: 'right' });
      doc.fillColor('#cbd5e1').fontSize(7.5).font('Helvetica').text(`Date: ${dateStr}  |  Status: ${orderStatus}`, pageMargin, 57, { width: contentWidth - 10, align: 'right' });

      let currentY = 78;

      // 2. PARTIES SECTION (Ship To / Buyer & Vendor / Seller Side-by-Side)
      const colGap = 8;
      const boxW = (contentWidth - colGap) / 2; // ~257.64
      const boxH = 92;
      const rightBoxX = pageMargin + boxW + colGap;

      // Left Box (Ship To / Buyer)
      doc.rect(pageMargin, currentY, boxW, boxH).strokeColor('#cbd5e1').lineWidth(0.75).stroke();
      doc.rect(pageMargin, currentY, boxW, 16).fill('#1e4072');
      doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold').text('SHIP TO / BUYER', pageMargin + 8, currentY + 4);

      doc.fillColor('#0f172a').fontSize(8.5).font('Helvetica-Bold').text(buyerName, pageMargin + 8, currentY + 20, { width: boxW - 16, ellipsis: true });
      doc.fillColor('#475569').fontSize(7.5).font('Helvetica').text(buyerAddress, pageMargin + 8, currentY + 32, { width: boxW - 16, height: 26, ellipsis: true });
      doc.fillColor('#0f172a').fontSize(7.5).font('Helvetica-Bold').text(`GSTIN: ${buyerGstin}${buyerPan !== 'N/A' ? `  |  PAN: ${buyerPan}` : ''}`, pageMargin + 8, currentY + 62, { width: boxW - 16, ellipsis: true });
      doc.fillColor('#64748b').fontSize(7).font('Helvetica').text(`Email: ${buyerEmail}  |  Mobile: ${buyerPhone}`, pageMargin + 8, currentY + 74, { width: boxW - 16, ellipsis: true });

      // Right Box (Vendor / Seller)
      doc.rect(rightBoxX, currentY, boxW, boxH).strokeColor('#cbd5e1').lineWidth(0.75).stroke();
      doc.rect(rightBoxX, currentY, boxW, 16).fill('#1e4072');
      doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold').text('VENDOR / SELLER', rightBoxX + 8, currentY + 4);

      if (sellerLogoBuf) {
        safeDrawImage(doc, sellerLogoBuf, rightBoxX + boxW - 38, currentY + 18, { fit: [30, 24], align: 'right' });
      }

      doc.fillColor('#0f172a').fontSize(8.5).font('Helvetica-Bold').text(sellerName, rightBoxX + 8, currentY + 20, { width: boxW - 48, ellipsis: true });
      doc.fillColor('#475569').fontSize(7.5).font('Helvetica').text(sellerAddress, rightBoxX + 8, currentY + 32, { width: boxW - 16, height: 26, ellipsis: true });
      doc.fillColor('#0f172a').fontSize(7.5).font('Helvetica-Bold').text(`GSTIN: ${sellerGstin}${sellerPan !== 'N/A' ? `  |  PAN: ${sellerPan}` : ''}${sellerUdyam ? `  |  Udyam: ${sellerUdyam}` : ''}`, rightBoxX + 8, currentY + 62, { width: boxW - 16, ellipsis: true });
      doc.fillColor('#64748b').fontSize(7).font('Helvetica').text(`Email: ${sellerEmail}  |  Mobile: ${sellerPhone}`, rightBoxX + 8, currentY + 74, { width: boxW - 16, ellipsis: true });

      currentY += boxH + 8;

      // 3. INFOGRID (Order Metadata Bar - 6 columns)
      doc.rect(pageMargin, currentY, contentWidth, 32).fillAndStroke('#f1f5f9', '#cbd5e1');
      const infoColW = contentWidth / 6;

      const drawInfoCell = (idx: number, label: string, val: string) => {
        const cellX = pageMargin + (idx * infoColW);
        doc.fillColor('#64748b').fontSize(6.5).font('Helvetica-Bold').text(label, cellX + 5, currentY + 5, { width: infoColW - 10, ellipsis: true });
        doc.fillColor('#0f172a').fontSize(7.5).font('Helvetica-Bold').text(val, cellX + 5, currentY + 17, { width: infoColW - 10, ellipsis: true });
      };

      drawInfoCell(0, 'PAYMENT TERMS', paymentTerms);
      drawInfoCell(1, 'DELIVERY TYPE', deliveryType);
      drawInfoCell(2, 'EXP. DELIVERY', deliveryDateStr);
      drawInfoCell(3, 'ACKNOWLEDGED AT', acknowledgedAt);
      drawInfoCell(4, 'PO REFERENCE', poRef);
      drawInfoCell(5, 'ORDER TITLE', poTitle);

      currentY += 40;

      // 4. ITEMS TABLE
      const poColX = [pageMargin, pageMargin + 25, pageMargin + 255, pageMargin + 315, pageMargin + 360, pageMargin + 435];
      const poColW = [25, 230, 60, 45, 75, 88.28];

      // Table Header Row
      doc.rect(pageMargin, currentY, contentWidth, 18).fill('#0b2447');
      doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold');
      doc.text('#', poColX[0] + 2, currentY + 5, { width: poColW[0] - 4, align: 'center' });
      doc.text('Description of Goods / Services', poColX[1] + 4, currentY + 5, { width: poColW[1] - 8, align: 'left' });
      doc.text('HSN/SAC', poColX[2] + 2, currentY + 5, { width: poColW[2] - 4, align: 'center' });
      doc.text('Qty', poColX[3] + 2, currentY + 5, { width: poColW[3] - 4, align: 'center' });
      doc.text('Rate', poColX[4] + 4, currentY + 5, { width: poColW[4] - 8, align: 'right' });
      doc.text('Line Total', poColX[5] + 4, currentY + 5, { width: poColW[5] - 8, align: 'right' });

      currentY += 18;

      // Items Rows
      items.forEach((item, idx) => {
        if (currentY + 20 > 841.89 - 180) {
          doc.addPage();
          currentY = 36;
        }
        const rowBg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
        doc.rect(pageMargin, currentY, contentWidth, 20).fill(rowBg);
        doc.rect(pageMargin, currentY, contentWidth, 20).strokeColor('#e2e8f0').lineWidth(0.5).stroke();

        doc.fillColor('#334155').fontSize(7.5).font('Helvetica');
        doc.text(String(item.srNo), poColX[0] + 2, currentY + 6, { width: poColW[0] - 4, align: 'center' });
        doc.font('Helvetica-Bold').fillColor('#0f172a').text(item.description, poColX[1] + 4, currentY + 6, { width: poColW[1] - 8, height: 12, ellipsis: true });
        doc.font('Helvetica').fillColor('#475569').text(item.hsn, poColX[2] + 2, currentY + 6, { width: poColW[2] - 4, align: 'center' });
        doc.text(String(item.qty), poColX[3] + 2, currentY + 6, { width: poColW[3] - 4, align: 'center' });
        doc.text(formatInr(item.unitPrice), poColX[4] + 4, currentY + 6, { width: poColW[4] - 8, align: 'right' });
        doc.font('Helvetica-Bold').fillColor('#0f172a').text(formatInr(item.totalAmount), poColX[5] + 4, currentY + 6, { width: poColW[5] - 8, align: 'right' });

        currentY += 20;
      });

      currentY += 8;

      // 5. FINANCIALS SUMMARY BOX (Right aligned with zero text collisions)
      const poSummaryW = 230;
      const poSummaryX = rightX - poSummaryW;

      doc.rect(poSummaryX, currentY, poSummaryW, 46).fillAndStroke('#f8fafc', '#cbd5e1');
      doc.fillColor('#475569').fontSize(8).font('Helvetica').text('Subtotal (Taxable Value):', poSummaryX + 10, currentY + 6);
      doc.fillColor('#0f172a').fontSize(8).font('Helvetica-Bold').text(formatInr(totalAmountNum), poSummaryX + 10, currentY + 6, { width: poSummaryW - 20, align: 'right' });

      doc.rect(poSummaryX, currentY + 18, poSummaryW, 28).fill('#0b2447');
      doc.fillColor('#ffffff').fontSize(8.5).font('Helvetica-Bold').text('GRAND TOTAL:', poSummaryX + 10, currentY + 27);
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold').text(formatInr(totalAmountNum), poSummaryX + 10, currentY + 27, { width: poSummaryW - 20, align: 'right' });

      // Amount in words
      doc.fillColor('#64748b').fontSize(7.5).font('Helvetica-Oblique').text(`Amount in words: ${numberToWords(totalAmountNum)}`, pageMargin + 10, currentY + 14, { width: contentWidth - poSummaryW - 20 });

      currentY += 56;

      // 6. CONTRACTUAL TERMS & CONDITIONS
      doc.fillColor('#0f172a').fontSize(8).font('Helvetica-Bold').text('Notes / Terms & Conditions:', pageMargin, currentY);
      currentY += 12;

      const poMetadata = (po?.metadata || {}) as any;
      const ldClause = poMetadata.ldTerms || poMetadata.penaltyClause || poMetadata.termsDocuments?.delayPenaltyDetails;
      const warranty = poMetadata.warrantyTerms || poMetadata.termsDocuments?.warrantyTerms;
      const isPbgReq = po?.pbgRequired ?? poMetadata.pbgRequired;
      const pbgPct = po?.pbgPercentage ?? poMetadata.pbgPercentage;
      const pbgAmt = poMetadata.pbgAmount;
      const pbgExempt = poMetadata.pbgExemptReason || (!isPbgReq ? 'MSE_STATUTORY_WAIVER' : null);

      const terms = [
        '1. This document is generated from the JSGSMILE Enterprise Procurement Portal workflow and must be read with linked GRN, invoice and payment records.',
        '2. Supplier must fulfil quantity, quality, delivery schedule, taxes and documentation requirements recorded against the purchase order.',
        '3. Buyer approval, payment release and settlement remain subject to portal approval matrix, delivery confirmation and invoice verification.'
      ];

      if (ldClause) {
        terms.push(`4. Liquidated Damages (Late Delivery): ${ldClause}`);
      }

      if (warranty) {
        terms.push(`5. Warranty Terms & Support Obligation: ${warranty}`);
      }

      if (isPbgReq && pbgPct > 0) {
        terms.push(`6. Performance Security (GFR Rule 171): ${pbgPct}%${pbgAmt ? ` (₹${Number(pbgAmt).toLocaleString('en-IN')})` : ''} via e-PBG / FDR or 5% MSME Retention Money Deduction from invoices.`);
      } else if (pbgExempt) {
        terms.push(`6. Performance Security (GFR Rule 171): 100% Waived under Public Procurement Policy for MSEs Order, 2012 (Statutory Exemption).`);
      }

      terms.forEach((term) => {
        if (currentY + 14 > 841.89 - 140) {
          doc.addPage();
          currentY = 36;
        }
        doc.fillColor('#475569').fontSize(7).font('Helvetica').text(term, pageMargin, currentY, { width: contentWidth });
        currentY += 11;
      });

      currentY += 8;

      // 7. BILATERAL SIGNATURES SECTION
      const sigBlockH = 92;
      if (currentY + sigBlockH > 841.89 - 40) {
        doc.addPage();
        currentY = 36;
      }

      // Left: Buyer Signatory Block
      doc.fillColor('#0f172a').fontSize(8.5).font('Helvetica-Bold').text(`For ${buyerName}`, pageMargin, currentY, { width: boxW, ellipsis: true });

      if (buyerStampBuf) {
        safeDrawImage(doc, buyerStampBuf, pageMargin, currentY + 14, { fit: [60, 40], align: 'left' });
      }
      if (buyerSigBuf) {
        safeDrawImage(doc, buyerSigBuf, pageMargin, currentY + (buyerStampBuf ? 54 : 16), { fit: [75, 26], align: 'left' });
      }
      doc.fillColor('#64748b').fontSize(7.5).font('Helvetica').text('Authorized Signatory (Issuing Authority)', pageMargin, currentY + 80);

      // Right: Seller Signatory Block
      doc.fillColor('#0f172a').fontSize(8.5).font('Helvetica-Bold').text(`For ${sellerName}`, rightBoxX, currentY, { width: boxW, align: 'right', ellipsis: true });

      if (sellerStampBuf) {
        safeDrawImage(doc, sellerStampBuf, rightBoxX + boxW - 65, currentY + 14, { fit: [60, 40], align: 'right' });
      }
      if (sellerSigBuf) {
        safeDrawImage(doc, sellerSigBuf, rightBoxX + boxW - 80, currentY + (sellerStampBuf ? 54 : 16), { fit: [75, 26], align: 'right' });
      }
      doc.fillColor('#64748b').fontSize(7.5).font('Helvetica').text('Authorized Signatory (Supplier Representative)', rightBoxX, currentY + 80, { width: boxW, align: 'right' });

      // Page bottom footer
      doc.strokeColor('#cbd5e1').lineWidth(0.5);
      doc.moveTo(pageMargin, 810).lineTo(rightX, 810).stroke();
      doc.fillColor('#94a3b8').fontSize(7).font('Helvetica').text('JSGSMILE Enterprise Procurement Portal', pageMargin, 816);
      doc.text('Page 1 of 1', pageMargin, 816, { width: contentWidth, align: 'right' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Retrieves existing stored PO PDF buffer or generates exact Purchase Order PDF buffer.
 */
export async function getOrGeneratePurchaseOrderPdfBuffer(po: any): Promise<{ buffer: Buffer; filename: string }> {
  let fullPo = po;
  const poId = typeof po === 'number' ? po : po?.id;
  if (poId && (!po?.buyer?.registrationDetails || !po?.items || !po?.seller?.registrationDetails)) {
    try {
      const dbPo = await db.purchaseOrder.findUnique({
        where: { id: poId },
        include: {
          items: true,
          buyer: {
            select: {
              id: true,
              name: true,
              email: true,
              mobile: true,
              registrationDetails: true,
              buyerProfile: true,
              organizationId: true,
              organization: {
                include: { profile: true }
              }
            }
          },
          seller: {
            select: {
              id: true,
              name: true,
              email: true,
              mobile: true,
              registrationDetails: true,
              sellerProfile: true,
              organizationId: true,
              organization: {
                include: { profile: true }
              }
            }
          }
        }
      });
      if (dbPo) {
        fullPo = { ...po, ...dbPo };
      }
    } catch (fetchErr) {
      logger.warn({ fetchErr, poId }, 'Failed to fetch complete purchase order relations for PDF');
    }
  }

  if (!fullPo.externalPdfFileId && !fullPo.pdfFileId && poId > 0) {
    try {
      const freshPo = await db.purchaseOrder.findUnique({
        where: { id: poId },
        select: { externalPdfFileId: true, pdfFileId: true, poNumber: true }
      });
      if (freshPo?.externalPdfFileId) {
        fullPo = { ...fullPo, externalPdfFileId: freshPo.externalPdfFileId };
      }
      if (freshPo?.pdfFileId) {
        fullPo = { ...fullPo, pdfFileId: freshPo.pdfFileId };
      }
    } catch {}
  }

  const attachedFileId = fullPo.externalPdfFileId || fullPo.pdfFileId;
  const filename = `PurchaseOrder_${fullPo.poNumber || `PO-${fullPo.id || 'N/A'}`}.pdf`;

  if (attachedFileId) {
    try {
      const asset = await db.fileAsset.findUnique({ where: { id: attachedFileId } });
      if (asset && asset.status !== 'deleted') {
        const stored = await getFileContent(asset.id, { id: asset.ownerId || fullPo.buyerId || 1, role: 'admin' });
        if (stored?.buffer && stored.buffer.length > 0) {
          logger.info({ poId: fullPo.id, assetId: asset.id, bytes: stored.buffer.length, filename: asset.originalName }, '[getOrGeneratePurchaseOrderPdfBuffer] Successfully resolved authentic uploaded PO PDF');
          return {
            buffer: stored.buffer,
            filename: asset.originalName || filename
          };
        }
      }
    } catch (err) {
      logger.warn({ err, attachedFileId }, 'Failed to fetch uploaded PO PDF buffer, falling back to generator');
    }
  }

  const buffer = await generatePurchaseOrderPdfBuffer(fullPo);
  return { buffer, filename };
}

/**
 * Sends notification emails with the attached Purchase Order PDF to BOTH the seller and the buyer
 * whenever a Purchase Order is created/generated (from cart checkout, procurement checkout, RFQ award, etc.).
 */
export async function notifyPurchaseOrderCreated(purchaseOrderId: number) {
  try {
    const po = await db.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: {
        items: true,
        buyer: {
          select: {
            id: true,
            name: true,
            email: true,
            mobile: true,
            registrationDetails: true,
            organizationId: true,
            buyerProfile: true,
            organization: { include: { profile: true } }
          }
        },
        seller: {
          select: {
            id: true,
            name: true,
            email: true,
            mobile: true,
            registrationDetails: true,
            organizationId: true,
            sellerProfile: true,
            organization: { include: { profile: true } }
          }
        }
      }
    });

    if (!po) {
      logger.warn({ purchaseOrderId }, 'Purchase order not found for notification');
      return;
    }

    const statusLower = String(po.status || po.poStatus || '').toLowerCase();
    const isIssued = ['issued', 'pending_acceptance', 'order_placed', 'accepted', 'in_fulfillment', 'generated', 'order_confirmed'].includes(statusLower) && !po.isDraft;
    if (!isIssued) {
      logger.info({ purchaseOrderId, status: po.status, isDraft: po.isDraft }, '[notifyPurchaseOrderCreated] Skipping PO email notification because PO is still a draft / not yet issued');
      return;
    }

    const formattedAmount = `₹${Number(po.amount || po.totalValue || 0).toLocaleString('en-IN')}`;
    const poNum = po.poNumber || `PO-${po.id}`;
    const deliveryDateStr = po.expectedDelivery ? formatDate(po.expectedDelivery) : 'As per schedule';

    const meta = (typeof po.metadata === 'object' && po.metadata !== null ? po.metadata : {}) as Record<string, any>;
    const billingDetails = (meta.billingDetails || {}) as Record<string, any>;

    const buyerDisplayName =
      billingDetails.companyName ||
      po.buyer?.organization?.organizationName ||
      po.buyer?.buyerProfile?.organizationName ||
      po.buyer?.name ||
      'Buyer';

    const sellerDisplayName =
      po.seller?.organization?.organizationName ||
      po.seller?.sellerProfile?.businessName ||
      po.seller?.name ||
      'Supplier';

    let pdfAttachment: { filename: string; content: Buffer; contentType: string } | undefined = undefined;

    try {
      const pdfRes = await getOrGeneratePurchaseOrderPdfBuffer(po);
      if (pdfRes?.buffer && pdfRes.buffer.length > 0) {
        pdfAttachment = {
          filename: pdfRes.filename || `PurchaseOrder_${poNum}.pdf`,
          content: pdfRes.buffer,
          contentType: 'application/pdf'
        };
        logger.info({ poId: po.id, sellerId: po.sellerId, buyerId: po.buyerId, filename: pdfAttachment.filename }, 'Purchase Order PDF attached for buyer and seller notification emails');
      }
    } catch (pdfErr) {
      logger.error({ error: pdfErr, poId: po.id }, 'Failed to generate/fetch Purchase Order PDF for notification');
    }

    const emailNote = pdfAttachment ? ' (Official Purchase Order PDF is attached to this email.)' : '';

    const escapeHtml = (value: unknown) =>
      String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const isDirectPurchase = po.sourceType === 'direct_purchase' || !po.tenderId;
    const notificationType = isDirectPurchase ? 'direct_purchase_po_generated' : 'po_generated';
    const rawAmountNum = Number(po.amount || po.totalValue || 0);
    const amountStr = rawAmountNum.toLocaleString('en-IN');
    const orderDesc = isDirectPurchase ? 'your direct purchase order' : 'your awarded tender';

    const commonVars = {
      orderNumber: poNum,
      amount: amountStr,
      currency: po.currency || 'INR',
      formattedAmount,
      orderTitle: po.title || 'Purchase Order',
      buyerName: buyerDisplayName,
      sellerName: sellerDisplayName,
      deliveryDate: deliveryDateStr,
      isDirectPurchase: isDirectPurchase ? 'true' : 'false',
      orderDescription: orderDesc
    };

    // 1. Notify Seller
    if (po.sellerId) {
      const sellerEmailHtml = `
        <div style="margin-bottom: 20px; padding: 18px 20px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px;">
          <p style="margin: 0 0 4px; color: #16a34a; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">New Order Received</p>
          <h2 style="margin: 0; color: #14532d; font-size: 18px; font-weight: 700;">Purchase Order ${escapeHtml(poNum)} Generated</h2>
        </div>

        <p style="margin: 0 0 16px; color: #334155; font-size: 14px; line-height: 1.6;">
          A new Purchase Order has been generated and issued to your organization by <strong>${escapeHtml(buyerDisplayName)}</strong>.
        </p>

        <table role="presentation" style="width: 100%; margin: 0 0 20px; border-collapse: collapse; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; font-size: 13px;">
          <tr style="background: #f8fafc;">
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-weight: 600; width: 38%;">PO Number</td>
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #0f172a; font-weight: 700;">${escapeHtml(poNum)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-weight: 600;">Order Title</td>
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${escapeHtml(po.title || 'Purchase Order')}</td>
          </tr>
          <tr style="background: #f8fafc;">
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-weight: 600;">Total Order Value</td>
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #16a34a; font-weight: 700; font-size: 14px;">${escapeHtml(formattedAmount)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-weight: 600;">Expected Delivery Date</td>
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${escapeHtml(deliveryDateStr)}</td>
          </tr>
          <tr style="background: #f8fafc;">
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-weight: 600;">Payment Terms</td>
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${escapeHtml(String(po.paymentTerms || 'PAY ON INVOICE').toUpperCase())}</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; color: #64748b; font-weight: 600;">Delivery Address</td>
            <td style="padding: 10px 14px; color: #0f172a;">${escapeHtml(po.deliveryAddress || 'As per purchase order')}</td>
          </tr>
        </table>

        <p style="margin: 0 0 16px; color: #475569; font-size: 13px; line-height: 1.6;">
          📄 The official Purchase Order PDF (<strong>${escapeHtml(pdfAttachment?.filename || `PurchaseOrder_${poNum}.pdf`)}</strong>) is attached to this email for your reference and fulfillment records.
        </p>

        <p style="margin: 0; color: #475569; font-size: 13px; line-height: 1.6;">
          Please log into your MSME portal dashboard to accept the order, coordinate dispatch, and generate the corresponding invoice once goods/services are delivered.
        </p>
      `;

      notifyWorkflowSoon(
        po.sellerId,
        `New Purchase Order Received: ${poNum}`,
        `A new Purchase Order ${poNum} (${po.title}) for amount ${formattedAmount} has been issued to your organization by ${buyerDisplayName}.${emailNote}`,
        notificationType,
        `/seller/orders?orderId=${po.id}`,
        pdfAttachment ? [pdfAttachment] : undefined,
        {
          emailSubject: `[PO Received] New Purchase Order #${poNum} from ${buyerDisplayName} - MSME Portal`,
          emailHtml: sellerEmailHtml,
          variables: {
            ...commonVars,
            actionUrl: `/seller/orders?orderId=${po.id}`
          }
        }
      );
    }

    // 2. Notify Buyer
    if (po.buyerId) {
      const buyerEmailHtml = `
        <div style="margin-bottom: 20px; padding: 18px 20px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px;">
          <p style="margin: 0 0 4px; color: #2563eb; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">Order Confirmation</p>
          <h2 style="margin: 0; color: #1e3a8a; font-size: 18px; font-weight: 700;">Purchase Order ${escapeHtml(poNum)} Generated Successfully</h2>
        </div>

        <p style="margin: 0 0 16px; color: #334155; font-size: 14px; line-height: 1.6;">
          Your Purchase Order has been generated and formally issued to supplier <strong>${escapeHtml(sellerDisplayName)}</strong>.
        </p>

        <table role="presentation" style="width: 100%; margin: 0 0 20px; border-collapse: collapse; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; font-size: 13px;">
          <tr style="background: #f8fafc;">
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-weight: 600; width: 38%;">PO Number</td>
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #0f172a; font-weight: 700;">${escapeHtml(poNum)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-weight: 600;">Supplier / Vendor</td>
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${escapeHtml(sellerDisplayName)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-weight: 600;">Order Title</td>
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${escapeHtml(po.title || 'Purchase Order')}</td>
          </tr>
          <tr style="background: #f8fafc;">
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-weight: 600;">Total Order Value</td>
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #2563eb; font-weight: 700; font-size: 14px;">${escapeHtml(formattedAmount)}</td>
          </tr>
          <tr style="background: #f8fafc;">
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-weight: 600;">Expected Delivery Date</td>
            <td style="padding: 10px 14px; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${escapeHtml(deliveryDateStr)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; color: #64748b; font-weight: 600;">Delivery Address</td>
            <td style="padding: 10px 14px; color: #0f172a;">${escapeHtml(po.deliveryAddress || 'As per purchase order')}</td>
          </tr>
        </table>

        <p style="margin: 0 0 16px; color: #475569; font-size: 13px; line-height: 1.6;">
          📄 The official Purchase Order PDF (<strong>${escapeHtml(pdfAttachment?.filename || `PurchaseOrder_${poNum}.pdf`)}</strong>) is attached to this email for your compliance and accounting records.
        </p>

        <p style="margin: 0; color: #475569; font-size: 13px; line-height: 1.6;">
          You can track the fulfillment, dispatch updates, inspection, and payment milestones anytime from your orders dashboard.
        </p>
      `;

      notifyWorkflowSoon(
        po.buyerId,
        `Purchase Order Generated: ${poNum}`,
        `Your Purchase Order ${poNum} (${po.title}) for amount ${formattedAmount} has been generated successfully and issued to ${sellerDisplayName}.${emailNote}`,
        notificationType,
        `/buyer/orders?orderId=${po.id}`,
        pdfAttachment ? [pdfAttachment] : undefined,
        {
          emailSubject: `[PO Issued] Purchase Order #${poNum} Generated - MSME Portal`,
          emailHtml: buyerEmailHtml,
          variables: {
            ...commonVars,
            actionUrl: `/buyer/orders?orderId=${po.id}`
          }
        }
      );
    }

    logger.info({ poId: po.id, poNum, buyerId: po.buyerId, sellerId: po.sellerId }, 'Purchase Order generated notifications and emails dispatched');
  } catch (err) {
    logger.warn({ err, purchaseOrderId }, 'Failed to notify parties of new purchase order with PDF');
  }
}

/**
 * Backward-compatible alias for notifyPurchaseOrderCreated.
 */
export async function notifySellerNewPurchaseOrder(purchaseOrderId: number) {
  return notifyPurchaseOrderCreated(purchaseOrderId);
}

export interface PaymentReceiptPdfInput {
  id?: number;
  referenceId: string;
  createdAt?: Date | string;
  paidAt?: Date | string;
  completedAt?: Date | string;
  amount?: number | string;
  currency?: string;
  gateway?: string;
  method?: string;
  status?: string;
  invoiceNumber?: string;
  poNumber?: string;
  payerName?: string;
  payerEmail?: string;
  payeeName?: string;
  payeeEmail?: string;
  taxableAmount?: number | string;
  cgstAmount?: number | string;
  sgstAmount?: number | string;
  igstAmount?: number | string;
  tdsAmount?: number | string;
  netAmountPaid?: number | string;
  escrowStatus?: string;
  escrowBalance?: number | string;
  escrowVaultName?: string;
}

/**
 * Generates an official, high-precision Payment Receipt PDF Buffer matching the exact portal UI screenshot.
 */
export async function generatePaymentReceiptPdfBuffer(input: PaymentReceiptPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 36 });
      const buffers: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err: Error) => reject(err));

      const pageMargin = 36;
      const contentWidth = 595.28 - (pageMargin * 2);

      // Top Navy Accent Bar
      doc.rect(pageMargin, pageMargin, contentWidth, 4).fill('#12335f');

      let currentY = pageMargin + 14;

      // Header: Portal Name & Status Badge
      doc.fillColor('#64748b').fontSize(7.5).font('Helvetica-Bold').text('GOVERNMENT MSME PORTAL', pageMargin, currentY);
      
      const badgeText = (input.status || 'SUCCESS').toUpperCase();
      doc.roundedRect(pageMargin + contentWidth - 75, currentY, 75, 16, 8).fill('#dcfce7');
      doc.fillColor('#15803d').fontSize(8).font('Helvetica-Bold').text(badgeText, pageMargin + contentWidth - 75, currentY + 4, { width: 75, align: 'center' });

      currentY += 12;

      doc.fillColor('#0f172a').fontSize(20).font('Helvetica-Bold').text('Official Payment Receipt', pageMargin, currentY);
      
      const dateStr = formatDate(input.paidAt || input.completedAt || input.createdAt || new Date());
      
      doc.fillColor('#475569').fontSize(8).font('Helvetica-Bold').text(`DATE: ${dateStr.toUpperCase()}`, pageMargin + contentWidth - 170, currentY + 6, { width: 90, align: 'right' });

      currentY += 26;

      const refId = input.referenceId || `PAY-2026-${String(input.id || '001').padStart(6, '0')}`;
      doc.fillColor('#64748b').fontSize(8).font('Helvetica').text(`System generated receipt for payment reference `, pageMargin, currentY, { continued: true });
      doc.font('Helvetica-Bold').fillColor('#0f172a').text(refId);

      currentY += 20;

      // 3 Top Cards (Receipt Reference, Invoice Number, Purchase Order)
      const colW = (contentWidth - 16) / 3;

      // Card 1: Receipt Reference
      doc.roundedRect(pageMargin, currentY, colW, 44, 6).fillAndStroke('#f8fafc', '#cbd5e1');
      doc.fillColor('#64748b').fontSize(7).font('Helvetica-Bold').text('RECEIPT REFERENCE', pageMargin + 10, currentY + 8);
      doc.fillColor('#0f172a').fontSize(9).font('Helvetica-Bold').text(refId, pageMargin + 10, currentY + 22, { width: colW - 20 });

      // Card 2: Invoice Number
      const card2X = pageMargin + colW + 8;
      doc.roundedRect(card2X, currentY, colW, 44, 6).fillAndStroke('#f8fafc', '#cbd5e1');
      doc.fillColor('#64748b').fontSize(7).font('Helvetica-Bold').text('INVOICE NUMBER', card2X + 10, currentY + 8);
      doc.fillColor('#0f172a').fontSize(9).font('Helvetica-Bold').text(input.invoiceNumber || 'N/A', card2X + 10, currentY + 22, { width: colW - 20 });

      // Card 3: Purchase Order
      const card3X = card2X + colW + 8;
      doc.roundedRect(card3X, currentY, colW, 44, 6).fillAndStroke('#f8fafc', '#cbd5e1');
      doc.fillColor('#64748b').fontSize(7).font('Helvetica-Bold').text('PURCHASE ORDER', card3X + 10, currentY + 8);
      doc.fillColor('#0f172a').fontSize(9).font('Helvetica-Bold').text(input.poNumber || 'N/A', card3X + 10, currentY + 22, { width: colW - 20 });

      currentY += 56;

      // Payer / Buyer & Payee / Seller Block (2 columns)
      const halfW = (contentWidth - 12) / 2;

      // Left: Payer / Buyer
      doc.roundedRect(pageMargin, currentY, halfW, 58, 6).fillAndStroke('#f8fafc', '#cbd5e1');
      doc.fillColor('#64748b').fontSize(7.5).font('Helvetica-Bold').text('PAYER / BUYER', pageMargin + 12, currentY + 10);
      doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold').text(input.payerName || 'N/A', pageMargin + 12, currentY + 24, { width: halfW - 24 });
      doc.fillColor('#64748b').fontSize(8).font('Helvetica').text(input.payerEmail || 'N/A', pageMargin + 12, currentY + 38, { width: halfW - 24 });

      // Right: Payee / Seller
      const rightX = pageMargin + halfW + 12;
      doc.roundedRect(rightX, currentY, halfW, 58, 6).fillAndStroke('#f8fafc', '#cbd5e1');
      doc.fillColor('#64748b').fontSize(7.5).font('Helvetica-Bold').text('PAYEE / SELLER', rightX + 12, currentY + 10);
      doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold').text(input.payeeName || 'N/A', rightX + 12, currentY + 24, { width: halfW - 24 });
      doc.fillColor('#64748b').fontSize(8).font('Helvetica').text(input.payeeEmail || 'N/A', rightX + 12, currentY + 38, { width: halfW - 24 });

      currentY += 72;

      // Total Settlement Amount Box (Blue Banner)
      const totalAmountNum = Number(input.amount || input.netAmountPaid || 0);
      const formattedTotal = formatInr(totalAmountNum);
      const methodStr = input.method ? `Gateway: ${input.gateway || 'bank_transfer'} | Method: ${input.method}` : 'Gateway: bank transfer | Method: card';

      doc.roundedRect(pageMargin, currentY, contentWidth, 68, 8).fill('#f0f9ff').stroke('#bae6fd');
      doc.fillColor('#0369a1').fontSize(8).font('Helvetica-Bold').text('TOTAL SETTLEMENT AMOUNT', pageMargin, currentY + 14, { width: contentWidth, align: 'center' });
      doc.fillColor('#0c4a6e').fontSize(22).font('Helvetica-Bold').text(formattedTotal, pageMargin, currentY + 28, { width: contentWidth, align: 'center' });
      doc.fillColor('#0284c7').fontSize(8).font('Helvetica').text(methodStr, pageMargin, currentY + 52, { width: contentWidth, align: 'center' });

      currentY += 82;

      // Tax and Deduction Summary Header
      doc.fillColor('#475569').fontSize(8).font('Helvetica-Bold').text('TAX AND DEDUCTION SUMMARY', pageMargin, currentY);

      currentY += 14;

      // Table Headers
      doc.rect(pageMargin, currentY, contentWidth, 20).fill('#f1f5f9');
      doc.fillColor('#334155').fontSize(7.5).font('Helvetica-Bold').text('DESCRIPTION', pageMargin + 10, currentY + 6);
      doc.fillColor('#334155').fontSize(7.5).font('Helvetica-Bold').text('AMOUNT (INR)', pageMargin + contentWidth - 120, currentY + 6, { width: 110, align: 'right' });

      currentY += 20;

      const taxableNum = Number(input.taxableAmount || totalAmountNum);
      const cgstNum = Number(input.cgstAmount || 0);
      const sgstNum = Number(input.sgstAmount || 0);
      const igstNum = Number(input.igstAmount || 0);
      const tdsNum = Number(input.tdsAmount || 0);

      const tableRows = [
        { label: 'Taxable Amount', amount: taxableNum },
        { label: 'CGST', amount: cgstNum },
        { label: 'SGST', amount: sgstNum },
        { label: 'IGST', amount: igstNum },
        { label: 'TDS Deducted', amount: -tdsNum, isNegative: true },
      ];

      tableRows.forEach((row, idx) => {
        const bg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
        doc.rect(pageMargin, currentY, contentWidth, 18).fill(bg);
        doc.fillColor('#334155').fontSize(8).font('Helvetica').text(row.label, pageMargin + 10, currentY + 5);
        const amtStr = row.isNegative && row.amount < 0 ? `-${formatInr(Math.abs(row.amount))}` : formatInr(row.amount);
        doc.fillColor('#334155').fontSize(8).font('Helvetica').text(amtStr, pageMargin + contentWidth - 120, currentY + 5, { width: 110, align: 'right' });
        currentY += 18;
      });

      // Net Amount Paid Row (Bold Highlight)
      doc.rect(pageMargin, currentY, contentWidth, 22).fill('#e2e8f0');
      doc.fillColor('#0f172a').fontSize(8.5).font('Helvetica-Bold').text('Net Amount Paid', pageMargin + 10, currentY + 6);
      doc.fillColor('#0f172a').fontSize(9).font('Helvetica-Bold').text(formattedTotal, pageMargin + contentWidth - 120, currentY + 6, { width: 110, align: 'right' });

      currentY += 30;

      // Escrow Custody Status Box
      doc.roundedRect(pageMargin, currentY, contentWidth, 42, 6).fillAndStroke('#f0fdf4', '#bbf7d0');
      doc.fillColor('#166534').fontSize(7.5).font('Helvetica-Bold').text(input.escrowVaultName || 'ESCROW ACCOUNT VAULT-B', pageMargin + 12, currentY + 10);
      doc.fillColor('#15803d').fontSize(8.5).font('Helvetica').text(`Custody Balance: `, pageMargin + 12, currentY + 24, { continued: true });
      doc.font('Helvetica-Bold').text(formattedTotal);

      // Held Badge inside escrow card
      const escrowBadgeText = (input.escrowStatus || 'HELD').toUpperCase();
      doc.roundedRect(pageMargin + contentWidth - 60, currentY + 12, 50, 18, 4).fill('#dcfce7');
      doc.fillColor('#15803d').fontSize(8).font('Helvetica-Bold').text(escrowBadgeText, pageMargin + contentWidth - 60, currentY + 16, { width: 50, align: 'center' });

      currentY += 54;

      // Footer declaration
      doc.fillColor('#94a3b8').fontSize(7.5).font('Helvetica').text(
        'This is an official computer-generated payment receipt from the Government MSME Portal finance module.',
        pageMargin,
        currentY,
        { width: contentWidth, align: 'center' }
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Sends a notification email with attached Payment Receipt PDF to both Payer (Buyer) and Payee (Seller) when a payment is completed.
 */
export async function notifyPaymentReceiptEmail(paymentId: number) {
  try {
    const payment = await db.paymentTransaction.findUnique({
      where: { id: paymentId },
      include: {
        invoice: {
          include: {
            purchaseOrder: true,
            items: true
          }
        },
        purchaseOrder: {
          include: {
            items: true
          }
        },
        payer: {
          select: {
            id: true,
            name: true,
            email: true,
            mobile: true,
            buyerProfile: true,
            organization: { include: { profile: true } }
          }
        },
        payee: {
          select: {
            id: true,
            name: true,
            email: true,
            mobile: true,
            sellerProfile: true,
            organization: { include: { profile: true } }
          }
        },
        escrowAccount: true
      }
    });

    if (!payment) return;

    const refId = payment.referenceId || `PAY-2026-${String(payment.id).padStart(6, '0')}`;
    const invNo = payment.invoice?.invoiceNumber || (payment.purchaseOrder?.poNumber ? `INV-${payment.purchaseOrder.poNumber}` : `INV-${payment.invoiceId || payment.id}`);
    const poNum = payment.purchaseOrder?.poNumber || (payment.invoice?.purchaseOrder?.poNumber) || `PO-${payment.purchaseOrderId || payment.id}`;

    const payerName = payment.payer?.organization?.organizationName || payment.payer?.name || 'Buyer';
    const payeeName = payment.payee?.organization?.organizationName || payment.payee?.name || 'Seller';

    const pdfBuffer = await generatePaymentReceiptPdfBuffer({
      id: payment.id,
      referenceId: refId,
      createdAt: payment.createdAt,
      paidAt: payment.completedAt || payment.updatedAt,
      amount: payment.amount,
      currency: payment.currency || 'INR',
      gateway: payment.gateway || 'bank_transfer',
      method: payment.method || 'card',
      status: payment.status || 'success',
      invoiceNumber: invNo,
      poNumber: poNum,
      payerName,
      payerEmail: payment.payer?.email || '',
      payeeName,
      payeeEmail: payment.payee?.email || '',
      taxableAmount: payment.invoice?.taxableAmount || payment.amount,
      cgstAmount: payment.invoice?.cgstAmount || 0,
      sgstAmount: payment.invoice?.sgstAmount || 0,
      igstAmount: payment.invoice?.igstAmount || 0,
      tdsAmount: payment.invoice?.tdsAmount || 0,
      escrowStatus: payment.escrowAccount?.status || 'held',
      escrowBalance: payment.escrowAccount?.amount || payment.amount,
      escrowVaultName: 'ESCROW ACCOUNT VAULT-B'
    });

    const pdfAttachment = {
      filename: `PaymentReceipt_${refId}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf'
    };

    const formattedAmount = `₹${Number(payment.amount || 0).toLocaleString('en-IN')}`;

    // 1. Notify Payer (Buyer) with attached Payment Receipt PDF
    if (payment.payerId) {
      notifyWorkflowSoon(
        payment.payerId,
        `Payment Confirmation & Receipt: ${refId}`,
        `Your payment of ${formattedAmount} for Invoice ${invNo} (PO ${poNum}) has been successfully processed and confirmed. Official payment receipt PDF is attached to this email.`,
        'payment_successful',
        '/payments/invoices',
        [pdfAttachment]
      );
    }

    // 2. Notify Payee (Seller) with attached Payment Receipt PDF
    if (payment.payeeId) {
      notifyWorkflowSoon(
        payment.payeeId,
        `Payment Received & Escrow Funded: ${refId}`,
        `Payment of ${formattedAmount} for Invoice ${invNo} (PO ${poNum}) from ${payerName} has been confirmed and placed in escrow custody. Official payment receipt PDF is attached to this email.`,
        'escrow_funded',
        '/payments/invoices',
        [pdfAttachment]
      );
    }

    logger.info({ paymentId: payment.id, refId, filename: pdfAttachment.filename }, 'Payment Receipt PDF generated and sent via email notification');
  } catch (err) {
    logger.error({ err, paymentId }, 'Failed to generate and email Payment Receipt PDF');
  }
}
