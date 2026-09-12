/**
 * The negative half of the fixture: a static file server and a filesystem
 * helper, both full of path-shaped string comparisons that are NOT routes.
 * If any of these mint a Route node, the rule is too loose.
 */

import path from 'node:path'

export function serveStatic(req, res, pathname) {
    // The bare-'/' normalisation idiom — a branch, not a route declaration.
    const file = pathname === '/' ? '/index.html' : pathname
    return readAsset(file, res)
}

export function resolveCacheDir(dir) {
    // `path` is the node:path module here; `/tmp/gitnexus-cache` is a directory.
    if (path === '/tmp/gitnexus-cache') {
        return dir
    }
    return null
}

export function isApiRequest(pathname) {
    // A namespace test, not a route: nothing serves `/api/`.
    return pathname.startsWith('/api/')
}

export function isNotHealth(pathname) {
    // Inequality asserts the path is something ELSE.
    return pathname !== '/api/live/health'
}

function readAsset(file, res) {
    res.end(file)
}
