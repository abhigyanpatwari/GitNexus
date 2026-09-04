use axum::{routing::{get, post, put}, Router};

pub struct SharedState;

pub fn routes() -> Router<SharedState> {
    Router::new()
        .route(
            "/api/v1/workspace/billing/subscription",
            get(my_subscription_handler),
        )
        .route("/api/v1/workspace/billing/usage", get(my_usage_handler))
        .route("/api/v1/workspace/billing/plan", get(my_plan_handler))
        .route(
            "/api/v1/provider/accounts/:id/subscription",
            get(get_subscription_handler).post(create_subscription_handler),
        )
        .route(
            "/api/v1/provider/accounts/:id/licenses/quantity",
            put(update_account_license_quantity_handler),
        )
}

pub async fn my_subscription_handler() {}
pub async fn my_usage_handler() {}
pub async fn my_plan_handler() {}
pub async fn get_subscription_handler() {}
pub async fn create_subscription_handler() {}
pub async fn update_account_license_quantity_handler() {}
