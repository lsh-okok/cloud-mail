import {useUserStore} from "@/store/user.js";

export default {
    mounted(el, binding) {
        const userStore = useUserStore();
        const permKeys = userStore.user.permKeys;
        const value = binding.value;

        if (permKeys.includes('*')) {
            return;
        }

        const hasPermission = Array.isArray(value)
            ? value.some(key => permKeys.includes(key))
            : permKeys.includes(value);

        if (!hasPermission) {
            el.parentNode && el.parentNode.removeChild(el);
        }
    }
}

export function hasPerm(permKey) {
    const {permKeys} = useUserStore().user;
    return permKeys.includes('*') || permKeys.includes(permKey);
}


export function permsToRouter(permKeys) {
    const routerList = []
    Object.keys(routers).forEach(perm => {
        if (permKeys.includes(perm) || permKeys.includes('*')) {
            routerList.push(...routers[perm])
        }
    })
    return routerList;
}

const routers = {
    '*': [
        {
            path: '/admin/mailboxes',
            name: 'mailboxes',
            component: () => import('@/views/mailboxes/index.vue'),
            meta: { title: 'sourceMailboxes', name: 'mailboxes', menu: true }
        },
        {
            path: '/admin/domains',
            name: 'domains',
            component: () => import('@/views/domains/index.vue'),
            meta: { title: 'mailDomains', name: 'domains', menu: true }
        },
        {
            path: '/admin/links',
            name: 'links',
            component: () => import('@/views/links/index.vue'),
            meta: { title: 'recipientLinks', name: 'links', menu: true }
        },
        {
            path: '/admin/verification',
            name: 'verification',
            component: () => import('@/views/verification/index.vue'),
            meta: { title: 'mailVerification', name: 'verification', menu: true }
        },
        {
            path: '/admin/nodes',
            name: 'nodes',
            component: () => import('@/views/nodes/index.vue'),
            meta: { title: 'nodeManagement', name: 'nodes', menu: true }
        }
    ],
    'email:send': [
        {
            path: '/sent',
            name: 'send',
            component: () => import('@/views/send/index.vue'),
            meta: {
                title: 'sent',
                name: 'send',
                menu: true
            }
        },
        {
            path: '/drafts',
            name: 'draft',
            component: () => import('@/views/draft/index.vue'),
            meta: {
                title: 'drafts',
                name: 'draft',
                menu: true
            }
        }
    ],
    'user:query': [{
        path: '/all-users',
        name: 'user',
        component: () => import('@/views/user/index.vue'),
        meta: {
            title: 'allUsers',
            name: 'user',
            menu: true
        }
    }],
    'role:query': [{
        path: '/role',
        name: 'role',
        component: () => import('@/views/role/index.vue'),
        meta: {
            title: 'permissions',
            name: 'role',
            menu: true
        }
    }],
    'setting:query': [{
        path: '/system-settings',
        name: 'sys-setting',
        component: () => import('@/views/sys-setting/index.vue'),
        meta: {
            title: 'SystemSettings',
            name: 'sys-setting',
            menu: true
        }
    }],
    'all-email:query': [{
        path: '/all-mail',
        name: 'all-email',
        component: () => import('@/views/all-email/index.vue'),
        meta: {
            title: 'allMail',
            name: 'all-email',
            menu: true
        }
    }],
    'analysis:query': [{
        path: '/dashboard',
        name: 'analysis',
        component: () => import('@/views/analysis/index.vue'),
        meta: {
            title: 'analytics',
            name: 'analysis',
            menu: true
        }
    }]
}
