/**
 * The composed-path idiom: every route is built from a base constant rather
 * than written as a literal. Before constant folding this whole module was
 * invisible — and, worse, indistinguishable from a module with no routes.
 */

const AUTO_TRADE_BASE_PATH = '/api/live/auto-trade'

export function createAutoTradeRoutes(ctx) {
    return {
        async handleAutoTrade(req, res, reqCtx) {
            const { pathname } = reqCtx
            const autoTradeBasePath = AUTO_TRADE_BASE_PATH

            if (req.method === 'GET' && pathname === `${autoTradeBasePath}/rules`) {
                return ctx.listRules()
            }

            if (req.method === 'POST' && pathname === `${autoTradeBasePath}/rules`) {
                return ctx.createRule()
            }

            if (req.method === 'GET' && pathname === AUTO_TRADE_BASE_PATH + '/positions') {
                return ctx.listPositions()
            }

            // Not foldable — `ruleId` is a runtime value, so no route is claimed
            // rather than a wrong one.
            if (req.method === 'DELETE' && pathname === `${autoTradeBasePath}/rules/${req.ruleId}`) {
                return ctx.deleteRule()
            }

            return null
        },
    }
}
