import prisma from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { uploadFile } from '../../services/storage/storage.service.js';
import type { AuthRequest, AuthenticatedUser } from '../../middleware/authenticate.js';
import { createOrReuseProcurementPOForAward, getSellerUserIdsForActor } from './procurement-order.service.js';
import { broadcastToProcurement, broadcastToUser } from '../../services/websocket.service.js';
import { logger } from '../../config/logger.js';
import { notificationService, resolveSellerOrgName } from '../../services/notification.service.js';
import { buildGovernmentGradeEmailHtml, ensurePublicUrl, formatIstDateTime, type TableRow } from '../../services/email-template.builder.js';
import { getPublicPortalUrl } from '../../config/env.js';
import { maskSensitive } from '../../utils/maskSensitive.js';
import { CANONICAL_METHOD_PREFIXES, getCanonicalLookupVariants } from '../../utils/refIdUtils.js';
import { getNextCanonicalSequence } from '../../services/sequence.service.js';
import { filterSealedDocuments } from './procurement-sealing.utils.js';
import { parseDateIST } from '../../utils/dateUtils.js';
import { notifySellerNewPurchaseOrder } from '../../services/invoice-pdf.service.js';

const db = prisma as any;

type Actor = AuthenticatedUser;

const publicBidStatuses = [
  'PENDING_ADMIN_APPROVAL',
  'APPROVED',
  'OPEN',
  'OPEN_FOR_BIDDING',
  'PUBLISHED',
  'CLOSED',
  'EXPIRED',
  'UNDER_EVALUATION',
  'TECHNICAL_EVALUATION',
  'TECHNICAL_EVALUATION_COMPLETED',
  'FINANCIAL_EVALUATION',
  'L1_GENERATED',
  'AWARD_RECOMMENDED',
  'AWARD_OFFERED',
  'AWARD_ACCEPTED',
  'AWARD_DECLINED',
  'AWARDED',
  'PO_GENERATED',
  'IN_PROGRESS',
  'DELIVERED',
  'GRN_COMPLETED',
  'INVOICE_SUBMITTED',
  'PAYMENT_COMPLETED',
  'COMPLETED',
  'NEGOTIATION'
];
export const financialOpenStatuses = ['FINANCIAL_EVALUATION', 'L1_GENERATED', 'AWARD_RECOMMENDED', 'AWARD_OFFERED', 'AWARD_ACCEPTED', 'AWARDED', 'PO_GENERATED', 'IN_PROGRESS', 'DELIVERED', 'GRN_COMPLETED', 'INVOICE_SUBMITTED', 'PAYMENT_COMPLETED', 'COMPLETED'];
const sellerVerifiedStatuses = ['approved_for_procurement', 'approved'];
const activeUserStatuses = ['ACTIVE'];
const verifiedOrganizationStatuses = ['VERIFIED'];
const editableBidStatuses = ['DRAFT'];
const editableApprovalStatuses = ['DRAFT', 'REJECTED'];
const technicalEvaluationStatuses = ['CLOSED', 'EXPIRED', 'TECHNICAL_EVALUATION', 'UNDER_EVALUATION'];
const financialEvaluationReadyStatuses = ['TECHNICAL_EVALUATION_COMPLETED', 'UNDER_EVALUATION', 'TECHNICAL_EVALUATION'];
const restrictedProcurementMethods = ['LIMITED_TENDER', 'REPEAT_ORDER'];

const bidTransitions: Record<string, string[]> = {
  DRAFT: ['PENDING_ADMIN_APPROVAL', 'PUBLISHED', 'OPEN', 'OPEN_FOR_BIDDING', 'CANCELLED'],
  PENDING_ADMIN_APPROVAL: ['APPROVED', 'PUBLISHED', 'OPEN', 'OPEN_FOR_BIDDING', 'DRAFT', 'CANCELLED'],
  APPROVED: ['OPEN', 'OPEN_FOR_BIDDING', 'PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['OPEN', 'OPEN_FOR_BIDDING', 'CLOSED', 'EXPIRED', 'UNDER_EVALUATION', 'TECHNICAL_EVALUATION', 'CANCELLED'],
  OPEN: ['CLOSED', 'EXPIRED', 'UNDER_EVALUATION', 'TECHNICAL_EVALUATION', 'CANCELLED'],
  OPEN_FOR_BIDDING: ['CLOSED', 'EXPIRED', 'UNDER_EVALUATION', 'TECHNICAL_EVALUATION', 'CANCELLED'],
  CLOSED: ['OPEN', 'OPEN_FOR_BIDDING', 'UNDER_EVALUATION', 'TECHNICAL_EVALUATION', 'CANCELLED'],
  EXPIRED: ['OPEN', 'OPEN_FOR_BIDDING', 'UNDER_EVALUATION', 'TECHNICAL_EVALUATION', 'CANCELLED'],
  TECHNICAL_EVALUATION: ['TECHNICAL_EVALUATION_COMPLETED', 'UNDER_EVALUATION', 'CANCELLED'],
  TECHNICAL_EVALUATION_COMPLETED: ['FINANCIAL_EVALUATION', 'L1_GENERATED', 'UNDER_EVALUATION', 'CANCELLED'],
  FINANCIAL_EVALUATION: ['L1_GENERATED', 'AWARD_RECOMMENDED', 'AWARD_OFFERED', 'UNDER_EVALUATION', 'CANCELLED'],
  L1_GENERATED: ['AWARD_RECOMMENDED', 'AWARD_OFFERED', 'AWARDED', 'CANCELLED'],
  AWARD_RECOMMENDED: ['AWARD_OFFERED', 'AWARD_ACCEPTED', 'AWARDED', 'CANCELLED'],
  AWARD_OFFERED: ['AWARD_ACCEPTED', 'AWARD_DECLINED', 'UNDER_EVALUATION', 'PO_GENERATED', 'CANCELLED'],
  AWARD_ACCEPTED: ['PO_GENERATED', 'IN_PROGRESS', 'CANCELLED'],
  AWARD_DECLINED: ['UNDER_EVALUATION', 'FINANCIAL_EVALUATION', 'AWARD_OFFERED', 'CANCELLED'],
  AWARDED: ['PO_GENERATED', 'CANCELLED'],
  PO_GENERATED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['DELIVERED', 'CANCELLED'],
  DELIVERED: ['GRN_COMPLETED', 'CANCELLED'],
  GRN_COMPLETED: ['INVOICE_SUBMITTED', 'CANCELLED'],
  INVOICE_SUBMITTED: ['PAYMENT_COMPLETED', 'CANCELLED'],
  PAYMENT_COMPLETED: ['COMPLETED', 'CLOSED', 'CANCELLED'],
  UNDER_EVALUATION: ['TECHNICAL_EVALUATION', 'TECHNICAL_EVALUATION_COMPLETED', 'FINANCIAL_EVALUATION', 'L1_GENERATED', 'AWARD_OFFERED', 'AWARDED', 'NEGOTIATION', 'CANCELLED'],
  NEGOTIATION: ['AWARD_OFFERED', 'AWARDED', 'CANCELLED'],
  CANCELLED: []
};

const maskedQuote = {
  quotedAmount: null,
  gstPercentage: null,
  totalAmount: null,
  financialSealed: true,
  message: 'Financial quote is sealed until financial evaluation.'
};

const assertActiveAccount = (user: any, roleLabel: string) => {
  if (!user || !activeUserStatuses.includes(String(user.accountStatus || 'ACTIVE'))) {
    throw new ApiError(403, `${roleLabel} account is not active for procurement actions.`, 'FORBIDDEN_ROLE');
  }
};

const assertBidTransition = (from: string, to: string, message?: string) => {
  if (from === to) return;
  if (!(bidTransitions[from] || []).includes(to)) {
    throw new ApiError(400, message || `Bid cannot move from ${from} to ${to}.`, 'INVALID_STATUS_TRANSITION');
  }
};

const firstPresent = (...values: any[]) => values.find(value => value !== undefined && value !== null && String(value).trim() !== '');

const arrayFromPacket = (...values: any[]) => {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
};

const normalizeBidItem = (item: any, index: number) => {
  const specifications = item?.specifications && typeof item.specifications === 'object' ? item.specifications : {};
  const technicalSpecification = firstPresent(item?.technicalSpecification, item?.technicalSpecifications, item?.specification, item?.specificationsText, item?.requirements, specifications.technicalSpecification, specifications.technicalSpecifications, specifications.description);
  const hsnSac = firstPresent(item?.hsn_sac_code, item?.hsnSacCode, item?.hsnSac, item?.hsn, item?.hsnCode, item?.sac, item?.sacCode, item?.product?.hsnCode, specifications.hsn_sac_code, specifications.hsnSacCode, specifications.hsnSac, specifications.hsn, specifications.hsnCode, specifications.sac, specifications.sacCode);
  const unit = firstPresent(item?.unit, item?.unitOfMeasure, item?.uom, item?.unitOfMeasurement, item?.product?.unitOfMeasure, specifications.unit, specifications.unitOfMeasure, specifications.uom);
  const rawUnitPrice = firstPresent(item?.estimatedUnitPrice, item?.unitPrice, item?.estimatedRate, item?.price, item?.rate, specifications.estimatedUnitPrice, specifications.unitPrice, specifications.estimatedRate, specifications.price, specifications.rate);
  const rawBrand = firstPresent(item?.brand_preference, item?.brandPreference, item?.brandRequirement, item?.brand, item?.brandName, item?.make, item?.oemBrandName, specifications.brand_preference, specifications.brandPreference, specifications.brandRequirement, specifications.brand, specifications.brandName, specifications.make);
  const rawFlexible = firstPresent(item?.brand_flexible, item?.brandFlexible, item?.isBrandFlexible, specifications.brand_flexible, specifications.brandFlexible, specifications.isBrandFlexible, item?.alternateBrandAllowed, specifications.alternateBrandAllowed);
  const rawType = firstPresent(item?.itemType, item?.type, specifications.itemType, specifications.type) || 'Product';

  return {
    ...item,
    id: String(firstPresent(item?.id, item?.lineItemId, item?.itemId, index + 1)),
    itemType: rawType,
    itemName: firstPresent(item?.itemName, item?.name, item?.title, item?.productName, item?.serviceName, item?.product?.name, item?.description, item?.itemDescription) || `Item ${index + 1}`,
    description: firstPresent(item?.description, item?.itemDescription, item?.scopeOfWork, item?.productDescription, item?.serviceDescription, specifications.description) || technicalSpecification || '',
    quantity: Number(firstPresent(item?.quantity, item?.qty, item?.requiredQuantity, 1)) || 1,
    unit: unit || 'Nos',
    unitOfMeasure: unit || 'Nos',
    estimatedUnitPrice: rawUnitPrice !== undefined && rawUnitPrice !== null ? Number(rawUnitPrice) : undefined,
    technicalSpecification: technicalSpecification || '',
    brand_preference: rawBrand || '',
    brandPreference: rawBrand || '',
    brandRequirement: rawBrand || null,
    brand_flexible: rawFlexible ?? 'Yes',
    brandFlexible: rawFlexible ?? 'Yes',
    warrantyRequirement: firstPresent(item?.warrantyRequirement, item?.warranty, item?.warrantyRequired, item?.warrantyPeriod, specifications.warrantyRequirement, specifications.warranty) || null,
    deliveryRequirement: firstPresent(item?.deliveryRequirement, item?.deliverySchedule, item?.deliveryTimeline, item?.deliverySla, specifications.deliveryRequirement, specifications.deliverySchedule) || null,
    buyerRemarks: firstPresent(item?.buyerRemarks, item?.remarks, item?.buyerRemark, item?.notes, specifications.buyerRemarks, specifications.remarks) || null,
    hsnSac: hsnSac || '',
    hsn_sac_code: hsnSac || '',
    hsn: firstPresent(item?.hsn, item?.hsnCode, item?.product?.hsnCode, specifications.hsn, specifications.hsnCode) || hsnSac || '',
    sac: firstPresent(item?.sac, item?.sacCode, specifications.sac, specifications.sacCode) || '',
    gstPercentage: firstPresent(item?.gstPercentage, item?.gst, item?.taxRate, specifications.gstPercentage, specifications.gst) ?? null,
    priceQuoteBasis: firstPresent(item?.priceQuoteBasis, item?.quoteBasis) || null,
    specifications: {
      ...specifications,
      itemType: rawType,
      hsn_sac_code: hsnSac || '',
      brand_preference: rawBrand || '',
      brand_flexible: rawFlexible ?? 'Yes',
      estimatedUnitPrice: rawUnitPrice !== undefined && rawUnitPrice !== null ? Number(rawUnitPrice) : undefined,
    }
  };
};

const normalizeBidItems = (bid: any) => {
  const packet = bid?.technicalPacket && typeof bid.technicalPacket === 'object' ? bid.technicalPacket : {};
  const wizardData = packet?.wizardData && typeof packet.wizardData === 'object' ? packet.wizardData : {};
  return arrayFromPacket(bid?.items, packet?.items, packet?.boq, packet?.boqItems, packet?.lineItems, packet?.itemRateSchedule, wizardData?.items, wizardData?.boq, wizardData?.lineItems).map(normalizeBidItem);
};

const rankToFinalStatus = (rank: number) => {
  if (rank === 1) return 'L1';
  if (rank === 2) return 'L2';
  if (rank === 3) return 'L3';
  if (rank === 4) return 'L4';
  return 'NOT_SELECTED';
};

export const isRestrictedBidMethod = (bid: any) => {
  const pType = String(bid?.procurementType || '').toUpperCase();
  const bType = String(bid?.bidType || '').toUpperCase();
  const rfqType = String(
    bid?.technicalPacket?.vendors?.rfqType ||
    bid?.technicalPacket?.rfqType ||
    bid?.technicalPacket?.wizardData?.rfqType ||
    ''
  ).toUpperCase();
  if (restrictedProcurementMethods.includes(pType) || restrictedProcurementMethods.includes(bType)) return true;
  if (rfqType === 'LIMITED') return true;
  return false;
};

export const isActorInvitedToBid = (actor: Actor | null | undefined, bid: any) => {
  if (!actor || actor.role !== 'seller') return false;
  const actorUserId = Number(actor.id);
  const actorOrgId = Number(actor.organizationId);

  // Preferred source of truth: relational invitation rows.
  if (Array.isArray(bid?.invitations) && bid.invitations.length) {
    if (bid.invitations.some((inv: any) => {
      const orgMatch = Number.isFinite(actorOrgId) && actorOrgId > 0 && Number(inv.sellerOrgId) === actorOrgId;
      const userMatch = Number.isFinite(actorUserId) && actorUserId > 0 && Number(inv.sellerUserId) === actorUserId;
      return orgMatch || userMatch;
    })) {
      return true;
    }
  }

  // Backwards-compatible fallback: invited sellers embedded in technicalPacket JSON
  // (covers rows created before the invitation table existed / not yet backfilled).
  const packet = bid?.technicalPacket && typeof bid.technicalPacket === 'object' ? bid.technicalPacket : {};
  const invited = Array.isArray(packet?.vendors?.invitedSellers)
    ? packet.vendors.invitedSellers
    : Array.isArray(packet?.qualifiedVendors)
      ? packet.qualifiedVendors
      : [];
  return invited.some((entry: any) => {
    if (entry && typeof entry === 'object') {
      const orgId = Number(entry.sellerOrgId ?? entry.supplierId ?? entry.organizationId ?? 0);
      const userId = Number(entry.sellerUserId ?? entry.userId ?? 0);
      if (orgId > 0 && Number.isFinite(actorOrgId) && actorOrgId === orgId) return true;
      if (userId > 0 && Number.isFinite(actorUserId) && actorUserId === userId) return true;
      if (!orgId && !userId && Number(entry.id) > 0) {
        return (Number.isFinite(actorOrgId) && actorOrgId === Number(entry.id)) || (Number.isFinite(actorUserId) && actorUserId === Number(entry.id));
      }
      return false;
    }
    const num = Number(entry);
    return (Number.isFinite(actorOrgId) && actorOrgId === num) || (Number.isFinite(actorUserId) && actorUserId === num);
  });
};

// Single source of truth for whether a procurement is invite-only ("PRIVATE") vs "PUBLIC".
// Prefers the explicit `visibility` column; falls back to method-name/selection heuristics
// for rows created before the column existed or where legacy visibility was set to PUBLIC.
export const isPrivateBid = (bid: any) => {
  if (isRestrictedBidMethod(bid)) return true;
  if (bid?.visibility === 'PRIVATE') {
    const pType = String(bid?.procurementType || '').toUpperCase();
    const bType = String(bid?.bidType || '').toUpperCase();
    const rfqType = String(
      bid?.technicalPacket?.vendors?.rfqType ||
      bid?.technicalPacket?.rfqType ||
      bid?.technicalPacket?.wizardData?.rfqType ||
      ''
    ).toUpperCase();
    const selection = String(
      bid?.technicalPacket?.vendors?.selection
      ?? bid?.technicalPacket?.wizardData?.vendors?.selection
      ?? ''
    ).toUpperCase();
    if (
      restrictedProcurementMethods.includes(pType) ||
      restrictedProcurementMethods.includes(bType) ||
      rfqType === 'LIMITED' ||
      selection === 'LIMITED' ||
      pType === 'LIMITED_TENDER' ||
      bType === 'LIMITED_TENDER'
    ) {
      return true;
    }
  }
  return false;
};

// Derive the visibility value to persist at create/publish time from the method + vendor selection.
export const deriveVisibility = (input: { procurementType?: string | null; bidType?: string | null; technicalPacket?: any; rfqType?: string | null; visibility?: string | null }) => {
  const pType = String(input?.procurementType || '').toUpperCase();
  const bType = String(input?.bidType || '').toUpperCase();
  const rfqType = String(
    input?.rfqType ||
    input?.technicalPacket?.rfqType ||
    input?.technicalPacket?.vendors?.rfqType ||
    input?.technicalPacket?.wizardData?.rfqType ||
    ''
  ).toUpperCase();
  const selection = String(
    input?.technicalPacket?.vendors?.selection
    ?? input?.technicalPacket?.wizardData?.vendors?.selection
    ?? ''
  ).toUpperCase();
  const restricted = restrictedProcurementMethods.includes(pType)
    || restrictedProcurementMethods.includes(bType)
    || rfqType === 'LIMITED'
    || selection === 'LIMITED'
    || pType === 'LIMITED_TENDER'
    || bType === 'LIMITED_TENDER';
  return restricted ? 'PRIVATE' : 'PUBLIC';
};

// Extract invited-seller ids (as numbers) from a technicalPacket blob, tolerant of the
// several historical shapes (primitive ids or objects with various id keys).
export const extractInvitedSellerIds = (technicalPacket: any): number[] => {
  const packet = technicalPacket && typeof technicalPacket === 'object' ? technicalPacket : {};
  const vendors = packet.vendors || packet.wizardData?.vendors || {};
  const list = Array.isArray(vendors.invitedSellers)
    ? vendors.invitedSellers
    : Array.isArray(packet.qualifiedVendors)
      ? packet.qualifiedVendors
      : [];
  const ids = new Set<number>();
  for (const entry of list) {
    let value: any;
    if (entry && typeof entry === 'object') {
      value = entry.sellerOrgId ?? entry.supplierId ?? entry.organizationId ?? entry.sellerUserId ?? entry.userId ?? entry.id;
    } else {
      value = entry;
    }
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) ids.add(num);
  }
  return [...ids];
};

// Persist relational invitation rows for a bid from its technicalPacket. Idempotent.
export const syncBidInvitations = async (bidId: number, technicalPacket: any, invitedById?: number) => {
  const packet = technicalPacket && typeof technicalPacket === 'object' ? technicalPacket : {};
  const vendors = packet.vendors || packet.wizardData?.vendors || {};
  const list = Array.isArray(vendors.invitedSellers)
    ? vendors.invitedSellers
    : Array.isArray(packet.qualifiedVendors)
      ? packet.qualifiedVendors
      : [];
  if (!list.length) return;

  const invitationRows: Array<{ bidId: number; sellerOrgId?: number | null; sellerUserId?: number | null; invitedById?: number | null }> = [];
  const seenKeys = new Set<string>();

  for (const entry of list) {
    let orgId: number | null = null;
    let userId: number | null = null;
    if (entry && typeof entry === 'object') {
      const parsedOrg = Number(entry.sellerOrgId ?? entry.organizationId ?? entry.supplierId ?? 0);
      const parsedUser = Number(entry.sellerUserId ?? entry.userId ?? 0);
      if (parsedOrg > 0) orgId = parsedOrg;
      if (parsedUser > 0) userId = parsedUser;
      if (!orgId && !userId && Number(entry.id) > 0) {
        orgId = Number(entry.id);
      }
    } else {
      const num = Number(entry);
      if (Number.isFinite(num) && num > 0) {
        orgId = num;
      }
    }

    const key = `${orgId ?? 'none'}:${userId ?? 'none'}`;
    if ((orgId || userId) && !seenKeys.has(key)) {
      seenKeys.add(key);
      invitationRows.push({
        bidId,
        sellerOrgId: orgId,
        sellerUserId: userId,
        invitedById: invitedById ?? null
      });
    }
  }

  if (invitationRows.length > 0) {
    await db.procurementBidInvitation.createMany({
      data: invitationRows,
      skipDuplicates: true
    }).catch(() => undefined);
  }
};

// THE authorization gate: can this actor view the full detail of this bid?
// Public bids are viewable by anyone; private bids only by the owner, an invited
// seller, a participant, or an admin. `bid` should be loaded with `invitations` and
// `participations` for accurate results.
export const canActorViewBid = (actor: Actor | null | undefined, bid: any) => {
  if (!isPrivateBid(bid)) return true;
  if (!actor) return false;
  if (actor.role === 'admin' || actor.role === 'master_admin') return true;
  if (actor.role === 'buyer') {
    if (bid.buyerId === Number(actor.id)) return true;
    if (actor.organizationId && (
      (bid.buyerOrganizationId && Number(bid.buyerOrganizationId) === Number(actor.organizationId)) ||
      (bid.buyer?.organizationId && Number(bid.buyer.organizationId) === Number(actor.organizationId))
    )) return true;
  }
  if (actor.role === 'seller' || actor.role === 'shg') {
    const hasParticipation = (bid.participations || []).some((p: any) => 
      p.sellerId === Number(actor.id) || 
      (actor.organizationId && p.seller?.organizationId === Number(actor.organizationId))
    );
    if (hasParticipation) return true;
    if (isActorInvitedToBid(actor, bid)) return true;
  }
  return false;
};

export const now = () => new Date();

export const moneyNumber = (value: unknown) => value == null ? null : Number(value);

export const procurementAudit = async (
  req: Pick<AuthRequest, 'user' | 'ip' | 'headers'>,
  action: string,
  entityType: string,
  entityId: string | number,
  newValue?: unknown,
  oldValue?: unknown
) => db.procurementAuditLog.create({
  data: {
    userId: req.user?.id,
    role: req.user?.role,
    entityType,
    entityId: String(entityId),
    action,
    oldValue: oldValue as any,
    newValue: newValue as any,
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent']
  }
});

export const bidInclude: any = {
  documents: true,
  invitations: true,
  buyer: {
    select: {
      id: true,
      name: true,
      email: true,
      mobile: true,
      role: true,
      buyerProfile: {
        select: {
          id: true,
          organizationName: true,
          organizationType: true,
          department: true,
          designation: true,
          representativeName: true,
          email: true,
          mobile: true,
          registeredAddress: true,
          corporateAddress: true,
          city: true,
          district: true,
          state: true,
          pincode: true
        }
      }
    }
  },
  buyerOrganization: { select: { id: true, organizationName: true, organizationType: true, verificationStatus: true, city: true, district: true, state: true } },
  participations: {
    include: {
      seller: { select: { id: true, name: true, email: true, mobile: true, role: true, onboardingStatus: true, organizationId: true, sellerProfile: { select: { mobile: true, businessName: true } }, organization: { select: { id: true, organizationName: true, city: true, district: true, state: true, addressLine1: true, addressLine2: true, pincode: true } } } },
      documents: true,
      clarifications: { include: { files: true } },
      evaluations: true,
      awards: true
    }
  },
  clarifications: {
    include: {
      files: true,
      seller: { select: { id: true, name: true } }
    }
  },
  evaluations: true,
  awards: true
};

export const leanBidInclude = {
  buyer: {
    select: {
      id: true,
      name: true,
      email: true,
      mobile: true,
      role: true,
      organizationId: true,
      buyerProfile: {
        select: {
          id: true,
          organizationName: true,
          organizationType: true,
          department: true,
          designation: true,
          representativeName: true,
          email: true,
          mobile: true,
          registeredAddress: true,
          corporateAddress: true,
          city: true,
          district: true,
          state: true,
          pincode: true
        }
      }
    }
  },
  buyerOrganization: { select: { id: true, organizationName: true, organizationType: true, verificationStatus: true, city: true, district: true, state: true } },
  documents: true,
  invitations: true,
  participations: {
    include: {
      seller: { select: { id: true, name: true, email: true, mobile: true, role: true, onboardingStatus: true, organizationId: true, sellerProfile: { select: { mobile: true, businessName: true } }, organization: { select: { id: true, organizationName: true, city: true, district: true, state: true, addressLine1: true, addressLine2: true, pincode: true } } } },
      documents: true
    }
  },
  clarifications: {
    include: {
      seller: { select: { id: true, name: true } }
    }
  },
  awards: {
    include: {
      seller: { select: { id: true, name: true, email: true, organization: { select: { organizationName: true } } } },
      participation: true
    }
  }
};

export const nextBidNumber = async (method = 'RFQ') => {
  return getNextCanonicalSequence(method);
};

export const nextParticipationNumber = async (bidNumber: string) => {
  const count = await db.procurementBidParticipation.count({
    where: { bid: { bidNumber } }
  });
  return `${bidNumber}-P${String(count + 1).padStart(4, '0')}`;
};

export const nextClarificationNumber = async (bidNumber: string) => {
  const count = await db.procurementBidClarification.count({
    where: { bid: { bidNumber } }
  });
  return `${bidNumber}-CLR-${String(count + 1).padStart(3, '0')}`;
};

export const resolveAuctionAsBidRecord = async (token: string, client: any = db) => {
  const stripped = token.replace(/^(RA-|PRC-|AUCTION-)/i, '');
  const rawNum = Number(stripped);
  const isNum = /^\d+$/.test(stripped) && Number.isFinite(rawNum) && rawNum > 0 && rawNum <= 2147483647;
  const validId = isNum ? rawNum : 0;

  const auction = await client.auction.findFirst({
    where: {
      OR: [
        { auctionCode: token },
        { referenceNo: token },
        { auctionCode: stripped },
        { referenceNo: stripped },
        ...(validId > 0 ? [{ id: validId }, { linkedRequirementId: validId }, { linkedBidId: validId }] : [])
      ]
    },
    include: {
      bids: {
        where: { isValid: true },
        orderBy: [{ amount: 'asc' }, { bidAmount: 'asc' }, { submittedAt: 'asc' }]
      }
    }
  });

  if (!auction) return null;

  // Query linked procurement bid if exists
  const candidateRefs: string[] = [];
  if (auction.referenceNo) {
    candidateRefs.push(auction.referenceNo);
    const stripped = auction.referenceNo.replace(/^(RA-|PRC-|AUCTION-|TENDER-|TND-|RFQ-|RFP-|RC-|RATE-)/i, '');
    if (stripped && stripped !== auction.referenceNo) candidateRefs.push(stripped);
  }
  const configParentRef = (auction.auctionConfig as any)?.parentRefNumber;
  if (configParentRef && typeof configParentRef === 'string') {
    candidateRefs.push(configParentRef);
  }
  const configParentId = (auction.auctionConfig as any)?.parentProcurementId;
  const configNumId = Number(configParentId);
  const resolvedBidId = auction.linkedBidId ? Number(auction.linkedBidId) : (Number.isFinite(configNumId) && configNumId > 0 ? configNumId : null);

  let linkedBid: any = null;
  if (resolvedBidId || candidateRefs.length > 0) {
    linkedBid = await client.procurementBid.findFirst({
      where: {
        OR: [
          ...(resolvedBidId ? [{ id: resolvedBidId }] : []),
          ...(candidateRefs.length > 0 ? [{ bidNumber: { in: candidateRefs } }] : [])
        ]
      },
      include: {
        participations: {
          where: { isWithdrawn: false },
          include: {
            seller: { include: { organization: true, sellerProfile: true } },
            documents: true
          }
        },
        buyer: { include: { buyerProfile: true, organization: true } },
        buyerOrganization: true,
        awards: true,
        documents: true
      }
    }).catch(() => null);
  }

  // Query linked requirement or buyerRequirement if exists
  let linkedReq: any = null;
  if (auction.linkedRequirementId || auction.referenceNo) {
    const buyerReq = await client.buyerRequirement.findFirst({
      where: {
        OR: [
          ...(auction.linkedRequirementId ? [{ id: Number(auction.linkedRequirementId) }] : []),
          ...(auction.referenceNo ? [{ referenceNumber: auction.referenceNo }] : [])
        ]
      },
      include: {
        buyerOrganization: true,
        createdBy: { include: { buyerProfile: true, organization: true } },
        category: true
      }
    }).catch(() => null);

    if (buyerReq) {
      linkedReq = {
        ...buyerReq,
        buyer: buyerReq.createdBy,
        organization: buyerReq.buyerOrganization
      };
    } else if (auction.linkedRequirementId) {
      linkedReq = await client.requirement.findUnique({
        where: { id: Number(auction.linkedRequirementId) },
        include: {
          items: true,
          organization: true,
          buyer: { include: { buyerProfile: true, organization: true } }
        }
      }).catch(() => null);
    }
  }

  // Query buyer organization
  let buyerOrg: any = linkedBid?.buyerOrganization || linkedReq?.organization || null;
  if (!buyerOrg && auction.buyerOrgId) {
    buyerOrg = await client.organization.findUnique({
      where: { id: auction.buyerOrgId }
    }).catch(() => null);
  }

  // Query buyer user
  let buyerUser: any = linkedBid?.buyer || linkedReq?.buyer || null;
  if (!buyerUser && auction.createdByUserId) {
    buyerUser = await client.user.findUnique({
      where: { id: auction.createdByUserId },
      include: { buyerProfile: true, organization: true }
    }).catch(() => null);
  }

  // Query participants
  const participants = await client.auctionParticipant.findMany({
    where: { auctionId: auction.id },
    include: {
      qualificationDocuments: true
    },
    orderBy: [{ currentRank: 'asc' }, { lastBidAmount: 'asc' }, { id: 'asc' }]
  }).catch(() => []);

  const orgIds = participants.map((p: any) => p.sellerOrgId).filter(Boolean);
  const orgs = orgIds.length > 0 ? await client.organization.findMany({
    where: { id: { in: orgIds } }
  }).catch(() => []) : [];
  const orgMap = new Map<number, any>(orgs.map((o: any) => [o.id, o]));

  const userIds = participants.map((p: any) => p.sellerUserId).filter(Boolean);
  const users = userIds.length > 0 ? await client.user.findMany({
    where: { id: { in: userIds } },
    include: { sellerProfile: true, organization: true }
  }).catch(() => []) : [];
  const userMap = new Map<number, any>(users.map((u: any) => [u.id, u]));

  // Standardize participations
  const mappedParticipations = participants.map((p: any, idx: number) => {
    const org = orgMap.get(p.sellerOrgId);
    const u = userMap.get(p.sellerUserId);
    const linkedPart = (linkedBid?.participations || []).find((lp: any) =>
      lp.sellerId === p.sellerUserId ||
      lp.sellerUserId === p.sellerUserId ||
      lp.sellerOrgId === p.sellerOrgId ||
      lp.seller?.organizationId === p.sellerOrgId
    );

    const bidsByP = (auction.bids || []).filter((b: any) =>
      b.participantId === p.id ||
      b.sellerOrgId === p.sellerOrgId ||
      b.sellerId === p.sellerUserId
    );
    const lowestBid = bidsByP[0];
    const bestAmount = Number(
      p.lastBidAmount ||
      (lowestBid ? (lowestBid.amount || lowestBid.bidAmount) : null) ||
      p.initialQuoteTotal ||
      p.initialQuoteAmount ||
      auction.currentLowestBid ||
      linkedPart?.totalPrice ||
      0
    );

    const initialQuote = Number(
      p.initialQuoteTotal ||
      p.initialQuoteAmount ||
      linkedPart?.totalPrice ||
      linkedPart?.quotedAmount ||
      bestAmount
    );

    const rankNum = p.currentRank || (idx + 1);
    const rankStr = `L${rankNum}`;
    const isWinner = auction.winnerSellerId
      ? (auction.winnerSellerId === p.sellerUserId || auction.winnerSellerId === p.sellerOrgId)
      : (rankNum === 1);
    const isAwardAccepted = auction.status === 'AWARD_ACCEPTED' || (isWinner && p.status === 'ACCEPTED');
    const isAwardRecommended = auction.status === 'AWARD_RECOMMENDED' || auction.statusEnum === 'AWARD_RECOMMENDED';
    const finalStatus = isAwardAccepted ? 'AWARDED' : (isWinner && isAwardRecommended ? 'AWARD_RECOMMENDED' : (p.status === 'ACCEPTED' ? 'AWARDED' : 'SUBMITTED'));

    const sellerName = org?.organizationName || u?.name || linkedPart?.sellerName || `Supplier #${p.id}`;
    const contactPerson = u?.name || linkedPart?.contactPerson || 'Representative';
    const sellerEmail = u?.email || linkedPart?.sellerEmail || '';
    const sellerMobile = u?.mobile || linkedPart?.sellerMobile || '';

    const ackData = typeof linkedPart?.acknowledgement === 'string'
      ? (() => { try { return JSON.parse(linkedPart.acknowledgement); } catch { return {}; } })()
      : (linkedPart?.acknowledgement || {});
    const respData = typeof linkedPart?.responseData === 'string'
      ? (() => { try { return JSON.parse(linkedPart.responseData); } catch { return {}; } })()
      : (linkedPart?.responseData || {});

    const candidateDocs = [
      ...(Array.isArray(linkedPart?.documents) ? linkedPart.documents : []),
      ...(Array.isArray(ackData?.documents) ? ackData.documents : []),
      ...(Array.isArray(ackData?.attachments) ? ackData.attachments : []),
      ...(Array.isArray(respData?.documents) ? respData.documents : []),
      ...(Array.isArray(respData?.attachments) ? respData.attachments : []),
      ...(Array.isArray(p.qualificationDocuments) ? p.qualificationDocuments.map((d: any, dIdx: number) => ({
          id: d.id || `doc-${p.id}-${dIdx}`,
          name: d.documentName || d.documentType || 'Qualification Document',
          fileName: d.documentName || 'Document',
          fileUrl: d.documentUrl || d.url,
          fileAssetId: d.fileAssetId || null,
          documentCategory: d.documentType || 'TECHNICAL_COMPLIANCE'
        })) : [])
    ];

    const rawLineItems = (Array.isArray(linkedPart?.lineItems) && linkedPart.lineItems.length > 0)
      ? linkedPart.lineItems
      : (Array.isArray(ackData?.lineItems) && ackData.lineItems.length > 0)
      ? ackData.lineItems
      : (Array.isArray(respData?.lineItems) && respData.lineItems.length > 0)
      ? respData.lineItems
      : [];

    const resolvedLineItems = rawLineItems.length > 0
      ? rawLineItems.map((li: any) => ({
          ...li,
          unitRate: (bestAmount > 0 && li.quantity > 0) ? Math.round((bestAmount / li.quantity) * 100) / 100 : li.unitRate,
          unitPrice: (bestAmount > 0 && li.quantity > 0) ? Math.round((bestAmount / li.quantity) * 100) / 100 : li.unitPrice,
          lineTotal: bestAmount > 0 ? bestAmount : li.lineTotal,
          totalAmount: bestAmount > 0 ? bestAmount : li.totalAmount
        }))
      : [{
          itemName: auction.title || 'Procurement requirement',
          description: auction.description || 'Reverse auction item',
          quantity: 1,
          unitOfMeasure: 'Nos',
          unitPrice: bestAmount,
          unitRate: bestAmount,
          lineTotal: bestAmount,
          totalAmount: bestAmount,
          makeBrand: p.makeBrand || 'Standard',
          model: p.model || 'Standard'
        }];

    const resolvedItemDesc = linkedPart?.offeredItemDescription || ackData?.offeredItemDescription || respData?.offeredItemDescription || auction.title || 'Procurement requirement';

    return {
      id: p.id,
      participationId: p.id,
      bidId: auction.id,
      sellerId: p.sellerUserId || linkedPart?.sellerId || u?.id,
      sellerUserId: p.sellerUserId || linkedPart?.sellerUserId || u?.id,
      sellerOrgId: p.sellerOrgId || linkedPart?.sellerOrgId || org?.id,
      sellerName,
      contactPerson,
      sellerEmail,
      sellerMobile,
      sellerType: 'Verified Seller',
      seller: {
        id: p.sellerUserId || u?.id,
        name: sellerName,
        email: sellerEmail,
        mobile: sellerMobile,
        role: 'seller',
        organization: org ? { id: org.id, organizationName: org.organizationName } : null
      },
      technicalStatus: p.qualificationStatus === 'APPROVED' ? 'QUALIFIED'
        : (p.qualificationStatus === 'REJECTED' ? 'DISQUALIFIED' : 'QUALIFIED'),
      financialStatus: 'OPENED',
      financialSealed: false,
      rank: rankNum,
      finalRank: rankStr,
      finalStatus,
      resultStatus: isAwardAccepted ? 'Awarded' : (isWinner && isAwardRecommended ? 'Awarded' : 'Responsive'),
      totalPrice: bestAmount,
      quotedAmount: bestAmount,
      totalAmount: bestAmount,
      initialQuoteAmount: initialQuote,
      savingsAmount: initialQuote > bestAmount ? initialQuote - bestAmount : 0,
      makeBrand: p.makeBrand || linkedPart?.makeBrand || ackData?.makeBrand || 'Standard',
      model: p.model || linkedPart?.model || ackData?.model || 'Standard',
      offeredItem: resolvedItemDesc,
      offeredItemDescription: resolvedItemDesc,
      lineItems: resolvedLineItems,
      documents: candidateDocs,
      acknowledgement: ackData,
      responseData: respData,
      submittedAt: p.updatedAt || p.createdAt || auction.startTime,
      createdAt: p.createdAt || auction.startTime,
      deliveryTimeline: linkedPart?.deliveryTimeline || ackData?.deliveryTimeline || 'Standard',
      terms: linkedPart?.terms || ackData?.terms || 'Standard terms',
      rawParticipation: p
    };
  });

  // Winning participant & awards
  const winningParticipant = mappedParticipations.find((p: any) =>
    auction.winnerSellerId
      ? (p.sellerUserId === auction.winnerSellerId || p.sellerOrgId === auction.winnerSellerId)
      : p.rank === 1
  ) || mappedParticipations[0];

  const winningAmount = Number(
    winningParticipant?.totalPrice ||
    auction.currentLowestAmount ||
    auction.currentLowestBid ||
    auction.currentBid ||
    0
  );

  const isAccepted = auction.status === 'AWARD_ACCEPTED' || Boolean(winningParticipant?.finalStatus === 'AWARDED');
  const synthesizedAwards = (winningParticipant && (auction.winnerSellerId || isAccepted || auction.status === 'AWARD_RECOMMENDED' || auction.statusEnum === 'AWARD_RECOMMENDED')) ? [{
    id: 1,
    bidId: auction.id,
    participationId: winningParticipant.id,
    sellerId: winningParticipant.sellerUserId || auction.winnerSellerId,
    sellerOrgId: winningParticipant.sellerOrgId,
    awardAmount: winningAmount,
    awardedAmount: winningAmount,
    awardStatus: isAccepted ? 'ACCEPTED' : 'RECOMMENDED',
    counterOfferStatus: isAccepted ? 'ACCEPTED' : 'NONE',
    remarks: auction.remarks || 'Reverse Auction Award',
    createdAt: auction.updatedAt || auction.createdAt
  }] : [];

  const origPayload: any = linkedBid?.payload || linkedReq?.payload || linkedBid?.technicalPacket || {};
  const origBasics: any = origPayload?.basics || {};
  const origTerms: any = origPayload?.terms || {};
  const origSchedule: any = origPayload?.schedule || {};

  const tenderItems = (Array.isArray(linkedBid?.items) && linkedBid.items.length > 0 ? linkedBid.items : null) ||
    (Array.isArray(linkedReq?.items) && linkedReq.items.length > 0 ? linkedReq.items : null) ||
    (Array.isArray(origPayload?.items) && origPayload.items.length > 0 ? origPayload.items : null) ||
    (Array.isArray(origPayload?.boqTable) && origPayload.boqTable.length > 0 ? origPayload.boqTable : null) ||
    [{
      id: 1,
      itemName: auction.title || 'Procurement requirement',
      description: auction.description || '',
      quantity: 1,
      unitOfMeasure: 'Nos'
    }];

  const boqTable = (Array.isArray(linkedBid?.boqTable) && linkedBid.boqTable.length > 0 ? linkedBid.boqTable : null) ||
    (Array.isArray(origPayload?.boqTable) && origPayload.boqTable.length > 0 ? origPayload.boqTable : null) ||
    (Array.isArray(linkedReq?.boqTable) && linkedReq.boqTable.length > 0 ? linkedReq.boqTable : null) ||
    [];

  const rawTerms = linkedBid?.termsAndConditions || origTerms?.termsAndConditions || linkedReq?.termsAndConditions || origPayload?.termsAndConditions || linkedReq?.terms;
  const termsAndConditions = Array.isArray(rawTerms) ? rawTerms : (typeof rawTerms === 'string' ? [rawTerms] : []);

  const rawElig = linkedBid?.eligibilityCriteria || origBasics?.eligibilityCriteria || linkedReq?.eligibilityCriteria || origPayload?.eligibilityCriteria;
  const eligibilityCriteria = Array.isArray(rawElig) ? rawElig : (typeof rawElig === 'string' ? [rawElig] : []);

  const documents = (Array.isArray(linkedBid?.documents) && linkedBid.documents.length > 0 ? linkedBid.documents : null) ||
    (Array.isArray(origPayload?.documents) && origPayload.documents.length > 0 ? origPayload.documents : null) ||
    (Array.isArray(linkedReq?.documents) && linkedReq.documents.length > 0 ? linkedReq.documents : null) ||
    [];

  const requiredDocuments = (Array.isArray(linkedBid?.requiredDocuments) && linkedBid.requiredDocuments.length > 0 ? linkedBid.requiredDocuments : null) ||
    (Array.isArray(origPayload?.requiredDocs) && origPayload.requiredDocs.length > 0 ? origPayload.requiredDocs : null) ||
    (Array.isArray(origPayload?.requiredDocuments) && origPayload.requiredDocuments.length > 0 ? origPayload.requiredDocuments : null) ||
    (Array.isArray(linkedReq?.requiredDocuments) && linkedReq.requiredDocuments.length > 0 ? linkedReq.requiredDocuments : null) ||
    [];

  const consigneeDetails = (Array.isArray(linkedBid?.technicalPacket?.consigneeDetails) && linkedBid.technicalPacket.consigneeDetails.length > 0 ? linkedBid.technicalPacket.consigneeDetails : null) ||
    (Array.isArray(origPayload?.consigneeDetails) && origPayload.consigneeDetails.length > 0 ? origPayload.consigneeDetails : null) ||
    [];

  const isGenericLocVal = (val?: string | null) => {
    if (!val) return true;
    const s = String(val).trim().toLowerCase();
    return !s || s === 'india' || s === 'pan-india' || s === 'all india' || s === 'location not specified' || s === 'not specified' || s === '—' || s === 'n/a';
  };

  const deliveryLocation = (!isGenericLocVal(origBasics?.deliveryLocation) ? origBasics.deliveryLocation : null) ||
    (!isGenericLocVal(consigneeDetails[0]?.location) ? consigneeDetails[0].location : null) ||
    (!isGenericLocVal(linkedBid?.deliveryLocation) ? linkedBid.deliveryLocation : null) ||
    (!isGenericLocVal(linkedReq?.deliveryLocation) ? linkedReq.deliveryLocation : null) ||
    (!isGenericLocVal(linkedReq?.location) ? linkedReq.location : null) ||
    (buyerOrg ? [buyerOrg.addressLine1, buyerOrg.addressLine2, buyerOrg.city, buyerOrg.district, buyerOrg.state, buyerOrg.pincode].filter(Boolean).join(', ') : null) ||
    linkedBid?.deliveryLocation ||
    'Location as per procurement document';
  const paymentTerms = linkedBid?.paymentTerms || origTerms?.paymentTerms || origBasics?.paymentTerms || linkedReq?.paymentTerms || 'Standard commercial payment terms';
  const deliveryTerms = linkedBid?.deliveryTerms || origTerms?.deliveryTerms || origBasics?.deliveryTerms || linkedReq?.deliveryTerms || 'Door delivery within contract period';

  const title = (auction.title && !auction.title.startsWith('RA-') && !auction.title.toLowerCase().startsWith('reverse auction'))
    ? auction.title
    : (linkedBid?.title || origBasics?.title || linkedReq?.title || auction.title || `Reverse Auction ${auction.auctionCode || auction.id}`);

  const description = linkedBid?.description || origBasics?.description || linkedReq?.description || auction.description || '';

  const approvalAuthority = linkedBid?.approvalAuthority || origPayload?.internal?.approvalAuthority || null;
  const justification = linkedBid?.justification || origPayload?.internal?.justification || null;
  const internalDetails = linkedBid?.internalDetails || origPayload?.internal || null;

  const estimatedVal = Number(
    linkedBid?.estimatedValue ||
    linkedReq?.estimatedValue ||
    auction.basePrice ||
    auction.startPrice ||
    auction.reservePrice ||
    auction.currentLowestBid ||
    0
  );

  const effectiveStatus = isAccepted ? 'AWARDED'
    : (auction.status === 'AWARD_RECOMMENDED' || auction.statusEnum === 'AWARD_RECOMMENDED' ? 'AWARD_RECOMMENDED'
    : (['CLOSED', 'COMPLETED', 'FINALIZED'].includes(auction.status) ? 'L1_GENERATED'
    : (['LIVE', 'ACTIVE'].includes(auction.status) ? 'OPEN' : (auction.status || 'ACTIVE'))));

  const effectiveStage = isAccepted ? 'AWARDED'
    : (auction.status === 'AWARD_RECOMMENDED' || auction.statusEnum === 'AWARD_RECOMMENDED' ? 'AWARD_RECOMMENDED'
    : (['CLOSED', 'COMPLETED', 'FINALIZED'].includes(auction.status) ? 'L1_GENERATED'
    : (['LIVE', 'ACTIVE'].includes(auction.status) ? 'SELLER_PARTICIPATION' : 'TECHNICAL_EVALUATION_COMPLETED')));

  const auctionPurchaseOrders = await client.purchaseOrder.findMany({
    where: {
      OR: [
        { sourceType: 'auction', sourceId: auction.id },
        ...(auction.linkedBidId ? [{ bidId: auction.linkedBidId }] : [])
      ]
    },
    include: {
      invoices: { include: { invoiceFile: true, paymentSlipFile: true } },
      grns: { include: { items: true } },
      items: true
    },
    orderBy: { createdAt: 'desc' }
  }).catch((poErr: any) => {
    logger.warn({ poErr: poErr?.message || poErr }, '[ProcurementBid] Failed to fetch auction purchase orders');
    return [];
  });

  const activeAuctionOrder = auctionPurchaseOrders[0] || null;

  return {
    id: auction.auctionCode || `RA-${auction.id}`,
    bidNumber: auction.auctionCode || `RA-${auction.id}`,
    referenceNumber: auction.referenceNo || auction.auctionCode || `RA-${auction.id}`,
    title,
    description,
    bidType: 'Reverse Auction',
    procurementType: 'Reverse Auction',
    procurementMethod: 'REVERSE_AUCTION',
    sourcingMethod: 'REVERSE_AUCTION',
    category: auction.category || linkedBid?.category || origBasics?.category || linkedReq?.category?.name || 'General',
    status: effectiveStatus,
    lifecycleStage: effectiveStage,
    estimatedValue: estimatedVal,
    startDate: auction.startTime || auction.actualStartedAt || auction.createdAt,
    endDate: auction.endTime || auction.actualClosedAt || auction.endTime,
    submissionStartDate: auction.startTime || auction.createdAt,
    publishedAt: auction.createdAt || auction.startTime,
    auctionCode: auction.auctionCode,
    auctionId: auction.id,
    sourceModel: 'AUCTION',
    sourceId: auction.id,
    buyerId: buyerUser?.id || auction.createdByUserId,
    buyer: buyerUser,
    buyerOrganization: buyerOrg,
    buyerOrganizationName: buyerOrg?.organizationName || linkedBid?.buyerOrganizationName || 'Buyer Organization',
    items: tenderItems,
    boqTable,
    documents,
    requiredDocuments,
    termsAndConditions,
    eligibilityCriteria,
    consigneeDetails,
    deliveryLocation,
    paymentTerms,
    deliveryTerms,
    approvalAuthority,
    justification,
    internalDetails,
    participations: mappedParticipations,
    results: mappedParticipations,
    awards: synthesizedAwards,
    technicalPacket: {
      ...(linkedBid?.technicalPacket || {}),
      ...(origPayload || {}),
      schedule: {
        ...(linkedBid?.technicalPacket?.schedule || origSchedule || {}),
        publishDate: auction.createdAt,
        bidStartDate: auction.startTime,
        submissionDate: auction.endTime,
        submissionEndDate: auction.endTime,
        packetType: 'Single'
      },
      basics: {
        ...(linkedBid?.technicalPacket?.basics || origBasics || {}),
        title,
        description,
        procurementMethod: 'REVERSE_AUCTION',
        procurementType: 'Reverse Auction',
        category: auction.category || linkedBid?.category || origBasics?.category || 'General',
        estimatedValue: estimatedVal,
        deliveryLocation,
        eligibilityCriteria
      },
      items: tenderItems,
      boqTable,
      terms: {
        ...(linkedBid?.technicalPacket?.terms || origTerms || {}),
        paymentTerms,
        deliveryTerms,
        termsAndConditions
      },
      termsAndConditions,
      eligibilityCriteria,
      consigneeDetails
    },
    payload: {
      ...(origPayload || {}),
      ...(auction.auctionConfig || {}),
      basics: {
        ...(origBasics || {}),
        title,
        description,
        procurementMethod: 'REVERSE_AUCTION',
        procurementType: 'Reverse Auction',
        category: auction.category || linkedBid?.category || origBasics?.category || 'General',
        estimatedValue: estimatedVal,
        deliveryLocation,
        eligibilityCriteria
      },
      items: tenderItems,
      boqTable,
      terms: {
        ...(origTerms || {}),
        paymentTerms,
        deliveryTerms,
        termsAndConditions
      },
      termsAndConditions,
      eligibilityCriteria,
      consigneeDetails
    },
    purchaseOrders: auctionPurchaseOrders,
    activeOrder: activeAuctionOrder,
    isReverseAuction: true,
    rawAuction: auction
  };
};

export const resolveBid = async (bidIdOrNumber: string | number, include: any = leanBidInclude) => {
  const token = String(bidIdOrNumber).trim();
  logger.info({ token }, '[RESOLVE_BID] Resolving procurement record for token');

  // 0. If token indicates a reverse auction, resolve directly via reverse auction records
  if (token.startsWith('RA-') || token.startsWith('AUCTION-')) {
    const auctionBid = await resolveAuctionAsBidRecord(token);
    if (auctionBid) {
      logger.info({ token, auctionId: auctionBid.auctionId }, '[RESOLVE_BID] Resolved reverse auction as procurement bid');
      return auctionBid;
    }
  }

  // 1. Direct indexed lookup in procurementBid
  let bid = await db.procurementBid.findUnique({
    where: { bidNumber: token },
    include,
  });

  if (bid) {
    logger.info({ token, bidId: bid.id, bidNumber: bid.bidNumber }, '[RESOLVE_BID] Direct hit on procurementBid.bidNumber');
    return await refreshBidStatus(bid);
  }

  // 2. Direct lookup by numeric ID if parameter is an integer
  const isNum = /^\d+$/.test(token) && Number(token) <= 2147483647;
  if (isNum) {
    bid = await db.procurementBid.findUnique({
      where: { id: Number(token) },
      include,
    });
    if (bid) return await refreshBidStatus(bid);
  }

  // 3. Direct indexed lookup in buyerRequirement
  const buyerReq = await db.buyerRequirement.findFirst({
    where: {
      OR: [
        { referenceNumber: token },
        ...(isNum ? [{ id: Number(token) }] : []),
      ],
    },
    include: {
      responses: true,
      category: true,
      buyerOrganization: true,
    },
  });

  if (buyerReq) {
    logger.info({ token, reqId: buyerReq.id, ref: buyerReq.referenceNumber }, '[RESOLVE_BID] Found linked BuyerRequirement, returning resolved adapter');
    return {
      id: buyerReq.id,
      bidNumber: buyerReq.referenceNumber || token,
      title: buyerReq.title,
      description: buyerReq.description,
      buyerId: buyerReq.createdById,
      buyerOrganizationId: buyerReq.buyerOrganizationId,
      buyerOrganizationName: buyerReq.buyerOrganization?.organizationName || 'Buyer',
      buyerType: buyerReq.buyerOrganization?.organizationType || buyerReq.buyerType || 'Private Enterprise',
      category: buyerReq.category?.name || 'General',
      bidType: buyerReq.requirementType || 'RFQ',
      procurementType: buyerReq.requirementType || 'RFQ',
      quantity: buyerReq.quantity,
      unit: buyerReq.unit,
      estimatedValue: buyerReq.budgetMax || buyerReq.budgetMin || 0,
      deliveryLocation: buyerReq.location || 'Pan-India',
      startDate: buyerReq.createdAt,
      endDate: buyerReq.lastDate,
      status: buyerReq.status === 'PUBLISHED' ? 'OPEN' : 'DRAFT',
      approvalStatus: 'APPROVED',
      lifecycleStage: 'BID_PUBLISHED',
      participations: (buyerReq.responses || []).map((r: any) => ({
        id: r.id,
        participationNumber: `${buyerReq.referenceNumber || token}-P${String(r.id).padStart(4, '0')}`,
        bidId: buyerReq.id,
        sellerId: r.sellerUserId,
        sellerUserId: r.sellerUserId,
        sellerOrganizationName: r.sellerOrganizationName || 'Supplier',
        status: r.status === 'ACCEPTED' ? 'AWARDED' : 'SUBMITTED',
        totalPrice: r.bidAmount,
        submittedAt: r.createdAt,
      })),
      isBuyerRequirement: true,
      rawBuyerRequirement: buyerReq,
    };
  }

  // 4. Secondary lookup in canonical variants
  const variants = getCanonicalLookupVariants(token);
  if (variants.length > 0) {
    bid = await db.procurementBid.findFirst({
      where: { bidNumber: { in: variants } },
      include,
    });
    if (bid) return await refreshBidStatus(bid);
  }

  if (bid) {
    logger.info({ token, bidId: bid.id, bidNumber: bid.bidNumber }, '[RESOLVE_BID] Found existing procurementBid in database');
  } else {
    logger.info({ token }, '[RESOLVE_BID] Not found in procurementBid table, searching requirement tables concurrently...');
    const parsedNum = isNum ? Number(token) : null;
    const candidateTokens = new Set<string>([token, ...variants]);
    const legacyReqWhere: any[] = Array.from(candidateTokens).map(t => ({ requirementNumber: t }));
    if (parsedNum) {
      legacyReqWhere.push({ id: parsedNum });
    }

    const qReqWhere: any[] = Array.from(candidateTokens).map(t => ({ subject: t }));
    if (parsedNum) {
      qReqWhere.push({ id: parsedNum });
    }

    const [buyerReqCandidate, legacyReqCandidate, qReq] = await Promise.all([
      parsedNum ? db.buyerRequirement.findUnique({
        where: { id: parsedNum },
        include: { buyerOrganization: true, createdBy: true }
      }).catch(err => {
        logger.warn({ err }, '[RESOLVE_BID] Error querying buyerRequirement');
        return null;
      }) : Promise.resolve(null),
      db.requirement.findFirst({
        where: { OR: legacyReqWhere },
        include: { organization: true, buyer: true }
      }).catch(err => {
        logger.warn({ err }, '[RESOLVE_BID] Error querying requirement');
        return null;
      }),
      db.quoteRequest.findFirst({
        where: { OR: qReqWhere },
        include: { buyer: { include: { organization: true } } }
      }).catch(err => {
        logger.warn({ err }, '[RESOLVE_BID] Error querying quoteRequest');
        return null;
      })
    ]);

    let buyerReq: any = buyerReqCandidate || legacyReqCandidate;

      if (qReq) {
        const reqId = qReq.id;
        const reqNumber = `RFQ-${qReq.id}`;
        const rawBuyerId = qReq.buyerId;
        const buyerOrgName = qReq.buyer?.organization?.organizationName || '';

        logger.info({ reqId, reqNumber, rawBuyerId }, '[RESOLVE_BID] Found quoteRequest record in DB');

        bid = await db.procurementBid.findFirst({
          where: {
            OR: [
              { bidNumber: reqNumber },
              ...(token && token !== reqNumber ? [{ bidNumber: token }] : []),
              { technicalPacket: { path: ['sourceRequirementId'], equals: reqId } },
              { technicalPacket: { path: ['quoteRequestId'], equals: reqId } }
            ]
          },
          include
        });

        if (!bid) {
          let validBuyerId = rawBuyerId;
          let buyerUser: any = null;
          if (validBuyerId) {
            buyerUser = await db.user.findUnique({ where: { id: Number(validBuyerId) }, include: { organization: true, buyerProfile: true } });
            if (!buyerUser) validBuyerId = null;
          }
          if (!validBuyerId) {
            const fallbackUser = await db.user.findFirst({ where: { role: { in: ['buyer', 'admin', 'master_admin'] } }, include: { organization: true, buyerProfile: true } });
            validBuyerId = fallbackUser?.id;
            buyerUser = fallbackUser;
          }

          logger.info({ reqNumber, reqId, validBuyerId }, '[RESOLVE_BID] Creating shadow procurementBid record for QuoteRequest in DB...');
          bid = await db.procurementBid.create({
            data: {
              bidNumber: reqNumber,
              title: qReq.subject || 'RFQ Procurement',
              description: qReq.description || qReq.subject || 'RFQ Procurement',
              category: 'General',
              buyerType: buyerUser?.organization?.organizationType || buyerUser?.buyerProfile?.organizationType || 'Private Enterprise',
              procurementType: 'RFQ',
              bidType: 'Product',
              buyerId: Number(validBuyerId),
              buyerOrganizationName: buyerOrgName || 'Buyer Organization',
              status: 'OPEN',
              approvalStatus: 'APPROVED',
              lifecycleStage: 'SELLER_PARTICIPATION',
              deliveryLocation: (qReq as any).deliveryLocation || (qReq as any).location || (buyerUser?.organization ? [buyerUser.organization.addressLine1, buyerUser.organization.city, buyerUser.organization.state].filter(Boolean).join(', ') : null) || 'Location as per procurement document',
              startDate: qReq.createdAt || new Date(),
              endDate: new Date(Date.now() + 30 * 86400000),
              technicalPacket: {
                sourceModel: 'QUOTE_REQUEST',
                sourceRequirementId: reqId,
                quoteRequestId: reqId
              }
            },
            include
          });
          logger.info({ newBidId: bid.id }, '[RESOLVE_BID] Created shadow procurementBid for QuoteRequest successfully');
        }
        if (bid) {
          bid.sourceModel = 'QUOTE_REQUEST';
          bid.sourceId = reqId;
        }
      }

    if (buyerReq) {
      const reqId = buyerReq.id;
      const reqNumber = buyerReq.requirementNumber || token;
      const rawBuyerId = buyerReq.createdById || buyerReq.buyerId;
      const buyerOrgName = buyerReq.buyerOrganization?.organizationName || buyerReq.organization?.organizationName || '';

      logger.info({ reqId, reqNumber, rawBuyerId }, '[RESOLVE_BID] Found requirement record in DB');

      bid = await db.procurementBid.findFirst({
        where: {
          OR: [
            { bidNumber: reqNumber },
            ...(token && token !== reqNumber ? [{ bidNumber: token }] : []),
            { technicalPacket: { path: ['sourceRequirementId'], equals: reqId } },
            { technicalPacket: { path: ['requirementId'], equals: reqId } }
          ]
        },
        include
      });

      if (!bid) {
        let validBuyerId = rawBuyerId;
        if (validBuyerId) {
          const userExists = await db.user.findUnique({ where: { id: Number(validBuyerId) } });
          if (!userExists) validBuyerId = null;
        }
        if (!validBuyerId) {
          const fallbackUser = await db.user.findFirst({ where: { role: { in: ['buyer', 'admin', 'master_admin'] } } });
          validBuyerId = fallbackUser?.id;
        }

        const reqPayload = (typeof buyerReq.payload === 'object' && buyerReq.payload ? buyerReq.payload : {}) as any;
        const reqBasics = reqPayload.basics || {};
        const reqOrg = buyerReq.organization || buyerReq.buyerOrganization || (buyerReq.buyer as any)?.buyerProfile?.organization || (buyerReq.buyer as any)?.organization;
        const orgAddr = reqOrg ? [reqOrg.addressLine1, reqOrg.addressLine2, reqOrg.city, reqOrg.district, reqOrg.state, reqOrg.pincode].filter(Boolean).join(', ') : '';
        const orgLoc = reqOrg ? [reqOrg.city, reqOrg.district, reqOrg.state].filter(Boolean).join(', ') : '';

        const isGeneric = (loc?: string | null) => {
          if (!loc) return true;
          const s = String(loc).trim().toLowerCase();
          return !s || s === 'india' || s === 'pan-india' || s === 'all india' || s === 'location not specified' || s === 'not specified' || s === '—' || s === 'n/a';
        };

        const resolvedDeliveryLoc =
          (!isGeneric(reqBasics.deliveryLocation) ? reqBasics.deliveryLocation : null) ||
          (Array.isArray(reqPayload.consigneeDetails) && reqPayload.consigneeDetails[0]?.location && !isGeneric(reqPayload.consigneeDetails[0].location) ? reqPayload.consigneeDetails[0].location : null) ||
          (!isGeneric(reqPayload.tender?.deliveryLocation) ? reqPayload.tender.deliveryLocation : null) ||
          (!isGeneric(reqPayload.deliveryLocation) ? reqPayload.deliveryLocation : null) ||
          (!isGeneric(buyerReq.location) ? buyerReq.location : null) ||
          (!isGeneric(buyerReq.deliveryLocation) ? buyerReq.deliveryLocation : null) ||
          orgAddr ||
          orgLoc ||
          'Location as per procurement document';

        const shadowTechnicalPacket: any = {
          ...reqPayload,
          basics: {
            ...reqBasics,
            deliveryLocation: reqBasics.deliveryLocation || resolvedDeliveryLoc
          },
          consigneeDetails: (Array.isArray(reqPayload.consigneeDetails) && reqPayload.consigneeDetails.length > 0)
            ? reqPayload.consigneeDetails
            : (orgAddr ? [{ name: reqOrg?.organizationName, location: orgAddr }] : []),
          ...(buyerReq.items && buyerReq.items.length > 0 ? { wizardData: { items: buyerReq.items } } : {}),
          sourceModel: 'REQUIREMENT',
          sourceRequirementId: reqId,
          requirementId: reqId,
          requirementNumber: reqNumber
        };

        logger.info({ reqNumber, reqId, validBuyerId }, '[RESOLVE_BID] Creating shadow procurementBid record in DB...');
        bid = await db.procurementBid.create({
          data: {
            bidNumber: reqNumber,
            title: buyerReq.title || 'Requirement Procurement',
            description: buyerReq.description || buyerReq.title || 'Procurement requirement',
            category: buyerReq.category?.name || buyerReq.category || 'General',
            buyerType: buyerReq.buyerOrganization?.organizationType || buyerReq.buyerType || 'Private Enterprise',
            procurementType: buyerReq.procurementMethod || 'RFQ',
            bidType: buyerReq.bidType || 'Product',
            buyerId: Number(validBuyerId),
            buyerOrganizationName: buyerOrgName || 'Buyer Organization',
            status: buyerReq.status === 'APPROVED' ? 'OPEN' : (buyerReq.status || 'OPEN'),
            approvalStatus: buyerReq.status === 'APPROVED' ? 'APPROVED' : 'DRAFT',
            lifecycleStage: 'SELLER_PARTICIPATION',
            deliveryLocation: resolvedDeliveryLoc,
            startDate: buyerReq.createdAt || new Date(),
            endDate: buyerReq.lastDate || buyerReq.requiredBy || new Date(Date.now() + 30 * 86400000),
            technicalPacket: shadowTechnicalPacket
          },
          include
        });
        logger.info({ newBidId: bid.id }, '[RESOLVE_BID] Created shadow procurementBid successfully');
      }
      if (bid) {
        bid.sourceModel = 'REQUIREMENT';
        bid.sourceId = reqId;
      }
    }
  }

  if (!bid) {
    // Try Rate Contract resolution (RC- prefixed IDs or plain contract IDs)
    const isRcPrefix = token.startsWith('RC-');
    const rcTimestampStr = isRcPrefix ? token.replace('RC-', '') : null;
    const rcTimestamp = rcTimestampStr ? Number(rcTimestampStr) : null;

    let contract: any = null;
    try {
      const orClauses: any[] = [];
      if (rcTimestampStr) {
        orClauses.push({ contractNumber: token });
        orClauses.push({ contractNumber: rcTimestampStr });
      }
      if (!isRcPrefix) {
        orClauses.push({ contractNumber: token });
      }
      if (rcTimestamp && Number.isFinite(rcTimestamp) && rcTimestamp > 0 && rcTimestamp <= 2147483647) {
        orClauses.push({ id: rcTimestamp });
      }
      if (orClauses.length > 0) {
        const contracts = await db.contract.findMany({
          where: { OR: orClauses },
          take: 1
        }).catch(() => [] as any[]);
        contract = contracts[0] || null;
      }
    } catch {
      // ignore
    }

    if (contract) {
      const meta = typeof contract.metadata === 'object' && contract.metadata !== null
        ? contract.metadata
        : (typeof contract.metadata === 'string' ? (() => { try { return JSON.parse(contract.metadata); } catch { return {}; } })() : {});
      const rcBidNumber = `RC-${contract.id}`;

      // Try to find existing shadow bid for this rate contract
      bid = await db.procurementBid.findFirst({
        where: {
          OR: [
            { bidNumber: rcBidNumber },
            { bidNumber: token },
            { technicalPacket: { path: ['sourceContractId'], equals: contract.id } },
            { technicalPacket: { path: ['contractId'], equals: contract.id } }
          ]
        },
        include
      }).catch(() => null);

      if (!bid) {
        let validBuyerId = contract.buyerId || meta.buyerId || null;
        let buyerUser: any = null;
        if (validBuyerId) {
          buyerUser = await db.user.findUnique({ where: { id: Number(validBuyerId) }, include: { organization: true, buyerProfile: true } }).catch(() => null);
          if (!buyerUser) validBuyerId = null;
        }
        if (!validBuyerId) {
          const fallbackUser = await db.user.findFirst({ where: { role: { in: ['buyer', 'admin', 'master_admin'] } }, include: { organization: true, buyerProfile: true } }).catch(() => null);
          validBuyerId = fallbackUser?.id;
          buyerUser = fallbackUser;
        }

        logger.info({ rcBidNumber, contractId: contract.id, validBuyerId }, '[RESOLVE_BID] Creating shadow procurementBid for Rate Contract...');
        const formatDate = (v: any) => {
          if (!v) return null;
          if (v instanceof Date) return v;
          try { return new Date(v); } catch { return null; }
        };
        bid = await db.procurementBid.create({
          data: {
            bidNumber: rcBidNumber,
            title: contract.contractTitle || contract.title || 'Rate Contract',
            description: contract.scope || contract.contractTitle || 'Rate Contract Procurement',
            category: (typeof meta.category === 'string' ? meta.category : null) || 'General',
            buyerType: meta.buyerType || buyerUser?.organization?.organizationType || buyerUser?.buyerProfile?.organizationType || 'Private Enterprise',
            procurementType: 'RATE_CONTRACT',
            bidType: 'Product',
            buyerId: Number(validBuyerId),
            buyerOrganizationName: meta.buyerOrgName || 'Buyer Organization',
            status: 'OPEN',
            approvalStatus: 'APPROVED',
            lifecycleStage: 'SELLER_PARTICIPATION',
            deliveryLocation: meta.deliveryLocation || (contract.deliveryLocation ? contract.deliveryLocation : null) || (buyerUser?.organization ? [buyerUser.organization.addressLine1, buyerUser.organization.city, buyerUser.organization.state].filter(Boolean).join(', ') : null) || 'Location as per contract',
            startDate: formatDate(contract.startDate) || new Date(),
            endDate: formatDate(contract.endDate) || new Date(Date.now() + 365 * 86400000),
            technicalPacket: {
              ...(meta.items && Array.isArray(meta.items) && meta.items.length > 0 ? { wizardData: { items: meta.items } } : {}),
              sourceModel: 'RATE_CONTRACT',
              sourceContractId: contract.id,
              contractId: contract.id
            }
          },
          include
        }).catch((err: any) => {
          logger.warn({ err }, '[RESOLVE_BID] Failed to create shadow bid for Rate Contract, trying findFirst...');
          return db.procurementBid.findFirst({
            where: { OR: [{ bidNumber: rcBidNumber }, { bidNumber: token }] },
            include
          }).catch(() => null);
        });
        if (bid) {
          bid.sourceModel = 'RATE_CONTRACT';
          bid.sourceId = contract.id;
          logger.info({ bidId: bid.id }, '[RESOLVE_BID] Created/found shadow procurementBid for Rate Contract');
        }
      }
    }
  }

  if (bid) {
    const packetMeta = bid.technicalPacket && typeof bid.technicalPacket === 'object' ? (bid.technicalPacket as any) : {};
    const linkedReqId = Number(packetMeta.sourceRequirementId || packetMeta.requirementId || packetMeta.linkedRequirementId || 0) || null;
    const linkedContractId = Number(packetMeta.sourceContractId || packetMeta.contractId || 0) || null;
    const linkedQuoteId = Number(packetMeta.quoteRequestId || 0) || null;

    if (!bid.sourceModel) {
      bid.sourceModel = packetMeta.sourceModel || (linkedContractId ? 'RATE_CONTRACT' : linkedQuoteId ? 'QUOTE_REQUEST' : linkedReqId ? 'REQUIREMENT' : 'PROCUREMENT_BID');
    }
    if (!bid.sourceId) {
      bid.sourceId = packetMeta.sourceId || linkedReqId || linkedContractId || linkedQuoteId || bid.id;
    }
  }

  if (!bid) {
    const auctionFallback = await resolveAuctionAsBidRecord(token);
    if (auctionFallback) {
      bid = auctionFallback;
    }
  }

  if (!bid) {
    logger.warn({ token }, '[RESOLVE_BID] Bid not found');
    throw new ApiError(404, 'Bid not found', 'BID_NOT_FOUND');
  }
  return refreshBidStatus(bid);
};

export const refreshBidStatus = async (bid: any) => {
  if (!bid || !bid.id || bid.isBuyerRequirement) return bid;
  const current = String(bid.status || '').toUpperCase();
  const time = now();

  const tp = (bid.technicalPacket && typeof bid.technicalPacket === 'object') ? (bid.technicalPacket as any) : {};
  const sched = tp.schedule || null;
  const tndr = tp.tender || null;
  const rateContractConfig = tp.rateContractConfig || tp.rateContract || {};

  const isRateContractPeriodEnd = Boolean(
    rateContractConfig.periodEndDate &&
    bid.endDate &&
    new Date(bid.endDate).toISOString().slice(0, 10) === new Date(rateContractConfig.periodEndDate).toISOString().slice(0, 10)
  );

  const deadlineCandidate = (isRateContractPeriodEnd ? null : bid.endDate) || firstPresent(
    bid.bidClosingDate,
    sched?.submissionClosingDate,
    sched?.submissionDate,
    sched?.submissionDeadline,
    sched?.submissionEndDate,
    sched?.bidClosingDate,
    tndr?.bidClosingDate,
    tp?.submissionDeadline,
    tp?.bidClosingDate,
    bid.endDate
  );
  const parsedDeadline = deadlineCandidate ? parseDateIST(deadlineCandidate) : (bid.endDate ? parseDateIST(bid.endDate) : null);
  const endDateTime = parsedDeadline ? parsedDeadline.getTime() : null;

  if (['OPEN', 'OPEN_FOR_BIDDING', 'PUBLISHED', 'ACTIVE'].includes(current) && endDateTime && endDateTime <= time.getTime()) {
    const expired = await db.procurementBid.update({
      where: { id: bid.id },
      data: { status: 'EXPIRED', lifecycleStage: 'TECHNICAL_EVALUATION' },
      include: bidInclude
    });
    await db.procurementAuditLog.create({
      data: {
        entityType: 'ProcurementBid',
        entityId: String(bid.id),
        action: 'BID_EXPIRED',
        oldValue: { status: current } as any,
        newValue: { status: 'EXPIRED', lifecycleStage: 'TECHNICAL_EVALUATION' } as any
      }
    });
    return expired;
  }
  if (['APPROVED', 'DRAFT'].includes(current) && bid.startDate && new Date(bid.startDate) <= time && endDateTime && endDateTime > time.getTime()) {
    return db.procurementBid.update({
      where: { id: bid.id },
      data: { status: 'OPEN', lifecycleStage: 'SELLER_PARTICIPATION' },
      include: bidInclude
    });
  }

  // Option B: Auto-transition for bids under evaluation when opening date or evaluation completion arrives
  if (['TECHNICAL_EVALUATION', 'TECHNICAL_EVALUATION_COMPLETED', 'UNDER_EVALUATION'].includes(current)) {
    await autoCheckAndPerformTransitions(bid.id);
  }

  return bid;
};

export const serializeBid = (bid: any, options: { actor?: Actor; detail?: boolean; includeParticipants?: boolean; includeFinancial?: boolean; sellerRatings?: Record<number, any> } = {}) => {
  const actor = options.actor;
  const actorRole = String(actor?.role || '').toLowerCase();
  const isAdmin = actorRole === 'admin' || actorRole === 'master_admin';
  const isBuyerOwner = actorRole === 'buyer' || isAdmin || (!!actor?.id && Number(bid.buyerId) === Number(actor.id));
  const canSeeParticipants = options.includeParticipants || isAdmin || isBuyerOwner || actorRole === 'buyer';
  const canSeeFinancial = options.includeFinancial || isAdmin || (isBuyerOwner && (financialOpenStatuses.includes(bid.status) || bid.status === 'TECHNICAL_EVALUATION_COMPLETED'));
  const packetMeta = bid.technicalPacket && typeof bid.technicalPacket === 'object' ? bid.technicalPacket as any : {};
  const isTwoPacket = String(bid.packetType || packetMeta.packetType || packetMeta.schedule?.packetType || '').toUpperCase().includes('TWO') || Boolean(bid.financialOpeningDate || packetMeta.financialOpeningDate || packetMeta.schedule?.financialOpeningDate);
  const linkedRequirementId = Number(packetMeta.sourceRequirementId || packetMeta.requirementId || packetMeta.linkedRequirementId || 0) || null;

  const discloseEstimatedCost = Boolean(
    bid.discloseEstimatedCost ??
    packetMeta.discloseEstimatedCost ??
    packetMeta.basics?.discloseEstimatedCost ??
    packetMeta.wizardData?.basics?.discloseEstimatedCost ??
    false
  );

  // Buyer packet & requirement documents are part of the tender pack sellers must respond to.
  // Filter out only internal buyer approval documents (e.g. budget sanctions) for sellers.
  const internalBuyerDocTypes = ['BUDGET_SANCTION', 'ADMINISTRATIVE_APPROVAL', 'PAC_CERTIFICATE', 'COMPETENT_AUTHORITY_APPROVAL', 'PRICE_REASONABILITY'];
  const publicDocuments = (bid.documents || []).filter((doc: any) => {
    if (doc.visibility === 'PUBLIC' || doc.visibility === 'SELLER_AFTER_LOGIN') return true;
    if (actor?.role === 'seller') {
      if (doc.visibility === 'BUYER_ADMIN_ONLY' || doc.visibility === 'INTERNAL') return false;
      return !internalBuyerDocTypes.includes(doc.documentType);
    }
    return isAdmin || isBuyerOwner;
  });

  const dbInvitations = Array.isArray(bid.invitations) ? bid.invitations : [];
  const rawTechnicalPacket = bid.technicalPacket && typeof bid.technicalPacket === 'object' ? (bid.technicalPacket as any) : {};
  const packetVendors = rawTechnicalPacket.vendors || rawTechnicalPacket.wizardData?.vendors || {};
  const packetInvitedSellers = Array.isArray(packetVendors.invitedSellers)
    ? packetVendors.invitedSellers
    : (Array.isArray(rawTechnicalPacket.qualifiedVendors) ? rawTechnicalPacket.qualifiedVendors : []);

  const effectiveInviteCount = Math.max(
    dbInvitations.length,
    packetInvitedSellers.length,
    Number(packetVendors.inviteCount) || 0
  );

  const enrichedVendors = {
    ...packetVendors,
    inviteCount: effectiveInviteCount,
    invitedSellers: packetInvitedSellers.length > 0
      ? packetInvitedSellers
      : dbInvitations.map((i: any) => i.sellerOrgId || i.sellerUserId).filter(Boolean)
  };

  const tenderItems = normalizeBidItems(bid);
  const rawPacketCopy = bid.technicalPacket && typeof bid.technicalPacket === 'object'
    ? { ...(bid.technicalPacket as any) }
    : {};
  const rawInternal = (bid.technicalPacket && typeof bid.technicalPacket === 'object' && (bid.technicalPacket as any).internal)
    ? (bid.technicalPacket as any).internal
    : {};

  if (actorRole === 'seller') {
    delete rawPacketCopy.internal;
    delete rawPacketCopy.limitedTenderJustification;
    rawPacketCopy.buyerContact = {
      orgName: rawInternal.orgName || bid.buyerOrganizationName || bid.buyerOrganization?.organizationName || null,
      contactPerson: rawInternal.contactPerson || bid.buyer?.buyerProfile?.representativeName || bid.buyer?.name || null,
      department: rawInternal.department || bid.buyer?.buyerProfile?.department || bid.buyer?.buyerProfile?.departmentName || null,
      email: rawInternal.email || bid.buyer?.buyerProfile?.email || bid.buyer?.email || null,
      mobile: rawInternal.mobile || bid.buyer?.buyerProfile?.mobile || bid.buyer?.mobile || null,
    };
  }

  const sellerTechnicalPacket = {
    ...rawPacketCopy,
    items: tenderItems,
    vendors: enrichedVendors
  };

  return {
    id: bid.id,
    bidNumber: bid.bidNumber,
    sourceModel: bid.sourceModel || (linkedRequirementId ? 'REQUIREMENT' : 'PROCUREMENT_BID'),
    sourceId: bid.sourceId || linkedRequirementId || bid.id,
    title: bid.title,
    description: bid.description,
    buyerId: bid.buyerId,
    buyerName: rawInternal.contactPerson || bid.buyer?.buyerProfile?.representativeName || bid.buyer?.name || undefined,
    buyerEmail: rawInternal.email || bid.buyer?.buyerProfile?.email || bid.buyer?.email || undefined,
    buyerMobile: rawInternal.mobile || bid.buyer?.buyerProfile?.mobile || bid.buyer?.mobile || undefined,
    buyerAddress: [
      bid.buyer?.buyerProfile?.registeredAddress || bid.buyer?.buyerProfile?.corporateAddress || bid.buyer?.buyerProfile?.address || bid.buyerOrganization?.registeredAddress,
      bid.buyer?.buyerProfile?.city || bid.buyerOrganization?.city,
      bid.buyer?.buyerProfile?.district || bid.buyerOrganization?.district,
      bid.buyer?.buyerProfile?.state || bid.buyerOrganization?.state,
      bid.buyer?.buyerProfile?.pincode || bid.buyerOrganization?.pincode
    ].filter(Boolean).join(', ') || undefined,
    buyerOrganizationName: bid.buyerOrganizationName || rawInternal.orgName || bid.buyer?.buyerProfile?.organizationName || bid.buyerOrganization?.organizationName || undefined,
    buyerType: bid.buyerType,
    departmentName: rawInternal.department || bid.buyer?.buyerProfile?.department || bid.buyer?.buyerProfile?.departmentName || null,
    consigneeDetails: bid.technicalPacket && typeof bid.technicalPacket === 'object' && (bid.technicalPacket as any).wizardData ? (bid.technicalPacket as any).wizardData : null,
    category: bid.category,
    bidType: bid.bidType,
    procurementType: bid.procurementType,
    quantity: moneyNumber(bid.quantity),
    unit: bid.unit,
    estimatedValue: (isBuyerOwner || isAdmin || discloseEstimatedCost || financialOpenStatuses.includes(bid.status))
      ? moneyNumber(bid.estimatedValue)
      : null,
    discloseEstimatedCost,
    deliveryLocation: bid.deliveryLocation,
    state: bid.state,
    district: bid.district,
    pincode: bid.pincode,
    startDate: bid.startDate,
    endDate: bid.endDate,
    technicalOpeningDate: bid.technicalOpeningDate,
    financialOpeningDate: bid.financialOpeningDate,
    bidValidityDate: bid.bidValidityDate,
    status: bid.status,
    approvalStatus: bid.approvalStatus,
    lifecycleStage: bid.lifecycleStage,
    visibility: bid.visibility,
    evaluationMethod: 'L1',
    documentFee: moneyNumber(bid.documentFee),
    allowClarification: bid.allowClarification,
    allowReverseAuction: bid.allowReverseAuction,
    allowBoq: bid.allowBoq,
    packetType: bid.packetType,
    technicalPacket: isAdmin || isBuyerOwner || actor?.role === 'seller' ? sellerTechnicalPacket : undefined,
    items: tenderItems,
    financialPacket: canSeeFinancial ? bid.financialPacket : undefined,
    termsAndConditions: bid.termsAndConditions || [],
    eligibilityCriteria: bid.eligibilityCriteria || [],
    requiredDocuments: bid.requiredDocuments || [],
    rejectedReason: isAdmin || isBuyerOwner ? bid.rejectedReason : undefined,
    approvalAuthority: (isAdmin || isBuyerOwner)
      ? (rawTechnicalPacket.internal?.approvalAuthority || rawTechnicalPacket.internal?.authorityName || rawTechnicalPacket.internal?.authority || '')
      : undefined,
    justification: (isAdmin || isBuyerOwner)
      ? (rawTechnicalPacket.internal?.justification || rawTechnicalPacket.basics?.justification || rawTechnicalPacket.limitedTenderJustification || '')
      : undefined,
    internalDetails: (isAdmin || isBuyerOwner)
      ? (rawTechnicalPacket.internal || null)
      : undefined,
    approvedAt: bid.approvedAt || null,
    publishedAt: bid.publishedAt || bid.approvedAt || bid.createdAt || bid.startDate,
    postPublishEditCount: Number(bid.postPublishEditCount || 0),
    createdAt: bid.createdAt,
    updatedAt: bid.updatedAt,
    buyer: bid.buyer ? {
      id: bid.buyer.id,
      name: bid.buyer.name || rawInternal.contactPerson || null,
      email: bid.buyer.email || rawInternal.email || null,
      mobile: bid.buyer.mobile || rawInternal.mobile || null,
      buyerProfile: bid.buyer.buyerProfile ? {
        id: bid.buyer.buyerProfile.id,
        organizationName: bid.buyer.buyerProfile.organizationName || bid.buyerOrganizationName || rawInternal.orgName,
        department: bid.buyer.buyerProfile.department || bid.buyer.buyerProfile.departmentName || rawInternal.department || null,
        departmentName: bid.buyer.buyerProfile.department || bid.buyer.buyerProfile.departmentName || rawInternal.department || null,
        designation: bid.buyer.buyerProfile.designation || null,
        representativeName: bid.buyer.buyerProfile.representativeName || rawInternal.contactPerson || bid.buyer.name || null,
        contactPerson: bid.buyer.buyerProfile.representativeName || rawInternal.contactPerson || bid.buyer.name || null,
        email: bid.buyer.buyerProfile.email || rawInternal.email || bid.buyer.email || null,
        mobile: bid.buyer.buyerProfile.mobile || rawInternal.mobile || bid.buyer.mobile || null,
        phone: bid.buyer.buyerProfile.mobile || rawInternal.mobile || bid.buyer.mobile || null,
        registeredAddress: bid.buyer.buyerProfile.registeredAddress || bid.buyer.buyerProfile.corporateAddress || bid.buyer.buyerProfile.address || null,
        address: bid.buyer.buyerProfile.registeredAddress || bid.buyer.buyerProfile.corporateAddress || bid.buyer.buyerProfile.address || null,
        city: bid.buyer.buyerProfile.city || null,
        district: bid.buyer.buyerProfile.district || null,
        state: bid.buyer.buyerProfile.state || null,
        pincode: bid.buyer.buyerProfile.pincode || null,
      } : {
        id: null,
        organizationName: bid.buyerOrganizationName || rawInternal.orgName || null,
        department: rawInternal.department || null,
        departmentName: rawInternal.department || null,
        designation: null,
        representativeName: rawInternal.contactPerson || bid.buyer.name || null,
        contactPerson: rawInternal.contactPerson || bid.buyer.name || null,
        email: rawInternal.email || bid.buyer.email || null,
        mobile: rawInternal.mobile || bid.buyer.mobile || null,
        phone: rawInternal.mobile || bid.buyer.mobile || null,
        registeredAddress: null,
        address: null,
        city: null,
        district: null,
        state: null,
        pincode: null,
      }
    } : (rawInternal.contactPerson || bid.buyerOrganizationName ? {
      id: null,
      name: rawInternal.contactPerson || bid.buyerOrganizationName,
      email: rawInternal.email || null,
      mobile: rawInternal.mobile || null,
      buyerProfile: {
        id: null,
        organizationName: bid.buyerOrganizationName || rawInternal.orgName || null,
        department: rawInternal.department || null,
        departmentName: rawInternal.department || null,
        designation: null,
        representativeName: rawInternal.contactPerson || null,
        contactPerson: rawInternal.contactPerson || null,
        email: rawInternal.email || null,
        mobile: rawInternal.mobile || null,
        phone: rawInternal.mobile || null,
        registeredAddress: null,
        address: null,
        city: null,
        district: null,
        state: null,
        pincode: null,
      }
    } : null),
    buyerOrganization: bid.buyerOrganization || (bid.buyerOrganizationName ? {
      id: null,
      organizationName: bid.buyerOrganizationName || rawInternal.orgName || null,
    } : null),
    documents: publicDocuments.map((doc: any) => {
      let fileAssetId = doc.fileAssetId;
      if (!fileAssetId && doc.fileUrl) {
        const match = String(doc.fileUrl).match(/\/api\/(?:public\/)?files\/(\d+)/);
        if (match && match[1]) fileAssetId = Number(match[1]);
      }
      return {
        id: doc.id,
        documentType: doc.documentType,
        fileName: doc.fileName,
        mimeType: doc.mimeType,
        fileSize: doc.fileSize,
        visibility: doc.visibility,
        fileAssetId: fileAssetId || doc.id,
        fileUrl: doc.fileUrl || (fileAssetId ? `/api/files/${fileAssetId}/view` : null)
      };
    }),
    participantsCount: (bid.participations || []).filter((p: any) => {
      const subStatus = String(p.submissionStatus || p.status || '').toUpperCase();
      return subStatus !== 'DRAFT' && !p.isWithdrawn;
    }).length,
    hasSubmittedProposal: actorRole === 'seller' ? (bid.participations || []).some((p: any) => {
      const pSellerId = Number(p.sellerId || p.sellerUserId || p.seller?.id || 0);
      const pOrgId = Number(p.organizationId || p.sellerOrganizationId || p.seller?.organizationId || p.seller?.organization?.id || 0);
      const matchesUser = (actor?.id && pSellerId === Number(actor.id)) || (actor?.organizationId && pOrgId === Number(actor.organizationId));
      const subStatus = String(p.submissionStatus || p.status || '').toUpperCase();
      return matchesUser && subStatus === 'SUBMITTED';
    }) : undefined,
    myParticipation: actorRole === 'seller' ? (() => {
      const found = (bid.participations || []).find((p: any) => {
        const pSellerId = Number(p.sellerId || p.sellerUserId || p.seller?.id || 0);
        const pOrgId = Number(p.organizationId || p.sellerOrganizationId || p.seller?.organizationId || p.seller?.organization?.id || 0);
        return (actor?.id && pSellerId === Number(actor.id)) || (actor?.organizationId && pOrgId === Number(actor.organizationId));
      });
      return found ? serializeParticipation(found, { canSeeFinancial: true, bid, ownView: true }) : undefined;
    })() : undefined,
    hasParticipated: actorRole === 'seller' ? (bid.participations || []).some((p: any) => {
      const pSellerId = Number(p.sellerId || p.sellerUserId || p.seller?.id || 0);
      const pOrgId = Number(p.organizationId || p.sellerOrganizationId || p.seller?.organizationId || p.seller?.organization?.id || 0);
      return (actor?.id && pSellerId === Number(actor.id)) || (actor?.organizationId && pOrgId === Number(actor.organizationId));
    }) : undefined,
    participations: canSeeParticipants ? (bid.participations || []).filter((p: any) => {
      if (isAdmin || isBuyerOwner) return true;
      if (actorRole === 'seller') {
        const isOwn = (actor?.id && Number(p.sellerId) === Number(actor.id)) || (actor?.organizationId && p.seller?.organizationId === actor.organizationId);
        // During bidding and before financial evaluation, sellers must only see their own participation
        if (!financialOpenStatuses.includes(bid.status)) {
          return isOwn;
        }
        return options.includeParticipants ? true : isOwn;
      }
      return false;
    }).map((p: any) => {
      const isOwn = (actor?.id && Number(p.sellerId) === Number(actor.id)) || (actor?.organizationId && p.seller?.organizationId === actor.organizationId);
      const isDisqualified = ['DISQUALIFIED', 'REJECTED', 'NOT_QUALIFIED'].includes(String(p.technicalStatus || '').toUpperCase());
      const isFinancialStageForBuyer = financialOpenStatuses.includes(bid.status) || bid.status === 'TECHNICAL_EVALUATION_COMPLETED';
      const allowFinancial = isAdmin || isOwn || (isTwoPacket ? (isBuyerOwner && isFinancialStageForBuyer && !isDisqualified) : (isBuyerOwner && (options.includeFinancial || financialOpenStatuses.includes(bid.status))));
      return serializeParticipation(p, { canSeeFinancial: allowFinancial, bid, ownView: isOwn });
    }) : undefined,
    results: canSeeParticipants ? (bid.participations || [])
      .filter((p: any) => {
        const subStatus = String(p.submissionStatus || p.status || '').toUpperCase();
        if (subStatus === 'DRAFT' || p.isWithdrawn) return false;
        if (isAdmin || isBuyerOwner) return true;
        if (actorRole === 'seller') {
          const isOwn = (actor?.id && Number(p.sellerId) === Number(actor.id)) || (actor?.organizationId && p.seller?.organizationId === actor.organizationId);
          if (!financialOpenStatuses.includes(bid.status)) return isOwn;
          return options.includeParticipants ? true : isOwn;
        }
        return false;
      })
      .map((p: any) => {
        const isOwn = (actor?.id && Number(p.sellerId) === Number(actor.id)) || (actor?.organizationId && p.seller?.organizationId === actor.organizationId);
        const isDisqualified = ['DISQUALIFIED', 'REJECTED', 'NOT_QUALIFIED'].includes(String(p.technicalStatus || '').toUpperCase());
        const isFinancialStageForBuyer = financialOpenStatuses.includes(bid.status) || bid.status === 'TECHNICAL_EVALUATION_COMPLETED';
        const allowFinancial = isAdmin || isOwn || (isTwoPacket ? (isBuyerOwner && isFinancialStageForBuyer && !isDisqualified) : (isBuyerOwner && (options.includeFinancial || financialOpenStatuses.includes(bid.status))));
        return serializeParticipation(p, { canSeeFinancial: allowFinancial, bid, ownView: isOwn });
      })
      .sort((a: any, b: any) => {
        if (isTwoPacket && !financialOpenStatuses.includes(bid.status) && !(isBuyerOwner && bid.status === 'TECHNICAL_EVALUATION_COMPLETED')) {
          const aQual = a.technicalStatus === 'QUALIFIED' ? 1 : 0;
          const bQual = b.technicalStatus === 'QUALIFIED' ? 1 : 0;
          if (aQual !== bQual) return bQual - aQual;
          return new Date(a.submittedAt || a.createdAt || 0).getTime() - new Date(b.submittedAt || b.createdAt || 0).getTime();
        }
        const priceA = Number(a.totalAmount || a.quotedAmount || 0);
        const priceB = Number(b.totalAmount || b.quotedAmount || 0);
        if (priceA > 0 && priceB > 0 && priceA !== priceB) return priceA - priceB;
        if (priceA > 0 && priceB <= 0) return -1;
        if (priceB > 0 && priceA <= 0) return 1;
        return new Date(a.submittedAt || a.createdAt || 0).getTime() - new Date(b.submittedAt || b.createdAt || 0).getTime();
      })
      .map((p: any, idx: number) => {
        const isDisqualified = ['DISQUALIFIED', 'REJECTED', 'NOT_QUALIFIED'].includes(String(p.technicalStatus || '').toUpperCase());
        const isFinSealed = Boolean(p.financialSealed || (isTwoPacket && (!financialOpenStatuses.includes(bid.status) && !(isBuyerOwner && bid.status === 'TECHNICAL_EVALUATION_COMPLETED') || isDisqualified) && !isAdmin));
        const rawQuotedAmt = p.totalAmount ?? p.quotedAmount ?? null;
        const quotedAmt = isFinSealed ? null : (rawQuotedAmt != null ? Number(rawQuotedAmt) : null);
        const sellerOrg = p.sellerName || p.seller?.organization?.organizationName || p.seller?.name || 'Supplier';
        const contactPerson = p.seller?.name || p.contactPerson || p.sellerName || 'Representative';
        const rawTech = String(p.technicalStatus || '').toUpperCase();
        const techStatusNormalized = rawTech === 'QUALIFIED' || rawTech === 'SHORTLISTED' || rawTech === 'ACCEPTED'
          ? 'Qualified'
          : rawTech === 'DISQUALIFIED' || rawTech === 'REJECTED'
            ? 'Disqualified'
            : 'Pending';
        return {
          id: p.id,
          participationId: p.id,
          sellerId: p.sellerId,
          sellerName: sellerOrg,
          contactPerson: contactPerson,
          sellerEmail: p.sellerEmail || 'Not provided',
          sellerMobile: p.sellerMobile || 'Not listed',
          submittedAt: p.submittedAt || p.createdAt,
          sellerType: 'Verified Supplier',
          offeredItem: p.offeredItemDescription || 'Procurement requirement',
          makeBrand: p.makeBrand || 'Standard',
          model: p.model || 'Standard',
          technicalStatus: techStatusNormalized,
          totalPrice: quotedAmt,
          quotedAmount: quotedAmt,
          gstPercentage: isFinSealed ? null : Number(p.gstPercentage || 0),
          totalAmount: quotedAmt,
          offeredQuantity: p.offeredQuantity || 1,
          deliveryTimeline: p.deliveryTimeline || 'Standard',
          documents: p.documents || [],
          lineItems: p.lineItems || [],
          finalRank: isFinSealed ? '-' : `L${idx + 1}`,
          resultStatus: rawTech === 'DISQUALIFIED' ? 'Ineligible' : 'Responsive',
          financialSealed: isFinSealed,
          details: {
            organizationName: sellerOrg,
            contactPerson: contactPerson,
            email: p.sellerEmail || '',
            mobile: p.sellerMobile || '',
            submittedAt: p.submittedAt || p.createdAt,
            deliveryTimeline: p.deliveryTimeline || 'Standard',
            complianceRemarks: p.complianceRemarks || 'Compliant',
            rfqNotes: p.rfqNotes || p.offeredItemDescription || '',
            terms: p.terms || '',
            message: p.offeredItemDescription || '',
            quotedAmount: quotedAmt,
            totalAmount: quotedAmt,
            offeredQuantity: p.offeredQuantity || 1,
            lineItems: p.lineItems || [],
            documents: p.documents || [],
          }
        };
      }) : undefined,
    clarifications: (isAdmin || isBuyerOwner)
      ? bid.clarifications
      : actor?.role === 'seller'
        ? (bid.clarifications || []).filter((c: any) => {
            const isRestrictedBid = ['DIRECT_PURCHASE', 'CATALOG_PURCHASE', 'REPEAT_ORDER', 'LIMITED_TENDER', 'SINGLE_SOURCE', 'PAC', 'EMERGENCY_PURCHASE'].includes(String(bid.procurementType || bid.bidType).toUpperCase());
            if (isRestrictedBid) {
              return c.sellerId === Number(actor.id);
            }
            return true;
          }).map((c: any) => {
            const isRestrictedBid = ['DIRECT_PURCHASE', 'CATALOG_PURCHASE', 'REPEAT_ORDER', 'LIMITED_TENDER', 'SINGLE_SOURCE', 'PAC', 'EMERGENCY_PURCHASE'].includes(String(bid.procurementType || bid.bidType).toUpperCase());
            if (isRestrictedBid) {
              return c;
            }
            const isOwn = c.sellerId === Number(actor.id);
            return {
              id: c.id,
              bidId: c.bidId,
              participationId: isOwn ? c.participationId : undefined,
              sellerId: isOwn ? c.sellerId : undefined,
              buyerId: c.buyerId,
              requestNumber: c.requestNumber,
              clarificationType: c.clarificationType,
              question: c.question,
              response: c.response,
              status: c.status,
              requestedById: isOwn ? c.requestedById : undefined,
              respondedById: isOwn ? c.respondedById : undefined,
              requestedAt: c.requestedAt,
              respondedAt: c.respondedAt,
              dueDate: isOwn ? c.dueDate : undefined,
              createdAt: c.createdAt,
              updatedAt: c.updatedAt,
              files: isOwn ? c.files : [],
              sellerName: isOwn ? (c.seller?.name || 'You') : `Bidder ${c.sellerId % 10 + 1}`
            };
          })
        : undefined,
    evaluations: isAdmin || isBuyerOwner ? bid.evaluations : undefined,
    awards: bid.awards,
    invitations: canSeeParticipants ? dbInvitations : undefined,
    invitedCount: effectiveInviteCount,
    invitationsCount: effectiveInviteCount,
    invitedSellers: enrichedVendors.invitedSellers
  };
};

export const serializeParticipation = (p: any, options: { canSeeFinancial?: boolean; bid?: any; ownView?: boolean } = {}) => {
  const bid = options.bid || p.bid;
  const canSeeFin = options.canSeeFinancial !== false;
  const rawQuoted = p.quotedAmount ?? p.totalAmount ?? p.responseData?.totalAmount ?? p.responseData?.quotedAmount ?? p.responseData?.totalPrice;
  const rawTotal = p.totalAmount ?? p.quotedAmount ?? p.responseData?.totalAmount ?? p.responseData?.quotedAmount ?? p.responseData?.totalPrice;

  // Merge all possible technical data sources in priority order:
  // stored DB columns > responseData > acknowledgement (may hold pre-submit technical data)
  const ackData = (p.acknowledgement && typeof p.acknowledgement === 'object' && !Array.isArray(p.acknowledgement))
    ? (p.acknowledgement as Record<string, any>)
    : {};
  const respData = (p.responseData && typeof p.responseData === 'object' && !Array.isArray(p.responseData))
    ? (p.responseData as Record<string, any>)
    : {};

  // Parse offeredItemDescription if it's a JSON string
  let descData: Record<string, any> = {};
  try {
    if (p.offeredItemDescription && (String(p.offeredItemDescription).startsWith('{') || String(p.offeredItemDescription).startsWith('['))) {
      descData = JSON.parse(p.offeredItemDescription);
    }
  } catch { /* ignore */ }

  const first = (...vals: any[]) => vals.find(v => v !== undefined && v !== null && String(v).trim() !== '');

  const lineItemsArr = p.lineItems || respData.lineItems || ackData.lineItems || descData.lineItems || [];
  const firstItem = lineItemsArr.length ? lineItemsArr[0] : {};
  const techOffer = descData.technicalOffer || respData.technicalOffer || ackData.technicalOffer || {};

  const sanitizePricesDeep = (data: any): any => {
    if (!data || typeof data !== 'object') return data;
    if (Array.isArray(data)) return data.map(sanitizePricesDeep);
    const clone = { ...data };
    const priceKeys = ['quotedAmount', 'totalAmount', 'unitPrice', 'lineTotal', 'unitRate', 'totalPrice', 'quotedPrice', 'price', 'gstAmount', 'taxAmount'];
    for (const key of Object.keys(clone)) {
      if (priceKeys.includes(key)) {
        clone[key] = null;
      } else if (clone[key] && typeof clone[key] === 'object') {
        clone[key] = sanitizePricesDeep(clone[key]);
      }
    }
    return clone;
  };

  const rawResp = { ...ackData, ...respData, ...descData };

  return {
    id: p.id,
    bidId: p.bidId,
    sellerId: p.sellerId,
    sellerUserId: p.sellerId,
    organizationId: p.seller?.organizationId || p.organizationId || null,
    sellerOrganizationId: p.seller?.organizationId || p.sellerOrgId || p.organizationId || null,
    seller: p.seller ? {
      id: p.seller.id,
      name: p.seller.name,
      email: p.seller.email,
      mobile: p.seller.mobile,
      role: p.seller.role,
      onboardingStatus: p.seller.onboardingStatus,
      organizationId: p.seller.organizationId,
      organization: p.seller.organization
    } : undefined,
    sellerName: p.sellerName || p.seller?.name || p.seller?.organization?.organizationName,
    sellerEmail: first(p.seller?.email, p.sellerEmail, respData.sellerEmail, ackData.sellerEmail, descData.sellerEmail, p.seller?.organization?.email),
    sellerMobile: first(p.seller?.mobile, p.seller?.sellerProfile?.mobile, p.seller?.sellerProfile?.phone, p.sellerMobile, p.phone, p.mobile, respData.sellerMobile, respData.mobile, respData.phone, ackData.sellerMobile, ackData.mobile, ackData.phone, descData.sellerMobile, descData.mobile, descData.phone, p.seller?.organization?.mobile, p.seller?.organization?.phone),
    participationNumber: p.participationNumber,
    technicalStatus: p.technicalStatus,
    financialStatus: p.financialStatus,
    finalStatus: p.finalStatus,
    rank: p.rank,
    quotedAmount: canSeeFin ? moneyNumber(rawQuoted) : null,
    gstPercentage: canSeeFin ? moneyNumber(first(p.gstPercentage, respData.gstPercentage, ackData.gstPercentage, descData.gstPercentage, firstItem.gstPercent, firstItem.gstPercentage)) : null,
    totalAmount: canSeeFin ? moneyNumber(rawTotal) : null,
    financialSealed: !canSeeFin,
    financialMessage: !canSeeFin ? 'Financial bid is sealed until opening' : undefined,
    makeBrand: first(p.makeBrand, respData.makeBrand, ackData.makeBrand, descData.makeBrand, techOffer.makeBrand, firstItem.makeBrand, firstItem.brand),
    model: first(p.model, p.modelNumber, respData.model, respData.modelNumber, ackData.model, ackData.modelNumber, descData.model, descData.modelNumber, techOffer.model, techOffer.modelNumber, firstItem.model, firstItem.modelNumber, firstItem.partNumber),
    offeredItemDescription: first(descData.offeredItemDescription, p.offeredItemDescription, respData.offeredItemDescription, ackData.offeredItemDescription, techOffer.offeredItemDescription),
    // Flatten technical offer fields from all sources so buyer always sees them
    complianceRemarks: first(descData.complianceRemarks, respData.complianceRemarks, ackData.complianceRemarks, techOffer.complianceRemarks, firstItem.complianceRemarks, firstItem.remarks),
    deliveryTimeline: first(
      p.deliveryTimeline,
      descData.deliveryTimeline,
      respData.deliveryTimeline,
      ackData.deliveryTimeline,
      techOffer.deliveryTimeline,
      firstItem.deliveryTimeline,
      firstItem.deliveryRequirement,
      firstItem.deliverySchedule,
      bid?.schedule?.requiredByDate ? `By ${bid.schedule.requiredByDate}` : undefined,
      bid?.basics?.requiredByDate ? `By ${bid.basics.requiredByDate}` : undefined,
      bid?.terms?.deliveryTerms,
      bid?.deliveryRequirement
    ),
    warrantyDetails: first(descData.warrantyDetails, respData.warrantyDetails, ackData.warrantyDetails, techOffer.warrantyDetails, firstItem.warrantyDetails),
    serviceSupport: first(descData.serviceSupport, respData.serviceSupport, ackData.serviceSupport, techOffer.serviceSupport),
    deviation: first(descData.deviation, respData.deviation, ackData.deviation, techOffer.deviation, firstItem.deviation),
    rfqNotes: first(descData.rfqNotes, respData.rfqNotes, ackData.rfqNotes, descData.notes, respData.notes, ackData.notes),
    responseData: canSeeFin ? rawResp : sanitizePricesDeep(rawResp),
    acknowledgement: canSeeFin ? p.acknowledgement : sanitizePricesDeep(p.acknowledgement),
    lineItems: lineItemsArr.map((item: any) => {
      const resolvedHsn = first(item.hsnCode, item.hsn_sac_code, item.hsn, item.hsnSac, item.hsn_code);
      return {
        ...item,
        hsnCode: resolvedHsn || null,
        hsn: resolvedHsn || null,
        unitPrice: canSeeFin ? item.unitPrice : null,
        lineTotal: canSeeFin ? item.lineTotal : null,
        unitRate: canSeeFin ? item.unitRate : null,
        totalAmount: canSeeFin ? item.totalAmount : null,
        gstPercent: canSeeFin ? item.gstPercent : null,
        gstPercentage: canSeeFin ? item.gstPercentage : null,
      };
    }),
    terms: first(p.terms, respData.terms, ackData.terms, descData.terms, descData.paymentTerms, respData.paymentTerms, ackData.paymentTerms),
    paymentTerms: first(p.paymentTerms, respData.paymentTerms, ackData.paymentTerms, descData.paymentTerms, p.terms, respData.terms, ackData.terms, descData.terms, bid?.paymentTerms, bid?.terms?.paymentTerms),
    offeredQuantity: first(p.offeredQuantity, respData.offeredQuantity, ackData.offeredQuantity, descData.offeredQuantity, (firstItem.quantity != null ? `${firstItem.quantity} ${firstItem.unitOfMeasure || firstItem.unit || 'Nos'}` : undefined)),
    status: p.submissionStatus || 'DRAFT',
    submissionStatus: p.submissionStatus || 'DRAFT',
    submittedAt: p.submittedAt,
    technicalSubmittedAt: p.technicalSubmittedAt,
    financialSubmittedAt: p.financialSubmittedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    isWithdrawn: p.isWithdrawn,
    rejectionReason: p.rejectionReason,
    documents: (() => {
      const allDocs: any[] = [
        ...(Array.isArray(p.documents) ? p.documents : []),
        ...(Array.isArray(respData.documents) ? respData.documents : []),
        ...(Array.isArray(ackData.documents) ? ackData.documents : []),
        ...(Array.isArray(descData.documents) ? descData.documents : [])
      ];
      const attUrls = [p.attachmentUrl, respData.attachmentUrl, ackData.attachmentUrl, descData.attachmentUrl].filter(Boolean);
      for (const u of attUrls) {
        if (typeof u === 'string' && u.trim() && !allDocs.some(d => d.fileUrl === u || d.url === u)) {
          allDocs.push({
            id: `att-${p.id}`,
            documentCategory: 'TECHNICAL_PROPOSAL',
            documentName: 'Quotation Proposal Document',
            fileName: u.split('/').pop() || 'Proposal_Document.pdf',
            fileUrl: u,
            fileAssetId: p.fileAssetId || null
          });
        }
      }
      return filterSealedDocuments(allDocs, canSeeFin);
    })().map((doc: any) => ({
      id: doc.id,
      documentCategory: doc.documentCategory || 'TECHNICAL_PROPOSAL',
      documentName: doc.documentName || doc.name || doc.fileName || 'Attachment',
      fileName: doc.fileName || doc.name || 'document',
      fileUrl: doc.fileUrl || doc.url || null,
      fileKey: doc.fileKey || null,
      mimeType: doc.mimeType || 'application/octet-stream',
      fileSize: doc.fileSize || 0,
      documentStatus: doc.documentStatus || 'UPLOADED',
      uploadedAt: doc.uploadedAt || p.submittedAt || p.createdAt,
      fileAssetId: doc.fileAssetId || null
    })),
    hasSealedFinancialQuote: !canSeeFin,
    clarifications: p.clarifications,
    evaluations: p.evaluations,
    awards: p.awards
  };
};

const getTenderBidActivityWhere = (query: any = {}) => {
  const where: any = {
    status: { in: ['published', 'bid_submission'] },
    bids: { some: { status: { not: 'withdrawn' }, withdrawnAt: null } }
  };

  if (query.status && !['OPEN', 'PUBLISHED', 'BID_SUBMISSION'].includes(String(query.status).toUpperCase())) {
    where.id = -1;
  }
  if (query.q) {
    const q = String(query.q);
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { tenderId: { contains: q, mode: 'insensitive' } },
      { category: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
      { buyer: { name: { contains: q, mode: 'insensitive' } } }
    ];
  }
  if (query.category) where.category = { contains: String(query.category), mode: 'insensitive' };
  if (query.bidType && !String(query.bidType).toLowerCase().includes('tender')) where.id = -1;
  return where;
};

export const serializeTenderBidActivity = (tender: any) => {
  const profile = tender.buyer?.buyerProfile;
  const latestBid = tender.bids?.[0];
  const fullAddress = [
    profile?.registeredAddress || profile?.corporateAddress || profile?.address,
    profile?.city,
    profile?.district,
    profile?.state,
    profile?.pincode
  ].filter(Boolean).join(', ');
  const location = fullAddress || [profile?.city, profile?.state].filter(Boolean).join(', ');
  const closesAt = tender.closesAt || latestBid?.createdAt || tender.updatedAt || tender.createdAt;
  const contactName = profile?.representativeName || tender.buyer?.name || 'Authorized Procurement Officer';
  const orgName = profile?.organizationName || tender.buyer?.name || 'Verified buyer';

  return {
    id: `TENDER-${tender.id}`,
    sourceModel: 'TENDER',
    sourceId: tender.id,
    bidNumber: tender.tenderId,
    title: tender.title,
    description: tender.description,
    buyerName: contactName,
    buyerEmail: profile?.email || tender.buyer?.email || '',
    buyerMobile: profile?.mobile || tender.buyer?.mobile || '',
    buyerAddress: location || 'Location not specified',
    buyerOrganizationName: orgName,
    buyerType: profile?.organizationType || 'Private Enterprise',
    departmentName: profile?.department || 'Procurement & Stores Department',
    category: tender.category,
    bidType: 'Tender',
    procurementType: 'Tender Bid',
    quantity: null,
    unit: null,
    estimatedValue: moneyNumber(tender.budget),
    deliveryLocation: location || 'Location not specified',
    state: profile?.state || null,
    district: profile?.district || profile?.city || null,
    startDate: tender.publishedAt || tender.createdAt,
    endDate: closesAt,
    status: tender.status,
    approvalStatus: 'APPROVED',
    lifecycleStage: 'SELLER_PARTICIPATION',
    termsAndConditions: [],
    eligibilityCriteria: [],
    requiredDocuments: tender.documentUrl ? ['Tender specification document'] : [],
    createdAt: tender.createdAt,
    updatedAt: latestBid?.createdAt || tender.updatedAt,
    participantsCount: tender._count?.bids ?? 0,
    buyer: tender.buyer ? {
      id: tender.buyer.id,
      name: tender.buyer.name || contactName,
      email: tender.buyer.email || profile?.email || '',
      mobile: tender.buyer.mobile || profile?.mobile || '',
      buyerProfile: profile ? {
        id: profile.id,
        organizationName: orgName,
        department: profile.department,
        departmentName: profile.department,
        designation: profile.designation,
        representativeName: profile.representativeName,
        contactPerson: profile.representativeName,
        email: profile.email || tender.buyer?.email,
        phone: profile.mobile || tender.buyer?.mobile,
        mobile: profile.mobile || tender.buyer?.mobile,
        address: profile.registeredAddress || profile.corporateAddress || profile.address || location,
        registeredAddress: profile.registeredAddress || profile.corporateAddress || profile.address,
        corporateAddress: profile.corporateAddress,
        city: profile.city,
        district: profile.district,
        state: profile.state,
        pincode: profile.pincode,
      } : null
    } : null,
    buyerOrganization: profile ? {
      organizationName: orgName,
      organizationType: profile.organizationType,
      city: profile.city,
      district: profile.district,
      state: profile.state,
    } : null,
    documents: tender.documentUrl ? [{
      id: `tender-doc-${tender.id}`,
      documentType: 'TENDER_DOCUMENT',
      fileName: tender.documentUrl.split('/').pop() || 'Tender document',
      mimeType: '',
      fileSize: 0,
      visibility: 'PUBLIC',
      fileAssetId: null,
      fileUrl: tender.documentUrl
    }] : []
  };
};

export const resolveTenderBidActivity = async (idOrNumber: string | number) => {
  const token = String(idOrNumber).trim();
  const digits = token.match(/\d+/g);
  const lastDigits = digits ? digits[digits.length - 1] : null;
  const numId = Number(token) || (token.startsWith('TENDER-') ? Number(token.replace('TENDER-', '')) : null);

  const searchOr: any[] = [
    { tenderId: token },
    { tenderId: token.replace(/-2026-/, '-') },
    { tenderId: token.replace(/^TND-/, 'TENDER-') },
    { tenderId: token.replace(/^TENDER-/, 'TND-') },
  ];
  if (numId && Number.isFinite(numId)) searchOr.push({ id: numId });
  if (lastDigits) {
    searchOr.push({ tenderId: `TND-${lastDigits}` });
    searchOr.push({ tenderId: `TND-2026-${lastDigits}` });
    searchOr.push({ tenderId: `TND-2026-${lastDigits.padStart(5, '0')}` });
    const parsedLast = Number(lastDigits);
    if (Number.isFinite(parsedLast) && parsedLast > 0 && parsedLast <= 2147483647) {
      searchOr.push({ id: parsedLast });
    }
  }

  const tender = await db.tender.findFirst({
    where: { OR: searchOr },
    select: {
      id: true,
      tenderId: true,
      title: true,
      description: true,
      category: true,
      budget: true,
      documentUrl: true,
      status: true,
      closesAt: true,
      publishedAt: true,
      createdAt: true,
      updatedAt: true,
      buyer: {
        select: {
          id: true,
          name: true,
          email: true,
          mobile: true,
          buyerProfile: {
            select: {
              id: true,
              organizationName: true,
              organizationType: true,
              department: true,
              designation: true,
              representativeName: true,
              email: true,
              mobile: true,
              registeredAddress: true,
              corporateAddress: true,
              city: true,
              district: true,
              state: true,
              pincode: true
            }
          }
        }
      },
      bids: {
        where: { status: { not: 'withdrawn' }, withdrawnAt: null },
        select: { createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1
      },
      _count: { select: { bids: { where: { status: { not: 'withdrawn' }, withdrawnAt: null } } } }
    }
  });

  if (!tender) throw new ApiError(404, 'Tender opportunity not found', 'TENDER_NOT_FOUND');
  return serializeTenderBidActivity(tender);
};

export const assertSellerVerified = async (actor: Actor) => {
  if (actor.role !== 'seller') throw new ApiError(403, 'Only verified sellers/vendors can participate in bids.', 'FORBIDDEN_ROLE');
  const user = await db.user.findUnique({
    where: { id: actor.id },
    include: { sellerProfile: true, organization: true }
  });
  assertActiveAccount(user, 'Seller');
  if (user?.organization?.isBlacklisted || user?.organization?.verificationStatus === 'SUSPENDED') {
    throw new ApiError(403, 'Seller organization is blocked for procurement participation.', 'SELLER_NOT_VERIFIED');
  }
  const profileVerified = user?.isDualRole
    ? user?.sellerProfile?.verificationStatusEnum === 'VERIFIED'
    : user?.sellerProfile?.verificationStatusEnum === 'VERIFIED' || user?.sellerProfile?.panVerified || user?.sellerProfile?.isUdyamCertified;
  const orgVerified = user?.organization?.verificationStatus === 'VERIFIED';
  const legacyApproved = user?.isDualRole ? false : sellerVerifiedStatuses.includes(String(user?.onboardingStatus));
  if (!user || (!legacyApproved && !profileVerified && !orgVerified)) {
    throw new ApiError(403, 'Please complete seller verification before participating in bids.', 'SELLER_NOT_VERIFIED');
  }
};

export const assertBuyerVerified = async (actor: Actor) => {
  if (actor.role !== 'buyer') throw new ApiError(403, 'Buyer access required', 'FORBIDDEN_ROLE');
  const user = await db.user.findUnique({
    where: { id: actor.id },
    include: { buyerProfile: true, organization: true }
  });
  assertActiveAccount(user, 'Buyer');
  if (user?.organization?.isBlacklisted || user?.organization?.verificationStatus === 'SUSPENDED') {
    throw new ApiError(403, 'Buyer organization is blocked for procurement publishing.', 'BUYER_NOT_VERIFIED');
  }
  const orgVerified = user?.organization ? verifiedOrganizationStatuses.includes(String(user.organization.verificationStatus)) : false;
  const profileVerified = user?.buyerProfile?.verificationStatusEnum === 'VERIFIED' || user?.buyerProfile?.verificationStatus === 'VERIFIED';
  const legacyApproved = user?.isDualRole ? false : sellerVerifiedStatuses.includes(String(user?.onboardingStatus));
  if (!user || (!orgVerified && !profileVerified && !legacyApproved)) {
    throw new ApiError(403, 'Buyer organization must be verified before submitting bids for admin approval.', 'BUYER_NOT_VERIFIED');
  }
  return user;
};

export const assertBidOpen = (bid: any) => {
  if (bid.status !== 'OPEN') throw new ApiError(400, 'This bid is not open for participation.', 'BID_NOT_OPEN');
  if (new Date(bid.endDate) <= now()) throw new ApiError(400, 'This bid is already closed.', 'BID_ALREADY_CLOSED');
};

export const assertBuyerOwner = (actor: Actor, bid: any) => {
  if (actor.role !== 'buyer' && actor.role !== 'admin' && actor.role !== 'master_admin') {
    throw new ApiError(403, 'Buyer access required', 'FORBIDDEN_ROLE');
  }
  if (actor.role === 'buyer' && bid.buyerId && Number(bid.buyerId) !== Number(actor.id) && (!actor.organizationId || bid.buyerOrganizationId !== actor.organizationId)) {
    if (bid.sourceModel === 'REQUIREMENT' || bid.sourceModel === 'QUOTE_REQUEST' || bid.sourceId) {
      return;
    }
    throw new ApiError(403, 'You cannot access another buyer bid.', 'FORBIDDEN_ROLE');
  }
};

export const listPublicBids = async (query: any, actor?: any) => {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(500, Math.max(1, Number(query.pageSize || 12)));
  const takeForMergedPage = page * pageSize;
  const actorInviteIds = (actor?.role === 'seller' || actor?.role === 'shg')
    ? [Number(actor.id), Number(actor.organizationId)].filter(Number.isFinite)
    : [];
  // Fallback for rows created before the invitation table existed / not yet backfilled:
  // still honour invited sellers embedded in the technicalPacket JSON.
  const invitedBidFilters = actorInviteIds.flatMap(value => ([
    { technicalPacket: { path: ['vendors', 'invitedSellers'], array_contains: value } },
    { technicalPacket: { path: ['qualifiedVendors'], array_contains: value } }
  ]));

  // A bid is "private" when visibility=PRIVATE OR (for legacy rows with the default
  // PUBLIC value) its method is a restricted method. This mirrors isPrivateBid().
  const privateBidPredicate = {
    OR: [
      { visibility: 'PRIVATE' as const },
      { procurementType: { in: restrictedProcurementMethods } },
      { bidType: { in: restrictedProcurementMethods } }
    ]
  };
  const publicBidPredicate = {
    visibility: 'PUBLIC' as const,
    NOT: {
      OR: [
        { procurementType: { in: restrictedProcurementMethods } },
        { bidType: { in: restrictedProcurementMethods } }
      ]
    }
  };

  const restrictedBidsCondition = actor
    ? (actor.role === 'admin' || actor.role === 'master_admin')
      ? {}
      : {
          OR: [
            // Public bids are visible to everyone.
            publicBidPredicate,
            // Private bids the seller was invited to (relational — the reliable path).
            ...((actor.role === 'seller' || actor.role === 'shg') ? [{
              AND: [
                privateBidPredicate,
                { invitations: { some: { OR: [{ sellerOrgId: { in: actorInviteIds } }, { sellerUserId: { in: actorInviteIds } }] } } }
              ]
            }] : []),
            // Legacy JSON-embedded invitations (un-backfilled rows).
            ...invitedBidFilters,
            // The buyer's own private bids.
            {
              buyerId: actor.id,
              ...privateBidPredicate
            },
            // Bids the seller already participated in.
            {
              participations: {
                some: { sellerId: actor.id }
              }
            }
          ]
        }
    : publicBidPredicate;

  const where: any = {
    approvalStatus: { not: 'REJECTED' },
    status: { in: query.status ? [String(query.status).toUpperCase()] : publicBidStatuses },
    ...restrictedBidsCondition
  };
  if (query.q) {
    const q = String(query.q);
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { bidNumber: { contains: q, mode: 'insensitive' } },
      { category: { contains: q, mode: 'insensitive' } },
      { buyerOrganizationName: { contains: q, mode: 'insensitive' } },
      { district: { contains: q, mode: 'insensitive' } },
      { state: { contains: q, mode: 'insensitive' } }
    ];
  }
  if (query.category) where.category = { contains: String(query.category), mode: 'insensitive' };
  if (query.location) where.OR = [...(where.OR || []), { district: { contains: String(query.location), mode: 'insensitive' } }, { state: { contains: String(query.location), mode: 'insensitive' } }];
  if (query.buyerType) where.buyerType = { contains: String(query.buyerType), mode: 'insensitive' };
  if (query.bidType) where.bidType = { contains: String(query.bidType), mode: 'insensitive' };

  const tenderWhere = getTenderBidActivityWhere(query);
  const [procurementTotal, tenderTotal, bids, tenderBidActivities] = await Promise.all([
    db.procurementBid.count({ where }),
    db.tender.count({ where: tenderWhere }),
    db.procurementBid.findMany({
      where,
      include: {
        documents: true,
        buyerOrganization: true,
        participations: {
          where: { isWithdrawn: false },
          select: { id: true, sellerId: true, submissionStatus: true, seller: { select: { id: true, organizationId: true } } }
        },
        awards: true,
        invitations: { select: { sellerOrgId: true, sellerUserId: true } },
        buyer: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            buyerProfile: {
              select: {
                departmentName: true
              }
            }
          }
        }
      },
      orderBy: query.sort === 'value' 
        ? { estimatedValue: 'desc' } 
        : (query.sort === 'latest' || query.sort === 'newest') 
        ? { createdAt: 'desc' } 
        : { endDate: 'asc' },
      take: takeForMergedPage
    }),
    db.tender.findMany({
      where: tenderWhere,
      select: {
        id: true,
        tenderId: true,
        title: true,
        description: true,
        category: true,
        budget: true,
        documentUrl: true,
        status: true,
        closesAt: true,
        publishedAt: true,
        createdAt: true,
        updatedAt: true,
        buyer: {
          select: {
            id: true,
            name: true,
            buyerProfile: { select: { organizationName: true, organizationType: true, city: true, state: true } }
          }
        },
        bids: {
          where: { status: { not: 'withdrawn' }, withdrawnAt: null },
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1
        },
        _count: { select: { bids: { where: { status: { not: 'withdrawn' }, withdrawnAt: null } } } }
      },
      orderBy: (query.sort === 'latest' || query.sort === 'newest') ? { createdAt: 'desc' } : { updatedAt: 'desc' },
      take: takeForMergedPage
    })
  ]);

  const items = [
    ...bids.map((bid: any) => {
      const isSeller = actor?.role === 'seller';
      const currentActorId = actor?.id ? Number(actor.id) : null;
      const currentOrgId = actor?.organizationId ? Number(actor.organizationId) : null;
      const hasParticipated = isSeller && Boolean(
        bid.participations && Array.isArray(bid.participations) && (
          bid.participations.some((p: any) => {
            const pSellerId = Number(p.sellerId || p.sellerUserId || p.seller?.id || 0);
            const pOrgId = Number(p.organizationId || p.sellerOrganizationId || p.seller?.organizationId || 0);
            return (currentActorId && pSellerId === currentActorId) || (currentOrgId && pOrgId === currentOrgId);
          })
        )
      );

      return {
        ...serializeBid(bid, { actor, includeParticipants: isSeller }),
        sourceModel: 'PROCUREMENT_BID',
        sourceId: bid.id,
        participated: hasParticipated,
        hasParticipated,
        // Emit whether THIS seller was explicitly invited (relational rows or legacy
        // technicalPacket JSON). The invitations page filters on this flag.
        isInvited: actorInviteIds.length > 0 && (
          (bid.invitations || []).some((inv: any) =>
            actorInviteIds.includes(Number(inv.sellerOrgId)) || actorInviteIds.includes(Number(inv.sellerUserId))
          ) ||
          (() => {
            const tp: any = bid.technicalPacket;
            const embedded = [
              ...(Array.isArray(tp?.vendors?.invitedSellers) ? tp.vendors.invitedSellers : []),
              ...(Array.isArray(tp?.qualifiedVendors) ? tp.qualifiedVendors : [])
            ].map(Number);
            return embedded.some(v => actorInviteIds.includes(v));
          })()
        )
      };
    }),
    ...tenderBidActivities.map(serializeTenderBidActivity)
  ]
    .sort((a: any, b: any) => {
      if (query.sort === 'value') return Number(b.estimatedValue || 0) - Number(a.estimatedValue || 0);
      if (query.sort === 'latest' || query.sort === 'newest') {
        const timeB = new Date(b.createdAt || b.publishedAt || b.startDate || 0).getTime();
        const timeA = new Date(a.createdAt || a.publishedAt || a.startDate || 0).getTime();
        return timeB - timeA;
      }
      return new Date(a.endDate || a.updatedAt || a.createdAt).getTime() - new Date(b.endDate || b.updatedAt || b.createdAt).getTime();
    })
    .slice((page - 1) * pageSize, page * pageSize);

  return { items, total: procurementTotal + tenderTotal, page, pageSize };
};

export const createBuyerBid = async (req: AuthRequest, body: any) => {
  if (req.user!.role !== 'buyer') throw new ApiError(403, 'Buyer access required', 'FORBIDDEN_ROLE');
  const user = await db.user.findUnique({ where: { id: req.user!.id }, include: { buyerProfile: true, organization: true } });
  assertActiveAccount(user, 'Buyer');
  if (user?.organization?.isBlacklisted || user?.organization?.verificationStatus === 'SUSPENDED') {
    throw new ApiError(403, 'Buyer organization is blocked for procurement publishing.', 'BUYER_NOT_VERIFIED');
  }
  const bid = await db.procurementBid.create({
    data: {
      bidNumber: await nextBidNumber(body.canonicalMethod || body.procurementType || body.bidType || body.procurementMethod || 'RFQ'),
      title: body.title,
      description: body.description,
      buyerId: req.user!.id,
      buyerOrganizationId: user?.organizationId || user?.buyerProfile?.organizationId,
      buyerOrganizationName: body.buyerOrganizationName || user?.organization?.organizationName || user?.buyerProfile?.organizationName || user?.name || 'Buyer organization',
      buyerType: body.buyerType || user?.organization?.organizationType || user?.buyerProfile?.organizationType || 'Private Enterprise',
      category: body.category,
      bidType: body.bidType,
      procurementType: body.procurementType,
      quantity: body.quantity,
      unit: body.unit,
      estimatedValue: body.estimatedValue,
      deliveryLocation: body.deliveryLocation,
      state: body.state,
      district: body.district,
      pincode: body.pincode,
      startDate: body.startDate,
      endDate: body.endDate,
      technicalOpeningDate: body.technicalOpeningDate,
      financialOpeningDate: body.financialOpeningDate,
      bidValidityDate: body.bidValidityDate,
      evaluationMethod: 'L1',
      documentFee: body.documentFee,
      allowClarification: body.allowClarification ?? true,
      allowReverseAuction: Boolean(body.allowReverseAuction),
      allowBoq: Boolean(body.allowBoq),
      packetType: body.packetType || 'SINGLE_PACKET',
      visibility: deriveVisibility(body) as any,
      technicalPacket: body.technicalPacket,
      financialPacket: body.financialPacket,
      termsAndConditions: body.termsAndConditions || [],
      eligibilityCriteria: body.eligibilityCriteria || [],
      requiredDocuments: body.requiredDocuments || []
    }
  });
  await syncBidInvitations(bid.id, body.technicalPacket, req.user!.id);
  await procurementAudit(req, 'BID_CREATED', 'ProcurementBid', bid.id, bid);
  return bid;
};

export const updateBuyerBid = async (req: AuthRequest, bidId: string, body: any) => {
  const bid = await resolveBid(bidId, { participations: true });
  assertBuyerOwner(req.user!, bid);
  const user = await db.user.findUnique({ where: { id: req.user!.id }, include: { organization: true } });
  if (user?.organization?.isBlacklisted || user?.organization?.verificationStatus === 'SUSPENDED') {
    throw new ApiError(403, 'Buyer organization is blocked for procurement publishing.', 'BUYER_NOT_VERIFIED');
  }
  
  const isPublished = ['PUBLISHED', 'OPEN', 'OPEN_FOR_BIDDING'].includes(String(bid.status).toUpperCase());
  
  if (!isPublished && !editableBidStatuses.includes(bid.status) && !editableApprovalStatuses.includes(bid.approvalStatus)) {
    throw new ApiError(400, 'Only draft, rejected or published bids can be edited.', 'INVALID_STATUS_TRANSITION');
  }

  // ── 3-Gate Validation for Published Bids ──
  if (isPublished) {
    // Check if bidding deadline has already closed
    if (bid.endDate && new Date() >= new Date(bid.endDate)) {
      throw new ApiError(400, 'Cannot edit procurement after the submission deadline has closed.', 'DEADLINE_CLOSED');
    }

    // Gate 1: Time — Must be within 6 hours of publishing
    const GRACE_WINDOW_MS = 6 * 60 * 60 * 1000;
    const publishTime = bid.publishedAt ? new Date(bid.publishedAt) : (bid.createdAt ? new Date(bid.createdAt) : null);
    if (!publishTime) {
      throw new ApiError(400, 'Publish timestamp not recorded. Cannot determine grace window.', 'PUBLISH_TIME_MISSING');
    }
    if (Date.now() - publishTime.getTime() > GRACE_WINDOW_MS) {
      throw new ApiError(409, 'The 6-hour grace edit window has expired. To modify requirements, please cancel this procurement and re-publish.', 'GRACE_WINDOW_EXPIRED');
    }

    // Gate 2: Bids — Must have zero submitted quotations
    const submittedCount = await db.procurementBidParticipation.count({
      where: {
        bidId: bid.id,
        submissionStatus: { notIn: ['DRAFT', 'WITHDRAWN'] },
        isWithdrawn: { not: true }
      }
    });
    if (submittedCount > 0) {
      throw new ApiError(409, `${submittedCount} supplier(s) have already submitted quotations. Editing is locked to protect bidder fairness. To modify requirements, please cancel this procurement and re-publish.`, 'QUOTATIONS_ALREADY_SUBMITTED');
    }

    // Gate 3: Edit Count — Only one post-publish edit allowed
    if ((bid.postPublishEditCount || 0) >= 1) {
      throw new ApiError(409, 'This procurement has already been edited once (maximum allowed). To make further changes, please cancel this procurement and re-publish.', 'EDIT_LIMIT_REACHED');
    }
  }

  // Recompute visibility whenever the method or vendor selection could have changed,
  // using the incoming values falling back to the persisted ones.
  const visibility = deriveVisibility({
    procurementType: body.procurementType ?? bid.procurementType,
    bidType: body.bidType ?? bid.bidType,
    technicalPacket: body.technicalPacket ?? bid.technicalPacket
  });
  body = { ...body, visibility };

  let updated;
  if (isPublished) {
    const nextVersion = (bid.version || 1) + 1;
    updated = await db.$transaction(async (tx: any) => {
      const bidUpdated = await tx.procurementBid.update({
        where: { id: bid.id },
        data: {
          ...body,
          version: nextVersion,
          postPublishEditCount: 1
        }
      });
      return bidUpdated;
    });

    // Send ONE consolidated notification to eligible/category-matched sellers
    try {
      const tp = (bid.technicalPacket || {}) as any;
      const vendorsSelection = String(tp.vendors?.selection || tp.vendors?.selectionMode || '').trim();
      void notificationService.notifySellersAndShgsOfProcurement({
        id: bid.id,
        title: `[Updated] ${updated.title || bid.title}`,
        bidNumber: bid.bidNumber,
        procurementType: updated.procurementType || bid.procurementType,
        canonicalMethod: updated.canonicalMethod || bid.canonicalMethod,
        buyerOrganizationName: bid.buyerOrganizationName,
        estimatedValue: updated.estimatedValue || bid.estimatedValue,
        endDate: updated.endDate || bid.endDate,
        visibility: updated.visibility || bid.visibility,
        sourcingStrategy: vendorsSelection,
        category: updated.category || bid.category,
        invitedSellerOrgIds: extractInvitedSellerIds(updated.technicalPacket || bid.technicalPacket)
      });
    } catch (err) {
      logger.warn({ err, bidId: bid.id }, 'Failed to send post-edit notification to sellers');
    }
  } else {
    updated = await db.procurementBid.update({ where: { id: bid.id }, data: body });
  }

  if (body.technicalPacket !== undefined) {
    await syncBidInvitations(bid.id, body.technicalPacket, req.user!.id);
  }

  await procurementAudit(req, 'BID_UPDATED', 'ProcurementBid', bid.id, updated, bid);

  const newEndDate = body.endDate ? new Date(body.endDate) : null;
  const oldEndDate = bid.endDate ? new Date(bid.endDate) : null;
  if (newEndDate && oldEndDate && newEndDate.getTime() > oldEndDate.getTime()) {
    const notifiedSellerIds = new Set<number>();
    const participations = await db.procurementBidParticipation.findMany({
      where: { bidId: bid.id },
      select: { sellerId: true }
    });
    for (const p of participations) {
      if (p.sellerId) notifiedSellerIds.add(p.sellerId);
    }

    const isLimited = (bid as any).visibility === 'LIMITED' || (bid as any).visibility === 'INVITED_SELLERS_ONLY';
    if (isLimited) {
      const technicalPacket = (bid.technicalPacket && typeof bid.technicalPacket === 'object') ? (bid.technicalPacket as any) : {};
      const invitedOrgIds: number[] = (bid as any).invitedSellerOrgIds || technicalPacket.invitedSellerOrgIds || technicalPacket.rules?.invitedSellerOrgIds || [];
      const invitedUserIds: number[] = (bid as any).invitedUserIds || technicalPacket.invitedUserIds || [];
      if (invitedOrgIds.length > 0 || invitedUserIds.length > 0) {
        const invitedUsers = await db.user.findMany({
          where: {
            role: { in: ['seller', 'shg'] as any },
            accountStatus: { not: 'BLOCKED' as any },
            OR: [
              ...(invitedOrgIds.length ? [{ organizationId: { in: invitedOrgIds } }] : []),
              ...(invitedUserIds.length ? [{ id: { in: invitedUserIds } }] : [])
            ]
          },
          select: { id: true }
        });
        for (const u of invitedUsers) {
          notifiedSellerIds.add(u.id);
        }
      }
    } else {
      const allActiveSellers = await db.user.findMany({
        where: {
          role: { in: ['seller', 'shg'] as any },
          accountStatus: { not: 'BLOCKED' as any }
        },
        select: { id: true }
      });
      for (const u of allActiveSellers) {
        notifiedSellerIds.add(u.id);
      }
    }

    const tenderRef = bid.bidNumber || bid.requirementNumber || `PRC-${bid.id}`;
    const noticeRef = `JSG-TND/${new Date().getFullYear()}/${bid.id}/EXT`;
    const originalDeadlineStr = formatIstDateTime(oldEndDate);
    const revisedDeadlineStr = formatIstDateTime(newEndDate);
    const portalUrl = getPublicPortalUrl();
    const redirectPath = `/seller/procurement/events/${bid.id}`;
    const actionUrl = ensurePublicUrl(redirectPath);

    const detailsTable: TableRow[] = [
      { label: 'Tender / RFQ Reference', value: tenderRef, isCode: true },
      { label: 'Tender Title', value: bid.title, isHighlight: true },
      { label: 'Notice Type', value: 'Submission Deadline Extended', isHighlight: true },
      { label: 'Original Submission Deadline', value: originalDeadlineStr },
      { label: 'Revised Submission Deadline', value: revisedDeadlineStr, color: '#166534', isHighlight: true },
      { label: 'Submission Protocol', value: 'Existing Submissions Remain Valid • Revisions Allowed', color: '#1e40af', isHighlight: true },
      { label: 'Official Portal Gateway', value: `<a href="${portalUrl}" style="color: #1e40af; text-decoration: underline; font-weight: 700;">${portalUrl}</a>` }
    ];

    const emailHtml = buildGovernmentGradeEmailHtml({
      portalName: 'JSG SMILE Procurement Portal',
      departmentName: 'Government of Odisha • District Administration Jharsuguda',
      noticeType: 'OFFICIAL NOTICE • DEADLINE EXTENDED',
      noticeRef,
      badgeVariant: 'warning',
      heading: 'Submission Deadline Extended',
      summary: `Official Notification for Tender "${bid.title}" (${tenderRef}). The submission closing timeline has been extended to ${revisedDeadlineStr}. All previously submitted commercial & technical quotations remain securely sealed and valid. Participating bidders may review or revise their submissions prior to the revised closing timestamp.`,
      detailsTable,
      actionButton: {
        label: 'View Tender & Manage Submission →',
        url: actionUrl
      },
      securityAdvisory: 'Statutory Notice: All procurement submissions on JSG SMILE are encrypted and sealed under Government of Odisha procurement rules.'
    });

    for (const sellerId of notifiedSellerIds) {
      try {
        await notificationService.notifyUser(sellerId, {
          title: 'Submission Deadline Extended',
          message: `The submission deadline for "${bid.title}" (${tenderRef}) has been extended from ${originalDeadlineStr} to ${revisedDeadlineStr}.`,
          type: 'tender.deadline_extended',
          priority: 'high',
          redirectUrl: redirectPath,
          emailSubject: `[Tender Notice] Submission Deadline Extended: ${bid.title} (${tenderRef})`,
          emailHtml,
          detailsTable,
          noticeRef
        }, ['in_app', 'email']);
      } catch (err) {
        logger.warn({ err, sellerId }, 'Failed to send deadline extension notification');
      }
    }

    try {
      const extEvent = {
        type: 'CORRIGENDUM_ISSUED' as const,
        procurementId: bid.id,
        requirementId: bid.requirementNumber || bid.bidNumber || bid.id,
        bidId: bid.id,
        bidNumber: tenderRef,
        corrigendumNumber: Number((updated as any)?.technicalPacket?.corrigendumCount || 1),
        newDeadline: newEndDate.toISOString(),
        revisedDeadlineStr,
        originalDeadlineStr,
        reason: 'Submission deadline extended',
        status: updated.status,
        timestamp: new Date().toISOString()
      };
      broadcastToProcurement(bid.id, extEvent);
      broadcastToProcurement('all', extEvent);
      broadcastToProcurement(bid.id, {
        type: 'PROCUREMENT_UPDATED',
        procurementId: bid.id,
        status: updated.status,
        timestamp: new Date().toISOString()
      });
      broadcastToProcurement('all', {
        type: 'PROCUREMENT_UPDATED',
        procurementId: bid.id,
        status: updated.status,
        timestamp: new Date().toISOString()
      });
    } catch (bcErr) {
      logger.warn({ bcErr, bidId: bid.id }, 'Failed to broadcast deadline extension');
    }
  }

  return updated;
};

export const getBidEditEligibility = async (req: AuthRequest, bidId: string) => {
  const bid = await resolveBid(bidId, { participations: true });
  assertBuyerOwner(req.user!, bid);

  const isPublished = ['PUBLISHED', 'OPEN', 'OPEN_FOR_BIDDING'].includes(String(bid.status).toUpperCase());
  if (!isPublished) {
    const isDraft = ['DRAFT'].includes(String(bid.status).toUpperCase()) || editableApprovalStatuses.includes(String(bid.approvalStatus).toUpperCase());
    return {
      canEdit: isDraft,
      isPublished: false,
      reason: isDraft ? null : 'INVALID_STATUS',
      graceWindowExpiresAt: null,
      submittedQuotationsCount: 0,
      editCount: bid.postPublishEditCount || 0,
      maxEdits: 1,
      publishedAt: null
    };
  }

  const GRACE_WINDOW_MS = 6 * 60 * 60 * 1000;
  const publishTime = bid.publishedAt ? new Date(bid.publishedAt) : (bid.createdAt ? new Date(bid.createdAt) : null);
  const expiresAt = publishTime ? new Date(publishTime.getTime() + GRACE_WINDOW_MS) : null;
  const timeExpired = !publishTime || (Date.now() - publishTime.getTime() > GRACE_WINDOW_MS);
  const deadlinePassed = bid.endDate ? new Date() >= new Date(bid.endDate) : false;

  const submittedCount = await db.procurementBidParticipation.count({
    where: {
      bidId: bid.id,
      submissionStatus: { notIn: ['DRAFT', 'WITHDRAWN'] },
      isWithdrawn: { not: true }
    }
  });

  const editCount = bid.postPublishEditCount || 0;
  const editLimitReached = editCount >= 1;

  let canEdit = true;
  let reason: string | null = null;

  if (deadlinePassed) {
    canEdit = false;
    reason = 'DEADLINE_CLOSED';
  } else if (editLimitReached) {
    canEdit = false;
    reason = 'EDIT_LIMIT_REACHED';
  } else if (submittedCount > 0) {
    canEdit = false;
    reason = 'QUOTATIONS_ALREADY_SUBMITTED';
  } else if (timeExpired) {
    canEdit = false;
    reason = 'GRACE_WINDOW_EXPIRED';
  }

  return {
    canEdit,
    isPublished: true,
    reason,
    graceWindowExpiresAt: expiresAt ? expiresAt.toISOString() : null,
    submittedQuotationsCount: submittedCount,
    editCount,
    maxEdits: 1,
    publishedAt: publishTime ? publishTime.toISOString() : null
  };
};

export interface ExtendScheduleInput {
  closingDate: string;
  technicalOpeningDate?: string | null;
  financialOpeningDate?: string | null;
  requiredByDate?: string | null;
  bidValidityDate?: string | null;
  reason: string;
}

export const extendBidSchedule = async (
  req: AuthRequest,
  bidId: string,
  body: ExtendScheduleInput
) => {
  const bid = await resolveBid(bidId, {});
  assertBuyerOwner(req.user!, bid);

  const status = String(bid.status || '').toUpperCase();
  const terminalStatuses = [
    'AWARDED',
    'AWARD_ACCEPTED',
    'AWARD_OFFERED',
    'AWARD_RECOMMENDED',
    'PO_GENERATED',
    'IN_PROGRESS',
    'DELIVERED',
    'GRN_COMPLETED',
    'INVOICE_SUBMITTED',
    'PAYMENT_COMPLETED',
    'COMPLETED',
    'CANCELLED',
    'FINANCIAL_EVALUATION',
    'L1_GENERATED',
  ];
  if (terminalStatuses.includes(status)) {
    throw new ApiError(
      400,
      `Cannot extend schedule for a tender in stage ${status.toLowerCase()} because financial bids have already been opened or contract awarded. Please issue a fresh re-tender instead.`,
      'TENDER_POST_FINANCIAL_LOCKED'
    );
  }

  const newClosingDate = parseDateIST(body.closingDate);
  if (!newClosingDate || isNaN(newClosingDate.getTime())) {
    throw new ApiError(400, 'Invalid submission closing date provided.', 'INVALID_CLOSING_DATE');
  }

  const now = new Date();
  if (newClosingDate.getTime() <= now.getTime()) {
    throw new ApiError(400, 'New submission closing date must be in the future.', 'CLOSING_DATE_IN_PAST');
  }

  const packet = (bid.technicalPacket && typeof bid.technicalPacket === 'object')
    ? (bid.technicalPacket as any)
    : {};
  const sched = packet.schedule || {};
  const tndr = packet.tender || {};
  const rateContractConfig = packet.rateContractConfig || packet.rateContract || {};

  // For Rate Contracts, bid.endDate may have been assigned the 6-12 month contract periodEndDate,
  // whereas the true bid submission closing deadline is in sched.submissionDate / sched.submissionDeadline / tndr.bidClosingDate.
  const hasRateContractPeriodEnd = Boolean(
    rateContractConfig.periodEndDate &&
    bid.endDate &&
    new Date(bid.endDate).toISOString().slice(0, 10) === new Date(rateContractConfig.periodEndDate).toISOString().slice(0, 10)
  );

  const effectiveCurrentClosingDate = hasRateContractPeriodEnd
    ? (sched.submissionClosingDate || sched.submissionDate || sched.submissionDeadline || sched.submissionEndDate || sched.bidClosingDate || tndr.bidClosingDate || packet.submissionDeadline || packet.bidClosingDate || bid.endDate)
    : (sched.submissionClosingDate || sched.submissionDate || sched.submissionDeadline || sched.submissionEndDate || sched.bidClosingDate || tndr.bidClosingDate || packet.submissionDeadline || packet.bidClosingDate || bid.endDate);

  const oldEndDate = effectiveCurrentClosingDate ? parseDateIST(effectiveCurrentClosingDate) : (bid.endDate ? parseDateIST(bid.endDate) : null);
  const isPastDeadline = oldEndDate ? oldEndDate.getTime() <= now.getTime() : false;
  const isExpiredOrClosed = ['CLOSED', 'EXPIRED'].includes(status) || isPastDeadline;

  if (oldEndDate && !isExpiredOrClosed && newClosingDate.getTime() <= oldEndDate.getTime()) {
    throw new ApiError(400, 'New submission closing date must be later than the current deadline.', 'CLOSING_DATE_NOT_EXTENDED');
  }

  // Validate technical opening date if provided
  let newTechDate: Date | null = null;
  if (body.technicalOpeningDate) {
    newTechDate = parseDateIST(body.technicalOpeningDate);
    if (!newTechDate || isNaN(newTechDate.getTime())) {
      throw new ApiError(400, 'Invalid technical opening date provided.', 'INVALID_TECH_DATE');
    }
    if (newTechDate.getTime() < newClosingDate.getTime()) {
      throw new ApiError(400, 'Technical opening date cannot be earlier than the submission closing date.', 'INVALID_DATE_SEQUENCE');
    }
  } else if (bid.technicalOpeningDate || sched.technicalOpeningDate || tndr.technicalEvaluationDate) {
    const oldTech = parseDateIST(bid.technicalOpeningDate || sched.technicalOpeningDate || tndr.technicalEvaluationDate);
    if (oldTech && oldTech.getTime() < newClosingDate.getTime()) {
      newTechDate = newClosingDate;
    }
  }

  const isTwoPacketBid =
    bid.packetType === 'TWO_PACKET' ||
    String((bid.technicalPacket as any)?.schedule?.packetType || '').toUpperCase().includes('TWO') ||
    String((bid.technicalPacket as any)?.packetType || '').toUpperCase().includes('TWO') ||
    String(bid.procurementType || '').toUpperCase().includes('TWO_PACKET');

  // Validate financial opening date if provided (only applicable for two packet tenders)
  let newFinDate: Date | null = null;
  if (!isTwoPacketBid || body.financialOpeningDate === null) {
    newFinDate = null;
  } else if (body.financialOpeningDate) {
    newFinDate = parseDateIST(body.financialOpeningDate);
    if (!newFinDate || isNaN(newFinDate.getTime())) {
      throw new ApiError(400, 'Invalid financial opening date provided.', 'INVALID_FIN_DATE');
    }
    const minFin = newTechDate || newClosingDate;
    if (newFinDate.getTime() < minFin.getTime()) {
      throw new ApiError(400, 'Financial opening date cannot be earlier than the technical opening / closing date.', 'INVALID_DATE_SEQUENCE');
    }
  } else if (bid.financialOpeningDate || sched.financialOpeningDate || tndr.financialEvaluationDate) {
    const oldFin = parseDateIST(bid.financialOpeningDate || sched.financialOpeningDate || tndr.financialEvaluationDate);
    const minFin = newTechDate || newClosingDate;
    if (oldFin && oldFin.getTime() < minFin.getTime()) {
      newFinDate = minFin;
    } else {
      newFinDate = oldFin;
    }
  }

  // Validate requiredByDate / delivery date if provided
  let newRequiredByDate: Date | null = null;
  if (body.requiredByDate) {
    newRequiredByDate = parseDateIST(body.requiredByDate, true);
    if (!newRequiredByDate || isNaN(newRequiredByDate.getTime())) {
      throw new ApiError(400, 'Invalid delivery / required-by date provided.', 'INVALID_DELIVERY_DATE');
    }
    if (newRequiredByDate.getTime() < newClosingDate.getTime()) {
      throw new ApiError(400, 'Required-by delivery date cannot be earlier than the submission closing date.', 'INVALID_DATE_SEQUENCE');
    }
  }

  // Validate bid validity date
  let newValidityDate: Date | null = null;
  if (body.bidValidityDate) {
    newValidityDate = parseDateIST(body.bidValidityDate, true);
    if (!newValidityDate || isNaN(newValidityDate.getTime())) {
      throw new ApiError(400, 'Invalid bid validity date provided.', 'INVALID_VALIDITY_DATE');
    }
    if (newValidityDate.getTime() < newClosingDate.getTime()) {
      throw new ApiError(400, 'Bid validity date cannot be earlier than the submission closing date.', 'INVALID_DATE_SEQUENCE');
    }
  }

  // Sync technicalPacket JSON payload if present
  let updatedTechnicalPacket = (bid.technicalPacket && typeof bid.technicalPacket === 'object')
    ? { ...(bid.technicalPacket as any) }
    : {};

  const currentCount = Number(updatedTechnicalPacket.corrigendumCount || 0);
  const schedule = updatedTechnicalPacket.schedule || {};
  const tndrObj = updatedTechnicalPacket.tender || {};
  const basics = updatedTechnicalPacket.basics || {};

  updatedTechnicalPacket = {
    ...updatedTechnicalPacket,
    corrigendumCount: currentCount + 1,
    submissionDeadline: newClosingDate.toISOString(),
    bidClosingDate: newClosingDate.toISOString(),
    schedule: {
      ...schedule,
      // Sync ALL deadline key variants so firstPresent() and downstream parsers never read stale values
      submissionClosingDate: newClosingDate.toISOString(),
      submissionDate: newClosingDate.toISOString(),
      submissionDeadline: newClosingDate.toISOString(),
      submissionEndDate: newClosingDate.toISOString(),
      bidClosingDate: newClosingDate.toISOString(),
      ...(newTechDate ? { technicalOpeningDate: newTechDate.toISOString() } : {}),
      financialOpeningDate: newFinDate ? newFinDate.toISOString() : null,
      ...(newValidityDate ? { bidValidityDate: newValidityDate.toISOString() } : {}),
    },
    tender: {
      ...tndrObj,
      bidClosingDate: newClosingDate.toISOString(),
      ...(newTechDate ? { technicalEvaluationDate: newTechDate.toISOString() } : {}),
      ...(newFinDate ? { financialEvaluationDate: newFinDate.toISOString() } : {}),
    },
    basics: {
      ...basics,
      ...(newRequiredByDate ? { requiredByDate: newRequiredByDate.toISOString() } : {}),
    }
  };

  const shouldReactivate = ['CLOSED', 'EXPIRED', 'UNDER_EVALUATION', 'TECHNICAL_EVALUATION', 'OPEN_FOR_BIDDING', 'PUBLISHED'].includes(status);

  const updated = await db.procurementBid.update({
    where: { id: bid.id },
    data: {
      endDate: newClosingDate,
      ...(shouldReactivate ? { status: 'OPEN', lifecycleStage: 'SELLER_PARTICIPATION' } : {}),
      ...(newTechDate ? { technicalOpeningDate: newTechDate } : {}),
      financialOpeningDate: newFinDate,
      ...(newValidityDate ? { bidValidityDate: newValidityDate } : {}),
      technicalPacket: updatedTechnicalPacket
    }
  });

  const changeSummary = {
    corrigendumCount: updatedTechnicalPacket.corrigendumCount,
    oldDates: {
      endDate: bid.endDate,
      technicalOpeningDate: bid.technicalOpeningDate,
      financialOpeningDate: bid.financialOpeningDate,
      bidValidityDate: bid.bidValidityDate
    },
    newDates: {
      endDate: newClosingDate,
      technicalOpeningDate: newTechDate || bid.technicalOpeningDate,
      financialOpeningDate: newFinDate || bid.financialOpeningDate,
      bidValidityDate: newValidityDate || bid.bidValidityDate,
      requiredByDate: newRequiredByDate
    },
    reason: body.reason,
    extendedByUserId: req.user!.id
  };

  await procurementAudit(req, 'BID_SCHEDULE_EXTENDED', 'ProcurementBid', bid.id, changeSummary, bid);

  const corrigendumNumber = updatedTechnicalPacket?.corrigendumCount || 1;
  const tenderRef = bid.bidNumber || bid.requirementNumber || `PRC-${bid.id}`;
  const noticeRef = `JSG-CORR/${new Date().getFullYear()}/${bid.id}/${String(corrigendumNumber).padStart(2, '0')}`;
  const originalDeadlineStr = bid.endDate ? formatIstDateTime(bid.endDate) : 'Not specified';
  const revisedDeadlineStr = formatIstDateTime(newClosingDate);
  const reasonStr = body.reason || 'Administrative Extension of Bidding Timelines';
  const portalUrl = getPublicPortalUrl();
  const redirectPath = `/seller/procurement/events/${bid.id}`;
  const actionUrl = ensurePublicUrl(redirectPath);

  // 1. Instant Real-Time WebSocket Broadcasts to open portal clients (~10ms)
  const corrigendumEvent = {
    type: 'CORRIGENDUM_ISSUED' as const,
    procurementId: bid.id,
    requirementId: bid.requirementNumber || bid.bidNumber || bid.id,
    bidId: bid.id,
    bidNumber: tenderRef,
    corrigendumNumber,
    newDeadline: newClosingDate.toISOString(),
    revisedDeadlineStr,
    originalDeadlineStr,
    reason: reasonStr,
    status: updated.status,
    timestamp: new Date().toISOString()
  };

  try {
    broadcastToProcurement(bid.id, corrigendumEvent);
    if (bid.bidNumber && String(bid.bidNumber) !== String(bid.id)) {
      broadcastToProcurement(bid.bidNumber, corrigendumEvent);
    }
    if (bid.requirementNumber && String(bid.requirementNumber) !== String(bid.id)) {
      broadcastToProcurement(bid.requirementNumber, corrigendumEvent);
    }
    broadcastToProcurement('all', corrigendumEvent);

    const updateEvent = {
      type: 'PROCUREMENT_UPDATED' as const,
      procurementId: bid.id,
      requirementId: bid.requirementNumber || bid.id,
      status: updated.status,
      timestamp: new Date().toISOString()
    };
    broadcastToProcurement(bid.id, updateEvent);
    broadcastToProcurement('all', updateEvent);
  } catch (bcErr) {
    logger.warn({ bcErr, bidId: bid.id }, 'Failed to broadcast corrigendum event');
  }

  // 2. Asynchronous Background Seller Notifications (Non-blocking: buyer response returns in <200ms)
  setImmediate(async () => {
    try {
      const notifiedSellerIds = new Set<number>();
      const participations = await db.procurementBidParticipation.findMany({
        where: { bidId: bid.id },
        select: { sellerId: true }
      });
      for (const p of participations) {
        if (p.sellerId) notifiedSellerIds.add(p.sellerId);
      }

      const isLimited = (bid as any).visibility === 'LIMITED' || (bid as any).visibility === 'INVITED_SELLERS_ONLY';
      if (isLimited) {
        const technicalPacket = (bid.technicalPacket && typeof bid.technicalPacket === 'object') ? (bid.technicalPacket as any) : {};
        const invitedOrgIds: number[] = (bid as any).invitedSellerOrgIds || technicalPacket.invitedSellerOrgIds || technicalPacket.rules?.invitedSellerOrgIds || [];
        const invitedUserIds: number[] = (bid as any).invitedUserIds || technicalPacket.invitedUserIds || [];
        if (invitedOrgIds.length > 0 || invitedUserIds.length > 0) {
          const invitedUsers = await db.user.findMany({
            where: {
              role: { in: ['seller', 'shg'] as any },
              accountStatus: { not: 'BLOCKED' as any },
              OR: [
                ...(invitedOrgIds.length ? [{ organizationId: { in: invitedOrgIds } }] : []),
                ...(invitedUserIds.length ? [{ id: { in: invitedUserIds } }] : [])
              ]
            },
            select: { id: true }
          });
          for (const u of invitedUsers) {
            notifiedSellerIds.add(u.id);
          }
        }
      } else {
        const allActiveSellers = await db.user.findMany({
          where: {
            role: { in: ['seller', 'shg'] as any },
            accountStatus: { not: 'BLOCKED' as any }
          },
          select: { id: true }
        });
        for (const u of allActiveSellers) {
          notifiedSellerIds.add(u.id);
        }
      }

      const detailsTable: TableRow[] = [
        { label: 'Tender / RFQ Reference', value: tenderRef, isCode: true },
        { label: 'Tender Title', value: bid.title, isHighlight: true },
        { label: 'Notice Serial', value: `Corrigendum Notice #${corrigendumNumber}`, isHighlight: true },
        { label: 'Original Submission Deadline', value: originalDeadlineStr },
        { label: 'Revised Submission Deadline', value: revisedDeadlineStr, color: '#166534', isHighlight: true },
        ...(newTechDate || bid.technicalOpeningDate ? [{
          label: 'Technical Bid Opening',
          value: formatIstDateTime(newTechDate || bid.technicalOpeningDate)
        }] : []),
        ...(newFinDate || bid.financialOpeningDate ? [{
          label: 'Financial Bid Opening',
          value: formatIstDateTime(newFinDate || bid.financialOpeningDate)
        }] : []),
        { label: 'Corrigendum Justification', value: reasonStr },
        { label: 'Submission Protocol', value: 'Existing Submissions Remain Valid • Revisions Allowed', color: '#1e40af', isHighlight: true },
        { label: 'Official Portal Gateway', value: `<a href="${portalUrl}" style="color: #1e40af; text-decoration: underline; font-weight: 700;">${portalUrl}</a>` }
      ];

      const emailHtml = buildGovernmentGradeEmailHtml({
        portalName: 'JSG SMILE Procurement Portal',
        departmentName: 'Government of Odisha • District Administration Jharsuguda',
        noticeType: 'OFFICIAL CORRIGENDUM • DEADLINE EXTENDED',
        noticeRef,
        badgeVariant: 'warning',
        heading: `Corrigendum #${corrigendumNumber}: Submission Deadline Extended`,
        summary: `Official Corrigendum Notice for Tender "${bid.title}" (${tenderRef}). The submission closing timeline has been extended to ${revisedDeadlineStr}. All previously submitted commercial & technical quotations remain securely sealed and valid. Participating bidders may review or revise their submissions prior to the revised closing timestamp.`,
        detailsTable,
        stepInstructions: {
          title: 'Action for Participating Bidders',
          steps: [
            'If you have already submitted your bid: Your quotation remains securely recorded and sealed. You may review or revise it at any time before the new deadline.',
            `If you have not yet submitted: Complete your technical and financial submission through the official portal before ${revisedDeadlineStr}.`,
            'Ensure all required statutory compliance documents and schedule sheets are attached.'
          ]
        },
        actionButton: {
          label: 'View Tender & Manage Submission →',
          url: actionUrl
        },
        securityAdvisory: 'Statutory Notice: All procurement submissions on JSG SMILE are encrypted and sealed under Government of Odisha procurement rules. Official nodal authorities will never ask for your authentication PIN or OTP.'
      });

      const sellerIdList = Array.from(notifiedSellerIds);
      const batchSize = 5;
      for (let i = 0; i < sellerIdList.length; i += batchSize) {
        const batch = sellerIdList.slice(i, i + batchSize);
        await Promise.allSettled(
          batch.map(async (sellerId) => {
            try {
              await notificationService.notifyUser(sellerId, {
                title: `Submission Deadline Extended (Corrigendum #${corrigendumNumber})`,
                message: `The submission deadline for "${bid.title}" (${tenderRef}) has been extended from ${originalDeadlineStr} to ${revisedDeadlineStr}. Reason: ${reasonStr}`,
                type: 'tender.deadline_extended',
                priority: 'high',
                redirectUrl: redirectPath,
                emailSubject: `[Corrigendum #${corrigendumNumber}] Submission Deadline Extended: ${bid.title} (${tenderRef})`,
                emailHtml,
                detailsTable,
                noticeRef
              }, ['in_app', 'email']);

              broadcastToUser(sellerId, {
                type: 'BID_STATUS_CHANGED',
                procurementId: bid.id,
                requirementId: bid.requirementNumber || bid.id,
                status: 'CORRIGENDUM_ISSUED',
                title: `Submission Deadline Extended (Corrigendum #${corrigendumNumber})`,
                message: `The submission deadline for "${bid.title}" has been extended to ${revisedDeadlineStr}.`,
                timestamp: new Date().toISOString()
              });
            } catch (err) {
              logger.warn({ err, sellerId }, 'Failed to send deadline extension notification to seller');
            }
          })
        );
      }
    } catch (bgErr) {
      logger.warn({ bgErr, bidId: bid.id }, 'Background seller notification task encountered an error');
    }
  });

  return updated;
};

export const uploadBuyerBidDocument = async (req: AuthRequest & { file?: Express.Multer.File }, bidId: string, body: any) => {
  const bid = await resolveBid(bidId, {});
  assertBuyerOwner(req.user!, bid);
  if (!editableBidStatuses.includes(bid.status) && !editableApprovalStatuses.includes(bid.approvalStatus)) {
    throw new ApiError(400, 'Documents can be uploaded only while the bid is draft or pending approval.', 'INVALID_STATUS_TRANSITION');
  }
  if (!req.file) throw new ApiError(400, 'File is required', 'FILE_REQUIRED');

  const asset = await uploadFile(req.file, {
    ownerId: req.user!.id,
    ownerRole: req.user!.role,
    entityType: 'procurement_bid',
    entityId: bid.id,
    purpose: String(body.documentType || 'BID_DOCUMENT'),
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  }, env.STORAGE_PROVIDER);

  const doc = await db.procurementBidDocument.create({
    data: {
      bidId: bid.id,
      documentType: String(body.documentType || 'BID_DOCUMENT'),
      fileAssetId: asset.id,
      fileName: asset.originalName,
      fileUrl: asset.url,
      fileKey: asset.key,
      mimeType: asset.mimeType,
      fileSize: asset.size,
      uploadedById: req.user!.id,
      visibility: body.visibility || 'PUBLIC'
    }
  });

  await procurementAudit(req, 'BID_DOCUMENT_UPLOADED', 'ProcurementBidDocument', doc.id, doc);
  return doc;
};

export const isAdminBidApprovalRequired = async () => {
  const feature = await db.platformFeature.findFirst({
    where: {
      feature: { code: 'admin-bid-approval' }
    }
  });
  if (feature && feature.enabled === false) {
    return false;
  }
  return true;
};

export const submitForApproval = async (req: AuthRequest, bidId: string) => {
  const bid = await resolveBid(bidId, {});
  assertBuyerOwner(req.user!, bid);
  await assertBuyerVerified(req.user!);
  if (!editableBidStatuses.includes(bid.status) && !editableApprovalStatuses.includes(bid.approvalStatus)) {
    throw new ApiError(400, 'Only draft or rejected bids can be submitted for approval.', 'INVALID_STATUS_TRANSITION');
  }

  const isApprovalRequired = await isAdminBidApprovalRequired();
  if (!isApprovalRequired) {
    const openNow = new Date(bid.startDate) <= now() && new Date(bid.endDate) > now();
    assertBidTransition(bid.status, openNow ? 'OPEN' : 'APPROVED');
    const updated = await db.procurementBid.update({
      where: { id: bid.id },
      data: {
        approvalStatus: 'APPROVED',
        status: openNow ? 'OPEN' : 'APPROVED',
        lifecycleStage: openNow ? 'SELLER_PARTICIPATION' : 'BID_PUBLISHED',
        approvedById: req.user!.id,
        approvedAt: now(),
        publishedAt: openNow ? (bid.publishedAt || now()) : null,
        rejectedReason: null
      }
    });
    await procurementAudit(req, 'BID_APPROVED', 'ProcurementBid', bid.id, updated, bid);
    if (openNow) await procurementAudit(req, 'BID_PUBLISHED', 'ProcurementBid', bid.id, { status: 'OPEN' }, bid);
    if (openNow) {
      try {
        await notificationService.notifyUser(req.user!.id, {
          title: 'Bid Published',
          message: `Your procurement "${bid.title}" is now open for submissions.`,
          type: 'bid.published',
          redirectUrl: `/buyer/procurement/events/${bid.id}`
        }, ['in_app', 'email']);
        const tp = (bid.technicalPacket || {}) as any;
        const vendorsSelection = String(tp.vendors?.selection || tp.vendors?.selectionMode || '').trim();
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
          invitedSellerOrgIds: extractInvitedSellerIds(bid.technicalPacket)
        });
      } catch (err) {
        logger.warn({ err }, 'Failed to send publish notification');
      }
    }
    return updated;
  }

  assertBidTransition(bid.status, 'PENDING_ADMIN_APPROVAL');
  const updated = await db.procurementBid.update({
    where: { id: bid.id },
    data: { status: 'PENDING_ADMIN_APPROVAL', approvalStatus: 'PENDING' }
  });
  await procurementAudit(req, 'BID_SUBMITTED_FOR_APPROVAL', 'ProcurementBid', bid.id, updated, bid);
  try {
    const admins = await db.user.findMany({ where: { role: 'admin' }, select: { id: true } });
    for (const admin of admins) {
      await notificationService.notifyUser(admin.id, {
        title: 'Bid Pending Approval',
        message: `Procurement "${bid.title}" submitted for admin approval.`,
        type: 'bid.pending_approval',
        redirectUrl: `/admin/bids/${bid.id}`
      }, ['in_app', 'email']);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to send admin approval notification');
  }
  return updated;
};


export const approveBid = async (req: AuthRequest, bidId: string) => {
  const bid = await resolveBid(bidId, {});
  if (!['PENDING', 'REJECTED'].includes(bid.approvalStatus)) throw new ApiError(400, 'Only pending bids can be approved.', 'INVALID_STATUS_TRANSITION');
  const openNow = new Date(bid.startDate) <= now() && new Date(bid.endDate) > now();
  assertBidTransition(bid.status, openNow ? 'OPEN' : 'APPROVED');
  const updated = await db.procurementBid.update({
    where: { id: bid.id },
    data: {
      approvalStatus: 'APPROVED',
      status: openNow ? 'OPEN' : 'APPROVED',
      lifecycleStage: openNow ? 'SELLER_PARTICIPATION' : 'BID_PUBLISHED',
      approvedById: req.user!.id,
      approvedAt: now(),
      publishedAt: openNow ? (bid.publishedAt || now()) : null,
      rejectedReason: null
    }
  });
  await procurementAudit(req, 'BID_APPROVED', 'ProcurementBid', bid.id, updated, bid);
  if (openNow) await procurementAudit(req, 'BID_PUBLISHED', 'ProcurementBid', bid.id, { status: 'OPEN' }, bid);
  try {
    if (openNow) {
      const invitations = await db.procurementBidInvitation.findMany({ where: { bidId: bid.id }, include: { bid: true } });
      for (const inv of invitations) {
        const targetId = inv.sellerUserId ?? inv.sellerOrgId;
        if (targetId) {
          await notificationService.notifyUser(targetId, {
            title: 'New Bidding Opportunity',
            message: `You have been invited to bid on "${bid.title}".`,
            type: 'bid.invitation',
            redirectUrl: `/seller/procurement/events/${bid.id}`
          }, ['in_app', 'email']);
        }
      }
      const tp = (bid.technicalPacket || {}) as any;
      const vendorsSelection = String(tp.vendors?.selection || tp.vendors?.selectionMode || '').trim();
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
        invitedSellerOrgIds: extractInvitedSellerIds(bid.technicalPacket)
      });
    }
    await notificationService.notifyUser(bid.buyerId, {
      title: openNow ? 'Bid Published' : 'Bid Approved',
      message: `Your procurement "${bid.title}" has been ${openNow ? 'published and is open for submissions' : 'approved by admin'}.`,
      type: 'bid.approved',
      redirectUrl: `/buyer/procurement/events/${bid.id}`
    }, ['in_app', 'email']);
  } catch (err) {
    logger.warn({ err }, 'Failed to send approval notification');
  }
  return updated;
};

export const rejectBid = async (req: AuthRequest, bidId: string, reason: string) => {
  const bid = await resolveBid(bidId, {});
  if (bid.status !== 'PENDING_ADMIN_APPROVAL') throw new ApiError(400, 'Only bids pending admin approval can be rejected.', 'INVALID_STATUS_TRANSITION');
  assertBidTransition(bid.status, 'DRAFT');
  const updated = await db.procurementBid.update({
    where: { id: bid.id },
    data: { approvalStatus: 'REJECTED', status: 'DRAFT', rejectedReason: reason, approvedById: req.user!.id, approvedAt: now() }
  });
  await procurementAudit(req, 'BID_REJECTED', 'ProcurementBid', bid.id, updated, bid);
  try {
    await notificationService.notifyUser(bid.buyerId, {
      title: 'Bid Rejected',
      message: `Your procurement "${bid.title}" was rejected by admin. Reason: ${reason}`,
      type: 'bid.rejected',
      redirectUrl: `/buyer/procurement/events/${bid.id}`
    }, ['in_app', 'email']);
  } catch (err) {
    logger.warn({ err }, 'Failed to send rejection notification');
  }
  return updated;
};

export const startParticipation = async (req: AuthRequest, bidId: string) => {
  await assertSellerVerified(req.user!);
  const bid = await resolveBid(bidId, {});
  assertBidOpen(bid);
  if (isRestrictedBidMethod(bid) && !isActorInvitedToBid(req.user!, bid)) {
    throw new ApiError(404, 'Bid not found', 'BID_NOT_FOUND');
  }

  const whereClause: any = { bidId: bid.id };
  if (req.user!.organizationId) {
    whereClause.OR = [
      { sellerId: req.user!.id },
      { seller: { organizationId: req.user!.organizationId } }
    ];
  } else {
    whereClause.sellerId = req.user!.id;
  }

  const existingParticipation = await db.procurementBidParticipation.findFirst({
    where: whereClause
  });
  if (existingParticipation) {
    throw new ApiError(409, 'You or your organization have already participated in this bid.', 'DUPLICATE_PARTICIPATION');
  }

  try {
    const participation = await db.procurementBidParticipation.create({
      data: {
        bidId: bid.id,
        sellerId: req.user!.id,
        participationNumber: await nextParticipationNumber(bid.bidNumber),
        financialStatus: 'LOCKED'
      }
    });
    await procurementAudit(req, 'BID_PARTICIPATED', 'ProcurementBidParticipation', participation.id, participation);
    try {
      const seller = await db.user.findUnique({ where: { id: req.user!.id }, select: { name: true } });
      await notificationService.notifyUser(bid.buyerId, {
        title: 'New Bid Participation',
        message: `Seller "${seller?.name || 'Unknown'}" started participating in "${bid.title}".`,
        type: 'bid.participation',
        redirectUrl: `/buyer/procurement/events/${bid.id}`
      }, ['in_app']);
    } catch (err) {
      logger.warn({ err }, 'Failed to send participation notification');
    }
    return participation;
  } catch (error: any) {
    if (error?.code === 'P2002') throw new ApiError(409, 'You have already participated in this bid.', 'DUPLICATE_PARTICIPATION');
    throw error;
  }
};

export const assertOwnParticipation = async (req: AuthRequest, bidId: string, participationId: number) => {
  const bid = await resolveBid(bidId, {});
  let participation = await db.procurementBidParticipation.findUnique({
    where: { id: participationId },
    include: { bid: true, documents: true, clarifications: { include: { files: true } }, evaluations: true, awards: true }
  });
  if (participation && participation.bidId !== bid.id) {
    const partBid = await db.procurementBid.findUnique({ where: { id: participation.bidId } });
    if (!partBid || (partBid.id !== bid.id && partBid.bidNumber !== bid.bidNumber && (!bid.sourceId || partBid.sourceId !== bid.sourceId))) {
      participation = null;
    }
  }
  if (!participation) {
    participation = await db.procurementBidParticipation.findFirst({
      where: { bidId: bid.id, OR: [{ id: participationId }, { sellerId: participationId }] },
      include: { bid: true, documents: true, clarifications: { include: { files: true } }, evaluations: true, awards: true }
    });
  }
  if (!participation) throw new ApiError(404, 'Participation not found', 'PARTICIPATION_NOT_FOUND');
  if (req.user!.role !== 'admin' && req.user!.role !== 'master_admin' && participation.sellerId !== req.user!.id && bid.buyerId !== req.user!.id) {
    throw new ApiError(403, 'You cannot access this participation.', 'FORBIDDEN_ROLE');
  }
  return { bid, participation };
};

export const uploadParticipationDocument = async (req: AuthRequest & { file?: Express.Multer.File }, bidId: string, participationId: number, category: string) => {
  const { bid, participation } = await assertOwnParticipation(req, bidId, participationId);
  if (participation.sellerId !== req.user!.id) throw new ApiError(403, 'Only the owner seller can upload documents.', 'FORBIDDEN_ROLE');
  if (participation.submissionStatus === 'SUBMITTED') throw new ApiError(400, 'Participation has already been submitted.', 'PARTICIPATION_ALREADY_SUBMITTED');
  assertBidOpen(bid);
  if (!req.file) throw new ApiError(400, 'File is required', 'FILE_REQUIRED');
  const fileEntityType = category === 'FINANCIAL_QUOTE' ? 'procurement_financial_quote' : 'procurement_bid_participation';
  const asset = await uploadFile(req.file, {
    ownerId: req.user!.id,
    ownerRole: req.user!.role,
    entityType: fileEntityType,
    entityId: participation.id,
    purpose: category,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  }, env.STORAGE_PROVIDER);

  const doc = await db.procurementBidParticipationDocument.create({
    data: {
      participationId: participation.id,
      bidId: bid.id,
      sellerId: req.user!.id,
      documentCategory: category,
      documentName: String(req.body.documentName || category),
      fileAssetId: asset.id,
      fileName: asset.originalName,
      fileUrl: asset.url,
      fileKey: asset.key,
      mimeType: asset.mimeType,
      fileSize: asset.size
    }
  });

  if (category !== 'FINANCIAL_QUOTE') {
    await db.procurementBidParticipation.update({
      where: { id: participation.id },
      data: { submissionStatus: 'TECHNICAL_DOCUMENTS_UPLOADED' }
    });
  }
  await procurementAudit(req, category === 'FINANCIAL_QUOTE' ? 'FINANCIAL_DOC_UPLOADED' : 'TECHNICAL_DOC_UPLOADED', 'ProcurementBidParticipationDocument', doc.id, doc);
  return doc;
};

export const saveFinancialQuote = async (req: AuthRequest & { file?: Express.Multer.File }, bidId: string, participationId: number, body: any) => {
  const { bid, participation } = await assertOwnParticipation(req, bidId, participationId);
  if (participation.sellerId !== req.user!.id) throw new ApiError(403, 'Only the owner seller can upload financial quote.', 'FORBIDDEN_ROLE');
  if (participation.submissionStatus === 'SUBMITTED') throw new ApiError(400, 'Participation has already been submitted.', 'PARTICIPATION_ALREADY_SUBMITTED');
  assertBidOpen(bid);
  let doc = null;
  if (req.file) {
    doc = await uploadParticipationDocument(req, bidId, participationId, 'FINANCIAL_QUOTE');
  }
  const quoted = Number(body.quotedAmount);
  const gst = Number(body.gstPercentage || 0);
  const total = Number(body.totalAmount || quoted + (quoted * gst / 100));

  let lineItemsObj = undefined;
  if (body.lineItems) {
    try {
      lineItemsObj = typeof body.lineItems === 'string' ? JSON.parse(body.lineItems) : body.lineItems;
    } catch(e) {}
  }

  let responseDataObj = undefined;
  if (body.responseData) {
    try {
      responseDataObj = typeof body.responseData === 'string' ? JSON.parse(body.responseData) : body.responseData;
    } catch(e) {}
  }
  const existingAck = (participation.acknowledgement as Record<string, any>) || {};
  const ackData = {
    ...existingAck,
    ...(responseDataObj || {}),
    ...(lineItemsObj ? { lineItems: lineItemsObj } : {}),
    ...(body.deliveryTimeline ? { deliveryTimeline: body.deliveryTimeline } : {}),
    ...(body.terms ? { terms: body.terms } : {}),
    ...(body.paymentTerms ? { paymentTerms: body.paymentTerms } : {}),
    ...(body.offeredQuantity ? { offeredQuantity: body.offeredQuantity } : {})
  };

  const updated = await db.procurementBidParticipation.update({
    where: { id: participation.id },
    data: {
      quotedAmount: quoted,
      gstPercentage: gst,
      totalAmount: total,
      makeBrand: body.makeBrand,
      model: body.model,
      offeredItemDescription: body.offeredItemDescription,
      acknowledgement: ackData,
      financialStatus: 'NOT_OPENED',
      submissionStatus: 'FINANCIAL_QUOTE_UPLOADED',
      financialSubmittedAt: now()
    }
  });
  await procurementAudit(req, 'FINANCIAL_DOC_UPLOADED', 'ProcurementBidParticipation', updated.id, { ...updated, quotedAmount: 'MASKED' });
  return { participation: serializeParticipation(updated), document: doc };
};

export const finalSubmitParticipation = async (req: AuthRequest, bidId: string, participationId: number, body: any = {}) => {
  const { bid, participation } = await assertOwnParticipation(req, bidId, participationId);
  if (participation.sellerId !== req.user!.id) throw new ApiError(403, 'Only the owner seller can submit.', 'FORBIDDEN_ROLE');
  if (participation.submissionStatus === 'SUBMITTED') throw new ApiError(400, 'Participation has already been submitted.', 'PARTICIPATION_ALREADY_SUBMITTED');
  assertBidOpen(bid);
  const docs = participation.documents || [];
  if (!docs.some((doc: any) => doc.documentCategory !== 'FINANCIAL_QUOTE')) {
    throw new ApiError(400, 'Please upload technical documents before final submission.', 'REQUIRED_DOCUMENT_MISSING');
  }
  if (!participation.quotedAmount || !docs.some((doc: any) => doc.documentCategory === 'FINANCIAL_QUOTE')) {
    throw new ApiError(400, 'Please upload financial quote before final submission.', 'REQUIRED_DOCUMENT_MISSING');
  }
  // Enforce the buyer-defined required-document checklist: the seller must map an
  // uploaded file to every named document the buyer listed at publish time.
  const requiredDocs: string[] = Array.isArray(bid.requiredDocuments) ? bid.requiredDocuments.filter(Boolean) : [];
  if (requiredDocs.length) {
    const uploadedNames = new Set(
      docs.map((doc: any) => String(doc.documentName || '').trim().toLowerCase()).filter(Boolean)
    );
    const missing = requiredDocs.filter(name => !uploadedNames.has(String(name).trim().toLowerCase()));
    if (missing.length) {
      throw new ApiError(
        400,
        `Missing required documents: ${missing.join(', ')}. Upload each listed document before final submission.`,
        'REQUIRED_DOCUMENT_MISSING',
        { missingDocuments: missing }
      );
    }
  }
  // Enforce acknowledgement of buyer terms & eligibility criteria when the buyer published any.
  const hasConditions = (bid.termsAndConditions || []).length > 0 || (bid.eligibilityCriteria || []).length > 0;
  if (hasConditions && body.acceptedTerms !== true) {
    throw new ApiError(400, 'You must accept the buyer terms & conditions and confirm eligibility before submitting.', 'TERMS_NOT_ACCEPTED');
  }
  // Preserve any existing technical offer data already stored in acknowledgement.
  // The seller saved their technical offer (makeBrand, model, complianceRemarks,
  // deliveryTimeline, warrantyDetails, serviceSupport, deviation, etc.) into
  // acknowledgement during financial-quote upload. We must NOT wipe it out here —
  // instead we merge the ACK receipt fields on top so the buyer can still see them.
  const existingAck = (participation.acknowledgement && typeof participation.acknowledgement === 'object')
    ? (participation.acknowledgement as Record<string, any>)
    : {};
  const ack = {
    ...existingAck,
    acknowledgementId: `ACK-BP-${participation.id}-${Date.now()}`,
    responseId: participation.participationNumber,
    timestamp: new Date().toISOString(),
    message: 'Participation submitted successfully.',
    acceptedTerms: body.acceptedTerms === true,
    acceptedTermsAt: body.acceptedTerms === true ? new Date().toISOString() : undefined
  };
  const updated = await db.procurementBidParticipation.update({
    where: { id: participation.id },
    data: {
      submissionStatus: 'SUBMITTED',
      technicalStatus: 'UNDER_REVIEW',
      submittedAt: now(),
      technicalSubmittedAt: now(),
      acknowledgement: ack
    }
  });
  await procurementAudit(req, 'PARTICIPATION_SUBMITTED', 'ProcurementBidParticipation', updated.id, updated);
  try {
    const seller = await db.user.findUnique({ where: { id: req.user!.id }, select: { name: true } });
    await notificationService.notifyUser(bid.buyerId, {
      title: 'Bid Submitted',
      message: `Seller "${seller?.name || 'Unknown'}" submitted their bid for "${bid.title}".`,
      type: 'bid.submitted',
      redirectUrl: `/buyer/procurement/events/${bid.id}`
    }, ['in_app', 'email']);
  } catch (err) {
    logger.warn({ err }, 'Failed to send bid submission notification');
  }

  try {
    const targetIds = [bid.id, bid.bidNumber, bid.sourceId, (bid.technicalPacket as any)?.sourceRequirementId].filter(Boolean);
    targetIds.forEach((tid: any) => {
      broadcastToProcurement(tid, {
        type: 'QUOTATION_SUBMITTED',
        requirementId: bid.sourceId || bid.id,
        procurementId: bid.id,
        responseId: updated.id,
        offeredPrice: updated.totalAmount ? Number(updated.totalAmount) : undefined,
        sellerOrgId: (req.user as any)?.organizationId || null,
        timestamp: new Date().toISOString()
      });
      broadcastToProcurement(tid, {
        type: 'PROCUREMENT_UPDATED',
        requirementId: bid.sourceId || bid.id,
        procurementId: bid.id,
        status: String(bid.status),
        timestamp: new Date().toISOString()
      });
    });
    if (bid.buyerId) {
      broadcastToUser(bid.buyerId, {
        type: 'BID_STATUS_CHANGED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        status: 'QUOTATION_SUBMITTED',
        timestamp: new Date().toISOString()
      });
    }
  } catch (bcErr) {
    logger.warn({ bcErr }, '[finalSubmitParticipation] Realtime broadcast error');
  }

  const saved = await db.procurementBidParticipation.findUnique({
    where: { id: updated.id },
    include: { documents: true, clarifications: { include: { files: true } }, evaluations: true, awards: true }
  });
  return serializeParticipation(saved || updated, { canSeeFinancial: true, bid, ownView: true });
};

export const askClarification = async (req: AuthRequest, bidId: string, body: any) => {
  const bid = await resolveBid(bidId, {});
  assertBuyerOwner(req.user!, bid);
  if (!technicalEvaluationStatuses.includes(bid.status)) throw new ApiError(400, 'Clarifications are allowed only during technical evaluation.', 'INVALID_STATUS_TRANSITION');
  const participation = await db.procurementBidParticipation.findUnique({ where: { id: Number(body.participationId) } });
  if (!participation || participation.bidId !== bid.id) throw new ApiError(404, 'Participation not found', 'PARTICIPATION_NOT_FOUND');
  const clarification = await db.procurementBidClarification.create({
    data: {
      bidId: bid.id,
      participationId: participation.id,
      sellerId: participation.sellerId,
      buyerId: bid.buyerId,
      requestNumber: await nextClarificationNumber(bid.bidNumber),
      clarificationType: body.clarificationType,
      question: body.question,
      requestedById: req.user!.id,
      dueDate: body.dueDate
    }
  });
  await db.procurementBidParticipation.update({ where: { id: participation.id }, data: { technicalStatus: 'CLARIFICATION_REQUIRED' } });
  await procurementAudit(req, 'CLARIFICATION_REQUESTED', 'ProcurementBidClarification', clarification.id, clarification);
  return clarification;
};

export const respondClarification = async (req: AuthRequest & { file?: Express.Multer.File }, bidId: string, clarificationId: number, response: string) => {
  const bid = await resolveBid(bidId, {});
  const clarification = await db.procurementBidClarification.findUnique({ where: { id: clarificationId }, include: { files: true } });
  if (!clarification || clarification.bidId !== bid.id) throw new ApiError(404, 'Clarification not found', 'CLARIFICATION_NOT_FOUND');
  if (clarification.sellerId !== req.user!.id) throw new ApiError(403, 'Only the owner seller can respond.', 'FORBIDDEN_ROLE');
  const updated = await db.procurementBidClarification.update({
    where: { id: clarification.id },
    data: { response, status: 'RESPONDED', respondedById: req.user!.id, respondedAt: now() }
  });
  let fileRecord = null;
  if (req.file) {
    const asset = await uploadFile(req.file, {
      ownerId: req.user!.id,
      ownerRole: req.user!.role,
      entityType: 'procurement_bid_clarification',
      entityId: clarification.id,
      purpose: 'clarification_response',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    }, env.STORAGE_PROVIDER);
    fileRecord = await db.procurementBidClarificationFile.create({
      data: {
        clarificationId: clarification.id,
        fileAssetId: asset.id,
        fileName: asset.originalName,
        fileUrl: asset.url,
        fileKey: asset.key,
        mimeType: asset.mimeType,
        fileSize: asset.size,
        uploadedById: req.user!.id
      }
    });
  }
  await procurementAudit(req, 'CLARIFICATION_RESPONDED', 'ProcurementBidClarification', clarification.id, updated);
  return { clarification: updated, file: fileRecord };
};

export const sellerAskClarification = async (req: AuthRequest, bidId: string, question: string) => {
  const bid = await resolveBid(bidId, { participations: { where: { sellerId: req.user!.id } } });
  if (!bid.allowClarification) throw new ApiError(400, 'Clarifications are not enabled for this procurement.', 'CLARIFICATIONS_DISABLED');
  
  const allowedStatuses = ['PUBLISHED', 'OPEN', 'OPEN_FOR_BIDDING'];
  if (!allowedStatuses.includes(bid.status)) {
    throw new ApiError(400, 'Questions can only be asked when the bidding opportunity is open.', 'INVALID_BID_STATUS');
  }

  // Only enforce submission-start-date gate when the bid is NOT yet in an active/open status.
  // If the bid is already PUBLISHED/OPEN/OPEN_FOR_BIDDING, clarifications must be allowed
  // regardless of the schedule dates (the bid was explicitly opened by the buyer).
  const sched = (bid.technicalPacket as any)?.schedule || (bid.payload as any)?.schedule;
  const bidIsActive = allowedStatuses.includes(bid.status);
  if (!bidIsActive) {
    const rawSubmissionStart = sched?.submissionStartDate || sched?.startDate || bid.startDate;
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

  const rawSubmissionDeadline = sched?.submissionDate || sched?.submissionDeadline || bid.endDate;
  if (rawSubmissionDeadline) {
    const deadlineD = new Date(rawSubmissionDeadline);
    if (!isNaN(deadlineD.getTime()) && deadlineD.getTime() < Date.now()) {
      throw new ApiError(400, 'The clarification window has closed as the quotation submission deadline has passed.', 'CLARIFICATION_DEADLINE_PASSED');
    }
  }

  let participation = bid.participations?.[0];
  if (!participation) {
    participation = await startParticipation(req, bidId);
  }

  const clarification = await db.procurementBidClarification.create({
    data: {
      bidId: bid.id,
      participationId: participation.id,
      sellerId: req.user!.id,
      buyerId: bid.buyerId,
      requestNumber: await nextClarificationNumber(bid.bidNumber),
      clarificationType: 'SELLER_QUERY',
      question,
      status: 'PENDING',
      requestedById: req.user!.id
    }
  });

  try {
    await notificationService.notifyUser(bid.buyerId, {
      title: 'New Clarification Question',
      message: `A seller asked a clarification question on opportunity "${bid.title}".`,
      type: 'tender.clarification_received',
      redirectUrl: `/buyer/procurement/events/${bid.id}`
    }, ['in_app', 'email']);
  } catch (err) {
    logger.warn({ err, buyerId: bid.buyerId }, 'Failed to send clarification notification');
  }

  await procurementAudit(req, 'CLARIFICATION_ASKED', 'ProcurementBidClarification', clarification.id, clarification);
  return clarification;
};

export const evaluateTechnical = async (req: AuthRequest, bidId: string, body: any) => {
  const bid = await resolveBid(bidId, {});
  assertBuyerOwner(req.user!, bid);

  const stage2Statuses = [
    'TECHNICAL_EVALUATION_COMPLETED',
    'FINANCIAL_EVALUATION',
    'L1_GENERATED',
    'AWARD_RECOMMENDED',
    'AWARDED',
    'PO_GENERATED',
    'PO_ISSUED',
    'COMPLETED',
    'REVERSE_AUCTION_ACTIVE',
    'REVERSE_AUCTION_SCHEDULED',
  ];
  if (
    stage2Statuses.includes(bid.status) ||
    stage2Statuses.includes(bid.lifecycleStage)
  ) {
    throw new ApiError(
      409,
      'Technical evaluation is finalized and cannot be modified once Stage 2 has opened.',
      'TECHNICAL_EVALUATION_FINALIZED'
    );
  }

  const sched = (bid.technicalPacket && typeof bid.technicalPacket === 'object') ? (bid.technicalPacket as any).schedule : null;
  const deadlineCandidate = firstPresent(
    bid.endDate,
    bid.bidClosingDate,
    sched?.submissionDate,
    sched?.submissionDeadline,
    sched?.submissionEndDate,
    sched?.bidClosingDate,
    (bid.technicalPacket as any)?.submissionDeadline,
    (bid.technicalPacket as any)?.bidClosingDate,
    bid.rawBuyerRequirement?.lastDate,
    bid.rawBuyerRequirement?.requiredBy
  );
  const deadlinePassed = deadlineCandidate ? new Date(deadlineCandidate).getTime() <= Date.now() : false;
  const isSubmissionClosed = technicalEvaluationStatuses.includes(bid.status) || deadlinePassed || Boolean(body?.closeBidIfOpen);

  if (!isSubmissionClosed && !['OPEN', 'OPEN_FOR_BIDDING', 'PUBLISHED'].includes(bid.status)) {
    throw new ApiError(400, 'Technical evaluation can start only after bid closes.', 'INVALID_STATUS_TRANSITION');
  }

  // Two-Packet Gating: Technical Opening Date Check
  const techOpenCandidate = firstPresent(
    bid.technicalOpeningDate,
    sched?.technicalOpeningDate,
    (bid.technicalPacket as any)?.technicalOpeningDate,
    (bid.technicalPacket as any)?.technicalEvaluationDate
  );
  if (techOpenCandidate) {
    const techOpenTime = new Date(techOpenCandidate).getTime();
    if (!isNaN(techOpenTime) && techOpenTime > Date.now()) {
      throw new ApiError(
        400,
        `Technical evaluation cannot begin before the scheduled technical opening date and time (${new Date(techOpenCandidate).toLocaleString('en-IN')}).`,
        'TECHNICAL_OPENING_NOT_REACHED'
      );
    }
  }

  const updatedRows = await db.$transaction(async (tx: any) => {
    if (bid.status !== 'TECHNICAL_EVALUATION') assertBidTransition(bid.status, 'TECHNICAL_EVALUATION');
    if (!bid.isBuyerRequirement) {
      const exists = await tx.procurementBid.findUnique({ where: { id: bid.id }, select: { id: true } });
      if (exists) {
        await tx.procurementBid.update({ where: { id: bid.id }, data: { status: 'TECHNICAL_EVALUATION', lifecycleStage: 'TECHNICAL_EVALUATION' } });
      }
    }
    const rows = [];
    for (const item of body.evaluations) {
      const targetIdNum = Number(item.participationId);
      let participation = !isNaN(targetIdNum) ? await tx.procurementBidParticipation.findUnique({ where: { id: targetIdNum } }) : null;
      if (!participation || participation.bidId !== bid.id) {
        participation = await tx.procurementBidParticipation.findFirst({
          where: {
            bidId: bid.id,
            OR: [
              ...(!isNaN(targetIdNum) ? [{ id: targetIdNum }, { sellerId: targetIdNum }] : []),
              { participationNumber: String(item.participationId).trim() }
            ]
          }
        });
      }

      // Check linked RequirementResponse if direct participation record not found
      if (!participation && !isNaN(targetIdNum)) {
        const reqResp = await tx.requirementResponse.findUnique({
          where: { id: targetIdNum }
        });
        if (reqResp) {
          const uniquePartNumber = `PRT-REQ-${bid.id}-${reqResp.id}`;
          participation = await tx.procurementBidParticipation.findFirst({
            where: { bidId: bid.id, sellerId: reqResp.sellerUserId }
          });
          const reqRespData = typeof reqResp.responseData === 'string'
            ? (() => { try { return JSON.parse(reqResp.responseData); } catch { return {}; } })()
            : (reqResp.responseData || {});
          if (!participation) {
            participation = await tx.procurementBidParticipation.create({
              data: {
                bidId: bid.id,
                sellerId: reqResp.sellerUserId,
                participationNumber: uniquePartNumber,
                submissionStatus: 'SUBMITTED',
                technicalStatus: item.status === 'QUALIFIED' ? 'QUALIFIED' : 'DISQUALIFIED',
                financialStatus: item.status === 'QUALIFIED' ? 'OPENED' : 'LOCKED',
                quotedAmount: reqResp.offeredPrice || 0,
                totalAmount: reqResp.offeredPrice || 0,
                makeBrand: (reqResp as any).makeBrand || reqRespData.makeBrand || null,
                model: (reqResp as any).model || reqRespData.model || null,
                offeredItemDescription: reqResp.message || reqRespData.message || null,
                acknowledgement: reqRespData,
                submittedAt: reqResp.createdAt
              }
            });
          }
          await tx.requirementResponse.update({
            where: { id: reqResp.id },
            data: { status: item.status === 'QUALIFIED' ? 'SHORTLISTED' : 'REJECTED' }
          }).catch(() => {});
        }
      }

      // Check linked QuoteResponse if still not found
      if (!participation && !isNaN(targetIdNum)) {
        const qResp = await tx.quoteResponse.findUnique({
          where: { id: targetIdNum }
        });
        if (qResp) {
          const uniquePartNumber = `PRT-QR-${bid.id}-${qResp.id}`;
          participation = await tx.procurementBidParticipation.findFirst({
            where: { bidId: bid.id, sellerId: qResp.sellerId }
          });
          const qRespData = typeof (qResp as any).responseData === 'string'
            ? (() => { try { return JSON.parse((qResp as any).responseData); } catch { return {}; } })()
            : ((qResp as any).responseData || {});
          if (!participation) {
            participation = await tx.procurementBidParticipation.create({
              data: {
                bidId: bid.id,
                sellerId: qResp.sellerId,
                participationNumber: uniquePartNumber,
                submissionStatus: 'SUBMITTED',
                technicalStatus: item.status === 'QUALIFIED' ? 'QUALIFIED' : 'DISQUALIFIED',
                financialStatus: item.status === 'QUALIFIED' ? 'OPENED' : 'LOCKED',
                quotedAmount: qResp.totalAmount || 0,
                totalAmount: qResp.totalAmount || 0,
                makeBrand: (qResp as any).makeBrand || qRespData.makeBrand || null,
                model: (qResp as any).model || qRespData.model || null,
                offeredItemDescription: (qResp as any).notes || qRespData.message || null,
                acknowledgement: qRespData,
                submittedAt: qResp.createdAt
              }
            });
          }
          await tx.quoteResponse.update({
            where: { id: qResp.id },
            data: {
              technicalStatus: item.status === 'QUALIFIED' ? 'QUALIFIED' : 'DISQUALIFIED',
              technicalRemarks: item.remarks || null
            }
          }).catch(() => {});
        }
      }

      if (!participation || participation.bidId !== bid.id) throw new ApiError(404, 'Participation not found', 'PARTICIPATION_NOT_FOUND');
      const technicalStatus = item.status === 'QUALIFIED' ? 'QUALIFIED' : 'DISQUALIFIED';
      await tx.procurementBidParticipation.update({
        where: { id: participation.id },
        data: {
          technicalStatus,
          financialStatus: technicalStatus === 'DISQUALIFIED' ? 'LOCKED' : participation.financialStatus,
          rejectionReason: item.status === 'DISQUALIFIED' ? item.remarks : null
        }
      });

      // Synchronize evaluation decision across any linked RequirementResponse, QuoteResponse, or Tender Bid
      if (participation.sellerId) {
        const sId = Number(participation.sellerId);
        const packet = (bid.technicalPacket && typeof bid.technicalPacket === 'object') ? (bid.technicalPacket as any) : {};
        const linkedReqId = Number(packet.sourceRequirementId || packet.requirementId || bid.sourceId || 0);

        // Sync RequirementResponse - strictly scoped to this procurement's requirement
        if (linkedReqId > 0) {
          await tx.requirementResponse.updateMany({
            where: {
              requirementId: linkedReqId,
              sellerUserId: sId
            },
            data: {
              status: technicalStatus === 'QUALIFIED' ? 'SHORTLISTED' : 'REJECTED'
            }
          }).catch(() => {});
        }

        // Sync QuoteResponse - strictly scoped to this procurement's quote request
        const linkedQuoteReqId = Number(bid.sourceId || packet.quoteRequestId || 0);
        if (linkedQuoteReqId > 0) {
          await tx.quoteResponse.updateMany({
            where: {
              quoteRequestId: linkedQuoteReqId,
              sellerId: sId
            },
            data: {
              technicalStatus,
              technicalRemarks: item.remarks || null
            }
          }).catch(() => {});
        }

        // Sync Tender Bid if applicable
        const tenderNum = Number(String(bid.bidNumber || '').replace(/\D+/g, '')) || Number(bid.sourceId || 0);
        if (tenderNum > 0) {
          await tx.bid.updateMany({
            where: {
              tenderId: tenderNum,
              sellerId: sId
            },
            data: {
              status: technicalStatus === 'QUALIFIED' ? 'accepted' : 'rejected'
            }
          }).catch(() => {});
        }
      }
      rows.push(await tx.procurementBidEvaluation.create({
        data: {
          bidId: bid.id,
          participationId: participation.id,
          sellerId: participation.sellerId,
          evaluatorId: req.user!.id,
          evaluationType: 'TECHNICAL',
          status: technicalStatus,
          remarks: item.remarks,
          score: item.score
        }
      }));
    }
    return rows;
  }, { maxWait: 15000, timeout: 30000 });
  await procurementAudit(req, 'TECHNICAL_EVALUATION_STARTED', 'ProcurementBid', bid.id, { status: 'TECHNICAL_EVALUATION' }, bid);
  for (const row of updatedRows) {
    await procurementAudit(req, row.status === 'QUALIFIED' ? 'SELLER_QUALIFIED' : 'SELLER_DISQUALIFIED', 'ProcurementBidParticipation', row.participationId, row);
  }

  // Option B: Auto-transition technical evaluation & open financial ranking once all sellers are evaluated
  await autoCheckAndPerformTransitions(bid.id, req);

  try {
    const targetIds = [bid.id, bid.bidNumber, bid.sourceId, (bid.technicalPacket as any)?.sourceRequirementId].filter(Boolean);
    targetIds.forEach((tid: any) => {
      broadcastToProcurement(tid, {
        type: 'TECHNICAL_EVALUATION_STARTED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        status: 'TECHNICAL_EVALUATION',
        timestamp: new Date().toISOString()
      });
      broadcastToProcurement(tid, {
        type: 'PROCUREMENT_UPDATED',
        requirementId: bid.sourceId || bid.id,
        procurementId: bid.id,
        status: 'TECHNICAL_EVALUATION',
        timestamp: new Date().toISOString()
      });
    });
  } catch (bcErr) {
    logger.warn({ bcErr }, '[evaluateTechnicalPart] Failed to broadcast technical evaluation start');
  }

  return updatedRows;
};

export const evaluateBidCountThresholds = async (
  tx: any,
  bid: any,
  qualifiedCount: number,
  body: any = {}
) => {
  const pkt = (bid.technicalPacket && typeof bid.technicalPacket === 'object') ? bid.technicalPacket as Record<string, any> : {};
  const sched = (pkt.schedule && typeof pkt.schedule === 'object') ? pkt.schedule : {};
  const rawMin = sched.minimumBidders ?? pkt.minimumBidders ?? pkt.minimumQualifiedBidders ?? (bid as any).minimumQualifiedBidders;
  const minRequired = Number(rawMin) > 0 ? Number(rawMin) : 3;
  const meta = (pkt.metadata && typeof pkt.metadata === 'object') ? pkt.metadata : {};

  // Single Bidder Protocol (Even if min is 1, a single bid carries monopoly pricing risk)
  if (qualifiedCount === 1) {
    const singleBidMeta = {
      ...meta,
      singleBidReceived: true,
      bidCount: 1,
      minimumBidsRequired: minRequired,
      singleBidJustification: body.justificationReason || body.remarks || null,
      singleBidAdvisory: 'Only 1 technically qualified quotation received. Buyer administrative confirmation required to ensure rate reasonability before proceeding.'
    };
    await tx.procurementBid.update({
      where: { id: bid.id },
      data: { technicalPacket: { ...pkt, metadata: singleBidMeta } }
    });
    if (body.singleBidConfirmed !== true) {
      throw new ApiError(
        400,
        'Single bid received. Buyer admin must confirm rate reasonability before proceeding with financial evaluation.',
        'SINGLE_BID_CONFIRMATION_REQUIRED'
      );
    }
  } else if (qualifiedCount < minRequired && qualifiedCount > 1) {
    const lowBidMeta = {
      ...meta,
      lowBidCountWarning: true,
      bidCount: qualifiedCount,
      minimumBidsRequired: minRequired,
      lowBidJustification: body.justificationReason || body.remarks || null,
      lowBidAdvisory: `Only ${qualifiedCount} bids received (less than configured minimum of ${minRequired}). Buyer confirmation required to proceed with below-threshold competition.`
    };
    await tx.procurementBid.update({
      where: { id: bid.id },
      data: { technicalPacket: { ...pkt, metadata: lowBidMeta } }
    });
    if (body.lowBidConfirmed !== true && body.confirmProceedBelowMinimum !== true) {
      throw new ApiError(
        400,
        `Only ${qualifiedCount} technically qualified bid(s) received, which is below the configured minimum sourcing requirement of ${minRequired}. Please confirm to proceed with current bids or extend the bidding deadline.`,
        'LOW_BID_COUNT_CONFIRMATION_REQUIRED'
      );
    }
  } else if (qualifiedCount >= minRequired) {
    // If threshold is satisfied and we previously had warnings, record that requirement is fulfilled
    const cleanMeta = {
      ...meta,
      lowBidCountWarning: false,
      singleBidReceived: false,
      bidCount: qualifiedCount,
      minimumBidsRequired: minRequired,
      thresholdSatisfied: true,
      advisoryNote: `Sourcing threshold met: ${qualifiedCount} qualified bids received (minimum required: ${minRequired}).`
    };
    await tx.procurementBid.update({
      where: { id: bid.id },
      data: { technicalPacket: { ...pkt, metadata: cleanMeta } }
    });
  }
};

export const performFinancialRankingAndOpening = async (bid: any, evaluatorId?: number, req?: any, body: any = {}) => {
  const sourceReqId = Number(bid.sourceId || (bid.technicalPacket as any)?.sourceRequirementId || (bid.technicalPacket as any)?.requirementId || 0);

  const ranked = await db.$transaction(async (tx: any) => {
    const qualified = await tx.procurementBidParticipation.findMany({
      where: { bidId: bid.id, technicalStatus: 'QUALIFIED', submissionStatus: 'SUBMITTED', totalAmount: { not: null } },
      orderBy: { totalAmount: 'asc' }
    });
    if (!qualified.length) return [];
    await evaluateBidCountThresholds(tx, bid, qualified.length, body);
    for (const [index, row] of qualified.entries()) {
      const rank = index + 1;
      const finalStatus = rankToFinalStatus(rank);
      await tx.procurementBidParticipation.update({
        where: { id: row.id },
        data: { financialStatus: 'EVALUATED', finalStatus, rank }
      });
      await tx.procurementBidEvaluation.create({
        data: {
          bidId: bid.id,
          participationId: row.id,
          sellerId: row.sellerId,
          evaluatorId: evaluatorId || bid.buyerId || 1,
          evaluationType: 'FINANCIAL',
          status: 'OPENED',
          remarks: `Auto-ranked ${finalStatus}`,
          score: null
        }
      });
    }
    await tx.procurementBid.update({
      where: { id: bid.id },
      data: { status: 'L1_GENERATED', lifecycleStage: 'L1_GENERATED', financialOpeningDate: now() }
    });
    if (sourceReqId > 0) {
      await tx.buyerRequirement.updateMany({
        where: { id: sourceReqId },
        data: { status: 'L1_GENERATED' }
      }).catch(() => null);
      await tx.requirement.updateMany({
        where: { OR: [{ id: sourceReqId }, { requirementNumber: bid.bidNumber }] },
        data: { status: 'L1_GENERATED' }
      }).catch(() => null);
    }
    await tx.procurementBidParticipation.updateMany({
      where: { bidId: bid.id, technicalStatus: { not: 'QUALIFIED' } },
      data: { financialStatus: 'LOCKED' }
    });
    return qualified.map((row: any, index: number) => ({ ...row, rank: index + 1, finalStatus: rankToFinalStatus(index + 1) }));
  }, { maxWait: 15000, timeout: 30000 });

  if (req && ranked.length > 0) {
    await procurementAudit(req, 'FINANCIAL_EVALUATION_OPENED', 'ProcurementBid', bid.id, { qualifiedCount: ranked.length }).catch(() => null);
    await procurementAudit(req, 'L1_GENERATED', 'ProcurementBid', bid.id, ranked.map((r: any) => ({ id: r.id, rank: r.rank, totalAmount: r.totalAmount }))).catch(() => null);
  }

  try {
    const l1Price = ranked.length > 0 ? Number(ranked[0].totalAmount || 0) : undefined;
    const targetIds = [bid.id, bid.bidNumber, sourceReqId].filter(Boolean);
    targetIds.forEach((tid: any) => {
      broadcastToProcurement(tid, {
        type: 'FINANCIAL_EVALUATION_STARTED',
        procurementId: bid.id,
        requirementId: sourceReqId || bid.id,
        status: 'L1_GENERATED',
        timestamp: new Date().toISOString()
      });
      broadcastToProcurement(tid, {
        type: 'L1_GENERATED',
        procurementId: bid.id,
        requirementId: sourceReqId || bid.id,
        l1Price,
        timestamp: new Date().toISOString()
      });
      broadcastToProcurement(tid, {
        type: 'PROCUREMENT_UPDATED',
        procurementId: bid.id,
        requirementId: sourceReqId || bid.id,
        status: 'L1_GENERATED',
        timestamp: new Date().toISOString()
      });
    });
  } catch (bcErr) {
    logger.warn({ bcErr }, '[performFinancialRankingAndOpening] Broadcast error');
  }

  return ranked;
};

export const autoCheckAndPerformTransitions = async (bidId: number | string, req?: any) => {
  try {
    const bid = await db.procurementBid.findFirst({
      where: { OR: [{ id: Number(bidId) || -1 }, { bidNumber: String(bidId) }] }
    });
    if (!bid) return null;

    const currentStatus = String(bid.status || '').toUpperCase();
    if (['L1_GENERATED', 'AWARD_RECOMMENDED', 'AWARD_OFFERED', 'AWARD_ACCEPTED', 'AWARDED', 'PO_GENERATED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED'].includes(currentStatus)) {
      return bid;
    }

    let qualified = await db.procurementBidParticipation.count({ where: { bidId: bid.id, technicalStatus: 'QUALIFIED' } });
    let pending = await db.procurementBidParticipation.count({
      where: {
        bidId: bid.id,
        submissionStatus: 'SUBMITTED',
        technicalStatus: { in: ['PENDING', 'UNDER_REVIEW', 'CLARIFICATION_REQUIRED'] }
      }
    });

    const sourceReqId = Number(bid.sourceId || (bid.technicalPacket as any)?.sourceRequirementId || (bid.technicalPacket as any)?.requirementId || 0);
    if (!qualified && sourceReqId > 0) {
      qualified = await db.requirementResponse.count({ where: { requirementId: sourceReqId, status: { in: ['SHORTLISTED', 'ACCEPTED', 'QUALIFIED'] } } });
      pending = await db.requirementResponse.count({ where: { requirementId: sourceReqId, status: { in: ['PENDING', 'UNDER_REVIEW', 'SUBMITTED'] } } });
    }

    // Auto-transition to TECHNICAL_EVALUATION_COMPLETED once all sellers are evaluated
    if (pending === 0 && qualified > 0) {
      if (currentStatus !== 'TECHNICAL_EVALUATION_COMPLETED' && currentStatus !== 'FINANCIAL_EVALUATION') {
        await db.procurementBid.update({
          where: { id: bid.id },
          data: { status: 'TECHNICAL_EVALUATION_COMPLETED', lifecycleStage: 'TECHNICAL_EVALUATION_COMPLETED' }
        });
        if (sourceReqId > 0) {
          await db.buyerRequirement.updateMany({
            where: { id: sourceReqId },
            data: { status: 'TECHNICAL_EVALUATION_COMPLETED' }
          }).catch(() => null);
          await db.requirement.updateMany({
            where: { OR: [{ id: sourceReqId }, { requirementNumber: bid.bidNumber }] },
            data: { status: 'TECHNICAL_EVALUATION_COMPLETED' }
          }).catch(() => null);
        }
        if (req) {
          await procurementAudit(req, 'TECHNICAL_EVALUATION_COMPLETED', 'ProcurementBid', bid.id, { auto: true }).catch(() => null);
        }
      }

      // Check if financial opening date/time has arrived
      const sched = (bid.technicalPacket && typeof bid.technicalPacket === 'object') ? (bid.technicalPacket as any).schedule : null;
      const finOpenCandidate = firstPresent(
        bid.financialOpeningDate,
        sched?.financialOpeningDate,
        (bid.technicalPacket as any)?.financialOpeningDate,
        (bid.technicalPacket as any)?.financialEvaluationDate
      );
      const isFinOpeningTimeReached = !finOpenCandidate || isNaN(new Date(finOpenCandidate).getTime()) || new Date(finOpenCandidate).getTime() <= Date.now();

      if (isFinOpeningTimeReached) {
        logger.info({ bidId: bid.id, bidNumber: bid.bidNumber }, '[AUTO_TRANSITION] Auto-opening financial evaluation and generating L1');
        await performFinancialRankingAndOpening(bid, req?.user?.id || bid.buyerId || 1, req);
      }
    }
  } catch (err: any) {
    logger.warn({ bidId, error: err?.message }, '[AUTO_TRANSITION] Error in auto-transition checks');
  }
};

export const completeTechnicalEvaluation = async (req: AuthRequest, bidId: string) => {
  const bid = await resolveBid(bidId, {});
  assertBuyerOwner(req.user!, bid);
  if (
    bid.status === 'TECHNICAL_EVALUATION_COMPLETED' ||
    ['FINANCIAL_EVALUATION', 'L1_GENERATED', 'AWARD_RECOMMENDED', 'AWARDED', 'PO_GENERATED'].includes(bid.status)
  ) {
    return bid;
  }
  if (!['TECHNICAL_EVALUATION', 'CLOSED', 'EXPIRED', 'UNDER_EVALUATION'].includes(bid.status)) {
    throw new ApiError(400, 'Technical evaluation is not active.', 'TECHNICAL_EVALUATION_PENDING');
  }
  let qualified = await db.procurementBidParticipation.count({ where: { bidId: bid.id, technicalStatus: 'QUALIFIED' } });
  let pending = await db.procurementBidParticipation.count({ where: { bidId: bid.id, submissionStatus: 'SUBMITTED', technicalStatus: { in: ['PENDING', 'UNDER_REVIEW', 'CLARIFICATION_REQUIRED'] } } });

  const sourceReqId = Number(bid.sourceId || (bid.technicalPacket as any)?.sourceRequirementId || (bid.technicalPacket as any)?.requirementId || 0);
  if (!qualified && sourceReqId > 0) {
    qualified = await db.requirementResponse.count({ where: { requirementId: sourceReqId, status: { in: ['SHORTLISTED', 'ACCEPTED', 'QUALIFIED'] } } });
    pending = await db.requirementResponse.count({ where: { requirementId: sourceReqId, status: { in: ['PENDING', 'UNDER_REVIEW', 'SUBMITTED'] } } });
  }

  if (!qualified) throw new ApiError(400, 'At least one seller must be technically qualified.', 'TECHNICAL_EVALUATION_PENDING');
  if (pending) throw new ApiError(400, 'Every submitted participant must be technically qualified or disqualified before completion.', 'TECHNICAL_EVALUATION_PENDING');
  if (bid.status !== 'TECHNICAL_EVALUATION') {
    assertBidTransition(bid.status, 'TECHNICAL_EVALUATION');
  }
  assertBidTransition('TECHNICAL_EVALUATION', 'TECHNICAL_EVALUATION_COMPLETED');
  const updated = await db.procurementBid.update({ where: { id: bid.id }, data: { status: 'TECHNICAL_EVALUATION_COMPLETED', lifecycleStage: 'TECHNICAL_EVALUATION_COMPLETED' } });

  if (sourceReqId > 0) {
    await db.buyerRequirement.updateMany({
      where: { id: sourceReqId },
      data: { status: 'TECHNICAL_EVALUATION_COMPLETED' }
    }).catch(() => null);
    await db.requirement.updateMany({
      where: { OR: [{ id: sourceReqId }, { requirementNumber: bid.bidNumber }] },
      data: { status: 'TECHNICAL_EVALUATION_COMPLETED' }
    }).catch(() => null);
  }

  await procurementAudit(req, 'TECHNICAL_EVALUATION_COMPLETED', 'ProcurementBid', bid.id, updated);

  // Also auto-open financial evaluation if opening time has arrived
  const sched = (updated.technicalPacket && typeof updated.technicalPacket === 'object') ? (updated.technicalPacket as any).schedule : null;
  const finOpenCandidate = firstPresent(
    updated.financialOpeningDate,
    sched?.financialOpeningDate,
    (updated.technicalPacket as any)?.financialOpeningDate,
    (updated.technicalPacket as any)?.financialEvaluationDate
  );
  const isFinOpeningTimeReached = !finOpenCandidate || isNaN(new Date(finOpenCandidate).getTime()) || new Date(finOpenCandidate).getTime() <= Date.now();
  if (isFinOpeningTimeReached) {
    await performFinancialRankingAndOpening(updated, req.user!.id, req);
  }

  return updated;
};

export const openFinancialEvaluation = async (req: AuthRequest, bidId: string, body: any = {}) => {
  const bid = await resolveBid(bidId, { participations: true });
  assertBuyerOwner(req.user!, bid);
  if (
    bid.status === 'FINANCIAL_EVALUATION' ||
    ['L1_GENERATED', 'AWARD_RECOMMENDED', 'AWARDED', 'PO_GENERATED'].includes(bid.status)
  ) {
    return bid;
  }
  if (!financialEvaluationReadyStatuses.includes(bid.status)) {
    throw new ApiError(400, 'Technical evaluation must be completed before opening financial bids.', 'TECHNICAL_EVALUATION_PENDING');
  }
  assertBidTransition(bid.status, 'FINANCIAL_EVALUATION');

  // Two-Packet Gating: Financial Opening Date Check
  const sched = (bid.technicalPacket && typeof bid.technicalPacket === 'object') ? (bid.technicalPacket as any).schedule : null;
  const finOpenCandidate = firstPresent(
    bid.financialOpeningDate,
    sched?.financialOpeningDate,
    (bid.technicalPacket as any)?.financialOpeningDate,
    (bid.technicalPacket as any)?.financialEvaluationDate
  );
  if (finOpenCandidate) {
    const finOpenTime = new Date(finOpenCandidate).getTime();
    if (!isNaN(finOpenTime) && finOpenTime > Date.now()) {
      throw new ApiError(
        400,
        `Financial bids cannot be opened before the scheduled financial opening date and time (${new Date(finOpenCandidate).toLocaleString('en-IN')}).`,
        'FINANCIAL_OPENING_NOT_REACHED'
      );
    }
  }

  const ranked = await performFinancialRankingAndOpening(bid, req.user!.id, req, body);
  if (!ranked.length) throw new ApiError(400, 'No technically qualified financial quotes are available to open.', 'FINANCIAL_NOT_OPENED');
  return ranked;
};

export const recommendAward = async (req: AuthRequest, bidId: string, body: any) => {
  logger.info({ bidId, user: req.user?.id, body: maskSensitive(body) }, '[RECOMMEND_AWARD] Starting award recommendation');

  const bid = await resolveBid(bidId, {});
  logger.info({ bidId: bid.id, bidNumber: bid.bidNumber, buyerId: bid.buyerId }, '[RECOMMEND_AWARD] Resolved bid');

  assertBuyerOwner(req.user!, bid);
  logger.info({ user: req.user?.id }, '[RECOMMEND_AWARD] Buyer ownership verified');

  // Strict Guard: If an auction is linked and active/concluded, direct quote awarding is illegal
  const linkedAuction = await db.auction.findFirst({
    where: {
      OR: [
        { linkedBidId: bid.id },
        ...(bid.sourceId ? [{ linkedRequirementId: Number(bid.sourceId) }] : [])
      ]
    },
    orderBy: { createdAt: 'desc' }
  });

  if (linkedAuction && ['LIVE', 'PAUSED', 'CLOSED', 'COMPLETED', 'AWARD_OFFERED', 'AWARDED'].includes(String(linkedAuction.status || '').toUpperCase())) {
    throw new ApiError(
      409,
      `Cannot award directly from initial quotations. Reverse Auction (${linkedAuction.auctionCode || linkedAuction.id}) is active or concluded. All contract award offers must be executed via the Reverse Auction Outcome Engine.`,
      'AWARD_LOCKED_BY_REVERSE_AUCTION'
    );
  }

  const rawPartId = body.participationId;
  let rawPartIdNum = typeof rawPartId === 'number' ? rawPartId : Number(String(rawPartId || '').replace(/^[^\d]+/, ''));
  let partIdNum = (rawPartIdNum && !isNaN(rawPartIdNum) && rawPartIdNum > 0 && rawPartIdNum <= 2147483647) ? rawPartIdNum : null;
  let participation: any = null;

  if (partIdNum && !isNaN(partIdNum)) {
    participation = await db.procurementBidParticipation.findUnique({
      where: { id: partIdNum },
      include: { seller: { include: { organization: true } } }
    });
  }

  if (!participation && typeof rawPartId === 'string' && rawPartId.trim()) {
    participation = await db.procurementBidParticipation.findFirst({
      where: {
        bidId: bid.id,
        OR: [
          { participationNumber: rawPartId.trim() },
          { participationNumber: { contains: rawPartId.trim() } }
        ]
      },
      include: { seller: { include: { organization: true } } }
    });
  }

  if (participation && participation.bidId !== bid.id) {
    const partBid = await db.procurementBid.findUnique({ where: { id: participation.bidId } });
    if (!partBid || (partBid.id !== bid.id && partBid.bidNumber !== bid.bidNumber && (!bid.sourceId || partBid.sourceId !== bid.sourceId))) {
      participation = null;
    }
  }

  if (!participation && partIdNum && !isNaN(partIdNum)) {
    participation = await db.procurementBidParticipation.findFirst({
      where: {
        bidId: bid.id,
        OR: [
          { id: partIdNum },
          { sellerId: partIdNum }
        ]
      },
      include: { seller: { include: { organization: true } } }
    });
  }

  if (!participation && partIdNum && !isNaN(partIdNum)) {
    logger.info({ partIdNum }, '[RECOMMEND_AWARD] Searching requirementResponse table for participation ID...');
    const reqResp = await db.requirementResponse.findUnique({
      where: { id: partIdNum },
      include: {
        sellerUser: { select: { id: true, name: true, email: true, mobile: true, role: true, organizationId: true } },
        sellerOrganization: { select: { organizationName: true } },
        requirement: true
      }
    });

    if (reqResp) {
      logger.info({ reqRespId: reqResp.id, sellerUserId: reqResp.sellerUserId }, '[RECOMMEND_AWARD] Found requirementResponse');
      let shadowPart = await db.procurementBidParticipation.findFirst({
        where: {
          bidId: bid.id,
          sellerId: reqResp.sellerUserId
        },
        include: { seller: { include: { organization: true } } }
      });

      if (!shadowPart) {
        const uniquePartNumber = `PRT-REQ-${bid.id}-${reqResp.id}-${Date.now().toString(36).slice(-4)}`;
        let responseDataObj: any = {};
        if (reqResp.responseData) {
          if (typeof reqResp.responseData === 'object') {
            responseDataObj = reqResp.responseData;
          } else if (typeof reqResp.responseData === 'string') {
            try { responseDataObj = JSON.parse(reqResp.responseData); } catch {}
          }
        }

        logger.info({ uniquePartNumber, bidId: bid.id, sellerId: reqResp.sellerUserId }, '[RECOMMEND_AWARD] Creating shadow participation');
        shadowPart = await db.procurementBidParticipation.create({
          data: {
            bidId: bid.id,
            sellerId: reqResp.sellerUserId,
            participationNumber: uniquePartNumber,
            submissionStatus: 'SUBMITTED',
            technicalStatus: 'QUALIFIED',
            financialStatus: 'EVALUATED',
            quotedAmount: reqResp.offeredPrice || 0,
            totalAmount: reqResp.offeredPrice || 0,
            submittedAt: reqResp.createdAt,
            acknowledgement: responseDataObj
          },
          include: { seller: { include: { organization: true } } }
        });
        logger.info({ shadowPartId: shadowPart.id }, '[RECOMMEND_AWARD] Created shadow participation successfully');
      }
      participation = shadowPart;

      await db.requirementResponse.update({
        where: { id: reqResp.id },
        data: { status: 'ACCEPTED' }
      }).catch(err => logger.warn({ err }, '[RECOMMEND_AWARD] Error updating requirementResponse status to ACCEPTED'));

      await db.requirementResponse.updateMany({
        where: { requirementId: reqResp.requirementId, id: { not: reqResp.id } },
        data: { status: 'REJECTED' }
      }).catch(err => logger.warn({ err }, '[RECOMMEND_AWARD] Error updating requirementResponse status to REJECTED'));

      if (reqResp.requirementId) {
        await db.buyerRequirement.update({
          where: { id: reqResp.requirementId },
          data: { status: 'AWARDED' }
        }).catch(err => logger.warn({ err }, '[RECOMMEND_AWARD] Error updating buyerRequirement status to AWARDED'));
      }
    }
  }

  if (!participation && partIdNum && !isNaN(partIdNum)) {
    logger.info({ partIdNum }, '[RECOMMEND_AWARD] Searching quoteResponse table for participation ID (RFQ)...');
    let quoteResp: any = await db.quoteResponse.findUnique({
      where: { id: partIdNum },
      include: {
        seller: { select: { id: true, name: true, email: true, mobile: true, role: true, organizationId: true } },
        quoteRequest: true
      }
    }).catch(err => {
      logger.warn({ err }, '[RECOMMEND_AWARD] Error querying quoteResponse');
      return null;
    });

    if (!quoteResp && bid.sourceId) {
      quoteResp = await db.quoteResponse.findFirst({
        where: {
          quoteRequestId: bid.sourceId,
          OR: [
            { id: partIdNum },
            { sellerId: partIdNum }
          ]
        },
        include: {
          seller: { select: { id: true, name: true, email: true, mobile: true, role: true, organizationId: true } },
          quoteRequest: true
        }
      }).catch(() => null);
    }

    if (quoteResp) {
      logger.info({ quoteRespId: quoteResp.id, sellerId: quoteResp.sellerId }, '[RECOMMEND_AWARD] Found quoteResponse');

      let validSellerId = quoteResp.sellerId;
      if (validSellerId) {
        const sellerUser = await db.user.findUnique({ where: { id: Number(validSellerId) } });
        if (!sellerUser) validSellerId = null;
      }
      if (!validSellerId) {
        const fallbackSeller = await db.user.findFirst({ where: { role: 'seller' } });
        validSellerId = fallbackSeller?.id || req.user!.id;
      }

      let shadowPart = await db.procurementBidParticipation.findFirst({
        where: {
          bidId: bid.id,
          sellerId: validSellerId
        },
        include: { seller: { include: { organization: true } } }
      });

      if (!shadowPart) {
        const uniquePartNumber = `PRT-QR-${bid.id}-${quoteResp.id}-${Date.now().toString(36).slice(-4)}`;
        let responseDataObj: any = {};
        if (quoteResp.notes || (quoteResp as any).responseData) {
          if (typeof (quoteResp as any).responseData === 'object') {
            responseDataObj = (quoteResp as any).responseData;
          } else if (typeof (quoteResp as any).responseData === 'string') {
            try { responseDataObj = JSON.parse((quoteResp as any).responseData); } catch {}
          }
        }

        const quotedTotal = Number(quoteResp.totalAmount || (quoteResp as any).quotedAmount || quoteResp.unitPrice || quoteResp.price || 0);

        logger.info({ uniquePartNumber, bidId: bid.id, sellerId: validSellerId, quotedTotal }, '[RECOMMEND_AWARD] Creating shadow participation for RFQ quoteResponse');
        shadowPart = await db.procurementBidParticipation.create({
          data: {
            bidId: bid.id,
            sellerId: validSellerId,
            participationNumber: uniquePartNumber,
            submissionStatus: 'SUBMITTED',
            technicalStatus: 'QUALIFIED',
            financialStatus: 'EVALUATED',
            quotedAmount: quotedTotal,
            totalAmount: quotedTotal,
            submittedAt: quoteResp.createdAt || new Date(),
            acknowledgement: responseDataObj
          },
          include: { seller: { include: { organization: true } } }
        });
        logger.info({ shadowPartId: shadowPart.id }, '[RECOMMEND_AWARD] Created shadow participation for RFQ quoteResponse successfully');
      }
      participation = shadowPart;

      await db.quoteResponse.update({
        where: { id: quoteResp.id },
        data: { status: 'ACCEPTED' }
      }).catch(err => logger.warn({ err }, '[RECOMMEND_AWARD] Error updating quoteResponse status to ACCEPTED'));

      if (quoteResp.quoteRequestId) {
        await db.quoteResponse.updateMany({
          where: { quoteRequestId: quoteResp.quoteRequestId, id: { not: quoteResp.id } },
          data: { status: 'REJECTED' }
        }).catch(err => logger.warn({ err }, '[RECOMMEND_AWARD] Error updating quoteResponse status to REJECTED'));

        await db.quoteRequest.update({
          where: { id: quoteResp.quoteRequestId },
          data: { status: 'closed', statusEnum: 'CLOSED' }
        }).catch(err => logger.warn({ err }, '[RECOMMEND_AWARD] Error updating quoteRequest status to CLOSED'));
      }
    }
  }

  if (!participation) {
    logger.error({ partIdNum, bidId: bid.id }, '[RECOMMEND_AWARD] Failed to locate participation record');
    throw new ApiError(404, 'Participation not found', 'PARTICIPATION_NOT_FOUND');
  }

  logger.info({ participationId: participation.id, sellerId: participation.sellerId }, '[RECOMMEND_AWARD] Resolved participation, executing transaction...');

  const award = await db.$transaction(async (tx: any) => {
    let created = await tx.procurementBidAward.findFirst({
      where: {
        bidId: bid.id,
        participationId: participation.id
      }
    });

    if (!created) {
      created = await tx.procurementBidAward.create({
        data: {
          bidId: bid.id,
          participationId: participation.id,
          sellerId: participation.sellerId,
          awardedAmount: participation.totalAmount || participation.quotedAmount || 0,
          originalBidAmount: participation.totalAmount || participation.quotedAmount || 0,
          justificationReason: body.justificationReason || body.adminOverrideReason || null,
          awardStatus: 'OFFERED',
          awardedById: req.user!.id,
          remarks: body.remarks || body.adminOverrideReason || 'Award offered by buyer',
          awardedAt: now()
        }
      });
    } else {
      created = await tx.procurementBidAward.update({
        where: { id: created.id },
        data: {
          awardStatus: 'OFFERED',
          awardedAmount: participation.totalAmount || participation.quotedAmount || 0,
          originalBidAmount: participation.totalAmount || participation.quotedAmount || 0,
          justificationReason: body.justificationReason || body.adminOverrideReason || null,
          remarks: body.remarks || body.adminOverrideReason || 'Award offered by buyer',
          awardedAt: now()
        }
      });
    }

    await tx.procurementBidParticipation.update({
      where: { id: participation.id },
      data: { finalStatus: 'AWARD_OFFERED', technicalStatus: 'QUALIFIED', financialStatus: 'EVALUATED' }
    });

    // CRITICAL: All other participants remain at their current status (UNDER_EVALUATION).
    // They are NOT rejected or marked NOT_SELECTED here!

    await tx.procurementBid.update({
      where: { id: bid.id },
      data: { status: 'AWARD_OFFERED', lifecycleStage: 'AWARD_RECOMMENDED' }
    });

    return created;
  }, {
    maxWait: 10000,
    timeout: 20000
  });

  logger.info({ awardId: award.id }, '[RECOMMEND_AWARD] Award offer recorded successfully');

  await procurementAudit(req, 'AWARD_OFFERED', 'ProcurementBidAward', award.id, award).catch(err => logger.warn({ err }, '[RECOMMEND_AWARD] Error creating audit log'));

  await notificationService.notifyUser(participation.sellerId, {
    title: 'Award Offer Received',
    message: `You have been offered the contract award for "${bid.title}". Please review the award and accept or decline.`,
    type: 'bid_awarded',
    redirectUrl: `/bids/${bid.id}`
  }).catch(() => undefined);

  try {
    const targetIds = [bid.id, bid.bidNumber, bid.sourceId, (bid.technicalPacket as any)?.sourceRequirementId].filter(Boolean);
    targetIds.forEach((tid: any) => {
      broadcastToProcurement(tid, {
        type: 'PROCUREMENT_AWARDED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        status: 'AWARD_OFFERED',
        sellerOrgId: participation.sellerOrgId,
        sellerUserId: participation.sellerId,
        awardedAmount: Number(award.awardedAmount || 0),
        timestamp: new Date().toISOString()
      });
      broadcastToProcurement(tid, {
        type: 'PROCUREMENT_UPDATED',
        requirementId: bid.sourceId || bid.id,
        procurementId: bid.id,
        status: 'AWARD_OFFERED',
        timestamp: new Date().toISOString()
      });
    });
    if (participation.sellerId) {
      broadcastToUser(participation.sellerId, {
        type: 'AWARD_RECEIVED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        awardedAmount: Number(award.awardedAmount || 0),
        timestamp: new Date().toISOString()
      });
    }
  } catch (bcErr) {
    logger.warn({ bcErr }, '[RECOMMEND_AWARD] Failed to broadcast award offer to procurement');
  }

  // In the simplified portal, NO auto-PO is generated at award time.
  // The seller must review and accept the award first, then PO is generated and accepted.
  return {
    award,
    status: 'AWARD_OFFERED',
    message: 'Award offer submitted to seller. Awaiting seller acceptance.'
  };
};

export const acceptAward = async (req: AuthRequest, bidId: string) => {
  logger.info({ bidId, user: req.user?.id }, '[ACCEPT_AWARD] Seller accepting award');
  const bid = await resolveBid(bidId, {});
  const sellerUserIds = await getSellerUserIdsForActor(req.user!);
  const sellerOrgIds = req.user?.organizationId ? [Number(req.user.organizationId)] : [];
  const validSellerIds = Array.from(new Set([...sellerUserIds, ...sellerOrgIds]));
  const awardIdFilter = req.body?.awardId ? Number(req.body.awardId) : undefined;

  const PENDING_AWARD_STATUSES = ['OFFERED', 'RECOMMENDED', 'ADMIN_APPROVED', 'AWARDED', 'AWARD_OFFERED', 'PENDING', 'PENDING_ACCEPTANCE', 'ISSUED'];

  let award = await db.procurementBidAward.findFirst({
    where: {
      bidId: bid.id,
      ...(awardIdFilter ? { id: awardIdFilter } : {}),
      sellerId: { in: validSellerIds },
      awardStatus: { in: PENDING_AWARD_STATUSES }
    },
    include: { participation: true }
  });

  if (!award && awardIdFilter) {
    const specificAward = await db.procurementBidAward.findFirst({
      where: { id: awardIdFilter, bidId: bid.id },
      include: { participation: true }
    });
    if (specificAward) {
      const isAuthorized =
        validSellerIds.includes(Number(specificAward.sellerId)) ||
        (specificAward.participation && validSellerIds.includes(Number(specificAward.participation.sellerId)));
      if (isAuthorized) {
        if (PENDING_AWARD_STATUSES.includes(specificAward.awardStatus)) {
          award = specificAward;
        } else if (specificAward.awardStatus === 'ACCEPTED' || specificAward.awardStatus === 'AWARD_ACCEPTED') {
          return { award: specificAward, status: 'AWARD_ACCEPTED', message: 'Award offer has already been accepted.' };
        }
      }
    }
  }

  // Idempotent recovery: If award is already accepted for this bid and seller, return success rather than 404
  if (!award) {
    const alreadyAccepted = await db.procurementBidAward.findFirst({
      where: {
        bidId: bid.id,
        ...(awardIdFilter ? { id: awardIdFilter } : {}),
        sellerId: { in: validSellerIds },
        awardStatus: { in: ['ACCEPTED', 'AWARD_ACCEPTED'] }
      },
      include: { participation: true }
    });
    if (alreadyAccepted) {
      return { award: alreadyAccepted, status: 'AWARD_ACCEPTED', message: 'Award offer has already been accepted.' };
    }
    throw new ApiError(404, 'No pending award offer found for your account on this bid.', 'AWARD_NOT_FOUND');
  }

  const updatedAward = await db.$transaction(async (tx: any) => {
    const updated = await tx.procurementBidAward.update({
      where: { id: award.id },
      data: {
        awardStatus: 'ACCEPTED',
        awardedAt: now()
      }
    });

    await tx.procurementBidParticipation.update({
      where: { id: award.participationId },
      data: {
        finalStatus: 'AWARD_ACCEPTED'
      }
    });

    await tx.procurementBid.update({
      where: { id: bid.id },
      data: {
        status: 'AWARD_ACCEPTED',
        lifecycleStage: 'AWARD_ACCEPTED'
      }
    });

    return updated;
  });

  await procurementAudit(req, 'AWARD_ACCEPTED', 'ProcurementBidAward', award.id, updatedAward).catch(() => undefined);

  const sellerOrgName = await resolveSellerOrgName(award.sellerId || req.user?.id);

  await notificationService.notifyUser(bid.buyerId, {
    title: 'Award Offer Accepted',
    message: `${sellerOrgName} has accepted your contract award offer for "${bid.title}". You may now generate and issue the Purchase Order.`,
    type: 'award_accepted',
    redirectUrl: `/bids/${bid.id}`
  }).catch(() => undefined);

  try {
    const targetIds = [bid.id, bid.bidNumber, bid.sourceId, (bid.technicalPacket as any)?.sourceRequirementId].filter(Boolean);
    targetIds.forEach((tid: any) => {
      broadcastToProcurement(tid, {
        type: 'AWARD_ACCEPTED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        status: 'AWARD_ACCEPTED',
        sellerOrgId: award.sellerId,
        awardId: award.id,
        bidId: bid.id,
        bidNumber: bid.bidNumber,
        timestamp: new Date().toISOString()
      } as any);
      broadcastToProcurement(tid, {
        type: 'BID_ACCEPTED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        status: 'AWARD_ACCEPTED',
        sellerOrgId: award.sellerId,
        awardId: award.id,
        bidId: bid.id,
        bidNumber: bid.bidNumber,
        timestamp: new Date().toISOString()
      } as any);
      broadcastToProcurement(tid, {
        type: 'PROCUREMENT_UPDATED',
        requirementId: bid.sourceId || bid.id,
        procurementId: bid.id,
        status: 'AWARD_ACCEPTED',
        awardId: award.id,
        bidId: bid.id,
        bidNumber: bid.bidNumber,
        timestamp: new Date().toISOString()
      } as any);
    });
    if (bid.buyerId) {
      broadcastToUser(bid.buyerId, {
        type: 'BID_STATUS_CHANGED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        status: 'AWARD_ACCEPTED',
        awardId: award.id,
        bidId: bid.id,
        bidNumber: bid.bidNumber,
        timestamp: new Date().toISOString()
      });
    }
  } catch (bcErr) {
    logger.warn({ bcErr }, '[ACCEPT_AWARD] Failed to broadcast award acceptance to procurement');
  }

  return {
    award: updatedAward,
    bid,
    id: bid.id,
    bidId: bid.id,
    bidNumber: bid.bidNumber,
    sourceId: bid.sourceId,
    status: 'AWARD_ACCEPTED'
  };
};

export const declineAward = async (req: AuthRequest, bidId: string, body: any = {}) => {
  const reason = String(body?.reason || '').trim();
  if (!reason || reason.length < 5) {
    throw new ApiError(400, 'A valid reason (minimum 5 characters) is required to decline an award.', 'REASON_REQUIRED');
  }

  logger.info({ bidId, user: req.user?.id, reason }, '[DECLINE_AWARD] Seller declining award');
  const bid = await resolveBid(bidId, {});
  const sellerUserIds = await getSellerUserIdsForActor(req.user!);
  const sellerOrgIds = req.user?.organizationId ? [Number(req.user.organizationId)] : [];
  const validSellerIds = Array.from(new Set([...sellerUserIds, ...sellerOrgIds]));
  const awardIdFilter = body?.awardId ? Number(body.awardId) : undefined;

  const PENDING_AWARD_STATUSES = ['OFFERED', 'RECOMMENDED', 'ADMIN_APPROVED', 'AWARDED', 'AWARD_OFFERED', 'PENDING', 'PENDING_ACCEPTANCE', 'ISSUED'];

  let award = await db.procurementBidAward.findFirst({
    where: {
      bidId: bid.id,
      ...(awardIdFilter ? { id: awardIdFilter } : {}),
      sellerId: { in: validSellerIds },
      awardStatus: { in: PENDING_AWARD_STATUSES }
    },
    include: { participation: true }
  });

  if (!award && awardIdFilter) {
    const specificAward = await db.procurementBidAward.findFirst({
      where: { id: awardIdFilter, bidId: bid.id },
      include: { participation: true }
    });
    if (specificAward) {
      const isAuthorized =
        validSellerIds.includes(Number(specificAward.sellerId)) ||
        (specificAward.participation && validSellerIds.includes(Number(specificAward.participation.sellerId)));
      if (isAuthorized) {
        if (PENDING_AWARD_STATUSES.includes(specificAward.awardStatus)) {
          award = specificAward;
        } else if (specificAward.awardStatus === 'DECLINED') {
          return { award: specificAward, status: 'AWARD_DECLINED', message: 'Award offer has already been declined.' };
        }
      }
    }
  }

  if (!award) {
    const alreadyDeclined = await db.procurementBidAward.findFirst({
      where: {
        bidId: bid.id,
        ...(awardIdFilter ? { id: awardIdFilter } : {}),
        sellerId: { in: validSellerIds },
        awardStatus: 'DECLINED'
      },
      include: { participation: true }
    });
    if (alreadyDeclined) {
      return { award: alreadyDeclined, status: 'AWARD_DECLINED', message: 'Award offer has already been declined.' };
    }
    throw new ApiError(404, 'No pending award offer found for your account on this bid.', 'AWARD_NOT_FOUND');
  }

  const updatedAward = await db.$transaction(async (tx: any) => {
    const updated = await tx.procurementBidAward.update({
      where: { id: award.id },
      data: {
        awardStatus: 'DECLINED',
        remarks: reason
      }
    });

    await tx.procurementBidParticipation.update({
      where: { id: award.participationId },
      data: {
        finalStatus: 'AWARD_DECLINED',
        rejectionReason: reason
      }
    });

    await tx.procurementBid.update({
      where: { id: bid.id },
      data: {
        status: 'UNDER_EVALUATION',
        lifecycleStage: 'FINANCIAL_EVALUATION'
      }
    });

    return updated;
  });

  await procurementAudit(req, 'AWARD_DECLINED', 'ProcurementBidAward', award.id, { reason }).catch(() => undefined);

  const sellerOrgName = await resolveSellerOrgName(award.sellerId || req.user?.id);

  await notificationService.notifyUser(bid.buyerId, {
    title: 'Award Offer Declined',
    message: `${sellerOrgName} has declined the award offer for "${bid.title}". Reason: ${reason}. You may evaluate other qualified bidders.`,
    type: 'award_declined',
    redirectUrl: `/bids/${bid.id}`
  }).catch(() => undefined);

  try {
    const targetIds = [bid.id, bid.bidNumber, bid.sourceId, (bid.technicalPacket as any)?.sourceRequirementId].filter(Boolean);
    targetIds.forEach((tid: any) => {
      broadcastToProcurement(tid, {
        type: 'BID_REJECTED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        status: 'AWARD_DECLINED',
        sellerOrgId: award.sellerId,
        timestamp: new Date().toISOString()
      });
      broadcastToProcurement(tid, {
        type: 'PROCUREMENT_UPDATED',
        requirementId: bid.sourceId || bid.id,
        procurementId: bid.id,
        status: 'UNDER_EVALUATION',
        timestamp: new Date().toISOString()
      });
    });
    if (bid.buyerId) {
      broadcastToUser(bid.buyerId, {
        type: 'BID_STATUS_CHANGED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        status: 'AWARD_DECLINED',
        timestamp: new Date().toISOString()
      });
    }
  } catch (bcErr) {
    logger.warn({ bcErr }, '[DECLINE_AWARD] Failed to broadcast award decline to procurement');
  }

  return { award: updatedAward, status: 'AWARD_DECLINED' };
};

export const sendPriceMatchCounterOffer = async (req: AuthRequest, bidId: string, body: any) => {
  logger.info({ bidId, user: req.user?.id, body: maskSensitive(body) }, '[PRICE_MATCH_COUNTER_OFFER] Initiating price match offer');
  const bid = await resolveBid(bidId, {
    participations: {
      include: {
        seller: { include: { organization: true } }
      }
    }
  });
  assertBuyerOwner(req.user!, bid);

  const rawPartId = body.participationId;
  let partIdNum = typeof rawPartId === 'number' ? rawPartId : Number(String(rawPartId || '').replace(/^[^\d]+/, ''));
  const targetParticipation = (bid.participations || []).find((p: any) => p.id === partIdNum || p.sellerId === partIdNum || p.participationNumber === String(rawPartId).trim());

  if (!targetParticipation) {
    throw new ApiError(404, 'Selected supplier participation could not be found for this bid.', 'PARTICIPATION_NOT_FOUND');
  }

  // Find L1 price to validate or default target price
  const validPrices = (bid.participations || [])
    .filter((p: any) => p.technicalStatus === 'QUALIFIED' || !p.technicalStatus || p.financialStatus === 'EVALUATED')
    .map((p: any) => Number(p.totalAmount || p.quotedAmount || 0))
    .filter((amt: number) => amt > 0);
  const l1Price = validPrices.length ? Math.min(...validPrices) : Number(targetParticipation.totalAmount || targetParticipation.quotedAmount || 0);

  const targetPrice = body.priceMatchTargetPrice != null && Number(body.priceMatchTargetPrice) > 0
    ? Number(body.priceMatchTargetPrice)
    : l1Price;

  // Deadline calculation: configurable hours (default 48) or explicit ISO deadlineDate
  let deadline: Date;
  if (body.deadlineDate) {
    deadline = new Date(body.deadlineDate);
    if (isNaN(deadline.getTime()) || deadline <= new Date()) {
      throw new ApiError(400, 'Deadline date must be a valid future timestamp.', 'INVALID_DEADLINE');
    }
  } else {
    const hours = Number(body.deadlineHours) || 48;
    if (hours < 1 || hours > 720) {
      throw new ApiError(400, 'Deadline hours must be between 1 and 720 (up to 30 days).', 'INVALID_HOURS');
    }
    deadline = new Date(Date.now() + hours * 3600 * 1000);
  }

  const sellerCurrentPrice = Number(targetParticipation.totalAmount || targetParticipation.quotedAmount || 0);
  const justification = body.justificationReason?.trim() || body.counterOfferNotes?.trim() || null;

  const award = await db.$transaction(async (tx: any) => {
    let existingAward = await tx.procurementBidAward.findFirst({
      where: {
        bidId: bid.id,
        participationId: targetParticipation.id
      }
    });

    const awardData = {
      bidId: bid.id,
      participationId: targetParticipation.id,
      sellerId: targetParticipation.sellerId,
      awardedAmount: targetPrice,
      originalBidAmount: sellerCurrentPrice,
      isPriceMatched: true,
      priceMatchTargetPrice: targetPrice,
      counterOfferStatus: 'PENDING',
      counterOfferDeadline: deadline,
      counterOfferNotes: body.counterOfferNotes?.trim() || null,
      justificationReason: justification,
      awardStatus: 'OFFERED',
      awardedById: req.user!.id,
      awardedAt: now(),
      remarks: `Price match counter-offer at ₹${targetPrice.toLocaleString('en-IN')}`
    };

    let resultAward;
    if (!existingAward) {
      resultAward = await tx.procurementBidAward.create({ data: awardData });
    } else {
      resultAward = await tx.procurementBidAward.update({
        where: { id: existingAward.id },
        data: awardData
      });
    }

    // Set target seller participation to AWARD_OFFERED
    await tx.procurementBidParticipation.update({
      where: { id: targetParticipation.id },
      data: {
        finalStatus: 'AWARD_OFFERED'
      }
    });

    // Bid remains in evaluation with sub-status
    await tx.procurementBid.update({
      where: { id: bid.id },
      data: {
        status: 'AWARD_OFFERED',
        lifecycleStage: 'AWARD_RECOMMENDED'
      }
    });

    return resultAward;
  }, { maxWait: 10000, timeout: 20000 });

  await procurementAudit(req, 'PRICE_MATCH_COUNTER_OFFER_SENT', 'ProcurementBidAward', award.id, {
    sellerId: targetParticipation.sellerId,
    originalBidAmount: sellerCurrentPrice,
    priceMatchTargetPrice: targetPrice,
    deadline: deadline.toISOString(),
    justification
  }).catch(() => undefined);

  const formattedPrice = `₹${targetPrice.toLocaleString('en-IN')}`;
  const formattedDeadline = deadline.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  await notificationService.notifyUser(targetParticipation.sellerId, {
    title: '🎯 Price Match Counter-Offer Received',
    message: `Buyer has invited you to match the target price of ${formattedPrice} for "${bid.title}". Response deadline: ${formattedDeadline}.`,
    type: 'counter_offer_received',
    redirectUrl: `/bids/${bid.id}`
  }).catch(() => undefined);

  try {
    const targetIds = [bid.id, bid.bidNumber, bid.sourceId, (bid.technicalPacket as any)?.sourceRequirementId].filter(Boolean);
    targetIds.forEach((tid: any) => {
      broadcastToProcurement(tid, {
        type: 'PROCUREMENT_AWARDED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        status: 'AWARD_OFFERED',
        sellerOrgId: targetParticipation.sellerOrgId,
        sellerUserId: targetParticipation.sellerId,
        awardedAmount: targetPrice,
        timestamp: new Date().toISOString()
      });
      broadcastToProcurement(tid, {
        type: 'PROCUREMENT_UPDATED',
        requirementId: bid.sourceId || bid.id,
        procurementId: bid.id,
        status: 'AWARD_OFFERED',
        timestamp: new Date().toISOString()
      });
    });
    if (targetParticipation.sellerId) {
      broadcastToUser(targetParticipation.sellerId, {
        type: 'AWARD_RECEIVED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        awardedAmount: targetPrice,
        timestamp: new Date().toISOString()
      });
    }
  } catch (bcErr) {
    logger.warn({ bcErr }, '[sendPriceMatchCounterOffer] Failed to broadcast price match offer');
  }

  return {
    award,
    status: 'COUNTER_OFFER_PENDING',
    targetPrice,
    deadline: deadline.toISOString(),
    message: `Price match counter-offer sent to ${targetParticipation.seller?.name || 'vendor'} with deadline ${formattedDeadline}.`
  };
};

export const acceptPriceMatchCounterOffer = async (req: AuthRequest, bidId: string) => {
  logger.info({ bidId, user: req.user?.id }, '[ACCEPT_COUNTER_OFFER] Seller accepting price match offer');
  const bid = await resolveBid(bidId, {});
  const sellerUserIds = await getSellerUserIdsForActor(req.user!);
  const sellerOrgIds = req.user?.organizationId ? [Number(req.user.organizationId)] : [];
  const validSellerIds = Array.from(new Set([...sellerUserIds, ...sellerOrgIds]));
  const awardIdFilter = req.body?.awardId ? Number(req.body.awardId) : undefined;

  let award = await db.procurementBidAward.findFirst({
    where: {
      bidId: bid.id,
      ...(awardIdFilter ? { id: awardIdFilter } : {}),
      sellerId: { in: validSellerIds },
      counterOfferStatus: 'PENDING'
    },
    include: { participation: true }
  });

  if (!award && awardIdFilter) {
    const specificAward = await db.procurementBidAward.findFirst({
      where: { id: awardIdFilter, bidId: bid.id },
      include: { participation: true }
    });
    if (specificAward) {
      const isAuthorized =
        validSellerIds.includes(Number(specificAward.sellerId)) ||
        (specificAward.participation && validSellerIds.includes(Number(specificAward.participation.sellerId)));
      if (isAuthorized) {
        if (specificAward.counterOfferStatus === 'PENDING') {
          award = specificAward;
        } else if (specificAward.counterOfferStatus === 'ACCEPTED') {
          const acceptedAmount = specificAward.priceMatchTargetPrice ? Number(specificAward.priceMatchTargetPrice) : Number(specificAward.awardedAmount);
          return { award: specificAward, status: 'AWARD_ACCEPTED', acceptedAmount, message: 'Price match counter-offer has already been accepted.' };
        }
      }
    }
  }

  // Idempotent recovery: If counter offer is already accepted for this bid and seller, return success rather than 404
  if (!award) {
    const alreadyAccepted = await db.procurementBidAward.findFirst({
      where: {
        bidId: bid.id,
        ...(awardIdFilter ? { id: awardIdFilter } : {}),
        sellerId: { in: validSellerIds },
        counterOfferStatus: 'ACCEPTED'
      },
      include: { participation: true }
    });
    if (alreadyAccepted) {
      const acceptedAmount = alreadyAccepted.priceMatchTargetPrice ? Number(alreadyAccepted.priceMatchTargetPrice) : Number(alreadyAccepted.awardedAmount);
      return { award: alreadyAccepted, status: 'AWARD_ACCEPTED', acceptedAmount, message: 'Price match counter-offer has already been accepted.' };
    }
    throw new ApiError(404, 'No pending price-match counter-offer found for your account on this bid.', 'COUNTER_OFFER_NOT_FOUND');
  }

  // Check deadline expiry
  if (award.counterOfferDeadline && new Date() > new Date(award.counterOfferDeadline)) {
    await db.procurementBidAward.update({
      where: { id: award.id },
      data: { counterOfferStatus: 'EXPIRED' }
    }).catch(() => undefined);
    throw new ApiError(400, 'The response deadline for this price-match counter-offer has expired.', 'COUNTER_OFFER_EXPIRED');
  }

  const acceptedAmount = award.priceMatchTargetPrice ? Number(award.priceMatchTargetPrice) : Number(award.awardedAmount);

  const updated = await db.$transaction(async (tx: any) => {
    const updatedAward = await tx.procurementBidAward.update({
      where: { id: award.id },
      data: {
        counterOfferStatus: 'ACCEPTED',
        awardStatus: 'ACCEPTED',
        awardedAmount: acceptedAmount,
        acceptedAt: now()
      }
    });

    await tx.procurementBidParticipation.update({
      where: { id: award.participationId },
      data: {
        totalAmount: acceptedAmount,
        quotedAmount: acceptedAmount,
        finalStatus: 'AWARD_ACCEPTED'
      }
    });

    await tx.procurementBid.update({
      where: { id: bid.id },
      data: {
        status: 'AWARD_ACCEPTED'
      }
    });

    return updatedAward;
  }, { maxWait: 10000, timeout: 20000 });

  await procurementAudit(req, 'PRICE_MATCH_COUNTER_OFFER_ACCEPTED', 'ProcurementBidAward', award.id, { acceptedAmount }).catch(() => undefined);

  const sellerOrgName = await resolveSellerOrgName(award.sellerId || req.user?.id);

  await notificationService.notifyUser(bid.buyerId, {
    title: '🎯 Price Match Accepted by Supplier',
    message: `${sellerOrgName} has accepted your price-match counter-offer at ₹${acceptedAmount.toLocaleString('en-IN')} for "${bid.title}". You may now issue the Purchase Order.`,
    type: 'counter_offer_accepted',
    redirectUrl: `/bids/${bid.id}`
  }).catch(() => undefined);

  try {
    const targetIds = [bid.id, bid.bidNumber, bid.sourceId, (bid.technicalPacket as any)?.sourceRequirementId].filter(Boolean);
    targetIds.forEach((tid: any) => {
      broadcastToProcurement(tid, {
        type: 'BID_ACCEPTED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        status: 'AWARD_ACCEPTED',
        sellerOrgId: award.sellerId,
        timestamp: new Date().toISOString()
      });
      broadcastToProcurement(tid, {
        type: 'PROCUREMENT_UPDATED',
        requirementId: bid.sourceId || bid.id,
        procurementId: bid.id,
        status: 'AWARD_ACCEPTED',
        timestamp: new Date().toISOString()
      });
    });
    if (bid.buyerId) {
      broadcastToUser(bid.buyerId, {
        type: 'BID_STATUS_CHANGED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        status: 'AWARD_ACCEPTED',
        timestamp: new Date().toISOString()
      });
    }
  } catch (bcErr) {
    logger.warn({ bcErr }, '[acceptPriceMatchCounterOffer] Failed to broadcast accept');
  }

  return { award: updated, status: 'AWARD_ACCEPTED', acceptedAmount };
};

export const declinePriceMatchCounterOffer = async (req: AuthRequest, bidId: string, body: any = {}) => {
  const reason = String(body?.reason || '').trim();
  if (!reason || reason.length < 5) {
    throw new ApiError(400, 'A valid reason (minimum 5 characters) is required to decline.', 'REASON_REQUIRED');
  }

  logger.info({ bidId, user: req.user?.id, reason }, '[DECLINE_COUNTER_OFFER] Seller declining price match offer');
  const bid = await resolveBid(bidId, {});
  const sellerUserIds = await getSellerUserIdsForActor(req.user!);
  const sellerOrgIds = req.user?.organizationId ? [Number(req.user.organizationId)] : [];
  const validSellerIds = Array.from(new Set([...sellerUserIds, ...sellerOrgIds]));
  const awardIdFilter = body?.awardId ? Number(body.awardId) : undefined;

  let award = await db.procurementBidAward.findFirst({
    where: {
      bidId: bid.id,
      ...(awardIdFilter ? { id: awardIdFilter } : {}),
      sellerId: { in: validSellerIds },
      counterOfferStatus: 'PENDING'
    },
    include: { participation: true }
  });

  if (!award && awardIdFilter) {
    const specificAward = await db.procurementBidAward.findFirst({
      where: { id: awardIdFilter, bidId: bid.id },
      include: { participation: true }
    });
    if (specificAward) {
      const isAuthorized =
        validSellerIds.includes(Number(specificAward.sellerId)) ||
        (specificAward.participation && validSellerIds.includes(Number(specificAward.participation.sellerId)));
      if (isAuthorized) {
        if (specificAward.counterOfferStatus === 'PENDING') {
          award = specificAward;
        } else if (specificAward.counterOfferStatus === 'DECLINED') {
          return { award: specificAward, status: 'AWARD_DECLINED', message: 'Price match counter-offer has already been declined.' };
        }
      }
    }
  }

  if (!award) {
    const alreadyDeclined = await db.procurementBidAward.findFirst({
      where: {
        bidId: bid.id,
        ...(awardIdFilter ? { id: awardIdFilter } : {}),
        sellerId: { in: validSellerIds },
        counterOfferStatus: 'DECLINED'
      },
      include: { participation: true }
    });
    if (alreadyDeclined) {
      return { award: alreadyDeclined, status: 'AWARD_DECLINED', message: 'Price match counter-offer has already been declined.' };
    }
    throw new ApiError(404, 'No pending price-match counter-offer found for your account on this bid.', 'COUNTER_OFFER_NOT_FOUND');
  }

  const updated = await db.$transaction(async (tx: any) => {
    const updatedAward = await tx.procurementBidAward.update({
      where: { id: award.id },
      data: {
        counterOfferStatus: 'DECLINED',
        awardStatus: 'DECLINED',
        declinedAt: now(),
        declinedReason: reason,
        remarks: reason
      }
    });

    await tx.procurementBidParticipation.update({
      where: { id: award.participationId },
      data: {
        finalStatus: 'AWARD_DECLINED',
        rejectionReason: reason
      }
    });

    // Reset bid back to evaluation so buyer can award L1 or another vendor
    await tx.procurementBid.update({
      where: { id: bid.id },
      data: {
        status: 'UNDER_EVALUATION',
        lifecycleStage: 'FINANCIAL_EVALUATION'
      }
    });

    return updatedAward;
  }, { maxWait: 10000, timeout: 20000 });

  await procurementAudit(req, 'PRICE_MATCH_COUNTER_OFFER_DECLINED', 'ProcurementBidAward', award.id, { reason }).catch(() => undefined);

  const sellerOrgName = await resolveSellerOrgName(award.sellerId || req.user?.id);

  await notificationService.notifyUser(bid.buyerId, {
    title: 'Price Match Declined by Supplier',
    message: `${sellerOrgName} has declined the price-match counter-offer for "${bid.title}". Reason: ${reason}. You can now award L1 or negotiate with another vendor.`,
    type: 'counter_offer_declined',
    redirectUrl: `/bids/${bid.id}`
  }).catch(() => undefined);

  try {
    const targetIds = [bid.id, bid.bidNumber, bid.sourceId, (bid.technicalPacket as any)?.sourceRequirementId].filter(Boolean);
    targetIds.forEach((tid: any) => {
      broadcastToProcurement(tid, {
        type: 'BID_REJECTED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        status: 'AWARD_DECLINED',
        sellerOrgId: award.sellerId,
        timestamp: new Date().toISOString()
      });
      broadcastToProcurement(tid, {
        type: 'PROCUREMENT_UPDATED',
        requirementId: bid.sourceId || bid.id,
        procurementId: bid.id,
        status: 'UNDER_EVALUATION',
        timestamp: new Date().toISOString()
      });
    });
    if (bid.buyerId) {
      broadcastToUser(bid.buyerId, {
        type: 'BID_STATUS_CHANGED',
        procurementId: bid.id,
        requirementId: bid.sourceId || bid.id,
        status: 'AWARD_DECLINED',
        timestamp: new Date().toISOString()
      });
    }
  } catch (bcErr) {
    logger.warn({ bcErr }, '[declinePriceMatchCounterOffer] Failed to broadcast decline');
  }

  return { award: updated, status: 'AWARD_DECLINED', reason };
};

export const generatePOForBid = async (req: AuthRequest, bidId: string, body: any = {}) => {
  logger.info({ bidId, user: req.user?.id }, '[GENERATE_PO] Generating Purchase Order');
  const bid = await resolveBid(bidId, {});
  const isBuyerOrAdmin =
    req.user?.role === 'admin' ||
    req.user?.role === 'master_admin' ||
    bid.buyerId === req.user!.id ||
    (Boolean(req.user?.organizationId) && bid.buyerOrganizationId === Number(req.user!.organizationId));

  if (!isBuyerOrAdmin) {
    throw new ApiError(
      403,
      'Only the buyer or administrators can generate and issue Purchase Orders. Sellers cannot generate Purchase Orders.',
      'BUYER_ONLY_ACTION'
    );
  }

  // Handle Reverse Auction PO generation if invoked for an auction entity
  if (bid.sourceModel === 'AUCTION' || String(bidId).toUpperCase().startsWith('RA-')) {
    const rawAuctionId = bid.auctionId || bid.sourceId || Number(String(bidId).replace(/^RA-/i, ''));
    const auction = await db.auction.findFirst({
      where: {
        OR: [
          ...(Number.isFinite(rawAuctionId) && rawAuctionId > 0 ? [{ id: rawAuctionId }] : []),
          { auctionCode: String(bidId) },
          { referenceNo: String(bidId) }
        ]
      }
    });

    if (auction) {
      const winner = body?.awardId
        ? await db.auctionParticipant.findFirst({ where: { id: Number(body.awardId), auctionId: auction.id } })
        : (await db.auctionParticipant.findFirst({ where: { auctionId: auction.id, currentRank: 1 } }) ||
           await db.auctionParticipant.findFirst({ where: { auctionId: auction.id } }));

      if (!winner) {
        throw new ApiError(400, 'No qualifying participant found for this auction', 'NO_WINNER_FOUND');
      }

      const winningAmount = winner.lastBidAmount || auction.currentLowestAmount || auction.startPrice || 0;
      let sellerUserId = winner.sellerUserId;
      if (!sellerUserId && winner.sellerOrgId) {
        const sellerUser = await db.user.findFirst({ where: { organizationId: winner.sellerOrgId } });
        if (sellerUser) sellerUserId = sellerUser.id;
      }
      if (!sellerUserId) sellerUserId = winner.sellerOrgId || 1;

      const buyerId = req.user?.id || auction.createdByUserId;
      const poNumber = `PO-RA-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;

      let po = await db.purchaseOrder.findFirst({
        where: {
          OR: [
            { title: { contains: `Reverse Auction ${auction.auctionCode || auction.id}` } },
            { notes: { contains: `auctionId:${auction.id}` } }
          ]
        },
        include: { invoices: true, grns: true }
      });

      if (!po) {
        po = await db.purchaseOrder.create({
          data: {
            poNumber,
            buyerId,
            sellerId: sellerUserId,
            title: `Purchase Order - Reverse Auction ${auction.auctionCode || auction.id} (${auction.title || 'Official Award'})`,
            amount: winningAmount,
            status: 'pending_acceptance',
            poStatus: 'ISSUED',
            notes: `[Reverse Auction Sourcing] Generated from auctionId:${auction.id}. Participant #${winner.id}.`,
            terms: 'Standard Government E-Marketplace Payment Terms.'
          },
          include: { invoices: true, grns: true }
        });

        await db.auction.update({
          where: { id: auction.id },
          data: {
            winnerSellerId: sellerUserId,
            finalizedAt: new Date(),
            status: 'AWARDED',
            statusEnum: 'AWARDED'
          }
        }).catch(() => null);
      }

      return {
        purchaseOrder: po,
        reused: false,
        alreadyIssued: false
      };
    }
  }

  const isMasterOrAdmin = req.user?.role === 'admin' || req.user?.role === 'master_admin';
  const allowedStatuses = isMasterOrAdmin 
    ? ['ACCEPTED', 'ADMIN_APPROVED', 'OFFERED', 'RECOMMENDED'] 
    : ['ACCEPTED', 'ADMIN_APPROVED'];

  let award = body?.awardId
    ? await db.procurementBidAward.findFirst({
        where: {
          bidId: bid.id,
          id: Number(body.awardId),
          awardStatus: { in: allowedStatuses }
        },
        include: { participation: true },
        orderBy: { updatedAt: 'desc' }
      })
    : null;

  if (!award) {
    award = await db.procurementBidAward.findFirst({
      where: {
        bidId: bid.id,
        awardStatus: { in: allowedStatuses }
      },
      include: { participation: true },
      orderBy: { updatedAt: 'desc' }
    });
  }

  if (!award) {
    const pendingOffer = await db.procurementBidAward.findFirst({
      where: { bidId: bid.id, awardStatus: 'OFFERED' }
    });
    if (pendingOffer) {
      throw new ApiError(
        400,
        'Cannot generate Purchase Order: The awarded supplier has not yet accepted the award offer. Official PO generation will unlock once the supplier confirms formal acceptance.',
        'SUPPLIER_ACCEPTANCE_PENDING'
      );
    }
    throw new ApiError(400, 'Cannot generate Purchase Order: No eligible accepted award found for this bid.', 'AWARD_NOT_FOUND');
  }

  const po = await createOrReuseProcurementPOForAward(req, award, bid);

  if (po.reused && (po.purchaseOrder.poStatus === 'ISSUED' || po.purchaseOrder.status === 'issued' || po.purchaseOrder.status === 'pending_acceptance' || po.purchaseOrder.status === 'accepted')) {
    logger.info({ poId: po.purchaseOrder.id, poNumber: po.purchaseOrder.poNumber }, '[GENERATE_PO] Purchase Order already issued for this award');
    return {
      purchaseOrder: po.purchaseOrder,
      reused: true,
      alreadyIssued: true,
      award
    };
  }

  const shouldIssueImmediately = body?.issueImmediately === true || body?.asDraft === false;

  if (shouldIssueImmediately) {
    const updatedPo = await db.purchaseOrder.update({
      where: { id: po.purchaseOrder.id },
      data: {
        status: 'pending_acceptance',
        poStatus: 'ISSUED',
        isDraft: false,
        issuedAt: new Date()
      }
    });

    await db.procurementBid.update({
      where: { id: bid.id },
      data: {
        status: 'PO_GENERATED'
      }
    });

    await notificationService.notifyUser(award.sellerId, {
      title: 'Purchase Order Issued',
      message: `Purchase Order #${po.purchaseOrder.poNumber} has been generated for "${bid.title}". Please accept the PO to commit to fulfillment.`,
      type: 'purchase_order',
      redirectUrl: `/seller/orders?orderId=${po.purchaseOrder.id}`
    }).catch(() => undefined);

    notifySellerNewPurchaseOrder(po.purchaseOrder.id).catch(() => undefined);

    try {
      broadcastToProcurement(bid.id, {
        type: 'PROCUREMENT_UPDATED',
        requirementId: bid.id,
        procurementId: bid.id,
        status: 'PO_GENERATED',
        timestamp: new Date().toISOString()
      });
    } catch (bcErr) {
      logger.warn({ bcErr }, '[GENERATE_PO] Failed to broadcast PO generation to procurement');
    }

    return {
      purchaseOrder: updatedPo,
      reused: po.reused,
      award
    };
  } else {
    // Generate as DRAFT so buyer can review, edit details, and issue cleanly
    const updatedPo = await db.purchaseOrder.update({
      where: { id: po.purchaseOrder.id },
      data: {
        status: 'draft',
        poStatus: 'DRAFT',
        isDraft: true
      }
    });

    return {
      purchaseOrder: updatedPo,
      reused: po.reused,
      isDraft: true,
      award
    };
  }
};

export const approveFinalAward = async (req: AuthRequest, bidId: string, body: any) => {
  const bid = await resolveBid(bidId, {});
  if (!['AWARD_RECOMMENDED', 'AWARD_OFFERED'].includes(bid.status)) throw new ApiError(400, 'Final award approval requires an award recommendation first.', 'INVALID_STATUS_TRANSITION');
  const award = await db.procurementBidAward.findFirst({
    where: { bidId: bid.id, ...(body.awardId ? { id: Number(body.awardId) } : {}) },
    orderBy: { createdAt: 'desc' }
  });
  if (!award) throw new ApiError(404, 'Award recommendation not found', 'AWARD_NOT_FOUND');
  const updated = await db.$transaction(async (tx: any) => {
    const approved = await tx.procurementBidAward.update({
      where: { id: award.id },
      data: { awardStatus: 'ADMIN_APPROVED', awardedById: req.user!.id, awardedAt: now(), remarks: body.remarks || award.remarks }
    });
    // NOTE: Standby bidders remain active/standby and are NOT transitioned to NOT_SELECTED until seller accepts the PO!
    await tx.procurementBidParticipation.update({ where: { id: award.participationId }, data: { finalStatus: 'AWARDED' } });
    await tx.procurementBid.update({ where: { id: bid.id }, data: { status: 'AWARD_RECOMMENDED', lifecycleStage: 'AWARD_RECOMMENDED' } });
    return approved;
  });
  await procurementAudit(req, 'FINAL_AWARD_APPROVED', 'ProcurementBidAward', updated.id, updated);
  // NOTE: In the simplified portal, NO auto PO is generated here. The seller must accept the award, then PO is generated and accepted.
  return { award: updated, status: 'ADMIN_APPROVED', message: 'Award approved. Awaiting seller acceptance.' };
};

export const getAverageRatingsForSellers = async (sellerIds: number[]) => {
  if (!sellerIds.length) return {};
  const ratings = await db.supplierRating.findMany({
    where: { sellerId: { in: sellerIds } }
  });

  const averages: Record<number, {
    rating: number;
    qualityScore: number;
    deliveryScore: number;
    communicationScore: number;
    documentationScore: number;
    count: number;
  }> = {};

  for (const sellerId of sellerIds) {
    const sellerRatings = ratings.filter((r: any) => r.sellerId === sellerId);
    if (!sellerRatings.length) {
      averages[sellerId] = { rating: 0, qualityScore: 0, deliveryScore: 0, communicationScore: 0, documentationScore: 0, count: 0 };
      continue;
    }

    const sum = (field: string) => sellerRatings.reduce((acc: number, curr: any) => acc + (curr[field] || 0), 0);
    const validCount = (field: string) => sellerRatings.filter((r: any) => r[field] != null).length;

    const ratingCount = validCount('rating');
    const qualityCount = validCount('qualityScore');
    const deliveryCount = validCount('deliveryScore');
    const commCount = validCount('communicationScore');
    const docCount = validCount('documentationScore');

    averages[sellerId] = {
      rating: ratingCount ? Number((sum('rating') / ratingCount).toFixed(1)) : 0,
      qualityScore: qualityCount ? Number((sum('qualityScore') / qualityCount).toFixed(1)) : 0,
      deliveryScore: deliveryCount ? Number((sum('deliveryScore') / deliveryCount).toFixed(1)) : 0,
      communicationScore: commCount ? Number((sum('communicationScore') / commCount).toFixed(1)) : 0,
      documentationScore: docCount ? Number((sum('documentationScore') / docCount).toFixed(1)) : 0,
      count: sellerRatings.length
    };
  }

  return averages;
};

export const getProcurementTimeline = async (bidId: number) => {
  const bid = await db.procurementBid.findUnique({
    where: { id: bidId },
    include: {
      buyer: { select: { name: true, role: true } },
      awards: {
        include: {
          seller: { select: { name: true, role: true } }
        }
      }
    }
  });
  if (!bid) return [];

  const logs = await db.procurementAuditLog.findMany({
    where: { entityType: 'ProcurementBid', entityId: String(bidId) },
    include: { user: { select: { name: true, role: true } } },
    orderBy: { createdAt: 'asc' }
  });

  const awardIds = bid.awards.map((a: any) => a.id);
  const pos = awardIds.length ? await db.purchaseOrder.findMany({
    where: { sourceType: 'procurement_bid_award', sourceId: { in: awardIds } },
    include: {
      buyer: { select: { name: true, role: true } },
      seller: { select: { name: true, role: true } },
      grns: { include: { approvals: true } },
      invoices: true,
      payments: true,
      deliveryTrackings: { include: { events: true } }
    }
  }) : [];

  const po = pos[0];

  const findLog = (actions: string[]) => logs.find((l: any) => actions.includes(l.action));

  const draftLog = findLog(['BID_CREATED']);
  const draftTime = draftLog ? draftLog.createdAt : bid.createdAt;
  const draftUser = draftLog?.user || bid.buyer;

  const pubLog = findLog(['BID_PUBLISHED', 'BID_APPROVED', 'BID_SUBMITTED_FOR_APPROVAL']);
  const pubTime = pubLog ? pubLog.createdAt : (bid.status !== 'DRAFT' && bid.status !== 'PENDING_ADMIN_APPROVAL' ? bid.createdAt : null);
  const pubUser = pubLog?.user || (pubTime ? bid.buyer : null);

  const openLog = findLog(['BID_OPENED', 'BID_PUBLISHED']);
  const openTime = openLog ? openLog.createdAt : (['OPEN', 'CLOSED', 'EXPIRED', 'TECHNICAL_EVALUATION', 'FINANCIAL_EVALUATION', 'AWARDED', 'PO_GENERATED', 'IN_PROGRESS', 'DELIVERED', 'GRN_COMPLETED', 'INVOICE_SUBMITTED', 'PAYMENT_COMPLETED', 'CLOSED'].includes(bid.status) ? bid.startDate : null);
  const openUser = openLog?.user || (openTime ? { name: 'System', role: 'system' } : null);

  const evalLog = findLog(['TECHNICAL_EVALUATION_STARTED', 'TECHNICAL_EVALUATION_COMPLETED', 'FINANCIAL_EVALUATION_OPENED', 'L1_GENERATED']);
  const evalTime = evalLog ? evalLog.createdAt : (['TECHNICAL_EVALUATION', 'FINANCIAL_EVALUATION', 'AWARDED', 'PO_GENERATED', 'IN_PROGRESS', 'DELIVERED', 'GRN_COMPLETED', 'INVOICE_SUBMITTED', 'PAYMENT_COMPLETED', 'CLOSED'].includes(bid.status) ? bid.updatedAt : null);
  const evalUser = evalLog?.user || (evalTime ? bid.buyer : null);

  const awardLog = findLog(['FINAL_AWARD_APPROVED', 'BID_AWARDED']);
  const awardTime = awardLog ? awardLog.createdAt : (bid.awards[0]?.awardedAt || null);
  const awardUser = awardLog?.user || (awardTime ? bid.buyer : null);

  const poTime = po ? po.createdAt : null;
  const poUser = po ? po.buyer : null;

  const activeTracking = po?.deliveryTrackings?.[0];
  const deliveryCompletedEvent = activeTracking?.events?.find((e: any) => e.status === 'DELIVERED' || e.status === 'COMPLETED');
  const deliveryTime = deliveryCompletedEvent ? deliveryCompletedEvent.createdAt : (activeTracking ? activeTracking.updatedAt : null);
  const deliveryUser = activeTracking ? po.seller : null;

  const grn = po?.grns?.[0];
  const grnTime = grn && grn.status === 'APPROVED' ? grn.updatedAt : null;
  const grnUser = grn ? po.buyer : null;

  const invoice = po?.invoices?.[0];
  const invoiceTime = invoice && invoice.status === 'APPROVED' ? invoice.updatedAt : null;
  const invoiceUser = invoice ? po.seller : null;

  const payment = po?.payments?.[0];
  const paymentTime = payment && (payment.status === 'SUCCESS' || payment.status === 'SETTLED') ? payment.updatedAt : null;
  const paymentUser = payment ? { name: 'Finance System', role: 'finance' } : null;

  const completedTime = bid.status === 'CLOSED' ? bid.updatedAt : null;
  const completedUser = completedTime ? bid.buyer : null;

  const stages = [
    { name: 'Draft', label: 'Draft Created', time: draftTime, user: draftUser, status: 'completed' },
    { name: 'Published', label: 'Published & Approved', time: pubTime, user: pubUser, status: pubTime ? 'completed' : 'pending' },
    { name: 'Open for Bids', label: 'Bidding Open', time: openTime, user: openUser, status: openTime ? 'completed' : 'pending' },
    { name: 'Evaluation', label: 'Under Evaluation', time: evalTime, user: evalUser, status: evalTime ? 'completed' : 'pending' },
    { name: 'Award', label: 'Awarded to Seller', time: awardTime, user: awardUser, status: awardTime ? 'completed' : 'pending' },
    { name: 'PO', label: 'PO Generated', time: poTime, user: poUser, status: poTime ? 'completed' : 'pending' },
    { name: 'Delivery', label: 'Goods Delivered', time: deliveryTime, user: deliveryUser, status: deliveryTime ? 'completed' : (poTime ? 'current' : 'pending') },
    { name: 'GRN', label: 'GRN Approved', time: grnTime, user: grnUser, status: grnTime ? 'completed' : (deliveryTime ? 'current' : 'pending') },
    { name: 'Invoice', label: 'Invoice Approved', time: invoiceTime, user: invoiceUser, status: invoiceTime ? 'completed' : (grnTime ? 'current' : 'pending') },
    { name: 'Payment', label: 'Payment Completed', time: paymentTime, user: paymentUser, status: paymentTime ? 'completed' : (invoiceTime ? 'current' : 'pending') },
    { name: 'Completed', label: 'Closed', time: completedTime, user: completedUser, status: completedTime ? 'completed' : (paymentTime ? 'current' : 'pending') }
  ];

  let foundCurrent = false;
  for (let i = stages.length - 1; i >= 0; i--) {
    if (stages[i].time) {
      stages[i].status = 'completed';
      if (!foundCurrent && i < stages.length - 1) {
        stages[i+1].status = 'current';
        foundCurrent = true;
      }
    } else {
      stages[i].status = 'pending';
    }
  }

  if (stages[0].status === 'pending') stages[0].status = 'current';

  return stages;
};

// ════════════════════════════════════════════════════════════════════════════
//  EDGE CASE 2: Reverse Auction Anti-Sniping Auto-Extension
//  If a bid is placed within the final 5 minutes of a REVERSE_AUCTION,
//  auto-extend the end time by 5 minutes (max 6 extensions = 30 min total).
// ════════════════════════════════════════════════════════════════════════════
const ANTI_SNIPE_WINDOW_MS = 5 * 60 * 1000;   // 5 minutes
const ANTI_SNIPE_EXTENSION_MS = 5 * 60 * 1000; // 5 minutes
const MAX_EXTENSIONS = 6;

export const autoExtendAuctionIfNeeded = async (bid: any) => {
  const bidType = String(bid.procurementType || bid.bidType || '').toUpperCase();
  if (bidType !== 'REVERSE_AUCTION') return null;
  if (!bid.endDate) return null;

  const endTime = new Date(bid.endDate).getTime();
  const currentTime = Date.now();
  const timeRemaining = endTime - currentTime;

  if (timeRemaining > ANTI_SNIPE_WINDOW_MS || timeRemaining <= 0) return null;

  const pkt = (bid.technicalPacket && typeof bid.technicalPacket === 'object') ? bid.technicalPacket as Record<string, any> : {};
  const meta = (pkt.metadata && typeof pkt.metadata === 'object') ? pkt.metadata : {};
  const extensionCount = Number(meta.extensionCount || 0);

  if (extensionCount >= MAX_EXTENSIONS) {
    logger.info({ bidId: bid.id, extensionCount }, '[ANTI_SNIPE] Max extensions reached');
    return null;
  }

  const newEndDate = new Date(endTime + ANTI_SNIPE_EXTENSION_MS);
  const updatedMeta = { ...meta, extensionCount: extensionCount + 1, lastExtendedAt: new Date().toISOString() };
  const updatedPkt = { ...pkt, metadata: updatedMeta };

  const updated = await db.procurementBid.update({
    where: { id: bid.id },
    data: { endDate: newEndDate, technicalPacket: updatedPkt }
  });

  logger.info({ bidId: bid.id, newEndDate, extensionCount: extensionCount + 1 }, '[ANTI_SNIPE] Auction auto-extended');
  return updated;
};

// ════════════════════════════════════════════════════════════════════════════
//  EDGE CASE 3: Landed Cost L1 Evaluation
//  Computes total landed cost = quotedAmount + GST + freight + loading
//  and sorts by landed cost instead of raw totalAmount.
// ════════════════════════════════════════════════════════════════════════════
export const computeLandedCost = (participation: any): number => {
  const quoted = Number(participation.quotedAmount || participation.totalAmount || 0);
  const gstPct = Number(participation.gstPercentage || 0);
  const ack = (participation.acknowledgement && typeof participation.acknowledgement === 'object')
    ? participation.acknowledgement as Record<string, any>
    : {};
  const freight = Number(ack.freight || ack.freightCharges || ack.deliveryCharges || 0);
  const loading = Number(ack.loadingCharges || ack.handlingCharges || 0);
  const gstAmount = quoted * gstPct / 100;
  return quoted + gstAmount + freight + loading;
};

export const openFinancialEvaluationLandedCost = async (req: AuthRequest, bidId: string, body: any = {}) => {
  const bid = await resolveBid(bidId, { participations: true });
  assertBuyerOwner(req.user!, bid);
  if (!['TECHNICAL_EVALUATION_COMPLETED'].includes(bid.status)) {
    throw new ApiError(400, 'Technical evaluation must be completed before opening financial bids.', 'TECHNICAL_EVALUATION_PENDING');
  }
  assertBidTransition(bid.status, 'FINANCIAL_EVALUATION');

  const ranked = await db.$transaction(async (tx: any) => {
    const qualified = await tx.procurementBidParticipation.findMany({
      where: { bidId: bid.id, technicalStatus: 'QUALIFIED', submissionStatus: 'SUBMITTED', totalAmount: { not: null } }
    });
    if (!qualified.length) throw new ApiError(400, 'No technically qualified financial quotes are available.', 'FINANCIAL_NOT_OPENED');

    // Dynamic Minimum Sourcing Bids & Single Bidder Protocol
    await evaluateBidCountThresholds(tx, bid, qualified.length, body);

    // Compute landed cost and sort
    const withLandedCost = qualified.map((row: any) => ({
      ...row,
      landedCost: computeLandedCost(row)
    }));
    withLandedCost.sort((a: any, b: any) => a.landedCost - b.landedCost);

    for (const [index, row] of withLandedCost.entries()) {
      const rank = index + 1;
      const finalStatus = rankToFinalStatus(rank);
      await tx.procurementBidParticipation.update({
        where: { id: row.id },
        data: { financialStatus: 'EVALUATED', finalStatus, rank }
      });
      await tx.procurementBidEvaluation.create({
        data: {
          bidId: bid.id,
          participationId: row.id,
          sellerId: row.sellerId,
          evaluatorId: req.user!.id,
          evaluationType: 'FINANCIAL',
          status: 'OPENED',
          remarks: `Ranked ${finalStatus} (Landed Cost: ₹${row.landedCost.toLocaleString('en-IN')})`,
          score: null
        }
      });
    }
    await tx.procurementBid.update({
      where: { id: bid.id },
      data: { status: 'L1_GENERATED', lifecycleStage: 'L1_GENERATED', financialOpeningDate: now() }
    });
    await tx.procurementBidParticipation.updateMany({
      where: { bidId: bid.id, technicalStatus: { not: 'QUALIFIED' } },
      data: { financialStatus: 'LOCKED' }
    });
    return withLandedCost.map((row: any, index: number) => ({
      ...row,
      rank: index + 1,
      finalStatus: rankToFinalStatus(index + 1)
    }));
  });
  await procurementAudit(req, 'FINANCIAL_EVALUATION_OPENED', 'ProcurementBid', bid.id, { qualifiedCount: ranked.length, method: 'LANDED_COST' });
  await procurementAudit(req, 'L1_GENERATED', 'ProcurementBid', bid.id, ranked.map((r: any) => ({ id: r.id, rank: r.rank, landedCost: r.landedCost })));
  return ranked;
};

// ════════════════════════════════════════════════════════════════════════════
//  SIMPLIFIED PORTAL: Single-Winner Paradigm (Zero Award Splitting)
//  All tenders are awarded 100% to a single winning bidder.
// ════════════════════════════════════════════════════════════════════════════
export const recommendSplitAward = async (req: AuthRequest, bidId: string, body: any) => {
  throw new ApiError(400, 'Award splitting is disabled. This portal strictly awards 100% of the bid to a single qualified winner.', 'SPLIT_AWARD_DISABLED');
};

export const inviteL2ToMatchL1 = async (req: AuthRequest, bidId: string, body: any = {}) => {
  throw new ApiError(400, 'L2 price-matching counter-offers are disabled. Award next qualified seller directly if previous seller declines.', 'L2_MATCH_DISABLED');
};

export const acceptL2Match = async (req: AuthRequest, bidId: string, participationId: number) => {
  throw new ApiError(400, 'L2 price-matching counter-offers are disabled.', 'L2_MATCH_DISABLED');
};

// ════════════════════════════════════════════════════════════════════════════
//  EDGE CASE 7: Bid Revision & Versioning Before Closing
//  Sellers can revise their quote before the deadline. Each revision
//  is tracked in an immutable revision history.
// ════════════════════════════════════════════════════════════════════════════
export const reviseParticipation = async (req: AuthRequest, bidId: string, participationId: number, body: any) => {
  const bid = await resolveBid(bidId, {});
  const participation = await db.procurementBidParticipation.findUnique({
    where: { id: participationId },
    include: { documents: true }
  });

  if (!participation || participation.bidId !== bid.id) {
    throw new ApiError(404, 'Participation not found.', 'PARTICIPATION_NOT_FOUND');
  }
  if (participation.sellerId !== req.user!.id) {
    throw new ApiError(403, 'Only the owner seller can revise their bid.', 'FORBIDDEN_ROLE');
  }
  if (participation.submissionStatus !== 'SUBMITTED') {
    throw new ApiError(400, 'Only submitted participations can be revised.', 'PARTICIPATION_NOT_SUBMITTED');
  }

  // Verify bid is still open
  const bidEndDate = bid.endDate ? new Date(bid.endDate) : null;
  if (bidEndDate && bidEndDate <= now()) {
    throw new ApiError(400, 'This bid is already closed. Revisions are no longer accepted.', 'BID_ALREADY_CLOSED');
  }
  const openStatuses = ['OPEN', 'OPEN_FOR_BIDDING', 'PUBLISHED', 'ACTIVE'];
  if (!openStatuses.includes(bid.status)) {
    throw new ApiError(400, 'Revisions are only allowed while the bid is open.', 'BID_NOT_OPEN');
  }

  // Snapshot current values into revision history
  const existingAck = (participation.acknowledgement && typeof participation.acknowledgement === 'object')
    ? participation.acknowledgement as Record<string, any>
    : {};
  const revisionHistory = Array.isArray(existingAck.revisionHistory) ? [...existingAck.revisionHistory] : [];
  const revisionCount = (existingAck.revisionCount || 0) + 1;

  revisionHistory.push({
    version: revisionCount,
    quotedAmount: Number(participation.quotedAmount),
    totalAmount: Number(participation.totalAmount),
    gstPercentage: Number(participation.gstPercentage || 0),
    submittedAt: participation.submittedAt?.toISOString() || null,
    revisedAt: new Date().toISOString(),
    revisedBy: req.user!.id
  });

  // Update with new values
  const newQuotedAmount = body.quotedAmount !== undefined ? Number(body.quotedAmount) : Number(participation.quotedAmount);
  const newGstPct = body.gstPercentage !== undefined ? Number(body.gstPercentage) : Number(participation.gstPercentage || 0);
  const newTotalAmount = body.totalAmount !== undefined ? Number(body.totalAmount) : newQuotedAmount;

  const updated = await db.procurementBidParticipation.update({
    where: { id: participation.id },
    data: {
      quotedAmount: newQuotedAmount,
      totalAmount: newTotalAmount,
      gstPercentage: newGstPct,
      makeBrand: body.makeBrand || participation.makeBrand,
      model: body.model || participation.model,
      offeredItemDescription: body.offeredItemDescription || participation.offeredItemDescription,
      submittedAt: now(),
      acknowledgement: {
        ...existingAck,
        revisionHistory,
        revisionCount,
        lastRevisedAt: new Date().toISOString(),
        ...(body.freight !== undefined ? { freight: Number(body.freight) } : {}),
        ...(body.loadingCharges !== undefined ? { loadingCharges: Number(body.loadingCharges) } : {}),
      }
    }
  });

  await procurementAudit(req, 'PARTICIPATION_REVISED', 'ProcurementBidParticipation', updated.id, {
    version: revisionCount,
    oldAmount: Number(participation.totalAmount),
    newAmount: newTotalAmount
  });

  // Edge Case 2: If this is a Reverse Auction, check for anti-sniping extension
  await autoExtendAuctionIfNeeded(bid);

  logger.info({ bidId: bid.id, participationId, revisionCount }, '[REVISION] Participation revised');
  return { participation: updated, revisionCount, message: `Bid revised to Version ${revisionCount}.` };
};
