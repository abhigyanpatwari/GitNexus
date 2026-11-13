export async function loadBilling() {
  await fetch('/api/v1/workspace/billing/usage');
  await fetch(`/api/v1/provider/accounts/${accountId}/licenses/quantity`);
}
