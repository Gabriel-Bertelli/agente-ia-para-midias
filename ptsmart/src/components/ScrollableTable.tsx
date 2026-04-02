import React, { useRef, useEffect, useCallback } from 'react';

/**
 * ScrollableTable
 * ───────────────
 * Wraps any <table> with:
 *  • A mirrored scrollbar on TOP (so users don't need to scroll all the way
 *    down to find the horizontal scrollbar).
 *  • A sticky <thead> so column headers stay visible while scrolling down.
 *  • The two scrollbars are kept in sync via a single shared handler.
 */
interface Props {
  children: React.ReactNode;
  maxHeight?: string; // e.g. '70vh' — limits vertical size so thead sticks
  className?: string;
}

export function ScrollableTable({ children, maxHeight = '72vh', className = '' }: Props) {
  const topBarRef  = useRef<HTMLDivElement>(null);
  const innerRef   = useRef<HTMLDivElement>(null);
  const ghostRef   = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false); // prevent recursive scroll events

  // Sync ghost div width with actual table width so top scrollbar works
  const syncGhostWidth = useCallback(() => {
    if (!innerRef.current || !ghostRef.current) return;
    const tableEl = innerRef.current.querySelector('table');
    if (tableEl) {
      ghostRef.current.style.width = `${tableEl.scrollWidth}px`;
    }
  }, []);

  useEffect(() => {
    syncGhostWidth();
    const ro = new ResizeObserver(syncGhostWidth);
    if (innerRef.current) ro.observe(innerRef.current);
    return () => ro.disconnect();
  }, [syncGhostWidth, children]);

  const onTopScroll = useCallback(() => {
    if (syncingRef.current || !topBarRef.current || !innerRef.current) return;
    syncingRef.current = true;
    innerRef.current.scrollLeft = topBarRef.current.scrollLeft;
    syncingRef.current = false;
  }, []);

  const onInnerScroll = useCallback(() => {
    if (syncingRef.current || !topBarRef.current || !innerRef.current) return;
    syncingRef.current = true;
    topBarRef.current.scrollLeft = innerRef.current.scrollLeft;
    syncingRef.current = false;
  }, []);

  return (
    <div className={`relative ${className}`}>
      {/* ── Top mirror scrollbar ── */}
      <div
        ref={topBarRef}
        onScroll={onTopScroll}
        style={{ overflowX: 'auto', overflowY: 'hidden', height: 12 }}
        className="rounded-t border-b border-slate-200 bg-slate-50/60"
        aria-hidden="true"
      >
        {/* Ghost element whose width matches the table's scroll width */}
        <div ref={ghostRef} style={{ height: 1 }} />
      </div>

      {/* ── Actual scrollable table area ── */}
      <div
        ref={innerRef}
        onScroll={onInnerScroll}
        style={{ overflowX: 'auto', overflowY: 'auto', maxHeight }}
      >
        {/*
          The children (a <table>) will have its <thead> made sticky via CSS.
          We inject a global style here so consumers don't need to remember.
        */}
        <style>{`
          .scrollable-table-inner thead th {
            position: sticky;
            top: 0;
            z-index: 10;
          }
          .scrollable-table-inner tfoot td {
            position: sticky;
            bottom: 0;
            z-index: 10;
          }
        `}</style>
        <div className="scrollable-table-inner">
          {children}
        </div>
      </div>
    </div>
  );
}
