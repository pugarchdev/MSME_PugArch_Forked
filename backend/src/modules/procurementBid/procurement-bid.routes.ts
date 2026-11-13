import { Router, type Response } from 'express';
import { z } from 'zod';
import { authenticate, checkFeatureEnabled, requireAccountType, requirePermission, type AuthRequest } from '../../middleware/auth.js';
import { upload } from '../../config/storage.js';
import prisma from '../../lib/prisma.js';
import { apiResponse } from '../../utils/apiResponse.js';
import { maskSensitive } from '../../utils/maskSensitive.js';
import { validate } from '../../middleware/validate.js';
import * as service from './procurement-bid.service.js';
import * as orderService from './procurement-order.service.js';
import { verifyAccessToken } from '../../services/token.service.js';
import { getAccessTokenFromRequest } from '../../services/auth-cookie.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../config/logger.js';
import { fulfillmentWorkflow } from '../../services/workflow/fulfillment-workflow.service.js';
import { getCache, setCache, deleteCache, getOrSetCache, invalidateByPattern } from '../../services/cache.service.js';
import { CANONICAL_METHOD_PREFIXES, getCanonicalLookupVariants, formatRequirementNumber } from '../../utils/refIdUtils.js';
import { parseDateIST } from '../../utils/dateUtils.js';

const router = Router();

export const invalidateBidCaches = async (bidOrId: any, token?: string) => {
  try {
    const keysToInvalidate = new Set<string>();
    if (typeof bidOrId === 'string' || typeof bidOrId === 'number') {
      keysToInvalidate.add(String(bidOrId));
    } else if (bidOrId && typeof bidOrId === 'object') {
      if (bidOrId.id) keysToInvalidate.add(String(bidOrId.id));
      if (bidOrId.bidId) keysToInvalidate.add(String(bidOrId.bidId));
      if (bidOrId.bidNumber) {
        keysToInvalidate.add(String(bidOrId.bidNumber));
        for (const variant of getCanonicalLookupVariants(bidOrId.bidNumber)) {
          keysToInvalidate.add(variant);
        }
      }
      if (bidOrId.sourceId) keysToInvalidate.add(String(bidOrId.sourceId));
      if (bidOrId.purchaseOrder?.bidId) keysToInvalidate.add(String(bidOrId.purchaseOrder.bidId));
      if (bidOrId.award?.bidId) keysToInvalidate.add(String(bidOrId.award.bidId));
      if (bidOrId.bid) {
        if (bidOrId.bid.id) keysToInvalidate.add(String(bidOrId.bid.id));
        if (bidOrId.bid.bidNumber) {
          keysToInvalidate.add(String(bidOrId.bid.bidNumber));
          for (const variant of getCanonicalLookupVariants(bidOrId.bid.bidNumber)) {
            keysToInvalidate.add(variant);
          }
        }
        if (bidOrId.bid.sourceId) keysToInvalidate.add(String(bidOrId.bid.sourceId));
      }
      const sourceReqId = (bidOrId.technicalPacket as any)?.sourceRequirementId || (bidOrId.technicalPacket as any)?.requirementId;
      if (sourceReqId) keysToInvalidate.add(String(sourceReqId));
    }
    if (token) {
      keysToInvalidate.add(String(token));
      for (const variant of getCanonicalLookupVariants(token)) {
        keysToInvalidate.add(variant);
      }
    }
    // Deep purge: if any numeric id is present, query and also purge by bidNumber and sourceId
    const numericTokens = Array.from(keysToInvalidate).filter((k) => /^\d+$/.test(k)).map(Number);
    if (numericTokens.length > 0) {
      const relatedBids = await (prisma as any).procurementBid.findMany({
        where: { id: { in: numericTokens } },
        select: { id: true, bidNumber: true, sourceId: true }
      }).catch(() => []);
      for (const b of relatedBids) {
        if (b.bidNumber) {
          keysToInvalidate.add(b.bidNumber);
          for (const variant of getCanonicalLookupVariants(b.bidNumber)) {
            keysToInvalidate.add(variant);
          }
        }
        if (b.sourceId) keysToInvalidate.add(String(b.sourceId));
      }
    }
    for (const key of keysToInvalidate) {
      if (!key) continue;
      await invalidateByPattern(`cache:proc_bid_${key}*`).catch(() => null);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to invalidate bid cache');
  }
};

const optionalActor = async (req: AuthRequest) => {
  const authHeader = req.headers.authorization || '';
  const [scheme, headerToken] = authHeader.split(' ');
  const canUseHeaderToken = scheme === 'Bearer' && headerToken && !['null', 'undefined', 'cookie-session'].includes(headerToken);
  const token = canUseHeaderToken
    ? headerToken
    : getAccessTokenFromRequest(req);

  if (!token) return null;
  try {
    const decoded = verifyAccessToken(token);
    const user = await prisma.user.findUnique({
      where: { id: Number(decoded.id) },
      select: { id: true, role: true, sessionVersion: true, accountStatus: true, organizationId: true }
    });
    if (!user || user.accountStatus !== 'ACTIVE' || user.role !== decoded.role || user.sessionVersion !== Number(decoded.sessionVersion)) return null;
    return { id: user.id, role: user.role, sessionVersion: user.sessionVersion, organizationId: user.organizationId, permissions: [], enabledFeatures: [] };
  } catch {
    return null;
  }
};

const asyncRoute = (handler: (req: AuthRequest & { file?: Express.Multer.File }, res: Response) => Promise<unknown>) =>
  async (req: AuthRequest & { file?: Express.Multer.File }, res: Response) => {
    try {
      await handler(req, res);
    } catch (err: any) {
      console.error('=================== [PROCUREMENT_ROUTE_ERROR] STACK TRACE ===================');
      console.error(err?.stack || err);
      console.error('=============================================================================');

      logger.error({
        err,
        message: err?.message,
        stack: err?.stack,
        code: err?.code,
        path: req.originalUrl || req.path,
        method: req.method,
        body: maskSensitive(req.body),
        params: req.params,
        user: req.user
      }, '[PROCUREMENT_ROUTE_ERROR] Route execution exception');

      if (err instanceof ApiError) {
        return apiResponse.error(res, err.statusCode, err.message, err.code, err.details);
      }
      return apiResponse.error(res, err?.statusCode || 500, err?.message || 'Unable to complete procurement request', err?.code || 'REQUEST_FAILED', { stack: err?.stack });
    }
  };

const bidBaseSchema = z.object({
  title: z.string().trim().min(3).max(220),
  description: z.string().trim().min(10).max(8000),
  buyerOrganizationName: z.string().trim().max(220).optional(),
  buyerType: z.string().trim().min(2).max(100).optional(),
  category: z.string().trim().min(2).max(120),
  bidType: z.string().trim().min(2).max(80),
  procurementType: z.string().trim().max(80).optional(),
  quantity: z.coerce.number().positive().optional(),
  unit: z.string().trim().max(120).optional(),
  estimatedValue: z.coerce.number().nonnegative().optional(),
  deliveryLocation: z.string().trim().min(2).max(400),
  state: z.string().trim().max(80).optional(),
  district: z.string().trim().max(80).optional(),
  pincode: z.string().trim().max(12).optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  technicalOpeningDate: z.coerce.date().optional(),
  financialOpeningDate: z.coerce.date().optional(),
  bidValidityDate: z.coerce.date().optional(),
  evaluationMethod: z.string().trim().max(120).optional().default('L1'),
  documentFee: z.coerce.number().nonnegative().optional(),
  allowClarification: z.boolean().optional(),
  allowReverseAuction: z.boolean().optional(),
  allowBoq: z.boolean().optional(),
  termsAndConditions: z.array(z.string().trim().min(1)).optional(),
  eligibilityCriteria: z.array(z.string().trim().min(1)).optional(),
  requiredDocuments: z.array(z.string().trim().min(1)).optional(),
  canonicalMethod: z.string().trim().max(80).optional(),
  categoryType: z.enum(['GOODS', 'SERVICES', 'WORKS']).optional(),
  pricingFormat: z.enum(['SINGLE_ITEM', 'BOQ', 'SOR']).optional(),
  technicalPacket: z.any().optional(),
  financialPacket: z.any().optional()
});

const bidBodySchema = bidBaseSchema.refine(data => data.endDate > data.startDate, { message: 'End date must be after start date', path: ['endDate'] });

const flexibleParticipationIdSchema = z.union([z.number(), z.string()]).transform(val => {
  if (typeof val === 'number') return val;
  const parsed = Number(String(val).replace(/^[^\d]+/, ''));
  return isNaN(parsed) ? val : parsed;
});

const idParamSchema = z.object({ bidId: z.string().trim().min(1) });
const participationParamSchema = idParamSchema.extend({ participationId: flexibleParticipationIdSchema });
const clarificationParamSchema = idParamSchema.extend({ clarificationId: z.coerce.number().int().positive() });

const financialQuoteSchema = z.object({
  quotedAmount: z.coerce.number().nonnegative(),
  gstPercentage: z.coerce.number().min(0).max(100).optional(),
  totalAmount: z.coerce.number().nonnegative().optional(),
  makeBrand: z.string().trim().max(160).optional(),
  model: z.string().trim().max(160).optional(),
  offeredItemDescription: z.string().trim().max(20000).optional(),
  lineItems: z.string().optional(),
  responseData: z.string().optional(),
  deliveryTimeline: z.string().trim().max(250).optional(),
  terms: z.string().trim().max(2000).optional(),
  paymentTerms: z.string().trim().max(2000).optional(),
  offeredQuantity: z.union([z.string(), z.number()]).optional(),
});

const clarificationSchema = z.object({
  participationId: flexibleParticipationIdSchema,
  clarificationType: z.string().trim().min(2).max(80),
  question: z.string().trim().min(5).max(3000),
  dueDate: z.coerce.date().optional()
});

const technicalEvaluationSchema = z.object({
  evaluations: z.array(z.object({
    participationId: flexibleParticipationIdSchema,
    status: z.enum(['QUALIFIED', 'DISQUALIFIED']),
    remarks: z.string().trim().max(2000).optional(),
    score: z.coerce.number().min(0).max(100).optional()
  })).min(1)
});

const orderIdParamSchema = z.object({ orderId: z.coerce.number().int().positive() });
const awardIdParamSchema = z.object({ awardId: z.coerce.number().int().positive() });
const grnParamSchema = orderIdParamSchema.extend({ grnId: z.coerce.number().int().positive() });
const invoiceParamSchema = orderIdParamSchema.extend({ invoiceId: z.coerce.number().int().positive() });

router.get('/procurement-bids', asyncRoute(async (req, res) => {
  const actor = await optionalActor(req);
  const cacheKey = `cache:procurement-bids:${actor?.id || 'anon'}:${actor?.role || 'anon'}:${JSON.stringify(req.query)}`;
  const data = await getOrSetCache(cacheKey, () => service.listPublicBids(req.query, actor), 30);
  if ((actor?.role === 'seller' || actor?.role === 'shg') && data?.items && Array.isArray(data.items) && data.items.length > 0) {
    await enrichBidsWithResponses(data.items, Number(actor.id));
    const currentActorId = Number(actor.id);
    const currentOrgId = actor.organizationId ? Number(actor.organizationId) : null;
    for (const item of data.items) {
      if (Array.isArray(item.participations)) {
        const hasSubmitted = item.participations.some((p: any) => {
          const pSellerId = Number(p.sellerId || p.sellerUserId || p.seller?.id || 0);
          const pOrgId = Number(p.organizationId || p.sellerOrganizationId || p.seller?.organizationId || 0);
          const matchesUser = (currentActorId && pSellerId === currentActorId) || (currentOrgId && pOrgId === currentOrgId);
          const subStatus = String(p.submissionStatus || p.status || '').toUpperCase();
          return matchesUser && subStatus === 'SUBMITTED';
        });
        const hasPart = item.participations.some((p: any) => {
          const pSellerId = Number(p.sellerId || p.sellerUserId || p.seller?.id || 0);
          const pOrgId = Number(p.organizationId || p.sellerOrganizationId || p.seller?.organizationId || 0);
          return (currentActorId && pSellerId === currentActorId) || (currentOrgId && pOrgId === currentOrgId);
        });
        if (hasPart) {
          item.participated = true;
          item.hasParticipated = true;
        }
        item.hasSubmittedProposal = hasSubmitted;
      }
    }
  }
  return apiResponse.success(res, data, 200, 'Bids fetched successfully');
}));

router.get('/procurement-bids/my', authenticate, requireAccountType('seller', 'buyer', 'admin', 'shg'), asyncRoute(async (req, res) => {
  const role = String(req.user?.role || '');
  const currentUserId = Number(req.user?.id);
  const where = (role === 'seller' || role === 'shg')
    ? { sellerId: currentUserId }
    : role === 'buyer'
      ? { tender: { buyerId: currentUserId } }
      : {};

  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const parsedLimit = parseInt(String(req.query.limit || '20'), 10) || 20;
  const limit = Math.min(Math.max(1, parsedLimit), 100);
  const skip = (page - 1) * limit;

  const [totalCount, bids] = await Promise.all([
    prisma.bid.count({ where }),
    prisma.bid.findMany({
      where,
      skip,
      take: limit,
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
      },
      orderBy: { createdAt: 'desc' }
    })
  ]);

  const totalPages = Math.ceil(totalCount / limit);

  return res.json({
    data: maskSensitive(bids),
    pagination: {
      page,
      limit,
      totalCount,
      totalPages
    }
  });
}));

router.get('/procurement-bids/:bidId', validate({ params: idParamSchema }), asyncRoute(async (req, res) => {
  const actor = await optionalActor(req);
  const currentActor = (req as any).user || actor;
  const originalToken = req.params.bidId;
  let token = originalToken;

  const shouldSkipCache = req.query.skipCache === 'true' || req.headers['cache-control']?.includes('no-cache') || req.headers['pragma'] === 'no-cache';
  const cacheKey = `cache:proc_bid_${originalToken}_${currentActor?.id || 'anon'}_${currentActor?.role || 'guest'}_${currentActor?.organizationId || 'no_org'}`;
  const cachedResponse = shouldSkipCache ? null : await getCache<any>(cacheKey);
  if (cachedResponse) {
    return apiResponse.success(res, cachedResponse, 200, 'Procurement bid details fetched successfully');
  }

  // FAST PATH: Check if token directly resolves in procurementBid table first!
  try {
    const directBid = await service.resolveBid(originalToken, service.leanBidInclude);
    if (directBid) {
      if (!service.canActorViewBid(currentActor as any, directBid)) {
        throw new ApiError(404, 'Bid not found', 'BID_NOT_FOUND');
      }
      await enrichBidsWithResponses([directBid], currentActor?.role === 'buyer' ? Number(currentActor.id) : undefined);
      const isBuyerOrAdmin = currentActor?.role === 'buyer' || currentActor?.role === 'admin' || currentActor?.role === 'master_admin' || (!!currentActor?.id && Number(directBid.buyerId) === Number(currentActor.id));
      const sellerCanSeeParticipants = currentActor?.role === 'seller' && (directBid.participations || []).some((p: any) => (currentActor.id && p.sellerId === Number(currentActor.id)) || (currentActor.organizationId && p.seller?.organizationId === currentActor.organizationId));
      const sellerCanSeeCompetitors = sellerCanSeeParticipants && service.financialOpenStatuses.includes(directBid.status);
      const includeParticipants = isBuyerOrAdmin || sellerCanSeeCompetitors;
      const includeFinancial = isBuyerOrAdmin || sellerCanSeeCompetitors;

      const sellerIds = (directBid.participations || []).map((p: any) => p.sellerId);
      const sellerRatings = await service.getAverageRatingsForSellers(sellerIds);
      const serialized = service.serializeBid(directBid, { actor: currentActor || undefined, detail: true, includeParticipants, includeFinancial, sellerRatings });
      const awardIds = (directBid.awards || []).map((a: any) => a.id);
      const linkedAuctions = await (prisma as any).auction.findMany({
        where: {
          OR: [
            { linkedBidId: directBid.id },
            ...(directBid.bidNumber ? [{ referenceNo: directBid.bidNumber }] : [])
          ]
        },
        select: { id: true, auctionCode: true }
      }).catch(() => []);
      const linkedAuctionIds = linkedAuctions.map((a: any) => a.id);

      const isNumericBidId = typeof directBid.id === 'number' || (/^\d+$/.test(String(directBid.id)) && Number(directBid.id) <= 2147483647);
      const numericBidId = isNumericBidId ? Number(directBid.id) : null;
      const auctionId = directBid.auctionId ? Number(directBid.auctionId) : (directBid.sourceId ? Number(directBid.sourceId) : null);
      const allAuctionIds = Array.from(new Set([...linkedAuctionIds, ...(auctionId ? [auctionId] : [])]));

      const poOrConditions: any[] = [
        ...(numericBidId !== null ? [{ bidId: numericBidId }] : []),
        ...(awardIds.length > 0 ? [{ sourceType: 'procurement_bid_award', sourceId: { in: awardIds } }] : []),
        ...(allAuctionIds.length > 0 ? [{ sourceType: 'auction', sourceId: { in: allAuctionIds } }] : [])
      ];

      const pos = poOrConditions.length > 0
        ? await (prisma as any).purchaseOrder.findMany({
            where: { OR: poOrConditions },
            include: {
              invoices: { include: { invoiceFile: true, paymentSlipFile: true } },
              grns: { include: { items: true } },
              items: true
            },
            orderBy: { createdAt: 'desc' }
          }).catch((poErr: any) => {
            logger.warn({ poErr: poErr?.message || poErr }, '[ProcurementBid] Failed to fetch purchase orders for bid');
            return [];
          })
        : [];

      if (pos.length > 0) {
        (serialized as any).purchaseOrders = pos;
        (serialized as any).activeOrder = pos[0] || null;
        if (serialized.awards && Array.isArray(serialized.awards)) {
          const poMap = new Map(pos.map((p: any) => [p.sourceId, p]));
          serialized.awards.forEach((aw: any) => {
            if (poMap.has(aw.id)) aw.order = poMap.get(aw.id);
            else if (pos.length > 0) aw.order = pos[0];
          });
        }
      }
      await setCache(cacheKey, serialized, 30);
      return apiResponse.success(res, serialized, 200, 'Procurement bid details fetched successfully');
    }
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
    // Fall back to Tender / Rate Contract / Requirement lookup below
  }

  if (token.startsWith('TENDER-') || token.startsWith('TND-')) {
    try {
      const data = await service.resolveTenderBidActivity(token);
      if (data) {
        await setCache(cacheKey, data, 30);
        return apiResponse.success(res, data, 200, 'Tender opportunity details fetched successfully');
      }
    } catch {
      // Continue to next fallbacks
    }
  }

  // Check if token refers to a Reverse Auction
  if (token.startsWith('RA-') || token.startsWith('PRC-') || token.startsWith('AUCTION-') || /^\d+$/.test(token)) {
    try {
      const synthesizedAuctionBid = await service.resolveAuctionAsBidRecord(token);
      if (synthesizedAuctionBid) {
        await setCache(cacheKey, synthesizedAuctionBid, 15);
        return apiResponse.success(res, synthesizedAuctionBid, 200, 'Reverse auction details fetched successfully');
      }
    } catch (auctionErr) {
      logger.warn({ auctionErr, token }, '[ProcurementBid] Error resolving reverse auction bid record');
      // Continue to next fallbacks
    }
  }

  // Check if token refers to a Rate Contract in db.contract first
  if (token.startsWith('RC-') || token.startsWith('RATE-') || /^\d+$/.test(token)) {
    const rawNum = Number(token.replace(/^(RC-|RATE-)/, '')) || (/^\d+$/.test(token) ? Number(token) : 0);
    const validId = (rawNum > 0 && rawNum <= 2147483647) ? rawNum : 0;
    const rateContract = await (prisma as any).contract.findFirst({
      where: {
        contractType: 'RATE_CONTRACT',
        OR: [
          { contractNumber: token },
          { contractNumber: `RC-${token}` },
          ...(validId > 0 ? [{ id: validId }] : [])
        ]
      }
    });

    if (rateContract) {
      const meta = typeof rateContract.metadata === 'string' ? JSON.parse(rateContract.metadata) : (rateContract.metadata || {});
      const reqId = Number(meta.requirementId || 0);
      const reqNum = meta.requirementNumber;

      let srcReq: any = null;
      if (reqId || reqNum || meta.requirementId) {
        const strReqNum = reqNum || (typeof meta.requirementId === 'string' ? meta.requirementId : undefined);
        srcReq = await (prisma as any).buyerRequirement.findFirst({
          where: { OR: [{ id: reqId > 0 && reqId <= 2147483647 ? reqId : undefined }, { requirementNumber: strReqNum }].filter(Boolean) as any[] },
          include: {
            buyerOrganization: { select: { id: true, organizationName: true, organizationType: true, city: true, district: true, state: true } },
            createdBy: { select: { id: true, name: true, email: true, mobile: true, role: true } }
          }
        }).catch(() => null);

        if (!srcReq) {
          srcReq = await (prisma as any).requirement.findFirst({
            where: { OR: [{ id: reqId > 0 && reqId <= 2147483647 ? reqId : undefined }, { requirementNumber: strReqNum }].filter(Boolean) as any[] },
            include: {
              items: true,
              organization: { select: { id: true, organizationName: true, organizationType: true, verificationStatus: true, city: true, district: true, state: true } },
              category: true,
              buyer: { select: { id: true, name: true, email: true, mobile: true, role: true, buyerProfile: { select: { departmentName: true, representativeName: true, email: true, mobile: true } } } },
            }
          }).catch(() => null);
        }
      }

      const srcPayload = typeof srcReq?.payload === 'string' ? JSON.parse(srcReq.payload) : (srcReq?.payload || {});
      const realTitle = 
        rateContract.title || 
        meta.contractTitle || 
        meta.title || 
        srcReq?.title || 
        srcPayload.basics?.title || 
        srcPayload.title ||
        (rateContract.contractNumber ? `Annual Rate Contract ${rateContract.contractNumber}` : `Annual Rate Contract #${rateContract.id}`);

      const realCategory = meta.contractCategory || srcReq?.category?.name || srcPayload.basics?.category || 'Rate Contract';
      const itemRateSchedule = Array.isArray(meta.itemRateSchedule) ? meta.itemRateSchedule : [];
      
      const items = (srcReq?.items && srcReq.items.length > 0)
        ? srcReq.items.map((i: any) => {
            const spec = typeof i.specifications === 'object' && i.specifications ? i.specifications : (typeof i.specifications === 'string' ? (() => { try { return JSON.parse(i.specifications); } catch { return {}; } })() : {});
            return {
              id: String(i.id),
              itemName: i.itemName || i.name || spec.itemName || '',
              description: i.description || spec.description || i.specification || '',
              quantity: Number(i.quantity || spec.quantity || 1),
              unit: i.unitOfMeasure || i.unit || spec.unit || 'Nos',
              unitOfMeasure: i.unitOfMeasure || i.unit || spec.unit || 'Nos',
              estimatedUnitPrice: i.estimatedUnitPrice ? Number(i.estimatedUnitPrice) : (spec.estimatedUnitPrice ? Number(spec.estimatedUnitPrice) : undefined),
              technicalSpecification: i.technicalSpecification || i.technicalSpecs || i.specs || spec.technicalSpecification || spec.technicalSpecs || spec.specs || (typeof i.specifications === 'string' ? i.specifications : undefined),
              brand: i.brand || i.brandName || i.makeBrand || spec.brand || spec.brand_preference || spec.brandName || undefined,
              make: i.make || i.makeBrand || spec.make || spec.makeBrand || undefined,
              model: i.model || spec.model || undefined,
              alternateBrandAllowed: i.alternateBrandAllowed ?? spec.alternateBrandAllowed ?? (spec.brand_flexible?.toLowerCase() === 'no' ? false : true),
              hsn: i.hsn || i.hsnCode || i.hsn_sac_code || spec.hsn || spec.hsn_sac_code || undefined,
              sac: i.sac || i.sacCode || spec.sac || undefined,
              gstPercent: i.gstPercent || i.gst || i.taxPercent || spec.gstPercent || spec.gst || spec.taxPercent || undefined,
              fileName: i.fileName || i.fileUrl || i.attachmentUrl || spec.fileName || spec.fileUrl || undefined,
              fileUrl: i.fileUrl || i.attachmentUrl || spec.fileUrl || undefined,
              specifications: typeof i.specifications === 'object' ? i.specifications : spec
            };
          })
        : itemRateSchedule.map((i: any, idx: number) => ({
            id: String(idx + 1),
            itemName: i.itemName || `Rate Schedule Item ${idx + 1}`,
            description: i.specification || i.description || '',
            quantity: Number(i.estimatedAnnualQuantity || i.quantity || 1),
            unit: i.uom || i.unit || 'Nos',
            unitOfMeasure: i.uom || i.unit || 'Nos',
            estimatedUnitPrice: Number(i.baseRate || i.estimatedUnitPrice || 0),
            technicalSpecification: i.technicalSpecification || i.specification || i.specs || undefined,
            brand: i.brand || i.makeBrand || i.brandName || undefined,
            make: i.make || i.makeBrand || undefined,
            model: i.model || undefined,
            alternateBrandAllowed: i.alternateBrandAllowed ?? true,
            hsn: i.hsn || i.hsnCode || i.hsn_sac_code || undefined,
            sac: i.sac || i.sacCode || undefined,
            gstPercent: i.gstPercent || i.gst || 18,
            fileName: i.fileName || i.fileUrl || undefined,
            fileUrl: i.fileUrl || undefined,
            specifications: i
          }));

      // 1. Find shadow procurementBid for this Rate Contract to load native bid participations
      const shadowBid = await (prisma as any).procurementBid.findFirst({
        where: {
          OR: [
            ...(validId > 0 ? [{ id: validId }] : []),
            { bidNumber: token },
            { bidNumber: rateContract.contractNumber },
            { bidNumber: `RC-${rateContract.id}` },
            { bidNumber: `RC-${rateContract.contractNumber}` },
            { technicalPacket: { path: ['sourceContractId'], equals: rateContract.id } },
            { technicalPacket: { path: ['contractId'], equals: rateContract.id } }
          ]
        },
        include: {
          participations: {
            where: { isWithdrawn: false },
            include: {
              seller: { select: { id: true, name: true, email: true, mobile: true, role: true, organization: true } },
              documents: true
            }
          }
        }
      }).catch(() => null);

      const rawNativeParts = (shadowBid?.participations || []).map((p: any) =>
        service.serializeParticipation(p, { canSeeFinancial: true, bid: shadowBid })
      );

      // 2. Query requirement responses for parent requirement by ID and requirement number
      const targetReqIds: number[] = [];
      if (srcReq?.id && Number(srcReq.id) <= 2147483647) targetReqIds.push(Number(srcReq.id));
      if (reqId > 0 && reqId <= 2147483647) targetReqIds.push(reqId);
      if (meta.requirementId && Number(meta.requirementId) > 0 && Number(meta.requirementId) <= 2147483647) targetReqIds.push(Number(meta.requirementId));

      const targetReqNumbers = Array.from(new Set([
        srcReq?.requirementNumber,
        meta.requirementNumber,
        typeof meta.requirementId === 'string' ? meta.requirementId : null,
        rateContract.contractNumber
      ].filter(Boolean) as string[]));

      if (targetReqNumbers.length > 0) {
        const matchingLegacy = await (prisma as any).requirement.findMany({
          where: { requirementNumber: { in: targetReqNumbers } },
          select: { id: true }
        }).catch(() => []);
        for (const m of matchingLegacy) {
          if (m?.id && !targetReqIds.includes(m.id)) targetReqIds.push(m.id);
        }
      }

      const legacyResponses = targetReqIds.length > 0
        ? await (prisma as any).requirementResponse.findMany({
            where: {
              requirementId: { in: targetReqIds },
              status: { not: 'DRAFT' }
            },
            include: {
              sellerUser: { select: { id: true, name: true, email: true, mobile: true, role: true, organizationId: true } },
              sellerOrganization: { select: { organizationName: true } }
            }
          }).catch(() => [])
        : [];

      const existingSellerIds = new Set(rawNativeParts.map((p: any) => p.sellerId).filter(Boolean));

      const mappedLegacyParticipations = legacyResponses
        .filter((r: any) => !existingSellerIds.has(r.sellerUserId || r.sellerOrganizationId || r.id))
        .map((r: any) => {
          const respData = typeof r.responseData === 'string' ? JSON.parse(r.responseData) : (r.responseData || {});
          const effectiveSellerId = r.sellerUserId || r.sellerOrganizationId || r.id;
          const sellerName = r.sellerUser?.name || r.sellerOrganization?.organizationName || `Seller #${effectiveSellerId}`;
          return {
            id: r.id,
            bidId: shadowBid?.id || rateContract.id,
            sellerId: effectiveSellerId,
            isWithdrawn: false,
            submissionStatus: 'SUBMITTED',
            seller: {
              id: effectiveSellerId,
              name: sellerName,
              email: r.sellerUser?.email || '',
              mobile: r.sellerUser?.mobile || '',
              role: r.sellerUser?.role || 'seller',
              organization: r.sellerOrganization || (r.sellerUser?.organizationId ? { id: r.sellerUser.organizationId, organizationName: sellerName } : null)
            },
            participationNumber: `PRT-${r.id}`,
            technicalStatus: r.status === 'SHORTLISTED' || r.status === 'ACCEPTED' ? 'QUALIFIED' : (r.status === 'REJECTED' ? 'DISQUALIFIED' : 'PENDING'),
            financialStatus: 'OPENED',
            financialSealed: false,
            finalStatus: r.status === 'ACCEPTED' ? 'AWARDED' : 'PENDING',
            quotedAmount: r.offeredPrice,
            totalAmount: r.offeredPrice,
            offeredQuantity: r.offeredQuantity,
            deliveryTimeline: r.deliveryTimeline || respData.deliveryTimeline,
            terms: r.terms || respData.terms,
            makeBrand: respData.makeBrand || r.makeBrand,
            model: respData.model || r.model,
            offeredItemDescription: r.message || '',
            responseData: respData,
            lineItems: Array.isArray(respData.lineItems) ? respData.lineItems : [],
            createdAt: r.createdAt,
            submittedAt: r.createdAt,
          };
        });

      const combinedParticipations = [...rawNativeParts, ...mappedLegacyParticipations];

      const formatDateStr = (val: any) => {
        if (!val) return '-';
        if (typeof val === 'string') return val.slice(0, 10);
        if (val instanceof Date) return val.toISOString().slice(0, 10);
        return String(val).slice(0, 10);
      };
      const startDateStr = formatDateStr(rateContract.startDate);
      const endDateStr = formatDateStr(rateContract.endDate);

        // 1. Gather all buyer uploaded documents
        const contractDocs: any[] = [];

        if (meta.contractDocument) {
          contractDocs.push({
            id: `rcdoc-${rateContract.id}`,
            documentType: 'RATE_CONTRACT_DOCUMENT',
            fileName: meta.contractDocument.fileName || meta.contractDocument.name || 'Rate Contract Document',
            fileAssetId: meta.contractDocument.fileAssetId ? Number(meta.contractDocument.fileAssetId) : null,
            fileUrl: meta.contractDocument.fileUrl || meta.contractDocument.url || (meta.contractDocument.fileAssetId ? `/api/files/${meta.contractDocument.fileAssetId}/view` : null)
          });
        }

        const rawPayloadDocs = [
          ...(Array.isArray(srcPayload?.documents) ? srcPayload.documents : []),
          ...(Array.isArray(srcPayload?.requiredDocs) ? srcPayload.requiredDocs : []),
          ...(Array.isArray(srcPayload?.wizardData?.documents) ? srcPayload.wizardData.documents : []),
          ...(Array.isArray(srcPayload?.termsDocuments?.documents) ? srcPayload.termsDocuments.documents : [])
        ];

        for (const d of rawPayloadDocs) {
          if (d && (d.fileAssetId || d.id || d.fileUrl || d.url || d.fileName || d.name)) {
            const fid = d.fileAssetId ? Number(d.fileAssetId) : (typeof d.id === 'number' ? d.id : null);
            const fname = d.fileName || d.name || d.originalName || 'Specification Document';
            const furl = d.fileUrl || d.url || (fid ? `/api/files/${fid}/view` : null);
            if (!contractDocs.some(existing => existing.fileName === fname || (fid && existing.fileAssetId === fid))) {
              contractDocs.push({
                id: fid || `doc-${contractDocs.length + 1}`,
                documentType: d.documentType || d.type || 'TECHNICAL_SPECIFICATION',
                fileName: fname,
                fileAssetId: fid,
                fileUrl: furl
              });
            }
          }
        }

        if (srcReq?.id) {
          const linkedFileAssets = await (prisma as any).fileAsset.findMany({
            where: {
              OR: [
                { entityType: { in: ['REQUIREMENT', 'BUYER_REQUIREMENT', 'RATE_CONTRACT', 'PROCUREMENT_BID'] }, entityId: Number(srcReq.id) },
                { entityType: 'RATE_CONTRACT', entityId: Number(rateContract.id) }
              ],
              status: 'active'
            },
            select: { id: true, originalName: true, mimeType: true, url: true }
          }).catch(() => []);

          for (const fa of linkedFileAssets) {
            if (!contractDocs.some(existing => existing.fileAssetId === fa.id || existing.fileName === fa.originalName)) {
              contractDocs.push({
                id: fa.id,
                documentType: 'ATTACHMENT',
                fileName: fa.originalName || 'Attachment',
                fileAssetId: fa.id,
                fileUrl: fa.url || `/api/files/${fa.id}/view`
              });
            }
          }
        }
        const synthesizedRateContract = {
        id: rateContract.contractNumber || `RC-${rateContract.id}`,
        bidNumber: rateContract.contractNumber || `RC-${rateContract.id}`,
        referenceNumber: rateContract.contractNumber || `RC-${rateContract.id}`,
        title: realTitle,
        description: meta.contractDescription || srcReq?.description || '',
        buyerId: meta.buyerId || srcReq?.buyerId || (actor?.id ? Number(actor.id) : 0),
        buyerOrganizationName: meta.buyerOrganizationName || srcReq?.organization?.organizationName || srcReq?.buyerOrganization?.organizationName || '',
        buyerType: meta.buyerType || srcReq?.buyerOrganization?.organizationType || srcReq?.organization?.organizationType || 'Private Enterprise',
        departmentName: srcReq?.buyer?.buyerProfile?.departmentName || srcReq?.createdBy?.buyerProfile?.departmentName || '',
        category: realCategory,
        bidType: 'Rate Contract',
        procurementType: 'Rate Contract',
        quantity: items.reduce((sum: number, i: any) => sum + Number(i.quantity || 0), 0) || 1,
        unit: items[0]?.unitOfMeasure || 'Nos',
        estimatedValue: Number(rateContract.value || srcReq?.estimatedValue || 0),
        deliveryLocation: meta.deliverySla || srcReq?.deliveryLocation || srcReq?.location || '',
        startDate: startDateStr,
        endDate: endDateStr,
        status: String(rateContract.status || 'ACTIVE'),
        approvalStatus: 'APPROVED',
        lifecycleStage: 'SELLER_PARTICIPATION',
        evaluationMethod: 'L1',
        packetType: 'SINGLE_PACKET',
        technicalPacket: {
          basics: {
            title: realTitle,
            description: meta.contractDescription || srcReq?.description || '',
            category: realCategory,
            deliveryLocation: meta.deliverySla || srcReq?.deliveryLocation || srcReq?.location || '',
            estimatedValue: Number(rateContract.value || srcReq?.estimatedValue || 0),
            requiredByDate: endDateStr,
            procurementCategory: srcPayload?.basics?.procurementCategory || srcPayload?.categoryType || 'GOODS',
            pricingFormat: srcPayload?.basics?.pricingFormat || srcPayload?.pricingFormat || 'SOR',
            buyerType: srcReq?.buyerOrganization?.organizationType || srcReq?.organization?.organizationType || srcPayload?.basics?.buyerType || 'Private Enterprise',
            isRepeatedSupply: true,
          },
          internal: {
            orgName: srcReq?.buyerOrganization?.organizationName || srcReq?.organization?.organizationName || meta.buyerOrganizationName || '',
            department: srcReq?.buyer?.buyerProfile?.departmentName || srcReq?.createdBy?.buyerProfile?.departmentName || srcPayload?.internal?.department || '',
            contactPerson: srcReq?.buyer?.buyerProfile?.representativeName || srcReq?.createdBy?.buyerProfile?.representativeName || srcPayload?.internal?.contactPerson || '',
            email: srcReq?.buyer?.email || srcReq?.createdBy?.email || srcReq?.buyer?.buyerProfile?.email || srcReq?.createdBy?.buyerProfile?.email || srcPayload?.internal?.email || '',
            mobile: srcReq?.buyer?.mobile || srcReq?.createdBy?.mobile || srcReq?.buyer?.buyerProfile?.mobile || srcReq?.createdBy?.buyerProfile?.mobile || srcPayload?.internal?.mobile || '',
            internalFileNumber: srcPayload?.internal?.internalFileNumber || '',
            justification: srcPayload?.internal?.justification || meta.contractDescription || '',
            budgetConfirmed: srcPayload?.internal?.budgetConfirmed ?? true,
            competentAuthority: srcPayload?.internal?.competentAuthority || '',
            approvalAuthority: srcPayload?.internal?.approvalAuthority || '',
          },
          schedule: {
            publishDate: rateContract.createdAt || srcPayload?.schedule?.publishDate,
            submissionStartDate: rateContract.startDate || srcPayload?.schedule?.submissionStartDate || rateContract.createdAt,
            submissionDate: rateContract.endDate || srcPayload?.schedule?.submissionDate,
            technicalOpeningDate: srcPayload?.schedule?.technicalOpeningDate || null,
            financialOpeningDate: srcPayload?.schedule?.financialOpeningDate || null,
            packetType: srcPayload?.schedule?.packetType || 'Single',
            clarificationAllowed: srcPayload?.schedule?.clarificationAllowed ?? true,
          },
          terms: {
            paymentTerms: meta.paymentTerms || srcPayload?.terms?.paymentTerms || '',
            deliveryTerms: meta.deliverySla || srcPayload?.terms?.deliveryTerms || '',
            freightIncluded: srcPayload?.terms?.freightIncluded ?? srcPayload?.tender?.freightIncluded ?? srcPayload?.freightIncluded ?? true,
            gstIncluded: srcPayload?.terms?.gstIncluded ?? srcPayload?.tender?.gstIncluded ?? srcPayload?.gstIncluded ?? false,
            warrantyTerms: srcPayload?.terms?.warrantyTerms || '',
            penaltyClause: meta.penaltyClause || srcPayload?.terms?.penaltyClause || '',
          },
          vendors: {
            selection: srcPayload?.vendors?.selection || (meta.supplierSelectionStrategy ? meta.supplierSelectionStrategy : 'Open'),
            msmePreference: srcPayload?.vendors?.msmePreference ?? false,
            excludeBlacklisted: srcPayload?.vendors?.excludeBlacklisted ?? true,
            invitedSellers: meta.selectedSuppliers || srcPayload?.vendors?.invitedSellers || [],
            inviteCount: (meta.selectedSuppliers || srcPayload?.vendors?.invitedSellers || []).length,
          },
          evaluation: {
            method: srcPayload?.evaluation?.method || 'L1',
            techWeight: srcPayload?.evaluation?.techWeight ?? null,
            commWeight: srcPayload?.evaluation?.commWeight ?? null,
            minQualifyingMarks: srcPayload?.evaluation?.minQualifyingMarks ?? null,
          },
          consigneeDetails: srcPayload?.consigneeDetails || [],
          serviceDetails: srcPayload?.serviceDetails || {},
          rateContractConfig: {
            ...meta,
            rateContractNumber: rateContract.contractNumber || `RC-${rateContract.id}`,
            contractTitle: realTitle,
            contractDescription: meta.contractDescription || '',
            contractCategory: realCategory,
            periodStartDate: startDateStr,
            periodEndDate: endDateStr,
            rateValidityPeriod: meta.rateValidityPeriod || '',
            supplierSelectionStrategy: meta.supplierSelectionStrategy || '',
            selectedSuppliers: meta.selectedSuppliers || [],
            itemRateSchedule: meta.itemRateSchedule || [],
            priceVariationClause: meta.priceVariationClause || '',
            callOffOrderAllowed: Boolean(meta.callOffOrderAllowed),
            maximumOrderQuantityPerCallOff: meta.maximumOrderQuantityPerCallOff || 0,
            minimumOrderQuantity: meta.minimumOrderQuantity || 0,
            deliverySla: meta.deliverySla || '',
            penaltyClause: meta.penaltyClause || '',
            securityDepositRequired: Boolean(meta.securityDepositRequired),
            securityDepositAmount: meta.securityDepositAmount ? Number(meta.securityDepositAmount) : 0,
            contractDocument: meta.contractDocument || null,
          },
          documents: contractDocs,
          requiredDocs: srcPayload?.requiredDocs || [],
          items: items,
        },
        termsAndConditions: [
          `Validity: ${startDateStr} to ${endDateStr}`,
          meta.rateValidityPeriod ? `Rate Validity: ${meta.rateValidityPeriod}` : null,
          meta.callOffOrderAllowed !== undefined ? `Call-off Orders: ${meta.callOffOrderAllowed ? 'Allowed' : 'Not Allowed'}` : null,
          meta.priceVariationClause ? `Price Variation: ${meta.priceVariationClause}` : null,
        ].filter(Boolean),
        eligibilityCriteria: meta.selectedSuppliers ? meta.selectedSuppliers.map((s: any) => s.supplierName || `Supplier ${s.supplierId}`) : [],
        requiredDocuments: contractDocs,
        createdAt: rateContract.createdAt,
        updatedAt: rateContract.updatedAt,
        buyerOrganization: srcReq?.organization || srcReq?.buyerOrganization || { organizationName: meta.buyerOrganizationName },
        buyer: srcReq?.buyer || srcReq?.createdBy || actor,
        documents: contractDocs,
        participations: combinedParticipations,
        participantsCount: combinedParticipations.length,
        items,
        approvalAuthority: srcPayload?.internal?.approvalAuthority || '',
        justification: srcPayload?.internal?.justification || meta.contractDescription || '',
        internalDetails: {
          orgName: srcReq?.buyerOrganization?.organizationName || srcReq?.organization?.organizationName || meta.buyerOrganizationName || '',
          department: srcReq?.buyer?.buyerProfile?.departmentName || srcReq?.createdBy?.buyerProfile?.departmentName || srcPayload?.internal?.department || '',
          contactPerson: srcReq?.buyer?.buyerProfile?.representativeName || srcReq?.createdBy?.buyerProfile?.representativeName || srcPayload?.internal?.contactPerson || '',
          email: srcReq?.buyer?.email || srcReq?.createdBy?.email || srcReq?.buyer?.buyerProfile?.email || srcReq?.createdBy?.buyerProfile?.email || srcPayload?.internal?.email || '',
          mobile: srcReq?.buyer?.mobile || srcReq?.createdBy?.mobile || srcReq?.buyer?.buyerProfile?.mobile || srcReq?.createdBy?.buyerProfile?.mobile || srcPayload?.internal?.mobile || '',
          internalFileNumber: srcPayload?.internal?.internalFileNumber || '',
          justification: srcPayload?.internal?.justification || meta.contractDescription || '',
          budgetConfirmed: srcPayload?.internal?.budgetConfirmed ?? true,
          competentAuthority: srcPayload?.internal?.competentAuthority || '',
          approvalAuthority: srcPayload?.internal?.approvalAuthority || '',
        },
        sourceModel: 'RATE_CONTRACT',
        sourceId: rateContract.id
      };

      return apiResponse.success(res, synthesizedRateContract, 200, 'Rate Contract details fetched successfully');
    }
  }

  let bid: any;
  try {
    bid = await service.resolveBid(originalToken, service.leanBidInclude);

    // MINIMAL FIX: Load legacy responses if native participations are empty
    if (bid && bid.participations && bid.participations.length === 0 && bid.bidNumber && bid.bidNumber.startsWith('REQ-')) {
      const legacyReq = await prisma.requirement.findFirst({ where: { requirementNumber: bid.bidNumber } });
      if (legacyReq) {
        const legacyResponses = await prisma.requirementResponse.findMany({
          where: { requirementId: legacyReq.id },
          include: {
            sellerUser: { select: { id: true, name: true, email: true, mobile: true, role: true, organizationId: true } },
            sellerOrganization: { select: { organizationName: true } }
          }
        });
        bid.participations = legacyResponses.map((r: any) => {
          const respData = typeof r.responseData === 'string' ? JSON.parse(r.responseData) : (r.responseData || {});
          const rawDocs: any[] = Array.isArray(respData.documents) ? respData.documents : [];
          const docs = rawDocs.map((d: any, idx: number) => ({
            id: d.id || `rdoc-${r.id}-${idx}`,
            documentName: d.documentName || d.name || d.fileName || 'Document',
            fileName: d.fileName || d.name || 'file.pdf',
            fileUrl: d.fileUrl || d.url || null,
            fileKey: d.fileKey || null,
            fileAssetId: d.fileAssetId || null,
            documentCategory: d.documentCategory || d.category || 'TECHNICAL_PROPOSAL',
            mimeType: d.mimeType || 'application/pdf',
            documentStatus: d.documentStatus || 'UPLOADED',
            uploadedAt: d.uploadedAt || r.createdAt,
          }));
          if (r.attachmentUrl && !docs.some((d: any) => d.fileUrl === r.attachmentUrl || d.url === r.attachmentUrl)) {
            docs.unshift({
              id: `att-${r.id}`,
              documentName: 'Uploaded Quote Attachment',
              fileName: 'Quotation_Attachment.pdf',
              fileUrl: r.attachmentUrl,
              fileKey: null,
              fileAssetId: null,
              documentCategory: 'TECHNICAL_PROPOSAL',
              mimeType: 'application/pdf',
              documentStatus: 'UPLOADED',
              uploadedAt: r.createdAt,
            });
          }
          return {
            id: r.id,
            bidId: bid.id,
            sellerId: r.sellerUserId,
            seller: { ...r.sellerUser, organization: r.sellerOrganization },
            participationNumber: `PRT-${r.id}`,
            technicalStatus: r.status === 'SHORTLISTED' || r.status === 'ACCEPTED' ? 'QUALIFIED' : (r.status === 'REJECTED' ? 'DISQUALIFIED' : 'PENDING'),
            financialStatus: 'OPENED',
            financialSealed: false,
            finalStatus: r.status === 'ACCEPTED' ? 'AWARDED' : 'PENDING',
            submissionStatus: 'SUBMITTED',
            quotedAmount: r.offeredPrice,
            totalAmount: r.offeredPrice,
            offeredQuantity: r.offeredQuantity,
            deliveryTimeline: r.deliveryTimeline || respData.deliveryTimeline,
            terms: r.terms || respData.terms,
            makeBrand: respData.makeBrand || r.makeBrand,
            model: respData.model || r.model,
            offeredItemDescription: r.message || '',
            responseData: respData,
            lineItems: Array.isArray(respData.lineItems) ? respData.lineItems : [],
            documents: docs,
            createdAt: r.createdAt,
            submittedAt: r.createdAt,
          };
        });
      }
    }
  } catch (err: any) {
    const isPrefixed = CANONICAL_METHOD_PREFIXES.some(p => token.startsWith(`${p}-`));
    if (err?.code === 'BID_NOT_FOUND' && (/^\d+$/.test(token) || isPrefixed)) {
      const numMatch = token.match(/\d+$/);
      const parsedId = /^\d+$/.test(token)
        ? Number(token)
        : (numMatch ? Number(numMatch[0]) : null);
      let requirement = null;

      if (Number.isFinite(parsedId) && parsedId > 0 && parsedId <= 2147483647) {
        const buyerReq = await prisma.buyerRequirement.findFirst({
          where: { id: parsedId },
          include: {
            buyerOrganization: { select: { id: true, organizationName: true, organizationType: true, verificationStatus: true, city: true, district: true, state: true } },
            category: true,
            createdBy: { select: { id: true, name: true, email: true, mobile: true, role: true, buyerProfile: { select: { departmentName: true, representativeName: true, email: true, mobile: true } } } },
          }
        });
        if (buyerReq) {
          requirement = buyerReq as any;
          // Map to match the shape expected by the frontend
          requirement.organization = buyerReq.buyerOrganization;
          requirement.buyer = buyerReq.createdBy;
          requirement.buyerId = buyerReq.createdById;
          requirement.organizationId = buyerReq.buyerOrganizationId;
          requirement.requirementNumber = formatRequirementNumber(buyerReq.id);
          
          requirement.payload = {
            basics: {
              title: buyerReq.title,
              description: buyerReq.description,
              quantity: buyerReq.quantity,
              unit: buyerReq.unit,
              category: buyerReq.category?.name,
              budgetMin: buyerReq.budgetMin,
              budgetMax: buyerReq.budgetMax,
              deliveryLocation: buyerReq.location,
            },
            internal: {
              contactPerson: buyerReq.contactPerson,
              email: buyerReq.createdBy?.email || buyerReq.createdBy?.buyerProfile?.email,
              mobile: buyerReq.createdBy?.mobile || buyerReq.createdBy?.buyerProfile?.mobile,
            },
            schedule: {
              submissionDate: buyerReq.lastDate,
            },
            terms: {
              termsAndConditions: buyerReq.terms ? [buyerReq.terms] : [],
            },
            requiredDocs: buyerReq.requiredDocuments || [],
          };
        }
      }

      if (!requirement) {
        const searchTokens = getCanonicalLookupVariants(token);
        requirement = await prisma.requirement.findFirst({
          where: {
            OR: [
              ...(Number.isFinite(parsedId) && parsedId > 0 && parsedId <= 2147483647 ? [{ id: parsedId }] : []),
              { requirementNumber: { in: searchTokens } },
            ]
          },
          include: {
            items: true,
            organization: { select: { id: true, organizationName: true, organizationType: true, verificationStatus: true, city: true, district: true, state: true } },
            category: true,
            buyer: { select: { id: true, name: true, email: true, mobile: true, role: true, buyerProfile: { select: { departmentName: true, representativeName: true, email: true, mobile: true } } } },
          }
        });
      }

      // Check RateContract if requirement still not resolved
      if (!requirement) {
        const contract = await (prisma as any).contract.findFirst({
          where: {
            OR: [
              { contractNumber: token },
              { id: Number(token.replace(/^(RC-|RATE-)/, '')) || 0 }
            ]
          }
        });
        if (contract) {
          const meta = (contract.metadata || {}) as any;
          const reqId = Number(meta.requirementId || 0);
          const reqNum = meta.requirementNumber;
          if (reqId || reqNum) {
            requirement = await prisma.requirement.findFirst({
              where: { OR: [{ id: reqId }, { requirementNumber: reqNum }] },
              include: {
                items: true,
                organization: { select: { id: true, organizationName: true, organizationType: true, verificationStatus: true, city: true, district: true, state: true } },
                category: true,
                buyer: { select: { id: true, name: true, email: true, mobile: true, role: true, buyerProfile: { select: { departmentName: true, representativeName: true, email: true, mobile: true } } } },
              }
            });
          }
          if (!requirement) {
            // Synthesize requirement directly from RateContract
            requirement = {
              id: contract.id,
              requirementNumber: contract.contractNumber || `RC-${contract.id}`,
              title: contract.title || meta.contractTitle || `Rate Contract ${contract.contractNumber}`,
              description: meta.contractDescription || '',
              buyerId: meta.buyerId || 0,
              organizationId: meta.buyerOrganizationId || 0,
              status: String(contract.status || 'ACTIVE'),
              estimatedValue: Number(contract.value || 0),
              createdAt: contract.createdAt,
              updatedAt: contract.updatedAt,
              items: Array.isArray(meta.itemRateSchedule) ? meta.itemRateSchedule.map((i: any) => ({
                itemName: i.itemName,
                quantity: i.estimatedAnnualQuantity,
                unitOfMeasure: i.uom,
                specifications: i
              })) : [],
              organization: { organizationName: meta.buyerOrganizationName || 'Buyer Org' },
              buyer: null,
              payload: {
                basics: {
                  title: contract.title,
                  description: meta.contractDescription,
                  category: meta.contractCategory,
                  deliveryLocation: meta.deliverySla
                }
              }
            } as any;
          }
        }
      }

      if (requirement) {
        let participations: any[] = [];
        let targetRequirementId = requirement.id;

        if (!('createdById' in requirement)) {
            const shadowBuyerReq = await prisma.buyerRequirement.findFirst({
                where: {
                    title: requirement.title,
                    description: requirement.description || requirement.title,
                    createdById: requirement.buyerId,
                    buyerOrganizationId: requirement.organizationId || requirement.buyer?.organizationId || null
                }
            });
            if (shadowBuyerReq) {
                targetRequirementId = shadowBuyerReq.id;
            }
        }

        const requirementIdsToQuery = Array.from(new Set([requirement.id, targetRequirementId].filter(Boolean) as number[]));

        const mapLegacyResponse = (r: any) => {
            const respData = typeof r.responseData === 'string' ? JSON.parse(r.responseData) : (r.responseData || {});
            const rawDocs: any[] = Array.isArray(respData.documents) ? respData.documents : [];
            const docs = rawDocs.map((d: any, idx: number) => ({
                id: d.id || `rdoc-${r.id}-${idx}`,
                documentName: d.documentName || d.name || d.fileName || 'Document',
                fileName: d.fileName || d.name || 'file.pdf',
                fileUrl: d.fileUrl || d.url || null,
                fileKey: d.fileKey || null,
                fileAssetId: d.fileAssetId || null,
                documentCategory: d.documentCategory || d.category || 'TECHNICAL_PROPOSAL',
                mimeType: d.mimeType || 'application/pdf',
                documentStatus: d.documentStatus || 'UPLOADED',
                uploadedAt: d.uploadedAt || r.createdAt,
            }));
            if (r.attachmentUrl && !docs.some((d: any) => d.fileUrl === r.attachmentUrl || d.url === r.attachmentUrl)) {
                docs.unshift({
                    id: `att-${r.id}`,
                    documentName: 'Uploaded Quote Attachment',
                    fileName: 'Quotation_Attachment.pdf',
                    fileUrl: r.attachmentUrl,
                    fileKey: null,
                    fileAssetId: null,
                    documentCategory: 'TECHNICAL_PROPOSAL',
                    mimeType: 'application/pdf',
                    documentStatus: 'UPLOADED',
                    uploadedAt: r.createdAt,
                });
            }
            return {
                id: r.id,
                bidId: requirement.id,
                sellerId: r.sellerUserId,
                seller: {
                    ...r.sellerUser,
                    organization: r.sellerOrganization
                },
                participationNumber: `PRT-${r.id}`,
                technicalStatus: r.status === 'SHORTLISTED' || r.status === 'ACCEPTED' ? 'QUALIFIED' : (r.status === 'REJECTED' ? 'DISQUALIFIED' : 'PENDING'),
                financialStatus: 'OPENED',
                financialSealed: false,
                finalStatus: r.status === 'ACCEPTED' ? 'AWARDED' : 'PENDING',
                submissionStatus: 'SUBMITTED',
                quotedAmount: r.offeredPrice,
                totalAmount: r.offeredPrice,
                offeredQuantity: r.offeredQuantity,
                deliveryTimeline: r.deliveryTimeline || respData.deliveryTimeline,
                terms: r.terms || respData.terms,
                makeBrand: respData.makeBrand || r.makeBrand,
                model: respData.model || r.model,
                offeredItemDescription: r.message || '',
                responseData: respData,
                lineItems: Array.isArray(respData.lineItems) ? respData.lineItems : [],
                documents: docs,
                createdAt: r.createdAt,
                submittedAt: r.createdAt,
            };
        };

        if (actor?.role === 'buyer' || actor?.role === 'admin' || actor?.role === 'master_admin') {
            const responses = await prisma.requirementResponse.findMany({
                where: { requirementId: { in: requirementIdsToQuery } },
                include: { 
                    sellerUser: { select: { id: true, name: true, email: true, mobile: true, role: true, organizationId: true } },
                    sellerOrganization: { select: { organizationName: true } }
                }
            });

            // Also query ProcurementBidParticipation if linked
            const bidParticipations = await (prisma as any).procurementBidParticipation.findMany({
                where: {
                  OR: [
                    { bidId: requirement.id },
                    { bid: { bidNumber: requirement.requirementNumber } }
                  ]
                },
                include: {
                  seller: { include: { organization: true } },
                  documents: true
                }
            }).catch(() => []);

            const mappedLegacy = responses.map(mapLegacyResponse);
            participations = [...mappedLegacy, ...bidParticipations];
        } else if (actor?.role === 'seller' && actor?.id) {
            // Under sealed bidding, sellers may strictly ONLY see their OWN response
            const responses = await prisma.requirementResponse.findMany({
                where: {
                    requirementId: { in: requirementIdsToQuery },
                    OR: [
                        { sellerUserId: Number(actor.id) },
                        ...(actor.organizationId ? [{ sellerOrganizationId: actor.organizationId }] : [])
                    ]
                },
                include: { 
                    sellerUser: { select: { id: true, name: true, email: true, mobile: true, role: true, organizationId: true } },
                    sellerOrganization: { select: { organizationName: true } }
                }
            });

            const bidParticipations = await (prisma as any).procurementBidParticipation.findMany({
                where: {
                  bidId: requirement.id,
                  OR: [
                    { sellerId: Number(actor.id) },
                    ...(actor.organizationId ? [{ seller: { organizationId: actor.organizationId } }] : [])
                  ]
                },
                include: {
                  seller: { include: { organization: true } },
                  documents: true
                }
            }).catch(() => []);

            const mappedLegacy = responses.map(mapLegacyResponse);
            participations = [...mappedLegacy, ...bidParticipations];
        }

        const payload = requirement.payload && typeof requirement.payload === 'object' ? requirement.payload as any : {};
        const reqMeta = (requirement as any).metadata || {};
        const isRateContract = Boolean(requirement.isRateContract || requirement.contractNumber || String(token).startsWith('RC-') || String(token).startsWith('RATE-'));
        const contractTitle = requirement.contractTitle || reqMeta.contractTitle || requirement.title || payload.basics?.title;

        // If legacy requirement doesn't have basics/internal/schedule/terms in payload, reconstruct them
        const basics = payload.basics || {
          title: contractTitle || requirement.title,
          description: requirement.description,
          quantity: requirement.items?.[0]?.quantity,
          unit: requirement.items?.[0]?.unitOfMeasure,
          category: requirement.category?.name,
          estimatedValue: requirement.estimatedValue,
          deliveryLocation: [requirement.organization?.district, requirement.organization?.state].filter(Boolean).join(', ')
        };
        const schedule = payload.schedule || {
          submissionDate: requirement.requiredBy || requirement.createdAt
        };
        const terms = payload.terms || {};
        const internal = payload.internal || {
          contactPerson: requirement.buyer?.buyerProfile?.contactPerson || requirement.buyer?.name,
          email: requirement.buyer?.email || requirement.buyer?.buyerProfile?.email,
          mobile: requirement.buyer?.mobile || requirement.buyer?.buyerProfile?.mobile
        };

        // Merge back into payload so frontend technicalPacket has these fields
        if (contractTitle && !basics.title) basics.title = contractTitle;
        payload.basics = basics;
        payload.schedule = schedule;
        payload.terms = terms;
        payload.internal = internal;
        
        let reqDocuments: any[] = [];
        if (requirement?.id) {
          const fileAssets = await (prisma as any).fileAsset.findMany({
            where: {
              OR: [
                { entityType: 'requirement', entityId: Number(requirement.id) },
                { entityType: 'procurement_bid', entityId: Number(requirement.id) }
              ],
              status: 'active'
            }
          }).catch(() => []);
          reqDocuments = (fileAssets || []).map((asset: any) => ({
            id: asset.id,
            documentType: 'REQUIRED_DOCUMENT',
            fileName: asset.originalName,
            mimeType: asset.mimeType,
            fileSize: asset.size,
            visibility: 'PUBLIC',
            fileAssetId: asset.id,
            fileUrl: asset.url || `/api/files/${asset.id}/view`
          }));
        }

        const cleanContractTitle = contractTitle && contractTitle !== 'Procurement Bid' ? contractTitle : null;
        const cleanReqTitle = requirement.title && requirement.title !== 'Procurement Bid' ? requirement.title : null;
        const resolvedTitle = cleanContractTitle
          || cleanReqTitle
          || basics.title
          || basics.contractTitle
          || (requirement.items && requirement.items[0] ? (requirement.items[0].itemName || requirement.items[0].name) : null)
          || (requirement.requirementNumber ? `${isRateContract ? 'Rate Contract' : 'Procurement'} ${requirement.requirementNumber}` : 'Procurement Opportunity');

        const synthesized = {
          id: requirement.id,
          bidNumber: requirement.requirementNumber || `REQ-${requirement.id}`,
          title: resolvedTitle,
          description: requirement.description || basics.description || '',
          buyerId: requirement.buyerId,
          buyerOrganizationName: requirement.organization?.organizationName || internal.orgName || basics.buyerOrganizationName || '',
          buyerType: requirement.organization?.organizationType || requirement.buyerOrganization?.organizationType || basics.buyerType || 'Private Enterprise',
          departmentName: requirement.buyer?.buyerProfile?.departmentName || internal.departmentName || 'Procurement',
          category: basics.category || requirement.category?.name || (isRateContract ? 'Rate Contract' : 'General procurement'),
          categoryType: basics.procurementCategory || payload.procurementCategory || payload.categoryType || (isRateContract ? 'GOODS' : 'GOODS'),
          pricingFormat: basics.pricingFormat || payload.pricingFormat || (isRateContract ? 'SOR' : 'SINGLE_ITEM'),
          bidType: isRateContract ? 'Rate Contract' : (basics.procurementCategory === 'SERVICES' ? 'Service' : basics.procurementCategory === 'WORKS' ? 'Works' : 'Product'),
          procurementType: isRateContract ? 'Rate Contract' : (requirement.procurementMethod || payload.recommendation?.id || 'RFQ'),
          quantity: basics.quantity ? Number(basics.quantity) : (requirement.items?.[0]?.quantity || null),
          unit: basics.unit || requirement.items?.[0]?.unitOfMeasure || '',
          estimatedValue: Number(requirement.estimatedValue || basics.estimatedValue || 0),
          deliveryLocation: basics.deliveryLocation || internal.deliveryAddress || [requirement.organization?.district, requirement.organization?.state].filter(Boolean).join(', ') || '',
          state: requirement.organization?.state || '',
          district: requirement.organization?.district || '',
          startDate: schedule.publishDate ? parseDateIST(schedule.publishDate) : (schedule.submissionStartDate ? parseDateIST(schedule.submissionStartDate) : requirement.createdAt),
          endDate: (schedule.submissionDate || schedule.submissionDeadline || payload.tender?.bidClosingDate) ? parseDateIST(schedule.submissionDate || schedule.submissionDeadline || payload.tender?.bidClosingDate, true) : (requirement.requiredBy ? parseDateIST(requirement.requiredBy, true) : requirement.createdAt),
          submissionStartDate: (schedule.submissionStartDate || schedule.startDate || payload.tender?.bidStartDate) ? parseDateIST(schedule.submissionStartDate || schedule.startDate || payload.tender?.bidStartDate) : null,
          technicalOpeningDate: (schedule.technicalOpeningDate || payload.tender?.technicalEvaluationDate || payload.technicalOpeningDate) ? parseDateIST(schedule.technicalOpeningDate || payload.tender?.technicalEvaluationDate || payload.technicalOpeningDate) : null,
          financialOpeningDate: (schedule.financialOpeningDate || payload.tender?.financialEvaluationDate || payload.financialOpeningDate) ? parseDateIST(schedule.financialOpeningDate || payload.tender?.financialEvaluationDate || payload.financialOpeningDate) : null,
          status: requirement.status === 'APPROVED' ? 'OPEN' : requirement.status || 'OPEN',
          approvalStatus: requirement.status || 'APPROVED',
          lifecycleStage: 'SELLER_PARTICIPATION',
          evaluationMethod: 'L1',
          isEmdRequired: false,
          emdAmount: null,
          documentFee: null,
          allowClarification: schedule.clarificationAllowed !== false && schedule.clarificationAllowed !== 'false' && schedule.allowClarifications !== false,
          allowReverseAuction: false,
          packetType: (
            String(schedule.packetType || payload.packetType || payload.rules?.packetType || '').toUpperCase().includes('TWO') ||
            String(schedule.packetType || payload.packetType || payload.rules?.packetType || '') === '2' ||
            Boolean(schedule.financialOpeningDate || payload.tender?.financialEvaluationDate || payload.financialOpeningDate)
          ) ? 'TWO_PACKET' : 'SINGLE_PACKET',
          technicalPacket: payload,
          termsAndConditions: terms.termsAndConditions || [],
          eligibilityCriteria: terms.eligibilityCriteria || basics.eligibilityCriteria || [],
          requiredDocuments: payload.requiredDocs || [],
          createdAt: requirement.createdAt,
          updatedAt: requirement.updatedAt,
          buyerOrganization: requirement.organization,
          buyer: requirement.buyer,
          documents: reqDocuments,
          participations: participations,
          results: (participations || []).map((p: any) => service.serializeParticipation(p, { canSeeFinancial: actor?.role !== 'seller' || Number(p.sellerId) === Number(actor?.id) })),
          clarifications: [],
          evaluations: [],
          awards: [],
          participantsCount: participations.length,
          sourceModel: isRateContract ? 'RATE_CONTRACT' : 'REQUIREMENT',
          sourceId: requirement.id,
          consigneeDetails: payload.consigneeDetails || null,
          items: requirement.items || [],
          approvalAuthority: internal.approvalAuthority || (requirement as any).approvalAuthority || '',
          justification: internal.justification || basics.justification || (requirement as any).justification || '',
          internalDetails: internal,
        };
        return apiResponse.success(res, synthesized, 200, 'Requirement-based bid details fetched successfully');
      }
    }
    throw err;
  }

  // Access gate: public bids are viewable by anyone; private (invite-only) bids only by
  // the owner, an invited seller, a participant, or an admin. 404 (not 403) to avoid
  // leaking the existence of a private procurement.
  if (!service.canActorViewBid(currentActor as any, bid)) {
    throw new ApiError(404, 'Bid not found', 'BID_NOT_FOUND');
  }
  await enrichBidsWithResponses([bid], currentActor?.role === 'buyer' ? Number(currentActor.id) : undefined);
  const isBuyerOrAdmin = currentActor?.role === 'buyer' || currentActor?.role === 'admin' || currentActor?.role === 'master_admin' || (!!currentActor?.id && Number(bid.buyerId) === Number(currentActor.id));
  const sellerCanSeeParticipants = currentActor?.role === 'seller' && (bid.participations || []).some((p: any) => (currentActor.id && p.sellerId === Number(currentActor.id)) || (currentActor.organizationId && p.seller?.organizationId === currentActor.organizationId));
  const sellerCanSeeCompetitors = sellerCanSeeParticipants && service.financialOpenStatuses.includes(bid.status);
  const includeParticipants = isBuyerOrAdmin || sellerCanSeeCompetitors;
  const includeFinancial = isBuyerOrAdmin || sellerCanSeeCompetitors;

  const sellerIds = (bid.participations || []).map((p: any) => p.sellerId);
  const sellerRatings = await service.getAverageRatingsForSellers(sellerIds);
  const serialized = service.serializeBid(bid, { actor: currentActor || undefined, detail: true, includeParticipants, includeFinancial, sellerRatings });
  await setCache(cacheKey, serialized, 30);
  return apiResponse.success(res, serialized, 200, 'Bid details fetched successfully');
}));

router.get('/procurement-bids/:bidId/timeline', validate({ params: idParamSchema }), asyncRoute(async (req, res) => {
  const bid = await service.resolveBid(req.params.bidId, {});
  const timeline = await service.getProcurementTimeline(bid.id);
  return apiResponse.success(res, timeline, 200, 'Procurement lifecycle timeline fetched');
}));

router.post('/procurement-bids/:bidId/participate', authenticate, requireAccountType('seller'), requirePermission('bid.submit'), validate({ params: idParamSchema }), asyncRoute(async (req, res) => {
  const participation = await service.startParticipation(req, req.params.bidId);
  const token = req.params.bidId;
  await deleteCache(`cache:proc_bid_${token}_${req.user!.id}_seller`);
  await deleteCache(`cache:proc_bid_${token}_anon_guest`);
  return apiResponse.created(res, participation, 'Bid participation started');
}));

router.post('/procurement-bids/:bidId/participation/:participationId/technical-documents', authenticate, requireAccountType('seller'), requirePermission('bid.submit'), upload.single('file'), validate({ params: participationParamSchema }), asyncRoute(async (req, res) => {
  const category = String(req.body.documentCategory || 'TECHNICAL_COMPLIANCE');
  const doc = await service.uploadParticipationDocument(req, req.params.bidId, Number(req.params.participationId), category);
  return apiResponse.created(res, doc, 'Technical document uploaded');
}));

router.post('/procurement-bids/:bidId/participation/:participationId/financial-quote', authenticate, requireAccountType('seller'), requirePermission('bid.submit'), upload.single('file'), validate({ params: participationParamSchema, body: financialQuoteSchema }), asyncRoute(async (req, res) => {
  const data = await service.saveFinancialQuote(req, req.params.bidId, Number(req.params.participationId), req.body);
  return apiResponse.success(res, data, 200, 'Financial quote saved securely');
}));

router.post('/procurement-bids/:bidId/participation/:participationId/submit', authenticate, requireAccountType('seller'), requirePermission('bid.submit'), validate({ params: participationParamSchema, body: z.object({ acceptedTerms: z.boolean().optional() }).passthrough().optional() }), asyncRoute(async (req, res) => {
  const data = await service.finalSubmitParticipation(req, req.params.bidId, Number(req.params.participationId), req.body || {});
  const token = req.params.bidId;
  await deleteCache(`cache:proc_bid_${token}_${req.user!.id}_seller`);
  await deleteCache(`cache:proc_bid_${token}_anon_guest`);
  return apiResponse.success(res, data, 200, 'Participation submitted successfully');
}));

router.get('/seller/procurement-bids', authenticate, requireAccountType('seller'), asyncRoute(async (req, res) => {
  const sellerFilters: any[] = [{ sellerId: req.user!.id }];
  if (req.user?.organizationId) {
    sellerFilters.push({ seller: { organizationId: req.user.organizationId } });
  }
  const rows = await (prisma as any).procurementBidParticipation.findMany({
    where: { OR: sellerFilters },
    include: { bid: true, documents: true, clarifications: { include: { files: true } }, evaluations: true, awards: true },
    orderBy: { createdAt: 'desc' }
  });
  return apiResponse.success(res, rows.map((row: any) => ({ ...service.serializeParticipation(row, { canSeeFinancial: true, ownView: true }), bid: service.serializeBid(row.bid, { actor: req.user }) })), 200, 'Seller bids fetched');
}));

router.get('/seller/procurement-bids/:bidId/invoice', authenticate, requireAccountType('seller'), validate({ params: idParamSchema }), asyncRoute(async (req, res) => {
  const bid = await service.resolveBid(req.params.bidId, {});
  const bidId = bid.id;
  
  const award = await (prisma as any).procurementBidAward.findFirst({
    where: { 
      bidId, 
      sellerId: req.user!.id, 
      awardStatus: { in: ['ADMIN_APPROVED', 'ACCEPTED'] } 
    },
    orderBy: { createdAt: 'desc' }
  });
  
  if (!award) {
    return apiResponse.success(res, { 
      exists: false, 
      isAwarded: false, 
      hasPO: false, 
      hasAcceptedPO: false, 
      canConvertToInvoice: false 
    }, 200, 'Invoice status fetched');
  }
  
  const po = await (prisma as any).purchaseOrder.findFirst({
    where: { sourceType: 'procurement_bid_award', sourceId: award.id }
  });
  
  if (!po) {
    return apiResponse.success(res, { 
      exists: false, 
      isAwarded: true, 
      hasPO: false, 
      hasAcceptedPO: false, 
      canConvertToInvoice: false 
    }, 200, 'Invoice status fetched');
  }

  const isPoAccepted = ['accepted', 'ACCEPTED'].includes(String(po.status || po.poStatus || ''));
  if (!isPoAccepted) {
    return apiResponse.success(res, { 
      exists: false, 
      isAwarded: true, 
      hasPO: true, 
      hasAcceptedPO: false, 
      canConvertToInvoice: false,
      poId: po.id,
      poNumber: po.poNumber 
    }, 200, 'PO pending seller acceptance');
  }
  
  const invoice = await (prisma as any).invoice.findFirst({
    where: { purchaseOrderId: po.id }
  });
  
  if (invoice) {
    return apiResponse.success(res, { 
      exists: true, 
      invoiceId: invoice.id, 
      invoiceNumber: invoice.invoiceNumber, 
      isAwarded: true, 
      hasPO: true, 
      hasAcceptedPO: true, 
      canConvertToInvoice: false 
    }, 200, 'Invoice status fetched');
  }
  
  return apiResponse.success(res, { 
    exists: false, 
    isAwarded: true, 
    hasPO: true, 
    hasAcceptedPO: true, 
    canConvertToInvoice: true,
    poId: po.id,
    poNumber: po.poNumber 
  }, 200, 'Invoice status fetched');
}));

router.post('/seller/procurement-bids/:bidId/convert-to-invoice', authenticate, requireAccountType('seller'), validate({ params: idParamSchema }), asyncRoute(async (req, res) => {
  const bid = await service.resolveBid(req.params.bidId, {});
  const bidId = bid.id;
  
  const award = await (prisma as any).procurementBidAward.findFirst({
    where: { 
      bidId, 
      sellerId: req.user!.id, 
      awardStatus: { in: ['ADMIN_APPROVED', 'ACCEPTED'] } 
    },
    orderBy: { createdAt: 'desc' }
  });
  
  if (!award) throw new ApiError(403, 'You must be the awarded seller to generate an invoice for this procurement.', 'AWARD_NOT_FOUND');
  
  const po = await (prisma as any).purchaseOrder.findFirst({
    where: { sourceType: 'procurement_bid_award', sourceId: award.id }
  });
  
  if (!po) throw new ApiError(400, 'Purchase order has not been generated for this award yet.', 'PO_NOT_FOUND');

  const isPoAccepted = ['accepted', 'ACCEPTED'].includes(String(po.status || po.poStatus || ''));
  if (!isPoAccepted) {
    throw new ApiError(400, 'You must accept the Purchase Order before converting it to an invoice.', 'PO_NOT_ACCEPTED');
  }
  
  let invoice = await (prisma as any).invoice.findFirst({
    where: { purchaseOrderId: po.id }
  });
  
  if (invoice) {
    return apiResponse.success(res, invoice, 200, 'Existing invoice returned');
  }
  
  const actor = {
    id: Number(req.user!.id),
    role: req.user!.role,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  };
    try {
      invoice = await fulfillmentWorkflow.createInvoice(actor, { purchaseOrderId: po.id });
      return apiResponse.created(res, invoice, 'Invoice created successfully');
    } catch (error: any) {
      console.error('[CONVERT_TO_INVOICE_ERROR]', error);
      throw new ApiError(500, error?.message || 'Failed to generate invoice from purchase order.', 'INVOICE_GENERATION_FAILED', error);
    }
  }));

router.get('/seller/procurement-bids/:bidId/status', authenticate, requireAccountType('seller'), validate({ params: idParamSchema }), asyncRoute(async (req, res) => {
  const bid = await service.resolveBid(req.params.bidId, { participations: { where: { OR: [{ sellerId: req.user!.id }, ...(req.user!.organizationId ? [{ seller: { organizationId: req.user!.organizationId } }] : [])] }, include: { documents: true, clarifications: { include: { files: true } }, evaluations: true, awards: true } } });
  await enrichBidsWithResponses([bid], req.user!.id);
  const participation = bid.participations?.find((p: any) => p.sellerId === req.user!.id || (req.user!.organizationId && p.seller?.organizationId === req.user!.organizationId)) || null;
  const isRestrictedBid = service.isRestrictedBidMethod(bid);
  if (isRestrictedBid) {
    if (!participation && !service.isActorInvitedToBid(req.user as any, bid)) {
      throw new ApiError(404, 'Bid not found', 'BID_NOT_FOUND');
    }
  }
  return apiResponse.success(res, { bid: service.serializeBid(bid, { actor: req.user }), participation: participation ? service.serializeParticipation(participation, { canSeeFinancial: true, bid, ownView: true }) : null }, 200, 'Bid status fetched');
}));

router.post('/procurement-bids/:bidId/clarifications/:clarificationId/respond', authenticate, requireAccountType('seller'), requirePermission('bid.submit'), upload.single('file'), validate({ params: clarificationParamSchema, body: z.object({ response: z.string().trim().min(2).max(5000) }) }), asyncRoute(async (req, res) => {
  const data = await service.respondClarification(req, req.params.bidId, Number(req.params.clarificationId), req.body.response);
  return apiResponse.success(res, data, 200, 'Clarification response submitted');
}));

router.post('/procurement-bids/:bidId/clarifications/ask', authenticate, requireAccountType('seller'), requirePermission('bid.submit'), validate({ params: idParamSchema, body: z.object({ question: z.string().trim().min(5).max(3000) }) }), asyncRoute(async (req, res) => {
  const data = await service.sellerAskClarification(req, req.params.bidId, req.body.question);
  return apiResponse.created(res, data, 'Clarification question submitted successfully');
}));

router.post('/buyer/procurement-bids', authenticate, requireAccountType('buyer'), requirePermission('tender.create'), validate({ body: bidBodySchema }), asyncRoute(async (req, res) => {
  const bid = await service.createBuyerBid(req, req.body);
  return apiResponse.created(res, bid, 'Bid draft created');
}));

router.get('/buyer/procurement-bids/:bidId/edit-eligibility', authenticate, requireAccountType('buyer'), validate({ params: idParamSchema }), asyncRoute(async (req, res) => {
  const eligibility = await service.getBidEditEligibility(req, req.params.bidId);
  return apiResponse.success(res, eligibility, 200, 'Edit eligibility retrieved');
}));

router.put('/buyer/procurement-bids/:bidId', authenticate, requireAccountType('buyer'), requirePermission('tender.update'), validate({ params: idParamSchema, body: bidBaseSchema.partial() }), asyncRoute(async (req, res) => {
  const bid = await service.updateBuyerBid(req, req.params.bidId, req.body);
  await invalidateBidCaches(bid, req.params.bidId);
  return apiResponse.success(res, bid, 200, 'Bid updated');
}));

const extendScheduleSchema = z.object({
  closingDate: z.string().min(1, 'Closing date is required'),
  technicalOpeningDate: z.string().nullable().optional(),
  financialOpeningDate: z.string().nullable().optional(),
  requiredByDate: z.string().nullable().optional(),
  bidValidityDate: z.string().nullable().optional(),
  reason: z.string().trim().min(5, 'Please provide an extension reason (min 5 characters)').max(500),
});

router.post('/buyer/procurement-bids/:bidId/extend-schedule', authenticate, requireAccountType('buyer'), requirePermission('tender.update'), validate({ params: idParamSchema, body: extendScheduleSchema }), asyncRoute(async (req, res) => {
  const bid = await service.extendBidSchedule(req, req.params.bidId, req.body);
  await invalidateBidCaches(bid, req.params.bidId);
  return apiResponse.success(res, bid, 200, 'Tender schedule extended and corrigendum issued');
}));

router.post('/buyer/procurement-bids/:bidId/documents', authenticate, requireAccountType('buyer'), requirePermission('tender.update'), upload.single('file'), validate({ params: idParamSchema }), asyncRoute(async (req, res) => {
  const doc = await service.uploadBuyerBidDocument(req, req.params.bidId, req.body);
  return apiResponse.created(res, doc, 'Bid document uploaded');
}));

router.post('/buyer/procurement-bids/:bidId/submit-for-approval', authenticate, requireAccountType('buyer'), requirePermission('tender.publish'), validate({ params: idParamSchema }), asyncRoute(async (req, res) => {
  const bid = await service.submitForApproval(req, req.params.bidId);
  return apiResponse.success(res, bid, 200, 'Bid submitted for admin approval');
}));

export const enrichBidsWithResponses = async (bids: any[], _buyerId?: number) => {
  if (!bids || !bids.length) return bids;

  try {
    const normalizeStr = (str: any) => String(str || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

    // Extract relevant requirement IDs and tokens from the target bids to eliminate full-table scans
    const targetReqIds = new Set<number>();
    const targetReqNumbers = new Set<string>();
    const targetQuoteReqIds = new Set<number>();
    const targetBidNumbers = new Set<string>();

    for (const bid of bids) {
      if (!bid) continue;
      const bidIdNum = Number(bid.id || 0);
      const srcIdNum = Number(bid.sourceId || 0);
      const reqIdNum = Number(bid.requirementId || 0);
      const bidPacket = bid.technicalPacket && typeof bid.technicalPacket === 'object' ? bid.technicalPacket : {};
      const packetReqIdNum = Number(bidPacket.sourceRequirementId || bidPacket.requirementId || bidPacket.linkedRequirementId || 0);

      if (bidIdNum > 0) targetReqIds.add(bidIdNum);
      if (srcIdNum > 0) {
        targetReqIds.add(srcIdNum);
        if (String(bid.sourceModel || '').toUpperCase() === 'QUOTE_REQUEST') {
          targetQuoteReqIds.add(srcIdNum);
        }
      }
      if (reqIdNum > 0) targetReqIds.add(reqIdNum);
      if (packetReqIdNum > 0) targetReqIds.add(packetReqIdNum);

      if (bid.bidNumber) {
        const bn = String(bid.bidNumber).trim();
        targetBidNumbers.add(bn);
        if (/^\d+$/.test(bn)) {
          const num = Number(bn);
          if (num > 0 && num <= 2147483647) targetReqIds.add(num);
        }
      }
      if (bid.requirementNumber) {
        const rn = String(bid.requirementNumber).trim();
        targetReqNumbers.add(rn);
        if (/^\d+$/.test(rn)) {
          const num = Number(rn);
          if (num > 0 && num <= 2147483647) targetReqIds.add(num);
        }
      }
    }

    const reqIdsArray = Array.from(targetReqIds);
    const canonicalVariants = new Set<string>();
    for (const n of [...targetReqNumbers, ...targetBidNumbers]) {
      canonicalVariants.add(n);
      for (const v of getCanonicalLookupVariants(n)) {
        canonicalVariants.add(v);
      }
    }
    const reqNumsArray = Array.from(canonicalVariants);

    // If no candidate requirement IDs or numbers, return immediately without touching DB
    if (reqIdsArray.length === 0 && reqNumsArray.length === 0) {
      return bids;
    }

    // Fetch ONLY the matching requirements concurrently
    const [buyerReqs, legacyReqs, quoteRequests] = await Promise.all([
      prisma.buyerRequirement.findMany({
        where: {
          OR: [
            ...(reqIdsArray.length > 0 ? [{ id: { in: reqIdsArray } }] : []),
            ...(reqNumsArray.length > 0 ? [{ referenceNumber: { in: reqNumsArray } }] : [])
          ]
        },
        select: { id: true, title: true, referenceNumber: true, description: true, createdById: true, buyerOrganizationId: true }
      }).catch(() => []),
      prisma.requirement.findMany({
        where: {
          OR: [
            ...(reqIdsArray.length > 0 ? [{ id: { in: reqIdsArray } }] : []),
            ...(reqNumsArray.length > 0 ? [{ requirementNumber: { in: reqNumsArray } }] : [])
          ]
        },
        select: { id: true, title: true, requirementNumber: true, buyerId: true }
      }).catch(() => []),
      prisma.quoteRequest.findMany({
        where: {
          OR: [
            ...(reqIdsArray.length > 0 ? [{ id: { in: reqIdsArray } }] : []),
            ...(reqNumsArray.length > 0 ? [{ subject: { in: reqNumsArray } }] : [])
          ]
        },
        select: { id: true, subject: true, buyerId: true }
      }).catch(() => [])
    ]);

    const allMatchedReqIds = new Set<number>(reqIdsArray);
    for (const br of buyerReqs) allMatchedReqIds.add(Number(br.id));
    for (const lr of legacyReqs) allMatchedReqIds.add(Number(lr.id));

    const allMatchedQuoteReqIds = new Set<number>(Array.from(targetQuoteReqIds));
    for (const qr of quoteRequests) allMatchedQuoteReqIds.add(Number(qr.id));

    // Fetch ONLY the RequirementResponses and QuoteResponses matching these target IDs
    const [allReqResponses, quoteResponses] = await Promise.all([
      allMatchedReqIds.size > 0
        ? prisma.requirementResponse.findMany({
            where: {
              requirementId: { in: Array.from(allMatchedReqIds) },
              status: { not: 'DRAFT' }
            },
            include: {
              sellerUser: { select: { id: true, name: true, email: true, mobile: true, role: true, organizationId: true } },
              sellerOrganization: { select: { organizationName: true } }
            }
          }).catch(() => [])
        : Promise.resolve([]),
      allMatchedQuoteReqIds.size > 0
        ? prisma.quoteResponse.findMany({
            where: {
              quoteRequestId: { in: Array.from(allMatchedQuoteReqIds) },
              status: { not: 'DRAFT' }
            },
            include: {
              seller: { select: { id: true, name: true, email: true, mobile: true, role: true, organizationId: true } },
              quoteRequest: { select: { id: true, subject: true, buyerId: true } }
            }
          }).catch(() => [])
        : Promise.resolve([])
    ]);

    for (const bid of bids) {
      if (!Array.isArray(bid.participations)) {
        bid.participations = [];
      }

      const existingSellerIds = new Set(bid.participations.map((p: any) => p.sellerId).filter(Boolean));
      const bidSourceModel = String(bid.sourceModel || '').toUpperCase();
      const bidSourceIdNum = Number(bid.sourceId || 0);
      const bidReqIdNum = Number(bid.requirementId || 0);
      const bidNumberNorm = normalizeStr(bid.bidNumber);
      const bidReqNumNorm = normalizeStr(bid.requirementNumber);
      const bidPacket = bid.technicalPacket && typeof bid.technicalPacket === 'object' ? bid.technicalPacket : {};
      const packetReqIdNum = Number(bidPacket.sourceRequirementId || bidPacket.requirementId || bidPacket.linkedRequirementId || 0);
      const bidTitleNorm = normalizeStr(bid.title);
      const bidBuyerId = Number(bid.buyerId || 0);
      const bidBuyerOrganizationId = Number(bid.buyerOrganizationId || 0);

      // Match RequirementResponses for ALL procurement bids (RFQ, RFP, Open Tender, Limited Tender, Rate Contract, etc.)
      for (const r of allReqResponses) {
        const reqId = Number(r.requirementId);
        const responseRequirement = buyerReqs.find((br: any) => Number(br.id) === reqId);

        const isDirectSourceMatch = (bidSourceModel === 'REQUIREMENT' || bidSourceModel === 'BUYER_REQUIREMENT') && bidSourceIdNum > 0 && reqId === bidSourceIdNum;
        const isReqIdMatch = (bidReqIdNum > 0 && reqId === bidReqIdNum) || (packetReqIdNum > 0 && reqId === packetReqIdNum);

        // Check if reqId belongs to a legacyReq matching requirementNumber
        const matchedLegacyReq = legacyReqs.find(lr => lr.id === reqId && (
          (bidNumberNorm && normalizeStr(lr.requirementNumber) === bidNumberNorm) ||
          (bidReqNumNorm && normalizeStr(lr.requirementNumber) === bidReqNumNorm)
        ));
        const matchedBuyerReq = responseRequirement && (
          (bidNumberNorm && normalizeStr(responseRequirement.referenceNumber) === bidNumberNorm) ||
          (bidReqNumNorm && normalizeStr(responseRequirement.referenceNumber) === bidReqNumNorm)
        );
        const matchedByTitleAndBuyer = responseRequirement &&
          bidTitleNorm &&
          normalizeStr(responseRequirement.title) === bidTitleNorm &&
          Number(responseRequirement.createdById) === bidBuyerId;

        if (isDirectSourceMatch || isReqIdMatch || matchedLegacyReq || matchedBuyerReq || matchedByTitleAndBuyer) {
          const sellerId = r.sellerUserId;
          if (sellerId) {
            const respData = typeof r.responseData === 'string' ? JSON.parse(r.responseData) : (r.responseData || {});
            const rawDocs = Array.isArray(respData.documents) ? respData.documents : [];
            const documents = rawDocs.map((d: any, idx: number) => ({
              id: d.id || `rdoc-${r.id}-${idx}`,
              documentName: d.documentName || d.name || d.fileName || 'Document',
              fileName: d.fileName || d.name || 'file.pdf',
              fileUrl: d.fileUrl || d.url || null,
              fileKey: d.fileKey || null,
              fileAssetId: d.fileAssetId || null,
              documentCategory: d.documentCategory || d.category || 'TECHNICAL_PROPOSAL',
              mimeType: d.mimeType || 'application/pdf',
              documentStatus: d.documentStatus || 'UPLOADED',
              uploadedAt: d.uploadedAt || r.createdAt,
            }));
            if (r.attachmentUrl && !documents.some((d: any) => d.fileUrl === r.attachmentUrl || d.url === r.attachmentUrl)) {
              documents.unshift({
                id: `att-${r.id}`,
                documentName: 'Uploaded Quote Attachment',
                fileName: 'Quotation_Attachment.pdf',
                fileUrl: r.attachmentUrl,
                fileKey: null,
                fileAssetId: null,
                documentCategory: 'TECHNICAL_PROPOSAL',
                mimeType: 'application/pdf',
                documentStatus: 'UPLOADED',
                uploadedAt: r.createdAt,
              });
            }
            if (!existingSellerIds.has(sellerId)) {
              existingSellerIds.add(sellerId);
              bid.participations.push({
                id: r.id,
                bidId: bid.id,
                sellerId: sellerId,
                seller: {
                  ...r.sellerUser,
                  organization: r.sellerOrganization
                },
                participationNumber: `PRT-REQ-${r.id}`,
                technicalStatus: r.status === 'SHORTLISTED' || r.status === 'ACCEPTED' ? 'QUALIFIED' : (r.status === 'REJECTED' ? 'DISQUALIFIED' : 'PENDING'),
                financialStatus: 'OPENED',
                financialSealed: false,
                finalStatus: r.status === 'ACCEPTED' ? 'AWARDED' : 'PENDING',
                submissionStatus: 'SUBMITTED',
                quotedAmount: Number(r.offeredPrice || 0),
                totalAmount: Number(r.offeredPrice || 0),
                offeredQuantity: r.offeredQuantity ? Number(r.offeredQuantity) : 1,
                deliveryTimeline: r.deliveryTimeline || respData.deliveryTimeline,
                terms: r.terms || respData.terms,
                makeBrand: respData.makeBrand || r.makeBrand,
                model: respData.model || r.model,
                offeredItemDescription: r.message || '',
                responseData: respData,
                lineItems: Array.isArray(respData.lineItems) ? respData.lineItems : [],
                documents,
                createdAt: r.createdAt,
                submittedAt: r.createdAt,
              });
            } else {
              // Existing participation in DB: merge rich documents, lineItems, specs, SLA, and responseData
              const existingPart = bid.participations.find((p: any) => p.sellerId === sellerId);
              if (existingPart) {
                if ((!existingPart.documents || existingPart.documents.length === 0) && documents.length > 0) {
                  existingPart.documents = documents;
                }
                if (!existingPart.offeredQuantity && r.offeredQuantity) {
                  existingPart.offeredQuantity = Number(r.offeredQuantity);
                }
                if ((!existingPart.deliveryTimeline || existingPart.deliveryTimeline === 'Standard') && (r.deliveryTimeline || respData.deliveryTimeline)) {
                  existingPart.deliveryTimeline = r.deliveryTimeline || respData.deliveryTimeline;
                }
                if ((!existingPart.makeBrand || existingPart.makeBrand === 'Standard' || existingPart.makeBrand === 'As per specification') && (respData.makeBrand || r.makeBrand)) {
                  existingPart.makeBrand = respData.makeBrand || r.makeBrand;
                }
                if (!existingPart.model && (respData.model || r.model)) {
                  existingPart.model = respData.model || r.model;
                }
                if ((!existingPart.terms || existingPart.terms === 'Standard Payment Terms') && (r.terms || respData.terms)) {
                  existingPart.terms = r.terms || respData.terms;
                }
                if (!existingPart.offeredItemDescription && (r.message || respData.message)) {
                  existingPart.offeredItemDescription = r.message || respData.message;
                }
                if ((!existingPart.lineItems || existingPart.lineItems.length === 0) && Array.isArray(respData.lineItems) && respData.lineItems.length > 0) {
                  existingPart.lineItems = respData.lineItems;
                }
                if (!existingPart.responseData || Object.keys(existingPart.responseData).length === 0) {
                  existingPart.responseData = respData;
                }
              }
            }
          }
        }
      }

      // Match QuoteResponses for RFQ / RFP / QUOTE_REQUEST sourced bids
      for (const qr of quoteResponses) {
        const qReqId = Number(qr.quoteRequestId);
        const isQuoteIdMatch = (bidSourceModel === 'QUOTE_REQUEST' && bidSourceIdNum > 0 && qReqId === bidSourceIdNum) || 
                               (bidNumberNorm === `rfq${qReqId}` || bidNumberNorm === `rfp${qReqId}`);

        if (isQuoteIdMatch) {
          const sellerId = qr.sellerId;
          if (sellerId) {
            const qrTech = String(qr.technicalStatus || '').toUpperCase();
            const normalizedTechStatus = qrTech === 'DISQUALIFIED' || qrTech === 'NOT_QUALIFIED'
              ? 'DISQUALIFIED'
              : (qrTech === 'QUALIFIED' ? 'QUALIFIED' : 'PENDING');
            const respData = typeof (qr as any).responseData === 'string'
              ? (() => { try { return JSON.parse((qr as any).responseData); } catch { return {}; } })()
              : ((qr as any).responseData || {});
            const qrDocs = Array.isArray((qr as any).documents) ? (qr as any).documents : (Array.isArray(respData.documents) ? respData.documents : []);
            const qrLineItems = Array.isArray((qr as any).lineItems) ? (qr as any).lineItems : (Array.isArray(respData.lineItems) ? respData.lineItems : []);

            if (!existingSellerIds.has(sellerId)) {
              existingSellerIds.add(sellerId);
              bid.participations.push({
                id: qr.id,
                bidId: bid.id,
                sellerId: sellerId,
                seller: qr.seller,
                participationNumber: `PRT-QR-${qr.id}`,
                technicalStatus: normalizedTechStatus,
                technicalRemarks: qr.technicalRemarks || null,
                financialStatus: normalizedTechStatus === 'QUALIFIED' ? 'OPENED' : 'LOCKED',
                financialSealed: normalizedTechStatus !== 'QUALIFIED',
                finalStatus: qr.status === 'ACCEPTED' ? 'AWARDED' : 'PENDING',
                submissionStatus: 'SUBMITTED',
                quotedAmount: Number(qr.totalAmount || 0),
                totalAmount: Number(qr.totalAmount || 0),
                offeredQuantity: (qr as any).offeredQuantity || respData.offeredQuantity || 1,
                deliveryTimeline: (qr as any).deliveryTimeline || respData.deliveryTimeline || 'Standard',
                offeredItemDescription: qr.notes || respData.message || '',
                documents: qrDocs,
                lineItems: qrLineItems,
                responseData: respData,
                createdAt: qr.createdAt,
                submittedAt: qr.createdAt,
              });
            } else {
              const existingPart = bid.participations.find((p: any) => p.sellerId === sellerId);
              if (existingPart) {
                if ((!existingPart.documents || existingPart.documents.length === 0) && qrDocs.length > 0) {
                  existingPart.documents = qrDocs;
                }
                if (!existingPart.offeredQuantity && ((qr as any).offeredQuantity || respData.offeredQuantity)) {
                  existingPart.offeredQuantity = Number((qr as any).offeredQuantity || respData.offeredQuantity);
                }
                if ((!existingPart.deliveryTimeline || existingPart.deliveryTimeline === 'Standard') && ((qr as any).deliveryTimeline || respData.deliveryTimeline)) {
                  existingPart.deliveryTimeline = (qr as any).deliveryTimeline || respData.deliveryTimeline;
                }
                if (!existingPart.offeredItemDescription && (qr.notes || respData.message)) {
                  existingPart.offeredItemDescription = qr.notes || respData.message;
                }
                if ((!existingPart.lineItems || existingPart.lineItems.length === 0) && qrLineItems.length > 0) {
                  existingPart.lineItems = qrLineItems;
                }
                if (!existingPart.responseData || Object.keys(existingPart.responseData).length === 0) {
                  existingPart.responseData = respData;
                }
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Error enriching bids with responses:', err);
  }

  return bids;
};

router.get('/buyer/procurement-bids', authenticate, requireAccountType('buyer'), asyncRoute(async (req, res) => {
  const bids = await (prisma as any).procurementBid.findMany({
    where: { buyerId: req.user!.id },
    include: {
      documents: { select: { id: true, documentType: true, fileName: true, fileUrl: true, fileAssetId: true } },
      participations: {
        where: { submissionStatus: { not: 'DRAFT' }, isWithdrawn: false },
        include: {
          seller: { select: { id: true, name: true, email: true, role: true, onboardingStatus: true } },
          documents: true
        }
      },
      awards: true,
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
    orderBy: { createdAt: 'desc' }
  });

  // Fetch Rate Contracts for logged in buyer
  const rateContracts = await (prisma as any).contract.findMany({
    where: {
      contractType: 'RATE_CONTRACT',
      createdById: req.user!.id
    },
    orderBy: { updatedAt: 'desc' },
    take: 50
  }).catch(() => []);

  for (const contract of rateContracts) {
    const meta = (contract.metadata || {}) as any;
    const contractNum = contract.contractNumber || `RC-${contract.id}`;
    const exists = bids.some((b: any) => b.bidNumber === contractNum || b.id === contract.id);
    if (!exists) {
      bids.push({
        id: contract.id,
        bidNumber: contractNum,
        title: contract.title || meta.contractTitle || `Annual Rate Contract ${contractNum}`,
        description: meta.contractDescription || contract.title || 'Rate Contract',
        buyerId: Number(meta.buyerId || req.user!.id),
        buyerOrganizationName: meta.buyerOrganizationName || '',
        procurementType: 'Rate Contract',
        bidType: 'Rate Contract',
        category: meta.contractCategory || 'Rate Contract',
        estimatedValue: Number(contract.value || 0),
        status: String(contract.status || 'ACTIVE'),
        approvalStatus: 'APPROVED',
        lifecycleStage: 'SELLER_PARTICIPATION',
        createdAt: contract.createdAt,
        updatedAt: contract.updatedAt,
        participations: [],
        documents: meta.contractDocument?.fileAssetId ? [{
          id: `rcdoc-${contract.id}`,
          documentType: 'RATE_CONTRACT_DOCUMENT',
          fileName: meta.contractDocument.fileName || 'Rate Contract Document',
          fileUrl: null
        }] : [],
        awards: [],
        buyer: req.user,
        sourceModel: 'RATE_CONTRACT',
        sourceId: contract.id,
        requirementId: meta.requirementId ? Number(meta.requirementId) : null,
        requirementNumber: meta.requirementNumber || null,
      });
    }
  }

  await enrichBidsWithResponses(bids, req.user!.id);
  return apiResponse.success(res, bids.map((bid: any) => service.serializeBid(bid, { actor: req.user, includeFinancial: true })), 200, 'Buyer bids fetched');
}));

router.get('/buyer/procurement-bids/:bidId/participants', authenticate, requireAccountType('buyer', 'admin'), requirePermission('tender.view'), validate({ params: idParamSchema }), asyncRoute(async (req, res) => {
  const bid = await service.resolveBid(req.params.bidId);
  service.assertBuyerOwner(req.user!, bid);
  await enrichBidsWithResponses([bid], req.user!.role === 'buyer' ? req.user!.id : undefined);

  const packetMeta = bid.technicalPacket && typeof bid.technicalPacket === 'object' ? bid.technicalPacket as any : {};
  const sched = packetMeta.schedule || {};
  const candidateFinDate = bid.financialOpeningDate || packetMeta.financialOpeningDate || sched.financialOpeningDate || sched.financialBidOpeningDate;
  const isFutureFinDate = candidateFinDate && !isNaN(new Date(candidateFinDate).getTime()) && new Date(candidateFinDate).getTime() > Date.now();
  const isTwoPacket = String(bid.packetType || packetMeta.packetType || sched.packetType || '').toUpperCase().includes('TWO') || Boolean(candidateFinDate);
  const isAdmin = req.user?.role === 'admin' || req.user?.role === 'master_admin';
  const isFinancialStage = (service.financialOpenStatuses.includes(bid.status) || bid.status === 'TECHNICAL_EVALUATION_COMPLETED') && !isFutureFinDate;

  return apiResponse.success(res, (bid.participations || []).map((p: any) => {
    const isDisqualified = ['DISQUALIFIED', 'REJECTED', 'NOT_QUALIFIED'].includes(String(p.technicalStatus || '').toUpperCase());
    const canSeeFinancial = isAdmin || (!isTwoPacket ? true : (isFinancialStage && !isDisqualified));
    return service.serializeParticipation(p, { canSeeFinancial, bid });
  }), 200, 'Participants fetched');
}));

router.post('/buyer/procurement-bids/:bidId/clarifications', authenticate, requireAccountType('buyer', 'admin'), requirePermission('tender.update'), validate({ params: idParamSchema, body: clarificationSchema }), asyncRoute(async (req, res) => {
  const data = await service.askClarification(req, req.params.bidId, req.body);
  return apiResponse.created(res, data, 'Clarification requested');
}));

router.post('/buyer/procurement-bids/:bidId/technical-evaluation', authenticate, requireAccountType('buyer', 'admin'), requirePermission('bid.technical.evaluate'), validate({ params: idParamSchema, body: technicalEvaluationSchema }), asyncRoute(async (req, res) => {
  const data = await service.evaluateTechnical(req, req.params.bidId, req.body);
  await invalidateBidCaches(data, req.params.bidId);
  return apiResponse.success(res, data, 200, 'Technical evaluation saved');
}));

router.post('/buyer/procurement-bids/:bidId/complete-technical-evaluation', authenticate, requireAccountType('buyer', 'admin'), requirePermission('bid.technical.evaluate'), validate({ params: idParamSchema }), asyncRoute(async (req, res) => {
  const data = await service.completeTechnicalEvaluation(req, req.params.bidId);
  await invalidateBidCaches(data, req.params.bidId);
  return apiResponse.success(res, data, 200, 'Technical evaluation completed');
}));

router.post('/buyer/procurement-bids/:bidId/open-financial-evaluation', authenticate, requireAccountType('buyer', 'admin'), requirePermission('bid.financial.evaluate'), validate({ params: idParamSchema, body: z.object({ singleBidConfirmed: z.boolean().optional(), lowBidConfirmed: z.boolean().optional(), confirmProceedBelowMinimum: z.boolean().optional(), justificationReason: z.string().trim().max(2000).optional(), remarks: z.string().trim().max(2000).optional() }).optional() }), asyncRoute(async (req, res) => {
  const data = await service.openFinancialEvaluation(req, req.params.bidId, req.body || {});
  await invalidateBidCaches(data, req.params.bidId);
  return apiResponse.success(res, data, 200, 'Financial evaluation opened and L1/L2/L3/L4 ranking generated');
}));

router.post(['/buyer/procurement-bids/:bidId/award', '/buyer/procurement-bids/:bidId/recommend-award', '/buyer/bids/:bidId/recommend-award'], authenticate, requireAccountType('buyer', 'admin'), requirePermission('award.recommend'), validate({ params: idParamSchema, body: z.object({ participationId: flexibleParticipationIdSchema, remarks: z.string().trim().max(2000).optional(), adminOverrideReason: z.string().trim().max(2000).optional(), justificationReason: z.string().trim().max(2000).optional(), generatePoNow: z.boolean().optional() }) }), asyncRoute(async (req, res) => {
  const data = await service.recommendAward(req, req.params.bidId, req.body);
  await invalidateBidCaches(data, req.params.bidId);
  return apiResponse.created(res, data, 'Award offer created');
}));

router.post(['/buyer/procurement-bids/:bidId/counter-offer', '/buyer/bids/:bidId/counter-offer'], authenticate, requireAccountType('buyer', 'admin'), requirePermission('award.recommend'), validate({ params: idParamSchema, body: z.object({ participationId: flexibleParticipationIdSchema, priceMatchTargetPrice: z.coerce.number().positive().optional(), deadlineHours: z.coerce.number().int().min(1).max(720).optional(), deadlineDate: z.string().optional(), counterOfferNotes: z.string().trim().max(2000).optional(), justificationReason: z.string().trim().max(2000).optional() }) }), asyncRoute(async (req, res) => {
  const data = await service.sendPriceMatchCounterOffer(req, req.params.bidId, req.body);
  await invalidateBidCaches(data, req.params.bidId);
  return apiResponse.created(res, data, 'Price match counter-offer sent to supplier');
}));

router.post(['/seller/procurement-bids/:bidId/counter-offer/accept', '/seller/bids/:bidId/counter-offer/accept'], authenticate, requireAccountType('seller'), validate({ params: idParamSchema, body: z.object({ awardId: z.union([z.number(), z.string()]).optional() }).optional() }), asyncRoute(async (req, res) => {
  const data = await service.acceptPriceMatchCounterOffer(req, req.params.bidId);
  await invalidateBidCaches(data, req.params.bidId);
  return apiResponse.success(res, data, 200, 'Price match counter-offer accepted successfully');
}));

router.post(['/seller/procurement-bids/:bidId/counter-offer/decline', '/seller/bids/:bidId/counter-offer/decline'], authenticate, requireAccountType('seller', 'shg'), validate({ params: idParamSchema, body: z.object({ reason: z.string().trim().min(5).max(2000), awardId: z.union([z.number(), z.string()]).optional() }) }), asyncRoute(async (req, res) => {
  const data = await service.declinePriceMatchCounterOffer(req, req.params.bidId, req.body);
  await invalidateBidCaches(data, req.params.bidId);
  return apiResponse.success(res, data, 200, 'Price match counter-offer declined');
}));

router.post(['/seller/procurement-bids/:bidId/accept-award', '/seller/bids/:bidId/accept-award'], authenticate, requireAccountType('seller', 'shg'), validate({ params: idParamSchema, body: z.object({ awardId: z.union([z.number(), z.string()]).optional() }).optional() }), asyncRoute(async (req, res) => {
  const data = await service.acceptAward(req, req.params.bidId);
  await invalidateBidCaches(data, req.params.bidId);
  return apiResponse.success(res, data, 200, 'Award offer accepted successfully');
}));

router.post(['/seller/procurement-bids/:bidId/decline-award', '/seller/bids/:bidId/decline-award'], authenticate, requireAccountType('seller', 'shg'), validate({ params: idParamSchema, body: z.object({ reason: z.string().trim().min(5).max(2000), awardId: z.union([z.number(), z.string()]).optional() }) }), asyncRoute(async (req, res) => {
  const data = await service.declineAward(req, req.params.bidId, req.body);
  await invalidateBidCaches(data, req.params.bidId);
  return apiResponse.success(res, data, 200, 'Award offer declined successfully');
}));

router.post(['/buyer/procurement-bids/:bidId/generate-po', '/seller/procurement-bids/:bidId/generate-po', '/procurement-bids/:bidId/generate-po'], authenticate, requireAccountType('buyer', 'admin', 'seller'), validate({ params: idParamSchema, body: z.object({ awardId: z.union([z.number(), z.string()]).optional(), asDraft: z.boolean().optional(), issueImmediately: z.boolean().optional() }).optional() }), asyncRoute(async (req, res) => {
  const data = await service.generatePOForBid(req, req.params.bidId, req.body || {});
  await invalidateBidCaches(data, req.params.bidId);
  return apiResponse.created(res, data, 'Purchase order generated and issued');
}));

router.get('/admin/procurement-bids', authenticate, requireAccountType('admin'), requirePermission('tender.view'), checkFeatureEnabled('admin-bid-approval'), asyncRoute(async (req, res) => {
  const bids = await (prisma as any).procurementBid.findMany({
    include: {
      documents: true,
      participations: true,
      awards: true,
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
    orderBy: { createdAt: 'desc' }
  });
  await enrichBidsWithResponses(bids);
  return apiResponse.success(res, bids.map((bid: any) => service.serializeBid(bid, { actor: req.user, includeParticipants: true, includeFinancial: true })), 200, 'Admin bids fetched');
}));

router.post('/admin/procurement-bids/:bidId/approve', authenticate, requireAccountType('admin'), requirePermission('tender.publish'), checkFeatureEnabled('admin-bid-approval'), validate({ params: idParamSchema }), asyncRoute(async (req, res) => {
  const data = await service.approveBid(req, req.params.bidId);
  return apiResponse.success(res, data, 200, 'Bid approved');
}));

router.post('/admin/procurement-bids/:bidId/reject', authenticate, requireAccountType('admin'), requirePermission('tender.publish'), checkFeatureEnabled('admin-bid-approval'), validate({ params: idParamSchema, body: z.object({ reason: z.string().trim().min(3).max(2000) }) }), asyncRoute(async (req, res) => {
  const data = await service.rejectBid(req, req.params.bidId, req.body.reason);
  return apiResponse.success(res, data, 200, 'Bid rejected');
}));

router.get('/admin/procurement-bids/:bidId/audit', authenticate, requireAccountType('admin'), requirePermission('report.view'), checkFeatureEnabled('admin-bid-approval'), validate({ params: idParamSchema }), asyncRoute(async (req, res) => {
  const bid = await service.resolveBid(req.params.bidId, {});
  const logs = await (prisma as any).procurementAuditLog.findMany({ where: { entityId: String(bid.id) }, orderBy: { createdAt: 'desc' } });
  return apiResponse.success(res, logs, 200, 'Audit trail fetched');
}));

router.get('/admin/procurement-bids/:bidId/participants', authenticate, requireAccountType('admin'), requirePermission('tender.view'), checkFeatureEnabled('admin-bid-approval'), validate({ params: idParamSchema }), asyncRoute(async (req, res) => {
  const bid = await service.resolveBid(req.params.bidId, { participations: { include: { seller: { select: { id: true, name: true, email: true, role: true } }, documents: true } } });
  return apiResponse.success(res, (bid.participations || []).map((p: any) => service.serializeParticipation(p, { canSeeFinancial: true })), 200, 'Admin bid participants fetched');
}));

router.post('/admin/procurement-bids/:bidId/final-award-approval', authenticate, requireAccountType('admin'), requirePermission('purchase_order.create'), checkFeatureEnabled('admin-bid-approval'), validate({ params: idParamSchema, body: z.object({ awardId: z.coerce.number().int().positive().optional(), remarks: z.string().trim().max(2000).optional() }) }), asyncRoute(async (req, res) => {
  const data = await service.approveFinalAward(req, req.params.bidId, req.body);
  return apiResponse.success(res, data, 200, 'Final award approved and PO generated');
}));

router.get('/admin/procurement/reports', authenticate, requireAccountType('admin'), requirePermission('report.view'), asyncRoute(async (req, res) => {
  const [bids, participations, awards] = await Promise.all([
    (prisma as any).procurementBid.count(),
    (prisma as any).procurementBidParticipation.count(),
    (prisma as any).procurementBidAward.count()
  ]);
  return apiResponse.success(res, { bids, participations, awards, generatedAt: new Date().toISOString() }, 200, 'Procurement report generated');
}));

router.get('/orders/procurement', authenticate, asyncRoute(async (req, res) => {
  const data = await orderService.listProcurementOrders(req.user!, req.query);
  return apiResponse.success(res, maskSensitive(data, { unmaskForAdmin: true, unmaskSelf: true }), 200, 'Procurement orders fetched');
}));

router.get('/orders/procurement/:orderId', authenticate, validate({ params: orderIdParamSchema }), asyncRoute(async (req, res) => {
  const data = await orderService.loadProcurementOrder(req.user!, Number(req.params.orderId));
  return apiResponse.success(res, maskSensitive(data, { unmaskForAdmin: true, unmaskSelf: true }), 200, 'Procurement order fetched');
}));

router.get('/seller/pending-awards-and-pos', authenticate, requireAccountType('seller', 'shg'), asyncRoute(async (req, res) => {
  try {
    const data = await orderService.listPendingAwardsAndPOsForSeller(req.user!);
    return apiResponse.success(res, data, 200, 'Pending awards and purchase orders fetched');
  } catch (err: any) {
    logger.warn({ err: err?.message || err, userId: req.user?.id }, '[PendingAwards] Failed to fetch awards & POs');
    return apiResponse.success(res, { hasPending: false, count: 0, awards: [], purchaseOrders: [] }, 200, 'Pending awards and purchase orders fetched');
  }
}));

router.get('/seller/awards', authenticate, requireAccountType('seller', 'shg'), asyncRoute(async (req, res) => {
  const data = await orderService.listSellerAwards(req.user!);
  return apiResponse.success(res, data, 200, 'Seller awards fetched');
}));

router.post(['/seller/awards/:awardId/accept', '/seller/purchase-orders/:id/accept-po', '/seller/purchase-orders/:id/accept'], authenticate, requireAccountType('seller', 'shg'), asyncRoute(async (req, res) => {
  const targetId = Number(req.params.id || req.params.awardId);
  if (req.path.includes('purchase-orders')) {
    const data = await orderService.acceptPO(req, targetId, req.body || {});
    const targetBidId = data?.purchaseOrder?.bidId || (data?.purchaseOrder?.metadata as any)?.bidId || req.body?.bidId;
    if (targetBidId) await invalidateBidCaches(targetBidId);
    return apiResponse.success(res, data, 200, 'Purchase Order accepted and fulfillment committed');
  }
  const data = await orderService.acceptSellerAward(req, targetId, req.body || {});
  const targetBidId = data?.award?.bidId || req.body?.bidId;
  if (targetBidId) await invalidateBidCaches(targetBidId);
  return apiResponse.success(res, data, 200, 'Award accepted and delivery opened');
}));

router.post(['/seller/awards/:awardId/reject', '/seller/awards/:awardId/decline'], authenticate, requireAccountType('seller', 'shg'), validate({ params: awardIdParamSchema, body: z.object({ reason: z.string().trim().min(5).max(2000) }) }), asyncRoute(async (req, res) => {
  const data = await orderService.rejectSellerAward(req, Number(req.params.awardId), req.body.reason);
  return apiResponse.success(res, data, 200, 'Award rejected');
}));

router.post(['/seller/purchase-orders/:id/reject', '/seller/purchase-orders/:id/decline'], authenticate, requireAccountType('seller', 'shg'), validate({
  body: z.object({
    reasonCode: z.string().trim().optional(),
    reason: z.string().trim().min(5, 'Reason must be at least 5 characters').max(2000),
    evidenceFileId: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).optional(),
    category: z.enum(['EXCUSED', 'UNEXCUSED']).optional()
  })
}), asyncRoute(async (req, res) => {
  const targetId = Number(req.params.id);
  if (isNaN(targetId) || targetId <= 0) {
    throw new ApiError(400, 'Invalid purchase order ID', 'INVALID_PARAM');
  }
  const data = await orderService.rejectPO(req, targetId, req.body.reason, {
    reasonCode: req.body.reasonCode,
    evidenceFileId: req.body.evidenceFileId ? Number(req.body.evidenceFileId) : undefined,
    category: req.body.category
  });
  const targetBidId = data?.purchaseOrder?.bidId || (data?.purchaseOrder?.metadata as any)?.bidId || req.body?.bidId;
  if (targetBidId) await invalidateBidCaches(targetBidId);
  return apiResponse.success(res, data, 200, 'Purchase Order declined');
}));

router.post('/orders/:orderId/delivery/update', authenticate, validate({ params: orderIdParamSchema }), asyncRoute(async (req, res) => {
  const data = await orderService.updateOrderDelivery(req, Number(req.params.orderId), req.body || {});
  return apiResponse.success(res, data, 200, 'Delivery updated');
}));

router.post('/orders/:orderId/delivery/documents', authenticate, upload.single('file'), validate({ params: orderIdParamSchema }), asyncRoute(async (req, res) => {
  const data = await orderService.addDeliveryDocument(req, Number(req.params.orderId), req.body || {});
  return apiResponse.created(res, data, 'Delivery document attached');
}));

router.get('/orders/:orderId/delivery', authenticate, validate({ params: orderIdParamSchema }), asyncRoute(async (req, res) => {
  const order = await orderService.loadProcurementOrder(req.user!, Number(req.params.orderId));
  return apiResponse.success(res, order.deliveryTrackings?.[0] || null, 200, 'Delivery fetched');
}));

router.post('/orders/:orderId/grn', authenticate, validate({ params: orderIdParamSchema }), asyncRoute(async (req, res) => {
  const data = await orderService.createOrderGrn(req, Number(req.params.orderId), req.body || {});
  return apiResponse.created(res, data, 'GRN created');
}));

router.put('/orders/:orderId/grn/:grnId', authenticate, validate({ params: grnParamSchema }), asyncRoute(async (req, res) => {
  const order = await orderService.loadProcurementOrder(req.user!, Number(req.params.orderId));
  if (req.user?.role !== 'admin' && order.buyerId !== req.user?.id) return apiResponse.error(res, 403, 'Buyer access required', 'FORBIDDEN_ROLE');
  const data = await (prisma as any).goodsReceiptNote.update({ where: { id: Number(req.params.grnId) }, data: req.body || {}, include: { items: true, documents: true } });
  return apiResponse.success(res, data, 200, 'GRN updated');
}));

router.post('/orders/:orderId/grn/:grnId/approve', authenticate, validate({ params: grnParamSchema }), asyncRoute(async (req, res) => {
  const data = await orderService.approveOrderGrn(req, Number(req.params.orderId), Number(req.params.grnId), req.body || {});
  return apiResponse.success(res, data, 200, 'GRN approved');
}));

router.post('/orders/:orderId/grn/:grnId/reject', authenticate, validate({ params: grnParamSchema, body: z.object({ rejectionReason: z.string().trim().min(5).max(2000).optional(), reason: z.string().trim().min(5).max(2000).optional() }) }), asyncRoute(async (req, res) => {
  const data = await orderService.rejectOrderGrn(req, Number(req.params.orderId), Number(req.params.grnId), req.body.rejectionReason || req.body.reason || 'Rejected by buyer');
  return apiResponse.success(res, data, 200, 'GRN rejected');
}));

router.post('/orders/:orderId/invoice', authenticate, validate({ params: orderIdParamSchema }), asyncRoute(async (req, res) => {
  const data = await orderService.createOrderInvoice(req, Number(req.params.orderId), req.body || {});
  return apiResponse.created(res, data, 'Invoice submitted');
}));

router.post('/orders/:orderId/invoice/upload', authenticate, upload.single('file'), validate({ params: orderIdParamSchema }), asyncRoute(async (req, res) => {
  const data = await orderService.uploadOrderInvoice(req, Number(req.params.orderId), req.body || {});
  return apiResponse.created(res, data, 'Invoice uploaded');
}));

router.post('/orders/:orderId/invoice/:invoiceId/approve', authenticate, validate({ params: invoiceParamSchema }), asyncRoute(async (req, res) => {
  const data = await orderService.approveOrderInvoice(req, Number(req.params.orderId), Number(req.params.invoiceId));
  return apiResponse.success(res, data, 200, 'Invoice approved');
}));

router.post('/orders/:orderId/invoice/:invoiceId/reject', authenticate, validate({ params: invoiceParamSchema, body: z.object({ reason: z.string().trim().min(5).max(2000) }) }), asyncRoute(async (req, res) => {
  const data = await orderService.rejectOrderInvoice(req, Number(req.params.orderId), Number(req.params.invoiceId), req.body.reason);
  return apiResponse.success(res, data, 200, 'Invoice rejected');
}));

router.post('/orders/:orderId/payment/initiate', authenticate, validate({ params: orderIdParamSchema }), asyncRoute(async (req, res) => {
  const data = await orderService.initiateOrderPayment(req, Number(req.params.orderId), req.body || {});
  return apiResponse.created(res, data, 'Payment initiated');
}));

router.get('/orders/:orderId/payment/status', authenticate, validate({ params: orderIdParamSchema }), asyncRoute(async (req, res) => {
  const data = await orderService.getOrderPaymentStatus(req.user!, Number(req.params.orderId));
  return apiResponse.success(res, data, 200, 'Payment status fetched');
}));

router.post('/orders/:orderId/settlement/mark-confirmed', authenticate, requireAccountType('admin'), requirePermission('payment.verify'), validate({ params: orderIdParamSchema }), asyncRoute(async (req, res) => {
  const data = await orderService.markSettlementConfirmed(req, Number(req.params.orderId), req.body || {});
  return apiResponse.success(res, data, 200, 'Settlement confirmed');
}));

router.post(['/buyer/invoices/:invoiceId/record-payment', '/orders/:orderId/invoices/:invoiceId/record-payment', '/orders/:orderId/payment/record'], authenticate, requireAccountType('buyer', 'admin'), asyncRoute(async (req, res) => {
  const invoiceId = Number(req.params.invoiceId || req.body?.invoiceId || 0);
  const orderId = Number(req.params.orderId || req.body?.orderId || 0);
  const data = await orderService.recordOrderPayment(req, invoiceId, { ...req.body, orderId });
  return apiResponse.success(res, data, 200, 'Payment receipt recorded successfully');
}));

router.post(['/seller/invoices/:invoiceId/confirm-settlement', '/orders/:orderId/invoices/:invoiceId/confirm-settlement', '/orders/:orderId/settlement/confirm'], authenticate, requireAccountType('seller', 'admin'), asyncRoute(async (req, res) => {
  const invoiceId = Number(req.params.invoiceId || req.body?.invoiceId || 0);
  const orderId = Number(req.params.orderId || req.body?.orderId || 0);
  const data = await orderService.confirmOrderSettlement(req, invoiceId, { ...req.body, orderId });
  return apiResponse.success(res, data, 200, 'Payment settlement confirmed and order completed');
}));

// ── Edge Case Routes ──
router.post('/:bidId/financial-evaluation-landed-cost', authenticate, asyncRoute(async (req, res) => {
  const data = await service.openFinancialEvaluationLandedCost(req, req.params.bidId, req.body || {});
  return apiResponse.success(res, data, 200, 'Financial evaluation opened with Landed Cost evaluation');
}));

// Split award & L2 counter-offer routes removed — only direct single-winner evaluation is supported

router.put('/:bidId/participations/:participationId/revise', authenticate, asyncRoute(async (req, res) => {
  const data = await service.reviseParticipation(req, req.params.bidId, Number(req.params.participationId), req.body || {});
  return apiResponse.success(res, data, 200, 'Participation revised successfully');
}));

export default router;
