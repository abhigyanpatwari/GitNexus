from auth_utils import verify_cron_secret, get_org_id_from_header
from services.sync import _start_cron_run, _complete_cron_run
from services.alerts import _create_ops_alert
from routers.alerts import send_daily_alerts


def handler_a():
    if verify_cron_secret("x"):
        org = get_org_id_from_header(None)
        _start_cron_run("a")
        _create_ops_alert("a")
        send_daily_alerts()
        _complete_cron_run("a")
        return org


def handler_b():
    _start_cron_run("b")
    _create_ops_alert("b")
    send_daily_alerts()


def handler_c():
    _start_cron_run("c")
