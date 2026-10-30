/** @jsxImportSource react */
import React from "react";
import type { InteractiveRendererProps } from "./types.js";

export function GenericInteractiveRenderer({ method, params, status }: InteractiveRendererProps) {
  return (
    <div className="mx-4 my-1 p-2 bg-[var(--bg-hover)] rounded text-xs">
      <span className="text-[var(--text-secondary)]">{method}: </span>
      <span className="text-[var(--text-tertiary)]">
        {status === "pending" ? "Waiting for response..." : status === "dismissed" ? "Answered in terminal" : status}
      </span>
      <span className="text-[var(--text-tertiary)] ml-1">
        {JSON.stringify(params).slice(0, 100)}
      </span>
    </div>
  );
}
