import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDebounce } from '../hooks/useDebounce';
import { useAuth } from '../hooks/useAuth';
import { COOKIE_SESSION_TOKEN } from '../lib/auth';
import {
  Building2,
  Search,
  RefreshCw,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Sliders,
  Users,
  Eye,
  Check,
  Ban,
  Package,
  Wrench,
  BookOpen,
  Briefcase,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  LayoutGrid,
  List,
  X,
  MoreVertical
} from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/button';
import { KpiCard } from '../features/shared/KpiCard';
import { SortableHeader } from '../features/shared/SortableHeader';
import { Pagination } from '../features/shared/Pagination';
import { ViewModeToggle } from '../features/shared/ViewModeToggle';
import { useResponsiveViewMode } from '../features/shared/hooks';
import { formatDateTime } from '../features/shared/format';
import { cn } from '../lib/utils';
import { DataTable, ColumnDef } from '../components/ui/data-table';
import { AppealQueue } from '../features/shared/AppealQueue';

interface Organization {
  id: number;
  organizationName: string;
  gstin?: string;
  panNumber?: string;
  verificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED' | 'CLOSED' | 'ARCHIVED' | 'MERGED';
  isBlacklisted: boolean;
  blacklistReason?: string;
  gstReuseAllowed?: boolean;
  previousOrganizationId?: number | null;
  replacementOrganizationId?: number | null;
  aadhaarKyc?: {
    status?: 'NOT_STARTED' | 'PENDING' | 'VERIFIED' | 'FAILED' | 'EXPIRED';
    provider?: string;
    verifiedName?: string | null;
    verifiedAt?: string | null;
    referenceKey?: string | null;
    idTokenSubject?: string | null;
  } | null;
  features: {
    products: boolean;
    services: boolean;
    marketplace: boolean;
    catalog: boolean;
  };
  _count?: {
    users: number;
    products: number;
    services: number;
  };
}

export default function OrganizationManagement() {
  const { user, token, loading: isAuthLoading } = useAuth();
  const isAuthorizedAdmin = Boolean(
    user && ['admin', 'master_admin'].includes(String(user.role).toLowerCase())
  );

  const authHeaders = useMemo(() => {
    const headers: Record<string, string> = {};
    const t = token || (typeof window !== 'undefined' ? localStorage.getItem('token') : null);
    if (t && t !== COOKIE_SESSION_TOKEN && t !== 'null' && t !== 'undefined') {
      headers.Authorization = `Bearer ${t}`;
    }
    return { headers };
  }, [token]);
  const queryClient = useQueryClient();

  const [openActionMenuId, setOpenActionMenuId] = useState<number | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebounce(searchQuery, 400);
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(10);
  const [viewMode, setViewMode] = useResponsiveViewMode();

  const { data: pendingAppealsData } = useQuery({
    queryKey: ['admin-appeals', 'pending-count', user?.id],
    queryFn: async () => {
      const res = await api.fetch('/api/admin/organizations/appeals?status=PENDING', { ...authHeaders });
      if (!res.ok) return [];
      const json = await res.json();
      return json.data || [];
    },
    enabled: isAuthorizedAdmin,
    staleTime: 30_000
  });
  const pendingAppealCount = Array.isArray(pendingAppealsData) ? pendingAppealsData.length : 0;

  // Detail dialogs
  const [detailOrg, setDetailOrg] = useState<Organization | null>(null);
  const [scopeOrg, setScopeOrg] = useState<Organization | null>(null);
  const [scopeTab, setScopeTab] = useState<'users' | 'products' | 'services'>('users');

  const [sortKey, setSortKey] = useState<'name' | 'gst' | 'status' | 'scope'>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const toggleSort = (key: 'name' | 'gst' | 'status' | 'scope') => {
    if (sortKey === key) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  const SortHeader = ({ label, columnKey, className = '' }: { label: string, columnKey: 'name' | 'gst' | 'status' | 'scope', className?: string }) => {
    const isActive = sortKey === columnKey;
    return (
      <button
        type="button"
        onClick={() => toggleSort(columnKey)}
        className={cn("inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-[#0c2340] transition-colors", isActive && "text-[#0c2340]", className)}
      >
        {label}
        {isActive ? (
          sortDirection === 'asc' ? <ArrowUp className="h-3 w-3 text-[#0c2340]" /> : <ArrowDown className="h-3 w-3 text-[#0c2340]" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    );
  };

  // Modal / Detail States
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
  const [isFeatureModalOpen, setIsFeatureModalOpen] = useState(false);
  const [isVerifyModalOpen, setIsVerifyModalOpen] = useState(false);
  const [isBlacklistModalOpen, setIsBlacklistModalOpen] = useState(false);

  // Form states
  const [blacklistReason, setBlacklistReason] = useState('');
  const [selectedVerifyStatus, setSelectedVerifyStatus] = useState<Organization['verificationStatus']>('VERIFIED');
  const [featuresState, setFeaturesState] = useState({
    products: false,
    services: false,
    marketplace: false,
    catalog: false
  });
  const [savingAction, setSavingAction] = useState(false);
  const isSavingActionRef = useRef(false);

  // Modal refs & wheel delegation for Detail Modal
  const detailModalContainerRef = useRef<HTMLDivElement>(null);
  const detailModalScrollRef = useRef<HTMLDivElement>(null);

  const anyModalOpen = Boolean(detailOrg || scopeOrg || isFeatureModalOpen || isVerifyModalOpen || isBlacklistModalOpen || selectedOrg);

  useEffect(() => {
    if (!anyModalOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [anyModalOpen]);

  useEffect(() => {
    if (!detailOrg) return;
    const containerEl = detailModalContainerRef.current;
    const scrollEl = detailModalScrollRef.current;
    if (!containerEl || !scrollEl) return;

    const handleWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) {
        if (target.scrollHeight > target.clientHeight) return;
      }
      e.stopPropagation();
      e.preventDefault();
      scrollEl.scrollTop += e.deltaY;
    };

    containerEl.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      containerEl.removeEventListener('wheel', handleWheel);
    };
  }, [detailOrg]);

  // Lifecycle action states
  const [lifecycleOrg, setLifecycleOrg] = useState<Organization | null>(null);
  const [lifecycleAction, setLifecycleAction] = useState<'close' | 'archive' | 'restore' | 'allow-gst-reuse' | 'revoke-gst-reuse' | null>(null);
  const [lifecycleReason, setLifecycleReason] = useState('');
  const [lifecycleConfirm, setLifecycleConfirm] = useState(false);
  const [lifecycleBlockers, setLifecycleBlockers] = useState<any[] | null>(null);

  const handleOpenLifecycleModal = (org: Organization, action: typeof lifecycleAction) => {
    setLifecycleOrg(org);
    setLifecycleAction(action);
    setLifecycleReason('');
    setLifecycleConfirm(false);
    setLifecycleBlockers(null);
  };

  const handleSaveLifecycleAction = async () => {
    if (!lifecycleOrg || !lifecycleAction) return;
    if (!lifecycleReason.trim()) {
      toast.error('Reason is required.');
      return;
    }
    if (lifecycleAction !== 'restore' && !lifecycleConfirm) {
      toast.error('Confirmation is required.');
      return;
    }

    setSavingAction(true);
    setLifecycleBlockers(null);

    try {
      const url = `/api/admin/organizations/${lifecycleOrg.id}/${lifecycleAction}`;
      const res = await api.patch(url, {
        reason: lifecycleReason,
        confirm: lifecycleConfirm
      }, authHeaders);

      if (res.ok) {
        toast.success(`Organization ${lifecycleAction.replace('-', ' ')} completed successfully.`);
        queryClient.invalidateQueries({ queryKey: ['organizations'] });
        setLifecycleOrg(null);
        setLifecycleAction(null);
      } else {
        const body = await res.json();
        if (body?.error === 'ORGANIZATION_HAS_ACTIVE_DEPENDENCIES' && body?.blockers) {
          setLifecycleBlockers(body.blockers);
          toast.error(body.message || 'Action blocked by active transactions.');
        } else {
          toast.error(body?.message || `Failed to perform organization ${lifecycleAction}`);
        }
      }
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || 'An error occurred.');
    } finally {
      setSavingAction(false);
    }
  };

  const { data, isLoading: loading, isFetching, refetch } = useQuery({
    queryKey: ['organizations', page, pageSize, statusFilter, debouncedSearch],
    queryFn: async () => {
      let url = `/api/admin/organizations?skip=${(page - 1) * pageSize}&take=${pageSize}`;
      if (debouncedSearch) url += `&q=${encodeURIComponent(debouncedSearch)}`;
      if (statusFilter !== 'all') url += `&status=${encodeURIComponent(statusFilter)}`;

      const res = await api.fetch(url, { ...authHeaders });
      if (!res.ok) throw new Error('Failed to fetch organizations');
      const payload = await res.json();
      return payload?.data || payload || {};
    },
    enabled: isAuthorizedAdmin,
    staleTime: 60_000,
  });

  const orgs = useMemo(() => {
    const dataOrgs = data?.organizations || data?.records || [];
    return Array.isArray(dataOrgs) ? dataOrgs : [];
  }, [data]);

  const total = data?.total ?? orgs.length;

  const sortedOrgs = useMemo(() => {
    return [...orgs].sort((a, b) => {
      const direction = sortDirection === 'asc' ? 1 : -1;
      if (sortKey === 'name') {
        return (a.organizationName || '').localeCompare(b.organizationName || '') * direction;
      }
      if (sortKey === 'gst') {
        const aTax = a.gstin || a.panNumber || '';
        const bTax = b.gstin || b.panNumber || '';
        return aTax.localeCompare(bTax) * direction;
      }
      if (sortKey === 'status') {
        return (a.verificationStatus || '').localeCompare(b.verificationStatus || '') * direction;
      }
      if (sortKey === 'scope') {
        const aCount = (a._count?.users ?? 0) + (a._count?.products ?? 0) + (a._count?.services ?? 0);
        const bCount = (b._count?.users ?? 0) + (b._count?.products ?? 0) + (b._count?.services ?? 0);
        return (aCount - bCount) * direction;
      }
      return 0;
    });
  }, [orgs, sortKey, sortDirection]);

  // Reset page when filter/search changes
  useEffect(() => {
    setPage(1);
  }, [statusFilter, debouncedSearch]);

  const setPageSize = (nextPageSize: number) => {
    setPageSizeState(nextPageSize);
    setPage(1);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
  };

  const handleOpenFeatureModal = (org: Organization) => {
    setSelectedOrg(org);
    setFeaturesState({
      products: org.features?.products ?? false,
      services: org.features?.services ?? false,
      marketplace: org.features?.marketplace ?? false,
      catalog: org.features?.catalog ?? false
    });
    setIsFeatureModalOpen(true);
  };

  const handleSaveFeatures = async () => {
    if (!selectedOrg || isSavingActionRef.current || savingAction) return;
    isSavingActionRef.current = true;
    setSavingAction(true);
    try {
      const res = await api.put(`/api/admin/organizations/${selectedOrg.id}/features`, featuresState, authHeaders);
      if (res.ok) {
        toast.success('Organization application features updated.');
        queryClient.invalidateQueries({ queryKey: ['organizations'] });
        setIsFeatureModalOpen(false);
      } else {
        toast.error('Failed to save organization features.');
      }
    } catch (err) {
      console.error(err);
      toast.error('Error communicating with organization features server.');
    } finally {
      setSavingAction(false);
      setTimeout(() => {
        isSavingActionRef.current = false;
      }, 300);
    }
  };

  const handleOpenVerifyModal = (org: Organization) => {
    setSelectedOrg(org);
    setSelectedVerifyStatus(org.verificationStatus);
    setIsVerifyModalOpen(true);
  };

  const handleSaveVerifyStatus = async () => {
    if (!selectedOrg || isSavingActionRef.current || savingAction) return;
    isSavingActionRef.current = true;
    setSavingAction(true);
    try {
      const res = await api.put(`/api/admin/organizations/${selectedOrg.id}`, {
        verificationStatus: selectedVerifyStatus
      }, authHeaders);
      if (res.ok) {
        toast.success(`Organization status updated to: ${selectedVerifyStatus}`);
        queryClient.invalidateQueries({ queryKey: ['organizations'] });
        setIsVerifyModalOpen(false);
      } else {
        toast.error('Failed to save verification status.');
      }
    } catch (err) {
      console.error(err);
      toast.error('Verification update request error.');
    } finally {
      setSavingAction(false);
      setTimeout(() => {
        isSavingActionRef.current = false;
      }, 300);
    }
  };

  const handleOpenBlacklistModal = (org: Organization) => {
    setSelectedOrg(org);
    setBlacklistReason(org.blacklistReason || '');
    setIsBlacklistModalOpen(true);
  };

  const handleSaveBlacklist = async (isBlacklisting: boolean) => {
    if (!selectedOrg || isSavingActionRef.current || savingAction) return;
    if (isBlacklisting && blacklistReason.trim().length < 5) {
      toast.error('Suspension reason must be at least 5 characters.');
      return;
    }
    isSavingActionRef.current = true;
    setSavingAction(true);
    try {
      const res = await api.put(`/api/admin/organizations/${selectedOrg.id}`, {
        isBlacklisted: isBlacklisting,
        blacklistReason: isBlacklisting ? blacklistReason.trim() : ''
      }, authHeaders);
      if (res.ok) {
        toast.success(isBlacklisting ? 'Organization access restricted.' : 'Organization access restriction cleared.');
        queryClient.invalidateQueries({ queryKey: ['organizations'] });
        setIsBlacklistModalOpen(false);
      } else {
        const errJson = await res.json().catch(() => null);
        toast.error(errJson?.message || 'Failed to change restriction status.');
      }
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || 'Restriction toggling request error.');
    } finally {
      setSavingAction(false);
      setTimeout(() => {
        isSavingActionRef.current = false;
      }, 300);
    }
  };

  const statusTone = (status: Organization['verificationStatus']) => {
    if (status === 'VERIFIED') return 'bg-emerald-50 border-emerald-200 text-emerald-700';
    if (status === 'REJECTED') return 'bg-red-50 border-red-200 text-red-700';
    if (status === 'SUSPENDED') return 'bg-amber-50 border-amber-200 text-amber-700';
    if (status === 'CLOSED') return 'bg-slate-50 border-slate-200 text-slate-700';
    if (status === 'ARCHIVED') return 'bg-slate-100 border-slate-300 text-slate-600';
    if (status === 'MERGED') return 'bg-blue-50 border-blue-200 text-blue-700';
    return 'bg-emerald-50 border-emerald-100 text-[#0c2340]';
  };

  const aadhaarStatus = (org: Organization) => org.aadhaarKyc?.status || 'NOT_STARTED';
  const aadhaarTone = (status: string) => {
    if (status === 'VERIFIED') return 'bg-emerald-50 border-emerald-200 text-emerald-700';
    if (status === 'FAILED') return 'bg-red-50 border-red-200 text-red-700';
    if (status === 'EXPIRED') return 'bg-amber-50 border-amber-200 text-amber-700';
    if (status === 'PENDING') return 'bg-blue-50 border-blue-200 text-blue-700';
    return 'bg-slate-50 border-slate-200 text-slate-600';
  };
  const AadhaarBadge = ({ org }: { org: Organization }) => {
    const status = aadhaarStatus(org);
    return (
      <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ${aadhaarTone(status)}`}>
        Aadhaar {status.replace(/_/g, ' ')}
      </span>
    );
  };

  const orgColumns: ColumnDef<Organization>[] = [
    {
      key: 'name',
      header: 'Company Details',
      sortable: true,
      sortKey: 'name',
      width: 'w-[30%]',
      cell: (org) => (
        <button
          type="button"
          onClick={() => setDetailOrg(org)}
          className="flex items-start gap-3 text-left group min-w-0 w-full"
          title="View company details"
        >
          <div className="h-10 w-10 rounded-lg bg-[#0c2340]/5 flex items-center justify-center text-[#0c2340] shrink-0 border border-slate-100 shadow-sm group-hover:bg-[#0c2340] group-hover:text-white transition-colors">
            <Building2 className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h4 className="font-extrabold text-neutral-900 text-sm group-hover:text-[#0c2340] group-hover:underline decoration-[#c5a556] underline-offset-2 transition-colors text-wrap-anywhere">
              {org.organizationName}
            </h4>
            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5 block">
              ID: ORG-{org.id}
            </span>
          </div>
        </button>
      ),
    },
    {
      key: 'tax',
      header: 'Tax IDs',
      sortable: true,
      sortKey: 'gst',
      width: 'w-[24%]',
      cell: (org) => (
        <div className="space-y-1 text-xs font-mono">
          <div>
            <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest mr-1">GSTIN:</span>
            <span className="text-slate-800 font-bold text-wrap-anywhere">{org.gstin || 'N/A'}</span>
          </div>
          <div>
            <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest mr-2">PAN:</span>
            <span className="text-slate-800 font-bold text-wrap-anywhere">{org.panNumber || 'N/A'}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'scope',
      header: 'Scope',
      sortable: true,
      sortKey: 'scope',
      width: 'w-[18%]',
      align: 'center',
      cell: (org) => (
        <div className="flex items-center justify-center gap-1.5 text-xs">
          <button
            type="button"
            onClick={() => { setScopeOrg(org); setScopeTab('users'); }}
            title="View users"
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700 hover:border-[#0c2340] hover:bg-[#0c2340]/5 hover:text-[#0c2340] transition-colors"
          >
            <Users className="h-3.5 w-3.5" />
            <span className="font-bold">{org._count?.users ?? 0}</span>
          </button>
          <button
            type="button"
            onClick={() => { setScopeOrg(org); setScopeTab('products'); }}
            title="View products"
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700 hover:border-[#0c2340] hover:bg-[#0c2340]/5 hover:text-[#0c2340] transition-colors"
          >
            <Package className="h-3.5 w-3.5" />
            <span className="font-bold">{org._count?.products ?? 0}</span>
          </button>
          <button
            type="button"
            onClick={() => { setScopeOrg(org); setScopeTab('services'); }}
            title="View services"
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700 hover:border-[#0c2340] hover:bg-[#0c2340]/5 hover:text-[#0c2340] transition-colors"
          >
            <Wrench className="h-3.5 w-3.5" />
            <span className="font-bold">{org._count?.services ?? 0}</span>
          </button>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      sortKey: 'status',
      width: 'w-[18%]',
      align: 'center',
      cell: (org) => (
        <div className="flex flex-col items-center gap-1">
          <span className={`px-2.5 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider border ${statusTone(org.verificationStatus)}`}>
            {org.verificationStatus}
          </span>
          <AadhaarBadge org={org} />
          {org.isBlacklisted && (
            <span className="flex items-center gap-0.5 bg-red-50 border border-red-200 text-red-700 text-[9px] uppercase font-extrabold tracking-wider px-1.5 py-0.5 rounded" title={org.blacklistReason}>
              <ShieldAlert className="h-2.5 w-2.5" /> RESTRICTED
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      width: 'w-16',
      align: 'right',
      cell: (org) => (
        <OrgActionsDropdown
          org={org}
          isOpen={openActionMenuId === org.id}
          onToggle={() => setOpenActionMenuId(openActionMenuId === org.id ? null : org.id)}
          onClose={() => setOpenActionMenuId(null)}
          onOpenDetails={setDetailOrg}
          onOpenFeatures={handleOpenFeatureModal}
          onOpenVerify={handleOpenVerifyModal}
          onOpenBlacklist={handleOpenBlacklistModal}
          onOpenLifecycle={handleOpenLifecycleModal}
        />
      ),
    },
  ];

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Banner / Header */}
      <div className="bg-[#0c2340] border-b-4 border-[#c5a556] rounded-xl shadow-sm overflow-hidden p-4 md:p-5 text-white relative">
        <div className="absolute right-0 top-0 opacity-10 translate-x-1/4 -translate-y-1/4 select-none pointer-events-none">
          <Building2 className="h-48 w-48 text-white" />
        </div>
        <div className="relative z-10 flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-xl md:text-2xl font-extrabold tracking-tight">Organization & Feature Management</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 self-start md:self-end">
            <Button
              onClick={() => refetch()}
              variant="outline"
              className="border-white/20 hover:border-white/50 hover:text-white text-black hover:bg-white/30 shrink-0 gap-2 text-xs font-bold uppercase tracking-wider h-9"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
              Sync Database
            </Button>
          </div>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Total Organizations"
          value={total}
          subtext="Active stakeholder entities"
          icon={Building2}
          tone="blue"
          loading={loading}
          active={statusFilter === 'all'}
          onClick={() => setStatusFilter('all')}
        />
        <KpiCard
          label="Verified Stakeholders"
          value={orgs.filter(o => o.verificationStatus === 'VERIFIED').length}
          subtext="Cleared for procurement"
          icon={CheckCircle2}
          tone="green"
          loading={loading}
          active={statusFilter === 'VERIFIED'}
          onClick={() => setStatusFilter('VERIFIED')}
        />
        <KpiCard
          label="Pending Review"
          value={orgs.filter(o => o.verificationStatus === 'PENDING').length}
          subtext="Awaiting verification decision"
          icon={AlertTriangle}
          tone="amber"
          loading={loading}
          active={statusFilter === 'PENDING'}
          onClick={() => setStatusFilter('PENDING')}
        />
        <KpiCard
          label="Access Restricted"
          value={orgs.filter(o => o.isBlacklisted || o.verificationStatus === 'SUSPENDED').length}
          subtext="Suspended or blacklisted"
          icon={Ban}
          tone="red"
          loading={loading}
          active={statusFilter === 'SUSPENDED'}
          onClick={() => setStatusFilter('SUSPENDED')}
        />
        <KpiCard
          label="Appeals Pending"
          value={pendingAppealCount}
          subtext="Awaiting determination"
          icon={ShieldAlert}
          tone="purple"
          loading={loading}
          active={statusFilter === 'APPEALS'}
          onClick={() => setStatusFilter('APPEALS')}
        />
      </div>

      {/* Search & Filter Controls */}
      <div className="bg-white rounded-xl border border-slate-200/80 p-3 sm:p-4 shadow-sm flex flex-col gap-3 sm:gap-4 lg:flex-row lg:items-center justify-between">
        <div className="flex items-center gap-2 w-full lg:max-w-sm">
          <form onSubmit={handleSearchSubmit} className="flex-1 min-w-0">
            <div className="relative w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by company name, GSTIN, or PAN..."
                className="w-full h-10 pl-10 pr-3 rounded-xl border border-slate-200 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-[#0c2340]/10 focus:border-[#0c2340] bg-slate-50/50 focus:bg-white transition-all"
              />
            </div>
          </form>
          <div className="lg:hidden shrink-0">
            <ViewModeToggle value={viewMode} onChange={setViewMode} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 w-full lg:flex-1">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mr-1 hidden sm:block">Filter:</span>
          {['all', 'PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED', 'APPEALS'].map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider border transition-all ${statusFilter === status
                ? 'bg-[#0c2340] border-[#0c2340] text-white shadow-sm'
                : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                }`}
            >
              {status === 'APPEALS' ? `Appeals ${pendingAppealCount > 0 ? `(${pendingAppealCount})` : ''}` : status}
            </button>
          ))}
        </div>

        <div className="hidden lg:flex items-center gap-2 shrink-0 justify-end">
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
        </div>
      </div>
      {/* Main Stakeholders Content */}
      {statusFilter === 'APPEALS' ? (
        <AppealQueue authHeaders={authHeaders.headers} districtScoped />
      ) : viewMode === 'list' ? (
        <DataTable<Organization>
          data={sortedOrgs}
          columns={orgColumns}
          keyExtractor={(org) => org.id}
          isLoading={loading}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSort={(key) => toggleSort(key as any)}
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={setPageSizeState}
          paginationLabel="organizations"
          emptyTitle="No organizations found"
          emptyDescription="No registered organizations match your current search or filter criteria."
        />
      ) : loading ? (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="bg-white border border-slate-200/60 rounded-xl p-4 flex flex-col gap-4 animate-pulse shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 rounded-lg bg-slate-200/80 shrink-0" />
                  <div className="space-y-2 flex-1 py-1">
                    <div className="h-3.5 w-3/4 bg-slate-200/80 rounded" />
                    <div className="h-2.5 w-1/2 bg-slate-200/80 rounded" />
                  </div>
                </div>
                <div className="space-y-2.5 pt-2">
                  <div className="h-3 w-24 bg-slate-200/80 rounded" />
                  <div className="h-3 w-20 bg-slate-200/80 rounded" />
                </div>
                <div className="flex flex-wrap gap-2 mt-auto pt-2">
                  <div className="h-6 w-16 bg-slate-200/80 rounded-md" />
                  <div className="h-6 w-20 bg-slate-200/80 rounded-md" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : orgs.length > 0 ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {sortedOrgs.map((org, index) => (
              <div key={org.id} className="rounded-xl border border-slate-200 bg-white shadow-sm hover:shadow-md transition-all flex flex-col h-full overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/50 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] font-black text-[#12335f] uppercase tracking-widest">
                      ORG-{org.id}
                    </span>
                    <span className={`px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider border ${statusTone(org.verificationStatus)}`}>
                      {org.verificationStatus}
                    </span>
                  </div>
                  <OrgActionsDropdown
                    org={org}
                    isOpen={openActionMenuId === org.id}
                    onToggle={() => setOpenActionMenuId(openActionMenuId === org.id ? null : org.id)}
                    onClose={() => setOpenActionMenuId(null)}
                    onOpenDetails={setDetailOrg}
                    onOpenFeatures={handleOpenFeatureModal}
                    onOpenVerify={handleOpenVerifyModal}
                    onOpenBlacklist={handleOpenBlacklistModal}
                    onOpenLifecycle={handleOpenLifecycleModal}
                    triggerClassName="h-7 w-7 border-0 shadow-none hover:bg-slate-200/50"
                  />
                </div>

                {/* Body */}
                <div className="p-4 flex-1 flex flex-col space-y-4">
                  <div>
                    <button type="button" onClick={() => setDetailOrg(org)} className="text-left group w-full text-wrap-anywhere">
                      <h4 className="font-extrabold text-slate-900 text-sm group-hover:text-[#0c2340] group-hover:underline decoration-[#c5a556] underline-offset-2 transition-colors">
                        {org.organizationName}
                      </h4>
                    </button>
                  </div>

                  <div className="space-y-1.5 text-xs text-slate-600 font-medium">
                    <div className="flex items-center gap-2 truncate text-wrap-anywhere">
                      <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 w-12 shrink-0">GSTIN</span>
                      <span className="truncate font-bold">{org.gstin || '—'}</span>
                    </div>
                    <div className="flex items-center gap-2 truncate text-wrap-anywhere">
                      <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 w-12 shrink-0">PAN</span>
                      <span className="truncate font-bold">{org.panNumber || '—'}</span>
                    </div>
                  </div>

                  <div className="space-y-2 pt-3 border-t border-slate-100 mt-auto">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">KYC Status</span>
                      <AadhaarBadge org={org} />
                    </div>
                    {org.isBlacklisted && (
                      <div className="flex items-center gap-1 text-red-600 text-[10px] font-bold bg-red-50 p-1.5 rounded-lg border border-red-100">
                        <ShieldAlert className="h-3 w-3 shrink-0" />
                        <span className="truncate">Restricted: {org.blacklistReason}</span>
                      </div>
                    )}
                    <div className="grid grid-cols-3 gap-1 pt-1">
                      <button type="button" onClick={() => { setScopeOrg(org); setScopeTab('users'); }} className="inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] font-bold text-slate-700 hover:border-[#0c2340] hover:bg-[#0c2340]/5 transition-colors truncate">
                        <Users className="h-3 w-3 shrink-0" />
                        <span className="truncate">{org._count?.users ?? 0}</span>
                      </button>
                      <button type="button" onClick={() => { setScopeOrg(org); setScopeTab('products'); }} className="inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] font-bold text-slate-700 hover:border-[#0c2340] hover:bg-[#0c2340]/5 transition-colors truncate">
                        <Package className="h-3 w-3 shrink-0" />
                        <span className="truncate">{org._count?.products ?? 0}</span>
                      </button>
                      <button type="button" onClick={() => { setScopeOrg(org); setScopeTab('services'); }} className="inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] font-bold text-slate-700 hover:border-[#0c2340] hover:bg-[#0c2340]/5 transition-colors truncate">
                        <Wrench className="h-3 w-3 shrink-0" />
                        <span className="truncate">{org._count?.services ?? 0}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} onPageSizeChange={setPageSizeState} label="organizations" />
        </div>
      ) : (
        <div className="py-16 text-center bg-white rounded-2xl border border-slate-200/80 shadow-sm">
          <Building2 className="h-12 w-12 text-slate-200 mx-auto mb-3" />
          <p className="text-sm font-bold text-slate-400 uppercase tracking-widest">No organizations found</p>
        </div>
      )}

      {/* Feature Flags Modal */}
      {isFeatureModalOpen && selectedOrg && (
        <div 
          className="fixed inset-0 bg-neutral-900/45 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Access Flags for ${selectedOrg.organizationName}`}
        >
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="bg-[#0c2340] border-b-4 border-[#c5a556] p-5 text-white">
              <h3 className="font-extrabold text-lg flex items-center gap-2">
                <Sliders className="h-5 w-5 text-[#c5a556]" /> Access Flags: {selectedOrg.organizationName}
              </h3>
              <p className="text-xs text-slate-300 mt-1">Manage feature flags overlay for this enterprise profile.</p>
            </div>

            <div className="p-6 space-y-4">
              <div className="space-y-3">
                <label className="flex items-center gap-3 p-3 rounded-lg border border-slate-100 hover:bg-slate-50 transition-colors cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={featuresState.catalog}
                    onChange={(e) => setFeaturesState(prev => ({ ...prev, catalog: e.target.checked }))}
                    className="h-4 w-4 text-[#0c2340] focus:ring-[#0c2340]"
                  />
                  <div>
                    <span className="text-sm font-bold text-neutral-900 block">Catalog Visibility</span>
                    <span className="text-[11px] text-slate-500">Allow this organization to view, read, and manage catalogs.</span>
                  </div>
                </label>

                <label className="flex items-center gap-3 p-3 rounded-lg border border-slate-100 hover:bg-slate-50 transition-colors cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={featuresState.marketplace}
                    onChange={(e) => setFeaturesState(prev => ({ ...prev, marketplace: e.target.checked }))}
                    className="h-4 w-4 text-[#0c2340] focus:ring-[#0c2340]"
                  />
                  <div>
                    <span className="text-sm font-bold text-neutral-900 block">Marketplace Access</span>
                    <span className="text-[11px] text-slate-500">Allow buying and trading directly in the marketplace ecosystem.</span>
                  </div>
                </label>

                <label className="flex items-center gap-3 p-3 rounded-lg border border-slate-100 hover:bg-slate-50 transition-colors cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={featuresState.products}
                    onChange={(e) => setFeaturesState(prev => ({ ...prev, products: e.target.checked }))}
                    className="h-4 w-4 text-[#0c2340] focus:ring-[#0c2340]"
                  />
                  <div>
                    <span className="text-sm font-bold text-neutral-900 block">Product Upload Authorization</span>
                    <span className="text-[11px] text-slate-500">Allow adding new physical inventory products to catalogs.</span>
                  </div>
                </label>

                <label className="flex items-center gap-3 p-3 rounded-lg border border-slate-100 hover:bg-slate-50 transition-colors cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={featuresState.services}
                    onChange={(e) => setFeaturesState(prev => ({ ...prev, services: e.target.checked }))}
                    className="h-4 w-4 text-[#0c2340] focus:ring-[#0c2340]"
                  />
                  <div>
                    <span className="text-sm font-bold text-neutral-900 block">Services Upload Authorization</span>
                    <span className="text-[11px] text-slate-500">Allow catalog additions of custom contractor or enterprise services.</span>
                  </div>
                </label>
              </div>
            </div>

            <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100">
              <Button
                variant="outline"
                onClick={() => setIsFeatureModalOpen(false)}
                className="border-slate-200 text-slate-600 hover:bg-slate-100 text-xs font-bold uppercase tracking-wider"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveFeatures}
                disabled={savingAction}
                className="bg-[#0c2340] hover:bg-[#0c2340]/90 text-white text-xs font-bold uppercase tracking-wider gap-2 px-4 shadow-sm"
              >
                {savingAction ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Sliders className="h-3.5 w-3.5 text-[#c5a556]" />}
                Save Controls
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Verification Modal */}
      {isVerifyModalOpen && selectedOrg && (
        <div 
          className="fixed inset-0 bg-neutral-900/45 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Verify Stakeholder ${selectedOrg.organizationName}`}
        >
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="bg-[#0c2340] border-b-4 border-[#c5a556] p-5 text-white">
              <h3 className="font-extrabold text-lg flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-400" /> Verify Stakeholder: {selectedOrg.organizationName}
              </h3>
              <p className="text-xs text-slate-300 mt-1">Audit verification standing for platform operations.</p>
            </div>

            <div className="p-6 space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-black uppercase tracking-widest text-slate-400">Select Status Setting</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED'] as const).map((vst) => (
                    <button
                      key={vst}
                      type="button"
                      onClick={() => setSelectedVerifyStatus(vst)}
                      className={`px-3 py-2 rounded-lg border text-xs font-extrabold uppercase transition-all ${selectedVerifyStatus === vst
                        ? 'bg-[#0c2340] border-[#0c2340] text-white shadow-sm'
                        : 'bg-white border-slate-200 text-slate-650 hover:border-slate-300'
                        }`}
                    >
                      {vst}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100">
              <Button
                variant="outline"
                onClick={() => setIsVerifyModalOpen(false)}
                className="border-slate-200 text-slate-600 hover:bg-slate-100 text-xs font-bold uppercase tracking-wider"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveVerifyStatus}
                disabled={savingAction}
                className="bg-[#0c2340] hover:bg-[#0c2340]/90 text-white text-xs font-bold uppercase tracking-wider gap-2 px-4 shadow-sm"
              >
                {savingAction ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5 text-[#c5a556]" />}
                Apply Status
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Blacklist / Restriction Modal */}
      {isBlacklistModalOpen && selectedOrg && (
        <div 
          className="fixed inset-0 bg-neutral-900/45 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Platform Restriction Desk for ${selectedOrg.organizationName}`}
        >
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="bg-[#0c2340] border-b-4 border-[#c5a556] p-5 text-white">
              <h3 className="font-extrabold text-lg flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-red-400" /> Platform Suspension &amp; Restriction Desk
              </h3>
              <p className="text-xs text-slate-300 mt-1">
                Manage portal-wide restrictions for {selectedOrg.organizationName}. The organization will be notified and can submit up to 2 appeals.
              </p>
            </div>

            <div className="p-6 space-y-4">
              {selectedOrg.isBlacklisted ? (
                <div>
                  <p className="text-xs text-slate-600 leading-relaxed bg-amber-50 border border-amber-200 p-3 rounded-lg flex gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                    This stakeholder is currently suspended/blacklisted from direct system interactions. Clearing this restriction restores standard operational rights.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-black uppercase tracking-widest text-slate-400">Reason for suspension / restriction</label>
                    <span className={`text-[11px] font-semibold ${blacklistReason.trim().length >= 5 ? 'text-slate-400' : 'text-amber-600'}`}>
                      {blacklistReason.trim().length < 5 ? `Min 5 characters (${blacklistReason.trim().length}/5)` : `${blacklistReason.trim().length} chars`}
                    </span>
                  </div>
                  <textarea
                    value={blacklistReason}
                    onChange={(e) => setBlacklistReason(e.target.value)}
                    placeholder="Enter compliance breach, dispute violations, or reason for suspension (min 5 characters)..."
                    rows={4}
                    className="w-full p-3 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-red-150 focus:border-red-500 bg-slate-50/50 focus:bg-white transition-all resize-none"
                  />
                </div>
              )}
            </div>

            <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100">
              <Button
                variant="outline"
                onClick={() => setIsBlacklistModalOpen(false)}
                className="border-slate-200 text-slate-600 hover:bg-slate-100 text-xs font-bold uppercase tracking-wider"
              >
                Cancel
              </Button>
              {selectedOrg.isBlacklisted ? (
                <Button
                  onClick={() => handleSaveBlacklist(false)}
                  disabled={savingAction}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase tracking-wider gap-2 px-4 shadow-sm"
                >
                  {savingAction ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  Lift Suspension
                </Button>
              ) : (
                <Button
                  onClick={() => handleSaveBlacklist(true)}
                  disabled={savingAction || blacklistReason.trim().length < 5}
                  className="bg-red-650 hover:bg-red-750 text-white text-xs font-bold uppercase tracking-wider gap-2 px-4 shadow-sm"
                >
                  {savingAction ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                  Apply Suspension
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Company Detail Dialog */}
      {detailOrg && (
        <div 
          ref={detailModalContainerRef} 
          className="fixed inset-0 bg-neutral-900/45 backdrop-blur-sm flex items-center justify-center z-50 p-4" 
          role="dialog"
          aria-modal="true"
          aria-label={`Stakeholder Profile Dossier for ${detailOrg.organizationName}`}
          onClick={() => setDetailOrg(null)}
        >
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
            <div className="bg-[#0c2340] border-b-4 border-[#c5a556] p-5 text-white relative">
              <button onClick={() => setDetailOrg(null)} className="absolute right-4 top-4 rounded-md border border-white/20 bg-white/10 p-2 text-white hover:bg-white/20" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
              <div className="flex items-start gap-4 pr-12">
                <div className="h-12 w-12 shrink-0 rounded-lg bg-white/15 flex items-center justify-center text-[#c5a556]">
                  <Building2 className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-[#c5a556]">Organization Detail</p>
                  <h2 className="mt-0.5 text-xl font-extrabold tracking-tight text-wrap-anywhere">{detailOrg.organizationName}</h2>
                  <p className="mt-1 font-mono text-[11px] text-slate-300">ID: ORG-{detailOrg.id}</p>
                </div>
              </div>
            </div>

            <div ref={detailModalScrollRef} className="flex-1 overflow-y-auto p-5 space-y-4 overscroll-contain focus:outline-none">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Verification</p>
                  <span className={`mt-1 inline-flex rounded-md border px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${statusTone(detailOrg.verificationStatus)}`}>{detailOrg.verificationStatus}</span>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Aadhaar KYC</p>
                  <span className={`mt-1 inline-flex rounded-md border px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${aadhaarTone(aadhaarStatus(detailOrg))}`}>
                    {aadhaarStatus(detailOrg).replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Restriction</p>
                  <p className="mt-1 text-sm font-black text-slate-900">{detailOrg.isBlacklisted ? 'Blacklisted' : 'Active'}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Total Records</p>
                  <p className="mt-1 text-sm font-black text-slate-900">
                    {(detailOrg._count?.users || 0) + (detailOrg._count?.products || 0) + (detailOrg._count?.services || 0)}
                  </p>
                </div>
              </div>

              {detailOrg.aadhaarKyc && (
                <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                  <div className="border-b border-slate-100 bg-slate-50/50 px-4 py-2.5">
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Aadhaar Verification</h3>
                  </div>
                  <div className="p-4 grid gap-3 sm:grid-cols-2">
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Provider</p>
                      <p className="mt-0.5 text-xs font-bold text-slate-700">MeriPehchaan</p>
                    </div>
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Verified Name</p>
                      <p className="mt-0.5 text-xs font-bold text-slate-700 text-wrap-anywhere">{detailOrg.aadhaarKyc.verifiedName || 'Not available'}</p>
                    </div>
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Verified At</p>
                      <p className="mt-0.5 text-xs font-bold text-slate-700">{detailOrg.aadhaarKyc.verifiedAt ? formatDateTime(detailOrg.aadhaarKyc.verifiedAt) : 'Not available'}</p>
                    </div>
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Reference / Subject</p>
                      <p className="mt-0.5 text-xs font-bold text-slate-700 text-wrap-anywhere">{detailOrg.aadhaarKyc.referenceKey || detailOrg.aadhaarKyc.idTokenSubject || 'Not available'}</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50/50 px-4 py-2.5">
                  <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Tax Identifications</h3>
                </div>
                <div className="p-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">GSTIN</p>
                    <p className="mt-0.5 font-mono text-xs font-bold text-slate-700 text-wrap-anywhere">{detailOrg.gstin || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">PAN</p>
                    <p className="mt-0.5 font-mono text-xs font-bold text-slate-700 text-wrap-anywhere">{detailOrg.panNumber || '—'}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50/50 px-4 py-2.5">
                  <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Operational Features</h3>
                </div>
                <div className="p-4 grid gap-2 sm:grid-cols-2">
                  {[
                    { label: 'Catalog', icon: BookOpen, on: !!detailOrg.features?.catalog },
                    { label: 'Marketplace', icon: Briefcase, on: !!detailOrg.features?.marketplace },
                    { label: 'Products', icon: Package, on: !!detailOrg.features?.products },
                    { label: 'Services', icon: Wrench, on: !!detailOrg.features?.services }
                  ].map(f => (
                    <div key={f.label} className={cn(
                      "flex items-center justify-between rounded-lg border px-3 py-2",
                      f.on ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50'
                    )}>
                      <span className="inline-flex items-center gap-2 text-xs font-bold text-slate-700">
                        <f.icon className={cn("h-3.5 w-3.5", f.on ? 'text-emerald-600' : 'text-slate-400')} />
                        {f.label}
                      </span>
                      <span className={cn(
                        "rounded px-2 py-0.5 text-[9px] font-black uppercase tracking-wider",
                        f.on ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                      )}>
                        {f.on ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50/50 px-4 py-2.5">
                  <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Scope Stats</h3>
                </div>
                <div className="p-4 grid gap-3 grid-cols-3">
                  <button
                    type="button"
                    onClick={() => { setScopeOrg(detailOrg); setScopeTab('users'); setDetailOrg(null); }}
                    className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-left hover:border-[#0c2340] hover:bg-[#0c2340]/5 transition-colors"
                  >
                    <Users className="h-4 w-4 text-slate-400 mb-1" />
                    <p className="text-xl font-black text-slate-900">{detailOrg._count?.users || 0}</p>
                    <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Users</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setScopeOrg(detailOrg); setScopeTab('products'); setDetailOrg(null); }}
                    className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-left hover:border-[#0c2340] hover:bg-[#0c2340]/5 transition-colors"
                  >
                    <Package className="h-4 w-4 text-slate-400 mb-1" />
                    <p className="text-xl font-black text-slate-900">{detailOrg._count?.products || 0}</p>
                    <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Products</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setScopeOrg(detailOrg); setScopeTab('services'); setDetailOrg(null); }}
                    className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-left hover:border-[#0c2340] hover:bg-[#0c2340]/5 transition-colors"
                  >
                    <Wrench className="h-4 w-4 text-slate-400 mb-1" />
                    <p className="text-xl font-black text-slate-900">{detailOrg._count?.services || 0}</p>
                    <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Services</p>
                  </button>
                </div>
              </div>

              {(detailOrg.previousOrganizationId || detailOrg.replacementOrganizationId || detailOrg.gstReuseAllowed) && (
                <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4 space-y-2">
                  <p className="text-[10px] font-black uppercase tracking-widest text-blue-700">GST Reuse Standing</p>
                  <div className="grid gap-2 text-xs">
                    <div>
                      <span className="font-bold text-slate-500 mr-2">GST Reuse Allowed:</span>
                      <span className={cn("font-black px-1.5 py-0.5 rounded text-[10px]", detailOrg.gstReuseAllowed ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-800")}>
                        {detailOrg.gstReuseAllowed ? "Yes" : "No"}
                      </span>
                    </div>
                    {detailOrg.previousOrganizationId && (
                      <div>
                        <span className="font-bold text-slate-500 mr-2">Previous Organization ID:</span>
                        <span className="font-mono bg-white px-1.5 py-0.5 rounded border border-slate-200">ORG-{detailOrg.previousOrganizationId}</span>
                      </div>
                    )}
                    {detailOrg.replacementOrganizationId && (
                      <div>
                        <span className="font-bold text-slate-500 mr-2">Re-registered Organization ID:</span>
                        <span className="font-mono bg-white px-1.5 py-0.5 rounded border border-slate-200">ORG-{detailOrg.replacementOrganizationId}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {detailOrg.isBlacklisted && detailOrg.blacklistReason && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-red-700 flex items-center gap-1.5">
                    <ShieldAlert className="h-3.5 w-3.5" /> Restriction Reason
                  </p>
                  <p className="mt-1 text-xs font-bold text-red-900 text-wrap-anywhere">{detailOrg.blacklistReason}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Organization Lifecycle & GST Reuse Modal */}
      {lifecycleOrg && lifecycleAction && (
        <div 
          className="fixed inset-0 bg-neutral-900/45 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Operational Status Configuration for ${lifecycleOrg.organizationName}`}
        >
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className={cn(
              "p-5 text-white border-b-4 border-[#c5a556]",
              lifecycleAction === 'close' || lifecycleAction === 'revoke-gst-reuse' ? 'bg-red-950' : 'bg-[#0c2340]'
            )}>
              <h3 className="font-extrabold text-lg flex items-center gap-2">
                <Building2 className="h-5 w-5 text-[#c5a556]" />
                {lifecycleAction.replace('-', ' ').toUpperCase()}: {lifecycleOrg.organizationName}
              </h3>
              <p className="text-xs text-slate-300 mt-1">
                {lifecycleAction === 'close' && 'Initiate permanent closure for this organization. This will blacklist the GST unless reuse is explicitly allowed.'}
                {lifecycleAction === 'archive' && 'Archive this organization. This halts all active operations but retains auditing data.'}
                {lifecycleAction === 'restore' && 'Restore this organization to VERIFIED status.'}
                {lifecycleAction === 'allow-gst-reuse' && 'Allow other accounts to register using this closed/archived organization\'s GST.'}
                {lifecycleAction === 'revoke-gst-reuse' && 'Revoke permission to register using this organization\'s GST.'}
              </p>
            </div>

            <div className="p-6 space-y-4">
              {/* Blockers list if API returns ORGANIZATION_HAS_ACTIVE_DEPENDENCIES */}
              {lifecycleBlockers && lifecycleBlockers.length > 0 && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 space-y-2">
                  <p className="text-xs font-black text-red-700 flex items-center gap-1.5 uppercase tracking-wider">
                    <ShieldAlert className="h-4 w-4" /> Active Dependencies Found
                  </p>
                  <p className="text-xs text-red-900">
                    This organization has active transactions. Please close or complete these dependencies before proceeding:
                  </p>
                  <ul className="divide-y divide-red-100 text-xs font-bold text-red-800">
                    {lifecycleBlockers.map((b, idx) => (
                      <li key={idx} className="py-1 flex justify-between">
                        <span>{b.type}</span>
                        <span>{b.count} active</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-xs font-black uppercase tracking-widest text-slate-400">Reason (Required)</label>
                <textarea
                  value={lifecycleReason}
                  onChange={(e) => setLifecycleReason(e.target.value)}
                  placeholder="Enter reason for this action..."
                  rows={3}
                  className="w-full p-3 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-[#0c2340]/10 focus:border-[#0c2340] bg-slate-50/50 focus:bg-white transition-all resize-none font-medium"
                />
              </div>

              {lifecycleAction !== 'restore' && (
                <label className="flex items-start gap-2.5 p-3 rounded-lg border border-slate-100 hover:bg-slate-50 transition-colors cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={lifecycleConfirm}
                    onChange={(e) => setLifecycleConfirm(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-[#0c2340] focus:ring-[#0c2340] mt-0.5"
                  />
                  <div className="text-xs">
                    <span className="font-bold text-neutral-900 block">I confirm this action</span>
                    <span className="text-[11px] text-slate-500">Check this box to acknowledge and verify the action.</span>
                  </div>
                </label>
              )}
            </div>

            <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100">
              <Button
                variant="outline"
                onClick={() => { setLifecycleOrg(null); setLifecycleAction(null); }}
                className="border-slate-200 text-slate-600 hover:bg-slate-100 text-xs font-bold uppercase tracking-wider"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveLifecycleAction}
                disabled={savingAction || !lifecycleReason.trim() || (lifecycleAction !== 'restore' && !lifecycleConfirm)}
                className={cn(
                  "text-white text-xs font-bold uppercase tracking-wider gap-2 px-4 shadow-sm",
                  lifecycleAction === 'close' || lifecycleAction === 'revoke-gst-reuse' ? 'bg-red-600 hover:bg-red-700' : 'bg-[#0c2340] hover:bg-[#0c2340]/90'
                )}
              >
                {savingAction && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                Submit
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Scope Stats Dialog (Users / Products / Services list) */}
      {scopeOrg && (
        <div 
          className="fixed inset-0 bg-neutral-900/45 backdrop-blur-sm flex items-center justify-center z-50 p-4" 
          role="dialog"
          aria-modal="true"
          aria-label={`Operational Scope Configuration for ${scopeOrg.organizationName}`}
          onClick={() => setScopeOrg(null)}
        >
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-3xl max-h-[88vh] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
            <div className="bg-[#0c2340] border-b-4 border-[#c5a556] p-5 text-white relative">
              <button onClick={() => setScopeOrg(null)} className="absolute right-4 top-4 rounded-md border border-white/20 bg-white/10 p-2 text-white hover:bg-white/20" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
              <p className="text-[10px] font-bold uppercase tracking-widest text-[#c5a556]">Scope Stats</p>
              <h2 className="mt-0.5 text-lg font-extrabold tracking-tight text-wrap-anywhere">{scopeOrg.organizationName}</h2>
            </div>

            <div className="flex border-b border-slate-200 bg-slate-50">
              {(['users', 'products', 'services'] as const).map(tab => {
                const count = scopeOrg._count?.[tab] ?? 0;
                const Icon = tab === 'users' ? Users : tab === 'products' ? Package : Wrench;
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setScopeTab(tab)}
                    className={cn(
                      "flex-1 px-4 py-3 inline-flex items-center justify-center gap-2 text-xs font-black uppercase tracking-wider border-b-2 transition-colors",
                      scopeTab === tab
                        ? 'border-[#0c2340] text-[#0c2340] bg-white'
                        : 'border-transparent text-slate-500 hover:text-[#0c2340]'
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {tab}
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px]">{count}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <ScopeListPanel
                orgId={scopeOrg.id}
                tab={scopeTab}
                count={scopeOrg._count?.[scopeTab] ?? 0}
                authHeaders={authHeaders}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Lazy loader for the organization scope dialog. Fetches users / products /
 * services for the given org from the matching admin endpoints when the tab
 * becomes active. Falls back to a friendly message if endpoints aren't ready.
 */
function ScopeListPanel({
  orgId,
  tab,
  count,
  authHeaders
}: {
  orgId: number;
  tab: 'users' | 'products' | 'services';
  count: number;
  authHeaders: { headers: Record<string, string> };
}) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (count === 0) {
      setLoading(false);
      setError(null);
      setItems([]);
      return () => { cancelled = true; };
    }
    setLoading(true);
    setError(null);
    setItems([]);
    const params = new URLSearchParams();
    params.set('organizationId', String(orgId));
    params.set('take', '50');
    const endpoint = tab === 'users'
      ? `/api/admin/users?${params.toString()}`
      : tab === 'products'
        ? `/api/admin/catalogue/products?${params.toString()}`
        : `/api/admin/catalogue/services?${params.toString()}`;

    const fetchOptions: RequestInit = {
      method: 'GET',
      credentials: 'include',
      ...(authHeaders || {})
    };

    api.fetch(endpoint, fetchOptions)
      .then(async res => {
        if (!res.ok) {
          let errorMsg = 'Failed to load list';
          try {
            const errBody = await res.json();
            if (errBody?.message) errorMsg = errBody.message;
            else if (errBody?.error?.message) errorMsg = errBody.error.message;
          } catch {
            // body not json
          }
          if (res.status === 429) {
            errorMsg = 'Request limit reached. Please wait a moment and click Retry.';
          } else if (res.status === 401 || res.status === 403) {
            errorMsg = 'Session expired or unauthorized to view list.';
          }
          throw new Error(errorMsg);
        }
        const body = await res.json();
        const data = body?.data || body || {};
        const list = Array.isArray(data)
          ? data
          : Array.isArray(data.records)
            ? data.records
            : Array.isArray(data.users)
              ? data.users
              : Array.isArray(data.products)
                ? data.products
                : Array.isArray(data.services)
                  ? data.services
                  : Array.isArray(data.items)
                    ? data.items
                    : [];
        if (!cancelled) {
          setItems(list.filter((i: any) => {
            const itemOrgId = Number(i.organizationId ?? i.organization?.id ?? i.seller?.organizationId ?? i.buyer?.organizationId);
            return itemOrgId === Number(orgId) || !itemOrgId;
          }));
        }
      })
      .catch(err => {
        if (!cancelled) setError(err?.message || 'Unable to load list');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [orgId, tab, count, authHeaders, reloadKey]);

  const columns = useMemo<ColumnDef<any>[]>(() => [
    {
      key: 'name',
      header: 'Name',
      cell: (item: any) => (
        <span className="font-bold text-slate-900 text-wrap-anywhere">
          {item.name || item.email || '—'}
        </span>
      )
    },
    {
      key: 'detail',
      header: tab === 'users' ? 'Email' : tab === 'products' ? 'SKU / HSN' : 'Pricing',
      cell: (item: any) => (
        <span className="text-xs text-slate-600 text-wrap-anywhere">
          {tab === 'users' ? item.email || '—' : tab === 'products' ? (item.sku || item.hsnCode || '—') : (item.pricingModel || '—')}
        </span>
      )
    },
    {
      key: 'status',
      header: 'Status',
      cell: (item: any) => (
        <span className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-600 text-[10px] font-black uppercase">
          {item.status || item.accountStatus || item.role || '—'}
        </span>
      )
    }
  ], [tab]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-3">
        <p className="text-center text-xs font-bold text-red-500">{error}</p>
        <button
          type="button"
          onClick={() => setReloadKey(k => k + 1)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 transition shadow-sm"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Retry
        </button>
      </div>
    );
  }

  return (
    <DataTable
      data={items}
      columns={columns}
      keyExtractor={(item: any, idx: number) => item.id || `org-${tab}-${idx}`}
      isLoading={loading}
      showSrNo={true}
      srNoHeader="#"
      srNoWidth="w-12"
      emptyTitle={`No ${tab} found`}
      emptyDescription={`No ${tab} found for this organization.`}
      rowClassName="hover:bg-slate-50/50 text-sm"
    />
  );
}

interface OrgActionsDropdownProps {
  org: Organization;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onOpenDetails: (org: Organization) => void;
  onOpenFeatures: (org: Organization) => void;
  onOpenVerify: (org: Organization) => void;
  onOpenBlacklist: (org: Organization) => void;
  onOpenLifecycle: (org: Organization, action: 'close' | 'archive' | 'restore' | 'allow-gst-reuse' | 'revoke-gst-reuse') => void;
  triggerClassName?: string;
}

function OrgActionsDropdown({
  org,
  isOpen,
  onToggle,
  onClose,
  onOpenDetails,
  onOpenFeatures,
  onOpenVerify,
  onOpenBlacklist,
  onOpenLifecycle,
  triggerClassName
}: OrgActionsDropdownProps) {
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
    const menuWidth = 192; // w-48
    const menuEstimatedHeight = 280;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const shouldOpenUp = spaceBelow < menuEstimatedHeight + 8 && spaceAbove > spaceBelow;

    let left = rect.right - menuWidth;
    if (left < 8) left = 8;
    if (left + menuWidth > window.innerWidth - 8) {
      left = window.innerWidth - menuWidth - 8;
    }

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
    <div className="relative inline-flex items-center justify-end" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Actions for organization ${org.organizationName}`}
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
          "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-900 transition-colors focus:outline-none focus:ring-2 focus:ring-[#0c2340]/20 shadow-sm cursor-pointer",
          isOpen && "bg-slate-100 border-slate-300 text-slate-900",
          triggerClassName
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
            transformOrigin: coords.bottom !== undefined ? 'bottom right' : 'top right',
          }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onKeyDown={handleMenuKeyDown}
          className="w-48 rounded-xl border border-slate-200 bg-white p-1.5 shadow-2xl ring-1 ring-black/5 flex flex-col gap-0.5 text-left animate-in fade-in zoom-in-95 duration-100"
          role="menu"
          aria-label={`Actions for organization ${org.organizationName}`}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { onClose(); onOpenDetails(org); }}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-slate-700 hover:bg-slate-100 transition-colors text-left"
          >
            <Eye className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
            <span>Details</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => { onClose(); onOpenFeatures(org); }}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-[#0c2340] hover:bg-[#0c2340]/5 transition-colors text-left"
          >
            <Sliders className="h-3.5 w-3.5 text-[#c5a556]" aria-hidden="true" />
            <span>Features</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => { onClose(); onOpenVerify(org); }}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-emerald-700 hover:bg-emerald-50 transition-colors text-left"
          >
            <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
            <span>Verify</span>
          </button>

          <div className="h-px bg-slate-100 my-1 mx-2" role="separator" />

          <button
            type="button"
            role="menuitem"
            onClick={() => { onClose(); onOpenBlacklist(org); }}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-red-700 hover:bg-red-50 transition-colors text-left"
          >
            <Ban className="h-3.5 w-3.5 text-red-600" aria-hidden="true" />
            <span>{org.isBlacklisted ? "Unrestrict" : "Restrict"}</span>
          </button>

          {org.verificationStatus !== 'CLOSED' && org.verificationStatus !== 'ARCHIVED' && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => { onClose(); onOpenLifecycle(org, 'close'); }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-red-700 hover:bg-red-50 transition-colors text-left"
              >
                <XCircle className="h-3.5 w-3.5 text-red-600" aria-hidden="true" />
                <span>Close</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => { onClose(); onOpenLifecycle(org, 'archive'); }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-amber-700 hover:bg-amber-50 transition-colors text-left"
              >
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                <span>Archive</span>
              </button>
            </>
          )}

          {(org.verificationStatus === 'CLOSED' || org.verificationStatus === 'ARCHIVED') && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { onClose(); onOpenLifecycle(org, 'restore'); }}
              className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-emerald-700 hover:bg-emerald-50 transition-colors text-left"
            >
              <RefreshCw className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
              <span>Restore</span>
            </button>
          )}

          {(org.verificationStatus === 'CLOSED' || org.verificationStatus === 'ARCHIVED') && (
            org.gstReuseAllowed ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => { onClose(); onOpenLifecycle(org, 'revoke-gst-reuse'); }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-amber-700 hover:bg-amber-50 transition-colors text-left"
              >
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                <span>Revoke GST</span>
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => { onClose(); onOpenLifecycle(org, 'allow-gst-reuse'); }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs font-bold rounded-lg text-blue-700 hover:bg-blue-50 transition-colors text-left"
              >
                <Check className="h-3.5 w-3.5 text-blue-600" aria-hidden="true" />
                <span>Allow GST</span>
              </button>
            )
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
