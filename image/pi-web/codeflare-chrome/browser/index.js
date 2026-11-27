import { activateTranscriptIntent } from './transcript-intent.js';

export default {
  apiVersion: 5,
  name: 'Codeflare Chat presentation',
  activate(context) {
    activateTranscriptIntent(context);
    return { contributions: {
      stylesheets: [{ id: 'footer', url: new URL('./footer.css', import.meta.url).href }],
    } };
  },
};
