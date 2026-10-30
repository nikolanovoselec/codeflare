/** Map file extension to Prism language identifier */
const EXT_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  toml: "toml",
  graphql: "graphql",
  svg: "xml",
  dockerfile: "docker",
  makefile: "makefile",
};

export function detectLanguage(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const basename = filePath.split("/").pop()?.toLowerCase() ?? "";
  // Handle dotfiles like Dockerfile, Makefile
  if (EXT_MAP[basename]) return EXT_MAP[basename];
  const ext = basename.split(".").pop() ?? "";
  return EXT_MAP[ext];
}
