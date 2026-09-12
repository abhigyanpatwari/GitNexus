/**
 * The path table, in a DIFFERENT file from the handlers — the shape that makes
 * per-file reconciliation insufficient. The dispatcher calls this to 404 early;
 * it is a membership test, not a route, and every path it lists is served with a
 * verb by `liveRoutes.js` (except `/api/live/config`, which only lives here).
 */

export function isKnownApiPath(pathname) {
    if (pathname === '/api/live/portfolio') {
        return true
    }

    if (pathname === '/api/live/events') {
        return true
    }

    if (pathname === '/api/live/config') {
        return true
    }

    return false
}
