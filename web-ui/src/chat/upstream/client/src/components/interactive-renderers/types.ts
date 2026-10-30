/** Props every interactive renderer receives */
export interface InteractiveRendererProps {
  requestId: string;
  method: string;
  params: Record<string, unknown>;
  status: "pending" | "resolved" | "cancelled" | "dismissed";
  result?: unknown;
  onRespond: (result: unknown) => void;
  onCancel: () => void;
}

/** An interactive renderer is a React component matching this signature */
export type InteractiveRenderer = React.ComponentType<InteractiveRendererProps>;
