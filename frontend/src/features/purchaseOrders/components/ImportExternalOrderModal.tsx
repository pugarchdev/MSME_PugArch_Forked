'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  X,
  Upload,
  FileText,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Calendar,
  Building2,
  ShieldCheck,
  Plus,
  Trash2,
  HelpCircle,
  Search,
  ExternalLink,
  ChevronRight,
  Info
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../../components/ui/button';
import { api, readJsonResponse } from '../../../lib/api';
import { postApi } from '../../shared/apiClient';
import { formatCurrency } from '../../shared/format';
import { FocusTrap } from '../../../components/ui/FocusTrap';

interface EditableLineItem {
  itemName: string;
  description?: string;
  quantity: number | string;
  unitOfMeasure: string;
  unitPrice: number | string;
  taxRate: number;
  totalAmount: number;
}

const cleanNumberInput = (raw: string): string => {
  if (!raw) return '';
  let val = String(raw).replace(/[^0-9.]/g, '');
  const parts = val.split('.');
  if (parts.length > 2) {
    val = parts[0] + '.' + parts.slice(1).join('');
  }
  if (/^0[0-9]/.test(val)) {
    val = val.replace(/^0+/, '') || '0';
  }
  return val;
};

interface MatchedVendor {
  matched: boolean;
  matchType?: string;
  organization?: {
    id: number;
    organizationName: string;
    gstin?: string;
    panNumber?: string;
    erpVendorCode?: string;
  } | null;
  sellerUserId?: number | null;
  sellerUser?: {
    id: number;
    name: string;
    email: string;
  } | null;
}

interface SellerSearchResult {
  id: number;
  organizationName: string;
  gstin?: string;
  panNumber?: string;
  city?: string;
  state?: string;
  sellerUserId?: number | null;
  sellerUserName?: string | null;
}

export interface ImportExternalOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (newOrder: any) => void;
}

type Step = 'DROPZONE' | 'PROCESSING' | 'VERIFY';

export function ImportExternalOrderModal({
  isOpen,
  onClose,
  onSuccess
}: ImportExternalOrderModalProps) {
  const [step, setStep] = useState<Step>('DROPZONE');
  const [progressMessage, setProgressMessage] = useState('Processing document...');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // File & Document State
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileAssetId, setFileAssetId] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [originalName, setOriginalName] = useState('');

  // Status Banner State: strictly "Extracted via AI Model", "Extracted via Digital Record", or "Manual Review Mode Active"
  const [statusBanner, setStatusBanner] = useState<string>('Extracted via AI Model');
  const [extractionMode, setExtractionMode] = useState<string>('AI_MODEL');

  // Form Fields
  const [externalSystem, setExternalSystem] = useState<'SAP' | 'GEM' | 'TALLY' | 'CUSTOM' | 'GENERIC'>('SAP');
  const [externalPoNumber, setExternalPoNumber] = useState('');
  const [title, setTitle] = useState('');
  const [documentDate, setDocumentDate] = useState('');
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('STANDARD_NET_30');

  // Vendor Fields
  const [matchedVendor, setMatchedVendor] = useState<MatchedVendor | null>(null);
  const [selectedSellerOrgId, setSelectedSellerOrgId] = useState<number | null>(null);
  const [selectedSellerUserId, setSelectedSellerUserId] = useState<number | null>(null);
  const [selectedSellerOrgName, setSelectedSellerOrgName] = useState<string>('');
  const [selectedSellerGstin, setSelectedSellerGstin] = useState<string>('');
  const [erpVendorCode, setErpVendorCode] = useState('');
  const [saveAlias, setSaveAlias] = useState(true);

  // Manual Vendor Search
  const [isSearchingVendor, setIsSearchingVendor] = useState(false);
  const [searchVendorQuery, setSearchVendorQuery] = useState('');
  const [vendorSearchResults, setVendorSearchResults] = useState<SellerSearchResult[]>([]);
  const [showVendorSearchDropdown, setShowVendorSearchDropdown] = useState(false);

  // Line Items
  const [lineItems, setLineItems] = useState<EditableLineItem[]>([]);
  const [extractionMetadata, setExtractionMetadata] = useState<any>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset when opened
  useEffect(() => {
    if (isOpen) {
      setStep('DROPZONE');
      setSelectedFile(null);
      setFileAssetId(null);
      setPreviewUrl(null);
      setLineItems([]);
      setMatchedVendor(null);
      setSelectedSellerOrgId(null);
      setSelectedSellerUserId(null);
      setSelectedSellerOrgName('');
      setSelectedSellerGstin('');
      setErpVendorCode('');
      setExternalPoNumber('');
      setTitle('');
    }
  }, [isOpen]);

  // Clean up object URL
  useEffect(() => {
    return () => {
      if (previewUrl && previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  // Handle Drag & Drop / File Selection
  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processSelectedFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processSelectedFile(e.target.files[0]);
    }
  };

  const processSelectedFile = async (file: File) => {
    const validTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      toast.error('Please upload a PDF document or image file (PNG, JPG, WebP).');
      return;
    }

    if (file.size > 25 * 1024 * 1024) {
      toast.error('File size exceeds 25 MB limit.');
      return;
    }

    setSelectedFile(file);
    setOriginalName(file.name);
    const localBlobUrl = URL.createObjectURL(file);
    setPreviewUrl(localBlobUrl);

    setStep('PROCESSING');
    setProgressMessage('Processing document...');

    // Progress animation step 1
    const t1 = setTimeout(() => {
      setProgressMessage('Extracting order details and line items...');
    }, 1200);

    // Progress animation step 2
    const t2 = setTimeout(() => {
      setProgressMessage('Matching local MSME supplier and vendor codes...');
    }, 2400);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await api.post('/api/documents/extract', formData);
      const json = await readJsonResponse(res);
      const data = json?.data || json;

      clearTimeout(t1);
      clearTimeout(t2);

      if (!data || !data.fileAssetId) {
        throw new Error(json?.message || 'Failed to extract document contents');
      }

      setFileAssetId(data.fileAssetId);
      if (data.viewUrl) {
        setPreviewUrl(data.viewUrl);
      }

      // Status banner (vendor-neutral)
      const banner = data.statusBanner || (data.extractionMode === 'GRACEFUL_FALLBACK' ? 'Manual Review Mode Active' : 'Extracted via AI Model');
      setStatusBanner(banner);
      setExtractionMode(data.extractionMode || 'AI_MODEL');

      const extracted = data.data || {};
      setExtractionMetadata(extracted);

      // System detection
      const sys = (extracted.systemDetected || 'SAP').toUpperCase();
      if (['SAP', 'GEM', 'TALLY', 'CUSTOM', 'GENERIC'].includes(sys)) {
        setExternalSystem(sys as any);
      } else {
        setExternalSystem('SAP');
      }

      // External PO Number
      const poNum = extracted.poNumber || (extracted.invoiceNumber ? `REF-${extracted.invoiceNumber}` : '');
      setExternalPoNumber(poNum);

      // Title
      const detectedTitle = extracted.lineItems?.[0]?.itemName
        ? `Procurement of ${extracted.lineItems[0].itemName}${extracted.lineItems.length > 1 ? ` (+${extracted.lineItems.length - 1} items)` : ''}`
        : `Imported Order ${poNum ? `#${poNum}` : file.name}`;
      setTitle(detectedTitle);

      // Dates
      if (extracted.documentDate) {
        setDocumentDate(extracted.documentDate);
      }
      if (extracted.deliveryTerms?.expectedDeliveryDate) {
        setExpectedDeliveryDate(extracted.deliveryTerms.expectedDeliveryDate);
      }
      if (extracted.deliveryTerms?.deliveryAddress) {
        setDeliveryAddress(extracted.deliveryTerms.deliveryAddress);
      }
      if (extracted.deliveryTerms?.paymentTerms) {
        setPaymentTerms(extracted.deliveryTerms.paymentTerms);
      }

      // Seller / Vendor resolution
      const vendor: MatchedVendor = data.matchedVendor || { matched: false };
      setMatchedVendor(vendor);

      const sellerCode = extracted.sellerDetails?.erpVendorCode || vendor.organization?.erpVendorCode || '';
      setErpVendorCode(sellerCode);

      if (vendor.matched && vendor.organization) {
        setSelectedSellerOrgId(vendor.organization.id);
        setSelectedSellerOrgName(vendor.organization.organizationName);
        setSelectedSellerGstin(vendor.organization.gstin || '');
        setSelectedSellerUserId(vendor.sellerUserId || null);
      } else if (extracted.sellerDetails?.name) {
        setSelectedSellerOrgName(extracted.sellerDetails.name);
        setSelectedSellerGstin(extracted.sellerDetails.gstin || '');
      }

      // Line items
      const items: EditableLineItem[] = Array.isArray(extracted.lineItems) && extracted.lineItems.length > 0
        ? extracted.lineItems.map((li: any) => {
            const qty = Number(li.quantity || 1);
            const price = Number(li.unitPrice || 0);
            const tax = Number(li.taxRate ?? 18);
            const sub = qty * price;
            const taxAmt = (sub * tax) / 100;
            const calculatedTotal = Math.round((sub + taxAmt) * 100) / 100;
            const extractedTotal = Number(li.totalAmount || 0);

            // If extracted total equals the pre-tax subtotal and tax > 0, enforce the tax-inclusive total
            const finalTotal = (Math.abs(extractedTotal - sub) < 0.05 && tax > 0)
              ? calculatedTotal
              : (extractedTotal > 0 ? extractedTotal : calculatedTotal);

            return {
              itemName: li.itemName || 'Item',
              description: li.description || (li.hsnCode ? `HSN: ${li.hsnCode}` : ''),
              quantity: qty,
              unitOfMeasure: li.uom || 'NOS',
              unitPrice: price,
              taxRate: tax,
              totalAmount: finalTotal
            };
          })
        : [
            {
              itemName: 'Procurement Item',
              description: 'Extracted item',
              quantity: 1,
              unitOfMeasure: 'NOS',
              unitPrice: Number(extracted.financials?.grandTotal || 0),
              taxRate: 18,
              totalAmount: Number(extracted.financials?.grandTotal || 0)
            }
          ];

      setLineItems(items);
      setStep('VERIFY');

      if (banner === 'Manual Review Mode Active') {
        toast.info('Document loaded in manual review mode. Please verify the extracted fields.');
      } else {
        toast.success('Document analyzed successfully! Please verify details before importing.');
      }
    } catch (err: any) {
      clearTimeout(t1);
      clearTimeout(t2);
      loggerWarnOrToast(err);
      // Even on complete network or upload error, allow graceful manual entry
      setStep('VERIFY');
      setStatusBanner('Manual Review Mode Active');
      setExtractionMode('GRACEFUL_FALLBACK');
      setLineItems([
        {
          itemName: 'Procurement Item',
          description: '',
          quantity: 1,
          unitOfMeasure: 'NOS',
          unitPrice: 0,
          taxRate: 18,
          totalAmount: 0
        }
      ]);
    }
  };

  const loggerWarnOrToast = (err: any) => {
    const msg = err.message || 'Unable to automatically extract document';
    toast.error(msg);
  };

  // Vendor Search Handlers
  const handleVendorSearch = async (query: string) => {
    setSearchVendorQuery(query);
    if (query.trim().length < 2) {
      setVendorSearchResults([]);
      setShowVendorSearchDropdown(false);
      return;
    }

    setIsSearchingVendor(true);
    try {
      const res = await api.get(`/api/sellers/search?q=${encodeURIComponent(query.trim())}`);
      const json = await readJsonResponse(res);
      const list = json?.data || json || [];
      setVendorSearchResults(list);
      setShowVendorSearchDropdown(true);
    } catch {
      setVendorSearchResults([]);
    } finally {
      setIsSearchingVendor(false);
    }
  };

  const handleSelectVendor = (vendor: SellerSearchResult) => {
    setSelectedSellerOrgId(vendor.id);
    setSelectedSellerOrgName(vendor.organizationName);
    setSelectedSellerGstin(vendor.gstin || '');
    setSelectedSellerUserId(vendor.sellerUserId || null);
    setShowVendorSearchDropdown(false);
    setSearchVendorQuery('');
    setMatchedVendor({
      matched: true,
      matchType: 'MANUAL_SELECT',
      organization: {
        id: vendor.id,
        organizationName: vendor.organizationName,
        gstin: vendor.gstin,
        panNumber: vendor.panNumber
      },
      sellerUserId: vendor.sellerUserId,
      sellerUser: vendor.sellerUserName ? { id: vendor.sellerUserId || 0, name: vendor.sellerUserName, email: '' } : null
    });
  };

  // Line item manipulation
  const handleUpdateItem = (index: number, field: keyof EditableLineItem, value: any) => {
    setLineItems(prev => {
      const updated = [...prev];
      const cur = { ...updated[index], [field]: value };

      if (field === 'quantity' || field === 'unitPrice' || field === 'taxRate') {
        const qty = Number(cur.quantity || 0);
        const price = Number(cur.unitPrice || 0);
        const taxRate = Number(cur.taxRate || 0);
        const base = qty * price;
        const total = taxRate > 0 ? base + (base * taxRate) / 100 : base;
        cur.totalAmount = Math.round(total * 100) / 100;
      }

      updated[index] = cur;
      return updated;
    });
  };

  const handleAddItem = () => {
    setLineItems(prev => [
      ...prev,
      {
        itemName: '',
        description: '',
        quantity: 1,
        unitOfMeasure: 'NOS',
        unitPrice: 0,
        taxRate: 18,
        totalAmount: 0
      }
    ]);
  };

  const handleRemoveItem = (index: number) => {
    if (lineItems.length <= 1) {
      toast.error('Order must have at least one line item.');
      return;
    }
    setLineItems(prev => prev.filter((_, i) => i !== index));
  };

  // Financial totals
  const subtotal = useMemo(() => {
    return lineItems.reduce((acc, item) => {
      const qty = Number(item.quantity || 0);
      const price = Number(item.unitPrice || 0);
      return acc + qty * price;
    }, 0);
  }, [lineItems]);

  const totalAmount = useMemo(() => {
    return lineItems.reduce((acc, item) => acc + Number(item.totalAmount || 0), 0);
  }, [lineItems]);

  const totalTax = Math.max(0, totalAmount - subtotal);

  // Submit Order Import
  const handleImportOrder = async (isDraftMode: boolean = false) => {
    if (!externalPoNumber.trim()) {
      toast.error('External PO reference number is required.');
      return;
    }

    if (!selectedSellerOrgId) {
      toast.error('Please map or select a registered MSME supplier for this purchase order.');
      return;
    }

    if (!fileAssetId) {
      toast.error('Attached document asset is missing. Please re-upload the document.');
      return;
    }

    if (lineItems.some(item => !item.itemName.trim() || Number(item.quantity) <= 0)) {
      toast.error('All line items must have a valid item name and quantity greater than zero.');
      return;
    }

    setIsSubmitting(true);
    try {
      const sanitizedLineItems = lineItems.map(it => ({
        ...it,
        quantity: Number(it.quantity) || 1,
        unitPrice: Number(it.unitPrice) || 0,
        taxRate: Number(it.taxRate) || 0,
        totalAmount: Number(it.totalAmount) || 0
      }));

      const payload = {
        externalSystem,
        externalPoNumber: externalPoNumber.trim(),
        title: title.trim() || `External PO ${externalPoNumber}`,
        documentDate: documentDate || undefined,
        sellerOrgId: selectedSellerOrgId,
        sellerUserId: selectedSellerUserId || undefined,
        erpVendorCode: erpVendorCode.trim() || undefined,
        saveAlias: Boolean(saveAlias && erpVendorCode.trim()),
        fileAssetId,
        lineItems: sanitizedLineItems,
        deliveryTerms: {
          expectedDeliveryDate: expectedDeliveryDate || undefined,
          deliveryAddress: deliveryAddress.trim() || undefined,
          paymentTerms
        },
        isDraft: isDraftMode,
        extractionMetadata
      };

      const res = await postApi('/api/purchase-orders/import-external', payload);
      const createdPo = (res as any)?.data || res;

      toast.success(
        isDraftMode
          ? `Order saved as Draft! Ref: ${createdPo.poNumber || `PO-${createdPo.id}`}`
          : `External Purchase Order successfully imported and synchronized! Ref: ${createdPo.poNumber || `PO-${createdPo.id}`}`
      );

      onSuccess(createdPo);
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'Failed to import purchase order');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/75 p-2 sm:p-4 md:p-6 backdrop-blur-sm animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
    >
      <FocusTrap onEscape={() => !isSubmitting && onClose()} className="w-full max-w-7xl h-[94vh] flex flex-col">
        <div className="w-full h-full flex flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden">
          
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-900 px-5 py-3.5 text-white shrink-0">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500/20 text-blue-400 border border-blue-500/30">
                <FileText className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-sm sm:text-base font-black tracking-tight flex items-center gap-2">
                  Import External Order (ERP / Procurement)
                  <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-400/30">
                    Dual Sync
                  </span>
                </h2>
                <p className="text-[11px] font-medium text-slate-300">
                  Upload PDF PO or External Contract to automatically extract details and synchronize with local MSMEs.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
              aria-label="Close dialog"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Body Content */}
          <div className="flex-1 overflow-hidden flex flex-col">

            {/* STEP 1: DROPZONE */}
            {step === 'DROPZONE' && (
              <div className="flex-1 flex flex-col items-center justify-center p-6 sm:p-12 text-center bg-slate-50/50">
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleFileDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full max-w-2xl border-2 border-dashed border-slate-300 hover:border-[#12335f] rounded-2xl p-8 sm:p-12 bg-white flex flex-col items-center justify-center cursor-pointer transition-all hover:shadow-md group"
                >
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 text-[#12335f] group-hover:scale-110 transition-transform mb-4 border border-blue-100">
                    <Upload className="h-8 w-8" />
                  </div>
                  <h3 className="text-base sm:text-lg font-black text-slate-900 mb-1">
                    Drop your Purchase Order or Contract PDF here
                  </h3>
                  <p className="text-xs text-slate-500 max-w-md mb-6">
                    Supports official PDF contracts, purchase orders, scanned quotations, or invoice copies (PDF, PNG, JPG up to 25MB).
                  </p>

                  <div className="flex flex-wrap justify-center gap-2 mb-6">
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-600 bg-slate-100 px-3 py-1 rounded-lg">
                      <ShieldCheck className="h-3.5 w-3.5 text-blue-600" />
                      ERP PO (45xxxx)
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-600 bg-slate-100 px-3 py-1 rounded-lg">
                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                      External Contract (CONT-xxxx)
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-600 bg-slate-100 px-3 py-1 rounded-lg">
                      <ShieldCheck className="h-3.5 w-3.5 text-purple-600" />
                      ERP Vendor Alias Bridge
                    </span>
                  </div>

                  <Button
                    type="button"
                    className="bg-[#12335f] hover:bg-[#0e2a4f] text-white text-xs font-bold uppercase tracking-wider px-6 h-10 rounded-xl shadow-sm"
                  >
                    Select Document from Computer
                  </Button>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                </div>
              </div>
            )}

            {/* STEP 2: PROCESSING (Vendor-neutral UI animation) */}
            {step === 'PROCESSING' && (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-slate-50/60">
                <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 p-8 shadow-lg flex flex-col items-center">
                  <div className="relative mb-6">
                    <div className="h-16 w-16 rounded-2xl bg-blue-50 border border-blue-200 flex items-center justify-center text-[#12335f]">
                      <FileText className="h-8 w-8 animate-pulse" />
                    </div>
                    <Loader2 className="h-6 w-6 text-blue-600 animate-spin absolute -bottom-1 -right-1 bg-white rounded-full p-0.5 border border-blue-200 shadow-xs" />
                  </div>

                  <h3 className="text-base font-black text-slate-900 mb-2">
                    Analyzing Document
                  </h3>
                  <p className="text-xs font-semibold text-slate-600 mb-6 animate-pulse">
                    {progressMessage}
                  </p>

                  <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div className="bg-[#12335f] h-full w-2/3 rounded-full animate-indeterminate" />
                  </div>
                  <span className="text-[10px] text-slate-400 mt-3">
                    Parsing line items, tax components, and MSME identifiers...
                  </span>
                </div>
              </div>
            )}

            {/* STEP 3: SPLIT-PANE VERIFICATION WORKSPACE */}
            {step === 'VERIFY' && (
              <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
                
                {/* Left Pane: Document Preview (50%) */}
                <div className="w-full lg:w-1/2 h-1/2 lg:h-full border-b lg:border-b-0 lg:border-r border-slate-200 bg-slate-900 flex flex-col">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-slate-800 text-slate-200 border-b border-slate-700 text-xs font-semibold shrink-0">
                    <span className="truncate max-w-[280px]" title={originalName}>
                      📄 Original Document: {originalName}
                    </span>
                    <div className="flex items-center gap-2">
                      {previewUrl && (
                        <a
                          href={previewUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1"
                        >
                          Open in New Tab <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                        className="h-7 text-[10px] bg-slate-700 hover:bg-slate-600 text-white border-slate-600"
                      >
                        Replace File
                      </Button>
                    </div>
                  </div>

                  <div className="flex-1 bg-slate-950 flex items-center justify-center overflow-hidden">
                    {previewUrl ? (
                      selectedFile?.type.startsWith('image/') ? (
                        <div className="h-full w-full overflow-auto p-4 flex items-center justify-center">
                          <img
                            src={previewUrl}
                            alt="Original PO"
                            className="max-h-full max-w-full object-contain rounded shadow-lg"
                          />
                        </div>
                      ) : (
                        <iframe
                          src={`${previewUrl}#toolbar=0&navpanes=0`}
                          className="w-full h-full border-none"
                          title="Original PDF Document"
                        />
                      )
                    ) : (
                      <span className="text-slate-500 text-xs">Preview unavailable</span>
                    )}
                  </div>
                </div>

                {/* Right Pane: Form & Verification Controls (50%) */}
                <div className="w-full lg:w-1/2 h-1/2 lg:h-full flex flex-col bg-white">
                  
                  {/* Top Status Banner (Strict User Requirement) */}
                  <div className="px-5 py-3 border-b border-slate-200 bg-slate-50/80 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs font-bold text-slate-500">Extraction Mode:</span>
                      <span
                        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide border ${
                          statusBanner === 'Manual Review Mode Active'
                            ? 'bg-amber-50 text-amber-900 border-amber-300'
                            : 'bg-emerald-50 text-emerald-800 border-emerald-300'
                        }`}
                      >
                        <span
                          className={`h-2 w-2 rounded-full ${
                            statusBanner === 'Manual Review Mode Active'
                              ? 'bg-amber-500'
                              : 'bg-emerald-500 animate-pulse'
                          }`}
                        />
                        {statusBanner}
                      </span>
                    </div>

                    <span className="text-[11px] font-semibold text-slate-500">
                      Step 2 of 2: Verify & Confirm
                    </span>
                  </div>

                  {/* Scrollable Form Fields */}
                  <div className="flex-1 overflow-y-auto p-5 space-y-6">

                    {/* Section 1: Order Header */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                          <Info className="h-3.5 w-3.5 text-[#12335f]" />
                          1. Order Identification & Header
                        </h4>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-[11px] font-bold text-slate-700 mb-1">
                            System Detected
                          </label>
                          <select
                            value={externalSystem}
                            onChange={(e) => setExternalSystem(e.target.value as any)}
                            className="w-full h-9 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-800 outline-none focus:border-[#12335f] focus:ring-1 focus:ring-[#12335f]"
                          >
                            <option value="SAP">Enterprise ERP</option>
                            <option value="GEM">Procurement Portal</option>
                            <option value="TALLY">Tally Prime</option>
                            <option value="CUSTOM">Custom Enterprise</option>
                            <option value="GENERIC">Other / Standard PO</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-[11px] font-bold text-slate-700 mb-1">
                            External PO / Ref # <span className="text-rose-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={externalPoNumber}
                            onChange={(e) => setExternalPoNumber(e.target.value)}
                            placeholder="e.g. 4500192831"
                            className="w-full h-9 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-900 outline-none focus:border-[#12335f] focus:ring-1 focus:ring-[#12335f]"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-bold text-slate-700 mb-1">
                            Order Date
                          </label>
                          <input
                            type="date"
                            value={documentDate}
                            onChange={(e) => setDocumentDate(e.target.value)}
                            className="w-full h-9 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-900 outline-none focus:border-[#12335f]"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-slate-700 mb-1">
                          Order Subject / Title <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          placeholder="Brief description of procurement"
                          className="w-full h-9 rounded-xl border border-slate-200 px-3 text-xs font-semibold text-slate-800 outline-none focus:border-[#12335f]"
                        />
                      </div>
                    </div>

                    {/* Section 2: Local MSME Supplier & Vendor Code */}
                    <div className="space-y-3 pt-3 border-t border-slate-200">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                          <Building2 className="h-3.5 w-3.5 text-blue-600" />
                          2. Local MSME Supplier & ERP Vendor Code
                        </h4>
                        {matchedVendor?.matched && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                            <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                            Verified Local Match
                          </span>
                        )}
                      </div>

                      {/* Matched Seller Card */}
                      {selectedSellerOrgId ? (
                        <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3.5 flex items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-black text-slate-900">
                                {selectedSellerOrgName}
                              </span>
                              <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded">
                                Org #{selectedSellerOrgId}
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600">
                              {selectedSellerGstin && (
                                <span>GSTIN: <strong className="font-mono">{selectedSellerGstin}</strong></span>
                              )}
                              {matchedVendor?.sellerUser && (
                                <span>Contact: <strong>{matchedVendor.sellerUser.name}</strong></span>
                              )}
                            </div>
                          </div>

                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setSelectedSellerOrgId(null);
                              setSelectedSellerOrgName('');
                              setSelectedSellerGstin('');
                              setSelectedSellerUserId(null);
                            }}
                            className="h-7 text-[10px] text-slate-600 hover:text-rose-600 hover:bg-rose-50"
                          >
                            Change Supplier
                          </Button>
                        </div>
                      ) : (
                        <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 space-y-3">
                          <div className="flex items-start gap-2.5">
                            <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                            <div className="text-xs text-amber-900">
                              <p className="font-bold">No registered local MSME auto-matched yet.</p>
                              <p className="text-[11px] text-amber-800">
                                Search below to link this purchase order to a registered local supplier on the portal:
                              </p>
                            </div>
                          </div>

                          {/* Vendor Search Input */}
                          <div className="relative">
                            <div className="relative">
                              <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                              <input
                                type="text"
                                value={searchVendorQuery}
                                onChange={(e) => handleVendorSearch(e.target.value)}
                                placeholder="Search supplier by Company Name, GSTIN, or PAN..."
                                className="w-full h-9 pl-9 pr-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-900 outline-none focus:border-blue-500"
                              />
                              {isSearchingVendor && (
                                <Loader2 className="h-3.5 w-3.5 text-blue-600 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />
                              )}
                            </div>

                            {/* Dropdown list */}
                            {showVendorSearchDropdown && vendorSearchResults.length > 0 && (
                              <div className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white rounded-xl border border-slate-200 shadow-xl divide-y divide-slate-100">
                                {vendorSearchResults.map((org) => (
                                  <button
                                    key={org.id}
                                    type="button"
                                    onClick={() => handleSelectVendor(org)}
                                    className="w-full text-left p-2.5 hover:bg-blue-50 transition-colors flex items-center justify-between"
                                  >
                                    <div>
                                      <p className="text-xs font-bold text-slate-900">{org.organizationName}</p>
                                      <p className="text-[10px] text-slate-500">
                                        GSTIN: {org.gstin || 'N/A'} • {org.city || ''}, {org.state || ''}
                                      </p>
                                    </div>
                                    <ChevronRight className="h-4 w-4 text-slate-400" />
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* ERP Vendor Code & Alias Mapping */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                        <div>
                          <label className="block text-[11px] font-bold text-slate-700 mb-1">
                            Vendor / Supplier ID
                          </label>
                          <input
                            type="text"
                            value={erpVendorCode}
                            onChange={(e) => setErpVendorCode(e.target.value)}
                            placeholder="e.g. LIFNR 1004523"
                            className="w-full h-9 rounded-xl border border-slate-200 px-3 text-xs font-mono font-bold text-slate-900 outline-none focus:border-[#12335f]"
                          />
                        </div>

                        <div className="flex items-center pt-5">
                          <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700">
                            <input
                              type="checkbox"
                              checked={saveAlias}
                              onChange={(e) => setSaveAlias(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300 text-[#12335f] focus:ring-[#12335f]"
                            />
                            <span>Remember this ERP Vendor Code for future orders</span>
                          </label>
                        </div>
                      </div>
                    </div>

                    {/* Section 3: Line Items */}
                    <div className="space-y-3 pt-3 border-t border-slate-200">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-black uppercase tracking-wider text-slate-800">
                          3. Line Items & BOQ Details ({lineItems.length})
                        </h4>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleAddItem}
                          className="h-7 text-xs font-bold text-blue-700 border-blue-200 bg-blue-50/50 hover:bg-blue-100 flex items-center gap-1"
                        >
                          <Plus className="h-3 w-3" /> Add Item
                        </Button>
                      </div>

                      <div className="overflow-x-auto rounded-xl border border-slate-200">
                        <table className="w-full text-left text-xs border-collapse">
                          <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">
                            <tr>
                              <th className="p-2.5 w-6">#</th>
                              <th className="p-2.5 min-w-[160px]">Item Description</th>
                              <th className="p-2.5 w-20">Qty</th>
                              <th className="p-2.5 w-20">Unit</th>
                              <th className="p-2.5 w-24">Unit Price (₹)</th>
                              <th className="p-2.5 w-20">GST %</th>
                              <th className="p-2.5 w-28 text-right">Total (₹)</th>
                              <th className="p-2.5 w-10 text-center"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {lineItems.map((item, idx) => (
                              <tr key={idx} className="hover:bg-slate-50/50">
                                <td className="p-2 font-mono text-[10px] text-slate-400 text-center">
                                  {idx + 1}
                                </td>
                                <td className="p-2">
                                  <input
                                    type="text"
                                    value={item.itemName}
                                    onChange={(e) => handleUpdateItem(idx, 'itemName', e.target.value)}
                                    placeholder="Item name"
                                    className="w-full h-8 px-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-900 outline-none focus:border-[#12335f]"
                                  />
                                </td>
                                <td className="p-2">
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    value={item.quantity === '' ? '' : item.quantity}
                                    placeholder="1"
                                    onFocus={(e) => e.target.select()}
                                    onChange={(e) => handleUpdateItem(idx, 'quantity', cleanNumberInput(e.target.value))}
                                    onBlur={() => {
                                      const num = parseFloat(String(item.quantity));
                                      handleUpdateItem(idx, 'quantity', isNaN(num) || num <= 0 ? 1 : num);
                                    }}
                                    className="w-full h-8 px-2 rounded-lg border border-slate-200 text-xs font-mono font-bold text-slate-900 outline-none focus:border-[#12335f]"
                                  />
                                </td>
                                <td className="p-2">
                                  <input
                                    type="text"
                                    value={item.unitOfMeasure}
                                    onChange={(e) => handleUpdateItem(idx, 'unitOfMeasure', e.target.value.toUpperCase())}
                                    placeholder="NOS"
                                    className="w-full h-8 px-2 rounded-lg border border-slate-200 text-xs font-bold text-slate-800 uppercase outline-none focus:border-[#12335f]"
                                  />
                                </td>
                                <td className="p-2">
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    value={item.unitPrice === '' ? '' : item.unitPrice}
                                    placeholder="0.00"
                                    onFocus={(e) => e.target.select()}
                                    onChange={(e) => handleUpdateItem(idx, 'unitPrice', cleanNumberInput(e.target.value))}
                                    onBlur={() => {
                                      const num = parseFloat(String(item.unitPrice));
                                      handleUpdateItem(idx, 'unitPrice', isNaN(num) || num < 0 ? 0 : num);
                                    }}
                                    className="w-full h-8 px-2 rounded-lg border border-slate-200 text-xs font-mono font-bold text-slate-900 outline-none focus:border-[#12335f]"
                                  />
                                </td>
                                <td className="p-2">
                                  <input
                                    type="number"
                                    min="0"
                                    max="28"
                                    value={item.taxRate}
                                    onChange={(e) => handleUpdateItem(idx, 'taxRate', parseFloat(e.target.value) || 0)}
                                    className="w-full h-8 px-2 rounded-lg border border-slate-200 text-xs font-mono text-slate-800 outline-none focus:border-[#12335f]"
                                  />
                                </td>
                                <td className="p-2 text-right font-mono font-bold text-slate-900">
                                  {formatCurrency(item.totalAmount)}
                                </td>
                                <td className="p-2 text-center">
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveItem(idx)}
                                    className="p-1 text-slate-400 hover:text-rose-600 rounded"
                                    title="Remove item"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Financial Summary */}
                      <div className="flex justify-end pt-2">
                        <div className="w-full max-w-xs rounded-xl bg-slate-50 border border-slate-200 p-3 space-y-1.5 text-xs">
                          <div className="flex justify-between text-slate-600">
                            <span>Taxable Subtotal:</span>
                            <span className="font-mono font-bold">{formatCurrency(subtotal)}</span>
                          </div>
                          <div className="flex justify-between text-slate-600">
                            <span>Estimated Tax (GST):</span>
                            <span className="font-mono font-bold">{formatCurrency(totalTax)}</span>
                          </div>
                          <div className="border-t border-slate-200 pt-1.5 flex justify-between text-slate-900 font-bold text-sm">
                            <span>Grand Total:</span>
                            <span className="font-mono text-[#12335f]">{formatCurrency(totalAmount)}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Section 4: Delivery Terms */}
                    <div className="space-y-3 pt-3 border-t border-slate-200">
                      <h4 className="text-xs font-black uppercase tracking-wider text-slate-800">
                        4. Delivery & Terms
                      </h4>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-[11px] font-bold text-slate-700 mb-1">
                            Expected Delivery Date
                          </label>
                          <input
                            type="date"
                            value={expectedDeliveryDate}
                            onChange={(e) => setExpectedDeliveryDate(e.target.value)}
                            className="w-full h-9 rounded-xl border border-slate-200 px-3 text-xs font-semibold text-slate-800 outline-none"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-bold text-slate-700 mb-1">
                            Payment Terms
                          </label>
                          <input
                            type="text"
                            value={paymentTerms}
                            onChange={(e) => setPaymentTerms(e.target.value)}
                            placeholder="e.g. Net 30, Advance"
                            className="w-full h-9 rounded-xl border border-slate-200 px-3 text-xs font-semibold text-slate-800 outline-none"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-bold text-slate-700 mb-1">
                            Consignee / Delivery Address
                          </label>
                          <input
                            type="text"
                            value={deliveryAddress}
                            onChange={(e) => setDeliveryAddress(e.target.value)}
                            placeholder="Site / Plant address"
                            className="w-full h-9 rounded-xl border border-slate-200 px-3 text-xs font-semibold text-slate-800 outline-none"
                          />
                        </div>
                      </div>
                    </div>

                  </div>

                  {/* Modal Footer Controls */}
                  <div className="p-4 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3 shrink-0">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={onClose}
                      disabled={isSubmitting}
                      className="h-10 px-4 text-xs font-bold text-slate-600 rounded-xl"
                    >
                      Cancel
                    </Button>

                    <div className="flex items-center gap-2.5">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleImportOrder(true)}
                        disabled={isSubmitting}
                        className="h-10 px-4 text-xs font-black uppercase tracking-wider text-slate-700 border-slate-300 rounded-xl"
                      >
                        Save as Draft
                      </Button>

                      <Button
                        type="button"
                        onClick={() => handleImportOrder(false)}
                        disabled={isSubmitting}
                        className="h-10 px-5 text-xs font-black uppercase tracking-wider bg-[#12335f] hover:bg-[#0e2a4f] text-white rounded-xl shadow-md flex items-center gap-2 cursor-pointer"
                      >
                        {isSubmitting ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Importing Order...
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="h-4 w-4" />
                            Confirm & Synchronize PO
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                </div>

              </div>
            )}

          </div>

        </div>
      </FocusTrap>
    </div>
  );
}
