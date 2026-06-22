"""App URL conf, included under the `api/` prefix from the root urls.py."""
from django.urls import path

from . import views

urlpatterns = [
    path('items/', views.item_list, name='item-list'),
    path('items/<int:pk>/', views.item_detail, name='item-detail'),
]
