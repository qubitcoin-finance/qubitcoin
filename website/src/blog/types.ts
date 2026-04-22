export interface BlogPost {
  slug: string;
  title: string;
  date: string;
  tags: string[];
  excerpt: string;
  content: () => string;
}

export const BLOG_TAG_COLORS: Record<string, string> = {
  bitcoin: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  cryptography: 'text-qubit-400 bg-qubit-600/10 border-qubit-600/20',
  quantum: 'text-entropy-cyan bg-entropy-cyan/10 border-entropy-cyan/20',
  technical: 'text-entropy-blue bg-entropy-blue/10 border-entropy-blue/20',
  'ml-dsa': 'text-qubit-300 bg-qubit-600/10 border-qubit-600/20',
  dilithium: 'text-qubit-300 bg-qubit-600/10 border-qubit-600/20',
  development: 'text-green-400 bg-green-500/10 border-green-500/20',
  testnet: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  engineering: 'text-entropy-blue bg-entropy-blue/10 border-entropy-blue/20',
};

export function h2(text: string): string {
  return `<h2 class="text-xl font-bold mt-8 mb-3">${text}</h2>`;
}

export function p(text: string): string {
  return `<p class="text-text-secondary text-sm leading-relaxed mb-3">${text}</p>`;
}

export function steps(items: string[]): string {
  const lis = items.map(item => `<li class="pl-1">${item}</li>`).join('\n  ');
  return `<div class="bg-surface rounded-lg glow-border p-4 mb-4">
<ol class="text-text-secondary text-sm leading-relaxed list-decimal list-inside space-y-3">
  ${lis}
</ol>
</div>`;
}
