'use client';

import React, { useEffect, useLayoutEffect, useState, useRef } from 'react';
import {
  Download,
  X,
  ArrowLeft,
  Copy,
  Maximize2,
  Minimize2,
  CheckCircle2,
  XCircle,
  Truck,
  FileText,
  Clock,
  CreditCard,
  User,
  Calendar,
  RefreshCw,
  MapPin,
  Sun,
  Moon,
  Upload,
  Receipt,
  Package,
  Building2,
  Hash,
  ZoomIn,
  ZoomOut,
  Lock,
  ShieldCheck,
  ExternalLink,
  Scale,
  Eye
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { toast } from 'sonner';
import { api, readJsonResponse, resolveMediaUrl } from '../../../lib/api';
import { cn } from '../../../lib/utils';
import type { DocumentConfig } from '../../../lib/pdfEngine';
import { FocusTrap } from '../../../components/ui/FocusTrap';
import { useAuth } from '../../../hooks/useAuth';
import { useRouter } from 'next/navigation';
import { openFileAsset, prewarmFileAssetPreview } from '../../../lib/files';
import { PbgManagementCard } from './PbgManagementCard';
import { L1NegotiationModal } from './L1NegotiationModal';

export interface PurchaseOrderItemDto {
  id?: number;
  itemName?: string;
  name?: string;
  title?: string;
  description?: string;
  quantity?: number | string;
  unitOfMeasure?: string;
  unit?: string;
  unitPrice?: number | string;
  totalAmount?: number | string;
  specifications?: any;
  brand?: string;
  product?: {
    name?: string;
    unitOfMeasure?: string;
    brand?: string;
    model?: string;
    description?: string;
  };
}

export interface PurchaseOrderDto {
  id: number;
  poNumber?: string;
  title?: string;
  amount?: number | string;
  totalValue?: number | string;
  status?: string;
  currency?: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  acceptedAt?: string | Date;
  expectedDelivery?: string | Date;
  deliveryAddress?: string;
  deliveryType?: string;
  paymentTerms?: string;
  buyerId?: number;
  sellerId?: number;
  buyer?: any;
  seller?: any;
  items?: PurchaseOrderItemDto[];
  deliveryTrackings?: any[];
  invoices?: any[];
  metadata?: any;
  [key: string]: any;
}

export interface PurchaseOrderReceiptModalProps {
  order: PurchaseOrderDto | null;
  onClose: () => void;
  onPrint?: (order: PurchaseOrderDto) => void;
  onDownloadPdf?: (order: PurchaseOrderDto) => void;
  // Operational actions
  isBuyer?: boolean;
  isSeller?: boolean;
  onAccept?: (order: PurchaseOrderDto) => void;
  onReject?: (order: PurchaseOrderDto) => void;
  onCancel?: (order: PurchaseOrderDto) => void;
  onCreateInvoice?: (order: PurchaseOrderDto) => void;
  onManageDispatch?: (order: PurchaseOrderDto) => void;
  onRepeatOrder?: (order: PurchaseOrderDto) => void;
  onUploadPaymentSlip?: (order: PurchaseOrderDto) => void;
  onViewPaymentSlip?: (order: PurchaseOrderDto) => void;
  activeDelivery?: any;
}

const readableStatus = (value?: string) =>
  String(value || 'generated')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());

const formatDate = (val?: string | Date | null) => {
  if (!val) return '—';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return d.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  } catch {
    return String(val);
  }
};

const formatIsoDate = (val?: string | Date | null) => {
  if (!val) return '—';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  } catch {
    return String(val);
  }
};

const formatCurrency = (val?: number | string | null) => {
  const num = Number(val || 0);
  return `₹${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatNumber = (val?: number | string | null) => {
  const num = Number(val || 0);
  return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};



const getStatusBadgeStyles = (status?: string) => {
  const s = String(status || '').toLowerCase().trim();
  if (['pending', 'pending_acceptance', 'pending_dispatch', 'awaiting_dispatch', 'requested'].includes(s)) {
    return {
      badge: 'border-amber-400/50 bg-amber-500/20 text-amber-300',
      dot: 'bg-amber-400',
    };
  }
  if (['accepted', 'approved', 'in_transit', 'dispatched', 'delivered', 'completed', 'grn_approved', 'paid', 'fulfilled'].includes(s)) {
    return {
      badge: 'border-emerald-400/50 bg-emerald-500/20 text-emerald-300',
      dot: 'bg-emerald-400',
    };
  }
  if (['rejected', 'cancelled', 'disputed', 'declined'].includes(s)) {
    return {
      badge: 'border-rose-400/50 bg-rose-500/20 text-rose-300',
      dot: 'bg-rose-400',
    };
  }
  return {
    badge: 'border-sky-400/50 bg-sky-500/20 text-sky-300',
    dot: 'bg-sky-400',
  };
};

// Neutral Minimal Theme (Clean, official monochrome enterprise receipt format)
export const NEUTRAL_MINIMAL_THEME = {
  headerBg: 'bg-slate-200',
  headerText: 'text-slate-950',
  labelBg: 'bg-slate-50',
  labelText: 'text-slate-800',
  accentLine: 'bg-slate-300',
  totalBg: 'bg-slate-200',
  totalText: 'text-slate-950',
  notesHeaderBg: 'bg-slate-200',
  notesHeaderText: 'text-slate-950',
  tableHeaderBorder: 'border-slate-300',
};

// In-memory cache for instant modal open without network delay or N/A flicker
const poDetailCache = new Map<number, PurchaseOrderDto>();
let cachedInvoiceBranding: {
  logoUrl: string | null;
  stampUrl: string | null;
  signatureUrl: string | null;
} | null = null;

export function PurchaseOrderReceiptModal({
  order: initialOrder,
  onClose,
  onPrint,
  onDownloadPdf,
  isBuyer,
  isSeller,
  onAccept,
  onReject,
  onCancel,
  onCreateInvoice,
  onManageDispatch,
  onRepeatOrder,
  onUploadPaymentSlip,
  onViewPaymentSlip,
  activeDelivery,
}: PurchaseOrderReceiptModalProps) {
  const router = useRouter();
  const { user } = useAuth();
  const [order, setOrder] = useState<PurchaseOrderDto | null>(() => {
    if (initialOrder?.id && poDetailCache.has(initialOrder.id)) {
      return { ...initialOrder, ...poDetailCache.get(initialOrder.id)! };
    }
    return initialOrder;
  });

  const [isLoadingDetails, setIsLoadingDetails] = useState<boolean>(() => {
    if (!initialOrder?.id) return false;
    if (poDetailCache.has(initialOrder.id)) return false;
    const hasSeller = Boolean(initialOrder.seller?.organization?.organizationName || initialOrder.seller?.name);
    const hasItems = Array.isArray(initialOrder.items) && initialOrder.items.length > 0;
    return !hasSeller || !hasItems;
  });

  const [activeTab, setActiveTab] = useState<'receipt' | 'audit' | 'gfr'>('receipt');
  const [isNegotiationModalOpen, setIsNegotiationModalOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [canvasBg, setCanvasBg] = useState<'light' | 'dark'>('light');

  const handleCreateInvoiceAction = () => {
    if (!isSeller) return;
    if (onCreateInvoice && order) {
      onCreateInvoice(order);
    } else if (order) {
      onClose();
      const amountVal = order.amount || (order as any).totalValue || 0;
      router.push(`/seller/invoices?convertPoId=${order.id}&amount=${amountVal}`);
    }
  };

  const handleManageDispatchAction = () => {
    if (onManageDispatch && order) {
      onManageDispatch(order);
    } else if (order) {
      onClose();
      const poNum = order.poNumber || order.id;
      const targetRoute = isBuyer ? '/orders/tracking' : '/seller/delivery-management';
      router.push(`${targetRoute}?search=${encodeURIComponent(poNum)}`);
    }
  };

  // Auto-fit page state to ensure the entire receipt is 100% visible on screen without scrolling
  const canvasRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [zoomMode, setZoomMode] = useState<'fit' | '100%' | 'custom'>('fit');
  const [scaleFactor, setScaleFactor] = useState<number>(1);
  const [sheetDims, setSheetDims] = useState<{ w: number; h: number }>({ w: 800, h: 650 });
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [liveBranding, setLiveBranding] = useState<{
    logoUrl: string | null;
    stampUrl: string | null;
    signatureUrl: string | null;
  }>(() => cachedInvoiceBranding || {
    logoUrl: null,
    stampUrl: null,
    signatureUrl: null
  });

  useEffect(() => {
    if (cachedInvoiceBranding) {
      setLiveBranding(cachedInvoiceBranding);
      return;
    }
    const fetchBranding = async () => {
      try {
        const token = localStorage.getItem('token');
        if (!token) return;
        const res = await api.fetch('/api/user/invoice-branding', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const raw = await res.json();
          const data = raw?.data || raw;
          const branding = {
            logoUrl: data?.logoUrl || null,
            stampUrl: data?.stampUrl || null,
            signatureUrl: data?.signatureUrl || null
          };
          cachedInvoiceBranding = branding;
          setLiveBranding(branding);
        }
      } catch {
        // non-blocking
      }
    };
    void fetchBranding();
  }, []);

  const currentTheme = NEUTRAL_MINIMAL_THEME;

  // Auto-fit calculation to ensure the entire 1-page receipt is visible without scrolling
  useLayoutEffect(() => {
    if (activeTab !== 'receipt') return;

    const measureAndScale = () => {
      const canvas = canvasRef.current;
      const sheet = sheetRef.current;
      if (!canvas || !sheet) return;

      const unscaledH = sheet.offsetHeight || 650;
      const unscaledW = sheet.offsetWidth || 800;
      setSheetDims({ w: unscaledW, h: unscaledH });

      if (zoomMode === '100%') {
        setScaleFactor(1);
        return;
      }

      if (zoomMode === 'custom') {
        return;
      }

      // Available space inside canvas minus comfortable padding
      const availH = canvas.clientHeight - 32;
      const availW = canvas.clientWidth - 32;

      if (unscaledH > 0 && availH > 0 && unscaledW > 0 && availW > 0) {
        const fitScaleY = availH / unscaledH;
        const fitScaleX = availW / unscaledW;
        // Best scale to fit both height and width completely within screen
        const bestScale = Math.min(fitScaleY, fitScaleX);
        setScaleFactor(Math.max(0.35, Math.min(1.25, Number(bestScale.toFixed(2)))));
      }
    };

    measureAndScale();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && canvasRef.current) {
      observer = new ResizeObserver(() => {
        measureAndScale();
      });
      observer.observe(canvasRef.current);
    }

    const timer1 = setTimeout(measureAndScale, 50);
    const timer2 = setTimeout(measureAndScale, 150);

    return () => {
      observer?.disconnect();
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [activeTab, zoomMode, order, isFullscreen]);

  // Sync initial order
  useEffect(() => {
    if (initialOrder?.id && poDetailCache.has(initialOrder.id)) {
      setOrder({ ...initialOrder, ...poDetailCache.get(initialOrder.id)! });
    } else {
      setOrder(initialOrder);
    }
  }, [initialOrder]);

  const reloadDetails = async () => {
    if (!initialOrder?.id) return;
    try {
      const res = await api.get(`/api/purchase-orders/${initialOrder.id}`);
      const body = await readJsonResponse(res);
      const fullData = (body as any)?.data || body;
      if (fullData && fullData.id) {
        poDetailCache.set(initialOrder.id, fullData);
        setOrder(prev => ({ ...(prev || initialOrder), ...fullData }));
      }
    } catch (err) {
      console.warn('Failed to refresh PO details', err);
    }
  };

  // Fetch full details whenever the modal opens to guarantee all organization relations are populated
  useEffect(() => {
    if (!initialOrder?.id) return;
    let isMounted = true;

    // Fast-path: if already cached, apply immediately
    if (poDetailCache.has(initialOrder.id)) {
      setOrder(prev => ({ ...(prev || initialOrder), ...poDetailCache.get(initialOrder.id)! }));
      setIsLoadingDetails(false);
      return;
    }

    const hasSeller = Boolean(initialOrder.seller?.organization?.organizationName || initialOrder.seller?.name);
    const hasItems = Array.isArray(initialOrder.items) && initialOrder.items.length > 0;
    if (!hasSeller || !hasItems) {
      setIsLoadingDetails(true);
    }

    const fetchFullDetails = async () => {
      try {
        const res = await api.get(`/api/purchase-orders/${initialOrder.id}`);
        const body = await readJsonResponse(res);
        const fullData = (body as any)?.data || body;
        if (fullData && fullData.id && isMounted) {
          poDetailCache.set(initialOrder.id, fullData);
          setOrder(prev => ({ ...(prev || initialOrder), ...fullData }));
          setIsLoadingDetails(false);
        }
      } catch (err) {
        console.warn('Failed to fetch full PO details for modal', err);
        if (isMounted) setIsLoadingDetails(false);
      }
    };

    fetchFullDetails();

    return () => {
      isMounted = false;
    };
  }, [initialOrder?.id]);

  // Keyboard shortcut: Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!order) return null;

  // Authentic Seller & Buyer data extraction with strict N/A fallback (Zero dummy/mock data)
  const sellerReg = (order.seller?.registrationDetails as Record<string, any>) || {};
  const sellerOrg =
    order.seller?.organization?.organizationName ||
    sellerReg.tradeName ||
    sellerReg.legalName ||
    sellerReg.businessName ||
    sellerReg.gstDetails?.tradeName ||
    sellerReg.gstDetails?.legalName ||
    sellerReg.gstDetails?.organizationName ||
    order.seller?.sellerProfile?.businessName ||
    order.seller?.sellerProfile?.companyName ||
    sellerReg.companyName ||
    order.seller?.name ||
    'N/A';

  const sellerOrgAddress = order.seller?.organization?.address ||
    [order.seller?.organization?.addressLine1, order.seller?.organization?.addressLine2, order.seller?.organization?.city, order.seller?.organization?.state, order.seller?.organization?.pincode].filter(Boolean).join(', ');

  const sellerAddress =
    sellerOrgAddress ||
    order.seller?.sellerProfile?.registeredAddress ||
    order.seller?.sellerProfile?.address ||
    sellerReg.businessAddress ||
    sellerReg.registeredAddress ||
    sellerReg.address ||
    sellerReg.gstDetails?.businessAddress ||
    sellerReg.gstDetails?.registeredOfficeAddress ||
    sellerReg.gstDetails?.address ||
    'N/A';

  const sellerPhone =
    order.seller?.mobile ||
    order.seller?.sellerProfile?.mobile ||
    sellerReg.mobile ||
    sellerReg.phone ||
    'N/A';

  const sellerEmail = order.seller?.email || sellerReg.email || 'N/A';

  const sellerGstin =
    order.seller?.organization?.gstin ||
    order.seller?.sellerProfile?.gst ||
    sellerReg.gstin ||
    sellerReg.gstDetails?.gstin ||
    sellerReg.gstDetails?.gstNumber ||
    sellerReg.gstDetails?.responseGstin ||
    'N/A';

  const sellerPan =
    order.seller?.organization?.panNumber ||
    order.seller?.sellerProfile?.pan ||
    sellerReg.pan ||
    sellerReg.orgPan ||
    sellerReg.personalPan ||
    sellerReg.gstDetails?.pan ||
    'N/A';

  const sellerUdyam =
    order.seller?.organization?.udyamNumber ||
    order.seller?.sellerProfile?.udyamNumber ||
    sellerReg.udyamNumber ||
    sellerReg.udyamDetails?.udyamNumber ||
    sellerReg.udyam ||
    null;

  const buyerReg = (order.buyer?.registrationDetails as Record<string, any>) || {};
  const buyerOrg =
    order.buyer?.organization?.organizationName ||
    order.buyer?.buyerProfile?.organizationName ||
    order.buyer?.buyerProfile?.companyName ||
    buyerReg.companyName ||
    buyerReg.businessName ||
    buyerReg.legalName ||
    buyerReg.tradeName ||
    order.buyer?.name ||
    'N/A';

  const buyerOrgAddress = order.buyer?.organization?.address ||
    [order.buyer?.organization?.addressLine1, order.buyer?.organization?.addressLine2, order.buyer?.organization?.city, order.buyer?.organization?.state, order.buyer?.organization?.pincode].filter(Boolean).join(', ');

  const buyerAddress =
    buyerOrgAddress ||
    order.buyer?.buyerProfile?.registeredAddress ||
    order.buyer?.buyerProfile?.address ||
    buyerReg.registeredAddress ||
    buyerReg.address ||
    'N/A';

  const deliveryAddress =
    order.deliveryAddress ||
    buyerAddress;

  const buyerPhone =
    order.buyer?.mobile ||
    order.buyer?.buyerProfile?.mobile ||
    buyerReg.mobile ||
    buyerReg.phone ||
    'N/A';

  const buyerEmail = order.buyer?.email || buyerReg.email || 'N/A';

  const buyerGstin =
    order.buyer?.organization?.gstin ||
    order.buyer?.buyerProfile?.gst ||
    buyerReg.gstin ||
    buyerReg.gstDetails?.gstin ||
    buyerReg.gstDetails?.gstNumber ||
    'N/A';

  const buyerPan =
    order.buyer?.organization?.panNumber ||
    order.buyer?.buyerProfile?.pan ||
    buyerReg.pan ||
    buyerReg.gstDetails?.pan ||
    'N/A';

  // Resolving Logos, Stamps and Signatures (Primary: OrganizationProfile -> Backup: registrationDetails -> FileAsset FK)
  const sellerLogo =
    order.seller?.organization?.profile?.logoUrl ||
    sellerReg.logoUrl ||
    order.seller?.organization?.logoFile?.url ||
    order.seller?.organization?.logoFile?.fileUrl ||
    (order.seller?.organization?.organizationLogoFileId ? `/api/files/${order.seller.organization.organizationLogoFileId}/view` : null) ||
    (order.seller?.organization?.organizationLogoFileId ? `/api/files/${order.seller.organization.organizationLogoFileId}/download` : null) ||
    null;

  const buyerLogo =
    order.buyer?.organization?.profile?.logoUrl ||
    buyerReg.logoUrl ||
    order.buyer?.organization?.logoFile?.url ||
    order.buyer?.organization?.logoFile?.fileUrl ||
    (order.buyer?.organization?.organizationLogoFileId ? `/api/files/${order.buyer.organization.organizationLogoFileId}/view` : null) ||
    (order.buyer?.organization?.organizationLogoFileId ? `/api/files/${order.buyer.organization.organizationLogoFileId}/download` : null) ||
    null;

  const isViewingSeller = isSeller || user?.role === 'seller' || user?.role === 'shg' || (order && order.sellerId === user?.id);
  const isViewingBuyer = isBuyer || user?.role === 'buyer' || (order && order.buyerId === user?.id);

  const currentUserReg = (user?.registrationDetails as Record<string, any>) || {};
  const lsStamp = typeof window !== 'undefined' ? localStorage.getItem('msme_invoice_stamp') : null;
  const lsSig = typeof window !== 'undefined' ? localStorage.getItem('msme_invoice_signature') : null;
  const lsLogo = typeof window !== 'undefined' ? localStorage.getItem('msme_invoice_logo') : null;

  const sellerSignature = sellerReg.signatureUrl || null;
  const sellerStamp = sellerReg.stampUrl || null;

  const buyerSignature = buyerReg.signatureUrl || null;
  const buyerStamp = buyerReg.stampUrl || null;

  const effectiveSellerLogo = sellerLogo || (isViewingSeller ? (currentUserReg.logoUrl || liveBranding.logoUrl || lsLogo) : null);
  const effectiveBuyerLogo = buyerLogo || (isViewingBuyer ? (currentUserReg.logoUrl || liveBranding.logoUrl || lsLogo) : null);

  const effectiveSellerSignature = sellerSignature || (isViewingSeller ? (currentUserReg.signatureUrl || liveBranding.signatureUrl || lsSig) : null);
  const effectiveSellerStamp = sellerStamp || (isViewingSeller ? (currentUserReg.stampUrl || liveBranding.stampUrl || lsStamp) : null);

  const effectiveBuyerSignature = buyerSignature || (isViewingBuyer ? (currentUserReg.signatureUrl || liveBranding.signatureUrl || lsSig) : null);
  const effectiveBuyerStamp = buyerStamp || (isViewingBuyer ? (currentUserReg.stampUrl || liveBranding.stampUrl || lsStamp) : null);

  const topLogo = effectiveBuyerLogo || effectiveSellerLogo;
  const topOrgName = buyerOrg !== 'N/A' ? buyerOrg : (sellerOrg !== 'N/A' ? sellerOrg : 'Enterprise Procurement');

  // Resolve media URLs to ensure local dev proxy & CORS compatibility
  const resolvedTopLogo = resolveMediaUrl(topLogo);
  const resolvedSellerLogo = resolveMediaUrl(effectiveSellerLogo);
  const resolvedBuyerLogo = resolveMediaUrl(effectiveBuyerLogo);
  const resolvedSellerSignature = resolveMediaUrl(effectiveSellerSignature);
  const resolvedSellerStamp = resolveMediaUrl(effectiveSellerStamp);
  const resolvedBuyerSignature = resolveMediaUrl(effectiveBuyerSignature);
  const resolvedBuyerStamp = resolveMediaUrl(effectiveBuyerStamp);

  const shipVia =
    order.deliveryType ? readableStatus(order.deliveryType) : 'Standard Ground Logistics';

  const rawTracking =
    activeDelivery?.trackingNumber ||
    (order.deliveryTrackings && order.deliveryTrackings[0]?.trackingNumber) ||
    null;
  const isPendingShipment = ['issued', 'generated', 'pending acceptance', 'accepted'].includes(String(order.status || '').toLowerCase()) ||
    ['CREATED', 'PENDING'].includes(String(activeDelivery?.status || ''));
  const trackingNumber = rawTracking || (isPendingShipment ? 'Pending Dispatch' : 'N/A');

  const poDate = formatIsoDate(order.createdAt);
  const dueDate = formatIsoDate(order.expectedDelivery || order.createdAt);

  // Line items normalization
  const rawItems = order.items && order.items.length > 0
    ? order.items
    : (order.metadata?.cartSnapshot?.items || [{
        itemName: order.title,
        quantity: 1,
        unitPrice: Number(order.amount || order.totalValue || 0),
        totalAmount: Number(order.amount || order.totalValue || 0),
      }]);

  const grandTotal = Number(order.amount || order.totalValue || 0);
  const rawGstRate = Number(order.metadata?.gstRate || 18);
  const metaGstAmount = Number(order.metadata?.gstAmount || 0);
  const metaBase = Number(order.metadata?.baseAmount || order.metadata?.taxableAmount || order.metadata?.quotationPricing?.subtotal || 0);

  // If order explicitly recorded gstAmount and baseAmount, use them directly:
  // Otherwise, if grandTotal > 0 and rawGstRate > 0, compute taxableBase = grandTotal / (1 + rawGstRate/100)
  let taxableBase: number;
  let taxAmount: number;
  if (metaBase > 0 && metaGstAmount > 0 && Math.abs((metaBase + metaGstAmount) - grandTotal) < 5) {
    taxableBase = metaBase;
    taxAmount = metaGstAmount;
  } else if (metaBase > 0 && metaBase < grandTotal) {
    taxableBase = metaBase;
    taxAmount = Math.round((grandTotal - metaBase) * 100) / 100;
  } else if (grandTotal > 0 && rawGstRate > 0) {
    taxableBase = Math.round((grandTotal / (1 + rawGstRate / 100)) * 100) / 100;
    taxAmount = Math.max(0, Math.round((grandTotal - taxableBase) * 100) / 100);
  } else {
    taxableBase = grandTotal;
    taxAmount = 0;
  }

  // Determine Inter-state (IGST) vs Intra-state (CGST + SGST) based on Buyer and Seller GSTIN state codes
  const buyerStateCode = buyerGstin && buyerGstin !== 'N/A' ? buyerGstin.slice(0, 2) : '';
  const sellerStateCode = sellerGstin && sellerGstin !== 'N/A' ? sellerGstin.slice(0, 2) : '';
  const isInterstate = Boolean(buyerStateCode && sellerStateCode && buyerStateCode !== sellerStateCode);
  const cgstAmount = !isInterstate && taxAmount > 0 ? Math.round((taxAmount / 2) * 100) / 100 : 0;
  const sgstAmount = !isInterstate && taxAmount > 0 ? Math.round((taxAmount - cgstAmount) * 100) / 100 : 0;
  const igstAmount = isInterstate ? taxAmount : 0;
  const taxLabel = isInterstate ? `IGST (${rawGstRate}%)` : `TAX / GST (${rawGstRate}%)`;

  const displayItems = rawItems.map((it: any, idx: number) => {
    const name = it.product?.name || it.itemName || it.name || it.title || `Item ${idx + 1}`;
    const qty = Number(it.quantity || 1);
    let unitPrice = Number(it.unitPrice || 0);

    // Guard against legacy bug where unitPrice was set to the entire lot gross amount:
    if (unitPrice === 0 || (qty > 1 && (unitPrice * qty) > (grandTotal * 1.2)) || (unitPrice >= grandTotal && qty > 1)) {
      unitPrice = Math.round(((taxableBase > 0 ? taxableBase : grandTotal) / (qty > 0 ? qty : 1)) * 100) / 100;
    }
    const total = Math.round(qty * unitPrice * 100) / 100;
    const specs = it.description || it.specifications?.description || (it.product?.brand ? `Brand: ${it.product.brand}` : '');
    const productCode = it.product?.code || (it.productId ? `PRD-${it.productId}` : `SKU-${idx + 101}`);
    
    // Comprehensive HSN resolution (check item, product, specs, order metadata, bid metadata, and seller profile)
    const hsn =
      it.hsnCode ||
      it.hsn ||
      it.hsn_sac_code ||
      it.hsnSacCode ||
      it.hsnSac ||
      it.sacCode ||
      it.sac ||
      it.product?.hsnCode ||
      it.product?.hsn ||
      it.specifications?.hsn_sac_code ||
      it.specifications?.hsnCode ||
      it.specifications?.hsn ||
      order.metadata?.hsnCode ||
      order.metadata?.hsn ||
      order.metadata?.hsnSac ||
      order.metadata?.bid?.items?.[idx]?.hsn ||
      order.metadata?.bid?.items?.[idx]?.hsnCode ||
      order.metadata?.bid?.items?.[idx]?.hsn_sac_code ||
      order.seller?.sellerProfile?.hsnCode ||
      sellerReg?.hsnCode ||
      sellerReg?.hsn ||
      sellerReg?.gstDetails?.hsnCode ||
      'N/A';

    const unit = it.unitOfMeasure || it.unit || it.product?.unitOfMeasure || 'Nos';
    const taxRate = it.taxRate !== undefined && it.taxRate !== null ? `${it.taxRate}%` : `${rawGstRate}%`;

    return {
      name,
      specs,
      quantity: qty,
      unitPrice,
      total,
      productCode,
      hsn,
      unit,
      taxRate,
    };
  });

  const subtotal = taxableBase > 0 ? taxableBase : (displayItems.reduce((acc, it) => acc + it.total, 0) || grandTotal);

  // On screen, only add filler rows if items < 3 to ensure the entire page fits without scrolling
  const fillerRowCount = Math.max(0, 3 - displayItems.length);
  const fillerRows = Array.from({ length: fillerRowCount });

  const handleDirectDownloadPdf = async () => {
    if (isGeneratingPdf) return;

    if (onDownloadPdf) {
      onDownloadPdf(order);
      return;
    }

    // If buyer uploaded an authentic official PO PDF document, download that directly!
    const attachedFileId = (order as any)?.externalPdfFileId || (order as any)?.pdfFileId;
    if (attachedFileId) {
      try {
        setIsGeneratingPdf(true);
        toast.loading('Downloading official buyer-uploaded PO...', { id: 'po-pdf-dl' });
        const res = await api.fetch(`/api/purchase-orders/${order.id}/download-pdf`);
        if (res.ok) {
          const blob = await res.blob();
          const downloadUrl = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.download = `${order.poNumber || `PO-${order.id}`}.pdf`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.URL.revokeObjectURL(downloadUrl);
          toast.success('Official Purchase Order PDF downloaded', { id: 'po-pdf-dl' });
          return;
        }
      } catch (dlErr) {
        console.warn('Failed to download uploaded PO PDF directly, falling back to generator', dlErr);
      } finally {
        setIsGeneratingPdf(false);
      }
    }

    try {
      setIsGeneratingPdf(true);
      toast.loading('Generating Purchase Order PDF...', { id: 'po-pdf-dl' });
      const { generateOfficialPurchaseOrderPdf } = await import('../lib/purchaseOrderPdfGenerator');

      const doc = await generateOfficialPurchaseOrderPdf({
        poNumber: order.poNumber || `PO-${order.id}`,
        poDate,
        dueDate,
        status: readableStatus(order.status),
        shipVia,
        trackingNumber,
        paymentTerms: order.paymentTerms ? readableStatus(order.paymentTerms) : 'Escrow Held / Pay on Invoice',
        issuerName: topOrgName,
        issuerSubtitle: 'Official Purchase Order Document',
        issuerLogoUrl: resolvedTopLogo || topLogo,
        buyer: {
          name: buyerOrg,
          contactName: order.buyer?.name && order.buyer.name !== buyerOrg ? order.buyer.name : undefined,
          address: deliveryAddress,
          gstin: buyerGstin,
          pan: buyerPan,
          phone: buyerPhone,
          email: buyerEmail,
          logoUrl: resolvedBuyerLogo || effectiveBuyerLogo,
          stampUrl: resolvedBuyerStamp || effectiveBuyerStamp,
          signatureUrl: resolvedBuyerSignature || effectiveBuyerSignature,
        },
        seller: {
          name: sellerOrg,
          contactName: order.seller?.name && order.seller.name !== sellerOrg ? order.seller.name : undefined,
          address: sellerAddress,
          udyamNumber: sellerUdyam || undefined,
          gstin: sellerGstin,
          pan: sellerPan,
          phone: sellerPhone,
          email: sellerEmail,
          logoUrl: resolvedSellerLogo || effectiveSellerLogo,
          stampUrl: resolvedSellerStamp || effectiveSellerStamp,
          signatureUrl: resolvedSellerSignature || effectiveSellerSignature,
        },
        items: displayItems.map((item, idx) => ({
          itemIndex: idx + 1,
          productCode: item.productCode,
          name: item.name,
          specs: item.specs,
          hsn: item.hsn,
          quantity: item.quantity,
          unit: item.unit,
          unitPrice: item.unitPrice,
          total: item.total,
        })),
        financials: {
          subtotal,
          shipping: 0,
          taxAmount,
          taxLabel,
          grandTotal,
        },
        notes: [
          '1. Delivery must strictly adhere to agreed specifications and timeline.',
          '2. Invoice raised must contain this Purchase Order Number and Date.',
          `3. Payment Terms: ${order.paymentTerms ? readableStatus(order.paymentTerms) : 'Escrow Held / Pay on Invoice'}.`,
          ...(order.metadata?.notes ? [`4. ${order.metadata.notes}`] : []),
        ],
      });

      const filename = `${order.poNumber || `PO-${order.id}`}.pdf`;
      doc.save(filename);
      toast.success('Purchase Order PDF downloaded', { id: 'po-pdf-dl' });
    } catch (err) {
      console.error('Failed to generate PDF:', err);
      toast.error('Failed to download PDF. Please try again.', { id: 'po-pdf-dl' });
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const viewingStatusLower = String(order.status || '').toLowerCase();
  const isIssued = viewingStatusLower === 'issued' || viewingStatusLower === 'generated' || viewingStatusLower === 'order_placed' || viewingStatusLower === 'pending_approval';
  const isAccepted = viewingStatusLower === 'accepted' || viewingStatusLower === 'in_fulfillment';

  return (
    <div
      className={cn(
        'fixed inset-0 z-[100] flex flex-col bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-100 overflow-hidden',
        !isFullscreen && 'p-3 sm:p-6 items-center justify-center'
      )}
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Purchase Order Receipt"
    >
      {/* Print stylesheet for 1-page physical printing */}
      <style dangerouslySetInnerHTML={{
        __html: `
        @page {
          size: A4 portrait;
          margin: 8mm;
        }
        @media print {
          body * {
            visibility: hidden !important;
          }
          #po-receipt-print-sheet, #po-receipt-print-sheet * {
            visibility: visible !important;
          }
          .po-scale-wrapper {
            width: 100% !important;
            height: auto !important;
            transform: none !important;
            display: block !important;
            position: static !important;
          }
          #po-receipt-print-sheet {
            position: fixed !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            max-width: 100% !important;
            margin: 0 !important;
            padding: 6mm !important;
            box-shadow: none !important;
            border: 2px solid black !important;
            background: white !important;
            transform: none !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .no-print {
            display: none !important;
          }
        }
        `
      }} />

      {/* Main Container Card */}
      <FocusTrap onEscape={onClose} className={cn("w-full flex justify-center", isFullscreen ? "h-full" : "h-[92vh] max-h-[95vh] max-w-5xl lg:max-w-6xl xl:max-w-7xl")}>
        <div
          className={cn(
            'flex flex-col bg-white overflow-hidden shadow-2xl transition-all duration-150 transform-gpu will-change-[transform,opacity] w-full',
            isFullscreen
              ? 'h-full w-full rounded-none'
              : 'h-full rounded-2xl border border-slate-200'
          )}
        >
        {/* Top Control Header Bar (Hidden in Print) */}
        <header className="no-print bg-[#0b1f3a] text-white px-3 sm:px-4 py-2 sm:py-2.5 shrink-0 flex items-center justify-between border-b border-white/10 shadow-md gap-2 sm:gap-4">
          {/* Left: Navigation, PO info, and Status Badge */}
          <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-8 sm:h-8.5 px-2 sm:px-2.5 text-white/90 hover:text-white hover:bg-white/10 text-xs font-bold rounded-xl gap-1 transition-all shrink-0 cursor-pointer"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Back</span>
            </Button>

            <div className="h-4 w-px bg-white/20 hidden sm:block shrink-0" />

            <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
              <span className="font-mono font-black text-xs sm:text-sm text-white tracking-tight whitespace-nowrap">
                {order.poNumber}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (order.poNumber) {
                    navigator.clipboard.writeText(order.poNumber);
                    toast.success('PO Number copied to clipboard');
                  }
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-all shrink-0 cursor-pointer"
                title="Copy PO Number"
                aria-label="Copy PO Number"
              >
                <Copy className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>

            {/* Status Badge: always visible, clearly styled with status semantics without overlapping */}
            {(() => {
              const statusStyles = getStatusBadgeStyles(order.status);
              return (
                <span className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2 sm:px-2.5 py-0.5 text-[10px] sm:text-[11px] font-black uppercase tracking-wider shrink-0 transition-colors",
                  statusStyles.badge
                )}>
                  <span className={cn("h-1.5 w-1.5 rounded-full animate-pulse", statusStyles.dot)} />
                  <span>{readableStatus(order.status)}</span>
                </span>
              );
            })()}
          </div>

          {/* Center: View Mode Toggle Tabs */}
          <div className="flex items-center justify-center shrink-0">
            <div className="flex items-center bg-white/10 p-0.5 rounded-xl border border-white/15 shrink-0">
              <button
                type="button"
                onClick={() => setActiveTab('receipt')}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-black uppercase tracking-wider transition-all cursor-pointer whitespace-nowrap',
                  activeTab === 'receipt'
                    ? 'bg-white text-slate-950 shadow-sm'
                    : 'text-white/80 hover:text-white hover:bg-white/5'
                )}
              >
                <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Receipt</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('audit')}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-black uppercase tracking-wider transition-all cursor-pointer whitespace-nowrap',
                  activeTab === 'audit'
                    ? 'bg-white text-slate-950 shadow-sm'
                    : 'text-white/80 hover:text-white hover:bg-white/5'
                )}
              >
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="hidden md:inline">Audit & Tracking</span>
                <span className="md:hidden">Audit</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('gfr')}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-black uppercase tracking-wider transition-all cursor-pointer whitespace-nowrap',
                  activeTab === 'gfr'
                    ? 'bg-white text-slate-950 shadow-sm'
                    : 'text-white/80 hover:text-white hover:bg-white/5'
                )}
              >
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                <span className="hidden xl:inline">GFR Compliance (PBG &amp; LD)</span>
                <span className="hidden sm:inline xl:hidden">GFR Compliance</span>
                <span className="sm:hidden">GFR</span>
              </button>
            </div>
          </div>

          {/* Right: Zoom controls (when in Receipt tab) + Fullscreen + Close */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 ml-auto">
            {activeTab === 'receipt' && (
              <div className="hidden lg:flex items-center bg-white/10 p-0.5 rounded-xl border border-white/15 gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setZoomMode('custom');
                    setScaleFactor(prev => Math.max(0.4, Number((prev - 0.1).toFixed(2))));
                  }}
                  className="h-6.5 w-6.5 flex items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-all cursor-pointer"
                  title="Zoom Out"
                  aria-label="Zoom Out"
                >
                  <ZoomOut className="h-3 w-3" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => setZoomMode('fit')}
                  className={cn(
                    'px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all cursor-pointer whitespace-nowrap',
                    zoomMode === 'fit'
                      ? 'bg-white text-slate-950 shadow-sm'
                      : 'text-white/70 hover:text-white hover:bg-white/5'
                  )}
                  title="Fit whole page in window without scrolling"
                >
                  Fit Page ({Math.round(scaleFactor * 100)}%)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setZoomMode('100%');
                    setScaleFactor(1);
                  }}
                  className={cn(
                    'px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all cursor-pointer whitespace-nowrap',
                    zoomMode === '100%' || (zoomMode === 'custom' && scaleFactor === 1)
                      ? 'bg-white text-slate-950 shadow-sm'
                      : 'text-white/70 hover:text-white hover:bg-white/5'
                  )}
                  title="View at regular 100% actual size"
                >
                  100%
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setZoomMode('custom');
                    setScaleFactor(prev => Math.min(1.5, Number((prev + 0.1).toFixed(2))));
                  }}
                  className="h-6.5 w-6.5 flex items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-all cursor-pointer"
                  title="Zoom In"
                  aria-label="Zoom In"
                >
                  <ZoomIn className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            )}

            {activeTab === 'receipt' && <div className="hidden lg:block h-4 w-px bg-white/20 shrink-0" />}

            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setIsFullscreen(!isFullscreen)}
              className="h-8 w-8 sm:h-8.5 sm:w-8.5 text-white/80 hover:text-white hover:bg-white/15 rounded-xl transition-all shrink-0 cursor-pointer"
              title={isFullscreen ? 'Exit Full Screen' : 'Full Screen'}
              aria-label={isFullscreen ? 'Exit Full Screen' : 'Full Screen'}
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-8 w-8 sm:h-8.5 sm:w-8.5 flex items-center justify-center rounded-xl bg-white/10 text-white hover:bg-rose-600 hover:text-white transition-all shrink-0 cursor-pointer border border-white/15 shadow-xs"
              title="Close modal"
              aria-label="Close modal"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </header>

        {/* Modal Body Canvas */}
        <div
          ref={canvasRef}
          className={cn(
            "flex-1 min-h-0 overflow-y-auto overflow-x-hidden transition-colors duration-200",
            activeTab === 'receipt'
              ? (canvasBg === 'light' ? "bg-slate-100/90" : "bg-slate-950")
              : "bg-slate-50/70"
          )}
        >
          {activeTab === 'receipt' ? (
            /* 1st Page Format: RECEIPT PURCHASE ORDER (Exact Match to Image 1) */
            <div className="min-h-full w-full p-3 sm:p-6 flex flex-col items-center justify-start sm:justify-center overflow-x-auto">
              {isLoadingDetails ? (
                <div className="flex flex-col items-center justify-center p-12 bg-white rounded-xl border border-slate-200 shadow-md my-auto max-w-md text-center">
                  <RefreshCw className="h-8 w-8 text-[#12335f] animate-spin mb-3 text-center mx-auto" />
                  <p className="text-sm font-bold text-slate-800">Loading Official Purchase Order...</p>
                  <p className="text-xs text-slate-500 mt-1">Retrieving official organization profile, line items, and tax credentials</p>
                </div>
              ) : (
                <div
                  className="po-scale-wrapper relative mx-auto my-auto shrink-0 transition-all duration-150"
                style={{
                  width: `${Math.round((sheetDims.w || 800) * scaleFactor)}px`,
                  height: `${Math.round((sheetDims.h || 650) * scaleFactor)}px`,
                  position: 'relative',
                }}
              >
                <div
                  ref={sheetRef}
                  id="po-receipt-print-sheet"
                  style={{
                    width: '800px',
                    maxWidth: '800px',
                    transform: scaleFactor !== 1 ? `scale(${scaleFactor})` : undefined,
                    transformOrigin: 'top left',
                    position: scaleFactor !== 1 ? 'absolute' : 'relative',
                    left: 0,
                    top: 0,
                  }}
                  className={cn(
                    "bg-white text-slate-900 rounded-sm border-2 border-black p-4 sm:p-5 flex flex-col justify-between shrink-0 transition-shadow",
                    canvasBg === 'light' ? "shadow-2xl shadow-slate-400/50" : "shadow-2xl shadow-black/80"
                  )}
                >
                <div>
                  {/* Header Branding & Title */}
                  <div className="flex items-center justify-between border-b pb-2 mb-2.5">
                    <div className="flex items-center gap-2.5">
                      {resolvedTopLogo && (
                        <img src={resolvedTopLogo} alt="Organization Logo" className="h-10 w-10 object-contain rounded" />
                      )}
                      <div>
                        <h2 className="text-base font-black text-slate-950 uppercase tracking-tight font-sans">
                          {topOrgName}
                        </h2>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <p className="text-[10px] text-slate-500 font-medium">Official Purchase Order Document</p>
                          {Boolean((order as any)?.externalPdfFileId || (order as any)?.pdfFileId) && (
                            <button
                              type="button"
                              onClick={() => {
                                const fileId = (order as any)?.externalPdfFileId || (order as any)?.pdfFileId;
                                openFileAsset({
                                  id: fileId,
                                  fileAssetId: fileId,
                                  originalName: (order as any)?.externalPdfFile?.originalName || (order as any)?.pdfFile?.originalName || `Purchase_Order_${order.poNumber || order.id}.pdf`
                                }, 'Purchase Order PDF').catch(err => {
                                  toast.error(err instanceof Error ? err.message : 'Unable to open PO PDF');
                                });
                              }}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-100 hover:bg-blue-200 text-blue-800 border border-blue-200 cursor-pointer transition-colors"
                              title="Click to view authentic uploaded PO PDF"
                            >
                              <Eye className="h-2.5 w-2.5 text-blue-700" />
                              <span>Buyer Signed PO Attached</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <h1 className="text-xl sm:text-2xl font-black text-slate-950 uppercase tracking-widest font-sans">
                        PURCHASE ORDER
                      </h1>
                      <p className="text-[10px] font-mono text-slate-600 font-bold">{order.poNumber || `PO-${order.id}`}</p>
                    </div>
                  </div>

                  {/* Table 1: Vendor & PO Info */}
                  <table className="w-full border-collapse border border-black text-xs mb-2">
                    <tbody>
                      <tr className="border-b border-slate-300">
                        <td className={cn("w-1/6 font-bold p-1.5 border-r border-slate-400 transition-colors", currentTheme.labelBg, currentTheme.labelText)}>Vendor Name:</td>
                        <td className="w-2/6 font-semibold p-1.5 text-slate-900 border-r border-black">
                          <div className="flex items-center gap-2">
                            {resolvedSellerLogo && (
                              <img src={resolvedSellerLogo} alt="Seller Logo" className="h-6 w-6 object-contain rounded shrink-0 border border-slate-200 bg-white" />
                            )}
                            <div className="min-w-0">
                              <div className="font-bold text-slate-950 truncate">{sellerOrg}</div>
                              {order.seller?.name && order.seller.name !== sellerOrg && (
                                <div className="text-[9px] text-slate-500 font-medium truncate">Contact: {order.seller.name}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className={cn("w-1/6 font-bold p-1.5 border-r border-slate-400 transition-colors", currentTheme.labelBg, currentTheme.labelText)}>PO Date:</td>
                        <td className="w-2/6 font-semibold p-1.5 text-slate-900 font-mono">{poDate}</td>
                      </tr>
                      <tr className="border-b border-slate-300">
                        <td className={cn("font-bold p-1.5 border-r border-slate-400 transition-colors", currentTheme.labelBg, currentTheme.labelText)}>Vendor Address:</td>
                        <td className="font-semibold p-1.5 text-slate-900 border-r border-black leading-tight">{sellerAddress}</td>
                        <td className={cn("font-bold p-1.5 border-r border-slate-400 transition-colors", currentTheme.labelBg, currentTheme.labelText)}>Udyam Reg. No.:</td>
                        <td className="font-black p-1.5 text-slate-950 font-mono">{sellerUdyam || 'N/A'}</td>
                      </tr>
                      <tr>
                        <td className={cn("font-bold p-1.5 border-r border-slate-400 transition-colors", currentTheme.labelBg, currentTheme.labelText)}>Vendor Tax Info:</td>
                        <td className="font-semibold p-1.5 text-slate-900 border-r border-black font-mono">GSTIN: {sellerGstin} | PAN: {sellerPan}</td>
                        <td className={cn("font-bold p-1.5 border-r border-slate-400 transition-colors", currentTheme.labelBg, currentTheme.labelText)}>Vendor Contact:</td>
                        <td className="font-semibold p-1.5 text-slate-900 font-mono">{sellerPhone} | {sellerEmail}</td>
                      </tr>
                    </tbody>
                  </table>

                  {/* Table 2: Ship To & Shipping Details */}
                  <table className="w-full border-collapse border border-black text-xs mb-2">
                    <tbody>
                      <tr className="border-b border-slate-300">
                        <td className={cn("w-1/6 font-bold p-1.5 border-r border-slate-400 transition-colors", currentTheme.labelBg, currentTheme.labelText)}>Ship To:</td>
                        <td className="w-2/6 font-semibold p-1.5 text-slate-900 border-r border-black">
                          <div className="flex items-center gap-2">
                            {resolvedBuyerLogo && (
                              <img src={resolvedBuyerLogo} alt="Buyer Logo" className="h-6 w-6 object-contain rounded shrink-0 border border-slate-200 bg-white" />
                            )}
                            <div className="min-w-0">
                              <div className="font-bold text-slate-950 truncate">{buyerOrg}</div>
                              {order.buyer?.name && order.buyer.name !== buyerOrg && (
                                <div className="text-[9px] text-slate-500 font-medium truncate">Attn: {order.buyer.name}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className={cn("w-1/6 font-bold p-1.5 border-r border-slate-400 transition-colors", currentTheme.labelBg, currentTheme.labelText)}>Ship Via:</td>
                        <td className="w-2/6 font-semibold p-1.5 text-slate-900">{shipVia}</td>
                      </tr>
                      <tr className="border-b border-slate-300">
                        <td className={cn("font-bold p-1.5 border-r border-slate-400 transition-colors", currentTheme.labelBg, currentTheme.labelText)}>Delivery Address:</td>
                        <td className="font-semibold p-1.5 text-slate-900 border-r border-black leading-tight">{deliveryAddress}</td>
                        <td className={cn("font-bold p-1.5 border-r border-slate-400 transition-colors", currentTheme.labelBg, currentTheme.labelText)}>Tracking Number:</td>
                        <td className="font-semibold p-1.5 text-slate-900 font-mono">{trackingNumber}</td>
                      </tr>
                      <tr>
                        <td className={cn("font-bold p-1.5 border-r border-slate-400 transition-colors", currentTheme.labelBg, currentTheme.labelText)}>Buyer GSTIN:</td>
                        <td className="font-semibold p-1.5 text-slate-900 border-r border-black font-mono">{buyerGstin}</td>
                        <td className={cn("font-bold p-1.5 border-r border-slate-400 transition-colors", currentTheme.labelBg, currentTheme.labelText)}>Due Date:</td>
                        <td className="font-semibold p-1.5 text-slate-900 font-mono">{dueDate}</td>
                      </tr>
                    </tbody>
                  </table>

                  {/* Table 3: Line Items (Full Enterprise 8-Column Format) */}
                  <table className="w-full border-collapse border border-black text-xs mb-2">
                    <thead>
                      <tr className={cn("border-b border-black font-bold transition-colors", currentTheme.headerBg, currentTheme.headerText)}>
                        <th className={cn("p-1.5 text-center border-r w-10", currentTheme.tableHeaderBorder)}>#</th>
                        <th className={cn("p-1.5 text-left border-r w-24", currentTheme.tableHeaderBorder)}>Code</th>
                        <th className={cn("p-1.5 text-left border-r", currentTheme.tableHeaderBorder)}>Product Description</th>
                        <th className={cn("p-1.5 text-center border-r w-20", currentTheme.tableHeaderBorder)}>HSN/SAC</th>
                        <th className={cn("p-1.5 text-center border-r w-14", currentTheme.tableHeaderBorder)}>Qty</th>
                        <th className={cn("p-1.5 text-center border-r w-14", currentTheme.tableHeaderBorder)}>Units</th>
                        <th className={cn("p-1.5 text-right border-r w-24", currentTheme.tableHeaderBorder)}>Rate [₹]</th>
                        <th className="p-1.5 text-right w-24">Total [₹]</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayItems.map((item, idx) => (
                        <tr key={idx} className="border-b border-slate-200 hover:bg-slate-50/50">
                          <td className="p-1.5 text-center border-r border-slate-300 font-mono">{idx + 1}</td>
                          <td className="p-1.5 text-left border-r border-slate-300 font-mono text-[11px]">{item.productCode}</td>
                          <td className="p-1.5 border-r border-slate-300">
                            <span className="font-bold text-slate-950 block">{item.name}</span>
                            {item.specs && <span className="text-[10px] text-slate-500 block leading-tight">{item.specs}</span>}
                          </td>
                          <td className="p-1.5 text-center border-r border-slate-300 font-mono text-[11px]">{item.hsn}</td>
                          <td className="p-1.5 text-center border-r border-slate-300 font-mono font-semibold">{item.quantity}</td>
                          <td className="p-1.5 text-center border-r border-slate-300 font-mono text-[11px]">{item.unit}</td>
                          <td className="p-1.5 text-right border-r border-slate-300 font-mono">₹{formatNumber(item.unitPrice)}</td>
                          <td className="p-1.5 text-right font-mono font-bold text-slate-950">₹{formatNumber(item.total)}</td>
                        </tr>
                      ))}

                      {/* Placeholder rows matching standard balance */}
                      {fillerRows.map((_, idx) => (
                        <tr key={`fill-${idx}`} className="border-b border-slate-200/60 h-6">
                          <td className="p-1 border-r border-slate-300 text-center text-slate-300 font-mono">-</td>
                          <td className="p-1 border-r border-slate-300 text-slate-300 font-mono">-</td>
                          <td className="p-1 border-r border-slate-300">&nbsp;</td>
                          <td className="p-1 border-r border-slate-300 text-center text-slate-300 font-mono">-</td>
                          <td className="p-1 border-r border-slate-300 text-center text-slate-300 font-mono">-</td>
                          <td className="p-1 border-r border-slate-300 text-center text-slate-300 font-mono">-</td>
                          <td className="p-1 border-r border-slate-300 text-right text-slate-300 font-mono">-</td>
                          <td className="p-1 text-right text-slate-300 font-mono">-</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Bottom Section: ADDITIONAL NOTES & TOTAL AMOUNT */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs mt-1 pt-1">
                  {/* Left: ADDITIONAL NOTES */}
                  <div className="border border-black overflow-hidden flex flex-col">
                    <div className={cn("border-b border-black p-1.5 font-bold uppercase tracking-wide transition-colors", currentTheme.notesHeaderBg, currentTheme.notesHeaderText)}>
                      ADDITIONAL NOTES & TERMS
                    </div>
                    <div className="p-2 text-[11px] text-slate-800 space-y-1 font-medium leading-relaxed bg-white flex-1">
                      <p>1. Delivery must strictly adhere to agreed specifications and timeline.</p>
                      <p>2. Payment Terms: {order.paymentTerms ? readableStatus(order.paymentTerms) : 'Escrow Held / Pay on Invoice'}.</p>
                      <p>3. Vendor invoice must cross-reference this PO Number and Date.</p>
                      {order.metadata?.notes && <p>4. {order.metadata.notes}</p>}
                    </div>
                  </div>

                  {/* Right: FINANCIAL SUMMARY */}
                  <div className="border border-black overflow-hidden">
                    <table className="w-full text-xs">
                      <tbody>
                        <tr className="border-b border-slate-300">
                          <td className="p-1.5 font-bold text-slate-800 text-right w-1/2">Subtotal (Taxable Value):</td>
                          <td className="p-1.5 font-mono font-semibold text-right w-1/2">₹{formatNumber(subtotal)}</td>
                        </tr>
                        <tr className="border-b border-slate-300">
                          <td className="p-1.5 font-bold text-slate-800 text-right">Shipping &amp; Handling:</td>
                          <td className="p-1.5 font-mono font-semibold text-right">₹0.00</td>
                        </tr>
                        {isInterstate ? (
                          <tr className="border-b border-slate-300">
                            <td className="p-1.5 font-bold text-slate-800 text-right">IGST ({rawGstRate}%):</td>
                            <td className="p-1.5 font-mono font-semibold text-right">₹{formatNumber(igstAmount)}</td>
                          </tr>
                        ) : (
                          <>
                            <tr className="border-b border-slate-300">
                              <td className="p-1.5 font-bold text-slate-800 text-right">CGST ({rawGstRate / 2}%):</td>
                              <td className="p-1.5 font-mono font-semibold text-right">₹{formatNumber(cgstAmount)}</td>
                            </tr>
                            <tr className="border-b border-slate-300">
                              <td className="p-1.5 font-bold text-slate-800 text-right">SGST ({rawGstRate / 2}%):</td>
                              <td className="p-1.5 font-mono font-semibold text-right">₹{formatNumber(sgstAmount)}</td>
                            </tr>
                          </>
                        )}
                        <tr className={cn("border-t-2 border-black font-black transition-colors", currentTheme.totalBg, currentTheme.totalText)}>
                          <td className="p-1.5 font-black text-right uppercase tracking-wide text-xs sm:text-sm">TOTAL AMOUNT:</td>
                          <td className="p-1.5 font-mono font-black text-right text-sm sm:text-base">₹{formatNumber(grandTotal)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Signatures & Stamp Row */}
                <div className="grid grid-cols-2 gap-4 mt-2 pt-2 border-t border-slate-300">
                  <div className="text-left text-xs">
                    <span className="font-bold text-slate-800">For {buyerOrg !== 'N/A' ? buyerOrg : 'Buyer'}:</span>
                    <div className="h-14 max-h-14 flex items-center gap-2 mt-0.5 relative overflow-hidden">
                      {resolvedBuyerStamp && (
                        <img
                          src={resolvedBuyerStamp}
                          alt="Buyer Stamp"
                          style={{ maxHeight: '48px', maxWidth: '48px', objectFit: 'contain' }}
                          className="h-11 w-11 object-contain mix-blend-multiply shrink-0"
                        />
                      )}
                      {resolvedBuyerSignature && (
                        <img
                          src={resolvedBuyerSignature}
                          alt="Buyer Signature"
                          style={{ maxHeight: '38px', maxWidth: '130px', objectFit: 'contain' }}
                          className="h-9 w-auto max-w-[130px] object-contain mix-blend-multiply shrink"
                        />
                      )}
                    </div>
                    <span className="text-[10px] text-slate-500 font-semibold block">Authorized Signatory (Buyer)</span>
                  </div>

                  <div className="text-right text-xs">
                    <span className="font-bold text-slate-800">For {sellerOrg !== 'N/A' ? sellerOrg : 'Supplier'}:</span>
                    <div className="h-14 max-h-14 flex items-center justify-end gap-2 mt-0.5 relative overflow-hidden">
                      {resolvedSellerStamp && (
                        <img
                          src={resolvedSellerStamp}
                          alt="Supplier Stamp"
                          style={{ maxHeight: '48px', maxWidth: '48px', objectFit: 'contain' }}
                          className="h-11 w-11 object-contain mix-blend-multiply shrink-0"
                        />
                      )}
                      {resolvedSellerSignature && (
                        <img
                          src={resolvedSellerSignature}
                          alt="Supplier Signature"
                          style={{ maxHeight: '38px', maxWidth: '130px', objectFit: 'contain' }}
                          className="h-9 w-auto max-w-[130px] object-contain mix-blend-multiply shrink"
                        />
                      )}
                    </div>
                    <span className="text-[10px] text-slate-500 font-semibold block">Authorized Signatory (Supplier)</span>
                  </div>
                </div>
              </div>
            </div>
            )}
          </div>
        ) : activeTab === 'audit' ? (
          /* Audit & Workflow Tracking View */
          <div className="min-h-full w-full py-5 sm:py-7 px-3 sm:px-6 lg:px-8 flex justify-center">
            <div className={cn("w-full space-y-5 transition-all duration-200", isFullscreen ? "max-w-6xl 2xl:max-w-7xl" : "max-w-5xl")}>
              {/* Order Title & Overview Card */}
              <div className="rounded-2xl bg-white p-5 sm:p-6 border border-slate-200/90 shadow-sm space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                        Purchase Order
                      </span>
                      <span className="font-mono text-xs font-bold text-slate-700 bg-slate-100 px-2.5 py-0.5 rounded-md border border-slate-200">
                        {order.poNumber || `PO-${order.id}`}
                      </span>
                    </div>
                    <h3 className="text-base sm:text-xl font-black text-slate-900 leading-snug break-words">
                      {order.title || 'Official Procurement Order'}
                    </h3>
                  </div>
                  <div className="text-left sm:text-right shrink-0 bg-slate-50 sm:bg-transparent p-3 sm:p-0 rounded-xl border sm:border-0 border-slate-100">
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block">
                      Total PO Amount
                    </span>
                    <span className="text-lg sm:text-2xl font-black text-[#12335f] font-mono">
                      {formatCurrency(grandTotal)}
                    </span>
                    <span className="text-[10px] font-semibold text-slate-400 block">
                      Base: ₹{formatNumber(subtotal)} | 18% GST: ₹{formatNumber(taxAmount)}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                  <span className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-black uppercase tracking-wide text-emerald-800 shadow-2xs">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    Status: {readableStatus(order.status)}
                  </span>

                  {order.paymentTerms && (
                    <span className="inline-flex items-center gap-1.5 rounded-xl border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-black uppercase tracking-wide text-teal-800 shadow-2xs">
                      <CreditCard className="h-3.5 w-3.5 text-teal-600" />
                      Payment: {readableStatus(order.paymentTerms)}
                    </span>
                  )}

                  {order.deliveryType && (
                    <span className="inline-flex items-center gap-1.5 rounded-xl border border-purple-200 bg-purple-50 px-3 py-1 text-xs font-black uppercase tracking-wide text-purple-800 shadow-2xs">
                      <Truck className="h-3.5 w-3.5 text-purple-600" />
                      Delivery: {readableStatus(order.deliveryType)}
                    </span>
                  )}
                </div>

                {/* 4 Summary Stat Tiles */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                  <div className="rounded-xl bg-slate-50 p-3 border border-slate-100">
                    <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 block mb-0.5">PO Date</span>
                    <p className="text-xs font-bold text-slate-800">{formatDate(order.createdAt)}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3 border border-slate-100">
                    <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 block mb-0.5">Expected Delivery</span>
                    <p className="text-xs font-bold text-slate-800">{formatDate(order.expectedDelivery)}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3 border border-slate-100">
                    <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 block mb-0.5">Buyer Organization</span>
                    <p className="text-xs font-bold text-slate-800 truncate" title={order.buyer?.name || buyerOrg}>{order.buyer?.name || buyerOrg}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3 border border-slate-100">
                    <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 block mb-0.5">Supplier Organization</span>
                    <p className="text-xs font-bold text-slate-800 truncate" title={order.seller?.name || sellerOrg}>{order.seller?.name || sellerOrg}</p>
                  </div>
                </div>
              </div>

              {/* Purchased Products / Line Items Table Card */}
              <div className="rounded-2xl bg-white border border-slate-200/90 shadow-sm overflow-hidden">
                <div className="p-4 sm:p-5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-50 text-[#12335f]">
                      <Package className="h-4 w-4" />
                    </div>
                    <div>
                      <h4 className="text-xs sm:text-sm font-black uppercase tracking-wider text-slate-900">
                        Purchased Items & Line Specifications
                      </h4>
                      <p className="text-[11px] font-semibold text-slate-400">
                        {displayItems.length} line item{displayItems.length === 1 ? '' : 's'} in order
                      </p>
                    </div>
                  </div>
                  <span className="text-xs font-bold text-slate-600 bg-slate-100 px-3 py-1 rounded-lg">
                    Total: <span className="font-mono text-slate-900 font-black">₹{formatNumber(grandTotal)}</span>
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-50/80 text-[10px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">
                        <th className="py-3 px-4 w-12 text-center">#</th>
                        <th className="py-3 px-4">Item & Description</th>
                        <th className="py-3 px-4 text-center w-24">Qty</th>
                        <th className="py-3 px-4 text-right w-32">Unit Price</th>
                        <th className="py-3 px-4 text-right w-36">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {displayItems.map((item, idx) => (
                        <tr key={idx} className="hover:bg-slate-50/50 transition-colors">
                          <td className="py-3 px-4 text-center font-mono font-bold text-slate-400">
                            {idx + 1}
                          </td>
                          <td className="py-3 px-4">
                            <div className="font-bold text-slate-900">{item.name}</div>
                            {item.specs && (
                              <div className="text-[11px] font-medium text-slate-500 mt-0.5">
                                {item.specs}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 text-center font-mono font-bold text-slate-800">
                            {item.quantity}
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-slate-700">
                            ₹{formatNumber(item.unitPrice)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-bold text-slate-900">
                            ₹{formatNumber(item.total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t-2 border-slate-200 bg-slate-50/90 text-xs font-bold text-slate-700">
                      <tr>
                        <td colSpan={3} className="py-2.5 px-4 text-right text-slate-500 uppercase tracking-wider text-[10px] font-black">
                          Subtotal
                        </td>
                        <td colSpan={2} className="py-2.5 px-4 text-right font-mono font-bold text-slate-900">
                          ₹{formatNumber(subtotal)}
                        </td>
                      </tr>
                      <tr>
                        <td colSpan={3} className="py-2.5 px-4 text-right text-slate-500 uppercase tracking-wider text-[10px] font-black">
                          Taxes / GST (18% Included)
                        </td>
                        <td colSpan={2} className="py-2.5 px-4 text-right font-mono font-bold text-slate-900">
                          ₹{formatNumber(taxAmount)}
                        </td>
                      </tr>
                      <tr className="border-t border-slate-200 bg-[#12335f]/5 text-slate-950 font-black">
                        <td colSpan={3} className="py-3 px-4 text-right text-[#12335f] uppercase tracking-wider text-xs font-black">
                          Grand Total Amount
                        </td>
                        <td colSpan={2} className="py-3 px-4 text-right font-mono text-sm sm:text-base font-black text-[#12335f]">
                          ₹{formatNumber(grandTotal)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              {/* Fulfillment Parties & Settings Grid */}
              <div className="grid gap-4 md:grid-cols-2">
                {/* Fulfillment Parties Card */}
                <div className="rounded-2xl bg-white p-5 border border-slate-200/80 shadow-sm space-y-4">
                  <div className="flex items-center gap-2 border-b border-slate-100 pb-2.5">
                    <User className="h-4 w-4 text-[#12335f]" />
                    <h4 className="text-xs font-black uppercase tracking-wider text-[#12335f]">
                      Fulfillment Parties
                    </h4>
                  </div>

                  <div className="space-y-3.5">
                    {/* Buyer Info */}
                    <div className="flex items-start gap-3 rounded-xl bg-slate-50 p-3.5 border border-slate-100">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-700 font-bold text-xs">
                        BY
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 block">
                          Buyer (Requester)
                        </span>
                        <p className="text-xs font-black text-slate-900">
                          {order.buyer?.name || buyerOrg}
                        </p>
                        {order.buyer?.email && (
                          <p className="text-[10px] font-semibold text-slate-500 font-mono">
                            {order.buyer.email}
                          </p>
                        )}
                        {order.deliveryAddress && (
                          <p className="text-[10px] text-slate-600 mt-1 break-words leading-relaxed">
                            {order.deliveryAddress}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Seller Info */}
                    <div className="flex items-start gap-3 rounded-xl bg-slate-50 p-3.5 border border-slate-100">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 font-bold text-xs">
                        SL
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 block">
                           Seller (Provider)
                        </span>
                        <p className="text-xs font-black text-slate-900">
                          {order.seller?.name || sellerOrg}
                        </p>
                        {order.seller?.email && (
                          <p className="text-[10px] font-semibold text-slate-500 font-mono">
                            {order.seller.email}
                          </p>
                        )}
                        {sellerAddress && (
                          <p className="text-[10px] text-slate-600 mt-1 break-words leading-relaxed">
                            {sellerAddress}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Fulfillment Settings Card */}
                <div className="rounded-2xl bg-white p-5 border border-slate-200/80 shadow-sm space-y-4">
                  <div className="flex items-center gap-2 border-b border-slate-100 pb-2.5">
                    <Calendar className="h-4 w-4 text-[#12335f]" />
                    <h4 className="text-xs font-black uppercase tracking-wider text-[#12335f]">
                      Fulfillment & Schedule
                    </h4>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-start gap-2.5 rounded-xl bg-indigo-50/50 p-3 border border-indigo-100">
                      <Clock className="h-4 w-4 text-indigo-600 shrink-0 mt-0.5" />
                      <div>
                        <span className="text-[9px] font-black uppercase tracking-wider text-indigo-700 block">
                          Expected Delivery Date
                        </span>
                        <p className="text-xs font-black text-slate-900">{formatDate(order.expectedDelivery)}</p>
                      </div>
                    </div>

                    {order.deliveryAddress && (
                      <div className="flex items-start gap-2.5 rounded-xl bg-slate-50 p-3 border border-slate-100">
                        <MapPin className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 block">
                            Delivery Address
                          </span>
                          <p className="text-xs font-semibold text-slate-800 leading-relaxed break-words whitespace-normal">
                            {order.deliveryAddress}
                          </p>
                        </div>
                      </div>
                    )}

                    {order.deliveryTrackings && order.deliveryTrackings.length > 0 && (
                      <div className="pt-1">
                        <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 block mb-1.5">
                          Delivery Trackings
                        </span>
                        <div className="flex flex-wrap gap-2">
                          {order.deliveryTrackings.map((dt: any) => (
                            <button
                              key={dt.id}
                              type="button"
                              onClick={() => {
                                onClose();
                                router.push(`/delivery/${dt.id}`);
                              }}
                              className="inline-flex items-center gap-2 rounded-lg bg-slate-100 hover:bg-slate-200 border border-slate-200 px-2.5 py-1 cursor-pointer transition-colors"
                              title="View delivery tracking details"
                            >
                              <span className="font-mono text-xs font-bold text-slate-800">{dt.trackingNumber || `DLV-${dt.id}`}</span>
                              <ExternalLink className="h-3 w-3 text-slate-400" />
                              <span className="text-[10px] font-bold text-slate-600 uppercase">({readableStatus(dt.status || 'pending')})</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Shipment Tracking Highlight Card */}
              {activeDelivery && (
                <div className="rounded-2xl border border-blue-200 bg-gradient-to-r from-blue-50/80 via-indigo-50/40 to-slate-50 p-5 space-y-3.5 shadow-sm">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#12335f] text-white shadow-sm">
                        <Truck className="h-4 w-4" />
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-[#12335f] uppercase tracking-wider">
                          Shipment Tracking Active
                        </h4>
                        <p className="text-[10px] font-semibold text-slate-500">Live dispatch and tracking status</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="rounded-full bg-[#12335f] text-white px-3 py-1 text-[10px] font-black uppercase tracking-wider shadow-2xs">
                        {readableStatus(activeDelivery.status || 'pending')}
                      </span>
                      {activeDelivery.id && (
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => {
                            onClose();
                            router.push(`/delivery/${activeDelivery.id}`);
                          }}
                          className="h-7 text-[11px] font-bold bg-[#12335f] text-white hover:bg-[#0e2a4f] shadow-2xs rounded-lg px-2.5 gap-1.5 cursor-pointer"
                          title="Open live delivery tracking & details"
                        >
                          <span>Live Tracking</span>
                          <ExternalLink className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-white/90 rounded-xl p-3.5 border border-blue-100/80 text-xs">
                    {activeDelivery.carrierName && (
                      <div>
                        <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 block">Carrier Partner</span>
                        <p className="font-black text-slate-800 truncate">{activeDelivery.carrierName}</p>
                      </div>
                    )}
                    {activeDelivery.trackingNumber && (
                      <div>
                        <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 block">Tracking Number</span>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="font-mono font-bold text-slate-900 truncate">{activeDelivery.trackingNumber}</span>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(activeDelivery.trackingNumber);
                              toast.success('Tracking number copied');
                            }}
                            className="text-slate-400 hover:text-slate-700 p-0.5 cursor-pointer"
                            title="Copy Tracking Number"
                            aria-label="Copy Tracking Number"
                          >
                            <Copy className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    )}
                    {activeDelivery.expectedDelivery && (
                      <div>
                        <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 block">Expected Arrival</span>
                        <p className="font-bold text-slate-800">{formatDate(activeDelivery.expectedDelivery)}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Workflow Timeline Section */}
              <div className="rounded-2xl bg-white p-5 border border-slate-200/80 shadow-sm space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-[#12335f]" />
                    <h4 className="text-xs font-black uppercase tracking-wider text-[#12335f]">
                      Workflow Tracking & Timestamps
                    </h4>
                  </div>
                  <span className="text-[10px] font-semibold text-slate-400">Order Lifecycle Audit</span>
                </div>

                <div className="relative border-l-2 border-slate-200 pl-6 ml-3 space-y-5 py-1">
                  <div className="relative">
                    <span className="absolute -left-[31px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 ring-4 ring-emerald-50 text-white shadow-2xs">
                      <CheckCircle2 className="h-3 w-3" />
                    </span>
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                      <span className="text-xs font-extrabold text-slate-900">Purchase Order Generated</span>
                      <span className="text-[10px] font-mono font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md">
                        {formatDate(order.createdAt)}
                      </span>
                    </div>
                    <p className="text-[11px] font-semibold text-slate-500 mt-1">
                      PO record created from procurement bidding workflow.
                    </p>
                  </div>

                  {viewingStatusLower !== 'generated' && viewingStatusLower !== 'order_placed' && viewingStatusLower !== 'cancelled' && (
                    <div className="relative">
                      <span className="absolute -left-[31px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 ring-4 ring-emerald-50 text-white shadow-2xs">
                        <CheckCircle2 className="h-3 w-3" />
                      </span>
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                        <span className="text-xs font-extrabold text-slate-900">PO Acknowledged by Seller</span>
                        <span className="text-[10px] font-mono font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md">
                          {order.acceptedAt ? formatDate(order.acceptedAt) : 'Acknowledged'}
                        </span>
                      </div>
                      <p className="text-[11px] font-semibold text-slate-500 mt-1">
                        Seller acknowledged and committed to fulfillment.
                      </p>
                    </div>
                  )}

                  {order.status === 'delivered' && (
                    <div className="relative">
                      <span className="absolute -left-[31px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 ring-4 ring-emerald-50 text-white shadow-2xs">
                        <CheckCircle2 className="h-3 w-3" />
                      </span>
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                        <span className="text-xs font-extrabold text-slate-900">Delivered & Completed</span>
                        <span className="text-[10px] font-mono font-bold text-slate-500 bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-md">
                          Completed
                        </span>
                      </div>
                      <p className="text-[11px] font-semibold text-slate-500 mt-1">
                        Consignment has been safely delivered and confirmed.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="min-h-full w-full p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
            <PbgManagementCard
              purchaseOrderId={Number(order.id)}
              poAmount={Number(order.totalValue || order.amount || 0)}
              isBuyer={Boolean(isBuyer)}
              isSeller={Boolean(isSeller)}
              isAdmin={Boolean(user?.role === 'admin' || user?.role === 'master_admin')}
              onRefresh={reloadDetails}
            />
          </div>
        )}
        </div>

        {/* Bottom Action Footer (Hidden in Print) - Single Row */}
        <footer className="no-print border-t border-slate-200 bg-white px-4 sm:px-6 py-2.5 shrink-0 flex items-center justify-between gap-2 overflow-x-auto no-scrollbar shadow-md">
          <div className="flex items-center gap-2 shrink-0">
            {isSeller && isIssued && onAccept && onReject && (
              <>
                <Button
                  onClick={() => onAccept(order)}
                  className="h-9 bg-emerald-600 text-xs font-black uppercase tracking-wider text-white hover:bg-emerald-700 shadow-sm rounded-xl px-3.5 whitespace-nowrap"
                >
                  <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Accept PO
                </Button>
                <Button
                  variant="outline"
                  onClick={() => onReject(order)}
                  className="h-9 border-rose-200 text-xs font-black uppercase tracking-wider text-rose-600 hover:bg-rose-50 rounded-xl px-3.5 whitespace-nowrap"
                >
                  <XCircle className="mr-1.5 h-3.5 w-3.5" /> Reject PO
                </Button>
              </>
            )}

            {(order as any)?.bidId && (
              <Button
                variant="outline"
                onClick={() => {
                  onClose();
                  router.push(`/bids/${(order as any).bidId}`);
                }}
                className="h-9 border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-bold uppercase tracking-wider rounded-xl px-3.5 whitespace-nowrap cursor-pointer"
              >
                <FileText className="mr-1.5 h-3.5 w-3.5 text-slate-500" /> View Quotation
              </Button>
            )}

            <Button
              variant="outline"
              onClick={() => setIsNegotiationModalOpen(true)}
              className="h-9 border-blue-300 bg-blue-50/90 text-blue-900 hover:bg-blue-100 text-xs font-black uppercase tracking-wider rounded-xl px-3.5 whitespace-nowrap cursor-pointer shadow-xs"
            >
              <Scale className="mr-1.5 h-3.5 w-3.5 text-blue-700" /> CVC L1 Negotiation
            </Button>

            {Boolean((order as any)?.externalPdfFileId || (order as any)?.pdfFileId) && (
              <Button
                variant="outline"
                onClick={() => {
                  const fileId = (order as any)?.externalPdfFileId || (order as any)?.pdfFileId;
                  openFileAsset({
                    id: fileId,
                    fileAssetId: fileId,
                    originalName: (order as any)?.externalPdfFile?.originalName || (order as any)?.pdfFile?.originalName || `Purchase_Order_${order.poNumber || order.id}.pdf`
                  }, 'Purchase Order PDF').catch(err => {
                    toast.error(err instanceof Error ? err.message : 'Unable to open PO PDF');
                  });
                }}
                className="h-9 border-indigo-200 bg-indigo-50/70 hover:bg-indigo-100 text-indigo-800 text-xs font-bold uppercase tracking-wider rounded-xl px-3.5 whitespace-nowrap cursor-pointer shadow-xs flex items-center gap-1.5"
                title="View authentic uploaded Purchase Order PDF"
              >
                <Eye className="h-3.5 w-3.5 text-indigo-600" />
                <span>View Uploaded PO</span>
              </Button>
            )}

            {(() => {
              const hasInvoice = Boolean(
                (order as any)?.invoices?.length > 0 ||
                (order as any)?.invoiceId ||
                (order as any)?.invoiceNumber ||
                (order as any)?.invoice ||
                ['invoiced', 'invoice_submitted', 'payment_initiated', 'completed', 'paid'].includes(viewingStatusLower)
              );
              if (isSeller && isAccepted && !hasInvoice) {
                return (
                  <Button
                    onClick={handleCreateInvoiceAction}
                    className="h-9 bg-emerald-600 text-xs font-black uppercase tracking-wider text-white hover:bg-emerald-700 shadow-sm rounded-xl px-3.5 whitespace-nowrap cursor-pointer"
                  >
                    <FileText className="mr-1.5 h-3.5 w-3.5" /> Convert PO to Invoice
                  </Button>
                );
              }
              return null;
            })()}

            {isSeller && (isAccepted || viewingStatusLower === 'delivered') && (
              <Button
                onClick={handleManageDispatchAction}
                className="h-9 bg-[#12335f] text-xs font-black uppercase tracking-wider text-white hover:bg-[#0b2445] shadow-sm rounded-xl px-3.5 whitespace-nowrap cursor-pointer"
              >
                <Truck className="mr-1.5 h-3.5 w-3.5" /> Delivery / Manage Dispatch
              </Button>
            )}

            {(() => {
              const activeInvoice = (order as any)?.invoices?.find(
                (inv: any) =>
                  String(inv.status || inv.invoiceStatus || '').toLowerCase() !== 'cancelled' &&
                  String(inv.status || inv.invoiceStatus || '').toLowerCase() !== 'rejected'
              ) || (order as any)?.invoices?.[0];

              const hasGrn = Boolean((order as any)?.grns?.length > 0 || ['grn_completed', 'inspection_accepted', 'delivered', 'completed', 'paid'].includes(viewingStatusLower));

              const hasSlip = Boolean(
                activeInvoice?.paymentSlipFileId ||
                activeInvoice?.paymentSlipFile ||
                (activeInvoice as any)?.offlineProof ||
                (activeInvoice as any)?.paymentReceiptFileAssetId ||
                (order as any)?.paymentSlipFileId ||
                (order as any)?.paymentSlip ||
                (order as any)?.offlineProof ||
                (order as any)?.paymentProof ||
                viewingStatusLower.includes('paid') ||
                viewingStatusLower === 'payment_submitted' ||
                String((order as any)?.paymentStatus || '').toLowerCase() === 'under_verification' ||
                String((order as any)?.paymentStatus || '').toLowerCase() === 'payment_submitted' ||
                String((order as any)?.paymentStatus || '').toLowerCase() === 'paid'
              );

              const isPaid = viewingStatusLower.includes('paid') || hasSlip;
              const payRoute = isBuyer ? '/buyer/payments' : '/seller/payments';

              if (viewingStatusLower === 'cancelled') return null;

              if (isPaid) {
                const proofId = activeInvoice?.paymentSlipFileId || (order as any)?.paymentSlipFileId || (order as any)?.paymentSlipFile;
                return (
                  <Button
                    onClick={() => {
                      if (onViewPaymentSlip) {
                        onViewPaymentSlip(order);
                      } else {
                        onClose();
                        router.push(`${payRoute}?search=${encodeURIComponent(order?.poNumber || order?.id || '')}`);
                      }
                    }}
                    onMouseEnter={() => {
                      if (proofId) prewarmFileAssetPreview(proofId, 'Payment_Proof');
                    }}
                    onFocus={() => {
                      if (proofId) prewarmFileAssetPreview(proofId, 'Payment_Proof');
                    }}
                    className="h-9 bg-emerald-700 text-xs font-black uppercase tracking-wider text-white hover:bg-emerald-800 shadow-sm rounded-xl px-3.5 whitespace-nowrap cursor-pointer"
                  >
                    <ShieldCheck className="mr-1.5 h-3.5 w-3.5 text-white" /> View Payment Proof {viewingStatusLower.includes('paid') ? '(Paid)' : ''}
                  </Button>
                );
              }

              if (hasGrn && !isPaid) {
                if (!isBuyer) {
                  return (
                    <span className="inline-flex items-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs font-bold text-amber-800">
                      <Clock className="h-3.5 w-3.5 text-amber-600" />
                      <span>Payment Pending from Buyer</span>
                    </span>
                  );
                }
                return null;
              }

              return null;
            })()}

            {isBuyer && !['cancelled', 'delivered'].includes(viewingStatusLower) && onCancel && (
              <Button
                onClick={() => onCancel(order)}
                className="h-9 border-rose-200 text-xs font-black uppercase tracking-wider text-rose-600 hover:bg-rose-50 rounded-xl px-3.5 whitespace-nowrap"
              >
                <XCircle className="mr-1.5 h-3.5 w-3.5" /> Cancel PO
              </Button>
            )}

            {isBuyer && viewingStatusLower === 'delivered' && onRepeatOrder && (
              <Button
                onClick={() => onRepeatOrder(order)}
                className="h-9 bg-[#12335f] text-xs font-black uppercase tracking-wider text-white hover:bg-[#0b2445] shadow-sm rounded-xl px-3.5 whitespace-nowrap"
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Repeat Order
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              type="button"
              variant="outline"
              disabled={isGeneratingPdf}
              onClick={handleDirectDownloadPdf}
              className="h-9 text-xs font-black uppercase tracking-wider rounded-xl border-slate-300 hover:bg-slate-50 px-3.5 whitespace-nowrap cursor-pointer"
              title="Download PDF directly"
              aria-label="Download PDF directly"
            >
              <Download className="mr-1.5 h-3.5 w-3.5 text-slate-600" aria-hidden="true" /> Download PDF
            </Button>
            <Button
              type="button"
              onClick={onClose}
              className="h-9 bg-slate-900 text-xs font-black uppercase tracking-wider text-white hover:bg-slate-800 rounded-xl px-4 shadow-sm whitespace-nowrap cursor-pointer"
            >
              Close
            </Button>
          </div>
        </footer>
      </div>
      </FocusTrap>

      {isNegotiationModalOpen && (
        <L1NegotiationModal
          isOpen={isNegotiationModalOpen}
          onClose={() => setIsNegotiationModalOpen(false)}
          purchaseOrderId={Number(order.id)}
          poNumber={order.poNumber || `PO-${order.id}`}
          originalPrice={Number(order.totalValue || order.amount || 0)}
          sellerUserId={(order as any).seller?.userId || (order as any).sellerUserId}
          sellerName={(order as any).seller?.name || (order as any).vendorName}
          isBuyer={Boolean(isBuyer)}
          isSeller={Boolean(isSeller)}
          onSuccess={reloadDetails}
        />
      )}
    </div>
  );
}
