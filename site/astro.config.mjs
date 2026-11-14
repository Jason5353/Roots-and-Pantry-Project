import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://rootsandpantry.co.uk',
  output: 'static',
  trailingSlash: 'always',
  build: {
    format: 'directory',
    // Keep all CSS in files so the Content-Security-Policy can stay strict (no inline styles).
    inlineStylesheets: 'never',
  },
});
