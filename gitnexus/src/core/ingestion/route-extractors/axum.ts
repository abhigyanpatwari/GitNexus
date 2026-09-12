// Rust Axum route extraction utilities.
//
// Axum commonly declares routes through chained Router::route calls:
//   Router::new()
//       .route("/api/items", get(list_items))
//       .route(
//           "/api/items/:id",
//           get(get_item).put(update_item),
//       )
//
// The route phase only needs the mounted URL and owning file to create Route
// nodes. Handler-level call resolution remains the responsibility of the Rust
// call graph.

export interface AxumRoute {
  routePath: string;
}

const AXUM_ROUTE_PATTERN = /\.route\s*\(\s*["'`]([^"'`]+)["'`]/g;

export function extractAxumRoutes(content: string): AxumRoute[] {
  const routes: AxumRoute[] = [];
  const seen = new Set<string>();

  AXUM_ROUTE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AXUM_ROUTE_PATTERN.exec(content)) !== null) {
    const routePath = match[1]?.trim();
    if (!routePath?.startsWith('/')) continue;
    if (seen.has(routePath)) continue;

    seen.add(routePath);
    routes.push({ routePath });
  }

  return routes;
}
