'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  FileText,
  Upload,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Calendar,
  MapPin,
  CreditCard,
  Hash,
  Package,
  Plus,
  Trash2,
  Eye,
  Calculator,
  ChevronDown
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../../components/ui/button';
import { api } from '../../../lib/api';
import { putApi, postApi } from '../../shared/apiClient';
import { formatCurrency, formatDate, formatDeliveryAddressString } from '../../shared/format';
import { fetchDeliveryAddresses, type DeliveryAddressDto } from '../../directPurchase/api';
import { AddDeliveryAddressModal } from '../../directPurchase/components/AddDeliveryAddressModal';
import { FocusTrap } from '../../../components/ui/FocusTrap';
import {
  PAYMENT_TERMS,
  matchPaymentTerms,
  QUANTITY_UNITS,
  matchQuantityUnit
} from '../../../constants/dropdowns';

export interface EditableLineItem {
  id?: number;
  itemName: string;
  description?: string;
  quantity: number;
  unitOfMeasure: string;
  unitPrice: number;
  taxRate: number;
  totalAmount: number;
}

export interface EditPurchaseOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  order: any;
  mode: 'draft' | 'amend';
  onSuccess: () => void;
}

export const STANDARD_PAYMENT_TERMS = PAYMENT_TERMS;
export const STANDARD_UOM_OPTIONS = QUANTITY_UNITS;
export const matchStandardUom = matchQuantityUnit;
export const matchStandardPaymentTerms = matchPaymentTerms;

const formatPaymentTerms = (terms?: string) => {
  if (!terms) return 'Net 30 Days';
  const clean = String(terms).trim();
  const map: Record<string, string> = {
    'PAY_ON_INVOICE': 'Pay on Invoice',
    'STANDARD_NET_30': 'Net 30 Days',
    'NET_30': 'Net 30 Days',
    'NET_60': 'Net 60 Days',
    'NET_90': 'Net 90 Days',
    'ADVANCE': '100% Advance Payment',
    'PAY_ON_DELIVERY': 'Pay on Delivery (COD/POD)',
    'IMMEDIATE': 'Immediate Payment'
  };
  return map[clean] || (clean.includes('_') ? clean.replace(/_/g, ' ') : clean);
};

export function EditPurchaseOrderModal({
  isOpen,
  onClose,
  order,
  mode,
  onSuccess,
}: EditPurchaseOrderModalProps) {
  const [title, setTitle] = useState('');
  const [externalPoNumber, setExternalPoNumber] = useState('');
  const [expectedDelivery, setExpectedDelivery] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [amendmentReason, setAmendmentReason] = useState('');
  const [pdfFileId, setPdfFileId] = useState<number | null>(null);
  const [pdfFileName, setPdfFileName] = useState<string>('');
  const [items, setItems] = useState<EditableLineItem[]>([]);
  const [savedAddresses, setSavedAddresses] = useState<DeliveryAddressDto[]>([]);
  const [isCustomAddress, setIsCustomAddress] = useState(false);
  const [isCustomPaymentTerms, setIsCustomPaymentTerms] = useState(false);
  const [isAddAddressModalOpen, setIsAddAddressModalOpen] = useState(false);

  const [uploadingPdf, setUploadingPdf] = useState(false);
  const [extractingPdf, setExtractingPdf] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchDeliveryAddresses()
      .then((addrs) => {
        if (alive && Array.isArray(addrs)) {
          setSavedAddresses(addrs);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (order && isOpen) {
      setTitle(order.title || '');
      setExternalPoNumber(order.externalPoNumber || '');
      if (order.expectedDelivery) {
        try {
          const d = new Date(order.expectedDelivery);
          setExpectedDelivery(d.toISOString().split('T')[0]);
        } catch {
          setExpectedDelivery('');
        }
      } else {
        setExpectedDelivery('');
      }

      let cleanAddress = typeof order.deliveryAddress === 'string' ? order.deliveryAddress : '';
      cleanAddress = cleanAddress.replace(/\bLIMITI\b/gi, 'LIMITED');
      setDeliveryAddress(cleanAddress);
      setIsCustomAddress(false);

      const initialTerms = formatPaymentTerms(order.paymentTerms);
      setPaymentTerms(initialTerms);
      setIsCustomPaymentTerms(matchStandardPaymentTerms(initialTerms) === 'Other');

      setAmendmentReason('');
      setPdfFileId(order.externalPdfFileId || null);
      setPdfFileName(order.externalPdfFile?.originalName || (order.externalPdfFileId ? 'Attached PO Document' : ''));
      setError(null);

      // Populate line items with strict tax mathematical integrity
      const existingItems = Array.isArray(order.items) && order.items.length > 0
        ? order.items.map((it: any) => {
            const qty = Number(it.quantity) || 1;
            const price = Number(it.unitPrice) || 0;
            const tax = Number(it.taxRate ?? 18);
            const subtotal = qty * price;
            const taxAmt = (subtotal * tax) / 100;
            const calculatedTotal = Math.round((subtotal + taxAmt) * 100) / 100;
            const incomingTotal = Number(it.totalAmount) || 0;

            // If incoming total is pre-tax subtotal and tax > 0, enforce tax-inclusive line total
            const total = (Math.abs(incomingTotal - subtotal) < 0.05 && tax > 0)
              ? calculatedTotal
              : (incomingTotal > 0 ? incomingTotal : calculatedTotal);

            return {
              id: it.id,
              itemName: it.itemName || 'Item',
              description: it.description || '',
              quantity: qty,
              unitOfMeasure: it.unitOfMeasure || 'units',
              unitPrice: price,
              taxRate: tax,
              totalAmount: total
            };
          })
        : [{
            itemName: order.title || 'Product Item',
            description: '',
            quantity: 1,
            unitOfMeasure: 'units',
            unitPrice: Number(order.totalValue || order.amount || 0),
            taxRate: 18,
            totalAmount: Math.round((Number(order.totalValue || order.amount || 0) * 1.18) * 100) / 100
          }];
      setItems(existingItems);
    }
  }, [order, isOpen]);

  // Recalculate totals dynamically
  const { subtotalTaxable, totalTax, calculatedTotalValue } = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    items.forEach((it) => {
      const lineSubtotal = (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0);
      const lineTax = (lineSubtotal * (Number(it.taxRate) || 0)) / 100;
      subtotal += lineSubtotal;
      tax += lineTax;
    });
    return {
      subtotalTaxable: Math.round(subtotal * 100) / 100,
      totalTax: Math.round(tax * 100) / 100,
      calculatedTotalValue: Math.round((subtotal + tax) * 100) / 100
    };
  }, [items]);

  const matchingSavedAddress = useMemo(() => {
    if (!deliveryAddress.trim() || savedAddresses.length === 0) return null;
    const norm = deliveryAddress.trim().toLowerCase();
    return (
      savedAddresses.find((a) => {
        const formatted = formatDeliveryAddressString(a).toLowerCase();
        return formatted === norm || (a.addressLine1 && norm.includes(a.addressLine1.toLowerCase()));
      }) || null
    );
  }, [deliveryAddress, savedAddresses]);

  const activeAddressOption = isCustomAddress
    ? 'custom'
    : matchingSavedAddress
    ? `addr_${matchingSavedAddress.id}`
    : deliveryAddress
    ? 'current_order'
    : 'custom';

  const handleUpdateItem = (index: number, field: keyof EditableLineItem, value: any) => {
    setItems((prev) => {
      const copy = [...prev];
      const item = { ...copy[index], [field]: value };
      const qty = Number(field === 'quantity' ? value : item.quantity) || 0;
      const price = Number(field === 'unitPrice' ? value : item.unitPrice) || 0;
      const taxRate = Number(field === 'taxRate' ? value : item.taxRate) || 0;
      const sub = qty * price;
      const taxAmt = (sub * taxRate) / 100;
      item.totalAmount = Math.round((sub + taxAmt) * 100) / 100;
      copy[index] = item;
      return copy;
    });
  };

  const handleAddItem = () => {
    setItems((prev) => [
      ...prev,
      {
        itemName: `Item ${prev.length + 1}`,
        description: '',
        quantity: 1,
        unitOfMeasure: 'units',
        unitPrice: 0,
        taxRate: 18,
        totalAmount: 0
      }
    ]);
  };

  const handleRemoveItem = (index: number) => {
    if (items.length <= 1) {
      toast.error('A Purchase Order must contain at least one line item.');
      return;
    }
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleExtractFromPdf = async (fileToExtract: File) => {
    setError(null);
    setExtractingPdf(true);
    try {
      const formData = new FormData();
      formData.append('file', fileToExtract);

      const res = await api.fetch('/api/documents/extract', {
        method: 'POST',
        body: formData,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || json?.error || 'Extraction failed');
      const data = json?.data?.data || json?.data || {};

      if (data.poNumber) {
        setExternalPoNumber(data.poNumber);
      }
      if (data.deliveryTerms?.deliveryAddress) {
        let addr = data.deliveryTerms.deliveryAddress.replace(/\bLIMITI\b/gi, 'LIMITED');
        setDeliveryAddress(addr);
      }
      if (data.deliveryTerms?.expectedDeliveryDate) {
        setExpectedDelivery(data.deliveryTerms.expectedDeliveryDate);
      }
      if (data.deliveryTerms?.paymentTerms) {
        setPaymentTerms(formatPaymentTerms(data.deliveryTerms.paymentTerms));
      }
      if (Array.isArray(data.lineItems) && data.lineItems.length > 0) {
        const extractedItems = data.lineItems.map((li: any) => {
          const qty = Number(li.quantity || 1);
          const price = Number(li.unitPrice || 0);
          const tax = Number(li.taxRate ?? 18);
          const sub = qty * price;
          const taxAmt = (sub * tax) / 100;
          const calculatedTotal = Math.round((sub + taxAmt) * 100) / 100;
          return {
            itemName: li.itemName || 'Item',
            description: li.description || (li.hsnCode ? `HSN: ${li.hsnCode}` : ''),
            quantity: qty,
            unitOfMeasure: li.uom || 'units',
            unitPrice: price,
            taxRate: tax,
            totalAmount: calculatedTotal
          };
        });
        setItems(extractedItems);
      }
      toast.success('Successfully extracted purchase order details and line items!');
    } catch (err: any) {
      toast.error(err.message || 'Auto-extraction failed; you may fill fields manually.');
    } finally {
      setExtractingPdf(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError('Please upload an authentic PDF document.');
      return;
    }

    if (file.size > 15 * 1024 * 1024) {
      setError('File size must be less than 15MB.');
      return;
    }

    setError(null);
    setUploadingPdf(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('category', 'purchase_order');
    formData.append('entityType', 'purchase_order');

    try {
      let res = await api.fetch('/api/files/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        // Fallback to /api/upload
        res = await api.fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || 'Upload failed');
      const payload = data?.data || data;
      const fileId = payload?.fileAsset?.id || payload?.fileAssetId || payload?.fileId || payload?.file?.id || payload?.id;
      if (!fileId) throw new Error('Server did not return a valid file asset ID');

      setPdfFileId(Number(fileId));
      setPdfFileName(file.name);
      toast.success('Official PO PDF attached successfully.');

      // Auto-extract if fields are empty or default (isolated so parsing warning does not fail attachment)
      try {
        if (!externalPoNumber || items.length <= 1) {
          await handleExtractFromPdf(file);
        }
      } catch (extractErr) {
        console.warn('Auto-extraction non-fatal notice:', extractErr);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to upload PDF file');
    } finally {
      setUploadingPdf(false);
      if (e.target) {
        e.target.value = '';
      }
    }
  };

  const handleSaveDraft = async (issueImmediately = false) => {
    setError(null);
    if (!title.trim()) {
      setError('Order Title is required.');
      return;
    }

    if (!items || items.length === 0) {
      setError('At least one line item is required.');
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.itemName.trim()) {
        setError(`Line Item #${i + 1} requires an item name.`);
        return;
      }
      if (item.quantity <= 0) {
        setError(`Line Item #${i + 1} ("${item.itemName}") quantity must be greater than zero.`);
        return;
      }
      if (item.unitPrice < 0) {
        setError(`Line Item #${i + 1} ("${item.itemName}") unit price cannot be negative.`);
        return;
      }
    }

    setSubmitting(true);
    try {
      const sanitizedItems = items.map((it) => ({
        id: it.id,
        itemName: it.itemName.trim(),
        description: it.description?.trim() || undefined,
        quantity: Number(it.quantity),
        unitOfMeasure: it.unitOfMeasure.trim() || 'units',
        unitPrice: Number(it.unitPrice),
        taxRate: Number(it.taxRate ?? 18),
        totalAmount: Number(it.totalAmount)
      }));

      if (mode === 'draft') {
        await putApi(`/api/purchase-orders/${order.id}/draft`, {
          title: title.trim(),
          externalPoNumber: externalPoNumber.trim() || undefined,
          expectedDelivery: expectedDelivery || undefined,
          deliveryAddress: deliveryAddress.trim() || undefined,
          paymentTerms: paymentTerms.trim() || undefined,
          externalPdfFileId: pdfFileId ?? null,
          items: sanitizedItems
        });

        if (issueImmediately) {
          await postApi(`/api/purchase-orders/${order.id}/issue`, {});
          toast.success('PO saved and officially issued to seller!');
        } else {
          toast.success('Draft PO updated successfully.');
        }
      } else {
        // Amend mode
        if (!amendmentReason.trim() || amendmentReason.trim().length < 5) {
          setError('Please provide a specific reason for this amendment (at least 5 characters).');
          setSubmitting(false);
          return;
        }

        await postApi(`/api/purchase-orders/${order.id}/amend`, {
          title: title.trim(),
          externalPoNumber: externalPoNumber.trim() || undefined,
          expectedDelivery: expectedDelivery || undefined,
          deliveryAddress: deliveryAddress.trim() || undefined,
          paymentTerms: paymentTerms.trim() || undefined,
          externalPdfFileId: pdfFileId ?? null,
          reason: amendmentReason.trim(),
          amendmentReason: amendmentReason.trim(),
          items: sanitizedItems
        });

        toast.success(`Amendment V${(order.amendmentVersion || 1) + 1} proposed! Awaiting seller acceptance.`);
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Operation failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddressSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === 'add_new') {
      setIsAddAddressModalOpen(true);
      return;
    }
    if (val === 'custom') {
      setIsCustomAddress(true);
    } else if (val === 'current_order') {
      setIsCustomAddress(false);
      let cleanAddress = typeof order?.deliveryAddress === 'string' ? order.deliveryAddress : '';
      cleanAddress = cleanAddress.replace(/\bLIMITI\b/gi, 'LIMITED');
      setDeliveryAddress(cleanAddress);
    } else if (val.startsWith('addr_')) {
      setIsCustomAddress(false);
      const id = Number(val.replace('addr_', ''));
      const found = savedAddresses.find((a) => a.id === id);
      if (found) {
        const fullAddr = formatDeliveryAddressString(found);
        setDeliveryAddress(fullAddr);
      }
    }
  };

  if (!isOpen || !order) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/70 p-3 sm:p-4 backdrop-blur-xs overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-po-modal-title"
    >
      <FocusTrap active={isOpen}>
        <div className="relative w-full max-w-3xl lg:max-w-4xl max-h-[92vh] overflow-y-auto rounded-3xl border border-slate-200 bg-white p-5 sm:p-7 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
          <div className="flex items-start justify-between border-b border-slate-100 pb-4">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200">
                <FileText className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h3 id="edit-po-modal-title" className="text-base font-black text-slate-900">
                  {mode === 'draft' ? 'Edit Draft Purchase Order' : `Propose PO Amendment (V${(order.amendmentVersion || 1) + 1})`}
                </h3>
                <p className="text-xs font-semibold text-slate-500">
                  PO #{order.poNumber || order.id} • Base Value: {formatCurrency(order.amount || order.totalValue)}
                  {order.seller?.organization?.organizationName && (
                    <span className="text-slate-700 font-bold"> • Supplier: {order.seller.organization.organizationName}</span>
                  )}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition"
              aria-label="Close dialog"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-5 space-y-4">
            {error && (
              <div
                className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold text-rose-700 flex items-center justify-between gap-2 animate-in fade-in"
                role="alert"
              >
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
                  <span>{error}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="p-1 text-rose-400 hover:text-rose-700 hover:bg-rose-100 rounded-md transition"
                  aria-label="Dismiss alert"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {mode === 'amend' && (
              <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-3.5 text-xs text-amber-900">
                <p className="font-bold flex items-center gap-1.5">
                  <AlertCircle className="h-4 w-4 text-amber-600" />
                  Amendment & Line-Item Revision Protocol:
                </p>
                <p className="mt-1 text-amber-800 leading-relaxed">
                  Modifying line item quantities, prices, or delivery terms creates a formal version snapshot with SHA-256 non-repudiation sealing. The supplier will be prompted to review and accept the revised terms before order execution continues.
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label htmlFor="po-edit-title" className="block text-xs font-black uppercase tracking-wider text-slate-700 mb-1.5">
                  Order Title / Subject <span className="text-rose-500">*</span>
                </label>
                <input
                  id="po-edit-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Supply of Industrial Bearings"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 shadow-2xs focus:border-[#12335f] focus:outline-none focus:ring-2 focus:ring-[#12335f]/20"
                  required
                />
              </div>

              <div>
                <label htmlFor="po-edit-external-po" className="block text-xs font-black uppercase tracking-wider text-slate-700 mb-1.5">
                  External ERP / PO Number (Optional)
                </label>
                <div className="relative">
                  <Hash className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    id="po-edit-external-po"
                    type="text"
                    value={externalPoNumber}
                    onChange={(e) => setExternalPoNumber(e.target.value)}
                    placeholder="e.g. 4500981244 or GEMC-5116877"
                    className="w-full rounded-xl border border-slate-300 bg-white pl-9 pr-3 py-2 text-xs font-mono font-bold text-slate-800 shadow-2xs focus:border-[#12335f] focus:outline-none focus:ring-2 focus:ring-[#12335f]/20"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="po-edit-expected-date" className="block text-xs font-black uppercase tracking-wider text-slate-700 mb-1.5">
                  Expected Delivery Date
                </label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    id="po-edit-expected-date"
                    type="date"
                    value={expectedDelivery}
                    onChange={(e) => setExpectedDelivery(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 bg-white pl-9 pr-3 py-2 text-xs font-bold text-slate-800 shadow-2xs focus:border-[#12335f] focus:outline-none focus:ring-2 focus:ring-[#12335f]/20"
                  />
                </div>
                {expectedDelivery && new Date(expectedDelivery) < new Date(new Date().toDateString()) && (
                  <p className="mt-1 text-[11px] font-bold text-amber-600 flex items-center gap-1" role="status">
                    <AlertCircle className="h-3 w-3 shrink-0" /> Selected date is in the past ({expectedDelivery}). Please verify.
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="po-edit-payment-terms" className="block text-xs font-black uppercase tracking-wider text-slate-700 mb-1.5">
                  Payment Terms
                </label>
                <div className="relative">
                  <CreditCard className="absolute left-3 top-2.5 h-4 w-4 text-slate-400 pointer-events-none" />
                  <select
                    id="po-edit-payment-terms"
                    value={isCustomPaymentTerms ? 'Other' : matchStandardPaymentTerms(paymentTerms)}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === 'Other') {
                        setIsCustomPaymentTerms(true);
                      } else {
                        setIsCustomPaymentTerms(false);
                        setPaymentTerms(val);
                      }
                    }}
                    className="w-full rounded-xl border border-slate-300 bg-white pl-9 pr-8 py-2 text-xs font-semibold text-slate-800 shadow-2xs focus:border-[#12335f] focus:outline-none focus:ring-2 focus:ring-[#12335f]/20 cursor-pointer appearance-none"
                  >
                    {STANDARD_PAYMENT_TERMS.map((term) => (
                      <option key={term.value} value={term.value}>{term.label}</option>
                    ))}
                    <option value="Other">Other / Custom Terms...</option>
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2.5 text-slate-400">
                    <ChevronDown className="h-4 w-4" />
                  </div>
                </div>
                {(isCustomPaymentTerms || matchStandardPaymentTerms(paymentTerms) === 'Other') && (
                  <input
                    type="text"
                    value={paymentTerms}
                    onChange={(e) => setPaymentTerms(e.target.value)}
                    placeholder="Enter custom payment schedule / terms..."
                    className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 shadow-2xs focus:border-[#12335f] focus:outline-none focus:ring-2 focus:ring-[#12335f]/20"
                  />
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="po-edit-address-select" className="block text-xs font-black uppercase tracking-wider text-slate-700">
                    Delivery / Consignee Address
                  </label>
                  <button
                    type="button"
                    onClick={() => setIsAddAddressModalOpen(true)}
                    className="inline-flex items-center gap-1 text-[11px] font-bold text-indigo-700 hover:text-indigo-900 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded-lg border border-indigo-200 transition-colors shrink-0 whitespace-nowrap cursor-pointer"
                  >
                    <Plus className="h-3 w-3" />
                    <span>Add Address</span>
                  </button>
                </div>
                <div className="relative">
                  <MapPin className="absolute left-3 top-2.5 h-4 w-4 text-slate-400 pointer-events-none" />
                  <select
                    id="po-edit-address-select"
                    value={activeAddressOption}
                    onChange={handleAddressSelectChange}
                    className="w-full rounded-xl border border-slate-300 bg-white pl-9 pr-8 py-2 text-xs font-semibold text-slate-800 shadow-2xs focus:border-[#12335f] focus:outline-none focus:ring-2 focus:ring-[#12335f]/20 cursor-pointer appearance-none truncate"
                  >
                    {savedAddresses.map((addr) => (
                      <option key={addr.id} value={`addr_${addr.id}`}>
                        {addr.addressLabel || addr.organizationName || 'Plant / Site'} ({addr.city}, {addr.state} - {addr.pincode})
                      </option>
                    ))}
                    {deliveryAddress && !matchingSavedAddress && (
                      <option value="current_order">
                        Current Order Address ({deliveryAddress.slice(0, 36)}...)
                      </option>
                    )}
                    <option value="add_new">+ Add New Delivery Address...</option>
                    <option value="custom">Custom / Manual Address Entry...</option>
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2.5 text-slate-400">
                    <ChevronDown className="h-4 w-4" />
                  </div>
                </div>
                <div className="mt-1.5">
                  <textarea
                    id="po-edit-address"
                    rows={2}
                    value={deliveryAddress}
                    onChange={(e) => {
                      setDeliveryAddress(e.target.value);
                      setIsCustomAddress(true);
                    }}
                    placeholder="e.g. Singhal Enterprises Pvt Ltd, Industrial Area, Jharsuguda, Odisha - 768201"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 shadow-2xs focus:border-[#12335f] focus:outline-none focus:ring-2 focus:ring-[#12335f]/20 resize-none leading-relaxed"
                  />
                </div>
                {deliveryAddress && deliveryAddress.trim().length > 0 && deliveryAddress.trim().length < 15 && (
                  <p className="mt-1 text-[11px] font-semibold text-amber-600 flex items-center gap-1" role="status">
                    <AlertCircle className="h-3 w-3 shrink-0" /> Full street address with PIN is recommended for consignee delivery.
                  </p>
                )}
              </div>
            </div>

            {/* ─── Line Items Editor ─── */}
            <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-[#12335f]" />
                  <h4 className="text-xs font-black uppercase tracking-wider text-[#12335f]">
                    Line Items & Quantities ({items.length})
                  </h4>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAddItem}
                  className="h-7 text-[11px] font-bold text-indigo-700 bg-indigo-50 border-indigo-200 hover:bg-indigo-100 flex items-center gap-1 rounded-lg"
                >
                  <Plus className="h-3.5 w-3.5" /> Add Line Item
                </Button>
              </div>

              <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                {items.map((item, idx) => (
                  <div
                    key={item.id ? `po-item-${item.id}` : `new-item-${idx}`}
                    className="rounded-xl border border-slate-200 bg-white p-3 shadow-2xs space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] font-bold text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
                        #{idx + 1}
                      </span>
                      <input
                        type="text"
                        placeholder="Item name / specification *"
                        value={item.itemName}
                        onChange={(e) => handleUpdateItem(idx, 'itemName', e.target.value)}
                        className="flex-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-bold text-slate-800 focus:border-[#12335f] focus:outline-none"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveItem(idx)}
                        disabled={items.length <= 1}
                        className="p-1 text-slate-400 hover:text-rose-600 disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Remove Item"
                        aria-label={`Remove Item ${idx + 1}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 text-xs items-start">
                      <div className="col-span-1 sm:col-span-2">
                        <label className="block text-[10px] font-bold text-slate-500 uppercase">Quantity *</label>
                        <input
                          type="number"
                          min="0.001"
                          step="any"
                          value={item.quantity}
                          onChange={(e) => handleUpdateItem(idx, 'quantity', parseFloat(e.target.value) || 0)}
                          className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono font-bold text-slate-800 focus:border-[#12335f] focus:outline-none"
                          required
                        />
                      </div>

                      <div className="col-span-1 sm:col-span-3">
                        <label className="block text-[10px] font-bold text-slate-500 uppercase">Unit</label>
                        <div className="space-y-1">
                          <select
                            value={matchStandardUom(item.unitOfMeasure)}
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val === 'Other') {
                                handleUpdateItem(idx, 'unitOfMeasure', matchStandardUom(item.unitOfMeasure) === 'Other' ? item.unitOfMeasure : '');
                              } else {
                                handleUpdateItem(idx, 'unitOfMeasure', val);
                              }
                            }}
                            className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-800 focus:border-[#12335f] focus:outline-none cursor-pointer truncate"
                          >
                            {STANDARD_UOM_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                            <option value="Other">Other / Custom...</option>
                          </select>
                          {matchStandardUom(item.unitOfMeasure) === 'Other' && (
                            <input
                              type="text"
                              value={item.unitOfMeasure}
                              onChange={(e) => handleUpdateItem(idx, 'unitOfMeasure', e.target.value)}
                              placeholder="Enter unit..."
                              className="w-full rounded-lg border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-800 focus:border-[#12335f] focus:outline-none"
                            />
                          )}
                        </div>
                      </div>

                      <div className="col-span-1 sm:col-span-3">
                        <label className="block text-[10px] font-bold text-slate-500 uppercase">Unit Price (₹) *</label>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={item.unitPrice}
                          onChange={(e) => handleUpdateItem(idx, 'unitPrice', parseFloat(e.target.value) || 0)}
                          className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono font-bold text-slate-800 focus:border-[#12335f] focus:outline-none"
                          required
                        />
                      </div>

                      <div className="col-span-1 sm:col-span-2">
                        <label className="block text-[10px] font-bold text-slate-500 uppercase">GST Rate (%)</label>
                        <select
                          value={item.taxRate}
                          onChange={(e) => handleUpdateItem(idx, 'taxRate', parseFloat(e.target.value) || 0)}
                          className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs font-semibold text-slate-800 focus:border-[#12335f] focus:outline-none cursor-pointer"
                        >
                          {![0, 5, 12, 18, 28].includes(item.taxRate) && (
                            <option value={item.taxRate}>{item.taxRate}% (Custom)</option>
                          )}
                          <option value="0">0%</option>
                          <option value="5">5%</option>
                          <option value="12">12%</option>
                          <option value="18">18%</option>
                          <option value="28">28%</option>
                        </select>
                      </div>

                      <div className="col-span-1 sm:col-span-2">
                        <label className="block text-[10px] font-bold text-slate-500 uppercase">HSN / SAC</label>
                        <input
                          type="text"
                          value={item.description || ''}
                          onChange={(e) => handleUpdateItem(idx, 'description', e.target.value)}
                          placeholder="e.g. 4819"
                          className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-slate-800 focus:border-[#12335f] focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between pt-1.5 border-t border-slate-100 text-[11px] gap-2">
                      <div className="flex items-center gap-2 text-slate-600 font-medium">
                        <span>Subtotal: <strong className="font-mono text-slate-800">{formatCurrency(item.quantity * item.unitPrice)}</strong></span>
                        <span className="text-slate-300">•</span>
                        <span>GST ({item.taxRate}%): <strong className="font-mono text-slate-800">{formatCurrency(((item.quantity * item.unitPrice) * (Number(item.taxRate) || 0)) / 100)}</strong></span>
                      </div>
                      <span className="font-mono font-black text-indigo-700 bg-indigo-50/70 px-2 py-0.5 rounded">
                        Line Total (incl. GST): {formatCurrency(item.totalAmount)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Dynamic Order Value Summary */}
              <div className="rounded-xl bg-white border border-slate-200 p-3.5 space-y-1.5 text-xs">
                <div className="flex items-center justify-between text-slate-600 font-medium">
                  <span>Taxable Subtotal:</span>
                  <span className="font-mono font-bold">{formatCurrency(subtotalTaxable)}</span>
                </div>
                <div className="flex items-center justify-between text-slate-600 font-medium">
                  <span>Applicable GST:</span>
                  <span className="font-mono font-bold">{formatCurrency(totalTax)}</span>
                </div>
                <div className="flex items-center justify-between border-t border-slate-200 pt-1.5 text-sm font-black text-slate-900">
                  <span className="flex items-center gap-1.5 text-[#12335f]">
                    <Calculator className="h-4 w-4" /> Revised PO Total:
                  </span>
                  <span className="font-mono text-indigo-700">
                    {formatCurrency(calculatedTotalValue)}
                  </span>
                </div>
              </div>
            </div>

            {/* Official PDF Document Upload & Extraction */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-black uppercase tracking-wider text-slate-700">
                  Official Buyer Purchase Order PDF (External ERP Document)
                </label>
                {pdfFileId && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                    <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                    Document Attached
                  </span>
                )}
              </div>

              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 p-4">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-indigo-700 shadow-2xs border border-slate-200">
                    {uploadingPdf || extractingPdf ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : pdfFileId ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                    ) : (
                      <Upload className="h-5 w-5" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-slate-800 truncate">
                      {pdfFileName || 'Upload official digitally signed PO PDF'}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {extractingPdf
                        ? 'Extracting PO number, line items, and delivery terms...'
                        : 'PDF format up to 15MB. Accessible to seller upon issuance.'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <label
                    htmlFor="po-pdf-file-upload"
                    className="cursor-pointer rounded-xl bg-white border border-slate-300 px-3 py-1.5 text-xs font-black text-slate-700 hover:bg-slate-50 transition shadow-2xs inline-block"
                  >
                    {pdfFileName ? 'Change PDF' : 'Select PDF'}
                  </label>
                  <input
                    id="po-pdf-file-upload"
                    type="file"
                    accept="application/pdf"
                    onChange={handleFileUpload}
                    className="sr-only"
                    disabled={uploadingPdf || extractingPdf || submitting}
                  />
                  {pdfFileId && (
                    <div className="flex items-center gap-1">
                      <a
                        href={`/api/files/${pdfFileId}/view`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 text-slate-400 hover:text-indigo-600 transition"
                        title="View Attached PDF"
                        aria-label="View Attached PDF"
                      >
                        <Eye className="h-4 w-4" />
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          setPdfFileId(null);
                          setPdfFileName('');
                          toast.info('Document attachment unlinked.');
                        }}
                        className="p-1.5 text-slate-400 hover:text-rose-600 transition"
                        title="Unlink PDF"
                        aria-label="Unlink PDF"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {mode === 'amend' && (
              <div>
                <label htmlFor="po-edit-amendment-reason" className="block text-xs font-black uppercase tracking-wider text-slate-700 mb-1.5">
                  Reason for Amendment (Required) <span className="text-rose-500">*</span>
                </label>
                <textarea
                  id="po-edit-amendment-reason"
                  rows={3}
                  value={amendmentReason}
                  onChange={(e) => setAmendmentReason(e.target.value)}
                  placeholder="State the reason for amending this purchase order (e.g. 'Quantity revised per site engineering change; unit price adjusted per mutual agreement')."
                  className="w-full rounded-xl border border-slate-300 bg-white p-3 text-xs text-slate-800 shadow-2xs focus:border-[#12335f] focus:outline-none focus:ring-2 focus:ring-[#12335f]/20 resize-none"
                  required
                />
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-slate-100">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={submitting}
                className="h-10 px-4 text-xs font-bold"
              >
                Cancel
              </Button>

              {mode === 'draft' ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleSaveDraft(false)}
                    disabled={submitting || uploadingPdf}
                    isLoading={submitting}
                    className="h-10 px-4 text-xs font-black uppercase tracking-wider border-slate-300 text-slate-800 hover:bg-slate-50"
                  >
                    Save Draft
                  </Button>
                  <Button
                    type="button"
                    onClick={() => handleSaveDraft(true)}
                    disabled={submitting || uploadingPdf}
                    isLoading={submitting}
                    className="h-10 px-4 bg-[#12335f] hover:bg-[#0e2a4f] text-white text-xs font-black uppercase tracking-wider shadow-sm flex items-center gap-1.5"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    <span>Save & Issue PO</span>
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  onClick={() => handleSaveDraft(false)}
                  disabled={submitting || uploadingPdf}
                  isLoading={submitting}
                  className="h-10 px-5 bg-indigo-700 hover:bg-indigo-800 text-white text-xs font-black uppercase tracking-wider shadow-sm flex items-center gap-1.5"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Submit Amendment</span>
                </Button>
              )}
            </div>
          </div>
        </div>
      </FocusTrap>

      <AddDeliveryAddressModal
        isOpen={isAddAddressModalOpen}
        onClose={() => setIsAddAddressModalOpen(false)}
        hasExistingAddresses={savedAddresses.length > 0}
        onAddressCreated={(newAddr) => {
          setSavedAddresses((prev) => [newAddr, ...prev]);
          const fullAddr = formatDeliveryAddressString(newAddr);
          setDeliveryAddress(fullAddr);
          setIsCustomAddress(false);
          setIsAddAddressModalOpen(false);
          toast.success('Address added and selected as delivery location.');
        }}
      />
    </div>
  );
}
