import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link as RouterLink, useNavigate as useRouterNavigate, useParams as useRouterParams, useSearchParams as useRouterSearchParams, type LinkProps, type NavigateFunction, type SetURLSearchParams } from "react-router-dom";

// The same library pages can navigate normally or inside the Appearance preview.
export const LibraryNavigationContext = createContext<{
  navigate: NavigateFunction;
  params: Record<string, string | undefined>;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
} | null>(null);

export function useNavigate() {
  const preview = useContext(LibraryNavigationContext);
  const navigate = useRouterNavigate();
  return preview?.navigate ?? navigate;
}

export function LibraryBackdrop({ children }: { children: ReactNode }) {
  const preview = useContext(LibraryNavigationContext);
  return preview ? children : createPortal(children, document.body);
}

export function useParams() {
  const preview = useContext(LibraryNavigationContext);
  const params = useRouterParams();
  return preview?.params ?? params;
}

export function useSearchParams(): [URLSearchParams, SetURLSearchParams] {
  const preview = useContext(LibraryNavigationContext);
  const normal = useRouterSearchParams();
  return preview ? [preview.searchParams, preview.setSearchParams] : normal;
}

export function Link({ onClick, ...props }: LinkProps) {
  const preview = useContext(LibraryNavigationContext);
  return <RouterLink {...props} onClick={event => {
    onClick?.(event);
    if (preview && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      void preview.navigate(props.to, { replace: props.replace });
    }
  }} />;
}
