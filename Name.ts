export let NAME = typeof document === "undefined" ? "UniiChat" : document.documentElement.dataset.name ?? "UniiChat";

export function name_set(name: string): void {
  NAME = name;
}

export function name_text(text: string, name = NAME): string {
  return text.replace(/\bUniiChat\b|\bUnii\b/g, () => name);
}

export function name_html(name = NAME): string {
  return name.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" })[c] ?? c);
}
