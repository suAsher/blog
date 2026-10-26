import { defineConfig } from 'astro/config';
import { readFile, writeFile } from 'node:fs/promises';
import { privatePWA } from './src/build/pwa-integration.mjs';

// The anonymous login page may load only its exact public asset paths. Share
// canonical tokens without exposing the authenticated /_astro/ asset tree.
async function loginStyles() {
  const [tokens, page] = await Promise.all([
    readFile(new URL('./src/styles/tokens.css', import.meta.url), 'utf8'),
    readFile(new URL('./public/login-assets/login.css', import.meta.url), 'utf8'),
  ]);
  return `${tokens}\n${page}`;
}

const publicLoginStyles = {
  name: 'public-login-styles',
  hooks: {
    'astro:config:setup': ({ updateConfig }) => {
      updateConfig({ vite: { plugins: [{
        name: 'public-login-styles-dev',
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url?.split('?')[0] !== '/login-assets/login.css') return next();
            try {
              response.setHeader('Content-Type', 'text/css; charset=utf-8');
              response.setHeader('Cache-Control', 'no-store');
              response.end(await loginStyles());
            } catch (error) { next(error); }
          });
        },
      }] } });
    },
    'astro:build:done': async ({ dir }) => {
      await writeFile(new URL('login-assets/login.css', dir), await loginStyles());
    },
  },
};

export default defineConfig({
  integrations: [publicLoginStyles, privatePWA()],
  output: 'static',
  trailingSlash: 'always',
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
      wrap: false,
    },
  },
  devToolbar: { enabled: false },
});
