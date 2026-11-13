'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Image as ImageIcon, Building2, User as UserIcon, ArrowRight, Sparkles, AlertCircle, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../hooks/useAuth';
import { getApi, postApi } from '../shared/apiClient';

interface PendingCategoryAlert {
  id: number;
  notificationId?: number | string;
  name: string;
  userName?: string;
  orgName?: string;
  message?: string;
  redirectUrl?: string;
}

const REMIND_DELAY_MS = 60 * 60 * 1000; // 1 hour

export default function AdminCategoryAlertPopup() {
  const { user } = useAuth();
  const role = String(user?.role || '').toLowerCase();
  const isAdmin = Boolean(user?.id && (role === 'admin' || role === 'master_admin'));
  const [alerts, setAlerts] = useState<PendingCategoryAlert[]>([]);
  const [visible, setVisible] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const snoozeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const getSnoozeKey = useCallback(() => {
    return `admin-category-remind-until:${user?.id || 'default'}`;
  }, [user?.id]);

  const loadPendingCategoryAlerts = useCallback(async () => {
    if (!isAdmin) return;

    // Never interrupt the admin if they are already editing/configuring a category
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search || '');
      if (params.has('edit') || params.has('highlight')) {
        setVisible(false);
        return;
      }
    }

    try {
      // Query backend for all user-added custom categories that still don't have an image
      const pendingRes = await getApi<any>('/api/admin/categories/pending-review').catch(() => null);
      const pendingList: PendingCategoryAlert[] = Array.isArray(pendingRes) ? pendingRes : pendingRes?.data || [];

      if (pendingList.length === 0) {
        // If all images are uploaded, clear any remaining snooze and hide
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(getSnoozeKey());
        }
        setVisible(false);
        return;
      }

      setAlerts(pendingList);
      setVisible(true);
    } catch {
      // Gracefully ignore error
    }
  }, [isAdmin, getSnoozeKey]);

  useEffect(() => {
    if (!isAdmin) return;

    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search || '');
      if (params.has('edit') || params.has('highlight')) {
        setVisible(false);
        return;
      }
    }

    const snoozeKey = getSnoozeKey();
    if (typeof localStorage !== 'undefined') {
      const storedSnooze = localStorage.getItem(snoozeKey);
      if (storedSnooze) {
        const snoozeTime = Number(storedSnooze);
        const remaining = snoozeTime - Date.now();
        if (remaining > 0) {
          // Still within the 1-hour snooze window; set timer to awaken when remaining time expires
          if (snoozeTimerRef.current) clearTimeout(snoozeTimerRef.current);
          snoozeTimerRef.current = setTimeout(() => {
            localStorage.removeItem(snoozeKey);
            void loadPendingCategoryAlerts();
          }, remaining);
          return;
        } else {
          localStorage.removeItem(snoozeKey);
        }
      }
    }

    void loadPendingCategoryAlerts();

    return () => {
      if (snoozeTimerRef.current) clearTimeout(snoozeTimerRef.current);
    };
  }, [user?.id, user?.role, loadPendingCategoryAlerts, getSnoozeKey]);

  const remindIn1Hour = () => {
    const snoozeUntil = Date.now() + REMIND_DELAY_MS;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(getSnoozeKey(), String(snoozeUntil));
    }
    setVisible(false);
    toast.info('Reminder scheduled for 1 hour', {
      description: 'This pop-up will reappear in 1 hour until the category photo is uploaded.'
    });

    if (snoozeTimerRef.current) clearTimeout(snoozeTimerRef.current);
    snoozeTimerRef.current = setTimeout(() => {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(getSnoozeKey());
      }
      void loadPendingCategoryAlerts();
    }, REMIND_DELAY_MS);
  };

  // Handle ESC key to dismiss with 1-hour snooze
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && visible) {
        remindIn1Hour();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible]);

  if (!visible || alerts.length === 0) return null;

  const current = alerts[activeIndex] || alerts[0];

  const openCategoryPhotoEditor = async () => {
    if (current.notificationId) {
      void postApi(`/api/notifications/${current.notificationId}/read`, {}).catch(() => undefined);
    }

    // Immediately snooze popup for 1 hour so the alert popup stops and doesn't reopen over the editor
    const snoozeUntil = Date.now() + REMIND_DELAY_MS;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(getSnoozeKey(), String(snoozeUntil));
    }
    if (snoozeTimerRef.current) clearTimeout(snoozeTimerRef.current);
    setVisible(false);

    const dest = current.redirectUrl || `/admin/categories?edit=${current.id}`;
    if (typeof window !== 'undefined') {
      if (window.location.pathname === '/admin/categories') {
        window.history.pushState({}, '', dest);
        window.dispatchEvent(new CustomEvent('admin-open-category-modal', { detail: { categoryId: current.id } }));
      } else {
        window.location.href = dest;
      }
    }
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="admin-category-alert-title"
      aria-describedby="admin-category-alert-desc"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-md p-4 animate-in fade-in duration-200"
      onClick={(e) => {
        // Dismiss with 1-hour reminder when clicking on the blurred backdrop
        if (e.target === e.currentTarget) {
          remindIn1Hour();
        }
      }}
    >
      <div
        ref={modalRef}
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-amber-200/90 bg-white shadow-2xl animate-in zoom-in-95 duration-200"
      >
        {/* Top Header Banner */}
        <div className="flex items-center justify-between gap-3 border-b border-amber-200/90 bg-gradient-to-r from-amber-50 via-amber-100/60 to-orange-50 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-600 text-white shadow-sm">
              <ImageIcon className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded bg-amber-200/80 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-amber-950">
                  <Sparkles className="h-2.5 w-2.5" /> Action Required
                </span>
                {alerts.length > 1 && (
                  <span className="text-[11px] font-bold text-amber-900">
                    ({activeIndex + 1} of {alerts.length})
                  </span>
                )}
              </div>
              <h2 id="admin-category-alert-title" className="text-sm font-black uppercase tracking-wide text-slate-900 mt-0.5">
                New Custom Category Added
              </h2>
            </div>
          </div>

          <button
            type="button"
            onClick={remindIn1Hour}
            title="Remind me in 1 hour"
            aria-label="Dismiss custom category alert for 1 hour"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-amber-200 bg-white text-slate-500 transition hover:border-red-300 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Main Content Area */}
        <div className="p-6 space-y-4">
          {/* Category Highlight Card */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/90 p-4 space-y-2.5 shadow-2xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
              Category Name
            </span>
            <div className="flex items-center justify-between gap-3">
              <span className="text-base font-black text-slate-900">
                {current.name}
              </span>
              <span className="shrink-0 rounded-md border border-amber-300 bg-amber-100/90 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-amber-900">
                No Image
              </span>
            </div>

            {/* User & Organization Attribution */}
            {(current.userName || current.orgName) && (
              <div className="pt-3 border-t border-slate-200/80 space-y-1.5 text-xs">
                {current.userName && (
                  <div className="flex items-center gap-2 text-slate-600">
                    <UserIcon className="h-4 w-4 text-slate-400 shrink-0" />
                    <span className="font-semibold text-slate-500">Requested by:</span>
                    <span className="font-extrabold text-slate-800">{current.userName}</span>
                  </div>
                )}
                {current.orgName && (
                  <div className="flex items-center gap-2 text-slate-600">
                    <Building2 className="h-4 w-4 text-slate-400 shrink-0" />
                    <span className="font-semibold text-slate-500">Organization:</span>
                    <span className="font-extrabold text-slate-800">{current.orgName}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Guidance Info Banner */}
          <div id="admin-category-alert-desc" className="flex items-start gap-2.5 text-xs text-slate-600 leading-relaxed bg-blue-50/70 p-3 rounded-xl border border-blue-100">
            <AlertCircle className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
            <p className="text-[11px] leading-relaxed">
              This category was created by an enterprise user and is live without a display image. Upload an official 3:4 portrait photo (PNG/JPG/WebP) so it renders properly across the buyer marketplace cards.
            </p>
          </div>

          {/* Carousel navigation if multiple custom categories are pending */}
          {alerts.length > 1 && (
            <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-xs">
              <button
                type="button"
                onClick={() => setActiveIndex(prev => (prev > 0 ? prev - 1 : alerts.length - 1))}
                className="text-xs font-bold text-slate-600 hover:text-slate-900 px-2.5 py-1 rounded hover:bg-slate-100"
              >
                &larr; Previous Category
              </button>
              <span className="text-[11px] font-semibold text-slate-400">
                {activeIndex + 1} of {alerts.length} pending
              </span>
              <button
                type="button"
                onClick={() => setActiveIndex(prev => (prev < alerts.length - 1 ? prev + 1 : 0))}
                className="text-xs font-bold text-slate-600 hover:text-slate-900 px-2.5 py-1 rounded hover:bg-slate-100"
              >
                Next Category &rarr;
              </button>
            </div>
          )}

          {/* Action Footer Buttons */}
          <div className="flex flex-col-reverse sm:flex-row items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={remindIn1Hour}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition shadow-2xs focus:outline-none focus:ring-2 focus:ring-slate-300"
            >
              <Clock className="h-3.5 w-3.5 text-slate-500" />
              <span>Remind me in 1 hour</span>
            </button>

            <button
              type="button"
              onClick={openCategoryPhotoEditor}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-[#12335f] px-5 py-2.5 text-xs font-black uppercase tracking-wider text-white shadow-md transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer"
            >
              <ImageIcon className="h-4 w-4" />
              <span>Upload Image Now</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
