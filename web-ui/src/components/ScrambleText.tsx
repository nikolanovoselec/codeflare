import { useScrambleText } from '../lib/use-scramble-text';

interface Props {
  text: string;
  class?: string;
  skipInitialHold?: boolean;
}

export default function ScrambleText(props: Props) {
  const display = useScrambleText(() => props.text, () => true, { fourPhase: true, skipInitialHold: props.skipInitialHold });

  return <span class={props.class}>{display()}</span>;
}
