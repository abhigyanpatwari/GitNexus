# Server-side enforcement that a dispatched non-main ref cannot bypass by
# editing its own workflow copy (see the activation checklist in
# .github/workflows/gitnexus-skill-evolution.yml). Secret VALUES are
# deliberately never managed here -- GITNEXUS_BENCH_AUTH_TOKEN,
# RELEASE_APP_ID, and RELEASE_APP_PRIVATE_KEY stay a manual, one-time step
# so a real API key/private key is never written into Terraform state.

resource "github_repository_environment" "evolution" {
  repository  = var.github_repo
  environment = "gitnexus-evolution"

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "evolution_main" {
  repository     = var.github_repo
  environment    = github_repository_environment.evolution.environment
  branch_pattern = "main"
}
