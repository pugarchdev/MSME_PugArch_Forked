import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Plus, Edit2, Trash2, Search, RefreshCw, FolderPlus, CheckCircle2, AlertTriangle, Layers, Tag, ArrowUp, ArrowDown, ArrowUpDown, Upload, Image as ImageIcon, X, Package, Wrench, Boxes, RotateCcw, Clock, Calendar, Filter, Sparkles, Info, Eye, Check, AlertCircle, Maximize2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../../lib/api';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Pagination } from '../../shared/Pagination';
import { DataTable, ColumnDef } from '../../../components/ui/data-table';
import { usePagination, useResponsiveViewMode } from '../../shared/hooks';
import { ViewModeToggle } from '../../shared/ViewModeToggle';
import { ResponsiveFilterBar } from '../../../components/ui/ResponsiveFilterBar';
import { getCategoryImageUrl, buildCategoryFallbackSvg, BUNDLED_CATEGORY_PHOTO_VERSION } from '../../marketplace/utils/categoryImages';
import { KpiCard } from '../../shared/KpiCard';
import { formatDate, formatTime } from '../../shared/format';

export interface Category {
  id: number;
  name: string;
  slug: string;
  type: 'PRODUCT' | 'SERVICE' | 'BOTH';
  description?: string | null;
  imageUrl?: string | null;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface ImageAnalysis {
  width: number;
  height: number;
  aspectRatioLabel: string;
  isOptimalRatio: boolean;
  fileSizeMb?: number;
  fileName?: string;
}

type SortField = 'id' | 'name' | 'type' | 'slug' | 'isActive' | 'updatedAt';
type SortOrder = 'asc' | 'desc';

export default function AdminCategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [imageFilter, setImageFilter] = useState<string>('ALL');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [viewMode, setViewMode] = useResponsiveViewMode('admin:categories:view-mode');

  // Modal states
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form states
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<'PRODUCT' | 'SERVICE' | 'BOTH'>('BOTH');
  const [formDescription, setFormDescription] = useState('');
  const [formImageUrl, setFormImageUrl] = useState<string>('');
  const [formIsActive, setFormIsActive] = useState<boolean>(true);
  const [imagePreview, setImagePreview] = useState<string>('');
  const [pendingImageFile, setPendingImageFile] = useState<File | null>(null);
  const [imageAnalysis, setImageAnalysis] = useState<ImageAnalysis | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchCategories = async () => {
    setIsLoading(true);
    try {
      let res = await api.fetch('/api/admin/categories');
      if (!res.ok) {
        res = await api.fetch('/api/categories');
      }
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : data.data || [];
        setCategories(list);
      } else {
        toast.error('Failed to load categories');
      }
    } catch {
      toast.error('Error connecting to categories API');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchCategories();
  }, []);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortOrder(field === 'updatedAt' ? 'desc' : 'asc');
    }
  };

  const analyzeImageDimensions = (url: string, file?: File) => {
    if (!url) {
      setImageAnalysis(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const ratio = w / h;
      let label = 'Portrait 3:4 (Ideal for Category Cards)';
      let isOptimalRatio = true;

      if (ratio >= 0.65 && ratio <= 0.85) {
        label = 'Portrait ~3:4 (Perfect Fit)';
        isOptimalRatio = true;
      } else if (ratio > 0.85 && ratio <= 1.15) {
        label = 'Square 1:1 (Good)';
        isOptimalRatio = true;
      } else if (ratio > 1.15) {
        label = 'Landscape (Subject will be centered)';
        isOptimalRatio = false;
      } else {
        label = 'Tall Portrait (Sides will be cropped to fit)';
        isOptimalRatio = false;
      }

      setImageAnalysis({
        width: w,
        height: h,
        aspectRatioLabel: label,
        isOptimalRatio,
        fileSizeMb: file ? Number((file.size / (1024 * 1024)).toFixed(2)) : undefined,
        fileName: file?.name
      });
    };
    img.src = url;
  };

  const openAddModal = () => {
    setEditingCategory(null);
    setFormName('');
    setFormType('BOTH');
    setFormDescription('');
    setFormImageUrl('');
    setFormIsActive(true);
    setImagePreview('');
    setImageAnalysis(null);
    setPendingImageFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setIsAddModalOpen(true);
  };

  const openEditModal = (cat: Category) => {
    setEditingCategory(cat);
    setFormName(cat.name);
    setFormType(cat.type || 'BOTH');
    setFormDescription(cat.description || '');
    setFormImageUrl(cat.imageUrl || '');
    setFormIsActive(cat.isActive !== false);
    const existingImg = cat.imageUrl || '';
    setImagePreview(existingImg);
    setPendingImageFile(null);
    if (existingImg) {
      analyzeImageDimensions(existingImg);
    } else {
      setImageAnalysis(null);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
    setIsAddModalOpen(true);
  };

  const closeCategoryModal = () => {
    setIsAddModalOpen(false);
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.has('edit') || params.has('highlight')) {
        params.delete('edit');
        params.delete('highlight');
        const newSearch = params.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '');
        window.history.replaceState({}, '', newUrl);
      }
    }
  };

  const hasHandledUrlEdit = useRef(false);
  useEffect(() => {
    if (hasHandledUrlEdit.current || categories.length === 0) return;
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const editId = params.get('edit') || params.get('highlight');
    if (editId) {
      const match = categories.find(c => String(c.id) === String(editId));
      if (match) {
        hasHandledUrlEdit.current = true;
        openEditModal(match);
        toast.info(`Opening category "${match.name}" to configure photo.`);
      }
    }
  }, [categories]);

  useEffect(() => {
    const handleOpenCategoryEvent = (e: any) => {
      const targetId = e?.detail?.categoryId;
      if (!targetId || categories.length === 0) return;
      const match = categories.find(c => String(c.id) === String(targetId));
      if (match) {
        openEditModal(match);
        toast.info(`Opening category "${match.name}" to configure photo.`);
      }
    };

    window.addEventListener('admin-open-category-modal', handleOpenCategoryEvent as EventListener);
    return () => {
      window.removeEventListener('admin-open-category-modal', handleOpenCategoryEvent as EventListener);
    };
  }, [categories]);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image size should be less than 5MB');
      return;
    }

    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      toast.error('Please upload a PNG, JPG, or WebP photo');
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    setPendingImageFile(file);
    setImagePreview(previewUrl);
    analyzeImageDimensions(previewUrl, file);
  };

  const uploadCategoryImage = async (categoryId: number, file: File): Promise<string> => {
    const formData = new FormData();
    formData.append('image', file);
    try {
      const res = await api.fetch(`/api/admin/categories/${categoryId}/image`, {
        method: 'POST',
        body: formData,
        headers: {} // let browser set content-type with boundary
      });
      if (res.ok) {
        const updated = await res.json();
        const newUrl = updated?.data?.imageUrl || updated?.imageUrl || '';
        if (!newUrl) throw new Error('Cloud upload completed without an image URL');
        return newUrl;
      } else {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Failed to upload image');
      }
    } catch (error) {
      throw error instanceof Error ? error : new Error('Network error uploading image');
    }
  };

  const handleRemoveImage = () => {
    setImagePreview('');
    setFormImageUrl('');
    setImageAnalysis(null);
    setPendingImageFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleToggleStatus = async (cat: Category, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const nextStatus = !cat.isActive;
    setTogglingId(cat.id);

    // Optimistic UI update
    setCategories(prev => prev.map(c => c.id === cat.id ? { ...c, isActive: nextStatus, updatedAt: new Date().toISOString() } : c));

    try {
      let res = await api.fetch(`/api/admin/categories/${cat.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: nextStatus })
      });
      if (!res.ok) {
        res = await api.fetch(`/api/admin/categories/${cat.id}`, {
          method: 'PUT',
          body: JSON.stringify({ isActive: nextStatus })
        });
      }
      if (res.ok) {
        toast.success(`Category "${cat.name}" is now ${nextStatus ? 'ACTIVE' : 'INACTIVE'}`);
      } else {
        throw new Error('Failed to update status');
      }
    } catch {
      // Rollback on failure
      setCategories(prev => prev.map(c => c.id === cat.id ? { ...c, isActive: !nextStatus } : c));
      toast.error(`Could not update status for "${cat.name}"`);
    } finally {
      setTogglingId(null);
    }
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      toast.error('Please enter a category name');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = editingCategory
        ? await api.fetch(`/api/admin/categories/${editingCategory.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: formName.trim(),
            type: formType,
            description: formDescription.trim() || undefined,
            imageUrl: formImageUrl || null,
            isActive: formIsActive
          })
        })
        : await api.fetch('/api/admin/categories', {
          method: 'POST',
          body: JSON.stringify({
            name: formName.trim(),
            type: formType,
            description: formDescription.trim() || undefined,
            imageUrl: null,
            isActive: formIsActive
          })
        });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Failed to ${editingCategory ? 'update' : 'create'} category`);
      }

      const savedResponse = await res.json();
      const savedCategory = savedResponse?.data || savedResponse;
      if (pendingImageFile) {
        try {
          await uploadCategoryImage(Number(savedCategory.id), pendingImageFile);
        } catch (imgErr) {
          toast.warning(`Category ${editingCategory ? 'updated' : 'created'}, but image upload had an issue: ${imgErr instanceof Error ? imgErr.message : 'Upload failed'}`);
          closeCategoryModal();
          await fetchCategories();
          return;
        }
      }

      toast.success(`Category ${editingCategory ? 'updated' : 'created'} successfully!`);
      closeCategoryModal();
      await fetchCategories();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Network error while saving category');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteCategory = async () => {
    if (!deletingCategory) return;
    setIsSubmitting(true);
    try {
      const res = await api.fetch(`/api/admin/categories/${deletingCategory.id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        toast.success(`Category "${deletingCategory.name}" permanently deleted successfully`);
        setCategories(prev => prev.filter(c => c.id !== deletingCategory.id));
        setDeletingCategory(null);
      } else {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Failed to permanently delete category');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Error deleting category');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isFiltered = Boolean(
    searchQuery.trim() ||
    typeFilter !== 'ALL' ||
    statusFilter !== 'ALL' ||
    imageFilter !== 'ALL'
  );

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (typeFilter !== 'ALL') count++;
    if (statusFilter !== 'ALL') count++;
    if (imageFilter !== 'ALL') count++;
    return count;
  }, [typeFilter, statusFilter, imageFilter]);

  const handleResetFilters = () => {
    setSearchQuery('');
    setTypeFilter('ALL');
    setStatusFilter('ALL');
    setImageFilter('ALL');
    setSortField('name');
    setSortOrder('asc');
  };

  const formatDateTime = (dateStr?: string | null) => {
    if (!dateStr) return { date: '—', time: '' };
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return { date: '—', time: '' };
      return { date: formatDate(d), time: formatTime(d), iso: d.toISOString() };
    } catch {
      return { date: '—', time: '' };
    }
  };

  const filteredCategories = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const list = categories.filter(cat => {
      const matchesSearch = !query || 
        cat.name.toLowerCase().includes(query) || 
        cat.slug.toLowerCase().includes(query) ||
        (cat.description && cat.description.toLowerCase().includes(query));

      const matchesType = typeFilter === 'ALL' || cat.type === typeFilter;

      const matchesStatus = statusFilter === 'ALL' ||
        (statusFilter === 'ACTIVE' && cat.isActive !== false) ||
        (statusFilter === 'INACTIVE' && cat.isActive === false);

      const hasCustomImage = Boolean(cat.imageUrl && !cat.imageUrl.startsWith('data:image/svg+xml'));
      const matchesImage = imageFilter === 'ALL' ||
        (imageFilter === 'WITH_IMAGE' && hasCustomImage) ||
        (imageFilter === 'FALLBACK_ONLY' && !hasCustomImage);

      return matchesSearch && matchesType && matchesStatus && matchesImage;
    });

    return list.sort((a, b) => {
      let valA: any = a[sortField];
      let valB: any = b[sortField];

      if (sortField === 'updatedAt') {
        const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
        const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
        return sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
      }

      if (sortField === 'isActive') {
        valA = a.isActive !== false ? 1 : 0;
        valB = b.isActive !== false ? 1 : 0;
      } else if (typeof valA === 'string') {
        valA = valA.toLowerCase();
        valB = (valB || '').toLowerCase();
      } else if (valA == null) {
        valA = '';
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
  }, [categories, searchQuery, typeFilter, statusFilter, imageFilter, sortField, sortOrder]);

  const { page, pageSize, pageItems: pagedCategories, total, setPage, setPageSize } = usePagination(filteredCategories, 10);

  const stats = useMemo(() => {
    return {
      total: categories.length,
      product: categories.filter(c => c.type === 'PRODUCT').length,
      service: categories.filter(c => c.type === 'SERVICE').length,
      both: categories.filter(c => c.type === 'BOTH').length,
      active: categories.filter(c => c.isActive !== false).length,
    };
  }, [categories]);

  const categoryColumns = useMemo<ColumnDef<Category>[]>(() => [
    {
      key: 'imageUrl',
      header: 'IMAGE',
      align: 'center',
      width: 'w-20',
      cell: (cat) => {
        const displayImg = getCategoryImageUrl(cat as any);
        return (
          <div className="h-10 w-10 mx-auto rounded-lg border border-slate-200/80 bg-white flex items-center justify-center shadow-2xs overflow-hidden">
            <img
              src={displayImg}
              alt={cat.name}
              className="h-full w-full object-cover"
              onError={(e) => {
                const target = e.target as HTMLImageElement;
                target.src = buildCategoryFallbackSvg(cat.name);
              }}
            />
          </div>
        );
      }
    },
    {
      key: 'name',
      header: 'CATEGORY NAME',
      sortable: true,
      cell: (cat) => (
        <div>
          <div className="font-bold text-slate-800">{cat.name}</div>
          {cat.description && (
            <div className="text-[11px] text-slate-400 font-medium truncate max-w-xs">{cat.description}</div>
          )}
        </div>
      )
    },
    {
      key: 'type',
      header: 'TYPE',
      sortable: true,
      width: 'w-28',
      cell: (cat) => (
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider ${
          cat.type === 'PRODUCT' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
          cat.type === 'SERVICE' ? 'bg-purple-50 text-purple-700 border border-purple-200' :
          'bg-indigo-50 text-indigo-700 border border-indigo-200'
        }`}>
          {cat.type || 'BOTH'}
        </span>
      )
    },
    {
      key: 'slug',
      header: 'SLUG',
      sortable: true,
      width: 'w-36',
      cell: (cat) => (
        <span className="font-mono text-[11px] text-slate-500">
          {cat.slug}
        </span>
      )
    },
    {
      key: 'isActive',
      header: 'STATUS',
      sortable: true,
      width: 'w-36',
      cell: (cat) => (
        <button
          type="button"
          role="switch"
          aria-checked={cat.isActive !== false}
          aria-label={`Toggle status for ${cat.name}. Currently ${cat.isActive !== false ? 'Active' : 'Inactive'}`}
          disabled={togglingId === cat.id}
          onClick={(e) => handleToggleStatus(cat, e)}
          title={`Click to ${cat.isActive !== false ? 'Deactivate' : 'Activate'} "${cat.name}"`}
          className={`group inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] font-bold transition-all border cursor-pointer ${
            cat.isActive !== false
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 hover:border-emerald-300 shadow-2xs'
              : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200 hover:border-slate-300'
          } ${togglingId === cat.id ? 'opacity-50 cursor-wait' : ''}`}
        >
          <span className={`h-2 w-2 rounded-full transition-colors ${
            cat.isActive !== false ? 'bg-emerald-500 group-hover:bg-emerald-600' : 'bg-slate-400 group-hover:bg-slate-500'
          }`} />
          <span>{cat.isActive !== false ? 'ACTIVE' : 'INACTIVE'}</span>
          <span className={`inline-flex items-center h-3.5 w-6 rounded-full p-0.5 transition-colors ${
            cat.isActive !== false ? 'bg-emerald-500' : 'bg-slate-300'
          }`}>
            <span className={`h-2.5 w-2.5 rounded-full bg-white shadow-xs transform transition-transform ${
              cat.isActive !== false ? 'translate-x-2.5' : 'translate-x-0'
            }`} />
          </span>
        </button>
      )
    },
    {
      key: 'updatedAt',
      header: 'UPDATED AT',
      sortable: true,
      width: 'w-40',
      cell: (cat) => {
        const dateInfo = formatDateTime(cat.updatedAt || cat.createdAt);
        return dateInfo.date !== '—' ? (
          <div className="flex flex-col" title={dateInfo.iso}>
            <span className="font-semibold text-slate-800 text-[11px]">
              {dateInfo.date}
            </span>
            <span className="text-[10px] text-slate-400 font-mono">
              {dateInfo.time}
            </span>
          </div>
        ) : (
          <span className="text-slate-400 italic text-[11px]">—</span>
        );
      }
    },
    {
      key: 'actions',
      header: 'ACTIONS',
      align: 'right',
      width: 'w-24',
      cell: (cat) => (
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => openEditModal(cat)}
            title="Edit Category"
            aria-label={`Edit ${cat.name}`}
            className="p-1.5 text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
          >
            <Edit2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => setDeletingCategory(cat)}
            title="Delete Category"
            aria-label={`Delete ${cat.name}`}
            className="p-1.5 text-slate-600 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )
    }
  ], [togglingId]);

  return (
    <div className="min-h-screen bg-slate-50/50 p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
              Categories Management
            </h1>
            <span className="bg-indigo-50 text-indigo-700 text-xs font-bold px-2.5 py-0.5 rounded-full border border-indigo-100">
              Admin Control
            </span>
          </div>
          <p className="text-xs sm:text-sm text-slate-500 mt-1 font-medium">
            Manage product and service classification taxonomy, icons, and marketplace visibility.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchCategories}
            disabled={isLoading}
            className="h-9 gap-1.5 text-xs font-bold border-slate-200 text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={openAddModal}
            className="h-9 gap-1.5 text-xs font-bold bg-[#12335f] hover:bg-[#0b2445] text-white shadow-xs"
          >
            <Plus className="h-4 w-4" />
            Add Category
          </Button>
        </div>
      </div>

      {/* KPI Stats Cards */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard
          label="Total Categories"
          value={stats.total}
          subtext="Configured marketplace groups"
          icon={Layers}
          tone="blue"
        />
        <KpiCard
          label="Product Only"
          value={stats.product}
          subtext="Physical merchandise items"
          icon={Package}
          tone="green"
        />
        <KpiCard
          label="Service Only"
          value={stats.service}
          subtext="Professional services"
          icon={Wrench}
          tone="purple"
        />
        <KpiCard
          label="Both (Hybrid)"
          value={stats.both}
          subtext="Dual supply & services"
          icon={Boxes}
          tone="indigo"
        />
        <KpiCard
          label="Active Status"
          value={stats.active}
          subtext="Live on buyer portal"
          icon={CheckCircle2}
          tone="cyan"
        />
      </div>

      {/* ── Search & Filter Toolbar ── */}
      <div className="rounded-2xl border border-slate-200/90 bg-white p-3 sm:p-4 shadow-xs">
        <ResponsiveFilterBar
          activeFilterCount={activeFilterCount}
          searchInput={
            <div className="relative w-full">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                aria-label="Search categories by name, slug, or description"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search categories by name, slug, description..."
                className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50/50 pl-10 pr-9 text-xs font-semibold text-slate-800 placeholder-slate-400 outline-none transition-all focus:border-[#12335f] focus:bg-white focus:ring-2 focus:ring-[#12335f]/10 shadow-inner"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search input"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 rounded-full transition-colors"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          }
          filters={
            <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
              {/* Type Filter */}
              <div className="w-full sm:w-auto sm:min-w-[140px]">
                <label htmlFor="category-type-filter" className="sr-only">Filter by Category Type</label>
                <select
                  id="category-type-filter"
                  aria-label="Filter by Category Type"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 outline-none hover:border-slate-300 focus:border-[#12335f] focus:ring-2 focus:ring-[#12335f]/10 transition-colors shadow-xs cursor-pointer"
                >
                  <option value="ALL">All Types</option>
                  <option value="BOTH">Both (Product & Service)</option>
                  <option value="PRODUCT">Product Only</option>
                  <option value="SERVICE">Service Only</option>
                </select>
              </div>

              {/* Status Filter */}
              <div className="w-full sm:w-auto sm:min-w-[130px]">
                <label htmlFor="category-status-filter" className="sr-only">Filter by Status</label>
                <select
                  id="category-status-filter"
                  aria-label="Filter by Status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 outline-none hover:border-slate-300 focus:border-[#12335f] focus:ring-2 focus:ring-[#12335f]/10 transition-colors shadow-xs cursor-pointer"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="ACTIVE">Active Only</option>
                  <option value="INACTIVE">Inactive Only</option>
                </select>
              </div>

              {/* Image Filter */}
              <div className="w-full sm:w-auto sm:min-w-[140px]">
                <label htmlFor="category-image-filter" className="sr-only">Filter by Photo Status</label>
                <select
                  id="category-image-filter"
                  aria-label="Filter by Photo Status"
                  value={imageFilter}
                  onChange={(e) => setImageFilter(e.target.value)}
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 outline-none hover:border-slate-300 focus:border-[#12335f] focus:ring-2 focus:ring-[#12335f]/10 transition-colors shadow-xs cursor-pointer"
                >
                  <option value="ALL">All Images</option>
                  <option value="WITH_IMAGE">Has Custom Photo</option>
                  <option value="FALLBACK_ONLY">Default Fallback</option>
                </select>
              </div>

              {/* Reset Filters Button */}
              {isFiltered && (
                <button
                  type="button"
                  onClick={handleResetFilters}
                  className="h-10 px-3 inline-flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-rose-300 bg-rose-50/70 text-rose-700 hover:bg-rose-100 hover:border-rose-400 text-xs font-bold transition-colors cursor-pointer"
                  title="Clear all active filters"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Reset</span>
                </button>
              )}
            </div>
          }
          endContent={<ViewModeToggle value={viewMode} onChange={setViewMode} />}
        />
      </div>

      {/* Categories — Grid View */}
      {viewMode === 'grid' && (
        isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-slate-200 bg-white p-4 animate-pulse">
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-14 w-14 rounded-xl bg-slate-100 shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3.5 bg-slate-100 rounded w-3/4" />
                    <div className="h-3 bg-slate-100 rounded w-1/2" />
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="h-3 bg-slate-100 rounded" />
                  <div className="h-3 bg-slate-100 rounded w-5/6" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredCategories.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white py-16 text-center">
            <Layers className="h-10 w-10 text-slate-300" />
            <p className="text-sm font-semibold text-slate-500">No categories found matching your criteria.</p>
            {isFiltered && (
              <Button variant="outline" size="sm" onClick={handleResetFilters} className="text-xs font-semibold">
                Clear All Filters
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {pagedCategories.map((cat) => {
                const displayImg = getCategoryImageUrl(cat as any);
                const dateInfo = formatDateTime(cat.updatedAt || cat.createdAt);
                return (
                  <div
                    key={cat.id}
                    className="group rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:border-indigo-200 hover:shadow-md flex flex-col overflow-hidden"
                  >
                    {/* Card Image Header */}
                    <div className="relative h-32 w-full bg-slate-50 overflow-hidden shrink-0">
                      <img
                        src={displayImg}
                        alt={cat.name}
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                        onError={(e) => {
                          const target = e.target as HTMLImageElement;
                          target.src = buildCategoryFallbackSvg(cat.name);
                        }}
                      />
                      {/* Type badge overlaid on image */}
                      <div className="absolute top-2 left-2">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-wider shadow-xs ${
                          cat.type === 'PRODUCT' ? 'bg-emerald-600 text-white' :
                          cat.type === 'SERVICE' ? 'bg-purple-600 text-white' :
                          'bg-indigo-600 text-white'
                        }`}>
                          {cat.type || 'BOTH'}
                        </span>
                      </div>
                      {/* Status badge overlaid on image */}
                      <div className="absolute top-2 right-2">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={cat.isActive !== false}
                          aria-label={`Toggle status for ${cat.name}. Currently ${cat.isActive !== false ? 'Active' : 'Inactive'}`}
                          disabled={togglingId === cat.id}
                          onClick={(e) => handleToggleStatus(cat, e)}
                          title={`Click to ${cat.isActive !== false ? 'Deactivate' : 'Activate'} "${cat.name}"`}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-wider shadow-xs transition-colors cursor-pointer ${
                            cat.isActive !== false
                              ? 'bg-emerald-500 text-white hover:bg-emerald-600'
                              : 'bg-slate-500 text-white hover:bg-slate-600'
                          } ${togglingId === cat.id ? 'opacity-60 cursor-wait' : ''}`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full bg-white ${
                            togglingId === cat.id ? 'animate-pulse' : ''
                          }`} />
                          {cat.isActive !== false ? 'Active' : 'Inactive'}
                        </button>
                      </div>
                    </div>

                    {/* Card Body */}
                    <div className="flex flex-col flex-1 p-3.5 gap-2">
                      <div className="min-w-0">
                        <h3 className="text-sm font-black text-slate-900 leading-snug break-words group-hover:text-indigo-700 transition-colors">
                          {cat.name}
                        </h3>
                        {cat.description && (
                          <p className="mt-0.5 text-[11px] text-slate-400 font-medium line-clamp-2">{cat.description}</p>
                        )}
                      </div>

                      {/* Slug */}
                      <div className="flex items-center gap-1 min-w-0">
                        <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 shrink-0">Slug</span>
                        <span className="font-mono text-[10px] text-slate-500 truncate">{cat.slug}</span>
                      </div>

                      {/* Updated date */}
                      {dateInfo.date !== '—' && (
                        <div className="flex items-center gap-1">
                          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 shrink-0">Updated</span>
                          <span className="text-[10px] text-slate-500 font-semibold">{dateInfo.date}</span>
                        </div>
                      )}

                      {/* Actions */}
                      <div className="mt-auto pt-2.5 border-t border-slate-100 flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => openEditModal(cat)}
                          title="Edit Category"
                          aria-label={`Edit ${cat.name}`}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 hover:bg-indigo-100 transition-colors"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                          Edit
                        </button>
                        <button
                          onClick={() => setDeletingCategory(cat)}
                          title="Delete Category"
                          aria-label={`Delete ${cat.name}`}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-red-600 bg-red-50 border border-red-100 hover:bg-red-100 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="bg-white rounded-xl border border-slate-200/80">
              <Pagination
                page={page}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
                label="categories"
              />
            </div>
          </>
        )
      )}

      {/* Categories — List/Table View */}
      {viewMode === 'list' && (
        <DataTable<Category>
          data={pagedCategories}
          columns={categoryColumns}
          keyExtractor={(cat) => cat.id}
          isLoading={isLoading}
          showSrNo={true}
          srNoHeader="SR. NO."
          srNoWidth="w-20"
          sortKey={sortField}
          sortDirection={sortOrder}
          onSort={(key) => handleSort(key as SortField)}
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          paginationLabel="categories"
          emptyTitle="No categories found"
          emptyDescription="No categories found matching your criteria."
          emptyAction={isFiltered ? { label: 'Clear All Filters', onClick: handleResetFilters } : undefined}
          caption="Categories Management Taxonomy and Classification Table"
        />
      )}

      {/* Add / Edit Category Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-3 sm:p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl max-w-2xl sm:max-w-3xl w-full p-5 sm:p-7 shadow-2xl border border-slate-100 animate-in zoom-in-95 duration-150 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-5">
              <div>
                <h3 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
                  {editingCategory ? 'Edit Category & Visual Asset' : 'Add New Category'}
                </h3>
                <p className="text-xs text-slate-500 font-medium mt-0.5">
                  Configure category taxonomy name, classification, and marketplace card visuals.
                </p>
              </div>
              <button
                onClick={closeCategoryModal}
                className="h-8 w-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 font-bold text-lg transition-colors"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSaveCategory} className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="form-category-name" className="block text-xs font-bold uppercase text-slate-700 tracking-wide mb-1.5">
                    Category Name *
                  </label>
                  <Input
                    id="form-category-name"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="e.g., Solar & Renewable Energy"
                    required
                    className="h-10 border-slate-300 text-xs font-semibold"
                  />
                </div>

                <div>
                  <label htmlFor="form-category-type" className="block text-xs font-bold uppercase text-slate-700 tracking-wide mb-1.5">
                    Category Classification *
                  </label>
                  <select
                    id="form-category-type"
                    value={formType}
                    onChange={(e) => setFormType(e.target.value as any)}
                    className="w-full h-10 rounded-xl border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-indigo-500/20 shadow-xs"
                  >
                    <option value="BOTH">Both (Product & Service)</option>
                    <option value="PRODUCT">Product Only</option>
                    <option value="SERVICE">Service Only</option>
                  </select>
                </div>
              </div>

              {/* ── Category Photo Section & Guidelines ── */}
              <div className="rounded-xl border border-slate-200/90 bg-slate-50/50 p-4 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 border-b border-slate-200/70 pb-2.5">
                  <div className="flex items-center gap-1.5">
                    <ImageIcon className="h-4 w-4 text-indigo-600" />
                    <span className="text-xs font-black uppercase tracking-wider text-slate-800">
                      Category Card Photo Configuration
                    </span>
                  </div>
                  <span className="text-[11px] font-semibold text-slate-500">
                    Visible across buyer portal & marketplace categories
                  </span>
                </div>

                {/* Configuration Guidelines Banner */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                  <div className="p-2.5 rounded-lg bg-white border border-slate-200 shadow-2xs">
                    <span className="text-slate-400 font-bold block uppercase text-[9px] tracking-wider">Aspect Ratio</span>
                    <span className="font-extrabold text-slate-800">3:4 or 4:5 Portrait</span>
                    <span className="text-[10px] text-slate-400 block mt-0.5">Square (1:1) also works</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white border border-slate-200 shadow-2xs">
                    <span className="text-slate-400 font-bold block uppercase text-[9px] tracking-wider">Optimal Size</span>
                    <span className="font-extrabold text-slate-800">800 × 1000 px</span>
                    <span className="text-[10px] text-slate-400 block mt-0.5">Min: 400 × 500 px</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white border border-slate-200 shadow-2xs">
                    <span className="text-slate-400 font-bold block uppercase text-[9px] tracking-wider">Framing</span>
                    <span className="font-extrabold text-slate-800">Center Subject</span>
                    <span className="text-[10px] text-slate-400 block mt-0.5">Avoid bottom-edge details</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white border border-slate-200 shadow-2xs">
                    <span className="text-slate-400 font-bold block uppercase text-[9px] tracking-wider">File Type</span>
                    <span className="font-extrabold text-slate-800">PNG, JPG, WebP</span>
                    <span className="text-[10px] text-slate-400 block mt-0.5">Max file size 5MB</span>
                  </div>
                </div>

                {/* Hidden File Input */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,image/webp"
                  onChange={handleImageChange}
                  className="hidden"
                />

                {/* Photo Upload & Previews Grid */}
                <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-start pt-1">
                  {/* Left Column: Upload Controls & Specs (7 cols) */}
                  <div className="md:col-span-7 space-y-3">
                    {imagePreview ? (
                      <div className="p-3.5 rounded-xl border border-slate-200 bg-white space-y-3 shadow-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                            Image Selected
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => fileInputRef.current?.click()}
                              className="text-xs font-bold text-indigo-600 hover:text-indigo-800 underline cursor-pointer"
                            >
                              Change Photo
                            </button>
                            <span className="text-slate-300">•</span>
                            <button
                              type="button"
                              onClick={handleRemoveImage}
                              className="text-xs font-bold text-red-600 hover:text-red-800 underline cursor-pointer"
                            >
                              Remove
                            </button>
                          </div>
                        </div>

                        {/* Image Specs & Analysis */}
                        {imageAnalysis && (
                          <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100 space-y-1.5 text-xs">
                            <div className="flex items-center justify-between text-slate-600">
                              <span className="text-slate-500 font-medium">Dimensions:</span>
                              <span className="font-mono font-bold text-slate-800">{imageAnalysis.width} × {imageAnalysis.height} px</span>
                            </div>
                            {imageAnalysis.fileSizeMb !== undefined && (
                              <div className="flex items-center justify-between text-slate-600">
                                <span className="text-slate-500 font-medium">File Size:</span>
                                <span className="font-mono font-bold text-slate-800">{imageAnalysis.fileSizeMb} MB</span>
                              </div>
                            )}
                            <div className="flex items-center justify-between pt-1 border-t border-slate-200/60">
                              <span className="text-slate-500 font-medium">Fit Assessment:</span>
                              <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded ${
                                imageAnalysis.isOptimalRatio
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                  : 'bg-amber-50 text-amber-700 border border-amber-200'
                              }`}>
                                {imageAnalysis.aspectRatioLabel}
                              </span>
                            </div>
                          </div>
                        )}

                        <p className="text-[11px] text-slate-500 leading-relaxed">
                          💡 When saved, this photo will be uploaded to cloud storage and optimized for high-speed delivery.
                        </p>
                      </div>
                    ) : (
                      <div
                        onClick={() => fileInputRef.current?.click()}
                        className="border-2 border-dashed border-slate-300 hover:border-indigo-500 hover:bg-indigo-50/20 rounded-xl p-6 text-center cursor-pointer transition-all flex flex-col items-center justify-center gap-2 group bg-white shadow-2xs"
                      >
                        <div className="h-11 w-11 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                          <Upload className="h-5 w-5" />
                        </div>
                        <div>
                          <div className="text-xs font-black text-slate-800">
                            Click to upload a category photo
                          </div>
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            PNG, JPG, or WebP up to 5MB (Portrait 3:4 or 4:5 recommended)
                          </p>
                        </div>
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-indigo-600 bg-indigo-50 px-3 py-1 rounded-full mt-1 border border-indigo-100">
                          <Sparkles className="h-3 w-3" /> Browse From Computer
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Right Column: Live Previews (5 cols) */}
                  <div className="md:col-span-5 flex flex-col items-center justify-center bg-white p-3.5 rounded-xl border border-slate-200 shadow-2xs">
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1">
                      <Eye className="h-3.5 w-3.5 text-indigo-600" /> Live Marketplace Card Preview
                    </span>

                    {/* Exact replica of marketplace category card */}
                    <div className="relative w-36 sm:w-40 aspect-[3/4] rounded-2xl overflow-hidden border border-slate-200/90 shadow-md bg-slate-100 group">
                      <img
                        src={imagePreview || (editingCategory ? getCategoryImageUrl(editingCategory as any) : buildCategoryFallbackSvg(formName || 'Category'))}
                        alt="Marketplace Card Live Preview"
                        className="absolute inset-0 h-full w-full object-cover object-center"
                        onError={(e) => {
                          const target = e.target as HTMLImageElement;
                          target.src = buildCategoryFallbackSvg(formName || 'Category');
                        }}
                      />
                      
                      {/* Compact lower side shade overlay */}
                      <div className="pointer-events-none absolute bottom-0 inset-x-0 h-12 bg-gradient-to-t from-white/95 via-white/55 to-transparent" />
                      
                      {/* Live Card Details */}
                      <div className="relative z-10 h-full flex flex-col justify-between p-2.5 text-center">
                        <div className="flex justify-end">
                          <span className="px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider bg-slate-900/80 text-white shadow-xs">
                            {formType}
                          </span>
                        </div>
                        <div>
                          <span className="block w-full text-xs font-black leading-tight line-clamp-2 text-slate-950">
                            {formName.trim() || 'Category Name'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <span className="text-[10px] text-slate-400 mt-2 font-medium text-center">
                      Exact view shown on buyer marketplace
                    </span>
                  </div>
                </div>
              </div>

              {/* Active Status in Edit/Add Modal */}
              <div className="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 bg-white shadow-2xs">
                <div>
                  <label htmlFor="form-is-active" className="text-xs font-bold uppercase text-slate-700 tracking-wide block">
                    Active Status in Marketplace
                  </label>
                  <p className="text-[11px] text-slate-500">
                    {formIsActive ? 'Visible to buyers on marketplace and categories taxonomy' : 'Hidden from active marketplace selections'}
                  </p>
                </div>
                <button
                  type="button"
                  id="form-is-active"
                  role="switch"
                  aria-checked={formIsActive}
                  onClick={() => setFormIsActive(!formIsActive)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500/20 ${
                    formIsActive ? 'bg-emerald-600' : 'bg-slate-300'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      formIsActive ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div>
                <label htmlFor="form-category-desc" className="block text-xs font-bold uppercase text-slate-700 tracking-wide mb-1.5">
                  Description (Optional)
                </label>
                <textarea
                  id="form-category-desc"
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="Brief summary of items/services under this category..."
                  rows={2}
                  className="w-full rounded-xl border border-slate-300 p-2.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeCategoryModal}
                  disabled={isSubmitting}
                  className="h-10 px-4 text-xs font-bold border-slate-300"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isSubmitting}
                  className="h-10 px-6 bg-[#12335f] hover:bg-[#0b2445] text-white text-xs font-bold tracking-wide shadow-xs"
                >
                  {isSubmitting ? 'Saving...' : editingCategory ? 'Update Category' : 'Create Category'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingCategory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-xl max-w-md w-full p-6 shadow-2xl border border-slate-100 animate-in zoom-in-95 duration-150 text-center space-y-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600 border border-red-200">
              <Trash2 className="h-6 w-6" />
            </div>

            <div>
              <h3 className="text-base font-bold text-slate-900">Permanently Delete Category?</h3>
              <p className="text-xs text-slate-500 mt-2 font-medium leading-relaxed">
                Are you sure you want to permanently delete <span className="font-bold text-slate-800">"{deletingCategory.name}"</span>?
              </p>
              <div className="mt-2.5 p-2.5 rounded-lg bg-red-50/80 border border-red-200/80 text-[11px] text-red-700 font-semibold text-left">
                ⚠️ This action cannot be undone. This category and its database record will be permanently deleted.
              </div>
            </div>

            <div className="flex items-center justify-center gap-3 pt-2">
              <Button
                variant="outline"
                onClick={() => setDeletingCategory(null)}
                disabled={isSubmitting}
                className="h-10 px-4 text-xs font-bold border-slate-300 w-full"
              >
                Cancel
              </Button>
              <Button
                onClick={handleDeleteCategory}
                disabled={isSubmitting}
                className="h-10 px-4 bg-red-600 hover:bg-red-700 text-white text-xs font-bold tracking-wide w-full shadow-xs"
              >
                {isSubmitting ? 'Deleting...' : 'Permanently Delete'}
              </Button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
