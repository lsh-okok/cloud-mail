export function cvtFileUrl(key) {

    if (!key) {
        return ''
    }

    if (key.startsWith('https://') || key.startsWith('http://')) {
        return key
    }

    return import.meta.env.BASE_URL + String(key).replace(/^\//, '')
}

export function normalizeUrl(domain) {

    if (!domain) {
        return ''
    }

    if (!domain.startsWith('http')) {
        return 'https://' + domain
    }

    if (domain.endsWith("/")) {
        domain = domain.slice(0, -1);
    }

    return domain
}
