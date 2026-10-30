'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { routeStatus, type Route } from '@haulpath/domain';
import type { LocalPlanningRequest } from './use-project-routes';

export const resultTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function RouteState({ route, planningRequests }: { route: Route; planningRequests: LocalPlanningRequest[] }) {
  const task = route.planning?.inputVersion === route.inputVersion ? route.planning : null;
  const running = task?.status === 'running' || planningRequests.some((pending) => pending.id === route.id && pending.inputVersion === route.inputVersion);
  return <><span className={`status status-${routeStatus(route)}`}>{routeStatus(route)}</span>{running ? <span className="overview-task">规划中 {task?.status === 'running' ? task.completed : 0}/{task?.status === 'running' ? task.total : Math.max(0, route.points.length - 1)}</span> : task?.status === 'failed' ? <span className="overview-task overview-task-error">最近规划失败</span> : null}</>;
}

export function OrderedPoints({ route, expanded, onToggle }: { route: Route; expanded: boolean; onToggle: () => void }) {
  const text = route.points.map((point) => point.name).join(' → ');
  const content = useRef<HTMLDivElement>(null);
  const id = useId();
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > parseFloat(getComputedStyle(element).lineHeight) * 2 + 1);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  if (!route.points.length) return <span className="overview-muted">尚未添加点位</span>;
  return <><div ref={content} id={id} className={`overview-points${expanded ? ' expanded' : ''}`}>{text}</div>{(overflowing || expanded) && <Button className="text-button overview-expand" aria-label={`${expanded ? '收起' : '展开'} ${route.name} 的全部点位`} aria-expanded={expanded} aria-controls={id} onClick={onToggle}>{expanded ? '收起' : '展开全部点位'}</Button>}</>;
}
