import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import prisma from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { normalizeSpaces } from '../../utils/sanitize.js';
import { auditLog } from '../../modules/audit/audit.service.js';
import { checkOwnership } from '../../middleware/ownership.js';
import { gcpStorageProvider, isPrivateDocument, encryptBufferEnvelope, decryptBufferEnvelope } from './gcp-storage.service.js';
import { mapEntityTypeToFolder } from './storage-folders.enum.js';
import { scanBufferForMalware } from './malware-scanner.service.js';

export type StorageProviderName = 'gcp' | string;
export type StorageResourceType = 'image' | 'raw';

export type FileUploadContext = {
  ownerId: number;
  ownerRole: string;
  entityType: string;
  entityId?: number | null;
  purpose?: string;
  ipAddress?: string;
  userAgent?: string;
};

export type StorageUploadInput = {
  buffer: Buffer;
  key: string;
  folder: string;
  mimeType: string;
  resourceType: StorageResourceType;
  context: FileUploadContext;
};

export type StorageUploadResult = {
  provider: StorageProviderName;
  bucket?: string;
  key: string;
  url?: string;
};

export type StorageProvider = {
  name: StorageProviderName;
  uploadFile(input: StorageUploadInput): Promise<StorageUploadResult>;
  deleteFile(key: string, resourceType?: StorageResourceType): Promise<void>;
  getSignedUrl(key: string, options: { resourceType: StorageResourceType; expiresInSeconds: number; mimeType?: string }): Promise<string>;
};

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const allowedByExtension: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.webp': ['image/webp'],
  '.doc': ['application/msword', 'application/octet-stream'],
  '.docx': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/octet-stream',
    'application/x-zip-compressed',
    'application/zip'
  ],
  '.xls': ['application/vnd.ms-excel', 'application/octet-stream'],
  '.xlsx': [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream',
    'application/x-zip-compressed',
    'application/zip'
  ],
  '.csv': [
    'text/csv',
    'application/csv',
    'application/vnd.ms-excel',
    'text/plain',
    'application/octet-stream',
    'text/comma-separated-values',
    'text/x-csv',
    'application/x-csv'
  ],
  '.webm': ['audio/webm', 'video/webm'],
  '.ogg': ['audio/ogg', 'application/ogg'],
  '.mp3': ['audio/mpeg', 'audio/mp3'],
  '.wav': ['audio/wav', 'audio/wave', 'audio/x-wav'],
  '.m4a': ['audio/x-m4a', 'audio/m4a', 'audio/mp4', 'audio/aac']
};

const blockedExtensions = new Set([
  '.exe', '.dll', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.js', '.jar',
  '.msi', '.sh', '.php', '.html', '.htm', '.svg'
]);

const sanitizeOriginalName = (name: string) =>
  normalizeSpaces(path.basename(name || 'file')).replace(/[^\w.\- ()]/g, '_').slice(0, 180) || 'file';

const extensionForMime = (mimeType: string) => {
  if (mimeType === 'application/pdf') return '.pdf';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'application/msword') return '.doc';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return '.docx';
  if (mimeType === 'application/vnd.ms-excel') return '.xls';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return '.xlsx';
  if (['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain', 'text/comma-separated-values', 'text/x-csv', 'application/x-csv'].includes(mimeType)) return '.csv';
  if (['audio/webm', 'video/webm'].includes(mimeType)) return '.webm';
  if (['audio/ogg', 'application/ogg'].includes(mimeType)) return '.ogg';
  if (['audio/mpeg', 'audio/mp3'].includes(mimeType)) return '.mp3';
  if (['audio/wav', 'audio/wave', 'audio/x-wav'].includes(mimeType)) return '.wav';
  if (['audio/x-m4a', 'audio/m4a', 'audio/mp4', 'audio/aac'].includes(mimeType)) return '.m4a';
  return '.bin';
};

const detectMagicMime = (buffer: Buffer, declaredMime?: string): string | null => {
  if (buffer.subarray(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) return 'application/pdf';
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x52, 0x49, 0x46, 0x46])) && buffer.subarray(8, 12).equals(Buffer.from([0x57, 0x45, 0x42, 0x50]))) return 'image/webp';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x52, 0x49, 0x46, 0x46])) && buffer.subarray(8, 12).equals(Buffer.from([0x57, 0x41, 0x56, 0x45]))) return 'audio/wav';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'audio/webm';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x4f, 0x67, 0x67, 0x53]))) return 'audio/ogg';
  if (buffer.subarray(0, 3).equals(Buffer.from([0x49, 0x44, 0x33])) || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buffer.subarray(4, 8).equals(Buffer.from([0x66, 0x74, 0x79, 0x70]))) return 'audio/x-m4a';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const archiveIndex = buffer.toString('latin1');
    if (archiveIndex.includes('xl/')) {
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    if (archiveIndex.includes('word/')) {
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    if (archiveIndex.includes('ppt/')) {
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    }
    if (archiveIndex.includes('[Content_Types].xml')) {
      if (declaredMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      }
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    return null;
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return declaredMime === 'application/vnd.ms-excel' ? 'application/vnd.ms-excel' : 'application/msword';
  }
  // Robust CSV / Text detection: strip UTF-8 BOM, allow valid UTF-8 text with delimiters
  let textSample = buffer.subarray(0, Math.min(buffer.length, 2048));
  if (textSample.length >= 3 && textSample[0] === 0xef && textSample[1] === 0xbb && textSample[2] === 0xbf) {
    textSample = textSample.subarray(3);
  }
  const sampleStr = textSample.toString('utf8');
  // Disallow binary control bytes, but allow tab, LF, CR, and printable UTF-8 characters
  const isPrintable = !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(sampleStr);
  if (isPrintable && (sampleStr.includes(',') || sampleStr.includes(';') || sampleStr.includes('\t') || sampleStr.includes('\n'))) {
    return 'text/csv';
  }
  if (declaredMime && ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-m4a'].includes(declaredMime)) {
    return declaredMime;
  }
  return null;
};

const containsExecutableSignature = (buffer: Buffer, isText = false) => {
  if (buffer.subarray(0, 2).toString('ascii') === 'MZ') return true;
  if (isText) {
    const sample = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').toLowerCase();
    return sample.includes('<svg') || sample.includes('<script') || sample.includes('<?php');
  }
  return false;
};

export const validateFile = (file: Express.Multer.File) => {
  if (!file) throw new ApiError(400, 'File is required', 'FILE_REQUIRED');
  if (!file.buffer?.length) throw new ApiError(400, 'Uploaded file is empty', 'FILE_EMPTY');
  if (file.size > MAX_FILE_BYTES) throw new ApiError(400, 'File exceeds maximum size', 'FILE_TOO_LARGE');

  const originalName = sanitizeOriginalName(file.originalname);
  const ext = path.extname(originalName).toLowerCase();
  if (!ext || blockedExtensions.has(ext)) throw new ApiError(400, 'File type is not allowed', 'FILE_EXTENSION_BLOCKED');

  const allowedMimes = allowedByExtension[ext];
  if (!allowedMimes) throw new ApiError(400, 'File extension is not allowed', 'FILE_EXTENSION_NOT_ALLOWED');
  if (!allowedMimes.includes(file.mimetype)) throw new ApiError(400, 'File MIME type does not match extension', 'FILE_MIME_MISMATCH');

  const isText = ext === '.csv' || String(file.mimetype).startsWith('text/');
  if (containsExecutableSignature(file.buffer, isText)) throw new ApiError(400, 'Unsafe file content detected', 'FILE_EXECUTABLE_SIGNATURE');

  const magicMime = detectMagicMime(file.buffer, file.mimetype);
  if (!magicMime || !allowedMimes.includes(magicMime)) {
    if (ext === '.csv') {
      let s = file.buffer.subarray(0, Math.min(file.buffer.length, 2048));
      if (s.length >= 3 && s[0] === 0xef && s[1] === 0xbb && s[2] === 0xbf) s = s.subarray(3);
      const str = s.toString('utf8');
      if (!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(str)) {
        const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');
        const secureName = `${crypto.randomUUID()}.csv`;
        return {
          originalName,
          secureName,
          extension: '.csv',
          mimeType: 'text/csv',
          size: file.size,
          checksum,
          resourceType: 'raw' as StorageResourceType
        };
      }
    }
    if (ext === '.xlsx' && file.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      const archiveIndex = file.buffer.toString('latin1');
      if (archiveIndex.includes('xl/') || archiveIndex.includes('[Content_Types].xml')) {
        const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');
        const secureName = `${crypto.randomUUID()}.xlsx`;
        return {
          originalName,
          secureName,
          extension: '.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: file.size,
          checksum,
          resourceType: 'raw' as StorageResourceType
        };
      }
    }
    throw new ApiError(400, 'File signature does not match allowed file type', 'FILE_MAGIC_MISMATCH');
  }

  const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const safeExtension = extensionForMime(magicMime);
  const secureName = `${crypto.randomUUID()}${safeExtension}`;
  const resourceType: StorageResourceType = magicMime.startsWith('image/') ? 'image' : 'raw';

  return {
    originalName,
    secureName,
    extension: safeExtension,
    mimeType: magicMime,
    size: file.size,
    checksum,
    resourceType
  };
};

export const scanFileForMalware = async (file: Express.Multer.File) => {
  if (!file?.buffer) return { clean: true };
  return scanBufferForMalware(file.buffer);
};

const providerFor = (_name?: string): StorageProvider => gcpStorageProvider;

const isPublicCatalogueAsset = async (fileAssetId: number) => {
  const [productImage, certification] = await Promise.all([
    prisma.productImage.findFirst({
      where: { fileAssetId },
      select: { id: true }
    }).catch(() => null),
    prisma.certification.findFirst({
      where: { fileAssetId },
      select: { id: true }
    }).catch(() => null)
  ]);
  return Boolean(productImage || certification);
};

const canSellerViewBid = (sellerId: number, bid: any) => {
  if (!bid) return false;
  const isPrivate = bid.visibility === 'INVITE_ONLY' || bid.visibility === 'PRIVATE';
  if (!isPrivate) return true;
  const hasParticipation = (bid.participations || []).some((p: any) => p.sellerId === sellerId);
  if (hasParticipation) return true;
  const isInvited = (bid.invitations || []).some((i: any) => i.sellerId === sellerId);
  if (isInvited) return true;
  return false;
};

export const canAccessFileAsset = async (asset: any, user: { id: number; role: string }) => {
  if (
    ['catalogue', 'catalogue_product', 'catalogue_service', 'banner', 'organization_banner', 'logo', 'organization_logo', 'company_logo', 'public', 'stamp', 'signature', 'invoice-branding'].includes(asset.entityType) ||
    (typeof asset.mimeType === 'string' && asset.mimeType.startsWith('image/') && ['general', 'onboarding', 'registration', 'procurement_draft', 'seller_profile', 'buyer_profile'].includes(asset.entityType)) ||
    await isPublicCatalogueAsset(asset.id)
  ) return true;
  if (!user || !user.id) return false;
  if (user.role === 'admin' || user.role === 'master_admin') return true;
  if (asset.ownerId === user.id) return true;

  // Purchase Order PDF access check (buyer, seller, or admin linked to the PO)
  const poDoc = await prisma.purchaseOrder.findFirst({
    where: {
      OR: [
        { externalPdfFileId: asset.id },
        { pdfFileId: asset.id }
      ]
    },
    select: {
      buyerId: true,
      sellerId: true,
      buyer: { select: { organizationId: true } },
      seller: { select: { organizationId: true } }
    }
  }).catch(() => null);

  if (poDoc) {
    if (poDoc.buyerId === user.id || poDoc.sellerId === user.id) return true;
    const userOrgId = (user as any).organizationId;
    if (userOrgId && (poDoc.buyer?.organizationId === userOrgId || poDoc.seller?.organizationId === userOrgId)) return true;
  }

  // Check if file asset is linked via ProcurementBidDocument (regardless of asset.entityId being null or set)
  const procurementDoc = await prisma.procurementBidDocument.findFirst({
    where: { fileAssetId: asset.id },
    include: {
      bid: {
        include: {
          invitations: true,
          participations: true
        }
      }
    }
  });

  if (procurementDoc) {
    if (user.role === 'buyer' && procurementDoc.bid.buyerId === user.id) return true;
    if (user.role === 'seller') {
      const isInternalApprovalDoc = ['BUDGET_SANCTION', 'ADMINISTRATIVE_APPROVAL', 'PAC_CERTIFICATE', 'COMPETENT_AUTHORITY_APPROVAL', 'PRICE_REASONABILITY'].includes(procurementDoc.documentType) && procurementDoc.visibility === 'BUYER_ADMIN_ONLY';
      if (!isInternalApprovalDoc && (procurementDoc.visibility === 'PUBLIC' || procurementDoc.visibility === 'SELLER_AFTER_LOGIN' || canSellerViewBid(user.id, procurementDoc.bid))) {
        return true;
      }
    }
    return false;
  }

  // Direct entityType === 'procurement_bid' or 'procurement_draft' check
  if (['procurement_bid', 'procurement_draft'].includes(asset.entityType) && asset.entityId) {
    const bid = await prisma.procurementBid.findUnique({
      where: { id: asset.entityId },
      include: { invitations: true, participations: true }
    });
    if (bid) {
      if (user.role === 'buyer' && bid.buyerId === user.id) return true;
      if (user.role === 'seller' && canSellerViewBid(user.id, bid)) return true;
    }
  }

  // Direct entityType === 'requirement' check
  if (asset.entityType === 'requirement' && asset.entityId) {
    const buyerReq = await prisma.buyerRequirement.findUnique({ where: { id: asset.entityId } }).catch(() => null);
    const legacyReq = buyerReq ? null : await prisma.requirement.findUnique({ where: { id: asset.entityId } }).catch(() => null);
    const req = buyerReq || legacyReq;
    if (req) {
      if (user.role === 'buyer' && (req.createdById === user.id || (req as any).buyerId === user.id)) return true;
      if (user.role === 'seller') return true;
    }
  }

  // Check if file is linked to any Requirement (SOW, BOQ, line items, requirement documents)
  const reqWithFile = await prisma.requirement.findFirst({
    where: {
      OR: [
        { payload: { path: ['serviceDetails', 'sowFileAssetId'], equals: asset.id } },
        { payload: { path: ['sowFileAssetId'], equals: asset.id } },
        { payload: { path: ['boqFileAssetId'], equals: asset.id } },
        { payload: { path: ['items'], array_contains: [{ fileAssetId: asset.id }] } },
        { payload: { path: ['documents'], array_contains: [{ fileAssetId: asset.id }] } }
      ]
    },
    select: { id: true, buyerId: true, organizationId: true, procurementMethod: true }
  }).catch(() => null);

  if (reqWithFile) {
    if (user.role === 'admin' || user.role === 'master_admin') return true;
    if (user.role === 'buyer') {
      const userOrgId = (user as any).organizationId ? Number((user as any).organizationId) : null;
      if (reqWithFile.buyerId === user.id) return true;
      if (userOrgId && reqWithFile.organizationId === userOrgId) return true;
      return true; // Any authenticated buyer can view procurement requirements
    }
    if (user.role === 'seller') {
      return true; // Any authenticated seller can view procurement SOW, specs, and BOQ documents
    }
    return true;
  }

  // Delivery Document check (regardless of entityId or entityType)
  const deliveryDoc = await prisma.deliveryDocument.findFirst({
    where: { fileAssetId: asset.id },
    include: {
      deliveryTracking: {
        include: {
          purchaseOrder: true,
          participants: true
        }
      }
    }
  }).catch(() => null);

  if (deliveryDoc) {
    if (user.role === 'admin' || user.role === 'master_admin') return true;
    if (deliveryDoc.uploadedById === user.id) return true;
    const po = deliveryDoc.deliveryTracking?.purchaseOrder;
    if (po && (po.buyerId === user.id || po.sellerId === user.id)) return true;
    const participants = deliveryDoc.deliveryTracking?.participants || [];
    if (participants.some((p: any) => p.userId === user.id && p.isActive !== false)) return true;
  }

  // Delivery Status Log check (e.g. POD photos attached on checkpoint)
  const deliveryLog = await prisma.deliveryStatusLog.findFirst({
    where: { fileAssetId: asset.id },
    include: {
      deliveryTracking: {
        include: {
          purchaseOrder: true,
          participants: true
        }
      }
    }
  }).catch(() => null);

  if (deliveryLog) {
    if (user.role === 'admin' || user.role === 'master_admin') return true;
    if (deliveryLog.changedById === user.id) return true;
    const po = deliveryLog.deliveryTracking?.purchaseOrder;
    if (po && (po.buyerId === user.id || po.sellerId === user.id)) return true;
    const participants = deliveryLog.deliveryTracking?.participants || [];
    if (participants.some((p: any) => p.userId === user.id && p.isActive !== false)) return true;
  }

  // Invoice file check
  const invoiceDoc = await prisma.invoice.findFirst({
    where: { OR: [{ invoiceFileId: asset.id }, { fileAssetId: asset.id }] },
    include: { purchaseOrder: true }
  }).catch(() => null);

  if (invoiceDoc) {
    if (user.role === 'admin' || user.role === 'master_admin') return true;
    if (invoiceDoc.sellerId === user.id || invoiceDoc.buyerId === user.id) return true;
    const po = invoiceDoc.purchaseOrder;
    if (po && (po.buyerId === user.id || po.sellerId === user.id)) return true;
  }

  // GRN Document check
  const grnDoc = await prisma.grnDocument.findFirst({
    where: { fileAssetId: asset.id },
    include: { grn: { include: { purchaseOrder: true } } }
  }).catch(() => null);

  if (grnDoc) {
    if (user.role === 'admin' || user.role === 'master_admin') return true;
    if (grnDoc.uploadedById === user.id) return true;
    const po = (grnDoc as any).grn?.purchaseOrder;
    if (po && (po.buyerId === user.id || po.sellerId === user.id)) return true;
  }

  // Offline Payment Proof check (either direct receiptFileId or via URL / key / entityId)
  let offlineProof: any = null;
  if (asset.entityType === 'offline_payment_proof' && asset.entityId) {
    offlineProof = await (prisma as any).offlinePaymentProof.findUnique({
      where: { id: asset.entityId }
    }).catch(() => null);
  }
  if (!offlineProof) {
    offlineProof = await (prisma as any).offlinePaymentProof.findFirst({
      where: {
        OR: [
          { receiptFileId: asset.id },
          { receiptFileUrl: { contains: `/files/${asset.id}` } },
          ...(asset.key ? [{ receiptFileUrl: { contains: asset.key } }] : [])
        ]
      }
    }).catch(() => null);
  }

  if (offlineProof) {
    if (user.role === 'admin' || user.role === 'master_admin') return true;
    if (offlineProof.uploadedByUserId === user.id) return true;
    if (offlineProof.verifiedByUserId === user.id || offlineProof.rejectedByUserId === user.id) return true;

    const userOrgId = (user as any).organizationId ? Number((user as any).organizationId) : null;
    if (user.role === 'buyer' && offlineProof.buyerOrgId && userOrgId === offlineProof.buyerOrgId) return true;
    if (user.role === 'seller' && offlineProof.sellerOrgId && userOrgId === offlineProof.sellerOrgId) return true;

    if (offlineProof.purchaseOrderId) {
      const po = await prisma.purchaseOrder.findUnique({
        where: { id: offlineProof.purchaseOrderId },
        select: { buyerId: true, sellerId: true }
      }).catch(() => null);
      if (po && (po.buyerId === user.id || po.sellerId === user.id)) return true;
    }

    if (offlineProof.paymentTransactionId) {
      const payTx = await prisma.paymentTransaction.findUnique({
        where: { id: offlineProof.paymentTransactionId },
        include: {
          purchaseOrder: { select: { buyerId: true, sellerId: true } },
          invoice: { select: { buyerId: true, sellerId: true } }
        }
      }).catch(() => null);

      if (payTx) {
        if (payTx.payerId === user.id || payTx.payeeId === user.id) return true;
        if (payTx.purchaseOrder && (payTx.purchaseOrder.buyerId === user.id || payTx.purchaseOrder.sellerId === user.id)) return true;
        if (payTx.invoice && (payTx.invoice.buyerId === user.id || payTx.invoice.sellerId === user.id)) return true;
      }
    }
  }

  // Direct PaymentTransaction check (e.g. metadata or entityId)
  if (asset.entityType === 'payment' && asset.entityId) {
    const directTx = await prisma.paymentTransaction.findUnique({
      where: { id: asset.entityId },
      include: {
        purchaseOrder: { select: { buyerId: true, sellerId: true } },
        invoice: { select: { buyerId: true, sellerId: true } }
      }
    }).catch(() => null);
    if (directTx) {
      if (directTx.payerId === user.id || directTx.payeeId === user.id) return true;
      if (directTx.purchaseOrder && (directTx.purchaseOrder.buyerId === user.id || directTx.purchaseOrder.sellerId === user.id)) return true;
      if (directTx.invoice && (directTx.invoice.buyerId === user.id || directTx.invoice.sellerId === user.id)) return true;
    }
  }

  // Purchase Order counterparty branding check (logos, stamps, signatures)
  if (user?.id) {
    const poWithBranding = await prisma.purchaseOrder.findFirst({
      where: {
        OR: [{ buyerId: user.id }, { sellerId: user.id }]
      },
      include: {
        buyer: { select: { id: true, registrationDetails: true, organization: { select: { organizationLogoFileId: true } } } },
        seller: { select: { id: true, registrationDetails: true, organization: { select: { organizationLogoFileId: true } } } }
      }
    }).catch(() => null);

    if (poWithBranding) {
      const bReg = (poWithBranding.buyer?.registrationDetails as Record<string, any>) || {};
      const sReg = (poWithBranding.seller?.registrationDetails as Record<string, any>) || {};
      const bLogoId = poWithBranding.buyer?.organization?.organizationLogoFileId;
      const sLogoId = poWithBranding.seller?.organization?.organizationLogoFileId;

      const keysAndUrls = [
        bReg.logoUrl, bReg.stampUrl, bReg.signatureUrl,
        sReg.logoUrl, sReg.stampUrl, sReg.signatureUrl
      ].filter(Boolean);

      if (bLogoId === asset.id || sLogoId === asset.id) return true;
      if (keysAndUrls.some(u => typeof u === 'string' && (u.includes(`/files/${asset.id}/`) || (asset.key && u.includes(asset.key))))) {
        return true;
      }
    }
  }

  // Quotation and Proposal documents uploaded by suppliers for buyer requirements / procurement bids
  if (['quotation', 'quote', 'requirement_response', 'technical_proposal', 'commercial_bid', 'procurement_participation_document', 'procurement_bid_participation'].includes(asset.entityType) || !asset.entityId) {
    if (user.role === 'buyer') {
      const fileIdStr = String(asset.id);
      const userOrgId = (user as any).organizationId ? Number((user as any).organizationId) : null;

      // 1. Direct attachmentUrl match on RequirementResponses for this buyer
      const matchedReqResponse = await prisma.requirementResponse.findFirst({
        where: {
          OR: [
            { attachmentUrl: { contains: `/files/${fileIdStr}` } },
            ...(asset.key ? [{ attachmentUrl: { contains: asset.key } }] : [])
          ],
          requirement: {
            OR: [
              { createdById: user.id },
              ...(userOrgId ? [{ buyerOrganizationId: userOrgId }] : [])
            ]
          }
        },
        select: { id: true }
      }).catch(() => null);

      if (matchedReqResponse) return true;

      // 2. Check if file is referenced in responseData of any requirement response for this buyer
      const recentBuyerResponses = await prisma.requirementResponse.findMany({
        where: {
          requirement: {
            OR: [
              { createdById: user.id },
              ...(userOrgId ? [{ buyerOrganizationId: userOrgId }] : [])
            ]
          }
        },
        select: { id: true, attachmentUrl: true, responseData: true }
      }).catch(() => []);

      for (const resp of recentBuyerResponses) {
        if (resp.attachmentUrl && (resp.attachmentUrl.includes(`/files/${fileIdStr}`) || (asset.key && resp.attachmentUrl.includes(asset.key)))) {
          return true;
        }
        if (resp.responseData) {
          const respStr = typeof resp.responseData === 'string' ? resp.responseData : JSON.stringify(resp.responseData);
          if (
            respStr.includes(`"fileAssetId":${asset.id}`) ||
            respStr.includes(`"fileAssetId": "${asset.id}"`) ||
            respStr.includes(`"id":${asset.id}`) ||
            respStr.includes(`"id": "${asset.id}"`) ||
            (asset.key && respStr.includes(asset.key)) ||
            respStr.includes(`/files/${fileIdStr}`)
          ) {
            return true;
          }
        }
      }

      // 3. Check procurement bid participations for this buyer
      const bidParticipationDoc = await prisma.procurementBidParticipationDocument.findFirst({
        where: {
          OR: [
            { fileAssetId: asset.id },
            ...(asset.key ? [{ fileKey: asset.key }] : []),
            { fileUrl: { contains: `/files/${fileIdStr}` } }
          ],
          participation: {
            bid: {
              OR: [
                { buyerId: user.id },
                ...(userOrgId ? [{ buyerOrganizationId: userOrgId }] : [])
              ]
            }
          }
        },
        select: { id: true }
      }).catch(() => null);

      if (bidParticipationDoc) return true;

      // 4. Check QuoteResponses for this buyer's QuoteRequests
      const quoteResp = await prisma.quoteResponse.findFirst({
        where: {
          OR: [
            { documentUrl: { contains: `/files/${fileIdStr}` } },
            ...(asset.key ? [{ documentUrl: { contains: asset.key } }] : [])
          ],
          quoteRequest: {
            buyerId: user.id
          }
        },
        select: { id: true }
      }).catch(() => null);

      if (quoteResp) return true;
    }
  }

  if (!asset.entityId) {
    if (['procurement_bid', 'procurement_draft'].includes(asset.entityType) && user.role === 'seller') {
      try {
        // Check QuoteRequestItems
        const reqItems = await prisma.$queryRawUnsafe<any[]>(
          `SELECT quoteRequestId FROM QuoteRequestItem WHERE CAST(attachments AS CHAR) LIKE '%"id":${asset.id}%' OR CAST(attachments AS CHAR) LIKE '%"fileAssetId":${asset.id}%' LIMIT 1`
        );
        if (reqItems && reqItems.length > 0) {
          const req = await prisma.quoteRequest.findUnique({ where: { id: reqItems[0].quoteRequestId } });
          if (req) {
            const bid = await (prisma.procurementBid as any).findFirst({
              where: { bidNumber: (req as any).quoteRequestNumber || String(req.id) },
              include: { invitations: true, participations: true }
            });
            if (bid && canSellerViewBid(user.id, bid)) return true;
          }
        }
        // Check ProcurementBidItems
        const bidItems = await prisma.$queryRawUnsafe<any[]>(
          `SELECT bidId FROM ProcurementBidItem WHERE CAST(attachments AS CHAR) LIKE '%"id":${asset.id}%' OR CAST(attachments AS CHAR) LIKE '%"fileAssetId":${asset.id}%' LIMIT 1`
        );
        if (bidItems && bidItems.length > 0) {
          const bid = await prisma.procurementBid.findUnique({
            where: { id: bidItems[0].bidId },
            include: { invitations: true, participations: true }
          });
          if (bid && canSellerViewBid(user.id, bid)) return true;
        }
      } catch (e) {
        // Suppress raw query errors in fallback
      }
    }
    return false;
  }

  if (asset.entityType === 'tender') return checkOwnership('tender', asset.entityId, user);
  if (asset.entityType === 'bid') return checkOwnership('bid', asset.entityId, user);
  if (asset.entityType === 'quote') return checkOwnership('quote', asset.entityId, user);
  if (asset.entityType === 'procurement_checkout') return asset.ownerId === user.id;
  if (['procurement_bid_participation', 'procurement_participation_document', 'procurement_financial_quote'].includes(asset.entityType)) {
    const doc = await prisma.procurementBidParticipationDocument.findFirst({
      where: { fileAssetId: asset.id },
      include: { participation: { include: { bid: true } } }
    });
    if (!doc) return false;
    const bid = doc.participation.bid;
    if (user.role === 'seller') return doc.sellerId === user.id;
    if (user.role === 'buyer') {
      if (bid.buyerId !== user.id) return false;
      if (doc.documentCategory !== 'FINANCIAL_QUOTE') {
        return true;
      }
      return doc.participation.technicalStatus === 'QUALIFIED' && ['FINANCIAL_EVALUATION', 'L1_GENERATED', 'AWARD_RECOMMENDED', 'AWARDED'].includes(bid.status);
    }
    return false;
  }
  if (['procurement_bid_clarification', 'procurement_clarification_file'].includes(asset.entityType)) {
    const file = await prisma.procurementBidClarificationFile.findFirst({
      where: { fileAssetId: asset.id },
      include: { clarification: { include: { bid: true } } }
    });
    if (!file) return false;
    if (user.role === 'seller') return file.clarification.sellerId === user.id;
    if (user.role === 'buyer') return file.clarification.bid.buyerId === user.id;
    return false;
  }
  if (['procurement_award_document', 'procurement_evaluation_report'].includes(asset.entityType)) {
    return false;
  }
  if (['procurement_delivery_document', 'procurement_invoice'].includes(asset.entityType)) {
    const deliveryDoc = await prisma.deliveryDocument.findFirst({
      where: { fileAssetId: asset.id },
      include: { deliveryTracking: { include: { purchaseOrder: true } } }
    }).catch(() => null);
    const invoice = deliveryDoc ? null : await prisma.invoice.findFirst({
      where: { OR: [{ invoiceFileId: asset.id }, { fileAssetId: asset.id }] },
      include: { purchaseOrder: true }
    }).catch(() => null);
    const po = deliveryDoc?.deliveryTracking?.purchaseOrder || invoice?.purchaseOrder;
    if (!po) return asset.ownerId === user.id;
    if (user.role === 'seller') return po.sellerId === user.id;
    if (user.role === 'buyer') return po.buyerId === user.id;
    return false;
  }

  const messageAttachment = await prisma.messageAttachment.findFirst({
    where: { fileAssetId: asset.id },
    include: { message: { include: { conversation: { select: { buyerId: true, sellerId: true } } } } }
  });
  if (messageAttachment?.message?.conversation) {
    const conv = messageAttachment.message.conversation;
    if (user.role === 'admin' || user.role === 'master_admin') return true;
    return conv.buyerId === user.id || conv.sellerId === user.id;
  }

  if (asset.entityType === 'message' && asset.entityId) {
    const message = await prisma.message.findUnique({
      where: { id: asset.entityId },
      include: { conversation: { select: { buyerId: true, sellerId: true } } }
    });
    if (message?.conversation) {
      if (user.role === 'admin' || user.role === 'master_admin') return true;
      return message.conversation.buyerId === user.id || message.conversation.sellerId === user.id;
    }
  }

  return false;
};

export const uploadFile = async (
  file: Express.Multer.File,
  context: FileUploadContext,
  providerName: StorageProviderName = 'gcp'
) => {
  const validation = validateFile(file);
  const scan = await scanFileForMalware(file);
  if (!scan.clean) throw new ApiError(400, 'File failed malware scan', 'FILE_MALWARE_DETECTED');

  const folderName = mapEntityTypeToFolder(context.entityType);
  const folder = `${folderName}/${context.ownerId}`;
  const key = validation.secureName;
  const provider = providerFor(providerName);
  const result = await provider.uploadFile({
    buffer: file.buffer,
    key,
    folder,
    mimeType: validation.mimeType,
    resourceType: validation.resourceType,
    context
  });

  const asset = await prisma.fileAsset.create({
    data: {
      ownerId: context.ownerId,
      ownerRole: context.ownerRole,
      entityType: context.entityType,
      entityId: context.entityId || null,
      storageProvider: result.provider,
      bucket: result.bucket,
      key: result.key,
      url: result.url,
      mimeType: validation.mimeType,
      size: validation.size,
      checksum: validation.checksum,
      originalName: validation.originalName,
      status: 'active'
    }
  });

  void auditLog({
    actorUserId: context.ownerId,
    actorRole: context.ownerRole,
    action: 'file.uploaded',
    entityType: 'file',
    entityId: asset.id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      fileId: asset.id,
      relatedEntityType: context.entityType,
      relatedEntityId: context.entityId,
      mimeType: asset.mimeType,
      size: asset.size,
      checksum: asset.checksum
    }
  }).catch(err => console.warn('[Audit] file.uploaded failed:', err?.message || err));

  return asset;
};

export const getSignedUrl = async (fileId: number, user: { id: number; role: string }, request?: { ipAddress?: string; userAgent?: string }) => {
  let asset = await prisma.fileAsset.findUnique({ where: { id: fileId } });
  if (!asset) {
    const procDoc = await prisma.procurementBidDocument.findUnique({ where: { id: fileId } }).catch(() => null);
    if (procDoc?.fileAssetId) {
      asset = await prisma.fileAsset.findUnique({ where: { id: procDoc.fileAssetId } }).catch(() => null);
    } else if (procDoc?.fileUrl) {
      const url = procDoc.fileUrl.startsWith('http') || procDoc.fileUrl.startsWith('/') ? procDoc.fileUrl : `/${procDoc.fileUrl}`;
      return {
        asset: { id: procDoc.id, mimeType: procDoc.mimeType || 'application/pdf', key: procDoc.fileKey || url, entityType: 'procurement_bid_document' },
        signedUrl: url,
        expiresInSeconds: 5 * 60
      };
    }
  }
  if (!asset) {
    const partDoc = await prisma.procurementBidParticipationDocument.findUnique({ where: { id: fileId } }).catch(() => null);
    if (partDoc?.fileAssetId) {
      asset = await prisma.fileAsset.findUnique({ where: { id: partDoc.fileAssetId } }).catch(() => null);
    } else if (partDoc?.fileUrl) {
      const url = partDoc.fileUrl.startsWith('http') || partDoc.fileUrl.startsWith('/') ? partDoc.fileUrl : `/${partDoc.fileUrl}`;
      return {
        asset: { id: partDoc.id, mimeType: partDoc.mimeType || 'application/pdf', key: partDoc.fileKey || url, entityType: 'procurement_participation_document' },
        signedUrl: url,
        expiresInSeconds: 5 * 60
      };
    }
  }
  if (!asset) {
    const sellerDoc = await prisma.sellerDocument.findUnique({ where: { id: fileId } }).catch(() => null);
    if (sellerDoc?.fileAssetId) {
      asset = await prisma.fileAsset.findUnique({ where: { id: sellerDoc.fileAssetId } }).catch(() => null);
    }
  }
  if (!asset) {
    const shgDoc = await (prisma as any).shgDocument.findUnique({ where: { id: fileId } }).catch(() => null);
    if (shgDoc?.fileAssetId) {
      asset = await prisma.fileAsset.findUnique({ where: { id: shgDoc.fileAssetId } }).catch(() => null);
    }
  }
  if (!asset) {
    const delDoc = await prisma.deliveryDocument.findUnique({ where: { id: fileId } }).catch(() => null);
    if (delDoc?.fileAssetId) {
      asset = await prisma.fileAsset.findUnique({ where: { id: delDoc.fileAssetId } }).catch(() => null);
    }
  }
  if (!asset) {
    const grnDocItem = await prisma.grnDocument.findUnique({ where: { id: fileId } }).catch(() => null);
    if (grnDocItem?.fileAssetId) {
      asset = await prisma.fileAsset.findUnique({ where: { id: grnDocItem.fileAssetId } }).catch(() => null);
    }
  }
  if (!asset) {
    const inv = await prisma.invoice.findUnique({ where: { id: fileId } }).catch(() => null);
    const invFid = inv?.invoiceFileId || inv?.fileAssetId;
    if (invFid) {
      asset = await prisma.fileAsset.findUnique({ where: { id: invFid } }).catch(() => null);
    }
  }
  if (!asset || asset.status !== 'active') throw new ApiError(404, 'File not found', 'FILE_NOT_FOUND');

  if (!(await canAccessFileAsset(asset, user))) {
    await auditLog({
      actorUserId: user.id,
      actorRole: user.role,
      action: asset.entityType?.startsWith('procurement') ? 'procurement.file_access_denied' : 'file.access_denied',
      entityType: 'file',
      entityId: asset.id,
      ipAddress: request?.ipAddress,
      userAgent: request?.userAgent
    });
    throw new ApiError(404, 'File not found', 'FILE_NOT_FOUND');
  }

  let signedUrl = asset.url || `/uploads/${asset.key}` || `/api/files/${asset.id}/view`;
  const isPrivate = isPrivateDocument({ folder: asset.key, metadata: { entityType: asset.entityType } }, asset.key);
  if (isPrivate) {
    signedUrl = `/api/files/${asset.id}/view`;
  } else if (asset.storageProvider !== 'local') {
    try {
      const provider = providerFor(asset.storageProvider as StorageProviderName);
      signedUrl = await provider.getSignedUrl(asset.key, {
        resourceType: asset.mimeType.startsWith('image/') ? 'image' : 'raw',
        expiresInSeconds: 5 * 60,
        mimeType: asset.mimeType
      });
    } catch (_err) {
      signedUrl = asset.url || `/uploads/${asset.key}` || `/api/files/${asset.id}/view`;
    }
  }

  await auditLog({
    actorUserId: user.id,
    actorRole: user.role,
    action: asset.entityType?.startsWith('procurement') ? 'procurement.file_viewed' : 'file.viewed',
    entityType: 'file',
    entityId: asset.id,
    ipAddress: request?.ipAddress,
    userAgent: request?.userAgent
  });

  return { asset, signedUrl, expiresInSeconds: 5 * 60 };
};

interface CachedFileContent {
  asset: any;
  buffer: Buffer;
  contentType: string;
  signedUrl: string;
  expiresInSeconds: number;
  timestamp: number;
}
const fileContentMemoryCache = new Map<number, CachedFileContent>();
const FILE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache
const MAX_CACHE_ENTRIES = 200;

export const getFileContent = async (fileId: number, user: { id: number; role: string }, request?: { ipAddress?: string; userAgent?: string }) => {
  const cached = fileContentMemoryCache.get(fileId);
  if (cached && Date.now() - cached.timestamp < FILE_CACHE_TTL_MS) {
    return {
      asset: cached.asset,
      signedUrl: cached.signedUrl,
      expiresInSeconds: cached.expiresInSeconds,
      buffer: cached.buffer,
      contentType: cached.contentType
    };
  }

  const signed = await getSignedUrl(fileId, user, request);
  const assetObj = signed.asset as any;

  const cacheAndReturn = (buffer: Buffer, contentType: string) => {
    const result = {
      ...signed,
      buffer,
      contentType
    };
    if (fileContentMemoryCache.size >= MAX_CACHE_ENTRIES) {
      const firstKey = fileContentMemoryCache.keys().next().value;
      if (firstKey !== undefined) fileContentMemoryCache.delete(firstKey);
    }
    fileContentMemoryCache.set(fileId, {
      asset: result.asset,
      buffer: result.buffer,
      contentType: result.contentType,
      signedUrl: result.signedUrl,
      expiresInSeconds: result.expiresInSeconds,
      timestamp: Date.now()
    });

    // Also persist to disk cache so subsequent requests hit instant local disk fast-path
    try {
      if (assetObj?.key) {
        const localTarget = path.resolve(process.cwd(), 'uploads', assetObj.key);
        fs.mkdirSync(path.dirname(localTarget), { recursive: true });
        if (!fs.existsSync(localTarget)) {
          if (isPrivateDocument({ folder: assetObj.key, metadata: { entityType: assetObj.entityType } }, assetObj.key)) {
            void encryptBufferEnvelope(buffer).then(encBuf => {
              if (!fs.existsSync(localTarget)) fs.writeFileSync(localTarget, encBuf);
            }).catch(() => {});
          } else {
            fs.writeFileSync(localTarget, buffer);
          }
        }
      }
    } catch {
      // Non-blocking disk cache
    }

    return result;
  };

  const rawKey = assetObj?.key || '';
  const cleanKey = rawKey.replace(/^(\/)?uploads\//, '');
  const baseKey = path.basename(rawKey);
  const rawUrl = (assetObj?.url || '').replace(/^(\/)?uploads\//, '');

  const localCandidates = [
    path.resolve(process.cwd(), 'uploads', rawKey),
    path.resolve(process.cwd(), 'uploads', cleanKey),
    path.resolve(process.cwd(), 'uploads', baseKey),
    path.resolve(process.cwd(), 'backend/uploads', rawKey),
    path.resolve(process.cwd(), 'backend/uploads', cleanKey),
    path.resolve(process.cwd(), 'backend/uploads', baseKey),
    path.resolve(process.cwd(), '../uploads', rawKey),
    path.resolve(process.cwd(), '../uploads', cleanKey),
    path.resolve(process.cwd(), '../uploads', baseKey),
    path.resolve(process.cwd(), rawKey),
    path.resolve(process.cwd(), cleanKey),
    ...(rawUrl ? [
      path.resolve(process.cwd(), 'uploads', rawUrl),
      path.resolve(process.cwd(), 'backend/uploads', rawUrl),
      path.resolve(process.cwd(), '../uploads', rawUrl)
    ] : [])
  ];

  for (const cand of localCandidates) {
    if (cand && fs.existsSync(cand) && !fs.statSync(cand).isDirectory()) {
      const rawBuffer = fs.readFileSync(cand);
      const buffer = await decryptBufferEnvelope(rawBuffer);
      return cacheAndReturn(buffer, assetObj?.mimeType || 'application/octet-stream');
    }
  }

  if (signed.signedUrl.startsWith('http://') || signed.signedUrl.startsWith('https://')) {
    try {
      const response = await fetch(signed.signedUrl, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const rawBuffer = Buffer.from(await response.arrayBuffer());
        const buffer = await decryptBufferEnvelope(rawBuffer);
        return cacheAndReturn(buffer, signed.asset.mimeType || response.headers.get('content-type') || 'application/octet-stream');
      }
      // If GCS signed URL returned 404, the object definitely does not exist in storage
      if (response.status === 404) {
        throw new ApiError(404, 'Stored file content not found on server disk or storage', 'FILE_NOT_FOUND_ON_DISK');
      }
    } catch (fetchErr: any) {
      if (fetchErr instanceof ApiError) throw fetchErr;
    }
  }

  // Fallback: If asset is on GCP, verify existence first to fail-fast instead of timing out
  if (assetObj?.storageProvider === 'gcp' || assetObj?.storageProviderEnum === 'GCP' || assetObj?.bucket) {
    try {
      const exists = await gcpStorageProvider.fileExists(assetObj.key);
      if (!exists) {
        throw new ApiError(404, 'Stored file content not found on server disk or storage', 'FILE_NOT_FOUND_ON_DISK');
      }

      const readGcpStream = async () => {
        const gcpStream = gcpStorageProvider.createReadStream(assetObj.key);
        const chunks: Buffer[] = [];
        for await (const chunk of gcpStream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
      };

      const buffer = await Promise.race([
        readGcpStream(),
        new Promise<Buffer>((_, reject) => setTimeout(() => reject(new Error('GCS read timeout')), 15000))
      ]);

      if (buffer && buffer.length > 0) {
        return cacheAndReturn(await decryptBufferEnvelope(buffer), assetObj.mimeType || 'application/octet-stream');
      }
    } catch (gcpErr: any) {
      if (gcpErr instanceof ApiError) throw gcpErr;
    }
  }

  throw new ApiError(404, 'Stored file content not found on server disk or storage', 'FILE_NOT_FOUND_ON_DISK');
};

export const deleteFile = async (fileId: number, user: { id: number; role: string }, request?: { ipAddress?: string; userAgent?: string }) => {
  const asset = await prisma.fileAsset.findUnique({ where: { id: fileId } });
  if (!asset || asset.status !== 'active') throw new ApiError(404, 'File not found', 'FILE_NOT_FOUND');

  if (!(await canAccessFileAsset(asset, user)) || (user.role !== 'admin' && asset.ownerId !== user.id)) {
    await auditLog({
      actorUserId: user.id,
      actorRole: user.role,
      action: 'file.delete_denied',
      entityType: 'file',
      entityId: asset.id,
      ipAddress: request?.ipAddress,
      userAgent: request?.userAgent
    });
    throw new ApiError(404, 'File not found', 'FILE_NOT_FOUND');
  }

  const provider = providerFor(asset.storageProvider as StorageProviderName);
  await provider.deleteFile(asset.key, asset.mimeType.startsWith('image/') ? 'image' : 'raw');
  const updated = await prisma.fileAsset.update({
    where: { id: fileId },
    data: { status: 'deleted' }
  });

  await auditLog({
    actorUserId: user.id,
    actorRole: user.role,
    action: 'file.deleted',
    entityType: 'file',
    entityId: asset.id,
    ipAddress: request?.ipAddress,
    userAgent: request?.userAgent
  });

  return updated;
};
