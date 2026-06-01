import { useScrambleText } from '../lib/use-scramble-text';

interface Props {
  text: string;
  class?: string;
}

export default function ScrambleText(props: Props) {
  const display = useScrambleText(() => props.text, () => true, { fourPhase: true });

  return <span class={props.class}>{display()}</span>;
}
