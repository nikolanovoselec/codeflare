import { Component, JSX, splitProps } from 'solid-js';

interface IconProps extends JSX.SvgSVGAttributes<SVGSVGElement> {
  path: string;
  size?: number;
  class?: string;
  style?: JSX.CSSProperties;
}

// Icon component for MDI icons
// Usage: <Icon path={mdiPlay} size={20} />
const Icon: Component<IconProps> = (props) => {
  const [local, others] = splitProps(props, ['path', 'size', 'class', 'style']);
  const size = () => local.size || 24;

  return (
    <svg
      viewBox="0 0 24 24"
      width={size()}
      height={size()}
      class={local.class}
      style={{
        fill: 'currentColor',
        ...local.style,
      }}
      {...others}
    >
      <path d={local.path} />
    </svg>
  );
};

export default Icon;
