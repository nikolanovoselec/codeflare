import { Component, JSX } from 'solid-js';

interface BrandIconProps {
  size?: number;
  class?: string;
  style?: JSX.CSSProperties;
  fill?: string;
}

/** OpenAI logo mark */
export const OpenAIIcon: Component<BrandIconProps> = (props) => (
  <svg
    viewBox="0 0 24 24"
    width={props.size || 24}
    height={props.size || 24}
    class={props.class}
    style={{ display: 'block', ...props.style }}
  >
    <path
      d="M22.28 9.37a5.98 5.98 0 00-.52-4.93 6.07 6.07 0 00-6.55-2.89A5.98 5.98 0 0010.69.02a6.07 6.07 0 00-5.8 4.22 5.99 5.99 0 00-4 2.9 6.07 6.07 0 00.75 7.12 5.98 5.98 0 00.52 4.93 6.07 6.07 0 006.55 2.89 5.98 5.98 0 004.52 1.53 6.07 6.07 0 005.8-4.22 5.99 5.99 0 004-2.9 6.07 6.07 0 00-.75-7.12zM13.21 21.45c-1.24 0-2.44-.42-3.41-1.2l.17-.1 5.66-3.27a.92.92 0 00.46-.8V10.1l2.39 1.38c.03.01.04.04.05.07v6.61a4.55 4.55 0 01-5.32 4.49v.8zm-9.52-4.2a4.5 4.5 0 01-.54-3.05l.17.1 5.66 3.27a.93.93 0 00.92 0l6.91-3.99v2.76c0 .04-.01.07-.04.09l-5.72 3.3a4.56 4.56 0 01-7.36-2.48zM2.54 7.86a4.52 4.52 0 012.37-1.98v6.74c0 .33.18.64.46.8l6.91 3.99-2.39 1.38a.09.09 0 01-.09 0L4.08 15.5A4.56 4.56 0 012.54 7.86zm16.34 3.8l-6.91-3.99 2.39-1.38a.09.09 0 01.09 0l5.72 3.3a4.55 4.55 0 01-.7 8.22v-6.74a.93.93 0 00-.46-.8l-.13-.61zm2.38-3.1l-.17-.1-5.66-3.27a.93.93 0 00-.92 0L7.6 9.18V6.42c0-.04.01-.07.04-.09l5.72-3.3a4.56 4.56 0 017.1 4.72l-.2-.19zM6.72 13.9L4.33 12.52a.09.09 0 01-.05-.07V5.84A4.55 4.55 0 0111.73 3l-.17.1-5.66 3.27a.92.92 0 00-.46.8l-.72 6.73zm1.3-2.8L12 8.65l3.98 2.3v4.59L12 17.84l-3.98-2.3V11.1z"
      fill={props.fill || 'currentColor'}
    />
  </svg>
);

/** Google Gemini sparkle mark */
export const GeminiIcon: Component<BrandIconProps> = (props) => (
  <svg
    viewBox="0 0 24 24"
    width={props.size || 24}
    height={props.size || 24}
    class={props.class}
    style={{ display: 'block', ...props.style }}
  >
    <path
      d="M12 0C12 6.627 6.627 12 0 12c6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12z"
      fill={props.fill || 'url(#gemini-grad)'}
    />
    <defs>
      <linearGradient id="gemini-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
        <stop stop-color="#4285f4" />
        <stop offset="1" stop-color="#a855f7" />
      </linearGradient>
    </defs>
  </svg>
);
