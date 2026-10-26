'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Route } from '@/lib/domain';
import { request } from '@/lib/client-request';

type ProjectSession = { projectId: string };
export type ProjectRouteRead = { session: ProjectSession; generation: number; sequence: number };
export type LocalPlanningRequest = ProjectRouteRead & { requestId: number; id: string; inputVersion: number };

// Project lists, foreground reads and writes share one session and one read generation.
// A session is an object so A → B → A cannot revive callbacks from the first A.
export function useProjectRoutes(projectId: string) {
  const [routes, setRoutes] = useState<Route[]>([]);
  const routesRef = useRef<Route[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [planningRequests, setPlanningRequests] = useState<LocalPlanningRequest[]>([]);
  const latestProject = useRef(projectId);
  latestProject.current = projectId;
  const session = useRef<ProjectSession>({ projectId: '' });
  const generation = useRef(0);
  const sequence = useRef(0);
  const appliedReads = useRef(new Map<string, number>());
  const writes = useRef(0);
  const pending = useRef(new Map<string, LocalPlanningRequest>());
  const requestId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const queued = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  const isSessionCurrent = useCallback((read: ProjectRouteRead) => read.session === session.current && read.session.projectId === latestProject.current, []);
  const isReadCurrent = useCallback((read: ProjectRouteRead) => isSessionCurrent(read) && read.generation === generation.current && writes.current === 0, [isSessionCurrent]);
  const captureRead = useCallback((): ProjectRouteRead => ({ session: session.current, generation: generation.current, sequence: ++sequence.current }), []);
  const commitRoutes = useCallback((next: Route[]) => { routesRef.current = next; setRoutes(next); }, []);
  const clearTimer = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  const schedule = useCallback(() => {
    clearTimer();
    if (document.visibilityState === 'hidden' || writes.current || !session.current.projectId) return;
    if (pending.current.size || routesRef.current.some((item) => item.planning?.status === 'running')) {
      timer.current = setTimeout(() => { timer.current = null; void refreshRef.current(); }, 1000);
    }
  }, [clearTimer]);

  const refreshRoutes = useCallback((): Promise<void> => {
    if (!session.current.projectId || session.current.projectId !== latestProject.current || document.visibilityState === 'hidden') return Promise.resolve();
    clearTimer();
    if (inFlight.current) return inFlight.current;
    if (writes.current) { queued.current = true; return Promise.resolve(); }
    const read = captureRead();
    queued.current = false;
    setRefreshing(true);
    const abort = new AbortController(); controller.current = abort;
    const work = request<Route[]>(`/api/projects/${read.session.projectId}/routes`, 'GET', undefined, abort.signal).then((items) => {
      if (!isReadCurrent(read)) return;
      const previous = new Map(routesRef.current.map((item) => [item.id, item]));
      commitRoutes(items.filter((item) => item.projectId === read.session.projectId).map((item) => {
        if ((appliedReads.current.get(item.id) ?? 0) > read.sequence) return previous.get(item.id) ?? item;
        appliedReads.current.set(item.id, read.sequence);
        return item;
      }));
      setLoaded(true); setRefreshError('');
    }).catch((failure) => {
      if (isReadCurrent(read)) setRefreshError(failure instanceof Error ? failure.message : '读取项目线路失败，请重试。');
    }).finally(() => {
      if (inFlight.current !== work) return;
      inFlight.current = null; controller.current = null;
      if (isSessionCurrent(read)) setRefreshing(false);
      if (queued.current && !writes.current) { queued.current = false; void refreshRef.current(); }
      else schedule();
    });
    inFlight.current = work;
    return work;
  }, [captureRead, clearTimer, commitRoutes, isReadCurrent, isSessionCurrent, schedule]);
  refreshRef.current = refreshRoutes;

  const applyRoute = useCallback((next: Route, read: ProjectRouteRead) => {
    if (!isReadCurrent(read) || next.projectId !== read.session.projectId) return false;
    const previous = routesRef.current.find((item) => item.id === next.id);
    if (!previous || previous.inputVersion > next.inputVersion || previous.updatedAt > next.updatedAt || (appliedReads.current.get(next.id) ?? 0) > read.sequence) return false;
    appliedReads.current.set(next.id, read.sequence);
    commitRoutes(routesRef.current.map((item) => item.id === next.id ? next : item));
    schedule();
    return true;
  }, [commitRoutes, isReadCurrent, schedule]);

  const beginWrite = useCallback(() => {
    clearTimer(); generation.current++; writes.current++;
    if (inFlight.current) queued.current = true;
    return captureRead();
  }, [captureRead, clearTimer]);
  const commitRoute = useCallback((next: Route, write: ProjectRouteRead) => {
    if (!isSessionCurrent(write) || next.projectId !== write.session.projectId) return false;
    const found = routesRef.current.some((item) => item.id === next.id);
    commitRoutes(found ? routesRef.current.map((item) => item.id === next.id ? next : item) : [...routesRef.current, next]);
    return true;
  }, [commitRoutes, isSessionCurrent]);
  const removeRoute = useCallback((id: string, write: ProjectRouteRead) => {
    if (!isSessionCurrent(write)) return;
    commitRoutes(routesRef.current.filter((item) => item.id !== id));
  }, [commitRoutes, isSessionCurrent]);
  const endWrite = useCallback((write: ProjectRouteRead) => {
    if (!isSessionCurrent(write)) return;
    generation.current++; writes.current = Math.max(0, writes.current - 1);
    if (queued.current && !inFlight.current && !writes.current) void refreshRef.current();
    else schedule();
  }, [isSessionCurrent, schedule]);

  const beginPlanning = useCallback((route: Route): LocalPlanningRequest => {
    const planning = { ...captureRead(), requestId: ++requestId.current, id: route.id, inputVersion: route.inputVersion };
    pending.current.set(route.id, planning); setPlanningRequests([...pending.current.values()]); schedule();
    return planning;
  }, [captureRead, schedule]);
  const isPlanningCurrent = useCallback((planning: LocalPlanningRequest) => isSessionCurrent(planning) && pending.current.get(planning.id)?.requestId === planning.requestId, [isSessionCurrent]);
  const endPlanning = useCallback((planning: LocalPlanningRequest) => {
    if (!isPlanningCurrent(planning)) return;
    // A completed planning request makes previously captured list data obsolete.
    generation.current++; queued.current = true;
    pending.current.delete(planning.id); setPlanningRequests([...pending.current.values()]);
    void refreshRef.current();
  }, [isPlanningCurrent]);

  useEffect(() => {
    session.current = { projectId }; generation.current++; writes.current = 0;
    appliedReads.current.clear(); pending.current.clear(); setPlanningRequests([]);
    commitRoutes([]); setLoaded(false); setRefreshError(''); setRefreshing(false); clearTimer();
    if (inFlight.current) queued.current = !!projectId;
    else if (projectId) void refreshRef.current();
    return () => {
      session.current = { projectId: '' }; clearTimer();
      controller.current?.abort(); controller.current = null; inFlight.current = null;
    };
  }, [projectId, clearTimer, commitRoutes]);

  useEffect(() => {
    const focus = () => { void refreshRef.current(); };
    const visibility = () => { if (document.visibilityState === 'hidden') clearTimer(); else focus(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visibility); };
  }, [clearTimer]);

  return { routes, routesRef, refreshing, loaded, refreshError, initialLoading: refreshing && !loaded, refreshRoutes, captureRead, isReadCurrent, isSessionCurrent, applyRoute, beginWrite, commitRoute, removeRoute, endWrite, planningRequests, beginPlanning, isPlanningCurrent, endPlanning };
}
