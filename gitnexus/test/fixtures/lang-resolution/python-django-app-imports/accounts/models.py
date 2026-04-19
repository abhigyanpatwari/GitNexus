from django.db import models


class Customer(models.Model):
    email = models.EmailField(unique=True)
