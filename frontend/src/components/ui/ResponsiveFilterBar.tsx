import React, { useState, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Filter, SlidersHorizontal, ChevronDown } from 'lucide-react';

export interface ResponsiveFilterBarProps {
  searchInput: ReactNode;
  filters?: ReactNode;
  endContent?: ReactNode;
  viewToggle?: ReactNode;
  activeFilterCount?: number;
  singleRowDesktop?: boolean;
  className?: string;
  hasFilters?: boolean;
  searchWrapperClassName?: string;
  filtersClassName?: string;
  collapsible?: boolean;
  filterTitle?: string;
  onReset?: () => void;
  resetLabel?: string;
  defaultOpen?: boolean;
  gridColsClassName?: string;
}

export function ResponsiveFilterBar({
  searchInput,
  filters,
  endContent,
  viewToggle,
  activeFilterCount = 0,
  singleRowDesktop = false,
  className,
  hasFilters,
  searchWrapperClassName,
  filtersClassName,
  collapsible = true,
  filterTitle = "Filter By Specific Criteria",
  onReset,
  resetLabel = "Reset Filter Options",
  defaultOpen = false,
  gridColsClassName = "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6",
}: ResponsiveFilterBarProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const showFiltersBtn = hasFilters !== false && Boolean(filters);
  const primaryViewToggle = viewToggle;

  // Automatically flatten / unwrap single outer container div (like <div className="flex flex-wrap...">)
  // so each child filter control is placed into its own grid cell instead of squished into col 1
  const normalizedFilters = React.useMemo(() => {
    if (React.isValidElement(filters) && typeof filters.type === 'string' && filters.type === 'div') {
      const p = filters.props as { className?: string; children?: ReactNode };
      if (p.className?.includes('flex') || p.className?.includes('flex-wrap')) {
        return p.children;
      }
    }
    return filters;
  }, [filters]);

  return (
    <div className={cn("flex flex-col gap-3 w-full min-w-0", className)}>
      {/* Tier 1: Search Input & Primary Actions Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-3 w-full min-w-0">
        {/* Search Bar */}
        <div className={cn("relative flex-1 min-w-0 w-full", searchWrapperClassName)}>
          {searchInput}
        </div>

        {/* Actions & Filters Toggle Toolbar */}
        <div className="flex items-center gap-2 shrink-0 flex-wrap sm:flex-nowrap justify-between sm:justify-end w-full sm:w-auto">
          {/* Filters Toggle Button */}
          {showFiltersBtn && (
            <button
              type="button"
              onClick={() => setIsOpen(prev => !prev)}
              aria-expanded={isOpen}
              aria-controls="advanced-filters-panel"
              aria-label="Toggle filter options"
              className={cn(
                "inline-flex h-9 items-center justify-center gap-2 rounded-xl border px-3 text-xs font-semibold transition-all shadow-2xs cursor-pointer shrink-0",
                isOpen || activeFilterCount > 0
                  ? "border-[#12335f] bg-[#12335f]/5 text-[#12335f] hover:bg-[#12335f]/10"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300"
              )}
            >
              <Filter className="h-3.5 w-3.5 text-[#12335f]" aria-hidden="true" />
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="flex h-4.5 w-4.5 items-center justify-center rounded-full bg-[#12335f] text-white text-[9px] font-black">
                  {activeFilterCount}
                </span>
              )}
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200 text-slate-500", isOpen && "rotate-180")} aria-hidden="true" />
            </button>
          )}

          {/* View Toggle and End Controls */}
          {(primaryViewToggle || endContent) && (
            <div className="flex items-center gap-2 shrink-0">
              {endContent}
              {primaryViewToggle && (
                <div className="border-l border-slate-200 pl-2">
                  {primaryViewToggle}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tier 2: Collapsible Secondary Filter Tray */}
      {isOpen && showFiltersBtn && (
        <div
          id="advanced-filters-panel"
          role="region"
          aria-label="Filter Options"
          className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3 sm:p-3.5 transition-all duration-200 space-y-2.5 animate-in fade-in slide-in-from-top-1"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-3.5 w-3.5 text-[#12335f]" aria-hidden="true" />
              <span className="text-[11px] font-black uppercase tracking-wider text-slate-700">
                {filterTitle}
              </span>
            </div>
            {onReset && (
              <button
                type="button"
                onClick={onReset}
                className="text-[11px] font-bold text-rose-600 hover:text-rose-700 hover:underline cursor-pointer"
              >
                {resetLabel}
              </button>
            )}
          </div>

          <div className={cn(
            "grid gap-2 sm:gap-2.5",
            gridColsClassName,
            // Only unwrap outer non-col-spanning flex wrappers if any remain; preserve composite/col-spanning controls
            "[&>div.flex:not([class*='col-span']):not([data-composite])]:!contents [&>div.flex-wrap:not([class*='col-span']):not([data-composite])]:!contents",
            // Sleek typography & compact sizing for all controls rendered inside
            "[&_select]:!text-xs [&_select]:!font-semibold [&_select]:!text-slate-700 [&_select]:!h-9 [&_select]:!px-2.5 [&_select]:!py-1.5 [&_select]:!rounded-xl [&_select]:!border [&_select]:!border-slate-200 [&_select]:!bg-white [&_select]:!shadow-2xs [&_select]:!w-full [&_select]:!min-w-0",
            "[&_label]:!text-[10px] [&_label]:!font-bold [&_label]:!uppercase [&_label]:!tracking-wider [&_label]:!text-slate-500 [&_label]:!mb-1 [&_label]:!block",
            "[&_input]:!text-xs [&_input]:!h-9 [&_input]:!rounded-xl [&_input]:!w-full [&_input]:!min-w-0",
            "[&_button]:!text-xs",
            "[&>div]:!w-full [&>div]:!max-w-none [&>div]:!min-w-0 [&>div>select]:!w-full [&>select]:!w-full [&>label]:!w-full [&>div>div]:!w-full",
            filtersClassName
          )}>
            {normalizedFilters}
          </div>
        </div>
      )}

      {/* Non-collapsible fallback when explicitly opted out */}
      {!collapsible && filters && !isOpen && (
        <div className="hidden sm:flex items-center flex-wrap gap-2 sm:gap-2.5 w-full min-w-0 pt-2.5 border-t border-slate-100/90">
          {filters}
        </div>
      )}
    </div>
  );
}
