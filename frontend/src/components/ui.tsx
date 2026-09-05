// Small shared presentational helpers.

import type { ReactNode } from "react";
import { Loader2, Clapperboard } from "lucide-react";

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-muted">
      <Loader2 className="size-5 animate-spin" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <div className="text-faint">{icon ?? <Clapperboard className="size-10" />}</div>
      <h3 className="text-lg font-medium text-muted">{title}</h3>
      {children && <div className="max-w-md text-sm text-faint">{children}</div>}
    </div>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <div className={`h-11 shrink-0 ${className}`}>
      <img
        src="/posterview-wordmark.svg?v=2"
        alt="PosterView"
        className="h-11 max-w-none object-contain object-left"
      />
    </div>
  );
}

export function ServerTypeBadge({ type }: { type: string }) {
  return <span className="text-xs text-faint capitalize">{type}</span>;
}
