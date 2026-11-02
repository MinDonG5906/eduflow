"use client";

import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { BookOpen, ChevronRight, CircleHelp, FileText, LayoutGrid, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { StudioView } from "./types";

export function StudioSidebar({
  open,
  setOpen,
  view,
  onNavigate,
  sceneCount,
  hasBoard,
  busy,
  importing,
  onNew,
  onHelp,
}: {
  open: boolean;
  // A state setter, so the focus trap below is not re-installed on every render.
  setOpen: Dispatch<SetStateAction<boolean>>;
  view: StudioView;
  onNavigate: (view: StudioView) => void;
  sceneCount: number;
  hasBoard: boolean;
  busy: boolean;
  importing: boolean;
  onNew: () => void;
  onHelp: () => void;
}) {
  const sidebarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const navigation = sidebarRef.current;
    const focusable = () => Array.from(
      navigation?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? [],
    );
    focusable()[0]?.focus();
    document.body.style.overflow = "hidden";
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key !== "Tab") return;
      const targets = focusable();
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const desktop = window.matchMedia("(min-width: 761px)");
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    document.addEventListener("keydown", handleKey);
    desktop.addEventListener("change", closeOnDesktop);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKey);
      desktop.removeEventListener("change", closeOnDesktop);
      previousFocus?.focus();
    };
  }, [open, setOpen]);

  return (
    <>
      <aside ref={sidebarRef} id="studio-navigation" className={`sidebar ${open ? "sidebar-open" : ""}`} aria-label="워크스페이스 탐색" role={open ? "dialog" : undefined} aria-modal={open || undefined}>
        <a className="brand" href="/" aria-label="EduFlow 홈">
          <div className="brand-symbol" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <span>EduFlow</span>
        </a>
        <Button
          variant="outline"
          className="new-work"
          onClick={onNew}
          disabled={busy || importing}
        >
          <Plus size={17} /> 새 스토리보드
        </Button>
        <button
          className={`nav-item ${view === "input" ? "selected" : ""}`}
          aria-current={view === "input" ? "page" : undefined}
          onClick={() => {
            onNavigate("input");
            setOpen(false);
          }}
          disabled={busy}
        >
          <FileText size={18} /> 원고 및 생성 설정 <ChevronRight size={14} />
        </button>
        <button
          className={`nav-item ${view === "board" ? "selected" : ""}`}
          aria-current={view === "board" ? "page" : undefined}
          onClick={() => {
            onNavigate("board");
            setOpen(false);
          }}
          disabled={!hasBoard || busy}
        >
          <LayoutGrid size={18} /> 스토리보드{" "}
          <span className="nav-count">{sceneCount}</span>
        </button>
        <a className="nav-item" href="/knowledge">
          <BookOpen size={18} /> 지식베이스 관리 <ChevronRight size={14} />
        </a>
        <div className="sidebar-bottom">
          <button onClick={onHelp}>
            <CircleHelp size={17} /> 도움말 및 안내 <ChevronRight size={14} />
          </button>
        </div>
      </aside>
      {open && (
        <button
          className="sidebar-scrim"
          aria-label="메뉴 닫기"
          onClick={() => setOpen(false)}
        />
      )}
    </>
  );
}
