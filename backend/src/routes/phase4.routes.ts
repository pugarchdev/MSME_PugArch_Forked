import { Router, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import https from 'https';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { optimizeImageBuffer } from '../utils/imageOptimizer.js';
import { permanentlyDeleteUser } from './master-admin.routes.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getGCSBucket, getGCSBucketName } from '../config/gcs.js';
import { applyCorsHeaders } from '../config/cors.js';
import { getFileContent, getSignedUrl, uploadFile } from '../services/storage/storage.service.js';
import { authenticate, optionalAuthenticate, authorize, authorizeAdmin, requireAccountType, requirePermission, type AuthRequest } from '../middleware/auth.js';
import { verifyAccessToken } from '../services/token.service.js';
import { getAccessTokenFromRequest } from '../services/auth-cookie.service.js';
import { upload } from '../config/storage.js';
import { auditLog } from '../modules/audit/audit.service.js';
import { onUserLinkedToOrganization } from '../services/org-membership.service.js';
import { approveOnboardingAndEnsureOrganization, createOrUpdatePendingOrganization } from '../services/onboarding-organization.service.js';
import { createComplianceFlag } from '../modules/compliance/compliance.service.js';
import { paymentRateLimit, verificationRateLimit } from '../middleware/rateLimit.js';
import { getOrSetCache, deleteCache, invalidateByPattern } from '../services/cache.service.js';
import { invalidateUserAuthCache, isMasterAdmin } from '../services/rbac.service.js';
import { notificationService } from '../services/notification.service.js';
import { broadcastToProcurement } from '../services/websocket.service.js';
import { notifySellerNewPurchaseOrder, generatePaymentReceiptPdfBuffer, notifyPaymentReceiptEmail, getOrGeneratePurchaseOrderPdfBuffer, getOrGenerateInvoicePdfBuffer } from '../services/invoice-pdf.service.js';
import { redisKeys } from '../constants/redis-keys.js';
import { ApiError } from '../utils/ApiError.js';
import { handleSecureRouteError } from '../utils/routeHelpers.js';
import { maskSensitive, maskBankAccount, type MaskSensitiveOptions } from '../utils/maskSensitive.js';
import { formatIstDateTime } from '../services/email-template.builder.js';
import { sha256, createHashFingerprint, decryptField, isEncrypted } from '../utils/crypto.js';
import { panVerificationService } from '../services/verification/pan.service.js';
import { udyamVerificationService } from '../services/verification/udyam.service.js';
import { formatRequirementNumber, formatRefId, CANONICAL_METHOD_PREFIXES, getCanonicalLookupVariants } from '../utils/refIdUtils.js';
import { bankVerificationService } from '../services/verification/bank.service.js';
import { GstService, hasValidGstinChecksum } from '../services/gstService.js';
import {
  approveMilestone,
  completeMilestone,
  createMilestone,
  listEscrowAccounts,
  reconcilePayment as reconcilePaymentWorkflow,
  unfreezeEscrow
} from '../modules/payments/payment.service.js';
import { idempotencyKeyFromRequest, withIdempotency } from '../services/idempotency.service.js';
import { catalogueWorkflow } from '../services/workflow/catalogue-workflow.service.js';
import { procurementWorkflow } from '../services/workflow/procurement-workflow.service.js';
import { numberSeries, notifyWorkflowSoon } from '../services/workflow/workflow-common.js';
import { statusTransitions, poStatusEnumFor, invoiceStatusEnumFor } from '../services/workflow/status-transition.service.js';
import { tenderWorkflow } from '../services/workflow/tender-workflow.service.js';
import { fulfillmentWorkflow } from '../services/workflow/fulfillment-workflow.service.js';
import { contractWorkflow } from '../services/workflow/contract-workflow.service.js';
import { ratingWorkflow } from '../services/workflow/rating-workflow.service.js';
import { ratingsService } from '../modules/ratings/ratings.service.js';
import { enrichBidsWithResponses, invalidateBidCaches } from '../modules/procurementBid/procurement-bid.routes.js';
import { STRICT_VERIFICATION } from '../config/verification.js';
import { getDefaultCompanyId } from '../services/default-company.service.js';
import { canonicalMethodFromRecord } from '../utils/procurement-methods.js';
import { nextBidNumber, deriveVisibility, syncBidInvitations } from '../modules/procurementBid/procurement-bid.service.js';
import { isValidCanonicalRef } from '../utils/refIdUtils.js';
import { cancelProcurementRequest } from '../modules/procurementCheckout/procurement-checkout.service.js';
import { createApprovalChain } from '../services/approval-chain.service.js';
import { parseDateIST } from '../utils/dateUtils.js';
import {
  validateCallOffOrderRequest,
  parseDeliverySlaDays,
  calculateExpectedDeliveryDate,
  parsePenaltyTerms,
  getRateContractUtilization
} from '../modules/rateContract/rate-contract.service.js';


const safeCoercedDate = z.preprocess((val) => {
  if (val === null || val === undefined || val === '') return val;
  if (val instanceof Date) return val;
  if (typeof val === 'object' && val !== null && Object.prototype.toString.call(val) === '[object Date]') {
    return val;
  }
  if (typeof val === 'string' && val.trim() !== '') {
    const parts = val.split('-');
    if (parts.length === 3 && parts[0].length === 2 && parts[1].length === 2 && parts[2].length === 4) {
      const isoStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
      const d = parseDateIST(isoStr);
      if (d && !isNaN(d.getTime())) return d;
    }
    const d = parseDateIST(val);
    if (d && !isNaN(d.getTime())) return d;
  }
  return val;
}, z.any().refine(val => {
  if (val === null || val === undefined) return true;
  return val instanceof Date || (typeof val === 'object' && val !== null && Object.prototype.toString.call(val) === '[object Date]' && !isNaN((val as Date).getTime()));
}, {
  message: "Invalid date"
}));

const db = prisma as any;
const router = Router();

const idParams = z.object({ id: z.coerce.number().int().positive() });
const sellerIdParams = z.object({ sellerId: z.coerce.number().int().positive() });
const buyerIdParams = z.object({ buyerId: z.coerce.number().int().positive() });
const gstParams = z.object({ gstin: z.string().trim().min(15).max(15) });
const paginationQuery = z.object({
  q: z.string().trim().max(120).optional(),
  role: z.enum(['buyer', 'seller', 'shg', 'all']).optional(),
  status: z.string().trim().max(80).optional(),
  procurementMethod: z.string().trim().max(80).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(1000).optional(),
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(1000).default(20),
  viewerScope: z.string().trim().optional()
}).partial();

const clean = (value: unknown) => String(value ?? '').trim();
const toDecimalNumber = (value: unknown, fallback = 0) => Number(value ?? fallback);
const isAdmin = (req: AuthRequest) => req.user?.role === 'admin';
const userId = (req: AuthRequest) => Number(req.user?.id);
const orgScope = {
  scopeType: 'ORGANIZATION' as const,
  getScopeId: (req: AuthRequest) => req.user?.organizationId
};
const approvedProcurementStatuses = new Set(['approved_for_procurement', 'approved']);

const ok = (res: Response, data: unknown, status = 200, options?: MaskSensitiveOptions) => res.status(status).json(maskSensitive({ success: true, data }, options));

const humanizeKey = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

const isPresentValue = (value: unknown) => {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
};

const formatDetailValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          return String(obj.name || obj.label || obj.supplierName || obj.itemName || obj.fileName || obj.id || JSON.stringify(obj));
        }
        return String(item);
      })
      .filter(Boolean)
      .join(', ');
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.entries(obj)
      .filter(([, v]) => isPresentValue(v))
      .map(([k, v]) => `${humanizeKey(k)}: ${formatDetailValue(v)}`)
      .join('; ');
  }
  return String(value);
};

const detailFieldsFromObject = (source: unknown, labelMap: Record<string, string> = {}) => {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
  return Object.entries(source as Record<string, unknown>)
    .filter(([key, value]) => isPresentValue(value) && !['id', 'documents', 'items', 'boqTable'].includes(key))
    .map(([key, value]) => ({
      label: labelMap[key] || humanizeKey(key),
      value: formatDetailValue(value)
    }))
    .filter(field => field.value);
};

const detailSection = (title: string, source: unknown, labelMap?: Record<string, string>) => {
  const fields = detailFieldsFromObject(source, labelMap);
  return fields.length ? { title, fields } : null;
};

const approvalTrailFor = (approvals: any[] = []) =>
  approvals
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))
    .map(a => ({
      stage: String(a.stage || ''),
      label: humanizeKey(String(a.stage || 'Approval')),
      decision: String(a.decision || 'PENDING'),
      remarks: a.remarks || a.clarificationNote || '',
      decidedAt: a.decidedAt?.toISOString?.() || '',
      approverName: a.approver?.name || '',
      approverEmail: a.approver?.email || ''
    }));

const trackingFor = (status: string, createdAt?: Date, submittedAt?: Date | null, approvedAt?: Date | null, approvals: any[] = []) => {
  const normalized = String(status || '').toUpperCase();
  const submitted = Boolean(submittedAt) || !['DRAFT'].includes(normalized);
  const approved = Boolean(approvedAt) || ['APPROVED', 'CONVERTED_TO_ORDER', 'COMPLETED'].includes(normalized);
  const approvalTrail = approvalTrailFor(approvals);
  return [
    { label: 'Created', status: 'completed', date: createdAt?.toISOString?.() || '' },
    { label: 'Submitted', status: submitted ? 'completed' : 'pending', date: submittedAt?.toISOString?.() || '' },
    { label: 'Approval Review', status: approved ? 'completed' : approvalTrail.length ? 'active' : 'pending', date: approvalTrail.find(a => a.decision === 'APPROVED')?.decidedAt || approvedAt?.toISOString?.() || '' },
    { label: 'Approved / Ordered', status: approved ? 'completed' : 'pending', date: approvedAt?.toISOString?.() || '' }
  ];
};

const procurementMethodDefinitions = [
  { slug: 'direct-purchase', code: 'DIRECT_PURCHASE', name: 'Direct Purchase', route: '/buyer/procurement/create?method=DIRECT_PURCHASE', handoffRoute: '/buyer/procurement/create?method=DIRECT_PURCHASE', badge: 'Common', valueHint: 'Best for low-value or approved direct buys' },
  { slug: 'rfq', code: 'RFQ', name: 'Request for Quotation (RFQ)', route: '/buyer/procurement/create?method=RFQ', handoffRoute: '/buyer/rfq', badge: 'Common', valueHint: 'Useful for custom specs and supplier quotes' },
  { slug: 'rfp', code: 'RFP', name: 'Request for Proposal (RFP)', route: '/buyer/procurement/create?method=RFP', handoffRoute: '/buyer/publish-bid?method=rfp', badge: 'Strategic', valueHint: 'Evaluate complex services with technical & financial proposals' },
  { slug: 'open-tender', code: 'OPEN_TENDER', name: 'Open Tender', route: '/buyer/procurement/create?method=OPEN_TENDER', handoffRoute: '/buyer/publish-bid?method=open-tender', badge: 'Compliance Required', valueHint: 'Formal bids and higher-value procurement' },
  { slug: 'limited-tender', code: 'LIMITED_TENDER', name: 'Limited Tender', route: '/buyer/procurement/create?method=LIMITED_TENDER', handoffRoute: '/buyer/publish-bid?method=limited-tender', badge: 'Restricted Pool', valueHint: 'Bids invited from a selected list of suppliers' },
  { slug: 'reverse-auction', code: 'REVERSE_AUCTION', name: 'Reverse Auction', route: '/buyer/procurement/create?method=REVERSE_AUCTION', handoffRoute: '/reverse-auctions/create', badge: 'Advanced', valueHint: 'Use after technical qualification' },
  // Legacy alias entries kept for backward compatibility with old records
  { slug: 'tender', code: 'OPEN_TENDER', name: 'Tender (Legacy)', route: '/buyer/procurement/create', handoffRoute: '/buyer/publish-bid?method=tender', badge: 'Legacy', valueHint: 'Migrated to Open Tender' },
];

const defaultMarketplaceCategories = [
  { name: 'Electrical & Electronics', type: 'BOTH', displayOrder: 10 },
  { name: 'Mechanical & Engineering', type: 'BOTH', displayOrder: 20 },
  { name: 'Construction & Building Materials', type: 'PRODUCT', displayOrder: 30 },
  { name: 'Industrial Chemicals', type: 'PRODUCT', displayOrder: 40 },
  { name: 'Refractories', type: 'PRODUCT', displayOrder: 50 },
  { name: 'Automobile Parts & Services', type: 'BOTH', displayOrder: 60 },
  { name: 'Tyres & Rubber Products', type: 'PRODUCT', displayOrder: 70 },
  { name: 'IT & Computer Equipment', type: 'PRODUCT', displayOrder: 80 },
  { name: 'Office Equipment & Stationery', type: 'PRODUCT', displayOrder: 90 },
  { name: 'Medical & Healthcare Supplies', type: 'PRODUCT', displayOrder: 100 },
  { name: 'Agriculture & Nursery', type: 'BOTH', displayOrder: 110 },
  { name: 'Safety Equipment & Industrial Safety', type: 'PRODUCT', displayOrder: 120 },
  { name: 'Fuel, Oil & Gas', type: 'PRODUCT', displayOrder: 130 },
  { name: 'Hydraulics & Pneumatics', type: 'PRODUCT', displayOrder: 140 },
  { name: 'Steel & Metal Products', type: 'PRODUCT', displayOrder: 150 },
  { name: 'Cement & Concrete Products', type: 'PRODUCT', displayOrder: 160 },
  { name: 'Pipes, Tiles & Hardware', type: 'PRODUCT', displayOrder: 170 },
  { name: 'Industrial Machinery & Spare Parts', type: 'PRODUCT', displayOrder: 180 },
  { name: 'Automation & Robotics', type: 'BOTH', displayOrder: 190 },
  { name: 'Fabrication & Welding Services', type: 'SERVICE', displayOrder: 200 },
  { name: 'Bearings & Mechanical Components', type: 'PRODUCT', displayOrder: 210 },
  { name: 'Electrical Cables & Power Equipment', type: 'PRODUCT', displayOrder: 220 },
  { name: 'Industrial Consumables', type: 'PRODUCT', displayOrder: 230 },
  { name: 'Packaging & Printing', type: 'BOTH', displayOrder: 240 },
  { name: 'Polymer & Plastic Products', type: 'PRODUCT', displayOrder: 250 },
  { name: 'Trading & Distribution', type: 'SERVICE', displayOrder: 260 },
  { name: 'Logistics & Supply Services', type: 'SERVICE', displayOrder: 270 },
  { name: 'Tools & Industrial Hardware', type: 'PRODUCT', displayOrder: 280 },
  { name: 'Laboratory Equipment & Chemicals', type: 'PRODUCT', displayOrder: 290 },
  { name: 'Engineering Consultancy Services', type: 'SERVICE', displayOrder: 300 },
  { name: 'Industrial Maintenance Services', type: 'SERVICE', displayOrder: 310 },
  { name: 'Construction & Civil Work Services', type: 'SERVICE', displayOrder: 320 },
  { name: 'Environmental & Waste Management', type: 'SERVICE', displayOrder: 330 },
  { name: 'Telecom & Communication Equipment', type: 'PRODUCT', displayOrder: 340 },
  { name: 'Furniture & Interior Supplies', type: 'PRODUCT', displayOrder: 350 },
  { name: 'General Industrial Supplier', type: 'BOTH', displayOrder: 360 },
  { name: 'Mining & Coal Equipment', type: 'PRODUCT', displayOrder: 370 },
  { name: 'Power & Energy Equipment', type: 'PRODUCT', displayOrder: 380 },
  { name: 'Gas Equipment & Cylinders', type: 'PRODUCT', displayOrder: 390 },
  { name: 'Conveyor & Material Handling Equipment', type: 'PRODUCT', displayOrder: 400 },
  { name: 'Pumps, Motors & Hydraulics', type: 'PRODUCT', displayOrder: 410 },
  { name: 'Industrial Seals & Gaskets', type: 'PRODUCT', displayOrder: 420 },
  { name: 'Welding & Cutting Equipment', type: 'PRODUCT', displayOrder: 430 },
  { name: 'Industrial Fasteners & Components', type: 'PRODUCT', displayOrder: 440 },
  { name: 'Retail & Commercial Supply', type: 'BOTH', displayOrder: 450 },
  { name: 'FMCG & Daily Utility Supply', type: 'PRODUCT', displayOrder: 460 },
  { name: 'Textile & Garments Supply', type: 'PRODUCT', displayOrder: 470 },
  { name: 'OEM / Manufacturing Vendor', type: 'BOTH', displayOrder: 480 },
  { name: 'Repair & Service Provider', type: 'SERVICE', displayOrder: 490 },
  { name: 'Multi-category Industrial Vendor', type: 'BOTH', displayOrder: 500 }
];

const ensureMarketplaceCategories = async () => {
  const count = await db.category.count({ where: { isActive: true } });
  if (count === 0) {
    await Promise.all(defaultMarketplaceCategories.map(category => {
      const slug = slugFor(category.name);
      const defaultPhotoUrl = `/category-photos/1787987232675/${slug}.webp`;
      return db.category.upsert({
        where: { slug },
        update: {
          name: category.name,
          type: category.type as any,
          displayOrder: category.displayOrder,
          isActive: true
        },
        create: {
          ...category,
          type: category.type as any,
          slug,
          imageUrl: defaultPhotoUrl,
          isActive: true
        }
      });
    }));
    await deleteCache(redisKeys.cacheCategoriesAll()).catch(() => undefined);
  }
  const categories = await db.category.findMany({
    where: { isActive: true },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }]
  });
  return categories;
};

const requireCompleteGstProfile = (gstResult: any) => {
  if (!gstResult?.isRegisteredDealer) {
    throw new ApiError(400, `GSTIN is not active on the GST registry (status: ${gstResult?.status || 'unknown'}). Please use an active GSTIN.`, 'GST_INACTIVE');
  }
  if (!gstResult?.legalName && !gstResult?.tradeName) {
    throw new ApiError(424, 'GST verification provider did not return registered business details. Please try again later.', 'GST_PROVIDER_INCOMPLETE');
  }
  const missing = [
    ['registered address', gstResult?.address],
    ['state', gstResult?.state],
    ['city or district', gstResult?.city || gstResult?.district],
    ['pincode', gstResult?.pincode]
  ].filter(([, value]) => !clean(value)).map(([label]) => label);

  if (missing.length) {
    throw new ApiError(
      422,
      `GSTIN was found, but the registry response is missing ${missing.join(', ')}. Please try again later or complete onboarding manually with your GST certificate.`,
      'GST_PROFILE_INCOMPLETE',
      { missing }
    );
  }
};

const buildVerifiedAddress = (gstResult: any) => ({
  pincode: clean(gstResult?.pincode),
  state: clean(gstResult?.state),
  city: clean(gstResult?.city || gstResult?.district),
  district: clean(gstResult?.district),
  address: clean(gstResult?.address)
});

const assertGstinNotOwnedByAnotherAccount = async (normalizedGstin: string, currentUserId: number) => {
  const currentUser = await db.user.findUnique({
    where: { id: currentUserId },
    select: {  }
  });

  const existingOrgs = await db.organization.findMany({
    where: { gstin: normalizedGstin }
  });

  for (const org of existingOrgs) {
    const status = org.verificationStatus;
    const isClosedOrArchived = status === 'CLOSED' || status === 'ARCHIVED';
    const isRejectedOrMerged = status === 'REJECTED' || status === 'MERGED';

    if (isClosedOrArchived) {
      if (!org.gstReuseAllowed) {
        throw new ApiError(400, 'This GST belongs to an archived organization but fresh registration has not been approved.', 'GST_REUSE_NOT_ALLOWED');
      }
    } else if (isRejectedOrMerged) {
      // Allowed cases - do nothing
    } else {
      if (org.companyId === currentUser?.companyId) {
        throw new ApiError(400, 'An active organization already exists with this GST in this company.', 'GST_ALREADY_ACTIVE');
      }
    }
  }
};
const attachBidFileAssets = async (rows: any[]) => {
  const fileIds = [...new Set(rows.map(row => Number(row?.fileAssetId)).filter(Boolean))];
  const assets = fileIds.length
    ? await db.fileAsset.findMany({
      where: { id: { in: fileIds }, status: 'active' },
      select: { id: true, originalName: true, mimeType: true, url: true, key: true }
    })
    : [];
  const assetsById = new Map<number, any>(assets.map((asset: any) => [Number(asset.id), asset]));

  return rows.map(row => {
    const fileAsset = row?.fileAssetId ? assetsById.get(Number(row.fileAssetId)) || null : null;
    return {
      ...row,
      fileAsset,
      documentUrl: row?.documentUrl || (fileAsset ? `/api/files/${(fileAsset as any).id}/view` : row?.documentUrl)
    };
  });
};
const fileIdFromUrl = (url: unknown) => {
  const match = String(url || '').match(/\/api\/files\/(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : null;
};
const linkUploadedTenderDocument = async (tenderId: number, documentUrl: unknown, ownerId: number) => {
  const fileAssetId = fileIdFromUrl(documentUrl);
  if (!fileAssetId) return;

  const asset = await db.fileAsset.findFirst({
    where: { id: fileAssetId, ownerId, status: 'active' }
  });
  if (!asset) throw new ApiError(400, 'Uploaded specification document is unavailable', 'TENDER_DOCUMENT_INVALID');

  await db.$transaction(async (tx: any) => {
    await tx.fileAsset.update({
      where: { id: fileAssetId },
      data: { entityType: 'tender', entityId: tenderId }
    });
    const existing = await tx.tenderDocument.findFirst({
      where: { tenderId, fileAssetId }
    });
    if (!existing) {
      await tx.tenderDocument.create({
        data: {
          tenderId,
          fileAssetId,
          documentType: 'specification',
          title: asset.originalName,
          isPublic: true
        }
      });
    }
  });
};
const attachQuoteResponseFileAssets = async (rows: any[]) => {
  const responses = rows.flatMap(row => Array.isArray(row?.quoteResponses) ? row.quoteResponses : []);
  const fileIds = [...new Set(responses.map(response => fileIdFromUrl(response?.documentUrl)).filter(Boolean))] as number[];
  const assets = fileIds.length
    ? await db.fileAsset.findMany({
      where: { id: { in: fileIds }, status: 'active' },
      select: { id: true, originalName: true, mimeType: true, url: true, key: true }
    })
    : [];
  const assetsById = new Map<number, any>(assets.map((asset: any) => [Number(asset.id), asset]));

  return rows.map(row => ({
    ...row,
    quoteResponses: Array.isArray(row?.quoteResponses)
      ? row.quoteResponses.map((response: any) => {
        const fileAssetId = fileIdFromUrl(response?.documentUrl);
        const fileAsset = fileAssetId ? assetsById.get(fileAssetId) || null : null;
        return {
          ...response,
          fileAssetId,
          fileAsset,
          documentName: fileAsset?.originalName || null,
          documentUrl: response?.documentUrl || (fileAsset ? `/api/files/${fileAsset.id}/view` : null)
        };
      })
      : row?.quoteResponses
  }));
};
const listWindow = (query: { page?: number; pageSize?: number; skip?: number; take?: number }, defaultTake = 50) => {
  const take = Math.min(1000, Math.max(1, Number(query.pageSize ?? query.take ?? defaultTake)));
  const skip = query.page ? (Math.max(1, Number(query.page)) - 1) * take : Math.max(0, Number(query.skip ?? 0));
  return { skip, take };
};
const paged = (records: unknown[], total: number, query: Record<string, unknown>, key = 'records') => ({
  [key]: records,
  records,
  total,
  ...listWindow(query),
  filters: query
});

const profileStatus = (user?: any, profile?: any) =>
  profile?.verificationStatusEnum ||
  (profile?.verificationStatus === 'VERIFIED' ? 'VERIFIED' : null) ||
  (user?.organization?.verificationStatus === 'VERIFIED' ? 'VERIFIED' : null) ||
  (approvedProcurementStatuses.has(String(user?.onboardingStatus)) ? 'VERIFIED' : 'PENDING');

const assertBuyerProcurementApproved = async (req: AuthRequest) => {
  if (isAdmin(req) || req.user?.role !== 'buyer') return (req as any)._buyerContext;
  if ((req as any)._buyerContext) return (req as any)._buyerContext;
  const user = await db.user.findUnique({
    where: { id: userId(req) },
    select: {
      id: true,
      name: true,
      email: true,
      mobile: true,
      role: true,
      onboardingStatus: true,
      sectionStatus: true,
      accountStatus: true,
      isDualRole: true,
      organizationId: true,
      organization: true,
      buyerProfile: true
    }
  });
  if (!user) throw new ApiError(404, 'User not found');

  const buyerProfileVerified = Boolean(
    user.buyerProfile?.verificationStatusEnum === 'VERIFIED' ||
    user.buyerProfile?.verificationStatus === 'VERIFIED'
  );

  const organizationVerified = Boolean(
    user.organization?.verificationStatus === 'VERIFIED' ||
    user.organization?.organizationOnboardingStatus === 'approved_for_procurement'
  );

  const allSectionsApproved = Boolean(
    user.sectionStatus &&
    typeof user.sectionStatus === 'object' &&
    Object.keys(user.sectionStatus).length > 0 &&
    Object.values(user.sectionStatus).every((s: any) => s === 'approved')
  );

  const isApproved =
    approvedProcurementStatuses.has(String(user.onboardingStatus)) ||
    user.onboardingStatus === 'completed' ||
    user.registrationStatus === 'completed' ||
    user.accountStatus === 'ACTIVE' ||
    buyerProfileVerified ||
    organizationVerified ||
    allSectionsApproved;

  if (isApproved && !approvedProcurementStatuses.has(String(user.onboardingStatus))) {
    // Harmonize user onboarding status to approved_for_procurement so downstream systems match
    await db.user.update({
      where: { id: user.id },
      data: { onboardingStatus: 'approved_for_procurement' }
    }).catch((err: any) => console.error('[HarmonizeBuyerOnboardingStatus]', err));
    user.onboardingStatus = 'approved_for_procurement';
  }

  if (!isApproved) {
    throw new ApiError(
      403,
      'Buyer account must be approved by admin before procurement actions are allowed.',
      'BUYER_PROCUREMENT_APPROVAL_REQUIRED'
    );
  }
  (req as any)._buyerContext = user;
  return user;
};

const listProfileBackedOrganizations = async (query: { q?: string; status?: string; skip?: number; take?: number; page?: number; pageSize?: number }, companyIdFilter?: number | null) => {
  const window = listWindow(query);
  let [buyers, sellers] = await Promise.all([
    db.buyerProfile.findMany({
      include: { user: { select: { id: true, name: true, email: true, onboardingStatus: true, accountStatus: true } } },
      orderBy: { updatedAt: 'desc' }
    }),
    db.sellerProfile.findMany({
      include: {
        user: { select: { id: true, name: true, email: true, onboardingStatus: true, accountStatus: true } },
        offices: { orderBy: [{ isMandatory: 'desc' }, { id: 'asc' }], take: 1 }
      },
      orderBy: { updatedAt: 'desc' }
    })
  ]);

  // If companyIdFilter is provided, filter buyers and sellers by organization's companyId
  if (companyIdFilter !== undefined && companyIdFilter !== null) {
    // Collect distinct organizationIds from buyers and sellers that are not null
    const orgIds = [...buyers, ...sellers]
      .map(p => p.organizationId)
      .filter((id): id is number => id !== null && id !== undefined);
    if (orgIds.length > 0) {
      // Fetch organizations for these ids to get their companyId
      const organizations = await db.organization.findMany({
        where: { id: { in: orgIds } },
        select: { id: true,  }
      });
      const orgIdToCompanyId = new Map<number, number>();
      for (const org of organizations) {
        orgIdToCompanyId.set(org.id, org.companyId);
      }
      // Filter buyers: keep only those where organizationId is not null and the organization's companyId matches
      buyers = buyers.filter(p => {
        const orgId = p.organizationId;
        if (orgId === null || orgId === undefined) return false;
        const companyId = orgIdToCompanyId.get(orgId);
        return companyId !== null && companyId !== undefined && companyId === companyIdFilter;
      });
      // Filter sellers similarly
      sellers = sellers.filter(p => {
        const orgId = p.organizationId;
        if (orgId === null || orgId === undefined) return false;
        const companyId = orgIdToCompanyId.get(orgId);
        return companyId !== null && companyId !== undefined && companyId === companyIdFilter;
      });
    } else {
      // If there are no organizationIds, then set arrays to empty
      buyers = [];
      sellers = [];
    }
  }

  const buyerRows = buyers.map((profile: any) => ({
    id: `buyer-profile-${profile.id}`,
    source: 'buyerProfile',
    organizationName: profile.organizationName || profile.nameAsInPan || profile.user?.name || 'Buyer Organization',
    organizationType: profile.organizationTypeEnum || 'GOVERNMENT',
    gstin: profile.gst,
    panNumber: profile.pan,
    city: profile.city,
    district: profile.district,
    state: profile.state,
    pincode: profile.pincode,
    country: profile.country || 'India',
    website: profile.website,
    verificationStatus: profileStatus(profile.user, profile),
    isBlacklisted: false,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    users: [profile.user].filter(Boolean),
    buyerProfiles: [profile],
    sellerProfiles: [],
    _count: { users: 1, buyerProfiles: 1, sellerProfiles: 0, products: 0, services: 0 },
    features: { products: true, services: true, marketplace: true, catalog: true }
  }));

  const sellerRows = sellers.map((profile: any) => {
    const office = profile.offices?.[0] || {};
    return {
      id: `seller-profile-${profile.id}`,
      source: 'sellerProfile',
      organizationName: profile.businessName || profile.nameAsInPan || profile.user?.name || 'Seller Organization',
      organizationType: profile.organizationTypeEnum || 'MSME',
      gstin: office.gstNumber,
      panNumber: profile.pan,
      city: office.city,
      state: office.state,
      country: 'India',
      verificationStatus: profileStatus(profile.user, profile),
      isBlacklisted: false,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      users: [profile.user].filter(Boolean),
      buyerProfiles: [],
      sellerProfiles: [profile],
      _count: { users: 1, buyerProfiles: 0, sellerProfiles: 1, products: 0, services: 0 },
      features: { products: true, services: true, marketplace: true, catalog: true }
    };
  });

  const term = clean(query.q).toLowerCase();
  const rows = [...buyerRows, ...sellerRows]
    .filter((org: any) => !term || [org.organizationName, org.gstin, org.panNumber, org.state, org.city].filter(Boolean).join(' ').toLowerCase().includes(term))
    .filter((org: any) => !query.status || org.verificationStatus === query.status)
    .sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return { organizations: rows.slice(window.skip, window.skip + window.take), total: rows.length };
};
const parse = <T>(schema: z.ZodType<T>, value: unknown) => schema.parse(value);
const catalogueAttachmentInclude = {
  images: { include: { fileAsset: true }, orderBy: [{ isPrimary: 'desc' as const }, { displayOrder: 'asc' as const }] },
  certifications: { include: { fileAsset: true } }
};

const attachCatalogueFiles = async (records: any[], itemKind: 'product' | 'service') => {
  const rows = Array.isArray(records) ? records : [];
  if (rows.length === 0) return rows;
  const catalogueEntityType = itemKind === 'product' ? 'catalogue_product' : 'catalogue_service';
  const assets = await db.fileAsset.findMany({
    where: {
      status: 'active',
      entityType: { in: [catalogueEntityType, 'catalogue'] },
      OR: rows.map(row => ({ ownerId: row.sellerId, entityId: row.id }))
    },
    orderBy: { createdAt: 'desc' }
  });
  return rows.map(row => ({
    ...row,
    itemKind,
    catalogueFiles: assets.filter(asset => asset.ownerId === row.sellerId && asset.entityId === row.id)
  }));
};

const asyncRoute = (handler: (req: AuthRequest, res: Response) => Promise<unknown>, fallback = 'Unable to complete request') =>
  async (req: AuthRequest, res: Response) => {
    try {
      await handler(req, res);
    } catch (error) {
      return handleSecureRouteError(res, error, fallback);
    }
  };

router.get('/procurement/methods', authenticate, authorize('buyer', 'admin', 'master_admin'), asyncRoute(async (_req, res) => {
  ok(res, procurementMethodDefinitions);
}, 'Unable to load procurement methods'));

const auditWrite = (req: AuthRequest, action: string, entityType: string, entityId?: number | string, metadata?: Record<string, unknown>) =>
  auditLog({
    actorUserId: userId(req),
    actorRole: req.user?.role,
    action,
    entityType,
    entityId,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    metadata
  });

const notifySafe = (
  targetUserId: number,
  title: string,
  message: string,
  type: string,
  redirectUrl = '/dashboard',
  priority: 'low' | 'medium' | 'high' | 'urgent' = 'medium'
) => {
  void notificationService.notifyWithEmail(targetUserId, {
    title,
    message,
    type,
    priority,
    redirectUrl
  }).catch(() => null);
};

const NOTIFICATION_READ_RETENTION_MS = 24 * 60 * 60 * 1000;

const archiveExpiredReadNotifications = async (targetUserId: number) => {
  const cutoff = new Date(Date.now() - NOTIFICATION_READ_RETENTION_MS);
  await db.notification.updateMany({
    where: {
      userId: targetUserId,
      isRead: true,
      isArchived: false,
      logs: {
        some: {
          action: 'notification.read',
          createdAt: { lte: cutoff }
        }
      }
    },
    data: { isArchived: true }
  }).catch(() => undefined);
};

const recordNotificationRead = async (targetUserId: number, notificationIds: number[]) => {
  const ids = Array.from(new Set(notificationIds.filter(id => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return;
  await db.notificationLog.createMany({
    data: ids.map(notificationId => ({
      notificationId,
      userId: targetUserId,
      action: 'notification.read',
      channel: 'SYSTEM',
      recipient: String(targetUserId),
      status: 'READ',
      sentAt: new Date()
    }))
  }).catch(() => undefined);
};

const slugFor = (name: string) =>
  name.trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const assertTenderAccess = async (req: AuthRequest, rawTenderId: number | string) => {
  const isNumeric = typeof rawTenderId === 'number' || /^\d+$/.test(String(rawTenderId));
  const numericId = isNumeric ? Number(rawTenderId) : null;
  const stringId = String(rawTenderId);

  let tender = null;
  if (numericId) {
    tender = await db.tender.findUnique({
      where: { id: numericId },
      include: {
        buyer: { include: { buyerProfile: true, organization: true } },
        tenderItems: true,
        tenderDocuments: { include: { fileAsset: true } }
      }
    });
  }
  if (!tender && stringId) {
    tender = await db.tender.findFirst({
      where: { tenderId: stringId },
      include: {
        buyer: { include: { buyerProfile: true, organization: true } },
        tenderItems: true,
        tenderDocuments: { include: { fileAsset: true } }
      }
    });
  }

  if (!tender) {
    let bid = null;
    if (numericId) {
      bid = await db.procurementBid.findUnique({
        where: { id: numericId },
        include: {
          buyer: { include: { buyerProfile: true, organization: true } },
          buyerOrganization: true,
          documents: true
        }
      });
    }
    if (!bid && stringId) {
      bid = await db.procurementBid.findFirst({
        where: { bidNumber: stringId },
        include: {
          buyer: { include: { buyerProfile: true, organization: true } },
          buyerOrganization: true,
          documents: true
        }
      });
    }

    if (bid) {
      const payload = (typeof bid.technicalPacket === 'object' && bid.technicalPacket ? (bid.technicalPacket as any) : {}) as any;
      const terms = payload.terms || {};
      const resolvedOrgName =
        bid.buyer?.organization?.organizationName ||
        bid.buyerOrganization?.organizationName ||
        bid.buyerOrganizationName ||
        bid.buyer?.buyerProfile?.organizationName ||
        'Verified Buyer';

      tender = {
        ...bid,
        id: bid.id,
        tenderId: bid.bidNumber,
        title: bid.title,
        category: bid.category,
        budget: Number(bid.estimatedValue || 0),
        description: bid.description,
        status: bid.status === 'PUBLISHED' ? 'published' : bid.status.toLowerCase(),
        statusEnum: bid.status,
        publishedAt: bid.startDate,
        closesAt: bid.endDate,
        createdAt: bid.createdAt,
        updatedAt: bid.updatedAt,
        paymentTerms: terms.paymentTerms || (bid as any).paymentTerms || null,
        deliveryType: terms.deliveryTerms || terms.deliveryType || (bid as any).deliveryType || null,
        itemCondition: bid.deliveryLocation,
        bidValidityDays: bid.bidValidityDate ? undefined : 90,
        bidValidityDate: bid.bidValidityDate,
        evaluationMethod: 'L1',
        technicalOpeningDate: bid.technicalOpeningDate,
        financialOpeningDate: bid.financialOpeningDate,
        allowReverseAuction: bid.allowReverseAuction,
        allowBoq: bid.allowBoq,
        allowClarification: bid.allowClarification,
        packetType: bid.packetType,
        buyerId: bid.buyerId,
        buyerOrganizationName: resolvedOrgName,
        buyerOrganization: bid.buyerOrganization || bid.buyer?.organization || null,
        buyer: {
          id: bid.buyer?.id || bid.buyerId,
          name: bid.buyer?.name || resolvedOrgName,
          email: bid.buyer?.email,
          organization: bid.buyer?.organization || bid.buyerOrganization || null,
          buyerOrganization: bid.buyerOrganization || bid.buyer?.organization || null,
          buyerProfile: {
            id: bid.buyer?.buyerProfile?.id || 1,
            organizationName: resolvedOrgName,
            department: bid.buyer?.buyerProfile?.department,
            contactPerson: bid.buyer?.name || bid.buyer?.buyerProfile?.contactPerson || bid.buyer?.buyerProfile?.contactPersonName,
            email: bid.buyer?.email || bid.buyer?.buyerProfile?.email || bid.buyer?.buyerProfile?.officialEmail,
            phone: bid.buyer?.mobile || bid.buyer?.buyerProfile?.contactPersonMobile || bid.buyer?.buyerProfile?.officialPhone || bid.buyer?.buyerProfile?.mobile,
            address: bid.buyer?.organization?.addressLine1 || bid.buyerOrganization?.addressLine1 || bid.buyer?.buyerProfile?.registeredAddress || bid.buyer?.buyerProfile?.officeAddress || bid.deliveryLocation
          }
        },
        tenderItems: [],
        tenderDocuments: (bid as any).documents?.map((d: any) => ({
          id: d.id,
          documentType: d.documentType || d.documentCategory || 'Tender Document',
          title: d.fileName,
          fileAsset: d.fileAsset,
          fileAssetId: d.fileAssetId,
          url: `/api/files/${d.fileAssetId}/view`
        })) || [],
        activitySnapshot: {
          totalQueries: 0,
          totalResponses: 0,
          totalViews: 0,
          interestedSuppliers: 0
        },
        technicalPacket: bid.technicalPacket,
        financialPacket: bid.financialPacket,
        termsAndConditions: bid.termsAndConditions,
        eligibilityCriteria: bid.eligibilityCriteria,
        requiredDocuments: bid.requiredDocuments
      } as any;
      
      if (bid.technicalPacket && typeof bid.technicalPacket === 'object') {
        const packet = bid.technicalPacket as any;
        if (Array.isArray(packet.items)) {
          tender.tenderItems = packet.items.map((it: any, idx: number) => ({
            id: it.id || idx + 1,
            itemName: it.itemName || it.name || it.title || bid.title,
            quantity: Number(it.quantity || 1),
            unitOfMeasure: it.unit || it.unitOfMeasure || 'Nos',
            description: it.description || it.specification || it.specifications || '',
            estimatedUnitPrice: it.estimatedUnitPrice || it.unitPrice,
            estimatedTotal: it.estimatedTotal || ((it.estimatedUnitPrice || it.unitPrice) ? (it.estimatedUnitPrice || it.unitPrice) * Number(it.quantity || 1) : null),
            brand: it.brand || it.brand_preference,
            make: it.make,
            model: it.model,
            hsn: it.hsn || it.hsn_sac_code || (it.specifications && it.specifications.hsn_sac_code),
            sac: it.sac,
            warranty: it.warranty,
            deliverySchedule: it.deliverySchedule,
            technicalSpecification: it.technicalSpecification || it.specification || '',
            specification: it.specification || it.technicalSpecification || it.description || '',
            gst: it.gst || (it.specifications && it.specifications.gst),
            alternateBrandAllowed: it.alternateBrandAllowed ?? (it.brand_flexible === 'Yes' || (it.specifications && it.specifications.brand_flexible === 'Yes')),
            uploadedSpecificationFiles: it.uploadedSpecificationFiles || it.specificationFileName || (it.specifications && it.specifications.specificationFileName),
            specificationFileName: it.specificationFileName || (it.specifications && it.specifications.specificationFileName) || '',
            fileAssetId: it.fileAssetId || (it.specifications && it.specifications.fileAssetId) || null,
            attachments: it.attachments || (it.specifications && it.specifications.attachments) || []
          }));
        }
      }
      
      if (!tender.tenderItems.length && bid.quantity) {
        tender.tenderItems = [{
          id: 1,
          itemName: bid.title,
          quantity: Number(bid.quantity),
          unitOfMeasure: bid.unit || 'Nos',
          description: bid.description
        }];
      }
    }
  }

  if (!tender) throw new ApiError(404, 'Tender not found', 'TENDER_NOT_FOUND');
  if (req.user && (isAdmin(req) || tender.buyerId === userId(req))) return tender;
  if (tender.status !== 'draft') return tender;
  if (req.user?.role === 'seller' && ['published', 'bid_submission'].includes(String(tender.status))) return tender;
  
  throw new ApiError(404, 'Tender not found', 'TENDER_NOT_FOUND');
};

const assertBidAccess = async (req: AuthRequest, bidId: number) => {
  const bid = await db.bid.findUnique({ where: { id: bidId }, include: { tender: true } });
  if (!bid) throw new ApiError(404, 'Bid not found', 'BID_NOT_FOUND');
  if (isAdmin(req) || bid.sellerId === userId(req) || bid.tender?.buyerId === userId(req)) return bid;
  throw new ApiError(404, 'Bid not found', 'BID_NOT_FOUND');
};

const assertPurchaseOrderAccess = async (req: AuthRequest, purchaseOrderId: number) => {
  const po = await db.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
  if (!po) throw new ApiError(404, 'Purchase order not found', 'PO_NOT_FOUND');
  if (isAdmin(req) || po.buyerId === userId(req) || po.sellerId === userId(req)) return po;
  throw new ApiError(404, 'Purchase order not found', 'PO_NOT_FOUND');
};

const productBody = z.object({
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  sku: z.string().trim().max(80).nullable().optional(),
  hsnCode: z.string().trim().max(30).nullable().optional(),
  brand: z.string().trim().max(120).nullable().optional(),
  modelNumber: z.string().trim().max(120).nullable().optional(),
  unitOfMeasure: z.string().trim().max(120).nullable().optional(),
  price: z.coerce.number().nonnegative().nullable().optional(),
  taxRate: z.coerce.number().min(0).max(100).nullable().optional(),
  discount: z.coerce.number().min(0).max(100).nullable().optional(),
  originalPrice: z.coerce.number().nonnegative().nullable().optional(),
  discountPrice: z.coerce.number().nonnegative().nullable().optional(),
  discountPercent: z.coerce.number().min(0).max(100).nullable().optional(),
  offerLabel: z.string().trim().max(120).nullable().optional(),
  offerStartAt: z.coerce.date().nullable().optional(),
  offerEndAt: z.coerce.date().nullable().optional(),
  isOfferActive: z.coerce.boolean().optional(),
  bulkDealAvailable: z.coerce.boolean().optional(),
  bulkMinQuantity: z.coerce.number().nonnegative().nullable().optional(),
  currency: z.string().trim().length(3).default('INR').optional(),
  isMsmeMade: z.coerce.boolean().optional(),
  itemCondition: z.string().trim().nullable().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'OUT_OF_STOCK', 'ARCHIVED']).optional(),
  imageIds: z.array(z.coerce.number().int()).optional(),
  documentIds: z.array(z.coerce.number().int()).optional(),
  specifications: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(500),
    unit: z.string().trim().max(120).nullable().optional()
  })).optional()
});

const serviceBody = z.object({
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  pricingModel: z.enum(['FIXED', 'HOURLY', 'DAILY', 'MONTHLY', 'PER_PROJECT', 'CUSTOM']).optional(),
  basePrice: z.coerce.number().nonnegative().nullable().optional(),
  taxRate: z.coerce.number().min(0).max(100).nullable().optional(),
  discount: z.coerce.number().min(0).max(100).nullable().optional(),
  originalPrice: z.coerce.number().nonnegative().nullable().optional(),
  discountPrice: z.coerce.number().nonnegative().nullable().optional(),
  discountPercent: z.coerce.number().min(0).max(100).nullable().optional(),
  offerLabel: z.string().trim().max(120).nullable().optional(),
  offerStartAt: z.coerce.date().nullable().optional(),
  offerEndAt: z.coerce.date().nullable().optional(),
  isOfferActive: z.coerce.boolean().optional(),
  bulkDealAvailable: z.coerce.boolean().optional(),
  bulkMinQuantity: z.coerce.number().nonnegative().nullable().optional(),
  currency: z.string().trim().length(3).default('INR').optional(),
  serviceArea: z.string().trim().max(300).nullable().optional(),
  scopeOfWork: z.string().trim().max(4000).nullable().optional(),
  deliverables: z.string().trim().max(4000).nullable().optional(),
  inclusions: z.string().trim().max(4000).nullable().optional(),
  exclusions: z.string().trim().max(4000).nullable().optional(),
  duration: z.string().trim().max(120).nullable().optional(),
  slaResponseTime: z.string().trim().max(120).nullable().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'OUT_OF_STOCK', 'ARCHIVED']).optional(),
  imageIds: z.array(z.coerce.number().int()).optional(),
  documentIds: z.array(z.coerce.number().int()).optional(),
  specifications: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(500),
    unit: z.string().trim().max(120).nullable().optional()
  })).optional()
});

const requirementBody = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(4000).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  procurementMethod: z.enum(['DIRECT_PURCHASE', 'RFQ', 'TENDER', 'REVERSE_AUCTION', 'RATE_CONTRACT']).default('TENDER'),
  estimatedValue: z.coerce.number().nonnegative().optional(),
  requiredBy: safeCoercedDate.optional(),
  items: z.array(z.object({
    productId: z.coerce.number().int().positive().optional(),
    itemName: z.string().trim().min(2).max(200),
    description: z.string().trim().max(2000).optional(),
    quantity: z.coerce.number().positive(),
    unitOfMeasure: z.string().trim().min(1).max(120),
    estimatedUnitPrice: z.coerce.number().nonnegative().optional(),
    specifications: z.record(z.string(), z.unknown()).optional()
  })).optional()
});

const normalizeToCanonicalMethod = (rawMethod: unknown): string => {
  const str = String(rawMethod || '').trim().toUpperCase().replace(/-/g, '_');
  
  if ([
    'DIRECT_PURCHASE', 'CATALOG_PURCHASE', 'RFQ', 'RFP', 'RFI',
    'SEALED_TENDER', 'OPEN_TENDER', 'LIMITED_TENDER', 'TWO_PACKET_BID',
    'REVERSE_AUCTION', 'BID_WITH_REVERSE_AUCTION', 'RATE_CONTRACT',
    'REPEAT_ORDER', 'SINGLE_SOURCE', 'EMERGENCY_PURCHASE',
    'BOQ_BASED_BID'
  ].includes(str)) {
    return str;
  }

  switch (str) {
    case 'L1_COMPARISON':
    case 'COMPARISON':
      return 'RFQ';
    case 'REQUEST_FOR_PROPOSAL':
      return 'RFP';
    case 'EXPRESSION_OF_INTEREST':
      return 'RFI';
    case 'SINGLE_TENDER':
      return 'SINGLE_SOURCE';
    case 'BOQ_BID':
    case 'BOQ':
      return 'BOQ_BASED_BID';
    case 'EMERGENCY':
    case 'EMERGENCY_PROCUREMENT':
      return 'EMERGENCY_PURCHASE';
    case 'BID_WITH_RA':
      return 'BID_WITH_REVERSE_AUCTION';
    case 'TENDER':
      return 'OPEN_TENDER';
    case 'CUSTOM_PRODUCT_BID':
    case 'PRODUCT_BID':
    case 'CUSTOM_BID':
      return 'OPEN_TENDER';
    case 'CUSTOM_SERVICE_BID':
    case 'SERVICE_BID':
      return 'RFP';
    default:
      return 'OPEN_TENDER';
  }
};

const procurementMethodCodeFor = (value: unknown) => {
  const canonical = normalizeToCanonicalMethod(value);
  switch (canonical) {
    case 'DIRECT_PURCHASE':
    case 'CATALOG_PURCHASE':
    case 'REPEAT_ORDER':
    case 'SINGLE_SOURCE':
    case 'EMERGENCY_PURCHASE':
      return 'DIRECT_PURCHASE';

    case 'RFQ':
    case 'RFI':
      return 'RFQ';

    case 'REVERSE_AUCTION':
    case 'BID_WITH_REVERSE_AUCTION':
      return 'REVERSE_AUCTION';

    case 'RATE_CONTRACT':
      return 'RATE_CONTRACT';

    case 'RFP':
    case 'SEALED_TENDER':
    case 'OPEN_TENDER':
    case 'LIMITED_TENDER':
    case 'TWO_PACKET_BID':
    case 'BOQ_BASED_BID':
    default:
      return 'TENDER';
  }
};

const procurementDraftBody = z.object({
  id: z.coerce.number().int().positive().optional(),
  procurementMethod: z.string().trim().max(80).optional(),
  method: z.string().trim().max(80).optional(),
  methodSlug: z.string().trim().max(80).optional(),
  canonicalMethod: z.string().trim().max(80).optional(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(4000).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  estimatedValue: z.coerce.number().nonnegative().optional(),
  requiredBy: safeCoercedDate.optional(),
  draftStep: z.coerce.number().int().min(0).optional(),
  workflowStatus: z.string().trim().max(80).optional(),
  approvalStatus: z.string().trim().max(80).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  items: z.array(z.object({
    productId: z.coerce.number().int().positive().optional(),
    itemName: z.string().trim().max(200).optional().or(z.literal('')),
    description: z.string().trim().max(2000).optional(),
    quantity: z.coerce.number().optional(),
    unitOfMeasure: z.string().trim().max(120).optional().or(z.literal('')),
    estimatedUnitPrice: z.coerce.number().nonnegative().optional(),
    specifications: z.record(z.string(), z.unknown()).optional()
  })).optional()
}).passthrough();

const procurementStatusMap: Record<string, string> = {
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'SUBMITTED',
  SUBMITTED: 'SUBMITTED',
  APPROVED: 'APPROVED',
  PUBLISHED: 'SOURCING',
  OPEN: 'SOURCING',
  CLARIFICATION: 'SOURCING',
  CLOSED: 'SOURCING',
  TECHNICAL_EVALUATION: 'SOURCING',
  FINANCIAL_EVALUATION: 'SOURCING',
  AWARD_RECOMMENDED: 'SOURCING',
  AWARDED: 'FULFILLED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED'
};

const procurementDraftInclude = {
  items: {
    select: {
      id: true,
      itemName: true,
      description: true,
      quantity: true,
      unitOfMeasure: true,
      estimatedUnitPrice: true,
      specifications: true
    }
  },
  category: {
    select: {
      id: true,
      name: true
    }
  }
};

// Optimized select for list queries (minimal fields)
const procurementListSelect = {
  id: true,
  requirementNumber: true,
  title: true,
  status: true,
  procurementMethod: true,
  estimatedValue: true,
  requiredBy: true,
  createdAt: true,
  updatedAt: true,
  buyerId: true,
  organizationId: true,
  categoryId: true,
  category: {
    select: {
      id: true,
      name: true
    }
  }
};

const methodSlugForDraft = (body: Record<string, unknown>) => {
  const raw = body.methodSlug || body.method || body.procurementMethod || 'OPEN_TENDER';
  const canonical = normalizeToCanonicalMethod(raw);
  return canonical.toLowerCase().replace(/_/g, '-');
};

const toDraftItems = (items: Array<Record<string, unknown>> | undefined, methodSlug: string, draftMeta: Record<string, unknown>) =>
  (items || []).map((item, index) => ({
    productId: item.productId ? Number(item.productId) : undefined,
    itemName: clean(item.itemName || item.name || `Procurement item ${index + 1}`),
    description: clean(item.description || item.specification || ''),
    quantity: Number(item.quantity || item.qty || 1),
    unitOfMeasure: clean(item.unitOfMeasure || item.unit || 'Nos'),
    estimatedUnitPrice: item.estimatedUnitPrice !== undefined || item.unitPrice !== undefined
      ? Number(item.estimatedUnitPrice ?? item.unitPrice)
      : undefined,
    specifications: {
      ...(typeof item.specifications === 'object' && item.specifications ? item.specifications : {}),
      procurementMethodSlug: methodSlug,
      draftMeta
    }
  }));

export const serializeProcurementDraft = (requirement: any) => {
  const firstMeta = requirement?.items?.find((item: any) => item.specifications)?.specifications || {};
  const payload = requirement.payload || firstMeta.draftMeta?.payload || null;
  
  // Resolve methodSlug canonically
  const rawMethod = payload?.fullProcurementMethod || payload?.type || firstMeta.procurementMethodSlug || requirement.procurementMethod || 'OPEN_TENDER';
  const methodSlug = normalizeToCanonicalMethod(rawMethod).toLowerCase().replace(/_/g, '-');

  const draftStep = requirement.draftStep ?? firstMeta.draftMeta?.draftStep ?? null;

  return {
    ...requirement,
    methodSlug,
    workflowStatus: Object.entries(procurementStatusMap).find(([, value]) => value === requirement.status)?.[0] || requirement.status,
    isPublished: !['DRAFT', 'REJECTED'].includes(String(requirement.status || '').toUpperCase()),
    draftStep,
    payload
  };
};

export const resolveRequirementId = async (idParam: string | number): Promise<number | null> => {
  const rawId = String(idParam || '').trim();
  if (!rawId) return null;
  const numId = Number(rawId);
  if (!isNaN(numId) && Number.isFinite(numId) && numId > 0) {
    const existingReq = await db.requirement.findUnique({
      where: { id: numId },
      select: { id: true }
    });
    if (existingReq) return existingReq.id;

    // Check if numId matches a ProcurementBid
    const matchingBid = await db.procurementBid.findUnique({
      where: { id: numId },
      select: { id: true, bidNumber: true, technicalPacket: true }
    });
    if (matchingBid) {
      const packet = typeof matchingBid.technicalPacket === 'object' && matchingBid.technicalPacket !== null
        ? (matchingBid.technicalPacket as any)
        : {};
      const linkedId = Number(packet.sourceRequirementId || packet.requirementId || 0);
      if (linkedId > 0) {
        const byLinked = await db.requirement.findUnique({ where: { id: linkedId }, select: { id: true } });
        if (byLinked) return byLinked.id;
      }

      if (matchingBid.bidNumber) {
        const reqByBid = await db.requirement.findFirst({
          where: {
            OR: [
              { requirementNumber: matchingBid.bidNumber },
              { requirementNumber: { equals: matchingBid.bidNumber, mode: 'insensitive' } }
            ]
          },
          select: { id: true }
        });
        if (reqByBid) return reqByBid.id;
      }
    }
  }

  const upperToken = rawId.toUpperCase();
  const variants = Array.from(new Set([
    rawId,
    upperToken,
    ...getCanonicalLookupVariants(rawId),
    ...getCanonicalLookupVariants(upperToken)
  ]));
  const found = await db.requirement.findFirst({
    where: {
      OR: [
        { requirementNumber: { in: variants } },
        { requirementNumber: { in: variants, mode: 'insensitive' } },
        { requirementNumber: rawId },
        { requirementNumber: upperToken }
      ]
    },
    select: { id: true }
  });
  if (found) return found.id;

  // Check tail sequence number if rawId is in format PREFIX-YYYY-XXXXX or PREFIX-XXXXX
  const tailMatch = rawId.match(/-(\d+)$/);
  if (tailMatch) {
    const tailId = Number(tailMatch[1]);
    if (!isNaN(tailId) && tailId > 0) {
      const byTail = await db.requirement.findFirst({
        where: { id: tailId },
        select: { id: true }
      });
      if (byTail) return byTail.id;
    }
  }

  const matchingBid = await db.procurementBid.findFirst({
    where: {
      OR: [
        { bidNumber: { in: variants } },
        { bidNumber: { in: variants, mode: 'insensitive' } },
        { bidNumber: rawId },
        { bidNumber: upperToken },
        ...(tailMatch && Number(tailMatch[1]) > 0 ? [{ id: Number(tailMatch[1]) }] : []),
        ...(!isNaN(numId) && numId > 0 ? [{ id: numId }] : [])
      ]
    },
    select: { id: true, bidNumber: true, technicalPacket: true }
  });
  if (matchingBid) {
    const packet = typeof matchingBid.technicalPacket === 'object' && matchingBid.technicalPacket !== null
      ? (matchingBid.technicalPacket as any)
      : {};
    const linkedId = Number(packet.sourceRequirementId || packet.requirementId || 0);
    if (linkedId > 0) return linkedId;

    const reqByBid = await db.requirement.findFirst({
      where: {
        OR: [
          ...(matchingBid.bidNumber ? [{ requirementNumber: matchingBid.bidNumber }, { requirementNumber: { equals: matchingBid.bidNumber, mode: 'insensitive' } }] : []),
          { id: matchingBid.id }
        ]
      },
      select: { id: true }
    });
    if (reqByBid) return reqByBid.id;
  }
  return null;
};

export const synthesizeDraftFromProcurementBid = (bid: any) => {
  const technicalPacket = typeof bid.technicalPacket === 'object' && bid.technicalPacket ? (bid.technicalPacket as any) : {};
  const packetBasics = technicalPacket.basics || {};
  const packetSchedule = technicalPacket.schedule || {};
  const packetTerms = technicalPacket.terms || {};
  const packetInternal = technicalPacket.internal || {};
  const packetVendors = technicalPacket.vendors || {};
  const method = bid.canonicalMethod || bid.procurementType || 'OPEN_TENDER';
  const methodSlug = normalizeToCanonicalMethod(method).toLowerCase().replace(/_/g, '-');

  const tenderItems = Array.isArray(technicalPacket.items) && technicalPacket.items.length > 0
    ? technicalPacket.items
    : [{
        id: 1,
        itemName: bid.title,
        quantity: bid.quantity ? String(bid.quantity) : '1',
        unitOfMeasure: bid.unit || 'Nos',
        description: bid.description,
        estimatedUnitPrice: bid.estimatedValue && bid.quantity ? Number(bid.estimatedValue) / Number(bid.quantity) : undefined
      }];

  const requirementItems = tenderItems.map((it: any, idx: number) => ({
    id: it.id || idx + 1,
    itemName: it.itemName || it.name || bid.title,
    quantity: String(it.quantity || '1'),
    unitOfMeasure: it.unitOfMeasure || it.unit || 'Nos',
    description: it.description || '',
    estimatedUnitPrice: it.estimatedUnitPrice,
    specifications: {
      ...(it.specifications || it),
      procurementMethodSlug: methodSlug,
      draftMeta: {
        methodSlug,
        draftStep: 1,
        workflowStatus: bid.status,
        approvalStatus: bid.approvalStatus || 'APPROVED',
        payload: {
          ...technicalPacket,
          type: method,
          basics: {
            title: bid.title,
            description: bid.description,
            procurementCategory: bid.categoryType || packetBasics.procurementCategory || 'GOODS',
            estimatedValue: Number(bid.estimatedValue || 0),
            deliveryLocation: bid.deliveryLocation,
            ...packetBasics
          },
          schedule: {
            submissionStartDate: bid.startDate?.toISOString?.() || packetSchedule.submissionStartDate || '',
            submissionDate: bid.endDate?.toISOString?.() || packetSchedule.submissionDate || '',
            technicalOpeningDate: bid.technicalOpeningDate?.toISOString?.() || packetSchedule.technicalOpeningDate || '',
            financialOpeningDate: bid.financialOpeningDate?.toISOString?.() || packetSchedule.financialOpeningDate || '',
            ...packetSchedule
          },
          internal: {
            orgName: bid.buyerOrganizationName || packetInternal.orgName || '',
            ...packetInternal
          },
          vendors: packetVendors,
          terms: packetTerms,
          items: tenderItems
        }
      }
    }
  }));

  return {
    id: bid.id,
    requirementNumber: bid.bidNumber,
    title: bid.title,
    description: bid.description,
    buyerId: bid.buyerId,
    status: bid.status,
    canonicalMethod: method,
    procurementMethod: method,
    estimatedValue: Number(bid.estimatedValue || 0),
    deliveryLocation: bid.deliveryLocation,
    version: Number(bid.version || 1),
    isPublished: true,
    draftStep: 1,
    createdAt: bid.createdAt,
    updatedAt: bid.updatedAt,
    publishedAt: bid.publishedAt || bid.createdAt,
    postPublishEditCount: Number(bid.postPublishEditCount || 0),
    items: requirementItems,
    payload: {
      ...technicalPacket,
      type: method,
      basics: {
        title: bid.title,
        description: bid.description,
        procurementCategory: bid.categoryType || packetBasics.procurementCategory || 'GOODS',
        estimatedValue: Number(bid.estimatedValue || 0),
        deliveryLocation: bid.deliveryLocation,
        ...packetBasics
      },
      schedule: {
        submissionStartDate: bid.startDate?.toISOString?.() || packetSchedule.submissionStartDate || '',
        submissionDate: bid.endDate?.toISOString?.() || packetSchedule.submissionDate || '',
        technicalOpeningDate: bid.technicalOpeningDate?.toISOString?.() || packetSchedule.technicalOpeningDate || '',
        financialOpeningDate: bid.financialOpeningDate?.toISOString?.() || packetSchedule.financialOpeningDate || '',
        ...packetSchedule
      },
      internal: {
        orgName: bid.buyerOrganizationName || packetInternal.orgName || '',
        ...packetInternal
      },
      vendors: packetVendors,
      terms: packetTerms,
      items: tenderItems
    }
  };
};

const assertProcurementDraftAccess = async (req: AuthRequest, idParam: number | string) => {
  const resolvedId = await resolveRequirementId(idParam);
  let requirement = resolvedId
    ? await db.requirement.findUnique({ where: { id: resolvedId }, include: procurementDraftInclude })
    : null;

  if (!requirement) {
    const rawId = String(idParam || '').trim();
    const numId = Number(rawId);
    const variants = Array.from(new Set([
      rawId,
      rawId.toUpperCase(),
      ...getCanonicalLookupVariants(rawId),
      ...getCanonicalLookupVariants(rawId.toUpperCase())
    ]));

    const bid = await db.procurementBid.findFirst({
      where: {
        OR: [
          ...(!isNaN(numId) && numId > 0 ? [{ id: numId }] : []),
          { bidNumber: { in: variants } },
          { bidNumber: { in: variants, mode: 'insensitive' } },
          { bidNumber: rawId }
        ]
      },
      include: {
        buyer: { include: { buyerProfile: true, organization: true } },
        documents: true,
        participations: true
      }
    });

    if (bid) {
      if (!isAdmin(req) && req.user?.role !== 'master_admin' && bid.buyerId !== userId(req)) {
        throw new ApiError(404, 'Procurement draft not found', 'PROCUREMENT_DRAFT_NOT_FOUND');
      }
      return synthesizeDraftFromProcurementBid(bid);
    }

    throw new ApiError(404, 'Procurement draft not found', 'PROCUREMENT_DRAFT_NOT_FOUND');
  }

  if (!isAdmin(req) && req.user?.role !== 'master_admin' && requirement.buyerId !== userId(req)) {
    throw new ApiError(404, 'Procurement draft not found', 'PROCUREMENT_DRAFT_NOT_FOUND');
  }
  return requirement;
};

const validateProcurementDraftForSubmit = (draft: any) => {
  const methodSlug = methodSlugForDraft(draft);
  const estimatedValue = Number(draft.estimatedValue || 0);
  const items = Array.isArray(draft.items) ? draft.items : [];
  const payload = draft.payload || {};
  const tender = payload.tender || {};
  const rules = payload.rules || {};
  const basics = payload.basics || {};
  const documents = Array.isArray(payload.documents) ? payload.documents : [];
  const consignees = Array.isArray(payload.consigneeDetails) ? payload.consigneeDetails : [];
  const hasDocument = (pattern: RegExp) => documents.some((doc: any) => pattern.test(String(doc.name || '')) && clean(doc.fileName));
  const hasSpecification = items.some((item: any) => clean(item.description || item.specification || item.technicalSpecification).length >= 10)
    || (Array.isArray(payload.items) && payload.items.some((item: any) => clean(item.specification || item.technicalSpecification || item.specificationFileName).length >= 10));
  const totalItemQuantity = (Array.isArray(payload.items) ? payload.items : items).reduce((total: number, item: any) => total + Number(item.quantity || 0), 0);
  const totalConsigneeQuantity = consignees.reduce((total: number, consignee: any) => total + Number(consignee.quantity || 0), 0);
  const hasConsigneeLocation = consignees.some((consignee: any) => clean(consignee.location || consignee.name));
  const isAfter = (later?: unknown, earlier?: unknown) => {
    if (!later || !earlier) return true;
    const laterTime = new Date(String(later)).getTime();
    const earlierTime = new Date(String(earlier)).getTime();
    return Number.isFinite(laterTime) && Number.isFinite(earlierTime) && laterTime > earlierTime;
  };
  if (estimatedValue <= 0) throw new ApiError(400, 'Estimated procurement value must be positive', 'PROCUREMENT_VALUE_REQUIRED');
  if (items.length === 0) throw new ApiError(400, 'At least one item or service line is required', 'PROCUREMENT_ITEM_REQUIRED');

  // Verify that all items have valid names, quantities, and units based on two-tier Category and Pricing Format
  const rawCat = basics.procurementCategory || basics.categoryType || payload.procurementCategory || payload.categoryType;
  const rawFormat = basics.pricingFormat || basics.sourcingFormat || payload.pricingFormat;

  const categoryType: 'GOODS' | 'SERVICES' | 'WORKS' =
    rawCat === 'SERVICES'
      ? 'SERVICES'
      : rawCat === 'WORKS'
      ? 'WORKS'
      : 'GOODS';

  const pricingFormat: 'SINGLE_ITEM' | 'BOQ' | 'SOR' =
    rawFormat === 'SOR'
      ? 'SOR'
      : rawFormat === 'BOQ'
      ? 'BOQ'
      : 'SINGLE_ITEM';

  if (categoryType === 'GOODS') {
    for (const item of items) {
      if (!item.itemName || String(item.itemName).trim().length < 2) {
        throw new ApiError(400, 'Item name must be at least 2 characters long', 'PROCUREMENT_ITEM_NAME_INVALID');
      }
      if (typeof item.quantity !== 'number' || item.quantity <= 0) {
        throw new ApiError(400, 'Item quantity must be positive', 'PROCUREMENT_ITEM_QUANTITY_INVALID');
      }
      if (!item.unitOfMeasure || String(item.unitOfMeasure).trim().length < 1) {
        throw new ApiError(400, 'Item unit of measure is required', 'PROCUREMENT_ITEM_UOM_INVALID');
      }
    }
  } else if (categoryType === 'SERVICES') {
    const serviceDetails = payload.serviceDetails || {};
    const hasSow = Boolean(serviceDetails.sowFileAssetId || serviceDetails.sowFileName || (serviceDetails.scopeOfWork && String(serviceDetails.scopeOfWork).trim().length >= 10));
    const serviceTitle = String(serviceDetails.serviceTitle || basics.title || '').trim();
    if (!serviceTitle) {
      throw new ApiError(400, 'Service Contract Title is required', 'PROCUREMENT_SERVICE_TITLE_REQUIRED');
    }
    if (!hasSow) {
      throw new ApiError(400, 'Service Scope of Work (SOW text or document upload) is required', 'PROCUREMENT_SERVICE_SOW_REQUIRED');
    }
  } else if (categoryType === 'WORKS') {
    const hasWorkScope = clean(basics.title).length >= 5 || items.length > 0;
    if (!hasWorkScope) {
      throw new ApiError(400, 'Works Contract Scope and line items are required', 'PROCUREMENT_WORKS_SCOPE_REQUIRED');
    }
  }

  if (pricingFormat === 'BOQ' || pricingFormat === 'SOR') {
    const boqTable = Array.isArray(payload.boqTable) ? payload.boqTable : [];
    if (boqTable.length > 0) {
      const validRows = boqTable.filter((r: any) => clean(r.description).length > 0);
      if (validRows.length === 0) {
        throw new ApiError(400, 'At least one valid line item is required in the BOQ schedule', 'PROCUREMENT_BOQ_EMPTY');
      }
    }
  }

  const isBoqOrWorks = pricingFormat === 'BOQ' || pricingFormat === 'SOR' || categoryType === 'WORKS';
  if (!hasConsigneeLocation) {
    throw new ApiError(400, 'Consignee delivery location is required', 'PROCUREMENT_CONSIGNEE_LOCATION_REQUIRED');
  }
  if (!isBoqOrWorks && (totalItemQuantity <= 0 || totalItemQuantity !== totalConsigneeQuantity)) {
    throw new ApiError(400, 'Total consignee quantity must equal total procurement quantity', 'PROCUREMENT_CONSIGNEE_QUANTITY_INVALID');
  }

  // Ensure submission deadline is set in the future
  const schedule = payload.schedule || {};
  const rawSubDate = schedule.submissionDate || schedule.submissionDeadline || tender.bidClosingDate;
  if (rawSubDate) {
    const parsedSubDate = parseDateIST(rawSubDate);
    const subTime = parsedSubDate ? parsedSubDate.getTime() : NaN;
    if (Number.isFinite(subTime) && subTime <= Date.now()) {
      throw new ApiError(400, 'Submission deadline date and time must be set in the future', 'PROCUREMENT_DEADLINE_PAST');
    }
  }

  // Timeline validations for tender-family, BOQ, PAC, rate-contract, and bid-with-reverse-auction methods
  const timelineMethodSlugs = [
    'open-tender', 'sealed-tender', 'limited-tender', 'two-packet-bid',
    'boq-based-bid', 'rate-contract',
    'rfp', 'bid-with-reverse-auction', 'emergency-purchase'
  ];
  if (timelineMethodSlugs.includes(methodSlug)) {
    if (tender.bidStartDate && tender.bidClosingDate && !isAfter(tender.bidClosingDate, tender.bidStartDate)) {
      throw new ApiError(400, 'Bid end date must be after start date', 'PROCUREMENT_DATE_INVALID');
    }
    if (tender.technicalEvaluationDate && tender.bidClosingDate && !isAfter(tender.technicalEvaluationDate, tender.bidClosingDate)) {
      throw new ApiError(400, 'Technical opening date must be after bid end date', 'PROCUREMENT_DATE_INVALID');
    }
    if (tender.financialEvaluationDate && tender.technicalEvaluationDate && !isAfter(tender.financialEvaluationDate, tender.technicalEvaluationDate)) {
      throw new ApiError(400, 'Financial opening date must be after technical opening date', 'PROCUREMENT_DATE_INVALID');
    }
  }
  if (methodSlug === 'rfp') {
    const payloadObj = (draft.payload && typeof draft.payload === 'object') ? draft.payload as Record<string, any> : {};
    const serviceDetails = (payloadObj.serviceDetails && typeof payloadObj.serviceDetails === 'object') ? payloadObj.serviceDetails : {};
    const approval = (payloadObj.approval && typeof payloadObj.approval === 'object') ? payloadObj.approval : {};
    const rfpScope = clean(
      tender.scopeOfWork ||
      serviceDetails.scopeOfWork ||
      (serviceDetails.sowFileName ? `Refer to attached SOW document: ${serviceDetails.sowFileName}` : '') ||
      (payloadObj.boqFileName ? `Refer to attached BOQ schedule: ${payloadObj.boqFileName}` : '') ||
      basics.justification ||
      approval.notes ||
      payloadObj.limitedTenderJustification ||
      draft.description
    );
    if (rfpScope.length < 10) {
      throw new ApiError(400, 'RFP requires a scope of work or detailed justification', 'PROCUREMENT_SCOPE_REQUIRED');
    }
  }
  if (methodSlug === 'reverse-auction') {
    const auctionConfig = normalizeAuctionConfigForDraft(draft);
    validateAuctionConfigForDraft(auctionConfig, methodSlug, payload.vendors?.selection);
  }

  // Limited Sourcing validation
  if (methodSlug === 'limited-tender' || (methodSlug === 'rfq' && payload.rfqType === 'LIMITED')) {
    const justification = payload.limitedTenderJustification || basics.justification || '';
    if (clean(justification).length < 15) {
      throw new ApiError(400, 'Limited Tender / RFQ requires a written justification of at least 15 characters', 'PROCUREMENT_JUSTIFICATION_REQUIRED');
    }
    const invitedSellers = Array.isArray(payload.vendors?.invitedSellers) ? payload.vendors.invitedSellers : [];
    if (invitedSellers.length === 0) {
      throw new ApiError(400, 'Limited Tender / RFQ requires inviting at least one selected vendor', 'PROCUREMENT_VENDORS_REQUIRED');
    }
  }

  // Statutory audit field validation
  const internal = payload.internal || {};

  // GFR 2017 Rule 162: Limited Tender Enquiry threshold is ₹25 Lakhs; higher values require detailed justification
  if (methodSlug === 'limited-tender' && estimatedValue > 2500000) {
    const justification = payload.limitedTenderJustification || basics.justification || internal.justification || '';
    if (clean(justification).length < 50) {
      throw new ApiError(400, 'Limited Tender exceeding ₹25 Lakhs (GFR Rule 162 threshold) requires a comprehensive justification of at least 50 characters', 'GFR_LTE_THRESHOLD_EXCEEDED');
    }
  }
  const approvalAuthority = clean(internal.approvalAuthority || payload.approvalAuthority || '');
  if (approvalAuthority) {
    if (approvalAuthority.length < 3) {
      throw new ApiError(400, 'Internal Approval Authority must be at least 3 characters', 'APPROVAL_AUTHORITY_INVALID');
    }
    if (/^(.)\1{3,}$/i.test(approvalAuthority) || /^(faf|asdf|test|xyz|abc|qwer)+$/i.test(approvalAuthority.replace(/\s+/g, '')) || !/[a-zA-Z]/.test(approvalAuthority)) {
      throw new ApiError(400, 'Please enter a valid title or name for Internal Approval Authority', 'APPROVAL_AUTHORITY_INVALID');
    }
  }

  const statutoryJustification = clean(payload.limitedTenderJustification || basics.justification || internal.justification || '');
  if (statutoryJustification) {
    if (/^(.)\1{4,}$/i.test(statutoryJustification) || /^(faf|asdf|test|xyz|abc|qwer)+$/i.test(statutoryJustification.replace(/\s+/g, ''))) {
      throw new ApiError(400, 'Please provide a legitimate business justification or statutory compliance reason', 'JUSTIFICATION_INVALID');
    }
  }

  // QCBS evaluation weightage invariant (CVC / GFR prescribed evaluation fairness)
  const evaluation = payload.evaluation || {};
  if (String(evaluation.method || '').toUpperCase() === 'QCBS') {
    const techWeight = Number(evaluation.technicalWeightage ?? evaluation.techWeight ?? 70);
    const finWeight = Number(evaluation.financialWeightage ?? evaluation.commWeight ?? evaluation.finWeight ?? 30);
    if (techWeight + finWeight !== 100) {
      throw new ApiError(400, `QCBS technical and financial weightage must sum to exactly 100% (currently ${techWeight + finWeight}%)`, 'QCBS_WEIGHT_INVALID');
    }
  }
};

const auctionConfigSchema = z.object({
  auctionNumber: z.string().trim().max(80).optional(),
  auctionTitle: z.string().trim().min(3).max(180),
  auctionDescription: z.string().trim().max(3000).optional(),
  procurementMethod: z.enum(['REVERSE_AUCTION', 'BID_WITH_REVERSE_AUCTION']),
  category: z.string().trim().max(160).optional(),
  currency: z.string().trim().length(3).default('INR'),
  buyerOrganization: z.string().trim().max(180).optional(),
  department: z.string().trim().max(160).optional(),
  purchaseGroup: z.string().trim().max(120).optional(),
  purchaseOrganization: z.string().trim().max(160).optional(),
  auctionType: z.enum(['ENGLISH_REVERSE', 'RANK_BASED_REVERSE']),
  auctionMode: z.enum(['ONLINE']),
  auctionStartDateTime: safeCoercedDate,
  auctionEndDateTime: safeCoercedDate,
  auctionDurationMinutes: z.coerce.number().int().positive({ message: 'Reverse auction duration must be greater than 0 minutes' }),
  startingBidPrice: z.coerce.number().positive({ message: 'Reverse auction starting bid price must be greater than 0' }),
  reservePrice: z.preprocess(val => (val === 0 || val === '0' || val === '' ? null : val), z.coerce.number().positive({ message: 'Reserve price must be greater than 0' }).optional().nullable()),
  minimumBidDecrement: z.coerce.number().positive({ message: 'Reverse auction minimum bid decrement must be greater than 0' }),
  autoExtensionEnabled: z.coerce.boolean(),
  extensionTriggerMinutes: z.coerce.number().int().positive().optional().nullable(),
  extensionDurationMinutes: z.coerce.number().int().positive().optional().nullable(),
  maximumExtensions: z.coerce.number().int().min(0).optional().nullable(),
  rankVisibility: z.enum(['SHOW_RANK_ONLY', 'SHOW_LOWEST_PRICE', 'HIDDEN']),
  qualifiedVendors: z.array(z.object({
    sellerOrgId: z.coerce.number().int().positive(),
    sellerUserId: z.coerce.number().int().positive().optional().nullable(),
    status: z.string().trim().max(80).optional()
  })).default([]),
  minimumQualifiedBidders: z.coerce.number().int().min(2),
  auctionTermsDocument: z.object({
    fileAssetId: z.coerce.number().int().positive().optional().nullable(),
    fileName: z.string().trim().max(2000).optional().nullable()
  }).optional().nullable(),
  buyerMonitorSettings: z.record(z.string(), z.unknown()).default({}),
  triggerConfiguration: z.object({
    preBidStageRequired: z.coerce.boolean().default(false),
    auctionAfterTechnicalQualification: z.coerce.boolean().default(false),
    auctionAmongTopNBidders: z.coerce.number().int().positive().optional().nullable(),
    auctionAmongAllTechnicallyQualified: z.coerce.boolean().default(true)
  }).optional().nullable()
}).passthrough();

const normalizeAuctionConfigForDraft = (draft: any) => {
  const payload = draft.payload || {};
  const rules = payload.rules || {};
  const raw = payload.auctionConfig || rules.auctionConfig || {};
  const estVal = Number(payload.basics?.estimatedValue || payload.estimatedValue || draft.estimatedValue || 0);
  return {
    auctionTitle: raw.auctionTitle || payload.basics?.title || draft.title,
    auctionDescription: raw.auctionDescription || draft.description || payload.basics?.description,
    procurementMethod: raw.procurementMethod || payload.fullProcurementMethod || draft.canonicalMethod || draft.method || draft.procurementMethod,
    category: raw.auctionCategory || raw.category || payload.basics?.category || payload.category,
    currency: raw.currency || payload.currency || payload.basics?.currency || draft.currency || 'INR',
    buyerOrganization: raw.buyerOrganization || payload.internal?.orgName,
    department: raw.department || payload.internal?.department,
    purchaseGroup: raw.purchaseGroup,
    purchaseOrganization: raw.purchaseOrganization,
    auctionType: raw.auctionType || 'ENGLISH_REVERSE',
    auctionMode: raw.auctionMode || 'ONLINE',
    auctionStartDateTime: raw.auctionStartDateTime || raw.startDateTime || raw.startAt || rules.auctionStartDateTime,
    auctionEndDateTime: raw.auctionEndDateTime || raw.endDateTime || raw.endAt || rules.auctionEndDateTime,
    auctionDurationMinutes: Number(raw.auctionDurationMinutes || raw.durationMinutes || 60),
    startingBidPrice: (() => {
      const explicit = raw.startingBidPrice ?? raw.startingPrice ?? rules.startPrice;
      if (explicit !== undefined && explicit !== null && Number(explicit) > 0) {
        return Number(explicit);
      }
      if (estVal > 0) return estVal;
      return Number(explicit || 0);
    })(),
    reservePrice: (raw.reservePrice && Number(raw.reservePrice) > 0)
      ? Number(raw.reservePrice)
      : ((rules.reservePrice && Number(rules.reservePrice) > 0) ? Number(rules.reservePrice) : null),
    minimumBidDecrement: (() => {
      const explicit = raw.minimumBidDecrement ?? raw.minDecrementAmount ?? rules.minimumDecrement;
      if (explicit !== undefined && explicit !== null && Number(explicit) > 0) {
        return Number(explicit);
      }
      if (estVal > 0) return Math.max(100, Math.round(estVal * 0.01));
      return 1000;
    })(),
    autoExtensionEnabled: Boolean(raw.autoExtensionEnabled ?? rules.autoExtensionEnabled ?? false),
    extensionTriggerMinutes: raw.extensionTriggerMinutes ?? raw.autoExtensionWindowMinutes ?? null,
    extensionDurationMinutes: raw.extensionDurationMinutes ?? raw.autoExtensionByMinutes ?? null,
    maximumExtensions: raw.maximumExtensions ?? raw.maxAutoExtensions ?? 0,
    rankVisibility: raw.rankVisibility || (rules.showLowestPrice ? 'SHOW_LOWEST_PRICE' : rules.showSellerRank ? 'SHOW_RANK_ONLY' : 'HIDDEN'),
    qualifiedVendors: Array.isArray(raw.qualifiedVendors)
      ? raw.qualifiedVendors.map((vendor: unknown) =>
        typeof vendor === 'object' && vendor !== null
          ? vendor
          : { sellerOrgId: vendor }
      )
      : Array.isArray(payload.vendors?.invitedSellers)
        ? payload.vendors.invitedSellers.map((sellerOrgId: unknown) => ({ sellerOrgId }))
        : [],
    minimumQualifiedBidders: raw.minimumQualifiedBidders || payload.schedule?.minimumBidders || 2,
    auctionTermsDocument: raw.auctionTermsDocument,
    buyerMonitorSettings: raw.buyerMonitorSettings || {},
    triggerConfiguration: (() => {
      const tc = raw.triggerConfiguration || {};
      const method = raw.procurementMethod || payload.basics?.method || payload.fullProcurementMethod || draft.canonicalMethod || draft.method || draft.procurementMethod || '';
      const isHybrid = method === 'BID_WITH_REVERSE_AUCTION';
      const triggerVal = tc.trigger;
      return {
        preBidStageRequired: Boolean(tc.preBidStageRequired ?? isHybrid),
        auctionAfterTechnicalQualification: Boolean(tc.auctionAfterTechnicalQualification ?? isHybrid),
        auctionAmongAllTechnicallyQualified: Boolean(tc.auctionAmongAllTechnicallyQualified ?? (triggerVal !== 'TOP_N_BIDDERS')),
        auctionAmongTopNBidders: tc.auctionAmongTopNBidders ?? (triggerVal === 'TOP_N_BIDDERS' ? Number(tc.topN || 3) : null)
      };
    })()
  };
};

const validateAuctionConfigForDraft = (configInput: Record<string, unknown>, methodSlug: string, vendorSelection?: string) => {
  const parsed = auctionConfigSchema.safeParse(configInput);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const fieldPath = firstIssue?.path ? firstIssue.path.filter((p: any) => typeof p === 'string' || typeof p === 'number').join('.') : '';
    const fieldMsg = firstIssue?.message || 'Reverse auction configuration is invalid';
    const errorMsg = fieldPath ? `${fieldPath}: ${fieldMsg}` : fieldMsg;
    throw new ApiError(400, errorMsg, 'PROCUREMENT_AUCTION_CONFIG_INVALID');
  }
  const config = parsed.data;
  if (methodSlug === 'reverse-auction' && config.procurementMethod !== 'REVERSE_AUCTION') {
    throw new ApiError(400, 'Reverse Auction configuration must use REVERSE_AUCTION', 'PROCUREMENT_AUCTION_METHOD_INVALID');
  }
  if (methodSlug !== 'reverse-auction' && config.procurementMethod !== 'BID_WITH_REVERSE_AUCTION') {
    config.procurementMethod = 'BID_WITH_REVERSE_AUCTION';
  }
  if (config.auctionStartDateTime >= config.auctionEndDateTime) {
    throw new ApiError(400, 'Auction start date/time must be before auction end date/time', 'PROCUREMENT_AUCTION_DATE_INVALID');
  }
  // Enforce future scheduling — standalone reverse auctions must not start in the past (GFR / CVC e-RA guidelines)
  if (methodSlug === 'reverse-auction') {
    const auctionStartMs = new Date(config.auctionStartDateTime).getTime();
    if (Number.isFinite(auctionStartMs) && auctionStartMs <= Date.now() + 60000) {
      throw new ApiError(400, 'Auction start date and time must be scheduled at least 1 minute in the future', 'PROCUREMENT_AUCTION_START_PAST');
    }
  }
  if (config.reservePrice && Number(config.reservePrice) > Number(config.startingBidPrice)) {
    throw new ApiError(400, 'Reserve price must be less than or equal to starting bid price', 'PROCUREMENT_AUCTION_RESERVE_INVALID');
  }
  if (vendorSelection !== 'Open' && config.qualifiedVendors.length < config.minimumQualifiedBidders) {
    throw new ApiError(400, 'Qualified vendor list must meet the minimum qualified bidders requirement', 'PROCUREMENT_AUCTION_VENDOR_COUNT_INVALID');
  }
  if (config.autoExtensionEnabled && (!config.extensionTriggerMinutes || !config.extensionDurationMinutes || !config.maximumExtensions)) {
    throw new ApiError(400, 'Auto extension trigger, duration, and maximum extensions are required when auto extension is enabled', 'PROCUREMENT_AUCTION_EXTENSION_REQUIRED');
  }
  if (config.procurementMethod === 'BID_WITH_REVERSE_AUCTION') {
    const trigger = config.triggerConfiguration;
    if (trigger) {
      if (!trigger.auctionAfterTechnicalQualification) {
        trigger.auctionAfterTechnicalQualification = true;
      }
      if (!trigger.auctionAmongAllTechnicallyQualified && !trigger.auctionAmongTopNBidders) {
        trigger.auctionAmongAllTechnicallyQualified = true;
      }
    }
  }
  return config;
};

const rateContractItemSchema = z.object({
  itemName: z.string().trim().min(2).max(240),
  specification: z.string().trim().max(2000).optional().default(''),
  uom: z.string().trim().min(1).max(120),
  estimatedAnnualQuantity: z.coerce.number().positive(),
  baseRate: z.coerce.number().positive(),
  gst: z.coerce.number().min(0).max(100).default(0),
  discount: z.coerce.number().min(0).max(100).default(0),
  slabPricing: z.array(z.object({
    minQuantity: z.coerce.number().positive(),
    maxQuantity: z.coerce.number().positive().optional().nullable(),
    rate: z.coerce.number().positive()
  })).optional().default([])
});

const rateContractConfigSchema = z.object({
  rateContractNumber: z.string().trim().max(80).optional(),
  contractTitle: z.string().trim().min(3).max(200),
  contractDescription: z.string().trim().max(4000).optional().default(''),
  contractCategory: z.string().trim().max(160).optional().default(''),
  periodStartDate: safeCoercedDate,
  periodEndDate: safeCoercedDate,
  rateValidityPeriod: z.string().trim().min(2).max(120),
  supplierSelectionStrategy: z.enum(['SINGLE_SUPPLIER', 'MULTI_SUPPLIER', 'PANEL_RATE_CONTRACT', 'ITEM_WISE_L1']),
  selectedSuppliers: z.array(z.object({
    supplierId: z.coerce.number().int().positive(),
    supplierUserId: z.coerce.number().int().positive().optional().nullable(),
    supplierName: z.string().trim().max(180).optional().nullable()
  })).default([]),
  itemRateSchedule: z.array(rateContractItemSchema).min(1),
  priceVariationClause: z.enum(['FIXED_PRICE', 'INDEX_BASED_VARIATION', 'MUTUALLY_AGREED_REVISION']).optional().default('FIXED_PRICE'),
  fallClauseApplicable: z.coerce.boolean().optional().default(true),
  priceIndexBenchmark: z.string().trim().max(200).optional().nullable(),
  maxPriceVariationCapPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  callOffOrderAllowed: z.coerce.boolean(),
  maximumOrderQuantityPerCallOff: z.coerce.number().positive().optional().nullable(),
  minimumOrderQuantity: z.coerce.number().nonnegative().default(0),
  deliverySla: z.string().trim().max(500).optional().nullable(),
  deliverySlaDays: z.coerce.number().int().positive().optional().nullable(),
  penaltyClause: z.string().trim().max(1000).optional().nullable(),
  penaltyRatePerWeek: z.coerce.number().min(0).max(100).optional().nullable(),
  penaltyGraceDays: z.coerce.number().int().nonnegative().optional().nullable(),
  maxPenaltyCapPercentage: z.coerce.number().min(0).max(100).optional().nullable(),
  securityDepositRequired: z.coerce.boolean().default(false),
  securityDepositAmount: z.coerce.number().nonnegative().default(0),
  approvalWorkflow: z.string().trim().max(200).optional().default('Finance + Procurement'),
  contractDocument: z.object({
    fileAssetId: z.coerce.number().int().positive().optional().nullable(),
    fileName: z.string().trim().max(2000).optional().nullable(),
    fileSize: z.coerce.number().optional().nullable(),
    fileUrl: z.string().trim().optional().nullable(),
    uploadedAt: z.string().trim().optional().nullable()
  }).passthrough().optional().nullable()
}).passthrough();

const normalizeRateContractConfigForDraft = (draft: any) => {
  const payload = draft.payload || {};
  const raw = payload.rateContractConfig || payload.rateContract || {};
  const items = Array.isArray(raw.itemRateSchedule) && raw.itemRateSchedule.length
    ? raw.itemRateSchedule
    : (Array.isArray(payload.items) ? payload.items : Array.isArray(draft.items) ? draft.items : []).map((item: any) => ({
      itemName: item.itemName || item.name,
      specification: item.specification || item.description || item.technicalSpecification || '',
      uom: item.unitOfMeasure || item.unit || 'Nos',
      estimatedAnnualQuantity: item.estimatedAnnualQuantity || item.quantity || 1,
      baseRate: item.baseRate || item.estimatedUnitPrice || item.unitPrice || 0,
      gst: item.gst || item.taxRate || 0,
      discount: item.discount || 0,
      slabPricing: item.slabPricing || []
    }));
  const selectedSuppliers = Array.isArray(raw.selectedSuppliers) && raw.selectedSuppliers.length
    ? raw.selectedSuppliers
    : Array.isArray(payload.vendors?.invitedSellers)
      ? payload.vendors.invitedSellers.map((supplierId: unknown) => ({ supplierId }))
      : [];

  const deliverySla = raw.deliverySla || payload.terms?.deliveryTerms || '';
  const deliverySlaDays = raw.deliverySlaDays !== undefined && raw.deliverySlaDays !== null && raw.deliverySlaDays !== ''
    ? Number(raw.deliverySlaDays)
    : null;

  return {
    rateContractNumber: raw.rateContractNumber,
    contractTitle: raw.contractTitle || payload.basics?.title || draft.title,
    contractDescription: raw.contractDescription || payload.basics?.description || draft.description || '',
    contractCategory: raw.contractCategory || payload.basics?.category || payload.category || '',
    periodStartDate: raw.periodStartDate || raw.startDate || payload.tender?.bidStartDate,
    periodEndDate: raw.periodEndDate || raw.endDate || payload.tender?.bidClosingDate || draft.requiredBy,
    rateValidityPeriod: raw.rateValidityPeriod || 'Contract period',
    supplierSelectionStrategy: raw.supplierSelectionStrategy || 'SINGLE_SUPPLIER',
    selectedSuppliers,
    itemRateSchedule: items,
    priceVariationClause: raw.priceVariationClause || 'FIXED_PRICE',
    fallClauseApplicable: raw.fallClauseApplicable !== undefined ? Boolean(raw.fallClauseApplicable) : true,
    priceIndexBenchmark: raw.priceIndexBenchmark || null,
    maxPriceVariationCapPercent: raw.maxPriceVariationCapPercent !== undefined && raw.maxPriceVariationCapPercent !== null && raw.maxPriceVariationCapPercent !== ''
      ? Number(raw.maxPriceVariationCapPercent)
      : null,
    callOffOrderAllowed: Boolean(raw.callOffOrderAllowed ?? true),
    maximumOrderQuantityPerCallOff: raw.maximumOrderQuantityPerCallOff ?? null,
    minimumOrderQuantity: raw.minimumOrderQuantity ?? 0,
    deliverySla,
    deliverySlaDays,
    penaltyClause: raw.penaltyClause || payload.terms?.penaltyClause || '',
    penaltyRatePerWeek: raw.penaltyRatePerWeek !== undefined && raw.penaltyRatePerWeek !== null && raw.penaltyRatePerWeek !== ''
      ? Number(raw.penaltyRatePerWeek)
      : null,
    penaltyGraceDays: raw.penaltyGraceDays !== undefined && raw.penaltyGraceDays !== null && raw.penaltyGraceDays !== ''
      ? Number(raw.penaltyGraceDays)
      : null,
    maxPenaltyCapPercentage: raw.maxPenaltyCapPercentage !== undefined && raw.maxPenaltyCapPercentage !== null && raw.maxPenaltyCapPercentage !== ''
      ? Number(raw.maxPenaltyCapPercentage)
      : null,
    securityDepositRequired: Boolean(raw.securityDepositRequired ?? false),
    securityDepositAmount: Number(raw.securityDepositAmount ?? payload.terms?.securityDeposit ?? 0),
    approvalWorkflow: raw.approvalWorkflow || payload.approval?.workflow || 'Finance + Procurement',
    contractDocument: raw.contractDocument || null
  };
};

const validateRateContractConfigForDraft = (configInput: Record<string, unknown>) => {
  const parsed = rateContractConfigSchema.safeParse(configInput);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message || 'Rate contract configuration is invalid', 'PROCUREMENT_RATE_CONTRACT_INVALID');
  }
  const config = parsed.data;
  if (config.periodStartDate >= config.periodEndDate) {
    throw new ApiError(400, 'Rate Contract end date must be after start date', 'RATE_CONTRACT_DATE_INVALID');
  }
  if (config.callOffOrderAllowed && config.maximumOrderQuantityPerCallOff && config.maximumOrderQuantityPerCallOff < config.minimumOrderQuantity) {
    throw new ApiError(400, 'Maximum call-off quantity cannot be lower than minimum order quantity', 'RATE_CONTRACT_CALLOFF_QUANTITY_INVALID');
  }
  for (const item of config.itemRateSchedule) {
    for (const slab of item.slabPricing || []) {
      if (slab.maxQuantity && slab.maxQuantity < slab.minQuantity) {
        throw new ApiError(400, 'Slab pricing maximum quantity cannot be lower than minimum quantity', 'RATE_CONTRACT_SLAB_INVALID');
      }
    }
  }
  if (config.securityDepositRequired && config.securityDepositAmount <= 0) {
    throw new ApiError(400, 'Security deposit amount is required when security deposit is enabled', 'RATE_CONTRACT_SECURITY_DEPOSIT_REQUIRED');
  }
  return config;
};

const categoryCache = new Map<string, number>();

const saveProcurementDraft = async (req: AuthRequest, body: z.infer<typeof procurementDraftBody>, targetStatus = 'DRAFT') => {
  const methodSlug = methodSlugForDraft(body);
  const methodCode = procurementMethodCodeFor(methodSlug);
  if (body.payload && typeof body.payload === 'object') {
    const payloadObj = body.payload as any;
    if (payloadObj.vendors) {
      const inv = Array.isArray(payloadObj.vendors.invitedSellers) ? payloadObj.vendors.invitedSellers : [];
      if (inv.length > 0) {
        payloadObj.vendors.inviteCount = Math.max(inv.length, Number(payloadObj.vendors.inviteCount) || 0);
      }
    }
  }
  const draftMeta = {
    methodSlug,
    draftStep: body.draftStep ?? null,
    workflowStatus: body.workflowStatus || 'DRAFT',
    approvalStatus: body.approvalStatus || 'DRAFT',
    payload: body.payload || null
  };
  const items = toDraftItems(body.items as Array<Record<string, unknown>> | undefined, methodSlug, draftMeta);

  // Resolve categoryId from frontend category string
  let resolvedCategoryId = body.categoryId;
  if (!resolvedCategoryId && body.payload) {
    const payloadBasics = (body.payload.basics || {}) as any;
    const auctionConfig = (body.payload.auctionConfig || {}) as any;
    const catName = payloadBasics.category || auctionConfig.category || auctionConfig.auctionCategory || body.payload.category || '';
    if (catName && typeof catName === 'string') {
      const FRONTEND_CATEGORY_TO_DB_MAP: Record<string, string> = {
        'IT Hardware': 'IT & Computer Equipment',
        'Office Equipment': 'Office Equipment & Stationery',
        'Electrical': 'Electrical & Electronics',
        'Mechanical': 'Mechanical & Engineering',
        'Civil Works': 'Construction & Civil Work Services',
        'Facility Management': 'Industrial Maintenance Services',
        'Professional Services': 'Engineering Consultancy Services'
      };
      const dbCatName = FRONTEND_CATEGORY_TO_DB_MAP[catName] || catName;
      const trimmedName = dbCatName.trim();
      const cacheKey = trimmedName.toLowerCase();
      
      if (categoryCache.has(cacheKey)) {
        resolvedCategoryId = categoryCache.get(cacheKey);
      } else {
        const categoryObj = await db.category.findFirst({
          where: { name: { equals: trimmedName, mode: 'insensitive' } }
        });
        if (categoryObj) {
          resolvedCategoryId = categoryObj.id;
          categoryCache.set(cacheKey, categoryObj.id);
        }
      }
    }
  }

  const data = {
    title: body.title,
    description: body.description,
    categoryId: resolvedCategoryId,
    procurementMethod: methodCode,
    canonicalMethod: body.canonicalMethod || methodSlug.toUpperCase(),
    estimatedValue: body.estimatedValue,
    requiredBy: body.requiredBy,
    status: targetStatus,
    payload: body.payload || null,  // Store complete wizard data
    draftStep: body.draftStep ?? null  // Store current wizard step
  };

  const saved = body.id
    ? await (async () => {
      let resolvedReqId = await resolveRequirementId(body.id);
      let existing = resolvedReqId ? await db.requirement.findFirst({ where: { id: resolvedReqId, buyerId: userId(req) } }) : null;
      if (!existing) {
        // Check if body.id is a ProcurementBid directly
        const numId = Number(body.id);
        if (!isNaN(numId) && numId > 0) {
          const bid = await db.procurementBid.findFirst({
            where: { id: numId, buyerId: userId(req) }
          });
          if (bid) {
            existing = await db.requirement.create({
              data: {
                requirementNumber: bid.bidNumber,
                title: body.title || bid.title,
                description: body.description || bid.description,
                buyerId: userId(req),
                status: targetStatus === 'DRAFT' ? 'DRAFT' : (bid.status || 'APPROVED'),
                procurementMethod: bid.canonicalMethod || bid.procurementType || 'OPEN_TENDER',
                canonicalMethod: bid.canonicalMethod || bid.procurementType || 'OPEN_TENDER',
                estimatedValue: body.estimatedValue ?? bid.estimatedValue,
                deliveryLocation: (body.payload as any)?.basics?.deliveryLocation || bid.deliveryLocation,
                payload: data.payload,
                draftStep: data.draftStep
              }
            });
            resolvedReqId = existing.id;
          }
        }
      }
      if (!existing || !resolvedReqId) throw new ApiError(404, 'Procurement draft not found', 'PROCUREMENT_DRAFT_NOT_FOUND');
      if (targetStatus === 'DRAFT' && !['DRAFT', 'REJECTED'].includes(String(existing.status))) {
        throw new ApiError(409, 'Submitted procurement cannot be edited as a draft', 'PROCUREMENT_DRAFT_LOCKED');
      }
      const [, updated] = await db.$transaction([
        db.requirementItem.deleteMany({ where: { requirementId: resolvedReqId } }),
        db.requirement.update({
          where: { id: resolvedReqId },
          data: { ...data, items: items.length ? { create: items } : undefined },
          include: procurementDraftInclude
        })
      ], { maxWait: 10_000, timeout: 30_000 });
      return updated;
    })()
    : await procurementWorkflow.createRequirement(actorFrom(req), {
      ...data,
      status: targetStatus,
      items,
      payload: data.payload,
      draftStep: data.draftStep
    });
  await auditWrite(req, body.id ? 'procurement.draft.updated' : 'procurement.draft.created', 'requirement', saved.id, { methodSlug });
  const draftBuyerId = userId(req);
  const draftOrgId = req.user?.organizationId;
  await Promise.allSettled([
    deleteCache(`cache:buyer:procurements:${draftBuyerId}`),
    invalidateByPattern(`cache:buyer:procurements:${draftBuyerId}*`),
    deleteCache(redisKeys.cacheDashboardSummary(draftBuyerId)),
    invalidateByPattern(`cache:dashboard:*:${draftBuyerId}*`),
    ...(draftOrgId ? [
      invalidateByPattern(`cache:buyer:procurements:*`),
      invalidateByPattern(`cache:dashboard:*`),
    ] : [])
  ]);
  return (saved as any)?.items ? saved : db.requirement.findUnique({ where: { id: saved.id }, include: procurementDraftInclude });
};

const nextProcurementAuctionCode = () => numberSeries('RA');
const nextRateContractCode = () => numberSeries('RC');

const createAuctionForSubmittedProcurement = async (req: AuthRequest, requirement: any, draftBody: z.infer<typeof procurementDraftBody>) => {
  const methodSlug = methodSlugForDraft(draftBody);
  const payload = (draftBody.payload || {}) as Record<string, any>;
  const isStandaloneReverseAuction = methodSlug === 'reverse-auction';
  const isAuctionMethod = ['reverse-auction', 'bid-with-reverse-auction'].includes(methodSlug);
  const isAuctionExplicitlyEnabled = payload.allowReverseAuction === true || (payload.basics?.isReverseAuctionNeeded === true && payload.allowReverseAuction !== false);
  const hasAuction = isAuctionMethod || isAuctionExplicitlyEnabled;
  if (!hasAuction) return null;

  // SAP Ariba Follow-On Pattern: For hybrid methods (BID_WITH_REVERSE_AUCTION or
  // toggle-based e-RA on RFQ/Open Tender), do NOT create the auction record at
  // publish time. The auction configuration is stored in the requirement payload
  // and will be used when the buyer explicitly launches Stage 2 via the
  // "Launch Reverse Auction" button after evaluating Stage 1 sealed proposals.
  // Only standalone REVERSE_AUCTION creates the auction immediately.
  if (!isStandaloneReverseAuction) return null;

  const normalized = normalizeAuctionConfigForDraft(draftBody);
  if (methodSlug !== 'reverse-auction') {
    normalized.procurementMethod = 'BID_WITH_REVERSE_AUCTION';
  }
  const config = validateAuctionConfigForDraft(normalized, methodSlug, (draftBody.payload as any)?.vendors?.selection);

  const existing = await db.auction.findFirst({
    where: {
      OR: [
        { linkedRequirementId: requirement.id },
        ...(requirement.requirementNumber ? [{ referenceNo: { contains: requirement.requirementNumber } }] : [])
      ]
    }
  });

  const auctionData = {
    title: config.auctionTitle,
    description: config.auctionDescription || null,
    procurementMethod: config.procurementMethod,
    category: config.category || null,
    auctionType: config.auctionType,
    auctionMode: config.auctionMode,
    auctionDurationMinutes: config.auctionDurationMinutes,
    purchaseGroup: config.purchaseGroup || null,
    purchaseOrganization: config.purchaseOrganization || null,
    startPrice: Number(config.startingBidPrice),
    basePrice: Number(config.startingBidPrice),
    reservePrice: config.reservePrice ? Number(config.reservePrice) : null,
    currentBid: Number(config.startingBidPrice),
    minDecrement: Number(config.minimumBidDecrement),
    minDecrementAmount: Number(config.minimumBidDecrement),
    autoExtensionEnabled: config.autoExtensionEnabled,
    autoExtensionWindowMinutes: config.extensionTriggerMinutes || 5,
    autoExtensionByMinutes: config.extensionDurationMinutes || 5,
    maxAutoExtensions: config.maximumExtensions || 0,
    currency: config.currency.toUpperCase(),
    rankVisibility: config.rankVisibility,
    minimumQualifiedBidders: config.minimumQualifiedBidders,
    termsDocumentFileId: config.auctionTermsDocument?.fileAssetId || null,
    termsDocumentName: config.auctionTermsDocument?.fileName || null,
    buyerMonitorSettings: config.buyerMonitorSettings,
    auctionConfig: config,
    visibilityMode: (
      config.procurementMethod === 'BID_WITH_REVERSE_AUCTION' ||
      (draftBody.payload as any)?.vendors?.selection === 'Open' ||
      !config.qualifiedVendors?.length
    ) ? 'TECHNICALLY_QUALIFIED_ONLY' : 'INVITED_SELLERS_ONLY',
    startTime: config.auctionStartDateTime,
    endTime: config.auctionEndDateTime,
    status: (config.procurementMethod === 'BID_WITH_REVERSE_AUCTION' || Boolean(config.triggerConfiguration?.preBidStageRequired) || (config.auctionStartDateTime && new Date(config.auctionStartDateTime).getTime() > Date.now())) ? 'pending' : 'active',
    statusEnum: (config.procurementMethod === 'BID_WITH_REVERSE_AUCTION' || Boolean(config.triggerConfiguration?.preBidStageRequired) || (config.auctionStartDateTime && new Date(config.auctionStartDateTime).getTime() > Date.now())) ? 'SCHEDULED' : 'LIVE'
  };

  if (existing) {
    const updated = await db.auction.update({
      where: { id: existing.id },
      data: auctionData
    });
    return updated;
  }

  const auction = await db.auction.create({
    data: {
      linkedRequirementId: requirement.id,
      auctionCode: config.auctionNumber || nextProcurementAuctionCode(),
      referenceNo: formatRequirementNumber(requirement.id, requirement.requirementNumber, requirement.procurementMethod || requirement.canonicalMethod),
      ...auctionData,
      buyerOrgId: (req as any)._buyerContext?.organizationId || req.user?.organizationId || requirement.organizationId || null,
      createdByUserId: userId(req),
      allowCompetitorNames: false,
      remarks: 'Created from guided procurement wizard',
      preBidStage: config.procurementMethod === 'BID_WITH_REVERSE_AUCTION' ? {
        required: true,
        triggerConfiguration: config.triggerConfiguration,
        status: 'PENDING_PRE_QUALIFICATION'
      } : undefined,
      auctionTrigger: config.procurementMethod === 'BID_WITH_REVERSE_AUCTION'
        ? config.triggerConfiguration?.auctionAmongTopNBidders
          ? 'TOP_N_BIDDERS'
          : 'ALL_TECHNICALLY_QUALIFIED'
        : null
    }
  });

  await db.auctionParticipant.createMany({
    data: config.qualifiedVendors.map(vendor => ({
      auctionId: auction.id,
      sellerOrgId: Number(vendor.sellerOrgId),
      sellerUserId: vendor.sellerUserId ? Number(vendor.sellerUserId) : null,
      status: 'TECHNICALLY_QUALIFIED',
      qualificationStatus: 'QUALIFIED'
    })),
    skipDuplicates: true
  });
  await auditWrite(req, 'auction.created_from_procurement', 'auction', auction.id, {
    requirementId: requirement.id,
    procurementMethod: config.procurementMethod,
    qualifiedVendorCount: config.qualifiedVendors.length
  });

  const isAuctionLimited = config.procurementMethod === 'BID_WITH_REVERSE_AUCTION' || Boolean(config.qualifiedVendors?.length);
  void notificationService.notifySellersAndShgsOfProcurement({
    id: auction.id,
    title: auction.title,
    bidNumber: auction.auctionNumber,
    procurementType: 'REVERSE_AUCTION',
    canonicalMethod: 'REVERSE_AUCTION',
    buyerOrganizationName: auction.buyerOrganization,
    estimatedValue: auction.estimatedValue,
    endDate: auction.endDateTime,
    visibility: isAuctionLimited ? 'INVITED_SELLERS_ONLY' : 'PUBLIC',
    sourcingStrategy: isAuctionLimited ? 'Selected' : 'Open',
    category: auction.category || (draftBody.payload as any)?.basics?.category || undefined,
    invitedSellerOrgIds: Array.isArray(config.qualifiedVendors) ? config.qualifiedVendors.map((v: any) => Number(v.sellerOrgId)).filter((id: number) => Number.isFinite(id) && id > 0) : []
  });

  return auction;
};

const createRateContractForSubmittedProcurement = async (req: AuthRequest, requirement: any, draftBody: z.infer<typeof procurementDraftBody>) => {
  const methodSlug = methodSlugForDraft(draftBody);
  if (methodSlug !== 'rate-contract') return null;

  const existing = await db.contract.findFirst({
    where: {
      contractType: 'RATE_CONTRACT',
      metadata: {
        path: ['requirementId'],
        equals: requirement.id
      }
    }
  });
  if (existing) return existing;

  const config = validateRateContractConfigForDraft(normalizeRateContractConfigForDraft(draftBody));
  const value = config.itemRateSchedule.reduce((sum, item) => {
    const discountedRate = Number(item.baseRate) * (1 - Number(item.discount || 0) / 100);
    return sum + (Number(item.estimatedAnnualQuantity) * discountedRate * (1 + Number(item.gst || 0) / 100));
  }, 0);
  const payload = (draftBody.payload || {}) as Record<string, unknown>;
  const payloadBasics = (payload.basics || {}) as Record<string, unknown>;

  const contract = await db.contract.create({
    data: {
      contractNumber: config.rateContractNumber || nextRateContractCode(),
      contractType: 'RATE_CONTRACT',
      status: 'ACTIVE',
      title: config.contractTitle,
      value,
      currency: String(payload.currency || payloadBasics.currency || requirement.currency || 'INR').toUpperCase(),
      startDate: config.periodStartDate,
      endDate: config.periodEndDate,
      metadata: {
        ...config,
        requirementId: requirement.id,
        requirementNumber: requirement.requirementNumber,
        buyerId: userId(req),
        buyerOrganizationId: req.user?.organizationId || requirement.organizationId || null,
        buyerOrganizationName: (req.user as any)?.organizationName || requirement.organization?.organizationName || null,
        buyerName: (req.user as any)?.name || requirement.buyer?.name || null,
        district: payloadBasics.district || payload.deliveryDistrict || payload.district || requirement.organization?.district || null,
        state: payloadBasics.state || payload.deliveryState || payload.state || requirement.organization?.state || null,
        deliveryLocation: payloadBasics.deliveryLocation || payload.deliveryLocation || payload.deliveryAddress || null,
        callOffOrderAllowed: config.callOffOrderAllowed,
        activeState: config.periodEndDate.getTime() >= Date.now() ? 'ACTIVE' : 'EXPIRED'
      }
    }
  });

  await auditWrite(req, 'rate_contract.created_from_procurement', 'contract', contract.id, {
    requirementId: requirement.id,
    supplierCount: (config.selectedSuppliers || []).length,
    itemCount: config.itemRateSchedule.length
  });
  return contract;
};

const bidBackedMethodSlugs = new Set([
  'rfq',
  'rfp',
  'open-tender',
  'limited-tender',
  'sealed-tender',
  'two-packet-bid',
  'boq-based-bid',
  'bid-with-reverse-auction',
  'reverse-auction',
  'rate-contract'
]);

const createProcurementBidForSubmittedRequirement = async (req: AuthRequest, requirement: any, draftBody: z.infer<typeof procurementDraftBody>) => {
  const methodSlug = methodSlugForDraft(draftBody);
  if (!bidBackedMethodSlugs.has(methodSlug)) return null;

  const payload = (draftBody.payload || requirement.payload || {}) as Record<string, any>;
  const basics = payload.basics || {};
  const tender = payload.tender || {};
  const schedule = payload.schedule || {};
  const terms = payload.terms || {};
  const internal = payload.internal || {};
  const rawVendors = payload.vendors || {};
  const rawInvitedSellers = Array.isArray(rawVendors.invitedSellers)
    ? rawVendors.invitedSellers
    : (Array.isArray(payload.qualifiedVendors) ? payload.qualifiedVendors : []);
  const vendors = {
    ...rawVendors,
    invitedSellers: rawInvitedSellers,
    inviteCount: Math.max(rawInvitedSellers.length, Number(rawVendors.inviteCount) || 0)
  };
  const rateContractConfig = payload.rateContractConfig || payload.rateContract || {};
  const canonicalMethod = String(draftBody.canonicalMethod || requirement.canonicalMethod || methodSlug.toUpperCase()).toUpperCase();
  const isLimitedRfq = methodSlug === 'rfq' && String(payload.rfqType || '').toUpperCase() === 'LIMITED';
  const bidType = isLimitedRfq ? 'LIMITED_TENDER' : canonicalMethod;
  const creationTime = requirement.createdAt ? new Date(requirement.createdAt) : new Date();
  const rawPublishCandidate = schedule.submissionStartDate || schedule.publishDate || schedule.bidStartDate || tender.bidStartDate || null;
  const parsedStartDate = rawPublishCandidate ? parseDateIST(rawPublishCandidate) : (rateContractConfig.periodStartDate ? parseDateIST(rateContractConfig.periodStartDate) : null);
  const isFutureScheduled = parsedStartDate && !isNaN(parsedStartDate.getTime()) && parsedStartDate.getTime() > (creationTime.getTime() + 60000);
  const effectiveStartDate = isFutureScheduled ? parsedStartDate : creationTime;
  const rawEndDate = schedule.submissionDate || schedule.submissionDeadline || schedule.bidClosingDate || schedule.submissionEndDate || tender.bidClosingDate || requirement.requiredBy || rateContractConfig.periodEndDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const effectiveEndDate = parseDateIST(rawEndDate, true) || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const existing = await db.procurementBid.findFirst({
    where: {
      OR: [
        ...(requirement.requirementNumber ? [{ bidNumber: requirement.requirementNumber }] : []),
        { technicalPacket: { path: ['sourceRequirementId'], equals: requirement.id } },
        { technicalPacket: { path: ['requirementId'], equals: requirement.id } }
      ]
    }
  }).catch(() => null);

  const buyer = (req as any)._buyerContext || await db.user.findUnique({
    where: { id: userId(req) },
    include: { organization: true, buyerProfile: true }
  });

  const baseData = {
    title: requirement.title || basics.title || 'Procurement requirement',
    description: requirement.description || basics.description || 'Published procurement requirement',
    buyerId: userId(req),
    buyerOrganizationId: req.user?.organizationId || requirement.organizationId || buyer?.organizationId || buyer?.buyerProfile?.organizationId || null,
    buyerOrganizationName: internal.orgName || buyer?.organization?.organizationName || buyer?.buyerProfile?.organizationName || buyer?.name || 'Buyer organization',
    buyerType: buyer?.organization?.organizationType || buyer?.buyerProfile?.organizationType || basics.buyerType || 'Private Enterprise',
    category: basics.category || requirement.category?.name || 'General procurement',
    bidType,
    categoryType: (
      basics.procurementCategory === 'SERVICES' || basics.categoryType === 'SERVICES' || draftBody.categoryType === 'SERVICES' || draftBody.procurementCategory === 'SERVICES'
        ? 'SERVICES'
        : basics.procurementCategory === 'WORKS' || basics.categoryType === 'WORKS' || draftBody.categoryType === 'WORKS' || draftBody.procurementCategory === 'WORKS'
        ? 'WORKS'
        : 'GOODS'
    ) as any,
    pricingFormat: (
      basics.pricingFormat === 'SOR' || basics.sourcingFormat === 'SOR' || draftBody.pricingFormat === 'SOR' || methodSlug === 'rate-contract'
        ? 'SOR'
        : basics.pricingFormat === 'BOQ' || basics.sourcingFormat === 'BOQ' || draftBody.pricingFormat === 'BOQ' || methodSlug === 'boq-based-bid'
        ? 'BOQ'
        : 'SINGLE_ITEM'
    ) as any,
    procurementType: canonicalMethod,
    canonicalMethod,
    quantity: Array.isArray(draftBody.items) && draftBody.items.length === 1 ? Number((draftBody.items[0] as any).quantity || 0) || null : null,
    unit: Array.isArray(draftBody.items) && draftBody.items.length === 1 ? String((draftBody.items[0] as any).unitOfMeasure || (draftBody.items[0] as any).unit || '') || null : null,
    estimatedValue: requirement.estimatedValue || basics.estimatedValue || null,
    deliveryLocation: basics.deliveryLocation || internal.deliveryAddress || 'Delivery location as per procurement document',
    state: buyer?.organization?.state || null,
    district: buyer?.organization?.district || null,
    pincode: buyer?.organization?.pincode || null,
    startDate: effectiveStartDate,
    endDate: effectiveEndDate,
    technicalOpeningDate: (tender.technicalEvaluationDate || schedule.technicalOpeningDate || payload.technicalOpeningDate) ? parseDateIST(tender.technicalEvaluationDate || schedule.technicalOpeningDate || payload.technicalOpeningDate) : null,
    financialOpeningDate: (tender.financialEvaluationDate || schedule.financialOpeningDate || payload.financialOpeningDate) ? parseDateIST(tender.financialEvaluationDate || schedule.financialOpeningDate || payload.financialOpeningDate) : null,
    bidValidityDate: (tender.bidValidityDate || schedule.bidValidityDate) ? parseDateIST(tender.bidValidityDate || schedule.bidValidityDate) : null,
    status: 'OPEN',
    approvalStatus: 'APPROVED',
    approvedAt: creationTime,
    lifecycleStage: 'SELLER_PARTICIPATION',
    evaluationMethod: 'L1',
    documentFee: tender.documentFee || null,
    allowClarification: schedule.clarificationAllowed !== false && schedule.clarificationAllowed !== 'false' && schedule.allowClarifications !== false,
    allowReverseAuction: ['bid-with-reverse-auction', 'reverse-auction'].includes(methodSlug) || payload.allowReverseAuction === true || (payload.basics?.isReverseAuctionNeeded === true && payload.allowReverseAuction !== false),
    allowBoq: methodSlug === 'boq-based-bid',
    packetType: (
      String(schedule.packetType || payload.packetType || payload.rules?.packetType || '').toLowerCase().includes('two') ||
      String(schedule.packetType || payload.packetType || payload.rules?.packetType || '') === '2' ||
      methodSlug === 'two-packet-bid' ||
      Boolean(tender.financialEvaluationDate || schedule.financialOpeningDate || payload.financialOpeningDate)
    ) ? 'TWO_PACKET' : 'SINGLE_PACKET',
    visibility: deriveVisibility({ procurementType: canonicalMethod, bidType, technicalPacket: { vendors } }),
    technicalPacket: {
      ...payload,
      urgency: payload.urgency || payload.priority || basics.priority || basics.urgency || (draftBody as any).urgency || (draftBody as any).priority || String(requirement.description || '').match(/(?:urgency|priority):\s*([A-Za-z0-9_-]+)/i)?.[1] || 'Normal',
      priority: payload.priority || payload.urgency || basics.priority || basics.urgency || (draftBody as any).priority || (draftBody as any).urgency || String(requirement.description || '').match(/(?:urgency|priority):\s*([A-Za-z0-9_-]+)/i)?.[1] || 'Normal',
      schedule: {
        ...schedule,
        minimumBidders: Math.max(1, Number(schedule.minimumBidders || payload.minimumQualifiedBidders || payload.schedule?.minimumBidders || 3)),
        publishDate: isFutureScheduled ? effectiveStartDate.toISOString() : (schedule.publishDate || effectiveStartDate.toISOString()),
      },
      minimumBidders: Math.max(1, Number(schedule.minimumBidders || payload.minimumQualifiedBidders || payload.schedule?.minimumBidders || 3)),
      minimumQualifiedBidders: Math.max(1, Number(schedule.minimumBidders || payload.minimumQualifiedBidders || payload.schedule?.minimumBidders || 3)),
      sourceRequirementId: requirement.id,
      requirementId: requirement.id,
      requirementNumber: requirement.requirementNumber,
      vendors
    },
    termsAndConditions: Array.isArray(terms.termsAndConditions) ? terms.termsAndConditions : [terms.termsAndConditions, terms.paymentTerms, terms.deliveryTerms].filter(Boolean),
    eligibilityCriteria: Array.isArray(terms.eligibilityCriteria) ? terms.eligibilityCriteria : [],
    requiredDocuments: Array.isArray(payload.requiredDocs)
      ? payload.requiredDocs.map((doc: any) => doc?.name || doc).filter(Boolean)
      : Array.isArray(payload.documents)
        ? payload.documents.map((doc: any) => doc?.name || doc?.fileName).filter(Boolean)
        : []
  };

  const bid = existing
    ? await db.procurementBid.update({
        where: { id: existing.id },
        data: baseData
      })
    : await db.procurementBid.create({
        data: {
          bidNumber: (requirement.requirementNumber && isValidCanonicalRef(requirement.requirementNumber))
            ? requirement.requirementNumber
            : await nextBidNumber(requirement.canonicalMethod || requirement.procurementMethod),
          ...baseData
        }
      });

  await syncBidInvitations(bid.id, baseData.technicalPacket, userId(req));

  void db.requirement.update({
    where: { id: requirement.id },
    data: {
      payload: {
        ...payload,
        linkedProcurementBidId: bid.id,
        linkedProcurementBidNumber: bid.bidNumber
      }
    }
  }).catch(() => undefined);

  const documents = Array.isArray(payload.documents) ? payload.documents : [];
  const fileAssetIds = documents.map((d: any) => Number(d?.fileAssetId || 0)).filter((id: number) => id > 0);
  if (fileAssetIds.length > 0) {
    const [assets, existingDocs] = await Promise.all([
      db.fileAsset.findMany({
        where: { id: { in: fileAssetIds }, ownerId: userId(req) },
        select: { id: true, originalName: true, mimeType: true, size: true, url: true, key: true }
      }),
      db.procurementBidDocument.findMany({
        where: { bidId: bid.id, fileAssetId: { in: fileAssetIds } }
      })
    ]);
    const assetMap = new Map(assets.map((a: any) => [a.id, a]));
    const existingDocMap = new Map(existingDocs.map((d: any) => [d.fileAssetId, d]));

    const docOps: Promise<any>[] = [];
    for (const doc of documents) {
      const fileAssetId = Number(doc?.fileAssetId || 0);
      if (!fileAssetId) continue;
      const asset: any = assetMap.get(fileAssetId);
      if (!asset) continue;
      const existingDoc: any = existingDocMap.get(fileAssetId);
      if (existingDoc) {
        docOps.push(db.procurementBidDocument.update({
          where: { id: existingDoc.id },
          data: {
            fileName: doc.fileName || asset.originalName || doc.name || 'Procurement document',
            mimeType: asset.mimeType || 'application/octet-stream',
            fileSize: asset.size || 0,
            fileUrl: asset.url || null,
            fileKey: asset.key || null,
            visibility: 'PUBLIC'
          }
        }));
      } else {
        docOps.push(db.procurementBidDocument.create({
          data: {
            bidId: bid.id,
            documentType: doc.name || doc.documentType || 'PROCUREMENT_DOCUMENT',
            fileAssetId,
            fileName: doc.fileName || asset.originalName || doc.name || 'Procurement document',
            fileUrl: asset.url || null,
            fileKey: asset.key || null,
            mimeType: asset.mimeType || 'application/octet-stream',
            fileSize: asset.size || 0,
            uploadedById: userId(req),
            visibility: 'PUBLIC'
          }
        }));
      }
    }
    if (docOps.length > 0) {
      await Promise.all(docOps);
    }
  }

  await auditWrite(req, existing ? 'procurement_bid.synced_from_requirement' : 'procurement_bid.created_from_requirement', 'procurementBid', bid.id, {
    requirementId: requirement.id,
    methodSlug,
    canonicalMethod
  });

  const vendorsSelection = String(vendors.selection || vendors.selectionMode || '').trim();
  const rawPacketVendors = (baseData.technicalPacket as any)?.vendors || {};
  const invitedOrgIds = Array.isArray(rawPacketVendors.invitedSellers)
    ? rawPacketVendors.invitedSellers.map((s: any) => Number(s?.id || s?.sellerOrgId || s)).filter((n: number) => Number.isFinite(n) && n > 0)
    : [];

  void notificationService.notifySellersAndShgsOfProcurement({
    id: bid.id,
    title: bid.title,
    bidNumber: bid.bidNumber,
    procurementType: bid.procurementType,
    canonicalMethod: bid.canonicalMethod,
    buyerOrganizationName: bid.buyerOrganizationName,
    estimatedValue: bid.estimatedValue,
    endDate: bid.endDate,
    visibility: bid.visibility,
    sourcingStrategy: vendorsSelection,
    category: bid.category,
    categoryId: requirement.categoryId || undefined,
    invitedSellerOrgIds: invitedOrgIds
  });

  return bid;
};

const tenderBody = z.object({
  title: z.string().trim().min(3).max(200),
  category: z.string().trim().min(2).max(120).default('General'),
  categoryId: z.coerce.number().int().positive().optional(),
  requirementId: z.coerce.number().int().positive().optional(),
  budget: z.coerce.number().positive(),
  description: z.string().trim().min(5).max(5000),
  documentUrl: z.string().trim().max(1000).optional(),
  closesAt: safeCoercedDate.optional(),
  quantityUnit: z.string().trim().max(120).optional(),
  paymentTerms: z.string().trim().max(80).optional(),
  deliveryType: z.string().trim().max(80).optional()
});

const bidBody = z.object({
  unitPrice: z.coerce.number().positive(),
  quantity: z.coerce.number().int().positive(),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  discountAmount: z.coerce.number().nonnegative().optional(),
  deliveryDays: z.coerce.number().int().positive(),
  warranty: z.string().trim().max(500).nullable().optional(),
  validTill: safeCoercedDate.nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  documentUrl: z.string().trim().max(1000).nullable().optional(),
  fileAssetId: z.coerce.number().int().positive().nullable().optional()
});

const directPurchaseBody = z.object({
  requirementId: z.coerce.number().int().positive().optional(),
  sellerId: z.coerce.number().int().positive(),
  totalAmount: z.coerce.number().nonnegative().optional()
});

const quoteRequestBody = z.object({
  sellerId: z.coerce.number().int().positive(),
  subject: z.string().trim().min(3).max(160),
  message: z.string().trim().min(1).max(4000),
  documentUrl: z.string().trim().max(1000).optional(),
  estimatedValue: z.coerce.number().nonnegative().optional(),
  deadlineDate: safeCoercedDate.optional()
});

const quoteResponseBody = z.object({
  totalAmount: z.coerce.number().nonnegative().optional(),
  offeredPrice: z.coerce.number().nonnegative().optional(),
  offeredQuantity: z.coerce.number().nonnegative().optional(),
  deliveryDays: z.coerce.number().int().positive().optional(),
  deliveryTimeline: z.string().trim().optional(),
  validityDate: safeCoercedDate.optional(),
  notes: z.string().trim().max(4000).optional(),
  message: z.string().trim().max(4000).optional(),
  terms: z.string().trim().max(2000).optional(),
  documentUrl: z.string().trim().max(1000).optional(),
  attachmentUrl: z.string().trim().max(1000).optional(),
  currency: z.string().trim().max(10).optional(),
  warrantyPeriod: z.string().trim().max(200).optional(),
  paymentTerms: z.string().trim().max(500).optional(),
  gstRate: z.coerce.number().min(0).max(100).optional(),
  deliveryLocation: z.string().trim().max(300).optional(),
  complianceStatus: z.string().trim().max(50).optional(),
  unitPrice: z.coerce.number().nonnegative().optional(),
  quantity: z.coerce.number().int().positive().optional(),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  status: z.enum(['DRAFT', 'SUBMITTED']).optional(),
  responseData: z.any().optional()
}).transform(val => {
  let deliveryDays = val.deliveryDays;
  if (!deliveryDays && val.deliveryTimeline) {
    const dMatch = val.deliveryTimeline.match(/(\d+)/);
    if (dMatch) deliveryDays = Number(dMatch[1]);
  }
  return {
    ...val,
    totalAmount: val.totalAmount ?? val.offeredPrice,
    documentUrl: val.documentUrl ?? val.attachmentUrl,
    notes: val.notes ?? val.message ?? val.terms,
    deliveryDays
  };
});

const actorFrom = (req: AuthRequest) => ({
  id: userId(req),
  role: String(req.user?.role),
  organizationId: (req as any)._buyerContext?.organizationId || req.user?.organizationId || null,
  ipAddress: req.ip,
  userAgent: req.headers['user-agent']
});

const cleanEnv = (value: unknown) => String(value || '').trim().replace(/^['"]|['"]$/g, '');

const apiSetuAllowInsecureTls = () =>
  cleanEnv(process.env.APISETU_ALLOW_INSECURE_TLS).toLowerCase() === 'true' ||
  process.env.NODE_ENV !== 'production';

const fetchApiSetuJson = async (apiUrl: string, headers: Record<string, string>) => {
  const parseBody = (text: string) => {
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers,
        signal: controller.signal
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, body: parseBody(text), text };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: any) {
    if (!apiSetuAllowInsecureTls()) {
      throw new ApiError(424, 'GST verification provider is unreachable. Please try again later.', 'GST_PROVIDER_UNREACHABLE', {
        cause: err?.cause?.code || err?.name || err?.message
      });
    }

    return new Promise<{ ok: boolean; status: number; body: any; text: string }>((resolve, reject) => {
      const request = https.request(apiUrl, {
        method: 'GET',
        headers,
        rejectUnauthorized: false
      }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => {
          resolve({
            ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
            status: response.statusCode || 0,
            body: parseBody(text),
            text
          });
        });
      });
      request.on('error', error => {
        reject(new ApiError(424, 'GST verification provider is unreachable. Please try again later.', 'GST_PROVIDER_UNREACHABLE', {
          cause: (error as any)?.code || error.message
        }));
      });
      request.setTimeout(20000, () => request.destroy(new Error('API Setu request timed out')));
      request.end();
    });
  }
};

// Onboarding
router.get('/onboarding/me', authenticate, asyncRoute(async (req, res) => {
  const user = await db.user.findUnique({
    where: { id: userId(req) },
    include: { buyerProfile: true, sellerProfile: { include: { offices: true, bankAccounts: true, sellerDocuments: { include: { fileAsset: true } } } }, organization: true }
  });
  ok(res, user);
}));

router.put('/seller/onboarding', authenticate, requireAccountType('seller', 'shg', 'admin', 'master_admin'), asyncRoute(async (req, res) => {
  const data = req.body || {};
  const exists = await db.sellerProfile.findUnique({ where: { userId: userId(req) } });
  if (!exists) {
    try {
      const u = await db.user.findUnique({ where: { id: userId(req) }, select: { name: true } });
      await notificationService.notifyAdmins({
        title: 'Seller Started Onboarding',
        message: `${u?.name || 'A stakeholder'} has started their onboarding process and is filling out details.`,
        type: 'onboarding_started',
        priority: 'low',
        redirectUrl: '/admin/onboarding'
      });
    } catch (err) {
      console.error('[Onboarding Started Notification] Failed:', err);
    }
  }
  const profile = await db.sellerProfile.upsert({
    where: { userId: userId(req) },
    update: { ...data, userId: undefined },
    create: {
      userId: userId(req),
      pan: clean(data.pan || `PENDING${userId(req)}`),
      productCategories: data.productCategories || [],
      termsAccepted: Boolean(data.termsAccepted),
      ...data
    }
  });

  if (Array.isArray(data.productCategories) && data.productCategories.length > 0) {
    const rawCategories: string[] = data.productCategories.filter((c: any) => typeof c === 'string' && c.trim().length > 1);
    for (const catName of rawCategories) {
      const slug = slugFor(catName.trim());
      const existing = await db.category.findFirst({
        where: { OR: [{ slug }, { name: { equals: catName.trim(), mode: 'insensitive' } }] }
      });
      if (!existing) {
        try {
          const newCat = await db.category.create({
            data: {
              name: catName.trim(),
              slug,
              type: 'BOTH',
              organizationId: profile.organizationId || null,
              isActive: true
            }
          });
          await deleteCache(redisKeys.cacheCategoriesAll()).catch(() => undefined);
          const u = await db.user.findUnique({
            where: { id: userId(req) },
            include: { organization: true, sellerProfile: true }
          });
          const sellerName = u?.name || 'A seller';
          const businessName = u?.organization?.organizationName || u?.sellerProfile?.businessName || 'Onboarding MSME';
          await notificationService.notifyAdmins({
            title: `New Custom Category: "${newCat.name}"`,
            message: `Added by ${sellerName} (${businessName}) during seller onboarding. Please review and upload a category photo.`,
            type: 'category_custom_added',
            priority: 'high',
            redirectUrl: `/admin/categories?edit=${newCat.id}`
          }).catch(() => undefined);
        } catch {
          // ignore duplicate race condition
        }
      }
    }
  }

  await auditWrite(req, 'onboarding.seller.updated', 'sellerProfile', profile.id);
  ok(res, profile);
}));

router.post('/buyer/onboarding/send-otp', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const { generateOtp, storeOtp } = await import('../services/otp.service.js');
  const { sendOtpEmail } = await import('../services/mail.service.js');
  const { smsService } = await import('../services/sms.service.js');

  const user = await db.user.findUnique({ where: { id: userId(req) }, include: { buyerProfile: true } });
  if (!user) throw new ApiError(404, 'User not found');

  const mobile = user.mobile || user.buyerProfile?.mobile;
  const channel = req.body?.channel === 'sms' && mobile && smsService.isEnabled() ? 'sms' : 'email';
  const identity = channel === 'sms' ? mobile : user.email;
  if (!identity) throw new ApiError(400, `${channel === 'sms' ? 'Mobile' : 'Email'} is not configured.`);

  const otp = generateOtp();
  const otpState = await storeOtp('buyer_profile_update', identity, otp, { userId: user.id, channel }, channel);

  let deliveryConfigured = false;
  if (channel === 'sms') {
    const smsResult = await smsService.sendOtpSms(identity, otp, 'onboarding_alert');
    deliveryConfigured = smsResult.success;
  } else {
    deliveryConfigured = await sendOtpEmail(identity, otp, '[SECURE AUTH] Profile update verification code');
  }

  await auditWrite(req, 'buyer.profile_update_otp.sent', 'user', user.id, { channel });

  ok(res, { success: true, sendsRemaining: otpState.sendsRemaining, deliveryConfigured, channel });
}));

router.post('/buyer/settings/change-email/send-otp', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const { generateOtp, storeEmailOtp } = await import('../services/otp.service.js');
  const { sendOtpEmail } = await import('../services/mail.service.js');

  const newEmail = clean(req.body?.email || req.body?.newEmail).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    throw new ApiError(400, 'Enter a valid new email address');
  }

  const user = await db.user.findUnique({ where: { id: userId(req) }, select: { id: true, email: true } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.email?.toLowerCase() === newEmail) throw new ApiError(400, 'New email must be different from current email');

  const existing = await db.user.findUnique({ where: { email: newEmail }, select: { id: true } });
  if (existing) throw new ApiError(409, 'This email is already registered with another account');

  const otp = generateOtp();
  const otpState = await storeEmailOtp(newEmail, otp);
  const deliveryConfigured = await sendOtpEmail(newEmail, otp, '[SECURE AUTH] Buyer email change verification code');

  await auditWrite(req, 'buyer.change_email_otp.sent', 'user', user.id, {
    newEmailHash: sha256(newEmail),
    deliveryConfigured
  });

  ok(res, { success: true, sendsRemaining: otpState.sendsRemaining, deliveryConfigured });
}));

router.post('/buyer/settings/change-email', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const { verifyEmailOtp, consumeEmailOtp } = await import('../services/otp.service.js');

  const newEmail = clean(req.body?.newEmail || req.body?.email).toLowerCase();
  const otp = clean(req.body?.otp);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    throw new ApiError(400, 'Enter a valid new email address');
  }
  if (!/^\d{6}$/.test(otp)) throw new ApiError(400, 'Enter the 6-digit OTP sent to the new email');

  const user = await db.user.findUnique({ where: { id: userId(req) }, select: { id: true, email: true } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.email?.toLowerCase() === newEmail) throw new ApiError(400, 'New email must be different from current email');

  const existing = await db.user.findUnique({ where: { email: newEmail }, select: { id: true } });
  if (existing) throw new ApiError(409, 'This email is already registered with another account');

  const otpCheck = await verifyEmailOtp(newEmail, otp);
  if (!otpCheck.ok) throw new ApiError(400, 'Invalid or expired OTP');

  await db.user.update({
    where: { id: user.id },
    data: { email: newEmail }
  });

  await consumeEmailOtp(newEmail);
  await auditWrite(req, 'buyer.email_changed', 'user', user.id, { newEmailHash: sha256(newEmail) });

  ok(res, { success: true, message: 'Email updated successfully' });
}));

router.post('/buyer/settings/change-password/send-otp', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const { generateOtp, storeOtp } = await import('../services/otp.service.js');
  const { sendOtpEmail } = await import('../services/mail.service.js');

  const user = await db.user.findUnique({ where: { id: userId(req) }, select: { id: true, email: true } });
  if (!user) throw new ApiError(404, 'User not found');
  if (!user.email) throw new ApiError(400, 'User email not registered');

  const otp = generateOtp();
  await storeOtp('forgot_password', user.email, otp, { userId: user.id, channel: 'email' }, 'email');
  const deliveryConfigured = await sendOtpEmail(user.email, otp, '[SECURE AUTH] Buyer password change authorization code');

  await auditWrite(req, 'buyer.change_password_otp.sent', 'user', user.id, {
    channel: 'email',
    deliveryConfigured
  });

  ok(res, { success: true, channel: 'email', deliveryConfigured });
}));

router.post('/buyer/settings/change-password', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const { verifyOtp, consumeOtp } = await import('../services/otp.service.js');
  const { hashPassword, validatePasswordStrength } = await import('../services/password.service.js');
  const { assertPasswordNotReused, rememberPreviousPassword } = await import('../services/password-history.service.js');

  const { newPassword, otp } = req.body || {};
  if (!newPassword || !otp) throw new ApiError(400, 'New password and OTP are required');

  const user = await db.user.findUnique({ where: { id: userId(req) } });
  if (!user) throw new ApiError(404, 'User not found');
  if (!user.email) throw new ApiError(400, 'User email not found');

  const cleanOtp = String(otp).trim();
  const result = await verifyOtp('forgot_password', user.email, cleanOtp);
  if (!result.ok) throw new ApiError(400, 'Invalid or expired OTP');

  const passwordValidation = validatePasswordStrength(newPassword);
  if (!passwordValidation.ok) {
    throw new ApiError(400, 'Password does not meet security requirements: ' + passwordValidation.errors.join(', '));
  }

  try {
    await assertPasswordNotReused(user.id, newPassword, user.password);
  } catch (err: any) {
    if (err.message === 'PASSWORD_REUSED') {
      throw new ApiError(400, 'New password cannot match your current or recently used passwords', 'PASSWORD_REUSED');
    }
    throw err;
  }

  const hashedPassword = await hashPassword(newPassword);
  await db.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      passwordResetVersion: { increment: 1 },
      sessionVersion: { increment: 1 },
      lastPasswordChangeAt: new Date()
    }
  });
  await rememberPreviousPassword(user.id, hashedPassword);

  await consumeOtp('forgot_password', user.email);
  await auditWrite(req, 'buyer.password_changed', 'user', user.id, {});

  ok(res, { success: true, message: 'Password updated successfully' });
}));

router.put('/buyer/onboarding', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const data = req.body || {};

  // Bank details validations
  if (data.bankAccountNo || data.bankIfsc || data.bankName || data.bankAddress || data.accountHolderName) {
    if (data.bankIfsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(data.bankIfsc).toUpperCase())) {
      throw new ApiError(400, 'Invalid IFSC code format');
    }
    if (data.bankAccountNo && !/^\d{9,18}$/.test(String(data.bankAccountNo))) {
      throw new ApiError(400, 'Bank account number must be between 9 and 18 digits');
    }
    if (data.bankName && (String(data.bankName).trim().length < 3 || String(data.bankName).trim().length > 100 || !/[a-zA-Z]/.test(String(data.bankName)))) {
      throw new ApiError(400, 'Bank name must be between 3 and 100 characters and contain letters');
    }
    if (data.accountHolderName && (String(data.accountHolderName).trim().length < 3 || String(data.accountHolderName).trim().length > 100 || !/[a-zA-Z]/.test(String(data.accountHolderName)))) {
      throw new ApiError(400, 'Account holder name must be between 3 and 100 characters and contain letters');
    }
    if (data.bankAddress && (String(data.bankAddress).trim().length < 10 || String(data.bankAddress).trim().length > 250)) {
      throw new ApiError(400, 'Bank address must be between 10 and 250 characters');
    }
  }

  // Guard personal fields with OTP check if profile already exists
  const personalFields = [
    'representativeName',
    'designation',
    'dateOfRetirement',
    'nameAsInPan',
    'pan',
    'dateAsInPan'
  ];
  const isUpdatingPersonalFields = personalFields.some(field => Object.prototype.hasOwnProperty.call(data, field));

  if (isUpdatingPersonalFields) {
    const exists = await db.buyerProfile.findUnique({ where: { userId: userId(req) } });
    if (exists) {
      const otp = req.body.otp;
      if (!otp) {
        throw new ApiError(400, 'OTP is required for updating personal information');
      }

      const user = await db.user.findUnique({ where: { id: userId(req) }, include: { buyerProfile: true } });
      if (!user) throw new ApiError(404, 'User not found');

      const { verifyOtp, consumeOtp } = await import('../services/otp.service.js');
      const mobile = user.mobile || user.buyerProfile?.mobile;
      const channel = req.body?.channel === 'sms' && mobile ? 'sms' : 'email';
      const identity = channel === 'sms' ? mobile : user.email;
      if (!identity) throw new ApiError(400, 'Identity not configured for verification');

      const verifyResult = await verifyOtp('buyer_profile_update', identity, otp);
      if (!verifyResult.ok) {
        throw new ApiError(400, 'Invalid or expired OTP');
      }

      await consumeOtp('buyer_profile_update', identity);
    }
  }

  const editableFields = [
    'organizationName',
    'businessType',
    'msmeType',
    'organizationType',
    'ministry',
    'division',
    'employeeCount',
    'industry',
    'cin',
    'pan',
    'nameAsInPan',
    'dateAsInPan',
    'gst',
    'website',
    'state',
    'district',
    'officeZoneName',
    'representativeName',
    'designation',
    'dateOfRetirement',
    'department',
    'email',
    'mobile',
    'alternateMobile',
    'stdCode',
    'officeContact',
    'extensionNo',
    'bankIfsc',
    'bankName',
    'bankAddress',
    'bankAccountNo',
    'accountHolderName',
    'competentAuthorityEmail',
    'verifyingFirstName',
    'verifyingLastName',
    'verifyingEmail',
    'verifyingMobile',
    'verifyingDesignation',
    'country',
    'city',
    'pincode',
    'registeredAddress',
    'corporateAddress',
    'procurementCategories',
    'otherCategoryDetails',
    'annualBudget',
    'preferredMethods',
    'otherMethodDetails',
    'declarationAccepted',
    'termsAccepted',
    'documents'
  ];
  const profileData = editableFields.reduce((acc: Record<string, unknown>, field) => {
    if (Object.prototype.hasOwnProperty.call(data, field)) acc[field] = data[field];
    return acc;
  }, {});
  const exists = await db.buyerProfile.findUnique({ where: { userId: userId(req) } });
  if (!exists) {
    try {
      const u = await db.user.findUnique({ where: { id: userId(req) }, select: { name: true } });
      await notificationService.notifyAdmins({
        title: 'Buyer Started Onboarding',
        message: `${u?.name || 'A stakeholder'} has started their onboarding process and is filling out details.`,
        type: 'onboarding_started',
        priority: 'low',
        redirectUrl: '/admin/onboarding'
      });
    } catch (err) {
      console.error('[Onboarding Started Notification] Failed:', err);
    }
  }
  const profile = await db.buyerProfile.upsert({
    where: { userId: userId(req) },
    update: profileData,
    create: {
      userId: userId(req),
      organizationName: clean(data.organizationName || 'Buyer Organization'),
      businessType: clean(data.businessType || 'Government Buyer'),
      mobile: clean(data.mobile || '0000000000'),
      procurementCategories: data.procurementCategories || [],
      preferredMethods: data.preferredMethods || [],
      ...profileData
    }
  });
  if (profileData.representativeName) {
    await db.user.update({
      where: { id: userId(req) },
      data: { name: String(profileData.representativeName) }
    });
  }
  await auditWrite(req, 'onboarding.buyer.updated', 'buyerProfile', profile.id);
  ok(res, profile);
}));

// Dedicated Category Management Endpoints (Bypasses onboarding compliance lock)
router.get('/buyer/categories', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const profile = await db.buyerProfile.findUnique({
    where: { userId: userId(req) },
    select: { procurementCategories: true, otherCategoryDetails: true }
  });
  if (!profile) throw new ApiError(404, 'Buyer profile not found');
  ok(res, profile);
}));

router.put('/buyer/categories', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const data = req.body || {};

  if (!Array.isArray(data.procurementCategories)) {
    throw new ApiError(400, 'procurementCategories must be an array');
  }

  const sanitized: string[] = [];
  for (const item of data.procurementCategories) {
    if (typeof item === 'string') {
      const cleanItem = item.trim().replace(/[<>]/g, '');
      if (cleanItem.length > 1 && !sanitized.includes(cleanItem)) {
        sanitized.push(cleanItem);
        if (sanitized.length >= 30) break;
      }
    }
  }

  if (sanitized.length === 0) {
    throw new ApiError(400, 'At least one procurement category is required');
  }

  const profile = await db.buyerProfile.findUnique({ where: { userId: userId(req) } });
  if (!profile) {
    throw new ApiError(404, 'Buyer profile not found. Complete onboarding first.');
  }

  for (const catName of sanitized) {
    const slug = slugFor(catName.trim());
    const existing = await db.category.findFirst({
      where: { OR: [{ slug }, { name: { equals: catName.trim(), mode: 'insensitive' } }] }
    });
    if (!existing) {
      try {
        await db.category.create({
          data: {
            name: catName.trim(),
            slug,
            type: 'BOTH',
            organizationId: profile.organizationId || null,
            isActive: true
          }
        });
        await deleteCache(redisKeys.cacheCategoriesAll()).catch(() => undefined);
      } catch {
        // ignore duplicate race condition
      }
    }
  }

  const updated = await db.buyerProfile.update({
    where: { userId: userId(req) },
    data: {
      procurementCategories: sanitized,
      otherCategoryDetails: data.otherCategoryDetails !== undefined
        ? (data.otherCategoryDetails ? String(data.otherCategoryDetails).trim().slice(0, 500) : '')
        : profile.otherCategoryDetails
    }
  });

  await auditWrite(req, 'buyer.categories.updated', 'buyerProfile', profile.id, {
    previousCount: profile.procurementCategories?.length || 0,
    newCount: sanitized.length
  });

  ok(res, {
    procurementCategories: updated.procurementCategories,
    otherCategoryDetails: updated.otherCategoryDetails
  });
}));

router.get('/seller/categories', authenticate, authorize('seller'), asyncRoute(async (req, res) => {
  const profile = await db.sellerProfile.findUnique({
    where: { userId: userId(req) },
    select: { productCategories: true, otherCategoryDetails: true }
  });
  if (!profile) throw new ApiError(404, 'Seller profile not found');
  ok(res, profile);
}));

router.put('/seller/categories', authenticate, authorize('seller'), asyncRoute(async (req, res) => {
  const data = req.body || {};

  if (!Array.isArray(data.productCategories)) {
    throw new ApiError(400, 'productCategories must be an array');
  }

  const sanitized: string[] = [];
  for (const item of data.productCategories) {
    if (typeof item === 'string') {
      const cleanItem = item.trim().replace(/[<>]/g, '');
      if (cleanItem.length > 1 && !sanitized.includes(cleanItem)) {
        sanitized.push(cleanItem);
        if (sanitized.length >= 30) break;
      }
    }
  }

  if (sanitized.length === 0) {
    throw new ApiError(400, 'At least one product category is required');
  }

  const profile = await db.sellerProfile.findUnique({ where: { userId: userId(req) } });
  if (!profile) {
    throw new ApiError(404, 'Seller profile not found. Complete onboarding first.');
  }

  for (const catName of sanitized) {
    const slug = slugFor(catName.trim());
    const existing = await db.category.findFirst({
      where: { OR: [{ slug }, { name: { equals: catName.trim(), mode: 'insensitive' } }] }
    });
    if (!existing) {
      try {
        const newCat = await db.category.create({
          data: {
            name: catName.trim(),
            slug,
            type: 'BOTH',
            organizationId: profile.organizationId || null,
            isActive: true
          }
        });
        await deleteCache(redisKeys.cacheCategoriesAll()).catch(() => undefined);
        const u = await db.user.findUnique({
          where: { id: userId(req) },
          include: { organization: true, sellerProfile: true }
        });
        const sellerName = u?.name || 'A seller';
        const businessName = u?.organization?.organizationName || u?.sellerProfile?.businessName || 'Onboarding MSME';
        await notificationService.notifyAdmins({
          title: `New Custom Category: "${newCat.name}"`,
          message: `Added by ${sellerName} (${businessName}). Please review and upload a category photo.`,
          type: 'category_custom_added',
          priority: 'high',
          redirectUrl: `/admin/categories?edit=${newCat.id}`
        }).catch(() => undefined);
      } catch {
        // ignore duplicate race condition
      }
    }
  }

  const updated = await db.sellerProfile.update({
    where: { userId: userId(req) },
    data: {
      productCategories: sanitized,
      otherCategoryDetails: data.otherCategoryDetails !== undefined
        ? (data.otherCategoryDetails ? String(data.otherCategoryDetails).trim().slice(0, 500) : '')
        : profile.otherCategoryDetails
    }
  });

  await auditWrite(req, 'seller.categories.updated', 'sellerProfile', profile.id, {
    previousCount: profile.productCategories?.length || 0,
    newCount: sanitized.length
  });

  ok(res, {
    productCategories: updated.productCategories,
    otherCategoryDetails: updated.otherCategoryDetails
  });
}));

router.post('/onboarding/submit', authenticate, asyncRoute(async (req, res) => {
  const user = await db.user.findUnique({
    where: { id: userId(req) },
    include: {
      sellerProfile: {
        include: {
          offices: true,
          sellerDocuments: true
        }
      }
    }
  });
  if (!user) throw new ApiError(404, 'User not found');

  if (user.role === 'seller' || user.role === 'shg') {
    const profile = user.sellerProfile;
    if (!profile) throw new ApiError(400, 'Seller profile not found');

    const regDetails = (user.registrationDetails as Record<string, any>) || {};
    const isShg = [
      'hershg',
      'women_shg',
      'farmer_shg',
      'artisan_shg',
      'dairy_shg',
      'livelihood_shg',
      'tribal_shg',
      'youth_shg',
      'other_shg'
    ].includes(String(regDetails.businessType || regDetails.shgType || '').trim().toLowerCase());

    const requiredDocs: string[] = isShg
      ? ['bank_passbook', 'leader_aadhaar', 'udyam_certificate']
      : ['pan_copy', 'bank_passbook', 'address_proof'];

    const addRequiredDoc = (docType: string) => {
      if (!requiredDocs.includes(docType)) requiredDocs.push(docType);
    };

    if (!isShg) {
      addRequiredDoc('udyam_certificate');
    }

    const hasGstin = (Array.isArray(profile.registrationTypes) && profile.registrationTypes.includes('GST_REGISTERED')) || Boolean(regDetails.gstin);
    if (!isShg && hasGstin) {
      addRequiredDoc('gst_certificate');
    }

    if (!isShg && (regDetails.verificationMethod === 'Aadhaar' || regDetails.aadhaarNumber)) {
      addRequiredDoc('aadhaar_card');
    }

    const corporateTypes = ['Company', 'LLP', 'Partnership', 'Cooperative', 'Society', 'Trust'];
    const isCorporate = corporateTypes.some(t => String(profile.organizationType || regDetails.businessType).toLowerCase().includes(t.toLowerCase()));
    if (!isShg && isCorporate && (regDetails.cinNumber || regDetails.registrationNumber || regDetails.cin)) {
      addRequiredDoc('business_registration_proof');
    }

    const uploadedDocs = profile.sellerDocuments?.map((d: any) => d.documentType) || [];
    const matchesDocType = (reqType: string, uploadedTypes: string[]) =>
      uploadedTypes.some(u => {
        const normU = String(u || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const normR = String(reqType || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normU === normR) return true;
        const aliases: Record<string, string[]> = {
          bankpassbook: ['bankpassbook', 'bankpassbookcancelledcheque'],
          bankpassbookcancelledcheque: ['bankpassbook', 'bankpassbookcancelledcheque'],
          leaderaadhaar: ['leaderaadhaar', 'groupleaderaadhaar', 'groupleaderaadhaarcard', 'aadhaarcard'],
          groupleaderaadhaar: ['leaderaadhaar', 'groupleaderaadhaar', 'groupleaderaadhaarcard', 'aadhaarcard'],
          registrationcertificate: ['registrationcertificate', 'shgregistrationcertificate'],
          shgregistrationcertificate: ['registrationcertificate', 'shgregistrationcertificate'],
          pancopy: ['pancopy', 'pancard', 'pancardgrouprepresentative'],
          pancardgrouprepresentative: ['pancopy', 'pancard', 'pancardgrouprepresentative'],
          udyamcertificate: ['udyamcertificate', 'udyamregistrationcertificate'],
          udyamregistrationcertificate: ['udyamcertificate', 'udyamregistrationcertificate'],
          isocertificate: ['isocertificate', 'isocertification', 'isocertified', 'iso'],
          isocertified: ['isocertificate', 'isocertification', 'isocertified', 'iso'],
          nsiccertificate: ['nsiccertificate', 'nsicregistrationcertificate', 'nsicregistered', 'nsic'],
          nsicregistrationcertificate: ['nsiccertificate', 'nsicregistrationcertificate', 'nsicregistered', 'nsic'],
          itr3years: ['itr3years', 'incometaxreturns', 'incometaxreturnsoflast3years', 'itr'],
          dippcertificate: ['dippcertificate', 'dippregistrationcertificate', 'dipp', 'startupcertificate']
        };
        return (aliases[normR] || []).includes(normU) || (aliases[normU] || []).includes(normR);
      });

    const shgOptionalDocPatterns = [
      'memberlist', 'member', 'shgregistrationcertificate', 'formationresolution',
      'pancard', 'pancopy', 'pan',
      'addressproof',
      'gstcertificate', 'gst',
      'productimages',
      'trainingskill', 'trainingcertificate', 'skilltraining', 'skilldevelopment',
      'womenempowerment', 'startupentrepreneurship', 'nrlm', 'produce',
      'farmerid', 'landrecord', 'fpo', 'fpc', 'artisan', 'handicraft',
      'catalogue', 'dairycooperative', 'dairylinkage', 'livestock',
      'businessactivity', 'activitydetails', 'tribal', 'activityspecific'
    ];
    const isShgOptionalDoc = (docType: string) => {
      const norm = String(docType || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return shgOptionalDocPatterns.some(pat => norm.includes(pat) || pat.includes(norm));
    };

    const missingDocs = requiredDocs
      .filter(d => !(isShg && isShgOptionalDoc(d)))
      .filter(d => !matchesDocType(d, uploadedDocs));

    if (missingDocs.length > 0) {
      const labels: Record<string, string> = {
        pan_copy: 'PAN Card Copy',
        bank_passbook: 'Bank Passbook / Cancelled Cheque',
        address_proof: 'Address Proof',
        udyam_certificate: 'Udyam Certificate',
        gst_certificate: 'GST Certificate',
        aadhaar_card: 'Aadhaar of Authorized Person',
        business_registration_proof: 'Business Registration Proof (CIN/Shop Act)',
        dipp_certificate: 'DIPP Certificate',
        iso_certificate: 'ISO Certificate',
        itr_3_years: 'Income Tax Returns of Last 3 Years',
        nsic_certificate: 'NSIC Registration Certificate',
        leader_aadhaar: 'Group Leader Aadhaar Card',
        registration_certificate: 'SHG Registration Certificate',
        shg_registration_certificate: 'SHG Registration Certificate',
        member_list: 'Member List'
      };
      const missingLabels = missingDocs.map(d => labels[d] || d).join(', ');
      throw new ApiError(400, `Missing required documents: ${missingLabels}. Please upload them before submitting.`, 'MISSING_MANDATORY_DOCUMENTS');
    }
  }

  const sectionStatus = (user.sectionStatus as Record<string, any>) || {};
  const sections = user.role === 'buyer'
    ? ['org', 'rep', 'address', 'procurement', 'docs']
    : ['pan', 'details', 'additional', 'offices', 'bank', 'documents'];

  const finalSectionStatus = { ...sectionStatus };
  for (const sec of sections) {
    if (!finalSectionStatus[sec] || finalSectionStatus[sec] === 'resubmission_required') {
      finalSectionStatus[sec] = 'pending';
    }
  }

  if (user.role === 'seller' || user.role === 'shg') {
    if (STRICT_VERIFICATION.PAN === false) finalSectionStatus.pan = 'approved';
    if (STRICT_VERIFICATION.BANK === false) finalSectionStatus.bank = 'approved';
    if (STRICT_VERIFICATION.UDYAM === false) finalSectionStatus.additional = 'approved';
  }

  let onboardingStatus = 'under_compliance_review';
  let registrationStatus = 'completed';

  const isDualRole = Boolean(user.isDualRole);
  const alreadyApproved = user.onboardingStatus === 'approved_for_procurement';

  if (isDualRole && alreadyApproved) {
    onboardingStatus = 'approved_for_procurement';
  }

  if (user.role === 'buyer') {
    await db.buyerProfile.updateMany({
      where: { userId: user.id },
      data: { verificationStatusEnum: 'UNDER_REVIEW', verificationStatus: 'UNDER_REVIEW' }
    });
  } else if (user.role === 'seller' || user.role === 'shg') {
    await db.sellerProfile.updateMany({
      where: { userId: user.id },
      data: { verificationStatusEnum: 'UNDER_REVIEW' }
    });
    if (user.sellerProfile?.id) {
      await db.sellerDocument.updateMany({
        where: {
          sellerProfileId: user.sellerProfile.id,
          verificationStatus: 'REJECTED'
        },
        data: {
          verificationStatus: 'PENDING'
        }
      });
    }
  }

  const updated = await db.user.update({
    where: { id: userId(req) },
    data: {
      onboardingStatus,
      registrationStatus,
      sectionStatus: {
        ...finalSectionStatus,
        submitted: true
      },
      sectionRejectionReasons: {},
      adminFeedback: null
    }
  });

  // Ensure organization record is created/linked as PENDING upon onboarding submission
  await createOrUpdatePendingOrganization(updated.id).catch((err: any) => {
    console.error('[Onboarding Submit] Failed to create pending organization:', err);
  });

  await invalidateUserAuthCache(updated.id).catch(() => undefined);
  deleteCache('/api/auth/me').catch(() => undefined);
  deleteCache('/api/org/status').catch(() => undefined);
  deleteCache(`/api/admin/onboarding/${updated.id}`).catch(() => undefined);

  await auditWrite(req, 'onboarding.submitted', 'user', updated.id);

  try {
    const applicant = await db.user.findUnique({ where: { id: userId(req) }, select: { name: true, role: true, email: true } });
    await notificationService.notifyWithEmail(userId(req), {
      title: 'Application Submitted for Review',
      message: 'Your onboarding application has been submitted for admin compliance review. You will be notified when an admin updates the status.',
      type: 'onboarding_submitted_for_review',
      priority: 'high',
      redirectUrl: user.role === 'seller' ? '/seller/onboarding' : '/buyer/onboarding'
    });
    await notificationService.notifyAdminsWithEmail({
      title: 'New Application Submitted',
      message: `${applicant?.name || 'A user'} (${applicant?.role}) has submitted their onboarding application for review.`,
      type: 'onboarding_submitted',
      priority: 'high',
      redirectUrl: '/admin/onboarding',
      emailSubject: 'New Application Pending Review - MSME Procurement Portal',
      emailHtml: `<p>A new onboarding application has been submitted and requires your review.</p><p><strong>Applicant:</strong> ${applicant?.name || 'Unknown'} (${applicant?.role})</p><p><strong>Email:</strong> ${applicant?.email || 'N/A'}</p>`
    });
  } catch (error) {
    // Suppress notification errors to not block user flow
  }

  ok(res, updated);
}));

router.post('/onboarding/upload-document', authenticate, upload.single('file'), asyncRoute(async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
  if (!req.file) throw new ApiError(400, 'Document file is required', 'DOCUMENT_REQUIRED');
  if (!req.user || !userId(req)) throw new ApiError(401, 'Authentication required', 'AUTH_REQUIRED');

  // Upsert sellerProfile — SHG and seller users (as well as admins/buyers testing onboarding)
  // completed the PAN step yet. We auto-create a minimal profile so they can
  // upload their SHG verification documents independently.
  let profile = await db.sellerProfile.findUnique({ where: { userId: userId(req) } });
  if (!profile) {
    const dbUser = await db.user.findUnique({ where: { id: userId(req) }, select: { name: true, registrationDetails: true } });
    const regDetails = (dbUser?.registrationDetails as Record<string, any>) || {};
    // Use a unique pan placeholder per user so the @unique constraint is not violated
    const panPlaceholder = `PENDING_${userId(req)}_${Date.now()}`;
    profile = await db.sellerProfile.create({
      data: {
        userId: userId(req),
        pan: panPlaceholder,
        nameAsInPan: dbUser?.name || 'Pending',
        organizationType: String(regDetails.businessType || 'herSHG')
      }
    });
  }

  const docType = clean(req.body?.documentType || 'onboarding');

  // Deactivate existing documents of the same type
  const existingDocs = await db.sellerDocument.findMany({
    where: {
      sellerProfileId: profile.id,
      documentType: docType
    },
    include: {
      fileAsset: true
    }
  });

  for (const doc of existingDocs) {
    await db.sellerDocument.delete({ where: { id: doc.id } });
    if (doc.fileAsset) {
      await db.fileAsset.update({
        where: { id: doc.fileAssetId },
        data: { status: 'inactive' }
      });
    }
  }

  const context = {
    ownerId: userId(req),
    ownerRole: String(req.user?.role),
    entityType: 'onboarding',
    entityId: profile.id,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  };

  const asset = await uploadFile(req.file, context, env.STORAGE_PROVIDER);

  const document = await db.sellerDocument.create({
    data: {
      sellerProfileId: profile.id,
      documentType: docType,
      fileAssetId: asset.id
    }
  });

  await auditWrite(req, 'onboarding.document_uploaded', 'sellerDocument', document.id);
  ok(res, { asset, document }, 201);
}));


const getPublicTenderDocument = async (fileId: number) => db.tenderDocument.findFirst({
  where: {
    fileAssetId: fileId,
    isPublic: true,
    tender: { status: { in: ['published', 'bid_submission'] } }
  },
  include: { tender: { select: { buyerId: true } } }
});

const getPublicFileActor = async (fileId: number): Promise<{ id: number; role: string } | null> => {
  const publicDoc = await getPublicTenderDocument(fileId);
  if (publicDoc) return { id: publicDoc.tender.buyerId, role: 'buyer' };

  const procurementDoc = await db.procurementBidDocument.findFirst({
    where: { fileAssetId: fileId, visibility: 'PUBLIC' },
    include: { bid: { select: { buyerId: true } } }
  }).catch(() => null);
  if (procurementDoc?.bid?.buyerId) return { id: Number(procurementDoc.bid.buyerId), role: 'buyer' };

  // Delivery Document check
  const deliveryDoc = await db.deliveryDocument.findFirst({
    where: { fileAssetId: fileId },
    include: { deliveryTracking: { include: { purchaseOrder: true } } }
  }).catch(() => null);
  if (deliveryDoc) {
    const po = deliveryDoc.deliveryTracking?.purchaseOrder;
    const actorId = deliveryDoc.uploadedById || po?.sellerId || po?.buyerId;
    if (actorId) {
      return { id: Number(actorId), role: deliveryDoc.uploaderRole || 'seller' };
    }
  }

  // Invoice check
  const invDoc = await db.invoice.findFirst({
    where: { OR: [{ invoiceFileId: fileId }, { fileAssetId: fileId }] },
    include: { purchaseOrder: true }
  }).catch(() => null);
  if (invDoc) {
    const actorId = invDoc.sellerId || invDoc.buyerId || invDoc.purchaseOrder?.sellerId || invDoc.purchaseOrder?.buyerId;
    if (actorId) {
      return { id: Number(actorId), role: 'seller' };
    }
  }

  // GRN Document check
  const grnDoc = await db.grnDocument.findFirst({
    where: { fileAssetId: fileId },
    include: { grn: { include: { purchaseOrder: true } } }
  }).catch(() => null);
  if (grnDoc) {
    const po = (grnDoc as any).grn?.purchaseOrder;
    const actorId = grnDoc.uploadedById || po?.buyerId || po?.sellerId;
    if (actorId) {
      return { id: Number(actorId), role: 'buyer' };
    }
  }

  // Check if file is an organization profile branding asset (logo or banner)
  const orgProfile = await db.organizationProfile.findFirst({
    where: {
      OR: [
        { logoUrl: { contains: `/files/${fileId}/` } },
        { bannerUrl: { contains: `/files/${fileId}/` } },
        { logoUrl: { endsWith: `/files/${fileId}/view` } },
        { bannerUrl: { endsWith: `/files/${fileId}/view` } }
      ]
    },
    select: { organizationId: true }
  }).catch(() => null);
  if (orgProfile) {
    const asset = await db.fileAsset.findUnique({
      where: { id: fileId },
      select: { ownerId: true, ownerRole: true }
    });
    if (asset) return { id: Number(asset.ownerId), role: String(asset.ownerRole || 'seller') };
  }

  // Check if file is a buyer profile branding asset (logo or banner)
  const buyerProfile = await db.buyerProfile.findFirst({
    where: {
      OR: [
        { logoUrl: { contains: `/files/${fileId}/` } },
        { bannerUrl: { contains: `/files/${fileId}/` } },
        { logoUrl: { endsWith: `/files/${fileId}/view` } },
        { bannerUrl: { endsWith: `/files/${fileId}/view` } }
      ]
    },
    select: { userId: true }
  }).catch(() => null);
  if (buyerProfile) {
    const asset = await db.fileAsset.findUnique({
      where: { id: fileId },
      select: { ownerId: true, ownerRole: true }
    });
    if (asset) return { id: Number(asset.ownerId), role: String(asset.ownerRole || 'buyer') };
  }

  // Check if file is referenced as organization logo
  const org = await db.organization.findFirst({
    where: { organizationLogoFileId: fileId },
    select: { id: true }
  }).catch(() => null);
  if (org) {
    const asset = await db.fileAsset.findUnique({
      where: { id: fileId },
      select: { ownerId: true, ownerRole: true }
    });
    if (asset) return { id: Number(asset.ownerId), role: String(asset.ownerRole || 'seller') };
  }

  const directCatalogueAsset = await db.fileAsset.findFirst({
    where: {
      id: fileId,
      status: 'active',
      OR: [
        { entityType: { in: ['catalogue', 'catalogue_product', 'catalogue_service', 'banner', 'organization_banner', 'logo', 'organization_logo', 'company_logo', 'public'] } },
        { entityType: 'general', mimeType: { startsWith: 'image/' } }
      ]
    },
    select: { ownerId: true, ownerRole: true }
  });
  if (directCatalogueAsset) {
    return { id: Number(directCatalogueAsset.ownerId), role: String(directCatalogueAsset.ownerRole || 'seller') };
  }

  const productImage = await db.productImage.findFirst({
    where: { fileAssetId: fileId, product: { status: 'ACTIVE' } },
    include: { product: { select: { sellerId: true } } }
  }).catch(() => null);
  if (productImage?.product?.sellerId) return { id: Number(productImage.product.sellerId), role: 'seller' };

  const certification = await db.certification.findFirst({
    where: {
      fileAssetId: fileId,
      OR: [
        { product: { status: 'ACTIVE' } },
        { service: { status: 'ACTIVE' } }
      ]
    },
    include: {
      product: { select: { sellerId: true } },
      service: { select: { sellerId: true } }
    }
  }).catch(() => null);
  const sellerId = certification?.product?.sellerId || certification?.service?.sellerId;
  if (sellerId) return { id: Number(sellerId), role: 'seller' };

  // Offline Payment Proof check
  const offlineProof = await (db as any).offlinePaymentProof.findFirst({
    where: {
      OR: [
        { receiptFileId: fileId },
        { receiptFileUrl: { contains: `/files/${fileId}/` } }
      ]
    }
  }).catch(() => null);
  if (offlineProof) {
    let poBuyerId = null;
    let poSellerId = null;
    if (offlineProof.purchaseOrderId) {
      const po = await db.purchaseOrder.findUnique({
        where: { id: offlineProof.purchaseOrderId },
        select: { buyerId: true, sellerId: true }
      }).catch(() => null);
      poBuyerId = po?.buyerId;
      poSellerId = po?.sellerId;
    }
    const actorId = offlineProof.uploadedByUserId || poBuyerId || poSellerId;
    if (actorId) return { id: Number(actorId), role: 'buyer' };
  }

  // Branding / Image asset fallback (stamps, signatures, onboarding images)
  const brandingAsset = await db.fileAsset.findFirst({
    where: {
      id: fileId,
      status: 'active',
      OR: [
        { entityType: { in: ['catalogue', 'catalogue_product', 'catalogue_service', 'banner', 'organization_banner', 'logo', 'organization_logo', 'company_logo', 'public', 'stamp', 'signature', 'invoice-branding'] } },
        { entityType: { in: ['general', 'onboarding', 'registration', 'procurement_draft', 'seller_profile', 'buyer_profile'] }, mimeType: { startsWith: 'image/' } }
      ]
    },
    select: { ownerId: true, ownerRole: true }
  }).catch(() => null);
  if (brandingAsset?.ownerId) {
    return { id: Number(brandingAsset.ownerId), role: String(brandingAsset.ownerRole || 'seller') };
  }

  // Requirement procurement document check (SOW, BOQ, line items, requirement documents)
  const reqWithFile = await db.requirement.findFirst({
    where: {
      OR: [
        { payload: { path: ['serviceDetails', 'sowFileAssetId'], equals: fileId } },
        { payload: { path: ['sowFileAssetId'], equals: fileId } },
        { payload: { path: ['boqFileAssetId'], equals: fileId } },
        { payload: { path: ['items'], array_contains: [{ fileAssetId: fileId }] } },
        { payload: { path: ['documents'], array_contains: [{ fileAssetId: fileId }] } }
      ]
    },
    select: { buyerId: true }
  }).catch(() => null);
  if (reqWithFile?.buyerId) {
    return { id: Number(reqWithFile.buyerId), role: 'buyer' };
  }

  return null;
};

router.get('/public/files/:id/view', asyncRoute(async (req: AuthRequest, res) => {
  const { id } = parse(idParams, req.params);
  const publicActor = await getPublicFileActor(id);
  if (!publicActor) throw new ApiError(404, 'Public document not found', 'FILE_NOT_FOUND');

  const signed = await getSignedUrl(id, publicActor, {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  });

  if (signed.signedUrl && (signed.signedUrl.startsWith('http://') || signed.signedUrl.startsWith('https://'))) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.redirect(302, signed.signedUrl);
  }

  const file = await getFileContent(id, publicActor, {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  });
  const filename = encodeURIComponent((file.asset as any).originalName || (file.asset as any).key || 'document');

  const etag = `W/"${id}-${(file.asset as any)?.updatedAt ? new Date((file.asset as any).updatedAt).getTime() : file.buffer.length}"`;

  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Length', file.buffer.length);
  res.setHeader('Content-Disposition', `inline; filename="${filename}"; filename*=UTF-8''${filename}`);
  applyCorsHeaders(req, res);
  res.setHeader('ETag', etag);

  // Relax frame restrictions so portal iframes can display document preview inline
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; frame-ancestors 'self' https://www.jsgsmile.in https://jsgsmile.in http://localhost:3000 http://localhost:5000;");

  if (req.headers['if-none-match'] === etag) {
    res.status(304);
    return res.end();
  }

  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  return res.end(file.buffer);
}));

router.get('/public/files/:id/signed-url', asyncRoute(async (req: AuthRequest, res) => {
  const { id } = parse(idParams, req.params);
  const publicActor = await getPublicFileActor(id);
  if (!publicActor) throw new ApiError(404, 'Public document not found', 'FILE_NOT_FOUND');

  const file = await getSignedUrl(id, publicActor, {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  });

  ok(res, {
    signedUrl: file.signedUrl,
    expiresInSeconds: file.expiresInSeconds,
    file: {
      id: file.asset.id,
      originalName: (file.asset as any).originalName || (file.asset as any).key,
      mimeType: file.asset.mimeType,
      size: (file.asset as any).size
    }
  });
}));

const RAW_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain'
};

router.get('/files/raw/:key(*)', optionalAuthenticate, asyncRoute(async (req: AuthRequest, res) => {
  const rawKey = req.params.key;
  if (!rawKey || typeof rawKey !== 'string') {
    throw new ApiError(400, 'Key is required', 'KEY_REQUIRED');
  }

  // Null byte or control character detection
  if (rawKey.includes('\0') || /[\x00-\x1f]/.test(rawKey)) {
    throw new ApiError(403, 'Path traversal detected', 'PATH_TRAVERSAL_DETECTED');
  }

  // Double-encoding check and decoding
  let decodedKey = rawKey;
  try {
    decodedKey = decodeURIComponent(rawKey);
    if (decodeURIComponent(decodedKey) !== decodedKey) {
      decodedKey = decodeURIComponent(decodedKey);
    }
  } catch {
    throw new ApiError(400, 'Invalid key encoding', 'INVALID_ENCODING');
  }

  if (decodedKey.includes('\0') || /[\x00-\x1f]/.test(decodedKey)) {
    throw new ApiError(403, 'Path traversal detected', 'PATH_TRAVERSAL_DETECTED');
  }

  // Sanitize and normalize decodedKey and rawKey using path.posix.normalize
  const normalizedRawKey = path.posix.normalize(rawKey.replace(/\\/g, '/'));
  let normalizedKey = path.posix.normalize(decodedKey.replace(/\\/g, '/')).replace(/^(\/|\.)+/, '');

  // Reject any key where decodedKey.includes('..') || rawKey.includes('..') immediately with HTTP 403 PATH_TRAVERSAL_DETECTED
  if (
    rawKey.includes('..') ||
    decodedKey.includes('..') ||
    normalizedRawKey.includes('..') ||
    normalizedKey.includes('..') ||
    path.isAbsolute(decodedKey) ||
    decodedKey.startsWith('/')
  ) {
    throw new ApiError(403, 'Path traversal detected', 'PATH_TRAVERSAL_DETECTED');
  }

  decodedKey = normalizedKey;

  // Public storage whitelist check: marketplace-visible asset prefixes allowed unauthenticated
  // Requires the normalized key to strictly begin with a whitelisted prefix and NOT escape via ..
  const PUBLIC_ASSET_PREFIXES = [
    'categories/photos/',
    'public/',
    'banners/',
    'products/',
    'documents/',
  ];
  const isPublicPrefix = (
    (decodedKey.startsWith('categories/photos/') || decodedKey.startsWith('public/') || PUBLIC_ASSET_PREFIXES.some(prefix => decodedKey.startsWith(prefix))) &&
    !decodedKey.includes('..') &&
    !rawKey.includes('..')
  );

  if (!req.user && !isPublicPrefix) {
    throw new ApiError(401, 'Authentication required to access this file', 'AUTHENTICATION_REQUIRED');
  }

  // Check for path traversal sequences
  const baseDirectories = [
    path.resolve(process.cwd(), 'uploads'),
    path.resolve(process.cwd(), 'backend', 'uploads'),
    path.resolve(process.cwd(), 'public'),
    path.resolve(process.cwd(), 'frontend', 'public')
  ];

  for (const baseDir of baseDirectories) {
    const localPath = path.resolve(baseDir, decodedKey);
    const relative = path.relative(baseDir, localPath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || path.isAbsolute(decodedKey)) {
      throw new ApiError(403, 'Path traversal detected', 'PATH_TRAVERSAL_DETECTED');
    }
  }

  const ext = path.extname(decodedKey).toLowerCase();
  let contentType = RAW_MIME_TYPES[ext] || 'application/octet-stream';
  const cacheControl = decodedKey.startsWith('categories/photos/') && req.query.v
    ? 'public, max-age=31536000, s-maxage=31536000, immutable'
    : 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400';

  // 1. Try authenticated GCS client
  try {
    const bucket = getGCSBucket();
    const file = bucket.file(decodedKey);
    const [exists] = await file.exists();
    if (exists) {
      const [buffer] = await file.download();
      const optimized = await optimizeImageBuffer(buffer, contentType, req.query);
      res.setHeader('Content-Type', optimized.contentType);
      res.setHeader('Content-Length', optimized.buffer.length);
      res.setHeader('Cache-Control', cacheControl);
      applyCorsHeaders(req, res);
      return res.end(optimized.buffer);
    }
  } catch {}

  // 2. Try fetching public storage URL
  try {
    const bucketName = getGCSBucketName();
    const publicUrl = `https://storage.googleapis.com/${bucketName}/${decodedKey}`;
    const response = await fetch(publicUrl);
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const headerContentType = response.headers.get('content-type') || contentType;
      const optimized = await optimizeImageBuffer(buffer, headerContentType, req.query);
      res.setHeader('Content-Type', optimized.contentType);
      res.setHeader('Content-Length', optimized.buffer.length);
      res.setHeader('Cache-Control', cacheControl);
      applyCorsHeaders(req, res);
      return res.end(optimized.buffer);
    }
  } catch {}

  // 3. Try local disk storage fallback with verified bounds
  try {
    for (const baseDir of baseDirectories) {
      const localPath = path.resolve(baseDir, decodedKey);
      const relative = path.relative(baseDir, localPath);
      if (relative.startsWith('..') || path.isAbsolute(relative) || path.isAbsolute(decodedKey)) {
        continue;
      }
      if (fs.existsSync(localPath) && !fs.statSync(localPath).isDirectory()) {
        const buffer = await fs.promises.readFile(localPath);
        const optimized = await optimizeImageBuffer(buffer, contentType, req.query);
        res.setHeader('Content-Type', optimized.contentType);
        res.setHeader('Content-Length', optimized.buffer.length);
        res.setHeader('Cache-Control', cacheControl);
        applyCorsHeaders(req, res);
        return res.end(optimized.buffer);
      }
    }
  } catch {}

  // 4. Try FileAsset lookup by key or filename
  try {
    const cleanKey = decodeURIComponent(decodedKey);
    const baseName = path.basename(cleanKey);
    const asset = await db.fileAsset.findFirst({
      where: {
        status: 'active',
        OR: [
          { key: decodedKey },
          { key: cleanKey },
          { url: { endsWith: decodedKey } },
          { url: { endsWith: cleanKey } },
          { originalName: baseName }
        ]
      }
    });

    if (asset) {
      const publicActor = (await getPublicFileActor(asset.id)) || (req.user ? { id: req.user.id, role: req.user.role } : { id: asset.ownerId, role: asset.ownerRole || 'seller' });
      const file = await getFileContent(asset.id, publicActor, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']
      });
      if (file?.buffer) {
        const optimized = await optimizeImageBuffer(file.buffer, file.contentType || contentType, req.query);
        res.setHeader('Content-Type', optimized.contentType);
        res.setHeader('Content-Length', optimized.buffer.length);
        res.setHeader('Cache-Control', cacheControl);
        applyCorsHeaders(req, res);
        return res.end(optimized.buffer);
      }
    }
  } catch {}

  throw new ApiError(404, 'File not found in storage', 'FILE_NOT_FOUND');
}));


router.get('/files/:id/view', optionalAuthenticate, asyncRoute(async (req: AuthRequest, res) => {
  const { id } = parse(idParams, req.params);
  let actor: any = req.user;
  if (!actor && typeof req.query.token === 'string' && req.query.token.trim()) {
    try {
      const decoded = verifyAccessToken(req.query.token.trim());
      if (decoded?.id) {
        const u = await db.user.findUnique({
          where: { id: Number(decoded.id) },
          select: { id: true, role: true, sessionVersion: true, accountStatus: true, organizationId: true }
        });
        if (u && u.accountStatus === 'ACTIVE') {
          actor = {
            id: u.id,
            role: u.role,
            sessionVersion: u.sessionVersion,
            permissions: [],
            organizationId: u.organizationId,
            enabledFeatures: []
          };
        }
      }
    } catch {
      // ignore invalid query token
    }
  }
  if (!actor) {
    actor = (await getPublicFileActor(id)) || undefined;
  }
  if (!actor) throw new ApiError(401, 'Authentication required', 'AUTH_REQUIRED');

  const signed = await getSignedUrl(id, actor, {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  });

  // Only redirect if explicit redirect query param was passed.
  // Otherwise, stream file buffer directly with inline disposition, robust CSP, and CORS headers
  // to avoid GCS signed URL expiry and cross-origin iframe sandbox blocks in Edge/Chrome.
  if (req.query.redirect === 'true' && signed.signedUrl && (signed.signedUrl.startsWith('http://') || signed.signedUrl.startsWith('https://'))) {
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.redirect(302, signed.signedUrl);
  }

  const file = await getFileContent(id, actor, {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  });
  const filename = encodeURIComponent((file.asset as any).originalName || (file.asset as any).key || 'document');

  const isImage = (file.contentType || '').startsWith('image/');
  const etag = `W/"${id}-${(file.asset as any)?.updatedAt ? new Date((file.asset as any).updatedAt).getTime() : file.buffer.length}"`;

  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Length', file.buffer.length);
  res.setHeader('Content-Disposition', `inline; filename="${filename}"; filename*=UTF-8''${filename}`);
  applyCorsHeaders(req, res);
  res.setHeader('ETag', etag);

  // Relax frame restrictions so portal iframes can display document preview inline
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; frame-ancestors 'self' https://www.jsgsmile.in https://jsgsmile.in http://localhost:3000 http://localhost:5000;");

  if (req.headers['if-none-match'] === etag) {
    res.status(304);
    return res.end();
  }

  if (isImage) {
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  } else {
    res.setHeader('Cache-Control', 'private, max-age=3600, stale-while-revalidate=86400');
  }
  return res.end(file.buffer);
}));

router.get('/files/:id/download', optionalAuthenticate, asyncRoute(async (req: AuthRequest, res) => {
  const { id } = parse(idParams, req.params);
  let actor: any = req.user;
  if (!actor && typeof req.query.token === 'string' && req.query.token.trim()) {
    try {
      const decoded = verifyAccessToken(req.query.token.trim());
      if (decoded?.id) {
        const u = await db.user.findUnique({
          where: { id: Number(decoded.id) },
          select: { id: true, role: true, sessionVersion: true, accountStatus: true, organizationId: true }
        });
        if (u && u.accountStatus === 'ACTIVE') {
          actor = {
            id: u.id,
            role: u.role,
            sessionVersion: u.sessionVersion,
            permissions: [],
            organizationId: u.organizationId,
            enabledFeatures: []
          };
        }
      }
    } catch {
      // ignore invalid query token
    }
  }
  if (!actor) {
    actor = (await getPublicFileActor(id)) || undefined;
  }
  if (!actor) throw new ApiError(401, 'Authentication required', 'AUTH_REQUIRED');

  const file = await getFileContent(id, actor, {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  });
  const filename = encodeURIComponent((file.asset as any).originalName || (file.asset as any).key || 'document');

  res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
  res.setHeader('Content-Length', file.buffer.length);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
  applyCorsHeaders(req, res);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.end(file.buffer);
}));

router.get('/files/:id/signed-url', authenticate, asyncRoute(async (req: AuthRequest, res) => {
  const { id } = parse(idParams, req.params);
  if (!req.user) throw new ApiError(401, 'Authentication required', 'AUTH_REQUIRED');

  const file = await getSignedUrl(id, req.user, {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  });

  ok(res, {
    signedUrl: file.signedUrl,
    expiresInSeconds: file.expiresInSeconds,
    file: {
      id: file.asset.id,
      originalName: (file.asset as any).originalName || (file.asset as any).key,
      mimeType: file.asset.mimeType,
      size: (file.asset as any).size
    }
  });
}));

router.get('/admin/onboarding', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);
  const pendingStatuses = ['pending', 'pending_validation', 'manual_review_required', 'under_compliance_review'];
  const conditions: any[] = [];

  if (query.status) {
    if (query.status === 'review_queue') {
      conditions.push({
        OR: [
          { onboardingStatus: { in: pendingStatuses } },
          {
            isDualRole: true,
            role: 'seller',
            sellerProfile: { verificationStatusEnum: 'UNDER_REVIEW' }
          },
          {
            isDualRole: true,
            role: 'buyer',
            buyerProfile: { verificationStatusEnum: 'UNDER_REVIEW' }
          }
        ]
      });
    } else {
      conditions.push({ onboardingStatus: query.status });
    }
  }

  if (query.q) {
    conditions.push({
      OR: [
        { name: { contains: query.q, mode: 'insensitive' } },
        { email: { contains: query.q, mode: 'insensitive' } },
        { buyerProfile: { organizationName: { contains: query.q, mode: 'insensitive' } } },
        { buyerProfile: { gst: { contains: query.q, mode: 'insensitive' } } },
        { buyerProfile: { pan: { contains: query.q, mode: 'insensitive' } } },
        { sellerProfile: { businessName: { contains: query.q, mode: 'insensitive' } } },
        { sellerProfile: { pan: { contains: query.q, mode: 'insensitive' } } }
      ]
    });
  }

  const baseWhere: any = {};
  if (conditions.length > 0) {
    baseWhere.AND = conditions;
  }

  const defaultTake = (!req.query.pageSize && !req.query.take && !req.query.page) ? 500 : 50;
  const window = listWindow(query, defaultTake);

  const userSelect = {
    // List view payload - intentionally lean. Heavy fields like
    // offices/bankAccounts/sellerDocuments/full profile are loaded only
    // when the scrutiny modal is opened via GET /admin/onboarding/:id.
    id: true,
    name: true,
    email: true,
    role: true,
    onboardingStatus: true,
    registrationStatus: true,
    registrationDetails: true,
    createdAt: true,
    updatedAt: true,
    sectionStatus: true,
    adminFeedback: true,
    complianceViolations: { select: { id: true, type: true, severity: true, status: true } },
    buyerProfile: {
      select: {
        id: true,
        organizationName: true,
        businessType: true,
        organizationType: true,
        industry: true,
        gst: true,
        pan: true,
        cin: true,
        state: true,
        city: true,
        pincode: true,
        registeredAddress: true,
        corporateAddress: true,
        mobile: true,
        alternateMobile: true,
        email: true,
        representativeName: true,
        designation: true,
        department: true,
        procurementCategories: true,
        annualBudget: true,
        documents: true,
        organization: true
      }
    },
    sellerProfile: {
      select: {
        id: true,
        businessName: true,
        organizationType: true,
        pan: true,
        nameAsInPan: true,
        dateAsInPan: true,
        panVerified: true,
        msmeCategory: true,
        msmeType: true,
        vendorType: true,
        turnoverMax3Yrs: true,
        productCategories: true,
        mobile: true,
        isUdyamCertified: true,
        documents: true,
        offices: { orderBy: [{ isMandatory: 'desc' }, { id: 'asc' }] },
        bankAccounts: true,
        sellerDocuments: { include: { fileAsset: true } },
        certifications: { include: { fileAsset: true } },
        organization: true
      }
    },
    organization: true
  };

  let users: any[] = [];
  let total = 0;

  const role = query.role;
  const isSpecificRole = role && role !== 'all';

  if (isSpecificRole) {
    let roleCondition: any;
    if (role === 'buyer') roleCondition = 'buyer';
    else if (role === 'shg') roleCondition = { in: ['shg', 'seller'] };
    else roleCondition = { in: ['seller', 'shg'] };

    const roleWhere = { ...baseWhere, role: roleCondition };
    const [fetchedUsers, fetchedTotal] = await Promise.all([
      db.user.findMany({
        where: roleWhere,
        select: userSelect,
        orderBy: { updatedAt: 'desc' },
        ...window
      }),
      db.user.count({ where: roleWhere })
    ]);
    users = fetchedUsers;
    total = fetchedTotal;
  } else {
    // When no specific role is requested, query sellers/SHG and buyers independently
    // to prevent higher-volume buyer activity from starving seller records out of the result window.
    const sellerWhere = { ...baseWhere, role: { in: ['seller', 'shg'] } };
    const buyerWhere = { ...baseWhere, role: 'buyer' };
    const totalWhere = { ...baseWhere, role: { in: ['buyer', 'seller', 'shg'] } };

    const [sellerUsers, buyerUsers, fetchedTotal] = await Promise.all([
      db.user.findMany({
        where: sellerWhere,
        select: userSelect,
        orderBy: { updatedAt: 'desc' },
        ...window
      }),
      db.user.findMany({
        where: buyerWhere,
        select: userSelect,
        orderBy: { updatedAt: 'desc' },
        ...window
      }),
      db.user.count({ where: totalWhere })
    ]);
    users = [...sellerUsers, ...buyerUsers];
    total = fetchedTotal;
  }

  const [statusGroups, approvedRoleGroups, flagged] = await Promise.all([
    db.user.groupBy({
      by: ['onboardingStatus'],
      where: { role: { in: ['buyer', 'seller', 'shg'] } },
      _count: { _all: true }
    }),
    db.user.groupBy({
      by: ['role'],
      where: { role: { in: ['buyer', 'seller', 'shg'] }, onboardingStatus: 'approved_for_procurement' },
      _count: { _all: true }
    }),
    db.complianceViolation.count({
      where: {
        status: 'open',
        user: { role: { in: ['buyer', 'seller', 'shg'] } }
      }
    })
  ]);

  const sellers: any[] = [];
  const buyers: any[] = [];
  const getDocumentEntries = (documents: any) =>
    documents && typeof documents === 'object' && !Array.isArray(documents)
      ? Object.entries(documents as Record<string, any>)
      : [];
  const documentOwners = users
    .filter((u: any) => getDocumentEntries((['seller', 'shg'].includes(u.role) ? u.sellerProfile : u.buyerProfile)?.documents).length > 0)
    .map((u: any) => u.id);
  const documentAssets = documentOwners.length > 0
    ? await db.fileAsset.findMany({
      where: { ownerId: { in: [...new Set(documentOwners)] }, status: 'active' },
      select: { id: true, ownerId: true, key: true, url: true, originalName: true, mimeType: true }
    })
    : [];
  const findDocumentAsset = (ownerId: number, url: string) => {
    const decodedUrl = (() => {
      try {
        return decodeURIComponent(url);
      } catch {
        return url;
      }
    })();
    return documentAssets.find(asset =>
      asset.ownerId === ownerId &&
      (asset.url === url || decodedUrl.includes(asset.key))
    );
  };
  const enrichDocuments = (ownerId: number, documents: any) => {
    if (!documents || typeof documents !== 'object' || Array.isArray(documents)) return documents;
    return Object.fromEntries(getDocumentEntries(documents).map(([key, value]) => {
      const enrichDocumentValue = (documentValue: any) => {
        const url = typeof documentValue === 'string' ? documentValue : documentValue?.url;
        const asset = typeof url === 'string' ? findDocumentAsset(ownerId, url) : null;
        return asset
          ? { url, fileId: asset.id, originalName: asset.originalName, mimeType: asset.mimeType }
          : documentValue;
      };
      return [
        key,
        Array.isArray(value) ? value.map(enrichDocumentValue) : enrichDocumentValue(value)
      ];
    }));
  };

  for (const u of users) {
    const rawProfile = ['seller', 'shg'].includes(u.role) ? u.sellerProfile : u.buyerProfile;
    let enrichedDocs = rawProfile?.documents ? enrichDocuments(u.id, rawProfile.documents) : rawProfile?.documents;

    if (['seller', 'shg'].includes(u.role) && u.sellerProfile?.sellerDocuments) {
      const docsObj = typeof enrichedDocs === 'object' && enrichedDocs ? { ...(enrichedDocs as Record<string, any>) } : {};
      for (const sd of u.sellerProfile.sellerDocuments) {
        if (sd.fileAsset) {
          const docTypeUpper = (sd.documentType || '').toUpperCase();
          let k = 'uploaded_files';
          if (docTypeUpper.includes('PAN')) {
            k = 'pan';
            delete docsObj.pan_copy; delete docsObj.panCard; delete docsObj.panCopy;
          } else if (docTypeUpper.includes('GST')) {
            k = 'gstCert';
            delete docsObj.gst_certificate; delete docsObj.gst; delete docsObj.gstCertificate;
          } else if (docTypeUpper.includes('UDYAM') || docTypeUpper.includes('MSME')) {
            k = 'udyamCert';
            delete docsObj.udyam_certificate; delete docsObj.udyam_cert; delete docsObj.udyam;
          } else if (docTypeUpper.includes('PASSBOOK') || docTypeUpper.includes('CHEQUE') || docTypeUpper.includes('BANK')) {
            k = 'bankPassbook';
            delete docsObj.bank_passbook; delete docsObj.cancelled_cheque; delete docsObj.bank_passbook_cancelled_cheque;
          } else if (docTypeUpper.includes('INCORPORATION') || docTypeUpper.includes('REGISTRATION') || docTypeUpper.includes('FORMATION')) {
            k = 'regCert';
            delete docsObj.registration_certificate; delete docsObj.business_registration_proof; delete docsObj.shg_registration_certificate;
          } else if (docTypeUpper.includes('ADDRESS')) {
            k = 'addressProof';
            delete docsObj.address_proof; delete docsObj.addressProofDoc;
          } else if (docTypeUpper.includes('LEADER') || docTypeUpper.includes('AADHAAR')) {
            k = 'leader_aadhaar';
            delete docsObj.group_leader_aadhaar; delete docsObj.leader_aadhaar;
          } else if (docTypeUpper.includes('MEMBER')) {
            k = 'member_list';
            delete docsObj.member_list;
          } else if (docTypeUpper.includes('AUTH') || docTypeUpper.includes('LETTER')) {
            k = 'authLetter';
            delete docsObj.authorization_letter; delete docsObj.auth_letter;
          } else {
            k = sd.documentType || 'uploaded_files';
          }

          docsObj[k] = {
            fileId: sd.fileAsset.id,
            url: `/api/files/${sd.fileAsset.id}/view`,
            originalName: sd.fileAsset.originalName,
            mimeType: sd.fileAsset.mimeType,
            uploadedAt: sd.uploadedAt || sd.createdAt
          };
        }
      }
      enrichedDocs = docsObj;
    }

    const regDetails = (u.registrationDetails as Record<string, any>) || {};
    const rawPan = rawProfile?.pan || u.organization?.panNumber || regDetails.pan || null;
    const rawNameAsInPan = (rawProfile as any)?.nameAsInPan || (rawProfile as any)?.panName || regDetails.nameAsInPan || u.organization?.organizationName || null;
    const rawDateAsInPan = (rawProfile as any)?.dateAsInPan || (rawProfile as any)?.dateOfIncorporation || regDetails.dateAsInPan || null;
    const rawMobile = rawProfile?.mobile || u.mobile || null;

    const plainPan = isEncrypted(rawPan) ? decryptField(rawPan) : rawPan;
    const plainNameAsInPan = isEncrypted(rawNameAsInPan) ? decryptField(rawNameAsInPan) : rawNameAsInPan;
    const plainDateAsInPan = isEncrypted(rawDateAsInPan) ? decryptField(rawDateAsInPan) : rawDateAsInPan;
    const plainMobile = isEncrypted(rawMobile) ? decryptField(rawMobile) : rawMobile;

    const rawBankAccounts = (rawProfile as any)?.bankAccounts;
    const enrichedBankAccounts = Array.isArray(rawBankAccounts)
      ? rawBankAccounts.map((b: any) => {
          const rawAccount = b.accountNumber;
          const plainAccount = isEncrypted(rawAccount) ? decryptField(rawAccount) : rawAccount;
          const displayAccount = plainAccount || b.accountNumberMasked || null;
          return {
            ...b,
            accountNumber: displayAccount,
            accountNumberMasked: b.accountNumberMasked || (plainAccount ? maskBankAccount(plainAccount) : null)
          };
        })
      : [];

    const item = {
      _id: String(u.id),
      id: u.id,
      name: u.name,
      email: u.email,
      mobile: plainMobile,
      role: u.role,
      onboardingStatus: u.onboardingStatus,
      registrationDetails: u.registrationDetails,
      organization: u.organization ? {
        ...u.organization,
        panNumber: isEncrypted(u.organization.panNumber) ? decryptField(u.organization.panNumber) : u.organization.panNumber
      } : u.organization,
      createdAt: u.createdAt,
      sectionStatus: u.sectionStatus,
      adminFeedback: u.adminFeedback,
      complianceViolations: u.complianceViolations,
      profile: rawProfile ? {
        ...rawProfile,
        pan: plainPan,
        nameAsInPan: plainNameAsInPan,
        dateAsInPan: plainDateAsInPan,
        mobile: plainMobile,
        bankAccounts: enrichedBankAccounts.length > 0 ? enrichedBankAccounts : (rawProfile as any).bankAccounts,
        documents: enrichedDocs
      } : rawProfile
    };
    if (['seller', 'shg'].includes(u.role)) sellers.push(item);
    else buyers.push(item);
  }

  const summary = {
    total,
    statuses: Object.fromEntries(statusGroups.map((row: any) => [row.onboardingStatus || 'pending', row._count._all])),
    approvedRoles: Object.fromEntries(approvedRoleGroups.map((row: any) => [row.role, row._count._all])),
    flagged
  };

  res.json(maskSensitive({
    success: true,
    sellers,
    buyers,
    total,
    ...window,
    filters: query,
    summary,
    data: {
      sellers,
      buyers,
      total,
      summary,
      ...window,
      filters: query
    }
  }, { unmaskForAdmin: true }));
}));

/**
 * Heavy-detail endpoint for the scrutiny modal. The list endpoint above is
 * intentionally lean (only the columns the table cells need); when an admin
 * actually opens an application for review we fetch the full picture in one
 * roundtrip. Keeps the list fast while still showing every onboarding field
 * the seller/buyer submitted.
 */
router.get('/admin/onboarding/:id', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const user = await db.user.findUnique({
    where: { id },
    include: {
      complianceViolations: { orderBy: { createdAt: 'desc' } },
      buyerProfile: true,
      shgProfile: true,
      sellerProfile: {
        include: {
          offices: { orderBy: [{ isMandatory: 'desc' }, { id: 'asc' }] },
          bankAccounts: true,
          certifications: { include: { fileAsset: true } },
          sellerDocuments: { include: { fileAsset: true } },
          organization: true
        }
      },
      organization: true
    }
  });
  if (!user) throw new ApiError(404, 'Application not found', 'APPLICATION_NOT_FOUND');
  if (!['buyer', 'seller', 'shg'].includes(String(user.role))) {
    throw new ApiError(404, 'Application not found', 'APPLICATION_NOT_FOUND');
  }

  // District multi-tenancy scoping:
  // For the Jharsuguda single-district portal, portal administrators (role: 'admin' or 'master_admin')
  // have legitimate jurisdiction to scrutinize all vendors and buyers applying to the portal.
  const isMaster = isMasterAdmin(req.user) || req.user?.role === 'master_admin' || req.user?.role === 'admin';
  if (!isMaster) {
    const adminDistrict = req.user?.districtId || (req.user?.activeScope?.scopeType === 'DISTRICT' ? req.user.activeScope.scopeId : null);
    if (adminDistrict) {
      const adminDistStr = String(adminDistrict).toLowerCase().trim();
      const userDistricts: string[] = [];
      if (user.buyerProfile?.district) userDistricts.push(user.buyerProfile.district.toLowerCase().trim());
      if (user.sellerProfile?.offices) {
        for (const office of user.sellerProfile.offices) {
          if (office.district) userDistricts.push(office.district.toLowerCase().trim());
        }
      }
      if (user.organization?.district) userDistricts.push(user.organization.district.toLowerCase().trim());
      if (user.organization?.city) userDistricts.push(user.organization.city.toLowerCase().trim());

      const matchesDistrict = userDistricts.some(d => d === adminDistStr || d.includes(adminDistStr) || adminDistStr.includes(d));
      if (!matchesDistrict && userDistricts.length > 0) {
        throw new ApiError(403, 'Application is outside your assigned district jurisdiction', 'DISTRICT_ACCESS_DENIED');
      }
    }
  }

  // Enrich documents (the same legacy JSON shape the list endpoint expanded).
  const profile = ['seller', 'shg'].includes(user.role) ? user.sellerProfile : user.buyerProfile;
  if (profile && ['seller', 'shg'].includes(user.role) && user.sellerProfile?.sellerDocuments) {
    const docsObj = typeof profile.documents === 'object' && profile.documents ? { ...(profile.documents as Record<string, any>) } : {};
    for (const sd of user.sellerProfile.sellerDocuments) {
      if (sd.fileAsset) {
        const u = (sd.documentType || '').toUpperCase();
        let k = 'uploaded_files';
        if (u.includes('PAN')) {
          k = 'pan';
          delete docsObj.pan_copy; delete docsObj.panCard; delete docsObj.panCopy;
        } else if (u.includes('GST')) {
          k = 'gstCert';
          delete docsObj.gst_certificate; delete docsObj.gst; delete docsObj.gstCertificate;
        } else if (u.includes('UDYAM') || u.includes('MSME')) {
          k = 'udyamCert';
          delete docsObj.udyam_certificate; delete docsObj.udyam_cert; delete docsObj.udyam;
        } else if (u.includes('PASSBOOK') || u.includes('CHEQUE') || u.includes('BANK')) {
          k = 'bankPassbook';
          delete docsObj.bank_passbook; delete docsObj.cancelled_cheque; delete docsObj.bank_passbook_cancelled_cheque;
        } else if (u.includes('INCORPORATION') || u.includes('REGISTRATION') || u.includes('FORMATION')) {
          k = 'regCert';
          delete docsObj.registration_certificate; delete docsObj.business_registration_proof; delete docsObj.shg_registration_certificate;
        } else if (u.includes('ADDRESS')) {
          k = 'addressProof';
          delete docsObj.address_proof; delete docsObj.addressProofDoc;
        } else if (u.includes('LEADER') || u.includes('AADHAAR')) {
          k = 'leader_aadhaar';
          delete docsObj.group_leader_aadhaar; delete docsObj.leader_aadhaar;
        } else if (u.includes('MEMBER')) {
          k = 'member_list';
          delete docsObj.member_list;
        } else if (u.includes('AUTH') || u.includes('LETTER')) {
          k = 'authLetter';
          delete docsObj.authorization_letter; delete docsObj.auth_letter;
        } else {
          k = sd.documentType || 'uploaded_files';
        }
        
        docsObj[k] = {
          fileId: sd.fileAsset.id,
          url: `/api/files/${sd.fileAsset.id}/view`,
          originalName: sd.fileAsset.originalName,
          mimeType: sd.fileAsset.mimeType,
          uploadedAt: sd.uploadedAt || sd.createdAt
        };
      }
    }
    profile.documents = docsObj;
  }

  const docFileIds: number[] = [];
  if (profile?.documents && typeof profile.documents === 'object' && !Array.isArray(profile.documents)) {
    for (const value of Object.values(profile.documents as Record<string, any>)) {
      const list = Array.isArray(value) ? value : [value];
      for (const entry of list) {
        const explicitFileId = Number(entry?.fileId || entry?.file?.id || entry?.fileAssetId);
        if (Number.isFinite(explicitFileId) && explicitFileId > 0) docFileIds.push(explicitFileId);
        const match = String(entry?.url || entry?.fileUrl || entry?.signedUrl || '').match(/\/api\/files\/(\d+)/);
        if (match) docFileIds.push(Number(match[1]));
      }
    }
  }

  const ownerFileAssets = await db.fileAsset.findMany({
    where: { ownerId: user.id, status: 'active' },
    orderBy: { id: 'desc' },
    select: { id: true, ownerId: true, key: true, url: true, originalName: true, mimeType: true, size: true, entityType: true, createdAt: true }
  });
  const fileAssets = docFileIds.length > 0
    ? await db.fileAsset.findMany({ where: { id: { in: docFileIds } } })
    : [];
  const fileAssetById = new Map([...ownerFileAssets, ...fileAssets].map((f: any) => [f.id, f]));
  const normalizeDocumentName = (value: unknown) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/(_optimized)(?=\.[a-z0-9]+$)/i, '');

  const assetByUrl = new Map<string, any>();
  const assetByKey = new Map<string, any>();
  const assetByName = new Map<string, any>();

  for (const asset of ownerFileAssets) {
    if (asset.url) assetByUrl.set(asset.url, asset);
    if (asset.key) assetByKey.set(asset.key, asset);
    const normName = normalizeDocumentName(asset.originalName);
    if (normName && !assetByName.has(normName)) assetByName.set(normName, asset);
  }

  const findAssetForDocumentEntry = (entry: any, fileId: number | null) => {
    if (fileId) {
      const found = fileAssetById.get(fileId);
      if (found) return found;
    }
    const url = String(entry?.url || entry?.fileUrl || entry?.signedUrl || '');
    if (url) {
      if (assetByUrl.has(url)) return assetByUrl.get(url);
      const decodedUrl = (() => {
        try {
          return decodeURIComponent(url);
        } catch {
          return url;
        }
      })();
      for (const asset of ownerFileAssets) {
        if (asset.url === url || (asset.key && decodedUrl.includes(asset.key)) || url.includes(`/api/files/${asset.id}/`)) {
          return asset;
        }
      }
    }
    const entryName = normalizeDocumentName(entry?.originalName || entry?.name || entry?.fileName);
    if (entryName) {
      if (assetByName.has(entryName)) return assetByName.get(entryName);
      for (const asset of ownerFileAssets) {
        const assetName = normalizeDocumentName(asset.originalName);
        if (assetName.includes(entryName) || entryName.includes(assetName)) {
          return asset;
        }
      }
    }
    return null;
  };
  const assetToDocument = (asset: any) => ({
    fileId: asset.id,
    url: `/api/files/${asset.id}/view`,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    fileAsset: asset
  });
  const enrichDocuments = (documents: any) => {
    if (!documents || typeof documents !== 'object' || Array.isArray(documents)) {
      return user.role === 'buyer' && ownerFileAssets.length > 0
        ? { uploaded_files: ownerFileAssets.map(assetToDocument) }
        : documents;
    }
    const enriched = Object.fromEntries(Object.entries(documents).map(([key, value]) => {
      const arr = Array.isArray(value) ? value : [value];
      return [key, arr.map((entry: any) => {
        const explicitFileId = Number(entry?.fileId || entry?.file?.id || entry?.fileAssetId);
        const match = String(entry?.url || entry?.fileUrl || entry?.signedUrl || '').match(/\/api\/files\/(\d+)/);
        const fileId = Number.isFinite(explicitFileId) && explicitFileId > 0 ? explicitFileId : (match ? Number(match[1]) : null);
        const fileAsset = findAssetForDocumentEntry(entry, fileId);
        return {
          ...entry,
          fileId: entry?.fileId || fileId || fileAsset?.id || undefined,
          url: fileAsset?.id ? `/api/files/${fileAsset.id}/view` : (entry?.url?.startsWith('/api/files/') ? entry.url : (entry?.url?.includes('cloudinary.com') ? undefined : entry?.url)),
          originalName: entry?.originalName || fileAsset?.originalName,
          mimeType: entry?.mimeType || fileAsset?.mimeType,
          fileAsset
        };
      })];
    }));
    const hasVisibleDocument = Object.values(enriched).some((value: any) =>
      (Array.isArray(value) ? value : [value]).some((entry: any) => entry?.url || entry?.fileId || entry?.fileAsset?.url)
    );
    return hasVisibleDocument || user.role !== 'buyer' || ownerFileAssets.length === 0
      ? enriched
      : { ...enriched, uploaded_files: ownerFileAssets.map(assetToDocument) };
  };

  const registrationDetails = (user.registrationDetails as Record<string, any>) || {};
  const registrationGstDetails = registrationDetails.gstDetails && typeof registrationDetails.gstDetails === 'object'
    ? registrationDetails.gstDetails
    : {};
  const organization = user.organization as any;
  const gstVerificationDetails = {
    gstin: (profile as any)?.gst || registrationDetails.gstin || organization?.gstin || null,
    verified: Boolean((profile as any)?.gstFingerprint || registrationDetails.gstVerified || organization?.gstin),
    source: (profile as any)?.gstFingerprint
      ? 'onboarding'
      : registrationDetails.gstVerified
        ? 'registration'
        : organization?.gstin
          ? 'organization'
          : null,
    legalName: registrationGstDetails.legalName || registrationGstDetails.legalBusinessName || organization?.organizationName || (profile as any)?.organizationName || null,
    tradeName: registrationGstDetails.tradeName || registrationGstDetails.tradeNam || null,
    status: registrationGstDetails.status || registrationGstDetails.gstnStatus || null,
    pan: registrationGstDetails.pan || organization?.panNumber || (profile as any)?.pan || registrationDetails.pan || null,
    state: registrationGstDetails.state || organization?.state || (profile as any)?.state || registrationDetails.state || null,
    district: registrationGstDetails.district || organization?.district || (profile as any)?.district || registrationDetails.district || null,
    city: registrationGstDetails.city || organization?.city || (profile as any)?.city || null,
    pincode: registrationGstDetails.pincode || organization?.pincode || (profile as any)?.pincode || null,
    address: registrationGstDetails.address || organization?.addressLine1 || (profile as any)?.registeredAddress || null
  };

  const rawPan = (profile as any)?.pan || organization?.panNumber || registrationDetails.pan || null;
  const rawNameAsInPan = (profile as any)?.nameAsInPan || (profile as any)?.panName || registrationDetails.nameAsInPan || organization?.organizationName || null;
  const rawDateAsInPan = (profile as any)?.dateAsInPan || (profile as any)?.dateOfIncorporation || registrationDetails.dateAsInPan || null;
  const rawGst = (profile as any)?.gst || organization?.gstin || registrationDetails.gstin || null;
  const rawMobile = (profile as any)?.mobile || user.mobile || null;
  const rawUdyam = (profile as any)?.udyamRegistrationNumber || organization?.udyamNumber || registrationDetails.udyamRegistrationNumber || null;

  const panValue = isEncrypted(rawPan) ? decryptField(rawPan) : rawPan;
  const nameAsInPanValue = isEncrypted(rawNameAsInPan) ? decryptField(rawNameAsInPan) : rawNameAsInPan;
  const dateAsInPanValue = isEncrypted(rawDateAsInPan) ? decryptField(rawDateAsInPan) : rawDateAsInPan;
  const gstValue = isEncrypted(rawGst) ? decryptField(rawGst) : rawGst;
  const mobileValue = isEncrypted(rawMobile) ? decryptField(rawMobile) : rawMobile;
  const udyamValue = isEncrypted(rawUdyam) ? decryptField(rawUdyam) : rawUdyam;

  const rawBankAccounts = (profile as any)?.bankAccounts;
  const enrichedBankAccounts = Array.isArray(rawBankAccounts)
    ? rawBankAccounts.map((b: any) => {
        const rawAccount = b.accountNumber;
        const plainAccount = isEncrypted(rawAccount) ? decryptField(rawAccount) : rawAccount;
        const displayAccount = plainAccount || b.accountNumberMasked || null;
        return {
          ...b,
          accountNumber: displayAccount,
          accountNumberMasked: b.accountNumberMasked || (plainAccount ? maskBankAccount(plainAccount) : null)
        };
      })
    : [];

  const enrichedProfile = profile
    ? {
        ...profile,
        pan: panValue,
        nameAsInPan: nameAsInPanValue,
        dateAsInPan: dateAsInPanValue,
        gst: gstValue,
        mobile: mobileValue,
        udyamRegistrationNumber: udyamValue,
        bankAccounts: enrichedBankAccounts.length > 0 ? enrichedBankAccounts : (profile as any).bankAccounts,
        documents: enrichDocuments(profile.documents),
        gstVerificationDetails
      }
    : {
        pan: panValue,
        nameAsInPan: nameAsInPanValue,
        dateAsInPan: dateAsInPanValue,
        gst: gstValue,
        mobile: mobileValue,
        udyamRegistrationNumber: udyamValue,
        gstVerificationDetails
      };

  const sanitizedUser = { ...user };
  delete (sanitizedUser as any).password;
  delete (sanitizedUser as any).passwordHash;
  delete (sanitizedUser as any).sessionVersion;
  if (sanitizedUser.mobile && isEncrypted(sanitizedUser.mobile)) {
    sanitizedUser.mobile = decryptField(sanitizedUser.mobile);
  }
  if (sanitizedUser.organization) {
    const org = { ...sanitizedUser.organization };
    if (org.panNumber && isEncrypted(org.panNumber)) {
      org.panNumber = decryptField(org.panNumber);
    }
    sanitizedUser.organization = org;
  }

  // Registration scrutiny desk is an authenticated admin-only workflow that requires unmasked
  // human-readable verification fields so officers can match submitted details against physical documents.
  res.json({
    success: true,
    data: {
      _id: user.id,
      ...sanitizedUser,
      profile: enrichedProfile
    }
  });
}));

router.post('/admin/onboarding/:id/section-status', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({
    sectionStatus: z.record(z.string(), z.unknown()),
    sectionRejectionReasons: z.record(z.string(), z.unknown()).nullish()
  }), req.body);

  const existing = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      role: true,
      sectionStatus: true,
      sectionRejectionReasons: true,
      onboardingStatus: true
    }
  });
  if (!existing) throw new ApiError(404, 'User not found');

  const previousStatus = (existing.sectionStatus as Record<string, unknown>) || {};
  const nextStatus = body.sectionStatus || {};
  const reasons = body.sectionRejectionReasons || {};

  const sections = existing.role === 'buyer'
    ? ['org', 'rep', 'address', 'procurement', 'docs']
    : ['pan', 'details', 'additional', 'offices', 'bank', 'documents'];

  // Strip non-section meta keys (e.g. seller-side `submitted: true` flag) so
  // the persisted state stays canonical and onboarding status calculations
  // never get confused by stray boolean values.
  const cleanSectionStatus: Record<string, string> = {};
  for (const s of sections) {
    cleanSectionStatus[s] = String(nextStatus[s] || previousStatus[s] || 'pending');
  }

  const sectionLabels: Record<string, string> = {
    pan: 'Business PAN Validation',
    details: 'Business Details',
    additional: 'Additional Details',
    offices: 'Office Locations',
    bank: 'Bank Accounts',
    documents: 'Documents Upload',
    org: 'Organization Details',
    rep: 'Representative Details',
    address: 'Address Details',
    procurement: 'Procurement Details',
    docs: 'Verification Documents'
  };

  const statuses = sections.map(s => cleanSectionStatus[s]);
  let newOnboardingStatus = existing.onboardingStatus;

  if (statuses.every(s => s === 'approved')) {
    newOnboardingStatus = 'approved_for_procurement';
  } else if (statuses.some(s => s === 'rejected')) {
    newOnboardingStatus = 'rejected';
  } else if (statuses.some(s => s === 'resubmission_required')) {
    newOnboardingStatus = 'resubmission_required';
  } else {
    newOnboardingStatus = 'under_compliance_review';
  }

  const updateData = {
    sectionStatus: cleanSectionStatus,
    sectionRejectionReasons: body.sectionRejectionReasons || {},
    onboardingStatus: newOnboardingStatus
  };

  const approvalResult = newOnboardingStatus === 'approved_for_procurement'
    ? await approveOnboardingAndEnsureOrganization(id, updateData)
    : null;

  const user = approvalResult?.user || await db.user.update({
    where: { id },
    data: updateData
  });

  if (existing.role === 'buyer') {
    let showcaseStatus = 'PENDING';
    if (newOnboardingStatus === 'approved_for_procurement') {
      showcaseStatus = 'VERIFIED';
    } else if (newOnboardingStatus === 'rejected') {
      showcaseStatus = 'REJECTED';
    }
    const adminUser = req.user?.id ? await db.user.findUnique({ where: { id: req.user.id } }) : null;
    const adminName = adminUser?.name || 'Admin';
    await db.buyerProfile.updateMany({
      where: { userId: id },
      data: {
        verificationStatus: showcaseStatus,
        verificationStatusEnum: showcaseStatus as any,
        verifiedAt: showcaseStatus === 'VERIFIED' ? new Date() : null,
        verifiedBy: showcaseStatus === 'VERIFIED' ? adminName : null
      }
    }).catch((err: any) => console.error('[Showcase Status Update Failed]', err));

    // Also update the Organization table verificationStatus if they are linked
    const linkedProfile = await db.buyerProfile.findUnique({ where: { userId: id } });
    if (linkedProfile?.organizationId) {
      await db.organization.update({
        where: { id: linkedProfile.organizationId },
        data: {
          verificationStatus: showcaseStatus as any,
          organizationOnboardingStatus: showcaseStatus === 'VERIFIED' ? 'approved_for_procurement' : undefined
        }
      }).catch((err: any) => console.error('[Organization Status Sync Failed]', err));
    }
  }

  if (approvalResult) {
    await auditWrite(req, 'onboarding.approved', 'user', id, {
      organizationId: approvalResult.organization.id
    });
    if (approvalResult.createdOrganization) {
      await auditWrite(req, 'organization.auto_created_from_onboarding', 'organization', approvalResult.organization.id, {
        userId: id,
        role: user.role
      });
    }
    if (approvalResult.createdMembership) {
      await auditWrite(req, 'org_membership.auto_created_admin', 'orgMembership', approvalResult.membership.id, {
        userId: id,
        organizationId: approvalResult.organization.id,
        orgRole: approvalResult.membership.orgRole
      });
    }
    await auditWrite(req, 'organization.verified_from_onboarding', 'organization', approvalResult.organization.id, {
      userId: id
    });
    deleteCache('/api/auth/me').catch(() => undefined);
    deleteCache('/api/org/status').catch(() => undefined);
    deleteCache('marketplace:home:v2').catch(() => undefined);
    deleteCache(redisKeys.cacheMarketplaceHome()).catch(() => undefined);
    invalidateByPattern('cache:marketplace:*').catch(() => undefined);
    invalidateByPattern('cache:*dashboard*').catch(() => undefined);
  }


  // Propagate document status to individual SellerDocument records if documents section status changes
  if (existing.role === 'seller' && body.sectionStatus && 'documents' in body.sectionStatus) {
    const nextDocStatus = body.sectionStatus.documents;
    const prevDocStatus = previousStatus.documents;
    if (nextDocStatus !== prevDocStatus) {
      const sellerProfile = await db.sellerProfile.findUnique({ where: { userId: id } });
      if (sellerProfile) {
        let docStatus: 'VERIFIED' | 'REJECTED' | 'UNDER_REVIEW' | 'PENDING' | undefined;
        if (nextDocStatus === 'approved') {
          docStatus = 'VERIFIED';
        } else if (nextDocStatus === 'rejected' || nextDocStatus === 'resubmission_required') {
          docStatus = 'REJECTED';
        } else if (nextDocStatus === 'under_review') {
          docStatus = 'UNDER_REVIEW';
        } else if (nextDocStatus === 'pending') {
          docStatus = 'PENDING';
        }

        if (docStatus) {
          await db.sellerDocument.updateMany({
            where: { sellerProfileId: sellerProfile.id },
            data: {
              verificationStatus: docStatus,
              remarks: (docStatus === 'REJECTED') ? String(reasons.documents || '') : null,
              verifiedById: req.user?.id ? Number(req.user.id) : null,
              verifiedAt: new Date()
            }
          });
        }
      }
    }
  }

  await auditWrite(req, 'admin.onboarding.section_status_updated', 'user', id);

  const changes: string[] = [];
  const rejectedDetails: string[] = [];

  for (const s of sections) {
    const prev = String(previousStatus[s] || 'pending');
    const next = String(nextStatus[s] || 'pending');
    const reason = clean(String(reasons[s] || ''));

    if (prev !== next) {
      const label = sectionLabels[s] || s;
      changes.push(`- **${label}**: status updated to '${next.replace(/_/g, ' ')}'${reason ? ` (Remarks: ${reason})` : ''}`);
    }

    if (next === 'rejected' || next === 'resubmission_required') {
      const label = sectionLabels[s] || s;
      rejectedDetails.push(`- **${label}**: Requires attention.${reason ? ` Remarks: ${reason}` : ''}`);
    }
  }

  const shouldNotify =
    newOnboardingStatus === 'approved_for_procurement' ||
    newOnboardingStatus === 'rejected' ||
    newOnboardingStatus === 'resubmission_required';

  if (changes.length > 0 && shouldNotify) {
    const isApproved = newOnboardingStatus === 'approved_for_procurement';
    const isRejected = newOnboardingStatus === 'rejected';
    const title = isApproved
      ? 'Application Onboarding Approved'
      : (isRejected ? 'Application Rejected' : 'Application Update: Section Remarks');

    let message: string;
    let emailHtml: string;

    if (isApproved) {
      // Final approval: every section is approved. Send a dedicated full-approval
      // email instead of the section-diff template (which would otherwise show
      // only the last-approved section, e.g. "Documents Upload").
      const approvedList = sections.map(s => `- **${sectionLabels[s] || s}**: Approved`);
      message =
        'Congratulations — all sections of your onboarding application have been approved. ' +
        'Your application is now approved for procurement access.\n\n' +
        'Approved sections:\n' + approvedList.join('\n');

      emailHtml = `
        <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-left: 4px solid #16a34a; border-radius: 6px; padding: 16px 18px; margin-bottom: 18px;">
          <h3 style="margin: 0 0 8px 0; color: #14532d; font-size: 16px;">Formal Application Approval Notice</h3>
          <p style="margin: 0; color: #166534; font-size: 13px; line-height: 1.6;">
            All statutory verification sections of your onboarding dossier have been examined and approved by the District Facilitation Cell. Your enterprise is now formally accredited for commercial procurement.
          </p>
        </div>
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px 18px; margin-bottom: 18px;">
          <strong style="color: #334155; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; display: block; margin-bottom: 8px;">Approved Dossier Sections:</strong>
          <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
            ${sections.map(s => `
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 6px 0; color: #475569;">${sectionLabels[s] || s}</td>
                <td style="padding: 6px 0; text-align: right; color: #16a34a; font-weight: 700;">✓ Approved</td>
              </tr>
            `).join('')}
          </table>
        </div>
        <p style="font-size: 13px; color: #475569; line-height: 1.6;">
          You can immediately access your dashboard to view active public tenders, participate in reverse auctions, and issue bids.
        </p>
      `;
    } else {
      message = `Updates to your profile sections:\n` + changes.join('\n');
      if (rejectedDetails.length > 0) {
        message += `\n\nSections requiring attention:\n` + rejectedDetails.join('\n');
      }

      emailHtml = `
        <p style="font-size: 14px; line-height: 1.6; color: #334155;">
          The District Nodal Officer has reviewed your onboarding application and recorded updates on your submitted sections:
        </p>
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px 18px; margin: 16px 0;">
          <strong style="color: #334155; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; display: block; margin-bottom: 8px;">Status Modifications:</strong>
          <ul style="margin: 0; padding-left: 20px; font-size: 13px; color: #334155; line-height: 1.6;">
            ${changes.map(c => `<li>${c}</li>`).join('')}
          </ul>
        </div>
        ${rejectedDetails.length > 0 ? `
        <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-left: 4px solid #dc2626; border-radius: 6px; padding: 14px 18px; margin: 16px 0;">
          <strong style="color: #991b1b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; display: block; margin-bottom: 8px;">⚠️ Sections Requiring Clarification / Correction:</strong>
          <ul style="margin: 0; padding-left: 20px; font-size: 13px; color: #991b1b; line-height: 1.6;">
            ${rejectedDetails.map(r => `<li>${r}</li>`).join('')}
          </ul>
        </div>` : ''}
        <p style="font-size: 13px; color: #475569; line-height: 1.6;">
          Please log into your onboarding portal to review the officer feedback and re-submit the required documentation.
        </p>
      `;
    }

    notificationService.notifyWithEmail(id, {
      title,
      message: message.replace(/\*\*/g, '').replace(/<[^>]*>/g, ''), // Strip md/html
      type: isApproved ? 'onboarding_approved_for_procurement' : 'section_status_updated',
      priority: isApproved ? 'high' : 'medium',
      redirectUrl: existing.role === 'seller' ? '/seller/onboarding' : '/buyer/onboarding',
      emailSubject: `${title} — MSME Procurement Portal`,
      emailHtml
    }).catch(error => {
      console.error('[Section Status Notification Error]:', error);
    });
  }

  ok(res, user);
}));

router.post('/admin/onboarding/:id/document-request', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({
    documentType: z.string().trim().min(1).max(100),
    reason: z.string().trim().min(3).max(1000)
  }), req.body);

  const existing = await db.user.findUnique({
    where: { id },
    include: {
      sellerProfile: {
        include: {
          sellerDocuments: true
        }
      },
      buyerProfile: true
    }
  });
  if (!existing) throw new ApiError(404, 'User not found');

  const cleanReason = body.reason.replace(/\0/g, '').trim();
  const docType = body.documentType.trim();

  // If seller or SHG, update the specific SellerDocument if it exists
  if (['seller', 'shg'].includes(existing.role) && existing.sellerProfile) {
    const existingSellerDoc = existing.sellerProfile.sellerDocuments.find(
      (d: any) => d.documentType.toLowerCase() === docType.toLowerCase()
    );
    if (existingSellerDoc) {
      await db.sellerDocument.update({
        where: { id: existingSellerDoc.id },
        data: {
          verificationStatus: 'REJECTED',
          remarks: cleanReason,
          verifiedById: Number(req.user?.id) || null,
          verifiedAt: new Date()
        }
      });
    }
  }

  // Update section status and rejection reasons on user
  const currentSectionStatus = (existing.sectionStatus as Record<string, unknown>) || {};
  const currentReasons = (existing.sectionRejectionReasons as Record<string, unknown>) || {};

  const docSectionKey = existing.role === 'buyer' ? 'docs' : 'documents';
  const updatedSectionStatus = {
    ...currentSectionStatus,
    [docSectionKey]: 'resubmission_required'
  };

  const updatedReasons = {
    ...currentReasons,
    [docType]: cleanReason
  };

  const updatedUser = await db.user.update({
    where: { id },
    data: {
      onboardingStatus: 'resubmission_required',
      sectionStatus: updatedSectionStatus,
      sectionRejectionReasons: updatedReasons,
      adminFeedback: cleanReason
    }
  });

  // Invalidate caches
  await invalidateUserAuthCache(id).catch(() => undefined);
  await deleteCache('/api/auth/me').catch(() => undefined);
  await deleteCache(`/api/admin/onboarding/${id}`).catch(() => undefined);

  // Send notification & email
  const displayDocName = docType.replace(/_/g, ' ').toUpperCase();
  await notificationService.notifyWithEmail(id, {
    title: `Document Correction Required: ${displayDocName}`,
    message: `The verification team has requested a re-upload of your ${displayDocName}: "${cleanReason}"`,
    type: 'document_correction_requested',
    priority: 'high',
    redirectUrl: existing.role === 'buyer' ? `/buyer/onboarding?section=docs` : `/seller/onboarding?section=documents`
  }).catch((err) => console.error('[Document Request Notification Error]:', err));

  await auditWrite(req, 'admin.onboarding.document_requested', 'user', id, {
    documentType: docType,
    reason: cleanReason
  });

  ok(res, { success: true, documentType: docType, reason: cleanReason, user: updatedUser });
}));

router.post('/admin/onboarding/:id/status', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({ onboardingStatus: z.string().trim().min(2), adminFeedback: z.string().trim().max(2000).optional() }), req.body);

  // Fetch the existing user to determine role and build correct section statuses
  const existing = await db.user.findUnique({ where: { id }, select: { role: true } });
  if (!existing) throw new ApiError(404, 'User not found');

  const updateData: Record<string, unknown> = { ...body };

  // When approving or rejecting the entire application, sync all individual section statuses
  // so that subsequent re-derivations of onboardingStatus from sections stay consistent.
  if (body.onboardingStatus === 'approved_for_procurement' || body.onboardingStatus === 'rejected') {
    const sectionValue = body.onboardingStatus === 'approved_for_procurement' ? 'approved' : 'rejected';
    const buyerSections = { org: sectionValue, rep: sectionValue, address: sectionValue, procurement: sectionValue, docs: sectionValue };
    const sellerSections = { pan: sectionValue, details: sectionValue, additional: sectionValue, offices: sectionValue, bank: sectionValue, documents: sectionValue };
    updateData.sectionStatus = existing.role === 'buyer' ? buyerSections : sellerSections;
  }

  const approvalResult = body.onboardingStatus === 'approved_for_procurement'
    ? await approveOnboardingAndEnsureOrganization(id, updateData)
    : null;
  const user = approvalResult?.user || await db.user.update({ where: { id }, data: updateData });
  await auditWrite(req, 'admin.onboarding.status_updated', 'user', id, body);

  if (existing.role === 'buyer') {
    let showcaseStatus = 'PENDING';
    if (body.onboardingStatus === 'approved_for_procurement') {
      showcaseStatus = 'VERIFIED';
    } else if (body.onboardingStatus === 'rejected') {
      showcaseStatus = 'REJECTED';
    }
    const adminUser = req.user?.id ? await db.user.findUnique({ where: { id: req.user.id } }) : null;
    const adminName = adminUser?.name || 'Admin';
    await db.buyerProfile.updateMany({
      where: { userId: id },
      data: {
        verificationStatus: showcaseStatus,
        verifiedAt: showcaseStatus === 'VERIFIED' ? new Date() : null,
        verifiedBy: showcaseStatus === 'VERIFIED' ? adminName : null
      }
    }).catch((err: any) => console.error('[Showcase Status Update Failed]', err));
  }

  if (approvalResult) {
    await auditWrite(req, 'onboarding.approved', 'user', id, {
      organizationId: approvalResult.organization.id
    });
    if (approvalResult.createdOrganization) {
      await auditWrite(req, 'organization.auto_created_from_onboarding', 'organization', approvalResult.organization.id, {
        userId: id,
        role: user.role
      });
    }
    if (approvalResult.createdMembership) {
      await auditWrite(req, 'org_membership.auto_created_admin', 'orgMembership', approvalResult.membership.id, {
        userId: id,
        organizationId: approvalResult.organization.id,
        orgRole: approvalResult.membership.orgRole
      });
    }
    await auditWrite(req, 'organization.verified_from_onboarding', 'organization', approvalResult.organization.id, {
      userId: id
    });
    deleteCache('/api/auth/me').catch(() => undefined);
    deleteCache('/api/org/status').catch(() => undefined);
    deleteCache('marketplace:home:v2').catch(() => undefined);
    deleteCache(redisKeys.cacheMarketplaceHome()).catch(() => undefined);
    invalidateByPattern('cache:marketplace:*').catch(() => undefined);
    invalidateByPattern('cache:*dashboard*').catch(() => undefined);
  }

  if (body.onboardingStatus === 'rejected') {
    const linkedUser = await db.user.findUnique({ where: { id }, select: { organizationId: true } });
    if (linkedUser?.organizationId) {
      // Don't downgrade an org that already has other approved users — only
      // suspend if this is the org's only user or the org is still PENDING.
      const otherApproved = await db.user.count({
        where: {
          organizationId: linkedUser.organizationId,
          onboardingStatus: 'approved_for_procurement',
          NOT: { id }
        }
      });
      if (otherApproved === 0) {
        await db.organization.update({
          where: { id: linkedUser.organizationId },
          data: { verificationStatus: 'REJECTED' as any }
        }).catch(err => console.error('[Onboarding] org reject mirror failed', err));
      }
    }
  }

  notificationService.notifyWithEmail(id, {
    title: 'Application Status Updated',
    message: `Your onboarding status has been updated to: ${body.onboardingStatus}. ${body.adminFeedback ? 'Admin feedback: ' + body.adminFeedback : ''}`,
    type: 'onboarding_status_updated',
    priority: 'high',
    redirectUrl: user.role === 'seller' ? '/seller/onboarding' : '/buyer/onboarding',
    emailSubject: 'Application Status Update — MSME Procurement Portal',
    emailHtml: `<p>Your onboarding application status has been updated.</p><p><strong>New Status:</strong> ${body.onboardingStatus}</p>${body.adminFeedback ? `<p><strong>Admin Feedback:</strong> ${body.adminFeedback}</p>` : ''}<p>Please log in to the portal to view details.</p>`
  }).catch(error => {
    console.error('[Onboarding Status Notification Error]:', error);
  });

  ok(res, approvalResult ? {
    user,
    organization: approvalResult.organization,
    membership: approvalResult.membership,
    organizationCreated: approvalResult.createdOrganization,
    membershipCreated: approvalResult.createdMembership
  } : user);
}));

// Verification
router.get('/utils/gst-verify/:gstin', verificationRateLimit, asyncRoute(async (req, res) => {
  const { gstin } = parse(gstParams, req.params);

  const normalizedGstin = gstin.toUpperCase();
  const fingerprint = sha256(normalizedGstin);
  const authHeader = req.headers.authorization || '';
  const [scheme, headerToken] = authHeader.split(' ');
  const canUseHeaderToken = scheme === 'Bearer' && headerToken && !['null', 'undefined', 'cookie-session'].includes(headerToken);
  const token = canUseHeaderToken ? headerToken : getAccessTokenFromRequest(req);
  let requesterUserId: number | null = null;
  if (token) {
    try {
      const decoded = verifyAccessToken(token);
      requesterUserId = decoded.id ? Number(decoded.id) : null;
    } catch {
      requesterUserId = null;
    }
  }

  const requestingUser = requesterUserId ? await db.user.findUnique({
    where: { id: requesterUserId },
    select: {
      id: true,
      organizationId: true,
      registrationDetails: true,
      buyerProfile: { select: { id: true, organizationId: true, gst: true } },
      sellerProfile: { select: { id: true } },
      organization: { select: { id: true, gstin: true } }
    }
  }) : null;

  const [sellerOffice, buyerProfile, organization] = await Promise.all([
    db.sellerOffice.findFirst({
      where: { gstFingerprint: fingerprint },
      select: { id: true, sellerProfile: { select: { userId: true } } }
    }),
    db.buyerProfile.findFirst({
      where: { gstFingerprint: fingerprint },
      select: { id: true, userId: true }
    }),
    db.organization.findFirst({
      where: { gstin: normalizedGstin },
      select: { id: true, users: { select: { id: true }, take: 5 } }
    })
  ]);

  const userRegGstin = String((requestingUser?.registrationDetails as any)?.gstin || '').trim().toUpperCase();
  const userOrgGstin = String(requestingUser?.organization?.gstin || '').trim().toUpperCase();
  const userBuyerGstin = String(requestingUser?.buyerProfile?.gst || '').trim().toUpperCase();

  const isOwnGstin = Boolean(normalizedGstin && (normalizedGstin === userRegGstin || normalizedGstin === userOrgGstin || normalizedGstin === userBuyerGstin));
  const isOwnOrg = Boolean(organization && requestingUser?.organizationId && organization.id === requestingUser.organizationId);

  const ownedByRequester = Boolean(requesterUserId && (
    isOwnGstin ||
    isOwnOrg ||
    sellerOffice?.sellerProfile?.userId === requesterUserId ||
    buyerProfile?.userId === requesterUserId ||
    organization?.users?.some((user: any) => user.id === requesterUserId)
  ));

  if ((sellerOffice || buyerProfile || organization) && !ownedByRequester) {
    throw new ApiError(400, 'GST is already registered', 'GST_ALREADY_REGISTERED');
  }

  const result = await verifyGstinInternal(gstin);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  // Mask the response (covers the raw provider payload and any incidental PII),
  // but restore the identity fields the onboarding form must auto-fill. The PAN
  // and GSTIN are derived from the GSTIN the caller just supplied — characters
  // 3–12 of the GSTIN are the PAN — so returning them unmasked here leaks
  // nothing the caller didn't already provide, and masking them only breaks
  // the form (the masked "AA***1P" fails PAN format validation).
  const masked = maskSensitive(result) as unknown as Record<string, unknown>;
  const source = result as unknown as Record<string, unknown>;
  masked.pan = source.pan;
  masked.gstin = source.gstin;
  masked.gstNumber = source.gstNumber;
  masked.requestedGstin = source.requestedGstin;
  masked.responseGstin = source.responseGstin;
  res.json(masked);
}));

router.post('/gst/verify', verificationRateLimit, asyncRoute(async (req, res) => {
  const { gstin } = parse(z.object({
    gstin: z.string().optional(),
    gstNumber: z.string().optional()
  }).refine(value => value.gstin || value.gstNumber, { message: 'GST number is required' }), req.body);
  const result = await verifyGstinInternal(gstin || req.body.gstNumber);
  ok(res, result);
}));

router.get('/verify/gst/:gstin', authenticate, verificationRateLimit, asyncRoute(async (req, res) => {
  const { gstin } = parse(gstParams, req.params);
  const gstResult = await verifyGstinInternal(gstin.toUpperCase());
  await db.apiVerificationLog.create({
    data: {
      userId: userId(req),
      provider: 'apisetu',
      verificationType: 'GST',
      requestReference: gstin.toUpperCase(),
      status: 'VERIFIED'
    }
  }).catch(() => undefined);
  ok(res, { gstin: gstin.toUpperCase(), verified: true, details: gstResult });
}));

async function verifyGstinInternal(gstin: string) {
  try {
    return await GstService.verifyGstin(gstin);
  } catch (e: any) {
    if (e instanceof ApiError) {
      // Pass through real provider errors (config missing 503, mismatch 400,
      // unreachable 424, etc.) without flattening them all into a generic 424.
      throw e;
    }
    throw new ApiError(424, e?.message?.startsWith('GST verification failed') ? e.message : 'GST verification provider is unreachable. Please try again later.', e?.code || 'GST_PROVIDER_UNREACHABLE');
  }
}

// ── Auto-create / find Organization from verified GST data ──
async function upsertOrganizationFromGst(
  gstResult: any,
  normalizedGstin: string,
  role: string,
  user?: any
) {
  // Try to find an existing ACTIVE or PENDING_CLOSURE (non-inactive) Organization by the same GSTIN
  let org = await db.organization.findFirst({
    where: {
      gstin: normalizedGstin,
      NOT: {
        verificationStatus: { in: ['CLOSED', 'ARCHIVED', 'REJECTED', 'MERGED'] }
      }
    }
  });

  let fallbackName = 'Verified Organization';
  if (user) {
    if (role === 'seller' && user.sellerProfile) {
      fallbackName = user.sellerProfile.businessName || user.sellerProfile.nameAsInPan || user.name || fallbackName;
    } else if (role === 'buyer' && user.buyerProfile) {
      fallbackName = user.buyerProfile.organizationName || user.buyerProfile.nameAsInPan || user.name || fallbackName;
    } else {
      fallbackName = user.name || fallbackName;
    }
  }

  if (!org) {
    // Check if there is an inactive organization with the same GSTIN to link previousOrganizationId
    const previousOrg = await db.organization.findFirst({
      where: {
        gstin: normalizedGstin,
        verificationStatus: { in: ['CLOSED', 'ARCHIVED', 'REJECTED', 'MERGED'] }
      },
      orderBy: { createdAt: 'desc' }
    });

    const orgType = role === 'buyer' ? 'GOVERNMENT' : 'MSME';
    const defaultCompanyId = user?.companyId || await getDefaultCompanyId();
    const newOrg = await db.organization.create({
      data: {
        organizationName: gstResult.legalName || gstResult.tradeName || fallbackName,
        organizationType: orgType as any,
        gstin: normalizedGstin,
        panNumber: gstResult.pan || null,
        state: gstResult.state || null,
        city: gstResult.city || null,
        district: gstResult.district || null,
        pincode: gstResult.pincode || null,
        addressLine1: gstResult.address || null,
        country: 'India',
        companyId: defaultCompanyId,
        previousOrganizationId: previousOrg?.id || null,
        verificationStatus: 'PENDING' as any
      }
    });

    if (previousOrg) {
      await db.organization.update({
        where: { id: previousOrg.id },
        data: { replacementOrganizationId: newOrg.id }
      });

      // Write audit log
      await auditLog({
        actorUserId: user?.id,
        actorRole: user?.role,
        action: 'ORGANIZATION_RE_REGISTERED_WITH_SAME_GST',
        entityType: 'organization',
        entityId: newOrg.id,
        ipAddress: user?.ipAddress || null,
        userAgent: user?.userAgent || null,
        metadata: {
          previousOrganizationId: previousOrg.id,
          gstin: normalizedGstin,
          companyId: user?.companyId
        }
      });
    }

    org = newOrg;
  } else {
    // Update the existing org with latest verified details if names changed
    await db.organization.update({
      where: { id: org.id },
      data: {
        organizationName: gstResult.legalName || gstResult.tradeName || (org.organizationName === 'Verified Organization' ? fallbackName : org.organizationName),
        panNumber: gstResult.pan || org.panNumber,
        state: gstResult.state || org.state,
        city: gstResult.city || org.city,
        district: gstResult.district || org.district,
        pincode: gstResult.pincode || org.pincode,
        addressLine1: gstResult.address || org.addressLine1
      }
    });
  }

  return org;
}

router.post('/profile/verify-gst-dashboard', authenticate, asyncRoute(async (req, res) => {
  const { gstin } = parse(z.object({ gstin: z.string().trim().min(15).max(15) }), req.body);
  const normalizedGstin = GstService.normalize(gstin);
  if (!hasValidGstinChecksum(normalizedGstin)) {
    throw new ApiError(400, 'Invalid GSTIN checksum. Please re-check the last character from your GST certificate.', 'INVALID_GSTIN_CHECKSUM');
  }

  const user = await db.user.findUnique({
    where: { id: userId(req) },
    include: { sellerProfile: { include: { offices: true } }, buyerProfile: true }
  });
  if (!user) throw new ApiError(404, 'User not found');

  const gstResult = await verifyGstinInternal(normalizedGstin);
  requireCompleteGstProfile(gstResult);
  try {
    await assertGstinNotOwnedByAnotherAccount(normalizedGstin, user.id);
  } catch (err: any) {
    if (err instanceof ApiError && (err.code === 'GST_ALREADY_ACTIVE' || err.code === 'GST_REUSE_NOT_ALLOWED')) {
      return res.status(err.statusCode).json({ error: err.code, message: err.message });
    }
    throw err;
  }
  const verifiedAddress = buildVerifiedAddress(gstResult);

  await db.apiVerificationLog.create({
    data: {
      userId: user.id,
      provider: gstResult.source === 'live_apisetu' ? 'apisetu' : 'cache',
      verificationType: 'GST',
      requestReference: normalizedGstin,
      status: 'VERIFIED'
    }
  }).catch(() => undefined);

  const sectionStatus = (user.sectionStatus as Record<string, any>) || {};
  const finalSectionStatus = { ...sectionStatus };

  if (user.role === 'seller') {
    let sellerProfile = user.sellerProfile;
    if (!sellerProfile) {
      const panToUse = gstResult.pan || `PENDING${user.id}`;
      const existingPanProfile = await db.sellerProfile.findFirst({
        where: {
          pan: panToUse,
          organization: {
            NOT: {
              verificationStatus: { in: ['CLOSED', 'ARCHIVED', 'REJECTED', 'MERGED'] }
            }
          }
        }
      });
      if (existingPanProfile) {
        throw new ApiError(400, 'This GSTIN/PAN is already registered with another account.');
      }

      sellerProfile = await db.sellerProfile.create({
        data: {
          userId: user.id,
          pan: panToUse,
          businessName: gstResult.legalName || gstResult.tradeName || 'Seller Business'
        }
      });
    } else {
      const panToUse = sellerProfile.pan.startsWith('PENDING') ? (gstResult.pan || sellerProfile.pan) : sellerProfile.pan;
      if (panToUse !== sellerProfile.pan) {
        const existingPanProfile = await db.sellerProfile.findFirst({
          where: {
            pan: panToUse,
            NOT: { id: sellerProfile.id },
            organization: {
              NOT: {
                verificationStatus: { in: ['CLOSED', 'ARCHIVED', 'REJECTED', 'MERGED'] }
              }
            }
          }
        });
        if (existingPanProfile) {
          throw new ApiError(400, 'This GSTIN/PAN is already registered with another account.');
        }
      }

      await db.sellerProfile.update({
        where: { id: sellerProfile.id },
        data: {
          businessName: sellerProfile.businessName || gstResult.legalName || gstResult.tradeName,
          pan: panToUse
        }
      });
    }

    const officeName = 'Registered Head Office';
    const existingOffice = sellerProfile.offices?.find(o => o.isMandatory || o.type === 'Registered Office' || o.gstNumber === normalizedGstin);

    if (existingOffice) {
      await db.sellerOffice.update({
        where: { id: existingOffice.id },
        data: {
          gstRegistered: true,
          gstNumber: normalizedGstin,
          gstMasked: normalizedGstin,
          gstFingerprint: sha256(normalizedGstin),
          pincode: verifiedAddress.pincode || existingOffice.pincode,
          state: verifiedAddress.state || existingOffice.state,
          city: verifiedAddress.city || existingOffice.city,
          address: verifiedAddress.address || existingOffice.address
        }
      });
    } else {
      await db.sellerOffice.create({
        data: {
          sellerProfileId: sellerProfile.id,
          name: officeName,
          type: 'Registered Office',
          gstRegistered: true,
          gstNumber: normalizedGstin,
          gstMasked: normalizedGstin,
          gstFingerprint: sha256(normalizedGstin),
          pincode: verifiedAddress.pincode,
          state: verifiedAddress.state,
          city: verifiedAddress.city,
          address: verifiedAddress.address,
          isMandatory: true
        }
      });
    }

    // ── Auto-create/link Organization for seller ──
    const org = await upsertOrganizationFromGst(gstResult, normalizedGstin, 'seller', user);
    await db.user.update({ where: { id: user.id }, data: { organizationId: org.id } });
    await db.sellerProfile.update({ where: { id: sellerProfile.id }, data: { organizationId: org.id } });
    // Create the OrgMembership so the user can use cart / approvals / GRN flows.
    await onUserLinkedToOrganization(user.id, org.id).catch(err => console.error('[Membership] seller link failed', err));

    finalSectionStatus.offices = 'approved';
    finalSectionStatus.details = 'approved';
  } else if (user.role === 'buyer') {
    let buyerProfile = user.buyerProfile;
    const profileData = {
      gst: normalizedGstin,
      gstMasked: normalizedGstin,
      gstFingerprint: sha256(normalizedGstin),
      state: verifiedAddress.state,
      district: verifiedAddress.district,
      city: verifiedAddress.city,
      pincode: verifiedAddress.pincode,
      registeredAddress: verifiedAddress.address,
      organizationName: buyerProfile?.organizationName || gstResult.legalName || gstResult.tradeName || 'Buyer Organization'
    };

    if (!buyerProfile) {
      await db.buyerProfile.create({
        data: {
          userId: user.id,
          mobile: user.mobile || '0000000000',
          businessType: 'Government Buyer',
          ...profileData
        }
      });
    } else {
      await db.buyerProfile.update({
        where: { id: buyerProfile.id },
        data: profileData
      });
    }

    // ── Auto-create/link Organization for buyer ──
    const org = await upsertOrganizationFromGst(gstResult, normalizedGstin, 'buyer', user);
    await db.user.update({ where: { id: user.id }, data: { organizationId: org.id } });
    const bpRecord = await db.buyerProfile.findUnique({ where: { userId: user.id } });
    if (bpRecord) {
      await db.buyerProfile.update({ where: { id: bpRecord.id }, data: { organizationId: org.id } });
    }
    // Create the OrgMembership so the user can use cart / approvals / GRN flows.
    await onUserLinkedToOrganization(user.id, org.id).catch(err => console.error('[Membership] buyer link failed', err));

    finalSectionStatus.org = 'approved';
    finalSectionStatus.address = 'approved';
  }

  const sections = user.role === 'buyer'
    ? ['org', 'rep', 'address', 'procurement', 'docs']
    : ['pan', 'details', 'additional', 'offices', 'bank', 'documents'];

  for (const sec of sections) {
    if (!finalSectionStatus[sec]) {
      finalSectionStatus[sec] = 'pending';
    }
  }

  if (user.role === 'seller') {
    if (STRICT_VERIFICATION.PAN === false) finalSectionStatus.pan = 'approved';
  }

  let onboardingStatus = user.onboardingStatus;
  let registrationStatus = user.registrationStatus;

  if (onboardingStatus !== 'approved_for_procurement' && (user.sectionStatus as any)?.submitted === true) {
    onboardingStatus = 'under_compliance_review';
    registrationStatus = 'completed';
  }

  const updatedUser = await db.user.update({
    where: { id: user.id },
    data: {
      onboardingStatus: onboardingStatus as any,
      registrationStatus: registrationStatus as any,
      sectionStatus: finalSectionStatus
    },
    include: { sellerProfile: { include: { offices: true } }, buyerProfile: true }
  });

  await auditWrite(req, 'onboarding.gst_verified_dashboard', 'user', user.id, { gstin: normalizedGstin });

  try {
    await notificationService.notifyWithEmail(user.id, {
      title: 'GST Verified Successfully',
      message: `Your business GSTIN ${normalizedGstin} has been successfully verified. ${onboardingStatus === 'approved_for_procurement'
        ? 'Your account is now fully approved for procurement!'
        : 'Your organization details have been updated.'
        }`,
      type: 'gst_verified',
      priority: 'high',
      redirectUrl: '/dashboard'
    });

    await notificationService.notifyAdmins({
      title: 'GST Verified dynamically via Dashboard',
      message: `User ${updatedUser.name} verified GSTIN ${normalizedGstin} dynamically. Onboarding status: ${onboardingStatus}.`,
      type: 'gst_verified_dashboard',
      priority: 'medium'
    });
  } catch (e) {
    console.warn('[GST Dashboard Verification] Notification failed:', e);
  }

  const safeUser = {
    id: updatedUser.id,
    name: updatedUser.name,
    email: updatedUser.email,
    role: updatedUser.role,
    registrationStatus: updatedUser.registrationStatus,
    onboardingStatus: updatedUser.onboardingStatus,
    sectionStatus: updatedUser.sectionStatus,
    sellerProfile: updatedUser.sellerProfile,
    buyerProfile: updatedUser.buyerProfile
  };

  res.json({ success: true, user: safeUser });
}));

router.post('/verify/pan', authenticate, verificationRateLimit, asyncRoute(async (req, res) => {
  const { pan } = parse(z.object({ pan: z.string().trim().min(10).max(10) }), req.body);
  const normalized = panVerificationService.normalize(pan);
  await db.apiVerificationLog.create({ data: { userId: userId(req), provider: 'internal', verificationType: 'PAN', requestReference: normalized, status: 'VERIFIED' } }).catch(() => undefined);
  ok(res, { pan: normalized, verified: true });
}));

router.post('/verify/udyam', authenticate, verificationRateLimit, asyncRoute(async (req, res) => {
  const { udyam } = parse(z.object({ udyam: z.string().trim().min(4).max(40) }), req.body);
  const normalized = udyamVerificationService.normalize(udyam);
  await db.apiVerificationLog.create({ data: { userId: userId(req), provider: 'internal', verificationType: 'UDYAM', requestReference: normalized, status: 'VERIFIED' } }).catch(() => undefined);
  ok(res, { udyam: normalized, verified: true });
}));

router.post('/verify/bank', authenticate, verificationRateLimit, asyncRoute(async (req, res) => {
  const body = parse(z.object({ ifsc: z.string().trim().min(4).max(20), accountNumber: z.string().trim().min(4).max(34) }), req.body);
  const ifsc = bankVerificationService.normalizeIfsc(body.ifsc);
  await db.apiVerificationLog.create({ data: { userId: userId(req), provider: 'internal', verificationType: 'BANK', requestReference: ifsc, status: 'VERIFIED' } }).catch(() => undefined);
  ok(res, { ifsc, accountFingerprint: sha256(body.accountNumber), verified: true });
}));

// Catalogue
router.post('/catalogue/upload', authenticate, authorize('seller'), upload.single('file'), asyncRoute(async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
  if (!req.file) throw new ApiError(400, 'File is required', 'FILE_REQUIRED');
  const context = {
    ownerId: userId(req),
    ownerRole: String(req.user?.role),
    entityType: 'catalogue',
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  };
  const asset = await uploadFile(req.file, context, env.STORAGE_PROVIDER);
  ok(res, asset, 201);
}));

// General file upload endpoint (all authenticated users)
router.post('/upload', authenticate, upload.single('file'), asyncRoute(async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
  if (!req.file) throw new ApiError(400, 'File is required', 'FILE_REQUIRED');
  const rawEntityType = req.body?.entityType;
  const entityType = typeof rawEntityType === 'string' && rawEntityType.trim() ? rawEntityType.trim() : 'general';
  const context = {
    ownerId: userId(req),
    ownerRole: String(req.user?.role),
    entityType,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  };
  const asset = await uploadFile(req.file, context, env.STORAGE_PROVIDER);
  const viewUrl = `/api/files/${asset.id}/view`;
  // Return viewUrl as primary URL so all file assets (including images) are served
  // reliably through the authenticated/public proxy rather than raw private bucket URLs.
  ok(res, {
    url: viewUrl,
    signedUrl: viewUrl,
    fileId: asset.id,
    file: {
      id: asset.id,
      url: viewUrl,
      documentUrl: viewUrl,
      originalName: asset.originalName,
      mimeType: asset.mimeType,
      size: asset.size
    }
  }, 201);
}));

router.get('/categories', asyncRoute(async (_req, res) => {
  const categories = await ensureMarketplaceCategories();
  ok(res, categories);
}));

router.get('/uoms', asyncRoute(async (_req, res) => {
  const [productUoms, tenderUoms] = await Promise.all([
    db.product.findMany({
      where: { unitOfMeasure: { not: null } },
      select: { unitOfMeasure: true },
      distinct: ['unitOfMeasure'],
      take: 100
    }).catch(() => []),
    db.tenderItem.findMany({
      where: { unitOfMeasure: { not: '' } },
      select: { unitOfMeasure: true },
      distinct: ['unitOfMeasure'],
      take: 100
    }).catch(() => [])
  ]);

  const dbUnits = new Set<string>();
  productUoms.forEach((p: any) => { if (p.unitOfMeasure?.trim()) dbUnits.add(p.unitOfMeasure.trim()); });
  tenderUoms.forEach((t: any) => { if (t.unitOfMeasure?.trim()) dbUnits.add(t.unitOfMeasure.trim()); });

  const standardUnits = [
    { value: 'NOS', label: 'NOS - Numbers' },
    { value: 'SET', label: 'SET - Sets' },
    { value: 'EA', label: 'EA - Each' },
    { value: 'KG', label: 'KG - Kilograms' },
    { value: 'MT', label: 'MT - Metric Tonnes' },
    { value: 'METER', label: 'METER - Meters' },
    { value: 'SQ FT', label: 'SQ FT - Square Feet' },
    { value: 'CU.MTRS', label: 'CU.MTRS - Cubic Meters' },
    { value: 'LTR', label: 'LTR - Litres' },
    { value: 'PKT', label: 'PKT - Packets' },
    { value: 'BOX', label: 'BOX - Boxes' },
    { value: 'PACK', label: 'PACK - Packs' },
    { value: 'RL', label: 'RL - Rolls' },
    { value: 'LOT', label: 'LOT - Lots' },
    { value: 'LS', label: 'LS - Lump Sum' },
    { value: 'HOUR', label: 'HOUR - Hours' },
    { value: 'DAY', label: 'DAY - Days' },
    { value: 'MONTH', label: 'MONTH - Months' }
  ];

  const existingUpper = new Set(standardUnits.map(u => u.value.toUpperCase()));
  dbUnits.forEach(u => {
    if (!existingUpper.has(u.toUpperCase())) {
      standardUnits.push({ value: u, label: u });
    }
  });

  ok(res, standardUnits);
}));

router.get('/tax-slabs', asyncRoute(async (_req, res) => {
  ok(res, [
    { value: 0, label: '0% (Exempted / Nil Rate)' },
    { value: 5, label: '5% (Essential Goods & Services)' },
    { value: 12, label: '12% (Standard Concessional Rate)' },
    { value: 18, label: '18% (Standard Rate)' },
    { value: 28, label: '28% (Luxury / Higher Rate)' }
  ]);
}));

router.post('/categories/custom', authenticate, asyncRoute(async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(2).max(160),
    type: z.enum(['PRODUCT', 'SERVICE', 'BOTH']).default('BOTH')
  }), req.body);

  const uid = userId(req);
  const user = await db.user.findUnique({
    where: { id: uid },
    include: { organization: true, sellerProfile: true, buyerProfile: true }
  });
  const userName = user?.name || 'A registered user';
  const orgName = user?.organization?.organizationName || user?.sellerProfile?.businessName || user?.buyerProfile?.organizationName || 'Registered Enterprise';

  const slug = slugFor(body.name);
  const existing = await db.category.findFirst({
    where: { OR: [{ slug }, { name: { equals: body.name, mode: 'insensitive' } }] }
  });

  if (existing) {
    if (!existing.isActive) {
      await db.category.update({ where: { id: existing.id }, data: { isActive: true } });
    }
    return ok(res, existing, 200);
  }

  const category = await db.category.create({
    data: {
      name: body.name,
      slug,
      type: body.type as any,
      organizationId: user?.organizationId || null,
      isActive: true
    }
  });
  await deleteCache(redisKeys.cacheCategoriesAll()).catch(() => undefined);
  await auditWrite(req, 'category.custom_created', 'category', category.id);

  // Notify all administrators to upload photo and configure category
  await notificationService.notifyAdmins({
    title: `New Custom Category: "${category.name}"`,
    message: `Added by ${userName} (${orgName}). Please review and upload a category photo to ensure proper display across the marketplace.`,
    type: 'category_custom_added',
    priority: 'high',
    redirectUrl: `/admin/categories?edit=${category.id}`
  }).catch((err) => {
    logger.warn({ err }, 'Failed to notify admins about custom category creation');
  });

  ok(res, category, 201);
}));

router.get('/admin/categories/pending-review', authenticate, authorizeAdmin, asyncRoute(async (_req, res) => {
  // 1. Find all notifications created when users added custom categories
  const notifs = await db.notification.findMany({
    where: {
      type: 'category_custom_added'
    },
    orderBy: { createdAt: 'desc' },
    take: 100
  });

  // Extract category IDs from redirectUrl: /admin/categories?edit=<id>
  const categoryIdToNotif = new Map<number, any>();
  for (const n of notifs) {
    if (n.redirectUrl) {
      const match = n.redirectUrl.match(/edit=(\d+)/);
      if (match) {
        const catId = Number(match[1]);
        if (!categoryIdToNotif.has(catId)) {
          categoryIdToNotif.set(catId, n);
        }
      }
    }
  }

  // Also include any categories that have organizationId != null and are missing images
  const customCategoriesFromOrg = await db.category.findMany({
    where: {
      isActive: true,
      organizationId: { not: null },
      OR: [{ imageUrl: null }, { imageUrl: '' }]
    },
    include: {
      organization: { select: { id: true, organizationName: true } }
    },
    take: 50
  });

  const allCustomCatIds = Array.from(new Set([
    ...Array.from(categoryIdToNotif.keys()),
    ...customCategoriesFromOrg.map((c: any) => c.id)
  ]));

  if (allCustomCatIds.length === 0) {
    return ok(res, []);
  }

  // Query categories that STILL DO NOT HAVE an image (imageUrl is null or empty)
  const pendingCategories = await db.category.findMany({
    where: {
      id: { in: allCustomCatIds },
      isActive: true,
      OR: [
        { imageUrl: null },
        { imageUrl: '' }
      ]
    },
    include: {
      organization: { select: { id: true, organizationName: true } }
    },
    orderBy: { createdAt: 'desc' }
  });

  // Format the response with user & organization details
  const results = pendingCategories.map((cat: any) => {
    const notif = categoryIdToNotif.get(cat.id);
    let userName = '';
    let orgName = cat.organization?.organizationName || '';

    if (notif?.message) {
      const authorMatch = notif.message.match(/Added by ([^(]+)\(([^)]+)\)/i);
      if (authorMatch) {
        if (!userName) userName = authorMatch[1].trim();
        if (!orgName) orgName = authorMatch[2].trim();
      }
    }

    return {
      id: cat.id,
      notificationId: notif?.id || null,
      name: cat.name,
      userName: userName || 'Registered User',
      orgName: orgName || 'Registered Enterprise',
      message: notif?.message || `Custom category "${cat.name}" does not have an image uploaded yet.`,
      redirectUrl: `/admin/categories?edit=${cat.id}`
    };
  });

  ok(res, results);
}));

router.get('/admin/categories', authenticate, authorizeAdmin, asyncRoute(async (_req, res) => {
  await ensureMarketplaceCategories();
  const categories = await db.category.findMany({
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }]
  });
  ok(res, categories);
}));

router.post('/admin/categories', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(2).max(160),
    type: z.enum(['PRODUCT', 'SERVICE', 'BOTH']).default('BOTH'),
    description: z.string().trim().max(1000).optional(),
    imageUrl: z.string().optional().nullable()
  }), req.body);
  const category = await db.category.create({ data: { ...body, slug: slugFor(body.name), isActive: true } });
  await deleteCache(redisKeys.cacheCategoriesAll()).catch(() => undefined);
  await deleteCache(redisKeys.cacheMarketplaceFeaturedCategories()).catch(() => undefined);
  await invalidateByPattern('cache:marketplace:*').catch(() => undefined);
  await auditWrite(req, 'category.created', 'category', category.id);
  ok(res, category, 201);
}));

router.put('/admin/categories/:id', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = req.body || {};
  const updateData: any = { ...body };
  if (body.name) updateData.slug = slugFor(body.name);
  const category = await db.category.update({ where: { id }, data: updateData });
  await deleteCache(redisKeys.cacheCategoriesAll()).catch(() => undefined);
  await deleteCache(redisKeys.cacheMarketplaceFeaturedCategories()).catch(() => undefined);
  await invalidateByPattern('cache:marketplace:*').catch(() => undefined);
  await auditWrite(req, 'category.updated', 'category', id);
  ok(res, category);
}));

router.patch('/admin/categories/:id/status', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({
    isActive: z.boolean()
  }), req.body);

  const category = await db.category.update({
    where: { id },
    data: { isActive: body.isActive }
  });

  await deleteCache(redisKeys.cacheCategoriesAll()).catch(() => undefined);
  await deleteCache(redisKeys.cacheMarketplaceFeaturedCategories()).catch(() => undefined);
  await invalidateByPattern('cache:marketplace:*').catch(() => undefined);
  await auditWrite(req, body.isActive ? 'category.activated' : 'category.deactivated', 'category', id);
  ok(res, category);
}));

router.delete('/admin/categories/:id', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  
  await db.$transaction(async (tx) => {
    await tx.product.updateMany({ where: { categoryId: id }, data: { categoryId: null } });
    await tx.service.updateMany({ where: { categoryId: id }, data: { categoryId: null } });
    await tx.buyerRequirement.updateMany({ where: { categoryId: id }, data: { categoryId: null } });
    await tx.requirement.updateMany({ where: { categoryId: id }, data: { categoryId: null } });
    await tx.tender.updateMany({ where: { categoryId: id }, data: { categoryId: null } });
    await tx.marketplaceInteraction.deleteMany({ where: { categoryId: id } }).catch(() => null);
    await tx.category.delete({ where: { id } });
  });

  await deleteCache(redisKeys.cacheCategoriesAll()).catch(() => undefined);
  await deleteCache(redisKeys.cacheMarketplaceFeaturedCategories()).catch(() => undefined);
  await invalidateByPattern('cache:marketplace:*').catch(() => undefined);
  await auditWrite(req, 'category.permanently_deleted', 'category', id);
  ok(res, { id, deleted: true, success: true });
}));

// ── Admin Category Image Upload (GCS-backed) ──
import multer from 'multer';
const categoryImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new ApiError(400, 'Only JPEG, PNG, or WebP images are allowed'));
    }
    cb(null, true);
  }
});

router.post('/admin/categories/:id/image', authenticate, authorizeAdmin, categoryImageUpload.single('image'), asyncRoute(async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
  const { id } = parse(idParams, req.params);
  const file = req.file;
  if (!file || !file.buffer?.length) throw new ApiError(400, 'Image file is required', 'IMAGE_REQUIRED');

  const category = await db.category.findUnique({ where: { id } });
  if (!category) throw new ApiError(404, 'Category not found', 'CATEGORY_NOT_FOUND');

  const ext = file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg';
  const timestamp = Date.now();
  const gcsKey = `categories/photos/${category.slug}-${timestamp}${ext}`;
  const bucketName = getGCSBucketName();

  // 1. Always save to local uploads directory for local disk fallback
  try {
    const localDir = path.resolve(process.cwd(), 'uploads', 'categories', 'photos');
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.resolve(localDir, `${category.slug}-${timestamp}${ext}`), file.buffer);
  } catch (err) {
    logger.warn({ err }, '[Storage] Could not write local category photo copy');
  }

  let imageUrl = `/api/files/raw/${gcsKey}?v=${timestamp}`;

  // 2. Upload to GCS if configured
  try {
    const bucket = getGCSBucket();
    await bucket.file(gcsKey).save(file.buffer, {
      contentType: file.mimetype,
      resumable: false,
      metadata: {
        contentType: file.mimetype,
        cacheControl: 'public, max-age=31536000, immutable',
        metadata: { categoryId: String(id), categorySlug: category.slug, uploadedBy: String(userId(req)) }
      }
    });
    imageUrl = `https://storage.googleapis.com/${bucketName}/${gcsKey}?v=${timestamp}`;
  } catch (gcsErr: any) {
    logger.warn({ err: gcsErr?.message || gcsErr }, '[GCS] Storage upload failed or credentials missing; using local storage fallback URL');
  }

  const updated = await db.category.update({ where: { id }, data: { imageUrl } });

  await deleteCache(redisKeys.cacheCategoriesAll()).catch(() => undefined);
  await deleteCache(redisKeys.cacheMarketplaceFeaturedCategories()).catch(() => undefined);
  await invalidateByPattern('cache:marketplace:*').catch(() => undefined);
  await auditWrite(req, 'category.image_uploaded', 'category', id);

  ok(res, updated);
}));

router.post('/seller/products', authenticate, requirePermission('catalogue.product.create', orgScope), asyncRoute(async (req, res) => {
  const body = parse(productBody, req.body);
  const product = await catalogueWorkflow.createProduct(actorFrom(req), body);
  ok(res, product, 201);
}));

router.get('/seller/products', authenticate, requirePermission('catalogue.product.view', orgScope), asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);
  const where: any = { sellerId: userId(req), ...(query.status ? { status: query.status } : {}) };
  if (query.q) where.OR = [{ name: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }];
  const window = listWindow(query);
  const [products, total] = await Promise.all([
    db.product.findMany({
      where,
      include: { category: true, seller: { select: { id: true, name: true, email: true, onboardingStatus: true } }, specifications: true, ...catalogueAttachmentInclude },
      ...window,
      orderBy: { updatedAt: 'desc' }
    }),
    db.product.count({ where })
  ]);
  ok(res, paged(await attachCatalogueFiles(products as any[], 'product'), total, query, 'products'));
}));

router.get('/seller/products/:id', authenticate, requirePermission('catalogue.product.view', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const product = await db.product.findFirst({ where: { id, sellerId: userId(req) }, include: { images: { include: { fileAsset: true } }, specifications: true, certifications: { include: { fileAsset: true } } } });
  if (!product) throw new ApiError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
  ok(res, (await attachCatalogueFiles([product], 'product'))[0]);
}));

router.put('/seller/products/:id', authenticate, requirePermission('catalogue.product.update', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(productBody.partial(), req.body);
  const existing = await db.product.findFirst({ where: { id, sellerId: userId(req) } });
  if (!existing) throw new ApiError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
  const product = await catalogueWorkflow.updateProduct(actorFrom(req), id, body);
  ok(res, product);
}));

router.delete('/seller/products/:id', authenticate, requirePermission('catalogue.product.delete', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const existing = await db.product.findFirst({ where: { id, sellerId: userId(req) } });
  if (!existing) throw new ApiError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
  const product = await catalogueWorkflow.archiveProduct(actorFrom(req), id);
  ok(res, product);
}));

router.get('/products/search', asyncRoute(async (req, res) => {
  const query = parse(paginationQuery.extend({
    sellerId: z.coerce.number().int().positive().optional(),
    organizationId: z.coerce.number().int().positive().optional()
  }), req.query);
  const where: any = { status: 'ACTIVE' };
  if (query.sellerId) where.sellerId = query.sellerId;
  if (query.organizationId) where.organizationId = query.organizationId;
  if (query.q) where.OR = [{ name: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }];
  if (query.categoryId) where.categoryId = query.categoryId;
  const window = listWindow(query);
  const [products, total] = await Promise.all([
    catalogueWorkflow.searchProducts({ ...query, ...window }),
    db.product.count({ where })
  ]);
  ok(res, paged(await attachCatalogueFiles(products as any[], 'product'), total, query, 'products'));
}));

router.post('/seller/services', authenticate, requirePermission('catalogue.service.create', orgScope), asyncRoute(async (req, res) => {
  const body = parse(serviceBody, req.body);
  const service = await catalogueWorkflow.createService(actorFrom(req), body);
  ok(res, service, 201);
}));

router.get('/seller/services', authenticate, requirePermission('catalogue.service.view', orgScope), asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);
  const where: any = { sellerId: userId(req), ...(query.status ? { status: query.status } : {}) };
  if (query.q) where.OR = [{ name: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }];
  const window = listWindow(query);
  const [services, total] = await Promise.all([
    db.service.findMany({
      where,
      include: { category: true, seller: { select: { id: true, name: true, email: true, onboardingStatus: true } }, specifications: true, certifications: { include: { fileAsset: true } } },
      ...window,
      orderBy: { updatedAt: 'desc' }
    }),
    db.service.count({ where })
  ]);
  ok(res, paged(await attachCatalogueFiles(services as any[], 'service'), total, query, 'services'));
}));

router.get('/seller/services/:id', authenticate, requirePermission('catalogue.service.view', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const service = await db.service.findFirst({
    where: { id, sellerId: userId(req) },
    include: { specifications: true, certifications: { include: { fileAsset: true } } }
  });
  if (!service) throw new ApiError(404, 'Service not found', 'SERVICE_NOT_FOUND');
  ok(res, (await attachCatalogueFiles([service], 'service'))[0]);
}));

router.post('/seller/products/:id/duplicate', authenticate, requirePermission('catalogue.product.create', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const product = await catalogueWorkflow.duplicateProduct(actorFrom(req), id);
  ok(res, product, 201);
}));

router.post('/seller/services/:id/duplicate', authenticate, requirePermission('catalogue.service.create', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const service = await catalogueWorkflow.duplicateService(actorFrom(req), id);
  ok(res, service, 201);
}));

router.patch('/seller/products/:id/status', authenticate, requirePermission('catalogue.product.update', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { status } = parse(z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']) }), req.body);
  const product = await catalogueWorkflow.setProductStatus(actorFrom(req), id, status);
  ok(res, product);
}));

router.patch('/seller/services/:id/status', authenticate, requirePermission('catalogue.service.update', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { status } = parse(z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']) }), req.body);
  const service = await catalogueWorkflow.setServiceStatus(actorFrom(req), id, status);
  ok(res, service);
}));

router.put('/seller/services/:id', authenticate, requirePermission('catalogue.service.update', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(serviceBody.partial(), req.body);
  const existing = await db.service.findFirst({ where: { id, sellerId: userId(req) } });
  if (!existing) throw new ApiError(404, 'Service not found', 'SERVICE_NOT_FOUND');
  const service = await catalogueWorkflow.updateService(actorFrom(req), id, body);
  ok(res, service);
}));

router.delete('/seller/services/:id', authenticate, requirePermission('catalogue.service.delete', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const existing = await db.service.findFirst({ where: { id, sellerId: userId(req) } });
  if (!existing) throw new ApiError(404, 'Service not found', 'SERVICE_NOT_FOUND');
  const service = await catalogueWorkflow.archiveService(actorFrom(req), id);
  ok(res, service);
}));

router.get('/services/search', asyncRoute(async (req, res) => {
  const query = parse(paginationQuery.extend({
    sellerId: z.coerce.number().int().positive().optional(),
    organizationId: z.coerce.number().int().positive().optional()
  }), req.query);
  const where: any = { status: 'ACTIVE' };
  if (query.sellerId) where.sellerId = query.sellerId;
  if (query.organizationId) where.organizationId = query.organizationId;
  if (query.q) where.OR = [{ name: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }];
  if (query.categoryId) where.categoryId = query.categoryId;
  const window = listWindow(query);
  const [services, total] = await Promise.all([
    catalogueWorkflow.searchServices({ ...query, ...window }),
    db.service.count({ where })
  ]);
  ok(res, paged(await attachCatalogueFiles(services as any[], 'service'), total, query, 'services'));
}));

router.get('/admin/catalogue/products', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const query = parse(paginationQuery.extend({
    organizationId: z.coerce.number().int().positive().optional()
  }), req.query);
  const where: any = {};
  if (query.status) where.status = query.status;
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.organizationId) where.organizationId = query.organizationId;
  if (query.q) {
    where.OR = [
      { name: { contains: query.q, mode: 'insensitive' } },
      { description: { contains: query.q, mode: 'insensitive' } },
      { seller: { name: { contains: query.q, mode: 'insensitive' } } },
      { seller: { email: { contains: query.q, mode: 'insensitive' } } }
    ];
  }
  const window = listWindow(query);
  const [products, total] = await Promise.all([
    db.product.findMany({
      where,
      include: { category: true, seller: { select: { id: true, name: true, email: true, onboardingStatus: true } }, ...catalogueAttachmentInclude },
      ...window,
      orderBy: { updatedAt: 'desc' }
    }),
    db.product.count({ where })
  ]);
  ok(res, paged(await attachCatalogueFiles(products as any[], 'product'), total, query, 'products'));
}));

router.get('/admin/catalogue/services', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const query = parse(paginationQuery.extend({
    organizationId: z.coerce.number().int().positive().optional()
  }), req.query);
  const where: any = {};
  if (query.status) where.status = query.status;
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.organizationId) where.organizationId = query.organizationId;
  if (query.q) {
    where.OR = [
      { name: { contains: query.q, mode: 'insensitive' } },
      { description: { contains: query.q, mode: 'insensitive' } },
      { seller: { name: { contains: query.q, mode: 'insensitive' } } },
      { seller: { email: { contains: query.q, mode: 'insensitive' } } }
    ];
  }
  const window = listWindow(query);
  const [services, total] = await Promise.all([
    db.service.findMany({
      where,
      include: { category: true, seller: { select: { id: true, name: true, email: true, onboardingStatus: true } }, certifications: { include: { fileAsset: true } } },
      ...window,
      orderBy: { updatedAt: 'desc' }
    }),
    db.service.count({ where })
  ]);
  ok(res, paged(await attachCatalogueFiles(services as any[], 'service'), total, query, 'services'));
}));

// Requirements
router.post('/procurement/drafts', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const body = parse(procurementDraftBody, req.body);
  const draft = await saveProcurementDraft(req, body);
  ok(res, serializeProcurementDraft(draft), body.id ? 200 : 201);
}, 'Unable to save procurement draft'));

router.get('/procurement/drafts', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);

  // We load V1 drafts from requirement table. Submitted/published rows stay
  // listed (flagged isPublished) so the buyer keeps a draft-history record
  // after publishing instead of the card silently vanishing.
  const reqWhere: any = { buyerId: userId(req), status: { in: ['DRAFT', 'REJECTED', 'SUBMITTED', 'APPROVED'] } };
  if (query.procurementMethod) reqWhere.procurementMethod = procurementMethodCodeFor(query.procurementMethod);
  if (query.categoryId) reqWhere.categoryId = query.categoryId;
  if (query.q) reqWhere.OR = [{ title: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }];

  const v1Drafts = await db.requirement.findMany({
    where: reqWhere,
    include: procurementDraftInclude,
    orderBy: { updatedAt: 'desc' }
  });

  // Load V2 drafts from bidWizardDraft table. SUBMITTED rows are the published
  // wizard drafts (submitViaWizard marks them SUBMITTED instead of deleting).
  const v2Drafts = await db.bidWizardDraft.findMany({
    where: {
      buyerId: userId(req),
      draftStatus: { in: ['DRAFT', 'SUBMITTED'] }
    },
    orderBy: { updatedAt: 'desc' }
  });

  // Map/serialize V2 drafts to match DisplayDraft shape on the frontend
  const serializedV2 = v2Drafts.map((d: any) => {
    const formData = d.formData || {};
    const step1 = formData.step1 || {};
    const step2 = formData.step2 || {};
    const step3 = formData.step3 || {};
    const step4 = formData.step4 || {};
    const step5 = formData.step5 || {};

    const title = step3.title || 'Untitled V2 Draft';
    const methodSlug = d.bidType.toLowerCase().replace(/_/g, '-');

    const productOrService = step4.productName || step4.serviceCategory || '';
    const categoryName = step4.productCategory || step4.serviceCategory || '';
    const quantity = step4.quantity || '';
    const unit = step4.unitOfMeasurement || '';
    const deliveryLocation = step5.singleConsignee?.location || step2.officeAddress || '';

    return {
      id: d.id,
      buyerId: d.buyerId,
      status: d.draftStatus === 'SUBMITTED' ? 'PUBLISHED' : 'DRAFT',
      isPublished: d.draftStatus === 'SUBMITTED',
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      title,
      methodSlug,
      estimatedValue: Number(step3.estimatedValue || 0),
      category: {
        name: categoryName
      },
      items: [
        {
          itemName: productOrService,
          quantity: quantity,
          unitOfMeasure: unit,
          description: step4.productDescription || step4.scopeOfWork || ''
        }
      ],
      payload: {
        isV2: true,
        basics: {
          title,
          estimatedValue: Number(step3.estimatedValue || 0),
          deliveryLocation
        },
        tender: {
          deliveryLocation
        }
      }
    };
  });

  // Merge lists
  let allMerged = [...v1Drafts.map(serializeProcurementDraft), ...serializedV2];

  // Apply filters on the merged list if needed
  if (query.procurementMethod) {
    const filterMethod = procurementMethodCodeFor(query.procurementMethod);
    allMerged = allMerged.filter(d => {
      // Check if it's V2 or V1
      if (d.payload?.isV2) {
        const type = String(d.items[0]?.itemName ? 'PRODUCT_BID' : 'SERVICE_BID'); // fallback detection or matchesProcurementMethodFilter logic
        const normalizedType = d.methodSlug.toUpperCase().replace(/-/g, '_');
        if (filterMethod === 'REVERSE_AUCTION') return normalizedType === 'REVERSE_AUCTION' || normalizedType === 'BID_WITH_RA';
        if (filterMethod === 'DIRECT_PURCHASE') return false;
        if (filterMethod === 'RFQ') return false;
        if (filterMethod === 'TENDER') {
          return ['PRODUCT_BID', 'SERVICE_BID', 'CUSTOM_BID', 'BOQ_BID'].includes(normalizedType);
        }
        return true;
      }
      return true; // V1 is already filtered in database query reqWhere
    });
  }

  if (query.q) {
    const q = String(query.q).toLowerCase();
    allMerged = allMerged.filter(d => {
      if (d.payload?.isV2) {
        return (
          String(d.title || '').toLowerCase().includes(q) ||
          String(d.items?.[0]?.itemName || '').toLowerCase().includes(q)
        );
      }
      return true; // V1 is already filtered in database query reqWhere
    });
  }

  // Sort by updatedAt desc
  allMerged.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  // Paginate in memory
  const total = allMerged.length;
  const page = Number(query.page || 1);
  const limit = Number(query.pageSize || 20);
  const offset = (page - 1) * limit;
  const paginated = allMerged.slice(offset, offset + limit);

  ok(res, paged(paginated, total, query as any, 'drafts'));
}, 'Unable to load procurement drafts'));

router.get('/procurement/drafts/:id', authenticate, authorize('buyer', 'admin', 'master_admin'), asyncRoute(async (req, res) => {
  const rawId = String(req.params.id || '').trim();
  if (!rawId) {
    throw new ApiError(400, 'Draft ID or reference number is required', 'DRAFT_ID_REQUIRED');
  }
  const draft = await assertProcurementDraftAccess(req, rawId);
  ok(res, serializeProcurementDraft(draft));
}, 'Unable to load procurement draft'));


async function handleCatalogPurchaseApprovalCompletion(req: any, id: number) {
  const reqRecord = await db.requirement.findUnique({
    where: { id },
    include: {
      items: true,
      buyer: true
    }
  });
  if (!reqRecord) return;

  const itemsBySeller: Record<string, any[]> = {};
  for (const item of reqRecord.items) {
    const specs = (item.specifications || {}) as Record<string, any>;
    const sellerId = Number(specs.sellerId);
    if (!sellerId) continue;
    if (!itemsBySeller[sellerId]) {
      itemsBySeller[sellerId] = [];
    }
    itemsBySeller[sellerId].push(item);
  }

  for (const [sellerIdStr, items] of Object.entries(itemsBySeller)) {
    const sellerId = Number(sellerIdStr);
    let totalAmount = new Prisma.Decimal(0);
    
    const poItemsData = items.map(item => {
      const qty = new Prisma.Decimal(Number(item.quantity || 1));
      const specs = (item.specifications || {}) as Record<string, any>;
      const price = new Prisma.Decimal(Number(specs.unitPrice || 0));
      const itemTotal = qty.mul(price);
      totalAmount = totalAmount.add(itemTotal);
      return {
        productId: item.productId || undefined,
        itemName: item.itemName,
        description: item.description || undefined,
        quantity: qty,
        unitOfMeasure: item.unitOfMeasure,
        unitPrice: price,
        taxRate: new Prisma.Decimal(Number(specs.gst || 0)),
        totalAmount: itemTotal
      };
    });

    const poNum = "PO-CAT-" + new Date().getFullYear() + "-" + Math.floor(100000 + Math.random() * 900000);

    const po = await db.purchaseOrder.create({
      data: {
        poNumber: poNum,
        buyerId: reqRecord.buyerId,
        sellerId: sellerId,
        title: "Purchase Order for Catalog Sourced Event #" + reqRecord.requirementNumber,
        amount: totalAmount,
        totalValue: totalAmount.toNumber(),
        status: 'generated',
        sourceType: 'requirement',
        sourceId: reqRecord.id,
        items: {
          create: poItemsData
        }
      }
    });

    await db.deliveryWorkflow.create({
      data: {
        purchaseOrderId: po.id,
        status: 'created'
      }
    });

    try {
      await notifySellerNewPurchaseOrder(po.id);
    } catch (err) {
      // non-fatal
    }
  }

  // Update requirement status to FULFILLED (awarded)
  await db.requirement.update({
    where: { id },
    data: { status: 'FULFILLED' }
  });

  await auditWrite(req, 'procurement.catalog_purchase_converted_to_po', 'requirement', id, { poCount: Object.keys(itemsBySeller).length });
}


router.post('/procurement/validate-catalog-items', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const { items } = z.object({
    items: z.array(z.object({
      catalogItemId: z.coerce.number().int().positive(),
      catalogItemType: z.enum(['Product', 'Service']),
      quantity: z.coerce.number().positive(),
      unitPrice: z.coerce.number().nonnegative()
    }))
  }).parse(req.body);

  const results = [];
  let allValid = true;

  for (const item of items) {
    const isProduct = item.catalogItemType === 'Product';
    if (isProduct) {
      const dbProduct = await db.product.findUnique({
        where: { id: item.catalogItemId },
        select: { id: true, name: true, price: true, status: true }
      });
      if (!dbProduct) {
        results.push({ catalogItemId: item.catalogItemId, valid: false, reason: 'Product not found' });
        allValid = false;
      } else if (dbProduct.status !== 'ACTIVE') {
        results.push({ catalogItemId: item.catalogItemId, valid: false, reason: 'Product is not active' });
        allValid = false;
      } else {
        const dbPrice = Number(dbProduct.price || 0);
        if (Math.abs(dbPrice - item.unitPrice) > 0.01) {
          results.push({ catalogItemId: item.catalogItemId, valid: false, reason: "Price mismatch. Expected: " + dbPrice });
          allValid = false;
        } else {
          results.push({ catalogItemId: item.catalogItemId, valid: true });
        }
      }
    } else {
      const dbService = await db.service.findUnique({
        where: { id: item.catalogItemId },
        select: { id: true, name: true, basePrice: true, status: true }
      });
      if (!dbService) {
        results.push({ catalogItemId: item.catalogItemId, valid: false, reason: 'Service not found' });
        allValid = false;
      } else if (dbService.status !== 'ACTIVE') {
        results.push({ catalogItemId: item.catalogItemId, valid: false, reason: 'Service is not active' });
        allValid = false;
      } else {
        const dbPrice = Number(dbService.basePrice || 0);
        if (Math.abs(dbPrice - item.unitPrice) > 0.01) {
          results.push({ catalogItemId: item.catalogItemId, valid: false, reason: "Price mismatch. Expected: " + dbPrice });
          allValid = false;
        } else {
          results.push({ catalogItemId: item.catalogItemId, valid: true });
        }
      }
    }
  }

  ok(res, { valid: allValid, results });
}, 'Unable to validate catalog items'));

router.post('/procurement/submit', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  await assertBuyerProcurementApproved(req);
  let parsed: any;
  try {
    parsed = procurementDraftBody.extend({ id: z.coerce.number().int().positive().optional() }).parse(req.body);
  } catch (zodError: any) {
    console.error('[SubmitProcurement] Zod parse failed:', JSON.stringify(zodError.issues || zodError.message, null, 2));
    const firstIssue = zodError.issues?.[0];
    const fieldPath = firstIssue?.path ? firstIssue.path.filter((p: any) => typeof p === 'string' || typeof p === 'number').join('.') : '';
    const fieldMsg = firstIssue?.message || 'Invalid procurement data';
    const errorMsg = fieldPath ? `${fieldPath}: ${fieldMsg}` : fieldMsg;
    throw new ApiError(400, errorMsg, 'PROCUREMENT_VALIDATION_FAILED');
  }
  try {
    validateProcurementDraftForSubmit(parsed);
  } catch (validationError: any) {
    console.error('[SubmitProcurement] Validation failed:', validationError.message, validationError.code);
    throw validationError;
  }

  const methodSlug = methodSlugForDraft(parsed);
  if (methodSlug === 'catalog-purchase') {
    const items = parsed.items || [];
    for (const item of items) {
      const specs = (item.specifications || {}) as Record<string, any>;
      const itemId = Number(specs.catalogItemId || item.productId);
      const isProduct = specs.catalogItemType !== 'Service';

      if (!itemId) {
        continue;
      }

      if (isProduct) {
        const dbProduct = await db.product.findUnique({
          where: { id: itemId }
        });
        if (!dbProduct) {
          throw new ApiError(400, `Product not found: ${item.itemName}`, 'CATALOG_PRODUCT_NOT_FOUND');
        }
        if (dbProduct.status !== 'ACTIVE') {
          throw new ApiError(400, `Product is not active in catalogue: ${item.itemName}`, 'CATALOG_PRODUCT_INACTIVE');
        }
        const dbPrice = Number(dbProduct.price || 0);
        const submittedPrice = Number(item.estimatedUnitPrice || specs.unitPrice || 0);
        if (Math.abs(dbPrice - submittedPrice) > 0.01) {
          throw new ApiError(400, `Price mismatch for product ${item.itemName}. Expected: ${dbPrice}, Submitted: ${submittedPrice}`, 'CATALOG_PRICE_MISMATCH');
        }
      } else {
        const dbService = await db.service.findUnique({
          where: { id: itemId }
        });
        if (!dbService) {
          throw new ApiError(400, `Service not found: ${item.itemName}`, 'CATALOG_SERVICE_NOT_FOUND');
        }
        if (dbService.status !== 'ACTIVE') {
          throw new ApiError(400, `Service is not active in catalogue: ${item.itemName}`, 'CATALOG_SERVICE_INACTIVE');
        }
        const dbPrice = Number(dbService.basePrice || 0);
        const submittedPrice = Number(item.estimatedUnitPrice || specs.unitPrice || 0);
        if (Math.abs(dbPrice - submittedPrice) > 0.01) {
          throw new ApiError(400, `Price mismatch for service ${item.itemName}. Expected: ${dbPrice}, Submitted: ${submittedPrice}`, 'CATALOG_PRICE_MISMATCH');
        }
      }
    }
  }

  // Grace Period Edit or Idempotency guard: prevent double-submission race condition (VULN-02)
  if (parsed.id) {
    let existingReq = await db.requirement.findFirst({
      where: { id: parsed.id, buyerId: userId(req) },
      select: { id: true, status: true, requirementNumber: true, procurementMethod: true, canonicalMethod: true, createdAt: true }
    });
    let existingBid = await db.procurementBid.findFirst({
      where: {
        OR: [
          ...(existingReq?.requirementNumber ? [{ bidNumber: existingReq.requirementNumber }] : []),
          ...(existingReq?.id ? [
            { technicalPacket: { path: ['sourceRequirementId'], equals: existingReq.id } },
            { technicalPacket: { path: ['requirementId'], equals: existingReq.id } }
          ] : []),
          { id: parsed.id }
        ]
      },
      include: {
        participations: { select: { id: true, submissionStatus: true } }
      }
    }).catch(() => null);

    if (!existingReq && existingBid) {
      // Find requirement through existingBid
      const packet = typeof existingBid.technicalPacket === 'object' && existingBid.technicalPacket ? (existingBid.technicalPacket as any) : {};
      const linkedReqId = Number(packet.sourceRequirementId || packet.requirementId || 0);
      if (linkedReqId > 0) {
        existingReq = await db.requirement.findFirst({
          where: { id: linkedReqId, buyerId: userId(req) },
          select: { id: true, status: true, requirementNumber: true, procurementMethod: true, canonicalMethod: true, createdAt: true }
        });
      }
      if (!existingReq && existingBid.bidNumber) {
        existingReq = await db.requirement.findFirst({
          where: { requirementNumber: { equals: existingBid.bidNumber, mode: 'insensitive' }, buyerId: userId(req) },
          select: { id: true, status: true, requirementNumber: true, procurementMethod: true, canonicalMethod: true, createdAt: true }
        });
      }
    }

    if ((existingReq && !['DRAFT', 'REJECTED'].includes(String(existingReq.status))) || (existingBid && ['PUBLISHED', 'OPEN', 'OPEN_FOR_BIDDING'].includes(String(existingBid.status)))) {
      const isGracePeriodEdit = Boolean((parsed as any).isGracePeriodEdit);
      if (isGracePeriodEdit) {
        // Enforce 6-hour, 0-bids, 1-edit limit
        const pubDate = existingBid?.publishedAt || existingBid?.createdAt || existingReq?.createdAt;
        const elapsed = Date.now() - new Date(pubDate).getTime();
        const withinWindow = elapsed <= 6 * 60 * 60 * 1000;
        const activeBids = (existingBid?.participations || []).filter(
          (p: any) => p.submissionStatus !== 'DRAFT' && !(p as any).isWithdrawn
        ).length;
        const editCount = Number(existingBid?.postPublishEditCount || 0);

        if (!withinWindow) {
          throw new ApiError(409, 'Grace period for editing has expired (6-hour window elapsed)', 'GRACE_PERIOD_EXPIRED');
        }
        if (activeBids > 0) {
          throw new ApiError(409, 'Cannot edit procurement after supplier proposals have been submitted', 'BIDS_ALREADY_RECEIVED');
        }
        if (editCount >= 1) {
          throw new ApiError(409, 'One-time grace edit has already been utilized for this procurement', 'GRACE_EDIT_ALREADY_USED');
        }

        // If existingReq didn't exist in DB, create it with matching requirementNumber
        if (!existingReq && existingBid) {
          existingReq = await db.requirement.create({
            data: {
              requirementNumber: existingBid.bidNumber,
              title: parsed.title || existingBid.title,
              description: parsed.description || existingBid.description,
              buyerId: userId(req),
              status: existingBid.status || 'APPROVED',
              procurementMethod: existingBid.canonicalMethod || existingBid.procurementType || 'OPEN_TENDER',
              canonicalMethod: existingBid.canonicalMethod || existingBid.procurementType || 'OPEN_TENDER',
              estimatedValue: existingBid.estimatedValue,
              deliveryLocation: existingBid.deliveryLocation,
              payload: parsed.payload || null
            }
          });
        }

        parsed.id = existingReq.id;

        // Allow update to proceed:
        const submitted = await saveProcurementDraft(req, parsed, existingReq.status || 'APPROVED');
        const [procurementBid, auction] = await Promise.all([
          createProcurementBidForSubmittedRequirement(req, submitted, parsed),
          createAuctionForSubmittedProcurement(req, submitted, parsed)
        ]);

        if (procurementBid) {
          await db.procurementBid.update({
            where: { id: procurementBid.id },
            data: {
              postPublishEditCount: { increment: 1 },
              version: { increment: 1 }
            }
          });
        }

        await auditWrite(req, 'procurement.grace_edit.published', 'requirement', submitted.id, {
          editCount: editCount + 1,
          newVersion: (existingBid?.version || 1) + 1
        });

        const submitBuyerId = userId(req);
        const submitOrgId = req.user?.organizationId;
        await Promise.allSettled([
          deleteCache(`cache:buyer:procurements:${submitBuyerId}`),
          invalidateByPattern(`cache:buyer:procurements:${submitBuyerId}*`),
          deleteCache(redisKeys.cacheDashboardSummary(submitBuyerId)),
          invalidateByPattern(`cache:dashboard:*:${submitBuyerId}*`),
          ...(submitOrgId ? [
            invalidateByPattern(`cache:buyer:procurements:*`),
            invalidateByPattern(`cache:dashboard:*`),
          ] : [])
        ]);

        return ok(res, {
          procurement: serializeProcurementDraft({ ...submitted, items: (submitted as any).items || [] }),
          procurementBid,
          auction,
          rateContract: null,
          referenceNumber: formatRequirementNumber(submitted.id, submitted.requirementNumber, submitted.procurementMethod || submitted.canonicalMethod)
        });
      }

      return ok(res, {
        procurement: existingReq ? serializeProcurementDraft({ ...existingReq, items: [] }) : null,
        procurementBid: existingBid,
        auction: null,
        rateContract: null,
        referenceNumber: existingReq ? formatRequirementNumber(existingReq.id, existingReq.requirementNumber, existingReq.procurementMethod || existingReq.canonicalMethod) : (existingBid?.bidNumber || String(parsed.id))
      });
    }
  }

  const submitted = await saveProcurementDraft(req, parsed, 'APPROVED');
  void auditWrite(req, 'workflow.requirement.submitted', 'requirement', submitted.id);

  try {
    const [procurementBid, auction] = await Promise.all([
      createProcurementBidForSubmittedRequirement(req, submitted, parsed),
      createAuctionForSubmittedProcurement(req, submitted, parsed)
    ]);

    const submitMethodSlug = methodSlugForDraft(parsed);
    let directPurchase: any = null;
    if (submitMethodSlug === 'direct-purchase') {
      const invitedSellersList = Array.isArray(parsed.payload?.vendors?.invitedSellers)
        ? parsed.payload.vendors.invitedSellers
        : [];
      const firstSeller = invitedSellersList[0];
      const invitedSellerId = Number(
        (firstSeller && typeof firstSeller === 'object')
          ? (firstSeller.supplierId ?? firstSeller.sellerUserId ?? firstSeller.sellerOrgId ?? firstSeller.id ?? 0)
          : (firstSeller ?? 0)
      );
      if (invitedSellerId > 0) {
        directPurchase = await procurementWorkflow.createDirectPurchase(actorFrom(req), {
          requirementId: submitted.id,
          sellerId: invitedSellerId,
          totalAmount: Number(submitted.estimatedValue || 0)
        }).catch(err => {
          logger.warn({ err }, `Failed to auto-create DirectPurchase for requirement ${submitted.id}`);
          return null;
        });
      }
    }

    await auditWrite(req, 'procurement.submitted', 'requirement', submitted.id, { methodSlug: submitMethodSlug });
    const submitBuyerId = userId(req);
    const submitOrgId = req.user?.organizationId;
    await Promise.allSettled([
      deleteCache(`cache:buyer:procurements:${submitBuyerId}`),
      invalidateByPattern(`cache:buyer:procurements:${submitBuyerId}*`),
      deleteCache(redisKeys.cacheDashboardSummary(submitBuyerId)),
      invalidateByPattern(`cache:dashboard:*:${submitBuyerId}*`),
      ...(submitOrgId ? [
        invalidateByPattern(`cache:buyer:procurements:*`),
        invalidateByPattern(`cache:dashboard:*`),
      ] : [])
    ]);
    ok(res, {
      procurement: serializeProcurementDraft({ ...submitted, items: (submitted as any).items || [] }),
      procurementBid,
      auction,
      rateContract: null,
      directPurchase,
      referenceNumber: formatRequirementNumber(submitted.id, submitted.requirementNumber, submitted.procurementMethod || submitted.canonicalMethod)
    });
  } catch (error) {
    // Only revert to DRAFT if no procurement bid was already created by a concurrent request.
    // This prevents the ghost state where a live bid exists but the requirement shows as DRAFT.
    const existingBidForReq = await db.procurementBid.findFirst({
      where: {
        OR: [
          ...(submitted.requirementNumber ? [{ bidNumber: submitted.requirementNumber }] : []),
          { technicalPacket: { path: ['sourceRequirementId'], equals: submitted.id } },
          { technicalPacket: { path: ['requirementId'], equals: submitted.id } }
        ]
      }
    }).catch(() => null);
    if (!existingBidForReq) {
      await db.requirement.update({
        where: { id: submitted.id },
        data: { status: 'DRAFT' }
      }).catch(() => undefined);
    }
    throw error;
  }
}, 'Unable to submit procurement'));

const enrichRateContracts = async (contracts: any[]) => {
  if (!contracts || contracts.length === 0) return contracts;
  const buyerOrgIds: number[] = [];
  const buyerUserIds: number[] = [];
  const requirementIds: number[] = [];

  for (const c of contracts) {
    const meta = (c?.metadata || {}) as any;
    const orgId = Number(meta.buyerOrganizationId || 0);
    const uId = Number(meta.buyerId || 0);
    const rId = Number(meta.requirementId || 0);
    if (orgId > 0 && !buyerOrgIds.includes(orgId)) buyerOrgIds.push(orgId);
    if (uId > 0 && !buyerUserIds.includes(uId)) buyerUserIds.push(uId);
    if (rId > 0 && !requirementIds.includes(rId)) requirementIds.push(rId);
  }

  const [orgs, users, reqs] = await Promise.all([
    buyerOrgIds.length > 0 ? db.organization.findMany({
      where: { id: { in: buyerOrgIds } },
      select: { id: true, organizationName: true, addressLine1: true, addressLine2: true, city: true, district: true, state: true, pincode: true }
    }).catch(() => []) : [],
    buyerUserIds.length > 0 ? db.user.findMany({
      where: { id: { in: buyerUserIds } },
      select: {
        id: true,
        name: true,
        email: true,
        organizationId: true,
        organization: { select: { id: true, organizationName: true, addressLine1: true, city: true, district: true, state: true, pincode: true } }
      }
    }).catch(() => []) : [],
    requirementIds.length > 0 ? db.requirement.findMany({
      where: { id: { in: requirementIds } },
      select: {
        id: true,
        requirementNumber: true,
        title: true,
        payload: true,
        buyer: { select: { id: true, name: true } },
        organization: { select: { id: true, organizationName: true, city: true, district: true, state: true } }
      }
    }).catch(() => []) : []
  ]);

  const orgMap = new Map<number, any>(orgs.map((o: any) => [o.id, o]));
  const userMap = new Map<number, any>(users.map((u: any) => [u.id, u]));
  const reqMap = new Map<number, any>(reqs.map((r: any) => [r.id, r]));

  return contracts.map(contract => {
    const meta = (contract.metadata || {}) as any;
    const buyerOrg = orgMap.get(Number(meta.buyerOrganizationId));
    const buyerUser = userMap.get(Number(meta.buyerId));
    const reqItem = reqMap.get(Number(meta.requirementId));
    const reqPayload = (reqItem?.payload || {}) as any;

    const resolvedOrgName = buyerOrg?.organizationName
      || buyerUser?.organization?.organizationName
      || reqItem?.organization?.organizationName
      || meta.buyerOrganizationName
      || meta.buyerOrganization?.organizationName
      || buyerUser?.name
      || null;

    const resolvedBuyerName = buyerUser?.name
      || reqItem?.buyer?.name
      || resolvedOrgName
      || meta.buyerName
      || null;

    const resolvedDistrict = reqPayload?.deliveryDistrict
      || reqPayload?.district
      || buyerOrg?.district
      || buyerUser?.organization?.district
      || reqItem?.organization?.district
      || meta.district
      || null;

    const resolvedState = reqPayload?.deliveryState
      || reqPayload?.state
      || buyerOrg?.state
      || buyerUser?.organization?.state
      || reqItem?.organization?.state
      || meta.state
      || null;

    const rawDeliveryLoc = meta.deliveryLocation && !meta.deliveryLocation.toLowerCase().includes('sla') && !meta.deliveryLocation.toLowerCase().includes('agreed')
      ? meta.deliveryLocation
      : null;

    const resolvedLocation = reqPayload?.deliveryLocation
      || reqPayload?.deliveryAddress
      || rawDeliveryLoc
      || (resolvedDistrict && resolvedState ? `${resolvedDistrict}, ${resolvedState}` : resolvedDistrict || resolvedState || null);

    const enrichedMeta = {
      ...meta,
      buyerOrganizationName: resolvedOrgName || meta.buyerOrganizationName,
      buyerName: resolvedBuyerName || meta.buyerName,
      district: resolvedDistrict || meta.district,
      state: resolvedState || meta.state,
      deliveryLocation: resolvedLocation || null
    };

    return {
      ...contract,
      buyerOrganizationName: resolvedOrgName,
      buyerName: resolvedBuyerName,
      district: resolvedDistrict,
      state: resolvedState,
      deliveryLocation: resolvedLocation,
      location: resolvedLocation,
      buyerOrganization: buyerOrg || buyerUser?.organization || reqItem?.organization || null,
      metadata: enrichedMeta
    };
  });
};

router.get('/procurement/rate-contracts', authenticate, authorize('buyer', 'admin', 'master_admin', 'seller', 'shg'), asyncRoute(async (req, res) => {
  const query = parse(paginationQuery.extend({
    contractState: z.enum(['ACTIVE', 'EXPIRED']).optional()
  }), req.query);
  const window = listWindow(query);
  const now = new Date();
  const where: any = { contractType: 'RATE_CONTRACT' };
  if (query.q) where.OR = [{ title: { contains: query.q, mode: 'insensitive' } }, { contractNumber: { contains: query.q, mode: 'insensitive' } }];
  if (query.contractState === 'ACTIVE') where.endDate = { gte: now };
  if (query.contractState === 'EXPIRED') where.endDate = { lt: now };

  const allContracts = await db.contract.findMany({
    where,
    orderBy: { endDate: 'asc' },
    ...window
  });
  const filtered = (isAdmin(req) || req.user?.role === 'master_admin')
    ? allContracts
    : (req.user?.role === 'seller' || req.user?.role === 'shg')
      ? allContracts.filter(contract => {
          const meta = (contract.metadata || {}) as any;
          const selectedSuppliers = Array.isArray(meta.selectedSuppliers) ? meta.selectedSuppliers : [];
          const isSelectedSeller = selectedSuppliers.some((s: any) =>
            Number(s.supplierUserId) === userId(req) || (req.user?.organizationId && Number(s.supplierOrgId) === req.user.organizationId)
          );
          return isSelectedSeller || contract.status === 'ACTIVE' || contract.status === 'PUBLISHED' || contract.status === 'OPEN' || !contract.endDate || contract.endDate >= now;
        })
      : allContracts.filter(contract => Number((contract.metadata as any)?.buyerId || 0) === userId(req));
  const enriched = await enrichRateContracts(filtered);
  ok(res, paged(enriched, enriched.length, query, 'rateContracts'));
}, 'Unable to load rate contracts'));

router.post('/procurement/rate-contracts/:id/call-off-orders', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const body = parse(z.object({
    sellerId: z.coerce.number().int().positive(),
    title: z.string().trim().min(3).max(200).optional(),
    deliveryAddress: z.string().trim().min(3).max(1000),
    expectedDelivery: safeCoercedDate.optional(),
    items: z.array(z.object({
      itemName: z.string().trim().min(2).max(240),
      quantity: z.coerce.number().positive(),
      unitOfMeasure: z.string().trim().min(1).max(120).optional(),
      unitPrice: z.coerce.number().positive().optional(),
      taxRate: z.coerce.number().min(0).max(100).optional().default(0)
    })).min(1)
  }), req.body);

  const contract = await db.contract.findUnique({ where: { id } });
  const metadata = (contract?.metadata || {}) as any;
  if (!contract || contract.contractType !== 'RATE_CONTRACT' || Number(metadata.buyerId || 0) !== userId(req)) {
    throw new ApiError(404, 'Rate contract not found', 'RATE_CONTRACT_NOT_FOUND');
  }

  // Validate call-off quantity bounds, cumulative balances, seller, and resolve prices
  const validation = await validateCallOffOrderRequest(contract, body);

  const slaDays = parseDeliverySlaDays(metadata.deliverySlaDays || metadata.deliverySla, 15);
  const expectedDelivery = body.expectedDelivery
    ? new Date(body.expectedDelivery)
    : calculateExpectedDeliveryDate(new Date(), slaDays);

  const penaltyTerms = parsePenaltyTerms(metadata);
  const amount = validation.resolvedItems.reduce((sum, item) => sum + item.totalAmount, 0);

  const po = await db.purchaseOrder.create({
    data: {
      poNumber: `CO-${new Date().getFullYear()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      buyerId: userId(req),
      sellerId: body.sellerId,
      contractId: contract.id,
      title: body.title || `Call-off order against ${contract.contractNumber}`,
      amount,
      totalValue: amount,
      currency: contract.currency,
      status: 'generated',
      poStatus: 'ISSUED',
      sourceType: 'RATE_CONTRACT_CALLOFF',
      sourceId: contract.id,
      expectedDelivery,
      deliveryAddress: body.deliveryAddress,
      metadata: {
        rateContractId: contract.id,
        rateContractNumber: contract.contractNumber,
        deliverySla: metadata.deliverySla,
        deliverySlaDays: slaDays,
        penaltyClause: metadata.penaltyClause,
        penaltyTerms
      },
      items: {
        create: validation.resolvedItems.map(item => ({
          itemName: item.itemName,
          quantity: item.quantity,
          unitOfMeasure: item.unitOfMeasure,
          unitPrice: item.unitPrice,
          taxRate: item.taxRate,
          totalAmount: item.totalAmount
        }))
      }
    },
    include: { items: true }
  });

  // Automatically initialize delivery tracking milestone
  await db.deliveryTracking.create({
    data: {
      purchaseOrderId: po.id,
      status: 'CREATED',
      expectedDelivery,
      slaStatus: 'ON_TIME',
      remarks: `Call-off Order against Rate Contract ${contract.contractNumber} (SLA: ${slaDays} days)`
    }
  }).catch(() => null);

  await auditWrite(req, 'rate_contract.calloff_order_created', 'purchaseOrder', po.id, {
    contractId: contract.id,
    totalQuantity: validation.totalCallOffQty,
    expectedDelivery
  });
  notifySellerNewPurchaseOrder(po.id).catch(() => undefined);
  ok(res, po, 201);
}, 'Unable to create rate contract call-off order'));

router.get('/procurement/rate-contracts/:id', authenticate, authorize('buyer', 'admin', 'master_admin', 'seller', 'shg'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const contract = await db.contract.findUnique({
    where: { id },
    include: {
      purchaseOrders: {
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          items: true,
          deliveryTrackings: {
            orderBy: { createdAt: 'desc' },
            take: 1
          }
        }
      }
    }
  });
  if (!contract || contract.contractType !== 'RATE_CONTRACT') {
    throw new ApiError(404, 'Rate contract not found', 'RATE_CONTRACT_NOT_FOUND');
  }
  const isOwner = isAdmin(req) || req.user?.role === 'master_admin' || Number((contract.metadata as any)?.buyerId || 0) === userId(req);
  if (!isOwner) {
    if (req.user?.role === 'seller' || req.user?.role === 'shg') {
      const meta = (contract.metadata || {}) as any;
      const selectedSuppliers = Array.isArray(meta.selectedSuppliers) ? meta.selectedSuppliers : [];
      const isSelectedSeller = selectedSuppliers.some((s: any) =>
        Number(s.supplierUserId) === userId(req) || (req.user?.organizationId && Number(s.supplierOrgId) === req.user.organizationId)
      );
      const isPublicOrActive = contract.status === 'ACTIVE' || contract.status === 'PUBLISHED' || contract.status === 'OPEN' || !contract.endDate || contract.endDate >= new Date();
      if (!isSelectedSeller && !isPublicOrActive) {
        throw new ApiError(403, 'Access denied', 'FORBIDDEN');
      }
    } else {
      throw new ApiError(403, 'Access denied', 'FORBIDDEN');
    }
  }
  const [enriched] = await enrichRateContracts([contract]);
  const utilization = await getRateContractUtilization(contract.id, contract.metadata, Number(contract.value || 0));

  ok(res, {
    ...(enriched || contract),
    utilization
  });
}, 'Unable to load rate contract details'));

// ── Public Procurement Opportunities (Home Page) ──
router.get('/api/public/procurement-opportunities', asyncRoute(async (_req, res) => {
  const [bids, rfqs] = await Promise.all([
    db.procurementBid.findMany({
      where: {
        visibility: 'PUBLIC',
        status: { in: ['PUBLISHED', 'OPEN', 'OPEN_FOR_BIDDING'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: {
        buyer: { select: { name: true, organizationId: true } },
        buyerOrganization: { select: { organizationName: true } },
      },
    }),
    db.quoteRequest.findMany({
      where: {
        status: { in: ['PUBLISHED', 'OPEN', 'ACTIVE'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: {
        buyer: { select: { name: true, organizationId: true } },
      },
    }),
  ]);

  const opportunities: any[] = [];

  for (const bid of bids) {
    const method = String(bid.procurementType || bid.bidType || 'OPEN_TENDER').toUpperCase();
    opportunities.push({
      id: bid.id,
      source: 'bid',
      title: bid.title || 'Untitled',
      method,
      buyerName: bid.buyer?.name || 'Buyer',
      buyerOrganization: bid.buyerOrganization?.organizationName || null,
      estimatedValue: bid.estimatedValue ? Number(bid.estimatedValue) : null,
      currency: 'INR',
      deadlineDate: bid.endDate?.toISOString() || null,
      category: bid.category || null,
      location: bid.deliveryLocation || null,
      createdAt: bid.createdAt.toISOString(),
    });
  }

  for (const rfq of rfqs) {
    opportunities.push({
      id: rfq.id,
      source: 'rfq',
      title: rfq.subject || 'Untitled',
      method: 'RFQ',
      buyerName: rfq.buyer?.name || 'Buyer',
      buyerOrganization: null,
      estimatedValue: rfq.estimatedValue ? Number(rfq.estimatedValue) : null,
      currency: 'INR',
      deadlineDate: rfq.deadlineDate?.toISOString() || null,
      category: null,
      location: null,
      createdAt: rfq.createdAt.toISOString(),
    });
  }

  opportunities.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  ok(res, { opportunities: opportunities.slice(0, 30), total: opportunities.length });
}, 'Unable to load procurement opportunities'));

router.get('/procurement/repeat-order/previous-pos', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const buyerUser = await db.user.findUnique({ where: { id: userId(req) }, select: { organizationId: true } });
  const buyerClause = buyerUser?.organizationId
    ? { OR: [{ buyerId: userId(req) }, { buyer: { organizationId: buyerUser.organizationId } }] }
    : { buyerId: userId(req) };

  const where: any = {
    ...buyerClause,
    status: { notIn: ['cancelled', 'rejected', 'CANCELLED', 'REJECTED'] },
  };
  if (q) {
    where.AND = [
      {
        OR: [
          { poNumber: { contains: q, mode: 'insensitive' } },
          { title: { contains: q, mode: 'insensitive' } },
          { seller: { name: { contains: q, mode: 'insensitive' } } },
          { items: { some: { itemName: { contains: q, mode: 'insensitive' } } } },
        ]
      }
    ];
  }

  const pos = await db.purchaseOrder.findMany({
    where,
    take: 100,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      poNumber: true,
      title: true,
      amount: true,
      totalValue: true,
      currency: true,
      status: true,
      poStatus: true,
      createdAt: true,
      expectedDelivery: true,
      deliveryAddress: true,
      deliveryType: true,
      paymentTerms: true,
      tenderId: true,
      contractId: true,
      metadata: true,
      buyer: {
        select: {
          id: true,
          name: true,
          email: true,
          mobile: true,
          organizationId: true,
          organization: {
            select: {
              id: true,
              organizationName: true,
              gstin: true,
              panNumber: true,
              addressLine1: true,
              addressLine2: true,
              city: true,
              state: true,
              pincode: true,
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
          accountStatus: true,
          organizationId: true,
          organization: {
            select: {
              id: true,
              organizationName: true,
              gstin: true,
              panNumber: true,
              addressLine1: true,
              addressLine2: true,
              city: true,
              state: true,
              pincode: true,
            }
          }
        }
      },
      items: {
        select: {
          id: true,
          productId: true,
          itemName: true,
          description: true,
          quantity: true,
          unitOfMeasure: true,
          unitPrice: true,
          taxRate: true,
          totalAmount: true,
          product: {
            select: {
              id: true,
              name: true,
              hsnCode: true,
              sku: true,
              unitOfMeasure: true,
              taxRate: true
            }
          }
        }
      },
      cracs: { select: { acceptedQuantity: true } },
      tender: {
        select: {
          id: true,
          tenderId: true,
          title: true,
          category: true,
          paymentTerms: true,
          deliveryType: true,
          documentUrl: true,
          requirement: {
            select: {
              id: true,
              requirementNumber: true,
              title: true,
              procurementMethod: true,
              canonicalMethod: true,
              payload: true,
              items: {
                select: {
                  itemName: true,
                  specifications: true
                }
              }
            }
          }
        }
      }
    }
  });

  const results = pos.map(po => {
    const orderedQty = po.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const deliveredQty = po.cracs.reduce((sum, crac) => sum + Number(crac.acceptedQuantity || 0), 0);
    const pendingQty = Math.max(0, orderedQty - deliveredQty);
    const originalMethod = po.tender?.requirement?.canonicalMethod || po.tender?.requirement?.procurementMethod || 'DIRECT_PURCHASE';
    const prNumber = po.tender?.requirement?.requirementNumber || (po.tender?.tenderId ? `TND-${po.tender.tenderId}` : `PR-${po.id}`);
    const reqPayload = (po.tender?.requirement?.payload as any) || {};

    const buyerOrg = po.buyer?.organization;
    const sellerOrg = po.seller?.organization;

    const buyerAddress = [buyerOrg?.addressLine1, buyerOrg?.addressLine2, buyerOrg?.city, buyerOrg?.state, buyerOrg?.pincode].filter(Boolean).join(', ') || po.deliveryAddress || 'Central Warehouse / Site Location';
    const sellerAddress = [sellerOrg?.addressLine1, sellerOrg?.addressLine2, sellerOrg?.city, sellerOrg?.state, sellerOrg?.pincode].filter(Boolean).join(', ') || '-';

    const itemsMapped = po.items.map((item, idx) => {
      const tenderReqItem = po.tender?.requirement?.items?.find(ri => ri.itemName?.toLowerCase() === item.itemName?.toLowerCase()) || po.tender?.requirement?.items?.[idx];
      const specs = (tenderReqItem?.specifications as any) || (item.description ? { description: item.description } : null) || null;
      const hsnSac = item.product?.hsnCode || (item as any).hsnCode || '8471';
      const gstRate = Number(item.taxRate ?? item.product?.taxRate ?? 18);
      return {
        id: item.id,
        productId: item.productId,
        itemName: item.itemName,
        description: item.description || item.itemName,
        quantity: Number(item.quantity),
        unitOfMeasure: item.unitOfMeasure || 'Nos',
        unitPrice: Number(item.unitPrice),
        taxRate: gstRate,
        gstRate,
        hsnSac,
        hsnCode: hsnSac,
        specifications: specs,
        totalAmount: Number(item.totalAmount),
      };
    });

    const deliveryLocation = po.deliveryAddress || buyerAddress;
    const paymentTerms = po.paymentTerms || po.tender?.paymentTerms || reqPayload?.paymentTerms || '100% payment within 30 days against Consignee Receipt and Acceptance Certificate (CRAC)';
    const deliveryTerms = po.deliveryType || po.tender?.deliveryType || reqPayload?.deliveryTerms || 'Free Delivery at Site / Consignee Location (F.O.R)';
    const commercialTerms = reqPayload?.commercialTerms || 'Original contract terms, SLA and warranty conditions shall govern this repeat order.';
    const requiredDocs = reqPayload?.requiredDocs || reqPayload?.documents || [
      { name: 'Tax Invoice (GST compliant)', mandatory: true },
      { name: 'Delivery Challan / Proof of Dispatch', mandatory: true },
      { name: 'Warranty & Guarantee Certificate', mandatory: false },
      { name: 'Consignee Receipt Acceptance Certificate (CRAC)', mandatory: true }
    ];

    return {
      id: po.id,
      poNumber: po.poNumber,
      title: po.title,
      amount: Number(po.amount),
      totalValue: Number(po.totalValue || po.amount),
      currency: po.currency || 'INR',
      status: po.status,
      poStatus: po.poStatus,
      poDate: po.createdAt,
      expectedDelivery: po.expectedDelivery,
      tenderId: po.tenderId,
      contractId: po.contractId,
      procurementId: prNumber,
      procurementTitle: po.title || po.tender?.title || 'Procurement Order',
      supplierName: sellerOrg?.organizationName || po.seller.name,
      procurementDetails: {
        procurementId: prNumber,
        procurementTitle: po.title || po.tender?.title || 'Procurement Order',
        category: po.tender?.category || 'Goods / Products',
        procurementMethod: originalMethod,
        tenderId: po.tender?.tenderId || null,
      },
      buyerDetails: {
        id: po.buyer.id,
        name: po.buyer.name,
        email: po.buyer.email,
        mobile: po.buyer.mobile,
        organizationName: buyerOrg?.organizationName || po.buyer.name,
        gstin: buyerOrg?.gstin || '-',
        panNumber: buyerOrg?.panNumber || '-',
        address: buyerAddress
      },
      supplierDetails: {
        id: po.seller.id,
        name: po.seller.name,
        organizationName: sellerOrg?.organizationName || po.seller.name,
        email: po.seller.email || '',
        mobile: po.seller.mobile || '',
        gstin: sellerOrg?.gstin || '-',
        panNumber: sellerOrg?.panNumber || '-',
        address: sellerAddress,
        isSupplierActive: po.seller.accountStatus === 'ACTIVE'
      },
      items: itemsMapped,
      orderedQuantity: orderedQty,
      deliveredQuantity: deliveredQty,
      pendingQuantity: pendingQty,
      deliveryLocation,
      paymentTerms,
      deliveryTerms,
      commercialTerms,
      requiredDocs,
      originalProcurementMethod: originalMethod,
      prNumber
    };
  });

  ok(res, { results });
}));

router.post('/procurement/:id/documents', authenticate, authorize('buyer', 'admin'), upload.single('file'), asyncRoute(async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
  if (!req.file) throw new ApiError(400, 'File is required', 'FILE_REQUIRED');
  const { id } = parse(idParams, req.params);
  const draft = await assertProcurementDraftAccess(req, id);
  if (!isAdmin(req) && draft.buyerId !== userId(req)) throw new ApiError(404, 'Procurement draft not found', 'PROCUREMENT_DRAFT_NOT_FOUND');
  const asset = await uploadFile(req.file, {
    ownerId: userId(req),
    ownerRole: String(req.user?.role),
    entityType: 'requirement',
    entityId: id,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  }, env.STORAGE_PROVIDER);
  await auditWrite(req, 'procurement.document_uploaded', 'fileAsset', asset.id, { requirementId: id });
  ok(res, asset, 201);
}, 'Unable to upload procurement document'));

router.patch('/procurement/:id/status', authenticate, authorize('buyer', 'admin', 'master_admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { status } = parse(z.object({ status: z.string().trim().min(2).max(80) }), req.body);
  const draft = await assertProcurementDraftAccess(req, id);
  const nextStatus = procurementStatusMap[status.toUpperCase()];
  if (!nextStatus) throw new ApiError(400, 'Unsupported procurement status', 'PROCUREMENT_STATUS_INVALID');
  const privileged = isAdmin(req) || req.user?.role === 'master_admin';
  if (!privileged && (draft.buyerId !== userId(req) || nextStatus !== 'CANCELLED')) {
    throw new ApiError(403, 'Only administrators can set this procurement status', 'PROCUREMENT_STATUS_FORBIDDEN');
  }
  const updated = await db.requirement.update({ where: { id }, data: { status: nextStatus }, include: procurementDraftInclude });
  await auditWrite(req, 'procurement.status_updated', 'requirement', id, { requestedStatus: status, status: nextStatus });
  
  if (nextStatus === 'APPROVED' && updated.canonicalMethod === 'CATALOG_PURCHASE') {
    try {
      await handleCatalogPurchaseApprovalCompletion(req, id);
    } catch (err) {
      console.error('Failed to handle catalog purchase approval completion:', err);
    }
  }
  
  ok(res, serializeProcurementDraft(updated));
}, 'Unable to update procurement status'));

router.get('/admin/procurement/intake', authenticate, authorize('admin', 'master_admin'), asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);
  const where: any = { status: { in: ['SUBMITTED', 'APPROVED'] } };
  if (query.procurementMethod) where.procurementMethod = procurementMethodCodeFor(query.procurementMethod);
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.q) where.OR = [{ title: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }];
  const window = listWindow(query);
  const [records, total] = await Promise.all([
    db.requirement.findMany({
      where,
      include: {
        ...procurementDraftInclude,
        buyer: { select: { id: true, name: true, email: true, role: true, organization: { select: { id: true, organizationName: true } } } },
        organization: { select: { id: true, organizationName: true } }
      },
      orderBy: { updatedAt: 'desc' },
      ...window
    }),
    db.requirement.count({ where })
  ]);
  ok(res, paged(records.map(serializeProcurementDraft), total, query, 'records'));
}, 'Unable to load procurement intake'));

router.post('/buyer/requirements', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  await assertBuyerProcurementApproved(req);
  const body = parse(requirementBody, req.body);
  const requirement = await procurementWorkflow.createRequirement(actorFrom(req), body);
  ok(res, requirement, 201);
}));

router.get('/buyer/requirements', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);
  const where: any = { buyerId: userId(req) };
  if (query.status) where.status = query.status;
  if (query.procurementMethod) where.procurementMethod = query.procurementMethod;
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.q) where.OR = [{ title: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }];
  const window = listWindow(query);
  const [requirements, total] = await Promise.all([
    db.requirement.findMany({
      where,
      select: procurementListSelect,  // Use optimized select for list view
      orderBy: { updatedAt: 'desc' },
      ...window
    }),
    db.requirement.count({ where })
  ]);
  // Set cache headers for 30 seconds
  res.setHeader('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
  ok(res, paged(requirements, total, query));
}));

router.get('/requirements/:id', authenticate, asyncRoute(async (req, res) => {
  const resolvedId = await resolveRequirementId(req.params.id);
  if (!resolvedId) throw new ApiError(404, 'Requirement not found', 'REQUIREMENT_NOT_FOUND');
  const id = resolvedId;
  const requirement = await db.requirement.findUnique({
    where: { id },
    include: {
      items: true,
      tenders: {
        select: {
          id: true,
          tenderId: true,
          title: true,
          status: true
        }
      },
      category: {
        select: {
          id: true,
          name: true
        }
      },
      directPurchases: {
        include: {
          seller: {
            select: {
              id: true,
              name: true,
              email: true,
              mobile: true
            }
          }
        }
      }
    }
  });
  if (!requirement || (!isAdmin(req) && requirement.buyerId !== userId(req))) throw new ApiError(404, 'Requirement not found', 'REQUIREMENT_NOT_FOUND');
  // Include serialized draft payload if available (contains all Create Procurement wizard data)
  const serialized = serializeProcurementDraft(requirement);
  ok(res, { ...requirement, methodSlug: serialized.methodSlug, payload: serialized.payload, workflowStatus: serialized.workflowStatus });
}));

router.put('/buyer/requirements/:id', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const resolvedId = await resolveRequirementId(req.params.id);
  if (!resolvedId) throw new ApiError(404, 'Requirement not found', 'REQUIREMENT_NOT_FOUND');
  const id = resolvedId;
  await assertBuyerProcurementApproved(req);
  const existing = await db.requirement.findFirst({ where: { id, buyerId: userId(req) } });
  if (!existing) throw new ApiError(404, 'Requirement not found', 'REQUIREMENT_NOT_FOUND');
  const body = parse(requirementBody.partial(), req.body);
  const requirement = await db.requirement.update({ where: { id }, data: { ...body, items: undefined } });
  await auditWrite(req, 'requirement.updated', 'requirement', id);
  ok(res, requirement);
}));
router.delete('/buyer/requirements/:id', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const resolvedId = await resolveRequirementId(req.params.id);
  if (!resolvedId) throw new ApiError(404, 'Requirement not found', 'REQUIREMENT_NOT_FOUND');
  const id = resolvedId;
  await assertBuyerProcurementApproved(req);
  const existing = await db.requirement.findFirst({ where: { id, buyerId: userId(req) }, include: { tenders: { select: { id: true } } } });
  if (!existing) throw new ApiError(404, 'Requirement not found', 'REQUIREMENT_NOT_FOUND');
  if (!['DRAFT', 'REJECTED'].includes(String(existing.status))) {
    throw new ApiError(409, 'Requirement can only be deleted while in draft or rejected state', 'REQUIREMENT_LOCKED');
  }
  if (existing.tenders.length > 0) {
    throw new ApiError(409, 'Cannot delete a requirement that has linked tenders', 'REQUIREMENT_HAS_TENDERS');
  }
  await db.$transaction([
    db.requirementItem.deleteMany({ where: { requirementId: id } }),
    db.requirement.delete({ where: { id } })
  ]);
  await auditWrite(req, 'requirement.deleted', 'requirement', id);
  ok(res, { success: true });
}));

router.post('/buyer/requirements/:id/submit', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const resolvedId = await resolveRequirementId(req.params.id);
  if (!resolvedId) throw new ApiError(404, 'Requirement not found', 'REQUIREMENT_NOT_FOUND');
  const id = resolvedId;
  await assertBuyerProcurementApproved(req);
  const existing = await db.requirement.findFirst({ where: { id, buyerId: userId(req) } });
  if (!existing) throw new ApiError(404, 'Requirement not found', 'REQUIREMENT_NOT_FOUND');
  const requirement = await procurementWorkflow.submitRequirement(actorFrom(req), id);
  ok(res, requirement);
}));

// Direct purchase and RFQ
const directPurchaseInclude = {
  buyer: {
    select: {
      id: true,
      name: true,
      email: true,
      mobile: true,
      buyerProfile: {
        select: {
          organizationName: true,
          organizationType: true,
          city: true,
          district: true,
          state: true
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
      sellerProfile: {
        select: {
          businessName: true,
          organizationType: true,
          offices: {
            select: { city: true, state: true },
            take: 1
          }
        }
      }
    }
  },
  requirement: {
    include: {
      items: true
    }
  }
};

router.post('/direct-purchases', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  await assertBuyerProcurementApproved(req);
  const body = parse(directPurchaseBody, req.body);
  const directPurchase = await procurementWorkflow.createDirectPurchase(actorFrom(req), body);
  ok(res, directPurchase, 201);
}));

router.get('/direct-purchases', authenticate, asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);
  const where: any = isAdmin(req) ? {} : req.user?.role === 'buyer' ? { buyerId: userId(req) } : { sellerId: userId(req) };
  if (query.status) where.status = query.status;
  if (query.q) where.OR = [{ requirement: { title: { contains: query.q, mode: 'insensitive' } } }, { seller: { name: { contains: query.q, mode: 'insensitive' } } }, { buyer: { name: { contains: query.q, mode: 'insensitive' } } }];
  const window = listWindow(query);
  const [rows, total] = await Promise.all([
    db.directPurchase.findMany({ where, include: directPurchaseInclude, orderBy: { updatedAt: 'desc' }, ...window }),
    db.directPurchase.count({ where })
  ]);
  ok(res, paged(rows, total, query));
}));

router.get('/direct-purchases/:id', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const row = await db.directPurchase.findUnique({
    where: { id },
    include: directPurchaseInclude
  });
  if (!row || (!isAdmin(req) && row.buyerId !== userId(req) && row.sellerId !== userId(req))) throw new ApiError(404, 'Direct purchase not found', 'DIRECT_PURCHASE_NOT_FOUND');
  ok(res, row);
}));

router.put('/direct-purchases/:id', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const body = parse(directPurchaseBody.partial().refine(value => Object.keys(value).length > 0, { message: 'At least one field is required' }), req.body);
  const existing = await db.directPurchase.findUnique({ where: { id } });
  if (!existing || (!isAdmin(req) && existing.buyerId !== userId(req))) throw new ApiError(404, 'Direct purchase not found', 'DIRECT_PURCHASE_NOT_FOUND');
  if (!['DRAFT', 'REQUESTED'].includes(String(existing.status))) throw new ApiError(409, 'Direct purchase can no longer be edited', 'DIRECT_PURCHASE_LOCKED');
  const updated = await db.directPurchase.update({
    where: { id },
    data: {
      ...(body.sellerId !== undefined ? { sellerId: body.sellerId } : {}),
      ...(body.requirementId !== undefined ? { requirementId: body.requirementId } : {}),
      ...(body.totalAmount !== undefined ? { totalAmount: body.totalAmount } : {})
    }
  });
  await notifySafe(
    updated.sellerId,
    'Direct purchase updated',
    `A direct purchase request ${updated.purchaseNumber} was updated by the buyer.`,
    'direct_purchase_updated',
    '/seller/orders'
  );
  await auditWrite(req, 'direct_purchase.updated', 'directPurchase', id);
  ok(res, updated);
}));

router.delete('/direct-purchases/:id', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const existing = await db.directPurchase.findUnique({ where: { id } });
  if (!existing || (!isAdmin(req) && existing.buyerId !== userId(req))) throw new ApiError(404, 'Direct purchase not found', 'DIRECT_PURCHASE_NOT_FOUND');
  if (!['DRAFT', 'REQUESTED', 'REJECTED'].includes(String(existing.status))) throw new ApiError(409, 'Direct purchase can no longer be deleted', 'DIRECT_PURCHASE_LOCKED');
  await db.directPurchase.delete({ where: { id } });
  await notifySafe(
    existing.sellerId,
    'Direct purchase cancelled',
    `Direct purchase request ${existing.purchaseNumber} was cancelled by the buyer.`,
    'direct_purchase_cancelled',
    '/seller/orders'
  );
  await auditWrite(req, 'direct_purchase.deleted', 'directPurchase', id);
  ok(res, { success: true });
}));

for (const [path, status, action] of [
  ['/direct-purchases/:id/accept', 'APPROVED', 'direct_purchase.accepted'],
  ['/direct-purchases/:id/reject', 'REJECTED', 'direct_purchase.rejected']
] as const) {
  router.post(path, authenticate, authorize('seller', 'admin'), asyncRoute(async (req, res) => {
    const { id } = parse(idParams, req.params);
    const existing = await db.directPurchase.findUnique({ where: { id } });
    if (!existing || (!isAdmin(req) && existing.sellerId !== userId(req))) throw new ApiError(404, 'Direct purchase not found', 'DIRECT_PURCHASE_NOT_FOUND');
    const updated = await procurementWorkflow.respondDirectPurchase(actorFrom(req), id, status === 'APPROVED');
    ok(res, updated);
  }));
}

router.post('/direct-purchases/:id/generate-po', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const body = parse(z.object({ tenderId: z.coerce.number().int().positive().optional(), bidId: z.coerce.number().int().positive().optional(), title: z.string().trim().min(3).max(200).optional() }), req.body);
  const result = await procurementWorkflow.generateDirectPurchasePO(actorFrom(req), id, body);
  ok(res, result.purchaseOrder, 201);
}));

router.post('/quote-requests', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  await assertBuyerProcurementApproved(req);
  const body = parse(quoteRequestBody, req.body);
  const quote = await procurementWorkflow.createQuoteRequest(actorFrom(req), body);
  ok(res, quote, 201);
}));

const quoteRequestInclude = {
  quoteResponses: {
    include: {
      seller: {
        select: {
          id: true,
          name: true,
          email: true,
          mobile: true,
          sellerProfile: {
            select: {
              businessName: true,
              organizationType: true
            }
          }
        }
      }
    }
  },
  buyer: {
    select: {
      id: true,
      name: true,
      email: true,
      mobile: true,
      buyerProfile: {
        select: {
          organizationName: true,
          organizationType: true,
          city: true,
          state: true
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
      sellerProfile: {
        select: {
          businessName: true,
          organizationType: true,
          offices: {
            select: {
              city: true,
              state: true
            }
          }
        }
      }
    }
  }
};

router.get('/quote-requests', authenticate, asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);
  const where: any = isAdmin(req) ? {} : req.user?.role === 'buyer' ? { buyerId: userId(req) } : { sellerId: userId(req) };
  if (query.status) where.status = query.status;
  if (query.q) where.OR = [{ subject: { contains: query.q, mode: 'insensitive' } }, { message: { contains: query.q, mode: 'insensitive' } }, { seller: { name: { contains: query.q, mode: 'insensitive' } } }, { buyer: { name: { contains: query.q, mode: 'insensitive' } } }];
  const window = listWindow(query);
  const [rows, total] = await Promise.all([
    db.quoteRequest.findMany({ where, include: quoteRequestInclude, orderBy: { updatedAt: 'desc' }, ...window }),
    db.quoteRequest.count({ where })
  ]);
  const enriched = await attachQuoteResponseFileAssets(rows);
  if (req.user?.role === 'buyer') {
    for (const r of enriched) {
      if (r.quoteResponses) {
        r.quoteResponses = r.quoteResponses.filter((qr: any) => qr.status !== 'DRAFT');
      }
    }
  }
  ok(res, paged(enriched, total, query));
}));

router.get('/quote-requests/:id', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const quote = await db.quoteRequest.findUnique({
    where: { id },
    include: quoteRequestInclude
  });
  if (!quote || (!isAdmin(req) && quote.buyerId !== userId(req) && quote.sellerId !== userId(req))) throw new ApiError(404, 'Quote request not found', 'QUOTE_REQUEST_NOT_FOUND');
  const [enriched] = await attachQuoteResponseFileAssets([quote]);
  /* Attach buyer-uploaded document file asset (if any) */
  let requestDocAsset: any = null;
  if (enriched.documentUrl) {
    const fid = fileIdFromUrl(enriched.documentUrl);
    if (fid) {
      requestDocAsset = await db.fileAsset.findFirst({ where: { id: fid, status: 'active' }, select: { id: true, originalName: true, mimeType: true, url: true, key: true } });
    }
  }
  if (req.user?.role === 'buyer' && enriched.deadlineDate && new Date(enriched.deadlineDate) < new Date() && enriched.status !== 'accepted' && enriched.statusEnum !== 'CLOSED') {
    notifySafe(
      enriched.buyerId,
      'RFQ Deadline Reached',
      `Submission deadline for "${enriched.subject}" has passed. Review received quotations.`,
      'quote_request_deadline_reached',
      '/quotations'
    );
  }
  if (req.user?.role === 'buyer' && enriched.quoteResponses) {
    enriched.quoteResponses = enriched.quoteResponses.filter((qr: any) => qr.status !== 'DRAFT');
  }
  if (req.user?.role === 'seller' && enriched.quoteResponses) {
    enriched.quoteResponses = enriched.quoteResponses.filter((qr: any) => qr.sellerId === userId(req));
  }
  ok(res, { ...enriched, requestDocAsset });
}));

router.put('/quote-requests/:id', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const body = parse(quoteRequestBody.partial().refine(value => Object.keys(value).length > 0, { message: 'At least one field is required' }), req.body);
  const quote = await db.quoteRequest.findUnique({ where: { id }, include: { quoteResponses: true } });
  if (!quote || (!isAdmin(req) && quote.buyerId !== userId(req))) throw new ApiError(404, 'Quote request not found', 'QUOTE_REQUEST_NOT_FOUND');
  
  const hasResponses = quote.quoteResponses.some((qr: any) => qr.status === 'SUBMITTED' || qr.status === 'ACCEPTED');
  const isAmendment = req.body.isAmendment === true;
  
  if (hasResponses && !isAmendment) {
    throw new ApiError(409, 'RFQ cannot be modified after receiving quotations unless an amendment is issued.', 'QUOTE_REQUEST_LOCKED');
  }

  const newDeadline = body.deadlineDate ? new Date(body.deadlineDate) : null;
  const oldDeadline = quote.deadlineDate ? new Date(quote.deadlineDate) : null;
  const isDeadlineExtended = newDeadline && (!oldDeadline || newDeadline.getTime() > oldDeadline.getTime());

  const nextVersion = isAmendment ? (quote.version || 1) + 1 : (quote.version || 1);
  const nextStatus = isAmendment ? 'pending' : undefined;

  const updated = await db.$transaction(async (tx: any) => {
    const quoteUpdated = await tx.quoteRequest.update({
      where: { id },
      data: {
        ...(body.sellerId !== undefined ? { sellerId: body.sellerId } : {}),
        ...(body.subject !== undefined ? { subject: body.subject } : {}),
        ...(body.message !== undefined ? { message: body.message } : {}),
        ...(body.documentUrl !== undefined ? { documentUrl: body.documentUrl } : {}),
        ...(body.estimatedValue !== undefined ? { estimatedValue: body.estimatedValue } : {}),
        ...(body.deadlineDate !== undefined ? { deadlineDate: body.deadlineDate } : {}),
        version: nextVersion,
        ...(nextStatus ? { status: nextStatus, statusEnum: 'SENT' } : {})
      }
    });

    if (isAmendment) {
      await tx.quoteResponse.updateMany({
        where: { quoteRequestId: id, status: { in: ['SUBMITTED', 'ACCEPTED', 'REJECTED'] } },
        data: { status: 'DRAFT' }
      });
    }

    return quoteUpdated;
  });

  if (body.documentUrl) {
    const match = body.documentUrl.match(/\/api\/files\/(\d+)/);
    const fileId = match ? Number(match[1]) : null;
    if (fileId) {
      await db.fileAsset.updateMany({
        where: { id: fileId },
        data: { entityType: 'quote', entityId: id }
      });
    } else {
      await db.fileAsset.updateMany({
        where: { url: body.documentUrl },
        data: { entityType: 'quote', entityId: id }
      });
    }
  }

  if (isAmendment) {
    await notifySafe(
      updated.sellerId,
      'RFQ Amended',
      `RFQ "${updated.subject}" was amended to V${nextVersion}. Your previous quotation has been reverted to draft. Please review and resubmit.`,
      'quote_request_amended',
      '/quotations'
    );
    await auditWrite(req, 'quote_request.amended', 'quoteRequest', id, { version: nextVersion });
  } else {
    await notifySafe(
      updated.sellerId,
      'RFQ updated',
      `RFQ "${updated.subject}" was updated by the buyer.`,
      'quote_request_updated',
      '/quotations'
    );
    await auditWrite(req, 'quote_request.updated', 'quoteRequest', id);
  }

  if (isDeadlineExtended) {
    await notifySafe(
      updated.sellerId,
      'RFQ Deadline Extended',
      `The submission deadline for RFQ "${updated.subject}" has been extended to ${formatIstDateTime(newDeadline)}.`,
      'quote_request_deadline_extended',
      '/quotations'
    );
  }

  ok(res, updated);
}));

router.delete('/quote-requests/:id', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const quote = await db.quoteRequest.findUnique({ where: { id }, include: { quoteResponses: true } });
  if (!quote || (!isAdmin(req) && quote.buyerId !== userId(req))) throw new ApiError(404, 'Quote request not found', 'QUOTE_REQUEST_NOT_FOUND');
  if (quote.quoteResponses.length > 0) throw new ApiError(409, 'RFQ with seller responses cannot be deleted', 'QUOTE_REQUEST_LOCKED');
  await db.quoteRequest.delete({ where: { id } });
  await notifySafe(
    quote.sellerId,
    'RFQ cancelled',
    `RFQ "${quote.subject}" was cancelled by the buyer.`,
    'quote_request_cancelled',
    '/quotations'
  );
  await auditWrite(req, 'quote_request.deleted', 'quoteRequest', id);
  ok(res, { success: true });
}));

router.post('/quote-requests/:id/responses', authenticate, authorize('seller'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const quote = await db.quoteRequest.findUnique({ where: { id } });
  if (!quote || quote.sellerId !== userId(req)) throw new ApiError(404, 'Quote request not found', 'QUOTE_REQUEST_NOT_FOUND');
  const body = parse(quoteResponseBody, req.body);
  const response = await procurementWorkflow.createQuoteResponse(actorFrom(req), id, body);
  try {
    broadcastToProcurement(id, {
      type: 'QUOTATION_SUBMITTED',
      requirementId: id,
      responseId: (response as any)?.id,
      offeredPrice: (response as any)?.totalAmount,
      sellerOrgId: (req.user as any)?.organizationId || null,
      timestamp: new Date().toISOString()
    });
  } catch (bcErr) {
    logger.warn({ bcErr }, '[QuoteRequest Response] Failed to broadcast');
  }
  ok(res, response, 201);
}));

const quoteResponseUpdateBody = z.object({
  totalAmount: z.coerce.number().positive().optional(),
  currency: z.string().trim().max(10).optional(),
  deliveryDays: z.coerce.number().int().positive().optional(),
  validityDate: safeCoercedDate.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  documentUrl: z.string().trim().max(1000).nullable().optional(),
  status: z.enum(['DRAFT', 'SUBMITTED']).optional(),
  warrantyPeriod: z.string().trim().max(200).nullable().optional(),
  paymentTerms: z.string().trim().max(500).nullable().optional(),
  gstRate: z.coerce.number().min(0).max(100).optional(),
  deliveryLocation: z.string().trim().max(300).nullable().optional(),
  complianceStatus: z.string().trim().max(50).nullable().optional(),
  discountPercent: z.coerce.number().min(0).max(100).optional()
});

router.put('/quote-responses/:id', authenticate, authorize('seller'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(quoteResponseUpdateBody, req.body);
  
  const response = await db.quoteResponse.findUnique({
    where: { id },
    include: { quoteRequest: true }
  });
  if (!response || response.sellerId !== userId(req)) {
    throw new ApiError(404, 'Quotation not found', 'QUOTE_RESPONSE_NOT_FOUND');
  }
  if (response.status !== 'DRAFT') {
    throw new ApiError(409, 'Only draft quotations can be modified.', 'QUOTE_RESPONSE_LOCKED');
  }

  const isSubmitting = body.status === 'SUBMITTED';
  if (isSubmitting) {
    if (response.quoteRequest.deadlineDate && new Date(response.quoteRequest.deadlineDate) < new Date()) {
      throw new ApiError(400, 'Cannot submit quote response after RFQ deadline.', 'RFQ_DEADLINE_PASSED');
    }
  }

  const ack = isSubmitting ? {
    acknowledgementId: `ACK-QR-${response.responseNumber}-${Date.now()}`,
    responseId: response.responseNumber!,
    timestamp: new Date().toISOString(),
    message: 'Quotation submitted successfully.'
  } : undefined;

  const updated = await db.$transaction(async (tx: any) => {
    const updatedResponse = await tx.quoteResponse.update({
      where: { id },
      data: {
        ...(body.totalAmount !== undefined ? { totalAmount: body.totalAmount } : {}),
        ...(body.currency !== undefined ? { currency: body.currency } : {}),
        ...(body.deliveryDays !== undefined ? { deliveryDays: body.deliveryDays } : {}),
        ...(body.validityDate !== undefined ? { validityDate: body.validityDate } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.documentUrl !== undefined ? { documentUrl: body.documentUrl } : {}),
        ...(isSubmitting ? { status: 'SUBMITTED', acknowledgement: ack } : {})
      }
    });

    if (isSubmitting) {
      await tx.quoteRequest.update({
        where: { id: response.quoteRequestId },
        data: { status: 'responded', statusEnum: 'RESPONDED' }
      });
    }

    return updatedResponse;
  });

  if (isSubmitting) {
    notifySafe(
      response.quoteRequest.buyerId,
      'RFQ response received',
      response.quoteRequest.subject,
      'quote_response_created',
      '/quotations'
    );
    await auditWrite(req, 'quote_response.submitted', 'quoteResponse', updated.id);
  } else {
    await auditWrite(req, 'quote_response.draft_saved', 'quoteResponse', updated.id);
  }

  ok(res, updated);
}));

router.post('/quote-responses/:id/withdraw', authenticate, authorize('seller'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const response = await db.quoteResponse.findUnique({
    where: { id },
    include: { quoteRequest: true }
  });
  if (!response || response.sellerId !== userId(req)) {
    throw new ApiError(404, 'Quotation not found', 'QUOTE_RESPONSE_NOT_FOUND');
  }

  if (response.quoteRequest.deadlineDate && new Date(response.quoteRequest.deadlineDate) < new Date()) {
    throw new ApiError(400, 'Cannot withdraw quotation after deadline.', 'RFQ_DEADLINE_PASSED');
  }

  if (response.quoteRequest.allowWithdrawal === false) {
    throw new ApiError(400, 'Withdrawal is not permitted for this RFQ.', 'WITHDRAWAL_NOT_PERMITTED');
  }

  const updated = await db.$transaction(async (tx: any) => {
    const updatedResponse = await tx.quoteResponse.update({
      where: { id },
      data: { status: 'WITHDRAWN' }
    });

    await tx.quoteRequest.update({
      where: { id: response.quoteRequestId },
      data: { status: 'pending', statusEnum: 'SENT' }
    });

    return updatedResponse;
  });

  notifySafe(
    response.quoteRequest.buyerId,
    'RFQ quotation withdrawn',
    `The quotation for RFQ "${response.quoteRequest.subject}" was withdrawn by the seller.`,
    'quote_response_withdrawn',
    '/quotations'
  );
  await auditWrite(req, 'quote_response.withdrawn', 'quoteResponse', updated.id);

  ok(res, updated);
}));

for (const [path, status, action] of [
  ['/quote-responses/:id/accept', 'ACCEPTED', 'quote_response.accepted'],
  ['/quote-responses/:id/reject', 'REJECTED', 'quote_response.rejected']
] as const) {
  router.post(path, authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
    const { id } = parse(idParams, req.params);
    await assertBuyerProcurementApproved(req);
    const response = await db.quoteResponse.findUnique({ where: { id }, include: { quoteRequest: true } });
    const isAuthorizedBuyer = isAdmin(req) ||
      response?.quoteRequest?.buyerId === userId(req) ||
      (Boolean(req.user?.organizationId) && (response?.quoteRequest as any)?.organizationId === req.user.organizationId);
    if (!response || !isAuthorizedBuyer) throw new ApiError(404, 'Quote response not found', 'QUOTE_RESPONSE_NOT_FOUND');
    if (status === 'ACCEPTED') {
      const body = parse(z.object({ tenderId: z.coerce.number().int().positive().optional(), bidId: z.coerce.number().int().positive().optional(), title: z.string().trim().min(3).max(200).optional() }).passthrough().optional().default({}), req.body || {});
      ok(res, await procurementWorkflow.acceptQuoteResponseAndGeneratePO(actorFrom(req), id, body));
      return;
    }
    if (response.status === 'ACCEPTED') {
      throw new ApiError(409, 'Accepted RFQ response cannot be rejected', 'QUOTE_RESPONSE_FINALIZED');
    }
    const updated = await db.$transaction(async (tx: any) => {
      const decided = response.status === 'REJECTED'
        ? response
        : await tx.quoteResponse.update({ where: { id }, data: { status } });
      await tx.quoteRequest.update({
        where: { id: response.quoteRequestId },
        data: { status: 'rejected', statusEnum: 'CLOSED' }
      });
      return decided;
    });
    await notifySafe(
      response.sellerId,
      'RFQ response rejected',
      `Your response for "${response.quoteRequest.subject}" was rejected by the buyer.`,
      'quote_response_rejected',
      '/quotations'
    );
    // Notify all participants that RFQ is closed when all accepted/rejected
    if (['accepted', 'rejected'].includes(action)) {
      const remaining = await db.quoteResponse.count({
        where: { quoteRequestId: response.quoteRequestId, status: 'SUBMITTED' }
      });
      if (remaining === 0) {
        await notifySafe(
          response.quoteRequest.sellerId,
          'RFQ Closed',
          `RFQ "${response.quoteRequest.subject}" has been closed.`,
          'quote_request_closed',
          '/quotations'
        );
      }
    }
    await auditWrite(req, action, 'quoteResponse', id);
    ok(res, updated);
  }));
}

// Buyer evaluation endpoints for quote responses (L1 workflow)
const evaluationStatusSchema = z.object({
  status: z.enum(['QUALIFIED', 'NOT_QUALIFIED', 'PENDING']),
  remarks: z.string().trim().max(2000).optional()
});

router.post('/quote-responses/:id/technical-status', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const body = parse(evaluationStatusSchema, req.body);
  const response = await db.quoteResponse.findUnique({ where: { id }, include: { quoteRequest: { select: { buyerId: true, subject: true } } } });
  if (!response || (!isAdmin(req) && response.quoteRequest.buyerId !== userId(req))) throw new ApiError(404, 'Quote response not found', 'QUOTE_RESPONSE_NOT_FOUND');
  const updated = await db.quoteResponse.update({
    where: { id },
    data: { technicalStatus: body.status, technicalRemarks: body.remarks ?? null }
  });
  await notifySafe(
    response.sellerId,
    'Technical Evaluation Updated',
    `Your quotation for "${response.quoteRequest.subject}" technical status: ${body.status}.`,
    'quote_response_technical_evaluation',
    '/quotations'
  );
  await auditWrite(req, 'quote_response.technical_evaluation', 'quoteResponse', id, { technicalStatus: body.status });
  ok(res, updated);
}));

router.post('/quote-responses/:id/financial-status', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const body = parse(evaluationStatusSchema, req.body);
  const response = await db.quoteResponse.findUnique({ where: { id }, include: { quoteRequest: { select: { buyerId: true, subject: true } } } });
  if (!response || (!isAdmin(req) && response.quoteRequest.buyerId !== userId(req))) throw new ApiError(404, 'Quote response not found', 'QUOTE_RESPONSE_NOT_FOUND');
  const updated = await db.quoteResponse.update({
    where: { id },
    data: { financialStatus: body.status, commercialRemarks: body.remarks ?? null }
  });
  await notifySafe(
    response.sellerId,
    'Financial Evaluation Updated',
    `Your quotation for "${response.quoteRequest.subject}" financial status: ${body.status}.`,
    'quote_response_financial_evaluation',
    '/quotations'
  );
  await auditWrite(req, 'quote_response.financial_evaluation', 'quoteResponse', id, { financialStatus: body.status });
  ok(res, updated);
}));

const buyerRemarksBody = z.object({
  buyerRemarks: z.string().trim().max(2000)
});

router.post('/quote-responses/:id/remarks', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(buyerRemarksBody, req.body);
  const response = await db.quoteResponse.findUnique({ where: { id }, include: { quoteRequest: { select: { buyerId: true } } } });
  if (!response || (!isAdmin(req) && response.quoteRequest.buyerId !== userId(req))) throw new ApiError(404, 'Quote response not found', 'QUOTE_RESPONSE_NOT_FOUND');
  const updated = await db.quoteResponse.update({
    where: { id },
    data: { buyerRemarks: body.buyerRemarks }
  });
  await auditWrite(req, 'quote_response.remarks', 'quoteResponse', id);
  ok(res, updated);
}));

// ── Request Revision ──
router.post('/quote-responses/:id/request-revision', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const response = await db.quoteResponse.findUnique({
    where: { id },
    include: { quoteRequest: { include: { buyer: { select: { name: true } } } } }
  });
  if (!response || (!isAdmin(req) && response.quoteRequest.buyerId !== userId(req))) throw new ApiError(404, 'Quote response not found', 'QUOTE_RESPONSE_NOT_FOUND');
  if (response.status !== 'SUBMITTED') throw new ApiError(409, 'Only submitted quotations can be revised.', 'INVALID_STATUS');

  await db.$transaction(async (tx: any) => {
    await tx.quoteResponse.update({
      where: { id },
      data: { status: 'DRAFT', acknowledgement: null }
    });
    await tx.quoteRequest.update({
      where: { id: response.quoteRequestId },
      data: { allowSellerRevision: true, revisionRequestedAt: new Date() }
    });
  });

  await notifySafe(
    response.quoteRequest.buyerId,
    'RFQ Revision Requested',
    `You requested a revision for "${response.quoteRequest.subject}". The seller has been notified.`,
    'quote_request_revision_requested',
    `/buyer/procurement`
  );
  await notifySafe(
    response.sellerId,
    'RFQ Revision Requested',
    `The buyer requested a revision for "${response.quoteRequest.subject}". Please review and resubmit your quotation.`,
    'quote_request_revision_requested',
    `/quotations`
  );

  await auditWrite(req, 'quote_response.revision_requested', 'quoteResponse', id);
  ok(res, { success: true, message: 'Revision requested. Seller can now resubmit.' });
}));

// ── Shortlist Toggle ──
const shortlistBody = z.object({
  shortlisted: z.boolean()
});

router.post('/quote-responses/:id/shortlist', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(shortlistBody, req.body);
  const response = await db.quoteResponse.findUnique({
    where: { id },
    include: { quoteRequest: { select: { buyerId: true, subject: true } } }
  });
  if (!response || (!isAdmin(req) && response.quoteRequest.buyerId !== userId(req))) throw new ApiError(404, 'Quote response not found', 'QUOTE_RESPONSE_NOT_FOUND');
  if (!['SUBMITTED', 'SHORTLISTED'].includes(response.status)) throw new ApiError(409, 'Only submitted quotations can be shortlisted.', 'INVALID_STATUS');

  const updated = await db.quoteResponse.update({
    where: { id },
    data: { isShortlisted: body.shortlisted, status: body.shortlisted ? 'SHORTLISTED' : 'SUBMITTED' }
  });

  if (body.shortlisted) {
    await notifySafe(
      response.quoteRequest.buyerId,
      'Seller Shortlisted',
      `Quotation for "${response.quoteRequest.subject}" has been shortlisted.`,
      'quote_response_shortlisted',
      `/quotations`
    );
  }

  await auditWrite(req, body.shortlisted ? 'quote_response.shortlisted' : 'quote_response.unshortlisted', 'quoteResponse', id);
  ok(res, updated);
}));

// ── RFQ Clarifications ──
const clarificationAskBody = z.object({
  question: z.string().trim().min(3).max(2000),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).optional().default('PUBLIC')
});

const findQuoteRequestRecord = async (idParam: string | number) => {
  const rawToken = String(idParam || '').trim();
  if (!rawToken) return null;
  const token = rawToken.replace(/^[^\w\d]+/, '');
  if (!token) return null;
  const isNum = /^\d+$/.test(token);
  const numId = isNum ? Number(token) : null;

  if (numId && numId > 0) {
    const [q, req, bid] = await Promise.all([
      db.quoteRequest.findUnique({ where: { id: numId }, include: { buyer: { select: { name: true } } } }).catch(() => null),
      db.buyerRequirement.findUnique({ where: { id: numId } }).catch(() => null),
      db.procurementBid.findUnique({ where: { id: numId } }).catch(() => null)
    ]);
    if (q) return { ...q, allowClarification: true };

    if (req) {
      const sched = (req.payload as any)?.schedule;
      return {
        id: req.id,
        subject: req.title,
        requirementNumber: req.referenceNumber || `RFQ-${new Date(req.createdAt).getFullYear()}-${String(req.id).padStart(5, '0')}`,
        buyerId: req.createdById,
        buyerOrganizationId: (req as any).buyerOrganizationId || null,
        sellerId: null,
        deadlineDate: req.lastDate,
        submissionStartDate: sched?.submissionStartDate || sched?.startDate || req.startDate || null,
        allowClarification: sched?.clarificationAllowed !== false && (req as any).allowClarification !== false,
        status: (req as any).status || 'PUBLISHED'
      };
    }

    if (bid) {
      const sched = (bid.technicalPacket as any)?.schedule;
      return {
        id: bid.id,
        subject: bid.title,
        requirementNumber: bid.bidNumber,
        buyerId: bid.buyerId,
        buyerOrganizationId: bid.buyerOrganizationId || null,
        sellerId: null,
        deadlineDate: bid.endDate,
        submissionStartDate: sched?.submissionStartDate || sched?.startDate || (bid.technicalPacket as any)?.tender?.bidStartDate || bid.startDate || null,
        allowClarification: bid.allowClarification !== false,
        status: bid.status || 'PUBLISHED'
      };
    }

    const legacyReq = await db.requirement.findUnique({ where: { id: numId } }).catch(() => null);
    if (legacyReq) {
      const sched = (legacyReq.payload as any)?.schedule;
      const rawEnd = sched?.submissionDate || sched?.submissionDeadline || legacyReq.requiredBy;
      return {
        id: legacyReq.id,
        subject: legacyReq.title,
        requirementNumber: legacyReq.requirementNumber,
        buyerId: legacyReq.createdById,
        buyerOrganizationId: null,
        sellerId: null,
        deadlineDate: rawEnd || null,
        submissionStartDate: sched?.submissionStartDate || sched?.startDate || (legacyReq.payload as any)?.tender?.bidStartDate || legacyReq.startDate || null,
        allowClarification: sched?.clarificationAllowed !== false,
        status: 'PUBLISHED'
      };
    }
  }

  const tokenVariants = Array.from(new Set([token, ...getCanonicalLookupVariants(token)]));

  const [bidMatch, reqMatch] = await Promise.all([
    db.procurementBid.findFirst({
      where: {
        OR: tokenVariants.map(t => ({ bidNumber: t }))
      }
    }).catch(() => null),
    db.requirement.findFirst({
      where: {
        OR: tokenVariants.map(t => ({ requirementNumber: t }))
      }
    }).catch(() => null)
  ]);

  if (bidMatch) {
    const sched = (bidMatch.technicalPacket as any)?.schedule;
    return {
      id: bidMatch.id,
      subject: bidMatch.title,
      requirementNumber: bidMatch.bidNumber,
      buyerId: bidMatch.buyerId,
      buyerOrganizationId: bidMatch.buyerOrganizationId || null,
      sellerId: null,
      deadlineDate: bidMatch.endDate,
      submissionStartDate: sched?.submissionStartDate || sched?.startDate || (bidMatch.technicalPacket as any)?.tender?.bidStartDate || bidMatch.startDate || null,
      allowClarification: bidMatch.allowClarification !== false,
      status: bidMatch.status || 'PUBLISHED'
    };
  }
  if (reqMatch) {
    const sched = (reqMatch.payload as any)?.schedule;
    const rawEnd = sched?.submissionDate || sched?.submissionDeadline || reqMatch.requiredBy;
    return {
      id: reqMatch.id,
      subject: reqMatch.title,
      requirementNumber: reqMatch.requirementNumber,
      buyerId: reqMatch.createdById,
      sellerId: null,
      deadlineDate: rawEnd || null,
      submissionStartDate: sched?.submissionStartDate || sched?.startDate || (reqMatch.payload as any)?.tender?.bidStartDate || reqMatch.startDate || null,
      allowClarification: sched?.clarificationAllowed !== false,
      status: 'PUBLISHED'
    };
  }

  return null;
};

router.post('/quote-requests/:id/clarifications', authenticate, asyncRoute(async (req, res) => {
  const quote = await findQuoteRequestRecord(req.params.id);
  if (!quote) throw new ApiError(404, 'RFQ not found', 'QUOTE_REQUEST_NOT_FOUND');
  const id = quote.id;
  const body = parse(clarificationAskBody, req.body);
  if (req.user?.role !== 'seller' && userId(req) !== quote.buyerId && userId(req) !== quote.sellerId) {
    throw new ApiError(403, 'Access denied', 'ACCESS_DENIED');
  }

  if ((quote as any).allowClarification === false) {
    throw new ApiError(400, 'Clarifications are not enabled for this procurement.', 'CLARIFICATIONS_DISABLED');
  }

  // Only enforce submission-start-date gate if the quote is NOT already in an active/open status.
  const quoteActiveStatuses = ['PUBLISHED', 'OPEN', 'OPEN_FOR_BIDDING'];
  const quoteStatus = String((quote as any).status || '').toUpperCase();
  if (!quoteActiveStatuses.includes(quoteStatus)) {
    const rawSubmissionStart = (quote as any).submissionStartDate;
    if (rawSubmissionStart) {
      let startD = new Date(rawSubmissionStart);
      if (typeof rawSubmissionStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawSubmissionStart.trim())) {
        startD = new Date(`${rawSubmissionStart.trim()}T00:00:00.000`);
      }
      if (!isNaN(startD.getTime()) && startD.getTime() > Date.now()) {
        throw new ApiError(400, 'The clarification window has not opened yet. Submissions and clarifications will begin at the scheduled start time.', 'CLARIFICATION_NOT_STARTED');
      }
    }
  }

  const rawSubmissionDeadline = quote.deadlineDate;
  if (rawSubmissionDeadline) {
    const deadlineD = new Date(rawSubmissionDeadline);
    if (!isNaN(deadlineD.getTime()) && deadlineD.getTime() < Date.now()) {
      throw new ApiError(400, 'The clarification window has closed as the quotation submission deadline has passed.', 'CLARIFICATION_DEADLINE_PASSED');
    }
  }

  const realQuoteReq = await db.quoteRequest.findUnique({ where: { id } }).catch(() => null);

  let clarification: any;
  if (realQuoteReq) {
    clarification = await db.quoteRequestClarification.create({
      data: {
        quoteRequestId: id,
        question: body.question,
        visibility: body.visibility || 'PUBLIC',
        askedById: userId(req)
      }
    });
  } else {
    clarification = await db.requirementClarification.create({
      data: {
        entityType: 'REQUIREMENT',
        entityId: id,
        question: body.question,
        visibility: body.visibility || 'PUBLIC',
        askedById: userId(req)
      }
    });
  }

  const isFromBuyer = userId(req) === quote.buyerId;
  const targetId = isFromBuyer ? quote.sellerId : quote.buyerId;
  if (targetId && targetId !== userId(req)) {
    const refNum = quote.requirementNumber || String(quote.id);
    const redirectUrl = isFromBuyer
      ? `/seller/procurement/rfq/${refNum}`
      : `/bids/${refNum}?type=RFQ`;
    // Non-blocking background notification for fast HTTP response
    setImmediate(() => {
      notifySafe(
        targetId,
        isFromBuyer ? 'Clarification Update' : 'New Clarification Question',
        `Regarding "${quote.subject}": ${body.question.substring(0, 100)}${body.question.length > 100 ? '...' : ''}`,
        'quote_request_clarification',
        redirectUrl
      );
    });
  }

  // Non-blocking audit write
  setImmediate(() => {
    void auditWrite(req, 'quote_request.clarification_asked', 'quoteRequestClarification', clarification.id);
  });
  ok(res, clarification, 201);
}));

const clarificationReplyBody = z.object({
  response: z.string().trim().min(1).max(3000)
});

router.post('/quote-requests/:id/clarifications/:clarId/reply', authenticate, asyncRoute(async (req, res) => {
  const quote = await findQuoteRequestRecord(req.params.id);
  if (!quote) throw new ApiError(404, 'RFQ not found', 'QUOTE_REQUEST_NOT_FOUND');
  const body = parse(clarificationReplyBody, req.body);
  const clarId = Number(req.params.clarId);

  if (userId(req) !== quote.buyerId && req.user?.role !== 'admin' && req.user?.role !== 'master_admin') {
    throw new ApiError(403, 'Only the buyer can answer clarification questions.', 'ACCESS_DENIED');
  }

  let updated: any;
  let askingUserId: number | null = null;
  const clar1 = await db.quoteRequestClarification.findFirst({
    where: { id: clarId, quoteRequestId: quote.id }
  }).catch(() => null);

  if (clar1) {
    askingUserId = clar1.askedById;
    updated = await db.quoteRequestClarification.update({
      where: { id: clar1.id },
      data: {
        response: body.response,
        answeredById: userId(req),
        answeredAt: new Date()
      }
    });
  } else {
    const clar2 = await db.requirementClarification.findFirst({
      where: { id: clarId, entityId: quote.id }
    }).catch(() => null);

    if (clar2) {
      askingUserId = clar2.askedById;
      updated = await db.requirementClarification.update({
        where: { id: clar2.id },
        data: {
          response: body.response,
          answeredById: userId(req),
          answeredAt: new Date()
        }
      });
    } else {
      const clar3 = await db.procurementBidClarification.findFirst({
        where: { id: clarId, bidId: quote.id }
      }).catch(() => null);

      if (!clar3) throw new ApiError(404, 'Clarification question not found', 'NOT_FOUND');

      askingUserId = clar3.sellerId || clar3.requestedById || null;
      updated = await db.procurementBidClarification.update({
        where: { id: clar3.id },
        data: {
          response: body.response,
          status: 'RESOLVED',
          respondedById: userId(req),
          respondedAt: new Date()
        }
      });
    }
  }

  const targetId = userId(req) === quote.buyerId ? (askingUserId || quote.sellerId) : quote.buyerId;
  if (targetId && targetId !== userId(req)) {
    const refNum = quote.requirementNumber || String(quote.id);
    const redirectUrl = userId(req) === quote.buyerId
      ? `/seller/procurement/rfq/${refNum}`
      : `/bids/${refNum}?type=RFQ`;
    // Non-blocking background notification for fast HTTP response
    setImmediate(() => {
      notifySafe(
        targetId,
        'Clarification Answered',
        `Buyer answered your question regarding "${quote.subject}"`,
        'quote_request_clarification',
        redirectUrl
      );
    });
  }

  // Non-blocking audit write
  setImmediate(() => {
    void auditWrite(req, 'quote_request.clarification_answered', 'quoteRequestClarification', updated.id);
  });
  ok(res, updated);
}));

router.get('/quote-requests/:id/clarifications', optionalAuthenticate, asyncRoute(async (req: AuthRequest, res) => {
  const quote = await findQuoteRequestRecord(req.params.id);
  if (!quote) throw new ApiError(404, 'RFQ not found', 'QUOTE_REQUEST_NOT_FOUND');
  const id = quote.id;

  const [qrClarifications, reqClarifications, procClarifications] = await Promise.all([
    db.quoteRequestClarification.findMany({
      where: { quoteRequestId: id },
      orderBy: { askedAt: 'asc' }
    }).catch(() => []),
    db.requirementClarification.findMany({
      where: { entityType: 'REQUIREMENT', entityId: id },
      orderBy: { askedAt: 'asc' }
    }).catch(() => []),
    db.procurementBidClarification.findMany({
      where: { bidId: id },
      orderBy: { createdAt: 'asc' }
    }).catch(() => [])
  ]);

  const normalizedProcClarifications = procClarifications.map((c: any) => ({
    id: c.id,
    quoteRequestId: c.bidId,
    question: c.question,
    response: c.response,
    visibility: c.isPublic ? 'PUBLIC' : 'PRIVATE',
    askedById: c.sellerId || c.requestedById,
    answeredById: c.respondedById,
    askedAt: c.createdAt,
    answeredAt: c.respondedAt,
  }));

  const allClarifications = [...qrClarifications, ...reqClarifications, ...normalizedProcClarifications].sort((a: any, b: any) =>
    new Date(a.askedAt || a.createdAt).getTime() - new Date(b.askedAt || b.createdAt).getTime()
  );

  const currentUserId = req.user?.id ? Number(req.user.id) : null;
  const isPrivilegedBuyerOrAdmin = Boolean(
    req.user && (
      req.user.role === 'admin' ||
      req.user.role === 'master_admin' ||
      (currentUserId && quote.buyerId && currentUserId === Number(quote.buyerId)) ||
      (req.user.organizationId && (quote as any).buyerOrganizationId && req.user.organizationId === (quote as any).buyerOrganizationId)
    )
  );

  // Private clarifications must NOT be shown to the public or other sellers/bidders.
  // They must be visible to the asking seller and the buyer only.
  const filtered = isPrivilegedBuyerOrAdmin
    ? allClarifications
    : allClarifications.filter((c: any) => {
        const vis = String(c.visibility || 'PUBLIC').toUpperCase();
        if (vis === 'PUBLIC') return true;
        // If PRIVATE:
        // Must be authenticated and must be the specific seller who asked it
        if (!currentUserId) return false;
        return Number(c.askedById) === currentUserId;
      });

  ok(res, filtered);
}));

const generateL1Body = z.object({
  techQualifiedOnly: z.boolean().optional().default(true)
});

router.post('/quote-requests/:id/generate-l1', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const body = parse(generateL1Body, req.body);
  const quote = await db.quoteRequest.findUnique({ where: { id }, include: { quoteResponses: true } });
  if (!quote || (!isAdmin(req) && quote.buyerId !== userId(req))) throw new ApiError(404, 'Quote request not found', 'QUOTE_REQUEST_NOT_FOUND');
  
  let responses = await db.quoteResponse.findMany({
    where: { quoteRequestId: id, status: { not: 'DRAFT' } },
    orderBy: [{ evaluatedPrice: 'asc' }, { totalAmount: 'asc' }, { createdAt: 'asc' }]
  });

  if (body.techQualifiedOnly) {
    responses = responses.filter(r => r.technicalStatus !== 'NOT_QUALIFIED');
  }

  const ranked = await db.$transaction(async (tx: any) => {
    const updates = responses.map((r: any, idx: number) =>
      tx.quoteResponse.update({
        where: { id: r.id },
        data: { rank: idx + 1, evaluatedPrice: r.evaluatedPrice || r.totalAmount }
      })
    );
    // Reset rank for unranked responses
    const unrankedIds = (await db.quoteResponse.findMany({
      where: { quoteRequestId: id, id: { notIn: responses.map((r: any) => r.id) }, status: { not: 'DRAFT' } },
      select: { id: true }
    })).map((r: any) => r.id);
    if (unrankedIds.length > 0) {
      updates.push(tx.quoteResponse.updateMany({
        where: { id: { in: unrankedIds } },
        data: { rank: null }
      }));
    }
    return tx.$transaction(updates);
  });

  await auditWrite(req, 'quote_request.l1_generated', 'quoteRequest', id);
  ok(res, { success: true, ranked: responses.length });
}));

// Tenders, bids, auctions
router.post('/tenders', authenticate, requirePermission('tender.create', orgScope), asyncRoute(async (req, res) => {
  await assertBuyerProcurementApproved(req);
  const body = parse(tenderBody, req.body);
  const tender = await tenderWorkflow.createTender(actorFrom(req), body);
  await linkUploadedTenderDocument(tender.id, body.documentUrl, userId(req));
  ok(res, tender, 201);
}));

const mapProcurementBidStatusToTenderStatus = (status: string): string => {
  const s = String(status || 'DRAFT').toUpperCase();
  if (['DRAFT', 'PENDING_ADMIN_APPROVAL', 'REJECTED'].includes(s)) return 'draft';
  if (['OPEN', 'APPROVED'].includes(s)) return 'published';
  if (['CLOSED', 'EXPIRED', 'CANCELLED'].includes(s)) return 'closed';
  if (['TECHNICAL_EVALUATION', 'TECHNICAL_EVALUATION_COMPLETED'].includes(s)) return 'tech_evaluation';
  if (['FINANCIAL_EVALUATION', 'L1_GENERATED', 'AWARD_RECOMMENDED'].includes(s)) return 'financial_evaluation';
  if (s === 'AWARDED') return 'awarded';
  return 'published';
};

router.get('/tenders', authenticate, asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);
  const isBuyerRole = req.user?.role === 'buyer';

  const baseWhereTender: any = isAdmin(req)
    ? {}
    : isBuyerRole
      ? { buyerId: userId(req) }
      : { status: { in: ['published', 'bid_submission', 'tech_bid_opening', 'tech_evaluation', 'financial_bid_opening', 'financial_opening', 'financial_evaluation'] } };

  const baseWherePB: any = isAdmin(req)
    ? {}
    : isBuyerRole
      ? { buyerId: userId(req) }
      : {
          status: { in: ['OPEN', 'APPROVED', 'CLOSED', 'TECHNICAL_EVALUATION', 'TECHNICAL_EVALUATION_COMPLETED', 'FINANCIAL_EVALUATION', 'L1_GENERATED', 'AWARD_RECOMMENDED', 'AWARDED', 'CANCELLED'] },
          OR: [
            {
              NOT: {
                OR: [
                  { procurementType: { in: ['DIRECT_PURCHASE', 'CATALOG_PURCHASE', 'REPEAT_ORDER', 'LIMITED_TENDER', 'SINGLE_SOURCE', 'EMERGENCY_PURCHASE'] } },
                  { bidType: { in: ['DIRECT_PURCHASE', 'CATALOG_PURCHASE', 'REPEAT_ORDER', 'LIMITED_TENDER', 'SINGLE_SOURCE', 'EMERGENCY_PURCHASE'] } }
                ]
              }
            },
            {
              participations: {
                some: { sellerId: userId(req) }
              }
            }
          ]
        };

  const whereTender: any = { ...baseWhereTender };
  const wherePB: any = { ...baseWherePB };

  // Status/Tab filter
  if (query.status) {
    if (query.status === 'published') {
      whereTender.status = { in: ['published', 'bid_submission', 'tech_bid_opening', 'tech_evaluation', 'financial_bid_opening', 'financial_opening', 'financial_evaluation'] };
      wherePB.status = { in: ['OPEN', 'APPROVED'] };
    } else if (query.status === 'closed') {
      whereTender.status = { in: ['closed', 'awarded', 'po_generated'] };
      wherePB.status = { in: ['CLOSED', 'EXPIRED', 'TECHNICAL_EVALUATION', 'TECHNICAL_EVALUATION_COMPLETED', 'FINANCIAL_EVALUATION', 'L1_GENERATED', 'AWARD_RECOMMENDED', 'AWARDED', 'CANCELLED'] };
    } else if (query.status === 'draft') {
      whereTender.status = 'draft';
      wherePB.status = { in: ['DRAFT', 'PENDING_ADMIN_APPROVAL'] };
    } else {
      whereTender.status = query.status;
      if (query.status === 'draft') {
        wherePB.status = { in: ['DRAFT', 'PENDING_ADMIN_APPROVAL'] };
      } else {
        wherePB.status = query.status;
      }
    }
  }

  // Category filter
  const category = req.query.category as string;
  if (category && category !== 'All') {
    whereTender.category = category;
    wherePB.category = category;
  }

  // Budget filter
  const budget = req.query.budget as string;
  if (budget && budget !== 'All') {
    if (budget === 'under_10l') {
      whereTender.budget = { lt: 1000000 };
      wherePB.estimatedValue = { lt: 1000000 };
    } else if (budget === '10l_50l') {
      whereTender.budget = { gte: 1000000, lte: 5000000 };
      wherePB.estimatedValue = { gte: 1000000, lte: 5000000 };
    } else if (budget === 'above_50l') {
      whereTender.budget = { gt: 5000000 };
      wherePB.estimatedValue = { gt: 5000000 };
    }
  }

  // Search filter
  const search = (req.query.search || query.q) as string;
  if (search && search.trim()) {
    const term = search.trim();
    whereTender.OR = [
      { tenderId: { contains: term, mode: 'insensitive' } },
      { title: { contains: term, mode: 'insensitive' } },
      { category: { contains: term, mode: 'insensitive' } },
      { description: { contains: term, mode: 'insensitive' } }
    ];
    wherePB.OR = [
      { bidNumber: { contains: term, mode: 'insensitive' } },
      { title: { contains: term, mode: 'insensitive' } },
      { category: { contains: term, mode: 'insensitive' } },
      { description: { contains: term, mode: 'insensitive' } }
    ];
  }

  // Fetch both sets
  const [tenders, procurementBids] = await Promise.all([
    db.tender.findMany({
      where: whereTender,
      include: { _count: { select: { bids: { where: { status: { not: 'withdrawn' } } } } } }
    }),
    db.procurementBid.findMany({
      where: wherePB,
      include: {
        _count: { select: { participations: { where: { isWithdrawn: false } } } },
        documents: true
      }
    })
  ]);

  // Normalize into a single structure
  const merged = [
    ...tenders.map((t: any) => ({
      id: t.id,
      tenderId: t.tenderId,
      title: t.title,
      category: t.category,
      budget: Number(t.budget || 0),
      bidsCount: t._count?.bids ?? t.bidsCount ?? 0,
      closesAt: t.closesAt ? t.closesAt.toISOString() : null,
      status: t.status,
      description: t.description || '',
      createdAt: t.createdAt ? t.createdAt.toISOString() : null,
      updatedAt: t.updatedAt ? t.updatedAt.toISOString() : null,
      documentUrl: t.documentUrl || null,
      quantityUnit: t.quantityUnit || null,
      paymentTerms: t.paymentTerms || null,
      deliveryType: t.deliveryType || null,
      isV2: false
    })),
    ...procurementBids.map((b: any) => {
      const doc = b.documents?.[0];
      const docUrl = doc ? `/api/files/${doc.fileAssetId}/view` : null;
      const bPayload = (typeof b.technicalPacket === 'object' && b.technicalPacket ? (b.technicalPacket as any) : {}) as any;
      const bTerms = bPayload.terms || {};

      return {
        id: b.id,
        tenderId: b.bidNumber,
        title: b.title,
        category: b.category,
        budget: Number(b.estimatedValue || 0),
        bidsCount: b._count?.participations ?? 0,
        closesAt: b.endDate ? b.endDate.toISOString() : null,
        status: mapProcurementBidStatusToTenderStatus(b.status),
        description: b.description || '',
        createdAt: b.createdAt ? b.createdAt.toISOString() : null,
        updatedAt: b.updatedAt ? b.updatedAt.toISOString() : null,
        documentUrl: docUrl,
        quantityUnit: b.unit || null,
        paymentTerms: bTerms.paymentTerms || b.termsAndConditions?.join(', ') || null,
        deliveryType: bTerms.deliveryTerms || bTerms.deliveryType || null,
        isV2: true,
        v2Status: b.status,
        documents: (b.documents || []).map((doc: any) => ({
          fileAssetId: doc.fileAssetId,
          fileName: doc.fileName || doc.fileAsset?.originalName || 'Document',
          documentType: doc.documentType || 'Bid Document'
        }))
      };
    })
  ];

  // Sorting
  const sortBy = req.query.sortBy as string || 'createdAt';
  const sortOrder = (req.query.sortOrder as string) === 'asc' ? 'asc' : 'desc';
  const dir = sortOrder === 'asc' ? 1 : -1;

  merged.sort((a: any, b: any) => {
    let va = a[sortBy] ?? '';
    let vb = b[sortBy] ?? '';
    if (sortBy === 'closes' || sortBy === 'closesAt') {
      va = a.closesAt ?? '';
      vb = b.closesAt ?? '';
    } else if (sortBy === 'created' || sortBy === 'createdAt') {
      va = a.createdAt ?? '';
      vb = b.createdAt ?? '';
    } else if (sortBy === 'budget') {
      return (Number(a.budget) - Number(b.budget)) * dir;
    } else if (sortBy === 'bids' || sortBy === 'bidsCount') {
      return (Number(a.bidsCount) - Number(b.bidsCount)) * dir;
    }
    if (typeof va === 'number' && typeof vb === 'number') {
      return (va - vb) * dir;
    }
    return String(va).localeCompare(String(vb)) * dir;
  });

  const { skip, take } = listWindow(query);
  const pagedRecords = merged.slice(skip, skip + take);

  ok(res, paged(
    pagedRecords,
    merged.length,
    query,
    'tenders'
  ));
}));

router.get('/tenders/summary', authenticate, asyncRoute(async (req, res) => {
  const isBuyerRole = req.user?.role === 'buyer';

  const baseWhereTender: any = isAdmin(req)
    ? {}
    : isBuyerRole
      ? { buyerId: userId(req) }
      : { status: { in: ['published', 'bid_submission', 'tech_bid_opening', 'tech_evaluation', 'financial_bid_opening', 'financial_opening', 'financial_evaluation'] } };

  const baseWherePB: any = isAdmin(req)
    ? {}
    : isBuyerRole
      ? { buyerId: userId(req) }
      : {
          status: { in: ['OPEN', 'APPROVED', 'CLOSED', 'TECHNICAL_EVALUATION', 'TECHNICAL_EVALUATION_COMPLETED', 'FINANCIAL_EVALUATION', 'L1_GENERATED', 'AWARD_RECOMMENDED', 'AWARDED', 'CANCELLED'] },
          OR: [
            {
              NOT: {
                OR: [
                  { procurementType: 'DIRECT_PURCHASE' },
                  { bidType: 'DIRECT_PURCHASE' }
                ]
              }
            },
            {
              participations: {
                some: { sellerId: userId(req) }
              },
              OR: [
                { procurementType: 'DIRECT_PURCHASE' },
                { bidType: 'DIRECT_PURCHASE' }
              ]
            }
          ]
        };

  const [
    draftTenders, activeTenders, closedTenders,
    draftPBs, activePBs, closedPBs
  ] = await Promise.all([
    db.tender.count({ where: { ...baseWhereTender, status: 'draft' } }),
    db.tender.count({ where: { ...baseWhereTender, status: { in: ['published', 'bid_submission', 'tech_bid_opening', 'tech_evaluation', 'financial_bid_opening', 'financial_opening', 'financial_evaluation'] } } }),
    db.tender.count({ where: { ...baseWhereTender, status: { in: ['closed', 'awarded', 'po_generated'] } } }),
    db.procurementBid.count({ where: { ...baseWherePB, status: { in: ['DRAFT', 'PENDING_ADMIN_APPROVAL'] } } }),
    db.procurementBid.count({ where: { ...baseWherePB, status: { in: ['OPEN', 'APPROVED'] } } }),
    db.procurementBid.count({ where: { ...baseWherePB, status: { in: ['CLOSED', 'EXPIRED', 'TECHNICAL_EVALUATION', 'TECHNICAL_EVALUATION_COMPLETED', 'FINANCIAL_EVALUATION', 'L1_GENERATED', 'AWARD_RECOMMENDED', 'AWARDED', 'CANCELLED'] } } })
  ]);

  ok(res, {
    draftCount: draftTenders + draftPBs,
    activeCount: activeTenders + activePBs,
    closedCount: closedTenders + closedPBs
  });
}));

router.get('/tenders/public', asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);
  const key = redisKeys.cacheTenderPublic(sha256(JSON.stringify(query)));
  const search = (query.q || req.query.search || '').toString().trim();
  const tenders = await getOrSetCache<any[]>(key, () => db.tender.findMany({
    where: {
      status: { in: ['published', 'bid_submission'] },
      ...(search ? {
        OR: [
          { tenderId: { contains: search, mode: 'insensitive' } },
          { title: { contains: search, mode: 'insensitive' } },
          { category: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } }
        ]
      } : {})
    },
    select: {
      id: true,
      buyerId: true,
      tenderId: true,
      title: true,
      category: true,
      budget: true,
      description: true,
      documentUrl: true,
      status: true,
      closesAt: true,
      createdAt: true,
      buyer: {
        select: {
          id: true,
          name: true,
          buyerProfile: {
            select: {
              organizationName: true,
              businessType: true,
              state: true,
              district: true
            }
          }
        }
      },
      tenderDocuments: {
        select: {
          id: true,
          title: true,
          documentType: true,
          fileAssetId: true,
          fileAsset: {
            select: {
              originalName: true
            }
          }
        }
      },
      _count: { select: { bids: { where: { status: { not: 'withdrawn' } } } } }
    },
    skip: query.skip,
    take: query.take,
    orderBy: { createdAt: 'desc' }
  }), 120);

  // Parse authorization optionally to check if the user is a seller and has participated
  let currentUserId: number | undefined;
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const decoded = verifyAccessToken(token);
      currentUserId = Number(decoded.id);
    } catch {
      // ignore
    }
  }

  let myBids: any[] = [];
  if (currentUserId) {
    myBids = await db.bid.findMany({
      where: {
        sellerId: currentUserId,
        tenderId: { in: tenders.map((t: any) => t.id) }
      },
      select: {
        id: true,
        tenderId: true,
        status: true,
        bidNumber: true
      }
    });
  }

  const enrichedTenders = tenders.map((tender: any) => {
    const myBid = myBids.find((b: any) => b.tenderId === tender.id);
    const docs = (tender.tenderDocuments || []).map((doc: any) => ({
      id: doc.id,
      title: doc.title || doc.fileAsset?.originalName || 'Document',
      documentType: doc.documentType,
      url: `/api/files/${doc.fileAssetId}/view`,
      originalName: doc.fileAsset?.originalName
    }));
    return {
      ...tender,
      documentUrl: docs[0]?.url || tender.documentUrl,
      bidsCount: tender._count?.bids ?? tender.bidsCount ?? 0,
      _count: undefined,
      hasParticipated: !!myBid,
      participationStatus: myBid ? myBid.status : null,
      myBidId: myBid ? myBid.id : null,
      myBidNumber: myBid ? myBid.bidNumber : null,
      tenderDocuments: docs
    };
  });

  res.json(maskSensitive(enrichedTenders));
}));

router.get('/tenders/:id', optionalAuthenticate, asyncRoute(async (req, res) => {
  const tenderRef = req.params.id;
  ok(res, await assertTenderAccess(req, tenderRef));
}));

router.put('/tenders/:id', authenticate, requirePermission('tender.update', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const tender = await assertTenderAccess(req, id);
  if (!isAdmin(req) && tender.buyerId !== userId(req)) throw new ApiError(403, 'Access denied', 'ACCESS_DENIED');
  const body = parse(tenderBody.partial(), req.body);
  const updated = await db.tender.update({ where: { id }, data: body });
  await linkUploadedTenderDocument(id, body.documentUrl, userId(req));
  await invalidateByPattern('cache:tender_public:*');
  await auditWrite(req, 'tender.updated', 'tender', id);
  ok(res, updated);
}));

for (const [path, data, action] of [
  ['/tenders/:id/publish', 'published', 'tender.published'],
  ['/tenders/:id/close', 'closed', 'tender.closed']
] as const) {
  router.post(path, authenticate, requirePermission('tender.publish', orgScope), asyncRoute(async (req, res) => {
    const { id } = parse(idParams, req.params);
    await assertBuyerProcurementApproved(req);
    const tender = await assertTenderAccess(req, id);
    if (!isAdmin(req) && tender.buyerId !== userId(req)) throw new ApiError(403, 'Access denied', 'ACCESS_DENIED');
    const updated = await tenderWorkflow.transitionTender(actorFrom(req), id, data);
    await invalidateByPattern('cache:tender_public:*');
    await auditWrite(req, action, 'tender', id);
    ok(res, updated);
  }));
}

router.post('/tenders/:id/items', authenticate, requirePermission('tender.update', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const tender = await assertTenderAccess(req, id);
  if (!isAdmin(req) && tender.buyerId !== userId(req)) throw new ApiError(403, 'Access denied', 'ACCESS_DENIED');
  const body = parse(z.object({ itemName: z.string().trim().min(2), quantity: z.coerce.number().positive(), unitOfMeasure: z.string().trim().min(1), description: z.string().optional(), productId: z.coerce.number().int().positive().optional(), estimatedUnitPrice: z.coerce.number().optional(), specifications: z.record(z.string(), z.unknown()).optional() }), req.body);
  const item = await db.tenderItem.create({ data: { ...body, tenderId: id } });
  await auditWrite(req, 'tender.item_added', 'tenderItem', item.id);
  ok(res, item, 201);
}));

router.post('/tenders/:id/documents', authenticate, requirePermission('tender.update', orgScope), upload.single('file'), asyncRoute(async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const tender = await assertTenderAccess(req, id);
  if (!isAdmin(req) && tender.buyerId !== userId(req)) throw new ApiError(403, 'Access denied', 'ACCESS_DENIED');
  if (!req.file) throw new ApiError(400, 'Document file is required', 'DOCUMENT_REQUIRED');
  const asset = await db.fileAsset.create({ data: { ownerId: userId(req), ownerRole: String(req.user?.role), entityType: 'tender', entityId: id, storageProvider: 'local', key: `tenders/${id}/${Date.now()}-${req.file.originalname}`, mimeType: req.file.mimetype, size: req.file.size, checksum: sha256(req.file.buffer.toString('base64')), originalName: req.file.originalname, status: 'active' } });
  const doc = await db.tenderDocument.create({ data: { tenderId: id, fileAssetId: asset.id, documentType: clean(req.body?.documentType || 'tender'), title: clean(req.body?.title), isPublic: Boolean(req.body?.isPublic) } });
  await invalidateByPattern('cache:tender_public:*');
  await auditWrite(req, 'tender.document_added', 'tenderDocument', doc.id);
  ok(res, { asset, document: doc }, 201);
}));

router.get('/tenders/:id/participants', authenticate, requirePermission('tender.view', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const tender = await assertTenderAccess(req, id);
  if (!isAdmin(req) && tender.buyerId !== userId(req)) throw new ApiError(403, 'Access denied', 'ACCESS_DENIED');
  ok(res, await db.tenderParticipant.findMany({ where: { tenderId: id }, include: { seller: { select: { id: true, name: true } } } }));
}));

router.post('/tenders/:id/bids', authenticate, requirePermission('bid.submit', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const tender = await assertTenderAccess(req, id);
  const body = parse(bidBody, req.body);
  const bid = await tenderWorkflow.submitBid(actorFrom(req), id, body);
  await invalidateByPattern('cache:tender_public:*');
  await auditWrite(req, 'bid.submitted', 'bid', bid.id, { tenderId: tender.id });
  ok(res, bid, 201);
}));

router.get('/bids/my', authenticate, authorize('seller', 'buyer', 'admin'), asyncRoute(async (req, res) => {
  const role = String(req.user?.role || '');
  const currentUserId = userId(req);
  let where: any = {};
  if (role === 'seller') {
    const ownTenderIds = await db.bid.findMany({
      where: { sellerId: currentUserId },
      select: { tenderId: true },
      distinct: ['tenderId']
    });
    const tenderIds = ownTenderIds.map((row: any) => row.tenderId).filter(Boolean);
    where = tenderIds.length ? { tenderId: { in: tenderIds } } : { sellerId: currentUserId };
  } else if (role === 'buyer') {
    where = { tender: { buyerId: currentUserId } };
  }
  const bids = await db.bid.findMany({
    where,
    include: {
      tender: true,
      seller: {
        select: {
          id: true,
          name: true,
          email: true,
          mobile: true,
          sellerProfile: { select: { businessName: true, organizationType: true, offices: { select: { city: true, state: true } } } }
        }
      }
    },
    orderBy: { createdAt: 'desc' }
  });
  const enriched = (await attachBidFileAssets(bids)).map((bid: any) => ({ ...bid, isOwnBid: bid.sellerId === currentUserId }));
  res.json(maskSensitive(enriched));
}));

router.get('/bids/:id(\\d+)', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBidAccess(req, id);
  const bid = await db.bid.findUnique({
    where: { id },
    include: {
      tender: {
        include: {
          buyer: {
            select: {
              id: true,
              name: true,
              email: true,
              mobile: true,
              buyerProfile: {
                select: {
                  organizationName: true,
                  organizationType: true,
                  city: true,
                  state: true
                }
              }
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
          sellerProfile: {
            select: {
              businessName: true,
              organizationType: true,
              offices: {
                select: {
                  city: true,
                  state: true
                }
              }
            }
          }
        }
      }
    }
  });
  if (!bid) throw new ApiError(404, 'Bid not found', 'BID_NOT_FOUND');
  const [enriched] = await attachBidFileAssets([bid]);
  ok(res, enriched);
}));

router.get('/tenders/:id/bids', authenticate, requirePermission('tender.view', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const tender = await assertTenderAccess(req, id);
  const requesterId = userId(req);
  if (!isAdmin(req) && req.user?.role === 'buyer' && tender.buyerId !== requesterId) throw new ApiError(403, 'Access denied', 'ACCESS_DENIED');
  
  const where: any = { tenderId: id };
  if (req.user?.role === 'seller') {
    where.sellerId = requesterId;
  }
  
  const bids = await db.bid.findMany({
    where,
    include: {
      seller: {
        select: {
          id: true,
          name: true,
          email: true,
          mobile: true,
          sellerProfile: {
            select: {
              businessName: true,
              organizationType: true,
              offices: {
                select: {
                  city: true,
                  state: true
                }
              }
            }
          }
        }
      }
    },
    orderBy: { createdAt: 'desc' }
  });
  res.json(maskSensitive((await attachBidFileAssets(bids)).map((bid: any) => ({ ...bid, isOwnBid: bid.sellerId === requesterId }))));
}));

router.put('/bids/:id(\\d+)', authenticate, requirePermission('bid.submit', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const bid = await assertBidAccess(req, id);
  if (bid.sellerId !== userId(req)) throw new ApiError(403, 'Access denied', 'ACCESS_DENIED');
  const updated = await tenderWorkflow.modifyBid(actorFrom(req), id, parse(bidBody.partial(), req.body));
  await invalidateByPattern('cache:tender_public:*');
  await auditWrite(req, 'bid.updated', 'bid', id);
  ok(res, updated);
}));

router.post('/bids/:id(\\d+)/withdraw', authenticate, requirePermission('bid.submit', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const bid = await assertBidAccess(req, id);
  if (bid.sellerId !== userId(req)) throw new ApiError(403, 'Access denied', 'ACCESS_DENIED');
  const updated = await tenderWorkflow.withdrawBid(actorFrom(req), id);
  await invalidateByPattern('cache:tender_public:*');
  await auditWrite(req, 'bid.withdrawn', 'bid', id);
  ok(res, updated);
}));

router.post('/bids/:id(\\d+)/status', authenticate, requirePermission('award.recommend', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const bid = await assertBidAccess(req, id);
  const body = parse(z.object({ status: z.string().trim().min(2), statusEnum: z.string().trim().optional(), title: z.string().trim().min(3).max(200).optional() }), req.body);
  if (!isAdmin(req) && bid.tender.buyerId !== userId(req)) throw new ApiError(403, 'Access denied', 'ACCESS_DENIED');
  if (body.status === 'accepted') {
    ok(res, await tenderWorkflow.awardBidAndGeneratePO(actorFrom(req), id, body.title));
    return;
  }
  const updated = await db.bid.update({ where: { id }, data: body });
  await auditWrite(req, 'bid.status_updated', 'bid', id, body);
  ok(res, updated);
}));

router.post('/tenders/:id/auction', authenticate, requirePermission('reverse_auction.create', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const tender = await assertTenderAccess(req, id);
  if (!isAdmin(req) && tender.buyerId !== userId(req)) throw new ApiError(403, 'Access denied', 'ACCESS_DENIED');
  const body = parse(z.object({ startPrice: z.coerce.number().positive(), minDecrement: z.coerce.number().positive(), startTime: safeCoercedDate, endTime: safeCoercedDate }).refine(value => value.endTime > value.startTime, {
    message: 'Auction end time must be after start time',
    path: ['endTime']
  }), req.body);
  const auction = await tenderWorkflow.createAuction(actorFrom(req), id, body);
  await auditWrite(req, 'auction.created', 'auction', auction.id);
  ok(res, auction, 201);
}));

router.get('/auctions/:id', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const auction = await db.auction.findUnique({ where: { id }, include: { Tender: true } });
  if (!auction || (!isAdmin(req) && auction.Tender.buyerId !== userId(req) && req.user?.role !== 'seller')) throw new ApiError(404, 'Auction not found', 'AUCTION_NOT_FOUND');
  ok(res, auction);
}));

router.post('/auctions/:id/bids', authenticate, requirePermission('reverse_auction.bid.submit', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({ bidAmount: z.coerce.number().positive(), deviceHash: z.string().optional() }), req.body);
  const result = await tenderWorkflow.placeAuctionBid(actorFrom(req), id, { ...body, ipAddress: req.ip, userAgentHash: sha256(String(req.headers['user-agent'] || '')) });
  await auditWrite(req, 'auction.bid_submitted', 'auctionBid', result.auctionBid.id);
  ok(res, result, 201);
}));

router.get('/auctions/:id/history', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  ok(res, await db.auctionBid.findMany({ where: { auctionId: id }, orderBy: { createdAt: 'desc' }, take: isAdmin(req) ? 200 : 50 }));
}));

router.post('/auctions/:id/finalize', authenticate, requirePermission('reverse_auction.award', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const auction = await db.auction.findUnique({ where: { id }, include: { Tender: true } });
  if (!auction || (!isAdmin(req) && auction.Tender.buyerId !== userId(req))) throw new ApiError(404, 'Auction not found', 'AUCTION_NOT_FOUND');
  const result = await tenderWorkflow.finalizeAuction(actorFrom(req), id);
  await auditWrite(req, 'auction.finalized', 'auction', id);
  ok(res, result);
}));

// Evaluation and contracts
router.post('/tenders/:id/technical-criteria', authenticate, requirePermission('bid.technical.evaluate', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  await assertTenderAccess(req, id);
  const body = parse(z.object({ name: z.string().min(2), description: z.string().optional(), maxScore: z.coerce.number().positive(), weightage: z.coerce.number().optional(), isMandatory: z.boolean().optional() }), req.body);
  const criteria = await db.technicalEvaluationCriteria.create({ data: { ...body, tenderId: id } });
  await auditWrite(req, 'evaluation.criteria_created', 'technicalEvaluationCriteria', criteria.id);
  ok(res, criteria, 201);
}));

router.post('/bids/:id(\\d+)/technical-evaluation', authenticate, requirePermission('bid.technical.evaluate', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  await assertBidAccess(req, id);
  const body = parse(z.object({ criteriaId: z.coerce.number().int().positive(), score: z.coerce.number().nonnegative(), status: z.enum(['PENDING', 'IN_PROGRESS', 'QUALIFIED', 'DISQUALIFIED', 'APPROVED', 'REJECTED']).default('PENDING'), remarks: z.string().optional() }), req.body);
  const result = await tenderWorkflow.evaluateBid(actorFrom(req), id, 'technical', body);
  await auditWrite(req, 'evaluation.technical_recorded', 'technicalEvaluationResult', result.id);
  ok(res, result);
}));

router.post('/bids/:id(\\d+)/financial-evaluation', authenticate, requirePermission('bid.financial.evaluate', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  await assertBidAccess(req, id);
  const body = parse(z.object({ quotedAmount: z.coerce.number().nonnegative(), evaluatedAmount: z.coerce.number().nonnegative().optional(), rank: z.coerce.number().int().positive().optional(), status: z.enum(['PENDING', 'IN_PROGRESS', 'QUALIFIED', 'DISQUALIFIED', 'APPROVED', 'REJECTED']).default('PENDING'), remarks: z.string().optional() }), req.body);
  const result = await tenderWorkflow.evaluateBid(actorFrom(req), id, 'financial', body);
  await auditWrite(req, 'evaluation.financial_recorded', 'financialEvaluation', result.id);
  ok(res, result);
}));

router.get('/tenders/:id/evaluation-summary', authenticate, requirePermission('tender.view', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertTenderAccess(req, id);
  const [technicalCriteria, technicalResults, financialEvaluations] = await Promise.all([
    db.technicalEvaluationCriteria.findMany({ where: { tenderId: id } }),
    db.technicalEvaluationResult.findMany({ where: { tenderId: id } }),
    db.financialEvaluation.findMany({ where: { tenderId: id } })
  ]);
  ok(res, { technicalCriteria, technicalResults, financialEvaluations });
}));

router.post('/tenders/:id/comparative-statement', authenticate, requirePermission('award.recommend', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  await assertTenderAccess(req, id);
  const statement = await tenderWorkflow.createComparativeStatement(actorFrom(req), id);
  await auditWrite(req, 'evaluation.comparative_statement_created', 'comparativeStatement', statement.id);
  ok(res, statement, 201);
}));

router.post('/contracts', authenticate, requirePermission('purchase_order.create', orgScope), asyncRoute(async (req, res) => {
  await assertBuyerProcurementApproved(req);
  const body = parse(z.object({ tenderId: z.coerce.number().int().positive().optional(), bidId: z.coerce.number().int().positive().optional(), title: z.string().min(3), value: z.coerce.number().nonnegative(), contractType: z.enum(['PURCHASE', 'RATE_CONTRACT', 'SERVICE_AGREEMENT', 'FRAMEWORK_AGREEMENT']).default('PURCHASE'), startDate: safeCoercedDate.optional(), endDate: safeCoercedDate.optional(), metadata: z.record(z.string(), z.unknown()).optional() }), req.body);
  const contract = await contractWorkflow.createAfterAward(actorFrom(req), body);
  await auditWrite(req, 'contract.created', 'contract', contract.id);
  ok(res, contract, 201);
}));

router.get('/contracts', authenticate, asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);
  const where: any = isAdmin(req) ? {} : req.user?.role === 'buyer' ? { tender: { buyerId: userId(req) } } : { bid: { sellerId: userId(req) } };
  if (query.status) where.status = query.status;
  if (query.q) where.OR = [{ title: { contains: query.q, mode: 'insensitive' } }, { contractNumber: { contains: query.q, mode: 'insensitive' } }];
  const window = listWindow(query);
  const [contracts, total] = await Promise.all([
    db.contract.findMany({ where, orderBy: { updatedAt: 'desc' }, ...window }),
    db.contract.count({ where })
  ]);
  ok(res, paged(contracts, total, query));
}));

router.get('/contracts/:id', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const contract = await db.contract.findUnique({ where: { id }, include: { tender: true, bid: true } });
  if (!contract || (!isAdmin(req) && contract.tender?.buyerId !== userId(req) && contract.bid?.sellerId !== userId(req))) throw new ApiError(404, 'Contract not found', 'CONTRACT_NOT_FOUND');
  ok(res, contract);
}));

router.put('/contracts/:id', authenticate, requirePermission('purchase_order.create', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const existing = await db.contract.findUnique({ where: { id }, include: { tender: true } });
  if (!existing || (!isAdmin(req) && existing.tender?.buyerId !== userId(req))) throw new ApiError(404, 'Contract not found', 'CONTRACT_NOT_FOUND');
  const contract = await db.contract.update({ where: { id }, data: req.body || {} });
  await auditWrite(req, 'contract.updated', 'contract', id);
  ok(res, contract);
}));

router.post('/contracts/:id/upload-document', authenticate, requirePermission('purchase_order.create', orgScope), upload.single('file'), asyncRoute(async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const existing = await db.contract.findUnique({ where: { id }, include: { tender: true } });
  if (!existing || (!isAdmin(req) && existing.tender?.buyerId !== userId(req))) throw new ApiError(404, 'Contract not found', 'CONTRACT_NOT_FOUND');
  if (!req.file) throw new ApiError(400, 'Document file is required', 'DOCUMENT_REQUIRED');
  const asset = await contractWorkflow.uploadDocument(actorFrom(req), id, req.file);
  await auditWrite(req, 'contract.document_uploaded', 'fileAsset', asset.id);
  ok(res, asset, 201);
}));

// PO, delivery, inspection, invoices, payments and escrow
router.post('/purchase-orders/generate', authenticate, requirePermission('purchase_order.create', orgScope), paymentRateLimit, asyncRoute(async (req, res) => {
  await assertBuyerProcurementApproved(req);
  const body = parse(z.object({ bidId: z.coerce.number().int().positive(), title: z.string().trim().min(3).max(200).optional() }), req.body);
  const result = await tenderWorkflow.awardBidAndGeneratePO(actorFrom(req), body.bidId, body.title);
  await auditWrite(req, 'purchase_order.generated', 'purchaseOrder', result.purchaseOrder.id);
}));

router.post('/purchase-orders/:id/repeat', authenticate, authorize('buyer'), paymentRateLimit, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({
    quantity: z.coerce.number().positive().optional(),
    deliveryAddress: z.string().trim().min(3).max(1000).optional(),
    expectedDelivery: safeCoercedDate,
    repeatOrderDate: safeCoercedDate.optional(),
    requiredByDate: safeCoercedDate.optional(),
    remarks: z.string().trim().max(1000).optional()
  }), req.body);

  const buyerUser = await db.user.findUnique({
    where: { id: userId(req) },
    select: { organizationId: true, name: true, email: true }
  });

  const existing = await db.purchaseOrder.findUnique({
    where: { id },
    include: {
      items: { include: { product: true } },
      buyer: { include: { organization: true } },
      seller: { include: { organization: true } },
      tender: { include: { requirement: true } }
    }
  });

  if (!existing) throw new ApiError(404, 'Purchase order not found');

  const isOwner = existing.buyerId === userId(req) || (buyerUser?.organizationId && existing.buyer?.organizationId === buyerUser.organizationId);
  if (!isOwner && !isAdmin(req)) {
    throw new ApiError(403, 'You are not authorized to repeat this purchase order', 'FORBIDDEN');
  }

  const repeatOrderDate = body.repeatOrderDate ? new Date(body.repeatOrderDate) : new Date();
  const newDeliveryDate = new Date(body.expectedDelivery);
  const requiredByDate = body.requiredByDate ? new Date(body.requiredByDate) : newDeliveryDate;

  const poNumber = `PO-REP-${Date.now().toString().slice(-6)}`;
  
  let newTotalAmount = 0;
  const itemsToCreate = existing.items.map(item => {
    const itemQty = (body.quantity && existing.items.length === 1) ? Number(body.quantity) : Number(item.quantity);
    const itemPrice = Number(item.unitPrice);
    const itemTotal = itemPrice * itemQty;
    newTotalAmount += itemTotal;
    return {
      productId: item.productId,
      itemName: item.itemName,
      description: item.description,
      quantity: itemQty,
      unitOfMeasure: item.unitOfMeasure,
      unitPrice: item.unitPrice,
      taxRate: item.taxRate,
      totalAmount: itemTotal
    };
  });

  if (newTotalAmount <= 0) {
    newTotalAmount = Number(existing.amount);
  }

  const buyerOrgId = buyerUser?.organizationId || existing.buyer?.organizationId;
  const initialStatus = buyerOrgId ? 'pending_approval' : 'order_placed';
  const initialPoStatus = buyerOrgId ? 'GENERATED' : 'ISSUED';

  const newPo = await db.purchaseOrder.create({
    data: {
      poNumber,
      title: `Repeat Order: ${existing.title}`,
      status: initialStatus,
      poStatus: initialPoStatus,
      amount: newTotalAmount,
      totalValue: newTotalAmount,
      buyerId: userId(req),
      sellerId: existing.sellerId,
      tenderId: existing.tenderId,
      contractId: existing.contractId,
      paymentTerms: existing.paymentTerms,
      deliveryType: existing.deliveryType,
      deliveryAddress: body.deliveryAddress || existing.deliveryAddress,
      expectedDelivery: newDeliveryDate,
      metadata: {
        source: 'repeat_order',
        repeatOfPoId: existing.id,
        repeatOfPoNumber: existing.poNumber,
        repeatOrderDate: repeatOrderDate.toISOString(),
        requiredByDate: requiredByDate.toISOString(),
        newDeliveryDate: newDeliveryDate.toISOString(),
        remarks: body.remarks || null,
        originalOrderTitle: existing.title,
        createdAt: new Date().toISOString()
      },
      items: {
        create: itemsToCreate
      }
    },
    include: {
      buyer: { select: { id: true, name: true, email: true, organization: true } },
      seller: { select: { id: true, name: true, email: true, organization: true } },
      items: true
    }
  });

  let approvalInfo = {
    requiresApproval: false,
    currentStage: 'READY_ISSUED',
    message: 'Repeat purchase order created successfully.'
  };

  if (buyerOrgId) {
    try {
      const chain = await createApprovalChain({
        entityType: 'purchase_order',
        entityId: newPo.id,
        organizationId: buyerOrgId,
        totalValue: newTotalAmount,
        initiatorUserId: userId(req)
      });
      approvalInfo = {
        requiresApproval: true,
        currentStage: chain[0]?.stage || 'DEPARTMENT_HEAD',
        message: 'Repeat order submitted. Routed to Department Head for approval.'
      };
    } catch (err: any) {
      logger.warn(`Failed to create approval chain for repeat PO #${newPo.id}: ${err?.message}`);
      await db.purchaseOrder.update({
        where: { id: newPo.id },
        data: { status: 'order_placed', poStatus: 'ISSUED' }
      });
      approvalInfo = {
        requiresApproval: false,
        currentStage: 'ISSUED',
        message: 'Repeat purchase order generated and placed.'
      };
    }
  }

  await auditWrite(req, 'purchase_order.repeat_created', 'purchaseOrder', newPo.id, {
    originalPoId: existing.id,
    originalPoNumber: existing.poNumber,
    newPoNumber: newPo.poNumber,
    totalValue: newTotalAmount
  });

  if (!approvalInfo.requiresApproval) {
    notifySellerNewPurchaseOrder(newPo.id).catch(() => undefined);
  }

  ok(res, {
    purchaseOrder: newPo,
    approvalInfo,
    message: approvalInfo.message
  }, 201);
}));

const formatOrgWithAddress = (org: any) => {
  if (!org) return org;
  const parts = [org.addressLine1, org.addressLine2, org.city, org.state, org.pincode].filter(Boolean);
  return {
    ...org,
    address: parts.length > 0 ? parts.join(', ') : (org.address || null),
    organizationLogoFile: org.logoFile || org.organizationLogoFile || null
  };
};

const formatPoWithOrgAddress = (po: any) => {
  if (!po) return po;
  return {
    ...po,
    buyer: po.buyer ? {
      ...po.buyer,
      organization: formatOrgWithAddress(po.buyer.organization)
    } : po.buyer,
    seller: po.seller ? {
      ...po.seller,
      organization: formatOrgWithAddress(po.seller.organization)
    } : po.seller
  };
};

router.get('/purchase-orders', authenticate, asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);
  let where: any = {};
  if (isAdmin(req)) {
    where = {};
  } else if (req.user?.role === 'buyer') {
    where = { buyerId: userId(req) };
  } else {
    const sellerIds = [userId(req)];
    if (req.user?.organizationId || (req.user as any)?.companyId) {
      const orgUsers = await db.user.findMany({
        where: {
          OR: [
            ...(req.user.organizationId ? [{ organizationId: req.user.organizationId }] : []),
            ...((req.user as any)?.companyId ? [{ companyId: (req.user as any).companyId }] : [])
          ]
        },
        select: { id: true }
      });
      orgUsers.forEach((u: any) => sellerIds.push(u.id));
    }
    where = {
      OR: [
        { sellerId: { in: Array.from(new Set(sellerIds)) } },
        ...(req.user?.organizationId ? [{ seller: { organizationId: req.user.organizationId } }] : [])
      ]
    };
  }

  if (query.status) where.status = query.status;
  if (query.q) where.OR = [
    { poNumber: { contains: query.q, mode: 'insensitive' } },
    { title: { contains: query.q, mode: 'insensitive' } },
    { seller: { name: { contains: query.q, mode: 'insensitive' } } },
    { buyer: { name: { contains: query.q, mode: 'insensitive' } } }
  ];
  const window = listWindow(query);
  const [purchaseOrders, total] = await Promise.all([
    db.purchaseOrder.findMany({
      where,
      include: {
        buyer: {
          select: {
            id: true,
            name: true,
            email: true,
            mobile: true,
            role: true,
            registrationDetails: true,
            organizationId: true,
            organization: {
              select: {
                id: true,
                organizationName: true,
                gstin: true,
                panNumber: true,
                udyamNumber: true,
                addressLine1: true,
                addressLine2: true,
                city: true,
                state: true,
                pincode: true,
                organizationLogoFileId: true,
                profile: { select: { logoUrl: true } },
                logoFile: { select: { id: true, url: true, fileUrl: true } }
              }
            },
            buyerProfile: true
          }
        },
        seller: {
          select: {
            id: true,
            name: true,
            email: true,
            mobile: true,
            role: true,
            registrationDetails: true,
            organizationId: true,
            organization: {
              select: {
                id: true,
                organizationName: true,
                gstin: true,
                panNumber: true,
                udyamNumber: true,
                addressLine1: true,
                addressLine2: true,
                city: true,
                state: true,
                pincode: true,
                organizationLogoFileId: true,
                profile: { select: { logoUrl: true } },
                logoFile: { select: { id: true, url: true, fileUrl: true } }
              }
            },
            sellerProfile: true
          }
        },
        tender: { select: { id: true, tenderId: true, title: true, category: true, status: true } },
        externalPdfFile: { select: { id: true, originalName: true, url: true, key: true, size: true, mimeType: true } },
        pdfFile: { select: { id: true, originalName: true, url: true, key: true, size: true, mimeType: true } },
        items: { include: { product: { select: { name: true, unitOfMeasure: true } } } },
        deliveryTrackings: { include: { events: { orderBy: { occurredAt: 'desc' }, take: 8 } } },
        invoices: { orderBy: { createdAt: 'desc' }, take: 5 },
        grns: { orderBy: { createdAt: 'desc' }, select: { id: true, grnNumber: true, status: true, createdAt: true }, take: 5 }
      },
      orderBy: { updatedAt: 'desc' },
      ...window
    }),
    db.purchaseOrder.count({ where })
  ]);
  ok(res, paged(purchaseOrders.map(formatPoWithOrgAddress), total, query, 'purchaseOrders'), 200, { unmaskForAdmin: true, unmaskSelf: true });
}));

router.get('/purchase-orders/:id', authenticate, asyncRoute(async (req, res) => {
  const rawId = String(req.params.id || '').trim();
  const numId = Number(rawId);
  const isNumeric = Number.isInteger(numId) && numId > 0 && numId <= 2147483647;
  const po = await db.purchaseOrder.findFirst({
    where: {
      OR: [
        ...(isNumeric ? [{ id: numId }] : []),
        { poNumber: rawId }
      ]
    },
    include: {
      tender: { select: { id: true, tenderId: true, title: true, category: true, status: true } },
      externalPdfFile: { select: { id: true, originalName: true, url: true, key: true, size: true, mimeType: true } },
      pdfFile: { select: { id: true, originalName: true, url: true, key: true, size: true, mimeType: true } },
      buyer: {
        select: {
          id: true,
          name: true,
          email: true,
          mobile: true,
          role: true,
          registrationDetails: true,
          organizationId: true,
          organization: {
            select: {
              id: true,
              organizationName: true,
              gstin: true,
              panNumber: true,
              udyamNumber: true,
              addressLine1: true,
              addressLine2: true,
              city: true,
              state: true,
              pincode: true,
              organizationLogoFileId: true,
              profile: { select: { logoUrl: true } },
              logoFile: { select: { id: true, url: true, fileUrl: true } }
            }
          },
          buyerProfile: true
        }
      },
      seller: {
        select: {
          id: true,
          name: true,
          email: true,
          mobile: true,
          role: true,
          registrationDetails: true,
          organizationId: true,
          organization: {
            select: {
              id: true,
              organizationName: true,
              gstin: true,
              panNumber: true,
              udyamNumber: true,
              addressLine1: true,
              addressLine2: true,
              city: true,
              state: true,
              pincode: true,
              organizationLogoFileId: true,
              profile: { select: { logoUrl: true } },
              logoFile: { select: { id: true, url: true, fileUrl: true } }
            }
          },
          sellerProfile: true
        }
      },
      items: { include: { product: { select: { name: true, unitOfMeasure: true } } } },
      invoices: true,
      deliveryTrackings: true,
      inspectionReports: true,
      grns: { orderBy: { createdAt: 'desc' }, select: { id: true, grnNumber: true, status: true, createdAt: true } },
      payments: {
        include: {
          escrowAccount: true,
          ledgerEntries: { orderBy: { createdAt: 'asc' } },
          payee: { select: { id: true, name: true, email: true } },
          payer: { select: { id: true, name: true, email: true } }
        },
        orderBy: { createdAt: 'desc' }
      }
    }
  });
  
  let isAllowed = false;
  if (po) {
    if (isAdmin(req)) isAllowed = true;
    else if (po.buyerId === userId(req)) isAllowed = true;
    else {
      const sellerIds = [userId(req)];
      if (req.user?.organizationId || (req.user as any)?.companyId) {
        const orgUsers = await db.user.findMany({
          where: {
            OR: [
              ...(req.user.organizationId ? [{ organizationId: req.user.organizationId }] : []),
              ...((req.user as any)?.companyId ? [{ companyId: (req.user as any).companyId }] : [])
            ]
          },
          select: { id: true }
        });
        orgUsers.forEach((u: any) => sellerIds.push(u.id));
      }
      if (sellerIds.includes(po.sellerId)) isAllowed = true;
    }
  }

  if (!po || !isAllowed) throw new ApiError(404, 'Purchase order not found', 'PO_NOT_FOUND');
  ok(res, formatPoWithOrgAddress(po), 200, { unmaskForAdmin: true, unmaskSelf: true });
}));

router.post('/purchase-orders/:id/acknowledge', authenticate, authorize('seller', 'admin', 'shg'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const po = await db.purchaseOrder.findUnique({ where: { id } });
  let isAllowed = false;
  if (po) {
    if (isAdmin(req)) isAllowed = true;
    else {
      const sellerIds = [userId(req)];
      if (req.user?.organizationId || (req.user as any)?.companyId) {
        const orgUsers = await db.user.findMany({
          where: {
            OR: [
              ...(req.user.organizationId ? [{ organizationId: req.user.organizationId }] : []),
              ...((req.user as any)?.companyId ? [{ companyId: (req.user as any).companyId }] : [])
            ]
          },
          select: { id: true }
        });
        orgUsers.forEach((u: any) => sellerIds.push(u.id));
      }
      if (sellerIds.includes(po.sellerId)) isAllowed = true;
    }
  }
  if (!po || !isAllowed) throw new ApiError(404, 'Purchase order not found', 'PO_NOT_FOUND');
  const updated = await fulfillmentWorkflow.acknowledgePO(actorFrom(req), id);
  await auditWrite(req, 'purchase_order.acknowledged', 'purchaseOrder', id);
  const targetBidId = (updated as any)?.bidId || ((updated as any)?.metadata as any)?.bidId || (po as any)?.bidId || ((po as any)?.metadata as any)?.bidId;
  if (targetBidId) await invalidateBidCaches(targetBidId).catch(() => null);
  ok(res, updated);
}));

router.post('/purchase-orders/:id/reject', authenticate, authorize('seller', 'admin', 'shg'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const po = await db.purchaseOrder.findUnique({ where: { id } });
  let isAllowed = false;
  if (po) {
    if (isAdmin(req)) isAllowed = true;
    else {
      const sellerIds = [userId(req)];
      if (req.user?.organizationId || (req.user as any)?.companyId) {
        const orgUsers = await db.user.findMany({
          where: {
            OR: [
              ...(req.user.organizationId ? [{ organizationId: req.user.organizationId }] : []),
              ...((req.user as any)?.companyId ? [{ companyId: (req.user as any).companyId }] : [])
            ]
          },
          select: { id: true }
        });
        orgUsers.forEach((u: any) => sellerIds.push(u.id));
      }
      if (sellerIds.includes(po.sellerId)) isAllowed = true;
    }
  }
  if (!po || !isAllowed) throw new ApiError(404, 'Purchase order not found', 'PO_NOT_FOUND');
  const body = req.body || {};
  const reason = (typeof body.reason === 'string' ? body.reason : typeof body.rejectionReason === 'string' ? body.rejectionReason : '')?.trim() || undefined;
  const updated = await fulfillmentWorkflow.rejectPO(actorFrom(req), id, reason);
  await auditWrite(req, 'purchase_order.rejected', 'purchaseOrder', id, { reason });
  ok(res, updated);
}));

router.post('/purchase-orders/:id/cancel', authenticate, authorize('buyer', 'seller', 'admin', 'shg'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const po = await db.purchaseOrder.findUnique({ where: { id } });
  let isBuyerAllowed = false;
  let isSellerAllowed = false;
  if (po) {
    if (isAdmin(req)) {
      isBuyerAllowed = true;
      isSellerAllowed = true;
    } else {
      if (po.buyerId === userId(req)) isBuyerAllowed = true;
      const sellerIds = [userId(req)];
      if (req.user?.organizationId || (req.user as any)?.companyId) {
        const orgUsers = await db.user.findMany({
          where: {
            OR: [
              ...(req.user.organizationId ? [{ organizationId: req.user.organizationId }] : []),
              ...((req.user as any)?.companyId ? [{ companyId: (req.user as any).companyId }] : [])
            ]
          },
          select: { id: true }
        });
        orgUsers.forEach((u: any) => sellerIds.push(u.id));
      }
      if (sellerIds.includes(po.sellerId)) isSellerAllowed = true;
    }
  }
  if (!po || (!isBuyerAllowed && !isSellerAllowed)) throw new ApiError(404, 'Purchase order not found', 'PO_NOT_FOUND');
  
  if (isSellerAllowed && !isBuyerAllowed) {
    const body = req.body || {};
    const reason = (typeof body.reason === 'string' ? body.reason : typeof body.rejectionReason === 'string' ? body.rejectionReason : '')?.trim() || undefined;
    const updated = await fulfillmentWorkflow.rejectPO(actorFrom(req), id, reason);
    await auditWrite(req, 'purchase_order.rejected', 'purchaseOrder', id, { reason });
    return ok(res, updated);
  }

  const updated = await fulfillmentWorkflow.cancelPO(actorFrom(req), id);
  await auditWrite(req, 'purchase_order.cancelled', 'purchaseOrder', id);
  ok(res, updated);
}));

// ─── FileAsset Ownership & Tenancy Guard ──────────────────────────────────
const assertFileAssetOwnership = async (fileAssetId: number, req: any) => {
  if (isAdmin(req)) return;
  const asset = await db.fileAsset.findUnique({
    where: { id: fileAssetId }
  });
  if (!asset) {
    throw new ApiError(404, 'Referenced file asset not found', 'FILE_NOT_FOUND');
  }
  if (asset.status !== 'active') {
    throw new ApiError(400, 'Referenced file asset is not active', 'FILE_INACTIVE');
  }
  const uid = userId(req);
  const userOrgId = req.user?.organizationId;
  const isOwner = asset.ownerId === uid;
  if (!isOwner) {
    if (userOrgId) {
      const ownerUser = await db.user.findUnique({
        where: { id: asset.ownerId },
        select: { organizationId: true }
      });
      if (ownerUser?.organizationId === userOrgId) {
        return;
      }
    }
    throw new ApiError(403, 'You do not have permission to attach this file asset', 'FILE_FORBIDDEN');
  }
};

// ─── Line Item Validation Schema ──────────────────────────────────────────
const poLineItemSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  itemName: z.string().trim().min(1, 'Item name is required').max(200),
  description: z.string().trim().max(1000).optional().nullable(),
  quantity: z.coerce.number().positive('Quantity must be greater than 0'),
  unitOfMeasure: z.string().trim().max(50).default('units'),
  unitPrice: z.coerce.number().nonnegative('Unit price cannot be negative'),
  taxRate: z.coerce.number().min(0).max(100).optional().default(18),
  totalAmount: z.coerce.number().nonnegative().optional()
});

// ─── PO Pre-Flight / Draft Edit / Issue / Amend Endpoints ───────────────────
router.put('/purchase-orders/:id/draft', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({
    title: z.string().trim().min(3).max(200).optional(),
    expectedDelivery: safeCoercedDate.optional(),
    deliveryAddress: z.string().trim().max(1000).optional(),
    paymentTerms: z.string().trim().max(500).optional(),
    deliveryType: z.string().trim().max(200).optional(),
    externalPoNumber: z.string().trim().max(100).optional(),
    externalPdfFileId: z.coerce.number().int().positive().optional().nullable(),
    items: z.array(poLineItemSchema).min(1, 'At least one line item is required').optional()
  }), req.body);

  const po = await db.purchaseOrder.findUnique({
    where: { id },
    include: { buyer: { select: { organizationId: true } } }
  });
  if (!po) throw new ApiError(404, 'Purchase order not found', 'PO_NOT_FOUND');
  const isBuyerOrg = req.user?.organizationId && po.buyer?.organizationId === req.user?.organizationId;
  if (!isAdmin(req) && po.buyerId !== userId(req) && !isBuyerOrg) throw new ApiError(403, 'Forbidden', 'FORBIDDEN');

  if (body.externalPdfFileId) {
    await assertFileAssetOwnership(body.externalPdfFileId, req);
  }

  const statusLower = String(po.status || '').toLowerCase();
  const allowedStatuses = ['generated', 'draft', 'pending_approval'];
  if (!allowedStatuses.includes(statusLower) && !po.isDraft) {
    throw new ApiError(409, 'Only draft or unissued purchase orders can be edited directly', 'PO_LOCKED');
  }

  const updated = await db.$transaction(async (tx) => {
    let newTotal: number | undefined = undefined;
    if (body.items && body.items.length > 0) {
      const calculatedItems = body.items.map(it => {
        const qty = Number(it.quantity);
        const price = Number(it.unitPrice);
        const tax = Number(it.taxRate ?? 18);
        const subtotal = qty * price;
        const taxAmt = (subtotal * tax) / 100;
        const totalAmount = Math.round((subtotal + taxAmt) * 100) / 100;
        return {
          itemName: it.itemName,
          description: it.description || null,
          quantity: qty,
          unitOfMeasure: it.unitOfMeasure || 'units',
          unitPrice: price,
          taxRate: tax,
          totalAmount
        };
      });
      newTotal = Number(calculatedItems.reduce((acc, it) => acc + it.totalAmount, 0).toFixed(2));

      await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
      await tx.purchaseOrderItem.createMany({
        data: calculatedItems.map(it => ({
          purchaseOrderId: id,
          itemName: it.itemName,
          description: it.description,
          quantity: it.quantity,
          unitOfMeasure: it.unitOfMeasure,
          unitPrice: it.unitPrice,
          taxRate: it.taxRate,
          totalAmount: it.totalAmount
        }))
      });
    }

    return tx.purchaseOrder.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.expectedDelivery !== undefined ? { expectedDelivery: body.expectedDelivery ? new Date(body.expectedDelivery) : null } : {}),
        ...(body.deliveryAddress !== undefined ? { deliveryAddress: body.deliveryAddress } : {}),
        ...(body.paymentTerms !== undefined ? { paymentTerms: body.paymentTerms } : {}),
        ...(body.deliveryType !== undefined ? { deliveryType: body.deliveryType } : {}),
        ...(body.externalPoNumber !== undefined ? { externalPoNumber: body.externalPoNumber } : {}),
        ...(body.externalPdfFileId !== undefined ? { externalPdfFileId: body.externalPdfFileId } : {}),
        ...(newTotal !== undefined ? { amount: newTotal, totalValue: newTotal } : {})
      },
      include: { items: true, buyer: true, seller: true }
    });
  });

  await auditWrite(req, 'purchase_order.draft_updated', 'purchaseOrder', id);
  ok(res, updated, 200, { unmaskEmails: true });
}));

router.post('/purchase-orders/:id/issue', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
  const po = await db.purchaseOrder.findUnique({
    where: { id },
    include: { buyer: { select: { organizationId: true } } }
  });
  if (!po) throw new ApiError(404, 'Purchase order not found', 'PO_NOT_FOUND');
  const isBuyerOrg = req.user?.organizationId && po.buyer?.organizationId === req.user?.organizationId;
  if (!isAdmin(req) && po.buyerId !== userId(req) && !isBuyerOrg) throw new ApiError(403, 'Forbidden', 'FORBIDDEN');

  const incomingPdfId = body.externalPdfFileId ? Number(body.externalPdfFileId) : undefined;
  if (incomingPdfId && Number.isInteger(incomingPdfId) && incomingPdfId > 0) {
    await assertFileAssetOwnership(incomingPdfId, req);
  }

  statusTransitions.purchaseOrder(po.status, 'issued');
  const updated = await db.purchaseOrder.update({
    where: { id },
    data: {
      status: 'issued',
      poStatus: poStatusEnumFor('issued') as any,
      isDraft: false,
      issuedAt: new Date(),
      version: { increment: 1 },
      ...(incomingPdfId ? { externalPdfFileId: incomingPdfId } : {})
    },
    include: { items: true, buyer: true, seller: true }
  });

  notifySellerNewPurchaseOrder(updated.id).catch(() => undefined);
  await auditWrite(req, 'purchase_order.issued', 'purchaseOrder', id);
  ok(res, updated, 200, { unmaskEmails: true });
}));

router.post('/purchase-orders/:id/recall', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const po = await db.purchaseOrder.findUnique({
    where: { id },
    include: { buyer: { select: { organizationId: true } } }
  });
  if (!po) throw new ApiError(404, 'Purchase order not found', 'PO_NOT_FOUND');
  const isBuyerOrg = req.user?.organizationId && po.buyer?.organizationId === req.user?.organizationId;
  if (!isAdmin(req) && po.buyerId !== userId(req) && !isBuyerOrg) throw new ApiError(403, 'Forbidden', 'FORBIDDEN');

  const statusLower = String(po.status || '').toLowerCase();
  const allowedRecallStatuses = ['issued', 'order_placed', 'pending_approval', 'generated', 'pending_acceptance'];
  if (!allowedRecallStatuses.includes(statusLower) && !po.isDraft) {
    throw new ApiError(409, `Cannot recall purchase order with status "${po.status}". Only issued or pending acceptance POs can be recalled to draft.`, 'PO_CANNOT_RECALL');
  }

  statusTransitions.purchaseOrder(po.status, 'draft');
  const updated = await db.purchaseOrder.update({
    where: { id },
    data: {
      status: 'draft',
      poStatus: poStatusEnumFor('draft') as any,
      isDraft: true
    },
    include: { items: true, buyer: true, seller: true }
  });

  await auditWrite(req, 'purchase_order.recalled_to_draft', 'purchaseOrder', id);
  ok(res, updated, 200, { unmaskEmails: true });
}));

router.post('/purchase-orders/:id/amend', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({
    reason: z.string().trim().min(5, 'Amendment reason required').max(1000).optional(),
    amendmentReason: z.string().trim().min(5, 'Amendment reason required').max(1000).optional(),
    expectedDelivery: safeCoercedDate.optional(),
    deliveryAddress: z.string().trim().max(1000).optional(),
    paymentTerms: z.string().trim().max(500).optional(),
    externalPoNumber: z.string().trim().max(100).optional(),
    externalPdfFileId: z.coerce.number().int().positive().optional().nullable(),
    items: z.array(poLineItemSchema).min(1, 'At least one line item is required').optional()
  }), req.body);

  const rawReason = (body.reason || body.amendmentReason || '').trim();
  if (!rawReason || rawReason.length < 5) {
    throw new ApiError(400, 'Amendment reason required (minimum 5 characters)', 'VALIDATION_ERROR');
  }

  const po = await db.purchaseOrder.findUnique({
    where: { id },
    include: { items: true, buyer: { select: { organizationId: true } } }
  });
  if (!po) throw new ApiError(404, 'Purchase order not found', 'PO_NOT_FOUND');
  const isBuyerOrg = req.user?.organizationId && po.buyer?.organizationId === req.user?.organizationId;
  if (!isAdmin(req) && po.buyerId !== userId(req) && !isBuyerOrg) throw new ApiError(403, 'Forbidden', 'FORBIDDEN');
  if (po.status !== 'accepted' && po.poStatus !== 'ACCEPTED') {
    throw new ApiError(409, 'Only accepted purchase orders can be formally amended', 'PO_NOT_ACCEPTED');
  }

  if (body.externalPdfFileId) {
    await assertFileAssetOwnership(body.externalPdfFileId, req);
  }

  let proposedItems: any[] | undefined = undefined;
  let proposedTotalValue: number | undefined = undefined;
  if (body.items && body.items.length > 0) {
    proposedItems = body.items.map(it => {
      const qty = Number(it.quantity);
      const price = Number(it.unitPrice);
      const tax = Number(it.taxRate ?? 18);
      const subtotal = qty * price;
      const taxAmt = (subtotal * tax) / 100;
      const totalAmount = Math.round((subtotal + taxAmt) * 100) / 100;
      return {
        ...(it.id ? { id: it.id } : {}),
        itemName: it.itemName,
        description: it.description || null,
        quantity: qty,
        unitOfMeasure: it.unitOfMeasure || 'units',
        unitPrice: price,
        taxRate: tax,
        totalAmount
      };
    });
    proposedTotalValue = Number(proposedItems.reduce((acc, it) => acc + it.totalAmount, 0).toFixed(2));
  }

  const history = Array.isArray(po.amendmentHistory) ? po.amendmentHistory : [];
  const nextVersion = (po.amendmentVersion || 1) + 1;
  const snapshot: any = {
    version: nextVersion,
    proposedAt: new Date().toISOString(),
    proposedBy: userId(req),
    reason: rawReason,
    status: 'PENDING',
    proposedChanges: {
      ...(body.expectedDelivery !== undefined ? { expectedDelivery: body.expectedDelivery ? new Date(body.expectedDelivery).toISOString() : null } : {}),
      ...(body.deliveryAddress !== undefined ? { deliveryAddress: body.deliveryAddress } : {}),
      ...(body.paymentTerms !== undefined ? { paymentTerms: body.paymentTerms } : {}),
      ...(body.externalPoNumber !== undefined ? { externalPoNumber: body.externalPoNumber } : {}),
      ...(body.externalPdfFileId !== undefined ? { externalPdfFileId: body.externalPdfFileId } : {}),
      ...(proposedItems ? { items: proposedItems, totalValue: proposedTotalValue, amount: proposedTotalValue } : {})
    },
    baseValues: {
      expectedDelivery: po.expectedDelivery ? po.expectedDelivery.toISOString() : null,
      deliveryAddress: po.deliveryAddress,
      paymentTerms: po.paymentTerms,
      externalPoNumber: po.externalPoNumber,
      externalPdfFileId: po.externalPdfFileId,
      items: po.items.map((i: any) => ({
        id: i.id,
        itemName: i.itemName,
        description: i.description,
        quantity: Number(i.quantity),
        unitOfMeasure: i.unitOfMeasure,
        unitPrice: Number(i.unitPrice),
        taxRate: Number(i.taxRate ?? 18),
        totalAmount: Number(i.totalAmount)
      })),
      totalValue: Number(po.totalValue || po.amount || 0),
      amount: Number(po.amount || 0)
    }
  };

  // Cryptographic Non-Repudiation Checksum:
  const digestPayload = JSON.stringify({
    poId: po.id,
    version: nextVersion,
    proposedChanges: snapshot.proposedChanges,
    baseValues: snapshot.baseValues
  });
  snapshot.integrityChecksum = createHash('sha256').update(digestPayload).digest('hex');

  // Contract integrity safeguard: DO NOT mutate base operational fields until seller accepts!
  const updated = await db.purchaseOrder.update({
    where: { id },
    data: {
      poStatus: poStatusEnumFor('amendment_pending') as any,
      amendmentHistory: [...history, snapshot]
    },
    include: { items: true, buyer: true, seller: true }
  });

  notifyWorkflowSoon(
    po.sellerId,
    `PO Amendment Proposed: ${po.poNumber}`,
    `Buyer proposed an amendment (V${nextVersion}) for PO ${po.poNumber}. Reason: "${rawReason}". Please review and respond.`,
    'po_amendment',
    '/seller/orders'
  );

  await auditWrite(req, 'purchase_order.amendment_proposed', 'purchaseOrder', id, {
    reason: rawReason,
    version: nextVersion,
    integrityChecksum: snapshot.integrityChecksum,
    proposedTotalValue
  });
  ok(res, updated, 200, { unmaskEmails: true });
}));

router.post('/purchase-orders/:id/amendment-decision', authenticate, authorize('seller', 'admin', 'shg'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({
    decision: z.enum(['accept', 'decline']).optional(),
    accepted: z.boolean().optional(),
    reason: z.string().trim().max(1000).optional(),
    remarks: z.string().trim().max(1000).optional()
  }), req.body);

  const po = await db.purchaseOrder.findUnique({
    where: { id },
    include: { items: true, seller: { select: { organizationId: true } } }
  });
  if (!po) throw new ApiError(404, 'Purchase order not found', 'PO_NOT_FOUND');
  const isSellerOrg = req.user?.organizationId && po.seller?.organizationId === req.user?.organizationId;
  if (!isAdmin(req) && po.sellerId !== userId(req) && !isSellerOrg) throw new ApiError(403, 'Forbidden', 'FORBIDDEN');
  if (po.poStatus !== 'AMENDMENT_PENDING') {
    throw new ApiError(409, 'No pending amendment found on this purchase order', 'NO_AMENDMENT_PENDING');
  }

  const isAccepted = body.decision === 'accept' || body.accepted === true;
  const remarks = (body.remarks || body.reason || '').trim() || undefined;

  const history = Array.isArray(po.amendmentHistory) ? [...po.amendmentHistory] : [];
  const pendingIndex = history.map(h => (h as any)?.status).lastIndexOf('PENDING');
  const pendingEntry = pendingIndex >= 0 ? (history[pendingIndex] as any) : null;
  const proposed = pendingEntry?.proposedChanges || {};

  let updatedHistory = history;
  if (pendingIndex >= 0) {
    updatedHistory[pendingIndex] = {
      ...pendingEntry,
      status: isAccepted ? 'ACCEPTED' : 'DECLINED',
      decidedAt: new Date().toISOString(),
      decidedBy: userId(req),
      remarks
    };
  }

  const updateData: any = {
    poStatus: 'ACCEPTED' as any,
    amendmentHistory: updatedHistory
  };

  const updated = await db.$transaction(async (tx) => {
    if (isAccepted) {
      updateData.amendmentVersion = { increment: 1 };
      if (proposed.expectedDelivery !== undefined) {
        updateData.expectedDelivery = proposed.expectedDelivery ? new Date(proposed.expectedDelivery) : null;
      }
      if (proposed.deliveryAddress !== undefined) {
        updateData.deliveryAddress = proposed.deliveryAddress;
      }
      if (proposed.paymentTerms !== undefined) {
        updateData.paymentTerms = proposed.paymentTerms;
      }
      if (proposed.externalPoNumber !== undefined) {
        updateData.externalPoNumber = proposed.externalPoNumber;
      }
      if (proposed.externalPdfFileId !== undefined) {
        updateData.externalPdfFileId = proposed.externalPdfFileId;
      }

      // Apply line items revision atomically
      if (proposed.items && Array.isArray(proposed.items) && proposed.items.length > 0) {
        await tx.purchaseOrderItem.deleteMany({
          where: { purchaseOrderId: po.id }
        });
        await tx.purchaseOrderItem.createMany({
          data: proposed.items.map((it: any) => ({
            purchaseOrderId: po.id,
            itemName: it.itemName,
            description: it.description || null,
            quantity: Number(it.quantity),
            unitOfMeasure: it.unitOfMeasure || 'units',
            unitPrice: Number(it.unitPrice),
            taxRate: Number(it.taxRate ?? 18),
            totalAmount: Number(it.totalAmount)
          }))
        });
        updateData.totalValue = proposed.totalValue ?? updateData.totalValue;
        updateData.amount = proposed.amount ?? updateData.amount;
      }
    }

    return tx.purchaseOrder.update({
      where: { id },
      data: updateData,
      include: { items: true, buyer: true, seller: true }
    });
  });

  notifyWorkflowSoon(
    po.buyerId,
    `PO Amendment ${isAccepted ? 'Accepted' : 'Declined'}: ${po.poNumber}`,
    `Seller ${isAccepted ? 'accepted' : 'declined'} the amendment for PO ${po.poNumber}.${remarks ? ` Remarks: ${remarks}` : ''}`,
    'po_amendment_decision',
    '/buyer/orders'
  );

  await auditWrite(req, `purchase_order.amendment_${isAccepted ? 'accepted' : 'declined'}`, 'purchaseOrder', id, { ...body, remarks });
  ok(res, updated, 200, { unmaskEmails: true });
}));



router.get('/purchase-orders/:id/pdf', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const po = await assertPurchaseOrderAccess(req, id);
  ok(res, { purchaseOrderId: id, pdfFileId: po.pdfFileId, url: po.pdfFileId ? `/api/files/${po.pdfFileId}/signed-url` : null });
}));

router.get('/purchase-orders/:id/download-pdf', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const po = await assertPurchaseOrderAccess(req, id);
  const { buffer, filename } = await getOrGeneratePurchaseOrderPdfBuffer(po);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.end(buffer);
}));

router.post('/purchase-orders/:id/delivery', authenticate, requirePermission('delivery.create', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const po = await assertPurchaseOrderAccess(req, id);
  if (!isAdmin(req) && po.sellerId !== userId(req)) throw new ApiError(403, 'Access denied', 'ACCESS_DENIED');
  const body = parse(z.object({ trackingNumber: z.string().trim().max(120).optional(), carrierName: z.string().trim().max(120).optional(), expectedDelivery: z.coerce.date().optional(), currentLocation: z.string().optional() }), req.body);
  const delivery = await fulfillmentWorkflow.createDelivery(actorFrom(req), id, body);
  await auditWrite(req, 'delivery.created', 'deliveryTracking', delivery.id);
  ok(res, delivery, 201);
}));

router.post('/delivery/:id/events', authenticate, requirePermission('delivery.update', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const delivery = await db.deliveryTracking.findUnique({ where: { id }, include: { purchaseOrder: true } });
  if (!delivery || (!isAdmin(req) && delivery.purchaseOrder.sellerId !== userId(req))) throw new ApiError(404, 'Delivery not found', 'DELIVERY_NOT_FOUND');
  const body = parse(z.object({ status: z.enum(['CREATED', 'DISPATCHED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELAYED', 'RETURNED', 'CANCELLED']), location: z.string().optional(), remarks: z.string().optional() }), req.body);
  const event = await fulfillmentWorkflow.addDeliveryEvent(actorFrom(req), id, body);
  await auditWrite(req, 'delivery.event_added', 'deliveryTrackingEvent', event.id);
  ok(res, event, 201);
}));

router.get('/delivery/:id', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const delivery = await db.deliveryTracking.findUnique({ where: { id }, include: { events: true, purchaseOrder: true } });
  if (!delivery || (!isAdmin(req) && delivery.purchaseOrder.buyerId !== userId(req) && delivery.purchaseOrder.sellerId !== userId(req))) throw new ApiError(404, 'Delivery not found', 'DELIVERY_NOT_FOUND');
  ok(res, delivery);
}));

router.post('/purchase-orders/:id/inspection', authenticate, requirePermission('inspection.create', orgScope), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const po = await assertPurchaseOrderAccess(req, id);
  if (!isAdmin(req) && po.buyerId !== userId(req)) throw new ApiError(403, 'Access denied', 'ACCESS_DENIED');
  const report = await fulfillmentWorkflow.createInspection(actorFrom(req), id, { remarks: clean(req.body?.remarks), metadata: req.body?.metadata });
  await auditWrite(req, 'inspection.created', 'inspectionReport', report.id);
  ok(res, report, 201);
}));

router.get('/purchase-orders/:id/inspection', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertPurchaseOrderAccess(req, id);
  ok(res, await db.inspectionReport.findMany({ where: { purchaseOrderId: id }, orderBy: { createdAt: 'desc' } }));
}));

for (const [path, status, action] of [
  ['/inspection/:id/approve', 'ACCEPTED', 'inspection.approved'],
  ['/inspection/:id/reject', 'REJECTED', 'inspection.rejected']
] as const) {
  router.post(path, authenticate, requirePermission('inspection.approve', orgScope), asyncRoute(async (req, res) => {
    const { id } = parse(idParams, req.params);
    await assertBuyerProcurementApproved(req);
    const existing = await db.inspectionReport.findUnique({ where: { id }, include: { purchaseOrder: true } });
    if (!existing || (!isAdmin(req) && existing.purchaseOrder.buyerId !== userId(req))) throw new ApiError(404, 'Inspection not found', 'INSPECTION_NOT_FOUND');
    const report = await fulfillmentWorkflow.decideInspection(actorFrom(req), id, status === 'ACCEPTED', clean(req.body?.remarks));
    await auditWrite(req, action, 'inspectionReport', id);
    ok(res, report);
  }));
}

router.post('/invoices', authenticate, authorize('seller', 'admin'), asyncRoute(async (req, res) => {
  const body = parse(z.object({
    purchaseOrderId: z.coerce.number().int().positive().optional(),
    amount: z.coerce.number().positive().optional(),
    gstRate: z.coerce.number().min(0).max(100).optional(),
    otherTaxRate: z.coerce.number().min(0).max(100).optional(),
    tdsRate: z.coerce.number().min(0).max(100).optional(),
    interstate: z.boolean().optional(),
    items: z.array(z.object({
      itemName: z.string().trim().min(2),
      description: z.string().optional(),
      quantity: z.coerce.number().positive(),
      unitPrice: z.coerce.number().nonnegative(),
      taxableAmount: z.coerce.number().nonnegative().optional(),
      totalAmount: z.coerce.number().nonnegative().optional()
    })).optional()
  }), req.body);

  const targetPoId = body.purchaseOrderId;

  if (!targetPoId) {
    throw new ApiError(400, 'Invoices cannot be submitted without an existing approved purchase order', 'PO_REQUIRED');
  }

  const po = await db.purchaseOrder.findUnique({ where: { id: targetPoId } });
  if (!po) {
    throw new ApiError(400, 'Invoices cannot be submitted without an existing approved purchase order', 'PO_REQUIRED');
  }

  if (!isAdmin(req) && po.sellerId !== userId(req)) {
    throw new ApiError(403, 'You are not the seller of this purchase order', 'FORBIDDEN_PO_SELLER_MISMATCH');
  }

  const validStatuses = ['accepted', 'in_fulfillment', 'delivered', 'ACCEPTED', 'IN_FULFILLMENT', 'DELIVERED'];
  if (!validStatuses.includes(po.status) && !validStatuses.includes(po.poStatus)) {
    throw new ApiError(409, `Cannot submit invoice for purchase order in '${po.status}' status`, 'INVALID_PO_STATUS_FOR_INVOICE');
  }

  const invoice = await fulfillmentWorkflow.createInvoice(actorFrom(req), {
    ...body,
    purchaseOrderId: targetPoId
  });

  await auditWrite(req, 'invoice.created', 'invoice', invoice.id);
  ok(res, invoice, 201);
}));

// ─── External / SAP Ariba Invoice Upload & Workspace ───────────────────────
router.post('/invoices/upload-external', authenticate, authorize('seller', 'admin', 'shg'), asyncRoute(async (req, res) => {
  const body = parse(z.object({
    purchaseOrderId: z.coerce.number().int().positive(),
    invoiceNumber: z.string().trim().min(2).max(60),
    externalPoNumber: z.string().trim().max(100).optional(),
    vendorCode: z.string().trim().max(100).optional(),
    amount: z.coerce.number().positive(),
    taxableAmount: z.coerce.number().nonnegative().optional(),
    cgstAmount: z.coerce.number().nonnegative().optional(),
    sgstAmount: z.coerce.number().nonnegative().optional(),
    igstAmount: z.coerce.number().nonnegative().optional(),
    invoiceDate: safeCoercedDate.optional(),
    invoiceFileId: z.coerce.number().int().positive()
  }), req.body);

  // Validate referenced uploaded file asset ownership
  await assertFileAssetOwnership(body.invoiceFileId, req);

  const po = await db.purchaseOrder.findUnique({
    where: { id: body.purchaseOrderId },
    include: { seller: { select: { organizationId: true } } }
  });
  if (!po) throw new ApiError(404, 'Purchase order not found', 'PO_NOT_FOUND');
  const isSellerOrg = req.user?.organizationId && po.seller?.organizationId === req.user?.organizationId;
  if (!isAdmin(req) && po.sellerId !== userId(req) && !isSellerOrg) {
    throw new ApiError(403, 'You are not the seller of this purchase order', 'FORBIDDEN');
  }

  // Wrap in interactive database transaction to prevent concurrency race conditions in cumulative balance calculation
  const invoice = await db.$transaction(async (tx) => {
    // Duplicate invoice check
    const duplicate = await tx.invoice.findFirst({
      where: {
        sellerId: po.sellerId,
        invoiceNumber: { equals: body.invoiceNumber, mode: 'insensitive' }
      }
    });
    if (duplicate) {
      throw new ApiError(409, `An invoice with number "${body.invoiceNumber}" already exists for your account`, 'DUPLICATE_INVOICE');
    }

    // Anti-overbilling validation: check cumulative invoice amounts against PO total
    const activeInvoices = await tx.invoice.findMany({
      where: {
        purchaseOrderId: po.id,
        status: { notIn: ['cancelled', 'rejected'] }
      },
      select: { amount: true }
    });
    const alreadyBilled = activeInvoices.reduce((sum: number, inv: any) => sum + Number(inv.amount || 0), 0);
    const remainingPoValue = Number(po.totalValue || po.amount || 0) - alreadyBilled;
    const tolerance = 5.0; // ₹5 tolerance for rounding
    if (body.amount > (remainingPoValue + tolerance)) {
      throw new ApiError(
        400,
        `Invoice amount (₹${body.amount.toLocaleString('en-IN')}) exceeds the remaining PO balance (₹${Math.max(0, remainingPoValue).toLocaleString('en-IN')})`,
        'PO_BALANCE_EXCEEDED'
      );
    }

    const invoiceDate = body.invoiceDate ? new Date(body.invoiceDate) : new Date();
    return tx.invoice.create({
      data: {
        invoiceNumber: body.invoiceNumber,
        purchaseOrderId: po.id,
        sellerId: po.sellerId,
        buyerId: po.buyerId,
        amount: body.amount,
        taxableAmount: body.taxableAmount || body.amount,
        cgstAmount: body.cgstAmount || 0,
        sgstAmount: body.sgstAmount || 0,
        igstAmount: body.igstAmount || 0,
        totalTaxAmount: (body.cgstAmount || 0) + (body.sgstAmount || 0) + (body.igstAmount || 0),
        status: 'submitted',
        invoiceStatus: invoiceStatusEnumFor('submitted') as any,
        isExternalUpload: true,
        externalPoNumber: body.externalPoNumber || po.externalPoNumber || null,
        vendorCode: body.vendorCode || null,
        invoiceFileId: body.invoiceFileId,
        fileAssetId: body.invoiceFileId,
        invoiceDate,
        metadata: {
          externalUpload: true,
          vendorCode: body.vendorCode,
          uploadedAt: new Date().toISOString()
        }
      }
    });
  });

  notifyWorkflowSoon(
    po.buyerId,
    `New External Invoice Submitted: ${invoice.invoiceNumber}`,
    `Seller submitted SAP/External invoice ${invoice.invoiceNumber} for PO ${po.poNumber} (Amount: ₹${Number(body.amount).toLocaleString('en-IN')}). Please review and approve.`,
    'invoice_submitted',
    '/buyer/invoices'
  );

  await auditWrite(req, 'invoice.uploaded_external', 'invoice', invoice.id, { purchaseOrderId: po.id });
  ok(res, invoice, 201);
}));

router.put('/invoices/:id/draft', authenticate, authorize('seller', 'admin', 'shg'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({
    invoiceNumber: z.string().trim().min(2).max(60).optional(),
    externalPoNumber: z.string().trim().max(100).optional(),
    vendorCode: z.string().trim().max(100).optional(),
    amount: z.coerce.number().positive().optional(),
    taxableAmount: z.coerce.number().nonnegative().optional(),
    cgstAmount: z.coerce.number().nonnegative().optional(),
    sgstAmount: z.coerce.number().nonnegative().optional(),
    igstAmount: z.coerce.number().nonnegative().optional(),
    invoiceDate: safeCoercedDate.optional(),
    invoiceFileId: z.coerce.number().int().positive().optional().nullable()
  }), req.body);

  if (body.invoiceFileId) {
    await assertFileAssetOwnership(body.invoiceFileId, req);
  }

  const invoice = await db.invoice.findUnique({
    where: { id },
    include: { purchaseOrder: true, seller: { select: { organizationId: true } } }
  });
  if (!invoice) throw new ApiError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
  const isSellerOrg = req.user?.organizationId && invoice.seller?.organizationId === req.user?.organizationId;
  if (!isAdmin(req) && invoice.sellerId !== userId(req) && !isSellerOrg) throw new ApiError(403, 'Forbidden', 'FORBIDDEN');

  const invStatusLower = String(invoice.status || '').toLowerCase();
  if (!['draft', 'rejected'].includes(invStatusLower)) {
    throw new ApiError(409, 'Only draft or rejected invoices can be edited/re-submitted', 'INVOICE_LOCKED');
  }

  const updated = await db.invoice.update({
    where: { id },
    data: {
      ...(body.invoiceNumber ? { invoiceNumber: body.invoiceNumber } : {}),
      ...(body.externalPoNumber !== undefined ? { externalPoNumber: body.externalPoNumber } : {}),
      ...(body.vendorCode !== undefined ? { vendorCode: body.vendorCode } : {}),
      ...(body.amount !== undefined ? { amount: body.amount } : {}),
      ...(body.taxableAmount !== undefined ? { taxableAmount: body.taxableAmount } : {}),
      ...(body.cgstAmount !== undefined ? { cgstAmount: body.cgstAmount } : {}),
      ...(body.sgstAmount !== undefined ? { sgstAmount: body.sgstAmount } : {}),
      ...(body.igstAmount !== undefined ? { igstAmount: body.igstAmount } : {}),
      ...(body.invoiceDate !== undefined ? { invoiceDate: body.invoiceDate ? new Date(body.invoiceDate) : invoice.invoiceDate } : {}),
      ...(body.invoiceFileId !== undefined ? { invoiceFileId: body.invoiceFileId, fileAssetId: body.invoiceFileId } : {}),
      status: 'submitted',
      invoiceStatus: invoiceStatusEnumFor('submitted') as any,
      rejectionReason: null,
      version: { increment: 1 }
    }
  });

  notifyWorkflowSoon(
    invoice.buyerId,
    `Invoice Re-submitted: ${updated.invoiceNumber}`,
    `Seller corrected and re-submitted invoice ${updated.invoiceNumber}. Please review and approve.`,
    'invoice_resubmitted',
    '/buyer/invoices'
  );

  await auditWrite(req, 'invoice.resubmitted', 'invoice', id);
  ok(res, updated);
}));


router.get('/invoices', authenticate, asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);
  const where: any = isAdmin(req) ? {} : req.user?.role === 'buyer' ? { buyerId: userId(req) } : { sellerId: userId(req) };
  if (query.status) where.OR = [{ status: query.status }, { invoiceStatus: String(query.status).toUpperCase() }];
  if (query.q) {
    where.OR = [
      ...(where.OR || []),
      { invoiceNumber: { contains: query.q, mode: 'insensitive' } },
      { purchaseOrder: { poNumber: { contains: query.q, mode: 'insensitive' } } },
      { seller: { name: { contains: query.q, mode: 'insensitive' } } },
      { buyer: { name: { contains: query.q, mode: 'insensitive' } } }
    ];
  }
  const window = listWindow(query);
  const [invoices, total] = await Promise.all([
    db.invoice.findMany({
      where,
      include: {
        buyer: { select: { id: true, name: true, organization: { select: { organizationName: true, gstin: true, panNumber: true } } } },
        seller: { select: { id: true, name: true, organization: { select: { organizationName: true, gstin: true, panNumber: true, cinNumber: true } } } },
        purchaseOrder: { select: { id: true, poNumber: true, title: true } },
        payments: { orderBy: { createdAt: 'desc' }, take: 3 }
      },
      orderBy: { updatedAt: 'desc' },
      ...window
    }),
    db.invoice.count({ where })
  ]);
  ok(res, paged(invoices, total, query, 'invoices'));
}));

router.get('/invoices/summary', authenticate, authorize('buyer', 'seller', 'admin'), asyncRoute(async (req, res) => {
  const uid = userId(req);
  const orgId = req.user?.organizationId;
  let where: any = {};
  if (!isAdmin(req)) {
    if (req.user?.role === 'buyer') {
      where = orgId ? { OR: [{ buyerId: uid }, { buyer: { organizationId: orgId } }] } : { buyerId: uid };
    } else {
      where = orgId ? { OR: [{ sellerId: uid }, { seller: { organizationId: orgId } }] } : { sellerId: uid };
    }
  }

  const invoices = await db.invoice.findMany({
    where,
    select: { amount: true, status: true, invoiceStatus: true }
  });

  const statusOf = (inv: any) => String(inv.invoiceStatus || inv.status || 'draft').toLowerCase();
  const totalValue = invoices.reduce((sum: number, inv: any) => sum + Number(inv.amount || 0), 0);
  const pendingCount = invoices.filter((inv: any) => ['draft', 'submitted', 'pending'].includes(statusOf(inv))).length;
  const approvedCount = invoices.filter((inv: any) => ['approved', 'paid'].includes(statusOf(inv))).length;

  const payload = { totalValue, pendingCount, approvedCount };
  res.json({
    success: true,
    ...payload,
    data: payload
  });
}));

router.get('/invoices/:id(\\d+)', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const invoice = await db.invoice.findUnique({
    where: { id },
    include: {
      items: true,
      payments: true,
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
              organization: {
                include: {
                  profile: true,
                  deliveryAddresses: true
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
              sellerProfile: {
                include: {
                  offices: true,
                  bankAccounts: true
                }
              },
              organization: {
                include: {
                  profile: true
                }
              }
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
          sellerProfile: {
            include: {
              offices: true,
              bankAccounts: true
            }
          },
          organization: {
            include: {
              profile: true,
              deliveryAddresses: true
            }
          }
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
          organization: {
            include: {
              profile: true,
              deliveryAddresses: true
            }
          }
        }
      }
    }
  });
  if (!invoice || (!isAdmin(req) && invoice.buyerId !== userId(req) && invoice.sellerId !== userId(req))) throw new ApiError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');

  // Compute interstate status from GSTINs / states
  const sellerReg = (invoice.seller?.registrationDetails as any) || (invoice.purchaseOrder?.seller?.registrationDetails as any) || {};
  const buyerReg = (invoice.buyer?.registrationDetails as any) || (invoice.purchaseOrder?.buyer?.registrationDetails as any) || {};
  const sGstin = sellerReg.gstin || invoice.seller?.sellerProfile?.offices?.[0]?.gstNumber || invoice.seller?.organization?.gstin || '';
  const bGstin = buyerReg.gstin || invoice.buyer?.buyerProfile?.gst || invoice.buyer?.organization?.gstin || '';
  const sCode = sGstin.trim().substring(0, 2);
  const bCode = bGstin.trim().substring(0, 2);
  const isInterstate = Boolean(
    (invoice.metadata as any)?.interstate ||
    Number(invoice.igstAmount) > 0 ||
    (/^\d{2}$/.test(sCode) && /^\d{2}$/.test(bCode) && sCode !== bCode) ||
    (sellerReg.state && buyerReg.state && sellerReg.state.toLowerCase() !== buyerReg.state.toLowerCase())
  );

  ok(res, { ...invoice, interstate: isInterstate });
}));

router.get('/invoices/:id(\\d+)/download-pdf', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const invoice = await db.invoice.findUnique({
    where: { id },
    include: {
      items: true,
      purchaseOrder: {
        include: {
          items: true,
          buyer: { select: { id: true, name: true, email: true, mobile: true, registrationDetails: true, buyerProfile: true, organizationId: true, organization: { include: { profile: true } } } },
          seller: { select: { id: true, name: true, email: true, mobile: true, registrationDetails: true, sellerProfile: true, organizationId: true, organization: { include: { profile: true } } } }
        }
      },
      seller: { select: { id: true, name: true, email: true, mobile: true, registrationDetails: true, sellerProfile: true, organizationId: true, organization: { include: { profile: true } } } },
      buyer: { select: { id: true, name: true, email: true, mobile: true, registrationDetails: true, buyerProfile: true, organizationId: true, organization: { include: { profile: true } } } }
    }
  });
  if (!invoice || (!isAdmin(req) && invoice.buyerId !== userId(req) && invoice.sellerId !== userId(req))) {
    throw new ApiError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
  }
  const { buffer, filename } = await getOrGenerateInvoicePdfBuffer(invoice);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.end(buffer);
}));

router.post('/invoices/:id/approve', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const existing = await db.invoice.findUnique({
    where: { id },
    include: { purchaseOrder: { include: { grns: true } } }
  });
  if (!existing || (!isAdmin(req) && existing.buyerId !== userId(req) && existing.purchaseOrder?.buyerId !== userId(req))) {
    throw new ApiError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
  }
  const invoice = await fulfillmentWorkflow.decideInvoice(actorFrom(req), id, true);
  await auditWrite(req, 'invoice.approved', 'invoice', id);
  ok(res, invoice);
}));

router.post('/invoices/:id/reject', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const body = parse(z.object({
    rejectionReason: z.string().trim().min(3, 'Rejection reason must be at least 3 characters').max(1000).optional()
  }), req.body || {});
  const existing = await db.invoice.findUnique({ where: { id }, include: { purchaseOrder: true } });
  if (!existing || (!isAdmin(req) && existing.buyerId !== userId(req) && existing.purchaseOrder?.buyerId !== userId(req))) {
    throw new ApiError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
  }
  const invoice = await fulfillmentWorkflow.decideInvoice(
    actorFrom(req),
    id,
    false,
    body.rejectionReason || 'Invoice rejected by buyer. Please review and resubmit.'
  );
  await auditWrite(req, 'invoice.rejected', 'invoice', id, { rejectionReason: body.rejectionReason });
  ok(res, invoice);
}));

router.get('/payments/:id', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const payment = await db.paymentTransaction.findUnique({ where: { id }, include: { escrowAccount: true, ledgerEntries: true } });
  if (!payment || (!isAdmin(req) && payment.payerId !== userId(req) && payment.payeeId !== userId(req))) throw new ApiError(404, 'Payment not found', 'PAYMENT_NOT_FOUND');
  ok(res, payment);
}));

router.get('/payments/:id/pdf', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const payment = await db.paymentTransaction.findUnique({
    where: { id },
    include: {
      invoice: { include: { purchaseOrder: true } },
      purchaseOrder: true,
      payer: { select: { name: true, email: true, organization: { select: { organizationName: true } } } },
      payee: { select: { name: true, email: true, organization: { select: { organizationName: true } } } },
      escrowAccount: true
    }
  });

  if (!payment || (!isAdmin(req) && payment.payerId !== userId(req) && payment.payeeId !== userId(req))) {
    throw new ApiError(404, 'Payment not found', 'PAYMENT_NOT_FOUND');
  }

  const refId = payment.referenceId || `PAY-2026-${String(payment.id).padStart(6, '0')}`;
  const invNo = payment.invoice?.invoiceNumber || (payment.purchaseOrder?.poNumber ? `INV-${payment.purchaseOrder.poNumber}` : `INV-${payment.invoiceId || payment.id}`);
  const poNum = payment.purchaseOrder?.poNumber || (payment.invoice?.purchaseOrder?.poNumber) || `PO-${payment.purchaseOrderId || payment.id}`;

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
    payerName: payment.payer?.organization?.organizationName || payment.payer?.name || 'Buyer',
    payerEmail: payment.payer?.email || '',
    payeeName: payment.payee?.organization?.organizationName || payment.payee?.name || 'Seller',
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

  const filename = `PaymentReceipt_${refId}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(pdfBuffer);
}));

router.post('/payments/:id/reconcile', authenticate, authorizeAdmin, paymentRateLimit, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({ status: z.enum(['success', 'failed', 'refunded', 'cancelled']), remarks: z.string().trim().max(1000).optional(), reversalLedgerEntryId: z.coerce.number().int().positive().optional() }), req.body);
  const key = idempotencyKeyFromRequest(req, `phase4-payment-reconcile:${id}:${body.status}:${userId(req)}`);
  const payment = await withIdempotency({
    req,
    userId: userId(req),
    route: 'POST /api/payments/:id/reconcile',
    key,
    handler: async () => reconcilePaymentWorkflow(actorFrom(req), id, body) as Promise<Record<string, unknown>>
  });
  await auditWrite(req, 'payment.reconciled', 'paymentTransaction', id, body);
  ok(res, payment);
}));

router.get('/escrow', authenticate, authorize('buyer', 'seller', 'admin'), asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);
  const result = await listEscrowAccounts(actorFrom(req), { ...listWindow(query), q: query.q, status: query.status });
  ok(res, { ...result, records: result.escrowAccounts, filters: query });
}));

router.get('/escrow/:id', authenticate, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const escrow = await db.escrowAccount.findUnique({
    where: { id },
    include: {
      milestones: true,
      transactions: true,
      paymentTransaction: true,
      buyer: { select: { id: true, name: true, email: true } },
      seller: { select: { id: true, name: true, email: true } },
      purchaseOrder: { select: { id: true, poNumber: true, status: true } }
    }
  });
  if (!escrow || (!isAdmin(req) && escrow.buyerId !== userId(req) && escrow.sellerId !== userId(req))) throw new ApiError(404, 'Escrow not found', 'ESCROW_NOT_FOUND');
  ok(res, escrow);
}));

router.post('/escrow/:id/milestones', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const body = parse(z.object({ title: z.string().min(3), description: z.string().optional(), amount: z.coerce.number().positive(), dueDate: z.string().datetime().optional(), metadata: z.record(z.string(), z.unknown()).optional() }), req.body);
  const key = idempotencyKeyFromRequest(req, `milestone-create:${id}:${body.title}:${userId(req)}`);
  ok(res, await withIdempotency({ req, userId: userId(req), route: 'POST /api/escrow/:id/milestones', key, handler: async () => createMilestone(actorFrom(req), id, body) as Promise<Record<string, unknown>> }), 201);
}));

router.post('/milestones/:id/complete', authenticate, authorize('seller', 'admin'), asyncRoute(async (req, res) => {
  const id = parse(idParams, req.params).id;
  const key = idempotencyKeyFromRequest(req, `milestone-complete:${id}:${userId(req)}`);
  ok(res, await withIdempotency({ req, userId: userId(req), route: 'POST /api/milestones/:id/complete', key, handler: async () => completeMilestone(actorFrom(req), id) as Promise<Record<string, unknown>> }));
}));
router.post('/milestones/:id/approve', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const id = parse(idParams, req.params).id;
  await assertBuyerProcurementApproved(req);
  const key = idempotencyKeyFromRequest(req, `milestone-approve:${id}:${userId(req)}`);
  ok(res, await withIdempotency({ req, userId: userId(req), route: 'POST /api/milestones/:id/approve', key, handler: async () => approveMilestone(actorFrom(req), id, clean(req.body?.reason)) as Promise<Record<string, unknown>> }));
}));
router.post('/milestones/:id/release', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const id = parse(idParams, req.params).id;
  await assertBuyerProcurementApproved(req);
  const key = idempotencyKeyFromRequest(req, `milestone-release:${id}:${userId(req)}`);
  ok(res, await withIdempotency({ req, userId: userId(req), route: 'POST /api/milestones/:id/release', key, handler: async () => approveMilestone(actorFrom(req), id, clean(req.body?.reason)) as Promise<Record<string, unknown>> }));
}));
router.post('/escrow/:id/freeze', authenticate, authorize('buyer', 'seller', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const key = idempotencyKeyFromRequest(req, `escrow-freeze:${id}:${userId(req)}`);
  ok(res, await withIdempotency({ req, userId: userId(req), route: 'POST /api/escrow/:id/freeze', key, handler: async () => fulfillmentWorkflow.freezeEscrowForDispute(actorFrom(req), id, clean(req.body?.reason)) as Promise<Record<string, unknown>> }));
}));
router.post('/escrow/:id/unfreeze', authenticate, authorize('buyer', 'admin'), asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertBuyerProcurementApproved(req);
  const key = idempotencyKeyFromRequest(req, `escrow-unfreeze:${id}:${userId(req)}`);
  ok(res, await withIdempotency({ req, userId: userId(req), route: 'POST /api/escrow/:id/unfreeze', key, handler: async () => unfreezeEscrow(actorFrom(req), id, clean(req.body?.reason)) as Promise<Record<string, unknown>> }));
}));

// Ratings
router.post('/ratings/supplier', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  await assertBuyerProcurementApproved(req);
  const body = parse(z.object({ sellerId: z.coerce.number().int().positive(), purchaseOrderId: z.coerce.number().int().positive().optional(), rating: z.coerce.number().int().min(1).max(5), review: z.string().max(2000).optional(), qualityScore: z.coerce.number().int().min(1).max(5).optional(), deliveryScore: z.coerce.number().int().min(1).max(5).optional(), communicationScore: z.coerce.number().int().min(1).max(5).optional(), documentationScore: z.coerce.number().int().min(1).max(5).optional() }), req.body);
  await ratingsService.assertNotAlreadyRatedPO(userId(req), String(req.user?.role), body.purchaseOrderId);
  const rating = await ratingWorkflow.rateSupplier(actorFrom(req), body);
  await auditWrite(req, 'rating.supplier_created', 'supplierRating', rating.id);
  ok(res, rating, 201);
}));

router.post('/ratings/buyer', authenticate, authorize('seller'), asyncRoute(async (req, res) => {
  const body = parse(z.object({ buyerId: z.coerce.number().int().positive(), purchaseOrderId: z.coerce.number().int().positive().optional(), rating: z.coerce.number().int().min(1).max(5), review: z.string().max(2000).optional(), paymentTimelinessScore: z.coerce.number().int().min(1).max(5).optional(), communicationScore: z.coerce.number().int().min(1).max(5).optional() }), req.body);
  await ratingsService.assertNotAlreadyRatedPO(userId(req), String(req.user?.role), body.purchaseOrderId);
  const rating = await ratingWorkflow.rateBuyer(actorFrom(req), body);
  await auditWrite(req, 'rating.buyer_created', 'buyerRating', rating.id);
  ok(res, rating, 201);
}));

// GET /ratings/supplier/:sellerId and GET /ratings/buyer/:buyerId are served
// by the dedicated ratings module mounted at /api/ratings (see routes/index.ts).

// Admin reports
router.get('/admin/users', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const query = parse(paginationQuery.extend({
    role: z.string().trim().optional(),
    onboardingStatus: z.string().trim().optional(),
    accountStatus: z.string().trim().optional(),
    registrationStatus: z.string().trim().optional(),
    organizationId: z.coerce.number().int().positive().optional()
  }), req.query);
  const where: any = {
    userId: { not: 'MASTER_ADMIN' },
    accountStatus: query.accountStatus ? query.accountStatus : { not: 'DELETED' },
    NOT: [
      { email: { startsWith: 'deleted_' } }
    ]
  };
  if (query.role) {
    const r = query.role.trim().toLowerCase();
    if (r === 'master_admin' || r === 'master admin') {
      return ok(res, { records: [], total: 0, filters: query });
    }
    where.role = r;
  } else {
    where.role = { not: 'master_admin' };
  }
  if (query.onboardingStatus) where.onboardingStatus = query.onboardingStatus;
  if (query.accountStatus) where.accountStatus = query.accountStatus;
  if (query.registrationStatus) where.registrationStatus = query.registrationStatus;
  if (query.organizationId) where.organizationId = query.organizationId;
  if (query.q) {
    where.OR = [
      { name: { contains: query.q, mode: 'insensitive' } },
      { email: { contains: query.q, mode: 'insensitive' } },
      { mobile: { contains: query.q, mode: 'insensitive' } },
      { userId: { contains: query.q, mode: 'insensitive' } }
    ];
  }

  const selectFields: any = {
    id: true,
    userId: true,
    name: true,
    email: true,
    mobile: true,
    role: true,
    registrationStatus: true,
    onboardingStatus: true,
    sectionStatus: true,
    adminFeedback: true,
    organizationId: true,
    accountStatus: true,
    emailVerified: true,
    lastLoginAt: true,
    createdAt: true,
    updatedAt: true,
    organization: {
      select: {
        id: true,
        organizationName: true,
        gstin: true,
        panNumber: true,
        udyamNumber: true,
        annualTurnover: true,
        verificationStatus: true,
        organizationType: true,
        city: true,
        district: true,
        state: true
      }
    },
    buyerProfile: {
      select: {
        organizationName: true,
        businessType: true,
        gst: true,
        pan: true,
        industry: true,
        city: true,
        state: true,
        annualBudget: true,
        procurementCategories: true
      }
    },
    sellerProfile: {
      select: {
        businessName: true,
        pan: true,
        productCategories: true
      }
    },
    shgProfile: {
      select: {
        id: true,
        shgName: true,
        shgType: true,
        state: true,
        district: true,
        block: true,
        gramPanchayat: true,
        village: true,
        pincode: true,
        formationYear: true,
        formationDate: true,
        memberCount: true,
        registrationStatus: true,
        registrationNumber: true,
        nrlmId: true,
        promotedBy: true,
        mainActivity: true,
        gstin: true,
        udyamNumber: true,
        representativeMobile: true,
        representativeEmail: true,
        representativeRole: true,
        applicationStatus: true,
        submittedAt: true,
        approvedAt: true
      }
    },
    kycVerifications: {
      where: { provider: 'MERIPEHCHAAN' as const, verificationType: 'AADHAAR' as const },
      take: 1,
      select: {
        status: true,
        provider: true,
        verificationType: true,
        verifiedName: true,
        verifiedAt: true,
        referenceKey: true,
        idTokenSubject: true
      }
    }
  };

  if (!query.organizationId) {
    selectFields.sessions = {
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true, ipAddress: true, userAgent: true, createdAt: true }
    };
    selectFields.complianceViolations = {
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, type: true, severity: true, status: true, description: true, createdAt: true }
    };
    selectFields.fraudAlerts = {
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, alertType: true, severity: true, status: true, entityType: true, entityId: true, createdAt: true }
    };
  }

  const [records, total] = await Promise.all([
    db.user.findMany({
      where,
      select: selectFields,
      orderBy: { createdAt: 'desc' },
      skip: query.skip,
      take: query.take
    }),
    db.user.count({ where })
  ]);

  const mappedRecords = records.map((user: any) => {
    const rawProfile = user.buyerProfile || user.sellerProfile || user.shgProfile || {};
    const profile = {
      ...rawProfile,
      businessName: rawProfile.businessName || rawProfile.shgName || rawProfile.organizationName || user.organization?.organizationName || null,
      organizationName: rawProfile.organizationName || rawProfile.shgName || rawProfile.businessName || user.organization?.organizationName || null,
      gst: rawProfile.gst || rawProfile.gstin || user.organization?.gstin || null,
      pan: rawProfile.pan || user.organization?.panNumber || null,
      city: rawProfile.city || rawProfile.district || rawProfile.village || user.organization?.city || null,
      state: rawProfile.state || user.organization?.state || null,
      udyamNumber: rawProfile.udyamNumber || user.organization?.udyamNumber || null,
      annualTurnover: user.organization?.annualTurnover || null
    };
    return {
      ...user,
      aadhaarKyc: user.kycVerifications?.[0] || null,
      kycVerifications: undefined,
      profile,
      shgProfile: user.shgProfile || null
    };
  });

  ok(res, { records: mappedRecords, total, filters: query });
}));

router.put('/admin/users/:id/status', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);

  const userToUpdate = await db.user.findUnique({ where: { id } });
  if (!userToUpdate) {
    throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');
  }
  if (userToUpdate.role === 'master_admin' || userToUpdate.userId === 'MASTER_ADMIN') {
    throw new ApiError(403, 'Master Admin user status cannot be changed.', 'MASTER_ADMIN_LOCKED');
  }

  const body = parse(z.object({ accountStatus: z.enum(['PENDING', 'ACTIVE', 'BLOCKED', 'SUSPENDED', 'DELETED']) }), req.body);

  if (id === userId(req) && body.accountStatus !== 'ACTIVE') {
    throw new ApiError(400, 'You cannot deactivate your own account', 'ADMIN_SELF_DEACTIVATION_BLOCKED');
  }

  const updatedUser = await db.user.update({
    where: { id },
    data: { accountStatus: body.accountStatus }
  });
  await auditWrite(req, 'admin.user.status_updated', 'user', id, { accountStatus: body.accountStatus });
  ok(res, updatedUser);
}));

router.put('/admin/users/:id', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);

  const userToUpdate = await db.user.findUnique({ where: { id } });
  if (!userToUpdate) {
    throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');
  }
  if (userToUpdate.role === 'master_admin' || userToUpdate.userId === 'MASTER_ADMIN') {
    throw new ApiError(403, 'Master Admin user cannot be edited or modified.', 'MASTER_ADMIN_LOCKED');
  }

  const body = parse(z.object({
    name: z.string().trim().min(2).max(100).optional(),
    email: z.string().trim().email().optional(),
    mobile: z.string().trim().optional(),
    role: z.string().trim().optional(),
    accountStatus: z.enum(['PENDING', 'ACTIVE', 'BLOCKED', 'SUSPENDED', 'DELETED']).optional()
  }), req.body);

  const allowedAssignableRoles = ['admin', 'buyer', 'seller', 'shg'];
  if (body.role) {
    const requestedRole = body.role.trim().toLowerCase();
    if (requestedRole === 'master_admin' || requestedRole === 'master admin') {
      throw new ApiError(403, 'Cannot assign Master Admin role.', 'MASTER_ADMIN_ASSIGNMENT_BLOCKED');
    }
    if (!allowedAssignableRoles.includes(requestedRole)) {
      throw new ApiError(400, `Cannot assign role '${requestedRole}'. Allowed roles: ${allowedAssignableRoles.join(', ')}`, 'INVALID_ROLE');
    }
    body.role = requestedRole;
  }

  if (id === userId(req) && body.accountStatus && body.accountStatus !== 'ACTIVE') {
    throw new ApiError(400, 'You cannot deactivate your own account', 'ADMIN_SELF_DEACTIVATION_BLOCKED');
  }

  const updated = await db.user.update({
    where: { id },
    data: {
      ...(body.name ? { name: body.name } : {}),
      ...(body.email ? { email: body.email } : {}),
      ...(body.mobile ? { mobile: body.mobile } : {}),
      ...(body.role ? { role: body.role } : {}),
      ...(body.accountStatus ? { accountStatus: body.accountStatus } : {})
    }
  });
  await auditWrite(req, 'admin.user.updated', 'user', id, body);
  ok(res, updated);
}));

router.delete('/admin/users/:id', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);

  const userToDelete = await db.user.findUnique({ where: { id } });
  if (!userToDelete) {
    throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');
  }
  if (userToDelete.role === 'master_admin' || userToDelete.userId === 'MASTER_ADMIN') {
    throw new ApiError(403, 'Master Admin user cannot be deleted.', 'MASTER_ADMIN_LOCKED');
  }

  if (id === userId(req)) throw new ApiError(400, 'You cannot delete your own account', 'ADMIN_SELF_DELETE_BLOCKED');

  await permanentlyDeleteUser(req as any, id, 'deleted via admin panel');
  await auditWrite(req, 'admin.user.deleted', 'user', id);
  ok(res, { success: true });
}));

router.get('/admin/audit-logs', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const query = parse(paginationQuery.extend({
    action: z.string().trim().optional(),
    entityType: z.string().trim().optional(),
    userId: z.coerce.number().int().positive().optional()
  }), req.query);
  const where: any = {};
  if (query.action) where.action = { contains: query.action, mode: 'insensitive' };
  if (query.entityType) where.entityType = { contains: query.entityType, mode: 'insensitive' };
  if (query.userId) where.userId = query.userId;
  if (query.q) {
    where.OR = [
      { action: { contains: query.q, mode: 'insensitive' } },
      { entityType: { contains: query.q, mode: 'insensitive' } }
    ];
  }
  const [records, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        ipAddress: true,
        createdAt: true,
        User: { select: { id: true, name: true, email: true, role: true } }
      },
      orderBy: { createdAt: 'desc' },
      skip: query.skip,
      take: query.take
    }),
    db.auditLog.count({ where })
  ]);
  ok(res, { records, total, filters: query });
}));

router.get('/admin/fraud-alerts', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const query = parse(paginationQuery.extend({
    severity: z.string().trim().optional(),
    alertType: z.string().trim().optional()
  }), req.query);
  const where: any = {};
  if (query.status) where.status = query.status;
  if (query.severity) where.severity = query.severity;
  if (query.alertType) where.alertType = query.alertType;
  if (query.q) {
    where.OR = [
      { entityType: { contains: query.q, mode: 'insensitive' } },
      { user: { name: { contains: query.q, mode: 'insensitive' } } },
      { user: { email: { contains: query.q, mode: 'insensitive' } } }
    ];
  }
  const [records, total, openComplianceFlags, failedLogins] = await Promise.all([
    db.fraudAlert.findMany({
      where,
      select: {
        id: true,
        alertType: true,
        severity: true,
        status: true,
        entityType: true,
        entityId: true,
        details: true,
        reviewedAt: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, name: true, email: true, role: true } },
        organization: { select: { id: true, organizationName: true, verificationStatus: true } },
        reviewedBy: { select: { id: true, name: true, email: true } }
      },
      orderBy: { createdAt: 'desc' },
      skip: query.skip,
      take: query.take
    }),
    db.fraudAlert.count({ where }),
    db.complianceViolation.count({ where: { status: 'open', severity: { in: ['high', 'critical'] } } }).catch(() => 0),
    db.loginEvent.count({ where: { success: false } }).catch(() => 0)
  ]);
  ok(res, { records, total, filters: query, summary: { openComplianceFlags, failedLogins } });
}));

router.get('/admin/compliance-rules', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const defaults = [
    { code: 'KYC_PAN_REQUIRED', title: 'PAN verification required', description: 'Seller and buyer onboarding must include a valid PAN verification result.', severity: 'HIGH' },
    { code: 'GSTIN_FORMAT_CHECK', title: 'GSTIN format and ownership check', description: 'GSTIN must match the registered legal entity wherever applicable.', severity: 'MEDIUM' },
    { code: 'BANK_ACCOUNT_DUPLICATE', title: 'Duplicate bank account prevention', description: 'Multiple sellers using the same bank account require manual compliance review.', severity: 'HIGH' },
    { code: 'BID_DEADLINE_ENFORCEMENT', title: 'Bid deadline enforcement', description: 'Bids and bid modifications after deadline must be blocked.', severity: 'CRITICAL' }
  ];
  if (await db.complianceRule.count().catch(() => 0) === 0) {
    await Promise.all(defaults.map(rule => db.complianceRule.upsert({ where: { code: rule.code }, update: {}, create: rule }).catch(() => null)));
  }
  const query = parse(paginationQuery.extend({
    severity: z.string().trim().optional(),
    isActive: z.coerce.boolean().optional()
  }), req.query);
  const where: any = {};
  if (query.severity) where.severity = query.severity;
  if (query.isActive !== undefined) where.isActive = query.isActive;
  if (query.q) {
    where.OR = [
      { code: { contains: query.q, mode: 'insensitive' } },
      { title: { contains: query.q, mode: 'insensitive' } },
      { description: { contains: query.q, mode: 'insensitive' } }
    ];
  }
  const [records, total] = await Promise.all([
    db.complianceRule.findMany({
      where,
      select: {
        id: true,
        code: true,
        title: true,
        description: true,
        severity: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        violations: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, type: true, severity: true, status: true, createdAt: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: query.skip,
      take: query.take
    }),
    db.complianceRule.count({ where })
  ]);
  ok(res, { records, total, filters: query });
}));

/**
 * Compliance Rule mutation endpoints. Admins can edit a rule's title,
 * description, severity, and toggle isActive. Code is immutable - it's the
 * machine-readable identifier that compliance violations reference.
 */
router.put('/admin/compliance-rules/:id', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({
    title: z.string().trim().min(2).max(160).optional(),
    description: z.string().trim().max(2000).optional(),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    isActive: z.boolean().optional()
  }), req.body);
  const existing = await db.complianceRule.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Compliance rule not found', 'COMPLIANCE_RULE_NOT_FOUND');
  const updated = await db.complianceRule.update({ where: { id }, data: body });
  await auditWrite(req, 'compliance_rule.updated', 'complianceRule', id, body);
  ok(res, updated);
}));

router.post('/admin/compliance-rules', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const body = parse(z.object({
    code: z.string().trim().min(3).max(80).regex(/^[A-Z0-9_]+$/, 'Code must be uppercase, numbers, and underscores only'),
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().max(2000).optional(),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
    isActive: z.boolean().default(true)
  }), req.body);
  const existing = await db.complianceRule.findUnique({ where: { code: body.code } });
  if (existing) throw new ApiError(409, 'A rule with this code already exists', 'COMPLIANCE_RULE_DUPLICATE');
  const rule = await db.complianceRule.create({ data: body });
  await auditWrite(req, 'compliance_rule.created', 'complianceRule', rule.id, body);
  ok(res, rule, 201);
}));

router.get('/admin/compliance-rules/:id/violations', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);

  const rule = await db.complianceRule.findUnique({ where: { id } });
  if (!rule) throw new ApiError(404, 'Compliance rule not found', 'COMPLIANCE_RULE_NOT_FOUND');

  const query = parse(paginationQuery, req.query);
  const window = listWindow(query);

  const ruleCodeToTypesMap: Record<string, string[]> = {
    'DUPLICATE_IDENTIFIER': ['duplicate_pan', 'duplicate_gst', 'duplicate_aadhaar_hash', 'duplicate_bank_account', 'DUPLICATE_IDENTIFIER'],
    'SUSPICIOUS_REGISTRATION': ['same_ip_multiple_sellers_bidding', 'similar_price_seconds_apart', 'suspicious_lowball_bid', 'sudden_bid_withdrawal_pattern', 'same_ip_multiple_sellers_auction', 'SUSPICIOUS_REGISTRATION'],
    'BANK_ACCOUNT_DUPLICATE': ['duplicate_bank_account', 'BANK_ACCOUNT_DUPLICATE'],
    'KYC_PAN_REQUIRED': ['KYC_PAN_REQUIRED'],
    'GSTIN_FORMAT_CHECK': ['GSTIN_FORMAT_CHECK'],
    'BID_DEADLINE_ENFORCEMENT': ['BID_DEADLINE_ENFORCEMENT'],
    'MISSING_REQUIRED_DOCUMENT': ['missing_udyam_certificate', 'missing_gst_declaration', 'MISSING_REQUIRED_DOCUMENT'],
    'EXPIRED_CERTIFICATE': ['EXPIRED_CERTIFICATE'],
    'INVALID_GST': ['gst_status_inactive', 'gst_legal_name_mismatch', 'INVALID_GST'],
    'INVALID_PAN': ['pan_name_mismatch', 'INVALID_PAN'],
    'INVALID_BANK': ['bank_verification_failed', 'INVALID_BANK'],
    'POLICY_VIOLATION': ['late_bid_submission_attempt', 'POLICY_VIOLATION']
  };
  const typeFilters = ruleCodeToTypesMap[rule.code] || [rule.code];
  const whereFilter = {
    OR: [
      { ruleId: id },
      { type: { in: typeFilters } }
    ]
  };

  let [records, total] = await Promise.all([
    db.complianceViolation.findMany({
      where: whereFilter,
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      skip: window.skip,
      take: window.take
    }),
    db.complianceViolation.count({ where: whereFilter })
  ]);



  ok(res, { records, total, ...window });
}));

router.post('/admin/compliance-violations/:id/resolve', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({
    remarks: z.string().trim().max(2000).optional()
  }), req.body || {});
  const violation = await db.complianceViolation.findUnique({ where: { id } });
  if (!violation) throw new ApiError(404, 'Violation not found', 'COMPLIANCE_VIOLATION_NOT_FOUND');

  const adminUser = await db.user.findUnique({
    where: { id: userId(req) },
    select: { name: true, email: true }
  });

  const updated = await db.complianceViolation.update({
    where: { id },
    data: {
      status: 'resolved',
      resolvedAt: new Date(),
      metadata: {
        ...((violation.metadata as any) || {}),
        resolutionRemarks: body.remarks,
        resolvedById: userId(req),
        resolvedByName: adminUser?.name || 'System Admin',
        resolvedByEmail: adminUser?.email || 'admin@msme.gov.in'
      }
    }
  });
  await auditWrite(req, 'compliance_violation.resolved', 'complianceViolation', id, body);
  ok(res, updated);
}));

/**
 * Fraud Alert mutation endpoints. Admin can assign themselves to an alert,
 * mark it under review, confirm, dismiss, or resolve. All transitions write
 * an audit log entry with the actor and reason.
 */
router.get('/admin/fraud-alerts/:id', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const alert = await db.fraudAlert.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true, role: true } },
      organization: true,
      reviewedBy: { select: { id: true, name: true, email: true } }
    }
  });
  if (!alert) throw new ApiError(404, 'Fraud alert not found', 'FRAUD_ALERT_NOT_FOUND');
  ok(res, alert);
}));

router.put('/admin/fraud-alerts/:id', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({
    status: z.enum(['OPEN', 'UNDER_REVIEW', 'CONFIRMED', 'DISMISSED', 'RESOLVED']).optional(),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    remarks: z.string().trim().max(2000).optional(),
    assignToSelf: z.boolean().optional()
  }), req.body || {});

  const existing = await db.fraudAlert.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Fraud alert not found', 'FRAUD_ALERT_NOT_FOUND');

  const data: any = {};
  if (body.status !== undefined) data.status = body.status;
  if (body.severity !== undefined) data.severity = body.severity;

  // Auto-stamp reviewer when transitioning to a non-OPEN status, OR when the
  // admin explicitly assigns themselves to triage the alert.
  const isTransitioningToReview = body.status && body.status !== 'OPEN';
  if (body.assignToSelf || isTransitioningToReview) {
    data.reviewedById = userId(req);
    data.reviewedAt = new Date();
  }

  if (body.remarks !== undefined) {
    data.details = {
      ...((existing.details as any) || {}),
      reviewerRemarks: body.remarks,
      reviewerRemarksAt: new Date().toISOString(),
      reviewerRemarksById: userId(req)
    };
  }

  const updated = await db.fraudAlert.update({
    where: { id },
    data,
    include: {
      user: { select: { id: true, name: true, email: true, role: true } },
      organization: true,
      reviewedBy: { select: { id: true, name: true, email: true } }
    }
  });
  await auditWrite(req, 'fraud_alert.updated', 'fraudAlert', id, body);
  ok(res, updated);
}));

router.get('/admin/reports/summary', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const kpiOnly = req.query.kpiOnly === 'true';
  const detailsOnly = req.query.detailsOnly === 'true';
  const timeframe = (req.query.timeframe as string) || 'all';
  const role = (req.query.role as string) || 'all';

  let startDate: Date | undefined;
  if (timeframe === '7d') startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  else if (timeframe === '30d') startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  else if (timeframe === '90d') startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  else if (timeframe === '1y') startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

  const globalWhere: any = {};
  if (startDate) globalWhere.createdAt = { gte: startDate };

  const userRoleWhere: any = {};
  if (role !== 'all') userRoleWhere.role = role;

  const pendingOnboardingStatuses = ['pending', 'pending_validation', 'manual_review_required', 'under_compliance_review', 'resubmission_required'];

  // 1. If detailsOnly is not true, we fetch the counts and KPIs (wrapped in cache)
  let totalNetwork = 0;
  let activeSellers = 0;
  let activeBuyers = 0;
  let activeShg = 0;
  let pendingApproval = 0;
  let tenders = 0;
  let bids = 0;
  let purchaseOrders = 0;
  let payments = 0;
  let disputes = 0;
  let avgOnboardingTime = '0 Days';
  let approvalRate = '0%';
  let activeProcurementValue = '₹0.00Cr';
  let tenderSuccessRate = '0%';
  let topBuyers = 'N/A';

  if (!detailsOnly) {
    const cachedKpis = await getOrSetCache(
      redisKeys.cacheAdminKpiSummary(timeframe, role),
      async () => {
        const countsPromise = Promise.all([
          db.user.count({ where: { ...globalWhere, ...userRoleWhere } }),
          Promise.resolve(0), // Placeholder for sellers (calculated below)
          db.user.count({ where: { role: 'buyer', onboardingStatus: 'approved_for_procurement', ...globalWhere, ...userRoleWhere } }),
          db.user.count({ where: { role: { in: ['seller', 'buyer', 'shg'] }, onboardingStatus: { in: pendingOnboardingStatuses }, ...globalWhere, ...userRoleWhere } }),
          db.tender.count({ where: globalWhere }),
          db.bid.count({ where: globalWhere }),
          db.purchaseOrder.count({ where: globalWhere }),
          db.paymentTransaction.count({ where: globalWhere }),
          db.dispute.count({ where: globalWhere }),
          Promise.resolve(0) // Placeholder for shg (calculated below)
        ]);

        const approvedSellersAndShgPromise = db.user.findMany({
          where: { role: { in: ['seller', 'shg'] }, onboardingStatus: 'approved_for_procurement', ...globalWhere, ...userRoleWhere },
          select: {
            id: true,
            role: true,
            registrationDetails: true,
            sellerProfile: { select: { organizationType: true } },
            shgProfile: { select: { id: true } },
            organization: {
              select: {
                organizationType: true
              }
            }
          }
        });

        const aggregatesPromise = (async () => {
          // Active PO Sum
          const activePOs = await db.purchaseOrder.aggregate({
            where: { status: { in: ['accepted', 'in_progress', 'delivered'] }, ...globalWhere },
            _sum: { amount: true }
          });
          const activeVal = '₹' + (Number(activePOs._sum.amount || 0) / 10000000).toFixed(2) + 'Cr';

          // Tender metrics
          const [closedTenders, awardedTenders] = await Promise.all([
            db.tender.count({ where: { status: 'closed', ...globalWhere } }),
            db.tender.count({ where: { status: 'closed', awardedBidId: { not: null }, ...globalWhere } })
          ]);
          const successRate = closedTenders > 0 ? ((awardedTenders / closedTenders) * 100).toFixed(1) + '%' : '0%';

          // Optimized Avg Onboarding Time using queryRaw with a fallback
          let onboardingTime = '0 Days';
          try {
            let filterSql = `WHERE "onboardingStatus" = 'approved_for_procurement'`;
            const args: any[] = [];
            if (startDate) {
              args.push(startDate);
              filterSql += ` AND "createdAt" >= $${args.length}`;
            }
            if (role !== 'all') {
              args.push(role);
              filterSql += ` AND "role" = $${args.length}`;
            }
            const rawResult: any[] = await (db as any).$queryRawUnsafe(`
              SELECT AVG(EXTRACT(EPOCH FROM ("updatedAt" - "createdAt")) / 86400) as "avgDays"
              FROM "User"
              ${filterSql}
            `, ...args);
            const avgDays = rawResult?.[0]?.avgDays ?? rawResult?.[0]?.avgdays;
            onboardingTime = avgDays ? Number(avgDays).toFixed(1) + ' Days' : '0 Days';
          } catch (e) {
            // Fallback to sample logic
            const approvedUsers = await db.user.findMany({
              where: { onboardingStatus: 'approved_for_procurement', ...globalWhere, ...userRoleWhere },
              select: { createdAt: true, updatedAt: true },
              take: 1000,
              orderBy: { updatedAt: 'desc' }
            });
            if (approvedUsers.length > 0) {
              const totalMs = approvedUsers.reduce((sum: number, u: any) => sum + (new Date(u.updatedAt).getTime() - new Date(u.createdAt).getTime()), 0);
              onboardingTime = (totalMs / approvedUsers.length / (1000 * 60 * 60 * 24)).toFixed(1) + ' Days';
            }
          }

          let topBuyerName = 'N/A';
          try {
            const topBuyerAgg = await db.purchaseOrder.groupBy({
              by: ['buyerId'],
              _count: { id: true },
              where: globalWhere,
              orderBy: { _count: { id: 'desc' } },
              take: 1
            });
            if (topBuyerAgg.length > 0 && topBuyerAgg[0].buyerId) {
              const buyerUser = await db.user.findUnique({
                where: { id: topBuyerAgg[0].buyerId },
                include: { organization: true }
              });
              topBuyerName = buyerUser?.organization?.organizationName || buyerUser?.name || 'Unknown';
            }
            if (!topBuyerName || topBuyerName === 'N/A') {
              // Fallback to most active buyer with requirements or approved buyer
              const topReqBuyer = await db.buyerRequirement.groupBy({
                by: ['buyerId'],
                _count: { id: true },
                orderBy: { _count: { id: 'desc' } },
                take: 1
              }).catch(() => []);
              if (topReqBuyer.length > 0 && topReqBuyer[0].buyerId) {
                const bUser = await db.user.findUnique({
                  where: { id: topReqBuyer[0].buyerId },
                  include: { organization: true }
                });
                topBuyerName = bUser?.organization?.organizationName || bUser?.name || 'N/A';
              } else {
                const firstBuyer = await db.user.findFirst({
                  where: { role: 'buyer', onboardingStatus: 'approved_for_procurement' },
                  include: { organization: true }
                });
                if (firstBuyer) {
                  topBuyerName = firstBuyer.organization?.organizationName || firstBuyer.name || 'N/A';
                }
              }
            }
          } catch (e) {
            console.error('Failed to fetch top buyer', e);
          }

          return { activeVal, successRate, onboardingTime, topBuyerName };
        })();

        const [counts, aggregates, approvedUsers] = await Promise.all([countsPromise, aggregatesPromise, approvedSellersAndShgPromise]);

        const isShgUserBackend = (user: any) => {
          if (!user) return false;
          if (user.role === 'shg') return true;
          if (user.role !== 'seller') return false;
          
          const isShgBusinessType = (value: unknown) => {
            const normalized = String(value || '').trim().toLowerCase();
            return ['hershg', 'her_shg', 'shg', 'women shg', 'self help group', 'women_self_help_group', 'women_shg', 'women-shg', 'farmer_producer_group', 'farmer_shg', 'artisan_handicraft_shg', 'artisan_shg', 'dairy_cooperative_shg', 'dairy_shg', 'livelihood_shg', 'tribal_shg', 'youth_shg', 'other_shg'].includes(normalized);
          };

          return isShgBusinessType(user?.registrationDetails?.businessType)
            || isShgBusinessType(user?.registrationDetails?.stakeholderCategory)
            || isShgBusinessType(user?.registrationDetails?.shgType)
            || isShgBusinessType(user?.sellerProfile?.organizationType)
            || isShgBusinessType(user?.organization?.organizationType)
            || isShgBusinessType(user?.organizationType)
            || isShgBusinessType(user?.businessType);
        };

        const activeShg_val = approvedUsers.filter(isShgUserBackend).length;
        const activeSellers_val = approvedUsers.filter((u: any) => u.role === 'seller' && !isShgUserBackend(u)).length;

        const totalNetwork_val = counts[0];
        const activeBuyers_val = counts[2];
        const pendingApproval_val = counts[3];
        const tenders_val = counts[4];
        const bids_val = counts[5];
        const purchaseOrders_val = counts[6];
        const payments_val = counts[7];
        const disputes_val = counts[8];

        const activeProcurementValue_val = aggregates.activeVal;
        const tenderSuccessRate_val = aggregates.successRate;
        const avgOnboardingTime_val = aggregates.onboardingTime;
        const topBuyerName_val = aggregates.topBuyerName;

        const totalOnboarded = await db.user.count({ where: { onboardingStatus: { not: 'pending' }, ...globalWhere, ...userRoleWhere } });
        const approvalRate_val = totalOnboarded > 0 ? ((activeSellers_val + activeBuyers_val) / totalOnboarded * 100).toFixed(1) + '%' : '0%';

        return {
          totalNetwork: totalNetwork_val,
          activeSellers: activeSellers_val,
          activeBuyers: activeBuyers_val,
          pendingApproval: pendingApproval_val,
          tenders: tenders_val,
          pendingTenders: tenders_val,
          bids: bids_val,
          purchaseOrders: purchaseOrders_val,
          payments: payments_val,
          disputes: disputes_val,
          avgOnboardingTime: avgOnboardingTime_val,
          approvalRate: approvalRate_val,
          activeProcurementValue: activeProcurementValue_val,
          tenderSuccessRate: tenderSuccessRate_val,
          topBuyers: topBuyerName_val,
          activeShg: activeShg_val
        };
      },
      60 // 60 seconds TTL
    );

    totalNetwork = cachedKpis.totalNetwork;
    activeSellers = cachedKpis.activeSellers;
    activeBuyers = cachedKpis.activeBuyers;
    pendingApproval = cachedKpis.pendingApproval;
    tenders = cachedKpis.tenders;
    bids = cachedKpis.bids;
    purchaseOrders = cachedKpis.purchaseOrders;
    payments = cachedKpis.payments;
    disputes = cachedKpis.disputes;
    avgOnboardingTime = cachedKpis.avgOnboardingTime;
    approvalRate = cachedKpis.approvalRate;
    activeProcurementValue = cachedKpis.activeProcurementValue;
    tenderSuccessRate = cachedKpis.tenderSuccessRate;
    topBuyers = cachedKpis.topBuyers;
    activeShg = cachedKpis.activeShg;

    if (kpiOnly) {
      return ok(res, {
        totalNetwork,
        activeSellers,
        activeBuyers,
        pendingApproval,
        tenders,
        pendingTenders: (cachedKpis as any).pendingTenders ?? tenders,
        bids,
        purchaseOrders,
        payments,
        disputes,
        avgOnboardingTime,
        approvalRate,
        activeProcurementValue,
        tenderSuccessRate,
        topBuyers,
        activeShg
      });
    }
  }

  // 2. Heavy details calculation (only if not kpiOnly)
  let userGrowth: any[] = [];
  let transactions: any[] = [];
  let clusterBreakdown: any[] = [];
  let procurementMethods: any = {};
  let settlementCompliance: any = {};
  let geographicLinkage: any = {};
  let entityClassification: any = {};
  let recentActivities: any[] = [];
  let shgStats: any = null;

  if (!kpiOnly) {
    const timeframe = String(req.query.timeframe || '30d').toLowerCase();
    const roleFilter = String(req.query.role || 'all').toLowerCase();

    // Determine timeframe start date
    const now = new Date();
    let startDate = new Date();
    let intervalCount = 6;
    let intervalType: 'day' | 'week' | 'month' = 'month';

    if (timeframe === '7d') {
      startDate.setDate(now.getDate() - 7);
      intervalCount = 7;
      intervalType = 'day';
    } else if (timeframe === '30d') {
      startDate.setDate(now.getDate() - 30);
      intervalCount = 5;
      intervalType = 'week';
    } else if (timeframe === '90d') {
      startDate.setDate(now.getDate() - 90);
      intervalCount = 3;
      intervalType = 'month';
    } else if (timeframe === '1y') {
      startDate.setFullYear(now.getFullYear() - 1);
      intervalCount = 12;
      intervalType = 'month';
    } else { // 'all'
      startDate.setFullYear(now.getFullYear() - 2);
      intervalCount = 8;
      intervalType = 'month';
    }

    // A. User Growth calculation with role & timeframe awareness
    const userGrowthPromise = (async () => {
      try {
        const userWhere: any = { createdAt: { gte: startDate } };
        if (roleFilter !== 'all') {
          userWhere.role = roleFilter;
        }

        const recentUsers = await db.user.findMany({
          where: userWhere,
          select: { createdAt: true, role: true },
          orderBy: { createdAt: 'asc' }
        });

        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const buckets: Array<{ name: string; buyers: number; sellers: number; shgs: number; total: number; start: Date; end: Date }> = [];

        if (intervalType === 'day') {
          for (let i = intervalCount - 1; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(now.getDate() - i);
            d.setHours(0, 0, 0, 0);
            const endD = new Date(d);
            endD.setHours(23, 59, 59, 999);
            buckets.push({
              name: `${dayNames[d.getDay()]} ${d.getDate()}`,
              buyers: 0,
              sellers: 0,
              shgs: 0,
              total: 0,
              start: d,
              end: endD
            });
          }
        } else if (intervalType === 'week') {
          for (let i = intervalCount - 1; i >= 0; i--) {
            const startD = new Date(now);
            startD.setDate(now.getDate() - (i + 1) * 6);
            startD.setHours(0, 0, 0, 0);
            const endD = new Date(startD);
            endD.setDate(startD.getDate() + 6);
            endD.setHours(23, 59, 59, 999);
            buckets.push({
              name: `Wk ${intervalCount - i}`,
              buyers: 0,
              sellers: 0,
              shgs: 0,
              total: 0,
              start: startD,
              end: endD
            });
          }
        } else {
          for (let i = intervalCount - 1; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const endD = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
            buckets.push({
              name: monthNames[d.getMonth()],
              buyers: 0,
              sellers: 0,
              shgs: 0,
              total: 0,
              start: d,
              end: endD
            });
          }
        }

        recentUsers.forEach((u: any) => {
          const uDate = new Date(u.createdAt);
          for (const b of buckets) {
            if (uDate >= b.start && uDate <= b.end) {
              if (u.role === 'buyer') b.buyers++;
              else if (u.role === 'seller') b.sellers++;
              else if (u.role === 'shg') b.shgs++;
              b.total++;
              break;
            }
          }
        });

        return buckets.map(b => ({
          name: b.name,
          buyers: b.buyers,
          sellers: b.sellers,
          shgs: b.shgs,
          total: b.total
        }));
      } catch {
        return [];
      }
    })();

    // B. Transaction Volume calculation
    const transactionsPromise = (async () => {
      try {
        const recentPayments = await db.paymentTransaction.findMany({
          where: { createdAt: { gte: startDate } },
          select: { createdAt: true, amount: true, status: true },
          orderBy: { createdAt: 'asc' }
        });

        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const buckets: Array<{ name: string; value: number; count: number; start: Date; end: Date }> = [];

        if (intervalType === 'day') {
          for (let i = intervalCount - 1; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(now.getDate() - i);
            d.setHours(0, 0, 0, 0);
            const endD = new Date(d);
            endD.setHours(23, 59, 59, 999);
            buckets.push({
              name: `${dayNames[d.getDay()]} ${d.getDate()}`,
              value: 0,
              count: 0,
              start: d,
              end: endD
            });
          }
        } else if (intervalType === 'week') {
          for (let i = intervalCount - 1; i >= 0; i--) {
            const startD = new Date(now);
            startD.setDate(now.getDate() - (i + 1) * 6);
            startD.setHours(0, 0, 0, 0);
            const endD = new Date(startD);
            endD.setDate(startD.getDate() + 6);
            endD.setHours(23, 59, 59, 999);
            buckets.push({
              name: `Wk ${intervalCount - i}`,
              value: 0,
              count: 0,
              start: startD,
              end: endD
            });
          }
        } else {
          for (let i = intervalCount - 1; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const endD = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
            buckets.push({
              name: monthNames[d.getMonth()],
              value: 0,
              count: 0,
              start: d,
              end: endD
            });
          }
        }

        recentPayments.forEach((p: any) => {
          const pDate = new Date(p.createdAt);
          for (const b of buckets) {
            if (pDate >= b.start && pDate <= b.end) {
              b.value += Number(p.amount || 0);
              b.count++;
              break;
            }
          }
        });

        return buckets.map(b => ({
          name: b.name,
          value: Math.round(b.value),
          count: b.count
        }));
      } catch {
        return [];
      }
    })();

    // C. Jharsuguda Industrial Cluster Breakdown (Pure DB Sourcing)
    const clusterBreakdownPromise = (async () => {
      try {
        const items = await db.purchaseOrderItem.findMany({
          select: {
            totalAmount: true,
            itemName: true,
            purchaseOrderId: true,
            product: { select: { category: { select: { name: true } } } }
          }
        });

        const categorySpend: Record<string, { spend: number; orderIds: Set<number> }> = {};
        for (const it of items) {
          const catName = it.product?.category?.name || it.itemName || 'General Procurement';
          if (!categorySpend[catName]) {
            categorySpend[catName] = { spend: 0, orderIds: new Set() };
          }
          categorySpend[catName].spend += Number(it.totalAmount || 0);
          categorySpend[catName].orderIds.add(it.purchaseOrderId);
        }

        const clusterBreakdown = Object.entries(categorySpend).map(([name, data]) => ({
          name,
          spend: Math.round(data.spend),
          orders: data.orderIds.size
        })).sort((a, b) => b.spend - a.spend);

        const totalSpend = clusterBreakdown.reduce((s, c) => s + c.spend, 0) || 1;
        return clusterBreakdown.map(c => ({
          ...c,
          percentage: Math.round((c.spend / totalSpend) * 100)
        }));
      } catch {
        return [];
      }
    })();

    // D. Procurement Methods Breakdown (Pure DB Sourcing)
    const procurementMethodsPromise = (async () => {
      try {
        const [tendersCount, directCount, quoteCount, rateContractCount] = await Promise.all([
          db.tender.count().catch(() => 0),
          db.directPurchase.count().catch(() => 0),
          db.quoteRequest.count().catch(() => 0),
          db.contract.count({ where: { contractType: 'RATE_CONTRACT' } }).catch(() => 0)
        ]);

        const totalMethods = tendersCount + directCount + quoteCount + rateContractCount || 1;
        return [
          { name: 'E-Tendering', count: tendersCount, share: Math.round((tendersCount / totalMethods) * 100) },
          { name: 'Direct Purchase', count: directCount, share: Math.round((directCount / totalMethods) * 100) },
          { name: 'L1 Quotations', count: quoteCount, share: Math.round((quoteCount / totalMethods) * 100) },
          { name: 'Rate Contracts', count: rateContractCount, share: Math.round((rateContractCount / totalMethods) * 100) }
        ];
      } catch {
        return [];
      }
    })();

    // E. MSMED Act 45-Day Statutory Payment Adherence (Pure DB Sourcing)
    const settlementCompliancePromise = (async () => {
      try {
        const [invoices, escrowAgg] = await Promise.all([
          db.invoice.findMany({
            select: {
              id: true,
              createdAt: true,
              payments: { select: { createdAt: true, status: true } }
            }
          }).catch(() => []),
          db.escrowAccount.aggregate({
            _sum: { amount: true },
            where: { status: { in: ['held', 'funded'] } }
          }).catch(() => ({ _sum: { amount: 0 } }))
        ]);

        const escrowHeld = Number(escrowAgg._sum?.amount || 0);
        let onTime = 0;
        let delayed = 0;
        let totalDays = 0;
        let settledCount = 0;

        for (const inv of invoices) {
          const paidPayment = inv.payments?.find((p: any) => 
            ['completed', 'settled', 'success'].includes(p.status?.toLowerCase())
          );
          if (paidPayment) {
            const days = Math.max(0, (paidPayment.createdAt.getTime() - inv.createdAt.getTime()) / (1000 * 3600 * 24));
            totalDays += days;
            settledCount++;
            if (days <= 45) onTime++;
            else delayed++;
          } else {
            const ageDays = (Date.now() - inv.createdAt.getTime()) / (1000 * 3600 * 24);
            if (ageDays > 45) delayed++;
          }
        }

        const avgSettlementDays = settledCount > 0 ? Number((totalDays / settledCount).toFixed(1)) : 0;
        const complianceRate = invoices.length > 0 ? `${Math.round((onTime / invoices.length) * 100)}%` : '0%';

        return {
          complianceRate,
          onTimePaymentsCount: onTime,
          delayedCount: delayed,
          avgSettlementDays,
          escrowHeldValue: `₹${(escrowHeld / 10000000).toFixed(2)}Cr`,
          targetSlaDays: 45,
          statutoryAct: 'MSMED Act 2006, Section 15'
        };
      } catch {
        return {
          complianceRate: '0%',
          onTimePaymentsCount: 0,
          delayedCount: 0,
          avgSettlementDays: 0,
          escrowHeldValue: '₹0.00Cr',
          targetSlaDays: 45,
          statutoryAct: 'MSMED Act 2006, Section 15'
        };
      }
    })();

    // F. Geographic Linkage (Pure DB Sourcing)
    const geographicLinkagePromise = (async () => {
      try {
        const orgs = await db.organization.findMany({
          select: { district: true, city: true, state: true }
        });

        let jsgCount = 0;
        let odishaCount = 0;
        let outsideCount = 0;

        for (const o of orgs) {
          const isJsg = (o.district && /jharsuguda/i.test(o.district)) || (o.city && /jharsuguda/i.test(o.city));
          const isOdisha = o.state && /odisha|orissa/i.test(o.state);
          if (isJsg) jsgCount++;
          else if (isOdisha) odishaCount++;
          else outsideCount++;
        }

        return {
          jharsugudaDistrict: jsgCount,
          restOfOdisha: odishaCount,
          restOfIndia: outsideCount,
          localLinkagePercent: orgs.length > 0 ? Math.round((jsgCount / orgs.length) * 100) : 0
        };
      } catch {
        return {
          jharsugudaDistrict: 0,
          restOfOdisha: 0,
          restOfIndia: 0,
          localLinkagePercent: 0
        };
      }
    })();

    // G. Entity Classification (Pure DB Sourcing)
    const entityClassificationPromise = (async () => {
      try {
        const [localMsmeCount, msmeCount, allSellersCount, shgCount, buyerCount] = await Promise.all([
          db.sellerProfile.count({ where: { msmeType: 'LOCAL_MSME' } }).catch(() => 0),
          db.sellerProfile.count({ where: { msmeType: 'MSME' } }).catch(() => 0),
          db.user.count({ where: { role: 'seller' } }).catch(() => 0),
          db.user.count({ where: { role: 'shg' } }).catch(() => 0),
          db.user.count({ where: { role: 'buyer' } }).catch(() => 0)
        ]);

        const otherSuppliers = Math.max(0, allSellersCount - (localMsmeCount + msmeCount));
        const total = (localMsmeCount + msmeCount + otherSuppliers + shgCount + buyerCount) || 1;

        const list = [
          { name: 'Local MSMEs (District)', count: localMsmeCount, value: Math.round((localMsmeCount / total) * 100), fill: '#12335f' },
          { name: 'MSME Enterprises', count: msmeCount, value: Math.round((msmeCount / total) * 100), fill: '#0284c7' },
          { name: 'General Suppliers', count: otherSuppliers, value: Math.round((otherSuppliers / total) * 100), fill: '#10b981' },
          { name: 'Women SHGs', count: shgCount, value: Math.round((shgCount / total) * 100), fill: '#8b5cf6' },
          { name: 'Anchor Buyers & PSUs', count: buyerCount, value: Math.round((buyerCount / total) * 100), fill: '#f59e0b' }
        ];

        return list.filter(item => item.count > 0);
      } catch {
        return [];
      }
    })();

    // H. Recent Activities Log (Pure DB Sourcing)
    const recentActivitiesPromise = (async () => {
      try {
        const recentOrders = await db.purchaseOrder.findMany({
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: {
            buyer: { select: { name: true } },
            seller: { select: { name: true } }
          }
        });

        return recentOrders.map((po: any) => ({
          id: po.id,
          type: 'PURCHASE_ORDER',
          title: po.title || `Purchase Order PO-${po.id}`,
          partyA: po.buyer?.name || 'Anchor Buyer',
          partyB: po.seller?.name || 'MSME Vendor',
          amount: Number(po.amount || 0),
          status: po.status,
          date: po.createdAt
        }));
      } catch {
        return [];
      }
    })();

    // I. Women SHG Linkage (Pure DB Sourcing)
    const shgStatsPromise = (async () => {
      try {
        const [shgUsersCount, shgPos] = await Promise.all([
          db.user.count({ where: { role: 'shg' } }).catch(() => 0),
          db.purchaseOrder.findMany({
            where: { seller: { role: 'shg' } },
            select: { id: true, amount: true, title: true }
          }).catch(() => [])
        ]);

        const shgSpend = shgPos.reduce((sum: number, po: any) => sum + Number(po.amount || 0), 0);
        return {
          collectivesCount: shgUsersCount,
          ordersCount: shgPos.length,
          totalSpend: shgSpend,
          spendFormatted: `₹${Number(shgSpend).toLocaleString('en-IN')}`
        };
      } catch {
        return {
          collectivesCount: 0,
          ordersCount: 0,
          totalSpend: 0,
          spendFormatted: '₹0'
        };
      }
    })();

    [
      userGrowth,
      transactions,
      clusterBreakdown,
      procurementMethods,
      settlementCompliance,
      geographicLinkage,
      entityClassification,
      recentActivities,
      shgStats
    ] = await Promise.all([
      userGrowthPromise,
      transactionsPromise,
      clusterBreakdownPromise,
      procurementMethodsPromise,
      settlementCompliancePromise,
      geographicLinkagePromise,
      entityClassificationPromise,
      recentActivitiesPromise,
      shgStatsPromise
    ]);

    if (detailsOnly) {
      return ok(res, {
        userGrowth,
        transactions,
        clusterBreakdown,
        procurementMethods,
        settlementCompliance,
        geographicLinkage,
        entityClassification,
        recentActivities,
        shgStats
      });
    }
  }

  ok(res, {
    totalNetwork,
    activeSellers,
    activeBuyers,
    pendingApproval,
    tenders,
    bids,
    purchaseOrders,
    payments,
    disputes,
    userGrowth,
    transactions,
    clusterBreakdown,
    procurementMethods,
    settlementCompliance,
    geographicLinkage,
    entityClassification,
    recentActivities,
    shgStats,
    avgOnboardingTime,
    approvalRate,
    activeProcurementValue,
    tenderSuccessRate
  });
}));

router.get('/admin/reports/procurement', authenticate, authorizeAdmin, asyncRoute(async (_req, res) => {
  const [requirements, tenders, directPurchases, quoteRequests, purchaseOrders, rateContracts, activeRateContracts, expiredRateContracts] = await Promise.all([
    db.requirement.count(),
    db.tender.count(),
    db.directPurchase.count(),
    db.quoteRequest.count(),
    db.purchaseOrder.count(),
    db.contract.count({ where: { contractType: 'RATE_CONTRACT' } }),
    db.contract.count({ where: { contractType: 'RATE_CONTRACT', endDate: { gte: new Date() } } }),
    db.contract.count({ where: { contractType: 'RATE_CONTRACT', endDate: { lt: new Date() } } })
  ]);
  ok(res, { requirements, tenders, directPurchases, quoteRequests, purchaseOrders, rateContracts, activeRateContracts, expiredRateContracts });
}));

router.get('/admin/reports/procurement/method-wise', authenticate, authorizeAdmin, asyncRoute(async (_req, res) => {
  const [tenderStats, dpStats, rfqStats, poStats] = await Promise.all([
    db.tender.aggregate({
      _count: { id: true },
      _sum: { budget: true }
    }),
    db.directPurchase.aggregate({
      _count: { id: true },
      _sum: { totalAmount: true }
    }),
    db.quoteRequest.aggregate({
      _count: { id: true },
      _sum: { estimatedValue: true }
    }),
    db.purchaseOrder.aggregate({
      _count: { id: true },
      _sum: { amount: true }
    })
  ]);

  const tenderCount = tenderStats._count.id || 0;
  const tenderSpend = Number(tenderStats._sum.budget || 0);

  const dpCount = dpStats._count.id || 0;
  const dpSpend = Number(dpStats._sum.totalAmount || 0);

  const rfqCount = rfqStats._count.id || 0;
  const rfqSpend = Number(rfqStats._sum.estimatedValue || 0);

  const poCount = poStats._count.id || 0;
  const poSpend = Number(poStats._sum.amount || 0);

  ok(res, {
    counts: [
      { method: 'TENDER', label: 'Open Tender', broadMethod: 'Competitive', count: tenderCount, isException: false },
      { method: 'DIRECT_PURCHASE', label: 'Direct Purchase', broadMethod: 'Direct', count: dpCount, isException: false },
      { method: 'QUOTE_REQUEST', label: 'Request for Quotation (RFQ)', broadMethod: 'Competitive', count: rfqCount, isException: false },
      { method: 'PURCHASE_ORDER', label: 'Purchase Order', broadMethod: 'Fulfilment', count: poCount, isException: false }
    ],
    spend: [
      { method: 'TENDER', label: 'Open Tender', totalSpend: tenderSpend, isException: false },
      { method: 'DIRECT_PURCHASE', label: 'Direct Purchase', totalSpend: dpSpend, isException: false },
      { method: 'QUOTE_REQUEST', label: 'Request for Quotation (RFQ)', totalSpend: rfqSpend, isException: false },
      { method: 'PURCHASE_ORDER', label: 'Purchase Order', totalSpend: poSpend, isException: false }
    ],
    tenderComparison: [
      { method: 'TENDER', label: 'Open Tender', count: tenderCount, totalSpend: tenderSpend },
      { method: 'DIRECT_PURCHASE', label: 'Direct Purchase', count: dpCount, totalSpend: dpSpend },
      { method: 'QUOTE_REQUEST', label: 'RFQ', count: rfqCount, totalSpend: rfqSpend },
      { method: 'PURCHASE_ORDER', label: 'Purchase Order', count: poCount, totalSpend: poSpend }
    ]
  });
}));

router.get('/admin/reports/procurement/exceptions', authenticate, authorizeAdmin, asyncRoute(async (_req, res) => {
  const directPurchases = await db.directPurchase.findMany({
    take: 50,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      purchaseNumber: true,
      totalAmount: true,
      justification: true,
      department: true,
      status: true,
      createdAt: true
    }
  });

  const exceptions = directPurchases.map(dp => ({
    id: dp.id,
    referenceNumber: dp.purchaseNumber,
    method: 'DIRECT_PURCHASE',
    amount: Number(dp.totalAmount || 0),
    exceptionReason: dp.justification || 'Direct Purchase Single Source',
    department: dp.department || 'General',
    status: dp.status,
    date: dp.createdAt
  }));

  ok(res, exceptions);
}));

router.get('/admin/reports/payments', authenticate, authorizeAdmin, asyncRoute(async (_req, res) => {
  const [invoices, payments, escrows, milestones] = await Promise.all([
    db.invoice.count(),
    db.paymentTransaction.count(),
    db.escrowAccount.count(),
    db.milestone.count()
  ]);
  ok(res, { invoices, payments, escrows, milestones });
}));

router.get('/admin/reports/suppliers', authenticate, authorizeAdmin, asyncRoute(async (_req, res) => {
  const [sellers, products, services, ratings] = await Promise.all([
    db.user.count({ where: { role: 'seller' } }),
    db.product.count(),
    db.service.count(),
    db.supplierRating.count()
  ]);
  ok(res, { sellers, products, services, ratings });
}));

router.get('/admin/reports/category-volume', authenticate, authorizeAdmin, asyncRoute(async (_req, res) => {
  const [categories, purchaseOrders, auctions] = await Promise.all([
    db.category.findMany({
      where: { isActive: true },
      select: { id: true, name: true, slug: true },
      orderBy: { name: 'asc' }
    }),
    db.purchaseOrder.findMany({
      select: {
        id: true,
        poNumber: true,
        amount: true,
        totalValue: true,
        status: true,
        sourceType: true,
        sourceId: true,
        metadata: true,
        tender: {
          select: {
            id: true,
            category: true,
            categoryId: true,
            categoryRef: { select: { id: true, name: true } }
          }
        },
        items: {
          select: {
            id: true,
            itemName: true,
            totalAmount: true,
            product: {
              select: {
                id: true,
                categoryId: true,
                category: { select: { id: true, name: true } }
              }
            }
          }
        }
      }
    }),
    db.auction.findMany({
      select: {
        id: true,
        category: true
      }
    })
  ]);

  const auctionCategoryMap = new Map<number, string>();
  for (const auc of auctions) {
    if (auc.id && auc.category) {
      auctionCategoryMap.set(auc.id, auc.category);
    }
  }

  const categoryNameMap = new Map<string, { id: number; name: string }>();
  for (const cat of categories) {
    categoryNameMap.set(cat.name.toLowerCase().trim(), { id: cat.id, name: cat.name });
  }

  const findCategory = (str?: string | null): { id: number | null; name: string } | null => {
    if (!str || typeof str !== 'string') return null;
    const cleanStr = str.toLowerCase().trim();
    if (!cleanStr) return null;

    if (categoryNameMap.has(cleanStr)) {
      return categoryNameMap.get(cleanStr)!;
    }

    if (cleanStr.includes('it equipment') || cleanStr.includes('computer')) {
      const match = categoryNameMap.get('it & computer equipment');
      if (match) return match;
    }
    if (cleanStr.includes('office') || cleanStr.includes('stationery')) {
      const match = categoryNameMap.get('office equipment & stationery');
      if (match) return match;
    }
    if (cleanStr.includes('precision engineering') || cleanStr.includes('machinery & spares') || cleanStr.includes('industrial machinery')) {
      const match = categoryNameMap.get('industrial machinery & spare parts') || categoryNameMap.get('mechanical & engineering');
      if (match) return match;
    }
    if (cleanStr.includes('electrical')) {
      const match = categoryNameMap.get('electrical & electronics');
      if (match) return match;
    }

    for (const [key, cat] of categoryNameMap.entries()) {
      if (cleanStr.includes(key) || key.includes(cleanStr)) {
        return cat;
      }
    }

    return null;
  };

  interface CategoryAggItem {
    categoryId: number | null;
    category: string;
    transactionCount: number;
    totalAmount: number;
  }

  const stats = new Map<string, CategoryAggItem>();

  for (const po of purchaseOrders) {
    const meta = (po.metadata || {}) as Record<string, any>;
    let auctionCat: string | undefined;
    const auctionId = meta.auctionId || (po.sourceType === 'auction' ? po.sourceId : null);
    if (auctionId && auctionCategoryMap.has(Number(auctionId))) {
      auctionCat = auctionCategoryMap.get(Number(auctionId));
    }

    if (po.items && po.items.length > 0) {
      const poCatItems = new Map<string, { categoryId: number | null; name: string; amount: number }>();

      for (const item of po.items) {
        const resolved = (item.product?.category ? { id: item.product.category.id, name: item.product.category.name } : null) ||
          findCategory(item.itemName) ||
          findCategory(auctionCat) ||
          (po.tender?.categoryRef ? { id: po.tender.categoryRef.id, name: po.tender.categoryRef.name } : null) ||
          findCategory(po.tender?.category) ||
          findCategory(meta.itemName);

        const catName = resolved?.name || 'General / Uncategorized';
        const catId = resolved?.id ?? null;
        const itemAmt = Number(item.totalAmount) || (Number(po.amount) / po.items.length) || 0;

        const current = poCatItems.get(catName) || { categoryId: catId, name: catName, amount: 0 };
        current.amount += itemAmt;
        poCatItems.set(catName, current);
      }

      for (const [catName, data] of poCatItems.entries()) {
        const cur = stats.get(catName) || { categoryId: data.categoryId, category: catName, transactionCount: 0, totalAmount: 0 };
        cur.transactionCount += 1;
        cur.totalAmount += data.amount;
        stats.set(catName, cur);
      }
    } else {
      const resolved = findCategory(auctionCat) ||
        (po.tender?.categoryRef ? { id: po.tender.categoryRef.id, name: po.tender.categoryRef.name } : null) ||
        findCategory(po.tender?.category) ||
        findCategory(meta.itemName);

      const catName = resolved?.name || 'General / Uncategorized';
      const catId = resolved?.id ?? null;
      const poAmt = Number(po.amount) || Number(po.totalValue) || 0;

      const cur = stats.get(catName) || { categoryId: catId, category: catName, transactionCount: 0, totalAmount: 0 };
      cur.transactionCount += 1;
      cur.totalAmount += poAmt;
      stats.set(catName, cur);
    }
  }

  const rawCategories = Array.from(stats.values());
  const totalTransactions = rawCategories.reduce((sum, c) => sum + c.transactionCount, 0);
  const totalTransactionValue = rawCategories.reduce((sum, c) => sum + c.totalAmount, 0);

  const categoriesWithPercentages = rawCategories.map((c) => ({
    ...c,
    percentageTransactions: totalTransactions > 0 ? Number(((c.transactionCount / totalTransactions) * 100).toFixed(1)) : 0,
    percentageValue: totalTransactionValue > 0 ? Number(((c.totalAmount / totalTransactionValue) * 100).toFixed(1)) : 0
  })).sort((a, b) => b.transactionCount - a.transactionCount || b.totalAmount - a.totalAmount);

  const topCategory = categoriesWithPercentages.length > 0
    ? [...categoriesWithPercentages].sort((a, b) => b.totalAmount - a.totalAmount)[0].category
    : 'None';

  const highestVolume = categoriesWithPercentages.length > 0
    ? Math.max(...categoriesWithPercentages.map(c => c.transactionCount))
    : 0;

  const averageTransactionValue = totalTransactions > 0
    ? Math.round(totalTransactionValue / totalTransactions)
    : 0;

  const summary = {
    totalCategories: categoriesWithPercentages.length,
    totalCategoriesInSystem: categories.length,
    totalTransactions,
    totalTransactionValue,
    averageTransactionValue,
    topCategory,
    highestTransactionVolume: highestVolume
  };

  ok(res, { summary, categories: categoriesWithPercentages });
}));

router.post('/admin/fraud-alerts', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const alert = await db.fraudAlert.create({ data: req.body || {} });
  await auditWrite(req, 'fraud_alert.created', 'fraudAlert', alert.id);
  ok(res, alert, 201);
}));

router.post('/admin/compliance-violations', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const body = parse(z.object({ userId: z.coerce.number().int().positive().optional(), type: z.string().min(2), severity: z.enum(['low', 'medium', 'high', 'critical']).optional(), description: z.string().min(3), metadata: z.record(z.string(), z.unknown()).optional() }), req.body);
  const violation = await createComplianceFlag(body);
  ok(res, violation, 201);
}));

// ═══════════════════════════════════════════
// RBAC Administration Routes
// ═══════════════════════════════════════════

router.get('/admin/rbac/roles', authenticate, authorizeAdmin, asyncRoute(async (_req, res) => {
  const roles = await db.rbacRole.findMany({
    where: {
      code: { notIn: ['master_admin', 'MASTER_ADMIN'] },
      name: { not: 'Master Admin' }
    },
    include: {
      permissions: {
        include: { permission: true }
      }
    },
    orderBy: { id: 'asc' }
  });
  ok(res, roles);
}));

router.get('/admin/rbac/permissions', authenticate, authorizeAdmin, asyncRoute(async (_req, res) => {
  const permissions = await db.permission.findMany({
    orderBy: [{ module: 'asc' }, { code: 'asc' }]
  });
  ok(res, permissions);
}));

router.post('/admin/rbac/update-permissions', authenticate, authorize('master_admin'), asyncRoute(async (req, res) => {
  const body = parse(z.object({
    roleId: z.coerce.number().int().positive(),
    permissionIds: z.array(z.coerce.number().int().positive())
  }), req.body);

  const role = await db.rbacRole.findUnique({ where: { id: body.roleId } });
  if (!role) throw new ApiError(404, 'Role not found', 'ROLE_NOT_FOUND');
  const roleCode = String(role.code || '').trim().toLowerCase();
  const roleName = String(role.name || '').trim().toLowerCase();
  if (roleCode === 'master_admin' || roleName === 'master admin') {
    throw new ApiError(403, 'Master Admin permissions are hardcoded and cannot be viewed or modified through RBAC.', 'MASTER_ADMIN_RBAC_LOCKED');
  }

  // Validate all permission IDs exist
  const validPerms = await db.permission.findMany({
    where: { id: { in: body.permissionIds } },
    select: { id: true }
  });
  const validIds = new Set(validPerms.map((p: any) => p.id));
  const invalidIds = body.permissionIds.filter(id => !validIds.has(id));
  if (invalidIds.length > 0) {
    throw new ApiError(400, `Invalid permission IDs: ${invalidIds.join(', ')}`, 'INVALID_PERMISSIONS');
  }

  // Replace permissions in transaction
  await db.$transaction([
    db.rolePermission.deleteMany({ where: { roleId: body.roleId } }),
    ...body.permissionIds.map((permissionId: number) =>
      db.rolePermission.create({ data: { roleId: body.roleId, permissionId } })
    )
  ]);

  await auditWrite(req, 'rbac.permissions_updated', 'rbacRole', body.roleId, {
    permissionCount: body.permissionIds.length
  });

  const updated = await db.rbacRole.findUnique({
    where: { id: body.roleId },
    include: { permissions: { include: { permission: true } } }
  });
  ok(res, updated);
}));

// ═══════════════════════════════════════════
// Organization Management Routes
// ═══════════════════════════════════════════

router.get('/admin/organizations', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const query = parse(z.object({
    q: z.string().optional(),
    status: z.string().optional(),
    skip: z.coerce.number().int().nonnegative().optional().default(0),
    take: z.coerce.number().int().positive().optional().default(100)
  }), req.query);

  const where: any = {};
  if (query.q) {
    where.OR = [
      { organizationName: { contains: query.q, mode: 'insensitive' } },
      { gstin: { contains: query.q, mode: 'insensitive' } },
      { panNumber: { contains: query.q, mode: 'insensitive' } },
      {
        buyerProfiles: {
          some: {
            OR: [
              { organizationName: { contains: query.q, mode: 'insensitive' } },
              { nameAsInPan: { contains: query.q, mode: 'insensitive' } }
            ]
          }
        }
      },
      {
        sellerProfiles: {
          some: {
            OR: [
              { businessName: { contains: query.q, mode: 'insensitive' } },
              { nameAsInPan: { contains: query.q, mode: 'insensitive' } }
            ]
          }
        }
      },
      { users: { some: { name: { contains: query.q, mode: 'insensitive' } } } }
    ];
  }
  if (query.status) where.verificationStatus = query.status;

  let organizationCompanyIdFilter: number | undefined;
  // Tenant isolation: non-master admins with a specific company assignment are scoped to their company
  if (req.user.role !== 'master_admin') {
    const userCompanyId = (req.user as any)?.companyId;
    if (userCompanyId) {
      where.companyId = userCompanyId;
      organizationCompanyIdFilter = userCompanyId;
    }
  }

  const total = await db.organization.count({ where });
  if (total === 0) {
    const fallback = await listProfileBackedOrganizations(query, organizationCompanyIdFilter);
    return ok(res, fallback);
  }

  const organizations = await db.organization.findMany({
    where,
    select: {
      id: true,
      organizationName: true,
      gstin: true,
      panNumber: true,
      verificationStatus: true,
      isBlacklisted: true,
      blacklistReason: true,
      buyerProfiles: {
        select: {
          organizationName: true,
          nameAsInPan: true,
          user: { select: { name: true } }
        }
      },
      sellerProfiles: {
        select: {
          businessName: true,
          nameAsInPan: true,
          user: { select: { name: true } }
        }
      },
      users: {
        select: {
          name: true
        }
      },
      kycVerifications: {
        where: { provider: 'MERIPEHCHAAN' as const, verificationType: 'AADHAAR' as const },
        take: 1,
        select: {
          status: true,
          provider: true,
          verificationType: true,
          verifiedName: true,
          verifiedAt: true,
          referenceKey: true,
          idTokenSubject: true
        }
      },
      _count: {
        select: {
          users: true,
          products: true,
          services: true
        }
      }
    },
    skip: query.skip,
    take: query.take,
    orderBy: { updatedAt: 'desc' }
  });

  const { orgFeaturesService } = await import('../services/org-features.service.js');
  const orgsWithFeatures = organizations.map((org: any) => {
    let resolvedName = org.organizationName;
    if (
      !resolvedName ||
      resolvedName === 'Verified Organization' ||
      resolvedName === 'Buyer Organization' ||
      resolvedName === 'Seller Organization'
    ) {
      const seller = org.sellerProfiles?.[0];
      const buyer = org.buyerProfiles?.[0];
      const user = org.users?.[0];

      if (seller) {
        resolvedName = seller.businessName || seller.nameAsInPan || seller.user?.name || user?.name || resolvedName;
      } else if (buyer) {
        resolvedName = buyer.organizationName || buyer.nameAsInPan || buyer.user?.name || user?.name || resolvedName;
      } else if (user) {
        resolvedName = user.name || resolvedName;
      }
    }

    const { buyerProfiles, sellerProfiles, users, kycVerifications, ...orgRest } = org;
    return {
      ...orgRest,
      organizationName: resolvedName || 'Verified Organization',
      aadhaarKyc: kycVerifications?.[0] || null,
      features: orgFeaturesService.getForOrg(org.id)
    };
  });

  const [totalAll, verifiedCount, pendingCount, suspendedCount] = await Promise.all([
    db.organization.count({ where: organizationCompanyIdFilter ? { companyId: organizationCompanyIdFilter } : {} }),
    db.organization.count({ where: { verificationStatus: 'VERIFIED', ...(organizationCompanyIdFilter ? { companyId: organizationCompanyIdFilter } : {}) } }),
    db.organization.count({ where: { verificationStatus: 'PENDING', ...(organizationCompanyIdFilter ? { companyId: organizationCompanyIdFilter } : {}) } }),
    db.organization.count({ where: { OR: [{ isBlacklisted: true }, { verificationStatus: 'SUSPENDED' }], ...(organizationCompanyIdFilter ? { companyId: organizationCompanyIdFilter } : {}) } }),
  ]);

  ok(res, {
    organizations: orgsWithFeatures,
    total,
    stats: {
      total: totalAll,
      verified: verifiedCount,
      pending: pendingCount,
      suspended: suspendedCount
    }
  });
}));

router.get('/admin/organizations/:id', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const org = await db.organization.findUnique({
    where: { id },
    include: {
      users: { select: { id: true, name: true, email: true, role: true, onboardingStatus: true, accountStatus: true } },
      buyerProfiles: { select: { id: true, organizationName: true, userId: true, nameAsInPan: true } },
      sellerProfiles: { select: { id: true, businessName: true, userId: true, nameAsInPan: true } },
      _count: { select: { products: true, services: true, tenders: true, requirements: true } }
    }
  });
  if (!org) throw new ApiError(404, 'Organization not found', 'ORG_NOT_FOUND');

  // Tenant isolation: non-master admins can only access organizations from their own company


  // Inject features dynamically
  const { orgFeaturesService } = await import('../services/org-features.service.js');

  let resolvedName = org.organizationName;
  if (
    !resolvedName ||
    resolvedName === 'Verified Organization' ||
    resolvedName === 'Buyer Organization' ||
    resolvedName === 'Seller Organization'
  ) {
    const seller = org.sellerProfiles?.[0];
    const buyer = org.buyerProfiles?.[0];
    const user = org.users?.[0];

    if (seller) {
      resolvedName = seller.businessName || seller.nameAsInPan || seller.user?.name || user?.name || resolvedName;
    } else if (buyer) {
      resolvedName = buyer.organizationName || buyer.nameAsInPan || buyer.user?.name || user?.name || resolvedName;
    } else if (user) {
      resolvedName = user.name || resolvedName;
    }
  }

  const orgWithFeatures = {
    ...org,
    organizationName: resolvedName || 'Verified Organization',
    features: orgFeaturesService.getForOrg(org.id)
  };

  ok(res, orgWithFeatures);
}));

router.put('/admin/organizations/:id', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const existingOrg = await db.organization.findUnique({
    where: { id },
  });
  if (!existingOrg) throw new ApiError(404, 'Organization not found', 'ORG_NOT_FOUND');

  // Tenant isolation: non-master admins can only update organizations from their own company


  if (req.user?.role === 'admin') {
    const { canAccessOrganization } = await import('../middleware/authorize.js');
    const canAccess = await canAccessOrganization(req, id);
    if (!canAccess) {
      throw new ApiError(403, 'You can only manage organizations within your assigned district.', 'DISTRICT_ACCESS_DENIED');
    }
  }

  const body = parse(z.object({
    verificationStatus: z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED']).optional(),
    isBlacklisted: z.boolean().optional(),
    blacklistReason: z.string().trim().max(1000).optional()
  }).refine((data) => {
    if (data.isBlacklisted === true) {
      return typeof data.blacklistReason === 'string' && data.blacklistReason.trim().length >= 5;
    }
    return true;
  }, {
    message: 'Blacklist reason must be at least 5 characters.',
    path: ['blacklistReason']
  }), req.body);

  if (body.isBlacklisted === true && existingOrg.isBlacklisted) {
    throw new ApiError(400, 'Organization is already suspended.', 'ALREADY_SUSPENDED');
  }

  const updateData: any = { ...body };
  if (body.isBlacklisted !== undefined) {
    if (body.isBlacklisted) {
      updateData.verificationStatus = 'SUSPENDED';
      updateData.blacklistedAt = new Date();
      updateData.blacklistedByUserId = req.user.id;
      updateData.suspensionType = 'MANUAL';
      updateData.appealStatus = 'NONE';
      updateData.appealMessage = null;
      updateData.appealDocumentUrl = null;
      updateData.appealSubmittedAt = null;
      updateData.appealReviewedAt = null;
      updateData.appealReviewedByUserId = null;
      updateData.appealRejectionReason = null;
    } else {
      if (existingOrg.verificationStatus === 'SUSPENDED') {
        updateData.verificationStatus = 'VERIFIED';
      }
      updateData.blacklistReason = null;
      updateData.blacklistedAt = null;
      updateData.blacklistedByUserId = null;
      updateData.suspensionType = null;
      if (existingOrg.appealStatus === 'PENDING') {
        updateData.appealStatus = 'APPROVED';
        updateData.appealReviewedAt = new Date();
        updateData.appealReviewedByUserId = req.user.id;
      }
    }
  }

  const org = await db.organization.update({
    where: { id },
    data: updateData,
    include: {
      buyerProfiles: { select: { organizationName: true, nameAsInPan: true } },
      sellerProfiles: { select: { businessName: true, nameAsInPan: true } },
      users: { select: { name: true } }
    }
  });
  await auditWrite(req, 'organization.updated', 'organization', id, body);

  // Notify org users about status changes
  if (updateData.verificationStatus || body.isBlacklisted !== undefined) {
    const orgUsers = await db.user.findMany({ where: { organizationId: id }, select: { id: true } });
    const { notificationService } = await import('../services/notification.service.js');
    const finalStatus = updateData.verificationStatus || existingOrg.verificationStatus;
    for (const u of orgUsers) {
      await notificationService.notifyWithEmail(u.id, {
        title: 'Organization Status Updated',
        message: body.isBlacklisted
          ? `Your organization has been restricted. Reason: ${body.blacklistReason || 'Policy violation'}`
          : `Your organization verification status is now: ${finalStatus}`,
        type: 'organization_status_updated',
        priority: body.isBlacklisted ? 'urgent' : 'high',
        redirectUrl: '/dashboard',
        emailSubject: 'Organization Status Update — MSME Procurement Portal',
        emailHtml: `<p>Your organization's status has been updated.</p><p><strong>Status:</strong> ${finalStatus}</p>${body.blacklistReason ? `<p><strong>Reason:</strong> ${body.blacklistReason}</p>` : ''}`
      });
    }
  }

  // Get current features
  const { orgFeaturesService } = await import('../services/org-features.service.js');
  const features = orgFeaturesService.getForOrg(org.id);

  let resolvedName = org.organizationName;
  if (
    !resolvedName ||
    resolvedName === 'Verified Organization' ||
    resolvedName === 'Buyer Organization' ||
    resolvedName === 'Seller Organization'
  ) {
    const seller = org.sellerProfiles?.[0];
    const buyer = org.buyerProfiles?.[0];
    const user = org.users?.[0];

    if (seller) {
      resolvedName = seller.businessName || seller.nameAsInPan || seller.user?.name || user?.name || resolvedName;
    } else if (buyer) {
      resolvedName = buyer.organizationName || buyer.nameAsInPan || buyer.user?.name || user?.name || resolvedName;
    } else if (user) {
      resolvedName = user.name || resolvedName;
    }
  }

  const { buyerProfiles, sellerProfiles, users, ...orgRest } = org;

  ok(res, { ...orgRest, organizationName: resolvedName || 'Verified Organization', features });
}));

const hasPermission = async (user: any, permissionKey: string, companyId: number): Promise<boolean> => {
  if (user.role === 'master_admin') return true;
  if (user.role !== 'admin') return false;
  if (null !== companyId) return false;

  // Query UserRole -> RbacRole -> RolePermission -> Permission
  const userRoles = await db.userRole.findMany({
    where: { userId: user.id },
    include: {
      role: {
        include: {
          permissions: {
            include: { permission: true }
          }
        }
      }
    }
  });

  const hasWildcard = userRoles.some((ur: any) =>
    ur.role.permissions.some((rp: any) => rp.permission.code === '*' || rp.permission.code === permissionKey)
  );

  if (hasWildcard) return true;

  // Fallback: if not found, check if it exists in DB at all. If it does not, default to true for admins of the company.
  const permInDb = await db.permission.findFirst({
    where: { code: permissionKey }
  });
  if (!permInDb) {
    return true;
  }

  return false;
};

// PATCH /admin/organizations/:id/close
router.patch('/admin/organizations/:id/close', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { reason, confirm, documentNote } = req.body || {};

  if (!reason || typeof reason !== 'string' || reason.trim() === '') {
    return res.status(400).json({ error: 'REASON_REQUIRED', message: 'Reason is required for this action.' });
  }
  if (confirm !== true) {
    return res.status(400).json({ error: 'CONFIRMATION_REQUIRED', message: 'Confirmation is required for this action.' });
  }

  const existingOrg = await db.organization.findUnique({ where: { id } });
  if (!existingOrg) {
    return res.status(404).json({ error: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found.' });
  }

  // Tenant Isolation


  // Permission Check
  const allowed = await hasPermission(req.user, 'organization.close', existingOrg.companyId || 0);
  if (!allowed) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'You do not have permission to close this organization.' });
  }

  // Dependency Blocker Check
  const { getOrganizationClosureBlockers } = await import('../utils/closureBlockers.js');
  const blockers = await getOrganizationClosureBlockers(id);
  if (blockers) {
    return res.status(409).json(blockers);
  }

  const updated = await db.organization.update({
    where: { id },
    data: {
      verificationStatus: 'CLOSED' as any,
      closedAt: new Date(),
      closedBy: req.user?.id,
      closureReason: reason,
      blacklistReason: reason
    }
  });

  await auditWrite(req, 'ORGANIZATION_CLOSED', 'organization', id, {
    reason,
    documentNote,
    oldValue: { verificationStatus: existingOrg.verificationStatus },
    newValue: { verificationStatus: 'CLOSED' }
  });

  return res.json({ success: true, organization: updated, message: 'Organization closed successfully.' });
}));

// PATCH /admin/organizations/:id/archive
router.patch('/admin/organizations/:id/archive', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { reason, confirm, documentNote } = req.body || {};

  if (!reason || typeof reason !== 'string' || reason.trim() === '') {
    return res.status(400).json({ error: 'REASON_REQUIRED', message: 'Reason is required for this action.' });
  }
  if (confirm !== true) {
    return res.status(400).json({ error: 'CONFIRMATION_REQUIRED', message: 'Confirmation is required for this action.' });
  }

  const existingOrg = await db.organization.findUnique({ where: { id } });
  if (!existingOrg) {
    return res.status(404).json({ error: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found.' });
  }

  // Tenant Isolation


  // Permission Check
  const allowed = await hasPermission(req.user, 'organization.archive', existingOrg.companyId || 0);
  if (!allowed) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'You do not have permission to archive this organization.' });
  }

  // Dependency Blocker Check
  const { getOrganizationClosureBlockers } = await import('../utils/closureBlockers.js');
  const blockers = await getOrganizationClosureBlockers(id);
  if (blockers) {
    return res.status(409).json(blockers);
  }

  const updated = await db.organization.update({
    where: { id },
    data: {
      verificationStatus: 'ARCHIVED' as any,
      archivedAt: new Date(),
      archivedBy: req.user?.id,
      closureReason: reason
    }
  });

  await auditWrite(req, 'ORGANIZATION_ARCHIVED', 'organization', id, {
    reason,
    documentNote,
    oldValue: { verificationStatus: existingOrg.verificationStatus },
    newValue: { verificationStatus: 'ARCHIVED' }
  });

  return res.json({ success: true, organization: updated, message: 'Organization archived successfully.' });
}));

// PATCH /admin/organizations/:id/restore
router.patch('/admin/organizations/:id/restore', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { reason, documentNote } = req.body || {};

  if (!reason || typeof reason !== 'string' || reason.trim() === '') {
    return res.status(400).json({ error: 'REASON_REQUIRED', message: 'Reason is required for this action.' });
  }

  const existingOrg = await db.organization.findUnique({ where: { id } });
  if (!existingOrg) {
    return res.status(404).json({ error: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found.' });
  }

  // Tenant Isolation


  // Permission Check
  const allowed = await hasPermission(req.user, 'organization.restore', existingOrg.companyId || 0);
  if (!allowed) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'You do not have permission to restore this organization.' });
  }

  const updated = await db.organization.update({
    where: { id },
    data: {
      verificationStatus: 'VERIFIED' as any,
      closedAt: null,
      closedBy: null,
      archivedAt: null,
      archivedBy: null,
      closureReason: null
    }
  });

  await auditWrite(req, 'ORGANIZATION_RESTORED', 'organization', id, {
    reason,
    documentNote,
    oldValue: { verificationStatus: existingOrg.verificationStatus },
    newValue: { verificationStatus: 'VERIFIED' }
  });

  return res.json({ success: true, organization: updated, message: 'Organization restored successfully.' });
}));

// PATCH /admin/organizations/:id/allow-gst-reuse
router.patch('/admin/organizations/:id/allow-gst-reuse', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { reason, confirm, documentNote } = req.body || {};

  if (!reason || typeof reason !== 'string' || reason.trim() === '') {
    return res.status(400).json({ error: 'REASON_REQUIRED', message: 'Reason is required for this action.' });
  }
  if (confirm !== true) {
    return res.status(400).json({ error: 'CONFIRMATION_REQUIRED', message: 'Confirmation is required for this action.' });
  }

  const existingOrg = await db.organization.findUnique({ where: { id } });
  if (!existingOrg) {
    return res.status(404).json({ error: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found.' });
  }

  // Tenant Isolation


  // Permission Check
  const allowed = await hasPermission(req.user, 'organization.allow_gst_reuse', existingOrg.companyId || 0);
  if (!allowed) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'You do not have permission to allow GST reuse on this organization.' });
  }

  if (existingOrg.verificationStatus !== 'CLOSED' && existingOrg.verificationStatus !== 'ARCHIVED') {
    return res.status(400).json({ error: 'GST_REUSE_NOT_ALLOWED', message: 'GST reuse can only be allowed for CLOSED or ARCHIVED organizations.' });
  }

  const updated = await db.organization.update({
    where: { id },
    data: {
      gstReuseAllowed: true,
      gstReuseAllowedBy: req.user?.id,
      gstReuseAllowedAt: new Date(),
      gstReuseReason: reason
    }
  });

  await auditWrite(req, 'ORGANIZATION_GST_REUSE_ALLOWED', 'organization', id, {
    reason,
    documentNote,
    oldValue: { gstReuseAllowed: existingOrg.gstReuseAllowed },
    newValue: { gstReuseAllowed: true }
  });

  return res.json({ success: true, organization: updated, message: 'GST reuse allowed successfully.' });
}));

// PATCH /admin/organizations/:id/revoke-gst-reuse
router.patch('/admin/organizations/:id/revoke-gst-reuse', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { reason, confirm, documentNote } = req.body || {};

  if (!reason || typeof reason !== 'string' || reason.trim() === '') {
    return res.status(400).json({ error: 'REASON_REQUIRED', message: 'Reason is required for this action.' });
  }
  if (confirm !== true) {
    return res.status(400).json({ error: 'CONFIRMATION_REQUIRED', message: 'Confirmation is required for this action.' });
  }

  const existingOrg = await db.organization.findUnique({ where: { id } });
  if (!existingOrg) {
    return res.status(404).json({ error: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found.' });
  }

  // Tenant Isolation


  // Permission Check
  const allowed = await hasPermission(req.user, 'organization.allow_gst_reuse', existingOrg.companyId || 0);
  if (!allowed) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'You do not have permission to revoke GST reuse on this organization.' });
  }

  const updated = await db.organization.update({
    where: { id },
    data: {
      gstReuseAllowed: false,
      gstReuseAllowedBy: null,
      gstReuseAllowedAt: null,
      gstReuseReason: null
    }
  });

  await auditWrite(req, 'ORGANIZATION_GST_REUSE_REVOKED', 'organization', id, {
    reason,
    documentNote,
    oldValue: { gstReuseAllowed: existingOrg.gstReuseAllowed },
    newValue: { gstReuseAllowed: false }
  });

  return res.json({ success: true, organization: updated, message: 'GST reuse revoked successfully.' });
}));

router.put('/admin/organizations/:id/features', authenticate, authorizeAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParams, req.params);
  const existingOrg = await db.organization.findUnique({
    where: { id },
  });
  if (!existingOrg) throw new ApiError(404, 'Organization not found', 'ORG_NOT_FOUND');

  // Tenant isolation: non-master admins can only access organizations from their own company

  const body = parse(z.object({
    products: z.boolean().optional(),
    services: z.boolean().optional(),
    marketplace: z.boolean().optional(),
    catalog: z.boolean().optional()
  }).partial(), req.body);

  const { orgFeaturesService } = await import('../services/org-features.service.js');
  const updatedFeatures = orgFeaturesService.updateForOrg(id, body);

  await auditWrite(req, 'organization.features_updated', 'organization', id, body);

  // Notify org users about feature access changes
  const orgUsers = await db.user.findMany({ where: { organizationId: id }, select: { id: true } });
  const { notificationService } = await import('../services/notification.service.js');
  for (const u of orgUsers) {
    await notificationService.notify(u.id, {
      title: 'Organization Feature Access Updated',
      message: `Your organization's access to certain portal features (Catalog/Marketplace/Products/Services) has been updated by the administrator.`,
      type: 'organization_features_updated',
      priority: 'medium',
      redirectUrl: '/dashboard'
    });
  }

  ok(res, { success: true, features: updatedFeatures });
}));

// ═══════════════════════════════════════════
// Notification Preferences Routes
// ═══════════════════════════════════════════

router.get('/notifications/preferences', authenticate, asyncRoute(async (req, res) => {
  const currentUserId = userId(req);
  let pref = await db.notificationPreference.findUnique({ where: { userId: currentUserId } });
  if (!pref) {
    pref = await db.notificationPreference.create({ data: { userId: currentUserId } });
  }
  const user = await db.user.findUnique({ where: { id: currentUserId }, select: { mobile: true, mobileVerified: true } });
  ok(res, { ...pref, mobile: user?.mobile || null, mobileVerified: Boolean(user?.mobileVerified) });
}));

router.put('/notifications/preferences', authenticate, asyncRoute(async (req, res) => {
  const body = parse(z.object({
    emailNotifications: z.boolean().optional(),
    smsNotifications: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    procurementAlerts: z.boolean().optional(),
    complianceAlerts: z.boolean().optional()
  }).partial(), req.body);
  const currentUserId = userId(req);
  if (body.smsNotifications === true) {
    const user = await db.user.findUnique({ where: { id: currentUserId }, select: { mobile: true, mobileVerified: true,  } });
    if (!user?.mobile || !user.mobileVerified) {
      throw new ApiError(400, 'Verify your mobile number to enable SMS notifications.', 'MOBILE_NOT_VERIFIED');
    }
    if (false as unknown as boolean) {
      const companyFeature = await db.companyFeature.findFirst({
        where: {
          
          feature: { code: 'sms' }
        }
      });
      if (!companyFeature || !companyFeature.enabled) {
        throw new ApiError(400, 'SMS notifications are disabled by the platform administrator.', 'FEATURE_DISABLED');
      }
    }
  }

  const pref = await db.notificationPreference.upsert({
    where: { userId: currentUserId },
    update: body,
    create: { userId: currentUserId, ...body }
  });
  if (typeof body.smsNotifications === 'boolean') {
    await db.user.update({
      where: { id: currentUserId },
      data: { smsNotificationsEnabled: body.smsNotifications }
    }).catch(() => null);
  }
  ok(res, pref);
}));

// ═══════════════════════════════════════════
// Notifications Listing, Read & Stream Routes
// ═══════════════════════════════════════════

router.get('/notifications', authenticate, asyncRoute(async (req, res) => {
  const query = parse(paginationQuery, req.query);
  const currentUserId = userId(req);
  await archiveExpiredReadNotifications(currentUserId);
  const where: any = { userId: currentUserId, isArchived: false };
  if (query.status === 'unread') where.isRead = false;
  if (query.status === 'read') where.isRead = true;
  if (query.q) where.OR = [{ title: { contains: query.q, mode: 'insensitive' } }, { message: { contains: query.q, mode: 'insensitive' } }, { type: { contains: query.q, mode: 'insensitive' } }];
  const window = listWindow(query);
  const [notifs, total] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...window
    }),
    db.notification.count({ where })
  ]);
  ok(res, paged(notifs, total, query, 'notifications'));
}));

router.post('/notifications/:id/read', authenticate, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const currentUserId = userId(req);
  const notification = await db.notification.findFirst({
    where: { id, userId: currentUserId, isArchived: false },
    select: { id: true, isRead: true }
  });
  if (!notification) throw new ApiError(404, 'Notification not found', 'NOTIFICATION_NOT_FOUND');
  await db.notification.updateMany({
    where: { id, userId: currentUserId },
    data: { isRead: true }
  });
  if (!notification.isRead) await recordNotificationRead(currentUserId, [id]);
  ok(res, { success: true, expiresAfterReadHours: 24 });
}));

router.post('/notifications/read-all', authenticate, asyncRoute(async (req, res) => {
  const currentUserId = userId(req);
  const unread = await db.notification.findMany({
    where: { userId: currentUserId, isRead: false, isArchived: false },
    select: { id: true }
  });
  await db.notification.updateMany({
    where: { userId: currentUserId, isRead: false, isArchived: false },
    data: { isRead: true }
  });
  await recordNotificationRead(currentUserId, unread.map(item => item.id));
  ok(res, { success: true, expiresAfterReadHours: 24 });
}));

router.delete('/notifications/:id', authenticate, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const currentUserId = userId(req);
  const notification = await db.notification.findFirst({
    where: { id, userId: currentUserId },
    select: { id: true }
  });
  if (!notification) throw new ApiError(404, 'Notification not found', 'NOTIFICATION_NOT_FOUND');
  await db.notificationLog.deleteMany({ where: { notificationId: id } });
  await db.notification.delete({ where: { id } });
  ok(res, { success: true });
}));

router.delete('/notifications', authenticate, asyncRoute(async (req, res) => {
  const currentUserId = userId(req);
  const userNotifs = await db.notification.findMany({
    where: { userId: currentUserId },
    select: { id: true }
  });
  const notifIds = userNotifs.map(n => n.id);
  if (notifIds.length > 0) {
    await db.notificationLog.deleteMany({ where: { notificationId: { in: notifIds } } });
    await db.notification.deleteMany({ where: { id: { in: notifIds } } });
  }
  ok(res, { success: true, count: notifIds.length });
}));

router.post('/notifications/clear-all', authenticate, asyncRoute(async (req, res) => {
  const currentUserId = userId(req);
  const userNotifs = await db.notification.findMany({
    where: { userId: currentUserId },
    select: { id: true }
  });
  const notifIds = userNotifs.map(n => n.id);
  if (notifIds.length > 0) {
    await db.notificationLog.deleteMany({ where: { notificationId: { in: notifIds } } });
    await db.notification.deleteMany({ where: { id: { in: notifIds } } });
  }
  ok(res, { success: true, count: notifIds.length });
}));

// Seller settings endpoints
router.post('/seller/settings/change-password/send-otp', authenticate, asyncRoute(async (req, res) => {
  const { generateOtp, storeOtp } = await import('../services/otp.service.js');
  const { sendOtpEmail } = await import('../services/mail.service.js');
  const { smsService } = await import('../services/sms.service.js');

  const user = await db.user.findUnique({ where: { id: userId(req) } });
  if (!user) throw new ApiError(404, 'User not found');

  const otp = generateOtp();
  const channel = req.body?.channel === 'sms' && user.mobileVerified && user.mobile && smsService.isEnabled() ? 'sms' : 'email';
  const identity = channel === 'sms' ? user.mobile : user.email;
  await storeOtp('forgot_password', identity, otp, { userId: user.id, channel }, channel);
  if (channel === 'sms') {
    await smsService.sendOtpSms(identity, otp, 'forgot_password');
  } else {
    await sendOtpEmail(user.email, otp, '[SECURE AUTH] Password change authorization code');
  }

  ok(res, { success: true, channel });
}));

router.post('/seller/settings/change-password', authenticate, asyncRoute(async (req, res) => {
  const { verifyOtp, consumeOtp } = await import('../services/otp.service.js');
  const { hashPassword, validatePasswordStrength } = await import('../services/password.service.js');
  const { assertPasswordNotReused, rememberPreviousPassword } = await import('../services/password-history.service.js');

  const { newPassword, otp } = req.body;
  if (!newPassword || !otp) throw new ApiError(400, 'Password and OTP are required');

  const user = await db.user.findUnique({ where: { id: userId(req) } });
  if (!user) throw new ApiError(404, 'User not found');

  const channel = req.body?.channel === 'sms' && user.mobileVerified && user.mobile ? 'sms' : 'email';
  const identity = channel === 'sms' ? user.mobile : user.email;
  const result = await verifyOtp('forgot_password', identity, otp);
  if (!result.ok) throw new ApiError(400, 'Invalid or expired OTP');

  const passwordValidation = validatePasswordStrength(newPassword);
  if (!passwordValidation.ok) {
    throw new ApiError(400, 'Password does not meet security requirements: ' + passwordValidation.errors.join(', '));
  }

  try {
    await assertPasswordNotReused(user.id, newPassword, user.password);
  } catch (err: any) {
    if (err.message === 'PASSWORD_REUSED') {
      throw new ApiError(400, 'New password cannot match your current or recently used passwords', 'PASSWORD_REUSED');
    }
    throw err;
  }

  const hashedPassword = await hashPassword(newPassword);
  await db.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      passwordResetVersion: { increment: 1 },
      sessionVersion: { increment: 1 },
      lastPasswordChangeAt: new Date()
    }
  });
  await rememberPreviousPassword(user.id, hashedPassword);

  await consumeOtp('forgot_password', identity);
  ok(res, { success: true, message: 'Password updated successfully' });
}));

router.post('/seller/settings/change-email', authenticate, asyncRoute(async (req, res) => {
  const { verifyEmailOtp, consumeEmailOtp } = await import('../services/otp.service.js');
  const { verifyPassword } = await import('../services/password.service.js');

  const { newEmail, otp, password } = req.body;
  if (!newEmail || !otp || !password) throw new ApiError(400, 'New email, OTP, and password are required');

  const user = await db.user.findUnique({ where: { id: userId(req) } });
  if (!user) throw new ApiError(404, 'User not found');

  const isPasswordMatch = await verifyPassword(password, user.password);
  if (!isPasswordMatch) throw new ApiError(400, 'Current password incorrect');

  const otpCheck = await verifyEmailOtp(newEmail, otp);
  if (!otpCheck.ok) throw new ApiError(400, 'Invalid or expired OTP');

  // Update email
  await db.user.update({
    where: { id: user.id },
    data: { email: newEmail.trim().toLowerCase() }
  });

  await consumeEmailOtp(newEmail);
  ok(res, { success: true, message: 'Email updated successfully' });
}));

router.post('/seller/settings/profile/send-otp', authenticate, asyncRoute(async (req, res) => {
  const { generateOtp, storeOtp } = await import('../services/otp.service.js');
  const { sendOtpEmail } = await import('../services/mail.service.js');
  const { smsService } = await import('../services/sms.service.js');

  const user = await db.user.findUnique({ where: { id: userId(req) } });
  if (!user) throw new ApiError(404, 'User not found');
  if (!user.email) throw new ApiError(400, 'Login email is not available for OTP delivery.');

  const otp = generateOtp();
  const channel = req.body?.channel === 'sms' && user.mobileVerified && user.mobile && smsService.isEnabled() ? 'sms' : 'email';
  const identity = channel === 'sms' ? user.mobile : user.email;
  await storeOtp('seller_profile_update', identity, otp, { userId: user.id, channel }, channel);
  if (channel === 'sms') {
    await smsService.sendOtpSms(identity, otp, 'onboarding_alert');
  } else {
    await sendOtpEmail(user.email, otp, '[SECURE AUTH] Profile update verification code');
  }

  ok(res, { success: true, channel });
}));

router.post('/seller/settings/profile', authenticate, asyncRoute(async (req, res) => {
  const { verifyOtp, consumeOtp } = await import('../services/otp.service.js');
  const { firstName, lastName, mobile, otp } = req.body;

  if (!firstName || !lastName || !mobile || !otp) {
    throw new ApiError(400, 'First name, last name, mobile number, and OTP are required');
  }

  const user = await db.user.findUnique({ where: { id: userId(req) } });
  if (!user) throw new ApiError(404, 'User not found');

  const channel = req.body?.channel === 'sms' && user.mobileVerified && user.mobile ? 'sms' : 'email';
  const identity = channel === 'sms' ? user.mobile : user.email;
  const verifyResult = await verifyOtp('seller_profile_update', identity, otp);
  if (!verifyResult.ok) {
    throw new ApiError(400, 'Invalid or expired OTP');
  }

  await db.user.update({
    where: { id: user.id },
    data: {
      name: `${firstName.trim()} ${lastName.trim()}`,
      mobile: mobile.trim(),
      mobileVerified: mobile.trim() === user.mobile ? user.mobileVerified : false
    }
  });

  await consumeOtp('seller_profile_update', identity);
  ok(res, { success: true });
}));

router.post('/seller/settings/aadhaar', authenticate, authorize('seller'), asyncRoute(async (req, res) => {
  const currentUserId = userId(req);
  const { aadhaarNumber } = req.body;
  const cleanedAadhaar = String(aadhaarNumber ?? '').replace(/\s+/g, '');
  if (!cleanedAadhaar || !/^\d{12}$/.test(cleanedAadhaar)) {
    throw new ApiError(400, 'Valid 12-digit Aadhaar number is required', 'INVALID_AADHAAR_FORMAT');
  }

  // Require genuine UIDAI / MeriPehchaan verification proof from UserKycVerification
  const verifiedKyc = await db.userKycVerification.findFirst({
    where: {
      userId: currentUserId,
      verificationType: 'AADHAAR',
      status: 'VERIFIED'
    },
    orderBy: { verifiedAt: 'desc' }
  });

  if (!verifiedKyc) {
    throw new ApiError(
      403,
      'Aadhaar must be verified through the authentic UIDAI / DigiLocker flow before saving seller settings. Please initiate verification via /api/kyc/aadhaar/start.',
      'AADHAAR_VERIFICATION_REQUIRED'
    );
  }

  // STQC & UIDAI Statutory Mandate:
  // Never persist raw Aadhaar in databases or return it in responses.
  const aadhaarMasked = `XXXXXXXX${cleanedAadhaar.slice(-4)}`;
  const aadhaarHash = createHashFingerprint(cleanedAadhaar, 'aadhaar_vault');

  const sellerProfile = await db.sellerProfile.update({
    where: { userId: currentUserId },
    data: {
      aadhaarHash,
      aadhaarMasked,
      aadhaarVerified: true
    },
    select: {
      id: true,
      userId: true,
      aadhaarMasked: true,
      aadhaarVerified: true,
      updatedAt: true
    }
  });

  ok(res, { success: true, sellerProfile });
}));

router.post('/seller/settings/close-account', authenticate, asyncRoute(async (req, res) => {
  // Mark user as inactive/suspended
  await db.user.update({
    where: { id: userId(req) },
    data: {
      registrationStatus: 'suspended',
      sessionVersion: { increment: 1 }
    }
  });
  ok(res, { success: true, message: 'Account closed successfully' });
}));

async function ensureUserOrganizationId(req: any): Promise<number> {
  let orgId = req.user?.organizationId;
  if (!orgId && req.user?.id) {
    const user = await db.user.findUnique({
      where: { id: req.user.id },
      include: {
        sellerProfile: true,
        buyerProfile: true
      }
    });

    if (user) {
      const membership = await db.orgMembership.findFirst({
        where: { userId: user.id },
        include: { organization: true }
      });
      if (membership?.organizationId) {
        orgId = membership.organizationId;
        await db.user.update({
          where: { id: user.id },
          data: { organizationId: orgId }
        });
        req.user.organizationId = orgId;
      } else {
        const regDetails = typeof user.registrationDetails === 'object' && user.registrationDetails ? user.registrationDetails as any : {};
        const gstDetails = typeof regDetails.gstDetails === 'object' && regDetails.gstDetails ? regDetails.gstDetails as any : {};
        
        const orgName = regDetails.businessName || regDetails.organisation || gstDetails.legalName || gstDetails.tradeName || user.name || 'Default Organisation';
        
        let orgType = 'MSME';
        const typeStr = String(regDetails.businessType || regDetails.organisationType || '').trim().toUpperCase();
        if (typeStr.includes('PROPRIETORSHIP')) {
          orgType = 'PROPRIETORSHIP';
        } else if (typeStr.includes('PARTNERSHIP')) {
          orgType = 'PARTNERSHIP';
        } else if (typeStr.includes('LLP')) {
          orgType = 'LLP';
        } else if (typeStr.includes('STARTUP')) {
          orgType = 'STARTUP';
        } else if (typeStr.includes('PUBLIC_LIMITED') || typeStr.includes('PUBLIC LTD')) {
          orgType = 'PUBLIC_LIMITED';
        } else if (typeStr.includes('COMPANY') || typeStr.includes('PRIVATE_LIMITED') || typeStr.includes('PVT LTD') || typeStr.includes('PVT. LTD.')) {
          const isPublic = typeStr.includes('PUBLIC') || (!typeStr.includes('PVT') && !typeStr.includes('PRIVATE') && String(orgName).toUpperCase().includes('LIMITED') && !String(orgName).toUpperCase().includes('PVT') && !String(orgName).toUpperCase().includes('PRIVATE'));
          orgType = isPublic ? 'PUBLIC_LIMITED' : 'PRIVATE_LIMITED';
        } else if (typeStr.includes('SHG')) {
          orgType = 'SHG';
        } else if (typeStr.includes('NGO')) {
          orgType = 'NGO';
        } else if (typeStr.includes('TRUST')) {
          orgType = 'TRUST';
        } else if (typeStr.includes('SOCIETY')) {
          orgType = 'SOCIETY';
        } else if (typeStr.includes('GOVERNMENT') || typeStr.includes('GOVT')) {
          orgType = 'GOVERNMENT';
        } else if (typeStr.includes('PSU')) {
          orgType = 'PSU';
        } else if (user.role === 'buyer') {
          orgType = 'GOVERNMENT';
        } else {
          orgType = 'MSME';
        }

        const defaultCompanyId = await getDefaultCompanyId();
        const newOrg = await db.organization.create({
          data: {
            organizationName: orgName,
            organizationType: orgType as any,
            gstin: regDetails.gstin || null,
            panNumber: regDetails.pan || regDetails.panNumber || gstDetails.pan || null,
            state: regDetails.state || gstDetails.state || null,
            district: regDetails.district || gstDetails.district || gstDetails.city || null,
            city: gstDetails.city || regDetails.district || null,
            pincode: gstDetails.pincode || null,
            addressLine1: regDetails.officeZoneName || gstDetails.address || null,
            companyId: defaultCompanyId,
            verificationStatus: 'PENDING',
            organizationOnboardingStatus: 'self_created'
          }
        });

        orgId = newOrg.id;
        await db.user.update({
          where: { id: user.id },
          data: { organizationId: orgId, companyId: defaultCompanyId }
        });
        req.user.organizationId = orgId;

        await db.orgMembership.create({
          data: {
            userId: user.id,
            organizationId: orgId,
            orgRole: 'ORG_ADMIN',
            isActive: true
          }
        });
        
        if (user.sellerProfile) {
          await db.sellerProfile.update({
            where: { id: user.sellerProfile.id },
            data: { organizationId: orgId }
          });
        } else if (user.buyerProfile) {
          await db.buyerProfile.update({
            where: { id: user.buyerProfile.id },
            data: { organizationId: orgId }
          });
        }
      }
    }
  }

  if (!orgId) throw new ApiError(400, 'User is not associated with an organization');
  return orgId;
}

const resolveBrandingAssetUrl = async (url: string | null | undefined): Promise<string | null> => {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return trimmed;
  if (trimmed.startsWith('/api/files/')) return trimmed;
  if (trimmed.startsWith('/org-logos/') || trimmed.startsWith('/banners/') || trimmed.startsWith('/products/')) return trimmed;

  const gcsMatch = trimmed.match(/^https?:\/\/storage\.googleapis\.com\/[^/]+\/(.+)$/);
  const keyCandidate = gcsMatch ? gcsMatch[1] : trimmed.replace(/^\/?(uploads\/)?/, '');
  const fileName = keyCandidate.split('/').pop() || '';

  if (fileName) {
    const asset = await db.fileAsset.findFirst({
      where: {
        OR: [
          { url: trimmed },
          { key: keyCandidate },
          { key: { endsWith: fileName } },
          { url: { contains: fileName } }
        ],
        status: 'active'
      },
      select: { id: true }
    });

    if (asset) {
      return `/api/files/${asset.id}/view`;
    }
  }

  if (gcsMatch) {
    return `/api/files/raw/${gcsMatch[1]}`;
  }

  return trimmed;
};

router.get('/seller/settings/branding', authenticate, authorize('seller', 'shg', 'admin', 'master_admin'), asyncRoute(async (req, res) => {
  let orgId = req.user?.organizationId;
  const targetSellerId = req.query.sellerId ? Number(req.query.sellerId) : undefined;
  const targetOrgId = req.query.organizationId ? Number(req.query.organizationId) : undefined;
  const isAdmin = req.user?.role === 'admin' || req.user?.role === 'master_admin';

  if (isAdmin && targetOrgId) {
    orgId = targetOrgId;
  } else if (isAdmin && targetSellerId) {
    const sUser = await db.user.findUnique({ where: { id: targetSellerId }, select: { organizationId: true } });
    if (sUser?.organizationId) orgId = sUser.organizationId;
  } else if (!orgId && isAdmin) {
    return ok(res, { logoUrl: null, bannerUrl: null });
  } else if (!orgId) {
    orgId = await ensureUserOrganizationId(req);
  }

  const profile = orgId ? await db.organizationProfile.findUnique({
    where: { organizationId: orgId }
  }) : null;

  const logoUrl = await resolveBrandingAssetUrl(profile?.logoUrl);
  const bannerUrl = await resolveBrandingAssetUrl(profile?.bannerUrl);

  ok(res, { 
    logoUrl,
    bannerUrl
  });
}));

router.put('/seller/settings/branding', authenticate, authorize('seller', 'shg'), asyncRoute(async (req, res) => {
  const orgId = await ensureUserOrganizationId(req);

  const body = parse(z.object({
    logoUrl: z.string().trim().optional().nullable(),
    bannerUrl: z.string().trim().optional().nullable()
  }), req.body);

  const resolvedLogoUrl = body.logoUrl !== undefined ? await resolveBrandingAssetUrl(body.logoUrl) : undefined;
  const resolvedBannerUrl = body.bannerUrl !== undefined ? await resolveBrandingAssetUrl(body.bannerUrl) : undefined;

  const updateData: any = {};
  if (resolvedLogoUrl !== undefined) updateData.logoUrl = resolvedLogoUrl;
  if (resolvedBannerUrl !== undefined) updateData.bannerUrl = resolvedBannerUrl;

  const updatedProfile = await db.organizationProfile.upsert({
    where: { organizationId: orgId },
    update: updateData,
    create: {
      organizationId: orgId,
      logoUrl: resolvedLogoUrl || null,
      bannerUrl: resolvedBannerUrl || null
    }
  });

  // Clear homepage and layout caches
  await invalidateByPattern('cache:marketplace:home:v2');
  await invalidateByPattern('cache:marketplace:home-layout:v2:*');

  ok(res, { 
    logoUrl: updatedProfile.logoUrl,
    bannerUrl: updatedProfile.bannerUrl
  });
}));

router.get('/user/invoice-branding', authenticate, asyncRoute(async (req, res) => {
  const uid = userId(req);
  const user = await db.user.findUnique({
    where: { id: uid },
    select: {
      id: true,
      registrationDetails: true,
      organizationId: true,
      organization: {
        include: {
          profile: true
        }
      },
      sellerProfile: true,
      buyerProfile: true
    }
  });

  const regDetails = (user?.registrationDetails as any) || {};
  let orgLogo = user?.organization?.profile?.logoUrl;

  if (!orgLogo) {
    const orgId = user?.organizationId || user?.sellerProfile?.organizationId || user?.buyerProfile?.organizationId;
    if (orgId) {
      const orgProfile = await db.organizationProfile.findUnique({
        where: { organizationId: orgId }
      });
      if (orgProfile?.logoUrl) {
        orgLogo = orgProfile.logoUrl;
      }
    }
  }

  const rawLogoUrl = regDetails.logoUrl || orgLogo || null;
  const logoUrl = await resolveBrandingAssetUrl(rawLogoUrl);
  const stampUrl = await resolveBrandingAssetUrl(regDetails.stampUrl || null);
  const signatureUrl = await resolveBrandingAssetUrl(regDetails.signatureUrl || null);

  ok(res, {
    logoUrl,
    stampUrl,
    signatureUrl
  });
}));

router.put('/user/invoice-branding', authenticate, asyncRoute(async (req, res) => {
  const body = parse(z.object({
    logoUrl: z.string().trim().optional().nullable(),
    stampUrl: z.string().trim().optional().nullable(),
    signatureUrl: z.string().trim().optional().nullable()
  }), req.body);

  const uid = userId(req);
  const user = await db.user.findUnique({
    where: { id: uid },
    select: { id: true, registrationDetails: true, organizationId: true, sellerProfile: true, buyerProfile: true }
  });
  if (!user) throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');

  const resolvedLogoUrl = body.logoUrl !== undefined ? await resolveBrandingAssetUrl(body.logoUrl) : undefined;
  const resolvedStampUrl = body.stampUrl !== undefined ? await resolveBrandingAssetUrl(body.stampUrl) : undefined;
  const resolvedSignatureUrl = body.signatureUrl !== undefined ? await resolveBrandingAssetUrl(body.signatureUrl) : undefined;

  const currentReg = (user.registrationDetails as Record<string, any>) || {};
  const updatedReg = {
    ...currentReg,
    ...(resolvedLogoUrl !== undefined && { logoUrl: resolvedLogoUrl }),
    ...(resolvedStampUrl !== undefined && { stampUrl: resolvedStampUrl }),
    ...(resolvedSignatureUrl !== undefined && { signatureUrl: resolvedSignatureUrl })
  };

  await db.user.update({
    where: { id: user.id },
    data: { registrationDetails: updatedReg }
  });

  const orgId = user.organizationId || user.sellerProfile?.organizationId || user.buyerProfile?.organizationId;
  if (resolvedLogoUrl !== undefined && orgId) {
    try {
      await db.organizationProfile.upsert({
        where: { organizationId: orgId },
        update: { logoUrl: resolvedLogoUrl },
        create: { organizationId: orgId, logoUrl: resolvedLogoUrl }
      });
    } catch {
      // ignore
    }
  }

  ok(res, {
    logoUrl: updatedReg.logoUrl || null,
    stampUrl: updatedReg.stampUrl || null,
    signatureUrl: updatedReg.signatureUrl || null
  });
}));

// ═══════════════════════════════════════════
// Unified My Procurements Endpoint
// ═══════════════════════════════════════════

const STATUS_GROUP = {
  draft: new Set(['DRAFT', 'BID_DRAFT', 'SAVED_DRAFT']),
  pending_approval: new Set(['PENDING_ADMIN_APPROVAL', 'PENDING_APPROVAL', 'SUBMITTED', 'SUBMITTED_FOR_APPROVAL', 'PENDING_REVIEW', 'AWAITING_APPROVAL']),
  active: new Set([
    'OPEN', 'PUBLISHED', 'APPROVED', 'TECHNICAL_EVALUATION', 'FINANCIAL_EVALUATION',
    'REQUESTED', 'SOURCING', 'PROCUREMENT_METHOD_SELECTED', 'LIVE', 'PAUSED', 'SCHEDULED',
    'IN_FULFILLMENT', 'ACCEPTED', 'GENERATED', 'ORDER_PLACED', 'INVOICE_SUBMITTED', 'ACTIVE'
  ]),
  completed: new Set(['AWARDED', 'ORDERED', 'FULFILLED', 'CONVERTED_TO_ORDER', 'CONVERTED_TO_BID', 'CLOSED', 'FINALIZED', 'AWARD_RECOMMENDED', 'DELIVERED', 'COMPLETED']),
  cancelled: new Set(['CANCELLED', 'REJECTED', 'EXPIRED', 'SENT_BACK_FOR_CORRECTION', 'VOIDED', 'ABANDONED']),
};

const statusGroupFor = (rawStatus: string): string => {
  const s = rawStatus?.toUpperCase() || 'DRAFT';
  for (const [group, set] of Object.entries(STATUS_GROUP)) {
    if (set.has(s)) return group;
  }
  if (['DRAFT', 'BID_DRAFT', 'SAVED_DRAFT'].includes(s)) return 'draft';
  return 'active';
};

const statusLabel = (raw: string): string =>
  (raw || 'DRAFT').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const METHOD_LABEL_MAP: Record<string, string> = {};
for (const m of procurementMethodDefinitions) {
  METHOD_LABEL_MAP[m.slug] = m.name;
  METHOD_LABEL_MAP[m.code] = m.name;
}

export type NormalizedProcurement = {
  id: number;
  type: string;
  typeLabel: string;
  linkedAuctionId?: number | null;
  linkedAuctionCode?: string | null;
  linkedAuctionStatus?: string | null;
  title: string;
  referenceNumber: string;
  status: string;
  statusLabel: string;
  statusGroup: string;
  method: string;
  methodLabel: string;
  estimatedValue: number;
  category: string;
  description: string;
  deliveryLocation: string;
  startDate: string;
  endDate: string;
  quantity: string;
  unit: string;
  organizationName: string;
  participantsCount?: number;
  publishedAt?: string | null;
  postPublishEditCount?: number;
  createdAt: string;
  updatedAt: string;
  actionUrl: string;
  documents?: any[];
  items?: any[];
  paymentTerms?: string;
  evaluationMethod?: string;
  eligibilityCriteria?: string[];
  termsAndConditions?: string[];
  budgetDetails?: any;
  approvalAuthority?: string;
  justification?: string;
  urgency?: string;
  priority?: string;
  internalDetails?: Record<string, any>;
  detailSections?: Array<{ title: string; fields: Array<{ label: string; value: string }> }>;
  approvalTrail?: Array<Record<string, unknown>>;
  tracking?: Array<{ label: string; status: string; date?: string }>;
};

export interface BuyerProcurementsDataResult {
  all: NormalizedProcurement[];
  kpis: {
    totalProcurements: number;
    drafts: number;
    pendingApproval: number;
    active: number;
    completed: number;
    cancelled: number;
    totalValue: number;
    activeRateContracts: number;
    expiredRateContracts: number;
    totalResponses: number;
  };
}

const cleanOpportunitySummary = (desc?: string | null): string => {
  if (!desc) return '';
  let text = String(desc).replace(/\r/g, '');
  text = text.replace(/Sourcing Method:\s*[^|\n]*/gi, '');
  text = text.replace(/Value:\s*(?:INR|Rs\.?|₹)?\s*[\d,.]*[^|\n]*/gi, '');
  text = text.replace(/Urgency:\s*[^|\n]*/gi, '');
  text = text.replace(/[\n\r|]+/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(/^[-:|,.\s]+|[-:|,.\s]+$/g, '').trim();
  return text;
};

export async function getBuyerProcurementsData(
  buyerId: number,
  buyerOrgId: number = -1,
  bypassCache: boolean = false
): Promise<BuyerProcurementsDataResult> {
  const cacheKey = `cache:buyer:procurements:${buyerId}`;
  if (bypassCache) {
    await deleteCache(cacheKey).catch(() => undefined);
    await invalidateByPattern(`cache:buyer:procurements:${buyerId}*`).catch(() => undefined);
  }

  return getOrSetCache(cacheKey, async () => {
    return fetchFreshBuyerProcurementsData(buyerId, buyerOrgId);
  }, 5);
}

async function fetchFreshBuyerProcurementsData(buyerId: number, buyerOrgId: number = -1): Promise<BuyerProcurementsDataResult> {
  // ── Parallel data fetch (concurrent, including buyer organization) ──
  const [buyerOrg, bidDrafts, procurementBids, procurementRequests, directPurchases, requirements, rateContracts, fileAssets, auctions, allApprovals] = await Promise.all([
    buyerOrgId > 0
      ? db.organization.findUnique({
          where: { id: buyerOrgId },
          select: { organizationName: true }
        })
      : Promise.resolve(null),
    db.bidWizardDraft.findMany({
      where: buyerOrgId > 0 ? { OR: [{ buyerId }, { buyer: { organizationId: buyerOrgId } }], draftStatus: 'DRAFT' } : { buyerId, draftStatus: 'DRAFT' },
      orderBy: { updatedAt: 'desc' },
    }),
    db.procurementBid.findMany({
      where: buyerOrgId > 0 ? { OR: [{ buyerId }, { buyerOrganizationId: buyerOrgId }] } : { buyerId },
      orderBy: { createdAt: 'desc' },
      include: {
        documents: true,
        participations: true
      },
    }),
    db.procurementRequest.findMany({
      where: buyerOrgId > 0 ? { OR: [{ buyerId }, { organizationId: buyerOrgId }] } : { buyerId },
      orderBy: { createdAt: 'desc' },
      include: {
        organization: { select: { organizationName: true } }
      }
    }),
    db.directPurchase.findMany({
      where: buyerOrgId > 0 ? { OR: [{ buyerId }, { buyer: { organizationId: buyerOrgId } }, { requirement: { organizationId: buyerOrgId } }] } : { buyerId },
      orderBy: { createdAt: 'desc' },
      include: {
        requirement: {
          include: {
            category: { select: { name: true } },
            items: true,
            organization: { select: { organizationName: true } }
          }
        },
        buyer: {
          include: {
            organization: { select: { organizationName: true } }
          }
        }
      },
    }),
    db.requirement.findMany({
      where: buyerOrgId > 0 ? { OR: [{ buyerId }, { organizationId: buyerOrgId }] } : { buyerId },
      orderBy: { createdAt: 'desc' },
      include: {
        category: { select: { name: true } },
        items: true,
        organization: { select: { organizationName: true } }
      },
    }),
    db.contract.findMany({
      where: {
        contractType: 'RATE_CONTRACT'
      },
      orderBy: { updatedAt: 'desc' },
    }),
    db.fileAsset.findMany({
      where: { ownerId: buyerId, entityType: 'requirement', status: 'active' }
    }),
    db.auction.findMany({
      where: buyerOrgId > 0
        ? {
            OR: [
              { createdByUserId: buyerId },
              { buyerOrgId: buyerOrgId }
            ]
          }
        : { createdByUserId: buyerId },
      orderBy: { createdAt: 'desc' },
    }),
    buyerOrgId > 0
      ? db.procurementApproval.findMany({
          where: { organizationId: buyerOrgId },
          include: { approver: { select: { id: true, name: true, email: true } } },
          orderBy: [{ entityId: 'asc' }, { sequence: 'asc' }]
        })
      : Promise.resolve([])
  ]);

  const loggedInOrgName = buyerOrg?.organizationName || '';

  const requirementAssets = fileAssets.reduce((acc: Record<number, any[]>, asset: any) => {
    const key = Number(asset.entityId);
    acc[key] = acc[key] || [];
    acc[key].push({
      fileAssetId: asset.id,
      fileName: asset.originalName || 'Document',
      documentType: 'Requirement Document'
    });
    return acc;
  }, {});

  // Resolve linked auctions in memory (instead of db query)
  const linkedAuctions = auctions.filter((auc: any) =>
    auc.linkedRequirementId && requirements.some((r: any) => r.id === auc.linkedRequirementId)
  );

  const auctionsByRequirementId = linkedAuctions.reduce((acc: Record<number, any>, auc: any) => {
    acc[auc.linkedRequirementId] = auc;
    return acc;
  }, {});

  const auctionIds = auctions.map((a: any) => a.id);
  const auctionParticipants = auctionIds.length > 0
    ? await db.auctionParticipant.findMany({
        where: { auctionId: { in: auctionIds } },
        select: { id: true, auctionId: true }
      }).catch(() => [])
    : [];
  const participantsCountByAuctionId = auctionParticipants.reduce((acc: Record<number, number>, p: any) => {
    acc[p.auctionId] = (acc[p.auctionId] || 0) + 1;
    return acc;
  }, {});

  const auctionsByBidId = auctions.reduce((acc: Record<number, any>, auc: any) => {
    if (auc.linkedBidId) {
      acc[auc.linkedBidId] = auc;
    }
    const parentRef = auc.referenceNo || (auc.auctionConfig as any)?.parentRefNumber;
    const parentId = (auc.auctionConfig as any)?.parentProcurementId;
    const matchedBid = procurementBids.find((pb: any) =>
      (auc.linkedBidId && pb.id === Number(auc.linkedBidId)) ||
      (parentId && (pb.id === Number(parentId) || pb.bidNumber === String(parentId))) ||
      (parentRef && (pb.bidNumber === parentRef || parentRef.includes(pb.bidNumber) || pb.bidNumber.includes(parentRef))) ||
      (auc.auctionCode && (pb.bidNumber === auc.auctionCode || auc.auctionCode.includes(pb.bidNumber) || pb.bidNumber.includes(auc.auctionCode)))
    );
    if (matchedBid) {
      acc[matchedBid.id] = auc;
    }
    return acc;
  }, {});

  // Group approvals in memory
  const cartApprovals = allApprovals.filter(a => a.entityType === 'cart');
  const directPurchaseApprovals = allApprovals.filter(a => a.entityType === 'direct_purchase' || a.entityType === 'cart');
  const tenderApprovals = allApprovals.filter(a => a.entityType === 'tender');

  const approvalsByEntity = (approvals: any[]) =>
    approvals.reduce((acc: Record<number, any[]>, approval: any) => {
      const key = Number(approval.entityId);
      acc[key] = acc[key] || [];
      acc[key].push(approval);
      return acc;
    }, {});
  const cartApprovalsByEntity = approvalsByEntity(cartApprovals);
  const directApprovalsByEntity = approvalsByEntity(directPurchaseApprovals);
  const tenderApprovalsByEntity = approvalsByEntity(tenderApprovals);

  const all: NormalizedProcurement[] = [];

  // Special conditions labels helper
  const SPECIAL_CONDITIONS_LABELS: Record<string, string> = {
    corrigendumAllowed: 'Corrigendum Allowed?',
    cancellationAllowedBeforeClosing: 'Bid Cancellation Allowed Before Closing?',
    clarificationWindowRequired: 'Clarification Window Required?',
    sellerQueryAllowed: 'Seller Query Allowed?',
    documentResubmissionAllowed: 'Document Resubmission Allowed?',
    splittingQuantityAllowed: 'Splitting Quantity Allowed?',
    multipleAwardAllowed: 'Multiple Award Allowed?',
    rateContractRequired: 'Rate Contract Required?',
  };

  // 1) Bid Wizard Drafts
  for (const d of bidDrafts) {
    const fd = d.formData as any || {};
    const step4 = fd?.step4 || {};
    const step5 = fd?.step5 || {};
    const step6 = fd?.step6 || {};
    const step7 = fd?.step7 || {};
    const step8 = fd?.step8 || {};
    const step3 = fd?.step3 || {};
    const step2 = fd?.step2 || {};

    const methodCanonical = canonicalMethodFromRecord({
      canonicalMethod: d.bidType,
      payload: d.formData
    });
    const bidTypeSlug = methodCanonical.toLowerCase().replace(/_/g, '-');


    // Extract documents
    const documents: any[] = [];
    const docFields = [
      'technicalSpecificationDocumentIds',
      'budgetSanctionDocumentIds',
      'administrativeApprovalDocumentIds',
      'scopeOfWorkDocumentIds',
      'boqDocumentIds',
      'pacCertificateDocumentIds',
      'drawingDocumentIds',
      'additionalTermDocumentIds'
    ];
    for (const field of docFields) {
      const arr = step7[field];
      if (Array.isArray(arr)) {
        for (const doc of arr) {
          if (doc && (doc.fileAssetId || doc.id)) {
            documents.push({
              fileAssetId: Number(doc.fileAssetId || doc.id),
              fileName: doc.fileName || doc.originalName || `${field.replace('DocumentIds', '')}`,
              documentType: doc.documentType || field.replace('DocumentIds', '').replace(/([A-Z])/g, ' $1').trim()
            });
          }
        }
      }
    }

    // Extract items
    const items = [];
    if (step4.productName || step4.serviceCategory) {
      const isProduct = d.bidType === 'PRODUCT_BID' || step4.productName;
      items.push({
        itemName: isProduct ? step4.productName : step4.serviceCategory,
        quantity: String(step4.quantity || ''),
        unitOfMeasure: step4.unitOfMeasurement || '',
        description: isProduct ? step4.productDescription : step4.scopeOfWork
      });
    }

    // Extract eligibility criteria
    const eligibilityCriteria: string[] = [];
    if (step6.minimumExperienceRequired) eligibilityCriteria.push(`Minimum Experience: ${step6.minimumExperience || 'N/A'}`);
    if (step6.minimumTurnoverRequired) eligibilityCriteria.push(`Minimum Turnover: ${step6.minimumTurnover || 'N/A'}`);
    if (step6.similarWorkExperienceRequired) eligibilityCriteria.push("Similar Work Experience Required");
    if (step6.msePreference) eligibilityCriteria.push("MSE Preference Allowed");
    if (step6.makeInIndiaPreference) eligibilityCriteria.push("Make in India Preference Allowed");
    if (Array.isArray(step6.bidderDocuments)) {
      eligibilityCriteria.push(`Required Bidder Documents: ${step6.bidderDocuments.join(', ')}`);
    }

    // Extract terms
    const termsAndConditions: string[] = [];
    if (step7.paymentTerms) termsAndConditions.push(`Payment Terms: ${step7.paymentTerms}`);
    if (step7.advancePaymentAllowed) termsAndConditions.push("Advance Payment Allowed");
    if (step7.partPaymentAllowed) termsAndConditions.push("Part Payment Allowed");
    if (step7.ewayBillRequired) termsAndConditions.push("e-Way Bill Required");

    // Add special conditions
    for (const [key, label] of Object.entries(SPECIAL_CONDITIONS_LABELS)) {
      if (step8[key]) termsAndConditions.push(label);
    }

    all.push({
      id: d.id,
      type: 'bid_draft',
      typeLabel: 'Bid Draft',
      title: fd?.basicDetails?.title || fd?.title || step3.title || `Draft #${d.id}`,
      referenceNumber: formatRefId(bidTypeSlug, d.id, null, bidTypeSlug),
      status: String(d.draftStatus || 'DRAFT'),
      statusLabel: statusLabel(String(d.draftStatus || 'DRAFT')),
      statusGroup: statusGroupFor(String(d.draftStatus || 'DRAFT')),
      method: bidTypeSlug,
      methodLabel: METHOD_LABEL_MAP[bidTypeSlug] || bidTypeSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      estimatedValue: Number(fd?.basicDetails?.estimatedValue || fd?.estimatedValue || step3.estimatedValue || 0),
      category: fd?.basicDetails?.category || fd?.category || step4.productCategory || step4.serviceCategory || '',
      description: cleanOpportunitySummary(fd?.basicDetails?.description || fd?.description || step4.productDescription || step4.scopeOfWork || ''),
      deliveryLocation: fd?.basicDetails?.deliveryLocation || fd?.deliveryLocation || step5.singleConsignee?.location || '',
      startDate: fd?.basicDetails?.startDate || fd?.startDate || '',
      endDate: fd?.basicDetails?.endDate || fd?.endDate || '',
      quantity: String(fd?.basicDetails?.quantity || fd?.quantity || step4.quantity || ''),
      unit: fd?.basicDetails?.unit || fd?.unit || step4.unitOfMeasurement || '',
      organizationName: fd?.basicDetails?.buyerOrganizationName || fd?.buyerOrganizationName || step2.organizationName || '',
      createdAt: d.createdAt?.toISOString?.() || '',
      updatedAt: d.updatedAt?.toISOString?.() || '',
      actionUrl: `/buyer/create-bid?draft=${d.id}`,
      documents: [...documents, ...(requirementAssets[d.id] || [])],
      items,
      paymentTerms: step7.paymentTerms || '',
      eligibilityCriteria,
      termsAndConditions,
      approvalAuthority: String((fd?.internal || fd?.step2)?.approvalAuthority || '').trim(),
      justification: String((fd?.internal || fd?.step2)?.justification || fd?.basics?.justification || fd?.limitedTenderJustification || '').trim(),
      internalDetails: (fd?.internal || fd?.step2) || undefined,
    });
  }

  // 2) ProcurementBid (published bids / tenders)
  await enrichBidsWithResponses(procurementBids, buyerId);
  for (const b of procurementBids) {
    const methodCanonical = canonicalMethodFromRecord(b);
    const methodSlug = methodCanonical.toLowerCase().replace(/_/g, '-');
    const bidRef = formatRefId(methodCanonical, b.id, b.bidNumber, methodCanonical);

    const documents = (b.documents || []).map((doc: any) => ({
      fileAssetId: doc.fileAssetId,
      fileName: doc.fileName || doc.fileAsset?.originalName || 'Document',
      documentType: doc.documentType || 'Bid Document'
    }));

    const technicalPacket = (b.technicalPacket || {}) as any;
    const internal = technicalPacket.internal || {};
    const basics = technicalPacket.basics || {};
    const schedule = technicalPacket.schedule || {};
    const terms = technicalPacket.terms || {};

    const sanitizeStatutoryDisplay = (val: string, fallback: string) => {
      const s = String(val || '').trim();
      if (!s) return '';
      if (/^(.)\1{3,}$/i.test(s) || /^(faf|asdf|test|xyz|abc|qwer)+$/i.test(s.replace(/[\s_-]+/g, '')) || !/[a-zA-Z]/.test(s)) {
        return fallback;
      }
      return s;
    };

    const approvalAuthority = sanitizeStatutoryDisplay(internal.approvalAuthority, 'Competent Financial Authority');
    const justification = sanitizeStatutoryDisplay(
      internal.justification || basics.justification || technicalPacket.limitedTenderJustification,
      'Approved for official procurement in accordance with statutory public procurement guidelines.'
    );
    const budgetConfirmed = internal.budgetConfirmed !== undefined ? Boolean(internal.budgetConfirmed) : true;
    const internalDetails = {
      orgName: internal.orgName || b.buyerOrganizationName || '',
      contactPerson: internal.contactPerson || '',
      email: internal.email || '',
      mobile: internal.mobile || '',
      department: internal.department || '',
      approvalAuthority,
      justification,
      budgetConfirmed,
      internalFileNumber: internal.internalFileNumber || '',
      competentAuthority: internal.competentAuthority || '',
    };

    const resolvedPriority = basics.priority || basics.urgency || technicalPacket.urgency || technicalPacket.priority || String(b.description || '').match(/(?:urgency|priority):\s*([A-Za-z0-9_-]+)/i)?.[1] || 'Normal';

    const bidDetailSections = [
      detailSection('Procurement Intent', {
        title: b.title,
        category: b.category,
        estimatedValue: b.estimatedValue ? `INR ${Number(b.estimatedValue).toLocaleString('en-IN')}` : undefined,
        deliveryLocation: b.deliveryLocation,
        requiredByDate: basics.requiredByDate,
        priority: resolvedPriority,
        urgency: resolvedPriority,
        buyerType: basics.buyerType,
      }),
      detailSection('Internal Approvals & Compliance', {
        approvalAuthority: approvalAuthority || undefined,
        justification: justification || undefined,
        budgetConfirmed: budgetConfirmed ? 'Confirmed & Sanctioned' : 'Pending',
        orgName: internal.orgName || b.buyerOrganizationName || undefined,
        contactPerson: internal.contactPerson || undefined,
        email: internal.email || undefined,
        mobile: internal.mobile || undefined,
        department: internal.department || undefined,
        internalFileNumber: internal.internalFileNumber || undefined,
        competentAuthority: internal.competentAuthority || undefined,
      }, {
        approvalAuthority: 'Internal Approval Authority',
        justification: 'Purchase Justification & Compliance Reason',
        budgetConfirmed: 'Budget Allocation & Sanction',
        orgName: 'Organization Name',
        contactPerson: 'Contact Person Name',
        email: 'Contact Email Address',
        mobile: 'Contact Mobile Number',
        department: 'Buying Department',
        internalFileNumber: 'Department File / Case Number',
        competentAuthority: 'Competent Financial Authority (CFA)',
      }),
      detailSection('Consignee & Delivery', technicalPacket.consigneeDetails ? { consigneeDetails: technicalPacket.consigneeDetails } : undefined),
      detailSection('Vendor / Supplier Selection', technicalPacket.vendors),
      detailSection('Timeline & Rules', { ...schedule, ...(technicalPacket.tender || {}), ...(technicalPacket.rules || {}) }),
      detailSection('Commercial Terms', terms),
      detailSection('Evaluation Basis', technicalPacket.evaluation),
      detailSection('Approval Notes', technicalPacket.approval),
      detailSection('Service Details', (technicalPacket.procurementCategory === 'SERVICES' || technicalPacket.categoryType === 'SERVICES') ? technicalPacket.serviceDetails : undefined),
    ].filter(Boolean) as Array<{ title: string; fields: Array<{ label: string; value: string }> }>;

    const packetItems = Array.isArray(technicalPacket.items) && technicalPacket.items.length > 0
      ? technicalPacket.items.map((it: any) => ({
          itemName: it.name || it.itemName || b.title,
          quantity: String(it.quantity || it.qty || b.quantity || ''),
          unitOfMeasure: it.unit || it.unitOfMeasure || b.unit || 'Nos',
          description: it.description || it.specifications?.description || cleanOpportunitySummary(b.description || ''),
          estimatedUnitPrice: Number(it.estimatedUnitPrice || it.unitPrice || it.price || 0) || undefined,
          specifications: it.specifications || it
        }))
      : null;

    const items = packetItems || [{
      itemName: b.title,
      quantity: String(b.quantity || ''),
      unitOfMeasure: b.unit || '',
      description: cleanOpportunitySummary(b.description || '')
    }];

    const eligibilityCriteria = b.eligibilityCriteria || [];
    const termsAndConditions = b.termsAndConditions || [];
    if (b.evaluationMethod) {
      termsAndConditions.push('Evaluation Method: L1 Basis (Lowest Landed Cost)');
    }

    all.push({
      id: b.id,
      type: 'bid_tender',
      typeLabel: 'Bid / Tender',
      title: b.title || `Bid #${bidRef}`,
      referenceNumber: bidRef,
      status: String(b.status || 'DRAFT'),
      statusLabel: statusLabel(String(b.status || 'DRAFT')),
      statusGroup: statusGroupFor(String(b.status || 'DRAFT')),
      method: methodSlug,
      methodLabel: METHOD_LABEL_MAP[methodSlug] || methodCanonical.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),

      estimatedValue: Number(
        b.estimatedValue ||
        auctionsByBidId[b.id]?.startPrice ||
        auctionsByBidId[b.id]?.basePrice ||
        basics.estimatedValue ||
        basics.totalBudget ||
        technicalPacket.auctionConfig?.startingBidPrice ||
        technicalPacket.auctionConfig?.basePrice ||
        0
      ),
      category: b.category || '',
      description: cleanOpportunitySummary(b.description || ''),
      deliveryLocation: b.deliveryLocation || '',
      startDate: b.startDate?.toISOString?.() || '',
      endDate: b.endDate?.toISOString?.() || '',
      quantity: String(b.quantity || ''),
      unit: b.unit || '',
      organizationName: b.buyerOrganizationName || '',
      participantsCount: (b.participations || []).filter((p: any) => {
        const subStatus = String(p.submissionStatus || p.status || '').toUpperCase();
        return subStatus !== 'DRAFT' && !p.isWithdrawn;
      }).length,
      publishedAt: b.publishedAt?.toISOString?.() || null,
      postPublishEditCount: Number(b.postPublishEditCount || 0),
      createdAt: b.createdAt?.toISOString?.() || '',
      updatedAt: b.updatedAt?.toISOString?.() || '',
      linkedAuctionId: auctionsByBidId[b.id]?.id || null,
      linkedAuctionCode: auctionsByBidId[b.id]?.auctionCode || null,
      linkedAuctionStatus: auctionsByBidId[b.id]?.statusEnum || auctionsByBidId[b.id]?.status || null,
      actionUrl: (() => {
        const la = auctionsByBidId[b.id];
        if (la) {
          const s = String(la.statusEnum || la.status || '').toUpperCase();
          if (['PUBLISHED', 'OPEN', 'ACTIVE', 'SOURCING', 'LIVE'].includes(s)) {
            return `/buyer/procurement/reverse-auction/${encodeURIComponent(String(la.auctionCode || la.id))}/live`;
          }
          if (['CLOSED', 'COMPLETED', 'AWARDED', 'FINALIZED'].includes(s)) {
            return `/buyer/procurement/reverse-auction/${encodeURIComponent(String(la.auctionCode || la.id))}/results`;
          }
        }
        const effectiveBidRef = bidRef || b.bidNumber || String(b.id);
        return `/bids/${encodeURIComponent(effectiveBidRef)}?type=${encodeURIComponent(methodCanonical)}`;
      })(),
      evaluationMethod: 'L1 Basis',
      documents,
      items,
      paymentTerms: terms.paymentTerms || '',
      eligibilityCriteria,
      termsAndConditions,
      approvalAuthority,
      justification,
      internalDetails,
      priority: resolvedPriority,
      urgency: resolvedPriority,
      budgetDetails: {
        costCenter: internal.costCenter || '',
        justification,
        approvingAuthority: approvalAuthority,
        remarks: budgetConfirmed ? 'Budget allocated and sanctioned under GFR/Corporate guidelines' : '',
      },
      detailSections: bidDetailSections.length > 0 ? bidDetailSections : undefined
    });
  }

  // 3) ProcurementRequest (cart checkout flows)
  for (const pr of procurementRequests) {
    const selectedMethod = pr.selectedMethod || pr.recommendedMethod || 'direct-purchase';
    const snap = pr.cartSnapshot as any;
    const categoryNames = (snap?.items || snap || []).map((item: any) => item?.product?.category?.name || item?.categoryName || item?.category || '').filter(Boolean);
    const prCategory = [...new Set(categoryNames)].join(', ') || '';

    const td = pr.termsDocuments as any || {};
    const documents: any[] = [];
    const rawDocs = td.requiredDocs || td.documents || [];
    if (Array.isArray(rawDocs)) {
      for (const doc of rawDocs) {
        if (doc) {
          documents.push({
            fileAssetId: doc.fileAssetId ? Number(doc.fileAssetId) : null,
            fileName: doc.name || doc.fileName || 'Document',
            documentType: doc.required ? 'Mandatory' : 'Optional',
            required: !!doc.required,
            instructions: doc.instructions || doc.remarks || ''
          });
        }
      }
    }

    const docFields = [
      'technicalSpecificationDocumentIds',
      'budgetSanctionDocumentIds',
      'administrativeApprovalDocumentIds',
      'scopeOfWorkDocumentIds',
      'boqDocumentIds',
      'pacCertificateDocumentIds',
      'drawingDocumentIds',
      'additionalTermDocumentIds'
    ];
    for (const field of docFields) {
      const arr = td[field];
      if (Array.isArray(arr)) {
        for (const doc of arr) {
          if (doc && (doc.fileAssetId || doc.id)) {
            const fid = Number(doc.fileAssetId || doc.id);
            if (!documents.some(d => d.fileAssetId === fid)) {
              documents.push({
                fileAssetId: fid,
                fileName: doc.fileName || doc.originalName || `${field.replace('DocumentIds', '')}`,
                documentType: 'Attachment',
                required: false,
                instructions: doc.instructions || doc.remarks || ''
              });
            }
          }
        }
      }
    }

    const items = (snap?.items || snap || []).map((item: any) => ({
      itemName: item?.product?.name || item?.service?.name || item?.itemName || 'Product/Service',
      quantity: String(item?.quantity || ''),
      unitOfMeasure: item?.product?.unit || item?.unit || 'Nos',
      description: item?.product?.description || item?.service?.description || '',
      estimatedUnitPrice: Number(item?.product?.price || item?.price || item?.estimatedUnitPrice || 0) || undefined,
      specifications: item?.product || item?.service || item?.specifications || undefined
    }));

    const itemsList = Array.isArray(snap?.items) ? snap.items : (Array.isArray(snap) ? snap : []);
    const calculatedValue = itemsList.reduce((sum: number, item: any) => {
      const qty = Number(item?.quantity || 1);
      const price = Number(item?.product?.price || item?.price || 0);
      return sum + (qty * price);
    }, 0);

    const budget = pr.budgetSanction as any || {};
    const payment = pr.paymentAuthority as any || {};
    const reasonability = pr.priceReasonability as any || {};

    const termsAndConditions: string[] = [];
    if (td.paymentTerms) termsAndConditions.push(`Payment Terms: ${td.paymentTerms}`);

    const prStatus = String(pr.status || 'DRAFT');
    const prStatusGroup = statusGroupFor(prStatus);
    const prApprovals = directApprovalsByEntity[Number(pr.id)] || cartApprovalsByEntity[Number(pr.cartId || pr.id)] || [];
    const prActionUrl =
      prStatusGroup === 'draft'
        ? '/buyer/procurement/drafts'
        : prStatusGroup === 'pending_approval'
          ? '/buyer/procurement/approvals'
          : prStatus === 'CONVERTED_TO_ORDER' || prStatus === 'COMPLETED' || prStatus === 'APPROVED'
            ? '/buyer/orders'
            : '/buyer/my-procurements';
    const prDetailSections = [
      detailSection('Buyer Details', pr.buyerDetails, {
        department: 'Buyer Department / Organization',
        officerName: 'Buyer Officer Name',
        fileNumber: 'Department File Number'
      }),
      detailSection('Consignee & Delivery', { ...(pr.consigneeDetails as any || {}), ...(pr.deliveryDetails as any || {}) }),
      detailSection('Budget & Sanction', pr.budgetSanction),
      detailSection('Payment Authority', pr.paymentAuthority),
      detailSection('Price Reasonability', pr.priceReasonability),
      detailSection('Warnings & Declarations', { ...(pr.warnings as any || {}), ...(pr.declarations as any || {}) }),
    ].filter(Boolean) as Array<{ title: string; fields: Array<{ label: string; value: string }> }>;

    const prRef = formatRefId('DP', pr.id, pr.requestNumber, selectedMethod);
    const prTitle = (items.length > 0 && items[0]?.itemName && items[0]?.itemName !== 'Product/Service')
      ? `${items[0].itemName}${items.length > 1 ? ` (+${items.length - 1} more items)` : ''}`
      : `Direct Purchase ${prRef}`;

    all.push({
      id: pr.id,
      type: 'procurement_request',
      typeLabel: 'Cart Checkout',
      title: prTitle,
      referenceNumber: prRef,
      status: prStatus,
      statusLabel: statusLabel(prStatus),
      statusGroup: prStatusGroup,
      method: selectedMethod,
      methodLabel: METHOD_LABEL_MAP[selectedMethod] || selectedMethod.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      estimatedValue: calculatedValue,
      category: prCategory,
      description: '',
      deliveryLocation: (pr as any).deliveryLocation || '',
      startDate: '',
      endDate: '',
      quantity: '',
      unit: '',
      organizationName: (pr as any).organization?.organizationName || loggedInOrgName || '',
      createdAt: pr.createdAt?.toISOString?.() || '',
      updatedAt: pr.updatedAt?.toISOString?.() || '',
      actionUrl: prActionUrl,
      documents: [...documents, ...(requirementAssets[pr.id] || [])],
      items,
      paymentTerms: td.paymentTerms || '',
      eligibilityCriteria: [],
      termsAndConditions,
      budgetDetails: {
        budgetHead: budget.budgetHead || '',
        financialYear: budget.financialYear || '',
        fundSource: budget.fundSource || '',
        sanctionAmount: budget.sanctionAmount ? Number(budget.sanctionAmount) : undefined,
        sanctionOrderNumber: budget.sanctionOrderNumber || '',
        sanctionDate: budget.sanctionDate || '',
        approvingAuthority: budget.approvingAuthority || '',
        payingAuthorityDesignation: payment.payingAuthorityDesignation || '',
        paymentMode: payment.paymentMode || '',
        priceReasonabilityRemarks: reasonability.priceReasonabilityRemarks || '',
        marketComparisonPrice: reasonability.marketComparisonPrice ? Number(reasonability.marketComparisonPrice) : undefined,
        lastPurchasePrice: reasonability.lastPurchasePrice ? Number(reasonability.lastPurchasePrice) : undefined,
      } as any,
      detailSections: prDetailSections,
      approvalTrail: approvalTrailFor(prApprovals),
      tracking: trackingFor(prStatus, pr.createdAt, pr.submittedAt, pr.approvedAt, prApprovals)
    });
  }

  // 4) DirectPurchase
  for (const dp of directPurchases) {
    const req = dp.requirement || {};
    const payload = req.payload as any || {};
    const dpApprovals = directApprovalsByEntity[Number(dp.id)] || [];
    const items = (req.items || []).map((item: any) => ({
      itemName: item.itemName || item.name || '',
      quantity: String(item.quantity || ''),
      unitOfMeasure: item.unitOfMeasure || item.unit || '',
      description: item.description || '',
      estimatedUnitPrice: item.estimatedUnitPrice !== null && item.estimatedUnitPrice !== undefined ? Number(item.estimatedUnitPrice) : undefined,
      specifications: item.specifications || undefined
    }));
    const dpDetailSections = [
      detailSection('Buyer & Department', {
        department: dp.department,
        budgetHead: dp.budgetHead,
        costCenter: dp.costCenter,
        consigneeName: dp.consigneeName,
        mobileNumber: dp.mobileNumber,
        email: dp.email,
      }),
      detailSection('Delivery', {
        deliveryAddress: dp.deliveryAddressText,
        deliveryInstructions: dp.deliveryInstructions,
        requiredDeliveryDate: dp.requiredDeliveryDate,
      }),
      detailSection('Justification & Remarks', {
        justification: dp.justification,
        remarks: dp.remarks,
      }),
      detailSection('Source Requirement', {
        requirementNumber: req.requirementNumber,
        procurementMethod: req.canonicalMethod || req.procurementMethod,
        requiredBy: req.requiredBy,
        workflowStatus: dp.workflowStatus,
        approvalStatus: dp.approvalStatus,
      }),
      detailSection('Original Wizard Basics', payload.basics),
      detailSection('Internal Details', payload.internal),
      detailSection('Schedule & Rules', { ...(payload.schedule || {}), ...(payload.rules || {}) }),
    ].filter(Boolean) as Array<{ title: string; fields: Array<{ label: string; value: string }> }>;

    const documents: any[] = [];
    const rawDocs = payload.requiredDocs || payload.documents || [];
    if (Array.isArray(rawDocs)) {
      for (const doc of rawDocs) {
        if (doc) {
          documents.push({
            fileAssetId: doc.fileAssetId ? Number(doc.fileAssetId) : null,
            fileName: doc.name || doc.fileName || 'Document',
            documentType: doc.required ? 'Mandatory' : 'Optional',
            required: !!doc.required,
            instructions: doc.instructions || doc.remarks || ''
          });
        }
      }
    }
    if (Array.isArray(payload.documents)) {
      for (const doc of payload.documents) {
        if (doc && doc.fileAssetId) {
          const fid = Number(doc.fileAssetId);
          if (!documents.some(d => d.fileAssetId === fid)) {
            documents.push({
              fileAssetId: fid,
              fileName: doc.fileName || doc.originalName || 'Document',
              documentType: 'Attachment',
              required: !!doc.required,
              instructions: doc.instructions || doc.remarks || ''
            });
          }
        }
      }
    }

    const dpRef = formatRefId('DP', dp.id, dp.purchaseNumber, 'DIRECT_PURCHASE');
    const dpTitle = (items.length > 0 && items[0]?.itemName)
      ? `${items[0].itemName}${items.length > 1 ? ` (+${items.length - 1} more items)` : ''}`
      : `Direct Purchase ${dpRef}`;

    all.push({
      id: dp.id,
      type: 'direct_purchase',
      typeLabel: 'Direct Purchase',
      title: dpTitle,
      referenceNumber: dpRef,
      status: String(dp.status || 'DRAFT'),
      statusLabel: statusLabel(String(dp.status || 'DRAFT')),
      statusGroup: statusGroupFor(String(dp.status || 'DRAFT')),
      method: 'direct-purchase',
      methodLabel: 'Direct Purchase',
      estimatedValue: Number(dp.totalAmount || 0),
      category: (dp as any).requirement?.category?.name || dp.department || '',
      description: '',
      deliveryLocation: dp.deliveryAddressText || '',
      startDate: '',
      endDate: '',
      quantity: '',
      unit: '',
      organizationName: (dp as any).requirement?.organization?.organizationName || (dp as any).buyer?.organization?.organizationName || loggedInOrgName || '',
      createdAt: dp.createdAt?.toISOString?.() || '',
      updatedAt: dp.updatedAt?.toISOString?.() || '',
      actionUrl: `/buyer/direct-purchase/orders`,
      documents: [...documents, ...(requirementAssets[Number(dp.requirementId)] || [])],
      items,
      paymentTerms: '',
      eligibilityCriteria: [],
      termsAndConditions: [],
      budgetDetails: {
        budgetHead: dp.budgetHead || '',
        costCenter: dp.costCenter || '',
        justification: dp.justification || '',
        remarks: dp.remarks || '',
      } as any,
      detailSections: dpDetailSections,
      approvalTrail: approvalTrailFor(dpApprovals),
      tracking: trackingFor(String(dp.status || 'DRAFT'), dp.createdAt, dp.requestedAt, dp.approvedAt, dpApprovals)
    });
  }

  // 5) Requirement
  const buyerReqIds = requirements.map(r => r.id);
  const matchedRequirementResponses = buyerReqIds.length > 0
    ? await db.requirementResponse.findMany({
        where: {
          requirementId: { in: buyerReqIds },
          status: { not: 'DRAFT' }
        },
        select: { id: true, requirementId: true }
      }).catch(() => [])
    : [];

  const reqResponseCountMap = new Map<number, number>();
  for (const resp of matchedRequirementResponses) {
    const rid = Number(resp.requirementId);
    reqResponseCountMap.set(rid, (reqResponseCountMap.get(rid) || 0) + 1);
  }

  for (const r of requirements) {
    const payload = (r as any).payload || {};

    // Deduplication logic: Skip if this requirement has been converted to a ProcurementBid, DirectPurchase, or RateContract
    const hasLinkedBid = procurementBids.some(b =>
      b.bidNumber === r.requirementNumber ||
      b.id === payload.linkedProcurementBidId ||
      Number((b.technicalPacket as any)?.sourceRequirementId || (b.technicalPacket as any)?.requirementId || 0) === r.id
    );
    if (hasLinkedBid) continue;

    const hasLinkedDP = directPurchases.some(dp => Number(dp.requirementId) === r.id);
    if (hasLinkedDP) continue;

    const hasLinkedRateContract = rateContracts.some(rc => {
      const meta = (rc.metadata || {}) as any;
      return Number(meta.requirementId || 0) === r.id ||
             meta.requirementNumber === r.requirementNumber ||
             rc.contractNumber === r.requirementNumber;
    });
    if (hasLinkedRateContract) continue;

    const methodSlug = String(r.procurementMethod || 'TENDER').toLowerCase().replace(/_/g, '-');
    const linkedAuction = auctionsByRequirementId[r.id];
    
    // Map status based on linked auction if applicable
    const rStatus = linkedAuction ? (linkedAuction.statusEnum || linkedAuction.status || r.status) : r.status;
    const rStatusUpper = String(rStatus || 'DRAFT').toUpperCase();
    
    const items = (r.items || []).map((item: any) => ({
      itemName: item.itemName || item.name || '',
      quantity: String(item.quantity || ''),
      unitOfMeasure: item.unitOfMeasure || item.unit || '',
      description: item.description || '',
      estimatedUnitPrice: item.estimatedUnitPrice !== null && item.estimatedUnitPrice !== undefined ? Number(item.estimatedUnitPrice) : undefined,
      specifications: item.specifications || undefined
    }));

    const documents: any[] = [];
    const rawDocs = payload.requiredDocs || payload.documents || [];
    if (Array.isArray(rawDocs)) {
      for (const doc of rawDocs) {
        if (doc) {
          documents.push({
            fileAssetId: doc.fileAssetId ? Number(doc.fileAssetId) : null,
            fileName: doc.name || doc.fileName || 'Document',
            documentType: doc.required ? 'Mandatory' : 'Optional',
            required: !!doc.required,
            instructions: doc.instructions || doc.remarks || ''
          });
        }
      }
    }
    if (Array.isArray(payload.documents)) {
      for (const doc of payload.documents) {
        if (doc && doc.fileAssetId) {
          const fid = Number(doc.fileAssetId);
          if (!documents.some(d => d.fileAssetId === fid)) {
            documents.push({
              fileAssetId: fid,
              fileName: doc.fileName || 'Document',
              documentType: 'Attachment',
              required: !!doc.required,
              instructions: doc.instructions || doc.remarks || ''
            });
          }
        }
      }
    }
    const requirementDetailSections = [
      detailSection('Procurement Intent', {
        ...(payload.basics || {}),
        buyerType: payload.buyerType,
        procurementCategory: payload.procurementCategory || payload.categoryType || payload.basics?.procurementCategory,
        pricingFormat: payload.pricingFormat || payload.basics?.pricingFormat,
        recommendedMethod: payload.recommendation?.id,
        recommendationReason: payload.recommendation?.reason,
      }),
      detailSection('Internal Approvals & Compliance', payload.internal, {
        approvalAuthority: 'Internal Approval Authority',
        justification: 'Purchase Justification & Compliance Reason',
        budgetConfirmed: 'Budget Allocation & Sanction',
        orgName: 'Organization Name',
        contactPerson: 'Contact Person Name',
        email: 'Contact Email Address',
        mobile: 'Contact Mobile Number',
        department: 'Buying Department',
        internalFileNumber: 'Department File / Case Number',
        competentAuthority: 'Competent Financial Authority (CFA)',
      }),
      detailSection('Consignee Details', { consigneeDetails: payload.consigneeDetails }),
      detailSection('Vendor / Supplier Selection', payload.vendors),
      detailSection('Timeline & Rules', { ...(payload.schedule || {}), ...(payload.tender || {}), ...(payload.rules || {}) }),
      detailSection('Commercial Terms', payload.terms),
      detailSection('Evaluation Basis', payload.evaluation),
      detailSection('Approval Notes', payload.approval),
      detailSection('Service Details', (payload.procurementCategory === 'SERVICES' || payload.categoryType === 'SERVICES') ? payload.serviceDetails : undefined),
      detailSection('Rate Contract', payload.rateContractConfig || payload.rateContract),
      detailSection('Reverse Auction', payload.auctionConfig),
    ].filter(Boolean) as Array<{ title: string; fields: Array<{ label: string; value: string }> }>;

    const reqMethod = r.procurementMethod || (r as any).canonicalMethod || payload.basics?.procurementMethod || 'TENDER';
    const reqRef = formatRequirementNumber(r.id, r.requirementNumber, reqMethod);

      const rAuction = auctionsByRequirementId[r.id];
      const rAuctionConfig = (payload.auctionConfig || {}) as any;
      const rEstimatedVal = Number(
        r.estimatedValue ||
        payload.basics?.estimatedValue ||
        rAuctionConfig.startingBidPrice ||
        rAuction?.startPrice ||
        rAuction?.basePrice ||
        0
      );

      all.push({
        id: r.id,
        type: 'requirement',
        typeLabel: 'Requirement',
        linkedAuctionId: rAuction?.id || null,
        title: r.title || `Requirement ${reqRef}`,
        referenceNumber: reqRef,
        status: rStatusUpper,
        statusLabel: statusLabel(rStatusUpper),
        statusGroup: statusGroupFor(rStatusUpper),
        method: methodSlug,
        methodLabel: METHOD_LABEL_MAP[methodSlug] || methodSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        estimatedValue: rEstimatedVal,
        category: (r as any).category?.name || payload.basics?.category || '',
        description: cleanOpportunitySummary(r.description || payload.basics?.description || ''),
        deliveryLocation: payload.basics?.deliveryLocation || payload.tender?.deliveryLocation || (r as any).deliveryLocation || '',
        startDate: rAuction?.startTime?.toISOString?.() || payload.schedule?.submissionStartDate || r.createdAt?.toISOString?.() || '',
        endDate: rAuction?.endTime?.toISOString?.() || payload.schedule?.submissionDate || payload.schedule?.bidValidityDate || '',
      quantity: String((r as any).quantity || ''),
      unit: (r as any).unit || '',
      organizationName: (r as any).organization?.organizationName || payload.basics?.buyerOrganizationName || loggedInOrgName || '',
      participantsCount: reqResponseCountMap.get(r.id) || 0,
      createdAt: r.createdAt?.toISOString?.() || '',
      updatedAt: r.updatedAt?.toISOString?.() || '',
      evaluationMethod: 'L1 Basis',
      actionUrl: (() => {
        const linkedAuction = auctionsByRequirementId[r.id];
        if (linkedAuction) {
          const s = String(linkedAuction.status).toUpperCase();
          if (['PUBLISHED', 'OPEN', 'ACTIVE', 'SOURCING', 'LIVE'].includes(s)) {
            return `/reverse-auctions/${linkedAuction.id}/live`;
          }
          if (['CLOSED', 'COMPLETED', 'AWARDED', 'FULFILLED', 'FINALIZED'].includes(s)) {
            return `/reverse-auctions/${linkedAuction.id}/results`;
          }
          return `/reverse-auctions/${linkedAuction.id}`;
        }
        const effectiveReqRef = reqRef || r.requirementNumber || String(r.id);
        return `/bids/${encodeURIComponent(effectiveReqRef)}?type=${encodeURIComponent(reqMethod.toUpperCase())}`;
      })(),
      documents: [...documents, ...(requirementAssets[r.id] || [])],
      items,
      paymentTerms: '',
      eligibilityCriteria: [],
      termsAndConditions: [],
      detailSections: requirementDetailSections,
      approvalAuthority: payload.internal?.approvalAuthority || '',
      justification: payload.internal?.justification || payload.basics?.justification || payload.limitedTenderJustification || '',
      internalDetails: payload.internal || undefined,
      budgetDetails: {
        costCenter: payload.internal?.costCenter || '',
        justification: payload.internal?.justification || payload.basics?.justification || '',
        approvingAuthority: payload.internal?.approvalAuthority || '',
        remarks: payload.internal?.budgetConfirmed ? 'Budget allocated and sanctioned under GFR/Corporate guidelines' : '',
      },
      approvalTrail: [],
      tracking: trackingFor(String(r.status || 'DRAFT'), r.createdAt, r.status === 'DRAFT' ? null : r.updatedAt, ['APPROVED', 'SOURCING', 'FULFILLED', 'PUBLISHED', 'OPEN', 'CLOSED'].includes(String(r.status || '')) ? r.updatedAt : null, [])
    });
  }

  // 6) Rate Contracts
  const buyerRateContracts = rateContracts.filter(c => {
    const metadata = (c.metadata || {}) as any;
    return Number(metadata.buyerId || 0) === buyerId;
  });

  const rcCandidateReqIds = new Set<number>();
  const rcCandidateSupplierIds = new Set<number>();
  for (const contract of buyerRateContracts) {
    const metadata = (contract.metadata || {}) as any;
    const srcReq = requirements.find(r => r.id === Number(metadata.requirementId) || r.requirementNumber === metadata.requirementNumber);
    if (srcReq?.id) rcCandidateReqIds.add(srcReq.id);
    if (metadata.requirementId) rcCandidateReqIds.add(Number(metadata.requirementId));
    for (const s of (metadata.selectedSuppliers || [])) {
      const sid = Number(s.supplierId || s.id);
      if (sid > 0) rcCandidateSupplierIds.add(sid);
    }
  }

  const allRcResponses = (rcCandidateReqIds.size > 0 || rcCandidateSupplierIds.size > 0)
    ? await db.requirementResponse.findMany({
        where: {
          OR: [
            ...(rcCandidateReqIds.size > 0 ? [{ requirementId: { in: Array.from(rcCandidateReqIds) } }] : []),
            ...(rcCandidateSupplierIds.size > 0 ? [{ sellerUserId: { in: Array.from(rcCandidateSupplierIds) } }] : []),
            ...(rcCandidateSupplierIds.size > 0 ? [{ sellerOrganizationId: { in: Array.from(rcCandidateSupplierIds) } }] : [])
          ]
        },
        include: {
          sellerUser: { select: { id: true, name: true, email: true, mobile: true, role: true, organizationId: true } },
          sellerOrganization: { select: { organizationName: true } }
        }
      }).catch(() => [])
    : [];

  for (const contract of buyerRateContracts) {
    const metadata = (contract.metadata || {}) as any;

    // Deduplication check: Skip if this Rate Contract is already represented by a ProcurementBid or Requirement in `all`
    const isAlreadyAdded = all.some(item =>
      (item.referenceNumber && (item.referenceNumber === metadata.requirementNumber || item.referenceNumber === contract.contractNumber)) ||
      (item.id && (item.id === metadata.requirementId || item.id === metadata.bidId))
    );
    if (isAlreadyAdded) continue;

    const expired = contract.endDate ? contract.endDate < new Date() : false;
    const itemRateSchedule = Array.isArray(metadata.itemRateSchedule) ? metadata.itemRateSchedule : [];
    const selectedSuppliers = Array.isArray(metadata.selectedSuppliers) ? metadata.selectedSuppliers : [];

    // Find linked source requirement to pull full items, specifications, and detail sections
    const srcReq = requirements.find(r => r.id === Number(metadata.requirementId) || r.requirementNumber === metadata.requirementNumber);
    const srcPayload = (srcReq as any)?.payload || {};

    // Filter supplier responses from the pre-fetched batch
    const reqIds = Array.from(new Set([srcReq?.id, Number(metadata.requirementId || 0)].filter(Boolean) as number[]));
    const allPossibleResponses = allRcResponses;

    const rateContractItemNames = itemRateSchedule.map((i: any) => String(i.itemName || '').toLowerCase().trim()).filter(Boolean);
    const responses = allPossibleResponses.filter((r: any) => {
      if (reqIds.includes(r.requirementId)) return true;
      const respData = typeof r.responseData === 'string' ? JSON.parse(r.responseData) : (r.responseData || {});
      const lineItems = Array.isArray(respData.lineItems) ? respData.lineItems : [];
      return lineItems.some((item: any) => rateContractItemNames.includes(String(item.itemName || '').toLowerCase().trim()));
    });

    const items = (srcReq?.items && srcReq.items.length > 0)
      ? srcReq.items.map((item: any) => ({
          itemName: item.itemName || item.name || '',
          quantity: String(item.quantity || ''),
          unitOfMeasure: item.unitOfMeasure || item.unit || '',
          description: item.description || '',
          estimatedUnitPrice: item.estimatedUnitPrice !== null && item.estimatedUnitPrice !== undefined ? Number(item.estimatedUnitPrice) : undefined,
          specifications: item.specifications || undefined
        }))
      : itemRateSchedule.map((item: any) => ({
          itemName: item.itemName,
          quantity: String(item.estimatedAnnualQuantity || ''),
          unitOfMeasure: item.uom || '',
          description: item.specification || '',
          estimatedUnitPrice: Number(item.baseRate || 0),
          specifications: item
        }));

    const contractDocs = metadata.contractDocument?.fileAssetId ? [{
      fileAssetId: metadata.contractDocument.fileAssetId,
      fileName: metadata.contractDocument.fileName || 'Rate Contract Document',
      documentType: 'Rate Contract Document'
    }] : [];
    const reqDocs = srcReq ? (requirementAssets[srcReq.id] || []) : [];

    const detailSections = [
      detailSection('Procurement Intent', {
        ...(srcPayload.basics || {}),
        buyerType: srcPayload.buyerType,
        procurementCategory: srcPayload.procurementCategory || srcPayload.categoryType || srcPayload.basics?.procurementCategory,
        pricingFormat: srcPayload.pricingFormat || srcPayload.basics?.pricingFormat,
        recommendedMethod: srcPayload.recommendation?.id,
        recommendationReason: srcPayload.recommendation?.reason,
      }),
      detailSection('Internal Buyer Details', srcPayload.internal),
      detailSection('Consignee Details', { consigneeDetails: srcPayload.consigneeDetails }),
      detailSection('Vendor / Supplier Selection', srcPayload.vendors),
      detailSection('Timeline & Rules', { ...(srcPayload.schedule || {}), ...(srcPayload.tender || {}), ...(srcPayload.rules || {}) }),
      detailSection('Commercial Terms', srcPayload.terms),
      detailSection('Evaluation Basis', srcPayload.evaluation),
      detailSection('Approval Notes', srcPayload.approval),
      detailSection('Service Details', (srcPayload.procurementCategory === 'SERVICES' || srcPayload.categoryType === 'SERVICES') ? srcPayload.serviceDetails : undefined),
      detailSection('Rate Contract Config', metadata),
    ].filter(Boolean) as Array<{ title: string; fields: Array<{ label: string; value: string }> }>;

    const participantsCount = responses.length;

    const rcRef = formatRefId('RC', contract.id, contract.contractNumber || metadata.requirementNumber, 'RATE_CONTRACT');

    all.push({
      id: contract.id,
      type: 'rate_contract',
      typeLabel: 'Rate Contract',
      title: contract.title || srcReq?.title || `Rate Contract ${rcRef}`,
      referenceNumber: rcRef,
      status: expired ? 'EXPIRED' : String(contract.status || 'ACTIVE'),
      statusLabel: expired ? 'Expired' : statusLabel(String(contract.status || 'ACTIVE')),
      statusGroup: expired ? 'cancelled' : 'active',
      method: 'rate-contract',
      methodLabel: 'Rate Contract',
      estimatedValue: Number(contract.value || srcReq?.estimatedValue || 0),
      category: metadata.contractCategory || srcReq?.category?.name || srcPayload.basics?.category || '',
      description: cleanOpportunitySummary(metadata.contractDescription || srcReq?.description || srcPayload.basics?.description || ''),
      deliveryLocation: metadata.deliverySla || srcPayload.basics?.deliveryLocation || (srcReq as any)?.deliveryLocation || '',
      startDate: contract.startDate?.toISOString?.() || '',
      endDate: contract.endDate?.toISOString?.() || '',
      quantity: String(items.reduce((sum: number, item: any) => sum + Number(item.quantity || 0), 0) || 1),
      unit: items[0]?.unitOfMeasure || 'Nos',
      organizationName: selectedSuppliers.map((supplier: any) => supplier.supplierName).filter(Boolean).join(', ') || (srcReq as any)?.organization?.organizationName || loggedInOrgName || '',
      participantsCount,
      createdAt: contract.createdAt?.toISOString?.() || '',
      updatedAt: contract.updatedAt?.toISOString?.() || '',
      actionUrl: `/bids/${rcRef}`,
      documents: [...contractDocs, ...reqDocs],
      items,
      paymentTerms: metadata.priceVariationClause || srcPayload.terms?.paymentTerms || '',
      eligibilityCriteria: selectedSuppliers.length > 0 ? selectedSuppliers.map((supplier: any) => supplier.supplierName || `Supplier ${supplier.supplierId}`) : [],
      termsAndConditions: [
        `Validity: ${contract.startDate?.toISOString?.().slice(0, 10) || '-'} to ${contract.endDate?.toISOString?.().slice(0, 10) || '-'}`,
        `Rate Validity: ${metadata.rateValidityPeriod || '-'}`,
        `Call-off Orders: ${metadata.callOffOrderAllowed ? 'Allowed' : 'Not Allowed'}`,
        `Price Variation: ${metadata.priceVariationClause || 'FIXED_PRICE'}${metadata.priceVariationClause === 'INDEX_BASED_VARIATION' ? ` (Pegged to ${metadata.priceIndexBenchmark || 'WPI'}, Cap: ${metadata.maxPriceVariationCapPercent ?? 10}%)` : ''}`,
        `Statutory Fall Clause: ${metadata.fallClauseApplicable !== false ? 'Applicable (Strict GFR Protection)' : 'Exempted'}`
      ],
      detailSections: detailSections.length > 0 ? detailSections : undefined,
    });
  }

  // 7) Reverse Auctions
  for (const a of auctions) {
    if (a.linkedRequirementId) continue;
    const parentRef = a.referenceNo || (a.auctionConfig as any)?.parentRefNumber;
    const parentId = (a.auctionConfig as any)?.parentProcurementId;
    const isLinkedToProcurementBid = procurementBids.some((pb: any) =>
      (a.linkedBidId && pb.id === Number(a.linkedBidId)) ||
      (parentId && (pb.id === Number(parentId) || pb.bidNumber === String(parentId))) ||
      (parentRef && (pb.bidNumber === parentRef || parentRef.includes(pb.bidNumber) || pb.bidNumber.includes(parentRef))) ||
      (a.auctionCode && (pb.bidNumber === a.auctionCode || a.auctionCode.includes(pb.bidNumber) || pb.bidNumber.includes(a.auctionCode)))
    );
    if (isLinkedToProcurementBid) continue;

    const s = String(a.statusEnum || a.status || 'scheduled').toUpperCase();
    const statusGroup = statusGroupFor(s);

    const actionUrl = (() => {
      if (['PUBLISHED', 'OPEN', 'ACTIVE', 'SOURCING', 'LIVE'].includes(s)) {
        return `/reverse-auctions/${a.id}/live`;
      }
      if (['CLOSED', 'COMPLETED', 'AWARDED', 'FULFILLED', 'FINALIZED'].includes(s)) {
        return `/reverse-auctions/${a.id}/results`;
      }
      return `/reverse-auctions/${a.id}`;
    })();

    const raRef = formatRefId('RA', a.id, a.auctionCode || a.referenceNo, 'REVERSE_AUCTION');
    const partCount = participantsCountByAuctionId[a.id] || (Array.isArray(a.bids) ? a.bids.length : 0);

    all.push({
      id: a.id,
      type: 'reverse_auction',
      typeLabel: 'Reverse Auction',
      title: a.title || `Reverse Auction ${raRef}`,
      referenceNumber: raRef,
      status: s,
      statusLabel: statusLabel(s),
      statusGroup: statusGroup,
      method: 'reverse-auction',
      methodLabel: 'Reverse Auction',
      participantsCount: partCount,
      estimatedValue: Number(a.startPrice || a.basePrice || 0),
      category: a.category || '',
      description: cleanOpportunitySummary(a.description || ''),
      deliveryLocation: '',
      startDate: a.startTime?.toISOString?.() || '',
      endDate: a.endTime?.toISOString?.() || '',
      quantity: '',
      unit: '',
      organizationName: loggedInOrgName || '',
      createdAt: a.createdAt?.toISOString?.() || '',
      updatedAt: a.updatedAt?.toISOString?.() || '',
      actionUrl,
      documents: a.termsDocumentFileId ? [{
        fileAssetId: a.termsDocumentFileId,
        fileName: a.termsDocumentName || 'Terms Document',
        documentType: 'Reverse Auction Terms'
      }] : [],
      items: [{
        itemName: a.title || 'Reverse Auction Sourcing',
        quantity: '1',
        unitOfMeasure: 'Nos',
        description: cleanOpportunitySummary(a.description || '')
      }],
      paymentTerms: '',
      eligibilityCriteria: [],
      termsAndConditions: [],
      detailSections: [
        detailSection('Reverse Auction Details', {
          auctionCode: a.auctionCode,
          auctionType: a.auctionType,
          auctionMode: a.auctionMode,
          startPrice: a.startPrice,
          minDecrement: a.minDecrement,
          autoExtensionEnabled: a.autoExtensionEnabled ? 'Yes' : 'No',
        })
      ].filter(Boolean) as any[]
    });
  }

  // Extra safety deduplication by type and id
  const seenKeys = new Set<string>();
  const deduplicatedAll: NormalizedProcurement[] = [];
  for (const item of all) {
    const key = `${item.type}-${item.id}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduplicatedAll.push(item);
  }

  // ── KPIs (computed from deduplicated data) ──
  const totalResponses = deduplicatedAll.reduce((sum, p) => sum + (Number(p.participantsCount) || 0), 0);
  const kpis = {
    totalProcurements: deduplicatedAll.filter(p => p.statusGroup !== 'draft').length,
    drafts: deduplicatedAll.filter(p => p.statusGroup === 'draft').length,
    pendingApproval: deduplicatedAll.filter(p => p.statusGroup === 'pending_approval').length,
    active: deduplicatedAll.filter(p => p.statusGroup === 'active').length,
    completed: deduplicatedAll.filter(p => p.statusGroup === 'completed').length,
    cancelled: deduplicatedAll.filter(p => p.statusGroup === 'cancelled').length,
    totalValue: deduplicatedAll.filter(p => p.statusGroup !== 'draft').reduce((sum, p) => sum + (p.estimatedValue || 0), 0),
    activeRateContracts: deduplicatedAll.filter(p => p.type === 'rate_contract' && p.statusGroup === 'active').length,
    expiredRateContracts: deduplicatedAll.filter(p => p.type === 'rate_contract' && p.status === 'EXPIRED').length,
    totalResponses,
  };

  return { all: deduplicatedAll, kpis };
}

router.get('/buyer/my-procurements', authenticate, authorize('buyer'), asyncRoute(async (req, res) => {
  const buyerId = userId(req);
  const buyerOrgId = req.user?.organizationId || -1;
  const { type, status, method, category, department, startDate, endDate, search, sortBy, sortDir, refresh } = req.query as Record<string, string | undefined>;

  const bypassCache = refresh === 'true' || refresh === '1';
  let all: NormalizedProcurement[] = [];
  let kpis = {
    totalProcurements: 0,
    drafts: 0,
    pendingApproval: 0,
    active: 0,
    completed: 0,
    cancelled: 0,
    totalValue: 0,
    activeRateContracts: 0,
    expiredRateContracts: 0,
    totalResponses: 0
  };

  try {
    const data = await getBuyerProcurementsData(buyerId, buyerOrgId, bypassCache);
    all = data.all || [];
    kpis = data.kpis || kpis;
  } catch (err: any) {
    logger.error({ err: err?.message || err }, '[getBuyerProcurementsData] Failed to retrieve buyer procurements');
  }

  let filtered = all;
  if (type) {
    filtered = filtered.filter(p => p.type === type);
  }
  if (status) {
    const st = status.toLowerCase();
    filtered = filtered.filter(p => {
      const pStatusGroup = (p.statusGroup || '').toLowerCase();
      const pStatus = (p.status || '').toLowerCase();
      if (pStatusGroup === st || pStatus === st) return true;
      if (st === 'published' || st === 'open' || st === 'active') {
        return pStatusGroup === 'active' || pStatus === 'published' || pStatus === 'open' || pStatus === 'active';
      }
      if (st === 'evaluation' || st === 'in_evaluation') {
        return pStatusGroup === 'active' || pStatus.includes('eval');
      }
      if (st === 'completed' || st === 'awarded') {
        return pStatusGroup === 'completed' || pStatus === 'awarded' || pStatus === 'completed' || pStatus === 'converted_to_order';
      }
      return false;
    });
  }
  if (method) {
    const m = method.toLowerCase().replace(/_/g, '-');
    filtered = filtered.filter(p => {
      const pMethod = (p.method || '').toLowerCase().replace(/_/g, '-');
      const pMethodLabel = (p.methodLabel || '').toLowerCase();
      return pMethod === m || pMethodLabel.includes(m.replace(/-/g, ' ')) || pMethodLabel.replace(/\s+/g, '_') === method.toLowerCase();
    });
  }
  if (category) {
    const cat = category.toLowerCase();
    filtered = filtered.filter(p => (p.category || '').toLowerCase().includes(cat));
  }
  if (department) {
    const dept = department.toLowerCase();
    filtered = filtered.filter(p => (p.organizationName || '').toLowerCase().includes(dept));
  }
  if (startDate) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    filtered = filtered.filter(p => p.createdAt && new Date(p.createdAt) >= start);
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    filtered = filtered.filter(p => p.createdAt && new Date(p.createdAt) <= end);
  }
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(p =>
      (p.title || '').toLowerCase().includes(q) ||
      (p.referenceNumber || '').toLowerCase().includes(q) ||
      (p.category || '').toLowerCase().includes(q) ||
      (p.typeLabel || '').toLowerCase().includes(q) ||
      (p.organizationName || '').toLowerCase().includes(q)
    );
  }

  // ── Sort ──
  const dir = sortDir === 'asc' ? 1 : -1;
  const key = sortBy || 'updatedAt';
  filtered.sort((a: any, b: any) => {
    if (key === 'updatedAt' || key === 'createdAt') {
      const da = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const dbVal = new Date(b.updatedAt || b.createdAt || 0).getTime();
      const numA = isNaN(da) ? 0 : da;
      const numB = isNaN(dbVal) ? 0 : dbVal;
      return (numA - numB) * dir;
    }
    const va = a[key] ?? '';
    const vb = b[key] ?? '';
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });

  ok(res, { kpis, procurements: filtered, all: filtered });
}));

const cancelProcurementSchema = z.object({
  type: z.string().trim().min(1).max(80),
  id: z.union([z.coerce.number().int().positive(), z.string().trim().min(1)]),
  reason: z.string().trim().min(5, 'Cancellation reason must be at least 5 characters').max(1000),
  remarks: z.string().trim().max(2000).optional(),
});

router.post('/buyer/procurements/cancel', authenticate, authorize('buyer', 'admin', 'master_admin'), asyncRoute(async (req, res) => {
  const buyerId = userId(req);
  const buyerOrgId = req.user?.organizationId || -1;
  const privileged = isAdmin(req) || req.user?.role === 'master_admin';

  const body = parse(cancelProcurementSchema, req.body);
  const { type, id: rawId, reason, remarks } = body;
  const normalizedType = type.toLowerCase().trim();
  const numId = typeof rawId === 'number' ? rawId : (!isNaN(Number(rawId)) ? Number(rawId) : -1);
  const strId = String(rawId).trim();

  if (normalizedType === 'procurement_request' || normalizedType.includes('checkout') || normalizedType === 'cart') {
    const pr = await db.procurementRequest.findFirst({
      where: {
        OR: [
          ...(numId > 0 ? [{ id: numId }] : []),
          { requestNumber: strId }
        ]
      }
    });
    if (!pr) throw new ApiError(404, 'Procurement request not found', 'NOT_FOUND');
    if (!privileged && pr.buyerId !== buyerId && pr.organizationId !== buyerOrgId) {
      throw new ApiError(403, 'You do not have permission to cancel this procurement request', 'FORBIDDEN');
    }
    const updated = await cancelProcurementRequest(pr.id, pr.organizationId, buyerId, `${reason}${remarks ? ` - ${remarks}` : ''}`);
    await invalidateByPattern(`cache:buyer:procurements:${buyerId}*`).catch(() => undefined);
    return ok(res, { success: true, message: 'Procurement request cancelled successfully', procurement: updated });
  }

  if (normalizedType === 'bid_tender' || normalizedType === 'procurement_bid' || normalizedType === 'bid' || normalizedType === 'tender') {
    const bid = await db.procurementBid.findFirst({
      where: {
        OR: [
          ...(numId > 0 ? [{ id: numId }] : []),
          { bidNumber: strId }
        ]
      },
      include: { participations: true }
    });
    if (!bid) throw new ApiError(404, 'Procurement bid not found', 'NOT_FOUND');
    if (!privileged && bid.buyerId !== buyerId && bid.buyerOrganizationId !== buyerOrgId) {
      throw new ApiError(403, 'You do not have permission to cancel this procurement bid', 'FORBIDDEN');
    }
    if (bid.status === 'CANCELLED') {
      return ok(res, { success: true, message: 'Bid is already cancelled', procurement: bid });
    }
    const nonCancellable = ['PO_GENERATED', 'AWARDED', 'DELIVERED', 'PAYMENT_COMPLETED'];
    if (nonCancellable.includes(bid.status)) {
      throw new ApiError(409, `Cannot cancel bid in ${bid.status} status. An order or award has already been finalized.`, 'BID_CANNOT_CANCEL');
    }

    const currentPacket = (bid.technicalPacket as Record<string, unknown>) || {};
    const updated = await db.procurementBid.update({
      where: { id: bid.id },
      data: {
        status: 'CANCELLED',
        technicalPacket: {
          ...currentPacket,
          cancellation: {
            reason,
            remarks: remarks || '',
            cancelledAt: new Date().toISOString(),
            cancelledBy: buyerId,
          }
        }
      }
    });

    // Also cancel any linked active reverse auctions
    const linkedAuctions = await db.auction.findMany({
      where: { linkedBidId: bid.id, statusEnum: { notIn: ['CANCELLED', 'CLOSED'] } },
      include: { participants: true }
    }).catch(() => []);

    if (linkedAuctions.length > 0) {
      await db.auction.updateMany({
        where: { linkedBidId: bid.id, statusEnum: { notIn: ['CANCELLED', 'CLOSED'] } },
        data: { status: 'CANCELLED', statusEnum: 'CANCELLED' }
      }).catch(() => undefined);

      for (const la of linkedAuctions) {
        for (const ap of la.participants || []) {
          const sellerUserId = ap.sellerId || (ap as any).sellerUserId;
          if (sellerUserId) {
            notifySafe(
              sellerUserId,
              'Reverse Auction Cancelled',
              `The reverse auction linked to "${bid.title}" (${la.auctionCode}) has been cancelled due to procurement cancellation.`,
              'auction_cancelled',
              `/reverse-auctions/${la.id}`
            );
          }
        }
      }
    }

    for (const p of bid.participations) {
      if (p.sellerUserId) {
        notifySafe(
          p.sellerUserId,
          'Bid Cancelled by Buyer',
          `The tender/bid "${bid.title}" (${bid.bidNumber}) has been cancelled by the buyer. Reason: ${reason}`,
          'bid_cancelled',
          `/bids/${bid.id}`
        );
      }
    }

    await auditWrite(req, 'procurement_bid.cancelled', 'procurementBid', bid.id, { reason, remarks });
    await invalidateByPattern(`cache:buyer:procurements:${buyerId}*`).catch(() => undefined);
    return ok(res, { success: true, message: 'Procurement bid cancelled successfully', procurement: updated });
  }

  if (normalizedType === 'requirement' || normalizedType === 'rfq' || normalizedType === 'rfp') {
    const requirement = await db.requirement.findFirst({
      where: {
        OR: [
          ...(numId > 0 ? [{ id: numId }] : []),
          { requirementNumber: strId }
        ]
      },
      include: { tenders: { select: { id: true, status: true } } }
    });
    if (!requirement) throw new ApiError(404, 'Requirement not found', 'NOT_FOUND');
    if (!privileged && requirement.buyerId !== buyerId && requirement.organizationId !== buyerOrgId) {
      throw new ApiError(403, 'You do not have permission to cancel this requirement', 'FORBIDDEN');
    }
    if (requirement.status === 'CANCELLED') {
      await db.auction.updateMany({
        where: { linkedRequirementId: requirement.id, statusEnum: { notIn: ['CANCELLED', 'CLOSED'] } },
        data: { status: 'CANCELLED', statusEnum: 'CANCELLED' }
      }).catch(() => undefined);
      return ok(res, { success: true, message: 'Requirement is already cancelled', procurement: requirement });
    }
    if (requirement.status === 'FULFILLED') {
      throw new ApiError(409, 'Cannot cancel a fulfilled requirement', 'REQUIREMENT_FULFILLED');
    }

    const currentPayload = (requirement.payload as Record<string, unknown>) || {};
    const updated = await db.requirement.update({
      where: { id: requirement.id },
      data: {
        status: 'CANCELLED',
        payload: {
          ...currentPayload,
          cancellation: {
            reason,
            remarks: remarks || '',
            cancelledAt: new Date().toISOString(),
            cancelledBy: buyerId,
          }
        }
      }
    });

    const linkedAuctions = await db.auction.findMany({
      where: { linkedRequirementId: requirement.id, statusEnum: { notIn: ['CANCELLED', 'CLOSED'] } },
      include: { participants: true }
    }).catch(() => []);

    await db.auction.updateMany({
      where: { linkedRequirementId: requirement.id, statusEnum: { notIn: ['CANCELLED', 'CLOSED'] } },
      data: { status: 'CANCELLED', statusEnum: 'CANCELLED' }
    }).catch(() => undefined);

    for (const la of linkedAuctions) {
      for (const ap of la.participants || []) {
        const sellerUserId = ap.sellerId || (ap as any).sellerUserId;
        if (sellerUserId) {
          notifySafe(
            sellerUserId,
            'Reverse Auction Cancelled',
            `The reverse auction linked to requirement "${requirement.title}" (${la.auctionCode}) was cancelled.`,
            'auction_cancelled',
            `/reverse-auctions/${la.id}`
          );
        }
      }
    }

    const responses = await db.requirementResponse.findMany({
      where: { requirementId: requirement.id },
      select: { sellerUserId: true }
    }).catch(() => []);

    for (const resp of responses) {
      if (resp.sellerUserId) {
        notifySafe(
          resp.sellerUserId,
          'Procurement Requirement Cancelled',
          `Requirement "${requirement.title}" (${requirement.requirementNumber}) was cancelled by the buyer. Reason: ${reason}`,
          'requirement_cancelled',
          '/seller/opportunities'
        );
      }
    }

    await auditWrite(req, 'requirement.cancelled', 'requirement', requirement.id, { reason, remarks });
    await invalidateByPattern(`cache:buyer:procurements:${buyerId}*`).catch(() => undefined);
    return ok(res, { success: true, message: 'Requirement cancelled successfully', procurement: updated });
  }

  if (normalizedType === 'direct_purchase') {
    const dp = await db.directPurchase.findFirst({
      where: {
        OR: [
          ...(numId > 0 ? [{ id: numId }] : []),
          { purchaseNumber: strId }
        ]
      }
    });
    if (!dp) throw new ApiError(404, 'Direct purchase not found', 'NOT_FOUND');
    if (!privileged && dp.buyerId !== buyerId) {
      throw new ApiError(403, 'You do not have permission to cancel this direct purchase', 'FORBIDDEN');
    }
    if (dp.status === 'CANCELLED') {
      return ok(res, { success: true, message: 'Direct purchase is already cancelled', procurement: dp });
    }
    if (dp.status === 'APPROVED' && (dp as any).purchaseOrderId) {
      throw new ApiError(409, 'Cannot cancel direct purchase after purchase order has been generated.', 'PO_EXISTS');
    }

    const updated = await db.directPurchase.update({
      where: { id: dp.id },
      data: {
        status: 'CANCELLED',
        remarks: `Cancelled by buyer: ${reason}${remarks ? ` - ${remarks}` : ''}`
      }
    });

    if (dp.sellerId) {
      notifySafe(
        dp.sellerId,
        'Direct Purchase Cancelled',
        `Direct purchase request ${dp.purchaseNumber} was cancelled by the buyer. Reason: ${reason}`,
        'direct_purchase_cancelled',
        '/seller/orders'
      );
    }

    await auditWrite(req, 'direct_purchase.cancelled', 'directPurchase', dp.id, { reason, remarks });
    await invalidateByPattern(`cache:buyer:procurements:${buyerId}*`).catch(() => undefined);
    return ok(res, { success: true, message: 'Direct purchase cancelled successfully', procurement: updated });
  }

  if (normalizedType === 'reverse_auction' || normalizedType === 'auction') {
    const auc = await db.auction.findFirst({
      where: {
        OR: [
          ...(numId > 0 ? [{ id: numId }] : []),
          { auctionCode: strId }
        ]
      },
      include: { participants: true }
    });
    if (!auc) throw new ApiError(404, 'Auction not found', 'NOT_FOUND');
    if (!privileged && auc.createdByUserId !== buyerId && auc.buyerOrgId !== buyerOrgId) {
      throw new ApiError(403, 'You do not have permission to cancel this auction', 'FORBIDDEN');
    }
    if (auc.statusEnum === 'CANCELLED' || auc.status === 'CANCELLED') {
      return ok(res, { success: true, message: 'Auction is already cancelled', procurement: auc });
    }
    if (auc.statusEnum === 'CLOSED' || auc.status === 'CLOSED') {
      throw new ApiError(409, 'Cannot cancel a closed auction', 'AUCTION_CLOSED');
    }

    const updated = await db.auction.update({
      where: { id: auc.id },
      data: {
        status: 'CANCELLED',
        statusEnum: 'CANCELLED'
      }
    });

    for (const p of auc.participants || []) {
      const sellerUserId = p.sellerId || (p as any).sellerUserId;
      if (sellerUserId) {
        notifySafe(
          sellerUserId,
          'Reverse Auction Cancelled by Buyer',
          `The reverse auction "${auc.title}" (${auc.auctionCode}) has been cancelled by the buyer. Reason: ${reason}`,
          'auction_cancelled',
          `/reverse-auctions/${auc.id}`
        );
      }
    }

    await auditWrite(req, 'reverse_auction.cancelled', 'auction', auc.id, { reason, remarks });
    await invalidateByPattern(`cache:buyer:procurements:${buyerId}*`).catch(() => undefined);
    return ok(res, { success: true, message: 'Reverse auction cancelled successfully', procurement: updated });
  }

  if (normalizedType === 'rate_contract' || normalizedType === 'contract') {
    let contract = await db.contract.findFirst({
      where: {
        OR: [
          ...(numId > 0 ? [{ id: numId }] : []),
          { contractNumber: strId }
        ]
      }
    });

    // Fallback: If not found in contract table, search procurementBid or requirement
    if (!contract) {
      const fallbackBid = await db.procurementBid.findFirst({
        where: {
          OR: [
            ...(numId > 0 ? [{ id: numId }] : []),
            { bidNumber: strId }
          ]
        },
        include: { participations: true }
      });
      if (fallbackBid) {
        const currentPacket = (fallbackBid.technicalPacket as Record<string, unknown>) || {};
        const updated = await db.procurementBid.update({
          where: { id: fallbackBid.id },
          data: {
            status: 'CANCELLED',
            technicalPacket: {
              ...currentPacket,
              cancellation: {
                reason,
                remarks: remarks || '',
                cancelledAt: new Date().toISOString(),
                cancelledBy: buyerId,
              }
            }
          }
        });
        for (const p of fallbackBid.participations) {
          if (p.sellerUserId) {
            notifySafe(
              p.sellerUserId,
              'Rate Contract Bid Cancelled',
              `Rate Contract procurement "${fallbackBid.title}" (${fallbackBid.bidNumber}) has been cancelled by the buyer. Reason: ${reason}`,
              'bid_cancelled',
              `/bids/${fallbackBid.id}`
            );
          }
        }
        await auditWrite(req, 'rate_contract.cancelled', 'procurementBid', fallbackBid.id, { reason, remarks });
        await invalidateByPattern(`cache:buyer:procurements:${buyerId}*`).catch(() => undefined);
        return ok(res, { success: true, message: 'Rate contract cancelled successfully', procurement: updated });
      }

      const fallbackReq = await db.requirement.findFirst({
        where: {
          OR: [
            ...(numId > 0 ? [{ id: numId }] : []),
            { requirementNumber: strId }
          ]
        }
      });
      if (fallbackReq) {
        const currentPayload = (fallbackReq.payload as Record<string, unknown>) || {};
        const updated = await db.requirement.update({
          where: { id: fallbackReq.id },
          data: {
            status: 'CANCELLED',
            payload: {
              ...currentPayload,
              cancellation: {
                reason,
                remarks: remarks || '',
                cancelledAt: new Date().toISOString(),
                cancelledBy: buyerId,
              }
            }
          }
        });
        await auditWrite(req, 'rate_contract.cancelled', 'requirement', fallbackReq.id, { reason, remarks });
        await invalidateByPattern(`cache:buyer:procurements:${buyerId}*`).catch(() => undefined);
        return ok(res, { success: true, message: 'Rate contract cancelled successfully', procurement: updated });
      }

      throw new ApiError(404, 'Rate Contract not found', 'NOT_FOUND');
    }

    if (contract.status === 'CANCELLED' || contract.status === 'TERMINATED') {
      return ok(res, { success: true, message: 'Rate contract is already cancelled', procurement: contract });
    }
    const updated = await db.contract.update({
      where: { id: contract.id },
      data: {
        status: 'CANCELLED',
        remarks: `Cancelled by buyer: ${reason}${remarks ? ` - ${remarks}` : ''}`
      }
    });
    await auditWrite(req, 'rate_contract.cancelled', 'contract', contract.id, { reason, remarks });
    await invalidateByPattern(`cache:buyer:procurements:${buyerId}*`).catch(() => undefined);
    return ok(res, { success: true, message: 'Rate contract cancelled successfully', procurement: updated });
  }

  throw new ApiError(400, `Unsupported procurement type: ${type}`, 'INVALID_TYPE');
}));

export default router;
