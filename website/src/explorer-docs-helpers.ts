// ---------------------------------------------------------------------------
// QubitCoin Block Explorer - shared documentation rendering helpers
// ---------------------------------------------------------------------------

export interface DocSection {
  id: string;
  title: string;
  icon: string;
  render: () => string;
  children?: { id: string; title: string }[];
}

export function docCode(code: string): string {
  return `<div class="bg-bg rounded-lg p-4 font-mono text-xs text-text-muted overflow-x-auto border border-border my-3"><pre class="whitespace-pre-wrap">${code}</pre></div>`;
}

export function docJson(json: string): string {
  // Syntax-highlight JSON: keys, strings, numbers, booleans, null
  const highlighted = json
    .replace(/("(?:[^"\\]|\\.)*")(\s*:)/g, '<span class="text-qubit-300">$1</span>$2')  // keys
    .replace(/:\s*("(?:[^"\\]|\\.)*")/g, ': <span class="text-entropy-cyan">$1</span>')  // string values
    .replace(/:\s*(\d+\.?\d*)/g, ': <span class="text-qubit-400">$1</span>')              // numbers
    .replace(/:\s*(true|false)/g, ': <span class="text-green-400">$1</span>')              // booleans
    .replace(/:\s*(null)/g, ': <span class="text-text-muted/50">$1</span>')                // null
    .replace(/\/\/.*/g, (m) => `<span class="text-text-muted/40 italic">${m}</span>`);     // comments
  return `<div class="bg-bg rounded-lg p-4 font-mono text-xs overflow-x-auto border border-border my-3"><pre class="whitespace-pre-wrap text-text-muted">${highlighted}</pre></div>`;
}

export function docSteps(items: string[]): string {
  const lis = items.map(item =>
    `<li class="pl-1">${item}</li>`
  ).join('\n  ');
  return `<div class="bg-surface rounded-lg glow-border p-4 mb-4">
<ol class="text-text-secondary text-sm leading-relaxed list-decimal list-inside space-y-3">
  ${lis}
</ol>
</div>`;
}

export function docH2(text: string): string {
  const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `<h2 id="${id}" class="text-xl font-bold mt-8 mb-3 scroll-mt-24">${text}</h2>`;
}

export function docH3(text: string): string {
  return `<h3 class="text-base font-semibold mt-6 mb-2 text-qubit-300">${text}</h3>`;
}

export function docP(text: string): string {
  return `<p class="text-text-secondary text-sm leading-relaxed mb-3">${text}</p>`;
}

export function docIcon(paths: string, cls: string): string {
  return `<svg class="w-4 h-4 ${cls} shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">${paths}</svg>`;
}
