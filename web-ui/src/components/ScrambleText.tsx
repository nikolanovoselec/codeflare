import { createSignal, onMount, onCleanup } from 'solid-js';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*<>{}[]|/\\~';
const TICK_MS = 50;

type Phase = 'hold' | 'scramble' | 'decrypt' | 'swap';

interface Props {
  text: string;
  class?: string;
}

export default function ScrambleText(props: Props) {
  const [display, setDisplay] = createSignal(props.text);
  let timer: ReturnType<typeof setInterval> | undefined;

  const randomChar = () => CHARS[Math.floor(Math.random() * CHARS.length)];

  onMount(() => {
    let phase: Phase = 'hold';
    let frame = 0;
    const target = props.text;
    let current = target.split('');

    timer = setInterval(() => {
      frame++;

      if (phase === 'hold') {
        if (frame > 60) { phase = 'scramble'; frame = 0; }
        return;
      }

      if (phase === 'scramble') {
        current = current.map((_, i) =>
          Math.random() < 0.4 ? randomChar() : target[i]
        );
        if (frame > 30) { phase = 'decrypt'; frame = 0; }
      }

      else if (phase === 'decrypt') {
        current = current.map((_, i) =>
          Math.random() < frame / 25 ? target[i] : randomChar()
        );
        if (frame > 25) { phase = 'swap'; frame = 0; current = target.split(''); }
      }

      else if (phase === 'swap') {
        const a = Math.floor(Math.random() * current.length);
        const b = Math.floor(Math.random() * current.length);
        [current[a], current[b]] = [current[b], current[a]];
        if (frame > 15) { phase = 'hold'; frame = 0; current = target.split(''); }
      }

      setDisplay(current.join(''));
    }, TICK_MS);
  });

  onCleanup(() => { if (timer) clearInterval(timer); });

  return <span class={props.class}>{display()}</span>;
}
