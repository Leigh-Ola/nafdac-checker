import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
for (const name of ['index.html', '_redirects']) await copyFile(name, 'dist/' + name);
console.log('Built single-file frontend; Netlify will bundle the NAPAMS function separately.');
