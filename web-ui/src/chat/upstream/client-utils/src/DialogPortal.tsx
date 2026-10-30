/** @jsxImportSource react */
import { useContext, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LayerHostContext } from "./LayerPortal.js";

interface Props {
  children: ReactNode;
}

export function DialogPortal({ children }: Props) {
  const host = useContext(LayerHostContext);
  const prevOverflow = useRef<string>("");

  useEffect(() => {
    // A bounded embed owns its scrolling; do not mutate its surrounding shell.
    if (host) return;
    prevOverflow.current = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow.current;
    };
  }, [host]);

  return createPortal(children, host ?? document.body);
}
