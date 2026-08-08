/**
 * A route module in the shape a raw `node:http` server actually uses: a `match`
 * that ORs the paths it owns, and a `handle` that dispatches each by verb.
 * No framework, no decorator, no filesystem convention — the route exists only
 * as a comparison.
 */

export function createLiveRoutes(ctx) {
    return {
        match(method, pathname) {
            return pathname === '/api/live/portfolio' || pathname === '/api/live/events'
        },

        async handle(req, res, reqCtx) {
            const { pathname } = reqCtx

            if (req.method === 'GET' && pathname === '/api/live/portfolio') {
                return sendJson(res, await ctx.stores.loadPortfolio())
            }

            if (req.method === 'POST' && pathname === '/api/live/portfolio') {
                return sendJson(res, await ctx.stores.resetPortfolio())
            }

            if (req.method === 'GET' && pathname === '/api/live/events') {
                return sendJson(res, await ctx.stores.loadEvents())
            }

            // Parameterised: an anchored regex is the only way to express a path
            // segment variable without a router.
            if (req.method === 'GET' && /^\/api\/live\/runs\/[^/]+$/.test(pathname)) {
                return sendJson(res, await ctx.stores.loadRun(pathname))
            }

            return notFound(res)
        },
    }
}

function sendJson(res, body) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
}

function notFound(res) {
    res.writeHead(404)
    res.end()
}
