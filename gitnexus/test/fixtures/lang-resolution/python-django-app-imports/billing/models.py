from django.db import models
from accounts.models import Customer


class Invoice(models.Model):
    customer = models.ForeignKey(
        Customer, on_delete=models.CASCADE, related_name="invoices"
    )
    total_cents = models.PositiveIntegerField()
