export default {
  apiVersion: 5,
  name: 'Codeflare Chat presentation',
  activate: () => ({
    contributions: {
      stylesheets: [{ id: 'footer', url: new URL('./footer.css', import.meta.url).href }],
    },
  }),
};
