import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebounce } from "../hooks/useDebounce";
import { api, resolveMediaUrl } from "../lib/api";
import { formatDate, formatDateTime } from "../features/shared/format";
import { downloadCsv } from "../features/shared/exportUtils";
import { Button } from "../components/ui/button";
import { ResponsiveFilterBar } from "../components/ui/ResponsiveFilterBar";
import { Pagination } from "../features/shared/Pagination";
import { DataTable, ColumnDef } from "../components/ui/data-table";
import { useResponsiveViewMode } from "../features/shared/hooks";
import { ViewModeToggle } from "../features/shared/ViewModeToggle";
import { KpiCard } from "../features/shared/KpiCard";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Badge,
} from "../components/ui/card";
import { Tabs } from "../components/ui/tabs";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { toast } from "sonner";
import { useAuth } from "../hooks/useAuth";
import { COOKIE_SESSION_TOKEN } from "../lib/auth";
import { getFileAssetPreview, type DocumentPreview } from "../lib/files";
import { DocumentPreviewModal } from "../components/DocumentPreviewModal";
import { FocusTrap } from "../components/ui/FocusTrap";
import { isShgUser } from "../lib/shg";
import { MaskedDataDisplay } from "../components/ui/MaskedDataDisplay";
import {
  Search,
  Eye,
  CheckCircle,
  XCircle,
  Users,
  ShoppingBag,
  X,
  FileText,
  Check,
  ShieldCheck,
  MapPin,
  Building2,
  Briefcase,
  AlertTriangle,
  AlertCircle,
  Download,
  Filter,
  Clock,
  BarChart3,
  ClipboardCheck,
  RefreshCw,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  LayoutGrid,
  List,
  Loader2,
} from "lucide-react";
import { cn } from "../lib/utils";

const SELLER_ONBOARDING_DOCUMENT_TYPES = new Set([
  "pan",
  "pancard",
  "pan_card",
  "pan_copy",
  "gst",
  "gstcert",
  "gst_certificate",
  "udyam",
  "udyamcert",
  "udyam_certificate",
  "bank",
  "bankpassbook",
  "bank_passbook",
  "address",
  "addressproof",
  "address_proof",
  "aadhaar",
  "aadhaar_card",
  "regcert",
  "registration_certificate",
  "business_registration_proof",
  "dipp",
  "dipp_certificate",
  "itr",
  "itr_3_years",
  "nsic",
  "nsic_certificate",
  "iso",
  "iso_certificate",
  "iso_certified",
  "uploaded_files",
  "other",
]);

const getDocumentFiles = (document: any) => {
  if (!document) return [];
  return Array.isArray(document) ? document.filter(Boolean) : [document];
};

const getDocumentUrl = (document: any) =>
  typeof document === "string"
    ? document
    : document?.url || document?.signedUrl || document?.fileAsset?.url || (document?.fileId ? `/api/files/${document.fileId}/view` : "");

const DOCUMENT_LABELS: Record<string, string> = {
  pan: "PAN_COPY",
  panCard: "PAN_COPY",
  pan_copy: "PAN_COPY",
  panCopy: "PAN_COPY",
  PAN_COPY: "PAN_COPY",
  pan_card_group_representative: "PAN_COPY",
  regCert: "REGISTRATION_CERTIFICATE",
  registration_certificate: "REGISTRATION_CERTIFICATE",
  registrationCertificate: "REGISTRATION_CERTIFICATE",
  business_registration_proof: "REGISTRATION_CERTIFICATE",
  shg_registration_certificate: "SHG_REGISTRATION_CERTIFICATE",
  gstCert: "GST_CERTIFICATE",
  gst_certificate: "GST_CERTIFICATE",
  gstCertificate: "GST_CERTIFICATE",
  gst: "GST_CERTIFICATE",
  GST_CERTIFICATE: "GST_CERTIFICATE",
  addressProof: "ADDRESS_PROOF",
  address_proof: "ADDRESS_PROOF",
  addressProofDoc: "ADDRESS_PROOF",
  ADDRESS_PROOF: "ADDRESS_PROOF",
  udyamCert: "UDYAM_CERTIFICATE",
  udyam_cert: "UDYAM_CERTIFICATE",
  udyam_certificate: "UDYAM_CERTIFICATE",
  udyamCertificate: "UDYAM_CERTIFICATE",
  udyam: "UDYAM_CERTIFICATE",
  UDYAM_CERTIFICATE: "UDYAM_CERTIFICATE",
  bankPassbook: "BANK_PASSBOOK",
  bank_passbook: "BANK_PASSBOOK",
  cancelled_cheque: "BANK_PASSBOOK",
  cancelledCheque: "BANK_PASSBOOK",
  bank_passbook_cancelled_cheque: "BANK_PASSBOOK",
  BANK_PASSBOOK: "BANK_PASSBOOK",
  authLetter: "AUTHORIZATION_LETTER",
  auth_letter: "AUTHORIZATION_LETTER",
  authorization_letter: "AUTHORIZATION_LETTER",
  uploaded_files: "UPLOADED_FILES",
  leader_aadhaar: "GROUP_LEADER_AADHAAR_CARD",
  group_leader_aadhaar: "GROUP_LEADER_AADHAAR_CARD",
  member_list: "MEMBER_LIST",
  training_certificate: "TRAINING_SKILL_CERTIFICATE",
  training_skill_certificates: "TRAINING_SKILL_CERTIFICATE",
  skill_training_certificate: "TRAINING_SKILL_CERTIFICATE",
  product_photos: "PRODUCT_PHOTOS_CATALOGUE",
  product_images: "PRODUCT_PHOTOS_CATALOGUE",
  product_catalogue: "PRODUCT_PHOTOS_CATALOGUE",
  iso: "ISO_CERTIFICATE",
  iso_certificate: "ISO_CERTIFICATE",
  iso_certified: "ISO_CERTIFICATE",
  nsic_certificate: "NSIC_CERTIFICATE",
  dipp_certificate: "DIPP_CERTIFICATE",
  itr_3_years: "ITR_3_YEARS",
  nrlm_mission_certificate: "NRLM_MISSION_CERTIFICATE",
  produce_details: "PRODUCE_CROP_DETAILS",
  dairy_linkage_details: "DAIRY_SOCIETY_LINKAGE",
  business_activity_proof: "BUSINESS_ACTIVITY_PROOF",
  activity_details: "ACTIVITY_DETAILS",
  activity_specific_supporting_documents: "SUPPORTING_DOCUMENTS"
};

const getCanonicalDocCategory = (typeOrKey: unknown): string => {
  const raw = String(typeOrKey || "").trim();
  const label = DOCUMENT_LABELS[raw] || "";
  const s = (label || raw).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!s) return "";
  if (s.includes("udyam") || s.includes("msme")) return "udyam";
  if (s.includes("pan")) return "pan";
  if (s.includes("gst")) return "gst";
  if (s.includes("address")) return "address";
  if (s.includes("bank") || s.includes("passbook") || s.includes("cheque")) return "bank";
  if (s.includes("incorporation") || s.includes("regcert") || s.includes("registration") || s.includes("formation")) return "reg_cert";
  if (s.includes("auth")) return "auth_letter";
  if (s.includes("leader") || s.includes("aadhaar")) return "leader_aadhaar";
  if (s.includes("member")) return "member_list";
  if (s.includes("training") || s.includes("skill")) return "training_certificate";
  if (s.includes("photo") || s.includes("catalogue") || s.includes("image")) return "product_photos";
  if (s.includes("iso")) return "iso";
  if (s.includes("nsic")) return "nsic";
  if (s.includes("dipp")) return "dipp";
  if (s.includes("itr")) return "itr";
  if (s.includes("nrlm")) return "nrlm";
  if (s.includes("produce") || s.includes("crop")) return "produce";
  if (s.includes("dairy")) return "dairy";
  if (s.includes("activity")) return "activity";
  return s;
};

const getDocumentLabel = (key: string) =>
  DOCUMENT_LABELS[key] || String(key || "DOCUMENT").replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toUpperCase();

const getDocumentFileName = (file: any, fallback: string) =>
  file?.originalName || file?.fileAsset?.originalName || file?.name || file?.fileName || fallback;

const getDocumentUploadedAt = (file: any) =>
  file?.uploadedAt || file?.createdAt || file?.fileAsset?.createdAt || file?.file?.createdAt || null;

const normalizeDocType = (str: unknown) => String(str || "").toLowerCase().replace(/[\s-]+/g, "_");

const getSellerOnboardingDocuments = (profile: any) => {
  const sellerDocuments: any[] = [];
  const seenCategories = new Set<string>();
  const seenFileIds = new Set<string>();
  const seenUrls = new Set<string>();
  const seenFileNames = new Set<string>();

  // 1. Relational sellerDocuments from Prisma
  const rawSellerDocs = Array.isArray(profile?.sellerDocuments)
    ? profile.sellerDocuments.filter((doc: any) => Boolean(doc?.fileAsset))
    : [];

  for (const doc of rawSellerDocs) {
    const file = doc.fileAsset;
    const fileId = file?.id || doc.fileAssetId || null;
    const cat = getCanonicalDocCategory(doc.documentType);
    const url = getDocumentUrl(file) || (fileId ? `/api/files/${fileId}/view` : "");
    const fn = getDocumentFileName(file, "");

    if (fileId && seenFileIds.has(String(fileId))) continue;
    if (cat && seenCategories.has(cat)) continue;
    if (url && seenUrls.has(url.toLowerCase())) continue;
    if (fn && seenFileNames.has(fn.toLowerCase())) continue;

    if (fileId) seenFileIds.add(String(fileId));
    if (cat) seenCategories.add(cat);
    if (url) seenUrls.add(url.toLowerCase());
    if (fn) seenFileNames.add(fn.toLowerCase());

    sellerDocuments.push({
      ...doc,
      docType: doc.documentType,
      label: getDocumentLabel(doc.documentType),
      fileAssetId: fileId,
      fileId,
      url,
      fileAsset: file
    });
  }

  // 2. Fallback: JSON documents that have not been populated in relational sellerDocuments
  if (profile?.documents && typeof profile.documents === "object" && !Array.isArray(profile.documents)) {
    for (const [key, value] of Object.entries(profile.documents)) {
      const files = getDocumentFiles(value).filter(getDocumentUrl);
      if (files.length === 0) continue;

      const cat = getCanonicalDocCategory(key);
      if (cat && seenCategories.has(cat)) continue;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fileId = file?.fileId || file?.id || file?.fileAssetId || null;
        const url = getDocumentUrl(file) || (fileId ? `/api/files/${fileId}/view` : "");
        const fn = getDocumentFileName(file, "");

        if (fileId && seenFileIds.has(String(fileId))) continue;
        if (url && seenUrls.has(url.toLowerCase())) continue;
        if (fn && seenFileNames.has(fn.toLowerCase())) continue;

        if (fileId) seenFileIds.add(String(fileId));
        if (url) seenUrls.add(url.toLowerCase());
        if (fn) seenFileNames.add(fn.toLowerCase());

        sellerDocuments.push({
          id: `legacy-${key}-${i}-${fileId || url || fn}`,
          documentType: key,
          docType: key,
          label: getDocumentLabel(key),
          fileAssetId: fileId,
          fileId,
          url,
          uploadedAt: getDocumentUploadedAt(file),
          verificationStatus: 'PENDING',
          fileAsset: file
        });
      }

      if (cat) seenCategories.add(cat);
    }
  }

  return { sellerDocuments, legacyDocuments: [] };
};

const getBuyerOnboardingDocuments = (profile: any): [string, any[]][] => {
  if (!profile?.documents || typeof profile.documents !== 'object' || Array.isArray(profile.documents)) {
    return [];
  }

  const result: [string, any[]][] = [];
  const seenCategories = new Set<string>();
  const seenFileIds = new Set<string>();
  const seenUrls = new Set<string>();
  const seenFileNames = new Set<string>();
  const seenKeys = new Set<string>();

  for (const [key, value] of Object.entries(profile.documents)) {
    const files = getDocumentFiles(value).filter(getDocumentUrl);
    if (files.length === 0) continue;

    const cat = getCanonicalDocCategory(key);
    // Suppress redundant alias categories (e.g., gst and gstCert, pan and panCard, bank and bankPassbook, address and addressProof)
    if (cat && seenCategories.has(cat)) continue;

    const normKey = (key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seenKeys.has(normKey)) continue;

    const uniqueFiles = files.filter((file: any) => {
      const fid = file?.fileId || file?.id || file?.fileAssetId;
      if (fid && seenFileIds.has(String(fid))) return false;
      const url = getDocumentUrl(file);
      if (url && seenUrls.has(String(url).toLowerCase())) return false;
      const fn = getDocumentFileName(file, '');
      if (fn && seenFileNames.has(String(fn).toLowerCase())) return false;

      if (fid) seenFileIds.add(String(fid));
      if (url) seenUrls.add(String(url).toLowerCase());
      if (fn) seenFileNames.add(String(fn).toLowerCase());
      return true;
    });

    if (uniqueFiles.length === 0) continue;

    if (cat) seenCategories.add(cat);
    seenKeys.add(normKey);
    result.push([key, uniqueFiles]);
  }

  return result;
};


const MSME_TYPE_LABELS: Record<string, string> = {
  MSME: 'MSME',
  NON_MSME: 'Non-MSME',
  LOCAL_MSME: 'Local MSME',
  ANCILLARY_UNIT: 'Ancillary Unit',
  STARTUP_MSME: 'Startup MSME'
};

const VENDOR_TYPE_LABELS: Record<string, string> = {
  MANUFACTURER: 'Manufacturer',
  TRADER: 'Trader',
  DISTRIBUTOR: 'Distributor',
  DEALER: 'Dealer',
  SERVICE_PROVIDER: 'Service Provider',
  CONTRACTOR: 'Contractor',
  OEM: 'OEM',
  RETAIL_SUPPLIER: 'Retail Supplier',
  WHOLESALER: 'Wholesaler'
};

const REGISTRATION_TYPE_LABELS: Record<string, string> = {
  GST_REGISTERED: 'GST Registered',
  UDYAM_REGISTERED: 'UDYAM Registered',
  NSIC_REGISTERED: 'NSIC Registered',
  ISO_CERTIFIED: 'ISO Certified',
  PAN_AVAILABLE: 'PAN Available'
};

const getGstNumber = (item: any): string | undefined => {
  if (!item) return undefined;
  const officeGst = Array.isArray(item.profile?.offices)
    ? item.profile.offices.find((o: any) => o?.gstNumber)?.gstNumber
    : Array.isArray(item.offices)
      ? item.offices.find((o: any) => o?.gstNumber)?.gstNumber
      : undefined;

  const gst =
    item.profile?.gstin ||
    item.profile?.gst ||
    item.profile?.gstNumber ||
    officeGst ||
    item.organization?.gstin ||
    item.profile?.organization?.gstin ||
    item.gstin ||
    item.gst ||
    item.gstNumber ||
    item.registrationDetails?.gstin ||
    item.registrationDetails?.gst ||
    item.registrationDetails?.gstNumber ||
    item.registrationDetails?.gstDetails?.gstin ||
    item.registrationDetails?.gstDetails?.gstNumber ||
    item.profile?.gstVerificationDetails?.gstin ||
    undefined;
  return gst && String(gst).trim().length > 0 ? String(gst).trim() : undefined;
};

const isCiphertext = (val: unknown): boolean =>
  typeof val === "string" && (val.startsWith("enc:v1:") || val.startsWith("ENC:V1:") || val.toLowerCase().startsWith("enc:v1:"));

const getPanNumber = (item: any): string | undefined => {
  if (!item) return undefined;
  const candidates = [
    item.profile?.pan,
    item.profile?.panNumber,
    item.profile?.organization?.panNumber,
    item.organization?.panNumber,
    item.registrationDetails?.pan,
    item.registrationDetails?.orgPan,
    item.registrationDetails?.personalPan,
    item.registrationDetails?.gstDetails?.pan,
    item.profile?.gstVerificationDetails?.pan,
    item.pan,
  ];
  for (const c of candidates) {
    if (c && typeof c === "string" && c.trim().length > 0 && !isCiphertext(c)) {
      return c.trim();
    }
  }
  const gst = getGstNumber(item);
  if (gst && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i.test(gst)) {
    return gst.substring(2, 12).toUpperCase();
  }
  return undefined;
};

const getUdyamNumber = (item: any): string | undefined => {
  if (!item) return undefined;
  const udyam =
    item.profile?.udyamNumber ||
    item.profile?.udyam ||
    item.profile?.udyamRegistrationNumber ||
    item.organization?.udyamNumber ||
    item.profile?.organization?.udyamNumber ||
    item.udyamNumber ||
    item.udyam ||
    item.registrationDetails?.udyamNumber ||
    item.registrationDetails?.udyam ||
    item.registrationDetails?.udyamRegistrationNumber ||
    undefined;
  return udyam && String(udyam).trim().length > 0 ? String(udyam).trim() : undefined;
};

const getCinNumber = (item: any): string | undefined => {
  if (!item) return undefined;
  const cin =
    item.profile?.cinNumber ||
    item.profile?.cin ||
    item.profile?.cinNo ||
    item.organization?.cinNumber ||
    item.profile?.organization?.cinNumber ||
    item.cinNumber ||
    item.cin ||
    item.registrationDetails?.cinNumber ||
    item.registrationDetails?.cin ||
    item.registrationDetails?.cinNo ||
    undefined;
  return cin && String(cin).trim().length > 0 ? String(cin).trim() : undefined;
};

const getEntityAddress = (item: any) => {
  const profile = item?.profile || {};
  const primaryOffice = Array.isArray(profile.offices)
    ? profile.offices[0]
    : Array.isArray(item?.offices)
      ? item.offices[0]
      : {};
  const org = profile.organization || item?.organization || {};
  const regGst = item?.registrationDetails?.gstDetails || {};

  const street =
    primaryOffice?.address ||
    org?.addressLine1 ||
    profile?.registeredAddress ||
    regGst?.address ||
    item?.registrationDetails?.officeZoneName ||
    "";

  const city =
    primaryOffice?.city ||
    profile?.city ||
    org?.city ||
    regGst?.city ||
    "";

  const district =
    primaryOffice?.district ||
    profile?.district ||
    org?.district ||
    regGst?.district ||
    item?.registrationDetails?.district ||
    "";

  const state =
    primaryOffice?.state ||
    profile?.state ||
    org?.state ||
    regGst?.state ||
    item?.registrationDetails?.state ||
    "";

  const pincode =
    primaryOffice?.pincode ||
    profile?.pincode ||
    org?.pincode ||
    regGst?.pincode ||
    item?.registrationDetails?.pincode ||
    "";

  const fullAddress = [street, city, district, state, pincode]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(", ");

  return { street, city, district, state, pincode, fullAddress };
};

const getBankDetails = (item: any) => {
  const profile = item?.profile || {};
  const primaryBank = Array.isArray(profile.bankAccounts) ? profile.bankAccounts[0] : {};
  const regDetails = item?.registrationDetails || {};

  const bankName = primaryBank?.bankName || regDetails.bankName || "";
  const accountNumber = primaryBank?.accountNumber || primaryBank?.accountNumberMasked || regDetails.accountNumber || "";
  const ifscCode = primaryBank?.ifscCode || primaryBank?.ifsc || regDetails.ifscCode || "";
  const accountHolderName = primaryBank?.accountHolderName || regDetails.accountName || item?.name || "";

  return { bankName, accountNumber, ifscCode, accountHolderName };
};

const toAbsoluteFileUrl = (urlOrAsset: any): string => {
  if (!urlOrAsset) return "";
  let rawUrl = "";
  if (typeof urlOrAsset === "string") {
    rawUrl = urlOrAsset;
  } else if (urlOrAsset?.url) {
    rawUrl = urlOrAsset.url;
  } else if (urlOrAsset?.signedUrl) {
    rawUrl = urlOrAsset.signedUrl;
  } else if (urlOrAsset?.fileAsset?.url) {
    rawUrl = urlOrAsset.fileAsset.url;
  } else if (urlOrAsset?.fileAssetId || urlOrAsset?.fileId || urlOrAsset?.id) {
    const id = urlOrAsset?.fileAssetId || urlOrAsset?.fileId || urlOrAsset?.id;
    rawUrl = `/api/files/${id}/view`;
  }
  rawUrl = String(rawUrl || "").trim();
  if (!rawUrl) return "";
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    return rawUrl;
  }
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;
};

const getExportDocumentLinks = (item: any) => {
  const profile = item?.profile || {};
  const regDetails = item?.registrationDetails || {};

  const docMap: Record<string, string[]> = {
    pan: [],
    gst: [],
    udyam: [],
    bank: [],
    address: [],
    registration: [],
    additional: [],
    all: [],
  };

  const addDoc = (category: keyof typeof docMap, label: string, urlCandidate: any) => {
    const url = toAbsoluteFileUrl(urlCandidate);
    if (!url) return;
    if (!docMap[category].includes(url)) {
      docMap[category].push(url);
    }
    const formatted = `${label}: ${url}`;
    if (!docMap.all.includes(formatted)) {
      docMap.all.push(formatted);
    }
  };

  const classifyAndAdd = (type: string, urlCandidate: any, customLabel?: string) => {
    const norm = String(type || "").toLowerCase().replace(/[\s-]+/g, "_");
    const label = customLabel || getDocumentLabel(type);

    if (norm.includes("pan")) {
      addDoc("pan", label, urlCandidate);
    } else if (norm.includes("gst")) {
      addDoc("gst", label, urlCandidate);
    } else if (norm.includes("udyam") || norm.includes("msme")) {
      addDoc("udyam", label, urlCandidate);
    } else if (norm.includes("bank") || norm.includes("passbook") || norm.includes("cheque")) {
      addDoc("bank", label, urlCandidate);
    } else if (norm.includes("address")) {
      addDoc("address", label, urlCandidate);
    } else if (
      norm.includes("reg") ||
      norm.includes("incorporation") ||
      norm.includes("business_registration")
    ) {
      addDoc("registration", label, urlCandidate);
    } else {
      addDoc("additional", label, urlCandidate);
    }
  };

  // 1. Process profile.sellerDocuments
  if (Array.isArray(profile.sellerDocuments)) {
    for (const doc of profile.sellerDocuments) {
      if (doc?.fileAsset) {
        classifyAndAdd(doc.documentType || "DOCUMENT", doc.fileAsset);
      }
    }
  }

  // 2. Process profile.documents (JSON object)
  if (profile.documents && typeof profile.documents === "object" && !Array.isArray(profile.documents)) {
    for (const [key, value] of Object.entries(profile.documents)) {
      const files = getDocumentFiles(value);
      for (const file of files) {
        classifyAndAdd(key, file);
      }
    }
  }

  // 3. Process regDetails.documents
  if (regDetails.documents && typeof regDetails.documents === "object" && !Array.isArray(regDetails.documents)) {
    for (const [key, value] of Object.entries(regDetails.documents)) {
      const files = getDocumentFiles(value);
      for (const file of files) {
        classifyAndAdd(key, file);
      }
    }
  }

  // 4. Process certifications
  if (Array.isArray(profile.certifications)) {
    for (const cert of profile.certifications) {
      if (cert?.fileAsset) {
        classifyAndAdd(cert.name || cert.type || "CERTIFICATION", cert.fileAsset);
      }
    }
  }

  return {
    panLink: docMap.pan.join(" ; "),
    gstLink: docMap.gst.join(" ; "),
    udyamLink: docMap.udyam.join(" ; "),
    bankLink: docMap.bank.join(" ; "),
    addressLink: docMap.address.join(" ; "),
    registrationLink: docMap.registration.join(" ; "),
    additionalLinks: docMap.additional.join(" ; "),
    allLinks: docMap.all.join(" | "),
  };
};

export default function AdminOnboarding() {
  const queryClient = useQueryClient();
  const { user, token, loading: isAuthLoading } = useAuth();

  const isAuthorizedAdmin = Boolean(
    user && ['admin', 'master_admin'].includes(String(user.role).toLowerCase())
  );

  const authHeaders = useMemo<Record<string, string>>(() => {
    const headers: Record<string, string> = {};
    const t = token || (typeof window !== 'undefined' ? localStorage.getItem('token') : null);
    if (t && t !== COOKIE_SESSION_TOKEN && t !== 'null' && t !== 'undefined') {
      headers.Authorization = `Bearer ${t}`;
    }
    return headers;
  }, [token]);

  const authOptions = useMemo<RequestInit>(() => ({
    headers: authHeaders
  }), [authHeaders]);

  const [sellers, setSellers] = useState<any[]>([]);
  const [buyers, setBuyers] = useState<any[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [activeTab, setActiveTab] = useState(() => {
    if (typeof window === "undefined") return "sellers";
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (["sellers", "buyers", "shg"].includes(String(tab))) return String(tab);
    const saved = sessionStorage.getItem("admin_onboarding_tab");
    return ["sellers", "buyers", "shg"].includes(String(saved)) ? String(saved) : "sellers";
  });

  const handleTabChange = useCallback((newTab: string) => {
    setActiveTab(newTab);
    if (typeof window !== "undefined") {
      sessionStorage.setItem("admin_onboarding_tab", newTab);
      const url = new URL(window.location.href);
      url.searchParams.set("tab", newTab);
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const sp = new URLSearchParams(window.location.search);
      const tab = sp.get("tab");
      if (["sellers", "buyers", "shg"].includes(String(tab))) {
        setActiveTab(String(tab));
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearchTerm = useDebounce(searchTerm, 400);

  const [statusFilter, setStatusFilter] = useState("all");
  const [progressFilter, setProgressFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [showcaseItems, setShowcaseItems] = useState<any[]>([]);
  const [showcaseItemsLoading, setShowcaseItemsLoading] = useState(false);
  const [showcaseActive, setShowcaseActive] = useState(true);
  const [previewDocument, setPreviewDocument] = useState<DocumentPreview | null>(null);
  const [viewingDocKey, setViewingDocKey] = useState<string | number | null>(null);
  const handleClosePreview = useCallback(() => setPreviewDocument(null), []);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(10);

  // Rejection Modal State
  const [isRejectModalOpen, setIsRejectModalOpen] = useState(false);
  const [activeSectionForRejection, setActiveSectionForRejection] =
    useState("");
  const [rejectionReason, setRejectionReason] = useState("");

  // Document-Level Targeted Request State
  const [isDocRequestModalOpen, setIsDocRequestModalOpen] = useState(false);
  const [docRequestTarget, setDocRequestTarget] = useState<{ documentType: string; label: string } | null>(null);
  const [docRequestReason, setDocRequestReason] = useState("");
  const [isSubmittingDocRequest, setIsSubmittingDocRequest] = useState(false);

  // Application Correction Modal State
  const [isCorrectionModalOpen, setIsCorrectionModalOpen] = useState(false);
  const [correctionReason, setCorrectionReason] = useState("");
  const [isSubmittingCorrection, setIsSubmittingCorrection] = useState(false);

  // Application Rejection Modal State
  const [isAppRejectModalOpen, setIsAppRejectModalOpen] = useState(false);
  const [appRejectReason, setAppRejectReason] = useState("");
  const [isSubmittingAppReject, setIsSubmittingAppReject] = useState(false);
  const isSectionActionBusyRef = useRef(false);
  const isStatusUpdatingRef = useRef(false);

  // Override Modal State
  const [isOverrideModalOpen, setIsOverrideModalOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);

  const isAnySubModalOpen =
    isRejectModalOpen ||
    isOverrideModalOpen ||
    isDocRequestModalOpen ||
    isCorrectionModalOpen ||
    isAppRejectModalOpen;

  // View / Toolbar UI state
  const [viewMode, setViewMode] = useResponsiveViewMode();
  const scrutinyModalScrollRef = useRef<HTMLDivElement | null>(null);

  // 1. Fetch KPI stats (shares key and cache with dashboard/MISReports)
  const { data: adminStats, isLoading: isAdminStatsLoading, error: adminStatsError } = useQuery({
    queryKey: ['adminStats', user?.id],
    queryFn: async () => {
      const res = await api.fetch('/api/admin/reports/summary?kpiOnly=true', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch stats');
      const json = await res.json();
      return json?.data ?? json;
    },
    enabled: isAuthorizedAdmin,
    staleTime: 60_000,
  });

  // 2. Fetch registrations list query
  const {
    data: onboardingData,
    isLoading: isOnboardingLoading,
    error: onboardingError,
    refetch: refetchOnboarding
  } = useQuery({
    queryKey: ['adminOnboardingList', user?.id],
    queryFn: async () => {
      const res = await api.fetch("/api/admin/onboarding?pageSize=1000", { headers: authHeaders });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const err = new Error(errJson?.message || errJson?.error || `Failed to load onboarding records (${res.status})`);
        (err as any).status = res.status;
        throw err;
      }
      const json = await res.json();
      return json?.data ?? json;
    },
    enabled: isAuthorizedAdmin,
    staleTime: 60_000,
  });

  const isLoading = isOnboardingLoading || (isAuthLoading && !user);

  useEffect(() => {
    if (onboardingData) {
      const s = Array.isArray(onboardingData.sellers)
        ? onboardingData.sellers
        : Array.isArray(onboardingData.data?.sellers)
          ? onboardingData.data.sellers
          : [];
      const b = Array.isArray(onboardingData.buyers)
        ? onboardingData.buyers
        : Array.isArray(onboardingData.data?.buyers)
          ? onboardingData.data.buyers
          : [];
      setSellers(s);
      setBuyers(b);
    }
  }, [onboardingData]);

  useEffect(() => {
    if (selectedItem) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      const handleKeyDown = (e: KeyboardEvent) => {
        if (
          e.key === 'Escape' &&
          !isRejectModalOpen &&
          !isOverrideModalOpen &&
          !isDocRequestModalOpen &&
          !isCorrectionModalOpen &&
          !isAppRejectModalOpen &&
          !previewDocument
        ) {
          setSelectedItem(null);
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => {
        document.body.style.overflow = prev;
        window.removeEventListener('keydown', handleKeyDown);
      };
    }
  }, [
    selectedItem,
    isRejectModalOpen,
    isOverrideModalOpen,
    isDocRequestModalOpen,
    isCorrectionModalOpen,
    isAppRejectModalOpen,
    previewDocument,
  ]);

  useEffect(() => {
    if (selectedItem && selectedItem.role === "buyer" && selectedItem.profile?.id) {
      const fetchAdminShowcase = async () => {
        setShowcaseItemsLoading(true);
        try {
          const res = await api.fetch(`/api/buyer-showcase/admin/organizations/${selectedItem.profile.id}/items`, {
            headers: authHeaders
          });
          if (res.ok) {
            const body = await res.json();
            setShowcaseItems(body.data || []);
          }
        } catch (err) {
          console.error("Failed to fetch admin showcase items", err);
        } finally {
          setShowcaseItemsLoading(false);
        }
      };
      void fetchAdminShowcase();
      queueMicrotask(() => {
        setShowcaseActive(selectedItem.profile?.isActive ?? true);
      });
    } else {
      queueMicrotask(() => {
        setShowcaseItems([]);
      });
    }
  }, [selectedItem]);

  const handleToggleShowcaseVisibility = async (checked: boolean) => {
    if (!selectedItem?.profile?.id) return;
    try {
      const res = await api.post(
        `/api/buyer-showcase/admin/organizations/${selectedItem.profile.id}/visibility`,
        { isActive: checked },
        {
          headers: {
            ...authHeaders,
            'Content-Type': 'application/json'
          }
        }
      );
      if (res.ok) {
        setShowcaseActive(checked);
        setSelectedItem((prev: any) => {
          if (!prev || !prev.profile) return prev;
          return {
            ...prev,
            profile: {
              ...prev.profile,
              isActive: checked
            }
          };
        });
        toast.success(checked ? "Showcase visibility activated" : "Showcase visibility deactivated");
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.message || "Failed to update visibility");
      }
    } catch (err) {
      console.error(err);
      toast.error("Network error updating visibility");
    }
  };

  const handleUpdateShowcaseStatus = async (status: 'VERIFIED' | 'REJECTED' | 'PENDING') => {
    if (!selectedItem?.profile?.id) return;
    try {
      const res = await api.post(
        `/api/buyer-showcase/admin/organizations/${selectedItem.profile.id}/status`,
        { status },
        {
          headers: {
            ...authHeaders,
            'Content-Type': 'application/json'
          }
        }
      );
      if (res.ok) {
        setSelectedItem((prev: any) => {
          if (!prev || !prev.profile) return prev;
          return {
            ...prev,
            profile: {
              ...prev.profile,
              verificationStatus: status
            }
          };
        });
        toast.success(`Showcase status updated to ${status}`);
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.message || "Failed to update showcase status");
      }
    } catch (err) {
      console.error(err);
      toast.error("Network error updating showcase status");
    }
  };


  /**
   * Open the scrutiny modal with the heavy detail (full profile, offices,
   * banks, certs, docs) already in place so review data appears instantly.
   *
   * Detail is fetched from /admin/onboarding/:id, but we cache every fetched
   * record in `detailCacheRef` and prefetch the visible rows (and on hover),
   * so by the time a reviewer clicks "Review" the data is usually already
   * resident — the modal renders complete immediately with no spinner/flash.
   * If the cache misses, we still show the lightweight row instantly and merge
   * the detail in as soon as it lands.
   */
  const detailCacheRef = useRef<Map<string, any>>(new Map());
  const inFlightRef = useRef<Map<string, Promise<any>>>(new Map());

  const fetchDetail = useCallback(async (item: any): Promise<any> => {
    const key = String(item._id || item.id);
    if (!key) return null;
    if (detailCacheRef.current.has(key)) return detailCacheRef.current.get(key);
    if (inFlightRef.current.has(key)) return inFlightRef.current.get(key);

    const promise = (async () => {
      try {
        const res = await api.fetch(`/api/admin/onboarding/${key}`, { ...authOptions, skipCache: true });
        if (!res.ok) return null;
        const payload = await res.json();
        const detail = payload?.data || payload;
        if (detail) detailCacheRef.current.set(key, detail);
        return detail;
      } catch {
        return null;
      } finally {
        inFlightRef.current.delete(key);
      }
    })();

    inFlightRef.current.set(key, promise);
    return promise;
  }, [authOptions]);

  // Warm the cache without opening the modal (hover / visible rows).
  const prefetchDetail = useCallback((item: any) => {
    const key = String(item?._id || item?.id || "");
    if (!key || detailCacheRef.current.has(key) || inFlightRef.current.has(key)) return;
    void fetchDetail(item);
  }, [fetchDetail]);

  const [isDetailLoading, setIsDetailLoading] = useState(false);

  const openItemForReview = async (item: any) => {
    const key = String(item._id || item.id);
    setDocRequestReason("");
    setIsDocRequestModalOpen(false);
    setDocRequestTarget(null);
    setCorrectionReason("");
    setIsCorrectionModalOpen(false);
    setAppRejectReason("");
    setIsAppRejectModalOpen(false);

    // If detail is already cached, render the complete record immediately.
    const cached = detailCacheRef.current.get(key);
    if (cached) {
      setSelectedItem({ ...item, ...cached });
      setIsDetailLoading(false);
      return;
    }

    // Otherwise show the lightweight row instantly and track detail loading.
    setSelectedItem(item);
    setIsDetailLoading(true);
    const detail = await fetchDetail(item);
    setIsDetailLoading(false);
    if (detail) {
      setSelectedItem((prev: any) =>
        prev && (prev._id === item._id || prev._id === item.id || prev.id === item.id)
          ? { ...prev, ...detail }
          : prev,
      );
    }
  };

  const handleUpdateStatus = async (
    userId: string,
    status: string,
    customOverrideReason?: string,
  ) => {
    if (!selectedItem || selectedItem._id !== userId || isStatusUpdatingRef.current) return;
    isStatusUpdatingRef.current = true;

    const selectedFlags = selectedItem.complianceViolations || [];
    let reason = "";
    if (
      status === "approved_for_procurement" &&
      selectedFlags.some((flag: any) =>
        ["medium", "high", "critical"].includes(flag.severity),
      )
    ) {
      if (customOverrideReason === undefined) {
        // Open override modal and stop execution to await user input
        setIsOverrideModalOpen(true);
        setOverrideReason("");
        return;
      }
      reason = customOverrideReason;
      if (!reason.trim()) {
        toast.error("Admin override reason is required for flagged approvals");
        return;
      }
    }

    // 1. Keep a backup of the previous state
    const previousSelectedItem = { ...selectedItem };
    const previousSellers = [...sellers];
    const previousBuyers = [...buyers];

    // 2. Compute the new state optimistically
    const isBuyer = selectedItem.role === "buyer";
    const buyerKeys = ["org", "rep", "address", "procurement", "docs"];
    const sellerKeys = [
      "pan",
      "details",
      "additional",
      "offices",
      "bank",
      "documents",
    ];
    const keys = isBuyer ? buyerKeys : sellerKeys;

    let updatedSectionStatus = selectedItem.sectionStatus;
    if (status === "approved_for_procurement") {
      updatedSectionStatus = Object.fromEntries(keys.map((k) => [k, "approved"]));
    } else if (status === "rejected") {
      updatedSectionStatus = Object.fromEntries(keys.map((k) => [k, "rejected"]));
    }

    const updatedItem = {
      ...selectedItem,
      onboardingStatus: status,
      sectionStatus: updatedSectionStatus,
      adminFeedback: reason || selectedItem.adminFeedback,
    };

    // 3. Apply optimistic state updates
    setSelectedItem(updatedItem);

    const updateListItem = (prevList: any[]) =>
      prevList.map((item) =>
        item._id === userId
          ? {
            ...item,
            onboardingStatus: status,
            sectionStatus: updatedSectionStatus,
            adminFeedback: reason || item.adminFeedback,
          }
          : item,
      );

    if (isBuyer) {
      setBuyers(updateListItem);
    } else {
      setSellers(updateListItem);
    }

    // Close override modal instantly if open
    setIsOverrideModalOpen(false);
    setOverrideReason("");

    // 4. Make the backend API request
    try {
      const numericId = Number(userId) || selectedItem?.id;
      const res = await api.post(
        `/api/admin/onboarding/${numericId}/status`,
        { onboardingStatus: status, adminFeedback: reason || undefined },
        {
          headers: authHeaders,
        },
      );
      if (res.ok) {
        const responseBody = await res.json().catch(() => ({} as any));
        const payload = responseBody?.data || responseBody;
        const organization = payload?.organization;
        const organizationMeta = organization
          ? {
            organization,
            organizationId: organization.id,
            organizationAutoCreated: Boolean(payload?.organizationCreated),
            organizationVerified: organization.verificationStatus === "VERIFIED",
          }
          : {};
        const successMessage = status === "approved_for_procurement"
          ? `Application approved and organization created/verified successfully.${organization?.organizationName ? ` Organization: ${organization.organizationName} (#${organization.id}).` : ""}`
          : `Complete application ${status}`;
        toast.success(successMessage);

        if (organization) {
          setSelectedItem((prev: any) => prev && (prev._id === userId || prev.id === numericId)
            ? { ...prev, ...organizationMeta, onboardingStatus: status, sectionStatus: updatedSectionStatus }
            : prev);
          const applyOrganizationMeta = (prevList: any[]) =>
            prevList.map((item) => item._id === userId || item.id === numericId
              ? { ...item, ...organizationMeta, onboardingStatus: status, sectionStatus: updatedSectionStatus }
              : item);
          if (isBuyer) setBuyers(applyOrganizationMeta);
          else setSellers(applyOrganizationMeta);
        }
        // Keep the warmed detail cache in sync so reopening the modal shows
        // the new status instantly instead of stale cached detail.
        const cacheKey = String(userId);
        const cachedDetail = detailCacheRef.current.get(cacheKey);
        if (cachedDetail) {
          detailCacheRef.current.set(cacheKey, {
            ...cachedDetail,
            ...organizationMeta,
            onboardingStatus: status,
            sectionStatus: updatedSectionStatus,
            adminFeedback: reason || cachedDetail.adminFeedback,
          });
        }
        queryClient.invalidateQueries({ queryKey: ['adminOnboardingList'] });
        queryClient.invalidateQueries({ queryKey: ['adminStats'] });
      } else {
        const errBody = await res.json().catch(() => ({} as any));
        const detail = errBody?.message || errBody?.error || `HTTP ${res.status}`;
        toast.error(`Failed to update status: ${detail}`);
        if (typeof window !== 'undefined') {
          console.error('[AdminOnboarding] status update failed', { status: res.status, body: errBody });
        }
        // Revert to original state
        detailCacheRef.current.delete(String(userId));
        setSelectedItem(previousSelectedItem);
        setSellers(previousSellers);
        setBuyers(previousBuyers);
      }
    } catch (err) {
      toast.error("Network error");
      console.error('[AdminOnboarding] status network error', err);
      // Revert to original state
      detailCacheRef.current.delete(String(userId));
      setSelectedItem(previousSelectedItem);
      setSellers(previousSellers);
      setBuyers(previousBuyers);
    } finally {
      setTimeout(() => {
        isStatusUpdatingRef.current = false;
      }, 300);
    }
  };

  const handleUpdateSectionStatus = async (
    userId: string,
    section: string,
    status: string,
    reason?: string,
  ) => {
    if (!selectedItem || selectedItem._id !== userId || isSectionActionBusyRef.current) return;
    isSectionActionBusyRef.current = true;

    // 1. Keep a backup of the previous state
    const previousSelectedItem = { ...selectedItem };
    const previousSellers = [...sellers];
    const previousBuyers = [...buyers];

    // 2. Define default status map based on the role
    const defaultStatusMap = selectedItem.role === "buyer"
      ? {
        org: "pending",
        rep: "pending",
        address: "pending",
        procurement: "pending",
        docs: "pending",
      }
      : {
        pan: "pending",
        details: "pending",
        additional: "pending",
        offices: "pending",
        bank: "pending",
        documents: "pending",
      };

    // 3. Compute updated sectionStatus
    const updatedSectionStatus = {
      ...(selectedItem.sectionStatus || defaultStatusMap),
      [section]: status,
    };

    // 4. Compute onboardingStatus
    // Skip non-section meta keys like `submitted` that the seller-side
    // /onboarding/submit endpoint stores in sectionStatus.
    const sectionKeys = selectedItem.role === "buyer"
      ? ["org", "rep", "address", "procurement", "docs"]
      : ["pan", "details", "additional", "offices", "bank", "documents"];
    const statuses = sectionKeys.map((k) => updatedSectionStatus[k as keyof typeof updatedSectionStatus] || "pending");
    let newStatus = "under_compliance_review";
    if (statuses.every((s) => s === "approved")) {
      newStatus = "approved_for_procurement";
    } else if (statuses.some((s) => s === "rejected")) {
      newStatus = "rejected";
    } else if (statuses.some((s) => s === "resubmission_required")) {
      newStatus = "resubmission_required";
    }

    // 5. Update rejection reasons
    const updatedRejectionReasons = reason
      ? {
        ...(selectedItem.sectionRejectionReasons || {}),
        [section]: reason,
      }
      : (selectedItem.sectionRejectionReasons || {});

    const updatedItem = {
      ...selectedItem,
      onboardingStatus: newStatus,
      sectionStatus: updatedSectionStatus,
      sectionRejectionReasons: updatedRejectionReasons,
    };

    // 6. Apply optimistic state updates
    setSelectedItem(updatedItem);

    const updateListItem = (prevList: any[]) =>
      prevList.map((item) =>
        item._id === userId
          ? {
            ...item,
            onboardingStatus: newStatus,
            sectionStatus: updatedSectionStatus,
            sectionRejectionReasons: updatedRejectionReasons,
          }
          : item,
      );

    if (selectedItem.role === "buyer") {
      setBuyers(updateListItem);
    } else {
      setSellers(updateListItem);
    }

    // 7. Make the backend API request
    try {
      // Strip non-section meta keys before sending so backend computation
      // stays consistent and we don't accidentally persist stale flags.
      const cleanSectionStatus: Record<string, string> = {};
      for (const k of sectionKeys) {
        cleanSectionStatus[k] = String(updatedSectionStatus[k as keyof typeof updatedSectionStatus] || "pending");
      }
      // Coerce userId to a number for the URL — backend's idParams uses
      // z.coerce.number().int().positive() but we send what we have. Use the
      // fallback to selectedItem.id (numeric) so even if _id was a string we
      // still hit the right route.
      const numericId = Number(userId) || selectedItem?.id;
      const res = await api.post(
        `/api/admin/onboarding/${numericId}/section-status`,
        {
          sectionStatus: cleanSectionStatus,
          sectionRejectionReasons: updatedRejectionReasons,
        },
        {
          headers: authHeaders,
        },
      );
      if (res.ok) {
        toast.success(`${section} status updated to ${status}`);
        // Keep prefetch cache in sync
        const cacheKey = String(userId);
        const cachedDetail = detailCacheRef.current.get(cacheKey);
        if (cachedDetail) {
          detailCacheRef.current.set(cacheKey, {
            ...cachedDetail,
            onboardingStatus: newStatus,
            sectionStatus: updatedSectionStatus,
            sectionRejectionReasons: updatedRejectionReasons,
          });
        }
        queryClient.invalidateQueries({ queryKey: ['adminOnboardingList'] });
        queryClient.invalidateQueries({ queryKey: ['adminStats'] });
      } else {
        // Try to surface the actual server message so reviewers know what
        // went wrong instead of seeing the generic "failed to update".
        const errBody = await res.json().catch(() => ({} as any));
        const detail = errBody?.message || errBody?.error || `HTTP ${res.status}`;
        toast.error(`Failed to update section status: ${detail}`);
        if (typeof window !== 'undefined') {
          console.error('[AdminOnboarding] section-status update failed', { status: res.status, body: errBody });
        }
        // Revert to original state
        detailCacheRef.current.delete(String(userId));
        setSelectedItem(previousSelectedItem);
        setSellers(previousSellers);
        setBuyers(previousBuyers);
      }
    } catch (err) {
      toast.error("Network error");
      console.error('[AdminOnboarding] section-status network error', err);
      // Revert to original state
      detailCacheRef.current.delete(String(userId));
      setSelectedItem(previousSelectedItem);
      setSellers(previousSellers);
      setBuyers(previousBuyers);
    } finally {
      setTimeout(() => {
        isSectionActionBusyRef.current = false;
      }, 300);
    }
  };

  const handleConfirmRejection = async () => {
    if (!selectedItem || !activeSectionForRejection) return;

    await handleUpdateSectionStatus(
      selectedItem._id,
      activeSectionForRejection,
      "rejected",
      rejectionReason,
    );

    // Reset and close modal
    setIsRejectModalOpen(false);
    setActiveSectionForRejection("");
    setRejectionReason("");
  };

  const openRejectionModal = (section: string) => {
    setActiveSectionForRejection(section);
    setIsRejectModalOpen(true);
  };

  const handleOpenDocRequestModal = (documentType: string, label: string) => {
    setDocRequestTarget({ documentType, label });
    setDocRequestReason("");
    setIsDocRequestModalOpen(true);
  };

  const handleConfirmDocRequest = async () => {
    if (!selectedItem || !docRequestTarget || isSubmittingDocRequest) return;
    const trimmed = docRequestReason.trim();
    if (!trimmed || trimmed.length < 3) {
      toast.error("Please enter a reason of at least 3 characters.");
      return;
    }
    const numericId = Number(selectedItem._id) || Number(selectedItem.id);
    setIsSubmittingDocRequest(true);
    try {
      const res = await api.post(
        `/api/admin/onboarding/${numericId}/document-request`,
        {
          documentType: docRequestTarget.documentType,
          reason: trimmed
        },
        authOptions
      );
      if (res.ok) {
        toast.success(`Re-upload requested for ${docRequestTarget.label}. Stakeholder notified.`);
        setIsDocRequestModalOpen(false);
        setDocRequestReason("");

        const docKey = selectedItem.role === 'buyer' ? 'docs' : 'documents';
        const updatedReasons = {
          ...(selectedItem.sectionRejectionReasons || {}),
          [docRequestTarget.documentType]: trimmed
        };
        const updatedSectionStatus = {
          ...(selectedItem.sectionStatus || {}),
          [docKey]: 'resubmission_required'
        };
        const updatedItem = {
          ...selectedItem,
          onboardingStatus: 'resubmission_required',
          sectionStatus: updatedSectionStatus,
          sectionRejectionReasons: updatedReasons,
          adminFeedback: trimmed
        };
        setSelectedItem(updatedItem);

        // Keep detail cache in sync
        const cacheKey = String(selectedItem._id || selectedItem.id);
        const cachedDetail = detailCacheRef.current.get(cacheKey);
        if (cachedDetail) {
          detailCacheRef.current.set(cacheKey, {
            ...cachedDetail,
            ...updatedItem
          });
        }

        const updateListItem = (prevList: any[]) =>
          prevList.map((item) =>
            item._id === selectedItem._id || item.id === numericId
              ? {
                  ...item,
                  onboardingStatus: 'resubmission_required',
                  sectionStatus: updatedSectionStatus,
                  sectionRejectionReasons: updatedReasons,
                  adminFeedback: trimmed
                }
              : item
          );

        if (selectedItem.role === "buyer") {
          setBuyers(updateListItem);
        } else {
          setSellers(updateListItem);
        }
        queryClient.invalidateQueries({ queryKey: ['adminOnboardingList'] });
        queryClient.invalidateQueries({ queryKey: ['adminStats'] });
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.message || "Failed to request document re-upload");
      }
    } catch {
      toast.error("Network error while requesting document re-upload");
    } finally {
      setIsSubmittingDocRequest(false);
    }
  };

  const handleConfirmCorrection = async () => {
    if (!selectedItem || isSubmittingCorrection) return;
    const trimmed = correctionReason.trim();
    if (!trimmed || trimmed.length < 3) {
      toast.error("Please specify correction instructions of at least 3 characters.");
      return;
    }
    setIsSubmittingCorrection(true);
    try {
      await handleUpdateStatus(selectedItem._id, "resubmission_required", trimmed);
      setIsCorrectionModalOpen(false);
      setCorrectionReason("");
    } finally {
      setIsSubmittingCorrection(false);
    }
  };

  const handleConfirmAppRejection = async () => {
    if (!selectedItem || isSubmittingAppReject) return;
    const trimmed = appRejectReason.trim();
    if (!trimmed || trimmed.length < 3) {
      toast.error("Please specify a rejection reason of at least 3 characters.");
      return;
    }
    setIsSubmittingAppReject(true);
    try {
      await handleUpdateStatus(selectedItem._id, "rejected", trimmed);
      setIsAppRejectModalOpen(false);
      setAppRejectReason("");
    } finally {
      setIsSubmittingAppReject(false);
    }
  };

  const handleViewDocument = async (fileAsset: any, label: string) => {
    const isGenuineFileAsset = Boolean(
      fileAsset?.originalName ||
      fileAsset?.mimeType ||
      fileAsset?.storageProvider ||
      fileAsset?.storageProviderEnum ||
      fileAsset?.key ||
      fileAsset?.bucket
    );
    const resolvedFileId = fileAsset?.fileAssetId || fileAsset?.fileAsset?.id || fileAsset?.fileId || (isGenuineFileAsset ? fileAsset?.id : null);
    const key = resolvedFileId || fileAsset?.url || fileAsset?.fileUrl || label;
    try {
      setViewingDocKey(key);
      const fileAssetObj = typeof fileAsset === 'object' && fileAsset !== null
        ? {
            ...fileAsset,
            fileId: resolvedFileId,
            url: fileAsset.url || fileAsset.fileAsset?.url || fileAsset.fileUrl || fileAsset.documentUrl
          }
        : fileAsset;
      setPreviewDocument(await getFileAssetPreview(fileAssetObj, label));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to open document");
    } finally {
      setViewingDocKey(null);
    }
  };

  const getStatusBadge = (onboardingStatus: string) => {
    switch (onboardingStatus) {
      case "approved_for_procurement":
        return (
          <Badge
            variant="success"
            className="rounded-full px-4 border-2 border-green-100 shadow-sm font-black uppercase text-[9px] tracking-widest"
          >
            Approved for Procurement
          </Badge>
        );
      case "rejected":
        return (
          <Badge
            variant="error"
            className="rounded-full px-4 border-2 border-red-100 shadow-sm font-black uppercase text-[9px] tracking-widest"
          >
            Rejected
          </Badge>
        );
      case "resubmission_required":
        return (
          <Badge
            variant="warning"
            className="rounded-full px-4 border-2 border-amber-100 shadow-sm font-black uppercase text-[9px] tracking-widest text-amber-700 bg-amber-50"
          >
            Resubmission Required
          </Badge>
        );
      case "under_compliance_review":
      case "manual_review_required":
        return (
          <Badge
            variant="warning"
            className="rounded-full px-4 border-2 border-slate-100 shadow-sm font-black uppercase text-[9px] tracking-widest text-[#12335f] bg-slate-50"
          >
            {onboardingStatus === "manual_review_required" ? "Manual Review Required" : "Under Compliance Review"}
          </Badge>
        );
      case "verified":
        return (
          <Badge
            variant="success"
            className="rounded-full px-4 border-2 border-indigo-100 shadow-sm font-black uppercase text-[9px] tracking-widest text-indigo-700 bg-indigo-50"
          >
            Verified
          </Badge>
        );
      case "pending_validation":
        return (
          <Badge
            variant="warning"
            className="rounded-full px-4 border-2 border-slate-100 shadow-sm font-black uppercase text-[9px] tracking-widest text-slate-700 bg-slate-50"
          >
            Pending Validation
          </Badge>
        );
      default:
        return (
          <Badge
            variant="warning"
            className="rounded-full px-4 border-2 border-slate-100 shadow-sm font-black uppercase text-[9px] tracking-widest text-slate-700 bg-slate-50"
          >
            {onboardingStatus || "Pending"}
          </Badge>
        );
    }
  };

  const getSections = (item: any) =>
    item.role === "buyer"
      ? ["org", "rep", "address", "procurement", "docs"]
      : [
        "pan",
        "details",
        "additional",
        "offices",
        "bank",
        "documents",
      ];

  const getProgress = (item: any) => {
    if (!item?.sectionStatus) return 0;
    const sections = getSections(item);
    const count = sections.filter(
      (section) => item.sectionStatus?.[section] === "approved",
    ).length;
    return Math.round((count / sections.length) * 100);
  };

  const getDisplayText = (value: unknown, fallback: string) => {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return fallback;
  };
  const getRoleLabel = (item: any) => activeTab === "shg" || isShgUser({ ...item, sellerProfile: item.profile }) ? "SHG" : (item.role || activeTab.replace(/s$/, "")).toUpperCase();
  // Pull the registered entity name from whichever profile the user has.
  // Returns empty string if onboarding hasn't started yet, so the table can
  // render a clear "Onboarding in progress" placeholder instead of "N/A".
  const getEntityName = (item: any): string => {
    const profile = item?.profile || {};
    const candidate = profile.businessName
      || profile.organizationName
      || profile.officeZoneName
      || (typeof item?.organization === "object" ? item.organization?.legalName || item.organization?.name : "");
    return typeof candidate === "string" ? candidate.trim() : "";
  };
  // Combine city + state when present. Empty string when neither exists, so
  // the caller can hide the row instead of printing "STATE N/A".
  const getEntityLocation = (item: any): string => {
    const profile = item?.profile || {};
    const parts = [profile.city, profile.state]
      .filter((part) => typeof part === "string" && part.trim().length > 0)
      .map((part) => String(part).trim());
    return parts.join(", ");
  };
  const getPrimaryCategory = (item: any) => {
    const category =
      item.role === "buyer"
        ? item.profile?.procurementCategories?.[0]
        : Array.isArray(item.profile?.productCategories)
          ? item.profile.productCategories[0]
          : item.profile?.industry;

    return getDisplayText(
      category,
      item.role === "buyer" ? "General Procurement" : "Manufacturing",
    );
  };
  const getSubmittedDate = (item: any) => {
    if (!item?.createdAt) return new Date(0);
    const d = new Date(item.createdAt);
    return Number.isNaN(d.getTime()) ? new Date(0) : d;
  };
  const isPendingStatus = (status: string) =>
    ["pending", "pending_validation", "manual_review_required", "under_compliance_review"].includes(
      status,
    );

  const filterData = (data: any[]) => {
    const term = debouncedSearchTerm.trim().toLowerCase();
    return data
      .filter((item) => {
        const name = (item.name || "").toLowerCase();
        const company = getEntityName(item).toLowerCase();
        const gst = (item.profile?.gst || "").toLowerCase();
        const pan = (item.profile?.pan || "").toLowerCase();
        const state = (item.profile?.state || "").toLowerCase();
        const status = item.onboardingStatus || "pending";
        const progress = getProgress(item);
        const matchesSearch =
          !term ||
          name.includes(term) ||
          company.includes(term) ||
          gst.includes(term) ||
          pan.includes(term) ||
          state.includes(term);
        const matchesStatus =
          statusFilter === "all" ||
          (statusFilter === "pending" && isPendingStatus(status)) ||
          (statusFilter === "approved" &&
            status === "approved_for_procurement") ||
          (statusFilter === "rejected" && status === "rejected") ||
          (statusFilter === "resubmission" &&
            status === "resubmission_required");
        const matchesProgress =
          progressFilter === "all" ||
          (progressFilter === "not_started" && progress === 0) ||
          (progressFilter === "in_progress" &&
            progress > 0 &&
            progress < 100) ||
          (progressFilter === "complete" && progress === 100);
        return matchesSearch && matchesStatus && matchesProgress;
      })
      .sort((a, b) => {
        if (sortBy === "oldest")
          return getSubmittedDate(a).getTime() - getSubmittedDate(b).getTime();
        if (sortBy === "newest")
          return getSubmittedDate(b).getTime() - getSubmittedDate(a).getTime();

        if (sortBy === "progress") return getProgress(b) - getProgress(a);
        if (sortBy === "progress_asc") return getProgress(a) - getProgress(b);

        if (sortBy === "entity")
          return getEntityName(a).localeCompare(getEntityName(b));
        if (sortBy === "entity_desc")
          return getEntityName(b).localeCompare(getEntityName(a));

        if (sortBy === "status")
          return String(a.onboardingStatus || "").localeCompare(String(b.onboardingStatus || ""));
        if (sortBy === "status_desc")
          return String(b.onboardingStatus || "").localeCompare(String(a.onboardingStatus || ""));

        if (sortBy === "category")
          return getPrimaryCategory(a).localeCompare(getPrimaryCategory(b));
        if (sortBy === "category_desc")
          return getPrimaryCategory(b).localeCompare(getPrimaryCategory(a));

        return getSubmittedDate(b).getTime() - getSubmittedDate(a).getTime();
      });
  };

  const shgApplications = useMemo(
    () => sellers.filter((item) => isShgUser({ ...item, sellerProfile: item.profile })),
    [sellers],
  );

  const sellerApplications = useMemo(
    () => sellers.filter((item) => !isShgUser({ ...item, sellerProfile: item.profile })),
    [sellers],
  );

  const currentData =
    activeTab === "sellers"
      ? filterData(sellerApplications)
      : activeTab === "buyers"
        ? filterData(buyers)
        : filterData(shgApplications);
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(currentData.length / pageSize)),
  );
  const pagedCurrentData = currentData.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const setPageSize = (nextPageSize: number) => {
    setPageSizeState(nextPageSize);
    setPage(1);
  };

  // Warm the detail cache for the rows currently on screen so opening the
  // scrutiny modal is instant. Runs whenever the visible page changes.
  // Prefetches are de-duped and capped per pass to avoid hammering the API.
  useEffect(() => {
    if (pagedCurrentData.length === 0) return;
    const timer = setTimeout(() => {
      pagedCurrentData.slice(0, Math.min(5, pageSize)).forEach(prefetchDetail);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, currentPage, pageSize, debouncedSearchTerm, statusFilter, progressFilter, sortBy, sellers, buyers]);

  useEffect(() => {
    queueMicrotask(() => {
      setPage(1);
    });
  }, [activeTab, searchTerm, statusFilter, progressFilter, sortBy]);

  const pendingSellersCount = sellerApplications.filter((s) => isPendingStatus(s.onboardingStatus)).length;
  const pendingBuyersCount = buyers.filter((b) => isPendingStatus(b.onboardingStatus)).length;
  const pendingShgCount = shgApplications.filter((s) => isPendingStatus(s.onboardingStatus)).length;

  const pendingTotal = adminStats?.pendingApproval ?? (pendingSellersCount + pendingBuyersCount + pendingShgCount);

  const activeSellers = adminStats?.activeSellers ?? sellerApplications.filter(
    (s) => s.onboardingStatus === "approved_for_procurement",
  ).length;
  const activeBuyers = adminStats?.activeBuyers ?? buyers.filter(
    (b) => b.onboardingStatus === "approved_for_procurement",
  ).length;
  const activeShg = adminStats?.activeShg ?? shgApplications.filter(
    (s) => s.onboardingStatus === "approved_for_procurement",
  ).length;
  const totalNetwork = sellers.length + buyers.length;
  const averageProgress = totalNetwork
    ? Math.round(
      [...sellers, ...buyers].reduce(
        (sum, item) => sum + getProgress(item),
        0,
      ) / totalNetwork,
    )
    : 0;

  const toggleAdminSort = (key: string) => {
    if (key === "submitted") {
      setSortBy(sortBy === "oldest" ? "newest" : "oldest");
    } else if (key === "progress") {
      setSortBy(sortBy === "progress" ? "progress_asc" : "progress");
    } else if (key === "entity" || key === "name") {
      setSortBy(sortBy === "entity" ? "entity_desc" : "entity");
    } else if (key === "category") {
      setSortBy(sortBy === "category" ? "category_desc" : "category");
    } else if (key === "status") {
      setSortBy(sortBy === "status" ? "status_desc" : "status");
    }
  };

  const renderSortTableHead = (
    label: string,
    sortKey: string,
    className = "",
  ) => {
    let isActive = false;
    let isAsc = true;

    if (sortKey === "submitted") {
      isActive = sortBy === "oldest" || sortBy === "newest";
      isAsc = sortBy === "oldest";
    } else if (sortKey === "progress") {
      isActive = sortBy === "progress" || sortBy === "progress_asc";
      isAsc = sortBy === "progress_asc";
    } else if (sortKey === "entity" || sortKey === "name") {
      isActive = sortBy === "entity" || sortBy === "entity_desc";
      isAsc = sortBy === "entity";
    } else if (sortKey === "category") {
      isActive = sortBy === "category" || sortBy === "category_desc";
      isAsc = sortBy === "category";
    } else if (sortKey === "status") {
      isActive = sortBy === "status" || sortBy === "status_desc";
      isAsc = sortBy === "status";
    }

    return (
      <th className={cn("p-3 text-[10px] font-black uppercase tracking-wider text-[#12335f]", className)}>
        <button
          type="button"
          onClick={() => toggleAdminSort(sortKey)}
          className={cn(
            "inline-flex items-center gap-1.5 hover:text-[#0b2445] transition-colors",
            isActive ? "text-[#12335f]" : "text-slate-500"
          )}
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
      </th>
    );
  };

  const onboardingColumns = useMemo<ColumnDef<any>[]>(() => [
    {
      key: "name",
      header: "Full Name",
      sortable: true,
      sortKey: "name",
      width: "w-[24%]",
      cell: (item) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void openItemForReview(item);
          }}
          className="block text-left group/name cursor-pointer w-full min-w-0"
          title="Click to view full personal details"
        >
          <div className="font-bold text-slate-800 text-xs tracking-tight group-hover/name:text-[#12335f] group-hover/name:underline decoration-[#f9a825] underline-offset-2 transition-colors flex items-center gap-1.5 text-wrap-anywhere">
            <span>{item.name}</span>
            <Eye className="h-3 w-3 opacity-0 group-hover/name:opacity-100 text-[#12335f] transition-opacity shrink-0" />
          </div>
          <div className="mt-1 text-[9px] font-bold uppercase tracking-wide text-slate-400">
            {getRoleLabel(item)}
          </div>
        </button>
      )
    },
    {
      key: "entity",
      header: "Entity Name",
      sortable: true,
      sortKey: "entity",
      width: "w-[26%]",
      cell: (item) => (
        <div>
          {getEntityName(item) ? (
            <div className="font-bold text-slate-600 text-xs underline decoration-indigo-200 underline-offset-4 break-words">
              {getEntityName(item)}
            </div>
          ) : (
            <div className="text-xs font-semibold italic text-slate-400">
              Onboarding in progress
            </div>
          )}
          {getEntityLocation(item) && (
            <div className="mt-1 text-[9px] font-bold uppercase tracking-wide text-slate-400">
              {getEntityLocation(item)}
            </div>
          )}
        </div>
      )
    },
    {
      key: "submitted",
      header: "Submitted At",
      sortable: true,
      sortKey: "submitted",
      width: "w-36",
      cell: (item) => (
        <div className="text-[11px] font-bold text-slate-500 font-mono">
          {formatDateTime(item.createdAt)}
        </div>
      )
    },
    {
      key: "progress",
      header: "Progress",
      sortable: true,
      sortKey: "progress",
      width: "w-36",
      cell: (item) => (
        <div className="min-w-[100px] max-w-[140px] flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[9px] font-black uppercase tracking-wider text-slate-500">
            <span>Verified</span>
            <span className={cn(getProgress(item) === 100 ? "text-emerald-600" : "text-[#12335f]")}>
              {getProgress(item)}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={cn("h-full transition-all duration-500 rounded-full", getProgress(item) === 100 ? "bg-emerald-500" : "bg-[#12335f]")}
              style={{ width: `${getProgress(item)}%` }}
            />
          </div>
        </div>
      )
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      sortKey: "status",
      width: "w-44",
      cell: (item) => {
        const status = item.onboardingStatus || "pending";
        let dotColor = "bg-slate-400";
        let title = "Pending";
        let subtext = "Awaiting review";
        
        switch (status) {
          case "approved_for_procurement":
            dotColor = "bg-emerald-500";
            title = "Approved for Procurement";
            subtext = "Procurement approval";
            break;
          case "rejected":
            dotColor = "bg-red-500";
            title = "Rejected";
            subtext = "Application denied";
            break;
          case "resubmission_required":
            dotColor = "bg-amber-500";
            title = "Resubmission Required";
            subtext = "Correction needed";
            break;
          case "under_compliance_review":
            dotColor = "bg-blue-500";
            title = "Compliance Review";
            subtext = "In verification queue";
            break;
          case "manual_review_required":
            dotColor = "bg-orange-500";
            title = "Manual Review";
            subtext = "Action required";
            break;
          case "verified":
            dotColor = "bg-indigo-500";
            title = "Verified";
            subtext = "Checks passed";
            break;
          case "pending_validation":
            dotColor = "bg-slate-500";
            title = "Pending Validation";
            subtext = "System check";
            break;
          default:
            dotColor = "bg-slate-400";
            title = status.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
            subtext = "Pending status";
        }

        return (
          <div className="min-w-[160px] flex flex-col gap-2 p-2 rounded-lg border border-slate-100 bg-slate-50/50">
            <div className="flex items-start gap-2">
              <div className={cn("mt-1 h-2 w-2 rounded-full shrink-0 shadow-sm", dotColor)} />
              <div className="min-w-0">
                <div className="text-[10px] font-black uppercase tracking-wider text-slate-700 truncate" title={title}>
                  {title}
                </div>
                <div className="text-[9px] font-bold text-slate-400 truncate mt-0.5" title={subtext}>
                  {subtext}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-0.5 px-0.5">
              {getSections(item).map((section: string) => {
                const secStatus = item.sectionStatus?.[section] || "pending";
                const isApproved = secStatus === "approved";
                const isRejected = secStatus === "rejected";
                return (
                  <div 
                    key={section}
                    title={`${section.toUpperCase()}: ${secStatus.toUpperCase()}`}
                    className={cn(
                      "h-1 flex-1 rounded-sm transition-colors",
                      isApproved ? "bg-emerald-500" : 
                      isRejected ? "bg-red-500" : 
                      "bg-slate-200"
                    )}
                  />
                );
              })}
            </div>
          </div>
        );
      }
    },
    {
      key: "action",
      header: "Action",
      align: "right",
      width: "w-24",
      cell: (item) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            void openItemForReview(item);
          }}
          className="text-[10px] font-black text-indigo-600 uppercase hover:underline hover:text-indigo-800 transition-all decoration-2 underline-offset-4 inline-flex items-center"
        >
          Review <span className="ml-1 text-base leading-none">→</span>
        </button>
      )
    }
  ], []);

  const handleKpiClick = (target: string) => {
    if (target === "pending") {
      setStatusFilter((prev) => {
        if (prev === "pending") return "all";
        
        // Intelligently switch to a tab that has pending items if the current tab is empty
        if (activeTab === "shg" && pendingShgCount === 0) {
          if (pendingSellersCount > 0) setActiveTab("sellers");
          else if (pendingBuyersCount > 0) setActiveTab("buyers");
        } else if (activeTab === "sellers" && pendingSellersCount === 0) {
          if (pendingBuyersCount > 0) setActiveTab("buyers");
          else if (pendingShgCount > 0) setActiveTab("shg");
        } else if (activeTab === "buyers" && pendingBuyersCount === 0) {
          if (pendingSellersCount > 0) setActiveTab("sellers");
          else if (pendingShgCount > 0) setActiveTab("shg");
        }
        
        return "pending";
      });
    } else if (target === "sellers") {
      if (activeTab === "sellers" && statusFilter === "approved") {
        setStatusFilter("all");
      } else {
        setActiveTab("sellers");
        setStatusFilter("approved");
      }
    } else if (target === "buyers") {
      if (activeTab === "buyers" && statusFilter === "approved") {
        setStatusFilter("all");
      } else {
        setActiveTab("buyers");
        setStatusFilter("approved");
      }
    } else if (target === "shg") {
      if (activeTab === "shg" && statusFilter === "approved") {
        setStatusFilter("all");
      } else {
        setActiveTab("shg");
        setStatusFilter("approved");
      }
    } else {
      setStatusFilter("all");
      setProgressFilter("all");
      setSearchTerm("");
    }
  };

  const handleExportCsv = async () => {
    if (currentData.length === 0) {
      toast.error("No records available for export");
      return;
    }

    setIsExporting(true);
    const toastId = toast.loading(`Preparing complete export for ${currentData.length} records...`);

    try {
      // Ensure each item has full details (including from detailCacheRef or fetch)
      const detailedItems = await Promise.all(
        currentData.map(async (item) => {
          const key = String(item._id || item.id);
          const cached = detailCacheRef.current.get(key);
          if (cached) return { ...item, ...cached };
          if (
            (item.profile?.offices?.length || item.profile?.sellerDocuments?.length) &&
            item.profile?.documents
          ) {
            return item;
          }
          const fetched = await fetchDetail(item);
          return fetched ? { ...item, ...fetched } : item;
        }),
      );

      const rows = detailedItems.map((item, index) => {
        const docLinks = getExportDocumentLinks(item);
        const addr = getEntityAddress(item);
        const bank = getBankDetails(item);
        const gst = getGstNumber(item) || "";
        const pan = getPanNumber(item) || "";
        const udyam = getUdyamNumber(item) || "";
        const cin = getCinNumber(item) || "";
        const email =
          item.email ||
          item.profile?.email ||
          item.registrationDetails?.userId ||
          "";
        const mobile =
          item.profile?.mobile ||
          item.profile?.offices?.[0]?.contactNumber ||
          item.profile?.contactPersonMobile ||
          item.registrationDetails?.mobile ||
          item.mobile ||
          "";
        const entityType =
          item.profile?.organizationType ||
          item.profile?.businessType ||
          item.registrationDetails?.businessType ||
          item.registrationDetails?.gstDetails?.constitutionOfBusiness ||
          item.organization?.organizationType ||
          "";
        const msmeCategory =
          item.profile?.msmeCategory ||
          item.profile?.msmeType ||
          (item.role === "seller" ? "MSME" : "");
        const turnover =
          item.profile?.turnoverMax3Yrs ||
          item.profile?.annualBudget ||
          item.profile?.organization?.annualTurnover ||
          item.organization?.annualTurnover ||
          "";

        return {
          "Sr No": index + 1,
          "Stakeholder Type": getRoleLabel(item),
          "Applicant Name": item.name || item.registrationDetails?.accountName || "",
          "Entity Name": getEntityName(item) || item.registrationDetails?.businessName || item.name || "",
          Email: email,
          "Mobile Number": mobile,
          PAN: pan,
          GST: gst,
          "UDYAM Registration Number": udyam,
          "CIN Number": cin,
          "Entity Type": entityType,
          "MSME Category": msmeCategory,
          Category: getPrimaryCategory(item),
          "Registered Address": addr.fullAddress,
          "Address Line": addr.street,
          City: addr.city,
          District: addr.district,
          State: addr.state,
          Pincode: addr.pincode,
          "Annual Turnover": turnover,
          "Bank Name": bank.bankName,
          "Bank Account Number": bank.accountNumber,
          "Bank IFSC Code": bank.ifscCode,
          "Account Holder Name": bank.accountHolderName,
          "Submitted Date": formatDateTime(item.createdAt),
          Status: item.onboardingStatus || "pending",
          "Verification Progress": `${getProgress(item)}%`,
          "Admin Feedback": item.adminFeedback || "",
          "PAN Document Link": docLinks.panLink,
          "GST Certificate Link": docLinks.gstLink,
          "UDYAM Certificate Link": docLinks.udyamLink,
          "Bank Proof Link": docLinks.bankLink,
          "Address Proof Link": docLinks.addressLink,
          "Registration Certificate Link": docLinks.registrationLink,
          "Additional Documents Links": docLinks.additionalLinks,
          "All Uploaded Documents Links": docLinks.allLinks,
        };
      });

      downloadCsv(
        `admin-onboarding-${activeTab}-${new Date().toISOString().split("T")[0]}.csv`,
        rows,
      );
      toast.dismiss(toastId);
      toast.success(
        `Exported ${rows.length} onboarding records with complete details and document links`,
      );
    } catch (err) {
      console.error("[ExportCsvError]", err);
      toast.dismiss(toastId);
      toast.error("Failed to generate complete export");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="relative min-h-[calc(100vh-100px)]">
      <div
        className={cn(
          "space-y-4 pb-12 transition-all duration-300",
          selectedItem && "blur-sm pointer-events-none",
        )}
      >
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-base font-extrabold tracking-tight text-indigo-950 uppercase">
              Registration Management
            </h1>
            <p className="text-slate-500 font-medium">
              Review, filter, export and approve stakeholder registrations.
            </p>
          </div>
          <div className="flex items-center space-x-3">
            <Button
              variant="outline"
              onClick={handleExportCsv}
              disabled={currentData.length === 0 || isExporting}
              className="rounded-xl border-slate-200 text-slate-600 font-bold uppercase tracking-widest text-[10px]"
            >
              {isExporting ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="mr-2 h-3.5 w-3.5" />
              )}
              {isExporting ? "Exporting..." : "Export CSV"}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <div className="min-w-0 space-y-4">
            {/* Stats Section */}
            <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4 lg:grid-cols-4">
              {[
                {
                  label: "Pending Approval",
                  value: pendingTotal,
                  sub: "Needs scrutiny action",
                  icon: Clock,
                  target: "pending",
                  tone: "amber" as const,
                },
                {
                  label: "Active Sellers",
                  value: activeSellers,
                  sub: "Approved supplier base",
                  icon: ShoppingBag,
                  target: "sellers",
                  tone: "emerald" as const,
                },
                {
                  label: "Active Buyers",
                  value: activeBuyers,
                  sub: "Approved procurement users",
                  icon: Building2,
                  target: "buyers",
                  tone: "blue" as const,
                },
                {
                  label: "Active SHG",
                  value: activeShg,
                  sub: "Approved SHG groups",
                  icon: BarChart3,
                  target: "shg",
                  tone: "indigo" as const,
                },
              ].map((stat) => (
                <KpiCard
                  key={stat.label}
                  label={stat.label}
                  value={isLoading || isAdminStatsLoading ? <Skeleton className="h-7 w-16 rounded-md" /> : stat.value}
                  subtext={stat.sub}
                  icon={stat.icon}
                  tone={stat.tone}
                  onClick={() => handleKpiClick(stat.target)}
                  active={
                    (stat.target === "pending" && statusFilter === "pending") ||
                    (stat.target === "sellers" && activeTab === "sellers" && statusFilter === "approved") ||
                    (stat.target === "buyers" && activeTab === "buyers" && statusFilter === "approved") ||
                    (stat.target === "shg" && activeTab === "shg" && statusFilter === "approved") ||
                    (stat.target === "network" && statusFilter === "all" && progressFilter === "all" && !searchTerm)
                  }
                />
              ))}
            </div>

            <Card className="border-none shadow-sm border border-slate-200/80 rounded-2xl overflow-hidden">
              <CardHeader className="bg-white p-0 border-b border-slate-100">
                <Tabs
                  tabs={[
                    { id: "sellers", label: `Seller Onboarding${statusFilter === 'pending' && pendingSellersCount > 0 ? ` (${pendingSellersCount})` : ''}` },
                    { id: "buyers", label: `Buyer Onboarding${statusFilter === 'pending' && pendingBuyersCount > 0 ? ` (${pendingBuyersCount})` : ''}` },
                    { id: "shg", label: `SHG Onboarding${statusFilter === 'pending' && pendingShgCount > 0 ? ` (${pendingShgCount})` : ''}` },
                  ]}
                  activeTab={activeTab}
                  onChange={handleTabChange}
                  className="px-4 pt-3 space-x-6"
                />
              </CardHeader>
              <CardContent className="p-0">
                <div className="flex flex-col gap-3 border-b border-slate-100 bg-white p-3 sm:p-4">
                  <div className="flex items-center gap-2 text-[#12335f]">
                    <Filter className="h-4 w-4" />
                    <p className="text-[10px] font-black uppercase tracking-widest">
                      Procurement Verification Filters
                    </p>
                  </div>
                  <p className="text-xs font-medium text-slate-500">
                    {isLoading ? (
                      <span className="inline-flex items-center gap-2 text-indigo-600 font-bold">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-[#12335f]" />
                        Loading {activeTab === "sellers" ? "seller" : activeTab === "buyers" ? "buyer" : "SHG"} applications...
                      </span>
                    ) : (
                      <>
                        Showing {currentData.length}{" "}
                        {activeTab === "sellers" ? "seller" : activeTab === "buyers" ? "buyer" : "SHG"} application
                        {currentData.length === 1 ? "" : "s"} for the selected criteria.
                      </>
                    )}
                  </p>

                  {/* ── Search + Filter + View Toggle Toolbar ── */}
                  <div className="rounded-2xl border border-slate-200/90 bg-white p-3 sm:p-4 shadow-sm">
                    <ResponsiveFilterBar
                      activeFilterCount={[statusFilter !== "all", progressFilter !== "all", sortBy !== "newest"].filter(Boolean).length}
                      searchInput={
                        <div className="relative w-full">
                          <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                          <input
                            placeholder="Search by company, PAN, GST, state, or applicant name..."
                            className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50/50 pl-10 pr-4 text-xs font-semibold text-slate-800 placeholder-slate-400 outline-none transition-all focus:border-[#12335f] focus:bg-white focus:ring-2 focus:ring-[#12335f]/10 shadow-inner"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            aria-label="Search applications"
                          />
                        </div>
                      }
                      filters={
                        <>
                          <div className="w-full sm:w-auto sm:min-w-[130px]">
                            <select
                              value={statusFilter}
                              onChange={(e) => setStatusFilter(e.target.value)}
                              aria-label="Status filter"
                              className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 outline-none hover:border-slate-300 focus:border-[#12335f] focus:ring-2 focus:ring-[#12335f]/10 transition-colors shadow-xs cursor-pointer"
                            >
                              <option value="all">All Status</option>
                              <option value="pending">Pending / Review</option>
                              <option value="approved">Approved</option>
                              <option value="resubmission">Correction Required</option>
                              <option value="rejected">Rejected</option>
                            </select>
                          </div>
                          <div className="w-full sm:w-auto sm:min-w-[130px]">
                            <select
                              value={progressFilter}
                              onChange={(e) => setProgressFilter(e.target.value)}
                              aria-label="Progress filter"
                              className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 outline-none hover:border-slate-300 focus:border-[#12335f] focus:ring-2 focus:ring-[#12335f]/10 transition-colors shadow-xs cursor-pointer"
                            >
                              <option value="all">All Progress</option>
                              <option value="not_started">0% Verified</option>
                              <option value="in_progress">In Progress</option>
                              <option value="complete">100% Verified</option>
                            </select>
                          </div>
                          <div className="w-full sm:w-auto sm:min-w-[130px]">
                            <select
                              value={sortBy}
                              onChange={(e) => setSortBy(e.target.value)}
                              aria-label="Sort"
                              className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 outline-none hover:border-slate-300 focus:border-[#12335f] focus:ring-2 focus:ring-[#12335f]/10 transition-colors shadow-xs cursor-pointer"
                            >
                              <option value="newest">Newest First</option>
                              <option value="oldest">Oldest First</option>
                              <option value="progress">Progress High</option>
                              <option value="entity">Entity A-Z</option>
                            </select>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              setSearchTerm("");
                              setStatusFilter("all");
                              setProgressFilter("all");
                              setSortBy("newest");
                            }}
                            className="h-10 rounded-xl border-slate-200 bg-white hover:bg-slate-50 text-xs font-bold text-slate-700 shrink-0"
                            title="Reset filters"
                          >
                            <RefreshCw className="h-3.5 w-3.5 mr-1" />
                            <span>Reset</span>
                          </Button>
                        </>
                      }
                    />
                  </div>
                </div>

                {isLoading ? (
                  <div className="p-8 space-y-4">
                    <div className="flex items-center justify-center gap-2.5 sm:gap-3 py-6 bg-slate-50/80 rounded-xl border border-slate-100 shadow-2xs">
                      <Loader2 className="h-5 w-5 animate-spin text-[#12335f]" />
                      <span className="text-xs font-black text-[#12335f] uppercase tracking-wider">
                        Loading {activeTab === "shg" ? "SHG" : activeTab} onboarding records...
                      </span>
                    </div>
                    {[1, 2, 3, 4, 5].map((i) => (
                      <div key={i} className="flex items-center justify-between py-4 border-b border-slate-50 animate-pulse">
                        <div className="h-4 w-8 bg-slate-100 rounded" />
                        <div className="h-4 w-1/4 bg-slate-100 rounded" />
                        <div className="h-4 w-1/4 bg-slate-100 rounded" />
                        <div className="h-4.5 w-20 bg-slate-100 rounded" />
                        <div className="h-4 w-16 bg-slate-100 rounded" />
                        <div className="h-4 w-12 bg-slate-100 rounded" />
                      </div>
                    ))}
                  </div>
                ) : onboardingError ? (
                  <div className="py-16 text-center text-slate-600 m-6 rounded-2xl border border-rose-200 bg-rose-50/50 p-6">
                    <AlertCircle className="h-10 w-10 text-rose-500 mx-auto mb-3" />
                    <h3 className="text-sm font-bold text-slate-900">Unable to load onboarding records</h3>
                    <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                      {onboardingError instanceof Error ? onboardingError.message : 'Please check your connection and sign in status.'}
                    </p>
                    <Button
                      onClick={() => refetchOnboarding()}
                      loadingText="Retrying..."
                      className="mt-4 bg-[#12335f] hover:bg-[#0b2445] text-white rounded-xl text-xs font-bold px-5"
                    >
                      <RefreshCw className="h-3.5 w-3.5 mr-2" />
                      Retry Connection
                    </Button>
                  </div>
                ) : currentData.length === 0 ? (
                  <div className="py-20 text-center text-slate-400 border-2 border-dashed border-slate-100 m-6 rounded-2xl">
                    No {activeTab === "shg" ? "SHG" : activeTab} registrations in record.
                  </div>
                ) : (
                  <>
                    {/* Responsive Table (List view) */}
                    {viewMode === "list" && (
                      <DataTable<any>
                        data={pagedCurrentData}
                        columns={onboardingColumns}
                        keyExtractor={(item) => item._id}
                        isLoading={isLoading}
                        showSrNo={true}
                        srNoHeader="Sr. No."
                        srNoWidth="w-16"
                        sortKey={sortBy === 'oldest' ? 'submitted' : sortBy === 'newest' ? 'submitted' : sortBy.startsWith('progress') ? 'progress' : sortBy.startsWith('entity') || sortBy.startsWith('name') ? 'entity' : sortBy.startsWith('status') ? 'status' : undefined}
                        sortDirection={sortBy.endsWith('_desc') || sortBy === 'newest' ? 'desc' : 'asc'}
                        onSort={(key) => toggleAdminSort(key)}
                        page={currentPage}
                        pageSize={pageSize}
                        total={currentData.length}
                        onPageChange={setPage}
                        onPageSizeChange={setPageSize}
                        paginationLabel="applications"
                        emptyTitle={`No ${activeTab === "shg" ? "SHG" : activeTab} registrations`}
                        emptyDescription={`No ${activeTab === "shg" ? "SHG" : activeTab} registrations in record.`}
                        caption={`Admin ${activeTab} Registration Management Table`}
                      />
                    )}

                    {/* Desktop Grid view (alternative to table) */}
                    {viewMode === "grid" && (
                      <div className="hidden md:grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4 p-4 md:p-6 bg-slate-50/50 rounded-b-2xl border-t border-slate-100">
                        {pagedCurrentData.map((item, index) => {
                          const getAvatarGradient = (status: string) => {
                            switch (status) {
                              case "approved_for_procurement":
                                return "bg-gradient-to-br from-emerald-600 to-green-500 shadow-emerald-500/10";
                              case "rejected":
                                return "bg-gradient-to-br from-red-600 to-rose-500 shadow-red-500/10";
                              case "resubmission_required":
                                return "bg-gradient-to-br from-amber-500 to-orange-400 shadow-amber-500/10";
                              default:
                                return "bg-gradient-to-br from-[#12335f] to-[#25528c] shadow-[#12335f]/10";
                            }
                          };

                          return (
                            <div
                              key={item._id}
                              onClick={() => void openItemForReview(item)}
                              onMouseEnter={() => prefetchDetail(item)}
                              className="group cursor-pointer rounded-2xl border border-slate-200 bg-white p-5 shadow-sm hover:shadow-md hover:-translate-y-0.5 hover:border-[#12335f]/25 transition-all duration-300 flex flex-col justify-between min-w-0"
                            >
                              <div>
                                {/* Top Row - Meta & Badge */}
                                <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-3 mb-3">
                                  <div className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400">
                                    {getRoleLabel(item)}
                                    {" · #"}
                                    {String((currentPage - 1) * pageSize + index + 1).padStart(2, "0")}
                                  </div>
                                  <div className="shrink-0">
                                    {getStatusBadge(item.onboardingStatus)}
                                  </div>
                                </div>

                                {/* Identity - Avatar & Names */}
                                <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
                                  <div className={cn(
                                    "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl shadow-md text-sm font-extrabold text-white transition-all duration-300 group-hover:scale-105",
                                    getAvatarGradient(item.onboardingStatus)
                                  )}>
                                    {String(item.name || "?").charAt(0).toUpperCase()}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="font-bold text-slate-800 text-sm tracking-tight group-hover:text-[#12335f] transition-colors line-clamp-2">
                                      {item.name}
                                    </div>
                                    <div className="mt-0.5 text-xs font-semibold text-slate-500 line-clamp-2" title={getEntityName(item) || undefined}>
                                      {getEntityName(item) || (
                                        <span className="font-medium italic text-slate-400">Onboarding in progress</span>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                {/* Metadata Grid */}
                                <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-slate-100 pt-3">
                                  <div className="flex items-start gap-2 min-w-0">
                                    <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0 text-slate-400 group-hover:text-[#12335f]/70 transition-colors" />
                                    <div className="min-w-0">
                                      <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Location</p>
                                      <p className="text-[11px] font-semibold text-slate-700 truncate" title={getEntityLocation(item) || undefined}>
                                        {getEntityLocation(item) || "—"}
                                      </p>
                                    </div>
                                  </div>

                                  <div className="flex items-start gap-2 min-w-0">
                                    <Briefcase className="h-3.5 w-3.5 mt-0.5 shrink-0 text-slate-400 group-hover:text-[#12335f]/70 transition-colors" />
                                    <div className="min-w-0">
                                      <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Category</p>
                                      <p className="text-[11px] font-semibold text-slate-700 truncate" title={item.role === "buyer" ? getDisplayText(item.profile?.annualBudget, "Budget pending") : getPrimaryCategory(item)}>
                                        {item.role === "buyer"
                                          ? getDisplayText(item.profile?.annualBudget, "Budget pending")
                                          : getPrimaryCategory(item)}
                                      </p>
                                    </div>
                                  </div>

                                  <div className="flex items-start gap-2 min-w-0">
                                    <Clock className="h-3.5 w-3.5 mt-0.5 shrink-0 text-slate-400 group-hover:text-[#12335f]/70 transition-colors" />
                                    <div className="min-w-0">
                                      <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Submitted</p>
                                      <p className="text-[11px] font-semibold text-slate-700 font-mono">
                                        {formatDateTime(item.createdAt)}
                                      </p>
                                    </div>
                                  </div>

                                  <div className="flex items-start gap-2 min-w-0">
                                    <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0 text-slate-400 group-hover:text-[#12335f]/70 transition-colors" />
                                    <div className="min-w-0">
                                      <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Verified</p>
                                      <p className="text-[11px] font-bold text-[#12335f]">
                                        {getProgress(item)}%
                                      </p>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {/* Progress bar */}
                              <div className="mt-4">
                                <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                                  <div
                                    className="h-full rounded-full bg-[#12335f] transition-all duration-500"
                                    style={{ width: `${getProgress(item)}%` }}
                                  />
                                </div>

                                {/* Footer - Section Dots & CTA */}
                                <div className="mt-3.5 flex items-center justify-between gap-2">
                                  <div className="flex space-x-1">
                                    {getSections(item).map((section) => {
                                      const sectionStatus = item.sectionStatus?.[section];
                                      const statusColors = {
                                        approved: "bg-emerald-500 shadow-sm shadow-emerald-500/20",
                                        rejected: "bg-red-500 shadow-sm shadow-red-500/20",
                                        pending: "bg-slate-200",
                                      };
                                      const colorClass = statusColors[sectionStatus as keyof typeof statusColors] || "bg-slate-200";
                                      return (
                                        <div
                                          key={section}
                                          className={cn("h-1.5 w-3 rounded-full transition-all duration-300", colorClass)}
                                          title={`${section}: ${sectionStatus || "pending"}`}
                                        />
                                      );
                                    })}
                                  </div>
                                  <div className="text-[10px] font-black text-indigo-600 group-hover:text-indigo-800 transition-colors flex items-center gap-1">
                                    <span>REVIEW</span>
                                    <span className="transform group-hover:translate-x-0.5 transition-transform duration-200">→</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Responsive Card Grid for Mobile */}
                    {viewMode === "grid" && (
                      <div className="md:hidden grid grid-cols-1 gap-4 p-4">
                        {pagedCurrentData.map((item, index) => {
                          const getAvatarGradient = (status: string) => {
                            switch (status) {
                              case "approved_for_procurement":
                                return "bg-gradient-to-br from-emerald-600 to-green-500 shadow-emerald-500/10";
                              case "rejected":
                                return "bg-gradient-to-br from-red-600 to-rose-500 shadow-red-500/10";
                              case "resubmission_required":
                                return "bg-gradient-to-br from-amber-500 to-orange-400 shadow-amber-500/10";
                              default:
                                return "bg-gradient-to-br from-[#12335f] to-[#25528c] shadow-[#12335f]/10";
                            }
                          };

                          return (
                            <div
                              key={item._id}
                              onClick={() => void openItemForReview(item)}
                              className="group cursor-pointer rounded-2xl border border-slate-200 bg-white p-4 shadow-sm active:bg-slate-50 transition-all flex flex-col justify-between min-w-0"
                            >
                              <div>
                                {/* Top Row - Meta & Badge */}
                                <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2.5 mb-2.5">
                                  <div className="text-[9px] font-extrabold uppercase tracking-widest text-slate-400">
                                    {getRoleLabel(item)}
                                    {" · #"}
                                    {String((currentPage - 1) * pageSize + index + 1).padStart(2, "0")}
                                  </div>
                                  <div className="shrink-0 scale-90 origin-right">
                                    {getStatusBadge(item.onboardingStatus)}
                                  </div>
                                </div>

                                {/* Identity - Avatar & Names */}
                                <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
                                  <div className={cn(
                                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-md text-xs font-extrabold text-white",
                                    getAvatarGradient(item.onboardingStatus)
                                  )}>
                                    {String(item.name || "?").charAt(0).toUpperCase()}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="font-bold text-slate-800 text-xs tracking-tight line-clamp-2">
                                      {item.name}
                                    </div>
                                    <div className="mt-0.5 text-[11px] font-semibold text-slate-500 line-clamp-2" title={getEntityName(item) || undefined}>
                                      {getEntityName(item) || (
                                        <span className="font-medium italic text-slate-400">Onboarding in progress</span>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                {/* Metadata Grid */}
                                <div className="mt-3 grid grid-cols-2 gap-x-2.5 gap-y-1.5 border-t border-slate-100 pt-2.5">
                                  <div className="flex items-start gap-1.5 min-w-0">
                                    <MapPin className="h-3 w-3 mt-0.5 shrink-0 text-slate-400" />
                                    <div className="min-w-0">
                                      <p className="text-[8px] font-bold uppercase tracking-wider text-slate-400">Location</p>
                                      <p className="text-[10px] font-semibold text-slate-700 truncate" title={getEntityLocation(item) || undefined}>
                                        {getEntityLocation(item) || "—"}
                                      </p>
                                    </div>
                                  </div>

                                  <div className="flex items-start gap-1.5 min-w-0">
                                    <Briefcase className="h-3 w-3 mt-0.5 shrink-0 text-slate-400" />
                                    <div className="min-w-0">
                                      <p className="text-[8px] font-bold uppercase tracking-wider text-slate-400">Category</p>
                                      <p className="text-[10px] font-semibold text-slate-700 truncate" title={item.role === "buyer" ? getDisplayText(item.profile?.annualBudget, "Budget pending") : getPrimaryCategory(item)}>
                                        {item.role === "buyer"
                                          ? getDisplayText(item.profile?.annualBudget, "Budget pending")
                                          : getPrimaryCategory(item)}
                                      </p>
                                    </div>
                                  </div>

                                  <div className="flex items-start gap-1.5 min-w-0">
                                    <Clock className="h-3 w-3 mt-0.5 shrink-0 text-slate-400" />
                                    <div className="min-w-0">
                                      <p className="text-[8px] font-bold uppercase tracking-wider text-slate-400">Submitted</p>
                                      <p className="text-[10px] font-semibold text-slate-700 font-mono">
                                        {formatDateTime(item.createdAt)}
                                      </p>
                                    </div>
                                  </div>

                                  <div className="flex items-start gap-1.5 min-w-0">
                                    <ShieldCheck className="h-3 w-3 mt-0.5 shrink-0 text-slate-400" />
                                    <div className="min-w-0">
                                      <p className="text-[8px] font-bold uppercase tracking-wider text-slate-400">Verified</p>
                                      <p className="text-[10px] font-bold text-[#12335f]">
                                        {getProgress(item)}%
                                      </p>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {/* Progress bar */}
                              <div className="mt-3.5">
                                <div className="h-1 overflow-hidden rounded-full bg-slate-100">
                                  <div
                                    className="h-full rounded-full bg-[#12335f]"
                                    style={{ width: `${getProgress(item)}%` }}
                                  />
                                </div>

                                {/* Footer - Section Dots & CTA */}
                                <div className="mt-3 flex items-center justify-between gap-2">
                                  <div className="flex space-x-0.5">
                                    {getSections(item).map((section) => {
                                      const sectionStatus = item.sectionStatus?.[section];
                                      const statusColors = {
                                        approved: "bg-emerald-500",
                                        rejected: "bg-red-500",
                                        pending: "bg-slate-200",
                                      };
                                      const colorClass = statusColors[sectionStatus as keyof typeof statusColors] || "bg-slate-200";
                                      return (
                                        <div
                                          key={section}
                                          className={cn("h-1 w-2.5 rounded-full", colorClass)}
                                        />
                                      );
                                    })}
                                  </div>
                                  <div className="text-[9px] font-black text-indigo-600 uppercase">
                                    Review →
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {viewMode === "grid" && (
                      <Pagination
                        page={currentPage}
                        pageSize={pageSize}
                        total={currentData.length}
                        onPageChange={setPage}
                        onPageSizeChange={setPageSize}
                        label="applications"
                      />
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* FULL SCREEN REVIEW OVERLAY */}
      {selectedItem && isMounted && typeof document !== 'undefined' && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Registration Scrutiny Desk"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-[#0b1f3a]/85 p-2 animate-in fade-in duration-300 md:p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isAnySubModalOpen) {
              setSelectedItem(null);
            }
          }}
          onWheel={(e) => {
            if (scrutinyModalScrollRef.current) {
              const target = e.target as HTMLElement | null;
              if (target && target.tagName === 'TEXTAREA') {
                const textarea = target as HTMLTextAreaElement;
                if (textarea.scrollHeight > textarea.clientHeight) {
                  return;
                }
              }
              scrutinyModalScrollRef.current.scrollTop += e.deltaY;
            }
          }}
        >
          <div
            className="flex h-[95dvh] w-full max-w-[1300px] flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-2xl animate-in zoom-in-95 duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header - government-portal styling: deep navy, gold accent, embossed feel */}
            <div className="relative border-b-2 border-[#f9a825] bg-gradient-to-r from-[#0b1f3a] via-[#12335f] to-[#0b1f3a] px-6 py-5 text-white md:px-8">
              <div className="flex flex-col gap-2.5 sm:gap-3 md:flex-row md:items-center md:justify-between">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-[#f9a825]/40 bg-white/10 text-[#f9a825] shadow-inner">
                    <ShieldCheck className="h-6 w-6" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#f9a825]">
                      Government of India · MSME Procurement Portal
                    </p>
                    <h2 className="text-lg font-extrabold uppercase leading-none tracking-tight md:text-xl">
                      Registration Scrutiny Desk
                    </h2>
                    <p className="text-[11px] font-medium text-slate-200">
                      Statutory verification and compliance decision module
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2.5 sm:gap-4 w-full sm:w-auto">
                  <div className="hidden flex-col items-end gap-0.5 border-l border-white/20 pl-4 md:flex">
                    <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-slate-300">Application ID</p>
                    <p className="font-mono text-xs font-extrabold text-white">
                      {selectedItem.registrationDetails?.userId || `MSME-${selectedItem._id?.toString().padStart(6, '0')}`}
                    </p>
                    <p className="text-[9px] font-bold text-slate-300">
                      Submitted {selectedItem.createdAt ? formatDateTime(selectedItem.createdAt) : '—'}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setSelectedItem(null);
                    }}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-white/20 bg-white/10 text-white transition-all hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-[#f9a825]"
                    aria-label="Close application review"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Content Area */}
            <div
              ref={scrutinyModalScrollRef}
              className="relative flex-1 min-h-0 space-y-8 overflow-y-auto overscroll-contain bg-slate-50 p-4 md:p-6 lg:p-8"
            >
              {isDetailLoading && (
                <div className="flex items-center gap-2.5 sm:gap-3.5 rounded-xl border border-blue-200 bg-blue-50/90 px-4 py-3 text-xs font-bold text-blue-950 shadow-xs animate-pulse">
                  <Loader2 className="h-4 w-4 animate-spin text-blue-600 shrink-0" />
                  <span>Loading full application record & verification documents...</span>
                </div>
              )}
              <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
                {/* Left Column: Identity Baseline */}
                <div className="space-y-5 lg:col-span-4">
                  <div className="space-y-3">
                    <div className="flex flex-col gap-1">
                      <h3 className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#12335f]">
                        Identity Baseline
                      </h3>
                      <div className="h-0.5 w-20 rounded-full bg-[#f9a825]" />
                    </div>
                    <div className="relative space-y-6 overflow-hidden rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
                      <div className="flex items-start gap-5">
                        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-[#12335f] text-base font-extrabold text-white shadow-sm">
                          {selectedItem.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="space-y-1 min-w-0 pt-1">
                          <div className="truncate text-base font-extrabold leading-none tracking-tight text-slate-900">
                            {selectedItem.name}
                          </div>
                          <div className="truncate text-xs font-semibold lowercase text-slate-500">
                            {selectedItem.email}
                          </div>
                          <div className="mt-3 inline-flex rounded border border-slate-100 bg-slate-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-[#12335f]">
                            ID:{" "}
                            {selectedItem.registrationDetails?.userId ||
                              selectedItem.name
                                .toUpperCase()
                                .replace(/\s+/g, "-")}
                          </div>
                        </div>
                      </div>
                      <div className="flex pt-3 border-t border-slate-200/50">
                        {getStatusBadge(selectedItem.onboardingStatus || "pending")}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <h3 className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
                        Verification Progress
                      </h3>
                      <span className="text-xs font-extrabold text-[#12335f]">
                        {getProgress(selectedItem)}%
                      </span>
                    </div>
                    <div className="mt-3 h-2 w-full overflow-hidden rounded-full border border-slate-200 bg-slate-100">
                      <div
                        className="h-full rounded-full bg-[#12335f] transition-all duration-700"
                        style={{ width: `${getProgress(selectedItem)}%` }}
                      />
                    </div>
                  </div>

                  {selectedItem.organization && (
                    <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
                      <div className="flex items-start justify-between gap-2.5 sm:gap-3">
                        <div>
                          <h3 className="text-[10px] font-extrabold uppercase tracking-wider text-emerald-800">
                            Organization Status
                          </h3>
                          <p className="mt-1 text-sm font-bold text-slate-950">
                            {selectedItem.organization.organizationName || selectedItem.organization.name || "Linked organization"}
                          </p>
                        </div>
                        <Badge variant="success" className="text-[8px]">
                          {selectedItem.organization.verificationStatus || "VERIFIED"}
                        </Badge>
                      </div>
                      <div className="grid gap-2 text-xs font-semibold text-emerald-900">
                        <div className="flex items-center justify-between gap-2.5 sm:gap-3 rounded-md border border-emerald-200 bg-white/70 px-3 py-2">
                          <span>Organization ID</span>
                          <span>#{selectedItem.organization.id || selectedItem.organizationId}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2.5 sm:gap-3 rounded-md border border-emerald-200 bg-white/70 px-3 py-2">
                          <span>Onboarding</span>
                          <span>{selectedItem.organization.organizationOnboardingStatus || selectedItem.onboardingStatus}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <h3 className="text-[10px] font-extrabold uppercase tracking-wider text-amber-800">
                        Compliance Flags
                      </h3>
                      <Badge variant={selectedItem.complianceViolations?.length ? "warning" : "success"} className="text-[8px]">
                        {selectedItem.complianceViolations?.length || 0} open
                      </Badge>
                    </div>
                    {selectedItem.complianceViolations?.length ? (
                      <div className="space-y-2">
                        {selectedItem.complianceViolations.map((flag: any) => (
                          <div key={flag.id} className="rounded-md border border-amber-200 bg-white p-3">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-slate-900">{flag.type?.replace(/_/g, " ")}</p>
                              <span className="rounded bg-amber-100 px-2 py-0.5 text-[9px] font-black uppercase text-amber-800">{flag.severity}</span>
                            </div>
                            <p className="mt-1 text-xs font-semibold text-slate-600">{flag.description}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs font-semibold text-amber-800">No open duplicate or fraud warnings.</p>
                    )}
                  </div>

                  {/* Quick Decision Buttons */}
                  <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                    <h3 className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
                      Scrutiny Decision Desk
                    </h3>
                    <Button
                      onClick={() =>
                        handleUpdateStatus(
                          selectedItem._id,
                          "approved_for_procurement",
                        )
                      }
                      disabled={
                        selectedItem.onboardingStatus === "approved_for_procurement"
                      }
                      className="h-12 w-full rounded-md bg-[#12335f] font-bold uppercase tracking-wide text-white hover:bg-[#0b2445] transition-all shadow-xs"
                    >
                      <CheckCircle className="h-5 w-5" />
                      <span>Approve Organization</span>
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setCorrectionReason("");
                        setIsCorrectionModalOpen(true);
                      }}
                      disabled={selectedItem.onboardingStatus === "resubmission_required"}
                      className="h-12 w-full rounded-md border-amber-300 bg-white font-bold uppercase tracking-wide text-amber-700 hover:bg-amber-50 transition-all"
                    >
                      <AlertTriangle className="h-5 w-5" />
                      <span>Request Correction</span>
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setAppRejectReason("");
                        setIsAppRejectModalOpen(true);
                      }}
                      disabled={selectedItem.onboardingStatus === "rejected"}
                      className="h-12 w-full rounded-md border-red-300 bg-white font-bold uppercase tracking-wide text-red-700 hover:bg-red-50 transition-all"
                    >
                      <XCircle className="h-5 w-5" />
                      <span>Reject Application</span>
                    </Button>
                  </div>

                </div>

                {/* Right Area: Structured Sections */}
                <div className="lg:col-span-8 space-y-6">
                  {selectedItem.role === "buyer" ? (
                    <>
                      {/* Buyer Section 1: Org */}
                      <div className="group rounded-lg border border-slate-200 bg-white p-5 shadow-sm animate-in slide-in-from-bottom-4 duration-300">
                        <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-100 relative">
                          <div className="flex items-center space-x-3">
                            <div className="w-9 h-9 rounded-md bg-slate-50 text-[#12335f] flex items-center justify-center shadow-sm">
                              <Building2 className="h-4 w-4" />
                            </div>
                            <h4 className="text-xs font-extrabold text-[#12335f] uppercase tracking-wide">
                              1. Organization Details
                            </h4>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button
                              onClick={() =>
                                handleUpdateSectionStatus(
                                  selectedItem._id,
                                  "org",
                                  "approved",
                                )
                              }
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.org === "approved"
                                  ? "bg-green-500 border-green-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-green-50 hover:text-green-600 hover:border-green-300",
                              )}
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => openRejectionModal("org")}
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.org === "rejected"
                                  ? "bg-red-500 border-red-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-red-50 hover:text-red-600 hover:border-red-300",
                              )}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        {(() => {
                          const gstDetails = selectedItem.profile?.gstVerificationDetails || {};
                          const gstin = selectedItem.profile?.gst || gstDetails.gstin || selectedItem.registrationDetails?.gstin;
                          return (
                            <div className="grid md:grid-cols-2 gap-8">
                              <InfoItem
                                label="Organization Name"
                                value={selectedItem.profile?.organizationName}
                                highlight
                              />
                              <InfoItem
                                label="Business Type"
                                value={selectedItem.profile?.businessType || selectedItem.registrationDetails?.businessType}
                              />
                              <InfoItem
                                label="Industry"
                                value={selectedItem.profile?.industry}
                              />
                              <InfoItem
                                label="PAN"
                                value={selectedItem.profile?.pan || selectedItem.registrationDetails?.pan}
                                mono
                                highlight
                              />
                              <InfoItem
                                label="CIN"
                                value={selectedItem.profile?.cin}
                              />
                              <InfoItem
                                label="GST"
                                value={gstin}
                              />
                              <InfoItem
                                label="GST Verification"
                                value={gstDetails.verified ? `Verified${gstDetails.source ? ` via ${gstDetails.source}` : ""}` : "Not Verified"}
                                highlight={Boolean(gstDetails.verified)}
                              />
                              {gstDetails.legalName && (
                                <InfoItem
                                  label="GST Legal Name"
                                  value={gstDetails.legalName}
                                />
                              )}
                              {gstDetails.status && (
                                <InfoItem
                                  label="GST Status"
                                  value={gstDetails.status}
                                />
                              )}
                              {gstDetails.address && (
                                <div className="md:col-span-2">
                                  <InfoItem
                                    label="GST Registered Address"
                                    value={[
                                      gstDetails.address,
                                      gstDetails.city,
                                      gstDetails.district,
                                      gstDetails.state,
                                      gstDetails.pincode,
                                    ].filter(Boolean).join(", ")}
                                  />
                                </div>
                              )}
                              <InfoItem
                                label="Website"
                                value={selectedItem.profile?.website}
                              />
                            </div>
                          );
                        })()}
                      </div>

                      {/* Buyer Section 2: Rep */}
                      <div className="group rounded-lg border border-slate-200 bg-white p-5 shadow-sm animate-in slide-in-from-bottom-4 duration-300 delay-75">
                        <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-100 relative">
                          <div className="flex items-center space-x-3">
                            <div className="w-9 h-9 rounded-md bg-slate-50 text-[#12335f] flex items-center justify-center shadow-sm">
                              <Users className="h-4 w-4" />
                            </div>
                            <h4 className="text-xs font-extrabold text-[#12335f] uppercase tracking-wide">
                              2. Authorized Representative
                            </h4>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button
                              onClick={() =>
                                handleUpdateSectionStatus(
                                  selectedItem._id,
                                  "rep",
                                  "approved",
                                )
                              }
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.rep === "approved"
                                  ? "bg-green-500 border-green-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-green-50 hover:text-green-600 hover:border-green-300",
                              )}
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => openRejectionModal("rep")}
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.rep === "rejected"
                                  ? "bg-red-500 border-red-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-red-50 hover:text-red-600 hover:border-red-300",
                              )}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <div className="grid md:grid-cols-2 gap-8">
                          <InfoItem
                            label="Representative Name"
                            value={selectedItem.profile?.representativeName || selectedItem.name}
                            highlight
                          />
                          <InfoItem
                            label="Designation"
                            value={selectedItem.profile?.designation}
                          />
                          <InfoItem
                            label="Department"
                            value={selectedItem.profile?.department}
                          />
                          <InfoItem
                            label="Official Email"
                            value={selectedItem.profile?.email || selectedItem.email}
                          />
                          <InfoItem
                            label="Mobile Number"
                            value={selectedItem.profile?.mobile || selectedItem.mobile}
                            highlight
                          />
                          <InfoItem
                            label="Alternate Mobile"
                            value={selectedItem.profile?.alternateMobile}
                          />
                        </div>
                      </div>

                      {/* Buyer Section 3: Address */}
                      <div className="group rounded-lg border border-slate-200 bg-white p-5 shadow-sm animate-in slide-in-from-bottom-4 duration-300">
                        <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-100 relative">
                          <div className="flex items-center space-x-3">
                            <div className="w-9 h-9 rounded-md bg-slate-50 text-[#12335f] flex items-center justify-center shadow-sm">
                              <MapPin className="h-4 w-4" />
                            </div>
                            <h4 className="text-xs font-extrabold text-[#12335f] uppercase tracking-wide">
                              3. Address Details
                            </h4>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button
                              onClick={() =>
                                handleUpdateSectionStatus(
                                  selectedItem._id,
                                  "address",
                                  "approved",
                                )
                              }
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.address ===
                                  "approved"
                                  ? "bg-green-500 border-green-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-green-50 hover:text-green-600 hover:border-green-300",
                              )}
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => openRejectionModal("address")}
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.address ===
                                  "rejected"
                                  ? "bg-red-500 border-red-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-red-50 hover:text-red-600 hover:border-red-300",
                              )}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <div className="grid md:grid-cols-2 gap-8">
                          <InfoItem
                            label="Country"
                            value={selectedItem.profile?.country}
                          />
                          <InfoItem
                            label="State"
                            value={selectedItem.profile?.state}
                          />
                          <InfoItem
                            label="City"
                            value={selectedItem.profile?.city}
                          />
                          <InfoItem
                            label="Pincode"
                            value={selectedItem.profile?.pincode}
                          />
                          <div className="md:col-span-2">
                            <InfoItem
                              label="Registered Address"
                              value={selectedItem.profile?.registeredAddress}
                            />
                          </div>
                          <div className="md:col-span-2">
                            <InfoItem
                              label="Corporate Address"
                              value={selectedItem.profile?.corporateAddress}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Buyer Section 4: Procurement */}
                      <div className="group rounded-lg border border-slate-200 bg-white p-5 shadow-sm animate-in slide-in-from-bottom-4 duration-300">
                        <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-100 relative">
                          <div className="flex items-center space-x-3">
                            <div className="w-9 h-9 rounded-md bg-slate-50 text-[#12335f] flex items-center justify-center shadow-sm">
                              <ShoppingBag className="h-4 w-4" />
                            </div>
                            <h4 className="text-xs font-extrabold text-[#12335f] uppercase tracking-wide">
                              4. Procurement Profile
                            </h4>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button
                              onClick={() =>
                                handleUpdateSectionStatus(
                                  selectedItem._id,
                                  "procurement",
                                  "approved",
                                )
                              }
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.procurement ===
                                  "approved"
                                  ? "bg-green-500 border-green-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-green-50 hover:text-green-600 hover:border-green-300",
                              )}
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => openRejectionModal("procurement")}
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.procurement ===
                                  "rejected"
                                  ? "bg-red-500 border-red-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-red-50 hover:text-red-600 hover:border-red-300",
                              )}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <div className="grid md:grid-cols-2 gap-8">
                          <InfoItem
                            label="Annual Budget"
                            value={selectedItem.profile?.annualBudget}
                            highlight
                          />
                          <div className="md:col-span-2">
                            <InfoItem
                              label="Procurement Categories"
                              value={[
                                selectedItem.profile?.procurementCategories?.join(", "),
                                selectedItem.profile?.otherCategoryDetails && `(Others: ${selectedItem.profile?.otherCategoryDetails})`
                              ].filter(Boolean).join(" ")}
                              highlight
                            />
                          </div>
                          <div className="md:col-span-2">
                            <InfoItem
                              label="Preferred Methods"
                              value={[
                                selectedItem.profile?.preferredMethods?.join(", "),
                                selectedItem.profile?.otherMethodDetails && `(Others: ${selectedItem.profile?.otherMethodDetails})`
                              ].filter(Boolean).join(" ")}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Buyer Section 5: Documents */}
                      <div className="group rounded-lg border border-slate-200 bg-white p-5 pb-6 shadow-sm animate-in slide-in-from-bottom-4 duration-300">
                        <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-100 relative">
                          <div className="flex items-center space-x-3">
                            <div className="w-9 h-9 rounded-md bg-slate-50 text-[#12335f] flex items-center justify-center shadow-sm">
                              <FileText className="h-4 w-4" />
                            </div>
                            <h4 className="text-xs font-extrabold text-[#12335f] uppercase tracking-wide">
                              5. Verification Documents
                            </h4>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button
                              onClick={() =>
                                handleUpdateSectionStatus(
                                  selectedItem._id,
                                  "docs",
                                  "approved",
                                )
                              }
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.docs === "approved"
                                  ? "bg-green-500 border-green-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-green-50 hover:text-green-600 hover:border-green-300",
                              )}
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => openRejectionModal("docs")}
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.docs === "rejected"
                                  ? "bg-red-500 border-red-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-red-50 hover:text-red-600 hover:border-red-300",
                              )}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        {(() => {
                          const buyerDocumentEntries = getBuyerOnboardingDocuments(selectedItem.profile);

                          return (
                            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                              {buyerDocumentEntries.map(
                                ([key, documentFiles]: [string, any[]]) =>
                                  documentFiles.map((file: any, index: number) => {
                                    const label = getDocumentLabel(key);
                                    const fileName = getDocumentFileName(file, `${label} Document`);
                                    const uploadedAt = getDocumentUploadedAt(file);
                                    const cardKey = `${key}-${index}-${file?.fileId || file?.url || fileName}`;
                                    const reasons = (selectedItem.sectionRejectionReasons as Record<string, string>) || {};
                                    const normKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
                                    const normLabel = label.toLowerCase().replace(/[^a-z0-9]/g, '');

                                    let docRejectionReason: string | null = null;
                                    for (const [rKey, rVal] of Object.entries(reasons)) {
                                      const normR = rKey.toLowerCase().replace(/[^a-z0-9]/g, '');
                                      if (normR === normKey || normR === normLabel) {
                                        docRejectionReason = String(rVal);
                                        break;
                                      }
                                    }
                                    if (!docRejectionReason) {
                                      if (normKey.includes('pan') && (reasons.pan || reasons.panCard || reasons.pan_copy || reasons.PAN_COPY)) {
                                        docRejectionReason = String(reasons.pan || reasons.panCard || reasons.pan_copy || reasons.PAN_COPY);
                                      } else if (normKey.includes('gst') && (reasons.gst || reasons.gstCert || reasons.gst_certificate || reasons.GST_CERTIFICATE)) {
                                        docRejectionReason = String(reasons.gst || reasons.gstCert || reasons.gst_certificate || reasons.GST_CERTIFICATE);
                                      } else if (normKey.includes('reg') && (reasons.regCert || reasons.cin || reasons.registration_certificate || reasons.REGISTRATION_CERTIFICATE)) {
                                        docRejectionReason = String(reasons.regCert || reasons.cin || reasons.registration_certificate || reasons.REGISTRATION_CERTIFICATE);
                                      } else if (normKey.includes('address') && (reasons.addressProof || reasons.address_proof || reasons.ADDRESS_PROOF)) {
                                        docRejectionReason = String(reasons.addressProof || reasons.address_proof || reasons.ADDRESS_PROOF);
                                      } else if (normKey.includes('auth') && (reasons.authLetter || reasons.authorization_letter || reasons.AUTHORIZATION_LETTER)) {
                                        docRejectionReason = String(reasons.authLetter || reasons.authorization_letter || reasons.AUTHORIZATION_LETTER);
                                      }
                                    }

                                     const isReupload = Boolean(docRejectionReason) && (selectedItem.sectionStatus?.docs === 'resubmission_required' || selectedItem.onboardingStatus === 'resubmission_required');
                                     const isApproved = selectedItem.sectionStatus?.docs === 'approved';
                                     const isRejected = selectedItem.sectionStatus?.docs === 'rejected';

                                    return (
                                      <div
                                        key={cardKey}
                                        className={cn(
                                          "p-4 rounded-xl border space-y-2 flex flex-col justify-between transition-all",
                                          isReupload
                                            ? "bg-amber-50/40 border-amber-300 ring-1 ring-amber-300/60 shadow-xs"
                                            : "bg-slate-50 border-slate-100"
                                        )}
                                      >
                                        <div>
                                          <div className="flex items-center justify-between gap-2.5 sm:gap-3">
                                            <span className="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider">
                                              {label}
                                            </span>
                                            <Badge
                                              variant="default"
                                              className={cn(
                                                "text-[9px] font-bold px-1.5 py-0.5",
                                                isReupload
                                                  ? "bg-amber-100 text-amber-900 border-amber-300 font-extrabold animate-pulse"
                                                  : isApproved
                                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                                    : isRejected
                                                      ? "bg-red-50 text-red-700 border-red-200"
                                                      : "bg-blue-50 text-blue-700 border-blue-200"
                                              )}
                                            >
                                              {isReupload
                                                ? "RE-UPLOAD REQUESTED"
                                                : isApproved
                                                  ? "VERIFIED"
                                                  : isRejected
                                                    ? "REJECTED"
                                                    : "PENDING REVIEW"}
                                            </Badge>
                                          </div>
                                          <p className="text-xs font-bold text-slate-700 mt-1 line-clamp-1" title={fileName}>
                                            {fileName}
                                          </p>
                                          {uploadedAt && (
                                            <p className="text-[9px] text-slate-400 mt-0.5">
                                              Uploaded: {formatDate(uploadedAt)}
                                            </p>
                                          )}
                                          {docRejectionReason && (
                                            <div className="mt-2 p-2 rounded-md bg-amber-50 border border-amber-200 text-[10px] text-amber-900">
                                              <span className="font-extrabold uppercase tracking-wider block text-amber-800 text-[8px]">
                                                Defect / Re-upload Note:
                                              </span>
                                              <span className="font-semibold text-amber-950 block mt-0.5">{docRejectionReason}</span>
                                            </div>
                                          )}
                                        </div>
                                        <div className="pt-2 border-t border-slate-100 mt-2 flex items-center justify-between gap-2">
                                          <button
                                            type="button"
                                            onClick={() => handleViewDocument({ fileId: file?.fileId, url: getDocumentUrl(file) }, label)}
                                            className="text-xs font-bold text-[#12335f] hover:underline inline-flex items-center gap-1"
                                          >
                                            <Eye className="h-3 w-3" /> View Document{documentFiles.length > 1 ? ` ${index + 1}` : ""}
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => handleOpenDocRequestModal(key, label)}
                                            className={cn(
                                              "text-[10px] font-bold inline-flex items-center gap-1 rounded px-2 py-1 border transition-colors shadow-2xs",
                                              isReupload
                                                ? "bg-amber-100 text-amber-900 border-amber-300 hover:bg-amber-200"
                                                : "text-amber-700 hover:text-amber-800 bg-amber-50 border-amber-200 hover:bg-amber-100"
                                            )}
                                          >
                                            <AlertTriangle className="h-3 w-3" /> {isReupload ? "Update Request" : "Request Re-upload"}
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  }),
                              )}
                              {buyerDocumentEntries.length === 0 && (
                                <div className="col-span-full py-4 text-center text-xs text-slate-400 font-medium">
                                  No uploaded documents found for this buyer profile.
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>

                      {/* Buyer Section 6: Showcase & Frequently Bought Items */}
                      <div className="group rounded-lg border border-slate-200 bg-white p-5 pb-6 shadow-sm animate-in slide-in-from-bottom-4 duration-300">
                        <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-100 relative">
                          <div className="flex items-center space-x-3">
                            <div className="w-9 h-9 rounded-md bg-slate-50 text-[#12335f] flex items-center justify-center shadow-sm">
                              <ShoppingBag className="h-4 w-4" />
                            </div>
                            <h4 className="text-xs font-extrabold text-[#12335f] uppercase tracking-wide">
                              6. Showcase & Frequently Bought Items
                            </h4>
                          </div>
                          
                          {/* Visibility & Verification Controls */}
                          <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
                            {/* Visibility Toggle */}
                            <div className="flex items-center space-x-3 bg-slate-50 border border-slate-200/60 px-3 py-1.5 rounded-xl shadow-sm">
                              <span className="text-[10px] font-black uppercase text-slate-500 tracking-wider">Showcase Active:</span>
                              <button
                                type="button"
                                onClick={() => handleToggleShowcaseVisibility(!showcaseActive)}
                                className={cn(
                                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
                                  showcaseActive ? "bg-emerald-500" : "bg-slate-350"
                                )}
                              >
                                <span
                                  className={cn(
                                    "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                                    showcaseActive ? "translate-x-4" : "translate-x-0"
                                  )}
                                />
                              </button>
                            </div>

                            {/* Verification Status & Buttons */}
                            <div className="flex items-center space-x-3 bg-slate-50 border border-slate-200/60 px-3 py-1.5 rounded-xl shadow-sm">
                              <span className="text-[10px] font-black uppercase text-slate-500 tracking-wider">Status:</span>
                              {selectedItem.profile?.verificationStatus === 'VERIFIED' ? (
                                <span className="px-2.5 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200">
                                  Verified
                                </span>
                              ) : selectedItem.profile?.verificationStatus === 'REJECTED' ? (
                                <span className="px-2.5 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider bg-red-50 text-red-700 border border-red-200">
                                  Rejected
                                </span>
                              ) : (
                                <span className="px-2.5 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider bg-amber-50 text-amber-700 border border-amber-200">
                                  Pending Review
                                </span>
                              )}
                              
                              <div className="flex items-center space-x-1.5 border-l border-slate-200 pl-3">
                                <button
                                  type="button"
                                  onClick={() => handleUpdateShowcaseStatus('VERIFIED')}
                                  className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 text-[9px] font-black text-white uppercase transition-colors"
                                >
                                  Verify
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleUpdateShowcaseStatus('REJECTED')}
                                  className="px-2 py-0.5 rounded bg-red-600 hover:bg-red-700 text-[9px] font-black text-white uppercase transition-colors"
                                >
                                  Reject
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Showcase Previews */}
                        <div className="grid md:grid-cols-2 gap-6 mb-6">
                          <div>
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider block mb-2">Showcase Logo</span>
                            {selectedItem.profile?.logoUrl ? (
                              <div className="border rounded-xl p-3 bg-white flex items-center justify-center h-24 w-24">
                                <img src={resolveMediaUrl(selectedItem.profile.logoUrl) || undefined} alt="Logo" className="max-h-full max-w-full object-contain" />
                              </div>
                            ) : (
                              <p className="text-[10px] font-bold text-slate-400 uppercase italic">No logo uploaded</p>
                            )}
                          </div>
                          <div>
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider block mb-2">Showcase Banner</span>
                            {selectedItem.profile?.bannerUrl ? (
                              <div className="border rounded-xl bg-slate-50 overflow-hidden h-24 w-full">
                                <img src={resolveMediaUrl(selectedItem.profile.bannerUrl) || undefined} alt="Banner" className="w-full h-full object-cover" />
                              </div>
                            ) : (
                              <p className="text-[10px] font-bold text-slate-400 uppercase italic">No banner uploaded</p>
                            )}
                          </div>
                        </div>

                        {/* Frequently Bought Items List */}
                        <div className="space-y-3">
                          <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider block">Frequently Bought Requirements List ({showcaseItems.length})</span>
                          
                          <DataTable
                            data={showcaseItems}
                            columns={[
                              {
                                key: 'serialNo',
                                header: 'Sl. No.',
                                width: 'w-16',
                                cell: (item: any, idx: number) => (
                                  <span className="font-bold text-slate-400">{item.serialNo || (idx + 1)}</span>
                                )
                              },
                              {
                                key: 'itemDescription',
                                header: 'Item Description',
                                cell: (item: any) => (
                                  <span className="font-extrabold text-slate-900">{item.itemDescription}</span>
                                )
                              },
                              {
                                key: 'category',
                                header: 'Category',
                                width: 'w-28',
                                cell: (item: any) => (
                                  item.category ? (
                                    <span className="bg-slate-100 text-slate-800 rounded px-1.5 py-0.5 text-[9px] font-bold">
                                      {item.category}
                                    </span>
                                  ) : (
                                    "-"
                                  )
                                )
                              },
                              {
                                key: 'estimatedMonthlyRequirement',
                                header: 'Monthly Qty',
                                width: 'w-28',
                                cell: (item: any) => (
                                  <span className="text-slate-900 font-bold">{item.estimatedMonthlyRequirement || "-"}</span>
                                )
                              },
                              {
                                key: 'unit',
                                header: 'Unit',
                                width: 'w-20',
                                cell: (item: any) => (
                                  <span className="text-slate-500 font-bold">{item.unit || "-"}</span>
                                )
                              }
                            ]}
                            keyExtractor={(item: any) => item.id}
                            isLoading={showcaseItemsLoading}
                            emptyTitle="No showcase items uploaded by this buyer."
                            emptyDescription="This buyer has not listed any recurring requirements yet."
                            rowClassName="hover:bg-slate-50/40 text-[11px]"
                          />
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Section 1: PAN */}
                      <div className="group rounded-lg border border-slate-200 bg-white p-5 shadow-sm animate-in slide-in-from-bottom-4 duration-300">
                        <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-100 relative">
                          <div className="flex items-center space-x-3">
                            <div className="w-9 h-9 rounded-md bg-slate-50 text-[#12335f] flex items-center justify-center shadow-sm">
                              <ShieldCheck className="h-4 w-4" />
                            </div>
                            <h4 className="text-xs font-extrabold text-[#12335f] uppercase tracking-wide">
                              1. Business PAN Validation
                            </h4>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button
                              onClick={() =>
                                handleUpdateSectionStatus(
                                  selectedItem._id,
                                  "pan",
                                  "approved",
                                )
                              }
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.pan === "approved"
                                  ? "bg-green-500 border-green-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-green-50 hover:text-green-600 hover:border-green-300",
                              )}
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => openRejectionModal("pan")}
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.pan === "rejected"
                                  ? "bg-red-500 border-red-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-red-50 hover:text-red-600 hover:border-red-300",
                              )}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <div className="grid md:grid-cols-2 gap-8">
                          <InfoItem
                            label="Organisation Type"
                            value={selectedItem.registrationDetails?.businessType || (selectedItem.profile?.organizationType && selectedItem.profile?.organizationType !== 'MSME' ? selectedItem.profile?.organizationType : null) || selectedItem.profile?.organizationType || "N/A"}
                            highlight
                          />
                          <InfoItem
                            label="PAN Number"
                            value={selectedItem.profile?.pan || selectedItem.organization?.panNumber || selectedItem.registrationDetails?.pan}
                            mono
                            highlight
                          />
                          <InfoItem
                            label="Name in PAN"
                            value={selectedItem.profile?.nameAsInPan || selectedItem.profile?.panName || selectedItem.registrationDetails?.nameAsInPan || selectedItem.profile?.businessName || selectedItem.organization?.organizationName || "N/A"}
                          />
                          <InfoItem
                            label="Date in PAN"
                            value={
                              (selectedItem.profile?.dateAsInPan || selectedItem.profile?.dateOfIncorporation || selectedItem.registrationDetails?.dateAsInPan)
                                ? formatDate(selectedItem.profile?.dateAsInPan || selectedItem.profile?.dateOfIncorporation || selectedItem.registrationDetails?.dateAsInPan)
                                : "N/A"
                            }
                          />
                          <InfoItem
                            label="Verification Status"
                            value={
                              selectedItem.profile?.panVerified
                                ? "VERIFIED"
                                : "PENDING"
                            }
                            highlight
                          />
                          {getGstNumber(selectedItem) && (
                            <InfoItem
                              label="GSTIN / GST Number"
                              value={getGstNumber(selectedItem)}
                              mono
                              highlight
                            />
                          )}
                        </div>
                      </div>

                      {/* Section 2: Details */}
                      <div className="group rounded-lg border border-slate-200 bg-white p-5 shadow-sm animate-in slide-in-from-bottom-4 duration-300 delay-75">
                        <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-100 relative">
                          <div className="flex items-center space-x-3">
                            <div className="w-9 h-9 rounded-md bg-slate-50 text-[#12335f] flex items-center justify-center shadow-sm">
                              <Building2 className="h-4 w-4" />
                            </div>
                            <h4 className="text-xs font-extrabold text-[#12335f] uppercase tracking-wide">
                              2. Business Details
                            </h4>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button
                              onClick={() =>
                                handleUpdateSectionStatus(
                                  selectedItem._id,
                                  "details",
                                  "approved",
                                )
                              }
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.details ===
                                  "approved"
                                  ? "bg-green-500 border-green-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-green-50 hover:text-green-600 hover:border-green-300",
                              )}
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => openRejectionModal("details")}
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.details ===
                                  "rejected"
                                  ? "bg-red-500 border-red-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-red-50 hover:text-red-600 hover:border-red-300",
                              )}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <div className="grid md:grid-cols-2 gap-8">
                          <InfoItem
                            label="Organization Name"
                            value={selectedItem.profile?.businessName || selectedItem.profile?.organizationName || selectedItem.organization?.organizationName || "N/A"}
                            highlight
                          />
                          <InfoItem
                            label="Date of Incorporation"
                            value={
                              selectedItem.profile?.dateOfIncorporation
                                ? formatDate(selectedItem.profile.dateOfIncorporation)
                                : "N/A"
                            }
                          />
                          <InfoItem
                            label="Role In Organization"
                            value={selectedItem.profile?.roleInOrg || selectedItem.registrationDetails?.roleInOrg || "N/A"}
                          />
                          <InfoItem
                            label="Registered Mobile"
                            value={selectedItem.profile?.mobile || selectedItem.mobile || selectedItem.profile?.offices?.[0]?.contactNumber || "N/A"}
                          />
                          {getGstNumber(selectedItem) && (
                            <InfoItem
                              label="GST Number"
                              value={getGstNumber(selectedItem)}
                              mono
                              highlight
                            />
                          )}
                          {getUdyamNumber(selectedItem) && (
                            <InfoItem
                              label="Udyam Registration Number"
                              value={getUdyamNumber(selectedItem)}
                              mono
                              highlight
                            />
                          )}
                          {getCinNumber(selectedItem) && (
                            <InfoItem
                              label="Corporate Identification Number (CIN)"
                              value={getCinNumber(selectedItem)}
                              mono
                              highlight
                            />
                          )}
                        </div>
                      </div>

                      {/* Section 3: Additional */}
                      <div className="group rounded-lg border border-slate-200 bg-white p-5 shadow-sm animate-in slide-in-from-bottom-4 duration-300">
                        <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-100 relative">
                          <div className="flex items-center space-x-3">
                            <div className="w-9 h-9 rounded-md bg-slate-50 text-[#12335f] flex items-center justify-center shadow-sm">
                              <Briefcase className="h-4 w-4" />
                            </div>
                            <h4 className="text-xs font-extrabold text-[#12335f] uppercase tracking-wide">
                              3. Additional Details
                            </h4>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button
                              onClick={() =>
                                handleUpdateSectionStatus(
                                  selectedItem._id,
                                  "additional",
                                  "approved",
                                )
                              }
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.additional ===
                                  "approved"
                                  ? "bg-green-500 border-green-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-green-50 hover:text-green-600 hover:border-green-300",
                              )}
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => openRejectionModal("additional")}
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.additional ===
                                  "rejected"
                                  ? "bg-red-500 border-red-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-red-50 hover:text-red-600 hover:border-red-300",
                              )}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <div className="grid md:grid-cols-2 gap-8">
                          <InfoItem
                            label="Startup Status"
                            value={
                              selectedItem.profile?.isStartup ? "YES" : "NO"
                            }
                          />
                          <InfoItem
                            label="Udyam Certified"
                            value={
                              selectedItem.profile?.isUdyamCertified
                                ? "YES"
                                : "NO"
                            }
                          />
                          <InfoItem
                            label="Bid Participation"
                            value={
                              selectedItem.profile?.participateInBid
                                ? "YES"
                                : "NO"
                            }
                          />
                          <InfoItem
                            label="MSME Type"
                            value={
                              selectedItem.profile?.msmeType
                                ? (MSME_TYPE_LABELS[selectedItem.profile.msmeType] || selectedItem.profile.msmeType)
                                : "N/A"
                            }
                          />
                          <InfoItem
                            label="Vendor Type"
                            value={
                              selectedItem.profile?.vendorType
                                ? (VENDOR_TYPE_LABELS[selectedItem.profile.vendorType] || selectedItem.profile.vendorType)
                                : "N/A"
                            }
                          />
                          <div className="md:col-span-2">
                            <InfoItem
                              label="Registration Types / Certifications"
                              value={
                                Array.isArray(selectedItem.profile?.registrationTypes) && selectedItem.profile.registrationTypes.length > 0
                                  ? selectedItem.profile.registrationTypes
                                    .map((type: string) => REGISTRATION_TYPE_LABELS[type] || type)
                                    .join(", ")
                                  : "N/A"
                              }
                            />
                          </div>
                        </div>
                      </div>

                      {/* Section 4: Offices */}
                      <div className="group rounded-lg border border-slate-200 bg-white p-5 shadow-sm animate-in slide-in-from-bottom-4 duration-300">
                        <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-100 relative">
                          <div className="flex items-center space-x-3">
                            <div className="w-9 h-9 rounded-md bg-slate-50 text-[#12335f] flex items-center justify-center shadow-sm">
                              <MapPin className="h-4 w-4" />
                            </div>
                            <h4 className="text-xs font-extrabold text-[#12335f] uppercase tracking-wide">
                              4. Office Locations
                            </h4>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button
                              onClick={() =>
                                handleUpdateSectionStatus(
                                  selectedItem._id,
                                  "offices",
                                  "approved",
                                )
                              }
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.offices ===
                                  "approved"
                                  ? "bg-green-500 border-green-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-green-50 hover:text-green-600 hover:border-green-300",
                              )}
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => openRejectionModal("offices")}
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.offices ===
                                  "rejected"
                                  ? "bg-red-500 border-red-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-red-50 hover:text-red-600 hover:border-red-300",
                              )}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <div className="space-y-4">
                          {selectedItem.profile?.offices?.map((office: any) => (
                            <div
                              key={office.id}
                              className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex justify-between items-start"
                            >
                              <div className="space-y-1">
                                <div className="flex items-center flex-wrap gap-2">
                                  <p className="text-xs font-extrabold text-slate-900 uppercase">
                                    {office.name}
                                  </p>
                                  <span className="text-[10px] font-bold text-[#12335f] bg-slate-100 px-2 py-0.5 rounded-full">
                                    {office.type}
                                  </span>
                                  {office.gstRegistered && (
                                    <Badge variant="success" className="text-[8px]">
                                      GST REG: {office.gstNumber || office.gstMasked || "Registered"}
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-[11px] font-medium text-slate-600 uppercase">
                                  {office.address}
                                </p>
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                  {office.city}, {office.state} - {office.pincode}
                                </p>
                                {office.contactNumber && (
                                  <p className="text-[10px] font-bold text-slate-500 uppercase">
                                    Contact: <span className="text-slate-700 font-semibold">{office.contactNumber}</span>
                                  </p>
                                )}
                              </div>
                            </div>
                          ))}
                          {(!selectedItem.profile?.offices ||
                            selectedItem.profile.offices.length === 0) && (
                              <p className="text-[10px] font-bold text-slate-400">
                                No offices registered.
                              </p>
                            )}
                        </div>
                      </div>

                      {/* Section 5: Bank */}
                      <div className="group rounded-lg border border-slate-200 bg-white p-5 shadow-sm animate-in slide-in-from-bottom-4 duration-300">
                        <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-100 relative">
                          <div className="flex items-center space-x-3">
                            <div className="w-9 h-9 rounded-md bg-slate-50 text-[#12335f] flex items-center justify-center shadow-sm">
                              <Building2 className="h-4 w-4" />
                            </div>
                            <h4 className="text-xs font-extrabold text-[#12335f] uppercase tracking-wide">
                              5. Bank Accounts
                            </h4>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button
                              onClick={() =>
                                handleUpdateSectionStatus(
                                  selectedItem._id,
                                  "bank",
                                  "approved",
                                )
                              }
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.bank === "approved"
                                  ? "bg-green-500 border-green-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-green-50 hover:text-green-600 hover:border-green-300",
                              )}
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => openRejectionModal("bank")}
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm",
                                selectedItem.sectionStatus?.bank === "rejected"
                                  ? "bg-red-500 border-red-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-red-50 hover:text-red-600 hover:border-red-300",
                              )}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <div className="space-y-4">
                          {selectedItem.profile?.bankAccounts?.map(
                            (bank: any) => (
                              <div
                                key={bank.id}
                                className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex justify-between items-start"
                              >
                                <div className="space-y-1">
                                  <p className="text-xs font-extrabold text-slate-900 uppercase">
                                    {bank.bankName}{" "}
                                    {bank.isPrimary && (
                                      <span className="text-[10px] font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded-full ml-2">
                                        PRIMARY
                                      </span>
                                    )}
                                  </p>
                                  <p className="text-[11px] font-bold text-slate-700 uppercase">
                                    A/C:{" "}
                                    <span className="text-slate-900">
                                      <MaskedDataDisplay value={bank.accountNumber || bank.accountNumberMasked} type="bankAccount" />
                                    </span>{" "}
                                    | IFSC:{" "}
                                    <span className="text-slate-900">
                                      {bank.ifsc || bank.ifscCode}
                                    </span>
                                  </p>
                                  <p className="text-[10px] font-medium text-slate-500 uppercase">
                                    Holder: {bank.holderName}
                                  </p>
                                  <p className="text-[10px] font-medium text-slate-400 uppercase">
                                    {bank.bankAddress}
                                  </p>
                                </div>
                                {bank.isVerified && (
                                  <Badge
                                    variant="success"
                                    className="text-[8px] h-5"
                                  >
                                    VERIFIED
                                  </Badge>
                                )}
                              </div>
                            ),
                          )}
                        </div>
                      </div>

                      {/* Section 6: Submitted Verification Documents */}
                      <div className="group rounded-lg border border-slate-200 bg-white p-5 pb-6 shadow-sm animate-in slide-in-from-bottom-4 duration-300">
                        <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-100 relative">
                          <div className="flex items-center space-x-3">
                            <div className="w-9 h-9 rounded-md bg-slate-50 text-[#12335f] flex items-center justify-center shadow-sm">
                              <FileText className="h-4 w-4" />
                            </div>
                            <h4 className="text-xs font-extrabold text-[#12335f] uppercase tracking-wide">
                              6. Submitted Verification Documents
                            </h4>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button
                              type="button"
                              onClick={() =>
                                handleUpdateSectionStatus(
                                  selectedItem._id,
                                  "documents",
                                  "approved",
                                )
                              }
                              aria-label="Approve Submitted Verification Documents"
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500",
                                selectedItem.sectionStatus?.documents ===
                                  "approved"
                                  ? "bg-green-500 border-green-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-green-50 hover:text-green-600 hover:border-green-300",
                              )}
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => openRejectionModal("documents")}
                              aria-label="Reject Submitted Verification Documents"
                              className={cn(
                                "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500",
                                selectedItem.sectionStatus?.documents ===
                                  "rejected"
                                  ? "bg-red-500 border-red-600 text-white"
                                  : "bg-white border-slate-200 text-slate-300 hover:bg-red-50 hover:text-red-600 hover:border-red-300",
                              )}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>

                        {(() => {
                          const { sellerDocuments, legacyDocuments } = getSellerOnboardingDocuments(selectedItem.profile);
                          return (
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                              {/* Render sellerDocuments (relational) */}
                              {sellerDocuments.length > 0 ? (
                                sellerDocuments.map((doc: any) => {
                                  const file = doc.fileAsset;
                                  const fileName = getDocumentFileName(file, `${doc.documentType || "Document"} File`);
                                  const uploadedAt = doc.uploadedAt || getDocumentUploadedAt(file);
                                  const status = doc.verificationStatus || "PENDING";

                                  const reasons = (selectedItem.sectionRejectionReasons as Record<string, string>) || {};
                                  const normDocType = (doc.documentType || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                                  const docCat = getCanonicalDocCategory(doc.documentType);

                                  let sellerDocRejectionReason: string | null = doc.remarks || null;
                                  if (!sellerDocRejectionReason) {
                                    for (const [rKey, rVal] of Object.entries(reasons)) {
                                      const normR = rKey.toLowerCase().replace(/[^a-z0-9]/g, "");
                                      if (normR === normDocType || (docCat && getCanonicalDocCategory(rKey) === docCat)) {
                                        sellerDocRejectionReason = String(rVal);
                                        break;
                                      }
                                    }
                                  }

                                  const isSellerReupload =
                                    (status === "REJECTED" || Boolean(sellerDocRejectionReason)) &&
                                    (selectedItem.sectionStatus?.documents === "resubmission_required" ||
                                      selectedItem.onboardingStatus === "resubmission_required");

                                  return (
                                    <div
                                      key={doc.id}
                                      className={cn(
                                        "h-full min-w-0 rounded-xl border p-4 flex flex-col justify-between transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)]",
                                        isSellerReupload
                                          ? "bg-amber-50/40 border-amber-300 ring-1 ring-amber-300/60 shadow-xs"
                                          : "bg-slate-50/70 border-slate-200/80 hover:bg-slate-50 hover:border-slate-300"
                                      )}
                                    >
                                      <div className="space-y-1 min-w-0">
                                        <div className="flex items-start justify-between gap-2 min-w-0 pb-0.5">
                                          <span
                                            className="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider truncate min-w-0 block"
                                            title={doc.documentType}
                                          >
                                            {doc.documentType}
                                          </span>
                                          <Badge
                                            variant="default"
                                            className={cn(
                                              "shrink-0 text-[9px] font-bold px-2 py-0.5 whitespace-nowrap",
                                              isSellerReupload
                                                ? "bg-amber-100 text-amber-900 border-amber-300 font-extrabold animate-pulse"
                                                : status === "APPROVED"
                                                  ? "bg-green-50 text-green-700 border-green-200"
                                                  : status === "REJECTED"
                                                    ? "bg-red-50 text-red-700 border-red-200"
                                                    : "bg-yellow-50 text-yellow-700 border-yellow-200"
                                            )}
                                          >
                                            {isSellerReupload
                                              ? "RE-UPLOAD REQUESTED"
                                              : status === "APPROVED"
                                                ? "VERIFIED"
                                                : status === "REJECTED"
                                                  ? "REJECTED"
                                                  : "PENDING REVIEW"}
                                          </Badge>
                                        </div>
                                        <p
                                          className="text-xs font-bold text-slate-700 truncate mt-1 block min-w-0"
                                          title={fileName}
                                        >
                                          {fileName}
                                        </p>
                                        {uploadedAt && (
                                          <p className="text-[10px] text-slate-400 mt-1 truncate">
                                            Uploaded: {formatDate(uploadedAt)}
                                          </p>
                                        )}
                                        {sellerDocRejectionReason && (
                                          <div className="mt-2 p-2 rounded-md bg-amber-50 border border-amber-200 text-[10px] text-amber-900">
                                            <span className="font-extrabold uppercase tracking-wider block text-amber-800 text-[8px]">
                                              Defect / Re-upload Note:
                                            </span>
                                            <span className="font-semibold text-amber-950 block mt-0.5 break-words">
                                              {sellerDocRejectionReason}
                                            </span>
                                          </div>
                                        )}
                                        {!sellerDocRejectionReason && doc.remarks && (
                                          <p
                                            className="text-[10px] text-slate-500 mt-1 italic truncate"
                                            title={doc.remarks}
                                          >
                                            Note: {doc.remarks}
                                          </p>
                                        )}
                                      </div>
                                      <div className="pt-2.5 border-t border-slate-200/80 mt-3 flex items-center justify-between gap-2">
                                        <button
                                          type="button"
                                          onClick={() => handleViewDocument({
                                            ...doc,
                                            fileAssetId: doc.fileAssetId || file?.id,
                                            fileId: doc.fileAssetId || file?.id,
                                            fileAsset: file,
                                            originalName: file?.originalName || doc.originalName,
                                            mimeType: file?.mimeType || doc.mimeType,
                                            url: doc.url || getDocumentUrl(file)
                                          }, doc.label || doc.documentType)}
                                          disabled={viewingDocKey === (doc.fileAssetId || file?.id || doc.url || doc.id || doc.documentType)}
                                          className="text-xs font-bold text-[#12335f] hover:text-[#0d274b] hover:underline inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#12335f]/30 rounded transition-colors disabled:opacity-60"
                                          aria-label={`View ${doc.label || doc.documentType || "document"}`}
                                        >
                                          {viewingDocKey === (doc.fileAssetId || file?.id || doc.url || doc.id || doc.documentType) ? (
                                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#12335f]" aria-hidden="true" />
                                          ) : (
                                            <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                          )}
                                          <span>{viewingDocKey === (doc.fileAssetId || file?.id || doc.url || doc.id || doc.documentType) ? "Opening..." : "View Document"}</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handleOpenDocRequestModal(doc.documentType, doc.documentType)}
                                          className={cn(
                                            "text-[10px] font-bold inline-flex items-center gap-1 rounded px-2 py-1 border transition-colors shadow-2xs focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500",
                                            isSellerReupload
                                              ? "bg-amber-100 text-amber-900 border-amber-300 hover:bg-amber-200"
                                              : "text-amber-700 hover:text-amber-800 bg-amber-50 border-amber-200 hover:bg-amber-100"
                                          )}
                                        >
                                          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                                          <span>{isSellerReupload ? "Update Request" : "Request Re-upload"}</span>
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })
                              ) : null}

                              {/* Render legacyDocuments if any */}
                              {legacyDocuments.length > 0 &&
                                legacyDocuments.map(([key, url]: [string, any]) => {
                                  const documentFiles = getDocumentFiles(url).filter(getDocumentUrl);
                                  if (documentFiles.length === 0) return null;
                                  const label = getDocumentLabel(key);
                                  const reasons = (selectedItem.sectionRejectionReasons as Record<string, string>) || {};
                                  const normKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
                                  const legacyCat = getCanonicalDocCategory(key);

                                  let docRejectionReason: string | null = null;
                                  for (const [rKey, rVal] of Object.entries(reasons)) {
                                    const normR = rKey.toLowerCase().replace(/[^a-z0-9]/g, "");
                                    if (normR === normKey || (legacyCat && getCanonicalDocCategory(rKey) === legacyCat)) {
                                      docRejectionReason = String(rVal);
                                      break;
                                    }
                                  }

                                  const isReupload =
                                    Boolean(docRejectionReason) &&
                                    (selectedItem.sectionStatus?.documents === "resubmission_required" ||
                                      selectedItem.onboardingStatus === "resubmission_required");

                                  return documentFiles.map((file: any, index: number) => {
                                    const fileName = getDocumentFileName(file, `${label} Document`);
                                    const uploadedAt = getDocumentUploadedAt(file);
                                    const cardKey = `legacy-${key}-${index}-${file?.fileId || file?.url || fileName}`;
                                    const status = isReupload ? "RE-UPLOAD REQUESTED" : "PENDING";
                                    return (
                                      <div
                                        key={cardKey}
                                        className={cn(
                                          "h-full min-w-0 rounded-xl border p-4 flex flex-col justify-between transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)]",
                                          isReupload
                                            ? "bg-amber-50/40 border-amber-300 ring-1 ring-amber-300/60 shadow-xs"
                                            : "bg-slate-50/70 border-slate-200/80 hover:bg-slate-50 hover:border-slate-300"
                                        )}
                                      >
                                        <div className="space-y-1 min-w-0">
                                          <div className="flex items-start justify-between gap-2 min-w-0 pb-0.5">
                                            <span
                                              className="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider truncate min-w-0 block"
                                              title={label}
                                            >
                                              {label}
                                            </span>
                                            <Badge
                                              variant="default"
                                              className={cn(
                                                "shrink-0 text-[9px] font-bold px-2 py-0.5 whitespace-nowrap",
                                                isReupload
                                                  ? "bg-amber-100 text-amber-900 border-amber-300 font-extrabold animate-pulse"
                                                  : "bg-yellow-50 text-yellow-700 border-yellow-200"
                                              )}
                                            >
                                              {status}
                                            </Badge>
                                          </div>
                                          <p
                                            className="text-xs font-bold text-slate-700 truncate mt-1 block min-w-0"
                                            title={fileName}
                                          >
                                            {fileName}
                                          </p>
                                          {uploadedAt && (
                                            <p className="text-[10px] text-slate-400 mt-1 truncate">
                                              Uploaded: {formatDate(uploadedAt)}
                                            </p>
                                          )}
                                          {docRejectionReason && (
                                            <div className="mt-2 p-2 rounded-md bg-amber-50 border border-amber-200 text-[10px] text-amber-900">
                                              <span className="font-extrabold uppercase tracking-wider block text-amber-800 text-[8px]">
                                                Defect / Re-upload Note:
                                              </span>
                                              <span className="font-semibold text-amber-950 block mt-0.5 break-words">
                                                {docRejectionReason}
                                              </span>
                                            </div>
                                          )}
                                        </div>
                                        <div className="pt-2.5 border-t border-slate-200/80 mt-3 flex items-center justify-between gap-2">
                                          <button
                                            type="button"
                                            onClick={() =>
                                              handleViewDocument(
                                                { fileId: file?.fileId, url: getDocumentUrl(file) },
                                                label,
                                              )
                                            }
                                            disabled={viewingDocKey === (file?.fileId || getDocumentUrl(file) || label)}
                                            className="text-xs font-bold text-[#12335f] hover:text-[#0d274b] hover:underline inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#12335f]/30 rounded transition-colors disabled:opacity-60"
                                            aria-label={`View ${label} document${documentFiles.length > 1 ? ` ${index + 1}` : ""}`}
                                          >
                                            {viewingDocKey === (file?.fileId || getDocumentUrl(file) || label) ? (
                                              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#12335f]" aria-hidden="true" />
                                            ) : (
                                              <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                            )}
                                            <span>
                                              {viewingDocKey === (file?.fileId || getDocumentUrl(file) || label) ? "Opening..." : `View Document${documentFiles.length > 1 ? ` ${index + 1}` : ""}`}
                                            </span>
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => handleOpenDocRequestModal(key, label)}
                                            className={cn(
                                              "text-[10px] font-bold inline-flex items-center gap-1 rounded px-2 py-1 border transition-colors shadow-2xs focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500",
                                              isReupload
                                                ? "bg-amber-100 text-amber-900 border-amber-300 hover:bg-amber-200"
                                                : "text-amber-700 hover:text-amber-800 bg-amber-50 border-amber-200 hover:bg-amber-100"
                                            )}
                                          >
                                            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                                            <span>{isReupload ? "Update Request" : "Request Re-upload"}</span>
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  });
                                })}

                              {sellerDocuments.length === 0 && legacyDocuments.length === 0 && (
                                <div className="col-span-full py-6 text-center text-xs text-slate-400 font-medium">
                                  No uploaded documents found for this seller profile.
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-center border-t border-slate-200 bg-white px-8 py-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                End of application record for verification
              </p>
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* REJECTION REASON MODAL */}
      {isRejectModalOpen && isMounted && typeof document !== 'undefined' && createPortal(
        <FocusTrap active onEscape={() => {
          setIsRejectModalOpen(false);
          setRejectionReason("");
        }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reject-section-modal-title"
            className="fixed inset-0 z-[110] flex items-center justify-center p-4"
          >
            <div
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300"
              onClick={() => {
                setIsRejectModalOpen(false);
                setRejectionReason("");
              }}
            />
            <div className="relative w-full max-w-md overflow-hidden rounded-lg border border-slate-300 bg-white shadow-2xl animate-in zoom-in-95 duration-300">
              <div className="flex items-center justify-between border-b border-slate-200 bg-[#12335f] px-6 py-4 text-white">
                <div className="space-y-1">
                  <h3 id="reject-section-modal-title" className="text-base font-extrabold uppercase tracking-tight">
                    Provide Rejection Reason
                  </h3>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-100">
                    Section: {activeSectionForRejection}
                  </p>
                </div>
                <button
                  onClick={() => {
                    setIsRejectModalOpen(false);
                    setRejectionReason("");
                  }}
                  className="flex h-9 w-9 items-center justify-center rounded-md border border-white/20 bg-white/10 text-white transition-colors hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-[#f9a825]"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-5 p-6">
                <div className="space-y-3">
                  <p className="text-xs font-medium leading-relaxed text-slate-600">
                    Please specify why this section is being rejected. This
                    feedback will be visible to the {selectedItem?.role}.
                  </p>
                  <textarea
                    value={rejectionReason}
                    onChange={(e) => setRejectionReason(e.target.value)}
                    placeholder="e.g., Uploaded documents are incorrect or unreadable..."
                    className="h-32 w-full resize-none rounded-md border border-slate-300 bg-white p-3 text-xs font-medium transition-all focus:outline-none focus:ring-2 focus:ring-red-600"
                    autoFocus
                  />
                </div>

                <div className="flex flex-col space-y-3">
                  <Button
                    onClick={handleConfirmRejection}
                    disabled={!rejectionReason.trim()}
                    className="h-11 w-full rounded-md bg-red-700 font-bold uppercase tracking-wide text-white hover:bg-red-800"
                  >
                    Confirm Rejection
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsRejectModalOpen(false);
                      setRejectionReason("");
                    }}
                    className="h-11 w-full rounded-md border-slate-300 font-bold uppercase tracking-wide text-slate-600 hover:bg-slate-50"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </FocusTrap>,
        document.body
      )}
      {/* COMPLIANCE OVERRIDE MODAL */}
      {isOverrideModalOpen && isMounted && typeof document !== 'undefined' && createPortal(
        <FocusTrap active onEscape={() => {
          setIsOverrideModalOpen(false);
          setOverrideReason("");
        }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="override-modal-title"
            className="fixed inset-0 z-[110] flex items-center justify-center p-4"
          >
            <div
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300"
              onClick={() => {
                setIsOverrideModalOpen(false);
                setOverrideReason("");
              }}
            />
            <div className="relative w-full max-w-lg overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl animate-in zoom-in-95 duration-300">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-slate-200 bg-[#12335f] px-6 py-4 text-white">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-300 animate-pulse" aria-hidden="true" />
                  <div className="space-y-0.5">
                    <h3 id="override-modal-title" className="text-base font-extrabold uppercase tracking-tight">
                      Compliance Override Required
                    </h3>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-100">
                      Admin Approval Authorization
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setIsOverrideModalOpen(false);
                    setOverrideReason("");
                  }}
                  aria-label="Close dialog"
                  className="flex h-9 w-9 items-center justify-center rounded-md border border-white/20 bg-white/10 text-white transition-colors hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-[#f9a825]"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>

              {/* Content */}
              <div className="space-y-5 p-6 max-h-[75vh] overflow-y-auto">
                <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-700" aria-hidden="true" />
                    <p className="text-xs font-bold text-amber-900">
                      Open Compliance Warnings Detected
                    </p>
                  </div>
                  <p className="text-xs font-medium leading-relaxed text-slate-600">
                    This profile has active compliance violations. Approving this organization requires providing a justification to log the override.
                  </p>

                  {/* List of violations */}
                  {selectedItem?.complianceViolations && selectedItem.complianceViolations.length > 0 && (
                    <div className="mt-2 space-y-2 max-h-40 overflow-y-auto pr-1">
                      {selectedItem.complianceViolations.map((flag: any) => (
                        <div key={flag.id || flag._id} className="rounded-md border border-amber-200 bg-white p-2.5 shadow-sm">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[9px] font-black uppercase tracking-widest text-[#12335f]">
                              {flag.type?.replace(/_/g, " ")}
                            </p>
                            <span className={cn(
                              "rounded px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider",
                              flag.severity === "critical" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"
                            )}>
                              {flag.severity}
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] font-semibold text-slate-600">
                            {flag.description}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <label htmlFor="admin-override-reason" className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                    Admin Override Reason
                  </label>
                  <textarea
                    id="admin-override-reason"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="Explain why this profile is being approved despite compliance flags (e.g., Verified physical documents, verified alternate business representation...)"
                    className="h-28 w-full resize-none rounded-lg border border-slate-300 bg-white p-3 text-xs font-medium transition-all focus:border-[#12335f] focus:outline-none focus:ring-2 focus:ring-[#12335f]/20"
                    autoFocus
                  />
                </div>

                {/* Action Buttons */}
                <div className="flex flex-col space-y-3 pt-2">
                  <Button
                    onClick={() => handleUpdateStatus(selectedItem._id, "approved_for_procurement", overrideReason)}
                    disabled={!overrideReason.trim()}
                    className="h-11 w-full rounded-md bg-[#12335f] font-bold uppercase tracking-wide text-white hover:bg-[#0b2445] transition-all"
                  >
                    Confirm Override Approval
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsOverrideModalOpen(false);
                      setOverrideReason("");
                    }}
                    className="h-11 w-full rounded-md border-slate-300 font-bold uppercase tracking-wide text-slate-600 hover:bg-slate-50"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </FocusTrap>,
        document.body
      )}
      {/* DOCUMENT RE-UPLOAD REQUEST MODAL */}
      {isDocRequestModalOpen && docRequestTarget && isMounted && typeof document !== 'undefined' && createPortal(
        <FocusTrap active onEscape={() => {
          setIsDocRequestModalOpen(false);
          setDocRequestReason("");
        }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="doc-request-modal-title"
            className="fixed inset-0 z-[110] flex items-center justify-center p-4"
          >
            <div
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300"
              onClick={() => {
                setIsDocRequestModalOpen(false);
                setDocRequestReason("");
              }}
            />
            <div className="relative w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl animate-in zoom-in-95 duration-300">
              <div className="flex items-center justify-between border-b border-slate-200 bg-[#12335f] px-6 py-4 text-white">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-300" aria-hidden="true" />
                  <div className="space-y-0.5">
                    <h3 id="doc-request-modal-title" className="text-base font-extrabold uppercase tracking-tight">
                      Request Document Re-upload
                    </h3>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-200">
                      Document: {docRequestTarget.label}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setIsDocRequestModalOpen(false);
                    setDocRequestReason("");
                  }}
                  aria-label="Close dialog"
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-white/20 bg-white/10 text-white transition-colors hover:bg-white/20"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              <div className="space-y-4 p-6">
                <p className="text-xs font-medium leading-relaxed text-slate-600">
                  Specify what is wrong with this document and what the stakeholder needs to provide (e.g., blurry image, expired document, wrong file). Only this document will be unlocked for re-upload.
                </p>

                <div className="space-y-1.5">
                  <label htmlFor="doc-request-reason-textarea" className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                    Defect / Correction Reason
                  </label>
                  <textarea
                    id="doc-request-reason-textarea"
                    value={docRequestReason}
                    onChange={(e) => setDocRequestReason(e.target.value)}
                    placeholder="e.g., The PAN card image is blurry. Please upload a clear color scan."
                    className="h-28 w-full resize-none rounded-lg border border-slate-300 bg-white p-3 text-xs font-medium transition-all focus:border-[#12335f] focus:outline-none focus:ring-2 focus:ring-[#12335f]/20"
                    maxLength={1000}
                    autoFocus
                  />
                  <div className="flex justify-end text-[10px] text-slate-400">
                    {docRequestReason.length}/1000
                  </div>
                </div>

                <div className="flex flex-col space-y-2 pt-2">
                  <Button
                    onClick={handleConfirmDocRequest}
                    disabled={isSubmittingDocRequest || docRequestReason.trim().length < 3}
                    className="h-11 w-full rounded-md bg-[#12335f] font-bold uppercase tracking-wide text-white hover:bg-[#0b2445] transition-all"
                  >
                    {isSubmittingDocRequest ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Sending Request...
                      </>
                    ) : (
                      "Send Re-upload Request"
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsDocRequestModalOpen(false);
                      setDocRequestReason("");
                    }}
                    className="h-11 w-full rounded-md border-slate-300 font-bold uppercase tracking-wide text-slate-600 hover:bg-slate-50"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </FocusTrap>,
        document.body
      )}

      {/* APPLICATION CORRECTION MODAL */}
      {isCorrectionModalOpen && isMounted && typeof document !== 'undefined' && createPortal(
        <FocusTrap active onEscape={() => {
          setIsCorrectionModalOpen(false);
          setCorrectionReason("");
        }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-correction-modal-title"
            className="fixed inset-0 z-[110] flex items-center justify-center p-4"
          >
            <div
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300"
              onClick={() => {
                setIsCorrectionModalOpen(false);
                setCorrectionReason("");
              }}
            />
            <div className="relative w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl animate-in zoom-in-95 duration-300">
              <div className="flex items-center justify-between border-b border-slate-200 bg-amber-700 px-6 py-4 text-white">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-200" aria-hidden="true" />
                  <div className="space-y-0.5">
                    <h3 id="app-correction-modal-title" className="text-base font-extrabold uppercase tracking-tight">
                      Request Application Correction
                    </h3>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-amber-100">
                      Overall Onboarding Resubmission
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setIsCorrectionModalOpen(false);
                    setCorrectionReason("");
                  }}
                  aria-label="Close dialog"
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-white/20 bg-white/10 text-white transition-colors hover:bg-white/20"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              <div className="space-y-4 p-6">
                <p className="text-xs font-medium leading-relaxed text-slate-600">
                  Specify what corrections are required across the application. The stakeholder will be notified and their application status will transition to Resubmission Required.
                </p>

                <div className="space-y-1.5">
                  <label htmlFor="app-correction-reason-textarea" className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                    Correction Instructions / Remarks
                  </label>
                  <textarea
                    id="app-correction-reason-textarea"
                    value={correctionReason}
                    onChange={(e) => setCorrectionReason(e.target.value)}
                    placeholder="e.g., Business address does not match certificate; please update and re-upload supporting utility bill."
                    className="h-28 w-full resize-none rounded-lg border border-slate-300 bg-white p-3 text-xs font-medium transition-all focus:border-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-600/20"
                    maxLength={1000}
                    autoFocus
                  />
                  <div className="flex justify-end text-[10px] text-slate-400">
                    {correctionReason.length}/1000
                  </div>
                </div>

                <div className="flex flex-col space-y-2 pt-2">
                  <Button
                    onClick={handleConfirmCorrection}
                    disabled={isSubmittingCorrection || correctionReason.trim().length < 3}
                    className="h-11 w-full rounded-md bg-amber-700 font-bold uppercase tracking-wide text-white hover:bg-amber-800 transition-all"
                  >
                    {isSubmittingCorrection ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Submitting...
                      </>
                    ) : (
                      "Submit Correction Request"
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsCorrectionModalOpen(false);
                      setCorrectionReason("");
                    }}
                    className="h-11 w-full rounded-md border-slate-300 font-bold uppercase tracking-wide text-slate-600 hover:bg-slate-50"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </FocusTrap>,
        document.body
      )}

      {/* APPLICATION REJECTION MODAL */}
      {isAppRejectModalOpen && isMounted && typeof document !== 'undefined' && createPortal(
        <FocusTrap active onEscape={() => {
          setIsAppRejectModalOpen(false);
          setAppRejectReason("");
        }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-reject-modal-title"
            className="fixed inset-0 z-[110] flex items-center justify-center p-4"
          >
            <div
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300"
              onClick={() => {
                setIsAppRejectModalOpen(false);
                setAppRejectReason("");
              }}
            />
            <div className="relative w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl animate-in zoom-in-95 duration-300">
              <div className="flex items-center justify-between border-b border-slate-200 bg-red-800 px-6 py-4 text-white">
                <div className="flex items-center gap-2">
                  <XCircle className="h-5 w-5 text-red-200" aria-hidden="true" />
                  <div className="space-y-0.5">
                    <h3 id="app-reject-modal-title" className="text-base font-extrabold uppercase tracking-tight">
                      Reject Application
                    </h3>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-red-100">
                      Final Scrutiny Decision
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setIsAppRejectModalOpen(false);
                    setAppRejectReason("");
                  }}
                  aria-label="Close dialog"
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-white/20 bg-white/10 text-white transition-colors hover:bg-white/20"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              <div className="space-y-4 p-6">
                <p className="text-xs font-medium leading-relaxed text-slate-600">
                  Please provide the official reason for rejecting this onboarding application. This will be recorded in the audit log and communicated to the applicant.
                </p>

                <div className="space-y-1.5">
                  <label htmlFor="app-reject-reason-textarea" className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                    Official Rejection Reason
                  </label>
                  <textarea
                    id="app-reject-reason-textarea"
                    value={appRejectReason}
                    onChange={(e) => setAppRejectReason(e.target.value)}
                    placeholder="e.g., Entity does not meet eligibility criteria / Inauthentic documentation detected."
                    className="h-28 w-full resize-none rounded-lg border border-slate-300 bg-white p-3 text-xs font-medium transition-all focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600/20"
                    maxLength={1000}
                    autoFocus
                  />
                  <div className="flex justify-end text-[10px] text-slate-400">
                    {appRejectReason.length}/1000
                  </div>
                </div>

                <div className="flex flex-col space-y-2 pt-2">
                  <Button
                    onClick={handleConfirmAppRejection}
                    disabled={isSubmittingAppReject || appRejectReason.trim().length < 3}
                    className="h-11 w-full rounded-md bg-red-700 font-bold uppercase tracking-wide text-white hover:bg-red-800 transition-all"
                  >
                    {isSubmittingAppReject ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Rejecting...
                      </>
                    ) : (
                      "Confirm Rejection"
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsAppRejectModalOpen(false);
                      setAppRejectReason("");
                    }}
                    className="h-11 w-full rounded-md border-slate-300 font-bold uppercase tracking-wide text-slate-600 hover:bg-slate-50"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </FocusTrap>,
        document.body
      )}
      {Boolean(previewDocument) && (
        <DocumentPreviewModal previewDocument={previewDocument} onClose={handleClosePreview} />
      )}
    </div>
  );
}

function InfoItem({
  label,
  value,
  mono = false,
  highlight = false,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  let displayValue = value || "Not Provided";
  if (typeof value === "string" && (value.startsWith("enc:v1:") || value.startsWith("ENC:V1:") || value.toLowerCase().startsWith("enc:v1:"))) {
    displayValue = "Under Verification";
  }

  return (
    <div className="min-w-0 space-y-1 rounded-md border border-slate-100 bg-slate-50/70 px-3 py-2">
      <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p
        className={cn(
          "break-words text-xs font-semibold tracking-tight transition-all",
          highlight ? "text-[#12335f]" : "text-slate-800",
          mono && "font-mono",
        )}
      >
        {displayValue}
      </p>
    </div>
  );
}
