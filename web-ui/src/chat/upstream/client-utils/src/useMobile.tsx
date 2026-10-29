/** @jsxImportSource react */
import React, { createContext, useContext, type ReactNode } from "react";
import { useMediaQuery } from "./useMediaQuery.js";

const MobileContext = createContext(false);

/**
 * Provides isMobile boolean (viewport width < 768px OR height < 600px) to the component tree.
 */
export function MobileProvider({ children }: { children: ReactNode }) {
  // Comma in a CSS media query string is OR. We treat the layout as mobile
  // whenever EITHER the width is < 768px OR the height is < 600px so that
  // landscape phones (e.g. 844x390, 915x412) flip to the single-panel mobile
  // layout instead of getting the cramped desktop two-panel one.
  // See change: fix-mobile-header-and-orientation.
  const isMobile = useMediaQuery("(max-width: 767px), (max-height: 599px)");
  return (
    <MobileContext.Provider value={isMobile}>
      {children}
    </MobileContext.Provider>
  );
}

/**
 * Returns true when the viewport width is < 768px OR the viewport height is < 600px.
 * The height arm is what catches landscape phones (~390-430px tall) so they get the
 * single-panel mobile layout instead of the cramped desktop two-panel one.
 */
export function useMobile(): boolean {
  return useContext(MobileContext);
}
