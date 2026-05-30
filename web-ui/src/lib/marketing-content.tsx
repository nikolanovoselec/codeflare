import type { JSX } from 'solid-js';
import {
  mdiRobotOutline,
  mdiLightningBolt,
  mdiSourceBranch,
  mdiCellphoneLink,
  mdiCellphoneScreenshot,
  mdiCloudLockOutline,
  mdiRocketLaunchOutline,
  mdiConsole,
} from '@mdi/js';

/** Home/login feature highlights shared between LoginPage and SubscribePage */
export const FEATURES: Array<{ icon: string; content: () => JSX.Element }> = [
  { icon: mdiRobotOutline, content: () => <>Claude Code, Codex, Antigravity & more</> },
  { icon: mdiLightningBolt, content: () => <>Pre-loaded, ready in seconds</> },
  { icon: mdiSourceBranch, content: () => <><span style={{ color: '#3b82f6' }}>GitHub</span> & <span style={{ color: '#f38020' }}>Cloudflare</span> built in</> },
  { icon: mdiConsole, content: () => <>Full Linux terminal, any browser</> },
  { icon: mdiCellphoneScreenshot, content: () => <>Containers self-destruct when done</> },
  { icon: mdiCloudLockOutline, content: () => <>Encrypted in transit and at rest</> },
  { icon: mdiRocketLaunchOutline, content: () => <>Idea to deployment in minutes</> },
  { icon: mdiCellphoneLink, content: () => <>Files persist. Bad decisions don't.</> },
];
