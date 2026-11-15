import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';
import {createHash} from 'node:crypto';import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';

/* Publishes the website chat script under a content-addressed path (/embed/<hash>.js) with its SRI hash in
   /embed/manifest.json. Install snippets use that pair, so a clinic's site only runs the exact file it was given.
   /embed.js stays as the mutable legacy path for snippets pasted before SRI. */
const embedSri=()=>({name:'embed-sri',apply:'build',closeBundle(){
  const src=readFileSync('public/embed.js');
  const hex=createHash('sha256').update(src).digest('hex').slice(0,16);
  const integrity='sha384-'+createHash('sha384').update(src).digest('base64');
  mkdirSync('dist/embed',{recursive:true});
  writeFileSync(`dist/embed/${hex}.js`,src);
  writeFileSync('dist/embed/manifest.json',JSON.stringify({src:`/embed/${hex}.js`,integrity}));
}});

export default defineConfig({plugins:[react(),embedSri()]});
