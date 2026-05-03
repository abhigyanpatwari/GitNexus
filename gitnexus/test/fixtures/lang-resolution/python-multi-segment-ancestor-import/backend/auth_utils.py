def verify_cron_secret(token):
    return token == "expected"


def get_org_id_from_header(headers):
    return headers.get("x-org-id") if headers else None
