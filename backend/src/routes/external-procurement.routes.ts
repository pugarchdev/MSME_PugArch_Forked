import { Router, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { authenticate, authorize, type AuthRequest } from '../middleware/auth.js';
import { upload } from '../config/storage.js';
import { uploadFile } from '../services/storage/storage.service.js';
import { ApiError } from '../utils/ApiError.js';
import { extractProcurementDocument, type DocumentExtractionResult } from '../services/ai/document-extractor.service.js';
import { generateSapInvoiceExport } from '../services/export/sap-export.service.js';
import { notifySellerNewPurchaseOrder } from '../services/invoice-pdf.service.js';

const router = Router();

const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });

const wrap = (handler: (req: AuthRequest, res: Response) => Promise<unknown>) =>
  (req: AuthRequest, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };

const userId = (req: AuthRequest) => {
  if (!req.user?.id) throw new ApiError(401, 'Unauthorized');
  return req.user.id;
};

/**
 * Helper to match an MSME vendor against local database by Alias, GSTIN, PAN, or Name
 */
async function resolveMsmeSeller(params: {
  buyerOrgId?: number | null;
  erpVendorCode?: string | null;
  gstin?: string | null;
  pan?: string | null;
  name?: string | null;
}) {
  const { buyerOrgId, erpVendorCode, gstin, pan, name } = params;

  // 1. Check BuyerVendorAlias
  if (buyerOrgId && erpVendorCode) {
    const alias = await prisma.buyerVendorAlias.findFirst({
      where: {
        buyerOrgId,
        erpVendorCode: erpVendorCode.trim()
      },
      include: {
        sellerOrg: {
          include: {
            users: {
              where: { role: { in: ['seller', 'shg'] } },
              take: 1
            }
          }
        }
      }
    });

    if (alias && alias.sellerOrg) {
      const sellerUser = alias.sellerOrg.users[0] || null;
      return {
        matched: true,
        matchType: 'ALIAS_MAPPED',
        organization: {
          id: alias.sellerOrg.id,
          organizationName: alias.sellerOrg.organizationName,
          gstin: alias.sellerOrg.gstin,
          panNumber: alias.sellerOrg.panNumber,
          erpVendorCode: alias.erpVendorCode
        },
        sellerUserId: sellerUser?.id || null,
        sellerUser
      };
    }
  }

  // 2. Match by GSTIN
  if (gstin && gstin.trim().length === 15) {
    const cleanGst = gstin.trim().toUpperCase();
    const org = await prisma.organization.findFirst({
      where: {
        gstin: cleanGst,
        deletedAt: null
      },
      include: {
        users: {
          where: { role: { in: ['seller', 'shg'] } },
          take: 1
        }
      }
    });

    if (org) {
      const sellerUser = org.users[0] || null;
      return {
        matched: true,
        matchType: 'GSTIN_EXACT',
        organization: {
          id: org.id,
          organizationName: org.organizationName,
          gstin: org.gstin,
          panNumber: org.panNumber
        },
        sellerUserId: sellerUser?.id || null,
        sellerUser
      };
    }
  }

  // 3. Match by PAN
  if (pan && pan.trim().length === 10) {
    const cleanPan = pan.trim().toUpperCase();
    const org = await prisma.organization.findFirst({
      where: {
        panNumber: cleanPan,
        deletedAt: null
      },
      include: {
        users: {
          where: { role: { in: ['seller', 'shg'] } },
          take: 1
        }
      }
    });

    if (org) {
      const sellerUser = org.users[0] || null;
      return {
        matched: true,
        matchType: 'PAN_EXACT',
        organization: {
          id: org.id,
          organizationName: org.organizationName,
          gstin: org.gstin,
          panNumber: org.panNumber
        },
        sellerUserId: sellerUser?.id || null,
        sellerUser
      };
    }
  }

  // 4. Fuzzy / Contains Name Match
  if (name && name.trim().length >= 4) {
    const cleanName = name.trim();
    const org = await prisma.organization.findFirst({
      where: {
        organizationName: {
          contains: cleanName,
          mode: 'insensitive'
        },
        deletedAt: null
      },
      include: {
        users: {
          where: { role: { in: ['seller', 'shg'] } },
          take: 1
        }
      }
    });

    if (org) {
      const sellerUser = org.users[0] || null;
      return {
        matched: true,
        matchType: 'NAME_SIMILAR',
        organization: {
          id: org.id,
          organizationName: org.organizationName,
          gstin: org.gstin,
          panNumber: org.panNumber
        },
        sellerUserId: sellerUser?.id || null,
        sellerUser
      };
    }
  }

  return {
    matched: false,
    matchType: 'UNMATCHED',
    organization: null,
    sellerUserId: null,
    sellerUser: null
  };
}

/**
 * 1. POST /api/documents/extract
 * Upload an external PO / Invoice (PDF / Image) -> AI Extraction Cascade -> Match Vendor
 */
router.post(
  '/documents/extract',
  authenticate,
  upload.single('file'),
  wrap(async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
    if (!req.file) {
      throw new ApiError(400, 'Document file (PDF or image) is required', 'FILE_REQUIRED');
    }

    const currentUserId = userId(req);
    const userRole = String(req.user?.role || 'buyer');
    const userOrgId = req.user?.organizationId || null;

    // 1. Upload to storage service to obtain permanent FileAsset
    const uploadContext = {
      ownerId: currentUserId,
      ownerRole: userRole,
      entityType: 'external_procurement_document',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    };

    const fileAsset = await uploadFile(req.file, uploadContext, env.STORAGE_PROVIDER);
    const viewUrl = `/api/files/${fileAsset.id}/view`;

    // 2. Multi-tier AI Document Extraction Cascade
    const extractionResult: DocumentExtractionResult = await extractProcurementDocument(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname
    );

    // 3. Resolve MSME Vendor against platform database
    const extractedSeller = extractionResult.data?.sellerDetails || {};
    const matchedVendor = await resolveMsmeSeller({
      buyerOrgId: userOrgId,
      erpVendorCode: extractedSeller.erpVendorCode,
      gstin: extractedSeller.gstin,
      pan: extractedSeller.pan,
      name: extractedSeller.name
    });

    ok(res, {
      fileAssetId: fileAsset.id,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
      viewUrl,
      extractionMode: extractionResult.extractionMode,
      statusBanner: extractionResult.statusBanner, // Strictly "Extracted via AI Model", "Extracted via Digital Record", or "Manual Review Mode Active"
      data: extractionResult.data,
      matchedVendor,
      warnings: extractionResult.warnings || []
    });
  })
);

/**
 * 2. POST /api/purchase-orders/import-external
 * Create a new Purchase Order from verified external order data
 */
const importExternalPoSchema = z.object({
  externalSystem: z.enum(['SAP', 'GEM', 'TALLY', 'CUSTOM', 'GENERIC']).default('SAP'),
  externalPoNumber: z.string().min(1, 'External PO number is required'),
  documentDate: z.string().optional(),
  title: z.string().min(1, 'Title / subject is required'),
  sellerOrgId: z.number().int().positive('Supplier organization is required'),
  sellerUserId: z.number().int().positive().optional(),
  erpVendorCode: z.string().optional(),
  saveAlias: z.boolean().default(false),
  vendorPlantCode: z.string().optional(),
  fileAssetId: z.number().int().positive('Attached document is required'),
  lineItems: z.array(
    z.object({
      itemName: z.string().min(1, 'Item name is required'),
      description: z.string().optional(),
      quantity: z.coerce.number().positive(),
      unitOfMeasure: z.string().default('NOS'),
      unitPrice: z.coerce.number().min(0),
      taxRate: z.coerce.number().min(0).default(18),
      totalAmount: z.coerce.number().min(0)
    })
  ).min(1, 'At least one line item is required'),
  deliveryTerms: z.object({
    expectedDeliveryDate: z.string().optional(),
    deliveryAddress: z.string().optional(),
    paymentTerms: z.string().optional()
  }).optional(),
  isDraft: z.boolean().default(false),
  extractionMetadata: z.any().optional()
});

router.post(
  '/purchase-orders/import-external',
  authenticate,
  authorize('buyer', 'admin'),
  wrap(async (req: AuthRequest, res) => {
    const parsed = importExternalPoSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid import request payload', 'VALIDATION_ERROR', parsed.error.issues);
    }

    const payload = parsed.data;
    const currentUserId = userId(req);
    const buyerOrgId = req.user?.organizationId;

    // Resolve seller User ID
    let effectiveSellerUserId = payload.sellerUserId;
    if (!effectiveSellerUserId) {
      const sellerOrgUser = await prisma.user.findFirst({
        where: {
          organizationId: payload.sellerOrgId,
          role: { in: ['seller', 'shg'] }
        }
      });
      if (!sellerOrgUser) {
        throw new ApiError(
          400,
          'Selected seller organization does not have an active seller user account on the portal.',
          'SELLER_ACCOUNT_MISSING'
        );
      }
      effectiveSellerUserId = sellerOrgUser.id;
    }

    // Calculate total order amount
    const totalAmount = payload.lineItems.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0);

    // Generate portal PO reference
    const timestampSuffix = Math.floor(Date.now() / 1000);
    const sanitizedExternalPo = payload.externalPoNumber.replace(/[^a-zA-Z0-9_-]/g, '');
    const poNumber = `PO-${payload.externalSystem}-${sanitizedExternalPo}-${timestampSuffix}`.slice(0, 40);

    const expectedDate = payload.deliveryTerms?.expectedDeliveryDate
      ? new Date(payload.deliveryTerms.expectedDeliveryDate)
      : null;

    // Create Purchase Order in Prisma transaction
    const createdPo = await prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.create({
        data: {
          poNumber,
          title: payload.title,
          buyerId: currentUserId,
          sellerId: effectiveSellerUserId!,
          amount: totalAmount,
          totalValue: totalAmount,
          currency: 'INR',
          status: payload.isDraft ? 'draft' : 'issued',
          isDraft: payload.isDraft,
          issuedAt: payload.isDraft ? null : new Date(),
          deliveryAddress: payload.deliveryTerms?.deliveryAddress || null,
          expectedDelivery: expectedDate,
          paymentTerms: payload.deliveryTerms?.paymentTerms || 'STANDARD_NET_30',
          externalPoNumber: payload.externalPoNumber,
          importSource: payload.externalSystem,
          externalSystem: payload.externalSystem,
          erpVendorCode: payload.erpVendorCode || null,
          externalPdfFileId: payload.fileAssetId,
          claimStatus: 'CLAIMED',
          extractionMetadata: payload.extractionMetadata ? payload.extractionMetadata : undefined,
          items: {
            create: payload.lineItems.map(item => ({
              itemName: item.itemName,
              description: item.description || null,
              quantity: item.quantity,
              unitOfMeasure: item.unitOfMeasure,
              unitPrice: item.unitPrice,
              taxRate: item.taxRate,
              totalAmount: item.totalAmount
            }))
          }
        },
        include: {
          items: true,
          seller: {
            include: {
              organization: true
            }
          },
          buyer: {
            include: {
              organization: true
            }
          }
        }
      });

      // If user requested to save ERP Vendor Alias for automatic sync next time
      if (payload.saveAlias && payload.erpVendorCode && buyerOrgId && payload.sellerOrgId) {
        await tx.buyerVendorAlias.upsert({
          where: {
            buyerOrgId_sellerOrgId: {
              buyerOrgId,
              sellerOrgId: payload.sellerOrgId
            }
          },
          update: {
            erpVendorCode: payload.erpVendorCode.trim(),
            erpSystem: payload.externalSystem,
            vendorPlantCode: payload.vendorPlantCode || null,
            updatedAt: new Date()
          },
          create: {
            buyerOrgId,
            sellerOrgId: payload.sellerOrgId,
            erpVendorCode: payload.erpVendorCode.trim(),
            erpSystem: payload.externalSystem,
            vendorPlantCode: payload.vendorPlantCode || null
          }
        }).catch((aliasErr: any) => {
          logger.warn(`[ExternalProcurement] Could not upsert buyer vendor alias: ${aliasErr.message}`);
        });
      }

      return po;
    });

    logger.info(`[ExternalProcurement] Successfully imported ${payload.externalSystem} order: ${createdPo.poNumber}`);
    if (!payload.isDraft) {
      notifySellerNewPurchaseOrder(createdPo.id).catch(err => {
        logger.warn({ err, poId: createdPo.id }, '[ExternalProcurement] Failed to notify seller of imported PO');
      });
    }
    ok(res, createdPo, 201);
  })
);

/**
 * 3. GET /api/buyer/vendor-aliases
 * Get all mapped ERP vendor codes for the current buyer organization
 */
router.get(
  '/buyer/vendor-aliases',
  authenticate,
  authorize('buyer', 'admin'),
  wrap(async (req: AuthRequest, res) => {
    const buyerOrgId = req.user?.organizationId;
    if (!buyerOrgId) {
      return ok(res, []);
    }

    const aliases = await prisma.buyerVendorAlias.findMany({
      where: { buyerOrgId },
      include: {
        sellerOrg: {
          select: {
            id: true,
            organizationName: true,
            gstin: true,
            panNumber: true,
            city: true,
            state: true
          }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    ok(res, aliases);
  })
);

/**
 * 4. POST /api/buyer/vendor-aliases
 * Manually map or update an ERP Vendor Code to a local MSME seller
 */
router.post(
  '/buyer/vendor-aliases',
  authenticate,
  authorize('buyer', 'admin'),
  wrap(async (req: AuthRequest, res) => {
    const buyerOrgId = req.user?.organizationId;
    if (!buyerOrgId) {
      throw new ApiError(400, 'Buyer must belong to an organization to map vendor codes', 'ORG_REQUIRED');
    }

    const schema = z.object({
      sellerOrgId: z.number().int().positive(),
      erpVendorCode: z.string().min(1, 'Vendor code is required'),
      erpSystem: z.string().default('SAP'),
      vendorPlantCode: z.string().optional(),
      notes: z.string().optional()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid vendor alias payload', 'VALIDATION_ERROR', parsed.error.issues);
    }

    const { sellerOrgId, erpVendorCode, erpSystem, vendorPlantCode, notes } = parsed.data;

    const alias = await prisma.buyerVendorAlias.upsert({
      where: {
        buyerOrgId_sellerOrgId: {
          buyerOrgId,
          sellerOrgId
        }
      },
      update: {
        erpVendorCode: erpVendorCode.trim(),
        erpSystem,
        vendorPlantCode: vendorPlantCode || null,
        notes: notes || null,
        updatedAt: new Date()
      },
      create: {
        buyerOrgId,
        sellerOrgId,
        erpVendorCode: erpVendorCode.trim(),
        erpSystem,
        vendorPlantCode: vendorPlantCode || null,
        notes: notes || null
      },
      include: {
        sellerOrg: true
      }
    });

    ok(res, alias);
  })
);

/**
 * 5. GET /api/invoices/:id/export-sap
 * Export Invoice in standard SAP MIRO / MIGO batch CSV format
 */
router.get(
  '/invoices/:id/export-sap',
  authenticate,
  wrap(async (req: AuthRequest, res) => {
    const invoiceId = parseInt(req.params.id, 10);
    if (isNaN(invoiceId)) {
      throw new ApiError(400, 'Invalid invoice ID', 'INVALID_ID');
    }

    const buyerOrgId = req.user?.organizationId;
    const { csvContent, filename, summary } = await generateSapInvoiceExport(invoiceId, buyerOrgId);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Invoice-Summary', JSON.stringify(summary));
    res.status(200).send(csvContent);
  })
);

/**
 * 6. GET /api/sellers/search
 * Search registered MSME sellers by name, GSTIN, or PAN for manual override
 */
router.get(
  '/sellers/search',
  authenticate,
  wrap(async (req: AuthRequest, res) => {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) {
      return ok(res, []);
    }

    const orgs = await prisma.organization.findMany({
      where: {
        deletedAt: null,
        OR: [
          { organizationName: { contains: q, mode: 'insensitive' } },
          { gstin: { contains: q, mode: 'insensitive' } },
          { panNumber: { contains: q, mode: 'insensitive' } }
        ]
      },
      take: 15,
      select: {
        id: true,
        organizationName: true,
        gstin: true,
        panNumber: true,
        city: true,
        state: true,
        users: {
          where: { role: { in: ['seller', 'shg'] } },
          select: { id: true, name: true, email: true },
          take: 1
        }
      }
    });

    const formatted = orgs.map(org => ({
      id: org.id,
      organizationName: org.organizationName,
      gstin: org.gstin,
      panNumber: org.panNumber,
      city: org.city,
      state: org.state,
      sellerUserId: org.users[0]?.id || null,
      sellerUserName: org.users[0]?.name || null
    }));

    ok(res, formatted);
  })
);

export default router;
