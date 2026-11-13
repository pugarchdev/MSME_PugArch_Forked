import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, AlertCircle, CheckCircle2, Download, FileText, RefreshCw, Search, ShieldCheck, Truck, XCircle, ArrowUp, ArrowDown, ArrowUpDown, Eye, X, Filter, List, LayoutGrid, MoreVertical, Building2, Calendar, MapPin, User, Copy, Package, CreditCard, Clock, Upload, Receipt, Lock, ClipboardCheck, Undo2, ExternalLink } from 'lucide-react';
import type { DocumentConfig } from '../lib/pdfEngine';
import { PaymentReceiptUploadModal } from '../features/payments/components/PaymentReceiptUploadModal';
import { PaymentReceiptViewModal } from '../features/payments/components/PaymentReceiptViewModal';
import { RepeatPurchaseOrderModal } from '../features/purchaseOrders/components/RepeatPurchaseOrderModal';
import { PurchaseOrderReceiptModal } from '../features/purchaseOrders/components/PurchaseOrderReceiptModal';
import { RecordOrderPaymentModal } from '../features/purchaseOrders/components/RecordOrderPaymentModal';
import { ConfirmOrderSettlementModal } from '../features/purchaseOrders/components/ConfirmOrderSettlementModal';
import { GrnCreateModal } from '../features/grn/components/GrnCreateModal';
import { TaxInvoiceRegistryModal } from '../features/invoices/components/TaxInvoiceRegistryModal';
import { EditPurchaseOrderModal } from '../features/purchaseOrders/components/EditPurchaseOrderModal';
import { ImportExternalOrderModal } from '../features/purchaseOrders/components/ImportExternalOrderModal';
import { downloadSapMiroExport } from '../features/purchaseOrders/lib/sapExport';

export const hasApprovedGrn = (order: any): boolean => {
  if (!order) return false;
  const status = String(order.status || '').toLowerCase();
  if (['grn_approved', 'grn_completed', 'inspection_accepted'].includes(status)) return true;
  if (Array.isArray(order.grns) && order.grns.length > 0) {
    return order.grns.some((g: any) => {
      const gs = String(g.status || '').toUpperCase();
      return ['APPROVED', 'PARTIAL', 'VERIFIED', 'COMPLETED'].includes(gs);
    });
  }
  return false;
};

export const getExistingGrn = (order: any): any | null => {
  if (!order) return null;
  if (Array.isArray(order.grns) && order.grns.length > 0) {
    return order.grns[0];
  }
  if (order.grn && typeof order.grn === 'object') {
    return order.grn;
  }
  return null;
};

export const hasAnyGrn = (order: any): boolean => {
  if (!order) return false;
  if (Array.isArray(order.grns) && order.grns.length > 0) return true;
  if (order.grnId || (order.grn && order.grn.id)) return true;
  const status = String(order.status || '').toLowerCase();
  if (['grn_approved', 'grn_completed', 'inspection_accepted'].includes(status)) return true;
  return false;
};

const moneyPdf = (val: any, currency = 'INR') => {
  const num = Number(val || 0);
  if (!Number.isFinite(num) || num === 0) return `${currency} 0.00`;
  return `${currency} ${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
import { Button } from '../components/ui/button';
import { DateTimePicker } from '../components/ui/DateTimePicker';
import { Card, CardContent } from '../components/ui/card';
import { api, readJsonResponse, resolveMediaUrl } from '../lib/api';
import { openFileAsset, prewarmFileAssetPreview } from '../lib/files';
import { cn } from '../lib/utils';
import { EmptyState, InlineError, LoadingState } from '../features/shared/FeatureStates';
import { formatCurrency, formatDate, formatDateTime, formatTime } from '../features/shared/format';
import { isAdvancePaymentTerms, isDeliveryDeliveredOrApproved } from '../features/shared/procurementLifecycleUtils';
import { useFeatureQuery, usePagination, useResponsiveViewMode } from '../features/shared/hooks';
import { KpiCard } from '../features/shared/KpiCard';
import { Pagination } from '../features/shared/Pagination';
import { EntityIdLink } from '../features/shared/EntityIdLink';
import { postApi } from '../features/shared/apiClient';
import { ViewModeToggle } from '../features/shared/ViewModeToggle';
import { ResponsiveFilterBar } from '../components/ui/ResponsiveFilterBar';
import { PageToolbar } from '../features/shared/PageToolbar';
import { useAuth } from '../hooks/useAuth';
import type { PurchaseOrderDto } from '../features/shared/types';
import { useDeliveryByPO } from '../features/delivery/hooks';
import { getDeliveryByPurchaseOrder } from '../features/delivery/api';
import { PageTableSkeleton, TableSkeleton, GridCardSkeleton } from '../components/ui/skeleton';
import { DataTable, type ColumnDef } from '../components/ui/data-table';
import { FocusTrap } from '../components/ui/FocusTrap';

const readableStatus = (value?: string) => String(value || 'generated').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
const openStatuses = ['generated', 'accepted', 'in_fulfillment', 'invoice_submitted', 'order_placed', 'issued', 'pending_approval', 'pending_acceptance'];
const purchaseOrderStatusParam = (tab: 'Open' | 'Delivered' | 'Cancelled' | 'All') => {
  if (tab === 'Delivered') return 'delivered';
  if (tab === 'Cancelled') return 'cancelled';
  return undefined;
};
const isOpenPurchaseOrder = (order: PurchaseOrderDto) => openStatuses.includes(String(order.status || 'generated').toLowerCase());

interface SortHeaderProps {
  label: string;
  columnKey: string;
  className?: string;
  sortBy: string;
  onToggleSort: (key: string) => void;
}

const SortHeader = ({ label, columnKey, className = '', sortBy, onToggleSort }: SortHeaderProps) => {
  let isActive = false;
  let isAsc = true;

  if (columnKey === 'po') {
    isActive = sortBy === 'po_asc' || sortBy === 'po_desc';
    isAsc = sortBy === 'po_asc';
  } else if (columnKey === 'title') {
    isActive = sortBy === 'title_asc' || sortBy === 'title_desc';
    isAsc = sortBy === 'title_asc';
  } else if (columnKey === 'party') {
    isActive = sortBy === 'party_asc' || sortBy === 'party_desc';
    isAsc = sortBy === 'party_asc';
  } else if (columnKey === 'value') {
    isActive = sortBy === 'value_low' || sortBy === 'value_high';
    isAsc = sortBy === 'value_low';
  } else if (columnKey === 'expected') {
    isActive = sortBy === 'expected_asc' || sortBy === 'expected_desc';
    isAsc = sortBy === 'expected_asc';
  } else if (columnKey === 'status') {
    isActive = sortBy === 'status' || sortBy === 'status_asc' || sortBy === 'status_desc';
    isAsc = sortBy === 'status' || sortBy === 'status_asc';
  } else if (columnKey === 'updated') {
    isActive = sortBy === 'updated_asc' || sortBy === 'updated_desc';
    isAsc = sortBy === 'updated_asc';
  }

  return (
    <button
      type="button"
      onClick={() => onToggleSort(columnKey)}
      className={cn("inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-slate-500 hover:text-[#12335f] transition-colors", isActive && "text-[#12335f]", className)}
    >
      {label}
      {isActive ? (
        isAsc ? (
          <ArrowUp className="h-3 w-3 text-[#12335f]" />
        ) : (
          <ArrowDown className="h-3 w-3 text-[#12335f]" />
        )
      ) : (
        <ArrowUpDown className="h-3 w-3 opacity-40" />
      )}
    </button>
  );
};
import { createPortal } from 'react-dom';

const OrderActionDropdown = ({
  order,
  isOpen,
  onToggle,
  onClose,
  isSeller,
  isBuyer,
  isIssued,
  isAccepted,
  isDelivered,
  isCancelled,
  setViewingOrder,
  handleAcceptOrder,
  handleRejectOrder,
  handleOpenDelivery,
  exportInvoicePdf,
  setConfirming,
  onUploadPaymentSlip,
  onViewPaymentSlip,
  onViewReceipt,
  onRecordPayment,
  onConfirmSettlement,
  onOpenGrnModal,
  onViewGrn,
  onViewInvoice,
  onEditPoDraft,
  onIssuePo,
  onRecallPo,
  onAmendPo,
  onAcceptAmendment,
  onDeclineAmendment,
}: any) => {
  const router = useRouter();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top?: number; bottom?: number; left: number } | null>(null);

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    if ((rect.width === 0 && rect.height === 0) || buttonRef.current.offsetParent === null) {
      setCoords(null);
      return;
    }

    const menuWidth = 176; // w-44 = 11rem = 176px
    const menuEstimatedHeight = 260;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const shouldOpenUp = spaceBelow < menuEstimatedHeight + 8 && spaceAbove > spaceBelow;

    let left = rect.right - menuWidth;
    if (left < 6) left = 6;
    if (left + menuWidth > window.innerWidth - 6) left = window.innerWidth - menuWidth - 6;

    setCoords({
      top: shouldOpenUp ? undefined : Math.round(rect.bottom + 4),
      bottom: shouldOpenUp ? Math.round(window.innerHeight - rect.top + 4) : undefined,
      left: Math.round(left),
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    updatePosition();

    const handleScroll = (e: Event) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      if (buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) {
          onClose();
          return;
        }
      }
      updatePosition();
    };

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current && !menuRef.current.contains(target) &&
        buttonRef.current && !buttonRef.current.contains(target)
      ) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        buttonRef.current?.focus();
      }
    };

    window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    window.addEventListener('resize', updatePosition);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('scroll', handleScroll, { capture: true });
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, updatePosition, onClose]);

  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!menuRef.current) return;
    const items = Array.from(
      menuRef.current.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])')
    );
    if (items.length === 0) return;

    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = (currentIndex + 1) % items.length;
      items[nextIndex]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = (currentIndex - 1 + items.length) % items.length;
      items[prevIndex]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      onClose();
    }
  };

  return (
    <div className="relative inline-flex items-center justify-end" onClick={e => e.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Actions for purchase order ${order.poNumber || order.id}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isOpen) {
            onClose();
          } else {
            updatePosition();
            onToggle();
          }
        }}
        className={cn(
          "h-8 w-8 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors shadow-2xs focus:outline-none focus:ring-2 focus:ring-[#12335f]/20 cursor-pointer",
          isOpen && "bg-slate-100 border-slate-300 text-slate-900"
        )}
        title="Actions"
      >
        <MoreVertical className="h-4 w-4" aria-hidden="true" />
      </button>

      {isOpen && coords && typeof document !== 'undefined' && createPortal(
        <div 
          ref={menuRef}
          style={{
            position: 'fixed',
            top: coords.top !== undefined ? `${coords.top}px` : undefined,
            bottom: coords.bottom !== undefined ? `${coords.bottom}px` : undefined,
            left: `${coords.left}px`,
            zIndex: 99999,
            transformOrigin: coords.bottom !== undefined ? 'bottom right' : 'top right'
          }}
          onClick={e => { e.preventDefault(); e.stopPropagation(); }}
          onKeyDown={handleMenuKeyDown}
          className="w-44 rounded-xl border border-slate-200 bg-white p-1.5 shadow-2xl ring-1 ring-black/5 flex flex-col gap-0.5 text-left animate-in fade-in zoom-in-95 duration-100"
          role="menu"
          aria-label={`Actions for purchase order ${order.poNumber || order.id}`}
        >
      <button
        type="button"
        onClick={() => {
          onClose();
          setViewingOrder(order);
        }}
        className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-slate-700 hover:bg-slate-100 hover:text-slate-950 transition-colors text-left"
      >
        <Eye className="h-3.5 w-3.5 text-slate-500" />
        <span>View</span>
      </button>

      <button
        type="button"
        onClick={() => {
          onClose();
          onViewReceipt?.(order);
        }}
        className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-blue-700 hover:bg-blue-50 transition-colors text-left"
      >
        <Receipt className="h-3.5 w-3.5 text-blue-600" />
        <span>View Official PO</span>
      </button>

      {/* Buyer: Draft Edit & Issue Actions */}
      {isBuyer && (String(order.status || '').toLowerCase() === 'draft' || String(order.status || '').toLowerCase() === 'generated' || order.isDraft) && (
        <>
          <button
            type="button"
            onClick={() => {
              onClose();
              onEditPoDraft?.(order);
            }}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-indigo-700 hover:bg-indigo-50 transition-colors text-left cursor-pointer"
          >
            <FileText className="h-3.5 w-3.5 text-indigo-600" />
            <span>Edit Purchase Order (Draft)</span>
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onIssuePo?.(order);
            }}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-emerald-700 hover:bg-emerald-50 transition-colors text-left cursor-pointer"
          >
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            <span>Issue PO to Seller</span>
          </button>
        </>
      )}

      {/* Buyer: Recall Issued / Pending Acceptance PO to Draft & Edit */}
      {isBuyer && isIssued && !order.isDraft && String(order.status || '').toLowerCase() !== 'draft' && String(order.status || '').toLowerCase() !== 'generated' && (
        <button
          type="button"
          onClick={() => {
            onClose();
            onRecallPo?.(order);
          }}
          className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-amber-700 hover:bg-amber-50 transition-colors text-left cursor-pointer"
          title="Recall this unaccepted purchase order back to draft state to make corrections and re-issue"
        >
          <Undo2 className="h-3.5 w-3.5 text-amber-600" />
          <span>Recall to Draft &amp; Edit</span>
        </button>
      )}

      {/* Buyer: Propose V2 Amendment on Accepted PO */}
      {isBuyer && isAccepted && (
        <button
          type="button"
          onClick={() => {
            onClose();
            onAmendPo?.(order);
          }}
          className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-purple-700 hover:bg-purple-50 transition-colors text-left cursor-pointer"
        >
          <FileText className="h-3.5 w-3.5 text-purple-600" />
          <span>Amend Order (V2)</span>
        </button>
      )}

      {/* Seller: Accept or Decline Proposed Amendment */}
      {isSeller && String(order.status || '').toLowerCase() === 'amendment_pending' && (
        <>
          <button
            type="button"
            onClick={() => {
              onClose();
              onAcceptAmendment?.(order);
            }}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-emerald-700 hover:bg-emerald-50 transition-colors text-left cursor-pointer"
          >
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            <span>Accept Amendment</span>
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onDeclineAmendment?.(order);
            }}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-rose-700 hover:bg-rose-50 transition-colors text-left cursor-pointer"
          >
            <XCircle className="h-3.5 w-3.5 text-rose-600" />
            <span>Decline Amendment</span>
          </button>
        </>
      )}

      {isSeller && isIssued && (
        <>
          <button
            type="button"
            onClick={() => {
              onClose();
              handleAcceptOrder(order);
            }}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-emerald-700 hover:bg-emerald-50 transition-colors text-left"
          >
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            <span>Accept</span>
          </button>

          <button
            type="button"
            onClick={() => {
              onClose();
              handleRejectOrder(order);
            }}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-rose-700 hover:bg-rose-50 transition-colors text-left"
          >
            <XCircle className="h-3.5 w-3.5 text-rose-600" />
            <span>Reject</span>
          </button>
        </>
      )}

      {order.bidId && (
        <button
          type="button"
          onClick={() => {
            onClose();
            router.push(`/bids/${order.bidId}`);
          }}
          className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-indigo-700 hover:bg-indigo-50 transition-colors text-left cursor-pointer"
        >
          <FileText className="h-3.5 w-3.5 text-indigo-600" />
          <span>View Quotation / Tender</span>
        </button>
      )}

      {isSeller && (isAccepted || isDelivered) && (
        <>
          {(() => {
            const hasInvoice = Boolean(
              (order as any).invoices?.length > 0 ||
              (order as any).invoiceId ||
              (order as any).invoiceNumber ||
              (order as any).invoice ||
              ['invoiced', 'invoice_submitted', 'payment_initiated', 'completed', 'paid'].includes(String(order.status || '').toLowerCase())
            );
            if (hasInvoice) {
              const inv = (order as any).invoices?.[0] || (order as any).invoice;
              const invNo = inv?.invoiceNumber || (order as any).invoiceNumber || order.id;
              const invId = inv?.id || (order as any).invoiceId;
              return (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    if (invId && onViewInvoice) {
                      onViewInvoice(Number(invId), inv || null);
                    } else {
                      router.push(`/seller/invoices?viewInvoiceNo=${invNo}`);
                    }
                  }}
                  className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-emerald-700 hover:bg-emerald-50 transition-colors text-left cursor-pointer"
                >
                  <FileText className="h-3.5 w-3.5 text-emerald-600" />
                  <span>View Invoice</span>
                </button>
              );
            }
            return (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  const amountVal = order.amount || order.totalValue || 0;
                  router.push(`/seller/invoices?convertPoId=${order.id}&amount=${amountVal}`);
                }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-emerald-700 hover:bg-emerald-50 transition-colors text-left cursor-pointer"
              >
                <FileText className="h-3.5 w-3.5 text-emerald-600" />
                <span>Create Invoice from PO</span>
              </button>
            );
          })()}
          <button
            type="button"
            onClick={() => {
              onClose();
              handleOpenDelivery(order);
            }}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-blue-700 hover:bg-blue-50 transition-colors text-left cursor-pointer"
          >
            <Truck className="h-3.5 w-3.5 text-blue-600" />
            <span>Delivery Tracking</span>
          </button>
        </>
      )}

      {(() => {
        const anyGrn = hasAnyGrn(order);
        const approvedGrn = hasApprovedGrn(order);
        const isPaid = String(order.status || '').toLowerCase().includes('paid');
        const activeInvoice = (order as any).invoices?.find(
          (inv: any) =>
            String(inv.status || inv.invoiceStatus || '').toLowerCase() !== 'cancelled' &&
            String(inv.status || inv.invoiceStatus || '').toLowerCase() !== 'rejected'
        ) || (order as any).invoices?.[0];

        const hasSlip = Boolean(
          activeInvoice?.paymentSlipFileId ||
          activeInvoice?.paymentSlipFile ||
          (activeInvoice as any)?.offlineProof ||
          (activeInvoice as any)?.paymentReceiptFileAssetId ||
          (order as any).paymentSlipFileId ||
          (order as any).paymentSlip ||
          (order as any).offlineProof ||
          (order as any).paymentProof
        );

        const hasPaymentRecorded = Boolean(
          isPaid ||
          hasSlip ||
          activeInvoice?.paymentReference ||
          String(activeInvoice?.status || '').toLowerCase() === 'payment_submitted' ||
          String(activeInvoice?.status || '').toLowerCase().includes('paid') ||
          String(order.status || '').toLowerCase() === 'payment_submitted' ||
          String((order as any).paymentStatus || '').toLowerCase() === 'paid' ||
          String((order as any).paymentStatus || '').toLowerCase() === 'under_verification' ||
          String((order as any).paymentStatus || '').toLowerCase() === 'payment_submitted' ||
          (order as any).payments?.length > 0
        );

        const isPaymentDone = isPaid || hasPaymentRecorded || hasSlip;
        const isDelivered = isDeliveryDeliveredOrApproved(order);

        const activeInvStatus = String(activeInvoice?.status || activeInvoice?.invoiceStatus || '').toLowerCase();
        const isInvoiceApproved = Boolean(
          activeInvoice && ['approved', 'issued', 'verified', 'accepted', 'paid', 'payment_submitted'].includes(activeInvStatus)
        );
        const isAdvance = isAdvancePaymentTerms(order) || isAdvancePaymentTerms(activeInvoice);
        const canPayNow = (isAdvance || approvedGrn) && isInvoiceApproved;

        const isSettled = Boolean(
          activeInvoice?.settledAt ||
          String(activeInvoice?.status || '').toLowerCase() === 'paid' ||
          (isPaid && !hasSlip)
        );

        return (
          <>
            {/* View GRN: once GRN is created, always allow viewing it */}
            {anyGrn && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onViewGrn?.(order);
                }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-teal-800 hover:bg-teal-50 transition-colors text-left cursor-pointer"
              >
                <ClipboardCheck className="h-3.5 w-3.5 text-teal-600" />
                <span>View GRN</span>
              </button>
            )}

            {/* Generate GRN: ONLY enabled when goods are DELIVERED; disabled otherwise */}
            {!anyGrn && !approvedGrn && !isPaymentDone && isBuyer && !isCancelled && (
              isDelivered ? (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenGrnModal?.(order.id);
                  }}
                  className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-amber-700 hover:bg-amber-50 transition-colors text-left cursor-pointer"
                >
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                  <span>Generate GRN (Pay Gate)</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled
                  className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-semibold rounded-lg text-slate-400 bg-slate-50 text-left cursor-not-allowed opacity-60"
                  title="Generate GRN is disabled until Delivery Status is marked as DELIVERED by the seller"
                >
                  <Lock className="h-3.5 w-3.5 text-slate-400" />
                  <span>Generate GRN (Awaiting Delivery)</span>
                </button>
              )
            )}

            {/* Buyer Payment Actions: STRICTLY gated by Invoice Approval + (Approved GRN or Advance Payment) */}
            {isBuyer && !isCancelled && (
              <>
                {isPaymentDone ? (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onViewPaymentSlip?.(order);
                    }}
                    onMouseEnter={() => {
                      const proofId = activeInvoice?.paymentSlipFileId || (order as any)?.paymentSlipFileId || (order as any)?.paymentSlipFile;
                      if (proofId) prewarmFileAssetPreview(proofId, 'Payment_Proof');
                    }}
                    onFocus={() => {
                      const proofId = activeInvoice?.paymentSlipFileId || (order as any)?.paymentSlipFileId || (order as any)?.paymentSlipFile;
                      if (proofId) prewarmFileAssetPreview(proofId, 'Payment_Proof');
                    }}
                    className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-emerald-800 hover:bg-emerald-50 transition-colors text-left cursor-pointer"
                    title="View uploaded payment proof"
                  >
                    <Receipt className="h-3.5 w-3.5 text-emerald-600" />
                    <span>View Payment Proof</span>
                  </button>
                ) : canPayNow ? (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onRecordPayment?.(order);
                    }}
                    className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-purple-700 hover:bg-purple-50 transition-colors text-left cursor-pointer"
                    title="Pay now online or upload payment proof"
                  >
                    <CreditCard className="h-3.5 w-3.5 text-purple-600" />
                    <span>Pay Now / Upload Payment Proof</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled
                    className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-semibold rounded-lg text-slate-400 bg-slate-50 text-left cursor-not-allowed opacity-60"
                    title={
                      !isInvoiceApproved
                        ? "Payment is disabled until Tax Invoice is issued and approved."
                        : !isAdvance && !approvedGrn
                        ? "Payment is disabled until Goods are Delivered and GRN is Generated."
                        : "Payment is locked."
                    }
                  >
                    <Lock className="h-3.5 w-3.5 text-slate-400" />
                    <span>
                      {!isInvoiceApproved
                        ? "Pay / Upload Proof (Invoice Pending)"
                        : !isAdvance && !approvedGrn
                        ? "Pay / Upload Proof (GRN Required)"
                        : "Pay / Upload Proof (Locked)"}
                    </span>
                  </button>
                )}
              </>
            )}
          </>
        );
      })()}

      <button
        type="button"
        onClick={() => {
          onClose();
          exportInvoicePdf(order, 'download');
        }}
        className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-[#12335f] hover:bg-blue-50 transition-colors text-left"
      >
        <Download className="h-3.5 w-3.5 text-[#12335f]" />
        <span>Download PO</span>
      </button>

      {(() => {
        const inv = (order as any).invoices?.find(
          (i: any) => !['cancelled', 'rejected'].includes(String(i.status || i.invoiceStatus || '').toLowerCase())
        ) || (order as any).invoices?.[0];
        if (!inv) return null;
        return (
          <button
            type="button"
            onClick={() => {
              onClose();
              downloadSapMiroExport(inv.id);
            }}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-emerald-800 hover:bg-emerald-50 transition-colors text-left cursor-pointer"
            title="Export to SAP MIRO / MIGO batch CSV"
          >
            <FileText className="h-3.5 w-3.5 text-emerald-600" />
            <span>Export SAP (MIRO)</span>
          </button>
        );
      })()}

      {(() => {
        const isPaid = String(order.status || '').toLowerCase().includes('paid');
        const activeInvoice = (order as any).invoices?.find(
          (inv: any) =>
            String(inv.status || inv.invoiceStatus || '').toLowerCase() !== 'cancelled' &&
            String(inv.status || inv.invoiceStatus || '').toLowerCase() !== 'rejected'
        ) || (order as any).invoices?.[0];

        const hasSlip = Boolean(
          activeInvoice?.paymentSlipFileId ||
          activeInvoice?.paymentSlipFile ||
          (activeInvoice as any)?.offlineProof ||
          (activeInvoice as any)?.paymentReceiptFileAssetId ||
          (order as any).paymentSlipFileId ||
          (order as any).paymentSlip ||
          (order as any).offlineProof ||
          (order as any).paymentProof
        );

        const hasPaymentRecorded = Boolean(
          isPaid ||
          hasSlip ||
          activeInvoice?.paymentReference ||
          String(activeInvoice?.status || '').toLowerCase() === 'payment_submitted' ||
          String(activeInvoice?.status || '').toLowerCase().includes('paid') ||
          String(order.status || '').toLowerCase() === 'payment_submitted' ||
          String((order as any).paymentStatus || '').toLowerCase() === 'paid' ||
          String((order as any).paymentStatus || '').toLowerCase() === 'under_verification' ||
          String((order as any).paymentStatus || '').toLowerCase() === 'payment_submitted' ||
          (order as any).payments?.length > 0
        );

        const isPaymentDone = isPaid || hasPaymentRecorded || hasSlip;

        const isSettled = Boolean(
          activeInvoice?.settledAt ||
          String(activeInvoice?.status || '').toLowerCase() === 'paid' ||
          (isPaid && !hasSlip)
        );

        if (isSeller && !isCancelled) {
          return (
            <>
              {isPaymentDone && !isSettled && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onConfirmSettlement?.(order);
                  }}
                  className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-emerald-700 hover:bg-emerald-50 transition-colors text-left cursor-pointer"
                >
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  <span>Confirm Settlement</span>
                </button>
              )}

              {isPaymentDone && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onViewPaymentSlip?.(order);
                  }}
                  onMouseEnter={() => {
                    const proofId = activeInvoice?.paymentSlipFileId || (order as any)?.paymentSlipFileId || (order as any)?.paymentSlipFile;
                    if (proofId) prewarmFileAssetPreview(proofId, 'Payment_Proof');
                  }}
                  onFocus={() => {
                    const proofId = activeInvoice?.paymentSlipFileId || (order as any)?.paymentSlipFileId || (order as any)?.paymentSlipFile;
                    if (proofId) prewarmFileAssetPreview(proofId, 'Payment_Proof');
                  }}
                  className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-emerald-800 hover:bg-emerald-50 transition-colors text-left cursor-pointer"
                  title="View uploaded payment proof"
                >
                  <Receipt className="h-3.5 w-3.5 text-emerald-600" />
                  <span>View Payment Proof</span>
                </button>
              )}
            </>
          );
        }

        return null;
      })()}

      {isBuyer && !isCancelled && !isDelivered && (
        <button
          type="button"
          onClick={() => {
            onClose();
            setConfirming({ action: 'cancel', order });
          }}
          className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-rose-700 hover:bg-rose-50 transition-colors text-left"
        >
          <XCircle className="h-3.5 w-3.5 text-rose-600" />
          <span>Cancel</span>
        </button>
      )}
        </div>,
        document.body
      )}
    </div>
  );
};

export default function PurchaseOrders() {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const targetParamProcessedRef = useRef<string | null>(null);
  const isSeller = user?.role === 'seller' || user?.role === 'shg';
  const isBuyer = user?.role === 'buyer';

  const [activeTab, setActiveTab] = useState<'Open' | 'Delivered' | 'Cancelled' | 'All'>('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All Statuses');
  const [partyFilter, setPartyFilter] = useState('All Parties');
  const [valueFilter, setValueFilter] = useState('All Values');
  const [expectedDateFilter, setExpectedDateFilter] = useState('All Dates');
  const [expectedDateCustom, setExpectedDateCustom] = useState({ start: '', end: '' });
  const [updatedDateFilter, setUpdatedDateFilter] = useState({ start: '', end: '' });
  const [sortBy, setSortBy] = useState('newest');
  const [viewMode, setViewMode] = useResponsiveViewMode();
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [confirming, setConfirming] = useState<{ action: 'acknowledge' | 'cancel'; order: PurchaseOrderDto } | null>(null);
  const [rejectingOrder, setRejectingOrder] = useState<PurchaseOrderDto | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string>('');
  const [isSubmittingReject, setIsSubmittingReject] = useState<boolean>(false);
  const isOrderActionBusyRef = useRef(false);
  const [recallingOrder, setRecallingOrder] = useState<PurchaseOrderDto | null>(null);
  const [recallReason, setRecallReason] = useState<string>('');
  const [isSubmittingRecall, setIsSubmittingRecall] = useState<boolean>(false);
  const [viewingOrder, setViewingOrder] = useState<PurchaseOrderDto | null>(null);
  const [receiptModalOrder, setReceiptModalOrder] = useState<PurchaseOrderDto | null>(null);
  const [uploadProofOrder, setUploadProofOrder] = useState<PurchaseOrderDto | null>(null);
  const [viewProofOrder, setViewProofOrder] = useState<PurchaseOrderDto | null>(null);
  const [recordPaymentOrder, setRecordPaymentOrder] = useState<PurchaseOrderDto | null>(null);
  const [confirmSettlementOrder, setConfirmSettlementOrder] = useState<PurchaseOrderDto | null>(null);
  const [grnModalPoId, setGrnModalPoId] = useState<number | null>(null);
  const [openKebabId, setOpenKebabId] = useState<number | null>(null);
  const [taxInvoiceModalOpen, setTaxInvoiceModalOpen] = useState(false);
  const [taxInvoiceModalId, setTaxInvoiceModalId] = useState<number | null>(null);
  const [taxInvoiceModalData, setTaxInvoiceModalData] = useState<any | null>(null);
  const [editPoModalOpen, setEditPoModalOpen] = useState(false);
  const [editPoTarget, setEditPoTarget] = useState<any | null>(null);
  const [editPoMode, setEditPoMode] = useState<'draft' | 'amend'>('draft');
  const [importExternalModalOpen, setImportExternalModalOpen] = useState(false);

  useEffect(() => {
    if (!openKebabId) return;
    const handleClose = () => setOpenKebabId(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenKebabId(null);
    };
    
    window.addEventListener('click', handleClose);
    window.addEventListener('scroll', handleClose, { capture: true, passive: true });
    window.addEventListener('resize', handleClose);
    window.addEventListener('keydown', handleKeyDown);
    
    return () => {
      window.removeEventListener('click', handleClose);
      window.removeEventListener('scroll', handleClose, { capture: true });
      window.removeEventListener('resize', handleClose);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [openKebabId]);

  const { data: activeDelivery } = useDeliveryByPO(viewingOrder?.id);

  const [repeatingOrder, setRepeatingOrder] = useState<PurchaseOrderDto | null>(null);

  const handleOpenRepeatModal = (order: PurchaseOrderDto) => {
    router.push(`/buyer/repeat-orders?selectPo=${order.id}`);
  };
  const viewerScope = `${user?.role || 'guest'}-${user?.id || 'none'}`;

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchTerm);
    }, 400);
    return () => clearTimeout(handler);
  }, [searchTerm]);

  const { data: allOrders, loading, refreshing, error, reload: reloadAllOrders, setData: setAllOrders } = useFeatureQuery<PurchaseOrderDto[]>(
    `/api/purchase-orders?take=100&viewerScope=${encodeURIComponent(viewerScope)}`,
    []
  );

  const reload = reloadAllOrders;
  const setPagedOrders = setAllOrders; // Alias for minimal changes to action handlers

  useEffect(() => {
    const targetId = searchParams?.get('orderId') || searchParams?.get('id') || searchParams?.get('poId');
    const searchParam = searchParams?.get('search') || searchParams?.get('po');
    const tabParam = searchParams?.get('tab');

    if (tabParam && ['Open', 'Delivered', 'Cancelled', 'All'].includes(tabParam)) {
      setActiveTab(tabParam as any);
    }

    if (searchParam && !searchTerm) {
      setSearchTerm(searchParam);
    }

    if (!targetId || targetParamProcessedRef.current === targetId) return;

    const numId = Number(targetId);
    const found = allOrders.find(
      (o) => o.id === numId || String(o.id) === targetId || o.poNumber?.toLowerCase() === targetId.toLowerCase()
    );

    if (found) {
      setViewingOrder(found);
      setActiveTab('All');
      targetParamProcessedRef.current = targetId;
      return;
    }

    if (!loading) {
      targetParamProcessedRef.current = targetId;
      let alive = true;
      api.get(`/api/purchase-orders/${targetId}`)
        .then(readJsonResponse)
        .then((body: any) => {
          const fullData = body?.data || body;
          if (fullData && fullData.id && alive) {
            setViewingOrder(fullData);
            setActiveTab('All');
          }
        })
        .catch(() => {
          // Ignore if order not found
        });
      return () => { alive = false; };
    }
  }, [searchParams, allOrders, loading, searchTerm]);

  const uniqueStatuses = useMemo(() => {
    const statuses = new Set<string>();
    allOrders.forEach(o => {
      if (o.status) statuses.add(readableStatus(o.status));
    });
    return Array.from(statuses).sort();
  }, [allOrders]);

  const uniqueParties = useMemo(() => {
    const parties = new Set<string>();
    allOrders.forEach(o => {
      if (o.seller?.name) parties.add(o.seller.name);
      if (o.buyer?.name) parties.add(o.buyer.name);
    });
    return Array.from(parties).sort();
  }, [allOrders]);

  const processedOrders = useMemo(() => {
    let result = [...allOrders];

    // 1. Search
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter(o => 
        o.poNumber?.toLowerCase().includes(q) || 
        o.title?.toLowerCase().includes(q) || 
        o.seller?.name?.toLowerCase().includes(q) || 
        o.buyer?.name?.toLowerCase().includes(q)
      );
    }

    // 2. Tab Filter
    if (activeTab === 'Open') result = result.filter(isOpenPurchaseOrder);
    else if (activeTab === 'Delivered') result = result.filter(o => ['delivered', 'completed'].includes(String(o.status || '').toLowerCase()));
    else if (activeTab === 'Cancelled') result = result.filter(o => ['cancelled', 'rejected'].includes(String(o.status || '').toLowerCase()));

    // 3. Status Filter
    if (statusFilter && statusFilter !== 'All Statuses') {
      result = result.filter(o => readableStatus(o.status).toLowerCase() === statusFilter.toLowerCase());
    }

    // 4. Party Filter
    if (partyFilter && partyFilter !== 'All Parties') {
      result = result.filter(o => o.seller?.name === partyFilter || o.buyer?.name === partyFilter);
    }

    // 5. Value Filter
    if (valueFilter && valueFilter !== 'All Values') {
      result = result.filter(o => {
        const val = Number(o.amount || o.totalValue || 0);
        if (valueFilter === 'Below ₹10,000') return val < 10000;
        if (valueFilter === '₹10,000 – ₹50,000') return val >= 10000 && val <= 50000;
        if (valueFilter === '₹50,000 – ₹1,00,000') return val >= 50000 && val <= 100000;
        if (valueFilter === 'Above ₹1,00,000') return val > 100000;
        return true;
      });
    }

    // 6. Expected Date Filter
    if (expectedDateFilter && expectedDateFilter !== 'All Dates') {
      const now = new Date();
      now.setHours(0,0,0,0);
      result = result.filter(o => {
        if (!o.expectedDelivery) return false;
        const expected = new Date(o.expectedDelivery);
        expected.setHours(0,0,0,0);
        
        if (expectedDateFilter === 'Upcoming') {
          return expected >= now && !['delivered', 'completed', 'cancelled', 'rejected'].includes(String(o.status).toLowerCase());
        }
        if (expectedDateFilter === 'Overdue') {
          return expected < now && !['delivered', 'completed', 'cancelled', 'rejected'].includes(String(o.status).toLowerCase());
        }
        if (expectedDateFilter === 'Custom Date Range') {
           const start = expectedDateCustom.start ? new Date(expectedDateCustom.start) : null;
           const end = expectedDateCustom.end ? new Date(expectedDateCustom.end) : null;
           if (start) start.setHours(0,0,0,0);
           if (end) end.setHours(23,59,59,999);
           
           if (start && expected < start) return false;
           if (end && expected > end) return false;
           return true;
        }
        return true;
      });
    }

    // 7. Updated Date Filter
    if (updatedDateFilter.start || updatedDateFilter.end) {
      result = result.filter(o => {
        if (!o.updatedAt) return false;
        const updated = new Date(o.updatedAt);
        const start = updatedDateFilter.start ? new Date(updatedDateFilter.start) : null;
        const end = updatedDateFilter.end ? new Date(updatedDateFilter.end) : null;
        if (start) start.setHours(0,0,0,0);
        if (end) end.setHours(23,59,59,999);
        
        if (start && updated < start) return false;
        if (end && updated > end) return false;
        return true;
      });
    }

    // 8. Sorting
    result.sort((a, b) => {
      const valA = Number(a.amount || a.totalValue || 0);
      const valB = Number(b.amount || b.totalValue || 0);
      
      if (sortBy === 'value_high') return valB - valA;
      if (sortBy === 'value_low') return valA - valB;
      if (sortBy === 'newest') return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      
      if (sortBy === 'po_asc') return String(a.poNumber || '').localeCompare(String(b.poNumber || ''));
      if (sortBy === 'po_desc') return String(b.poNumber || '').localeCompare(String(a.poNumber || ''));
      if (sortBy === 'title_asc') return String(a.title || '').localeCompare(String(b.title || ''));
      if (sortBy === 'title_desc') return String(b.title || '').localeCompare(String(a.title || ''));
      if (sortBy === 'party_asc') return String(a.seller?.name || '').localeCompare(String(b.seller?.name || ''));
      if (sortBy === 'party_desc') return String(b.seller?.name || '').localeCompare(String(a.seller?.name || ''));
      if (sortBy === 'expected_asc') return new Date(a.expectedDelivery || 0).getTime() - new Date(b.expectedDelivery || 0).getTime();
      if (sortBy === 'expected_desc') return new Date(b.expectedDelivery || 0).getTime() - new Date(a.expectedDelivery || 0).getTime();
      if (sortBy === 'updated_asc') return new Date(a.updatedAt || 0).getTime() - new Date(b.updatedAt || 0).getTime();
      if (sortBy === 'updated_desc') return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
      if (sortBy === 'status_asc' || sortBy === 'status') return String(a.status || '').localeCompare(String(b.status || ''));
      if (sortBy === 'status_desc') return String(b.status || '').localeCompare(String(a.status || ''));

      return 0;
    });

    return result;
  }, [allOrders, activeTab, debouncedSearch, statusFilter, partyFilter, valueFilter, expectedDateFilter, expectedDateCustom, updatedDateFilter, sortBy]);

  const { page, pageSize, total, pageItems: visibleOrders, setPage, setPageSize } = usePagination(processedOrders, 10);

  const totalSpend = useMemo(
    () => allOrders.reduce((sum, order) => sum + Number(order.amount || order.totalValue || 0), 0),
    [allOrders]
  );
  const deliveredCount = useMemo(
    () => allOrders.filter(order => {
      const s = String(order.status || '').toLowerCase();
      return s === 'delivered' || s === 'completed';
    }).length,
    [allOrders]
  );
  const openCount = useMemo(
    () => allOrders.filter(isOpenPurchaseOrder).length,
    [allOrders]
  );
  const poHealth = useMemo(() => {
    const now = new Date();
    return allOrders.reduce(
      (acc, order) => {
        const value = Number(order.amount || order.totalValue || 0);
        const status = String(order.status || '').toLowerCase();
        if (isOpenPurchaseOrder(order)) acc.openValue += value;
        if (isSeller && status === 'accepted') acc.invoiceReady += 1;
        if (isSeller && (status === 'generated' || status === 'order_placed')) acc.awaitingSeller += 1;
        const expected = order.expectedDelivery ? new Date(order.expectedDelivery) : null;
        if (expected && expected < now && !['delivered', 'cancelled', 'completed'].includes(status)) {
          acc.deliveryRisk += 1;
        }
        return acc;
      },
      { openValue: 0, invoiceReady: 0, awaitingSeller: 0, deliveryRisk: 0 }
    );
  }, [allOrders, isSeller]);

  const refreshPurchaseOrders = async () => {
    await Promise.all([reload(), reloadAllOrders()]);
  };

  const handleConvertToInvoice = (order: PurchaseOrderDto) => {
    const amountVal = order.amount || order.totalValue || 0;
    router.push(`/seller/invoices?convertPoId=${order.id}&amount=${amountVal}`);
  };

  useEffect(() => {
    if (!viewingOrder?.id) return;
    let isMounted = true;
    (async () => {
      try {
        const res = await api.get(`/api/purchase-orders/${viewingOrder.id}`);
        const body = await readJsonResponse(res);
        const fullData = (body as any)?.data || body;
        if (fullData && fullData.id && isMounted) {
          setViewingOrder(prev => ({ ...(prev || viewingOrder), ...fullData }));
        }
      } catch {
        // ignore
      }
    })();
    return () => { isMounted = false; };
  }, [viewingOrder?.id]);

  const formatTimestamp = (value?: string | Date | null) => {
    return formatDateTime(value);
  };


  const toggleSort = (key: string) => {
    if (key === 'po') {
      setSortBy(sortBy === 'po_asc' ? 'po_desc' : 'po_asc');
    } else if (key === 'title') {
      setSortBy(sortBy === 'title_asc' ? 'title_desc' : 'title_asc');
    } else if (key === 'party') {
      setSortBy(sortBy === 'party_asc' ? 'party_desc' : 'party_asc');
    } else if (key === 'value') {
      setSortBy(sortBy === 'value_low' ? 'value_high' : 'value_low');
    } else if (key === 'expected') {
      setSortBy(sortBy === 'expected_asc' ? 'expected_desc' : 'expected_asc');
    } else if (key === 'status') {
      setSortBy(sortBy === 'status_asc' ? 'status_desc' : 'status_asc');
    } else if (key === 'updated') {
      setSortBy(sortBy === 'updated_asc' ? 'updated_desc' : 'updated_asc');
    }
  };

  const completeAction = async () => {
    if (!confirming) return;
    try {
      const endpoint = confirming.action === 'acknowledge'
        ? `/api/purchase-orders/${confirming.order.id}/acknowledge`
        : `/api/purchase-orders/${confirming.order.id}/cancel`;
      const updated = await postApi<PurchaseOrderDto>(endpoint, {});
      setPagedOrders(current => current.map(order => order.id === updated.id ? { ...order, ...updated } : order));
      if (viewingOrder && viewingOrder.id === updated.id) {
        setViewingOrder(updated);
      }
      toast.success(`PO ${readableStatus(updated.status)}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Unable to update purchase order');
    } finally {
      setConfirming(null);
    }
  };

  const handleAcceptOrder = async (order: PurchaseOrderDto) => {
    if (isOrderActionBusyRef.current) return;
    isOrderActionBusyRef.current = true;
    try {
      const endpoint = `/api/purchase-orders/${order.id}/acknowledge`;
      const updated = await postApi<PurchaseOrderDto>(endpoint, {});
      setPagedOrders(current => current.map(o => o.id === updated.id ? { ...o, ...updated, status: 'accepted' } : o));
      if (viewingOrder && viewingOrder.id === order.id) {
        setViewingOrder({ ...viewingOrder, ...updated, status: 'accepted' });
      }
      toast.success(`Purchase Order ${order.poNumber || `PO-${order.id}`} ACCEPTED. Please prepare items for dispatch in Delivery Management.`);
      await refreshPurchaseOrders();
      if (order.poNumber) {
        router.push(`/seller/delivery-management?search=${encodeURIComponent(order.poNumber)}`);
      } else {
        router.push('/seller/delivery-management');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Unable to accept purchase order');
    } finally {
      setTimeout(() => {
        isOrderActionBusyRef.current = false;
      }, 300);
    }
  };

  const handleRejectOrder = (order: PurchaseOrderDto) => {
    setRejectingOrder(order);
    setRejectionReason('');
  };

  const confirmRejectOrder = async () => {
    if (!rejectingOrder || isOrderActionBusyRef.current || isSubmittingReject) return;
    isOrderActionBusyRef.current = true;
    setIsSubmittingReject(true);
    try {
      const endpoint = `/api/purchase-orders/${rejectingOrder.id}/reject`;
      const updated = await postApi<PurchaseOrderDto>(endpoint, {
        reason: rejectionReason.trim() || undefined,
        rejectionReason: rejectionReason.trim() || undefined
      });
      setPagedOrders(current => current.map(o => o.id === updated.id ? { ...o, ...updated, status: 'rejected' } : o));
      if (viewingOrder && viewingOrder.id === rejectingOrder.id) {
        setViewingOrder({ ...viewingOrder, ...updated, status: 'rejected' });
      }
      toast.success(`Purchase Order ${rejectingOrder.poNumber || `PO-${rejectingOrder.id}`} has been REJECTED.`);
      setRejectingOrder(null);
      setRejectionReason('');
      await refreshPurchaseOrders();
    } catch (err: any) {
      toast.error(err?.message || 'Unable to reject purchase order');
    } finally {
      setIsSubmittingReject(false);
      setTimeout(() => {
        isOrderActionBusyRef.current = false;
      }, 300);
    }
  };

  const handleRecallPo = (order: PurchaseOrderDto) => {
    setRecallingOrder(order);
    setRecallReason('');
  };

  const confirmRecallPo = async () => {
    if (!recallingOrder || isOrderActionBusyRef.current || isSubmittingRecall) return;
    isOrderActionBusyRef.current = true;
    setIsSubmittingRecall(true);
    try {
      const endpoint = `/api/purchase-orders/${recallingOrder.id}/recall`;
      const updated = await postApi<PurchaseOrderDto>(endpoint, {
        reason: recallReason.trim() || undefined
      });
      toast.success(`Purchase Order ${recallingOrder.poNumber || `PO-${recallingOrder.id}`} recalled to Draft. Opening editor...`);
      const targetToEdit = { ...recallingOrder, ...updated, status: 'draft', poStatus: 'DRAFT', isDraft: true };
      setPagedOrders(current => current.map(o => o.id === updated.id ? targetToEdit : o));
      if (viewingOrder && viewingOrder.id === recallingOrder.id) {
        setViewingOrder(targetToEdit);
      }
      setRecallingOrder(null);
      setRecallReason('');
      await refreshPurchaseOrders();
      // Seamlessly open the Edit Draft Modal so buyer can make corrections immediately
      setEditPoTarget(targetToEdit);
      setEditPoMode('draft');
      setEditPoModalOpen(true);
    } catch (err: any) {
      toast.error(err?.message || 'Unable to recall purchase order to draft');
    } finally {
      setIsSubmittingRecall(false);
      setTimeout(() => {
        isOrderActionBusyRef.current = false;
      }, 300);
    }
  };

  const handleOpenDelivery = async (order: PurchaseOrderDto) => {
    // 1. Direct delivery tracking ID if present on PO or activeDelivery
    const dlvId = (order as any).deliveryTrackings?.[0]?.id || 
                  (order as any).deliveryId || 
                  (order as any).delivery?.id || 
                  (activeDelivery?.id && viewingOrder?.id === order.id ? activeDelivery.id : null);
    if (dlvId) {
      router.push(`/delivery/${dlvId}`);
      return;
    }

    // 2. Fetch delivery record associated with this PO
    try {
      const dlv = await getDeliveryByPurchaseOrder(order.id);
      if (dlv?.id) {
        router.push(`/delivery/${dlv.id}`);
        return;
      }
    } catch (err) {
      console.warn('Could not resolve delivery for PO', err);
    }

    // 3. Fallback to role-specific delivery management list
    const isSellerSide = user?.role === 'seller' || user?.role === 'shg';
    if (isSellerSide) {
      if (order.poNumber) {
        router.push(`/seller/delivery-management?search=${encodeURIComponent(order.poNumber)}`);
      } else {
        router.push('/seller/delivery-management');
      }
    } else {
      if (order.poNumber) {
        router.push(`/orders/tracking?search=${encodeURIComponent(order.poNumber)}`);
      } else {
        router.push('/orders/tracking');
      }
    }
  };

  const handleViewGrn = async (targetOrder: any) => {
    const grn = getExistingGrn(targetOrder);
    let grnId = grn?.id || targetOrder.grnId || targetOrder.grn?.id;
    if (grnId) {
      router.push(`/grn/${grnId}`);
      return;
    }

    try {
      const res = await api.get(`/api/grn/po/${targetOrder.id}/eligibility`).then(readJsonResponse);
      const existingList = res?.data?.existing || res?.existing || [];
      if (Array.isArray(existingList) && existingList.length > 0 && existingList[0]?.id) {
        router.push(`/grn/${existingList[0].id}`);
        return;
      }
    } catch (err) {
      console.warn('Failed to resolve GRN by eligibility, trying po detail', err);
    }

    try {
      const poRes = await api.get(`/api/purchase-orders/${targetOrder.id}`).then(readJsonResponse);
      const poData = poRes?.data || poRes;
      const gId = poData?.grns?.find((g: any) => String(g.status || '').toUpperCase() === 'APPROVED')?.id ||
                  poData?.grns?.[0]?.id ||
                  poData?.grnId;
      if (gId) {
        router.push(`/grn/${gId}`);
        return;
      }
    } catch (err) {
      console.warn('Failed to resolve GRN by PO details', err);
    }

    router.push('/grn');
  };

  const renderOrderActions = (order: PurchaseOrderDto) => {
    const statusLower = String(order.status || '').toLowerCase();
    const poStatusLower = String(order.poStatus || '').toLowerCase();
    const effectiveStatus = poStatusLower || statusLower;
    const isIssued = statusLower === 'issued' || statusLower === 'generated' || statusLower === 'order_placed' || statusLower === 'pending_approval' || statusLower === 'pending_acceptance' || effectiveStatus === 'pending_acceptance' || effectiveStatus === 'issued';
    const isAccepted = statusLower === 'accepted' || statusLower === 'in_fulfillment';
    const isDelivered = statusLower === 'delivered' || statusLower === 'completed';
    const isCancelled = statusLower === 'cancelled' || statusLower === 'rejected';

    return (
      <OrderActionDropdown
        order={order}
        isOpen={openKebabId === order.id}
        onToggle={() => setOpenKebabId(openKebabId === order.id ? null : order.id)}
        onClose={() => setOpenKebabId(null)}
        isSeller={isSeller}
        isBuyer={isBuyer}
        isIssued={isIssued}
        isAccepted={isAccepted}
        isDelivered={isDelivered}
        isCancelled={isCancelled}
        setViewingOrder={setViewingOrder}
        handleAcceptOrder={handleAcceptOrder}
        handleRejectOrder={handleRejectOrder}
        handleOpenDelivery={handleOpenDelivery}
        exportInvoicePdf={exportInvoicePdf}
        setConfirming={setConfirming}
        onUploadPaymentSlip={setUploadProofOrder}
        onViewPaymentSlip={setViewProofOrder}
        onViewReceipt={setReceiptModalOrder}
        onRecordPayment={setRecordPaymentOrder}
        onConfirmSettlement={setConfirmSettlementOrder}
        onOpenGrnModal={(poId: number) => setGrnModalPoId(poId)}
        onViewGrn={handleViewGrn}
        onViewInvoice={(invId: number, invData: any) => {
          setTaxInvoiceModalId(invId);
          setTaxInvoiceModalData(invData);
          setTaxInvoiceModalOpen(true);
        }}
        onEditPoDraft={(target: any) => {
          setEditPoTarget(target);
          setEditPoMode('draft');
          setEditPoModalOpen(true);
        }}
        onIssuePo={async (target: any) => {
          try {
            await postApi(`/api/purchase-orders/${target.id}/issue`, {});
            toast.success(`Purchase Order ${target.poNumber || `PO-${target.id}`} officially ISSUED to supplier!`);
            await refreshPurchaseOrders();
          } catch (err: any) {
            toast.error(err.message || 'Failed to issue purchase order');
          }
        }}
        onRecallPo={handleRecallPo}
        onAmendPo={(target: any) => {
          setEditPoTarget(target);
          setEditPoMode('amend');
          setEditPoModalOpen(true);
        }}
        onAcceptAmendment={async (target: any) => {
          try {
            await postApi(`/api/purchase-orders/${target.id}/amendment-decision`, { decision: 'accept', accepted: true });
            toast.success(`Amendment ACCEPTED for PO ${target.poNumber || `PO-${target.id}`}.`);
            await refreshPurchaseOrders();
          } catch (err: any) {
            toast.error(err.message || 'Failed to accept amendment');
          }
        }}
        onDeclineAmendment={async (target: any) => {
          try {
            await postApi(`/api/purchase-orders/${target.id}/amendment-decision`, { decision: 'decline', accepted: false, remarks: 'Declined by supplier', reason: 'Declined by supplier' });
            toast.success(`Amendment DECLINED for PO ${target.poNumber || `PO-${target.id}`}.`);
            await refreshPurchaseOrders();
          } catch (err: any) {
            toast.error(err.message || 'Failed to decline amendment');
          }
        }}
      />
    );
  };



  const exportInvoicePdf = async (baseOrder: PurchaseOrderDto, mode: 'download' | 'print') => {
    const { PdfEngine } = await import('../lib/pdfEngine');
    let order = baseOrder;
    try {
      const res = await api.get(`/api/purchase-orders/${baseOrder.id}`);
      const body = await readJsonResponse(res);
      const fullData = (body as any)?.data || body;
      if (fullData && fullData.id) {
        order = { ...baseOrder, ...fullData };
      }
    } catch (err) {
      console.warn('Failed to fetch full PO details for PDF, using list data', err);
    }

    const totalValue = Number(order.amount || order.totalValue || 0);
    
    // Fallback items if none exist
    const items = order.items?.length ? order.items : [{
      itemName: order.title,
      quantity: 1,
      unitPrice: totalValue,
      totalAmount: totalValue
    }];

    const tableData = items.map((item, index) => {
      const qty = Number(item.quantity || 1);
      const unitPrice = Number(item.unitPrice || 0);
      const lineTotal = Number(item.totalAmount || qty * unitPrice || totalValue);
      return [
        String(index + 1),
        item.itemName || order.title,
        String(qty),
        unitPrice || (lineTotal / Math.max(qty, 1)),
        lineTotal
      ];
    });

    const subtotal = tableData.reduce((sum, row) => sum + Number(row[4] || 0), 0) || totalValue;

    const seller = (order.seller as any) || {};
    const buyer = (order.buyer as any) || {};
    const sellerReg = (seller.registrationDetails as Record<string, any>) || {};
    const buyerReg = (buyer.registrationDetails as Record<string, any>) || {};

    const buyerOrgName =
      buyer.organization?.organizationName ||
      buyer.buyerProfile?.organizationName ||
      buyer.buyerProfile?.companyName ||
      buyerReg.companyName ||
      buyerReg.businessName ||
      buyerReg.legalName ||
      buyerReg.tradeName ||
      buyer.name ||
      'N/A';

    const sellerOrg =
      seller.organization?.organizationName ||
      sellerReg.tradeName ||
      sellerReg.legalName ||
      sellerReg.businessName ||
      sellerReg.gstDetails?.tradeName ||
      sellerReg.gstDetails?.legalName ||
      sellerReg.gstDetails?.organizationName ||
      seller.sellerProfile?.businessName ||
      seller.sellerProfile?.companyName ||
      sellerReg.companyName ||
      seller.name ||
      'N/A';

    const sellerOrgAddress = seller.organization?.address ||
      [seller.organization?.addressLine1, seller.organization?.addressLine2, seller.organization?.city, seller.organization?.state, seller.organization?.pincode].filter(Boolean).join(', ');

    const sellerAddress =
      sellerOrgAddress ||
      seller.sellerProfile?.registeredAddress ||
      seller.sellerProfile?.address ||
      sellerReg.businessAddress ||
      sellerReg.registeredAddress ||
      sellerReg.address ||
      sellerReg.gstDetails?.businessAddress ||
      sellerReg.gstDetails?.registeredOfficeAddress ||
      sellerReg.gstDetails?.address ||
      'N/A';

    const sellerGstin =
      seller.organization?.gstin ||
      seller.sellerProfile?.gst ||
      sellerReg.gstin ||
      sellerReg.gstDetails?.gstin ||
      sellerReg.gstDetails?.gstNumber ||
      sellerReg.gstDetails?.responseGstin ||
      'N/A';

    const buyerOrgAddress = buyer.organization?.address ||
      [buyer.organization?.addressLine1, buyer.organization?.addressLine2, buyer.organization?.city, buyer.organization?.state, buyer.organization?.pincode].filter(Boolean).join(', ');

    const buyerAddress =
      order.deliveryAddress ||
      buyerOrgAddress ||
      buyer.buyerProfile?.registeredAddress ||
      buyer.buyerProfile?.address ||
      buyerReg.registeredAddress ||
      buyerReg.address ||
      'N/A';

    const buyerGstin =
      buyer.organization?.gstin ||
      buyer.buyerProfile?.gstin ||
      buyerReg.gstin ||
      buyerReg.gstDetails?.gstin ||
      buyerReg.gstDetails?.gstNumber ||
      buyerReg.gstDetails?.responseGstin ||
      'N/A';

    const sellerUdyam =
      seller.organization?.udyamNumber ||
      seller.sellerProfile?.udyamNumber ||
      sellerReg.udyamNumber ||
      sellerReg.udyamDetails?.udyamNumber ||
      sellerReg.udyam ||
      null;

    const currentUserReg = (user?.registrationDetails as Record<string, any>) || {};
    const lsStamp = typeof window !== 'undefined' ? localStorage.getItem('msme_invoice_stamp') : null;
    const lsSig = typeof window !== 'undefined' ? localStorage.getItem('msme_invoice_signature') : null;
    const lsLogo = typeof window !== 'undefined' ? localStorage.getItem('msme_invoice_logo') : null;

    const sellerLogo =
      seller.organization?.profile?.logoUrl ||
      sellerReg.logoUrl ||
      seller.organization?.logoFile?.url ||
      seller.organization?.logoFile?.fileUrl ||
      (seller.organization?.organizationLogoFileId ? `/api/files/${seller.organization.organizationLogoFileId}/view` : null) ||
      (seller.organization?.organizationLogoFileId ? `/api/files/${seller.organization.organizationLogoFileId}/download` : null) ||
      (order.sellerId === user?.id || isSeller ? (currentUserReg.logoUrl || lsLogo) : null);

    const buyerLogo =
      buyer.organization?.profile?.logoUrl ||
      buyerReg.logoUrl ||
      buyer.organization?.logoFile?.url ||
      buyer.organization?.logoFile?.fileUrl ||
      (buyer.organization?.organizationLogoFileId ? `/api/files/${buyer.organization.organizationLogoFileId}/view` : null) ||
      (buyer.organization?.organizationLogoFileId ? `/api/files/${buyer.organization.organizationLogoFileId}/download` : null) ||
      (order.buyerId === user?.id || isBuyer ? (currentUserReg.logoUrl || lsLogo) : null);

    const effectiveSellerLogo = resolveMediaUrl(sellerLogo);
    const effectiveBuyerLogo = resolveMediaUrl(buyerLogo);

    const effectiveSellerSignature = resolveMediaUrl(
      sellerReg.signatureUrl || (order.sellerId === user?.id || isSeller ? (currentUserReg.signatureUrl || lsSig) : null)
    );
    const effectiveSellerStamp = resolveMediaUrl(
      sellerReg.stampUrl || (order.sellerId === user?.id || isSeller ? (currentUserReg.stampUrl || lsStamp) : null)
    );
    const effectiveBuyerSignature = resolveMediaUrl(
      buyerReg.signatureUrl || (order.buyerId === user?.id || isBuyer ? (currentUserReg.signatureUrl || lsSig) : null)
    );
    const effectiveBuyerStamp = resolveMediaUrl(
      buyerReg.stampUrl || (order.buyerId === user?.id || isBuyer ? (currentUserReg.stampUrl || lsStamp) : null)
    );

    const { generateOfficialPurchaseOrderPdf } = await import('../features/purchaseOrders/lib/purchaseOrderPdfGenerator');

    const poDate = order.createdAt ? new Date(order.createdAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    const dueDate = order.expectedDelivery ? new Date(order.expectedDelivery).toISOString().slice(0, 10) : poDate;
    const trackingNumber = (order.deliveryTrackings && order.deliveryTrackings[0]?.trackingNumber) || 'Pending Dispatch';
    const metaBase = Number(order.metadata?.baseAmount || order.metadata?.taxableAmount || 0);
    const metaGst = Number(order.metadata?.gstAmount || 0);
    const rawGstRate = Number(order.metadata?.gstRate || 18);
    const grandTotal = totalValue || subtotal;
    const actualTaxable = metaBase > 0 && metaGst > 0 ? metaBase : (grandTotal > 0 ? Math.round((grandTotal / (1 + rawGstRate / 100)) * 100) / 100 : subtotal);
    const taxAmount = metaBase > 0 && metaGst > 0 ? metaGst : Math.max(0, Math.round((grandTotal - actualTaxable) * 100) / 100);

    const buyerState = buyerGstin && buyerGstin !== 'N/A' ? buyerGstin.slice(0, 2) : '';
    const sellerState = sellerGstin && sellerGstin !== 'N/A' ? sellerGstin.slice(0, 2) : '';
    const isInterstate = Boolean(buyerState && sellerState && buyerState !== sellerState);
    const taxLabel = isInterstate ? `IGST (${rawGstRate}%)` : `TAX / GST (${rawGstRate}%)`;

    const doc = await generateOfficialPurchaseOrderPdf({
      poNumber: order.poNumber || `PO-${order.id}`,
      poDate,
      dueDate,
      status: readableStatus(order.status),
      shipVia: order.deliveryType ? readableStatus(order.deliveryType) : 'Standard Ground Logistics',
      trackingNumber,
      paymentTerms: order.paymentTerms ? readableStatus(order.paymentTerms) : 'Escrow Held / Pay on Invoice',
      issuerName: buyerOrgName !== 'N/A' ? buyerOrgName : (sellerOrg !== 'N/A' ? sellerOrg : 'Enterprise Procurement'),
      issuerSubtitle: 'Official Purchase Order Document',
      issuerLogoUrl: effectiveBuyerLogo || effectiveSellerLogo,
      buyer: {
        name: buyerOrgName,
        contactName: buyer.name && buyer.name !== buyerOrgName ? buyer.name : undefined,
        address: buyerAddress,
        gstin: buyerGstin,
        pan: buyerReg.pan || 'N/A',
        phone: buyer.mobile || buyerReg.mobile || 'N/A',
        email: buyer.email || buyerReg.email || 'N/A',
        logoUrl: effectiveBuyerLogo,
        stampUrl: effectiveBuyerStamp,
        signatureUrl: effectiveBuyerSignature,
      },
      seller: {
        name: sellerOrg,
        contactName: seller.name && seller.name !== sellerOrg ? seller.name : undefined,
        address: sellerAddress,
        udyamNumber: sellerUdyam || undefined,
        gstin: sellerGstin,
        pan: sellerReg.pan || 'N/A',
        phone: seller.mobile || sellerReg.mobile || 'N/A',
        email: seller.email || sellerReg.email || 'N/A',
        logoUrl: effectiveSellerLogo,
        stampUrl: effectiveSellerStamp,
        signatureUrl: effectiveSellerSignature,
      },
      items: items.map((it: any, idx: number) => ({
        itemIndex: idx + 1,
        productCode: it.product?.code || (it.productId ? `PRD-${it.productId}` : `SKU-${idx + 101}`),
        name: it.itemName || it.name || order.title || `Item ${idx + 1}`,
        specs: it.description || (it.product?.brand ? `Brand: ${it.product.brand}` : ''),
        hsn: it.hsnCode || it.hsn || it.product?.hsnCode || order.metadata?.hsnCode || order.metadata?.hsn || sellerReg?.hsnCode || 'N/A',
        quantity: Number(it.quantity || 1),
        unit: it.unitOfMeasure || it.unit || 'Nos',
        unitPrice: Number(it.unitPrice || 0) || (Number(it.totalAmount || totalValue) / Math.max(Number(it.quantity || 1), 1)),
        total: Number(it.totalAmount || (Number(it.quantity || 1) * Number(it.unitPrice || 0)) || totalValue),
      })),
      financials: {
        subtotal: actualTaxable,
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
    if (mode === 'print') {
      doc.autoPrint();
      window.open(doc.output('bloburl'), '_blank');
      toast.success('Purchase Order opened for printing');
      return;
    }
    doc.save(filename);
    toast.success('Purchase Order PDF downloaded');
  };

  const handleClearFilters = () => {
    setSearchTerm('');
    setStatusFilter('All Statuses');
    setPartyFilter('All Parties');
    setValueFilter('All Values');
    setExpectedDateFilter('All Dates');
    setExpectedDateCustom({ start: '', end: '' });
    setUpdatedDateFilter({ start: '', end: '' });
  };

  const activeFiltersCount = 
    (searchTerm ? 1 : 0) + 
    (statusFilter !== 'All Statuses' ? 1 : 0) + 
    (partyFilter !== 'All Parties' ? 1 : 0) + 
    (valueFilter !== 'All Values' ? 1 : 0) + 
    (expectedDateFilter !== 'All Dates' ? 1 : 0) + 
    ((updatedDateFilter.start || updatedDateFilter.end) ? 1 : 0);

  const poColumns: ColumnDef<PurchaseOrderDto>[] = [
    {
      key: 'poNumber',
      header: <SortHeader label="PO" columnKey="po" sortBy={sortBy} onToggleSort={toggleSort} />,
      width: 'w-[15%]',
      cell: (order) => (
        <div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-xs font-black text-[#12335f] whitespace-nowrap">
              <EntityIdLink label={order.poNumber} id={order.id} size="sm" onClick={() => setViewingOrder(order)} />
            </span>
            {(order as any).amendmentVersion && (order as any).amendmentVersion > 1 && (
              <span className="rounded bg-purple-100 text-purple-800 border border-purple-200 px-1 py-0.2 text-[9px] font-bold font-mono">
                v{(order as any).amendmentVersion}
              </span>
            )}
          </div>
          {(order as any).externalPoNumber && (
            <div className="mt-1 flex items-center gap-1 flex-wrap">
              <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-800 border border-blue-200">
                {String((order as any).externalSystem || (order as any).importSource || 'SAP').toUpperCase()}: {(order as any).externalPoNumber}
              </span>
              {(order as any).erpVendorCode && (
                <span className="text-[9px] font-mono text-slate-500 font-semibold" title={`ERP Vendor Code: ${(order as any).erpVendorCode}`}>
                  (V: {(order as any).erpVendorCode})
                </span>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'title',
      header: <SortHeader label="Title" columnKey="title" sortBy={sortBy} onToggleSort={toggleSort} />,
      width: 'w-[23%]',
      cell: (order) => (
        <div>
          <p className="font-bold text-slate-900">{order.title}</p>
          <div className="flex flex-wrap items-center gap-1.5 mt-1">
            <span className="text-[9px] font-bold text-slate-500">{formatDate(order.createdAt)}</span>
            {order.paymentTerms && (
              <span className="text-[9px] font-black text-teal-700 bg-teal-50 px-1.5 py-0.5 rounded uppercase">
                {readableStatus(order.paymentTerms)}
              </span>
            )}
            {order.deliveryType && (
              <span className="text-[9px] font-black text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded uppercase">
                {readableStatus(order.deliveryType)}
              </span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'party',
      header: <SortHeader label="Party" columnKey="party" sortBy={sortBy} onToggleSort={toggleSort} />,
      width: 'w-[13%]',
      cell: (order) => (
        <span className="text-slate-600">{order.seller?.name || order.seller?.email || `Seller #${order.sellerId || '-'}`}</span>
      ),
    },
    {
      key: 'value',
      header: <SortHeader label="Value" columnKey="value" sortBy={sortBy} onToggleSort={toggleSort} />,
      width: 'w-[10%]',
      cell: (order) => (
        <span className="font-bold text-slate-900">{formatCurrency(order.amount || order.totalValue)}</span>
      ),
    },
    {
      key: 'expected',
      header: <SortHeader label="Expected" columnKey="expected" sortBy={sortBy} onToggleSort={toggleSort} />,
      width: 'w-[8%]',
      cell: (order) => <span className="text-slate-500">{formatDate(order.expectedDelivery)}</span>,
    },
    {
      key: 'updated',
      header: <SortHeader label="Updated At" columnKey="updated" sortBy={sortBy} onToggleSort={toggleSort} />,
      width: 'w-[11%]',
      cell: (order) =>
        order.updatedAt ? (
          <div>
            <p className="text-slate-700">{formatDate(order.updatedAt)}</p>
            <p className="text-[9px] font-semibold text-slate-400 mt-0.5">{formatTime(order.updatedAt)}</p>
          </div>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      key: 'status',
      header: <SortHeader label="Status" columnKey="status" sortBy={sortBy} onToggleSort={toggleSort} />,
      width: 'w-[11%]',
      cell: (order) => <StatusPill status={order.status} />,
    },
    {
      key: 'actions',
      header: 'Actions',
      width: 'w-[8%]',
      align: 'right',
      cellClassName: 'text-right',
      cell: (order) => renderOrderActions(order),
    },
  ];

  if ((loading || refreshing) && (!allOrders || allOrders.length === 0)) {
    return <PageTableSkeleton kpiCount={4} />;
  }

  return (
    <div className="space-y-6">
      {/* Transparent Header */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between py-2">
        <div className="min-w-0">
          <h1 className="text-3xl font-black tracking-tight text-slate-900">Purchase Orders</h1>
        </div>
        <div className="flex items-center gap-2">
          {isBuyer && (
            <Button
              onClick={() => setImportExternalModalOpen(true)}
              className="h-10 rounded-lg text-xs font-black uppercase bg-[#12335f] hover:bg-[#0e2a4f] text-white shadow-sm flex items-center gap-1.5 cursor-pointer"
            >
              <Upload className="h-4 w-4" />
              <span>Import External PO / ERP</span>
            </Button>
          )}
          <Button variant="outline" onClick={refreshPurchaseOrders} className="h-10 rounded-lg text-xs font-black uppercase bg-white hover:bg-slate-50 border-slate-200 shadow-sm">
            <RefreshCw className={cn("mr-2 h-4 w-4 text-[#12335f]", refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Open POs"
          value={openCount}
          subtext="Active purchase orders"
          icon={FileText}
          onClick={() => setActiveTab(prev => prev === 'Open' ? 'All' : 'Open')}
          active={activeTab === 'Open'}
          tone="blue"
        />
        <KpiCard
          label="Delivered"
          value={deliveredCount}
          subtext="Completed deliveries"
          icon={CheckCircle2}
          onClick={() => setActiveTab(prev => prev === 'Delivered' ? 'All' : 'Delivered')}
          active={activeTab === 'Delivered'}
          tone="green"
        />
        <KpiCard
          label={isBuyer ? 'Total Spend' : 'Total Order Value'}
          value={formatCurrency(totalSpend)}
          subtext={`${allOrders.length} total ${allOrders.length === 1 ? 'order' : 'orders'}`}
          icon={CreditCard}
          onClick={() => {
            setActiveTab('All');
            setStatusFilter('All Statuses');
            setExpectedDateFilter('All Dates');
          }}
          active={activeTab === 'All' && statusFilter === 'All Statuses' && expectedDateFilter === 'All Dates'}
          tone="indigo"
        />
        <KpiCard
          label={isBuyer ? 'Pending Fulfillment' : 'Open Order Value'}
          value={formatCurrency(poHealth.openValue)}
          subtext={`${openCount} ${openCount === 1 ? 'order' : 'orders'} in pipeline`}
          icon={Clock}
          onClick={() => setActiveTab(prev => prev === 'Open' ? 'All' : 'Open')}
          active={activeTab === 'Open'}
          tone="amber"
          badge={poHealth.deliveryRisk > 0 ? `${poHealth.deliveryRisk} SLA Risk` : undefined}
          badgeColor="bg-rose-100 text-rose-800"
        />
      </div>

      {error && <InlineError message={error} onRetry={reload} />}

      {/* ── Search + Filter + View Toggle Toolbar ── */}
      <div className="rounded-xl border border-slate-200/90 bg-white p-2 sm:p-2.5 shadow-2xs">
        <ResponsiveFilterBar
          activeFilterCount={activeFiltersCount}
          searchWrapperClassName="min-w-[140px] max-w-[200px] xl:max-w-[240px] flex-1 shrink"
          onReset={handleClearFilters}
          resetLabel="Clear Filters"
          searchInput={
            <div className="relative w-full">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                value={searchTerm}
                onChange={event => setSearchTerm(event.target.value)}
                placeholder="Search PO, party..."
                className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50/50 pl-8 pr-3 text-xs font-semibold text-slate-800 placeholder-slate-400 outline-none transition-all focus:border-[#12335f] focus:bg-white focus:ring-2 focus:ring-[#12335f]/10 shadow-inner"
              />
            </div>
          }
          filters={
            <>
              {/* Status */}
              <div className="w-full">
                <select
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value)}
                  className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 outline-none hover:border-slate-300 focus:border-[#12335f] focus:ring-2 focus:ring-[#12335f]/10 transition-colors shadow-2xs cursor-pointer truncate"
                >
                  <option value="All Statuses">Status: All</option>
                  {uniqueStatuses.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              
              {/* Party */}
              <div className="w-full">
                <select
                  value={partyFilter}
                  onChange={e => setPartyFilter(e.target.value)}
                  className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 outline-none hover:border-slate-300 focus:border-[#12335f] focus:ring-2 focus:ring-[#12335f]/10 transition-colors shadow-2xs cursor-pointer truncate"
                >
                  <option value="All Parties">Party: All</option>
                  {uniqueParties.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>

              {/* Value */}
              <div className="w-full">
                <select
                  value={valueFilter}
                  onChange={e => setValueFilter(e.target.value)}
                  className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 outline-none hover:border-slate-300 focus:border-[#12335f] focus:ring-2 focus:ring-[#12335f]/10 transition-colors shadow-2xs cursor-pointer truncate"
                >
                  <option value="All Values">Value: All</option>
                  <option value="Below ₹10,000">Below ₹10k</option>
                  <option value="₹10,000 – ₹50,000">₹10k–50k</option>
                  <option value="₹50,000 – ₹1,00,000">₹50k–1L</option>
                  <option value="Above ₹1,00,000">Above ₹1L</option>
                </select>
              </div>

              {/* Expected */}
              <div className="w-full">
                <select
                  value={expectedDateFilter}
                  onChange={e => setExpectedDateFilter(e.target.value)}
                  className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 outline-none hover:border-slate-300 focus:border-[#12335f] focus:ring-2 focus:ring-[#12335f]/10 transition-colors shadow-2xs cursor-pointer truncate"
                >
                  <option value="All Dates">Expected: All</option>
                  <option value="Upcoming">Upcoming</option>
                  <option value="Overdue">Overdue</option>
                  <option value="Custom Date Range">Custom Range</option>
                </select>
              </div>
              
              {expectedDateFilter === 'Custom Date Range' && (
                <div data-composite="true" className="col-span-2 flex items-center gap-1.5 w-full min-w-0">
                  <div className="flex-1 min-w-0">
                    <DateTimePicker
                      mode="date"
                      size="sm"
                      value={expectedDateCustom.start}
                      onChange={val => setExpectedDateCustom({ ...expectedDateCustom, start: val })}
                      placeholder="Start date"
                    />
                  </div>
                  <span className="text-slate-400 font-bold shrink-0">-</span>
                  <div className="flex-1 min-w-0">
                    <DateTimePicker
                      mode="date"
                      size="sm"
                      value={expectedDateCustom.end}
                      min={expectedDateCustom.start}
                      onChange={val => setExpectedDateCustom({ ...expectedDateCustom, end: val })}
                      placeholder="End date"
                    />
                  </div>
                </div>
              )}

              {/* Updated Date */}
              <div data-composite="true" className="col-span-2 flex items-center gap-1.5 w-full min-w-0">
                <div className="flex-1 min-w-0">
                  <DateTimePicker
                    mode="date"
                    size="sm"
                    value={updatedDateFilter.start}
                    onChange={val => setUpdatedDateFilter({ ...updatedDateFilter, start: val })}
                    placeholder="Updated from"
                  />
                </div>
                <span className="text-slate-300 font-black shrink-0">-</span>
                <div className="flex-1 min-w-0">
                  <DateTimePicker
                    mode="date"
                    size="sm"
                    value={updatedDateFilter.end}
                    min={updatedDateFilter.start}
                    onChange={val => setUpdatedDateFilter({ ...updatedDateFilter, end: val })}
                    placeholder="Updated to"
                  />
                </div>
              </div>
            </>
          }
          viewToggle={<ViewModeToggle value={viewMode} onChange={setViewMode} size="sm" />}
        />
      </div>

      {(loading || refreshing) && (!allOrders || allOrders.length === 0) ? (
        viewMode === 'grid' ? <GridCardSkeleton count={6} /> : <TableSkeleton rows={8} cols={7} />
      ) : error ? (
        <div className="p-8 text-center text-red-500">
          <ShieldCheck className="mx-auto h-12 w-12 opacity-50 mb-4" />
          <p>Failed to load orders.</p>
        </div>
      ) : visibleOrders.length === 0 ? (
        <EmptyState
          title="No purchase orders"
          description={searchTerm || activeTab !== 'All' ? 'No purchase orders match the current search, status tab, or sorting filters.' : 'No purchase orders have been generated from procurement awards yet.'}
        />
      ) : viewMode === 'grid' ? (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {visibleOrders.map((order, index) => {
              const rowIndex = (page - 1) * pageSize + index + 1;
              return (
                <div
                  key={order.id}
                  className="group rounded-2xl border border-slate-200/85 bg-white p-4 shadow-sm transition hover:border-[#12335f]/40 hover:shadow-md flex flex-col justify-between"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-slate-100 font-mono text-[9px] font-black text-slate-500">
                            {String(rowIndex).padStart(2, '0')}
                          </span>
                          <EntityIdLink label={order.poNumber} id={order.id} size="sm" onClick={() => setViewingOrder(order)} />
                        </div>
                        <h3 title={order.title} className="mt-2 line-clamp-2 text-sm font-black leading-snug text-slate-900 group-hover:text-[#12335f] transition-colors">{order.title}</h3>
                      </div>
                      <StatusPill status={order.status} />
                    </div>

                    <div className="grid grid-cols-2 gap-2.5 text-[10px] font-semibold text-slate-500 pt-1">
                      <InfoTile label="Party" value={order.seller?.name || order.seller?.email || `Seller #${order.sellerId || '-'}`} />
                      <InfoTile label="Value" value={formatCurrency(order.amount || order.totalValue)} />
                      <InfoTile label="Expected" value={formatDate(order.expectedDelivery)} />
                      <InfoTile label="Created" value={formatDate(order.createdAt)} />
                    </div>

                    {(order.paymentTerms || order.deliveryType) && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {order.paymentTerms && <span className="rounded bg-teal-50 px-2 py-0.5 text-[9px] font-black uppercase text-teal-700">{readableStatus(order.paymentTerms)}</span>}
                        {order.deliveryType && <span className="rounded bg-blue-50 px-2 py-0.5 text-[9px] font-black uppercase text-blue-700">{readableStatus(order.deliveryType)}</span>}
                      </div>
                    )}
                  </div>

                  <div className="mt-4 border-t border-slate-100 pt-3">
                    {renderOrderActions(order)}
                  </div>
                </div>
              );
            })}
          </div>
          <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} onPageSizeChange={setPageSize} label="orders" />
        </div>
      ) : (
        <DataTable<PurchaseOrderDto>
          data={visibleOrders}
          columns={poColumns}
          keyExtractor={(order) => order.id}
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          paginationLabel="orders"
          showSrNo={true}
          srNoWidth="w-[50px]"
          minWidth="min-w-[1120px] w-full"
        />
      )}

      {confirming && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-black text-slate-950 capitalize">Confirm {confirming.action}</h3>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="text-slate-400 hover:text-slate-600 transition-colors"
                aria-label="Close dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-3 text-sm font-semibold text-slate-500">Apply this action to {confirming.order.poNumber}?</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirming(null)}>No</Button>
              <Button onClick={completeAction} className="bg-[#12335f] text-white">Yes, continue</Button>
            </div>
          </div>
        </div>
      )}

      {rejectingOrder && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm animate-in fade-in duration-150"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reject-po-title"
          aria-describedby="reject-po-desc"
        >
          <FocusTrap onEscape={() => !isSubmittingReject && setRejectingOrder(null)} className="w-full max-w-md">
            <div className="w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl animate-in zoom-in-95 duration-150 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-50 text-rose-600 border border-rose-100">
                    <XCircle className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div>
                    <h3 id="reject-po-title" className="text-base font-black text-slate-900">
                      Reject Purchase Order
                    </h3>
                    <p id="reject-po-desc" className="text-[11px] font-semibold text-slate-500">
                      {rejectingOrder.poNumber || `PO #${rejectingOrder.id}`}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setRejectingOrder(null)}
                  disabled={isSubmittingReject}
                  className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                  aria-label="Close dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <p className="text-xs text-slate-600 leading-relaxed">
                Are you sure you want to reject this purchase order? Once rejected, this order will be marked as rejected.
              </p>

              <div className="space-y-1.5">
                <label htmlFor="po-rejection-reason" className="block text-xs font-bold text-slate-700">
                  Reason for Rejection <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <textarea
                  id="po-rejection-reason"
                  rows={3}
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="e.g. Inability to meet delivery timeline, inventory stockout, pricing discrepancy..."
                  className="w-full rounded-xl border border-slate-200 p-2.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100 outline-none transition-all resize-none"
                  disabled={isSubmittingReject}
                />
              </div>

              <div className="flex justify-end items-center gap-2.5 pt-2 border-t border-slate-100">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setRejectingOrder(null)}
                  disabled={isSubmittingReject}
                  className="h-9 px-4 text-xs font-bold rounded-xl"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={confirmRejectOrder}
                  disabled={isSubmittingReject}
                  className="h-9 px-4 text-xs font-black uppercase tracking-wider bg-rose-600 hover:bg-rose-700 text-white rounded-xl shadow-xs flex items-center gap-1.5"
                >
                  {isSubmittingReject ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      <span>Rejecting...</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-3.5 w-3.5" />
                      <span>Reject PO</span>
                    </>
                  )}
                </Button>
              </div>
            </div>
          </FocusTrap>
        </div>
      )}

      {recallingOrder && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm animate-in fade-in duration-150"
          role="dialog"
          aria-modal="true"
          aria-labelledby="recall-po-title"
          aria-describedby="recall-po-desc"
        >
          <FocusTrap onEscape={() => !isSubmittingRecall && setRecallingOrder(null)} className="w-full max-w-md">
            <div className="w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl animate-in zoom-in-95 duration-150 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50 text-amber-600 border border-amber-100">
                    <Undo2 className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div>
                    <h3 id="recall-po-title" className="text-base font-black text-slate-900">
                      Recall Purchase Order
                    </h3>
                    <p id="recall-po-desc" className="text-[11px] font-semibold text-slate-500">
                      {recallingOrder.poNumber || `PO #${recallingOrder.id}`}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setRecallingOrder(null)}
                  disabled={isSubmittingRecall}
                  className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                  aria-label="Close dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="rounded-xl bg-amber-50/70 border border-amber-200/80 p-3 text-xs text-amber-900 leading-relaxed space-y-1">
                <p className="font-bold flex items-center gap-1.5 text-amber-800">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  Retract to Draft for Editing
                </p>
                <p className="text-[11px] text-amber-700">
                  This purchase order is currently pending supplier acceptance. Recalling it will retract it to Draft mode so you can update line items, dates, terms, or PDF attachments, and then re-issue cleanly.
                </p>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="po-recall-reason" className="block text-xs font-bold text-slate-700">
                  Reason for Recall <span className="text-slate-400 font-normal">(optional audit note)</span>
                </label>
                <textarea
                  id="po-recall-reason"
                  rows={2}
                  value={recallReason}
                  onChange={(e) => setRecallReason(e.target.value)}
                  placeholder="e.g. Need to adjust delivery date, clerical error in line items..."
                  className="w-full rounded-xl border border-slate-200 p-2.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-amber-400 focus:ring-2 focus:ring-amber-100 outline-none transition-all resize-none"
                  disabled={isSubmittingRecall}
                />
              </div>

              <div className="flex justify-end items-center gap-2.5 pt-2 border-t border-slate-100">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setRecallingOrder(null)}
                  disabled={isSubmittingRecall}
                  className="h-9 px-4 text-xs font-bold rounded-xl"
                >
                  Keep Issued
                </Button>
                <Button
                  type="button"
                  onClick={confirmRecallPo}
                  disabled={isSubmittingRecall}
                  className="h-9 px-4 text-xs font-black uppercase tracking-wider bg-amber-600 hover:bg-amber-700 text-white rounded-xl shadow-xs flex items-center gap-1.5 cursor-pointer"
                >
                  {isSubmittingRecall ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      <span>Recalling...</span>
                    </>
                  ) : (
                    <>
                      <Undo2 className="h-3.5 w-3.5" />
                      <span>Recall &amp; Edit</span>
                    </>
                  )}
                </Button>
              </div>
            </div>
          </FocusTrap>
        </div>
      )}

      {viewingOrder && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 sm:p-4 backdrop-blur-md animate-in fade-in duration-200"
          role="dialog"
          aria-modal="true"
          aria-labelledby="po-modal-title"
        >
          <FocusTrap onEscape={() => setViewingOrder(null)}>
            <div className="max-h-[92vh] w-full max-w-5xl xl:max-w-6xl overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-2xl flex flex-col animate-in zoom-in-95 duration-200">
              
              {/* Compact Sleek Header */}
              <div className="relative bg-gradient-to-r from-slate-950 via-slate-900 to-[#12335f] text-white px-5 py-3.5 sm:px-6 shrink-0 border-b border-slate-800/80 shadow-xs">
                <div className="flex items-center justify-between gap-3">
                  {/* Left: Badge, PO Number, and Status */}
                  <div className="flex items-center gap-2.5 sm:gap-3.5 min-w-0 flex-wrap">
                    <div className="flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-300 border border-white/10 backdrop-blur-xs shrink-0">
                      <FileText className="h-3 w-3 text-blue-400" />
                      <span>PO Details</span>
                    </div>
                    
                    <div className="flex items-center gap-1.5 min-w-0">
                      <h2 id="po-modal-title" className="text-base sm:text-lg font-bold font-mono tracking-tight text-white truncate">
                        {viewingOrder.poNumber}
                      </h2>
                      <button
                        type="button"
                        onClick={() => {
                          if (viewingOrder.poNumber) {
                            navigator.clipboard.writeText(viewingOrder.poNumber);
                            toast.success('PO Number copied to clipboard');
                          }
                        }}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer shrink-0"
                        title="Copy PO Number"
                        aria-label="Copy PO Number"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {/* Inline Status Pill */}
                    <span className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] sm:text-xs font-bold uppercase tracking-wider border shrink-0",
                      ['delivered', 'completed', 'accepted'].includes(String(viewingOrder.status || '').toLowerCase())
                        ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                        : ['cancelled', 'rejected'].includes(String(viewingOrder.status || '').toLowerCase())
                        ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
                        : "bg-blue-500/15 text-blue-300 border-blue-500/30"
                    )}>
                      <span className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        ['delivered', 'completed', 'accepted'].includes(String(viewingOrder.status || '').toLowerCase())
                          ? "bg-emerald-400 animate-pulse"
                          : ['cancelled', 'rejected'].includes(String(viewingOrder.status || '').toLowerCase())
                          ? "bg-rose-400"
                          : "bg-blue-400 animate-pulse"
                      )} />
                      {readableStatus(viewingOrder.status)}
                    </span>
                  </div>

                  {/* Right Side: Total Amount & Close */}
                  <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
                    <div className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-1 border border-white/10 backdrop-blur-xs">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-300 hidden md:inline">Total:</span>
                      <span className="text-sm sm:text-base font-bold text-white font-mono">{formatCurrency(viewingOrder.amount || viewingOrder.totalValue)}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setViewingOrder(null)}
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-slate-300 hover:bg-white/20 hover:text-white transition-all border border-white/15 shadow-2xs cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400"
                      aria-label="Close PO Details"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Modal Body */}
              <div className="overflow-y-auto p-4 sm:p-5 space-y-4 sm:space-y-5 flex-1 bg-slate-50/60">
                
                {/* Order Overview Bar */}
                <div className="rounded-xl bg-white p-4 border border-slate-200/80 shadow-2xs space-y-2.5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 block mb-0.5">Order Title & Reference</span>
                      <h3 className="text-sm sm:text-base font-bold text-slate-900 leading-snug">{viewingOrder.title}</h3>
                    </div>

                    <div className="flex items-center gap-2.5 shrink-0">
                      {(() => {
                        const tenderRef = (viewingOrder as any).tender?.tenderId || (viewingOrder as any).tender?.id || viewingOrder.tenderId || (viewingOrder as any).bidId;
                        const targetUrl = tenderRef ? `/bids/${tenderRef}` : '/buyer/my-procurements';
                        return (
                          <button
                            type="button"
                            onClick={() => {
                              setViewingOrder(null);
                              router.push(targetUrl);
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50/80 hover:bg-blue-100 hover:border-blue-300 px-3 py-1.5 text-xs font-bold text-blue-800 transition-colors shadow-2xs cursor-pointer"
                            title="View associated procurement requirement & tender details"
                          >
                            <ExternalLink className="h-3.5 w-3.5 text-blue-600" />
                            <span>Procurement Details</span>
                          </button>
                        );
                      })()}

                      <div className="sm:hidden text-right shrink-0">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 block">Total</span>
                        <span className="text-xs font-bold text-slate-900 font-mono">{formatCurrency(viewingOrder.amount || viewingOrder.totalValue)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2.5">
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600">
                      <Calendar className="h-3 w-3 text-slate-400" />
                      Created: {formatDate(viewingOrder.createdAt)}
                    </span>

                    {viewingOrder.paymentTerms && (
                      <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700">
                        <CreditCard className="h-3 w-3 text-slate-500" />
                        Payment: {readableStatus(viewingOrder.paymentTerms)}
                      </span>
                    )}

                    {viewingOrder.deliveryType && (
                      <span className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50/70 px-2.5 py-1 text-xs font-semibold text-blue-800">
                        <Truck className="h-3 w-3 text-blue-600" />
                        Delivery: {readableStatus(viewingOrder.deliveryType)}
                      </span>
                    )}

                    {Boolean((viewingOrder as any).tender?.tenderId || viewingOrder.tenderId) && (
                      <button
                        type="button"
                        onClick={() => {
                          const tId = (viewingOrder as any).tender?.tenderId || (viewingOrder as any).tender?.id || viewingOrder.tenderId;
                          setViewingOrder(null);
                          router.push(`/bids/${tId}`);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50/70 hover:bg-indigo-100 px-2.5 py-1 text-xs font-semibold text-indigo-800 transition-colors cursor-pointer"
                      >
                        <FileText className="h-3 w-3 text-indigo-600" />
                        <span>Procurement: {(viewingOrder as any).tender?.tenderId || `TND-${viewingOrder.tenderId}`}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Amendment Pending Review Alert & Comparison Card */}
                {(() => {
                  const isAmendmentPending = String((viewingOrder as any).poStatus || viewingOrder.status || '').toLowerCase() === 'amendment_pending';
                  if (!isAmendmentPending) return null;

                  const history = Array.isArray((viewingOrder as any).amendmentHistory) ? (viewingOrder as any).amendmentHistory : [];
                  const pendingEntry = [...history].reverse().find((h: any) => h.status === 'PENDING') || history[history.length - 1];
                  const proposed = pendingEntry?.proposedChanges || {};
                  const base = pendingEntry?.baseValues || {};

                  return (
                    <div className="rounded-2xl border-2 border-amber-300 bg-amber-50/60 p-4 sm:p-5 shadow-sm space-y-3.5 animate-in fade-in">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-white shadow-2xs">
                            <AlertCircle className="h-5 w-5" />
                          </span>
                          <div>
                            <h4 className="text-xs font-black uppercase tracking-wider text-amber-950">
                              PO Amendment Proposal (V{pendingEntry?.version || 2}) Pending Review
                            </h4>
                            <p className="text-[11px] font-semibold text-amber-800">
                              Proposed on {pendingEntry?.proposedAt ? formatDate(pendingEntry.proposedAt) : 'Recently'} • Awaiting Supplier Decision
                            </p>
                          </div>
                        </div>
                        {pendingEntry?.integrityChecksum && (
                          <span className="font-mono text-[9px] font-bold text-amber-700 bg-amber-100/80 px-2 py-1 rounded border border-amber-300" title={`SHA-256 Checksum: ${pendingEntry.integrityChecksum}`}>
                            SHA-256 Sealed: {String(pendingEntry.integrityChecksum).slice(0, 10)}...
                          </span>
                        )}
                      </div>

                      {pendingEntry?.reason && (
                        <div className="rounded-xl bg-white/90 border border-amber-200 p-3 text-xs">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-amber-800 block mb-0.5">Buyer Reason:</span>
                          <p className="font-medium text-slate-800 italic">"{pendingEntry.reason}"</p>
                        </div>
                      )}

                      {/* Header-Level Diffs */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                        {proposed.expectedDelivery && (
                          <div className="rounded-xl bg-white/80 p-2.5 border border-amber-200">
                            <span className="text-[9px] font-bold uppercase text-slate-400 block">Revised Delivery Date:</span>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="line-through text-slate-400 font-mono text-[11px]">{formatDate(base.expectedDelivery || viewingOrder.expectedDelivery)}</span>
                              <span className="font-bold text-emerald-700 font-mono text-[11px]">→ {formatDate(proposed.expectedDelivery)}</span>
                            </div>
                          </div>
                        )}
                        {proposed.paymentTerms && (
                          <div className="rounded-xl bg-white/80 p-2.5 border border-amber-200">
                            <span className="text-[9px] font-bold uppercase text-slate-400 block">Revised Payment Terms:</span>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="line-through text-slate-400 text-[11px]">{base.paymentTerms || viewingOrder.paymentTerms}</span>
                              <span className="font-bold text-emerald-700 text-[11px]">→ {proposed.paymentTerms}</span>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Line Items Proposed Revision Diff */}
                      {proposed.items && Array.isArray(proposed.items) && proposed.items.length > 0 && (
                        <div className="rounded-xl bg-white border border-amber-200 overflow-hidden">
                          <div className="bg-amber-100/70 px-3 py-2 border-b border-amber-200 flex items-center justify-between">
                            <span className="text-[11px] font-black uppercase text-amber-900 flex items-center gap-1.5">
                              <Package className="h-3.5 w-3.5" /> Proposed Line-Item Revisions
                            </span>
                            <div className="flex items-center gap-2 text-xs font-mono">
                              <span className="line-through text-slate-400 font-bold">{formatCurrency(viewingOrder.amount || viewingOrder.totalValue)}</span>
                              <span className="text-emerald-700 font-black">→ {formatCurrency(proposed.totalValue || proposed.amount)}</span>
                            </div>
                          </div>
                          <div className="divide-y divide-slate-100 text-xs">
                            {proposed.items.map((pItem: any, pIdx: number) => (
                              <div key={pIdx} className="p-2.5 flex items-center justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <p className="font-bold text-slate-900 truncate">{pItem.itemName}</p>
                                  <p className="text-[10px] text-slate-500 font-mono">
                                    Qty: {pItem.quantity} {pItem.unitOfMeasure} • Price: {formatCurrency(pItem.unitPrice)} • GST: {pItem.taxRate}%
                                  </p>
                                </div>
                                <span className="font-mono font-bold text-indigo-700 text-xs shrink-0">
                                  {formatCurrency(pItem.totalAmount)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Fulfillment Parties & Settings Grid */}
                <div className="grid gap-4 md:grid-cols-2">
                  
                  {/* Fulfillment Parties Card */}
                  <div className="rounded-xl bg-white p-4 border border-slate-200/80 shadow-2xs space-y-3.5">
                    <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
                      <User className="h-4 w-4 text-[#12335f]" />
                      <h4 className="text-xs font-bold uppercase tracking-wider text-[#12335f]">Fulfillment Parties</h4>
                    </div>

                    <div className="space-y-3">
                      {/* Buyer Info */}
                      {(() => {
                        const buyerObj = (viewingOrder.buyer as any) || {};
                        const buyerOrgDisplay = buyerObj.organization?.organizationName || buyerObj.buyerProfile?.companyName || buyerObj.registrationDetails?.businessName || viewingOrder.buyer?.name || 'MSME Portal Buyer';
                        const buyerLogoUrl = resolveMediaUrl(
                          buyerObj.organization?.profile?.logoUrl ||
                          buyerObj.registrationDetails?.logoUrl ||
                          buyerObj.organization?.logoFile?.url ||
                          (buyerObj.organization?.organizationLogoFileId ? `/api/files/${buyerObj.organization.organizationLogoFileId}/view` : null) ||
                          (viewingOrder.buyerId === user?.id ? (user?.registrationDetails?.logoUrl || (typeof window !== 'undefined' ? localStorage.getItem('msme_invoice_logo') : null)) : null)
                        );
                        return (
                          <div className="flex items-start gap-3 rounded-lg bg-slate-50/80 p-3 border border-slate-200/60">
                            {buyerLogoUrl ? (
                              <img src={buyerLogoUrl} alt="Buyer Logo" className="h-9 w-9 rounded-lg object-contain border border-slate-200 bg-white p-0.5 shrink-0" />
                            ) : (
                              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-800 font-bold text-xs border border-blue-200">
                                BY
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 block">Buyer (Requester)</span>
                              <p className="text-xs font-bold text-slate-900 truncate">
                                {buyerOrgDisplay}
                              </p>
                              {viewingOrder.buyer?.name && viewingOrder.buyer.name !== buyerOrgDisplay && (
                                <p className="text-[10px] font-medium text-slate-600 truncate">Attn: {viewingOrder.buyer.name}</p>
                              )}
                              {(() => {
                                const buyerEmail = (viewingOrder.buyerId === user?.id && user?.email && !user.email.includes('*'))
                                  ? user.email
                                  : (viewingOrder.buyer?.email || (buyerObj as any).email);
                                return buyerEmail ? (
                                  <p className="text-[10px] font-medium text-slate-500 font-mono truncate" title={buyerEmail}>{buyerEmail}</p>
                                ) : null;
                              })()}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Seller Info */}
                      {(() => {
                        const sellerObj = (viewingOrder.seller as any) || {};
                        const sellerOrgDisplay = sellerObj.organization?.organizationName || sellerObj.sellerProfile?.businessName || sellerObj.registrationDetails?.businessName || viewingOrder.seller?.name || viewingOrder.seller?.email || 'MSME Portal Seller';
                        const sellerLogoUrl = resolveMediaUrl(
                          sellerObj.organization?.profile?.logoUrl ||
                          sellerObj.registrationDetails?.logoUrl ||
                          sellerObj.organization?.logoFile?.url ||
                          (sellerObj.organization?.organizationLogoFileId ? `/api/files/${sellerObj.organization.organizationLogoFileId}/view` : null) ||
                          (viewingOrder.sellerId === user?.id ? (user?.registrationDetails?.logoUrl || (typeof window !== 'undefined' ? localStorage.getItem('msme_invoice_logo') : null)) : null)
                        );
                        return (
                          <div className="flex items-start gap-3 rounded-lg bg-slate-50/80 p-3 border border-slate-200/60">
                            {sellerLogoUrl ? (
                              <img src={sellerLogoUrl} alt="Seller Logo" className="h-9 w-9 rounded-lg object-contain border border-slate-200 bg-white p-0.5 shrink-0" />
                            ) : (
                              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-800 font-bold text-xs border border-emerald-200">
                                SL
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 block">Seller (Provider)</span>
                              <p className="text-xs font-bold text-slate-900 truncate">
                                {sellerOrgDisplay}
                              </p>
                              {viewingOrder.seller?.name && viewingOrder.seller.name !== sellerOrgDisplay && (
                                <p className="text-[10px] font-medium text-slate-600 truncate">Contact: {viewingOrder.seller.name}</p>
                              )}
                              {(() => {
                                const sellerEmail = (viewingOrder.sellerId === user?.id && user?.email && !user.email.includes('*'))
                                  ? user.email
                                  : (viewingOrder.seller?.email || (sellerObj as any).email);
                                return sellerEmail ? (
                                  <p className="text-[10px] font-medium text-slate-500 font-mono truncate" title={sellerEmail}>{sellerEmail}</p>
                                ) : null;
                              })()}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Fulfillment Settings Card */}
                  <div className="rounded-xl bg-white p-4 border border-slate-200/80 shadow-2xs space-y-3.5">
                    <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
                      <Calendar className="h-4 w-4 text-[#12335f]" />
                      <h4 className="text-xs font-bold uppercase tracking-wider text-[#12335f]">Fulfillment & Schedule</h4>
                    </div>

                    <div className="space-y-2.5">
                      <div className="flex items-start gap-2.5 rounded-lg bg-slate-50/80 p-3 border border-slate-200/70">
                        <Clock className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
                        <div>
                          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500 block">Expected Delivery Date</span>
                          <p className="text-xs font-bold text-slate-900">{formatDate(viewingOrder.expectedDelivery)}</p>
                        </div>
                      </div>

                      {viewingOrder.deliveryAddress && (
                        <div className="flex items-start gap-2.5 rounded-lg bg-slate-50/80 p-3 border border-slate-200/70">
                          <MapPin className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500 block">Delivery Address</span>
                            <p title={viewingOrder.deliveryAddress} className="text-xs font-medium text-slate-700 leading-relaxed line-clamp-2">
                              {viewingOrder.deliveryAddress}
                            </p>
                          </div>
                        </div>
                      )}

                      {viewingOrder.deliveryTrackings && viewingOrder.deliveryTrackings.length > 0 && (
                        <div className="pt-1">
                          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500 block mb-1.5">Delivery Trackings</span>
                          <div className="flex flex-wrap gap-2">
                            {viewingOrder.deliveryTrackings.map((dt: any) => (
                              <div key={dt.id} className="inline-flex items-center gap-2 rounded-lg bg-slate-100 border border-slate-200 px-2.5 py-1">
                                <EntityIdLink
                                  label={dt.trackingNumber || `DLV-${dt.id}`}
                                  id={dt.id}
                                  size="sm"
                                  onClick={() => {
                                    setViewingOrder(null);
                                    if (dt.id) {
                                      router.push(`/delivery/${dt.id}`);
                                    } else if (isSeller) {
                                      router.push(`/seller/delivery-management?search=${encodeURIComponent(viewingOrder.poNumber || `DLV-${dt.id}`)}`);
                                    } else {
                                      router.push(`/orders/tracking?search=${encodeURIComponent(viewingOrder.poNumber || `DLV-${dt.id}`)}`);
                                    }
                                  }}
                                />
                                <span className="text-[10px] font-bold text-slate-600 uppercase">({readableStatus(dt.status || 'pending')})</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                </div>

                {/* Shipment Tracking & Delivery Progress Card */}
                {(() => {
                  const deliveryStatusRaw = String(activeDelivery?.status || viewingOrder.status || 'pending').toLowerCase();
                  
                  // Determine milestone step (1 to 5)
                  let stepNumber = 1;
                  let stepStatusLabel = 'Order Placed';
                  let stepStatusTone = 'bg-blue-50 text-blue-800 border-blue-200';

                  if (['delivered', 'completed'].includes(deliveryStatusRaw)) {
                    stepNumber = 5;
                    stepStatusLabel = 'Delivered';
                    stepStatusTone = 'bg-emerald-50 text-emerald-800 border-emerald-200';
                  } else if (['out_for_delivery'].includes(deliveryStatusRaw)) {
                    stepNumber = 4;
                    stepStatusLabel = 'Out for Delivery';
                    stepStatusTone = 'bg-indigo-50 text-indigo-800 border-indigo-200';
                  } else if (['in_transit', 'dispatched', 'picked_up', 'at_hub'].includes(deliveryStatusRaw)) {
                    stepNumber = 3;
                    stepStatusLabel = 'In Transit';
                    stepStatusTone = 'bg-blue-50 text-blue-800 border-blue-200';
                  } else if (['ready_for_pickup', 'packed', 'pickup_scheduled', 'accepted', 'in_fulfillment'].includes(deliveryStatusRaw)) {
                    stepNumber = 2;
                    stepStatusLabel = 'Ready / Packed';
                    stepStatusTone = 'bg-sky-50 text-sky-800 border-sky-200';
                  } else if (['cancelled', 'rejected'].includes(deliveryStatusRaw)) {
                    stepNumber = 1;
                    stepStatusLabel = 'Cancelled';
                    stepStatusTone = 'bg-rose-50 text-rose-800 border-rose-200';
                  } else {
                    stepNumber = 1;
                    stepStatusLabel = readableStatus(activeDelivery?.status || viewingOrder.status || 'pending');
                    stepStatusTone = 'bg-slate-100 text-slate-800 border-slate-200';
                  }

                  const milestones = [
                    { step: 1, title: 'Order Placed', desc: formatDate(viewingOrder.createdAt) },
                    { step: 2, title: 'Packed & Ready', desc: activeDelivery?.packedAt ? formatDate(activeDelivery.packedAt) : 'Warehouse' },
                    { step: 3, title: 'In Transit', desc: activeDelivery?.pickedUpAt ? formatDate(activeDelivery.pickedUpAt) : 'Carrier dispatch' },
                    { step: 4, title: 'Out for Delivery', desc: 'Last mile handover' },
                    { step: 5, title: 'Delivered', desc: activeDelivery?.actualDelivery ? formatDate(activeDelivery.actualDelivery) : formatDate(activeDelivery?.expectedDelivery || viewingOrder.expectedDelivery) },
                  ];

                  const progressWidthPercent = Math.min(100, Math.max(0, ((stepNumber - 1) / 4) * 100));

                  const trackingNumber = activeDelivery?.trackingNumber || (viewingOrder.deliveryTrackings && viewingOrder.deliveryTrackings.length > 0 ? viewingOrder.deliveryTrackings[0]?.trackingNumber : null);
                  const carrierName = activeDelivery?.carrierName || activeDelivery?.logisticsPartnerName || (trackingNumber ? 'Standard Courier Partner' : 'Awaiting Seller Assignment');
                  const arrivalDate = formatDate(activeDelivery?.expectedDelivery || viewingOrder.expectedDelivery);
                  const locationText = activeDelivery?.currentLocation || (stepNumber === 5 ? 'Delivered to Consignee' : stepNumber >= 3 ? 'In Transit to Destination' : 'Seller Fulfillment Center');

                  return (
                    <div className="rounded-xl border border-slate-200/90 bg-white p-4 sm:p-5 space-y-4 shadow-2xs">
                      {/* Header */}
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white shadow-2xs">
                            <Truck className="h-4 w-4" />
                          </div>
                          <div>
                            <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                              Shipment Tracking & Delivery Progress
                            </h4>
                            <p className="text-[11px] font-medium text-slate-500">Live dispatch and tracking status</p>
                          </div>
                        </div>
                        <span className={cn("rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-wider", stepStatusTone)}>
                          {stepStatusLabel}
                        </span>
                      </div>

                      {/* Visual Progress Stepper */}
                      <div className="bg-slate-50/70 rounded-xl p-4 border border-slate-200/70 shadow-2xs">
                        <div className="relative">
                          {/* Connecting Track Background */}
                          <div className="absolute top-4 left-6 right-6 h-1 bg-slate-200 rounded-full" />
                          {/* Active Progress Bar */}
                          <div
                            className="absolute top-4 left-6 h-1 bg-emerald-500 rounded-full transition-all duration-500"
                            style={{ width: `calc(${progressWidthPercent}% * (100% - 48px) / 100)` }}
                          />

                          {/* Milestones Nodes */}
                          <div className="relative flex justify-between items-start">
                            {milestones.map((m) => {
                              const isCompleted = m.step < stepNumber || (m.step === 5 && stepNumber === 5);
                              const isCurrent = m.step === stepNumber && stepNumber !== 5;
                              const isUpcoming = m.step > stepNumber;

                              return (
                                <div key={m.step} className="flex flex-col items-center text-center max-w-[70px] sm:max-w-[100px]">
                                  <div
                                    className={cn(
                                      "flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-all shadow-2xs",
                                      isCompleted && "bg-emerald-500 text-white ring-4 ring-emerald-50",
                                      isCurrent && "bg-slate-900 text-white ring-4 ring-slate-100 ring-offset-1 ring-offset-white",
                                      isUpcoming && "bg-slate-100 text-slate-400 border border-slate-300"
                                    )}
                                  >
                                    {isCompleted ? (
                                      <CheckCircle2 className="h-4 w-4" />
                                    ) : isCurrent ? (
                                      <Truck className="h-3.5 w-3.5 animate-pulse" />
                                    ) : (
                                      <span className="font-mono text-[11px]">{m.step}</span>
                                    )}
                                  </div>
                                  <span
                                    className={cn(
                                      "mt-2 text-[10px] sm:text-[11px] font-bold leading-tight",
                                      isCompleted ? "text-slate-800" : isCurrent ? "text-slate-900 font-black" : "text-slate-400"
                                    )}
                                  >
                                    {m.title}
                                  </span>
                                  <span className="text-[9px] text-slate-500 hidden sm:block mt-0.5 font-medium truncate max-w-full">
                                    {m.desc}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>

                      {/* Consignment Meta Grid */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 bg-slate-50/70 rounded-xl p-3 border border-slate-200/70 text-xs">
                        <div>
                          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500 block mb-0.5">Carrier Partner</span>
                          <div className="flex items-center gap-1.5">
                            <Building2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                            <p className="font-bold text-slate-800 truncate" title={carrierName}>{carrierName}</p>
                          </div>
                        </div>

                        <div>
                          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500 block mb-0.5">Tracking Number / AWB</span>
                          <div className="flex items-center gap-1.5">
                            <span className={cn("font-mono font-bold truncate", trackingNumber ? "text-slate-900" : "text-slate-500 italic")}>
                              {trackingNumber || 'Pending Waybill'}
                            </span>
                            {trackingNumber && (
                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard.writeText(trackingNumber);
                                  toast.success('Tracking number copied to clipboard');
                                }}
                                className="text-slate-400 hover:text-slate-700 p-0.5 cursor-pointer rounded hover:bg-slate-200 transition-colors"
                                title="Copy Tracking Number"
                                aria-label="Copy Tracking Number"
                              >
                                <Copy className="h-3 w-3" aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        </div>

                        <div>
                          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500 block mb-0.5">Expected Arrival</span>
                          <div className="flex items-center gap-1.5">
                            <Calendar className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                            <p className="font-bold text-slate-800">{arrivalDate}</p>
                          </div>
                        </div>

                        <div>
                          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500 block mb-0.5">Current Location</span>
                          <div className="flex items-center gap-1.5">
                            <MapPin className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                            <p className="font-bold text-slate-800 truncate" title={locationText}>{locationText}</p>
                          </div>
                        </div>
                      </div>

                      {/* Track Details Action Button */}
                      <Button 
                        size="sm"
                        className="w-full bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold uppercase tracking-wider h-9 rounded-lg shadow-2xs transition-colors flex items-center justify-center gap-2 cursor-pointer"
                        onClick={() => {
                          setViewingOrder(null);
                          const activeDlvId = activeDelivery?.id || (viewingOrder.deliveryTrackings && viewingOrder.deliveryTrackings[0]?.id);
                          if (activeDlvId) {
                            router.push(`/delivery/${activeDlvId}`);
                          } else if (isSeller) {
                            router.push(`/seller/delivery-management?search=${encodeURIComponent(viewingOrder.poNumber || '')}`);
                          } else {
                            router.push(`/orders/tracking?search=${encodeURIComponent(viewingOrder.poNumber || '')}`);
                          }
                        }}
                      >
                        <Truck className="h-3.5 w-3.5" /> Track Shipment Details
                      </Button>
                    </div>
                  );
                })()}

                {/* Workflow Timeline Section */}
                <div className="rounded-xl bg-white p-4 sm:p-5 border border-slate-200/80 shadow-2xs space-y-3.5">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-[#12335f]" />
                      <h4 className="text-xs font-bold uppercase tracking-wider text-[#12335f]">Workflow Tracking & Timestamps</h4>
                    </div>
                    <span className="text-[10px] font-medium text-slate-500">Order Lifecycle Audit</span>
                  </div>

                  <div className="relative border-l-2 border-slate-200 pl-6 ml-3 space-y-4 py-1">
                    {/* Step 1: PO Generated */}
                    <div className="relative">
                      <span className="absolute -left-[31px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 ring-4 ring-emerald-50 text-white shadow-2xs">
                        <CheckCircle2 className="h-3 w-3" />
                      </span>
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                        <span className="text-xs font-bold text-slate-900">Purchase Order Generated</span>
                        <span className="text-[10px] font-mono font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-md">{formatTimestamp(viewingOrder.createdAt)}</span>
                      </div>
                      <p className="text-[11px] font-medium text-slate-500 mt-0.5">PO record successfully created from procurement bidding workflow.</p>
                    </div>

                    {/* Step 2: PO Acknowledged */}
                    {(() => {
                      const viewingStatusLower = String(viewingOrder.status || '').toLowerCase();
                      return viewingStatusLower !== 'generated' && viewingStatusLower !== 'order_placed' && viewingStatusLower !== 'cancelled' && (
                        <div className="relative">
                          <span className="absolute -left-[31px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 ring-4 ring-emerald-50 text-white shadow-2xs">
                            <CheckCircle2 className="h-3 w-3" />
                          </span>
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                            <span className="text-xs font-bold text-slate-900">PO Acknowledged by Seller</span>
                            <span className="text-[10px] font-mono font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-md">
                              {viewingOrder.acceptedAt ? formatTimestamp(viewingOrder.acceptedAt) : 'Acknowledged'}
                            </span>
                          </div>
                          <p className="text-[11px] font-medium text-slate-500 mt-0.5">Seller acknowledged and committed to fulfilling this order.</p>
                        </div>
                      );
                    })()}

                    {/* Step 3: Delivered */}
                    {viewingOrder.status === 'delivered' && (
                      <div className="relative">
                        <span className="absolute -left-[31px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 ring-4 ring-emerald-50 text-white shadow-2xs">
                          <CheckCircle2 className="h-3 w-3" />
                        </span>
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                          <span className="text-xs font-bold text-slate-900">Delivered & Completed</span>
                          <span className="text-[10px] font-mono font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">Completed</span>
                        </div>
                        <p className="text-[11px] font-medium text-slate-500 mt-0.5">Consignment has been safely delivered and confirmed by buyer.</p>
                      </div>
                    )}

                    {/* Step 4: Cancelled */}
                    {viewingOrder.status === 'cancelled' && (
                      <div className="relative">
                        <span className="absolute -left-[31px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 ring-4 ring-rose-50 text-white shadow-2xs">
                          <XCircle className="h-3 w-3" />
                        </span>
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                          <span className="text-xs font-bold text-rose-700">Order Cancelled</span>
                          <span className="text-[10px] font-mono font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-md border border-rose-200">Cancelled</span>
                        </div>
                        <p className="text-[11px] font-medium text-rose-500 mt-0.5">Fulfillment terminated by one of the parties.</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Terms & Documents section */}
                {(() => {
                  const meta = (viewingOrder.metadata as any) || {};
                  const terms = meta.termsDocuments || {};
                  const docs = (Array.isArray(terms.documents) ? terms.documents : []) as Array<{
                    documentType: string;
                    fileAssetId: number;
                    fileName: string;
                    fileSize: number;
                  }>;
                  
                  const deliveryTerms = terms.deliveryTerms || meta.deliveryTerms;
                  const paymentTerms = terms.paymentTerms || meta.paymentTerms || viewingOrder.paymentTerms;
                  const warrantyTerms = terms.warrantyTerms || meta.warrantyTerms;
                  const inspectionTerms = terms.inspectionTerms || meta.inspectionTerms;
                  const delayPenaltyDetails = terms.delayPenaltyDetails || meta.ldTerms || meta.penaltyClause;
                  const additionalTerms = terms.additionalTerms || meta.additionalTerms;

                  const hasTerms = deliveryTerms || paymentTerms || warrantyTerms || inspectionTerms || delayPenaltyDetails || additionalTerms;
                  const hasDocs = docs.length > 0;

                  if (!hasTerms && !hasDocs) return null;

                  return (
                    <div className="rounded-xl bg-white p-4 sm:p-5 border border-slate-200/80 shadow-2xs space-y-3.5">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-[#12335f]" />
                          <h4 className="text-xs font-bold uppercase tracking-wider text-[#12335f]">Procurement Terms & Documents</h4>
                        </div>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2 text-xs">
                        {hasTerms && (
                          <div className="space-y-2">
                            {deliveryTerms && <div><p className="text-[9px] font-bold uppercase text-slate-500">Delivery Terms</p><p className="font-semibold text-slate-800">{deliveryTerms}</p></div>}
                            {paymentTerms && <div><p className="text-[9px] font-bold uppercase text-slate-500">Payment Terms</p><p className="font-semibold text-slate-800">{paymentTerms}</p></div>}
                            {warrantyTerms && <div><p className="text-[9px] font-bold uppercase text-slate-500">Warranty Terms</p><p className="font-semibold text-slate-800">{warrantyTerms}</p></div>}
                            {inspectionTerms && <div><p className="text-[9px] font-bold uppercase text-slate-500">Inspection Terms</p><p className="font-semibold text-slate-800">{inspectionTerms}</p></div>}
                            {delayPenaltyDetails && <div><p className="text-[9px] font-bold uppercase text-slate-500">Delay Penalty (LD)</p><p className="font-semibold text-slate-800">{delayPenaltyDetails}</p></div>}
                            {additionalTerms && <div><p className="text-[9px] font-bold uppercase text-slate-500">Additional Terms</p><p className="font-semibold text-slate-800">{additionalTerms}</p></div>}
                          </div>
                        )}
                        {hasDocs && (
                          <div className="space-y-2">
                            <p className="text-[9px] font-bold uppercase text-slate-500">Uploaded Procurement Documents</p>
                            <div className="space-y-2">
                              {docs.map((doc, dIdx) => (
                                <div key={dIdx} className="flex items-center gap-3 rounded-lg bg-slate-50/80 border border-slate-200/80 p-2.5 hover:border-slate-300 transition-all">
                                  <FileText className="h-4 w-4 shrink-0 text-[#12335f]" />
                                  <div className="min-w-0 flex-1">
                                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{doc.documentType}</p>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        openFileAsset({
                                          id: doc.fileAssetId,
                                          fileAssetId: doc.fileAssetId,
                                          originalName: doc.fileName,
                                        }, doc.fileName).catch(err => {
                                          toast.error(err instanceof Error ? err.message : 'Unable to open document');
                                        });
                                      }}
                                      title={doc.fileName}
                                      className="block truncate text-xs font-bold text-[#12335f] hover:underline text-left w-full cursor-pointer"
                                    >
                                      {doc.fileName}
                                    </button>
                                  </div>
                                  <span className="text-[10px] font-bold text-slate-500 shrink-0 font-mono">({(doc.fileSize / 1024).toFixed(0)} KB)</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Line Items Table Section - Responsive with Zero Horizontal Scroll */}
                <div className="rounded-xl bg-white border border-slate-200/80 shadow-2xs overflow-hidden space-y-0">
                  <div className="flex items-center justify-between bg-slate-50 px-4 py-3 border-b border-slate-200/80">
                    <div className="flex items-center gap-2">
                      <Package className="h-4 w-4 text-[#12335f]" />
                      <h4 className="text-xs font-bold uppercase tracking-wider text-[#12335f]">Line Items</h4>
                    </div>
                    <span className="rounded-full bg-slate-200/80 px-2.5 py-0.5 text-[10px] font-bold text-slate-700">
                      {(viewingOrder.items?.length || 1)} Item(s)
                    </span>
                  </div>

                  {/* Table with fixed layout to prevent horizontal scroll */}
                  <div className="w-full">
                    <table className="w-full text-left border-collapse table-fixed">
                      <thead>
                        <tr className="border-b border-slate-200/80 bg-slate-50/60 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                          <th scope="col" className="py-2.5 px-3 text-center w-12 sm:w-14">#</th>
                          <th scope="col" className="py-2.5 px-3 text-left">Item Description</th>
                          <th scope="col" className="py-2.5 px-2 text-center w-16 sm:w-20">Qty</th>
                          <th scope="col" className="py-2.5 px-3 text-right w-24 sm:w-28">Unit Price</th>
                          <th scope="col" className="py-2.5 px-3 text-right w-28 sm:w-32">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs">
                        {((viewingOrder.items && viewingOrder.items.length > 0)
                          ? viewingOrder.items
                          : [{ itemName: viewingOrder.title, quantity: 1, unitPrice: viewingOrder.amount || viewingOrder.totalValue, totalAmount: viewingOrder.amount || viewingOrder.totalValue }]
                        ).map((item: any, idx: number) => {
                          const qty = Number(item.quantity || 1);
                          const unitPrice = Number(item.unitPrice || 0);
                          const totalAmount = Number(item.totalAmount || (qty * unitPrice));
                          return (
                            <tr key={item.id || `po-item-${idx}`} className="hover:bg-slate-50/70 transition-colors">
                              <td className="py-3 px-3 text-center font-mono font-bold text-slate-400 text-[11px] align-top">
                                {String(idx + 1).padStart(2, '0')}
                              </td>
                              <td className="py-3 px-3 align-top">
                                <p className="font-bold text-slate-900 leading-snug break-words">
                                  {item.itemName || viewingOrder.title}
                                </p>
                                {item.description && (
                                  <p className="text-[11px] font-medium text-slate-500 mt-0.5 leading-relaxed break-words">
                                    {item.description}
                                  </p>
                                )}
                                {item.hsnCode && (
                                  <span className="inline-block mt-1 text-[9px] font-mono font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                                    HSN: {item.hsnCode}
                                  </span>
                                )}
                              </td>
                              <td className="py-3 px-2 text-center align-top">
                                <span className="inline-block rounded-md bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-800 font-mono">
                                  {qty}
                                </span>
                              </td>
                              <td className="py-3 px-3 text-right font-mono font-semibold text-slate-600 align-top whitespace-nowrap">
                                {formatCurrency(unitPrice)}
                              </td>
                              <td className="py-3 px-3 text-right font-mono font-bold text-slate-900 align-top whitespace-nowrap">
                                {formatCurrency(totalAmount)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3.5 bg-slate-50/80 border-t border-slate-200/80">
                    <div className="text-xs text-slate-500 font-medium">
                      Showing <span className="font-bold text-slate-800">{(viewingOrder.items?.length || 1)}</span> line item(s)
                    </div>
                    <div className="bg-slate-900 text-white rounded-lg px-4 py-2 text-right shadow-2xs flex items-center gap-3">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300">Grand Total:</span>
                      <span className="text-base font-bold text-white font-mono">{formatCurrency(viewingOrder.amount || viewingOrder.totalValue)}</span>
                    </div>
                  </div>
                </div>

                {/* Signatures & Stamps Card */}
                {(() => {
                  const buyerObj = (viewingOrder.buyer as any) || {};
                  const sellerObj = (viewingOrder.seller as any) || {};
                  const bReg = (buyerObj.registrationDetails as Record<string, any>) || {};
                  const sReg = (sellerObj.registrationDetails as Record<string, any>) || {};
                  const currentUserReg = (user?.registrationDetails as Record<string, any>) || {};
                  const lsStamp = typeof window !== 'undefined' ? localStorage.getItem('msme_invoice_stamp') : null;
                  const lsSig = typeof window !== 'undefined' ? localStorage.getItem('msme_invoice_signature') : null;

                  const bStamp = resolveMediaUrl(bReg.stampUrl || (viewingOrder.buyerId === user?.id || isBuyer ? (currentUserReg.stampUrl || lsStamp) : null));
                  const bSig = resolveMediaUrl(bReg.signatureUrl || (viewingOrder.buyerId === user?.id || isBuyer ? (currentUserReg.signatureUrl || lsSig) : null));
                  const sStamp = resolveMediaUrl(sReg.stampUrl || (viewingOrder.sellerId === user?.id || isSeller ? (currentUserReg.stampUrl || lsStamp) : null));
                  const sSig = resolveMediaUrl(sReg.signatureUrl || (viewingOrder.sellerId === user?.id || isSeller ? (currentUserReg.signatureUrl || lsSig) : null));

                  const buyerOrgDisplay = buyerObj.organization?.organizationName || buyerObj.buyerProfile?.companyName || bReg.businessName || viewingOrder.buyer?.name || 'Buyer';
                  const sellerOrgDisplay = sellerObj.organization?.organizationName || sellerObj.sellerProfile?.businessName || sReg.businessName || viewingOrder.seller?.name || 'Seller';

                  return (
                    <div className="rounded-xl bg-white p-4 sm:p-5 border border-slate-200/80 shadow-2xs space-y-3.5">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                        <div className="flex items-center gap-2">
                          <ShieldCheck className="h-4 w-4 text-[#12335f]" />
                          <h4 className="text-xs font-bold uppercase tracking-wider text-[#12335f]">Signatures & Official Authorization</h4>
                        </div>
                        <span className="text-[10px] font-medium text-slate-500">Verified MSME Seals</span>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                        {/* Buyer Authorization */}
                        <div className="rounded-lg bg-slate-50/80 p-3.5 border border-slate-200/60 flex flex-col justify-between space-y-2.5">
                          <div>
                            <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500 block">Buyer Authorization</span>
                            <p className="text-xs font-bold text-slate-900 truncate">For {buyerOrgDisplay}</p>
                          </div>
                          <div className="flex items-center gap-3 h-12 bg-white p-2 rounded-lg border border-slate-200/70 overflow-hidden">
                            {bStamp ? (
                              <img
                                src={bStamp}
                                alt="Buyer Stamp"
                                style={{ maxHeight: '32px', maxWidth: '32px', objectFit: 'contain' }}
                                className="h-8 w-8 object-contain mix-blend-multiply shrink-0"
                              />
                            ) : (
                              <div className="h-8 w-8 rounded border border-dashed border-slate-300 flex items-center justify-center text-[7px] font-bold text-slate-400 shrink-0 uppercase">
                                Stamp
                              </div>
                            )}
                            {bSig ? (
                              <img
                                src={bSig}
                                alt="Buyer Signature"
                                style={{ maxHeight: '32px', maxWidth: '100px', objectFit: 'contain' }}
                                className="h-8 w-auto max-w-[100px] object-contain mix-blend-multiply shrink"
                              />
                            ) : (
                              <span className="text-[10px] font-medium text-slate-400 italic">Signature on file</span>
                            )}
                          </div>
                          <span className="text-[9px] text-slate-500 font-medium border-t border-slate-200 pt-1 text-center block">Authorized Buyer Signatory</span>
                        </div>

                        {/* Seller Authorization */}
                        <div className="rounded-lg bg-slate-50/80 p-3.5 border border-slate-200/60 flex flex-col justify-between space-y-2.5">
                          <div>
                            <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500 block">Supplier Authorization</span>
                            <p className="text-xs font-bold text-slate-900 truncate">For {sellerOrgDisplay}</p>
                          </div>
                          <div className="flex items-center gap-3 h-12 bg-white p-2 rounded-lg border border-slate-200/70 overflow-hidden">
                            {sStamp ? (
                              <img
                                src={sStamp}
                                alt="Seller Stamp"
                                style={{ maxHeight: '32px', maxWidth: '32px', objectFit: 'contain' }}
                                className="h-8 w-8 object-contain mix-blend-multiply shrink-0"
                              />
                            ) : (
                              <div className="h-8 w-8 rounded border border-dashed border-slate-300 flex items-center justify-center text-[7px] font-bold text-slate-400 shrink-0 uppercase">
                                Stamp
                              </div>
                            )}
                            {sSig ? (
                              <img
                                src={sSig}
                                alt="Seller Signature"
                                style={{ maxHeight: '32px', maxWidth: '100px', objectFit: 'contain' }}
                                className="h-8 w-auto max-w-[100px] object-contain mix-blend-multiply shrink"
                              />
                            ) : (
                              <span className="text-[10px] font-medium text-slate-400 italic">Signature on file</span>
                            )}
                          </div>
                          <span className="text-[9px] text-slate-500 font-medium border-t border-slate-200 pt-1 text-center block">Authorized Supplier Signatory</span>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* GRN Gating Warning Banner for Buyer */}
                {isBuyer && !hasApprovedGrn(viewingOrder) && !String(viewingOrder.status || '').toLowerCase().includes('paid') && !['cancelled', 'draft'].includes(String(viewingOrder.status || '').toLowerCase()) && (
                  <div className="rounded-xl border border-amber-300 bg-amber-50/90 p-4 text-amber-900 shadow-2xs space-y-2">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                      <h4 className="text-xs font-black uppercase tracking-wider text-amber-900">
                        {hasAnyGrn(viewingOrder) ? 'GRN Created: Verification / Approval In Progress' : 'Statutory Payment Gate: Verified GRN Required'}
                      </h4>
                    </div>
                    <p className="text-xs text-amber-800 font-semibold leading-relaxed">
                      {hasAnyGrn(viewingOrder)
                        ? 'A Goods Receipt Note (GRN) has already been recorded for this order. Please inspect and approve the GRN to unlock escrow and record payments.'
                        : 'Payment Blocked: A verified Goods Receipt Note (GRN) must be generated and approved by the consignee/buyer before releasing escrow or uploading payment proof.'}
                    </p>
                    <div className="pt-1">
                      {hasAnyGrn(viewingOrder) ? (
                        <Button
                          type="button"
                          onClick={() => {
                            const target = viewingOrder;
                            setViewingOrder(null);
                            handleViewGrn(target);
                          }}
                          className="h-8 bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-black uppercase tracking-wider rounded-lg shadow-2xs cursor-pointer"
                        >
                          <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" /> View GRN
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          onClick={() => {
                            const poId = viewingOrder.id;
                            setViewingOrder(null);
                            setGrnModalPoId(poId);
                          }}
                          className="h-8 bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-black uppercase tracking-wider rounded-lg shadow-2xs cursor-pointer"
                        >
                          <AlertTriangle className="mr-1.5 h-3.5 w-3.5" /> Generate GRN First
                        </Button>
                      )}
                    </div>
                  </div>
                )}

              </div>

              {/* Modal Sticky Action Footer - Harmonized & Professional */}
              <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-slate-200 bg-white px-4 sm:px-6 py-3.5 shrink-0 shadow-lg">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  {(() => {
                    const viewingStatusLower = String(viewingOrder.status || '').toLowerCase();
                    const viewingPoStatusLower = String((viewingOrder as any).poStatus || '').toLowerCase();
                    const effectiveViewingStatus = viewingPoStatusLower || viewingStatusLower;
                    const isIssuedModal = viewingStatusLower === 'issued' || viewingStatusLower === 'generated' || viewingStatusLower === 'order_placed' || viewingStatusLower === 'pending_approval' || viewingStatusLower === 'pending_acceptance' || effectiveViewingStatus === 'pending_acceptance' || effectiveViewingStatus === 'issued';
                    const isAcceptedModal = viewingStatusLower === 'accepted' || viewingStatusLower === 'in_fulfillment';
                    const isDeliveredModal = viewingStatusLower === 'delivered';
                    const isCancelledModal = viewingStatusLower === 'cancelled' || viewingStatusLower === 'rejected';

                    const activeInvoice = (viewingOrder as any).invoices?.[0] || (viewingOrder as any).invoice;
                    const approvedGrn = hasApprovedGrn(viewingOrder);

                    const hasSlip = Boolean(
                      (viewingOrder as any).paymentProofUrl ||
                      (viewingOrder as any).paymentProofDocumentUrl ||
                      (viewingOrder as any).paymentSlipUrl ||
                      (viewingOrder as any).bankSlipUrl ||
                      (viewingOrder as any).receiptUrl ||
                      activeInvoice?.paymentProofUrl ||
                      activeInvoice?.paymentSlipUrl ||
                      (viewingOrder as any).paymentSlip ||
                      (viewingOrder as any).offlineProof ||
                      (viewingOrder as any).paymentProof
                    );

                    const isPaid = Boolean(
                      viewingStatusLower.includes('paid') ||
                      String(activeInvoice?.status || '').toLowerCase() === 'paid'
                    );

                    const hasPaymentRecorded = Boolean(
                      isPaid ||
                      activeInvoice?.paymentReference ||
                      String(activeInvoice?.status || '').toLowerCase() === 'payment_submitted' ||
                      String(activeInvoice?.status || '').toLowerCase().includes('paid') ||
                      ((viewingOrder as any).payments && (viewingOrder as any).payments.length > 0)
                    );

                    const isSettled = Boolean(
                      activeInvoice?.settledAt ||
                      viewingStatusLower === 'settled' ||
                      viewingStatusLower === 'closed' ||
                      viewingStatusLower === 'completed' ||
                      (isPaid && !hasSlip)
                    );

                    return (
                      <>
                        {/* Seller: Accept / Reject when newly issued */}
                        {isSeller && isIssuedModal && (
                          <>
                            <Button
                              onClick={() => {
                                setViewingOrder(null);
                                handleAcceptOrder(viewingOrder);
                              }}
                              className="h-9 bg-emerald-600 text-xs font-bold uppercase tracking-wider text-white hover:bg-emerald-700 shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-pointer"
                            >
                              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Accept PO
                            </Button>
                            <Button
                              variant="outline"
                              onClick={() => {
                                setViewingOrder(null);
                                handleRejectOrder(viewingOrder);
                              }}
                              className="h-9 border-rose-300 text-xs font-bold uppercase tracking-wider text-rose-600 hover:bg-rose-50 hover:text-rose-700 shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-pointer"
                            >
                              <XCircle className="mr-1.5 h-3.5 w-3.5" /> Reject PO
                            </Button>
                          </>
                        )}

                        {/* Seller: Accept / Decline when amendment proposed */}
                        {isSeller && viewingStatusLower === 'amendment_pending' && (
                          <>
                            <Button
                              onClick={async () => {
                                try {
                                  await postApi(`/api/purchase-orders/${viewingOrder.id}/amendment-decision`, { decision: 'accept', accepted: true });
                                  toast.success(`Amendment ACCEPTED for PO ${viewingOrder.poNumber || `PO-${viewingOrder.id}`}.`);
                                  await refreshPurchaseOrders();
                                  setViewingOrder(prev => prev ? { ...prev, status: 'accepted' } : null);
                                } catch (err: any) {
                                  toast.error(err.message || 'Failed to accept amendment');
                                }
                              }}
                              className="h-9 bg-emerald-600 text-xs font-bold uppercase tracking-wider text-white hover:bg-emerald-700 shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-pointer flex items-center gap-1.5"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" /> Accept Amendment
                            </Button>
                            <Button
                              variant="outline"
                              onClick={async () => {
                                try {
                                  await postApi(`/api/purchase-orders/${viewingOrder.id}/amendment-decision`, { decision: 'decline', accepted: false, remarks: 'Declined by seller', reason: 'Declined by seller' });
                                  toast.success(`Amendment DECLINED for PO ${viewingOrder.poNumber || `PO-${viewingOrder.id}`}.`);
                                  await refreshPurchaseOrders();
                                  setViewingOrder(prev => prev ? { ...prev, status: 'accepted' } : null);
                                } catch (err: any) {
                                  toast.error(err.message || 'Failed to decline amendment');
                                }
                              }}
                              className="h-9 border-rose-300 text-xs font-bold uppercase tracking-wider text-rose-600 hover:bg-rose-50 shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-pointer flex items-center gap-1.5"
                            >
                              <XCircle className="h-3.5 w-3.5" /> Decline Amendment
                            </Button>
                          </>
                        )}

                        {/* Seller: Invoicing & Delivery tracking */}
                        {isSeller && (isAcceptedModal || isDeliveredModal) && (
                          <>
                            {(() => {
                              const hasInvoice = Boolean(
                                (viewingOrder as any)?.invoices?.length > 0 ||
                                (viewingOrder as any)?.invoiceId ||
                                (viewingOrder as any)?.invoiceNumber ||
                                (viewingOrder as any)?.invoice ||
                                ['invoiced', 'invoice_submitted', 'payment_initiated', 'completed', 'paid'].includes(String(viewingOrder.status || '').toLowerCase())
                              );
                              if (hasInvoice) {
                                const inv = (viewingOrder as any)?.invoices?.[0] || (viewingOrder as any)?.invoice;
                                const invNo = inv?.invoiceNumber || (viewingOrder as any)?.invoiceNumber || viewingOrder.id;
                                const invId = inv?.id || (viewingOrder as any)?.invoiceId;
                                return (
                                  <Button
                                    onClick={() => {
                                      if (invId) {
                                        setTaxInvoiceModalId(Number(invId));
                                        setTaxInvoiceModalData(inv || null);
                                        setTaxInvoiceModalOpen(true);
                                      } else {
                                        setViewingOrder(null);
                                        router.push(`/seller/invoices?viewInvoiceNo=${invNo}`);
                                      }
                                    }}
                                    className="h-9 bg-slate-900 text-xs font-bold uppercase tracking-wider text-white hover:bg-slate-800 shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-pointer"
                                  >
                                    <FileText className="mr-1.5 h-3.5 w-3.5" /> View Invoice
                                  </Button>
                                );
                              }
                              return (
                                <Button
                                  onClick={() => {
                                    setViewingOrder(null);
                                    const amountVal = viewingOrder.amount || viewingOrder.totalValue || 0;
                                    router.push(`/seller/invoices?convertPoId=${viewingOrder.id}&amount=${amountVal}`);
                                  }}
                                  className="h-9 bg-slate-900 text-xs font-bold uppercase tracking-wider text-white hover:bg-slate-800 shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-pointer"
                                >
                                  <FileText className="mr-1.5 h-3.5 w-3.5" /> Create Invoice from PO
                                </Button>
                              );
                            })()}
                            <Button
                              onClick={() => {
                                setViewingOrder(null);
                                handleOpenDelivery(viewingOrder);
                              }}
                              className="h-9 bg-slate-800 text-xs font-bold uppercase tracking-wider text-white hover:bg-slate-900 shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-pointer"
                            >
                              <Truck className="mr-1.5 h-3.5 w-3.5" /> Delivery Tracking
                            </Button>
                          </>
                        )}

                        {/* Linked Quotation */}
                        {(viewingOrder as any)?.bidId && (
                          <Button
                            variant="outline"
                            onClick={() => {
                              const bId = (viewingOrder as any).bidId;
                              setViewingOrder(null);
                              router.push(`/bids/${bId}`);
                            }}
                            className="h-9 border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-bold uppercase tracking-wider rounded-lg px-3.5 whitespace-nowrap cursor-pointer shadow-2xs"
                          >
                            <FileText className="mr-1.5 h-3.5 w-3.5 text-slate-500" /> View Quotation
                          </Button>
                        )}

                        {/* BUYER WORKFLOW */}
                        {isBuyer && !isCancelledModal && (
                          <>
                            {/* Draft Editing & Issuance for Buyer */}
                            {(viewingStatusLower === 'draft' || viewingStatusLower === 'generated' || (viewingOrder as any).isDraft) && (
                              <>
                                <Button
                                  variant="outline"
                                  onClick={() => {
                                    setEditPoTarget(viewingOrder);
                                    setEditPoMode('draft');
                                    setEditPoModalOpen(true);
                                  }}
                                  className="h-9 border-indigo-200 bg-indigo-50/60 hover:bg-indigo-100 text-indigo-800 text-xs font-black uppercase tracking-wider rounded-lg px-3.5 whitespace-nowrap shadow-2xs cursor-pointer flex items-center gap-1.5"
                                >
                                  <FileText className="h-3.5 w-3.5 text-indigo-600" />
                                  <span>Edit Purchase Order (Draft)</span>
                                </Button>
                                <Button
                                  onClick={async () => {
                                    try {
                                      await postApi(`/api/purchase-orders/${viewingOrder.id}/issue`, {});
                                      toast.success(`PO officially ISSUED to supplier!`);
                                      await refreshPurchaseOrders();
                                      setViewingOrder(prev => prev ? { ...prev, status: 'issued' } : null);
                                    } catch (err: any) {
                                      toast.error(err.message || 'Failed to issue PO');
                                    }
                                  }}
                                  className="h-9 bg-[#12335f] hover:bg-[#0e2a4f] text-white text-xs font-black uppercase tracking-wider rounded-lg px-3.5 whitespace-nowrap shadow-2xs cursor-pointer flex items-center gap-1.5"
                                >
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  <span>Issue PO to Seller</span>
                                </Button>
                              </>
                            )}

                            {/* Recall unaccepted PO to Draft to make edits */}
                            {isIssuedModal && !isCancelledModal && !(viewingOrder as any).isDraft && viewingStatusLower !== 'draft' && viewingStatusLower !== 'generated' && (
                              <Button
                                variant="outline"
                                onClick={() => handleRecallPo(viewingOrder)}
                                className="h-9 border-amber-200 bg-amber-50 hover:bg-amber-100 text-amber-800 text-xs font-black uppercase tracking-wider rounded-lg px-3.5 whitespace-nowrap shadow-2xs cursor-pointer flex items-center gap-1.5"
                                title="Recall this unaccepted purchase order to draft to make modifications"
                              >
                                <Undo2 className="h-3.5 w-3.5 text-amber-600" />
                                <span>Recall to Draft &amp; Edit</span>
                              </Button>
                            )}

                            {/* Propose V2 Amendment for Buyer on Accepted PO */}
                            {isAcceptedModal && (
                              <Button
                                variant="outline"
                                onClick={() => {
                                  setEditPoTarget(viewingOrder);
                                  setEditPoMode('amend');
                                  setEditPoModalOpen(true);
                                }}
                                className="h-9 border-purple-200 bg-purple-50 hover:bg-purple-100 text-purple-800 text-xs font-black uppercase tracking-wider rounded-lg px-3.5 whitespace-nowrap shadow-2xs cursor-pointer flex items-center gap-1.5"
                              >
                                <FileText className="h-3.5 w-3.5 text-purple-600" />
                                <span>Amend PO (V2)</span>
                              </Button>
                            )}

                            {/* View attached official external SAP PDF */}
                            {(viewingOrder as any).externalPdfFileId && (
                              <Button
                                variant="outline"
                                onClick={() => {
                                  openFileAsset({
                                    id: (viewingOrder as any).externalPdfFileId,
                                    fileAssetId: (viewingOrder as any).externalPdfFileId,
                                    originalName: (viewingOrder as any).externalPdfFile?.originalName || 'SAP_Purchase_Order.pdf'
                                  }, 'SAP_Purchase_Order.pdf').catch(err => {
                                    toast.error(err instanceof Error ? err.message : 'Unable to open PO PDF');
                                  });
                                }}
                                className="h-9 border-indigo-200 bg-indigo-50/60 hover:bg-indigo-100 text-indigo-800 text-xs font-bold uppercase tracking-wider rounded-lg px-3.5 whitespace-nowrap cursor-pointer shadow-2xs flex items-center gap-1.5"
                              >
                                <FileText className="h-3.5 w-3.5 text-indigo-600" />
                                <span>View SAP PO PDF</span>
                              </Button>
                            )}

                            {/* Export SAP MIRO Batch */}
                            {activeInvoice && (
                              <Button
                                variant="outline"
                                onClick={() => downloadSapMiroExport(activeInvoice.id)}
                                className="h-9 border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 text-xs font-black uppercase tracking-wider rounded-lg px-3.5 whitespace-nowrap cursor-pointer shadow-2xs flex items-center gap-1.5"
                                title="Download SAP MIRO / MIGO compatible batch CSV"
                              >
                                <Download className="h-3.5 w-3.5 text-emerald-600" />
                                <span>Export to SAP (MIRO)</span>
                              </Button>
                            )}

                            {/* Cancel PO (only if not yet delivered/settled) */}
                            {!['delivered', 'completed', 'settled', 'closed'].includes(viewingStatusLower) && (
                              <Button
                                variant="outline"
                                onClick={() => setConfirming({ action: 'cancel', order: viewingOrder })}
                                className="h-9 border-rose-300 text-xs font-bold uppercase tracking-wider text-rose-600 hover:bg-rose-50 hover:text-rose-700 rounded-lg px-3.5 whitespace-nowrap shadow-2xs cursor-pointer"
                              >
                                <XCircle className="mr-1.5 h-3.5 w-3.5" /> Cancel PO
                              </Button>
                            )}

                            {/* GRN Section */}
                            {approvedGrn ? (
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => {
                                  const target = viewingOrder;
                                  setViewingOrder(null);
                                  handleViewGrn(target);
                                }}
                                className="h-9 border-teal-300 text-teal-700 hover:bg-teal-50 text-xs font-bold uppercase tracking-wider shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-pointer"
                              >
                                <ClipboardCheck className="mr-1.5 h-3.5 w-3.5 text-teal-600" /> View GRN
                              </Button>
                            ) : hasAnyGrn(viewingOrder) ? (
                              <Button
                                type="button"
                                onClick={() => {
                                  const target = viewingOrder;
                                  setViewingOrder(null);
                                  handleViewGrn(target);
                                }}
                                className="h-9 bg-teal-600 hover:bg-teal-700 text-xs font-bold uppercase tracking-wider text-white shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-pointer"
                              >
                                <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" /> View GRN (Pending Approval)
                              </Button>
                            ) : (
                              /* Generate GRN: enabled ONLY if goods delivered */
                              isDeliveryDeliveredOrApproved(viewingOrder) ? (
                                <Button
                                  type="button"
                                  onClick={() => {
                                    const poId = viewingOrder.id;
                                    setViewingOrder(null);
                                    setGrnModalPoId(poId);
                                  }}
                                  className="h-9 bg-amber-600 hover:bg-amber-700 text-xs font-bold uppercase tracking-wider text-white shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-pointer"
                                >
                                  <AlertTriangle className="mr-1.5 h-3.5 w-3.5" /> Generate GRN
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  disabled
                                  className="h-9 bg-slate-100 text-slate-400 border border-slate-200 text-xs font-bold uppercase tracking-wider shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-not-allowed opacity-60"
                                  title="Generate GRN is disabled until Delivery Status is marked as DELIVERED by the seller"
                                >
                                  <Lock className="mr-1.5 h-3.5 w-3.5 text-slate-400" /> Generate GRN (Awaiting Delivery)
                                </Button>
                              )
                            )}

                            {/* Payment Actions: STRICTLY gated by Invoice Approval + (Approved GRN or Advance Payment) */}
                            {!hasPaymentRecorded && !hasSlip && !isPaid && !isSettled && (
                              (() => {
                                const modalActiveInv = (viewingOrder as any).invoices?.find(
                                  (inv: any) =>
                                    String(inv.status || inv.invoiceStatus || '').toLowerCase() !== 'cancelled' &&
                                    String(inv.status || inv.invoiceStatus || '').toLowerCase() !== 'rejected'
                                ) || (viewingOrder as any).invoices?.[0];
                                const modalInvStatus = String(modalActiveInv?.status || modalActiveInv?.invoiceStatus || '').toLowerCase();
                                const modalInvApproved = Boolean(
                                  modalActiveInv && ['approved', 'issued', 'verified', 'accepted', 'paid', 'payment_submitted'].includes(modalInvStatus)
                                );
                                const modalAdvance = isAdvancePaymentTerms(viewingOrder) || isAdvancePaymentTerms(modalActiveInv);
                                const modalCanPay = (modalAdvance || approvedGrn) && modalInvApproved;

                                if (modalCanPay) {
                                  return (
                                    <Button
                                      onClick={() => {
                                        const target = viewingOrder;
                                        setViewingOrder(null);
                                        setRecordPaymentOrder(target);
                                      }}
                                      className="h-9 bg-emerald-600 text-xs font-bold uppercase tracking-wider text-white hover:bg-emerald-700 shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-pointer"
                                      title="Pay online or upload payment proof"
                                    >
                                      <CreditCard className="mr-1.5 h-3.5 w-3.5" /> Pay Now / Upload Payment Proof
                                    </Button>
                                  );
                                }

                                return (
                                  <Button
                                    disabled
                                    className="h-9 bg-slate-100 text-slate-400 border border-slate-200 text-xs font-bold uppercase tracking-wider shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-not-allowed opacity-60"
                                    title={
                                      !modalInvApproved
                                        ? "Payment is disabled until Tax Invoice is issued and approved."
                                        : !modalAdvance && !approvedGrn
                                        ? "Payment is disabled until Goods are Delivered & GRN is Generated."
                                        : "Payment is locked."
                                    }
                                  >
                                    <Lock className="mr-1.5 h-3.5 w-3.5 text-slate-400" /> Pay Now (
                                    {!modalInvApproved
                                      ? "Invoice Pending"
                                      : !modalAdvance && !approvedGrn
                                      ? "GRN Required"
                                      : "Locked"}
                                    )
                                  </Button>
                                );
                              })()
                            )}

                            {/* View Payment Proof: ONLY visible if proof is uploaded or payment recorded */}
                            {(hasSlip || hasPaymentRecorded || isPaid) && (
                              <Button
                                variant="outline"
                                onClick={() => setViewProofOrder(viewingOrder)}
                                onMouseEnter={() => {
                                  const proofId = activeInvoice?.paymentSlipFileId || (viewingOrder as any)?.paymentSlipFileId || (viewingOrder as any)?.paymentSlipFile;
                                  if (proofId) prewarmFileAssetPreview(proofId, 'Payment_Proof');
                                }}
                                onFocus={() => {
                                  const proofId = activeInvoice?.paymentSlipFileId || (viewingOrder as any)?.paymentSlipFileId || (viewingOrder as any)?.paymentSlipFile;
                                  if (proofId) prewarmFileAssetPreview(proofId, 'Payment_Proof');
                                }}
                                className="h-9 border-slate-200 bg-white text-xs font-bold uppercase tracking-wider text-slate-700 hover:bg-slate-50 rounded-lg px-3.5 whitespace-nowrap shadow-2xs cursor-pointer"
                              >
                                <Receipt className="mr-1.5 h-3.5 w-3.5 text-slate-500" /> View Payment Proof
                              </Button>
                            )}

                            {/* Repeat Order for Buyer on completed/delivered orders */}
                            {(isDeliveredModal || isSettled) && (
                              <Button
                                onClick={() => handleOpenRepeatModal(viewingOrder)}
                                className="h-9 bg-slate-900 text-xs font-bold uppercase tracking-wider text-white hover:bg-slate-800 shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-pointer"
                              >
                                <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Repeat Order
                              </Button>
                            )}
                          </>
                        )}

                        {/* SELLER WORKFLOW */}
                        {isSeller && !isCancelledModal && (
                          <>
                            {/* GRN approved, but buyer has not yet paid */}
                            {approvedGrn && !hasPaymentRecorded && !hasSlip && !isSettled && (
                              <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800">
                                <Clock className="h-3.5 w-3.5 text-amber-600" />
                                <span>Awaiting Buyer Payment & Payment Proof</span>
                              </span>
                            )}

                            {/* View Payment Proof: ONLY if proof is actually uploaded or payment recorded */}
                            {(hasSlip || hasPaymentRecorded) && (
                              <Button
                                variant="outline"
                                onClick={() => setViewProofOrder(viewingOrder)}
                                onMouseEnter={() => {
                                  const proofId = activeInvoice?.paymentSlipFileId || (viewingOrder as any)?.paymentSlipFileId || (viewingOrder as any)?.paymentSlipFile;
                                  if (proofId) prewarmFileAssetPreview(proofId, 'Payment_Proof');
                                }}
                                onFocus={() => {
                                  const proofId = activeInvoice?.paymentSlipFileId || (viewingOrder as any)?.paymentSlipFileId || (viewingOrder as any)?.paymentSlipFile;
                                  if (proofId) prewarmFileAssetPreview(proofId, 'Payment_Proof');
                                }}
                                className="h-9 border-slate-200 bg-white text-xs font-bold uppercase tracking-wider text-slate-700 hover:bg-slate-50 rounded-lg px-3.5 whitespace-nowrap shadow-2xs cursor-pointer"
                              >
                                <Receipt className="mr-1.5 h-3.5 w-3.5 text-slate-500" /> View Payment Proof
                              </Button>
                            )}

                            {/* Confirm Settlement & Close: ONLY when payment recorded or slip uploaded, and NOT already settled */}
                            {(hasPaymentRecorded || hasSlip) && !isSettled && (
                              <Button
                                onClick={() => {
                                  const target = viewingOrder;
                                  setViewingOrder(null);
                                  setConfirmSettlementOrder(target);
                                }}
                                className="h-9 bg-emerald-600 text-xs font-bold uppercase tracking-wider text-white hover:bg-emerald-700 shadow-2xs rounded-lg px-3.5 whitespace-nowrap cursor-pointer"
                              >
                                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Confirm Settlement & Close
                              </Button>
                            )}

                            {/* Settled Badge */}
                            {isSettled && (
                              <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800">
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                                <span>Settled & Closed</span>
                              </span>
                            )}
                          </>
                        )}

                        {/* Admin / Master Admin: View Payment Proof if uploaded */}
                        {(user?.role === 'admin' || user?.role === 'master_admin') && (hasSlip || hasPaymentRecorded) && (
                          <Button
                            variant="outline"
                            onClick={() => setViewProofOrder(viewingOrder)}
                            className="h-9 border-slate-200 bg-white text-xs font-bold uppercase tracking-wider text-slate-700 hover:bg-slate-50 rounded-lg px-3.5 whitespace-nowrap shadow-2xs cursor-pointer"
                          >
                            <Receipt className="mr-1.5 h-3.5 w-3.5 text-slate-500" /> View Payment Proof
                          </Button>
                        )}
                      </>
                    );
                  })()}
                </div>

                <div className="flex items-center gap-2 shrink-0 ml-auto">
                  <Button 
                    variant="outline" 
                    onClick={() => setReceiptModalOrder(viewingOrder)} 
                    className="h-9 text-xs font-bold uppercase tracking-wider rounded-lg border-slate-200 bg-white text-slate-700 hover:bg-slate-50 px-3.5 whitespace-nowrap shadow-2xs cursor-pointer"
                  >
                    <Receipt className="mr-1.5 h-3.5 w-3.5 text-slate-500" /> View Official PO
                  </Button>
                 
                </div>
              </div>

            </div>
          </FocusTrap>
        </div>
      )}
      {repeatingOrder && (
        <RepeatPurchaseOrderModal
          order={repeatingOrder}
          onClose={() => setRepeatingOrder(null)}
          onSuccess={() => {
            setViewingOrder(null);
            reload();
          }}
        />
      )}

      {receiptModalOrder && (
        <PurchaseOrderReceiptModal
          order={receiptModalOrder}
          onClose={() => setReceiptModalOrder(null)}
          isSeller={isSeller}
          isBuyer={isBuyer}
          onAccept={(o) => handleAcceptOrder(o as any)}
          onReject={(o) => handleRejectOrder(o as any)}
          onCreateInvoice={(o) => handleConvertToInvoice(o as any)}
          onManageDispatch={(o) => handleOpenDelivery(o as any)}
          onRepeatOrder={(o) => handleOpenRepeatModal(o as any)}
          onUploadPaymentSlip={(o) => setUploadProofOrder(o as any)}
          onViewPaymentSlip={(o) => setViewProofOrder(o as any)}
          activeDelivery={activeDelivery}
        />
      )}

      {uploadProofOrder && (
        <PaymentReceiptUploadModal
          isOpen={!!uploadProofOrder}
          onClose={() => setUploadProofOrder(null)}
          order={{
            id: Number(uploadProofOrder.id),
            poNumber: uploadProofOrder.poNumber,
            amount: uploadProofOrder.amount || uploadProofOrder.totalValue,
            totalValue: uploadProofOrder.totalValue || uploadProofOrder.amount,
            seller: uploadProofOrder.seller
          }}
          onSuccess={() => {
            setUploadProofOrder(null);
            toast.success('Payment proof uploaded successfully. Awaiting verification.');
            reload();
          }}
        />
      )}

      {viewProofOrder && (
        <PaymentReceiptViewModal
          isOpen={!!viewProofOrder}
          onClose={() => setViewProofOrder(null)}
          orderId={Number(viewProofOrder.id)}
          orderPoNumber={viewProofOrder.poNumber}
          sellerName={viewProofOrder.seller?.name}
          isSettled={
            ['completed', 'settled'].includes(String(viewProofOrder.status || viewProofOrder.poStatus || '').toLowerCase())
          }
          onStatusChange={() => {
            setViewProofOrder(null);
            reload();
          }}
        />
      )}

      {recordPaymentOrder && (
        <RecordOrderPaymentModal
          isOpen={!!recordPaymentOrder}
          onClose={() => setRecordPaymentOrder(null)}
          order={recordPaymentOrder}
          onSuccess={() => {
            setRecordPaymentOrder(null);
            toast.success('Payment recorded and payment proof uploaded successfully.');
            reload();
          }}
        />
      )}

      {confirmSettlementOrder && (
        <ConfirmOrderSettlementModal
          isOpen={!!confirmSettlementOrder}
          onClose={() => setConfirmSettlementOrder(null)}
          order={confirmSettlementOrder}
          onSuccess={() => {
            setConfirmSettlementOrder(null);
            toast.success('Settlement confirmed and order closed successfully.');
            reload();
          }}
        />
      )}

      {grnModalPoId && (
        <GrnCreateModal
          initialPoId={grnModalPoId}
          onClose={() => setGrnModalPoId(null)}
          onCreated={(createdGrn: any) => {
            const currentPoId = grnModalPoId;
            setGrnModalPoId(null);
            toast.success('Goods Receipt Note (GRN) created successfully!');
            if (createdGrn) {
              setAllOrders((prev: PurchaseOrderDto[]) =>
                prev.map((o) =>
                  o.id === createdGrn.purchaseOrderId || o.id === currentPoId
                    ? {
                        ...o,
                        grns: [createdGrn, ...(o.grns || [])],
                        grnId: createdGrn.id
                      }
                    : o
                )
              );
              if (viewingOrder && (viewingOrder.id === createdGrn.purchaseOrderId || viewingOrder.id === currentPoId)) {
                setViewingOrder((prev: any) => ({
                  ...prev,
                  grns: [createdGrn, ...(prev?.grns || [])],
                  grnId: createdGrn.id
                }));
              }
            }
            refreshPurchaseOrders();
          }}
        />
      )}

      {taxInvoiceModalOpen && (
        <TaxInvoiceRegistryModal
          isOpen={taxInvoiceModalOpen}
          onClose={() => {
            setTaxInvoiceModalOpen(false);
            setTaxInvoiceModalId(null);
            setTaxInvoiceModalData(null);
          }}
          invoiceId={taxInvoiceModalId}
          initialInvoiceData={taxInvoiceModalData}
          onInvoiceApproved={() => {
            refreshPurchaseOrders();
          }}
        />
      )}

      {editPoModalOpen && (
        <EditPurchaseOrderModal
          isOpen={editPoModalOpen}
          onClose={() => {
            setEditPoModalOpen(false);
            setEditPoTarget(null);
          }}
          order={editPoTarget}
          mode={editPoMode}
          onSuccess={async () => {
            await refreshPurchaseOrders();
            if (viewingOrder && editPoTarget && viewingOrder.id === editPoTarget.id) {
              try {
                const res = await api.get(`/api/purchase-orders/${viewingOrder.id}`);
                const body = await readJsonResponse(res);
                const fullData = (body as any)?.data || body;
                if (fullData && fullData.id) {
                  setViewingOrder(fullData);
                }
              } catch {
                // ignore
              }
            }
          }}
        />
      )}

      {importExternalModalOpen && (
        <ImportExternalOrderModal
          isOpen={importExternalModalOpen}
          onClose={() => setImportExternalModalOpen(false)}
          onSuccess={(newOrder) => {
            refreshPurchaseOrders();
            if (newOrder && newOrder.id) {
              setViewingOrder(newOrder);
            }
          }}
        />
      )}
    </div>
  );
}



function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <p className="mt-1 break-words text-xs font-bold text-slate-800">{value || '-'}</p>
    </div>
  );
}

function StatusPill({ status }: { status?: string }) {
  const value = String(status || 'generated').toLowerCase();
  const isAccepted = value === 'accepted';
  const isCancelled = value === 'cancelled';
  const isRejected = value === 'rejected';
  const isDelivered = value === 'delivered';
  const isIssued = value === 'issued' || value === 'generated' || value === 'order_placed';
  const isPendingApproval = value === 'pending_approval';
  const isPaidOffline = value === 'paid_offline_verified';
  const isPaid = value === 'paid' || isPaidOffline;
  const isAmendmentPending = value === 'amendment_pending';

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-lg border px-3 py-1 text-[10px] font-black uppercase tracking-wide',
        isPaidOffline && 'border-indigo-300 bg-indigo-50 text-indigo-800 shadow-2xs',
        isPaid && !isPaidOffline && 'border-emerald-300 bg-emerald-50 text-emerald-800 shadow-2xs',
        !isPaid && isAmendmentPending && 'border-purple-300 bg-purple-50 text-purple-800 shadow-2xs',
        !isPaid && isAccepted && 'border-emerald-300 bg-emerald-50 text-emerald-800 shadow-2xs',
        !isPaid && isDelivered && 'border-green-300 bg-green-50 text-green-800 shadow-2xs',
        !isPaid && (isCancelled || isRejected) && 'border-rose-300 bg-rose-50 text-rose-800 shadow-2xs',
        !isPaid && isIssued && 'border-sky-300 bg-sky-50 text-sky-900 shadow-2xs',
        !isPaid && isPendingApproval && 'border-amber-300 bg-amber-50 text-amber-900 shadow-2xs',
        !isAccepted && !isDelivered && !isCancelled && !isRejected && !isIssued && !isPaid && !isPendingApproval && !isAmendmentPending && 'border-slate-200 bg-slate-50 text-slate-700'
      )}
    >
      {isPaidOffline ? 'PAID (OFFLINE)' : isAmendmentPending ? 'AMENDMENT PENDING' : isAccepted ? 'ACCEPTED' : isRejected ? 'REJECTED' : isCancelled ? 'CANCELLED' : isIssued ? 'ISSUED' : readableStatus(value).toUpperCase()}
    </span>
  );
}
