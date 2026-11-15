import {defineConfig, loadEnv} from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import {ElementPlusResolver} from 'unplugin-vue-components/resolvers'
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(({mode}) => {
    const env = loadEnv(mode, process.cwd(), 'VITE')
    const appPath = process.env.APP_BASE_PATH ?? env.VITE_APP_BASE_PATH ?? ''
    const appBase = appPath ? `/${appPath.replace(/^\/+|\/+$/g, '')}/` : '/'
    const proxyBase = appBase.replace(/\/$/, '')
    return {
        server: {
            host: true,
            port: 3001,
            hmr: true,
            proxy: Object.fromEntries(['/api', '/attachments', '/oss', '/static'].map(prefix => [`${proxyBase}${prefix}`, {
                target: env.VITE_DEV_PROXY_TARGET || 'http://127.0.0.1:3000',
                changeOrigin: true,
            }])),
        },
        base: appPath ? appBase : (env.VITE_STATIC_URL || '/'),
        plugins: [vue(),
            VitePWA({
                injectRegister: 'script-defer',
                manifest: {
                    name: env.VITE_PWA_NAME,
                    short_name: env.VITE_PWA_NAME,
                    background_color: '#FFFFFF',
                    theme_color: '#FFFFFF',
                    icons: [
                        {
                            src: 'mail-pwa.png',
                            sizes: '192x192',
                            type: 'image/png',
                        }
                    ],
                },
                workbox: {
                    disableDevLogs: true,
                    globPatterns: [],
                    runtimeCaching: [],
                    navigateFallback: null,
                    cleanupOutdatedCaches: true,
                }
            }),
            AutoImport({
                resolvers: [ElementPlusResolver()],
            }),
            Components({
                resolvers: [ElementPlusResolver()],
            })
        ],
        resolve: {
            alias: {
                '@': path.resolve(__dirname, 'src')
            }
        },
        build: {
            target: 'es2022',
            outDir: env.VITE_OUT_DIR || 'dist',
            emptyOutDir: true,
            assetsInclude: ['**/*.json']
        }
    }
})
